// @ts-check
/**
 * @dingji_cherubino/dsh-full-featured-hub — host shell.
 *
 * ONE plugin row mounts ONE card, and that card is a *host* for panels. This
 * file is the host half of the host: it owns the plugin identity, the merged
 * settings schema, and the mount/unmount lifecycle, and it hands every panel a
 * {@link import('./lib/host-kit.js').PanelHost} so no panel ever has to touch
 * `ctx.webServer`, `ctx.credentials` or `$DSH_HOME` itself.
 *
 * ── adding a panel ─────────────────────────────────────────────────────────
 *
 *   1. `panels/<id>/host.js`   — export `id`, `order`, `label`, optional
 *                                `storageDomain` / `schema(z)`, and `mount(host)`
 *   2. `panels/<id>/client.js` — export nothing; declare
 *                                `function create<Id>Panel() { … return { id, order, label, Component } }`
 *   3. add it to `PANELS` in `panels/index.js`
 *   4. add it to `CLIENT_PANELS` in `client/register.js`
 *   5. `node tools/build-client.mjs`   (regenerates the single `client.js` bundle)
 *
 * Nothing else in this file needs to change: routes, config namespacing,
 * credential plumbing and teardown are all handled generically below.
 *
 * ── layout on disk ─────────────────────────────────────────────────────────
 *
 *   /dsh-hud/<panel>/<action>   every panel route (panels pick only `<action>`)
 *   panels.<panel>.*            every panel's settings slice (see below)
 *   storages/<domain>/state.json  per-panel persistence
 *
 * ── config namespacing ─────────────────────────────────────────────────────
 *
 * Panel settings live under `panels.<id>` — NOT at the top level — because two
 * panels legitimately want the same field names (`pollMs`, `timeoutMs`, …) and
 * a flat schema would make them fight. Migrating an older profile therefore
 * means nesting the old top-level block one level deeper:
 *
 *   - id: hud            # was: quota-hud / github-hud
 *     name: @dingji_cherubino/dsh-full-featured-hub
 *     config:
 *       panels:
 *         quota:  { …the old dsh-quota-hud config… }
 *         github: { …the old dsh-github-hud config… }
 */

import { PANELS } from './panels/index.js'
import { PLUGIN_NAME, createHost, live, resolveSchemastery, unwrap } from './lib/host-kit.js'

export const name = PLUGIN_NAME

/** Required services: the same-origin route surface and the credential store. */
export const inject = ['webServer', 'credentials']

/** Settings namespace owned by this plugin. */
export const namespace = PLUGIN_NAME

/**
 * Schemastery is optional: without it the plugin still runs on defaults, it
 * just has no generated settings page. A throw while *building* the schema is
 * contained per panel, so one bad panel schema can never cost every panel its
 * settings page.
 */
const z = await resolveSchemastery()

/**
 * Panels whose schema threw while being built, with the error.
 *
 * The per-panel `catch` in `buildConfig` is deliberate — one bad panel must not
 * cost the others their settings page — but a SILENT catch is how a missing
 * import made a whole panel disappear from the settings page with nothing in the
 * console to say so. So the failure is recorded here, logged by `apply()`, and
 * asserted by `tools/test-config.mjs`, which is what actually caught it.
 *
 * Declared ABOVE `Config` and `__test` on purpose: `export const` is read at
 * module evaluation, and referencing a `const` declared below it is a TDZ crash
 * that `node --check` cannot see.
 * @type {Array<{ id: string, error: Error }>}
 */
const schemaFailures = []

/**
 * Keys that were dropped because they arrived as schemastery NODES rather than
 * values, per panel. Logged once by `apply()` — a silently ignored setting is
 * exactly the kind of thing this project refuses to ship.
 * @type {Map<string, string[]>}
 */
const configWarnings = new Map()

export const Config = buildConfig(z)

/** Test-only handles (the loader only reads name/apply/inject/Config). */
export const __test = { buildConfig, PANELS, resolveSchemastery, schemaFailures }

/**
 * Compose ONE settings schema out of every panel's own.
 * @param {any} z the resolved schemastery factory, or `null`
 */
