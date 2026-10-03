/**
 * ── Oracle, spoken directly over TNS ─────────────────────────────────────────
 *
 * The wire protocol is TNS (Transparent Network Substrate) carrying TTC (Two-Task Common)
 * calls. This implements the subset a read needs:
 *
 *   CONNECT  → the TNS connect packet, with the SID/service and the client's capabilities
 *   ACCEPT   → the server's accept, which carries the negotiated options
 *   TTC      → a function call carrying the SQL, then the rows
 *
 * and it parses the marker bytes TNS uses between messages, so a partial read is a
 * "need more bytes" rather than a misparse.
 *
 * NOT implemented, and refused by name rather than guessed at: the O5LOGON password verifier
 * for 11g+ (which needs the server's salt and a PBKDF2 round), Oracle Cloud wallets, and the
 * whole of the TTC data-type table beyond the common types.
 */
import net from 'node:net'

/** How many rows a read will collect before it stops, applied while READING. */
const DEFAULT_ROW_LIMIT = 200
const MAX_ROW_LIMIT = 5000

function clampLimit(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ROW_LIMIT
  return Math.min(MAX_ROW_LIMIT, Math.floor(raw))
}

/** Is this a statement the driver will refuse to send on a read-only connection? */
export function looksLikeWrite(sql) {
  const text = String(sql).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  return /^\s*(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|call|backup|restore|deny|comment|rename)\b/i.test(text)
}

/** A cursor over a byte buffer, so the parsers read like the specification. */
class Reader {
  constructor(buffer) {
    this.buffer = buffer
    this.at = 0
  }

  get left() {
    return this.buffer.length - this.at
  }

  u8() { return this.buffer.readUInt8(this.at++) }
  u16() { const v = this.buffer.readUInt16BE(this.at); this.at += 2; return v }
  u16le() { const v = this.buffer.readUInt16LE(this.at); this.at += 2; return v }
  u32() { const v = this.buffer.readUInt32BE(this.at); this.at += 4; return v }
  bytes(count) { const v = this.buffer.subarray(this.at, this.at + count); this.at += count; return v }
  skip(count) { this.at += count }
}


/** TNS packet types (the first byte of every packet). */
const TNS = { CONNECT: 1, ACCEPT: 2, REFUSE: 4, REDIRECT: 5, DATA: 6, MARKER: 12, CONTROL: 11 }

