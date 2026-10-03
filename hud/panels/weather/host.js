// @ts-check
/**
 * dsh-hud › weather panel — host half.
 *
 * Feeds the HUD's title bar with the weather where the user actually is:
 *
 *   { location, current: { text, temperature, humidity, wind… }, alerts: […] }
 *
 * ── where the data comes from (and why these sources) ──────────────────────
 *
 *   current conditions  Open-Meteo  `api.open-meteo.com/v1/forecast`
 *   location by name    Open-Meteo  `geocoding-api.open-meteo.com/v1/search`
 *   location by IP      ip-api.com  (http) with ipwho.is (https) as a fallback
 *   extreme alerts      NMC 中央气象台 `www.nmc.cn/rest/findAlarm`
 *
 * All four are keyless, which matters: this HUD must work on a fresh install
 * with nothing to configure. Every one of them was probed from the target
 * machine before this file was written — `ipapi.co` returned a Cloudflare 403
 * and was dropped, and the NMC `province=` filter turned out to be a 417, which
 * is why alert filtering is done locally (see below).
 *
 * ── how alerts are matched to the user ────────────────────────────────────
 *
 * NMC answers with EVERY active alert in the country (879 on the day this was
 * written) and each item carries only `alertid`, `issuetime`, `title`, `url`,
 * `pic`. Two things make that workable:
 *
 *   1. `pageSize=1000` returns the whole set in ONE request, so there is no
 *      pagination gap where a local alert could hide;
 *   2. **the `alertid` prefix is the province administrative code** — 52 贵州,
 *      32 江苏, 11 北京 … so "which province is this about" is exact, not a
 *      guess. Verified against the live payload: every prefix seen (52, 14, 22,
 *      35, 43, 23, 44, 36, 21, 33, 45, 61, 15, 34, 50, 51) is a real province.
 *
 * Matching is two-tier and says which tier it used: a title containing the
 * caller's CITY is `scope: 'city'` (this alert is about them), anything else
 * from their province is `scope: 'province'` (a warning nearby). The card
 * labels the difference rather than pretending they are equal.
 *
 * ── the 10-minute cadence ─────────────────────────────────────────────────
 *
 * `refreshMs` defaults to 600 000 (10 min) and is the single number that drives
 * both halves: the browser polls `/dsh-hud/weather/state` on it, and the host
 * caches upstream on it, so several open tabs still produce one upstream call
 * per window. `POST /dsh-hud/weather/refresh` bypasses the cache.
 */

import { live } from '../../lib/host-kit.js'

export const id = 'weather'
export const order = 30
export const label = { zh: '天气', en: 'Weather' }

/**
 * Location cache: `{ location, at }`. Resolving by IP costs a request and the
 * answer does not change minute to minute, so it is kept for a day.
 */
export const storageDomain = 'dsh-hud/weather'

// ── constants ──────────────────────────────────────────────────────────────
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
/** http-only on the free tier; the host is Node, so there is no mixed content. */
const IP_API = 'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone&lang=zh-CN'
const IP_WHO = 'https://ipwho.is/'
const NMC_ALARM = 'http://www.nmc.cn/rest/findAlarm'
const NMC_WEB = 'http://www.nmc.cn'

const DEFAULT_REFRESH_MS = 600_000
const MIN_REFRESH_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 2_000
/** How long an IP-resolved location is trusted. */
const LOCATION_TTL_MS = 24 * 60 * 60_000
/** One page covers every active alert; there are far fewer than this. */
const ALERT_PAGE_SIZE = 1000
/** Most alerts shown; the list is already sorted newest-first by the source. */
const MAX_ALERTS = 8

/**
 * Province name → 2-digit administrative code, the same prefix NMC puts on
 * `alertid`. Names are matched after {@link provinceKey} strips the suffixes,
 * so 江苏省 / 江苏 / 北京市 / 内蒙古自治区 all land correctly.
 */
