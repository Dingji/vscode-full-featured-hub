// dsh-hud › weather panel — browser half.
//
// FRAGMENT CONTRACT: `tools/build-client.mjs` concatenates this file into the
// single `client.js` bundle, inside the same factory scope as the shell and the
// other panels. No top-level `import` / `export` / `return`; everything lives
// inside `createWeatherPanel()`. `React`, `jsx`, `jsxs` and `hud` come from the
// enclosing bundle scope.
//
// This panel contributes ONLY `head` — a widget in the HUD's title bar. It has
// no `Component`, so it never takes a grid column and never disturbs the card
// layout; the ⚙ editor still gets a row for it, because "is the weather line
// showing" is a thing the user should be able to switch off.
//
// The title bar has room for one line, so it carries exactly what was asked
// for — condition, temperature, humidity, wind — and pushes everything else
// (feels-like, precipitation, gusts, 风力等级, the alert list, the refresh
// button) into a click-open panel. The alert chip is the exception: an extreme
// weather warning is the one thing that must not need a click to notice, so it
// sits inline next to the reading.
//
// Cadence: the host ships `refreshMs` (default 600 000 = 10 minutes) and it is
// what the poll interval is armed with, so the host and the browser can never
// disagree about how fresh "fresh" is.

const WX_CLOCK_MS = 0 // no clock tick: nothing in the line counts down
const WX_FALLBACK_REFRESH_MS = 600_000
const WX_MIN_REFRESH_MS = 60_000
const WX_MAX_REFRESH_MS = 6 * 60 * 60_000
/** Severity order for picking which alert earns the inline chip. */
const WX_LEVEL_RANK = { 红色: 4, 橙色: 3, 黄色: 2, 蓝色: 1, '': 0 }