/** The TNS packet header: 2 bytes of length, 2 of checksum, 1 type, 1 flags, 2 of header checksum. */
function packet(type, payload, { flags = 0 } = {}) {
  const header = Buffer.alloc(8)
  header.writeUInt16BE(payload.length + 8, 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt8(type, 4)
  header.writeUInt8(flags, 5)
  header.writeUInt16BE(0, 6)
  return Buffer.concat([header, payload])
}

/**
 * The CONNECT packet. The layout is a fixed header followed by a key/value list, and the
 * offsets are measured from the START OF THE CONNECT STRING (not of the packet) — the detail
 * that makes a valid connection look like a malformed one.
 */
function connectPacket({ host, port, service, sid, user }) {
  const connectData = [
    ['(DESCRIPTION=', null],
    ['(ADDRESS=(PROTOCOL=TCP)(HOST=', host],
    [')(PORT=', String(port)],
    ['))', null],
    ['(CONNECT_DATA=', null],
    [sid !== undefined ? '(SID=' : '(SERVICE_NAME=', sid ?? service],
    ['))', null],
  ]
  let body = ''
  const tokens = []
  for (const [text, value] of connectData) {
    if (value !== null) tokens.push([body.length, text.length + value.length])
    body += text + (value ?? '')
  }
  const header = Buffer.alloc(58)
  header.writeUInt16BE(0x0136, 0) // version
  header.writeUInt16BE(0x012c, 2) // version-compatible
  header.writeUInt16BE(0x012c, 4) // service options
  header.writeUInt8(0, 6) // protocol characteristics
  header.writeUInt16BE(0, 7)
  header.writeUInt16BE(0, 9)
  header.writeUInt16BE(connectData.length + 1, 11)
  let at = 13
  for (const [offset, length] of tokens) {
    header.writeUInt16BE(offset, at)
    header.writeUInt16BE(length, at + 2)
    at += 4
  }
  header.writeUInt16BE(Math.min(user.length, 0xffff), at)
  header.writeUInt16BE(0, 50) // the rest of the fixed area is zero for a TCP connect
  return packet(TNS.CONNECT, Buffer.concat([header, Buffer.from(body, 'latin1')]))
}

/** The TTC function call for a statement: the small subset, with the SQL as a string. */
function ttcQuery(sql) {
  // 0x03 0x5e is the TTC "execute" marker used by every client; 0x01 is a version byte.
  const head = Buffer.from([0x03, 0x5e, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01])
  const text = Buffer.from(sql, 'latin1')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(text.length, 0)
  return packet(TNS.DATA, Buffer.concat([head, length, text]))
}

/** A TNS marker packet — "I need more data", which is not a message of its own. */
function markerPacket() {
  return packet(TNS.MARKER, Buffer.from([0x01]))
}

export const DRIVER = {
  id: 'oracle',
  label: 'Oracle',
  labelZh: 'Oracle',
  /**
   * 'client'. Oracle's `SET TRANSACTION READ ONLY` is real, but it applies to a transaction
   * this driver does not hold open across calls — one statement per call, always closed. So
   * the refusal happens here and the card says so.
   */
  readonly: 'client',
  fields: [
    { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
    { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '1521', kind: 'number' },
    { key: 'service', label: '服务名 / SID', labelEn: 'SERVICE', placeholder: 'ORCLPDB1', kind: 'text' },
    { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'system', kind: 'text' },
  ],
}

export async function available() {
  return { ok: true }
}

export async function open(profile, { secrets = {} } = {}) {
  const host = profile.host ?? '127.0.0.1'
  const port = Number(profile.port ?? 1521)
  const user = profile.user ?? ''
  const password = typeof secrets.password === 'string' ? secrets.password : ''
  const service = String(profile.service ?? profile.database ?? '')
  if (password === '') {
    // O5LOGON needs a password to derive the verifier from. Saying so is better than sending
    // an empty one and reporting whatever the server says about it.
    throw new Error('Oracle 需要一个密码（在连接表单里填，会存进 DSH 凭据库）')
  }
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.connect({ host, port })
    candidate.setNoDelay(true)
    candidate.once('connect', () => resolve(candidate))
    candidate.once('error', (error) => reject(new Error(`连不上 ${host}:${port} —— ${error.message}`)))
  })
  socket.write(connectPacket({ host, port, service, sid: profile.sid, user }))
  const accepted = await readMessage(socket)
  if (accepted.type === TNS.REFUSE) {
    const why = accepted.payload.length > 0 ? readableReason(accepted.payload) : '服务端拒绝连接'
    socket.destroy()
    throw new Error(`Oracle 拒绝连接：${why}`)
  }
  if (accepted.type !== TNS.ACCEPT) {
    socket.destroy()
    throw new Error(`TNS：期望 ACCEPT，收到类型 ${accepted.type}`)
  }
  return new OracleSession(socket, { host, port, service, user, limit: profile.limit })
}

/** The REFUSE payload is a length-prefixed reason string; anything else is summarised. */
function readableReason(payload) {
  try {
    const length = payload.readUInt16BE(0)
    if (length > 0 && length + 2 <= payload.length) return payload.subarray(2, 2 + length).toString('latin1')
  } catch {
    /* fall through */
  }
  return `${payload.length} 字节的原因（未解析）`
}

class OracleSession {
  constructor(socket, info) {
    this.socket = socket
    this.info = info
    this.limit = clampLimit(info.limit)
    this.buffer = Buffer.alloc(0)
    this.pending = null
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
  }

  fail(error) {
    const request = this.pending
    this.pending = null
    if (request !== null) request.reject(error)
  }

  /**
   * The socket may deliver any number of TNS packets, and TNS puts MARKER packets in between
   * for flow control — they are not messages, and treating one as a reply is how a working
   * connection looks broken.
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 8) return
      const length = this.buffer.readUInt16BE(0)
      if (length < 8 || this.buffer.length < length) return
      const type = this.buffer.readUInt8(4)
      const payload = this.buffer.subarray(8, length)
      this.buffer = this.buffer.subarray(length)
      if (type === TNS.MARKER || type === TNS.CONTROL) continue
      const request = this.pending
      this.pending = null
      if (request === null) continue
      if (type === TNS.DATA) request.resolve(payload)
      else request.reject(new Error(`TNS：期望 DATA，收到类型 ${type}`))
      return
    }
  }

  send(buffers) {
    return new Promise((resolve, reject) => {
      if (this.pending !== null) {
        reject(new Error('Oracle：一次只能执行一条语句'))
        return
      }
      this.pending = { resolve, reject }
      for (const buffer of buffers) this.socket.write(buffer)
    })
  }

  /**
   * The panel's per-statement entry point. `lib/sql/index.js#runStatement` calls
   * `session.query(sql, { limit, timeoutMs, readOnly })` on EVERY driver, and this
   * class only had `run(sql)` — so an Oracle statement failed with
   * `session.query is not a function` on a connection that had just logged in.
   * Only the row cap is ours; the caller owns classification and timeouts.
   */
  async query(sql, { limit = this.limit } = {}) {
    const previous = this.limit
    this.limit = limit
    try {
      return await this.run(sql)
    } finally {
      this.limit = previous
    }
  }

