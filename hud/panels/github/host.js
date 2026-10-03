// @ts-check
/**
 * dsh-hud — host half of the `github` panel.
 *
 * Every route lives under `/dsh-hud/github/*` and the panel's settings live in
 * `panels.github` of the merged plugin's config. The HUD shell owns the plugin
 * name, the injected services and the entry point (`mount` below).
 *
 * Watches the signed-in user's OWN GitHub repositories and answers one
 * normalized activity feed per repository:
 *
 *   { kind, action, title, detail, actor, at, url, branch?, unread }
 *
 * `kind` is one of `push` / `update` / `branch` / `tag` / `merge` / `pr` /
 * `issue` / `comment` / `release` / `delete` / `fork` / `star` / `wiki` /
 * `member` / `public` / `other` — the labels the card renders.
 *
 * Four design decisions worth knowing before editing:
 *
 * 1. **Only the user's own repositories.** Discovery uses
 *    `GET /user/repos?affiliation=owner`, so organisations a user merely
 *    belongs to never appear; a watch list can only reference a repo that
 *    discovery returned.
 *
 * 2. **The plugin owns its transport.** `github.com` (needed for the device
 *    flow) is unreachable from plenty of networks while `api.github.com` is
 *    not, and DSH's process-wide proxy policy can only be set before launch.
 *    A HUD must not require a restart, so `resolveTransport()` probes
 *    candidates — an explicitly configured proxy, the environment, a local
 *    proxy port, then a direct connection — and caches whichever one can
 *    actually reach github.com. Tunnelling is implemented on `node:net` /
 *    `node:tls` / `node:http` so the plugin stays dependency-free.
 *
 * 3. **The browser drives the cadence.** There is no host timer: each
 *    `GET /dsh-hud/github/state` refreshes upstream data when its cache is older
 *    than `pollMs`, and concurrent callers share one in-flight poll. Closing
 *    every tab therefore stops polling on its own.
 *
 * 4. **Conditional requests everywhere.** Every upstream GET carries the last
 *    `ETag`, and a `304` reuses the cached body — those responses do not count
 *    against the rate limit, which is what makes a 60 s cadence affordable.
 *
 * The watch list, the per-repo read marks and the settings persist to
 * `$DSH_HOME/storages/<storageDomain>/state.json`: `storageDomain` keeps the
 * legacy value on purpose, so state written before the merge is still read.
 *
 * The token lives in the credential ref `GITHUB_TOKEN`; it is read on the host
 * and never sent to the browser.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { PLUGIN_NAME, json, packageVersion, readBody, sameOrigin } from '../../lib/host-kit.js'

/**
 * Panel identity. `id` is both the route segment (`/dsh-hud/github/…`) and the
 * config key (`panels.github`); the shell owns the plugin name and `inject`.
 */
export const id = 'github'
/** Tab position in the HUD card. */
export const order = 20
/** Tab title, per language. */
export const label = { zh: 'GitHub', en: 'GitHub' }
/**
 * Persistence domain — deliberately the LEGACY name. The watch list, the read
 * marks and the settings already live under this domain in
 * `$DSH_HOME/storages/`, and this plugin was renamed from `dsh-github-hud` to
 * `dsh-hud`. Renaming the domain would silently orphan every existing state
 * file, so it must not be "tidied up".
 */
export const storageDomain = 'dsh-github-hud'

/**
 * Pure helpers, exported for a test harness. The shell only reads `id` /
 * `order` / `label` / `storageDomain` / `mount`, so extra exports are inert at
 * runtime.
 */
export const __test = {
  normalizeRuns,
  normalizeReviewSearch,
  normalizeEvent,
  normalizeRelease,
  parseRateLimit,
  normalizeProxyUrl,
  parseEnvText,
  candidateTransports,
  transportLabel,
  probeTransport,
  rawRequest,
  isTransportFailure,
  normalizeFullName,
}

// ── constants ──────────────────────────────────────────────────────────────
const VERSION = packageVersion()
const API_BASE = 'https://api.github.com'
const WEB_BASE = 'https://github.com'
/** Credential ref holding the token. Never leaves the host. */
const TOKEN_REF = 'GITHUB_TOKEN'
/**
 * Default OAuth app for the device flow: GitHub CLI's public client id. It is
 * a *public* identifier (not a secret) with the device flow enabled, which is
 * why the card can offer "sign in with a code" without the user registering an
 * OAuth app first. Anyone may override it in the card's settings, and a
 * personal access token needs no client id at all.
 */
const DEFAULT_CLIENT_ID = '178c6fc778ccc68e1d6a'
/** `repo` is what unlocks private repositories; `read:user` names the account. */
const DEFAULT_SCOPES = 'repo read:user'
const DEFAULT_POLL_MS = 60_000
const MIN_POLL_MS = 20_000
const MAX_POLL_MS = 900_000
const DEFAULT_CAROUSEL_MS = 9_000
const MIN_CAROUSEL_MS = 4_000
const MAX_CAROUSEL_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 3_000
const MAX_TIMEOUT_MS = 60_000
/** Feed length kept per repository. */
const DEFAULT_PER_REPO_LIMIT = 30
/** Repos discovered by the picker (3 pages of 100). */
const MAX_OWN_REPOS = 300
/** Local proxy ports probed when nothing else is configured. */
const LOCAL_PROXY_PORTS = [7890, 7897, 10809, 1080, 8889]
/** How long a resolved transport is trusted before it is probed again. */
const TRANSPORT_TTL_MS = 10 * 60_000
const USER_AGENT = `dsh-hud/${VERSION}`

// ── small helpers ──────────────────────────────────────────────────────────

/** Schemastery wraps volatile values; read through the wrapper when present. */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function safeJson(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `owner/name` or nothing — the only repo identifier the plugin accepts. */
function normalizeFullName(value) {
  if (typeof value !== 'string') return undefined
  const match = /^\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*$/.exec(value)
  return match ? `${match[1]}/${match[2]}` : undefined
}

/**
 * A human-readable message for anything thrown by the transport stack.
 * `net.connect` reports an unreachable proxy as an `AggregateError` whose own
 * `message` is empty — surfacing that verbatim would leave the card with a
 * blank error, so the code and the inner errors are folded in instead.
 */
function messageOf(error) {
  if (error instanceof AggregateError) {
    const inner = [...new Set((error.errors ?? []).map((one) => messageOf(one)).filter(Boolean))]
    if (inner.length > 0) return inner.join('; ')
    return stringOr(error.code, '') || 'connection failed'
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message !== '') return message
  return stringOr(error?.code, '') || (error?.name && error.name !== 'Error' ? String(error.name) : 'unknown error')
}

/** Run `fn` over items with a bounded number of concurrent calls. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

// ── transport: direct, or through an HTTP CONNECT proxy ────────────────────
/**
 * Parse `http://user:pass@host:port`, `host:port` or a bare `host`. Returns
 * `undefined` for anything this plugin cannot tunnel (SOCKS, PAC, unparseable)
 * so the caller can report and skip it rather than fail the whole request.
 */
function normalizeProxyUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const auth =
    url.username !== '' || url.password !== ''
      ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
      : undefined
  return { host: url.hostname, port, auth, label: `${url.hostname}:${port}` }
}

/** Minimal `KEY=VALUE` reader, matching how the launcher snapshots `$DSH_HOME/.env`. */
function parseEnvText(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[match[1]] = value
  }
  return out
}

/**
 * Proxy environment: an exported variable wins, then `$DSH_HOME/.env` — the
 * same precedence DSH's own launcher uses, and the reason a proxy set for the
 * harness is honoured here without any plugin configuration.
 */
