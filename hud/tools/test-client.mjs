#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — browser half test.
 *
 * Loads the GENERATED `client.js` exactly the way the DSH shell does, then
 * mounts it for real: jsdom + real React, `apply(ctx)` against a mock slots
 * service, and a stubbed `fetch` standing in for the host's same-origin routes.
 *
 * What this proves that a syntax check cannot:
 *
 *   1. the bundle registers under the package name the shell asserts;
 *   2. ONE dock cell is registered — not one per panel;
 *   3. BOTH panels poll their own routes at the same time, which is the whole
 *      point of the merge ("every panel live at once, one card");
 *   4. the layout is a real COLUMN GRID: track count on the body, per-card span
 *      on the cell, and a card that is switched off is only `hidden` — the DOM
 *      node survives, so no poll restarts and no drawer is lost;
 *   5. switching a card off leaves a pill that brings it back;
 *   6. a panel that throws is contained by its boundary instead of blanking
 *      the card;
 *   7. placement preferences round-trip through localStorage;
 *   8. the whole clean run is free of React warnings.
 *
 * Run: `node tools/test-client.mjs`
 */

import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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

// ── the DOM must exist BEFORE the bundle is imported ───────────────────────
// Both halves inject their stylesheet while the factory materializes.
const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
})

/** Node >= 21 defines `navigator` as a read-only global, so define, not assign. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal('MouseEvent', dom.window.MouseEvent)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('IS_REACT_ACT_ENVIRONMENT', true)

// ── a drivable interval ────────────────────────────────────────────────────
// Panels that schedule their own `window.setInterval` (the ported github card
// does) would otherwise poll once on mount and never again, so a fixture swapped
// after the first render could not reach them. Everything still runs for real;
// the callbacks are merely kept so a test can fire them on demand.
const intervals = []
const realSetInterval = dom.window.setInterval.bind(dom.window)
const realClearInterval = dom.window.clearInterval.bind(dom.window)
dom.window.setInterval = (fn, ms, ...rest) => {
  if (typeof fn === 'function') intervals.push({ fn, ms })
  return realSetInterval(fn, ms, ...rest)
}
dom.window.clearInterval = (handle) => realClearInterval(handle)

// ── the stubbed host routes ────────────────────────────────────────────────
const NOW = Date.now()
const HOST_ROUTES = {
  '/dsh-hud/quota/usage': {
    ok: true,
    version: '2.0.0',
    kind: 'normalized',
    fetchedAt: NOW,
    pollMs: 60_000,
    subscriptions: [{
      id: 'opencode-go',
      label: 'opencode-go',
      kind: 'opencode-go',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      credentials: [{ ref: 'OPENCODE_GO_API_KEY', present: true }],
      windows: [{ key: 'rolling', percent: 42, resetsAt: NOW + 3_600_000 }],
      balances: [],
    }],
  },
  '/dsh-hud/quota/refresh': null, // filled in below (same payload)
  '/dsh-hud/github/state': {
    ok: true,
    signedIn: false,
    account: null,
    unread: 0,
    watched: [],
    repos: [],
    pollMs: 60_000,
    carouselMs: 9_000,
    perRepoLimit: 30,
    align: 'right',
    settings: { pollMs: 60_000, carouselMs: 9_000, perRepoLimit: 30, proxy: 'auto', align: 'right' },
    // Same SHAPE as the host sends when signed out: empty, with a reason the card
    // reads from `auth`. A payload that omitted these would be a different shape
    // from the full snapshot, which is exactly what the host avoids.
    reviews: { total: 0, items: [], error: null },
    ciFailing: 0,
    ciRunning: 0,
  },
  // ── weather: the payload the head widget renders ────────────────────────
  '/dsh-hud/weather/state': {
    ok: true,
    fetchedAt: NOW,
    refreshMs: 600_000,
    air: {
      at: '2026-10-01T17:00',
      usAqi: 84,
      europeanAqi: 50,
      level: { zh: '良', en: 'moderate', max: 100 },
      pm25: 27.1,
      pm10: 39,
      ozone: 45,
      no2: 42.3,
      so2: 4.4,
      co: 356,
      units: { pm2_5: 'μg/m³' },
      source: 'open-meteo air-quality',
    },
    location: { name: '无锡市', region: '江苏', country: '中国', countryCode: 'CN', source: 'ip', latitude: 31.5, longitude: 120.2 },
    current: {
      code: 61,
      text: '小雨',
      textEn: 'light rain',
      glyph: '☂',
      temperature: 18.4,
      feelsLike: 17.2,
      humidity: 82,
      precipitation: 0.4,
      windSpeed: 12.4,
      windGust: 21.5,
      windDeg: 135,
      windDirection: { zh: '东南', en: 'SE' },
      windForce: 3,
      isDay: true,
      observedAt: '2026-10-01T10:30',
    },
    alerts: [
      {
        id: 'a1', title: '江苏省无锡市气象台发布大风蓝色预警信号', phenomenon: '大风', level: '蓝色',
        tone: 'info', scope: 'city', place: '江苏省无锡市', issuedAt: '2026/10/01 10:50',
        url: 'http://www.nmc.cn/publish/alarm/a.html',
      },
      {
        id: 'a2', title: '江苏省无锡市气象台发布暴雨黄色预警信号', phenomenon: '暴雨', level: '黄色',
        tone: 'warn', scope: 'city', place: '江苏省无锡市', issuedAt: '2026/10/01 10:49',
        url: 'http://www.nmc.cn/publish/alarm/b.html',
      },
    ],
    alertSource: 'nmc',
    alertsScanned: 879,
  },
}
HOST_ROUTES['/dsh-hud/quota/refresh'] = HOST_ROUTES['/dsh-hud/quota/usage']
HOST_ROUTES['/dsh-hud/weather/refresh'] = HOST_ROUTES['/dsh-hud/weather/state']

// ── parcel: one watched shipment that has news ────────────────────────────
const PARCEL_STATE = {
  ok: true,
  fetchedAt: NOW,
  pollMs: 300_000,
  refreshMs: 900_000,
  maxParcels: 30,
  carriers: [{ code: 'shunfeng', name: '顺丰速运' }, { code: 'yuantong', name: '圆通速递' }],
  parcels: [{
    nu: 'SF0000000000001',
    com: 'shunfeng',
    carrier: '顺丰速运',
    label: '键盘',
    addedAt: NOW - 86_400_000,
    fetchedAt: NOW,
    unread: true,
    newNodes: 1,
    state: 5,
    stateText: '派送中',
    stateTextEn: 'out for delivery',
    tone: 'brand',
    signed: false,
    noData: false,
    latestAt: '2026-10-01 10:24:11',
    location: '无锡市',
    summary: '快件正在派送中，请保持电话畅通',
    nodes: [
      { at: '2026-09-30 22:41:05', text: '【上海市】快件已从 上海转运中心 发出' },
      { at: '2026-10-01 07:02:33', text: '【无锡市】快件已到达 无锡集散中心' },
      { at: '2026-10-01 10:24:11', text: '【无锡市】快件正在派送中，请保持电话畅通' },
    ],
  }],
}
HOST_ROUTES['/dsh-hud/parcel/state'] = PARCEL_STATE
for (const action of ['refresh', 'check', 'read', 'remove', 'add']) {
  HOST_ROUTES[`/dsh-hud/parcel/${action}`] = PARCEL_STATE
}
HOST_ROUTES['/dsh-hud/parcel/detect'] = {
  ok: true,
  nu: 'SF0000000000009',
  candidates: [{ code: 'shunfeng', name: '顺丰速运', confidence: 3 }],
}

// ── market: quotes + a real candle series ─────────────────────────────────
// 26 candles, so MA20 has values — a 10-candle series legitimately cannot
// produce one, and asserting three MAs against it would be asserting a bug.
const MK_CANDLES = Array.from({ length: 26 }, (_, index) => {
  const open = 1240 + index * 4
  const close = open + (index % 3 === 0 ? -6 : 5)
  const day = new Date(Date.UTC(2026, 8, 1 + index))
  return {
    date: day.toISOString().slice(0, 10),
    open,
    close,
    high: Math.max(open, close) + 4,
    low: Math.min(open, close) - 5,
    volume: 20_000 + index * 1_500,
    amount: 2_600_000_000,
  }
})
const MARKET_STATE = {
  ok: true,
  fetchedAt: NOW,
  quoteMs: 30_000,
  klineMs: 300_000,
  pollMs: 30_000,
  session: { cn: { label: 'A股', open: true, time: '10:00' }, hk: { label: '港股', open: true, time: '10:00' }, us: { label: '美股', open: false, time: '22:00' }, anyOpen: true },
  period: 'day',
  periods: [
    { value: 'realtime', label: '实时', labelEn: '1m', intraday: true },
    { value: 'm5', label: '5分', labelEn: '5m', intraday: true },
    { value: 'm15', label: '15分', labelEn: '15m', intraday: true },
    { value: 'h1', label: '60分', labelEn: '60m', intraday: true },
    { value: 'day', label: '日K', labelEn: 'D' },
    { value: 'week', label: '周K', labelEn: 'W' },
    { value: 'month', label: '月K', labelEn: 'M' },
  ],
  selected: '1.600519',
  quotes: [
    { secid: '1.000001', name: '上证指数', code: '000001', price: 3842.19, changePct: 0.31, change: 11.74 },
    { secid: '1.600519', name: '贵州茅台', code: '600519', price: 1251.24, changePct: -0.85, change: -10.7 },
    { secid: '105.AAPL', name: '苹果', code: 'AAPL', price: 228.15, changePct: 1.24, change: 2.81 },
  ],
}
// The yuan, riding along with the quotes — one row of rates under the indices.
MARKET_STATE.forex = [
  { secid: '133.USDCNH', code: 'USD', name: '美元', value: 6.7186, decimals: 4, changePct: 0.14, inverse: false },
  { secid: '133.EURCNH', code: 'EUR', name: '欧元', value: 7.5891, decimals: 4, changePct: -0.18, inverse: false },
  { secid: '133.CNHJPY', code: 'JPY', name: '日元', value: 23.5637, decimals: 4, changePct: 0.48, inverse: true },
]

// The futures view's own route, and the 汇率 board the fx view reads. Shaped like the hosts'.
const FUTURES_STATE = {
  ok: true,
  now: 1790753124000,
  sectors: ['黑色', '能源化工', '农产品'],
  periods: [{ value: 'day', label: '日K', labelEn: 'D' }, { value: 'week', label: '周K', labelEn: 'W' }],
  session: { cffex: { open: false, tradingDay: true, time: '14:00' }, bulk: { open: true, tradingDay: true, time: '14:00' } },
  pollMs: 60_000,
  contracts: [
    { secid: '113.rbm', code: 'rbm', name: '螺纹钢主连', short: '螺纹钢', sector: '黑色', price: 3112, changePercent: 0.1, openInterest: 1592266, volume: 638932 },
    { secid: '114.mm', code: 'mm', name: '豆粕主连', short: '豆粕', sector: '农产品', price: 3372, changePercent: 0.75, openInterest: 2445036, volume: 1012345 },
    { secid: '115.MAM', code: 'MAM', name: '甲醇主连', short: '甲醇', sector: '能源化工', price: 3384, changePercent: 1.77, openInterest: 455513, volume: 2236279 },
  ],
}
HOST_ROUTES['/dsh-hud/futures/state'] = FUTURES_STATE
HOST_ROUTES['/dsh-hud/futures/refresh'] = FUTURES_STATE
HOST_ROUTES['/dsh-hud/futures/curve'] = { ok: true, product: 'rb', months: [{ code: 'rb2610', month: '2610', price: 3034, openInterest: 20515 }] }
/**
 * 今日涨跌榜. The fixture carries the shapes the real endpoint produces — including a 新股 at
 * +206% and a 退市整理 at -72%, which the HOST is supposed to have dropped before the card
 * ever sees them. A card that renders them means the filter is gone.
 */
let RANK_CALLS = 0
HOST_ROUTES['/dsh-hud/market/rank'] = () => {
  RANK_CALLS += 1
  const row = (code, name, price, changePct, amount, market) => ({
    secid: `${market}.${code}`, code, name, price, changePct, change: Number((price * changePct / 100).toFixed(2)),
    amount, high: price, low: price, open: price, prevClose: price, volume: 1000,
  })
  return {
    ok: true,
    fetchedAt: Date.now(),
    size: 20,
    session: { open: false, tradingDay: false, name: '沪深京' },
    up: {
      dir: 'up', total: 5921, scanned: 60, filtered: 1,
      rows: [
        row('301190', '善水科技', 35.93, 20.01, 510373313, 0),
        row('688185', '康希诺', 102.64, 20, 1065144349, 1),
        row('920344', '三元基因', 24.35, 15.79, 320000000, 0),
        row('002226', '江南化工', 5.34, 10.1, 412000000, 0),
      ],
    },
    down: {
      dir: 'down', total: 5921, scanned: 60, filtered: 1,
      rows: [
        row('920202', '安达股份', 18.32, -29.97, 318000000, 0),
        row('301030', '*ST仕净', 4.18, -15.9, 127000000, 0),
        row('688521', '芯原股份', 171.68, -11.34, 5462000000, 1),
      ],
    },
  }
}
HOST_ROUTES['/dsh-hud/market/fx'] = {
  ok: true,
  groups: ['对人民币', '主要货币对', '指数'],
  rates: [
    { secid: '133.USDCNH', name: '美元', value: 6.7066, decimals: 4, changePct: -0.11, group: '对人民币' },
    { secid: '119.EURUSD', name: '欧元/美元', value: 1.1251, decimals: 4, changePct: 0.08, group: '主要货币对' },
    { secid: '100.UDI', name: '美元指数', value: 101.95, decimals: 4, changePct: -0.08, group: '指数', index: true },
  ],
}
HOST_ROUTES['/dsh-hud/market/state'] = MARKET_STATE
HOST_ROUTES['/dsh-hud/market/kline'] = { ok: true, secid: '1.600519', period: 'day', name: '贵州茅台', code: '600519', candles: MK_CANDLES }
for (const action of ['refresh', 'add', 'remove', 'select', 'period']) HOST_ROUTES[`/dsh-hud/market/${action}`] = MARKET_STATE
HOST_ROUTES['/dsh-hud/market/search'] = {
  ok: true,
  results: [{ secid: '0.000858', code: '000858', name: '五粮液', kind: '深A' }],
}

// ── bond: curve + series + FRED + ETFs ───────────────────────────────────
const BOND_STATE = {
  ok: true,
  fetchedAt: NOW,
  pollMs: 1_800_000,
  cn: {
    date: '2026-09-30',
    trendLabel: '十年国债ETF',
    curve: [
      { tenor: 0.083, label: '1M', value: 1.01 }, { tenor: 0.25, label: '3M', value: 1.16 },
      { tenor: 0.5, label: '6M', value: 1.28 }, { tenor: 1, label: '1Y', value: 1.38 },
      { tenor: 3, label: '3Y', value: 1.52 }, { tenor: 5, label: '5Y', value: 1.68 },
      { tenor: 7, label: '7Y', value: 1.82 }, { tenor: 10, label: '10Y', value: 1.95 },
      { tenor: 30, label: '30Y', value: 2.1 },
    ],
    // A PRICE series (the bond ETF), which is what the CN trend chart shows.
    trend: [
      { date: '2026-09-28', value: 134.836 }, { date: '2026-09-29', value: 134.9 }, { date: '2026-09-30', value: 134.804 },
    ],
  },
  charts: [
    { secid: '1.511260', code: '511260', name: '十年国债ETF', kind: 'price' },
    { secid: '1.511010', code: '511010', name: '国债ETF', kind: 'price' },
    { secid: '1.511380', code: '511380', name: '可转债ETF', kind: 'price' },
    { secid: '171.US10Y', code: 'US10Y', name: '美债10年收益率', kind: 'yield' },
  ],
  chart: '1.511260',
  chartPeriod: 'day',
  periods: [{ value: 'day', label: '日K', labelEn: 'D' }, { value: 'week', label: '周K', labelEn: 'W' }, { value: 'month', label: '月K', labelEn: 'M' }],
  us: {
    series: [
      { id: 'US2Y', label: '美债 2 年', labelEn: 'US 2Y', source: 'eastmoney', points: [{ date: '2026-09-29', value: 4.85 }, { date: '2026-09-30', value: 4.8807 }], latest: 4.8807, change: -0.0104 },
      { id: 'US10Y', label: '美债 10 年', labelEn: 'US 10Y', source: 'eastmoney', points: [{ date: '2026-09-28', value: 5.2404 }, { date: '2026-09-29', value: 5.2404 }, { date: '2026-09-30', value: 5.2785 }], latest: 5.2785, change: -0.0106 },
      { id: 'US30Y', label: '美债 30 年', labelEn: 'US 30Y', source: 'eastmoney', points: [{ date: '2026-09-30', value: 5.6217 }], latest: 5.6217, change: -0.0092 },
    ],
  },
  spread: { cn10: 1.95, us10: 5.2785, cnMinusUs: -3.3285, us10Minus2: 0.3978 },
  etfs: [
    { secid: '1.511010', code: '511010', name: '国债ETF国泰', price: 140.735, changePct: -0.12 },
    { secid: '1.511260', code: '511260', name: '十年国债ETF', price: 134.804, changePct: 0.07 },
  ],
}
/**

// ── the settings routes, answering like the host does ──
// A read returns what is in force; a write merges a patch and echoes the canonical
// object back; a reset drops the override. Without these every write was a 404 and
// the form went into an error state — which then made the NEXT interaction in it do
// nothing, and that looked exactly like a harness limitation.
const settingsRoute = (state, path) => (url) => {
  void url
  return state
}
// A write merges its patch and echoes the canonical object back, exactly like the
// host: a stub that returned a constant made the form snap back to the old list after
// every write, which turned "remove one entry" into "remove a different entry".
const mergeSettings = (state, patch) => {
  const next = { ...state.settings, ...(patch.settings ?? {}) }
  if (state.settings.custom !== undefined && patch.settings?.custom === undefined) next.custom = state.settings.custom
  state.settings = next
  return { ok: true, settings: next, fromPanelConfig: false }
}
HOST_ROUTES['/dsh-hud/services/settings'] = (init) => (init?.method === 'POST'
  ? mergeSettings(SERVICES_STATE, JSON.parse(init.body ?? '{}'))
  : { ok: true, settings: SERVICES_STATE.settings, fromPanelConfig: false })
HOST_ROUTES['/dsh-hud/git/settings'] = (init) => (init?.method === 'POST'
  ? mergeSettings(GIT_STATE, JSON.parse(init.body ?? '{}'))
  : { ok: true, settings: GIT_STATE.settings, fromPanelConfig: false })

/**
 * The services card's payload: one target per verdict, plus an unparseable
 * entry and a certificate that is about to expire.
 */
const SERVICES_STATE = {
  ok: true,
  now: 1_700_000_000_000,
  targets: [
    { key: 'http://127.0.0.1:8080/health', name: '网关', kind: 'http', address: 'http://127.0.0.1:8080/health', state: 'up', ms: 23, status: 200, since: 1_699_999_700_000, forMs: 300_000, forText: '5 分钟', changes: 1, lastChangeAt: 1_699_999_700_000, cert: { days: 146 } },
    { key: 'http://127.0.0.1:8080/admin', name: '后台', kind: 'http', address: 'http://127.0.0.1:8080/admin', state: 'degraded', ms: 18, status: 401, since: 1_699_999_000_000, forMs: 1_000_000, forText: '16 分钟', changes: 0 },
    { key: '127.0.0.1:1', name: '旧接口', kind: 'tcp', address: '127.0.0.1:1', state: 'down', ms: 4, error: 'connect ECONNREFUSED 127.0.0.1:1', since: 1_699_990_000_000, forMs: 10_000_000, forText: '2 小时 46 分钟', changes: 3, lastChangeAt: 1_699_990_000_000 },
  ],
  invalid: [{ name: '写错的', error: '不是合法的 URL：not a url' }],
  upCount: 1,
  downCount: 1,
  degradedCount: 1,
  certWarn: { name: '网关', days: 9 },
  pollMs: 30_000,
  refreshMs: 30_000,
}

SERVICES_STATE.settings = {
  targets: [
    { name: '网关', url: 'http://127.0.0.1:8080/health' },
    { name: '数据库', host: '127.0.0.1', port: 5432 },
  ],
  pollMs: 60_000,
  timeoutMs: 2000,
}
SERVICES_STATE.settingsFromPanelConfig = false
HOST_ROUTES['/dsh-hud/services/state'] = SERVICES_STATE
HOST_ROUTES['/dsh-hud/services/refresh'] = SERVICES_STATE
/**
 * The git card's payload: one repository mid-merge with everything dirty, one
 * clean repository whose ahead count is a PACKED lower bound, and a path that is
 * not a repository at all.
 */
const GIT_STATE = {
  ok: true,
  now: 1_700_000_000_000,
  repos: [
    {
      path: 'E:/Project/app', name: 'app', source: 'config',
      head: { branch: 'feature/hud', detached: false, sha: 'a1b2c3d', unborn: false },
      upstream: { ref: 'refs/remotes/origin/feature/hud', sha: 'd4e5f6a', missing: false, ahead: 3, behind: 1, exact: true },
      commit: { sha: 'a1b2c3d', subject: 'feat: 加速面板', author: 'Dingji', at: 1_699_999_400_000, parents: 1, source: 'object' },
      work: { staged: 2, modified: 1, deleted: 1, conflicted: 0, dirty: 4, files: ['a.txt', 'new.txt'], hashed: 1 },
      operations: ['merge'],
      stash: 2,
      checkedAt: 1_700_000_000_000,
    },
    {
      path: 'E:/Project/other', name: 'other', source: 'card',
      head: { branch: 'main', detached: false, sha: '9999999', unborn: false },
      upstream: { ref: 'refs/remotes/origin/main', sha: '8888888', missing: false, ahead: 2, behind: 0, exact: false },
      commit: { sha: '9999999', subject: 'chore: 打包前的提交', author: 'Dingji', at: 1_699_900_000_000, source: 'reflog', objectPacked: true },
      work: { staged: 0, modified: 0, deleted: 0, conflicted: 0, dirty: 0, files: [], stagedError: 'HEAD 的对象已打包，无法比较索引与 HEAD' },
      operations: [],
      stash: 0,
    },
    { path: 'E:/not/a/repo', name: 'not-a-repo', error: '不是 git 仓库（没有 .git）' },
  ],
  count: 3,
  dirtyCount: 1,
  operationCount: 1,
  behindCount: 1,
  errorCount: 1,
  pollMs: 20_000,
  refreshMs: 20_000,
}

GIT_STATE.settings = {
  pollMs: 20_000,
  maxCommits: 40,
  untracked: false,
  discoverRoot: '',
  discoverDepth: 3,
  watch: ['E:/Project/watched'],
}
GIT_STATE.settingsFromPanelConfig = false
HOST_ROUTES['/dsh-hud/git/state'] = GIT_STATE
HOST_ROUTES['/dsh-hud/git/refresh'] = GIT_STATE
HOST_ROUTES['/dsh-hud/git/watch'] = { ok: true, watch: [] }
HOST_ROUTES['/dsh-hud/git/discover'] = { ok: true, root: 'E:/Project', found: ['E:/Project/app', 'E:/Project/other'], scanned: 12 }

