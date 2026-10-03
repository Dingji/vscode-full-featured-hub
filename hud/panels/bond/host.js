// @ts-check
/**
 * dsh-hud › bond panel — host half. **Domestic only.**
 *
 *  中国国债收益率曲线   中国货币网 (CFETS/中债) `ClsYldCurvHis`
 *  K 线                东方财富 push2his（国债 / 可转债 / 城投 ETF 的价格）
 *  ETF 行情            东方财富 push2
 *
 * There is no US leg here, by request. An earlier version carried US Treasury
 * yields (eastmoney `171.US2Y|US10Y|US30Y`, with FRED as a fallback) plus the
 * 中美利差; all of it is gone, along with FRED and the fallback path — so this
 * panel now talks to exactly two hosts, neither of which throttles a HUD.
 *
 * ── what the CN endpoint actually returns ─────────────────────────────────
 *
 * `{ head, data, records }` — `records` is at the TOP level, NOT under `data`,
 * and `data.dateList` only ever carries the newest date. Each record is ONE
 * (date, tenor) cell:
 *
 *   { newDateValueCN: '2026-09-30', yearTermStr: '0.083',
 *     maturityYieldStr: '1.0150', currentYieldStr: '1.0150', futureYieldStr: '---' }
 *
 * Rows come back date-DESC, tenor-ASC, so ONE page yields the newest curve. Two
 * measured limits decide the request shape:
 *
 *   - the date span is capped (10 days → 824 rows; 31 and 45 days → `total: 0`),
 *     so the window is 10 days;
 *   - a burst gets an HTML anti-scraping page back, so it is exactly ONE request
 *     of ONE page per refresh, and an HTML answer is reported as what it is.
 *
 * ── K-lines ───────────────────────────────────────────────────────────────
 *
 * The CN curve cannot be candled (see the cap above), so the candles come from
 * eastmoney — the same endpoint the share panel uses, which carries bond ETFs'
 * prices. Periods: 实时/5分/15分/60分 (one session) plus 日/周/月 (the last year).
 */

import { live } from '../../lib/host-kit.js'

export const id = 'bond'
export const order = 60
export const label = { zh: '债市', en: 'Bonds' }
export const storageDomain = 'dsh-hud/bond'

const CN_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/ClsYldCurvHis'
const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

const DEFAULT_POLL_MS = 1_800_000
const MIN_POLL_MS = 300_000
const DEFAULT_KLINE_MS = 1_800_000
const MIN_KLINE_MS = 300_000
const DEFAULT_TIMEOUT_MS = 20_000
const MIN_TIMEOUT_MS = 5_000
/** How long an intraday chart is reused. 实时 has to mean something. */
const INTRADAY_CACHE_MS = 60_000
/** chinamoney's span cap — measured, not guessed. */
const WINDOW_DAYS = 10
/** The tenors a human actually quotes, in order. */
const TENOR_LABELS = {
  0.083: '1M', 0.25: '3M', 0.5: '6M', 1: '1Y', 2: '2Y', 3: '3Y', 4: '4Y', 5: '5Y',
  6: '6Y', 7: '7Y', 8: '8Y', 9: '9Y', 10: '10Y', 15: '15Y', 20: '20Y', 30: '30Y',
}
/**
 * NOT `Object.keys(TENOR_LABELS).map(Number)`.
 *
 * JavaScript enumerates integer-like keys FIRST, in ascending order, and only
 * then the rest in insertion order — so deriving the list from the label map
 * yields `1, 3, 5, …, 30, 0.083, 0.25, 0.5` and plots a "yield curve" that runs
 * 1Y→30Y and then jumps back to 1M. The browser test caught exactly that; the
 * order below is spelled out so it cannot come back.
 */
const KEY_TENORS = [0.083, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30]

/**
 * What the panel can draw a K-line OF. All domestic.
 *
 * `kind` is not decoration: a bond ETF quotes a PRICE, which moves INVERSELY to
 * yields, and the card says which of the two it is showing.
 */
