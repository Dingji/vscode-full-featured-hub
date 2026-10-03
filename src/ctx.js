// @ts-check
/**
 * dsh-hud — the cordis context adapter.
 *
 * `hud/index.js` is a DSH plugin: it expects a cordis `ctx` carrying the
 * `webServer` and `credentials` services and an `effect()` scope. Everything
 * else in the host tree — `lib/host-kit.js`, `lib/imap.js`, `lib/sql/*` and
 * all nine `panels/<id>/host.js` — only ever reaches the context through the
 * per-panel `host` object that `lib/host-kit.js#createHost` builds on top of
 * those three, which is what makes this adapter small.
 *
 * The shape below is deliberately the same one the vendor's own host suite
 * mounts (`hud/tools/test-host.mjs#mockContext`), so "works against the test
 * context" and "works in VS Code" are the same statement:
 *
 *   routes       Map<path, { kind, handler }>   ← the in-process route table
 *   credentials  { resolve, present, write, remove }
 *   webServer    { register({ kind, path, handler }) → dispose }
 *   loader       { entries: () => [] }          ← see below
 *   effect(cb)   → dispose
 *
 * `loader` is not a stub any more. The quota card discovers the platforms it
 * can show through `ctx.loader.entries()` — it reads the live `llm-pi-ai`
 * plugin's `providers` table out of it — so returning `[]` meant a user with
 * keys for three platforms saw one, and the card's own platform picker (a row
 * of dots, rendered only when more than one row was discovered) never appeared.
 * `./dsh-profile` reads that table off disk instead. It is the only consumer:
 * nothing else in the host tree touches `ctx.loader`.
 */

'use strict'

const { RouteTable } = require('./router')

/**
 * @param {object} options
 * @param {import('./credentials').CredentialStore} options.credentials
 * @param {(message: string, ...rest: unknown[]) => void} [options.log]
 * @param {{ entries: () => Array<Record<string, any>> }} [options.loader]
 * @param {() => Set<string>} [options.hidden] credential refs to keep from the panels
 */
function createHudContext({ credentials, log, loader, hidden }) {
  const table = new RouteTable()
  const logger = typeof log === 'function' ? log : () => {}
  /** Read live: a settings change must land on the next poll, not a restart. */
  const suppressed = (ref) => {
    try {
      return hidden !== undefined && hidden().has(ref)
    } catch {
      return false
    }
  }

  /**
   * `ctx.credentials` — the DSH credentials service, backed by the same
   * document DSH itself manages. `write` and `remove` are what make the kit
   * prefer this over patching the YAML file by hand; `present` is what a panel
   * asks when it only needs to know whether a secret exists.
   */
  const credentialsService = {
    async resolve(ref) {
      if (suppressed(ref)) return undefined
      try {
        const hit = await credentials.resolve(ref)
        return hit === undefined ? undefined : { value: hit.value, source: hit.source }
      } catch (error) {
        // host-kit treats a throwing service as "absent" and falls back to the
        // file; surfacing the reason here is what makes a broken document
        // visible in the output channel instead of silent.
        logger(`credentials.resolve(${ref}) failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
    async present(ref) {
      if (suppressed(ref)) return false
      try {
        return Boolean(await credentials.resolve(ref))
      } catch {
        return false
      }
    },
    async write(ref, value) {
      return credentials.write(ref, value)
    },
    async remove(ref) {
      return credentials.remove(ref)
    },
  }

  return {
    /** The route table, for the RPC dispatcher and the diagnostics command. */
    table,
    routes: table.routes,
    credentials: credentialsService,
    webServer: table.service,
    /**
     * `ctx.loader` — the DSH loader, as far as this host can honestly stand in
     * for it. Read from the profile's own patch layer, in the shape the loader
     * would have produced, and never throwing: the panel calls this while
     * polling, and an unreadable profile means "no entries", not a broken card.
     */
    loader: {
      entries: () => {
        try {
          return loader?.entries() ?? []
        } catch (error) {
          logger(`loader.entries() failed: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      },
    },
    /**
     * `ctx.effect(callback)` — DSH runs the callback and keeps its disposer.
     * The same contract, minus the cordis scope.
     */
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
    logger: logger,
  }
}

module.exports = { createHudContext }