// @ts-check
/**
 * dsh-hud › todo panel — host half.
 *
 * A待办 list that lives in the HUD's title bar: your own items, plus whatever a
 * calendar feed hands over, grouped by when they are due, with the digest the
 * end of the day needs.
 *
 * ── what it integrates with, and what it does NOT ──────────────────────────
 *
 *   ✅ 自己设置         full CRUD, stored in this plugin's own storage domain
 *   ✅ 日历订阅 (ICS)    one or more `.ics` / webcal URLs, read-only
 *   ❌ 飞书 / 钉钉 待办 API
 *   ❌ 邮箱 IMAP
 *
 * The two refusals are deliberate and are not "not yet":
 *
 *   - **Feishu Task / DingTalk TODO APIs need an enterprise app** (app id +
 *     secret), a **user OAuth grant**, and in most tenants an admin who
 *     approves the scopes. There is no keyless path, so shipping a button that
 *     pretends to sync would be a lie with extra steps.
 *   - **IMAP** needs mail credentials plus a hand-written IMAP + MIME stack, and
 *     then has to guess which messages are actionable. Guessing is the part that
 *     makes it not worth building.
 *
 * What DOES cover the intent: both Feishu (日历 → 订阅/共享) and DingTalk
 * (日程 → 导出/订阅), plus Outlook, Google Calendar and every Chinese mail
 * provider, publish an **ICS subscription URL**. Paste it in and the events land
 * in this list. The URL itself is the credential, so nothing else is needed.
 *
 * ── how ICS is parsed ──────────────────────────────────────────────────────
 *
 * Hand-written, because the format is small and a dependency would be larger
 * than the parser. It handles the parts that real feeds actually use:
 *
 *   - line folding (RFC 5545 §3.1: a leading space/TAB continues the last line)
 *   - `DTSTART`/`DTEND` as `VALUE=DATE` (all-day), `...Z` (UTC), or `TZID=…`
 *   - `VEVENT` and `VTODO`
 *   - `RRULE` limited to what a reminder feed needs: `FREQ=DAILY|WEEKLY|MONTHLY`
 *     with `INTERVAL`, `COUNT`, `UNTIL` and (for weekly) `BYDAY`
 *
 * Anything outside that subset is **reported, not silently dropped**: an event
 * whose rule cannot be expanded comes back as a single occurrence with
 * `approx: true`, and the feed reports `unsupported` so the card can say so.
 *
 * ── the notification schedule ─────────────────────────────────────────────
 *
 * The host does not notify (it has no clock the user can hear). It publishes the
 * SCHEDULE and the payload — `leads: [60, 30, 5]` minutes before `dueAt`, plus a
 * daily `digestAt` (default 16:30) listing tomorrow's items — and the browser
 * half fires them, deduped per `(id, lead)`. Same split as every other panel
 * here: host owns data, browser owns the user's moment.
 */

import { live } from '../../lib/host-kit.js'
import { ImapError, fetchRecentHeaders } from '../../lib/imap.js'

export const id = 'todo'
export const order = 20
export const label = { zh: '待办', en: 'To-do' }
export const span = 1
/**
 * Off by default, like the other cards that need setup: the title-bar entry is
 * always there and carries the count, so the feature is one click away without
 * spending one of the three columns on a fresh install.
 */
export const defaultOn = false
export const storageDomain = 'dsh-hud/todo'
export const refreshMs = 300_000

/** Notification leads, in minutes before `dueAt`. */
const DEFAULT_LEADS = [60, 30, 5]
/** The end-of-day digest, in local time. 16:30 is the ask. */
const DEFAULT_DIGEST_AT = '16:30'
/** How far ahead a feed's events are materialized. */
const HORIZON_DAYS = 90
/** A feed is refetched at most this often, however often the card polls. */
const FEED_CACHE_MS = 15 * 60_000
const FEED_TIMEOUT_MS = 15_000
const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 500

/**
 * ── 番茄钟（pomodoro）──────────────────────────────────────────────────────
 *
 * A focus timer that lives on the todo card, because that is where the thing you
 * are supposed to be working on already is.
 *
 * ── why the HOST owns the clock ────────────────────────────────────────────
 *
 * The countdown is derived from two TIMESTAMPS, never from a decrementing
 * counter: `startedAt` / `endsAt`, plus `remainingMs` while paused. So a page
 * refresh, a hidden card, a sleeping laptop or a restarted Harness all resume the
 * same session instead of losing it — and two open tabs show the same second
 * rather than two different ones.
 *
 * The browser still does the ticking (it has the frame loop), but it only ever
 * RENDERS `endsAt - now`; it never owns the elapsed time.
 *
 * ── the transition is LAZY, and that is on purpose ─────────────────────────
 *
 * Nothing runs while nobody is looking, so a session that ended overnight is
 * settled on the next read — as ONE transition, not as the eleven that would have
 * happened. A pomodoro cannot honestly count sessions nobody was present for, and
 * inventing them would be the kind of number this project refuses to print.
 */
const POMODORO_DEFAULTS = { workMinutes: 25, breakMinutes: 5, longBreakEvery: 4, longBreakMinutes: 15 }
const POMODORO_LIMITS = { workMinutes: [1, 180], breakMinutes: [1, 60], longBreakEvery: [2, 12], longBreakMinutes: [1, 120] }

/** A finite integer inside `[min, max]`, or the fallback. */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** The stored pomodoro block, cleaned: every field is validated on the way out. */
function readPomodoro(host) {
  const stored = host.storage.read()
  const raw = stored?.pomodoro && typeof stored.pomodoro === 'object' ? stored.pomodoro : {}
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  return {
    settings: {
      workMinutes: clampInt(settings.workMinutes, ...POMODORO_LIMITS.workMinutes, POMODORO_DEFAULTS.workMinutes),
      breakMinutes: clampInt(settings.breakMinutes, ...POMODORO_LIMITS.breakMinutes, POMODORO_DEFAULTS.breakMinutes),
      longBreakEvery: clampInt(settings.longBreakEvery, ...POMODORO_LIMITS.longBreakEvery, POMODORO_DEFAULTS.longBreakEvery),
      longBreakMinutes: clampInt(settings.longBreakMinutes, ...POMODORO_LIMITS.longBreakMinutes, POMODORO_DEFAULTS.longBreakMinutes),
    },
    phase: raw.phase === 'break' ? 'break' : 'work',
    running: raw.running === true,
    // `endsAt` is the only thing that decides how much time is left while running.
    endsAt: Number.isFinite(Number(raw.endsAt)) && Number(raw.endsAt) > 0 ? Number(raw.endsAt) : undefined,
    remainingMs: Number.isFinite(Number(raw.remainingMs)) && Number(raw.remainingMs) >= 0 ? Number(raw.remainingMs) : undefined,
    completedToday: clampInt(raw.completedToday, 0, 100, 0),
    dayKey: typeof raw.dayKey === 'string' ? raw.dayKey : '',
    /** Bumped on every transition, so a card can tell "new session" from "same one". */
    cycleId: clampInt(raw.cycleId, 0, Number.MAX_SAFE_INTEGER, 0),
    /** What the session is FOR, if the user picked an item. */
    label: typeof raw.label === 'string' ? raw.label.slice(0, 80) : '',
    lastEndedAt: Number.isFinite(Number(raw.lastEndedAt)) ? Number(raw.lastEndedAt) : undefined,
  }
}

