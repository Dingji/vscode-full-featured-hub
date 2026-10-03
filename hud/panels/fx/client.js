// dsh-hud › 汇率 view — browser half.
//
// A VIEW of the markets card, not a card: it is composed by `panels/markets/client.js` like 股市,
// 债市 and 期货. That distinction matters twice over — a registered panel would get a card and a
// pill of its own (the mistake this card already made once with 期货), and this view needs no host
// of its own at all: it reads `/dsh-hud/market/fx` and `/dsh-hud/market/kline`, routes the 股市
// panel has had all along.
//
// Three groups, because a rate means nothing without knowing what it is quoted AGAINST:
//
//   对人民币     — what one unit costs in yuan (and 100日元, which the board quotes that way)
//   主要货币对   — the majors, which do not involve the yuan at all
//   指数         — 美元指数, the single number a currency desk looks at first
//
// The 100日元 row is labelled as such rather than as 日元: eastmoney quotes the board in 100-yen
// lots, and a rate read as "one yen costs 4.2 yuan" is wrong by two orders of magnitude. Saying
// which unit is being priced is the whole job of a label here.

function FxRows(props) {
  const { rates, groups, selected, onSelect, zh } = props
  const byGroup = React.useMemo(() => {
    const map = new Map()
    for (const rate of rates ?? []) {
      const key = groups.includes(rate.group) ? rate.group : '其他'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(rate)
    }
    return [...map.entries()]
  }, [rates, groups])

  return jsx('div', { className: 'fx-list', children: byGroup.map(([group, rows]) => jsxs('div', {
    className: 'fx-group',
    children: [
      jsx('div', { className: 'fx-grouphead', children: group }),
      ...rows.map((rate) => {
        const up = (rate.changePct ?? 0) >= 0
        return jsxs('button', {
          type: 'button',
          className: `fx-row${rate.secid === selected ? ' is-on' : ''}${rate.index ? ' is-index' : ''}`,
          'data-secid': rate.secid,
          'data-act': 'select',
          onClick: () => onSelect(rate.secid),
          children: [
            jsx('span', { className: 'fx-name', title: rate.nameEn ?? rate.name, children: rate.name }),
            jsx('span', {
              className: 'fx-value',
              children: rate.value === undefined ? '—' : rate.value.toFixed(rate.decimals ?? 4),
            }),
            // Three periods, because one is a ticker and three are a trend. This is the standard
            // shape of a professional rate table: the daily move answers "what happened", the
            // 60-day and year-to-date answers "which way is this going", and neither is readable
            // without the other.
            jsx('span', {
              className: `fx-chg ${up ? 'is-up' : 'is-down'}`,
              children: rate.changePct === undefined ? '—' : `${up ? '+' : ''}${rate.changePct.toFixed(2)}%`,
            }),
            // NOT for the dollar index, and that is a measured decision rather than a hunch.
            //
            // `f24`/`f25` were checked against the K-line for three instruments. For the two FX
            // pairs they match to the hundredth: USDCNH -1.12% / -3.85% against a computed -1.12% /
            // -3.85%, EURUSD -1.43% / -4.21% against -1.43% / -4.21%. For 美元指数 they do not:
            // the fields read -0.10% while 60 days is +0.96% and the year is +3.72% — they merely
            // echo the daily change. A column that is right on twelve rows and wrong on the
            // thirteenth is worse than no column, so the index gets dashes and a reason.
            rate.index === true
              ? jsxs(React.Fragment, { children: [
                  jsx('span', {
                    className: 'fx-chg fx-chg-na',
                    title: zh ? '指数不提供这两个周期' : 'not available for an index',
                    children: '—',
                  }),
                  jsx('span', { className: 'fx-chg fx-chg-na', children: '—' }),
                ] })
              : jsxs(React.Fragment, { children: [
                  jsx('span', {
                    className: `fx-chg fx-chg-60 ${(rate.change60d ?? 0) >= 0 ? 'is-up' : 'is-down'}`,
                    title: zh ? '60 日' : '60 days',
                    children: rate.change60d === undefined ? '—' : `${rate.change60d >= 0 ? '+' : ''}${rate.change60d.toFixed(2)}%`,
                  }),
                  jsx('span', {
                    className: `fx-chg fx-chg-ytd ${(rate.changeYtd ?? 0) >= 0 ? 'is-up' : 'is-down'}`,
                    title: zh ? '年初至今' : 'year to date',
                    children: rate.changeYtd === undefined ? '—' : `${rate.changeYtd >= 0 ? '+' : ''}${rate.changeYtd.toFixed(2)}%`,
                  }),
                ] }),
          ],
        }, rate.secid)
      }),
    ],
  }, group)) })
}

