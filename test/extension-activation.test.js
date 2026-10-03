// Extension tests: activate the real src/extension.js against the mock API and
// drive the webview protocol, the commands, the settings wiring and the
// credential path.
//
// What this catches that the webview suite cannot: a bad contribution id, a
// command that throws, a CSP that would block the card's own stylesheets, a
// secret echoed back over the wire, or a settings edit that never reaches the
// panels.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } = require('node:fs')
const { join, dirname } = require('node:path')
const Module = require('node:module')

const stub = require('./vscode-stub')
const { tempDir, settle } = require('./harness')

// `DSH_HUD_EXT_ROOT` points at an extracted .vsix, so the same suite can be run
// against the manifest, media and hud tree that actually ship.
const ROOT = process.env.DSH_HUD_EXT_ROOT || join(__dirname, '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const HUD_MANIFEST = JSON.parse(readFileSync(join(ROOT, 'hud', 'package.json'), 'utf8'))

// `src/extension.js` captures `require('vscode')` once, so the routing is
// installed a single time and points at whichever mock is current.
let current = null
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return current.vscode
  return originalLoad.apply(this, arguments)
}

/** Boot the extension in a temp DSH home. */
function boot(options = {}) {
  const tmp = tempDir()
  const mock = stub.createMockVscode({
    ...options,
    settings: { credentialsFile: join(tmp.dir, '.credentials.yaml'), ...(options.settings ?? {}) },
  })
  current = mock
  stub.setCurrent(mock)
  // Hermetic: without this the extension reads the developer's OWN DSH profile
  // and credential document, so the suite would pass or fail depending on what
  // the person running it happens to have configured.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp.dir
  // Seeded BEFORE activation, so the store's parse cache never holds the empty
  // document this overwrites.
  const credentials = options.credentials ?? {}
  if (Object.keys(credentials).length > 0) {
    writeFileSync(mock.settings.credentialsFile, [
      'version: 1',
      'refs:',
      ...Object.entries(credentials).map(([ref, value]) => `  ${ref}: ${value}`),
      '',
    ].join('\n'), 'utf8')
  }
  const globalState = new Map(Object.entries(options.globalState ?? {}))
  const context = stub.createContext(ROOT, { secrets: new Map(), globalState })
  delete require.cache[require.resolve('../src/extension')]
  const extension = require('../src/extension')
  extension.activate(context)

  const openView = () => {
    const view = stub.createWebviewView()
    mock.calls.viewProvider.provider.resolveWebviewView(view)
    return view
  }

  return {
    ...mock,
    tmp,
    extension,
    context,
    globalState,
    openView,
    /** Write a DSH profile patch, so the loader table has something in it. */
    writeProfile: (providers, name = 'desktop') => {
      const file = join(tmp.dir, 'profiles', name, 'cordis.patch.yml')
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, [
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        ...Object.keys(providers).flatMap((id) => [`      ${id}:`, `        apiKeyEnv: ${providers[id]}`]),
        '',
      ].join('\n'), 'utf8')
      return file
    },
    dispose: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      for (const disposable of context.subscriptions) {
        try {
          disposable.dispose?.()
        } catch {
          /* already gone */
        }
      }
      tmp.dispose()
    },
  }
}

// ── the manifest ───────────────────────────────────────────────────────────
test('the manifest contributes the panel view, its commands and its settings', () => {
  // The Marketplace id is `<publisher>.<name>` — the name is this port's own
  // (`vscode-full-featured-hub`, following the upstream's `…-full-featured-hub`),
  // while the VERSION follows the upstream tree it ships.
  assert.equal(MANIFEST.name, 'vscode-full-featured-hub')
  assert.equal(MANIFEST.version, HUD_MANIFEST.version, 'the extension reports the HUD package version')
  assert.equal(MANIFEST.main, './src/extension.js')
  assert.equal(MANIFEST.extensionKind[0], 'ui', 'secrets and $DSH_HOME live on this machine')
  const panel = MANIFEST.contributes.viewsContainers.panel.find((entry) => entry.id === 'hud')
  assert.ok(panel, 'expected the bottom-panel container')
  assert.equal(existsSync(join(ROOT, panel.icon)), true)
  assert.deepEqual(
    [MANIFEST.contributes.views.hud[0].id, MANIFEST.contributes.views.hud[0].type],
    ['hud.card', 'webview'],
  )
  const ids = MANIFEST.contributes.commands.map((command) => command.command).sort()
  assert.deepEqual(ids, [
    'hud.diagnostics', 'hud.openCredentialsFile', 'hud.openSettings',
    'hud.quotaPlatforms', 'hud.quotaReset', 'hud.reload', 'hud.resetLayout',
    'hud.rightCard', 'hud.setCredential', 'hud.show', 'hud.sqlConnections', 'hud.sshHosts',
  ])
  for (const menu of MANIFEST.contributes.menus['view/title']) {
    assert.ok(ids.includes(menu.command), `${menu.command} is in a menu but not contributed`)
  }
  assert.deepEqual(Object.keys(MANIFEST.contributes.configuration.properties).sort(), [
    'hud.credentialStore', 'hud.credentialsFile', 'hud.dshProfile', 'hud.language',
    'hud.notifications', 'hud.panels', 'hud.quotaDiscovery', 'hud.retainContext',
    'hud.rightCard', 'hud.sshStrictHostKey', 'hud.statusBar',
  ])
  assert.ok(MANIFEST.dependencies.yaml, 'the yaml parser is a runtime dependency')
  assert.ok(MANIFEST.dependencies.ssh2, 'and the SSH client is one too — the card cannot shell out')
  assert.equal(MANIFEST.scripts.package.includes('--no-dependencies'), false)

  // Every declared setting must also be MODELED, or it is documented and
  // unreachable — the failure mode that hid `hud.dshProfile` and `hud.language`.
  const { DEFAULTS } = require('../src/settings')
  const declared = Object.keys(MANIFEST.contributes.configuration.properties).map((key) => key.replace(/^hud\./, ''))
  assert.deepEqual(declared.sort(), Object.keys(DEFAULTS).sort(), 'a declared setting nobody reads is a lie')
})

test('the HUD tree ships as its own module package, unmodified', () => {
  // NOT a hardcoded name: the upstream renames its own package as it likes (it has
  // already gone from `dsh-hud` to a scoped name), and pinning the string here only
  // ever produces a test that fails for a reason nobody cares about. What matters is
  // that the tree is a loadable ESM package and that the port ships ITS version.
  assert.match(HUD_MANIFEST.name, /dsh|hud/i, 'the tree is a package, whatever it is called')
  assert.equal(HUD_MANIFEST.type, 'module', 'the host half is ESM and is imported, not required')
  assert.equal(HUD_MANIFEST.version, MANIFEST.version, 'the port mirrors the upstream version')
  for (const file of ['index.js', 'client.js', 'lib/host-kit.js', 'panels/index.js', 'panels/quota/host.js']) {
    assert.ok(existsSync(join(ROOT, 'hud', file)), `${file} must be present`)
  }
})