/** Local `YYYY-MM-DD`, so "today's count" follows the user's midnight, not UTC's. */
function pomodoroDayKey(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The length of the phase that is about to start, in ms. */
function phaseLength(state, phase) {
  const { settings } = state
  if (phase === 'work') return settings.workMinutes * 60_000
  // Every Nth break is the long one. `completedToday` counts FINISHED work
  // sessions, so the 4th break follows the 4th session.
  const long = settings.longBreakEvery > 0 && state.completedToday > 0 && state.completedToday % settings.longBreakEvery === 0
  return (long ? settings.longBreakMinutes : settings.breakMinutes) * 60_000
}

/**
 * Settle a state against the clock — PURE, returns `[next, ended]`.
 *
 * `ended` is `undefined` when nothing happened, otherwise it describes the session
 * that has just finished, which is what the card turns into a notification.
 */
function settlePomodoro(state, now) {
  let next = state
  let ended
  // Midnight resets the count, so "today" keeps meaning today.
  const dayKey = pomodoroDayKey(now)
  if (state.dayKey !== dayKey) next = { ...next, dayKey, completedToday: 0 }
  if (!next.running || next.endsAt === undefined) return [next, ended]
  if (next.endsAt > now) return [next, ended]
  // Exactly ONE transition, however long it has been.
  const finishedWork = next.phase === 'work'
  const completedToday = finishedWork ? next.completedToday + 1 : next.completedToday
  const phase = finishedWork ? 'break' : 'work'
  const withCount = { ...next, completedToday, phase }
  ended = {
    phase: next.phase,
    at: next.endsAt,
    lateByMs: Math.max(0, now - next.endsAt),
    completedToday,
    // The break that follows a work session, so the notification can say which.
    nextPhase: phase,
    nextMs: phaseLength(withCount, phase),
  }
  next = {
    ...withCount,
    running: true,
    // The next phase starts at `now`, not at the moment the previous one ended:
    // the user is looking at it NOW, so a break should last its full length.
    endsAt: now + ended.nextMs,
    remainingMs: undefined,
    cycleId: next.cycleId + 1,
    lastEndedAt: now,
  }
  return [next, ended]
}

/** The read-only view the card renders. Never mutates. */
function pomodoroView(state, now) {
  const running = state.running && state.endsAt !== undefined
  const remainingMs = running
    ? Math.max(0, state.endsAt - now)
    : (state.remainingMs ?? phaseLength(state, state.phase))
  return {
    phase: state.phase,
    running,
    remainingMs,
    endsAt: running ? state.endsAt : undefined,
    totalMs: phaseLength(state, state.phase),
    // A phase is "started" when it has an end or has been paused part-way; a
    // freshly loaded card shows a full timer waiting to be started.
    started: running || state.remainingMs !== undefined,
    completedToday: state.completedToday,
    cycleId: state.cycleId,
    label: state.label,
    settings: state.settings,
    lastEndedAt: state.lastEndedAt,
  }
}

/**
 * Apply one action — PURE, returns the next state.
 *
 * `now` is a parameter so the transitions are testable without waiting a second.
 */
function applyPomodoroAction(state, action, now) {
  switch (action) {
    case 'start':
      return {
        ...state,
        // A fresh start always begins with a work session: the point of the timer
        // is the work, and starting on a break is not a thing anyone means.
        phase: 'work',
        running: true,
        endsAt: now + phaseLength({ ...state, phase: 'work' }, 'work'),
        remainingMs: undefined,
      }
    case 'pause': {
      if (!state.running || state.endsAt === undefined) return state
      return { ...state, running: false, remainingMs: Math.max(0, state.endsAt - now), endsAt: undefined }
    }
    case 'resume': {
      if (state.running) return state
      const remaining = state.remainingMs ?? phaseLength(state, state.phase)
      if (remaining <= 0) return state
      return { ...state, running: true, endsAt: now + remaining, remainingMs: undefined }
    }
    case 'skip': {
      // Skipping moves to the next phase WITHOUT credit: the session was not done.
      const phase = state.phase === 'work' ? 'break' : 'work'
      const next = { ...state, phase, cycleId: state.cycleId + 1 }
      const length = phaseLength(next, phase)
      return state.running
        ? { ...next, endsAt: now + length, remainingMs: undefined, lastEndedAt: now }
        : { ...next, remainingMs: length, endsAt: undefined }
    }
    case 'reset':
      // Back to a full work session, waiting to be started. The day's count is
      // kept: it is a record of what happened, not part of the timer.
      return {
        ...state,
        phase: 'work',
        running: false,
        endsAt: undefined,
        remainingMs: undefined,
        cycleId: state.cycleId + 1,
      }
    default:
      return state
  }
}

/**
 * ── credentials that come from a LOGIN ─────────────────────────────────────
 *
 * Nothing here is an API key handed out by a dashboard. Both credential paths
 * are things the user already has, because they already log in with them:
 *
 *   邮箱    IMAP + **授权码** (an app password from the mail settings). Works on
 *           163 / 126 / QQ / 阿里 / 腾讯企业邮 today. No application
 *           registration, no administrator, no review.
 *   飞书/钉钉 OAuth: the user authorises THIS plugin's own app once, and the
 *           token is kept and refreshed. See `loginProviders` below — the app
 *           has to exist in the vendor's console first, and that is not
 *           something a plugin can do for you.
 *
 * Both live in `$DSH_HOME/.credentials.yaml` through the kit's credential store,
 * NEVER in the panel's state file: a mailbox 授权码 in a JSON blob that the card
 * reads back over HTTP would be a real leak, and the state route is same-origin
 * but not encrypted.
 */
const MAIL_SECRET_REF = 'DSH_HUD_TODO_MAIL'
const OAUTH_SECRET_REF = 'DSH_HUD_TODO_OAUTH'

/**
 * The login (OAuth 2.0 authorization-code) providers, as DATA.
 *
 * Endpoint paths in vendor consoles change; a table can be corrected without
 * touching the flow, and the settings screen lets each field be overridden. The
 * defaults below are the documented authorization/token endpoints for the
 * "self-built app" (自建应用) case.
 *
 * What a plugin CANNOT do, and therefore says out loud in the UI: create the
 * app, pick its scopes, or approve it inside a tenant. Until that exists there
 * is no client id to log in with.
 */
const LOGIN_PROVIDERS = {
  feishu: {
    label: '飞书',
    authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
    tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    tasksUrl: 'https://open.feishu.cn/open-apis/task/v2/tasks',
    scope: 'task:task:read',
    idField: 'app_id',
    secretField: 'app_secret',
    console: 'https://open.feishu.cn/app',
  },
  dingtalk: {
    label: '钉钉',
    authorizeUrl: 'https://login.dingtalk.com/oauth2/auth',
    tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    tasksUrl: 'https://api.dingtalk.com/v1.0/todo/users/me/tasks',
    scope: 'Todo.Todo.Read',
    idField: 'client_id',
    secretField: 'client_secret',
    console: 'https://open-dev.dingtalk.com',
  },
}

// ── time helpers ───────────────────────────────────────────────────────────

/** Local `YYYY-MM-DD` for a Date (never `toISOString`, which is UTC). */
function localDate(at) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** `HH:MM` in local time. */
function localClock(at) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Midnight at the start of the local day `at` falls in. */
function startOfDay(at) {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/**
 * Parse what the card sends for a due moment.
 *
 * Accepts `2026-10-01` (a date → 09:00 local, so it appears in the morning
 * rather than at midnight) and `2026-10-01T14:30` / a full ISO string. Returns
 * epoch millis, or undefined when there is no usable time.
 */
export function parseDue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const at = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 9, 0, 0, 0)
    return Number.isFinite(at.getTime()) ? at.getTime() : undefined
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `HH:MM` → minutes since midnight, or undefined. */
export function parseDigestAt(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

// ── ICS ────────────────────────────────────────────────────────────────────

/** Unfold RFC 5545 folded lines: a line starting with space/TAB continues. */
export function unfold(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .reduce((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += line.slice(1)
      else lines.push(line)
      return lines
    }, [])
}

/** `NAME;PARAM=1:value` → `{ name, params, value }` (params upper-cased). */
export function parseProperty(line) {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const [name, ...rest] = head.split(';')
  const params = {}
  for (const part of rest) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    params[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).replace(/^"|"$/g, '')
  }
  return { name: name.trim().toUpperCase(), params, value }
}

/** Unescape the escapes ICS text values use. */
export function unescapeText(value) {
  return String(value ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

/**
 * Parse an ICS time value into epoch millis.
 *
 * `VALUE=DATE` is an all-day date: it becomes 09:00 local, the same convention
 * `parseDue` uses, so an all-day event is not announced at 00:00.
 *
 * `TZID` is honoured as far as JavaScript allows without a timezone database:
 * an explicit `Z` is UTC; a `TZID` other than the machine's own zone is treated
 * as wall-clock in that zone and then re-anchored through `Intl` — see
 * `zonedToEpoch`, which uses the offset the runtime already knows for the
 * target date rather than guessing a fixed one.
 */
export function parseIcsTime(value, params = {}, now = Date.now()) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(text)) {
    const match = /^(\d{4})(\d{2})(\d{2})/.exec(text)
    if (!match) return undefined
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9, 0, 0, 0)
    return Number.isFinite(at.getTime()) ? at.getTime() : undefined
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(text)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, utc] = match
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0)]
  if (utc === 'Z') {
    const at = new Date(Date.UTC(...parts))
    return Number.isFinite(at.getTime()) ? at.getTime() : undefined
  }
  const zone = params.TZID
  const wall = new Date(...parts)
  if (!zone || zone === 'local') return Number.isFinite(wall.getTime()) ? wall.getTime() : undefined
  return zonedToEpoch(parts, zone, wall.getTime(), now)
}

