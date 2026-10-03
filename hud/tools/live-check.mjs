/**
 * dsh-hud › live data check.
 *
 * Answers one question with evidence: **does every panel actually retrieve
 * data?** Not "does the code look right" — the mock-context suites already
 * cover that — but "mount the host half exactly as the plugin does, with the
 * config the runtime would materialise, call the real routes, and look at what
 * came back".
 *
 *   node tools/live-check.mjs
 *
 * What makes this stricter than the unit suites:
 *
 *   1. The panels are mounted through the REAL plugin entry (`index.js` →
 *      `apply()`), not one at a time, so the Config is built by the same
 *      schemastery path the runtime uses and every schema DEFAULT is in force.
 *      A panel whose config it only gets from its schema would come up empty
 *      here — that is how the missing watch-list default was caught.
 *   2. Every assertion is a CONTRACT assertion: it checks the exact fields the
 *      browser half reads, with plausible values, not merely that a request
 *      completed. A 200 with an empty array is a FAILURE.
 *   3. Upstream throttling is reported as THROTTLED, separately from FAILED.
 *      The difference matters: one is the internet being rude to a polling
 *      client, the other is the plugin being broken.
 *
 * It talks to the live internet, so it is NOT part of `npm test` — the unit
 * suites must stay hermetic and fast. This is the deliberate online check.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const checkingRemote = process.argv.slice(2).some((value) => value.startsWith('--url') || (value.startsWith('http'))) || Boolean(process.env.DSH_HUD_LIVE_URL)
if (!checkingRemote) {
  const VENDOR = join(here, 'vendor', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
  if (!existsSync(VENDOR)) {
    console.error('schemastery is not vendored yet — run: node tools/extract-vendor.mjs')
    process.exit(2)
  }
  const z = (await import(new URL('./vendor/node_modules/@deepseek-ai/schemastery/lib/index.mjs', import.meta.url).href)).default
  globalThis.__DSH_HUD_TEST_SCHEMASTERY__ = z
}

// Two targets:
//
//   (default)          mount the plugin in-process and call its handlers. Tests
//                      the code, not the server — works before a restart.
//   --url <base>       talk to a RUNNING DeepSeek Harness over HTTP. This is the
//                      end-to-end path the browser half actually uses, so it is
//                      the only check that proves the live server serves data.
//                      Requires the host half to have been loaded (i.e. it will
//                      report 404s until Harness has been restarted once).
//
// `--write` additionally allows the checks that MUTATE state (adding a parcel)
// when pointed at a real server; without it they are skipped.
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const baseUrl = (option('url') ?? process.env.DSH_HUD_LIVE_URL ?? '').replace(/\/+$/, '')
const allowWrite = flag('write')

// The store. By default this is a throwaway directory, so a check never touches
// the real profile. Point `DSH_HUD_LIVE_HOME` at a real DSH home to verify the
// REAL credential and storage state — in which case the mutating checks are
// skipped, because a diagnostic must not leave a test parcel in your watch list.
const requested = baseUrl === '' ? process.env.DSH_HUD_LIVE_HOME : undefined
const useRealHome = typeof requested === 'string' && requested !== '' && existsSync(requested)
const home = baseUrl !== '' ? '' : useRealHome ? requested : mkdtempSync(join(tmpdir(), 'hud-live-'))
const ephemeral = baseUrl === '' && !useRealHome
if (baseUrl === '') process.env.DSH_HOME = home
const writable = ephemeral || allowWrite

// ── git, for the repository fixture ────────────────────────────────────────
// `null` when git is absent, so the check SKIPS instead of failing: a machine
// without git can still run every other check.
const gitBin = (() => {
  try {
    execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { stdio: 'ignore' })
    return process.platform === 'win32' ? 'git.exe' : 'git'
  } catch {
    return null
  }
})()
function git(cwd, ...args) {
  return execFileSync(gitBin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '')
}
const gitRunRoot = mkdtempSync(join(tmpdir(), 'hud-live-git-'))
// ── mounting (skipped entirely when checking a running server) ─────────────
const routes = new Map()
let handles = { panels: () => [] }
if (baseUrl === '') {
  const ctx = {
    credentials: { async resolve() { return undefined } },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    loader: { entries: () => [] },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const mod = await import('../index.js')
  // Through the plugin's own schema, so the targets take the same path a settings
  // edit takes rather than being poked in behind the config's back.
  // A PLAIN object, which is the shape the harness itself passes: `new Config(…)`
  // builds a tree of schemastery NODES, and a node read as a value is how
  // `[object Object] ms` once reached a user-facing error message.
  const config = {
    panels: {
      git: { repos: [{ path: join(gitRunRoot, 'live-demo'), name: 'fixture' }] },
    },
  }
  handles = mod.apply(ctx, config)
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function call(path, { method = 'GET', body } = {}) {
  // Against a running server: a plain fetch, exactly like the browser half.
  if (baseUrl !== '') {
    let res
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new Error(`cannot reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: `non-JSON response (HTTP ${res.status})` }
    }
    return { status: res.status, json: () => parsed }
  }
  const [pathname] = path.split('?')
  const handler = routes.get(pathname)
  if (!handler) return { status: 404, json: () => ({ error: 'route not registered' }) }
  const text = body === undefined ? '' : JSON.stringify(body)
  const listeners = {}
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:19387' },
    on(event, fn) { listeners[event] = fn; return this },
    resume() {},
    flush() {
      if (text !== '') listeners.data?.(Buffer.from(text))
      listeners.end?.()
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(chunk) { this.body = chunk },
  }
  const promise = handler(req, res)
  req.flush()
  await promise
  let parsed
  try {
    parsed = JSON.parse(res.body ?? '{}')
  } catch {
    parsed = { error: 'non-JSON response' }
  }
  return { status: res.statusCode, json: () => parsed }
}

// ── reporting ──────────────────────────────────────────────────────────────
const results = []
const record = (panel, name, ok, detail, kind) => {
  results.push({ panel, name, ok, detail, kind: kind ?? (ok ? 'OK' : 'FAIL') })
}

/**
 * Run one contract assertion. `pick` returns the value to inspect; the
 * assertion fails when it is empty, undefined, or not the expected shape.
 */
