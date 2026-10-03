// A protocol-faithful fake SQL Server, for testing the TDS driver without one.
//
// It is NOT a stub that returns canned bytes to a canned request: it reads the client's
// PRELOGIN and LOGIN7 the way the real server does, DE-OBFUSCATES the password with an
// independent implementation of the specified transform, and refuses a wrong one with a
// real ERROR token. That is what makes the assertions statements about the driver rather
// than about my own idea of it — the same approach as `tools/fake-mysql.mjs`, which
// caught a real framing bug that no amount of self-consistent testing would have.
//
// What it speaks: PRELOGIN (with an encryption answer you choose), LOGIN7, SQL_BATCH, and
// the reply tokens LOGINACK / ENVCHANGE / COLMETADATA / ROW / NBCROW / INFO / ERROR /
// DONE — plus LOGIN PACKET ENCRYPTION, since the driver learned to do it: the TLS
// handshake carried inside PRELOGIN packets, the LOGIN7 decrypted out of it, and the
// session back in plaintext afterwards.
//
// ── why this fake used to agree with a bug ──────────────────────────────────
//
// It read the LOGIN7 offset table the same WRONG way the driver wrote it: as if the
// offsets were measured from the TDS packet header, so it subtracted 8. A real server
// measures them from the start of the LOGIN7 structure, ignores a login that does not,
// and says NOTHING — no error, no disconnect. The two mistakes cancelled out here and
// the driver shipped broken. It now asserts the spec's own rule instead: ibHostName must
// equal 94 (`state.hostNameOffset`), which is the start of the variable data.
import net from 'node:net'
import tls from 'node:tls'
import { Duplex } from 'node:stream'
import { FAKE_TLS_CERT, FAKE_TLS_KEY } from './fake-tls-cert.mjs'

const TDS_VERSION = 0x74000004

/** The inverse of the specified obfuscation — written from the spec, not copied. */
export function deobfuscatePassword(bytes) {
  const out = Buffer.alloc(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) {
    const unxored = bytes[i] ^ 0xa5
    out[i] = ((unxored << 4) & 0xf0) | ((unxored >> 4) & 0x0f)
  }
  return out.toString('utf16le')
}

function packet(type, payload, packetId = 1) {
  const header = Buffer.alloc(8)
  header.writeUInt8(type, 0)
  header.writeUInt8(1, 1) // EOM
  header.writeUInt16BE(payload.length + 8, 2)
  header.writeUInt16BE(0, 4)
  header.writeUInt8(packetId, 6)
  header.writeUInt8(0, 7)
  return Buffer.concat([header, payload])
}

/** PRELOGIN answer: version + the encryption verdict this fake was told to give. */
function preloginReply(encryption) {
  const version = Buffer.from([16, 0, 4, 0, 0, 0])
  const answer = Buffer.from([encryption])
  const entries = [{ token: 0x00, data: version }, { token: 0x01, data: answer }]
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
  return packet(0x04, Buffer.concat([...table, Buffer.from([0xff]), ...entries.map((e) => e.data)]))
}

// ── token writers ────────────────────────────────────────────────────────────
const ucs2 = (text) => Buffer.from(String(text), 'utf16le')
const bVarchar = (text) => {
  const bytes = ucs2(text)
  return Buffer.concat([Buffer.from([bytes.length / 2]), bytes])
}
const usVarchar = (text) => {
  const bytes = ucs2(text)
  const head = Buffer.alloc(2)
  head.writeUInt16LE(bytes.length / 2, 0)
  return Buffer.concat([head, bytes])
}

function loginAck() {
  const body = Buffer.concat([
    Buffer.from([1]), // interface: SQL Server
    Buffer.from([0x04, 0x00, 0x00, 0x74]), // TDS 7.4
    bVarchar('fake-sqlserver'),
    Buffer.from([16, 0, 0, 0]),
  ])
  const head = Buffer.alloc(2)
  head.writeUInt16LE(body.length, 0)
  return Buffer.concat([Buffer.from([0xad]), head, body])
}