test('every install command in the docs names the extension this manifest declares', () => {
  // The Marketplace ID is `<publisher>.<name>`, and this repository has changed it
  // twice. Each change silently invalidated the install line in the docs — which is
  // the one line a reader copies — so the rule is checked instead of remembered.
  // An INSTALL line must name either the current ID or a .vsix; the old IDs may
  // still appear in `--uninstall-extension` lines, which is where they belong.
  const id = `${MANIFEST.publisher}.${MANIFEST.name}`
  for (const file of ['README.md', 'PUBLISHING.md', 'CHANGELOG.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const installs = [...text.matchAll(/code --install-extension (\S+)/g)].map((match) => match[1])
    // The changelog talks about removing an old extension, not installing one.
    if (file !== 'CHANGELOG.md') assert.ok(installs.length > 0, `${file} should document how to install`)
    for (const target of installs) {
      const ok = target === id || target.endsWith('.vsix')
      assert.ok(ok, `${file} tells the reader to install "${target}", which is neither ${id} nor a .vsix`)
    }
  }
  // And the uninstall notes must name the IDs that actually existed, or they send
  // someone hunting for an extension that was never installed.
  const publishing = readFileSync(join(ROOT, 'PUBLISHING.md'), 'utf8')
  for (const retired of ['dsh-hud.dsh-hud', 'dsh-hud.vscode-full-featured-hub']) {
    assert.ok(publishing.includes(retired), `PUBLISHING.md should still say how to remove ${retired}`)
  }

  // The README's title IS the listing title on the Marketplace page, so the two must
  // not drift: `displayName` is displayed directly above the README, and seeing two
  // different names is how a reader stops trusting the page. It also has to be
  // specific — a bare generic word is rejected by the Marketplace as already taken.
  const heading = readFileSync(join(ROOT, 'README.md'), 'utf8').match(/^# (.+)$/m)
  assert.ok(heading, 'README.md needs a top-level heading')
  assert.equal(heading[1].trim(), MANIFEST.displayName, 'the README title must be the listing title')
  assert.ok(MANIFEST.displayName.trim().length >= 8, 'a display name this short is almost certainly taken')
})

test('publish.ps1 stays runnable by Windows PowerShell 5.1, and verifies before it publishes', () => {
  const file = join(ROOT, 'publish.ps1')
  if (!existsSync(file)) return
  // The BOM is not cosmetic. This script's messages are Chinese, and Windows
  // PowerShell reads a .ps1 WITHOUT a BOM as ANSI: the parser then fails with
  // "unexpected }" pointing at lines that contain no brace at all, and the release
  // script cannot run. An editor that rewrites the file can silently drop the BOM,
  // which is exactly why it is asserted here rather than remembered.
  const bytes = readFileSync(file)
  assert.deepEqual(
    [...bytes.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    'publish.ps1 must start with a UTF-8 BOM or 5.1 cannot parse it',
  )
  const text = bytes.toString('utf8')
  assert.match(text, /VSCE_PAT/, 'a token must be acceptable from the environment, for CI')
  assert.match(text, /Read-Host -AsSecureString/, 'and prompted for when there is no CI')
  // Order matters: a publish attempt with a bad token is a wasted round trip and a
  // confusing error, while verify-pat says exactly what is wrong.
  const verify = text.indexOf('verify-pat')
  const publish = text.indexOf('publish --packagePath')
  assert.ok(verify > 0 && publish > 0, 'the script must both verify and publish')
  assert.ok(verify < publish, 'verify-pat must come before the publish call')
})

// ── activation ─────────────────────────────────────────────────────────────
test('activation registers the view provider and every command', (t) => {
  const app = boot()
  t.after(() => app.dispose())
  assert.equal(app.calls.viewProvider.id, 'hud.card')
  assert.equal(typeof app.calls.viewProvider.provider.resolveWebviewView, 'function')
  for (const command of MANIFEST.contributes.commands) {
    assert.ok(app.commands.has(command.command), `${command.command} was not registered`)
  }
})

test('the card document carries the CSP, the theme and the script order', (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  assert.equal(view.webview.options.enableScripts, true)
  assert.equal(view.webview.options.localResourceRoots.length, 2, 'media/ and hud/ only')
  const html = view.webview.html
  const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html)[1]
  assert.ok(nonce.length >= 32)
  assert.match(html, new RegExp(`<style nonce="${nonce}"`))
  assert.equal(html.includes('unsafe-inline'), false)
  assert.match(html, /connect-src 'none'/)
  // The theme adapter is inlined and really is the generated one.
  assert.match(html, /--dsw-alias-label-primary: var\(--vscode-foreground/)
  assert.match(html, /\.hud-root/)
  // The scripts, in the order the runtime needs them. Matched on the
  // `src="` attribute: the theme stylesheet's own header mentions
  // `hud/client.js`, so a bare substring search would match the CSS.
  const order = ['media/react.js', 'media/xterm.js', 'media/ssh-card.js', 'media/runtime.js', 'hud/client.js']
    .map((name) => html.indexOf(`src="vscode-webview://test/${name}"`))
  assert.ok(order.every((at) => at > 0), `every script must be referenced — saw ${order.join(', ')}`)
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'react → the terminal and the ssh card (globals the runtime reads at boot) → runtime → the vendor bundle',
  )
  assert.match(html, /window\.__hudBoot\(\)/)
  assert.match(html, /<html lang="zh-CN">/)
})

test('the card renders in the language DSH itself is set to', async (t) => {
  // The shell picks its language with `pickLocale()`, which reads the document's
  // `lang` — set in DSH by the locale plugin. The profile is therefore the
  // faithful source, and it must win over the editor's display language.
  const app = boot({ language: 'en-US' })
  t.after(() => app.dispose())
  app.writeProfile({ 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY' })
  writeFileSync(join(app.tmp.dir, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: locale',
    '  name: "@deepseek-ai/dsh-client-locale"',
    '  config:',
    '    preference: zh',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers: {}',
    '',
  ].join('\n'), 'utf8')

  const view = app.openView()
  assert.match(view.webview.html, /<html lang="zh-CN">/, 'a Chinese DSH locale beats an English editor')

  await app.commands.get('hud.diagnostics')()
  const text = app.outputChannel.lines.join('\n')
  assert.match(text, /card language {4}: zh {3}← DSH locale preference/)
})

test('hud.language pins the card, whatever the profile says', async (t) => {
  const app = boot({ language: 'zh-cn', settings: { language: 'en' } })
  t.after(() => app.dispose())
  const view = app.openView()
  assert.match(view.webview.html, /<html lang="en">/)
  await app.commands.get('hud.diagnostics')()
  assert.match(app.outputChannel.lines.join('\n'), /card language {4}: en {3}← hud\.language \(pinned\)/)
})

test('with no profile and an English editor the card is English', async (t) => {
  const app = boot({ language: 'en' })
  t.after(() => app.dispose())
  assert.match(app.openView().webview.html, /<html lang="en">/)
})

test('changing the language re-creates the card', async (t) => {
  const app = boot({ settings: { language: 'zh' } })
  t.after(() => app.dispose())
  app.openView()
  const before = app.calls.viewProvider

  await app.vscode.workspace.getConfiguration().update('language', 'en', 1)
  // The language is baked into the document, so `reload()` — which re-runs the
  // script already in it — could not change it. Only a re-resolve can.
  assert.notEqual(app.calls.viewProvider, before, 'the view provider was re-registered')
  assert.match(app.openView().webview.html, /<html lang="en">/)
})

test('the layout the host remembers is embedded in the document', (t) => {
  const app = boot({ globalState: { 'hud.storage.dsh-hud/prefs': '{"columns":2}', 'other.key': 'ignored' } })
  t.after(() => app.dispose())
  const view = app.openView()
  const payload = /window\.__hudHost = (\{.*?\});/.exec(view.webview.html)[1]
  const host = JSON.parse(payload)
  assert.deepEqual(host.storage, { 'dsh-hud/prefs': '{"columns":2}' }, 'only hud.storage.* is seeded')
  assert.equal(host.notifications, true)
  assert.equal(host.version, '2.0.0')
})

// ── the RPC surface ────────────────────────────────────────────────────────
test('the route RPC reaches the real host half', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  const reply = await view.request('route', { path: '/dsh-hud/quota/usage', method: 'GET' })
  assert.equal(reply.ok, true)
  assert.equal(reply.data.status, 200)
  const payload = JSON.parse(reply.data.body)
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.subscriptions))
})

test('an unknown route answers 404 and an unknown method is refused', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  const missing = await view.request('route', { path: '/dsh-hud/nope/x' })
  assert.equal(missing.ok, true)
  assert.equal(missing.data.status, 404)
  const bogus = await view.request('definitely-not-a-method')
  assert.equal(bogus.ok, false)
  assert.match(bogus.error, /unknown method/)
})

