// End-to-end: the REAL host half, the REAL card bundle, and the runtime shim
// that joins them — mounted in jsdom through a fake webview bridge.
//
// This is the test that says the port works. Nothing here is a stand-in for
// the card: `media/react.js`, `media/runtime.js` and the vendor's own
// `hud/client.js` are evaluated in order, exactly as the webview document
// loads them, and every panel request travels the same path it does in VS
// Code — fetch shim → postMessage → the in-process route table → the panel's
// own handler → back.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const { JSDOM } = require('jsdom')

// `DSH_HUD_EXT_ROOT` points at an extracted .vsix, so the same suite can be run
// against the bytes that actually ship.
const ROOT = process.env.DSH_HUD_EXT_ROOT || join(__dirname, '..')
const { CredentialStore } = require('../src/credentials')
const { createHudContext } = require('../src/ctx')
const { buildDocument, buildCsp, makeNonce } = require('../src/webview')
const { startServer, tempDir, settle, waitFor } = require('./harness')

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/** Boot the real host half plus the real card, joined by a fake bridge. */
async function bootCard({ panels = {}, storage = {}, notifications = true, secrets = {}, sqlConnections = undefined, rightCard = 'database' } = {}) {
  const tmp = tempDir()
  const store = new CredentialStore({ dshHome: tmp.dir, cacheMs: 0 })
  for (const [ref, value] of Object.entries(secrets)) await store.write(ref, value, 'dsh')

  /**
   * Point the PANELS at the scratch home too, before they mount.
   *
   * `CredentialStore` takes a path, but the host half resolves its own storage
   * root from `$DSH_HOME` and never asks the context — so setting only the store
   * left every panel reading and writing the developer's real
   * `~/.dsh/storages/…`. That is how a test can silently depend on somebody's
   * connection list, and how a probe once replaced one.
   */
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp.dir
  if (sqlConnections !== undefined) {
    const file = join(tmp.dir, 'storages', 'dsh-hud', 'sql', 'state.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      settings: { pollMs: 60_000, active: sqlConnections[0]?.id ?? '', connections: sqlConnections },
    }), 'utf8')
  }

  const ctx = createHudContext({ credentials: store, log: () => {} })
  const hud = await import(pathToFileURL(join(ROOT, 'hud', 'index.js')).href)
  /**
   * The host half announces every panel on `console.log`. Collected rather than
   * dropped: a panel that FAILS to mount is announced the same way, and a harness
   * that swallows it turns "one panel is missing" into a bare number.
   */
  const hostLogs = []
  const realLog = console.log
  let handles
  try {
    console.log = (...args) => hostLogs.push(args.map((value) => String(value)).join(' '))
    handles = hud.apply(ctx, { panels })
  } finally {
    console.log = realLog
  }

  const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="hud-root"></div></body></html>', {
    url: 'http://127.0.0.1:19387/',
    pretendToBeVisual: true,
    // Load-bearing: without it jsdom's `window.eval` runs in the NODE scope,
    // where `window` is undefined — the card would fail with a ReferenceError
    // that has nothing to do with the card.
    runScripts: 'outside-only',
  })
  const w = dom.window
  // The real Response class — the runtime's fetch shim constructs one per call.
  w.Response = Response
  if (typeof w.AbortSignal?.timeout !== 'function') {
    Object.defineProperty(w.AbortSignal, 'timeout', { value: (ms) => AbortSignal.timeout(ms), configurable: true })
  }
  // jsdom implements neither. A real webview has both, and the shell measures
  // its cards with ResizeObserver — without it the later cards mount on a slow
  // retry path, which is a property of the harness rather than of the card.
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  }

  const requests = []
  const routeAnswers = []
  const storageWrites = []
  const notificationsSent = []
  const openedExternal = []

  const reply = (id, data) => w.dispatchEvent(new w.MessageEvent('message', { data: { id, ok: true, data } }))
  const fail = (id, error) => w.dispatchEvent(new w.MessageEvent('message', { data: { id, ok: false, error } }))

  async function handle(message) {
    try {
      switch (message.method) {
        case 'route': {
          const answer = await ctx.table.dispatch(message.params)
          routeAnswers.push({ path: message.params?.path, method: message.params?.method, status: answer.status })
          return reply(message.id, answer)
        }
        case 'storage.set':
          storageWrites.push(message.params)
          return reply(message.id, { ok: true })
        case 'clipboard.read':
          return reply(message.id, { text: 'from-host-clipboard' })
        case 'clipboard.write':
          return reply(message.id, { ok: true })
        case 'notify':
          notificationsSent.push(message.params)
          return reply(message.id, { ok: true })
        case 'openExternal':
          openedExternal.push(message.params)
          return reply(message.id, { ok: true })
        default:
          return fail(message.id, `unknown method: ${message.method}`)
      }
    } catch (error) {
      fail(message.id, error instanceof Error ? error.message : String(error))
    }
  }

  w.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      requests.push(message)
      void handle(message)
    },
  })

  // `rightCard` is read while the document is built — the panel is registered (or