function FxCard(props) {
  const { startTimers } = props
  const zh = hud.pickLocale() === 'zh'
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState('133.USDCNH')
  const [period, setPeriod] = React.useState('day')
  const [chart, setChart] = React.useState(null)
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const read = React.useCallback(async () => {
    try {
      const json = await hud.fetchJson('/dsh-hud/market/fx')
      if (!aliveRef.current) return
      setSnapshot(json)
      setError(null)
    } catch (failure) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  React.useEffect(() => {
    read().catch(() => {})
    // The majors and the index move around the clock on weekdays, so this view has no
    // closed-market arithmetic of its own: the host's cadence already carries it.
    const tick = () => { read().catch(() => {}) }
    if (typeof startTimers === 'function') {
      const stop = startTimers(tick, 60_000)
      return () => { if (typeof stop === 'function') stop() }
    }
    const stop = setInterval(tick, 60_000)
    return () => clearInterval(stop)
  }, [read])

  // The 股市 panel's own kline route — the same one the candlestick chart in that view uses. It
  // validates a secid with the `market.code` shape, which every FX secid here satisfies.
  React.useEffect(() => {
    let live = true
    setChart(null)
    hud.fetchJson(`/dsh-hud/market/kline?secid=${encodeURIComponent(selected)}&period=${period}`)
      .then((json) => { if (live) setChart(json) })
      .catch((failure) => { if (live) setChart({ ok: false, error: failure instanceof Error ? failure.message : String(failure) }) })
    return () => { live = false }
  }, [selected, period])

  const rates = snapshot?.rates ?? []
  const selectedRow = rates.find((one) => one.secid === selected)
  const periods = [
    { value: 'day', zh: '日K', en: 'D' },
    { value: 'week', zh: '周K', en: 'W' },
    { value: 'month', zh: '月K', en: 'M' },
  ]

  return jsxs('div', { className: 'fx-root', children: [
    jsxs('div', { className: 'fx-head', children: [
      jsx('span', { className: 'fx-title', children: zh ? '汇率' : 'FX' }),
      // Said out loud rather than implied: a currency rate is only meaningful against a named
      // base, and this board's base is the yuan (except for the majors, which say so themselves).
      jsx('span', { className: 'fx-base', children: zh ? '离岸人民币为基准' : 'base: offshore CNH' }),
      // The column headings, because three unlabelled percentages in a row are three numbers
      // nobody can tell apart — the first is today, the second is 60 days, the third is the year.
      jsxs('span', { className: 'fx-cols', children: [
        jsx('span', { children: zh ? '1日' : '1D' }),
        jsx('span', { children: zh ? '60日' : '60D' }),
        jsx('span', { children: zh ? '今年' : 'YTD' }),
      ] }),
      jsxs('span', { className: 'fx-right', children: [
        jsx('button', {
          type: 'button',
          className: 'fx-btn',
          'data-act': 'refresh',
          onClick: () => { read().catch(() => {}) },
          children: zh ? '刷新' : 'Refresh',
        }),
      ] }),
    ] }),

    error === null ? null : jsx('span', { className: 'fx-err', role: 'alert', children: error }),

    jsx(FxRows, { rates, groups: snapshot?.groups ?? [], selected, onSelect: setSelected, zh }),

    jsxs('div', { className: 'fx-detail', children: [
      jsxs('div', { className: 'fx-detailhead', children: [
        jsx('span', { className: 'fx-dname', children: selectedRow?.name ?? (zh ? '选择货币' : 'pick a pair') }),
        selectedRow === undefined ? null : jsx('span', {
          className: 'fx-dvalue',
          children: selectedRow.value.toFixed(selectedRow.decimals ?? 4),
        }),
        jsxs('span', { className: 'fx-periods', children: periods.map((one) => jsx('button', {
          type: 'button',
          className: `fx-period${one.value === period ? ' is-on' : ''}`,
          'data-period': one.value,
          onClick: () => setPeriod(one.value),
          children: zh ? one.zh : one.en,
        }, one.value)) }),
      ] }),
      chart === null
        ? jsx('div', { className: 'fx-chart is-loading', children: zh ? '读取K线…' : 'loading candles…' })
        : chart.ok === false
          ? jsx('div', { className: 'fx-chart is-err', children: chart.error })
          : jsx(CandleChart, {
              candles: chart.candles,
              height: 150,
              // The candle chart has no name of its own: the endpoint's `name` is absent for a
              // currency pair (there is no instrument name to report), so the row's label is used.
              label: `${selectedRow?.name ?? chart.secid} ${period}`,
            }),
    ] }),
  ] })
}

function createFxPanel() {
  if (document.querySelector('style[data-plugin="dsh-hud-fx"]') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud-fx'
    tag.textContent = [
      '.fx-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.fx-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.fx-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.fx-base{font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.fx-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none}',
      '.fx-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.fx-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.fx-list{display:flex;flex-direction:column;gap:4px;max-height:196px;overflow-y:auto;padding-right:2px;scrollbar-width:thin}',
      '.fx-group{display:flex;flex-direction:column;gap:1px}',
      '.fx-grouphead{font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c);padding:3px 2px 1px}',
      '.fx-row{display:grid;grid-template-columns:minmax(56px,1fr) auto auto auto auto;gap:6px;align-items:center;width:100%;padding:1px 4px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11px;line-height:16px;color:inherit;text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.fx-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
      '.fx-row.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      // The index is not a pair and is not traded: set apart rather than mixed in with the rates.
      '.fx-row.is-index .fx-name{font-weight:600}',
      '.fx-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fx-value{text-align:right;min-width:56px}',
      '.fx-chg{text-align:right;min-width:44px;font-size:10.5px}',
      '.fx-chg-60,.fx-chg-ytd{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.fx-chg-na{color:var(--dsw-alias-label-caption,#81858c)}',
      '.fx-cols{margin-left:auto;display:inline-flex;gap:6px;font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.fx-cols span{min-width:44px;text-align:right}',
      '.fx-chg.is-up{color:#d0503f}',
      '.fx-chg.is-down{color:#1f9463}',
      '.fx-detail{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.fx-detailhead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.fx-dname{font-size:11.5px;font-weight:600}',
      '.fx-dvalue{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.fx-periods{margin-left:auto;display:inline-flex;gap:3px;flex:none}',
      '.fx-period{padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.fx-period.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.fx-chart{min-height:150px}',
      '.fx-chart.is-loading,.fx-chart.is-err{font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.fx-chart.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  return {
    id: 'fx',
    // 57: after 期货 (55) and before 债市 (60) in any list that sorts panels; the TAB order is the
    // card's own list.
    order: 57,
    label: { zh: '汇率', en: 'FX' },
    span: 1,
    defaultRows: 7,
    Component: FxCard,
    __test: { FxCard, FxRows },
  }
}