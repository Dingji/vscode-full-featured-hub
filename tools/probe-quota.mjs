#!/usr/bin/env node
// @ts-check
/**
 * What the quota card actually sees in THIS environment.
 *
 * `Account balance` is a carousel: one subscription on screen at a time, a row
 * of dots to pick another — but only when there is more than one. So "I cannot
 * choose a platform" is usually "only one platform was discovered", and that is
 * a fact about the discovery inputs, not about the card.
 *
 * This mounts the real host half against the real `$DSH_HOME` and prints what
 * `/dsh-hud/quota/usage` returns. Reference NAMES and presence only — never a
 * secret value.
 *
 *   node tools/probe-quota.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { CredentialStore } = require(join(root, 'src', 'credentials.js'))
const { createHudContext } = require(join(root, 'src', 'ctx.js'))
const { createDshProfile } = require(join(root, 'src', 'dsh-profile.js'))
const { hiddenRefs, selectedKinds, byKind, subscriptionFor } = require(join(root, 'src', 'quota-catalog.js'))

// `--auto` = DSH's own discovery; the default is what the extension ships
// (`hud.quotaDiscovery: chosen`), gate included.
const AUTO = process.argv.includes('--auto')
// Pass a subscriptions list the way the settings would: --chosen=deepseek,zai
const CHOSEN = (process.argv.find((arg) => arg.startsWith('--chosen=')) ?? '--chosen=').slice('--chosen='.length)
const selected = CHOSEN === '' ? [] : selectedKinds(CHOSEN.split(',').map((kind) => ({ kind })))
const subscriptions = selected.map((kind) => subscriptionFor(byKind.get(kind)))

const store = new CredentialStore({})
const profile = createDshProfile({ dshHome: store.dshHome, name: '', log: (line) => console.log(`[hud] ${line}`) })
const capped = (line) => { if (!/^panel /.test(line)) console.log(`[hud] ${line}`) }
const ctx = createHudContext({
  credentials: store,
  log: capped,
  loader: { entries: () => (AUTO ? profile.entries() : []) },
  // The same exception the extension makes: the panel's own fallback row reads
  // this ref, and hiding it would only make that row claim a missing key.
  hidden: () => (AUTO ? new Set() : hiddenRefs(selected, byKind.get('opencode-go').apiKeyEnv)),
})

const hud = await import(pathToFileURL(join(root, 'hud', 'index.js')).href)
await hud.apply(ctx, { panels: { quota: { subscriptions } } })

const answer = await ctx.table.dispatch({ path: '/dsh-hud/quota/usage', method: 'GET' })
const body = JSON.parse(answer.body)

console.log(`credentials file : ${store.file}`)
console.log(`discovery mode   : ${AUTO ? 'auto (DSH behaviour)' : `chosen [${selected.join(', ') || 'nothing chosen'}]`}`)
const dsh = profile.describe()
console.log(`dsh profile      : ${dsh.profile ?? '(none)'}   entries=${dsh.entries}${dsh.error === null ? '' : `  ⚠ ${dsh.error}`}`)
// The table the panel actually reads, without printing any secret.
for (const entry of profile.entries()) {
  const providers = entry.fiber?.config?.providers
  if (providers === undefined) continue
  console.log(`  ${entry.options.id || entry.options.name} → providers: ${Object.keys(providers).join(', ') || '(none)'}`)
}
console.log(`status           : ${answer.status}`)
console.log(`pollMs           : ${body.pollMs}`)
console.log(`subscriptions    : ${(body.subscriptions ?? []).length}`)
for (const sub of body.subscriptions ?? []) {
  console.log(`  · id=${sub.id}  kind=${sub.kind ?? '?'}  label=${sub.label ?? '?'}`)
  console.log(`    baseUrl=${sub.baseUrl ?? '(none)'}`)
  console.log(`    credentials=${JSON.stringify(sub.credentials ?? [])}   ← ref names and whether present`)
  if (sub.usage) console.log(`    usage=${JSON.stringify(sub.usage).slice(0, 160)}`)
  if (sub.error) console.log(`    error=${sub.error}`)
}