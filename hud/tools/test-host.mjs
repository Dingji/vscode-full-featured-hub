#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — host half test.
 *
 * Mounts the REAL plugin against a mock cordis context and drives its REAL
 * same-origin routes over a REAL local HTTP upstream:
 *
 *   mock ctx ──▶ mod.apply(ctx, config) ──▶ routes Map
 *                                              │
 *   test ── fake req/res ──────────────────────┘
 *                                              │
 *                              panel collector ──▶ http://127.0.0.1:<port>
 *
 * So the route table, the config namespacing, the credential plumbing, the
 * collectors and the cache are all exercised end to end — no browser, no DSH,
 * no network. Run: `node tools/test-host.mjs`
 */

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { connect as netConnect, createServer as createTcpServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

// ── a REAL git fixture ─────────────────────────────────────────────────────
// The panel never spawns git, so its fixture has to be built BY git: that is what
// makes the parser assertions statements about the real on-disk format rather
// than about my own idea of it. The suite skips this section cleanly without git.
const gitRoot = mkdtempSync(join(tmpdir(), 'hud-git-'))
const gitBin = process.platform === 'win32' ? 'git.exe' : 'git'
async function hasGit() {
  try {
    execFileSync(gitBin, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function runGit(cwd, ...args) {
  try {
    return execFileSync(gitBin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '')
  } catch (error) {
    // Surface git's own words — and BOTH streams: `git commit` says "nothing to
    // commit" on stdout, so a stderr-only message reads as an empty failure.
    const text = [error.stderr, error.stdout].map((part) => String(part ?? '').trim()).filter(Boolean).join(' | ')
    throw new Error(`git ${args.join(' ')} failed: ${text || error.message}`)
  }
}
/** A git command whose non-zero exit is expected (a conflicting merge, say). */
function runGitAllowingFailure(cwd, ...args) {
  try {
    return execFileSync(gitBin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}
/** A `.git` directory with just a HEAD, for the pure-parser assertions. */
const fixtureGitDir = (() => {
  const dir = join(gitRoot, 'shape')
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
})()

// The panels are normally reached through the real pply(); the services block
// mounts one directly with its own config, so it needs the kit's factory.
import { createHost } from '../lib/host-kit.js'

// MUST be set before the plugin resolves any storage/credential path, so the
// test never touches the real ~/.dsh.
const suiteHome = mkdtempSync(join(tmpdir(), 'dsh-hud-test-'))
process.env.DSH_HOME = suiteHome

let failures = 0
let checks = 0

function ok(label, condition, detail) {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures++
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return ok(label, a === e, `expected ${e}, got ${a}`)
}

// ── a mock cordis context ──────────────────────────────────────────────────
function mockContext({ credentials = {} } = {}) {
  /** @type {Map<string, { kind: string, handler: Function }>} */
  const routes = new Map()
  const ctx = {
    routes,
    // A WRITABLE credential store, like the real service: the mail 授权码 and the
    // OAuth client secret are written here, and a panel that stores a secret has
    // to be able to read back only its EXISTENCE. Without `write`, the kit falls
    // back to patching `$DSH_HOME/.credentials.yaml` — correct in production, but
    // then `present()` cannot see it and the test asserts the wrong thing.
    credentials: {
      async resolve(ref) {
        return Object.prototype.hasOwnProperty.call(credentials, ref) ? { value: credentials[ref] } : undefined
      },
      async present(ref) {
        return Object.prototype.hasOwnProperty.call(credentials, ref)
      },
      async write(ref, value) {
        credentials[ref] = value
      },
      async remove(ref) {
        delete credentials[ref]
      },
    },
    webServer: {
      register({ kind, path, handler }) {
        if (routes.has(path)) throw new Error(`duplicate route ${path}`)
        routes.set(path, { kind, handler })
        return () => routes.delete(path)
      },
    },
    loader: { entries: () => [] },
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
  }
  return ctx
}

/** A fake `req` good enough for same-origin checks, body reads and query params. */
function mockReq({ method = 'GET', host = '127.0.0.1:19387', origin, body, url } = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const listeners = {}
  return {
    method,
    url: url ?? '/',
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    on(event, fn) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(fn)
      return this
    },
    resume() {},
    destroy() {},
    /** Deliver the body to whoever is listening (mirrors a real socket). */
    flush() {
      if (text !== '') for (const fn of listeners.data ?? []) fn(Buffer.from(text))
      for (const fn of listeners.end ?? []) fn()
    },
  }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: /** @type {Record<string, string>} */ ({}),
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
    json() {
      return this.body === undefined || this.body === '' ? null : JSON.parse(this.body)
    },
  }
}

/** Call one registered route and return the response. A query string on `path`
 *  is kept on the request (the route table is matched on the pathname alone,
 *  exactly like the real router). */
async function call(ctx, path, options = {}) {
  const [pathname] = String(path).split('?')
  const route = ctx.routes.get(pathname)
  if (!route) throw new Error(`route not registered: ${pathname}`)
  const req = mockReq({ ...options, url: path })
  const res = mockRes()
  const promise = route.handler(req, res)
  req.flush() // a POST handler is awaiting its body; deliver it
  await promise
  return res
}

// ── a real local upstream ──────────────────────────────────────────────────
/** Records every path it was asked for, so caching can be asserted. */
const upstreamHits = []

/**
 * A calendar feed with the shapes that actually break parsers: a folded SUMMARY,
 * a `TZID` time, a UTC time, an all-day `VALUE=DATE`, a recurring VEVENT, and a
 * VTODO carrying ONLY `DUE` (no `DTSTART`).
 *
 * Dates are built relative to today so the panel's own windows (yesterday → +90
 * days) always contain them, whatever day the suite runs.
 */
const TODO_ICS = (() => {
  const pad = (value) => String(value).padStart(2, '0')
  const day = (offset) => {
    const at = new Date()
    at.setDate(at.getDate() + offset)
    return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  }
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//dsh-hud//CN',
    'BEGIN:VEVENT',
    'UID:review@test',
    'SUMMARY:季度评审（标题很长会被折',
    ' 行，解析器必须接回去）',
    `DTSTART:${day(1)}T020000Z`,
    `DTEND:${day(1)}T030000Z`,
    'DESCRIPTION:带\\,逗号的说明',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:holiday@test',
    'SUMMARY:调休',
    `DTSTART;VALUE=DATE:${day(2)}`,
    'END:VEVENT',
    'BEGIN:VTODO',
    'UID:expense@test',
    'SUMMARY:交报销单',
    `DUE;VALUE=DATE:${day(3)}`,
    'END:VTODO',
    'BEGIN:VEVENT',
    'UID:standup@test',
    'SUMMARY:每日站会',
    `DTSTART:${day(0)}T093000Z`,
    'RRULE:FREQ=DAILY;COUNT=3',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
})()

/**
 * Weather fixtures. `ipCity` is mutable so one mount can be driven through two
 * different locations: the widget's behaviour depends on whether an alert names
 * the user's own city, and that is the branch worth testing.
 */
let ipCity = '无锡市'
/** Flip to drive the bond panel onto its FRED fallback. */
let usQuoteFails = false
/**
 * Parcel fixtures, NEWEST FIRST exactly like the real API. `extraScans` lets one
 * mount be driven through a timeline that MOVES, which is the only way to test
 * the change detection that the badge and the "new" highlight depend on.
 */
let extraScans = 0
const parcelNodes = () => {
  const nodes = [
    { time: '2026-10-01 10:24:11', ftime: '2026-10-01 10:24:11', context: '【无锡市】快件正在派送中，请保持电话畅通' },
    { time: '2026-10-01 07:02:33', ftime: '2026-10-01 07:02:33', context: '【无锡市】快件已到达 无锡集散中心' },
    { time: '2026-09-30 22:41:05', ftime: '2026-09-30 22:41:05', context: '【上海市】快件已从 上海转运中心 发出' },
  ]
  for (let i = 0; i < extraScans; i++) {
    nodes.unshift({ time: `2026-10-01 1${i}:55:00`, ftime: `2026-10-01 1${i}:55:00`, context: `【无锡市】第 ${i + 1} 条新扫描` })
  }
  return nodes
}
const ALERT_FIXTURES = [
  { alertid: '32020041600000_20261001105007', issuetime: '2026/10/01 10:50', title: '江苏省无锡市气象台发布大风蓝色预警信号', url: '/publish/alarm/a.html', pic: 'x' },
  { alertid: '32010041600000_20261001104959', issuetime: '2026/10/01 10:49', title: '江苏省南京市气象台发布暴雨黄色预警信号', url: '/publish/alarm/b.html', pic: 'x' },
  { alertid: '52062241600000_20261001104651', issuetime: '2026/10/01 10:46', title: '贵州省铜仁市玉屏侗族自治县气象台发布高温橙色预警信号', url: '/publish/alarm/c.html', pic: 'x' },
  { alertid: '11000041600000_20261001104000', issuetime: '2026/10/01 10:40', title: '北京市气象台发布雷电黄色预警', url: '/publish/alarm/d.html', pic: 'x' },
]

const upstream = createServer((req, res) => {
  upstreamHits.push(req.url ?? '')
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // ── parcel: kuaidi100-shaped replies ────────────────────────────────────
  // The real endpoint answers Content-Type: text/html with a JSON body, so the
  // stub does too — a test that only works against `application/json` would not
  // be testing the parser that has to cope with the real thing.
  const sendHtml = (body) => {
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  // ── todo: calendar feeds ────────────────────────────────────────────────
  // Served as `text/calendar`, like a real Feishu/DingTalk/Outlook share link.
  // One path answers a LOGIN PAGE instead, because that is what an expired
  // subscription actually does, and the panel has to say so rather than report
  // "0 items".
  if (req.url?.startsWith('/ics/login')) {
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
    res.end('<!doctype html><html><body>请先登录</body></html>')
    return
  }
  if (req.url?.startsWith('/ics/basic')) {
    res.writeHead(200, { 'content-type': 'text/calendar;charset=utf-8' })
    res.end(TODO_ICS)
    return
  }
  if (req.url?.startsWith('/kd/query')) {
    const params = new URL(req.url, 'http://x').searchParams
    const com = params.get('type')
    const nu = params.get('postid')
    if (com === 'bogus') {
      return sendHtml({ message: '参数错误', nu: '', ischeck: '0', condition: '', com: '', status: '400', state: '0', data: [] })
    }
    if (com === 'shunfeng' && nu === 'SF0000000000001') {
      return sendHtml({ message: 'ok', nu, ischeck: '0', condition: 'F00', com, status: '200', state: '5', data: parcelNodes() })
    }
    return sendHtml({ message: 'ok', nu, ischeck: '0', condition: '', com, status: '200', state: '3', data: [{ time: '2026-09-01 09:00:00', ftime: '2026-09-01 09:00:00', context: '查无结果' }] })
  }
  if (req.url?.startsWith('/zen/go/v1/usage')) {
    return send({ usage: { rolling: { percent: 42, resetsAt: Date.now() + 3_600_000 } } })
  }
  if (req.url?.startsWith('/custom/usage')) {
    return send({ data: { limits: { weekly: { used: 25, limit: 100 } } } })
  }
  // ── weather: Open-Meteo-shaped current conditions ────────────────────────
  if (req.url?.startsWith('/wx/forecast')) {
    return send({
      timezone: 'Asia/Shanghai',
      current: {
        time: '2026-10-01T10:30',
        temperature_2m: 23.6,
        relative_humidity_2m: 56,
        apparent_temperature: 25.1,
        is_day: 1,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 12.4,
        wind_direction_10m: 135,
        wind_gusts_10m: 21.5,
      },
    })
  }
  // ── weather: ip-api-shaped location ─────────────────────────────────────
  if (req.url?.startsWith('/wx/ip')) {
    return send({
      status: 'success', country: '中国', countryCode: 'CN', regionName: '江苏', city: ipCity,
      lat: 31.5618, lon: 120.2864, timezone: 'Asia/Shanghai',
    })
  }
  // ── weather: NMC-shaped alert list (only five fields, like the real one) ──
  if (req.url?.startsWith('/wx/alarm')) {
    return send({ msg: 'success', code: 0, data: { page: { pageNo: 1, pageSize: 1000, count: ALERT_FIXTURES.length, next: 1, list: ALERT_FIXTURES } } })
  }
  if (req.url?.startsWith('/wx/geocode')) {
    return send({ results: [] })
  }
  // ── market: eastmoney-shaped quotes / candles / search ──────────────────
  if (req.url?.startsWith('/em/quote')) {
    return send({ rc: 0, data: { total: 3, diff: [
      { f1: 2, f2: 384219, f3: 31, f4: 1174, f12: '000001', f13: 1, f14: '上证指数', f124: 1790755920 },
      { f1: 2, f2: 125124, f3: -85, f4: -107, f12: '600519', f13: 1, f14: '贵州茅台', f124: 1790755920 },
      { f1: 2, f2: 22815, f3: 124, f4: 281, f12: 'AAPL', f13: 105, f14: '苹果', f124: 1790755920 },
    ] } })
  }
  // ── bond: its own paths, so the market stub cannot swallow them ─────────
  if (req.url?.startsWith('/bd/quote')) {
    // Bond ETFs only — the panel is domestic now, with no US leg at all.
    return send({ rc: 0, data: { total: 2, diff: [
      { f1: 3, f2: 140735, f3: -12, f4: -17, f12: '511010', f13: 1, f14: '国债ETF国泰' },
      { f1: 3, f2: 134804, f3: 7, f4: 9, f12: '511260', f13: 1, f14: '十年国债ETF' },
    ] } })
  }
  if (req.url?.startsWith('/bd/kline')) {
    // `klt` must reach the upstream: the period menu IS the route's point.
    const params = new URL(req.url, 'http://x').searchParams
    if (params.get('klt') === '1') {
      // A session of one-minute bars, plus one bar from an EARLIER day that the
      // 实时 trim has to drop.
      const bars = ['2026-09-29 15:00,133.900,134.000,134.100,133.800,400']
      for (let index = 0; index < 12; index++) {
        const hour = String(9 + Math.floor(index / 4)).padStart(2, '0')
        const minute = String((index % 4) * 15).padStart(2, '0')
        bars.push(`2026-09-30 ${hour}:${minute},134.100,134.200,134.300,134.000,500`)
      }
      return send({ rc: 0, data: { code: '511260', name: '十年国债ETF', klines: bars } })
    }
    if (params.get('klt') === '102') {
      return send({ rc: 0, data: { code: '511260', name: '十年国债ETF', klines: [
        '2026-09-25,133.900,134.100,134.300,133.800,9000,120000000.00',
        '2026-10-02,134.100,134.804,134.900,134.000,11000,148000000.00',
      ] } })
    }
    return send({ rc: 0, data: { code: '511260', name: '十年国债ETF', klines: [
      '2026-09-29,134.60,134.500,134.70,134.40,2000,26900000.00',
      '2026-09-30,134.50,134.804,134.90,134.45,2400,32300000.00',
      'broken',
    ] } })
  }
  if (req.url?.startsWith('/em/kline')) {
    return send({ rc: 0, data: { code: '600519', market: 1, name: '贵州茅台', klines: [
      '2026-09-28,1250.00,1262.99,1266.00,1247.10,21000,2600000000.00',
      '2026-09-29,1262.99,1257.12,1268.40,1254.10,18000,2250000000.00',
      '2026-09-30,1257.12,1251.24,1271.50,1250.89,30981,3894630783.00',
      '2026-10-01,broken',
    ] } })
  }
  if (req.url?.startsWith('/em/search')) {
    return send({ QuotationCodeTable: { Data: [
      { Code: '600519', Name: '贵州茅台', QuoteID: '1.600519', MktNum: '1', SecurityTypeName: '沪A' },
      { Code: '000858', Name: '五粮液', QuoteID: '0.000858', MktNum: '0', SecurityTypeName: '深A' },
      { Code: '', Name: '坏数据', QuoteID: '', MktNum: '', SecurityTypeName: '' },
    ] } })
  }

  if (req.url?.startsWith('/em/etf')) {
    return send({ rc: 0, data: { total: 2, diff: [
      { f1: 3, f2: 140735, f3: -12, f4: -17, f12: '511010', f13: 1, f14: '国债ETF国泰' },
      { f1: 3, f2: 134804, f3: 7, f4: 9, f12: '511260', f13: 1, f14: '十年国债ETF' },
    ] } })
  }
  // ── bond: 中国货币网 curve cells (date DESC, tenor ASC) ─────────────────
  if (req.url?.startsWith('/cm/yield')) {
    const tenors = { 0.083: 1.01, 0.25: 1.16, 0.5: 1.28, 1: 1.38, 3: 1.52, 5: 1.68, 7: 1.82, 10: 1.95, 30: 2.10 }
    const records = []
    for (const [offset, date] of ['2026-09-30', '2026-09-29', '2026-09-28'].entries()) {
      for (const [tenor, base] of Object.entries(tenors)) {
        records.push({
          newDateValueCN: date,
          yearTermStr: tenor,
          // Three days, each 1bp lower than the day before it.
          maturityYieldStr: (base + offset * 0.01).toFixed(4),
          currentYieldStr: '1.0000',
          futureYieldStr: '---',
        })
      }
    }
    // An unpublished long tenor: `---` must be dropped, never turned into NaN.
    records.push({ newDateValueCN: '2026-09-30', yearTermStr: '15', maturityYieldStr: '---', currentYieldStr: '---', futureYieldStr: '---' })
    return send({ head: { rep_code: '200' }, data: { dateList: ['2026-09-30'], total: records.length }, records })
  }
  // ── bond: FRED CSV, with `.` for a missing observation ──────────────────
  if (req.url?.startsWith('/fred')) {
    const id = new URL(req.url, 'http://x').searchParams.get('id')
    const values = id === 'DGS2' ? [3.60, 3.62, 3.65] : id === 'DGS30' ? [5.10, 5.12, 5.15] : [5.20, 5.24, 5.26]
    const rows = values.map((value, index) => `2026-09-${28 + index},${value}`)
    if (id === 'DGS10') rows.push('2026-10-01,.')
    res.writeHead(200, { 'content-type': 'application/csv' })
    return res.end(`observation_date,${id}\n${rows.join('\n')}\n`)
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
})

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
const port = /** @type {any} */ (upstream.address()).port
const base = `http://127.0.0.1:${port}`
console.log(`local upstream on ${base}\n`)

// ── the plugin under test ──────────────────────────────────────────────────
console.log('host shell')
const mod = await import('../index.js')

eq('name is dsh-hud', mod.name, 'dsh-hud')
eq('inject asks for webServer + credentials', mod.inject, ['webServer', 'credentials'])
eq('namespace is dsh-hud', mod.namespace, 'dsh-hud')
ok('apply is a function', typeof mod.apply === 'function')

const ctx = mockContext({ credentials: { TEST_OPENCODE_KEY: 'sk-test-opencode' } })
const handles = mod.apply(ctx, {
  panels: {
    quota: {
      cacheMs: 5_000,
      subscriptions: [
        { id: 'opencode-go', kind: 'opencode-go', apiKeyEnv: 'TEST_OPENCODE_KEY', baseUrl: `${base}/zen/go` },
        { id: 'custom-demo', kind: 'custom', apiKeyEnv: '', auth: 'none', url: `${base}/custom/usage` },
      ],
    },
    weather: {
      // No city / coordinates on purpose: this drives the IP-location path,
      // which is what a fresh install actually uses.
      refreshMs: 60_000,
      forecastUrl: `${base}/wx/forecast`,
      ipGeoUrl: `${base}/wx/ip`,
      alarmUrl: `${base}/wx/alarm`,
      geocodeUrl: `${base}/wx/geocode`,
    },
    parcel: {
      // Floors keep the shared cache window short enough for a test to outlive.
      pollMs: 60_000,
      refreshMs: 300_000,
      queryUrl: `${base}/kd/query`,
    },
    market: {
      watch: '1.000001,1.600519,105.AAPL',
      quoteMs: 10_000,
      klineMs: 60_000,
      quoteUrl: `${base}/em/quote`,
      klineUrl: `${base}/em/kline`,
      searchUrl: `${base}/em/search`,
    },
    bond: {
      pollMs: 300_000,
      cnUrl: `${base}/cm/yield`,
      quoteUrl: `${base}/bd/quote`,
      klineUrl: `${base}/bd/kline`,
      fredUrl: `${base}/fred`,
    },
  },
})

console.log('\n  panels mounted')
eq('apply() reports every panel — services, git and machine are gone', handles.panels().sort(),
  ['bond', 'futures', 'github', 'market', 'parcel', 'quota', 'sql', 'todo', 'weather'])
ok('host.panel("quota") exposes its handles', typeof handles.panel('quota')?.subscriptions === 'function')
ok('host.panel("weather") exposes its handles', typeof handles.panel('weather')?.state === 'function')
ok('host.panel("parcel") exposes its handles', typeof handles.panel('parcel')?.payload === 'function')
ok('host.panel("market") exposes its handles', typeof handles.panel('market')?.payload === 'function')
ok('host.panel("bond") exposes its handles', typeof handles.panel('bond')?.state === 'function')

// ── route table ────────────────────────────────────────────────────────────
console.log('\nroutes')
const expectedRoutes = [
  '/dsh-hud/quota/usage',
  '/dsh-hud/quota/refresh',
  '/dsh-hud/quota/credential',
  '/dsh-hud/github/state',
  '/dsh-hud/github/refresh',
  '/dsh-hud/github/credential',
  '/dsh-hud/github/logout',
  '/dsh-hud/github/device/start',
  '/dsh-hud/github/device/poll',
  '/dsh-hud/github/device/cancel',
  '/dsh-hud/github/repos',
  '/dsh-hud/github/watch',
  '/dsh-hud/github/read',
  '/dsh-hud/github/settings',
  '/dsh-hud/todo/state',
  '/dsh-hud/todo/refresh',
  '/dsh-hud/todo/add',
  '/dsh-hud/todo/update',
  '/dsh-hud/todo/remove',
  '/dsh-hud/todo/settings',
    '/dsh-hud/todo/pomodoro',
  '/dsh-hud/todo/feed',
  '/dsh-hud/todo/mail',
  '/dsh-hud/todo/mail/list',
  '/dsh-hud/todo/login',
  '/dsh-hud/todo/callback',
  '/dsh-hud/todo/tasks',
  '/dsh-hud/weather/state',
  '/dsh-hud/weather/refresh',
  '/dsh-hud/parcel/state',
  '/dsh-hud/parcel/refresh',
  '/dsh-hud/parcel/check',
  '/dsh-hud/parcel/add',
  '/dsh-hud/parcel/remove',
  '/dsh-hud/parcel/read',
  '/dsh-hud/parcel/detect',
  '/dsh-hud/market/state',
  // The 汇率 board. One route on the 股市 panel, which the 汇率 VIEW reads — the view is a client
  // composition and has no host of its own.
  '/dsh-hud/market/fx',
  '/dsh-hud/market/kline',
  // 今日涨跌榜: eastmoney's own screen, sorted by 涨跌幅 in either direction.
  '/dsh-hud/market/rank',
  '/dsh-hud/market/refresh',
  '/dsh-hud/market/search',
  '/dsh-hud/market/add',
  '/dsh-hud/market/remove',
  '/dsh-hud/market/select',
  '/dsh-hud/market/period',
  '/dsh-hud/bond/state',
  '/dsh-hud/futures/state',
  '/dsh-hud/futures/refresh',
  '/dsh-hud/futures/kline',
  '/dsh-hud/futures/curve',
  '/dsh-hud/futures/favorite',
  '/dsh-hud/sql/state',
  '/dsh-hud/sql/refresh',
  '/dsh-hud/sql/query',
  '/dsh-hud/sql/test',
  // Where a typed password is written on its way to the credential store, so that the
  // connection itself never carries a secret.
  '/dsh-hud/sql/credential',
  // And where it is deleted from, which is the second half of deleting a connection —
  // refused while any OTHER connection still names the same credential.
  '/dsh-hud/sql/credential/remove',
  '/dsh-hud/sql/settings',
  // The card is a database OR an SSH client, never both — and the SSH half has its own
  // three routes, which do not touch a database at all.
  '/dsh-hud/sql/ssh/state',
  '/dsh-hud/sql/ssh/test',
  '/dsh-hud/sql/ssh/run',
  // The live terminal: open, poll, type, close. Four routes that together are a terminal.
  '/dsh-hud/sql/ssh/open',
  '/dsh-hud/sql/ssh/session',
  '/dsh-hud/sql/ssh/input',
  '/dsh-hud/sql/ssh/close',
  '/dsh-hud/bond/kline',
  '/dsh-hud/bond/chart',
  '/dsh-hud/bond/refresh',
]
for (const path of expectedRoutes) {
  ok(`registered ${path}`, ctx.routes.has(path))
}
eq('route count', ctx.routes.size, expectedRoutes.length)
for (const [path, route] of ctx.routes) {
  eq(`kind of ${path} is exact`, route.kind, 'exact')
}

// ── quota: the real collector against the real upstream ────────────────────
console.log('\nquota panel — live query')
const usage = await call(ctx, '/dsh-hud/quota/usage')
eq('GET /usage is 200', usage.statusCode, 200)
const payload = usage.json()
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
ok('payload is marked ok', payload?.ok === true)
ok('payload carries a poll cadence', typeof payload?.pollMs === 'number', String(payload?.pollMs))
// A panel lives in `panels/<id>/`, so a panel-local `./package.json` read is a
// silent `0.0.0` — the version must come from the kit, and this is the check
// that caught it in the live payload.
eq('the payload reports the real package version', payload?.version, pkgVersion)
const rows = payload?.subscriptions ?? []
eq('two subscription rows', rows.length, 2)

const opencode = rows.find((r) => r.id === 'opencode-go')
const custom = rows.find((r) => r.id === 'custom-demo')
ok('opencode row came from the local gateway', opencode?.windows?.[0]?.percent === 42, JSON.stringify(opencode))
ok('opencode row carries a reset time', typeof opencode?.windows?.[0]?.resetsAt === 'number')
ok('custom row auto-detected the weekly window', custom?.windows?.[0]?.percent === 25, JSON.stringify(custom))
eq('custom row owns its kind', custom?.kind, 'custom')
ok('row exposes credential refs (refs only, never values)', Array.isArray(opencode?.credentials))
ok('ref presence is reported', opencode?.credentials?.some((c) => c.ref === 'TEST_OPENCODE_KEY' && c.present === true))
ok('no secret ever leaves the host', !JSON.stringify(payload).includes('sk-test-opencode'))

console.log('\nquota panel — cache and force')
const before = upstreamHits.length
await call(ctx, '/dsh-hud/quota/usage')
eq('a second GET reuses the cache', upstreamHits.length, before)
await call(ctx, '/dsh-hud/quota/refresh', { method: 'POST' })
ok('POST /refresh actually re-queries upstream', upstreamHits.length > before, `hits ${upstreamHits.length}`)

console.log('\nquota panel — guards')
const head = await call(ctx, '/dsh-hud/quota/usage', { method: 'HEAD' })
eq('HEAD /usage is 200', head.statusCode, 200)
eq('HEAD /usage has an empty body', head.body, '')
const wrongMethod = await call(ctx, '/dsh-hud/quota/usage', { method: 'POST' })
eq('POST /usage is 405', wrongMethod.statusCode, 405)
const crossOrigin = await call(ctx, '/dsh-hud/quota/refresh', { method: 'POST', origin: 'https://evil.example' })
eq('cross-origin POST /refresh is 403', crossOrigin.statusCode, 403)
const crossOriginCred = await call(ctx, '/dsh-hud/quota/credential', {
  method: 'POST', origin: 'https://evil.example', body: { ref: 'X', value: 'y' },
})
eq('cross-origin POST /credential is 403', crossOriginCred.statusCode, 403)

// ── quota: the credential drawer ───────────────────────────────────────────
console.log('\nquota panel — credential drawer')
const badRef = await call(ctx, '/dsh-hud/quota/credential', { method: 'POST', body: { ref: '../etc/passwd', value: 'x' } })
eq('a malformed ref is 400', badRef.statusCode, 400)
const badValue = await call(ctx, '/dsh-hud/quota/credential', { method: 'POST', body: { ref: 'GOOD_REF', value: '' } })
eq('an empty value is 400', badValue.statusCode, 400)
const badJson = await call(ctx, '/dsh-hud/quota/credential', { method: 'POST', body: '{not json' })
eq('malformed JSON is 400', badJson.statusCode, 400)
const saved = await call(ctx, '/dsh-hud/quota/credential', { method: 'POST', body: { ref: 'GOOD_REF', value: 'hunter2' } })
eq('a valid save is 200', saved.statusCode, 200)
ok('the response says where it landed', typeof saved.json()?.how === 'string', JSON.stringify(saved.json()))
ok('the response NEVER echoes the secret', !JSON.stringify(saved.json()).includes('hunter2'))

// ── github: guards only (its upstream needs a real token) ──────────────────
console.log('\ngithub panel — guards')
const ghState = await call(ctx, '/dsh-hud/github/state')
ok('GET /state answers without a token', ghState.statusCode === 200 || ghState.statusCode === 502, `status ${ghState.statusCode}`)
if (ghState.statusCode === 200) {
  const body = ghState.json()
  eq('signed-out state is explicit', body?.auth?.status, 'missing')
  ok('signed-out state names no account', body?.auth?.account === null)
  eq('the github payload reports the real package version', body?.version, pkgVersion)
  ok('the token is never echoed', !JSON.stringify(body).includes('GITHUB_TOKEN_VALUE'))
}
const ghMethod = await call(ctx, '/dsh-hud/github/refresh', { method: 'GET' })
eq('GET /refresh is 405', ghMethod.statusCode, 405)
const ghCross = await call(ctx, '/dsh-hud/github/watch', { method: 'POST', origin: 'https://evil.example', body: { action: 'add', repo: 'a/b' } })
eq('cross-origin POST /watch is 403', ghCross.statusCode, 403)
const ghBadRepo = await call(ctx, '/dsh-hud/github/watch', { method: 'POST', body: { action: 'add', repo: 'not a repo' } })
ok('a malformed repo name is rejected', ghBadRepo.statusCode >= 400, `status ${ghBadRepo.statusCode}`)

// ── weather: the whole pipeline against a stubbed upstream ────────────────
console.log('\nweather panel — pipeline')
const wx = await call(ctx, '/dsh-hud/weather/state')
eq('GET /state is 200', wx.statusCode, 200)
const wxBody = wx.json()
ok('payload is ok', wxBody?.ok === true)
eq('the payload carries the refresh cadence', wxBody?.refreshMs, 60_000)
eq('location came from the IP lookup',
  [wxBody?.location?.name, wxBody?.location?.region, wxBody?.location?.source],
  ['无锡市', '江苏', 'ip'])

const current = wxBody?.current
eq('the WMO code became a condition', [current?.text, current?.glyph, current?.textEn], ['阴', '☁', 'overcast'])
eq('temperature / humidity / wind are normalized', [current?.temperature, current?.humidity, current?.windSpeed], [23.6, 56, 12.4])
eq('wind degrees became a compass point', [current?.windDirection?.zh, current?.windDirection?.en], ['东南', 'SE'])
eq('wind speed became a 蒲福风级', current?.windForce, 3)
eq('gusts are kept for the detail panel', current?.windGust, 21.5)
eq('the observation time is kept', current?.observedAt, '2026-10-01T10:30')

console.log('\nweather panel — alert matching')
eq('a city match wins outright', wxBody?.alerts?.length, 1)
const cityAlert = wxBody?.alerts?.[0]
eq('the surviving alert is the local one', cityAlert?.id, '32020041600000_20261001105007')
eq('it is scoped to the city', cityAlert?.scope, 'city')
eq('the headline was parsed into parts',
  [cityAlert?.phenomenon, cityAlert?.level, cityAlert?.tone, cityAlert?.place],
  ['大风', '蓝色', 'info', '江苏省无锡市'])
ok('the detail link points at nmc.cn', String(cityAlert?.url).startsWith('http://www.nmc.cn/publish/alarm/'))
eq('another province\'s alert never reaches this user',
  (wxBody?.alerts ?? []).some((alert) => String(alert.id).startsWith('52')), false)
eq('the alert source is named', wxBody?.alertSource, 'nmc')
eq('the whole active set was scanned in one request', wxBody?.alertsScanned, 4)

// Second location: a city with no alert of its own, so the province tier runs.
ipCity = '苏州市'
const provinceTier = (await call(ctx, '/dsh-hud/weather/refresh', { method: 'POST' })).json()
eq('a forced refresh re-resolves the location', provinceTier?.location?.name, '苏州市')
eq('with no city match the province tier applies', provinceTier?.alerts?.length, 2)
eq('every row is labelled province',
  [...new Set((provinceTier?.alerts ?? []).map((alert) => alert.scope))], ['province'])
eq('the province tier is really the user\'s own province',
  (provinceTier?.alerts ?? []).map((alert) => String(alert.id).slice(0, 2)), ['32', '32'])

console.log('\nweather panel — cache and guards')
const wxHits = () => upstreamHits.filter((url) => url.startsWith('/wx/')).length
const beforeWx = wxHits()
await call(ctx, '/dsh-hud/weather/state')
eq('a second GET reuses the cache', wxHits(), beforeWx)
const wxHead = await call(ctx, '/dsh-hud/weather/state', { method: 'HEAD' })
eq('HEAD /state is 200', wxHead.statusCode, 200)
eq('HEAD /state has an empty body', wxHead.body, '')
eq('POST /state is 405', (await call(ctx, '/dsh-hud/weather/state', { method: 'POST' })).statusCode, 405)
eq('GET /refresh is 405', (await call(ctx, '/dsh-hud/weather/refresh', { method: 'GET' })).statusCode, 405)
eq('cross-origin GET /state is 403',
  (await call(ctx, '/dsh-hud/weather/state', { origin: 'https://evil.example' })).statusCode, 403)
eq('cross-origin POST /refresh is 403',
  (await call(ctx, '/dsh-hud/weather/refresh', { method: 'POST', origin: 'https://evil.example' })).statusCode, 403)

console.log('\nweather panel — pure helpers')
const weatherPanel = mod.__test.PANELS.find((panel) => panel.id === 'weather')
const wxTest = weatherPanel.__test
eq('江苏 → 32', wxTest.provincePrefix('江苏省'), '32')
eq('北京市 → 11', wxTest.provincePrefix('北京市'), '11')
eq('内蒙古自治区 → 15', wxTest.provincePrefix('内蒙古自治区'), '15')
eq('广西壮族自治区 → 45', wxTest.provincePrefix('广西壮族自治区'), '45')
eq('新疆维吾尔自治区 → 65', wxTest.provincePrefix('新疆维吾尔自治区'), '65')
eq('西藏自治区 → 54', wxTest.provincePrefix('西藏自治区'), '54')
eq('an English region yields no prefix', wxTest.provincePrefix('Jiangsu Sheng'), undefined)
eq('the city needle drops the 市 suffix', wxTest.cityNeedle('无锡市'), '无锡')
eq('12.4 km/h is force 3', wxTest.beaufort(12.4), 3)
eq('120 km/h is force 12', wxTest.beaufort(120), 12)
eq('0 km/h is force 0', wxTest.beaufort(0), 0)
eq('135° is south-east', wxTest.compassOf(135).zh, '东南')
eq('an unparseable headline passes through', wxTest.parseAlertTitle('随手一条').phenomenon, '随手一条')
eq('a 预警 without 信号 still parses', wxTest.parseAlertTitle('北京市气象台发布雷电黄色预警').level, '黄色')
eq('红色 is the most severe tone', wxTest.parseAlertTitle('北京市气象台发布暴雨红色预警信号').tone, 'crit')

// A location that cannot be resolved must produce a fix-it hint, not a crash.
console.log('\nweather panel — unresolved location')
const ctx2 = mockContext()
const handles2 = mod.apply(ctx2, {
  panels: { weather: { city: '不存在的地方XYZ', geocodeUrl: `${base}/wx/geocode`, forecastUrl: `${base}/wx/forecast` } },
})
const unresolved = (await call(ctx2, '/dsh-hud/weather/state')).json()
eq('no location, no crash', unresolved?.location, null)
ok('a hint explains what to set', typeof unresolved?.hint?.title === 'string', JSON.stringify(unresolved?.hint))
eq('the weather section is simply empty', unresolved?.current, null)
ok('the hint names the settings path',
  (unresolved?.hint?.steps ?? []).some((step) => step.includes('panels.weather')), JSON.stringify(unresolved?.hint?.steps))
// Every `apply()` mounts EVERY registered panel — the panel registry is the
// module's, not the call's — so a second mount reports all three again.
eq('apply() still reports every panel', handles2.panels().sort(), ['bond', 'futures', 'github', 'market', 'parcel', 'quota', 'sql', 'todo', 'weather'])

console.log('\nroute verbs, and 期货收藏')
{
  // ── the GET that answered 405 ──
  //
  // The fx route was wrapped in `write(req, res, run)` — the panel's helper for WRITE routes, whose
  // first act is to refuse anything that is not a POST. So a correct GET was answered
  // `method-not-allowed` by a route that existed, which then had the shell's "restart the host"
  // hint stapled to it. Both halves of that are now asserted: the verb works, and a route's own JSON
  // error is not mistaken for a missing route.
  /**
 * ── 今日涨跌榜 ──────────────────────────────────────────────────────────────
 *
 * The filter is the whole point. The live endpoint's raw top is a first-day listing at +206%
 * and a delisting at -72%: both true, neither the market's move, and a "today's movers" list
 * that opens with them is answering a different question.
 */
{
  const market = await import('../panels/market/host.js')
  const { rankableName, parseRankRow } = market.__test

  eq('a new listing is not a market move', rankableName('N力勤'), false)
  eq('nor is a next-new listing', rankableName('C三瑞'), false)
  eq('nor is a delisting', rankableName('元道退'), false)
  ok('but an ordinary stock is, including an ST one',
    rankableName('善水科技') && rankableName('*ST仕净') && rankableName('康希诺-U'), 'ST and -U are normal listings')
  eq('and an empty name is not', rankableName('   '), false)

  const parsed = parseRankRow({ f12: '688185', f13: 1, f14: '康希诺', f2: 102.64, f3: 20, f4: 17.11, f6: 1065144349, f15: 103, f16: 88, f17: 90, f18: 85.53 })
  eq('a screen row becomes the shape the card renders',
    [parsed.secid, parsed.code, parsed.name, parsed.price, parsed.changePct, parsed.change],
    ['1.688185', '688185', '康希诺', 102.64, 20, 17.11])
  ok('with the money behind the move, and the whole day range',
    parsed.amount === 1065144349 && parsed.high === 103 && parsed.low === 88 && parsed.prevClose === 85.53,
    JSON.stringify(parsed))
  eq('a row with no code is dropped rather than rendered blank', parseRankRow({ f14: '没有代码' }), undefined)
  eq('and so is a row with no name', parseRankRow({ f12: '600519', f13: 1 }), undefined)

  // The route itself, against an upstream that is not there: it must answer with EMPTY halves
  // and say why, not 500 — the card has a place for that sentence.
  const rankCall = await call(ctx, '/dsh-hud/market/rank')
  eq('the ranking route answers even with no upstream', rankCall.statusCode, 200)
  const body = rankCall.json()
  ok('and it always carries both halves, so the card never has to guess',
    body.ok === true && Array.isArray(body.up?.rows) && Array.isArray(body.down?.rows) && body.size === 20,
    JSON.stringify({ ok: body.ok, size: body.size, up: body.up?.rows?.length, down: body.down?.rows?.length }))
  ok('and it reports which session those numbers belong to',
    body.session !== undefined && typeof body.session.open === 'boolean' && body.session.tradingDay !== undefined,
    JSON.stringify(body.session))
  eq('a POST to it is refused as a method', (await call(ctx, '/dsh-hud/market/rank', { method: 'POST' })).statusCode, 405)
}

const fxGet = await call(ctx, '/dsh-hud/market/fx')
  eq('GET on the fx route is allowed', fxGet.statusCode, 200)
  eq('and it answers the three groups the view draws',
    fxGet.json()?.groups, ['对人民币', '主要货币对', '指数'])
  eq('POST on it is refused, with the route\'s own JSON reason',
    [(await call(ctx, '/dsh-hud/market/fx', { method: 'POST' })).statusCode,
      (await call(ctx, '/dsh-hud/market/fx', { method: 'POST' })).json()?.error],
    [405, 'method-not-allowed'])

  // ── 收藏 ──
  const favGet = await call(ctx, '/dsh-hud/futures/favorite')
  eq('the favourite route takes POST only', favGet.statusCode, 405)
  const starred = await call(ctx, '/dsh-hud/futures/favorite', {
    method: 'POST', body: { secid: '113.rbm', on: true },
  })
  eq('starring a contract returns the whole new list', starred.json()?.favorites, ['113.rbm'])
  const starredTwo = await call(ctx, '/dsh-hud/futures/favorite', {
    method: 'POST', body: { secid: '114.mm', on: true },
  })
  eq('and a second star is appended, in the order they were added',
    starredTwo.json()?.favorites, ['113.rbm', '114.mm'])
  eq('starring the same one twice does not duplicate it',
    (await call(ctx, '/dsh-hud/futures/favorite', { method: 'POST', body: { secid: '113.rbm', on: true } }))
      .json()?.favorites,
    ['113.rbm', '114.mm'])
  eq('unstarring removes exactly that one',
    (await call(ctx, '/dsh-hud/futures/favorite', { method: 'POST', body: { secid: '113.rbm', on: false } }))
      .json()?.favorites,
    ['114.mm'])
  // The list is a DEFAULT, not a permission — but a typo must not reach storage.
  eq('a secid that is not a secid is refused',
    (await call(ctx, '/dsh-hud/futures/favorite', { method: 'POST', body: { secid: 'not a secid!', on: true } }))
      .statusCode,
    400)
  eq('and an empty one', (await call(ctx, '/dsh-hud/futures/favorite', { method: 'POST', body: {} })).statusCode, 400)
  // The card reads them back on the next poll.
  eq('and the state carries them, so a reload keeps the stars',
    (await call(ctx, '/dsh-hud/futures/state')).json()?.favorites, ['114.mm'])
  // Clean up: a leftover star would leak into whatever runs next.
  await call(ctx, '/dsh-hud/futures/favorite', { method: 'POST', body: { secid: '114.mm', on: false } })
}

console.log('\nFX — the 汇率 board the 汇率 view reads')
{
  const marketLib = await import('../panels/market/host.js')
  const board = marketLib.FX_BOARD

  // Every secid was verified live before it was written down, and the two obvious guesses were
  // NOT: there is no `119.USDCNY` (the onshore pair is not on that board) and no `100.USDX`
  // (the dollar index is `100.UDI`). A code that does not exist returns no row rather than an
  // error, so a wrong one renders as a missing line and nothing else.
  eq('the board is sixteen instruments', board.length, 16)
  eq('with no duplicates', board.length - new Set(board.map((one) => one.secid)).size, 0)
  eq('across three groups, as the view draws them',
    [...new Set(board.map((one) => one.group))], ['对人民币', '主要货币对', '指数'])
  ok('every entry carries the fields the parser reads',
    board.every((one) => typeof one.secid === 'string' && typeof one.zh === 'string'
      && typeof one.en === 'string' && typeof one.group === 'string'),
    JSON.stringify(board.find((one) => typeof one.en !== 'string')))

  // ── the field contract that produced a 10000× error ──
  //
  // `parseForexRow` scales by 10^f1: it expects the RAW value plus the decimal count. The route
  // asked for `fltt=2`, which returns an already-human number with no `f1`, so the parser fell
  // back to 10^4 — and 6.7065 became 0.00067. Nothing on screen looked broken.
  const parsed = marketLib.parseForexRow({ f1: 4, f2: 67065, f3: -11, f12: 'USDCNH', f14: '美元兑离岸人民币' }, board[0])
  eq('a raw value with its own decimal count comes out as the rate', parsed.value, 6.7065)
  eq('and the change is in hundredths of a percent', parsed.changePct, -0.11)
  eq('with the group carried through, so a view can group it', parsed.group, '对人民币')
  eq('and the index flagged, because it is not a pair', board.filter((one) => one.index === true).map((one) => one.zh), ['美元指数'])
  // A missing row is filtered out rather than rendered blank — the endpoint omits unknown secids.
  eq('an unknown secid yields nothing rather than a zero', marketLib.parseForexRow(undefined, board[0]), undefined)
}

console.log('\nfutures — 主连, 持仓量, and the curve')
{
  const futuresLib = await import('../panels/futures/host.js')
  const ft = futuresLib.__test

  // ── the contract list is evidence, not a guess ──
  //
  // Every secid shipped was requested from the live quote endpoint and answered with a price.
  // Three of the first guesses were WRONG in a way the panel would not show: 锰硅 and 硅铁 are on
  // 郑商所 (115), not 大商所 (114), and 中证1000 is IMM, not IM0. A wrong secid renders as a
  // blank row, which is exactly the failure that never gets reported.
  eq('every contract is a 主连 or a foreign continuous symbol',
    ft.CONTRACTS.filter((one) => !/m$/i.test(one.secid.split('.')[1]) && !/00Y$/i.test(one.secid.split('.')[1])),
    [])
  eq('and no secid is listed twice',
    ft.CONTRACTS.length - new Set(ft.CONTRACTS.map((one) => one.secid)).size, 0)
  eq('with every exchange prefix that was found rather than assumed',
    [...new Set(ft.CONTRACTS.map((one) => one.secid.split('.')[0]))].sort(),
    ['101', '102', '103', '112', '113', '114', '115', '220', '225'])
  ok('and every sector the card draws has a session rule',
    ft.SECTORS.every((sector) => ft.SESSIONS.some((session) => session.markets.includes(sector))),
    JSON.stringify(ft.SECTORS.filter((sector) => !ft.SESSIONS.some((s) => s.markets.includes(sector)))))

  // ── 持仓量: f108, the field a stock returns as a dash ──
  const row = ft.quoteRow({ secid: '113.rbm', zh: '螺纹钢', sector: '黑色' },
    { f12: 'rbm', f14: '螺纹钢主连', f2: 3112, f3: 0.35, f4: 11, f5: 638932, f108: 1592266 })
  eq('持仓量 is carried, separately from the volume',
    [row.openInterest, row.volume], [1592266, 638932])
  eq('and a missing field stays missing rather than becoming zero',
    ft.quoteRow({ secid: '1.x', zh: 'x', sector: 'x' }, { f12: 'x', f2: 1 }).openInterest, undefined)
  eq('the change and the percentage are both kept, because a tick is not a cent',
    [row.change, row.changePercent], [11, 0.35])

  // ── the curve ──
  eq('a 主连 code knows its product', [
    ft.productOfCode('rbm'), ft.productOfCode('IFM'), ft.productOfCode('MAM'), ft.productOfCode('lcm'),
  ], ['rb', 'IF', 'MA', 'lc'])
  // A foreign continuous symbol has no month series, and the panel says so instead of drawing an
  // empty curve that looks like a failed request.
  eq('and a foreign continuous symbol has none', ft.productOfCode('CL00Y'), null)

  // ── the session clock ──
  const at = (iso) => ft.sessionState(new Date(iso))
  // 2026-10-09 is the Friday after 国庆. 01:30Z = 09:30 Beijing: the commodity day session.
  eq('a commodity session is open at 09:30 Beijing', at('2026-10-09T01:30:00Z').bulk.open, true)
  // 中金所 starts at 09:30, so at 09:05 the commodities are open and the financials are not.
  eq('and the financial futures are not, because 中金所 opens later',
    [at('2026-10-09T01:05:00Z').bulk.open, at('2026-10-09T01:05:00Z').cffex.open], [true, false])
  // 22:00 Beijing = 14:00Z: the 夜盘 of the commodity groups.
  eq('the night session is open at 22:00 Beijing', at('2026-10-09T14:00:00Z').bulk.open, true)
  eq('while 中金所 has no night session at all', at('2026-10-09T14:00:00Z').cffex.open, false)
  // The metals run later than the rest, which is why the groups are separate.
  eq('the metals are still trading at 23:30 when the others have stopped',
    [at('2026-10-09T15:30:00Z').metal.open, at('2026-10-09T15:30:00Z').bulk.open], [true, false])
  // 10-02 is 国庆: nothing trades, and the card says which holiday.
  const holiday = at('2026-10-02T02:00:00Z')
  eq('a holiday shuts every domestic group', [holiday.cffex.tradingDay, holiday.bulk.tradingDay], [false, false])
  eq('with the reason', holiday.bulk.closedLabel, '国庆')
  // 外盘 is never CLAIMED to be open or shut: COMEX and NYMEX keep their own calendar and the
  // exchange data is the authority on it.
  eq('and 外盘 makes no claim about its own hours', [holiday.global.tradingDay, holiday.global.open], [true, true])
  eq('which the session record admits', holiday.global.global, true)

  // ── and the panel really mounts, with its routes ──
  eq('the panel is registered', mod.__test.PANELS.some((panel) => panel.id === 'futures'), true)
  for (const route of ['state', 'refresh', 'kline', 'curve']) {
    ok(`the ${route} route is mounted`, ctx.routes.has(`/dsh-hud/futures/${route}`))
  }
  eq('a bare GET on refresh is refused', (await call(ctx, '/dsh-hud/futures/refresh')).statusCode, 405)
}

console.log('\nmarket — trading days, not just weekends')
{
  const marketLib = await import('../panels/market/host.js')
  const mk = marketLib.__test

  // 2026-10-02 is a FRIDAY inside the 国庆节 closure — the date this was written for. A weekday
  // is not a trading day, and the panel used to poll all day for a price that cannot change.
  const holiday = mk.session(new Date('2026-10-02T02:00:00Z'))
  eq('a holiday is not a trading day', holiday.cn.tradingDay, false)
  eq('and the reason is the holiday, not the hour', holiday.cn.closed, 'holiday')
  eq('with the name, so the card can say which one', holiday.cn.closedLabel, '国庆')

  // A Saturday in the same week: shut for the ordinary reason.
  eq('a weekend is shut for the ordinary reason',
    mk.session(new Date('2026-10-03T02:00:00Z')).cn.closed, 'weekend')

  // The working Friday after the holiday must be untouched: a calendar that swallows real days
  // is worse than no calendar.
  const working = mk.session(new Date('2026-10-09T02:00:00Z'))
  eq('a working Friday is a trading day again', working.cn.tradingDay, true)
  eq('with no holiday label', working.cn.closedLabel, undefined)
  // …and the two kinds of "shut" stay distinct, which is what the two intervals hang on.
  eq('the lunch break is still a trading day', mk.session(new Date('2026-10-09T04:00:00Z')).cn.tradingDay, true)
  eq('but no session is open then', mk.session(new Date('2026-10-09T04:00:00Z')).cn.open, false)
  eq('while the morning session is open at 09:30', mk.session(new Date('2026-10-09T01:30:00Z')).cn.open, true)

  // Every shipped date is a WEEKDAY. One that fell on a Saturday would be dead weight and would
  // suggest this table is what handles weekends.
  const dates = mk.holidaysFor('cn')
  eq('the shipped calendar covers the 2026 closures', dates.length, 19)
  eq('and every entry is a weekday, because weekends are handled elsewhere',
    dates.filter(([day]) => ['Sat', 'Sun'].includes(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' })
        .format(new Date(day + 'T04:00:00Z')),
    )), [])

  // Hong Kong and the US ship EMPTY on purpose.
  eq('香港和美国没有内置日历', [mk.holidaysFor('hk').length, mk.holidaysFor('us').length], [0, 0])
  eq('and the setting parses market:date:label',
    mk.extraHolidays('hk:2026-12-25:圣诞, us:2026-11-26:感恩节').hk,
    [['2026-12-25', '圣诞']])
  eq('while a malformed entry is ignored rather than guessed at',
    mk.extraHolidays('hk:not-a-date, nonsense, us:2026-11-26')?.us,
    [['2026-11-26', '休市']])
  eq('and a configured closure really closes the market',
    mk.session(new Date('2026-12-25T02:00:00Z'), mk.extraHolidays('hk:2026-12-25:圣诞')).hk.tradingDay,
    false)

  // ── the report is filtered to what the watch list holds ──
  //
  // "Is any session open" is the wrong question on a day like this: a watch list of A-shares was
  // polled every ten seconds through 国庆节 because the New York session happened to be running.
  // The prices on that list could not change.
  const rows = (watch) => watch.split(',').map((secid) => ({ secid }))
  const forList = (iso, watch) => mk.sessionFor(mk.session(new Date(iso)), mk.watchedMarkets(rows(watch)))
  const A_SHARES = '1.000001,0.399001'
  const MIXED = '1.000001,116.00700,105.AAPL'

  eq('a secid knows its session', [
    mk.marketOfSecid('1.000001'), mk.marketOfSecid('0.399001'),
    mk.marketOfSecid('116.00700'), mk.marketOfSecid('105.AAPL'),
  ], ['cn', 'cn', 'hk', 'us'])
  eq('and an unknown prefix claims nothing', mk.marketOfSecid('999.WHATEVER'), undefined)

  const cnOnHoliday = forList('2026-10-02T02:00:00Z', A_SHARES)
  eq('an A-share-only list is NOT open on 国庆节', cnOnHoliday.anyOpen, false)
  eq('and it is not a trading day either, which is what stretches the interval',
    cnOnHoliday.anyTradingDay, false)
  eq('while a list that also holds US stocks still polls, because that market IS trading',
    forList('2026-10-02T02:00:00Z', MIXED).anyOpen, true)
  eq('an A-share-only list is open on a working day',
    forList('2026-10-09T01:30:00Z', A_SHARES).anyOpen, true)
  eq('and at lunch it is a trading day but not open — the middle interval',
    [forList('2026-10-09T04:00:00Z', A_SHARES).anyTradingDay,
      forList('2026-10-09T04:00:00Z', A_SHARES).anyOpen], [true, false])
  eq('a Saturday is a non-trading day for an A-share list',
    forList('2026-10-03T02:00:00Z', A_SHARES).anyTradingDay, false)
  // No opinion is not the same as "closed": an unrecognised list keeps every market, because
  // polling too little is the worse failure — a stale price looks like a quiet market.
  eq('an unrecognised watch list keeps every market rather than shutting them all',
    forList('2026-10-02T02:00:00Z', '999.NOPE').anyOpen,
    mk.session(new Date('2026-10-02T02:00:00Z')).anyOpen)
  eq('and the three intervals are an order of magnitude apart',
    [mk.CLOSED_POLL_MS / 1000, mk.NON_TRADING_POLL_MS / 1000], [600, 3600])
}

// ── parcel: watch list, polling, change detection ─────────────────────────
console.log('\nparcel panel — carrier detection is offline')
const parcelPanel = mod.__test.PANELS.find((panel) => panel.id === 'parcel')
const pkTest = parcelPanel.__test
eq('an SF number names 顺丰 outright', pkTest.detectCarriers('SF1234567890123'),
  [{ code: 'shunfeng', name: '顺丰速运', confidence: 3 }])
ok('a bare 12-digit number yields several guesses', pkTest.detectCarriers('781234567890').length >= 2,
  JSON.stringify(pkTest.detectCarriers('781234567890')))
ok('every guess is a code the endpoint accepts',
  pkTest.detectCarriers('781234567890').every((candidate) => pkTest.carrierByCode(candidate.code) !== undefined))
eq('too short a number yields nothing', pkTest.detectCarriers('123'), [])
eq('the number is normalized for comparison', pkTest.normalizeNumber(' sf 1234-5678 '), 'SF12345678')
eq('the state legend is kuaidi100\'s', [pkTest.stateInfo(5).zh, pkTest.stateInfo(3).zh, pkTest.stateInfo(2).tone], ['派送中', '已签收', 'warn'])
eq('an unmapped state is reported as itself, not guessed', pkTest.stateInfo(99).zh, '状态 99')

console.log('\nparcel panel — add, query, normalize')
const added = (await call(ctx, '/dsh-hud/parcel/add', {
  method: 'POST', body: { nu: 'SF0000000000001', com: 'shunfeng', label: '键盘' },
})).json()
eq('the parcel was added', added?.parcels?.length, 1)
const firstParcel = added?.parcels?.[0]
eq('the carrier name resolves from the code', firstParcel?.carrier, '顺丰速运')
eq('the chip comes from the API state code', [firstParcel?.stateText, firstParcel?.tone], ['派送中', 'brand'])
eq('nodes arrive newest-first and are stored oldest-first',
  firstParcel?.nodes?.map((node) => node.text.slice(0, 5)), ['【上海市】', '【无锡市】', '【无锡市】'])
eq('the newest scan becomes the summary', firstParcel?.summary, '快件正在派送中，请保持电话畅通')
eq('the place comes from the scan text', firstParcel?.location, '无锡市')
eq('a node carries no coordinates — only a time and a sentence',
  Object.keys(firstParcel?.nodes?.[0] ?? {}).sort(), ['at', 'text'])
ok('a freshly added parcel is not "news"', firstParcel?.unread === false)
eq('the badge starts empty', handles.panel('parcel').countUnread(), 0)

console.log('\nparcel panel — the timeline moves, and the badge notices')
extraScans = 2
await call(ctx, '/dsh-hud/parcel/refresh', { method: 'POST' })
const moved = handles.panel('parcel').payload().parcels[0]
ok('a new scan marks the parcel unread', moved?.unread === true)
eq('and counts exactly how many nodes are new', moved?.newNodes, 2)
eq('the badge counts it', handles.panel('parcel').countUnread(), 1)
await call(ctx, '/dsh-hud/parcel/read', { method: 'POST', body: { nu: 'SF0000000000001' } })
ok('marking read clears it', handles.panel('parcel').payload().parcels[0].unread === false)
eq('and the badge returns to zero', handles.panel('parcel').countUnread(), 0)

console.log('\nparcel panel — a number with no scans yet')
const noTrack = (await call(ctx, '/dsh-hud/parcel/add', {
  method: 'POST', body: { nu: '7899999999999', com: 'yuantong' },
})).json()
const tracked = noTrack?.parcels?.find((parcel) => parcel.nu === '7899999999999')
eq('查无结果 becomes an explicit state, not an empty card', [tracked?.noData, tracked?.stateText], [true, '暂无轨迹'])
eq('and it keeps no phantom nodes', tracked?.nodes?.length, 0)

console.log('\nparcel panel — cache, detect, remove, guards')
const kdHits = () => upstreamHits.filter((url) => url.startsWith('/kd/query')).length
const beforeKd = kdHits()
await call(ctx, '/dsh-hud/parcel/state')
eq('a second GET reuses the per-parcel cache', kdHits(), beforeKd)
const detected = (await call(ctx, '/dsh-hud/parcel/detect', { method: 'POST', body: { nu: 'JT1234567890123' } })).json()
eq('the detect route suggests the right carrier', detected?.candidates?.[0]?.code, 'jtexpress')
const removed = (await call(ctx, '/dsh-hud/parcel/remove', { method: 'POST', body: { nu: '7899999999999' } })).json()
ok('a parcel can be removed', (removed?.parcels ?? []).every((parcel) => parcel.nu !== '7899999999999'))
eq('an unknown carrier code is refused',
  (await call(ctx, '/dsh-hud/parcel/add', { method: 'POST', body: { nu: 'SF0000000000009', com: 'not-a-carrier' } })).statusCode, 400)
eq('a duplicate number is refused',
  (await call(ctx, '/dsh-hud/parcel/add', { method: 'POST', body: { nu: 'SF0000000000001', com: 'shunfeng' } })).statusCode, 400)
eq('a too-short number is refused',
  (await call(ctx, '/dsh-hud/parcel/add', { method: 'POST', body: { nu: '123', com: 'shunfeng' } })).statusCode, 400)
eq('removing something unknown is refused',
  (await call(ctx, '/dsh-hud/parcel/remove', { method: 'POST', body: { nu: 'NOPE' } })).statusCode, 400)
eq('GET /add is 405', (await call(ctx, '/dsh-hud/parcel/add', { method: 'GET' })).statusCode, 405)
eq('cross-origin POST /add is 403',
  (await call(ctx, '/dsh-hud/parcel/add', { method: 'POST', origin: 'https://evil.example', body: { nu: 'SF1', com: 'shunfeng' } })).statusCode, 403)
eq('HEAD /state is 200', (await call(ctx, '/dsh-hud/parcel/state', { method: 'HEAD' })).statusCode, 200)

// The endpoint answers a rejected carrier code with `参数错误` on an HTTP 200,
// so that branch cannot be reached through /add (the carrier table gates it).
// It is the branch that tells a user "pick another carrier", so it is tested
// directly.
let rejectedMessage = ''
try {
  pkTest.parseQueryResponse({ status: '400', message: '参数错误' }, { nu: 'X', com: 'yuantong' })
} catch (error) {
  rejectedMessage = error instanceof Error ? error.message : String(error)
}
ok('a rejected carrier code is explained as such, not as a network failure',
  rejectedMessage.includes('快递公司代码无效'), rejectedMessage)

// ── market: quotes, candles, search ───────────────────────────────────────
console.log('\nmarket panel — quoting')
const marketPanel = mod.__test.PANELS.find((panel) => panel.id === 'market')
const mkTest = marketPanel.__test
// `f1` is the decimal count: reading `f2` raw gives 384219 for a 3842.19 index.
eq('prices are scaled by the API\'s own decimal field',
  [mkTest.parseQuote({ f1: 2, f2: 384219, f3: 31, f4: 1174, f12: '000001', f13: 1, f14: '上证指数' }).price,
    mkTest.parseQuote({ f1: 3, f2: 140735, f3: -12, f4: -17, f12: '511010', f13: 1, f14: 'ETF' }).price],
  [3842.19, 140.735])
eq('the percentage comes back as a percentage', mkTest.parseQuote({ f1: 2, f3: 31, f12: 'x', f13: 1 }).changePct, 0.31)
eq('a secid is only accepted in market.code form', [mkTest.secidOf('1.600519'), mkTest.secidOf('sh600519'), mkTest.secidOf('105.aapl')],
  ['1.600519', '', '105.AAPL'])
eq('periods map to eastmoney klt codes', [mkTest.periodKlt('day'), mkTest.periodKlt('week'), mkTest.periodKlt('month'), mkTest.periodKlt('bogus')],
  [101, 102, 103, 101])

const mkState = (await call(ctx, '/dsh-hud/market/state')).json()
eq('the configured watch list comes back in order',
  (mkState?.quotes ?? []).map((row) => [row.name, row.price, row.changePct]),
  [['上证指数', 3842.19, 0.31], ['贵州茅台', 1251.24, -0.85], ['苹果', 228.15, 1.24]])
eq('the first watch entry is selected by default', mkState?.selected, '1.000001')
eq('the session report covers all three markets, and whether today trades at all',
  Object.keys(mkState?.session ?? {}).sort(), ['anyOpen', 'anyTradingDay', 'cn', 'hk', 'us'])
ok('a quote cadence is reported', (mkState?.pollMs ?? 0) >= 10_000, String(mkState?.pollMs))

console.log('\nmarket panel — session clock (deterministic instants)')
// 02:00Z = 10:00 Beijing on a Wednesday → A-shares trading, US shut.
const cnMorning = mkTest.sessionState(new Date('2026-09-30T02:00:00Z'))
eq('Wednesday 10:00 Beijing: A-shares open, US shut', [cnMorning.cn.open, cnMorning.us.open], [true, false])
// 04:00Z = 12:00 Beijing → the lunch break, which must NOT read as open.
const cnLunch = mkTest.sessionState(new Date('2026-09-30T04:00:00Z'))
eq('the lunch break is not "open"', cnLunch.cn.open, false)
// Saturday in every timezone involved.
const weekend = mkTest.sessionState(new Date('2026-10-03T02:00:00Z'))
eq('a weekend shuts everything', [weekend.cn.open, weekend.hk.open, weekend.us.open, weekend.anyOpen], [false, false, false, false])

console.log('\nmarket panel — candles')
const mkWeek = (await call(ctx, '/dsh-hud/market/kline?secid=1.600519&period=week')).json()
eq('the request asked for weekly candles', upstreamHits.some((url) => url.includes('/em/kline') && url.includes('klt=102')), true)
eq('the instrument is echoed back', [mkWeek?.name, mkWeek?.code, mkWeek?.period], ['贵州茅台', '600519', 'week'])
eq('candles are oldest-first with OHLC', mkWeek?.candles?.map((candle) => [candle.date, candle.open, candle.close, candle.high, candle.low]),
  [['2026-09-28', 1250, 1262.99, 1266, 1247.1], ['2026-09-29', 1262.99, 1257.12, 1268.4, 1254.1], ['2026-09-30', 1257.12, 1251.24, 1271.5, 1250.89]])
eq('a truncated row is skipped, not trusted', mkWeek?.candles?.length, 3)
ok('volume and amount ride along', mkWeek?.candles?.[2]?.volume === 30981 && mkWeek?.candles?.[2]?.amount === 3894630783)

// The daily window is ONE MONTH now, enforced on the DATES: a year of daily bars
// is a smear, and the detail lives in the readout instead.
const mkDay = (await call(ctx, '/dsh-hud/market/kline?secid=1.600519&period=day')).json()
const monthFloor = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10)
eq('日K asks for far fewer bars than it used to',
  upstreamHits.some((url) => url.includes('/em/kline') && url.includes('klt=101') && url.includes('lmt=60')), true)
eq('and every candle it keeps is inside the month',
  (mkDay?.candles ?? []).every((candle) => candle.date >= monthFloor), true)
eq('the fixture has an older row that the window had to drop', (mkDay?.candles ?? []).length, 3)
eq('the period menu states the window each period uses',
  mkTest.PERIODS.map((entry) => [entry.value, entry.intraday === true ? 'session' : entry.windowDays]),
  [['realtime', 'session'], ['m5', 'session'], ['m15', 'session'], ['h1', 'session'], ['day', 31], ['week', 365], ['month', 365]])

console.log('\nmarket panel — search, add, select, period, guards')
const mkSearch = (await call(ctx, '/dsh-hud/market/search', { method: 'POST', body: { input: '茅台' } })).json()
eq('search maps QuoteID to a secid', (mkSearch?.results ?? []).map((hit) => [hit.name, hit.secid]), [['贵州茅台', '1.600519'], ['五粮液', '0.000858']])
const mkAdded = (await call(ctx, '/dsh-hud/market/add', { method: 'POST', body: { secid: '0.000858', name: '五粮液' } })).json()
ok('adding puts it in the list', (mkAdded?.quotes ?? []).some((row) => row.secid === '0.000858'))
eq('and selects it', mkAdded?.selected, '0.000858')
eq('a duplicate is refused', (await call(ctx, '/dsh-hud/market/add', { method: 'POST', body: { secid: '0.000858' } })).statusCode, 400)
eq('a malformed secid is refused', (await call(ctx, '/dsh-hud/market/add', { method: 'POST', body: { secid: 'sh600519' } })).statusCode, 400)
eq('removing something absent is refused', (await call(ctx, '/dsh-hud/market/remove', { method: 'POST', body: { secid: '9.999999' } })).statusCode, 400)
const mkRemoved = (await call(ctx, '/dsh-hud/market/remove', { method: 'POST', body: { secid: '0.000858' } })).json()
ok('removing drops it', (mkRemoved?.quotes ?? []).every((row) => row.secid !== '0.000858'))
eq('an unknown period is refused', (await call(ctx, '/dsh-hud/market/period', { method: 'POST', body: { period: 'hour' } })).statusCode, 400)
eq('a valid period sticks', (await call(ctx, '/dsh-hud/market/period', { method: 'POST', body: { period: 'month' } })).json()?.period, 'month')
await call(ctx, '/dsh-hud/market/period', { method: 'POST', body: { period: 'day' } })
eq('GET /add is 405', (await call(ctx, '/dsh-hud/market/add', { method: 'GET' })).statusCode, 405)
eq('cross-origin POST /add is 403',
  (await call(ctx, '/dsh-hud/market/add', { method: 'POST', origin: 'https://evil.example', body: { secid: '1.600000' } })).statusCode, 403)
eq('HEAD /state is 200', (await call(ctx, '/dsh-hud/market/state', { method: 'HEAD' })).statusCode, 200)
const mkHits = () => upstreamHits.filter((url) => url.startsWith('/em/quote')).length
const beforeMk = mkHits()
await call(ctx, '/dsh-hud/market/state')
eq('a second GET reuses the quote cache', mkHits(), beforeMk)

// ── bond: yield curve, series, FRED, spread ───────────────────────────────
console.log('\nbond panel — the CN curve')
const bondPanel = mod.__test.PANELS.find((panel) => panel.id === 'bond')
const bdTest = bondPanel.__test
const bdState = (await call(ctx, '/dsh-hud/bond/state')).json()
eq('the curve is dated by its newest published day', bdState?.cn?.date, '2026-09-30')
eq('only quoted tenors are kept, with labels',
  (bdState?.cn?.curve ?? []).map((point) => [point.label, point.value]),
  [['1M', 1.01], ['3M', 1.16], ['6M', 1.28], ['1Y', 1.38], ['3Y', 1.52], ['5Y', 1.68], ['7Y', 1.82], ['10Y', 1.95], ['30Y', 2.1]])
eq('the curve is ordered short → long', (bdState?.cn?.curve ?? []).map((point) => point.tenor), [0.083, 0.25, 0.5, 1, 3, 5, 7, 10, 30])
// The order is spelled out in KEY_TENORS because deriving it from the label
// map puts the integer-like keys first (1Y→30Y) and the decimals last (1M/3M/6M).
ok('the label map keeps its decimals out of the integer-key trap',
  Object.keys(bdTest.TENOR_LABELS).slice(0, 3).join(','), '1,2,3')
// The CN curve cannot be candled (chinamoney returns ~75 rows/day and answers an
// HTML guard page to bursts), so the summary carries no trend series at all —
// progress shows up in the K-lines below instead.
eq('the summary carries no trend series', bdState?.cn?.trend, undefined)
eq('but it names what CAN be charted',
  (bdState?.charts ?? []).map((entry) => [entry.name, entry.kind]),
  [['十年国债ETF', 'price'], ['国债ETF', 'price'], ['可转债ETF', 'price'], ['城投债ETF', 'price']])
eq('and which one is selected', bdState?.chart, '1.511260')
eq('and offers 实时 + 3 intraday + 日/周/月',
  (bdState?.periods ?? []).map((entry) => entry.value),
  ['realtime', 'm5', 'm15', 'h1', 'day', 'week', 'month'])
// 28 records were served; the unpublished one is dropped, so 27 rows parse.
eq('the whole fetched set is reported (minus the unpublished row)', bdState?.cn?.rows, 27)

console.log('\nbond panel — domestic only')
// No US leg at all, by request: no `us` section, no spread, no FRED config.
eq('the payload carries no US section', bdState?.us, undefined)
eq('and no cross-market spread', bdState?.spread, undefined)
eq('the 10Y is lifted out of the curve as a single number', bdState?.cn?.ten, 1.95)
eq('only the two domestic sources are named', Object.keys(bdState?.sources ?? {}).sort(), ['cn', 'etf'])
console.log('\nbond panel — the K-line route (日K / 周K / 月K)')
const bdDay = (await call(ctx, '/dsh-hud/bond/kline')).json()
eq('day candles come back with the full OHLC',
  (bdDay?.candles ?? []).map((candle) => [candle.date, candle.open, candle.close, candle.high, candle.low]),
  [['2026-09-29', 134.6, 134.5, 134.7, 134.4], ['2026-09-30', 134.5, 134.804, 134.9, 134.45]])
eq('a truncated row is skipped', (bdDay?.candles ?? []).length, 2)
eq('and the volume rides along for the strip', (bdDay?.candles ?? [])[1]?.volume, 2400)
eq('the default instrument is the 10Y bond ETF', [bdDay?.secid, bdDay?.kind, bdDay?.period], ['1.511260', 'price', 'day'])
const bdWeek = (await call(ctx, '/dsh-hud/bond/kline?period=week')).json()
eq('weekly candles ask the upstream for klt=102',
  upstreamHits.some((url) => url.startsWith('/bd/kline') && url.includes('klt=102')), true)
eq('and come back as weekly candles', (bdWeek?.candles ?? []).map((candle) => candle.date), ['2026-09-25', '2026-10-02'])
eq('the period is echoed so the buttons can reflect it', bdWeek?.period, 'week')
const bdChart = (await call(ctx, '/dsh-hud/bond/chart', { method: 'POST', body: { secid: '1.511010', period: 'month' } })).json()
eq('choosing an instrument and a period sticks', [bdChart?.chart, bdChart?.chartPeriod], ['1.511010', 'month'])
eq('and the next K-line follows the choice', (await call(ctx, '/dsh-hud/bond/kline')).json()?.secid, '1.511010')
eq('an instrument the panel does not carry is refused',
  (await call(ctx, '/dsh-hud/bond/chart', { method: 'POST', body: { secid: '9.999999' } })).statusCode, 400)
eq('a period outside the menu is refused',
  (await call(ctx, '/dsh-hud/bond/chart', { method: 'POST', body: { period: 'year' } })).statusCode, 400)
eq('GET /chart is 405', (await call(ctx, '/dsh-hud/bond/chart', { method: 'GET' })).statusCode, 405)
eq('HEAD /kline is 200', (await call(ctx, '/dsh-hud/bond/kline', { method: 'HEAD' })).statusCode, 200)
eq('cross-origin /kline is 403',
  (await call(ctx, '/dsh-hud/bond/kline', { method: 'GET', origin: 'https://evil.example' })).statusCode, 403)
await call(ctx, '/dsh-hud/bond/chart', { method: 'POST', body: { secid: '1.511260', period: 'day' } })

console.log('\nbond panel — 实时 (one session) and the one-year cap')
// 实时 asks for klt=1 and keeps ONE session: measured live, that is 240
// one-minute bars, 09:31→15:00.
const bdLive = (await call(ctx, '/dsh-hud/bond/kline?period=realtime')).json()
eq('实时 asks the upstream for 1-minute bars',
  upstreamHits.some((url) => url.startsWith('/bd/kline') && url.includes('klt=1&')), true)
eq('and reports itself as intraday', [bdLive?.period, bdLive?.intraday], ['realtime', true])
eq('the whole session is kept', (bdLive?.candles ?? []).length, 12)
eq('and only that session', [...new Set((bdLive?.candles ?? []).map((candle) => candle.date.slice(0, 10)))], ['2026-09-30'])
// The last-year rule, on the dates rather than on the bar count.
const yearAgo = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)
eq('日K drops anything older than a year',
  (bdDay?.candles ?? []).every((candle) => candle.date >= new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10)), true)
eq('and a 400-day-old row would have been dropped',
  bdTest.trimCandles([{ date: yearAgo, close: 1 }, { date: '2026-09-30', close: 2 }], bdTest.periodOf('day')).length, 1)
eq('while an intraday trim keeps only the newest date',
  bdTest.trimCandles([
    { date: '2026-09-29 15:00', close: 1 }, { date: '2026-09-30 09:31', close: 2 }, { date: '2026-09-30 15:00', close: 3 },
  ], bdTest.periodOf('realtime')).map((candle) => candle.close), [2, 3])
eq('the menu is exactly 实时 + 3 intraday + 日/周/月',
  bdTest.PERIODS.map((entry) => [entry.value, entry.intraday === true]),
  [['realtime', true], ['m5', true], ['m15', true], ['h1', true], ['day', false], ['week', false], ['month', false]])

console.log('\nbond panel — refresh and guards')
const bdTenor = (await call(ctx, '/dsh-hud/bond/refresh', { method: 'POST' })).json()
eq('the refresh route returns the whole payload again', bdTenor?.ok, true)
eq('and the curve survives it', (bdTenor?.cn?.curve ?? []).length, 9)
eq('GET /refresh is 405', (await call(ctx, '/dsh-hud/bond/refresh', { method: 'GET' })).statusCode, 405)
eq('cross-origin POST /refresh is 403',
  (await call(ctx, '/dsh-hud/bond/refresh', { method: 'POST', origin: 'https://evil.example' })).statusCode, 403)
eq('HEAD /state is 200', (await call(ctx, '/dsh-hud/bond/state', { method: 'HEAD' })).statusCode, 200)

console.log('\nbond panel — pure helpers')
eq('an unpublished yield is dropped, not NaN',
  bdTest.parseCnRecords({ records: [{ newDateValueCN: '2026-09-30', yearTermStr: '15', maturityYieldStr: '---' }] }).length, 0)
eq('a curve with no quoted tenor returns nothing rather than a partial curve',
  bdTest.keyCurve([{ date: '2026-09-30', tenor: 50, value: 1.4 }]).points.length, 0)
eq('an eastmoney kline row becomes a close-only point',
  bdTest.parseTrend(['2026-09-30,1250.00,134.804,135.1,134.2,2000']),
  [{ date: '2026-09-30', value: 134.804 }])
eq('a malformed trend row is skipped', bdTest.parseTrend(['broken']).length, 0)
eq('and a malformed candle row is skipped too', bdTest.parseCandles({ klines: ['broken'] }).candles.length, 0)

// ── todo panel ─────────────────────────────────────────────────────────────
console.log('\ntodo panel — ICS parsing')
const td = (await import('../panels/todo/host.js')).__test
const tdNow = Date.parse('2026-10-01T10:00:00')
const tdFeed = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:a@x',
  'SUMMARY:季度评审（很长的标题继',
  ' 续在这里）',
  'DTSTART;TZID=Asia/Shanghai:20261002T140000',
  'DTEND;TZID=Asia/Shanghai:20261002T150000',
  'DESCRIPTION:带\\,逗号\\n和换行',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:b@x',
  'SUMMARY:UTC 会议',
  'DTSTART:20261003T020000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:c@x',
  'SUMMARY:全天假',
  'DTSTART;VALUE=DATE:20261005',
  'END:VEVENT',
  'BEGIN:VTODO',
  'UID:d@x',
  'SUMMARY:交报销单',
  'DUE;VALUE=DATE:20261006',
  'END:VTODO',
  'BEGIN:VEVENT',
  'UID:e@x',
  'SUMMARY:每周站会',
  'DTSTART;TZID=Asia/Shanghai:20261001T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')
const tdParsed = td.parseIcs(tdFeed, { now: tdNow, label: '飞书日历' })
eq('a folded line is stitched back together',
  tdParsed.items[0]?.title, '季度评审（很长的标题继续在这里）')
eq('and its escaped description is unescaped',
  tdParsed.items[0]?.note, '带,逗号\n和换行')
eq('a TZID wall clock is anchored to that zone, not to UTC',
  new Date(tdParsed.items[0].dueAt).toISOString(), '2026-10-02T06:00:00.000Z')
eq('a `Z` time is UTC',
  new Date(tdParsed.items.find((item) => item.title === 'UTC 会议').dueAt).toISOString(), '2026-10-03T02:00:00.000Z')
eq('an all-day date becomes 09:00 local, never midnight',
  [new Date(tdParsed.items.find((item) => item.title === '全天假').dueAt).getHours(),
    tdParsed.items.find((item) => item.title === '全天假').allDay], [9, true])
// A VTODO very often carries ONLY `DUE`. Requiring DTSTART threw it away.
eq('a VTODO with only DUE is kept',
  tdParsed.items.some((item) => item.kind === 'todo' && item.title === '交报销单'), true)
eq('nothing was skipped', tdParsed.counts.skipped, 0)
eq('COUNT=6 with BYDAY=MO,TH emits exactly six occurrences',
  tdParsed.items.filter((item) => item.title === '每周站会').length, 6)
eq('every occurrence is a real date in order',
  [...new Set(tdParsed.items.filter((item) => item.title === '每周站会').map((item) => new Date(item.dueAt).getDay()))].sort(),
  [1, 4]) // Monday and Thursday
eq('feed items are marked read-only and carry their source',
  tdParsed.items.every((item) => item.readOnly === true && item.source === '飞书日历'), true)
eq('a rule outside the supported subset is REPORTED, not silently dropped',
  td.parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:y', 'SUMMARY:年会',
    'DTSTART:20261010T100000Z', 'RRULE:FREQ=YEARLY;BYSETPOS=2;BYDAY=FR', 'END:VEVENT', 'END:VCALENDAR'].join('\n'),
  { now: tdNow }).unsupported, ['FREQ=YEARLY'])
