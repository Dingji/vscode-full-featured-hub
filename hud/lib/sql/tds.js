// ── SQL Server, spoken directly ──────────────────────────────────────────────
//
// TDS (Tabular Data Stream) over TCP, hand-written, no client abbreviation and no
// `tedious`. Same shape as the PostgreSQL and MySQL drivers beside it: the protocol is
// implemented here and the driver answers the small interface `lib/sql/index.js` expects.
//
// ── the one thing this driver CANNOT promise ────────────────────────────────
//
// SQL Server has no server-enforced read-only transaction. PostgreSQL has
// `BEGIN TRANSACTION READ ONLY`, MySQL has `START TRANSACTION READ ONLY`, SQLite has a
// read-only file handle — all three let the SERVER refuse a write. SQL Server's nearest
// equivalents are `ApplicationIntent=ReadOnly` (a routing hint for Availability Groups,
// not an enforcement) and a read-only LOGIN (which is a server-side decision the user
// makes, not one this plugin can make for them).
//
// So for this driver, read-only is a promise made HERE: the plugin refuses to send a
// statement it classifies as a write, and says so plainly rather than implying a
// guarantee the server is not making. `readOnly` is reported as 'client' — not
// 'engine' and not 'transaction' — because that is the truth and the three are not the
// same thing.
//
// ── what it speaks ──────────────────────────────────────────────────────────
//
//   PRELOGIN  → negotiates encryption. The answer is NOT "on or off": ENCRYPT_OFF
//               means "encryption is available, the login packet will be encrypted,
//               the session stays plaintext" — and that is the common case. Only
//               ENCRYPT_NOT_SUP means no encryption at all.
//   LOGIN7    → SQL authentication, with the password obfuscation the protocol specifies
//   SQL_BATCH → the statement itself, with a transaction descriptor of "none"
//
// and it parses: LOGINACK, ENVCHANGE, INFO, ERROR, COLMETADATA, ROW, NBCROW, DONE.
// Anything else is reported by token number rather than silently misread.
//
// ── login packet encryption: the two bugs this file used to have ────────────
//
// Both were found against a real SQL Server 2008 R2, and BOTH made the server drop
// the login WITHOUT an answer — no ERROR token, no disconnect, just silence until the
// caller gave up. That is the worst possible failure mode to debug from the outside,
// which is why the details are written down here.
//
//   1. NO ENCRYPTION AT ALL. The driver only did TLS when the server answered
//      ENCRYPT_REQ. But SQL Server answers ENCRYPT_OFF by default, and it still
//      requires the LOGIN7 packet to arrive inside TLS — that is what "login packet
//      encryption" means, and it is why every Microsoft client encrypts the login
//      even with `Encrypt=no`. A plaintext LOGIN7 is discarded.
//
//      Carrying that TLS is NOT a normal TLS handshake: the handshake records travel
//      inside TDS packets (type 0x12) until the handshake finishes, then the TLS
//      records go out bare, and the login answer comes back IN PLAINTEXT because only
//      the login was encrypted.
//
//   2. WRONG OFFSET BASE. LOGIN7's variable-field offsets are measured from the start
//      of the LOGIN7 STRUCTURE (94), not from the start of the TDS packet header (102).
//      The old code added 8, so even an encrypted login was discarded — which is how
//      this stayed hidden: every symptom looked like "the server ignores us".
//
// One OpenSSL detail belongs here too: the first application record must NOT be split
// into an empty record plus the real one (SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS). That
// mitigation is on by default and this server answers a login sent that way with the
// same silence. Schannel, which the Microsoft drivers use, does not split.
//
// ── what it deliberately does not do ────────────────────────────────────────
//
//   • Windows / Azure AD authentication: it needs a token from an identity provider, not
//     a credential. Refused by name.
//   • MARS (multiple active result sets): one statement at a time, like every other
//     driver here.
//   • The whole TDS type system: the common types are decoded properly, and anything
//     exotic is rendered as `<type 0xNN>` rather than guessed at.
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { Duplex } from 'node:stream'

/** Packet types (MS-TDS 2.2.3.1). */
const PACKET = { SQL_BATCH: 0x01, RPC: 0x03, REPLY: 0x04, LOGIN7: 0x10, PRELOGIN: 0x12 }
/** Token types (MS-TDS 2.2.5), the ones this driver understands. */
const TOKEN = {
  COLMETADATA: 0x81, ERROR: 0xaa, INFO: 0xab, LOGINACK: 0xad,
  ENVCHANGE: 0xe3, ROW: 0xd1, NBCROW: 0xd2, DONE: 0xfd, DONEPROC: 0xfe, DONEINPROC: 0xff,
  // Tokens that carry nothing this card shows, but that a real server DOES send — every
  // one of them is length-prefixed, so skipping them is exact rather than a guess. They
  // are here because of a live 2008 R2: `select ... order by name` came back as
  // "不认识的 token 0xa9", the ORDER token it sends for any ordered result.
  ORDER: 0xa9, TABNAME: 0xa4, COLINFO: 0xa5, RETURNSTATUS: 0x79,
  /**
   * FEDAUTHINFO — federated-authentication information, and the token that produced
   * "TDS: 不认识的 token 0xee（第 0 字节）" on a statement that had worked a minute
   * earlier. It carries an STS URL and an SPN, neither of which a SQL-login session can
   * use, so it is skipped.
   *
   * Verify the width before adding anything here: ORDER/TABNAME/COLINFO are prefixed with
   * a WORD, and this one with a DWORD (MS-TDS 2.2.7.5, and `fedauth-info-parser.js` in
   * tedious reads `readUInt32LE` before slicing). One wrong width does not fail — it
   * shifts every token after it, which is how a reply turns into plausible-looking
   * nonsense. RETURNVALUE (0xac), FEATUREEXTACK (0xae), SSPI (0xed) and ALTMETADATA
   * (0x88) are deliberately still UNKNOWN here: each needs its own verified framing
   * rather than a guess, and failing loudly beats decoding wrongly.
   */
  FEDAUTHINFO: 0xee,
}
/** PRELOGIN encryption answers (MS-TDS 2.2.6.5). */
const ENCRYPT = { OFF: 0, ON: 1, NOT_SUP: 2, REQ: 3 }
const TDS_VERSION = 0x74000004
const PACKET_SIZE = 4096
/** The row cap, applied while READING — see query(). */
const DEFAULT_ROW_LIMIT = 200
const MAX_ROW_LIMIT = 5000
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 120_000
/**
 * Deadlines for the two phases that used to have none.
 *
 * Without these the driver simply waited: a refused or filtered port, or a server that
 * never answers the login, hung until the BROWSER's 20-second fetch limit fired — so
 * every cause looked like "请求超时", and the one message that would have helped
 * ("nothing is listening on that port") was never produced.
 */
const CONNECT_TIMEOUT_MS = 10_000
const LOGIN_TIMEOUT_MS = 20_000

function clampLimit(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ROW_LIMIT
  return Math.min(MAX_ROW_LIMIT, Math.floor(raw))
}

/**
 * How long a STATEMENT may take before it is abandoned.
 *
 * Connect and login always had deadlines; the statements did not, and that asymmetry is
 * what the card showed as "网络错误：signal timed out": a server that accepts the login and
 * then never answers a query left the route open until the browser gave up, with nothing
 * to report. The connection's own timeout (default 20s, clamped by the contract) is the
 * budget — the same number the panel passes down.
 */