// not) before the shell renders the grid — so it belongs to the document, exactly
// like the nonce and the storage seed.
  w.__hudHost = { storage, notifications, nonce: 'test-nonce-1234', version: '2.0.0', rightCard }
  w.eval(read('media/react.js'))
  // Both define a global the runtime reads at boot. Skipping them would make the
  // SSH card fail to register for a reason that has nothing to do with the card.
  w.eval(read('media/xterm.js'))
  w.eval(read('media/ssh-card.js'))
  w.eval(read('media/runtime.js'))
  w.eval(read('hud/client.js'))
  w.__hudBoot()

  return {
    dom,
    w,
    ctx,
    handles,
    store,
    hostLogs,
    requests,
    routeAnswers,
    storageWrites,
    notificationsSent,
    openedExternal,
    tmp,
    dispose: () => {
      try {
        w.close()
      } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        tmp.dispose()
      }
    },
  }
}

/** The `data-panel` cells currently rendered. */
const renderedPanels = (w) => [...w.document.querySelectorAll('.hud-panel[data-panel]')].map((node) => node.getAttribute('data-panel')).sort()

/** Strip the jsdom realm from a value so deepEqual compares values, not prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ── the document itself ────────────────────────────────────────────────────
test('the document pins a nonce CSP and the load-bearing script order', () => {
  const nonce = makeNonce()
  assert.ok(nonce.length >= 32)
  const html = buildDocument({
    nonce,
    cspSource: 'vscode-webview://abc',
    lang: 'zh-cn',
    styleText: '/* theme */',
    scriptUris: ['react.js', 'runtime.js', 'client.js'],
    hostPayload: { storage: { 'dsh-hud/prefs': '{"columns":3}' }, nonce },
  })

  assert.match(html, /<html lang="zh-cn">/)
  assert.match(html, new RegExp(`<style nonce="${nonce}"`))
  assert.equal(html.includes('unsafe-inline'), false, 'the CSP must not need unsafe-inline')
  assert.match(html, /connect-src 'none'/, 'the card never speaks to the network directly')
  assert.match(html, /img-src vscode-webview:\/\/abc data:/)

  // Order is what makes the shim work: react → runtime → the vendor bundle.
  const order = ['react.js', 'runtime.js', 'client.js'].map((name) => html.indexOf(name))
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'scripts must load in that order')
  assert.ok(html.indexOf('__hudHost') < order[0], 'the host payload must precede every script')
  assert.ok(html.indexOf('__hudBoot()') > order[2], 'and the boot must come last')
  // The card's storage seed is embedded, escaped, not fetched.
  assert.match(html, /window\.__hudHost = \{"storage":\{"dsh-hud\/prefs"/)
})

test('the CSP is one policy and stays strict', () => {
  const csp = buildCsp({ nonce: 'N', cspSource: 'vscode-webview://x' })
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'nonce-N'/)
  assert.match(csp, /style-src 'nonce-N'/)
  assert.equal(csp.includes('*'), false)
})

