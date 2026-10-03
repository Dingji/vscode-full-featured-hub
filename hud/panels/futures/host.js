// @ts-check
/**
 * dsh-hud › futures panel — host half.
 *
 * WHAT MAKES A FUTURES PANEL DIFFERENT FROM A STOCK WATCH LIST. Three things, and each one is a
 * decision rather than a decoration:
 *
 *   1. **主力合约, not a contract.** A future has a dozen listed months and the liquid one
 *      changes. A stock's ticker is stable for ever; a future's is not. So every row here is a
 *      主连 (main-continuous) symbol — `rbm`, `IFM`, `lcm` — which the exchange data follows
 *      automatically as the contract rolls. Picking a month by hand would mean a watch list that
 *      quietly stops being the liquid one a few weeks later.
 *
 *   2. **持仓量 (open interest).** The number that matters most in futures and does not exist for
 *      a stock: it is how many contracts are still open, so it says whether a move is new money
 *      or the same money changing hands. It arrives on the quote as `f108` — a field a stock
 *      returns as `-`, which is how it was identified rather than assumed.
 *
 *   3. **期限结构 (the curve).** Every listed month of one product, priced, which is how a
 *      futures desk reads 升水/贴水: whether the market is paying up for later delivery. It is
 *      the one view a stock panel has no equivalent of.
 *
 * ── how the contract list was built ──
 *
 * EVERY secid below was VERIFIED against the live quote endpoint before it was written down: 69
 * candidates requested in one call, and a code that returns no price is a code that does not
 * exist. Three of my first guesses were wrong in a way nobody would notice from the panel — 锰硅
 * and 硅铁 are on 郑商所 (115), not 大商所 (114), and 中证1000 is `IMM`, not `IM0`. A wrong secid
 * does not throw; it renders as a blank row.
 *
 * The exchange prefixes, also found rather than assumed:
 *
 *   101 COMEX · 102 NYMEX · 103 CBOT · 112 IPE · 113 上期所 · 114 大商所 · 115 郑商所
 *   220 中金所 · 225 广期所
 */
export const id = 'futures'
/** Between the market card (50) and the bond card (60): the tab strip reads 股市 · 债市 · 期货. */
export const order = 55
export const label = { zh: '期货', en: 'Futures' }
export const storageDomain = 'dsh-hud/futures'

const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const BOARD_URL = 'https://push2.eastmoney.com/api/qt/clist/get'

const DEFAULT_POLL_MS = 60_000
const MIN_POLL_MS = 10_000
const MAX_POLL_MS = 3_600_000
const DEFAULT_TIMEOUT_MS = 20_000
const MIN_TIMEOUT_MS = 5_000
const DEFAULT_KLINE_MS = 900_000
const MIN_KLINE_MS = 60_000

/** Shut up shop: the daytime break, and the whole of a non-trading day. */
const CLOSED_POLL_MS = 300_000
const NON_TRADING_POLL_MS = 3_600_000
const INTRADAY_CACHE_MS = 60_000

