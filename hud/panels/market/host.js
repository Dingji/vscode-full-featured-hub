// @ts-check
/**
 * dsh-hud › market panel — host half.
 *
 * Domestic + overseas stock quotes and K-lines, from 东方财富 (eastmoney), which
 * was probed from the target machine before this file existed and answers all
 * three things this panel needs, keyless, in UTF-8 JSON:
 *
 *   quotes   push2.eastmoney.com/api/qt/ulist.np/get   批量，一次拿全自选
 *   K-line   push2his.eastmoney.com/api/qt/stock/kline/get   OHLC + 成交量
 *   search   searchapi.eastmoney.com/api/suggest/get   代码/名称 → secid
 *
 * (`qt.gtimg.cn` and Sina's K-line endpoint also work and were kept as
 * documented alternatives, but both answer GBK, and eastmoney carries more
 * fields per candle — volume AND amount — for less plumbing.)
 *
 * ── secid ─────────────────────────────────────────────────────────────────
 *
 * Eastmoney addresses everything as `<market>.<code>`:
 *
 *   1.000001  上证指数      0.399001  深证成指      0.399006  创业板指
 *   1.000300  沪深300       116.00700 腾讯控股      105.AAPL  苹果
 *   100.DJIA  道琼斯        100.NDX   纳斯达克100   100.SPX   标普500
 *   100.N225  日经225       100.HSI   恒生指数      100.FTSE  富时100
 *
 * ── cadence ───────────────────────────────────────────────────────────────
 *
 * Quotes default to 30 s and K-lines to 5 min. That is deliberately SLOWER than
 * the exchanges: this is a HUD, not a trading terminal, and hammering a free
 * endpoint every second is both rude and pointless. On top of that the panel
 * knows when the sessions are open (`sessionState()`), and while every market it
 * watches is CLOSED it stretches the quote interval to ten minutes — there is
 * nothing to see, and a closed market's last price does not change.
 */

import { live } from '../../lib/host-kit.js'

export const id = 'market'
export const order = 50
export const label = { zh: '股市', en: 'Markets' }
export const storageDomain = 'dsh-hud/market'


const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const SEARCH_URL = 'https://searchapi.eastmoney.com/api/suggest/get'
/**
 * ── 今日涨跌榜 ────────────────────────────────────────────────────────────
 *
 * A different endpoint from the quote one: `clist` is eastmoney's own screen, sorted by a
 * field (`fid=f3` is 涨跌幅) either descending (`po=1`, the gainers) or ascending (`po=0`,
 * the losers). Everything else about it is the same as the rest of this panel — keyless,
 * UTF-8 JSON, one host — which is why it belongs here rather than in a panel of its own.
 */
const RANK_URL = 'https://push2.eastmoney.com/api/qt/clist/get'
/** 沪深京 A 股: 深主板 + 创业板 + 沪主板 + 科创板 + 北交所. */
const RANK_BOARDS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
const RANK_FIELDS = 'f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18'
const RANK_SIZE = 20
/**
 * How many rows to ASK for so that {@link RANK_SIZE} survive the filter.
 *
 * Measured on a real session: the raw top of the list is 新股 (a first-day listing, +206%)
 * and 退市整理 (a delisting, -72%) — both true, and both useless in a "today's movers" list,
 * because their moves are not the market's. Asking for more and dropping them is the honest
 * fix; asking for exactly 20 and showing them would be the easy one.
 */
const RANK_SCAN = 60
/** The public token the search box on eastmoney's own site sends. */
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'

const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 10_000
const DEFAULT_KLINE_MS = 300_000
const MIN_KLINE_MS = 60_000
const DEFAULT_TIMEOUT_MS = 12_000
const MIN_TIMEOUT_MS = 3_000
/** Quote interval used while every watched market is shut. */
const CLOSED_POLL_MS = 600_000
/**
 * How long to wait when NO market has a trading day at all.
 *
 * Ten minutes is right for a lunch break — something will change when it ends. On a holiday
 * nothing changes until the next session, and polling a quote endpoint every ten minutes for a
 * whole day is 60-odd requests that cannot return a different answer. An hour keeps the card
 * honest (it still notices the next open within the hour) without pretending there is news.
 */
const NON_TRADING_POLL_MS = 3_600_000
const MAX_WATCH = 24
const MAX_CANDLES = 240

/**
 * The watch list used when the config does not carry one.
 *
 * This is NOT merely a schema default. If schemastery is unavailable the Config
 * is `undefined`, and a panel that relied on the schema to materialise its list
 * would come up with an EMPTY watch list and a card that renders nothing at all.
 * The live probe caught exactly that, so the fallback lives in the reader too.
 */
const DEFAULT_WATCH = '1.000001,0.399001,1.000300,116.00700,100.DJIA,100.NDX,105.AAPL'

/**
 * The periods the panel offers, and what each asks the upstream for.
 *
 * `bars` is eastmoney's `lmt`. `intraday` marks the ones trimmed to a SINGLE
 * session — which is what 实时 means: today's bars, by minute or by hour.
 * Otherwise `windowDays` is how far back the series is kept, and it is enforced
 * on the DATES rather than by `lmt`, because `lmt` cannot express a span:
 * `klt=102&lmt=60` reaches back ~14 months.
 *
 * The windows, and why:
 *
 *   实时 / 5分 / 15分 / 60分   the latest session. Measured: `klt=1` already
 *                            returns exactly one (240 one-minute bars,
 *                            09:31→15:00); the coarser ones run across days and
 *                            have to be cut to the newest date.
 *   日K                       ONE MONTH. Twenty-odd bars, wide enough to read,
 *                            which is what a daily chart is actually looked at
 *                            for — a year of them is a smear. (It used to be a
 *                            year.) The detail lives in the readout instead.
 *   周K / 月K                 one year — the cap that was asked for, and ~53
 *                            weekly or ~12 monthly bars is the right density
 *                            for those units.
 */