// ── the shell ──────────────────────────────────────────────────────────────
test('the real card bundle mounts the shell into the webview', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()

  assert.equal(
    app.handles.panels().length,
    9,
    `all nine host panels mounted — logs: ${app.hostLogs.filter((line) => /failed|mounted/.test(line)).join(' | ')}`,
  )
  assert.equal(app.w.document.querySelectorAll('.hud-root').length, 1, 'exactly one HUD root')
  assert.equal(app.w.document.querySelectorAll('.hud-card').length, 1, 'exactly one dock cell')
  assert.ok(app.w.__hud.entry(), 'the bundle registered through __ModuleLoader__')
})

test('the shell renders the real column grid with the real cards', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()

  const body = app.w.document.querySelector('.hud-body')
  assert.ok(body, 'expected the grid container')
  assert.match(body.getAttribute('data-cols') ?? '', /^[123]$/, 'the shell declares a track count')

  const panels = renderedPanels(app.w)
  assert.ok(panels.length >= 4, `expected several cards, saw ${panels.join(',')}`)
  // The five default-on cards plus the two head-only widgets. `sql` and
  // `parcel` ship off, so they are mounted but not necessarily rendered.
  for (const id of ['quota', 'github', 'markets']) {
    assert.ok(panels.includes(id), `${id} should be on the grid (saw ${panels.join(',')})`)
  }
  assert.ok(app.w.document.querySelector('.hud-heads'), 'the title bar has its widget slot')
})

test('every panel request is answered by the real host route table', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())

  // The shell mounts its cards progressively and each one arms its own poll, so
  // wait for the set rather than for a fixed number of milliseconds.
  const polled = (prefix) => app.routeAnswers.some((a) => String(a.path).startsWith(prefix))
  // jsdom drives React's concurrent scheduler far slower than a browser does —
  // the shell mounts its cards over several commits and the last one lands many
  // seconds in — so this waits for the set instead of racing a fixed sleep.
  await waitFor(
    () => polled('/dsh-hud/quota/') && polled('/dsh-hud/github/') && polled('/dsh-hud/weather/'),
    { timeoutMs: 30_000 },
  )

  const paths = app.routeAnswers.map((a) => a.path)
  assert.ok(paths.length > 0, 'expected the panels to poll')
  assert.ok(polled('/dsh-hud/quota/'), `quota polled (saw ${paths.join(', ')})`)
  assert.ok(polled('/dsh-hud/github/'), `github polled (saw ${paths.join(', ')})`)
  assert.ok(polled('/dsh-hud/weather/'), `the weather head widget polled (saw ${paths.join(', ')})`)
  // Several panels polling AT ONCE is the whole point of the merged card.
  const panelsPolled = new Set(paths.map((p) => String(p).split('/')[2]))
  assert.ok(panelsPolled.size >= 4, `expected several panels live at once, saw ${[...panelsPolled].join(', ')}`)
  // A 404/405 here would mean the host half did not register that path, and
  // the card would show its "restart the host" explanation instead of data.
  const missing = app.routeAnswers.filter((a) => a.status === 404 || a.status === 405)
  assert.deepEqual(missing, [], 'no panel request may hit an unregistered route')
  assert.ok(app.routeAnswers.every((a) => a.status < 500), 'and none may fault')
})

test('every shipped panel registered its routes on the host', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  const routes = app.ctx.table.paths()
  // One base path per panel, plus each panel's own actions.
  for (const id of ['quota', 'github', 'todo', 'weather', 'parcel', 'market', 'futures', 'bond', 'sql']) {
    assert.ok(routes.some((route) => route.startsWith(`/dsh-hud/${id}/`)), `${id} registered no route`)
  }
  assert.ok(routes.includes('/dsh-hud/quota/usage'), 'the quota route is where the card looks for it')
  assert.ok(routes.length >= 25, `expected the panels' whole route surface, saw ${routes.length}`)
})

