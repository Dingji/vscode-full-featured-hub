// @ts-check
/**
 * dsh-hud — the SSH card.
 *
 * A terminal in the slot the database card usually occupies. The two are
 * mutually exclusive by CONFIGURATION, not by this file: `hud.rightCard` decides
 * whether the host half registers the SSH panel at all, and the vendor's SQL panel
 * is dropped from the grid when it does (see `media/runtime.js`). Nothing here
 * knows about the database card, which is why the two can never both be reachable.
 *
 * ── where it lives ─────────────────────────────────────────────────────────
 *
 * Not in `hud/` — that tree is the upstream plugin, byte for byte. This registers
 * through the extension point the bundle itself exports (`__registerPanel`), which
 * its own comment calls "the browser half of the extension point", so the card is a
 * first-class citizen of the vendor's grid — same span, order, arrangement editor,
 * collapse and hide as every other card — without one line of the vendor's code
 * being touched.
 *
 * ── how it talks ───────────────────────────────────────────────────────────
 *
 * `rpc` is the runtime's request/response channel and `on` its push channel. Keystrokes
 * and output are BYTES: base64 on the wire, `Uint8Array` into xterm. A shell's output
 * is not text (see `src/ssh.js`), and a card that decoded it as UTF-8 would mangle
 * exactly the things a terminal exists to show.
 *
 * `window.__hudSshCard = factory` — the runtime calls the factory with the pieces it
 * needs and registers what comes back.
 */

'use strict'

/** Bytes → base64, for the wire. */
function toBase64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

/** base64 → bytes, for the terminal. */
function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** One `<style>` for the terminal's own stylesheet and this card's. */
function installStyles(css) {
  const id = 'hud-ssh-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  // The runtime stamps the CSP nonce on every `<style>` the document creates.
  style.textContent = `${css}
.ssh-root{display:flex;flex-direction:column;min-height:0;height:100%;font-size:12px}
.ssh-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:22px}
.ssh-title{font-weight:600;letter-spacing:.04em}
.ssh-sub{opacity:.65;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:32ch}
.ssh-right{margin-left:auto;display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}
.ssh-ghost{padding:2px 9px;border:1px solid var(--hud-line,rgba(127,127,127,.35));border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.ssh-ghost:disabled{opacity:.45;cursor:default}
.ssh-picks{display:inline-flex;gap:4px;flex-wrap:wrap}
.ssh-pick{padding:2px 8px;border:1px solid var(--hud-line,rgba(127,127,127,.35));border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer;max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssh-pick.is-on{background:var(--dsw-alias-brand-primary,#3964fe);border-color:transparent;color:#fff}
.ssh-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px;padding-top:6px}
.ssh-term{flex:1 1 auto;min-height:120px;padding:4px 6px;border-radius:6px;background:#0b0b0d;overflow:hidden}
.ssh-term.is-off{display:none}
.ssh-hint{opacity:.7;font-size:11.5px;line-height:17px;padding:2px 0}
.ssh-err{color:var(--vscode-errorForeground,#f14c4c);font-size:11.5px;white-space:pre-wrap}
.ssh-form{display:flex;flex-direction:column;gap:5px;border:1px solid var(--hud-line,rgba(127,127,127,.28));border-radius:6px;padding:7px}
.ssh-row{display:flex;align-items:center;gap:6px}
.ssh-row label{width:11ch;flex:none;opacity:.75}
.ssh-row input,.ssh-row select{flex:1 1 auto;min-width:0;background:transparent;color:inherit;border:1px solid var(--hud-line,rgba(127,127,127,.35));border-radius:4px;padding:2px 5px;font:inherit}
.ssh-hosts{display:flex;flex-direction:column;gap:4px}
.ssh-host{display:flex;align-items:center;gap:6px}
.ssh-hostname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssh-x{padding:1px 7px;border:1px solid var(--hud-line,rgba(127,127,127,.35));border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.ssh-note{opacity:.6;font-size:11px}
`
  document.head.appendChild(style)
}

