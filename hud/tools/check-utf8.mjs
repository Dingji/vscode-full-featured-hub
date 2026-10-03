#!/usr/bin/env node
// @ts-check
/**
 * UTF-8 integrity check.
 *
 * This exists because of a real incident: PowerShell 5.1's `Get-Content -Raw`
 * + `Set-Content` round-trip silently rewrites non-ASCII characters (every
 * em-dash and every Chinese label became `?`) and shrinks the file. Both
 * ported panels are full of Chinese UI text, so a mangled file would still
 * parse, still pass `node --check`, and only show up as `?` in the card.
 *
 * Run: `node tools/check-utf8.mjs`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP = new Set(['node_modules', '.git', 'tools'])
const CHECK_EXT = /\.(js|mjs|json|md|yml)$/

/** @returns {string[]} every candidate file, relative to the package root */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (CHECK_EXT.test(entry)) out.push(relative(root, full))
  }
  return out
}

/**
 * Text that MUST survive a round-trip, per file. These are the strings a
 * mangling would eat first: locale labels rendered straight into the card.
 * Files that carry no non-ASCII text of their own are simply absent here —
 * the U+FFFD and re-encode checks still cover them.
 */
const REQUIRED = {
  'panels/quota/client.js': ['用量限额', '账户余额', '正在获取用量数据…', '已复制', '重置时间未知'],
  'panels/quota/host.js': ['用量导出不是合法 ZIP', '请安装 qianwen CLI（千问官方命令行工具）', '已用'],
  'panels/github/client.js': ['发布', '推送', '合并'],
  'panels/github/host.js': ['你自己的仓库'],
  'client/shell.js': ['用量', '居中', '通栏', '渲染失败', '栏位数'],
  'README.md': ['同一时刻都是活的', '栏位数', '网格', '配额'],
}

let failures = 0
const files = walk(root)

for (const rel of files) {
  const buffer = readFileSync(join(root, rel))
  const text = buffer.toString('utf8')

  // A UTF-8 round-trip through a lossy encoder leaves U+FFFD behind.
  if (text.includes('\uFFFD')) {
    console.error(`FAIL ${rel}: contains U+FFFD (mojibake)`)
    failures++
    continue
  }
  // Re-encoding must reproduce the exact bytes, or the file is not valid UTF-8.
  if (Buffer.from(text, 'utf8').compare(buffer) !== 0) {
    console.error(`FAIL ${rel}: not valid UTF-8 (re-encode differs)`)
    failures++
    continue
  }
  const required = REQUIRED[rel]
  if (required) {
    const missing = required.filter((needle) => !text.includes(needle))
    if (missing.length > 0) {
      console.error(`FAIL ${rel}: missing literal text ${JSON.stringify(missing)}`)
      failures++
      continue
    }
  }
  console.log(`ok   ${rel} (${buffer.length} bytes)`)
}

console.log(`\n${files.length} files checked`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('utf-8: all green')