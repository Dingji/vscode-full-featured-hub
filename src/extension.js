// @ts-check
/**
 * dsh-hud — VS Code extension entry.
 *
 * The HUD is a DSH plugin whose host half is a small framework: one plugin row
 * mounts a card, and the card hosts panels, each with its own same-origin
 * routes and its own polling. Mounting that in VS Code is therefore mostly a
 * matter of supplying the three services the framework asks for — and nothing
 * else in `hud/` is touched:
 *
 *   DSH                                   VS Code
 *   ───────────────────────────────────   ──────────────────────────────────
 *   conversation.input.dock slot          a webview view in the bottom panel
 *   ctx.webServer.register(path, …)       the in-process route table
 *   ctx.credentials                       CredentialStore over
 *                                         $DSH_HOME/.credentials.yaml
 *   panels.<id> settings                  the `hud.panels` setting
 *   $DSH_HOME/storages/<domain>/          the same files, unchanged
 *   same-origin fetch                     postMessage RPC
 *
 * The browser half is shipped verbatim too: `media/runtime.js` gives the
 * vendor's own `hud/client.js` the module loader, the React runtime, the fetch
 * bridge and the API shims it expects, so all 631 KB of it — the column grid,
 * the layout editor, every panel's component — runs unmodified.
 *
 * Secrets stay in the extension host: a panel resolves a REF through the
 * credential store, and the card never receives a value.
 */

'use strict'

const vscode = require('vscode')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { CredentialStore } = require('./credentials')
const connectionList = require('./connection-list')
const { createHudContext } = require('./ctx')
const { createDshProfile } = require('./dsh-profile')
const { PLATFORMS, byKind, selectedKinds, subscriptionFor, credentialRefs, hiddenRefs } = require('./quota-catalog')
const sqlConnections = require('./sql-connections')
const sshHosts = require('./ssh-hosts')
const { SshSessions } = require('./ssh')
const { normalizeSettings, unusablePanelSlices, DEFAULTS } = require('./settings')
const { buildDocument, makeNonce } = require('./webview')
const { MAX_BODY_BYTES } = require('./router')

const VIEW_ID = 'hud.card'
const SECTION = 'hud'
/** Layout preferences the card keeps in `localStorage` live here instead. */
const STORAGE_PREFIX = 'hud.storage.'
/** Same bounds the host half's own route validation uses. */
const REF_RE = /^[A-Za-z0-9_]{1,64}$/
const MAX_VALUE_BYTES = 16 * 1024
/** How long the credential-row cache survives before the file is re-read. */
const CREDENTIAL_CACHE_MS = 1_000
/** The status bar's own cadence; the card polls on its own schedule. */
const STATUS_POLL_MS = 60_000