/**
 * Wall-clock parts in a named zone → epoch millis.
 *
 * `Intl` is asked what that zone's clock reads at a first-guess instant; the
 * difference is the zone's offset at that moment, which is then subtracted. Two
 * passes, because the first guess can land on the other side of a DST switch —
 * and a silent one-hour error in a reminder is exactly the kind of bug nobody
 * finds until it matters.
 */
export function zonedToEpoch(parts, zone, fallback, now = Date.now()) {
  const asUtc = Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5] ?? 0)
  const offsetAt = (instant) => {
    try {
      const format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
      const seen = {}
      for (const { type, value } of format.formatToParts(new Date(instant))) seen[type] = value
      const asIfUtc = Date.UTC(
        Number(seen.year), Number(seen.month) - 1, Number(seen.day),
        Number(seen.hour === '24' ? '00' : seen.hour), Number(seen.minute), Number(seen.second),
      )
      return asIfUtc - instant
    } catch {
      return null
    }
  }
  const first = offsetAt(asUtc - (offsetAt(now) ?? 0))
  if (first === null) return fallback
  const second = offsetAt(asUtc - first)
  const offset = second === null ? first : second
  const result = asUtc - offset
  return Number.isFinite(result) ? result : fallback
}

/**
 * Expand an `RRULE` into occurrences inside `[from, to]`.
 *
 * Limited on purpose: `FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL`, `COUNT`,
 * `UNTIL` and `BYDAY` (weekly). Anything else is reported through `unsupported`
 * so the caller can mark the item approximate instead of inventing times.
 *
 * @returns {{ times: number[], unsupported: string[] }}
 */
export function expandRule(rule, start, from, to, limit = 60) {
  const fields = {}
  for (const part of String(rule ?? '').split(';')) {
    const [key, value] = part.split('=')
    if (key && value !== undefined) fields[key.trim().toUpperCase()] = value.trim()
  }
  const unsupported = []
  const freq = fields.FREQ
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) {
    if (freq) unsupported.push(`FREQ=${freq}`)
    return { times: [], unsupported }
  }
  for (const key of Object.keys(fields)) {
    if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(key)) unsupported.push(key)
  }
  if (fields.BYSETPOS || fields.BYMONTHDAY || fields.BYMONTH || fields.BYYEARDAY) unsupported.push('BYSETPOS/BYMONTH*')
  const interval = Math.max(1, Number(fields.INTERVAL) || 1)
  const count = fields.COUNT === undefined ? Infinity : Math.max(0, Number(fields.COUNT) || 0)
  const until = fields.UNTIL === undefined ? Infinity : (parseIcsTime(fields.UNTIL, {}) ?? Infinity)
  // `BYDAY` on a weekly rule picks weekdays. Only the plain `MO`/`TU`/… forms
  // are handled; `2MO` ("second Monday") needs BYSETPOS semantics.
  const byDay = []
  if (fields.BYDAY) {
    for (const token of fields.BYDAY.split(',')) {
      const day = token.trim().toUpperCase()
      if (!/^[A-Z]{2}$/.test(day)) unsupported.push(`BYDAY=${token}`)
      else byDay.push(day)
    }
  }
  const DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
  const times = []
  const step = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' }[freq]
  let occurrence = 0
  // Walk forward from the rule's own start, one interval at a time.
  for (let cursor = new Date(start), guard = 0; guard < 800; guard++) {
    if (cursor.getTime() > to) break
    if (cursor.getTime() > until || occurrence >= count) break
    if (freq === 'WEEKLY' && byDay.length > 0) {
      // The cursor marks the week; emit each selected weekday inside it.
      const weekStart = startOfDay(cursor)
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)) // Monday
      for (const day of byDay) {
        // `COUNT` counts OCCURRENCES, so it has to be checked per emitted
        // weekday — checking it once per week lets a two-day rule overshoot.
        if (occurrence >= count) break
        const at = new Date(weekStart)
        at.setDate(at.getDate() + ((DAY_INDEX[day] + 6) % 7))
        at.setHours(new Date(start).getHours(), new Date(start).getMinutes(), 0, 0)
        if (at.getTime() < start || at.getTime() > until) continue
        occurrence += 1
        if (at.getTime() >= from && at.getTime() <= to && times.length < limit) times.push(at.getTime())
      }
    } else if (cursor.getTime() >= from && times.length < limit) {
      times.push(cursor.getTime())
      occurrence += 1
    } else if (cursor.getTime() < from) {
      occurrence += 1
    }
    const next = new Date(cursor)
    if (step === 'day') next.setDate(next.getDate() + interval)
    else if (step === 'week') next.setDate(next.getDate() + 7 * interval)
    else next.setMonth(next.getMonth() + interval)
    if (next.getTime() === cursor.getTime()) break
    cursor = next
  }
  return { times: times.sort((a, b) => a - b), unsupported }
}

/**
 * Parse an ICS document into items.
 *
 * @param {string} text
 * @param {{ label?: string, now?: number, horizonDays?: number, idPrefix?: string }} [options]
 * @returns {{ items: any[], unsupported: string[], counts: Record<string, number> }}
 */
export function parseIcs(text, options = {}) {
  const now = options.now ?? Date.now()
  const horizonDays = options.horizonDays ?? HORIZON_DAYS
  const from = now - 86_400_000 // yesterday, so an overdue item is still visible
  const to = now + horizonDays * 86_400_000
  const lines = unfold(text)
  const items = []
  const unsupported = new Set()
  const counts = { events: 0, todos: 0, occurrences: 0, skipped: 0 }
  let block = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT' || line === 'BEGIN:VTODO') {
      block = { kind: line === 'BEGIN:VEVENT' ? 'event' : 'todo', props: {}, alarms: [] }
      continue
    }
    if (line === 'END:VEVENT' || line === 'END:VTODO') {
      if (block) {
        if (block.kind === 'event') counts.events += 1
        else counts.todos += 1
        const built = buildIcsItems(block, { now, from, to, label: options.label, idPrefix: options.idPrefix, unsupported })
        if (built.length === 0) counts.skipped += 1
        else {
          counts.occurrences += built.length
          items.push(...built)
        }
      }
      block = null
      continue
    }
    if (!block) continue
    const property = parseProperty(line)
    if (!property) continue
    if (property.name === 'TRIGGER' || property.name === 'ACTION') continue
    block.props[property.name] = { value: property.value, params: property.params }
  }
  return { items, unsupported: [...unsupported], counts }
}

