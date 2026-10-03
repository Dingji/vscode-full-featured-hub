// Research round 4: confirm 持仓量 by comparing a main contract with a far month, test the K-line
// on a 主连 code, and check whether a term structure (期限结构) can be built.
const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } })
  return res.json()
}

// ── 1. 持仓量: the main month should dwarf a far month. That is the test. ──
console.log('=== main month vs far month (which field behaves like 持仓量?) ===')
const fields = 'f2,f3,f4,f5,f6,f12,f14,f108,f107,f111,f109,f110'
const json = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=113.rb2610,113.rb2709,113.rb2701&fields=${fields}`)
for (const row of json?.data?.diff ?? []) {
  console.log(`  ${String(row.f12).padEnd(8)} ${String(row.f14).padEnd(12)} vol=${String(row.f5).padEnd(10)} ` +
    `amount=${String(row.f6).padEnd(14)} f108=${String(row.f108).padEnd(10)} f107=${row.f107} f111=${row.f111}`)
}

// A stock, to see whether f108 means anything there (it should not).
const stock = (await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=1.600519&fields=${fields}`))?.data?.diff?.[0]
console.log(`  stock 600519: f108=${stock?.f108} f107=${stock?.f107} (a stock has no open interest)`)

// ── 2. does the K-line work for a 主连 code? ──
console.log('\n=== kline on 主连 ===')
for (const secid of ['113.rum', '220.IFM', '102.CL00Y']) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=4&end=20500101`
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  const json = await get(url)
  console.log(`  ${secid.padEnd(12)} name=${json?.data?.name} rows=${json?.data?.klines?.length} ` +
    `last=${JSON.stringify(json?.data?.klines?.slice(-1)[0])}`)
}

// ── 3. can a term structure be built? all contracts of one product, sorted by month ──
console.log('\n=== term structure for 螺纹钢 (all listed months) ===')
const board = await get('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=400&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:113&fields=f12,f14,f2,f3,f5,f108')
const months = (board?.data?.diff ?? [])
  .filter((row) => /^rb\d{4}$/i.test(row.f12))
  .map((row) => ({ code: row.f12, price: row.f2, oi: row.f108, vol: row.f5 }))
  .sort((a, b) => a.code.localeCompare(b.code))
for (const one of months) console.log(`  ${one.code.padEnd(8)} price=${String(one.price).padEnd(9)} vol=${String(one.vol).padEnd(10)} oi=${one.oi}`)

// ── 4. the night session: do these products trade at night, and does the quote carry a time? ──
console.log('\n=== a timestamp field? ===')
const time = (await get('https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=113.rum&fields=f2,f12,f14,f124,f125,f86'))?.data?.diff?.[0]
console.log('  ', JSON.stringify(time), '-> f124 as a date:', time?.f124 ? new Date(time.f124 * 1000).toISOString() : 'n/a')