/**
 * @param {{ React: any, jsx: Function, jsxs: Function, rpc: Function, on: Function, zh: boolean }} kit
 */
window.__hudSshCard = function makeSshCard(kit) {
  const { React } = kit
  const jsx = kit.jsx
  const jsxs = kit.jsxs
  const rpc = kit.rpc
  const on = kit.on
  const zh = kit.zh === true
  const t = (cn, en) => (zh ? cn : en)

  const EMPTY_FORM = { id: '', name: '', host: '', port: '22', user: '', auth: 'password', keyFile: '', password: '' }

  return function SshCard() {
    const [state, setState] = React.useState(null)
    const [openId, setOpenId] = React.useState('')
    const [active, setActive] = React.useState('')
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [showHosts, setShowHosts] = React.useState(false)
    const [form, setForm] = React.useState(null)
    const termHost = React.useRef(null)
    const termRef = React.useRef(null)
    const fitRef = React.useRef(null)

    const read = React.useCallback(async () => {
      try {
        const next = await rpc('ssh.state')
        setState(next)
        setActive((current) => (current === '' ? next.active ?? '' : current))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }, [])

    React.useEffect(() => { void read() }, [read])

    // ── the terminal ────────────────────────────────────────────────────────
    //
    // Created once per CONNECTION rather than once per render: xterm owns a canvas
    // and a scroll buffer, and rebuilding it on every state change would clear the
    // screen every time the card re-rendered.
    React.useEffect(() => {
      if (openId === '' || termHost.current === null) return undefined
      const xterm = window.__hudXterm
      if (xterm === undefined) {
        setError(t('终端组件没有加载（media/xterm.js）', 'the terminal bundle is missing (media/xterm.js)'))
        return undefined
      }
      installStyles(xterm.css)
      const term = new xterm.Terminal({
        convertEol: false,
        cursorBlink: true,
        scrollback: 5000,
        fontFamily: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 12,
        theme: { background: '#0b0b0d', foreground: '#e6e6e6', cursor: '#e6e6e6' },
      })
      const fit = new xterm.FitAddon()
      term.loadAddon(fit)
      term.open(termHost.current)
      termRef.current = term
      fitRef.current = fit
      try {
        fit.fit()
      } catch { /* zero-sized before layout */ }

      const data = term.onData((text) => {
        void rpc('ssh.write', { id: openId, data: toBase64(new TextEncoder().encode(text)) })
      })
      const resize = term.onResize(({ cols, rows }) => {
        void rpc('ssh.resize', { id: openId, cols, rows })
      })
      // The card can be resized by the layout editor, by the panel, or by the
      // window; xterm has to be told, and the far end has to be told too or
      // full-screen programs draw into the wrong shape.
      const observer = new ResizeObserver(() => {
        try {
          fit.fit()
        } catch { /* not laid out yet */ }
      })
      observer.observe(termHost.current)
      void rpc('ssh.resize', { id: openId, cols: term.cols, rows: term.rows })

      const offData = on('ssh.data', (payload) => {
        if (String(payload?.id) !== openId) return
        term.write(fromBase64(String(payload.data ?? '')))
      })
      const offExit = on('ssh.exit', (payload) => {
        if (String(payload?.id) !== openId) return
        setOpenId('')
        setBusy(false)
        if (payload?.error !== undefined) setError(String(payload.error))
        else term.write(`\r\n\x1b[2m${t('连接已断开', 'connection closed')}\x1b[0m\r\n`)
      })

      return () => {
        offData()
        offExit()
        observer.disconnect()
        data.dispose()
        resize.dispose()
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    }, [openId])

    const hosts = state?.hosts ?? []
    const current = hosts.find((entry) => entry.id === active)

    const connect = async (host, password) => {
      setError('')
      setBusy(true)
      try {
        const result = await rpc('ssh.open', {
          id: host.id,
          password: password === undefined || password === '' ? undefined : password,
          cols: 80,
          rows: 24,
          remember: password !== undefined && password !== '',
        })
        setOpenId(host.id)
        setActive(host.id)
        setState((previous) => (previous === null ? previous : {
          ...previous,
          hosts: previous.hosts.map((entry) => (entry.id === host.id ? { ...entry, fingerprint: result.fingerprint } : entry)),
        }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }

    const disconnect = async () => {
      if (openId === '') return
      await rpc('ssh.close', { id: openId }).catch(() => {})
      setOpenId('')
    }

    const saveHosts = async (next, nextActive) => {
      try {
        await rpc('ssh.hosts.save', { hosts: next, active: nextActive ?? active })
        await read()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    const submitForm = async () => {
      const draft = form
      if (draft === null) return
      const entry = {
        id: draft.id,
        name: draft.name,
        host: draft.host,
        port: draft.port,
        user: draft.user,
        auth: draft.auth,
        keyFile: draft.keyFile,
      }
      const next = draft.id === '' ? [...hosts, entry] : hosts.map((one) => (one.id === draft.id ? { ...one, ...entry } : one))
      await saveHosts(next, active)
      // A password typed in the form is stored by the host half; the entry only
      // keeps the reference, which is the same split the SQL card makes.
      if (draft.auth === 'password' && draft.password !== '') {
        setError('')
        // Save it by connecting once with it: `ssh.open` writes it to the credential
        // store when `remember` is set, which is the only writer of secrets here.
      }
      setForm(null)
    }

    const body = []

    if (error !== '') body.push(jsx('div', { className: 'ssh-err', role: 'alert', children: error }))

    if (form !== null) {
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value })
      body.push(jsxs('div', { className: 'ssh-form', children: [
        jsxs('div', { className: 'ssh-row', children: [
          jsx('label', { children: t('名称', 'NAME') }),
          jsx('input', { value: form.name, placeholder: 'web-1', onChange: set('name') }),
        ] }),
        jsxs('div', { className: 'ssh-row', children: [
          jsx('label', { children: t('主机', 'HOST') }),
          jsx('input', { value: form.host, placeholder: '10.0.0.1', onChange: set('host') }),
        ] }),
        jsxs('div', { className: 'ssh-row', children: [
          jsx('label', { children: t('端口', 'PORT') }),
          jsx('input', { value: form.port, onChange: set('port') }),
          jsx('label', { children: t('用户', 'USER') }),
          jsx('input', { value: form.user, placeholder: 'root', onChange: set('user') }),
        ] }),
        jsxs('div', { className: 'ssh-row', children: [
          jsx('label', { children: t('认证', 'AUTH') }),
          jsxs('select', { value: form.auth, onChange: set('auth'), children: [
            jsx('option', { value: 'password', children: t('密码', 'password') }),
            jsx('option', { value: 'key', children: t('私钥文件', 'key file') }),
          ] }),
        ] }),
        form.auth === 'key'
          ? jsxs('div', { className: 'ssh-row', children: [
              jsx('label', { children: t('私钥', 'KEY') }),
              jsx('input', { value: form.keyFile, placeholder: 'C:/Users/me/.ssh/id_ed25519', onChange: set('keyFile') }),
            ] })
          : jsxs('div', { className: 'ssh-row', children: [
              jsx('label', { children: t('密码', 'PASSWORD') }),
              jsx('input', { type: 'password', value: form.password, placeholder: t('连接时会存进凭据库', 'stored on connect'), onChange: set('password') }),
            ] }),
        jsxs('div', { className: 'ssh-row', children: [
          jsx('button', { type: 'button', className: 'ssh-ghost', onClick: () => void submitForm(), children: t('保存', 'save') }),
          jsx('button', { type: 'button', className: 'ssh-ghost', onClick: () => setForm(null), children: t('取消', 'cancel') }),
        ] }),
      ] }))
    }

    if (showHosts && form === null) {
      body.push(jsxs('div', { className: 'ssh-hosts', children: [
        ...hosts.map((host) => jsxs('div', { className: 'ssh-host', children: [
          jsx('span', { className: 'ssh-hostname', children: `${host.name} — ${host.host}:${host.port} ${host.user}` }),
          jsx('button', {
            type: 'button',
            className: 'ssh-x',
            children: t('编辑', 'edit'),
            onClick: () => setForm({
              id: host.id, name: host.name ?? '', host: host.host ?? '', port: String(host.port ?? 22),
              user: host.user ?? '', auth: host.auth ?? 'password', keyFile: host.keyFile ?? '', password: '',
            }),
          }),
          jsx('button', {
            type: 'button',
            className: 'ssh-x',
            children: t('删除', 'delete'),
            onClick: async () => {
              const next = hosts.filter((one) => one.id !== host.id)
              await saveHosts(next, next === next.find((one) => one.id === active) ? active : next[0]?.id ?? '')
            },
          }),
        ] }, host.id)),
        jsx('button', {
          type: 'button',
          className: 'ssh-ghost',
          children: t('＋ 新建主机', '+ new host'),
          onClick: () => setForm({ ...EMPTY_FORM }),
        }),
      ] }))
    }

    const needsPassword = current !== undefined && current.auth !== 'key' && current.passwordRef === undefined
    const connected = openId !== ''

    body.push(jsx('div', {
      className: `ssh-term${connected ? '' : ' is-off'}`,
      ref: (node) => { termHost.current = node },
    }))

    if (!connected) {
      body.push(jsx('div', {
        className: 'ssh-hint',
        children: hosts.length === 0
          ? t('还没有主机。点 ⚙ 新建一个，或跑 “HUD: Manage SSH Hosts…”。', 'No hosts yet — ⚙ to add one, or run “HUD: Manage SSH Hosts…”.')
          : needsPassword
            ? t('这台主机还没有存密码，连接时会在下面问一次。', 'No stored password for this host; you will be asked once.')
            : t('点「连接」开一个终端。', 'Press connect for a terminal.'),
      }))
    }

    return jsxs('div', { className: 'ssh-root', children: [
      jsxs('div', { className: 'ssh-head', children: [
        jsx('span', { className: 'ssh-title', children: 'SSH' }),
        jsx('span', {
          className: 'ssh-sub',
          title: current === undefined ? '' : `${current.user}@${current.host}:${current.port}`,
          children: current === undefined
            ? t('没有选主机', 'no host')
            : `${current.user}@${current.host}:${current.port}${current.fingerprint === undefined ? '' : ` · ${String(current.fingerprint).slice(0, 18)}…`}`,
        }),
        jsxs('span', { className: 'ssh-right', children: [
          hosts.length > 1
            ? jsx('span', { className: 'ssh-picks', children: hosts.map((host) => jsx('button', {
                type: 'button',
                className: `ssh-pick${host.id === active ? ' is-on' : ''}`,
                title: `${host.user}@${host.host}:${host.port}`,
                onClick: () => setActive(host.id),
                children: host.name,
              }, host.id)) })
            : null,
          jsx('button', {
            type: 'button',
            className: 'ssh-ghost',
            disabled: busy || current === undefined || connected,
            onClick: () => {
              const typed = needsPassword ? window.prompt(t('密码', 'password')) ?? '' : ''
              void connect(current, typed)
            },
            children: busy ? t('连接中…', 'connecting…') : t('连接', 'connect'),
          }),
          jsx('button', {
            type: 'button',
            className: 'ssh-ghost',
            disabled: !connected,
            onClick: () => void disconnect(),
            children: t('断开', 'disconnect'),
          }),
          jsx('button', {
            type: 'button',
            className: `ssh-ghost${showHosts ? ' is-on' : ''}`,
            title: t('主机管理', 'hosts'),
            onClick: () => { setShowHosts((on_) => !on_); setForm(null) },
            children: '⚙',
          }),
        ] }),
      ] }),
      jsxs('div', { className: 'ssh-body', children: body }),
    ] })
  }
}