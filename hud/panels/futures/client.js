// dsh-hud › 期货 panel — browser half.
//
// THE THREE THINGS THAT MAKE THIS A FUTURES VIEW RATHER THAN A STOCK LIST, all visible on screen:
//
//   1. every row is a 主连 (main-continuous) contract, so the liquid month is whoever it is today;
//   2. 持仓量 sits beside the price, because it is the number that says whether a move is new
//      money or the same money changing hands — and a stock has no such number;
//   3. the 期限结构 strip under the chart: every listed month of the selected product, which is
//      how 升水/贴水 is read. Nothing here has a stock equivalent.
//
// The chart is the shell's shared `CandleChart` — the same one the 股市 and 债市 views draw with,
// so a candle looks the same wherever it appears in this HUD.

/**
 * The contracts a filter leaves.
 *
 * Matches the short label, the name the exchange reports, the code and the secid — because `rb` is
 * what someone who trades this types and 螺纹钢 is what someone who does not. Both have to work, and
 * neither is a guess about the other.
 *
 * A hook rather than an inline `useMemo` because TWO places need the same answer: the list, and the
 * "showing 3 / 69" counter beside the box. A counter computed from a different filter than the list
 * is a counter that lies.
 */
function useFilteredContracts(contracts, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  return React.useMemo(() => {
    if (needle === '') return contracts ?? []
    return (contracts ?? []).filter((row) => [row.short, row.name, row.code, row.secid]
      .some((field) => String(field ?? '').toLowerCase().includes(needle)))
  }, [contracts, needle])
}

function FuturesRows(props) {
  const { contracts, sectors, selected, onSelect, zh, query, favorites, onStar } = props
  const starred = React.useMemo(() => new Set(favorites ?? []), [favorites])
  const shown = useFilteredContracts(contracts, query)
  // Grouped by sector in the order the host declares, and a contract whose sector is unknown
  // lands in a trailing group rather than disappearing: a row that vanishes is indistinguishable
  // from a row that was never there.
  const groups = React.useMemo(() => {
    const bySector = new Map()
    for (const row of shown) {
      const key = sectors.includes(row.sector) ? row.sector : '其他'
      if (!bySector.has(key)) bySector.set(key, [])
      bySector.get(key).push(row)
    }
    return [...bySector.entries()]
  }, [shown, sectors])

  // 收藏 goes FIRST, above the sectors: it is a statement about what matters to the reader, and
  // the sector order is a statement about the exchange. Only rendered when it has something in it —
  // an empty group with a heading is a promise the card cannot keep.
  const groupsToDraw = React.useMemo(() => {
    const starred = (contracts ?? []).filter((row) => (favorites ?? []).includes(row.secid))
    return starred.length === 0 ? groups : [['★ 收藏', starred], ...groups]
  }, [groups, contracts, favorites])

  const drawRow = (row) => {
    const up = (row.changePercent ?? 0) >= 0
    const isStarred = starred.has(row.secid)
    return jsxs('div', {
      className: `ft-line${isStarred ? ' is-starred' : ''}`,
      children: [
        jsxs('button', {
          type: 'button',
          className: `ft-row${row.secid === selected ? ' is-on' : ''}`,
          'data-secid': row.secid,
          'data-act': 'select',
          onClick: () => onSelect(row.secid),
          children: [
            jsx('span', { className: 'ft-name', title: row.name, children: row.short }),
            jsx('span', { className: 'ft-price', children: row.price === undefined ? '—' : fmt(row.price) }),
            jsx('span', {
              className: `ft-chg ${up ? 'is-up' : 'is-down'}`,
              children: row.changePercent === undefined ? '—' : `${up ? '+' : ''}${row.changePercent.toFixed(2)}%`,
            }),
            // 持仓量 and 成交量, in that order: open interest is the futures number, volume is the
            // one every market has, and leading with the ordinary one would be a stock panel
            // wearing a futures title.
            jsx('span', {
              className: 'ft-oi',
              title: zh ? '持仓量' : 'open interest',
              children: row.openInterest === undefined ? '—' : compact(row.openInterest),
            }),
            // 仓差, in its own column and coloured like the price change, because that is how it
            // reads: green/red says which way the money moved, the sign says in or out.
            jsx('span', {
              className: `ft-doi ${(row.openInterestChange ?? 0) >= 0 ? 'is-up' : 'is-down'}`,
              title: zh ? '仓差 · 持仓量较昨日的变化' : 'open-interest change',
              children: row.openInterestChange === undefined
                ? '—'
                : `${row.openInterestChange >= 0 ? '+' : ''}${compact(row.openInterestChange)}`,
            }),
            jsx('span', {
              className: 'ft-vol',
              title: zh ? '成交量' : 'volume',
              children: row.volume === undefined ? '—' : compact(row.volume),
            }),
          ],
        }, row.secid),
        jsx('button', {
          type: 'button',
          className: `ft-star${isStarred ? ' is-on' : ''}`,
          'data-act': 'star',
          'data-secid': row.secid,
          'aria-pressed': isStarred ? 'true' : 'false',
          title: isStarred ? (zh ? '取消收藏' : 'unstar') : (zh ? '收藏' : 'star'),
          // The label is the star; the state is in aria-pressed. A button whose only content is a
          // symbol says nothing to a screen reader without one of the two.
          'aria-label': `${isStarred ? (zh ? '取消收藏' : 'unstar') : (zh ? '收藏' : 'star')} ${row.short}`,
          onClick: () => onStar(row.secid, !isStarred),
          children: isStarred ? '★' : '☆',
        }),
      ],
    }, row.secid)
  }

  return jsx('div', { className: 'ft-list', children: groupsToDraw.map(([sector, rows]) => jsxs('div', {
    className: `ft-group${sector.startsWith('★') ? ' is-favorites' : ''}`,
    children: [
      jsx('div', { className: 'ft-grouphead', children: sector }),
      ...rows.map(drawRow),
    ],
  }, sector)) })
}

