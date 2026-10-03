#!/usr/bin/env node
// @ts-check
/**
 * Trace the TDS handshake byte by byte.
 *
 * `hud/lib/sql/tds.js` implements PRELOGIN → (maybe TLS) → LOGIN7, and the
 * whole connect path has no deadline: a server that stops answering leaves the
 * promise pending forever, which the card can only report as "登录超时".
 *
 * This wraps `net.connect` / `tls.connect` to log every write and every read
 * with a timestamp, then calls the driver's own `open()`. Nothing in the HUD
 * tree is modified — the instrumentation is on Node's sockets, so what is
 * measured is exactly what ships.
 *
 *   SQL_HOST=... SQL_USER=... SQL_PASSWORD=... node tools/probe-tds.mjs [--port 1433] [--encrypt]
 */

import net from 'node:net'
import tls from 'node:tls'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.SQL_HOST ?? '127.0.0.1'
const port = Number(process.env.SQL_PORT ?? 1433)
const user = process.env.SQL_USER ?? 'sa'
const database = process.env.SQL_DATABASE ?? ''
const password = process.env.SQL_PASSWORD ?? ''
const forceTls = process.argv.includes('--encrypt')

const started = Date.now()
const hex = (buffer) => [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
const mark = (what) => console.log(`+${String(Date.now() - started).padStart(6)}ms  ${what}`)

/** TDS packet header: type(1) status(1) length(2, big endian) spid(2) packetId(1) window(1). */
function describePacket(buffer) {
  if (buffer.length < 8) return `short (${buffer.length}B)`
  const type = buffer[0]
  const name = { 0x04: 'REPLY', 0x12: 'PRELOGIN' }[type] ?? `type 0x${type.toString(16)}`
  return `${name} len=${buffer.readUInt16BE(2)} id=${buffer[6]}`
}

const ENCRYPTION_NAMES = ['ENCRYPT_OFF', 'ENCRYPT_ON', 'ENCRYPT_NOT_SUP', 'ENCRYPT_REQ']

/**
 * The PRELOGIN reply is an option table: token(1) offset(2, BE) length(2, BE),
 * terminated by 0xff, with the values parked at their offsets past the table.
 * The ENCRYPTION byte is the one that decides whether a TLS handshake follows —
 * the single most useful number in this whole trace.
 */
function decodePrelogin(buffer) {
  const payload = buffer.subarray(8)
  const found = []
  for (let at = 0; at + 5 <= payload.length && payload[at] !== 0xff; at += 5) {
    const token = payload[at]
    const offset = payload.readUInt16BE(at + 1)
    const length = payload.readUInt16BE(at + 3)
    const value = payload.subarray(offset, offset + length)
    if (token === 0x01 && length >= 1) {
      found.push(`ENCRYPTION=${ENCRYPTION_NAMES[value[0]] ?? `0x${value[0].toString(16)}`}`)
    } else {
      found.push(`token 0x${token.toString(16)} len=${length}`)
    }
  }
  return found.join(', ')
}

function watch(socket, label) {
  socket.on('connect', () => mark(`${label} connected`))
  socket.on('secureConnect', () => mark(`${label} TLS established (${socket.getProtocol?.()})`))
  socket.on('data', (buffer) => {
    mark(`${label} IN  ${buffer.length}B  ${describePacket(buffer)}`)
    // The prelogin reply is short and decides everything after it; show it all.
    if (buffer.length <= 64) {
      console.log(`              full: [${hex(buffer)}]`)
      if (buffer[0] === 0x04) console.log(`              ${decodePrelogin(buffer)}`)
    }
  })
  socket.on('error', (error) => mark(`${label} error: ${error.code ?? ''} ${error.message}`))
  socket.on('timeout', () => mark(`${label} timeout`))
  socket.on('end', () => mark(`${label} end (server finished sending)`))
  socket.on('close', () => mark(`${label} closed`))
  const write = socket.write.bind(socket)
  socket.write = (buffer, ...rest) => {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    mark(`${label} OUT ${bytes.length}B  ${describePacket(bytes)}`)
    return write(buffer, ...rest)
  }
  return socket
}

const realNetConnect = net.connect
net.connect = (...args) => {
  mark(`net.connect(${JSON.stringify(args[0])})`)
  return watch(realNetConnect(...args), 'tcp')
}
const realTlsConnect = tls.connect
tls.connect = (...args) => {
  mark('tls.connect()')
  return watch(realTlsConnect(...args), 'tls')
}

const tds = await import(pathToFileURL(join(root, 'hud', 'lib', 'sql', 'tds.js')).href)

const profile = {
  id: 'probe', driver: 'sqlserver', name: 'probe', readOnly: true,
  limit: 20, timeoutMs: 15_000, host, port, database, user,
  ...(forceTls ? { encrypt: true } : {}),
}

mark(`opening ${user}@${host}:${port}/${database}${forceTls ? ' (force TLS)' : ''}`)

const DEADLINE_MS = 20_000
let session = null
try {
  session = await Promise.race([
    tds.open(profile, { secrets: { password } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`DEADLINE: 驱动在 ${DEADLINE_MS}ms 内没有任何结论`)), DEADLINE_MS).unref()),
  ])
  mark('OPEN OK')
  console.log('info:', JSON.stringify(session.info ?? {}))
  const result = await session.query('SELECT @@VERSION AS v', { limit: 5 }).catch((error) => ({ error: error.message }))
  console.log('query:', JSON.stringify(result).slice(0, 400))
} catch (error) {
  mark(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try { session?.close() } catch { /* best effort */ }
}