test('the route table refuses an unknown path with a non-JSON 404', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  const answer = await app.ctx.table.dispatch({ path: '/dsh-hud/nope/usage', method: 'GET' })
  assert.equal(answer.status, 404)
  assert.match(answer.body, /no route/)
  assert.equal(answer.headers['content-type'].startsWith('application/json'), false)
})

// ── the browser-API bridges ────────────────────────────────────────────────
test('the SQL card offers add, edit and delete for its connections', async (t) => {
  // Seeded into the scratch home, so the assertions below are about the markup
  // and never about whatever the developer happens to have configured.
  const app = await bootCard({
    sqlConnections: [
      { id: 'db', driver: 'postgres', name: 'Passport', host: '127.0.0.1', port: 5432, database: 'app', user: 'sa', readOnly: true },
      { id: 'wh', driver: 'sqlserver', name: 'Warehouse', host: '10.0.0.9', port: 1433, database: 'dw', user: 'sa', readOnly: false },
    ],
  })
  t.after(() => app.dispose())
  const w = app.w
  const click = (element) => element.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))

  const found = await waitFor(() => w.document.querySelector('.sq-root') !== null, { timeoutMs: 30_000 })
  assert.ok(found, 'expected the SQL card')
  const root = w.document.querySelector('.sq-root')
  const at = (act) => root.querySelector(`[data-act="${act}"]`)

  // ADD — the header button.
  //
  // It is disabled while the driver list is still EMPTY, because the panel asks
  // `drivers.every((driver) => driver.available !== true)` and `[].every(…)` is
  // vacuously true. So "I cannot add a connection" is either this attribute or a
  // state route that never answered — worth waiting for rather than reading one
  // frame.
  const add = at('new')
  assert.ok(add, 'expected the "+ connect" button')
  const enabled = await waitFor(() => at('new').disabled === false, { timeoutMs: 30_000 })
  assert.ok(enabled, 'adding must be allowed once the driver list arrives')
  click(add)
  await settle(2)
  assert.ok(root.querySelector('.sq-connect'), 'clicking it opens the in-card connect form')
  click(at('new'))
  await settle(2)

  // The manager: one row per connection, each with its own verbs.
  const gear = root.querySelector('button[aria-label="数据库设置"]')
  assert.ok(gear, 'expected the settings gear (aria-label = the panel\'s own label)')
  click(gear)
  await settle(2)
  const list = root.querySelector('.sq-conns')
  assert.ok(list, 'the gear must open the connection list')
  assert.ok(list.querySelector('[data-act="conn-new"]'), 'with a "+ new connection" button')

  const rows = [...list.querySelectorAll('.sq-connrow')]
  assert.equal(rows.length, 2, 'one row per connection')
  const row = rows.find((one) => one.getAttribute('data-conn') === 'db')
  assert.ok(row, 'the row is keyed by the connection id')
  assert.ok(row.querySelector('[data-act="conn-pick"]'), 'the row itself switches the active connection')
  assert.ok(row.querySelector('[data-act="conn-edit"]'), 'and offers edit')
  assert.ok(row.querySelector('[data-act="conn-copy"]'), 'copy')
  assert.ok(row.querySelector('[data-act="conn-del"]'), 'delete')

  // Delete is deliberately TWO steps: nothing is dropped on one click.
  assert.equal(row.querySelector('[data-act="conn-del-confirm"]'), null, 'not armed until asked')
  click(row.querySelector('[data-act="conn-del"]'))
  await settle(2)
  const armed = list.querySelector('.sq-connrow[data-conn="db"]')
  assert.ok(armed.querySelector('[data-act="conn-del-confirm"]'), 'clicking delete arms a confirmation')
  assert.ok(armed.querySelector('[data-act="conn-del-cancel"]'), 'which can be cancelled')
})