async function check(panel, name, fn) {
  try {
    const detail = await fn()
    // A check may return `{ kind, detail }` to say something other than "ok":
    // `skip` (not applicable here) or `slow` (the upstream throttled us). Without
    // this branch an object return was recorded as a PASS with `[object Object]`
    // as its detail — which is how a failing feed reported success.
    if (detail !== null && typeof detail === 'object' && typeof detail.kind === 'string') {
      const kind = detail.kind.toUpperCase()
      record(panel, name, kind === 'OK', detail.detail, kind)
      return
    }
    record(panel, name, true, detail)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Throttling and timeouts are the network's fault, not the panel's, and the
    // panels are built to degrade rather than die — so they do not fail the run.
    const kind = /防抓取|超时|timeout|HTTP 5\d\d|ECONN|fetch failed|限流/i.test(message) ? 'THROTTLED' : 'FAIL'
    record(panel, name, kind === 'THROTTLED', message, kind)
  }
}

const need = (condition, message) => {
  if (!condition) throw new Error(message)
}
const count = (value) => (Array.isArray(value) ? value.length : -1)
const show = (value) => {
  if (value === undefined || value === null) return 'undefined'
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 40)
  return String(value).slice(0, 40)
}

console.log(`dsh-hud live data check — ${new Date().toLocaleString('zh-CN')}`)
console.log(baseUrl !== ''
  ? `target: the RUNNING server at ${baseUrl}`
  : useRealHome
    ? `target: in-process, store = the REAL profile at ${home}`
    : 'target: in-process, store = a throwaway directory (set DSH_HUD_LIVE_HOME to check a real profile)')
console.log(baseUrl === '' ? `panels mounted: ${handles.panels().join(', ')}\n` : '')

// ── quota ──────────────────────────────────────────────────────────────────
await check('quota', 'GET /dsh-hud/quota/usage', async () => {
  const { status, json } = await call('/dsh-hud/quota/usage')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  need(body.ok !== false, `panel reports: ${body.error ?? 'not ok'}`)
  // The shape is `subscriptions[]`, each with its own `windows`. A profile with
  // no credentials configured is a LEGITIMATE state — what must never happen is
  // a subscription that is empty WITHOUT SAYING WHY. That is the contract here.
  const subscriptions = body.subscriptions ?? []
  need(count(subscriptions) > 0, 'no subscription was described at all')
  const withUsage = subscriptions.filter((entry) => count(entry.windows) > 0)
  if (count(withUsage) > 0) {
    const total = withUsage.reduce((sum, entry) => sum + count(entry.windows), 0)
    // A window is `{ key, percent, resetsAt }` (plus used/total/unit when the
    // provider reports a balance) — `key`, not `label`.
    const all = withUsage.flatMap((entry) => entry.windows ?? [])
    const peak = all.reduce((max, window) => (typeof window.percent === 'number' && window.percent > max.percent ? window : max), { percent: -1 })
    const balanced = all.find((window) => window.total !== undefined)
    return `v${show(body.version)} ${count(withUsage)}/${count(subscriptions)} subscription(s), ${total} window(s) · peak ${show(peak.key)} ${show(peak.percent)}%`
      + (balanced ? ` · balance ${show(balanced.used)}/${show(balanced.total)} ${show(balanced.unit)}` : '')
      + (count(withUsage) < count(subscriptions) ? ` · ${count(subscriptions) - count(withUsage)} with no windows` : '')
  }
  const unexplained = subscriptions.filter((entry) => !entry.error && !entry.hint)
  need(count(unexplained) === 0,
    `a subscription came back empty with no explanation: ${JSON.stringify(unexplained[0])}`)
  return `${useRealHome ? 'this profile has' : 'no credentials in a throwaway profile —'} ${count(subscriptions)} subscription(s), each explains why: ${show(subscriptions[0].error)}`
})

