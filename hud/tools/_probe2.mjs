// Research round 2: the contract LIST for an exchange, and where 持仓量 lives.
const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } })
  return res.json()
}

// ── 1. every contract SHFE lists, which reveals the naming convention ──
console.log('=== the SHFE board (m:113), first rows ===')
const listUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=40&po=1&np=1&fltt=2&invt=2'
  + '&fid=f3&fs=m:113&fields=f12,f13,f14,f2,f3,f5,f6'
const board = await get(listUrl)
console.log('  total reported:', board?.data?.total)
for (const row of (board?.data?.diff ?? []).slice(0, 25)) {
  console.log(`  ${String(row.f12).padEnd(12)} ${row.f14}`)
}

// ── 2. is there a 主力/连续 row anywhere? look for suspicious codes across exchanges ──
console.log('\n=== codes that are not a plain contract month ===')
for (const [mkt, label] of [[113, 'SHFE'], [114, 'DCE'], [115, 'CZCE'], [220, 'CFFEX'], [225, 'GFEX']]) {
  const json = await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:${mkt}&fields=f12,f14`)
  const odd = (json?.data?.diff ?? [])
    .map((row) => String(row.f12))
    .filter((code) => !/^[A-Za-z]{1,3}\d{3,4}$/.test(code))
  console.log(`  ${label.padEnd(6)} total=${String(json?.data?.total).padEnd(5)} odd=${JSON.stringify(odd.slice(0, 14))}`)
}

// ── 3. which field carries 持仓量? ask for a wide range and print the numbers ──
console.log('\n=== hunting 持仓量 (open interest) ===')
const wide = Array.from({ length: 40 }, (_, i) => `f${i + 1}`).join(',')
const probe = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=113.rb2610&fields=${wide}`)
const row = probe?.data?.diff?.[0] ?? {}
const entries = Object.entries(row).filter(([, value]) => typeof value === 'number' && value !== 0 && value !== '-')
console.log('  rb2610 non-zero numeric fields:')
for (const [key, value] of entries) console.log(`     ${key} = ${value}`)

// ── 4. the same for a stock, to see which fields are futures-only ──
const stock = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=1.600519&fields=${wide}`)
const srow = stock?.data?.diff?.[0] ?? {}
const futuresOnly = Object.keys(row).filter((key) => row[key] !== undefined && srow[key] === undefined)
console.log('  fields a future has and a stock does not:', JSON.stringify(futuresOnly))