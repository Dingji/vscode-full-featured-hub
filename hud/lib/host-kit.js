// @ts-check
/**
 * dsh-hud — host kit.
 *
 * The panel-agnostic half of the plugin. A *panel* is a self-contained feature
 * (subscription quota, GitHub activity, …) that brings its own upstream
 * queries and its own browser component. Everything a panel needs in order to
 * live inside the HUD without knowing how the HUD is mounted lives here:
 *
 *   - same-origin JSON routes, registered under `/dsh-hud/<panel>/<action>`
 *   - the shared credential store (one writer, never two implementations)
 *   - per-panel JSON persistence under `$DSH_HOME/storages/<domain>/`
 *   - bounded request-body reading and origin checks
 *
 * ── the panel contract (host side) ─────────────────────────────────────────
 *
 * `panels/<id>/host.js` exports:
 *
 *   export const id = 'quota'              // route segment + config key
 *   export const order = 10                // tab order in the card
 *   export const label = { zh, en }        // tab title
 *   export const storageDomain = '…'       // optional; defaults to `dsh-hud/<id>`
 *   export function schema(z) { … }        // optional; merged under `panels.<id>`
 *   export function mount(host) { … }      // register routes, return test handles
 *
 * `host` is the object built by {@link createHost}. Panels never touch
 * `ctx.webServer`, `ctx.credentials` or `$DSH_HOME` directly, which is what
 * keeps them independently testable (see `test/host.test.mjs`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath, dirname as dirnamePath } from 'node:path'

/** The package name — also the browser bundle's module-loader id. */
export const PLUGIN_NAME = 'dsh-hud'
/** Every panel route lives under this prefix: `/dsh-hud/<panel>/<action>`. */
export const ROUTE_PREFIX = '/dsh-hud'
/** Largest request body any panel route will read. */
export const MAX_BODY_BYTES = 64 * 1024
/** Largest credential value the drawer will accept. */
export const MAX_SECRET_BYTES = 16 * 1024

// ── small shared helpers ───────────────────────────────────────────────────

/** Schemastery wraps volatile values; read through the wrapper when present. */
export function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * Mark one field live-editable when the resolved schemastery supports it.
 * `.volatile()` is illegal on fields nested inside an ARRAY ("volatile fields
 * require a fixed object path") — the array itself is what gets marked.
 */
export function live(field) {
  return typeof field?.volatile === 'function' ? field.volatile() : field
}

/** `$DSH_HOME`, defaulting to `~/.dsh` exactly like the shipped plugins do. */
export function dshHomeDir() {
  return process.env.DSH_HOME || joinPath(homedir(), '.dsh')
}

/**
 * The plugin's own version, from the package's `package.json`.
 *
 * ONE source of truth for the whole HUD: every panel reports this (payload
 * `version`, user agents). A panel must never hard-code it or re-derive its own
 * path — a panel lives in `panels/<id>/`, so a `new URL('./package.json', …)`
 * from there silently resolves to a file that does not exist and yields
 * `0.0.0` (which is exactly what shipped in the first merge and was caught by
 * probing the live route).
 */
export function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg?.version === 'string' && pkg.version !== '') return pkg.version
  } catch {
    /* not installed as a package (a bare checkout) */
  }
  return '0.0.0'
}

/**
 * Schemastery is a peer of the DSH runtime. Resolution order:
 *  0. an INJECTED factory — `globalThis.__DSH_HUD_TEST_SCHEMASTERY__`. The tool
 *     scripts import the vendored copy, and before this was read the injection
 *     was dead code: `tools/live-check.mjs` set it, `Config` came back undefined,
 *     and every panel in the online check silently ran on DEFAULTS — which is
 *     why a configured target list arrived empty;
 *  1. bare specifier — works when the profile tree hoists it;
 *  2. walk up from this file looking for an installed DSH app tree
 *     (`…/resources/app.asar/dsh/node_modules/@deepseek-ai/schemastery`) —
 *     Electron's patched fs lets a `file://` import read into the asar;
 *  3. give up quietly: defaults only, no generated settings page.
 * @returns {Promise<any|null>}
 */
