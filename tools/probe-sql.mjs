#!/usr/bin/env node
// @ts-check
/**
 * Drive the SQL panel's own drivers against one instance.
 *
 * The card reports "登录超时" and nothing else, which is the same string for a
 * closed port, a stalled prelogin and a wrong password. This runs the SAME code
 * the panel runs — `hud/lib/sql/index.js` + the driver it dispatches to — and
 * prints what actually happened at each step, so the failure can be named.
 *
 *   SQL_HOST=... SQL_USER=... SQL_PASSWORD=... SQL_DATABASE=... \
 *     node tools/probe-sql.mjs [--driver mssql] [--list] [--query "select 1"]
 *
 * The password is read from the environment, never from argv, so it does not
 * end up in a process listing.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect } from 'node:net'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const flag = (name) => process.argv.includes(`--${name}`)

// Which copy of the driver tree to load. Defaults to the shipped one; pointing
// it at a patched copy is how a candidate fix is validated before it lands.
const SQL_LIB = process.env.SQL_LIB ?? join(root, 'hud', 'lib', 'sql')
const SQL_INDEX = join(SQL_LIB, 'index.js')

const driver = arg('driver', 'mssql')
const host = process.env.SQL_HOST ?? '127.0.0.1'
const port = Number(process.env.SQL_PORT ?? 0) || undefined
const database = process.env.SQL_DATABASE ?? ''
const user = process.env.SQL_USER ?? ''
const password = process.env.SQL_PASSWORD ?? ''

if (flag('list')) {
  const sql = await import(pathToFileURL(SQL_INDEX).href)
  console.log('drivers the panel knows:')
  for (const spec of sql.DRIVER_SPECS ?? []) console.log(`  ${spec.id.padEnd(12)} ${spec.defaultPort}  ${spec.label}`)
  const caps = await sql.capabilities().catch((error) => ({ error: error.message }))
  console.log('\ncapabilities:', JSON.stringify(caps, null, 2))
  process.exit(0)
}

// ── 1. raw TCP, before any protocol ────────────────────────────────────────
const tcp = await new Promise((resolve) => {
  const started = Date.now()
  const socket = connect({ host, port: port ?? 1433 })
  socket.setTimeout(8_000)
  const done = (result) => { socket.destroy(); resolve({ ...result, ms: Date.now() - started }) }
  socket.on('connect', () => done({ ok: true }))
  socket.on('timeout', () => done({ ok: false, why: 'timeout' }))
  socket.on('error', (error) => done({ ok: false, why: `${error.code ?? ''} ${error.message}`.trim() }))
})
console.log(`tcp ${host}:${port ?? 1433} → ${tcp.ok ? `open in ${tcp.ms}ms` : `${tcp.why} after ${tcp.ms}ms`}`)
if (!tcp.ok) process.exit(1)

// ── 2. the panel's own code path ───────────────────────────────────────────
const sql = await import(pathToFileURL(SQL_INDEX).href)

const profile = sql.cleanProfile({
  id: 'probe',
  driver,
  host,
  ...(port === undefined ? {} : { port }),
  database,
  user,
  readOnly: true,
  timeoutMs: 15_000,
})
console.log('profile:', JSON.stringify({ ...profile, passwordRef: profile.passwordRef ?? null }))

/** Read the wire log the driver keeps, when it keeps one. */
const trace = []
if (process.env.SQL_TRACE === '1') {
  const driverModule = pathToFileURL(join(SQL_LIB, driver === 'sqlserver' ? 'tds.js' : `${driver}.js`)).href
  const mod = await import(driverModule)
  if (typeof mod.available === 'function') console.log('driver available():', await mod.available())
  void trace
}

console.log('\n— testProfile (the card\'s "test" button) —')
const started = Date.now()
try {
  const result = await sql.testProfile(profile, { secrets: { password } })
  console.log(`  OK in ${result.ms}ms  driver=${result.driver}`)
  console.log(`  info: ${JSON.stringify(result.info)}`)
} catch (error) {
  console.log(`  FAILED after ${Date.now() - started}ms`)
  console.log(`  message : ${error instanceof Error ? error.message : String(error)}`)
  if (error?.hint) console.log(`  hint    : ${JSON.stringify(error.hint)}`)
  if (error?.stack) console.log(`  stack   :\n${String(error.stack).split('\n').slice(1, 7).join('\n')}`)
  process.exitCode = 1
  process.exit(1)
}

if (flag('list')) {
  console.log('\n— objectsQuery —')
  const objects = await sql.describeProfile(profile, { secrets: { password }, limit: 10 })
  console.log(JSON.stringify(objects, null, 2).slice(0, 800))
}

const query = arg('query', '')
if (query !== '') {
  console.log(`\n— runStatement: ${query} —`)
  const result = await sql.runStatement(profile, { sql: query, secrets: { password }, limit: 10 })
  console.log(JSON.stringify(result, null, 2).slice(0, 1200))
}