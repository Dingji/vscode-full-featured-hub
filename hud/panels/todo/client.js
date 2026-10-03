// dsh-hud › todo panel — browser half.
//
// A title-bar entry on the RIGHT of the head row (next to the ⚙), carrying how
// many things are open and what is next, plus a click-open list.
//
// ── why the notifier lives here and not in the host ────────────────────────
//
// The host has no clock the user can hear. It publishes the SCHEDULE — `leads`
// (60/30/5 minutes before `dueAt`) and `digestAt` (16:30 by default) — and this
// half fires them, because this half is the one with `Notification`, the user's
// local clock, and their permission. The split is the same one every panel here
// uses: host owns data, browser owns the user's moment.
//
// The honest limitation, stated in the UI as well: a notification needs THIS
// PAGE to be open. Nothing can fire while DeepSeek Harness is closed, because
// nothing of ours is running then.
//
// ── dedupe ─────────────────────────────────────────────────────────────────
//
// Every firing is recorded in `localStorage` as `<id>@<lead>` (and `<day>` for
// the digest), so a page refresh does not re-announce the meeting that starts in
// five minutes. Entries older than a week are pruned on write.

const TD_STORAGE_KEY = 'dsh-hud:todo:notified'
const TD_TICK_MS = 30_000
const TD_FALLBACK_REFRESH_MS = 300_000
const TD_MIN_REFRESH_MS = 30_000
const TD_MAX_REFRESH_MS = 3_600_000
/** A fired lead stays on the line this long before it stops being news. */
const TD_ALERT_MS = 10 * 60_000

/** Read the fired-notification ledger, pruning anything older than a week. */
function tdReadLedger(now = Date.now()) {
  try {
    const parsed = JSON.parse(localStorage.getItem(TD_STORAGE_KEY) ?? '{}')
    const fresh = {}
    for (const [key, at] of Object.entries(parsed ?? {})) {
      if (typeof at === 'number' && now - at < 7 * 86_400_000) fresh[key] = at
    }
    return fresh
  } catch {
    return {}
  }
}

function tdWriteLedger(ledger) {
  try {
    localStorage.setItem(TD_STORAGE_KEY, JSON.stringify(ledger))
  } catch {
    /* storage disabled: notifications are best-effort anyway */
  }
}

/**
 * Which leads are due to fire right now.
 *
 * `leads` are minutes BEFORE the due moment; a lead fires when the clock is at
 * or past `dueAt - lead` but the item is not yet due — a 5-minute warning that
 * arrives after the meeting started is not a warning.
 *
 * Exported for the test harness, because this is the part that must be exactly
 * right and is invisible when it is wrong.
 */
function tdDueLeads(item, leads, now, fired) {
  const dueAt = typeof item?.dueAt === 'number' ? item.dueAt : undefined
  if (dueAt === undefined || dueAt < now) return []
  // ONLY the closest passed lead fires:
  //   T-60 passed={60}         → 60
  //   T-30 passed={60,30}      → 30      (the 60 fired an hour ago)
  //   T-5  passed={60,30,5}    → 5
  //   T-31 passed={60}         → 60      (late, but it is the current news)
  //   added at T-20            → 30      (one notification, not three)
  // Firing every passed lead would mean three at once for anything added or
  // opened late, which is how people turn notifications off. A stale lead is
  // skipped: nobody needs "in an hour" about something starting in five minutes.
  const current = leads.filter((lead) => now >= dueAt - lead * 60_000).sort((a, b) => a - b)[0]
  if (current === undefined) return []
  if (fired[`${item.id}@${current}`] !== undefined) return []
  return [current]
}

/** Minutes until a moment, rounded, for "还有 25 分钟". */
function tdMinutesUntil(at, now) {
  return Math.round((at - now) / 60_000)
}

/** `今天 14:30` / `明天 09:00` / `10-05 09:00` — as short as it can be. */
function tdWhen(at, now, zh) {
  const pad = (value) => String(value).padStart(2, '0')
  const at2 = new Date(at)
  const clock = `${pad(at2.getHours())}:${pad(at2.getMinutes())}`
  const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const delta = Math.round((day(at2) - day(new Date(now))) / 86_400_000)
  if (delta === 0) return clock
  if (delta === -1) return zh ? `昨天 ${clock}` : `yesterday ${clock}`
  if (delta === 1) return zh ? `明天 ${clock}` : `tomorrow ${clock}`
  if (delta < 0 && delta > -8) return zh ? `${-delta} 天前` : `${-delta}d ago`
  return `${pad(at2.getMonth() + 1)}-${pad(at2.getDate())} ${clock}`
}

/** The signed lead label: `30 分钟后` / `已过 5 分钟`. */
function tdLeadLabel(minutes, zh) {
  if (minutes >= 0) return zh ? `${minutes} 分钟后` : `in ${minutes}m`
  return zh ? `已过 ${-minutes} 分钟` : `${-minutes}m ago`
}

/**
 * Derive the colour scheme from the surface we actually paint with.
 *
 * Native widgets that cannot be styled — the `<input type="time">` picker, the
 * scrollbar of a scrolling list — are painted from `color-scheme`. The app
 * implements dark mode with its own tokens and marks it on `<body>`, so relying
 * on the platform's guess is how a popup ends up light under light text. Asking
 * the surface token directly is deterministic, and it follows a third-party
 * palette override too.
 */
function tdSurfaceScheme() {
  try {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;color:var(--dsw-alias-bg-layer-1,#ffffff)'
    document.body.appendChild(probe)
    const painted = getComputedStyle(probe).color
    probe.remove()
    const parts = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(painted)
    if (parts === null) return 'light'
    const luminance = 0.2126 * Number(parts[1]) + 0.7152 * Number(parts[2]) + 0.0722 * Number(parts[3])
    return luminance < 128 ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * A themed dropdown.
 *
 * Deliberately not a `<select>`: see the `.td-menu` note above. It behaves like
 * one where it matters — a button that opens a list of options, Escape and a
 * click outside to close, arrows and Enter to choose.
 */
function TdSelect(props) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const ref = React.useRef(null)
  const options = Array.isArray(props.options) ? props.options : []
  const current = options.find((option) => option.value === props.value)
  hud.useDismiss(ref, open, React.useCallback(() => setOpen(false), []))
  const choose = (value) => {
    setOpen(false)
    props.onChange?.(value)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(Math.max(0, options.findIndex((option) => option.value === props.value)))
        return
      }
      if (event.key === 'ArrowDown') setActive((index) => Math.min(options.length - 1, index + 1))
      else if (event.key === 'ArrowUp') setActive((index) => Math.max(0, index - 1))
      else if (active >= 0 && active < options.length) choose(options[active].value)
    }
  }
  return jsxs('span', { className: 'td-drop', ref, children: [
    jsxs('button', {
      type: 'button',
      className: 'td-sel',
      'aria-haspopup': 'listbox',
      'aria-expanded': open ? 'true' : 'false',
      disabled: props.disabled === true,
      title: props.title,
      onClick: () => setOpen((value) => !value),
      onKeyDown,
      children: [
        jsx('span', { children: current?.label ?? props.placeholder ?? '' }),
        jsx('span', { className: 'td-caret', 'aria-hidden': true, children: '▾' }),
      ],
    }),
    open
      ? jsx('span', { className: 'td-menu', role: 'listbox', children: options.map((option, index) => jsx('button', {
          type: 'button',
          role: 'option',
          'aria-selected': option.value === props.value ? 'true' : 'false',
          className: `td-opt${option.value === props.value ? ' is-on' : ''}${index === active ? ' is-active' : ''}`,
          onClick: () => choose(option.value),
          children: option.label,
        }, option.value)) })
      : null,
  ] })
}