export async function resolveSchemastery() {
  let bareError = null
  // The injected factory comes first, so a tool script can test the REAL settings
  // tree against the vendored schemastery instead of running on defaults.
  try {
    const injected = /** @type {any} */ (globalThis).__DSH_HUD_TEST_SCHEMASTERY__
    if (typeof injected === 'function') return injected
  } catch {
    /* no injected factory */
  }
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const z0 = mod.default ?? mod
    if (typeof z0 === 'function') return z0
  } catch (error) {
    bareError = error
  }
  const { dirname } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const rel = ['resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs']
  const dirs = [process.env.DSH_APP_DIR, process.execPath ? dirname(process.execPath) : undefined]
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8 && dir; depth++) {
    dirs.push(dir)
    const parent = dirname(dir)
    dir = parent === dir ? undefined : parent
  }
  for (const base of dirs) {
    if (!base) continue
    try {
      const mod = await import(pathToFileURL(joinPath(base, ...rel)).href)
      const z0 = mod.default ?? mod
      if (typeof z0 === 'function') return z0
    } catch {
      // try the next candidate directory
    }
  }
  void bareError
  return null
}

/**
 * ── user settings that live in the panel's own storage ─────────────────────
 *
 * A panel's SCHEMA config (the settings page) is the seed, and its storage holds
 * whatever the user changed from the card. This helper is the one place that
 * decides which wins, so every panel answers the question the same way:
 *
 *     card settings (stored, validated)  >  settings page (schema)  >  default
 *
 * The alternative — writing back into the schema config — is not available: the
 * settings page owns that object and rewrites it from the UI, so a card writing
 * there would be overwritten the next time the page is saved. The card's own
 * storage is the surface the card can actually own.
 *
 * `clean` is the panel's validator: it receives the raw object and must return the
 * CANONICAL one (unknown keys dropped, values clamped). It is applied on the way
 * in AND on the way out, so a hand-edited `state.json` cannot smuggle a value the
 * panel would then act on.
 *
 * @param {any} host
 * @param {{ key?: string, clean: (raw: any) => any, fallback?: () => any }} options
 */
export function panelSettings(host, { key = 'settings', clean, fallback = () => undefined }) {
  const read = () => {
    const stored = host.storage.read()
    const raw = stored?.[key]
    if (raw === undefined || raw === null) {
      // Nothing stored: the settings page (or the panel's default) answers.
      const seed = fallback()
      return seed === undefined ? undefined : clean(seed)
    }
    return clean(raw)
  }
  const write = (patch) => {
    const merged = { ...(read() ?? {}), ...(patch ?? {}) }
    const next = clean(merged)
    const stored = host.storage.read()
    host.storage.write({ ...(stored ?? {}), [key]: next })
    return next
  }
  const clear = () => {
    const stored = host.storage.read()
    const next = { ...(stored ?? {}) }
    delete next[key]
    host.storage.write(next)
  }
  return { read, write, clear }
}

/** `{ read, write, file }` over one panel's `state.json`, written atomically. */
export function stateStore(domain) {
  const dir = joinPath(dshHomeDir(), 'storages', domain)
  const file = joinPath(dir, 'state.json')
  return {
    file,
    /** @returns {Record<string, any>} the parsed object, or `{}` */
    read() {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    },
    /** @returns {boolean} whether the write landed */
    write(value) {
      try {
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        renameSync(tmp, file) // atomic: a reader never sees a half-written file
        return true
      } catch {
        return false
      }
    },
  }
}

/** Credential refs the card's drawer is allowed to write. */
export function isValidRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(ref)
}

/** Bounded request-body reader (2 s cap so a stalled peer cannot pin us). */
export function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(finish, 2000)
    if (typeof req?.on !== 'function') return finish()
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        finish()
        try {
          req.destroy?.()
        } catch {
          /* already gone */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('close', finish)
  })
}

/** True when the request is same-origin, or carries no Origin header at all. */
export function sameOrigin(req) {
  const origin = req?.headers?.origin
  if (!origin) return true
  try {
    const host = req?.headers?.host
    return !host || new URL(origin).host === host
  } catch {
    return false
  }
}

/** One JSON response, always `no-store`. Panels never build headers twice. */
export function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Method guard: `405` unless the request used an allowed verb. */
export function requireMethod(req, res, allowed) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (allowed.includes(method)) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

// ── credentials ────────────────────────────────────────────────────────────

