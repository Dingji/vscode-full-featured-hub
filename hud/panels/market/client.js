// dsh-hud › market panel — browser half.
//
// FRAGMENT CONTRACT: concatenated into the single `client.js` bundle by
// `tools/build-client.mjs`, inside the same factory scope as the shell. No
// top-level `import` / `export` / `return`; `React`, `jsx`, `jsxs` and `hud`
// come from the bundle scope.
//
// The chart is hand-written SVG — the same approach as the quota panel's usage
// chart, because the platform module table only carries react, and a charting
// library is not going to be added for one panel. Three details make it read
// like a real terminal chart rather than a sketch:
//
//   - candle BODIES are fills and every STROKE carries
//     `vector-effect="non-scaling-stroke"`. The SVG stretches to the card width
//     (`preserveAspectRatio="none"`), which distorts anything stroked; fills
//     stretch as a unit and stay correct.
//   - all TEXT lives in HTML positioned by percentage, outside the SVG, so
//     labels never inherit the stretch.
//   - it follows the domestic convention: 红涨绿跌.
//
// The candlestick chart itself lives in the SHELL (`hud.CandleChart`), because
// the bond panel draws K-lines too. This panel only frames it and supplies what
// is specific to shares: the day/week/month periods and the price formatting.
const MK_FALLBACK_MS = 30_000
const MK_MIN_MS = 10_000
const MK_MAX_MS = 60 * 60_000
// Five rows: enough to see the watch list move, few enough that the card stays
// short. The rest are still polled and counted, just not drawn (the note below
// says how many are hidden).
const MK_VISIBLE_ROWS = 5

