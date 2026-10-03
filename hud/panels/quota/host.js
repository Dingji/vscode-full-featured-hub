// @ts-check
/**
 * dsh-hud — host half of the `quota` panel.
 *
 * A collector registry that normalizes quota data from several subscription
 * providers into ONE shape the browser renders adaptively:
 *
 *   { windows: [{ key, percent, resetsAt }], balances: [{ key, value, currency }], plan }
 *
 * `windows` is the limit-window view (5-hour / weekly / monthly) and `balances`
 * is the prepaid-balance view — a subscription renders whichever it has, and
 * only the windows it actually reports (some plans have 5h+weekly only, some
 * monthly only). Providers are discovered from the live `llm-pi-ai` table by
 * name inference, plus any explicitly configured entries.
 *
 * Built-in collectors (endpoints verified against each vendor's docs):
 *   - opencode-go : GET {base}/v1/usage              → rolling/weekly/monthly %
 *   - zai         : GET /api/monitor/usage/quota/limit → GLM Coding Plan
 *                   TOKENS_LIMIT unit 3 (5h) / unit 6 (weekly) / TIME_LIMIT (monthly)
 *   - deepseek    : GET https://api.deepseek.com/user/balance → balances
 *   - moonshot    : GET /v1/users/me/balance          → available/voucher/cash
 *   - custom      : any JSON endpoint; windows auto-detected by key name
 *
 * API keys are resolved through DSH's credentials service and never leave the
 * host. Three same-origin routes serve the browser — the shell registers them
 * under the merged plugin's prefix (see lib/host-kit.js):
 *   GET  /dsh-hud/quota/usage       cached snapshot of every subscription
 *   POST /dsh-hud/quota/refresh     bypass the cache and re-query now
 *   POST /dsh-hud/quota/credential  store one credential (save drawer)
 * The payload also carries `pollMs` — the live client cadence (floor 30 s).
 *
 * The dock cell, the panel registry, schemastery and every timer belong to the
 * shell; this module owns discovery, collection and the routes above only.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { execFile } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

// The shared panel contract: `live()` marks a field live-editable and
// `unwrap()` reads through a schemastery wrapper. Schemastery resolution and
// the settings namespace now belong to the shell, which calls `schema(z)`
// below with its own `z` and merges the result under `panels.quota`.
//
// This panel keeps no state file, so `storageDomain` is omitted: createHost
// defaults it to `dsh-hud/<id>` — i.e. `dsh-hud/quota`.
import { live, packageVersion, unwrap } from '../../lib/host-kit.js'

/** Panel identity — the shell reads these to build the card's tab. */
export const id = 'quota'
export const order = 10
export const label = { zh: '用量', en: 'Quota' }

/** Test-only pure helpers (the shell only reads id/order/label/schema/mount). */
export const __test = { refsFor, openCodeTokenFromFile, parseCsv, bucketTime }

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'
const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'
const DEFAULT_PROVIDER_PREFIX = 'opencode'
/** Platform-session credential that unlocks DeepSeek's private usage export. */
const DEEPSEEK_USER_TOKEN = 'DEEPSEEK_USER_TOKEN'
const DEFAULT_CACHE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 15_000
/** Client poll cadence. Floor is 30 s — the API contract the UI enforces too. */
const DEFAULT_POLL_MS = 60_000
const MIN_POLL_MS = 30_000
const MAX_POLL_MS = 600_000
const MIN_CACHE_MS = 5_000
const MIN_TIMEOUT_MS = 2_000
/** Loader entries probed for the providers table. */
const PI_AI_SOURCES = ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai']
/**
 * The OFFICIAL DeepSeek provider (`provider id: deepseek-official`) is
 * registered by its own plugin, NOT by llm-pi-ai — without probing it here the
 * subscription row never exists and switching to the official source would
 * fall back to showing another vendor's billing.
 *
 * Entry ids differ by build: current bundles ship `llm-deepseek`
 * (`@deepseek-ai/dsh-llm-deepseek`, the provider adapter), while older ones
 * shipped `llm-deepseek-api-key`. Probe BOTH so the row exists either way.
 */
const DEEPSEEK_OFFICIAL_SOURCES = [
  'llm-deepseek',
  '@deepseek-ai/dsh-llm-deepseek',
  'llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
]
/** Collector kinds accepted by the config schema. */
const KINDS = ['auto', 'opencode-go', 'zai', 'grok', 'mimo', 'deepseek', 'moonshot', 'openrouter', 'siliconflow', 'qwen', 'commandcode', 'custom', 'custom2']

// ── 千问AI平台 control-plane gateway (personal Token Plan) ─────────────────
/** The console's `/data/api.json` gateway; overridden per-subscription by `consoleUrl`. */
const QWEN_CONSOLE_URL = 'https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway'
/** credential holding the full `Cookie:` header of platform.qianwenai.com. */
const QWEN_CONSOLE_COOKIE = 'QWEN_CONSOLE_COOKIE'
const QWEN_API_PREFIX = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/'
/** `Data.cornerstoneParam` the console always sends with these calls. */
const QWEN_CORNERSTONE = {
  domain: 'platform.qianwenai.com',
  consoleSite: 'QIANWENAI',
  console: 'ONE_CONSOLE',
  xsp_lang: 'zh-CN',
  protocol: 'V2',
  productCode: 'p_efm',
}

/**
 * Panel settings schema, merged by the shell under `panels.quota`. Only
 * schemastery calls proven to exist on this runtime are used (`min` exists,
 * `gte`/`lte` do not) — a throw here silently drops the whole generated
 * settings page.
 */
export function schema(z) {
  try {
    const windowEntry = z.object({
      key: z.string().default(''),
      label: z.string().default(''),
      percentPath: z.string().default(''),
      usedPath: z.string().default(''),
      totalPath: z.string().default(''),
      resetsAtPath: z.string().default(''),
      unit: z.string().default(''),
    })
    const balanceEntry = z.object({
      label: z.string().default(''),
      path: z.string().default(''),
      currency: z.string().default(''),
    })
    const entry = z.object({
      id: z.string().default(''),
      label: z.string().default(''),
      kind: z.string().default('custom'),
      apiKeyEnv: z.string().default(''),
      baseUrl: z.string().default(''),
      url: z.string().default(''),
      auth: z.string().default('bearer'),
      headerName: z.string().default(''),
      seriesUrl: z.string().default(''),
      consoleUrl: z.string().default(''),
      // custom2-only fields (user-defined endpoint + field mapping).
      // NOTE: `.volatile()` is illegal on fields nested inside an array —
      // cordis rejects "volatile fields require a fixed object path". The
      // parent `subscriptions` array IS volatile, so editing it re-reads these.
      method: z.string().default('GET'),
      headers: z.dict(z.string()).default({}),
      body: z.dict(z.any()).default({}),
      windows: z.array(windowEntry).default([]),
      balances: z.array(balanceEntry).default([]),
      planPath: z.string().default(''),
    })
    return z.object({
      apiKeyEnv: live(z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV)),
      baseUrl: live(z.string().default(DEFAULT_BASE_URL)),
      providerPrefix: live(z.string().default(DEFAULT_PROVIDER_PREFIX)),
      subscriptions: live(z.array(entry).default([])),
      cacheMs: live(z.number().min(MIN_CACHE_MS).default(DEFAULT_CACHE_MS)),
      timeoutMs: live(z.number().min(MIN_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)),
      pollMs: live(z.number().min(MIN_POLL_MS).default(DEFAULT_POLL_MS)),
    })
  } catch {
    return undefined
  }
}

/** Deep-unwrap a plain object (volatile refs may nest one level). */
function deepUnwrapObject(value) {
  const v = unwrap(value)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out = {}
  for (const [k, raw] of Object.entries(v)) {
    const val = unwrap(raw)
    if (val !== undefined) out[k] = val
  }
  return out
}

/** Deep-unwrap an array (volatile refs may wrap the array or its items). */
function deepUnwrapArray(value) {
  const v = unwrap(value)
  if (!Array.isArray(v)) return []
  return v.map((item) => {
    const it = unwrap(item)
    if (it && typeof it === 'object' && !Array.isArray(it)) return deepUnwrapObject(it)
    return it
  })
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '')
}

/** Origin of any provider base URL (chat bases carry paths; monitors don't). */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Epoch ms from a seconds/millis/ISO timestamp. */
function epochMs(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const t = new Date(value).getTime()
    if (Number.isFinite(t)) return t
    const asNum = Number(value)
    if (Number.isFinite(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum
  }
  return undefined
}

/** UTC midnight on the 1st of next month (fallback reset for monthly windows). */
function nextUtcFirstOfMonth() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
}

/** Percentage 0–100 from an object carrying percent/used+total style fields. */
function percentOf(w) {
  if (!w || typeof w !== 'object') return undefined
  const direct = num(w.percent) ?? num(w.percentage) ?? num(w.percentUsed) ?? num(w.usedPercent) ?? num(w.usagePercent)
  if (direct !== undefined) return clamp(direct, 0, 100)
  const used = num(w.currentValue) ?? num(w.used)
  const total = num(w.usage) ?? num(w.total) ?? num(w.limit) ?? num(w.cap)
  if (used !== undefined && total !== undefined && total > 0) return clamp((used / total) * 100, 0, 100)
  return undefined
}

// The version comes from the kit: this file lives in `panels/quota/`, so its own
// `./package.json` would not exist and the payload used to report `0.0.0`.
const CURRENT_VERSION = packageVersion()

