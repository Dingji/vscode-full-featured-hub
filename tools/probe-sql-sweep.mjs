#!/usr/bin/env node
// @ts-check
/**
 * Ask one table after another and report which reply the driver cannot parse.
 *
 * "It works for me" is not an answer when the user's statement differs from the
 * probe's. Column TYPES and row widths change the token stream, so this walks
 * every base table in the database with `SELECT TOP n *` — the widest, most
 * type-diverse reply each table can produce — and names the ones that fail.
 *
 *   SQL_HOST=… SQL_USER=… SQL_PASSWORD=… SQL_DATABASE=… node tools/probe-sql-sweep.mjs
 *   … node tools/probe-sql-sweep.mjs --driver=sqlserver --rows=3 --where=Audit
 *
 * The password comes from the environment, never from argv.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const hit = argv.find((value) => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const driver = flag('driver', process.env.SQL_DRIVER || 'sqlserver')
const rows = Number(flag('rows', '3'))
const where = flag('where', '').toLowerCase()

const profile = {
  driver,
  host: process.env.SQL_HOST,
  port: process.env.SQL_PORT === undefined ? undefined : Number(process.env.SQL_PORT),
  database: process.env.SQL_DATABASE,
  user: process.env.SQL_USER,
  readOnly: true,
}
const password = process.env.SQL_PASSWORD
if (password === undefined || password === '') {
  console.error('SQL_PASSWORD is not set')
  process.exit(2)
}

const sql = await import(pathToFileURL(join(root, 'hud', 'lib', 'sql', 'index.js')).href)
const { CredentialStore } = require(join(root, 'src', 'credentials.js'))
const store = new CredentialStore({ dshHome: process.env.DSH_HOME || undefined })
const resolve = (ref) => store.resolve(ref)

/** Which tables, and which column type each one carries — the type is the suspect. */
const listing = await sql.runStatement(profile, {
  sql: `SELECT s.name AS sch, o.name AS tbl, c.name AS col, t.name AS typ
    FROM sys.columns c
    JOIN sys.objects o ON o.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE o.type = 'U' ORDER BY s.name, o.name, c.column_id`,
  resolve,
  secrets: { password },
  limit: 5000,
  timeoutMs: 30_000,
})

/** @type {Map<string, {cols: string[], types: Set<string>}>} */
const tables = new Map()
for (const [sch, tbl, col, typ] of listing.rows) {
  if (where !== '' && !`${sch}.${tbl}`.toLowerCase().includes(where)) continue
  const key = `${sch}.${tbl}`
  if (!tables.has(key)) tables.set(key, { cols: [], types: new Set() })
  tables.get(key).cols.push(col)
  tables.get(key).types.add(typ)
}

console.log(`${tables.size} table(s), ${rows} row(s) each\n`)
const failures = []
for (const [key, info] of [...tables].sort()) {
  const statement = `SELECT TOP ${rows} * FROM [${key.replace('.', '].[')}]`
  const started = Date.now()
  try {
    const result = await sql.runStatement(profile, { sql: statement, resolve, secrets: { password }, limit: 5000, timeoutMs: 30_000 })
    console.log(`  ok    ${key.padEnd(34)} ${String(result.columns.length).padStart(3)} cols  ${String(result.rows.length).padStart(3)} rows  ${Date.now() - started}ms`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  FAIL  ${key.padEnd(34)} ${message}`)
    failures.push({ key, message, types: [...info.types].join(',') })
  }
}

if (failures.length > 0) {
  console.log('\nfailures, with the column types each table carries:')
  for (const failure of failures) console.log(`  ${failure.key}: ${failure.types}`)
}
console.log(`\n${tables.size - failures.length}/${tables.size} tables read`)
process.exit(failures.length === 0 ? 0 : 1)