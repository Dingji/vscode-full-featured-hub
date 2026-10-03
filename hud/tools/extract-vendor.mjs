#!/usr/bin/env node
// @ts-check
/**
 * Pull `@deepseek-ai/schemastery` out of the installed DSH app bundle.
 *
 * The plugin's settings schema is built with the REAL schemastery at runtime,
 * and schemastery's `.volatile()` placement rules are enforced by the loader —
 * so the only honest way to test `Config` is against the real library. A plain
 * Node process cannot read inside an `.asar` (that needs Electron's patched
 * fs), so this does the one thing Electron does for us: unpack the entries.
 *
 * Output: `tools/vendor/schemastery/` (git-ignored, never published).
 * Run:    `node tools/extract-vendor.mjs`
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Default install location; override with DSH_ASAR. */
const ASAR = process.env.DSH_ASAR
  || join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

/** Where the plugin's resolver looks, relative to the asar root. */
const IN_ASAR = ['dsh', 'node_modules', '@deepseek-ai']
/**
 * The subtree to unpack. `cosmokit` is schemastery's own runtime dependency, so
 * both land under `vendor/node_modules/@deepseek-ai/` — which is also what lets
 * schemastery's bare `import '@deepseek-ai/cosmokit'` resolve upward to it.
 */
const PACKAGES = ['schemastery', 'cosmokit']
const OUT = join(here, 'vendor', 'node_modules', '@deepseek-ai')

if (!existsSync(ASAR)) {
  console.error(`app.asar not found: ${ASAR}`)
  console.error('Set DSH_ASAR to the path of resources/app.asar and retry.')
  process.exit(1)
}

const buf = readFileSync(ASAR)
// ASAR layout: [4][headerPicklePayload][headerStringLength][headerSize][JSON header][file data].
// `readUInt32LE(12)` is the exact JSON length (the parse below proves it), so
// file data starts at 16 + headerSize. The commonly copied `8 + headerSize` is
// off by 8 and yields silently shifted — i.e. truncated — files.
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const contentBase = 16 + headerSize

/** Walk to the directory node for a POSIX-style path inside the archive. */
function nodeAt(segments) {
  let node = header
  for (const segment of segments) {
    node = node?.files?.[segment]
    if (!node) throw new Error(`not in the archive: ${segments.join('/')}`)
  }
  return node
}

let files = 0
let bytes = 0

/**
 * Verify one entry against the archive's own integrity block list, so a wrong
 * offset can never masquerade as a successful extraction.
 */
function verify(entry, data, rel) {
  const blocks = entry.integrity?.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return
  const blockSize = Number(entry.integrity.blockSize) || data.length || 1
  blocks.forEach((expected, index) => {
    const slice = data.subarray(index * blockSize, (index + 1) * blockSize)
    const actual = createHash('sha256').update(slice).digest('hex')
    if (actual !== expected) {
      throw new Error(`integrity mismatch in ${rel} (block ${index}): ${actual} != ${expected}`)
    }
  })
}

function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const childRel = rel ? `${rel}/${name}` : name
    if (entry.files) {
      walk(entry, childRel)
      continue
    }
    if (entry.unpacked) continue // lives in app.asar.unpacked; not needed here
    const target = join(OUT, childRel)
    const resolved = resolve(target)
    if (!resolved.startsWith(resolve(OUT) + sep)) throw new Error(`path escape: ${childRel}`)
    const start = contentBase + Number(entry.offset)
    const data = buf.subarray(start, start + Number(entry.size))
    if (data.length !== Number(entry.size)) throw new Error(`short read in ${childRel}`)
    verify(entry, data, childRel)
    mkdirSync(dirname(resolved), { recursive: true })
    writeFileSync(resolved, data)
    files++
    bytes += data.length
  }
}

const subtreeRoot = nodeAt(IN_ASAR)
for (const name of PACKAGES) {
  const node = subtreeRoot.files?.[name]
  if (!node) {
    console.error(`not in the archive: ${[...IN_ASAR, name].join('/')}`)
    process.exit(1)
  }
  walk(node, name)
}

console.log(`extracted ${files} files (${bytes} bytes)`)
console.log(`  from  ${ASAR}::${[...IN_ASAR, `{${PACKAGES.join(',')}}`].join('/')}`)
console.log(`  to    ${OUT}`)

// Prove it is importable from here — the whole point of extracting it.
try {
  const mod = await import(new URL('./vendor/node_modules/@deepseek-ai/schemastery/lib/index.mjs', import.meta.url).href)
  const z = mod.default ?? mod
  console.log(`  import ok: typeof z === '${typeof z}'`)
  if (typeof z !== 'function') {
    console.error('extracted schemastery did not default-export a factory')
    process.exit(1)
  }
} catch (error) {
  console.error(`  import FAILED: ${error instanceof Error ? error.message : String(error)}`)
  console.error('  a dependency is probably missing from the archive subtree')
  process.exit(1)
}