test('storage writes land in globalState under the hud prefix', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  const written = await view.request('storage.set', { key: 'dsh-hud/prefs', value: '{"columns":3}' })
  assert.deepEqual(written.data, { ok: true })
  assert.equal(app.globalState.get('hud.storage.dsh-hud/prefs'), '{"columns":3}')
  // A null value clears the key rather than storing "null".
  await view.request('storage.set', { key: 'dsh-hud/prefs', value: null })
  assert.equal(app.globalState.has('hud.storage.dsh-hud/prefs'), false)
  const bad = await view.request('storage.set', { key: '', value: 'x' })
  assert.equal(bad.ok, false)
})

test('clipboard and notifications go to the host', async (t) => {
  const app = boot({ clipboardText: 'pasted-cookie' })
  t.after(() => app.dispose())
  const view = app.openView()

  await view.request('clipboard.write', { text: 'npm i x' })
  assert.deepEqual(app.calls.clipboardWrites, ['npm i x'])
  const read = await view.request('clipboard.read')
  assert.deepEqual(read.data, { text: 'pasted-cookie' })

  await view.request('notify', { title: '待办提醒', body: '1 小时后开始' })
  assert.deepEqual(app.calls.infoMessages, ['待办提醒 — 1 小时后开始'])
})

test('notifications can be switched off', async (t) => {
  const app = boot({ settings: { notifications: false } })
  t.after(() => app.dispose())
  const view = app.openView()
  await view.request('notify', { title: 't', body: 'b' })
  assert.deepEqual(app.calls.infoMessages, [])
})

test('openExternal only accepts http(s)', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  const opened = await view.request('openExternal', { url: 'https://github.com/login/device' })
  assert.equal(opened.ok, true)
  assert.deepEqual(app.calls.openedExternal, ['https://github.com/login/device'])

  for (const url of ['file:///etc/passwd', 'command:workbench.action.quit', 'vscode://x']) {
    const refused = await view.request('openExternal', { url })
    assert.equal(refused.ok, false, `${url} must be refused`)
    assert.match(refused.error, /not an http\(s\) URL/)
  }
})

// ── settings reach the panels ──────────────────────────────────────────────
test('a hud.panels edit reaches the panels without a restart', async (t) => {
  const app = boot({ settings: { panels: { quota: { pollMs: 120_000 } } } })
  t.after(() => app.dispose())
  const view = app.openView()

  const first = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.equal(first.pollMs, 120_000, 'the panel read the configured cadence')

  // The framework re-reads `config.panels[id]` on every poll, so mutating the
  // object is what makes an edit live.
  await app.vscode.workspace.getConfiguration().update('panels', { quota: { pollMs: 90_000 } }, 1)
  await settle(2)
  const second = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.equal(second.pollMs, 90_000)
})

test('a panel slice that is not an object is ignored, and diagnostics says so', async (t) => {
  const app = boot({ settings: { panels: { quota: ['not', 'an', 'object'], github: { perRepoLimit: 5 } } } })
  t.after(() => app.dispose())
  await app.commands.get('hud.diagnostics')()
  const text = app.outputChannel.lines.join('\n')
  assert.match(text, /hud\.panels: quota 不是对象/)
  assert.match(text, /hud\.panels keys {2}: github/)
})

// ── credentials ────────────────────────────────────────────────────────────
test('setCredential writes the secret and never echoes it back', async (t) => {
  const app = boot({
    answers: { quickPick: { label: 'GITHUB_TOKEN', ref: 'GITHUB_TOKEN' }, inputBox: 'ghp_secret_value' },
  })
  t.after(() => app.dispose())
  await app.commands.get('hud.setCredential')()
  const box = app.calls.inputBoxes[0]
  assert.equal(box.password, true)
  assert.ok(box.validateInput(''), 'an empty value is rejected')
  assert.equal(box.validateInput('ok'), undefined)
  assert.match(readFileSync(app.settings.credentialsFile, 'utf8'), /GITHUB_TOKEN: ghp_secret_value/)
  assert.equal(app.calls.infoMessages.some((m) => /GITHUB_TOKEN 已保存到/.test(m)), true)
  assert.doesNotMatch(JSON.stringify(app.calls.infoMessages), /ghp_secret_value/)
})

test('setCredential can type a ref name the shipped panels do not use', async (t) => {
  const app = boot({ answers: { quickPick: { label: '手动引用名', ref: '' } } })
  t.after(() => app.dispose())
  const answers = ['MY_QUOTA_KEY', 'sk-typed-by-hand']
  let index = 0
  app.vscode.window.showInputBox = async (options) => {
    app.calls.inputBoxes.push(options)
    return answers[index++]
  }
  await app.commands.get('hud.setCredential')()
  assert.match(readFileSync(app.settings.credentialsFile, 'utf8'), /MY_QUOTA_KEY: sk-typed-by-hand/)
})