const CHARTS = [
  { secid: '1.511260', code: '511260', name: '十年国债ETF', kind: 'price' },
  { secid: '1.511010', code: '511010', name: '国债ETF', kind: 'price' },
  { secid: '1.511380', code: '511380', name: '可转债ETF', kind: 'price' },
  { secid: '1.511220', code: '511220', name: '城投债ETF', kind: 'price' },
]
const DEFAULT_CHART = '1.511260'
/** Tradeable CN bond ETFs, as quotes. */
const ETF_SECIDS = ['1.511010', '1.511260', '1.511380', '1.511220']

/**
 * The periods, and what each asks the upstream for.
 *
 * `bars` is eastmoney's `lmt`. `intraday` marks the ones trimmed to a SINGLE
 * session — which is what 实时 means: the latest session's bars, by minute or by
 * hour. The trim is by newest DATE rather than by clock, so outside trading hours
 * the chart shows the last session instead of nothing at all.
 *
 * 日/周/月 are trimmed to the last YEAR on the dates, because `lmt` cannot do it:
 * `klt=102&lmt=60` reaches back ~14 months and `klt=103&lmt=14` about the same.
 */
const PERIODS = [
  { value: 'realtime', klt: 1, bars: 240, intraday: true, label: '实时', labelEn: '1m' },
  { value: 'm5', klt: 5, bars: 240, intraday: true, label: '5分', labelEn: '5m' },
  { value: 'm15', klt: 15, bars: 240, intraday: true, label: '15分', labelEn: '15m' },
  { value: 'h1', klt: 60, bars: 240, intraday: true, label: '60分', labelEn: '60m' },
  // 日K = ONE MONTH; 周K/月K = one year. See the market host for the reasoning.
  { value: 'day', klt: 101, bars: 60, windowDays: 31, label: '日K', labelEn: 'D' },
  { value: 'week', klt: 102, bars: 60, windowDays: 365, label: '周K', labelEn: 'W' },
  { value: 'month', klt: 103, bars: 14, windowDays: 365, label: '月K', labelEn: 'M' },
]

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** `YYYY-MM-DD` for `days` ago, in local time. */
function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 86_400_000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Flatten the CN payload into `{ date, tenor, value }` rows. Rows whose yield is
 * `---` (the endpoint's "not published yet" marker, seen on the long end) are
 * dropped rather than turned into NaN.
 */
function parseCnRecords(json) {
  const rows = Array.isArray(json?.records) ? json.records : []
  const out = []
  for (const row of rows) {
    const date = String(row?.newDateValueCN ?? '')
    const tenor = Number(row?.yearTermStr)
    const value = Number(row?.maturityYieldStr)
    if (date === '' || !Number.isFinite(tenor) || !Number.isFinite(value)) continue
    out.push({ date, tenor, value })
  }
  return out
}

/**
 * The newest published curve, keyed to the tenors people quote. Returns `[]`
 * when the newest date has none of them (rather than plotting a partial curve
 * as if it were complete).
 */
function keyCurve(rows) {
  const newest = rows[0]?.date
  if (newest === undefined) return { date: '', points: [] }
  const byTenor = new Map()
  for (const row of rows) {
    if (row.date !== newest) continue
    if (!KEY_TENORS.includes(row.tenor)) continue
    byTenor.set(row.tenor, row.value)
  }
  const points = KEY_TENORS
    .filter((tenor) => byTenor.has(tenor))
    .map((tenor) => ({ tenor, label: TENOR_LABELS[tenor], value: byTenor.get(tenor) }))
  return { date: newest, points }
}

/** eastmoney's kline rows as a close-only series, oldest first. */
function parseTrend(rows) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const [date, , close] = String(row).split(',')
    const value = Number(close)
    if (!date || !Number.isFinite(value)) continue
    out.push({ date, value })
  }
  return out
}

/**
 * Candles with the full OHLC.
 *
 * `parseTrend` projects a row down to its close, which is all a trend line needs
 * and NOT enough for a candlestick — a candle is defined by all four prices, plus
 * the volume for the strip underneath.
 */
function parseCandles(data) {
  const rows = Array.isArray(data?.klines) ? data.klines : []
  const candles = []
  for (const row of rows) {
    const [date, open, close, high, low, volume, amount] = String(row).split(',')
    const candle = {
      date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume),
      // The readout shows 成交额 too, so it has to survive parsing.
      amount: amount === undefined ? undefined : Number(amount),
    }
    if (![candle.open, candle.close, candle.high, candle.low].every(Number.isFinite)) continue
    candles.push(candle)
  }
  return { name: String(data?.name ?? ''), code: String(data?.code ?? ''), candles }
}