function proxyFromEnv() {
  let fileEnv = {}
  try {
    fileEnv = parseEnvText(readFileSync(joinPath(process.env.DSH_HOME || joinPath(homedir(), '.dsh'), '.env'), 'utf8'))
  } catch {
    fileEnv = {}
  }
  const env = { ...fileEnv, ...process.env }
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    const raw = env[key]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const proxy = normalizeProxyUrl(raw)
    if (proxy) return { proxy, source: `env:${key}` }
    // Named but unusable (SOCKS/PAC): report it once and continue probing.
    return { proxy: undefined, source: `env:${key}`, unusable: raw }
  }
  return undefined
}

/**
 * Ordered transport candidates. An explicit `proxy` setting short-circuits the
 * list; `off` pins a direct connection; `auto` prefers the environment, then a
 * direct connection, then the local proxy ports a desktop VPN client listens on.
 */
function candidateTransports(settings) {
  const configured = stringOr(unwrap(settings?.proxy), 'auto')
  const out = []
  if (configured !== 'auto') {
    if (configured === 'off' || configured === 'direct' || configured === '') {
      return [{ kind: 'direct', source: 'config' }]
    }
    const proxy = normalizeProxyUrl(configured)
    if (!proxy) return [{ kind: 'direct', source: 'config:unusable-proxy' }]
    return [{ kind: 'proxy', proxy, source: 'config' }]
  }
  const fromEnv = proxyFromEnv()
  if (fromEnv) {
    if (fromEnv.proxy) out.push({ kind: 'proxy', proxy: fromEnv.proxy, source: fromEnv.source })
    else out.push({ kind: 'unusable', source: fromEnv.source, reason: `unsupported proxy ${fromEnv.unusable}` })
  }
  out.push({ kind: 'direct', source: 'direct' })
  for (const port of LOCAL_PROXY_PORTS) {
    out.push({
      kind: 'proxy',
      proxy: { host: '127.0.0.1', port, auth: undefined, label: `127.0.0.1:${port}` },
      source: 'local-port',
    })
  }
  return out
}

function transportLabel(transport) {
  if (transport.kind === 'direct') return 'direct'
  if (transport.kind === 'unusable') return transport.source
  return `${transport.proxy.label} (${transport.source})`
}

/** Open a CONNECT tunnel; resolves with a plain socket already spliced past the headers. */
function connectTunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error(`proxy ${proxy.label} did not answer in ${timeoutMs}ms`)))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.setTimeout(0)
      const lines = [
        `CONNECT ${target.host}:${target.port} HTTP/1.1`,
        `Host: ${target.host}:${target.port}`,
        'Proxy-Connection: keep-alive',
      ]
      if (proxy.auth) lines.push(`Proxy-Authorization: Basic ${proxy.auth}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 64 * 1024) fail(new Error(`proxy ${proxy.label} sent an oversized handshake`))
        return
      }
      socket.removeListener('data', onData)
      const head = buffer.subarray(0, end).toString('latin1')
      const status = Number(head.split('\r\n')[0].split(' ')[1])
      if (status !== 200) {
        fail(new Error(`proxy ${proxy.label} refused CONNECT (${Number.isFinite(status) ? status : 'no status'})`))
        return
      }
      settled = true
      // Bytes the proxy already sent past the handshake belong to the tunnel.
      const rest = buffer.subarray(end + 4)
      if (rest.length > 0) {
        try {
          socket.unshift(rest)
        } catch {
          /* stream already ended; the request will surface it */
        }
      }
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

function tlsOver(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const wrapped = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] })
    const timer = setTimeout(() => {
      try {
        wrapped.destroy()
      } catch {
        /* already gone */
      }
      reject(new Error(`TLS handshake with ${servername} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    wrapped.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(wrapped)
    })
    wrapped.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function collectResponse(res, resolve) {
  const chunks = []
  res.on('data', (chunk) => chunks.push(chunk))
  const finish = () =>
    resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
  res.on('end', finish)
  res.on('error', finish)
}

/** One request over an already-TLS socket (plain `http` speaks HTTP/1.1 over it). */
function requestOverSocket(socket, { url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        agent: false,
        createConnection: () => socket,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.host, ...headers },
        setHost: false,
      },
      (res) => collectResponse(res, resolve),
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response from ${target.host} in ${timeoutMs}ms`)))
    req.once('error', reject)
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

function directRequest({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port !== '' ? Number(target.port) : 443,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.host, ...headers },
      },
      (res) => collectResponse(res, resolve),
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response from ${target.host} in ${timeoutMs}ms`)))
    req.once('error', reject)
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

/** Redirects are followed manually so a moved repository still answers. */
async function rawRequest(transport, options, redirectsLeft = 3) {
  const res =
    transport.kind === 'proxy' ? await proxiedRequest(transport, options) : await directRequest(options)
  if ([301, 302, 307, 308].includes(res.status) && typeof res.headers.location === 'string' && redirectsLeft > 0) {
    const next = new URL(res.headers.location, options.url).href
    const target = new URL(next)
    if (target.host !== new URL(options.url).host) {
      throw new Error(`refusing to follow a redirect to ${target.host}`)
    }
    return rawRequest(transport, { ...options, url: next, body: res.status === 307 || res.status === 308 ? options.body : undefined }, redirectsLeft - 1)
  }
  return res
}

async function proxiedRequest(transport, options) {
  const target = new URL(options.url)
  const port = target.port !== '' ? Number(target.port) : target.protocol === 'https:' ? 443 : 80
  const timeoutMs = numberOr(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const socket = await connectTunnel(transport.proxy, { host: target.hostname, port }, timeoutMs)
  if (target.protocol !== 'https:') return requestOverSocket(socket, options)
  let secured
  try {
    secured = await tlsOver(socket, target.hostname, timeoutMs)
  } catch (error) {
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
    throw error
  }
  try {
    return await requestOverSocket(secured, options)
  } finally {
    try {
      secured.destroy() // one tunnel per request: no stale socket to reason about
    } catch {
      /* already gone */
    }
  }
}

/**
 * The reachability probe deliberately targets the endpoint the device flow
 * actually uses: `github.com` is blocked or throttled on plenty of networks
 * while `api.github.com` answers normally, and a probe against the API host
 * would happily pick a route that cannot sign anyone in. Any HTTP status
 * counts as reachable — a 404 still proves the request completed.
 */
async function probeTransport(transport, timeoutMs) {
  const res = await rawRequest(transport, {
    url: `${WEB_BASE}/login/device/code`,
    method: 'GET',
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    timeoutMs,
  })
  return res.status > 0
}

function parseRateLimit(headers) {
  const limit = Number(headers?.['x-ratelimit-limit'])
  const remaining = Number(headers?.['x-ratelimit-remaining'])
  const reset = Number(headers?.['x-ratelimit-reset'])
  if (!Number.isFinite(limit) && !Number.isFinite(remaining)) return undefined
  return {
    limit: Number.isFinite(limit) ? limit : undefined,
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    resetAt: Number.isFinite(reset) ? reset * 1000 : undefined,
  }
}

/** Network-level failure — the transport, not the answer, is the problem. */
function isTransportFailure(error) {
  const code = error?.code
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPROTO', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(
      String(code),
    )
  ) {
    return true
  }
  // The messages this module raises itself must classify as transport
  // failures too, or a dead route would never trigger the re-probe + retry.
  return /timeout|timed out|did not answer|no response from|socket hang up|refused CONNECT|TLS handshake|connection failed/i.test(
    messageOf(error),
  )
}

// ── GitHub events → the feed the card renders ──────────────────────────────
/** Labels are resolved on the client; the host ships the stable `kind`. */
const KIND_BY_REF_TYPE = { branch: 'branch', tag: 'tag', repository: 'create' }
const PR_ACTION = { opened: 'opened', closed: 'closed', reopened: 'reopened' }

