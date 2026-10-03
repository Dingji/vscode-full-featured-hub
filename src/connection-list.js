// @ts-check
/**
 * dsh-hud — the parts of a "list of connections" that are the same whether the
 * connection is a database or an SSH host.
 *
 * Extracted rather than copied, because two of these carry rules that are easy to
 * get subtly wrong twice: an `active` that must never dangle, and a credential name
 * that must satisfy the store's pattern — a name outside it makes the credentials
 * plugin fail to LOAD, which stops DSH from starting.
 *
 * Pure: no `vscode`, no filesystem, no network.
 */

'use strict'

/** The cap the SQL card enforces (`MAX_CONNECTIONS` in `panels/sql/client.js`). */
const MAX_CONNECTIONS = 12

/**
 * A fresh id that collides with nothing.
 *
 * The panel counts rather than reusing gaps, so a list holding `conn-3` yields
 * `conn-2`: ids are how `active` refers to a connection, and reusing one would make
 * that reference ambiguous.
 *
 * @param {Array<Record<string, any>>} connections
 * @param {string} [prefix]
 */
function nextId(connections, prefix = 'conn') {
  const taken = new Set((connections ?? []).map((entry) => entry?.id))
  let index = (connections ?? []).length + 1
  let id = `${prefix}-${index}`
  while (taken.has(id)) {
    index += 1
    id = `${prefix}-${index}`
  }
  return id
}

/** Replace one entry by id, leaving the order alone. */
function replaceById(connections, id, entry) {
  return (connections ?? []).map((existing) => (existing?.id === id ? { ...entry } : existing))
}

/**
 * Remove one entry, and make sure `active` still points at something — a dangling
 * `active` renders a card with nothing selected and no way back.
 * @returns {{ connections: Array<Record<string, any>>, active: string }}
 */
function removeById(connections, id, active) {
  const list = (connections ?? []).filter((entry) => entry?.id !== id)
  if (active !== id && list.some((entry) => entry?.id === active)) return { connections: list, active }
  return { connections: list, active: list[0]?.id ?? '' }
}

/**
 * A name the credential store will accept: `[A-Za-z_][A-Za-z0-9_]*`.
 *
 * @param {string} prefix e.g. `hud_sql`, `hud_ssh`
 * @param {string} id the connection's own id
 * @param {string} [fallback] what an empty id becomes
 */
function refName(prefix, id, fallback = 'credential') {
  const cleaned = String(id ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
  return cleaned === '' ? fallback : `${prefix}_${cleaned}`
}

module.exports = { MAX_CONNECTIONS, nextId, replaceById, removeById, refName }