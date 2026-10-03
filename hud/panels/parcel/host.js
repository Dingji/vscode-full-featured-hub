// @ts-check
/**
 * dsh-hud › parcel panel — host half.
 *
 * Tracks Chinese courier shipments: watch list, poll, normalized timeline,
 * change detection (so the HUD can behave like a push feed), persistence.
 *
 * ── the one thing that works without a key ────────────────────────────────
 *
 *   GET https://www.kuaidi100.com/query?type=<com>&postid=<nu>&phone=&temp=<r>
 *   → { message, nu, ischeck, com, status, condition, state, data: [
 *         { time, ftime, context } ] }
 *
 * Every alternative was probed from the target machine before this file was
 * written, and every one of them needs credentials:
 *
 *   快递鸟 kdniao       → "EBusinessID不能为空"
 *   17TRACK             → 401 "Access token is invalid"
 *   快递100 autonumber  → "701 key缺失"  (auto carrier detection now needs a key)
 *   快递100 订阅推送     → needs an enterprise customer+key AND a publicly
 *                         reachable callback URL, which a desktop plugin has not
 *                         got. See "push" below.
 *
 * ── what the payload does and does not contain ────────────────────────────
 *
 * A track node carries EXACTLY `time`, `context`, `ftime` — verified by
 * unioning the keys of every node in a live response. There is no latitude, no
 * longitude, no areaCode: **the data cannot place a parcel on a map**, so this
 * panel does not pretend to. The location is whatever the scan text says
 * ("【邢台市】…"), shown as text and clearly labelled as such.
 *
 * ── carrier codes are VERIFIED, not guessed ───────────────────────────────
 *
 * `query` rejects an unknown `com` with `参数错误`, which makes the code list
 * testable: every code below was sent to the live endpoint with a throwaway
 * number and kept only when the answer came back `ok`. That probe rejected
 * tiantian, xiyoute, feikang, pingandad, gdkj, gtongsudi, nantian, meiguo and
 * sto — all of which circulate in blog posts and none of which work today.
 *
 * ── "push" ────────────────────────────────────────────────────────────────
 *
 * There is no server push here and there cannot be one without a business
 * account and a public endpoint. What this does instead is behave like one
 * locally: each refresh compares a change key (newest node's ftime + node
 * count + signed flag); when it moves, the parcel is marked unread, the tab
 * badge counts it, and the UI highlights the new nodes. Polling is deliberately
 * slower than the weather's — a parcel moves a handful of times a day, and the
 * public endpoint is rate-limited — so `refreshMs` defaults to 15 minutes.
 */

import { live } from '../../lib/host-kit.js'

export const id = 'parcel'
export const order = 40
export const label = { zh: '快递', en: 'Parcels' }

export const storageDomain = 'dsh-hud/parcel'

/** Pure helpers, exported for the test harness. */
export const __test = {
  normalizeNumber,
  carriers,
  carrierByCode,
  detectCarriers,
  stateInfo,
  normalizeNodes,
  summarize,
  locationOf,
  changeKey,
  parseQueryResponse,
}

// ── constants ──────────────────────────────────────────────────────────────
const QUERY_URL = 'https://www.kuaidi100.com/query'
const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 3_000
/** Client poll cadence. */
const DEFAULT_POLL_MS = 300_000
const MIN_POLL_MS = 60_000
/** Per-parcel upstream cache window — the endpoint is rate limited and a
 *  shipment moves a few times a day, not a few times a minute. */
const DEFAULT_REFRESH_MS = 900_000
const MIN_REFRESH_MS = 300_000
/** Most parcels the panel will watch. */
const MAX_PARCELS = 30
/** Timeline nodes kept per parcel (the API can return hundreds). */
const MAX_NODES = 60

/**
 * Courier codes, verified against the live endpoint (see the banner). `patterns`
 * drive the OFFLINE detector: weight 3 is an unambiguous prefix, 2 a structured
 * form, 1 a length/leading-digit guess that the user is expected to confirm.
 */