function envChange(kind, value) {
  const next = bVarchar(value)
  const old = bVarchar('')
  const body = Buffer.concat([Buffer.from([kind]), next, old])
  const head = Buffer.alloc(2)
  head.writeUInt16LE(body.length, 0)
  return Buffer.concat([Buffer.from([0xe3]), head, body])
}

function errorToken(number, klass, text) {
  const body = Buffer.concat([
    Buffer.from([number & 0xff, (number >> 8) & 0xff, 0, 0]), // number
    Buffer.from([1]), // state
    Buffer.from([klass]), // class
    usVarchar(text),
    bVarchar('fake-sqlserver'),
    bVarchar(''),
    Buffer.from([0, 0, 0, 0]), // line
  ])
  const head = Buffer.alloc(2)
  head.writeUInt16LE(body.length, 0)
  return Buffer.concat([Buffer.from([0xaa]), head, body])
}

function infoToken(number, text) {
  const body = Buffer.concat([
    Buffer.from([number & 0xff, (number >> 8) & 0xff, 0, 0]),
    Buffer.from([1, 0]),
    usVarchar(text),
    bVarchar('fake-sqlserver'),
    bVarchar(''),
    Buffer.from([0, 0, 0, 0]),
  ])
  const head = Buffer.alloc(2)
  head.writeUInt16LE(body.length, 0)
  return Buffer.concat([Buffer.from([0xab]), head, body])
}

function doneToken(rowcount, status = 0) {
  const body = Buffer.alloc(12)
  body.writeUInt16LE(status, 0)
  body.writeUInt16LE(0, 2)
  body.writeBigInt64LE(BigInt(rowcount), 4)
  return Buffer.concat([Buffer.from([0xfd]), body])
}

/**
 * ORDER (MS-TDS 2.2.5.7): the token a server sends for an ordered result. It carries
 * nothing this card shows, and it is length-prefixed — so the client must skip it rather
 * than fail on it. A live 2008 R2 sends one for every `order by`.
 */
function orderToken(columns) {
  const body = Buffer.alloc(2 + columns * 3)
  body.writeUInt16LE(columns, 0)
  for (let i = 0; i < columns; i += 1) {
    body.writeUInt16LE(i, 2 + i * 3)
    body.writeUInt8(1, 4 + i * 3) // ascending
  }
  return Buffer.concat([Buffer.from([0xa9, body.length & 0xff, (body.length >> 8) & 0xff]), body])
}

/** COLMETADATA for the columns a fake result declares. */
function colMetadata(columns) {
  const head = Buffer.alloc(2)
  head.writeUInt16LE(columns.length, 0)
  const parts = [Buffer.from([0x81]), head]
  for (const column of columns) {
    const meta = Buffer.alloc(4)
    meta.writeUInt32LE(0, 0) // usertype
    const flags = Buffer.alloc(2)
    flags.writeUInt16LE(0, 0)
    const typeInfo = []
    if (column.type === 'int') {
      typeInfo.push(Buffer.from([0x26, 4])) // INTN, 4 bytes
    } else if (column.type === 'nvarchar') {
      const maxlen = Buffer.alloc(2)
      maxlen.writeUInt16LE(column.maxlen ?? 200, 0)
      // …and the 5-byte COLLATION a real server sends for every character type. A parser
      // that forgets it reads the column name and the ROW token five bytes early, which
      // is exactly what a live 2008 R2 caught: `select @@version` came back as
      // "不认识的 token 0x8c". The value here is the Chinese_PRC collation that server
      // actually sent.
      typeInfo.push(Buffer.concat([Buffer.from([0xe7]), maxlen, Buffer.from([0x04, 0x08, 0xd0, 0x00, 0x00])]))
    } else if (column.type === 'decimal') {
      typeInfo.push(Buffer.from([0x6a, 9, column.precision ?? 10, column.scale ?? 2]))
    } else if (column.type === 'datetime2') {
      typeInfo.push(Buffer.from([0x2a, 8, column.scale ?? 7]))
    } else if (column.type === 'bit') {
      typeInfo.push(Buffer.from([0x68, 1]))
    } else {
      throw new Error(`fake-tds: unknown column type ${column.type}`)
    }
    parts.push(meta, flags, ...typeInfo, bVarchar(column.name))
  }
  return Buffer.concat(parts)
}

