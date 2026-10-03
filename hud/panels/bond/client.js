// dsh-hud › bond panel — browser half.
//
// FRAGMENT CONTRACT: concatenated into the single `client.js` bundle by
// `tools/build-client.mjs`. No top-level `import` / `export` / `return`;
// `React`, `jsx`, `jsxs` and `hud` come from the bundle scope.
//
// A bond view is not a stock view with different numbers, so this card is not a
// candlestick chart:
//
//   期限结构 (the term structure) is the headline — a curve across tenors, which
//   is what "债市走势" means to anyone who works with bonds. One line, dots on
//   the quoted tenors, the value printed at each dot.
//
//   走势 comes from a bond ETF rather than from a yield series. A yield has no
//   OHLC — it is a single number per day, published once a day, and drawing
//   candles for it would be a lie dressed as professionalism. Chinamoney also
//   returns ~75 rows per trading day (one per tenor), so a 45-day 10Y history
//   costs ~57 paged requests and gets you an anti-scraping page; a bond ETF's
//   daily closes are the same signal, from a source built to be polled, and the
//   UI labels it as a PRICE (which moves inverse to yield) instead of pretending
//   it is a yield.
//
// Yields are therefore NOT coloured 红涨绿跌: a yield rising is not "up" in the
// sense a price is. They carry `+3.2bp` and an arrow, and only the tradeable
// bond ETFs — which ARE prices — get the red/green treatment.

const BD_FALLBACK_MS = 1_800_000
const BD_MIN_MS = 300_000
const BD_MAX_MS = 24 * 60 * 60_000
const BD_CN = '#2f6fd0'

