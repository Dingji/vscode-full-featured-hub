// dsh-hud › parcel panel — browser half.
//
// FRAGMENT CONTRACT: concatenated into the single `client.js` bundle by
// `tools/build-client.mjs`, inside the same factory scope as the shell. No
// top-level `import` / `export` / `return`; `React`, `jsx`, `jsxs` and `hud`
// come from the bundle scope.
//
// A CARD (it has `Component`), one column wide by default: a compact list of
// watched shipments that expands into full timelines. Every parcel row carries
// what a courier app puts on its list screen — carrier, status chip, the place
// of the newest scan, how long ago — and the expansion carries the whole track.
//
// Two honest details this UI is careful about:
//
//   - the newest scan's place is shown as TEXT and labelled as coming from the
//     scan text. The API carries no coordinates (verified: the union of every
//     node's keys is exactly `time`, `context`, `ftime`), so there is no pin to
//     draw and this card does not draw one;
//   - "unread" means the timeline MOVED since the card last acknowledged it, so
//     the tab badge counts real news rather than new parcels.

const PK_FALLBACK_POLL_MS = 300_000
const PK_MIN_POLL_MS = 60_000
const PK_MAX_POLL_MS = 6 * 60 * 60_000
/** Nodes rendered before the timeline is truncated with a "more" line. */
const PK_VISIBLE_NODES = 12