test('the markets card carries 今日涨跌榜 and a hover chart, from the panel itself', async (t) => {
  // This is the UPSTREAM's feature, not this port's: the card grew 自选/涨幅榜/跌幅榜,
  // a 新股/退市 filter and a hover chart while this port was building the same thing
  // by hand. What is left to test is that it still works THROUGH the port — the
  // route reaches the card, the rows render, and the hover draws candles.
  const realFetch = globalThis.fetch
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  const klines = Array.from({ length: 24 }, (_, index) => {
    const minute = String(31 + index).padStart(2, '0')
    const open = 60 + index / 10
    const close = open + (index % 2 === 0 ? 0.4 : -0.3)
    return `2026-09-30 09:${minute},${open.toFixed(2)},${close.toFixed(2)},${(Math.max(open, close) + 0.2).toFixed(2)},${(Math.min(open, close) - 0.2).toFixed(2)},${1000 + index},${100000 + index}`
  })
  // Neutral names on purpose: the panel FILTERS new listings (`N…`) and delisting
// (`…退`) out of the board, because their move is not the market's. A fixture
// called `N力勤` would come back as 19 rows and look like an off-by-one.
  const rows = (dir) => Array.from({ length: 20 }, (_, index) => ({
    secid: `0.00${String(index).padStart(4, '0')}`,
    code: `00${String(index).padStart(4, '0')}`,
    name: index === 0 ? (dir === 'up' ? '力勤科技' : '元道股份') : `样例${dir}${index}`,
    price: 10 + index,
    changePct: dir === 'up' ? 200 - index : -(50 - index),
    change: 1,
  }))
  globalThis.fetch = async (url, options) => {
    const target = String(url)
    if (target.includes('/clist/get')) {
      // Their route reads BOTH directions from one pair of calls, filtered.
      return json({
        data: {
          total: 5921,
          diff: (target.match(/po=0/) ? rows('down') : rows('up')).map((row) => ({
            f2: row.price, f3: row.changePct, f4: row.change, f12: row.code.slice(2), f13: 0, f14: row.name,
          })),
        },
      })
    }
    if (target.includes('kline/get')) return json({ data: { name: '力勤科技', code: '0000', klines } })
    return realFetch(url, options)
  }
  t.after(() => { globalThis.fetch = realFetch })

  const app = await bootCard()
  t.after(() => app.dispose())
  const w = app.w
  const click = (element) => element.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
  const hover = (element) => element.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))

  assert.ok(await waitFor(() => w.document.querySelector('.mk-root') !== null, { timeoutMs: 30_000 }),
    'the markets card is up')

  // The leaderboard is a VIEW of the card, and 自选 is what you land on — so it has
  // to be switched to, the way a person would.
  const tab = (text) => [...w.document.querySelectorAll('button')].find((button) => button.textContent === text)
  assert.ok(tab('自选') && tab('涨幅榜') && tab('跌幅榜'), 'the three views are offered')
  click(tab('涨幅榜'))

  assert.ok(await waitFor(() => w.document.querySelector('[data-act="rank-table"]') !== null, { timeoutMs: 20_000 }),
    'the leaderboard is in the card')
  const table = w.document.querySelector('[data-act="rank-table"]')
  const body = [...table.querySelectorAll('.mk-rrow')]
  assert.equal(body.length, 20, '前 20')

  // The hover chart is the card's own, drawn with the shell's shared chart.
  hover(body[0])
  assert.ok(
    await waitFor(() => w.document.querySelector('[data-act="rank-hover"] svg.hud-k-svg') !== null, { timeoutMs: 5_000 }),
    'hovering a row draws that stock\'s intraday candles',
  )
  const pop = w.document.querySelector('[data-act="rank-hover"]')
  assert.match(pop.textContent, /当日分时/)
  assert.ok(pop.querySelectorAll('rect, line, path, polygon').length >= 10, 'candles, not an empty box')
  assert.equal(pop.querySelector('[data-act="rank-hover-wait"]'), null, 'and the loading line is gone')

  // Switching to the losers is the other half of the same answer.
  click(tab('跌幅榜'))
  await settle(4)
  assert.match(w.document.querySelector('[data-act="rank-table"]').textContent, /元道股份/)
})