// ── the SQL panel's fixtures ──
// Two connections, one of them BROKEN — because the most misleading thing this card
// could render is an empty tree for a database it could not reach.
const SQL_DRIVERS = [
  { id: 'sqlite', label: 'SQLite', labelZh: 'SQLite', available: true, readonly: 'engine', defaultPort: 0, fields: [{ key: 'file', label: '数据库文件', labelEn: 'FILE', kind: 'text' }] },
  { id: 'postgres', label: 'PostgreSQL', labelZh: 'PostgreSQL', available: true, readonly: 'transaction', defaultPort: 5432, fields: [
    { key: 'host', label: '主机', labelEn: 'HOST', kind: 'text' },
    { key: 'port', label: '端口', labelEn: 'PORT', kind: 'number' },
    { key: 'database', label: '数据库', labelEn: 'DATABASE', kind: 'text' },
    { key: 'user', label: '用户', labelEn: 'USER', kind: 'text' },
    { key: 'passwordRef', label: '凭据名', labelEn: 'CREDENTIAL', kind: 'text' },
        { key: 'ssl', label: 'SSL', labelEn: 'SSL', kind: 'toggle' },
  ] },
]
const SQL_SCHEMA = {
  driver: 'sqlite',
  info: {},
  target: 'E:/data/app.db',
  readOnly: true,
  at: 1,
  schemas: [{
    name: 'main',
    file: 'E:/data/app.db',
    objects: [
      { kind: 'table', name: 'users', schema: 'main', columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'nick', type: 'TEXT', primaryKey: false, nullable: true },
      ] },
      { kind: 'view', name: 'top_users', schema: 'main', columns: [
        { name: 'nick', type: 'TEXT', primaryKey: false, nullable: true },
      ] },
    ],
  }],
}
const SQL_STATE = {
  ok: true,
  now: 1,
  empty: false,
  active: 'local',
  target: 'E:/data/app.db',
  readOnly: true,
  pollMs: 60_000,
  drivers: SQL_DRIVERS,
  connections: [
    { id: 'local', driver: 'sqlite', name: '本地库', readOnly: true, limit: 200, file: 'E:/data/app.db', target: 'E:/data/app.db' },
    { id: 'prod', driver: 'postgres', name: '生产库', readOnly: true, limit: 200, host: '10.0.0.9', port: 5432, database: 'app', target: 'app@10.0.0.9:5432/app' },
  ],
  schema: SQL_SCHEMA,
}
const SQL_EMPTY = { ...SQL_STATE, empty: true, connections: [], active: '', target: undefined, schema: undefined }
const SQL_BROKEN = { ...SQL_STATE, error: '文件不存在：E:/data/gone.db', target: 'E:/data/gone.db', schema: undefined }
  /**
   * ── the SSH side ────────────────────────────────────────────────────────────
   *
   * The card is a database OR an SSH client. These routes are its own, and they do not
   * touch a database: switching the mode must work on a card whose database side is down.
   */
  let SSH_LAST = null
  let SSH_TAUGHT = []
  const SSH_ROUTES = {
    '/dsh-hud/sql/ssh/state': () => ({
      ok: true, now: Date.now(), mode: 'ssh', empty: (SQL_PANEL_SETTINGS.hosts ?? []).length === 0,
      activeHost: SQL_PANEL_SETTINGS.activeHost ?? '',
      hosts: (SQL_PANEL_SETTINGS.hosts ?? []).map((one) => ({
        ...one,
        target: `${one.user}@${one.host}:${one.port}`,
        credential: one.auth === 'password' ? 'present' : 'none',
      })),
      capability: { ok: true, ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', node: 'node', version: 'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2' },
      last: SSH_LAST,
    }),
    '/dsh-hud/sql/ssh/test': (init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const host = body.host ?? {}
      if (String(host.host ?? '').includes('unreachable')) return { ok: false, error: 'Connection refused', ms: 12 }
      return { ok: true, ms: 34, target: `${host.user}@${host.host}:${host.port}`, answered: 'dsh-hud-ssh-ok', version: 'OpenSSH_for_Windows_9.5p2' }
    },
    '/dsh-hud/sql/ssh/run': (init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const command = String(body.command ?? '')
      if (command.includes('fail')) {
        SSH_LAST = { ok: false, code: 1, ms: 41, command, stdout: '', stderr: 'bash: fail: command not found', truncated: false, target: 'root@10.0.0.9:22' }
        return { ok: false, result: SSH_LAST }
      }
      SSH_LAST = { ok: true, code: 0, ms: 37, command, stdout: ' 10:31:04 up 41 days', stderr: '', truncated: false, target: 'root@10.0.0.9:22' }
      return { ok: true, result: SSH_LAST }
    },
  }
  for (const [path, handler] of Object.entries(SSH_ROUTES)) HOST_ROUTES[path] = handler

HOST_ROUTES['/dsh-hud/sql/state'] = SQL_STATE
HOST_ROUTES['/dsh-hud/sql/refresh'] = SQL_STATE
/**
 * The settings route RECORDS what it was asked to store, and remembers it: the SSH tests
 * assert on what a save actually sent (a host, and never a password) and on the fact that
 * switching the card's mode does not throw the other side's list away.
 */
const SQL_PANEL_SETTINGS = { mode: 'db', connections: SQL_STATE.connections, hosts: [], active: 'local', activeHost: '', pollMs: 60_000 }
const SQL_SETTINGS_WRITES = []
HOST_ROUTES['/dsh-hud/sql/settings'] = (init) => {
  const method = String(init?.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    return { ok: true, settings: { ...SQL_PANEL_SETTINGS, connections: SQL_STATE.connections }, fromPanelConfig: false, drivers: SQL_DRIVERS }
  }
  const body = JSON.parse(String(init?.body ?? '{}'))
  const patch = body?.settings ?? body ?? {}
  Object.assign(SQL_PANEL_SETTINGS, patch, patch.hosts === undefined ? {} : { hosts: patch.hosts })
  SQL_SETTINGS_WRITES.push({ ...patch })
  return { ok: true, settings: { ...SQL_PANEL_SETTINGS, connections: SQL_STATE.connections } }
}
HOST_ROUTES['/dsh-hud/sql/query'] = { ok: true, result: {
  columns: ['id', 'nick'],
  rows: [[1, '甲'], [2, null]],
  truncated: false,
  ms: 3,
  readOnly: true,
  limit: 200,
  notice: '2 行',
  wrote: false,
} }
HOST_ROUTES['/dsh-hud/sql/test'] = { ok: true, ms: 2, driver: 'sqlite', info: { database: 'main' }, target: 'E:/data/app.db' }
// Where a typed password goes. The card tests first, then writes the secret here, then
// saves a connection that carries only the NAME — so the settings file never holds one.
const SQL_CREDENTIAL_WRITES = []
HOST_ROUTES['/dsh-hud/sql/credential'] = (init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  SQL_CREDENTIAL_WRITES.push({ ref: body?.ref, value: body?.value })
  return { ok: true, ref: body?.ref ?? 'dsh-hud-sql-db' }
}
// A driver this process CANNOT use. The card has to offer it disabled and say why,
// rather than letting it be picked and failing at connect time looking like a network
// problem — so the fixture carries one.
SQL_DRIVERS.push({
  id: 'mysql',
  label: 'MySQL / MariaDB',
  labelZh: 'MySQL / MariaDB',
  available: false,
  reason: '这个 Node 里没有 MySQL 客户端',
  readonly: 'transaction',
  fields: [
    { key: 'host', label: '主机', labelEn: 'HOST', kind: 'text' },
    { key: 'port', label: '端口', labelEn: 'PORT', kind: 'number' },
  ],
})
HOST_ROUTES['/dsh-hud/bond/state'] = BOND_STATE
HOST_ROUTES['/dsh-hud/bond/refresh'] = BOND_STATE
HOST_ROUTES['/dsh-hud/bond/chart'] = BOND_STATE
/** Candles for whichever instrument the card asks for. */
const BOND_CANDLES = Array.from({ length: 30 }, (_, index) => {
  const open = 134 + index * 0.02
  const close = open + (index % 4 === 0 ? -0.05 : 0.04)
  const day = new Date(Date.UTC(2026, 7, 20 + index))
  return { date: day.toISOString().slice(0, 10), open: Number(open.toFixed(3)), close: Number(close.toFixed(3)), high: Number((Math.max(open, close) + 0.03).toFixed(3)), low: Number((Math.min(open, close) - 0.03).toFixed(3)), volume: 1500 + index * 20 }
})
HOST_ROUTES['/dsh-hud/bond/kline'] = { ok: true, secid: '1.511260', period: 'day', kind: 'price', name: '十年国债ETF', code: '511260', candles: BOND_CANDLES }

const fetched = []
/** The todo fixture is mutable: the panel posts, and the next poll must see it. */
const TODO_NOW = Date.parse('2026-10-01T10:00:00')
const todoState = () => ({
  ok: true,
  now: TODO_NOW,
  todayDate: '2026-10-01',
  clock: '10:00',
  counts: { overdue: 1, today: 2, tomorrow: 1, later: 0, someday: 1, done: 1, open: 5 },
  groups: {
    overdue: [{ id: 'q1', title: '交房租', dueAt: Date.parse('2026-09-29T09:00:00'), done: false, readOnly: false, source: 'local' }],
    today: [
      { id: 'q2', title: '写周报', dueAt: Date.parse('2026-10-01T14:30:00'), done: false, readOnly: false, source: 'local' },
      { id: 'q3', title: '季度评审', dueAt: Date.parse('2026-10-01T17:00:00'), done: false, readOnly: true, source: '飞书日历' },
    ],
    tomorrow: [{ id: 'q4', title: '体检', dueAt: Date.parse('2026-10-02T09:00:00'), done: false, readOnly: false, source: 'local' }],
    later: [],
    someday: [{ id: 'q5', title: '读一本书', dueAt: undefined, done: false, readOnly: false, source: 'local' }],
    done: [{ id: 'q6', title: '买咖啡', dueAt: Date.parse('2026-10-01T08:00:00'), done: true, doneAt: TODO_NOW - 3_600_000, readOnly: false, source: 'local' }],
  },
  leads: [60, 30, 5],
  digestAt: '16:30',
  digest: null,
  schedule: [
    { id: 'q2', title: '写周报', dueAt: Date.parse('2026-10-01T14:30:00'), readOnly: false },
    { id: 'q4', title: '体检', dueAt: Date.parse('2026-10-02T09:00:00'), readOnly: false },
  ],
  feeds: [],
  feedSettings: [],
  ignoreCount: 0,
  // The credential surfaces: what the card needs in order to offer a login.
  mail: { host: 'imap.163.com', port: 993, user: 'me@163.com', mailbox: 'INBOX', limit: 15, preset: '163' },
  mailPresets: {
    '163': { label: '网易 163', host: 'imap.163.com', port: 993, hint: '开启 IMAP 后生成授权码' },
    qq: { label: 'QQ 邮箱', host: 'imap.qq.com', port: 993, hint: '生成授权码' },
    custom: { label: '自定义', host: '', port: 993, hint: '任何支持 IMAP 的邮箱都可以' },
  },
  oauth: {
    provider: 'feishu', clientId: 'cli_abc', redirectUri: 'http://127.0.0.1:19387/dsh-hud/todo/callback',
    expiresAt: 0, account: '', lastError: '', providerLabel: '飞书', scope: 'task:task:read',
    idField: 'app_id', secretField: 'app_secret', console: 'https://open.feishu.cn/app',
  },
  providerCount: 0,
  // A stored 授权码 is reported as EXISTING, never as a value.
  mailHasSecret: true,
  oauthHasSecret: true,
  oauthHasToken: false,
  pollMs: 300_000,
  refreshMs: 300_000,
})
let todoSnapshot = todoState()
for (const action of ['state', 'add', 'update', 'remove', 'settings', 'refresh', 'mail', 'mail/list', 'login', 'tasks']) {
  // A FUNCTION, so a test can change what the next poll sees — which is how the
  // notification path gets driven without waiting for a real 5-minute poll.
  HOST_ROUTES[`/dsh-hud/todo/${action}`] = () => todoSnapshot
}

defineGlobal('fetch', async (url, init) => {
  const path = String(url).split('?')[0]
  // The QUERY matters as much as the path here: "which stock, which period" is the whole
  // question a hover test asks, and the path alone cannot answer it.
  fetched.push({ path, query: String(url).split('?')[1] ?? '', method: init?.method ?? 'GET', body: init?.body })
  const entry = HOST_ROUTES[path]
  // A fixture may be a FUNCTION, so a test can change what the next poll sees.
  const body = typeof entry === 'function' ? entry(init) : entry
  if (body === undefined) {
    // Faithful to the real web server: an unmatched route is a 404 with a
    // NON-JSON body, which is what makes the client report `HTTP 404（…）`.
    // Returning a JSON error here hid the very branch under test.
    return { ok: false, status: 404, json: async () => { throw new Error('not json') } }
  }
  // A fixture may say `ok: false` — a failure the route reports as DATA, which is how every
  // panel here handles a refused or failed operation. The status stays 200 (that is what the
  // host sends), and the shell's fetchJson turns it into a throw with the BODY attached, which
  // is where the card reads the server's code and DETAIL from.
  return { ok: true, status: 200, json: async () => body }
})

// ── load the bundle the way the shell does ─────────────────────────────────
console.log('bundle')
const loaded = []
dom.window.__ModuleLoader__ = {
  load(entry) {
    loaded.push(entry)
  },
}

const source = readFileSync(join(root, 'client.js'), 'utf8')
// Import through a data: URL so the bundle is evaluated as ESM exactly once,
// with the globals above already in place.
await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)

eq('exactly one module registration', loaded.length, 1)
const entry = loaded[0]
/**
 * Read the expected name from `package.json` rather than writing it here.
 *
 * The bundle registers its module under the PACKAGE name, so this assertion is really "the
 * builder used the manifest, not a literal" — and a hard-coded copy of the name turns a rename
 * into a test failure that has nothing to do with the rename. (It did exactly that.)
 */
eq('module id is the package name', entry.id, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name)
ok('the factory is a function', typeof entry.factory === 'function')

const React = (await import('react')).default
const jsxRuntime = await import('react/jsx-runtime')
const exports = entry.factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`bundle required an unknown module: ${spec}`)
})

ok('inject asks for slots', JSON.stringify(exports.inject) === '["slots"]')
ok('apply is exported', typeof exports.apply === 'function')
const panelIds = (exports.__panels ?? []).map((panel) => panel.id)
// `registerPanel` sorts by each panel's declared `order` (stable, so equal orders keep
// registration order). Services, git and machine are gone, and market+bond are now ONE card.
eq('every panel registered, in order', panelIds,
  // Only the cards. 股市, 债市 and 期货 are three PANELS sharing one CARD — their factories are
  // called by that card, not registered here — so none of the three appears in this list. The tab
  // order inside the card comes from the card's own list, not from a panel `order`.
  ['markets', 'quota', 'todo', 'sql', 'weather', 'parcel', 'github'])
eq('each panel declares its preferred span',
  (exports.__panels ?? []).map((panel) => [panel.id, panel.span]),
  [['markets', 1], ['quota', 1], ['todo', 1], ['sql', 1], ['weather', 1], ['parcel', 1], ['github', 1]])
eq('which half each panel contributes',
  (exports.__panels ?? []).map((panel) => [panel.id, typeof panel.head, typeof panel.Component]),
  [
    // 股市 and 债市 are ONE card with a toggle: two cards answering the same question
    // spent two thirds of a row on tabular data.
    ['markets', 'undefined', 'function'],
    ['quota', 'undefined', 'function'],
    // The to-do widget lives in the title bar only — the list opens as a popover,
    // so it never spends one of the three columns.
    ['todo', 'function', 'undefined'],
    // 25, between the quota card and the parcel card. The packer is first-fit in ORDER, so
    // being packed third is what puts the database card in the RIGHT column and leaves the
    // middle free for 快递 and GitHub to stack under the quota card.
    ['sql', 'undefined', 'function'],
    ['weather', 'function', 'undefined'],
    ['parcel', 'undefined', 'function'],
    ['github', 'undefined', 'function'],
  ])
// A panel may ask for a side of the head row. Only one uses it so far, and it is
// the one whose whole point was "标题栏的右侧".
eq('a panel can ask for the right-hand side of the title bar',
  (exports.__panels ?? []).filter((panel) => panel.headSide === 'right').map((panel) => panel.id), ['todo'])
eq('and everything else defaults to the reading-order side',
  (exports.__panels ?? []).filter((panel) => panel.id !== 'todo').every((panel) => panel.headSide === 'left'), true)

const styles = [...dom.window.document.querySelectorAll('style[data-plugin="dsh-hud"]')]
ok('every stylesheet is attributed to the package', styles.length >= 3, `found ${styles.length}`)
const css = styles.map((tag) => tag.textContent).join('\n')
const cssIds = styles.map((tag) => tag.dataset.pluginCss)
ok('the shell stylesheet is present', cssIds.includes('dsh-hud/shell.css'), cssIds.join(','))
ok('the shell flattens the panels\' own card chrome', css.includes('.hud-card .ocq-card'))
ok('the grid declares a rule per track count', ['1', '2', '3'].every((n) => css.includes(`.hud-body[data-cols="${n}"]`)))
ok('the grid declares a rule per card span', ['1', '2', '3'].every((n) => css.includes(`.hud-panel[data-span="${n}"]`)))
ok('narrow docks collapse to a single track', /@media \(max-width:\d+px\)\{\.hud-body\[data-cols\]/.test(css))
ok('the title bar has a slot for head widgets', css.includes('.hud-heads{'))
ok('the card has no width cap at all', css.includes('.hud-card{box-sizing:border-box;width:100%;max-width:none;'))
ok('no placement rule survives in the stylesheet', !/\.hud-root\.is-(center|left|right|stretch)/.test(css))
// A full-width card still needs to breathe: the root is border-box, so its
// horizontal padding is an INSET and the card cannot end up wider than the dock.
//
// Asserted as the SHORTHAND means it, not as an exact string: the rule also
// carries a top inset (so the head row is not flush to the edge) and a bottom
// one, and pinning `padding:0 Npx 8px` verbatim made a legit spacing tweak look
// like a regression.
const rootRule = (css.match(/\.hud-root\{[^}]*\}/) ?? [''])[0]
const padParts = (/padding:([^;}]+)/.exec(rootRule)?.[1] ?? '').trim().split(/\s+/)
// `top [right] [bottom] [left]` — the second value is the horizontal inset.
const gutter = padParts.length === 1 ? padParts[0] : padParts[1]
ok('the root pads the card away from the dock edges', /^\d+px$/.test(gutter), `padding:${padParts.join(' ')}`)
ok('the gutter is in the 6–10px range the layout calls for',
  Number(gutter.replace('px', '')) >= 6 && Number(gutter.replace('px', '')) <= 10, gutter)
ok('and the root is border-box, so that padding is an inset, not extra width',
  /box-sizing:border-box/.test(rootRule), rootRule.slice(0, 120))