/**
 * 量仓关系: what the price change and the open-interest change say TOGETHER.
 *
 * Four combinations, and the two that matter most are the ones people get wrong: 增仓上涨 is new
 * money pushing the price (the trend has fuel), 减仓上涨 is shorts closing (the fuel is leaving).
 * Same direction, opposite meaning — which is the whole reason a futures panel shows 仓差 at all.
 */
function verdictOf(row, zh) {
  const up = (row?.changePercent ?? 0) >= 0
  const adding = (row?.openInterestChange ?? 0) >= 0
  if (row?.openInterestChange === undefined) return zh ? '—' : '—'
  if (up && adding) return zh ? '增仓上涨' : 'up, OI up'
  if (up && !adding) return zh ? '减仓上涨' : 'up, OI down'
  if (!up && adding) return zh ? '增仓下跌' : 'down, OI up'
  return zh ? '减仓下跌' : 'down, OI down'
}

/** A price without a fixed number of decimals: gold is 910.58 and 沪铜 is 109680. */
function fmt(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10000) return value.toFixed(0)
  if (Math.abs(value) >= 1000) return value.toFixed(1)
  return value.toFixed(2)
}

/** 1592266 → 159万 — an open interest is read for its magnitude, not its last digit. */
function compact(value) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(Math.round(value))
}

/**
 * 期限结构: the listed months of one product, front to back.
 *
 * The bar is the price relative to the front month, so the SHAPE of the curve is visible without
 * reading twelve numbers: rising to the right is 升水 (later delivery costs more), falling is
 * 贴水. The months are whatever the exchange lists, which is the point — nothing here decides
 * which months matter.
 */
