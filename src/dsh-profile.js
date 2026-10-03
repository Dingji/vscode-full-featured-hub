// The DSH side of the loader contract, read from disk.
//
// Why this exists
// ---------------
// The quota card's `Account balance` is a carousel: one platform on screen at a
// time, with a row of dots to pick another — and the dots only appear when more
// than one row was DISCOVERED. Rows come from three sources, and one of them is
// the live `llm-pi-ai` plugin's `providers` table, which the panel reads through
// `ctx.loader.entries()`. A VS Code extension has no DSH runtime to ask, so
// without this the table is empty: a user with keys for three platforms sees
// one, and the card's own picker never renders.
//
// How DSH composes that table
// ---------------------------
// `@deepseek-ai/dsh-llm-pi-ai` declares `providers: z.dict(profile).default({})`
// — the plugin ships NO default providers — and a profile layer overrides it:
//
//     <dsh home>/profiles/<profile>/package.json      which bundles are loaded
//     <dsh home>/profiles/<profile>/cordis.patch.yml  id-targeted config overrides
//
// So the effective table is the patch layer, and that is what is read here.
// Nothing is interpreted: entries are handed over in the shape the loader would
// have produced, and the panel's own `loaderEntryConfig` decides what to make of
// them.

'use strict'

const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const YAML = require('yaml')

const PATCH_FILENAME = 'cordis.patch.yml'
const PROFILES_DIR = 'profiles'
/** The panel re-reads this on every poll; re-parsing a small YAML per poll is
 * wasteful, and a stale-by-two-seconds table is indistinguishable in use. */
const CACHE_MS = 2_000

/** Probes for the locale plugin, whose `preference` the card renders in. */
const LOCALE_SOURCES = ['locale', '@deepseek-ai/dsh-client-locale']

/**
 * One patch entry → the shape `loaderEntryConfig` probes: it matches on
 * `options.id` / `options.name`, skips `disabled`, and reads `fiber.config`.
 * @param {any} raw
 */
function toEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (id === '' && name === '') return null
  const config = raw.config !== null && typeof raw.config === 'object' ? raw.config : {}
  return { options: { id, name }, disabled: raw.disabled === true, fiber: { config } }
}

/**
 * A patch file is a top-level array of loader patch entries. Besides an
 * id-targeted override, an entry may be an `insert` list of whole new entries —
 * those are entries too, and dropping them would hide every plugin a profile
 * adds rather than overrides.
 * @param {any} document
 * @returns {Array<Record<string, any>>}
 */
function entriesFromDocument(document) {
  if (!Array.isArray(document)) return []
  const out = []
  for (const item of document) {
    const direct = toEntry(item)
    if (direct !== null) out.push(direct)
    if (Array.isArray(item?.insert)) {
      for (const inserted of item.insert) {
        const entry = toEntry(inserted)
        if (entry !== null) out.push(entry)
      }
    }
  }
  return out
}

/**
 * @param {{ dshHome: string, name?: string, log?: (line: string) => void }} options
 */
function createDshProfile({ dshHome, name = '', log = () => {} }) {
  /** @type {{ at: number, profile: string | null, entries: Array<Record<string, any>>, error: string | null, source: string | null }} */
  let cache = { at: 0, profile: null, entries: [], error: null, source: null }

  const profilesRoot = () => join(dshHome, PROFILES_DIR)

  /**
   * The most recently edited profile, or the named one. A profile with no patch
   * file is not a candidate for auto-detection: it has nothing to contribute.
   * @returns {string | null}
   */
  function chooseProfile() {
    if (name !== '') return existsSync(join(profilesRoot(), name, PATCH_FILENAME)) ? name : null
    let candidates = []
    try {
      candidates = readdirSync(profilesRoot(), { withFileTypes: true })
    } catch {
      return null
    }
    let best = null
    for (const entry of candidates) {
      if (!entry.isDirectory()) continue
      let at = 0
      try {
        at = statSync(join(profilesRoot(), entry.name, PATCH_FILENAME)).mtimeMs
      } catch {
        continue
      }
      // Newest wins; the name breaks ties so the choice is never arbitrary.
      if (best === null || at > best.at || (at === best.at && entry.name < best.name)) best = { name: entry.name, at }
    }
    return best === null ? null : best.name
  }

  function reload() {
    const profile = chooseProfile()
    const source = profile === null ? null : join(profilesRoot(), profile, PATCH_FILENAME)
    let entries = []
    let error = null
    if (source !== null) {
      try {
        entries = entriesFromDocument(YAML.parse(readFileSync(source, 'utf8')))
      } catch (cause) {
        // A profile may use `!!js` expressions, which a plain parse rejects.
        // Say so rather than reporting an empty table as if it were the truth.
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    cache = { at: Date.now(), profile, entries, error, source }
    if (error !== null) log(`dsh profile ${String(profile)} could not be read: ${error}`)
    return cache
  }

  /** @param {boolean} [force] */
  function current(force = false) {
    if (force || cache.at === 0 || Date.now() - cache.at >= CACHE_MS) return reload()
    return cache
  }

  return {
    /** The configured profile name ('' = auto-detect), read by the extension. */
    name,
    /** Which profile was read, and from where — for diagnostics. */
    describe() {
      const state = current()
      return {
        profile: state.profile,
        source: state.source,
        entries: state.entries.length,
        error: state.error,
      }
    },
    /**
     * The loader contract. Never throws: the panel calls this while polling, and
     * a missing or unreadable profile means "no entries", not a broken card.
     * @returns {Array<Record<string, any>>}
     */
    entries() {
      try {
        return current().entries
      } catch (cause) {
        log(`dsh profile entries failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        return []
      }
    },
    /**
     * The UI language DSH is configured to use (`@deepseek-ai/dsh-client-locale`
     * → `config.preference`), or null.
     *
     * This is the card's OWN language input: `pickLocale()` in the shell reads
     * `document.documentElement.lang`, and the DSH locale plugin is what sets
     * that in DSH. A VS Code window says nothing about which language you want
     * the HUD in, so the profile is the honest source.
     * @returns {string | null}
     */
    locale() {
      try {
        for (const probe of LOCALE_SOURCES) {
          for (const entry of current().entries) {
            if (entry.disabled) continue
            if (entry.options.id !== probe && entry.options.name !== probe) continue
            const preference = entry.fiber?.config?.preference
            if (typeof preference === 'string' && preference.trim() !== '') return preference.trim()
          }
        }
      } catch {
        /* an unreadable profile simply has no opinion */
      }
      return null
    },
  }
}

module.exports = { createDshProfile, entriesFromDocument, toEntry, PATCH_FILENAME, LOCALE_SOURCES }