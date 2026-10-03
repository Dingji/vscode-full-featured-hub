#!/usr/bin/env node
// @ts-check
/**
 * Static check: a `jsx(...)` call must never receive an ARRAY of children.
 *
 * React's automatic runtime has two entries. `jsxs` (static) takes an array of
 * children; `jsx` (dynamic) takes exactly one and validates it, warning for each
 * child without a `key`. Calling `jsx` with an array is therefore not a style
 * question — it is a runtime warning and, with it, a real chance of a wrong or
 * missing key.
 *
 * The browser suite already fails on React warnings, but ONLY for the branches a
 * test happens to render. This file catches the whole class statically, in every
 * branch, including the ones no test reaches — which is how this same mistake
 * got through four times before it was worth writing down.
 *
 * Run: `node tools/check-jsx.mjs` (also part of `npm test`).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Every hand-written browser fragment: the bundle is generated from these. */
function fragments() {
  const files = [join(root, 'client', 'shell.js'), join(root, 'client', 'register.js')]
  const panels = join(root, 'panels')
  for (const entry of readdirSync(panels, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    files.push(join(panels, entry.name, 'client.js'))
  }
  return files
}

/**
 * Strip strings and comments so a `(` inside a string cannot unbalance the scan.
 * Returns the same length with those regions blanked out, so indices still map
 * back to the original text.
 */
function blank(text) {
  const out = text.split('')
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') out[index++] = ' '
      continue
    }
    if (char === '/' && next === '*') {
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) out[index++] = ' '
      out[index++] = ' '
      out[index++] = ' '
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out[index++] = ' '
      while (index < text.length) {
        if (text[index] === '\\') {
          out[index++] = ' '
          out[index++] = ' '
          continue
        }
        const done = text[index] === quote
        out[index++] = ' '
        if (done) break
      }
      continue
    }
    index += 1
  }
  return out.join('')
}

/** The end index (exclusive) of the call whose `(` is at `open`. */
function callEnd(clean, open) {
  let depth = 0
  for (let index = open; index < clean.length; index++) {
    if (clean[index] === '(') depth += 1
    else if (clean[index] === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return clean.length
}

/** The index of the `]` matching the `[` at `open`, or the end of the text. */
function matchingBracket(clean, open) {
  let depth = 0
  for (let index = open; index < clean.length; index++) {
    if (clean[index] === '[') depth += 1
    else if (clean[index] === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return clean.length
}

/** Blank out every nested jsx/jsxs call inside a span, innermost first. */
function withoutNested(clean, from, to) {
  const chars = clean.slice(from, to).split('')
  // Repeatedly remove the innermost calls: after removing inner ones, outer ones
  // become innermost, so a few passes clear the nesting.
  for (let pass = 0; pass < 40; pass++) {
    const text = chars.join('')
    const match = /jsxs?\(/.exec(text)
    if (!match) break
    const open = match.index + match[0].length - 1
    const end = callEnd(text, open)
    for (let index = match.index; index < end; index++) chars[index] = ' '
  }
  return chars.join('')
}

let problems = 0
let scanned = 0

for (const file of fragments()) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  const clean = blank(text)
  const lines = text.split('\n')
  const lineOf = (index) => text.slice(0, index).split('\n').length
  for (let at = clean.indexOf('jsx('); at >= 0; at = clean.indexOf('jsx(', at + 1)) {
    // `jsxs(` also contains `jsx` — skip it.
    if (clean[at + 3] === 's') continue
    const open = at + 3
    const end = callEnd(clean, open)
    const inner = withoutNested(clean, open, end)
    const found = /children:\s*\[/.exec(inner)
    if (!found) continue
    // `[...].join('')` is a STRING, not an array of children — the `[` is the
    // receiver of the join, which is a common and correct shape.
    const bracket = open + found.index + found[0].length - 1
    const close = matchingBracket(clean, bracket)
    const after = clean.slice(close + 1, close + 12)
    if (/^\s*\.join\(/.test(after)) continue
    const line = lineOf(at)
    console.log(`  ${file.replace(`${root}\\`, '')}:${line}  (children is an array${/^\s*\.(map|filter|slice)\(/.test(after) ? ' from ' + after.trim().split('(')[0].slice(1) : ''})`)
    console.log(`      ${lines[line - 1]?.trim().slice(0, 110)}`)
    problems += 1
  }
}

if (problems > 0) {
  console.error(`\n${problems} jsx() call(s) receive an array of children — use jsxs().`)
  console.error('React validates every child of a dynamic call, so each one needs a key,')
  console.error('and the browser suite fails on the warning this produces.')
  process.exit(1)
}
console.log(`jsx/jsxs: all green (${scanned} fragments scanned, no array children passed to jsx)`)