// Unit tests for the pieces that hold no state: the settings mapping, the route
// table's request/response shim, and the credentials service the panels see.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { normalizeSettings, normalizePanels, unusablePanelSlices, DEFAULTS } = require('../src/settings')
const { RouteTable, makeRequest, makeResponse } = require('../src/router')
const { createHudContext } = require('../src/ctx')
const { CredentialStore } = require('../src/credentials')
const { tempDir } = require('./harness')

// ── SQL connections ────────────────────────────────────────────────────────
test('a new connection id never collides with an existing one', () => {
  const sql = require('../src/sql-connections')
  assert.equal(sql.nextId([]), 'conn-1')
  assert.equal(sql.nextId([{ id: 'conn-1' }]), 'conn-2')
  // The panel counts, so a gap must not be reused: `conn-2` exists while the
  // list has one entry, and `conn-2` again would make `active` ambiguous.
  assert.equal(sql.nextId([{ id: 'conn-3' }]), 'conn-2')
  assert.equal(sql.nextId([{ id: 'conn-1' }, { id: 'conn-2' }]), 'conn-3')
})

test('a connection reads as one line', () => {
  const sql = require('../src/sql-connections')
  assert.equal(
    sql.describe({ driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'app', readOnly: true }),
    '127.0.0.1:5432/app · read-only',
  )
  assert.equal(
    sql.describe({ driver: 'sqlserver', host: 'db', port: 1433, readOnly: false }),
    'db:1433 · writable',
  )
  assert.equal(sql.describe({ driver: 'sqlite', file: 'E:/x.db' }), 'E:/x.db · read-only')
})

test('a field answer is coerced the way the connection needs it', () => {
  const sql = require('../src/sql-connections')
  const port = { key: 'port', kind: 'number', label: '端口' }
  const host = { key: 'host', kind: 'text', label: '主机' }
  const toggle = { key: 'ssl', kind: 'toggle', label: 'SSL' }

  assert.deepEqual(sql.coerceField(port, ' 1433 ', { numbers: true }), { value: 1433 })
  assert.deepEqual(sql.coerceField(port, '', { numbers: true }), { value: undefined }, 'empty means "leave it out"')
  assert.match(sql.coerceField(port, 'abc', { numbers: true }).error, /数字/)
  assert.match(sql.coerceField(port, '70000', { numbers: true }).error, /1\.\.65535/)
  assert.match(sql.coerceField(port, '1433', { numbers: false }).error, /数字/, 'a picker answer is never a number')

  assert.deepEqual(sql.coerceField(host, ' db.example ', { numbers: true }), { value: 'db.example' })
  assert.deepEqual(sql.coerceField(host, '   ', { numbers: true }), { value: undefined })

  for (const yes of ['true', '1', 'yes', '是', '开']) assert.deepEqual(sql.coerceField(toggle, yes, { numbers: true }), { value: true })
  for (const no of ['false', '0', 'no', '否', '关']) assert.deepEqual(sql.coerceField(toggle, no, { numbers: true }), { value: false })
  assert.match(sql.coerceField(toggle, 'maybe', { numbers: true }).error, /是.*否/)
})

test('removing a connection never leaves active dangling', () => {
  const sql = require('../src/sql-connections')
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  assert.deepEqual(sql.removeById(list, 'b', 'a'), { connections: [{ id: 'a' }, { id: 'c' }], active: 'a' })
  // Removing the ACTIVE one has to pick another, or the card renders no editor.
  assert.deepEqual(sql.removeById(list, 'a', 'a'), { connections: [{ id: 'b' }, { id: 'c' }], active: 'b' })
  assert.deepEqual(sql.removeById([{ id: 'a' }], 'a', 'a'), { connections: [], active: '' })
  assert.deepEqual(sql.removeById(undefined, 'a', 'x'), { connections: [], active: '' }, 'no list is not a crash')
})

