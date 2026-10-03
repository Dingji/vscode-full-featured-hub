/**
 * ── DB2, spoken directly over DRDA ──────────────────────────────────────────
 *
 * DRDA (Distributed Relational Database Architecture) is a request/reply protocol built out
 * of named code points: every message is a sequence of (length, code point, payload) triples,
 * which makes it unusually pleasant to implement and unusually easy to get subtly wrong — one
 * mis-sized code point and everything after it is garbage.
 *
 * What this speaks:
 *
 *   EXCSAT    → exchange server attributes (the client's own)
 *   ACCSEC    → the security check, naming the mechanism
 *   SECCHK    → the credentials themselves
 *   ACCRDB    → access the relational database
 *   EXCSQLSTT → execute a statement, with the SQL as a single code point
 *
 * and it reads the reply messages, the SQLCARD (which carries the SQLCODE an error is reported
 * through), and the SQLDTA rows.
 *
 * NOT implemented, and refused by name rather than guessed at: DB2's "FOR READ ONLY" is a
 * property of a CURSOR, and this driver does not hold a cursor open across calls — one
 * statement per call, always closed. Read-only is therefore enforced HERE, and the card reports
 * it as 'client' rather than borrowing the wording of a server guarantee.
 */
import net from 'node:net'

/** How many rows a read collects before it stops, applied while READING. */
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
  return /^\s*(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|call|backup|restore|deny|comment|rename|reorg|runstats|import|load)\b/i.test(text)
}

/** The DRDA code points this driver uses, by name so the messages read like the spec. */
const CP = {
  EXCSAT: 0x1041, EXTNAM: 0x115e, SRVNAM: 0x116d, SRVRLSLV: 0x115a, SRVCLSNM: 0x1147,
  ACCSEC: 0x106d, SECMEC: 0x11a2, SECCHK: 0x106e, SECTKN: 0x11dc, USRID: 0x11a0,
  RDBNAM: 0x2110, ACCRDB: 0x2001, PRDID: 0x112e, TYPDEFNAM: 0x002f,
  EXCSQLSTT: 0x2005, SQLSTT: 0x2124, QRYBLKSZ: 0x2114, MAXBLKEXT: 0x2141,
  SQLCARD: 0x2408, SQLDTA: 0x2412, QRYDTA: 0x241b, SQLDARD: 0x2411,
  SECMEC_USRIDPWD: 0x0003,
  // Reply-only codes this driver recognises so it can SKIP them by their own length rather
  // than by a guess: a code point is self-describing, and that is the whole point of DRDA.
  ENDQRYRM: 0x220b, RDBACCCL: 0x1140, SECMGRM: 0x11a8, MGRLVLLS: 0x1404, RDBNACCL: 0x2202,
}

/** One code point: a 4-byte length (including itself), a 2-byte code, then the payload. */
function cp(code, payload) {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(payload.length + 4, 0)
  head.writeUInt16BE(code, 2)
  return Buffer.concat([head, payload])
}