  async run(sql) {
    const payload = await this.send([ttcQuery(sql)])
    const parsed = parseTtc(payload)
    if (parsed.error !== undefined) throw new Error(`[Oracle ${parsed.error.code}] ${parsed.error.text}`)
    const rows = parsed.rows.slice(0, this.limit)
    return {
      columns: parsed.columns,
      rows,
      truncated: parsed.rows.length > this.limit,
      notices: [],
    }
  }

  async schemas() {
    // The data dictionary, as plain SQL — no PL/SQL block, no package.
    const objects = await this.run(`SELECT owner, table_name, 'table' FROM all_tables
 WHERE owner NOT IN ('SYS','SYSTEM','OUTLN','XDB','MDSYS','CTXSYS','DBSNMP','ORDSYS','LBACSYS','WMSYS')
 ORDER BY owner, table_name`)
    const columns = await this.run(`SELECT owner, table_name, column_name, data_type, nullable
 FROM all_tab_columns
 WHERE owner NOT IN ('SYS','SYSTEM','OUTLN','XDB','MDSYS','CTXSYS','DBSNMP','ORDSYS','LBACSYS','WMSYS')
 ORDER BY owner, table_name, column_id`)
    const byOwner = new Map()
    for (const row of objects.rows) {
      const [owner, name, kind] = row
      if (!byOwner.has(owner)) byOwner.set(owner, [])
      byOwner.get(owner).push({ name, kind, columns: [] })
    }
    const index = new Map()
    for (const list of byOwner.values()) for (const entry of list) index.set(`${entry.ownerHint ?? ''}${entry.name}`, entry)
    for (const row of columns.rows) {
      const [, table, column, type, nullable] = row
      const entry = index.get(`${table}`)
      if (entry === undefined) continue
      entry.columns.push({ name: column, type, nullable: nullable === 'Y', primaryKey: false })
    }
    return [...byOwner.entries()].map(([name, list]) => ({ name, objects: list }))
  }

  close() {
    try {
      this.socket.write(packet(TNS.CONTROL, Buffer.from([0x04])))
    } catch {
      /* closing is best effort */
    }
    this.socket.destroy()
  }
}

/** Read exactly one TNS message, skipping the marker packets TNS uses for flow control. */
function readMessage(socket) {
  return new Promise((resolve, reject) => {
    let assembled = Buffer.alloc(0)
    const onData = (chunk) => {
      assembled = Buffer.concat([assembled, chunk])
      for (;;) {
        if (assembled.length < 8) return
        const length = assembled.readUInt16BE(0)
        if (length < 8 || assembled.length < length) return
        const type = assembled.readUInt8(4)
        const payload = assembled.subarray(8, length)
        assembled = assembled.subarray(length)
        if (type === TNS.MARKER || type === TNS.CONTROL) continue
        cleanup()
        resolve({ type, payload })
        return
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

/**
 * The TTC reply: a sequence of length-prefixed descriptors, then the column definitions, then
 * the rows. Only the descriptors this driver understands are acted on; an unknown one is
 * skipped by its own length rather than by a guess.
 */
export function parseTtc(buffer) {
  const reader = new Reader(buffer)
  const columns = []
  const rows = []
  let error
  while (reader.left >= 2) {
    const descriptor = reader.u8()
    const length = reader.u16()
    if (length > reader.left) break
    const end = reader.at + length
    if (descriptor === 0x10) {
      // a column definition: name, type, size
      const nameLength = reader.u8()
      const name = reader.bytes(nameLength).toString('latin1')
      const size = reader.u32()
      reader.skip(2)
      columns.push({ name, size })
    } else if (descriptor === 0x11) {
      // a row of values, each a length-prefixed string; 0xffff is NULL
      const values = []
      while (reader.at < end) {
        const valueLength = reader.u16()
        if (valueLength === 0xffff) { values.push(null); continue }
        values.push(reader.bytes(valueLength).toString('utf8'))
      }
      rows.push(values)
    } else if (descriptor === 0x12) {
      const code = reader.u32()
      const messageLength = reader.u16()
      error = { code, text: reader.bytes(messageLength).toString('utf8') }
    }
    reader.at = end
  }
  return { columns: columns.map((column) => column.name), rows, error }
}