test('a blank connection starts on the driver\'s own defaults, read-only', () => {
  const sql = require('../src/sql-connections')
  const spec = {
    id: 'sqlserver',
    defaultPort: 1433,
    fields: [{ key: 'host', kind: 'text' }, { key: 'port', kind: 'number' }, { key: 'user', kind: 'text' }],
  }
  const entry = sql.blank(spec, [])
  assert.equal(entry.id, 'conn-1')
  assert.equal(entry.driver, 'sqlserver')
  assert.equal(entry.host, '127.0.0.1')
  assert.equal(entry.port, 1433, 'the port comes from the spec, not from a guess')
  assert.equal(entry.readOnly, true, '"I did not think about it" must not mean "sure, drop it"')
  // A field with no default is left ABSENT rather than present-but-empty, which
  // is the difference between "use the server default" and "use an empty string".
  assert.equal('user' in entry, false)
  // SQLite's port is 0, which is not a port at all.
  assert.equal(sql.blank({ id: 'sqlite', defaultPort: 0, fields: [{ key: 'file', kind: 'text' }] }, []).port, undefined)
})

test('the generated credential name is one the store will accept', () => {
  const sql = require('../src/sql-connections')
  const { CREDENTIAL_REF_PATTERN } = require('../hud/lib/sql/contract.js')
  for (const id of ['conn-1', 'db', '2fast', 'a b/c', '', 'LingboPassport']) {
    const ref = sql.credentialRefFor(id)
    assert.match(ref, CREDENTIAL_REF_PATTERN, `${ref} (from ${JSON.stringify(id)}) must be legal`)
  }
  // A hyphen is not merely unreadable: the store's pattern rejects it, the
  // credentials plugin then fails to load, and DSH will not start.
  assert.equal(sql.credentialRefFor('conn-1').includes('-'), false)
  // The same fallback `lib/sql/index.js#toCredentialRef` uses for an empty id —
  // unreachable through the panel, which names a blank connection `conn-N`, but
  // the two must not disagree about what an empty id produces.
  assert.equal(sql.credentialRefFor(''), 'credential')
})

test('the cap matches the one the card enforces', () => {
  const sql = require('../src/sql-connections')
  // Read out of the card's own source: if the panel ever changes the number, the
  // command must change with it, and this is the only place that can notice.
  const client = readFileSync(join(__dirname, '..', 'hud', 'panels', 'sql', 'client.js'), 'utf8')
  const match = client.match(/const MAX_CONNECTIONS = (\d+)/)
  assert.ok(match, 'expected the card to still declare MAX_CONNECTIONS')
  assert.equal(sql.MAX_CONNECTIONS, Number(match[1]))
})

test('a password is only asked for when one can be used', () => {
  const sql = require('../src/sql-connections')
  assert.equal(sql.needsPassword({ driver: 'sqlite' }), false, 'a file needs no secret')
  assert.equal(sql.needsPassword({ driver: 'postgres', user: 'sa' }), true)
  assert.equal(sql.needsPassword({ driver: 'postgres' }), false, 'no user means nothing to authenticate')
  assert.equal(sql.needsPassword({ driver: 'postgres', user: '' }), false)
})

// ── the TDS token stream ───────────────────────────────────────────────────
// A statement that had worked a minute earlier failed with
// "TDS: 不认识的 token 0xee（第 0 字节）". 0xEE is FEDAUTHINFO (MS-TDS 2.2.7.5),
// which carries an STS URL and an SPN — nothing a SQL-login session can use — and
// the driver's token table did not know it. Its framing differs from the other
// skippable tokens by one width, which is exactly the kind of difference that
// shifts every token after it instead of failing.
const tds = () => import(pathToFileURL(join(__dirname, '..', 'hud', 'lib', 'sql', 'tds.js')).href)
const u16 = (value) => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value, 0); return buffer }
const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value, 0); return buffer }
const i64 = (value) => { const buffer = Buffer.alloc(8); buffer.writeBigInt64LE(value, 0); return buffer }
const DONE = () => Buffer.concat([Buffer.from([0xfd]), u16(0), u16(0), i64(0n)])