function clampTimeout(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(500, Math.round(raw)))
}

/**
 * The password obfuscation LOGIN7 specifies (MS-TDS 2.2.6.4).
 *
 * Each byte: swap its nibbles, then XOR with 0xA5. It is not encryption and is not meant
 * to be — but it IS specified, so getting it wrong means the server sees a wrong password
 * and reports "login failed", which is a miserable way to discover a bug.
 */
export function obfuscatePassword(password) {
  const source = Buffer.from(String(password), 'utf16le')
  const out = Buffer.alloc(source.length)
  for (let i = 0; i < source.length; i += 1) {
    const byte = source[i]
    out[i] = (((byte << 4) & 0xf0) | ((byte >> 4) & 0x0f)) ^ 0xa5
  }
  return out
}

/** UTF-16LE, which is what every string in TDS is. */
function ucs2(text) {
  return Buffer.from(String(text), 'utf16le')
}

/** The 8-byte packet header. `length` includes the header itself. */
function packet(type, payload, packetId) {
  const header = Buffer.alloc(8)
  header.writeUInt8(type, 0)
  header.writeUInt8(1, 1) // status: EOM — one message, one packet, unless it is long
  header.writeUInt16BE(payload.length + 8, 2)
  header.writeUInt16BE(0, 4) // SPID
  header.writeUInt8(packetId & 0xff, 6)
  header.writeUInt8(0, 7) // window
  return Buffer.concat([header, payload])
}

/** PRELOGIN, with the option table the spec requires. */
function preloginPacket(offer = ENCRYPT.OFF) {
  // The client's own version, then its encryption preference: ENCRYPT_OFF by default
  // ("encryption is available but not required — the server answers with what it
  // wants"), and ENCRYPT_NOT_SUP on the retry below, where the login really is going
  // out in the clear and saying otherwise is a lie the server can detect.
  const version = Buffer.alloc(6)
  const encryption = Buffer.from([offer])
  const entries = [
    { token: 0x00, data: version },
    { token: 0x01, data: encryption },
  ]
  const table = []
  let offset = entries.length * 5 + 1
  for (const entry of entries) {
    const row = Buffer.alloc(5)
    row.writeUInt8(entry.token, 0)
    row.writeUInt16BE(offset, 1)
    row.writeUInt16BE(entry.data.length, 3)
    table.push(row)
    offset += entry.data.length
  }
  return packet(PACKET.PRELOGIN, Buffer.concat([...table, Buffer.from([0xff]), ...entries.map((e) => e.data)]), 1)
}

/**
 * LOGIN7. The layout is fixed fields, then a table of (offset, length) pairs, then the
 * variable data.
 *
 * The offsets are measured from the start of the LOGIN7 STRUCTURE — not from the start
 * of the TDS packet header. This used to be `8 + fixed`, i.e. 102, on the theory that
 * the header counted; measured against a real server that is simply wrong, and a server
 * that dislikes it does not answer at all (no ERROR token — silence). MS-TDS 2.2.6.4
 * states it for the OffsetLength rule ("the offset from the start of the structure")
 * and `Length` below is likewise the structure length, header excluded.
 */
function login7Packet({ host, user, password, database, appName }) {
  const encoded = {
    host: ucs2(host),
    user: ucs2(user),
    password: obfuscatePassword(password),
    app: ucs2(appName),
    server: ucs2(host),
    database: ucs2(database),
  }
  const fixed = 94
  let cursor = fixed
  const slots = {}
  for (const [key, buffer] of Object.entries(encoded)) {
    slots[key] = { offset: cursor, chars: buffer.length / 2 }
    cursor += buffer.length
  }
  const head = Buffer.alloc(fixed)
  head.writeUInt32LE(0, 0) // Length, patched below
  head.writeUInt32LE(TDS_VERSION, 4)
  head.writeUInt32LE(PACKET_SIZE, 8)
  head.writeUInt32LE(0, 12) // ClientProgVer
  head.writeUInt32LE(process.pid ?? 0, 16)
  head.writeUInt32LE(0, 20) // ConnectionID
  head.writeUInt8(0xe0, 24) // OptionFlags1: use the named database, IEEE float, x86 order
  head.writeUInt8(0x03, 25) // OptionFlags2: init language + ODBC
  head.writeUInt8(0x00, 26) // TypeFlags: SQL authentication
  head.writeUInt8(0x00, 27) // OptionFlags3
  head.writeUInt32LE(0, 28) // ClientTimeZone
  head.writeUInt32LE(0x0409, 32) // ClientLCID: en-US
  let at = 36
  const put = (key, length) => {
    if (key === null) {
      head.writeUInt16LE(0, at)
      head.writeUInt16LE(length, at + 2)
    } else {
      head.writeUInt16LE(slots[key].offset, at)
      head.writeUInt16LE(slots[key].chars, at + 2)
    }
    at += 4
  }
  put('host', 0)
  put('user', 0)
  put('password', 0)
  put('app', 0)
  put('server', 0)
  put(null, 0) // extension
  put('app', 0) // CltIntName
  put(null, 0) // language
  put('database', 0)
  head.write('000000000000', 36 + 36, 'hex') // ClientID
  put(null, 0) // SSPI
  put(null, 0) // AtchDBFile
  put(null, 0) // ChangePassword
  head.writeUInt32LE(0, 36 + 36 + 6 + 4 + 4 + 4) // cbSSPILong
  const body = Buffer.concat([encoded.host, encoded.user, encoded.password, encoded.app, encoded.server, encoded.database])
  head.writeUInt32LE(head.length + body.length, 0)
  return packet(PACKET.LOGIN7, Buffer.concat([head, body]), 1)
}

/**
 * A SQL_BATCH message. The ALL_HEADERS block carries a transaction descriptor; all zeros
 * means "not in a transaction", which is exactly what a read wants.
 */
function batchPackets(sql) {
  const header = Buffer.alloc(22)
  header.writeUInt32LE(22, 0) // total header length, including this field
  header.writeUInt32LE(18, 4) // length of the headers after this field
  header.writeUInt16LE(2, 8) // TM_REQUEST
  header.writeUInt32LE(0, 10) // transaction descriptor, low
  header.writeUInt32LE(0, 14) // transaction descriptor, high
  header.writeUInt32LE(1, 18) // outstanding request count
  const text = ucs2(`${sql}\n`)
  const payload = Buffer.concat([header, text])
  // A message longer than one packet is split, and only the LAST carries the EOM flag.
  const chunks = []
  for (let offset = 0; offset < payload.length; offset += PACKET_SIZE - 8) {
    chunks.push(payload.subarray(offset, offset + PACKET_SIZE - 8))
  }
  return chunks.map((chunk, index) => {
    const frame = packet(PACKET.SQL_BATCH, chunk, (index + 1) & 0xff)
    if (index < chunks.length - 1) frame.writeUInt8(0, 1) // not the end of the message
    return frame
  })
}

/** A cursor over one TDS message, so the token parsers read like the spec. */
class Reader {
  constructor(buffer) {
    this.buffer = buffer
    this.at = 0
  }

  get done() {
    return this.at >= this.buffer.length
  }

  u8() {
    return this.buffer.readUInt8(this.at++)
  }