test('openCredentialsFile creates a document DSH can read, and never overwrites one', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  await app.commands.get('hud.openCredentialsFile')()
  assert.equal(readFileSync(app.settings.credentialsFile, 'utf8'), 'version: 1\nrefs:\n')
  assert.equal(app.calls.openedDocument.fsPath, app.settings.credentialsFile)

  writeFileSync(app.settings.credentialsFile, 'version: 1\nrefs:\n  KEEP: me\n', 'utf8')
  await app.commands.get('hud.openCredentialsFile')()
  assert.match(readFileSync(app.settings.credentialsFile, 'utf8'), /KEEP: me/)
})

test('a credential saved by the command is visible to the panels', async (t) => {
  // A made-up ref, so nothing ambient (an env var, a real `.env`, the machine's
  // own `~/.dsh/.credentials.yaml`) can make the assertion meaningless.
  const REF = 'DSH_HUD_TEST_ONLY_REF'
  const app = boot({
    settings: {
      panels: { quota: { subscriptions: [{ id: 'q', kind: 'opencode-go', apiKeyEnv: REF, baseUrl: 'http://127.0.0.1:1' }] } },
    },
    answers: { quickPick: { label: REF, ref: REF }, inputBox: 'sk-live' },
  })
  t.after(() => app.dispose())
  const view = app.openView()

  const before = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.deepEqual(before.subscriptions[0].credentials, [{ ref: REF, present: false }])

  await app.commands.get('hud.setCredential')()
  const after = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.equal(after.subscriptions[0].credentials[0].present, true, 'the panel sees the new secret immediately')
})

// ── commands ───────────────────────────────────────────────────────────────
test('reload pushes a reload to every open card', (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()
  app.commands.get('hud.reload')()
  assert.equal(view.posted.some((message) => message.type === 'reload'), true)
})

test('resetLayout clears only the hud layout keys, after confirming', async (t) => {
  const app = boot({
    answers: { warning: '恢复默认' },
    globalState: { 'hud.storage.a': '1', 'hud.storage.b': '2', other: 'kept' },
  })
  t.after(() => app.dispose())
  app.openView()
  await app.commands.get('hud.resetLayout')()
  assert.equal(app.globalState.has('hud.storage.a'), false)
  assert.equal(app.globalState.has('hud.storage.b'), false)
  assert.equal(app.globalState.get('other'), 'kept')
})

test('resetLayout does nothing when the confirmation is dismissed', async (t) => {
  const app = boot({ answers: { warning: undefined }, globalState: { 'hud.storage.a': '1' } })
  t.after(() => app.dispose())
  app.openView()
  await app.commands.get('hud.resetLayout')()
  assert.equal(app.globalState.get('hud.storage.a'), '1')
})

test('the show command focuses the contributed view', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  await app.commands.get('hud.show')()
  assert.equal(app.calls.commands.some((c) => c.id === 'hud.card.focus'), true)
})

test('diagnostics names every panel, the routes and the credential file', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  await app.commands.get('hud.diagnostics')()
  const text = app.outputChannel.lines.join('\n')
  // Both versions are reported, and the numbers are not pinned: the stub's manifest
  // version and the upstream's move independently of each other.
  assert.match(text, /HUD extension \d+\.\d+\.\d+ · hud package \d+\.\d+\.\d+/)
  assert.match(text, /credentials file : /)
  assert.match(text, /panels mounted {3}: /)
  assert.match(text, /routes registered: \d+/)
  assert.match(text, /\/dsh-hud\/quota\/usage/)
  assert.match(text, /layout storage {3}: \d+ key\(s\)/)
  for (const id of ['quota', 'github', 'todo', 'weather', 'parcel', 'market', 'futures', 'bond', 'sql']) {
    assert.ok(text.includes(id), `${id} missing from diagnostics`)
  }
})

test('openSettings opens the panels section', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  await app.commands.get('hud.openSettings')()
  assert.deepEqual(app.calls.commands.find((c) => c.id === 'workbench.action.openSettings').args, ['hud.panels'])
})

