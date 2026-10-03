// dsh-hud — browser half of the `quota` panel.
//
// A FRAGMENT, not a standalone module: tools/build-client.mjs concatenates the
// panel fragments verbatim into ONE `dsh-hud` bundle, inside a single factory
// scope. So this file has no top-level import/export/return — the whole panel
// is nested in `createQuotaPanel()` below, which returns its registry entry.
// The enclosing bundle scope already provides `React`, `jsx`, `jsxs`, `hud` and
// `registerPanel`; this fragment declares none of them.
//
// The shell owns the dock cell, the placement and the timers: it builds
// `startTimers` and passes the platform props (`startTimers`, `useProjection`)
// straight through to the panel's `Component`.
//
// Behaviour:
//  - registers a compact usage card into the `conversation.input.dock` list
//    slot (the strip directly above the composer card, session scope);
//  - the card is stacked ABOVE the scrolling transcript (sticky + z-index +
//    opaque surface) so content scrolling past never shows behind or over it;
//  - each configured `opencode*` subscription gets its own window set and the
//    card auto-rotates through them (8 s), pausing while hovered; dots switch
//    manually;
//  - two bars per window: a usage bar with a SEGMENTED gradient that cools to
//    amber past 60 % and to red past 80 %, and a REVERSE time bar counting
//    down to the reset (hover it for the exact reset time);
//  - session decode rate plus this-run instant rate, from the `sessionStats`
//    projection (same source as the composer status line);
//  - polls the host's same-origin `/dsh-hud/quota/usage` route on the live
//    `pollMs` cadence (configurable host-side, hard floor 30 s).
//
// Visual language: quiet and native — DSH theme tokens, no glow, no gradient
// text, no ambient animation beyond the bar width transition.
function createQuotaPanel() {
    /** Self-diagnostics, filterable in the console with `ocq`. */
    const dbg = (...args) => {
      try {
        console.log('[ocq]', ...args)
      } catch {}
    }
    dbg('factory materialized')

    // ── constants ──────────────────────────────────────────────────────────
    const CLOCK_MS = 1_000
    const DEFAULT_POLL_MS = 60_000
    /** Hard floor of the refresh cadence — mirrored by the host config. */
    const MIN_POLL_MS = 30_000
    const MAX_POLL_MS = 600_000
    /** How long one subscription stays on screen before rotating. */
    const CAROUSEL_MS = 8_000
    const OCGO_PROVIDER = 'opencode-go'
    /** Thresholds: ≥60 warn, ≥80 danger (mirrored by the gradient stops). */
    const WARN_AT = 60
    const DANGER_AT = 80

    /** Window lengths used to derive time-elapsed when a reset time is known. */
    const WINDOWS = [
      { key: 'rolling', zh: '5 小时限额', en: '5-hour limit', spanMs: 5 * 3600_000 },
      { key: 'weekly', zh: '周限额', en: 'Weekly limit', spanMs: 7 * 86400_000 },
      { key: 'monthly', zh: '月限额', en: 'Monthly limit', spanMs: 30 * 86400_000 },
    ]
    const WINDOW_META = Object.fromEntries(WINDOWS.map((m) => [m.key, m]))

    /** Localized labels for the prepaid-balance keys the collectors emit. */
    const BALANCE_LABELS = {
      available: ['可用余额', 'available'],
      granted: ['赠金', 'granted'],
      toppedUp: ['充值余额', 'topped-up'],
      voucher: ['代金券', 'voucher'],
      cash: ['现金', 'cash'],
      gift: ['赠金', 'gift'],
      charge: ['充值余额', 'charged'],
      bonus: ['赠送余额', 'bonus'],
      total: ['总额', 'total'],
      used: ['已用', 'used'],
      credits: ['剩余额度', 'credits'],
    }

    /**
     * Normalize one host row into the shape the card renders:
     *   `{ id, label, plan?, windows: [{key, percent, resetsAt?}], balances, error? }`
     * Legacy payloads carrying `usage.{rolling,weekly,monthly}` are converted
     * here so an old host half still renders.
     */
    function normalizeRow(row) {
      const windows = []
      if (Array.isArray(row?.windows) && row.windows.length > 0) {
        for (const w of row.windows) {
          const pct = num(w?.percent)
          if (pct === undefined) continue
          windows.push({
            key: String(w.key ?? ''),
            // Custom sources may ship their own label (e.g. "Token 套餐").
            label: typeof w.label === 'string' && w.label ? w.label : undefined,
            percent: clamp(pct, 0, 100),
            resetsAt: num(w.resetsAt),
            // Optional absolute credits (千问 Token Plan): 13,284 / 180,000.
            used: num(w.used),
            total: num(w.total),
            unit: typeof w.unit === 'string' && w.unit ? w.unit : undefined,
          })
        }
      } else if (row?.usage && typeof row.usage === 'object') {
        for (const meta of WINDOWS) {
          const w = row.usage[meta.key]
          const pct = percentOf(w)
          if (pct === undefined) continue
          windows.push({ key: meta.key, percent: pct, resetsAt: resetsAtOf(w) })
        }
      }
      return {
        id: String(row?.id ?? ''),
        label: String(row?.label ?? ''),
        kind: String(row?.kind ?? ''),
        plan: typeof row?.plan === 'string' && row.plan ? row.plan : undefined,
        // Drawer status: [{ ref, present }] — refs only, values never ship.
        credentials: Array.isArray(row?.credentials)
          ? row.credentials
              .filter((c) => c && typeof c.ref === 'string')
              .map((c) => ({ ref: c.ref, present: Boolean(c.present) }))
          : [],
        windows,
        balances: Array.isArray(row?.balances)
          ? row.balances.filter((b) => b && typeof b === 'object' && typeof b.key === 'string')
          : [],
        // Structured fix-it panel: “请安装 XXX” + command + steps.
        hint: row?.hint && typeof row.hint === 'object' && typeof row.hint.title === 'string'
          ? {
              title: row.hint.title,
              install: typeof row.hint.install === 'string' ? row.hint.install : undefined,
              steps: Array.isArray(row.hint.steps) ? row.hint.steps.filter((s) => typeof s === 'string') : [],
            }
          : undefined,
        // Usage series (last 30 days) → line chart.
        series: Array.isArray(row?.series)
          ? row.series
              .filter((p) => p && typeof p.t === 'number' && typeof p.v === 'number')
              .map((p) => ({ t: p.t, v: p.v, c: typeof p.c === 'number' ? p.c : undefined }))
          : [],
        granularity: row?.granularity === 'hour' || row?.granularity === 'day' ? row.granularity : undefined,
        seriesTokens: num(row?.seriesTokens),
        seriesCost: num(row?.seriesCost),
        error: typeof row?.error === 'string' && row.error ? row.error : undefined,
      }
    }

    /**
     * The usage ramp, designed to be ANCHORED TO THE TRACK (the fill scales
     * it with `background-size`, so colours line up with absolute usage — a
     * 20 % bar shows only blue, never a squeezed rainbow).
     *
     * Palette logic: brand blue below the warn line, a cool sand bridge that
     * crosses 60 % exactly on amber, then a short amber → red move that lands
     * on danger at 80 %. Every stop is a mid-saturation solid so the ramp
     * stays clean in both light and dark themes, and the hue never passes
     * through a muddy blue-brown blend.
     */
    const USAGE_GRADIENT =
      'linear-gradient(90deg,#3b6ff2 0%,#5b8bf5 38%,#a9b7d9 51%,#f0b93f 60%,#f2a733 70%,#e8623f 80%,#dd3b34 90%,#d83b34 100%)'

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS_ID = 'dsh-hud/quota.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-hud'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        // Stacked above the transcript: sticky + z-index + an opaque surface,
        // so scrolling content passes behind the card and never overlaps it.
        '.ocq-root{position:sticky;top:0;z-index:1000;isolation:isolate;display:flex;justify-content:center;width:100%;padding:0 2px 8px;font-family:inherit;color:var(--dsw-alias-label-primary,#0f1115)}',
        // Surface: layered shadow (edge + soft ambient) and a hairline top
        // highlight read as a real card without any glow or gradient chrome.
        '.ocq-card{box-sizing:border-box;width:min(100%,560px);display:flex;flex-direction:column;gap:10px;padding:11px 13px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#ffffff);box-shadow:inset 0 1px 0 rgba(255,255,255,.65),0 1px 2px rgba(0,0,0,.05),0 10px 28px -18px rgba(15,17,21,.45)}',
        '.ocq-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}',
        // Status LED: worst window's severity at a glance (neutral blue when
        // the row reports balances instead of windows).
        '.ocq-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 3px rgba(57,100,254,.14)}',
        '.ocq-status.is-ok{background:#22a06b;box-shadow:0 0 0 3px rgba(34,160,107,.15)}',
        '.ocq-status.is-warn{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16)}',
        '.ocq-status.is-crit{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}',
        '.ocq-title{font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#0f1115);flex:none}',
        '.ocq-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-right{margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        // Refresh: a quiet pill instead of bare text, with a real focus ring.
        '.ocq-refresh{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;padding:1px 9px;border-radius:999px;color:var(--dsw-alias-state-business-primary,#3964fe);font-size:11px;line-height:16px;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
        '.ocq-refresh:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
        '.ocq-refresh:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
        '.ocq-refresh:disabled{opacity:.55;cursor:default}',
        '.ocq-rates{display:flex;align-items:center;gap:14px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
        '.ocq-rate b{margin-left:4px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ocq-rate em{margin-left:4px;font-style:normal;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px 18px}',
        // Side column: a tracked micro-label over the balances, then rows with
        // a dotted leader — table-like alignment without extra chrome. The
        // primary balance (可用) is larger and brand-coloured for hierarchy.
        '.ocq-sidehead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-balances{display:flex;flex-direction:column;gap:8px}',
        '.ocq-balance{display:flex;align-items:baseline;gap:6px;font-size:12px}',
        '.ocq-lead{flex:1 1 auto;min-width:8px;border-bottom:1px dotted var(--dsw-alias-border-l2,rgba(0,0,0,.20));transform:translateY(-3px)}',
        '.ocq-balance span{color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-balance b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ocq-balance.is-primary b{font-size:14.5px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
        // Prepaid + chart mode (DeepSeek): balances left, chart right, so the
        // card stacks nothing vertically and stays short. Wraps to two lines
        // when the dock is too narrow for both (min-widths force the break
        // instead of squeezing the chart to nothing).
        '.ocq-split{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}',
        '.ocq-side{flex:0 1 148px;min-width:132px;display:flex;flex-direction:column;gap:6px}',
        '.ocq-main{flex:1 1 240px;min-width:180px}',
        // Structured fix-it panel (“请安装 XXX” + command + steps).
        '.ocq-hint{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
        '.ocq-hint-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ocq-code{display:block;box-sizing:border-box;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-state-business-primary,#3964fe);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;overflow-x:auto;white-space:nowrap;user-select:all}',
        '.ocq-step{position:relative;padding-left:14px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
        '.ocq-step::before{content:"›";position:absolute;left:4px;color:var(--dsw-alias-label-caption,#81858c)}',
        // Copy affordances: every command-like line and the install block can
        // go to the clipboard in one click; URLs become real links.
        '.ocq-coderow{display:flex;align-items:center;gap:6px}',
        '.ocq-coderow .ocq-code{flex:1 1 auto;min-width:0}',
        '.ocq-copybtn{flex:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:5px;padding:1px 6px;margin-left:6px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:border-color .15s ease,color .15s ease}',
        '.ocq-copybtn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ocq-copybtn.is-done{color:#22a06b;border-color:rgba(34,160,107,.45)}',
        '.ocq-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none;border-bottom:1px dotted currentColor;word-break:break-all}',
        '.ocq-link:hover{border-bottom-style:solid}',
        // Credential drawer: paste a Cookie/token/key (or a whole cURL) and
        // save it without opening the YAML file.
        '.ocq-drawer{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
        '.ocq-drawer.is-open{border-color:rgba(57,100,254,.35)}',
        '.ocq-drawer-btn{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#3964fe);font-size:11.5px;cursor:pointer;text-align:left}',
        '.ocq-drawer-caret{width:10px;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-drawer-btn em{font-style:normal;padding:0 5px;border-radius:4px;background:rgba(57,100,254,.12);font-size:10px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ocq-drawer-body{display:flex;flex-direction:column;gap:6px}',
        '.ocq-drawer-input{box-sizing:border-box;width:100%;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}',
        '.ocq-drawer-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
        '.ocq-drawer-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.ocq-drawer-ghost{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;border-radius:999px;padding:1px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
        '.ocq-drawer-ghost:hover{border-color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-drawer-save{border:1px solid var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff;border-radius:999px;padding:1px 11px;font-size:11px;cursor:pointer}',
        '.ocq-drawer-save:disabled{opacity:.5;cursor:default}',
        '.ocq-drawer-msg{font-size:11px;color:#22a06b}',
        '.ocq-drawer-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.ocq-drawer-note{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
        // Usage line chart: full content width, small side gutters.
        '.ocq-chart{display:flex;flex-direction:column;gap:5px;padding:3px 4px 0}',
        '.ocq-chart-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:11px}',
        '.ocq-chart-title{color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-chart-meta{color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ocq-chart-box{position:relative;width:100%;height:104px}',
        '.ocq-chart-svg{display:block;width:100%;height:104px}',
        // Shorter plot when the chart shares a row with the balance column.
        '.ocq-chart--sm .ocq-chart-box{height:74px}',
        '.ocq-chart--sm .ocq-chart-svg{height:74px}',
        '.ocq-chart-grid{stroke:var(--dsw-alias-border-l1,rgba(0,0,0,.07));stroke-width:1;stroke-dasharray:3 4;vector-effect:non-scaling-stroke}',
        '.ocq-chart-area{fill:url(#ocq-chart-fill)}',
        '.ocq-chart-line{fill:none;stroke:var(--dsw-alias-state-business-primary,#3964fe);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}',
        '.ocq-chart-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ocq-chart-now{color:var(--dsw-alias-state-business-primary,#3964fe)}',
        // Chart polish: a hairline baseline under the plot, the y-extremes as
        // HTML (never stretched), and a static marker on the newest point.
        '.ocq-chart-base{stroke:var(--dsw-alias-border-l2,rgba(0,0,0,.12));stroke-width:1;vector-effect:non-scaling-stroke;opacity:.55}',
        '.ocq-chart-yaxis{position:absolute;right:3px;top:1px;font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-caption,#81858c);opacity:.85;pointer-events:none;font-variant-numeric:tabular-nums}',
        '.ocq-chart-yaxis.is-zero{top:auto;bottom:2px;opacity:.6}',
        '.ocq-chart-mark{position:absolute;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#ffffff));transform:translate(-50%,-50%);pointer-events:none}',
        // Hover tooltip: a dashed guide marks the column, the bubble states
        // date · tokens · cost in words. Sibling of the SVG (box is relative),
        // pointer-events:none so it never steals the hover it is showing.
        '.ocq-hoverline{stroke:var(--dsw-alias-label-caption,#81858c);stroke-width:1;stroke-dasharray:2 3;vector-effect:non-scaling-stroke;opacity:.9}',
        '.ocq-tip{position:absolute;top:3px;z-index:2;pointer-events:none;padding:3px 7px;border-radius:6px;background:rgba(23,26,32,.94);color:#fff;font-size:10.5px;line-height:15px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.22);font-variant-numeric:tabular-nums;animation:ocq-fade .12s ease-out}',
        '.ocq-tip b{font-weight:600}',
        '.ocq-tip i{font-style:normal;opacity:.62;margin-left:5px}',
        '.ocq-cell{display:flex;flex-direction:column;gap:5px;min-width:0}',
        '.ocq-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
        '.ocq-name{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-pct{min-width:4ch;text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
        // Usage bar: a neutral inset track; the fill carries the ramp, scaled
        // to the track width so each colour marks its absolute usage level.
        '.ocq-track{position:relative;height:7px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));box-shadow:inset 0 1px 1px rgba(0,0,0,.05)}',
        '.ocq-fill{position:relative;height:100%;border-radius:4px;background-repeat:no-repeat;box-shadow:inset 0 1px 0 rgba(255,255,255,.22);transition:width .35s ease}',
        '.ocq-fill::after{content:"";position:absolute;top:0;right:0;bottom:0;width:2px;border-radius:0 4px 4px 0;background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,.3))}',
        // Reverse time bar: shrinks towards zero as the window drains.
        '.ocq-time{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));overflow:hidden;cursor:default}',
        '.ocq-timefill{height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(129,133,140,.30),rgba(129,133,140,.72));transition:width .5s ease}',
        '.ocq-foot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ocq-warn{color:var(--dsw-static-amber-500,#f59e0b)}',
        '.ocq-crit{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.ocq-dots{display:flex;align-items:center;gap:6px;padding-top:1px}',
        '.ocq-dotbtn{width:16px;height:14px;padding:0;border:0;background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
        '.ocq-dotbtn::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));transition:background .15s ease,width .15s ease}',
        '.ocq-dotbtn:hover::before{background:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-dotbtn[aria-current="true"]::before{width:14px;border-radius:3px;background:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ocq-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
        '.ocq-msg.ocq-crit{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        // ── motion ────────────────────────────────────────────────────────
        // Two moments only: DRAW (bars grow from 0, the line strokes itself,
        // cells fade up staggered) and SWITCH (the whole body swaps in, keyed
        // by the active subscription). No idle animation — the card stays
        // quiet while data sits still.
        '@keyframes ocq-grow{from{width:0}}',
        '@keyframes ocq-fade{from{opacity:0}}',
        '@keyframes ocq-swap{from{opacity:0;transform:translateY(5px)}}',
        '@keyframes ocq-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}',
        '.ocq-body{display:flex;flex-direction:column;gap:9px;animation:ocq-swap .26s cubic-bezier(.22,.7,.3,1)}',
        '.ocq-cell{animation:ocq-fade .3s ease-out both}',
        '.ocq-cell:nth-child(2){animation-delay:.05s}',
        '.ocq-cell:nth-child(3){animation-delay:.1s}',
        '.ocq-cell:nth-child(4){animation-delay:.15s}',
        // `backwards` on delayed animations: hold the from-state (width 0 /
        // hidden) during the delay instead of flashing the final frame first.
        '.ocq-fill{animation:ocq-grow .55s cubic-bezier(.22,.7,.3,1)}',
        '.ocq-timefill{animation:ocq-grow .55s .1s cubic-bezier(.22,.7,.3,1) backwards}',
        '.ocq-chart-line{stroke-dasharray:1;animation:ocq-draw .9s .12s ease-out backwards}',
        '.ocq-chart-area{animation:ocq-fade .9s .3s ease-out backwards}',
        '.ocq-hint{animation:ocq-fade .28s ease-out}',
        '.ocq-dots{animation:ocq-fade .28s ease-out}',
        // Honour the OS setting: never animate for users who opted out.
        '@media (prefers-reduced-motion:reduce){.ocq-body,.ocq-cell,.ocq-fill,.ocq-timefill,.ocq-chart-line,.ocq-chart-area,.ocq-hint,.ocq-dots,.ocq-tip{animation:none}}',
      ].join('')
      document.head.appendChild(tag)
    }

    // ── locale ─────────────────────────────────────────────────────────────
    function pickLocale() {
      try {
        const html = document.documentElement.lang || ''
        if (/^zh/i.test(html)) return 'zh'
        if (navigator.language && /^zh/i.test(navigator.language)) return 'zh'
      } catch {}
      return 'en'
    }

    // ── data helpers ───────────────────────────────────────────────────────
    const isOpenCodeGo = (provider) =>
      provider === OCGO_PROVIDER || String(provider ?? '').startsWith(`${OCGO_PROVIDER}/`)

    /**
     * Providers this plugin has a collector for — mirrors the host's
     * `inferKind`. The card stays visible for any of them (and for unknown
     * providers, fail-open), so selecting DeepSeek/Kimi/GLM doesn't hide the
     * subscriptions those vendors contribute.
     */
    const SUPPORTED_PROVIDER_RE = /opencode|deepseek|moonshot|kimi|glm|zai|zhipu|bigmodel|grok|xai|mimo|xiaomi|openrouter|siliconflow|silicon|qwen|qianwen|dashscope|aliyun|alibaba|token-plan|commandcode|command-code/i
    const isSupportedProvider = (provider) => {
      if (typeof provider !== 'string' || provider === '') return true // unknown → fail-open
      return SUPPORTED_PROVIDER_RE.test(provider)
    }

    /** Mirror of the host's `inferKind`: provider id → collector kind. */
    function providerKind(provider) {
      const s = String(provider ?? '').toLowerCase()
      if (s.includes('opencode')) return 'opencode-go'
      if (s.includes('deepseek')) return 'deepseek'
      if (s.includes('moonshot') || s.includes('kimi')) return 'moonshot'
      if (s.includes('glm') || s.includes('zai') || s.includes('zhipu') || s.includes('bigmodel')) return 'zai'
      if (s.includes('grok') || s.includes('xai')) return 'grok'
      if (s.includes('mimo') || s.includes('xiaomi')) return 'mimo'
      if (s.includes('openrouter')) return 'openrouter'
      if (s.includes('siliconflow') || s.includes('silicon')) return 'siliconflow'
      if (s.includes('qwen') || s.includes('qianwen') || s.includes('dashscope') || s.includes('token-plan')
          || s.includes('aliyun') || s.includes('alibaba') || s.includes('bailian')) return 'qwen'
      if (s.includes('commandcode') || s.includes('command-code')) return 'commandcode'
      return null
    }

    /**
     * The card follows the session's provider: pick ONLY the subscriptions
     * belonging to it, so switching models switches the billing view and hides
     * every other vendor.
     *
     * Match order:
     *   1. exact id            `deepseek` → `deepseek`, `qwen-token-plan-cn` → same,
     *                          user-defined ids match their provider name
     *   2. id/provider prefix  `opencode` → `opencode` (NOT `opencode-go`),
     *                          `deepseek-v4` → `deepseek`
     *   3. collector kind      `xai` → the `grok` row, `zhipu` → the `zai` row
     * Nothing matched → [] : the Hud explains it. Showing the full list here
     * was the bug that surfaced OpenCode billing while another model was
     * selected, so a non-empty provider NEVER borrows another vendor's row.
     * Only an empty provider (no model selected yet) keeps the whole list.
     */
    function filterForProvider(rows, provider) {
      const p = String(provider ?? '').trim().toLowerCase()
      if (!p || !Array.isArray(rows) || rows.length === 0) return rows
      const idOf = (r) => String(r.id ?? '').toLowerCase()
      let hit = rows.filter((r) => idOf(r) === p)
      if (hit.length === 0) {
        hit = rows.filter((r) => {
          const id = idOf(r)
          return id.startsWith(`${p}-`) || id.startsWith(`${p}/`) || p.startsWith(`${id}-`)
        })
      }
      if (hit.length > 0) return hit
      const kind = providerKind(p)
      if (kind) hit = rows.filter((r) => r.kind === kind)
      return hit // may be [] → explained by the Hud, never another vendor
    }

    function num(v) {
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    /** Percent used in [0,100] from any plausible field name. */
    function percentOf(w) {
      if (!w) return undefined
      const direct = num(w.percent) ?? num(w.percentUsed) ?? num(w.usedPercent) ?? num(w.usagePercent)
      if (direct !== undefined) return clamp(direct, 0, 100)
      const used = num(w.used)
      const total = num(w.total) ?? num(w.limit) ?? num(w.cap)
      if (used !== undefined && total !== undefined && total > 0) {
        return clamp((used / total) * 100, 0, 100)
      }
      return undefined
    }

    function resetsAtOf(w) {
      if (!w) return undefined
      const raw = w.resetsAt ?? w.resetAt ?? w.resets_at ?? w.windowEnd ?? w.expiresAt
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw
      if (typeof raw === 'string') {
        const t = new Date(raw).getTime()
        return Number.isFinite(t) ? t : undefined
      }
      return undefined
    }

    /** Compact countdown: 4天 6时 / 2时 15分 / 8分 / 即将重置. */
    function countdown(ms, lang) {
      if (!Number.isFinite(ms) || ms <= 0) return lang === 'zh' ? '即将重置' : 'soon'
      const m = Math.floor(ms / 60000)
      if (m < 60) return lang === 'zh' ? `${m} 分` : `${m}m`
      const h = Math.floor(m / 60)
      if (h < 24) return lang === 'zh' ? `${h} 时 ${m % 60} 分` : `${h}h ${m % 60}m`
      const d = Math.floor(h / 24)
      return lang === 'zh' ? `${d} 天 ${h % 24} 时` : `${d}d ${h % 24}h`
    }

    /** Threshold class for the percentage text: ≥80 danger, ≥60 warn. */
    function severity(pct) {
      if (pct >= DANGER_AT) return 'ocq-crit'
      if (pct >= WARN_AT) return 'ocq-warn'
      return ''
    }

    /** Tokens-per-second display: one decimal below 10, whole above. */
    function formatTps(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return null
      const v = Math.max(0, value)
      return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
    }

    async function fetchJson(url, init) {
      let res
      try {
        // A bounded wait: an unresponsive host must fail the poll, never hang
        // it — the in-flight guard below would otherwise stop future polls.
        res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000), ...init })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(/timeout|abort/i.test(msg) ? '请求超时（20s）' : `网络错误：${msg}`)
      }
      const json = await res.json().catch(() => null)
      if (!res.ok || !json || json.ok === false) {
        throw new Error(String(json?.error || (json ? `HTTP ${res.status}` : `HTTP ${res.status}（响应不是 JSON）`)))
      }
      return json
    }

    // ── usage line chart ────────────────────────────────────────────────────
    /**
     * Full-content-width line chart (small side gutters so it never touches
     * the card edge), time on x, tokens on y. The SVG stretches to 100 %
     * (`preserveAspectRatio: none`) with non-scaling strokes, so the line
     * stays 2 px whatever the card width; axis labels are HTML, not SVG text,
     * so they never distort.
     */
    function LineChart(props) {
      // Hook FIRST — the early return below must not change the hook count
      // between renders (a series growing from 1 to 2 points would otherwise
      // trip React's "Rendered fewer hooks" guard and kill the slot entry).
      const [hover, setHover] = React.useState(null)
      // Box measured on every pointer event so the bubble can sit at the
      // cursor's own coordinates inside it.
      const boxRef = React.useRef(null)
      const { points, from, to, granularity, tokens, cost, lang } = props
      if (!Array.isArray(points) || points.length < 2) return null
      const W = 1000
      const H = 104
      const TOP = 12
      const BOTTOM = 14
      const plotH = H - TOP - BOTTOM
      const max = Math.max(...points.map((p) => p.v), 1)
      // Raw maximum (0 for an all-zero month) — used by the y-axis label, so
      // an empty month reads "0" instead of the scale floor of 1.
      const maxRaw = Math.max(0, ...points.map((p) => p.v))
      const span = Math.max(1, to - from)
      const x = (t) => clamp((t - from) / span, 0, 1) * W
      const y = (v) => TOP + (1 - v / max) * plotH
      const linePath = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`)
        .join(' ')
      const baseY = (H - BOTTOM).toFixed(1)
      const areaPath = `${linePath} L${x(points[points.length - 1].t).toFixed(1)} ${baseY} L${x(points[0].t).toFixed(1)} ${baseY} Z`
      const stampOf = (t) => new Date(t).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      })
      const fmtNum = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)))
      const hitWidth = W / Math.max(points.length, 1)
      const title = lang === 'zh'
        ? (granularity === 'hour' ? '用量曲线（小时级）' : '用量曲线（按日聚合）')
        : (granularity === 'hour' ? 'Usage (hourly)' : 'Usage (daily buckets)')
      const tokensLabel = tokens === undefined ? ''
        : (lang === 'zh' ? `共 ${fmtNum(tokens)} tok` : `${fmtNum(tokens)} tok total`)
      const costLabel = cost === undefined || !cost ? '' : (lang === 'zh' ? ` · ¥${cost.toFixed(2)}` : ` · $${cost.toFixed(2)}`)
      // Split mode (shares a row with the balances column): drop the prose
      // title — the axis already states the range — and keep only the numbers.
      const compact = Boolean(props.compact)
      const meta = tokensLabel || costLabel ? `${tokensLabel}${costLabel}` : ''

      // Hover → text tooltip. The bubble FOLLOWS THE CURSOR on both axes: it
      // is anchored to the mouse, never to the data point, so pointer position
      // and tooltip position can never disagree (anchoring to the point left a
      // visible offset — up to half a column — and the edge-flip made it worse).
      // The dashed guide still marks the point: that is the exact datum.
      const track = (event, i) => {
        const el = boxRef.current
        let px
        let py
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            px = ((event.clientX - r.left) / r.width) * 100
            py = ((event.clientY - r.top) / r.height) * 100
          }
        }
        setHover({ i, px, py })
      }
      // Index is clamped so a poll that shortens the series can never point
      // the bubble at a removed point.
      const hi = hover && hover.i >= 0 && hover.i < points.length ? hover.i : null
      const tipPoint = hi === null ? null : points[hi]
      // Fallback to the point's x when an event carries no coordinates.
      // NOTE: `hover` itself is null before any pointer event — `??` only
      // guards the value, so the host needs optional chaining too. Reading
      // `hover.py` directly here crashed the whole slot entry on first paint.
      const tipPct = tipPoint ? (hover?.px ?? (x(tipPoint.t) / W) * 100) : 0
      const tipPctY = hover?.py ?? 4
      // Keep the bubble inside the card: flip horizontally near both edges,
      // and lift it ABOVE the cursor in the lower half of the plot.
      const tipAlignX = tipPct < 16 ? '0' : tipPct > 84 ? '-100%' : '-50%'
      const tipAlignY = tipPctY > 58 ? 'calc(-100% - 6px)' : '10px'
      const tipTransform = `translate(${tipAlignX}, ${tipAlignY})`
      const dayLabel = (t) => new Date(t).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit', day: '2-digit',
      })
      const money = lang === 'zh' ? '¥' : '$'
      const tipText = tipPoint
        ? `${granularity === 'day' ? dayLabel(tipPoint.t) : stampOf(tipPoint.t)} · ${fmtNum(tipPoint.v)} tok${tipPoint.c ? ` · ${money}${tipPoint.c.toFixed(2)}` : ''}`
        : ''

      return jsxs('div', { className: `ocq-chart${compact ? ' ocq-chart--sm' : ''}`, children: [
        compact
          ? (meta
              ? jsx('div', { className: 'ocq-chart-head', children: jsx('span', { className: 'ocq-chart-meta', children: meta }) })
              : null)
          : jsxs('div', { className: 'ocq-chart-head', children: [
              jsx('span', { className: 'ocq-chart-title', children: title }),
              meta ? jsx('span', { className: 'ocq-chart-meta', children: meta }) : null,
            ] }),
        jsxs('div', {
          className: 'ocq-chart-box',
          ref: boxRef,
          // Clear on LEAVING the whole box (not per column): crossing from one
          // column to the next then never flickers the tooltip away.
          onMouseLeave: () => setHover(null),
          children: [
            jsxs('svg', {
              className: 'ocq-chart-svg',
              viewBox: `0 0 ${W} ${H}`,
              preserveAspectRatio: 'none',
              role: 'img',
              'aria-label': title,
              children: [
                jsxs('defs', { children: jsxs('linearGradient', {
                  id: 'ocq-chart-fill',
                  x1: 0, y1: 0, x2: 0, y2: 1,
                  children: [
                    jsx('stop', { offset: '0%', 'stop-color': 'var(--dsw-alias-state-business-primary,#3964fe)', 'stop-opacity': 0.3 }),
                    jsx('stop', { offset: '100%', 'stop-color': 'var(--dsw-alias-state-business-primary,#3964fe)', 'stop-opacity': 0 }),
                  ],
                }) }),
                [0.25, 0.5, 0.75].map((f) => jsx('line', {
                  x1: 0, x2: W, y1: TOP + plotH * f, y2: TOP + plotH * f, className: 'ocq-chart-grid',
                }, `g${f}`)),
                // Hairline baseline: the plotted area sits on something.
                jsx('line', {
                  x1: 0, x2: W, y1: H - BOTTOM, y2: H - BOTTOM,
                  className: 'ocq-chart-base',
                }, 'base'),
                jsx('path', { d: areaPath, className: 'ocq-chart-area' }),
                // pathLength=1 lets CSS stroke the line in (dashoffset 1 → 0)
                // without measuring the path in JS.
                jsx('path', { d: linePath, className: 'ocq-chart-line', pathLength: 1 }),
                // Hovered column: a dashed vertical guide (a vertical line is
                // the one stroke the non-uniform x/y stretch cannot distort).
                tipPoint
                  ? jsx('line', {
                      x1: x(tipPoint.t), x2: x(tipPoint.t), y1: 0, y2: H,
                      className: 'ocq-hoverline',
                    }, 'guide')
                  : null,
                points.map((p, i) => jsx('rect', {
                  x: clamp(x(p.t) - hitWidth / 2, 0, W),
                  y: 0,
                  width: hitWidth,
                  height: H,
                  fill: 'transparent',
                  // Enter picks the column; move keeps the bubble pinned to the
                  // cursor while it travels across it.
                  onMouseEnter: (e) => track(e, i),
                  onMouseMove: (e) => track(e, i),
                }, `h${i}`)),
              ],
            }, 'svg'),
            // Text tooltip: date · tokens · cost, pinned at the CURSOR's
            // coordinates inside the chart box (guide line stays on the point).
            tipPoint
              ? jsx('div', {
                  className: 'ocq-tip',
                  'aria-hidden': true,
                  style: {
                    left: `${tipPct}%`,
                    top: `${tipPctY}%`,
                    transform: tipTransform,
                  },
                  children: tipText,
                }, 'tip')
              : null,
            // Y-extremes as HTML — SVG text would stretch with the box — and a
            // static marker on the newest point (HTML dot: a circle inside the
            // non-uniform viewBox would render as an ellipse).
            jsx('div', { className: 'ocq-chart-yaxis', children: maxRaw === 0 ? '0' : fmtNum(maxRaw) }, 'ymax'),
            jsx('div', { className: 'ocq-chart-yaxis is-zero', children: '0' }, 'yzero'),
            jsx('div', {
              className: 'ocq-chart-mark',
              style: {
                left: `${(x(points[points.length - 1].t) / W) * 100}%`,
                top: `${(y(points[points.length - 1].v) / H) * 100}%`,
              },
            }, 'mark'),
          ],
        }),
        jsxs('div', { className: 'ocq-chart-axis', children: [
          jsx('span', { children: stampOf(from) }),
          jsx('span', { children: stampOf((from + to) / 2) }),
          jsx('span', { className: 'ocq-chart-now', children: lang === 'zh' ? '现在' : 'now' }),
        ] }),
      ] })
    }

    // ── paste helpers for the credential drawer ─────────────────────────────
    /**
     * Normalize whatever the user pasted into something a collector can use.
     * Handles: whole `curl …` commands (Copy as cURL), `Cookie:`/`Authorization:`
     * header lines, bare `Bearer …`, and JSON wrappers. NEVER logs the value.
     * @param {string} raw
     * @param {string} ref
     * @returns {{ value: string, kind: string, note: string }}
     */
    function parseSecret(raw, ref) {
      let text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) return { value: '', kind: 'empty', note: '' }
      const wantCookie = /cookie/i.test(String(ref ?? ''))
      const stripBearer = (s) => s.replace(/^bearer\s+/i, '').trim()

      if (/^curl[\s'"]/i.test(text)) {
        // Copy as cURL → extract the auth headers (order: requested kind first).
        const headers = {}
        for (const m of text.matchAll(/(?:-H|--header)\s+(['"])([^'"]*)\1/g)) {
          const idx = m[2].indexOf(':')
          if (idx > 0) headers[m[2].slice(0, idx).trim().toLowerCase()] = m[2].slice(idx + 1).trim()
        }
        const cookie = headers.cookie
        const auth = headers.authorization ?? headers['x-api-key'] ?? headers['x-auth-token']
        const picked = wantCookie || (!auth && cookie) ? cookie : auth
        if (!picked) return { value: '', kind: 'curl', note: 'cURL 里没有 Cookie / Authorization 头' }
        const isCookie = picked === cookie
        return {
          value: isCookie ? picked : stripBearer(picked),
          kind: isCookie ? 'cookie' : 'bearer',
          note: `已从 cURL 解析出${isCookie ? ' Cookie 头' : '认证头'}`,
        }
      }
      if (/^cookie:\s*/i.test(text)) {
        return { value: text.replace(/^cookie:\s*/i, '').trim(), kind: 'cookie', note: '识别为 Cookie 头' }
      }
      if (/^(authorization|x-api-key|x-auth-token):/i.test(text)) {
        return { value: stripBearer(text.replace(/^[^:]+:\s*/i, '')), kind: 'bearer', note: '识别为认证头' }
      }
      if (/^bearer\s+/i.test(text)) {
        return { value: stripBearer(text), kind: 'bearer', note: '已去掉 Bearer 前缀' }
      }
      if (text.startsWith('{')) return { value: text, kind: 'json', note: '识别为 JSON 包装（按原样保存，插件会取 value）' }
      return { value: text, kind: wantCookie ? 'cookie' : 'key', note: '' }
    }

    /** Hint steps that are obviously shell commands / code worth copying. */
    const looksCopyable = (s) =>
      /^(npm|pnpm|yarn|npx|node|grok|qianwen|codex|opencode|curl|dsh|copy\(|localStorage|GET |POST )\b/i.test(String(s).trim())
      || /`[^`]+`/.test(String(s))
    const codeOf = (s) => {
      const m = /`([^`]+)`/.exec(String(s))
      return m ? m[1] : (looksCopyable(s) ? String(s).trim() : null)
    }
    const urlOf = (s) => (String(s).match(/https?:\/\/[^\s，。；）)]+/) || [])[0] ?? null

    // ── component ──────────────────────────────────────────────────────────
    function Hud(props = {}) {
      const lang = pickLocale()
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [, setTick] = React.useState(0)
      const [subIndex, setSubIndex] = React.useState(0)
      const [hovering, setHovering] = React.useState(false)
      // Credential drawer: paste → POST → refresh. Never holds state longer
      // than the interaction (the draft is cleared after a successful save).
      const [drawerOpen, setDrawerOpen] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveMsg, setSaveMsg] = React.useState(null) // { ok, text } | null
      const [copiedKey, setCopiedKey] = React.useState(null)

      // ── rates: session average + this run's instant rate ────────────────
      // Same source as the composer status line (`sessionStats` projection).
      // A missing or throwing projection must not take the card down — the
      // rates simply read as "—" while everything else keeps working.
      let stats
      try {
        stats = typeof props?.useProjection === 'function' ? props.useProjection('sessionStats') : undefined
      } catch (e) {
        dbg('sessionStats projection unavailable', e)
        stats = undefined
      }
      const sampleRef = React.useRef({ tokens: undefined, at: 0, instant: null })
      const decodeMs = num(stats?.decodeMs) ?? 0
      const decodeTokens = num(stats?.decodeTokens) ?? 0
      const avgTps = decodeMs > 0 && decodeTokens > 0 ? decodeTokens / (decodeMs / 1000) : null
      const sampleNow = Date.now()
      if (decodeTokens > 0) {
        const s = sampleRef.current
        if (s.tokens === undefined) {
          s.tokens = decodeTokens
          s.at = sampleNow
        } else if (decodeTokens > s.tokens) {
          const dt = (sampleNow - s.at) / 1000
          if (dt >= 0.35) {
            s.instant = (decodeTokens - s.tokens) / dt
            s.tokens = decodeTokens
            s.at = sampleNow
          }
        }
      }
      const instantTps = sampleRef.current.instant

      // One poll at a time: the interval fires every `pollMs`, and a slow host
      // would otherwise stack overlapping requests (and stale responses) —
      // the last writer must not be an out-of-order reply.
      const inFlightRef = React.useRef(false)
      // Set false on unmount so late responses never setState on a dead card.
      const aliveRef = React.useRef(true)
      React.useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      const poll = React.useCallback(() => {
        if (inFlightRef.current) return
        inFlightRef.current = true
        fetchJson('/dsh-hud/quota/usage').then((json) => {
          if (aliveRef.current) {
            setSnapshot(json)
            setError(null)
          }
        }, (e) => {
          if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
        }).then(() => { inFlightRef.current = false }, () => { inFlightRef.current = false })
      }, [])

      // Live cadence from the host (`pollMs`), clamped to the 30 s floor and
      // re-armed whenever the configured value changes.
      const pollMs = React.useMemo(
        () => clamp(num(snapshot?.pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS),
        [snapshot],
      )
      const onTick = React.useCallback(() => setTick((n) => n + 1), [])

      // First fetch + refresh when the tab comes back.
      React.useEffect(() => {
        dbg('hud mounted', { model: props.model, pollMs })
        poll()
        const onVisible = () => {
          if (document.visibilityState === 'visible') poll()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [poll])

      // Poll + clock timers, re-armed when the cadence changes.
      React.useEffect(() => {
        let stop
        try {
          if (typeof props.startTimers === 'function') {
            stop = props.startTimers(poll, pollMs, onTick, CLOCK_MS)
          } else {
            const a = window.setInterval(poll, pollMs)
            const b = window.setInterval(onTick, CLOCK_MS)
            stop = () => {
              window.clearInterval(a)
              window.clearInterval(b)
            }
          }
        } catch (e) {
          // A timer failure must never take the card down: the mount fetch
          // already painted it and visibilitychange keeps it fresh.
          console.error('[ocq] timers unavailable:', e)
        }
        return () => {
          try {
            if (typeof stop === 'function') stop()
          } catch {}
        }
      }, [poll, onTick, pollMs, props.startTimers])

      const refresh = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const json = await fetchJson('/dsh-hud/quota/refresh', { method: 'POST' })
          if (aliveRef.current) {
            setSnapshot(json)
            setError(null)
          }
        } catch (e) {
          if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [busy])

      const subscriptions = React.useMemo(() => {
        const list = Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions : []
        let rows
        if (list.length > 0) rows = filterForProvider(list.map(normalizeRow), props.provider)
        else if (snapshot?.usage != null) rows = [normalizeRow({ id: 'opencode-go', label: 'opencode-go', usage: snapshot.usage })]
        else rows = []
        // Nothing matched the provider (fallback list): put any row mentioning
        // it first so its billing still opens on top.
        const p = String(props.provider ?? '').toLowerCase()
        if (!p || rows.length < 2) return rows
        const hit = rows.findIndex((r) => String(r.id).toLowerCase().includes(p))
        return hit > 0 ? [rows[hit], ...rows.slice(0, hit), ...rows.slice(hit + 1)] : rows
      }, [snapshot, props.provider])

      // Switching model jumps straight to the new vendor's billing view
      // instead of keeping the old carousel position.
      React.useEffect(() => {
        setSubIndex(0)
      }, [props.provider])

      const count = subscriptions.length
      const activeIndex = count > 0 ? Math.abs(subIndex) % count : 0
      const active = count > 0 ? subscriptions[activeIndex] : undefined

      // Auto-rotate through the subscriptions while not hovered — and while
      // the tab is visible: re-mounting the body in a background tab would
      // replay animations nobody sees (and burn frames).
      React.useEffect(() => {
        if (count <= 1 || hovering) return undefined
        const id = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          setSubIndex((i) => i + 1)
        }, CAROUSEL_MS)
        return () => window.clearInterval(id)
      }, [count, hovering])

      // ── credential drawer: parse the paste → POST → force refresh ────────
      const missingCreds = React.useMemo(
        () => (active?.credentials ?? []).filter((c) => !c.present),
        [active],
      )
      const missingRef = missingCreds[0]?.ref ?? null
      const parsedSecret = React.useMemo(() => parseSecret(draft, missingRef), [draft, missingRef])

      /** Copy with a visible "已复制" tick; falls back to execCommand. */
      const copyText = React.useCallback(async (text) => {
        let ok = false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            ok = true
          }
        } catch { ok = false }
        if (!ok) {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body?.appendChild(ta)
            ta.select()
            document.execCommand?.('copy')
            ta.remove?.()
            ok = true
          } catch { ok = false }
        }
        if (!ok || !aliveRef.current) return
        setCopiedKey(text)
        window.setTimeout(() => {
          if (aliveRef.current) setCopiedKey((cur) => (cur === text ? null : cur))
        }, 1400)
      }, [])

      const readClipboard = React.useCallback(async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (text && aliveRef.current) {
            setDraft(text.trim())
            setSaveMsg(null)
          }
        } catch {
          if (aliveRef.current) {
            setSaveMsg({
              ok: false,
              text: lang === 'zh' ? '剪贴板读取被拒，请直接在输入框粘贴（Ctrl+V）' : 'Clipboard blocked — paste into the field instead',
            })
          }
        }
      }, [lang])

      const saveCredential = React.useCallback(async () => {
        if (saving || !missingRef) return
        const secret = parseSecret(draft, missingRef)
        if (!secret.value) return
        setSaving(true)
        try {
          const json = await fetchJson('/dsh-hud/quota/credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ref: missingRef, value: secret.value }),
          })
          if (!aliveRef.current) return
          setDraft('') // the secret leaves the DOM immediately after the write
          setSaveMsg({
            ok: true,
            text: lang === 'zh' ? `已保存到 ${json.how ?? 'credentials'}` : `Saved to ${json.how ?? 'credentials'}`,
          })
          await refresh() // present:true → the drawer moves to the next ref
        } catch (e) {
          if (aliveRef.current) setSaveMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
        } finally {
          if (aliveRef.current) setSaving(false)
        }
      }, [saving, missingRef, draft, lang, refresh])

      /** Save-drawer target + the paste preview shown while open. */
      const missingCredsText = missingCreds.length > 1 ? `(+${missingCreds.length - 1})` : ''

      /**
       * One hint line: URLs become real links (open the platform in a click),
       * command-looking lines get a copy button. Keeps the host's step strings
       * untouched — all rendering logic lives here.
       */
      const stepNodes = (text, id) => {
        const raw = String(text)
        const url = urlOf(raw)
        const code = codeOf(raw)
        const parts = url ? raw.split(url) : [raw]
        const children = []
        parts.forEach((part, idx) => {
          children.push(part)
          if (url && idx < parts.length - 1) {
            children.push(jsx('a', {
              className: 'ocq-link',
              href: url,
              target: '_blank',
              rel: 'noreferrer noopener',
              key: `${id}-link`,
              children: url,
            }))
          }
        })
        if (code) {
          const done = copiedKey === code
          children.push(jsx('button', {
            type: 'button',
            key: `${id}-copy`,
            className: `ocq-copybtn${done ? ' is-done' : ''}`,
            title: lang === 'zh' ? '复制到剪贴板' : 'Copy to clipboard',
            onClick: () => copyText(code),
            children: done
              ? (lang === 'zh' ? '已复制' : 'Copied')
              : (lang === 'zh' ? '复制' : 'Copy'),
          }))
        }
        return children
      }

      const now = Date.now()
      // Only the windows the subscription actually reports are drawn — a plan
      // with 5h+weekly draws two cells, a monthly-only plan draws one.
      const cells = []
      for (const win of active?.windows ?? []) {
        // Built-ins use the localized catalog; a user-defined source may ship
        // its own key/label, so fall back instead of dropping the cell.
        const meta = WINDOW_META[win.key] ?? {
          key: win.key,
          zh: win.label ?? win.key,
          en: win.label ?? win.key,
          spanMs: 7 * 86400_000,
        }
        if (!meta) continue
        const pct = win.percent
        const cls = severity(pct)
        const width = `${clamp(pct, 0, 100)}%`
        const end = win.resetsAt
        const elapsed = end === undefined ? undefined : clamp((meta.spanMs - (end - now)) / meta.spanMs, 0, 1)
        const remaining = elapsed === undefined ? null : clamp((1 - elapsed) * 100, 0, 100)
        const resetAt = end === undefined ? null : new Date(end).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
        const resetTip = end === undefined
          ? (lang === 'zh' ? '重置时间未知' : 'reset time unknown')
          : (lang === 'zh'
              ? `重置于 ${resetAt}（${countdown(end - now, lang)}后）`
              : `resets at ${resetAt} (${countdown(end - now, lang)} left)`)
        // Absolute quota detail when the source reports it (千问 Token Plan):
        // `13,284 / 180,000 Credits` — more informative than repeating 7%.
        const credits = win.used !== undefined && win.total !== undefined
          ? `${win.used.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')} / ${win.total.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}${win.unit ? ` ${win.unit}` : ''}`
          : null
        const barTitle = lang === 'zh'
          ? (credits ? `已用 ${Math.round(pct)}% · ${credits}` : `已用 ${Math.round(pct)}%`)
          : (credits ? `${Math.round(pct)}% used · ${credits}` : `${Math.round(pct)}% used`)
        cells.push(
          jsxs('div', { className: 'ocq-cell', children: [
            jsxs('div', { className: 'ocq-row', children: [
              jsx('span', { className: 'ocq-name', children: lang === 'zh' ? meta.zh : meta.en }),
              jsx('span', { className: `ocq-pct ${cls}`.trim(), children: `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%` }),
            ] }),
            jsx('div', {
              className: 'ocq-track',
              title: barTitle,
              children: jsx('div', {
                className: 'ocq-fill',
                style: {
                  width,
                  backgroundImage: USAGE_GRADIENT,
                  // Anchor the ramp to the TRACK, not the fill: a 30 % bar
                  // shows the first 30 % of the palette, never a squashed one.
                  backgroundSize: pct > 0 ? `${10000 / pct}% 100%` : '100% 100%',
                },
              }),
            }),
            // Reverse time bar: only when a reset time is known.
            end === undefined
              ? null
              : jsx('div', {
                  className: 'ocq-time',
                  title: resetTip,
                  children: jsx('div', {
                    className: 'ocq-timefill',
                    style: { width: remaining === null ? '0%' : `${remaining}%` },
                  }),
                }),
            jsxs('div', { className: 'ocq-foot', children: [
              jsx('span', {
                children: credits
                  ? credits
                  : (elapsed === undefined
                      ? (lang === 'zh' ? '窗口进度 —' : 'window —')
                      : (lang === 'zh' ? `已过 ${Math.round(elapsed * 100)}%` : `${Math.round(elapsed * 100)}% elapsed`)),
              }),
              jsx('span', {
                children: end === undefined
                  ? ''
                  : (lang === 'zh' ? `${countdown(end - now, lang)}后重置` : `resets in ${countdown(end - now, lang)}`),
              }),
            ] }),
          ] }, win.key),
        )
      }

      // Prepaid subscriptions (DeepSeek / Kimi) report balances, not windows.
      const balances = active?.balances ?? []
      const series = Array.isArray(active?.series) ? active.series : []
      // A row carrying BOTH balances and a usage chart (DeepSeek) renders side
      // by side — balances left, chart right — so the card never stacks the
      // two vertically. Window-only plans (OpenCode, Qwen…) are untouched.
      const splitMode = balances.length > 0 && series.length > 1
      const balanceRows = balances.map((b, idx) => {
        const label = BALANCE_LABELS[b.key] ?? [b.key, b.key]
        const value = typeof b.value === 'number' && Number.isFinite(b.value)
          ? b.value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 4 })
          : String(b.value ?? '—')
        // In split mode the currency heads the column once, not every row.
        const suffix = !splitMode && b.currency ? ` (${b.currency})` : ''
        return jsxs('div', { className: `ocq-balance${idx === 0 ? ' is-primary' : ''}`, children: [
          jsx('span', { children: `${lang === 'zh' ? label[0] : label[1]}${suffix}` }),
          // Dotted leader: rows align like a table without extra borders.
          jsx('i', { className: 'ocq-lead', 'aria-hidden': true }),
          jsx('b', { children: value }),
        ] }, b.key)
      })
      const balanceCurrency = splitMode
        ? (balances.find((b) => b.currency)?.currency ?? '')
        : ''

      const stamp = snapshot?.fetchedAt
        ? new Date(snapshot.fetchedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
        : null
      const avgText = formatTps(avgTps)
      const instantText = formatTps(instantTps)
      // Split mode with no session running: two rows of "—" say nothing, so
      // the rate line disappears until there is a number to show.
      const showRates = !(splitMode && avgText === null && instantText === null)

      // The provider is a known vendor but no subscription row exists for it:
      // explain instead of borrowing another vendor's billing.
      const unmatched = Array.isArray(snapshot?.subscriptions)
        && snapshot.subscriptions.length > 0
        && count === 0
      const providerName = String(props.provider ?? '').trim()
      const unmatchedHint = unmatched
        ? {
            title: lang === 'zh' ? `未发现 ${providerName || '当前供应商'} 的订阅` : `No subscription for ${providerName || 'this provider'}`,
            steps: lang === 'zh'
              ? [
                  '不会拿别家的额度顶替显示',
                  '订阅来自三处：llm-pi-ai provider 表 + 内置发现（如官方 deepseek-official）+ subscriptions 显式配置',
                  '自定义：设置 → 插件 → 配置 → subscriptions 加 { "id": "<与 provider 同名>", "kind": "custom2", "url", "windows": [...] }（id 必须等于 provider 名才会匹配）',
                ]
              : [
                  "Another vendor's quota is never substituted",
                  'Rows come from the llm-pi-ai provider table, built-in discovery (e.g. deepseek-official), and explicit subscriptions',
                  'Custom source: add { "id": "<same as provider>", "kind": "custom2", "url", "windows": [...] } under Settings → Plugins → subscriptions (the id must equal the provider name)',
                ],
          }
        : undefined
      const shownHint = active?.hint ?? unmatchedHint

      // Title follows what the subscription reports: window limits vs balance.
      const titleText = cells.length > 0 || balanceRows.length === 0
        ? (lang === 'zh' ? '用量限额' : 'Usage limits')
        : (lang === 'zh' ? '账户余额' : 'Account balance')
      const subText = active
        ? (active.plan ? `${active.label} · ${active.plan}` : active.label)
        : (unmatched && providerName ? providerName : null)

      // Status LED in the header: the WORST window's severity at a glance;
      // balance-only rows stay neutral blue, a failed query lights it red.
      const worstPct = cells.length > 0
        ? Math.max(...(active?.windows ?? []).map((w) => num(w.percent) ?? 0))
        : null
      const statusCls = active?.error
        ? ' is-crit'
        : worstPct === null ? '' : worstPct >= 80 ? ' is-crit' : worstPct >= 60 ? ' is-warn' : ' is-ok'
      const statusTitle = active?.error
        ? (lang === 'zh' ? '查询失败' : 'query failed')
        : worstPct === null
          ? (lang === 'zh' ? '订阅状态' : 'subscription status')
          : (lang === 'zh' ? `最高用量 ${Math.round(worstPct)}%` : `peak usage ${Math.round(worstPct)}%`)

      return jsx('div', {
        className: 'ocq-root',
        onMouseEnter: () => setHovering(true),
        onMouseLeave: () => setHovering(false),
        children: jsxs('div', { className: 'ocq-card', children: [
          jsxs('div', { className: 'ocq-head', children: [
            jsx('span', { className: `ocq-status${statusCls}`, title: statusTitle, 'aria-hidden': true }),
            jsx('span', { className: 'ocq-title', children: titleText }),
            subText
              ? jsx('span', { className: 'ocq-sub', title: subText, children: subText })
              : null,
            jsxs('span', { className: 'ocq-right', children: [
              // Timestamp lives in the refresh button's tooltip in split mode —
              // repeating it in the header just adds a line for nothing.
              stamp && !splitMode
                ? jsx('span', { title: lang === 'zh' ? '上次更新' : 'Last updated', children: stamp })
                : null,
              jsx('button', {
                type: 'button',
                className: 'ocq-refresh',
                onClick: refresh,
                disabled: busy,
                title: stamp
                  ? (lang === 'zh' ? `上次更新 ${stamp}` : `Last updated ${stamp}`)
                  : undefined,
                children: busy
                  ? (lang === 'zh' ? '刷新中' : 'refreshing')
                  : (lang === 'zh' ? '刷新' : 'refresh'),
              }),
            ] }),
          ] }),
          showRates
            ? jsxs('div', { className: 'ocq-rates', children: [
                jsxs('span', { className: 'ocq-rate', children: [
                  lang === 'zh' ? '速率' : 'rate',
                  jsx('b', { children: avgText === null ? '—' : `${avgText} tok/s` }),
                ] }),
                jsxs('span', { className: 'ocq-rate', children: [
                  lang === 'zh' ? '本次速率' : 'this run',
                  jsx('b', { children: instantText === null ? '—' : `${instantText} tok/s` }),
                  instantText === null && avgText !== null
                    ? jsx('em', { children: lang === 'zh' ? '（待开始）' : '(idle)' })
                    : null,
                ] }),
              ] })
            : null,
          // Everything from here down re-mounts as ONE unit when the active
          // subscription changes (provider switch or carousel step). That key
          // is what triggers the swap animation — bars, chart and cells then
          // draw themselves in again via their own CSS animations.
          jsxs('div', {
            className: 'ocq-body',
            children: [
              active?.error && cells.length === 0 && balanceRows.length === 0
                ? jsx('div', { className: 'ocq-msg ocq-crit', children: `${active.label}: ${active.error}` })
                : null,
              !active?.error && cells.length === 0 && balanceRows.length === 0 && !error && !unmatched
                ? jsx('div', { className: 'ocq-msg', children: lang === 'zh' ? '正在获取用量数据…' : 'Loading usage data…' })
                : null,
              // Structured fix-it panel: “请安装 XXX” / “未发现该供应商的订阅”.
              // Commands are one click from the clipboard, URLs open the
              // platform directly — no re-typing anything.
              shownHint
                ? jsxs('div', { className: 'ocq-hint', children: [
                    jsx('div', { className: 'ocq-hint-title', children: shownHint.title }),
                    shownHint.install
                      ? jsxs('div', { className: 'ocq-coderow', children: [
                          jsx('code', { className: 'ocq-code', children: shownHint.install }),
                          jsx('button', {
                            type: 'button',
                            className: `ocq-copybtn${copiedKey === shownHint.install ? ' is-done' : ''}`,
                            title: lang === 'zh' ? '复制到剪贴板' : 'Copy to clipboard',
                            onClick: () => copyText(shownHint.install),
                            children: copiedKey === shownHint.install
                              ? (lang === 'zh' ? '已复制' : 'Copied')
                              : (lang === 'zh' ? '复制' : 'Copy'),
                          }),
                        ] })
                      : null,
                    ...shownHint.steps.map((s, i) => jsx('div', { className: 'ocq-step', children: stepNodes(s, `s${i}`) }, `s${i}`)),
                  ] })
                : null,
              // Credential drawer: save a Cookie/token/key straight from the
              // card — no YAML editing. Shows only REFS (never values), and
              // walks to the next missing ref after each save.
              missingRef
                ? jsxs('div', { className: `ocq-drawer${drawerOpen ? ' is-open' : ''}`, children: [
                    jsxs('button', {
                      type: 'button',
                      className: 'ocq-drawer-btn',
                      onClick: () => { setDrawerOpen((v) => !v); setSaveMsg(null) },
                      children: [
                        jsx('span', { className: 'ocq-drawer-caret', children: drawerOpen ? '▾' : '▸' }),
                        lang === 'zh' ? `配置 ${missingRef}` : `Configure ${missingRef}`,
                        missingCredsText ? jsx('em', { children: missingCredsText }) : null,
                      ],
                    }),
                    drawerOpen
                      ? jsxs('div', { className: 'ocq-drawer-body', children: [
                          jsx('input', {
                            className: 'ocq-drawer-input',
                            type: 'text',
                            value: draft,
                            spellCheck: false,
                            autoComplete: 'off',
                            'aria-label': missingRef,
                            placeholder: lang === 'zh'
                              ? '粘贴 Cookie / token / key / 整条 Copy as cURL'
                              : 'Paste a Cookie, token, key or a whole cURL command',
                            onChange: (e) => { setDraft(e.target.value); setSaveMsg(null) },
                          }),
                          jsxs('div', { className: 'ocq-drawer-actions', children: [
                            jsx('button', {
                              type: 'button',
                              className: 'ocq-drawer-ghost',
                              onClick: readClipboard,
                              children: lang === 'zh' ? '读取剪贴板' : 'From clipboard',
                            }),
                            jsx('button', {
                              type: 'button',
                              className: 'ocq-drawer-save',
                              disabled: saving || !draft.trim(),
                              onClick: saveCredential,
                              children: saving
                                ? (lang === 'zh' ? '保存中…' : 'Saving…')
                                : (lang === 'zh' ? '保存' : 'Save'),
                            }),
                            saveMsg
                              ? jsx('span', { className: `ocq-drawer-msg${saveMsg.ok ? '' : ' is-err'}`, children: saveMsg.text })
                              : null,
                          ] }),
                          parsedSecret.note
                            ? jsx('div', { className: 'ocq-drawer-note', children: parsedSecret.note })
                            : null,
                        ] })
                      : null,
                  ] })
                : null,
              cells.length > 0 ? jsx('div', { className: 'ocq-grid', children: cells }) : null,
              // Prepaid + chart (DeepSeek): balances and the month-long usage
              // chart share ONE row — this is what makes the card short. One
              // currency label heads the column instead of repeating every row.
              splitMode
                ? jsxs('div', { className: 'ocq-split', children: [
                    jsxs('div', { className: 'ocq-side', children: [
                      jsxs('div', { className: 'ocq-sidehead', children: [
                        jsx('span', { children: lang === 'zh' ? '余额' : 'Balance' }),
                        balanceCurrency ? jsx('span', { children: balanceCurrency }) : null,
                      ] }),
                      jsx('div', { className: 'ocq-balances', children: balanceRows }),
                    ] }),
                    jsx('div', { className: 'ocq-main', children: jsx(LineChart, {
                      points: series,
                      // Host ships the exact window (last 30 days); fall back
                      // to a month only for payloads without the bounds.
                      from: active.seriesFrom ?? now - 30 * 86400_000,
                      to: active.seriesTo ?? now,
                      granularity: active.granularity,
                      tokens: active.seriesTokens,
                      cost: active.seriesCost,
                      lang,
                      compact: true,
                    }) }),
                  ] })
                : null,
              !splitMode && balanceRows.length > 0
                ? jsx('div', { className: 'ocq-balances', children: balanceRows })
                : null,
              // Usage line chart, stacked only when it shares no row.
              !splitMode && series.length > 1
                ? jsx(LineChart, {
                    points: series,
                    from: active.seriesFrom ?? now - 30 * 86400_000,
                    to: active.seriesTo ?? now,
                    granularity: active.granularity,
                    tokens: active.seriesTokens,
                    cost: active.seriesCost,
                    lang,
                  })
                : null,
              count > 1
                ? jsxs('div', { className: 'ocq-dots', children: subscriptions.map((sub, i) =>
                    jsx('button', {
                      type: 'button',
                      className: 'ocq-dotbtn',
                      'aria-current': i === activeIndex ? 'true' : 'false',
                      'aria-label': sub.label,
                      title: sub.label,
                      onClick: () => setSubIndex(i),
                    }, sub.id || String(i)),
                  ) })
                : null,
              error && cells.length > 0
                ? jsx('div', { className: 'ocq-msg ocq-crit', children: error })
                : null,
            ],
          }, active?.id ?? (unmatched ? `unmatched:${providerName}` : 'idle')),
        ] }),
      })
    }

    // ── provider gate ──────────────────────────────────────────────────────
    /** Normalize a `{ provider, model }`-ish selection. */
    function fromSelection(sel) {
      if (!sel) return undefined
      if (typeof sel === 'string') {
        const [provider, ...rest] = sel.split('/')
        return provider ? { provider, model: rest.length ? rest.join('/') : undefined } : undefined
      }
      const provider = sel.provider ?? sel.providerId
      if (typeof provider !== 'string' || provider === '') return undefined
      const model = sel.model ?? sel.name ?? sel.id
      return { provider, model: typeof model === 'string' && model !== '' ? model : undefined }
    }

    /**
     * The session's live model selection, read from the `modelSelection`
     * projection face — the same source the composer's submit state uses
     * (`session.projections.faceOf("modelSelection")` → `{ next?, lastUsed? }`).
     */
    // The slot runtime sometimes invokes the component with NO props object at
    // all (seen in the wild as `reading 'useProjection' of undefined`) — every
    // entry point therefore defaults to `{}` and reads defensively.
    function projectionSelection(props) {
      const hook = props?.useProjection
      if (typeof hook !== 'function') return undefined
      let face
      try {
        face = hook('modelSelection')
      } catch {
        return undefined
      }
      if (!face || typeof face !== 'object') return undefined
      return fromSelection(face.next) ?? fromSelection(face.lastUsed) ?? fromSelection(face)
    }

    /** Fallback probe across the other session-scoped standard hooks. */
    function hookSelection(props) {
      const hooks = [props?.useConversation, props?.useSession, props?.useSessions]
      for (const hook of hooks) {
        if (typeof hook !== 'function') continue
        let snap
        try {
          snap = hook((s) => s)
        } catch {
          continue
        }
        if (!snap) continue
        const hit = fromSelection(snap.model ?? snap.currentModel ?? snap.selection)
        if (hit) return hit
      }
      return undefined
    }

    /**
     * Read the model selection from BOTH hook families, in a FIXED order every
     * render. React counts hooks per render: a short-circuiting `a ?? b` that
     * skips a family on one render but not the next shifts the hook order and
     * crashes the whole slot entry ("Rendered fewer hooks than expected") —
     * exactly the failure mode that took this card down once already.
     */
    function gateSelection(props = {}) {
      let fromProjection
      try {
        fromProjection = projectionSelection(props)
      } catch (e) {
        dbg('projectionSelection failed', e)
        fromProjection = undefined
      }
      let fromHook
      try {
        fromHook = hookSelection(props)
      } catch (e) {
        dbg('hookSelection failed', e)
        fromHook = undefined
      }
      return fromProjection ?? fromHook
    }

    /**
     * The card always renders; whether it shows a vendor's quota is decided by
     * `filterForProvider` inside the Hud (matched row → that vendor only;
     * nothing matched → explanation panel, never another vendor's billing).
     * Hiding here on an unrecognized provider name would break user-defined
     * `custom2` subscriptions, whose provider ids we cannot know in advance.
     */
    let lastGate = null
    function Gate(props = {}) {
      const sel = gateSelection(props)
      const provider = sel?.provider
      const gateKey = `${provider ?? 'unknown'}:${sel?.model ?? ''}`
      if (gateKey !== lastGate) {
        lastGate = gateKey
        dbg('gate selection', {
          hasProjectionHook: typeof props.useProjection === 'function',
          provider: provider ?? null,
          model: sel?.model ?? null,
          knownVendor: isSupportedProvider(provider),
        })
      }
      const label = sel?.model ? `${provider}/${sel.model}` : (provider ?? 'OpenCode')
      return jsx(Hud, {
        model: label,
        provider: provider ?? '',
        startTimers: props.startTimers,
        useProjection: props.useProjection,
      })
    }

    // ── panel entry ────────────────────────────────────────────────────────
    // The registry entry the shell collects. What used to be the module exports
    // now rides in `__test`: the isolation test wants filterForProvider /
    // providerKind, and the layout tests render `Hud` / `Gate` under a stubbed
    // React. Registration into `conversation.input.dock` and the timers belong
    // to the shell, so neither is built here any more.
    //
    // `span: 2` is this panel's PREFERENCE, not a rule: the quota card carries
    // up to three limit windows plus a usage chart, so it reads badly in a
    // single 1/3 track. The user's own layout choice (⚙) always wins over it,
    // and the shell clamps it to however many columns the HUD currently has.
    return {
      id: 'quota',
      order: 20,
      span: 1,
      label: { zh: '用量', en: 'Quota' },
      // ON by default, and one column wide: it is the second card of the shipped layout,
      // stacked above the machine card — but NOT tied to it. Each card in that column has
      // its own height, and this one is set from what it shows.
      defaultOn: true,
      // FOUR rows is the floor, and it is a floor rather than a measurement on purpose:
      // the rate line, the monthly bar with its reset countdown, the credit totals and the
      // CNY figure together need more than three, and three is where it kept landing. There
      // is no ceiling — the measurement can still make it taller.
      defaultRows: 3,
      Component: Gate,
      __test: { filterForProvider, providerKind, Hud, Gate },
    }
}