  u16() {
    const value = this.buffer.readUInt16LE(this.at)
    this.at += 2
    return value
  }

  u32() {
    const value = this.buffer.readUInt32LE(this.at)
    this.at += 4
    return value
  }

  i32() {
    const value = this.buffer.readInt32LE(this.at)
    this.at += 4
    return value
  }

  i64() {
    const value = this.buffer.readBigInt64LE(this.at)
    this.at += 8
    return value
  }

  skip(count) {
    this.at += count
  }

  bytes(count) {
    const value = this.buffer.subarray(this.at, this.at + count)
    this.at += count
    return value
  }

  /** B_VARCHAR: a one-byte length in CHARACTERS, then that many UTF-16 code units. */
  bVarchar() {
    const chars = this.u8()
    return this.bytes(chars * 2).toString('utf16le')
  }

  /** US_VARCHAR: a two-byte length, in CHARACTERS. Used inside ERROR/INFO tokens. */
  usVarchar() {
    const chars = this.u16()
    return this.bytes(chars * 2).toString('utf16le')
  }
}

/** Decode one column value. `meta` is what COLMETADATA said about it. */
function decodeValue(reader, meta) {
  const { type, maxlen, scale } = meta
  /**
   * BYTELEN types — INTN, BITN, FLTN, MONEYN, DATETIMEN, TIMEN, DATETIME2N,
   * DATETIMEOFFSETN, DECIMALN/NUMERICN and GUIDN — carry a ONE-byte length, and 0 means
   * NULL. Reading two bytes here is what made `select count(*)` answer 54324743469268992
   * against a real server instead of 18: the value's own `04` was swallowed as the high
   * half of a 4612-byte length.
   */
  const byteLength = () => {
    const length = reader.u8()
    return length === 0 ? null : reader.bytes(length)
  }
  /** USHORTLEN types — the BIGCHAR/BIGVARCHAR/NVARCHAR/NCHAR family — use two, and 0xFFFF means NULL. */
  const variable = () => {
    const length = reader.u16()
    if (length === 0xffff) return null
    return reader.bytes(length)
  }
  /**
   * PLP — the framing every MAX type uses, and XML always uses. Measured on a live 2008 R2,
   * because it is the one shape that only shows up on real data:
   *
   *   cast('hi' as nvarchar(max)) → 04 00 00 00 00 00 00 00 | 04 00 00 00 | 68 00 69 00 | 00 00 00 00
   *                                 └─ total length (ULONG, 8 bytes) ─┘  └ chunk ┘  └terminator┘
   *
   * The total is 0xFFFFFFFFFFFFFFFE when the server does not know it in advance, and
   * 0xFFFFFFFFFFFFFFFF means NULL. Chunks follow until one is zero bytes long. Reading a
   * MAX column as an ordinary NVARCHAR instead asks for 65535 bytes and throws.
   */
  const plp = () => {
    const total = reader.i64()
    if (total === -1n) return null // 0xFFFFFFFFFFFFFFFF
    const chunks = []
    for (;;) {
      const size = reader.u32()
      if (size === 0) break
      chunks.push(reader.bytes(size))
    }
    return Buffer.concat(chunks)
  }
  /** MAX columns: PLP; everything else in the family: a USHORT length. */
  const charValue = (maxlen) => (maxlen === 0xffff ? plp() : variable())
  switch (type) {
    case 0x1f: return null // NULLTYPE
    case 0x30: return reader.u8() // INT1
    case 0x32: return reader.u8() !== 0 // BIT
    case 0x34: return reader.u16() // INT2
    case 0x38: return reader.u32() // INT4
    case 0x3b: return reader.buffer.readFloatLE((reader.at += 4) - 4) // FLT4
    // MONEY is 8 bytes fixed: the HIGH 32 bits first, then the LOW 32 — both little
    // endian within themselves. Reading only the first four bytes both lost the value
    // (every money column came out 0) and left the stream four bytes short.
    case 0x3c: {
      const high = reader.i32()
      const low = reader.u32()
      return Number(((high * 4294967296 + low) / 10000).toFixed(4))
    }
    case 0x3d: { // DATETIME: days since 1900-01-01, then 1/300s ticks
      const days = reader.i32()
      const ticks = reader.u32()
      return sqlDate(new Date(Date.UTC(1900, 0, 1) + days * 86_400_000 + Math.round(ticks / 300) * 1000))
    }
    case 0x3e: return reader.buffer.readDoubleLE((reader.at += 8) - 8) // FLT8
    case 0x7f: return reader.i64().toString() // INT8, as text: JSON cannot hold it exactly
    case 0x24: { // GUIDN
      const value = byteLength()
      if (value === null) return null
      const hex = value.toString('hex')
      return `${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase()
    }
    case 0x26: { const v = byteLength(); if (v === null) return null; return v.length === 1 ? v.readInt8(0) : v.length === 2 ? v.readInt16LE(0) : v.length === 4 ? v.readInt32LE(0) : v.readBigInt64LE(0).toString() }
    case 0x68: { const v = byteLength(); return v === null ? null : v[0] !== 0 }
    case 0x6d: { const v = byteLength(); if (v === null) return null; return v.length === 4 ? v.readFloatLE(0) : v.readDoubleLE(0) }
    case 0x6e: { // MONEYN — same high/low word order as MONEY, with a length byte
      const v = byteLength()
      if (v === null) return null
      return Number(((v.readInt32LE(0) * 4294967296 + v.readUInt32LE(4)) / 10000).toFixed(4))
    }
    case 0x6f: { // DATETIMEN
      const v = byteLength()
      if (v === null) return null
      const days = v.readInt32LE(0)
      const ticks = v.readUInt32LE(4)
      return sqlDate(new Date(Date.UTC(1900, 0, 1) + days * 86_400_000 + Math.round(ticks / 300) * 1000))
    }
    case 0x28: { const v = byteLength(); if (v === null) return null; const days = v.readUIntLE(0, 3); return sqlDate(new Date(DATE_EPOCH + days * 86_400_000)) }
    case 0x29: { // TIMEN: a time-of-day in units of 10^-scale seconds
      const v = byteLength()
      if (v === null) return null
      let units = 0n
      for (let i = v.length - 1; i >= 0; i -= 1) units = (units << 8n) | BigInt(v[i])
      const divisor = 10n ** BigInt(scale ?? 7)
      return `${formatTime(units / divisor)}.${(units % divisor).toString().padStart(scaleDigits(scale), '0')}`
    }
    case 0x2a: { // DATETIME2N: time (5 bytes) then date (3 bytes)
      const v = byteLength()
      if (v === null) return null
      let units = 0n
      for (let i = 4; i >= 0; i -= 1) units = (units << 8n) | BigInt(v[i])
      const divisor = 10n ** BigInt(scale ?? 7)
      const days = v.readUIntLE(5, 3)
      const date = new Date(DATE_EPOCH + days * 86_400_000)
      return `${date.toISOString().slice(0, 10)} ${formatTime(units / divisor)}.${(units % divisor).toString().padStart(scaleDigits(scale), '0')}`
    }
    case 0x2b: { // DATETIMEOFFSETN
      const v = byteLength()
      if (v === null) return null
      let units = 0n
      for (let i = 4; i >= 0; i -= 1) units = (units << 8n) | BigInt(v[i])
      const divisor = 10n ** BigInt(scale ?? 7)
      const days = v.readUIntLE(5, 3)
      const offset = v.readInt16LE(8)
      const date = new Date(DATE_EPOCH + days * 86_400_000)
      const sign = offset < 0 ? '-' : '+'
      const mins = Math.abs(offset)
      return `${date.toISOString().slice(0, 10)} ${formatTime(units / divisor)}.${(units % divisor).toString().padStart(scaleDigits(scale), '0')} ${sign}${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
    }
    case 0x6a: // DECIMALN — 'numeric' is the same wire type
    case 0x6c: {
      const v = byteLength()
      if (v === null || v.length === 0) return null
      /**
       * Measured against a real SQL Server 2008 R2 rather than assumed, because every
       * wrong guess here still produces something that LOOKS like a decimal:
       *
       *   cast(12.34 as decimal(10,2))   → 05 | 01 d2 04 00 00
       *   cast(-0.50 as decimal(10,2))   → 05 | 00 32 00 00 00
       *   cast(-12345.678 as decimal(12,3)) → 05 | 00 4e 61 bc 00
       *
       * so the layout is a SIGN BYTE (0x01 positive, 0x00 negative) followed by the
       * magnitude, little-endian — not a two's complement over the whole value, and not a
       * sign bit in the last byte. The first of those turned 12.34 into
       * -47223664828696452124.62 and the second turned -0.50 into 184467440737095515.66.
       */
      const negative = v[0] === 0x00
      const text = decimalText(v.subarray(1), scale)
      return negative ? `-${text}` : text
    }

    case 0xa5: case 0xad: case 0xaf: case 0xa7: { // binary / char types
      const v = charValue(maxlen)
      if (v === null) return null
      if (type === 0xaf || type === 0xa7) return v.toString('latin1')
      return v.length === 0 ? '' : `<${v.length} bytes · ${v.subarray(0, 8).toString('hex')}>`
    }
    case 0xe7: case 0xef: { // NVARCHAR / NCHAR
      const v = charValue(maxlen)
      return v === null ? null : v.toString('utf16le')
    }
    // TEXT / NTEXT are the legacy types: a one-byte length, and 0 means NULL.
    case 0x23: case 0x63: {
      const v = byteLength()
      if (v === null) return null
      return type === 0x63 ? v.toString('utf16le') : v.toString('latin1')
    }
    case 0xf1: { // XML, as text — always PLP
      const v = plp()
      return v === null ? null : v.toString('utf16le')
    }
    case 0x62: { // SQLVARIANT — decode the inner type
      // The row length is a ULONG here, not the USHORT the other variable types use.
      const length = reader.u32()
      const v = length === 0xffffffff ? null : reader.bytes(length)
      if (v === null) return null
      /**
       * Measured: `cast(7 as sql_variant)` arrives as `38 00 07 00 00 00` inside a 6-byte
       * value — the inner type (INT4), one zero byte, then the value. Decoding the value
       * straight after the type reads that pad byte as part of a 4-byte integer and
       * answers 1792 instead of 7.
       */
      const inner = new Reader(v)
      const meta2 = readTypeInfo(inner)
      inner.u8()
      return decodeValue(inner, meta2)
    }
    default: {
      // Not a type this driver decodes. Read its bytes if it is variable-length, and say
      // what it was rather than inventing a value.
      try {
        const v = variable()
        return v === null ? null : `<type 0x${type.toString(16)}>`
      } catch {
        return `<type 0x${type.toString(16)}>`
      }
    }
  }
}

/** How many decimal places a time value carries at this scale. */
function scaleDigits(scale) {
  return Math.max(0, Math.min(7, Number(scale) ?? 7))
}

function formatTime(totalSeconds) {
  const seconds = Math.trunc(Number(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function decimalText(bytes, scale) {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i])
  const digits = scaleDigits(scale)
  if (digits === 0) return value.toString()
  const text = value.toString().padStart(digits + 1, '0')
  return `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`
}

/**
 * Day zero of the DATE / DATETIME2 / DATETIMEOFFSET calendar: 0001-01-01.
 *
 * NOT `Date.UTC(1, 0, 1)` — JavaScript maps years 0..99 to 1900+year, so that expression
 * is 1901-01-01. A live `cast('2024-03-05' as date)` came back as 3924-03-05, which is
 * exactly that 1900-year lie, and it is the kind of wrong that still looks like data.
 */
const DATE_EPOCH = (() => {
  const epoch = new Date(0)
  epoch.setUTCFullYear(1, 0, 1)
  epoch.setUTCHours(0, 0, 0, 0)
  return epoch.getTime()
})()

/** A JS Date is JSON-safe; a Date is also what a caller expects for a date column. */
function sqlDate(date) {
  return date.toISOString().replace('T', ' ').slice(0, 23)
}

/** The type-specific part of a COLMETADATA column entry. */
function readTypeInfo(reader) {
  const type = reader.u8()
  const meta = { type, maxlen: undefined, precision: undefined, scale: undefined }
  switch (type) {
    case 0x6a: case 0x6c:
      meta.maxlen = reader.u8()
      meta.precision = reader.u8()
      meta.scale = reader.u8()
      break
    case 0x26: case 0x68: case 0x6d: case 0x6e: case 0x6f:
      meta.maxlen = reader.u8()
      break
    /**
     * TIMEN / DATETIME2N / DATETIMEOFFSETN carry exactly ONE type-info byte: the SCALE.
     * The maxlen is implied by it. Reading a maxlen byte first, as this did, shifted every
     * later byte by one — which is why a live \`select cast(... as date), cast(... as time)
     * …\` came back as "offset out of range ... Received 255", and why a table's column
     * names turned into mojibake starting at its first datetime2 column.
     *
     * Measured: \`cast('13:45:59' as time)\` → \`29 07 01 74 00\` = type, scale 7, name
     * length 1, "t". The DEFAULT scale is 7, which is what makes it look like a length.
     */
    case 0x29: case 0x2a: case 0x2b:
      meta.scale = reader.u8()
      break
    // The USHORTLEN family. The BINARY types carry no collation…
    case 0xa5: case 0xad:
      meta.maxlen = reader.u16()
      break
    // …but every CHARACTER type carries a 5-byte COLLATION between the length and the
    // column name (MS-TDS 2.2.5.4.3). It was missing here, so against a real server the
    // column name and the ROW token after it were read five bytes early: `select
    // @@version` came back as "不认识的 token 0x8c" — literally the first byte of that
    // row's text.
    case 0xa7: case 0xaf: case 0xe7: case 0xef:
      meta.maxlen = reader.u16()
      reader.skip(5)
      break
    // GUIDN: one length byte in the type info, 16 in the value. Without this case a
    // uniqueidentifier column shifts every later byte by one — a live \`select * from
    // sys.databases\` turned the following column names into mojibake.
    case 0x24:
      meta.maxlen = reader.u8()
      break
    // XML: a "schema present" flag, then three B_VARCHAR names when it is set. The flag is
    // the byte that was being read as the next column's name length.
    case 0xf1:
      if (reader.u8() !== 0) {
        reader.bVarchar()
        reader.bVarchar()
        reader.bVarchar()
      }
      break
    // SQLVARIANT: a 4-byte MaxLen here, and the value carries its own inner type info.
    case 0x62:
      meta.maxlen = reader.u32()
      break
    // TEXT/NTEXT carry a collation too, between the 4-byte length and the table name.
    case 0x23: case 0x63:
      meta.maxlen = reader.u32()
      reader.skip(5)
      break
    // IMAGE has none: just the length, then the table name.
    case 0x22:
      meta.maxlen = reader.u32()
      break
    case 0xf0: // CLR UDT: length, then four B_VARCHAR names
      meta.maxlen = reader.u16()
      reader.bVarchar()
      reader.bVarchar()
      reader.bVarchar()
      reader.bVarchar()
      break
    default:
      break
  }
  return meta
}

/**
 * One parsed server message: the rows, whatever the server said about them, and whether
 * the batch is finished. Kept as plain data so the fake server in the tests can produce
 * exactly the same shape the real one produces.
 */
export function parseTokens(buffer) {
  const reader = new Reader(buffer)
  const columns = []
  const rows = []
  const messages = []
  let done = false
  let rowcount = null
  while (!reader.done) {
    const token = reader.u8()
    if (token === TOKEN.COLMETADATA) {
      const count = reader.u16()
      columns.length = 0
      if (count !== 0xffff) {
        for (let i = 0; i < count; i += 1) {
          const usertype = reader.u32()
          const flags = reader.u16()
          const meta = readTypeInfo(reader)
          const name = reader.bVarchar()
          // TEXT/NTEXT/IMAGE also carry the table name in the metadata.
          if (meta.type === 0x23 || meta.type === 0x63 || meta.type === 0x22) reader.bVarchar()
          columns.push({ name, usertype, flags, ...meta })
        }
      }
    } else if (token === TOKEN.ROW || token === TOKEN.NBCROW) {
      const nulls = token === TOKEN.NBCROW ? reader.bytes(Math.ceil(columns.length / 8)) : null
      const row = columns.map((meta, index) => {
        if (nulls !== null && (nulls[index >> 3] & (1 << (index & 7))) !== 0) return null
        return decodeValue(reader, meta)
      })
      rows.push(row)
    } else if (token === TOKEN.ERROR || token === TOKEN.INFO) {
      const length = reader.u16()
      const end = reader.at + length
      const number = reader.u32()
      const state = reader.u8()
      const klass = reader.u8()
      const text = reader.usVarchar()
      const server = reader.bVarchar()
      const proc = reader.bVarchar()
      const line = reader.u32()
      messages.push({ token: token === TOKEN.ERROR ? 'error' : 'info', number, state, class: klass, text, server, proc, line })
      // Trust the token's own length over my field list: a token I mis-parse by one byte
      // would otherwise corrupt every token after it.
      reader.at = end
    } else if (token === TOKEN.LOGINACK) {
      const length = reader.u16()
      const end = reader.at + length
      const iface = reader.u8()
      const version = reader.u32()
      const name = reader.bVarchar()
      const progVersion = reader.u32()
      messages.push({ token: 'loginack', iface, version, name, progVersion })
      reader.at = end
    } else if (token === TOKEN.RETURNSTATUS) {
      // A stored procedure's return value: 4 bytes, and nothing the card shows.
      reader.at += 4
    } else if (token === TOKEN.ORDER || token === TOKEN.TABNAME || token === TOKEN.COLINFO) {
      // Length-prefixed and useless to the card: skip the whole token.
      const length = reader.u16()
      reader.at += length
    } else if (token === TOKEN.FEDAUTHINFO) {
      /**
       * A DWORD length, not a WORD — see the note on TOKEN.FEDAUTHINFO.
       *
       * And the length is CHECKED before it is trusted. If the stream were misaligned
       * rather than genuinely carrying this token, the four bytes here are row data and
       * the "length" is arbitrary; skipping by it would eat the rest of the reply and
       * hand back a result that looks real. A length that cannot fit is therefore the
       * original error, unchanged, so the next person gets the same honest message
       * instead of a silently wrong table.
       */
      const length = reader.u32()
      if (reader.at + length > reader.buffer.length) {
        throw new Error(`TDS: 不认识的 token 0x${token.toString(16)}（第 ${reader.at - 5} 字节）`)
      }
      reader.at += length
    } else if (token === TOKEN.ENVCHANGE) {
      const length = reader.u16()
      const end = reader.at + length
      const kind = reader.u8()
      const variable = !(kind === 1 || kind === 2 || kind === 3 || kind === 4 || kind === 19)
      const readOne = () => {
        if (variable) {
          const bytes = reader.u8()
          return reader.bytes(bytes).toString('utf16le')
        }
        const chars = reader.u8()
        return reader.bytes(chars * 2).toString('utf16le')
      }
      const value = readOne()
      const old = readOne()
      messages.push({ token: 'envchange', kind, value, old })
      reader.at = end
    } else if (token === TOKEN.DONE || token === TOKEN.DONEPROC || token === TOKEN.DONEINPROC) {
      const status = reader.u16()
      const curcmd = reader.u16()
      const count = reader.i64()
      if (token === TOKEN.DONE) {
        done = true
        rowcount = count
      }
      void status
      void curcmd
    } else {
      /**
       * An unknown token has no length to skip by, so continuing would be guessing.
       * Naming it is more useful than a corruption two tokens later.
       *
       * The first bytes go in too, because "token 0xee at byte 0" has two very different
       * causes that the number alone cannot separate: a token this table does not know,
       * or a stream that is not token data at all (a session the server encrypted while
       * the driver read it raw, where byte 8 of a TLS record is an arbitrary byte). A
       * hex preview settles it on sight — `ee 00 00 00` is FEDAUTHINFO, `17 03 03` is a
       * TLS record — instead of another round of questions.
       */
      const head = reader.buffer.subarray(0, 16).toString('hex').replace(/(..)(?=.)/g, '$1 ')
      throw new Error(`TDS: 不认识的 token 0x${token.toString(16)}（第 ${reader.at - 1} 字节）`
        + `；应答开头 ${head}，共 ${reader.buffer.length} 字节`)
    }
  }
  return { columns, rows, messages, done, rowcount }
}

/** The schema listing, as plain SELECTs — no catalog stored procedures needed. */
export function objectsQuery() {
  return `SELECT s.name AS schema_name, o.name AS object_name,
       CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' ELSE LOWER(o.type) END AS kind
  FROM sys.objects o
  JOIN sys.schemas s ON s.schema_id = o.schema_id
 WHERE o.type IN ('U', 'V')
 ORDER BY s.name, o.name`
}

export function columnsQuery() {
  return `SELECT s.name AS schema_name, o.name AS object_name, c.name AS column_name,
       t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable,
       CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_primary_key
  FROM sys.columns c
  JOIN sys.objects o ON o.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  JOIN sys.types t ON t.user_type_id = c.user_type_id
  LEFT JOIN (
       SELECT ic.object_id, ic.column_id
         FROM sys.index_columns ic
         JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
  ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
 WHERE o.type IN ('U', 'V')
 ORDER BY s.name, o.name, c.column_id`
}

/** Is this a statement the driver is willing to send on a read-only connection? */
export function looksLikeWrite(sql) {
  const text = String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  return /^\s*(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|backup|restore|deny|bulk)\b/i.test(text)
    || /\b(into)\s+[#@\w]/i.test(text) && /^\s*select/i.test(text)
}

/**
 * ── the session ─────────────────────────────────────────────────────────────
 *
 * A socket, a buffer of reassembled messages, and one pending request at a time. Every
 * read is capped while it is READ, not by rewriting the query: adding `TOP n` to someone
 * else's SQL changes what it means (it does not compose with UNION, ORDER BY or a CTE),
 * which is the same reason the other drivers cap the same way.
 */
class TdsSession {
  constructor(socket, info, options) {
    this.socket = socket
    this.info = info
    this.limit = clampLimit(options.limit)
    // The statement deadline, from the connection's own timeout (clamped by the contract).
    this.timeoutMs = clampTimeout(options.timeoutMs)
    this.pending = null
    /** Payloads of the packets of the message being assembled — see `onData`. */
    this.parts = []
    this.buffer = []
    socket.on('data', (chunk) => this.onData(chunk))
  }

  onData(chunk) {
    this.buffer.push(chunk)
    const whole = Buffer.concat(this.buffer)
    let at = 0
    /**
     * The packets collected SO FAR for the message being assembled — and it has to live on
     * the session, not in this call.
     *
     * A reply larger than one TCP delivery arrives in several `data` events. The packets
     * that were complete in an earlier event used to be pushed into a LOCAL array, which
     * was then thrown away by the `break` below, so the next event started the message over
     * from the packets that were still buffered: the payload lost its beginning and the
     * parse started in the middle of a row. Measured on a real server: the schema listing
     * (22852 bytes, six packets, the only big reply this driver sends) failed with
     * "不认识的 token 0x0（第 0 字节）" — byte zero of a message whose real first byte is
     * 0x81 — while every small statement worked.
     */
    while (at + 8 <= whole.length) {
      const length = whole.readUInt16BE(at + 2)
      if (length < 8 || at + length > whole.length) break
      const status = whole.readUInt8(at + 1)
      this.parts.push(whole.subarray(at + 8, at + length))
      const type = whole.readUInt8(at)
      at += length
      if ((status & 0x01) !== 0) {
        this.buffer = [whole.subarray(at)]
        const payload = Buffer.concat(this.parts)
        this.parts = []
        const request = this.pending
        this.pending = null
        if (request !== null) {
          if (type === PACKET.REPLY) {
            try {
              request.resolve(payload)
            } catch (error) {
              request.reject(error)
            }
          } else {
            request.reject(new Error(`TDS: 期望应答包，收到类型 0x${type.toString(16)}`))
          }
        }
        return
      }
    }
    this.buffer = [whole.subarray(at)]
  }

  send(buffers) {
    return new Promise((resolve, reject) => {
      if (this.pending !== null) {
        reject(new Error('TDS: 一次只能执行一条语句'))
        return
      }
      this.pending = { resolve, reject }
      for (const buffer of buffers) this.socket.write(buffer)
    })
  }

  /** Reject a statement that has not answered in `this.timeoutMs`. */
  #withStatementDeadline(promise, sql) {
    const ms = Number(this.timeoutMs)
    if (!Number.isFinite(ms) || ms <= 0) return promise
    let timer
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const head = String(sql).trim().split(/\s+/).slice(0, 6).join(' ')
        reject(new Error(`语句超过 ${Math.round(ms / 1000)} 秒没有回应（${head}…）—— 服务器接受了连接，但没有回答这条语句`))
      }, ms)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
  }

  /**
   * Send one batch and read its reply, with a DEADLINE.
   *
   * Connect and login have had timeouts for a while; the statements did not — so a server
   * that accepts the login and then never answers a query left the panel's route open
   * until the browser gave up (20s), which the card can only report as "网络错误：signal
   * timed out". A timeout here turns that into a sentence about the statement.
   */
  async run(sql) {
    const payload = await this.#withStatementDeadline(this.send(batchPackets(sql)), sql)
    const parsed = parseTokens(payload)
    const failure = parsed.messages.find((message) => message.token === 'error' && message.class >= 11)
    if (failure !== undefined) {
      // The whole token, not just its text: the class and the state are what separate a
      // syntax error from a permissions error.
      const error = new Error(`[SQL Server ${failure.number}] ${failure.text.trim()}`)
      error.server = { ...failure, code: failure.number }
      throw error
    }
    // A row cap applied while reading: the server sends everything, and this stops
    // collecting. The count is reported so "truncated" is never a guess.
    const rows = parsed.rows.slice(0, this.limit)
    return {
      columns: parsed.columns.map((column) => column.name),
      rows,
      truncated: parsed.rows.length > this.limit,
      notices: parsed.messages.filter((message) => message.token === 'info').map((message) => message.text.trim()),
    }
  }

  /**
   * The panel's per-statement entry point.
   *
   * `lib/sql/index.js#runStatement` calls `session.query(sql, { limit, timeoutMs,
   * readOnly })` on EVERY driver, and this class only ever had `run(sql)` — so a
   * SQL Server statement failed with `session.query is not a function` on a
   * connection that had just logged in successfully. The card could test a
   * connection and never run anything on it.
   *
   * `timeoutMs` and `readOnly` belong to the caller: the panel classifies the
   * statement and refuses writes before it gets here, and the batch is always a
   * plain request. The row cap is ours, and it is applied while READING — the
   * server still sends everything.
   *
   * @param {string} sql
   * @param {{ limit?: number }} [options]
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

  async columnsOf(schema, object) {
    const quoted = (text) => `'${String(text).replace(/'/g, "''")}'`
    const result = await this.run(`${columnsQuery()} AND s.name = ${quoted(schema)} AND o.name = ${quoted(object)}`)
    return result.rows.map((row) => ({
      name: row[2],
      type: row[3],
      nullable: row[7] === true || row[7] === 1 || row[7] === '1',
      primaryKey: row[8] === 1 || row[8] === true || row[8] === '1',
    }))
  }

  async schemas() {
    const objects = await this.run(objectsQuery())
    const bySchema = new Map()
    for (const row of objects.rows) {
      const [schema, name, kind] = row
      if (!bySchema.has(schema)) bySchema.set(schema, [])
      bySchema.get(schema).push({ name, kind, columns: [] })
    }
    // Columns are one query for the whole database rather than one per object: a server
    // round trip per table is what makes a schema tree feel slow.
    const columns = await this.run(columnsQuery())
    const index = new Map()
    for (const object of bySchema.values()) {
      for (const entry of object) index.set(`${entry.name}`, entry)
    }
    for (const row of columns.rows) {
      const [, object, column, type, , , , nullable, primaryKey] = row
      const entry = index.get(object)
      if (entry === undefined) continue
      entry.columns.push({
        name: column,
        type,
        nullable: nullable === true || nullable === 1 || nullable === '1',
        primaryKey: primaryKey === 1 || primaryKey === true || primaryKey === '1',
      })
    }
    return [...bySchema.entries()].map(([name, list]) => ({ name, objects: list }))
  }

  close() {
    this.socket.destroy()
  }
}

/** Read exactly one TDS message, across as many packets as it takes. */
function readMessage(socket) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let assembled = Buffer.alloc(0)
    const onData = (chunk) => {
      assembled = Buffer.concat([assembled, chunk])
      let at = 0
      while (at + 8 <= assembled.length) {
        const length = assembled.readUInt16BE(at + 2)
        if (length < 8 || at + length > assembled.length) break
        const status = assembled.readUInt8(at + 1)
        chunks.push(assembled.subarray(at + 8, at + length))
        at += length
        if ((status & 0x01) !== 0) {
          cleanup()
          resolve(Buffer.concat(chunks))
          return
        }
      }
      assembled = assembled.subarray(at)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    // A server that hangs up mid-handshake must FAIL, not wait for ever.
    //
    // `data` and `error` were the only events this listened for, so a peer that
    // closed the connection left this promise pending with no timer and no
    // listener to settle it. That is the whole of "登录超时": SQL Server rejects a
    // login it cannot parse by closing, and the card then had nothing to report
    // and nothing to time out — it simply never answered.
    const onClose = () => {
      cleanup()
      reject(new Error('连接被服务器关闭（没有收到响应）'))
    }
    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      socket.removeListener('end', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('end', onClose)
  })
}