test('the right slot is the database card or the SSH card, never both', async (t) => {
  // The whole promise of `hud.rightCard`: the two are ONE SLOT. So this asserts
  // both halves — the chosen card is there, and the other is not merely hidden but
  // absent from the grid the shell renders from.
  const database = await bootCard({ rightCard: 'database' })
  t.after(() => database.dispose())
  assert.ok(
    await waitFor(() => database.w.document.querySelector('.sq-root') !== null, { timeoutMs: 30_000 }),
    'the database card is the default',
  )
  assert.equal(database.w.document.querySelector('.ssh-root'), null, 'and SSH is nowhere in the document')

  const ssh = await bootCard({ rightCard: 'ssh' })
  t.after(() => ssh.dispose())
  assert.ok(
    await waitFor(() => ssh.w.document.querySelector('.ssh-root') !== null, { timeoutMs: 30_000 }),
    'switching the setting puts the SSH card in the slot',
  )
  assert.equal(ssh.w.document.querySelector('.sq-root'), null, 'and the SQL card is gone, not hidden')
  // The registry is what the shell renders from, so it is the thing to check: a
  // card that only looks absent would come back on the next layout edit.
  const ids = [...ssh.w.document.querySelectorAll('.hud-panel[data-panel]')].map((node) => node.getAttribute('data-panel'))
  assert.equal(ids.includes('sql'), false, `sql must not be a panel at all — saw ${ids.join(', ')}`)
  assert.ok(ids.includes('ssh'), `the ssh panel must be in the grid — saw ${ids.join(', ')}`)
})

test('the SSH card offers a terminal, a host picker and host management', async (t) => {
  const app = await bootCard({
    rightCard: 'ssh',
    sqlConnections: [
      { id: 'ssh-1', driver: 'postgres', name: 'web-1' },
    ],
  })
  t.after(() => app.dispose())
  const w = app.w
  const root = () => w.document.querySelector('.ssh-root')

  assert.ok(await waitFor(() => root() !== null, { timeoutMs: 30_000 }), 'expected the SSH card')
  const card = root()
  assert.match(card.textContent, /SSH/)
  // The terminal's mount point exists before a connection does — xterm is created
  // into it on connect, so an empty box is the correct resting state.
  assert.ok(card.querySelector('.ssh-term'), 'the terminal host element is there before connecting')
  assert.equal(card.querySelector('.ssh-term').className.includes('is-off'), true, 'and hidden until connected')

  // The ⚙ is the host manager, and it is the only place a host is added.
  const gear = [...card.querySelectorAll('button')].find((button) => button.textContent === '⚙')
  assert.ok(gear, 'expected the host-management button')
  gear.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
  await settle(2)
  assert.ok(root().textContent.includes('新建主机'), 'the gear opens the host list with an add button')
})

test('every stylesheet the bundle injects carries the CSP nonce', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()
  const styles = [...app.w.document.querySelectorAll('style[data-plugin="dsh-hud"]')]
  assert.ok(styles.length >= 3, `expected the shell and panel stylesheets, saw ${styles.length}`)
  for (const style of styles) {
    assert.equal(style.getAttribute('nonce'), 'test-nonce-1234', 'a stylesheet without the nonce would be blocked')
  }
})

test('the panel-fill rules do not depend on a height preference or a selector feature', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()

  const root = app.w.document.querySelector('.hud-root')
  const body = app.w.document.querySelector('.hud-body')
  const handle = app.w.document.querySelector('.hud-resize')
  assert.ok(root && body, 'expected the rendered card')
  // The layout must not hinge on the shell still rendering this, or on how.
  // Whatever mode it reports, and whether or not it is even there, the fill
  // rules are written to match.
  for (const mode of ['auto', 'manual']) {
    handle?.setAttribute('data-mode', mode)
    assert.equal(root.matches('.hud-root'), true, `the fill rules match in ${mode} mode`)
  }
  handle?.remove()
  assert.equal(root.matches('.hud-root'), true, 'and still match with no handle at all')
})

