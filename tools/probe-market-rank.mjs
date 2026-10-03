#!/usr/bin/env node
// @ts-check
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Eastmoney's ranking endpoint, checked before any card is built on it.
 *
 * The watch list uses `ulist.np/get` — quotes for symbols you already know. A 涨跌榜
 * needs `clist/get`, which sorts a whole MARKET by change percent and is a different
 * response shape (`data.diff` is an array, not an object keyed by secid).
 *
 * The two things worth confirming by hand: which way `po` sorts, and whether `fltt=2`
 * already returns a percentage or hundredths of one. Both are the kind of detail that
 * looks right in a card showing plausible numbers.
 *
 *   node tools/probe-market-rank.mjs
 *   node tools/probe-market-rank.mjs --market=hk --size=5
 */

const MARKETS = {
  // A-shares: Shenzhen main + ChiNext, Shanghai main + STAR, Beijing.
  cn: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
  hk: 'm:128+t:3,m:128+t:4,m:128+t:1,m:128+t:2',
  us: 'm:105,m:106,m:107',
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find((value) => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const market = flag('market', 'cn')
const size = Number(flag('size', '20'))

const URL_BASE = 'https://push2.eastmoney.com/api/qt/clist/get'
const FIELDS = 'f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18'

async function rank(direction) {
  const url = `${URL_BASE}?pn=1&pz=${size}&po=${direction === 'up' ? 1 : 0}&np=1&fltt=2&invt=2&fid=f3`
    + `&fs=${encodeURIComponent(MARKETS[market])}&fields=${FIELDS}&_=${Date.now()}`
  const response = await fetch(url, {
    headers: { accept: 'application/json, text/plain, */*', referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  const rows = body?.data?.diff
  if (!Array.isArray(rows)) throw new Error(`unexpected shape: ${JSON.stringify(body).slice(0, 200)}`)
  return { total: body.data.total, rows }
}

const raw = await rank('up')
console.log(`market=${market} size=${size} total listed=${raw.total}`)
console.log('\n— raw first row, to read the units off it —')
console.log(JSON.stringify(raw.rows[0], null, 1))

for (const direction of ['up', 'down']) {
  const { rows } = await rank(direction)
  console.log(`\n— ${direction === 'up' ? '涨幅榜 (po=1)' : '跌幅榜 (po=0)'} — ${rows.length} rows`)
  for (const row of rows.slice(0, 5)) {
    console.log(`  ${String(row.f12).padEnd(8)} ${String(row.f14).padEnd(12)} ${String(row.f2).padStart(9)}  ${row.f3 > 0 ? '+' : ''}${row.f3}%`)
  }
  const sorted = rows.map((row) => row.f3)
  const monotonic = direction === 'up'
    ? sorted.every((value, index) => index === 0 || sorted[index - 1] >= value)
    : sorted.every((value, index) => index === 0 || sorted[index - 1] <= value)
  console.log(`  sorted the way \`po=${direction === 'up' ? 1 : 0}\` promises: ${monotonic}`)
}

/**
 * And the ROUTE the card actually calls, against the same live endpoint.
 *
 * The unit tests stub the fetch (they must — a test that needs Eastmoney is a test
 * that fails on a train), so this is where the two halves meet: the real handler,
 * a real request object, and a real answer.
 */