/** A FEDAUTHINFO token carrying one SPN, framed the way the spec frames it. */
const fedAuthInfo = (spn) => {
  const entries = Buffer.alloc(9)
  entries.writeUInt8(0x02, 0) // SPN
  const text = Buffer.from(spn, 'utf16le')
  entries.writeUInt32LE(text.length, 1)
  entries.writeUInt32LE(13, 5) // where the string starts, measured inside the token
  const body = Buffer.concat([u32(1), entries, text])
  return Buffer.concat([Buffer.from([0xee]), u32(body.length), body])
}

test('a FEDAUTHINFO token is skipped by its own width, not the neighbours\'', async () => {
  const { parseTokens } = await tds()
  const parsed = parseTokens(Buffer.concat([fedAuthInfo('MSSQLSvc/db.example:1433'), DONE()]))
  // The assertion is not "it did not throw" — it is that the DONE token AFTER it
  // still parsed. A WORD-length skip would consume four bytes too few and the
  // stream would be misaligned right there instead.
  assert.equal(parsed.done, true, 'the token after it must still be read')
  assert.deepEqual(parsed.columns, [])
  assert.deepEqual(parsed.rows, [])
})

test('a FEDAUTHINFO length that cannot fit is still an error, not a silent skip', async () => {
  const { parseTokens } = await tds()
  // What a MISALIGNED stream looks like: the four bytes read as a length are row
  // data. Skipping by them would swallow the rest of the reply and hand back a
  // result that looks real, so the honest failure is kept.
  const bogus = Buffer.concat([Buffer.from([0xee]), u32(0x7ffffff0), Buffer.from([0, 0, 0, 0])])
  assert.throws(() => parseTokens(Buffer.concat([bogus, DONE()])), /不认识的 token 0xee/)
})

test('the tokens that are still unknown fail loudly rather than being guessed', async () => {
  const { parseTokens } = await tds()
  // RETURNVALUE and FEATUREEXTACK are NOT length-prefixed in any way this driver
  // has verified, so they stay out of the table. If one is added later it needs its
  // own framing, not a copy of the branch above.
  for (const byte of [0xac, 0xae]) {
    assert.throws(
      () => parseTokens(Buffer.concat([Buffer.from([byte]), Buffer.alloc(32), DONE()])),
      new RegExp(`不认识的 token 0x${byte.toString(16)}`),
    )
  }
})

// ── settings ───────────────────────────────────────────────────────────────
test('settings fall back to the documented defaults', () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULTS })
  assert.deepEqual(normalizeSettings({}), { ...DEFAULTS })
  // Booleans are only true when explicitly true.
  assert.equal(normalizeSettings({ retainContext: 'yes' }).retainContext, false)
  assert.equal(normalizeSettings({ retainContext: true }).retainContext, true)
  assert.equal(normalizeSettings({ notifications: false }).notifications, false)
  assert.equal(normalizeSettings({ statusBar: true }).statusBar, true)
})

test('hud.panels is passed through as the framework expects it', () => {
  const panels = { quota: { pollMs: 30_000, apiKeyEnv: 'X' }, sql: { timeoutMs: 5_000 } }
  assert.deepEqual(normalizeSettings({ panels }).panels, panels)
  // The object identity of each slice is preserved (copied, not wrapped), so a
  // panel reading a nested value gets the value and not a schema node.
  assert.equal(typeof normalizePanels(panels).quota.pollMs, 'number')
})