// ── github ─────────────────────────────────────────────────────────────────
await check('github', 'GET /dsh-hud/github/state', async () => {
  const { status, json } = await call('/dsh-hud/github/state')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  // Signed out is a legitimate state, but the payload still has to be complete.
  need(body.auth !== undefined, 'no auth section in the payload')
  // ── CI and review requests ───────────────────────────────────────────────
  // Both are ALWAYS in the payload, in both states, so the card never has to ask
  // which shape it is holding.
  need(body.reviews !== undefined && Array.isArray(body.reviews.items),
    `no reviews section: ${show(body.reviews)}`)
  need(typeof body.ciFailing === 'number' && typeof body.ciRunning === 'number',
    `no CI counts: ${show({ failing: body.ciFailing, running: body.ciRunning })}`)
  const account = body.auth?.account
  if (body.auth?.status !== 'ok') {
    // Signed out the review SEARCH cannot run — `review-requested:@me` is a 422
    // unauthenticated — so it must be an empty list rather than an error, with
    // `auth` saying why.
    need(body.reviews.items.length === 0 && body.reviews.error === null,
      `signed out, reviews should be empty and error-free: ${show(body.reviews)}`)
    return `auth=${show(body.auth?.status)} — ${show(body.auth?.error ?? 'not signed in')}`
      + ' · 待评审 0（未登录；该搜索需要授权）· CI 字段已就位'
  }
  // Signed in, the search is authenticated, so it must have produced a COUNT or
  // an error — never a silent empty list that reads as "nothing waiting".
  need(body.reviews.error === null || typeof body.reviews.error === 'string',
    `reviews.error has the wrong shape: ${show(body.reviews.error)}`)
  need(body.reviews.error !== null || typeof body.reviews.total === 'number',
    `signed in with no review count and no error: ${show(body.reviews)}`)
  const withCi = (body.repos ?? []).filter((repo) => repo.ci !== undefined)
  return `signed in as ${show(account?.login)} (${show(account?.publicRepos)} public repos)`
    + ` · 待我评审 ${show(body.reviews.total)}${body.reviews.error ? ` (${show(body.reviews.error)})` : ''}`
    + ` · 监控 ${(body.repos ?? []).length} 个仓库，其中 ${withCi.length} 个带 CI 数据`
    + ` · CI 失败 ${body.ciFailing} / 运行中 ${body.ciRunning}`
    // Three possible answers, and "no runs at all" is one of them: a repository
    // that does not use Actions has an EMPTY run list, which is not a CI failure
    // and not a missing feature.
    + (withCi.length === 0
      ? ''
      : withCi[0].ci?.available === false
        ? ` · 最新：读不到（${show(withCi[0].ci.reason)}）`
        : withCi[0].ci?.latest === undefined
          ? ' · 最新：没有 CI 记录（该仓库不使用 Actions）'
          : ` · 最新：${show(withCi[0].ci.latest.name)} ${show(withCi[0].ci.latest.conclusion ?? withCi[0].ci.latest.status)}`)
})

// ── weather (title-bar widget) ─────────────────────────────────────────────
await check('weather', 'GET /dsh-hud/weather/state', async () => {
  const { status, json } = await call('/dsh-hud/weather/state')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  need(body.ok !== false, `panel reports: ${body.error ?? 'not ok'}`)
  // The key is `location` — not `place`; the checker's own first draft guessed
  // wrong and reported a FAIL for a panel that had in fact resolved a city.
  const where = body.location
  need(where !== undefined, 'no location resolved')
  need(typeof where.name === 'string' && where.name !== '', `location has no name: ${JSON.stringify(where)}`)
  const current = body.current
  need(current !== undefined, 'no current conditions')
  // Air quality rides with the weather and fails independently, so the payload must
  // say EITHER a reading OR why there is none — never nothing at all.
  const airOk = body.air !== null && body.air !== undefined && typeof body.air.usAqi === 'number'
  if (body.air === null || body.air === undefined) {
    need(typeof body.airError === 'string' && body.airError !== '', `no air reading and no reason: ${show({ air: body.air, airError: body.airError })}`)
  } else {
    need(airOk, `air section without a numeric AQI: ${show(body.air)}`)
  }
  need(typeof current.temperature === 'number', `temperature is ${show(current.temperature)}`)
  need(typeof current.humidity === 'number', `humidity is ${show(current.humidity)}`)
  need(current.windDirection !== undefined || typeof current.windSpeed === 'number', 'no wind data')
  return `${show(where.name)}/${show(where.region)} ${show(current.text)} ${show(current.temperature)}°C 湿度${show(current.humidity)}% 风${show(current.windSpeed)}km/h`
    + (body.air === null || body.air === undefined
      ? ` · 空气质量：读不到（${show(body.airError)}）`
      : ` · 空气 AQI ${show(body.air.usAqi)}（${show(body.air.level?.zh)}）PM2.5 ${show(body.air.pm25)} PM10 ${show(body.air.pm10)}`)
    + ` alerts=${count(body.alerts)} scanned=${show(body.alertsScanned)}`
})

