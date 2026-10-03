// @ts-check
/**
 * dsh-hud — managing the SQL panel's connections from the command palette.
 *
 * The CARD already does all of this: `＋ 连接` opens a form that tests before it
 * saves, and the ⚙ lists the connections with a delete button beside each and a
 * field form for the active one. So this module is not a second implementation —
 * it is the same operations, reachable from a place people actually look, and it
 * goes through the panel's OWN routes so validation and storage stay one thing:
 *
 *   GET  /dsh-hud/sql/settings        read the connection list (+ pollMs)
 *   GET  /dsh-hud/sql/state           the driver list, with each driver's fields
 *   POST /dsh-hud/sql/test            try an unsaved connection
 *   POST /dsh-hud/sql/settings        write it back
 *
 * The fields are NOT hardcoded here. The host exports them per driver
 * (`drivers[].fields`, from `lib/sql/contract.js#DRIVER_SPECS`), which is what
 * lets the card render a form without knowing one driver from another — so this
 * reads the same list and a new driver or field appears here for free.
 *
 * Pure on purpose: no `vscode`, no network, so the coercions and the list edits
 * are testable on their own.
 */

'use strict'

const { MAX_CONNECTIONS, nextId, replaceById, removeById, refName } = require('./connection-list')

/**
 * One line describing a connection, for a picker.
 * @param {Record<string, any>} entry
 */
function describe(entry) {
  const target = entry?.driver === 'sqlite'
    ? (entry?.file || '(no file)')
    : `${entry?.host ?? ''}:${entry?.port ?? ''}${entry?.database === undefined || entry.database === '' ? '' : `/${entry.database}`}`
  const readOnly = entry?.readOnly === false ? 'writable' : 'read-only'
  return `${target} · ${readOnly}`
}

/**
 * The default value a field starts on, from the driver spec and the panel's own
 * defaults — the same numbers `cleanProfile` would apply.
 * @param {Record<string, any>} spec a `drivers[]` entry
 * @param {Record<string, any>} [entry] the connection being edited
 * @param {string} key
 */
function currentValue(spec, entry, key) {
  if (entry !== undefined && entry[key] !== undefined) return entry[key]
  if (key === 'port') return spec?.defaultPort === 0 || spec?.defaultPort === undefined ? undefined : spec.defaultPort
  if (key === 'host') return '127.0.0.1'
  return undefined
}

/**
 * Coerce one typed answer into the value the connection should carry.
 *
 * Returns `{ error }` rather than a value when the answer cannot be used, so the
 * caller can re-ask instead of writing something the driver will reject at
 * connect time.
 * @param {{ key: string, kind?: string, label?: string }} field
 * @param {string} raw
 * @param {{ numbers: boolean }} options `numbers` is false when the answer came from a picker
 * @returns {{ value?: any, error?: string }}
 */
function coerceField(field, raw, { numbers }) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (field.kind === 'toggle') {
    if (text === '' ) return { value: undefined }
    if (/^(true|1|yes|y|是|开)$/i.test(text)) return { value: true }
    if (/^(false|0|no|n|否|关)$/i.test(text)) return { value: false }
    return { error: `${field.label ?? field.key} 只能是「是」或「否」` }
  }
  if (field.kind === 'number') {
    if (text === '') return { value: undefined }
    if (!numbers) return { error: `${field.label ?? field.key} 需要一个数字` }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return { error: `${field.label ?? field.key} 需要一个数字` }
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      return { error: `${field.label ?? field.key} 需要是 1..65535 之间的整数` }
    }
    return { value: Math.round(parsed) }
  }
  if (text === '') return { value: undefined }
  if (text.length > 400) return { error: '内容过长' }
  return { value: text }
}

/**
 * A brand-new connection for a driver: the id the panel would generate, the
 * driver's own defaults, and read-only ON — because "I did not think about it"
 * must not mean "sure, drop it", which is the rule the panel states too.
 * @param {Record<string, any>} spec
 * @param {Array<Record<string, any>>} connections
 */
function blank(spec, connections) {
  const id = nextId(connections)
  /** @type {Record<string, any>} */
  const entry = { id, driver: spec?.id ?? 'sqlite', name: id, readOnly: true }
  for (const field of spec?.fields ?? []) {
    const value = currentValue(spec, undefined, field.key)
    if (value !== undefined) entry[field.key] = value
  }
  return entry
}

/**
 * Which password credential a connection should carry, and whether one is
 * needed at all. `sqlite` needs none, and a connection with no user (a
 * password-less server) does not either — asking for a secret nobody will use is
 * how people learn to ignore the prompt.
 * @param {Record<string, any>} entry
 */
function needsPassword(entry) {
  if (entry?.driver === 'sqlite') return false
  return typeof entry?.user === 'string' && entry.user !== ''
}

/**
 * The credential ref the panel would generate for a connection id, sanitised the
 * way `lib/sql/index.js#toCredentialRef` sanitises it. Hyphens are not merely
 * unreadable to the credential store — the pattern is
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`, and a name outside it makes the credentials
 * plugin fail to LOAD, which stops DSH from starting.
 * @param {string} id
 */
function credentialRefFor(id) {
  return refName('hud_sql', id, 'credential')
}

module.exports = {
  MAX_CONNECTIONS,
  nextId,
  describe,
  currentValue,
  coerceField,
  replaceById,
  removeById,
  blank,
  needsPassword,
  credentialRefFor,
}