/** Credential refs the shipped panels ask for (see tools/list-credential-refs.mjs). */
const KNOWN_REFS = [
  'OPENCODE_GO_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_USER_TOKEN',
  'QWEN_CONSOLE_COOKIE',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'COMMANDCODE_API_KEY',
  'GITHUB_TOKEN',
  'DSH_HUD_TODO_MAIL',
  'DSH_HUD_TODO_OAUTH',
  'DSH_HUD_TODO_TOKEN',
]

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const output = vscode.window.createOutputChannel('HUD')
  const log = (message, ...rest) => {
    try {
      const tail = rest.map((r) => (r instanceof Error ? (r.stack ?? r.message) : JSON.stringify(r))).join(' ')
      output.appendLine(`${message}${tail ? ` ${tail}` : ''}`)
    } catch {
      /* logging must never throw */
    }
  }
  const trace = (...args) => {
    try {
      console.log('[hud]', ...args)
    } catch {
      /* console unavailable */
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────
  /**
   * Read every modeled setting.
   *
   * Driven off `DEFAULTS` rather than a hand-written list of keys: the list
   * version silently dropped `hud.dshProfile` and `hud.language` — both
   * declared, documented and unreachable — and nothing failed, because a
   * setting that is never read just behaves like its default.
   */
  const readSettings = () => {
    const section = vscode.workspace.getConfiguration(SECTION)
    /** @type {Record<string, unknown>} */
    const raw = {}
    for (const key of Object.keys(DEFAULTS)) raw[key] = section.get(key)
    return normalizeSettings(raw)
  }
  let settings = readSettings()

  /**
   * The credential store follows `hud.credentialsFile`, so a settings change
   * rebuilds it. It is the `ctx.credentials` service for the panels.
   */
  const makeStore = () => new CredentialStore({
    credentialsFile: settings.credentialsFile,
    secretStorage: context.secrets,
    cacheMs: CREDENTIAL_CACHE_MS,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    target: settings.credentialStore,
  })
  let store = makeStore()

  /**
   * The config object handed to `hud.apply()`. The framework re-reads
   * `config.panels[id]` on every poll (never cached), so panels pick up a
   * settings edit within one refresh when this object is MUTATED — which is
   * why it is one long-lived object rather than a fresh one per change.
   */
  const liveConfig = { panels: settings.panels }

  /**
   * The DSH loader, as far as this host can honestly stand in for it.
   *
   * The quota card discovers the platforms it can show through
   * `ctx.loader.entries()` — it reads the live `llm-pi-ai` plugin's `providers`
   * table out of it — so an empty loader means a user with keys for three
   * platforms sees one, and the card's own platform picker (a row of dots,
   * rendered only when more than one row was discovered) never appears. With no
   * DSH runtime to ask, that table is read from the profile's own patch layer.
   */
  const makeProfile = () => createDshProfile({ dshHome: store.dshHome, name: settings.dshProfile, log })
  let profile = makeProfile()

  /**
   * The platforms the user chose, and the credentials that therefore must not
   * be visible.
   *
   * Read live from the settings on every call, so the panels pick up a change
   * on their next poll. In `auto` mode nothing is hidden and the loader is
   * left alone, which is DeepSeek Harness' own behaviour.
   */
  const chosenPlatforms = () => {
    if (settings.quotaDiscovery !== 'chosen') return null
    return selectedKinds(panelSlice('quota').subscriptions)
  }
  const hiddenCredentialRefs = () => {
    const chosen = chosenPlatforms()
    if (chosen === null) return new Set()
    // The panel renders one fallback row of its own when it discovers nothing,
    // reading this ref. Hiding it cannot remove that row — it only makes it
    // claim a credential is missing when it is not.
    const fallback = panelSlice('quota').apiKeyEnv || byKind.get('opencode-go').apiKeyEnv
    return hiddenRefs(chosen, fallback)
  }

  /**
   * A stable handle: replacing the reader (a settings edit, a different DSH
   * home) must not need the panels to be re-mounted.
   *
   * In `chosen` mode the profile's provider table contributes nothing: the user
   * has said which platforms to show, and the panel's own discovery is what
   * would otherwise add rows nobody asked for.
   */
  const loader = {
    entries: () => (chosenPlatforms() === null ? profile.entries() : []),
  }

  const ctx = createHudContext({ credentials: store, log, loader, hidden: hiddenCredentialRefs })
  /** The framework's inspection handle: `{ panels(), panel(id) }`. */
  let handles = null
  let mountError = null

  const mounted = (async () => {
    try {
      // The host half is ESM (`hud/package.json` sets `type: module`), and
      // `hud/index.js` awaits schemastery resolution at module scope, so it is
      // imported rather than required. Nothing in this extension edits it.
      const hud = await import(pathToFileURL(join(__dirname, '..', 'hud', 'index.js')).href)
      handles = hud.apply(ctx, liveConfig)
      const panels = handles.panels()
      log(`HUD ${readHudVersion()} mounted ${panels.length} panel(s): ${panels.join(', ') || '(none)'}`)
      trace('panels mounted', panels)
      return panels
    } catch (error) {
      mountError = error instanceof Error ? error : new Error(String(error))
      log('mounting the HUD failed', mountError)
      return []
    }
  })()

  // ── the card's storage (the shell's `localStorage`) ───────────────────────
  const readStorageSeed = () => {
    /** @type {Record<string, string>} */
    const seed = {}
    for (const key of context.globalState.keys()) {
      if (!key.startsWith(STORAGE_PREFIX)) continue
      const value = context.globalState.get(key)
      if (typeof value === 'string') seed[key.slice(STORAGE_PREFIX.length)] = value
    }
    return seed
  }
  const clearStorage = async () => {
    for (const key of context.globalState.keys()) {
      if (key.startsWith(STORAGE_PREFIX)) await context.globalState.update(key, undefined)
    }
  }

  // ── the webview ──────────────────────────────────────────────────────────
  let provider = null

  /**
   * The card's own view of its geometry, reported by `media/runtime.js`.
   * A webview is not inspectable from the extension host, so when the layout is
   * wrong this is the only way to see what the card measured — and "the panel
   * does not fill" is otherwise unanswerable from a screenshot.
   */
  const layout = { report: null }

  /** Re-register the view so a `retainContext` change takes effect. */
  let registration = null
  const registerView = () => {
    registration?.dispose()
    provider = new HudViewProvider(context, {
      ctx,
      readSettings: () => settings,
      readStorageSeed,
      log,
      trace,
      mounted,
      layout,
      language,
      /**
       * The SSH bits the view needs, handed over as a bundle rather than reached
       * for: `handle()` is a method on the provider, which lives outside this
       * closure and cannot see `store`, `readSshHosts` or the helpers built here.
       * Passing them is also what keeps the storage path in ONE place — a second
       * `store.dshHome` read inside the provider would be a second answer to
       * "where do hosts live" the day the home moves.
       */
      ssh: {
        readHosts: () => readSshHosts(),
        secrets: sshSecrets,
        writeHosts: (hosts, active) => sshHosts.write(store.dshHome, { hosts, active }),
      },
    })
    registration = vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: settings.retainContext },
    })
    return registration
  }
  context.subscriptions.push({ dispose: () => registration?.dispose() })
  registerView()

  // ── status bar (opt-in) ──────────────────────────────────────────────────
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.command = 'hud.show'
  context.subscriptions.push(statusItem)

  /** Ask the quota panel's own route for the worst window, and paint it. */
  const paintStatus = async () => {
    if (!settings.statusBar) {
      statusItem.hide()
      return
    }
    try {
      await mounted
      const res = await ctx.table.dispatch({ path: '/dsh-hud/quota/usage', method: 'GET' })
      const payload = res.status === 200 ? JSON.parse(res.body) : null
      const rows = Array.isArray(payload?.subscriptions) ? payload.subscriptions : []
      const figures = []
      for (const row of rows) for (const w of row.windows ?? []) if (typeof w.percent === 'number') figures.push({ row, pct: w.percent })
      if (figures.length === 0) {
        const withBalance = rows.find((r) => (r.balances ?? []).length > 0)
        const first = withBalance?.balances?.[0]
        statusItem.text = first ? `$(pulse) ${first.value}${first.currency ? ` ${first.currency}` : ''}` : '$(pulse) —'
        statusItem.tooltip = first ? `${withBalance.label} · ${first.key}` : 'HUD — no quota data yet'
        statusItem.show()
        return
      }
      const worst = figures.reduce((a, b) => (b.pct > a.pct ? b : a))
      statusItem.text = `${worst.pct >= 80 ? '$(flame)' : worst.pct >= 60 ? '$(warning)' : '$(pulse)'} ${Math.round(worst.pct)}%`
      statusItem.tooltip = rows
        .map((r) => `${r.label}${r.error ? ` (${r.error})` : ''}: ${(r.windows ?? []).map((w) => `${w.key} ${Math.round(w.percent)}%`).join(' · ') || '—'}`)
        .join('\n')
      statusItem.show()
    } catch (error) {
      log('status bar refresh failed', error)
    }
  }

  let statusTimer = null
  const armStatus = () => {
    if (statusTimer !== null) clearInterval(statusTimer)
    statusTimer = null
    if (!settings.statusBar) {
      statusItem.hide()
      return
    }
    paintStatus()
    statusTimer = setInterval(paintStatus, STATUS_POLL_MS)
    if (typeof statusTimer.unref === 'function') statusTimer.unref()
  }
  context.subscriptions.push({ dispose: () => { if (statusTimer !== null) clearInterval(statusTimer) } })
  armStatus()

  // ── what the commands share ──────────────────────────────────────────────
  /**
   * The language the CARD renders in — `'zh'` or `'en'`.
   *
   * The shell decides with `pickLocale()`, which reads
   * `document.documentElement.lang`. In DSH the locale plugin sets that, so the
   * profile's `locale.preference` is the faithful source and the one that makes
   * the card agree with the same panels running in DSH.
   *
   * `vscode.env.language` is only the fallback: it describes the editor's
   * display language, which is often English on a machine whose owner reads
   * Chinese — and a HUD is not the editor chrome.
   * @returns {'zh' | 'en'}
   */
  function language() {
    if (settings.language === 'zh' || settings.language === 'en') return settings.language
    const preference = profile.locale()
    if (preference !== null) return /^zh/i.test(preference) ? 'zh' : 'en'
    return /^zh/i.test(String(vscode.env.language ?? '')) ? 'zh' : 'en'
  }

  /** Where the resolved language came from, for the diagnostics command. */
  function languageSource() {
    if (settings.language !== 'auto') return 'hud.language'
    if (profile.locale() !== null) return 'DSH locale preference'
    return 'vscode.env.language'
  }

  /**
   * The SSH host list, from the panel's own storage convention.
   *
   * Read through `store.dshHome` rather than a captured path: the credentials file
   * setting can move the whole home while the extension is running, and the hosts
   * must follow it — a list that stayed behind would look like it had been wiped.
   */
  function readSshHosts() {
    return sshHosts.read(store.dshHome)
  }

  /**
   * Everything one host needs to authenticate, resolved in ONE place.
   *
   * Both the card's connect and the palette's "test connection" go through this,
   * because the two failing differently is the classic way a test button lies: the
   * test would find the stored password and the card would not, or the other way
   * round, and the error would name the wrong cause.
   *
   * What the user just typed wins over what is stored — it is the only value that
   * is certainly current.
   *
   * @param {Record<string, any>} host
   * @param {string} [typed] a password typed for this connection
   */
  async function sshSecrets(host, typed) {
    let password = typeof typed === 'string' && typed !== '' ? typed : undefined
    if (password === undefined && host.auth !== 'key') {
      const ref = typeof host.passwordRef === 'string' ? host.passwordRef : sshHosts.passwordRefFor(host.id)
      password = (await ctx.credentials.resolve(ref))?.value
      if (password === undefined) {
        throw new Error(`「${host.name ?? host.id}」没有可用密码：在卡片里输入一次，或先跑 “HUD: Set Credential…” 存下 ${ref}`)
      }
    }

    let privateKey
    if (host.auth === 'key') {
      if (typeof host.keyFile !== 'string' || host.keyFile === '') {
        throw new Error(`「${host.name ?? host.id}」用密钥登录，但没有填私钥文件`)
      }
      try {
        privateKey = readFileSync(host.keyFile, 'utf8')
      } catch (error) {
        throw new Error(`读不了私钥 ${host.keyFile}：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const passphraseRef = typeof host.passphraseRef === 'string' ? host.passphraseRef : sshHosts.passphraseRefFor(host.id)
    const passphrase = (await ctx.credentials.resolve(passphraseRef))?.value
    return { password, privateKey, passphrase }
  }

  /**
   * Connect once and hang up, for the palette's "test connection".
   *
   * A real authentication rather than a TCP check: a port that answers says nothing
   * about whether the password is right, and a test that passes on a wrong password
   * is worse than no test.
   */
  async function testHost(host) {
    const manager = new SshSessions({ push: () => {}, log })
    try {
      const secrets = await sshSecrets(host)
      const result = await manager.open(host, {
        ...secrets,
        cols: 80,
        rows: 24,
        strictHostKey: settings.sshStrictHostKey === true,
      })
      manager.close(host.id)
      return { ok: true, fingerprint: result.fingerprint }
    } catch (error) {
      manager.closeAll()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Ask for one secret and save it.
   * @param {string} ref
   * @param {{ zh?: string, en?: string } | undefined} [why] what it is for
   * @returns {Promise<boolean>} whether something was written
   */
  async function promptCredentialValue(ref, why) {
    const value = await vscode.window.showInputBox({
      title: `HUD — ${ref}`,
      prompt: why?.zh ? `${why.zh} · 粘贴 Cookie / token / key` : '粘贴 Cookie / token / key',
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim().length === 0 ? '不能为空' : text.length > MAX_VALUE_BYTES ? '内容过长' : undefined),
    })
    if (value === undefined) return false
    try {
      const how = await store.write(ref, value.trim())
      void vscode.window.showInformationMessage(`HUD: ${ref} 已保存到 ${how}`)
      provider?.reload()
      return true
    } catch (error) {
      void vscode.window.showErrorMessage(`HUD: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** The `hud.panels` slice for one panel, as an object we may edit. */
  function panelSlice(panelId) {
    const panels = vscode.workspace.getConfiguration(SECTION).get('panels')
    if (panels === null || typeof panels !== 'object' || Array.isArray(panels)) return {}
    const slice = panels[panelId]
    return slice !== null && typeof slice === 'object' && !Array.isArray(slice) ? slice : {}
  }

  /**
   * The scope `hud.panels` already lives in. Writing to Global while a workspace
   * value exists would appear to do nothing at all.
   */
  function configTarget() {
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect('panels')
    return inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
  }

  /** Write one extension setting at the scope the panel config uses. */
  async function updateSetting(key, value) {
    await vscode.workspace.getConfiguration(SECTION).update(key, value, configTarget())
  }

  /**
   * Write `hud.panels` back with ONE panel's slice changed.
   *
   * `hud.panels` carries every panel's settings, so a command that rewrote the
   * whole object would quietly erase the others.
   * @param {string} panelId
   * @param {(slice: Record<string, any>) => Record<string, any>} mutate
   */
  async function updatePanelSlice(panelId, mutate) {
    const configuration = vscode.workspace.getConfiguration(SECTION)
    const panels = configuration.get('panels')
    const current = panels !== null && typeof panels === 'object' && !Array.isArray(panels) ? panels : {}
    await configuration.update('panels', { ...current, [panelId]: mutate(panelSlice(panelId)) }, configTarget())
  }

  // ── commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('hud.show', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
    }),

    vscode.commands.registerCommand('hud.reload', () => {
      // A fresh document re-runs `apply()` and re-mounts every panel, which is
      // what a host-side change (a new route, an edited panel) needs.
      provider?.reload()
    }),

    vscode.commands.registerCommand('hud.setCredential', async () => {
      const items = []
      for (const ref of KNOWN_REFS) {
        // eslint-disable-next-line no-await-in-loop
        const described = await store.describe(ref)
        items.push({ label: ref, description: described.configured ? `已配置（${described.source}）` : '未配置', ref })
      }
      for (const ref of store.refs()) {
        if (!KNOWN_REFS.includes(ref)) items.push({ label: ref, description: '已配置（file）', ref })
      }
      items.push({ label: '$(edit) 其它引用名…', description: '手动输入一个 credential 引用名', ref: '' })
      const picked = await vscode.window.showQuickPick(items, { title: 'HUD — 选择要配置的凭据', placeHolder: '引用名' })
      if (!picked) return
      let ref = picked.ref
      if (!ref) {
        const typed = await vscode.window.showInputBox({
          title: 'HUD — 凭据引用名',
          prompt: '例如 MY_QUOTA_KEY（必须匹配 ^[A-Za-z_][A-Za-z0-9_]*$，否则 DSH 下次启动会拒绝整个凭据文件）',
          ignoreFocusOut: true,
          validateInput: (text) => (REF_RE.test(text.trim()) ? undefined : '引用名不合法'),
        })
        if (typed === undefined) return
        ref = typed.trim()
      }
      await promptCredentialValue(ref)
    }),

    /**
     * The quota card renders one row per subscription it discovers, and its
     * platform picker appears only when more than one was found. Discovery
     * needs a `subscriptions` list for anything that is neither in the DSH
     * profile nor built in — this is the chooser for that list, so nobody has
     * to hand-write the JSON.
     */
    vscode.commands.registerCommand('hud.quotaPlatforms', async () => {
      const selected = selectedKinds(panelSlice('quota').subscriptions)
      const items = await Promise.all(PLATFORMS.map(async (platform) => {
        const required = platform.credentials.filter((credential) => credential.optional !== true)
        const resolved = await Promise.all(required.map((credential) => store.resolve(credential.ref)))
        const missing = required.filter((_, index) => resolved[index] === undefined)
        const zeroSetup = platform.credentials.every((credential) => credential.optional === true)
        return {
          label: platform.label.zh,
          description: missing.length > 0
            ? `需要 ${missing.map((credential) => credential.ref).join(' / ')}`
            : zeroSetup ? '已可出数（读本机 CLI 登录态）' : '已可出数',
          detail: `${platform.shows.zh}\n\n${platform.detail.zh}`,
          picked: selected.includes(platform.kind),
          platform,
        }
      }))
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'HUD — 用量卡片轮播哪些平台',
        placeHolder: '勾选要加入的平台（可以逐个看清接口与凭据要求）',
        matchOnDetail: true,
      })
      if (picked === undefined) return

      const chosen = PLATFORMS.filter((platform) => picked.some((item) => item.platform.kind === platform.kind))
      await updatePanelSlice('quota', (slice) => {
        const next = { ...slice }
        // An empty array is not the same as absent: it is a deliberate "show
        // none of my own", where absent means "do not gate me at all".
        next.subscriptions = chosen.map(subscriptionFor)
        return next
      })
      // Choosing is what turns the gate on, so what was ticked is what shows.
      await updateSetting('quotaDiscovery', 'chosen')

      void vscode.window.showInformationMessage(
        chosen.length === 0
          ? 'HUD: 用量卡片已改为「只显示我选的平台」，当前一个都没选。面板至少会保留它自己的兜底行（opencode-go）。想恢复自动发现就跑 HUD: Reset Quota Platforms。'
          : `HUD: 用量卡片现在只显示 ${chosen.length} 个平台：${chosen.map((platform) => platform.label.zh).join('、')}`,
      )

      // Offer whatever the choice still needs, rather than leaving rows that
      // can only say "configure me".
      const missing = []
      for (const credential of credentialRefs(chosen)) {
        if (credential.optional) continue
        // eslint-disable-next-line no-await-in-loop
        if (await store.resolve(credential.ref) === undefined) missing.push(credential)
      }
      if (missing.length === 0) return
      const answer = await vscode.window.showInformationMessage(
        `HUD: 还缺 ${missing.length} 个凭据：${missing.map((credential) => credential.ref).join('、')}`,
        '现在配置', '稍后',
      )
      if (answer !== '现在配置') return
      for (const credential of missing) {
        // eslint-disable-next-line no-await-in-loop
        await promptCredentialValue(credential.ref, credential.why)
      }
    }),

    vscode.commands.registerCommand('hud.quotaReset', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'HUD: 用量卡片恢复成 DeepSeek Harness 的自动发现？（清空手工平台列表，并让 DSH profile 的 provider 与内置发现重新参与；已保存的凭据不受影响）',
        { modal: true },
        '恢复自动发现',
      )
      if (confirmed !== '恢复自动发现') return
      await updatePanelSlice('quota', (slice) => {
        const next = { ...slice }
        delete next.subscriptions
        return next
      })
      await updateSetting('quotaDiscovery', 'auto')
      void vscode.window.showInformationMessage('HUD: 用量平台已恢复自动发现。')
    }),

    /**
     * The SQL panel's connection list, from the command palette.
     *
     * The card has all of this already — `＋ 连接` tests before it saves, and the ⚙
     * lists connections with a delete button beside each. What it does not have is
     * a place people look first, and a gear labelled "settings" is where a
     * connection list goes to be missed. Every step here goes through the panel's
     * OWN routes, so validation and storage stay exactly one implementation.
     */
    vscode.commands.registerCommand('hud.sqlConnections', async () => {
      await mounted
      const call = async (path, body) => {
        const answer = await ctx.table.dispatch({
          path,
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        let parsed
        try {
          parsed = JSON.parse(answer.body)
        } catch {
          throw new Error(`HUD: ${path} 返回了非 JSON（${answer.status}）`)
        }
        if (answer.status >= 400 || parsed.ok === false) throw new Error(parsed.error ?? `HTTP ${answer.status}`)
        return parsed
      }

      try {
        const state = await call('/dsh-hud/sql/state')
        const drivers = (state.drivers ?? []).filter((driver) => driver.available === true)
        if (drivers.length === 0) {
          void vscode.window.showErrorMessage('HUD: 没有可用的数据库驱动')
          return
        }
        const settings = (await call('/dsh-hud/sql/settings')).settings ?? { connections: [], active: '' }
        const connections = Array.isArray(settings.connections) ? settings.connections : []
        const active = typeof settings.active === 'string' ? settings.active : ''

        const save = async (next, nextActive, note) => {
          await call('/dsh-hud/sql/settings', { settings: { ...settings, connections: next, active: nextActive } })
          provider?.reload()
          void vscode.window.showInformationMessage(note)
        }

        /** Ask for one driver's fields, plus the name, the password and read-only. */
        const collect = async (spec, entry) => {
          const next = { ...entry }
          const name = await vscode.window.showInputBox({
            title: `HUD — ${spec.labelZh ?? spec.id}：名称`,
            value: String(next.name ?? next.id ?? ''),
            prompt: '卡片里显示的名字',
            ignoreFocusOut: true,
          })
          if (name === undefined) return undefined
          next.name = name.trim() === '' ? String(next.id) : name.trim()
          next.driver = spec.id

          for (const field of spec.fields ?? []) {
            const current = sqlConnections.currentValue(spec, next, field.key)
            if (field.kind === 'toggle') {
              const picked = await vscode.window.showQuickPick(
                [{ label: '是', value: true }, { label: '否', value: false }],
                { title: `HUD — ${next.name}：${field.label ?? field.key}`, ignoreFocusOut: true },
              )
              if (picked === undefined) return undefined
              next[field.key] = picked.value
              continue
            }
            const typed = await vscode.window.showInputBox({
              title: `HUD — ${next.name}：${field.label ?? field.key}`,
              value: current === undefined ? '' : String(current),
              placeHolder: field.placeholder ?? '',
              ignoreFocusOut: true,
              validateInput: (text) => {
                const result = sqlConnections.coerceField(field, text, { numbers: true })
                return result.error
              },
            })
            if (typed === undefined) return undefined
            const coerced = sqlConnections.coerceField(field, typed, { numbers: true })
            if (coerced.error !== undefined) return undefined
            if (coerced.value === undefined) delete next[field.key]
            else next[field.key] = coerced.value
          }

          const readOnlyPick = await vscode.window.showQuickPick(
            [
              { label: '只读', description: '插件拒绝发送写语句', value: true },
              { label: '可写', description: '发送前仍要在卡片里再确认一次', value: false },
            ],
            { title: `HUD — ${next.name}：只读？`, ignoreFocusOut: true },
          )
          if (readOnlyPick === undefined) return undefined
          next.readOnly = readOnlyPick.value

          if (sqlConnections.needsPassword(next)) {
            const useStored = next.passwordRef !== undefined
            const ask = useStored
              ? await vscode.window.showQuickPick(
                [{ label: '用已保存的凭据', value: false }, { label: '现在输入新密码', value: true }],
                { title: `HUD — ${next.name}：密码`, ignoreFocusOut: true },
              )
              : { value: true }
            if (ask === undefined) return undefined
            if (ask.value) {
              const secret = await vscode.window.showInputBox({
                title: `HUD — ${next.name}：密码`,
                prompt: '只用于这次连接测试；连接里只留引用名',
                password: true,
                ignoreFocusOut: true,
              })
              if (secret === undefined) return undefined
              next.passwordRef = next.passwordRef ?? sqlConnections.credentialRefFor(next.id)
              return { entry: next, password: secret }
            }
          }
          return { entry: next, password: undefined }
        }

        const items = [
          { label: '$(add) 新建连接…', description: '选择驱动并逐项填写', action: 'new' },
          ...connections.map((entry) => ({
            label: String(entry.name ?? entry.id),
            description: `${sqlConnections.describe(entry)}${entry.id === active ? '   · 当前' : ''}`,
            detail: `driver ${entry.driver}${entry.user === undefined ? '' : `   user ${entry.user}`}`,
            action: 'pick',
            entry,
          })),
        ]
        const chosen = await vscode.window.showQuickPick(items, {
          title: 'HUD — 数据库连接',
          placeHolder: connections.length === 0 ? '还没有连接，先新建一个' : '选择要管理的连接',
          ignoreFocusOut: true,
        })
        if (chosen === undefined) return

        if (chosen.action === 'new') {
          // The card refuses past this too. Adding a 13th here would produce a
          // connection the card cannot show — and the card is where it has to be
          // edited afterwards.
          if (connections.length >= sqlConnections.MAX_CONNECTIONS) {
            void vscode.window.showErrorMessage(
              `HUD: 最多 ${sqlConnections.MAX_CONNECTIONS} 个连接 —— 先删掉一个再新建`,
            )
            return
          }
          const spec = await vscode.window.showQuickPick(
            drivers.map((driver) => ({
              label: driver.labelZh ?? driver.label ?? driver.id,
              description: driver.defaultPort === 0 ? '本地文件' : `默认端口 ${driver.defaultPort}`,
              spec: driver,
            })),
            { title: 'HUD — 新建连接：选择驱动', ignoreFocusOut: true },
          )
          if (spec === undefined) return
          const draft = await collect(spec.spec, sqlConnections.blank(spec.spec, connections))
          if (draft === undefined) return

          // TEST BEFORE SAVING, the rule the card follows: a connection written
          // first and found broken afterwards is a settings file nobody can trust.
          let tested = false
          try {
            const result = await call('/dsh-hud/sql/test', { connection: draft.entry, password: draft.password })
            tested = true
            void vscode.window.showInformationMessage(`HUD: 连接成功（${result.ms ?? '?'} ms，${result.info?.serverVersion ?? result.driver ?? ''}）`)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            const anyway = await vscode.window.showWarningMessage(`HUD: 连接测试失败 — ${reason}`, { modal: true }, '仍然保存', '取消')
            if (anyway !== '仍然保存') return
          }

          if (draft.password !== undefined && draft.entry.passwordRef !== undefined) {
            await store.write(draft.entry.passwordRef, draft.password)
          }
          const next = sqlConnections.replaceById([...connections, draft.entry], draft.entry.id, draft.entry)
          await save(next, draft.entry.id, `HUD: 已${tested ? '连接并' : ''}保存「${draft.entry.name}」`)
          return
        }

        const spec = drivers.find((driver) => driver.id === chosen.entry.driver)
        const action = await vscode.window.showQuickPick(
          [
            { label: '$(edit) 编辑字段…', action: 'edit', description: '主机 / 端口 / 库 / 用户 / 只读' },
            { label: '$(check) 设为当前连接', action: 'activate', description: chosen.entry.id === active ? '已经是当前' : '卡片切到这一条' },
            { label: '$(trash) 删除', action: 'delete', description: '只删这一条连接，凭据不动' },
          ],
          { title: `HUD — ${chosen.entry.name}`, ignoreFocusOut: true },
        )
        if (action === undefined) return

        if (action.action === 'activate') {
          await save(connections, chosen.entry.id, `HUD: 当前连接改为「${chosen.entry.name}」`)
          return
        }
        if (action.action === 'delete') {
          const confirmed = await vscode.window.showWarningMessage(
            `HUD: 删除连接「${chosen.entry.name}」？（已保存的凭据不会被删掉）`,
            { modal: true },
            '删除',
          )
          if (confirmed !== '删除') return
          const result = sqlConnections.removeById(connections, chosen.entry.id, active)
          await save(result.connections, result.active, `HUD: 已删除「${chosen.entry.name}」`)
          return
        }

        if (spec === undefined) {
          // A connection whose driver is not in the list cannot be edited field by
          // field — the field list IS the driver. Say so instead of opening an
          // empty form.
          void vscode.window.showErrorMessage(`HUD: 驱动 ${chosen.entry.driver} 现在不可用，无法编辑这一条`)
          return
        }
        const draft = await collect(spec, { ...chosen.entry, id: chosen.entry.id })
        if (draft === undefined) return
        try {
          await call('/dsh-hud/sql/test', { connection: draft.entry, password: draft.password })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          const anyway = await vscode.window.showWarningMessage(`HUD: 连接测试失败 — ${reason}`, { modal: true }, '仍然保存', '取消')
          if (anyway !== '仍然保存') return
        }
        if (draft.password !== undefined && draft.entry.passwordRef !== undefined) {
          await store.write(draft.entry.passwordRef, draft.password)
        }
        await save(
          sqlConnections.replaceById(connections, chosen.entry.id, draft.entry),
          active === '' ? chosen.entry.id : active,
          `HUD: 已保存「${draft.entry.name}」`,
        )
      } catch (error) {
        void vscode.window.showErrorMessage(`HUD: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),

    /**
     * Which card the rightmost slot is: the database, or an SSH terminal.
     *
     * The two are one slot rather than two cards, so this is a REPLACEMENT and the
     * setting is what enforces it — the card that is not chosen is not registered at
     * all, rather than hidden behind a preference the user could un-hide and end up
     * with both.
     */
    vscode.commands.registerCommand('hud.rightCard', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '数据库', description: 'SQL 卡片：连接、库表树、语句编辑器', value: 'database' },
          { label: 'SSH 终端', description: '同一个位置换成交互式终端（真 PTY）', value: 'ssh' },
        ],
        { title: `HUD — 最右侧的卡片（现在是 ${settings.rightCard === 'ssh' ? 'SSH 终端' : '数据库'}）`, ignoreFocusOut: true },
      )
      if (picked === undefined) return
      if (picked.value === settings.rightCard) {
        void vscode.window.showInformationMessage(`HUD: 已经是${picked.label}了`)
        return
      }
      await updateSetting('rightCard', picked.value)
      // A new document, not a reload: the panel is registered while it is built.
      registerView()
      void vscode.window.showInformationMessage(`HUD: 右侧卡片已切换为${picked.label}`)
    }),

    /**
     * The SSH hosts, from the command palette — the same shape as the SQL
     * connection manager, because they are the same kind of thing.
     */
    vscode.commands.registerCommand('hud.sshHosts', async () => {
      const load = () => readSshHosts()
      const save = (hosts, active, note) => {
        sshHosts.write(store.dshHome, { hosts, active })
        provider?.reload()
        if (note !== undefined) void vscode.window.showInformationMessage(note)
      }

      /** Ask for every field of one host. Returns undefined when cancelled. */
      const collect = async (draft, existing) => {
        const ask = async (title, value, placeHolder, validateInput) => {
          const typed = await vscode.window.showInputBox({
            title: `HUD — ${title}`, value: value ?? '', placeHolder, ignoreFocusOut: true, validateInput,
          })
          return typed === undefined ? null : typed.trim()
        }

        const name = await ask('主机名称', existing?.name ?? draft.name, '留空就用 user@host')
        if (name === null) return undefined
        const host = await ask('主机名 / IP', existing?.host ?? '', 'example.com', (v) => (v.trim() === '' ? '不能为空' : undefined))
        if (host === null) return undefined
        const port = await ask('端口', String(existing?.port ?? sshHosts.DEFAULT_PORT), '22', (v) => {
          const n = Number(v)
          return Number.isInteger(n) && n >= 1 && n <= 65_535 ? undefined : '需要 1..65535 之间的整数'
        })
        if (port === null) return undefined
        const user = await ask('用户名', existing?.user ?? '', 'root', (v) => (v.trim() === '' ? '不能为空' : undefined))
        if (user === null) return undefined
        const auth = await vscode.window.showQuickPick(
          [
            { label: '密码', description: '存在 DSH 凭据库里，主机条目只留引用名', value: 'password' },
            { label: '私钥文件', description: '用一个本地私钥文件（口令也从凭据库取）', value: 'key' },
          ],
          { title: 'HUD — 认证方式', ignoreFocusOut: true },
        )
        if (auth === undefined) return undefined

        /** @type {Record<string, any>} */
        const next = { ...existing, name, host, port, user, auth: auth.value }
        if (auth.value === 'key') {
          const keyFile = await ask('私钥文件路径', existing?.keyFile ?? '', 'C:/Users/me/.ssh/id_ed25519')
          if (keyFile === null) return undefined
          next.keyFile = keyFile
        } else {
          delete next.keyFile
          const password = await ask('密码（可留空，稍后再存）', '', '直接回车跳过')
          if (password === null) return undefined
          if (password !== '') {
            const ref = next.passwordRef ?? sshHosts.passwordRefFor(next.id ?? 'new')
            await store.write(ref, password)
            next.passwordRef = ref
          }
        }
        const normalized = sshHosts.normalize(next, { keepId: existing?.id })
        return normalized
      }

      try {
        const { hosts, active } = load()
        const chosen = await vscode.window.showQuickPick(
          [
            { label: '$(add) 新建主机…', description: '主机名、端口、用户、密码或密钥', action: 'new' },
            ...hosts.map((host) => ({
              label: String(host.name ?? host.id),
              description: `${sshHosts.describe(host)}${host.id === active ? '   · 默认' : ''}`,
              detail: host.note,
              action: 'pick',
              host,
            })),
          ],
          {
            title: 'HUD — SSH 主机',
            placeHolder: hosts.length === 0 ? '还没有主机，先新建一个' : '选择要管理的主机',
            ignoreFocusOut: true,
          },
        )
        if (chosen === undefined) return

        if (chosen.action === 'new') {
          const draft = sshHosts.blank(hosts)
          const entry = await collect(draft, undefined)
          if (entry === undefined) return
          const withId = { ...entry, id: draft.id }
          // A REAL connection test, not a ping: the only way to know a password and
          // a key are right is to authenticate with them.
          const open = await vscode.window.showQuickPick(
            [{ label: '先测试连接', value: true }, { label: '直接保存', value: false }],
            { title: `HUD — ${withId.name}`, ignoreFocusOut: true },
          )
          if (open === undefined) return
          if (open.value) {
            const tested = await testHost(withId)
            if (!tested.ok) {
              const anyway = await vscode.window.showWarningMessage(`HUD: 连接失败 — ${tested.error}`, { modal: true }, '仍然保存', '取消')
              if (anyway !== '仍然保存') return
            }
          }
          save([...hosts, withId], active === '' ? withId.id : active, `HUD: 已保存主机「${withId.name}」`)
          return
        }

        const action = await vscode.window.showQuickPick(
          [
            { label: '$(edit) 编辑…', action: 'edit', description: '主机名 / 端口 / 用户 / 认证' },
            { label: '$(plug) 测试连接', action: 'test', description: '真的连一次，然后断开' },
            { label: '$(check) 设为默认', action: 'activate', description: chosen.host.id === active ? '已经是默认' : '卡片打开时用这一台' },
            { label: '$(trash) 删除', action: 'delete', description: '只删这一条，凭据不动' },
          ],
          { title: `HUD — ${chosen.host.name}`, ignoreFocusOut: true },
        )
        if (action === undefined) return

        if (action.action === 'activate') {
          save(hosts, chosen.host.id, `HUD: 默认主机改为「${chosen.host.name}」`)
          return
        }
        if (action.action === 'test') {
          const tested = await testHost(chosen.host)
          if (tested.ok) void vscode.window.showInformationMessage(`HUD: 「${chosen.host.name}」连上了${tested.fingerprint ? ` — ${tested.fingerprint}` : ''}`)
          else void vscode.window.showErrorMessage(`HUD: 「${chosen.host.name}」连接失败 — ${tested.error}`)
          return
        }
        if (action.action === 'delete') {
          const confirmed = await vscode.window.showWarningMessage(
            `HUD: 删除主机「${chosen.host.name}」？（已保存的密码/口令不会被删掉）`,
            { modal: true },
            '删除',
          )
          if (confirmed !== '删除') return
          const result = connectionList.removeById(hosts, chosen.host.id, active)
          save(result.connections, result.active, `HUD: 已删除「${chosen.host.name}」`)
          return
        }

        const edited = await collect({ ...chosen.host }, chosen.host)
        if (edited === undefined) return
        const next = { ...edited, id: chosen.host.id }
        save(connectionList.replaceById(hosts, chosen.host.id, next), active === '' ? next.id : active, `HUD: 已保存「${next.name}」`)
      } catch (error) {
        void vscode.window.showErrorMessage(`HUD: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),

    vscode.commands.registerCommand('hud.openCredentialsFile', async () => {
      const file = store.file
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, 'version: 1\nrefs:\n', 'utf8')
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
      await vscode.window.showTextDocument(doc, { preview: false })
    }),

    vscode.commands.registerCommand('hud.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.panels`)
    }),

    vscode.commands.registerCommand('hud.resetLayout', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'HUD: 把卡片排列、尺寸、折叠与显隐恢复成默认值？（面板自己的设置与存储不受影响）',
        { modal: true },
        '恢复默认',
      )
      if (confirmed !== '恢复默认') return
      await clearStorage()
      provider?.reload()
    }),

    vscode.commands.registerCommand('hud.diagnostics', async () => {
      output.clear()
      output.appendLine(`HUD extension ${context.extension.packageJSON.version} · hud package ${readHudVersion()}`)
      output.appendLine(`credentials file : ${store.file}`)
      output.appendLine(`credential store : ${settings.credentialStore}`)
      output.appendLine(`retainContext    : ${settings.retainContext}    notifications: ${settings.notifications}`)
      const unusable = unusablePanelSlices(vscode.workspace.getConfiguration(SECTION).get('panels'))
      if (unusable.length > 0) output.appendLine(`⚠ hud.panels: ${unusable.join(', ')} 不是对象，已被忽略`)
      output.appendLine(`hud.panels keys  : ${Object.keys(settings.panels).join(', ') || '(none)'}`)
      // Which DSH profile the loader table came from, and how much it carried:
      // this is where the quota card's platform rows come from.
      const dsh = profile.describe()
      output.appendLine(
        `dsh profile      : ${dsh.profile ?? '(none found)'}${settings.dshProfile === '' ? ' (auto)' : ' (hud.dshProfile)'}`
        + `${dsh.source === null ? '' : `  ← ${dsh.source}`}`,
      )
      output.appendLine(`  loader entries : ${dsh.entries}${dsh.error === null ? '' : `   ⚠ ${dsh.error}`}`)
      output.appendLine(`card language    : ${language()}   ← ${languageSource()}${settings.language === 'auto' ? '' : ' (pinned)'}`)
      if (mountError) output.appendLine(`⚠ mounting failed: ${mountError.message}`)
      const panels = await mounted
      output.appendLine(`panels mounted   : ${panels.join(', ') || '(none)'}`)
      const routes = ctx.table.paths()
      output.appendLine(`routes registered: ${routes.length}`)
      for (const route of routes) output.appendLine(`  ${route}`)
      output.appendLine(`layout storage   : ${Object.keys(readStorageSeed()).length} key(s) in globalState`)

      // What the CARD sees. Everything above describes the host; this is the
      // only window onto the webview's own geometry, and it is the difference
      // between "the layout is wrong" and a number to fix.
      output.appendLine('')
      if (layout.report === null) {
        output.appendLine('card layout      : no report yet — open the HUD panel (or resize it), then run this again')
      } else {
        const r = layout.report
        output.appendLine('card layout      — measured by the webview itself')
        output.appendLine(`  panel viewport : ${r.viewport?.width}×${r.viewport?.height}`)
        output.appendLine(`  theme sheets   : ${r.theme?.sheets} in the document, fill rules present: ${r.theme?.fillRules}`)
        output.appendLine(`  :has() support : ${r.theme?.hasSelector}`)
        output.appendLine(`  height mode    : ${r.mode ?? '(no handle rendered)'}`)
        output.appendLine(`  .hud-root      : box ${r.root?.height}px, css height ${r.root?.cssHeight}, display ${r.root?.display}`)
        output.appendLine(`  .hud-card      : box ${r.card?.height}px, flex ${r.card?.flex}`)
        output.appendLine(`  .hud-body      : box ${r.body?.height}px, max-height ${r.body?.maxHeight}`)
        output.appendLine(`                   grid-auto-rows ${r.body?.gridAutoRows}, ${r.body?.rows} card(s)`)
        output.appendLine(`  UNUSED BELOW   : ${r.wastedBelow}px   ← 0 means the card reaches the bottom`)
        output.appendLine(`  reported at    : ${r.reportedAt}`)
      }
      output.show(true)
    }),
  )

  // ── settings changes ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SECTION)) return
      const next = readSettings()
      const fileChanged = next.credentialsFile !== settings.credentialsFile
        || next.credentialStore !== settings.credentialStore
      const retainChanged = next.retainContext !== settings.retainContext
      // The language is baked into the document, so it needs a re-resolve —
      // `reload()` only re-runs the script the document already has.
      const languageChanged = next.language !== settings.language
      // Same reason: which card occupies the right slot is decided while the
      // document is built, by whether the SSH panel gets registered.
      const rightCardChanged = next.rightCard !== settings.rightCard
      settings = next
      // Mutated in place: the framework reads `config.panels[id]` per poll.
      liveConfig.panels = settings.panels
      if (fileChanged) {
        store = makeStore()
        ctx.credentials = makeCredentialService(store, log, hiddenCredentialRefs)
      }
      // The profile table is read live, so a change lands on the next poll.
      if (fileChanged || next.dshProfile !== profile.name) profile = makeProfile()
      if (retainChanged || languageChanged || rightCardChanged) registerView()
      armStatus()
      log('settings applied')
    }),
  )

  /**
   * 今日涨跌榜 comes from the PANEL, not from here.
   *
   * This port used to register its own `/dsh-hud/market/rank`, and the upstream then
   * grew one with the same path — so the second registration was refused as a
   * duplicate, and because a panel registers all of its routes inside one effect,
   * that refusal took the ENTIRE market card down with it.
   *
   * The upstream's version is the one to keep: the same 20 rows, plus the 新股/退市
   * filter, the session state and the hover chart, all inside the card that owns
   * them. A route path is a shared namespace; two independent implementations of
   * "the same feature" collide there long before anyone notices they overlap.
   */

  log(`activated; credentials → ${store.file}`)
}

