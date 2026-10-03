// @ts-check
/**
 * A small IMAP client, written against `node:tls` and `node:net` only.
 *
 * ── why hand-written ───────────────────────────────────────────────────────
 *
 * This plugin ships with ZERO runtime dependencies, and an IMAP library is a
 * large thing to add for what is actually needed here: log in, select one
 * mailbox, read the headers of the newest few messages. The protocol subset is
 * small and — unlike the task APIs of Feishu and DingTalk — it is **stable**:
 * RFC 3501 has not moved in twenty years, and `LOGIN` / `SELECT` / `FETCH` are
 * implemented by every provider. Nothing here guesses at a vendor's private
 * schema.
 *
 * ── what it does, in order ─────────────────────────────────────────────────
 *
 *   1. greeting            `* OK …`
 *   2. `LOGIN`             the账号 and its 授权码 (see below)
 *   3. `SELECT`            the mailbox; reads `EXISTS` to know how many
 *   4. `FETCH`             the newest `limit` messages, headers only
 *   5. `LOGOUT`
 *
 * ── the 授权码, not the password ───────────────────────────────────────────
 *
 * 163 / 126 / QQ / 阿里 / 腾讯企业邮 all refuse the account password over IMAP
 * and require an **授权码** (an app password) generated in their web settings.
 * That is the login credential this client expects, and it is why email needs no
 * application registration anywhere: the user enables IMAP and copies one string.
 * Gmail and Outlook would additionally want OAuth/XOAUTH2, which is a different
 * flow and is NOT implemented — saying so is better than a failed login with no
 * explanation.
 *
 * ── what is deliberately NOT attempted ─────────────────────────────────────
 *
 * Deciding **which messages are actionable**. There is no reliable signal, and a
 * wrong guess puts junk in someone's task list. This client returns what it read
 * and the UI lets the user turn one into a to-do; the judgement stays human.
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Thrown for anything the caller should show the user verbatim. */
export class ImapError extends Error {}

/**
 * Decode RFC 2047 encoded-words, which is how a Chinese subject arrives.
 *
 * `=?UTF-8?B?5rWL6K+V?=` and `=?GBK?Q?=B2=E2=CA=D4?=` are both real. Base64 and
 * quoted-printable are handled; an unknown charset falls back to UTF-8 rather
 * than dropping the subject, because a mangled subject is still readable and a
 * missing one is not.
 */
export function decodeEncodedWords(value) {
  return String(value ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, payload) => {
    try {
      const bytes = String(encoding).toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(String(payload).replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary')
      const label = String(charset).toLowerCase()
      if (label === 'utf-8' || label === 'utf8' || label === 'us-ascii' || label === 'ascii') {
        return bytes.toString('utf8')
      }
      // Node decodes GBK/GB18030/Big5 through the full-icu build it ships with.
      return new TextDecoder(label, { fatal: false }).decode(bytes)
    } catch {
      return whole
    }
  })
}

/** Unfold a header block into `{ SUBJECT: '…', FROM: '…' }` (upper-case keys). */
export function parseHeaders(text) {
  const out = {}
  const unfolded = String(text ?? '').replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toUpperCase()
    // An encoded word SPLIT across a fold must be rejoined with no space at all
    // (RFC 2047 §2), and a long Chinese subject is folded exactly there. Base64
    // never contains a space and Q-encoding writes one as `_`, so removing the
    // whitespace inside an encoded word is always safe.
    const value = line.slice(colon + 1).trim()
      .replace(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g, (word) => word.replace(/\s+/g, ''))
    out[name] = out[name] === undefined ? value : `${out[name]} ${value}`
  }
  return out
}

/** `"张三" <a@b.com>` → `张三`; a bare address is returned as written. */
export function displayName(from) {
  const text = decodeEncodedWords(String(from ?? '').replace(/[\r\n]+/g, ' ')).trim()
  const named = /^(.*?)\s*<[^>]*>\s*$/.exec(text)
  const name = (named?.[1] ?? text).trim().replace(/^"|"$/g, '')
  return name === '' ? text : name
}

/** `Date:` → epoch millis, or undefined. Never throws on a broken date. */
export function parseMailDate(value) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : undefined
}

/**
 * An IMAP conversation over one socket.
 *
 * The reader handles **literals** (`{123}\r\n…123 bytes…`), which is the part a
 * naive line-splitting client gets wrong: a subject longer than one line arrives
 * as a literal, and treating it as text corrupts the rest of the stream. The
 * tests drive this class against a mock server that sends exactly such a byte
 * sequence.
 */
export class ImapSession {
  /**
   * @param {{ connect?: Function, host: string, port?: number, timeoutMs?: number, onLog?: Function }} options
   */
  constructor(options) {
    this.options = options
    this.socket = null
    /** BYTES, never characters — see `sliceResponse`. */
    this.buffer = Buffer.alloc(0)
    this.counter = 0
    /** Resolvers waiting for the next complete response. */
    this.waiters = []
    this.closed = false
  }