function rowToken(columns, values) {
  const parts = [Buffer.from([0xd1])]
  const nbc = [Buffer.from([0xd2])]
  nbc.push(Buffer.alloc(Math.ceil(columns.length / 8)))
  for (const [index, column] of columns.entries()) {
    const value = values[index]
    if (value === null || value === undefined) {
      if (column.type === 'int' || column.type === 'bit') {
        // INTN/BITN carry a length byte; 0 means NULL.
        parts.push(Buffer.from([0]))
        nbc[1][index >> 3] |= 1 << (index & 7)
      } else if (column.type === 'nvarchar' && (column.maxlen ?? 200) === 0xffff) {
        // A MAX column says NULL with all-ones in the 8-byte PLP total length.
        parts.push(Buffer.alloc(8, 0xff))
        nbc[1][index >> 3] |= 1 << (index & 7)
      } else {
        parts.push(Buffer.from([0xff, 0xff]))
        nbc[1][index >> 3] |= 1 << (index & 7)
      }
      continue
    }
    if (column.type === 'int') {
      const body = Buffer.alloc(5)
      body.writeUInt8(4, 0)
      body.writeInt32LE(value, 1)
      parts.push(body)
      nbc.push(body)
    } else if (column.type === 'bit') {
      const body = Buffer.from([1, value ? 1 : 0])
      parts.push(body)
      nbc.push(body)
    } else if (column.type === 'nvarchar') {
      const bytes = ucs2(value)
      if ((column.maxlen ?? 200) === 0xffff) {
        /**
         * PLP — the framing every MAX type uses (`nvarchar(max)`, `varbinary(max)`, and
         * XML always). Measured on a live server:
         *
         *   cast('hi' as nvarchar(max)) → 04 00 00 00 00 00 00 00 | 04 00 00 00 | 68 00 69 00 | 00 00 00 00
         *
         * A total length (ULONG), then chunks (ULONG length + bytes) until a zero-length
         * one. A driver that reads a MAX column as an ordinary NVARCHAR asks for 65535
         * bytes and throws — which is what `select * from <any table with one>` did.
         */
        const total = Buffer.alloc(8)
        total.writeBigUInt64LE(BigInt(bytes.length), 0)
        const size = Buffer.alloc(4)
        size.writeUInt32LE(bytes.length, 0)
        const body = Buffer.concat([total, size, bytes, Buffer.alloc(4)])
        parts.push(body)
        nbc.push(body)
      } else {
        const len = Buffer.alloc(2)
        len.writeUInt16LE(bytes.length, 0)
        const body = Buffer.concat([len, bytes])
        parts.push(body)
        nbc.push(body)
      }
    } else if (column.type === 'decimal') {
      const scale = column.scale ?? 2
      /**
       * The format a real server uses, measured rather than guessed: a SIGN BYTE
       * (0x01 positive, 0x00 negative) followed by the magnitude, little-endian.
       *
       *   cast(12.34 as decimal(10,2))     → 01 d2 04 00 00
       *   cast(-0.50 as decimal(10,2))     → 00 32 00 00 00
       *   cast(-12345.678 as decimal(12,3)) → 00 4e 61 bc 00
       *
       * This fake used to write a 64-bit two's complement instead, which is why a driver
       * that looked for the sign in the wrong place could pass its own tests and still
       * print -47223664828696452124.62 for 12.34 on a real server.
       */
      const digits = BigInt(Math.round(value * 10 ** scale))
      const negative = digits < 0n
      let magnitude = negative ? -digits : digits
      const width = column.maxlen === undefined ? 4 : column.maxlen - 1
      const bytes = Buffer.alloc(1 + width)
      bytes[0] = negative ? 0x00 : 0x01
      for (let i = 0; i < width; i += 1) {
        bytes[1 + i] = Number(magnitude & 0xffn)
        magnitude >>= 8n
      }
      const body = Buffer.concat([Buffer.from([bytes.length]), bytes])
      parts.push(body)
      nbc.push(body)
    } else {
      throw new Error(`fake-tds: unknown column type ${column.type}`)
    }
  }
  return { row: Buffer.concat(parts), nbc: Buffer.concat(nbc) }
}