/**
 * LOGIN7 goes out encrypted: the TLS handshake records are carried inside TDS packets
 * (type 0x12) while the handshake runs, and go bare once it finishes — exactly what the
 * platform drivers do. See the header comment for why this is not optional.
 *
 * `release()` hands the raw socket back for the rest of the session. With ENCRYPT_OFF
 * only the login is encrypted, so the server's answer and every later statement are
 * plaintext: TLS must stop consuming the socket or the answer is swallowed.
 */
function tlsOverTds(rawSocket, { host, rejectUnauthorized = false }) {
  let wrapping = true
  let released = false
  let pending = Buffer.alloc(0)
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      if (!wrapping) { rawSocket.write(chunk, done); return }
      // packetId 0: the handshake is part of the PRELOGIN exchange.
      rawSocket.write(packet(PACKET.PRELOGIN, chunk, 0), done)
    },
    final(done) { done() },
  })
  const onRawData = (chunk) => {
    if (released) return
    if (!wrapping) { duplex.push(chunk); return }
    pending = Buffer.concat([pending, chunk])
    // A bare TLS record (0x14..0x17) means the handshake finished and the client side
    // has switched to a plain TLS stream; hand it over unwrapped.
    if (pending.length > 0 && pending.readUInt8(0) !== PACKET.PRELOGIN) {
      duplex.push(pending)
      pending = Buffer.alloc(0)
      return
    }
    let at = 0
    while (at + 8 <= pending.length) {
      if (pending.readUInt8(at) !== PACKET.PRELOGIN) break
      const length = pending.readUInt16BE(at + 2)
      if (length < 8 || at + length > pending.length) break
      duplex.push(pending.subarray(at + 8, at + length))
      at += length
    }
    pending = pending.subarray(at)
  }
  rawSocket.on('data', onRawData)
  rawSocket.on('error', (error) => duplex.destroy(error))
  const secure = tls.connect({
    socket: duplex,
    servername: host,
    rejectUnauthorized,
    // A SQL Server 2008 R2 box offers TLS 1.0 only, which OpenSSL 3 refuses at its
    // default security level. Lowering the floor is what lets the handshake happen at
    // all; the alternative is not connecting to an old server.
    minVersion: 'TLSv1',
    maxVersion: 'TLSv1.2',
    ciphers: 'DEFAULT@SECLEVEL=0',
    // No zero-length first record. OpenSSL splits the first application record as a
    // BEAST mitigation, Schannel does not, and this server ignores a login sent split.
    secureOptions: crypto.constants.SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS,
  })
  const ready = new Promise((resolve, reject) => {
    // Wrap while the handshake runs, stop the moment it finishes: the LOGIN7 record and
    // everything after it go out bare, which is what the platform drivers do and what
    // this server accepts. Doing it here rather than asking the caller to remember.
    secure.once('secureConnect', () => { wrapping = false; resolve() })
    // A persistent handler, not `once`: an error that arrives while nobody is reading
    // (which is the normal state between two statements) would otherwise be an UNHANDLED
    // 'error' event, and that takes the whole DSH host process down with it.
    secure.on('error', (error) => {
      const failure = new Error(`TLS 错误 —— ${error.message}`)
      rawSocket.destroy()
      reject(failure)
    })
  })
  return {
    secure,
    ready,
    stopWrapping: () => { wrapping = false },
    // Detach the TLS layer from the raw socket: everything from here on is plaintext.
    release: () => { released = true; rawSocket.removeListener('data', onRawData) },
  }
}

