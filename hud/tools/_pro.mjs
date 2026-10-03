// What does the quote endpoint already carry for multi-period changes? A pro rate table shows
// 1日/1周/1月/年初至今 side by side, and 16 separate K-line requests to build that would be absurd
// if four fields will do it.
const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } })
  return res.json()
}

console.log('=== FX: every field that could be a period change ===')
const wide = Array.from({ length: 40 }, (_, i) => `f${i + 1}`).join(',')
const fx = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?invt=2&np=1&secids=133.USDCNH,119.EURUSD,100.UDI&fields=${wide}`)
for (const row of fx?.data?.diff ?? []) {
  console.log(`  --- ${row.f12} ${row.f14} ---`)
  const entries = Object.entries(row).filter(([key, value]) => value !== '-' && value !== 0 && key !== 'f13')
  console.log('   ', entries.map(([key, value]) => `${key}=${value}`).join(' '))
}

console.log('\n=== futures: the same, plus anything that looks like 持仓量变化 ===')
const fut = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?invt=2&np=1&secids=113.rbm,114.mm&fields=${wide}`)
for (const row of fut?.data?.diff ?? []) {
  console.log(`  --- ${row.f12} ${row.f14} ---`)
  const entries = Object.entries(row).filter(([key, value]) => value !== '-' && value !== 0 && key !== 'f13')
  console.log('   ', entries.map(([key, value]) => `${key}=${value}`).join(' '))
}

// A field that means 持仓量变化 must be SMALL next to 持仓量, and it must differ between contracts
// whose open interest differs by orders of magnitude — rb2701 has 1.59M against rb2610's 20k.
console.log('\n=== does any field behave like 持仓量变化? (compare with f108) ===')
const cmp = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?invt=2&np=1&secids=113.rb2610,113.rb2701,113.rb2709&fields=f12,f14,f108,f110,f111,f112,f113,f114,f115,f116,f117,f118`)
for (const row of cmp?.data?.diff ?? []) {
  console.log(`  ${String(row.f12).padEnd(8)} oi=${String(row.f108).padEnd(9)} f110=${String(row.f110).padEnd(8)} f111=${String(row.f111).padEnd(8)} f112=${row.f112} f113=${row.f113} f114=${row.f114} f115=${row.f115}`)
}