/** Drain a byte stream into TDS packets, returning whatever is left over. */
function drain(buffer, onPacket) {
  for (;;) {
    if (buffer.length < 8) return buffer
    const length = buffer.readUInt16BE(2)
    if (buffer.length < length) return buffer
    const type = buffer.readUInt8(0)
    const payload = buffer.subarray(8, length)
    buffer = buffer.subarray(length)
    onPacket(type, payload)
  }
}

/**
 * Start the fake server.
 *
 * `state` is for the test to look at: what the client asked for, and whether it got the
 * password right. `reply` decides what a batch answers — by default, a one-column result.
 */
export async function startFakeSqlServer(options = {}) {
  const password = options.password ?? 'Str0ng!Pass'
  const user = options.user ?? 'sa'
  const database = options.database ?? 'app'
  const encryption = options.encryption ?? 0x00 // ENCRYPT_OFF by default
  /**
   * ENCRYPT_OFF does NOT mean "no encryption". It means the LOGIN7 packet arrives inside
   * a TLS handshake that is itself carried in TDS packets, and the session then goes back
   * to plaintext. Only ENCRYPT_NOT_SUP means a plaintext login is all there is.
   */
  const expectsEncryption = encryption !== 0x02
  const state = {
    prelogins: 0,
    logins: 0,
    batches: [],
    scrambles: [],
    authenticated: false,
    wrongPassword: false,
    sawEncryption: null,
    loginTransport: null,
    hostNameOffset: null,
  }
  const replyFor = options.reply ?? (() => ({
    columns: [{ name: 'nick', type: 'nvarchar' }],
    rows: [['甲'], ['乙'], [null]],
  }))

  const sockets = new Set()
  /**
   * Write a reply the way a real server does: as PACKETS, not as one blob.
   *
   * The length field of a TDS packet is 16 bits and the negotiated packet size is 4096, so
   * a reply bigger than that arrives as several packets — and the schema listing this
   * driver sends (22852 bytes, six packets) is exactly such a reply. A fake that wrote
   * everything in one packet could never produce the case that broke it.
   *
   * `trickle` spaces the packets out so each one arrives in its own `data` event, which is
   * the shape that exposed the bug: packets collected in one event were discarded when the
   * next event arrived, so the message lost its beginning.
   */
  const PACKET_SIZE = 4096
  const replyInPackets = (write) => (bytes) => {
    // Call sites hand this a complete reply PACKET (a type-0x04 frame); the payload inside
    // it is what gets re-chunked. Wrapping the frame itself would double the header, which
    // the client then reads as a token.
    const framed = bytes.length >= 8 && bytes.readUInt8(0) === 0x04 && bytes.readUInt16BE(2) === bytes.length
    const payload = framed ? bytes.subarray(8) : bytes
    const frames = []
    for (let offset = 0; offset < payload.length; offset += PACKET_SIZE - 8) {
      const chunk = payload.subarray(offset, offset + PACKET_SIZE - 8)
      const frame = packet(0x04, chunk, 1)
      if (offset + chunk.length < payload.length) frame.writeUInt8(0, 1) // not the end yet
      frames.push(frame)
    }
    if (options.trickle === true && frames.length > 1) {
      frames.forEach((frame, index) => setTimeout(() => write(frame), index * 4))
      return
    }
    for (const frame of frames) write(frame)
  }
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})

    /**
     * Three phases, and the byte stream means something different in each:
     *
     *   prelogin   raw TDS packets, starting with PRELOGIN
     *   handshake  TLS records carried INSIDE PRELOGIN packets (0x12, packetId 0)
     *   session    TDS packets again — decrypted while the login is read, plaintext
     *              afterwards, because ENCRYPT_OFF encrypts ONLY the login packet
     */
    let phase = 'prelogin'
    let raw = Buffer.alloc(0)
    let inner = Buffer.alloc(0)
    let secure = null
    let duplex = null
    let wrapping = true

    /** Answers go back over TLS only when the whole session is encrypted. */
    const writeRaw = (bytes) => {
      if (phase === 'session' && encryption !== 0x00 && secure !== null) secure.write(bytes)
      else socket.write(bytes)
    }
    const sendReply = replyInPackets(writeRaw)
    const reply = (bytes) => {
      if (phase === 'session' && encryption !== 0x00 && secure !== null) secure.write(bytes)
      else socket.write(bytes)
    }

    const readLogin = (payload) => {
      state.logins += 1
      // 94 bytes of fixed part, then the offset table. Host, user and password are the
      // first three pairs, and a length is in CHARACTERS, not bytes.
      const fieldOffset = (index) => payload.readUInt16LE(36 + index * 4)
      const read = (index) => {
        const offset = fieldOffset(index)
        const chars = payload.readUInt16LE(38 + index * 4)
        return chars === 0 ? '' : payload.subarray(offset, offset + chars * 2)
      }
      // ibHostName MUST point at the start of the variable data (MS-TDS 2.2.6.4), which
      // is where the 94 bytes of fixed part end.
      state.hostNameOffset = fieldOffset(0)
      const askedUser = read(1).toString('utf16le')
      const askedPassword = deobfuscatePassword(read(2))
      state.scrambles.push({ user: askedUser, passwordLength: askedPassword.length })
      if (askedUser !== user || askedPassword !== password) {
        state.wrongPassword = true
        sendReply(packet(0x04, Buffer.concat([
          errorToken(18456, 14, `Login failed for user '${askedUser}'.`),
          doneToken(0),
        ])))
        return
      }
      state.authenticated = true
      sendReply(packet(0x04, Buffer.concat([loginAck(), envChange(1, database), doneToken(0)])))
    }

    /** One complete TDS packet, header stripped, from whichever stream is live. */
    const handle = (type, payload) => {
      if (type === 0x10) {
        state.loginTransport = secure === null ? 'plaintext' : 'tls'
        // Switch modes BEFORE answering: `reply()` picks its stream from the phase, and
        // for ENCRYPT_ON/REQ the answer must go back inside TLS.
        phase = 'session'
        // ENCRYPT_OFF encrypts only the login: let go of TLS and answer in plaintext.
        if (encryption === 0x00) secure = null
        readLogin(payload)
        return
      }
      if (type === 0x01) {
        // A server that accepts the login and then says NOTHING about a statement: the shape
        // the driver's statement deadline exists for.
        if (options.ignoreBatches === true) return
        // SQL_BATCH: 22 bytes of ALL_HEADERS, then the UTF-16 statement, then a newline.
        const sql = payload.subarray(22).toString('utf16le').replace(/\n$/, '')
        state.batches.push(sql)
        const answer = replyFor(sql, { password, user, database })
        if (answer.error !== undefined) {
          sendReply(packet(0x04, Buffer.concat([errorToken(answer.error.number ?? 102, 15, answer.error.text), doneToken(0)])))
          return
        }
        const tokens = [colMetadata(answer.columns)]
        const nbcRows = []
        for (const values of answer.rows) {
          const built = rowToken(answer.columns, values)
          tokens.push(built.row)
          nbcRows.push(built.nbc)
        }
        if (answer.notice !== undefined) tokens.push(infoToken(0, answer.notice))
        if (options.nbc === true) {
          tokens.length = 1
          tokens.push(...nbcRows)
        }
        tokens.push(doneToken(answer.rows.length))
        // A real server sends an ORDER token for any ordered result, and a parser that
        // does not know the token fails the whole query: a live 2008 R2 answered
        // "不认识的 token 0xa9" for `select ... order by name`. Emitting it here is what
        // keeps that from coming back unnoticed.
        if (/\border\s+by\b/i.test(sql)) tokens.splice(1, 0, orderToken(answer.columns.length))
        sendReply(packet(0x04, Buffer.concat(tokens)))
        return
      }
      // Anything else: answer with a plain error rather than going silent, so a driver bug
      // shows up as a message instead of a timeout.
      sendReply(packet(0x04, Buffer.concat([
        errorToken(0, 16, `fake-sqlserver: unexpected packet type 0x${type.toString(16)}`),
        doneToken(0),
      ])))
    }

    /** PRELOGIN: read the offer, answer with this fake's encryption verdict. */
    const handlePrelogin = (payload) => {
      state.prelogins += 1
      const reader = { at: 0 }
      const options2 = {}
      while (reader.at < payload.length) {
        const token = payload.readUInt8(reader.at++)
        if (token === 0xff) break
        const offset = payload.readUInt16BE(reader.at)
        const size = payload.readUInt16BE(reader.at + 2)
        reader.at += 4
        options2[token] = payload.subarray(offset, offset + size)
      }
      state.sawEncryption = options2[1] === undefined ? null : options2[1][0]
      socket.write(preloginReply(encryption))
      if (expectsEncryption) startHandshake()
      else phase = 'session'
    }

    /** Terminate the login-packet TLS handshake, carried inside PRELOGIN packets. */
    const startHandshake = () => {
      phase = 'handshake'
      duplex = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          // Wrapped while the handshake runs, bare once it finishes — the mirror of what
          // the driver does, and what the platform drivers do.
          socket.write(packet(0x12, chunk, wrapping ? 0 : 1), done)
        },
        final(done) { done() },
      })
      secure = new tls.TLSSocket(duplex, {
        isServer: true,
        secureContext: tls.createSecureContext({ key: FAKE_TLS_KEY, cert: FAKE_TLS_CERT }),
      })
      secure.on('error', () => {})
      secure.on('secure', () => { wrapping = false })
      secure.on('data', (chunk) => {
        inner = Buffer.concat([inner, chunk])
        inner = drain(inner, handle)
      })
    }

    /** Raw bytes during the handshake: unwrap the PRELOGIN carriers, feed TLS. */
    const onRawData = (chunk) => {
      if (phase === 'handshake') {
        raw = Buffer.concat([raw, chunk])
        for (;;) {
          if (raw.length === 0) return
          // Once the handshake is done the client stops wrapping, and a bare TLS record
          // (0x14..0x17) is a stream rather than a packet: hand the rest over as-is. This
          // is also the signal to stop wrapping OUR records — taken from the wire rather
          // than from a TLS event, which is what the client does and what always holds.
          if (raw.readUInt8(0) !== 0x12) {
            wrapping = false
            duplex.push(raw)
            raw = Buffer.alloc(0)
            return
          }
          if (raw.length < 8) return
          const length = raw.readUInt16BE(2)
          if (raw.length < length) return
          duplex.push(raw.subarray(8, length))
          raw = raw.subarray(length)
        }
      }
      if (phase === 'prelogin') {
        raw = Buffer.concat([raw, chunk])
        raw = drain(raw, (type, payload) => {
          if (type === 0x12) handlePrelogin(payload)
          else handle(type, payload)
        })
        return
      }
      // session: encrypted throughout (ENCRYPT_ON/REQ) or plaintext (ENCRYPT_OFF).
      if (secure !== null && encryption !== 0x00) {
        duplex.push(chunk)
        return
      }
      inner = Buffer.concat([inner, chunk])
      inner = drain(inner, handle)
    }
    socket.on('data', onRawData)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    state,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

export const FAKE_PASSWORD = 'Str0ng!Pass'
export const TDS_VERSION_CONSTANT = TDS_VERSION