/** Turn one parsed VEVENT/VTODO block into dated items. */
function buildIcsItems(block, context) {
  const { now, from, to, label, idPrefix, unsupported } = context
  const get = (name) => block.props[name]
  // A VTODO frequently carries ONLY `DUE` (no `DTSTART`), and treating that as
  // "no date" threw the item away — which is how the报销单 in the fixture
  // disappeared. The due moment IS the moment for a todo.
  const startProp = get('DTSTART') ?? get('DUE')
  const dueProp = get('DTEND') ?? (startProp === get('DUE') ? undefined : get('DUE'))
  if (!startProp) return []
  const start = parseIcsTime(startProp.value, startProp.params, now)
  if (start === undefined) return []
  const end = dueProp ? parseIcsTime(dueProp.value, dueProp.params, now) : undefined
  const summary = unescapeText(get('SUMMARY')?.value) || (block.kind === 'todo' ? '(未命名待办)' : '(未命名日程)')
  const note = unescapeText(get('DESCRIPTION')?.value).slice(0, 400)
  const uid = unescapeText(get('UID')?.value) || `${summary}@${start}`
  const rule = get('RRULE')?.value
  let times = [start]
  let approx = false
  if (rule) {
    const expanded = expandRule(rule, start, from, to)
    for (const token of expanded.unsupported) unsupported.add(token)
    if (expanded.times.length > 0) times = expanded.times
    else if (expanded.unsupported.length > 0) {
      // The rule cannot be expanded: keep the series' own start (if it is in
      // range) and SAY it is approximate, rather than pretending it recurs.
      const inRange = start >= from && start <= to
      times = inRange ? [start] : []
      approx = true
    } else {
      times = []
    }
  }
  const items = []
  for (const time of times) {
    if (time < from || time > to) continue
    const allDay = startProp.params.VALUE === 'DATE' || /^\d{8}$/.test(String(startProp.value))
    items.push({
      id: `${idPrefix ?? 'ics'}:${uid}:${time}`,
      title: summary,
      note,
      dueAt: time,
      endAt: end,
      allDay,
      done: String(get('STATUS')?.value ?? '').toUpperCase() === 'COMPLETED',
      readOnly: true,
      approx,
      source: label || 'ical',
      kind: block.kind,
    })
  }
  return items
}

// ── the item model ─────────────────────────────────────────────────────────

/** A new local item, normalized. */
export function makeItem(input, now = Date.now()) {
  const title = String(input?.title ?? '').trim().slice(0, 200)
  if (title === '') return null
  return {
    id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title,
    note: String(input?.note ?? '').trim().slice(0, 500),
    dueAt: parseDue(input?.dueAt),
    priority: ['high', 'normal', 'low'].includes(input?.priority) ? input.priority : 'normal',
    done: false,
    doneAt: undefined,
    createdAt: now,
    updatedAt: now,
    readOnly: false,
    source: 'local',
  }
}

/** Apply a patch to one item, keeping the shape valid whatever arrives. */
export function applyPatch(item, patch, now = Date.now()) {
  const next = { ...item }
  if (typeof patch?.title === 'string' && patch.title.trim() !== '') next.title = patch.title.trim().slice(0, 200)
  if (typeof patch?.note === 'string') next.note = patch.note.trim().slice(0, 500)
  if ('dueAt' in (patch ?? {})) next.dueAt = parseDue(patch.dueAt)
  if (['high', 'normal', 'low'].includes(patch?.priority)) next.priority = patch.priority
  if (typeof patch?.done === 'boolean') {
    next.done = patch.done
    next.doneAt = patch.done ? now : undefined
  }
  if (typeof patch?.snoozeMinutes === 'number' && Number.isFinite(patch.snoozeMinutes)) {
    const base = next.dueAt !== undefined && next.dueAt > now ? next.dueAt : now
    next.dueAt = base + Math.max(1, Math.min(60 * 24 * 30, patch.snoozeMinutes)) * 60_000
    next.done = false
    next.doneAt = undefined
  }
  next.updatedAt = now
  return next
}

/**
 * Group items the way the card reads them.
 *
 * `overdue` is "before today", not "before now": an item due at 09:00 is not
 * late at 09:01 in any useful sense, and a list that shouts at you all morning
 * is a list you stop reading.
 */
export function groupItems(items, now = Date.now()) {
  const today = startOfDay(new Date(now)).getTime()
  const tomorrow = today + 86_400_000
  const groups = { overdue: [], today: [], tomorrow: [], later: [], someday: [], done: [] }
  for (const item of items) {
    if (item.done) {
      groups.done.push(item)
      continue
    }
    if (item.dueAt === undefined) {
      groups.someday.push(item)
      continue
    }
    const day = startOfDay(new Date(item.dueAt)).getTime()
    if (day < today) groups.overdue.push(item)
    else if (day === today) groups.today.push(item)
    else if (day === tomorrow) groups.tomorrow.push(item)
    else groups.later.push(item)
  }
  const byDue = (a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)
  const byCreated = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
  for (const key of ['overdue', 'today', 'tomorrow', 'later']) groups[key].sort(byDue)
  groups.someday.sort(byCreated)
  groups.done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  return groups
}

/**
 * What the digest should say, given the local clock.
 *
 * Fires **once a day, at or after `digestAt`**, and only when there is
 * something to say: a reminder that says "nothing tomorrow" every evening is
 * noise, and the ask was "提示明天的事项（如果有）".
 */
export function digestFor(items, now, digestAt) {
  const target = parseDigestAt(digestAt)
  if (target === undefined) return null
  const at = new Date(now)
  const minutes = at.getHours() * 60 + at.getMinutes()
  if (minutes < target) return null
  const today = startOfDay(at).getTime()
  const tomorrow = today + 86_400_000
  const pending = items.filter((item) => !item.done && item.dueAt !== undefined
    && startOfDay(new Date(item.dueAt)).getTime() === tomorrow)
  if (pending.length === 0) return null
  return {
    day: localDate(at),
    at: localClock(at),
    title: `明天有 ${pending.length} 项待办`,
    items: pending.slice(0, 8).map((item) => ({ id: item.id, title: item.title, dueAt: item.dueAt })),
    more: Math.max(0, pending.length - 8),
  }
}

// ── config + state ─────────────────────────────────────────────────────────

function readSettings(host) {
  const stored = host.storage.read()
  const settings = stored?.settings && typeof stored.settings === 'object' ? stored.settings : {}
  const feeds = Array.isArray(settings.feeds)
    ? settings.feeds
        .filter((feed) => feed && typeof feed.url === 'string' && /^https?:\/\//i.test(feed.url))
        .slice(0, 8)
        .map((feed, index) => ({
          url: feed.url,
          label: typeof feed.label === 'string' && feed.label.trim() !== '' ? feed.label.trim().slice(0, 40) : `订阅 ${index + 1}`,
          enabled: feed.enabled !== false,
        }))
    : []
  const leads = Array.isArray(settings.leads)
    ? [...new Set(settings.leads.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 24 * 60))].sort((a, b) => b - a).slice(0, 6)
    : DEFAULT_LEADS
  return {
    feeds,
    leads: leads.length > 0 ? leads : DEFAULT_LEADS,
    digestAt: parseDigestAt(settings.digestAt) === undefined ? DEFAULT_DIGEST_AT : settings.digestAt,
    ignore: Array.isArray(settings.ignore) ? settings.ignore.filter((value) => typeof value === 'string').slice(0, 500) : [],
  }
}

/**
 * Persist the pomodoro block. Written on its own, so a timer action can never race
 * a todo edit into the same record.
 */
function writePomodoro(host, next) {
  const stored = host.storage.read()
  host.storage.write({ ...(stored ?? {}), pomodoro: next })
}

function readItems(host) {
  const stored = host.storage.read()
  return Array.isArray(stored?.items) ? stored.items.filter((item) => item && typeof item.id === 'string') : []
}

/** The mail account (no secret: that lives in the credential store). */
function readMail(host) {
  const stored = host.storage.read()
  const mail = stored?.mail && typeof stored.mail === 'object' ? stored.mail : {}
  return {
    host: typeof mail.host === 'string' ? mail.host.trim() : '',
    port: Number.isFinite(Number(mail.port)) && Number(mail.port) > 0 ? Number(mail.port) : 993,
    user: typeof mail.user === 'string' ? mail.user.trim() : '',
    mailbox: typeof mail.mailbox === 'string' && mail.mailbox.trim() !== '' ? mail.mailbox.trim() : 'INBOX',
    limit: Number.isFinite(Number(mail.limit)) ? Math.min(50, Math.max(5, Number(mail.limit))) : 15,
    // Which provider preset the host/user came from, for the UI only.
    preset: typeof mail.preset === 'string' ? mail.preset : 'custom',
  }
}