function createParcelPanel() {
  const CSS_ID = 'dsh-hud/parcel.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      // Two panes, the same shape as the GitHub card: the left rail holds the empty-state line, the
      // 添加单号 button and the refresh note; the right pane holds the parcel LIST. A parcel row was
      // always meant to be read as a list, and a list that sits under the controls is a list that
      // moves every time a control changes width.
      //
      // `minmax(0, 1fr)` rather than `1fr`: a track's default minimum is its content, so a long
      // tracking line would widen the pane past the card and put a scrollbar on the whole HUD.
      '.pk-root{display:grid;grid-template-columns:minmax(90px,40%) minmax(0,1fr);align-items:start;gap:5px 10px;min-width:0}',
      '.pk-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}',
      '.pk-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 3px rgba(57,100,254,.14)}',
      '.pk-status.is-ok{background:#22a06b;box-shadow:0 0 0 3px rgba(34,160,107,.15)}',
      '.pk-status.is-warn{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16)}',
      '.pk-status.is-crit{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}',
      '.pk-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.pk-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.pk-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.pk-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.pk-btn:disabled{opacity:.55;cursor:default}',
      '.pk-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-btn.is-quiet:hover{border-color:var(--dsw-alias-label-caption,#81858c)}',
      '.pk-list{display:flex;flex-direction:column;gap:7px}',
      // The parcels go in the right-hand pane; everything else falls into the left rail.
      '.pk-row{grid-column:2;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));overflow:hidden}',
      '.pk-row.is-unread{border-color:rgba(57,100,254,.35)}',
      '.pk-rowhead{display:flex;align-items:center;gap:7px;width:100%;padding:7px 9px;border:0;background:transparent;font-family:inherit;text-align:left;cursor:pointer}',
      '.pk-caret{flex:none;width:9px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.pk-name{flex:none;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.pk-nu{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.pk-chip{flex:none;padding:0 7px;border-radius:999px;border:1px solid transparent;font-size:10.5px;line-height:16px}',
      '.pk-chip.t-brand{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe);background:rgba(57,100,254,.10)}',
      '.pk-chip.t-ok{border-color:rgba(34,160,107,.35);color:#1a7f52;background:rgba(34,160,107,.10)}',
      '.pk-chip.t-warn{border-color:rgba(245,158,11,.45);color:#b45309;background:rgba(245,158,11,.10)}',
      '.pk-chip.t-crit{border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.10)}',
      '.pk-chip.t-info{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14));color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-new{flex:none;padding:0 6px;border-radius:999px;background:rgba(57,100,254,.14);font-size:10px;line-height:15px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.pk-meta{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:7px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.pk-where{flex:none;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-body{display:flex;flex-direction:column;gap:6px;padding:0 9px 9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.pk-sum{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word;padding-top:6px}',
      '.pk-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.pk-steps{display:flex;flex-direction:column;gap:0;padding-top:2px}',
      '.pk-step{position:relative;display:flex;gap:8px;padding:4px 0 4px 14px;font-size:11px;line-height:16px}',
      '.pk-step::before{content:"";position:absolute;left:3px;top:11px;bottom:-3px;width:1px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14))}',
      '.pk-step:last-child::before{display:none}',
      '.pk-dot{position:absolute;left:0;top:9px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}',
      '.pk-step.is-latest .pk-dot{background:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.pk-step.is-ok .pk-dot{background:#22a06b}',
      '.pk-step.is-new{background:rgba(57,100,254,.06);border-radius:6px}',
      '.pk-step.is-new .pk-dot{background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 2px rgba(57,100,254,.18)}',
      '.pk-time{flex:none;width:88px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.pk-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.pk-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding-top:4px}',
      '.pk-add{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
      '.pk-field{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.pk-field label{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);min-width:52px}',
      '.pk-input{box-sizing:border-box;flex:1 1 140px;min-width:0;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px;line-height:16px}',
      '.pk-input.is-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.pk-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
      '.pk-select{flex:1 1 120px;min-width:0;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px}',
      '.pk-cands{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.pk-cand{padding:1px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.pk-cand:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.pk-cand[aria-pressed="true"]{border-color:rgba(57,100,254,.45);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.pk-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.pk-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.pk-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '@keyframes pk-swap{from{opacity:0;transform:translateY(4px)}}',
      '.pk-row.is-unread{animation:pk-swap .24s cubic-bezier(.22,.7,.3,1)}',
      '@media (prefers-reduced-motion:reduce){.pk-row.is-unread{animation:none}}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num

  /** `2 小时前` style, for the newest scan. */
  function ago(at, lang) {
    if (!at) return ''
    const then = Date.parse(String(at).replace(/-/g, '/'))
    if (!Number.isFinite(then)) return String(at).slice(5, 16)
    const minutes = Math.floor((Date.now() - then) / 60_000)
    if (minutes < 1) return lang === 'zh' ? '刚刚' : 'just now'
    if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`
    const days = Math.floor(hours / 24)
    return lang === 'zh' ? `${days} 天前` : `${days}d ago`
  }

  function ParcelRow(props) {
    const { parcel, lang, open, onToggle, onCheck, onRemove, onRead, busy } = props
    const zh = lang === 'zh'
    const nodes = Array.isArray(parcel.nodes) ? parcel.nodes : []
    // Newest first, which is how every courier app reads.
    const ordered = nodes.slice().reverse()
    const newCount = num(parcel.newNodes) ?? 0
    const shown = ordered.slice(0, PK_VISIBLE_NODES)
    const statusTone = parcel.tone === 'ok' ? 'is-ok' : parcel.tone === 'crit' ? 'is-crit' : parcel.tone === 'warn' ? 'is-warn' : ''

    return jsxs('div', { className: `pk-row${parcel.unread ? ' is-unread' : ''}`, 'data-nu': parcel.nu, children: [
      jsxs('button', {
        type: 'button',
        className: 'pk-rowhead',
        'aria-expanded': open ? 'true' : 'false',
        // The row is name-first (the user's label if there is one), so the
        // carrier has to be reachable somewhere: it heads the expanded body and
        // it is here in the tooltip.
        title: `${parcel.carrier} ${parcel.nu}${parcel.label ? ` · ${parcel.label}` : ''}`,
        onClick: () => {
          onToggle()
          if (!open && parcel.unread) onRead()
        },
        children: [
          jsx('span', { className: 'pk-caret', 'aria-hidden': true, children: open ? '▾' : '▸' }),
          jsx('span', { className: 'pk-name', children: parcel.label || parcel.carrier }),
          jsx('span', { className: 'pk-nu', children: parcel.nu }),
          jsx('span', { className: `pk-chip t-${parcel.tone || 'info'}`, children: zh ? parcel.stateText : (parcel.stateTextEn || parcel.stateText) }),
          parcel.unread ? jsx('span', { className: 'pk-new', children: zh ? `${newCount || 1} 新` : `${newCount || 1} new` }) : null,
          jsxs('span', { className: 'pk-meta', children: [
            parcel.location ? jsx('span', { className: 'pk-where', children: parcel.location }) : null,
            jsx('span', { children: ago(parcel.latestAt, lang) }),
          ] }),
        ],
      }),
      open
        ? jsxs('div', { className: 'pk-body', children: [
            jsx('div', { className: 'pk-note', children: [
              parcel.carrier,
              ' · ',
              parcel.nu,
              parcel.label ? ` · ${parcel.label}` : '',
              parcel.phone ? ` · ${zh ? '尾号' : 'phone'} ${parcel.phone}` : '',
            ].join('') }),
            parcel.error
              ? jsx('div', { className: 'pk-msg is-err', children: parcel.error })
              : null,
            parcel.summary
              ? jsx('div', { className: 'pk-sum', children: parcel.summary })
              : jsx('div', { className: 'pk-empty', children: parcel.noData
                  ? (zh ? '这家快递还没有这个单号的轨迹 —— 刚发货时常见，过几小时再看。' : 'no scans yet — normal right after dispatch')
                  : (zh ? '暂无轨迹数据' : 'no tracking data') }),
            // The place is a NAME taken from the scan text, not a coordinate.
            parcel.location
              ? jsx('div', { className: 'pk-note pk-src', children: zh
                  ? `最新位置：${parcel.location}（取自扫描文案，接口不提供经纬度）`
                  : `latest place: ${parcel.location} (from the scan text — the API carries no coordinates)` })
              : null,
            shown.length > 0
              ? jsxs('div', { className: 'pk-steps', children: [
                  ...shown.map((node, index) => {
                    const isNew = index < newCount
                    const isLatest = index === 0
                    const isOk = isLatest && parcel.signed
                    return jsxs('div', {
                      className: `pk-step${isNew ? ' is-new' : ''}${isLatest ? ' is-latest' : ''}${isOk ? ' is-ok' : ''}`,
                      children: [
                        jsx('span', { className: 'pk-dot', 'aria-hidden': true }),
                        jsx('span', { className: 'pk-time', children: String(node.at).slice(0, 16) }),
                        jsx('span', { className: 'pk-text', children: node.text }),
                      ],
                    }, `${node.at}-${index}`)
                  }),
                  ordered.length > shown.length
                    ? jsx('div', { className: 'pk-note', children: zh ? `还有 ${ordered.length - shown.length} 条更早的记录` : `${ordered.length - shown.length} older scans` })
                    : null,
                ] })
              : null,
            jsxs('div', { className: 'pk-actions', children: [
              jsx('button', { type: 'button', className: 'pk-btn', disabled: busy, onClick: onCheck, children: busy ? (zh ? '查询中…' : 'checking…') : (zh ? '刷新这个' : 'refresh') }),
              parcel.unread
                ? jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: onRead, children: zh ? '标记已读' : 'mark read' })
                : null,
              jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: onRemove, children: zh ? '不再关注' : 'remove' }),
              jsx('span', { className: 'pk-note', children: parcel.fetchedAt
                ? (zh ? `${ago(new Date(parcel.fetchedAt).toISOString().slice(0, 19).replace('T', ' '), lang)}查询` : `checked ${ago(new Date(parcel.fetchedAt).toISOString().slice(0, 19).replace('T', ' '), lang)}`)
                : (zh ? '尚未查询' : 'not checked yet') }),
            ] }),
          ] })
        : null,
    ] })
  }

  /**
   * The card. Hook order is fixed — nothing returns before every hook has run,
   * so the loading / error / ready states cannot shift the hook count.
   */
  function ParcelCard(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [openNu, setOpenNu] = React.useState(null)
    const [busyNu, setBusyNu] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [adding, setAdding] = React.useState(false)
    const [draft, setDraft] = React.useState({ nu: '', phone: '', label: '', com: '' })
    const [candidates, setCandidates] = React.useState([])
    const [addMsg, setAddMsg] = React.useState(null)
    const aliveRef = React.useRef(true)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/parcel/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    const pollMs = clamp(num(snapshot?.pollMs) ?? PK_FALLBACK_POLL_MS, PK_MIN_POLL_MS, PK_MAX_POLL_MS)

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
        console.error('[pk] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, pollMs, props.startTimers])

    /** The badge counts parcels whose timeline MOVED since we acknowledged it. */
    const parcels = Array.isArray(snapshot?.parcels) ? snapshot.parcels : []
    const unread = parcels.filter((parcel) => parcel.unread).length
    React.useEffect(() => {
      hud.setBadge('parcel', unread)
    }, [unread])

    const post = React.useCallback(async (action, body) => {
      const json = await hud.fetchJson(`/dsh-hud/parcel/${action}`, {
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

    const refreshAll = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        await post('refresh')
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy, post])

    const checkOne = React.useCallback(async (nu) => {
      setBusyNu(nu)
      try {
        await post('check', { nu })
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusyNu(null)
      }
    }, [post])

    /** Suggest carriers as the number is typed — offline, no request. */
    const detect = React.useCallback(async (nu) => {
      if (nu.trim().length < 6) {
        setCandidates([])
        return
      }
      try {
        const json = await post('detect', { nu })
        if (!aliveRef.current) return
        setCandidates(Array.isArray(json?.candidates) ? json.candidates : [])
        setDraft((current) => (current.com === '' && json?.candidates?.length > 0 ? { ...current, com: json.candidates[0].code } : current))
      } catch {
        if (aliveRef.current) setCandidates([])
      }
    }, [post])

    const submit = React.useCallback(async () => {
      if (!draft.nu.trim() || !draft.com) return
      setAddMsg(null)
      try {
        await post('add', { nu: draft.nu, com: draft.com, phone: draft.phone, label: draft.label })
        if (!aliveRef.current) return
        setDraft({ nu: '', phone: '', label: '', com: '' })
        setCandidates([])
        setAdding(false)
      } catch (failure) {
        if (aliveRef.current) setAddMsg(failure instanceof Error ? failure.message : String(failure))
      }
    }, [draft, post])

    const carrierList = Array.isArray(snapshot?.carriers) ? snapshot.carriers : []
    const tone = parcels.some((parcel) => parcel.unread) ? 'is-warn'
      : parcels.some((parcel) => parcel.tone === 'brand') ? ''
        : parcels.length > 0 && parcels.every((parcel) => parcel.tone === 'ok') ? 'is-ok' : ''
    const stamp = snapshot?.fetchedAt
      ? new Date(snapshot.fetchedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false })
      : null

    return jsxs('div', { className: 'pk-root', 'data-panel': 'parcel', children: [
      jsxs('div', { className: 'pk-head', children: [
        jsx('span', { className: `pk-status ${tone}`.trim(), 'aria-hidden': true }),
        jsx('span', { className: 'pk-title', children: zh ? '快递' : 'Parcels' }),
        jsx('span', { className: 'pk-sub', children: parcels.length === 0
          ? (zh ? '还没有关注任何包裹' : 'nothing watched yet')
          : (zh ? `${parcels.length} 个包裹${unread > 0 ? ` · ${unread} 个有新动态` : ''}` : `${parcels.length} watched${unread > 0 ? ` · ${unread} updated` : ''}`) }),
        jsxs('span', { className: 'pk-right', children: [
          stamp ? jsx('span', { children: stamp }) : null,
          jsx('button', { type: 'button', className: 'pk-btn', onClick: refreshAll, disabled: busy, children: busy ? (zh ? '刷新中' : 'refreshing') : (zh ? '刷新' : 'refresh') }),
        ] }),
      ] }),
      error ? jsx('div', { className: 'pk-msg is-err', children: error }) : null,
      parcels.length > 0
        ? jsx('div', { className: 'pk-list', children: parcels.map((parcel) => jsx(ParcelRow, {
            parcel,
            lang,
            open: openNu === parcel.nu,
            busy: busyNu === parcel.nu,
            onToggle: () => setOpenNu((current) => (current === parcel.nu ? null : parcel.nu)),
            onCheck: () => checkOne(parcel.nu),
            onRemove: () => { post('remove', { nu: parcel.nu }).catch(() => {}) },
            onRead: () => { post('read', { nu: parcel.nu }).catch(() => {}) },
          }, parcel.nu)) })
        : jsx('div', { className: 'pk-empty', children: zh
            ? '点下面的「添加单号」把快递单号粘进来，之后每 5 分钟自动看一次；有新的扫描记录就会在标题栏和页签上标出来。'
            : 'Add a tracking number below. It is checked every 5 minutes and new scans are flagged on the tab.' }),
      adding
        ? jsxs('div', { className: 'pk-add', children: [
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '单号' : 'number' }),
              jsx('input', {
                className: 'pk-input is-mono',
                value: draft.nu,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: zh ? '粘贴快递单号' : 'paste a tracking number',
                onChange: (event) => {
                  const nu = event.target.value
                  setDraft((current) => ({ ...current, nu }))
                  setAddMsg(null)
                  detect(nu)
                },
              }),
            ] }),
            candidates.length > 0
              ? jsxs('div', { className: 'pk-cands', children: [
                  jsx('span', { className: 'pk-note', children: zh ? '可能是' : 'maybe' }),
                  ...candidates.slice(0, 5).map((candidate) => jsx('button', {
                    type: 'button',
                    className: 'pk-cand',
                    'aria-pressed': draft.com === candidate.code ? 'true' : 'false',
                    title: candidate.confidence >= 3 ? (zh ? '单号前缀明确' : 'clear prefix') : (zh ? '按单号格式推测，请确认' : 'guessed from the format — please confirm'),
                    onClick: () => setDraft((current) => ({ ...current, com: candidate.code })),
                    children: candidate.name,
                  }, candidate.code)),
                ] })
              : null,
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '快递' : 'carrier' }),
              jsxs('select', {
                className: 'pk-select',
                value: draft.com,
                onChange: (event) => setDraft((current) => ({ ...current, com: event.target.value })),
                children: [
                  jsx('option', { value: '', children: zh ? '请选择' : 'choose' }),
                  ...carrierList.map((carrier) => jsx('option', { value: carrier.code, children: carrier.name }, carrier.code)),
                ],
              }),
            ] }),
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '手机后四位' : 'phone (last 4)' }),
              jsx('input', {
                className: 'pk-input is-mono',
                value: draft.phone,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: zh ? '顺丰等隐私面单需要，可留空' : 'needed by some carriers',
                onChange: (event) => setDraft((current) => ({ ...current, phone: event.target.value })),
              }),
            ] }),
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '备注' : 'label' }),
              jsx('input', {
                className: 'pk-input',
                value: draft.label,
                spellCheck: false,
                placeholder: zh ? '比如「键盘」' : 'e.g. keyboard',
                onChange: (event) => setDraft((current) => ({ ...current, label: event.target.value })),
              }),
            ] }),
            addMsg ? jsx('div', { className: 'pk-msg is-err', children: addMsg }) : null,
            jsxs('div', { className: 'pk-actions', children: [
              jsx('button', { type: 'button', className: 'pk-btn', disabled: !draft.nu.trim() || !draft.com, onClick: submit, children: zh ? '添加并查询' : 'add' }),
              jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: () => { setAdding(false); setAddMsg(null) }, children: zh ? '取消' : 'cancel' }),
              jsx('span', { className: 'pk-note', children: zh
                ? '快递公司必须选：接口的自动识别现在需要 key，这里改用本地单号格式推测。'
                : 'Carrier is required: the online detector needs a key now, so the suggestion above is a local pattern guess.' }),
            ] }),
          ] })
        : jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: () => setAdding(true), children: zh ? '＋ 添加单号' : '+ add a number' }),
      jsx('span', { className: 'pk-note', children: zh
        ? `每 ${Math.round(pollMs / 60_000)} 分钟自动看一次；接口免费无限流保证，实际查询间隔不低于 ${Math.round((num(snapshot?.refreshMs) ?? 0) / 60_000) || 15} 分钟。`
        : `Checked every ${Math.round(pollMs / 60_000)} min; upstream queries are spaced at least ${Math.round((num(snapshot?.refreshMs) ?? 0) / 60_000) || 15} min.` }),
    ] })
  }

  return {
    id: 'parcel',
    // 30: packed third, right after 用量限额 (20) and 数据库 (25).
    //
    // THE ORDER IS THE GEOMETRY. The packer scans top-left first, row by row, so a card lands
    // in the first hole big enough for it. With 股市债市 (10 rows) and 数据库 (10 rows) already
    // filling columns 1 and 3, the hole at row 4 of the MIDDLE column is the first one this card
    // fits — which is what puts it under 用量限额 rather than somewhere else.
    order: 30,
    // One column: a compact list that expands. Widen it in ⚙ if you like long
    // timelines.
    span: 1,
    // On by default now: it is one of the three cards of the middle column, and a column with a
    // hole in the middle of it is the layout this card exists to fill.
    defaultOn: true,
    /**
     * ONE row. Not a measurement: the content is a single horizontal line once the blocks sit side
     * by side, and the middle column is 用量限额 (3) + 快递 (1) + GitHub (1), which has to add up to
     * the 5 the two full-height cards claim.
     */
    defaultRows: 1,
    label: { zh: '快递', en: 'Parcels' },
    Component: ParcelCard,
    __test: { ParcelCard, ago },
  }
}