const CARRIERS = [
  { code: 'shunfeng', name: '顺丰速运', patterns: [[/^SF\d{12,15}$/i, 3]] },
  { code: 'jtexpress', name: '极兔速递', patterns: [[/^JT\d{10,13}$/i, 3]] },
  { code: 'jd', name: '京东物流', patterns: [[/^JD[LVX]?\d{9,15}$/i, 3]] },
  { code: 'yuantong', name: '圆通速递', patterns: [[/^YT\d{10,13}$/i, 3], [/^[DV]\d{11,13}$/i, 1]] },
  { code: 'shentong', name: '申通快递', patterns: [[/^STO\d{10,14}$/i, 3], [/^(77|88|66|55|33|22)\d{8,12}$/, 1]] },
  { code: 'ems', name: 'EMS', patterns: [[/^[A-Z]{2}\d{9}CN$/i, 3]] },
  { code: 'debangkuaidi', name: '德邦快递', patterns: [[/^DPK\d{8,14}$/i, 3], [/^\d{10,12}$/, 1]] },
  { code: 'youzhengguonei', name: '邮政快递包裹', patterns: [[/^9\d{8,12}$/, 1]] },
  { code: 'zhongtong', name: '中通快递', patterns: [[/^[78]\d{11,13}$/, 1]] },
  { code: 'yunda', name: '韵达速递', patterns: [[/^[3456]\d{12,14}$/, 1]] },
  { code: 'huitongkuaidi', name: '百世快递', patterns: [[/^(5|7|8)\d{11,13}$/, 1]] },
  { code: 'suer', name: '速尔快递', patterns: [[/^[56]\d{11,13}$/, 1]] },
  { code: 'quanfengkuaidi', name: '全峰快递', patterns: [[/^\d{12}$/, 1]] },
  { code: 'youshuwuliu', name: '优速快递', patterns: [[/^\d{12}$/, 1]] },
  { code: 'ane66', name: '安能物流', patterns: [[/^ANE\d{8,14}$/i, 3], [/^\d{12}$/, 1]] },
  { code: 'suning', name: '苏宁物流', patterns: [[/^\d{15}$/, 1]] },
  { code: 'zhaijisong', name: '宅急送', patterns: [[/^\d{10,11}$/, 1]] },
  { code: 'longbanwuliu', name: '龙邦物流', patterns: [[/^LB\d{8,14}$/i, 3]] },
  { code: 'wanjiawuliu', name: '万家物流', patterns: [[/^WJ\d{8,14}$/i, 3]] },
]

/**
 * `state` → label + tone. This is kuaidi100's documented public mapping; an
 * unknown value is reported as itself rather than silently mapped to 在途.
 */
const STATES = {
  0: { zh: '在途', en: 'in transit', tone: 'info' },
  1: { zh: '已揽收', en: 'collected', tone: 'info' },
  2: { zh: '疑难', en: 'problem', tone: 'warn' },
  3: { zh: '已签收', en: 'delivered', tone: 'ok' },
  4: { zh: '退签', en: 'returned signed', tone: 'warn' },
  5: { zh: '派送中', en: 'out for delivery', tone: 'brand' },
  6: { zh: '退回', en: 'returning', tone: 'warn' },
  7: { zh: '转投', en: 'redirected', tone: 'warn' },
  8: { zh: '清关', en: 'customs', tone: 'info' },
  9: { zh: '待清关', en: 'awaiting customs', tone: 'info' },
  10: { zh: '清关中', en: 'in customs', tone: 'info' },
  11: { zh: '已清关', en: 'cleared customs', tone: 'ok' },
  12: { zh: '清关异常', en: 'customs issue', tone: 'crit' },
  13: { zh: '拒签', en: 'refused', tone: 'crit' },
}

/** Scan texts that mean "the courier has nothing for this number". */
const NO_DATA_RE = /查无结果|暂无|无轨迹|没有找到|无查询结果|单号不存在|抱歉/