const PERIODS = [
  { value: 'realtime', klt: 1, bars: 240, intraday: true, label: '实时', labelEn: '1m' },
  { value: 'm5', klt: 5, bars: 240, intraday: true, label: '5分', labelEn: '5m' },
  { value: 'm15', klt: 15, bars: 240, intraday: true, label: '15分', labelEn: '15m' },
  { value: 'h1', klt: 60, bars: 240, intraday: true, label: '60分', labelEn: '60m' },
  { value: 'day', klt: 101, bars: 60, windowDays: 31, label: '日K', labelEn: 'D' },
  { value: 'week', klt: 102, bars: 60, windowDays: 365, label: '周K', labelEn: 'W' },
  { value: 'month', klt: 103, bars: 14, windowDays: 365, label: '月K', labelEn: 'M' },
]
/** How long an intraday chart is reused. 实时 has to mean something. */
const INTRADAY_CACHE_MS = 60_000

/**
 * Sessions, in each market's OWN local time. Weekends are shut; the intraday
 * lunch break is included because a HUD that says "开盘中" through a closed
 * lunch hour is worse than one that says nothing.
 */
const SESSIONS = [
  { market: 'cn', tz: 'Asia/Shanghai', label: 'A股', blocks: [['09:15', '11:30'], ['13:00', '15:00']] },
  { market: 'hk', tz: 'Asia/Hong_Kong', label: '港股', blocks: [['09:30', '12:00'], ['13:00', '16:00']] },
  { market: 'us', tz: 'America/New_York', label: '美股', blocks: [['09:30', '16:00']] },
]

/**
 * Weekday closures, per market, in that market's own calendar.
 *
 * 2026 A股: the exchanges' own notices. Only the WEEKDAYS are listed — a Saturday closure is a
 * weekend, which the session check already knows, and listing it twice would be two places to
 * keep right. Each entry is `YYYY-MM-DD` and a label, because "休市" with no reason reads like
 * a bug while "休市 · 国庆节" reads like a calendar.
 *
 * Hong Kong and the US are deliberately EMPTY: those calendars are not something I can verify
 * from here, and a wrong table silently swallows a real trading day. Add them through the
 * `holidays` setting, which takes the same `market:date:label` form.
 */
const HOLIDAYS = {
  cn: [
    ['2026-01-01', '元旦'], ['2026-01-02', '元旦'],
    ['2026-02-16', '春节'], ['2026-02-17', '春节'], ['2026-02-18', '春节'],
    ['2026-02-19', '春节'], ['2026-02-20', '春节'], ['2026-02-23', '春节'],
    ['2026-04-06', '清明'],
    ['2026-05-01', '劳动节'], ['2026-05-04', '劳动节'], ['2026-05-05', '劳动节'],
    ['2026-06-19', '端午'],
    ['2026-09-25', '中秋'],
    ['2026-10-01', '国庆'], ['2026-10-02', '国庆'], ['2026-10-05', '国庆'],
    ['2026-10-06', '国庆'], ['2026-10-07', '国庆'],
  ],
  hk: [],
  us: [],
}

