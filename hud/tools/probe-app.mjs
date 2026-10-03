#!/usr/bin/env node
// @ts-check
/**
 * Read-only probe into the installed DSH app bundle.
 *
 * Answers questions the plugin cannot answer from its own side: what the host
 * shell actually renders around a slot, how much room a dock gives its
 * occupant, which CSS a slot's container uses. A plain Node process cannot read
 * inside an `.asar` (that needs Electron's patched fs), so this unpacks the
 * entries itself.
 *
 * Usage:
 *   node tools/probe-app.mjs list <substring>          # paths + sizes
 *   node tools/probe-app.mjs grep <substring> <regex>  # search inside matches
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ASAR = process.env.DSH_ASAR
  || join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

const buf = readFileSync(ASAR)
// [4][headerPicklePayload][headerStringLength][headerSize][JSON header][data]
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const contentBase = 16 + headerSize

/** @returns {{rel: string, entry: any}[]} */
function walk(node, rel = '', out = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const next = rel ? `${rel}/${name}` : name
    if (entry.files) walk(entry, next, out)
    else out.push({ rel: next, entry })
  }
  return out
}

function read(entry) {
  const start = contentBase + Number(entry.offset)
  return buf.subarray(start, start + Number(entry.size))
}

const all = walk(header)
const [mode, needle, pattern] = process.argv.slice(2)
const hits = all.filter((file) => file.rel.includes(needle ?? ''))

if (mode === 'list') {
  hits.sort((a, b) => Number(b.entry.size) - Number(a.entry.size))
  console.log(`${hits.length} path(s) matching ${JSON.stringify(needle)}, largest first:`)
  for (const file of hits.slice(0, 40)) {
    console.log(`  ${String(Math.round(Number(file.entry.size) / 1024)).padStart(7)} KB  ${file.rel}`)
  }
} else if (mode === 'grep') {
  const re = new RegExp(pattern, 'g')
  let total = 0
  for (const file of hits) {
    const text = read(file.entry).toString('utf8')
    const matches = [...text.matchAll(re)]
    if (matches.length === 0) continue
    total += matches.length
    console.log(`\n=== ${file.rel}  (${matches.length} hit(s))`)
    for (const match of matches.slice(0, 12)) {
      const from = Math.max(0, match.index - 220)
      const snippet = text.slice(from, match.index + 320).replace(/\s+/g, ' ')
      console.log(`  …${snippet}…`)
    }
  }
  console.log(`\n${total} match(es) across ${hits.length} file(s)`)
} else {
  console.error('usage: probe-app.mjs list <substring> | grep <substring> <regex>')
  process.exit(2)
}