/**
 * The `ctx.credentials` service, rebuilt when the store is replaced.
 * Kept as a factory so `ctx.credentials` can be swapped without re-mounting
 * the panels (which only ever call through the object).
 *
 * `hidden` is how the quota card's platform list is enforced. The panel
 * discovers some rows by itself — the built-in DeepSeek source appears whenever
 * `DEEPSEEK_API_KEY` resolves, and no configuration field removes a discovered
 * row — so a credential belonging to a platform the user did not choose is
 * simply not visible. Read live, so a settings change lands on the next poll.
 *
 * @param {import('./credentials').CredentialStore} store
 * @param {(message: string, ...rest: unknown[]) => void} log
 * @param {() => Set<string>} [hidden]
 */
function makeCredentialService(store, log, hidden = () => new Set()) {
  const suppressed = (ref) => {
    try {
      return hidden().has(ref)
    } catch {
      return false
    }
  }
  return {
    async resolve(ref) {
      if (suppressed(ref)) return undefined
      try {
        const hit = await store.resolve(ref)
        return hit === undefined ? undefined : { value: hit.value, source: hit.source }
      } catch (error) {
        log(`credentials.resolve(${ref}) failed`, error)
        throw error
      }
    },
    async present(ref) {
      if (suppressed(ref)) return false
      try {
        return Boolean(await store.resolve(ref))
      } catch {
        return false
      }
    },
    write: (ref, value) => store.write(ref, value),
    remove: (ref) => store.remove(ref),
  }
}

