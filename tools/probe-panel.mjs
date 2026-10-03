#!/usr/bin/env node
// @ts-check
/**
 * Ask the mounted HUD for the payloads the CARD asks for.
 *
 * Panels decide what to render from their own routes, so "the button is missing"
 * is almost always a fact in a JSON body rather than a missing feature. This
 * mounts the real host half and dispatches real routes, printing what came back.
 *
 *   node tools/probe-panel.mjs /dsh-hud/sql/state
 *   node tools/probe-panel.mjs /dsh-hud/sql/settings --post '{"settings":{"connections":[]}}'
 *   node tools/probe-panel.mjs /dsh-hud/sql/state --home <dir>      # a scratch DSH home
 *
 * Writes go to `$DSH_HOME/storages/…`, and the panels write the REAL home by
 * default. A `--post` without `--home` is therefore refused: nobody should
 * discover their connection list was edited by a probe.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const path = args.find((value) => value.startsWith('/')) ?? '/dsh-hud/sql/state'
const postIndex = args.indexOf('--post')
const postFileIndex = args.indexOf('--post-file')
// A file beats a command line: shell quoting mangles JSON, and a body that
// arrives truncated reads as a server-side 400 that is really a shell bug.
const body = postFileIndex >= 0
  ? readFileSync(args[postFileIndex + 1], 'utf8')
  : (postIndex >= 0 ? args[postIndex + 1] : undefined)
const homeIndex = args.indexOf('--home')
const home = homeIndex >= 0 ? args[homeIndex + 1] : undefined
const only = args.includes('--drivers')

if (body !== undefined && home === undefined) {
  console.error('refusing to POST against the real DSH home — pass --home <dir>')
  process.exit(2)
}
// `$DSH_HOME` is what the host half actually reads for its storage files — it
// resolves that path ITSELF and never asks the context. Redirecting only
// `CredentialStore` therefore leaves writes pointed at the real
// `storages/dsh-hud/<panel>/state.json`, which is how a probe once replaced a
// real connection list. The environment variable is the only lever that moves
// both, so it is set BEFORE the panels mount.
if (home !== undefined) process.env.DSH_HOME = home

const { CredentialStore } = require(join(root, 'src', 'credentials.js'))
const { createHudContext } = require(join(root, 'src', 'ctx.js'))
const { createDshProfile } = require(join(root, 'src', 'dsh-profile.js'))

const store = new CredentialStore(home === undefined ? {} : { dshHome: home })
const profile = createDshProfile({ dshHome: store.dshHome, name: '' })
const ctx = createHudContext({ credentials: store, log: () => {}, loader: { entries: () => [] } })

const hud = await import(pathToFileURL(join(root, 'hud', 'index.js')).href)
const handles = hud.apply(ctx, { panels: {} })
await new Promise((resolve) => setTimeout(resolve, 50))

const answer = await ctx.table.dispatch({
  path,
  method: body === undefined ? 'GET' : 'POST',
  ...(body === undefined ? {} : { body }),
})

console.log(`${body === undefined ? 'GET ' : 'POST'} ${path} → ${answer.status}`)
let parsed
try {
  parsed = JSON.parse(answer.body)
} catch {
  console.log(answer.body.slice(0, 400))
  handles?.dispose?.()
  process.exit(0)
}

if (only) {
  console.log(JSON.stringify(parsed.drivers ?? parsed, null, 2))
} else {
  console.log(JSON.stringify(parsed, null, 2).slice(0, 3000))
}
handles?.dispose?.()
process.exit(0)