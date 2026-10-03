// ── the PostgreSQL bug, pinned ───────────────────────────────────────────────
//
// The auth loop `continue`d on AuthenticationOk instead of leaving. A real server sends
// ParameterStatus ('S') messages BEFORE that point, so the first one looked like a protocol
// violation and a perfectly good SCRAM login was thrown away:
//
//     认证阶段收到了意料之外的消息（S）
//
// The regression test needs a server that sends those messages in the real order, so this
// drives the smallest possible one: SCRAM-SHA-256 end to end, with ParameterStatus and
// BackendKeyData interleaved exactly as PostgreSQL does.
import { createServer } from 'node:net'
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The SCRAM server side, from RFC 5802: it must be able to CHECK the client's proof and
 * produce the signature the client checks back.
 *
 * Written from the specification rather than mirroring lib/sql/pg.js, so that agreement between
 * the two means something — a shared bug would cancel out and both sides would pass.
 */
function scramServer(password, clientFirst) {
  const salt = randomBytes(16)
  const iterations = 4096
  const bare = clientFirst.replace(/^n,,[^,]*,/, (whole) => whole)
  const clientFirstBare = clientFirst.startsWith('n,,') ? clientFirst.slice(3) : clientFirst
  const nonce = /(?:^|,)r=([^,]+)/.exec(clientFirstBare)?.[1] ?? ''
  const serverNonce = `${nonce}${randomBytes(12).toString('base64')}`
  const serverFirst = `r=${serverNonce},s=${salt.toString('base64')},i=${iterations}`
  void bare
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  return {
    first: serverFirst,
    finish(clientFinal) {
      const withoutProof = clientFinal.replace(/,p=[^,]*$/, '')
      const proof = Buffer.from(/(?:^|,)p=([^,]*)/.exec(clientFinal)?.[1] ?? '', 'base64')
      const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`
      const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest()
      // The client's proof must equal ClientKey XOR ClientSignature. Checking it is the point
      // of the exchange: a fake that skips the check accepts any password.
      const expected = Buffer.alloc(clientKey.length)
      for (let i = 0; i < clientKey.length; i += 1) expected[i] = clientKey[i] ^ clientSignature[i]
      const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest()
      return {
        ok: proof.length === expected.length && timingSafeEqual(proof, expected),
        serverSignature,
      }
    },
  }
}

/** A PostgreSQL message: one type byte, a 4-byte length including itself, then the payload. */
function message(type, payload) {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'latin1')
  head.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([head, payload])
}

const str = (text) => Buffer.from(`${text}\0`, 'utf8')

function authRequest(code, extra = Buffer.alloc(0)) {
  const body = Buffer.alloc(4)
  body.writeInt32BE(code, 0)
  return message('R', Buffer.concat([body, extra]))
}

function rowDescription(columns) {
  const head = Buffer.alloc(2)
  head.writeInt16BE(columns.length, 0)
  const parts = columns.map((name) => {
    const body = Buffer.concat([
      str(name),
      Buffer.from([0, 0, 0, 0]), // table oid (int32)
      Buffer.from([0, 0]), // column attnum (int16)
      Buffer.from([0x00, 0x00, 0x00, 0x19]), // type oid: text (25) — INT32, not int16
      Buffer.from([0xff, 0xff]), // type size (int16)
      Buffer.from([0xff, 0xff, 0xff, 0xff]), // type modifier (int32)
      Buffer.from([0, 0]), // format: text (int16)
    ])
    return body
  })
  return message('T', Buffer.concat([head, ...parts]))
}

function dataRow(values) {
  const head = Buffer.alloc(2)
  head.writeInt16BE(values.length, 0)
  const parts = values.map((value) => {
    if (value === null) {
      const nullLength = Buffer.alloc(4)
      nullLength.writeInt32BE(-1, 0)
      return nullLength
    }
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeInt32BE(bytes.length, 0)
    return Buffer.concat([length, bytes])
  })
  return message('D', Buffer.concat([head, ...parts]))
}

function readyForQuery() {
  return message('Z', Buffer.from('I'))
}

function commandComplete(tag) {
  return message('C', str(tag))
}

/**
 * Start the fake. `rows` is what a query answers with; the handshake is always the real one.
 */
export async function startFakePostgres({ user = 'app', password = 'sup3r-s3cret' } = {}) {
  const state = { scram: false, authenticated: false, queries: [], parameterStatusSent: 0, sslRequests: 0, trace: [] }
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let scram = null
    let scrambled = false
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!scrambled) {
          // The startup message has no type byte: a 4-byte length then the protocol version.
          if (buffer.length < 8) return
          const length = buffer.readInt32BE(0)
          if (buffer.length < length) return
          const code = buffer.readInt32BE(4)
          // An SSLRequest is answered with a SINGLE BYTE and no message framing, and 'N' means
          // "no TLS here" — which is what this fake is. A server that supports it answers 'S'
          // and then the connection becomes a TLS stream.
          if (code === 80877103) {
            buffer = buffer.subarray(length)
            state.sslRequests += 1
            socket.write('N')
            continue
          }
          buffer = buffer.subarray(length)
          scrambled = true
          // SASL, offering SCRAM-SHA-256 — the same first message a real server sends.
          const mechanisms = Buffer.concat([str('SCRAM-SHA-256'), Buffer.from([0])])
          socket.write(authRequest(10, mechanisms))
          continue
        }
        if (buffer.length < 5) return
        const type = String.fromCharCode(buffer.readUInt8(0))
        state.trace.push(`recv ${type}`)
        const length = buffer.readInt32BE(1)
        if (buffer.length < length + 1) return
        const payload = buffer.subarray(5, length + 1)
        buffer = buffer.subarray(length + 1)
        if (type === 'p') {
          // Two different messages arrive as 'p', and only the FIRST has a mechanism name and a
          // length prefix. Parsing the second the same way reads "c=biws,r=…" as a mechanism
          // name and rejects a perfectly good client — which is what this fake did until the
          // driver's own trace showed it.
          if (scram === null) {
            const end = payload.indexOf(0)
            const mechanism = payload.subarray(0, end).toString('utf8')
            const dataLength = payload.readInt32BE(end + 1)
            const data = payload.subarray(end + 5, end + 5 + dataLength).toString('utf8')
            if (mechanism !== 'SCRAM-SHA-256') {
              socket.write(authRequest(0, Buffer.alloc(0)))
              socket.destroy()
              return
            }
            scram = scramServer(password, data)
            state.scram = true
            socket.write(authRequest(11, Buffer.from(scram.first, 'utf8')))
          } else {
            const data = payload.toString('utf8')
            const checked = scram.finish(data)
            state.authenticated = checked.ok === true
            if (!state.authenticated) {
              // A wrong password is refused the way a server refuses it: an error, not a
              // silent close.
              socket.write(message('E', Buffer.concat([
                Buffer.from([0x53]), str('FATAL'),
                Buffer.from([0x43]), str('28P01'),
                Buffer.from([0x4d]), str('password authentication failed for user "' + user + '"'),
                Buffer.from([0]),
              ])))
              socket.destroy()
              return
            }
            const serverFinal = `v=${checked.serverSignature.toString('base64')}`
            socket.write(authRequest(12, Buffer.from(serverFinal, 'utf8')))
            // ── THE ORDER THAT MATTERS ──
            // AuthenticationOk, then ParameterStatus for each setting, then BackendKeyData,
            // then ReadyForQuery. A client that stops expecting 'R' at the first of these is
            // the bug this fake exists to catch.
            let out = Buffer.concat([authRequest(0)])
            out = Buffer.concat([out, message('S', Buffer.concat([str('server_version'), str('16.4')]))])
            state.parameterStatusSent += 1
            out = Buffer.concat([out, message('S', Buffer.concat([str('client_encoding'), str('UTF8')]))])
            state.parameterStatusSent += 1
            out = Buffer.concat([out, message('K', Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]))])
            out = Buffer.concat([out, readyForQuery()])
            socket.write(out)
          }
          continue
        }
        if (type === 'Q') {
          const sql = payload.toString('utf8').replace(/\0$/, '')
          state.queries.push(sql)
          // Transaction control returns NO result set — only CommandComplete. A fake that
          // answered `BEGIN` with a row would make the driver's row handling look right while
          // every real query came back with a phantom first row from the transaction it opened.
          if (/^\s*(begin|commit|rollback)\b/i.test(sql)) {
            const tag = sql.trim().split(/\s+/)[0].toUpperCase()
            socket.write(Buffer.concat([commandComplete(tag), readyForQuery()]))
            continue
          }
          const columns = ['name', 'n']
          const rows = sql.toLowerCase().includes('count') ? [['notes', '3']] : [['甲', '1'], ['乙', '2']]
          const out = [
            rowDescription(columns),
            ...rows.map(dataRow),
            commandComplete(`SELECT ${rows.length}`),
            readyForQuery(),
          ]
          socket.write(Buffer.concat(out))
          continue
        }
        if (type === 'X') { socket.destroy(); return }
        // Anything else (Parse/Bind for the extended protocol) is answered as an error rather
        // than ignored, so a driver that drifts to the extended protocol fails loudly.
        socket.write(message('E', Buffer.concat([
          Buffer.from([0x53]), str('ERROR'),
          Buffer.from([0x43]), str('0A000'),
          Buffer.from([0x4d]), str(`fake-postgres: unsupported message ${type}`),
          Buffer.from([0]),
        ])))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export const FAKE_USER = 'app'
export const FAKE_PASSWORD = 'sup3r-s3cret'