/** The configured extra dates: `cn:2026-12-25:圣诞`, comma or newline separated. */
function extraHolidays(raw) {
  const out = {}
  for (const piece of String(raw ?? '').split(/[,\n]/)) {
    const [market, date, label] = piece.split(':').map((one) => (one ?? '').trim())
    if (!market || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue
    out[market] = [...(out[market] ?? []), [date, label || '休市']]
  }
  return out
}

/** Every closure for one market, the shipped table first. */
function holidaysFor(market, extra) {
  return [...(HOLIDAYS[market] ?? []), ...(extra?.[market] ?? [])]
}

// Test-only handles. Declared AFTER the constants and helpers they reference:
// an `export const` that closes over a `const` declared further down is still
// in its temporal dead zone and throws at import time — which `node --check`
// does NOT catch, because it is not a syntax error.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Split `1.600519` into its parts, rejecting anything malformed. */
function secidOf(value) {
  const match = /^(\d{1,3})\.([A-Za-z0-9]{1,12})$/.exec(String(value ?? '').trim())
  return match ? `${match[1]}.${match[2].toUpperCase()}` : ''
}

/**
 * Which session a secid trades in, from its eastmoney prefix.
 *
 * `1.` and `0.` are Shanghai and Shenzhen, `116.` is Hong Kong, and the US boards are
 * `100.`/`105.`/`106.`/`107.`. An unknown prefix returns undefined rather than guessing: a
 * market this function invents would be a session that never opens.
 */
function marketOfSecid(secid) {
  const prefix = String(secid ?? '').split('.')[0]
  if (prefix === '1' || prefix === '0') return 'cn'
  if (prefix === '116') return 'hk'
  if (['100', '105', '106', '107'].includes(prefix)) return 'us'
  return undefined
}

/** The sessions the watch list actually needs, as a Set. Empty means "no opinion". */
function watchedMarkets(rows) {
  const out = new Set()
  for (const row of rows ?? []) {
    const market = marketOfSecid(row?.secid)
    if (market !== undefined) out.add(market)
  }
  return out
}

/**
 * Narrow a session report to the markets being watched.
 *
 * With an empty or unrecognised watch list every market counts, because polling too little is a
 * worse failure than polling too much: a stale price looks like a quiet market.
 */
function sessionFor(session, watched) {
  if (watched === undefined || watched.size === 0) return session
  let anyOpen = false
  let anyTradingDay = false
  for (const market of watched) {
    if (session[market]?.open) anyOpen = true
    if (session[market]?.tradingDay) anyTradingDay = true
  }
  return { ...session, anyOpen, anyTradingDay }
}

/** eastmoney reports prices as integers scaled by `f1` decimal places. */
function fmtPrice(raw, digits) {
  const value = num(raw)
  if (value === undefined) return undefined
  return digits === undefined ? value : Number((value / 10 ** digits).toFixed(digits))
}

/** The period entry for a value, falling back to 日K. */
function periodOf(value) {
  return PERIODS.find((entry) => entry.value === String(value)) ?? PERIODS.find((entry) => entry.value === 'day')
}

function periodKlt(period) {
  return periodOf(period).klt
}

/**
 * Trim a candle series to what the period promises: one session for intraday,
 * `windowDays` for everything else.
 *
 * The intraday cut is by newest DATE rather than by clock, so a chart drawn
 * before the open (or on a holiday) shows the previous session instead of
 * nothing at all — the honest version of "today's bars" outside today.
 */
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
 * One row of the batch-quote response. `f1` is the decimal count, so every
 * price field has to be scaled by it — reading `f2` raw gives 384219 for a
 * 3842.19 index, which is the kind of "looks like data" bug that survives
 * review.
 */
/**
 * Is this row a move the MARKET made?
 *
 * No: 新股 (`N…`) and 次新 (`C…`) trade without the daily limit on their first days, and
 * 退市整理 (`…退`) is a stock being wound up. Their percentages are real and they are not
 * what anyone means by 今日涨跌榜 — the first screen of the raw list is otherwise dominated
 * by them, which is exactly what it looked like the first time this was run.
 */
function rankableName(name) {
  const text = String(name ?? '').trim()
  if (text === '') return false
  if (/^[NC]/.test(text)) return false
  if (text.includes('退')) return false
  return true
}

/** One screen row → the shape the card renders. */
function parseRankRow(row) {
  const code = String(row?.f12 ?? '').trim()
  const market = num(row?.f13)
  if (code === '' || market === undefined) return undefined
  const name = String(row?.f14 ?? '').trim()
  if (name === '') return undefined
  return {
    secid: `${market}.${code}`,
    code,
    name,
    price: num(row?.f2),
    changePct: num(row?.f3),
    change: num(row?.f4),
    volume: num(row?.f5),
    amount: num(row?.f6),
    high: num(row?.f15),
    low: num(row?.f16),
    open: num(row?.f17),
    prevClose: num(row?.f18),
  }
}

function parseQuote(row) {
  const digits = num(row?.f1) ?? 2
  const price = fmtPrice(row?.f2, digits)
  return {
    secid: `${row?.f13}.${row?.f12}`,
    code: String(row?.f12 ?? ''),
    market: num(row?.f13),
    name: String(row?.f14 ?? ''),
    price,
    changePct: num(row?.f3) === undefined ? undefined : Number((row.f3 / 100).toFixed(2)),
    change: fmtPrice(row?.f4, digits),
    at: num(row?.f124) ? new Date(row.f124 * 1000).toISOString() : undefined,
  }
}

/**
 * One K-line response. Eastmoney packs each candle as
 * `date,open,close,high,low,volume,amount` — a string, not an object, so it is
 * split positionally and a short row is skipped rather than trusted.
 */
function parseKline(json, secid, period) {
  const data = json?.data
  const lines = Array.isArray(data?.klines) ? data.klines : []
  const candles = []
  for (const line of lines) {
    const parts = String(line).split(',')
    if (parts.length < 6) continue
    const [date, open, close, high, low, volume, amount] = parts
    const candle = {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: amount === undefined ? undefined : Number(amount),
    }
    if (![candle.open, candle.close, candle.high, candle.low].every(Number.isFinite)) continue
    candles.push(candle)
  }
  return {
    secid,
    period: stringOr(period, 'day'),
    intraday: periodOf(period).intraday === true,
    name: String(data?.name ?? ''),
    code: String(data?.code ?? ''),
    candles: trimCandles(candles.slice(-MAX_CANDLES), periodOf(period)),
  }
}

/** Search hits, reduced to what the picker needs. */
function parseSearch(json) {
  const rows = json?.QuotationCodeTable?.Data
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => ({
      secid: secidOf(row?.QuoteID) || secidOf(String(row?.MktNum ?? '') + '.' + String(row?.Code ?? '')),
      code: String(row?.Code ?? ''),
      name: String(row?.Name ?? ''),
      kind: String(row?.SecurityTypeName ?? row?.Classify ?? ''),
    }))
    .filter((row) => row.secid !== '' && row.name !== '')
    .slice(0, 8)
}

