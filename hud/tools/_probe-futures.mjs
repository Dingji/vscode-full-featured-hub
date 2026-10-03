// Research: how does eastmoney identify futures, and how is the 主力合约 represented?
//
// The lesson from the FX pairs in this repo applies here: SECIDs ARE FOUND, NOT GUESSED. A wrong
// prefix does not error — it silently returns the wrong instrument or an empty row, which is how
// a panel "works" while showing nothing.
const TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'
const SEARCH = 'https://searchapi.eastmoney.com/api/suggest/get'
const QUOTE = 'https://push2.eastmoney.com/api/qt/ulist.np/get'

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  return res.json()
}

const search = async (input, count = 8) => {
  const url = `${SEARCH}?input=${encodeURIComponent(input)}&type=14&token=${TOKEN}&count=${count}`
  const json = await get(url)
  return json?.QuotationCodeTable?.Data ?? []
}

// ── 1. one representative product per exchange, to learn every prefix ──
console.log('=== exchange prefixes ===')
const probes = ['螺纹钢', '铁矿石', 'PTA', '甲醇', '沪深300', '十年国债', '原油', '碳酸锂', '豆粕', '黄金']
const seen = new Map()
for (const probe of probes) {
  const rows = await search(probe, 6)
  const futures = rows.filter((row) => row.SecurityTypeName === '期货')
  for (const row of futures) {
    const key = `${row.JYS}`
    if (!seen.has(key)) {
      seen.set(key, { mkt: row.MktNum, jys: row.JYS, sample: row.Code, name: row.Name })
    }
  }
}
for (const [jys, info] of [...seen].sort((a, b) => Number(a[1].mkt) - Number(b[1].mkt))) {
  console.log(`  mkt=${String(info.mkt).padEnd(4)} ${jys.padEnd(8)} ${info.sample.padEnd(10)} ${info.name}`)
}

// ── 2. is there a 主力 / 连续 symbol? ──
console.log('\n=== 主力/连续 symbols ===')
for (const probe of ['螺纹钢主力', '螺纹钢连续', 'rb0', '沪深300主力']) {
  const rows = await search(probe, 5)
  const futures = rows.filter((row) => row.SecurityTypeName === '期货')
  if (futures.length === 0) { console.log(`  ${probe.padEnd(12)} -> nothing`); continue }
  for (const row of futures.slice(0, 3)) {
    console.log(`  ${probe.padEnd(12)} -> mkt=${row.MktNum} code=${row.Code} name=${row.Name}`)
  }
}

// ── 3. does a plain quote work for a discovered secid? ──
console.log('\n=== quote fields (what a pro panel needs) ===')
const fields = 'f1,f2,f3,f4,f12,f13,f14,f15,f16,f17,f18,f5,f6,f20,f21,f8,f10,f9,f23'
const url = `${QUOTE}?fltt=2&invt=2&np=1&secids=113.rb2610,113.rb0,225.lc2610&fields=${fields}`
const quote = await get(url)
for (const row of quote?.data?.diff ?? []) {
  console.log(`  mkt=${row.f13} code=${row.f12} name=${row.f14} price=${row.f2} chg%=${row.f3} ` +
    `vol=${row.f5} oi=${row.f20 ?? row.f21} prevClose=${row.f18} open=${row.f17} high=${row.f15} low=${row.f16}`)
}
void fields

// ── 4. a K-line for a futures secid ──
console.log('\n=== kline ===')
const kline = await get('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=113.rb0&klt=101&fqt=0&lmt=5&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57')
console.log('  name:', kline?.data?.name, '| rows:', JSON.stringify(kline?.data?.klines))