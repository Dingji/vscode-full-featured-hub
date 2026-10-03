// @ts-check
/**
 * dsh-hud — SSH sessions, host side.
 *
 * One `ssh2` client per open terminal, with a real PTY, bridged to the webview as
 * bytes rather than as text.
 *
 * ── why base64 ─────────────────────────────────────────────────────────────
 *
 * A shell's output is a byte stream, not a string: `ls --color`, a UTF-8 file cut
 * mid-character by a read boundary, a binary `cat` — all of them produce bytes that
 * are not valid UTF-16 and do not survive a JSON round trip intact. So the wire
 * carries base64 and the terminal decodes it into a Uint8Array, which is exactly
 * what xterm's `write` accepts. Sending strings would look right for `ls` and
 * quietly corrupt everything else.
 *
 * ── why the session belongs to a WEBVIEW ───────────────────────────────────
 *
 * `hud.retainContext` defaults to false, so switching away from the HUD panel
 * DESTROYS the webview. An SSH connection that outlived it would keep a login open
 * on somebody's server with nothing on screen to close it, so every session is
 * owned by the client that opened it and `closeAll` runs when that view is disposed.
 */

'use strict'

const { createHash } = require('node:crypto')

/** Nothing here may block the extension host for long. */
const READY_TIMEOUT_MS = 20_000
const KEEPALIVE_MS = 15_000

/**
 * A host key's SHA256 fingerprint, in the form `ssh-keygen -lf` prints.
 * @param {Buffer} key
 */
function fingerprintOf(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

class SshSessions {
  /**
   * @param {{
   *   push: (event: string, payload: any) => void,
   *   log: (line: string) => void,
   * }} deps `push` delivers one event to the webview that owns the session
   */
  constructor({ push, log }) {
    this.push = push
    this.log = log
    /** @type {Map<string, { conn: any, stream: any, host: any }>} */
    this.sessions = new Map()
  }

  /** What the card shows before it connects: the hosts, and who is open. */
  state(hosts) {
    return {
      hosts: hosts.map((host) => ({
        ...host,
        open: this.sessions.has(host.id),
      })),
      open: [...this.sessions.values()].map((session) => ({
        id: session.host.id,
        name: session.host.name ?? session.host.host,
        fingerprint: session.fingerprint,
      })),
    }
  }

  /**
   * Open a shell.
   *
   * `async`, so every failure arrives as a REJECTION. A plain function that throws
   * for a bad argument and rejects for a bad connection is two shapes for one
   * operation, and a caller that wrote `open(...).catch(...)` would miss half of
   * them — which is exactly what the test for the already-open case caught.
   *
   * @param {Record<string, any>} host the saved host entry
   * @param {{ password?: string, passphrase?: string, privateKey?: string, cols: number, rows: number, strictHostKey?: boolean }} options
   */
  async open(host, options) {
    const id = String(host.id)
    if (this.sessions.has(id)) throw new Error(`「${host.name ?? id}」已经连着了`)
    const cols = Number.isFinite(options.cols) && options.cols > 0 ? Math.floor(options.cols) : 80
    const rows = Number.isFinite(options.rows) && options.rows > 0 ? Math.floor(options.rows) : 24

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line global-require
      const { Client } = require('ssh2')
      const conn = new Client()
      let settled = false
      let fingerprint = ''
      const fail = (error) => {
        if (settled) return
        settled = true
        try {
          conn.end()
        } catch { /* already gone */ }
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols, rows }, (error, stream) => {
          if (error) {
            fail(error)
            return
          }
          this.sessions.set(id, { conn, stream, host, fingerprint })
          settled = true
          /**
           * The stream's bytes, base64'd — see the note at the top of this file.
           * `ssh.data` is not a reply to anything, so it carries no id.
           */
          stream.on('data', (chunk) => this.push('ssh.data', { id, data: chunk.toString('base64') }))
          stream.stderr.on('data', (chunk) => this.push('ssh.data', { id, data: chunk.toString('base64') }))
          stream.on('close', () => {
            this.sessions.delete(id)
            this.push('ssh.exit', { id })
            try {
              conn.end()
            } catch { /* already gone */ }
          })
          resolve({ id, fingerprint, cols, rows })
        })
      })
      conn.on('error', (error) => {
        this.sessions.delete(id)
        this.push('ssh.exit', { id, error: error.message })
        fail(error)
      })
      conn.on('close', () => {
        if (this.sessions.delete(id)) this.push('ssh.exit', { id })
      })

      /** @type {Record<string, any>} */
      const config = {
        host: host.host,
        port: Number(host.port ?? 22),
        username: host.user,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_MS,
        // Recorded either way: the card shows it, so "I did not verify" is a
        // statement the user can see rather than one they have to trust.
        hostVerifier: (key) => {
          fingerprint = fingerprintOf(key)
          return options.strictHostKey !== true || host.fingerprint === fingerprint
        },
      }
      if (typeof options.password === 'string' && options.password !== '') config.password = options.password
      if (typeof options.privateKey === 'string' && options.privateKey !== '') config.privateKey = options.privateKey
      if (typeof options.passphrase === 'string' && options.passphrase !== '') config.passphrase = options.passphrase
      if (config.password === undefined && config.privateKey === undefined) {
        // Without this the library tries the agent and the default keys, which
        // fails with "All configured authentication methods failed" — an error
        // that names everything except the actual problem.
        fail(new Error(`「${host.name ?? id}」没有可用的认证方式：填一个密码或一把私钥`))
        return
      }

      this.log(`ssh ${config.username}@${config.host}:${config.port} opening`)
      try {
        conn.connect(config)
      } catch (error) {
        fail(error)
      }
    })
  }

  /** Keystrokes, base64 for the same reason the output is. */
  write(id, data) {
    const session = this.sessions.get(String(id))
    if (session === undefined) return false
    session.stream.write(Buffer.from(String(data), 'base64'))
    return true
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(String(id))
    if (session === undefined) return false
    // ssh2's argument order is (rows, cols), which is the reverse of every other
    // call in this file — the one place a swap would be invisible until a
    // full-screen program drew itself wrong.
    session.stream.setWindow(Math.max(2, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0)
    return true
  }

  close(id) {
    const session = this.sessions.get(String(id))
    if (session === undefined) return false
    this.sessions.delete(String(id))
    try {
      session.stream.end()
    } catch { /* already gone */ }
    try {
      session.conn.end()
    } catch { /* already gone */ }
    return true
  }

  /** Every session, for a webview that is being destroyed. */
  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}

module.exports = { SshSessions, fingerprintOf, READY_TIMEOUT_MS, KEEPALIVE_MS }