/** `HH:MM` in a given IANA zone, plus the weekday. */
function localClock(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  // The DATE in the MARKET's own calendar, not this machine's. At 23:00 in Shanghai it is still
  // the previous day in New York, and a holiday lookup against the wrong date fails to find the
  // closure on exactly the day it matters.
  return {
    time: `${hour}:${get('minute')}`,
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/**
 * Which sessions are open right now, and — separately — whether today is a trading day at all.
 *
 * The two are different questions and the panel needs both. At the lunch break the market
 * reopens in an hour, so a slow poll is a pause. On 国庆节 it does not reopen today, so a slow
 * poll is a waste of an entire day's requests for a number that cannot change.
 */
function sessionState(now = new Date(), extra) {
  const out = {}
  let anyOpen = false
  let anyTradingDay = false
  for (const session of SESSIONS) {
    const { time, weekday, date } = localClock(session.tz, now)
    const weekend = weekday === 'Sat' || weekday === 'Sun'
    const holiday = holidaysFor(session.market, extra).find(([day]) => day === date)
    const tradingDay = !weekend && holiday === undefined
    const open = tradingDay && session.blocks.some(([from, to]) => time >= from && time < to)
    out[session.market] = {
      label: session.label,
      open,
      time,
      date,
      tradingDay,
      // WHY it is shut, so the card can say 国庆节 rather than just 休市.
      closed: weekend ? 'weekend' : holiday === undefined ? undefined : 'holiday',
      closedLabel: holiday?.[1],
    }
    if (open) anyOpen = true
    if (tradingDay) anyTradingDay = true
  }
  return { ...out, anyOpen, anyTradingDay }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * The yuan against the majors, from the endpoint this panel already uses.
 *
 * The secids were FOUND, not guessed: `m:133` is eastmoney's offshore-CNH board,
 * and asking for anything else (`119.USDCNY`, `119.EURCNY`, …) silently returns a
 * one-row answer rather than an error — which is how the first version of this
 * list looked like it worked while returning exactly one rate.
 *
 * The scale comes from the response itself: `f1` is the number of decimals, so
 * `f2 / 10^f1` is the price. Assuming a fixed /10000 would be right for every pair
 * today and wrong the first time one of them changes precision.
 */
export const FX_PAIRS = [
  { secid: '133.USDCNH', code: 'USD', zh: '美元', en: 'USD' },
  { secid: '133.EURCNH', code: 'EUR', zh: '欧元', en: 'EUR' },
  { secid: '133.GBPCNH', code: 'GBP', zh: '英镑', en: 'GBP' },
  { secid: '133.HKDCNH', code: 'HKD', zh: '港币', en: 'HKD' },
  { secid: '133.AUDCNH', code: 'AUD', zh: '澳元', en: 'AUD' },
  { secid: '133.CADCNH', code: 'CAD', zh: '加元', en: 'CAD' },
  { secid: '133.SGDCNH', code: 'SGD', zh: '新加坡元', en: 'SGD' },
  { secid: '133.CHFCNH', code: 'CHF', zh: '瑞郎', en: 'CHF' },
  { secid: '133.CNHJPY', code: 'JPY', zh: '日元', en: 'JPY', inverse: true },
]

/**
 * The 汇率 board: everything worth watching against the yuan, plus the majors and the index.
 *
 * Groups are presentation. `inverse` marks the ones eastmoney quotes the OTHER way round — the
 * board carries `CNHJPY` (yuan per yen) while a reader wants 100 yen per yuan, and showing the
 * reciprocal without saying so is how a rate ends up a hundred times wrong.
 *
 * Verified against the live endpoint, one 请求 for the lot: `119.USDCNY` and `100.USDX` do not
 * exist, and a code that does not exist returns no row at all rather than an error.
 */
export const FX_BOARD = [
  { secid: '133.USDCNH', zh: '美元', en: 'USD', code: 'USD', group: '对人民币' },
  { secid: '133.EURCNH', zh: '欧元', en: 'EUR', code: 'EUR', group: '对人民币' },
  { secid: '133.GBPCNH', zh: '英镑', en: 'GBP', code: 'GBP', group: '对人民币' },
  { secid: '133.JPYCNH', zh: '100日元', en: 'JPY', code: 'JPY', group: '对人民币' },
  { secid: '133.HKDCNH', zh: '港币', en: 'HKD', code: 'HKD', group: '对人民币' },
  { secid: '133.AUDCNH', zh: '澳元', en: 'AUD', code: 'AUD', group: '对人民币' },
  { secid: '133.CADCNH', zh: '加元', en: 'CAD', code: 'CAD', group: '对人民币' },
  { secid: '133.CHFCNH', zh: '瑞郎', en: 'CHF', code: 'CHF', group: '对人民币' },
  { secid: '133.SGDCNH', zh: '新加坡元', en: 'SGD', code: 'SGD', group: '对人民币' },
  { secid: '133.NZDCNH', zh: '新西兰元', en: 'NZD', code: 'NZD', group: '对人民币' },
  { secid: '119.EURUSD', zh: '欧元/美元', en: 'EURUSD', code: 'EURUSD', group: '主要货币对' },
  { secid: '119.USDJPY', zh: '美元/日元', en: 'USDJPY', code: 'USDJPY', group: '主要货币对' },
  { secid: '119.GBPUSD', zh: '英镑/美元', en: 'GBPUSD', code: 'GBPUSD', group: '主要货币对' },
  { secid: '119.AUDUSD', zh: '澳元/美元', en: 'AUDUSD', code: 'AUDUSD', group: '主要货币对' },
  { secid: '119.USDHKD', zh: '美元/港币', en: 'USDHKD', code: 'USDHKD', group: '主要货币对' },
  { secid: '100.UDI', zh: '美元指数', en: 'DXY', code: 'DXY', group: '指数', index: true },
]

/** An eastmoney ulist row → a rate, using the row's own decimal count. */
export function parseForexRow(row, pair) {
  const raw = num(row?.f2)
  const decimals = num(row?.f1)
  if (raw === undefined || raw <= 0) return undefined
  const scale = Math.pow(10, decimals === undefined ? 4 : decimals)
  return {
    secid: pair.secid,
    code: pair.code,
    name: pair.zh,
    nameEn: pair.en,
    value: raw / scale,
    decimals: decimals === undefined ? 4 : decimals,
    // f3 is the change in hundredths of a percent (14 → +0.14%), the same
    // convention the bond panel reads for its ETFs.
    changePct: num(row?.f3) === undefined ? undefined : num(row.f3) / 100,
    // `inverse` says the pair is quoted the other way round (CNH per JPY), so a
    // card can label it instead of implying "1 JPY costs 23 CNY".
    inverse: pair.inverse === true,
    // The two longer periods. A rate table without them is a ticker: one day's move says nothing
    // about whether a currency is in a trend. Both arrive in hundredths of a percent, the same
    // unit as the daily change above — which is how they were checked against it.
    change60d: num(row?.f24) === undefined ? undefined : num(row.f24) / 100,
    changeYtd: num(row?.f25) === undefined ? undefined : num(row.f25) / 100,
    // Carried through so a view can GROUP and order the rows. The 股市 view's one-line FX strip
    // has no groups and simply ignores both fields.
    group: pair.group,
    index: pair.index === true,
    at: num(row?.f124) === undefined ? undefined : num(row.f124) * 1000,
  }
}

function parseForex(body) {
  const rows = Array.isArray(body?.data?.diff) ? body.data.diff : []
  const byCode = new Map(rows.map((row) => [String(row?.f12 ?? ''), row]))
  return FX_PAIRS
    .map((pair) => parseForexRow(byCode.get(pair.secid.split('.')[1]), pair))
    .filter((entry) => entry !== undefined)
}

async function getJson(url, timeoutMs) {
  let res
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json, text/plain, */*', referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(/timeout|abort/i.test(message) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${message}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
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
      /** Comma-separated secids to watch, in display order. */
      watch: live(z.string().default(DEFAULT_WATCH)),
      quoteMs: live(z.number().min(MIN_POLL_MS).default(DEFAULT_POLL_MS)),
      klineMs: live(z.number().min(MIN_KLINE_MS).default(DEFAULT_KLINE_MS)),
      timeoutMs: live(z.number().min(MIN_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)),
      /** Stretch the quote interval while every watched market is shut. */
      slowWhenClosed: live(z.boolean().default(true)),
    /**
     * Extra closures, `market:YYYY-MM-DD:label`, comma separated — e.g.
     * `hk:2026-12-25:圣诞,us:2026-11-26:感恩节`.
     *
     * A SETTING rather than a shipped table for Hong Kong and the US: those calendars are not
     * something this plugin can verify, and a wrong holiday table silently suppresses a real
     * trading day — which is worse than not having one.
     */
    holidays: live(z.string().default('')),
      quoteUrl: live(z.string().default('')),
      klineUrl: live(z.string().default('')),
      searchUrl: live(z.string().default('')),
      rankUrl: live(z.string().default('')),
    })
  } catch {
    return undefined
  }
}