test('a panel slice that is not a mapping is dropped, and can be named', () => {
  const raw = { quota: { ok: true }, sql: ['nope'], github: 'nope', todo: null }
  assert.deepEqual(Object.keys(normalizePanels(raw)), ['quota'])
  assert.deepEqual(unusablePanelSlices(raw).sort(), ['github', 'sql', 'todo'])
  assert.deepEqual(unusablePanelSlices({ quota: {} }), [])
  // A non-object `panels` value is ignored wholesale rather than throwing.
  assert.deepEqual(normalizePanels(['nope']), {})
  assert.deepEqual(unusablePanelSlices('nope'), [])
})

test('hud.credentialStore accepts only the three targets', () => {
  assert.equal(normalizeSettings({ credentialStore: 'vscode' }).credentialStore, 'vscode')
  assert.equal(normalizeSettings({ credentialStore: 'both' }).credentialStore, 'both')
  assert.equal(normalizeSettings({ credentialStore: 'nonsense' }).credentialStore, 'dsh')
})

test('hud.credentialsFile is trimmed, and empty means "the DSH default"', () => {
  assert.equal(normalizeSettings({ credentialsFile: '  /tmp/x.yaml  ' }).credentialsFile, '/tmp/x.yaml')
  assert.equal(normalizeSettings({ credentialsFile: '   ' }).credentialsFile, '')
  assert.equal(normalizeSettings({ credentialsFile: 42 }).credentialsFile, '')
})

// ── the route table ────────────────────────────────────────────────────────
test('the route table matches on the pathname and keeps the query string', async () => {
  const table = new RouteTable()
  const seen = []
  table.service.register({
    kind: 'exact',
    path: '/dsh-hud/x/state',
    handler: (req, res) => {
      seen.push({ method: req.method, url: req.url })
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true }))
    },
  })
  const answer = await table.dispatch({ path: '/dsh-hud/x/state?a=1&b=2', method: 'GET' })
  assert.equal(answer.status, 200)
  assert.deepEqual(JSON.parse(answer.body), { ok: true })
  assert.deepEqual(seen, [{ method: 'GET', url: '/dsh-hud/x/state?a=1&b=2' }])
})

test('a duplicate path throws, and unregistering frees it', () => {
  const table = new RouteTable()
  const dispose = table.service.register({ kind: 'exact', path: '/p', handler: () => {} })
  assert.throws(() => table.service.register({ kind: 'exact', path: '/p', handler: () => {} }), /duplicate route/)
  dispose()
  assert.deepEqual(table.paths(), [])
})

test('an unregistered path answers 404 with a non-JSON body', async () => {
  const answer = await new RouteTable().dispatch({ path: '/dsh-hud/gone/x' })
  assert.equal(answer.status, 404)
  assert.equal(answer.headers['content-type'].startsWith('application/json'), false)
})

test('a handler that throws answers 500 rather than rejecting the RPC', async () => {
  const table = new RouteTable()
  table.service.register({ kind: 'exact', path: '/boom', handler: () => { throw new Error('handler exploded') } })
  const answer = await table.dispatch({ path: '/boom' })
  assert.equal(answer.status, 500)
  assert.match(JSON.parse(answer.body).error, /handler exploded/)
})

test('a POST body reaches the handler through the same events a socket uses', async () => {
  const table = new RouteTable()
  const bodies = []
  table.service.register({
    kind: 'exact',
    path: '/echo',
    handler: async (req, res) => {
      const chunks = []
      await new Promise((resolve) => {
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', resolve)
      })
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.statusCode = 200
      res.end('{}')
    },
  })
  await table.dispatch({ path: '/echo', method: 'POST', body: JSON.stringify({ a: 1 }) })
  assert.deepEqual(JSON.parse(bodies[0]), { a: 1 })
  // An object body is serialized; an absent one still ends the stream, so a
  // handler waiting on `end` is never left hanging.
  await table.dispatch({ path: '/echo', method: 'POST', body: { b: 2 } })
  assert.deepEqual(JSON.parse(bodies[1]), { b: 2 })
  await table.dispatch({ path: '/echo', method: 'POST' })
  assert.equal(bodies[2], '')
})