  /** Open the socket (TLS by default, plain when a `connect` is injected). */
  open() {
    const { host, port = 993, timeoutMs = 15_000, connect } = this.options
    let settle
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    // Pre-handled, for the same reason `command()` is: a refused or reset
    // connection rejects here, and if the caller has not reached its `await` yet
    // an unhandled rejection would take the process down instead of surfacing as
    // an error message.
    promise.catch(() => {})
    const fail = (message) => settle.reject(new ImapError(message))
    const timer = setTimeout(() => {
      this.destroy()
      fail(`连接超时（${timeoutMs} ms）`)
    }, timeoutMs)
    let socket
    try {
      const factory = typeof connect === 'function' ? connect : tlsConnect
      // `servername` only when the host is a NAME: Node warns (DEP0123) that an
      // IP is not a legal SNI value, and the warning is noise in every run that
      // points the client at 127.0.0.1.
      const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
      socket = factory({
        host,
        port,
        ...(isAddress ? {} : { servername: host }),
        rejectUnauthorized: false,
      }, () => {
        clearTimeout(timer)
        settle.resolve(undefined)
      })
    } catch (error) {
      clearTimeout(timer)
      fail(error instanceof Error ? error.message : String(error))
      return promise
    }
    this.socket = socket
    // Deliberately NO `setEncoding`: IMAP counts literals in BYTES, so the
    // session has to keep bytes. Decoding to a string here is what made a
    // literal containing a Chinese subject skip the wrong distance and then hang
    // waiting for a tag line that had already been consumed.
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('error', (error) => {
      clearTimeout(timer)
      const message = error instanceof Error ? error.message : String(error)
      this.fail(message)
      fail(message)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      this.closed = true
      this.fail('连接已关闭')
    })
    return promise
  }

  destroy() {
    this.closed = true
    try {
      this.socket?.destroy()
    } catch {
      /* already gone */
    }
  }

  /** Reject everyone waiting: the connection is no longer usable. */
  fail(message) {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.reject(new ImapError(message))
  }

  /**
   * Append bytes and hand every COMPLETE response to the oldest waiter.
   *
   * A response ends at a line whose first token is the tag we are waiting for —
   * but only once no literal is outstanding, which is what the scan below
   * accounts for.
   */
  feed(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]
      const complete = this.sliceResponse(waiter.tag)
      if (complete === null) break
      this.buffer = this.buffer.subarray(complete.length)
      this.waiters.shift()
      waiter.resolve(complete)
    }
  }

  /**
   * The response bytes for `tag`, or null when it has not fully arrived.
   *
   * A scanner rather than `split('\n')` because of literals: after `{12}` the
   * NEXT 12 **BYTES** are data even if they contain CRLF — and 12 bytes is not
   * 12 characters once the payload is Chinese. Counting characters here is the
   * bug this function exists to avoid.
   */
  sliceResponse(tag) {
    const needle = Buffer.from(`${tag} `, 'utf8')
    let index = 0
    while (index < this.buffer.length) {
      const lineEnd = this.buffer.indexOf(0x0a, index) // '\n'
      if (lineEnd < 0) return null
      const line = this.buffer.subarray(index, lineEnd + 1)
      // A literal marker at the end of a line: skip exactly that many bytes.
      const literal = /\{(\d+)\}\r?\n$/.exec(line.toString('latin1'))
      if (literal) {
        const size = Number(literal[1])
        const start = lineEnd + 1
        if (start + size > this.buffer.length) return null
        index = start + size
        continue
      }
      if (line.length >= needle.length && line.subarray(0, needle.length).equals(needle)) {
        return this.buffer.subarray(0, lineEnd + 1)
      }
      index = lineEnd + 1
    }
    return null
  }

  /** Send one tagged command and wait for its response. */
  command(text) {
    if (this.closed) return Promise.reject(new ImapError('连接已关闭'))
    this.counter += 1
    const tag = `A${String(this.counter).padStart(3, '0')}`
    const payload = `${tag} ${text}\r\n`
    let settle
    const promise = new Promise((resolve, reject) => {
      settle = { tag, resolve, reject }
    })
    // Mark the promise as handled the moment it exists. A socket can die between
    // the write and the caller's `await`, and an unhandled rejection takes the
    // whole process down — which is how a mail server hanging up turned into a
    // crashed test run instead of an error the user could read. The awaiting
    // caller still receives the rejection; this only stops the noise.
    promise.catch(() => {})
    this.waiters.push(settle)
    try {
      this.socket.write(payload)
    } catch (error) {
      settle.reject(new ImapError(error instanceof Error ? error.message : String(error)))
    }
    return promise
  }
}

/** `* 12 EXISTS` → 12. */
export function parseExists(response) {
  const match = /\*\s+(\d+)\s+EXISTS/i.exec(String(response ?? ''))
  return match ? Number(match[1]) : undefined
}