function buildConfig(z) {
  if (!z) return undefined
  try {
    /** @type {Record<string, any>} */
    const panels = {}
    for (const panel of PANELS) {
      if (typeof panel.schema !== 'function') continue
      try {
        const built = panel.schema(z)
        if (built) panels[panel.id] = built
      } catch (error) {
        // this panel keeps working on defaults; the others keep their page
        schemaFailures.push({ id: panel.id, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    return z.object({
      // NOT `.volatile()` on this object, and that is load-bearing.
      //
      // The loader's schema builder walks the tree and throws
      //   "<path>: volatile fields require a fixed object path without an
      //    enclosing volatile field"
      // for any volatile field nested inside another volatile one. Marking
      // `panels` volatile would therefore reject every panel that marks its
      // OWN leaves volatile — i.e. exactly the panels that want live settings.
      //
      // So liveness is declared one level down, by each panel, where the rule
      // allows it: editing `panels.quota.cacheMs` applies live; editing
      // `panels.github.*` (no schema) never did and still goes through the
      // panel's own `/settings` route.
      panels: z.object(panels),
    })
  } catch {
    return undefined
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  /** Self-diagnostics, filterable in the console with `hud`. */
  const log = (...args) => {
    try {
      console.log('[hud]', ...args)
    } catch {
      /* console unavailable */
    }
  }

  /** Live `mount()` handles, keyed by panel id — readable via `host.panel(id)`. */
  const handles = new Map()

  // A panel that lost its settings page must say so out loud: silently falling
  // back to defaults is how a missing import stayed invisible.
  for (const failure of schemaFailures) {
    log(`panel "${failure.id}" has no settings page: ${failure.error.message}`)
  }

  /**
   * Is this a plain data object, as opposed to a schemastery NODE?
   *
   * A node is an object too, and reading `.timeoutMs` off one yields another
   * node — which is how `请求超时（[object Object] ms）` reached a user-facing
   * error message. Nodes carry a `type` plus a `meta`, which is what is checked.
   */
  const isPlainValue = (value) => {
    if (value === null || typeof value !== 'object') return true
    if (Array.isArray(value)) return value.every(isPlainValue)
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    if (typeof value.type === 'string' && value.meta !== undefined) return false
    return Object.values(value).every(isPlainValue)
  }

  /**
   * The live config slice for one panel. Read on every call (never cached) so
   * a settings edit is picked up by the very next poll.
   *
   * Only PLAIN data is handed over: a panel must never have to ask whether the
   * value it just read is a number or a schema node.
   * @param {string} id
   */
  const panelConfig = (id) => {
    const own = unwrap(config)
    const all = unwrap(own?.panels)
    const slice = unwrap(all?.[id])
    if (slice === null || typeof slice !== 'object' || Array.isArray(slice)) return {}
    const plain = {}
    const dropped = []
    for (const [key, value] of Object.entries(slice)) {
      if (isPlainValue(value)) plain[key] = value
      else dropped.push(key)
    }
    if (dropped.length > 0) configWarnings.set(id, dropped)
    return plain
  }

  const disposers = []

  /**
   * Report a dropped setting once its panel has actually been read.
   *
   * The read happens later (panels read config on every poll), so this is
   * checked on a timer instead of at mount: a key that is never read is a key
   * nobody is missing.
   */
  const warningTimer = setInterval(() => {
    for (const [id, keys] of [...configWarnings]) {
      log(`panel "${id}": ignoring ${keys.join(', ')} — the value is a schema node, not data`)
      configWarnings.delete(id)
    }
  }, 3_000)
  if (typeof warningTimer.unref === 'function') warningTimer.unref()
  disposers.push(() => clearInterval(warningTimer))

  /**
   * Register one panel route. The path is always `${ROUTE_PREFIX}/<panel>/…`,
   * so panels choose only the last segment and collisions are impossible.
   */
  const register = (path, handler) => {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
    disposers.push(dispose)
    return dispose
  }

  ctx.effect(() => {
    for (const panel of PANELS) {
      if (typeof panel.mount !== 'function') continue
      const host = createHost({
        ctx,
        id: panel.id,
        storageDomain: panel.storageDomain,
        panelConfig: () => panelConfig(panel.id),
        register,
        log,
        handles,
      })
      try {
        handles.set(panel.id, panel.mount(host))
        log(`panel "${panel.id}" mounted at ${host.basePath}/*`)
      } catch (error) {
        // One panel failing must not take the HUD (or the other panels) down.
        log(`panel "${panel.id}" failed to mount:`, error)
      }
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
      handles.clear()
    }
  }, `${PLUGIN_NAME}: panels`)

  // Inspection handle: lets a test assert which panels mounted, and reach a
  // panel's own handles, without a single network call.
  return {
    panels: () => [...handles.keys()],
    panel: (id) => handles.get(id),
  }
}