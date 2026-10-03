// Research round 3: confirm the 主连 names, and find 持仓量.
const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } })
  return res.json()
}

// ── 1. what are the m/s codes actually CALLED? ──
console.log('=== the m / s codes, by name ===')
for (const [mkt, label] of [[113, 'SHFE'], [114, 'DCE'], [115, 'CZCE'], [220, 'CFFEX'], [225, 'GFEX']]) {
  const json = await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:${mkt}&fields=f12,f14`)
  const mains = (json?.data?.diff ?? [])
    .filter((row) => /主连|次主连/.test(row.f14))
    .map((row) => `${row.f12}=${row.f14}`)
  console.log(`  ${label}: ${mains.slice(0, 12).join('  ')}`)
}

// ── 2. 持仓量: sweep the high field numbers ──
console.log('\n=== sweeping f100..f140 for 持仓量 ===')
const high = Array.from({ length: 45 }, (_, i) => `f${i + 100}`).join(',')
const fut = (await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=113.rb2610&fields=${high}`))?.data?.diff?.[0] ?? {}
const stock = (await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=1.600519&fields=${high}`))?.data?.diff?.[0] ?? {}
console.log('  rb2610:', JSON.stringify(fut))
console.log('  the future has, the stock does not:',
  JSON.stringify(Object.keys(fut).filter((key) => fut[key] !== undefined && stock[key] === undefined)))

// ── 3. the ulist request with a named field set — what does eastmoney's own page ask for? ──
console.log('\n=== a main-continuous quote, with a pro field set ===')
const fields = 'f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f23,f24,f25,f26,f27,f28,f29,f30,f31,f32,f33,f34,f35,f36,f37,f38,f39,f40'
const mains = '113.rum,113.cum,113.aum,114.i0,114.im,220.IFM,225.lcm,115.MAM,102.CL00Y,101.GC00Y'
const json = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=${mains}&fields=${fields}`)
for (const row of json?.data?.diff ?? []) {
  console.log(`  ${String(row.f13).padEnd(4)}.${String(row.f12).padEnd(8)} ${String(row.f14).padEnd(12)} ` +
    `price=${String(row.f2).padEnd(9)} chg%=${String(row.f3).padEnd(7)} vol=${String(row.f5).padEnd(9)} ` +
    `f20=${row.f20 ?? '-'} f21=${row.f21 ?? '-'} f22=${row.f22 ?? '-'}`)
}