function actorOf(event) {
  return {
    actor: stringOr(event?.actor?.login, '') || undefined,
    avatar: stringOr(event?.actor?.avatar_url, '') || undefined,
  }
}

function firstLine(text, limit = 120) {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/**
 * Normalize one `GET /repos/{owner}/{repo}/events` entry.
 *
 * Every branch of GitHub's event union that this HUD advertises is handled
 * explicitly; anything else is kept as `other` with its type as the title so a
 * new GitHub event type degrades into a readable row instead of a blank one.
 */
function normalizeEvent(repo, event) {
  const item = {
    id: `evt:${event?.id ?? `${event?.type ?? 'event'}:${event?.created_at ?? ''}`}`,
    kind: 'other',
    action: '',
    title: '',
    detail: '',
    url: stringOr(repo?.url, '') || undefined,
    at: epochMs(event?.created_at),
    ...actorOf(event),
  }
  const payload = event?.payload ?? {}
  const web = stringOr(repo?.url, WEB_BASE)
  const branchOf = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '')

  switch (event?.type) {
    case 'PushEvent': {
      const branch = branchOf(payload.ref)
      const commits = Array.isArray(payload.commits) ? payload.commits : []
      const last = commits[commits.length - 1]
      const head = stringOr(payload.head, '')
      const before = stringOr(payload.before, '')
      const count = Number.isFinite(payload.size) ? payload.size : commits.length
      // "Merge pull request …" is what GitHub's merge button writes: a push
      // carrying it IS a merge, and calling it a plain push would hide that.
      const mergeLike = /^merge (pull request|branch|remote-tracking)/i.test(firstLine(last?.message, 200))
      item.kind = mergeLike ? 'merge' : branch !== '' && branch === repo?.defaultBranch ? 'update' : 'push'
      item.action = mergeLike ? 'merged' : 'pushed'
      // GitHub sometimes ships a PushEvent with no commit list at all (a large
      // or force push) — the branch is then the only thing worth naming.
      item.title = firstLine(last?.message) || (branch !== '' ? `push → ${branch}` : 'push')
      item.detail = count > 0 ? `${count} commit${count === 1 ? '' : 's'}${branch !== '' ? ` · ${branch}` : ''}` : branch
      item.branch = branch || undefined
      item.url =
        head !== '' && before !== '' && !/^0+$/.test(before)
          ? `${web}/compare/${before.slice(0, 7)}...${head.slice(0, 7)}`
          : branch !== ''
            ? `${web}/commits/${branch}`
            : web
      break
    }
    case 'CreateEvent': {
      const refType = stringOr(payload.ref_type, '')
      const ref = stringOr(payload.ref, '')
      item.kind = KIND_BY_REF_TYPE[refType] ?? 'create'
      item.action = 'created'
      item.title = ref || refType || 'created'
      item.detail =
        refType === 'branch'
          ? `new branch${payload.master_branch ? ` from ${payload.master_branch}` : ''}`
          : refType === 'tag'
            ? 'new tag'
            : `new ${refType || 'ref'}`
      item.branch = refType === 'branch' ? ref : undefined
      item.url = ref !== '' ? `${web}/tree/${ref}` : web
      break
    }
    case 'DeleteEvent': {
      const refType = stringOr(payload.ref_type, '')
      const ref = stringOr(payload.ref, '')
      item.kind = 'delete'
      item.action = 'deleted'
      item.title = ref || refType || 'deleted'
      item.detail = `${refType || 'ref'} deleted`
      break
    }
    case 'PullRequestEvent': {
      const pr = payload.pull_request ?? {}
      const merged = payload.action === 'closed' && pr.merged === true
      item.kind = merged ? 'merge' : 'pr'
      item.action = merged ? 'merged' : PR_ACTION[payload.action] ?? String(payload.action ?? '')
      item.title = firstLine(pr.title) || `#${payload.number ?? ''}`
      const head = stringOr(pr.head?.ref, '')
      const base = stringOr(pr.base?.ref, '')
      item.detail = `${head && base ? `${head} → ${base} · ` : ''}PR #${payload.number ?? pr.number ?? ''}`
      item.branch = base || undefined
      item.url = stringOr(pr.html_url, web)
      break
    }
    case 'PullRequestReviewEvent':
    case 'PullRequestReviewCommentEvent': {
      const pr = payload.pull_request ?? {}
      item.kind = 'review'
      item.action = stringOr(payload.action, 'reviewed')
      item.title = firstLine(pr.title) || `PR #${pr.number ?? payload.pull_request?.number ?? ''}`
      item.detail = event.type === 'PullRequestReviewEvent' ? 'review submitted' : 'review comment'
      item.url = stringOr(payload.comment?.html_url, stringOr(pr.html_url, web))
      break
    }
    case 'IssuesEvent': {
      const issue = payload.issue ?? {}
      item.kind = 'issue'
      item.action = stringOr(payload.action, '')
      item.title = firstLine(issue.title) || `#${issue.number ?? ''}`
      item.detail = `issue #${issue.number ?? ''}${item.action ? ` ${item.action}` : ''}`
      item.url = stringOr(issue.html_url, web)
      break
    }
    case 'IssueCommentEvent': {
      const issue = payload.issue ?? {}
      item.kind = 'comment'
      item.action = stringOr(payload.action, 'created')
      item.title = firstLine(issue.title) || `#${issue.number ?? ''}`
      item.detail = `${issue.pull_request ? 'PR' : 'issue'} #${issue.number ?? ''} · ${firstLine(payload.comment?.body, 60) || 'comment'}`
      item.url = stringOr(payload.comment?.html_url, stringOr(issue.html_url, web))
      break
    }
    case 'CommitCommentEvent': {
      item.kind = 'comment'
      item.action = 'created'
      item.title = firstLine(payload.comment?.body) || 'commit comment'
      item.detail = `commit ${String(payload.comment?.commit_id ?? '').slice(0, 7)}`
      item.url = stringOr(payload.comment?.html_url, web)
      break
    }
    case 'ReleaseEvent': {
      const release = payload.release ?? {}
      item.kind = 'release'
      item.action = stringOr(payload.action, 'published')
      item.title = stringOr(release.name, '') || stringOr(release.tag_name, '') || 'release'
      item.detail = `release ${stringOr(release.tag_name, '')}${release.prerelease ? ' · pre-release' : ''}`.trim()
      item.url = stringOr(release.html_url, web)
      break
    }
    case 'ForkEvent': {
      item.kind = 'fork'
      item.action = 'forked'
      item.title = stringOr(payload.forkee?.full_name, 'fork')
      item.detail = 'repository forked'
      item.url = stringOr(payload.forkee?.html_url, web)
      break
    }
    case 'WatchEvent': {
      item.kind = 'star'
      item.action = 'started'
      item.title = '★ new star'
      item.detail = 'repository starred'
      break
    }
    case 'GollumEvent': {
      const page = Array.isArray(payload.pages) ? payload.pages[0] : undefined
      item.kind = 'wiki'
      item.action = stringOr(page?.action, 'updated')
      item.title = stringOr(page?.title, '') || stringOr(page?.page_name, '') || 'wiki page'
      item.detail = 'wiki updated'
      item.url = stringOr(page?.html_url, web)
      break
    }
    case 'MemberEvent': {
      item.kind = 'member'
      item.action = stringOr(payload.action, '')
      item.title = stringOr(payload.member?.login, '') || 'collaborator'
      item.detail = `collaborator ${item.action}`.trim()
      break
    }
    case 'PublicEvent': {
      item.kind = 'public'
      item.action = 'published'
      item.title = 'repository is now public'
      break
    }
    default: {
      item.kind = 'other'
      item.title = stringOr(event?.type, 'event')
      break
    }
  }
  if (item.at === undefined) return null
  return item
}