function createBondPanel() {
  const CSS_ID = 'dsh-hud/bond.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.bd-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.bd-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;flex-wrap:wrap}',
      '.bd-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.bd-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.bd-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.bd-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.bd-btn:disabled{opacity:.55;cursor:default}',
      '.bd-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-btn.is-on{background:rgba(57,100,254,.10);border-color:rgba(57,100,254,.35);font-weight:600}',
      '.bd-sec{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.bd-sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-seclabel{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c)}',
      '.bd-secnote{color:var(--dsw-alias-label-caption,#81858c);font-size:10.5px}',
      // ── chart ─────────────────────────────────────────────────────────────
      '.bd-chart{position:relative;width:100%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));padding:5px 7px 3px}',
      '.bd-svg{display:block;width:100%;height:auto}',
      '.bd-ylab{position:absolute;right:2px;transform:translateY(-50%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 3px}',
      '.bd-xlab{position:absolute;bottom:0;transform:translateX(-50%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.bd-ptlab{position:absolute;top:0;transform:translate(-50%,-100%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.bd-tip{position:absolute;top:2px;transform:translateX(-50%);z-index:3;pointer-events:none;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 6px 18px -12px rgba(15,17,21,.55);font-size:10.5px;line-height:14px;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-tip b{color:var(--dsw-alias-label-primary,#0f1115)}',
      // ── numbers ───────────────────────────────────────────────────────────
      '.bd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:4px 12px}',
      '.bd-kv{display:flex;align-items:baseline;gap:6px;font-size:11.5px}',
      '.bd-kv span{color:var(--dsw-alias-label-caption,#81858c)}',
      '.bd-kv b{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}',
      '.bd-bp{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-etfs{display:flex;flex-direction:column;gap:1px}',
      '.bd-etf{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:6px;font-size:11.5px}',
      '.bd-etf:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
      '.bd-etfname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.bd-code{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.bd-px{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.bd-chg{flex:none;width:62px;text-align:right;font-variant-numeric:tabular-nums}',
      '.bd-up{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.bd-down{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.bd-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.bd-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.bd-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num
  const toNum = (value) => (num(value) === undefined ? null : value)

  /**
   * One line chart, used for the term structure AND both time series — a yield
   * curve is a line chart whose x axis happens to be tenors instead of dates, so
   * one component with a `formatX` is enough and keeps them looking identical.
   *
   * Same SVG technique as the market candles: the drawing stretches to the card
   * (`preserveAspectRatio="none"`), every stroke opts out with
   * `vector-effect="non-scaling-stroke"`, and every label is HTML positioned by
   * percentage so text never inherits the stretch.
   */
  function BondLine(props) {
    const lang = props.lang
    const zh = lang === 'zh'
    const [hover, setHover] = React.useState(null)
    const points = (Array.isArray(props.points) ? props.points : [])
      .map((point) => ({ ...point, value: toNum(point.value) }))
      .filter((point) => point.value !== null)
    const n = points.length
    if (n === 0) {
      return jsx('div', { className: 'bd-msg', children: props.empty ?? (zh ? '暂无数据' : 'no data') })
    }

    const W = 720
    const H = props.height ?? 120
    const TOP = 8
    const BOTTOM = H - 16
    let hi = -Infinity
    let lo = Infinity
    for (const point of points) {
      if (point.value > hi) hi = point.value
      if (point.value < lo) lo = point.value
    }
    if (hi === lo) {
      hi += 0.05
      lo -= 0.05
    }
    const pad = (hi - lo) * 0.12
    hi += pad
    lo -= pad

    const slot = W / Math.max(1, n - 1)
    const xAt = (index) => index * slot
    const yAt = (value) => TOP + ((hi - value) / (hi - lo)) * (BOTTOM - TOP)
    const line = points.map((point, index) => `${xAt(index).toFixed(2)},${yAt(point.value).toFixed(2)}`).join(' ')
    const area = `0,${BOTTOM} ${line} ${W},${BOTTOM}`
    const color = props.color ?? BD_CN
    const gradientId = props.gradientId ?? 'bd-fill'
    const hovered = hover === null ? null : points[hover]
    // Only label every dot when there are few enough that the labels do not
    // collide; a 45-point series gets its values in the tooltip instead.
    const showPointLabels = props.labelPoints === true && n <= 12

    return jsxs('div', { className: 'bd-chart', children: [
      jsxs('svg', {
        className: 'bd-svg',
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': props.ariaLabel ?? 'chart',
        onMouseLeave: () => setHover(null),
        children: [
          jsx('defs', { children: // `jsxs`, not `jsx`: this element has an ARRAY of children, and React's
          // non-static path validates each keyless child in an array — which is
          // the warning the browser test caught here.
          jsxs('linearGradient', {
            id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1,
            children: [
              jsx('stop', { offset: '0%', stopColor: color, stopOpacity: 0.22 }, 'top'),
              jsx('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }, 'bottom'),
            ],
          }) }),
          ...[0, 0.5, 1].map((fraction) => jsx('line', {
            x1: 0, x2: W, y1: TOP + (BOTTOM - TOP) * fraction, y2: TOP + (BOTTOM - TOP) * fraction,
            stroke: 'var(--dsw-alias-border-l1,rgba(0,0,0,.07))',
            strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke',
          }, `g${fraction}`)),
          jsx('polygon', { points: area, fill: `url(#${gradientId})` }),
          jsx('polyline', {
            points: line, fill: 'none', stroke: color, strokeWidth: 1.6,
            strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
          }),
          ...points.map((point, index) => jsx('circle', {
            cx: xAt(index), cy: yAt(point.value), r: n <= 12 ? 2.6 : 0,
            fill: 'var(--dsw-alias-bg-layer-1,#fff)', stroke: color, strokeWidth: 1.4,
            vectorEffect: 'non-scaling-stroke',
          }, `d${index}`)),
          hovered
            ? jsx('line', {
                x1: xAt(hover), x2: xAt(hover), y1: TOP, y2: BOTTOM,
                stroke: 'var(--dsw-alias-label-caption,#81858c)', strokeWidth: 1,
                strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke',
              }, 'guide')
            : null,
          ...points.map((point, index) => jsx('rect', {
            x: xAt(index) - slot / 2, y: 0, width: slot, height: H, fill: 'transparent',
            onMouseEnter: () => setHover(index),
          }, `hit${index}`)),
        ],
      }),
      jsx('span', { className: 'bd-ylab', style: { top: `${(TOP / H) * 100}%` }, children: hi.toFixed(2) }),
      jsx('span', { className: 'bd-ylab', style: { top: `${(BOTTOM / H) * 100}%` }, children: lo.toFixed(2) }),
      ...(showPointLabels
        ? points.map((point, index) => jsx('span', {
            className: 'bd-ptlab',
            style: { left: `${Math.min(94, Math.max(6, (xAt(index) / W) * 100))}%`, top: `${(yAt(point.value) / H) * 100}%` },
            children: point.value.toFixed(2),
          }, `l${index}`))
        : []),
      jsx('span', { className: 'bd-xlab', style: { left: '6%' }, children: props.formatX ? props.formatX(points[0], 0) : points[0].label }),
      n > 2
        ? jsx('span', { className: 'bd-xlab', style: { left: '50%' }, children: props.formatX ? props.formatX(points[Math.floor(n / 2)], Math.floor(n / 2)) : points[Math.floor(n / 2)].label })
        : null,
      n > 1
        ? jsx('span', { className: 'bd-xlab', style: { left: '94%' }, children: props.formatX ? props.formatX(points[n - 1], n - 1) : points[n - 1].label })
        : null,
      hovered
        ? jsxs('div', {
            className: 'bd-tip',
            style: { left: `${Math.min(86, Math.max(14, (xAt(hover) / W) * 100))}%` },
            children: [
              jsx('b', { children: props.formatX ? props.formatX(hovered, hover) : hovered.label }),
              ' ',
              hovered.value.toFixed(4),
              props.unit ? ` ${props.unit}` : '',
            ],
          })
        : null,
    ] })
  }

  /** The card. */
  function BondCard(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [kline, setKline] = React.useState(null)
    const [klineError, setKlineError] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const aliveRef = React.useRef(true)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    /**
     * The candles are their OWN request, not part of `/state`: a K-line is
     * fetched when the selection changes and on a slower clock than the
     * summary, so folding it into the summary would refetch 240 candles every
     * time the card polls.
     */
    const loadKline = React.useCallback((secid, period, force) => {
      if (!secid) return
      const url = `/dsh-hud/bond/kline?secid=${encodeURIComponent(secid)}&period=${encodeURIComponent(period ?? 'day')}${force ? '&refresh=1' : ''}`
      hud.fetchJson(url).then((json) => {
        if (!aliveRef.current) return
        setKline(json)
        setKlineError(json?.ok === false ? (json.error ?? 'kline failed') : null)
      }, (failure) => {
        if (aliveRef.current) setKlineError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/bond/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
        // The FIRST summary decides which instrument the K-line is for; after
        // that the selection is the user's and this never overrides it.
        loadKline(json?.chart, json?.chartPeriod, false)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [loadKline])

    const pollMs = clamp(num(snapshot?.pollMs) ?? BD_FALLBACK_MS, BD_MIN_MS, BD_MAX_MS)

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
        console.error('[bd] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, pollMs, props.startTimers])

    const refresh = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        const json = await hud.fetchJson('/dsh-hud/bond/refresh', { method: 'POST' })
        if (aliveRef.current) {
          setSnapshot(json)
          setError(null)
        }
        loadKline(json?.chart, json?.chartPeriod, true)
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy, loadKline])

    /**
     * Switching instrument or period writes the choice to the HOST (it survives
     * a reload) and refetches that instrument's candles — the selection is host
     * state because the K-line cache lives there too.
     */
    const choose = React.useCallback(async (patch) => {
      try {
        const json = await hud.fetchJson('/dsh-hud/bond/chart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!aliveRef.current) return
        setSnapshot(json)
        loadKline(json?.chart, json?.chartPeriod, false)
      } catch (failure) {
        if (aliveRef.current) setKlineError(failure instanceof Error ? failure.message : String(failure))
      }
    }, [loadKline])
    const chooseChart = (secid) => choose({ secid })
    const choosePeriod = (value) => choose({ period: value })


    const cn = snapshot?.cn ?? {}
    const stamp = snapshot?.fetchedAt
      ? new Date(snapshot.fetchedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false })
      : null

    return jsxs('div', { className: 'bd-root', 'data-panel': 'bond', children: [
      jsxs('div', { className: 'bd-head', children: [
        jsx('span', { className: 'bd-title', children: zh ? '债市' : 'Bonds' }),
        jsx('span', { className: 'bd-secnote', children: cn.date
          ? (zh ? `中债曲线 ${cn.date}` : `CN curve ${cn.date}`)
          : (zh ? '中债曲线 --' : 'CN curve --') }),
        jsxs('span', { className: 'bd-right', children: [
          stamp ? jsx('span', { children: stamp }) : null,
          jsx('button', { type: 'button', className: 'bd-btn', onClick: refresh, disabled: busy, children: busy ? (zh ? '刷新中' : 'loading') : (zh ? '刷新' : 'refresh') }),
        ] }),
      ] }),
      error ? jsx('div', { className: 'bd-msg is-err', children: error }) : null,

      // ── the headline: the term structure ──────────────────────────────────
      jsxs('div', { className: 'bd-sec', children: [
        jsxs('div', { className: 'bd-sechead', children: [
          jsx('span', { className: 'bd-seclabel', children: zh ? '国债收益率曲线（期限结构）' : 'GOVERNMENT CURVE' }),
          jsx('span', { className: 'bd-secnote', children: zh ? '中债国债，单位 %' : 'China government, %' }),
        ] }),
        cn.error
          ? jsx('div', { className: 'bd-msg is-err', children: cn.error })
          : jsx(BondLine, {
              lang,
              points: cn.curve ?? [],
              formatX: (point) => point.label,
              height: 118,
              labelPoints: true,
              color: BD_CN,
              gradientId: 'bd-cn',
              unit: '%',
              ariaLabel: zh ? '国债收益率曲线' : 'government yield curve',
              empty: zh ? '没有拿到中债曲线' : 'no CN curve',
            }),
      ] }),

      // ── the K-line: 实时 / 5分 / 15分 / 60分 / 日K / 周K / 月K ────────────
      // The CN YIELD CURVE cannot be candled (the host's banner explains the
      // measured limits), so this charts what CAN be: the domestic bond ETFs.
      jsxs('div', { className: 'bd-sec', children: [
        jsxs('div', { className: 'bd-sechead', children: [
          jsx('span', { className: 'bd-seclabel', children: zh ? 'K 线' : 'CANDLES' }),
          jsx('span', { className: 'bd-secnote', children: zh ? '场内价格：涨 = 收益率下行' : 'price: up = yields down' }),
          jsxs('span', { className: 'bd-kv', children: [
            jsx('span', { children: zh ? '10Y' : '10Y' }),
            jsx('b', { children: num(cn.ten) === undefined ? '--' : `${cn.ten.toFixed(3)}%` }),
          ] }),
        ] }),
        jsx('span', { className: 'bd-charts', children: (snapshot?.charts ?? []).map((entry) => jsx('button', {
          type: 'button',
          className: `bd-btn is-quiet${entry.secid === snapshot?.chart ? ' is-on' : ''}`,
          onClick: () => chooseChart(entry.secid),
          children: entry.name,
        }, entry.secid)) }),
        klineError
          ? jsx('div', { className: 'bd-msg is-err', children: klineError })
          : kline === null
            ? jsx('div', { className: 'bd-msg', children: zh ? '正在取 K 线…' : 'loading candles…' })
            : jsx('div', { className: 'bd-kline', children: jsx(hud.CandleChart, {
                lang,
                candles: kline.candles ?? [],
                // A bond ETF price needs three decimals to say anything (134.804).
                decimals: 3,
                height: 176,
                period: snapshot?.chartPeriod ?? kline.period,
                periods: snapshot?.periods ?? [],
                onPeriod: (value) => choosePeriod(value),
                ariaLabel: zh ? '债市 K 线图' : 'bond candlestick chart',
                empty: zh ? '这只标的没有 K 线数据' : 'no candles',
              }) }),
      ] }),

      // ── tradeable proxies ─────────────────────────────────────────────────
      (snapshot?.etfs ?? []).length > 0
        ? jsxs('div', { className: 'bd-sec', children: [
            jsx('span', { className: 'bd-sechead', children: jsx('span', { className: 'bd-seclabel', children: zh ? '国债 ETF' : 'BOND ETFs' }) }),
            jsx('div', { className: 'bd-etfs', children: (snapshot?.etfs ?? []).map((etf) => jsxs('div', { className: 'bd-etf', children: [
              jsx('span', { className: 'bd-etfname', children: etf.name }),
              jsx('span', { className: 'bd-code', children: etf.code }),
              jsx('span', { className: 'bd-px', children: num(etf.price) === undefined ? '--' : etf.price.toFixed(3) }),
              jsx('span', {
                className: `bd-chg ${num(etf.changePct) === undefined || etf.changePct === 0 ? '' : etf.changePct > 0 ? 'bd-up' : 'bd-down'}`,
                children: num(etf.changePct) === undefined ? '--' : `${etf.changePct > 0 ? '+' : ''}${etf.changePct.toFixed(2)}%`,
              }),
            ] }, etf.secid)) }),
          ] })
        : null,
    ] })
  }

  return {
    id: 'bond',
    order: 60,
    // ONE column by default: the row holds three, and the share panel asks for
    // two of them — see the shell's single-row rule. Widen it in ⚙ if you would
    // rather give the curve the room and shrink the share card.
    span: 1,
    label: { zh: '债市', en: 'Bonds' },
    Component: BondCard,
    __test: { BondCard, BondLine },
  }
}