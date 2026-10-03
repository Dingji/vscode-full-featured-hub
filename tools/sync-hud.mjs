#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — sync `hud/` from the upstream plugin checkout.
 *
 * The port never edits the HUD tree; it only supplies the services the plugin
 * asks for. That only stays true if refreshing the tree is a copy rather than a
 * merge, so this is the one supported way to update it — run it whenever the
 * upstream moves, then re-run the suites.
 *
 *   node tools/sync-hud.mjs [--upstream <dir>] [--check]
 *
 * `--check` reports what would change without writing anything.
 *
 * What is copied: everything the plugin is made of — `index.js`, `client.js`,
 * `lib/`, `panels/`, `client/` (the bundle's fragments), the manifest and the
 * docs. What is NOT: `tools/node_modules` and `tools/vendor` (installed here
 * instead), `tools/package-lock.json`, packed `.tgz` archives, and the
 * upstream's own `_*.mjs` / `_*.py` scratch probes.
 *
 * Files are removed as well as updated, so a fragment the upstream DELETED does
 * not linger and silently stay in the bundle.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = join(root, 'hud')

const argIndex = process.argv.indexOf('--upstream')
const UPSTREAM = resolve(
  (argIndex > 0 ? process.argv[argIndex + 1] : undefined)
  ?? process.env.DSH_HUD_UPSTREAM
  ?? join(root, '..', 'dsh-hud'),
)
const CHECK_ONLY = process.argv.includes('--check')

if (!existsSync(UPSTREAM)) {
  console.error(`upstream checkout not found: ${UPSTREAM}`)
  console.error('Pass --upstream <dir> or set DSH_HUD_UPSTREAM.')
  process.exit(2)
}

/** Top-level entries to copy, verbatim. `tools/` is the vendor's own test
 * suite — it runs against this copy, so it comes over too (its scratch probes,
 * its `node_modules` and its extracted vendor tree are filtered out below). */
const ENTRIES = [
  'index.js', 'client.js', 'client', 'lib', 'panels', 'tools',
  'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'PUBLISHING.md', '.gitignore',
]

/** Never copied: installed here, packed here, or the upstream's own scratch. */
const SKIP_FILE = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])vendor([\\/]|$)/,
  /package-lock\.json$/,
  /\.tgz$/,
  /[\\/]_[^\\/]*\.(mjs|py)$/,
]

const skip = (rel) => SKIP_FILE.some((pattern) => pattern.test(rel))

/** @returns {Map<string, string>} relative path → absolute path, for a tree */
function collect(base, prefix = '') {
  const out = new Map()
  const visit = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (skip(childRel)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full, childRel)
        continue
      }
      if (statSync(full).isFile()) out.set(prefix ? `${prefix}/${childRel}` : childRel, full)
    }
  }
  visit(base, '')
  return out
}

const wanted = new Map()
for (const entry of ENTRIES) {
  const full = join(UPSTREAM, entry)
  if (!existsSync(full)) {
    console.error(`upstream is missing ${entry}`)
    process.exit(2)
  }
  if (statSync(full).isDirectory()) {
    for (const [rel, path] of collect(full, entry)) wanted.set(rel, path)
  } else {
    wanted.set(entry, full)
  }
}

// A file the upstream dropped must not survive here: the bundle is built by
// concatenating every fragment, so a stale one would still be compiled in.
const existing = existsSync(LOCAL) ? collect(LOCAL) : new Map()
const stale = [...existing.keys()].filter((rel) => !wanted.has(rel))

const added = []
const updated = []
const unchanged = []
for (const [rel, source] of wanted) {
  const target = join(LOCAL, rel)
  if (!existsSync(target)) {
    added.push(rel)
    continue
  }
  const same = Buffer.compare(readFileSync(source), readFileSync(target)) === 0
  if (same) unchanged.push(rel)
  else updated.push(rel)
}

console.log(`upstream : ${UPSTREAM}`)
console.log(`local    : ${LOCAL}`)
console.log(`files    : ${wanted.size} wanted — ${added.length} new, ${updated.length} changed, ${unchanged.length} unchanged, ${stale.length} stale`)

for (const rel of added.slice(0, 10)) console.log(`  + ${rel}`)
for (const rel of updated.slice(0, 10)) console.log(`  ~ ${rel}`)
for (const rel of stale.slice(0, 10)) console.log(`  - ${rel}`)
const more = added.length + updated.length + stale.length - 30
if (more > 0) console.log(`  … and ${more} more`)

if (CHECK_ONLY) {
  console.log(added.length + updated.length + stale.length === 0 ? '\nhud/ is in sync.' : '\nhud/ is OUT OF SYNC — run without --check.')
  process.exit(added.length + updated.length + stale.length === 0 ? 0 : 1)
}

for (const [rel, source] of wanted) {
  const target = join(LOCAL, rel)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}
for (const rel of stale) rmSync(join(LOCAL, rel), { force: true })

console.log('\nhud/ synced. Re-run: npm run hud:test && npm run check:verbatim && npm test')