function createTodoPanel() {
  const CSS_ID = 'dsh-hud/todo.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      // ── the title-bar entry ───────────────────────────────────────────────
      '.td-root{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.td-btn{display:inline-flex;align-items:center;gap:6px;min-width:0;padding:0 6px;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:18px;color:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}',
      '.td-btn:hover{border-color:var(--hud-line,rgba(0,0,0,.1));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-btn[aria-expanded="true"]{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
      '.td-mark{flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
      // The count chip: the one number this widget exists to show.
      '.td-count{font-style:normal;min-width:16px;padding:0 5px;border-radius:999px;background:rgba(57,100,254,.14);font-size:10px;line-height:15px;text-align:center;color:var(--dsw-alias-state-business-primary,#3964fe);font-variant-numeric:tabular-nums}',
      '.td-count.is-overdue{background:rgba(220,38,38,.14);color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}',
      '.td-next{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-zero{color:var(--dsw-alias-label-caption,#81858c)}',
      // A fired reminder, on the line, until it stops being news.
      '.td-alert{display:inline-flex;align-items:center;gap:5px;max-width:260px;padding:0 9px;border:1px solid rgba(245,158,11,.45);border-radius:999px;background:rgba(245,158,11,.12);font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#b45309);cursor:pointer}',
      '.td-alert b{font-weight:600}',
      '.td-alert span{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // ── the popover ───────────────────────────────────────────────────────
      '.td-pop{position:absolute;top:calc(100% + 7px);right:0;z-index:9;box-sizing:border-box;width:min(440px,calc(100vw - 28px));max-height:min(66vh,520px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:12px;background:var(--hud-pop,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 3px 10px rgba(15,17,21,.07),0 24px 52px -28px rgba(15,17,21,.5);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);text-align:left;white-space:normal}',
      '.td-pop-head{display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.08))}',
      // The timer reads as a strip above the list: it is set going and then ignored,
          // so it must be legible at a glance and never compete with the items.
            '.td-pomo{display:flex;flex-direction:column;gap:4px;padding:7px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
            '.td-pomo-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
            '.td-pomo-phase{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
            '.td-pomo.is-running .td-pomo-phase{color:var(--dsw-alias-state-business-primary,#3964fe)}',
            '.td-pomo.is-break .td-pomo-phase{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
          // Tabular figures: a countdown that shifts width every second is unreadable.
            '.td-pomo-time{font-size:17px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
            '.td-pomo.is-running .td-pomo-time{color:var(--dsw-alias-state-business-primary,#3964fe)}',
            '.td-pomo-total,.td-pomo-done{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
            '.td-pomo-done{font-variant-numeric:tabular-nums}',
      '.td-pop-title{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-pop-head .td-spacer{margin-left:auto}',
      '.td-ghost{padding:0 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      '.td-ghost:hover{border-color:var(--hud-line-2,rgba(0,0,0,.18));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
      '.td-ghost[aria-pressed="true"]{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-ghost:disabled{opacity:.4;cursor:default}',
      // add row
      '.td-add{display:flex;align-items:center;gap:6px}',
      '.td-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:3px 9px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:transparent;font-family:inherit;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-time{flex:none;box-sizing:border-box;padding:3px 6px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
      // groups
      '.td-group{display:flex;flex-direction:column;gap:3px}',
      '.td-group-head{display:flex;align-items:baseline;gap:7px;padding-top:2px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-group-head em{font-style:normal;font-weight:600;letter-spacing:0;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-row{display:flex;align-items:flex-start;gap:7px;padding:3px 5px;border-radius:8px}',
      '.td-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
      '.td-check{flex:none;width:14px;height:14px;margin-top:2px;padding:0;border:1px solid var(--hud-line-2,rgba(0,0,0,.2));border-radius:4px;background:transparent;font-family:inherit;font-size:10px;line-height:12px;color:transparent;cursor:pointer}',
      '.td-check:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-check[aria-pressed="true"]{border-color:var(--dsw-alias-state-success-primary,#1a7f52);background:rgba(26,127,82,.14);color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.td-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.td-title{color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.td-row.is-done .td-title{color:var(--dsw-alias-label-caption,#81858c);text-decoration:line-through}',
      '.td-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-due{font-variant-numeric:tabular-nums}',
      '.td-due.is-overdue{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}',
      '.td-due.is-soon{color:var(--dsw-alias-state-warn-primary,#b45309);font-weight:600}',
      '.td-src{padding:0 6px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;font-size:9.5px;line-height:14px}',
      '.td-approx{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.td-note{color:var(--dsw-alias-label-caption,#81858c);word-break:break-word}',
      '.td-acts{flex:none;display:inline-flex;align-items:center;gap:3px;opacity:0;transition:opacity .15s ease}',
      '.td-row:hover .td-acts,.td-row:focus-within .td-acts{opacity:1}',
      '.td-mini{padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer}',
      '.td-mini:hover{border-color:var(--hud-line,rgba(0,0,0,.12));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-empty{padding:5px 2px;color:var(--dsw-alias-label-caption,#81858c)}',
      // settings
      '.td-set{display:flex;flex-direction:column;gap:7px;padding-top:8px;border-top:1px solid var(--hud-line,rgba(0,0,0,.08))}',
      '.td-set-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.td-set-label{min-width:62px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-feed{display:flex;align-items:center;gap:6px}',
      '.td-feed-state{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-feed-state.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.td-msg{font-size:11px;line-height:16px;word-break:break-word}',
      '.td-msg.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.td-msg.is-good{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.td-note-line{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── credentials that come from a LOGIN ────────────────────────────────
      '.td-sec{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.035))}',
      '.td-sec-head{display:flex;align-items:center;gap:7px}',
      '.td-sec-title{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-sec-state{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-sec-state.is-on{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.td-sel{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:3px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.td-sel:hover{border-color:var(--hud-line-2,rgba(0,0,0,.18))}',
      '.td-sel:disabled{opacity:.4;cursor:default}',
      '.td-caret{font-size:8px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── our own dropdown, NOT a <select> ─────────────────────────────────
      // A native popup is painted by the platform from the element's
      // `color-scheme`, not from its `color`. The app's palette and its declared
      // canvas scheme can disagree, and the result is a LIGHT popup under LIGHT
      // text — an unreadable list that no page CSS can reach. This one is ours,
      // so it is themed by the same tokens as everything else.
      '.td-drop{position:relative;display:inline-flex;min-width:0}',
      '.td-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:10;box-sizing:border-box;min-width:100%;max-height:220px;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:1px;padding:3px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:9px;background:var(--hud-pop,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 2px 6px rgba(15,17,21,.08),0 16px 34px -20px rgba(15,17,21,.5)}',
      '.td-opt{display:block;width:100%;box-sizing:border-box;padding:3px 9px;border:0;border-radius:6px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);text-align:left;white-space:nowrap;cursor:pointer}',
      '.td-opt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-opt.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.td-wide{flex:1 1 140px}',
      '.td-mail-row{display:flex;align-items:baseline;gap:7px;padding:3px 4px;border-radius:6px}',
      '.td-mail-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
      '.td-mail-sub{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-mail-from{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-unread{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none}',
      '.td-link:hover{text-decoration:underline}',
    ].join('')
    document.head.appendChild(tag)
  }

  /**
   * The whole panel, in the title bar.
   *
   * Hook order is fixed: nothing below returns before every hook has run, so the
   * "no reading yet" / "error" / "ready" states cannot change the hook count and
   * take the slot entry down.
   */
  function TodoHead(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [showSet, setShowSet] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [draft, setDraft] = React.useState('')
    const [draftTime, setDraftTime] = React.useState('')
    const [notice, setNotice] = React.useState(null)
    const [alert, setAlert] = React.useState(null)
    const [permission, setPermission] = React.useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
    const [feedDraft, setFeedDraft] = React.useState({ url: '', label: '' })
    const [mailDraft, setMailDraft] = React.useState(null)
    const [loginDraft, setLoginDraft] = React.useState(null)
    const [mailList, setMailList] = React.useState(null)
    const [mailBusy, setMailBusy] = React.useState(false)
    const [digestDraft, setDigestDraft] = React.useState('')
    const [leadsDraft, setLeadsDraft] = React.useState('')
    const rootRef = React.useRef(null)
    const aliveRef = React.useRef(true)
    /**
     * The latest snapshot, for the timer callback. The tick is created once and
     * fires on a 30 s interval, so it cannot close over a `snapshot` state value
     * that changes every poll — it reads the ref instead.
     */
    const snapshotRef = React.useRef(null)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    // Native widgets inside this widget (the time picker, scrollbars) are painted
    // from `color-scheme`, so it is set from the surface token once, on mount.
    React.useEffect(() => {
      const root = rootRef.current
      if (root === null || root === undefined) return
      try {
        root.style.colorScheme = tdSurfaceScheme()
      } catch {
        /* a widget without a style object is not worth failing over */
      }
    }, [])

    const accept = React.useCallback((json) => {
      setSnapshot(json)
      setError(null)
      if (json?.digestAt && digestDraft === '') setDigestDraft(json.digestAt)
      if (Array.isArray(json?.leads) && leadsDraft === '') setLeadsDraft(json.leads.join(','))
      // Seed the credential forms from the host once, then leave them alone: a
      // poll landing while someone is typing a 授权码 must not wipe the field.
      if (json?.mail) setMailDraft((current) => (current === null ? { ...json.mail, secret: '' } : current))
      if (json?.oauth) {
        setLoginDraft((current) => (current === null
          ? { provider: json.oauth.provider, clientId: json.oauth.clientId, redirectUri: json.oauth.redirectUri, clientSecret: '' }
          : current))
      }
    }, [digestDraft, leadsDraft])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/todo/state').then((json) => {
        if (!aliveRef.current) return
        accept(json)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [accept])

      // ── 番茄钟 ──────────────────────────────────────────────────────────
      // The HOST owns the clock: this half only renders `endsAt - now`, so a
      // refresh, a hidden tab or a sleeping laptop resumes the same session
      // instead of losing it.
      const pomo = snapshot?.pomodoro ?? {
        phase: 'work', running: false, remainingMs: 25 * 60_000, totalMs: 25 * 60_000,
        started: false, completedToday: 0, cycleId: 0, settings: {}, justEnded: null,
      }
      const [pomoNow, setPomoNow] = React.useState(() => Date.now())
      // One tick per second while a session RUNS, and nothing at all otherwise:
      // an idle timer does not need a frame loop.
      React.useEffect(() => {
        if (pomo.running !== true) return undefined
        setPomoNow(Date.now())
        const timer = window.setInterval(() => setPomoNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [pomo.running, pomo.endsAt])
      const pomoLive = pomo.running === true && typeof pomo.endsAt === "number"
        ? { ...pomo, remainingMs: Math.max(0, pomo.endsAt - pomoNow) }
        : pomo

    const send = React.useCallback(async (path, body) => {
      setBusy(true)
      try {
        const json = await hud.fetchJson(`/dsh-hud/todo/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
        if (!aliveRef.current) return null
        if (json?.ok === false) setNotice({ bad: true, text: json.error ?? '操作失败' })
        else {
          setNotice(null)
          accept(json)
        }
        return json
      } catch (failure) {
        if (aliveRef.current) setNotice({ bad: true, text: failure instanceof Error ? failure.message : String(failure) })
        return null
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [accept])

    const refreshMs = hud.clamp(hud.num(snapshot?.refreshMs) ?? TD_FALLBACK_REFRESH_MS, TD_MIN_REFRESH_MS, TD_MAX_REFRESH_MS)

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    // ── 番茄钟到点 ──────────────────────────────────────────────────────
    //
    // Two things happen when a phase ends, and they are deliberately separate:
    //
    //   1. the card ASKS the host to settle the timer the moment its own
    //      countdown reaches zero, so the transition is recorded within a
    //      second instead of at the next five-minute poll;
    //   2. a notification fires for the phase that just ended.
    //
    // The host is the source of truth for BOTH: `justEnded` arrives in the
    // response and `cycleId` identifies the transition, so the same one cannot
    // be announced twice — not by a cached payload, a re-render, or two tabs.
    React.useEffect(() => {
      if (pomo.running !== true || typeof pomo.endsAt !== "number") return undefined
      if (pomo.endsAt - pomoNow > 0) return undefined
      // Past due: settle it. The host is idempotent here, so a burst is harmless.
      send("pomodoro", { action: "settle" }).catch(() => {})
      return undefined
    }, [pomo.running, pomo.endsAt, pomoNow, send])

    const pomoNoticed = React.useRef(0)
    React.useEffect(() => {
      const ended = pomo.justEnded
      if (ended === null || ended === undefined) return undefined
      if (pomo.cycleId <= pomoNoticed.current) return undefined
      pomoNoticed.current = pomo.cycleId
      // The SAME ledger the reminders use, so a refresh cannot re-announce a
      // session that already ended.
      const ledgerKey = `pomodoro@${pomo.cycleId}@${ended.at}`
      const ledger = tdReadLedger()
      if (ledger[ledgerKey] !== undefined) return undefined
      ledger[ledgerKey] = Date.now()
      tdWriteLedger(ledger)
      // A finished FOCUS session is the one worth interrupting for; a finished
      // break only needs a line in the panel.
      if (ended.phase === "work") {
        tdNotify(
          zh ? "专注结束" : "Focus finished",
          zh ? `完成第 ${ended.completedToday} 段，该休息 ${Math.round(ended.nextMs / 60_000)} 分钟了` : `Session ${ended.completedToday} done — take ${Math.round(ended.nextMs / 60_000)} minutes`,
        )
      } else {
        tdNotify(zh ? "休息结束" : "Break over", zh ? "回到专注吧。" : "Back to it.")
      }
      // Stated inline too: a notification needs THIS PAGE to be open, because
      // nothing of ours runs while the Harness is closed.
      //
      // This is the title-bar ALERT line — the same one a reminder uses — because a
      // finished session has to be visible WITHOUT the panel being open. The
      // popover strip already says which phase is running.
      setAlert({ text: ended.phase === 'work'
        ? (zh ? `专注结束 · 完成第 ${ended.completedToday} 段` : `Focus finished · session ${ended.completedToday}`)
        : (zh ? '休息结束' : 'Break over') })
      return undefined
    }, [pomo.justEnded, pomo.cycleId, zh])

    // ── the notifier ───────────────────────────────────────────────────────
    /**
     * One tick every 30 seconds, always running — including while the card is
     * switched off and the popover is closed, because a reminder that only works
     * with the list open is not a reminder.
     */
    const tick = React.useCallback(() => {
      const current = snapshotRef.current
      if (current === null) return
      const now = Date.now()
      const leads = Array.isArray(current.leads) ? current.leads : []
      const ledger = tdReadLedger(now)
      const schedule = Array.isArray(current.schedule) ? current.schedule : []
      let fired = null
      for (const item of schedule) {
        for (const lead of tdDueLeads(item, leads, now, ledger)) {
          ledger[`${item.id}@${lead}`] = now
          // The soonest lead wins the line: if three fire together, the one that
          // matters is the closest to the deadline.
          if (fired === null || lead < fired.lead) fired = { item, lead }
        }
      }
      // The end-of-day digest: once per day, and only when tomorrow has items.
      const digest = current.digest
      if (digest && digest.day && ledger[`digest@${digest.day}`] === undefined) {
        ledger[`digest@${digest.day}`] = now
        tdWriteLedger(ledger)
        tdNotify(zh ? digest.title : `Tomorrow: ${digest.items.length} item(s)`,
          digest.items.map((entry) => entry.title).join('、') + (digest.more > 0 ? (zh ? ` 等 ${digest.more} 项` : ` +${digest.more}`) : ''))
        setAlert({ text: zh ? `下班提醒 · ${digest.title}` : `End of day · ${digest.items.length} tomorrow`, at: now, digest: true })
        return
      }
      if (fired === null) {
        tdWriteLedger(ledger)
        return
      }
      tdWriteLedger(ledger)
      const minutes = tdMinutesUntil(fired.item.dueAt, now)
      const title = zh ? `${tdLeadLabel(minutes, zh)}：${fired.item.title}` : `${fired.item.title} in ${minutes}m`
      tdNotify(zh ? '待办提醒' : 'To-do reminder', title)
      setAlert({ text: title, at: now, id: fired.item.id })
    }, [zh])

    React.useEffect(() => {
      snapshotRef.current = snapshot
    }, [snapshot])

    React.useEffect(() => {
      let stop
      try {
        if (typeof props.startTimers === 'function') {
          stop = props.startTimers(poll, refreshMs, tick, TD_TICK_MS)
        } else {
          const pollTimer = window.setInterval(poll, refreshMs)
          const tickTimer = window.setInterval(tick, TD_TICK_MS)
          stop = () => {
            window.clearInterval(pollTimer)
            window.clearInterval(tickTimer)
          }
        }
      } catch (failure) {
        console.error('[td] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, refreshMs, tick, props.startTimers])

    // The fired reminder clears itself: news that never expires is clutter.
    React.useEffect(() => {
      if (alert === null) return undefined
      const timer = window.setTimeout(() => setAlert(null), TD_ALERT_MS)
      return () => window.clearTimeout(timer)
    }, [alert])

    // The count reaches the head row AND the ⚙ editor through the shell's badge.
    const openCount = hud.num(snapshot?.counts?.open) ?? 0
    const overdueCount = hud.num(snapshot?.counts?.overdue) ?? 0
    React.useEffect(() => {
      hud.setBadge('todo', overdueCount > 0 ? overdueCount : openCount)
    }, [openCount, overdueCount])

    hud.useDismiss(rootRef, open, React.useCallback(() => setOpen(false), []))

    const askPermission = React.useCallback(async () => {
      if (typeof Notification === 'undefined') return
      try {
        const result = await Notification.requestPermission()
        setPermission(result)
        if (result !== 'granted') {
          setNotice({ bad: true, text: zh ? '未获授权：提醒只会显示在 HUD 里' : 'Not granted: reminders stay in the HUD' })
        } else {
          setNotice({ good: true, text: zh ? '已开启系统通知' : 'System notifications on' })
        }
      } catch (failure) {
        setNotice({ bad: true, text: failure instanceof Error ? failure.message : String(failure) })
      }
    }, [zh])

    const addItem = React.useCallback(async () => {
      const title = draft.trim()
      if (title === '') return
      const json = await send('add', { title, dueAt: draftTime === '' ? undefined : `${snapshot?.todayDate ?? ''}T${draftTime}` })
      if (json?.ok !== false) {
        setDraft('')
        setDraftTime('')
      }
    }, [draft, draftTime, send, snapshot?.todayDate])

    const groups = snapshot?.groups ?? {}
    const nextItem = (groups.today ?? [])[0] ?? (groups.overdue ?? [])[0] ?? (groups.tomorrow ?? [])[0]
    const rowsOf = (list) => (Array.isArray(list) ? list : []).map((item) => jsx(TodoRow, {
      item,
      zh,
      now: snapshot?.now ?? Date.now(),
      busy,
      onPatch: (patch) => send('update', { id: item.id, patch }),
      onRemove: () => send('remove', { id: item.id }),
      // NO `key` in this object: React wants it as the third argument, and a key
      // inside spread props is a warning today and a wrong-row bug tomorrow.
    }, item.id))

    return jsxs('span', { className: 'td-root', ref: rootRef, children: [
      jsxs('button', {
        type: 'button',
        className: 'td-btn',
        'aria-expanded': open ? 'true' : 'false',
        title: zh ? '待办事项' : 'To-do',
        onClick: () => setOpen((value) => !value),
        children: [
          jsx('span', { className: 'td-mark', 'aria-hidden': true, children: '☑' }),
          jsx('span', { children: zh ? '待办' : 'To-do' }),
          openCount > 0
            ? jsx('em', { className: `td-count${overdueCount > 0 ? ' is-overdue' : ''}`, children: openCount > 99 ? '99+' : String(openCount) })
            : jsx('span', { className: 'td-zero', children: zh ? '无' : '0' }),
          nextItem
            ? jsx('span', { className: 'td-next', children: `${tdWhen(nextItem.dueAt, snapshot?.now ?? Date.now(), zh)} ${nextItem.title}` })
            : null,
        ],
      }),
      alert
        ? jsxs('button', {
            type: 'button',
            className: 'td-alert',
            title: zh ? '点击查看' : 'Open',
            onClick: () => {
              setOpen(true)
              setAlert(null)
            },
            children: [
              jsx('b', { children: zh ? '提醒' : 'ALERT' }),
              jsx('span', { children: alert.text }),
            ],
          })
        : null,
      open
        ? jsxs('div', { className: 'td-pop', role: 'dialog', 'aria-label': zh ? '待办事项' : 'To-do', children: [
            // ── 番茄钟 ──────────────────────────────────────────────────────
            // At the TOP, above the list: it is the thing you set going and then
            // stop looking at, so it must be visible the moment the panel opens.
            jsx('div', { className: `td-pomo${pomo.running ? ' is-running' : ''}${pomo.phase === 'break' ? ' is-break' : ''}`, children:
              jsxs('div', { className: 'td-pomo-row', children: [
                jsx('span', { className: 'td-pomo-phase', children: pomo.phase === 'break' ? (zh ? '休息' : 'break') : (zh ? '专注' : 'focus') }),
                // The countdown is DERIVED from `endsAt` every second; the browser
                // never owns the elapsed time, so a refresh loses nothing.
                jsx('span', { className: 'td-pomo-time', children: tdClock(pomoLive.remainingMs) }),
                jsx('span', { className: 'td-pomo-total', children: zh ? `共 ${Math.round(pomoLive.totalMs / 60_000)} 分钟` : `${Math.round(pomoLive.totalMs / 60_000)} min` }),
                jsx('span', { className: 'td-spacer' }),
                pomo.completedToday > 0
                  ? jsx('span', { className: 'td-pomo-done', title: zh ? '今天完成的专注时段' : 'focus sessions finished today', children: zh ? `今天 ${pomo.completedToday}` : `today ${pomo.completedToday}` })
                  : null,
                jsx('button', {
                  type: 'button',
                  className: 'td-ghost',
                  disabled: busy,
                  title: pomo.running ? (zh ? '暂停' : 'Pause') : (pomo.started ? (zh ? '继续' : 'Resume') : (zh ? '开始一个专注时段' : 'Start a focus session')),
                  onClick: () => send('pomodoro', { action: pomo.running ? 'pause' : (pomo.started ? 'resume' : 'start') }),
                  children: pomo.running ? (zh ? '暂停' : 'Pause') : (pomo.started ? (zh ? '继续' : 'Resume') : (zh ? '开始' : 'Start')),
                }),
                pomo.started || pomo.running
                  ? jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy,
                      title: zh ? '跳到下一段（不计入完成数）' : 'Skip to the next phase (no credit)',
                      onClick: () => send('pomodoro', { action: 'skip' }),
                      children: zh ? '跳过' : 'Skip',
                    })
                  : null,
                pomo.started || pomo.running
                  ? jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy,
                      title: zh ? '重置计时器（保留今天的计数）' : 'Reset the timer (keeps today\'s count)',
                      onClick: () => send('pomodoro', { action: 'reset' }),
                      children: zh ? '重置' : 'Reset',
                    })
                  : null,
              ] }),
            }),
            jsxs('div', { className: 'td-pop-head', children: [
              jsx('span', { className: 'td-pop-title', children: zh ? '待办' : 'TO-DO' }),
              jsx('span', { className: 'td-note-line', children: snapshot === null
                ? (error === null ? (zh ? '正在读取…' : 'loading…') : error)
                : (zh
                    ? `${openCount} 项未完成 · 逾期 ${overdueCount}`
                    : `${openCount} open · ${overdueCount} overdue`) }),
              jsx('span', { className: 'td-spacer' }),
              jsx('button', {
                type: 'button',
                className: 'td-ghost',
                disabled: busy,
                title: zh ? '重新读取（含订阅）' : 'Refresh (feeds too)',
                onClick: () => send('refresh'),
                children: zh ? '刷新' : 'Refresh',
              }),
              jsx('button', {
                type: 'button',
                className: 'td-ghost',
                'aria-pressed': showSet ? 'true' : 'false',
                title: zh ? '订阅与提醒设置' : 'Feeds and reminders',
                onClick: () => setShowSet((value) => !value),
                children: zh ? '设置' : 'Settings',
              }),
            ] }),
            // ── add ──────────────────────────────────────────────────────────
            jsxs('div', { className: 'td-add', children: [
              jsx('input', {
                className: 'td-input',
                value: draft,
                placeholder: zh ? '添加待办，回车即可' : 'Add a to-do, press Enter',
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addItem()
                },
              }),
              jsx('input', {
                className: 'td-time',
                type: 'time',
                value: draftTime,
                title: zh ? '时间（留空则无日期）' : 'Time (empty = no date)',
                onChange: (event) => setDraftTime(event.target.value),
              }),
              jsx('button', {
                type: 'button',
                className: 'td-ghost',
                disabled: busy || draft.trim() === '',
                onClick: addItem,
                children: zh ? '添加' : 'Add',
              }),
            ] }),
            permission === 'default'
              ? jsxs('div', { className: 'td-set-row', children: [
                  jsx('button', {
                    type: 'button',
                    className: 'td-ghost',
                    onClick: askPermission,
                    children: zh ? '开启系统通知' : 'Enable notifications',
                  }),
                  jsx('span', { className: 'td-note-line', children: zh
                    ? '提醒需要这个页面开着；关掉 Harness 就不会响。'
                    : 'Reminders need this page open; nothing fires while Harness is closed.' }),
                ] })
              : permission === 'denied'
                ? jsx('span', { className: 'td-note-line', children: zh
                    ? '系统通知被拒绝，提醒只显示在标题栏（可在浏览器设置里改回）。'
                    : 'System notifications are blocked; reminders show in the title bar only.' })
                : null,
            notice
              ? jsx('span', { className: `td-msg${notice.bad ? ' is-bad' : notice.good ? ' is-good' : ''}`, children: notice.text })
              : null,
            // ── the list ─────────────────────────────────────────────────────
            openCount === 0 && (groups.done ?? []).length === 0
              ? jsx('span', { className: 'td-empty', children: zh ? '没有待办。上面输入一行就能加。' : 'Nothing to do. Add one above.' })
              : null,
            (groups.overdue ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '逾期' : 'OVERDUE', jsx('em', { children: String(groups.overdue.length) })] }),
                  rowsOf(groups.overdue),
                ] })
              : null,
            (groups.today ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '今天' : 'TODAY', jsx('em', { children: String(groups.today.length) })] }),
                  rowsOf(groups.today),
                ] })
              : null,
            (groups.tomorrow ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '明天' : 'TOMORROW', jsx('em', { children: String(groups.tomorrow.length) })] }),
                  rowsOf(groups.tomorrow),
                ] })
              : null,
            (groups.later ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '以后' : 'LATER', jsx('em', { children: String(groups.later.length) })] }),
                  rowsOf(groups.later),
                ] })
              : null,
            (groups.someday ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '无日期' : 'NO DATE', jsx('em', { children: String(groups.someday.length) })] }),
                  rowsOf(groups.someday),
                ] })
              : null,
            (groups.done ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '已完成' : 'DONE', jsx('em', { children: String((groups.done ?? []).length) })] }),
                  rowsOf((groups.done ?? []).slice(0, 5)),
                ] })
              : null,
            // ── settings ─────────────────────────────────────────────────────
            showSet
              ? jsxs('div', { className: 'td-set', children: [
                  jsxs('div', { className: 'td-set-row', children: [
                    jsx('span', { className: 'td-set-label', children: zh ? '日历订阅' : 'FEEDS' }),
                    jsx('span', { className: 'td-note-line', children: zh
                      ? '粘贴 .ics 订阅地址（飞书/钉钉日历共享、Outlook、邮箱日历都可以），只读同步。'
                      : 'Paste an .ics subscription URL (Feishu/DingTalk calendar share, Outlook, mail calendar). Read-only.' }),
                  ] }),
                  (snapshot?.feedSettings ?? []).map((feed) => {
                    const status = (snapshot?.feeds ?? []).find((entry) => entry.url === feed.url)
                    return jsxs('div', { className: 'td-feed', key: feed.url }, [
                      jsx('span', { className: 'td-title', children: feed.label }),
                      jsx('span', { className: `td-feed-state${status?.error ? ' is-bad' : ''}`, children: status?.error
                        ?? (status?.count === undefined ? (zh ? '未同步' : 'not synced') : `${status.count} 项`)
                        ?? '' }),
                      status?.unsupported?.length > 0
                        ? jsx('span', { className: 'td-approx', title: status.unsupported.join(', '), children: zh ? '部分规则未展开' : 'partial rules' })
                        : null,
                      jsx('span', { className: 'td-spacer', style: { marginLeft: 'auto' } }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-mini',
                        title: feed.enabled ? (zh ? '暂停这个订阅' : 'Pause') : (zh ? '启用' : 'Enable'),
                        onClick: () => send('settings', {
                          feeds: (snapshot?.feedSettings ?? []).map((entry) => (entry.url === feed.url ? { ...entry, enabled: !entry.enabled } : entry)),
                        }),
                        children: feed.enabled ? (zh ? '暂停' : 'Pause') : (zh ? '启用' : 'On'),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-mini',
                        title: zh ? '删除这个订阅' : 'Remove',
                        onClick: () => send('settings', { feeds: (snapshot?.feedSettings ?? []).filter((entry) => entry.url !== feed.url) }),
                        children: zh ? '删除' : 'Del',
                      }),
                    ])
                  }),
                  jsxs('div', { className: 'td-add', children: [
                    jsx('input', {
                      className: 'td-input',
                      value: feedDraft.url,
                      placeholder: 'https://…/basic.ics',
                      onChange: (event) => setFeedDraft((current) => ({ ...current, url: event.target.value })),
                    }),
                    jsx('input', {
                      className: 'td-time',
                      style: { width: '88px' },
                      value: feedDraft.label,
                      placeholder: zh ? '名称' : 'name',
                      onChange: (event) => setFeedDraft((current) => ({ ...current, label: event.target.value })),
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy || feedDraft.url.trim() === '',
                      onClick: async () => {
                        // Probe BEFORE saving: the reason a subscription fails is
                        // only useful while the URL is still on screen.
                        const probe = await send('feed', { url: feedDraft.url.trim(), label: feedDraft.label.trim() })
                        if (probe?.ok !== true) return
                        const feeds = [...(snapshot?.feedSettings ?? []), { url: feedDraft.url.trim(), label: feedDraft.label.trim() || `订阅 ${(snapshot?.feedSettings ?? []).length + 1}`, enabled: true }]
                        const saved = await send('settings', { feeds })
                        if (saved?.ok !== false) {
                          setFeedDraft({ url: '', label: '' })
                          setNotice({ good: true, text: zh ? `已添加，读到 ${probe.counts?.occurrences ?? 0} 项` : `Added, ${probe.counts?.occurrences ?? 0} items` })
                        }
                      },
                      children: zh ? '测试并添加' : 'Test + add',
                    }),
                  ] }),
                  jsxs('div', { className: 'td-set-row', children: [
                    jsx('span', { className: 'td-set-label', children: zh ? '下班提醒' : 'DIGEST' }),
                    jsx('input', {
                      className: 'td-time',
                      style: { width: '72px' },
                      value: digestDraft,
                      placeholder: '16:30',
                      onChange: (event) => setDigestDraft(event.target.value),
                    }),
                    jsx('span', { className: 'td-note-line', children: zh ? '到点提醒明天的事项（没有就不打扰）' : 'Reminds you about tomorrow (only if there is something)' }),
                  ] }),
                  jsxs('div', { className: 'td-set-row', children: [
                    jsx('span', { className: 'td-set-label', children: zh ? '提前提醒' : 'LEADS' }),
                    jsx('input', {
                      className: 'td-input',
                      style: { maxWidth: '150px' },
                      value: leadsDraft,
                      placeholder: '60,30,5',
                      onChange: (event) => setLeadsDraft(event.target.value),
                    }),
                    jsx('span', { className: 'td-note-line', children: zh ? '分钟，逗号分隔' : 'minutes, comma separated' }),
                    jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy,
                      onClick: () => send('settings', {
                        digestAt: digestDraft || snapshot?.digestAt,
                        leads: leadsDraft.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0),
                      }),
                      children: zh ? '保存' : 'Save',
                    }),
                  ] }),
                  jsx('span', { className: 'td-note-line', children: zh
                    ? '飞书/钉钉的待办 API 需要企业应用与用户授权，邮箱需要 IMAP 凭据 —— 本插件不走这两条路，日历订阅覆盖了同样的信息。'
                    : 'Feishu/DingTalk task APIs need an enterprise app and user OAuth; mail needs IMAP credentials. Neither is used — calendar subscription covers the same ground.' }),
                  // ── 邮箱：IMAP + 授权码 ────────────────────────────────────
                  // Neither of these is an API key from a dashboard. Both are
                  // logins the user already has, which is why the card asks for a
                  // 授权码 (mail) or an app id + secret (OAuth) and nothing else.
                  jsxs('div', { className: 'td-sec', children: [
                    jsxs('div', { className: 'td-sec-head', children: [
                      jsx('span', { className: 'td-sec-title', children: zh ? '邮箱（IMAP）' : 'MAIL (IMAP)' }),
                      jsx('span', {
                        className: `td-sec-state${snapshot?.mail?.host && mailList !== null ? ' is-on' : ''}`,
                        children: !snapshot?.mail?.host
                          ? (zh ? '未配置' : 'not set')
                          : mailList === null
                            ? (zh ? '已配置' : 'set')
                            : (zh ? `读到 ${mailList.length} 封` : `${mailList.length} read`),
                      }),
                    ] }),
                    jsx('span', { className: 'td-note-line', children: zh
                      ? '用「授权码 / 应用专用密码」，不是账号密码（163、126、QQ、腾讯企业邮、阿里云都支持）。只读最近的邮件标题，读信不会把它们标成已读。'
                      : 'Use the app password (授权码), not the account password. Headers only, and reading does not mark mail as read.' }),
                    jsxs('div', { className: 'td-add', children: [
                      jsx(TdSelect, {
                        value: mailDraft?.preset ?? 'custom',
                        title: zh ? '常见的 IMAP 服务商' : 'common IMAP providers',
                        options: Object.entries(snapshot?.mailPresets ?? {}).map(([key, value]) => ({ value: key, label: value.label })),
                        onChange: (preset) => {
                          const known = snapshot?.mailPresets?.[preset]
                          setMailDraft((current) => ({ ...(current ?? {}), preset, host: known?.host ?? current?.host ?? '', port: known?.port ?? 993 }))
                        },
                      }),
                      jsx('input', {
                        className: 'td-input td-wide',
                        value: mailDraft?.host ?? '',
                        placeholder: zh ? 'IMAP 服务器' : 'IMAP host',
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), host: event.target.value })),
                      }),
                      jsx('input', {
                        className: 'td-time',
                        style: { width: '62px' },
                        value: String(mailDraft?.port ?? 993),
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), port: Number(event.target.value) || 993 })),
                      }),
                    ] }),
                    jsxs('div', { className: 'td-add', children: [
                      jsx('input', {
                        className: 'td-input',
                        value: mailDraft?.user ?? '',
                        placeholder: zh ? '邮箱账号' : 'account',
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), user: event.target.value })),
                      }),
                      jsx('input', {
                        className: 'td-input',
                        type: 'password',
                        value: mailDraft?.secret ?? '',
                        placeholder: snapshot?.mailHasSecret === true ? (zh ? '授权码（已保存，留空不改）' : 'app password (saved)') : (zh ? '授权码' : 'app password'),
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), secret: event.target.value })),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy || mailBusy,
                        onClick: async () => {
                          setMailBusy(true)
                          try {
                            const saved = await send('mail', {
                              preset: mailDraft?.preset,
                              host: mailDraft?.host,
                              port: mailDraft?.port,
                              user: mailDraft?.user,
                              mailbox: mailDraft?.mailbox,
                              limit: mailDraft?.limit,
                              secret: mailDraft?.secret,
                            })
                            if (saved?.ok !== false) {
                              const listed = await send('mail/list', {})
                              if (listed?.ok === true) {
                                setMailList(listed.messages ?? [])
                                setNotice({ good: true, text: zh ? `连接成功，${listed.mailbox} 共 ${listed.total} 封` : `Connected: ${listed.total} in ${listed.mailbox}` })
                              } else {
                                setMailList(null)
                                setNotice({ bad: true, text: listed?.error ?? '读取失败' })
                              }
                            }
                          } finally {
                            setMailBusy(false)
                          }
                        },
                        children: mailBusy ? (zh ? '连接中…' : 'connecting…') : (zh ? '保存并连接' : 'Save + connect'),
                      }),
                    ] }),
                    mailList === null
                      ? null
                      : mailList.length === 0
                        ? jsx('span', { className: 'td-note-line', children: zh ? '这个目录里没有邮件。' : 'No mail in that mailbox.' })
                        : jsxs('div', { children: [
                            jsx('span', { className: 'td-note-line', children: zh
                              ? '点一封加为待办。不自动猜哪封是待办 —— 猜错就是把垃圾塞进清单。'
                              : 'Click one to turn it into a to-do. Nothing guesses which mail is actionable.' }),
                            ...mailList.slice(0, 8).map((message) => jsxs('div', { className: 'td-mail-row', key: String(message.uid ?? message.subject) }, [
                              message.seen === false ? jsx('span', { className: 'td-unread', title: zh ? '未读' : 'unread' }) : null,
                              jsx('span', { className: 'td-mail-sub', title: message.subject, children: message.subject }),
                              jsx('span', { className: 'td-mail-from', title: message.from, children: message.from }),
                              jsx('button', {
                                type: 'button',
                                className: 'td-mini',
                                disabled: busy,
                                onClick: async () => {
                                  const json = await send('add', { title: message.subject, note: message.from })
                                  if (json?.ok !== false) setNotice({ good: true, text: zh ? '已加入待办' : 'Added' })
                                },
                                children: zh ? '加为待办' : 'Add',
                              }),
                            ])),
                          ] }),
                  ] }),
                  // ── 飞书 / 钉钉：登录换 token ────────────────────────────
                  jsxs('div', { className: 'td-sec', children: [
                    jsxs('div', { className: 'td-sec-head', children: [
                      jsx('span', { className: 'td-sec-title', children: zh ? '飞书 / 钉钉（登录）' : 'FEISHU / DINGTALK' }),
                      jsx('span', {
                        className: `td-sec-state${(snapshot?.oauth?.expiresAt ?? 0) > Date.now() ? ' is-on' : ''}`,
                        children: snapshot?.oauth?.provider === ''
                          ? (zh ? '未选择' : 'pick one')
                          : (snapshot?.oauth?.expiresAt ?? 0) > Date.now()
                            ? (zh ? '已登录' : 'signed in')
                            : (zh ? '未登录' : 'not signed in'),
                      }),
                    ] }),
                    // The one thing a plugin cannot do, said plainly and first.
                    jsxs('span', { className: 'td-note-line', children: [
                      zh ? '需要你先在开放平台创建一个「自建应用」并把回调地址填成 ' : 'You must first create a self-built app and set its redirect URI to ',
                      jsx('code', { children: snapshot?.oauth?.redirectUri || `${location.origin}/dsh-hud/todo/callback` }),
                      zh ? '。插件无法替你创建应用，也无法替你通过企业审批。' : '. A plugin cannot create the app or approve it for you.',
                    ] }),
                    jsxs('div', { className: 'td-add', children: [
                      jsx(TdSelect, {
                        value: loginDraft?.provider ?? '',
                        placeholder: zh ? '选择服务商' : 'choose',
                        options: [
                          { value: '', label: zh ? '选择服务商' : 'choose' },
                          { value: 'feishu', label: zh ? '飞书' : 'Feishu' },
                          { value: 'dingtalk', label: zh ? '钉钉' : 'DingTalk' },
                        ],
                        onChange: (provider) => setLoginDraft((current) => ({ ...(current ?? {}), provider })),
                      }),
                      jsx('input', {
                        className: 'td-input',
                        value: loginDraft?.clientId ?? '',
                        placeholder: snapshot?.oauth?.idField ?? 'client_id',
                        onChange: (event) => setLoginDraft((current) => ({ ...(current ?? {}), clientId: event.target.value })),
                      }),
                      jsx('input', {
                        className: 'td-input',
                        type: 'password',
                        value: loginDraft?.clientSecret ?? '',
                        placeholder: snapshot?.oauth?.secretField ?? 'client_secret',
                        onChange: (event) => setLoginDraft((current) => ({ ...(current ?? {}), clientSecret: event.target.value })),
                      }),
                    ] }),
                    jsxs('div', { className: 'td-set-row', children: [
                      jsx('input', {
                        className: 'td-input td-wide',
                        value: loginDraft?.redirectUri ?? '',
                        placeholder: 'redirect_uri',
                        onChange: (event) => setLoginDraft((current) => ({ ...(current ?? {}), redirectUri: event.target.value })),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy,
                        onClick: async () => {
                          const saved = await send('login', {
                            provider: loginDraft?.provider,
                            clientId: loginDraft?.clientId,
                            clientSecret: loginDraft?.clientSecret,
                            redirectUri: loginDraft?.redirectUri || `${location.origin}/dsh-hud/todo/callback`,
                          })
                          if (saved?.ok === true && saved.authorizeUrl) {
                            setNotice({ good: true, text: zh ? '已保存，点「打开授权页」登录' : 'Saved — open the authorize page' })
                          }
                        },
                        children: zh ? '保存' : 'Save',
                      }),
                      snapshot?.oauth?.provider
                        ? jsx('a', {
                            className: 'td-ghost td-link',
                            href: `/dsh-hud/todo/login?open=1#${encodeURIComponent(loginDraft?.provider ?? '')}`,
                            onClick: async (event) => {
                              // The host builds the URL (parameter names differ per
                              // vendor), so ask for it and open THAT.
                              event.preventDefault()
                              const saved = await send('login', {
                                provider: loginDraft?.provider,
                                clientId: loginDraft?.clientId,
                                clientSecret: loginDraft?.clientSecret,
                                redirectUri: loginDraft?.redirectUri || `${location.origin}/dsh-hud/todo/callback`,
                              })
                              if (saved?.authorizeUrl) window.open(saved.authorizeUrl, '_blank', 'noopener')
                              else setNotice({ bad: true, text: zh ? '还没有填 client id' : 'no client id yet' })
                            },
                            children: zh ? '打开授权页' : 'Open authorize page',
                          })
                        : null,
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy || (snapshot?.oauth?.provider ?? '') === '',
                        onClick: async () => {
                          const json = await send('tasks', {})
                          if (json?.ok === true) setNotice({ good: true, text: zh ? `拉取到 ${json.count} 条待办` : `${json.count} tasks` })
                          else setNotice({ bad: true, text: json?.error ?? '拉取失败' })
                        },
                        children: zh ? '拉取待办' : 'Fetch tasks',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy || (snapshot?.oauth?.provider ?? '') === '',
                        onClick: () => send('login', { logout: true }),
                        children: zh ? '退出登录' : 'Sign out',
                      }),
                    ] }),
                    snapshot?.oauth?.lastError
                      ? jsx('span', { className: 'td-msg is-bad', children: snapshot.oauth.lastError })
                      : null,
                    snapshot?.oauth?.account
                      ? jsx('span', { className: 'td-note-line', children: `${zh ? '当前账号' : 'account'}：${snapshot.oauth.account}` })
                      : null,
                    jsx('span', { className: 'td-note-line', children: zh
                      ? '接口地址按开放平台当前文档预置，可在这里改。若你的租户返回的字段不同，拉取会把原始响应显示出来，而不是假装成功。'
                      : 'Endpoint defaults come from the vendors\' docs and are editable here. If your tenant answers differently, the raw response is shown.' }),
                  ] }),
                ] })
              : null,
          ] })
        : null,
    ] })
  }

  /** One row: checkbox, title, when, source, actions. */
  function TodoRow(props) {
    const { item, zh, now, busy } = props
    const minutes = item.dueAt === undefined ? undefined : tdMinutesUntil(item.dueAt, now)
    const overdue = minutes !== undefined && minutes < 0
    const soon = minutes !== undefined && minutes >= 0 && minutes <= 60
    return jsxs('div', { className: `td-row${item.done ? ' is-done' : ''}`, 'data-id': item.id, children: [
      jsx('button', {
        type: 'button',
        className: 'td-check',
        'aria-pressed': item.done ? 'true' : 'false',
        'aria-label': item.done ? (zh ? '标记未完成' : 'Mark not done') : (zh ? '标记完成' : 'Mark done'),
        disabled: busy || item.readOnly === true,
        title: item.readOnly === true ? (zh ? '来自订阅，不能在这里勾选' : 'From a feed; not editable here') : undefined,
        onClick: () => props.onPatch?.({ done: !item.done }),
        children: item.done ? '✓' : '',
      }),
      jsxs('div', { className: 'td-body', children: [
        jsx('span', { className: 'td-title', children: item.title }),
        jsxs('span', { className: 'td-meta', children: [
          item.dueAt === undefined
            ? null
            : jsx('span', {
                className: `td-due${overdue ? ' is-overdue' : soon ? ' is-soon' : ''}`,
                children: `${tdWhen(item.dueAt, now, zh)}${overdue ? (zh ? ' · 已过' : ' · late') : soon ? ` · ${tdLeadLabel(minutes, zh)}` : ''}`,
              }),
          item.readOnly === true ? jsx('span', { className: 'td-src', children: item.source ?? 'ics' }) : null,
          item.approx === true ? jsx('span', { className: 'td-approx', children: zh ? '重复规则未完全展开' : 'rule approximated' }) : null,
          item.note ? jsx('span', { className: 'td-note', children: item.note.slice(0, 80) }) : null,
        ] }),
      ] }),
      jsxs('span', { className: 'td-acts', children: [
        item.readOnly === true || item.done
          ? null
          : jsx('button', {
              type: 'button',
              className: 'td-mini',
              disabled: busy,
              title: zh ? '推迟一小时' : 'Snooze an hour',
              onClick: () => props.onPatch?.({ snoozeMinutes: 60 }),
              children: zh ? '+1h' : '+1h',
            }),
        item.readOnly === true || item.done
          ? null
          : jsx('button', {
              type: 'button',
              className: 'td-mini',
              disabled: busy,
              title: zh ? '推迟到明天同一时间' : 'Snooze to tomorrow',
              onClick: () => props.onPatch?.({ snoozeMinutes: 60 * 24 }),
              children: zh ? '明天' : 'tmrw',
            }),
        jsx('button', {
          type: 'button',
          className: 'td-mini',
          disabled: busy,
          title: item.readOnly === true ? (zh ? '不再显示（不会改动日历）' : 'Hide here (does not touch the calendar)') : (zh ? '删除' : 'Delete'),
          onClick: props.onRemove,
          children: item.readOnly === true ? (zh ? '隐藏' : 'Hide') : (zh ? '删除' : 'Del'),
        }),
      ] }),
    ] })
  }

  return {
    id: 'todo',
    order: 20,
    label: { zh: '待办', en: 'To-do' },
    span: 1,
    defaultOn: false,
    // The whole point of the ask: it belongs on the RIGHT of the title bar.
    headSide: 'right',
    head: TodoHead,
    __test: { tdDueLeads, tdWhen, tdLeadLabel, tdMinutesUntil, tdReadLedger, tdWriteLedger, tdClock, TD_STORAGE_KEY, TD_TICK_MS },
  }
}

/**
 * A countdown as `mm:ss`. Past an hour it grows an hours field rather than
 * printing `90:00`, which reads like a mistake.
 */
function tdClock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** Fire a system notification when allowed; the HUD line covers the rest. */
function tdNotify(title, body) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
    // `tag` collapses repeats of the same reminder instead of stacking them.
    new Notification(title, { body, tag: 'dsh-hud-todo', silent: false })
    return true
  } catch {
    return false
  }
}