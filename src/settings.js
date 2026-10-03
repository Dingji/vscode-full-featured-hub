// @ts-check
/**
 * dsh-hud — VS Code settings → HUD config.
 *
 * The HUD's host half takes ONE config object and reads each panel's slice out
 * of `config.panels[id]` (see `hud/index.js#panelConfig`). In DSH that object
 * is the plugin's schemastery-backed settings; here it is the `hud.panels`
 * setting verbatim — deliberately the same shape, so a block can be copied
 * between the two tools without editing.
 *
 * Pure on purpose: `vscode` is not touched, so the whole mapping is testable.
 */

'use strict'

/** Defaults for the extension's own settings. */
const DEFAULTS = {
  panels: {},
  retainContext: false,
  notifications: true,
  credentialsFile: '',
  credentialStore: 'dsh',
  statusBar: false,
  dshProfile: '',
  language: 'auto',
  quotaDiscovery: 'chosen',
  rightCard: 'database',
  sshStrictHostKey: false,
}

/** The store targets `hud.credentialStore` accepts. */
const STORES = ['dsh', 'vscode', 'both']

/** The card renders in one of two languages; `auto` resolves to one of them. */
const LANGUAGES = ['auto', 'zh', 'en']

/**
 * The rightmost card is one thing or the other — never both.
 *
 *   database — the SQL card, exactly as upstream ships it
 *   ssh      — an interactive SSH terminal in the same slot
 *
 * The two are the same slot because that is what they are: a connection to
 * something remote, in the corner of the HUD. Two cards would sit there competing
 * for the same columns, and the SSH one would push the database card out of the
 * layout it has always had.
 */
const RIGHT_CARDS = ['database', 'ssh']

/**
 * How the quota card decides which platforms exist.
 *   chosen — only what `hud.panels.quota.subscriptions` lists
 *   auto   — DeepSeek Harness' behaviour: the profile's provider table, the
 *            built-in discovery, and the explicit list on top
 */
const DISCOVERY = ['chosen', 'auto']

/**
 * Normalize a raw settings object.
 * @param {Record<string, unknown>} [raw]
 */
function normalizeSettings(raw = {}) {
  return {
    panels: normalizePanels(raw.panels),
    retainContext: raw.retainContext === true,
    notifications: raw.notifications !== false,
    credentialsFile: typeof raw.credentialsFile === 'string' ? raw.credentialsFile.trim() : '',
    credentialStore: STORES.includes(String(raw.credentialStore)) ? String(raw.credentialStore) : DEFAULTS.credentialStore,
    statusBar: raw.statusBar === true,
    dshProfile: typeof raw.dshProfile === 'string' ? raw.dshProfile.trim() : '',
    language: LANGUAGES.includes(String(raw.language)) ? String(raw.language) : DEFAULTS.language,
    quotaDiscovery: DISCOVERY.includes(String(raw.quotaDiscovery)) ? String(raw.quotaDiscovery) : DEFAULTS.quotaDiscovery,
    rightCard: RIGHT_CARDS.includes(String(raw.rightCard)) ? String(raw.rightCard) : DEFAULTS.rightCard,
    // Off by default, and stated in the card: a self-signed host key is the norm on
    // a box you built yourself, and refusing it by default would be a wall the user
    // cannot get past without editing a file.
    sshStrictHostKey: raw.sshStrictHostKey === true,
  }
}

/**
 * `hud.panels` as the host expects it: an object of plain objects.
 *
 * A slice that is not an object is DROPPED rather than coerced — `panelConfig`
 * would discard it downstream anyway, and dropping it here means the
 * diagnostics command can name it. Arrays count as "not an object": a panel
 * slice is a mapping.
 * @param {unknown} value
 */
function normalizePanels(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  /** @type {Record<string, Record<string, unknown>>} */
  const panels = {}
  for (const [id, slice] of Object.entries(value)) {
    if (slice === null || typeof slice !== 'object' || Array.isArray(slice)) continue
    panels[id] = { ...slice }
  }
  return panels
}

/** Panel ids whose slice was present but unusable — for the diagnostics command. */
function unusablePanelSlices(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
    .filter(([, slice]) => slice === null || typeof slice !== 'object' || Array.isArray(slice))
    .map(([id]) => id)
}

module.exports = { DEFAULTS, STORES, LANGUAGES, DISCOVERY, RIGHT_CARDS, normalizeSettings, normalizePanels, unusablePanelSlices }