function readConfig(host) {
  const own = host.config() ?? {}
  return {
    watch: String(stringOr(own.watch, DEFAULT_WATCH))
      .split(',')
      .map((entry) => secidOf(entry))
      .filter(Boolean),
    quoteMs: clamp(num(own.quoteMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, 60 * 60_000),
    klineMs: clamp(num(own.klineMs) ?? DEFAULT_KLINE_MS, MIN_KLINE_MS, 24 * 60 * 60_000),
    timeoutMs: clamp(num(own.timeoutMs) ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, 60_000),
    slowWhenClosed: own.slowWhenClosed !== false,
    holidays: typeof own.holidays === 'string' ? own.holidays : '',
    quoteUrl: stringOr(own.quoteUrl, QUOTE_URL),
    klineUrl: stringOr(own.klineUrl, KLINE_URL),
    searchUrl: stringOr(own.searchUrl, SEARCH_URL),
    rankUrl: stringOr(own.rankUrl, RANK_URL),
  }
}

/**
 * @param {import('../../lib/host-kit.js').PanelHost} host
 */
export function mount(host) {
  const storage = host.storage
  const log = host.log
  const stored = storage.read()

  /** Watch list: `[{ secid, name }]`, in display order. */
  let watch = Array.isArray(stored?.watch) && stored.watch.length > 0
    ? stored.watch.map((row) => ({ secid: secidOf(row?.secid), name: String(row?.name ?? '') })).filter((row) => row.secid !== '')
    : null // null → fall back to the configured list until the user edits one
  let selected = secidOf(stored?.selected)
  let period = PERIODS.some((entry) => entry.value === stored?.period) ? stored.period : 'day'

  const persist = () => storage.write({ version: 1, watch, selected, period })

  /** The effective list: the user's, else the configured defaults. */
  const listOf = (cfg) => (watch ?? cfg.watch.map((secid) => ({ secid, name: '' }))).slice(0, MAX_WATCH)

  const fetchQuotes = async (cfg, secids) => {
    if (secids.length === 0) return []
    const url = `${cfg.quoteUrl}${cfg.quoteUrl.includes('?') ? '&' : '?'}`
      + `secids=${secids.join(',')}&fields=f1,f2,f3,f4,f12,f13,f14,f124&_=${Date.now()}`
    const json = await getJson(url, cfg.timeoutMs)
    const rows = json?.data?.diff
    return Array.isArray(rows) ? rows.map(parseQuote) : []
  }

  const fetchKline = async (cfg, secid, want) => {
    const url = `${cfg.klineUrl}${cfg.klineUrl.includes('?') ? '&' : '?'}`
      + `secid=${encodeURIComponent(secid)}&klt=${periodKlt(want)}&fqt=1&lmt=${periodOf(want).bars}`
      + '&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&_=' + Date.now()
    return parseKline(await getJson(url, cfg.timeoutMs), secid, want)
  }

  const search = async (cfg, input) => {
    const url = `${cfg.searchUrl}${cfg.searchUrl.includes('?') ? '&' : '?'}`
      + `input=${encodeURIComponent(input)}&type=14&token=${SEARCH_TOKEN}&count=8&_=${Date.now()}`
    return parseSearch(await getJson(url, cfg.timeoutMs))
  }

  // ── caches ───────────────────────────────────────────────────────────────
  /** @type {{ at: number, promise: Promise<any> } | null} */
  let quoteCache = null
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const klineCache = new Map()

  const quotes = async (force = false) => {
    const cfg = readConfig(host)
    const now = Date.now()
    const watched = watchedMarkets(listOf(cfg))
    const session = sessionFor(sessionState(new Date(), extraHolidays(cfg.holidays)), watched)
    // Three rates, not two. A closed HOUR is a pause; a closed DAY is a day off, and the
    // difference is an order of magnitude in requests.
    const quiet = session.anyOpen
      ? cfg.quoteMs
      : session.anyTradingDay ? Math.max(cfg.quoteMs, CLOSED_POLL_MS) : Math.max(cfg.quoteMs, NON_TRADING_POLL_MS)
    const window = cfg.slowWhenClosed ? quiet : cfg.quoteMs
    if (!force && quoteCache && now - quoteCache.at < window) return quoteCache.promise
    const promise = fetchQuotes(cfg, listOf(cfg).map((row) => row.secid)).catch((error) => {
      if (quoteCache?.promise === promise) quoteCache = null
      throw error
    })
    quoteCache = { at: now, promise }
    return promise
  }

  /** Forex, cached like the quotes: one upstream call per window. */
  let fxCache = null
  const fxRates = async (force = false) => {
    const cfg = readConfig(host)
    const now = Date.now()
    if (!force && fxCache && now - fxCache.at < cfg.quoteMs) return fxCache.promise
    const url = `${QUOTE_URL}?fields=f1,f2,f3,f12,f13,f14,f124&secids=${FX_PAIRS.map((pair) => pair.secid).join(',')}`
    const promise = getJson(url, cfg.timeoutMs).then((body) => parseForex(body)).catch((error) => {
      if (fxCache?.promise === promise) fxCache = null
      throw error
    })
    fxCache = { at: now, promise }
    return promise
  }

  /**
   * The ranking, cached like everything else here.
   *
   * The cadence follows the market: while a session is open a screen is worth refreshing
   * every 30 s, and once everything is shut the day's ranking is FINAL — so the cache
   * stretches to ten minutes rather than pretending there is news. Between the two, a
   * closed hour is a pause and the list is still worth a look.
   */
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const rankCache = new Map()
  const ranking = async (dir, force = false) => {
    const cfg = readConfig(host)
    const now = Date.now()
    const session = sessionState(new Date(), extraHolidays(cfg.holidays))
    const window = session.cn?.open === true
      ? Math.max(cfg.quoteMs, 30_000)
      : session.cn?.tradingDay === true ? CLOSED_POLL_MS : NON_TRADING_POLL_MS
    const hit = rankCache.get(dir)
    if (!force && hit !== undefined && now - hit.at < window) return hit.promise
    const url = `${cfg.rankUrl}?pn=1&pz=${RANK_SCAN}&po=${dir === 'up' ? '1' : '0'}&np=1&fltt=2&invt=2`
      + `&fid=f3&fs=${encodeURIComponent(RANK_BOARDS)}&fields=${RANK_FIELDS}&_=${Date.now()}`
    const promise = getJson(url, cfg.timeoutMs).then((body) => {
      const rows = Array.isArray(body?.data?.diff) ? body.data.diff : []
      const parsed = rows.map(parseRankRow).filter((row) => row !== undefined)
      const kept = parsed.filter((row) => rankableName(row.name))
      return {
        dir,
        total: num(body?.data?.total),
        // How many were dropped, and why: a list that silently hides rows is a list nobody
        // can check.
        scanned: parsed.length,
        filtered: parsed.length - kept.length,
        rows: kept.slice(0, RANK_SIZE),
      }
    }).catch((error) => {
      if (rankCache.get(dir)?.promise === promise) rankCache.delete(dir)
      throw error
    })
    rankCache.set(dir, { at: now, promise })
    return promise
  }

  const kline = async (secid, want, force = false) => {
    const cfg = readConfig(host)
    const key = `${secid}|${want}`
    const hit = klineCache.get(key)
    const now = Date.now()
    // 实时 means something: an intraday chart is reused for a minute, a daily one
    // for klineMs (a daily candle does not move between two glances).
    const window = periodOf(want).intraday ? INTRADAY_CACHE_MS : cfg.klineMs
    if (!force && hit && now - hit.at < window) return hit.promise
    const promise = fetchKline(cfg, secid, want).catch((error) => {
      if (klineCache.get(key)?.promise === promise) klineCache.delete(key)
      throw error
    })
    klineCache.set(key, { at: now, promise })
    return promise
  }

  /** The quote payload the card renders — no K-line, which is its own route. */

  const payload = async (force = false) => {
    const cfg = readConfig(host)
    const session = sessionFor(sessionState(new Date(), extraHolidays(cfg.holidays)), watchedMarkets(listOf(cfg)))
    let rows = []
    let error
    try {
      rows = await quotes(force)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    const entries = listOf(cfg)
    const bySecid = new Map(rows.map((row) => [row.secid, row]))
    const active = selected !== '' && entries.some((row) => row.secid === selected)
      ? selected
      : (entries[0]?.secid ?? '')
    // ── the yuan, against the majors ──────────────────────────────────────
    // Folded in here rather than made a panel of its own: it is a number you read
    // next to the indices, it comes from the SAME host this card already talks to
    // (`push2.eastmoney.com`), and an outage on it must not blank the quotes.
    let forex = []
    let forexError
    try {
      forex = await fxRates(force)
    } catch (failure) {
      forexError = failure instanceof Error ? failure.message : String(failure)
    }
    return {
      ok: true,
      fetchedAt: Date.now(),
      forex,
      forexError,
      quoteMs: cfg.quoteMs,
      klineMs: cfg.klineMs,
      pollMs: !cfg.slowWhenClosed || session.anyOpen
      ? cfg.quoteMs
      : session.anyTradingDay ? Math.max(cfg.quoteMs, CLOSED_POLL_MS) : Math.max(cfg.quoteMs, NON_TRADING_POLL_MS),
      session,
      period,
      periods: PERIODS.map(({ value, label, labelEn, intraday }) => ({ value, label, labelEn, intraday })),
      selected: active,
      error,
      quotes: entries.map((entry) => {
        const row = bySecid.get(entry.secid)
        return {
          secid: entry.secid,
          name: row?.name || entry.name || entry.secid,
          code: row?.code || entry.secid.split('.')[1],
          price: row?.price,
          changePct: row?.changePct,
          change: row?.change,
          stale: row === undefined,
        }
      }),
    }
  }

  // ── routes ───────────────────────────────────────────────────────────────
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
      host.json(res, 200, await payload(false))
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** K-line is a GET because it is a read of cached upstream data. */
  const handleKline = async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? '/', 'http://x')
    const cfg = readConfig(host)
    const entries = listOf(cfg)
    const secid = secidOf(url.searchParams.get('secid')) || selected || entries[0]?.secid || ''
    const want = PERIODS.some((entry) => entry.value === url.searchParams.get('period')) ? url.searchParams.get('period') : period
    if (secid === '') return host.json(res, 400, { ok: false, error: 'no instrument' })
    if (method === 'HEAD') {
      res.statusCode = 200
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    try {
      host.json(res, 200, { ok: true, ...(await kline(secid, want, url.searchParams.get('refresh') === '1')) })
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 今日涨跌榜. A GET, like the K-line: it reads cached upstream data and changes nothing.
   *
   * Both directions come back in one answer, because a card that shows a ranking shows both
   * halves of it, and two round trips to say one thing is one too many.
   */
  const handleRank = async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (method === 'HEAD') {
      res.statusCode = 200
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const force = url.searchParams.get('refresh') === '1'
    const cfg = readConfig(host)
    const session = sessionState(new Date(), extraHolidays(cfg.holidays))
    const errors = {}
    const halves = await Promise.all(['up', 'down'].map(async (dir) => {
      try {
        return await ranking(dir, force)
      } catch (error) {
        errors[dir] = error instanceof Error ? error.message : String(error)
        return { dir, rows: [], total: undefined, scanned: 0, filtered: 0 }
      }
    }))
    const [up, down] = halves
    host.json(res, 200, {
      ok: true,
      fetchedAt: Date.now(),
      size: RANK_SIZE,
      // 沪京深的开市状态: the ranking is only "today's" while that is true, and the card says so.
      session: { open: session.cn?.open === true, tradingDay: session.cn?.tradingDay === true, name: '沪深京' },
      up,
      down,
      error: Object.keys(errors).length === 0 ? undefined : Object.entries(errors).map(([dir, message]) => `${dir === 'up' ? '涨幅' : '跌幅'}榜：${message}`).join('；'),
    })
  }

  const handleRefresh = (req, res) => write(req, res, async () => {
    quoteCache = null
    fxCache = null
    klineCache.clear()
    rankCache.clear()
    host.json(res, 200, await payload(true))
  })

  const handleSearch = (req, res) => write(req, res, async (body) => {
    const input = String(body?.input ?? '').trim()
    if (input.length < 1) throw new Error('请输入代码或名称')
    host.json(res, 200, { ok: true, results: await search(readConfig(host), input.slice(0, 24)) })
  })

  const handleAdd = (req, res) => write(req, res, async (body) => {
    const cfg = readConfig(host)
    const secid = secidOf(body?.secid)
    if (secid === '') throw new Error('代码格式不对')
    const entries = listOf(cfg)
    if (entries.some((row) => row.secid === secid)) throw new Error('已经在自选里了')
    if (entries.length >= MAX_WATCH) throw new Error(`最多关注 ${MAX_WATCH} 个标的`)
    watch = [...entries, { secid, name: String(body?.name ?? '').slice(0, 40) }]
    selected = secid
    persist()
    quoteCache = null
    fxCache = null
    host.json(res, 200, await payload(true))
  })

  const handleRemove = (req, res) => write(req, res, async (body) => {
    const cfg = readConfig(host)
    const secid = secidOf(body?.secid)
    const entries = listOf(cfg).filter((row) => row.secid !== secid)
    if (entries.length === listOf(cfg).length) throw new Error('自选里没有这个标的')
    watch = entries
    if (selected === secid) selected = entries[0]?.secid ?? ''
    persist()
    quoteCache = null
    fxCache = null
    host.json(res, 200, await payload(true))
  })

  const handleSelect = (req, res) => write(req, res, async (body) => {
    const secid = secidOf(body?.secid)
    if (secid === '') throw new Error('代码格式不对')
    selected = secid
    persist()
    host.json(res, 200, await payload(false))
  })

  const handlePeriod = (req, res) => write(req, res, async (body) => {
    const want = String(body?.period ?? '')
    if (!PERIODS.some((entry) => entry.value === want)) throw new Error(`周期只能是 ${PERIODS.map((entry) => entry.value).join('/')}`)
    period = want
    persist()
    host.json(res, 200, await payload(false))
  })

  if (typeof host.ctx?.effect === 'function') {
    host.ctx.effect(() => {
      const off = [
        host.route('state', handleState),
        // The 汇率 board. Read-only and cacheless: it is sixteen rows, and the card that shows it
        // polls on the same cadence as everything else.
        host.route('fx', (req, res) => {
          if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD') return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
          return (async () => {
            const cfg = readConfig(host)
            // NO `fltt=2`, and `f1` IS in the field list.
            //
            // `parseForexRow` scales by 10^f1: it expects the RAW integer the endpoint sends plus
            // the decimal count. Asking for `fltt=2` returns an already-human number with no `f1`,
            // so the parser divided 6.7065 by its fallback 10^4 and produced 0.00067 — every rate
            // on the board out by a factor of ten thousand, and formatted to look plausible.
            // A secid that does not exist is OMITTED by the endpoint, so a missing row is filtered
            // out rather than drawn as a blank line.
            // f24 = 60日涨跌幅, f25 = 年初至今涨跌幅 — both in hundredths of a percent, the same
            // unit as the daily change, which is how they were checked against it. Three periods
            // from ONE request: sixteen pairs would otherwise be sixteen K-line calls.
            const fields = 'f1,f2,f3,f24,f25,f12,f13,f14,f124'
            const url = `${cfg.quoteUrl}?invt=2&np=1&fields=${fields}`
              + `&secids=${FX_BOARD.map((pair) => pair.secid).join(',')}`
            const body = await getJson(url, cfg.timeoutMs)
            const byCode = new Map((body?.data?.diff ?? []).map((row) => [String(row?.f12 ?? ''), row]))
            const rates = FX_BOARD
              .map((pair) => parseForexRow(byCode.get(pair.secid.split('.')[1]), pair))
              .filter((entry) => entry !== undefined)
            host.json(res, 200, { ok: true, groups: ['对人民币', '主要货币对', '指数'], rates })
          })().catch((error) => host.json(res, 502, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }),
        host.route('kline', handleKline),
  host.route('rank', handleRank),
        host.route('refresh', handleRefresh),
        host.route('search', handleSearch),
        host.route('add', handleAdd),
        host.route('remove', handleRemove),
        host.route('select', handleSelect),
        host.route('period', handlePeriod),
      ]
      return () => {
        for (const dispose of off) dispose()
      }
    }, 'dsh-hud/market: routes')
  }

  log(`market watching ${listOf(readConfig(host)).length} instrument(s)`)

  return {
    payload,
    quotes: (force) => quotes(force),
    kline: (secid, want, force) => kline(secid, want, force),
    search: (input) => search(readConfig(host), input),
    list: () => listOf(readConfig(host)),
    session: (now, extra) => sessionState(now, extra),
    holidaysFor,
    extraHolidays,
  }
}

/** Pure helpers, exported for the test harness. */
export const __test = {
  // The ranking's two pure pieces: the filter that decides what a "today's movers" list MEANS,
  // and the row parser. Both are worth pinning — the first screening of the live endpoint was
  // 新股 +206% and 退市整理 -72%, which is what a missing filter looks like.
  rankableName,
  parseRankRow,
  // `session` takes an INSTANT, so a holiday can be exercised without waiting for one: the whole
  // calendar is about specific dates, and a test that can only run on 10月2日 is not a test.
  session: (now, extra) => sessionState(now, extra),
  holidaysFor,
  extraHolidays,
  NON_TRADING_POLL_MS,
  marketOfSecid,
  watchedMarkets,
  sessionFor,
  CLOSED_POLL_MS,
  parseForex,
  parseForexRow,
  FX_PAIRS, parseQuote, parseKline, parseSearch, secidOf, sessionState, periodKlt, periodOf, trimCandles, fmtPrice, PERIODS }

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}