/**
 * Known IMAP endpoints, so the common case is two fields and not five.
 *
 * Every one of them authenticates with an 授权码 rather than the account
 * password; the card says so next to the field.
 */
const MAIL_PRESETS = {
  '163': { label: '网易 163', host: 'imap.163.com', port: 993, hint: '设置 → POP3/SMTP/IMAP → 开启 IMAP → 新增授权码' },
  '126': { label: '网易 126', host: 'imap.126.com', port: 993, hint: '同上：开启 IMAP 后生成授权码' },
  qq: { label: 'QQ 邮箱', host: 'imap.qq.com', port: 993, hint: '设置 → 账户 → 开启 IMAP/SMTP → 生成授权码' },
  exmail: { label: '腾讯企业邮', host: 'imap.exmail.qq.com', port: 993, hint: '邮箱绑定 → 客户端专用密码' },
  aliyun: { label: '阿里云邮箱', host: 'imap.aliyun.com', port: 993, hint: '设置 → 客户端设置 → 生成授权码' },
  outlook: { label: 'Outlook / Hotmail', host: 'outlook.office365.com', port: 993, hint: '微软已要求 OAuth，授权码登录可能被拒' },
  custom: { label: '自定义', host: '', port: 993, hint: '任何支持 IMAP 的邮箱都可以' },
}

function writeItems(host, items) {
  const stored = host.storage.read()
  host.storage.write({ ...stored, items: items.slice(0, MAX_ITEMS) })
}

