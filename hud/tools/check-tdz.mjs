// Static check: a top-level `export` must not name a binding declared BELOW it.
//
// ── why this exists ────────────────────────────────────────────────────────
//
// `export const __test = { airLevel, AIR_FIELDS, … }` placed above the `const
// AIR_FIELDS = …` it names is a TDZ crash at module evaluation:
//
//     ReferenceError: Cannot access 'AIR_FIELDS' before initialization
//
// and `node --check` cannot see it, because it is not a syntax error. This has
// happened FIVE times in this project (imagine, weather, market, bond, index),
// each time costing a debugging round on a file that looked perfect. So it is
// checked mechanically.
//
// The rule implemented: for every top-level declaration in a file, an EXPORTED
// top-level expression may not reference a name whose declaration line is greater
// than the export's line. Only same-file bindings are considered — an import or a
// parameter is not a TDZ risk here.
//
// Deliberately conservative: it reports a violation only when it can see both the
// declaration and the reference, so it never invents a problem. A miss is
// acceptable; a false alarm is not.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Every source file that is NOT generated. */
function sources() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'tools') continue
        walk(full)
        continue
      }
      if (!/\.(js|mjs)$/.test(entry.name)) continue
      // `client.js` is the concatenated bundle: its fragments are checked instead.
      if (relative(root, full) === 'client.js') continue
      out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * Top-level declarations and their lines, with the KIND.
 *
 * The kind is the whole point: `function` declarations are HOISTED, so naming one
 * above its definition is perfectly safe — and an earlier version of this check
 * reported 28 violations across the ported panels, every one of them a hoisted
 * function. Only `const` / `let` / `class` are TDZ hazards.
 */
function declarations(lines) {
  const map = new Map()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lexical = /^(?: {0,4})(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)
    const klass = /^(?: {0,4})(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line)
    const fn = /^(?: {0,4})(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line)
    if (lexical !== null) {
      if (!map.has(lexical[1])) map.set(lexical[1], { line: index + 1, hoisted: false })
    } else if (klass !== null) {
      if (!map.has(klass[1])) map.set(klass[1], { line: index + 1, hoisted: false })
    } else if (fn !== null) {
      // A function declaration wins over a same-named lexical binding only if it
      // was seen first; either way it is not the hazard this check looks for.
      if (!map.has(fn[1])) map.set(fn[1], { line: index + 1, hoisted: true })
    }
  }
  return map
}

/** Exported object literals that name other bindings: `export const X = { a, b }`. */
function exportedObjects(lines) {
  const blocks = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^(?: {0,4})export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(lines[index])
    if (match === null) continue
    let end = index
    let depth = 0
    for (; end < lines.length; end++) {
      for (const char of lines[end]) {
        if (char === '{') depth += 1
        else if (char === '}') depth -= 1
      }
      if (depth <= 0 && end >= index) break
    }
    blocks.push({ name: match[1], from: index + 1, to: end + 1, body: lines.slice(index, end + 1).join('\n') })
  }
  return blocks
}

const files = sources()
let failures = 0
let checked = 0

for (const file of files.sort()) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const declared = declarations(lines)
  if (declared.size === 0) continue
  for (const block of exportedObjects(lines)) {
    checked += 1
    const names = new Set()
    for (const match of block.body.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*(?:,|\}|$)/gm)) names.add(match[1])
    for (const name of names) {
      const found = declared.get(name)
      if (found === undefined) continue
      // Hoisted function declarations are safe above their definition.
      if (found.hoisted) continue
      const at = found.line
      // Declared INSIDE the exported literal itself, or ABOVE it: both are fine.
      // (The first version of this check skipped anything declared outside the
      // block — which is every real violation, so it reported a green run on a
      // file that crashed. Proving the check with a deliberately broken probe is
      // what exposed that.)
      if (at <= block.to) continue
      failures += 1
      const where = relative(root, file)
      console.log(`  FAIL ${where}: export "${block.name}" (line ${block.from}) names "${name}", declared at line ${at}`)
      console.log('       a module-level TDZ crash — move the declaration above the export, or move the export to the end of the file')
    }
  }
}

console.log(`tdz: ${failures === 0 ? 'all green' : `${failures} problem(s)`} (${files.length} file(s), ${checked} exported object(s) inspected)`)
process.exit(failures === 0 ? 0 : 1)