/** A DDM string: a 2-byte length in CHARACTERS, then that many bytes. */
function ddm(text) {
  const bytes = Buffer.from(String(text), 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(String(text).length, 0)
  return Buffer.concat([head, bytes])
}

/** A command: a 4-byte length, a 2-byte code, then its code points. */
function command(code, ...parts) {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(4)
  head.writeUInt16BE(body.length + 4, 0)
  head.writeUInt16BE(code, 2)
  return Buffer.concat([head, body])
}

export function excsat({ clientName = 'dsh-hud' } = {}) {
  return command(CP.EXCSAT,
    cp(CP.SRVCLSNM, ddm('QDB2/NT')),
    cp(CP.SRVNAM, ddm('dsh-hud')),
    cp(CP.SRVRLSLV, ddm('1.0')),
    cp(CP.EXTNAM, ddm(clientName)))
}

export function accsec() {
  const mechanism = Buffer.alloc(2)
  mechanism.writeUInt16BE(CP.SECMEC_USRIDPWD, 0)
  return command(CP.ACCSEC, cp(CP.SECMEC, mechanism))
}

export function secchk({ user, password }) {
  const mechanism = Buffer.alloc(2)
  mechanism.writeUInt16BE(CP.SECMEC_USRIDPWD, 0)
  const credentials = Buffer.from(String(password), 'utf8')
  return command(CP.SECCHK,
    cp(CP.SECMEC, mechanism),
    cp(CP.USRID, ddm(user)),
    cp(CP.SECTKN, credentials))
}

export function accrdb({ database }) {
  return command(CP.ACCRDB,
    cp(CP.RDBNAM, ddm(database)),
    cp(CP.PRDID, ddm('QDB2/NT')),
    cp(CP.TYPDEFNAM, ddm('QTDSQLASC')))
}

export function execSqlStt(sql) {
  const blockSize = Buffer.alloc(4)
  blockSize.writeUInt32BE(32_768, 0)
  return command(CP.EXCSQLSTT,
    cp(CP.SQLSTT, Buffer.from(String(sql), 'utf8')),
    cp(CP.QRYBLKSZ, blockSize),
    cp(CP.MAXBLKEXT, Buffer.from([0x01, 0x00])))
}

/** Walk a message's code points from just after its own header. */
function* codePoints(buffer, from = 0) {
  let at = from + 4
  while (at + 4 <= buffer.length) {
    const length = buffer.readUInt16BE(at)
    const code = buffer.readUInt16BE(at + 2)
    if (length < 4 || at + length > buffer.length) return
    yield { code, payload: buffer.subarray(at + 4, at + length) }
    at += length
  }
}

/**
 * The SQLCARD's SQLCODE.
 *
 * This is how DRDA reports success and failure, and a driver that skips it reports a failed
 * query as an empty result — the single most misleading thing a database card can do.
 */
export function parseSqlCard(payload) {
  // 2 bytes of length, 1 version, 1 release, then the SQLCODE as a signed 32-bit integer.
  if (payload.length < 8) return { sqlcode: 0 }
  return { sqlcode: payload.readInt32BE(4) }
}

/** Everything one reply message has to say. */
export function parseReply(buffer) {
  const rows = []
  const columns = []
  let error
  for (const { code, payload } of codePoints(buffer)) {
    if (code === CP.SQLCARD) {
      const card = parseSqlCard(payload)
      if (card.sqlcode !== 0) error = { code: card.sqlcode }
    } else if (code === CP.SQLDARD) {
      // The column definitions, as length-prefixed names. A server always sends these before
      // the data; when they are missing the card shows positional names rather than inventing
      // real ones.
      let at = 0
      while (at + 2 <= payload.length) {
        const length = payload.readUInt16BE(at)
        at += 2
        if (length === 0 || at + length > payload.length) break
        columns.push(payload.subarray(at, at + length).toString('utf8'))
        at += length
      }
    } else if (code === CP.SQLDTA || code === CP.QRYDTA) {
      let at = 0
      const values = []
      while (at + 2 <= payload.length) {
        const length = payload.readUInt16BE(at)
        at += 2
        if (length === 0xffff) { values.push(null); continue }
        if (at + length > payload.length) break
        values.push(payload.subarray(at, at + length).toString('utf8'))
        at += length
      }
      if (values.length > 0) rows.push(values)
    }
  }
  return { columns, rows, error }
}

export const DRIVER = {
  id: 'db2',
  label: 'DB2',
  labelZh: 'DB2',
  /**
   * 'client'. See the note at the top: DB2's read-only mode belongs to a cursor, and this
   * driver keeps no cursor between calls, so the refusal is made here.
   */
  readonly: 'client',
  fields: [
    { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
    { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '50000', kind: 'number' },
    { key: 'database', label: '数据库', labelEn: 'DATABASE', placeholder: 'SAMPLE', kind: 'text' },
    { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'db2inst1', kind: 'text' },
  ],
}

export async function available() {
  // A socket and the Node it is already running on, like PostgreSQL and MySQL.
  return { ok: true }
}

export async function open(profile, { secrets = {} } = {}) {
  const host = profile.host ?? '127.0.0.1'
  const port = Number(profile.port ?? 50_000)
  const user = profile.user ?? ''
  const password = typeof secrets.password === 'string' ? secrets.password : ''
  const database = String(profile.database ?? '')
  if (password === '') {
    // Said plainly rather than sent as an empty credential and reported as whatever the
    // server calls it.
    throw new Error('DB2 需要一个密码（在连接表单里填密码，它会存进 DSH 凭据库）')
  }
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.connect({ host, port })
    candidate.setNoDelay(true)
    candidate.once('connect', () => resolve(candidate))
    candidate.once('error', (error) => reject(new Error(`连不上 ${host}:${port} —— ${error.message}`)))
  })
  const session = new Db2Session(socket, { host, port, database, user, limit: profile.limit })
  try {
    // One exchange per command, in the order the specification requires: no batching, because
    // a failure in the middle has to be attributable to the step that caused it.
    await session.round(excsat())
    await session.round(accsec())
    await session.round(secchk({ user, password }))
    const accepted = await session.round(accrdb({ database }))
    const failure = parseReply(accepted).error
    if (failure !== undefined) throw new Error(`[DB2 SQLCODE ${failure.code}] 无法打开数据库 ${database}`)
  } catch (error) {
    session.close()
    throw error
  }
  return session
}