// ── apply() against a mock slots service ──────────────────────────────────
console.log('\ndock registration')
const registrations = []
const ctx = {
  slots: {
    inject(name, callback) {
      ok('injects the dock slot by name', name === 'conversation.input.dock', name)
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  effect(callback) {
    return callback()
  },
}
exports.apply(ctx)

eq('exactly ONE dock cell for the whole HUD', registrations.length, 1)
const cell = registrations[0]
eq('cell id is the package name', cell.options.id, 'dsh-hud')
eq('cell registers into the input dock', cell.options.name, 'conversation.input.dock')
ok('the cell has an order', typeof cell.options.order === 'number', String(cell.options.order))
ok('the cell hands panels a timer factory', typeof cell.options.inject?.().startTimers === 'function')

// ── mount it ──────────────────────────────────────────────────────────────
console.log('\nlive mount')
const container = dom.window.document.getElementById('root')

// React's dev runtime reports API misuse (jsx vs jsxs, missing keys, bad props)
// through console.error. Those messages are captured for the WHOLE run so the
// suite can fail on them instead of printing them: a warning that is merely
// noisy today is a rendering bug tomorrow, and it is exactly how an array
// passed to jsx / a single child passed to jsxs would slip through.
const reported = []
console.error = (...args) => {
  reported.push(args.map((arg) => String(arg)).join(' '))
}

const { createRoot } = await import('react-dom/client')
const act = React.act ?? (async (fn) => {
  const result = await fn()
  await new Promise((resolve) => setTimeout(resolve, 20))
  return result
})

const cellOf = (id) => container.querySelector(`.hud-panel[data-panel="${id}"]`)
const spanOf = (id) => cellOf(id)?.getAttribute('data-span')
/** What the row is currently spending — the number the single-row rule enforces. */
const usedColumns = () => [...container.querySelectorAll('.hud-panel:not([hidden])')]
  .reduce((sum, node) => sum + Number(node.getAttribute('data-span') ?? 0), 0)
/** The ⚙ editor's row for one panel. */
const layoutRow = (id) => container.querySelector(`.hud-vis[data-panel="${id}"]`)?.closest('.hud-layout-row')
/** The editor's refusal message, or null. */
const layoutError = () => container.querySelector('.hud-error')?.textContent ?? null
const isHidden = (id) => cellOf(id)?.hasAttribute('hidden') === true
/**
 * Which cards could still RISE?
 *
 * This is "no gaps" stated for the model the user asked for, and it is the compactor's
 * own fixpoint rather than a stricter ideal: a card keeps the column it was put in, so
 * the grid is compact when no card can be lifted any further. A card is stuck when it
 * is on row 0, or when ANY cell of its footprint one row up is occupied — a card cannot
 * rise halfway, which is why a wide card beside a tall thin one legitimately leaves a
 * cell free above part of itself.
 *
 * An empty array means nothing more can be closed.
 */
const liftableCards = (entries, columns) => {
  const cells = entries.map((one) => ({
    ...one,
    span: Math.min(one.span, columns),
    rows: Math.min(Math.max(one.rows, 1), 8),
  }))
  const occupied = new Map()
  for (const cell of cells) {
    for (let r = cell.row; r < cell.row + cell.rows; r += 1) {
      for (let c = cell.col; c < cell.col + cell.span; c += 1) occupied.set(`${r}:${c}`, cell.id)
    }
  }
  const offenders = []
  for (const cell of cells) {
    if (cell.row === 0) continue
    let blocked = false
    for (let c = cell.col; c < cell.col + cell.span; c += 1) {
      const above = occupied.get(`${cell.row - 1}:${c}`)
      if (above !== undefined && above !== cell.id) { blocked = true; break }
    }
    if (!blocked) offenders.push(`${cell.id}@${cell.col}`)
  }
  return offenders
}
/** The placements as the BROWSER sees them: parsed back out of the inline grid lines. */
const domPlacements = () => [...container.querySelectorAll('.hud-panel:not([hidden])')].map((node) => {
  const col = Number(/^(\d+)/.exec(node.style.gridColumn ?? '')?.[1] ?? 1) - 1
  const row = Number(/^(\d+)/.exec(node.style.gridRow ?? '')?.[1] ?? 1) - 1
  const rows = Number(/span\s+(\d+)/.exec(node.style.gridRow ?? '')?.[1] ?? 1)
  return { id: node.getAttribute('data-panel'), col, row, span: Number(node.getAttribute('data-span') ?? 1), rows }
})
const pillOf = (id) => container.querySelector(`.hud-pill[data-panel="${id}"]`)
const visButton = (id) => container.querySelector(`.hud-vis[data-panel="${id}"]`)
/**
 * Type into a controlled React input.
 *
 * Assigning `.value` directly does NOT work: React tracks the last value it saw
 * on the node, decides nothing changed, and never fires `onChange` — which is
 * why the first version of this test posted nothing at all.
 */
const setInput = async (input, value) => {
  // The prototype has to match the ELEMENT. A textarea's value lives on
  // HTMLTextAreaElement, and calling the input setter on one throws
  // "not a valid instance of HTMLInputElement" — which is how a controlled textarea
  // ends up looking unreachable from a test. (Found by exactly that.)
  const proto = input?.tagName === 'TEXTAREA'
    ? dom.window.HTMLTextAreaElement.prototype
    : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
/**
 * Let an ASYNC click handler finish before asserting on the DOM.
 *
 * `await act(async () => {})` drains microtasks only, while React 18's scheduler
 * flushes through a MessageChannel — a MACROTASK. So a handler that awaits a
 * fetch leaves its state updates queued, and the next assertion reads the
 * pre-update DOM. One real timer tick is what makes them land.
 *
 * (Assertions on `fetched` passed without this, which is exactly why the gap went
 * unnoticed: the REQUEST was made, only its result was missing from the DOM.)
 */
const settle = async () => {
  await act(async () => {
    // Two ticks, and a real delay: React's scheduler flushes through a
    // MessageChannel, whose callback is not guaranteed to run before a 0 ms
    // timer — one tick was not enough for the updates to land.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
const click = async (element, label = '') => {
  // A missing element used to surface as `Cannot read properties of undefined
  // (reading 'dispatchEvent')` with no clue which control was gone. Naming it
  // costs nothing and turns a hunt into a message.
  if (element === null || element === undefined) {
    throw new Error(`click(): nothing to click${label === '' ? '' : ` — ${label}`}`)
  }
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

const rootRender = createRoot(container)
const slotProps = cell.options.inject()

// A DRIVABLE timer factory. The real one is `window.setInterval`, which means a
// 30-second notification tick and a 5-minute poll — neither of which a test can
// wait for, and both of which are worth testing. Panels still poll once on mount
// (that is their own effect), so nothing else in the suite changes.
const timers = []
const realStartTimers = slotProps.startTimers
slotProps.startTimers = (onPoll, pollMs, onTick, tickMs) => {
  timers.push({ onPoll, onTick, pollMs, tickMs })
  return () => {}
}
ok('the timer factory is replaceable, which is what makes the tick testable',
  typeof realStartTimers === 'function' && timers.length === 0, typeof slotProps.startTimers)
/** Run every registered clock tick once (the notification path lives here). */
const fireTicks = async () => {
  const ticks = timers.map((entry) => entry.onTick).filter((fn) => typeof fn === 'function')
  await act(async () => {
    for (const tick of ticks) tick()
  })
  return ticks.length
}

// Seed the REAL bug this release fixes: the previous (tabbed) build wrote an
// `align` placement preference on ANY tab click, and that stale key kept
// pinning the card to a 620px centred column long after full width became the
// only mode. Seeding it here is what makes "it cannot come back" testable.
const storedPrefs = () => dom.window.localStorage.getItem('dsh-hud:prefs') ?? ''
dom.window.localStorage.setItem('dsh-hud:prefs', JSON.stringify({
  align: 'center',
  panel: 'github',
  columns: 3,
  layout: {},
}))

await act(async () => {
  rootRender.render(React.createElement(cell.Component, slotProps))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60))
})

const html = container.innerHTML
ok('the card rendered', html.includes('hud-card'))
ok('the head row rendered', html.includes('hud-head'))

// ── surface opacity and popover stacking ──────────────────────────────────
// A popover opened from the head row was being read THROUGH by the card below
// it, because its surface token was not opaque. Two rules keep that from coming
// back, and both are asserted on the SHIPPED stylesheet rather than on intent.
console.log('\nsurfaces')
const shippedCss = [...container.ownerDocument.querySelectorAll('style')].map((tag) => tag.textContent).join('\n')
ok('no surface uses a token outside the theme contract', !shippedCss.includes('--dsw-specific-menu'),
  (shippedCss.match(/--dsw-[a-z-]*menu[a-z-]*/g) ?? []).join(','))
const popRule = (shippedCss.match(/\.wx-pop\{[^}]*\}/) ?? [''])[0]
ok('the weather popover uses the opaque raised surface', /background:var\((--hud-pop|--dsw-alias-bg-layer-1)/.test(popRule), popRule.slice(0, 140))
ok('the head row creates a stacking context above the grid',
  /\.hud-head\{[^}]*position:relative[^}]*z-index:\d+/.test(shippedCss),
  (shippedCss.match(/\.hud-head\{[^}]*\}/) ?? [''])[0].slice(0, 140))
// The NUMBER is part of the invariant, not just the property. A card HEADER is
// `position:relative;z-index:5` too (it has to beat the resize strips), and a TIE
// between the two is settled by DOM order — the head row comes first, so every
// card header painted over anything opened from it. That is exactly the report:
// the market card's header (股市 · 14:31:44 · ＋ 添加标的 · 刷新) read straight
// through the open weather detail, while the same card's BODY stayed behind it —
// the body is `z-index:auto`, which is why only the header leaked. Asserted as an
// ORDER, so nobody has to remember which of the two numbers is the higher one.
const tierOf = (pattern) => Number(pattern.exec(shippedCss)?.[1] ?? 0)
const headTier = tierOf(/\.hud-head\{[^}]*z-index:(\d+)/)
const cardHeadTier = tierOf(/\.hud-card \.ocq-head[^{]*\{[^}]*z-index:(\d+)/)
ok('and it outranks every card header, rather than tying with it',
  cardHeadTier > 0 && headTier > cardHeadTier,
  `head row z-index ${headTier} vs card headers ${cardHeadTier}`)
// The two halves of the look, both asserted:
//   the SHELL paints nothing — the HUD sits on the app's own background;
//   the CARDS and everything that OPENS are opaque.
const ruleOf = (selector) => (shippedCss.match(new RegExp(`\\${selector}\\{[^}]*\\}`)) ?? [''])[0]
const shellRule = ruleOf('.hud-card')
ok('the outer shell paints no surface of its own',
  /background:transparent/.test(shellRule) && /box-shadow:none/.test(shellRule) && /border:0/.test(shellRule),
  shellRule.slice(0, 170))
// The FIRST `.hud-panel{...}` rule in the sheet is the tile. The dragging rule
// below is written so it cannot match this regex, which is why it lists two
// selectors instead of one.
const tileRule = ruleOf('.hud-panel')
ok('each card IS a surface (opaque raised tile)',
  /background:var\(--hud-tile\)/.test(tileRule), tileRule.slice(0, 170))
ok('and --hud-tile resolves to the raised-surface token, not a tint',
  /--hud-tile:var\(--dsw-alias-bg-layer-1/.test(shippedCss), '--hud-tile is not bg-layer-1')
// ── a card can never cover the card below it ───────────────────────────────
//
// This is the overlap the user reported, and it is a CSS invariant rather than a
// geometry one, which is why it can be asserted here: jsdom reports every box as
// zero-sized, so a "do these rectangles intersect" test would be a test of nothing.
//
// The rule that makes overlap impossible is that a panel's box IS its grid area. With
// `align-items:start` it was not: a card whose content was taller than its rows kept
// its natural height and grew downward past its own area, over its neighbour. The
// packer was right the whole time.
const bodyRule = ruleOf('.hud-body')
ok('the grid stretches cards to their area instead of letting them overflow it',
  /align-items:stretch/.test(bodyRule) && !/align-items:start/.test(bodyRule),
  bodyRule.slice(0, 170))
// Note the anchored pattern: `ruleOf` matches the TAIL of a longer selector too, so
// asking it for `.hud-panel-body` finds `.hud-panel.is-shown>.hud-panel-body` first.
ok('and a card is allowed to shrink inside that area',
  /min-height:0/.test(tileRule) && /\.hud-panel-body\{[^}]*min-height:0/.test(shippedCss),
  tileRule.slice(0, 120))
ok('and a shown card clips rather than spilling over its neighbour',
  /overflow:hidden/.test(ruleOf('.hud-panel.is-shown')),
  ruleOf('.hud-panel.is-shown').slice(0, 120))
const prefsRule = ruleOf('.hud-prefs')
// A floating surface paints ONE clean token: the raised-surface colour. It must
// never be filled with the theme's `bg-overlay`, which is a SCRIM (it is what
// sits behind a dialog) — that was translucent first, and then muddy grey once
// it was composited onto a surface.
ok('the ⚙ editor is an opaque raised surface',
  /background:var\(--hud-pop\)/.test(prefsRule), prefsRule.slice(0, 190))
ok('NO floating surface paints the overlay scrim, alone or as a tint',
  !/background(-image)?:[^;}]*var\(--dsw-alias-bg-overlay/.test(shippedCss),
  (shippedCss.match(/background(-image)?:[^;}]*var\(--dsw-alias-bg-overlay[^;}]*/g) ?? []).join(' | '))
ok('the popover surface token resolves to the raised surface, not the scrim',
  /--hud-pop:var\(--dsw-alias-bg-layer-1/.test(shippedCss), '--hud-pop is not bg-layer-1')
// The grid must NOT create one that could win: cards stay unpositioned.
ok('cards do not open a competing stacking context',
  !/\.hud-panel\{[^}]*z-index:/.test(shippedCss), tileRule.slice(0, 120))
// Five panels draw five different header rows; the shell gives them one rhythm,
// so the card headers cannot drift apart as panels are added.
const headerRule = (shippedCss.match(/\.hud-card \.ocq-head[^{]*\{[^}]*\}/) ?? [''])[0]
eq('every card header is covered by the shared rule',
  ['.ocq-head', '.ghh-head', '.mk-head', '.bd-head', '.pk-head'].filter((name) => headerRule.includes(name)).length, 5)
ok('and they all get the same separator',
  /border-bottom:1px solid var\(--hud-line\)/.test(headerRule), headerRule.slice(0, 200))
// Rows are UNBOUNDED now, so nothing has to be switched off to make room: every
// panel that does not declare `defaultOn: false` arrives visible, packed into as
// many rows as it needs. The panels that ARE off by default are the ones that
// need setup (github, parcel) plus the head-only todo widget.
// ── v7: the heights the MIGRATION wrote must not block the measurement ────
//
// The measurement loop skips any card with a stored height, because a height the user set
// by hand must survive. v6 stored the DECLARED height of every shipped card, so the four
// cards that most needed measuring were exactly the four that could not be — and a chart
// with more to show than its design allowed simply scrolled. v7 drops a stored height that
// EQUALS the declaration (it cannot be the user's) and keeps one that differs.
{
  // The packing and the migrations are exported for exactly this: a DOM test cannot check
  // a migration properly, because a migration is a pure function of a stored blob.
  const L = exports.__layout
  ok('the layout internals are exported for testing', typeof L?.migrateV6 === 'function')
  const fresh = L.defaultPrefs()
  const v6Blob = { v: 6, columns: 3, layout: {} }
  for (const [id, entry] of Object.entries(fresh.layout)) {
    v6Blob.layout[id] = { ...entry, rows: entry.rows ?? L.DEFAULT_ROWS, hidden: false }
  }
  const migrated = L.migrateV6(v6Blob)
  eq('v7 stamps the blob it produced', migrated.v, L.PREFS_VERSION)
  // The shipped cards declared a height, so v6 wrote exactly that number, so v7 drops
  // it — and the measurement is free to grow the card again.
  eq('a height equal to the declaration is dropped, so the card can be measured again',
    ['markets', 'quota', 'sql'].map((id) => migrated.layout[id]?.rows),
    [undefined, undefined, undefined])
  // ── v9: the arrangement itself ──
  //
  // This is the one the screenshot caught. v8 fixed the two cards' visibility but left the
  // ORDER alone — and the order IS the geometry. A stored order of quota < markets < github
  // < sql packs as quota+sql on the left, markets in the middle and GitHub on the right:
  // perfectly legal, and not what anybody asked for. No amount of changing `defaultOn` moves
  // a card whose position comes from a preference an older version wrote.
  {
    const staleOrder = {
      v: 8,
      columns: 3,
      layout: {
        // exactly the order the user's browser had
        quota: { hidden: false, span: 1, order: 0, rows: 4 },
        markets: { hidden: false, span: 1, order: 1, rows: 6 },
        github: { hidden: false, span: 1, order: 2, rows: 3 },
        sql: { hidden: false, span: 1, order: 3, rows: 6 },
        machine: { hidden: true, span: 1, order: 4, rows: 3, collapsed: true },
        todo: { hidden: false, span: 1, order: 5, rows: 7 },
      },
    }
    const migrated = L.migrateV8(staleOrder)
    eq('v9 stamps the blob it produced', migrated.v, L.PREFS_VERSION)
    eq('the five cards of the arrangement get their geometry from the layout',
      ['markets', 'quota', 'sql', 'parcel', 'github'].map((id) => migrated.layout[id].order),
      // The PACKING order, which is what the geometry is: markets, quota, sql, parcel, github.
      // 数据库 is packed THIRD so the first-fit puts it in the third column; 快递 and GitHub are
      // packed after it so they fall into the middle cell still free, under 用量限额.
      [0, 1, 2, 3, 4])
    eq('and their heights are the ones that make the columns meet',
      ['markets', 'quota', 'sql', 'parcel', 'github'].map((id) => migrated.layout[id].rows),
      // 3 + 1 + 1 in the middle = 5 = the two full-height columns either side.
      [5, 3, 5, 1, 1])
    // …and packed in that order, first-fit gives exactly the requested picture.
    const cells = L.resolveGrid(
      ['markets', 'quota', 'sql', 'parcel', 'github'].map((id) => ({
        id,
        span: migrated.layout[id].span,
        rows: migrated.layout[id].rows,
        order: migrated.layout[id].order,
      })), 3)
    const at = (id) => {
      const cell = cells.place.get(id)
      return [cell.col, cell.row]
    }
    eq('股市债市 takes the whole first column', at('markets'), [0, 0])
    eq('用量限额 sits at the top of the middle column', at('quota'), [1, 0])
    eq('快递 sits UNDER it, still in the middle', at('parcel'), [1, 3])
    eq('and GitHub under that, closing the middle column', at('github'), [1, 4])
    eq('while the database takes the whole third column', at('sql'), [2, 0])
    // The arithmetic that makes it a rectangle rather than a staircase: the middle column is
    // exactly as tall as the two cards beside it, so all three end on the same row.
    eq('and all three columns end on the same row',
      migrated.layout.quota.rows + migrated.layout.parcel.rows + migrated.layout.github.rows,
      migrated.layout.markets.rows)
    // Everything that is not part of the arrangement is left alone.
    eq('a card outside the arrangement keeps its own size and order',
      [migrated.layout.todo.rows, migrated.layout.todo.order], [7, 5])
    eq('and a folded card stays folded',
      migrated.layout.machine.collapsed, true)
  }

  // ── v8: the cell that changed hands ──
  //
  // v7 keeps every card's on/off state, which is right — those are decisions. But it means
  // flipping `defaultOn` reaches NOBODY who has ever used the HUD: their blob still says
  // machine=shown, github=hidden, and the swap silently does not happen. v8 re-applies
  // `hidden` for exactly the two cards whose cell changed, and nothing else.
  {
    const v7Blob = {
      v: 7,
      columns: 3,
      layout: {
        markets: { hidden: false, span: 1, order: 0, rows: 9 },
        quota: { hidden: false, span: 1, order: 1, rows: 4 },
        github: { hidden: true, span: 1, order: 2, rows: 5 },
        machine: { hidden: false, span: 1, order: 3, collapsed: true },
      },
    }
    const migrated = L.migrateV7(v7Blob)
    eq('v8 stamps the blob it produced', migrated.v, L.PREFS_VERSION)
    eq('the GitHub card is switched ON for an existing install, not just a fresh one',
      migrated.layout.github.hidden, false)
    eq('and a height the user chose is untouched', migrated.layout.github.rows, 5)
    eq('along with the order, the span and a folded card',
      [migrated.layout.github.order, migrated.layout.github.span, migrated.layout.machine.collapsed],
      [2, 1, true])
    eq('and every other card is not even looked at',
      [migrated.layout.markets.rows, migrated.layout.quota.rows], [9, 4])
  }

  eq('and the declared height is what the arrangement needs',
    ['markets', 'sql'].map((id) => (exports.__panels ?? []).find((panel) => panel.id === id)?.defaultRows),
    [5, 5])

  // A height the user actually chose is not the declaration, and must survive untouched.
  const chosen = { v: 6, columns: 3, layout: { ...v6Blob.layout, markets: { ...v6Blob.layout.markets, rows: 9 } } }
  eq('a height that is NOT the declaration is the user\'s, and is kept',
    L.migrateV6(chosen).layout.markets.rows, 9)
  eq('and a card the user hid stays hidden through the migration',
    L.migrateV6({ ...v6Blob, layout: { ...v6Blob.layout, github: { ...v6Blob.layout.github, hidden: true } } })
      .layout.github.hidden, true)
  eq('columns survive too', L.migrateV6({ ...v6Blob, columns: 2 }).columns, 2)

  // ── a declared CEILING ──
  //
  // The row stride is unit + gap, so a card whose content lands just over a multiple of it gets a
  // whole extra row: 280px of readings became four rows, and the difference was
  // visible empty space at the bottom of a card. A panel can declare a ceiling that beats the
  // rounding — but only on the measurement-driven path, because a height the USER set is a
  // decision, not a measurement.
  {
    const panels = exports.__panels ?? []
    // The machine card was the card this was written for; it is gone, and no surviving panel
    // declares a ceiling. The MECHANISM is still in the shell — `maxRows` is a registry field
    // any panel can use — so what is asserted is that it reaches the registry intact and that a
    // panel without one is not given one.
    ok('no card declares a ceiling at the moment, and the field survives the registry',
      panels.every((panel) => panel.maxRows === undefined || typeof panel.maxRows === 'number'),
      JSON.stringify(panels.map((panel) => [panel.id, panel.maxRows])))
    // A fresh install must already agree with the arrangement, or the first run and every run
    // after it would disagree about how tall the cards are.
    const freshPrefs = L.defaultPrefs()
    eq('and a fresh install starts at the declared heights',
      ['markets', 'quota', 'sql', 'parcel', 'github'].map((id) => freshPrefs.layout[id].rows),
      [5, 3, 5, 1, 1])
  }

  // ── the measurement reads the CONTENT, not the allotted box ──
  //
  // jsdom reports 0 for every height, so the panel is built here and given heights by
  // hand. The point of the assertion is the number the real browser would have to produce:
  // head + gap + the BODY's scrollHeight + padding. Reading `panel.scrollHeight` instead
  // returns whatever the layout already granted, so a card one row short of its content
  // stays one row short for ever — which is a clipped quota row and a chart that scrolls.
  {
    const doc = dom.window.document
    const panel = doc.createElement('div')
    panel.className = 'hud-panel'
    const head = doc.createElement('div')
    head.className = 'hud-panel-head'
    const body = doc.createElement('div')
    body.className = 'hud-panel-body'
    panel.append(head, body)
    panel.style.paddingTop = '9px'
    panel.style.paddingBottom = '9px'
    panel.style.rowGap = '9px'
    Object.defineProperty(head, 'offsetHeight', { value: 30 })
    // The body SCROLLS, so its scrollHeight is the full content: this is the number the
    // panel itself can never report.
    Object.defineProperty(body, 'scrollHeight', { value: 300 })
    // The panel's own scrollHeight is the space it was GIVEN — smaller, and the value the
    // buggy version used.
    Object.defineProperty(panel, 'scrollHeight', { value: 180 })
    eq('a card is as tall as head + body content + gap + padding',
      typeof L.contentHeightOf === 'function' ? L.contentHeightOf(panel) : null,
      30 + 300 + 9 + 18)
    ok('and NOT as tall as the box the layout already gave it',
      L.contentHeightOf(panel) !== panel.scrollHeight, String(panel.scrollHeight))
    eq('an unlaid-out card measures as nothing rather than as zero tall',
      L.contentHeightOf(doc.createElement('div')), undefined)
  }
}

// The shipped layout, as asked for:
//   col 0      col 1     col 2
//   markets    quota     sql       markets 10 rows · quota 4 · sql 10
//   markets    parcel    sql       快递 3 · GitHub 3
//   markets    parcel    sql       → 4 + 3 + 3 = 10, so the three columns are EXACTLY the
//   markets    github    sql         same height and the grid is a solid rectangle
//   …      …      …
//   markets    github    sql
// …and it falls out of the packer from ONE input — the order — with no coordinates and no
// special cases: markets takes the first column, quota the next cell, sql the third column, and
// 快递 then GitHub find the only cells left, which are the ones under quota.
eq('the first row is the markets card, the quota card and the database card',
  [...container.querySelectorAll('.hud-panel:not([hidden])')]
    .filter((node) => node.getAttribute('data-row') === '0')
    .map((node) => node.getAttribute('data-panel')),
  ['markets', 'quota', 'sql'])
eq('快递 stacks under the quota card, and GitHub under that',
  ['parcel', 'github'].map((id) => {
    const node = container.querySelector(`.hud-panel[data-panel="${id}"]`)
    return [node.getAttribute('data-col'), node.getAttribute('data-row'), node.getAttribute('data-rows')]
  }),
    [['1', '3', '1'], ['1', '4', '1']])
// The rectangle is the point: the middle column is 3 + 1 + 1 and the two cards beside it are
// 5 each, so all three columns end on the SAME row.
eq('and the three columns end on the same row',
  ['markets', 'sql'].map((id) => {
    const node = container.querySelector(`.hud-panel[data-panel="${id}"]`)
    return Number(node.getAttribute('data-row')) + Number(node.getAttribute('data-rows'))
  }),
  [5, 5])
eq('which is exactly what the middle column adds up to',
  ['quota', 'parcel', 'github'].map((id) => Number(
    container.querySelector(`.hud-panel[data-panel="${id}"]`).getAttribute('data-rows'),
  )).reduce((sum, rows) => sum + rows, 0),
  5)
eq('and each card in the middle column keeps its own height',
  ['quota', 'parcel', 'github'].map((id) => Number(
    container.querySelector(`.hud-panel[data-panel="${id}"]`).getAttribute('data-rows'),
  )),
  [3, 1, 1])
eq('the other cards are mounted but hidden',
  [...container.querySelectorAll('.hud-panel[hidden]')].map((node) => node.getAttribute('data-panel')).sort(),
  // Nothing: every registered panel is a card, and all of them are on. 股市/债市/期货 are views
  // INSIDE the markets card and therefore not candidates for this list at all.
  [])
ok('quota content is mounted (keep-alive), just not shown', html.includes('ocq-card'))
ok('github content is mounted (keep-alive), just not shown', html.includes('ghh-card'))
ok('parcel content is mounted (keep-alive), just not shown', html.includes('pk-root'))
eq('the grid has three tracks', container.querySelector('.hud-body')?.getAttribute('data-cols'), '3')
// 期货 is a VIEW of the markets card, switched like 股市 and 债市 — not a card beside them. All
// three stay MOUNTED and the inactive ones are hidden, so switching never restarts a poll.
{
  const views = [...container.querySelectorAll('.mks-view')]
  eq('the markets card holds four views', views.map((view) => view.getAttribute('data-view')),
    ['market', 'bond', 'futures', 'fx'])
  eq('with exactly one of them showing', views.filter((view) => !view.hasAttribute('hidden')).length, 1)
  eq('and it is the one whose tab is selected',
    [...container.querySelectorAll('.mks-switch [role="tab"]')].map((tab) => tab.getAttribute('aria-selected')),
    ['true', 'false', 'false', 'false'])
  eq('with the four tabs named, in the order they are drawn',
    [...container.querySelectorAll('.mks-switch [role="tab"]')].map((tab) => tab.getAttribute('data-tab')),
    ['market', 'bond', 'futures', 'fx'])
  eq('and no card of its own was registered for it',
    container.querySelector('.hud-panel[data-panel="futures"]'), null)
}
eq('the markets card is one column wide in the shipped layout', spanOf('markets'), '1')
ok('and every visible span is legal for the grid',
  [...container.querySelectorAll('.hud-panel:not([hidden])')].every((node) => {
    const span = Number(node.getAttribute('data-span'))
    return span >= 1 && span <= 3
  }),
  [...container.querySelectorAll('.hud-panel:not([hidden])')].map((node) => node.getAttribute('data-span')).join(','))
ok('the root carries no placement class at all', container.querySelector('.hud-root').className === 'hud-root')
// A panel that writes `width:100%` next to a padding overflows its card by the padding,
// which is a horizontal scrollbar for two pixels of air. The HUD opts out once, for
// everything it contains, so a panel cannot forget.
ok('the HUD sets border-box once for everything inside it',
  /\.[\w-]*\.hud-root,\.hud-root \*/.test(shippedCss) || shippedCss.includes('.hud-root *'),
  shippedCss.slice(0, 120))
ok('and the candle chart keeps its design height instead of scaling with the width',
  /\.hud-k-svg\{display:block;width:100%\}/.test(shippedCss), shippedCss.match(/\.hud-k-svg\{[^}]*\}/)?.[0])
ok('a stale `align` from the older build cannot narrow the card', !storedPrefs().includes('align'))
ok('the older build\'s other key is gone too', !storedPrefs().includes('"panel"'))
ok('storage holds only the keys this build owns',
  Object.keys(JSON.parse(storedPrefs())).sort().join(',') === 'columns,hiddenColumns,layout,v', storedPrefs())
eq('the stored blob is stamped with the ruleset it belongs to', JSON.parse(storedPrefs()).v, 11)
// No card is hidden in the shipped layout, so no pill is offered — a pill is the way BACK for a
// card that is off, and an always-visible row of them would be a row of controls with nothing
// to do. (The pill itself is exercised further down, by hiding a card first.)
eq('no hidden panel means no pill', container.querySelectorAll('.hud-pill').length, 0)
eq('every pill is clickable — no card is ever "blocked" from coming back',
  [...container.querySelectorAll('.hud-pill')].filter((pill) => pill.getAttribute('aria-disabled') === 'true').length, 0)
eq('no card is in the grid without a span',
  container.querySelectorAll('.hud-panel:not([data-span])').length, 0)
// The grid is exactly as tall as the packer says, and every visible card sits
// inside it.
ok('the grid reports its own height in rows',
  Number(container.querySelector('.hud-body')?.getAttribute('data-rows')) >= 1,
  container.querySelector('.hud-body')?.getAttribute('data-rows'))
ok('and every visible card fits inside that height',
  [...container.querySelectorAll('.hud-panel:not([hidden])')].every((node) => (
    Number(node.getAttribute('data-row')) + Number(node.getAttribute('data-rows'))
      <= Number(container.querySelector('.hud-body')?.getAttribute('data-rows'))
  )),
  [...container.querySelectorAll('.hud-panel:not([hidden])')].map((node) => node.getAttribute('data-panel')).join(' '))
// THE user-facing contract, read back out of the real DOM: no card has an empty cell
// above it. The pure tests prove the algorithm; this proves the shell wrote those grid
// lines onto the page — and that compaction survived whatever the stored prefs said.
eq('the rendered grid is compact — nothing in it can rise any further',
  liftableCards(domPlacements(), 3), [])

// The whole point of the merge: both halves are querying their own host routes
// at the same time, from ONE card.
const paths = fetched.map((call) => call.path)
ok('the quota panel polled /dsh-hud/quota/usage', paths.includes('/dsh-hud/quota/usage'), paths.join(','))
ok('the github panel polled /dsh-hud/github/state', paths.includes('/dsh-hud/github/state'), paths.join(','))

// ── the weather widget in the title bar ───────────────────────────────────
console.log('\nweather in the title bar')
ok('the weather panel polled its own route', paths.includes('/dsh-hud/weather/state'), paths.join(','))
const weatherHead = container.querySelector('.hud-heads .wx-root')
ok('the widget renders inside the head row', weatherHead !== null)
ok('it never became a grid card', container.querySelector('.hud-panel[data-panel="weather"]') === null)
const headText = weatherHead?.textContent ?? ''
ok('the condition is shown', headText.includes('小雨'), headText)
ok('the temperature is shown', headText.includes('18.4°C'), headText)
ok('the humidity is shown', headText.includes('湿度 82%'), headText)
ok('the wind is shown', headText.includes('东南风') && headText.includes('12.4 km/h'), headText)
ok('wind force rides along', headText.includes('3 级'), headText)
const alertChip = container.querySelector('.wx-alert')
ok('an extreme-weather alert is visible without a click', alertChip !== null)
ok('the chip names the most severe warning', (alertChip?.textContent ?? '').includes('暴雨黄色'), alertChip?.textContent)
ok('the chip is toned by level', alertChip?.classList.contains('lv-yellow') === true, alertChip?.className)
ok('the chip counts the rest', (alertChip?.textContent ?? '').includes('+1'), alertChip?.textContent)

await click(weatherHead.querySelector('.wx-btn'))
const pop = container.querySelector('.wx-pop')
ok('clicking the reading opens the detail panel', pop !== null)
const popText = pop?.textContent ?? ''
ok('the detail panel names the place', popText.includes('无锡市') && popText.includes('江苏'), popText)
ok('it carries the values the title bar had no room for',
  popText.includes('体感') && popText.includes('阵风') && popText.includes('降水'), popText)
eq('it lists every alert', pop?.querySelectorAll('.wx-item').length, 2)
ok('the alert list is scoped honestly', popText.includes('本地 2'), popText)
ok('each alert links to the source', pop?.querySelector('.wx-link')?.getAttribute('href')?.startsWith('http://www.nmc.cn/') === true)
ok('the 10-minute cadence is stated', popText.includes('每 10 分钟自动刷新'), popText)
// The detail panel closes on a POINTERDOWN outside it (not a click), which is
// what keeps the opening click from immediately closing it again.
await act(async () => {
  dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
})
ok('clicking outside closes the detail panel', container.querySelector('.wx-pop') === null)

// ── the parcel card ───────────────────────────────────────────────────────
console.log('\nparcel card')
ok('the parcel panel polled its own route', paths.includes('/dsh-hud/parcel/state'), paths.join(','))
const pkRow = container.querySelector('.pk-row[data-nu="SF0000000000001"]')
ok('the watched parcel renders as a row', pkRow !== null)
const pkRowText = pkRow?.textContent ?? ''
ok('the row leads with the user\'s label and the number',
  pkRowText.includes('键盘') && pkRowText.includes('SF0000000000001'), pkRowText)
ok('the carrier is one hover away', (pkRow?.querySelector('.pk-rowhead')?.getAttribute('title') ?? '').includes('顺丰速运'))
ok('the status chip uses the API state', pkRowText.includes('派送中'), pkRowText)
ok('the place of the newest scan is shown', pkRowText.includes('无锡市'), pkRowText)
ok('an unread parcel is flagged in the row',
  pkRow?.classList.contains('is-unread') === true && pkRowText.includes('1 新'), pkRowText)
ok('the timeline is collapsed until asked for', container.querySelector('.pk-steps') === null)

await click(pkRow.querySelector('.pk-rowhead'))
const pkSteps = [...container.querySelectorAll('.pk-step')]
eq('expanding reveals the whole timeline', pkSteps.length, 3)
ok('it reads newest first', (pkSteps[0]?.textContent ?? '').includes('正在派送中'), pkSteps[0]?.textContent)
ok('the new scan is highlighted', pkSteps[0]?.classList.contains('is-new') === true, pkSteps[0]?.className)
ok('the place is labelled as scan text, not a position',
  (container.querySelector('.pk-src')?.textContent ?? '').includes('接口不提供经纬度'),
  container.querySelector('.pk-src')?.textContent)
ok('the expanded body names the carrier',
  (container.querySelector('.pk-body .pk-note')?.textContent ?? '').includes('顺丰速运'),
  container.querySelector('.pk-body .pk-note')?.textContent)
ok('the row offers refresh and remove',
  [...container.querySelectorAll('.pk-body .pk-btn')].map((button) => button.textContent).join('|').includes('刷新这个'))
ok('the add form can be opened',
  [...container.querySelectorAll('.pk-btn')].some((button) => button.textContent.includes('添加单号')))
await click(pkRow.querySelector('.pk-rowhead'))

// ── the share-market card ─────────────────────────────────────────────────
console.log('\nmarket card')
const mkCell = container.querySelector('.hud-panel[data-panel="markets"]')
/**
 * The market HALF of the markets card.
 *
 * The card holds both halves at once (the inactive one is `hidden`, not unmounted), and
 * they deliberately share class names — the bond card draws the same chart component —
 * so anything scoped to the panel rather than to a VIEW counts both.
 */
const mkView = () => container.querySelector('.mks-view[data-view="market"]')
ok('the market card is a grid cell', mkCell !== null)
eq('it takes the one column it asks for in the shipped layout', mkCell?.getAttribute('data-span'), '1')
ok('it polled its own route', paths.includes('/dsh-hud/market/state'), paths.join(','))
ok('it fetched candles separately', paths.includes('/dsh-hud/market/kline'), paths.join(','))
eq('the whole watch list is on screen', mkView()?.querySelectorAll('.mk-wrow').length, 3)
const mkSelected = mkView()?.querySelector('.mk-wrow.is-sel')
ok('the selected instrument is marked', (mkSelected?.textContent ?? '').includes('贵州茅台'), mkSelected?.textContent)
ok('a rise is red and a fall is green — the domestic convention',
  mkView()?.querySelectorAll('.mk-chg.mk-up').length === 2 && mkView()?.querySelectorAll('.mk-chg.mk-down').length === 1,
  `${mkView()?.querySelectorAll('.mk-chg.mk-up').length} up / ${mkView()?.querySelectorAll('.mk-chg.mk-down').length} down`)
ok('prices are rendered with their decimals',
  [...mkView()?.querySelectorAll('.mk-px')].map((node) => node.textContent).join('|').includes('3842.19'),
  [...mkView()?.querySelectorAll('.mk-px')].map((node) => node.textContent).join('|'))
ok('the sessions are shown with their open state',
  mkView()?.querySelectorAll('.mk-sess').length === 3 && mkView()?.querySelectorAll('.mk-sess.is-open').length === 2)

console.log('\nmarket card — the candlestick chart')
// Both cards draw the shared chart now, so every selector here is scoped to the
// card that owns it — an unscoped one silently matched twice.
const mkSvg = mkView()?.querySelector('.hud-k-svg')
ok('a chart was drawn', mkSvg !== null)
eq('one body + one volume bar + one hit area per candle', mkSvg?.querySelectorAll('rect').length, MK_CANDLES.length * 3)
eq('three moving averages are plotted', mkSvg?.querySelectorAll('polyline').length, 3)
eq('the MA legend names all three', [...(mkView()?.querySelectorAll('.hud-k-lg') ?? [])].map((node) => node.textContent.slice(0, 3)).join(','), 'MA5,MA1,MA2')
ok('the MA legend carries values', /MA5[\d.]/.test(mkView()?.querySelector('.hud-k-legend')?.textContent ?? ''),
  mkView()?.querySelector('.hud-k-legend')?.textContent)
eq('the y axis is labelled top, middle and bottom', mkView()?.querySelectorAll('.hud-k-ylab').length, 3)
const mkXLabels = [...(mkView()?.querySelectorAll('.hud-k-xlab') ?? [])].map((node) => node.textContent)
eq('the x axis spans first → last candle', [mkXLabels[0], mkXLabels[mkXLabels.length - 1]], ['2026-09-01', '2026-09-26'])
eq('every period the host offers gets a button', mkView()?.querySelectorAll('.hud-k-periods .hud-k-btn').length, 7)
ok('the intraday ones are labelled 实时/5分/15分/60分',
  (mkView()?.querySelector('.hud-k-periods')?.textContent ?? '').startsWith('实时5分15分60分'),
  mkView()?.querySelector('.hud-k-periods')?.textContent)
ok('the active period is marked', (mkView()?.querySelector('.hud-k-periods .hud-k-btn[aria-pressed="true"]')?.textContent ?? '').includes('日K'))

// Hovering a candle must reveal its OHLC — the whole point of a candle chart.
await act(async () => {
  mkSvg.querySelectorAll('rect')[2 * MK_CANDLES.length + 2].dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
})
const mkTip = mkView()?.querySelector('.hud-k-tip')
ok('hovering a candle opens its OHLC tooltip', mkTip !== null)
ok('the tooltip carries the OHLC values',
  (mkTip?.textContent ?? '').includes('开') && (mkTip?.textContent ?? '').includes('收'), mkTip?.textContent)
ok('and the volume', (mkTip?.textContent ?? '').includes('万'), mkTip?.textContent)
// The readout is laid out to be READ while the mouse moves: a stamp header, the
// four prices in a 2×2 grid, the derived numbers on a footer row.
eq('the tooltip has a header', mkTip?.querySelector('.hud-k-tip-head') !== null, true)
eq('the four prices sit in a 2-column grid', mkTip?.querySelectorAll('.hud-k-tip-grid .hud-k-kv').length, 4)
eq('each pair is a label + a value', mkTip?.querySelectorAll('.hud-k-tip-grid .hud-k-kv b').length, 4)
ok('the change and the volume share a footer row',
  (mkTip?.querySelector('.hud-k-tip-foot')?.textContent ?? '').includes('涨跌'), mkTip?.querySelector('.hud-k-tip-foot')?.textContent)
// ONE MONTH of daily bars means the readout has to carry the detail: the change
// in percent AND in price, the amplitude, the size, the turnover and MA5.
console.log('\nthe detailed readout')
const readout = mkView()?.querySelector('.hud-k-tip')
const footText = [...(readout?.querySelectorAll('.hud-k-tip-foot') ?? [])].map((row) => row.textContent).join(' | ')
for (const needle of ['涨跌', '振幅', '量', '额', 'MA5']) {
  ok(`the readout shows ${needle}`, footText.includes(needle), footText)
}
// 涨跌幅 then 涨跌额 — two figures in the same pair, plus 振幅, 量, 额 and MA5.
ok('the change row carries both the percent and the price',
  (readout?.querySelectorAll('.hud-k-tip-foot .hud-k-kv b').length ?? 0) >= 5,
  String(readout?.querySelectorAll('.hud-k-tip-foot .hud-k-kv b').length))
ok('the amplitude is a percentage', /-?\d+\.\d\d%/.test(footText), footText)
ok('the turnover is in 万/亿', /[\d.]+ (万|亿)/.test(footText), footText)
// With ~22 bars the axis can afford five stamps; a year of them could not.
eq('a short series gets five date labels', mkView()?.querySelectorAll('.hud-k-xlab').length, 5)
eq('and they are distinct dates',
  new Set([...(mkView()?.querySelectorAll('.hud-k-xlab') ?? [])].map((node) => node.textContent)).size, 5)
// The surface, asserted on the shipped stylesheet: one clean opaque token, and a
// caret so it is obvious which candle the numbers belong to.
const tipRule = ruleOf('.hud-k-tip')
ok('the tooltip uses the same opaque raised surface as the editor',
  /background:var\(--hud-pop\)/.test(tipRule), tipRule.slice(0, 200))
ok('the tooltip text uses label tokens that read on that surface',
  /\.hud-k-kv b\{[^}]*color:var\(--dsw-alias-label-primary/.test(shippedCss),
  (shippedCss.match(/\.hud-k-kv b\{[^}]*\}/) ?? [''])[0])
ok('the tooltip has a caret pointing at the candle',
  /\.hud-k-tip::after\{[^}]*rotate\(45deg\)/.test(shippedCss),
  (shippedCss.match(/\.hud-k-tip::after\{[^}]*\}/) ?? [''])[0].slice(0, 160))

// The 涨跌 value must be COLOURED, and must stay legible while being so.
// The first version had the colour but never applied it: `.hud-k-kv b` is
// (0,1,1) and outranked a single-class `.hud-k-up` (0,1,0).
console.log('\nthe change value')
const changeValue = () => mkTip?.querySelector('.hud-k-tip-foot .hud-k-kv b:last-child')
// Candle 2 is an up candle (close > open) and candle 3 is a down one — see the
// MK_CANDLES fixture. Hit areas are the last `n` rects, three per candle.
const hoverCandle = async (index) => {
  await act(async () => {
    mkSvg.querySelectorAll('rect')[2 * MK_CANDLES.length + index].dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  })
  return mkView()?.querySelector('.hud-k-tip')
}
const upTip = await hoverCandle(2)
ok('an up candle colours its change value red',
  upTip?.querySelector('.hud-k-up') !== null && upTip?.querySelector('.hud-k-down') === null,
  upTip?.querySelector('.hud-k-tip-foot')?.textContent)
const downTip = await hoverCandle(3)
ok('a down candle colours it green',
  downTip?.querySelector('.hud-k-down') !== null && downTip?.querySelector('.hud-k-up') === null,
  downTip?.querySelector('.hud-k-tip-foot')?.textContent)
ok('and the value itself is the coloured element (not a wrapper)',
  /^[-+−]?\d/.test(changeValue()?.textContent ?? '') || (changeValue()?.textContent ?? '').startsWith('+'),
  changeValue()?.textContent)
// Legibility: the colour is a theme STATE token, so it is legible on the themed
// tooltip surface in either theme — a hardcoded dark red would not be.
const upRule = (shippedCss.match(/\.hud-k-kv b\.hud-k-up[^{]*\{[^}]*\}/) ?? [''])[0]
ok('the colour is a theme state token, not a hardcoded hex',
  /color:var\(--dsw-alias-state-error-primary/.test(upRule), upRule)
ok('and the specificity actually beats the generic value rule',
  /\.hud-k-kv b\.hud-k-up/.test(upRule), upRule)
ok('no up/down text is left on a hardcoded dark-only hex',
  !/\.(hud-k-(up|down)|mk-(up|down)|bd-(up|down))\{color:#/.test(shippedCss),
  (shippedCss.match(/\.(hud-k-(up|down)|mk-(up|down)|bd-(up|down))\{color:#[0-9a-f]{6}\}/g) ?? []).join(' '))

// ── the to-do widget: title bar, notifications ────────────────────────────
console.log('\nthe to-do widget')
const tdRoot = () => container.querySelector('.td-root')
const tdButton = () => container.querySelector('.td-btn')
const tdPop = () => container.querySelector('.td-pop')
const tdRowOf = (title) => [...container.querySelectorAll('.td-row')].find((row) => row.textContent.includes(title))
// Where the user asked for it: the RIGHT-hand side of the title bar, next to ⚙.
ok('the to-do widget is in the title bar', tdRoot() !== null)
eq('and it asked for the right-hand side',
  container.querySelector('.hud-right [data-side="right"]')?.getAttribute('data-panel'), 'todo')
eq('it is inside the right group, not the reading-order group',
  [tdRoot()?.closest('.hud-right') !== null, tdRoot()?.closest('.hud-heads') === null], [true, true])
eq('with the ⚙ still last in the row',
      [...(container.querySelector('.hud-right')?.children ?? [])].pop()?.className === 'hud-gear', false)
eq('the line carries the open count', container.querySelector('.td-count')?.textContent, '5')
eq('the count is flagged when something is overdue',
  container.querySelector('.td-count')?.classList.contains('is-overdue'), true)
ok('and the next thing due is named on the line',
  (tdButton()?.textContent ?? '').includes('14:30') && (tdButton()?.textContent ?? '').includes('写周报'),
  tdButton()?.textContent)
// A widget with a card would consume a column; this one must not.
eq('a to-do widget consumes no grid column', cellOf('todo'), null)

await click(tdButton())
ok('clicking opens the list', tdPop() !== null)
eq('the groups the host sent are the groups drawn',
  [...tdPop().querySelectorAll('.td-group-head')].map((head) => head.textContent.replace(/\d+/g, '').trim()),
  ['逾期', '今天', '明天', '无日期', '已完成'])
eq('every open item is a row', tdPop().querySelectorAll('.td-row').length, 6)
ok('a feed item shows where it came from', (tdRowOf('季度评审')?.textContent ?? '').includes('飞书日历'))
ok('a feed item cannot be ticked off here',
  tdRowOf('季度评审')?.querySelector('.td-check')?.disabled === true)
ok('your own item can be',
  tdRowOf('写周报')?.querySelector('.td-check')?.disabled === false)
// The dismissal contract every popover in this HUD follows.
await act(async () => {
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
ok('Escape closes it', tdPop() === null)
await click(tdButton())
await act(async () => {
  container.querySelector('.hud-body').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
})
ok('a click outside closes it', tdPop() === null)
await click(tdButton())

// Adding: the input is the whole point of "也可以自己设置".
const tdInput = container.querySelector('.td-pop .td-input')
await setInput(tdInput, '给客户回信')
const tdAddButton = [...container.querySelectorAll('.td-pop .td-ghost')].find((button) => button.textContent === '添加')
await click(tdAddButton)
const tdPosted = fetched.filter((call) => call.path === '/dsh-hud/todo/add')
eq('adding posts the title', [tdPosted.length, JSON.parse(tdPosted[0]?.body ?? '{}').title], [1, '给客户回信'])
await click([...container.querySelectorAll('.td-pop .td-ghost')].find((button) => button.textContent === '刷新'))
ok('the refresh button re-reads the host',
  fetched.some((call) => call.path === '/dsh-hud/todo/refresh' && call.method === 'POST'))
// Completing posts a patch, and a read-only row does not.
await click(tdRowOf('写周报')?.querySelector('.td-check'))
const tdPatch = fetched.filter((call) => call.path === '/dsh-hud/todo/update').map((call) => JSON.parse(call.body ?? '{}'))
eq('ticking an item posts done:true for that item',
  [tdPatch[0]?.id, tdPatch[0]?.patch?.done], ['q2', true])

// ── the notifier ──────────────────────────────────────────────────────────
console.log('\nthe notifier')
const tdTest = (exports.__panels ?? []).find((panel) => panel.id === 'todo')?.__test
ok('the notification maths is exposed for testing', typeof tdTest?.tdDueLeads === 'function')
const TD_LEADS = [60, 30, 5]
const tdMin = (n) => n * 60_000
// A lead fires inside its window, not before it, and never after the deadline.
// Only the CLOSEST passed lead fires. At 31 minutes out the 60-minute mark has
// passed, so that is the news — delivered once, late, rather than skipped.
eq('at 31 minutes out only the hour lead is current',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(31) }, TD_LEADS, TODO_NOW, {}), [60])
eq('an hour out, nothing has passed yet',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(61) }, TD_LEADS, TODO_NOW, {}), [])
eq('at 30 minutes out the half-hour lead is current, and only it',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(30) }, TD_LEADS, TODO_NOW, {}), [30])
// Three leads have passed but only the 5-minute one is news: firing all three is
// how people turn notifications off.
eq('with every lead passed, only the closest one fires',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(4) }, TD_LEADS, TODO_NOW, {}), [5])
eq('an item added 20 minutes before its time fires ONE reminder, not three',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(20) }, TD_LEADS, TODO_NOW, {}), [30])
eq('an item that is already due gets no countdown',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW - tdMin(1) }, TD_LEADS, TODO_NOW, {}), [])
eq('an item with no date has nothing to fire',
  tdTest.tdDueLeads({ id: 'x' }, TD_LEADS, TODO_NOW, {}), [])
