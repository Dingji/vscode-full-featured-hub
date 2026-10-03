// Verify every 主连 candidate in ONE request. The list ships only what this proves exists: a
// wrong code returns an empty row, which is how a panel looks fine while showing nothing.
const CANDIDATES = [
  // 中金所 — 股指与国债
  ['220', 'IFM', '沪深300'], ['220', 'IHM', '上证50'], ['220', 'ICM', '中证500'], ['220', 'IM0', '中证1000'],
  ['220', 'TSM', '二债'], ['220', 'TFM', '五债'], ['220', 'TM', '十债'], ['220', 'TLM', '三十债'],
  // 上期所 — 贵金属与有色
  ['113', 'aum', '沪金'], ['113', 'agm', '沪银'], ['113', 'cum', '沪铜'], ['113', 'alm', '沪铝'],
  ['113', 'znm', '沪锌'], ['113', 'pbm', '沪铅'], ['113', 'nim', '沪镍'], ['113', 'snm', '沪锡'],
  ['113', 'aom', '氧化铝'], ['113', 'brm', '丁二烯'],
  // 上期所 / 大商所 — 黑色
  ['113', 'rbm', '螺纹钢'], ['113', 'hcm', '热卷'], ['113', 'ssm', '不锈钢'],
  ['114', 'im', '铁矿石'], ['114', 'jm', '焦炭'], ['114', 'jmm', '焦煤'], ['114', 'sm', '锰硅'], ['114', 'sfm', '硅铁'],
  // 能源化工
  ['113', 'rum', '橡胶'], ['113', 'fum', '燃油'], ['113', 'bum', '沥青'], ['113', 'spm', '纸浆'],
  ['114', 'lm', '塑料'], ['114', 'vm', 'PVC'], ['114', 'ppm', '聚丙烯'], ['114', 'egm', '乙二醇'],
  ['114', 'ebm', '苯乙烯'], ['115', 'MAM', '甲醇'], ['115', 'TAM', 'PTA'], ['115', 'SAM', '纯碱'],
  ['115', 'FGM', '玻璃'], ['115', 'URM', '尿素'], ['115', 'PFM', '短纤'], ['115', 'SHM', '烧碱'],
  // 农产品
  ['114', 'am', '豆一'], ['114', 'mm', '豆粕'], ['114', 'ym', '豆油'], ['114', 'pm', '棕榈油'],
  ['114', 'cm', '玉米'], ['114', 'csm', '淀粉'], ['114', 'jdm', '鸡蛋'], ['114', 'lhm', '生猪'],
  ['115', 'CFM', '棉花'], ['115', 'SRM', '白糖'], ['115', 'OIM', '菜油'], ['115', 'RMM', '菜粕'],
  ['115', 'APM', '苹果'], ['115', 'CJM', '红枣'], ['115', 'PKM', '花生'],
  // 新能源
  ['225', 'sim', '工业硅'], ['225', 'lcm', '碳酸锂'], ['225', 'psm', '多晶硅'],
  // 外盘
  ['102', 'CL00Y', 'NYMEX原油'], ['101', 'GC00Y', 'COMEX黄金'], ['101', 'SI00Y', 'COMEX白银'],
  ['101', 'HG00Y', 'COMEX铜'], ['112', 'B00Y', '布伦特原油'], ['103', 'ZM00Y', 'CBOT豆粕'],
  ['103', 'ZC00Y', 'CBOT玉米'], ['103', 'ZS00Y', 'CBOT大豆'], ['103', 'ZW00Y', 'CBOT小麦'],
]

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } })
  return res.json()
}

const secids = CANDIDATES.map(([mkt, code]) => `${mkt}.${code}`).join(',')
const fields = 'f2,f3,f4,f5,f6,f12,f13,f14,f108'
const json = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&secids=${secids}&fields=${fields}`)
const found = new Map()
for (const row of json?.data?.diff ?? []) {
  found.set(`${row.f13}.${row.f12}`, row)
}

const ok = []
const missing = []
for (const [mkt, code, zh] of CANDIDATES) {
  const row = found.get(`${Number(mkt)}.${code}`)
  if (row === undefined || typeof row.f2 !== 'number') { missing.push(`${mkt}.${code} ${zh}`); continue }
  ok.push({ secid: `${mkt}.${code}`, name: row.f14, price: row.f2, chg: row.f3, oi: row.f108, vol: row.f5 })
}

console.log(`VERIFIED ${ok.length} / ${CANDIDATES.length}\n`)
const bySector = {}
for (const one of ok) {
  const [mkt, code] = one.secid.split('.')
  const sector = mkt === '220' ? '股指国债' : mkt === '225' ? '新能源'
    : ['101', '102', '103', '112'].includes(mkt) ? '外盘' : 'domestic'
  ;(bySector[sector] ??= []).push(one)
}
for (const [sector, rows] of Object.entries(bySector)) {
  console.log(`--- ${sector} ---`)
  for (const one of rows) {
    console.log(`  '${one.secid}',`.padEnd(16) + `// ${one.name}  ${one.price}  oi=${one.oi}`)
  }
}
console.log('\nMISSING (must not ship):', missing.length === 0 ? 'none' : missing.join(' | '))