test('the request shim answers same-origin checks the way a real one does', () => {
  const noOrigin = makeRequest({ url: '/' })
  assert.equal(noOrigin.headers.origin, undefined, 'no Origin → same-origin')
  const withOrigin = makeRequest({ url: '/', origin: 'https://evil.test' })
  assert.equal(withOrigin.headers.origin, 'https://evil.test')
  const res = makeResponse()
  res.setHeader('X-Test', 'v')
  assert.deepEqual(res.headers, { 'x-test': 'v' }, 'headers are lower-cased like Node does')
  res.end(undefined)
  assert.equal(res.body, '')
})

// ── the context adapter ────────────────────────────────────────────────────
test('the adapter offers exactly the services the framework asks for', async () => {
  const tmp = tempDir()
  try {
    const store = new CredentialStore({ dshHome: tmp.dir, cacheMs: 0 })
    const ctx = createHudContext({ credentials: store, log: () => {} })
    assert.deepEqual(Object.keys(ctx.webServer), ['register'])
    assert.deepEqual(Object.keys(ctx.credentials).sort(), ['present', 'remove', 'resolve', 'write'])
    // With no loader supplied the table is empty, which is what a machine with
    // no DSH profile at all must look like — not an error.
    assert.deepEqual(ctx.loader.entries(), [], 'no loader → empty table, never a throw')
    assert.equal(typeof ctx.effect, 'function')
    assert.equal(ctx.routes instanceof Map, true)
  } finally {
    tmp.dispose()
  }
})

test('ctx.effect runs the callback and keeps its disposer', () => {
  const ctx = createHudContext({ credentials: new CredentialStore({}), log: () => {} })
  let disposed = false
  const dispose = ctx.effect(() => () => { disposed = true })
  assert.equal(disposed, false, 'the callback runs immediately')
  dispose()
  assert.equal(disposed, true)
  // A callback with no disposer is still safe to dispose.
  assert.equal(typeof ctx.effect(() => undefined), 'function')
})

test('ctx.credentials resolves, reports presence, writes and removes', async () => {
  const tmp = tempDir()
  try {
    const store = new CredentialStore({ dshHome: tmp.dir, cacheMs: 0 })
    const ctx = createHudContext({ credentials: store, log: () => {} })

    assert.equal(await ctx.credentials.resolve('MISSING'), undefined)
    assert.equal(await ctx.credentials.present('MISSING'), false)

    const how = await ctx.credentials.write('SOME_REF', 'value-1')
    assert.equal(how, 'credentials.yaml')
    assert.deepEqual(await ctx.credentials.resolve('SOME_REF'), { value: 'value-1', source: 'file' })
    assert.equal(await ctx.credentials.present('SOME_REF'), true)

    await ctx.credentials.remove('SOME_REF')
    assert.equal(await ctx.credentials.resolve('SOME_REF'), undefined)
    // Removing something absent is not an error.
    await ctx.credentials.remove('SOME_REF')
  } finally {
    tmp.dispose()
  }
})

test('a broken credentials document surfaces instead of reading as "no credentials"', async () => {
  const tmp = tempDir()
  try {
    const { writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    writeFileSync(join(tmp.dir, '.credentials.yaml'), 'SOME_REF: flat-layout\n', 'utf8')
    const store = new CredentialStore({ dshHome: tmp.dir, cacheMs: 0 })
    const logged = []
    const ctx = createHudContext({ credentials: store, log: (message) => logged.push(String(message)) })

    await assert.rejects(() => ctx.credentials.resolve('SOME_REF'), /旧的扁平布局/)
    assert.equal(logged.some((line) => line.includes('credentials.resolve')), true, 'the reason is logged')
    // `present` never throws — the framework asks it per row.
    assert.equal(await ctx.credentials.present('SOME_REF'), false)
  } finally {
    tmp.dispose()
  }
})