/**
 * Read one credential, degrading to `undefined` for every failure mode.
 * On some builds `resolve()` answers `undefined` instead of `{value}` when the
 * ref is missing — an unguarded `.value` there is a real crash we have seen.
 *
 * ── and it must not be able to HANG ─────────────────────────────────────────
 *
 * The credentials service serialises its operations behind one queue
 * (`await this.operations` in dsh-credentials-local) and takes a file lock when it
 * writes. A single operation that never settles therefore wedges every later
 * `resolve()` for the life of the process — and the panel that calls it waits for
 * ever. Measured, from the card's side: every route that touches a credential stops
 * answering, the browser's 20s fetch abort fires, and the card is left with no state
 * at all — which reads as "my connections are gone" even though the settings file is
 * untouched.
 *
 * So the service is given a deadline. On timeout the FILE is read directly, which is
 * the same fallback used when the service is absent, and the panel keeps working.
 * @returns {Promise<string|undefined>}
 */
export async function resolveCredentialValue(ctx, ref, { deadlineMs = CREDENTIAL_RESOLVE_MS } = {}) {
  if (!ref) return undefined
  try {
    const hit = await withDeadline(ctx.credentials.resolve(ref), deadlineMs)
    const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
    if (value !== '') return value
  } catch {
    /* the service may be absent in another build, or wedged — fall through to the file */
  }
  // The FILE is the fallback, symmetrically with `writeCredential` and
  // `removeCredential`: those two patch `$DSH_HOME/.credentials.yaml` when the
  // service has no writable method, so without this a token could be written and
  // then be invisible to the very panel that wrote it. (The online check with a
  // real profile home is what surfaced it: the token was in the file, every panel
  // still reported "not signed in".)
  return readCredentialFromFile(ref)
}

/** How long the credentials service gets before the file is read instead. */
export const CREDENTIAL_RESOLVE_MS = 5_000

/** …and before a write is patched into the file instead. */
export const CREDENTIAL_WRITE_MS = 5_000

/** Reject a promise that has not settled in time — the timer never holds the process open. */
export function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`凭据服务 ${ms / 1000} 秒没有回应`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * One ref out of `$DSH_HOME/.credentials.yaml`.
 *
 * Deliberately narrow: the line must be `  REF: value` inside the `refs:` block,
 * because a value under `records:` is a different thing. A quoted value is
 * unquoted and `''` is unescaped, matching how `writeCredential` writes it.
 * @returns {string|undefined}
 */