eq('and that item is flagged approximate rather than pretending to recur',
  td.parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:y', 'SUMMARY:年会',
    'DTSTART:20261010T100000Z', 'RRULE:FREQ=YEARLY', 'END:VEVENT', 'END:VCALENDAR'].join('\n'),
  { now: tdNow }).items[0]?.approx, true)
// Three zones, one wall clock: the offsets have to differ, and be DST-correct.
const tdZoned = (zone) => new Date(td.parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:z', 'SUMMARY:z',
  `DTSTART;TZID=${zone}:20261002T140000`, 'END:VEVENT', 'END:VCALENDAR'].join('\n'), { now: tdNow }).items[0].dueAt).toISOString()
eq('the same wall clock in three zones lands at three instants',
  [tdZoned('Asia/Shanghai'), tdZoned('America/New_York'), tdZoned('Europe/London')],
  ['2026-10-02T06:00:00.000Z', '2026-10-02T18:00:00.000Z', '2026-10-02T13:00:00.000Z'])

console.log('\ntodo panel — grouping, digest and the item model')
const tdItem = (title, dueAt, extra = {}) => ({ id: title, title, dueAt, done: false, createdAt: 1, ...extra })
const tdGroups = td.groupItems([
  tdItem('前天', Date.parse('2026-09-29T15:00:00')),
  tdItem('今早', Date.parse('2026-10-01T09:00:00')),
  tdItem('今晚', Date.parse('2026-10-01T20:00:00')),
  tdItem('明天', Date.parse('2026-10-02T10:00:00')),
  tdItem('下周', Date.parse('2026-10-08T10:00:00')),
  tdItem('没日期', undefined),
  { ...tdItem('做完了', Date.parse('2026-10-01T08:00:00')), done: true, doneAt: 5 },
], tdNow)
eq('the groups are the ones the card draws',
  Object.fromEntries(Object.entries(tdGroups).map(([key, list]) => [key, list.map((item) => item.title)])),
  { overdue: ['前天'], today: ['今早', '今晚'], tomorrow: ['明天'], later: ['下周'], someday: ['没日期'], done: ['做完了'] })