/** Read the live `llm-pi-ai` providers table from the Loader (hot: no restart). */
function piAiProviders(ctx) {
  return loaderEntryConfig(ctx, PI_AI_SOURCES, 'providers', {})
}

/**
 * Read one field out of the first matching loader entry's live config.
 * Probes are tried in order; entries are guarded because some are unaddressable.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} probes entry id / package name candidates
 * @param {string} [field] config field to read (omit for the whole config)
 * @param {unknown} [fallback]
 */
function loaderEntryConfig(ctx, probes, field, fallback) {
  const loader = ctx.loader ?? ctx.root?.loader
  if (!loader || typeof loader.entries !== 'function') return fallback
  let entries = []
  try {
    entries = loader.entries() ?? []
  } catch {
    return fallback
  }
  for (const probe of probes) {
    for (const entry of entries) {
      try {
        if (entry?.disabled || !entry?.fiber) continue
        if (entry.options?.id !== probe && entry.options?.name !== probe) continue
        const cfg = unwrap(entry.fiber.config)
        if (field === undefined) return cfg
        const value = unwrap(cfg?.[field])
        if (value !== undefined && value !== null) return value
      } catch {
        // unaddressable entry — probe the next one
      }
    }
  }
  return fallback
}

/**
 * Infer the collector kind from a provider/subscription id. `null` means
 * "unknown" — those are skipped unless explicitly configured, so a generic
 * OpenAI-compatible proxy never adds a dead carousel entry.
 */
function inferKind(id) {
  const s = String(id ?? '').toLowerCase()
  if (s.includes('opencode')) return 'opencode-go'
  if (s.includes('deepseek')) return 'deepseek'
  if (s.includes('moonshot') || s.includes('kimi')) return 'moonshot'
  if (s.includes('glm') || s.includes('zai') || s.includes('zhipu') || s.includes('bigmodel') || s.includes('z.ai')) return 'zai'
  if (s.includes('grok') || s.includes('xai')) return 'grok'
  if (s.includes('mimo') || s.includes('xiaomi')) return 'mimo'
  if (s.includes('openrouter')) return 'openrouter'
  if (s.includes('siliconflow') || s.includes('silicon') || s.includes('siliflow')) return 'siliconflow'
  if (s.includes('qwen') || s.includes('qianwen') || s.includes('dashscope') || s.includes('token-plan')
      || s.includes('alibaba') || s.includes('aliyun') || s.includes('bailian')) return 'qwen'
  if (s.includes('commandcode') || s.includes('command-code')) return 'commandcode'
  return null
}

// ── structured guidance ───────────────────────────────────────────────────

/**
 * An error that carries a fix-it panel the client renders verbatim:
 *   { title, install?, steps? }  →  “请安装 XXX” + the install command + steps.
 */
class HintError extends Error {
  constructor(message, hint) {
    super(message)
    this.hint = hint
  }
}

// ── DeepSeek usage series (last month) ─────────────────────────────────────

const DEEPSEEK_EXPORT_URL = 'https://platform.deepseek.com/api/v0/usage/export'
/** Chart window: the last 30 calendar days (UTC), including today. */
const DS_SERIES_DAYS = 30
const ZIP_MAX_ENTRIES = 64
const ZIP_MAX_BYTES = 32 * 1024 * 1024
const TOKEN_ROW_TYPES = new Set(['output_tokens', 'input_cache_hit_tokens', 'input_cache_miss_tokens'])

/**
 * Extract every `.csv` out of a ZIP buffer. Standard EOCD → central directory
 * walk (deflate method 8 via zlib, stored method 0). CRCs are not verified —
 * the bytes come straight from the platform over HTTPS.
 * @param {Buffer} buffer
 * @returns {Record<string, string>}
 */
function extractZipCsv(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('用量导出不是合法 ZIP（结构异常）')
  const count = buffer.readUInt16LE(eocd + 10)
  if (count > ZIP_MAX_ENTRIES) throw new Error('用量导出 ZIP 条目过多')
  let offset = buffer.readUInt32LE(eocd + 16)
  const files = {}
  let outputBytes = 0
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('用量导出 ZIP 目录结构异常')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compSize = buffer.readUInt32LE(offset + 20)
    const uncompSize = buffer.readUInt32LE(offset + 24)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    if (uncompSize > ZIP_MAX_BYTES || outputBytes + uncompSize > ZIP_MAX_BYTES) {
      throw new Error('用量导出 ZIP 解压内容过大')
    }
    const lhNameLen = buffer.readUInt16LE(localOffset + 26)
    const lhExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen
    if (dataStart > buffer.length || compSize > buffer.length - dataStart) {
      throw new Error('用量导出 ZIP 数据边界异常')
    }
    const compressed = buffer.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = compressed
    else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: ZIP_MAX_BYTES - outputBytes })
    else throw new Error(`用量导出 ZIP 压缩方式 ${method} 不支持`)
    outputBytes += data.length
    if (name.toLowerCase().endsWith('.csv')) files[name] = data.toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
  }
  return files
}

/** Minimal CSV line splitter (quotes, escaped quotes, commas). */
function parseCsvLine(line) {
  const out = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++ } else inQuotes = false
      } else current += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(current); current = '' }
    else current += ch
  }
  out.push(current)
  return out
}

function parseCsv(text) {
  const lines = String(text ?? '').trim().split('\n').map((l) => l.replace(/\r+$/, ''))
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0].replace(/^﻿/, ''))
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i].trim())
    if (values.length < 2) continue
    const row = {}
    headers.forEach((h, idx) => { row[h] = idx < values.length ? values[idx] : '' })
    rows.push(row)
  }
  return rows
}

/** UTC epoch ms for `YYYY-MM-DD` or `YYYYMMDD`. */
function parseUtcDate(v) {
  const s = String(v ?? '').trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return null
}

/** Time-of-day column the export may include (`utc_date` alone is daily). */
const DS_TIME_COLUMNS = ['utc_hour', 'hour', 'time', 'utc_time', 'datetime', 'utc_datetime', 'timestamp']