/** Normalize one `GET /repos/{owner}/{repo}/releases` entry. */
/**
 * `GET /repos/:owner/:repo/actions/runs` → what a card needs.
 *
 * The rule that matters: a run is only "failing" when it has CONCLUDED badly.
 * `status: in_progress` with `conclusion: null` is not a failure, and a naive
 * `conclusion !== 'success'` check reports every running build as broken — which
 * is how a CI badge becomes noise and then gets ignored.
 */
function normalizeRuns(data) {
  const list = Array.isArray(data?.workflow_runs) ? data.workflow_runs : []
  const runs = list.map((run) => ({
    id: numberOr(run?.id, 0),
    name: stringOr(run?.name, '') || stringOr(run?.display_title, '') || 'workflow',
    status: stringOr(run?.status, 'unknown'),
    conclusion: run?.conclusion === null || run?.conclusion === undefined ? undefined : stringOr(run.conclusion, ''),
    branch: stringOr(run?.head_branch, '') || undefined,
    event: stringOr(run?.event, '') || undefined,
    sha: stringOr(run?.head_sha, '').slice(0, 7) || undefined,
    actor: stringOr(run?.actor?.login, '') || undefined,
    at: epochMs(run?.run_started_at ?? run?.created_at ?? run?.updated_at),
    url: stringOr(run?.html_url, '') || undefined,
    attempt: numberOr(run?.run_attempt, 1),
  })).filter((run) => run.id !== 0)
  const running = runs.filter((run) => run.conclusion === undefined && /in_progress|queued|requested|waiting|pending/i.test(run.status))
  const failing = runs.filter((run) => run.conclusion !== undefined && !/success|neutral|skipped/i.test(run.conclusion ?? ''))
  return {
    runs,
    total: numberOr(data?.total_count, runs.length),
    latest: runs[0],
    running: running.length,
    failing: failing.length,
    // The newest run of each name, so three matrix jobs of one workflow do not
    // read as three different pipelines.
    workflows: [...runs.reduce((map, run) => {
      if (!map.has(run.name)) map.set(run.name, run)
      return map
    }, new Map()).values()].slice(0, 4),
  }
}

/**
 * `GET /search/issues?q=is:pr is:open review-requested:@me` → the PRs waiting on
 * a review.
 *
 * `review-requested:@me` needs authentication: unauthenticated it is a 422, not
 * an empty list — which is exactly why the card must not show "0 waiting" for a
 * signed-out panel. The caller reports the error instead.
 */
function normalizeReviewSearch(data) {
  const items = Array.isArray(data?.items) ? data.items : []
  return {
    total: numberOr(data?.total_count, items.length),
    items: items.slice(0, 20).map((item) => ({
      id: numberOr(item?.id, 0),
      number: numberOr(item?.number, 0),
      title: stringOr(item?.title, '') || '(no title)',
      url: stringOr(item?.html_url, '') || undefined,
      // The repository arrives as an API URL in a search result.
      repo: stringOr(item?.repository_url, '').replace(`${API_BASE}/repos/`, '') || undefined,
      author: stringOr(item?.user?.login, '') || undefined,
      draft: item?.draft === true,
      at: epochMs(item?.updated_at ?? item?.created_at),
      labels: (Array.isArray(item?.labels) ? item.labels : []).map((label) => stringOr(label?.name, '')).filter((name) => name !== '').slice(0, 3),
    })).filter((item) => item.id !== 0),
  }
}

function normalizeRelease(repo, release) {
  const at = epochMs(release?.published_at) ?? epochMs(release?.created_at)
  if (at === undefined) return null
  const tag = stringOr(release?.tag_name, '')
  return {
    id: `rel:${release?.id ?? tag}`,
    kind: 'release',
    action: release?.draft === true ? 'drafted' : release?.prerelease === true ? 'prereleased' : 'published',
    title: stringOr(release?.name, '') || tag || 'release',
    detail: `release ${tag}${release?.prerelease === true ? ' · pre-release' : ''}`.trim(),
    url: stringOr(release?.html_url, stringOr(repo?.url, WEB_BASE)),
    at,
    actor: stringOr(release?.author?.login, '') || undefined,
    avatar: stringOr(release?.author?.avatar_url, '') || undefined,
  }
}

// ── panel ──────────────────────────────────────────────────────────────────

/**
 * Register this panel's routes on the HUD's host and return its test handles.
 * @param {import('../../lib/host-kit.js').PanelHost} host
 */