/** A row per product. `sector` is the grouping the card draws, not a market fact. */
const CONTRACTS = [
  // ── 中金所: 股指与国债. NO night session, and the hours differ from the commodity exchanges. ──
  { secid: '220.IFM', zh: '沪深300', sector: '股指国债' },
  { secid: '220.IHM', zh: '上证50', sector: '股指国债' },
  { secid: '220.ICM', zh: '中证500', sector: '股指国债' },
  { secid: '220.IMM', zh: '中证1000', sector: '股指国债' },
  { secid: '220.TSM', zh: '二债', sector: '股指国债' },
  { secid: '220.TFM', zh: '五债', sector: '股指国债' },
  { secid: '220.TM', zh: '十债', sector: '股指国债' },
  { secid: '220.TLM', zh: '三十债', sector: '股指国债' },
  // ── 贵金属与有色 ──
  { secid: '113.aum', zh: '沪金', sector: '贵金属有色' },
  { secid: '113.agm', zh: '沪银', sector: '贵金属有色' },
  { secid: '113.cum', zh: '沪铜', sector: '贵金属有色' },
  { secid: '113.alm', zh: '沪铝', sector: '贵金属有色' },
  { secid: '113.znm', zh: '沪锌', sector: '贵金属有色' },
  { secid: '113.pbm', zh: '沪铅', sector: '贵金属有色' },
  { secid: '113.nim', zh: '沪镍', sector: '贵金属有色' },
  { secid: '113.snm', zh: '沪锡', sector: '贵金属有色' },
  { secid: '113.aom', zh: '氧化铝', sector: '贵金属有色' },
  // ── 黑色 ──
  { secid: '113.rbm', zh: '螺纹钢', sector: '黑色' },
  { secid: '113.hcm', zh: '热卷', sector: '黑色' },
  { secid: '113.ssm', zh: '不锈钢', sector: '黑色' },
  { secid: '114.im', zh: '铁矿石', sector: '黑色' },
  { secid: '114.jm', zh: '焦炭', sector: '黑色' },
  { secid: '114.jmm', zh: '焦煤', sector: '黑色' },
  { secid: '115.SMM', zh: '锰硅', sector: '黑色' },
  { secid: '115.SFM', zh: '硅铁', sector: '黑色' },
  // ── 能源化工 ──
  { secid: '113.rum', zh: '橡胶', sector: '能源化工' },
  { secid: '113.brm', zh: '丁二烯', sector: '能源化工' },
  { secid: '113.fum', zh: '燃油', sector: '能源化工' },
  { secid: '113.bum', zh: '沥青', sector: '能源化工' },
  { secid: '113.spm', zh: '纸浆', sector: '能源化工' },
  { secid: '114.lm', zh: '塑料', sector: '能源化工' },
  { secid: '114.vm', zh: 'PVC', sector: '能源化工' },
  { secid: '114.ppm', zh: '聚丙烯', sector: '能源化工' },
  { secid: '114.egm', zh: '乙二醇', sector: '能源化工' },
  { secid: '114.ebm', zh: '苯乙烯', sector: '能源化工' },
  { secid: '115.MAM', zh: '甲醇', sector: '能源化工' },
  { secid: '115.TAM', zh: 'PTA', sector: '能源化工' },
  { secid: '115.SAM', zh: '纯碱', sector: '能源化工' },
  { secid: '115.FGM', zh: '玻璃', sector: '能源化工' },
  { secid: '115.URM', zh: '尿素', sector: '能源化工' },
  { secid: '115.PFM', zh: '短纤', sector: '能源化工' },
  { secid: '115.SHM', zh: '烧碱', sector: '能源化工' },
  // ── 农产品 ──
  { secid: '114.am', zh: '豆一', sector: '农产品' },
  { secid: '114.mm', zh: '豆粕', sector: '农产品' },
  { secid: '114.ym', zh: '豆油', sector: '农产品' },
  { secid: '114.pm', zh: '棕榈油', sector: '农产品' },
  { secid: '114.cm', zh: '玉米', sector: '农产品' },
  { secid: '114.csm', zh: '淀粉', sector: '农产品' },
  { secid: '114.jdm', zh: '鸡蛋', sector: '农产品' },
  { secid: '114.lhm', zh: '生猪', sector: '农产品' },
  { secid: '115.CFM', zh: '棉花', sector: '农产品' },
  { secid: '115.SRM', zh: '白糖', sector: '农产品' },
  { secid: '115.OIM', zh: '菜油', sector: '农产品' },
  { secid: '115.RMM', zh: '菜粕', sector: '农产品' },
  { secid: '115.APM', zh: '苹果', sector: '农产品' },
  { secid: '115.CJM', zh: '红枣', sector: '农产品' },
  { secid: '115.PKM', zh: '花生', sector: '农产品' },
  // ── 新能源 ──
  { secid: '225.sim', zh: '工业硅', sector: '新能源' },
  { secid: '225.lcm', zh: '碳酸锂', sector: '新能源' },
  { secid: '225.psm', zh: '多晶硅', sector: '新能源' },
  // ── 外盘. Continuous `00Y` symbols: the foreign exchanges do not use the 主连 convention. ──
  { secid: '102.CL00Y', zh: 'NYMEX原油', sector: '外盘' },
  { secid: '112.B00Y', zh: '布伦特原油', sector: '外盘' },
  { secid: '101.GC00Y', zh: 'COMEX黄金', sector: '外盘' },
  { secid: '101.SI00Y', zh: 'COMEX白银', sector: '外盘' },
  { secid: '101.HG00Y', zh: 'COMEX铜', sector: '外盘' },
  { secid: '103.ZS00Y', zh: 'CBOT大豆', sector: '外盘' },
  { secid: '103.ZM00Y', zh: 'CBOT豆粕', sector: '外盘' },
  { secid: '103.ZC00Y', zh: 'CBOT玉米', sector: '外盘' },
  { secid: '103.ZW00Y', zh: 'CBOT小麦', sector: '外盘' },
]

