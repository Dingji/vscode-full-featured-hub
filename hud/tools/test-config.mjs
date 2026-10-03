#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — settings-schema test.
 *
 * Merging two plugins into one config tree is the single riskiest part of this
 * package, because the loader enforces a rule that is easy to violate and
 * fatal when you do:
 *
 *     "<path>: volatile fields require a fixed object path
 *      without an enclosing volatile field"
 *
 * It is raised by the loader's schema builder while it walks the plugin's
 * `Config`, so a violation costs the plugin its settings page at best. The
 * rule was read straight out of the shipped bundle, and this test re-implements
 * that exact walk (same fields, same `blocked` propagation) over the REAL
 * schema objects built by the REAL schemastery.
 *
 * Run `node tools/extract-vendor.mjs` once first — it unpacks schemastery from
 * the installed app bundle. Without it this test SKIPS rather than lying.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
let checks = 0

function ok(label, condition, detail) {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures++
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return ok(label, a === e, `expected ${e}, got ${a}`)
}

// ── the real schemastery ───────────────────────────────────────────────────
const VENDOR = join(here, 'vendor', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
if (!existsSync(VENDOR)) {
  console.log('SKIP: real schemastery not unpacked yet.')
  console.log('      run: node tools/extract-vendor.mjs')
  process.exit(0)
}
const z = (await import(new URL('./vendor/node_modules/@deepseek-ai/schemastery/lib/index.mjs', import.meta.url).href)).default
ok('unpacked schemastery default-exports a factory', typeof z === 'function')

// ── the loader's own rule, re-implemented ──────────────────────────────────
/**
 * Mirrors `validateVolatilePlacement` from the shipped bundle:
 * a volatile field is illegal when an enclosing field is already volatile
 * (or when it sits inside an array / lazy inner). Returns the violation or
 * `undefined` when the tree is legal.
 *
 * NOTE the guard accepts callables: a schemastery schema IS a function object
 * (`typeof z.string() === 'function'`), so an `typeof !== 'object'` bail-out
 * here silently walks nothing and turns every assertion below into a false
 * green. The negative control at the bottom of this file is what caught that.
 */
function findVolatileViolation(node, path, blocked = false, seen = new Map()) {
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return undefined
  const states = seen.get(node) ?? new Set()
  if (states.has(blocked)) return undefined
  states.add(blocked)
  seen.set(node, states)
  if (node.meta?.volatile && blocked) {
    return `${path}: volatile fields require a fixed object path without an enclosing volatile field`
  }
  const nested = blocked || Boolean(node.meta?.volatile)
  for (const [key, child] of Object.entries(node.dict ?? {})) {
    const hit = findVolatileViolation(child, `${path}/${key}`, nested, seen)
    if (hit) return hit
  }
  if (node.sKey) {
    const hit = findVolatileViolation(node.sKey, `${path}/keys`, true, seen)
    if (hit) return hit
  }
  if (node.inner) {
    const hit = findVolatileViolation(node.inner, `${path}/inner`, true, seen)
    if (hit) return hit
  }
  for (const [index, child] of (node.list ?? []).entries()) {
    const hit = findVolatileViolation(child, `${path}/${index}`, true, seen)
    if (hit) return hit
  }
  return undefined
}

// ── the plugin's composed schema ───────────────────────────────────────────
console.log('\ncomposed config')
const mod = await import('../index.js')
ok('__test.buildConfig is exported', typeof mod.__test?.buildConfig === 'function')

const schema = mod.__test.buildConfig(z)
ok('buildConfig returns a schema with the real schemastery', schema !== undefined && schema !== null)

const panels = schema?.dict?.panels
ok('the config root carries `panels`', panels !== undefined)
ok('`panels` itself is NOT volatile', !panels?.meta?.volatile,
  'an enclosing volatile would reject every live leaf one level down')

// THE guard that matters: `buildConfig` catches a throwing panel schema on
// purpose (one bad panel must not cost the others their page), so without this
// the failure is invisible. A missing import in the machine panel removed its
// whole settings page and nothing said a word until this assertion existed.
const schemaFailures = mod.__test?.schemaFailures ?? []
eq('no panel schema threw while building the settings tree',
  schemaFailures.map((failure) => `${failure.id}: ${failure.error.message}`), [])
const declared = mod.__test.PANELS.filter((panel) => typeof panel.schema === 'function').map((panel) => panel.id).sort()
eq('every panel that declares a schema has one in the tree',
  declared.filter((id) => panels?.dict?.[id] === undefined), [])

const quota = panels?.dict?.quota
ok('panels.quota came from the quota panel', quota !== undefined)
eq('panels.quota exposes every field the panel declared', Object.keys(quota?.dict ?? {}).sort(), [
  'apiKeyEnv', 'baseUrl', 'cacheMs', 'pollMs', 'providerPrefix', 'subscriptions', 'timeoutMs',
])
ok('panels.quota.subscriptions is volatile (live edits)', quota?.dict?.subscriptions?.meta?.volatile === true)
ok('panels.quota.cacheMs is volatile (live edits)', quota?.dict?.cacheMs?.meta?.volatile === true)
ok('the github panel contributed no schema (its settings live in its state file)',
  panels?.dict?.github === undefined)

const weather = panels?.dict?.weather
ok('panels.weather came from the weather panel', weather !== undefined)
eq('panels.weather exposes every field the panel declared', Object.keys(weather?.dict ?? {}).sort(), [
  'alarmUrl', 'alerts', 'city', 'forecastUrl', 'geocodeUrl', 'ipGeoUrl', 'ipWhoUrl',
  'latitude', 'longitude', 'refreshMs', 'timeoutMs',
])
ok('panels.weather.city is volatile (live edits)', weather?.dict?.city?.meta?.volatile === true)

const todo = panels?.dict?.todo
ok('panels.todo came from the to-do panel', todo !== undefined)
eq('panels.todo exposes every field the panel declared', Object.keys(todo?.dict ?? {}).sort(), [
  'digestAt', 'feedCacheMs', 'pollMs', 'timeoutMs',
])
// The digest time and the notification leads are the two settings a user edits
// while looking at the clock, so they have to be live.
ok('panels.todo.digestAt is volatile (live edits)', todo?.dict?.digestAt?.meta?.volatile === true)
ok('panels.todo.pollMs is volatile (live edits)', todo?.dict?.pollMs?.meta?.volatile === true)

const parcel = panels?.dict?.parcel
ok('panels.parcel came from the parcel panel', parcel !== undefined)
eq('panels.parcel exposes every field the panel declared', Object.keys(parcel?.dict ?? {}).sort(), [
  'extraCarriers', 'pollMs', 'queryUrl', 'refreshMs', 'timeoutMs',
])
ok('panels.parcel.pollMs is volatile (live edits)', parcel?.dict?.pollMs?.meta?.volatile === true)

const market = panels?.dict?.market
ok('panels.market came from the market panel', market !== undefined)
eq('panels.market exposes every field the panel declared', Object.keys(market?.dict ?? {}).sort(), [
  'holidays', 'klineMs', 'klineUrl', 'quoteMs', 'quoteUrl', 'rankUrl', 'searchUrl', 'slowWhenClosed',
  'timeoutMs', 'watch',
])
ok('panels.market.watch is volatile', market?.dict?.watch?.meta?.volatile === true)
// The trading calendar is a SETTING for every market outside A股: those holidays are not
// something this plugin can verify, and a wrong table silently swallows a real trading day —
// which is worse than having no table at all.
ok('the extra-holiday list is editable from the settings page',
  market?.dict?.holidays !== undefined)

// The machine panel is gone, and its config namespace went with it — the same rule the next
// two assertions apply to services and git: a schema entry for a panel that no longer exists is
// a settings page offering to configure nothing.
eq('panels.machine is gone with the panel', panels?.dict?.machine, undefined)

// The services panel is gone, and its config namespace went with it: a schema entry for
// a panel that no longer exists is a settings page offering to configure nothing.
eq('panels.services is gone with the panel', panels?.dict?.services, undefined)
eq('and so is panels.git', panels?.dict?.git, undefined)

const bond = panels?.dict?.bond
ok('panels.bond came from the bond panel', bond !== undefined)
eq('panels.bond exposes every field the panel declared', Object.keys(bond?.dict ?? {}).sort(), [
  'cnUrl', 'klineMs', 'klineUrl', 'pollMs', 'quoteUrl', 'timeoutMs', 'windowDays',
])
ok('panels.bond.pollMs is volatile', bond?.dict?.pollMs?.meta?.volatile === true)

// ── the rule ───────────────────────────────────────────────────────────────
console.log('\nloader volatile-placement rule')
const violation = findVolatileViolation(schema, 'config')
ok('the composed schema is legal', violation === undefined, violation)

// Negative control: without one, the check above could pass by walking nothing.
const { live } = await import('../lib/host-kit.js')
ok('`live()` really marks a field volatile on this schemastery',
  /** @type {any} */ (live(z.object({}))).meta?.volatile === true)

const illegal = z.object({
  outer: live(z.object({ inner: live(z.string()) })),
})
const negativeViolation = findVolatileViolation(illegal, 'config')
ok('the walker detects a volatile-inside-volatile violation',
  typeof negativeViolation === 'string' && negativeViolation.startsWith('config/outer/inner'),
  String(negativeViolation))

// Regression: the shape this package shipped BEFORE the fix — `panels` itself
// marked volatile — is rejected by the very same rule. That is why the shell
// leaves `panels` alone and lets each panel declare its own live leaves.
const quotaPanel = mod.__test.PANELS.find((panel) => panel.id === 'quota')
const shippedBadShape = z.object({ panels: live(z.object({ quota: quotaPanel.schema(z) })) })
const badViolation = findVolatileViolation(shippedBadShape, 'config')
ok('marking `panels` volatile is rejected — the bug this design removes',
  typeof badViolation === 'string' && badViolation.startsWith('config/panels/quota/'),
  String(badViolation))

// ── does the runtime resolver's asar path actually exist? ──────────────────
console.log('\nruntime resolution')
const asar = process.env.DSH_ASAR
  || join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
if (!existsSync(asar)) {
  console.log(`  skip asar probe (not found: ${asar})`)
} else {
  // The same relative path `resolveSchemastery()` builds in lib/host-kit.js.
  const wanted = ['dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs']
  const buf = readFileSync(asar)
  const headerSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
  let node = header
  for (const segment of wanted) node = node?.files?.[segment]
  ok(`the app bundle contains ${wanted.join('/')}`, node !== undefined,
    'resolveSchemastery() walks up from process.execPath to exactly this path')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('config schema: all green')