function createWeatherPanel() {
  const CSS_ID = 'dsh-hud/weather.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      // The widget is one line of small text; the card's own surface and the
      // title bar's border already frame it, so there is no chrome here.
      '.wx-root{position:relative;display:inline-flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.wx-btn{display:inline-flex;align-items:center;gap:6px;min-width:0;padding:1px 2px;border:0;border-radius:6px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:inherit;cursor:pointer}',
      '.wx-btn:hover{color:var(--dsw-alias-label-primary,#0f1115)}',
      '.wx-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
      '.wx-glyph{flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-temp{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      // Air quality in the head row: a dot for the band AND the band's name,
      // because an AQI number alone tells most people nothing.
      '.wx-air{display:inline-flex;align-items:baseline;gap:4px}',
      '.wx-air-band{font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-air-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#b6bac1);vertical-align:middle}',
      '.wx-air-dot.is-good{background:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.wx-air-dot.is-moderate{background:#c8a02a}',
      '.wx-air-dot.is-poor{background:var(--dsw-alias-state-warning-primary,#b45309)}',
      '.wx-air-dot.is-bad{background:#c2410c}',
      '.wx-air-dot.is-severe{background:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.wx-sep{color:var(--dsw-alias-border-l2,rgba(0,0,0,.18))}',
      '.wx-dim{color:var(--dsw-alias-label-caption,#81858c)}',
      // The alert chip: the one element here allowed to raise its voice, and it
      // still only changes colour and weight.
      '.wx-alert{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid transparent;font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;background:transparent}',
      '.wx-alert.lv-blue{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe);background:rgba(57,100,254,.08)}',
      '.wx-alert.lv-yellow{border-color:rgba(245,158,11,.45);color:#b45309;background:rgba(245,158,11,.10)}',
      '.wx-alert.lv-orange{border-color:rgba(234,88,12,.45);color:#c2410c;background:rgba(234,88,12,.10)}',
      '.wx-alert.lv-red{border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.10);font-weight:600}',
      '.wx-alert-count{font-style:normal;opacity:.75}',
      // Click-open detail panel.
      '.wx-pop{position:absolute;top:100%;left:0;z-index:6;margin-top:7px;box-sizing:border-box;width:min(340px,78vw);display:flex;flex-direction:column;gap:6px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#ffffff);box-shadow:0 2px 6px rgba(0,0,0,.06),0 14px 32px -18px rgba(15,17,21,.5);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);text-align:left;white-space:normal}',
      '.wx-pop-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:5px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
      '.wx-pop-place{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.wx-pop-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.wx-pop-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:4px 12px}',
      '.wx-kv{display:flex;align-items:baseline;gap:6px}',
      '.wx-kv span{color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-kv b{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}',
      '.wx-pop-sec{padding-top:5px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));display:flex;flex-direction:column;gap:4px}',
      '.wx-pop-sechead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-item{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:16px}',
      '.wx-lv{flex:none;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;border:1px solid transparent}',
      '.wx-lv.lv-blue{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.wx-lv.lv-yellow{border-color:rgba(245,158,11,.45);color:#b45309}',
      '.wx-lv.lv-orange{border-color:rgba(234,88,12,.45);color:#c2410c}',
      '.wx-lv.lv-red{border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.wx-item-title{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.wx-item-meta{flex:none;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.wx-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none;border-bottom:1px dotted currentColor}',
      '.wx-hint{display:flex;flex-direction:column;gap:3px;padding:6px 8px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));font-size:11px}',
      '.wx-hint b{color:var(--dsw-alias-label-primary,#0f1115)}',
      '.wx-hint-step{position:relative;padding-left:13px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.wx-hint-step::before{content:"›";position:absolute;left:3px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-actions{display:flex;align-items:center;gap:8px;padding-top:4px}',
      '.wx-ghost{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.wx-ghost:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.wx-ghost:disabled{opacity:.55;cursor:default}',
      '.wx-msg{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num

  /** Highest severity wins the inline chip; ties keep source order. */
  function worstAlert(alerts) {
    let best
    let rank = -1
    for (const alert of alerts) {
      const value = WX_LEVEL_RANK[alert?.level] ?? 0
      if (value > rank) {
        rank = value
        best = alert
      }
    }
    return best
  }

  const levelClass = (level) => `lv-${({ 蓝色: 'blue', 黄色: 'yellow', 橙色: 'orange', 红色: 'red' })[level] ?? 'blue'}`

  /** The condition in the reader's language, falling back to the Chinese one. */
  const conditionText = (current, zh) => (zh ? current.text : (current.textEn || current.text))

/** A µg/m³ reading, or `--` when the upstream omitted it. */
  const fmtAir = (value) => (num(value) === undefined ? '--' : String(Math.round(num(value) * 10) / 10))

  /**
   * The AQI band as a colour class.
   *
   * The same six EPA bands the host uses, so the dot and the WORD always agree —
   * a green dot beside 重度污染 would be worse than having no colour at all.
   */
  const airTone = (aqi) => {
    const value = num(aqi)
    if (value === undefined) return 'is-unknown'
    if (value <= 50) return 'is-good'
    if (value <= 100) return 'is-moderate'
    if (value <= 150) return 'is-poor'
    if (value <= 200) return 'is-bad'
    return 'is-severe'
  }
  const fmtTemp = (value, lang) => (num(value) === undefined ? '--' : `${Math.round(value * 10) / 10}°C`)
  const fmtSpeed = (value) => (num(value) === undefined ? '--' : `${Math.round(value * 10) / 10} km/h`)
  const fmtWind = (current, lang) => {
    if (!current) return '--'
    const direction = current.windDirection ? (lang === 'zh' ? current.windDirection.zh : current.windDirection.en) : ''
    const speed = fmtSpeed(current.windSpeed)
    const force = num(current.windForce)
    if (lang === 'zh') {
      return `${direction ? `${direction}风 ` : ''}${speed}${force === undefined ? '' : ` (${force} 级)`}`
    }
    return `${direction ? `${direction} ` : ''}${speed}${force === undefined ? '' : ` (force ${force})`}`
  }

  /**
   * The title-bar widget.
   *
   * Hook order is fixed: nothing below returns before every hook has run, so the
   * "no reading yet" / "error" / "ready" states cannot shift the hook count and
   * take the slot entry down.
   */
  function WeatherHead(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const rootRef = React.useRef(null)
    const aliveRef = React.useRef(true)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/weather/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    // The refresh cadence is the host's number (10 minutes by default), clamped
    // the same way the shell clamps every other cadence.
    const refreshMs = clamp(num(snapshot?.refreshMs) ?? WX_FALLBACK_REFRESH_MS, WX_MIN_REFRESH_MS, WX_MAX_REFRESH_MS)

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
        if (typeof props.startTimers === 'function') {
          // No clock tick: nothing on this line counts down.
          stop = props.startTimers(poll, refreshMs, undefined, WX_CLOCK_MS)
        } else {
          const id = window.setInterval(poll, refreshMs)
          stop = () => window.clearInterval(id)
        }
      } catch (failure) {
        console.error('[wx] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, refreshMs, props.startTimers])

    // Close the detail panel on a click anywhere outside it. The listener is
    // attached while open, so the click that opened it cannot close it.
    React.useEffect(() => {
      if (!open) return undefined
      const onDown = (event) => {
        if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
      }
      document.addEventListener('pointerdown', onDown)
      return () => document.removeEventListener('pointerdown', onDown)
    }, [open])

    const refresh = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        const json = await hud.fetchJson('/dsh-hud/weather/refresh', { method: 'POST' })
        if (aliveRef.current) {
          setSnapshot(json)
          setError(null)
        }
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy])

    // Air quality rides along with the weather: same provider family, separate
  // failure. irError is shown beside the readings rather than replacing them.
  const air = snapshot?.air ?? null
  const airError = typeof snapshot?.airError === 'string' ? snapshot.airError : undefined
  const current = snapshot?.current
    const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : []
    const worst = worstAlert(alerts)
    const hint = snapshot?.hint
    /**
     * A 404 here has one overwhelmingly likely cause: the browser half was
     * updated (a page refresh is enough for that) while the host half is still
     * the module Node cached at startup, so `/dsh-hud/weather/*` does not exist
     * yet. Say that, instead of showing a generic failure the user cannot act on.
     */
    const routeMissing = typeof error === 'string' && /\b404\b/.test(error)
    const place = snapshot?.location
      ? [snapshot.location.name, snapshot.location.region].filter(Boolean).join(' · ')
      : ''

    // One line, in the order it was asked for: condition, temperature,
    // humidity, wind.
    const headline = current
      ? [
          `${current.glyph} ${conditionText(current, zh)}`,
          fmtTemp(current.temperature, lang),
          `${zh ? '湿度' : 'humidity'} ${num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%`}`,
          fmtWind(current, lang),
        ]
      : null

    const tooltip = current
      ? `${place ? `${place} ` : ''}${conditionText(current, zh)} ${fmtTemp(current.temperature, lang)}`
        + ` · ${zh ? '体感' : 'feels'} ${fmtTemp(current.feelsLike, lang)}`
        + ` · ${zh ? '湿度' : 'humidity'} ${num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%`}`
        + ` · ${fmtWind(current, lang)}`
        + (alerts.length > 0 ? ` · ${zh ? `${alerts.length} 条预警` : `${alerts.length} alert(s)`}` : '')
      : (routeMissing
          ? (zh ? '宿主半区还没有天气路由：重启一次 DeepSeek Harness 即可（浏览器半区刷新就够了，宿主半区不行）'
                : 'the host half has no weather route yet — restart DeepSeek Harness once (a page refresh updates the browser half only)')
          : error ? `${zh ? '天气获取失败' : 'weather failed'}: ${error}` : (zh ? '正在获取天气…' : 'loading weather…'))

    const summary = headline
      ? jsxs('button', {
          type: 'button',
          className: 'wx-btn',
          title: tooltip,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
          children: [
            jsx('span', { className: 'wx-glyph', 'aria-hidden': true, children: current.glyph }),
            jsx('span', { children: conditionText(current, zh) }),
            jsx('span', { className: 'wx-temp', children: fmtTemp(current.temperature, lang) }),
            jsx('span', { className: 'wx-sep', 'aria-hidden': true, children: '·' }),
            jsx('span', { children: `${zh ? '湿度' : 'humidity'} ${num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%`}` }),
            jsx('span', { className: 'wx-sep', 'aria-hidden': true, children: '·' }),
            jsx('span', { children: fmtWind(current, lang) }),
            // Air quality, in the head row: it is the other number that decides
            // whether the window gets opened, and the band is spelled out because
            // an AQI value alone means nothing to most people.
            air?.usAqi === undefined
              ? null
              : jsxs('span', { className: 'wx-air', title: zh ? '空气质量（美国 AQI）' : 'air quality (US AQI)', children: [
                  jsx('span', { className: 'wx-sep', 'aria-hidden': true, children: '·' }),
                  jsx('span', { className: `wx-air-dot ${airTone(air.usAqi)}`, 'aria-hidden': true }),
                  jsx('span', { children: `AQI ${Math.round(air.usAqi)}` }),
                  air.level === undefined ? null : jsx('span', { className: 'wx-air-band', children: zh ? air.level.zh : air.level.en }),
                ] }),
          ],
        })
      : jsx('button', {
          type: 'button',
          className: 'wx-btn',
          title: tooltip,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
          children: jsx('span', { className: 'wx-dim', children: routeMissing
            ? (zh ? '天气 -- 需重启宿主' : 'weather -- restart host')
            : error ? (zh ? '天气获取失败' : 'weather failed') : (zh ? '天气 --' : 'weather --') }),
        })

    return jsxs('span', {
      className: 'wx-root',
      ref: rootRef,
      'data-panel': 'weather',
      children: [
        summary,
        // An extreme-weather warning must be visible without a click.
        worst
          ? jsxs('button', {
              type: 'button',
              className: `wx-alert ${levelClass(worst.level)}`,
              title: worst.title,
              onClick: () => setOpen(true),
              children: [
                jsx('span', { 'aria-hidden': true, children: '⚠' }),
                jsx('span', { children: `${worst.phenomenon}${worst.level}${zh ? '预警' : ''}` }),
                alerts.length > 1 ? jsx('em', { className: 'wx-alert-count', children: `+${alerts.length - 1}` }) : null,
              ],
            })
          : null,
        open
          ? jsxs('div', { className: 'wx-pop', children: [
              jsxs('div', { className: 'wx-pop-head', children: [
                jsx('span', { className: 'wx-pop-place', children: place || (zh ? '未知地点' : 'unknown place') }),
                jsx('span', { className: 'wx-dim', children: current?.observedAt
                  ? `${zh ? '观测' : 'obs'} ${String(current.observedAt).slice(11, 16) || current.observedAt}`
                  : '' }),
              ] }),
              current
                ? jsxs('div', { className: 'wx-pop-grid', children: [
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '天气' : 'sky' }), jsx('b', { children: conditionText(current, zh) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '温度' : 'temp' }), jsx('b', { children: fmtTemp(current.temperature, lang) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '体感' : 'feels' }), jsx('b', { children: fmtTemp(current.feelsLike, lang) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '湿度' : 'humidity' }), jsx('b', { children: num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%` })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '风' : 'wind' }), jsx('b', { children: fmtWind(current, lang) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '阵风' : 'gusts' }), jsx('b', { children: fmtSpeed(current.windGust) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '降水' : 'precip' }), jsx('b', { children: num(current.precipitation) === undefined ? '--' : `${current.precipitation} mm` })] }),
                  ] })
                : null,
              // ── air quality ───────────────────────────────────────────────
              // Its own section because the numbers are read as a group, and every
              // one of them is in the same unit.
              air !== null && air !== undefined && air.usAqi !== undefined
                ? jsxs('div', { className: 'wx-pop-sec', children: [
                    jsxs('div', { className: 'wx-pop-sechead', children: [
                      jsx('span', { children: zh ? '空气质量' : 'AIR' }),
                      jsxs('span', { children: [
                        jsx('span', { className: `wx-air-dot ${airTone(air.usAqi)}`, 'aria-hidden': true }),
                        ` AQI ${Math.round(air.usAqi)}`,
                        air.level === undefined ? '' : ` ${zh ? air.level.zh : air.level.en}`,
                      ] }),
                    ] }),
                    jsxs('div', { className: 'wx-pop-grid', children: [
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: 'PM2.5' }), jsx('b', { children: fmtAir(air.pm25) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: 'PM10' }), jsx('b', { children: fmtAir(air.pm10) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '臭氧' : 'O₃' }), jsx('b', { children: fmtAir(air.ozone) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '二氧化氮' : 'NO₂' }), jsx('b', { children: fmtAir(air.no2) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '二氧化硫' : 'SO₂' }), jsx('b', { children: fmtAir(air.so2) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '一氧化碳' : 'CO' }), jsx('b', { children: fmtAir(air.co) })] }),
                    ] }),
                    jsx('span', { className: 'wx-dim', children: air.source ?? '' }),
                  ] })
                : airError === undefined
                  ? null
                  // An air outage is stated NEXT TO the weather, never instead of it.
                  : jsx('span', { className: 'wx-dim', children: `${zh ? '空气质量读取失败' : 'air failed'}：${airError}` }),
              // ── extreme weather alerts ────────────────────────────────────
              alerts.length > 0
                ? jsxs('div', { className: 'wx-pop-sec', children: [
                    jsxs('div', { className: 'wx-pop-sechead', children: [
                      jsx('span', { children: zh ? '预警' : 'ALERTS' }),
                      jsx('span', { children: `${alerts[0].scope === 'city' ? (zh ? '本地' : 'local') : (zh ? '本省' : 'province')} ${alerts.length}` }),
                    ] }),
                    ...alerts.map((alert, index) => jsxs('div', { className: 'wx-item', children: [
                      jsx('span', { className: `wx-lv ${levelClass(alert.level)}`, children: alert.level || (zh ? '预警' : 'alert') }),
                      jsx('span', { className: 'wx-item-title', children: `${alert.phenomenon || alert.title}${alert.place ? ` · ${alert.place}` : ''}` }),
                      jsx('span', { className: 'wx-item-meta', children: String(alert.issuedAt).slice(5) }),
                      alert.url
                        ? jsx('a', { className: 'wx-link', href: alert.url, target: '_blank', rel: 'noreferrer noopener', children: zh ? '详情' : 'more' })
                        : null,
                    ] }, alert.id || `a${index}`)),
                  ] })
                : jsxs('div', { className: 'wx-pop-sec', children: [
                    jsx('div', { className: 'wx-pop-sechead', children: jsx('span', { children: zh ? '预警' : 'ALERTS' }) }),
                    jsx('div', { className: 'wx-dim', children: snapshot?.alertSource === 'unsupported'
                      ? (zh ? '当前地区暂无预警数据源（目前接入中央气象台，仅中国境内）' : 'no alert source for this region (NMC covers China only)')
                      : snapshot?.alertSource === 'off'
                        ? (zh ? '预警已在设置中关闭' : 'alerts are switched off in settings')
                        : snapshot?.alertSource === 'error'
                          ? (zh ? `预警查询失败：${snapshot?.alertsError ?? ''}` : `alert lookup failed: ${snapshot?.alertsError ?? ''}`)
                          : (zh ? '本地与本省当前没有生效的预警' : 'no active alerts locally or in this province') }),
                  ] }),
              hint
                ? jsxs('div', { className: 'wx-hint', children: [
                    jsx('b', { children: hint.title }),
                    ...(hint.steps ?? []).map((step, index) => jsx('div', { className: 'wx-hint-step', children: step }, `h${index}`)),
                  ] })
                : null,
              error
                ? jsx('div', { className: 'wx-msg', children: routeMissing
                    ? (zh
                        ? '宿主半区还没加载天气路由 —— 重启一次 DeepSeek Harness。浏览器半区刷新就会更新，宿主半区不会（Node 按 URL 缓存了模块）。'
                        : 'The host half has no weather route yet — restart DeepSeek Harness. A page refresh updates the browser half only; the host module is cached by URL.')
                    : error })
                : null,
              jsxs('div', { className: 'wx-actions', children: [
                jsx('button', { type: 'button', className: 'wx-ghost', onClick: refresh, disabled: busy, children: busy ? (zh ? '刷新中…' : 'refreshing…') : (zh ? '刷新' : 'refresh') }),
                jsx('span', { className: 'wx-dim', children: zh
                  ? `每 ${Math.round(refreshMs / 60_000)} 分钟自动刷新`
                  : `auto-refresh every ${Math.round(refreshMs / 60_000)} min` }),
              ] }),
            ] })
          : null,
      ],
    })
  }

  return {
    id: 'weather',
    order: 30,
    label: { zh: '天气', en: 'Weather' },
    // Head-only: no `Component`, so this panel takes no grid column.
    head: WeatherHead,
    __test: { WeatherHead, worstAlert, fmtWind },
  }
}