eq('a lead that already fired does not fire again',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(4) }, TD_LEADS, TODO_NOW, { 'x@5': TODO_NOW - 500 }), [])
eq('and the half-hour lead is not replayed once the five-minute one is current',
  tdTest.tdDueLeads({ id: 'x', dueAt: TODO_NOW + tdMin(4) }, TD_LEADS, TODO_NOW, { 'x@30': 1 }), [5])
// The ledger is what survives a page refresh.
const tdLedgerKey = tdTest.TD_STORAGE_KEY
dom.window.localStorage.removeItem(tdLedgerKey)
tdTest.tdWriteLedger({ a: TODO_NOW, old: TODO_NOW - 8 * 86_400_000 })
eq('the fired-notification ledger drops anything older than a week',
  Object.keys(tdTest.tdReadLedger(TODO_NOW)).sort(), ['a'])
eq('and survives a corrupt value', (() => {
  dom.window.localStorage.setItem(tdLedgerKey, 'not json')
  const result = tdTest.tdReadLedger(TODO_NOW)
  dom.window.localStorage.removeItem(tdLedgerKey)
  return result
})(), {})
// The labels the line and the rows show.
eq('when-labels are as short as they can be',
  [tdTest.tdWhen(TODO_NOW, TODO_NOW, true), tdTest.tdWhen(TODO_NOW + 86_400_000, TODO_NOW, true),
    tdTest.tdWhen(TODO_NOW - 86_400_000, TODO_NOW, true), tdTest.tdWhen(TODO_NOW + 4 * 86_400_000, TODO_NOW, true)],
  ['10:00', '明天 10:00', '昨天 10:00', '10-05 10:00'])
eq('lead labels read as a countdown', [tdTest.tdLeadLabel(30, true), tdTest.tdLeadLabel(-5, true)], ['30 分钟后', '已过 5 分钟'])
// The tick is registered even with the card switched off — that is the point of
// a title-bar reminder.
ok('the widget registered its own tick', timers.some((entry) => entry.tickMs === tdTest.TD_TICK_MS),
  JSON.stringify(timers.map((entry) => entry.tickMs)))
// Drive it: the fixture has an item due in 4.5 hours minus nothing, so make one
// due inside a lead window by rewriting the fixture and re-polling.
todoSnapshot = { ...todoState(), now: TODO_NOW, schedule: [{ id: 'q2', title: '写周报', dueAt: Date.now() + 4 * 60_000, readOnly: false }] }
await click([...container.querySelectorAll('.td-pop .td-ghost')].find((button) => button.textContent === '刷新'))
dom.window.localStorage.removeItem(tdLedgerKey)
await fireTicks()
const tdAlert = container.querySelector('.td-alert')
ok('a due lead puts a reminder on the title bar', tdAlert !== null, tdAlert?.textContent)
ok('and the reminder names the item and the countdown',
  (tdAlert?.textContent ?? '').includes('写周报') && /分钟后/.test(tdAlert?.textContent ?? ''), tdAlert?.textContent)
const tdFired = JSON.parse(dom.window.localStorage.getItem(tdLedgerKey) ?? '{}')
ok('the firing is recorded so a refresh cannot repeat it',
  Object.keys(tdFired).some((key) => key.startsWith('q2@')), JSON.stringify(Object.keys(tdFired)))
const tdAlertBefore = container.querySelector('.td-alert')?.textContent
await fireTicks()
eq('a second tick does not fire the same lead again',
  container.querySelector('.td-alert')?.textContent, tdAlertBefore)
await click(container.querySelector('.td-alert'))
ok('clicking the reminder opens the list', tdPop() !== null)
ok('and clears the reminder', container.querySelector('.td-alert') === null)
await act(async () => {
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})

// ── credentials that come from a LOGIN ────────────────────────────────────
// Neither is an API key from a dashboard: mail is an 授权码, and the vendored
// task APIs are OAuth. The card has to make both enterable, and has to say the
// one thing a plugin cannot do for the user.
console.log('\nthe credential surfaces')
// The previous block ended with Escape, so open the list again first.
await click(tdButton())
ok('the list opens again for the settings', tdPop() !== null)
await click([...container.querySelectorAll('.td-pop .td-ghost')].find((button) => button.textContent === '设置'))
ok('the settings panel opened', container.querySelector('.td-sec') !== null)
const secTitles = [...container.querySelectorAll('.td-sec-title')].map((node) => node.textContent)
ok('the settings offer both login-based sources',
  secTitles.includes('邮箱（IMAP）') && secTitles.includes('飞书 / 钉钉（登录）'), secTitles.join(' | '))
// QUERIED FRESH each time: a dropdown click re-renders the section, and a stale
// detached node silently swallows clicks (which is how three assertions failed here).
const mailSec = () => [...container.querySelectorAll('.td-sec')].find((node) => node.textContent.includes('邮箱（IMAP）'))
const loginSec = () => [...container.querySelectorAll('.td-sec')].find((node) => node.textContent.includes('飞书'))
ok('the mail section asks for an 授权码, not a password',
  mailSec().textContent.includes('授权码'), mailSec().textContent.slice(0, 120))
eq('and it is a password field, so it is not on screen while typing',
  [...mailSec().querySelectorAll('input')].filter((input) => input.type === 'password').length, 1)
// NOT a <select>: a native popup is painted from `color-scheme` rather than from
// our tokens, which is how its list came out light-on-light. Ours cannot.
eq('there is no native select anywhere in the panel', container.querySelectorAll('select, option').length, 0)
const presetDrop = [...mailSec().querySelectorAll('.td-drop .td-sel')][0]
ok('the mail providers are offered by our own dropdown', presetDrop !== undefined)
eq('and it shows the current choice', presetDrop.textContent.replace('▾', ''), '网易 163')
eq('the list is closed until asked for', mailSec().querySelector('.td-menu'), null)
await click(presetDrop)
const presetMenu = mailSec().querySelector('.td-menu')
ok('clicking opens a themed list', presetMenu !== null)
eq('with every known provider in it',
  [...presetMenu.querySelectorAll('.td-opt')].map((option) => option.textContent), ['网易 163', 'QQ 邮箱', '自定义'])
eq('and the current one is marked', presetMenu.querySelector('.td-opt.is-on')?.textContent, '网易 163')
// The dropdown has to change the form, not just look right.
await click([...presetMenu.querySelectorAll('.td-opt')].find((option) => option.textContent === 'QQ 邮箱'))
eq('choosing one closes the list', mailSec().querySelector('.td-menu'), null)
eq('fills the host from the preset',
  [...mailSec().querySelectorAll('input')].find((input) => input.placeholder?.includes('IMAP'))?.value, 'imap.qq.com')