eq('an item due earlier today is NOT "overdue" — a list that shouts all morning is not read',
  tdGroups.overdue.length, 1)
eq('and today is sorted by time', tdGroups.today.map((item) => new Date(item.dueAt).getHours()), [9, 20])
// The digest is the 16:30 ask: once a day, and only when tomorrow has something.
eq('before 16:30 there is no digest',
  td.digestFor([tdItem('明天', Date.parse('2026-10-02T10:00:00'))], Date.parse('2026-10-01T16:29:00'), '16:30'), null)
const tdDigest = td.digestFor([
  tdItem('明天 A', Date.parse('2026-10-02T10:00:00')),
  tdItem('明天 B', Date.parse('2026-10-02T15:00:00')),
  tdItem('今天', Date.parse('2026-10-01T18:00:00')),
], Date.parse('2026-10-01T16:30:00'), '16:30')
eq('at 16:30 it names tomorrow, and only tomorrow',
  [tdDigest.title, tdDigest.items.map((item) => item.title)], ['明天有 2 项待办', ['明天 A', '明天 B']])
eq('and it carries the day it belongs to, so it can fire exactly once',
  tdDigest.day, '2026-10-01')
eq('nothing tomorrow means no reminder at all — the ask was 如果有',
  td.digestFor([tdItem('今天', Date.parse('2026-10-01T18:00:00'))], Date.parse('2026-10-01T16:30:00'), '16:30'), null)