/** A promise that gives up, so a silent server cannot hang the caller forever. */
function withDeadline(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** The prelogin handshake, which decides whether TLS is required. */
async function prelogin(socket, offer = ENCRYPT.OFF) {
  socket.write(preloginPacket(offer))
  const reply = await readMessage(socket)
  const options = {}
  let at = 0
  while (at + 5 <= reply.length) {
    const token = reply.readUInt8(at)
    at += 1
    if (token === 0xff) break
    // BIG-endian here, and little-endian in LOGIN7's table below. Two tables with two byte
    // orders in one protocol, which is why this is spelled out rather than shared.
    const offset = reply.readUInt16BE(at)
    const length = reply.readUInt16BE(at + 2)
    at += 4
    options[token] = reply.subarray(offset, offset + length)
  }
  // A missing or short ENCRYPTION entry is treated as ENCRYPT_OFF only because the
  // alternative — treating an unreadable answer as "no encryption needed" — is the
  // dangerous one. It is reported so the card can say the negotiation was odd.
  const encryption = options[1] === undefined || options[1].length < 1 ? 0 : options[1][0]
  // The version is optional in the spec but every server sends it; a missing one means
  // the option table was misread, so it is reported as such rather than as "undefined".
  const version = options[0] === undefined || options[0].length < 3
    ? undefined
    : `${options[0][0]}.${options[0][1]}.${options[0][2]}`
  return { encryption, version }
}

export const DRIVER = {
  id: 'sqlserver',
  label: 'SQL Server',
  labelZh: 'SQL Server',
  /**
   * `client` — NOT `engine` and NOT `transaction`. See the note at the top of this file:
   * SQL Server has no read-only transaction, so read-only here is enforced by refusing to
   * send the statement, not by the server refusing to run it. The card says so.
   */
  readonly: 'client',
  defaultPort: 1433,
  fields: [
    { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
    { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '1433', kind: 'number' },
    { key: 'database', label: '数据库', labelEn: 'DATABASE', placeholder: 'master', kind: 'text' },
    { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'sa', kind: 'text' },
    { key: 'encrypt', label: '强制 TLS', labelEn: 'FORCE TLS', kind: 'toggle' },
    { key: 'trustServerCertificate', label: '不校验证书', labelEn: 'TRUST CERT', kind: 'toggle' },
  ],
}

export async function available() {
  // Nothing to probe: this driver needs a socket and the Node it is already running on —
  // the same answer PostgreSQL and MySQL give. SQLite is the one that has to ask whether
  // `node:sqlite` exists in this build.
  return { ok: true }
}

export async function open(profile, { secrets = {} } = {}) {
  const host = profile.host ?? '127.0.0.1'
  const port = Number(profile.port ?? 1433)
  const user = profile.user ?? 'sa'
  const password = typeof secrets.password === 'string' ? secrets.password : ''
  if (profile.auth === 'windows' || profile.integrated === true) {
    throw new Error('SQL Server 的 Windows / AD 认证需要身份提供方的令牌，本驱动只支持 SQL 登录')
  }

  const connect = () => new Promise((resolve, reject) => {
    const candidate = net.connect({ host, port })
    candidate.setNoDelay(true)
    candidate.setTimeout(CONNECT_TIMEOUT_MS, () => {
      candidate.destroy()
      reject(new Error(`连不上 ${host}:${port} —— ${CONNECT_TIMEOUT_MS / 1000} 秒内没有回应。`
        + '常见原因：SQL Server 没有启用 TCP/IP、端口不是这个（命名实例走动态端口，不是 1433）、或者防火墙把包丢了。'))
    })
    candidate.once('connect', () => { candidate.setTimeout(0); resolve(candidate) })
    candidate.once('error', (error) => reject(new Error(`连不上 ${host}:${port} —— ${error.message}`)))
  })

  /**
   * Connect, negotiate, and start the login-packet tunnel if the server can take one.
   *
   * Returns the socket to send LOGIN7 on, the tunnel when the login must be encrypted,
   * and what to report as `encrypt`. A handshake failure is NOT fatal: the caller retries
   * on a FRESH connection with a plaintext login, because a socket that has already sent
   * a ClientHello can never be used for one.
   */
  const negotiate = async (offer = ENCRYPT.OFF) => {
    const socket = await connect()
    const greeting = await withDeadline(prelogin(socket, offer), LOGIN_TIMEOUT_MS,
      `服务器接受了连接但 ${LOGIN_TIMEOUT_MS / 1000} 秒内没有回应 PRELOGIN —— 这个端口上的东西可能不是 SQL Server`)
    /**
     * Which encryption, and it is NOT a yes/no.
     *
     *   ENCRYPT_OFF / ON  the login packet is encrypted, the session stays plaintext
     *                     (OFF) or is encrypted throughout (ON). This is the normal
     *                     case and it is why a plaintext LOGIN7 is ignored.
     *   ENCRYPT_REQ       the server demands encryption for the whole session.
     *   ENCRYPT_NOT_SUP   the server cannot encrypt at all; plaintext is the only way.
     */
    const fullTls = profile.encrypt === true || greeting.encryption === ENCRYPT.REQ || greeting.encryption === ENCRYPT.ON
    const chosen = profile.encrypt === true ? 'tls' : (fullTls ? 'tls' : 'login')
    if (greeting.encryption === ENCRYPT.NOT_SUP) {
      return { socket, greeting, tunnel: undefined, note: 'off（服务器不支持加密）', fullTls: false }
    }
    try {
      // Certificate policy, and the two cases genuinely differ:
      //   login-packet encryption — the server presents the self-signed certificate it
      //     generates when nobody installed one, and the point is to keep the PASSWORD
      //     off the wire. Every Microsoft driver accepts it here, so this does too.
      //   full session encryption (强制 TLS) — the connection's own toggle decides, as
      //     before: a certificate the machine does not trust is the user's call.
      const tunnel = tlsOverTds(socket, {
        host,
        rejectUnauthorized: fullTls ? profile.trustServerCertificate !== true : false,
      })
      await withDeadline(tunnel.ready, LOGIN_TIMEOUT_MS, 'TLS 握手超时 —— 服务器没有完成登录包加密的协商')
      return { socket, greeting, tunnel, note: chosen, fullTls }
    } catch (error) {
      return { socket, greeting, tunnel: undefined, fullTls: false, retryPlaintext: error }
    }
  }

  let attempt = await negotiate()
  if (attempt.retryPlaintext !== undefined) {
    /**
     * A server that offered encryption and then failed the handshake still has to be
     * reachable, and only a NEW connection can carry a plaintext login.
     *
     * The retry must ALSO change what it offers. Re-sending the same ENCRYPT_OFF and
     * then going plaintext is a contradiction the server is entitled to punish: a real
     * SQL Server 2008 R2 (10.50.9) answers such a login by closing the socket without a
     * single token, which used to surface as "登录超时" with nothing to act on. Offering
     * ENCRYPT_NOT_SUP — "this connection is not encrypted" — is what a plaintext login
     * actually means, and the same server then logs in in ~30 ms.
     *
     * A server that REQUIRES encryption is unaffected: it answers ENCRYPT_REQ and the
     * tunnel is used, not this path.
     */
    const reason = attempt.retryPlaintext instanceof Error ? attempt.retryPlaintext.message : String(attempt.retryPlaintext)
    attempt.socket.destroy()
    attempt = await negotiate(ENCRYPT.NOT_SUP)
    if (attempt.tunnel === undefined) attempt.note = `off（${reason}）`
  }
  const { socket, greeting, tunnel, note, fullTls } = attempt

  const login = login7Packet({
    host,
    user,
    password,
    database: profile.database ?? '',
    appName: 'dsh-hud',
  })

  let response
  if (tunnel !== undefined) {
    tunnel.secure.write(login)
    if (fullTls) {
      /**
       * Full-session encryption. The handshake above is the same one the login-only path
       * uses and is exercised by the tests and by real servers; keeping the SESSION inside
       * TLS is the part that has only been checked against the protocol description
       * (impacket keeps its TLS socket for ENCRYPT_ON/REQ the same way), never against a
       * server that demands it. So a failure here is reported as what it is instead of as
       * an OpenSSL string nobody can act on.
       */
      try {
        response = await withDeadline(readMessage(tunnel.secure), LOGIN_TIMEOUT_MS, '登录超时 —— 服务器没有回应登录包')
      } catch (error) {
        throw new Error(`服务器要求整条连接加密（ENCRYPT_REQ），这一步没能完成 —— `
          + `${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      // Login-packet encryption only: the answer comes back in PLAINTEXT, so the TLS
      // layer must let go of the socket or it swallows the very reply we need.
      tunnel.release()
      response = await withDeadline(readMessage(socket), LOGIN_TIMEOUT_MS,
        '登录超时 —— 加密的登录包发出去了，服务器没有回应（用户名/密码/库名是否正确？）')
    }
  } else {
    socket.write(login)
    response = await withDeadline(readMessage(socket), LOGIN_TIMEOUT_MS, '登录超时 —— 服务器没有回应登录包')
  }

  const parsed = parseTokens(response)
  if (parsed.messages.some((message) => message.token === 'loginack') === false) {
    const failure = parsed.messages.find((message) => message.token === 'error')
    throw new Error(failure === undefined
      ? 'SQL Server 没有确认登录（响应里没有 LOGINACK）'
      : `登录失败：${failure.text.trim()}`)
  }
  const database = parsed.messages.filter((message) => message.token === 'envchange' && message.kind === 1).pop()
  const info = {
    host,
    port,
    database: database === undefined ? (profile.database ?? '') : database.value,
    user,
    serverVersion: greeting.version,
    encrypt: note,
  }
  // With login-packet encryption the session runs on the RAW socket (plaintext), which
  // is exactly what the server expects after the login.
  return new TdsSession(fullTls && tunnel !== undefined ? tunnel.secure : socket, info, {
    limit: profile.limit,
    // The connection's own statement budget. Without it the session fell back to the
    // DEFAULT (20s) whatever the profile said, and a statement that never answers took the
    // browser's whole fetch window to fail.
    timeoutMs: profile.timeoutMs,
  })
}