export function readCredentialFromFile(ref) {
  let text
  try {
    text = readFileSync(joinPath(dshHomeDir(), '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inRefs = /^refs:\s*$/.test(line.trim())
      continue
    }
    if (!inRefs) continue
    const match = new RegExp(`^[\\t ]+${ref}:[\\t ]*(.*)$`).exec(line)
    if (match === null) continue
    let value = match[1].trim()
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'")
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    return value === '' ? undefined : value
  }
  return undefined
}

/** Presence flag for the card's drawer — refs only, never values. */
export async function credentialPresent(ctx, ref) {
  return (await resolveCredentialValue(ctx, ref)) !== undefined
}

/**
 * Store a credential. The credentials service is preferred — it owns the
 * cross-process writer lock and hot-reloads; when this build exposes no
 * writable method, `$DSH_HOME/.credentials.yaml` is patched atomically, which
 * the same watcher publishes.
 * @returns {Promise<string>} where it landed (diagnostics only, never the value)
 */
export async function writeCredential(ctx, ref, value) {
  const service = ctx.credentials
  for (const method of ['write', 'set']) {
    if (typeof service?.[method] === 'function') {
      /**
       * WITH A DEADLINE, like the read side.
       *
       * The service serialises its operations behind one queue and locks the file when it
       * writes, so an operation that never settles wedges every later call — and this is the
       * one a person meets while ADDING a connection: the test passes, then 保存 appears to
       * hang for the browser's full 20s and the connection is never stored. On timeout the
       * file is patched below instead, which is the same fallback used when the service has
       * no writable method at all.
       */
      try {
        await withDeadline(service[method](ref, value), CREDENTIAL_WRITE_MS)
        return `credentials.${method}()`
      } catch {
        break
      }
    }
  }
  const file = joinPath(dshHomeDir(), '.credentials.yaml')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    text = 'version: 1\nrecords: {}\nrefs:\n'
  }
  if (!/^\s*refs:/m.test(text)) text += `${text.endsWith('\n') ? '' : '\n'}refs:\n`
  const escaped = value.replace(/'/g, "''")
  const line = `  ${ref}: '${escaped}'`
  const existing = new RegExp(`^[\\t ]*${ref}:[^\\n]*\\n?`, 'm')
  const next = existing.test(text)
    ? text.replace(existing, `${line}\n`)
    : `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`
  // The directory may not exist yet — a fresh `$DSH_HOME`, which is what the SUITE uses and
  // what a first run looks like. Without this the write fails with ENOENT on the temp file,
  // and the answer to the card is "could not store the password" for a reason nobody can see.
  // Found by running the panel's own route against a temporary home.
  mkdirSync(dirnamePath(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file) // atomic: the watcher never sees a half-written file
  return 'credentials.yaml'
}

/**
 * Remove a ref from `$DSH_HOME/.credentials.yaml`. The line is *deleted*,
 * never blanked: this build treats an empty ref value as a hard parse error,
 * so writing `REF: ''` would break every other credential in the file.
 * @returns {Promise<string>} what happened (diagnostics only)
 */
export async function removeCredential(ctx, ref) {
  // Prefer the SERVICE, symmetrically with `writeCredential`. Editing the file
  // behind a live credentials service leaves whatever it has cached still
  // readable, so "log out" would appear to succeed and the secret would still be
  // there — which is exactly what a test caught.
  const service = ctx.credentials
  for (const method of ['remove', 'delete', 'unset']) {
    if (typeof service?.[method] === 'function') {
      // Bounded for the same reason as the write above: a wedged service must not turn
      // "delete this credential" into a request that never answers.
      try {
        await withDeadline(service[method](ref), CREDENTIAL_WRITE_MS)
        return `credentials.${method}()`
      } catch {
        break
      }
    }
  }
  const file = joinPath(dshHomeDir(), '.credentials.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 'credentials.yaml (absent)'
  }
  const next = text.replace(new RegExp(`^[\\t ]*${ref}:[^\\n]*\\n?`, 'm'), '')
  if (next === text) return 'credentials.yaml (unchanged)'
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)
  return 'credentials.yaml'
}

// ── the host a panel is given ──────────────────────────────────────────────

/**
 * @typedef {object} PanelHost
 * @property {any} ctx                 the cordis context
 * @property {string} id               panel id (route segment + config key)
 * @property {string} basePath         `/dsh-hud/<id>`
 * @property {() => Record<string, any>} config  live panel config slice
 * @property {(action: string, handler: Function) => () => void} route
 * @property {(res: any, status: number, body: any) => void} json
 * @property {(req: any) => boolean} sameOrigin
 * @property {(req: any, maxBytes?: number) => Promise<string>} readBody
 * @property {{ resolve: Function, present: Function, write: Function, remove: Function }} credential
 * @property {{ file: string, read: Function, write: Function }} storage
 * @property {(...args: any[]) => void} log
 * @property {(id: string) => any} panel   another panel's mount() handles
 */

/**
 * Build the per-panel host object.
 *
 * @param {object} options
 * @param {any} options.ctx
 * @param {string} options.id
 * @param {string} [options.storageDomain] defaults to `dsh-hud/<id>`
 * @param {() => Record<string, any>} [options.panelConfig]
 * @param {(path: string, handler: Function) => () => void} options.register
 * @param {(message: string, ...rest: any[]) => void} [options.log]
 * @param {Map<string, any>} [options.handles] shared map of mounted panels
 * @returns {PanelHost}
 */
export function createHost({ ctx, id, storageDomain, panelConfig, register, log, handles }) {
  const basePath = `${ROUTE_PREFIX}/${id}`
  return {
    ctx,
    id,
    basePath,
    config: typeof panelConfig === 'function' ? panelConfig : () => ({}),
    route(action, handler) {
      const path = `${basePath}/${String(action).replace(/^\/+/, '')}`
      return register(path, handler)
    },
    json,
    sameOrigin,
    readBody,
    credential: {
      resolve: (ref) => resolveCredentialValue(ctx, ref),
      present: (ref) => credentialPresent(ctx, ref),
      write: (ref, value) => writeCredential(ctx, ref, value),
      remove: (ref) => removeCredential(ctx, ref),
    },
    storage: stateStore(storageDomain || `${PLUGIN_NAME}/${id}`),
    log: typeof log === 'function' ? log : () => {},
    panel: (panelId) => handles?.get(panelId),
  }
}