eq('an empty title is refused', td.makeItem({ title: '   ' }, tdNow), null)
eq('a plain date means 09:00, not midnight', new Date(td.makeItem({ title: 'x', dueAt: '2026-10-05' }, tdNow).dueAt).getHours(), 9)
eq('a snooze pushes the due time forward and un-completes it',
  (() => {
    const snoozed = td.applyPatch({ ...tdItem('x', tdNow - 3_600_000), done: true }, { snoozeMinutes: 60 }, tdNow)
    return [snoozed.dueAt - tdNow, snoozed.done]
  })(), [3_600_000, false])
eq('a snooze on a future item moves ITS time, not now+60',
  (() => {
    const base = tdNow + 86_400_000
    return td.applyPatch(tdItem('x', base), { snoozeMinutes: 60 }, tdNow).dueAt - base
  })(), 3_600_000)
eq('an unparseable due value clears the date instead of storing NaN',
  td.applyPatch(tdItem('x', tdNow), { dueAt: 'nonsense' }, tdNow).dueAt, undefined)

console.log('\ntodo panel — routes: your own items')
const tdState = (await call(ctx, '/dsh-hud/todo/state')).json()
eq('a fresh install has nothing to do', [tdState?.counts?.open, tdState?.counts?.done], [0, 0])
eq('and the default schedule is the one that was asked for',
  [tdState?.leads, tdState?.digestAt], [[60, 30, 5], '16:30'])
const tdAdded = (await call(ctx, '/dsh-hud/todo/add', { method: 'POST', body: { title: '写周报' } })).json()
eq('adding an item returns it', [tdAdded?.ok, tdAdded?.item?.title, tdAdded?.item?.source], [true, '写周报', 'local'])
eq('and the state now counts it', tdAdded?.counts?.open, 1)
const tdId = tdAdded.item.id
eq('an item with no title is refused',
  (await call(ctx, '/dsh-hud/todo/add', { method: 'POST', body: { title: '' } })).statusCode, 400)
const tdDone = (await call(ctx, '/dsh-hud/todo/update', { method: 'POST', body: { id: tdId, patch: { done: true } } })).json()
eq('completing moves it to the done group', [tdDone?.counts?.done, tdDone?.counts?.open], [1, 0])
eq('and stamps when', typeof tdDone?.groups?.done?.[0]?.doneAt, 'number')
eq('an unknown id is a 404', (await call(ctx, '/dsh-hud/todo/update', { method: 'POST', body: { id: 'nope', patch: {} } })).statusCode, 404)
const tdRemoved = (await call(ctx, '/dsh-hud/todo/remove', { method: 'POST', body: { id: tdId } })).json()
eq('removing takes it out of the payload',
  [tdRemoved?.ok, tdRemoved?.counts?.done, tdRemoved?.counts?.open], [true, 0, 0])
// The schedule is what the browser half fires notifications from.
const tdSched = (await call(ctx, '/dsh-hud/todo/add', { method: 'POST', body: { title: '开会' } })).json()
eq('an item with no date never enters the notification schedule',
  tdSched?.schedule?.some((entry) => entry.title === '开会'), false)
const tdTimed = (await call(ctx, '/dsh-hud/todo/add', { method: 'POST', body: { title: '有时间的', dueAt: '2026-10-02' } })).json()
eq('a dated item does, with its due moment intact',
  tdTimed?.schedule?.filter((entry) => entry.title === '有时间的').map((entry) => typeof entry.dueAt), ['number'])
eq('the schedule is published with the leads, so the browser needs no rules of its own',
  [tdTimed?.leads, Object.keys(tdTimed?.schedule?.[0] ?? {}).sort()],
  [[60, 30, 5], ['dueAt', 'id', 'readOnly', 'title']])

console.log('\ntodo panel — routes: calendar feeds')
eq('a subscription that is not http(s) is refused',
  (await call(ctx, '/dsh-hud/todo/feed', { method: 'POST', body: { url: 'ftp://x/y.ics' } })).statusCode, 400)
const tdProbe = (await call(ctx, '/dsh-hud/todo/feed', { method: 'POST', body: { url: `${base}/ics/basic` } })).json()
eq('probing a feed reports what it read', [tdProbe?.ok, tdProbe?.counts?.events, tdProbe?.counts?.todos], [true, 3, 1])
ok('and shows the next few so the user can confirm it is the right calendar',
  Array.isArray(tdProbe?.next) && tdProbe.next.length > 0, JSON.stringify(tdProbe?.next))
const tdLogin = (await call(ctx, '/dsh-hud/todo/feed', { method: 'POST', body: { url: `${base}/ics/login` } })).json()
eq('a feed behind a login page says exactly that, instead of "0 items"',
  [tdLogin?.ok, /登录/.test(tdLogin?.error ?? '')], [false, true])
const tdSaved = (await call(ctx, '/dsh-hud/todo/settings', {
  method: 'POST',
  body: { feeds: [{ url: `${base}/ics/basic`, label: '飞书日历' }], leads: [60, 30, 5], digestAt: '16:30' },
})).json()
eq('saving a subscription syncs it immediately', [tdSaved?.ok, tdSaved?.externalCount > 0], [true, true])
eq('the feed reports its own status, not just a count',
  tdSaved?.feeds?.map((feed) => [feed.label, typeof feed.count, feed.error ?? null]),
  [['飞书日历', 'number', null]])
eq('feed items show up with their source, flagged read-only',
  tdSaved?.groups?.today?.concat(tdSaved?.groups?.tomorrow ?? [], tdSaved?.groups?.later ?? [])
    .filter((item) => item.source === '飞书日历').every((item) => item.readOnly === true), true)
eq('a daily recurring event is expanded into several items',
  (tdSaved?.groups?.today?.length ?? 0) + (tdSaved?.groups?.tomorrow?.length ?? 0) + (tdSaved?.groups?.later?.length ?? 0) >= 4, true)
// Removing a feed item cannot delete it from someone's calendar, so it is an
// ignore on this side — and the payload says so.
const tdExternal = (tdSaved?.groups?.today ?? []).concat(tdSaved?.groups?.tomorrow ?? [], tdSaved?.groups?.later ?? [])
  .find((item) => item.readOnly === true)
const tdIgnored = (await call(ctx, '/dsh-hud/todo/remove', { method: 'POST', body: { id: tdExternal.id } })).json()
eq('hiding a feed item records an ignore instead of deleting their event',
  [tdIgnored?.ok, tdIgnored?.ignored, tdIgnored?.ignoreCount], [true, tdExternal.id, 1])
const tdBadDigest = (await call(ctx, '/dsh-hud/todo/settings', { method: 'POST', body: { digestAt: '25:00' } })).json()
eq('a nonsense digest time is refused with the expected format',
  [tdBadDigest?.ok, /HH:MM/.test(tdBadDigest?.error ?? '')], [false, true])
eq('and settings survive a re-read', (await call(ctx, '/dsh-hud/todo/state')).json()?.feedSettings?.length, 1)

console.log('\ntodo panel — guards')
eq('GET /add is 405', (await call(ctx, '/dsh-hud/todo/add', { method: 'GET' })).statusCode, 405)
eq('cross-origin POST /add is 403',
  (await call(ctx, '/dsh-hud/todo/add', { method: 'POST', origin: 'https://evil.example' })).statusCode, 403)
eq('HEAD /state is 200', (await call(ctx, '/dsh-hud/todo/state', { method: 'HEAD' })).statusCode, 200)
const tdRefreshed = (await call(ctx, '/dsh-hud/todo/refresh', { method: 'POST' })).json()
eq('the refresh route returns the whole payload again', [tdRefreshed?.ok, tdRefreshed?.digestAt], [true, '16:30'])
eq('GET /refresh is 405', (await call(ctx, '/dsh-hud/todo/refresh', { method: 'GET' })).statusCode, 405)

console.log('\ntodo panel — 邮箱 (IMAP + 授权码)')
// A real IMAP conversation, over a real socket, against a mock server that sends
// the parts a naive client gets wrong: a literal-sized header block, an encoded
// (GBK) subject, and a fold in the middle of a header.
const imapSeen = []
// node:net's createServer, NOT node:http's: both are in scope in this file, and an
// HTTP server cannot speak IMAP — it just closes the connection, which is how the
// first version of this test failed with 连接已关闭 and no server-side trace.
const imapServer = createTcpServer((socket) => {
  let stage = 0
  socket.setEncoding('utf8')
  socket.write('* OK IMAP4rev1 mock ready\r\n')
  socket.on('data', (chunk) => {
    for (const line of String(chunk).split('\r\n')) {
      if (line.trim() === '') continue
      imapSeen.push(line.slice(0, 60))
      const tag = line.split(' ')[0]
      stage += 1
      if (/ CAPABILITY/i.test(line)) socket.write('* CAPABILITY IMAP4rev1\r\n' + `${tag} OK CAPABILITY completed\r\n`)
      else if (/ LOGIN/i.test(line)) {
        // The 授权码 rule, enforced by the mock: the account password is refused.
        if (line.includes('wrongpass')) socket.write(`${tag} NO [AUTHENTICATIONFAILED] login failed\r\n`)
        else socket.write(`${tag} OK LOGIN completed\r\n`)
      } else if (/ SELECT/i.test(line)) {
        socket.write('* 3 EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n' + `${tag} OK [READ-WRITE] SELECT completed\r\n`)
      } else if (/ FETCH/i.test(line)) {
        const headers = [
          // ONE encoded word, folded across two lines — which is how a long
          // Chinese subject really arrives. Two details matter and both were
          // wrong in the first version of this fixture: `?=` before the fold
          // makes it two words (the second malformed), and a base64 payload must
          // not contain `=` padding in the middle, because a decoder stops there.
          // `1tC5+rP2v9ogvdPK1Q==` is the GBK of 中国出口 接收, split 8/12.
          'Subject: =?GBK?B?1tC5+rP2',
          ' v9ogvdPK1Q==?=',
          'From: =?UTF-8?B?5byg5LiJ?= <a@b.com>',
          'Date: Wed, 01 Oct 2026 09:30:00 +0800',
          '',
        ].join('\r\n')
        const size = Buffer.byteLength(headers)
        const second = 'Subject: 未读的提醒\r\nFrom: notice@x.com\r\nDate: Tue, 30 Sep 2026 08:00:00 +0800\r\n\r\n'
        // Sequence order, oldest first — which is what a real server sends, and
        // what makes `newest first` a claim worth testing. (Writing them the
        // other way round made the assertion pass by accident.)
        socket.write(`* 2 FETCH (UID 41 FLAGS () INTERNALDATE "30-Sep-2026 08:00:00 +0800" BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${Buffer.byteLength(second)}}\r\n${second})\r\n`)
        // BYTES, counted by the runtime: a literal is a byte count, and a
        // hand-written one desynchronises the stream (which is exactly what a
        // hard-coded {58} did here — it silently mis-parsed without erroring).
        socket.write(`* 3 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE "01-Oct-2026 09:31:00 +0800" BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${size}}\r\n${headers})\r\n`)
        socket.write(`${tag} OK FETCH completed\r\n`)
      } else if (/ LOGOUT/i.test(line)) {
        socket.write('* BYE bye\r\n' + `${tag} OK LOGOUT completed\r\n`)
        socket.end()
      } else socket.write(`${tag} OK\r\n`)
    }
  })
})
await new Promise((resolve) => imapServer.listen(0, '127.0.0.1', resolve))
const imapPort = imapServer.address().port
// Point the panel at the mock. The client takes a `connect` factory for exactly
// this: the protocol logic gets exercised without a TLS certificate.
const imapTest = (await import('../lib/imap.js')).__test
const plainConnect = (options, onReady) => {
  const socket = netConnect({ host: '127.0.0.1', port: imapPort }, onReady)
  return socket
}
const mailRead = await fetchRecentHeadersMock()
async function fetchRecentHeadersMock() {
  const { fetchRecentHeaders } = await import('../lib/imap.js')
  return fetchRecentHeaders({
    host: 'imap.mock', port: imapPort, user: 'me@x.com', password: '授权码123', connect: plainConnect,
  })
}
eq('a login with an 授权码 reads the mailbox', [mailRead.total, mailRead.messages.length], [3, 2])
eq('messages come back newest first', mailRead.messages.map((message) => message.uid), [42, 41])
eq('a GBK subject is decoded', mailRead.messages[0].subject, '中国出口 接收')
eq('a UTF-8 display name is decoded', mailRead.messages[0].from, '张三')
eq('the date survives the round trip',
  new Date(mailRead.messages[0].date).toISOString(), '2026-10-01T01:30:00.000Z')
eq('flags are read, so unread mail can be told apart',
  mailRead.messages.map((message) => message.seen), [true, false])
eq('BODY.PEEK is used, so reading does not mark mail as read',
  imapSeen.some((line) => line.includes('BODY.PEEK')), true)
eq('and the client logs out instead of leaving the connection open',
  imapSeen.some((line) => / LOGOUT/i.test(line)), true)