test('the panel-fill rules are unconditional and survive regeneration', () => {
  const css = read('media/theme.css')

  // The first two attempts keyed the fill off `:has()` and the shell's height
  // mode; both left a card that ignored every panel resize. The rules must now
  // reach the elements on their own.
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(
    /:has\(/.test(cssWithoutComments),
    false,
    'no layout rule may depend on :has() — a selector feature failing must not mean a broken card',
  )

  const block = (selector) => {
    const at = css.indexOf(`${selector} {`)
    assert.ok(at > 0, `expected a rule for ${selector}`)
    return css.slice(at, css.indexOf('}', at))
  }
  const root = block('.hud-root')
  assert.ok(root.includes('height: 100vh !important'), 'the card takes the panel height, and beats the vendor stylesheet')
  assert.ok(root.includes('display: flex !important') && root.includes('flex-direction: column !important'))
  assert.ok(block('.hud-root > .hud-card').includes('flex: 1 1 auto !important'), 'the card stretches')
  const grid = block('.hud-root .hud-body')
  assert.ok(grid.includes('max-height: none !important'), 'the shell\'s window-minus-composer cap is off')
  assert.ok(
    grid.includes('grid-auto-rows: minmax(var(--hud-row-h, 78px), 1fr) !important'),
    'rows share the leftover height',
  )
  assert.ok(grid.includes('flex: 1 1 auto !important') && grid.includes('min-height: 0 !important'))
  // The grip resized the HUD against a dock this host does not have; with the
  // panel driving the height it could only misreport, so it is gone.
  assert.ok(block('.hud-resize').includes('display: none !important'), 'the inert grip is removed')
})

test('the card arrangement round-trips through the host, not the webview', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()
  app.w.localStorage.setItem('dsh-hud/prefs', '{"columns":2}')
  await settle(2)
  assert.deepEqual(plain(app.storageWrites.at(-1)), { key: 'dsh-hud/prefs', value: '{"columns":2}' })
  assert.equal(app.w.localStorage.getItem('dsh-hud/prefs'), '{"columns":2}')

  // A seed injected by the host is visible synchronously, which is what the
  // shell needs while it mounts.
  const seeded = await bootCard({ storage: { 'dsh-hud/prefs': '{"columns":1}' } })
  t.after(() => seeded.dispose())
  assert.equal(seeded.w.localStorage.getItem('dsh-hud/prefs'), '{"columns":1}')
})

test('notifications and clipboard go to the host', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()

  new app.w.Notification('待办提醒', { body: '1 小时后开始' })
  await settle(2)
  assert.deepEqual(plain(app.notificationsSent.at(-1)), { title: '待办提醒', body: '1 小时后开始' })
  assert.equal(app.w.Notification.permission, 'granted')
  assert.equal(await app.w.Notification.requestPermission(), 'granted')

  await app.w.navigator.clipboard.writeText('npm i x')
  assert.equal(await app.w.navigator.clipboard.readText(), 'from-host-clipboard')
})

test('window.open hands the URL to the host instead of navigating', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()
  app.w.open('https://example.com/authorize', '_blank', 'noopener')
  await settle(2)
  assert.deepEqual(plain(app.openedExternal.at(-1)), { url: 'https://example.com/authorize' })
})

test('the fetch shim turns a same-origin route into a real Response', async (t) => {
  const app = await bootCard()
  t.after(() => app.dispose())
  await settle()

  const ok = await app.w.fetch('/dsh-hud/quota/usage', { cache: 'no-store', signal: app.w.AbortSignal.timeout(20_000) })
  assert.equal(ok.status, 200)
  assert.equal(ok.ok, true)
  const payload = await ok.json()
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.subscriptions), 'the quota payload is the normalized shape')

  const missing = await app.w.fetch('/dsh-hud/not-a-panel/x')
  assert.equal(missing.status, 404)
  assert.equal(missing.ok, false)
})