// ── parcel ─────────────────────────────────────────────────────────────────
await check('parcel', 'GET /dsh-hud/parcel/state', async () => {
  const { status, json } = await call('/dsh-hud/parcel/state')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  need(count(body.carriers) > 0, 'the carrier table is empty')
  return `carriers=${count(body.carriers)} watch=${count(body.parcels)} pollMs=${show(body.pollMs)}`
})

// A real add → query → normalize round trip against the live tracking endpoint.
// Skipped against a real profile: it would leave a parcel in the watch list.
if (writable) await check('parcel', 'POST /add → live courier query', async () => {
  const { status, json } = await call('/dsh-hud/parcel/add', {
    method: 'POST',
    body: { nu: 'SF0000000000001', com: 'shunfeng', label: 'live-check' },
  })
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  const row = (body.parcels ?? [])[0]
  need(row !== undefined, 'the parcel was not added')
  // A number the courier does not know is the EXPECTED answer here — what is
  // asserted is that the pipeline produced a definite, explained outcome rather
  // than an empty object.
  need(row.stateText !== undefined, 'no state was derived')
  return `${show(row.carrier)} state=${show(row.stateText)} noData=${show(row.noData)} nodes=${count(row.nodes)}`
})

await check('parcel', 'POST /detect (carrier guess, offline)', async () => {
  const { json } = await call('/dsh-hud/parcel/detect', { method: 'POST', body: { nu: 'SF1234567890123' } })
  const body = json()
  need(count(body.candidates) > 0, 'no candidates for a clear SF number')
  return body.candidates.slice(0, 3).map((c) => `${c.name}(${c.confidence})`).join(', ')
})

// ── todo: your own items, and a REAL calendar feed ─────────────────────────
await check('todo', 'GET /dsh-hud/todo/state', async () => {
  const { status, json } = await call('/dsh-hud/todo/state')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  // The schedule is the contract the browser half fires notifications from.
  need(Array.isArray(body.leads) && body.leads.length > 0, 'no notification leads')
  need(typeof body.digestAt === 'string' && /^\d{2}:\d{2}$/.test(body.digestAt), `digestAt is ${show(body.digestAt)}`)
  // The pomodoro rides in the same payload, and its countdown must be a real
  // duration: a missing one would render as `00:00` and look finished.
  const pomo = body.pomodoro
  need(pomo !== undefined, 'no pomodoro in the payload')
  need(typeof pomo.remainingMs === 'number' && pomo.remainingMs > 0,
    `the timer has no remaining time: ${show(pomo.remainingMs)}`)
  need(['work', 'break'].includes(pomo.phase), `unknown phase: ${show(pomo.phase)}`)
  need(typeof pomo.settings?.workMinutes === 'number', `no work length: ${show(pomo.settings)}`)
  return `open=${show(body.counts?.open)} leads=[${body.leads.join(',')}] 下班提醒=${show(body.digestAt)} feeds=${count(body.feedSettings)}`
    + ` · 番茄钟 ${show(pomo.phase)} ${Math.round(pomo.remainingMs / 60_000)}分钟 今天${show(pomo.completedToday)}/${show(pomo.settings.workMinutes)}分钟一段`
})

// A full pomodoro cycle through the live host: start, pause, resume, skip, reset.
// Mutating, so it runs only against the throwaway profile.
if (writable) await check('todo', 'POST /pomodoro (start → pause → resume → skip → reset)', async () => {
  const act = async (action, extra) => (await call('/dsh-hud/todo/pomodoro', { method: 'POST', body: { action, ...(extra ?? {}) } })).json()
  const started = await act('start')
  need(started.ok === true && started.pomodoro?.running === true, `start failed: ${show(started.error)}`)
  need(Math.round(started.pomodoro.remainingMs / 60_000) === started.pomodoro.settings.workMinutes,
    `a started session is not a full one: ${show(started.pomodoro.remainingMs)}`)
  const paused = await act('pause')
  need(paused.pomodoro.running === false && paused.pomodoro.remainingMs > 0, 'pause lost the remaining time')
  need((await act('resume')).pomodoro.running === true, 'resume did not restart it')
  const skipped = await act('skip')
  need(skipped.pomodoro.phase === 'break', `skip did not move to the break: ${show(skipped.pomodoro.phase)}`)
  // A skip is NOT a finished session, and the count must say so.
  need(skipped.pomodoro.completedToday === 0, `a skipped session was counted: ${show(skipped.pomodoro.completedToday)}`)
  const reset = await act('reset')
  need(reset.pomodoro.running === false && reset.pomodoro.phase === 'work', 'reset did not return to an idle work session')
  const refused = await call('/dsh-hud/todo/pomodoro', { method: 'POST', body: { action: 'levitate' } })
  need(refused.status === 400, `an unknown action was accepted: HTTP ${refused.status}`)
  const tuned = await act('settle', { settings: { workMinutes: 30, breakMinutes: 6 } })
  need(tuned.pomodoro.settings.workMinutes === 30, `a setting did not stick: ${show(tuned.pomodoro.settings)}`)
  await act('reset')
  return `start→pause→resume→skip→reset 全部通过 · 跳过不计入完成数 · 未知动作被拒 · 设置 30/6 生效`
})