export function mount(host) {
  const ctx = host.ctx
  const storage = host.storage
  const stored = storage.read()

  // Boot defaults come from `panels.github` in the plugin config; the kit has
  // already unwrapped schemastery, so these are plain values.
  const bootConfig = host.config()

  /** Mutable, browser-editable settings; `config` supplies the boot defaults. */
  const settings = {
    pollMs: clamp(numberOr(bootConfig.pollMs, numberOr(stored?.settings?.pollMs, DEFAULT_POLL_MS)), MIN_POLL_MS, MAX_POLL_MS),
    carouselMs: clamp(
      numberOr(bootConfig.carouselMs, numberOr(stored?.settings?.carouselMs, DEFAULT_CAROUSEL_MS)),
      MIN_CAROUSEL_MS,
      MAX_CAROUSEL_MS,
    ),
    timeoutMs: clamp(numberOr(bootConfig.timeoutMs, DEFAULT_TIMEOUT_MS), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    perRepoLimit: clamp(numberOr(stored?.settings?.perRepoLimit, DEFAULT_PER_REPO_LIMIT), 5, 100),
    proxy: stringOr(bootConfig.proxy, stringOr(stored?.settings?.proxy, 'auto')),
    clientId: stringOr(stored?.settings?.clientId, stringOr(bootConfig.clientId, DEFAULT_CLIENT_ID)),
    scopes: stringOr(stored?.settings?.scopes, stringOr(bootConfig.scopes, DEFAULT_SCOPES)),
    // Kept for compatibility with an older browser half that may still send it;
    // the HUD shell now owns the card's real placement, so this value only
    // survives in the state document and changes nothing on screen.
    align: stringOr(stored?.settings?.align, stringOr(bootConfig.align, 'right')),
  }

  /** Watch list: `[{ fullName, addedAt, readAt, muted }]`, newest last. */
  let watched = Array.isArray(stored?.watched)
    ? stored.watched
        .map((row) => ({
          fullName: normalizeFullName(row?.fullName),
          addedAt: epochMs(row?.addedAt) ?? Date.now(),
          // Per-repo read mark, so clearing one repository's badge does not
          // clear every other repository's.
          readAt: epochMs(row?.readAt) ?? 0,
          muted: row?.muted === true,
        }))
        .filter((row) => row.fullName !== undefined)
    : []
  let lastReadAt = epochMs(stored?.lastReadAt) ?? Date.now()

  const persist = () => storage.write({ version: 1, watched, lastReadAt, settings })

  // ── auth ────────────────────────────────────────────────────────────────
  let accountCache = null // { at, account }

  /** The kit owns token reading: it never throws and never leaks the value. */
  const readToken = () => host.credential.resolve(TOKEN_REF)

  /**
   * Store the token through the kit, which prefers the credentials service (it
   * owns the writer lock and hot-reloads) and otherwise patches
   * `$DSH_HOME/.credentials.yaml` atomically, which the same watcher publishes.
   */
  const writeToken = (value) => host.credential.write(TOKEN_REF, value)

  /**
   * Remove the ref through the kit. The line is *deleted*, never blanked: this
   * build treats an empty ref value as a hard error while parsing the file, so
   * writing `REF: ''` would break every other credential in it.
   */
  const removeTokenFromFile = () => host.credential.remove(TOKEN_REF)

  // ── transport resolution ────────────────────────────────────────────────
  /** @type {{ at: number, transport: any, attempts: any[] } | null} */
  let transportCache = null
  let transportInFlight = null

  const resolveTransport = async (force = false) => {
    if (!force && transportCache && Date.now() - transportCache.at < TRANSPORT_TTL_MS) return transportCache
    if (transportInFlight) return transportInFlight
    transportInFlight = (async () => {
      const attempts = []
      for (const candidate of candidateTransports(settings)) {
        if (candidate.kind === 'unusable') {
          attempts.push({ source: candidate.source, label: transportLabel(candidate), ok: false, error: candidate.reason })
          continue
        }
        try {
          await probeTransport(candidate, Math.min(settings.timeoutMs, 10_000))
          attempts.push({ source: candidate.source, label: transportLabel(candidate), ok: true })
          const resolved = { at: Date.now(), transport: candidate, attempts }
          transportCache = resolved
          return resolved
        } catch (error) {
          attempts.push({ source: candidate.source, label: transportLabel(candidate), ok: false, error: messageOf(error) })
        }
      }
      // Nothing reached github.com: keep the best guess (direct) so the card can
      // still show a real error from the actual call instead of a probe failure.
      const fallback = { at: Date.now(), transport: { kind: 'direct', source: 'fallback' }, attempts }
      transportCache = fallback
      return fallback
    })()
    try {
      return await transportInFlight
    } finally {
      transportInFlight = null
    }
  }

  /**
   * Every outbound call goes through here: on a network-level failure the
   * route is re-probed and the request retried, so a proxy that died (or a
   * link that only degraded) heals without a plugin restart. HTTP errors are
   * answers, not transport failures, and are returned as-is.
   */
  const requestWithRetry = async (options, attempts = 3) => {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { transport } = await resolveTransport(attempt > 0)
      try {
        return await rawRequest(transport, options)
      } catch (error) {
        lastError = error
        if (!isTransportFailure(error)) throw error
      }
    }
    throw lastError
  }

  // ── GitHub REST ─────────────────────────────────────────────────────────
  /** `url -> { etag, data }` — the reason a 60 s cadence is affordable. */
  const etagCache = new Map()
  let lastRateLimit = null

  /**
   * One GitHub REST call. A `304` resolves with the cached body; `etagKey`
   * defaults to the URL so every GET becomes conditional on its own.
   */
  const ghRequest = async (pathOrUrl, { token, method = 'GET', body, accept, etagKey, timeoutMs } = {}) => {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`
    const key = etagKey === undefined ? url : etagKey
    const cached = key === null ? undefined : etagCache.get(key)
    const headers = {
      accept: accept ?? 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (method === 'GET' && cached?.etag) headers['if-none-match'] = cached.etag
    if (body !== undefined) headers['content-type'] = 'application/json'

    const res = await requestWithRetry({
      url,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: numberOr(timeoutMs, settings.timeoutMs),
    })

    const rate = parseRateLimit(res.headers)
    if (rate) lastRateLimit = rate
    if (res.status === 304 && cached) {
      return { ok: true, status: 304, data: cached.data, notModified: true, rateLimit: rate }
    }
    const data = safeJson(res.text)
    if (key !== null && method === 'GET' && typeof res.headers.etag === 'string') {
      etagCache.set(key, { etag: res.headers.etag, data })
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      data,
      headers: res.headers,
      rateLimit: rate,
      message: stringOr(data?.message, '') || undefined,
    }
  }

  /** Turn a failed response into something the card can act on. */
  const ghError = (res, what) => {
    if (res.status === 401) return `GitHub rejected the token (401) — sign in again`
    if (res.status === 404) return `${what}: not found (404) — the repository may be renamed or the token lacks access`
    if (res.status === 403 || res.status === 429) {
      const reset = res.rateLimit?.resetAt
      const when = reset ? ` (resets ${new Date(reset).toLocaleTimeString()})` : ''
      if (res.rateLimit?.remaining === 0) return `GitHub rate limit reached${when}`
      return `${what}: access denied (${res.status})${res.message ? ` — ${res.message}` : ''}`
    }
    return `${what}: HTTP ${res.status}${res.message ? ` — ${res.message}` : ''}`
  }

  // ── account & repository discovery ──────────────────────────────────────
  const fetchAccount = async (token, force = false) => {
    if (!force && accountCache && Date.now() - accountCache.at < 10 * 60_000) return accountCache.account
    const res = await ghRequest('/user', { token, etagKey: `/user:${token.slice(-8)}` })
    if (!res.ok) throw Object.assign(new Error(ghError(res, 'account')), { status: res.status })
    const account = {
      login: stringOr(res.data?.login, ''),
      name: stringOr(res.data?.name, '') || undefined,
      avatar: stringOr(res.data?.avatar_url, '') || undefined,
      url: stringOr(res.data?.html_url, '') || `${WEB_BASE}/${stringOr(res.data?.login, '')}`,
      publicRepos: numberOr(res.data?.public_repos, undefined),
      privateRepos: numberOr(res.data?.total_private_repos, undefined),
    }
    accountCache = { at: Date.now(), account }
    return account
  }

  /** Own repositories only — `affiliation=owner` excludes org memberships. */
  const fetchOwnRepos = async (token, force = false) => {
    const key = '/user/repos?affiliation=owner'
    const cached = etagCache.get(key)
    if (!force && cached?.at && Date.now() - cached.at < 5 * 60_000 && Array.isArray(cached.data)) return cached.data
    const out = []
    for (let page = 1; page <= 3; page += 1) {
      const res = await ghRequest(
        `/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=100&page=${page}`,
        { token, etagKey: `${key}&page=${page}` },
      )
      if (!res.ok) throw new Error(ghError(res, 'repository list'))
      const rows = Array.isArray(res.data) ? res.data : []
      for (const row of rows) {
        const fullName = normalizeFullName(row?.full_name)
        if (!fullName) continue
        out.push({
          fullName,
          description: stringOr(row?.description, '') || undefined,
          private: row?.private === true,
          archived: row?.archived === true,
          fork: row?.fork === true,
          stars: numberOr(row?.stargazers_count, 0),
          openIssues: numberOr(row?.open_issues_count, 0),
          language: stringOr(row?.language, '') || undefined,
          defaultBranch: stringOr(row?.default_branch, '') || undefined,
          pushedAt: epochMs(row?.pushed_at),
          url: stringOr(row?.html_url, '') || `${WEB_BASE}/${fullName}`,
        })
        if (out.length >= MAX_OWN_REPOS) break
      }
      if (rows.length < 100) break
    }
    etagCache.set(key, { etag: undefined, data: out, at: Date.now() })
    return out
  }

  // ── per-repository polling ──────────────────────────────────────────────
  /** @type {Map<string, any>} fullName -> last good payload for that repo */
  const repoCache = new Map()

  const pollRepo = async (entry, token) => {
    const fullName = entry.fullName
    const previous = repoCache.get(fullName) ?? {}
    const next = { fullName, ...previous, fetchedAt: Date.now(), error: null }
    const problems = []

    try {
      const meta = await ghRequest(`/repos/${fullName}`, { token })
      if (!meta.ok) problems.push(ghError(meta, fullName))
      else {
        next.meta = {
          fullName,
          description: stringOr(meta.data?.description, '') || undefined,
          private: meta.data?.private === true,
          archived: meta.data?.archived === true,
          fork: meta.data?.fork === true,
          defaultBranch: stringOr(meta.data?.default_branch, 'main'),
          stars: numberOr(meta.data?.stargazers_count, 0),
          forks: numberOr(meta.data?.forks_count, 0),
          openIssues: numberOr(meta.data?.open_issues_count, 0),
          language: stringOr(meta.data?.language, '') || undefined,
          pushedAt: epochMs(meta.data?.pushed_at),
          updatedAt: epochMs(meta.data?.updated_at),
          url: stringOr(meta.data?.html_url, '') || `${WEB_BASE}/${fullName}`,
          ownerAvatar: stringOr(meta.data?.owner?.avatar_url, '') || undefined,
        }
      }
    } catch (error) {
      problems.push(`${fullName}: ${messageOf(error)}`)
    }

    const repoForUrls = next.meta ?? { url: `${WEB_BASE}/${fullName}`, defaultBranch: undefined }

    let events = []
    try {
      const res = await ghRequest(`/repos/${fullName}/events?per_page=100`, { token })
      if (!res.ok) problems.push(ghError(res, `${fullName} events`))
      else if (Array.isArray(res.data)) {
        events = res.data.map((event) => normalizeEvent(repoForUrls, event)).filter(Boolean)
      }
    } catch (error) {
      problems.push(`${fullName} events: ${messageOf(error)}`)
    }

    let releases = []
    try {
      const res = await ghRequest(`/repos/${fullName}/releases?per_page=10`, { token })
      if (!res.ok) {
        // A repository with releases disabled answers 404 here; that is not a
        // failure worth showing, so only real errors are surfaced.
        if (res.status !== 404) problems.push(ghError(res, `${fullName} releases`))
      } else if (Array.isArray(res.data)) {
        releases = res.data.map((release) => normalizeRelease(repoForUrls, release)).filter(Boolean)
      }
    } catch (error) {
      problems.push(`${fullName} releases: ${messageOf(error)}`)
    }

    // Releases appear in the events feed too; the id-keyed merge keeps one row.
    const merged = new Map()
    for (const item of [...events, ...releases]) if (!merged.has(item.id)) merged.set(item.id, item)
    const feed = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, settings.perRepoLimit)

    // Reuse the previous feed when this poll returned nothing at all — a
    // transient 502 must not blank a card that had content a minute ago.
    next.items = feed.length > 0 ? feed : previous.items ?? []
    next.activityAt = next.items[0]?.at

    // ── CI, for the default branch ─────────────────────────────────────────
    // Five runs answers "is it green?" without spending rate limit on history
    // nobody reads in a dock. A repository WITHOUT Actions answers 404, which is
    // a STATE rather than a failure — so it is reported as unavailable WITH the
    // reason, not silently as an empty list.
    try {
      const branch = next.meta?.defaultBranch
      const path = `/repos/${fullName}/actions/runs?per_page=5${branch === undefined ? '' : `&branch=${encodeURIComponent(branch)}`}`
      const runs = await ghRequest(path, { token, etagKey: `ci:${fullName}` })
      if (runs.status === 404) {
        next.ci = { available: false, reason: '仓库没有启用 Actions，或这个 token 读不到' }
      } else if (!runs.ok) {
        problems.push(ghError(runs, `${fullName} CI`))
      } else {
        next.ci = { available: true, ...normalizeRuns(runs.data) }
      }
    } catch (error) {
      problems.push(`${fullName} CI: ${messageOf(error)}`)
    }

    next.error = problems.length > 0 ? problems[0] : null
    next.problems = problems
    repoCache.set(fullName, next)
    return next
  }

  // ── snapshot (single-flight, cache TTL = pollMs) ────────────────────────
  let snapshotCache = { at: 0, data: null }
  let snapshotInFlight = null
  /** The review-request search, kept with the snapshot so a failure is sticky. */
  const reviews = { cache: null }

  const buildSnapshot = async (token) => {
    const { transport, attempts } = await resolveTransport()
    const auth = { status: 'ok', account: null, error: null }
    let account = null
    let ownRepos = []

    if (!token) {
      auth.status = 'missing'
      auth.error = `no ${TOKEN_REF} credential yet`
    } else {
      try {
        account = await fetchAccount(token)
        auth.account = account
      } catch (error) {
        auth.status = isTransportFailure(error) ? 'unreachable' : 'invalid'
        auth.error = messageOf(error)
      }
    }

    let repos = []
    if (auth.status === 'ok') {
      const active = watched.filter((row) => !row.muted)
      repos = await mapLimit(active, 3, (entry) => pollRepo(entry, token))
      // Silence an empty watch list rather than probing GitHub for nothing.
      if (active.length === 0) repos = []
      try {
        ownRepos = await fetchOwnRepos(token)
      } catch {
        ownRepos = []
      }
      // ── review requests ──────────────────────────────────────────────────
      // `review-requested:@me` is an AUTHENTICATED search: signed out it answers
      // 422, not an empty list. So a failure is carried as `error` and the card
      // must not read it as "nothing is waiting for you".
      try {
        const query = 'is:pr is:open review-requested:@me'
        const found = await ghRequest(`/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=20`, {
          token,
          etagKey: 'reviews:@me',
        })
        reviews.cache = found.ok
          ? { ...normalizeReviewSearch(found.data), error: null }
          : { total: 0, items: [], error: ghError(found, '待评审的 PR') }
      } catch (error) {
        reviews.cache = { total: 0, items: [], error: messageOf(error) }
      }
    }

    const watchedNames = new Set(watched.map((row) => row.fullName))
    const unreadFloor = lastReadAt
    const decorated = repos.map((repo) => {
      const row = watched.find((entry) => entry.fullName === repo.fullName)
      // A repository added a minute ago must not report its whole 90-day
      // backlog as unread, so the floor is the newest of the global mark, this
      // repository's own mark, and the moment it was added.
      const floor = Math.max(unreadFloor, row?.readAt ?? 0, row?.addedAt ?? 0)
      const items = (repo.items ?? []).map((item) => ({ ...item, unread: item.at > floor }))
      return {
        fullName: repo.fullName,
        meta: repo.meta ?? null,
        error: repo.error ?? null,
        fetchedAt: repo.fetchedAt,
        unread: items.filter((item) => item.unread).length,
        items,
        // CI has to be carried through this projection as well: fields that are
        // not listed here are DROPPED, and that is how the online check reported
        // "0 of 2 repositories have CI data" for a panel that had just fetched
        // it. The fetch was fine; the payload never mentioned it.
        ci: repo.ci ?? null,
        problems: repo.problems ?? [],
      }
    })

    // Keep the card's carousel order stable: watch-list order, not response order.
    const byName = new Map(decorated.map((repo) => [repo.fullName, repo]))
    const ordered = watched.filter((row) => !row.muted).map((row) => byName.get(row.fullName)).filter(Boolean)

    return {
      ok: true,
      version: VERSION,
      fetchedAt: Date.now(),
      pollMs: settings.pollMs,
      carouselMs: settings.carouselMs,
      align: settings.align,
      transport: { kind: transport.kind, label: transportLabel(transport), source: transport.source, attempts },
      rateLimit: lastRateLimit,
      credentials: [{ ref: TOKEN_REF, present: Boolean(token) }],
      auth,
      client: describeClient(),
      device: deviceState.pending
        ? {
            userCode: deviceState.userCode,
            verificationUri: deviceState.verificationUri,
            expiresAt: deviceState.expiresAt,
            interval: deviceState.interval,
            error: deviceState.error,
          }
        : null,
      settings: { ...settings, tokenRef: TOKEN_REF },
      watched: watched.map((row) => ({ fullName: row.fullName, addedAt: row.addedAt, muted: row.muted })),
      repos: ordered,
      availableRepos: ownRepos.map((repo) => ({ ...repo, watched: watchedNames.has(repo.fullName) })),
      unread: ordered.reduce((sum, repo) => sum + repo.unread, 0),
      // ── what is waiting on ME, rather than on the repositories ──────────
      reviews: reviews.cache ?? { total: 0, items: [], error: null },
      // Failing CI on a watched repository. `available === false` (no Actions,
      // or a token that cannot read them) is a state, not a failure, and is not
      // counted here.
      ciFailing: ordered.filter((repo) => (repo.ci?.failing ?? 0) > 0).length,
      ciRunning: ordered.filter((repo) => (repo.ci?.running ?? 0) > 0).length,
      lastReadAt,
    }
  }

  const snapshot = async (force = false) => {
    const fresh = snapshotCache.data && Date.now() - snapshotCache.at < settings.pollMs
    if (!force && fresh) return snapshotCache.data
    if (snapshotInFlight) return snapshotInFlight
    snapshotInFlight = (async () => {
      const token = await readToken()
      const data = await buildSnapshot(token)
      snapshotCache = { at: Date.now(), data }
      return data
    })()
    try {
      return await snapshotInFlight
    } finally {
      snapshotInFlight = null
    }
  }

  /** The state endpoint, with no GitHub traffic at all. */
  const idleSnapshot = async (error) => {
    const token = await readToken()
    return {
      ok: true,
      version: VERSION,
      fetchedAt: Date.now(),
      pollMs: settings.pollMs,
      carouselMs: settings.carouselMs,
      align: settings.align,
      transport: transportCache ? { kind: transportCache.transport.kind, label: transportLabel(transportCache.transport) } : null,
      rateLimit: lastRateLimit,
      credentials: [{ ref: TOKEN_REF, present: Boolean(token) }],
      auth: { status: token ? 'checking' : 'missing', account: null, error: error ?? null },
      client: describeClient(),
      device: null,
      settings: { ...settings, tokenRef: TOKEN_REF },
      watched: watched.map((row) => ({ fullName: row.fullName, addedAt: row.addedAt, muted: row.muted })),
      repos: [],
      availableRepos: [],
      unread: 0,
      // The SAME SHAPE as the full snapshot, so the card never has to ask which
      // payload it is holding: signed out, `reviews` is an empty list and the CI
      // counts are zero — and `auth.status` says why they are empty.
      reviews: { total: 0, items: [], error: null },
      ciFailing: 0,
      ciRunning: 0,
      lastReadAt,
    }
  }

  // ── device flow (client-driven: the card polls on GitHub's own interval) ─
  const deviceState = { pending: false, deviceCode: null, userCode: null, verificationUri: `${WEB_BASE}/login/device`, expiresAt: 0, interval: 5, error: null }

  const deviceStart = async () => {
    const body = new URLSearchParams({ client_id: settings.clientId, scope: settings.scopes }).toString()
    const res = await requestWithRetry({
      url: `${WEB_BASE}/login/device/code`,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'user-agent': USER_AGENT,
      },
      body,
      timeoutMs: settings.timeoutMs,
    })
    const data = safeJson(res.text)
    if (res.status !== 200 || !data?.device_code) {
      deviceState.pending = false
      const reason = stringOr(data?.error_description, '') || stringOr(data?.error, '') || `HTTP ${res.status}`
      throw new Error(
        res.status === 404 || /not found/i.test(reason)
          ? `GitHub refused the device flow for client id ${settings.clientId} — set your own OAuth app client id (with device flow enabled) in settings`
          : `device flow could not start: ${reason}`,
      )
    }
    deviceState.pending = true
    deviceState.deviceCode = data.device_code
    deviceState.userCode = data.user_code
    deviceState.verificationUri = stringOr(data.verification_uri, `${WEB_BASE}/login/device`)
    deviceState.interval = numberOr(data.interval, 5)
    deviceState.expiresAt = Date.now() + numberOr(data.expires_in, 900) * 1000
    deviceState.error = null
    persist()
    return { ...deviceState }
  }

  const devicePoll = async () => {
    if (!deviceState.pending || !deviceState.deviceCode) return { status: 'idle' }
    if (Date.now() > deviceState.expiresAt) {
      deviceState.pending = false
      deviceState.error = 'the code expired — start again'
      return { status: 'expired', error: deviceState.error }
    }
    const body = new URLSearchParams({
      client_id: settings.clientId,
      device_code: deviceState.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString()
    const res = await requestWithRetry({
      url: `${WEB_BASE}/login/oauth/access_token`,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'user-agent': USER_AGENT,
      },
      body,
      timeoutMs: settings.timeoutMs,
    })
    const data = safeJson(res.text)
    const error = stringOr(data?.error, '')
    if (typeof data?.access_token === 'string' && data.access_token !== '') {
      const token = data.access_token
      // Verify before storing: a token that cannot read /user is of no use here.
      try {
        accountCache = null
        await fetchAccount(token, true)
      } catch (verifyError) {
        deviceState.pending = false
        deviceState.error = `signed in, but the token could not read the account: ${messageOf(verifyError)}`
        return { status: 'error', error: deviceState.error }
      }
      const how = await writeToken(token)
      deviceState.pending = false
      deviceState.deviceCode = null
      deviceState.userCode = null
      deviceState.error = null
      snapshotCache = { at: 0, data: null }
      persist()
      return { status: 'ok', how, scope: stringOr(data?.scope, '') || undefined }
    }
    if (error === 'authorization_pending') return { status: 'pending' }
    if (error === 'slow_down') {
      deviceState.interval = Math.min(deviceState.interval + 5, 60)
      return { status: 'pending', interval: deviceState.interval }
    }
    deviceState.pending = false
    deviceState.error = stringOr(data?.error_description, '') || error || 'sign-in failed'
    return { status: 'error', error: deviceState.error }
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  // `json`, `sameOrigin` and `readBody` come from the host kit (imported at the
  // top of this file) — they were byte-identical local copies before the merge.

  const readJsonBody = async (req) => safeJson(await readBody(req)) ?? {}

  /** A guard shared by every mutating route: POST + same origin. */
  const guard = (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return false
    }
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
      return false
    }
    return true
  }

  /**
   * Why the card may be missing even though this half is running: the browser
   * bundle is composed by the `clientModules` service from the loader entries
   * declaring `dsh.client`. When that composition fails the host stays healthy
   * and only the card is absent, which is invisible from outside — so the state
   * payload carries the answer. The service is read optionally (no `inject`
   * entry), because it is not needed for anything but this report.
   */
  const describeClient = () => {
    let modules
    try {
      modules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
    } catch {
      modules = undefined
    }
    if (!modules || typeof modules.clientPath !== 'function') {
      return { composed: null, reason: 'the client-modules service is not reachable from this plugin' }
    }
    let file
    try {
      file = modules.clientPath(PLUGIN_NAME)
    } catch (error) {
      return { composed: false, reason: messageOf(error) }
    }
    if (!file) {
      return {
        composed: false,
        reason: `client-modules composed no bundle for ${PLUGIN_NAME} — check that package.json declares dsh.client.platform and exports "./client"`,
      }
    }
    const report = { composed: true, file }
    try {
      const info = statSync(file)
      report.bytes = info.size
      report.modifiedAt = info.mtimeMs
    } catch {
      /* the path is still the useful part */
    }
    return report
  }

  const handleState = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    if (req.method === 'HEAD') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    const token = await readToken()
    // Before a token exists there is nothing to poll: answer instantly so the
    // card's first paint is never blocked on a transport probe.
    if (!token && !snapshotCache.data) return json(res, 200, await idleSnapshot())
    try {
      json(res, 200, await snapshot(false))
    } catch (error) {
      const data = snapshotCache.data
      if (data) return json(res, 200, { ...data, errors: [messageOf(error)] })
      json(res, 502, { ok: false, error: messageOf(error) })
    }
  }

  const handleRefresh = async (req, res) => {
    if (!guard(req, res)) return
    try {
      req.resume?.()
    } catch {
      /* no body */
    }
    try {
      snapshotCache = { at: 0, data: null }
      json(res, 200, await snapshot(true))
    } catch (error) {
      json(res, 502, { ok: false, error: messageOf(error) })
    }
  }

  const handleCredential = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const raw = typeof body?.value === 'string' ? body.value.trim() : ''
    if (raw === '' || raw.length > 16_384) return json(res, 400, { ok: false, error: 'bad-token' })
    // Accept the shapes a user actually has on the clipboard.
    const token =
      /(?:^|\s)(?:token\s+)?([A-Za-z0-9_]{20,})$/i.exec(raw.replace(/^authorization:\s*/i, ''))?.[1] ?? raw
    try {
      accountCache = null
      const account = await fetchAccount(token, true)
      const how = await writeToken(token)
      snapshotCache = { at: 0, data: null }
      json(res, 200, { ok: true, how, account: { login: account.login } })
    } catch (error) {
      json(res, 400, { ok: false, error: messageOf(error) })
    }
  }

  const handleLogout = async (req, res) => {
    if (!guard(req, res)) return
    try {
      req.resume?.()
    } catch {
      /* no body */
    }
    try {
      const service = ctx.credentials
      let cleared = false
      // `set`/`unset` are the service's public write pair in this build.
      for (const method of ['unset', 'remove', 'delete', 'clear']) {
        if (typeof service?.[method] === 'function') {
          await service[method](TOKEN_REF)
          cleared = true
          break
        }
      }
      if (!cleared) removeTokenFromFile()
      accountCache = null
      snapshotCache = { at: 0, data: null }
      etagCache.clear()
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  const handleDeviceStart = async (req, res) => {
    if (!guard(req, res)) return
    try {
      req.resume?.()
    } catch {
      /* no body */
    }
    try {
      json(res, 200, { ok: true, ...(await deviceStart()) })
    } catch (error) {
      json(res, 502, { ok: false, error: messageOf(error) })
    }
  }

  const handleDevicePoll = async (req, res) => {
    if (!guard(req, res)) return
    try {
      req.resume?.()
    } catch {
      /* no body */
    }
    try {
      const result = await devicePoll()
      json(res, result.status === 'error' || result.status === 'expired' ? 400 : 200, { ok: result.status !== 'error' && result.status !== 'expired', ...result })
    } catch (error) {
      json(res, 502, { ok: false, status: 'error', error: messageOf(error) })
    }
  }

  const handleDeviceCancel = async (req, res) => {
    if (!guard(req, res)) return
    try {
      req.resume?.()
    } catch {
      /* no body */
    }
    deviceState.pending = false
    deviceState.deviceCode = null
    deviceState.userCode = null
    deviceState.error = null
    json(res, 200, { ok: true })
  }

  const handleRepos = async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const token = await readToken()
    if (!token) return json(res, 200, { ok: true, repos: [], watched: watched.map((row) => row.fullName) })
    try {
      const force = /[?&]refresh=1/.test(String(req.url ?? ''))
      const repos = await fetchOwnRepos(token, force)
      const names = new Set(watched.map((row) => row.fullName))
      json(res, 200, { ok: true, repos: repos.map((repo) => ({ ...repo, watched: names.has(repo.fullName) })) })
    } catch (error) {
      json(res, 502, { ok: false, error: messageOf(error) })
    }
  }

  const handleWatch = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const action = stringOr(body?.action, '')
    const fullName = normalizeFullName(body?.repo)
    if (!fullName) return json(res, 400, { ok: false, error: 'bad-repo' })
    const token = await readToken()

    if (action === 'remove') {
      watched = watched.filter((row) => row.fullName !== fullName)
      repoCache.delete(fullName)
      persist()
      snapshotCache = { at: 0, data: null }
      return json(res, 200, { ok: true, watched: watched.map((row) => row.fullName) })
    }
    if (action !== 'add') return json(res, 400, { ok: false, error: 'bad-action' })
    if (watched.some((row) => row.fullName === fullName)) {
      return json(res, 200, { ok: true, already: true, watched: watched.map((row) => row.fullName) })
    }
    // Only the user's own repositories: the watch list is checked against the
    // discovery endpoint, so a typo (or someone else's repo) cannot be added.
    if (token) {
      try {
        const own = await fetchOwnRepos(token)
        if (own.length > 0 && !own.some((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase())) {
          return json(res, 403, { ok: false, error: `only your own repositories can be watched (${fullName} is not one of them)` })
        }
      } catch {
        /* discovery unavailable: fall through and let polling report the truth */
      }
    }
    watched = [...watched, { fullName, addedAt: Date.now(), muted: false }]
    persist()
    snapshotCache = { at: 0, data: null }
    json(res, 200, { ok: true, watched: watched.map((row) => row.fullName) })
  }

  const handleRead = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const stamp = Date.now()
    const fullName = normalizeFullName(body?.repo)
    if (fullName) {
      // One repository: move only its own mark, leaving the others untouched.
      const row = watched.find((entry) => entry.fullName === fullName)
      if (!row) return json(res, 404, { ok: false, error: 'not-watched' })
      row.readAt = stamp
    } else {
      lastReadAt = stamp
    }
    persist()
    json(res, 200, { ok: true, lastReadAt, repo: fullName ?? null, readAt: stamp })
  }

  const handleSettings = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    if (body?.pollMs !== undefined) {
      settings.pollMs = clamp(numberOr(Number(body.pollMs), settings.pollMs), MIN_POLL_MS, MAX_POLL_MS)
    }
    if (body?.carouselMs !== undefined) {
      settings.carouselMs = clamp(numberOr(Number(body.carouselMs), settings.carouselMs), MIN_CAROUSEL_MS, MAX_CAROUSEL_MS)
    }
    if (body?.perRepoLimit !== undefined) {
      settings.perRepoLimit = clamp(numberOr(Number(body.perRepoLimit), settings.perRepoLimit), 5, 100)
    }
    if (typeof body?.proxy === 'string') settings.proxy = body.proxy.trim() === '' ? 'auto' : body.proxy.trim()
    if (typeof body?.clientId === 'string' && body.clientId.trim() !== '') settings.clientId = body.clientId.trim()
    if (typeof body?.scopes === 'string' && body.scopes.trim() !== '') settings.scopes = body.scopes.trim()
    if (typeof body?.align === 'string' && ['left', 'center', 'right', 'stretch'].includes(body.align)) settings.align = body.align
    persist()
    // A changed proxy invalidates both the route and every cached body.
    transportCache = null
    etagCache.clear()
    snapshotCache = { at: 0, data: null }
    json(res, 200, { ok: true, settings: { ...settings } })
  }

  ctx.effect(() => {
    const dispose = [
      host.route('state', handleState),
      host.route('refresh', handleRefresh),
      host.route('credential', handleCredential),
      host.route('logout', handleLogout),
      host.route('device/start', handleDeviceStart),
      host.route('device/poll', handleDevicePoll),
      host.route('device/cancel', handleDeviceCancel),
      host.route('repos', handleRepos),
      host.route('watch', handleWatch),
      host.route('read', handleRead),
      host.route('settings', handleSettings),
    ]
    return () => {
      for (const off of dispose) {
        try {
          off()
        } catch {
          /* already disposed */
        }
      }
    }
  }, 'dsh-hud/github: routes')

  // Inspection handle for tests: discovery and transport without any HTTP.
  return {
    snapshot: () => snapshot(false),
    watched: () => watched.map((row) => row.fullName),
    resolveTransport: () => resolveTransport(true),
    settings: () => ({ ...settings }),
  }
}