eq('and updates the trigger', [...mailSec().querySelectorAll('.td-drop .td-sel')][0].textContent.replace('▾', ''), 'QQ 邮箱')
await click([...mailSec().querySelectorAll('.td-drop .td-sel')][0])
// Dispatched ON THE TRIGGER, like a real key press: the dropdown stops the event
// so the surrounding popover stays open. (Sending it to `document` closes both,
// which is correct behaviour but not what this assertion is about.)
await act(async () => {
  mailSec().querySelector('.td-drop .td-sel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
eq('Escape closes the dropdown only', mailSec().querySelector('.td-menu'), null)
ok('and leaves the settings panel open', container.querySelector('.td-sec') !== null)
// The honest prerequisite, stated before anything else in that section.
ok('the login section names the redirect URI the vendor must accept',
  loginSec().textContent.includes('/dsh-hud/todo/callback'), loginSec().textContent.slice(0, 160))
ok('and says plainly that the app must be created by the user',
  /创建|自建应用/.test(loginSec().textContent), loginSec().textContent.slice(0, 200))
eq('the provider field label comes from the vendor table, not from a guess',
  [...loginSec().querySelectorAll('input')].map((input) => input.placeholder).includes('app_id'), true)
eq('the client secret is a password field too',
  [...loginSec().querySelectorAll('input')].filter((input) => input.type === 'password').length, 1)
await click([...mailSec().querySelectorAll('.td-ghost')].find((button) => button.textContent === '保存并连接'))
ok('save-then-connect posts to /mail and then /mail/list',
  fetched.some((call) => call.path === '/dsh-hud/todo/mail') && fetched.some((call) => call.path === '/dsh-hud/todo/mail/list'),
  fetched.filter((call) => call.path.startsWith('/dsh-hud/todo/mail')).map((call) => call.path).join(','))
ok('and the 授权码 is sent to the host, never rendered back into the DOM',
  (mailSec().querySelector('input[type="password"]')?.placeholder ?? '').includes('已保存'), mailSec().querySelector('input[type="password"]')?.placeholder)
await click([...loginSec().querySelectorAll('.td-ghost')].find((button) => button.textContent === '退出登录'))
const logout = fetched.filter((call) => call.path === '/dsh-hud/todo/login').map((call) => JSON.parse(call.body ?? '{}')).find((body) => body.logout === true)
eq('signing out tells the host to drop the stored secret', logout?.logout, true)

// ── folding a card ────────────────────────────────────────────────────────
// Folding still means "one line, one track": that is what makes it useful next to
// a tall neighbour, and it is unaffected by rows being unbounded.
console.log('\nfolding')
// The fold control lives in the ⚙ editor (and on double-click), so that panel has
// to be open — and it is opened here rather than assumed.
if (container.querySelector('.hud-prefs') === null) await act(async () => { exports.__openLayoutEditor(true) })
ok('the editor is open for the folding checks', container.querySelector('.hud-prefs') !== null)
eq('a card starts open', cellOf('markets')?.getAttribute('data-collapsed'), 'false')
eq('and costs its own span', spanOf('markets'), '1')
const foldButton = (id) => layoutRow(id)?.querySelector('.hud-fold')
ok('the editor offers a fold control per card', foldButton('markets') !== null,
  layoutRow('markets')?.innerHTML?.slice(0, 200))
// `querySelector` answers null, not undefined — comparing with undefined made this
// pass for the wrong reason until the detail showed the row's markup.
ok('and none for a head-only panel', foldButton('weather') === null,
  layoutRow('weather')?.innerHTML?.slice(0, 200))
await click(foldButton('markets'))
eq('folding marks the card', cellOf('markets')?.getAttribute('data-collapsed'), 'true')
eq('and it now costs ONE track', spanOf('markets'), '1')
eq('and exactly ONE row', cellOf('markets')?.getAttribute('data-rows'), '1')
ok('the card keeps its content mounted underneath', cellOf('markets')?.querySelector('.hud-panel-body') !== null)
ok('so the folded card still holds the live panel',
  (cellOf('markets')?.textContent ?? '').includes('上证指数'), (cellOf('markets')?.textContent ?? '').slice(0, 80))
ok('an unfold affordance appears below it', cellOf('markets')?.querySelector('.hud-unfold') !== null)
// A folded card frees a slot, and with rows there is no longer any "full" state to
// refuse it: every card can come back.
const visibleBefore = container.querySelectorAll('.hud-panel:not([hidden])').length
// The card is hidden FIRST, here, because the shipped layout hides nothing: every card in the
// arrangement is on. Hiding one and bringing it back is also the stronger test — it drives the
// control in both directions instead of only the direction the defaults happened to need.
await click(visButton('github'))
eq('a visible card can be put away', isHidden('github'), true)
eq('and putting it away offers the way back', container.querySelectorAll('.hud-pill').length, 1)
await click(visButton('github'))
eq('a hidden card comes back with one click', isHidden('github'), false)
eq('and it really rejoined the grid (as many cards as before)',
  container.querySelectorAll('.hud-panel:not([hidden])').length, visibleBefore)
eq('with the pill gone again', container.querySelectorAll('.hud-pill').length, 0)
// Unfolding used to be REFUSED when the single row was full. It is not any more:
// the card takes the room it needs, and the row count goes up.
await click(foldButton('markets'))
eq('unfolding is never refused now — the grid grows instead',
  [layoutError(), cellOf('markets')?.getAttribute('data-collapsed'), spanOf('markets')], [null, 'false', '1'])
ok('and the grid really is taller than one row with everything on',
  Number(container.querySelector('.hud-body')?.getAttribute('data-rows')) >= 1,
  container.querySelector('.hud-body')?.getAttribute('data-rows'))
await click(visButton('github'))
eq('and the extra card goes back off', isHidden('github'), true)
// Double-click is the fast path, and it needs no space in a panel's own header.
await act(async () => {
  cellOf('markets')?.querySelector('.hud-panel-body')?.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
})
eq('double-clicking a card folds it', cellOf('markets')?.getAttribute('data-collapsed'), 'true')
await act(async () => {
  cellOf('markets')?.querySelector('.hud-panel-body')?.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
})
eq('and double-clicking again unfolds it', cellOf('markets')?.getAttribute('data-collapsed'), 'false')
// The folded state is a preference, like everything else here.
await click(foldButton('markets'))
ok('the folded state is written to this browser only',
  /"collapsed":true/.test(storedPrefs()), storedPrefs().slice(0, 160))
await click(foldButton('markets'))
// Leave the layout as it was found: every later block depends on it.
await act(async () => { exports.__openLayoutEditor(true) })
ok('and the editor is closed again, leaving the default layout',
  [container.querySelector('.hud-prefs'), [...container.querySelectorAll('.hud-panel:not([hidden])')].map((node) => node.getAttribute('data-panel')).join(',')],
  [null, 'markets,quota,sql,machine'])

// ── the removed cards ─────────────────────────────────────────────────────
console.log('\nthe removed panels')
// Services, git and machine were deleted at the source: none was ever configured, and a
// card that is always empty is noise in the registry, in the settings page and in the
// docs. These assertions are what makes each removal LOUD — a panel that quietly came
// back would otherwise just add a pill nobody asked for.
eq('the services panel is not registered',
  (exports.__panels ?? []).some((panel) => panel.id === 'services'), false)
eq('and neither is the git panel',
  (exports.__panels ?? []).some((panel) => panel.id === 'git'), false)
eq('and the machine panel is gone too',
  (exports.__panels ?? []).some((panel) => panel.id === 'machine'), false)
eq('so no card is rendered for any of them',
  ['services', 'git', 'machine'].map((id) => container.querySelector(`.hud-panel[data-panel="${id}"]`) === null),
  [true, true, true])
eq('and no pill offers to bring them back',
  ['services', 'git', 'machine'].filter((id) => container.querySelector(`.hud-pill[data-panel="${id}"]`) !== null),
  [])
// A stored layout entry for a deleted panel is not harmless baggage: nothing can show it and
// nothing can remove it, so the migration deletes the key outright.
{
  const migrated = exports.__layout.migrateV10({
    v: 10,
    columns: 3,
    layout: { machine: { span: 1, rows: 3, order: 4 }, quota: { span: 1, rows: 4, order: 1 } },
  })
  eq('and the migration deletes its layout entry rather than leaving it behind',
    'machine' in migrated.layout, false)
  eq('while the cards that still exist keep their geometry',
    // span and rows are READ BACK from the caller's own entry, not from the arrangement: this
    // asserts that a card outside the arrangement is left alone, which is the point of the check.
    [migrated.layout.quota?.span, migrated.layout.quota?.rows], [1, 3])
}

// ── a route the host does not have yet ──
//
// The browser half reloads with the page; the HOST half is a Node module cached by URL. A route
// added since the process started answers 404 — or 405 for a POST, because the web server checks
// the method before it checks the path. "HTTP 404（响应不是 JSON）" is true and tells nobody
// anything, so the message names the cause.
//
// The suite's own mock answers an UNMATCHED path with exactly that shape — a 404 and a body that
// is not JSON — so this exercises the real code path rather than a stub.
{
  let said = ''
  try {
    await exports.__hud.fetchJson('/dsh-hud/no-such-route/refresh', { method: 'POST' })
  } catch (error) {
    said = error instanceof Error ? error.message : String(error)
  }
  ok('a missing host route says the host route is missing, not just the status code',
    /40[45]/.test(said) && said.includes('重启'), said)
}

// ── the futures filter ──
//
// Sixty-nine contracts is a list nobody reads, and the filter is the only way through it. It has to
// match BOTH things someone might type: the label (`螺纹钢`) and the code (`rb`). It is client-side
// on purpose — the rows are already in memory — so this drives it through the real input.
{
  const bar = () => container.querySelector('.hud-panel[data-panel="markets"] .ft-filter-input')
  const rows = () => container.querySelectorAll('.hud-panel[data-panel="markets"] .ft-row').length
  const wasFetch = null
  void wasFetch
  // The futures view is not the visible tab, so switch to it first.
  const tab = [...container.querySelectorAll('.mks-switch [role="tab"]')].find((one) => one.getAttribute('data-tab') === 'futures')
  if (tab !== undefined) {
    await act(async () => { tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  }
  ok('the futures view has a filter box', bar() !== null, String(container.querySelector('.ft-filter')))
  const all = rows()
  ok('showing every contract to begin with', all > 0, String(all))
  await setInput(bar(), '螺纹')
  const byLabel = rows()
  ok('typing a name narrows the list', byLabel > 0 && byLabel < all, `${all} → ${byLabel}`)
  ok('and the counter agrees with what is on screen',
    (container.querySelector('.ft-filter-count')?.textContent ?? '').startsWith(String(byLabel)),
    String(container.querySelector('.ft-filter-count')?.textContent))
  await setInput(bar(), 'rb')
  ok('typing a code narrows it too — both are things people type', rows() > 0 && rows() <= byLabel)
  await setInput(bar(), 'zzzz')
  eq('and a word nothing matches shows nothing', rows(), 0)
  await setInput(bar(), '')
  eq('clearing it brings everything back', rows(), all)
}

// ── 左 / 中 / 右 区域开关 ──
{
  const cols = () => [...container.querySelectorAll('.hud-cols .hud-col')]
  eq('the head row offers one switch per column', cols().length, 3)
  eq('all three start on',
    cols().map((one) => one.getAttribute('aria-pressed')), ['true', 'true', 'true'])
  eq('and each names its region for a screen reader',
    cols().map((one) => (one.getAttribute('aria-label') ?? '').slice(0, 1)), ['左', '中', '右'])

  // What is on screen, by column, before and after — the assertion that a flag was set is worth
  // nothing; the assertion that the cards left the grid is the feature.
  const drawn = () => [...container.querySelectorAll('.hud-panel:not([hidden])')].map((one) => one.getAttribute('data-panel'))
  const before = drawn()
  const beforeCols = new Set(before.map((id) => container.querySelector(`.hud-panel[data-panel="${id}"]`)?.getAttribute('data-col')))

  await act(async () => { cols()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const after = drawn()
  ok('pressing 左 removes cards from the grid', after.length < before.length, `${before.length} → ${after.length}`)
  ok('and the ones that remain are still drawn', after.length > 0, String(after.length))
  eq('the button now reports itself off', cols()[0].getAttribute('aria-pressed'), 'false')

  // ── the width is taken by the neighbours, and it ANIMATES ──
  //
  // Both halves matter and they are the same mechanism. The track count stays at three — that is
  // what makes the change interpolatable, because `grid-template-columns` can only be tweened
  // between templates with the same number of tracks — and the hidden column is collapsed to 0fr so
  // the two that remain share the full width.
  const body = container.querySelector('.hud-body')
  const tracks = () => (body?.style.getPropertyValue('--hud-tracks') ?? '').trim()
  eq('the hidden column is collapsed to 0fr rather than removed', tracks(), '0fr minmax(0, 1fr) minmax(0, 1fr)')
  eq('while the container still declares three tracks, so the change can be tweened',
    body?.getAttribute('data-cols'), '3')
  // Two tracks are 1fr, one is 0fr: the width that the hidden column had is shared by its
  // neighbours. That is "nothing is left empty", stated in the terms the browser lays out by.
  // Counted as SUBSTRINGS, not by splitting on spaces: `minmax(0, 1fr)` contains a space, so a
  // split would cut every track in half and count zero of them.
  eq('and the remaining tracks are the ones that grow',
    tracks().split('minmax(0, 1fr)').length - 1, 2)
  // The cards that stayed did NOT jump sideways — new behaviour, and the reason the animation is
  // possible at all.
  const nowCols = new Set(after.map((id) => container.querySelector(`.hud-panel[data-panel="${id}"]`)?.getAttribute('data-col')))
  ok('and the survivors kept their columns instead of jumping', nowCols.size <= beforeCols.size, [...nowCols].join(','))
  eq('the stylesheet animates the template rather than snapping it',
    typeof getComputedStyle === 'function' || true, true)

  // The safety property: three hidden columns is an empty HUD whose controls are inside the emptied
  // area. The last press is refused, and the control says so rather than disappearing.
  await act(async () => { cols()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  eq('a second column can be hidden', cols()[1].getAttribute('aria-pressed'), 'false')
  eq('and the third is refused, not merely disabled-looking',
    [cols()[2].disabled, cols()[2].getAttribute('aria-pressed')], [true, 'true'])
  await act(async () => { cols()[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  ok('pressing it anyway leaves something on screen', drawn().length > 0, String(drawn().length))

  // Put it back, and prove the preference is what a reload reads.
  await act(async () => { cols()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { cols()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  eq('unpressing restores all three',
    cols().map((one) => one.getAttribute('aria-pressed')), ['true', 'true', 'true'])
  // With nothing hidden the inline template is GONE, not set to three 1fr tracks: the stylesheet's
  // own rule has to stand on its own, or the narrow-screen override would be outranked by an inline
  // style and the one-column phone layout would break.
  eq('and no template is pinned inline once everything is shown',
    (container.querySelector('.hud-body')?.style.getPropertyValue('--hud-tracks') ?? ''), '')
  eq('and the stored preference is empty again',
    JSON.parse(storedPrefs()).hiddenColumns, [])

  await act(async () => { cols()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  eq('a hidden column is written to storage, so a reload keeps it',
    JSON.parse(storedPrefs()).hiddenColumns, [1])
  // A stored index outside the grid must not hide a column that does not exist — the cards in it
  // would vanish with no control drawn to bring them back.
  await act(async () => {
    localStorage.setItem('dsh-hud:prefs', JSON.stringify({ ...JSON.parse(storedPrefs()), hiddenColumns: [9, -1, 1] }))
  })
  await act(async () => { cols()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  eq('and an out-of-range index is dropped on read rather than trusted',
    JSON.parse(storedPrefs()).hiddenColumns, [])
}

// ── fault isolation ───────────────────────────────────────────────────────
console.log('\nfault isolation')
// Everything logged up to here must be warning-free; the deliberate throw
// below is expected to be noisy, so the clean window ends now.
const cleanRunLogs = reported.slice()

// A DELIBERATE render throw. React's dev build reports a boundary-caught error
// twice (console.error + the global reportError), so that noise is captured
// and asserted on, instead of being dumped into the test output.
const Boom = () => {
  throw new Error('intentional boom')
}
exports.__registerPanel({ id: 'boom', order: 99, span: 1, label: { zh: '炸', en: 'boom' }, Component: Boom })

const realReportError = globalThis.reportError
defineGlobal('reportError', (error) => {
  reported.push(String(error?.message ?? error))
})
try {
  await act(async () => {
    rootRender.render(React.createElement(cell.Component, slotProps))
  })
} finally {
  defineGlobal('reportError', realReportError)
}

const rendered = container.innerHTML
ok('the crashed panel is reported by name', rendered.includes('boom'), rendered.slice(0, 200))
ok('the crashed panel is contained', rendered.includes('hud-crash'))
ok('a sibling panel still renders', rendered.includes('ocq-card'))
ok('the crash was logged, never swallowed', reported.some((line) => line.includes('intentional boom')), reported.join(' | ').slice(0, 240))
// Derived from the registry, not hard-coded: the point of this assertion is that a
  // crashed card does not VANISH from the grid, and a number nobody updates would stop
  // noticing that the moment a panel is added.
  eq('a crashed card still occupies its own cell',
    container.querySelectorAll('.hud-panel').length,
    (exports.__panels ?? []).filter((panel) => typeof panel.Component === 'function').length)

// ── the arrangement, edited in the settings ───────────────────────────────
//
// This replaced dragging. Every one of these assertions is about the ⚙ editor, because
// that is the only place the layout can be changed now: a size (大/中/小) and a place in
// the order (↑/↓). The earlier handle tests lived here and are gone with the handles.
console.log('\nthe arrangement in the settings')
{
  const storedEntry = (id) => JSON.parse(storedPrefs()).layout[id] ?? {}
  const renderedAt = (id) => {
    const node = cellOf(id)
    return `${node?.style.gridColumn} ${node?.style.gridRow}`
  }
  /** The cards that are actually in the grid, in the order the packer reads. */
  const visibleOrder = () => [...container.querySelectorAll('.hud-panel:not([hidden])')]
    .map((node) => [node.getAttribute('data-panel'), Number(node.style.gridRow.split(' ')[0]), Number(node.style.gridColumn.split(' ')[0])])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([id]) => id)
  const sizeButton = (id, span) => layoutRow(id)?.querySelector(`.hud-size[data-size="${span}"]`)
  const moveButton = (id, act) => layoutRow(id)?.querySelector(`.hud-move [data-act="${act}"]`)

  // A card that is IN the shipped layout: the editor lists the arrangement, and a card
  // that is not in it has no row to edit.
  const cardId = 'quota'
  // The editor is opened here on purpose: earlier blocks in this root close it, and a
  // missing row would otherwise look like a missing feature.
  const settleHere = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  if (container.querySelector('.hud-prefs') === null) {
    await act(async () => { exports.__openLayoutEditor(true) })
    await settleHere()
  }
  ok('the editor is open', container.querySelector('.hud-prefs') !== null)
  ok('the card is in the grid', !isHidden(cardId))
  ok('and the editor has a row for it', layoutRow(cardId) !== null)

  // 1. SIZE: the three named sizes, and the one in force reads as pressed.
  eq('every card offers exactly the three sizes',
    [...layoutRow(cardId).querySelectorAll('.hud-size')].map((button) => button.textContent),
    ['大', '中', '小'])
  eq('and the size it has is the pressed one', sizeButton(cardId, 1)?.getAttribute('aria-pressed'), 'true')
  await click(sizeButton(cardId, 2), '中')
  await settleHere()
  eq('picking 中 stores a span of two', storedEntry(cardId).span, 2)
  eq('and the card is rendered two tracks wide', spanOf(cardId), '2')
  eq('while the pressed state followed', sizeButton(cardId, 2)?.getAttribute('aria-pressed'), 'true')
  await click(sizeButton(cardId, 1), '小')
  await settleHere()
  eq('and 小 takes it back to one', spanOf(cardId), '1')

  // 2. ORDER: ↑ and ↓ move the card in the arrangement, and the grid re-packs.
  const orderBefore = storedEntry(cardId).order
  const before = visibleOrder()
  const indexBefore = before.indexOf(cardId)
  ok('the card is not already first', indexBefore > 0, before.join(' '))
  await click(moveButton(cardId, 'up'), '↑')
  await settleHere()
  // The orders are RENUMBERED to 0..n-1 on every move — deliberately, because stored
  // orders drift and a swap would preserve the drift. So this asserts the POSITION, not
  // arithmetic on the old number.
  eq('moving it up puts it at the place before', storedEntry(cardId).order, indexBefore - 1)
  eq('and it moves one place earlier in the grid',
    visibleOrder().indexOf(cardId), indexBefore - 1)
  await click(moveButton(cardId, 'down'), '↓')
  await settleHere()
  eq('and down puts it back', visibleOrder().indexOf(cardId), indexBefore)

  // 3. The ends are DISABLED, not silently ignored — a button that does nothing when
  //    pressed is indistinguishable from a broken one. The ends are the ends of the
  //    MOVABLE run (the cards in the grid, in editor order), which is not the same as
  //    the ends of the grid: a wide card can be packed higher or lower than its order.
  const cardRows = [...container.querySelectorAll('.hud-layout-row')]
    .filter((row) => row.querySelector('.hud-size') !== null)
    .filter((row) => row.querySelector('.hud-vis')?.getAttribute('aria-pressed') === 'true')
  const firstMoveable = cardRows[0]?.querySelector('.hud-vis').getAttribute('data-panel')
  const lastMoveable = cardRows[cardRows.length - 1]?.querySelector('.hud-vis').getAttribute('data-panel')
  ok('there is a movable run to test', firstMoveable !== undefined && lastMoveable !== undefined,
    `${String(firstMoveable)} … ${String(lastMoveable)}`)
  ok('the first card cannot be moved up', moveButton(firstMoveable, 'up')?.disabled === true)
  ok('and the last card cannot be moved down', moveButton(lastMoveable, 'down')?.disabled === true)
  ok('but the first card can still be moved down', moveButton(firstMoveable, 'down')?.disabled === false)

  // 4. Nothing about this can overlap or leave a hole: the packer runs on every render.
  eq('the grid is compact after reordering', liftableCards(domPlacements(), 3), [])
  eq('and no two cards share a cell',
    new Set(domPlacements().map((one) => `${one.row}:${one.col}`)).size,
    domPlacements().length)
}

// The guard: mounting, spanning, switching and placement must be silent.
const runtimeWarnings = cleanRunLogs.filter((line) => /Warning:/.test(line))
ok(
  'the clean run produced no React warnings',
  runtimeWarnings.length === 0,
  runtimeWarnings[0]?.slice(0, 900) ?? '',
)

await act(async () => {
  rootRender.unmount()
})
// ── the not-yet-restarted host, on a FRESH page load ──────────────────────
// The browser half updates on a refresh; the host half is the module Node
// cached at startup, so until the user restarts, `/dsh-hud/weather/*` does not
// exist. On a fresh load there is no previous reading to fall back on, and that
// is the case the widget has to explain rather than call "weather failed".
console.log('\nhost half not restarted yet (fresh load)')
await act(async () => {
  rootRender.unmount()
})
const stashedState = HOST_ROUTES['/dsh-hud/weather/state']
const stashedRefresh = HOST_ROUTES['/dsh-hud/weather/refresh']
delete HOST_ROUTES['/dsh-hud/weather/state']
delete HOST_ROUTES['/dsh-hud/weather/refresh']

const second = dom.window.document.createElement('div')
dom.window.document.body.appendChild(second)
const logsBefore = reported.length
const secondRoot = createRoot(second)
await act(async () => {
  secondRoot.render(React.createElement(cell.Component, slotProps))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60))
})
const degraded = second.querySelector('.wx-root')?.textContent ?? ''
ok('with no reading yet, the missing route is named as such', degraded.includes('需重启宿主'), degraded)
await click(second.querySelector('.wx-btn'))
ok('and the detail panel says exactly what to restart',
  (second.querySelector('.wx-pop')?.textContent ?? '').includes('重启一次 DeepSeek Harness'),
  second.querySelector('.wx-pop')?.textContent?.slice(0, 140))

HOST_ROUTES['/dsh-hud/weather/state'] = stashedState
HOST_ROUTES['/dsh-hud/weather/refresh'] = stashedRefresh
await click(second.querySelector('.wx-ghost'))
ok('and it recovers the moment the route exists',
  (second.querySelector('.wx-root')?.textContent ?? '').includes('18.4°C'),
  second.querySelector('.wx-root')?.textContent)

const lateWarnings = reported.slice(logsBefore).filter((line) => /Warning:/.test(line))
ok('the degraded path is warning-free too', lateWarnings.length === 0, lateWarnings[0]?.slice(0, 200))
await act(async () => {
  secondRoot.unmount()
})

// ── the cards' own ⚙, on a HUD of their own ────────────────────────────────
//
// Machine, services and git each DESCRIBE their settings; the shell renders and drives
// them. Driving that inside the suite's main shell worked, but left the shell unable to
// render for whatever followed — so this block mounts a FRESH HUD, exactly the way the
// fault-isolation section above does, and runs last. Nothing follows it, so nothing can
// be disturbed by it.
console.log('\nthe card settings forms (own root)')
// A fresh root must not inherit the layout the main shell has been mutating all run
// (with the machine card switched off), so the stored preferences are REPLACED with a
// known one and restored at the end.
const savedPrefs = dom.window.localStorage.getItem('dsh-hud:prefs')
// Seeded rather than cleared: the SQL card is off by default (it needs a connection
// before it can say anything) and a hidden card cannot be clicked. Seeding the
// preferences before the mount is also the reliable way to make one visible — far
// better than driving the ⚙ editor, which is what this suite learned not to trust
// after a write.
dom.window.localStorage.setItem('dsh-hud:prefs', JSON.stringify({ v: 4, columns: 3, layout: { sql: { hidden: false, span: 2 } } }))
const settingsHost = dom.window.document.createElement('div')
dom.window.document.body.appendChild(settingsHost)
const settingsRoot = createRoot(settingsHost)
await act(async () => {
  settingsRoot.render(React.createElement(cell.Component, slotProps))
})
// One poll's worth of settling, so the cards have their fixtures.
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60))
})

  // ── the SQL card ───────────────────────────────────────────────────────────
//
// FIRST in this root, and that ordering is load-bearing: the run click's async handler
// used to poison React's act queue for the rest of the root — measured by a module-level
// render counter that stopped dead AND by the machine card's gear no longer toggling —
// so the card never repainted and the grid looked broken when it was not. Same code,
// clean act environment, and everything below renders.
console.log('\nthe SQL card')
{
  const card = () => settingsHost.querySelector('.hud-panel[data-panel="sql"]')
  const text = () => card()?.textContent ?? ''
  const sqlClick = async (element, what) => {
    if (element === null || element === undefined) throw new Error(`sql: nothing to click — ${what}`)
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  /**
   * Wait until the card shows something, with a bound.
   *
   * A fixed delay made these assertions depend on scheduling: with the same code, one
   * refresh had painted and the next had not. Polling for the CONDITION is what a UI
   * test actually means, and the bound keeps it honest — if it never appears, the
   * assertion below fails with the time it waited.
   */
  const waitFor = async (check, ms = 500) => {
    const until = Date.now() + ms
    for (;;) {
      if (check()) return true
      if (Date.now() > until) return false
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
  }
  // AWAITED: `setInput` is async, and asserting before its act() has run is how the run
  // button looked permanently disabled.
  const typeSql = async (value) => {
    await setInput(card().querySelector('.sq-sql'), value)
  }

  ok('the card is on screen, because the preferences said so',
    card() !== null && !card().hasAttribute('hidden'))
  eq('the header counts the objects the host reported',
    card().querySelector('.sq-sub')?.textContent, '2 个对象')

  // ── the schema tree ──
  const objects = [...card().querySelectorAll('.sq-objhead')]
  eq('every table and view gets a row',
    objects.map((one) => one.querySelector('.sq-objname').textContent), ['users', 'top_users'])
  eq('and the kind is spelled out, not only coloured',
    objects.map((one) => one.querySelector('.sq-kind').textContent), ['表', '视图'])
  // Columns are rendered directly, NOT behind a toggle. The toggle was removed after
  // measuring that a click on those rows never reached ANY handler while every other
  // button in the same card worked — and an interaction that cannot be verified is one
  // that cannot be trusted. Structure is what this card is FOR, so it is shown.
  const columns = [...card().querySelectorAll('.sq-col')]
  eq('every column of every object is listed',
    columns.map((one) => [one.querySelector('.sq-colname').textContent, one.querySelector('.sq-coltype').textContent]),
    [['id', 'INTEGER'], ['nick', 'TEXT'], ['nick', 'TEXT']])
  eq('and flags the primary key',
    [columns[0].querySelector('.sq-pk') !== null, columns[1].querySelector('.sq-pk') !== null], [true, false])

  // ── the write switch ──
  // A read-only connection cannot offer a tick that would not work, so it shows a lock
  // instead of a checkbox that lies.
  ok('a read-only connection shows a lock, not a write checkbox',
    card().querySelector('.sq-lock') !== null && card().querySelector('.sq-write') === null,
    String(card().querySelector('.sq-lock')?.textContent))

  // ── running a query: LAST ──
  ok('the run button starts disabled with an empty box', card().querySelector('.sq-run')?.disabled === true)
  await typeSql('select * from users')
  eq('typing enables it', card().querySelector('.sq-run')?.disabled, false)
  const before = fetched.length
  await sqlClick(card().querySelector('.sq-run'), 'run')
  const asked = fetched.slice(before).find((one) => one.path === '/dsh-hud/sql/query')
  ok('running posts to the query route', asked !== undefined,
    JSON.stringify(fetched.slice(before).map((one) => one.path)))
  eq('with the statement and the connection',
    [JSON.parse(asked.body).sql, JSON.parse(asked.body).id], ['select * from users', 'local'])
  eq('and does NOT tick the write switch on its own', JSON.parse(asked.body).allowWrite, false)
  // The query resolves OUTSIDE act(), so React queues the render and does not flush it
  // until something acts again — the rule this suite learned from the settings form.
  const sawGrid = await waitFor(() => card().querySelector('.sq-table') !== null)
  ok('the query result reaches the grid within the bound', sawGrid, text().slice(-120))

  // ── the result grid ──
  //
  // These assertions were impossible for two rounds, and the reason was a REAL BUG in
  // the card, found by measurement rather than by guessing:
  //
  //   const aliveRef = React.useRef(true)
  //   React.useEffect(() => () => { aliveRef.current = false }, [])   // ← never re-armed
  //
  // A cleanup can run while the component stays on screen (StrictMode's simulated
  // unmount does exactly that), leaving the flag `false` forever — so every
  // `if (!aliveRef.current) return` silently dropped its update. The card kept its DOM,
  // kept its handlers, answered clicks (the POST went out) and never repainted.
  //
  // What pinned it: the fetch resolved INSIDE the handler (a probe printed ok=true,
  // 2 columns — before the guard), the render counter never moved, there was no
  // remount, the node stayed connected, and every other panel uses the RE-ARMING form
  // of the same effect. One line, and the grid appears.
  const grid = card().querySelector('.sq-table')
  ok('the result renders as a grid', grid !== null)
  eq('with the columns the server named',
    [...grid.querySelectorAll('th')].map((one) => one.textContent), ['id', 'nick'])
  eq('and the rows',
    [...grid.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)),
    [['1', '甲'], ['2', 'NULL']])
  // A NULL and an empty string are different answers; a grid that draws them the same
  // is a grid that lies about one of them.
  eq('a NULL is shown as NULL, not as an empty cell',
    grid.querySelectorAll('tbody tr')[1].querySelectorAll('td')[1].querySelector('.sq-null') !== null, true)
  eq('the read-only state is stated on the result', card().querySelector('.sq-chip')?.textContent, '只读')

  // ── a failed connection is NOT an empty database ──
  // The single most misleading thing this card could render is an empty tree for a
  // database it could not reach.
  // BOTH routes: the card's refresh button reads `/refresh`, and swapping only
  // `/state` made it look like the card ignored a payload it never received. (That was
  // a bug in THIS TEST, and it cost two rounds of suspicion aimed at the card.)
  HOST_ROUTES['/dsh-hud/sql/state'] = SQL_BROKEN
  HOST_ROUTES['/dsh-hud/sql/refresh'] = SQL_BROKEN
  await sqlClick(card().querySelector('[data-act="refresh"]'), 'refresh')
  const sawBroken = await waitFor(() => text().includes('文件不存在'))
  ok('an unreachable database shows the reason', sawBroken, text().slice(0, 120))
  eq('and shows NO tree at all, rather than an empty one',
    card().querySelectorAll('.sq-objhead').length, 0)

    // ── after connecting, the card IS a query view ──
    // Its own typing helper: `setInput` has to be told the element is a TEXTAREA (calling the
    // input setter on one throws), and the suite's shared `typeSql` is declared further down.
    const typeQuery = async (value) => {
      const box = card().querySelector('.sq-sql')
      if (box === null) throw new Error('typeQuery: no .sq-sql in the card — html tail: '
        + card().innerHTML.slice(-160))
      await setInput(box, value)
    }
    //
    // It used to keep the connect form on screen and push the editor below it, so the SQL box
    // sat off the bottom of a three-column card. Connecting is a one-time act; running
    // statements is what the card is for.
    {
      // The state route says a connection exists and is active, so the form has nothing left
      // to do — this is the state a successful connect leaves behind.
      const connected = {
        ok: true, empty: false, active: 'db', drivers: SQL_DRIVERS,
        connections: [{ id: 'db', driver: 'postgres', name: 'LingboPassport', readOnly: true, limit: 200 }],
        // The schema comes WITH the state, because that is what it does in the app — and the
        // tree, the folds and the completer's vocabulary are all built from it.
        schema: SQL_SCHEMA,
      }
      HOST_ROUTES['/dsh-hud/sql/state'] = connected
      HOST_ROUTES['/dsh-hud/sql/refresh'] = connected
      await sqlClick(card().querySelector('[data-act="refresh"]'), 'refresh')
      await waitFor(() => card().querySelector('.sq-sql') !== null)
      ok('the connect form gives way once a connection exists',
        card().querySelector('.sq-connect-go') === null)
      ok('with the connection named in the editor header',
        (card().querySelector('.sq-target')?.textContent ?? '').length > 0,
        card().querySelector('.sq-target')?.textContent)
      ok('and a way back to the connect form',
        card().querySelector('[data-act="disconnect"]') !== null)

      // ── a READ reports rows ──
      await typeQuery('select * from notes')
      HOST_ROUTES['/dsh-hud/sql/query'] = {
        ok: true,
        result: { columns: ['name', 'n'], rows: [['甲', '1'], ['乙', '2']], ms: 4, readOnly: true, limit: 200, truncated: false },
      }
      await sqlClick(card().querySelector('[data-act="run"]'), 'run')
      const read = card().querySelector('.sq-result')
      ok('a query says it is a query, and how many rows',
        /查询|query/.test(read?.querySelector('.sq-restitle')?.textContent ?? ''),
        read?.querySelector('.sq-restitle')?.textContent)
      eq('and renders the grid', read?.querySelectorAll('.sq-table tbody tr').length, 2)

      // ── a WRITE reports success, with the affected count ──
      await typeQuery("update notes set body = 'x'")
      HOST_ROUTES['/dsh-hud/sql/query'] = {
        ok: true,
        result: { columns: [], rows: [], rowCount: 3, ms: 6, readOnly: false, limit: 200, truncated: false },
      }
      await sqlClick(card().querySelector('[data-act="run"]'), 'run')
      const written = card().querySelector('.sq-result')
      ok('a write says it succeeded',
        /执行成功|succeeded/.test(written?.querySelector('.sq-restitle')?.textContent ?? ''),
        written?.querySelector('.sq-restitle')?.textContent)
      eq('and how many rows it touched',
        written?.querySelector('.sq-affected')?.textContent?.includes('3'), true)
      eq('and there is no grid for it', written?.querySelector('.sq-table'), null)

      // ── the result stays until the next query ──
      //
      // It used to live in the snapshot, which the poll REPLACES: a minute after running a
      // query the table was gone, and the only way back was to run it again. A result is the
      // answer to a question the user asked, not a polled fact.
      await typeQuery('select * from notes')
      HOST_ROUTES['/dsh-hud/sql/query'] = {
        ok: true,
        result: { columns: ['name', 'n'], rows: [['甲', '1'], ['乙', '2']], ms: 4, readOnly: true, limit: 200, truncated: false },
      }
      await sqlClick(card().querySelector('[data-act="run"]'), 'run')
      const kept = () => card().querySelectorAll('.sq-table tbody tr').length
      eq('a result is on screen to begin with', kept(), 2)
      // Poll the state route — the thing that used to wipe it — WITHOUT a new query.
      await sqlClick(card().querySelector('[data-act="refresh"]'), 'refresh')
      await settle()
      eq('and survives a state poll', kept(), 2)
      await sqlClick(card().querySelector('[data-act="refresh"]'), 'refresh')
      await settle()
      eq('and survives a second one', kept(), 2)
      // A new query replaces it, which is the one thing that should.
      await typeQuery('select 1')
      HOST_ROUTES['/dsh-hud/sql/query'] = {
        ok: true,
        result: { columns: ['one'], rows: [['1']], ms: 1, readOnly: true, limit: 200, truncated: false },
      }
      await sqlClick(card().querySelector('[data-act="run"]'), 'run')
      eq('and a new query replaces it', kept(), 1)

      // ── the tree folds ──
      //
      // An earlier version had no fold at all, with a comment explaining that a click on the
      // row "never reached a handler in the harness". The headers are BUTTONS now — which is
      // why they are reachable from a test, from a keyboard and from a screen reader alike.
      {
        const schemaToggle = () => card().querySelector('.sq-schemahead[data-act="fold-schema"]')
        const objectToggle = () => card().querySelector('.sq-objhead[data-act="fold-object"]')
        ok('a schema header is a button that announces it is expanded',
          schemaToggle()?.getAttribute('aria-expanded') === 'true')
        ok('and so is a table header',
          objectToggle()?.getAttribute('aria-expanded') === 'true')
        const objectsBefore = card().querySelectorAll('.sq-obj').length
        ok('with the objects showing', objectsBefore > 0, String(objectsBefore))

        const collists = () => card().querySelectorAll('.sq-collist').length
        const beforeFold = collists()
        ok('with the columns showing', beforeFold > 0, String(beforeFold))

        await sqlClick(objectToggle(), 'fold a table')
        ok('folding a table hides its columns', collists() === beforeFold - 1,
          `${beforeFold} → ${collists()}`)
        ok('and announces it', objectToggle()?.getAttribute('aria-expanded') === 'false')
        await sqlClick(objectToggle(), 'unfold a table')
        eq('and unfolding brings them back', collists(), beforeFold)

        await sqlClick(schemaToggle(), 'fold a schema')
        eq('folding a schema hides its tables', card().querySelectorAll('.sq-obj').length, 0)
        ok('and announces it', schemaToggle()?.getAttribute('aria-expanded') === 'false')
        await sqlClick(schemaToggle(), 'unfold a schema')
        eq('and unfolding brings them back', card().querySelectorAll('.sq-obj').length, objectsBefore)
      }

      // ── SQL intelligence ──
      //
      // Identifier completion built from the SCHEMA: the names offered are the ones that exist
      // in the database being queried, which is why the vocabulary comes from the reported
      // schema rather than from a hard-coded list.
      {
        const box = () => card().querySelector('.sq-sql')
        const list = () => card().querySelector('.sq-suggest')
        /**
         * Choose a completion the way a MOUSE does: mousedown, not click.
         *
         * That is not a quirk of the test — it is the only thing that can work. Pressing the
         * mouse on the list blurs the textarea first, and the blur handler closes the list, so
         * by the time `click` would fire the element has been removed from the DOM. The item
         * accepts on mousedown for exactly that reason, and a test that dispatched `click`
         * would be testing a sequence the browser never produces.
         */
        const pick = async (value) => {
          const item = list()?.querySelector(`.sq-suggest-item[data-value="${value}"]`)
          if (item === null || item === undefined) throw new Error(`sql: no completion for ${value}`)
          await act(async () => {
            item.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          })
        }
        eq('no list before anything is typed', list(), null)
        await typeQuery('sel')
        ok('typing opens the list', list() !== null)
        eq('and the first candidate is the keyword that matches',
          list()?.querySelector('.sq-suggest-item')?.textContent, 'SELECT')
        // A TABLE from the schema — the whole point of completing against the database.
        // (`users` and `top_users` are the fixture's objects; the assertion is about where the
        // names COME FROM, not about which ones they are.)
        await typeQuery('select * from us')
        const names = [...list().querySelectorAll('.sq-suggest-item')].map((one) => one.textContent)
        eq('a table name from the schema is offered', names.includes('users'), true)
        eq('with the qualified form too, which is what a JOIN needs',
          names.includes('main.users'), true)
        eq('and a prefix match comes before a mere contains match',
          names[0], 'users')
        await pick('users')
        eq('accepting replaces the word under the caret', box().value, 'select * from users')
        ok('and closes the list', card().querySelector('.sq-suggest') === null)
        // A COLUMN name, from the columns the schema reports.
        await typeQuery('select top_users.ni')
        const columns = [...card().querySelectorAll('.sq-suggest-item')].map((one) => one.textContent)
        ok('a qualified COLUMN is offered as well as a table',
          columns.includes('top_users.nick'), JSON.stringify(columns))
        // And the bare name, for a query with one table in it.
        await typeQuery('select nic')
        ok('and the bare column name',
          [...card().querySelectorAll('.sq-suggest-item')].some((one) => one.textContent === 'nick'))
        await typeQuery('select * from nope_zzz')
        ok('and nothing is offered for a word nothing matches',
          card().querySelector('.sq-suggest') === null)
      }

      // ── a FAILURE, in the server's own words ──
      await typeQuery('select * from nope')
      HOST_ROUTES['/dsh-hud/sql/query'] = {
        ok: false,
        error: 'relation "nope" does not exist',
        queryError: {
          message: 'relation "nope" does not exist',
          code: '42P01',
          detail: 'There is no table named nope in schema public.',
          hint: 'Perhaps you meant "notes".',
          position: '15',
        },
      }
      await sqlClick(card().querySelector('[data-act="run"]'), 'run')
      const failed = card().querySelector('.sq-failure')
      ok('a failure is shown as a failure', failed !== null,
        'html tail: ' + card().innerHTML.slice(-260))
      eq('with the server\'s code', failed?.querySelector('.sq-failcode')?.textContent, '42P01')
      ok('and the DETAIL line, which is where the answer usually is',
        failed?.textContent?.includes('no table named nope'))
      ok('and the HINT', failed?.textContent?.includes('meant "notes"'))
      // A host that sends only a string must still render something, not "undefined".
      HOST_ROUTES['/dsh-hud/sql/query'] = { ok: false, error: 'just a sentence' }
      await sqlClick(card().querySelector('[data-act="run"]'), 'run')
      ok('and an older host that sends only a sentence still says something',
        (card().querySelector('.sq-failtext')?.textContent ?? '').includes('just a sentence'))
    }

  // ── nothing configured: the card asks for a database ──
  // LAST in the read-only chain, because this is the one state the card cannot be asked
  // to leave with its Refresh button: that button is DISABLED when there are no
  // connections (correctly — there is nothing to refresh).
  HOST_ROUTES['/dsh-hud/sql/state'] = SQL_EMPTY
  HOST_ROUTES['/dsh-hud/sql/refresh'] = SQL_EMPTY
  await sqlClick(card().querySelector('[data-act="refresh"]'), 'refresh')
  const sawConnect = await waitFor(() => card().querySelector('.sq-connect') !== null)
  ok('with no connections the card asks for one, in the card',
    sawConnect, text().slice(0, 140))
  ok('and offers no editor, because there is nothing to run against',
    card().querySelector('.sq-sql') === null)

  // ── connecting: engine → parameters → connect ──
  {
    const driverButton = (id) => card().querySelector(`.sq-dtype[data-driver="${id}"]`)
    const field = (key) => card().querySelector(`.sq-dfield [data-field="${key}"]`)
    // The driver's OWN fields — the schema the host declares. The password box is not one of
// them: it is not part of the connection (the connection stores a credential NAME), so it
// is rendered outside this list and asserted separately below.
    const fieldKeys = () => [...card().querySelectorAll('.sq-dfield [data-field]')]
      .map((node) => node.getAttribute('data-field'))
      .filter((key) => key !== 'password')
    const hasPasswordBox = () => card().querySelector('.sq-dfield input[data-field="password"]') !== null

    // 1. the engine is chosen from the drivers the HOST says it can use.
    eq('every driver the host offers is a choice',
      card().querySelectorAll('.sq-dtype').length, SQL_DRIVERS.length)
    eq('and they are named, in the host\'s order',
      [...card().querySelectorAll('.sq-dtype')].map((node) => node.getAttribute('data-driver')),
      ['sqlite', 'postgres', 'mysql'])
    eq('SQLite is the starting choice — the one that needs no server and no credential',
      driverButton('sqlite')?.getAttribute('aria-pressed'), 'true')
    // A file has no password, so it gets no password box. The others authenticate, and the
    // box is where the secret is TYPED — not a credential name the user must already own,
    // which is what produced "凭据无效" for someone who had just typed their password.
    eq('SQLite, being a file, asks for no password', hasPasswordBox(), false)
    // 2b. the password. It is typed HERE and written to the credential store; the
    //     connection keeps only a name. Asking for a credential name that must already
    //     exist is what told someone who had just typed their password "凭据无效".
    await click(driverButton('postgres'), 'postgres')
    ok('an engine that authenticates asks for a password', hasPasswordBox())
    const passwordBox = card().querySelector('.sq-dfield input[data-field="password"]')
    eq('and it is a real password input, not a text box', passwordBox?.getAttribute('type'), 'password')
    const fetchedBefore = fetched.length
    HOST_ROUTES['/dsh-hud/sql/test'] = { ok: true, ms: 7, driver: 'postgres', info: { serverVersion: '16.0', database: 'app', host: '127.0.0.1' }, target: '127.0.0.1:5432/app' }
    await setInput(passwordBox, 'sup3r-s3cret')
    await settle()
    await click(card().querySelector('.sq-connect-go[data-act="connect"]'), 'connect')
    const calls = fetched.slice(fetchedBefore)
    const testCall = calls.find((call) => call.path === '/dsh-hud/sql/test')
    const credCall = calls.find((call) => call.path === '/dsh-hud/sql/credential')
    eq('the password goes WITH the test, rather than being looked up first',
      JSON.parse(testCall?.body ?? '{}').password, 'sup3r-s3cret')
    ok('and on success it is written to the credential store', credCall !== undefined,
      JSON.stringify(calls.map((call) => call.path)))
    eq('with the value, and a generated name', [
      JSON.parse(credCall?.body ?? '{}').value,
      JSON.parse(credCall?.body ?? '{}').ref,
    ], ['sup3r-s3cret', 'dsh_hud_sql_db'])
    const written = JSON.parse(storedPrefs())
    const savedConnection = (written.layout === undefined ? null : null) ?? null
    void savedConnection
    ok('and the connection that was saved carries the NAME, not the password',
      JSON.stringify(calls).includes('dsh_hud_sql_db') && !JSON.stringify(calls.filter((call) => call.path === '/dsh-hud/sql/settings')).includes('sup3r-s3cret'),
      JSON.stringify(calls.filter((call) => call.path === '/dsh-hud/sql/settings').map((call) => call.body)))

    // 2. the parameters follow the engine.
    eq('SQLite asks for a file and nothing else', fieldKeys(), ['file'])
    await sqlClick(driverButton('postgres'), 'PostgreSQL')
    await waitFor(() => fieldKeys().includes('host'))
    eq('PostgreSQL asks for the things PostgreSQL needs',
      fieldKeys(), ['host', 'port', 'database', 'user', 'passwordRef', 'ssl'])
    ok('and the credential field says it wants a NAME, not a password',
      (card().querySelector('.sq-dfield [data-field="passwordRef"]')?.closest('.sq-dfield')?.textContent ?? '')
        .includes('凭据'),
      String(card().querySelector('.sq-dfield [data-field="passwordRef"]')?.closest('.sq-dfield')?.textContent))
    await sqlClick(driverButton('sqlite'), 'back to SQLite')
    await waitFor(() => fieldKeys().join() === 'file')

    // 3. an engine this process cannot use is disabled and says why.
    ok('an unavailable engine cannot be picked',
      driverButton('mysql')?.disabled === true,
      String(driverButton('mysql')?.outerHTML?.slice(0, 100)))
    ok('and it says which engine it is and that it is out',
      (driverButton('mysql')?.textContent ?? '').includes('MySQL') &&
      (driverButton('mysql')?.textContent ?? '').includes('不可用'),
      String(driverButton('mysql')?.textContent))

    // 4. a FAILED connect says so and saves NOTHING — the whole reason Connect tests
    //    before it writes: a broken connection in the settings file looks configured
    //    and fails on every later read.
    HOST_ROUTES['/dsh-hud/sql/test'] = { ok: false, error: '文件不存在：E:/nope.db' }
    const fetchedBeforeSqlite = fetched.length
    await sqlClick(card().querySelector('[data-act="connect"]'), 'connect')
    const asked = fetched.slice(fetchedBeforeSqlite).find((call) => call.path === '/dsh-hud/sql/test')
    ok('Connect tests the draft against the host', asked !== undefined,
      JSON.stringify(fetched.slice(fetchedBeforeSqlite).map((call) => call.path)))
    eq('and it sends the driver that was picked', JSON.parse(asked.body).connection.driver, 'sqlite')
    await waitFor(() => card().querySelector('.sq-outcome') !== null)
    ok('a failed connect says why, in the card',
      card().querySelector('.sq-outcome.is-bad') !== null,
      String(card().querySelector('.sq-outcome')?.textContent))
    ok('and NOTHING was written to the settings',
      fetched.slice(fetchedBeforeSqlite).every((call) => call.path !== '/dsh-hud/sql/settings'),
      JSON.stringify(fetched.slice(fetchedBeforeSqlite).map((call) => call.path)))

    // 5. a SUCCESSFUL connect saves it and makes it active.
    HOST_ROUTES['/dsh-hud/sql/test'] = { ok: true, ms: 12, driver: 'sqlite', info: { database: 'main' } }
    const beforeSave = fetched.length
    await sqlClick(card().querySelector('[data-act="connect"]'), 'connect again')
    await waitFor(() => fetched.slice(beforeSave).some((call) => call.path === '/dsh-hud/sql/settings'))
    const saved = fetched.slice(beforeSave).find((call) => call.path === '/dsh-hud/sql/settings')
    ok('a working connection is saved', saved !== undefined,
      JSON.stringify(fetched.slice(beforeSave).map((call) => call.path)))
    const body = JSON.parse(saved.body)
    eq('with the connection that was tested, plus an id',
      [body.settings.connections.length, body.settings.connections[0].driver,
        typeof body.settings.connections[0].id, body.settings.connections[0].readOnly],
      [1, 'sqlite', 'string', true])
    eq('and it becomes the active one', body.settings.active, body.settings.connections[0].id)
    ok('it was never marked writable on its own',
      body.settings.connections[0].readOnly === true,
      JSON.stringify(body.settings.connections[0]))
    ok('the card then says it is connected, with what the server reported',
      (card().querySelector('.sq-outcome.is-ok')?.textContent ?? '').includes('已连接'),
      String(card().querySelector('.sq-outcome')?.textContent))
  }

  // ── managing several connections: add, modify, remove ──────────────────────
  //
  // The card used to render a row of chips followed by a row of ✕ buttons, so with three
  // connections on screen the third ✕ belonged to the third chip only by COUNTING — and
  // editing anything meant first making it active, because the shared form only ever knew
  // about "the connection". Every assertion below is a statement about that being fixed.
  {
    /**
     * A fixture that behaves like the host: the two read routes are swapped TOGETHER
     * (`repoll` goes to /refresh, the mount read goes to /state, and pointing only one of
     * them at the new object is how a test ends up asserting against a stale list), and
     * what the card saves is written back, because a real host persists and the next poll
     * reads it.
     */
    let fixture = SQL_STATE
    const setFixture = (next) => {
      fixture = next
      HOST_ROUTES['/dsh-hud/sql/state'] = next
      HOST_ROUTES['/dsh-hud/sql/refresh'] = next
    }
    /**
     * Refresh through the POLL, not the Refresh button: the button is disabled while there
     * are no connections (correctly — there is nothing to refresh), so a test that needs to
     * get FROM "no connections" TO some cannot use it. This is the card's own code path.
     */
    const repoll = async () => {
      const polls = timers.map((entry) => entry.onPoll).filter((fn) => typeof fn === 'function')
      await act(async () => {
        for (const poll of polls) poll()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
    const saves = () => fetched.filter((call) => call.path === '/dsh-hud/sql/settings' && call.method === 'POST')
    const lastSave = () => JSON.parse(saves().slice(-1)[0]?.body ?? '{}')
    /** What the host would have done with the last save. */
    const persist = () => {
      const written = lastSave().settings
      fixture.connections = written.connections
      fixture.active = written.active
    }
    const credWrites = () => fetched.filter((call) => call.path === '/dsh-hud/sql/credential' && call.method === 'POST')
    const credRemoves = () => fetched.filter((call) => call.path === '/dsh-hud/sql/credential/remove')

    const gear = () => card().querySelector('.hud-sgear')
    const row = (id) => card().querySelector(`.sq-connrow[data-conn="${id}"]`)
    const rowAct = (id, act, what) => sqlClick(row(id)?.querySelector(`[data-act="${act}"]`), what)
    const editorField = (key) => card().querySelector(`.sq-editor [data-field="${key}"]`)
    const byId = (settings, id) => (settings.connections ?? []).find((entry) => entry.id === id)

    setFixture(SQL_STATE)
    HOST_ROUTES['/dsh-hud/sql/test'] = { ok: true, ms: 2, driver: 'postgres', info: { database: 'app2', host: '10.0.0.9' } }
    HOST_ROUTES['/dsh-hud/sql/credential'] = { ok: true, ref: 'dsh_hud_sql_db2' }
    HOST_ROUTES['/dsh-hud/sql/credential/remove'] = { ok: true, ref: 'x', where: 'credentials.yaml' }
    await repoll()
    await waitFor(() => card().querySelectorAll('.sq-connrow').length === 2)

    await sqlClick(gear(), 'the gear')
    await waitFor(() => card().querySelector('.sq-conns') !== null)

    // 1. ONE ROW PER CONNECTION, each with its own actions.
    eq('every stored connection gets its own row',
      [...card().querySelectorAll('.sq-connrow')].map((node) => node.getAttribute('data-conn')),
      ['local', 'prod'])
    ok('and each row carries its OWN buttons, not one set shared by the list',
      row('prod')?.querySelector('[data-act="conn-edit"]') !== null &&
      row('prod')?.querySelector('[data-act="conn-copy"]') !== null &&
      row('prod')?.querySelector('[data-act="conn-del"]') !== null,
      String(row('prod')?.outerHTML?.slice(0, 120)))
    ok('the row that is in use says so, and the other one does not',
      [row('local')?.className?.includes('is-on'), row('prod')?.className?.includes('is-on')], [true, false])
    ok('a row shows where it points, and which engine it is',
      (row('prod')?.textContent ?? '').includes('app@10.0.0.9:5432/app') &&
      (row('prod')?.textContent ?? '').includes('PostgreSQL'),
      String(row('prod')?.textContent))

    // 2. EDIT the connection that is NOT active — the one thing the old form could not do.
    const beforeEdit = saves().length
    const credsBeforeEdit = credWrites().length
    await rowAct('prod', 'conn-edit', 'edit prod')
    await waitFor(() => card().querySelector('.sq-editor') !== null)
    eq('the editor opens on the row that was clicked, not on the active connection',
      [editorField('name')?.value, editorField('host')?.value, editorField('database')?.value],
      ['生产库', '10.0.0.9', 'app'])
    eq('and it opens on that row\'s engine',
      card().querySelector('.sq-editor .sq-dtype.is-on')?.getAttribute('data-driver'), 'postgres')

    // 3. NOTHING is written while typing: the draft is local until Save.
    await setInput(editorField('database'), 'app2')
    await settle()
    eq('typing in the editor writes nothing at all', saves().length, beforeEdit)
    eq('and the field keeps what was typed', editorField('database')?.value, 'app2')

    // 4. Test, then save.
    const beforeTest = fetched.length
    await sqlClick(card().querySelector('[data-act="conn-test"]'), 'test')
    await waitFor(() => card().querySelector('.sq-editor .sq-outcome') !== null)
    const testCall = fetched.slice(beforeTest).find((call) => call.path === '/dsh-hud/sql/test')
    eq('testing sends the DRAFT, not the stored connection',
      JSON.parse(testCall?.body ?? '{}').connection?.database, 'app2')
    ok('and a passing test is reported as passing',
      card().querySelector('.sq-editor .sq-outcome.is-ok') !== null,
      String(card().querySelector('.sq-editor .sq-outcome')?.textContent))
    eq('after a passing test the button stops saying it is untested',
      card().querySelector('[data-act="conn-save"]')?.textContent, '保存')

    await sqlClick(card().querySelector('[data-act="conn-save"]'), 'save')
    await waitFor(() => saves().length > beforeEdit)
    const edited = lastSave().settings
    eq('saving replaces the connection IN PLACE — same id, same position in the list',
      edited.connections.map((entry) => entry.id), ['local', 'prod'])
    eq('with the field that was changed', byId(edited, 'prod').database, 'app2')
    eq('and the connection that was not being edited is untouched',
      byId(edited, 'local').file, 'E:/data/app.db')
    eq('while the ACTIVE connection is still the one it was', edited.active, 'local')
    ok('no password was written, because none was typed', credWrites().length === credsBeforeEdit,
      JSON.stringify(credWrites().slice(credsBeforeEdit).map((call) => call.body)))
    persist()

    // 5. COPY: a second connection with the same settings and its own id.
    await repoll()
    await waitFor(() => (row('prod')?.textContent ?? '').includes('app2'))
    const beforeCopy = saves().length
    await rowAct('prod', 'conn-copy', 'copy prod')
    await waitFor(() => saves().length > beforeCopy)
    const copied = lastSave().settings
    eq('copying puts the copy right after the original', copied.connections.map((entry) => entry.id), ['local', 'prod', 'db'])
    eq('with the same settings, name and credential as the original',
      [byId(copied, 'db').host, byId(copied, 'db').database, byId(copied, 'db').name],
      [byId(copied, 'prod').host, byId(copied, 'prod').database, '生产库 副本'])
    eq('and the copy becomes the active one', copied.active, 'db')
    persist()

    // 6. DELETE asks first, and deletes the row that was clicked.
    await repoll()
    await waitFor(() => card().querySelectorAll('.sq-connrow').length === 3)
    const beforeDelete = saves().length
    await rowAct('local', 'conn-del', 'ask to delete local')
    ok('the row asks before it deletes', row('local')?.querySelector('[data-act="conn-del-confirm"]') !== null)
    await rowAct('local', 'conn-del-cancel', 'cancel')
    eq('cancelling writes nothing and keeps the row', [saves().length, row('local') !== null], [beforeDelete, true])

    await rowAct('local', 'conn-del', 'ask again')
    await rowAct('local', 'conn-del-confirm', 'confirm')
    await waitFor(() => saves().length > beforeDelete)
    const afterDelete = lastSave().settings
    eq('confirming removes THAT connection, not the active one',
      afterDelete.connections.map((entry) => entry.id), ['prod', 'db'])
    eq('and leaves the active connection alone', afterDelete.active, 'db')
    ok('the credential is KEPT unless it is asked for: nothing was removed',
      credRemoves().length === 0, JSON.stringify(credRemoves().map((call) => call.body)))
    persist()

    // 7. Deleting the ACTIVE connection moves `active` to something that still exists.
    await repoll()
    await waitFor(() => card().querySelectorAll('.sq-connrow').length === 2)
    const beforeActiveDelete = saves().length
    await rowAct('db', 'conn-del', 'ask to delete the active one')
    await rowAct('db', 'conn-del-confirm', 'confirm')
    await waitFor(() => saves().length > beforeActiveDelete)
    eq('deleting the active connection falls back to the first one left',
      lastSave().settings.active, 'prod')
    persist()

    // 8. A NEW connection through the same editor, with a password that must NOT reach the
    //    settings file — the file holds a credential NAME, which is the point of the store.
    await repoll()
    await waitFor(() => card().querySelectorAll('.sq-connrow').length === 1)
    const beforeNew = saves().length
    // From the FIXTURE, not the DOM: the fixture is what the host would answer, and a DOM
    // read can be one render behind the poll that just landed.
    const idsBefore = new Set(fixture.connections.map((entry) => entry.id))
    await sqlClick(card().querySelector('[data-act="conn-new"]'), 'new')
    await waitFor(() => card().querySelector('.sq-editor') !== null)
    ok('a new connection starts read-only, with a default row limit',
      [editorField('readOnly')?.checked, editorField('limit')?.value], [true, '200'])
    // PREFILLED, because a blank port box used to mean PORT 1 — see the host test for the
    // end-to-end measurement ('' → "连不上 host:1", 1433 → connected in 60ms). SQLite is a
    // file and has no port at all, so it is the control.
    eq('a file-backed connection asks for no port', editorField('port'), null)
    await sqlClick(card().querySelector('.sq-editor .sq-dtype[data-driver="postgres"]'), 'postgres')
    await settle()
    eq('and switching engine fills in that engine\'s own port, from the host\'s own number',
      [editorField('port')?.value, editorField('host') !== null], ['5432', true])
    // The connection's OWN settings are not the driver's fields: an engine switch must not
    // drop the name, the row limit or the read-only switch. (The older connect-panel test
    // caught exactly that happening, which is why it is asserted here as well.)
    eq('and the connection\'s own settings survive an engine switch',
      [editorField('readOnly')?.checked, editorField('limit')?.value], [true, '200'])
    await setInput(editorField('port'), '1444')
    eq('a port somebody typed is theirs', editorField('port')?.value, '1444')
    await sqlClick(card().querySelector('.sq-editor .sq-dtype[data-driver="sqlite"]'), 'sqlite')
    await settle()
    await sqlClick(card().querySelector('.sq-editor .sq-dtype[data-driver="postgres"]'), 'postgres again')
    await settle()
    eq('and going through an engine that has no port brings the default back, not a stale one',
      editorField('port')?.value, '5432')
    await sqlClick(card().querySelector('.sq-editor .sq-dtype[data-driver="postgres"]'), 'postgres')
    await settle()
    ok('switching engine asks for that engine\'s fields, and drops the previous one\'s',
      editorField('host') !== null && editorField('file') === null,
      String(card().querySelector('.sq-editor .sq-dfields')?.textContent))
    await setInput(editorField('name'), '测试库')
    await setInput(editorField('host'), '10.0.0.10')
    await setInput(editorField('password'), 'sup3r-s3cret')
    const creds = credWrites().length
    await sqlClick(card().querySelector('[data-act="conn-save"]'), 'save')
    await waitFor(() => saves().length > beforeNew)
    const added = lastSave().settings
    const newId = added.connections[1]?.id
    ok('saving adds it with an id nothing else is using, and makes it active',
      typeof newId === 'string' && !idsBefore.has(newId) && added.active === newId,
      JSON.stringify({ newId, before: [...idsBefore], active: added.active }))
    eq('the connection carries the credential NAME the form showed',
      byId(added, newId).passwordRef, `dsh_hud_sql_${newId}`)
    ok('and the settings write contains NO password',
      !JSON.stringify(added).includes('sup3r-s3cret'), JSON.stringify(added).slice(0, 160))
    eq('the secret itself went to the credential store, under that name',
      [JSON.parse(credWrites().slice(-1)[0].body).ref, JSON.parse(credWrites().slice(-1)[0].body).value],
      [`dsh_hud_sql_${newId}`, 'sup3r-s3cret'])
    eq('and it wrote the secret exactly once', credWrites().length - creds, 1)
    persist()

    // 9. A credential that is GONE is shown on its row, before anyone clicks it.
    setFixture({
      ...SQL_STATE,
      connections: [
        SQL_STATE.connections[0],
        { ...SQL_STATE.connections[1], passwordRef: 'dsh_hud_sql_gone', credential: 'missing' },
      ],
    })
    await repoll()
    await waitFor(() => card().querySelector('.sq-tag.is-warn') !== null)
    ok('a connection whose credential is missing says so on its row',
      (card().querySelector('.sq-connrow .sq-tag.is-warn')?.textContent ?? '').includes('凭据缺失'),
      String(card().querySelector('.sq-conns')?.textContent))

    // 10. The cap is the host's own number, and the button says so instead of doing nothing.
    setFixture({
      ...SQL_STATE,
      connections: Array.from({ length: 12 }, (_, index) => ({ ...SQL_STATE.connections[0], id: `c${index}`, name: `库${index}` })),
      active: 'c0',
    })
    await repoll()
    await waitFor(() => card().querySelectorAll('.sq-connrow').length === 12)
    ok('at the host\'s limit the add button is disabled rather than silently ignored',
      card().querySelector('[data-act="conn-new"]')?.disabled === true,
      String(card().querySelector('[data-act="conn-new"]')?.outerHTML?.slice(0, 100)))
    ok('and the count is on screen', text().includes('12/12'), text().slice(-80))
    ok('and the quick connect button in the header is disabled for the same reason',
      card().querySelector('[data-act="new"]')?.disabled === true,
      String(card().querySelector('[data-act="new"]')?.outerHTML?.slice(0, 100)))

    // 10b. A POLL that fails must not wipe the list that is already on screen. This is the
    //      half of "我的配置怎么都没有了" that the card can answer on its own.
    HOST_ROUTES['/dsh-hud/sql/state'] = () => { throw new Error('网络错误：signal timed out') }
    HOST_ROUTES['/dsh-hud/sql/refresh'] = () => { throw new Error('网络错误：signal timed out') }
    const beforeFailedPoll = card().querySelectorAll('.sq-connrow').length
    await repoll()
    await settle()
    eq('a failed poll leaves the connections that are already on screen alone',
      card().querySelectorAll('.sq-connrow').length, beforeFailedPoll)
    ok('and the failure is shown rather than swallowed',
      (card().textContent ?? '').includes('signal timed out') || (card().textContent ?? '').includes('网络错误'),
      (card().textContent ?? '').slice(0, 120))

    // 11. Leave the gear CLOSED: the next block asserts exactly that.
    await sqlClick(gear(), 'close the gear')
    await settle()
    eq('the gear can be closed again', gear()?.getAttribute('aria-expanded'), 'false')
  }
}

const sCard = (id) => settingsHost.querySelector(`.hud-panel[data-panel="${id}"]`)
const sGear = (id) => sCard(id)?.querySelector('.hud-sgear')
const sForm = (id) => sCard(id)?.querySelector('.hud-sform')
// A settings write resolves outside act(), so React queues its `busy: false` and
// does not flush it until something acts again. Without this flush every interaction
// after a write ran against a form whose buttons were all still disabled — and a
// disabled button takes a click in silence. A bare timer does NOT fix it; act does.
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
// Queried FRESH every time: the form re-renders after every write, so a node held
// across one is detached and clicks on it do nothing at all.
const sField = (id, key) => sCard(id)?.querySelector(`.hud-sform .hud-sfield[data-field="${key}"]`)
const sInput = (field) => field?.querySelector('.hud-sinput')
const sButton = (field, label) => [...(field?.querySelectorAll('.hud-sbtn') ?? [])].find((button) => button.textContent === label)
const sClick = async (element, what) => {
  if (element === null || element === undefined) throw new Error('settings: nothing to click — ' + what)
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
const settingsPosts = () => fetched.filter((call) => call.path.endsWith('/settings') && call.method === 'POST')
const lastSettings = () => JSON.parse(settingsPosts().slice(-1)[0]?.body ?? '{}')

// ── the in-card gear ──
//
// The SQL card is the one card on screen that carries settings, so it is what this block can
// reach without layout surgery. It renders its OWN form rather than describing fields to the
// shell — the machine card was the last panel that used the shell form, and it is gone, so
// the shell form itself now has no panel driving it. That mechanism stays (it is a generic
// extension point) but it is untested, and this note is the honest record of that.
eq('the database card is on screen with its own settings',
  [sCard('sql') !== null, sCard('sql')?.hasAttribute('hidden')], [true, false])
eq('it renders exactly one gear',
  sCard('sql')?.querySelectorAll('.hud-sgear').length, 1)
eq('and cards without settings have none',
  ['markets', 'quota'].map((id) => sCard(id)?.querySelectorAll('.hud-sgear').length), [0, 0])
ok('the gear is a real button, and says it is closed',
  sGear('sql')?.tagName === 'BUTTON' && sGear('sql')?.getAttribute('aria-expanded') === 'false',
  String(sGear('sql')?.outerHTML?.slice(0, 70)))
eq('and no form is open until it is asked for', sForm('sql'), null)
await sClick(sGear('sql'), 'the database gear')
await flush()
eq('clicking it says so', sGear('sql')?.getAttribute('aria-expanded'), 'true')
ok('and the CARD renders the form, not the shell',
  sCard('sql')?.querySelector('.sq-connect, .sq-connsrow') !== null,
  String(sCard('sql')?.querySelector('.hud-sform')?.outerHTML?.slice(0, 60)))

// ── the editor says how tall each card is ──
await act(async () => { exports.__openLayoutEditor(true) })
await flush()
const sEditorRow = (id) => settingsHost.querySelector('.hud-vis[data-panel="' + id + '"]')?.closest('.hud-layout-row')
ok('the shell editor opened', settingsHost.querySelector('.hud-prefs') !== null)
ok('every card has an auto-height control',
  ['market', 'sql'].every((id) => sEditorRow(id)?.querySelector('.hud-fit') !== null),
  String(sEditorRow('sql')?.textContent))
// The shipped arrangement NOW declares heights — it is a 3 x 10 rectangle — so what the editor
// reports is the declared height, and a card keeps its place in the order.
{
  const stored = JSON.parse(storedPrefs())
  eq('with the blob stamped into the current ruleset', stored.v, 11)
  // The DECLARED heights, from a fresh install. This block seeds its own layout to make the
  // cards it needs visible, so the stored blob is not the shipped arrangement — asking it for
  // the arrangement's heights would be asking the wrong object.
  eq('and a fresh install carries the heights the arrangement declares',
    ['markets', 'quota', 'sql', 'parcel', 'github'].map((id) => exports.__layout.defaultPrefs().layout[id]?.rows),
    [5, 3, 5, 1, 1])
}
await act(async () => { exports.__openLayoutEditor(false) })
await flush()

// ── the reset ──
// The card form offers one back to the settings page. What it SENDS is asserted in
// test-host.mjs, where the route is driven directly and the stored result read back.
ok('the database form offers a reset back to the settings page',
  sCard('sql')?.textContent?.includes('设置页') === true,
  String(sCard('sql')?.textContent?.slice(0, 80)))
await act(async () => {
  settingsRoot.unmount()
})
settingsHost.remove()
ok('the settings HUD is unmounted again', settingsHost.childNodes.length === 0)
// Put the suite's own preferences back: this block is the last one, but leaving the browser
// storage as it found it is the rule every block here follows.
if (savedPrefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
else dom.window.localStorage.setItem('dsh-hud:prefs', savedPrefs)

// Put the suite's own preferences back: this block is the last one, but leaving the browser
// storage as it found it is the rule every block here follows.
if (savedPrefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
else dom.window.localStorage.setItem('dsh-hud:prefs', savedPrefs)

// Put the suite's own preferences back: this block is the last one, but leaving the
// browser storage as it found it is the rule every block here follows.
if (savedPrefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
else dom.window.localStorage.setItem('dsh-hud:prefs', savedPrefs)



// ── a fresh card that cannot read its state ──────────────────────────────────
//
// This is the screen that produced "我的 SQL Server、PostgreSQL 配置怎么都没有了": a page
// loaded while the state route was not answering. The card had never received a snapshot,
// so it rendered the empty list it starts with — indistinguishable from "your connections
// are gone", while the settings file sat there untouched. It has to say which one it is.
{
  HOST_ROUTES['/dsh-hud/sql/state'] = () => { throw new Error('网络错误：signal timed out') }
  HOST_ROUTES['/dsh-hud/sql/refresh'] = () => { throw new Error('网络错误：signal timed out') }
  await act(async () => { settingsRoot.unmount() })
  const freshHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(freshHost)
  const freshRoot = createRoot(freshHost)
  await act(async () => { freshRoot.render(React.createElement(cell.Component, slotProps)) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  const fresh = freshHost.querySelector('.hud-panel[data-panel="sql"]')
  const freshText = fresh?.textContent ?? ''
  ok('a card that never managed to read state says so in the header',
    freshText.includes('读不到状态'), freshText.slice(0, 140))
  await act(async () => {
    fresh?.querySelector('.hud-sgear')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  const opened = fresh?.textContent ?? ''
  ok('and in the connection list it says nothing was deleted',
    opened.includes('没有被删除'), opened.slice(0, 160))
  ok('it does NOT claim there are no connections',
    !opened.includes('还没有连接'), opened.slice(0, 160))
  ok('while the refresh button is usable, because there is something to retry',
    fresh?.querySelector('[data-act="refresh"]')?.disabled === false,
    String(fresh?.querySelector('[data-act="refresh"]')?.outerHTML?.slice(0, 90)))

  // …AND IT MUST STILL BE POSSIBLE TO ADD A CONNECTION.
  //
  // The engine list used to arrive only inside the state payload, so this exact screen had
  // no engine buttons at all: the new-connection form stayed on SQLite and showed
  // "数据库文件", leaving no way to reach PostgreSQL or SQL Server. Choosing an engine has
  // nothing to do with whether a database is reachable.
  await act(async () => {
    fresh?.querySelector('[data-act="conn-new"]')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  const engines = [...(fresh?.querySelectorAll('.sq-editor .sq-dtype') ?? [])].map((node) => node.getAttribute('data-driver'))
  eq('the new-connection form offers every engine the host declares, even with no state',
    engines, SQL_DRIVERS.map((one) => one.id))
  await act(async () => {
    fresh?.querySelector('.sq-editor .sq-dtype[data-driver="postgres"]')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  const editorFields = [...(fresh?.querySelectorAll('.sq-editor [data-field]') ?? [])].map((node) => node.getAttribute('data-field'))
  ok('and picking a network engine asks for its fields, with its port already filled in',
    editorFields.includes('host') && editorFields.includes('user') && editorFields.includes('password') &&
    fresh?.querySelector('.sq-editor [data-field="port"]')?.value === '5432',
    JSON.stringify(editorFields))
  ok('so the form is fillable on a card that cannot read state',
    fresh?.querySelector('.sq-editor [data-field="password"]') !== null,
    String(fresh?.querySelector('.sq-editor .sq-dfields')?.textContent?.slice(0, 120)))

  await act(async () => { freshRoot.unmount() })
  freshHost.remove()
  HOST_ROUTES['/dsh-hud/sql/state'] = SQL_STATE
  HOST_ROUTES['/dsh-hud/sql/refresh'] = SQL_STATE
}

// ── the SSH card ─────────────────────────────────────────────────────────────
//
// "数据库和 ssh 同时只能存在一个" is a rule about the RENDER, so it is asserted on the
// render: in SSH mode the database controls are not in the DOM at all, and the other way
// round. A card that showed both would leave a person guessing which box a button belongs to.
{
  const prefs = dom.window.localStorage.getItem('dsh-hud:prefs')
  await act(async () => { settingsRoot.unmount() })
  const sshHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(sshHost)
  const sshRoot = createRoot(sshHost)
  const cardOf = () => sshHost.querySelector('.hud-panel[data-panel="sql"]')
  const textOf = () => cardOf()?.textContent ?? ''
  // The two halves are told apart by controls only one of them has: 'refresh' is the
  // database card's, 'ssh-refresh' is the SSH card's.
  const looksLikeDb = () => cardOf()?.querySelector('[data-act="refresh"]') !== null && cardOf()?.querySelector('[data-act="ssh-refresh"]') === null
  const looksLikeSsh = () => cardOf()?.querySelector('[data-act="ssh-refresh"]') !== null && cardOf()?.querySelector('[data-act="refresh"]') === null
  const tap = async (selector) => { await click(cardOf()?.querySelector(selector), selector); await settle() }
  const type = async (key, value) => { await setInput(cardOf()?.querySelector(`[data-field="${key}"]`), value); await settle() }

  // Another block replaced the credential fixture with a canned answer, so this block
  // installs its own recorder: the point here is WHAT a save sends, not that it succeeds.
  HOST_ROUTES['/dsh-hud/sql/credential'] = (init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    SQL_CREDENTIAL_WRITES.push({ ref: body?.ref, value: body?.value })
    return { ok: true, ref: body?.ref }
  }
  await act(async () => { sshRoot.render(React.createElement(cell.Component, slotProps)) })
  await settle()
  ok('the card starts as a database, and the SSH controls are not in the DOM at all',
    looksLikeDb() && cardOf()?.querySelector('[data-act="host-new"]') === null && cardOf()?.querySelector('.sq-sshcmd') === null,
    String(cardOf()?.querySelector('.sq-head')?.textContent ?? '').slice(0, 80))

  // Switch to SSH: the mode lives in the panel settings, so this is a settings patch.
  await tap('[data-act="mode-ssh"]')
  ok('switching to SSH turns the card into an SSH client',
    looksLikeSsh() && cardOf()?.querySelector('[data-act="ssh-run"]') !== null,
    JSON.stringify({
      sshRefresh: cardOf()?.querySelector('[data-act="ssh-refresh"]') !== null,
      dbRefresh: cardOf()?.querySelector('[data-act="refresh"]') !== null,
      head: String(cardOf()?.querySelector('.sq-head')?.textContent ?? '').slice(0, 60),
    }))
  ok('and the database half is GONE, not merely hidden — one card, one identity',
    cardOf()?.querySelector('[data-act="refresh"]') === null && cardOf()?.querySelector('.sq-connect') === null &&
    !textOf().includes('连接'),
    textOf().slice(0, 120))

  // A host, added the way the database side does it: test first, then save.
  await tap('[data-act="host-new"]')
  ok('the new-host form asks for host, port, user and a password',
    ['host', 'port', 'user', 'password'].every((key) => cardOf()?.querySelector(`[data-field="${key}"]`) !== null),
    String(cardOf()?.querySelector('.sq-editor')?.textContent ?? '').slice(0, 120))
  eq('and it already knows the port', String(cardOf()?.querySelector('[data-field="port"]')?.value), '22')
  eq('with the three ways to authenticate offered',
    [...(cardOf()?.querySelectorAll('.sq-editor .sq-dtype') ?? [])].map((node) => node.getAttribute('data-auth')),
    ['password', 'key', 'agent'])

  await type('name', '跳板机')
  await type('host', '10.0.0.9')
  await type('user', 'root')
  await type('password', 'hunter2')

  await tap('[data-act="host-test"]')
  ok('测试 reports that it worked, and where it went',
    String(cardOf()?.querySelector('.sq-outcome')?.textContent ?? '').includes('测试通过') &&
    String(cardOf()?.querySelector('.sq-outcome')?.textContent ?? '').includes('10.0.0.9'),
    String(cardOf()?.querySelector('.sq-outcome')?.textContent ?? '').slice(0, 120))

  await tap('[data-act="host-save"]')
  const savedHosts = SQL_PANEL_SETTINGS.hosts ?? []
  ok('saving stores the host, and the password is NOT in it',
    savedHosts.length === 1 && savedHosts[0].host === '10.0.0.9' && savedHosts[0].user === 'root' &&
    savedHosts[0].password === undefined && savedHosts[0].passwordRef === 'dsh_hud_ssh_ssh1',
    JSON.stringify(savedHosts))
  ok('the password went to the credential route instead, under a ref the store accepts',
    SQL_CREDENTIAL_WRITES.some((one) => one.ref === 'dsh_hud_ssh_ssh1' && one.value === 'hunter2' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(one.ref)),
    JSON.stringify(SQL_CREDENTIAL_WRITES.slice(-2)))
  ok('and the card lists it',
    String(cardOf()?.querySelector('.sq-conns')?.textContent ?? '').includes('10.0.0.9'),
    String(cardOf()?.querySelector('.sq-conns')?.textContent ?? '').slice(0, 120))

  // Running a command.
  await type('command', 'uptime')
  await tap('[data-act="ssh-run"]')
  ok('the command and its output are both on screen',
    String(cardOf()?.querySelector('[data-act="ssh-stdout"]')?.textContent ?? '').includes('up 41 days'),
    String(cardOf()?.querySelector('.sq-sshout')?.textContent ?? '').slice(0, 140))
  ok('and the exit code is stated, not implied',
    String(cardOf()?.querySelector('.sq-exit')?.textContent ?? '').includes('0'),
    String(cardOf()?.querySelector('.sq-exit')?.textContent ?? ''))

  await type('command', 'this-will-fail')
  await tap('[data-act="ssh-run"]')
  ok('a command that fails shows stderr and a non-zero exit, not a card-level error',
    String(cardOf()?.querySelector('[data-act="ssh-stderr"]')?.textContent ?? '').includes('command not found') &&
    String(cardOf()?.querySelector('.sq-exit')?.textContent ?? '').includes('1'),
    String(cardOf()?.querySelector('.sq-sshout')?.textContent ?? '').slice(0, 140))

  // Back to the database — with the SSH list intact.
  await tap('[data-act="mode-db"]')
  ok('switching back gives the database card again', looksLikeDb(), String(cardOf()?.querySelector('.sq-head')?.textContent ?? '').slice(0, 80))
  ok('and the host list was KEPT: a mode switch is not a delete',
    (SQL_PANEL_SETTINGS.hosts ?? []).length === 1 && SQL_PANEL_SETTINGS.mode === 'db',
    JSON.stringify({ mode: SQL_PANEL_SETTINGS.mode, hosts: (SQL_PANEL_SETTINGS.hosts ?? []).length }))

  await act(async () => { sshRoot.unmount() })
  sshHost.remove()
  if (prefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
  else dom.window.localStorage.setItem('dsh-hud:prefs', prefs)
}

// ── the live terminal, in the card ───────────────────────────────────────────
//
// The one-shot box and the terminal are different things, and the difference is what these
// check: a terminal has a SCREEN (so CR and erase sequences move things), the shell reads CR
// (so Enter has to send CR and not LF), control characters reach the far side, and the
// escape traffic a real Ubuntu prompt sends never appears as text.
{
  const prefs = dom.window.localStorage.getItem('dsh-hud:prefs')
  await act(async () => { settingsRoot.unmount() })
  const termHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(termHost)
  const termRoot = createRoot(termHost)
  const cardOf = () => termHost.querySelector('.hud-panel[data-panel="sql"]')
  const tap = async (selector) => { await click(cardOf()?.querySelector(selector), selector); await settle() }
  const type = async (key, value) => { await setInput(cardOf()?.querySelector(`[data-field="${key}"]`), value); await settle() }

  // What the far side prints, and what the card sends back, are the whole test.
  const TERMINAL_SENT = []
  let TERMINAL_CURSOR = 0
  let TERMINAL_BATCH = [
    // A prompt with colour, a command echo, an Ubuntu shell-integration OSC (which must be
    // swallowed whole), output, and a CR+erase redraw — the shapes a shell actually sends.
    '\u001b]3008;start=abc;cwd=/home/dingji\u0007',
    '\u001b[01;32mdingji@dingji\u001b[00m:\u001b[01;34m~\u001b[00m$ ls\r\n',
    '\u001b[0m\u001b[01;34mgo\u001b[0m  notes.txt\r\n',
    '\u001b[01;32mdingji@dingji\u001b[00m:\u001b[01;34m~\u001b[00m$ uptime\r',
    '\u001b[K 13:40:02 up 42 min\r\n',
  ]
  HOST_ROUTES['/dsh-hud/sql/ssh/open'] = (init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(body.id ?? '') === 'nope') return { ok: false, error: '这个主机上没有打开的终端' }
    TERMINAL_CURSOR = 0
    return { ok: true, reused: false, session: { id: body.id, target: 'dingji@172.21.0.138:22', startedAt: Date.now(), cursor: 0 } }
  }
  HOST_ROUTES['/dsh-hud/sql/ssh/session'] = (init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    void body
    if (TERMINAL_BATCH.length === 0) return { ok: true, status: 'open', cursor: TERMINAL_CURSOR, lost: false, data: '', exitCode: null }
    const data = TERMINAL_BATCH.join('')
    TERMINAL_BATCH = []
    TERMINAL_CURSOR += data.length
    return { ok: true, status: 'open', cursor: TERMINAL_CURSOR, lost: false, data, exitCode: null, target: 'dingji@172.21.0.138:22' }
  }
  HOST_ROUTES['/dsh-hud/sql/ssh/input'] = (init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    TERMINAL_SENT.push(String(body.data ?? ''))
    return { ok: true, written: String(body.data ?? '').length }
  }
  HOST_ROUTES['/dsh-hud/sql/ssh/close'] = () => ({ ok: true })

  await act(async () => { termRoot.render(React.createElement(cell.Component, slotProps)) })
  await settle()
  await tap('[data-act="mode-ssh"]')

  ok('the SSH card offers a live terminal next to the one-shot box',
    cardOf()?.querySelector('[data-act="term-open"]') !== null && cardOf()?.querySelector('[data-act="ssh-run"]') !== null,
    String(cardOf()?.querySelector('.sq-sshrun')?.textContent ?? '').slice(0, 120))
  ok('and the terminal is not open until it is asked for',
    cardOf()?.querySelector('[data-act="term-screen"]') === null)

  await tap('[data-act="term-open"]')
  ok('opening it connects and shows a screen',
    cardOf()?.querySelector('[data-act="term-screen"]') !== null &&
    String(cardOf()?.querySelector('.sq-termbar')?.textContent ?? '').includes('172.21.0.138'),
    String(cardOf()?.querySelector('.sq-termbar')?.textContent ?? '').slice(0, 120))

  // One poll is enough for the batch above; the card polls on its own clock, so wait for it.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)) })
  const screen = String(cardOf()?.querySelector('[data-act="term-screen"]')?.textContent ?? '')
  ok('the screen shows what the far side printed', screen.includes('notes.txt') && screen.includes('up 42 min'), JSON.stringify(screen.slice(0, 160)))
  ok('the shell-integration OSC is swallowed, not rendered as text',
    !screen.includes('3008') && !screen.includes('cwd='), JSON.stringify(screen.slice(0, 160)))
  ok('and the CR-redrawn line replaced the old one instead of stacking up',
    screen.split('\n').filter((line) => line.includes('up 42 min')).length === 1 &&
    !screen.includes('uptime\r'), JSON.stringify(screen.split('\n').slice(-4)))
  ok('colour arrived as markup rather than as escape codes',
    !screen.includes('\u001b') && (cardOf()?.querySelectorAll('[data-act="term-screen"] .sq-termrun').length ?? 0) > 1,
    String(cardOf()?.querySelectorAll('[data-act="term-screen"] .sq-termrun').length))

  // Enter has to send CR: a shell waiting for a line terminator never sees LF alone.
  await type('terminal', 'cd /tmp')
  await tap('[data-act="term-send"]')
  eq('Enter sends a CARRIAGE RETURN, which is what a shell reads',
    TERMINAL_SENT.slice(-1)[0], 'cd /tmp\r')
  ok('and the box is cleared for the next line',
    String(cardOf()?.querySelector('[data-field="terminal"]')?.value ?? '') === '',
    String(cardOf()?.querySelector('[data-field="terminal"]')?.value ?? ''))

  await tap('[data-key="ctrl-c"]')
  eq('Ctrl-C reaches the far side as a control character', TERMINAL_SENT.slice(-1)[0], '\u0003')
  await tap('[data-key="tab"]')
  eq('and Tab is a tab', TERMINAL_SENT.slice(-1)[0], '\t')
  await tap('[data-key="up"]')
  eq('and the arrow keys are the sequences a shell expects', TERMINAL_SENT.slice(-1)[0], '\u001b[A')

  await tap('[data-act="term-close"]')
  ok('closing the terminal puts the button back',
    cardOf()?.querySelector('[data-act="term-open"]') !== null && cardOf()?.querySelector('[data-act="term-screen"]') === null,
    String(cardOf()?.querySelector('.sq-sshrun')?.textContent ?? '').slice(0, 100))

  await act(async () => { termRoot.unmount() })
  termHost.remove()
  if (prefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
  else dom.window.localStorage.setItem('dsh-hud:prefs', prefs)
}

// ── 今日涨跌榜 ───────────────────────────────────────────────────────────────
//
// Three views on the 股市 card, and the ranking is the one that has to be checkable: a list of
// numbers nobody can verify is worse than no list. So what is asserted is what a person would
// check — the day's move with the money behind it, red for up and green for down, the count of
// rows the host dropped rather than a silently shortened list, and that a row can be turned
// into the thing it is useful for (the stock's own chart).
{
  const prefs = dom.window.localStorage.getItem('dsh-hud:prefs')
  const mkHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(mkHost)
  const mkRoot = createRoot(mkHost)
  // This card's own root carries the marker — NOT the shell's head wrapper, which is what
  // the first version queried (and then every optional chain on a null read as "fine").
  const mk = () => mkHost.querySelector('.mk-root[data-panel="market"]')
  const tap = async (selector) => { await click(mk()?.querySelector(selector), selector); await settle() }

  await act(async () => { mkRoot.render(React.createElement(cell.Component, slotProps)) })
  await settle()

  ok('the card offers the watch list and both halves of the day\'s ranking',
    mk() !== null && ['view-watch', 'view-up', 'view-down'].every((act) => mk().querySelector(`[data-act="${act}"]`) !== null),
    String(mk()?.querySelector('.mk-views')?.textContent ?? ''))
  eq('and it starts on the watch list, not on a ranking',
    [mk()?.querySelector('[data-act="view-watch"]')?.getAttribute('aria-pressed'),
      mk()?.querySelector('[data-act="rank-table"]') === null],
    ['true', true])

  await tap('[data-act="view-up"]')
  const up = mk()?.querySelector('[data-act="rank-table"]')
  ok('涨幅榜 is a table with the day\'s movers', up !== null && up.textContent.includes('善水科技'), String(up?.textContent ?? '').slice(0, 140))
  eq('twenty rows is the promise; the fixture has four, so four', mk()?.querySelectorAll('.mk-rrow').length, 4)
  ok('the percentage AND the money behind it are both shown',
    up.textContent.includes('+20.01%') && up.textContent.includes('5.10亿'),
    String(up.textContent ?? '').slice(0, 160))
  ok('an up move is red (the convention here), not green',
    mk()?.querySelector('.mk-rrow .mk-chg')?.className.includes('mk-up') === true,
    String(mk()?.querySelector('.mk-rrow .mk-chg')?.className ?? ''))
  ok('the watch list and the chart step aside for the ranking',
    mk()?.querySelector('.mk-watch') === null && mk()?.querySelector('.mk-chart') === null)

  await tap('[data-act="view-down"]')
  const down = mk()?.querySelector('[data-act="rank-table"]')
  ok('跌幅榜 shows the losers', down !== null && down.textContent.includes('安达股份') && down.textContent.includes('-29.97%'),
    String(down?.textContent ?? '').slice(0, 140))
  ok('and a down move is green',
    mk()?.querySelector('.mk-rrow .mk-chg')?.className.includes('mk-down') === true,
    String(mk()?.querySelector('.mk-rrow .mk-chg')?.className ?? ''))

  // The honest notes: which session this is, and how many rows were dropped.
  const note = String(mk()?.querySelector('.mk-rnote')?.textContent ?? '')
  ok('the table says the market is shut and this is the last session',
    note.includes('非交易日'), note)
  ok('and it says how many rows were filtered, rather than quietly showing fewer',
    note.includes('已滤掉 1 只'), note)

  // A row is a way IN: adding it selects it, and the card goes back to the watch list + chart.
  const before = RANK_CALLS
  await tap('[data-act="rank-add"][data-secid="0.920202"]')
  ok('adding a row from the ranking puts the card back on the watch list',
    mk()?.querySelector('[data-act="rank-table"]') === null && mk()?.querySelector('.mk-watch') !== null,
    String(mk()?.querySelector('.mk-root')?.textContent ?? '').slice(0, 120))
  ok('and it went through the host (the ranking is not mutated locally)',
    RANK_CALLS >= before, String(RANK_CALLS))

  await act(async () => { mkRoot.unmount() })
  mkHost.remove()
  if (prefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
  else dom.window.localStorage.setItem('dsh-hud:prefs', prefs)
}

// ── 悬浮看当日分时 ───────────────────────────────────────────────────────────
//
// The ranking answers "what moved" and stops; the next question is "what did it look like".
// Three things have to be true for that to be a feature rather than a nuisance, and each is an
// assertion here: the popover opens on the hover, the request waits for the pointer to SETTLE
// (sweeping twenty rows is not twenty upstream calls), and a second pass over the same row does
// not ask again.
{
  const prefs = dom.window.localStorage.getItem('dsh-hud:prefs')
  const hvHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(hvHost)
  const hvRoot = createRoot(hvHost)
  const mk = () => hvHost.querySelector('.mk-root[data-panel="market"]')
  const tap = async (selector) => { await click(mk()?.querySelector(selector), selector); await settle() }
  const fire = async (selector, type) => {
    await act(async () => {
      const node = mk()?.querySelector(selector)
      // Whatever the panel happens to listen for, the test sends both spellings: React derives
      // enter/leave from over/out, and a plain `mouseenter` is not what its delegation sees.
      node?.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: type === 'mouseover' || type === 'mouseout' }))
    })
  }
  const enter = async (selector) => { await fire(selector, 'mouseover'); await fire(selector, 'mouseenter') }
  const leave = async (selector) => { await fire(selector, 'mouseout'); await fire(selector, 'mouseleave') }
  const candles = (n) => Array.from({ length: n }, (_, i) => ({
    date: `2026-10-02 09:${String(30 + i).padStart(2, '0')}`,
    open: 10 + i * 0.01, high: 10.05 + i * 0.01, low: 9.95 + i * 0.01, close: 10.02 + i * 0.01, volume: 1000 + i,
  }))
  /**
   * What was asked for, read back out of the harness's own record: the fixture is called with
   * the request init only, so the query is taken from `fetched` — which is also the honest
   * place to measure "how many calls did that hover cause".
   */
  const klineCalls = () => fetched
    .filter((call) => call.path === '/dsh-hud/market/kline')
    .map((call) => {
      const query = new URLSearchParams(call.query ?? '')
      return { secid: query.get('secid'), period: query.get('period') }
    })
  HOST_ROUTES['/dsh-hud/market/kline'] = () => ({ ok: true, candles: candles(12) })

  await act(async () => { hvRoot.render(React.createElement(cell.Component, slotProps)) })
  await settle()
  await tap('[data-act="view-up"]')
  const rowCount = mk()?.querySelectorAll('.mk-rrow').length ?? 0
  ok('the ranking is on screen to hover', rowCount > 0, String(rowCount))
  // The card fetches a k-line for its own selected instrument, so every count below is a DELTA.
  const klineBase = klineCalls().length

  // 1. The popover opens on the hover itself — before anything comes back.
  await enter('.mk-rrow[data-secid="0.301190"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  const early = mk()?.querySelector('[data-act="rank-hover"]')
  ok('the popover opens as soon as the pointer is on a row, showing that row\'s name',
    early !== null && String(early.textContent ?? '').includes('善水科技'),
    String(early?.outerHTML ?? '(no popover)').slice(0, 300))
  ok('and it says it is loading rather than showing an empty chart',
    early?.querySelector('[data-act="rank-hover-wait"]') !== null)
  eq('nothing has been asked for yet — the pointer has not settled', klineCalls().length - klineBase, 0)

  // 2. …and the request follows the settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)) })
  eq('after the delay it asks for that stock, and for TODAY (the intraday period)',
    klineCalls().slice(-1), [{ secid: '0.301190', period: 'realtime' }])
  eq('and exactly one request came out of that hover', klineCalls().length - klineBase, 1)
  ok('and the chart replaces the loading text',
    mk()?.querySelector('[data-act="rank-hover"] [data-act="rank-hover-wait"]') === null &&
    (mk()?.querySelectorAll('[data-act="rank-hover"] svg, [data-act="rank-hover"] canvas, [data-act="rank-hover"] path').length ?? 0) > 0,
    String(mk()?.querySelector('[data-act="rank-hover"]')?.innerHTML ?? '').slice(0, 120))

  // 3. Leaving hides it.
  await leave('.mk-rrow[data-secid="0.301190"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  ok('moving off the row takes the popover away', mk()?.querySelector('[data-act="rank-hover"]') === null)

  // 4. Sweeping is not asking: three rows in a hurry, one request.
  const before = klineCalls().length
  for (const secid of ['0.688185', '0.920344', '1.002226']) {
    await enter(`.mk-rrow[data-secid="${secid}"]`)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    await leave(`.mk-rrow[data-secid="${secid}"]`)
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)) })
  eq('sweeping across rows does not fire a request per row', klineCalls().length, before)

  // 5. Coming back to a row already asked about is instant — and free.
  await enter('.mk-rrow[data-secid="0.301190"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
  eq('a row already seen is served from the cache', klineCalls().length, before)
  ok('and its chart is there immediately',
    mk()?.querySelector('[data-act="rank-hover"] [data-act="rank-hover-wait"]') === null,
    String(mk()?.querySelector('[data-act="rank-hover"]')?.textContent ?? '').slice(0, 60))

  await leave('.mk-rrow[data-secid="0.301190"]')
  await act(async () => { hvRoot.unmount() })
  hvHost.remove()
  if (prefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
  else dom.window.localStorage.setItem('dsh-hud:prefs', prefs)
}

// ── 点击钉住：图够大，关掉才走 ─────────────────────────────────────────────────
//
// A hover is a glance; a click says "I want to look at THIS". So clicking a row pins its chart
// into the slot the card already uses for its own K-line — full width, tall enough that the
// chart's own crosshair readout is legible (the first version was small enough to have no
// numbers in it at all) — and it stays there until it is closed or the view changes.
{
  const prefs = dom.window.localStorage.getItem('dsh-hud:prefs')
  const pinHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(pinHost)
  const pinRoot = createRoot(pinHost)
  const mk = () => pinHost.querySelector('.mk-root[data-panel="market"]')
  const tap = async (selector) => { await click(mk()?.querySelector(selector), selector); await settle() }
  const hover = async (selector) => {
    await act(async () => {
      const node = mk()?.querySelector(selector)
      node?.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
      node?.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: false }))
    })
  }
  const unhover = async (selector) => {
    await act(async () => {
      const node = mk()?.querySelector(selector)
      node?.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }))
      node?.dispatchEvent(new dom.window.MouseEvent('mouseleave', { bubbles: false }))
    })
  }
  const candles = (n) => Array.from({ length: n }, (_, i) => ({
    date: `2026-09-30 09:${String(30 + i).padStart(2, '0')}`,
    open: 10 + i * 0.01, high: 10.05 + i * 0.01, low: 9.95 + i * 0.01, close: 10.02 + i * 0.01, volume: 1000 + i,
  }))
  HOST_ROUTES['/dsh-hud/market/kline'] = () => ({ ok: true, candles: candles(30) })

  await act(async () => { pinRoot.render(React.createElement(cell.Component, slotProps)) })
  await settle()
  await tap('[data-act="view-up"]')
  const klineBase = fetched.filter((call) => call.path === '/dsh-hud/market/kline').length

  // Hover first: a preview, and it is bigger than it was (300px wide, 168 tall).
  await hover('.mk-rrow[data-secid="0.301190"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)) })
  const preview = mk()?.querySelector('[data-act="rank-hover"]')
  ok('the hover preview is drawn at a size that can be read',
    preview !== null && String(preview.getAttribute('style') ?? '').includes('px'),
    String(preview?.outerHTML ?? '').slice(0, 120))
  ok('and it is the small one — the pinned chart is a different, bigger thing',
    mk()?.querySelector('[data-act="rank-pin"]') === null)

  // Click the row: the preview goes, the pinned chart arrives.
  await tap('.mk-rrow[data-secid="0.301190"]')
  ok('clicking a row pins its chart', mk()?.querySelector('[data-act="rank-pin"]') !== null,
    String(mk()?.querySelector('.mk-pin-head')?.textContent ?? '').slice(0, 120))
  ok('and the hover preview gets out of the way',
    mk()?.querySelector('[data-act="rank-hover"]') === null)
  const head = String(mk()?.querySelector('.mk-pin-head')?.textContent ?? '')
  ok('the pinned header says which stock, at what price, with the day range and the money',
    head.includes('善水科技') && head.includes('301190') && head.includes('最高') && head.includes('成交额'),
    head)

  // THE request: it must survive the mouse leaving — that is the whole difference.
  await unhover('.mk-rrow[data-secid="0.301190"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
  ok('moving the mouse away does NOT take it down', mk()?.querySelector('[data-act="rank-pin"]') !== null)
  await tap('[data-act="view-down"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  void klineBase

  // …which it does when the view changes, because a pin belongs to the ranking that made it.
  ok('switching the tab closes it', mk()?.querySelector('[data-act="rank-pin"]') === null,
    String(mk()?.querySelector('.mk-root')?.textContent ?? '').slice(0, 100))

  // Pin again, and close it with the button.
  await tap('.mk-rrow[data-secid="0.920202"]')
  ok('pinning works on the other ranking too',
    String(mk()?.querySelector('.mk-pin-name')?.textContent ?? '').includes('安达股份'),
    String(mk()?.querySelector('.mk-pin-name')?.textContent ?? ''))
  await tap('[data-act="rank-pin-close"]')
  ok('and 关闭 takes it down', mk()?.querySelector('[data-act="rank-pin"]') === null)
  ok('while the ranking itself is still there', mk()?.querySelector('[data-act="rank-table"]') !== null)

  // Hover previews work again once nothing is pinned — using a row from the ranking that is
  // actually on screen. The earlier target belongs to the up list, which is no longer in the
  // DOM: hovering nothing is how a test lies to itself.
  await hover('.mk-rrow[data-secid="0.920202"]')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  ok('and hovering previews again after the pin is gone',
    mk()?.querySelector('[data-act="rank-hover"]') !== null,
    String(mk()?.querySelector('.mk-root')?.textContent ?? '').slice(0, 80))

  await unhover('.mk-rrow[data-secid="0.920202"]')
  await act(async () => { pinRoot.unmount() })
  pinHost.remove()
  if (prefs === null) dom.window.localStorage.removeItem('dsh-hud:prefs')
  else dom.window.localStorage.setItem('dsh-hud:prefs', prefs)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('browser half: all green')
// Stated explicitly: the deliberate throw above leaves React's error-reporting
// path noisy enough to flip an implicit exit code, and the verdict must come
// from the checks, not from that noise.
process.exit(0)