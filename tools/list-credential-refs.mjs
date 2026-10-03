#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — list the credential refs the panels ask for.
 *
 * Every panel resolves its secrets through `host.credential.resolve(REF)`, and
 * the card's own drawer learns the refs from the payload. The VS Code
 * `hud.setCredential` command needs the same list BEFORE any panel has polled,
 * so it is read out of the source here.
 *
 *   node tools/list-credential-refs.mjs            # human-readable
 *   node tools/list-credential-refs.mjs --json     # for the extension to embed
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** A credential reference is a POSIX identifier in upper snake case. */
const REF = /^[A-Z][A-Z0-9_]{4,40}$/
/** It has to look like a secret's name, not any shouting constant. */
const NAMES_A_SECRET = /(KEY|TOKEN|COOKIE|SECRET|PASSWORD|CREDENTIAL|CODE)$/

/** @returns {string[]} every file under the given directories */
function filesUnder(...dirs) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|mjs)$/.test(entry.name) && statSync(full).isFile()) out.push(full)
    }
  }
  for (const dir of dirs) walk(join(root, dir))
  return out
}

/** @type {Map<string, Set<string>>} */
const found = new Map()
for (const file of filesUnder('hud/panels', 'hud/lib')) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]{3,40})['"`]/g)) {
    const name = match[1]
    // A template literal may interpolate; only plain names are refs.
    if (!REF.test(name) || !NAMES_A_SECRET.test(name)) continue
    if (!found.has(name)) found.set(name, new Set())
    found.get(name).add(relative(root, file).replace(/\\/g, '/'))
  }
}

const rows = [...found.entries()]
  .map(([ref, files]) => ({ ref, files: [...files].sort() }))
  .sort((a, b) => a.ref.localeCompare(b.ref))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows.map((row) => row.ref)))
} else {
  for (const row of rows) console.log(`${row.ref.padEnd(32)} ${row.files.length} file(s): ${row.files.join(', ')}`)
  console.log(`\n${rows.length} refs`)
}