function TermStructure(props) {
  const { curve, zh } = props
  if (curve === undefined || curve === null) {
    return jsx('div', { className: 'ft-curve is-loading', children: zh ? '读取月份…' : 'loading months…' })
  }
  if (curve.error !== undefined) {
    return jsx('div', { className: 'ft-curve is-err', children: curve.error })
  }
  if (curve.note !== undefined) {
    return jsx('div', { className: 'ft-curve is-note', children: curve.note })
  }
  const months = curve.months ?? []
  if (months.length === 0) {
    return jsx('div', { className: 'ft-curve is-note', children: zh ? '没有月份序列' : 'no listed months' })
  }
  const front = months[0].price
  const prices = months.map((one) => one.price).filter(Number.isFinite)
  const high = Math.max(...prices)
  const low = Math.min(...prices)
  const span = high - low || 1
  return jsxs('div', { className: 'ft-curve', children: [
    jsxs('div', { className: 'ft-curvehead', children: [
      jsx('span', { children: zh ? '期限结构' : 'term structure' }),
      // The direction is stated rather than left to the reader: 升水 and 贴水 are the two words a
      // futures desk uses, and a reader who has to infer the sign from a bar chart will not.
      jsx('span', { className: months.at(-1).price >= front ? 'is-up' : 'is-down', children: zh
        ? (months.at(-1).price >= front ? '远月升水' : '远月贴水')
        : (months.at(-1).price >= front ? 'contango' : 'backwardation') }),
    ] }),
    jsxs('div', { className: 'ft-curvebody', children: months.map((one) => jsxs('div', {
      className: 'ft-month',
      title: `${one.code}  ${fmt(one.price)}  ${one.openInterest === undefined ? '' : `持仓 ${compact(one.openInterest)}`}`,
      children: [
        jsx('span', { className: 'ft-mlabel', children: one.month }),
        jsx('span', { className: 'ft-mbar', children: jsx('span', {
          className: 'ft-mfill',
          style: { width: `${20 + 80 * ((one.price - low) / span)}%` },
        }) }),
        jsx('span', { className: 'ft-mprice', children: fmt(one.price) }),
      ],
    }, one.code)) }),
  ] })
}