/**
 * Pull the messages out of a FETCH response.
 *
 * Takes BYTES (or a string, which is converted) because the header block is a
 * literal sized in bytes: slicing a decoded string by that number is the same
 * character/byte mistake the session scanner had.
 */
export function parseFetch(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8')
  const messages = []
  // Group boundaries are found by scanning for `* n FETCH` at the start of a
  // line, then walking each group with the literal size respected.
  const text = buffer.toString('latin1')
  const starts = []
  const pattern = /\*\s+\d+\s+FETCH\s+/gi
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index === 0 || text[match.index - 1] === '\n') starts.push({ at: match.index, body: match.index + match[0].length })
  }
  starts.forEach((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1].at : buffer.length
    const group = buffer.subarray(start.body, end)
    const head = group.subarray(0, Math.min(group.length, 400)).toString('latin1')
    const flags = /FLAGS\s+\(([^)]*)\)/i.exec(head)
    const internal = /INTERNALDATE\s+"([^"]*)"/i.exec(head)
    const uid = /\bUID\s+(\d+)/i.exec(head)
    let headers = {}
    const literal = /\{(\d+)\}\r?\n/.exec(head)
    if (literal) {
      const size = Number(literal[1])
      const from = literal.index + literal[0].length
      headers = parseHeaders(group.subarray(from, from + size).toString('utf8'))
    } else {
      headers = parseHeaders(head)
    }
    const seen = (flags?.[1] ?? '').toUpperCase().split(/\s+/).filter(Boolean)
    messages.push({
      uid: uid ? Number(uid[1]) : undefined,
      subject: decodeEncodedWords(headers.SUBJECT ?? '(无主题)').trim() || '(无主题)',
      from: displayName(headers.FROM),
      date: parseMailDate(headers.DATE),
      internalDate: internal ? parseMailDate(internal[1].replace(/^"|"$/g, '')) : undefined,
      seen: seen.includes('\\SEEN'),
      flagged: seen.includes('\\FLAGGED'),
    })
  })
  return messages
}

/** Quote a mailbox name for IMAP, escaping the two characters that matter. */
export function quoteMailbox(name) {
  return `"${String(name ?? 'INBOX').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** IMAP wants `1-Jan-2026` style dates in SEARCH. */
export function imapDate(at) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const date = new Date(at)
  return `${date.getDate()}-${months[date.getMonth()]}-${date.getFullYear()}`
}

/**
 * Log in and read the newest headers of one mailbox.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} [options.port]
 * @param {string} options.user
 * @param {string} options.password   the 授权码, not the account password
 * @param {string} [options.mailbox]
 * @param {number} [options.limit]
 * @param {Function} [options.connect]  transport override (tests inject a plain socket)
 * @returns {Promise<{ messages: any[], total: number, mailbox: string }>}
 */
export async function fetchRecentHeaders(options) {
  const { host, user, password, mailbox = 'INBOX', limit = 20, timeoutMs = 15_000 } = options
  if (!host) throw new ImapError('未填写 IMAP 服务器')
  if (!user || !password) throw new ImapError('未填写邮箱账号或授权码')
  const session = new ImapSession({ host, port: options.port, timeoutMs, connect: options.connect })
  try {
    await session.open()
    const greeting = (await session.command('CAPABILITY')).toString('utf8') // also flushes the greeting
    if (/^\*\s+(BYE|NO)/im.test(greeting)) throw new ImapError('服务器拒绝了连接')
    const login = (await session.command(`LOGIN ${quoteMailbox(user)} ${quoteMailbox(password)}`)).toString('utf8')
    if (/^A\d+\s+NO/im.test(login) || /^A\d+\s+BAD/im.test(login)) {
      // The single most common cause, and the one worth naming: providers reject
      // the account password and want an app-specific 授权码.
      throw new ImapError('登录失败：多数邮箱需要「授权码 / 应用专用密码」，而不是账号密码')
    }
    const select = (await session.command(`SELECT ${quoteMailbox(mailbox)}`)).toString('utf8')
    if (/^A\d+\s+NO/im.test(select)) throw new ImapError(`无法打开邮箱目录 ${mailbox}`)
    const total = parseExists(select) ?? 0
    if (total === 0) {
      await session.command('LOGOUT').catch(() => {})
      return { messages: [], total: 0, mailbox }
    }
    const from = Math.max(1, total - limit + 1)
    // `BODY.PEEK` so reading does not mark the messages as read.
    const fetch = await session.command(`FETCH ${from}:* (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])`)
    const messages = parseFetch(fetch).reverse() // newest first
    await session.command('LOGOUT').catch(() => {})
    return { messages, total, mailbox }
  } finally {
    session.destroy()
  }
}

/** Pure helpers, exported for the test harness. */
export const __test = {
  decodeEncodedWords,
  parseHeaders,
  displayName,
  parseMailDate,
  parseExists,
  parseFetch,
  quoteMailbox,
  imapDate,
  ImapSession,
}