// The single most common failure, and the one worth naming.
const mailBad = await (async () => {
  const { fetchRecentHeaders } = await import('../lib/imap.js')
  try {
    await fetchRecentHeaders({ host: 'imap.mock', port: imapPort, user: 'me@x.com', password: 'wrongpass', connect: plainConnect })
    return null
  } catch (error) {
    return error.message
  }
})()
eq('a rejected password is explained as "授权码", not as a network error',
  /授权码/.test(mailBad ?? ''), true)

console.log('\ntodo panel — 登录换 token (飞书 / 钉钉)')
const tdHost = (await import('../panels/todo/host.js')).__test
eq('both providers are declared as data, not as code branches',
  Object.keys(tdHost.LOGIN_PROVIDERS).sort(), ['dingtalk', 'feishu'])
eq('the mail presets name the real endpoints',
  [tdHost.MAIL_PRESETS['163'].host, tdHost.MAIL_PRESETS.qq.host, tdHost.MAIL_PRESETS.exmail.host],
  ['imap.163.com', 'imap.qq.com', 'imap.exmail.qq.com'])
// The authorize URL is built by the host, because the two vendors disagree about
// their parameter names.
const tdLoginUrl = tdHost.loginUrlFor({}, {
  provider: 'feishu', clientId: 'cli_abc', redirectUri: 'http://127.0.0.1:19387/dsh-hud/todo/callback',
  authorizeUrl: tdHost.LOGIN_PROVIDERS.feishu.authorizeUrl,
})
ok('the Feishu authorize URL uses its own parameter name',
  tdLoginUrl.includes('app_id=cli_abc') && tdLoginUrl.includes('response_type=code'), tdLoginUrl)
const tdDingUrl = tdHost.loginUrlFor({}, {
  provider: 'dingtalk', clientId: 'ding_abc', redirectUri: 'http://127.0.0.1:19387/dsh-hud/todo/callback',
  authorizeUrl: tdHost.LOGIN_PROVIDERS.dingtalk.authorizeUrl,
})
ok('and DingTalk uses client_id plus its consent prompt',
  tdDingUrl.includes('client_id=ding_abc') && tdDingUrl.includes('prompt=consent'), tdDingUrl)
eq('a login page is HTML-escaped, so a vendor cannot inject markup into it',
  tdHost.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;')
// No provider chosen yet: the state must say so rather than show a dead button.
const tdLoginState = (await call(ctx, '/dsh-hud/todo/state')).json()
eq('the payload carries the login state with no secrets in it',
  [tdLoginState?.oauth?.provider, 'clientSecret' in (tdLoginState?.oauth ?? {}), 'token' in (tdLoginState?.oauth ?? {})],
  ['', false, false])
eq('and it carries the mail settings with no secret either',
  ['secret' in (tdLoginState?.mail ?? {}), tdLoginState?.mail?.preset], [false, 'custom'])
const tdSaved2 = (await call(ctx, '/dsh-hud/todo/mail', {
  method: 'POST',
  body: { preset: '163', user: 'me@163.com', secret: '授权码' },
})).json()
eq('saving mail settings fills the host from the preset',
  [tdSaved2?.mail?.host, tdSaved2?.mail?.port, tdSaved2?.hasSecret], ['imap.163.com', 993, true])
const tdMailState = (await call(ctx, '/dsh-hud/todo/mail', { method: 'GET' })).json()
eq('a GET reports whether a secret exists, without returning it',
  [tdMailState?.hasSecret, JSON.stringify(tdMailState?.mail).includes('授权码')], [true, false])
eq('re-saving without a secret keeps the one that is stored',
  (await call(ctx, '/dsh-hud/todo/mail', { method: 'POST', body: { mailbox: 'INBOX' } })).json()?.hasSecret, true)
// HERMETIC: 127.0.0.1:1 has nothing listening, so the route fails fast and
// locally. An earlier version of this test left the preset at 163, i.e. it made
// the suite reach the real imap.163.com — which both broke hermeticity and
// turned a refused connection into an unhandled rejection that killed the run.
await call(ctx, '/dsh-hud/todo/mail', { method: 'POST', body: { preset: 'custom', host: '127.0.0.1', port: 1 } })
const tdList = (await call(ctx, '/dsh-hud/todo/mail/list', { method: 'POST', body: {} })).json()
eq('listing mail against an unreachable server reports the failure, not an empty list',
  [tdList?.ok, typeof tdList?.error === 'string'], [false, true])
ok('and the error says what actually happened',
  /ECONNREFUSED|连接|超时|socket/i.test(tdList?.error ?? ''), tdList?.error)
eq('and the mail routes are POST-only', (await call(ctx, '/dsh-hud/todo/mail/list', { method: 'GET' })).statusCode, 405)
const tdLoginSave = (await call(ctx, '/dsh-hud/todo/login', {
  method: 'POST',
  body: { provider: 'feishu', clientId: 'cli_abc', clientSecret: 'sec', redirectUri: 'http://127.0.0.1:19387/dsh-hud/todo/callback' },
})).json()
eq('saving a login fills the provider endpoints from the table',
  [tdLoginSave?.oauth?.provider, tdLoginSave?.hasSecret, /open\.feishu\.cn/.test(tdLoginSave?.authorizeUrl ?? '')],
  ['feishu', true, true])
eq('the client secret is never echoed back',
  JSON.stringify(tdLoginSave).includes('"sec"'), false)
eq('logging out clears the stored secret',
  (await call(ctx, '/dsh-hud/todo/login', { method: 'POST', body: { logout: true } })).json()?.hasSecret, false)
// Fetching tasks with no token has to say exactly that.
const tdTasks = (await call(ctx, '/dsh-hud/todo/tasks', { method: 'POST', body: {} })).json()
eq('asking for provider tasks without a token explains the state',
  [tdTasks?.ok, /登录|token/.test(tdTasks?.error ?? '')], [false, true])
imapServer.close()

// ── the removed panels ──────────────────────────────────────────────
// Services, git and machine were deleted at the source. The assertions below are what make
// each removal LOUD: a panel that quietly came back would otherwise just mount routes and
// serve empty lists that nothing reads.
// The route map is built by the mock context above, and it is what the route-table
// assertions later in this file count. A deleted panel must leave nothing behind in it.
eq('the services routes are gone',
  [...ctx.routes.keys()].filter((route) => route.startsWith('/dsh-hud/services/')), [])
eq('and so are the git routes — but not github\'s, which only start the same way',
  [...ctx.routes.keys()].filter((route) => route.startsWith('/dsh-hud/git/')), [])
eq('and the machine card left no routes behind',
  [...ctx.routes.keys()].filter((route) => route.startsWith('/dsh-hud/machine/')), [])
ok('while github still has its own', ctx.routes.has('/dsh-hud/github/state'))

// ── the config guard ───────────────────────────────────────────────────────
// A panel reads `host.config().timeoutMs` and expects a NUMBER. When a config
// tree arrives with schemastery NODES in it instead of values — which is what
// `new Config({…})` produces for anything the caller did not spell out — that
// read yields an object, and the string reached a user-facing error message as
// `请求超时（[object Object] ms）`. The kit now drops nodes and says so.
console.log('\nconfig guard — schema nodes never reach a panel')
const guardRoutes = new Map()
const guardSeen = []
const guardPlugin = await import('../index.js')
const guardConfig = {
  panels: {
    // A real value…
    probe: { timeoutMs: 1234, label: 'ok' },
    // …and what a schema node looks like once unwrapped: an object with `type`
    // and `meta`, which must NOT be handed to a panel as though it were data.
    probe2: { timeoutMs: { type: 'number', meta: { default: 5000 } }, keep: true },
  },
}
const guardCtx = mockContext()
const guardCtx2 = {
  ...guardCtx,
  webServer: {
    register({ path, handler }) {
      guardRoutes.set(path, handler)
      return () => guardRoutes.delete(path)
    },
  },
}
// `apply` mounts the real panels; the point here is only what `panelConfig`
// hands them, so a fake panel is registered through the same path.
const guardModule = { id: 'probe', order: 1, label: { zh: 'x' }, mount: (host) => { guardSeen.push(host.config()); return {} } }
const guardModule2 = { id: 'probe2', order: 2, label: { zh: 'y' }, mount: (host) => { guardSeen.push(host.config()); return {} } }
const guardPanels = guardPlugin.__test.PANELS
const guardCount = guardPanels.length
guardPanels.push(guardModule, guardModule2)
try {
  const disposer = guardPlugin.apply(guardCtx2, guardConfig)
  void disposer
  eq('a plain value reaches the panel unchanged', guardSeen.find((slice) => slice.label === 'ok')?.timeoutMs, 1234)
  const second = guardSeen.find((slice) => slice.keep === true)
  eq('a schema node is dropped, not passed through as data',
    [second?.timeoutMs, second?.keep], [undefined, true])
  ok('and the panel still gets everything that WAS plain data',
    guardSeen.some((slice) => slice.label === 'ok' && slice.timeoutMs === 1234))
} finally {
  guardPanels.length = guardCount
}

// ── the credential file fallback ───────────────────────────────────────────
// `writeCredential` and `removeCredential` patch `$DSH_HOME/.credentials.yaml`
// when the service has no writable method, so `resolveCredentialValue` has to be
// able to READ that file too — otherwise a token can be written and then be
// invisible to the panel that wrote it. The online check against a real profile
// home is what surfaced it: the token was in the file and every panel still said
// "not signed in".
console.log('\ncredentials — the service, and the file behind it')
const kit = await import('../lib/host-kit.js')
const credHome = mkdtempSync(join(tmpdir(), 'hud-cred-'))
process.env.DSH_HOME = credHome
writeFileSync(join(credHome, '.credentials.yaml'), [
  'version: 1',
  'records:',
  '  GITHUB_TOKEN: not-a-ref-value',
  'refs:',
  "  GITHUB_TOKEN: 'ghp_example'",
  "  OTHER_REF: 'a''b'",
  '  EMPTY_REF:',
  '',
].join('\n'))
eq('a quoted ref value is read and unquoted', kit.readCredentialFromFile('GITHUB_TOKEN'), 'ghp_example')
eq('an escaped quote is unescaped', kit.readCredentialFromFile('OTHER_REF'), "a'b")
eq('a ref with no value is undefined, not an empty string', kit.readCredentialFromFile('EMPTY_REF'), undefined)
eq('a ref that only exists under `records:` is NOT a credential',
  kit.readCredentialFromFile('NOT_IN_REFS'), undefined)
eq('an unknown ref is undefined', kit.readCredentialFromFile('NOPE'), undefined)
// The service wins when it answers; the file is the fallback.
const credCtx = { credentials: { async resolve(ref) { return ref === 'GITHUB_TOKEN' ? { value: 'from-service' } : undefined } } }
eq('the service is preferred when it has a value', await kit.resolveCredentialValue(credCtx, 'GITHUB_TOKEN'), 'from-service')
eq('and the file answers for a ref the service does not know',
  await kit.resolveCredentialValue({ credentials: { async resolve() { return undefined } } }, 'GITHUB_TOKEN'), 'ghp_example')
eq('a service that throws still falls back to the file',
  await kit.resolveCredentialValue({ credentials: { async resolve() { throw new Error('no service') } } }, 'GITHUB_TOKEN'), 'ghp_example')
eq('an absent service falls back to the file',
  await kit.resolveCredentialValue({}, 'GITHUB_TOKEN'), 'ghp_example')
process.env.DSH_HOME = suiteHome
// ── github panel: CI + review requests ─────────────────────────────────────
console.log('\ngithub panel — CI and review normalizers')
const ghTest = (await import('../panels/github/host.js')).__test
// The REAL shape, captured from api.github.com with a live token: a run that is
// still going has `conclusion: null`, which is the case a naive
// `conclusion !== 'success'` check calls a failure.
const RUNS_PAYLOAD = {
  total_count: 40000,
  workflow_runs: [
    {
      id: 1, name: 'CI', display_title: 'Addressing comment', status: 'in_progress', conclusion: null,
      head_branch: 'feature/x', head_sha: 'a'.repeat(40), event: 'pull_request',
      actor: { login: 'Dingji' }, run_started_at: '2026-10-01T09:02:23Z',
      html_url: 'https://github.com/o/r/actions/runs/1', run_attempt: 1,
    },
    {
      id: 2, name: 'CI', status: 'completed', conclusion: 'failure',
      head_branch: 'main', head_sha: 'b'.repeat(40), event: 'push',
      actor: { login: 'someone' }, run_started_at: '2026-09-30T09:00:00Z',
      html_url: 'https://github.com/o/r/actions/runs/2', run_attempt: 2,
    },
    {
      id: 3, name: 'CodeQL', status: 'completed', conclusion: 'success',
      head_branch: 'main', head_sha: 'c'.repeat(40), event: 'push',
      actor: { login: 'someone' }, run_started_at: '2026-09-29T09:00:00Z',
      html_url: 'https://github.com/o/r/actions/runs/3', run_attempt: 1,
    },
    { id: 4, name: 'Release', status: 'queued', conclusion: null, head_branch: 'main', run_started_at: '2026-09-29T08:00:00Z' },
    { id: 5, name: 'Docs', status: 'completed', conclusion: 'skipped', head_branch: 'main', run_started_at: '2026-09-28T08:00:00Z' },
  ],
}
const runs = ghTest.normalizeRuns(RUNS_PAYLOAD)
eq('a running workflow is NOT counted as failing — its conclusion is null',
  [runs.failing, runs.running], [1, 2])
eq('the latest run is the first one GitHub returned', [runs.latest?.id, runs.latest?.conclusion], [1, undefined])
eq('a skipped run is not a failure either', runs.failing, 1)
eq('the run carries what a card shows',
  (({ name, status, branch, sha, event, actor, attempt }) => ({ name, status, branch, sha, event, actor, attempt }))(runs.runs[0]),
  { name: 'CI', status: 'in_progress', branch: 'feature/x', sha: 'a'.repeat(7), event: 'pull_request', actor: 'Dingji', attempt: 1 })
eq('the start time is parsed to epoch ms', runs.runs[0].at, Date.parse('2026-10-01T09:02:23Z'))
// One workflow with five matrix jobs must not read as five pipelines.
eq('per-workflow rows are de-duplicated by name, newest first',
  runs.workflows.map((run) => run.name), ['CI', 'CodeQL', 'Release', 'Docs'])
eq('and the list is capped', runs.workflows.length <= 4, true)
eq('an empty payload is an empty answer, not a crash',
  (({ runs: list, failing, running, latest }) => [list.length, failing, running, latest])(ghTest.normalizeRuns({})),
  [0, 0, 0, undefined])
eq('a payload with a null workflow_runs is handled',
  ghTest.normalizeRuns({ workflow_runs: null }).runs.length, 0)

const REVIEW_PAYLOAD = {
  total_count: 2,
  items: [
    {
      id: 11, number: 42, title: 'feat: 加速面板', draft: false,
      html_url: 'https://github.com/o/r/pull/42',
      repository_url: 'https://api.github.com/repos/o/r',
      user: { login: 'someone' }, updated_at: '2026-10-01T08:00:00Z',
      labels: [{ name: 'review' }, { name: 'urgent' }, { name: 'x' }, { name: 'ignored' }],
    },
    { id: 12, number: 43, title: 'chore: 草稿', draft: true, html_url: 'https://github.com/o/r/pull/43', repository_url: 'https://api.github.com/repos/o/other', updated_at: '2026-09-20T08:00:00Z' },
  ],
}
const found = ghTest.normalizeReviewSearch(REVIEW_PAYLOAD)
eq('the search total is kept, not just the page length', found.total, 2)
eq('a result carries the repository, stripped of the API prefix',
  [found.items[0].repo, found.items[1].repo], ['o/r', 'o/other'])
eq('and the fields a row needs',
  (({ number, title, author, draft, url }) => ({ number, title, author, draft, url }))(found.items[0]),
  { number: 42, title: 'feat: 加速面板', author: 'someone', draft: false, url: 'https://github.com/o/r/pull/42' })
eq('labels are capped so a row cannot wrap', found.items[0].labels.length, 3)
eq('a draft is marked as one', found.items[1].draft, true)
eq('an empty search is an empty answer',
  (({ total, items }) => [total, items.length])(ghTest.normalizeReviewSearch({})), [0, 0])

// ── air quality (weather) and forex (market) ───────────────────────────────
console.log('\nair quality — the EPA bands')
// `wxTest` is already bound to the weather panel's __test above (line ~720);
// re-importing it here was a redeclaration.
eq('the bands break where the EPA says they do',
  [0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301].map((value) => wxTest.airLevel(value)?.zh),
  ['优', '优', '良', '良', '轻度污染', '轻度污染', '中度污染', '中度污染', '重度污染', '重度污染', '严重污染'])
eq('the English band travels with it', wxTest.airLevel(84)?.en, 'moderate')
eq('the band carries its own ceiling, so a card can show "84 / 100"', wxTest.airLevel(84)?.max, 100)
eq('the top band has no ceiling', wxTest.airLevel(400)?.max, undefined)
eq('a missing or nonsense AQI has no band, rather than a default one',
  [wxTest.airLevel(undefined), wxTest.airLevel('x'), wxTest.airLevel(null)], [undefined, undefined, undefined])
// The fields are the ones the API actually HAS: asking for a forecast-only
// variable is answered with a 400 and an empty body (learned by doing it).
ok('only fields that exist are requested',
  wxTest.AIR_FIELDS.includes('us_aqi') && wxTest.AIR_FIELDS.includes('pm2_5') && !wxTest.AIR_FIELDS.some((field) => /albedo|forecast/.test(field)),
  wxTest.AIR_FIELDS.join(','))

console.log('\nforex — the yuan against the majors')
// `mkTest` likewise already exists (line ~842).
// The scale comes from the row's own `f1`, not from a hardcoded 10000.
const fxRow = mkTest.parseForexRow({ f1: 4, f2: 67180, f3: 14, f12: 'USDCNH', f14: '美元兑离岸人民币' }, mkTest.FX_PAIRS[0])
eq('a rate is scaled by the decimals the row declares', [fxRow.code, fxRow.value, fxRow.decimals], ['USD', 6.718, 4])
eq('and the change is hundredths of a percent', fxRow.changePct, 0.14)
eq('a different precision would still parse correctly', mkTest.parseForexRow({ f1: 2, f2: 671, f3: 14 }, mkTest.FX_PAIRS[0]).value, 6.71)
eq('a row with no price yields nothing', mkTest.parseForexRow({ f1: 4, f2: 0 }, mkTest.FX_PAIRS[0]), undefined)
eq('a row with no decimals falls back to four', mkTest.parseForexRow({ f2: 67180 }, mkTest.FX_PAIRS[0]).value, 6.718)
// The pairs were FOUND, not guessed: `m:133` is the offshore-CNH board, and a
// wrong secid is answered with a one-row result rather than with an error.
eq('the pairs are the ones the m:133 board actually serves',
  mkTest.FX_PAIRS.map((pair) => pair.secid.split('.')[1]),
  ['USDCNH', 'EURCNH', 'GBPCNH', 'HKDCNH', 'AUDCNH', 'CADCNH', 'SGDCNH', 'CHFCNH', 'CNHJPY'])
ok('every pair is on the CNH board, not the international one',
  mkTest.FX_PAIRS.every((pair) => pair.secid.startsWith('133.')), mkTest.FX_PAIRS.map((pair) => pair.secid).join(','))
eq('the JPY pair is marked as inversely quoted, so the card can say so',
  mkTest.FX_PAIRS.filter((pair) => pair.inverse === true).map((pair) => pair.code), ['JPY'])
const fxParsed = mkTest.parseForex({ data: { diff: [{ f1: 4, f2: 67180, f3: 14, f12: 'USDCNH' }, { f1: 4, f2: 8561, f3: 13, f12: 'HKDCNH' }] } })
eq('only the rows that came back become rates', fxParsed.map((entry) => entry.code), ['USD', 'HKD'])
eq('an empty payload is an empty list, not a crash', mkTest.parseForex({}).length, 0)

console.log('\nair and forex — through the panels')
// Both additions ride inside payloads that already exist, so the shape of those
// payloads is what has to be asserted here.
const wxState = (await call(ctx, '/dsh-hud/weather/state')).json()
ok('the weather payload carries an air section, or a reason it has none',
  wxState?.air !== undefined && wxState?.air !== null ? typeof wxState.air === 'object' : typeof wxState?.airError === 'string',
  JSON.stringify({ air: wxState?.air ?? null, airError: wxState?.airError ?? null }).slice(0, 200))
if (wxState?.air !== null && wxState?.air !== undefined) {
  ok('the air reading has an AQI and a band',
    typeof wxState.air.usAqi === 'number' && typeof wxState.air.level?.zh === 'string',
    JSON.stringify(wxState.air).slice(0, 200))
  ok('and the pollutant values are numbers', typeof wxState.air.pm25 === 'number' && typeof wxState.air.pm10 === 'number')
}
const mkStateWithFx = (await call(ctx, '/dsh-hud/market/state')).json()
ok('the market payload carries a forex list, or a reason it has none',
  Array.isArray(mkStateWithFx?.forex) && mkStateWithFx.forex.length > 0 ? true : typeof mkStateWithFx?.forexError === 'string',
  JSON.stringify({ count: mkStateWithFx?.forex?.length ?? null, error: mkStateWithFx?.forexError ?? null }))
if (Array.isArray(mkStateWithFx?.forex) && mkStateWithFx.forex.length > 0) {
  ok('every rate has a code, a value and a change',
    mkStateWithFx.forex.every((rate) => typeof rate.code === 'string' && typeof rate.value === 'number' && typeof rate.changePct === 'number'),
    JSON.stringify(mkStateWithFx.forex[0]))
  ok('and the quotes are still there beside it', (mkStateWithFx.quotes ?? []).length > 0)
}

// ── the pomodoro ───────────────────────────────────────────────────────────
console.log('\n番茄钟 — the pure transition core')
const tdPomo = (await import('../panels/todo/host.js')).__test
const MIN = 60_000
const BASE = Date.UTC(2026, 9, 1, 12, 0, 0)
const freshState = (over = {}) => ({
  settings: { ...tdPomo.POMODORO_DEFAULTS },
  phase: 'work', running: false, endsAt: undefined, remainingMs: undefined,
  completedToday: 0, dayKey: tdPomo.pomodoroDayKey(BASE), cycleId: 0, label: '', lastEndedAt: undefined,
  ...over,
})

// ── how long each phase is ──
eq('a work phase is the configured length', tdPomo.phaseLength(freshState(), 'work'), 25 * MIN)
eq('a break is the short one', tdPomo.phaseLength(freshState(), 'break'), 5 * MIN)
// Every Nth break is the long one, and `completedToday` counts FINISHED sessions.
eq('the 4th break is the long one', tdPomo.phaseLength(freshState({ completedToday: 4 }), 'break'), 15 * MIN)
eq('and the 3rd is not', tdPomo.phaseLength(freshState({ completedToday: 3 }), 'break'), 5 * MIN)

// ── settling ──
eq('a timer that is not running settles to itself', tdPomo.settlePomodoro(freshState(), BASE)[1], undefined)
const midRun = freshState({ running: true, endsAt: BASE + 5 * MIN })
eq('a timer that is not due yet is left alone', tdPomo.settlePomodoro(midRun, BASE)[1], undefined)
const [settledWork, endedWork] = tdPomo.settlePomodoro(midRun, BASE + 5 * MIN)
eq('a finished FOCUS session becomes a break and earns a mark',
  [settledWork.phase, settledWork.completedToday, settledWork.cycleId], ['break', 1, 1])
eq('the break runs from NOW, not from the moment the session ended',
  settledWork.endsAt, BASE + 5 * MIN + 5 * MIN)
eq('and it keeps running: the point of a timer is that it keeps time',
  settledWork.running, true)
eq('the transition describes what just ended',
  (({ phase, completedToday, nextPhase, nextMs }) => ({ phase, completedToday, nextPhase, nextMs }))(endedWork),
  { phase: 'work', completedToday: 1, nextPhase: 'break', nextMs: 5 * MIN })
eq('and how late it was noticed', endedWork.lateByMs, 0)
// A break ending is not a completed session.
const [settledBreak, endedBreak] = tdPomo.settlePomodoro(freshState({ phase: 'break', running: true, endsAt: BASE, completedToday: 3 }), BASE + 1)
eq('a finished BREAK does not count as a session',
  [settledBreak.phase, settledBreak.completedToday, endedBreak.phase], ['work', 3, 'break'])
// The 4th break follows the 4th session, so it is the long one.
eq('the long break is scheduled after the 4th session',
  tdPomo.settlePomodoro(freshState({ running: true, endsAt: BASE, completedToday: 3 }), BASE)[0].endsAt,
  BASE + 15 * MIN)
// ── the honest part ──
// Nothing runs while nobody is looking, so a session that ended hours ago is ONE
// transition, not the eleven that would have happened.
const stale = freshState({ running: true, endsAt: BASE - 3 * 60 * MIN, cycleId: 7 })
const [settledStale, endedStale] = tdPomo.settlePomodoro(stale, BASE)
eq('an overnight session settles as ONE transition, not eleven',
  [settledStale.cycleId - stale.cycleId, settledStale.completedToday], [1, 1])
eq('and it says how late it was noticed', endedStale.lateByMs, 3 * 60 * MIN)
// Midnight resets the count, so "today" keeps meaning today.
const nextDay = freshState({ running: true, endsAt: BASE - 3 * 60 * MIN, completedToday: 6, dayKey: tdPomo.pomodoroDayKey(BASE) })
const [settledNextDay] = tdPomo.settlePomodoro(nextDay, BASE + 24 * 60 * MIN)
eq('the count resets when the local day changes',
  [settledNextDay.completedToday, settledNextDay.dayKey], [1, tdPomo.pomodoroDayKey(BASE + 24 * 60 * MIN)])

// ── actions ──
const started = tdPomo.applyPomodoroAction(freshState(), 'start', BASE)
eq('start always begins a WORK session, at its full length',
  [started.phase, started.running, started.endsAt - BASE], ['work', true, 25 * MIN])
const paused = tdPomo.applyPomodoroAction(started, 'pause', BASE + 10 * MIN)
eq('pause keeps the remaining time', [paused.running, paused.remainingMs, paused.endsAt], [false, 15 * MIN, undefined])
const resumed = tdPomo.applyPomodoroAction(paused, 'resume', BASE + 30 * MIN)
eq('resume continues from where it stopped, not from the full length',
  [resumed.running, resumed.endsAt - (BASE + 30 * MIN)], [true, 15 * MIN])
eq('pausing twice changes nothing', tdPomo.applyPomodoroAction(paused, 'pause', BASE + 31 * MIN), paused)
const skipped = tdPomo.applyPomodoroAction(started, 'skip', BASE + 2 * MIN)
eq('skip moves to the next phase WITHOUT credit',
  [skipped.phase, skipped.completedToday, skipped.cycleId, skipped.endsAt - (BASE + 2 * MIN)], ['break', 0, 1, 5 * MIN])
const reset = tdPomo.applyPomodoroAction({ ...started, completedToday: 5 }, 'reset', BASE)
eq('reset goes back to a full work session waiting to start',
  [reset.phase, reset.running, reset.endsAt, reset.remainingMs], ['work', false, undefined, undefined])
eq('and does NOT wipe the day\'s count — it is a record, not a timer',
  reset.completedToday, 5)
eq('an unknown action is a no-op', tdPomo.applyPomodoroAction(started, 'nonsense', BASE), started)

// ── the view ──
eq('a fresh timer shows a full phase, not started',
  (({ remainingMs, started: isStarted, running }) => ({ remainingMs, isStarted, running }))(tdPomo.pomodoroView(freshState(), BASE)),
  { remainingMs: 25 * MIN, isStarted: false, running: false })
eq('a running timer counts down from its end time',
  tdPomo.pomodoroView(freshState({ running: true, endsAt: BASE + 3 * MIN }), BASE).remainingMs, 3 * MIN)
eq('a running timer never shows a negative time',
  tdPomo.pomodoroView(freshState({ running: true, endsAt: BASE - MIN }), BASE).remainingMs, 0)
eq('a paused timer shows what is left of it',
  tdPomo.pomodoroView(freshState({ running: false, remainingMs: 4 * MIN }), BASE).remainingMs, 4 * MIN)

console.log('\n番茄钟 — through the routes')
const pomoOf = async (action, extra) => (await call(ctx, '/dsh-hud/todo/pomodoro', { method: 'POST', body: { action, ...(extra ?? {}) } })).json()
// The state payload always carries the timer, so the widget never has to guess.
const todoStateWithPomo = (await call(ctx, '/dsh-hud/todo/state')).json()
ok('the todo payload carries the timer',
  todoStateWithPomo?.pomodoro !== undefined && typeof todoStateWithPomo.pomodoro.remainingMs === 'number',
  JSON.stringify(todoStateWithPomo?.pomodoro ?? null))
ok('and the settings the card needs to describe it',
  typeof todoStateWithPomo?.pomodoro?.settings?.workMinutes === 'number')
const pomoStarted = await pomoOf('start')
eq('start answers with the running timer', [pomoStarted.pomodoro.phase, pomoStarted.pomodoro.running], ['work', true])
eq('and a full-length session', Math.round(pomoStarted.pomodoro.remainingMs / MIN), 25)
const pomoPaused = await pomoOf('pause')
eq('pause answers with a stopped timer that keeps its remainder',
  [pomoPaused.pomodoro.running, Math.round(pomoPaused.pomodoro.remainingMs / MIN)], [false, 25])
eq('resume starts it again', (await pomoOf('resume')).pomodoro.running, true)
eq('skip flips the phase without credit',
  (({ phase, completedToday }) => ({ phase, completedToday }))((await pomoOf('skip')).pomodoro),
  { phase: 'break', completedToday: 0 })
eq('reset returns to a stopped work session', (({ phase, running, started: isStarted }) => ({ phase, running, started: isStarted }))((await pomoOf('reset')).pomodoro),
  { phase: 'work', running: false, started: false })
const pomoTuned = await pomoOf('settle', { settings: { workMinutes: 45, breakMinutes: 8, longBreakEvery: 3, longBreakMinutes: 20 } })
eq('settings can be changed with any action',
  pomoTuned.pomodoro.settings, { workMinutes: 45, breakMinutes: 8, longBreakEvery: 3, longBreakMinutes: 20 })
eq('an out-of-range setting is CLAMPED rather than stored',
  (await pomoOf('settle', { settings: { workMinutes: 9999 } })).pomodoro.settings.workMinutes,
  tdPomo.POMODORO_LIMITS.workMinutes[1])
eq('and a zero break is raised to the floor rather than accepted',
  (await pomoOf('settle', { settings: { breakMinutes: 0 } })).pomodoro.settings.breakMinutes,
  tdPomo.POMODORO_LIMITS.breakMinutes[0])
const pomoBad = await call(ctx, '/dsh-hud/todo/pomodoro', { method: 'POST', body: { action: 'levitate' } })
eq('an unknown action is refused, with the list of real ones', pomoBad.statusCode, 400)
ok('and the error names the actions', /start/.test(pomoBad.json().error ?? ''), pomoBad.json().error)
// The path that matters most: a session that finished while the page was CLOSED.
// The host settles it on the next read, so the count is real rather than assumed.
{
  const storeFile = join(process.env.DSH_HOME, 'storages', 'dsh-hud/todo', 'state.json')
  const stored = JSON.parse(readFileSync(storeFile, 'utf8'))
  writeFileSync(storeFile, JSON.stringify({
    ...stored,
    pomodoro: {
      settings: { ...tdPomo.POMODORO_DEFAULTS },
      phase: 'work', running: true, endsAt: Date.now() - 4 * MIN, completedToday: 2,
      dayKey: tdPomo.pomodoroDayKey(Date.now()), cycleId: 11, label: '',
    },
  }))
  // A FORCED read: the state is cached for up to ten seconds, and a test that read
  // the cache would be asserting on the state from BEFORE the seed.
  const settledRead = (await call(ctx, '/dsh-hud/todo/refresh', { method: 'POST' })).json()
  eq('a session that ended while the page was closed is settled on the next read',
    [settledRead.pomodoro.phase, settledRead.pomodoro.completedToday, settledRead.pomodoro.cycleId],
    ['break', 3, 12])
  ok('and the read reports the transition, so the card can announce it',
    settledRead.pomodoro.justEnded !== null && settledRead.pomodoro.justEnded.phase === 'work',
    JSON.stringify(settledRead.pomodoro.justEnded))
  const secondRead = (await call(ctx, '/dsh-hud/todo/refresh', { method: 'POST' })).json()
  eq('a second read does NOT report it again',
    secondRead.pomodoro.justEnded, null)
  eq('and the timer is still running, now on the break',
    [secondRead.pomodoro.phase, secondRead.pomodoro.running], ['break', true])
}


// ── SQL Server: TDS, against a server that speaks it back ──────────────────
//
// There is no SQL Server on this machine and there is not going to be one, so the driver
// is exercised against tools/fake-tds.mjs — which reads PRELOGIN and LOGIN7 the way the
// real server does and DE-OBFUSCATES the password with its own implementation of the
// specified transform. That is what makes these assertions statements about the driver
// rather than about my own idea of the protocol.
console.log('\nSQL — the credential ref alphabet (a wrong one stops DSH from starting)')
{
  const sqlLib = await import('../lib/sql/index.js')
  // The store's rule, quoted from the error it throws:
  //   credential ref "dsh-hud-sql-db" must match /^[A-Za-z_][A-Za-z0-9_]*$/
  // No hyphens. A ref outside that set makes the credentials plugin fail to LOAD, ten other
  // plugins wait for it for ever, and the app refuses to start until the line is deleted by
  // hand — so the name this plugin generates has to be legal by construction.
  eq("the rule is the store's own", sqlLib.CREDENTIAL_REF_PATTERN.source, String.raw`^[A-Za-z_][A-Za-z0-9_]*$`)
  eq('the name that broke a real startup is refused', sqlLib.isCredentialRef('dsh-hud-sql-db'), false)
  eq('and sanitising it produces a legal one', sqlLib.toCredentialRef('dsh-hud-sql-db'), 'dsh_hud_sql_db')
  eq('a connection id with a hyphen is fixed, not passed through',
    sqlLib.toCredentialRef('db-2'), 'db_2')
  eq('a leading digit is prefixed, because the pattern forbids one',
    sqlLib.toCredentialRef('2fast'), '_2fast')
  eq('an empty request still yields something writable',
    sqlLib.toCredentialRef(''), 'credential')
  eq('and every result passes the check',
    ['dsh-hud-sql-db', 'db-2', '2fast', '', 'a b/c']
      .map((one) => sqlLib.isCredentialRef(sqlLib.toCredentialRef(one))),
    [true, true, true, true, true])

  // A connection stored BEFORE the rule was known keeps the illegal name, so the heal has to
  // happen on READ as well — otherwise the card goes on asking the store for `dsh-hud-sql-db`
  // and reports that the credential is missing, which is true and completely unactionable.
  eq('a stored connection heals its own ref on the way in',
    sqlLib.cleanProfile({ driver: 'postgres', host: 'db', passwordRef: 'dsh-hud-sql-db' }, 0).passwordRef,
    'dsh_hud_sql_db')
  eq('an absent ref stays absent rather than becoming a name',
    sqlLib.cleanProfile({ driver: 'postgres', host: 'db' }, 0).passwordRef, undefined)
  eq('and a legal one is left exactly as it was',
    sqlLib.cleanProfile({ driver: 'postgres', host: 'db', passwordRef: 'pg_main' }, 0).passwordRef, 'pg_main')

  // The route SANITISES rather than writing something that cannot be read back: writing first
  // and failing at the next startup is the worst possible order for a failure this fatal.
  // (`call` directly, because the suite's `post` helper is declared further down.)
  const asked = (await call(ctx, '/dsh-hud/sql/credential', {
    method: 'POST', body: { ref: 'has-a-hyphen', value: 'x' },
  })).json()
  eq('the credential route stores the legal form of a name it was given',
    [asked.ok, asked.ref], [true, 'has_a_hyphen'])
}

console.log('\nPostgreSQL — a STATEMENT, which is what the card actually does')
{
  // ── the bug this exists for ──
  //
  // The Query message was built into a buffer four bytes too small. `Buffer.copy` does not
  // complain when the destination runs out — it copies what fits and drops the rest — so every
  // statement went out with its last four bytes missing while the length field still claimed
  // them. The server waited for the remainder, the client waited for an answer, and fifteen
  // seconds later the socket gave up: "等待服务器超过 15 秒".
  //
  // Nothing caught it because the PostgreSQL tests only ever CONNECTED — they never ran a
  // statement. The fake server was faithful the whole time; it was simply never asked. So this
  // block runs real queries, including the read-only transaction the card wraps them in.
  //
  // EVERY AWAIT HERE IS BOUNDED. A framing bug makes both ends wait, and an unbounded test
  // would hang the suite instead of failing it — which is the failure mode that let this ship.
  const { startFakePostgres } = await import('./fake-postgres.mjs')
  const sqlLib = await import('../lib/sql/index.js')

  /** Resolve or throw after `ms`, so a deadlock is a FAILED CHECK and not a hung run. */
  const withDeadline = (promise, ms, what) => Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])

  const fake = await startFakePostgres()
  try {
    const profile = sqlLib.cleanProfile(
      { driver: 'postgres', host: '127.0.0.1', port: fake.port, database: 'app', user: 'app' }, 0,
    )
    const secrets = { secrets: { password: 'sup3r-s3cret' } }

    const read = await withDeadline(
      sqlLib.runStatement(profile, { sql: 'select name, n from notes', ...secrets }), 4_000, 'a SELECT',
    )
    // `runStatement` returns the result DIRECTLY (the panel's route is what wraps it in
    // `{ result }`), so reading `.result.rows` here found nothing.
    eq('a SELECT comes back with its rows', read.rows, [['甲', '1'], ['乙', '2']])
    // The message the server received must be the whole statement: the fake reads the length
    // field the client wrote, so a truncated payload shows up here as a missing word.
    eq('and the server received the statement the user typed',
      fake.state.queries.includes('select name, n from notes'), true)
    // The read-only transaction is sent as its own statement first — that guard is worth
    // proving, because it is what makes a write fail with the SERVER's words.
    eq('inside a read-only transaction, so the server refuses writes',
      fake.state.queries[0], 'BEGIN TRANSACTION READ ONLY')
    eq('and the statement arrived whole, not truncated',
      fake.state.queries[1], 'select name, n from notes')

    // An unbounded number of statements in one call must each arrive whole.
    const multi = await withDeadline(
      sqlLib.runStatement(profile, { sql: 'select * from notes where n > 1', ...secrets }), 4_000, 'a second SELECT',
    )
    eq('a second statement on a fresh connection also arrives whole',
      multi.columns, ['name', 'n'])
  } finally {
    await fake.close()
  }
}