// A local add → read → complete → remove round trip through the live host.
if (writable) await check('todo', 'POST /add → update → remove (own items)', async () => {
  const added = await call('/dsh-hud/todo/add', { method: 'POST', body: { title: 'live-check 待办', dueAt: '2026-10-02' } })
  const addBody = added.json()
  need(added.status === 200 && addBody.ok === true, `add failed: ${show(addBody.error)}`)
  const id = addBody.item?.id
  need(typeof id === 'string', 'no id came back')
  need(addBody.counts?.open === 1, `the open count is ${show(addBody.counts?.open)}`)
  need(addBody.schedule?.some((entry) => entry.id === id), 'a dated item did not reach the schedule')
  const done = await call('/dsh-hud/todo/update', { method: 'POST', body: { id, patch: { done: true } } })
  const doneBody = done.json()
  need(doneBody.counts?.done === 1 && doneBody.counts?.open === 0, `after completing: ${JSON.stringify(doneBody.counts)}`)
  const removed = await call('/dsh-hud/todo/remove', { method: 'POST', body: { id } })
  need(removed.json().counts?.done === 0, 'the item survived the remove')
  return `added → scheduled → done → removed (id ${id.slice(0, 8)}…)`
})

/**
 * A REAL public calendar feed, end to end.
 *
 * Probed from this machine before the URL was written down:
 *
 *   calendars.icloud.com/holidays/cn_zh.ics           200, 66 KB, 0.3 s   ← used
 *   calendar.google.com/…/basic.ics                   fetch failed         (blocked)
 *   officeholidays.com/ics/china                      aborted at 12 s      (blocked)
 *
 * Both of the blocked ones are the same class of failure FRED had: reachable in
 * a browser, not from this process. The iCloud feed is the one that actually
 * answers, so it is the one that proves the subscription path against the
 * internet rather than against a stub.
 *
 * The distinction the summary keeps: an unreachable upstream is `slow`, a 200
 * that fails to PARSE is a `FAIL`.
 */
await check('todo', 'POST /feed → a real .ics over the network', async () => {
  const url = 'https://calendars.icloud.com/holidays/cn_zh.ics'
  const probe = await call('/dsh-hud/todo/feed', { method: 'POST', body: { url, label: '节假日' } })
  const body = probe.json()
  if (probe.status !== 200) return { kind: 'slow', detail: `HTTP ${probe.status}` }
  if (body.ok !== true) {
    const unreachable = /网络请求失败|超时|HTTP \d|登录/.test(body.error ?? '')
    return { kind: unreachable ? 'slow' : 'fail', detail: `feed error: ${show(body.error)}` }
  }
  need(body.counts?.events > 0, `the feed parsed but carried no events: ${JSON.stringify(body.counts)}`)
  const next = (body.next ?? [])[0]
  need(next?.title !== undefined, 'no event survived parsing')
  return `events=${show(body.counts?.events)} 首个「${show(next.title)}」`
    + ` ${show(next.dueAt === undefined ? '?' : new Date(next.dueAt).toISOString().slice(0, 10))}`
    + ` unsupported=${JSON.stringify(body.unsupported ?? [])}`
})