const PROVINCE_CODES = {
  11: ['北京'], 12: ['天津'], 13: ['河北'], 14: ['山西'], 15: ['内蒙古'],
  21: ['辽宁'], 22: ['吉林'], 23: ['黑龙江'],
  31: ['上海'], 32: ['江苏'], 33: ['浙江'], 34: ['安徽'], 35: ['福建'], 36: ['江西'], 37: ['山东'],
  41: ['河南'], 42: ['湖北'], 43: ['湖南'], 44: ['广东'], 45: ['广西'], 46: ['海南'],
  50: ['重庆'], 51: ['四川'], 52: ['贵州'], 53: ['云南'], 54: ['西藏'],
  61: ['陕西'], 62: ['甘肃'], 63: ['青海'], 64: ['宁夏'], 65: ['新疆'],
  71: ['台湾'], 81: ['香港'], 82: ['澳门'],
}

/**
 * WMO weather codes → a short label and a glyph. The glyphs are plain
 * geometric/astronomical symbols, not emoji: the HUD's visual language is
 * quiet and native, and colour emoji would shout next to it.
 */
const WEATHER_CODES = {
  0: { zh: '晴', en: 'clear', glyph: '☀' },
  1: { zh: '晴间多云', en: 'mainly clear', glyph: '☀' },
  2: { zh: '多云', en: 'partly cloudy', glyph: '⛅' },
  3: { zh: '阴', en: 'overcast', glyph: '☁' },
  45: { zh: '雾', en: 'fog', glyph: '≋' },
  48: { zh: '雾凇', en: 'rime fog', glyph: '≋' },
  51: { zh: '毛毛雨', en: 'light drizzle', glyph: '☂' },
  53: { zh: '毛毛雨', en: 'drizzle', glyph: '☂' },
  55: { zh: '密集毛毛雨', en: 'dense drizzle', glyph: '☂' },
  56: { zh: '冻毛毛雨', en: 'freezing drizzle', glyph: '☂' },
  57: { zh: '冻毛毛雨', en: 'freezing drizzle', glyph: '☂' },
  61: { zh: '小雨', en: 'light rain', glyph: '☂' },
  63: { zh: '中雨', en: 'rain', glyph: '☂' },
  65: { zh: '大雨', en: 'heavy rain', glyph: '☂' },
  66: { zh: '冻雨', en: 'freezing rain', glyph: '☂' },
  67: { zh: '冻雨', en: 'freezing rain', glyph: '☂' },
  71: { zh: '小雪', en: 'light snow', glyph: '❄' },
  73: { zh: '中雪', en: 'snow', glyph: '❄' },
  75: { zh: '大雪', en: 'heavy snow', glyph: '❄' },
  77: { zh: '米雪', en: 'snow grains', glyph: '❄' },
  80: { zh: '阵雨', en: 'light showers', glyph: '☂' },
  81: { zh: '阵雨', en: 'showers', glyph: '☂' },
  82: { zh: '强阵雨', en: 'violent showers', glyph: '☂' },
  85: { zh: '阵雪', en: 'snow showers', glyph: '❄' },
  86: { zh: '强阵雪', en: 'heavy snow showers', glyph: '❄' },
  95: { zh: '雷阵雨', en: 'thunderstorm', glyph: '⚡' },
  96: { zh: '雷阵雨伴冰雹', en: 'thunderstorm, hail', glyph: '⚡' },
  99: { zh: '雷阵雨伴强冰雹', en: 'thunderstorm, heavy hail', glyph: '⚡' },
}

const COMPASS = [
  { zh: '北', en: 'N' }, { zh: '东北', en: 'NE' }, { zh: '东', en: 'E' }, { zh: '东南', en: 'SE' },
  { zh: '南', en: 'S' }, { zh: '西南', en: 'SW' }, { zh: '西', en: 'W' }, { zh: '西北', en: 'NW' },
]

/** 蒲福风级 upper bounds in km/h (level 0..11, 12 = ≥118). */
const BEAUFORT_KMH = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117]

// ── pure helpers ───────────────────────────────────────────────────────────

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** WMO code → `{ text, textEn, glyph }`, with a neutral entry for unknown codes. */
function weatherText(code) {
  const entry = WEATHER_CODES[code]
  if (!entry) return { text: `天气码 ${code ?? '?'}`, textEn: 'unknown', glyph: '·' }
  return { text: entry.zh, textEn: entry.en, glyph: entry.glyph }
}