console.log('\nPostgreSQL — SCRAM against a server that sends the REAL message order')
{
  // ── the bug this exists for ──
  //
  // The auth loop `continue`d on AuthenticationOk instead of leaving it. A real server sends
  // ParameterStatus ('S') messages BEFORE that point — for server_version, client_encoding and
  // every other setting it volunteers — so the first 'S' looked like a protocol violation and
  // a perfectly good SCRAM login was thrown away:
  //
  //     认证阶段收到了意料之外的消息（S）
  //
  // The fake below sends those messages in the real order, which is the only way a test can
  // catch this: a fake that sends AuthenticationOk alone would pass either way.
  const { startFakePostgres } = await import('./fake-postgres.mjs')
  const sqlLib = await import('../lib/sql/index.js')

  const fake = await startFakePostgres()
  try {
    const profile = sqlLib.cleanProfile(
      { driver: 'postgres', host: '127.0.0.1', port: fake.port, database: 'app', user: 'app' }, 0,
    )
    const info = await sqlLib.testProfile(profile, { secrets: { password: 'sup3r-s3cret' } })
    eq('SCRAM completes even though ParameterStatus arrives first', info.ok, true)
    ok('and the messages really were sent before the login finished',
      fake.state.parameterStatusSent >= 2, String(fake.state.parameterStatusSent))
    // server_version is one of those ParameterStatus messages, so reading it proves the loop
    // not only survived the 'S' but parsed it.
    eq('and the version was read out of the ParameterStatus it once choked on',
      info.info?.serverVersion, '16.4')
  } finally {
    await fake.close()
  }

  // A wrong password is refused by the SERVER, with the server's own words.
  const wrong = await startFakePostgres()
  try {
    const profile = sqlLib.cleanProfile(
      { driver: 'postgres', host: '127.0.0.1', port: wrong.port, database: 'app', user: 'app' }, 0,
    )
    let message = ''
    try {
      await sqlLib.testProfile(profile, { secrets: { password: 'not-the-password' } })
    } catch (error) {
      message = error.message
    }
    ok('a wrong password is refused rather than accepted',
      message.includes('password authentication failed'), message)
  } finally {
    await wrong.close()
  }

  // The SSL path: the driver offers SSLRequest, the server answers 'N', and the session
  // continues in the clear — which is what every client does with sslmode=prefer.
  const sslFake = await startFakePostgres()
  try {
    const profile = sqlLib.cleanProfile(
      { driver: 'postgres', host: '127.0.0.1', port: sslFake.port, database: 'app', user: 'app', ssl: true }, 0,
    )
    const info = await sqlLib.testProfile(profile, { secrets: { password: 'sup3r-s3cret' } })
    eq('an SSL profile still connects when the server refuses TLS',
      [info.ok, sslFake.state.sslRequests >= 1], [true, true])
  } finally {
    await sslFake.close()
  }
}

console.log('\nSQL Server — the default port, and the TDS driver')
{
  const sqlLib = await import('../lib/sql/index.js')
  // The shortcut `driver === 'postgres' ? 5432 : 3306` gave SQL Server MySQL's port, so a
  // connection to a real server on 1433 was refused before a packet was sent.
  eq('every driver has its own default port, not "postgres or everything else"',
    ['sqlite', 'postgres', 'mysql', 'sqlserver', 'oracle', 'db2']
      .map((id) => sqlLib.DRIVER_SPECS.find((spec) => spec.id === id)?.defaultPort),
    [0, 5432, 3306, 1433, 1521, 50_000])
  eq('and a SQL Server profile with no port given lands on 1433',
    sqlLib.cleanProfile({ driver: 'sqlserver', host: 'db.example' }, 0).port, 1433)
  eq('while MySQL still lands on 3306',
    sqlLib.cleanProfile({ driver: 'mysql', host: 'db.example' }, 0).port, 3306)
}