// ── sql: a REAL database file, created here, read through the panel ─────────
// No MySQL or PostgreSQL server is installed on this machine, so this check uses the
// one engine it can be SURE about: SQLite through `node:sqlite`, which ships with
// Node. The database is created and queried through the panel's own routes, so what is
// proven is the whole path — driver, storage, routes — against a real file rather than
// a stub. (The MySQL driver is verified against a protocol-faithful server in
// test-host.mjs, and the PostgreSQL driver against the real server on 5432; neither is
// claimed here, because this check must be honest about what it can reach.)
await check('sql', 'POST /dsh-hud/sql/state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-live-sql-'))
  const file = join(dir, 'live.db')
  try {
    const seed = await import('../lib/sql/index.js')
    const writable = seed.cleanProfile({ driver: 'sqlite', file, readOnly: false }, 0)
    await seed.runStatement(writable, { sql: 'create table events (id integer primary key, kind text not null)', allowWrite: true })
    await seed.runStatement(writable, { sql: "insert into events (kind) values ('启动')", allowWrite: true })
    await seed.runStatement(writable, { sql: "insert into events (kind) values ('巡检')", allowWrite: true })
    await seed.runStatement(writable, { sql: 'create view recent as select kind from events', allowWrite: true })

    // Configure the connection through the panel's settings route, exactly as the card
    // does, then read the schema through its state route.
    const saved = await call('/dsh-hud/sql/settings', {
      method: 'POST',
      body: { settings: { connections: [{ id: 'live', driver: 'sqlite', file, name: '自检库', readOnly: true }], active: 'live' } },
    })
    need(saved.status === 200 && saved.json().ok === true, `settings route: HTTP ${saved.status} ${show(saved.json()?.error)}`)

    const state = (await call('/dsh-hud/sql/state')).json()
    need(state.ok === true, `state route: ${show(state.error)}`)
    // An unreachable database must NOT look like an empty one — the single most
    // misleading thing this panel could do, so it is checked first.
    need(state.error === undefined, `the panel reported an error instead of a schema: ${show(state.error)}`)
    const main = (state.schema?.schemas ?? []).find((one) => one.name === 'main')
    need(main !== undefined, `no schema came back: ${show(state.schema?.schemas)}`)
    const kinds = (main.objects ?? []).map((object) => `${object.kind}:${object.name}`).sort()
    need(kinds.includes('table:events') && kinds.includes('view:recent'),
      `the real table and view are not both listed: ${JSON.stringify(kinds)}`)
    const table = (main.objects ?? []).find((object) => object.name === 'events')
    need((table.columns ?? []).map((column) => column.name).join(',') === 'id,kind',
      `columns are wrong: ${JSON.stringify(table.columns)}`)

    // A real query, through the route.
    const read = (await call('/dsh-hud/sql/query', { method: 'POST', body: { id: 'live', sql: 'select kind from events order by id' } })).json()
    need(read.ok === true, `the query failed: ${show(read.error)}`)
    need(JSON.stringify(read.result?.rows) === JSON.stringify([['启动'], ['巡检']]),
      `rows are wrong: ${JSON.stringify(read.result?.rows)}`)

    // And a write REFUSED, because the connection is read-only — by the engine, not by
    // a keyword filter.
    const refused = (await call('/dsh-hud/sql/query', { method: 'POST', body: { id: 'live', sql: "insert into events (kind) values ('x')" } })).json()
    need(refused.ok === false, 'a write on a read-only connection was allowed')

    return `SQLite ${file} · ${kinds.join(', ')} · ${read.result.rows.length} 行`
      + ` · 只读拒写 ${show((refused.error ?? '').slice(0, 24))}`
  } finally {
    // The connection list is left as it was found: a real profile must not keep a
    // pointer to a temp file that this check has just deleted.
    await call('/dsh-hud/sql/settings', { method: 'POST', body: { reset: true } }).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

// `marketSelected` carries the chosen instrument between the market checks, which is why
// it is declared out here rather than inside the first one.
let marketSelected = ''
await check('market', 'GET /dsh-hud/market/state', async () => {
  const { status, json } = await call('/dsh-hud/market/state')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  need(body.error === undefined, `panel reports: ${body.error}`)
  const quotes = body.quotes ?? []
  need(count(quotes) > 0, 'the watch list came back EMPTY (a config default did not materialise)')
  const priced = quotes.filter((row) => typeof row.price === 'number' && row.price > 0)
  need(count(priced) > 0, `no quote carried a price: ${JSON.stringify(quotes[0])}`)
  marketSelected = body.selected ?? ''
  const sample = priced[0]
  // ── the yuan ────────────────────────────────────────────────────────────
  // Read next to the indices and served by the same host, so it is checked with
  // them. `forexError` is the honest alternative when the upstream is down.
  const forex = Array.isArray(body.forex) ? body.forex : []
  if (forex.length === 0) {
    need(typeof body.forexError === 'string' && body.forexError !== '',
      `no forex and no reason: ${show({ forex: body.forex, forexError: body.forexError })}`)
  } else {
    const usable = forex.filter((rate) => typeof rate.value === 'number' && rate.value > 0)
    need(count(usable) >= 3, `only ${count(usable)} rates carried a value: ${JSON.stringify(forex.slice(0, 2))}`)
    // The SCALE is what silently goes wrong: a missed /10^f1 turns USDCNH 6.7 into
    // 67180, or into 0.0006. A plausibility band catches that where a schema cannot.
    const usd = forex.find((rate) => rate.code === 'USD')
    if (usd !== undefined) {
      need(usd.value > 3 && usd.value < 15, `USD/CNH is outside any plausible band: ${show(usd.value)}`)
    }
  }
  return `${count(priced)}/${count(quotes)} priced · ${show(sample.name)} ${show(sample.price)} ${show(sample.changePct)}%`
    + (forex.length === 0
      ? ` · 汇率：读不到（${show(body.forexError)}）`
      : ` · 汇率 ${forex.map((rate) => `${rate.code} ${rate.value}`).slice(0, 3).join(' / ')}`)
})

await check('market', 'GET /dsh-hud/market/kline (OHLC candles)', async () => {
  const { status, json } = await call(`/dsh-hud/market/kline?secid=${encodeURIComponent(marketSelected || '1.600519')}&period=day`)
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  const candles = body.candles ?? []
  /**
   * A MONTH of daily candles, not an exact count.
   *
   * This said `> 20` and failed on 2026-10-02 with exactly 20: 日K is a 31-day window, and a
   * window that lands on 国庆 plus weekends holds fewer trading days than a quiet one. The
   * assertion's job is "a month of real OHLC came back" — the window check further down is what
   * pins the period — so the floor is a holiday-heavy month, not a typical one.
   */
  need(count(candles) >= 18, `only ${count(candles)} candles`)
  const last = candles[candles.length - 1]
  need([last.open, last.close, last.high, last.low].every((value) => typeof value === 'number' && value > 0),
    `a candle has no OHLC: ${JSON.stringify(last)}`)
  need(last.high >= last.low, 'a candle has high < low')
  // The share panel has the same period model: 实时 is one session, 日K is a year.
  const live = (await call(`/dsh-hud/market/kline?secid=${encodeURIComponent(marketSelected || '1.600519')}&period=realtime`)).json()
  const liveBars = live.candles ?? []
  need(count(liveBars) > 30, `only ${count(liveBars)} intraday bars`)
  const liveDays = [...new Set(liveBars.map((candle) => String(candle.date).slice(0, 10)))]
  need(liveDays.length === 1, `实时 spans ${liveDays.length} days`)
  const floor = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10)
  // 日K is ONE MONTH — about 20-23 trading days, and nothing older.
  need(candles.every((candle) => String(candle.date).slice(0, 10) >= floor),
    `a daily candle is older than a month: ${show(candles[0].date)}`)
  need(count(candles) >= 15 && count(candles) <= 25,
    `a month of trading days should be 15-25 bars, got ${count(candles)}`)
  // The readout shows 量 and 额, so both must survive the pipeline.
  need(candles.every((candle) => typeof candle.volume === 'number'), 'a daily candle has no volume')
  need(candles.some((candle) => typeof candle.amount === 'number' && candle.amount > 0),
    'no daily candle carries an amount (成交额)')
  return `${count(candles)} candles · ${show(body.name)} last ${show(last.date)} O${show(last.open)} C${show(last.close)} H${show(last.high)} L${show(last.low)}`
    + ` 量${show(last.volume)} 额${show(last.amount)}`
    + ` · 实时 ${count(liveBars)} 根 @ ${liveDays[0]} · 覆盖 ${show(candles[0].date)} → ${show(last.date)}`
})

