// The DSH profile reader, and the thing it exists for: the quota card
// discovering more than one platform.
//
// `Account balance` is a carousel whose picker — a row of dots — is rendered
// only when MORE THAN ONE row was discovered. One of the three discovery
// sources is the live `llm-pi-ai` plugin's `providers` table, read through
// `ctx.loader.entries()`. A VS Code extension has no DSH runtime, so the table
// is read from the profile's patch layer; without it a user with keys for three
// platforms sees one and the picker never appears.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync, utimesSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { createDshProfile, entriesFromDocument, toEntry } = require('../src/dsh-profile')
const { createHudContext } = require('../src/ctx')
const { CredentialStore } = require('../src/credentials')
const { tempDir, settle } = require('./harness')

/** A patch file with one `llm-pi-ai` entry naming `providers`. */
function writePatch(file, providers) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, [
    '- id: locale',
    '  name: "@deepseek-ai/dsh-client-locale"',
    '  config:',
    '    preference: zh',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    ...Object.keys(providers).flatMap((id) => [
      `      ${id}:`,
      `        apiKeyEnv: ${providers[id]}`,
    ]),
    '',
  ].join('\n'), 'utf8')
}

// ── the document → entries mapping ─────────────────────────────────────────
test('a patch document becomes the entries a loader would have produced', () => {
  const entries = entriesFromDocument([
    { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } },
    { id: 'disabled-one', config: { a: 1 }, disabled: true },
    { id: 'no-config' },
    null,
    'nonsense',
    { id: '' },
  ])
  assert.equal(entries.length, 3, 'only entries a loader could address survive')
  assert.deepEqual(entries[0], {
    options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale' },
    disabled: false,
    fiber: { config: { preference: 'zh' } },
  })
  assert.equal(entries[1].disabled, true, 'a disabled entry is marked, not dropped — the panel skips it itself')
  assert.deepEqual(entries[2].fiber.config, {}, 'a missing config is an empty one, not a crash')
})

test('an insert list is entries too', () => {
  const entries = entriesFromDocument([
    { id: 'host', insert: [{ id: 'added', name: '@x/y', config: { on: true } }] },
  ])
  // A profile that ADDS a plugin rather than overriding one would otherwise be
  // invisible, which is the same defect in a different disguise.
  assert.deepEqual(entries.map((entry) => entry.options.id), ['host', 'added'])
})

test('a document that is not a list yields nothing', () => {
  for (const value of [null, undefined, {}, 'nope', 42]) {
    assert.deepEqual(entriesFromDocument(value), [])
  }
  assert.equal(toEntry(undefined), null)
  assert.equal(toEntry({ name: '@x/y' }).options.id, '', 'a name-only entry is addressable by name')
})

// ── choosing and reading a profile ─────────────────────────────────────────
test('the most recently edited profile wins, and hud.dshProfile overrides it', () => {
  const tmp = tempDir()
  try {
    const root = join(tmp.dir, 'profiles')
    writePatch(join(root, 'desktop', 'cordis.patch.yml'), { 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY' })
    writePatch(join(root, 'web', 'cordis.patch.yml'), { 'opencode-go': 'OPENCODE_GO_API_KEY' })
    // `web` is newer.
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'web', 'cordis.patch.yml'), later, later)

    const auto = createDshProfile({ dshHome: tmp.dir })
    assert.equal(auto.describe().profile, 'web', 'auto-detection takes the newest')
    assert.equal(auto.entries()[1].fiber.config.providers['opencode-go'].apiKeyEnv, 'OPENCODE_GO_API_KEY')

    const named = createDshProfile({ dshHome: tmp.dir, name: 'desktop' })
    assert.equal(named.describe().profile, 'desktop')
    assert.equal(named.entries()[1].fiber.config.providers['qwen-token-plan-cn'].apiKeyEnv, 'QWEN_TOKEN_PLAN_CN_API_KEY')

    const missing = createDshProfile({ dshHome: tmp.dir, name: 'nope' })
    assert.equal(missing.describe().profile, null)
    assert.deepEqual(missing.entries(), [], 'a profile that is not there contributes nothing')
  } finally {
    tmp.dispose()
  }
})

test('a home with no profiles is not an error', () => {
  const tmp = tempDir()
  try {
    const profile = createDshProfile({ dshHome: tmp.dir })
    assert.deepEqual(profile.entries(), [])
    assert.deepEqual(profile.describe(), { profile: null, source: null, entries: 0, error: null })
    assert.equal(profile.locale(), null, 'and it has no opinion about language')
  } finally {
    tmp.dispose()
  }
})

