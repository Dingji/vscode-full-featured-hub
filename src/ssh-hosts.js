// @ts-check
/**
 * dsh-hud — the SSH host list, and nothing else.
 *
 * Stored where the panels store things, so a user's own backup or a hand edit works
 * the same way: `$DSH_HOME/storages/dsh-hud/ssh/state.json`. Secrets do NOT go in
 * here — a host entry carries a credential NAME and the secret lives in the
 * credential document, which is the same split the SQL card makes (`passwordRef`).
 *
 * Pure except for `read`/`write`, so the list rules are testable on their own.
 */

'use strict'

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const { nextId, refName } = require('./connection-list')

/** Under `$DSH_HOME/storages/`, which is where every panel keeps its state. */
const STORAGE_PATH = ['storages', 'dsh-hud', 'ssh', 'state.json']

/** SSH's own default, and the only port worth guessing. */
const DEFAULT_PORT = 22

/** How a host authenticates. `agent` is deliberately absent: it works only when the
 * extension host happens to have SSH_AUTH_SOCK, which is not something a card can
 * promise, and offering it would produce a failure the user cannot act on. */
const AUTH_KINDS = ['password', 'key']

/** Where the host list lives. */
function storageFile(dshHome) {
  return join(dshHome, ...STORAGE_PATH)
}

/**
 * Read the list. A missing file is an empty list; an unreadable one is an ERROR
 * rather than an empty list, because silently showing "no hosts" is how someone
 * concludes their configuration was deleted.
 * @param {string} dshHome
 */
function read(dshHome) {
  const file = storageFile(dshHome)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return { hosts: [], active: '', file, missing: true }
    }
    throw new Error(`读不了 SSH 主机列表 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const hosts = Array.isArray(parsed?.hosts) ? parsed.hosts.filter((entry) => entry !== null && typeof entry === 'object') : []
  return { hosts, active: typeof parsed?.active === 'string' ? parsed.active : '', file, missing: false }
}

/**
 * Write the list, atomically: a card that is interrupted mid-write must not leave a
 * file that cannot be parsed, because the next launch reads it before anything else.
 * @param {string} dshHome
 */
function write(dshHome, { hosts, active }) {
  const file = storageFile(dshHome)
  mkdirSync(dirname(file), { recursive: true })
  const body = `${JSON.stringify({ version: 1, hosts, active: active ?? '' }, null, 2)}\n`
  const temporary = `${file}.tmp`
  writeFileSync(temporary, body, 'utf8')
  renameSync(temporary, file)
  return { hosts, active: active ?? '', file }
}

/**
 * One line describing a host, for a picker: `user@host:port`, and how it logs in.
 * @param {Record<string, any>} host
 */
function describe(host) {
  const user = host?.user === undefined || host.user === '' ? '' : `${host.user}@`
  const auth = host?.auth === 'key' ? ' · 密钥' : ' · 密码'
  return `${user}${host?.host ?? ''}:${host?.port ?? DEFAULT_PORT}${auth}`
}

/**
 * Keep an entry to the shape the rest of this module assumes.
 *
 * A port typed as text becomes a number, an unknown `auth` becomes `password`, and a
 * missing name falls back to `user@host` — the details that otherwise surface as a
 * connection that "just does not work" with nothing on screen to explain it.
 * @param {Record<string, any>} input
 * @param {{ keepId?: string }} [options]
 */
function normalize(input, options = {}) {
  const host = String(input?.host ?? '').trim()
  if (host === '') throw new Error('主机名不能为空')
  const rawPort = input?.port === undefined || input?.port === '' ? DEFAULT_PORT : Number(input.port)
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65_535) throw new Error('端口需要是 1..65535 之间的整数')
  const user = String(input?.user ?? '').trim()
  if (user === '') throw new Error('用户名不能为空')
  const auth = AUTH_KINDS.includes(input?.auth) ? input.auth : 'password'
  /** @type {Record<string, any>} */
  const entry = {
    id: typeof options.keepId === 'string' && options.keepId !== '' ? options.keepId : String(input?.id ?? ''),
    name: String(input?.name ?? '').trim() === '' ? `${user}@${host}` : String(input.name).trim(),
    host,
    port: rawPort,
    user,
    auth,
    readOnly: input?.readOnly === true,
  }
  // Optional, and left ABSENT when not given: an empty string in `keyFile` would be
  // a path that exists nowhere, which is a worse failure than no path at all.
  for (const key of ['keyFile', 'passwordRef', 'passphraseRef', 'fingerprint', 'note']) {
    const value = input?.[key]
    if (typeof value === 'string' && value.trim() !== '') entry[key] = value.trim()
  }
  return entry
}

/**
 * A brand-new host entry, with the id the list would generate.
 * @param {Array<Record<string, any>>} hosts
 * @param {Record<string, any>} [input]
 */
function blank(hosts, input = {}) {
  const id = nextId(hosts, 'ssh')
  return {
    id,
    name: '',
    host: '',
    port: DEFAULT_PORT,
    user: '',
    auth: 'password',
    readOnly: true,
    ...input,
  }
}

/** Does this host need a secret typed (or found) before it can connect? */
function needsSecret(host) {
  if (host?.auth === 'key') return typeof host.keyFile !== 'string' || host.keyFile === ''
  return true
}

/** The credential name a host uses for its password. */
function passwordRefFor(id) {
  return refName('hud_ssh', id, 'ssh_password')
}

/** The credential name a host uses for a key's passphrase. */
function passphraseRefFor(id) {
  return refName('hud_ssh_passphrase', id, 'ssh_passphrase')
}

module.exports = {
  STORAGE_PATH,
  DEFAULT_PORT,
  AUTH_KINDS,
  storageFile,
  read,
  write,
  describe,
  normalize,
  blank,
  needsSecret,
  passwordRefFor,
  passphraseRefFor,
}