function sum(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Tracking numbers are compared uppercase, without spaces or dashes. */
function normalizeNumber(value) {
  return String(value ?? '').toUpperCase().replace(/[\s\-_]/g, '')
}

/** The whole verified carrier table, for the picker. */
function carriers() {
  return CARRIERS.map((carrier) => ({ code: carrier.code, name: carrier.name }))
}

function carrierByCode(code) {
  return CARRIERS.find((carrier) => carrier.code === code)
}

/**
 * Offline carrier suggestions for a tracking number.
 *
 * The online detector needs a key now, so this is a local pattern table. It is
 * deliberately a SUGGESTION engine: Chinese numeric formats overlap heavily, so
 * a pure-digit number usually yields several candidates at confidence 1 and the
 * UI asks the user to confirm rather than silently picking one.
 */
function detectCarriers(value) {
  const nu = normalizeNumber(value)
  if (nu.length < 6) return []
  const hits = []
  for (const carrier of CARRIERS) {
    let best = 0
    for (const [re, weight] of carrier.patterns) {
      if (re.test(nu)) best = Math.max(best, weight)
    }
    if (best > 0) hits.push({ code: carrier.code, name: carrier.name, confidence: best })
  }
  return hits.sort((a, b) => b.confidence - a.confidence)
}

function stateInfo(state) {
  return STATES[state] ?? { zh: `状态 ${state ?? '?'}`, en: `state ${state ?? '?'}`, tone: 'info' }
}

/**
 * Nodes arrive NEWEST FIRST and are normalized to oldest-first chronological
 * order, which is what a timeline reads as. `isNew` is filled in later, once
 * the previous snapshot is known.
 */
function normalizeNodes(data) {
  const list = Array.isArray(data) ? data : []
  return list
    .map((node) => ({
      at: sum(node?.ftime, sum(node?.time, '')),
      text: String(node?.context ?? '').trim(),
    }))
    .filter((node) => node.text !== '')
    .slice(0, MAX_NODES)
    .reverse()
}

/** A short human line for the collapsed row: the newest scan. */
function summarize(nodes) {
  const last = nodes[nodes.length - 1]
  if (!last) return ''
  return last.text.replace(/^【[^】]*】/, '').trim() || last.text
}

/**
 * The place named by the newest scan, e.g. `【无锡市】快件正在派送中` → 无锡市.
 *
 * This is the ONLY location the data carries: a scan prefix in a sentence. It is
 * a city or district NAME, never a coordinate, so the UI shows it as text and
 * says where it came from instead of drawing a pin it cannot place.
 */
function locationOf(nodes) {
  const last = nodes[nodes.length - 1]
  if (!last) return ''
  const match = /^【([^】]+)】/.exec(last.text)
  return match ? match[1].trim() : ''
}

/** Everything that means "this parcel changed since we last looked". */
function changeKey(parcel) {
  return [parcel?.com, parcel?.nu, parcel?.state, parcel?.signed ? 1 : 0, parcel?.nodes?.length ?? 0,
    parcel?.nodes?.[parcel.nodes.length - 1]?.at ?? ''].join('|')
}

/**
 * Turn one raw API body into the normalized parcel view, or throw with the
 * service's own words. `status` is a STRING in this API ('200' / '400'), and a
 * bad carrier code answers `参数错误` rather than an HTTP error — so the message
 * is passed through instead of being replaced by a generic failure.
 */
function parseQueryResponse(json, { nu, com }) {
  const status = String(json?.status ?? '')
  const message = String(json?.message ?? '')
  if (status !== '200') {
    throw new Error(message === '参数错误'
      ? `快递公司代码无效或单号格式不对（${com}）—— 在卡片里换一家试试`
      : `查询失败：${message || status || '未知错误'}`)
  }
  const nodes = normalizeNodes(json?.data)
  const signed = String(json?.ischeck ?? '') === '1'
  const noData = nodes.length === 0 || (nodes.length === 1 && NO_DATA_RE.test(nodes[0].text))
  const state = noData ? -1 : (num(Number(json?.state)) ?? -1)
  return {
    nu,
    com,
    signed,
    noData,
    state,
    ...(noData ? { zh: '暂无轨迹', en: 'no tracking yet', tone: 'warn' } : stateInfo(state)),
    nodes: noData ? [] : nodes,
    location: noData ? '' : locationOf(nodes),
    latestAt: nodes.length > 0 ? nodes[nodes.length - 1].at : '',
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * One bounded GET parsed as JSON.
 *
 * The endpoint answers `Content-Type: text/html` with a JSON BODY, so the
 * content type is deliberately ignored and the text parsed instead — trusting
 * the header here would reject every successful response.
 */
async function getJson(url, timeoutMs, headers = {}) {
  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = /timeout|abort/i.test(message) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${message}`
    throw new Error(`${safeHost(url)} — ${reason}`)
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${safeHost(url)} 返回的不是 JSON（HTTP ${res.status}，可能被限流或拦截）`)
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url).slice(0, 60)
  }
}

