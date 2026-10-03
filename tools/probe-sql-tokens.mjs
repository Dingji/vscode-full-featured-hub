#!/usr/bin/env node
// @ts-check
/**
 * Statements chosen for the SHAPE of their reply, not for their data.
 *
 * A plain `SELECT` produces the stream everyone tests against: COLMETADATA, ROW…,
 * DONE. Everything else in TDS is rarely exercised — a batch with no result set at
 * all, an error, an informational message, an empty result, several result sets,
 * a reply big enough to span packets, and a statement SQL Server answers with
 * only ENVCHANGE. If a driver can parse one reply and not another, it is here.
 *
 *   SQL_HOST=… SQL_USER=… SQL_PASSWORD=… SQL_DATABASE=… node tools/probe-sql-tokens.mjs
 *
 * The password comes from the environment, never from argv.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  ['a plain select', 'SELECT 1 AS one'],
  ['a wide select', 'SELECT TOP 3 * FROM dbo.Plugins'],
  ['an EMPTY result set', 'SELECT TOP 0 * FROM dbo.Plugins'],
  ['no result set at all', 'SET NOCOUNT ON'],
  ['a USE, which is only ENVCHANGE', 'USE LingboPluginHub'],
  ['an informational message', "PRINT 'hello from TDS'"],
  ['an error', 'SELECT * FROM dbo.NoSuchTableHere'],
  ['a RAISERROR', "RAISERROR('deliberate', 16, 1)"],
  ['two result sets', 'SELECT 1 AS a; SELECT 2 AS b'],
  ['a stored procedure that returns rows', 'EXEC sp_help'],
  ['a scalar function', 'SELECT db_name() AS db, @@spid AS spid'],
  ['a big reply, several packets', 'SELECT TOP 5000 * FROM dbo.Plugins'],
  ['a very big reply', 'SELECT TOP 20000 * FROM sys.all_columns'],
  ['a batch ending in a comment', 'SELECT 1 AS one -- trailing'],
  ['a batch with a leading comment', '/* leading */ SELECT 1 AS one'],
  ['NUL-heavy data', "SELECT REPLICATE(CHAR(0), 10) AS zeros"],
  ['a long string', "SELECT REPLICATE('x', 8000) AS long_text"],
  ['a binary value', 'SELECT 0xEE AS b'],
  ['a decimal and a float', 'SELECT CAST(1.5 AS decimal(18,4)) AS d, CAST(1.5 AS float) AS f'],
  ['a very long identifier query', 'SELECT TOP 1 name FROM sys.objects WHERE name LIKE \'%\''],
]

const profile = {
  driver: process.env.SQL_DRIVER || 'sqlserver',
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

let failures = 0
for (const [label, statement] of STATEMENTS) {
  const started = Date.now()
  try {
    const result = await sql.runStatement(profile, { sql: statement, resolve, secrets: { password }, limit: 50, timeoutMs: 30_000 })
    const shape = `${result.columns.length} cols, ${result.rows.length} rows`
    console.log(`  ok    ${label.padEnd(38)} ${shape.padEnd(16)} ${Date.now() - started}ms`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A refusal from the panel's own classifier is not a driver failure.
    const expected = /只读|写|一条语句|没有可执行/.test(message)
    console.log(`  ${expected ? 'refuse' : 'FAIL  '} ${label.padEnd(37)} ${message}`)
    if (!expected) failures += 1
  }
}
console.log(`\n${STATEMENTS.length - failures}/${STATEMENTS.length} statements handled`)
process.exit(failures === 0 ? 0 : 1)