function createMarketPanel() {
  const CSS_ID = 'dsh-hud/market.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.mk-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      // The rate row: dense, aligned on the decimal point, and never wrapped per rate.
      '.mk-fx{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;padding-top:7px;border-top:1px solid var(--hud-line,rgba(0,0,0,.08));font-variant-numeric:tabular-nums}',
      '.mk-fx-label{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-fx-item{display:inline-flex;align-items:baseline;gap:4px;font-size:11px;line-height:16px}',
      '.mk-fx-code{color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px}',
      '.mk-fx-value{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',
      '.mk-fx-chg{font-size:10.5px}',
      '.mk-fx-inv{padding:0 4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));font-size:9px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;flex-wrap:wrap}',
      '.mk-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-sessions{display:inline-flex;align-items:center;gap:5px}',
      '.mk-sess{padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-sess.is-open{border-color:rgba(34,160,107,.4);color:#1a7f52;background:rgba(34,160,107,.08)}',
      // A market that is not trading TODAY is a different state from one that is merely between
      // sessions: struck through, because the whole day is off rather than the next hour.
      '.mk-sess.is-off{text-decoration:line-through;opacity:.75}',
      '.mk-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.mk-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.mk-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.mk-btn:disabled{opacity:.55;cursor:default}',
      '.mk-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
      // The word beside the ＋ only when there is room for it: the head row already carries the
      // title, three session chips and 刷新, and a fourth label wraps the whole row on a narrow
      // card. The ＋ and the tooltip carry the meaning at that size.
      '.mk-add-wide{display:inline}',
      '@container (max-width:420px){.mk-add-wide{display:none}}',
      '.mk-btn.is-on{background:rgba(57,100,254,.10);border-color:rgba(57,100,254,.35);font-weight:600}',
      // ── watch list ────────────────────────────────────────────────────────
      '.mk-watch{display:flex;flex-direction:column;gap:1px}',
    // The shared chart brings its own layout; the panel only frames it.
    '.mk-chart{width:100%;box-sizing:border-box;padding:5px 7px 3px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}',
      '.mk-wrow{display:flex;align-items:center;gap:7px;width:100%;padding:4px 7px;border:1px solid transparent;border-radius:7px;background:transparent;font-family:inherit;text-align:left;cursor:pointer}',
      '.mk-wrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
      '.mk-wrow.is-sel{border-color:rgba(57,100,254,.30);background:rgba(57,100,254,.07)}',
      '.mk-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-code{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.mk-px{margin-left:auto;flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-chg{flex:none;width:62px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums}',
      '.mk-up{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      // The view switch and the ranking table. Same type scale as the watch rows, so the two
      // lists read as the same card.
      '.mk-views{display:inline-flex;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;overflow:hidden;margin-right:2px}',
      '.mk-view{padding:0 8px;border:0;background:transparent;font-family:inherit;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap}',
      '.mk-view.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.mk-rank{display:flex;flex-direction:column;gap:0}',
      '.mk-rhead,.mk-rrow{display:grid;grid-template-columns:18px minmax(0,1fr) 60px 62px 62px 62px 20px;align-items:center;gap:4px;padding:1px 2px}',
      '.mk-rhead{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c);border-bottom:1px solid var(--hud-line,rgba(0,0,0,.08))}',
      '.mk-rrow{font-size:11.5px;line-height:17px;border-radius:5px}',
      '.mk-rrow:nth-child(odd){background:var(--hud-tile,rgba(0,0,0,.02))}',
      '.mk-rno{font-variant-numeric:tabular-nums;font-size:10px;color:var(--dsw-alias-label-caption,#81858c);text-align:right}',
      '.mk-rrow .mk-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mk-ramt{font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b);text-align:right}',
      '.mk-radd{padding:0 4px;font-size:11px;line-height:15px}',
      '.mk-rnote{display:flex;flex-wrap:wrap;gap:8px;padding-top:4px;font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      // The hover chart: fixed to the viewport, never in the way, above everything.
      '.mk-hover{position:fixed;z-index:40;width:300px;padding:5px 6px 2px;border:1px solid var(--hud-line,rgba(0,0,0,.14));border-radius:9px;background:var(--hud-card-bg,#fff);box-shadow:0 6px 22px rgba(0,0,0,.16);pointer-events:none}',
      '.mk-hover-head{display:flex;align-items:center;gap:6px;padding-bottom:2px}',
      '.mk-hover-name{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mk-hover-wait{height:104px;display:flex;align-items:center;justify-content:center;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-rrow.is-hover{background:rgba(57,100,254,.10)}',
      '.mk-rrow{cursor:pointer}',
      // The pinned chart: the card's own chart slot, used the way the watch view uses it.
      '.mk-pin{display:flex;flex-direction:column;gap:4px;padding:5px 6px 2px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:9px;background:var(--hud-tile,rgba(0,0,0,.02))}',
      '.mk-pin-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.mk-pin-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-pin-px{font-size:12px;font-variant-numeric:tabular-nums}',
      '.mk-pin-space{flex:1 1 auto}',
      '.mk-pin-facts{display:flex;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.mk-pin-wait{height:220px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-rrow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-2px}',
      '.mk-down{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.mk-x{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-caption,#81858c);font-family:inherit;font-size:12px;line-height:14px;cursor:pointer;padding:0 2px}',
      '.mk-x:hover{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // ── chart ─────────────────────────────────────────────────────────────
      '.mk-chart{position:relative;width:100%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));padding:6px 8px 4px}',
      // ── add / search ──────────────────────────────────────────────────────
      '.mk-add{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
      '.mk-input{box-sizing:border-box;width:100%;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px;line-height:16px}',
      '.mk-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
      '.mk-hits{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow-y:auto}',
      '.mk-hit{display:flex;align-items:center;gap:7px;padding:3px 7px;border:1px solid transparent;border-radius:6px;background:transparent;font-family:inherit;text-align:left;cursor:pointer;font-size:11.5px}',
      '.mk-hit:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
      '.mk-hit .mk-code{margin-left:auto}',
      '.mk-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.mk-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.mk-empty{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b)}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num

  const pct = (value) => (num(value) === undefined ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)
  const toneOf = (value) => (num(value) === undefined || value === 0 ? '' : value > 0 ? 'mk-up' : 'mk-down')
  const price = (value) => (num(value) === undefined ? '--' : value.toFixed(value >= 1000 ? 2 : value >= 10 ? 2 : 3))

/**
 * ── 今日涨跌榜 ───────────────────────────────────────────────────────────────
 *
 * Three views on one card: 自选 (what it always showed), 涨幅榜 and 跌幅榜. The ranking is a
 * different upstream call from the quotes — eastmoney's own screen, sorted by 涨跌幅 — and it
 * is read here rather than in a card of its own because it is the same subject, from the same
 * host, on the same cadence.
 *
 * What the rows say, and what they deliberately do not:
 *   • the day's move, the price, and 成交额 — a percentage with no money behind it is a story;
 *   • the 沪京深 session state, because a ranking on a non-trading day is the LAST trading
 *     day's, and a list that does not say so looks like live data on a holiday;
 *   • how many rows the host dropped (新股 and 退市整理: real moves, not the market's).
 *     A list that silently hides rows is a list nobody can check.
 */
const RANK_VIEWS = [
  { id: 'watch', zh: '自选', en: 'Watch' },
  { id: 'up', zh: '涨幅榜', en: 'Gainers' },
  { id: 'down', zh: '跌幅榜', en: 'Losers' },
]

/** 成交额 in the units a person reads: 亿 / 万, and nothing at all when it is unknown. */
const money = (value) => (num(value) === undefined
  ? '--'
  : value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿`
    : value >= 1e4 ? `${(value / 1e4).toFixed(0)}万`
      : String(Math.round(value)))

/** One ranking: 20 rows, the day's move, and the one action that makes them useful. */
function RankTable(props) {
  const { zh, half, session, busy, error, onPick, hover, hoverChart, pinned, pinnedChart, pinnedBusy } = props
  const rows = Array.isArray(half?.rows) ? half.rows : []
  if (error !== undefined && error !== null && rows.length === 0) {
    return jsx('div', { className: 'mk-msg is-err', 'data-act': 'rank-error', children: error })
  }
  if (rows.length === 0) {
    return jsx('div', { className: 'mk-empty', children: busy === true
      ? (zh ? '读取榜单…' : 'loading…')
      : (zh ? '没有拿到榜单数据' : 'no ranking data') })
  }
  return jsxs('div', { className: 'mk-rank', 'data-act': 'rank-table', children: [
    jsxs('div', { className: 'mk-rhead', children: [
      jsx('span', { className: 'mk-rno', children: '#' }),
      jsx('span', { className: 'mk-name', children: zh ? '名称' : 'NAME' }),
      jsx('span', { className: 'mk-code', children: zh ? '代码' : 'CODE' }),
      jsx('span', { className: 'mk-px', children: zh ? '最新' : 'LAST' }),
      jsx('span', { className: 'mk-chg', children: zh ? '涨跌幅' : 'CHG' }),
      jsx('span', { className: 'mk-ramt', children: zh ? '成交额' : 'AMOUNT' }),
      jsx('span', { className: 'mk-radd' }),
    ] }),
    ...rows.map((row, index) => jsxs('div', {
      className: `mk-rrow${hover?.secid === row.secid ? ' is-hover' : ''}`,
      'data-secid': row.secid,
      // The handlers live on the ROW, not on a wrapper: the row is what the pointer is on.
      // A click PINS this row's chart: a hover is a glance, a click says "this one".
      onClick: () => props.onPin?.(row),
      onMouseEnter: (event) => props.onHover?.(row, event.currentTarget),
      onMouseLeave: () => props.onLeave?.(),
      // Keyboard users get the same chart: focus is a hover that does not need a mouse.
      onFocus: (event) => props.onHover?.(row, event.currentTarget),
      onBlur: () => props.onLeave?.(),
      tabIndex: 0,
      children: [
        jsx('span', { className: 'mk-rno', children: String(index + 1) }),
        jsx('span', { className: 'mk-name', title: row.name, children: row.name }),
        jsx('span', { className: 'mk-code', children: row.code }),
        jsx('span', { className: 'mk-px', children: price(row.price) }),
        jsx('span', { className: `mk-chg ${toneOf(row.changePct)}`, children: pct(row.changePct) }),
        jsx('span', { className: 'mk-ramt', children: money(row.amount) }),
        /**
         * ONE action, and it is add-then-select: the host's `add` already selects what it
         * added, so this single click is what puts the stock on the card with its K-line —
         * which is the only reason to look at a ranking row twice.
         */
        jsx('button', {
          type: 'button',
          className: 'mk-btn is-quiet mk-radd',
          'data-act': 'rank-add',
          'data-secid': row.secid,
          title: zh ? '加入自选并看它的 K 线' : 'add to the watch list',
          onClick: () => onPick(row),
          children: '＋',
        }),
      ],
    }, row.secid)),
    /**
     * The hover chart, drawn where the row is.
     *
     * Deliberately NOT interactive: `pointer-events: none` means the pointer never enters it, so
     * the row underneath cannot flicker between entered and left — which is how this feature
     * usually ends up unusable. Whatever needs clicking is on the row.
     */
    hover === null || hover === undefined
      ? null
      : jsxs('div', {
          className: 'mk-hover',
          'data-act': 'rank-hover',
          'data-secid': hover.secid,
          style: { left: `${hover.left}px`, top: `${hover.top}px` },
          children: [
            jsxs('div', { className: 'mk-hover-head', children: [
              jsx('span', { className: 'mk-hover-name', children: hover.name }),
              jsx('span', { className: 'mk-code', children: hover.code }),
              jsx('span', { className: 'mk-note', children: zh ? '当日分时' : 'today' }),
            ] }),
            hoverChart === null
              ? jsx('div', { className: 'mk-hover-wait', 'data-act': 'rank-hover-wait', children: zh ? '读取中…' : 'loading…' })
              : jsx(hud.CandleChart, {
                  lang: zh ? 'zh' : 'en',
                  candles: hoverChart,
                  height: 104,
                  ariaLabel: zh ? `${hover.name} 当日分时` : `${hover.name} today`,
                  empty: zh ? '今天没有分时数据' : 'no intraday data',
                }),
          ],
        }),
/**
     * The pinned chart, in the slot the watch view uses for its own K-line.
     *
     * Full width and 220px tall: the chart draws its crosshair readout inside its own box, so a
     * chart too small to hover is a chart with no numbers in it — which is precisely what the
     * first version of this was.
     */
    pinned === null || pinned === undefined
      ? null
      : jsxs('div', { className: 'mk-pin', 'data-act': 'rank-pin', 'data-secid': pinned.secid, children: [
          jsxs('div', { className: 'mk-pin-head', children: [
            jsx('span', { className: 'mk-pin-name', children: pinned.name }),
            jsx('span', { className: 'mk-code', children: pinned.code }),
            jsx('span', { className: `mk-pin-px ${toneOf(pinned.changePct)}`, children: price(pinned.price) }),
            jsx('span', { className: `mk-chg ${toneOf(pinned.changePct)}`, children: pct(pinned.changePct) }),
            jsx('span', { className: 'mk-pin-space' }),
            // The day's shape in words, because that is what the candles are saying and reading
            // it off a chart is work: 最高/最低/成交额 come from the ranking row already in hand.
            jsxs('span', { className: 'mk-pin-facts', children: [
              jsx('span', { children: `${zh ? '最高' : 'H'} ${price(pinned.high)}` }),
              jsx('span', { children: `${zh ? '最低' : 'L'} ${price(pinned.low)}` }),
              jsx('span', { children: `${zh ? '成交额' : 'AMT'} ${money(pinned.amount)}` }),
              jsx('span', { children: zh ? '当日分时' : 'today' }),
            ] }),
            jsx('button', {
              type: 'button',
              className: 'mk-btn is-quiet',
              'data-act': 'rank-pin-close',
              title: zh ? '关闭（切换页签也会关闭）' : 'close',
              onClick: () => props.onUnpin?.(),
              children: zh ? '关闭' : 'close',
            }),
          ] }),
          pinned.error !== undefined && pinned.error !== null
            ? jsx('div', { className: 'mk-msg is-err', children: pinned.error })
            : null,
          pinnedChart === null
            ? jsx('div', { className: 'mk-pin-wait', 'data-act': 'rank-pin-wait', children: pinnedBusy === true
              ? (zh ? '读取当日分时…' : 'loading…')
              : (zh ? '没有拿到分时数据' : 'no intraday data') })
            : jsx(hud.CandleChart, {
                lang: zh ? 'zh' : 'en',
                candles: pinnedChart,
                height: 220,
                ariaLabel: zh ? `${pinned.name} 当日分时` : `${pinned.name} today`,
                empty: zh ? '今天没有分时数据' : 'no intraday data',
              }),
        ]}),
    jsxs('div', { className: 'mk-rnote', children: [
      // jsxs, not jsx: an array of children needs keys, and the checker (and React) say so.
      jsxs('span', { children: [
        session?.open === true
          ? (zh ? '沪深京 交易中' : 'CN session open')
          : session?.tradingDay === true
            ? (zh ? '沪深京 休市中（当日数据）' : 'CN closed (today)')
            : (zh ? '沪深京 非交易日 —— 这是最近一个交易日的榜单' : 'CN non-trading day — last session'),
      ] }),
      num(half?.filtered) > 0
        ? jsx('span', { title: zh ? '新股与退市整理股的涨跌幅不是市场的涨跌幅' : 'new listings and delistings are not the market', children: zh
          ? `已滤掉 ${half.filtered} 只新股/退市`
          : `${half.filtered} filtered` })
        : null,
      num(half?.total) > 0
        ? jsx('span', { children: zh ? `全市场 ${half.total} 只` : `${half.total} listed` })
        : null,
    ] }),
  ] })
}

/**
 * ── hovering a ranking row ───────────────────────────────────────────────────
 *
 * The ranking answers "what moved today" and then stops: the next question is always "what did
 * it LOOK like", which the list cannot answer and the selected instrument's chart answers only
 * for one stock at a time. So a row, on hover, shows its own intraday candles.
 *
 * Three decisions that are the whole feature:
 *
 * 1. **Debounced.** Sweeping the mouse down twenty rows must not be twenty upstream calls.
 *    Hovering waits {@link HOVER_DELAY_MS}, and only the row the pointer SETTLES on is asked
 *    for. This endpoint is a real request per secid; a hover that fires per row is a hover that
 *    gets the card rate-limited.
 * 2. **Cached, and not forever.** The candles for a secid are kept in memory for as long as the
 *    card is on screen (bounded), so going back over a row is instant — but the cache is the
 *    CLIENT's, with the same one-minute life the host gives an intraday chart. Two caches with
 *    different lifetimes would disagree in a way nobody could explain.
 * 3. **It never takes the mouse.** The popover is `pointer-events: none`: a tooltip that
 *    captures the pointer makes the row underneath flicker between entered and left, which is
 *    the classic way this feature is ruined.
 */
const HOVER_DELAY_MS = 160
const HOVER_CACHE_MS = 60_000
const HOVER_CACHE_MAX = 40

/** Where to put a popover so it is always fully on screen, next to the row it belongs to. */
function hoverPosition(rect, width, height) {
  const margin = 8
  const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1280
  const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 720
  // To the RIGHT of the row when there is room, because the row's own numbers are on the left.
  let left = rect.right + margin
  if (left + width > viewportWidth - margin) left = rect.left - width - margin
  if (left < margin) left = Math.max(margin, viewportWidth - width - margin)
  let top = rect.top - 6
  if (top + height > viewportHeight - margin) top = viewportHeight - height - margin
  if (top < margin) top = margin
  return { left: Math.round(left), top: Math.round(top) }
}
  /** The card: watch list + the selected instrument's K-line. */
  function MarketCard(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [kline, setKline] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [adding, setAdding] = React.useState(false)
    const [query, setQuery] = React.useState('')
    const [hits, setHits] = React.useState([])
    const [addMsg, setAddMsg] = React.useState(null)
    /**
     * Which of the three views is on screen, and the ranking behind it.
     *
     * `view` is client state, not settings: it is where the eye is, not a preference — and a
     * card that reopens on the ranking because that is where it was left is a card that
     * hides the watch list on every reload.
     */
    const [view, setView] = React.useState('watch')
    const [rank, setRank] = React.useState(null)
    const [rankError, setRankError] = React.useState(null)
    const [rankBusy, setRankBusy] = React.useState(false)
/**
     * The hover chart: which row the pointer is on, where it is on screen, and the candles.
     *
     * `hover` is the row and its position; `hoverChart` is what came back for it. Kept apart
     * because the popover must appear IMMEDIATELY (with 读取中…) — a tooltip that only shows up
     * after the network answers feels broken for exactly as long as the request takes.
     */
    const [hover, setHover] = React.useState(null)
    const [hoverChart, setHoverChart] = React.useState(null)
/**
     * The PINNED chart: what a click on a row produces.
     *
     * A hover preview is a glance — small, floating, gone the moment the pointer moves. Clicking
     * says "I want to look at THIS", and the two are different enough to be different states:
     * the pinned chart goes in the slot the card already uses for its K-line (full width, tall
     * enough for the chart's own crosshair readout to be legible), carries the day's numbers in
     * its header, and stays until it is closed or the view changes.
     */
    const [pinned, setPinned] = React.useState(null)
    const [pinnedChart, setPinnedChart] = React.useState(null)
    const [pinnedBusy, setPinnedBusy] = React.useState(false)
    const aliveRef = React.useRef(true)
    /** secid → { at, candles }: the client's own minute, matching the host's intraday cache. */
    const hoverCache = React.useRef(new Map())
    const hoverTimer = React.useRef(null)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/market/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    // The host decides the cadence (it knows which sessions are open), except
    // that a 0/undefined value must never arm a hot loop.
    /**
     * The ranking is fetched only while it is being LOOKED at.
     *
     * The quote poll runs whatever the view is, because the head needs the session state —
     * but a ranking nobody has opened is a request nobody asked for, and this endpoint is a
     * screen over 5900 stocks, not a handful of secids.
     */
    const readRank = React.useCallback(() => {
      setRankBusy(true)
      return hud.fetchJson('/dsh-hud/market/rank').then((json) => {
        if (!aliveRef.current) return
        setRank(json)
        setRankError(null)
      }, (failure) => {
        if (aliveRef.current) setRankError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => {
        if (aliveRef.current) setRankBusy(false)
      })
    }, [])

/**
     * Point at a row; after a moment, ask for its intraday candles.
     *
     * Both halves matter: the popover opens on the hover itself, and the REQUEST only happens
     * once the pointer has settled — sweeping the list is not a reason to call upstream twenty
     * times, and the row a person stops on is the row they meant.
     */
    /** Read inside the hover callback, which must not be re-created on every pin. */
    const pinnedRef = React.useRef(null)
    React.useEffect(() => { pinnedRef.current = pinned }, [pinned])

    const showHover = React.useCallback((row, element) => {
      if (element === null || element === undefined) return
      const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
      if (rect === null) return
      // Measured at the moment of the hover rather than on every render: the layout is known
      // here, and a rect captured earlier is stale as soon as anything scrolls.
      // While a chart is PINNED, hovering does not open previews: the pinned chart is what the
      // person is looking at, and a second floating one on top of it is noise.
      if (pinnedRef.current !== null) return
      const place = hoverPosition(rect, 300, 168)
      setHover({ secid: row.secid, name: row.name, code: row.code, ...place })
      setHoverChart(hoverCache.current.get(row.secid)?.candles ?? null)
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => {
        const hit = hoverCache.current.get(row.secid)
        if (hit !== undefined && Date.now() - hit.at < HOVER_CACHE_MS) return
        hud.fetchJson(`/dsh-hud/market/kline?secid=${encodeURIComponent(row.secid)}&period=realtime`)
          .then((json) => {
            const candles = Array.isArray(json?.candles) ? json.candles : []
            hoverCache.current.set(row.secid, { at: Date.now(), candles })
            // Bounded: a card that keeps every candle of every row it ever hovered grows all day.
            if (hoverCache.current.size > HOVER_CACHE_MAX) {
              const oldest = [...hoverCache.current.entries()].sort((a, b) => a[1].at - b[1].at)[0]
              if (oldest !== undefined) hoverCache.current.delete(oldest[0])
            }
            if (!aliveRef.current) return
            // Only if the pointer is STILL on that row: an answer that arrives after the mouse
            // has moved on must not paint itself over the row that is there now.
            setHover((current) => {
              if (current === null || current.secid !== row.secid) return current
              setHoverChart(candles)
              return current
            })
          }, () => {
            /* a hover chart that failed says nothing: the row is still readable, and an error
               banner per missed hover would be noise. The K-line view itself reports failures. */
          })
      }, HOVER_DELAY_MS)
    }, [])

    const hideHover = React.useCallback(() => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      setHover(null)
      setHoverChart(null)
    }, [])

    React.useEffect(() => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    }, [])

/**
     * Pin a row's chart, reusing the hover cache when it is still fresh.
     *
     * The cache is shared on purpose: hovering a row and then clicking it is ONE look at one
     * stock, and asking upstream twice for it would be the kind of waste that only shows up on
     * somebody's rate limit.
     */
    const pinRow = React.useCallback((row) => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      setHover(null)
      setHoverChart(null)
      setPinned(row)
      const hit = hoverCache.current.get(row.secid)
      const fresh = hit !== undefined && Date.now() - hit.at < HOVER_CACHE_MS
      setPinnedChart(fresh ? hit.candles : null)
      if (fresh) return
      setPinnedBusy(true)
      hud.fetchJson(`/dsh-hud/market/kline?secid=${encodeURIComponent(row.secid)}&period=realtime`)
        .then((json) => {
          const candles = Array.isArray(json?.candles) ? json.candles : []
          hoverCache.current.set(row.secid, { at: Date.now(), candles })
          if (!aliveRef.current) return
          // Only if the pin is still on that row: an answer that arrives after another row was
          // clicked must not paint itself over the one that is there now.
          setPinned((current) => {
            if (current === null || current.secid !== row.secid) return current
            setPinnedChart(candles)
            return current
          })
        }, (failure) => {
          if (!aliveRef.current) return
          setPinned((current) => (current === null || current.secid !== row.secid
            ? current
            : { ...current, error: failure instanceof Error ? failure.message : String(failure) }))
        })
        .finally(() => { if (aliveRef.current) setPinnedBusy(false) })
    }, [])

    const unpin = React.useCallback(() => {
      setPinned(null)
      setPinnedChart(null)
      setPinnedBusy(false)
    }, [])

    const pollMs = clamp(num(snapshot?.pollMs) ?? MK_FALLBACK_MS, MK_MIN_MS, MK_MAX_MS)
    const selected = snapshot?.selected ?? ''
    const period = snapshot?.period ?? 'day'

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    React.useEffect(() => {
      let stop
      try {
        stop = typeof props.startTimers === 'function'
          ? props.startTimers(poll, pollMs, undefined, 0)
          : (() => {
              const id = window.setInterval(poll, pollMs)
              return () => window.clearInterval(id)
            })()
      } catch (failure) {
        console.error('[mk] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, pollMs, props.startTimers])

    // The K-line is fetched whenever the selection or the period changes, and on
    // the host's slower K-line cadence in between — a daily candle does not move
    // every 30 seconds.
    const loadKline = React.useCallback((secid, want, force) => {
      if (!secid) return
      const url = `/dsh-hud/market/kline?secid=${encodeURIComponent(secid)}&period=${encodeURIComponent(want)}${force ? '&refresh=1' : ''}`
      hud.fetchJson(url).then((json) => {
        if (aliveRef.current) setKline(json)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    React.useEffect(() => {
      loadKline(selected, period, false)
      const cadence = clamp(num(snapshot?.klineMs) ?? 300_000, 60_000, 24 * 60 * 60_000)
      const id = window.setInterval(() => loadKline(selected, period, false), cadence)
      return () => window.clearInterval(id)
    }, [selected, period, loadKline, snapshot?.klineMs])

    const post = React.useCallback(async (action, body) => {
      const json = await hud.fetchJson(`/dsh-hud/market/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (aliveRef.current) {
        setSnapshot(json)
        setError(null)
      }
      return json
    }, [])

    const refresh = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        await post('refresh')
        loadKline(selected, period, true)
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy, post, loadKline, selected, period])

    const runSearch = React.useCallback(async (input) => {
      setQuery(input)
      setAddMsg(null)
      if (input.trim().length < 1) {
        setHits([])
        return
      }
      try {
        const json = await post('search', { input })
        if (aliveRef.current) setHits(Array.isArray(json?.results) ? json.results : [])
      } catch (failure) {
        if (aliveRef.current) {
          setHits([])
          setAddMsg(failure instanceof Error ? failure.message : String(failure))
        }
      }
    }, [post])

      // The yuan, from the same payload as the quotes.
      const forex = Array.isArray(snapshot?.forex) ? snapshot.forex : []
      // Armed by the view, on the same cadence as everything else on this card.
    React.useEffect(() => {
      if (view === 'watch') return undefined
      readRank().catch(() => {})
      let stop
      try {
        stop = typeof props.startTimers === 'function'
          ? props.startTimers(() => { readRank().catch(() => {}) }, pollMs, undefined, 0)
          : (() => {
              const id = window.setInterval(() => { readRank().catch(() => {}) }, pollMs)
              return () => window.clearInterval(id)
            })()
      } catch {
        /* the timer is optional; the first read already happened */
      }
      return () => { try { if (typeof stop === 'function') stop() } catch { /* already stopped */ } }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, pollMs])

    const forexError = typeof snapshot?.forexError === 'string' ? snapshot.forexError : undefined
      const quotes = Array.isArray(snapshot?.quotes) ? snapshot.quotes : []
    const sessions = snapshot?.session ?? {}
    const shown = quotes.slice(0, MK_VISIBLE_ROWS)
    const stamp = snapshot?.fetchedAt
      ? new Date(snapshot.fetchedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false })
      : null

    return jsxs('div', { className: 'mk-root', 'data-panel': 'market', children: [
      jsxs('div', { className: 'mk-head', children: [
        jsx('span', { className: 'mk-title', children: zh ? '股市' : 'Markets' }),
        jsxs('span', { className: 'mk-sessions', children: ['cn', 'hk', 'us'].map((market) => {
          const one = sessions[market] ?? {}
          // The chip says WHY a market is shut when the reason is a holiday, because "A股" greyed
          // out with no explanation reads like a broken feed while "A股 国庆" reads like a
          // calendar. A weekend gets no label: everyone knows what a Saturday is.
          const why = one.closed === 'holiday' && one.closedLabel ? ` ${one.closedLabel}` : ''
          const title = [one.label ?? market, one.time, why.trim()].filter(Boolean).join(' ')
          return jsx('span', {
            className: `mk-sess${one.open ? ' is-open' : ''}${one.tradingDay === false ? ' is-off' : ''}`,
            title,
            children: `${one.label ?? market}${why}`,
          }, market)
        }) }),
        jsxs('span', { className: 'mk-right', children: [
          jsxs('span', { className: 'mk-views', role: 'group', children: RANK_VIEWS.map((one) => jsx('button', {
            type: 'button',
            className: `mk-view${view === one.id ? ' is-on' : ''}`,
            'data-act': `view-${one.id}`,
            'aria-pressed': view === one.id ? 'true' : 'false',
            title: one.id === 'watch' ? (zh ? '自选与 K 线' : 'watch list') : (zh ? '今日涨跌榜前 20' : "today's top 20"),
            // A pin belongs to the ranking that produced it: changing the view is changing the
            // question, so the answer goes away with it.
            onClick: () => { setView(one.id); setPinned(null); setPinnedChart(null); setPinnedBusy(false) },
            children: zh ? one.zh : one.en,
          }, one.id)) }),
          stamp ? jsx('span', { children: stamp }) : null,
          // In the HEAD row, not at the foot of the card: a control that adds to a list
          // belongs beside the list, and the row it used to occupy was a whole line of height
          // below the chart. The `＋` is the label because that is what the eye looks for; the
          // word appears only when the card is wide enough for it.
          jsx('button', {
            type: 'button',
            className: 'mk-btn is-quiet',
            'data-act': 'add',
            disabled: adding === true,
            title: zh ? '添加标的' : 'add an instrument',
            onClick: () => { setAdding(true); setAddMsg(null) },
            children: jsxs('span', { children: [
              '＋',
              jsx('span', { className: 'mk-add-wide', children: zh ? ' 添加标的' : ' add' }),
            ] }),
          }),
          jsx('button', {
            type: 'button',
            className: 'mk-btn',
            'data-act': 'refresh',
            disabled: busy,
            onClick: () => { refresh(); if (view !== 'watch') readRank().catch(() => {}) },
            children: busy ? (zh ? '刷新中' : 'loading') : (zh ? '刷新' : 'refresh'),
          }),
        ] }),
      ] }),
      error ? jsx('div', { className: 'mk-msg is-err', children: error }) : null,
      view !== 'watch'
        ? jsx(RankTable, {
            zh,
            half: rank?.[view],
            session: rank?.session,
            busy: rankBusy,
            error: rankError ?? rank?.error,
            hover: hover,
            hoverChart: hoverChart,
            onHover: showHover,
            onLeave: hideHover,
            pinned: pinned,
            pinnedChart: pinnedChart,
            pinnedBusy: pinnedBusy,
            onPin: pinRow,
            onUnpin: unpin,
            onPick: (row) => {
              // Add-then-select in one click: the host's `add` selects what it added, so this
              // lands the person on the stock's own chart — which is the only reason to look
              // at a ranking row a second time.
              post('add', { secid: row.secid, name: row.name })
                .then(() => { if (aliveRef.current) setView('watch') })
                .catch((failure) => { if (aliveRef.current) setAddMsg(failure instanceof Error ? failure.message : String(failure)) })
            },
          })
        : null,
      addMsg !== null && view !== 'watch' ? jsx('div', { className: 'mk-msg is-err', children: addMsg }) : null,
      view !== 'watch' || quotes.length > 0
        ? null
        : jsx('div', { className: 'mk-empty', children: zh ? '自选是空的，点右上角的「＋」添加标的。' : 'the watch list is empty — use ＋ above' }),
      view === 'watch' && quotes.length > 0
        ? jsx('div', { className: 'mk-watch', children: shown.map((row) => jsxs('div', {
            className: `mk-wrow${row.secid === selected ? ' is-sel' : ''}`,
            role: 'button',
            tabIndex: 0,
            onClick: () => { post('select', { secid: row.secid }).catch(() => {}) },
            children: [
              jsx('span', { className: 'mk-name', children: row.name }),
              jsx('span', { className: 'mk-code', children: row.code }),
              jsx('span', { className: 'mk-px', children: price(row.price) }),
              jsx('span', { className: `mk-chg ${toneOf(row.changePct)}`, children: pct(row.changePct) }),
              jsx('button', {
                type: 'button',
                className: 'mk-x',
                title: zh ? '从自选移除' : 'remove',
                onClick: (event) => { event.stopPropagation(); post('remove', { secid: row.secid }).catch(() => {}) },
                children: '×',
              }),
            ],
          }, row.secid)) })
        : null,
      view === 'watch' && quotes.length > shown.length
        ? jsx('div', { className: 'mk-note', children: zh ? `还有 ${quotes.length - shown.length} 个自选未显示` : `${quotes.length - shown.length} more hidden` })
        : null,
      // ── the yuan ────────────────────────────────────────────────────────
      // One compact row of rates, under the indices: `1 USD = 6.7186 CNH`. It is
      // here rather than in a card of its own because it is read TOGETHER with the
      // indices — and it comes from the same upstream as they do.
      forex.length > 0
        ? jsxs('div', { className: 'mk-fx', children: [
            jsx('span', { className: 'mk-fx-label', children: zh ? '汇率' : 'FX' }),
            ...forex.map((rate) => jsxs('span', {
              className: 'mk-fx-item',
              title: rate.inverse
                ? (zh ? `1 离岸人民币 = ${rate.value} ${rate.code}` : `1 CNH = ${rate.value} ${rate.code}`)
                : (zh ? `1 ${rate.code} = ${rate.value} 离岸人民币` : `1 ${rate.code} = ${rate.value} CNH`),
              children: [
                jsx('span', { className: 'mk-fx-code', children: rate.code }),
                jsx('span', { className: 'mk-fx-value', children: rate.value.toFixed(rate.decimals) }),
                jsx('span', { className: `mk-fx-chg ${toneOf(rate.changePct)}`, children: pct(rate.changePct) }),
                // The inverse pair is flagged, so nobody reads "1 JPY = 23.5 CNY".
                rate.inverse ? jsx('span', { className: 'mk-fx-inv', children: zh ? '反向' : 'inv' }) : null,
              ],
            }, rate.secid)),
          ] })
        : forexError !== undefined
          ? jsx('div', { className: 'mk-note', children: `${zh ? '汇率读取失败' : 'FX failed'}：${forexError}` })
          : null,
      // The chart is the shell's shared one (`hud.CandleChart`): the bond panel
        // draws K-lines too, and two copies of a chart drift apart. This panel
        // supplies only what is specific to shares — the periods, the width and
        // the compact height.
        view !== 'watch'
        ? null
        : jsx('div', { className: 'mk-chart', children: jsx(hud.CandleChart, {
          lang,
          candles: kline?.candles ?? [],
          height: 176,
          decimals: 2,
          period,
          // The menu is the HOST's: it owns what each period costs upstream (one
          // session of bars for 实时/5分/15分/60分, the last year for 日/周/月).
          periods: snapshot?.periods ?? [],
          onPeriod: (value) => { post('period', { period: value }).catch(() => {}) },
          ariaLabel: zh ? 'K 线图' : 'candlestick chart',
          empty: zh ? '没有拿到 K 线数据' : 'no candles',
        }) }),
        adding
        ? jsxs('div', { className: 'mk-add', children: [
            jsx('input', {
              className: 'mk-input',
              value: query,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: zh ? '输入名称或代码，如 茅台 / 600519 / AAPL' : 'name or code, e.g. AAPL',
              onChange: (event) => runSearch(event.target.value),
            }),
            hits.length > 0
              ? jsx('div', { className: 'mk-hits', children: hits.map((hit) => jsxs('button', {
                  type: 'button',
                  className: 'mk-hit',
                  onClick: async () => {
                    try {
                      await post('add', { secid: hit.secid, name: hit.name })
                      if (!aliveRef.current) return
                      setQuery('')
                      setHits([])
                      setAdding(false)
                    } catch (failure) {
                      if (aliveRef.current) setAddMsg(failure instanceof Error ? failure.message : String(failure))
                    }
                  },
                  children: [
                    jsx('span', { children: hit.name }),
                    jsx('span', { className: 'mk-code', children: `${hit.code}${hit.kind ? ` · ${hit.kind}` : ''}` }),
                  ],
                }, hit.secid)) })
              : null,
            addMsg ? jsx('div', { className: 'mk-msg is-err', children: addMsg }) : null,
            jsx('button', { type: 'button', className: 'mk-btn is-quiet', onClick: () => { setAdding(false); setAddMsg(null); setHits([]) }, children: zh ? '取消' : 'cancel' }),
          ] })
        // The form itself, with its results. The trigger is in the head row now, so this is
        // only ever the "adding" state.
        : null,
    ] })
  }

  return {
    id: 'market',
    order: 50,
    // Two columns: a candle chart in a third of the dock is unreadable.
    span: 2,
    label: { zh: '股市', en: 'Markets' },
    Component: MarketCard,
    __test: { MarketCard },
  }
}