const SECTORS = ['股指国债', '贵金属有色', '黑色', '能源化工', '农产品', '新能源', '外盘']

/**
 * Sessions, in Beijing time — the exchanges' own clock, and the clock every Chinese futures
 * trader reads. `night` is the 夜盘 window that starts the SAME calendar day at 21:00.
 *
 * The night windows are per EXCHANGE-GROUP rather than per product. The real schedule varies by
 * product (沪金 runs to 02:30 while 螺纹钢 stops at 23:00), and a per-product table maintained
 * from memory would be wrong in exactly the way that matters — it would keep polling, or stop
 * polling, on the wrong side of a real open. A group is coarse enough to be honest about.
 *
 * 外盘 has NO schedule here on purpose: COMEX and NYMEX trade nearly around the clock through
 * their own holidays, and the exchange data is the authority on when. It is marked as always a
 * trading day and never claimed to be open or shut.
 */
const SESSIONS = [
  { key: 'cffex', markets: ['股指国债'], tz: 'Asia/Shanghai', day: [['09:30', '11:30'], ['13:00', '15:00']], night: null },
  { key: 'metal', markets: ['贵金属有色'], tz: 'Asia/Shanghai', day: [['09:00', '10:15'], ['10:30', '11:30'], ['13:30', '15:00']], night: [['21:00', '23:59'], ['00:00', '01:00']] },
  { key: 'bulk', markets: ['黑色', '能源化工', '农产品', '新能源'], tz: 'Asia/Shanghai', day: [['09:00', '10:15'], ['10:30', '11:30'], ['13:30', '15:00']], night: [['21:00', '23:00']] },
  { key: 'global', markets: ['外盘'], tz: 'Asia/Shanghai', day: null, night: null },
]

/** Weekday closures. The same state holidays — a futures exchange shuts when the market does. */
const HOLIDAYS = [
  ['2026-01-01', '元旦'], ['2026-01-02', '元旦'],
  ['2026-02-16', '春节'], ['2026-02-17', '春节'], ['2026-02-18', '春节'],
  ['2026-02-19', '春节'], ['2026-02-20', '春节'], ['2026-02-23', '春节'],
  ['2026-04-06', '清明'],
  ['2026-05-01', '劳动节'], ['2026-05-04', '劳动节'], ['2026-05-05', '劳动节'],
  ['2026-06-19', '端午'],
  ['2026-09-25', '中秋'],
  ['2026-10-01', '国庆'], ['2026-10-02', '国庆'], ['2026-10-05', '国庆'],
  ['2026-10-06', '国庆'], ['2026-10-07', '国庆'],
]