class Db2Session {
  constructor(socket, info) {
    this.socket = socket
    this.info = info
    this.limit = clampLimit(info.limit)
    this.buffer = Buffer.alloc(0)
    this.queue = []
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
  }

  fail(error) {
    const next = this.queue.shift()
    if (next !== undefined) next.reject(error)
  }

  /**
   * One DDM message per round.
   *
   * The length is at the START of the message and covers the whole thing, so a partial read is
   * simply "wait for more" — which is why the buffer is kept rather than parsed optimistically.
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 6) return
      // The reply's own encoding says how wide the length field is; ASCII replies (which is
      // what a server sends by default) use the 2-byte form this driver requests.
      const length = this.buffer.readUInt16BE(0)
      if (length < 6 || this.buffer.length < length) return
      const message = this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      const next = this.queue.shift()
      if (next !== undefined) next.resolve(message)
    }
  }

  round(buffer) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.socket.write(buffer)
    })
  }

  /**
   * The panel's per-statement entry point. `lib/sql/index.js#runStatement` calls
   * `session.query(sql, { limit, timeoutMs, readOnly })` on EVERY driver, and this
   * class only had `run(sql)` — so a DB2 statement failed with
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
    const reply = await this.round(execSqlStt(sql))
    const parsed = parseReply(reply)
    if (parsed.error !== undefined) {
      throw new Error(`[DB2 SQLCODE ${parsed.error.code}] 语句被服务器拒绝`)
    }
    const rows = parsed.rows.slice(0, this.limit)
    return {
      columns: parsed.columns.length > 0
        ? parsed.columns
        : (rows[0] ?? []).map((_, index) => `col${index + 1}`),
      rows,
      truncated: parsed.rows.length > this.limit,
      notices: [],
    }
  }

  async schemas() {
    // The catalog, as plain SQL. One query for the objects and one for the columns: a round
    // trip per table is what makes a schema tree feel slow, and it is the same reason the
    // other drivers do it this way.
    const objects = await this.run(`SELECT TRIM(TABSCHEMA), TRIM(TABNAME), TYPE FROM SYSCAT.TABLES
 WHERE TYPE IN ('T','V') AND TABSCHEMA NOT LIKE 'SYS%' ORDER BY TABSCHEMA, TABNAME`)
    const columns = await this.run(`SELECT TRIM(TABSCHEMA), TRIM(TABNAME), TRIM(COLNAME), TRIM(TYPENAME), NULLS
 FROM SYSCAT.COLUMNS WHERE TABSCHEMA NOT LIKE 'SYS%' ORDER BY TABSCHEMA, TABNAME, COLNO`)
    const bySchema = new Map()
    for (const row of objects.rows) {
      const [schema, name, kind] = row
      if (!bySchema.has(schema)) bySchema.set(schema, [])
      bySchema.get(schema).push({ name, kind: kind === 'V' ? 'view' : 'table', columns: [] })
    }
    // Keyed by NAME, because the column query is answered for the whole database at once.
    const index = new Map()
    for (const list of bySchema.values()) for (const entry of list) index.set(entry.name, entry)
    for (const row of columns.rows) {
      const [, table, column, type, nullable] = row
      const entry = index.get(table)
      if (entry === undefined) continue
      entry.columns.push({ name: column, type, nullable: nullable === 'Y', primaryKey: false })
    }
    return [...bySchema.entries()].map(([name, list]) => ({ name, objects: list }))
  }

  close() {
    this.socket.destroy()
  }
}