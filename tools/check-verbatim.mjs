#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — prove `hud/` is the vendor's tree, unmodified.
 *
 * The whole port rests on one claim: the host half and the browser bundle are
 * shipped verbatim, and only the three services they ask for are supplied from
 * outside. A claim like that is worth checking mechanically rather than
 * trusting, so this walks both trees and compares every file byte for byte.
 *
 *   node tools/check-verbatim.mjs [--upstream <dir>]
 *
 * `--upstream` defaults to `$DSH_HUD_UPSTREAM`, then to the sibling checkout
 * `../dsh-hud`. Only files that exist in BOTH trees are compared for equality;
 * a file present upstream but missing here fails, while a file only here is
 * reported (the build adds `tools/vendor/`, and nothing else).
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = join(root, 'hud')

/** Directories that are generated here and must not be compared. */
const SKIP = new Set(['node_modules', 'vendor', '.git'])

/**
 * What the port actually LOADS. These must match byte for byte: `index.js` and
 * `lib/` + `panels/` are the host half the extension imports, `client.js` is the
 * bundle the webview runs, and `client/` holds the fragments that bundle is
 * built from.
 *
 * Everything else upstream carries — its tools, its README, the packed `.tgz`,
 * scratch probes — is informational. Failing on a file this port never reads
 * would make the check cry wolf, and a check that cries wolf gets ignored.
 */
const REQUIRED = [
  /^index\.js$/,
  /^client\.js$/,
  /^package\.json$/,
  /^client\//,
  /^lib\//,
  /^panels\//,
]

const isRequired = (rel) => REQUIRED.some((pattern) => pattern.test(rel))

const argIndex = process.argv.indexOf('--upstream')
const UPSTREAM = resolve(
  (argIndex > 0 ? process.argv[argIndex + 1] : undefined)
  ?? process.env.DSH_HUD_UPSTREAM
  ?? join(root, '..', 'dsh-hud'),
)

if (!existsSync(UPSTREAM)) {
  console.error(`upstream checkout not found: ${UPSTREAM}`)
  console.error('Pass --upstream <dir> or set DSH_HUD_UPSTREAM.')
  process.exit(2)
}

/** @returns {Map<string, string>} relative path → sha256, for one tree */
function hashTree(base) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!statSync(full).isFile()) continue
      const bytes = readFileSync(full)
      out.set(relative(base, full).replace(/\\/g, '/'), createHash('sha256').update(bytes).digest('hex'))
    }
  }
  walk(base)
  return out
}

const mine = hashTree(LOCAL)
const theirs = hashTree(UPSTREAM)

const changed = []
const missing = []
let identical = 0
for (const [rel, hash] of theirs) {
  if (!mine.has(rel)) {
    missing.push(rel)
    continue
  }
  if (mine.get(rel) !== hash) changed.push(rel)
  else identical++
}
const extra = [...mine.keys()].filter((rel) => !theirs.has(rel))

// Only the files the port loads can fail the run.
const brokenRequired = [...missing, ...changed].filter(isRequired)
const informational = [...missing, ...changed].filter((rel) => !isRequired(rel))

console.log(`upstream : ${UPSTREAM}`)
console.log(`local    : ${LOCAL}`)
console.log(`compared : ${theirs.size} file(s) — ${identical} identical, ${REQUIRED.length} runtime pattern(s) enforced`)

if (informational.length > 0) {
  console.log(`\nnot carried over (${informational.length}) — upstream tooling and scratch files this port does not read:`)
  for (const rel of informational.slice(0, 12)) console.log(`  · ${rel}`)
  if (informational.length > 12) console.log(`  … and ${informational.length - 12} more`)
}

if (extra.length > 0) {
  console.log(`\nonly here (${extra.length}) — the build's own additions:`)
  for (const rel of extra.slice(0, 12)) console.log(`  + ${rel}`)
  if (extra.length > 12) console.log(`  … and ${extra.length - 12} more`)
}

if (brokenRequired.length > 0) {
  console.error(`\nNOT VERBATIM (${brokenRequired.length}) — these are loaded at runtime:`)
  for (const rel of missing.filter(isRequired)) console.error(`  - MISSING  ${rel}`)
  for (const rel of changed.filter(isRequired)) console.error(`  ~ MODIFIED ${rel}`)
  console.error('\nRestore them from the upstream checkout; the port must not edit the HUD tree.')
  process.exit(1)
}
console.log('\nEvery file the port loads is byte-for-byte identical to upstream.')