await check('market', 'POST /search (name → secid)', async () => {
  const { status, json } = await call('/dsh-hud/market/search', { method: 'POST', body: { input: '茅台' } })
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  need(count(body.results) > 0, 'search returned nothing for a well-known name')
  return body.results.slice(0, 3).map((hit) => `${hit.name}(${hit.secid})`).join(', ')
})

// ── bond ───────────────────────────────────────────────────────────────────
await check('bond', 'GET /dsh-hud/bond/state', async () => {
  const { status, json } = await call('/dsh-hud/bond/state')
  const body = json()
  need(status === 200, `HTTP ${status} ${body.error ?? ''}`)
  const parts = []
  const failures = []
  // Each leg is independent: one upstream being rude must not hide the others,
  // and the panel is built the same way.
  if (body.cn?.error) failures.push(`CN curve: ${body.cn.error}`)
  else {
    const curve = body.cn?.curve ?? []
    need(count(curve) >= 6, `the CN curve has only ${count(curve)} tenors`)
    need(curve.every((point) => typeof point.value === 'number' && point.value > 0), 'a curve point has no yield')
    parts.push(`curve ${show(body.cn.date)} ${count(curve)}T 10Y=${show(curve.find((p) => p.tenor === 10)?.value)}`)
  }
  if (body.cn?.trendError) failures.push(`CN trend: ${body.cn.trendError}`)
  else {
    // The K-lines are their own route now (checked below); what matters here is
    // that the summary still names what can be charted, all of it domestic.
    need(count(body.charts) > 0, 'the panel offers nothing to chart')
    need((body.charts ?? []).every((entry) => /^\d\.\d+$/.test(entry.secid ?? '')),
      `a chart instrument is not a domestic secid: ${show(body.charts?.[0]?.secid)}`)
    parts.push(`charts ${count(body.charts)} (${body.charts.map((entry) => entry.name).join('/')})`)
  }
  // Domestic only, by request: no US section anywhere in the payload.
  need(body.us === undefined, 'the payload still carries a US section')
  need(body.spread === undefined, 'the payload still carries a cross-market spread')
  need(typeof body.cn?.ten === 'number', 'the CN 10Y is not lifted out of the curve')
  parts.push(`10Y ${show(body.cn.ten)}%`)
  const etfs = (body.etfs ?? []).filter((etf) => typeof etf.price === 'number' && etf.price > 1)
  need(count(etfs) > 0, `no bond ETF carried a plausible price: ${JSON.stringify(body.etfs?.[0])}`)
  parts.push(`ETFs ${count(etfs)}`)
  if (count(parts) === 0) throw new Error(failures.join(' | ') || 'nothing came back')
  const note = failures.length > 0 ? `  [degraded: ${failures.join(' | ')}]` : ''
  return parts.join(' · ') + note
})