/** Fetch one feed, with a timeout and a size cap. */
async function fetchFeed(url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch(url, {
      signal: controller?.signal,
      headers: { accept: 'text/calendar, text/plain, */*', 'user-agent': 'dsh-hud/todo' },
    })
    if (!response.ok) return { error: `HTTP ${response.status}` }
    const text = await response.text()
    if (text.length > MAX_FEED_BYTES) return { error: `订阅内容过大（${Math.round(text.length / 1024)} KB）` }
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      // A feed behind a login page answers 200 with HTML. Saying so is more
      // useful than "0 items".
      return { error: /<html/i.test(text) ? '返回的是网页而不是日历（订阅地址可能需要登录）' : '不是 iCalendar 内容' }
    }
    return { text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: /abort/i.test(message) ? `请求超时（${timeoutMs} ms）` : `网络请求失败：${message}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Collect every read-only item from the configured feeds.
 *
 * Cached for `FEED_CACHE_MS`: the card polls every 5 minutes, an enterprise
 * calendar does not change that often, and hammering someone's calendar server
 * is a good way to get the subscription revoked.
 */
function createFeedCollector(host) {
  let cache = { at: 0, items: [], status: [] }
  return async function collect({ force = false, now = Date.now() } = {}) {
    const settings = readSettings(host)
    const active = settings.feeds.filter((feed) => feed.enabled)
    if (active.length === 0) return { items: [], status: [], cached: false }
    if (!force && now - cache.at < FEED_CACHE_MS) return { ...cache, cached: true }
    const items = []
    const status = []
    for (const feed of active) {
      const result = await fetchFeed(feed.url, FEED_TIMEOUT_MS)
      if (result.error) {
        status.push({ label: feed.label, url: feed.url, error: result.error })
        continue
      }
      const parsed = parseIcs(result.text, { label: feed.label, now, idPrefix: feed.label })
      items.push(...parsed.items)
      status.push({
        label: feed.label,
        url: feed.url,
        count: parsed.items.length,
        // Reported, never swallowed: an item whose recurrence could not be
        // expanded is marked approximate, and the feed says which rule it was.
        unsupported: parsed.unsupported,
      })
    }
    cache = { at: now, items, status }
    return { items, status, cached: false }
  }
}

/** Where the access token from a login is kept. */
const TOKEN_REF_FOR_OAUTH = 'DSH_HUD_TODO_TOKEN'

/** HTML-escape for the one page this panel serves. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

/** A tiny response page: the browser lands here, not the HUD. */
function htmlPage(res, message) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(`<!doctype html><meta charset="utf-8"><title>dsh-hud</title>`
    + '<body style="font:14px/1.7 system-ui;padding:32px;max-width:520px;margin:auto">'
    + `<p>${message}</p><p style="color:#888">dsh-hud · 待办</p></body>`)
}

/**
 * Build the URL the user has to open.
 *
 * Returned to the card rather than opened by the host: the host has no browser,
 * and a plugin that silently opens windows is not something to build.
 */
function loginUrlFor(host, oauth) {
  if (oauth.provider === '' || oauth.clientId === '' || oauth.authorizeUrl === '') return ''
  const provider = LOGIN_PROVIDERS[oauth.provider]
  const params = new URLSearchParams({
    [provider.idField]: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state: 'dsh-hud',
  })
  // Feishu names its client parameter `app_id`; DingTalk's QR login wants
  // `client_id` plus a `prompt=consent`. Building it here keeps that difference
  // out of the card.
  if (oauth.provider === 'dingtalk') params.set('prompt', 'consent')
  return `${oauth.authorizeUrl}?${params.toString()}`
}

/**
 * Exchange the authorization code for an access token.
 *
 * The two vendors disagree about the body encoding (form vs JSON) and about the
 * response envelope (`access_token` at the top vs nested under `data`), so both
 * shapes are accepted — and when neither matches, the RAW response is returned
 * as the error. Guessing silently is what turns a wrong endpoint into "0 items".
 */
async function exchangeCode(host, code) {
  const oauth = readOauth(host)
  const provider = LOGIN_PROVIDERS[oauth.provider]
  if (provider === undefined || oauth.tokenUrl === '') return { error: '还没有选择服务商或 token 地址' }
  const secret = await host.credential.resolve(OAUTH_SECRET_REF)
  if (secret === undefined) return { error: `还没有填写 ${provider.secretField}` }
  const payload = {
    grant_type: 'authorization_code',
    code,
    [provider.idField]: oauth.clientId,
    [provider.secretField]: secret,
    redirect_uri: oauth.redirectUri,
  }
  try {
    const response = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: oauth.provider === 'feishu'
        ? { 'content-type': 'application/json; charset=utf-8' }
        : { 'content-type': 'application/x-www-form-urlencoded' },
      body: oauth.provider === 'feishu' ? JSON.stringify(payload) : new URLSearchParams(payload).toString(),
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { error: `token 响应不是 JSON：${text.slice(0, 160)}` }
    }
    // Both vendors nest the useful half under `data` in the v2 shape and put it
    // at the top level in the v1 shape.
    const body = json?.data ?? json
    const token = body?.access_token ?? body?.token ?? json?.access_token
    if (typeof token !== 'string' || token === '') {
      const reason = json?.error_description ?? json?.error ?? body?.message ?? text.slice(0, 160)
      return { error: `token 响应里没有 access_token：${reason}` }
    }
    if (typeof token === 'string') await host.credential.write(TOKEN_REF_FOR_OAUTH, token)
    const expiresIn = Number(body?.expires_in ?? json?.expires_in)
    return {
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + 7_200_000,
      account: body?.name ?? body?.nickname ?? body?.open_id ?? '',
    }
  } catch (error) {
    return { error: `请求 token 失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Read the user's tasks from the provider.
 *
 * The response shape is the one thing here that cannot be verified without a
 * real app, so the mapper is defensive and reports the raw payload when it finds
 * nothing recognisable. It accepts the shapes both vendors document (`items` /
 * `tasks` / `data.items`, `summary` / `subject` / `title`, `due.due_time` /
 * `dueTime`), and `error` carries the raw body so the user can see exactly what
 * their tenant answered.
 */
async function fetchProviderTasks(host) {
  const oauth = readOauth(host)
  if (oauth.provider === '' || oauth.tasksUrl === '') return { error: '还没有选择服务商' }
  const token = await host.credential.resolve(TOKEN_REF_FOR_OAUTH)
  if (token === undefined) return { error: '还没有登录（token 不存在）' }
  try {
    const response = await fetch(`${oauth.tasksUrl}?completed=false&page_size=50`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(oauth.provider === 'dingtalk' ? { 'x-acs-dingtalk-access-token': token } : {}),
      },
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { error: `接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}` }
    }
    const list = json?.data?.items ?? json?.items ?? json?.data?.tasks ?? json?.tasks ?? json?.result?.items
    if (!Array.isArray(list)) {
      const reason = json?.msg ?? json?.message ?? json?.error?.message ?? `HTTP ${response.status}`
      return { error: `没找到任务数组：${reason}`, raw: text.slice(0, 400) }
    }
    const tasks = []
    for (const entry of list) {
      const title = String(entry?.summary ?? entry?.subject ?? entry?.title ?? entry?.content ?? '').trim()
      if (title === '') continue
      const due = entry?.due?.due_time ?? entry?.dueTime ?? entry?.due_at ?? entry?.dueDate
      tasks.push({
        id: String(entry?.guid ?? entry?.id ?? entry?.taskId ?? title),
        title: title.slice(0, 200),
        note: String(entry?.description ?? entry?.desc ?? '').slice(0, 400),
        // Both vendors use epoch MILLISECONDS (as a string) for due times.
        dueAt: Number.isFinite(Number(due)) && Number(due) > 0 ? Number(due) : parseDue(due),
        done: entry?.completed_at !== undefined && entry.completed_at !== '0' && entry.completed_at !== 0,
      })
    }
    return { tasks }
  } catch (error) {
    return { error: `读取待办失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The login configuration, minus every secret.
 *
 * Module scope on purpose: `snapshot()` needs it, and a helper nested inside
 * `mount()` is invisible to a module-level function — which is exactly how the
 * state route started answering 500 after the login routes were added.
 */
function readOauth(host) {
  const stored = host.storage.read()
  const oauth = stored?.oauth && typeof stored.oauth === 'object' ? stored.oauth : {}
  const provider = LOGIN_PROVIDERS[oauth.provider] ? oauth.provider : ''
  return {
    provider,
    clientId: typeof oauth.clientId === 'string' ? oauth.clientId.trim() : '',
    redirectUri: typeof oauth.redirectUri === 'string' ? oauth.redirectUri.trim() : '',
    authorizeUrl: typeof oauth.authorizeUrl === 'string' && oauth.authorizeUrl !== '' ? oauth.authorizeUrl : (provider ? LOGIN_PROVIDERS[provider].authorizeUrl : ''),
    tokenUrl: typeof oauth.tokenUrl === 'string' && oauth.tokenUrl !== '' ? oauth.tokenUrl : (provider ? LOGIN_PROVIDERS[provider].tokenUrl : ''),
    tasksUrl: typeof oauth.tasksUrl === 'string' && oauth.tasksUrl !== '' ? oauth.tasksUrl : (provider ? LOGIN_PROVIDERS[provider].tasksUrl : ''),
    expiresAt: Number.isFinite(Number(oauth.expiresAt)) ? Number(oauth.expiresAt) : 0,
    account: typeof oauth.account === 'string' ? oauth.account : '',
    lastError: typeof oauth.lastError === 'string' ? oauth.lastError : '',
  }
}

function writeOauth(host, patch) {
  const stored = host.storage.read()
  const current = stored?.oauth && typeof stored.oauth === 'object' ? stored.oauth : {}
  host.storage.write({ ...stored, oauth: { ...current, ...patch } })
}

/** The payload both halves read. */
function snapshot(host, feeds, now) {
  const settings = readSettings(host)
  const local = readItems(host)
  const ignored = new Set(settings.ignore)
  // Three sources, one list: your own items, whatever the calendar feeds hand
  // over, and whatever a login-based provider returned. All read-only except the
  // first.
  const providerTasks = Array.isArray(host.storage.read()?.providerTasks) ? host.storage.read().providerTasks : []
  const external = [...feeds.items, ...providerTasks].filter((item) => !ignored.has(item.id))
  const items = [...local, ...external]
  const groups = groupItems(items, now)
  const leads = settings.leads
  return {
    ok: true,
    now,
    todayDate: localDate(new Date(now)),
    clock: localClock(new Date(now)),
    localCount: local.length,
    externalCount: external.length,
    counts: {
      overdue: groups.overdue.length,
      today: groups.today.length,
      tomorrow: groups.tomorrow.length,
      later: groups.later.length,
      someday: groups.someday.length,
      done: groups.done.length,
      open: groups.overdue.length + groups.today.length + groups.tomorrow.length + groups.later.length + groups.someday.length,
    },
    groups,
    leads,
    digestAt: settings.digestAt,
    // The browser fires these; the host only says what the schedule is.
    schedule: groups.overdue.concat(groups.today, groups.tomorrow, groups.later)
      .filter((item) => item.dueAt !== undefined && !item.done)
      .slice(0, 40)
      .map((item) => ({ id: item.id, title: item.title, dueAt: item.dueAt, readOnly: item.readOnly === true })),
    digest: digestFor(items, now, settings.digestAt),
    feeds: feeds.status,
    feedSettings: settings.feeds,
    // What the login cards need, minus every secret: the client id and the URLs
    // are configuration, the client secret and the token never leave the host.
    oauth: (() => {
      const oauth = readOauth(host)
      return {
        provider: oauth.provider,
        clientId: oauth.clientId,
        redirectUri: oauth.redirectUri,
        expiresAt: oauth.expiresAt,
        account: oauth.account,
        lastError: oauth.lastError,
        providerLabel: oauth.provider === '' ? '' : LOGIN_PROVIDERS[oauth.provider].label,
        scope: oauth.provider === '' ? '' : LOGIN_PROVIDERS[oauth.provider].scope,
        idField: oauth.provider === '' ? 'client_id' : LOGIN_PROVIDERS[oauth.provider].idField,
        secretField: oauth.provider === '' ? 'client_secret' : LOGIN_PROVIDERS[oauth.provider].secretField,
        console: oauth.provider === '' ? '' : LOGIN_PROVIDERS[oauth.provider].console,
      }
    })(),
    providerCount: providerTasks.length,
    mail: (() => {
      const mail = readMail(host)
      return { host: mail.host, port: mail.port, user: mail.user, mailbox: mail.mailbox, limit: mail.limit, preset: mail.preset }
    })(),
    mailPresets: MAIL_PRESETS,
    ignoreCount: settings.ignore.length,
  }
}

// ── the panel ──────────────────────────────────────────────────────────────

export function schema(z) {
  return z.object({
    pollMs: live(z.number().min(30_000).max(3_600_000).default(refreshMs))
      .description('浏览器轮询间隔（毫秒）'),
    feedCacheMs: live(z.number().min(60_000).max(24 * 3_600_000).default(FEED_CACHE_MS))
      .description('日历订阅的缓存时长（毫秒）'),
    digestAt: live(z.string().default(DEFAULT_DIGEST_AT))
      .description('每天的下班前提醒时间（HH:MM，本地时间）'),
    timeoutMs: live(z.number().min(1_000).max(60_000).default(FEED_TIMEOUT_MS))
      .description('订阅请求超时（毫秒）'),
  })
}

/** @param {import('../../lib/host-kit.js').PanelHost} host */
export function mount(host) {
  const collectFeeds = createFeedCollector(host)
  let lastFeeds = { items: [], status: [], cached: false }
  /** The last snapshot, reused inside one poll window. */
  let cachedState = null
  let cachedAt = 0

  const pollMs = () => {
    const value = Number(host.config().pollMs ?? refreshMs)
    return Number.isFinite(value) ? Math.min(3_600_000, Math.max(30_000, value)) : refreshMs
  }

  async function stateOnce({ force = false, now = Date.now() } = {}) {
    if (!force && cachedState !== null && now - cachedAt < Math.min(pollMs(), 10_000)) return cachedState
    lastFeeds = await collectFeeds({ force, now })
    // The pomodoro is SETTLED on every read: nothing runs while nobody is looking,
    // so this is where a finished session becomes a real transition. Idempotent —
    // a second read a moment later has nothing left to settle.
    const settled = settlePomodoro(readPomodoro(host), now)
    if (settled[1] !== undefined) writePomodoro(host, settled[0])
    const payload = {
      ...snapshot(host, lastFeeds, now),
      pomodoro: { ...pomodoroView(settled[0], now), justEnded: settled[1] ?? null },
      // Whether a secret EXISTS — never the secret. The card needs it to say
      // "已保存，留空不改" instead of asking for the 授权码 again on every visit.
      mailHasSecret: (await host.credential.present(MAIL_SECRET_REF)) === true,
      oauthHasSecret: (await host.credential.present(OAUTH_SECRET_REF)) === true,
      oauthHasToken: (await host.credential.present(TOKEN_REF_FOR_OAUTH)) === true,
      version: host.ctx?.__hudVersion,
      pollMs: pollMs(),
      refreshMs: pollMs(),
    }
    cachedState = payload
    cachedAt = now
    return payload
  }

  host.route('pomodoro', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const action = String(body?.action ?? '')
      const now = Date.now()
      const current = readPomodoro(host)
      const ACTIONS = ['start', 'pause', 'resume', 'skip', 'reset', 'settle']
      if (!ACTIONS.includes(action)) {
        return host.json(res, 400, { ok: false, error: `动作只能是 ${ACTIONS.join('/')}` })
      }
      // `settle` is what the card calls the moment its countdown hits zero, so a
      // finished session is recorded and announced within a second instead of at
      // the next poll. It mutates nothing else.
      const settled = settlePomodoro(current, now)
      let next = settled[0]
      let ended = settled[1]
      if (action !== 'settle') next = applyPomodoroAction(next, action, now)
      // Settings may ride along with any action (the editor uses `settle` for it).
      if (body?.settings && typeof body.settings === 'object') {
        next = {
          ...next,
          settings: {
            workMinutes: clampInt(body.settings.workMinutes, ...POMODORO_LIMITS.workMinutes, next.settings.workMinutes),
            breakMinutes: clampInt(body.settings.breakMinutes, ...POMODORO_LIMITS.breakMinutes, next.settings.breakMinutes),
            longBreakEvery: clampInt(body.settings.longBreakEvery, ...POMODORO_LIMITS.longBreakEvery, next.settings.longBreakEvery),
            longBreakMinutes: clampInt(body.settings.longBreakMinutes, ...POMODORO_LIMITS.longBreakMinutes, next.settings.longBreakMinutes),
          },
        }
      }
      if (typeof body?.label === 'string') next = { ...next, label: body.label.slice(0, 80) }
      writePomodoro(host, next)
      // The todo payload carries the timer too, so invalidate it rather than let a
      // cached copy describe a timer that has already moved on.
      cachedState = null
      // Settling again after the action: `start` on a stale state must not report
      // a transition that happened before the button was pressed.
      const after = settlePomodoro(next, now)
      if (after[1] !== undefined) {
        writePomodoro(host, after[0])
        ended = after[1]
      }
      host.json(res, 200, {
        ok: true,
        action,
        pomodoro: { ...pomodoroView(after[0], now), justEnded: ended ?? null },
        ...(await stateOnce({ force: false, now })),
      })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('state', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method === 'HEAD') return host.json(res, 200, { ok: true })
    if (req.method !== 'GET' && req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      host.json(res, 200, await stateOnce())
    } catch (error) {
      host.json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('refresh', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      host.json(res, 200, await stateOnce({ force: true }))
    } catch (error) {
      host.json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('add', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const item = makeItem(body, Date.now())
      if (item === null) return host.json(res, 400, { ok: false, error: '标题不能为空' })
      const items = readItems(host)
      if (items.length >= MAX_ITEMS) return host.json(res, 400, { ok: false, error: `最多 ${MAX_ITEMS} 条` })
      writeItems(host, [item, ...items])
      cachedState = null
      host.json(res, 200, { ok: true, item, ...(await stateOnce({ force: false })) })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('update', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const target = String(body?.id ?? '')
      const items = readItems(host)
      const index = items.findIndex((item) => item.id === target)
      if (index < 0) return host.json(res, 404, { ok: false, error: '没有这条待办' })
      const next = items.slice()
      next[index] = applyPatch(items[index], body.patch ?? body, Date.now())
      writeItems(host, next)
      cachedState = null
      host.json(res, 200, { ok: true, item: next[index], ...(await stateOnce({ force: false })) })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('remove', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const target = String(body?.id ?? '')
      const items = readItems(host)
      // A read-only (feed) item cannot be deleted from someone's calendar, so
      // "remove" on one means "stop showing it here" — recorded as an ignore,
      // which is the honest version of the same gesture.
      if (!items.some((item) => item.id === target)) {
        const stored = host.storage.read()
        const settings = stored?.settings && typeof stored.settings === 'object' ? stored.settings : {}
        const ignore = [...new Set([...(Array.isArray(settings.ignore) ? settings.ignore : []), target])].slice(-500)
        host.storage.write({ ...stored, settings: { ...settings, ignore } })
        cachedState = null
        return host.json(res, 200, { ok: true, ignored: target, ...(await stateOnce({ force: false })) })
      }
      writeItems(host, items.filter((item) => item.id !== target))
      cachedState = null
      host.json(res, 200, { ok: true, removed: target, ...(await stateOnce({ force: false })) })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('settings', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const stored = host.storage.read()
      const current = readSettings(host)
      const feeds = Array.isArray(body?.feeds)
        ? body.feeds
            .filter((feed) => feed && typeof feed.url === 'string' && /^https?:\/\//i.test(feed.url.trim()))
            .slice(0, 8)
            .map((feed, index) => ({
              url: feed.url.trim(),
              label: String(feed.label ?? '').trim().slice(0, 40) || `订阅 ${index + 1}`,
              enabled: feed.enabled !== false,
            }))
        : current.feeds
      const leads = Array.isArray(body?.leads) ? body.leads : current.leads
      const digestAt = typeof body?.digestAt === 'string' ? body.digestAt : current.digestAt
      if (parseDigestAt(digestAt) === undefined) return host.json(res, 400, { ok: false, error: '时间格式应为 HH:MM' })
      const cleanedLeads = [...new Set(leads.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 1440))]
        .sort((a, b) => b - a).slice(0, 6)
      host.storage.write({
        ...stored,
        settings: {
          ...(stored?.settings ?? {}),
          feeds,
          leads: cleanedLeads.length > 0 ? cleanedLeads : DEFAULT_LEADS,
          digestAt,
          ignore: current.ignore,
        },
      })
      cachedState = null
      host.json(res, 200, { ok: true, ...(await stateOnce({ force: true })) })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('feed', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    // Probe ONE url before saving it, so the card can report why a subscription
    // does not work while the user still has the URL in their clipboard.
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const url = String(body?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return host.json(res, 400, { ok: false, error: '订阅地址必须以 http(s):// 开头' })
      const result = await fetchFeed(url, host.config().timeoutMs ?? FEED_TIMEOUT_MS)
      if (result.error) return host.json(res, 200, { ok: false, error: result.error })
      const parsed = parseIcs(result.text, { label: body?.label || '订阅', now: Date.now() })
      host.json(res, 200, {
        ok: true,
        counts: parsed.counts,
        unsupported: parsed.unsupported,
        next: parsed.items.slice(0, 5).map((item) => ({ title: item.title, dueAt: item.dueAt })),
      })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  // ── 邮箱：IMAP + 授权码 ───────────────────────────────────────────────────
  /**
   * Read the newest headers of one mailbox.
   *
   * A GOAL, not a guess: this returns what the mailbox actually contains and the
   * user decides which message becomes a to-do. Nothing here tries to detect
   * "actionable" mail — a wrong guess puts junk in someone's task list, and there
   * is no signal that would make the guess right.
   */
  async function readMailbox({ limit } = {}) {
    const mail = readMail(host)
    if (mail.host === '' || mail.user === '') {
      return { error: '还没有配置邮箱（设置 → 邮箱）' }
    }
    const secret = await host.credential.resolve(MAIL_SECRET_REF)
    if (secret === undefined) return { error: '还没有保存授权码' }
    try {
      const result = await fetchRecentHeaders({
        host: mail.host,
        port: mail.port,
        user: mail.user,
        password: secret,
        mailbox: mail.mailbox,
        limit: limit ?? mail.limit,
        timeoutMs: host.config().timeoutMs ?? FEED_TIMEOUT_MS,
      })
      return { mail, ...result }
    } catch (error) {
      const message = error instanceof ImapError || error instanceof Error ? error.message : String(error)
      return { error: message }
    }
  }

  host.route('mail', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method === 'HEAD') return host.json(res, 200, { ok: true })
    if (req.method === 'GET') {
      const mail = readMail(host)
      return host.json(res, 200, {
        ok: true,
        mail,
        presets: MAIL_PRESETS,
        hasSecret: (await host.credential.present(MAIL_SECRET_REF)) === true,
      })
    }
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const stored = host.storage.read()
      const preset = MAIL_PRESETS[body?.preset] ?? MAIL_PRESETS.custom
      const presetHost = body?.preset && body.preset !== 'custom' ? preset.host : undefined
      const mail = {
        preset: typeof body?.preset === 'string' && MAIL_PRESETS[body.preset] ? body.preset : 'custom',
        host: String(body?.host ?? presetHost ?? readMail(host).host).trim(),
        port: Number(body?.port ?? preset.port) || 993,
        user: String(body?.user ?? readMail(host).user).trim(),
        mailbox: String(body?.mailbox ?? readMail(host).mailbox).trim() || 'INBOX',
        limit: Number(body?.limit ?? readMail(host).limit) || 15,
      }
      // The 授权码 goes to the credential store; a blank value means "keep the
      // one you have", so re-saving the host does not wipe the secret.
      const secret = typeof body?.secret === 'string' ? body.secret.trim() : ''
      if (secret !== '') await host.credential.write(MAIL_SECRET_REF, secret)
      if (body?.clearSecret === true) await host.credential.remove(MAIL_SECRET_REF)
      host.storage.write({ ...stored, mail })
      cachedState = null
      host.json(res, 200, {
        ok: true,
        mail: readMail(host),
        hasSecret: (await host.credential.present(MAIL_SECRET_REF)) === true,
      })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('mail/list', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const result = await readMailbox({ limit: body?.limit })
      if (result.error) return host.json(res, 200, { ok: false, error: result.error })
      host.json(res, 200, {
        ok: true,
        mailbox: result.mailbox,
        total: result.total,
        messages: result.messages.map((message) => ({
          uid: message.uid,
          subject: message.subject,
          from: message.from,
          date: message.date ?? message.internalDate,
          seen: message.seen,
          flagged: message.flagged,
        })),
      })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  // ── 飞书 / 钉钉：登录换 token ─────────────────────────────────────────────
  /**
   * The authorization-code flow, in three routes: start, callback, tasks.
   *
   * `redirect_uri` points at THIS host's own callback, so the login finishes on
   * the machine the HUD runs on. Two things are the user's to supply and the UI
   * says so plainly: the app has to exist in the vendor console, and the vendor
   * has to accept that redirect URI.
   */
  // readOauth / writeOauth live at module scope: `snapshot()` needs them, and a
  // helper nested in `mount()` is invisible to it (which is how the state route
  // started answering 500).
  host.route('login', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}')
      const stored = host.storage.read()
      const current = readOauth(host)
      const provider = typeof body?.provider === 'string' && LOGIN_PROVIDERS[body.provider] ? body.provider : current.provider
      const oauth = {
        provider,
        clientId: String(body?.clientId ?? current.clientId).trim(),
        redirectUri: String(body?.redirectUri ?? current.redirectUri).trim(),
        authorizeUrl: String(body?.authorizeUrl ?? current.authorizeUrl).trim(),
        tokenUrl: String(body?.tokenUrl ?? current.tokenUrl).trim(),
        tasksUrl: String(body?.tasksUrl ?? current.tasksUrl).trim(),
        expiresAt: current.expiresAt,
        account: current.account,
        lastError: current.lastError,
      }
      const secret = typeof body?.clientSecret === 'string' ? body.clientSecret.trim() : ''
      if (secret !== '') await host.credential.write(OAUTH_SECRET_REF, secret)
      if (body?.logout === true) {
        await host.credential.remove(OAUTH_SECRET_REF)
        oauth.expiresAt = 0
        oauth.account = ''
        oauth.lastError = ''
      } else if (body?.forgetToken === true) {
        await host.credential.remove(TOKEN_REF_FOR_OAUTH)
        oauth.expiresAt = 0
        oauth.account = ''
      }
      host.storage.write({ ...stored, oauth })
      cachedState = null
      host.json(res, 200, {
        ok: true,
        oauth: readOauth(host),
        hasSecret: (await host.credential.present(OAUTH_SECRET_REF)) === true,
        providers: Object.fromEntries(Object.entries(LOGIN_PROVIDERS).map(([key, value]) => [key, { label: value.label, console: value.console, scope: value.scope, idField: value.idField, secretField: value.secretField }])),
        // The URL to open, built here so the card does not have to know the
        // provider's parameter names.
        authorizeUrl: loginUrlFor(host, readOauth(host)),
      })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.route('callback', async (req, res) => {
    // The vendor redirects the BROWSER here, so this one is a GET with a query
    // and answers with a small page rather than JSON.
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code') ?? ''
      const failure = url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? ''
      if (failure !== '') {
        writeOauth(host, { lastError: failure })
        return htmlPage(res, `登录被拒绝：${escapeHtml(failure)}`)
      }
      if (code === '') return htmlPage(res, '回调里没有 code。')
      const result = await exchangeCode(host, code)
      if (result.error) {
        writeOauth(host, { lastError: result.error })
        return htmlPage(res, `换取 token 失败：${escapeHtml(result.error)}`)
      }
      writeOauth(host, { expiresAt: result.expiresAt, account: result.account, lastError: '' })
      return htmlPage(res, `登录成功${result.account ? `：${escapeHtml(result.account)}` : ''}。可以关掉这个页面，回到 HUD 点「拉取待办」。`)
    } catch (error) {
      htmlPage(res, `回调处理失败：${escapeHtml(error instanceof Error ? error.message : String(error))}`)
    }
  })

  host.route('tasks', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' })
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' })
    try {
      const result = await fetchProviderTasks(host)
      if (result.error) return host.json(res, 200, { ok: false, error: result.error, raw: result.raw })
      // Provider tasks become read-only items, exactly like an ICS feed: the
      // vendor owns them, the HUD shows them.
      const items = result.tasks.map((task) => ({
        id: `login:${readOauth(host).provider}:${task.id}`,
        title: task.title,
        note: task.note ?? '',
        dueAt: task.dueAt,
        done: task.done === true,
        readOnly: true,
        source: LOGIN_PROVIDERS[readOauth(host).provider]?.label ?? 'login',
        kind: 'task',
      }))
      const stored = host.storage.read()
      host.storage.write({ ...stored, providerTasks: items })
      cachedState = null
      host.json(res, 200, { ok: true, count: items.length, tasks: items.slice(0, 20) })
    } catch (error) {
      host.json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  host.log(`todo panel mounted at ${host.basePath}/*`)
  return { stateOnce, collectFeeds }
}

/** Pure helpers, exported for the test harness. */
export const __test = {
  settlePomodoro,
  applyPomodoroAction,
  pomodoroView,
  pomodoroDayKey,
  phaseLength,
  POMODORO_DEFAULTS,
  POMODORO_LIMITS,
  parseDue,
  parseDigestAt,
  unfold,
  parseProperty,
  unescapeText,
  parseIcsTime,
  zonedToEpoch,
  expandRule,
  parseIcs,
  makeItem,
  applyPatch,
  groupItems,
  digestFor,
  localDate,
  localClock,
  DEFAULT_LEADS,
  DEFAULT_DIGEST_AT,
  HORIZON_DAYS,
  MAX_ITEMS,
  LOGIN_PROVIDERS,
  MAIL_PRESETS,
  MAIL_SECRET_REF,
  OAUTH_SECRET_REF,
  TOKEN_REF_FOR_OAUTH,
  loginUrlFor,
  escapeHtml,
}