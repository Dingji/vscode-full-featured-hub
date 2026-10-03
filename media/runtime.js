// dsh-hud — VS Code webview runtime.
//
// The card itself is the vendor's own `hud/client.js`, byte for byte: a DSH
// module-loader bundle that expects a `window.__ModuleLoader__`, React from a
// platform module table, same-origin `/dsh-hud/...` routes, and a dock slot to
// register one cell into. A VS Code webview offers none of those, so this file
// supplies all four — and nothing else. No panel, no stylesheet and no shell
// code is touched, which is what makes the card identical rather than similar.
//
//   DSH                                   here
//   ───────────────────────────────────   ──────────────────────────────────
//   window.__ModuleLoader__.load(...)      captured, then booted explicitly
//   require('react'|'react/jsx-runtime')   media/react.js, bundled
//   fetch('/dsh-hud/<panel>/<action>')     postMessage → the in-process router
//   ctx.slots.register(slot, Component)    captured; React renders it
//   Notification / clipboard / window.open forwarded to the VS Code host
//   localStorage                           the host's globalState (seeded)
//
// Load order in the document is load-bearing:
//   react.js  →  runtime.js  →  client.js  →  __hudBoot()
// so the loader exists before the bundle calls it, and the bundle exists before
// the boot runs.
;(function () {
  'use strict'

  /** Everything the host injected into the document before this script. */
  const host = window.__hudHost || {}
  const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null

  const debug = (...args) => {
    try {
      console.log('[hud]', ...args)
    } catch {
      /* console unavailable */
    }
  }

  // ── request/response over the webview channel ────────────────────────────
  let sequence = 0
  const pending = new Map()

  /**
   * Named events the host pushes, with no reply expected.
   *
   * A request/response channel cannot carry a stream: `ssh.data` arrives whenever
   * the remote shell says something, not when this side asked. So the host sends
   * `{ event, payload }` with no `id`, and every subscriber gets it.
   * @type {Map<string, Set<Function>>}
   */
  const listeners = new Map()

  /**
   * Subscribe to one host event.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(handler)
    return () => listeners.get(event)?.delete(handler)
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  function rpc(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (!bridge) {
        reject(new Error('宿主通道不可用（host bridge unavailable）'))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`宿主请求超时（${method}）`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      bridge.postMessage({ id, method, params })
    })
  }

  window.addEventListener('message', (event) => {
    const message = event?.data
    if (!message || typeof message !== 'object') return
    if (typeof message.id === 'number') {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.ok === false) waiting.reject(new Error(String(message.error ?? '宿主返回错误')))
      else waiting.resolve(message.data)
      return
    }
    // Host-initiated: the reload command replaces the document.
    if (message.type === 'reload') window.location.reload()
    // Anything else is a named EVENT — no id, because nothing is waiting for it.
    // The SSH card's terminal output arrives this way: it is a stream, not an
    // answer, and a request/response channel cannot carry one.
    if (typeof message.event === 'string') {
      for (const handler of listeners.get(message.event) ?? []) {
        try {
          handler(message.payload)
        } catch (error) {
          debug(`event handler for ${message.event} failed`, error)
        }
      }
    }
  })

  // ── 1. every `<style>` the bundle creates is allowed by the CSP ──────────
  // The card injects eleven stylesheets, each as
  // `document.createElement('style')` + `textContent` + `head.append(...)`. A
  // nonce policy blocks those, so the nonce the host put in the document is
  // stamped onto every style element as it is created. Setting it before the
  // element enters the tree is what the policy checks.
  //
  // This is why the card's CSP does not need `style-src 'unsafe-inline'`.
  function installStyleNonce(nonce) {
    if (!nonce) return
    const create = document.createElement.bind(document)
    document.createElement = function (tag, options) {
      const element = create(tag, options)
      if (String(tag).toLowerCase() === 'style') element.setAttribute('nonce', nonce)
      return element
    }
    // `createElementNS` is not used for styles by this bundle, but a panel
    // added later might; patch it too so the guarantee holds for the whole tree.
    const createNs = document.createElementNS.bind(document)
    document.createElementNS = function (namespace, tag) {
      const element = createNs(namespace, tag)
      if (String(tag).toLowerCase() === 'style') element.setAttribute('nonce', nonce)
      return element
    }
  }

  // ── 2. localStorage, over the host's own store ───────────────────────────
  // The shell keeps the card arrangement in localStorage, and a webview's own
  // storage is tied to the webview's lifetime. Backing it with `globalState`
  // means the layout survives a panel reload, a window reload and an extension
  // update — and the seed is injected into the document, so the synchronous
  // reads the shell does while mounting still see it immediately.
  const storage = (() => {
    const values = new Map(Object.entries(host.storage || {}))
    const write = (key) => {
      const value = values.get(key)
      rpc('storage.set', { key, value: value === undefined ? null : value }).catch((error) => debug('storage write failed', error))
    }
    const api = {
      get length() {
        return values.size
      },
      key(index) {
        return [...values.keys()][index] ?? null
      },
      getItem(key) {
        const value = values.get(String(key))
        return value === undefined ? null : value
      },
      setItem(key, value) {
        values.set(String(key), String(value))
        write(String(key))
      },
      removeItem(key) {
        values.delete(String(key))
        write(String(key))
      },
      clear() {
        for (const key of [...values.keys()]) {
          values.delete(key)
          write(key)
        }
      },
    }
    try {
      Object.defineProperty(window, 'localStorage', { value: api, configurable: true, writable: true })
    } catch (error) {
      debug('could not install the localStorage bridge', error)
    }
    return api
  })()

  // ── 3. Notification → VS Code notifications ──────────────────────────────
  // The to-do panel's reminders use the browser Notification API. A webview
  // cannot grant that permission, so `permission` always reads "granted" while
  // the host decides whether to actually show anything (`hud.notifications`).
  function installNotifications() {
    const HudNotification = function (title, options) {
      this.title = String(title ?? '')
      this.body = String(options?.body ?? '')
      this.tag = options?.tag
      this.onclick = null
      this.onclose = null
      this.onerror = null
      this.close = () => {}
      rpc('notify', { title: this.title, body: this.body }).catch((error) => debug('notification failed', error))
    }
    HudNotification.permission = 'granted'
    HudNotification.requestPermission = () => Promise.resolve('granted')
    try {
      Object.defineProperty(window, 'Notification', { value: HudNotification, configurable: true, writable: true })
    } catch (error) {
      debug('could not install the Notification bridge', error)
    }
  }

  // ── 4. clipboard → the host's clipboard ──────────────────────────────────
  // `navigator.clipboard` exists in a webview but reading is refused, and the
  // card offers both directions (copy a command, paste a Cookie).
  function installClipboard() {
    const api = {
      writeText: (text) => rpc('clipboard.write', { text: String(text ?? '') }, 10_000).then(() => undefined),
      readText: () => rpc('clipboard.read', undefined, 10_000).then((result) => String(result?.text ?? '')),
    }
    try {
      Object.defineProperty(navigator, 'clipboard', { value: api, configurable: true })
    } catch (error) {
      debug('could not install the clipboard bridge', error)
    }
  }

  // ── 5. window.open → the real browser ────────────────────────────────────
  // A webview may not navigate, so a link the card opens goes to the host,
  // which hands it to the OS browser.
  function installOpen() {
    const open = (url) => {
      if (typeof url === 'string' && url !== '') {
        rpc('openExternal', { url }).catch((error) => debug('openExternal failed', error))
      }
      return null
    }
    try {
      window.open = open
    } catch (error) {
      debug('could not install the window.open bridge', error)
    }
  }

  // ── 6. fetch → the in-process route table ────────────────────────────────
  // Every panel request is a same-origin path (`/dsh-hud/<panel>/<action>`);
  // anything absolute is left to the platform.
  function installFetch() {
    const native = typeof window.fetch === 'function' ? window.fetch.bind(window) : null
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '')
      if (!url.startsWith('/')) {
        if (!native) throw new Error(`no fetch for ${url}`)
        return native(input, init)
      }
      const signal = init?.signal
      const request = rpc('route', {
        path: url,
        method: String(init?.method ?? 'GET').toUpperCase(),
        body: init?.body === undefined || init?.body === null ? undefined : String(init.body),
        headers: init?.headers && typeof init.headers === 'object' ? { origin: init.headers.origin } : undefined,
      })
      // The shell bounds every poll with `AbortSignal.timeout(20_000)`; honour
      // it, or a stalled host would hang the poll the signal exists to bound.
      const settled = signal
        ? await Promise.race([
            request,
            new Promise((_resolve, reject) => {
              const fail = () => reject(new Error('aborted'))
              if (signal.aborted) fail()
              else signal.addEventListener('abort', fail, { once: true })
            }),
          ])
        : await request
      return new Response(settled?.body ?? '', {
        status: Number(settled?.status ?? 200),
        headers: settled?.headers && typeof settled.headers === 'object' ? settled.headers : { 'content-type': 'application/json' },
      })
    }
  }

  // ── 7. install every bridge, before the bundle is allowed to run ──────────
  // All of it has to be in place before `client.js` evaluates: the bundle
  // injects its stylesheets and reads the saved arrangement while it
  // materializes, and its factory registers the dock cell synchronously.
  installStyleNonce(host.nonce)
  installNotifications()
  installClipboard()
  installOpen()
  installFetch()

  // ── 8. the module loader ─────────────────────────────────────────────────
  const react = globalThis.__hudReact
  let entry = null

  window.__ModuleLoader__ = {
    load(candidate) {
      entry = candidate
    },
  }

  /** The platform module table the bundle's factory is handed. */
  function requireModule(spec) {
    if (!react) throw new Error('React 运行时未加载（media/react.js missing）')
    if (spec === 'react') return react.React
    if (spec === 'react/jsx-runtime') return react.jsxRuntime
    throw new Error(`bundle required an unknown module: ${spec}`)
  }

  // ── 9. boot: register the dock cell and render it ────────────────────────
  function renderFailure(error) {
    const root = document.getElementById('hud-root') || document.body
    const box = document.createElement('div')
    box.setAttribute('data-hud-error', '')
    box.style.cssText = 'margin:10px;padding:10px 12px;border:1px dashed var(--vscode-input-border,#888);border-radius:8px;'
      + 'font-family:var(--vscode-font-family,sans-serif);font-size:12px;line-height:18px;color:var(--vscode-foreground,#ccc)'
    const title = document.createElement('div')
    title.style.cssText = 'font-weight:600;margin-bottom:4px'
    title.textContent = 'HUD 启动失败'
    const detail = document.createElement('div')
    detail.style.cssText = 'opacity:.8;white-space:pre-wrap;word-break:break-word'
    detail.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    box.append(title, detail)
    root.replaceChildren(box)
  }

  // ── layout report ────────────────────────────────────────────────────────
  /**
   * What the card's boxes actually measure, reported to the host so
   * `HUD: Show Diagnostics` can print it.
   *
   * A webview cannot be inspected from the extension host, and "the layout is
   * wrong" is not something anyone can debug from a screenshot. This turns it
   * into numbers: how tall the panel is, how tall the card is, how much panel
   * is left unused below it, whether the theme stylesheet even reached this
   * document, and whether the selector engine supports what it asks for.
   *
   * @returns {Record<string, any>}
   */
  function measureLayout() {
    const box = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        cssHeight: style.height,
        display: style.display,
        flex: style.flex,
      }
    }
    const body = document.querySelector('.hud-body')
    const card = document.querySelector('.hud-card')
    const sheets = [...document.querySelectorAll('style')]
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      theme: {
        sheets: sheets.length,
        // Did the generated stylesheet reach this document at all?
        fillRules: sheets.some((sheet) => (sheet.textContent || '').includes('.hud-root .hud-body')),
        hasSelector: typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
          ? CSS.supports('selector(:has(*))')
          : null,
      },
      mode: document.querySelector('.hud-resize')?.getAttribute('data-mode') ?? null,
      root: box('.hud-root'),
      card: box('.hud-card'),
      body: body
        ? { ...box('.hud-body'), maxHeight: getComputedStyle(body).maxHeight, gridAutoRows: getComputedStyle(body).gridAutoRows, rows: body.children.length }
        : null,
      // The whole complaint in one number: panel left unused below the card.
      wastedBelow: card === null ? null : Math.max(0, Math.round(window.innerHeight - card.getBoundingClientRect().bottom)),
      reportedAt: new Date().toISOString(),
    }
  }

  let reportTimer = null
  /** Debounced: a panel drag fires `resize` continuously. */
  function reportLayout(delayMs = 300) {
    if (reportTimer !== null) clearTimeout(reportTimer)
    reportTimer = setTimeout(() => {
      reportTimer = null
      try {
        // Fire-and-forget: no id, so nothing waits on a reply.
        bridge?.postMessage({ method: 'layout', params: measureLayout() })
      } catch (error) {
        debug('layout report failed', error)
      }
    }, delayMs)
  }
  window.addEventListener('resize', () => reportLayout())

  window.__hudBoot = function boot() {
    try {
      if (!react) throw new Error('React 运行时未加载')
      if (!entry) throw new Error('client.js 没有调用 window.__ModuleLoader__.load()')

      const exports = entry.factory(requireModule)

      /**
       * The shared pieces both of this port's cards are built from.
       *
       * `zh` follows the same rule the shell's own `pickLocale()` follows, so the
       * additions speak the language the rest of the HUD already settled on.
       */
      const panels = exports.__panels ?? []
      const jsxRuntime = requireModule('react/jsx-runtime')
      const zh = /^zh/i.test(document.documentElement.lang || navigator.language || 'en')
      const kit = {
        React: react.React,
        jsx: jsxRuntime.jsx,
        jsxs: jsxRuntime.jsxs,
        zh,
        /**
         * The card toolkit the bundle builds for its own panels.
         *
         * A panel gets it from the bundle's CLOSURE — its fragment is concatenated
         * into the same factory scope — so it is not in `props` and a wrapper
         * outside that scope has no other way to reach `fetchJson`, the settings
         * gear or the theme. `register.js` exports it deliberately
         * (`exports.__hud = hud`), which is what makes a card added from out here
         * behave like one written in there.
         */
        hud: exports.__hud,
      }

      /**
       * ── 今日涨跌榜 is the CARD's own view now ─────────────────────────────
       *
       * This port used to wrap the markets card with a leaderboard of its own,
       * because the card had none. The upstream then shipped one: 自选/涨幅榜/跌幅榜,
       * the same 20 rows, a 新股/退市 filter and a hover chart drawn with
       * `hud.CandleChart` — everything the wrapper did, inside the component that
       * owns the card. So the wrapper is gone, and the card is left alone.
       *
       * A panel's client id here is `markets` (the host mounts it as `market`, with
       * `futures` and `bond` beside it) — worth remembering before reaching into the
       * registry again, since the wrong id fails silently.
       */

      /**
       * ── the right slot: the database card, or an SSH terminal ────────────
       *
       * The two are one slot, so this is a SWAP rather than a preference: when the
       * mode is `ssh`, the vendor's SQL panel is REMOVED from the registry the shell
       * renders from, and this card is registered in its place. Removing it is the
       * point — merely hiding it would leave both reachable, which is the one thing
       * the setting promises cannot happen.
       *
       * Both halves of that come from the same extension point, so `hud/` stays
       * byte-for-byte upstream while this card is a first-class citizen of the grid:
       * same span, same order, same arrangement editor, same collapse and hide.
       */
      const rightCard = window.__hudHost?.rightCard === 'ssh' ? 'ssh' : 'database'
      if (rightCard === 'ssh') {
        try {
          const sqlIndex = panels.findIndex((panel) => panel?.id === 'sql')
          if (sqlIndex >= 0) panels.splice(sqlIndex, 1)

          const make = window.__hudSshCard
          if (typeof make !== 'function') throw new Error('media/ssh-card.js 没有加载')
          const Component = make({ ...kit, rpc: window.__hud.rpc, on: window.__hud.on })
          exports.__registerPanel({
            id: 'ssh',
            // Where the database card was: last, at the right-hand edge.
            order: 95,
            span: 1,
            defaultOn: true,
            defaultRows: 6,
            label: { zh: 'SSH', en: 'SSH' },
            Component,
          })
          debug('right card: ssh — sql removed, ssh registered')
        } catch (error) {
          // A card that fails to register must not take the HUD down: the database
          // panel was already dropped, so put it back and say what happened.
          debug('ssh card failed', error)
          renderFailure(error)
        }
      }

      /** What `ctx.slots.register` captured — one dock cell for the whole HUD. */
      const cells = []
      const ctx = {
        slots: {
          inject(_name, callback) {
            callback()
          },
          register(options, Component) {
            cells.push({ options, Component })
            return () => {}
          },
        },
        effect(callback) {
          const dispose = callback()
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        },
      }
      exports.apply(ctx)

      const cell = cells[0]
      if (!cell) throw new Error('HUD 没有注册任何 dock 单元')
      debug('cell registered', cell.options?.id, '| panels:', (exports.__panels ?? []).map((panel) => panel.id).join(','))

      // The slot's own `inject()` is what DSH hands a card as props — here it
      // carries the timer factory the shell passes down to every panel.
      const props = typeof cell.options.inject === 'function' ? cell.options.inject() : {}
      const container = document.getElementById('hud-root') || document.body
      react.ReactDOMClient.createRoot(container).render(react.React.createElement(cell.Component, props))
      debug('rendered', Object.keys(props))
      // Once now (so diagnostics works immediately) and once after the grid has
      // settled — the shell mounts its cards over several commits.
      reportLayout(0)
      reportLayout(1500)
    } catch (error) {
      debug('boot failed', error)
      renderFailure(error)
    }
  }

  // Exposed for the smoke test and for the diagnostics command.
  window.__hud = { rpc, on, storage, entry: () => entry, measureLayout, reportLayout }
  debug('runtime ready', { bridge: Boolean(bridge), react: Boolean(react), seed: Object.keys(host.storage || {}).length })
})()