function FuturesCard(props) {
  const { startTimers } = props
  // `hud` is the shell's shared toolkit and is in scope for every fragment — it is NOT a prop.
  //
  // Reading it from props is what made this card throw on its first poll:
  // `Cannot read properties of undefined (reading 'fetchJson')`. The SQL card has always called
  // `hud.fetchJson(...)` directly, and that is the convention: the shell declares the toolkit once
  // and every panel uses it. The language comes from `hud.pickLocale()` for the same reason.
  const zh = hud.pickLocale() === 'zh'
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState('')
  const [period, setPeriod] = React.useState('day')
  const [chart, setChart] = React.useState(null)
  const [curve, setCurve] = React.useState(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  /** The filter box. Component state on purpose: a search is not a preference, and it must not be
   *  still there tomorrow. Sixty-nine contracts is a list nobody reads; typing `rb` or `螺纹` is. */
  const [query, setQuery] = React.useState('')
  /**
   * The starred list, held locally for instant feedback and replaced by the server's answer.
   *
   * A star that waits for a round trip before it fills in feels broken on a slow link, and one that
   * keeps only the local answer drifts the moment two tabs are open. So: set it now, send it, and
   * take whatever comes back.
   */
  const [favorites, setFavorites] = React.useState(null)
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const read = React.useCallback(async (force = false) => {
    try {
      const json = await hud.fetchJson(`/dsh-hud/futures/${force ? 'refresh' : 'state'}`, force ? { method: 'POST' } : undefined)
      if (!aliveRef.current) return
      setSnapshot(json)
      setSelected((current) => current !== '' ? current : (json?.contracts?.[0]?.secid ?? ''))
      setError(null)
    } catch (failure) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  React.useEffect(() => {
    read(false).catch(() => {})
    const tick = () => { read(true).catch(() => {}) }
    // `startTimers` when the shell provides it: that is the timer that knows about a hidden tab,
    // and a futures card polling an exchange from a tab nobody is looking at is exactly the
    // traffic this panel spends its effort not making.
    if (typeof startTimers === 'function') {
      const stop = startTimers(tick, snapshot?.pollMs ?? 60_000)
      return () => { if (typeof stop === 'function') stop() }
    }
    const stop = setInterval(tick, snapshot?.pollMs ?? 60_000)
    return () => clearInterval(stop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, snapshot?.pollMs])

  // The chart follows the selection and the period, and both can change faster than the request
  // completes — so a late answer for the previous selection is dropped rather than drawn.
  React.useEffect(() => {
    if (selected === '') return undefined
    let live = true
    setChart(null)
    hud.fetchJson(`/dsh-hud/futures/kline?secid=${encodeURIComponent(selected)}&period=${period}`)
      .then((json) => { if (live) setChart(json) })
      .catch((failure) => { if (live) setChart({ ok: false, error: failure instanceof Error ? failure.message : String(failure) }) })
    return () => { live = false }
  }, [selected, period])

  React.useEffect(() => {
    if (selected === '') return undefined
    let live = true
    setCurve(null)
    hud.fetchJson(`/dsh-hud/futures/curve?secid=${encodeURIComponent(selected)}`)
      .then((json) => { if (live) setCurve(json) })
      .catch((failure) => { if (live) setCurve({ error: failure instanceof Error ? failure.message : String(failure) }) })
    return () => { live = false }
  }, [selected])

  // The server's list wins whenever it arrives; the local one covers the gap until then.
  React.useEffect(() => {
    if (Array.isArray(snapshot?.favorites)) setFavorites(snapshot.favorites)
  }, [snapshot?.favorites])

  const toggleStar = (secid, on) => {
    setFavorites((current) => {
      const list = current ?? []
      return on ? (list.includes(secid) ? list : [...list, secid]) : list.filter((one) => one !== secid)
    })
    hud.fetchJson('/dsh-hud/futures/favorite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secid, on }),
    }).then((json) => {
      if (Array.isArray(json?.favorites)) setFavorites(json.favorites)
    }).catch(() => {})
  }

  const contracts = snapshot?.contracts ?? []
  // The same filter the list uses, so the counter cannot disagree with what is on screen.
  const shown = useFilteredContracts(contracts, query)
  const session = snapshot?.session ?? {}
  const selectedRow = contracts.find((one) => one.secid === selected)
  const stamp = snapshot?.now === undefined ? '' : new Date(snapshot.now).toLocaleTimeString('zh-CN', { hour12: false })

  return jsxs('div', { className: 'ft-root', children: [
    jsxs('div', { className: 'ft-head', children: [
      jsx('span', { className: 'ft-title', children: zh ? '期货' : 'Futures' }),
      // The session chips name the EXCHANGE GROUPS, not the products: the night windows differ
      // per group and a chip per product would be sixty chips.
      jsxs('span', { className: 'ft-sessions', children: [
        ['cffex', '中金所'], ['metal', '金属'], ['bulk', '商品'], ['global', '外盘'],
      ].map(([key, name]) => {
        const one = session[key] ?? {}
        const why = one.closed === 'holiday' && one.closedLabel ? ` ${one.closedLabel}` : ''
        return jsx('span', {
          className: `ft-sess${one.open ? ' is-open' : ''}${one.tradingDay === false ? ' is-off' : ''}`,
          title: [name, one.time, one.night === true ? (zh ? '有夜盘' : 'night') : '', why.trim()].filter(Boolean).join(' '),
          children: `${name}${why}`,
        }, key)
      }) }),
      jsxs('span', { className: 'ft-right', children: [
        stamp === '' ? null : jsx('span', { className: 'ft-stamp', children: stamp }),
        jsx('button', {
          type: 'button',
          className: 'ft-btn',
          'data-act': 'refresh',
          onClick: () => { read(true).catch(() => {}) },
          children: zh ? '刷新' : 'Refresh',
        }),
      ] }),
    ] }),

    error === null ? null : jsx('span', { className: 'ft-err', role: 'alert', children: error }),
    // The upstream's complaint is reported instead of an empty list: "no contracts" and "the
    // endpoint refused" are different problems and must not look the same.
    snapshot?.error === undefined || snapshot.error === null
      ? null
      : jsx('span', { className: 'ft-err', children: snapshot.error }),

    // ── the filter ──
    //
    // Above the list, full width, and it filters as you type. Not a search ROUTE: the sixty-nine
    // rows are already in memory, and a round trip to narrow a list you are holding would be
    // slower than typing and would stop working the moment the network does.
    jsxs('label', { className: 'ft-filter', children: [
      jsx('span', { className: 'ft-filter-icon', 'aria-hidden': true, children: '⌕' }),
      jsx('input', {
        type: 'search',
        className: 'ft-filter-input',
        value: query,
        spellCheck: false,
        'data-act': 'filter',
        placeholder: zh ? '搜索合约：螺纹钢 / rb / 沪深' : 'filter: 螺纹钢 / rb / 沪深',
        'aria-label': zh ? '搜索期货合约' : 'filter contracts',
        onChange: (event) => setQuery(event.target.value),
      }),
      query === ''
        ? null
        : jsx('span', {
            className: 'ft-filter-count',
            children: `${shown.length} / ${contracts.length}`,
          }),
    ] }),

    jsx(FuturesRows, {
      contracts,
      sectors: snapshot?.sectors ?? [],
      selected,
      onSelect: setSelected,
      zh,
      query,
      favorites: favorites ?? snapshot?.favorites ?? [],
      onStar: toggleStar,
    }),

    jsxs('div', { className: 'ft-detail', children: [
      jsxs('div', { className: 'ft-detailhead', children: [
        jsx('span', { className: 'ft-dname', children: selectedRow?.name ?? (zh ? '选择合约' : 'pick a contract') }),
        selectedRow?.openInterest === undefined ? null : jsxs('span', { className: 'ft-dmeta', children: [
          jsx('span', { children: `${zh ? '持仓' : 'OI'} ${compact(selectedRow.openInterest)}` }),
          jsx('span', { children: `${zh ? '成交' : 'vol'} ${compact(selectedRow.volume)}` }),
          // 量仓关系 — the four-way reading, said in words.
          //
          // Open interest alone says how many contracts are open; the CHANGE says whether a move is
          // new money or the same money changing hands. 增仓上涨 is the strong one (new longs are
          // paying up), 减仓上涨 is the weak one (shorts covering), and the two falling readings
          // differ the same way. A trader reads this before the price.
          jsx('span', {
            className: 'ft-verdict',
            title: zh ? '量仓关系' : 'price vs open interest',
            children: verdictOf(selectedRow, zh),
          }),
        ] }),
        jsxs('span', { className: 'ft-periods', children: (snapshot?.periods ?? []).map((one) => jsx('button', {
          type: 'button',
          className: `ft-period${one.value === period ? ' is-on' : ''}`,
          'data-period': one.value,
          onClick: () => setPeriod(one.value),
          children: zh ? one.label : one.labelEn,
        }, one.value)) }),
      ] }),
      chart === null
        ? jsx('div', { className: 'ft-chart is-loading', children: zh ? '读取K线…' : 'loading candles…' })
        : chart.ok === false
          ? jsx('div', { className: 'ft-chart is-err', children: chart.error })
          : jsx(CandleChart, {
              candles: chart.candles,
              height: 168,
              label: zh ? `${chart.name} ${chart.period}` : `${chart.name} ${chart.period}`,
            }),
      jsx(TermStructure, { curve, zh }),
    ] }),
  ] })
}

function createFuturesPanel() {
  if (document.querySelector('style[data-plugin="dsh-hud-futures"]') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud-futures'
    tag.textContent = [
      '.ft-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.ft-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.ft-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ft-sessions{display:inline-flex;align-items:center;gap:5px}',
      '.ft-sess{padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-sess.is-open{border-color:rgba(34,160,107,.4);color:#1a7f52;background:rgba(34,160,107,.08)}',
      '.ft-sess.is-off{text-decoration:line-through;opacity:.75}',
      '.ft-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.ft-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      // The filter box: full width, above the list, small enough not to cost a row.
      '.ft-filter{display:flex;align-items:center;gap:5px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.ft-filter-icon{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-filter-input{flex:1 1 auto;min-width:0;height:22px;border:0;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:inherit;outline:none}',
      '.ft-filter-count{flex:none;font-size:10px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.ft-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // The list scrolls INSIDE its own box: this card is a grid cell, and a list that grew with
      // its contents would push the chart out of the cell it was measured for.
      '.ft-list{display:flex;flex-direction:column;gap:4px;max-height:190px;overflow-y:auto;padding-right:2px;scrollbar-width:thin}',
      // A row is two sibling buttons, not a button inside a button: the browser silently
      // repairs nested buttons, which is how a control ends up existing and not working.
      '.ft-line{display:grid;grid-template-columns:1fr auto;gap:2px;align-items:center;border-radius:5px}',
      '.ft-line.is-starred{background:rgba(217,161,59,.09)}',
      '.ft-star{flex:none;padding:0 5px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer}',
      '.ft-star:hover{color:#d9a13b}',
      '.ft-star.is-on{color:#d9a13b}',
      '.ft-group.is-favorites .ft-grouphead{color:#d9a13b}',
      '.ft-group{display:flex;flex-direction:column;gap:1px}',
      '.ft-grouphead{font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c);padding:3px 2px 1px}',
      '.ft-row{display:grid;grid-template-columns:minmax(46px,1fr) minmax(50px,.85fr) minmax(44px,.75fr) minmax(42px,.7fr) minmax(44px,.75fr) minmax(46px,.8fr);gap:5px;align-items:center;width:100%;padding:1px 4px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11px;line-height:16px;color:inherit;text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.ft-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
      '.ft-row.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.ft-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ft-price,.ft-oi,.ft-vol,.ft-chg{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ft-oi,.ft-vol{color:var(--dsw-alias-label-caption,#81858c);font-size:10.5px}',
      '.ft-doi{text-align:right;font-size:10.5px}',
      '.ft-doi.is-up{color:#d0503f}',
      '.ft-doi.is-down{color:#1f9463}',
      '.ft-doi-spacer{display:none}',
      // 红涨绿跌 — the domestic convention, the same pair the shell's chart uses.
      '.ft-chg.is-up{color:#d0503f}',
      '.ft-chg.is-down{color:#1f9463}',
      '.ft-detail{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.ft-detailhead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.ft-dname{font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ft-dmeta{display:inline-flex;gap:7px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.ft-periods{margin-left:auto;display:inline-flex;gap:3px;flex:none}',
      '.ft-period{padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.ft-period.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.ft-chart{min-height:168px}',
      '.ft-chart.is-loading,.ft-chart.is-err,.ft-curve.is-loading,.ft-curve.is-err,.ft-curve.is-note{font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-chart.is-err,.ft-curve.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.ft-curve{display:flex;flex-direction:column;gap:3px}',
      '.ft-curvehead{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-curvehead .is-up{color:#d0503f}',
      '.ft-curvehead .is-down{color:#1f9463}',
      '.ft-curvebody{display:flex;flex-direction:column;gap:1px}',
      '.ft-month{display:grid;grid-template-columns:38px 1fr auto;gap:6px;align-items:center;font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums}',
      '.ft-mlabel{color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-mbar{display:block;height:7px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));overflow:hidden}',
      '.ft-mfill{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#3964fe,#7aa2ff)}',
      '.ft-mprice{color:var(--dsw-alias-label-secondary,#61666b)}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  return {
    id: 'futures',
    order: 55,
    label: { zh: '期货', en: 'Futures' },
    // One column, like the other two views of this card.
    span: 1,
    // OFF by default: the markets card ships as 股市, and 期货 is a tab away. The card's own
    // switch mounts all three views, so this only decides which one is in front.
    defaultOn: false,
    defaultRows: 8,
    Component: FuturesCard,
    __test: { FuturesCard, FuturesRows, TermStructure, fmt, compact },
  }
}