const PERIODS = [
  { value: 'intraday', klt: 5, bars: 96, label: '分时', labelEn: 'Intraday', intraday: true },
  { value: 'day', klt: 101, bars: 90, label: '日K', labelEn: 'D' },
  { value: 'week', klt: 102, bars: 60, label: '周K', labelEn: 'W' },
  { value: 'month', klt: 103, bars: 24, label: '月K', labelEn: 'M' },
]
const DEFAULT_PERIOD = 'day'

function number(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function clockIn(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  return {
    time: `${hour}:${get('minute')}`,
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

const inBlocks = (time, blocks) => blocks === null || blocks === undefined
  ? false
  : blocks.some(([from, to]) => time >= from && time <= to)

/**
 * What every group is doing right now.
 *
 * The NIGHT session is the subtle part: at 22:00 on a Monday the 夜盘 of that Monday is running,
 * and at 00:30 on a Tuesday it is still Monday's session — so the trading DAY is the previous
 * day's, and asking "is today a holiday" with today's date would answer wrongly for the hour
 * after midnight.
 */
function sessionState(now = new Date()) {
  const out = {}
  let anyOpen = false
  let anyTradingDay = false
  for (const session of SESSIONS) {
    const { time, weekday, date } = clockIn(session.tz, now)
    const weekend = weekday === 'Sat' || weekday === 'Sun'
    const holiday = HOLIDAYS.find(([day]) => day === date)
    const global = session.day === null
    const tradingDay = global ? true : (!weekend && holiday === undefined)
    const open = global ? true : (tradingDay && (inBlocks(time, session.day) || inBlocks(time, session.night)))
    out[session.key] = {
      open,
      time,
      date,
      tradingDay,
      closed: weekend ? 'weekend' : holiday === undefined ? undefined : 'holiday',
      closedLabel: holiday?.[1],
      night: session.night !== null,
      global,
    }
    if (open) anyOpen = true
    if (tradingDay) anyTradingDay = true
  }
  return { ...out, anyOpen, anyTradingDay }
}

/** The period entry for a value, falling back to 日K. */
function periodOf(value) {
  return PERIODS.find((entry) => entry.value === value) ?? PERIODS.find((entry) => entry.value === DEFAULT_PERIOD) ?? PERIODS[1]
}

/** The product code behind a 主连 symbol: `rbm` → `rb`, `IFM` → `IF`, `CL00Y` → null. */
function productOfCode(code) {
  const text = String(code ?? '')
  if (/00Y$/i.test(text)) return null
  return /m$/i.test(text) ? text.slice(0, -1) : null
}

/** One quote row, in the shape the card draws. Missing numbers stay missing. */
function quoteRow(contract, raw) {
  const price = typeof raw?.f2 === 'number' ? raw.f2 : undefined
  return {
    secid: contract.secid,
    code: String(raw?.f12 ?? contract.secid.split('.')[1] ?? ''),
    name: String(raw?.f14 ?? contract.zh),
    short: contract.zh,
    sector: contract.sector,
    price,
    // 涨跌额 and 涨跌幅 are separate on purpose: a percentage is useless without the tick size,
    // and a futures contract's tick is not a stock's cent.
    change: typeof raw?.f4 === 'number' ? raw.f4 : undefined,
    changePercent: typeof raw?.f3 === 'number' ? raw.f3 : undefined,
    // 持仓量 — the field a stock does not have, and the reason this panel exists.
    openInterest: typeof raw?.f108 === 'number' ? raw.f108 : undefined,
    // 仓差: how much the open interest moved today. See the note at the top of this file for how
    // this field was identified rather than assumed.
    openInterestChange: typeof raw?.f33 === 'number' ? raw.f33 : undefined,
    volume: typeof raw?.f5 === 'number' ? raw.f5 : undefined,
    amount: typeof raw?.f6 === 'number' ? raw.f6 : undefined,
    high: typeof raw?.f15 === 'number' ? raw.f15 : undefined,
    low: typeof raw?.f16 === 'number' ? raw.f16 : undefined,
    open: typeof raw?.f17 === 'number' ? raw.f17 : undefined,
    prevClose: typeof raw?.f18 === 'number' ? raw.f18 : undefined,
  }
}

export function schema(z) {
  return z.object({
    pollMs: z.number().min(MIN_POLL_MS).max(MAX_POLL_MS).default(DEFAULT_POLL_MS),
    klineMs: z.number().min(MIN_KLINE_MS).default(DEFAULT_KLINE_MS),
    timeoutMs: z.number().min(MIN_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    /** Stretch the interval while every session is shut. */
    slowWhenClosed: z.boolean().default(true),
    /** Contracts to watch, comma separated secids. Empty means the shipped list. */
    watch: z.string().default(''),
    quoteUrl: z.string().default(''),
    klineUrl: z.string().default(''),
    boardUrl: z.string().default(''),
  })
}

export function mount(host) {
  const storage = host.storage
  /**
   * The starred contracts, in the order they were starred.
   *
   * Read once on mount and written on every change. Stored as a list of SECIDS rather than indices
   * or positions: a position in a list that the host may reorder is a reference that quietly comes
   * to mean something else.
   */
  const storedFavorites = storage?.read?.()?.favorites
  let favorites = Array.isArray(storedFavorites) ? storedFavorites.filter((one) => typeof one === 'string') : []
  const saveFavorites = () => {
    const previous = storage?.read?.() ?? {}
    storage?.write?.({ ...previous, version: 1, favorites })
  }

  const own = () => (typeof host.config === 'function' ? host.config() ?? {} : {})
  const cfg = () => {
    const source = own()
    return {
      pollMs: number(source.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
      klineMs: number(source.klineMs, MIN_KLINE_MS, 86_400_000, DEFAULT_KLINE_MS),
      timeoutMs: number(source.timeoutMs, MIN_TIMEOUT_MS, 120_000, DEFAULT_TIMEOUT_MS),
      slowWhenClosed: source.slowWhenClosed !== false,
      quoteUrl: typeof source.quoteUrl === 'string' && source.quoteUrl !== '' ? source.quoteUrl : QUOTE_URL,
      klineUrl: typeof source.klineUrl === 'string' && source.klineUrl !== '' ? source.klineUrl : KLINE_URL,
      boardUrl: typeof source.boardUrl === 'string' && source.boardUrl !== '' ? source.boardUrl : BOARD_URL,
    }
  }

  /** The watch list: the configured secids, or every shipped contract. */
  const listOf = (config) => {
    const wanted = String(config.watch ?? '').split(',').map((one) => one.trim()).filter(Boolean)
    if (wanted.length === 0) return CONTRACTS
    return wanted.map((secid) => CONTRACTS.find((one) => one.secid === secid) ?? { secid, zh: secid, sector: '自选' })
  }

  /**
   * One request, with the failure MESSAGES this HUD uses elsewhere.
   *
   * "请求超时（20000 ms）" and "网络请求失败" are the strings someone else's panel already shows,
   * and a timeout that reads as a parse error — which is what a bare `JSON.parse` of an empty
   * body gives — sends people looking in the wrong place.
   */
  async function getJson(url, timeoutMs) {
    let res
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: 'https://quote.eastmoney.com/',
          'user-agent': 'Mozilla/5.0 (compatible; dsh-hud)',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(/timeout|abort/i.test(message) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${message}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    try {
      return JSON.parse(await res.text())
    } catch {
      throw new Error('行情接口返回的不是 JSON')
    }
  }

  let quoteCache = null
  const quotes = async (config, force = false) => {
    const now = Date.now()
    const session = sessionState()
    const quiet = session.anyOpen
      ? config.pollMs
      : session.anyTradingDay ? Math.max(config.pollMs, CLOSED_POLL_MS) : Math.max(config.pollMs, NON_TRADING_POLL_MS)
    const window = config.slowWhenClosed ? quiet : config.pollMs
    if (!force && quoteCache !== null && now - quoteCache.at < window) return quoteCache.promise
    const rows = listOf(config)
    // f33 is 仓差: requested here and nowhere else, so a change to this list is a change to what
    // the panel can say.
    const fields = 'f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f33,f108'
    const url = `${config.quoteUrl}?fltt=2&invt=2&np=1&fields=${fields}&secids=${rows.map((one) => one.secid).join(',')}`
    const promise = getJson(url, config.timeoutMs).then((json) => {
      const bySecid = new Map()
      for (const raw of json?.data?.diff ?? []) bySecid.set(`${raw.f13}.${raw.f12}`, raw)
      return rows.map((contract) => quoteRow(contract, bySecid.get(contract.secid)))
    }).catch((error) => {
      if (quoteCache?.promise === promise) quoteCache = null
      throw error
    })
    quoteCache = { at: now, promise }
    return promise
  }

  let klineCache = null
  const kline = async (config, secid, period, force = false) => {
    const now = Date.now()
    const key = `${secid}|${period.value}`
    if (!force && klineCache !== null && klineCache.key === key && now - klineCache.at < (period.intraday ? INTRADAY_CACHE_MS : config.klineMs)) {
      return klineCache.promise
    }
    const fields1 = 'f1,f2,f3,f4,f5,f6'
    const fields2 = 'f51,f52,f53,f54,f55,f56,f57'
    const url = `${config.klineUrl}?secid=${encodeURIComponent(secid)}&klt=${period.klt}&fqt=0`
      + `&lmt=${period.bars}&end=20500101&fields1=${fields1}&fields2=${fields2}`
    const promise = getJson(url, config.timeoutMs).then((json) => {
      const rows = (json?.data?.klines ?? []).map((line) => {
        const [date, open, close, high, low, volume, amount] = String(line).split(',')
        return {
          date,
          open: Number(open),
          close: Number(close),
          high: Number(high),
          low: Number(low),
          volume: Number(volume),
          amount: Number(amount),
        }
      }).filter((row) => Number.isFinite(row.close) && row.close > 0)
      return { secid, name: json?.data?.name ?? secid, period: period.value, candles: rows }
    }).catch((error) => {
      if (klineCache?.promise === promise) klineCache = null
      throw error
    })
    klineCache = { key, at: now, promise }
    return promise
  }

  /**
   * 期限结构: every listed month of one product, priced.
   *
   * This is the view with no stock equivalent. The board endpoint returns the whole exchange, so
   * the months are filtered out of it by product code and sorted by delivery month — the order
   * IS the curve, and reading it is how a desk sees whether later delivery costs more (升水) or
   * less (贴水) than the front month.
   */
  const curve = async (config, secid) => {
    const [market, code] = String(secid).split('.')
    const product = productOfCode(code)
    if (product === null) {
      return { secid, product: null, months: [], note: '外盘连续合约没有月份序列' }
    }
    const url = `${config.boardUrl}?pn=1&pz=400&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:${market}`
      + '&fields=f12,f14,f2,f3,f5,f108'
    const json = await getJson(url, config.timeoutMs)
    const months = (json?.data?.diff ?? [])
      .filter((row) => new RegExp(`^${product}\\d{3,4}$`, 'i').test(String(row.f12)))
      .map((row) => ({
        code: String(row.f12),
        month: String(row.f12).slice(product.length),
        price: typeof row.f2 === 'number' ? row.f2 : undefined,
        changePercent: typeof row.f3 === 'number' ? row.f3 : undefined,
        volume: typeof row.f5 === 'number' ? row.f5 : undefined,
        openInterest: typeof row.f108 === 'number' ? row.f108 : undefined,
      }))
      .filter((row) => row.price !== undefined)
      .sort((a, b) => a.month.localeCompare(b.month))
    return { secid, product, months }
  }

  /** Origin + verb guard, shared by every route here. */
  const guard = (req, res, verbs) => {
    if (!host.sameOrigin(req)) {
      host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
      return false
    }
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (!verbs.includes(method)) {
      host.json(res, 405, { ok: false, error: 'method-not-allowed' })
      return false
    }
    return true
  }

  const query = (req) => new URL(req.url ?? '/', 'http://x').searchParams

  host.route('state', async (req, res) => {
    if (!guard(req, res, ['GET', 'HEAD'])) return
    const config = cfg()
    const session = sessionState()
    let rows = []
    let error
    try {
      rows = await quotes(config)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    host.json(res, 200, {
      ok: true,
      now: Date.now(),
      error,
      session,
      sectors: SECTORS,
      favorites,
      contracts: rows,
      period: DEFAULT_PERIOD,
      periods: PERIODS.map((entry) => ({ value: entry.value, label: entry.label, labelEn: entry.labelEn })),
      pollMs: !config.slowWhenClosed || session.anyOpen
        ? config.pollMs
        : session.anyTradingDay ? Math.max(config.pollMs, CLOSED_POLL_MS) : Math.max(config.pollMs, NON_TRADING_POLL_MS),
    })
  })

  host.route('refresh', async (req, res) => {
    if (!guard(req, res, ['POST'])) return
    const config = cfg()
    let rows = []
    let error
    try {
      rows = await quotes(config, true)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    host.json(res, 200, { ok: true, now: Date.now(), error, contracts: rows, session: sessionState() })
  })

  host.route('kline', async (req, res) => {
    if (!guard(req, res, ['GET', 'HEAD'])) return
    const config = cfg()
    const params = query(req)
    const secid = String(params.get('secid') ?? CONTRACTS[0].secid)
    const period = periodOf(params.get('period'))
    try {
      host.json(res, 200, { ok: true, ...(await kline(config, secid, period, params.get('refresh') === '1')) })
    } catch (failure) {
      // 502, not 200: the route worked and the UPSTREAM did not, and the two must not look alike
      // to whoever is reading the network tab.
      host.json(res, 502, { ok: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  })

  /**
   * Star or unstar one contract.
   *
   * POST, and the answer is the WHOLE new list rather than an acknowledgement: the card keeps a
   * copy for instant feedback, and a list that is authoritative on both sides cannot drift.
   */
  host.route('favorite', async (req, res) => {
    if (!guard(req, res, ['POST'])) return
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const secid = String(body?.secid ?? '').trim()
      if (secid === '') return host.json(res, 400, { ok: false, error: 'no secid' })
      // A contract that is not in the shipped list can still be starred — the list is a default,
      // not a permission — but it has to LOOK like a secid, or storage fills with typos.
      if (!/^\d{1,3}\.[A-Za-z0-9]{1,12}$/.test(secid)) {
        return host.json(res, 400, { ok: false, error: 'bad secid' })
      }
      const on = body?.on === true
      favorites = on
        ? (favorites.includes(secid) ? favorites : [...favorites, secid])
        : favorites.filter((one) => one !== secid)
      saveFavorites()
      host.json(res, 200, { ok: true, favorites })
    } catch (error) {
      host.json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('curve', async (req, res) => {
    if (!guard(req, res, ['GET', 'HEAD'])) return
    const config = cfg()
    const secid = String(query(req).get('secid') ?? CONTRACTS[0].secid)
    try {
      host.json(res, 200, { ok: true, ...(await curve(config, secid)) })
    } catch (failure) {
      host.json(res, 502, { ok: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  })
}

/** Exported for the test harness: the calendar and the mapping are what a test can pin down. */
export const __test = {
  CONTRACTS,
  SECTORS,
  PERIODS,
  HOLIDAYS,
  SESSIONS,
  sessionState,
  productOfCode,
  quoteRow,
  periodOf,
}