function bucketTime(row, timeCol) {
  const date = parseUtcDate(row.utc_date)
  if (timeCol) {
    const raw = String(row[timeCol] ?? '').trim()
    if (raw) {
      if (/\d{1,2}:\d{2}/.test(raw)) {
        const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`
        const t = Date.parse(iso)
        if (Number.isFinite(t)) return Math.floor(t / 3600000) * 3600000
        // `YYYY-MM-DD HH:MM` without timezone → attach the date explicitly.
        const hm = /(\d{1,2}):(\d{2})/.exec(raw)
        if (hm && date !== null) return date + (Number(hm[1]) * 3600 + Number(hm[2]) * 60) * 1000
      }
      const hm = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw)
      if (hm && date !== null) {
        return date + (Number(hm[1]) * 3600 + Number(hm[2] ?? 0) * 60) * 1000
      }
    }
  }
  if (date !== null) return Math.floor(date / 3600000) * 3600000 // day bucket at UTC midnight
  return null
}

/**
 * Turn export CSV rows into a time series of tokens (plus cost).
 * Granularity is whatever the platform actually returns — hourly when a
 * time-of-day column exists — EXCEPT for long windows: a week or more is
 * daily by definition, one point per calendar day, and every day in the
 * window is emitted (zero-usage days become explicit 0 points instead of
 * silently vanishing from the month).
 */
function buildSeries(rows, fromMs, toMs) {
  const windowDays = (toMs - fromMs) / 86400000
  const forceDay = windowDays >= 7
  const timeCol = forceDay
    ? null
    : DS_TIME_COLUMNS.find((c) => rows.some((r) => String(r[c] ?? '').trim() !== ''))
  const buckets = new Map()
  let tokens = 0
  let cost = 0
  for (const row of rows) {
    if (!TOKEN_ROW_TYPES.has(String(row.type ?? ''))) continue
    const amount = Number.parseFloat(row.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const t = bucketTime(row, timeCol)
    if (t === null || t < fromMs - 86400000 || t > toMs + 3600000) continue
    const entry = buckets.get(t) ?? { t, v: 0, c: 0 }
    const rowCost = (Number.parseFloat(row.price) || 0) * amount
    entry.v += amount
    entry.c += rowCost
    buckets.set(t, entry)
    tokens += amount
    cost += rowCost
  }
  const granularity = timeCol ? 'hour' : 'day'
  let series = [...buckets.values()]
  if (!timeCol) {
    // Daily mode → exactly one point per UTC day across the whole window.
    // `fromMs` is a UTC midnight (month windows are day-aligned upstream).
    const startDay = Math.floor(fromMs / 86400000) * 86400000
    const endDay = Math.floor(toMs / 86400000) * 86400000
    series = []
    for (let t = startDay; t <= endDay; t += 86400000) {
      series.push(buckets.get(t) ?? { t, v: 0, c: 0 })
    }
  }
  series.sort((a, b) => a.t - b.t)
  return {
    series: series.map((p) => ({ t: p.t, v: Math.round(p.v), c: Math.round(p.c * 1e6) / 1e6 })),
    granularity,
    tokens: Math.round(tokens),
    cost: Math.round(cost * 1e6) / 1e6,
    from: fromMs,
    to: toMs,
  }
}

/**
 * Fetch the last month of usage from the platform export (ZIP → CSV).
 * Needs the platform `userToken` — an API key cannot authenticate these
 * private dashboard endpoints.
 */
/**
 * The month export needs a PLATFORM userToken (localStorage) — neither an API
 * key nor the account-platform grant token is accepted (verified against the
 * live service). Attach a ready-to-render hint so the user sees the exact
 * steps instead of a transport error.
 * @param {'missing'|'expired'} kind
 */
function seriesTokenError(kind) {
  const err = new Error(
    kind === 'missing'
      ? '用量导出缺少 DEEPSEEK_USER_TOKEN'
      : 'DEEPSEEK_USER_TOKEN 已失效（401/403/invalid token）',
  )
  err.hint = {
    title: kind === 'missing'
      ? '配置 DEEPSEEK_USER_TOKEN 解锁近 30 天用量曲线'
      : 'DEEPSEEK_USER_TOKEN 已失效，请重新复制',
    steps: [
      '登录 platform.deepseek.com → F12 Console 执行 copy(JSON.parse(localStorage.getItem("userToken")).value)',
      '存入 credential DEEPSEEK_USER_TOKEN（JSON 包装整段粘贴也可以）',
    ],
  }
  return err
}

/**
 * `localStorage.getItem("userToken")` answers a JSON wrapper on current
 * builds — `{"value":"…","__version":"0"}` — and users paste it raw. Sending
 * that wrapper as a bearer token earns `40003 invalid token`, so unwrap it
 * here and accept BOTH shapes.
 * @param {unknown} raw
 * @returns {string|undefined}
 */
function unwrapUserToken(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return undefined
  if (!value.startsWith('{')) return value
  try {
    const parsed = JSON.parse(value)
    const inner = typeof parsed?.value === 'string' ? parsed.value.trim() : ''
    return inner || undefined
  } catch {
    return value // not JSON after all — send it unchanged
  }
}

async function fetchDeepSeekSeries(userToken, timeoutMs, exportBase) {
  const now = Date.now()
  // One calendar month: UTC midnight of (now − 29 days) through the next UTC
  // midnight — 30 days INCLUDING today.
  const startDay = new Date(now - (DS_SERIES_DAYS - 1) * 86400000)
  const endDay = new Date(now)
  const start = Math.floor(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()) / 1000)
  const end = Math.floor(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate() + 1) / 1000)
  const from = start * 1000
  const url = `${stringOr(exportBase, DEEPSEEK_EXPORT_URL)}?start=${start}&end=${end}&tz=0`
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${userToken}`,
      'user-agent': 'Mozilla/5.0 (dsh-quota-hud)',
      referer: 'https://platform.deepseek.com/',
      accept: 'application/zip, text/csv, */*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 401 || res.status === 403) {
    throw seriesTokenError('expired')
  }
  if (!res.ok) throw new Error(`用量导出 HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  // The platform answers auth problems with HTTP 200 + a JSON body, NEVER a
  // ZIP — parsing that as a ZIP produced the misleading "not a valid ZIP".
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    const body = buffer.toString('utf8')
    let code = ''
    let msg = ''
    try {
      const parsed = JSON.parse(body)
      code = String(parsed?.code ?? '')
      msg = String(parsed?.msg ?? '')
    } catch {
      // fall through to the generic message below
    }
    const blob = `${code} ${msg}`
    if (/40002|missing token/i.test(blob)) throw seriesTokenError('missing')
    if (/40003|invalid token/i.test(blob)) throw seriesTokenError('expired')
    throw new Error(msg ? `用量导出返回错误 ${code}：${msg}` : '用量导出返回的不是 ZIP')
  }
  const files = extractZipCsv(buffer)
  const csv = Object.entries(files).find(([name]) => name.toLowerCase().includes('amount'))?.[1]
    ?? Object.values(files)[0]
  if (!csv) throw new Error('用量导出 ZIP 里没有 CSV')
  return buildSeries(parseCsv(csv), from, now)
}

// ── collectors ────────────────────────────────────────────────────────────

/** Short `host + path` for error messages (never leaks query strings/keys). */
function safeEndpoint(url) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return String(url).slice(0, 80)
  }
}

async function httpJson(url, headers, timeoutMs, opts = {}) {
  let res
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      // Cookie-authed consoles redirect to a login page when the session died;
      // following it would return HTML, so some collectors ask for the raw 3xx.
      ...(opts.redirect ? { redirect: opts.redirect } : {}),
    })
  } catch (error) {
    // Network / timeout failures become readable text instead of a raw
    // "fetch failed" stack fragment.
    const msg = error instanceof Error ? error.message : String(error)
    const reason = /timeout|aborted|abort/i.test(msg)
      ? `请求超时（${timeoutMs} ms）`
      : `网络请求失败：${msg}`
    throw new Error(`${safeEndpoint(url)} — ${reason}`)
  }
  if (opts.redirect === 'manual' && res.status >= 300 && res.status < 400) {
    throw new Error('登录已过期（重定向到登录页），请重新获取凭据')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} @ ${safeEndpoint(url)}${body ? `: ${body.slice(0, 160)}` : ''}`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error(`${safeEndpoint(url)} 返回的不是 JSON（可能需要重新登录，或接口已变更）`)
  }
}

/** opencode-go: GET {base}/v1/usage → usage.{rolling,weekly,monthly}. */
function collectOpencodeGo(raw, key, timeoutMs) {
  const base = trimSlash(stringOr(raw.baseUrl, DEFAULT_BASE_URL))
  return httpJson(`${base}/v1/usage`, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs).then((json) => {
    const u = json?.usage ?? json
    const windows = []
    for (const winKey of ['rolling', 'weekly', 'monthly']) {
      const w = u?.[winKey]
      if (!w || typeof w !== 'object') continue
      const pct = percentOf(w)
      if (pct === undefined) continue
      windows.push({ key: winKey, percent: pct, resetsAt: epochMs(w.resetsAt ?? w.resetAt) })
    }
    if (windows.length === 0) throw new Error('响应里没有可用的限额窗口')
    return { windows }
  })
}

/** Port of GLM's `findLimit`: match by type/name, then by unit, else fallback. */
function findLimit(limits, type, unit) {
  let fallback = null
  for (const item of limits) {
    if (item?.type !== type && item?.name !== type) continue
    if (unit === undefined) return item
    if (item.unit === unit) return item
    if (item.unit === undefined && fallback === null) fallback = item
  }
  return fallback
}

/** GLM Coding Plan quota: unit 3 → 5-hour, unit 6 → weekly, TIME_LIMIT → monthly. */
function collectZai(raw, key, timeoutMs) {
  const origin = originOf(raw.baseUrl)
    ?? (raw.id && /bigmodel|zhipu|智谱/i.test(String(raw.id)) ? 'https://open.bigmodel.cn' : 'https://api.z.ai')
  // China station authenticates with the RAW key; z.ai uses Bearer.
  const headers = origin.includes('bigmodel.cn')
    ? { Authorization: key, Accept: 'application/json' }
    : { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  return httpJson(`${origin}/api/monitor/usage/quota/limit`, headers, timeoutMs).then(async (quota) => {
    const container = quota?.data ?? quota
    const limits = Array.isArray(container) ? container : Array.isArray(container?.limits) ? container.limits : []
    const windows = []
    const push = (keyName, limit, fallbackReset) => {
      if (!limit) return
      const pct = percentOf(limit)
      if (pct === undefined) return
      windows.push({ key: keyName, percent: pct, resetsAt: epochMs(limit.nextResetTime) ?? fallbackReset })
    }
    push('rolling', findLimit(limits, 'TOKENS_LIMIT', 3) ?? findLimit(limits, 'CREDIT_LIMIT', 3))
    push('weekly', findLimit(limits, 'TOKENS_LIMIT', 6) ?? findLimit(limits, 'CREDIT_LIMIT', 6))
    push('monthly', findLimit(limits, 'TIME_LIMIT'), nextUtcFirstOfMonth())
    // Plan name is supplementary — a failure here must not drop usable quota.
    let plan
    try {
      const sub = await httpJson(`${origin}/api/biz/subscription/list`, headers, timeoutMs)
      plan = sub?.data?.[0]?.productName
    } catch {}
    if (windows.length === 0 && plan === undefined) {
      throw new Error('配额接口无数据（该 Key 可能不是 Coding Plan 订阅）')
    }
    return { windows, plan }
  })
}

/**
 * DeepSeek: prepaid balances (public API key) plus the last-30-days usage series
 * from the private platform export (needs `DEEPSEEK_USER_TOKEN`; an API key
 * cannot authenticate the dashboard endpoints).
 */
async function collectDeepseek(raw, key, timeoutMs, env = {}) {
  const origin = originOf(raw.baseUrl) ?? 'https://api.deepseek.com'
  const json = await httpJson(`${origin}/user/balance`, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs)
  const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
  const balances = []
  for (const info of infos) {
    const currency = stringOr(info?.currency, '')
    const push = (keyName, value) => {
      const v = Number.parseFloat(value)
      if (Number.isFinite(v)) balances.push({ key: keyName, value: v, currency })
    }
    push('available', info?.total_balance)
    push('granted', info?.granted_balance)
    push('toppedUp', info?.topped_up_balance)
  }
  if (balances.length === 0) throw new Error('余额数据为空')

  const out = { balances }
  if (!env.userToken) {
    out.hint = {
      title: '配置 DEEPSEEK_USER_TOKEN 解锁近 30 天用量曲线',
      steps: [
        '登录 platform.deepseek.com → F12 Console 执行 copy(JSON.parse(localStorage.getItem("userToken")).value)',
        '存入 credential DEEPSEEK_USER_TOKEN（JSON 包装整段粘贴也可以）',
      ],
    }
    return out
  }
  try {
    const series = await fetchDeepSeekSeries(env.userToken, timeoutMs, raw.seriesUrl)
    if (series.series.length > 0) {
      out.series = series.series
      out.granularity = series.granularity
      out.seriesTokens = series.tokens
      out.seriesCost = series.cost
      // Exact window (month) so the client's x-axis matches what was fetched.
      out.seriesFrom = series.from
      out.seriesTo = series.to
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Auth-shaped failures carry their own step-by-step hint; everything else
    // reports the message verbatim so nothing is silently swallowed.
    out.hint = error?.hint ?? {
      title: '用量曲线拉取失败',
      steps: [msg],
    }
  }
  return out
}

/** Moonshot / Kimi prepaid balance (USD). */
function collectMoonshot(raw, key, timeoutMs) {
  const origin = originOf(raw.baseUrl)
    ?? (/\.cn$|moonshot\.cn/i.test(String(raw.id ?? '')) ? 'https://api.moonshot.cn' : 'https://api.moonshot.ai')
  return httpJson(`${origin}/v1/users/me/balance`, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs).then((json) => {
    const d = json?.data ?? {}
    const balances = []
    const push = (keyName, value) => {
      if (typeof value === 'number' && Number.isFinite(value)) balances.push({ key: keyName, value, currency: 'USD' })
    }
    push('available', d.available_balance)
    push('voucher', d.voucher_balance)
    push('cash', d.cash_balance)
    if (balances.length === 0) throw new Error('余额数据为空')
    return { balances }
  })
}

/**
 * xAI Grok — Grok CLI billing API (reverse-engineered, undocumented):
 *   GET {base}/v1/billing  → config.{monthlyLimit,used}.val + billingPeriodEnd
 *   GET {base}/v1/settings → subscription_tier_display (plan label)
 * Auth: Bearer token + the `X-XAI-Token-Auth: xai-grok-cli` header. The token
 * comes from the credential, falling back to the Grok CLI's own login file
 * (`~/.grok/auth.json`) so `grok login` is enough — no key management.
 */
function grokTokenFromFile() {
  try {
    const raw = JSON.parse(readFileSync(joinPath(homedir(), '.grok', 'auth.json'), 'utf8'))
    const token = raw?.access_token ?? raw?.token ?? raw?.tokens?.access_token
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

function collectGrok(raw, key, timeoutMs) {
  const root = trimSlash(stringOr(raw.baseUrl, 'https://cli-chat-proxy.grok.com'))
  const api = /\/v1$/.test(root) ? root : `${root}/v1`
  const headers = {
    Authorization: `Bearer ${key}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    Accept: 'application/json',
  }
  return httpJson(`${api}/billing`, headers, timeoutMs).then(async (billing) => {
    const cfg = billing?.config ?? {}
    const limit = num(cfg.monthlyLimit?.val)
    const used = num(cfg.used?.val)
    const windows = []
    if (limit !== undefined && limit > 0 && used !== undefined) {
      windows.push({
        key: 'monthly',
        percent: clamp((used / limit) * 100, 0, 100),
        resetsAt: epochMs(cfg.billingPeriodEnd),
      })
    }
    let plan
    try {
      const settings = await httpJson(`${api}/settings`, headers, timeoutMs)
      plan = settings?.subscription_tier_display ?? settings?.subscriptionTierDisplay
    } catch {}
    if (windows.length === 0 && plan === undefined) {
      throw new Error('Grok billing 响应里没有月度额度')
    }
    return { windows, plan }
  })
}

/** Xiaomi MiMo — console API under `/api/v1`, authenticated by browser COOKIES. */
function mimoPeriodEnd(detail) {
  const s = detail?.data?.currentPeriodEnd
  if (typeof s !== 'string' || s.trim() === '') return undefined
  // The console renders `yyyy-MM-dd HH:mm:ss` in UTC; normalize to ISO+Z so
  // the countdown isn't shifted by the viewer's timezone.
  const iso = s.includes('T') ? s : `${s.trim().replace(' ', 'T')}Z`
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : undefined
}

function collectMimo(raw, key, timeoutMs) {
  const base = trimSlash(stringOr(raw.baseUrl, 'https://platform.xiaomimimo.com/api/v1'))
  const headers = { Cookie: key, Accept: 'application/json' }
  // A dead console session answers 302 to the login page — don't follow it.
  const opts = { redirect: 'manual' }
  return Promise.all([
    httpJson(`${base}/balance`, headers, timeoutMs, opts),
    httpJson(`${base}/tokenPlan/usage`, headers, timeoutMs, opts).catch(() => null),
    httpJson(`${base}/tokenPlan/detail`, headers, timeoutMs, opts).catch(() => null),
  ]).then(([balance, usage, detail]) => {
    if (balance && typeof balance.code === 'number' && balance.code !== 0) {
      throw new Error(`MiMo code ${balance.code}${balance.message ? `: ${balance.message}` : ''}`)
    }
    const d = balance?.data
    const currency = stringOr(d?.currency, 'CNY')
    const balances = []
    const push = (keyName, value) => {
      const n = Number.parseFloat(value)
      if (Number.isFinite(n)) balances.push({ key: keyName, value: n, currency })
    }
    push('available', d?.balance)
    push('cash', d?.cashBalance)
    push('gift', d?.giftBalance)

    const windows = []
    const item = usage && usage.code === 0 ? usage?.data?.monthUsage?.items?.[0] : undefined
    if (item) {
      const pct = percentOf(item) // { used, limit, percent }
      if (pct !== undefined) windows.push({ key: 'monthly', percent: pct, resetsAt: mimoPeriodEnd(detail) })
    }
    const plan = detail && detail.code === 0 ? detail?.data?.planCode : undefined

    if (balances.length === 0 && windows.length === 0) {
      throw new Error('MiMo 返回空数据（Cookie 可能已过期，请重抓 Cookie 头）')
    }
    return { windows, balances, plan }
  })
}

/** OpenRouter — prepaid credits (no window): `GET /api/v1/credits`. */
function collectOpenrouter(raw, key, timeoutMs) {
  const origin = originOf(raw.baseUrl) ?? 'https://openrouter.ai'
  return httpJson(`${origin}/api/v1/credits`, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs).then((json) => {
    const d = json?.data ?? {}
    const total = Number.parseFloat(d.total_credits)
    const used = Number.parseFloat(d.total_usage)
    const balances = []
    if (Number.isFinite(total) && Number.isFinite(used)) {
      balances.push({ key: 'available', value: total - used, currency: 'USD' })
      balances.push({ key: 'used', value: used, currency: 'USD' })
      balances.push({ key: 'total', value: total, currency: 'USD' })
    } else if (Number.isFinite(total)) {
      balances.push({ key: 'total', value: total, currency: 'USD' })
    }
    if (balances.length === 0) throw new Error('OpenRouter credits 响应为空')
    return { balances }
  })
}

/** SiliconFlow 硅基流动 — `GET /v1/user/info` returns string balances. */
function collectSiliconflow(raw, key, timeoutMs) {
  const origin = originOf(raw.baseUrl) ?? 'https://api.siliconflow.cn'
  return httpJson(`${origin}/v1/user/info`, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs).then((json) => {
    const d = json?.data ?? json
    const balances = []
    const push = (keyName, value, currency = 'CNY') => {
      const n = Number.parseFloat(value)
      if (Number.isFinite(n)) balances.push({ key: keyName, value: n, currency })
    }
    push('available', d?.totalBalance)
    push('charge', d?.chargeBalance)
    push('bonus', d?.balance)
    if (balances.length === 0) throw new Error('SiliconFlow 账户信息为空')
    return { balances }
  })
}

/**
 * Qwen / 阿里百炼 Token Plan — the OFFICIAL CLI is the only documented way to
 * read these quotas (no public HTTP usage endpoint; the console is manual):
 *
 *   npm install -g @qianwenai/qianwen-cli
 *   qianwen auth login --init-only --format json      (device-flow browser login)
 *   qianwen usage summary --period month --format json
 *
 * → coding_plan.windows.{per_5h, weekly, monthly} = { remaining, total, used_pct }
 *   pay_as_you_go.total = { cost, currency }          (this month's spend)
 *   plan = "PRO"                                      (seat tier)
 *
 * The CLI owns its own credentials, so no API key is required here.
 */
function runQianwenCli(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Windows resolves `.cmd` shims only through a shell; call cmd.exe
    // explicitly instead of `shell: true`, which concatenates unescaped args
    // and trips Node's deprecation warning. Our args are fixed literals.
    const windows = process.platform === 'win32'
    const file = windows ? (process.env.ComSpec || 'cmd.exe') : 'qianwen'
    const argv = windows ? ['/d', '/s', '/c', 'qianwen', ...args] : args
    execFile(file, argv, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        const text = `${stdout ?? ''}\n${stderr ?? ''}\n${error.message ?? ''}`
        if (/ENOENT|not recognized|不是内部或外部命令|cannot find/i.test(text)) {
          return reject(new HintError('未找到 qianwen CLI', {
            title: '请安装 qianwen CLI（千问官方命令行工具）',
            install: 'npm install -g @qianwenai/qianwen-cli',
            steps: [
              'qianwen auth login --init-only --format json   # 复制打印出的授权链接到浏览器打开',
              'qianwen auth login --complete --format json    # 完成登录（设备流）',
            ],
          }))
        }
        if (/not authenticated|unauthenticated|auth login|login required|未登录|credential/i.test(text)) {
          return reject(new HintError('qianwen CLI 未登录', {
            title: '请完成 qianwen CLI 登录',
            steps: [
              'qianwen auth login --init-only --format json   # 打开打印的授权链接',
              'qianwen auth login --complete --format json',
            ],
          }))
        }
        return reject(new Error(`qianwen CLI 执行失败：${String(error.message ?? '').slice(0, 200)}`))
      }
      try {
        resolve(JSON.parse(String(stdout ?? '')))
      } catch {
        reject(new Error('qianwen CLI 输出不是合法 JSON'))
      }
    })
  })
}

/** `qianwen usage summary --period month --format json`, normalized. */
function qwenCliSummary(timeoutMs) {
  return runQianwenCli(['usage', 'summary', '--period', 'month', '--format', 'json'], timeoutMs).then((json) => {
    const windows = []
    // CLI v1.9.0 emits `token_plan`; the older skill docs show `coding_plan`.
    // Accept both so neither payload shape loses its windows.
    const section = json?.token_plan ?? json?.coding_plan
    const win = section?.windows ?? {}
    const add = (keyName, obj, fallbackReset) => {
      if (!obj || typeof obj !== 'object') return
      const pct = num(obj.used_pct)
        ?? (num(obj.remaining) !== undefined && num(obj.total) !== undefined && obj.total > 0
          ? clamp((1 - obj.remaining / obj.total) * 100, 0, 100)
          : undefined)
      if (pct === undefined) return
      windows.push({
        key: keyName,
        percent: clamp(pct, 0, 100),
        resetsAt: epochMs(obj.resets_at ?? obj.reset_at) ?? fallbackReset,
      })
    }
    add('rolling', win.per_5h ?? win.fiveHour ?? win['5h'])
    add('weekly', win.weekly)
    // Seat quotas reset monthly on the 1st (documented behaviour); the 5-hour
    // and weekly anchors are account-specific, so those stay "unknown" rather
    // than being guessed — the client then omits the time bar for them.
    add('monthly', win.monthly, nextUtcFirstOfMonth())

    const balances = []
    const spend = json?.pay_as_you_go?.total
    const cost = num(spend?.cost)
    if (cost !== undefined) balances.push({ key: 'used', value: cost, currency: stringOr(spend?.currency, '') })

    const plan = typeof section?.plan === 'string' && section.plan ? section.plan : undefined
    const free = Array.isArray(json?.free_tier) ? json.free_tier.length : 0
    return { windows, balances, plan, free, subscribed: section?.subscribed }
  })
}

/**
 * 千问AI平台控制台 gateway (personal Token Plan) — the console's own XHRs:
 *
 *   POST {consoleUrl}&api=<zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/…>
 *   body: form-urlencoded { sfm_bailian, action, region, params }
 *   auth: the platform `Cookie` header (no sec_token needed — verified)
 *
 *   /subscription → { specCode: 'pro', endTime, remainingDays, status }
 *   /quota-config → { pro: { five_hour, monthly }, … }   (all tier caps)
 *   /usage        → { per1MonthPercentage, per1MonthResetTime }
 *
 * Three calls compose the real quota: tier cap × used percentage + reset.
 */
async function qwenConsolePost(consoleUrl, api, cookie, timeoutMs) {
  const params = JSON.stringify({
    Api: `${QWEN_API_PREFIX}${api}`,
    Data: { cornerstoneParam: QWEN_CORNERSTONE },
    V: '1.0',
  })
  const body = new URLSearchParams({
    sfm_bailian: '',
    action: 'BroadScopeAspnGateway',
    region: 'cn-beijing',
    params,
  })
  const url = `${consoleUrl}&api=${encodeURIComponent(`${QWEN_API_PREFIX}${api}`)}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json, text/plain, */*',
        origin: 'https://platform.qianwenai.com',
        referer: 'https://platform.qianwenai.com/home/analytics/token-plan/individual',
        cookie,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0 Safari/537.36',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const reason = /timeout|aborted|abort/i.test(msg) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${msg}`
    throw new Error(`${safeEndpoint(url)} — ${reason}`)
  }
  const json = await res.json().catch(() => null)
  if (!json) {
    throw new Error(`${safeEndpoint(url)} 返回非 JSON（HTTP ${res.status}；Cookie 多半已过期或账号被登出）`)
  }
  const inner = json?.data?.DataV2?.data
  if (inner?.code !== 'SUCCESS') {
    throw new Error(inner?.msg || json?.data?.errorMsg || `千问网关失败（HTTP ${res.status}）`)
  }
  return inner?.data?.data ?? inner?.data
}

async function qwenConsoleSummary(raw, timeoutMs, cookie) {
  if (!cookie) {
    return {
      hint: {
        title: '粘贴平台 Cookie 解锁个人版 Token Plan 额度',
        steps: [
          '浏览器登录 platform.qianwenai.com → F12 → Network → 任选一条 /data/api.json 请求 → 复制 Cookie 请求头',
          `整段存入 credential ${QWEN_CONSOLE_COOKIE}`,
          '之后卡片会显示真实月额度（如 180,000 Credits 已用百分比）与重置时间',
        ],
      },
    }
  }
  const consoleUrl = stringOr(raw?.consoleUrl, QWEN_CONSOLE_URL)
  const settled = await Promise.allSettled([
    qwenConsolePost(consoleUrl, 'subscription', cookie, timeoutMs),
    qwenConsolePost(consoleUrl, 'quota-config', cookie, timeoutMs),
    qwenConsolePost(consoleUrl, 'usage', cookie, timeoutMs),
  ])
  const [subR, cfgR, usageR] = settled
  if (usageR.status !== 'fulfilled') {
    const detail = usageR.reason instanceof Error ? usageR.reason.message : String(usageR.reason)
    return {
      hint: {
        title: '千问控制台额度接口查询失败',
        steps: [
          detail,
          `多数情况是 Cookie 过期：重新复制整段 Cookie 覆盖 credential ${QWEN_CONSOLE_COOKIE}`,
          '也可能是接口变更：把该提示和 F12 里的响应贴给插件维护者',
        ],
      },
    }
  }
  const used = num(usageR.value?.per1MonthPercentage)
  if (used === undefined) return {} // no personal plan visible on this account
  const windows = [{
    key: 'monthly',
    percent: clamp(used * 100, 0, 100),
    resetsAt: epochMs(usageR.value?.per1MonthResetTime),
  }]
  const tier = subR.status === 'fulfilled' ? stringOr(subR.value?.specCode, '') : ''
  if (tier && cfgR.status === 'fulfilled') {
    const cap = num(cfgR.value?.[tier]?.monthly)
    if (cap !== undefined && cap > 0) {
      windows[0].used = Math.round(used * cap)
      windows[0].total = cap
      windows[0].unit = 'Credits'
    }
  }
  return { windows, plan: tier ? `Token Plan ${tier}` : undefined }
}

/**
 * Qwen: console first (personal plans live there), CLI alongside (free tier,
 * pay-as-you-go spend, team plans). Each side is best-effort; the merge keeps
 * whichever windows actually exist and never drops a working source.
 */
async function collectQwen(raw, _key, timeoutMs, env = {}) {
  const [cliSettled, conSettled] = await Promise.allSettled([
    qwenCliSummary(timeoutMs),
    qwenConsoleSummary(raw, timeoutMs, env.cookie),
  ])
  const cli = cliSettled.status === 'fulfilled'
    ? cliSettled.value
    : { error: cliSettled.reason instanceof Error ? cliSettled.reason.message : String(cliSettled.reason), hint: cliSettled.reason?.hint }
  const con = conSettled.status === 'fulfilled' ? conSettled.value : {}

  const cliWindows = Array.isArray(cli?.windows) ? cli.windows : []
  const conWindows = Array.isArray(con?.windows) ? con.windows : []
  // The console is authoritative for the personal plan's monthly window; the
  // CLI contributes any 5h/weekly windows it can see (team plans).
  const windows = [
    ...cliWindows.filter((w) => w.key !== 'monthly'),
    ...(conWindows.find((w) => w.key === 'monthly')
      ? conWindows.filter((w) => w.key === 'monthly')
      : cliWindows.filter((w) => w.key === 'monthly')),
  ]

  const balances = Array.isArray(cli?.balances) ? cli.balances : []
  const plan = con.plan ?? cli.plan
  const free = cli.free ?? 0

  // Hints only matter while we have nothing to show — a cookie prompt over a
  // working quota row would just be noise. When BOTH setup paths are missing
  // (no console cookie AND no CLI), merge them so a 包月 user sees either route.
  let hint
  if (windows.length === 0) {
    const a = con.hint
    const b = cli.hint
    if (a && b) {
      hint = {
        title: a.title,
        install: a.install ?? b.install,
        steps: [...(a.steps ?? []), ...(b.steps ?? [])],
      }
    } else {
      hint = a ?? b
    }
  }

  if (windows.length === 0 && balances.length === 0 && plan === undefined && free === 0 && !hint) {
    throw new Error(
      cli.error
        ? `qianwen CLI 执行失败：${cli.error}`
        : 'qianwen 没返回 Token Plan 额度（确认已登录且订阅生效）',
    )
  }
  return { windows, balances, plan, hint }
}

/**
 * Command Code — `GET https://api.commandcode.ai/alpha/billing/credits`
 * → `windowLimits.{fiveHour, weekly, monthly} = { used, cap, resetAt }`.
 * Key: credential `COMMANDCODE_API_KEY`, falling back to the local CLI login
 * file `~/.commandcode/auth.json` (`user_*` token) — same pattern as Grok.
 */
function commandCodeTokenFromFile() {
  const scan = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return undefined
    for (const value of Object.values(node)) {
      if (typeof value === 'string' && value.startsWith('user_')) return value
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const hit = scan(value, depth + 1)
        if (hit) return hit
      }
    }
    return undefined
  }
  try {
    const raw = JSON.parse(readFileSync(joinPath(homedir(), '.commandcode', 'auth.json'), 'utf8'))
    return scan(raw, 0) ?? (typeof raw?.access_token === 'string' ? raw.access_token : undefined)
  } catch {
    return undefined
  }
}

/**
 * Zero-manual OpenCode key: the opencode CLI keeps its session in
 * `~/.opencode/auth.json`; scan it for an `oc_sk_…` key the same way the
 * Command Code fallback scans `user_*`. `home` is injectable for tests.
 * @param {string} [home]
 * @returns {string|undefined}
 */
function openCodeTokenFromFile(home = homedir()) {
  const scan = (node, depth) => {
    if (depth > 5) return undefined
    if (typeof node === 'string') return /^oc_sk_[A-Za-z0-9._-]+/.test(node) ? node : undefined
    if (!node || typeof node !== 'object') return undefined
    for (const value of Object.values(node)) {
      const hit = scan(value, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  try {
    const raw = JSON.parse(readFileSync(joinPath(home, '.opencode', 'auth.json'), 'utf8'))
    return scan(raw, 0)
  } catch {
    return undefined
  }
}

/**
 * Which credential refs a subscription actually consumes — the card renders a
 * save drawer for the ones that are missing. ONLY refs are listed; values are
 * never part of the payload.
 * @param {any} sub
 * @returns {string[]}
 */
function refsFor(sub) {
  const authNone = String(sub?.auth ?? 'bearer').toLowerCase() === 'none'
  const list = []
  const push = (ref) => {
    if (typeof ref === 'string' && ref && !list.includes(ref)) list.push(ref)
  }
  if (sub?.kind === 'qwen') {
    // The qianwen CLI carries its own login; only the console cookie is ours.
    push(QWEN_CONSOLE_COOKIE)
    return list
  }
  if (sub?.kind === 'deepseek') {
    push(sub?.apiKeyEnv)
    push(DEEPSEEK_USER_TOKEN) // optional: only unlocks the usage chart
    return list
  }
  if ((sub?.kind === 'custom' || sub?.kind === 'custom2') && authNone) return list
  push(sub?.apiKeyEnv)
  return list
}

async function collectCommandCode(raw, key, timeoutMs) {
  const root = trimSlash(stringOr(raw.baseUrl, 'https://api.commandcode.ai'))
  const json = await httpJson(`${root}/alpha/billing/credits`, {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  }, timeoutMs)
  const limits = json?.windowLimits
  if (!limits || typeof limits !== 'object') {
    throw new Error('Command Code 没返回 windowLimits（响应结构可能已变）')
  }
  const windows = []
  const add = (keyName, obj) => {
    if (!obj || typeof obj !== 'object') return
    const used = num(obj.used)
    const limit = num(obj.cap) ?? num(obj.limit) ?? num(obj.limit_amount)
    if (used === undefined || limit === undefined || limit <= 0) return
    windows.push({
      key: keyName,
      percent: clamp((used / limit) * 100, 0, 100),
      resetsAt: epochMs(obj.resetAt ?? obj.resets_at ?? obj.reset_at),
    })
  }
  add('rolling', limits.fiveHour)
  add('weekly', limits.weekly)
  add('monthly', limits.monthly)
  if (windows.length === 0) throw new Error('Command Code 的窗口额度里没有可用的 used/cap')
  const plan = typeof json?.plan === 'string' ? json.plan : undefined
  return { windows, plan }
}

// ── custom2: user-defined endpoint + field mapping ────────────────────────

/**
 * Dot-path JSON lookup with array indices: `data.usage.0.percent`,
 * `windowLimits.fiveHour.used`. Returns undefined when any hop is missing.
 */
function jsonPath(node, path) {
  if (typeof path !== 'string' || path === '') return undefined
  let cur = node
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = cur[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/** Coerce a mapped value to a number; accepts "7.38", 0.0738-style fractions. */
function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseFloat(value.replace(/[,\s]/g, ''))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * A fully user-defined quota source. The user maps their provider's JSON
 * response into the normalized row shape — no code change needed for any
 * vendor that answers with JSON over HTTP:
 *
 *   { id, label?, kind:'custom2', url, method?, headers?, body?, auth?,
 *     apiKeyEnv?, windows?: [{ key|label, percentPath?|usedPath?+totalPath?,
 *                              totalPath?, resetsAtPath? }],
 *     balances?: [{ label, path, currency? }] }
 *
 * Percent resolution order per window: `percentPath` (direct), else
 * used/total paths (absolute), else auto-fraction heuristic (≤1 → ×100).
 */
async function collectCustom2(raw, key, timeoutMs) {
  const url = stringOr(raw.url, '')
  if (!url) {
    throw new HintError('未配置用量接口 url', {
      title: '请为该订阅配置 url',
      steps: ['设置 → 插件 → 配置 → subscriptions', '给这条订阅填 url 与 windows 字段映射'],
    })
  }
  const method = stringOr(raw.method, 'GET').toUpperCase()
  const headers = { Accept: 'application/json', ...plainHeaders(raw.headers) }
  const auth = String(raw.auth ?? 'bearer').toLowerCase()
  if (key && auth === 'bearer') headers.Authorization = `Bearer ${key}`
  else if (key && auth === 'raw') headers.Authorization = key
  else if (key && auth === 'header') headers[stringOr(raw.headerName, 'X-Api-Key')] = key
  else if (key && auth === 'cookie') headers.Cookie = key

  let body
  if (raw.body !== undefined && raw.body !== null && typeof raw.body === 'object' && Object.keys(raw.body).length > 0) {
    body = JSON.stringify(raw.body)
    if (headers['content-type'] === undefined && headers['Content-Type'] === undefined) {
      headers['content-type'] = 'application/json'
    }
  }

  let res
  try {
    res = await fetch(url, {
      method: method === 'HEAD' ? 'GET' : method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const reason = /timeout|aborted|abort/i.test(msg) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${msg}`
    throw new Error(`${safeEndpoint(url)} — ${reason}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error(`${safeEndpoint(url)} 返回的不是 JSON（检查 url 是否是数据接口而非页面地址）`)
  }

  const windows = []
  const declared = Array.isArray(raw.windows) ? raw.windows : []
  for (const w of declared) {
    if (!w || typeof w !== 'object') continue
    const keyName = stringOr(w.key, '')
    const label = stringOr(w.label, '')
    let percent
    if (typeof w.percentPath === 'string' && w.percentPath) {
      percent = asNumber(jsonPath(json, w.percentPath))
    }
    const used = typeof w.usedPath === 'string' && w.usedPath ? asNumber(jsonPath(json, w.usedPath)) : undefined
    const total = typeof w.totalPath === 'string' && w.totalPath ? asNumber(jsonPath(json, w.totalPath)) : undefined
    if (percent === undefined && used !== undefined && total !== undefined && total > 0) {
      percent = (used / total) * 100
    }
    if (percent === undefined && used !== undefined && used <= 1 && used >= 0) {
      // fraction-shaped value (0–1): treat as percentage directly
      percent = used * 100
    }
    if (percent === undefined) continue
    const out = {
      key: keyName || label || `custom-${windows.length}`,
      label: label || undefined,
      percent: clamp(percent, 0, 100),
    }
    if (typeof w.resetsAtPath === 'string' && w.resetsAtPath) {
      const t = epochMs(jsonPath(json, w.resetsAtPath))
      if (t !== undefined) out.resetsAt = t
    }
    if (used !== undefined && total !== undefined) {
      out.used = Math.round(used)
      out.total = Math.round(total)
      out.unit = stringOr(w.unit, '') || undefined
    }
    windows.push(out)
  }

  const balances = []
  const balDeclared = Array.isArray(raw.balances) ? raw.balances : []
  for (const b of balDeclared) {
    if (!b || typeof b !== 'object' || typeof b.path !== 'string' || !b.path) continue
    const value = asNumber(jsonPath(json, b.path))
    if (value === undefined) continue
    balances.push({ key: stringOr(b.label, b.path), value, currency: stringOr(b.currency, '') })
  }

  const plan = typeof raw.planPath === 'string' && raw.planPath ? jsonPath(json, raw.planPath) : undefined

  if (windows.length === 0 && balances.length === 0) {
    throw new HintError('按当前映射没取到任何窗口或余额字段', {
      title: '字段映射可能不对',
      steps: [
        `先手动访问 ${safeEndpoint(url)} 看真实 JSON 结构`,
        '在 subscriptions 里核对 windows[].percentPath / usedPath+totalPath / resetsAtPath',
        '路径支持点号与数组下标，如 data.usage.0.percent',
      ],
    })
  }
  return {
    windows,
    balances,
    plan: typeof plan === 'string' && plan ? plan : undefined,
  }
}

/** Normalize a user-supplied header map to plain strings. */
function plainHeaders(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && k) out[k] = v
  }
  return out
}

/** Key aliases the generic collector scans for when reading arbitrary JSON. */
const WINDOW_ALIASES = {
  rolling: ['rolling', 'rollingusage', 'fivehour', 'five_hour', '5h', 'hourly', 'session', 'primary'],
  weekly: ['weekly', 'week', '7d', 'sevenday', 'seven_day', 'secondary'],
  monthly: ['monthly', 'month', '30d'],
}

function normKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Walk a few containers looking for an object that reports a percentage. */
function findWindow(root, aliases) {
  const seen = new Set()
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return undefined
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const name = normKey(item?.type ?? item?.name ?? item?.kind ?? item?.label)
        if (name && aliases.some((a) => name.includes(normKey(a)))) {
          const pct = percentOf(item)
          if (pct !== undefined) return { percent: pct, resetsAt: epochMs(item.resetsAt ?? item.resetAt ?? item.nextResetTime) }
        }
      }
      for (const item of node) {
        const hit = visit(item, depth + 1)
        if (hit) return hit
      }
      return undefined
    }
    for (const alias of aliases) {
      if (alias in node) {
        const pct = percentOf(node[alias])
        if (pct !== undefined) {
          const value = node[alias]
          return { percent: pct, resetsAt: epochMs(value?.resetsAt ?? node.resetsAt) }
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const hit = visit(value, depth + 1)
        if (hit) return hit
      }
    }
    return undefined
  }
  return visit(root, 0)
}

/** Generic collector: any JSON endpoint, windows auto-detected by key name. */
function collectCustom(raw, key, timeoutMs) {
  const url = stringOr(raw.url, '')
  if (!url) {
    return Promise.reject(new HintError('未配置用量接口 url', {
      title: '请为该订阅配置用量接口',
      steps: [
        '设置 → 插件 → dsh-quota-hud → 配置 → subscriptions',
        '给这条订阅填 url（以及 auth：bearer / raw / header / none）',
      ],
    }))
  }
  const headers = { Accept: 'application/json' }
  const auth = String(raw.auth ?? 'bearer').toLowerCase()
  if (key && auth === 'bearer') headers.Authorization = `Bearer ${key}`
  else if (key && auth === 'raw') headers.Authorization = key
  else if (key && auth === 'header') headers[stringOr(raw.headerName, 'X-Api-Key')] = key
  else if (key && auth === 'cookie') headers.Cookie = key // console sessions (qianwenai, MiMo, …)
  return httpJson(url, headers, timeoutMs).then((json) => {
    const windows = []
    for (const [winKey, aliases] of Object.entries(WINDOW_ALIASES)) {
      const hit = findWindow(json, aliases)
      if (hit) windows.push({ key: winKey, percent: hit.percent, resetsAt: hit.resetsAt })
    }
    if (windows.length === 0) {
      throw new Error('响应里没识别出限额窗口（把字段名告诉我，我加进别名表）')
    }
    return { windows }
  })
}

const COLLECTORS = {
  'opencode-go': collectOpencodeGo,
  zai: collectZai,
  deepseek: collectDeepseek,
  moonshot: collectMoonshot,
  grok: collectGrok,
  mimo: collectMimo,
  openrouter: collectOpenrouter,
  siliconflow: collectSiliconflow,
  qwen: collectQwen,
  commandcode: collectCommandCode,
  custom: collectCustom,
  custom2: collectCustom2,
}

// ── panel mount ───────────────────────────────────────────────────────────

/**
 * Mount the panel. The shell owns the dock cell, the placement and the timers;
 * this only registers the routes and returns the test handles.
 * @param {import('../../lib/host-kit.js').PanelHost} host
 */
export function mount(host) {
  const ctx = host.ctx

  const readConfig = () => {
    const own = unwrap(host.config())
    const subs = unwrap(own?.subscriptions)
    return {
      apiKeyEnv: stringOr(unwrap(own?.apiKeyEnv), DEFAULT_API_KEY_ENV),
      baseUrl: stringOr(unwrap(own?.baseUrl), DEFAULT_BASE_URL),
      providerPrefix: stringOr(unwrap(own?.providerPrefix), DEFAULT_PROVIDER_PREFIX).toLowerCase(),
      subscriptions: Array.isArray(subs) ? subs.map((s) => unwrap(s)).filter((s) => s && typeof s === 'object') : [],
      cacheMs: clamp(numberOr(unwrap(own?.cacheMs), DEFAULT_CACHE_MS), MIN_CACHE_MS, 3_600_000),
      timeoutMs: clamp(numberOr(unwrap(own?.timeoutMs), DEFAULT_TIMEOUT_MS), MIN_TIMEOUT_MS, 60_000),
      pollMs: clamp(numberOr(unwrap(own?.pollMs), DEFAULT_POLL_MS), MIN_POLL_MS, MAX_POLL_MS),
    }
  }

  /**
   * Every subscription to poll:
   *  - explicitly configured entries (always included, may override by id);
   *  - `llm-pi-ai` providers whose id infers a known kind;
   *  - providers matching `providerPrefix` when no kind was inferred.
   */
  const subscriptions = async () => {
    const cfg = readConfig()
    const out = new Map()

    for (const [id, raw] of Object.entries(piAiProviders(ctx))) {
      const p = unwrap(raw)
      const providerBase = stringOr(unwrap(p?.baseURL), '')
      const apiKeyEnv = stringOr(unwrap(p?.apiKeyEnv), cfg.apiKeyEnv)
      const kind = inferKind(id)
      const prefixMatched = cfg.providerPrefix !== '' && id.toLowerCase().startsWith(cfg.providerPrefix)
      if (kind === null && !prefixMatched) continue
      out.set(id, {
        id,
        label: id,
        kind: kind ?? 'custom',
        apiKeyEnv,
        baseUrl: providerBase || cfg.baseUrl,
        url: '',
        auth: 'bearer',
        headerName: '',
        seriesUrl: stringOr(unwrap(p?.seriesUrl), ''),
        consoleUrl: stringOr(unwrap(p?.consoleUrl), ''),
      })
    }

    // The built-in DeepSeek provider lives in its own plugin and never shows
    // up in the llm-pi-ai table: probe it explicitly so selecting the official
    // DeepSeek source switches the card to DeepSeek instead of falling back to
    // another vendor. Its live config carries `baseURL` + `apiKeyEnv`. When the
    // entry cannot be addressed at all (different bundle, plugin disabled),
    // fall back to a credential check so the row still exists — an honest
    // "configure DEEPSEEK_API_KEY" hint beats a silently missing subscription.
    const officialCfg = loaderEntryConfig(ctx, DEEPSEEK_OFFICIAL_SOURCES)
    if (!out.has('deepseek-official')) {
      const officialEnv = stringOr(unwrap(officialCfg?.apiKeyEnv), 'DEEPSEEK_API_KEY')
      let usable = officialCfg !== undefined && officialCfg !== null
      if (!usable) {
        try {
          usable = Boolean((await ctx.credentials.resolve(officialEnv))?.value)
        } catch {
          usable = false
        }
      }
      if (usable) {
        const officialBase = stringOr(unwrap(officialCfg?.baseURL), 'https://api.deepseek.com')
        out.set('deepseek-official', {
          id: 'deepseek-official',
          label: 'deepseek-official',
          kind: 'deepseek',
          apiKeyEnv: officialEnv,
          baseUrl: originOf(officialBase) ?? 'https://api.deepseek.com',
          url: '',
          auth: 'bearer',
          headerName: '',
          seriesUrl: '',
        })
      }
    }

    for (const entry of cfg.subscriptions) {
      const id = stringOr(entry?.id, '')
      if (!id) continue
      const kind = KINDS.includes(String(entry?.kind)) && entry.kind !== 'auto' ? String(entry.kind) : 'custom'
      out.set(id, {
        id,
        label: stringOr(entry?.label, id),
        kind,
        apiKeyEnv: stringOr(entry?.apiKeyEnv, cfg.apiKeyEnv),
        baseUrl: stringOr(entry?.baseUrl, cfg.baseUrl),
        url: stringOr(entry?.url, ''),
        auth: stringOr(entry?.auth, 'bearer'),
        headerName: stringOr(entry?.headerName, ''),
        seriesUrl: stringOr(entry?.seriesUrl, ''),
        consoleUrl: stringOr(entry?.consoleUrl, ''),
        // custom2 field mapping (user-defined endpoint):
        method: stringOr(entry?.method, 'GET'),
        headers: deepUnwrapObject(entry?.headers),
        body: deepUnwrapObject(entry?.body),
        windows: deepUnwrapArray(entry?.windows),
        balances: deepUnwrapArray(entry?.balances),
        planPath: stringOr(entry?.planPath, ''),
      })
    }

    if (out.size === 0) {
      out.set(cfg.apiKeyEnv, {
        id: cfg.apiKeyEnv,
        label: 'opencode-go',
        kind: 'opencode-go',
        apiKeyEnv: cfg.apiKeyEnv,
        baseUrl: cfg.baseUrl,
        url: '',
        auth: 'bearer',
        headerName: '',
      })
    }

    for (const sub of out.values()) {
      if (sub.kind === 'opencode-go') {
        // The gateway root is what the usage path wants; a chat base URL only
        // counts when it actually points at the GO gateway.
        sub.baseUrl = originOf(sub.baseUrl) && sub.baseUrl.includes('/zen/go') ? trimSlash(sub.baseUrl) : cfg.baseUrl
      }
    }
    return [...out.values()]
  }

  /** Per-subscription upstream cache so several tabs never hammer gateways. */
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const cache = new Map()

  const runCollector = async (sub) => {
    const cfg = readConfig()
    let key
    try {
      const hit = await ctx.credentials.resolve(sub.apiKeyEnv)
      key = hit?.value
    } catch (error) {
      // A broken/absent credentials store must name itself instead of
      // surfacing a raw loader exception.
      throw new HintError(`读取 credential ${sub.apiKeyEnv} 失败`, {
        title: '凭据读取失败',
        steps: [
          error instanceof Error ? error.message : String(error),
          `确认 ~/.dsh/.credentials.yaml 里存在 ${sub.apiKeyEnv} 且缩进/引号正确`,
        ],
      })
    }
    // Local CLI logins we can read instead of a managed credential.
    if (!key && sub.kind === 'grok') key = grokTokenFromFile()
    if (!key && sub.kind === 'commandcode') key = commandCodeTokenFromFile()
    // opencode CLI session → zero-manual OpenCode key.
    if (!key && sub.kind === 'opencode-go') key = openCodeTokenFromFile()

    if (!key && sub.kind === 'grok') {
      throw new HintError('Grok 未登录', {
        title: '请安装并登录 Grok CLI',
        steps: ['grok login（token 会写入 ~/.grok/auth.json）', '或把 token 存进 credential GROK_KEY'],
      })
    }
    if (!key && sub.kind === 'commandcode') {
      throw new HintError('缺少 Command Code 凭据', {
        title: '请提供 Command Code API Key',
        steps: [
          '登录 Command Code 后，复制 ~/.commandcode/auth.json 里 user_ 开头的 key',
          `存入 credential ${sub.apiKeyEnv || 'COMMANDCODE_API_KEY'}`,
        ],
      })
    }
    if (!key && sub.kind === 'mimo') {
      throw new HintError('未配置 MiMo Cookie', {
        title: '请粘贴 MiMo 浏览器 Cookie',
        steps: [
          '登录 platform.xiaomimimo.com → 开发者工具 → Network → 复制 Cookie 请求头',
          `整段存入 credential ${sub.apiKeyEnv}`,
        ],
      })
    }
    // Endpoints that need NO credential: the qianwen CLI carries its own
    // login, and `auth: 'none'` user-defined endpoints are public JSON —
    // failing those over a missing apiKeyEnv would be a false alarm.
    const authNone = String(sub.auth ?? 'bearer').toLowerCase() === 'none'
    const needsKey = !(sub.kind === 'qwen'
      || ((sub.kind === 'custom' || sub.kind === 'custom2') && authNone))
    if (!key && needsKey) {
      throw new HintError(`未配置 API Key（credential ${sub.apiKeyEnv}）`, {
        title: `请配置 credential ${sub.apiKeyEnv}`,
        steps: ['在 ~/.dsh/.credentials.yaml 里加一行：', `${sub.apiKeyEnv}: <你的 key>`],
      })
    }

    // Secondary credentials are OPTIONAL: absent must degrade to "no chart /
    // no console query", never crash the row. On some builds resolve() answers
    // `undefined` instead of `{value: undefined}` when the ref is missing —
    // an unguarded `.value` there surfaced as
    // `Cannot read properties of undefined (reading 'value')`.
    const optionalValue = async (ref) => {
      try {
        return (await ctx.credentials.resolve(ref))?.value
      } catch {
        return undefined
      }
    }
    const env = {}
    if (sub.kind === 'deepseek') {
      // Users paste the raw localStorage output, which is a JSON wrapper —
      // unwrapUserToken accepts both that and the bare token.
      env.userToken = unwrapUserToken(await optionalValue(DEEPSEEK_USER_TOKEN))
    }
    if (sub.kind === 'qwen') {
      // Platform cookie unlocks the personal Token Plan console endpoints.
      env.cookie = await optionalValue(QWEN_CONSOLE_COOKIE)
    }
    const collect = COLLECTORS[sub.kind] ?? COLLECTORS.custom
    return await collect(sub, key, cfg.timeoutMs, env)
  }

  const usageOnce = (sub, force) => {
    const now = Date.now()
    const cfg = readConfig()
    const entry = cache.get(sub.id)
    if (!force && entry !== undefined && now - entry.at < cfg.cacheMs) return entry.promise
    const promise = runCollector(sub).catch((error) => {
      if (cache.get(sub.id)?.promise === promise) cache.delete(sub.id)
      throw error
    })
    cache.set(sub.id, { at: now, promise })
    return promise
  }

  /** Query every subscription in parallel; failures are reported per row. */
  const snapshot = async (force) =>
    Promise.all(
      (await subscriptions()).map(async (sub) => {
        // Drawer status rides along with the row (refs only, never values).
        const credentials = await credentialStatus(sub)
        const withCreds = { ...(credentials.length > 0 ? { credentials } : {}) }
        try {
          const result = await usageOnce(sub, force)
          const hasSeries = Array.isArray(result?.series) && result.series.length > 0
          return {
            id: sub.id,
            label: sub.label,
            kind: sub.kind,
            apiKeyEnv: sub.apiKeyEnv,
            ...withCreds,
            windows: Array.isArray(result?.windows) ? result.windows : [],
            balances: Array.isArray(result?.balances) ? result.balances : [],
            ...(result?.plan ? { plan: result.plan } : {}),
            ...(result?.hint ? { hint: result.hint } : {}),
            // Usage series (DeepSeek, last 30 days) — the client draws it as a
            // chart. `seriesFrom`/`seriesTo` ship the host's exact window so
            // the x-axis never disagrees with what was actually fetched.
            ...(hasSeries
              ? {
                  series: result.series,
                  granularity: result.granularity,
                  seriesTokens: result.seriesTokens,
                  seriesCost: result.seriesCost,
                  seriesFrom: result.seriesFrom,
                  seriesTo: result.seriesTo,
                }
              : {}),
          }
        } catch (error) {
          return {
            id: sub.id,
            label: sub.label,
            kind: sub.kind,
            apiKeyEnv: sub.apiKeyEnv,
            ...withCreds,
            windows: [],
            balances: [],
            error: error instanceof Error ? error.message : String(error),
            ...(error?.hint ? { hint: error.hint } : {}),
          }
        }
      }),
    )

  const payload = (rows) => {
    const cfg = readConfig()
    const firstWindows = rows.find((r) => r.windows?.length > 0)
    return {
      ok: true,
      version: CURRENT_VERSION,
      kind: 'normalized',
      fetchedAt: Date.now(),
      pollMs: cfg.pollMs,
      // Back-compat: first windowed subscription in the legacy `usage` shape.
      usage: firstWindows
        ? Object.fromEntries(firstWindows.windows.map((w) => [w.key, { status: 'ok', percent: w.percent, resetsAt: w.resetsAt }]))
        : null,
      subscriptions: rows,
    }
  }

  /**
   * Presence flags for the card's save drawer — refs only, NEVER values.
   * Resolved per snapshot (a local file read), in parallel across refs.
   */
  const credentialStatus = async (sub) => {
    const refs = refsFor(sub)
    if (refs.length === 0) return []
    return Promise.all(refs.map(async (ref) => {
      // host.credential.present() is safe (never throws) and returns presence
      // only — the value itself never crosses this boundary.
      const present = await host.credential.present(ref)
      return { ref, present }
    }))
  }

  // Credential writes go through the kit: it prefers the credentials service
  // (cross-process writer lock + hot reload) and falls back to patching
  // `$DSH_HOME/.credentials.yaml` atomically, which the watcher hot-publishes.
  // See `writeCredential` in lib/host-kit.js.

  const handleCredential = async (req, res) => {
    if (req.method !== 'POST') {
      return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    if (!host.sameOrigin(req)) {
      return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    }
    const raw = await host.readBody(req)
    let parsed
    try {
      parsed = JSON.parse(raw || '{}')
    } catch {
      return host.json(res, 400, { ok: false, error: 'bad-json' })
    }
    const ref = typeof parsed?.ref === 'string' ? parsed.ref : ''
    const value = typeof parsed?.value === 'string' ? parsed.value.trim() : ''
    if (!/^[A-Za-z0-9_]{1,64}$/.test(ref)) {
      return host.json(res, 400, { ok: false, error: 'bad-ref' })
    }
    if (!value || value.length > 16384) {
      return host.json(res, 400, { ok: false, error: 'bad-value' })
    }
    try {
      // The kit owns the writer: it prefers the credentials service and falls
      // back to patching `$DSH_HOME/.credentials.yaml` atomically.
      const how = await host.credential.write(ref, value)
      // Never echo the secret back — only where it landed.
      return host.json(res, 200, { ok: true, ref, how })
    } catch (error) {
      return host.json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleUsage = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    // HEAD must answer without a body — and without doing the work.
    if (req.method === 'HEAD') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    try {
      host.json(res, 200, payload(await snapshot(false)))
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRefresh = async (req, res) => {
    if (req.method !== 'POST') {
      return host.json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    // Drain any request body so the socket is not left half-read.
    try {
      req.resume?.()
    } catch { /* no body to drain */ }
    // Same-origin only: a foreign page must not be able to drive our upstream
    // queries (this endpoint forces real network/CLI work for every row).
    if (!host.sameOrigin(req)) {
      return host.json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
    }
    try {
      host.json(res, 200, payload(await snapshot(true)))
    } catch (error) {
      host.json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Routes live under `/dsh-hud/quota/<action>` — the kit adds the prefix and
  // owns the `kind: 'exact'` registration (see panelHost.route in the kit).
  ctx.effect(() => {
    const disposeUsage = host.route('usage', handleUsage)
    const disposeRefresh = host.route('refresh', handleRefresh)
    // Save drawer: writes a credential (same-origin only) and never echoes it.
    const disposeCredential = host.route('credential', handleCredential)
    return () => {
      disposeUsage()
      disposeRefresh()
      disposeCredential()
    }
  }, 'dsh-hud/quota: routes')

  // Inspection handle: lets tests assert DISCOVERY (which rows exist, and why)
  // without triggering a single network call — plus the drawer's plumbing
  // (the writer is the kit's, so panels and shell can never disagree on it).
  return {
    subscriptions: () => subscriptions(),
    credentialStatus,
    writeCredential: (ref, value) => host.credential.write(ref, value),
  }
}