test('the locale preference is read from the profile, the way DSH reads it', () => {
  const tmp = tempDir()
  try {
    const file = join(tmp.dir, 'profiles', 'desktop', 'cordis.patch.yml')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, [
      '- id: locale',
      '  name: "@deepseek-ai/dsh-client-locale"',
      '  config:',
      '    preference: zh',
      '- id: llm-pi-ai',
      '  config:',
      '    providers: {}',
      '',
    ].join('\n'), 'utf8')
    assert.equal(createDshProfile({ dshHome: tmp.dir }).locale(), 'zh')

    // A disabled entry is not in force, and an entry matched by package name
    // must work as well as one matched by id.
    writeFileSync(file, [
      '- id: locale',
      '  name: "@deepseek-ai/dsh-client-locale"',
      '  disabled: true',
      '  config:',
      '    preference: zh',
      '- id: renamed',
      '  name: "@deepseek-ai/dsh-client-locale"',
      '  config:',
      '    preference: en',
      '',
    ].join('\n'), 'utf8')
    assert.equal(createDshProfile({ dshHome: tmp.dir }).locale(), 'en')

    // `preference: auto` is not a language — the caller falls back instead.
    writeFileSync(file, '- id: locale\n  config:\n    preference: auto\n', 'utf8')
    assert.equal(createDshProfile({ dshHome: tmp.dir }).locale(), 'auto')
  } finally {
    tmp.dispose()
  }
})

test('an unreadable patch is reported, not silently read as empty', () => {
  const tmp = tempDir()
  try {
    const file = join(tmp.dir, 'profiles', 'desktop', 'cordis.patch.yml')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '- id: llm-pi-ai\n  config:\n    providers: [unclosed\n', 'utf8')

    const logged = []
    const profile = createDshProfile({ dshHome: tmp.dir, log: (line) => logged.push(line) })
    assert.deepEqual(profile.entries(), [])
    assert.notEqual(profile.describe().error, null, 'the reason is kept for diagnostics')
    assert.equal(logged.some((line) => line.includes('could not be read')), true)
  } finally {
    tmp.dispose()
  }
})

test('a profile using !!js expressions still yields its other entries', () => {
  const tmp = tempDir()
  try {
    // Real profiles allow `!!js`, and the yaml reader tolerates it — worth
    // pinning, because a profile that used one would otherwise lose every
    // platform in the same file.
    const file = join(tmp.dir, 'profiles', 'desktop', 'cordis.patch.yml')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, [
      '- id: ui-chat',
      '  config:',
      '    transcriptView: !!js process.env.HUD_VIEW || "detailed"',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      qwen-token-plan-cn:',
      '        apiKeyEnv: QWEN_TOKEN_PLAN_CN_API_KEY',
      '',
    ].join('\n'), 'utf8')

    const profile = createDshProfile({ dshHome: tmp.dir })
    assert.equal(profile.describe().error, null)
    const piAi = profile.entries().find((entry) => entry.options.id === 'llm-pi-ai')
    assert.ok(piAi, 'the provider table must survive a sibling !!js value')
    assert.deepEqual(Object.keys(piAi.fiber.config.providers), ['qwen-token-plan-cn'])
  } finally {
    tmp.dispose()
  }
})

// ── the adapter still behaves when there is no loader at all ───────────────
test('the context passes a loader through, and never throws without one', () => {
  const bare = createHudContext({ credentials: new CredentialStore({}) })
  assert.deepEqual(bare.loader.entries(), [], 'no loader is an empty table')

  const exploding = createHudContext({
    credentials: new CredentialStore({}),
    log: () => {},
    loader: { entries: () => { throw new Error('profile exploded') } },
  })
  assert.deepEqual(exploding.loader.entries(), [], 'a failing loader must not break a poll')
})

// ── the point of all of it ─────────────────────────────────────────────────
test('the quota card discovers every platform the profile configures', async (t) => {
  const tmp = tempDir()
  t.after(() => tmp.dispose())

  // Two platforms, as a real profile would name them.
  writePatch(join(tmp.dir, 'profiles', 'desktop', 'cordis.patch.yml'), {
    'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
    'opencode-go': 'OPENCODE_GO_API_KEY',
  })

  const store = new CredentialStore({ dshHome: tmp.dir, cacheMs: 0 })
  const profile = createDshProfile({ dshHome: tmp.dir })
  const ctx = createHudContext({ credentials: store, log: () => {}, loader: profile })

  const hud = await import(pathToFileURL(join(__dirname, '..', 'hud', 'index.js')).href)
  const handles = hud.apply(ctx, { panels: {} })
  t.after(() => handles?.dispose?.())
  await settle(2)

  const answer = await ctx.table.dispatch({ path: '/dsh-hud/quota/usage', method: 'GET' })
  const body = JSON.parse(answer.body)
  const ids = body.subscriptions.map((sub) => sub.id)

  // Both profile providers, plus whatever built-in discovery adds. The card
  // renders its platform picker on `length > 1`, so this is the assertion that
  // the picker exists at all.
  assert.ok(ids.includes('qwen-token-plan-cn'), `qwen missing from ${ids.join(', ')}`)
  assert.ok(ids.includes('opencode-go'), `opencode-go missing from ${ids.join(', ')}`)
  assert.ok(body.subscriptions.length > 1, 'more than one row is what makes the picker render')

  const kinds = Object.fromEntries(body.subscriptions.map((sub) => [sub.id, sub.kind]))
  assert.equal(kinds['qwen-token-plan-cn'], 'qwen', 'the id is enough for the panel to infer the vendor')
  assert.equal(kinds['opencode-go'], 'opencode-go')
})