/** The HUD package's own version — the number the panels report. */
function readHudVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'hud', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * The card's host: one webview view, a request/response channel over
 * `postMessage` (the stand-in for same-origin HTTP), and a push channel for
 * the reload command.
 */
class HudViewProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{ ctx: any, readSettings: () => any, readStorageSeed: () => Record<string, string>, log: Function, trace: Function, mounted: Promise<string[]> }} deps
   */
  constructor(context, deps) {
    this.context = context
    this.deps = deps
    /** @type {Set<{ push: (message: any) => void }>} */
    this.clients = new Set()
  }

  /** Re-render the card in every open view. */
  reload() {
    for (const client of this.clients) client.push({ type: 'reload' })
  }

  /**
   * @param {vscode.WebviewView} view
   */
  resolveWebviewView(view) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    const hudRoot = vscode.Uri.joinPath(this.context.extensionUri, 'hud')
    view.webview.options = {
      enableScripts: true,
      // The card's own bundle is served from `hud/`, everything else from
      // `media/`; nothing outside those two may be loaded.
      localResourceRoots: [mediaRoot, hudRoot],
    }
    view.webview.html = this.html(view.webview)

    const push = (message) => { view.webview.postMessage(message).then(undefined, () => {}) }
    const client = {
      push,
      /**
       * SSH sessions belong to the VIEW that opened them.
       *
       * `hud.retainContext` defaults to false, so switching away from the HUD panel
       * destroys this webview — and a session that outlived it would leave a login
       * open on somebody's server with nothing on screen to close it. So each view
       * gets its own manager, and disposing the view closes what it opened.
       *
       * The events carry no `id`: nothing is waiting for them, exactly like the
       * `layout` report in the other direction.
       */
      ssh: new SshSessions({ push: (event, payload) => push({ event, payload }), log: this.deps.log }),
    }
    this.clients.add(client)
    view.onDidDispose(() => {
      // Close before forgetting: an orphaned shell is a login left open on a
      // server, and the next view would open a second one to the same host.
      client.ssh.closeAll()
      this.clients.delete(client)
    })

    view.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') return
      // An unsolicited report: no id, so it expects no reply. It carries the
      // card's own measurements, which only the webview can take.
      if (message.id === undefined && message.method === 'layout') {
        this.deps.layout.report = message.params ?? null
        return
      }
      if (typeof message.id !== 'number') return
      try {
        client.push({ id: message.id, ok: true, data: await this.handle(message, client) })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        this.deps.log(`rpc ${String(message.method)} failed: ${text}`)
        client.push({ id: message.id, ok: false, error: text })
      }
    })
  }

  /**
   * One RPC call. `route` is the whole same-origin surface the panels use;
   * the rest are host capabilities a webview does not have on its own.
   *
   * `client` is the calling VIEW: SSH sessions are owned by it, so the methods that
   * touch a session need to know which one asked.
   * @param {{ method: string, params?: any }} message
   * @param {{ ssh: any }} [client]
   */
  async handle(message, client) {
    const { ctx, log } = this.deps
    switch (message.method) {
      case 'route': {
        // Panels can only be reached once the host half has mounted.
        await this.deps.mounted
        const params = message.params ?? {}
        // The bound belongs here rather than in the route table: this is the
        // trust boundary, and it mirrors `MAX_BODY_BYTES` in the host kit — the
        // same 64 KB a panel's own `readBody` enforces on the way in.
        const body = typeof params.body === 'string' ? params.body : ''
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          return {
            status: 413,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: false, error: 'request-body-too-large' }),
          }
        }
        return await ctx.table.dispatch(params)
      }

      case 'storage.set': {
        const key = message.params?.key
        if (typeof key !== 'string' || key === '') throw new Error('bad-storage-key')
        const value = message.params?.value
        await this.context.globalState.update(
          `${STORAGE_PREFIX}${key}`,
          value === null || value === undefined ? undefined : String(value),
        )
        return { ok: true }
      }

      case 'clipboard.write':
        await vscode.env.clipboard.writeText(String(message.params?.text ?? ''))
        return { ok: true }

      case 'clipboard.read':
        return { text: await vscode.env.clipboard.readText() }

      case 'openExternal': {
        const raw = String(message.params?.url ?? '')
        const uri = vscode.Uri.parse(raw)
        if (uri.scheme !== 'https' && uri.scheme !== 'http') throw new Error('refused: not an http(s) URL')
        await vscode.env.openExternal(uri)
        return { ok: true }
      }

      case 'notify': {
        // The to-do panel's reminders. A webview can never hold the browser
        // Notification permission, so the host answers instead.
        if (this.deps.readSettings().notifications !== false) {
          const title = String(message.params?.title ?? 'HUD')
          const body = String(message.params?.body ?? '')
          void vscode.window.showInformationMessage(body ? `${title} — ${body}` : title)
        }
        return { ok: true }
      }

      // ── SSH: the terminal the rightmost card can be instead of the database ──
      case 'ssh.state': {
        const { hosts, active, file, missing } = this.deps.ssh.readHosts()
        return {
          ...client.ssh.state(hosts),
          active,
          file,
          missing: missing === true,
          strictHostKey: this.deps.readSettings().sshStrictHostKey === true,
        }
      }

      case 'ssh.hosts.save': {
        const params = message.params ?? {}
        const raw = Array.isArray(params.hosts) ? params.hosts : []
        // Normalized on the way IN, so a bad port or a missing user is refused with
        // a sentence rather than stored and discovered at connect time.
        const hosts = raw.map((entry) => sshHosts.normalize(entry, { keepId: entry?.id }))
        const active = typeof params.active === 'string' ? params.active : ''
        this.deps.ssh.writeHosts(hosts, active)
        return { ok: true, hosts, active }
      }

      case 'ssh.open': {
        const params = message.params ?? {}
        const { hosts } = this.deps.ssh.readHosts()
        const host = hosts.find((entry) => String(entry.id) === String(params.id))
        if (host === undefined) throw new Error(`没有这个主机：${String(params.id)}`)
        const settings = this.deps.readSettings()
        const secrets = await this.deps.ssh.secrets(host, params.password)

        const result = await client.ssh.open(host, {
          ...secrets,
          cols: params.cols,
          rows: params.rows,
          strictHostKey: settings.sshStrictHostKey === true,
        })

        // Remember the key we were shown, the first time only — that is what makes
        // `hud.sshStrictHostKey` meaningful on the second connection.
        if (typeof result.fingerprint === 'string' && result.fingerprint !== '' && host.fingerprint !== result.fingerprint) {
          const next = hosts.map((entry) => (entry.id === host.id ? { ...entry, fingerprint: result.fingerprint } : entry))
          this.deps.ssh.writeHosts(next, host.id)
        }
        if (typeof params.password === 'string' && params.password !== '' && params.remember === true) {
          await store.write(typeof host.passwordRef === 'string' ? host.passwordRef : sshHosts.passwordRefFor(host.id), params.password)
        }
        return result
      }

      case 'ssh.write':
        return { ok: client.ssh.write(message.params?.id, message.params?.data) }

      case 'ssh.resize':
        return { ok: client.ssh.resize(message.params?.id, Number(message.params?.cols), Number(message.params?.rows)) }

      case 'ssh.close':
        return { ok: client.ssh.close(message.params?.id) }

      default:
        log(`unknown rpc method: ${String(message.method)}`)
        throw new Error(`unknown method: ${String(message.method)}`)
    }
  }

  /**
   * The card document. See `src/webview.js` — the script order is load-bearing.
   * @param {vscode.Webview} webview
   */
  html(webview) {
    const nonce = makeNonce()
    const read = (relative) => {
      try {
        return readFileSync(vscode.Uri.joinPath(this.context.extensionUri, relative).fsPath, 'utf8')
      } catch (error) {
        this.deps.log(`missing ${relative}`, error)
        return `/* ${relative} could not be read */`
      }
    }
    const uri = (relative) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, relative)).toString()
    const settings = this.deps.readSettings()

    return buildDocument({
      nonce,
      cspSource: webview.cspSource,
      // `this.deps.language()` speaks the card's vocabulary ('zh' | 'en'); the
      // document gets a real BCP-47 tag, which is what `pickLocale()` reads and
      // what a screen reader or a font fallback would use.
      lang: this.deps.language() === 'zh' ? 'zh-CN' : 'en',
      styleText: read('media/theme.css'),
      scriptUris: [
        uri('media/react.js'),
        // Both define a global the runtime reads at boot (`__hudXterm`,
        // `__hudSshCard`) and neither depends on the other, so they go before the
        // runtime rather than being fetched on demand — a card that had to fetch its
        // own terminal would show an empty box until the fetch landed.
        uri('media/xterm.js'),
        uri('media/ssh-card.js'),
        uri('media/runtime.js'),
        uri('hud/client.js'),
      ],
      hostPayload: {
        // The synchronous storage seed: the shell reads the arrangement while
        // it mounts, before any RPC could come back.
        storage: this.deps.readStorageSeed(),
        notifications: settings.notifications,
        nonce,
        version: this.context.extension.packageJSON.version,
        /**
         * Which card the rightmost slot is.
         *
         * Baked into the document rather than fetched, because the card has to be
         * registered (or not) BEFORE the shell renders the grid: a card that
         * appeared one poll later would flash the database card first, and one that
         * disappeared would leave a hole. Changing it therefore re-creates the
         * document — the same rule `hud.language` follows.
         */
        rightCard: settings.rightCard,
      },
    })
  }
}

function deactivate() { /* every listener is a disposable on the context */ }

module.exports = { activate, deactivate, HudViewProvider, makeCredentialService, readHudVersion }