/** Degrees → 8-point compass, in both languages. */
function compassOf(degrees) {
  const value = num(degrees)
  if (value === undefined) return undefined
  const index = ((Math.round(value / 45) % 8) + 8) % 8
  return COMPASS[index]
}

/** km/h → 蒲福风级 (0–12). */
function beaufort(kmh) {
  const value = num(kmh)
  if (value === undefined) return undefined
  for (let level = 0; level < BEAUFORT_KMH.length; level++) {
    if (value < BEAUFORT_KMH[level]) return level
  }
  return 12
}

/**
 * Split an NMC headline into its parts. The house format is
 * `<place>气象台发布<phenomenon><level>预警信号` (sometimes `…预警` without
 * `信号`), e.g. 「贵州省黔南布依族苗族自治州荔波县气象台发布大风蓝色预警信号」.
 * A title that does not match is passed through as-is rather than mangled.
 */
function parseAlertTitle(title) {
  const text = stringOr(title, '')
  const match = /^(?<place>.+?)气象台发布(?<phenomenon>.+?)(?<level>蓝色|黄色|橙色|红色)预警(?:信号)?$/.exec(text)
  if (!match?.groups) {
    return { place: '', phenomenon: text, level: '', tone: 'info' }
  }
  const { place, phenomenon, level } = match.groups
  const tone = level === '红色' ? 'crit' : level === '橙色' ? 'high' : level === '黄色' ? 'warn' : 'info'
  return { place, phenomenon, level, tone }
}

/** Strip the administrative suffixes so names compare cleanly. */
function provinceKey(name) {
  return String(name ?? '')
    .replace(/[\s]/g, '')
    .replace(/(特别行政区|维吾尔|壮族|回族|自治区|自治州|地区|省|市|盟|区|县)/g, '')
}

/** The 2-digit code NMC would prefix this province's alerts with. */
function provincePrefix(name) {
  const key = provinceKey(name)
  if (key.length < 2) return undefined
  for (const [code, aliases] of Object.entries(PROVINCE_CODES)) {
    if (aliases.some((alias) => key.startsWith(alias) || alias.startsWith(key))) return code
  }
  return undefined
}

/** The shortest useful city needle for title matching (无锡市 → 无锡). */
function cityNeedle(name) {
  const key = provinceKey(name)
  return key.length >= 2 ? key : undefined
}

/**
 * Pick the alerts that concern this location, newest first.
 *
 * City matches win outright: an alert naming the user's own city is about them.
 * Only when there is none does the province tier apply, and those rows are
 * tagged `scope: 'province'` so the UI can say "本省" instead of implying the
 * warning is overhead.
 */
function matchAlerts(all, location) {
  const list = Array.isArray(all) ? all : []
  const city = cityNeedle(location?.city ?? location?.name)
  const prefix = provincePrefix(location?.region ?? location?.admin1 ?? location?.province)

  const decorate = (item, scope) => {
    const parsed = parseAlertTitle(item?.title)
    return {
      id: stringOr(item?.alertid, ''),
      title: stringOr(item?.title, ''),
      ...parsed,
      scope,
      issuedAt: stringOr(item?.issuetime, ''),
      url: item?.url ? `${NMC_WEB}${item.url}` : undefined,
    }
  }

  const inProvince = prefix === undefined
    ? list
    : list.filter((item) => String(item?.alertid ?? '').startsWith(prefix))

  if (city) {
    const byCity = inProvince.filter((item) => String(item?.title ?? '').includes(city))
    if (byCity.length > 0) return byCity.slice(0, MAX_ALERTS).map((item) => decorate(item, 'city'))
  }
  // No city hit. Province rows are still worth showing, clearly labelled.
  return inProvince.slice(0, MAX_ALERTS).map((item) => decorate(item, 'province'))
}