console.log('\nSQL Server — the TDS driver, against a fake that reads the bytes')
{
  const { startFakeSqlServer } = await import('./fake-tds.mjs')
  const tdsDriver = await import('../lib/sql/tds.js')
  const { obfuscatePassword, looksLikeWrite } = tdsDriver

  // The obfuscation is specified, so it is checked against the specification's own
  // arithmetic rather than against itself: 'a' is 0x61 0x00 in UTF-16LE, and each byte is
  // nibble-swapped then XORed with 0xA5 — 0x61 → 0xB3, 0x00 → 0xA5.
  eq('the password transform matches the spec (utf-16le, nibble swap, xor 0xa5)',
    obfuscatePassword('a').toString('hex'), 'b3a5')
  eq('and it round-trips through the fake server\'s independent implementation',
    (await import('./fake-tds.mjs')).deobfuscatePassword(obfuscatePassword('a')), 'a')

  const server = await startFakeSqlServer()
  try {
    const session = await tdsDriver.open(
      { host: '127.0.0.1', port: server.port, user: 'sa', database: 'app', limit: 200 },
      { secrets: { password: 'Str0ng!Pass' } },
    )
    ok('the driver logs in', server.state.authenticated === true)
    eq('the password arrived de-obfuscated, character for character',
      server.state.scrambles[0]?.passwordLength, 'Str0ng!Pass'.length)
    eq('the prelogin negotiated an encryption verdict', server.state.sawEncryption, 0)
    // ENCRYPT_OFF does not mean "no encryption": the login packet must arrive INSIDE a
    // TLS handshake carried in TDS packets. A plaintext login is what a real server
    // ignores, and this pair of assertions is what keeps that from coming back.
    eq('the login packet went in encrypted, not in the clear', server.state.loginTransport, 'tls')
    // The offsets in LOGIN7 are measured from the start of the STRUCTURE. Writing them
    // header-relative (94 + 8) is invisible to a lenient reading and fatal to a real
    // server, which answers with silence — so the fake checks the spec's own rule.
    eq('and its offsets are structure-relative, as the spec requires', server.state.hostNameOffset, 94)
    // The version comes from the PRELOGIN option table, whose offsets are BIG-endian
    // while LOGIN7's are little-endian. Reading it with the wrong byte order produced
    // "undefined.undefined.undefined" and an encryption byte that was silently empty.
    eq('and the version parses out of that table', session.info.serverVersion, '16.0.4')
    eq('and the database came from the ENVCHANGE token', session.info.database, 'app')
    eq('login-packet encryption is reported as such', session.info.encrypt, 'login')

    const result = await session.run('select nick from users')
    eq('the batch reached the server verbatim', server.state.batches.at(-1), 'select nick from users')
    eq('the column name came from COLMETADATA', result.columns, ['nick'])
    eq('the rows decoded, NULL included', result.rows, [['甲'], ['乙'], [null]])
    eq('and nothing was truncated', result.truncated, false)
    session.close()

    // The row cap applies while READING, and says so.
    const capped = await tdsDriver.open(
      { host: '127.0.0.1', port: server.port, user: 'sa', database: 'app', limit: 1 },
      { secrets: { password: 'Str0ng!Pass' } },
    )
    const limited = await capped.run('select nick from users')
    eq('the row cap truncates while reading', limited.rows, [['甲']])
    eq('and the truncation is REPORTED, not inferred', limited.truncated, true)
    capped.close()
  } finally {
    await server.close()
  }

  // ── two things only a LIVE server caught ──────────────────────────────────
  //
  // Both of these decoded fine against a fake that was less faithful than the real thing,
  // and both returned garbage or an error against a real SQL Server 2008 R2:
  //
  //   • an INT column — INTN carries a ONE-byte length, and reading two turned
  //     `select count(*)` into 54324743469268992 instead of 18;
  //   • an ordered result — a real server sends an ORDER token (0xa9) for `order by`,
  //     and an unknown token failed the whole query.
  //
  // The nvarchar half of this reply also covers the third: a real COLMETADATA carries a
  // 5-byte collation after a character column's length, and a parser that forgets it
  // reads every later byte five early.
  //
  // The last column is `nvarchar(max)`, which a real server frames as PLP — and a driver
  // that reads it as an ordinary NVARCHAR asks for 65535 bytes and throws, which is what
  // `select *` on any table with one did.
  const mixedTypes = await startFakeSqlServer({
    reply: () => ({
      columns: [
        { name: 'n', type: 'int' },
        { name: 'tag', type: 'nvarchar' },
        { name: 'amount', type: 'decimal', scale: 2 },
        { name: 'blob', type: 'nvarchar', maxlen: 0xffff },
      ],
      rows: [[18, '甲', 12.34, 'hi'], [0, '乙', -0.5, null]],
    }),
  })
  try {
    const session = await tdsDriver.open(
      { host: '127.0.0.1', port: mixedTypes.port, user: 'sa', database: 'app' },
      { secrets: { password: 'Str0ng!Pass' } },
    )
    const mixed = await session.run('select n, tag, amount, blob from t')
    eq('an INT column decodes as a number, not as 5.4e16',
      mixed.rows, [[18, '甲', '12.34', 'hi'], [0, '乙', '-0.50', null]])
    eq('and the column names survive the collation in COLMETADATA',
      mixed.columns, ['n', 'tag', 'amount', 'blob'])
    const ordered = await session.run('select n from t order by n')
    // The fake answers every batch with the same four columns, so what this asserts is
    // that the ORDER token a server sends for an ordered result does not FAIL the query —
    // which is exactly what a live 2008 R2 did ("不认识的 token 0xa9").
    eq('an ordered result is not failed by the ORDER token', ordered.rows.length, 2)
    session.close()
  } finally {
    await mixedTypes.close()
  }

  /**
   * ── a reply that arrives in SEVERAL packets ────────────────────────────────
   *
   * This is the shape that broke the schema listing on a real server: 22852 bytes, six
   * packets, and the packets collected in one `data` event were thrown away when the next
   * one arrived — so the message lost its beginning and the parse started in the middle of
   * a row ("不认识的 token 0x0（第 0 字节）"). Every small statement worked, which is why
   * nothing else caught it.
   *
   * The fake now chunks its replies like a real server, and `trickle` spaces the packets so
   * each one arrives on its own — the exact shape that failed.
   */
  const big = await startFakeSqlServer({
    trickle: true,
    reply: () => ({
      columns: [{ name: 'id', type: 'int' }, { name: 'label', type: 'nvarchar' }],
      rows: Array.from({ length: 400 }, (_, index) => [index, `第${index}行·abcdefghijklmnop`]),
    }),
  })
  try {
    const session = await tdsDriver.open(
      { host: '127.0.0.1', port: big.port, user: 'sa', database: 'app', limit: 500 },
      { secrets: { password: 'Str0ng!Pass' } },
    )
    const result = await session.run('select id, label from big')
    eq('a reply split across several packets keeps its beginning',
      [result.rows.length, result.rows[0], result.rows[399]],
      [400, [0, '第0行·abcdefghijklmnop'], [399, '第399行·abcdefghijklmnop']])
    eq('and the column names survive too', result.columns, ['id', 'label'])
    session.close()
  } finally {
    await big.close()
  }

  /**
   * ── a dependency that never answers must not take the panel with it ────────
   *
   * The credentials service serialises its work behind one queue and takes a file lock
   * when it writes, so ONE operation that never settles wedges every later resolve for the
   * life of the process. From the card's side that looked like this: every route touching a
   * credential stopped answering, the browser's 20s abort fired, and the card was left with
   * no state at all — which reads as "my connections are gone" while the settings file sits
   * there untouched.
   */
  {
    const hostKit = await import('../lib/host-kit.js')
    // A ref that exists in the FILE (this suite runs against a temp DSH_HOME), written
    // through the plugin's own writer, so the fallback has something real to find.
    await hostKit.writeCredential({}, 'dsh_hud_sql_wedged', 'from-the-file')
    const wedged = { credentials: { resolve: () => new Promise(() => {}) } }
    const startedAt = Date.now()
    const fromFile = await hostKit.resolveCredentialValue(wedged, 'dsh_hud_sql_wedged', { deadlineMs: 120 })
    ok('a credential service that never answers falls back to the FILE, instead of hanging',
      fromFile === 'from-the-file', JSON.stringify(fromFile))
    ok('and it gives up on the service quickly rather than waiting for ever',
      Date.now() - startedAt < 2_000, `${Date.now() - startedAt}ms`)

    // …and in a home that does not exist yet. A fresh `$DSH_HOME` is what the suite uses and
    // what a first run looks like, and the write failed with ENOENT on the temp file — which
    // the card can only report as "could not store the password". Found by driving the
    // panel's own route against a temporary home.
    {
      const fresh = mkdtempSync(join(tmpdir(), 'dsh-hud-fresh-'))
      const previous = process.env.DSH_HOME
      process.env.DSH_HOME = join(fresh, 'nested', 'deeper')
      try {
        const where = await hostKit.writeCredential({}, 'dsh_hud_fresh_ref', 'a-secret')
        eq('the credential file is created, with its parent directories, in a home that has none',
          [where, hostKit.readCredentialFromFile('dsh_hud_fresh_ref')], ['credentials.yaml', 'a-secret'])
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
        rmSync(fresh, { recursive: true, force: true })
      }
    }

    // The WRITE side of the same wedge: saving a connection stores its password, and that
    // write must not be the thing that hangs. On timeout the file is patched directly.
    const wedgedWrite = { credentials: { resolve: () => new Promise(() => {}), write: () => new Promise(() => {}) } }
    const startedWrite = Date.now()
    const where = await hostKit.writeCredential(wedgedWrite, 'dsh_hud_sql_written', 'a-secret')
    eq('a credential written through a wedged service lands in the FILE instead',
      [where, hostKit.readCredentialFromFile('dsh_hud_sql_written')], ['credentials.yaml', 'a-secret'])
    ok('and the write does not wait for ever',
      Date.now() - startedWrite < 7_000, `${Date.now() - startedWrite}ms`)

    // A statement that is never answered gets a sentence, not an open route.
    const mute = await startFakeSqlServer({ ignoreBatches: true })
    try {
      const session = await tdsDriver.open(
        { host: '127.0.0.1', port: mute.port, user: 'sa', database: 'app', timeoutMs: 600 },
        { secrets: { password: 'Str0ng!Pass' } },
      )
      const at = Date.now()
      let message = ''
      try {
        await session.run('select 1 as one')
      } catch (error) {
        message = error.message
      }
      ok('a statement the server never answers times out with a sentence about the statement',
        /没有回应/.test(message) && /select 1/.test(message), message)
      ok('and it takes the connection\'s own timeout, not the browser\'s 20s',
        Date.now() - at < 3_000, `${Date.now() - at}ms`)
      session.close()
    } finally {
      await mute.close()
    }
  }

  // A wrong password is refused BY THE SERVER's ERROR token, not by a timeout.
  const wrong = await startFakeSqlServer()
  try {
    let message = ''
    try {
      await tdsDriver.open({ host: '127.0.0.1', port: wrong.port, user: 'sa', database: 'app' },
        { secrets: { password: 'not-the-password' } })
    } catch (error) {
      message = error.message
    }
    ok('a wrong password is refused with the server\'s own words',
      message.includes('Login failed') && message.includes("'sa'"), message)
    eq('and the server agrees it was the password', wrong.state.wrongPassword, true)
  } finally {
    await wrong.close()
  }

  // A server that cannot encrypt at all: the driver must NOT insist on TLS.
  const plain = await startFakeSqlServer({ encryption: 0x02 })
  try {
    const session = await tdsDriver.open(
      { host: '127.0.0.1', port: plain.port, user: 'sa', database: 'app' },
      { secrets: { password: 'Str0ng!Pass' } },
    )
    eq('ENCRYPT_NOT_SUP gets a plaintext login and still works',
      [plain.state.loginTransport, plain.state.authenticated], ['plaintext', true])
    ok('and the card is told the server cannot encrypt',
      /^off（服务器不支持加密）$/.test(session.info.encrypt), session.info.encrypt)
    session.close()
  } finally {
    await plain.close()
  }

  // ── a typed password must REACH the driver ──
  //
  // The connect form tests with the password the user just typed, before any credential
  // exists. That only works if the literal is forwarded all the way down; it used to be
  // dropped by `withSession`, which knew only about a resolver — and the driver then
  // reported a missing CREDENTIAL, sending the user to the wrong form entirely.
  const typed = await startFakeSqlServer()
  try {
    const profile = (await import('../lib/sql/index.js')).cleanProfile(
      { driver: 'sqlserver', host: '127.0.0.1', port: typed.port, user: 'sa', database: 'app' }, 0,
    )
    const sqlLib2 = await import('../lib/sql/index.js')
    // NOT named `ok`: that is the assertion helper, and shadowing it turns every later
    // `ok(...)` in this block into "ok is not a function".
    const typedResult = await sqlLib2.testProfile(profile, { secrets: { password: 'Str0ng!Pass' } })
    eq('a password typed into the form reaches the driver', [typedResult.ok, typed.state.authenticated], [true, true])
    eq('and the version still comes back', typedResult.info?.serverVersion, '16.0.4')

    // The resolver path must keep working for a SAVED connection — which means the
    // profile has to NAME the credential, because that is the only thing a resolver has to
    // go on. (Without the name, secretsFor returns {} and an empty password reaches the
    // server as a WRONG password rather than a missing one.)
    const saved = { ...profile, passwordRef: 'mssql-sa' }
    const byName = await sqlLib2.testProfile(saved, { resolve: async () => 'Str0ng!Pass' })
    eq('a credential resolved by name works too', byName.ok, true)
    let refused = ''
    try {
      await sqlLib2.testProfile(saved, { resolve: async () => 'not-it' })
    } catch (error) {
      refused = error.message
    }
    ok('and a wrong secret is still refused', refused.includes('Login failed'), refused)
  } finally {
    await typed.close()
  }

  // ── the honest difference ──
  //
  // The other three drivers have the SERVER refuse a write. SQL Server has no read-only
  // transaction, so this one refuses in the plugin and says which it is. The capability
  // list must not blur the two.
  const sqlModule = await import('../lib/sql/index.js')
  const caps = await sqlModule.capabilities()
  const entry = caps.find((cap) => cap.id === 'sqlserver')
  eq('SQL Server is offered by the panel', entry !== undefined, true)
  eq('and it is offered as available — it needs nothing but a socket', entry.available, true)
  eq('but its read-only guarantee is marked as OURS, not the engine\'s',
    entry.readonly, 'client')
  eq('while the three that the server enforces keep saying so',
    caps.filter((cap) => cap.readonly !== 'client').map((cap) => cap.id).sort(),
    ['mysql', 'postgres', 'sqlite'])
  ok('and a write is refused client-side when read-only is on',
    looksLikeWrite('INSERT INTO t VALUES (1)') && looksLikeWrite('exec sp_who')
      && !looksLikeWrite('select * from t') && !looksLikeWrite("select 'insert' as word"))
}

// ── the SQL library: four drivers, four kinds of evidence ─────────────────
//
// The differences between these three sections are the point:
//   • SQLite runs against a REAL database file this test creates — schema, view,
//     columns, rows, the cap, and a write refused by the ENGINE.
//   • MySQL runs against a protocol-faithful fake that verifies the scramble this
//     client computes against an INDEPENDENT derivation, so a wrong implementation
//     cannot pass by agreeing with itself. (No MySQL server is installed on this
//     machine; saying that is better than pretending the fake is one.)
//   • PostgreSQL talks to the REAL server on 127.0.0.1:5432 — handshake, SCRAM
//     exchange, and the server's own verdict on a wrong password. That is what found
//     the framing bug below; pure parsers alone could not.
console.log('\nSQL — the panel routes, against a real database')
{
  // The library is tested below; this is about the PANEL: the connection list, what a
  // failure looks like, and the two switches. It runs against a real SQLite file, so
  // "it listed the table" is a fact about a database rather than about a stub.
  const dir = mkdtempSync(join(tmpdir(), 'hud-sqlpanel-'))
  const file = join(dir, 'app.db')
  const seed = await import('../lib/sql/index.js')
  const writable = seed.cleanProfile({ driver: 'sqlite', file, readOnly: false }, 0)
  await seed.runStatement(writable, { sql: 'create table notes (id integer primary key, body text not null)', allowWrite: true })
  await seed.runStatement(writable, { sql: "insert into notes (body) values ('第一条')", allowWrite: true })
  await seed.runStatement(writable, { sql: 'create view recent as select body from notes', allowWrite: true })

  const sqlCall = (path, options) => call(ctx, path, options)
  const post = (path, body) => sqlCall(path, { method: 'POST', body })

  // Nothing configured yet: an empty list that says so, and NOT an error.
  const empty = (await sqlCall('/dsh-hud/sql/state')).json()
  eq('with no connections the panel says it is empty, not broken',
    [empty.ok, empty.empty, empty.error], [true, true, undefined])
  eq('and it reports which drivers this process can use',
    (empty.drivers ?? []).map((driver) => driver.id),
    ['sqlite', 'postgres', 'mysql', 'sqlserver', 'oracle', 'db2'])

  // Add one through the settings route, exactly as the card does.
  const saved = (await post('/dsh-hud/sql/settings', {
    settings: { connections: [{ id: 'local', driver: 'sqlite', file, name: '本地库', readOnly: true }], active: 'local' },
  })).json()
  eq('a connection added from the card is stored',
    [saved.ok, saved.settings.connections.length, saved.settings.active], [true, 1, 'local'])

  const state = (await sqlCall('/dsh-hud/sql/state')).json()
  eq('the state lists the connection and marks it active',
    [state.empty, state.active, state.target], [false, 'local', file])
  const main = state.schema?.schemas?.find((one) => one.name === 'main')
  eq('and the schema of a REAL database comes through the route',
    main?.objects?.map((object) => `${object.kind}:${object.name}`).sort(), ['table:notes', 'view:recent'])
  eq('with the columns',
    main?.objects?.find((object) => object.name === 'notes')?.columns?.map((column) => column.name),
    ['id', 'body'])
  eq('a read-only connection is reported as read-only', state.readOnly, true)

  const read = (await post('/dsh-hud/sql/query', { id: 'local', sql: 'select * from notes' })).json()
  eq('a SELECT runs and returns rows', [read.ok, read.result.rows], [true, [[1, '第一条']]])
  eq('with the column names and the read-only flag',
    [read.result.columns, read.result.readOnly], [['id', 'body'], true])

  // A write, refused, with the reason naming the switch that is off.
  const refused = (await post('/dsh-hud/sql/query', { id: 'local', sql: "insert into notes (body) values ('x')" })).json()
  eq('a write on a read-only connection is refused with a reason',
    [refused.ok, typeof refused.error], [false, 'string'])
  ok('and the sentence names the switch that would allow it',
    /关掉「只读」/.test(refused.error ?? ''), String(refused.error))

  // Open the connection, tick nothing: still refused, for the OTHER reason.
  await post('/dsh-hud/sql/settings', {
    settings: { connections: [{ id: 'local', driver: 'sqlite', file, name: '本地库', readOnly: false }], active: 'local' },
  })
  const needsTick = (await post('/dsh-hud/sql/query', { id: 'local', sql: "insert into notes (body) values ('x')" })).json()
  ok('a writable connection still needs the per-run tick, and says so',
    needsTick.ok === false && /勾选「允许写」/.test(needsTick.error ?? ''), String(needsTick.error))
  const wrote = (await post('/dsh-hud/sql/query', {
    id: 'local', sql: "insert into notes (body) values ('第二条')", allowWrite: true,
  })).json()
  eq('with both switches it runs, and reports what it changed',
    [wrote.ok, wrote.result.wrote, /影响 1 行/.test(wrote.result.notice ?? '')], [true, true, true])
  eq('and the row is really there',
    (await post('/dsh-hud/sql/query', { id: 'local', sql: 'select count(*) as n from notes' })).json()?.result?.rows,
    [[2]])

  const bad = (await post('/dsh-hud/sql/query', { id: 'local', sql: 'select * from nope' })).json()
  ok('a missing table comes back as ok:false with the database own words',
    bad.ok === false && /no such table/.test(bad.error ?? ''), String(bad.error))

  // A connection that cannot be reached must NOT look like an empty database. This is
  // the single most misleading thing the panel could do.
  await post('/dsh-hud/sql/settings', {
    settings: { connections: [{ id: 'broken', driver: 'sqlite', file: join(dir, 'gone.db'), name: '不存在' }], active: 'broken' },
  })
  const broken = (await sqlCall('/dsh-hud/sql/state')).json()
  ok('an unreachable database is an ERROR, never an empty schema',
    broken.schema === undefined && typeof broken.error === 'string' && broken.error.includes('文件不存在'),
    JSON.stringify({ hasSchema: broken.schema !== undefined, error: broken.error }))

  const tested = (await post('/dsh-hud/sql/test', { connection: { driver: 'sqlite', file } })).json()
  eq('the test route connects without saving anything', [tested.ok, tested.driver], [true, 'sqlite'])
  const failedTest = (await post('/dsh-hud/sql/test', { connection: { driver: 'sqlite', file: join(dir, 'gone.db') } })).json()
  eq('and reports the reason when it cannot', [failedTest.ok, typeof failedTest.error], [false, 'string'])
  const noCredential = (await post('/dsh-hud/sql/test', {
    connection: { driver: 'postgres', host: '127.0.0.1', port: 5432, user: 'postgres', passwordRef: 'definitely-not-stored' },
  })).json()
  ok('a credential name that resolves to nothing is named as such',
    noCredential.ok === false && /凭据/.test(noCredential.error ?? ''), String(noCredential.error))

  const reset = (await post('/dsh-hud/sql/settings', { reset: true })).json()
  eq('a reset drops the card connections', [reset.reset, reset.settings.connections.length], [true, 0])
  eq('and the state is empty again', (await sqlCall('/dsh-hud/sql/state')).json()?.empty, true)

  // ── several connections: which one would actually open, and deleting one ────
  //
  // A connection whose credential was removed fails at connect time with a sentence about
  // a credential — and with a list of connections, "which one is broken?" is exactly what
  // the list has to answer. The state payload says so per connection, and the delete route
  // refuses to take a credential that another connection still names.
  const stored = (await post('/dsh-hud/sql/credential', { ref: 'dsh_hud_sql_hosted', value: 'pw-for-the-test' })).json()
  eq('a credential can be stored under a name that is legal for the store', stored.ok, true)
  await post('/dsh-hud/sql/settings', {
    settings: {
      connections: [
        { id: 'a', driver: 'sqlite', file, name: '本地库', readOnly: true },
        { id: 'b', driver: 'postgres', host: '127.0.0.1', user: 'postgres', name: '有凭据', passwordRef: 'dsh_hud_sql_hosted' },
        { id: 'c', driver: 'postgres', host: '127.0.0.1', user: 'postgres', name: '没凭据', passwordRef: 'dsh_hud_sql_absent' },
      ],
      active: 'a',
    },
  })
  const many = (await sqlCall('/dsh-hud/sql/state')).json()
  eq('the state carries every connection, in order, with how to reach it',
    many.connections.map((entry) => entry.id), ['a', 'b', 'c'])
  eq('and says per connection whether its credential is there',
    many.connections.map((entry) => entry.credential), ['none', 'present', 'missing'])
  ok('a connection with no credential at all is not called missing',
    many.connections[0].credential === 'none', JSON.stringify(many.connections[0]))

  const held = (await post('/dsh-hud/sql/credential/remove', { ref: 'dsh_hud_sql_hosted' })).json()
  ok('deleting a credential a connection still names is REFUSED, and says which',
    held.ok === false && /有凭据/.test(held.error ?? ''), String(held.error))
  const stillNamed = (await post('/dsh-hud/sql/credential/remove', { ref: 'dsh_hud_sql_absent' })).json()
  ok('and the refusal is about the REFERENCE, not about whether it resolves',
    stillNamed.ok === false && /没凭据/.test(stillNamed.error ?? ''), String(stillNamed.error))
  const nameless = (await post('/dsh-hud/sql/credential/remove', { ref: 'dsh_hud_sql_unused' })).json()
  eq('while one no connection names is removed', [nameless.ok, nameless.ref], [true, 'dsh_hud_sql_unused'])
  const illegal = (await post('/dsh-hud/sql/credential/remove', { ref: 'not/legal' })).json()
  eq('and a name that is not a legal ref is refused before anything is touched', illegal.ok, false)

  const resetAgain = (await post('/dsh-hud/sql/settings', { reset: true })).json()
  eq('the reset still works with several connections stored', resetAgain.reset, true)
  await post('/dsh-hud/sql/credential/remove', { ref: 'dsh_hud_sql_hosted' })

  eq('POST is the only write verb on query', (await sqlCall('/dsh-hud/sql/query')).statusCode, 405)
  eq('cross-origin state is refused',
    (await sqlCall('/dsh-hud/sql/state', { origin: 'https://evil.example' })).statusCode, 403)
  rmSync(dir, { recursive: true, force: true })
}

/**
 * ── the SSH half ────────────────────────────────────────────────────────────
 *
 * The card can be an SSH client instead of a database, and the transport is the SYSTEM's
 * ssh rather than a hand-written protocol (a usable SSH client needs a key exchange, a
 * host-key signature, an AEAD packet layer, userauth and channels, and every wrong detail
 * ends in a connection that simply never authenticates). What that buys is the user's own
 * ssh — agent, config, known_hosts — and what it costs is a dependency on the machine, so
 * the panel ASKS whether it is there, the way it asks about node:sqlite.
 */
{
  const ssh = await import('../lib/ssh/client.js')

  eq('a host defaults to port 22 and a strict host-key policy',
    (({ port, auth, acceptNewHostKey }) => ({ port, auth, acceptNewHostKey }))(ssh.cleanHost({ host: 'example.com' }, 0)),
    { port: 22, auth: 'agent', acceptNewHostKey: false })
  eq('a blank port box means 22, not port 1',
    ssh.cleanHost({ host: 'example.com', port: '' }, 0).port, 22)
  eq('and a port somebody typed is kept', ssh.cleanHost({ host: 'x', port: '2222' }, 0).port, 2222)
  eq('a user with shell metacharacters is stripped rather than passed to ssh',
    ssh.cleanHost({ host: 'x', user: 'root; rm -rf /' }, 0).user, 'rootrm-rf')
  eq('the target is what a card shows', ssh.targetOf(ssh.cleanHost({ host: '10.0.0.9', user: 'root', port: 2222 }, 0)), 'root@10.0.0.9:2222')

  // Every flag is the contract with ssh, so the flags are pinned here rather than described.
  const agent = ssh.sshArgs(ssh.cleanHost({ host: 'h', user: 'u' }, 0), 'uptime')
  ok('an agent host runs non-interactively, with no PTY and no stdin',
    agent.includes('-T') && agent.includes('-n') && agent.includes('BatchMode=yes'), JSON.stringify(agent))
  ok('and the destination comes last, after --, so it cannot be read as an option',
    agent[agent.length - 2] === 'u@h' && agent[agent.length - 1] === 'uptime' && agent.includes('--'), JSON.stringify(agent))
  ok('the host key policy is strict unless the host says otherwise',
    agent.includes('StrictHostKeyChecking=yes'), JSON.stringify(agent))
  ok('unless the host opts in, and then it is accept-new',
    ssh.sshArgs(ssh.cleanHost({ host: 'h', user: 'u', acceptNewHostKey: true }, 0), 'x').includes('StrictHostKeyChecking=accept-new'))
  const keyed = ssh.sshArgs(ssh.cleanHost({ host: 'h', user: 'u', auth: 'key', keyPath: 'C:/k/id_ed25519' }, 0), 'x')
  ok('a key host passes -i and refuses to fall back to a password',
    keyed.includes('-i') && keyed.includes('C:/k/id_ed25519') && keyed.includes('PreferredAuthentications=publickey'), JSON.stringify(keyed))
  const pw = ssh.sshArgs(ssh.cleanHost({ host: 'h', user: 'u', auth: 'password' }, 0), 'x')
  ok('a password host asks for exactly one prompt and no key',
    pw.includes('NumberOfPasswordPrompts=1') && pw.includes('PubkeyAuthentication=no'), JSON.stringify(pw))
  ok('and the password is NOWHERE in the argv',
    !pw.some((arg) => String(arg).includes('secret')), JSON.stringify(pw))

  // The askpass wiring: the mechanism that makes password auth possible without a TTY.
  const env = ssh.sshEnv(ssh.cleanHost({ host: 'h', user: 'u', auth: 'password' }, 0), 'sekret')
  eq('the password travels in the environment, and ssh is told to use askpass',
    [env.DSH_SSH_PASSWORD, env.SSH_ASKPASS_REQUIRE, typeof env.SSH_ASKPASS], ['sekret', 'force', 'string'])
  ok('the askpass program is a node, preloaded with the script that prints it',
    String(env.SSH_ASKPASS).toLowerCase().includes('node') && String(env.NODE_OPTIONS).includes('askpass.cjs'),
    JSON.stringify({ askpass: env.SSH_ASKPASS, nodeOptions: env.NODE_OPTIONS }))
  ok('and a host with no password puts nothing in the environment',
    ssh.sshEnv(ssh.cleanHost({ host: 'h', user: 'u', auth: 'agent' }, 0), undefined).DSH_SSH_PASSWORD === undefined)

  /**
   * Windows ssh prints its own localized messages as OCTAL ESCAPES — a failed DNS lookup
   * arrives as the ASCII text "\262\273\326\252…" rather than as bytes in any encoding.
   * Measured on this machine, and the reason decodeOutput exists.
   */
  eq('ssh\'s octal-escaped, GBK-encoded message is decoded into text',
    ssh.decodeOutput(Buffer.from('ssh: \\262\\273\\326\\252', 'utf8')),
    'ssh: 不知')
  eq('while ordinary output is left alone', ssh.decodeOutput(Buffer.from('uptime: 3 days', 'utf8')), 'uptime: 3 days')

  /**
   * The explanations, with the strings a REAL ssh printed.
   *
   * Every one of these came out of a live run against 172.21.0.138 (Windows OpenSSH 9.5p2 →
   * Ubuntu): the first is the error everyone meets first, and it is the reason this mapping
   * exists — "No ED25519 host key is known for … and you have requested strict checking"
   * is correct, secure, and says nothing about the checkbox that fixes it.
   */
  const explained = [
    ['No ED25519 host key is known for 172.21.0.138 and you have requested strict checking.\r\nHost key verification failed.\r\n', '接受新主机密钥'],
    ['dingji@172.21.0.138: Permission denied (publickey,password).\r\n', '不允许密码登录'],
    ['banner exchange: Connection to UNKNOWN port -1: Connection refused\r\n', '没有 ssh 服务在听'],
    ['ssh: connect to host 10.0.0.1 port 22: Connection timed out\r\n', '网络不通'],
    ['ssh: Could not resolve hostname nope.invalid: 不知道这样的主机。\r\n', '解析不了'],
    ['Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures\r\n', '尝试次数太多'],
  ]
  for (const [stderr, expected] of explained) {
    const hint = ssh.explainSshFailure(stderr, 255)
    ok(`ssh's own words are answered with an action: ${JSON.stringify(stderr.slice(0, 34))}…`,
      typeof hint === 'string' && hint.includes(expected), JSON.stringify(hint))
  }
  eq('and an unexplained failure is left to speak for itself',
    ssh.explainSshFailure('something nobody has seen before', 255), undefined)

  // ── the real ssh, against endpoints that exist ──
  const capability = await ssh.available()
  ok('the machine has an ssh client, and the panel can find it',
    capability.ok === true && typeof capability.version === 'string', JSON.stringify(capability))

  const refused = await ssh.runCommand(
    ssh.cleanHost({ host: '127.0.0.1', port: 1, user: 'nobody', auth: 'agent', timeoutMs: 8_000 }, 0),
    { command: 'echo hi', timeoutMs: 8_000 },
  )
  ok('a closed port fails quickly, with what ssh actually said',
    refused.ok === false && refused.ms < 8_000 && /refused|refus/i.test(refused.stderr),
    JSON.stringify({ ms: refused.ms, stderr: refused.stderr.slice(0, 120) }))

  /**
   * …and a server that ACCEPTS the connection and then says nothing at all. That is the
   * shape the deadline exists for: ssh waits for a banner for ever, and without the
   * deadline the card's request would wait with it.
   */
  const mute = createTcpServer((socket) => { socket.on('error', () => {}); socket.on('data', () => {}) })
  await new Promise((resolve) => mute.listen(0, '127.0.0.1', resolve))
  const at = Date.now()
  const stalled = await ssh.runCommand(
    ssh.cleanHost({ host: '127.0.0.1', port: mute.address().port, user: 'nobody', auth: 'agent', timeoutMs: 3_000 }, 0),
    { command: 'echo hi', timeoutMs: 3_000 },
  )
  await new Promise((resolve) => mute.close(resolve))
  ok('a host that accepts the connection and never answers is abandoned on time',
    stalled.ok === false && Date.now() - at < 8_000 && /没有结束/.test(stalled.error ?? ''),
    JSON.stringify({ ms: Date.now() - at, error: stalled.error }))
}


