// dsh-hud — browser half of the `github` panel.
//
// This file is a FRAGMENT: `tools/build-client.mjs` concatenates every
// `panels/<id>/client.js` verbatim into the single `dsh-hud` bundle, inside one
// factory scope. It therefore carries no top-level `import` / `export` /
// `return` — everything lives inside `createGithubPanel()` below, and the
// enclosing scope supplies `React`, `jsx`, `jsxs`, `hud` and `registerPanel`.
//
// The shell owns the dock cell, the card's placement and the tab strip (this
// panel only reports its unread count through `hud.setBadge`). Styling is
// inline CSS over the shell's own `--dsw-alias-*` design tokens so the card
// matches the shipped dock entries without importing their internals.
//
// Behaviour:
//  - sign-in has two paths: the GitHub device flow (a code, a link, and the
//    card polls GitHub's own interval) or a pasted personal access token;
//  - repositories are chosen from the account's OWN repos, and every watched
//    repo gets a page in the feed; several pages carousel on a timer, pause
//    while hovered, and the dots switch them by hand;
//  - the host owns the token and the polling; the card only reads
//    `/dsh-hud/github/state` on the cadence the host reports (`pollMs`).
function createGithubPanel() {
    /** Self-diagnostics, filterable in the console with `ghh`. */
    const dbg = (...args) => {
      try {
        console.log('[ghh]', ...args)
      } catch {
        /* console unavailable */
      }
    }

    // ── constants ──────────────────────────────────────────────────────────
    const CLOCK_MS = 15_000
    const FETCH_TIMEOUT_MS = 20_000
    const DEFAULT_POLL_MS = 60_000
    const MIN_POLL_MS = 20_000
    const DEFAULT_CAROUSEL_MS = 9_000
    const MIN_CAROUSEL_MS = 4_000
    /** Feed rows rendered per page; the body scrolls beyond this. */
    const VISIBLE_ROWS = 6
    /** Sentinel id for the "everything, merged" page. */
    const ALL_PAGE = '__all__'

    /**
     * Event kinds → badge label and tone. `tone` maps to one of the palette
     * classes in the stylesheet; the label is the human word for the row.
     */
    const KINDS = {
      release: { zh: '发布', en: 'release', tone: 'brand' },
      update: { zh: '更新', en: 'update', tone: 'brand' },
      push: { zh: '推送', en: 'push', tone: 'info' },
      branch: { zh: '分支', en: 'branch', tone: 'ok' },
      tag: { zh: '标签', en: 'tag', tone: 'ok' },
      merge: { zh: '合并', en: 'merge', tone: 'ok' },
      pr: { zh: 'PR', en: 'PR', tone: 'info' },
      review: { zh: '评审', en: 'review', tone: 'muted' },
      issue: { zh: 'Issue', en: 'issue', tone: 'warn' },
      comment: { zh: '评论', en: 'comment', tone: 'muted' },
      delete: { zh: '删除', en: 'delete', tone: 'danger' },
      fork: { zh: 'Fork', en: 'fork', tone: 'muted' },
      star: { zh: 'Star', en: 'star', tone: 'warn' },
      wiki: { zh: 'Wiki', en: 'wiki', tone: 'muted' },
      member: { zh: '成员', en: 'member', tone: 'muted' },
      public: { zh: '公开', en: 'public', tone: 'brand' },
      create: { zh: '新建', en: 'create', tone: 'ok' },
      other: { zh: '动态', en: 'event', tone: 'muted' },
    }

    const TONES = ['brand', 'info', 'ok', 'warn', 'danger', 'muted']

    // ── helpers ────────────────────────────────────────────────────────────
    function pickLocale() {
      try {
        const html = document.documentElement.lang || ''
        if (/^zh/i.test(html)) return 'zh'
        if (navigator.language && /^zh/i.test(navigator.language)) return 'zh'
      } catch {
        /* no document: fall through */
      }
      return 'en'
    }

    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    /** Compact relative time; falls back to an absolute stamp past a week. */
    function sinceLabel(at, now, lang) {
      const ms = num(at)
      if (ms === undefined) return ''
      const delta = Math.max(0, now - ms)
      const minutes = Math.floor(delta / 60_000)
      if (minutes < 1) return lang === 'zh' ? '刚刚' : 'now'
      if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`
      const days = Math.floor(hours / 24)
      if (days < 7) return lang === 'zh' ? `${days} 天前` : `${days}d ago`
      return new Date(ms).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit' })
    }

    function clockLabel(at, lang) {
      const ms = num(at)
      if (ms === undefined) return ''
      return new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
    }

    function kindMeta(kind, lang) {
      const meta = KINDS[kind] ?? KINDS.other
      return { label: lang === 'zh' ? meta.zh : meta.en, tone: TONES.includes(meta.tone) ? meta.tone : 'muted' }
    }

    /** `3 分钟前` — an age is what you act on; a timestamp is what you look up. */
    function relativeTime(at, now, lang) {
      const ms = num(at)
      if (ms === undefined) return ''
      const seconds = Math.max(0, Math.round(((num(now) ?? Date.now()) - ms) / 1000))
      if (lang === 'zh') {
        if (seconds < 60) return `${seconds} 秒前`
        if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
        if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
        return `${Math.floor(seconds / 86_400)} 天前`
      }
      if (seconds < 60) return `${seconds}s ago`
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
      if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
      return `${Math.floor(seconds / 86_400)}d ago`
    }

    /**
     * One CI line for a repository: the newest run, its verdict as a WORD, and how
     * long ago it started.
     *
     * A run that is still going says so. `conclusion === null` is the trap here —
     * treating "not success" as failure reports every running build as broken, and
     * a real response (verified against GitHub) is exactly
     * `status: in_progress, conclusion: null`.
     */
    function CiLine(props) {
      const { ci, lang, now } = props
      if (ci === undefined || ci === null) return null
      if (ci.available === false) {
        return jsx('span', { className: 'ghh-ci is-muted', children: ci.reason ?? (lang === 'zh' ? '读不到 CI' : 'CI unavailable') })
      }
      const latest = ci.latest
      if (latest === undefined) {
        return jsx('span', { className: 'ghh-ci is-muted', children: lang === 'zh' ? '没有 CI 记录' : 'no CI runs' })
      }
      const running = latest.conclusion === undefined
      const tone = running ? 'is-running' : /success|neutral|skipped/i.test(latest.conclusion ?? '') ? 'is-ok' : 'is-bad'
      return jsxs('span', { className: `ghh-ci ${tone}`, title: latest.url, children: [
        jsx('span', { className: 'ghh-ci-dot', 'aria-hidden': true }),
        jsx('span', { className: 'ghh-ci-name', children: latest.name }),
        jsx('span', { className: 'ghh-ci-verdict', children: running ? (lang === 'zh' ? '进行中' : latest.status) : latest.conclusion }),
        latest.branch ? jsx('span', { className: 'ghh-ci-branch', children: latest.branch }) : null,
        jsx('span', { className: 'ghh-ci-at', children: relativeTime(latest.at, now, lang) }),
        // Counts make a fleet readable at a glance: one failing run out of five is
        // a different situation from five.
        (ci.failing ?? 0) > 1 ? jsx('span', { className: 'ghh-ci-count', children: `${ci.failing} ${lang === 'zh' ? '失败' : 'failed'}` }) : null,
        (ci.running ?? 0) > 1 ? jsx('span', { className: 'ghh-ci-count', children: `${ci.running} ${lang === 'zh' ? '进行中' : 'running'}` }) : null,
      ] })
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    /** Bounded fetch: an unresponsive host fails the poll instead of hanging it. */
    async function fetchJson(url, init) {
      let res
      try {
        res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(/timeout|abort/i.test(message) ? `请求超时（${FETCH_TIMEOUT_MS / 1000}s）` : `网络错误：${message}`)
      }
      const json = await res.json().catch(() => null)
      if (!json) throw new Error(`HTTP ${res.status}（响应不是 JSON）`)
      if (json.ok === false) throw new Error(String(json.error ?? `HTTP ${res.status}`))
      return json
    }

    const postJson = (url, body) =>
      fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          return ok
        } catch {
          return false
        }
      }
    }

    // ── styles ─────────────────────────────────────────────────────────────
    /**
     * Every colour is a design token so the card follows the active theme.
     * The root stays sticky with an opaque surface: the transcript scrolls
     * behind it rather than through it.
     */
    const CSS_ID = 'dsh-hud/github.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-hud'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        '.ghh-root{position:sticky;top:0;z-index:999;isolation:isolate;display:flex;width:100%;padding:0 2px 2px;font-family:inherit;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-root.is-left{justify-content:flex-start}',
        '.ghh-root.is-center{justify-content:center}',
        '.ghh-root.is-right{justify-content:flex-end}',
        '.ghh-card{box-sizing:border-box;width:min(100%,460px);display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:inset 0 1px 0 rgba(255,255,255,.65),0 1px 2px rgba(0,0,0,.05),0 10px 28px -18px rgba(15,17,21,.45);overflow:hidden}',
        '.ghh-root.is-stretch .ghh-card{width:100%}',
        // header
        '.ghh-head{display:flex;align-items:center;gap:8px;padding:8px 11px;font-size:12px;line-height:16px}',
        '.ghh-mark{flex:none;width:15px;height:15px;color:var(--dsw-alias-label-primary,#0f1115);opacity:.9}',
        '.ghh-title{font-weight:600;letter-spacing:.01em;flex:none}',
        '.ghh-who{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        // unread badge
        '.ghh-unread{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff;font-size:10px;font-weight:600;line-height:16px}',
        // quiet buttons
        '.ghh-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;padding:1px 8px;border-radius:999px;color:var(--dsw-alias-state-business-primary,#3964fe);font-size:11px;line-height:16px;cursor:pointer;transition:background .15s ease,border-color .15s ease;font-family:inherit}',
        '.ghh-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
        '.ghh-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
        '.ghh-btn:disabled{opacity:.55;cursor:default}',
        '.ghh-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-btn.is-quiet:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-btn.is-primary{background:var(--dsw-alias-state-business-primary,#3964fe);border-color:transparent;color:#fff}',
        '.ghh-btn.is-primary:hover{background:var(--dsw-alias-state-business-primary,#3964fe);filter:brightness(1.08)}',
        // repository tabs
        '.ghh-tabs{display:flex;align-items:center;gap:6px;padding:0 11px 7px;overflow-x:auto;scrollbar-width:none}',
        '.ghh-tabs::-webkit-scrollbar{display:none}',
        '.ghh-tab{flex:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap;font-family:inherit;display:inline-flex;align-items:center;gap:5px}',
        '.ghh-tab:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}',
        '.ghh-tab.is-active{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
        '.ghh-tabdot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);flex:none}',
        // body
        // The BODY only: the head and the tab strip keep their own rows, because a title bar that wrapped
      // into the content would stop reading as a title bar.
      //
      // Two panes: the left rail holds what DESCRIBES the card (a CI line, a review request, the
      // "nothing happened" note), the right pane holds the event LIST. Everything a reader scans
      // repeatedly is in one column, and the column is on the right because that is where a list
      // is read from.
      '.ghh-body{display:grid;grid-template-columns:minmax(90px,40%) minmax(0,1fr);align-items:start;gap:5px 12px;max-height:184px;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
        '.ghh-body::-webkit-scrollbar{width:8px}',
        '.ghh-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:4px}',
        // The events go in the right-hand pane. Every other child of the body falls into the left
      // rail by default, which is exactly the split wanted and needs no change to the render tree.
      '.ghh-row{grid-column:2;display:flex;align-items:flex-start;gap:8px;padding:6px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));text-decoration:none;color:inherit;cursor:pointer}',
        '.ghh-row:last-child{border-bottom:0}',
        '.ghh-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
        '.ghh-row.is-unread .ghh-rowtitle{font-weight:600}',
        '.ghh-row.is-unread::before{content:"";flex:none;width:5px;height:5px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe)}',
        // badges
        '.ghh-badge{flex:none;display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;font-size:10px;font-weight:600;letter-spacing:.02em;white-space:nowrap}',
        '.ghh-badge.t-brand{background:rgba(57,100,254,.13);color:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ghh-badge.t-info{background:rgba(14,140,190,.14);color:#0e7fa8}',
        '.ghh-badge.t-ok{background:rgba(34,160,107,.14);color:#1c8459}',
        '.ghh-badge.t-warn{background:rgba(245,158,11,.16);color:#a96800}',
        '.ghh-badge.t-danger{background:rgba(239,68,68,.14);color:#c53030}',
        '.ghh-badge.t-muted{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.07));color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.ghh-rowtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-rowmeta{display:flex;align-items:center;gap:6px;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ghh-rowmeta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ghh-avatar{flex:none;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(0,0,0,.15));object-fit:cover}',
        '.ghh-repo{flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-when{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,#81858c)}',
        // footer
        '.ghh-foot{display:flex;align-items:center;gap:8px;padding:6px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ghh-foot .ghh-spacer{margin-left:auto}',
        // panels (login, picker, settings)
        '.ghh-panel{display:flex;flex-direction:column;gap:9px;padding:11px}',
        '.ghh-panelhead{display:flex;align-items:center;gap:8px}',
        '.ghh-paneltitle{font-size:12px;font-weight:600}',
      // ── waiting on me ──────────────────────────────────────────────────
      // A review request is addressed to a person, so this block reads like a
      // list of things to do rather than like a feed.
      '.ghh-reviews{border-left:2px solid var(--dsw-alias-state-business-primary,#3964fe);padding-left:8px}',
      '.ghh-review{display:flex;align-items:baseline;gap:7px;padding:2px 0;text-decoration:none;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ghh-review:hover .ghh-review-title{text-decoration:underline}',
      '.ghh-review-repo{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.ghh-review-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ghh-review-draft{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ghh-review-at{flex:none;font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── CI ─────────────────────────────────────────────────────────────
      // Colour is the second signal; the verdict is always a word too, because
      // "queued" and "cancelled" are not distinguishable by hue.
      '.ghh-cipanel{padding:5px 0}',
      '.ghh-ci{display:inline-flex;align-items:baseline;gap:6px;font-size:11px;line-height:16px;min-width:0;font-variant-numeric:tabular-nums}',
      '.ghh-ci-dot{flex:none;align-self:center;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#b6bac1)}',
      '.ghh-ci.is-ok .ghh-ci-dot{background:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.ghh-ci.is-bad .ghh-ci-dot{background:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.ghh-ci.is-running .ghh-ci-dot{background:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.ghh-ci-name{color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}',
      '.ghh-ci.is-bad .ghh-ci-verdict{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}',
      '.ghh-ci.is-ok .ghh-ci-verdict{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.ghh-ci.is-running .ghh-ci-verdict{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.ghh-ci.is-muted{color:var(--dsw-alias-label-caption,#81858c)}',
      '.ghh-ci-branch{color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}',
      '.ghh-ci-at,.ghh-ci-count{margin-left:auto;color:var(--dsw-alias-label-caption,#81858c);font-size:10px}',
      '.ghh-ci-count{margin-left:6px}',
        '.ghh-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-note.is-error{color:var(--dsw-alias-state-error-primary,#d33)}',
        '.ghh-note.is-ok{color:#1c8459}',
        '.ghh-notice{padding:6px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
        '.ghh-steps{display:flex;flex-direction:column;gap:4px}',
        '.ghh-step{position:relative;padding-left:13px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-step::before{content:"›";position:absolute;left:3px;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-code{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
        '.ghh-usercode{flex:1 1 auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:17px;font-weight:600;letter-spacing:.14em;color:var(--dsw-alias-state-business-primary,#3964fe);user-select:all;text-align:center}',
        '.ghh-input{box-sizing:border-box;width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px;line-height:16px}',
        '.ghh-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
        '.ghh-input.is-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
        '.ghh-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.ghh-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none;border-bottom:1px dotted currentColor;word-break:break-all}',
        '.ghh-link:hover{border-bottom-style:solid}',
        // repository picker list
        '.ghh-repolist{display:flex;flex-direction:column;max-height:186px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px}',
        '.ghh-repolist::-webkit-scrollbar{width:8px}',
        '.ghh-repolist::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:4px}',
        '.ghh-repoitem{display:flex;align-items:center;gap:8px;padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));font-size:11.5px}',
        '.ghh-repoitem:last-child{border-bottom:0}',
        '.ghh-repoitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
        '.ghh-reponame{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-repodesc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-lock{flex:none;font-size:9.5px;padding:0 5px;height:15px;line-height:15px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.07));color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-grid{display:grid;grid-template-columns:auto 1fr;gap:7px 10px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
        // settings drawer
        '.ghh-drawer{display:flex;flex-direction:column;gap:8px;padding:9px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
        '.ghh-drawer-btn{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px;cursor:pointer;font-family:inherit}',
        '.ghh-drawer-btn:hover{color:var(--dsw-alias-state-business-primary,#3964fe)}',
        // motion: draw-in only, and never for reduced-motion users
        '.ghh-fade{animation:ghh-fade .24s ease-out backwards}',
        '@keyframes ghh-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
        '@media (prefers-reduced-motion:reduce){.ghh-fade{animation:none}}',
        // narrow docks: the side alignment would waste width, so fill it
        '@media (max-width:720px){.ghh-card{width:100%}}',
      ].join('')
      document.head.appendChild(tag)
    }

    // ── small presentational pieces ────────────────────────────────────────

    /** GitHub's mark, inline so the bundle stays dependency-free. */
    function GithubMark(props) {
      return jsx('svg', {
        className: 'ghh-mark',
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
        fill: 'currentColor',
        ...props,
        children: jsx('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        }),
      })
    }

    function KindBadge(props) {
      const meta = kindMeta(props.kind, props.lang)
      return jsx('span', { className: `ghh-badge t-${meta.tone}`, title: props.kind, children: meta.label })
    }

    /** One feed row. A real anchor, so middle-click and copy-link both work. */
    function EventRow(props) {
      const { item, lang, now, showRepo } = props
      const meta = []
      if (item.detail) meta.push(item.detail)
      return jsxs('a', {
        className: `ghh-row${item.unread ? ' is-unread' : ''}`,
        href: item.url || undefined,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: `${clockLabel(item.at, lang)}${item.actor ? ` · ${item.actor}` : ''}`,
        children: [
          jsx(KindBadge, { kind: item.kind, lang }),
          jsxs('span', { className: 'ghh-main', children: [
            jsx('span', { className: 'ghh-rowtitle', children: item.title }),
            jsxs('span', { className: 'ghh-rowmeta', children: [
              item.avatar
                ? jsx('img', { className: 'ghh-avatar', src: item.avatar, alt: '', loading: 'lazy' })
                : null,
              item.actor ? jsx('span', { children: item.actor }) : null,
              showRepo && item.repo ? jsx('span', { className: 'ghh-repo', children: item.repo }) : null,
              meta.length > 0 ? jsx('span', { children: meta.join(' · ') }) : null,
            ] }),
          ] }),
          jsx('span', { className: 'ghh-when', children: sinceLabel(item.at, now, lang) }),
        ],
      })
    }

    function Note(props) {
      return jsx('div', { className: `ghh-note${props.tone ? ` is-${props.tone}` : ''}`, children: props.children })
    }

    // ── main card ──────────────────────────────────────────────────────────
    /**
     * All hooks run unconditionally at the top: a conditional hook would shift
     * the order between renders and take the whole dock entry down with
     * React's "Rendered fewer hooks than expected".
     */
    function GithubHud(props = {}) {
      const lang = pickLocale()
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const [page, setPage] = React.useState(0)
      const [hovering, setHovering] = React.useState(false)
      const [panel, setPanel] = React.useState(null) // 'login' | 'picker' | 'settings' | null
      const [loginMode, setLoginMode] = React.useState('device')
      const [device, setDevice] = React.useState(null)
      const [deviceBusy, setDeviceBusy] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [notice, setNotice] = React.useState(null) // { tone, text }
      const [pickerQuery, setPickerQuery] = React.useState('')
      const [pickerRepos, setPickerRepos] = React.useState([])
      const [form, setForm] = React.useState(null)
      const mounted = React.useRef(true)
      const pollRef = React.useRef(null)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      /** One poll: read the host snapshot, and never stack requests. */
      const poll = React.useCallback(async (force) => {
        if (pollRef.current) return
        pollRef.current = true
        try {
          const json = force ? await postJson('/dsh-hud/github/refresh') : await fetchJson('/dsh-hud/github/state')
          if (!mounted.current) return
          setSnapshot(json)
          setError(null)
        } catch (caught) {
          if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          pollRef.current = false
        }
      }, [])

      // First load, then the host's own cadence (rebuilt whenever it changes).
      const pollMs = clamp(num(snapshot?.pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, 900_000)
      React.useEffect(() => {
        poll(false)
      }, [poll])
      React.useEffect(() => {
        const timer = window.setInterval(() => poll(false), pollMs)
        return () => window.clearInterval(timer)
      }, [poll, pollMs])

      // A cheap clock so relative stamps age without re-fetching.
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
        return () => window.clearInterval(timer)
      }, [])

      // Device-flow polling runs on GitHub's interval, only while a code is live.
      React.useEffect(() => {
        if (!device?.pending) return undefined
        const interval = clamp(num(device.interval) ?? 5, 3, 60) * 1000
        const timer = window.setInterval(async () => {
          try {
            const result = await postJson('/dsh-hud/github/device/poll')
            if (!mounted.current) return
            if (result.status === 'ok') {
              setDevice(null)
              setNotice({ tone: 'ok', text: lang === 'zh' ? '已登录 GitHub' : 'signed in to GitHub' })
              setPanel(null)
              poll(true)
            } else if (result.status === 'error' || result.status === 'expired') {
              setDevice(null)
              setNotice({ tone: 'error', text: result.error ?? 'sign-in failed' })
            } else if (result.status === 'pending' && num(result.interval)) {
              setDevice((current) => (current ? { ...current, interval: result.interval } : current))
            }
          } catch (caught) {
            if (mounted.current) setNotice({ tone: 'error', text: caught instanceof Error ? caught.message : String(caught) })
          }
        }, interval)
        return () => window.clearInterval(timer)
      }, [device, lang, poll])

      // A pending sign-in lives on the host, so a page reload resumes it
      // instead of silently dropping a code the user is about to approve.
      React.useEffect(() => {
        const remote = snapshot?.device
        if (!remote || device) return
        setDevice({
          userCode: remote.userCode,
          verificationUri: remote.verificationUri,
          expiresAt: remote.expiresAt,
          interval: remote.interval,
          pending: true,
        })
      }, [snapshot, device])

      const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : []
      const watched = Array.isArray(snapshot?.watched) ? snapshot.watched : []
      const auth = snapshot?.auth ?? { status: 'missing' }
      const signedIn = auth.status === 'ok'

      // Pages: one per watched repo, plus a merged page once there are several.
      const pages = React.useMemo(() => {
        if (repos.length === 0) return []
        if (repos.length === 1) return [{ id: repos[0].fullName, repo: repos[0] }]
        const merged = {
          fullName: ALL_PAGE,
          items: repos
            .flatMap((repo) => (repo.items ?? []).map((item) => ({ ...item, repo: repo.fullName })))
            .sort((a, b) => b.at - a.at),
          unread: repos.reduce((sum, repo) => sum + (repo.unread ?? 0), 0),
          // A repo that failed must not vanish from the merged page — its error
          // is the only sign the user would otherwise get.
          errors: repos.filter((repo) => repo.error).map((repo) => `${repo.fullName}: ${repo.error}`),
          meta: null,
        }
        return [{ id: ALL_PAGE, repo: merged }, ...repos.map((repo) => ({ id: repo.fullName, repo }))]
      }, [repos])

      // Carousel: only when there is something to rotate, and never mid-hover.
      const carouselMs = clamp(num(snapshot?.carouselMs) ?? DEFAULT_CAROUSEL_MS, MIN_CAROUSEL_MS, 60_000)
      const pageCount = pages.length
      React.useEffect(() => {
        if (pageCount < 2 || hovering || panel !== null) return undefined
        const timer = window.setInterval(() => {
          setPage((current) => (current + 1) % pageCount)
        }, carouselMs)
        return () => window.clearInterval(timer)
      }, [pageCount, hovering, panel, carouselMs])

      React.useEffect(() => {
        if (page >= pageCount && pageCount > 0) setPage(0)
      }, [page, pageCount])

      // ── actions ─────────────────────────────────────────────────────────
      const run = async (label, fn) => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
        } catch (caught) {
          setNotice({ tone: 'error', text: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          if (mounted.current) setBusy(false)
        }
        void label
      }

      const startDevice = () =>
        run('device', async () => {
          setDeviceBusy(true)
          try {
            const result = await postJson('/dsh-hud/github/device/start')
            setDevice({
              userCode: result.userCode,
              verificationUri: result.verificationUri,
              expiresAt: result.expiresAt,
              interval: result.interval,
              pending: true,
            })
            setNotice({ tone: undefined, text: lang === 'zh' ? '在 GitHub 页面输入下面这串代码，然后回到这里等它自动完成。' : 'Enter the code on GitHub, then wait here — this card finishes on its own.' })
          } finally {
            if (mounted.current) setDeviceBusy(false)
          }
        })

      const cancelDevice = () =>
        run('cancel', async () => {
          await postJson('/dsh-hud/github/device/cancel')
          setDevice(null)
          setNotice(null)
        })

      const saveToken = () =>
        run('token', async () => {
          const value = draft.trim()
          if (value === '') return
          const result = await postJson('/dsh-hud/github/credential', { value })
          setDraft('')
          setNotice({ tone: 'ok', text: `${lang === 'zh' ? '已保存到' : 'saved to'} ${result.how}（${result.account?.login ?? ''}）` })
          setPanel(null)
          await poll(true)
        })

      const loadRepos = (force) =>
        run('repos', async () => {
          const result = await fetchJson(`/dsh-hud/github/repos${force ? '?refresh=1' : ''}`)
          setPickerRepos(Array.isArray(result.repos) ? result.repos : [])
        })

      const watch = (repo, action) =>
        run('watch', async () => {
          await postJson('/dsh-hud/github/watch', { action, repo })
          const result = await fetchJson('/dsh-hud/github/repos')
          setPickerRepos(Array.isArray(result.repos) ? result.repos : [])
          await poll(true)
        })

      const markRead = () =>
        run('read', async () => {
          await postJson('/dsh-hud/github/read', {})
          await poll(true)
        })

      const saveSettings = () =>
        run('settings', async () => {
          const result = await postJson('/dsh-hud/github/settings', {
            pollMs: Number(form.pollMs),
            carouselMs: Number(form.carouselMs),
            perRepoLimit: Number(form.perRepoLimit),
            proxy: form.proxy,
            align: form.align,
            scopes: form.scopes,
            clientId: form.clientId,
          })
          setForm(null)
          setNotice({ tone: 'ok', text: lang === 'zh' ? '设置已保存' : 'settings saved' })
          void result
          await poll(true)
        })

      const logout = () =>
        run('logout', async () => {
          await postJson('/dsh-hud/github/logout')
          setSnapshot(null)
          setNotice({ tone: undefined, text: lang === 'zh' ? '已退出 GitHub' : 'signed out of GitHub' })
          await poll(false)
        })

      const openPanel = (name) => {
        setNotice(null)
        setPanel((current) => (current === name ? null : name))
        if (name === 'picker') loadRepos(false)
        if (name === 'settings' && snapshot) {
          setForm({
            pollMs: snapshot.settings?.pollMs ?? DEFAULT_POLL_MS,
            carouselMs: snapshot.settings?.carouselMs ?? DEFAULT_CAROUSEL_MS,
            perRepoLimit: snapshot.settings?.perRepoLimit ?? 30,
            proxy: snapshot.settings?.proxy ?? 'auto',
            align: snapshot.settings?.align ?? 'right',
            scopes: snapshot.settings?.scopes ?? 'repo read:user',
            clientId: snapshot.settings?.clientId ?? '',
          })
        }
      }

      // ── derived view state ──────────────────────────────────────────────
      const align = ['left', 'center', 'right', 'stretch'].includes(snapshot?.align) ? snapshot.align : 'right'
      const active = pages.length > 0 ? pages[Math.min(page, pages.length - 1)] : null
      const unread = num(snapshot?.unread) ?? 0
      // ── what is waiting on ME ───────────────────────────────────────────
      // The badge is "things that need a human", so it is not just unread events:
      // a review request and a failing pipeline are both that, and both are easy
      // to miss in a dock. `available === false` CI is a state, not a failure.
      const reviews = snapshot?.reviews ?? { total: 0, items: [], error: null }
      const reviewItems = Array.isArray(reviews.items) ? reviews.items : []
      const reviewCount = num(reviews.total) ?? reviewItems.length
      const ciFailing = num(snapshot?.ciFailing) ?? 0
      const ciRunning = num(snapshot?.ciRunning) ?? 0
      const attention = unread + reviewCount + ciFailing

      React.useEffect(() => {
        hud.setBadge('github', attention)
      }, [attention])
      /** The merged page's display name, shared by the header and the tabs. */
      const allPagesLabel = lang === 'zh' ? '全部' : 'all'
      const tokenPresent = snapshot?.credentials?.some((row) => row.ref === snapshot?.settings?.tokenRef && row.present) ?? false
      const transportLabel = snapshot?.transport?.label ?? ''
      const rateLimit = snapshot?.rateLimit

      const headerSub = signedIn
        ? [
            auth.account?.login,
            active ? (active.id === ALL_PAGE ? allPagesLabel : repoTitle(active.id)) : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : lang === 'zh'
          ? '未登录'
          : 'not signed in'

      const showLoginPanel = panel === 'login' || (!signedIn && panel === null)
      const deviceStillPending = Boolean(device?.pending)

      return jsx('div', {
        className: `ghh-root is-${align}`,
        onMouseEnter: () => setHovering(true),
        onMouseLeave: () => setHovering(false),
        children: jsxs('div', { className: 'ghh-card', children: [
          // ── header ──────────────────────────────────────────────────────
          jsxs('div', { className: 'ghh-head', children: [
            jsx(GithubMark, {}),
            jsx('span', { className: 'ghh-title', children: 'GitHub' }),
            jsx('span', { className: 'ghh-who', title: headerSub, children: headerSub }),
            jsxs('span', { className: 'ghh-right', children: [
              unread > 0
                ? jsx('span', { className: 'ghh-unread', title: lang === 'zh' ? `${unread} 条未读` : `${unread} unread`, children: String(unread) })
                : null,
              signedIn
                ? jsx('button', {
                    type: 'button',
                    className: 'ghh-btn is-quiet',
                    onClick: () => openPanel('picker'),
                    disabled: busy,
                    title: lang === 'zh' ? '关注仓库' : 'watched repositories',
                    children: lang === 'zh' ? '仓库' : 'repos',
                  })
                : null,
              signedIn
                ? jsx('button', {
                    type: 'button',
                    className: 'ghh-btn',
                    onClick: () => run('refresh', () => poll(true)),
                    disabled: busy,
                    title: snapshot?.fetchedAt ? `${lang === 'zh' ? '上次更新' : 'updated'} ${clockLabel(snapshot.fetchedAt, lang)}` : undefined,
                    children: busy ? (lang === 'zh' ? '刷新中' : '…') : lang === 'zh' ? '刷新' : 'refresh',
                  })
                : null,
            ] }),
          ] }),

          // ── repository tabs ─────────────────────────────────────────────
          pages.length > 1
            ? jsxs('div', { className: 'ghh-tabs', children: [
                ...pages.map((entry, index) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      className: `ghh-tab${index === page ? ' is-active' : ''}`,
                      onClick: () => setPage(index),
                      title: entry.id === ALL_PAGE ? (lang === 'zh' ? '全部仓库' : 'all repositories') : entry.id,
                      children: [
                        entry.repo.unread > 0 ? jsx('span', { className: 'ghh-tabdot' }) : null,
                        jsx('span', { children: entry.id === ALL_PAGE ? allPagesLabel : repoTitle(entry.id) }),
                      ],
                    },
                    entry.id,
                  ),
                ),
              ] })
            : null,

          // ── body ────────────────────────────────────────────────────────
          showLoginPanel
            ? renderLoginPanel()
            : panel === 'picker'
              ? renderPicker()
              : panel === 'settings' && form
                ? renderSettings()
                : renderFeed(),

          // A single notice slot OUTSIDE the panels: a sign-in confirmation
          // must survive the panel that triggered it closing.
          notice
            ? jsx('div', { className: 'ghh-notice ghh-fade', children: jsx(Note, { tone: notice.tone, children: notice.text }) })
            : null,

          // ── footer ──────────────────────────────────────────────────────
          jsxs('div', { className: 'ghh-foot', children: [
            jsx('button', {
              type: 'button',
              className: 'ghh-drawer-btn',
              onClick: () => openPanel('settings'),
              children: `▸ ${lang === 'zh' ? '设置' : 'settings'}`,
            }),
            signedIn && unread > 0
              ? jsx('button', { type: 'button', className: 'ghh-drawer-btn', onClick: markRead, disabled: busy, children: lang === 'zh' ? '全部已读' : 'mark all read' })
              : null,
            signedIn
              ? jsx('button', { type: 'button', className: 'ghh-drawer-btn', onClick: logout, disabled: busy, children: lang === 'zh' ? '退出' : 'sign out' })
              : null,
            jsx('span', { className: 'ghh-spacer' }),
            rateLimit && num(rateLimit.remaining) !== undefined
              ? jsx('span', { title: lang === 'zh' ? 'GitHub API 剩余额度' : 'GitHub API remaining', children: `${rateLimit.remaining}` })
              : null,
            transportLabel
              ? jsx('span', { title: `${lang === 'zh' ? '网络通道' : 'transport'}: ${transportLabel}`, children: transportLabel === 'direct' ? (lang === 'zh' ? '直连' : 'direct') : 'proxy' })
              : null,
          ] }),
        ] }),
      })

      // ── panel renderers (plain functions: no hooks, so hook order is fixed)

      function repoTitle(fullName) {
        return String(fullName ?? '').split('/').filter(Boolean).slice(-1)[0] || String(fullName ?? '')
      }

      function renderFeed() {
        if (error) {
          return jsx('div', { className: 'ghh-panel', children: jsxs('div', { className: 'ghh-steps', children: [
            jsx(Note, { tone: 'error', children: error }),
            jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '宿主侧未响应——确认插件已启用，然后刷新页面。' : 'The host did not answer — check that the plugin is enabled, then reload.' }),
          ] }) })
        }
        if (!signedIn) return null
        if (watched.length === 0) {
          return jsx('div', { className: 'ghh-panel', children: jsxs('div', { className: 'ghh-steps', children: [
            jsx(Note, { children: lang === 'zh' ? '还没有关注仓库。挑一个自己的仓库开始监控吧。' : 'No repositories watched yet — pick one of your own to start.' }),
            jsx('div', { className: 'ghh-actions', children: jsx('button', { type: 'button', className: 'ghh-btn is-primary', onClick: () => openPanel('picker'), children: lang === 'zh' ? '添加关注仓库' : 'add a repository' }) }),
          ] }) })
        }
        const items = active?.repo?.items ?? []
        // The CI line belongs to a REPOSITORY page, and the merged "all" page has
        // no single pipeline to describe — so it is shown only where it is true.
        const ciRow = active?.id === ALL_PAGE || active?.repo === undefined
          ? null
          : jsx('div', { className: 'ghh-panel ghh-cipanel', children: jsx(CiLine, { ci: active.repo.ci, lang, now }) })
        const errorRows =
          active?.id === ALL_PAGE
            ? active.repo.errors ?? []
            : active?.repo?.error
              ? [active.repo.error]
              : []
        if (items.length === 0) {
          return jsx('div', { className: 'ghh-panel', children: jsxs('div', { className: 'ghh-steps', children: [
            ...errorRows.map((row, index) => jsx(Note, { tone: 'error', children: row }, `err-${index}`)),
            errorRows.length === 0
              ? jsx(Note, {
                  children: lang === 'zh'
                    ? '这个仓库最近没有动静（近 90 天无事件）。'
                    : 'No recent activity in this repository (nothing in the last 90 days).',
                })
              : null,
          ] }) })
        }
        return jsxs('div', { className: 'ghh-body', children: [
          ciRow,
          ...errorRows.map((row, index) =>
            jsx('div', { className: 'ghh-panel', children: jsx(Note, { tone: 'error', children: row }) }, `err-${index}`),
          ),
          // ── waiting on me ────────────────────────────────────────────────
          // Above the feed, because a review request is addressed to YOU and the
          // feed is only news. A search that FAILED says so instead of showing an
          // empty list: `review-requested:@me` is an authenticated query, and
          // signed out it is a 422 rather than "nothing waiting".
          reviewCount > 0 || reviews.error
            ? jsxs('div', { className: 'ghh-panel ghh-reviews', children: [
                jsxs('div', { className: 'ghh-panelhead', children: [
                  jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '等待我评审' : 'Waiting on my review' }),
                  jsx('span', { className: 'ghh-count', children: reviewCount > 0 ? String(reviewCount) : '' }),
                ] }),
                reviews.error ? jsx(Note, { tone: 'error', children: reviews.error }) : null,
                ...reviewItems.slice(0, 4).map((item) => jsxs('a', {
                  className: 'ghh-review',
                  href: item.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  children: [
                    jsx('span', { className: 'ghh-review-repo', children: item.repo ?? '' }),
                    jsx('span', { className: 'ghh-review-title', children: `#${item.number} ${item.title}` }),
                    item.draft ? jsx('span', { className: 'ghh-review-draft', children: lang === 'zh' ? '草稿' : 'draft' }) : null,
                    jsx('span', { className: 'ghh-review-at', children: relativeTime(item.at, now, lang) }),
                  ],
                }, item.id)),
              ] })
            : null,
          ...items.slice(0, Math.max(VISIBLE_ROWS, num(snapshot?.settings?.perRepoLimit) ?? VISIBLE_ROWS)).map((item) =>
            jsx(EventRow, { item, lang, now, showRepo: active?.id === ALL_PAGE }, item.id),
          ),
        ] })
      }

      function renderLoginPanel() {
        return jsxs('div', { className: 'ghh-panel ghh-fade', children: [
          // A host that never answered would otherwise leave this panel looking
          // perfectly normal while nothing can possibly work.
          error ? jsx(Note, { tone: 'error', children: error }) : null,
          jsxs('div', { className: 'ghh-panelhead', children: [
            jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '登录 GitHub' : 'Sign in to GitHub' }),
            jsxs('span', { className: 'ghh-right', children: [
              jsx('button', {
                type: 'button',
                className: `ghh-tab${loginMode === 'device' ? ' is-active' : ''}`,
                onClick: () => setLoginMode('device'),
                children: lang === 'zh' ? '设备码' : 'device code',
              }),
              jsx('button', {
                type: 'button',
                className: `ghh-tab${loginMode === 'token' ? ' is-active' : ''}`,
                onClick: () => setLoginMode('token'),
                children: lang === 'zh' ? '粘贴 Token' : 'paste token',
              }),
            ] }),
          ] }),

          loginMode === 'device'
            ? jsxs('div', { className: 'ghh-steps', children: [
                deviceStillPending
                  ? jsxs('div', { className: 'ghh-steps', children: [
                      jsxs('div', { className: 'ghh-code', children: [
                        jsx('span', { className: 'ghh-usercode', children: device.userCode }),
                        jsx('button', {
                          type: 'button',
                          className: 'ghh-btn',
                          onClick: async () => {
                            const ok = await copyText(device.userCode)
                            setNotice({ tone: ok ? 'ok' : 'error', text: ok ? (lang === 'zh' ? '代码已复制' : 'code copied') : (lang === 'zh' ? '复制失败，请手动选中' : 'copy failed — select it manually') })
                          },
                          children: lang === 'zh' ? '复制' : 'copy',
                        }),
                      ] }),
                      jsxs('div', { className: 'ghh-actions', children: [
                        jsx('a', { className: 'ghh-link', href: device.verificationUri, target: '_blank', rel: 'noreferrer noopener', children: lang === 'zh' ? '打开 GitHub 授权页 →' : 'open GitHub →' }),
                        jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: cancelDevice, disabled: busy, children: lang === 'zh' ? '取消' : 'cancel' }),
                      ] }),
                      jsx('div', { className: 'ghh-step', children: lang === 'zh' ? `授权后本卡片会自动完成登录（每 ${device.interval ?? 5} 秒检查一次，代码 15 分钟内有效）。` : `This card finishes on its own once you approve (checks every ${device.interval ?? 5}s; the code lives 15 minutes).` }),
                    ] })
                  : jsxs('div', { className: 'ghh-steps', children: [
                      jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '点下面的按钮，GitHub 会给出一串一次性代码。' : 'Get a one-time code from GitHub.' }),
                      jsx('div', { className: 'ghh-actions', children: jsx('button', {
                        type: 'button',
                        className: 'ghh-btn is-primary',
                        onClick: startDevice,
                        disabled: busy || deviceBusy,
                        children: deviceBusy ? (lang === 'zh' ? '获取中…' : 'starting…') : lang === 'zh' ? '开始设备码登录' : 'start device sign-in',
                      }) }),
                      jsx('div', { className: 'ghh-step', children: lang === 'zh' ? `默认使用公开的 GitHub CLI OAuth 应用（client id ${snapshot?.settings?.clientId ?? ''}），申请范围 ${snapshot?.settings?.scopes ?? ''}；也可在设置里换成你自己的 OAuth 应用。` : `Uses the public GitHub CLI OAuth app by default (client id ${snapshot?.settings?.clientId ?? ''}) with scopes ${snapshot?.settings?.scopes ?? ''}; supply your own OAuth app in settings if you prefer.` }),
                    ] }),
              ] })
            : jsxs('div', { className: 'ghh-steps', children: [
                jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '推荐细粒度 token，只勾选你愿意开放的内容（仓库读取即可）。' : 'A fine-grained token with read-only repository access is enough.' }),
                jsx('a', { className: 'ghh-link', href: 'https://github.com/settings/tokens?type=beta', target: '_blank', rel: 'noreferrer noopener', children: lang === 'zh' ? '打开 GitHub Token 设置 →' : 'open GitHub token settings →' }),
                jsx('input', {
                  className: 'ghh-input is-mono',
                  type: 'password',
                  value: draft,
                  placeholder: 'github_pat_… / ghp_…',
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') saveToken()
                  },
                }),
                jsxs('div', { className: 'ghh-actions', children: [
                  jsx('button', { type: 'button', className: 'ghh-btn is-primary', onClick: saveToken, disabled: busy || draft.trim() === '', children: busy ? (lang === 'zh' ? '保存中…' : 'saving…') : lang === 'zh' ? '保存并验证' : 'save and verify' }),
                  jsx('button', {
                    type: 'button',
                    className: 'ghh-btn is-quiet',
                    onClick: async () => {
                      try {
                        const text = await navigator.clipboard.readText()
                        if (text) setDraft(text.trim())
                      } catch {
                        setNotice({ tone: 'error', text: lang === 'zh' ? '剪贴板读取被拒，请手动粘贴' : 'clipboard blocked — paste manually' })
                      }
                    },
                    children: lang === 'zh' ? '读取剪贴板' : 'from clipboard',
                  }),
                ] }),
              ] }),

          
          !tokenPresent && snapshot ? jsx('div', { className: 'ghh-step', children: lang === 'zh' ? `凭据保存在 ${snapshot.settings?.tokenRef ?? 'GITHUB_TOKEN'}，只存在宿主侧，浏览器拿不到。` : `Stored as ${snapshot.settings?.tokenRef ?? 'GITHUB_TOKEN'} on the host only; the browser never sees it.` }) : null,
        ] })
      }

      function renderPicker() {
        const query = pickerQuery.trim().toLowerCase()
        const rows = pickerRepos.filter((repo) => query === '' || repo.fullName.toLowerCase().includes(query))
        return jsxs('div', { className: 'ghh-panel ghh-fade', children: [
          jsxs('div', { className: 'ghh-panelhead', children: [
            jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '关注仓库' : 'Watched repositories' }),
            jsxs('span', { className: 'ghh-right', children: [
              jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => loadRepos(true), disabled: busy, children: lang === 'zh' ? '重新读取' : 'reload' }),
              jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => setPanel(null), children: lang === 'zh' ? '收起' : 'close' }),
            ] }),
          ] }),
          jsx('input', {
            className: 'ghh-input',
            value: pickerQuery,
            placeholder: lang === 'zh' ? '筛选仓库…' : 'filter repositories…',
            onChange: (event) => setPickerQuery(event.target.value),
          }),
          rows.length === 0
            ? jsx(Note, { children: busy ? (lang === 'zh' ? '正在读取你的仓库…' : 'loading your repositories…') : lang === 'zh' ? '没有匹配的仓库。本插件只列出你自己拥有的仓库。' : 'No match. Only repositories you own are listed.' })
            : jsx('div', { className: 'ghh-repolist', children: rows.map((repo) =>
                jsxs('div', { className: 'ghh-repoitem', children: [
                  jsxs('span', { className: 'ghh-main', children: [
                    jsx('span', { className: 'ghh-reponame', title: repo.fullName, children: repo.fullName }),
                    repo.description ? jsx('span', { className: 'ghh-repodesc', title: repo.description, children: repo.description }) : null,
                  ] }),
                  repo.private ? jsx('span', { className: 'ghh-lock', children: lang === 'zh' ? '私有' : 'private' }) : null,
                  num(repo.stars) ? jsx('span', { className: 'ghh-repodesc', children: `★${repo.stars}` }) : null,
                  repo.watched
                    ? jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => watch(repo.fullName, 'remove'), disabled: busy, children: lang === 'zh' ? '取消关注' : 'unwatch' })
                    : jsx('button', { type: 'button', className: 'ghh-btn', onClick: () => watch(repo.fullName, 'add'), disabled: busy, children: lang === 'zh' ? '关注' : 'watch' }),
                ] }, repo.fullName),
              ) }),
          
        ] })
      }

      function renderSettings() {
        const field = (label, key, extra) =>
          jsxs(React.Fragment, { children: [
            jsx('label', { children: label }),
            jsx('input', {
              className: `ghh-input${extra?.mono ? ' is-mono' : ''}`,
              type: extra?.type ?? 'text',
              value: form[key] ?? '',
              onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.value })),
            }),
          ] }, key)
        return jsxs('div', { className: 'ghh-panel ghh-fade', children: [
          jsxs('div', { className: 'ghh-panelhead', children: [
            jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '设置' : 'Settings' }),
            jsx('span', { className: 'ghh-right', children: jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => setPanel(null), children: lang === 'zh' ? '收起' : 'close' }) }),
          ] }),
          jsxs('div', { className: 'ghh-grid', children: [
            field(lang === 'zh' ? '轮询间隔 (ms)' : 'poll (ms)', 'pollMs'),
            field(lang === 'zh' ? '轮播间隔 (ms)' : 'carousel (ms)', 'carouselMs'),
            field(lang === 'zh' ? '每仓库条数' : 'rows per repo', 'perRepoLimit'),
            field(lang === 'zh' ? '代理' : 'proxy', 'proxy', { mono: true }),
            field(lang === 'zh' ? 'OAuth client id' : 'OAuth client id', 'clientId', { mono: true }),
            field(lang === 'zh' ? '授权范围' : 'scopes', 'scopes', { mono: true }),
          ] }),
          jsxs('div', { className: 'ghh-steps', children: [
            jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '代理填 auto 会自动探测（环境变量 → 直连 → 本地 7890/7897/10809 等端口）；填 off 强制直连。' : 'proxy "auto" probes (env → direct → local 7890/7897/10809 …); "off" forces a direct connection.' }),
          ] }),
          jsxs('div', { className: 'ghh-actions', children: [
            jsx('button', { type: 'button', className: 'ghh-btn is-primary', onClick: saveSettings, disabled: busy, children: busy ? (lang === 'zh' ? '保存中…' : 'saving…') : lang === 'zh' ? '保存' : 'save' }),
            jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => setPanel(null), children: lang === 'zh' ? '取消' : 'cancel' }),
          ] }),
          
        ] })
      }
    }

    // ── fragment entry point ───────────────────────────────────────────────
    // The HUD shell owns the dock cell, the grid and the layout editor, so this
    // panel contributes its identity and its component — nothing else.
    // `span: 1` is only this panel's PREFERENCE: one track is what an activity
    // feed reads well in, and the user's own layout choice (⚙) overrides it.
    return {
      id: 'github',
      // AFTER the database card (30), because the packer is first-fit in ORDER: that is
      // what puts this card in the middle column's lower cell, under the quota card,
      // rather than in the third cell of the first row. Order is the whole geometry.
      order: 40,
      span: 1,
      label: { zh: 'GitHub', en: 'GitHub' },
      // ON by default now: it takes the middle column's lower cell, under the quota card,
      // where the machine card used to sit. The machine card is still registered and one
      // click away in ⚙ — this is a LAYOUT decision, not a deletion.
      defaultOn: true,
      // ONE row, and it is the ARRANGEMENT's number rather than the card's: the middle column is
      // 用量限额 (3) + 快递 (1) + GitHub (1), and that sum has to equal the 5 the two full-height
      // cards claim or the middle column ends a row early and leaves a hole.
      //
      // One row is honest for the EMPTY state, which is what this card shows most of the time. A
      // busy afternoon scrolls — inside the body, which already had its own scrollbar and its own
      // max-height — rather than making every day taller for everyone.
      defaultRows: 1,
      Component: GithubHud,
      __test: { Hud: GithubHud, kinds: KINDS },
    }
}