/** The endpoints in use, with the panel config's overrides applied. */
function endpoints(cfg = {}) {
  return {
    forecast: stringOr(cfg.forecastUrl, OPEN_METEO),
    geocode: stringOr(cfg.geocodeUrl, GEOCODE),
    ipApi: stringOr(cfg.ipGeoUrl, IP_API),
    ipWho: stringOr(cfg.ipWhoUrl, IP_WHO),
    alarm: stringOr(cfg.alarmUrl, NMC_ALARM),
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * One bounded GET returning parsed JSON. Errors are turned into readable text
 * (host + status) instead of a raw fetch stack fragment, and a non-JSON body is
 * called out — several of these endpoints answer an auth/param problem with an
 * HTML page and `200`, which would otherwise surface as `Unexpected token '<'`.
 */
async function getJson(url, timeoutMs, headers = {}) {
  let res
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = /timeout|abort/i.test(message) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${message}`
    throw new Error(`${safeHost(url)} — ${reason}`)
  }
  if (!res.ok) throw new Error(`${safeHost(url)} HTTP ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${safeHost(url)} 返回的不是 JSON（可能被拦截或参数被拒）`)
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url).slice(0, 60)
  }
}

async function fetchAir(location) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${location.latitude}&longitude=${location.longitude}`
    + `&current=${AIR_FIELDS.join(',')}&timezone=auto`
  const res = await getJson(url, 12_000)
  const current = res?.current
  if (current === null || current === undefined) throw new Error('空气质量接口没有返回 current')
  const aqi = Number(current.us_aqi)
  return {
    at: current.time,
    usAqi: Number.isFinite(aqi) ? aqi : undefined,
    europeanAqi: Number(current.european_aqi),
    level: airLevel(aqi),
    pm25: Number(current.pm2_5),
    pm10: Number(current.pm10),
    ozone: Number(current.ozone),
    no2: Number(current.nitrogen_dioxide),
    so2: Number(current.sulphur_dioxide),
    co: Number(current.carbon_monoxide),
    units: res?.current_units ?? {},
    source: 'open-meteo air-quality',
  }
}

/** Location by name, via Open-Meteo's keyless geocoder. */
async function geocode(name, url, timeoutMs) {
  const query = `${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}&count=1&language=zh&format=json`
  const json = await getJson(query, timeoutMs)
  const hit = json?.results?.[0]
  if (!hit) throw new Error(`没有找到「${name}」这个地点`)
  return {
    name: stringOr(hit.name, name),
    region: stringOr(hit.admin1, ''),
    country: stringOr(hit.country, ''),
    countryCode: stringOr(hit.country_code, '').toUpperCase(),
    latitude: num(hit.latitude),
    longitude: num(hit.longitude),
    timezone: stringOr(hit.timezone, ''),
    source: 'geocode',
  }
}

/**
 * Location by IP. ip-api first (it is the one that answers in Chinese via
 * `lang=zh-CN`, which is what makes province matching work), ipwho.is second
 * because it is https and structured differently — a network that blocks one
 * rarely blocks both.
 *
 * Takes the two URLs explicitly rather than re-deriving them: `readConfig`
 * already resolved the overrides, and re-deriving here silently fell back to
 * the PUBLIC endpoints — which made the test suite pass while talking to the
 * real internet instead of its stub.
 */
async function locateByIp(urls, timeoutMs) {
  try {
    const json = await getJson(urls.ipApi, timeoutMs)
    if (json?.status === 'success') {
      return {
        name: stringOr(json.city, ''),
        region: stringOr(json.regionName, ''),
        country: stringOr(json.country, ''),
        countryCode: stringOr(json.countryCode, '').toUpperCase(),
        latitude: num(json.lat),
        longitude: num(json.lon),
        timezone: stringOr(json.timezone, ''),
        source: 'ip',
      }
    }
    throw new Error(stringOr(json?.message, 'ip-api 未返回结果'))
  } catch (firstError) {
    try {
      const json = await getJson(urls.ipWho, timeoutMs)
      if (json?.success === true) {
        return {
          name: stringOr(json.city, ''),
          region: stringOr(json.region, ''),
          country: stringOr(json.country, ''),
          countryCode: stringOr(json.country_code, '').toUpperCase(),
          latitude: num(json.latitude),
          longitude: num(json.longitude),
          timezone: stringOr(json.timezone?.id, ''),
          source: 'ip',
        }
      }
      throw new Error('ipwho.is 未返回结果')
    } catch (secondError) {
      const detail = firstError instanceof Error ? firstError.message : String(firstError)
      throw new Error(`无法通过 IP 定位（${detail}）`)
    }
  }
}

// ── panel ──────────────────────────────────────────────────────────────────

/**
 * The settings this panel contributes, merged into the plugin config under
 * `panels.weather`. `latitude`/`longitude`/`city` are all optional: with none
 * of them set the panel locates the user by IP.
 */
export function schema(z) {
  try {
    return z.object({
      city: live(z.string().default('')),
      latitude: live(z.number().default(0)),
      longitude: live(z.number().default(0)),
      refreshMs: live(z.number().min(MIN_REFRESH_MS).default(DEFAULT_REFRESH_MS)),
      /** `auto` = NMC when the location is in China, `off` = never ask. */
      alerts: live(z.string().default('auto')),
      timeoutMs: live(z.number().min(MIN_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)),
      // Endpoint overrides — the same escape hatch the quota panel has for
      // `baseUrl`, and what lets the test suite drive a local stub instead of
      // the public internet.
      forecastUrl: live(z.string().default('')),
      geocodeUrl: live(z.string().default('')),
      ipGeoUrl: live(z.string().default('')),
      ipWhoUrl: live(z.string().default('')),
      alarmUrl: live(z.string().default('')),
    })
  } catch {
    return undefined
  }
}

function readConfig(host) {
  const own = host.config() ?? {}
  const latitude = num(own.latitude)
  const longitude = num(own.longitude)
  return {
    city: stringOr(own.city, '').trim(),
    // 0/0 is "null island", never a real answer — treated as unset.
    latitude: latitude !== undefined && !(latitude === 0 && longitude === 0) ? latitude : undefined,
    longitude: longitude !== undefined && !(latitude === 0 && longitude === 0) ? longitude : undefined,
    refreshMs: clamp(num(own.refreshMs) ?? DEFAULT_REFRESH_MS, MIN_REFRESH_MS, 6 * 60 * 60_000),
    alerts: stringOr(own.alerts, 'auto').toLowerCase(),
    timeoutMs: clamp(num(own.timeoutMs) ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, 60_000),
    ...endpoints(own),
  }
}

/**
 * @param {import('../../lib/host-kit.js').PanelHost} host
 */
export function mount(host) {
  const storage = host.storage
  const log = host.log

  /** @type {{ location?: any, at: number }} */
  let cachedLocation = (() => {
    const stored = storage.read()
    const location = stored?.location
    const at = num(stored?.at) ?? 0
    return location && typeof location === 'object' ? { location, at } : { at: 0 }
  })()

  /**
   * Where the user is. Precedence: explicit coordinates → explicit city name →
   * a still-fresh IP result → a fresh IP lookup. The IP answer is cached for a
   * day in the panel's own state file, so a transient outage of the geo service
   * never blanks the widget.
   */
  const resolveLocation = async (cfg, force = false) => {
    if (cfg.latitude !== undefined && cfg.longitude !== undefined) {
      return {
        name: cfg.city || '设定坐标',
        region: '',
        country: '',
        countryCode: '',
        latitude: cfg.latitude,
        longitude: cfg.longitude,
        timezone: '',
        source: 'config',
      }
    }
    if (cfg.city) {
      return geocode(cfg.city, cfg.geocode, cfg.timeoutMs)
    }
    if (!force && cachedLocation.location && Date.now() - cachedLocation.at < LOCATION_TTL_MS) {
      return cachedLocation.location
    }
    const location = await locateByIp({ ipApi: cfg.ipApi, ipWho: cfg.ipWho }, cfg.timeoutMs)
    cachedLocation = { location, at: Date.now() }
    storage.write({ version: 1, location, at: cachedLocation.at })
    return location
  }

  /** Current conditions, normalized to °C / km/h / %. */
  const fetchCurrent = async (cfg, location) => {
    const url = `${cfg.forecast}${cfg.forecast.includes('?') ? '&' : '?'}`
      + `latitude=${location.latitude}&longitude=${location.longitude}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m'
      + '&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&timezone=auto'
    const json = await getJson(url, cfg.timeoutMs)
    const current = json?.current
    if (!current || num(current.temperature_2m) === undefined) {
      throw new Error('天气接口没有返回当前观测值')
    }
    const code = num(current.weather_code)
    const windSpeed = num(current.wind_speed_10m)
    const direction = compassOf(current.wind_direction_10m)
    return {
      code,
      ...weatherText(code),
      temperature: num(current.temperature_2m),
      feelsLike: num(current.apparent_temperature),
      humidity: num(current.relative_humidity_2m),
      precipitation: num(current.precipitation),
      windSpeed,
      windGust: num(current.wind_gusts_10m),
      windDeg: num(current.wind_direction_10m),
      windDirection: direction,
      windForce: beaufort(windSpeed),
      isDay: current.is_day === 1,
      observedAt: stringOr(current.time, ''),
      timezone: stringOr(json?.timezone, ''),
    }
  }

  /**
   * Extreme-weather alerts. NMC is China's national service, so it is only
   * asked when the location resolved to China — a US or EU user gets an empty
   * list and an honest `source: 'unsupported'` instead of a pointless request.
   */
  const fetchAlerts = async (cfg, location) => {
    if (cfg.alerts === 'off') return { alerts: [], source: 'off' }
    const inChina = location.countryCode === 'CN' || /中国/.test(String(location.country ?? '')) || location.source === 'ip-api'
    if (cfg.alerts === 'auto' && !inChina) return { alerts: [], source: 'unsupported' }
    const url = `${cfg.alarm}${cfg.alarm.includes('?') ? '&' : '?'}pageNo=1&pageSize=${ALERT_PAGE_SIZE}`
    const json = await getJson(url, cfg.timeoutMs)
    const list = json?.data?.page?.list
    if (!Array.isArray(list)) throw new Error('预警接口没有返回列表')
    return { alerts: matchAlerts(list, location), source: 'nmc', scanned: list.length }
  }

  /** One upstream refresh, with every failure contained per section. */
  const collect = async (force = false) => {
    const cfg = readConfig(host)
    const out = {
      ok: true,
      fetchedAt: Date.now(),
      refreshMs: cfg.refreshMs,
      location: null,
      current: null,
      alerts: [],
      alertSource: 'none',
    }

    let location
    try {
      location = await resolveLocation(cfg, force)
    } catch (error) {
      out.location = null
      out.hint = {
        title: '还无法确定所在城市',
        steps: [
          error instanceof Error ? error.message : String(error),
          '在 设置 → 插件 → dsh-hud → panels.weather 里填 city（例如 无锡），或直接填 latitude / longitude',
        ],
      }
      return out
    }
    out.location = location

    // Weather, alerts and AIR are independent: a country with no alert source must
    // not cost the user their temperature reading, and an air-quality outage must
    // not either. Three settled results, three contained failures.
    const [weatherResult, alertResult, airResult] = await Promise.allSettled([
      fetchCurrent(cfg, location),
      fetchAlerts(cfg, location),
      fetchAir(location),
    ])
    if (airResult.status === 'fulfilled') {
      out.air = airResult.value
    } else {
      // An air-quality failure is reported NEXT TO the weather, never instead of
      // it — the temperature is the thing people came for.
      out.air = null
      out.airError = airResult.reason instanceof Error ? airResult.reason.message : String(airResult.reason)
    }
    if (weatherResult.status === 'fulfilled') {
      out.current = weatherResult.value
    } else {
      const message = weatherResult.reason instanceof Error ? weatherResult.reason.message : String(weatherResult.reason)
      out.hint = { title: '天气查询失败', steps: [message] }
    }
    if (alertResult.status === 'fulfilled') {
      out.alerts = alertResult.value.alerts
      out.alertSource = alertResult.value.source
      out.alertsScanned = alertResult.value.scanned
    } else {
      const message = alertResult.reason instanceof Error ? alertResult.reason.message : String(alertResult.reason)
      out.alerts = []
      out.alertSource = 'error'
      out.alertsError = message
    }
    return out
  }

  // ── upstream cache: one call per window, however many tabs are open ──────
  /** @type {{ at: number, promise: Promise<any> } | null} */
  let cache = null
  const stateOnce = (force) => {
    const cfg = readConfig(host)
    const now = Date.now()
    if (!force && cache && now - cache.at < cfg.refreshMs) return cache.promise
    const promise = collect(force).catch((error) => {
      if (cache?.promise === promise) cache = null
      throw error
    })
    cache = { at: now, promise }
    return promise
  }

  const handleState = async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    if (String(req?.method ?? 'GET').toUpperCase() === 'HEAD') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
      return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    try {
      const payload = await stateOnce(false)
      log(`weather: ${summarize(payload)}`)
      host.json(res, 200, payload)
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRefresh = async (req, res) => {
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    try {
      req.resume?.()
    } catch {
      /* no body to drain */
    }
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    try {
      host.json(res, 200, await stateOnce(true))
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctxEffect(host, () => {
    const offState = host.route('state', handleState)
    const offRefresh = host.route('refresh', handleRefresh)
    return () => {
      offState()
      offRefresh()
    }
  })

  // Handles for tests and sibling panels.
  return {
    collect,
    state: () => stateOnce(false),
    location: () => cachedLocation.location,
    endpoints: () => {
      const cfg = readConfig(host)
      return { forecast: cfg.forecast, geocode: cfg.geocode, ipApi: cfg.ipApi, alarm: cfg.alarm }
    },
  }
}

/** Register routes through the panel's effect so teardown is automatic. */
function ctxEffect(host, callback) {
  if (typeof host.ctx?.effect === 'function') return host.ctx.effect(callback, 'dsh-hud/weather: routes')
  return callback()
}

/** One-line summary for the host log — never a secret, never a whole payload. */
function summarize(payload) {
  if (!payload?.current) return payload?.hint?.title ?? 'no reading'
  const place = payload.location?.name || payload.location?.region || '?'
  const alerts = payload.alerts?.length ? `, ${payload.alerts.length} alert(s)` : ''
  return `${place} ${payload.current.text} ${payload.current.temperature}°C, humidity ${payload.current.humidity}%${alerts}`
}


/**
 * Air quality, from Open-Meteo's keyless air-quality API — the same family as the
 * forecast call above, so there is no second provider to trust or to fail.
 *
 * Only fields that EXIST are requested: asking for one that does not (e.g.
 * `pm2_5_albedo`, which is a forecast-only variable) is answered with a 400 and
 * an empty body, which is how the first version of this function failed.
 */
const AIR_FIELDS = ['us_aqi', 'pm2_5', 'pm10', 'carbon_monoxide', 'nitrogen_dioxide', 'sulphur_dioxide', 'ozone', 'european_aqi']
const AIR_LEVELS = [
  { max: 50, zh: '优', en: 'good' },
  { max: 100, zh: '良', en: 'moderate' },
  { max: 150, zh: '轻度污染', en: 'unhealthy for sensitive groups' },
  { max: 200, zh: '中度污染', en: 'unhealthy' },
  { max: 300, zh: '重度污染', en: 'very unhealthy' },
  { max: Number.POSITIVE_INFINITY, zh: '严重污染', en: 'hazardous' },
]

/** US AQI → its band. The bands are the EPA's, which is what `us_aqi` means. */
export function airLevel(aqi) {
  // `Number(null)` is 0 and `Number('')` is 0, so a MISSING reading would come back
  // as 优 — "perfect air" for data that never arrived. Absent is absent.
  if (aqi === null || aqi === undefined || aqi === '') return undefined
  const value = Number(aqi)
  if (!Number.isFinite(value)) return undefined
  const band = AIR_LEVELS.find((entry) => value <= entry.max)
  return band === undefined ? undefined : { zh: band.zh, en: band.en, max: band.max === Number.POSITIVE_INFINITY ? undefined : band.max }
}

/** Pure helpers, exported for the test harness. */
export const __test = {
  airLevel,
  AIR_FIELDS,
  weatherText,
  compassOf,
  beaufort,
  parseAlertTitle,
  provincePrefix,
  cityNeedle,
  matchAlerts,
  endpoints,
  summarize,
}