/**
 * ── the interactive session ─────────────────────────────────────────────────
 *
 * The command runner answers "run this"; a session answers "let me use it". The difference
 * is a process that stays alive: keystrokes go in, a terminal's own output comes back, and
 * shell state persists from one line to the next.
 *
 * Driven here by a real child process through the session's spawn seam — the same buffering,
 * polling, writing and closing the panel uses, without needing a network host in the suite.
 * The PTY half was verified against a real Ubuntu box using the card's own routes: `cd /tmp`
 * then `pwd` answered `/tmp`, an exported variable survived to the next line, `read -p` asked
 * a question that was answered by typing into the session, and `stty size` answered `30 100`
 * because the session TELLS the far side its size — without that it answered `0 0`, since a
 * web page has no local terminal to measure.
 */
{
  const session = await import('../lib/ssh/session.js')

  const host0 = { id: 'h', host: '192.0.2.10', port: 2222, user: 'dingji', auth: 'password', timeoutMs: 20_000, acceptNewHostKey: false, keyPath: '' }
  const args = session.sessionArgs(host0, { cols: 120, rows: 40 })
  ok('a session asks for a PTY on both sides and runs no command',
    args.includes('-tt') && !args.includes('-T') && !args.includes('-n') && args[args.length - 1] === 'dingji@192.0.2.10',
    JSON.stringify(args))
  ok('and it drops BatchMode, which would stop a prompt from ever being shown',
    !args.includes('BatchMode=yes'), JSON.stringify(args))
  ok('keepalives are on, so a connection that died is noticed',
    args.includes('ServerAliveInterval=30') && args.includes('ServerAliveCountMax=3'), JSON.stringify(args))
  const sizing = args.find((arg) => String(arg).startsWith('RemoteCommand='))
  ok('and the remote PTY is TOLD its size, because there is no local terminal to measure',
    typeof sizing === 'string' && sizing.includes('stty cols 120 rows 40') && sizing.includes('exec'),
    JSON.stringify(sizing))

  /**
   * A real interactive child process: echoes what is typed, counts lines, answers a question,
   * and honours Ctrl-C. Written out as a file rather than a string of escapes, because the
   * first version of this was unreadable enough to hide a bug in itself.
   */
  const fakeShell = join(suiteHome, 'fake-shell.mjs')
  writeFileSync(fakeShell, [
    "process.stdout.write('ready> ')",
    "let buffer = ''",
    'let n = 0',
    "process.stdin.on('data', (chunk) => {",
    '  for (const ch of String(chunk)) {',
    "    if (ch === '\\r' || ch === '\\n') {",
    '      n += 1',
    "      process.stdout.write('\\r\\nline ' + n + ': ' + buffer + '\\n')",
    "      if (buffer === 'where') process.stdout.write('/tmp\\r\\n')",
    "      if (buffer === 'quit') { process.stdout.write('bye\\r\\n'); process.exit(0) }",
    "      buffer = ''",
    "      process.stdout.write('ready> ')",
    "    } else if (ch === '\\u0003') {",
    "      process.stdout.write('^C\\r\\nready> ')",
    "      buffer = ''",
    "    } else if (ch === '\\b' || ch === '\\u007f') {",
    '      buffer = buffer.slice(0, -1)',
    '    } else {',
    '      buffer += ch',
    '      process.stdout.write(ch)',
    '    }',
    '  }',
    '})',
    '',
  ].join('\n'), 'utf8')

  const live = await session.openSession(
    { ...host0, id: 'sess' },
    { spawnTarget: { file: process.execPath, args: [fakeShell] }, idleMs: 60_000, secrets: { password: 'test-only' } },
  )
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let cursor = 0
  const drain = async (ms) => {
    const until = Date.now() + ms
    let text = ''
    while (Date.now() < until) {
      const read = live.read(cursor)
      cursor = read.cursor
      text += read.data
      await sleep(40)
    }
    return text
  }

  const first = await drain(400)
  ok('a session prints what the far side printed', first.includes('ready>'), JSON.stringify(first))

  // Nothing new means nothing new: the cursor is what stops the card re-rendering the world.
  eq('and a poll with nothing new returns nothing', live.read(cursor).data, '')

  live.write('echo hi\r')
  const answer = await drain(400)
  ok('keystrokes go in and their echo comes back', /line 1: echo hi/.test(answer), JSON.stringify(answer))

  // THE point of a session: state that survives from one line to the next.
  live.write('cd /tmp\r')
  live.write('where\r')
  const second = await drain(500)
  ok('and the session is still the same shell two lines later',
    /line 2: cd \/tmp/.test(second) && /\/tmp/.test(second), JSON.stringify(second))

  // A control character has to reach the process, not be swallowed as text.
  live.write('\u0003')
  const interrupted = await drain(300)
  ok('a control character reaches the far side intact', interrupted.includes('^C'), JSON.stringify(interrupted))

  const before = live.read(cursor)
  eq('the cursor only moves forward, so nothing is delivered twice',
    [before.cursor >= cursor, before.lost], [true, false])
  cursor = before.cursor

  live.close('test')
  await sleep(250)
  eq('closing ends the session', live.read(cursor).status, 'closed')

  rmSync(fakeShell, { force: true })
}

console.log('\nSQL — the shared contract')/**
 * The shared contract every driver implements: statements, values, limits, and what a
 * refusal looks like. Each driver's own block lives with its own code.
 */
{
  const sql = await import('../lib/sql/index.js')
  eq('one statement passes through', sql.splitStatements('select 1').statements.length, 1)
  eq('a semicolon inside a literal is not a separator',
    sql.splitStatements("select ';' as a").statements.length, 1)
  eq('two statements are refused WITH a reason',
    [sql.splitStatements('select 1; select 2').statements.length, typeof sql.splitStatements('select 1; select 2').reason],
    [2, 'string'])
  eq('a SELECT is a read', sql.classify('select * from t'), 'read')
  eq('an INSERT is a write', sql.classify('insert into t values (1)'), 'write')
  // The classifier must not be fooled by text inside a literal or a comment. The
  // comment in the source says what it is NOT: a security boundary.
  eq('a keyword inside a string literal is not a statement',
    sql.classify("select 'drop table x'"), 'read')
  eq('nor is a keyword inside a line comment', sql.classify('-- delete from t\nselect 1'), 'read')
  eq('nor inside a block comment', sql.classify('/* update t set a=1 */ select 1'), 'read')
  // A common table expression is the honest "cannot tell": it is a read about half
  // the time, and guessing permissively is the one direction that can hurt.
  eq('a CTE is reported as unknown, not as a read',
    sql.classify('with x as (delete from t returning *) select * from x'), 'unknown')
  // AN EMPTY FIELD IS "NOT SUPPLIED", and this is a real bug that reached a real server:
  // `Number('')` is 0, which is finite, so the clamp turned a blank port box into the
  // MINIMUM — port 1 — and the driver's own default never applied. Measured end to end:
  // port '' → "连不上 122.112.251.34:1 —— 10 秒内没有回应" while port 1433 connected in 60ms.
  eq('a blank port falls back to the driver\'s default, not to port 1',
    ['sqlserver', 'postgres', 'mysql', 'oracle', 'db2'].map((driver) => sql.cleanProfile({ driver, port: '' }, 0).port),
    [1433, 5432, 3306, 1521, 50000])
  eq('and so does one that is only whitespace',
    sql.cleanProfile({ driver: 'sqlserver', port: '   ' }, 0).port, 1433)
  eq('while a port somebody typed is kept',
    sql.cleanProfile({ driver: 'sqlserver', port: '1444' }, 0).port, 1444)
  eq('and a port that is not a number at all still falls back',
    sql.cleanProfile({ driver: 'sqlserver', port: 'the usual one' }, 0).port, 1433)
  // The same trap one level up: a blank poll box became 5 seconds instead of 60.
  const sqlHost = await import('../panels/sql/host.js')
  eq('a blank poll interval falls back to the default, not to the minimum',
    sqlHost.cleanSettings({ pollMs: '' }).pollMs, 60_000)
  eq('while a poll interval somebody typed is kept',
    sqlHost.cleanSettings({ pollMs: '30000' }).pollMs, 30_000)
  eq('a profile defaults to READ ONLY', sql.cleanProfile({ driver: 'postgres' }).readOnly, true)
  eq('and a port out of range is clamped, not stored',
    sql.cleanProfile({ driver: 'mysql', port: 99999 }).port, 65535)
  eq('a typo in the driver falls back to sqlite rather than crashing',
    sql.cleanProfile({ driver: 'orcale' }).driver, 'sqlite')
  const caps = await sql.capabilities()
  // The third column is the point: three of these have the SERVER refuse a write, and
  // SQL Server has no read-only transaction at all, so its refusal happens in the plugin.
  // The list is allowed to say which is which, and must not blur the two.
  eq('every driver reports availability AND how read-only is enforced',
    caps.map((entry) => [entry.id, typeof entry.available, entry.readonly]),
    [
      ['sqlite', 'boolean', 'engine'],
      ['postgres', 'boolean', 'transaction'],
      ['mysql', 'boolean', 'transaction'],
      // The three whose server either has no read-only transaction (SQL Server) or whose
      // read-only mode belongs to a transaction or a cursor that this driver does not keep
      // open across calls (Oracle, DB2). All three say 'client' — which is the point of
      // having the column at all.
      ['sqlserver', 'boolean', 'client'],
      ['oracle', 'boolean', 'client'],
      ['db2', 'boolean', 'client'],
    ])
}

console.log('\nSQL — SQLite, against a real database file')
{
  const sql = await import('../lib/sql/index.js')
  const sqlite = await import('../lib/sql/sqlite.js')
  const availability = await sqlite.available()
  ok('node:sqlite is available here, or the reason is stated',
    availability.ok === true || typeof availability.reason === 'string', JSON.stringify(availability))
  if (availability.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'hud-sql-'))
    const file = join(dir, 'app.db')
    const writable = sql.cleanProfile({ driver: 'sqlite', file, readOnly: false }, 0)
    // The fixture is written through the SAME registry the panel uses, with both
    // switches on — which is itself a check that a write needs both.
    await sql.runStatement(writable, { sql: 'create table users (id integer primary key, name text not null, score real)', allowWrite: true })
    await sql.runStatement(writable, { sql: "insert into users (name, score) values ('甲', 1.5)", allowWrite: true })
    await sql.runStatement(writable, { sql: "insert into users (name, score) values ('乙', 2.5)", allowWrite: true })
    await sql.runStatement(writable, { sql: 'create view top as select name, score from users where score > 2', allowWrite: true })

    const described = await sql.describeProfile(writable)
    const main = described.schemas.find((schema) => schema.name === 'main')
    eq('the schema lists the table AND the view',
      main?.objects?.map((object) => `${object.kind}:${object.name}`).sort(), ['table:users', 'view:top'])
    const users = main.objects.find((object) => object.name === 'users')
    eq('a table reports its real columns, with types and the primary key',
      users.columns.map((column) => [column.name, column.type, column.primaryKey]),
      [['id', 'INTEGER', true], ['name', 'TEXT', false], ['score', 'REAL', false]])
    eq('and a view reports its columns too',
      main.objects.find((object) => object.name === 'top').columns.length, 2)

    const readOnlyProfile = sql.cleanProfile({ driver: 'sqlite', file }, 1)
    const read = await sql.runStatement(readOnlyProfile, { sql: 'select name, score from users order by id' })
    eq('a SELECT returns rows, in column order', read.rows, [['甲', 1.5], ['乙', 2.5]])
    eq('with the column names the statement declared', read.columns, ['name', 'score'])
    eq('and it is marked as having run read-only', read.readOnly, true)
    const capped = await sql.runStatement(readOnlyProfile, { sql: 'select * from users', limit: 1 })
    eq('the row cap truncates rather than rewriting the query',
      [capped.rows.length, capped.truncated], [1, true])

    // Both switches, and each refusal names the one that is off.
    const attempts = []
    for (const [label, profile, allowWrite] of [
      ['read-only connection, not ticked', readOnlyProfile, false],
      ['read-only connection, ticked', readOnlyProfile, true],
      ['writable connection, not ticked', writable, false],
    ]) {
      try {
        await sql.runStatement(profile, { sql: "insert into users (name) values ('丙')", allowWrite })
        attempts.push(`${label}: RAN`)
      } catch (error) {
        attempts.push(error.message)
      }
    }
    ok('a write needs BOTH switches, and each refusal names the one that is off',
      attempts[0].includes('关掉「只读」') && attempts[1].includes('关掉「只读」') && attempts[2].includes('勾选「允许写」'),
      attempts.join(' | '))
    // The engine is the last line of defence: with the classifier out of the way, the
    // FILE HANDLE still refuses. That is the difference between a filter and a
    // guarantee, so it is asserted through the driver directly.
    const session = await sqlite.open({ file, readOnly: true }, {})
    let engineRefused = false
    try {
      await session.query("insert into users (name) values ('丁')")
    } catch (error) {
      engineRefused = /readonly database/i.test(error.message)
    }
    session.close()
    ok('the read-only FILE HANDLE refuses the write even with every filter bypassed', engineRefused)
    const wrote = await sql.runStatement(writable, { sql: "insert into users (name, score) values ('丙', 9)", allowWrite: true })
    ok('an allowed write reports the rows it changed', /影响 1 行/.test(wrote.notice ?? ''), String(wrote.notice))
    eq('and is flagged as a write', wrote.wrote, true)
    let sqlError
    try {
      await sql.runStatement(readOnlyProfile, { sql: 'select * from nope' })
    } catch (error) {
      sqlError = error.message
    }
    ok('a missing table is reported in the database own words',
      typeof sqlError === 'string' && /no such table/i.test(sqlError), String(sqlError))
    let missingFile
    try {
      await sql.runStatement(sql.cleanProfile({ driver: 'sqlite', file: join(dir, 'gone.db') }), { sql: 'select 1' })
    } catch (error) {
      missingFile = error.message
    }
    // Opening read-write would CREATE the file and then cheerfully report "0 tables"
    // about a database the user never had, so the mistake is named instead.
    ok('a read-only profile against a missing file is named as such',
      typeof missingFile === 'string' && missingFile.includes('文件不存在'), String(missingFile))
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\nSQL — MySQL against a protocol-faithful server')
{
  const sql = await import('../lib/sql/index.js')
  const mysql = await import('../lib/sql/mysql.js')
  const { startFakeMysql, PASSWORD, scrambleFromScratch } = await import('./fake-mysql.mjs')
  const nonce = Buffer.from('12345678abcdefghijkl', 'utf8')
  ok('mysql_native_password matches an independent derivation',
    mysql.nativePassword('hunter2', nonce).equals(scrambleFromScratch('hunter2', nonce)))
  eq('a MySQL field type code gets a name', mysql.mysqlTypeName(3), 'int')
  eq('and an unknown one says so instead of guessing', mysql.mysqlTypeName(999), 'type:999')

  const fake = await startFakeMysql()
  try {
    const profile = sql.cleanProfile({
      driver: 'mysql', host: '127.0.0.1', port: fake.port, user: 'root', database: 'app', passwordRef: 'mysql_app',
    })
    // An UNDERSCORE, not a hyphen: `cleanProfile` normalises refs into the store's alphabet, so
    // a fixture written with a hyphen would be sanitised out from under the resolver below and
    // the test would fail on a missing credential rather than on what it is testing.
    const resolve = async (ref) => (ref === 'mysql_app' ? PASSWORD : undefined)
    let wrong
    try {
      await sql.testProfile({ ...profile, passwordRef: 'other' }, { resolve: async () => 'wrong-password' })
    } catch (error) {
      wrong = error.message
    }
    ok('a wrong password gets the server own refusal, with its SQLSTATE',
      typeof wrong === 'string' && /Access denied/.test(wrong) && /28000/.test(wrong), String(wrong))
    eq('and the server really did compute a mismatch', fake.state.wrongScramble, true)

    const info = await sql.testProfile(profile, { resolve })
    eq('a correct password completes the handshake',
      [info.ok, info.info.serverVersion], [true, '8.0.36-fake'])
    const described = await sql.describeProfile(profile, { resolve })
    eq('the schema lists a table and a view, with their columns',
      described.schemas[0].objects.map((object) => `${object.kind}:${object.name}:${object.columns.length}`),
      ['table:users:2', 'view:top_users:1'])
    eq('and a primary key is flagged, with its unsigned type',
      [described.schemas[0].objects[0].columns[0].primaryKey, described.schemas[0].objects[0].columns[0].type],
      [true, 'int unsigned'])
    const read = await sql.runStatement(profile, { sql: 'select * from users', resolve })
    eq('rows come back with NULLs preserved and numbers as the server sent them',
      read.rows, [['1', '甲'], ['2', '乙'], ['3', null]])
    const capped = await sql.runStatement(profile, { sql: 'select * from users', limit: 2, resolve })
    eq('the cap truncates', [capped.rows.length, capped.truncated], [2, true])
    // Read-only is the SERVER rule here: the driver opens START TRANSACTION READ ONLY
    // and the fake enforces exactly that, so the sequencing is real.
    const wrote = await sql.runStatement({ ...profile, readOnly: false },
      { sql: "insert into users (name) values ('x')", allowWrite: true, resolve })
    ok('a write with both switches on runs, and the server said so',
      /影响 1 行/.test(wrote.notice ?? ''), String(wrote.notice))
    let tableMissing
    try {
      await sql.runStatement(profile, { sql: 'select * from missing', resolve })
    } catch (error) {
      tableMissing = error.message
    }
    ok('a missing table keeps the server SQLSTATE',
      typeof tableMissing === 'string' && /42S02/.test(tableMissing), String(tableMissing))
  } finally {
    await fake.close()
  }
}

console.log('\nSQL — PostgreSQL against a real server, if one is listening')
{
  const pg = await import('../lib/sql/pg.js')
  eq('a type OID gets a name', [pg.typeName(23), pg.typeName(3802)], ['int4', 'jsonb'])
  eq('an unknown OID says so', pg.typeName(99999), 'oid:99999')
  eq('a CommandComplete tag is parsed per command shape',
    [pg.parseCommandComplete('SELECT 5').rows, pg.parseCommandComplete('INSERT 0 1').rows, pg.parseCommandComplete('UPDATE 3').rows],
    [5, 1, 3])
  const errorPayload = Buffer.from('SERROR\0C28P01\0Mbad password\0Ddetail\0Hhint\0\0', 'utf8')
  eq('an ErrorResponse keeps its code, message, detail and hint',
    (() => {
      const parsed = pg.parseErrorFields(errorPayload)
      return [parsed.severity, parsed.code, parsed.message, parsed.detail, parsed.hint]
    })(),
    ['ERROR', '28P01', 'bad password', 'detail', 'hint'])
  // A DataRow with a NULL: length -1 is how the protocol says NULL, and reading it as
  // an empty string would turn every NULL into ''.
  eq('a DataRow decodes NULL as null, not as an empty string',
    (() => {
      const count = Buffer.from([0x00, 0x02])
      const minusOne = Buffer.alloc(4); minusOne.writeInt32BE(-1, 0)
      const two = Buffer.alloc(4); two.writeInt32BE(2, 0)
      return pg.parseDataRow(Buffer.concat([count, minusOne, two, Buffer.from('ab', 'utf8')]))
    })(),
    [null, 'ab'])
  let nonceRefused
  try {
    const scram = pg.scramClient({ user: 'u', password: 'p', clientNonce: 'AAAA' })
    scram.final(Buffer.from('r=BBBB,i=4096,s=QSXCR+Q6sek8bf92', 'utf8'))
  } catch (error) {
    nonceRefused = error.message
  }
  ok('a server nonce that does not extend ours is refused',
    typeof nonceRefused === 'string' && nonceRefused.includes('nonce'), String(nonceRefused))

  // A local PostgreSQL is a normal thing to have and NOT a requirement, so its
  // absence is reported and the section carries on.
  const reachable = await new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port: 5432 })
    socket.setTimeout(1_500, () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
    socket.once('connect', () => { socket.destroy(); resolve(true) })
  })
  if (!reachable) {
    console.log('  (no PostgreSQL on 127.0.0.1:5432 — the pure parsers above are all that ran)')
  } else {
    const profile = { host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres' }
    let noCredential
    try {
      await pg.open(profile, {})
    } catch (error) {
      noCredential = error.message
    }
    ok('without a credential, the driver names the mechanism the server asked for',
      typeof noCredential === 'string' && /SCRAM-SHA-256/.test(noCredential), String(noCredential))
    // A wrong password completes the ENTIRE SCRAM exchange and gets the server's
    // verdict — the proof that the handshake, the salt derivation and the proof are
    // all framed the way a real server expects.
    let wrong
    const started = Date.now()
    try {
      await pg.open(profile, { secrets: { password: 'definitely-not-the-password' } })
    } catch (error) {
      wrong = error.message
    }
    ok('a wrong password completes the SCRAM exchange and is refused by the SERVER',
      typeof wrong === 'string' && /authentication/i.test(wrong),
      `${String(wrong)} (${Date.now() - started}ms)`)
    let refused
    try {
      await pg.open({ ...profile, port: 5999 }, {})
    } catch (error) {
      refused = error.message
    }
    ok('a port with nothing behind it says so',
      typeof refused === 'string' && /ECONNREFUSED|无法连接/.test(refused), String(refused))
  }
}

// ── teardown ───────────────────────────────────────────────────────────────
console.log('\nteardown')
const countBefore = ctx.routes.size
upstream.close()
ok('routes were all live before teardown', countBefore === expectedRoutes.length)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('host half: all green')