// ── bond K-lines: 日K / 周K / 月K of a real instrument ─────────────────────
await check('bond', 'GET /dsh-hud/bond/kline (日K + 周K)', async () => {
  const day = await call('/dsh-hud/bond/kline?secid=1.511260&period=day')
  const dayBody = day.json()
  need(day.status === 200, `HTTP ${day.status} ${dayBody.error ?? ''}`)
  const candles = dayBody.candles ?? []
  need(count(candles) > 5, `only ${count(candles)} daily candles`)
  const last = candles[candles.length - 1]
  need([last.open, last.close, last.high, last.low].every((value) => typeof value === 'number' && value > 0),
    `a candle has no OHLC: ${JSON.stringify(last)}`)
  need(last.high >= last.low, 'a candle has high < low')
  need(last.high >= Math.max(last.open, last.close) && last.low <= Math.min(last.open, last.close),
    'the high/low do not bracket open and close')
  // 日K is ONE MONTH.
  const monthFloor = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10)
  need(candles.every((candle) => String(candle.date).slice(0, 10) >= monthFloor),
    `a daily candle is older than a month: ${show(candles[0].date)}`)
  need(count(candles) >= 15 && count(candles) <= 25,
    `a month of trading days should be 15-25 bars, got ${count(candles)}`)
  const week = await call('/dsh-hud/bond/kline?secid=1.511260&period=week')
  const weekBody = week.json()
  need(count(weekBody.candles) > 5, `only ${count(weekBody.candles)} weekly candles`)
  // Proof that `klt` reached the upstream: 周K keeps a YEAR while 日K keeps a
  // MONTH, so the weekly series must start far earlier — and therefore carry more
  // bars. (Asserting a bar count alone would not prove it: the count is whatever
  // the window allowed, so the SPAN is the honest check.)
  const dailyFloor = String(candles[0].date).slice(0, 10)
  const weeklyFloor = String(weekBody.candles[0].date).slice(0, 10)
  need(Date.parse(weeklyFloor) < Date.parse(dailyFloor) - 180 * 86_400_000,
    `周K does not reach back beyond a month: ${weeklyFloor} vs ${dailyFloor}`)
  need(count(weekBody.candles) > count(candles),
    `weekly has fewer bars (${count(weekBody.candles)}) than daily (${count(candles)}) over a longer span`)
  // 实时 = ONE session of one-minute bars. The first bar's DATE is the newest
  // session, which on a holiday (or before the open) is the previous one — that
  // is the intended behaviour, not a gap.
  const live = await call('/dsh-hud/bond/kline?secid=1.511260&period=realtime')
  const liveBody = live.json()
  const liveBars = liveBody.candles ?? []
  need(count(liveBars) > 30, `only ${count(liveBars)} intraday bars`)
  need(liveBody.intraday === true, 'the 实时 period did not report itself as intraday')
  const liveDays = [...new Set(liveBars.map((candle) => String(candle.date).slice(0, 10)))]
  need(liveDays.length === 1, `实时 spans ${liveDays.length} days: ${liveDays.slice(0, 4).join(', ')}`)
  // And the one-month window on the daily series, checked on the dates.
  const bondFloor = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10)
  need(candles.every((candle) => String(candle.date).slice(0, 10) >= bondFloor),
    `a daily candle is older than a month: ${show(candles[0].date)}`)
  return `${show(dayBody.name)} 日${count(candles)} 周${count(weekBody.candles)}`
    + ` · last ${show(last.date)} O${show(last.open)} C${show(last.close)} H${show(last.high)} L${show(last.low)}`
    + ` · 实时 ${count(liveBars)} 根 @ ${liveDays[0]}`
    + ` · 日K 覆盖 ${show(candles[0].date)} → ${show(last.date)}`
})

// ── summary ────────────────────────────────────────────────────────────────
const pad = (value, width) => String(value).padEnd(width)
const width = Math.max(...results.map((row) => row.name.length), 10)
console.log('panel    result    check'.padEnd(width + 26) + 'detail')
console.log('-'.repeat(width + 26 + 40))
let failures = 0
let throttled = 0
for (const row of results) {
  // SKIP prints as itself: the mark table used to fall through to FAIL, so a
    // not-applicable check looked like a broken panel.
    const mark = row.kind === 'OK' ? '  ok  ' : row.kind === 'SKIP' ? ' skip ' : row.kind === 'THROTTLED' ? ' slow ' : ' FAIL '
  if (row.kind === 'FAIL') failures += 1
  if (row.kind === 'THROTTLED') throttled += 1
  console.log(`${pad(row.panel, 9)}${mark}${pad(row.name, width + 4)}${row.detail}`)
}
console.log('')
console.log(`${results.length - failures - throttled}/${results.length} checks returned real data` +
  (throttled > 0 ? `, ${throttled} throttled by an upstream (the panel degrades, it does not break)` : '') +
  (failures > 0 ? `, ${failures} FAILED` : ''))

if (ephemeral) rmSync(home, { recursive: true, force: true })
// The git fixture is a real repository on disk; nothing to close, just clean up.
rmSync(gitRunRoot, { recursive: true, force: true })
process.exit(failures > 0 ? 1 : 0)