test('the card\'s own layout measurements reach diagnostics', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  // Diagnostics before the webview has said anything must say so, rather than
  // print zeros that look like a measurement.
  await app.commands.get('hud.diagnostics')()
  assert.match(app.outputChannel.lines.join('\n'), /no report yet/)

  // The report carries no id — it is unsolicited and expects no reply — which
  // is exactly the shape a naive `typeof id !== 'number'` guard drops.
  await view.send({
    method: 'layout',
    params: {
      viewport: { width: 1200, height: 640 },
      theme: { sheets: 12, fillRules: true, hasSelector: true },
      mode: 'auto',
      root: { height: 640, cssHeight: '640px', display: 'flex' },
      card: { height: 600, flex: '1 1 auto' },
      body: { height: 560, maxHeight: 'none', gridAutoRows: 'minmax(78px, 1fr)', rows: 4 },
      wastedBelow: 0,
      reportedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  assert.equal(view.posted.some((message) => message.method === 'layout'), false, 'a report gets no reply')

  await app.commands.get('hud.diagnostics')()
  const text = app.outputChannel.lines.join('\n')
  assert.match(text, /panel viewport : 1200×640/)
  assert.match(text, /fill rules present: true/)
  assert.match(text, /\.hud-root\s+: box 640px, css height 640px, display flex/)
  assert.match(text, /\.hud-card\s+: box 600px/)
  assert.match(text, /\.hud-body\s+: box 560px, max-height none/)
  assert.match(text, /grid-auto-rows minmax\(78px, 1fr\), 4 card\(s\)/)
  assert.match(text, /UNUSED BELOW\s+: 0px/)
  assert.match(text, /reported at {4}: 2026-01-01T00:00:00\.000Z/)
})

test('the DSH profile drives which platforms the balance card can offer', async (t) => {
  // A DeepSeek key as well, because that is the shape of a real machine: the
  // built-in discovery contributes a row, the profile contributes another, and
  // the card's picker renders on there being more than one.
  const app = boot({
    credentials: { DEEPSEEK_API_KEY: 'test-key-not-used' },
    // The profile's provider table is an `auto`-mode source; in the default
    // `chosen` mode the user's own list is the whole truth.
    settings: { quotaDiscovery: 'auto' },
  })
  t.after(() => app.dispose())
  app.writeProfile({ 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY' })
  const view = app.openView()

  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  const ids = body.subscriptions.map((sub) => sub.id)
  assert.ok(ids.includes('qwen-token-plan-cn'), `expected the profile's provider, saw ${ids.join(', ')}`)
  assert.ok(ids.includes('deepseek-official'), `expected built-in discovery too, saw ${ids.join(', ')}`)
  assert.ok(body.subscriptions.length > 1, 'more than one row is what makes the card\'s picker render')

  await app.commands.get('hud.diagnostics')()
  const text = app.outputChannel.lines.join('\n')
  assert.match(text, /dsh profile {6}: desktop \(auto\)/)
  assert.match(text, /loader entries : \d+/)
})

test('hud.dshProfile actually selects the named profile', async (t) => {
  // Auto-detection picks the newest patch, so a named profile that is OLDER is
  // the case that proves the setting is wired rather than merely declared.
  const app = boot({ settings: { dshProfile: 'web', quotaDiscovery: 'auto' } })
  t.after(() => app.dispose())
  app.writeProfile({ 'opencode-go': 'OPENCODE_GO_API_KEY' }, 'web')
  const desktop = app.writeProfile({ 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY' }, 'desktop')
  // `desktop` is written last, so auto-detection would choose it.
  const past = new Date(Date.now() - 60_000)
  utimesSync(desktop, past, past)

  const view = app.openView()
  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  const ids = body.subscriptions.map((sub) => sub.id)
  assert.ok(ids.includes('opencode-go'), `expected the named profile's provider, saw ${ids.join(', ')}`)
  assert.equal(ids.includes('qwen-token-plan-cn'), false, 'and not the newer one it was told to ignore')

  await app.commands.get('hud.diagnostics')()
  assert.match(app.outputChannel.lines.join('\n'), /dsh profile {6}: web \(hud\.dshProfile\)/)
})

test('a machine with no DSH profile still gets a working card', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()

  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.ok(body.subscriptions.length >= 1, 'built-in discovery must still stand on its own')
  await app.commands.get('hud.diagnostics')()
  assert.match(app.outputChannel.lines.join('\n'), /dsh profile {6}: \(none found\) \(auto\)/)
})

test('the quota platform chooser offers every platform the card can collect', async (t) => {
  const app = boot({ answers: { quickPick: undefined } })
  t.after(() => app.dispose())
  await app.commands.get('hud.quotaPlatforms')()

  const { items, options } = app.calls.quickPicks[0]
  assert.equal(options.canPickMany, true, 'this is a chooser, not a picker')
  assert.deepEqual(
    items.map((item) => item.platform.kind),
    ['opencode-go', 'deepseek', 'zai', 'commandcode', 'moonshot', 'grok', 'qwen', 'mimo', 'openrouter', 'siliconflow'],
  )
  // Every item has to say what it needs and what it shows — the difference
  // between a chooser and a list of vendor names nobody can act on.
  for (const item of items) {
    assert.ok(item.label.length > 0, 'a readable label')
    assert.ok(item.description.length > 0, `${item.platform.kind} must say what it needs`)
    assert.ok(item.detail.includes(item.platform.shows.zh), `${item.platform.kind} must say what it shows`)
    assert.equal(item.picked, false, 'nothing configured yet')
  }
  // A platform with a CLI login needs no credential, and must not claim one.
  assert.match(items.find((item) => item.platform.kind === 'grok').description, /已可出数/)
  assert.match(items.find((item) => item.platform.kind === 'moonshot').description, /MOONSHOT_API_KEY/)
  assert.deepEqual(app.calls.infoMessages, [], 'cancelling must not report success')
})

test('choosing platforms writes subscriptions the card actually collects', async (t) => {
  const app = boot({
    answers: { quickPick: (items) => items.filter((item) => ['moonshot', 'zai'].includes(item.platform.kind)) },
  })
  t.after(() => app.dispose())

  const view = app.openView()
  await app.commands.get('hud.quotaPlatforms')()

  const written = app.settings.panels?.quota?.subscriptions
  assert.deepEqual(written.map((entry) => entry.kind), ['zai', 'moonshot'])
  // The endpoint is the one thing an explicit entry MUST carry: omitting it
  // inherits the panel's global default, which is OpenCode's gateway — a Kimi
  // row without one would silently query the wrong vendor.
  assert.equal(written.find((entry) => entry.kind === 'moonshot').baseUrl, 'https://api.moonshot.ai')
  assert.equal(written.find((entry) => entry.kind === 'zai').baseUrl, 'https://api.z.ai')
  assert.equal(written.find((entry) => entry.kind === 'zai').apiKeyEnv, 'ZAI_API_KEY')
  assert.equal(written.find((entry) => entry.kind === 'mimo'), undefined)
  assert.match(app.calls.infoMessages.join('\n'), /只显示 2 个平台/)

  // And the panel really does discover them — the whole point of the write.
  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  const ids = body.subscriptions.map((sub) => sub.id)
  assert.ok(ids.includes('moonshot'), `moonshot missing from ${ids.join(', ')}`)
  assert.ok(ids.includes('zai'), `zai missing from ${ids.join(', ')}`)
  const kinds = Object.fromEntries(body.subscriptions.map((sub) => [sub.id, sub.kind]))
  assert.equal(kinds.moonshot, 'moonshot')
  assert.equal(kinds.zai, 'zai')
})

test('the chooser offers to collect credentials it still needs', async (t) => {
  const app = boot({
    answers: {
      quickPick: (items) => items.filter((item) => ['moonshot', 'siliconflow'].includes(item.platform.kind)),
      info: '现在配置',
      inputBox: 'sk-pasted-by-hand',
    },
  })
  t.after(() => app.dispose())
  await app.commands.get('hud.quotaPlatforms')()

  const prompt = app.calls.infoPrompts.find((entry) => entry.items.includes('现在配置'))
  assert.ok(prompt, 'a missing credential must be offered, not just complained about')
  assert.match(prompt.message, /MOONSHOT_API_KEY/)
  assert.match(prompt.message, /SILICONFLOW_API_KEY/)
  assert.deepEqual(app.calls.inputBoxes.map((box) => box.title), ['HUD — MOONSHOT_API_KEY', 'HUD — SILICONFLOW_API_KEY'])
  for (const box of app.calls.inputBoxes) assert.equal(box.password, true, 'a secret must not be shown in the clear')
  assert.match(readFileSync(app.settings.credentialsFile, 'utf8'), /MOONSHOT_API_KEY: sk-pasted-by-hand/)
})

test('choosing nothing shows nothing — the gate is what the list says', async (t) => {
  const app = boot({
    credentials: { DEEPSEEK_API_KEY: 'test-key-not-used' },
    answers: { quickPick: () => [] },
  })
  t.after(() => app.dispose())
  app.writeProfile({ 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY' })
  const view = app.openView()
  await app.commands.get('hud.quotaPlatforms')()

  // Written as an EMPTY LIST, not deleted: absent means "do not gate me at all",
  // and the user has just said "show none of my own".
  assert.deepEqual(app.settings.panels.quota.subscriptions, [])
  assert.equal(app.settings.quotaDiscovery, 'chosen')
  assert.match(app.calls.infoMessages.join('\n'), /一个都没选/)

  // The panel always renders at least one row — its own fallback — so "none"
  // is that row and nothing else, not a live platform nobody asked for.
  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.deepEqual(body.subscriptions.map((sub) => sub.id), ['OPENCODE_GO_API_KEY'])
})

test('the gate never breaks the panel\'s own fallback row', async (t) => {
  // When the panel discovers nothing it renders one fallback row from its own
  // `apiKeyEnv`. Hiding that credential cannot remove the row — it can only
  // make it claim a key is missing when the user has one — so it is exempt.
  const app = boot({
    credentials: { OPENCODE_GO_API_KEY: 'present-but-unused' },
    // A closed port, so the collector fails fast on the NETWORK rather than on
    // a credential: that difference is exactly what this test is about.
    settings: { panels: { quota: { baseUrl: 'http://127.0.0.1:1' } } },
  })
  t.after(() => app.dispose())
  const view = app.openView()

  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.deepEqual(body.subscriptions.map((sub) => sub.id), ['OPENCODE_GO_API_KEY'])
  const [row] = body.subscriptions
  assert.deepEqual(row.credentials, [{ ref: 'OPENCODE_GO_API_KEY', present: true }], 'the ref is still visible')
  assert.doesNotMatch(String(row.error ?? ''), /未配置 API Key/, 'and the row must not claim it is unconfigured')
})

test('by default the card shows only what was chosen, not what it can find', async (t) => {
  // The machine can offer two more platforms: the profile's provider table and
  // the built-in DeepSeek source. Neither is on anyone's list yet.
  const app = boot({ credentials: { DEEPSEEK_API_KEY: 'test-key-not-used' } })
  t.after(() => app.dispose())
  app.writeProfile({ 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY' })
  const view = app.openView()

  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  const ids = body.subscriptions.map((sub) => sub.id)
  assert.equal(ids.includes('qwen-token-plan-cn'), false, `the profile's provider must wait to be chosen: ${ids.join(', ')}`)
  assert.equal(ids.includes('deepseek-official'), false, `so must the built-in DeepSeek row: ${ids.join(', ')}`)
})

test('the gate hides the platform\'s credentials from the panels, not from the user', async (t) => {
  const app = boot({ credentials: { DEEPSEEK_API_KEY: 'test-key-not-used' } })
  t.after(() => app.dispose())
  const view = app.openView()

  // This is the mechanism: the built-in DeepSeek row exists only when
  // `DEEPSEEK_API_KEY` resolves, so an unchosen platform's credential is not
  // visible. `present` has to agree, or a row would appear with a ref the
  // drawer then cannot fill.
  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.equal(body.subscriptions.some((sub) => sub.id === 'deepseek-official'), false)

  // The user's own view of the document is untouched: the credential is still
  // there, still reported as configured, still manageable by the command that
  // manages credentials.
  await app.commands.get('hud.setCredential')()
  const items = app.calls.quickPicks.at(-1).items
  assert.equal(items.find((item) => item.label === 'DEEPSEEK_API_KEY').description.startsWith('已配置'), true)
})

test('a chosen platform\'s credential is visible again', async (t) => {
  const app = boot({
    credentials: { DEEPSEEK_API_KEY: 'test-key-not-used' },
    settings: { panels: { quota: { subscriptions: [{ id: 'deepseek-official', kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' }] } } },
  })
  t.after(() => app.dispose())
  const view = app.openView()
  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.deepEqual(body.subscriptions.map((sub) => sub.id), ['deepseek-official'])
  assert.deepEqual(body.subscriptions[0].credentials, [
    { ref: 'DEEPSEEK_API_KEY', present: true },
    { ref: 'DEEPSEEK_USER_TOKEN', present: false },
  ])
})

test('reset restores the automatic discovery, list and mode together', async (t) => {
  const app = boot({
    credentials: { DEEPSEEK_API_KEY: 'test-key-not-used' },
    settings: { panels: { quota: { subscriptions: [{ id: 'zai', kind: 'zai' }], pollMs: 30_000 } } },
    answers: { warning: '恢复自动发现' },
  })
  t.after(() => app.dispose())
  await app.commands.get('hud.quotaReset')()
  assert.equal('subscriptions' in app.settings.panels.quota, false)
  assert.equal(app.settings.panels.quota.pollMs, 30_000, 'only the platform list is reset')
  assert.equal(app.settings.quotaDiscovery, 'auto', 'and the automatic sources come back')

  const view = app.openView()
  const body = JSON.parse((await view.request('route', { path: '/dsh-hud/quota/usage' })).data.body)
  assert.ok(body.subscriptions.some((sub) => sub.id === 'deepseek-official'), 'the built-in row is back')
  assert.match(app.calls.infoMessages.join('\n'), /恢复自动发现/)
})

test('reset does nothing when the confirmation is dismissed', async (t) => {
  const app = boot({
    settings: { panels: { quota: { subscriptions: [{ id: 'zai', kind: 'zai' }] } } },
    answers: { warning: undefined },
  })
  t.after(() => app.dispose())
  await app.commands.get('hud.quotaReset')()
  assert.deepEqual(app.settings.panels.quota.subscriptions.map((entry) => entry.kind), ['zai'])
  assert.equal(app.calls.updates.some((update) => update.key === 'quotaDiscovery'), false, 'a dismissed dialog changes nothing')
})

test('the refs the gate can hide are refs no other panel uses', () => {
  // `ctx.credentials` is shared by every panel, so hiding a ref must be
  // provably a quota-only act — checked against the panels' own source rather
  // than assumed.
  const { hiddenRefs } = require('../src/quota-catalog')
  const hiddable = hiddenRefs([])
  assert.ok(hiddable.size >= 8, `expected the catalog's refs, saw ${hiddable.size}`)
  assert.ok(hiddable.has('DEEPSEEK_API_KEY') && hiddable.has('DEEPSEEK_USER_TOKEN'))

  // Refs belonging to a chosen platform are not hidden; an unknown ref never is.
  const kept = hiddenRefs(['deepseek'])
  assert.equal(kept.has('DEEPSEEK_API_KEY'), false)
  assert.equal(kept.has('DEEPSEEK_USER_TOKEN'), false)
  assert.equal(kept.has('GITHUB_TOKEN'), false, 'a ref no platform owns is never touched')
  assert.equal(kept.has('DSH_HUD_TODO_TOKEN'), false)

  // The exemption, and proof it is doing work: the fallback ref IS in the
  // catalogue's ownership map, so only the explicit `keep` spares it.
  assert.equal(hiddable.has('OPENCODE_GO_API_KEY'), true, 'without the exemption it would be hidden')
  assert.equal(hiddenRefs([], 'OPENCODE_GO_API_KEY').has('OPENCODE_GO_API_KEY'), false)

  // And every ref the panels can read outside the quota card stays out of it.
  for (const ref of ['GITHUB_TOKEN', 'DSH_HUD_TODO_TOKEN', 'DSH_HUD_TODO_MAIL', 'DSH_HUD_TODO_OAUTH', 'PASSWORD']) {
    assert.equal(hiddable.has(ref), false, `${ref} belongs to another panel and must never be hidden`)
  }
})

test('a platform edit leaves every other panel\'s settings alone', async (t) => {
  const app = boot({
    settings: { panels: { github: { perRepoLimit: 30 }, sql: { timeoutMs: 5_000 } } },
    answers: { quickPick: (items) => items.filter((item) => item.platform.kind === 'grok') },
  })
  t.after(() => app.dispose())
  await app.commands.get('hud.quotaPlatforms')()

  assert.deepEqual(app.settings.panels.github, { perRepoLimit: 30 }, 'hud.panels carries every panel')
  assert.deepEqual(app.settings.panels.sql, { timeoutMs: 5_000 })
  assert.deepEqual(app.settings.panels.quota.subscriptions.map((entry) => entry.kind), ['grok'])
})

test('the chooser opens on what is already configured', async (t) => {
  const app = boot({
    settings: { panels: { quota: { subscriptions: [{ id: 'moonshot', kind: 'moonshot', baseUrl: 'https://api.moonshot.ai' }] } } },
    answers: { quickPick: undefined },
  })
  t.after(() => app.dispose())
  await app.commands.get('hud.quotaPlatforms')()
  const items = app.calls.quickPicks[0].items
  assert.equal(items.find((item) => item.platform.kind === 'moonshot').picked, true)
  assert.equal(items.filter((item) => item.picked).length, 1)
})

test('the catalog\'s endpoints and kinds match the panel\'s own collectors', async (t) => {
  // The catalog is hand-written data about someone else's code, so it is worth
  // checking against that code rather than trusting it: every `kind` must be a
  // collector the panel dispatches, and every endpoint must be a URL.
  const { PLATFORMS, VENDOR_KINDS } = require('../src/quota-catalog')
  const source = readFileSync(join(ROOT, 'hud', 'panels', 'quota', 'host.js'), 'utf8')
  const collectors = /const COLLECTORS = \{([\s\S]*?)\n\}/.exec(source)[1]
  const implemented = [...collectors.matchAll(/^\s*'?([\w-]+)'?:\s*collect/gm)].map((match) => match[1])
  assert.deepEqual(implemented.sort(), [...VENDOR_KINDS].sort(), 'the catalog\'s kind list is the panel\'s')

  for (const platform of PLATFORMS) {
    assert.ok(implemented.includes(platform.kind), `${platform.kind} has no collector`)
    if (platform.baseUrl !== '') assert.match(platform.baseUrl, /^https:\/\//, `${platform.kind} needs a real endpoint`)
    // The endpoint a platform ships must be the one its collector defaults to,
    // or the row would query a host the vendor never intended.
    if (platform.kind === 'moonshot') assert.ok(source.includes('https://api.moonshot.ai'))
    if (platform.kind === 'zai') assert.ok(source.includes('https://api.z.ai'))
    if (platform.kind === 'mimo') assert.ok(source.includes('https://platform.xiaomimimo.com/api/v1'))
  }
})

test('the SQL connection manager lists, deletes and re-points connections', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  // Seeded through the panel's own storage file, which is what the panel reads.
  const file = join(app.tmp.dir, 'storages', 'dsh-hud', 'sql', 'state.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    settings: {
      pollMs: 60_000,
      active: 'db',
      connections: [
        { id: 'db', driver: 'postgres', name: 'Passport', host: '127.0.0.1', port: 5432, database: 'Passport', user: 'sa', readOnly: true },
        { id: 'wh', driver: 'sqlserver', name: 'Warehouse', host: '10.0.0.9', port: 1433, database: 'dw', user: 'sa', readOnly: true },
      ],
    },
  }), 'utf8')

  app.vscode.window.showQuickPick = async (items, options) => {
    if (options?.title === 'HUD — 数据库连接') return items.find((item) => item.entry?.id === 'db')
    if (options?.title === 'HUD — Passport') return items.find((item) => item.action === 'delete')
    return undefined
  }
  const warned = []
  app.vscode.window.showWarningMessage = async (message, options, ...items) => {
    warned.push({ message, items })
    return app.answers.warning ?? '删除'
  }

  await app.commands.get('hud.sqlConnections')()

  const written = JSON.parse(readFileSync(file, 'utf8')).settings
  assert.deepEqual(written.connections.map((entry) => entry.id), ['wh'], 'only the chosen one is gone')
  assert.equal(written.active, 'wh', 'and active re-points, rather than dangling')
  assert.equal(written.pollMs, 60_000, 'everything else in the settings survives')
  assert.match(warned[0].message, /Passport/)
  assert.match(app.calls.infoMessages.join('\n'), /已删除「Passport」/)
})

test('deleting the last connection leaves an empty, usable list', async (t) => {
  const app = boot({ answers: { warning: '删除' } })
  t.after(() => app.dispose())
  const file = join(app.tmp.dir, 'storages', 'dsh-hud', 'sql', 'state.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    settings: { pollMs: 60_000, active: 'only', connections: [{ id: 'only', driver: 'sqlite', name: 'Local', file: 'E:/x.db', readOnly: true }] },
  }), 'utf8')

  app.vscode.window.showQuickPick = async (items, options) => {
    if (options?.title === 'HUD — 数据库连接') return items.find((item) => item.entry?.id === 'only')
    if (options?.title === 'HUD — Local') return items.find((item) => item.action === 'delete')
    return undefined
  }
  await app.commands.get('hud.sqlConnections')()

  const written = JSON.parse(readFileSync(file, 'utf8')).settings
  assert.deepEqual(written.connections, [])
  // `active: 'only'` would leave the card pointing at a connection that is not
  // there — no editor and no way back.
  assert.equal(written.active, '')
})

test('a new connection is tested before it is saved', async (t) => {
  // Against the vendor's own fake SQL Server, so "the test passed" means a real
  // TDS login completed rather than that nothing was listening.
  const { startFakeSqlServer } = await import('../hud/tools/fake-tds.mjs')
  const server = await startFakeSqlServer()
  t.after(() => server.close())

  const app = boot()
  t.after(() => app.dispose())
  const answers = {
    名称: 'Analytics', 主机: '127.0.0.1', 端口: String(server.port), 数据库: 'app', 用户: 'sa', 密码: 'Str0ng!Pass',
  }
  app.vscode.window.showInputBox = async (options) => {
    app.calls.inputBoxes.push(options)
    const key = String(options.title).split('：').pop()
    return answers[key]
  }
  app.vscode.window.showQuickPick = async (items, options) => {
    const title = String(options?.title ?? '')
    if (title === 'HUD — 数据库连接') return items.find((item) => item.action === 'new')
    if (title === 'HUD — 新建连接：选择驱动') return items.find((item) => item.spec?.id === 'sqlserver')
    if (title.includes('TLS') || title.includes('证书')) return items.find((item) => item.value === false)
    if (title.includes('只读？')) return items.find((item) => item.value === true)
    return undefined
  }

  await app.commands.get('hud.sqlConnections')()

  const file = join(app.tmp.dir, 'storages', 'dsh-hud', 'sql', 'state.json')
  const written = JSON.parse(readFileSync(file, 'utf8')).settings
  assert.equal(written.connections.length, 1)
  const [saved] = written.connections
  assert.equal(saved.name, 'Analytics')
  assert.equal(saved.driver, 'sqlserver')
  assert.equal(saved.host, '127.0.0.1')
  assert.equal(saved.port, server.port, 'a port typed as text is stored as a number')
  assert.equal(saved.readOnly, true, 'read-only is the default, not an afterthought')
  assert.equal(server.state.authenticated, true, 'and the fake server really did log someone in')
  // The password is NOT in the connection: the panel stores a credential NAME,
  // and the secret goes to the credential document.
  assert.equal(JSON.stringify(saved).includes('Str0ng'), false, 'no secret in the connection list')
  assert.equal(readFileSync(app.settings.credentialsFile, 'utf8').includes('Str0ng!Pass'), true, 'it went to the store instead')
  assert.match(app.calls.infoMessages.join('\n'), /连接成功/)
  assert.match(app.calls.infoMessages.join('\n'), /已连接并保存/)
})

test('a connection that will not connect is not saved silently', async (t) => {
  const app = boot({ answers: { warning: '取消' } })
  t.after(() => app.dispose())
  // A closed port, so the panel's own test route really fails.
  app.vscode.window.showInputBox = async (options) => {
    const key = String(options.title).split('：').pop()
    return { 名称: 'Broken', 主机: '127.0.0.1', 端口: '1', 数据库: 'x', 用户: 'sa', 密码: 'p' }[key]
  }
  app.vscode.window.showQuickPick = async (items, options) => {
    const title = String(options?.title ?? '')
    if (title === 'HUD — 数据库连接') return items.find((item) => item.action === 'new')
    if (title === 'HUD — 新建连接：选择驱动') return items.find((item) => item.spec?.id === 'sqlserver')
    if (title.includes('TLS') || title.includes('证书')) return items.find((item) => item.value === false)
    if (title.includes('只读？')) return items.find((item) => item.value === true)
    return undefined
  }
  const asked = []
  app.vscode.window.showWarningMessage = async (message, options, ...items) => {
    asked.push({ message, items })
    return '取消'
  }

  await app.commands.get('hud.sqlConnections')()

  assert.equal(asked.length, 1, 'a failed test must be reported, not swallowed')
  assert.match(asked[0].message, /连接测试失败/)
  assert.deepEqual(asked[0].items, ['仍然保存', '取消'])
  const file = join(app.tmp.dir, 'storages', 'dsh-hud', 'sql', 'state.json')
  const written = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).settings : { connections: [] }
  assert.deepEqual(written.connections ?? [], [], 'and cancelling must write nothing')
})

test('the SSH card\'s host list is read, normalized and written by the host half', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()
  // `request` resolves with the RPC envelope — `{ ok, data }` — so a refusal is a
  // value to assert on, not an exception to catch.
  const call = async (method, params) => {
    const reply = await view.request(method, params)
    return reply.ok === false ? { error: reply.error } : reply.data
  }

  const empty = await call('ssh.state')
  assert.deepEqual(empty.hosts, [], 'no hosts yet, and that is not an error')
  assert.equal(empty.strictHostKey, false, 'host keys are not pinned by default')
  assert.match(empty.file, /storages[\\/]dsh-hud[\\/]ssh[\\/]state\.json$/, 'in the scratch DSH home, not the real one')

  const saved = await call('ssh.hosts.save', {
    hosts: [{ id: 'ssh-1', name: 'web', host: '10.0.0.1', port: '2222', user: 'root' }],
    active: 'ssh-1',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.hosts[0].port, 2222, 'a port typed as text is stored as a number')
  assert.equal(saved.hosts[0].name, 'web')

  const back = await call('ssh.state')
  assert.equal(back.hosts.length, 1)
  assert.equal(back.active, 'ssh-1')
  assert.equal(back.hosts[0].user, 'root')

  // A host that could never connect is refused with a sentence, rather than stored
  // and discovered at connect time.
  assert.match((await call('ssh.hosts.save', { hosts: [{ id: 'x', host: '', user: 'root' }] })).error, /主机名不能为空/)
  assert.match((await call('ssh.hosts.save', { hosts: [{ id: 'x', host: 'h', user: 'u', port: 0 }] })).error, /1\.\.65535/)
  // And a refused save leaves the list exactly as it was.
  assert.equal((await call('ssh.state')).hosts.length, 1)
})

test('connecting to a host that is not in the list is refused, not attempted', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()
  const reply = await view.request('ssh.open', { id: 'nope' })
  assert.equal(reply.ok, false)
  assert.match(reply.error, /没有这个主机/)
})

test('a host with no stored password says so before opening a socket', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  const view = app.openView()
  await view.request('ssh.hosts.save', {
    hosts: [{ id: 'ssh-1', name: 'web', host: '127.0.0.1', port: 1, user: 'root' }],
    active: 'ssh-1',
  })
  // Port 1 is closed, so a connection would fail — but it must not even get that
  // far: the missing credential is the answer, and it names the ref to store.
  const reply = await view.request('ssh.open', { id: 'ssh-1' })
  assert.equal(reply.ok, false)
  assert.match(reply.error, /没有可用密码/)
  assert.match(reply.error, /hud_ssh_ssh_1/, 'and it names the credential to store')
})

test('the right slot can be switched, and the switch re-creates the card', async (t) => {
  const app = boot({ answers: { quickPick: (items) => items.find((item) => item.value === 'ssh') } })
  t.after(() => app.dispose())
  app.openView()

  assert.match(app.openView().webview.html, /"rightCard":"database"/, 'the default document is the database card')
  await app.commands.get('hud.rightCard')()

  assert.equal(app.settings.rightCard, 'ssh', 'the setting is what enforces the exclusivity')
  // Re-registered, not merely reloaded: which panel exists is decided while the
  // document is built, so a reload of the old document would show the old card.
  assert.match(app.openView().webview.html, /"rightCard":"ssh"/, 'and the document is rebuilt')
  assert.match(app.calls.infoMessages.join('\n'), /右侧卡片已切换/)
})

test('the status bar stays hidden unless it is switched on', async (t) => {
  const app = boot()
  t.after(() => app.dispose())
  app.openView()
  assert.equal(app.statusItem.visible, false)
})

test('deactivate never throws', (t) => {
  const app = boot()
  t.after(() => app.dispose())
  assert.equal(app.extension.deactivate(), undefined)
})