// ── panel ──────────────────────────────────────────────────────────────────

export function schema(z) {
  try {
    return z.object({
      /** Client poll cadence. */
      pollMs: live(z.number().min(MIN_POLL_MS).default(DEFAULT_POLL_MS)),
      /** Per-parcel upstream cache window (the endpoint is rate limited). */
      refreshMs: live(z.number().min(MIN_REFRESH_MS).default(DEFAULT_REFRESH_MS)),
      timeoutMs: live(z.number().min(MIN_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)),
      /** Endpoint override — a proxy, a mirror, or a keyed provider later. */
      queryUrl: live(z.string().default('')),
      /** Extra carrier codes to add to the built-in verified table. */
      extraCarriers: live(z.string().default('')),
    })
  } catch {
    return undefined
  }
}

function readConfig(host) {
  const own = host.config() ?? {}
  return {
    pollMs: clamp(num(own.pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, 6 * 60 * 60_000),
    refreshMs: clamp(num(own.refreshMs) ?? DEFAULT_REFRESH_MS, MIN_REFRESH_MS, 12 * 60 * 60_000),
    timeoutMs: clamp(num(own.timeoutMs) ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, 60_000),
    queryUrl: stringOr(own.queryUrl, QUERY_URL),
    extraCarriers: stringOr(own.extraCarriers, ''),
  }
}

/**
 * @param {import('../../lib/host-kit.js').PanelHost} host
 */
export function mount(host) {
  const storage = host.storage
  const log = host.log

  const stored = storage.read()
  /** @type {Array<{ nu: string, com: string, phone: string, label: string, addedAt: number, seenKey: string, snapshot: any, fetchedAt: number }>} */
  let parcels = Array.isArray(stored?.parcels)
    ? stored.parcels
        .map((row) => ({
          nu: normalizeNumber(row?.nu),
          com: stringOr(row?.com, ''),
          phone: stringOr(row?.phone, ''),
          label: stringOr(row?.label, ''),
          addedAt: num(row?.addedAt) ?? Date.now(),
          seenKey: stringOr(row?.seenKey, ''),
          seenCount: num(row?.seenCount) ?? 0,
          snapshot: row?.snapshot && typeof row.snapshot === 'object' ? row.snapshot : null,
          fetchedAt: num(row?.fetchedAt) ?? 0,
        }))
        .filter((row) => row.nu !== '' && row.com !== '')
    : []

  const persist = () => storage.write({ version: 1, parcels })

  /** Config-supplied extra carrier codes, `code:名称,code2:名称2`. */
  const extraCarriers = (raw) => String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, name] = entry.split(':')
      return { code: String(code ?? '').trim(), name: stringOr(String(name ?? '').trim(), String(code ?? '').trim()) }
    })
    .filter((entry) => /^[a-z0-9_]+$/i.test(entry.code))

  const allCarriers = (cfg) => {
    const extra = extraCarriers(cfg.extraCarriers).filter((entry) => !CARRIERS.some((known) => known.code === entry.code))
    return [...carriers(), ...extra.map(({ code, name }) => ({ code, name }))]
  }

  /** One upstream query for one parcel, normalized. */
  const queryOne = async (cfg, parcel) => {
    const url = `${cfg.queryUrl}${cfg.queryUrl.includes('?') ? '&' : '?'}`
      + `type=${encodeURIComponent(parcel.com)}&postid=${encodeURIComponent(parcel.nu)}`
      + `&phone=${encodeURIComponent(parcel.phone ?? '')}&temp=${Math.random()}`
    const json = await getJson(url, cfg.timeoutMs, {
      // Their own site sends this; without it some edges answer a captcha page.
      referer: 'https://www.kuaidi100.com/',
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (dsh-hud)',
    })
    return parseQueryResponse(json, parcel)
  }

  /**
   * Refresh every parcel whose cache window expired (`force` ignores it).
   * Failures are per-parcel: one dead number must not blank the others, and the
   * previous snapshot is kept so a transient error never erases a timeline.
   */
  const collect = async (force = false) => {
    const cfg = readConfig(host)
    const now = Date.now()
    const results = await Promise.all(parcels.map(async (parcel) => {
      const fresh = parcel.snapshot && now - parcel.fetchedAt < cfg.refreshMs
      if (!force && fresh) return { parcel, changed: false }
      try {
        const snapshot = await queryOne(cfg, parcel)
        const changed = changeKey(snapshot) !== changeKey(parcel.snapshot)
        parcel.snapshot = snapshot
        parcel.fetchedAt = now
        parcel.error = undefined
        return { parcel, changed }
      } catch (error) {
        parcel.error = error instanceof Error ? error.message : String(error)
        return { parcel, changed: false }
      }
    }))
    const changed = results.filter((row) => row.changed).length
    if (changed > 0) {
      persist()
      log(`${changed} parcel(s) updated`)
    }
    return changed
  }

  /** The payload the card renders. */
  const payload = () => {
    const cfg = readConfig(host)
    return {
      ok: true,
      fetchedAt: Date.now(),
      pollMs: cfg.pollMs,
      refreshMs: cfg.refreshMs,
      carriers: allCarriers(cfg),
      maxParcels: MAX_PARCELS,
      parcels: parcels.map((parcel) => {
        const snapshot = parcel.snapshot
        const key = snapshot ? changeKey(snapshot) : ''
        return {
          nu: parcel.nu,
          com: parcel.com,
          carrier: carrierByCode(parcel.com)?.name ?? parcel.com,
          phone: parcel.phone,
          label: parcel.label,
          addedAt: parcel.addedAt,
          fetchedAt: parcel.fetchedAt,
          // Unread = the timeline moved since the card last acknowledged it.
          unread: key !== '' && key !== parcel.seenKey,
          error: parcel.error,
          ...(snapshot
            ? {
                state: snapshot.state,
                stateText: snapshot.zh,
                stateTextEn: snapshot.en,
                tone: snapshot.tone,
                signed: snapshot.signed,
                noData: snapshot.noData,
                nodes: snapshot.nodes,
                latestAt: snapshot.latestAt,
                location: snapshot.location,
                summary: summarize(snapshot.nodes),
                // How many trailing nodes the card has not acknowledged yet —
                // what makes a single row highlightable as news.
                newNodes: Math.max(0, snapshot.nodes.length - (parcel.seenCount ?? 0)),
              }
            : { state: -1, stateText: '查询中', stateTextEn: 'loading', tone: 'info', nodes: [] }),
        }
      }),
    }
  }

  const countUnread = () => payload().parcels.filter((parcel) => parcel.unread).length

  // ── routes ───────────────────────────────────────────────────────────────
  const readBody = async (req) => {
    const raw = await host.readBody(req)
    try {
      return JSON.parse(raw || '{}')
    } catch {
      return null
    }
  }

  const write = async (req, res, run) => {
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    try {
      req.resume?.()
    } catch {
      /* nothing to drain */
    }
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    const body = await readBody(req)
    if (body === null) return host.json(res, 400, { ok: false, error: 'bad-json' })
    try {
      return await run(body)
    } catch (error) {
      return host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleState = async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method === 'HEAD') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    if (method !== 'GET') return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    try {
      await collect(false)
      host.json(res, 200, payload())
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRefresh = (req, res) => write(req, res, async () => {
    await collect(true)
    host.json(res, 200, payload())
  })

  const handleCheck = (req, res) => write(req, res, async (body) => {
    const nu = normalizeNumber(body?.nu)
    const parcel = parcels.find((row) => row.nu === nu)
    if (!parcel) throw new Error('没有在关注这个单号')
    try {
      parcel.snapshot = await queryOne(readConfig(host), parcel)
      parcel.fetchedAt = Date.now()
      parcel.error = undefined
      persist()
    } catch (error) {
      parcel.error = error instanceof Error ? error.message : String(error)
    }
    host.json(res, 200, payload())
  })

  const handleAdd = (req, res) => write(req, res, async (body) => {
    const nu = normalizeNumber(body?.nu)
    const com = String(body?.com ?? '').trim()
    const phone = String(body?.phone ?? '').trim()
    const name = String(body?.label ?? '').trim().slice(0, 40)
    if (nu.length < 6 || nu.length > 40) throw new Error('单号看起来不对（6–40 个字符）')
    if (!/^[a-z0-9_]+$/i.test(com)) throw new Error('请选择快递公司')
    const cfg = readConfig(host)
    if (!allCarriers(cfg).some((carrier) => carrier.code === com)) throw new Error(`未知的快递公司代码：${com}`)
    if (parcels.some((row) => row.nu === nu)) throw new Error('这个单号已经在关注列表里了')
    if (parcels.length >= MAX_PARCELS) throw new Error(`最多关注 ${MAX_PARCELS} 个包裹`)
    const parcel = { nu, com, phone, label: name, addedAt: Date.now(), seenKey: '', snapshot: null, fetchedAt: 0 }
    parcels.push(parcel)
    try {
      parcel.snapshot = await queryOne(cfg, parcel)
      parcel.fetchedAt = Date.now()
      // A freshly added parcel is not "unread news" — the user just typed it.
      parcel.seenKey = changeKey(parcel.snapshot)
      parcel.seenCount = parcel.snapshot.nodes.length
    } catch (error) {
      parcel.error = error instanceof Error ? error.message : String(error)
    }
    persist()
    host.json(res, 200, payload())
  })

  const handleRemove = (req, res) => write(req, res, async (body) => {
    const nu = normalizeNumber(body?.nu)
    const before = parcels.length
    parcels = parcels.filter((row) => row.nu !== nu)
    if (parcels.length === before) throw new Error('没有在关注这个单号')
    persist()
    host.json(res, 200, payload())
  })

  const handleRead = (req, res) => write(req, res, async (body) => {
    const nu = normalizeNumber(body?.nu)
    for (const parcel of parcels) {
      if (nu !== '' && parcel.nu !== nu) continue
      if (parcel.snapshot) {
        parcel.seenKey = changeKey(parcel.snapshot)
        parcel.seenCount = parcel.snapshot.nodes.length
      }
    }
    persist()
    host.json(res, 200, payload())
  })

  const handleDetect = (req, res) => write(req, res, async (body) => {
    const nu = normalizeNumber(body?.nu)
    host.json(res, 200, { ok: true, nu, candidates: detectCarriers(nu) })
  })

  if (typeof host.ctx?.effect === 'function') {
    host.ctx.effect(() => {
      const off = [
        host.route('state', handleState),
        host.route('refresh', handleRefresh),
        host.route('check', handleCheck),
        host.route('add', handleAdd),
        host.route('remove', handleRemove),
        host.route('read', handleRead),
        host.route('detect', handleDetect),
      ]
      return () => {
        for (const dispose of off) dispose()
      }
    }, 'dsh-hud/parcel: routes')
  }

  return {
    collect,
    payload,
    countUnread,
    parcels: () => parcels,
    add: (nu, com, phone, label) => {
      parcels.push({ nu: normalizeNumber(nu), com, phone: phone ?? '', label: label ?? '', addedAt: Date.now(), seenKey: '', snapshot: null, fetchedAt: 0 })
      persist()
    },
  }
}