test('a bare credential shows the card\'s own fix-it panel instead of failing', async (t) => {
  const app = await bootCard({ panels: { quota: { pollMs: 60_000 } } })
  t.after(() => app.dispose())
  await settle()

  const answer = await app.ctx.table.dispatch({ path: '/dsh-hud/quota/usage', method: 'GET' })
  const payload = JSON.parse(answer.body)
  const quotaRow = payload.subscriptions.find((row) => row.kind === 'opencode-go')
  assert.ok(quotaRow, 'the fallback subscription row exists')
  assert.match(quotaRow.error, /未配置 API Key/)
  assert.match(quotaRow.hint.title, /请配置 credential/)
  // The card renders that hint as a panel; the drawer's ref list rides along.
  assert.ok(app.w.document.querySelector('.hud-card'), 'the card is still on screen')
})

test('a seeded credential and a local upstream produce real quota data', async (t) => {
  const server = await startServer({
    // The opencode-go rule keeps only a `/zen/go` base, so the fake gateway
    // has to live under that path.
    'GET /zen/go/v1/usage': () => ({ usage: { rolling: { percent: 1 }, weekly: { percent: 10 }, monthly: { percent: 29 } } }),
  })
  const app = await bootCard({
    secrets: { OPENCODE_GO_API_KEY: 'sk-test' },
    panels: {
      quota: {
        baseUrl: `${server.url}/zen/go`,
        subscriptions: [{ id: 'opencode', kind: 'opencode-go', baseUrl: `${server.url}/zen/go` }],
      },
    },
  })
  t.after(async () => {
    app.dispose()
    await server.close()
  })
  await settle(6)

  const answer = await app.ctx.table.dispatch({ path: '/dsh-hud/quota/usage', method: 'GET' })
  const payload = JSON.parse(answer.body)
  const row = payload.subscriptions[0]
  assert.deepEqual(row.windows.map((w) => [w.key, w.percent]), [['rolling', 1], ['weekly', 10], ['monthly', 29]])
  assert.equal(row.credentials[0].present, true)
  assert.ok(server.seen.some((s) => s.path === '/zen/go/v1/usage'), 'the panel really called the upstream')
})

test('a failing panel cannot blank the card', async (t) => {
  // A vendor that answers 500 makes the quota row report an error; the shell
  // still renders, and the other panels are untouched.
  const server = await startServer({ 'GET /zen/go/v1/usage': () => ({ __status: 500, __body: {} }) })
  const app = await bootCard({
    secrets: { OPENCODE_GO_API_KEY: 'sk-test' },
    panels: { quota: { baseUrl: `${server.url}/zen/go` } },
  })
  t.after(async () => {
    app.dispose()
    await server.close()
  })
  await settle(6)
  assert.ok(app.w.document.querySelector('.hud-card'), 'the card survives a panel failure')
  const answer = await app.ctx.table.dispatch({ path: '/dsh-hud/quota/usage', method: 'GET' })
  assert.match(JSON.parse(answer.body).subscriptions[0].error, /HTTP 500/)
})

// ── the runtime's own surface ──────────────────────────────────────────────
test('the runtime reports a failure instead of leaving an empty panel', async (t) => {
  const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="hud-root"></div></body></html>', {
    url: 'http://127.0.0.1:19387/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const w = dom.window
  t.after(() => w.close())
  w.Response = Response
  w.acquireVsCodeApi = () => ({ postMessage: () => {} })
  w.__hudHost = { storage: {}, nonce: 'n' }
  w.eval(read('media/react.js'))
  w.eval(read('media/runtime.js'))
  // No client.js: the loader was never called, which is a real failure mode
  // (a bad localResourceRoots, a missing file) and must be visible.
  w.__hudBoot()
  const box = w.document.querySelector('[data-hud-error]')
  assert.ok(box, 'expected the failure panel')
  assert.match(box.textContent, /HUD 启动失败/)
  assert.match(box.textContent, /client\.js 没有调用/)
})