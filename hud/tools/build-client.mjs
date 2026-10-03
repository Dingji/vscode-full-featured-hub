#!/usr/bin/env node
// @ts-check
/**
 * @dingji_cherubino/dsh-full-featured-hub — browser bundle builder.
 *
 * The DSH client module system loads ONE file per package (`exports["./client"]`)
 * and registers it as a single `window.__ModuleLoader__.load({ id, factory })`
 * call. Panels are therefore authored as separate, individually reviewable
 * fragments and concatenated here into that one bundle — inside a single
 * factory scope, so a panel can use the shell's helpers and still keep all of
 * its own internals private inside `create<Id>Panel()`.
 *
 *   node tools/build-client.mjs            # write client.js
 *   node tools/build-client.mjs --check    # fail if client.js is out of date
 *
 * Panel fragments are DISCOVERED: any `panels/<dir>/client.js` is included, in
 * directory-name order. Concatenation order does not matter — tab order comes
 * from each panel's `order`, decided at runtime by the shell's registry.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'client.js')
const checkOnly = process.argv.includes('--check')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PACKAGE_NAME = String(pkg.name)

/** The shell is first (it defines `hud`), the epilogue is last (it registers). */
const SHELL = 'client/shell.js'
const EPILOGUE = 'client/register.js'

/** Every `panels/<dir>/client.js`, in a deterministic order. */
function panelFragments() {
  const dir = join(root, 'panels')
  return readdirSync(dir)
    .filter((name) => {
      const file = join(dir, name, 'client.js')
      return existsSync(file) && statSync(file).isFile()
    })
    .sort()
    .map((name) => `panels/${name}/client.js`)
}

/**
 * A fragment is concatenated straight into a function body, so it must not
 * carry module syntax or a top-level `return`. Catching that here beats
 * debugging a `Unexpected token 'export'` inside the browser bundle.
 */
function assertFragment(rel) {
  const text = readFileSync(join(root, rel), 'utf8')
  const offenders = []
  if (/^(import|export)\s/m.test(text)) offenders.push('top-level import/export')
  if (/^return\b/m.test(text)) offenders.push('top-level return')
  if (offenders.length > 0) {
    throw new Error(`${rel}: fragment contains ${offenders.join(' and ')} — see the FRAGMENT CONTRACT comment in ${SHELL}`)
  }
  return text
}

const parts = [SHELL, ...panelFragments(), EPILOGUE]
const bodies = parts.map((rel) => {
  const text = assertFragment(rel)
  return `\n// ${'─'.repeat(74)}\n// ── ${rel}\n// ${'─'.repeat(74)}\n\n${text.trimEnd()}\n`
})

const banner = `// @dingji_cherubino/dsh-full-featured-hub — browser half. GENERATED FILE — DO NOT EDIT.
//
// Hand-authored client bundle in the DSH module-loader factory format:
//   window.__ModuleLoader__.load({ id, factory: (require) => exports })
// Only the platform module table may be required (react / react/jsx-runtime).
//
// Built by \`node tools/build-client.mjs\` from:
${parts.map((rel) => `//   - ${rel}`).join('\n')}
//
// Edit those fragments, never this file. A fragment is concatenated verbatim
// into the factory below, so it may not contain top-level import/export/return.

window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const { jsx, jsxs } = require('react/jsx-runtime')
    const React = require('react')
${bodies.join('')}
    return module.exports
  },
})
`

if (checkOnly) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== banner) {
    console.error(`client.js is OUT OF DATE — run: node tools/build-client.mjs`)
    process.exit(1)
  }
  console.log(`client.js is up to date (${parts.length} fragments)`)
  process.exit(0)
}

writeFileSync(target, banner, 'utf8')
const lines = banner.split('\n').length
console.log(`client.js written: ${parts.length} fragments, ${lines} lines, ${Buffer.byteLength(banner)} bytes`)