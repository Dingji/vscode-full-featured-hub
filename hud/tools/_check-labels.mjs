// Two checks in one pass:
//   1. does every hand-written short label match the name the exchange itself reports?
//   2. what FX instruments exist beyond the handful the 股市 view already shows?
import { readFileSync } from 'node:fs'

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } })
  return res.json()
}

// ── 1. the labels ──
const source = readFileSync('panels/futures/host.js', 'utf8')
const shipped = [...source.matchAll(/\{ secid: '([^']+)', zh: '([^']+)', sector: '([^']+)' \}/g)]
  .map(([, secid, zh, sector]) => ({ secid, zh, sector }))

const ids = shipped.map((one) => one.secid).join(',')
const quote = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&fields=f12,f13,f14,f2,f108&secids=${ids}`)
const byId = new Map((quote?.data?.diff ?? []).map((row) => [`${row.f13}.${row.f12}`, row]))

console.log(`=== label check: ${shipped.length} shipped contracts ===`)
const mismatches = []
for (const one of shipped) {
  const row = byId.get(one.secid)
  if (row === undefined) { mismatches.push(`${one.secid}: NO PRICE`); continue }
  // The exchange calls it 螺纹钢主连; the panel calls it 螺纹钢. Strip the suffix the exchange adds.
  const official = String(row.f14).replace(/(主连|次主连|当月连续|连续)$/, '')
  if (official !== one.zh && !official.includes(one.zh)) {
    mismatches.push(`${one.secid}: panel says "${one.zh}", the exchange says "${row.f14}"`)
  }
}
console.log(mismatches.length === 0 ? '  every label matches' : mismatches.map((one) => `  MISMATCH ${one}`).join('\n'))

// ── 2. FX candidates ──
console.log('\n=== FX: what exists ===')
const CANDIDATES = [
  ['133', 'USDCNH', '美元/离岸人民币'], ['133', 'EURCNH', '欧元/离岸人民币'],
  ['133', 'GBPCNH', '英镑/离岸人民币'], ['133', 'JPYCNH', '日元/离岸人民币'],
  ['133', 'HKDCNH', '港元/离岸人民币'], ['133', 'AUDCNH', '澳元/离岸人民币'],
  ['133', 'CADCNH', '加元/离岸人民币'], ['133', 'CHFCNH', '瑞郎/离岸人民币'],
  ['133', 'SGDCNH', '新加坡元/离岸人民币'], ['133', 'NZDCNH', '新西兰元/离岸人民币'],
  ['119', 'USDCNY', '美元/在岸人民币'], ['119', 'EURUSD', '欧元/美元'],
  ['119', 'USDJPY', '美元/日元'], ['119', 'GBPUSD', '英镑/美元'],
  ['119', 'AUDUSD', '澳元/美元'], ['119', 'USDHKD', '美元/港元'],
  ['100', 'UDI', '美元指数'], ['100', 'USDX', '美元指数'],
]
const fxIds = CANDIDATES.map(([mkt, code]) => `${mkt}.${code}`).join(',')
const fx = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&fields=f12,f13,f14,f2,f3&secids=${fxIds}`)
for (const row of fx?.data?.diff ?? []) {
  console.log(`  ${row.f13}.${String(row.f12).padEnd(9)} ${String(row.f14).padEnd(22)} ${row.f2}  ${row.f3}%`)
}
const missing = CANDIDATES.filter(([mkt, code]) => !(fx?.data?.diff ?? []).some((row) => `${row.f13}` === mkt && row.f12 === code))
console.log('  not found:', missing.map(([mkt, code]) => `${mkt}.${code}`).join(' ') || 'none')

// ── 3. and the FX board, in case there are more ──
console.log('\n=== the m:133 board ===')
const board = await get('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=60&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:133&fields=f12,f14,f2,f3')
for (const row of (board?.data?.diff ?? []).slice(0, 20)) console.log(`  ${String(row.f12).padEnd(10)} ${row.f14}`)
console.log('  total on the board:', board?.data?.total)

// ── 4. does a K-line work for FX? ──
const kline = await get('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=133.USDCNH&klt=101&fqt=0&lmt=3&end=20500101&fields1=f1&fields2=f51,f52,f53,f54,f55,f56')
console.log('\n  kline 133.USDCNH:', kline?.data?.name, JSON.stringify(kline?.data?.klines))