function periodOf(value) {
  return PERIODS.find((entry) => entry.value === String(value)) ?? PERIODS.find((entry) => entry.value === 'day')
}

/** One session for intraday, windowDays for everything else. */
function trimCandles(candles, entry) {
  if (candles.length === 0) return candles
  if (entry.intraday) {
    const newest = String(candles[candles.length - 1].date).slice(0, 10)
    return candles.filter((candle) => String(candle.date).slice(0, 10) === newest)
  }
  const floor = new Date(Date.now() - (entry.windowDays ?? 365) * 86_400_000).toISOString().slice(0, 10)
  return candles.filter((candle) => String(candle.date).slice(0, 10) >= floor)
}

/**
 * Test-only handles. Declared AFTER the constants and helpers they reference: an
 * `export const` closing over a `const` declared further down is still in its
 * temporal dead zone and throws at import time — which `node --check` does NOT
 * catch, because it is not a syntax error.
 */
export const __test = { parseCnRecords, keyCurve, parseTrend, parseCandles, trimCandles, periodOf, TENOR_LABELS, CHARTS, PERIODS }

// ── HTTP ───────────────────────────────────────────────────────────────────

async function getText(url, timeoutMs, headers = {}) {
  let res
  try {
    res = await fetch(url, { headers: { accept: '*/*', ...headers }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(/timeout|abort/i.test(message) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${message}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function getJson(url, timeoutMs, headers) {
  const text = await getText(url, timeoutMs, headers)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回的不是 JSON（可能被限流或拦截）')
  }
}

// ── panel ──────────────────────────────────────────────────────────────────

export function schema(z) {
  try {
    return z.object({
      pollMs: live(z.number().min(MIN_POLL_MS).default(DEFAULT_POLL_MS)),
      /** How long a daily candle series is reused, in ms. */
      klineMs: live(z.number().min(MIN_KLINE_MS).default(DEFAULT_KLINE_MS)),
      timeoutMs: live(z.number().min(MIN_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)),
      /**
       * The CN query window, in days. NOT a history depth: the endpoint returns
       * ZERO records beyond ~10 days and serves an HTML guard page to oversized
       * pages. One page of 90 covers a whole trading day's curve.
       */
      windowDays: live(z.number().min(3).max(20).default(WINDOW_DAYS)),
      cnUrl: live(z.string().default('')),
      /** eastmoney batch quotes: the bond ETFs. */
      quoteUrl: live(z.string().default('')),
      /** eastmoney K-lines: every chartable instrument. */
      klineUrl: live(z.string().default('')),
    })
  } catch {
    return undefined
  }
}

function readConfig(host) {
  const own = host.config() ?? {}
  return {
    pollMs: clamp(num(own.pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, 24 * 60 * 60_000),
    klineMs: clamp(num(own.klineMs) ?? DEFAULT_KLINE_MS, MIN_KLINE_MS, 24 * 60 * 60_000),
    timeoutMs: clamp(num(own.timeoutMs) ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, 60_000),
    windowDays: clamp(num(own.windowDays) ?? WINDOW_DAYS, 3, 20),
    cnUrl: stringOr(own.cnUrl, CN_URL),
    quoteUrl: stringOr(own.quoteUrl, QUOTE_URL),
    klineUrl: stringOr(own.klineUrl, KLINE_URL),
  }
}

/**
 * @param {import('../../lib/host-kit.js').PanelHost} host
 */
export function mount(host) {
  const storage = host.storage
  const stored = storage.read()
  const chartEntry = (secid) => CHARTS.find((entry) => entry.secid === secid)
  /** Which instrument the K-line shows — the user's pick, else the first one. */
  let chart = chartEntry(stored?.chart) ? stored.chart : DEFAULT_CHART
  /** Which period: 实时 / 5分 / 15分 / 60分 / 日K / 周K / 月K. */
  let period = PERIODS.some((entry) => entry.value === stored?.period) ? stored.period : 'day'
  const persist = () => storage.write({ version: 1, chart, period })

  const fetchCn = async (cfg) => {
    // ONE page, and pageSize is deliberately modest: this endpoint serves an
    // HTML guard page to anything that looks like scraping, and the newest
    // curve fits in one page (~90 rows).
    const url = `${cfg.cnUrl}${cfg.cnUrl.includes('?') ? '&' : '?'}`
      + `lang=CN&startDate=${isoDaysAgo(cfg.windowDays)}&endDate=${isoDaysAgo(0)}`
      + '&bondType=CYCC000&reference=1&pageSize=90&pageNum=1'
    const text = await getText(url, cfg.timeoutMs, { referer: 'https://www.chinamoney.com.cn/' })
    // The guard page is HTML, not JSON — say which of the two it is, because
    // "被限流了" and "接口变了" call for completely different reactions.
    if (text.trimStart().startsWith('<')) {
      throw new Error('中国货币网返回了防抓取页面（请求过于频繁），稍后会自己恢复')
    }
    try {
      return parseCnRecords(JSON.parse(text))
    } catch {
      throw new Error('中国货币网的返回无法解析')
    }
  }

  /** One instrument's candles, for one period. */
  const fetchKline = async (cfg, secid, want) => {
    const entry = periodOf(want)
    const json = await getJson(
      `${cfg.klineUrl}${cfg.klineUrl.includes('?') ? '&' : '?'}`
        + `secid=${encodeURIComponent(secid)}&klt=${entry.klt}&fqt=1&lmt=${entry.bars}&end=20500101`
        + '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&_=' + Date.now(),
      cfg.timeoutMs,
      { referer: 'https://quote.eastmoney.com/' },
    )
    const parsed = parseCandles(json?.data)
    return {
      secid,
      period: entry.value,
      intraday: entry.intraday === true,
      kind: chartEntry(secid)?.kind ?? 'price',
      name: parsed.name,
      code: parsed.code,
      candles: trimCandles(parsed.candles, entry),
    }
  }

  const fetchEtfs = async (cfg) => {
    const url = `${cfg.quoteUrl}${cfg.quoteUrl.includes('?') ? '&' : '?'}`
      // NO `fltt=2`: with it the API returns DISPLAY values while `f1` still
      // advertises the decimal count, so dividing by 10**f1 reports a 141.7
      // bond ETF as 0.1417. Without it, `f1`-scaling is the truth — verified
      // against the live endpoint before and after.
      + `secids=${ETF_SECIDS.join(',')}&fields=f1,f2,f3,f4,f12,f13,f14&_=${Date.now()}`
    const json = await getJson(url, cfg.timeoutMs, { referer: 'https://quote.eastmoney.com/' })
    const rows = json?.data?.diff
    if (!Array.isArray(rows)) return []
    return rows.map((row) => {
      const digits = num(row?.f1) ?? 2
      return {
        secid: `${row?.f13}.${row?.f12}`,
        code: String(row?.f12 ?? ''),
        name: String(row?.f14 ?? ''),
        price: num(row?.f2) === undefined ? undefined : Number((row.f2 / 10 ** digits).toFixed(digits)),
        changePct: num(row?.f3) === undefined ? undefined : Number((row.f3 / 100).toFixed(2)),
      }
    })
  }

  /** Everything the card needs, with each source failing independently. */
  const collect = async () => {
    const cfg = readConfig(host)
    const out = {
      ok: true,
      fetchedAt: Date.now(),
      pollMs: cfg.pollMs,
      klineMs: cfg.klineMs,
      cn: { date: '', curve: [], error: undefined },
      etfs: [],
      charts: CHARTS,
      periods: PERIODS.map(({ value, label, labelEn, intraday }) => ({ value, label, labelEn, intraday })),
      sources: { cn: 'chinamoney', etf: 'eastmoney' },
    }

    const [cnResult, etfResult] = await Promise.allSettled([fetchCn(cfg), fetchEtfs(cfg)])

    if (cnResult.status === 'fulfilled') {
      const rows = cnResult.value
      const newest = rows[0]?.date
      // The curve object carries the sorted points; the 10Y is lifted out as the
      // single number a card prints next to it.
      const curve = keyCurve(rows)
      out.cn.date = newest ?? ''
      out.cn.curve = curve.points
      out.cn.ten = curve.points.find((point) => point.tenor === 10)?.value
      out.cn.rows = rows.length
    } else {
      out.cn.error = cnResult.reason instanceof Error ? cnResult.reason.message : String(cnResult.reason)
    }

    if (etfResult.status === 'fulfilled') out.etfs = etfResult.value
    return out
  }

  /** @type {{ at: number, promise: Promise<any> } | null} */
  let cache = null
  /** Per (secid|period) candle cache — see `handleKline`. */
  const klineCache = new Map()

  /**
   * Upstream data, cached for `pollMs`.
   *
   * Note what is NOT in here: the user's chart choice. That is UI state, and
   * caching it meant changing the selection returned the PREVIOUS selection
   * until the cache expired — the browser test caught exactly that. Only the
   * collected market data is cached; the selection is merged in per request.
   */
  const collectOnce = (force) => {
    const cfg = readConfig(host)
    const now = Date.now()
    if (!force && cache && now - cache.at < cfg.pollMs) return cache.promise
    const promise = collect().catch((error) => {
      if (cache?.promise === promise) cache = null
      throw error
    })
    cache = { at: now, promise }
    return promise
  }

  const stateOnce = async (force) => ({
    ...(await collectOnce(force)),
    chart,
    chartPeriod: period,
  })

  const readBody = async (req) => {
    try {
      return JSON.parse((await host.readBody(req)) || '{}')
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
      host.json(res, 200, await stateOnce(false))
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The K-line for the selected instrument and period.
   *
   * A GET, like the share panel's: it reads cached upstream data and changes
   * nothing. Cached per (secid, period) — an intraday series for a minute, a
   * daily one for `klineMs`, because 实时 has to mean something while a daily
   * candle does not move between two glances.
   */
  const handleKline = async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? '/', 'http://x')
    const cfg = readConfig(host)
    const wanted = chartEntry(url.searchParams.get('secid'))?.secid ?? chart
    const entry = periodOf(url.searchParams.get('period') ?? period)
    if (method === 'HEAD') {
      res.statusCode = 200
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    const key = `${wanted}|${entry.value}`
    const now = Date.now()
    const hit = klineCache.get(key)
    const force = url.searchParams.get('refresh') === '1'
    const window = entry.intraday ? INTRADAY_CACHE_MS : cfg.klineMs
    try {
      if (!force && hit && now - hit.at < window) {
        return host.json(res, 200, { ok: true, ...(await hit.promise) })
      }
      const promise = fetchKline(cfg, wanted, entry.value).catch((error) => {
        if (klineCache.get(key)?.promise === promise) klineCache.delete(key)
        throw error
      })
      klineCache.set(key, { at: now, promise })
      host.json(res, 200, { ok: true, ...(await promise) })
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRefresh = (req, res) => write(req, res, async () => {
    cache = null
    klineCache.clear()
    host.json(res, 200, await stateOnce(true))
  })

  const handleChart = (req, res) => write(req, res, async (body) => {
    if (body?.secid !== undefined) {
      const want = chartEntry(body.secid)
      if (want === undefined) throw new Error(`只能看这些标的：${CHARTS.map((entry) => entry.name).join(' / ')}`)
      chart = want.secid
    }
    if (body?.period !== undefined) {
      if (!PERIODS.some((entry) => entry.value === body.period)) {
        throw new Error(`周期只能是 ${PERIODS.map((entry) => entry.value).join('/')}`)
      }
      period = body.period
    }
    persist()
    host.json(res, 200, await stateOnce(false))
  })

  if (typeof host.ctx?.effect === 'function') {
    host.ctx.effect(() => {
      const off = [
        host.route('state', handleState),
        host.route('kline', handleKline),
        host.route('refresh', handleRefresh),
        host.route('chart', handleChart),
      ]
      return () => {
        for (const dispose of off) dispose()
      }
    }, 'dsh-hud/bond: routes')
  }

  return {
    state: (force) => stateOnce(force),
    collect,
    kline: (secid, want) => fetchKline(
      readConfig(host),
      chartEntry(secid)?.secid ?? chart,
      periodOf(want ?? period).value,
    ),
    selection: () => ({ chart, period }),
  }
}