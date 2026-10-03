// A minimal `vscode` API stand-in, injected through Module._load.
//
// Enough of the real surface to activate the extension outside VS Code and
// drive every path the card can reach: the webview view, commands,
// configuration, secret storage, global state, the clipboard and notifications.
// Every call is recorded, so a test asserts what the extension DID rather than
// only that it did not throw.

'use strict'

const Module = require('node:module')
const { join } = require('node:path')

/** `hud.*` defaults, so `getConfiguration` behaves like the real thing. */
const DEFAULTS = {
  panels: {},
  retainContext: false,
  notifications: true,
  credentialsFile: '',
  credentialStore: 'dsh',
  statusBar: false,
  dshProfile: '',
  language: 'auto',
  quotaDiscovery: 'chosen',
}

const makeUri = (fsPath) => ({ scheme: 'file', fsPath, toString: () => `file:///${String(fsPath).replace(/\\/g, '/')}` })

function createMockVscode(overrides = {}) {
  const settings = { ...DEFAULTS, ...(overrides.settings ?? {}) }
  const calls = {
    commands: [], messages: [], openedExternal: [], clipboardWrites: [],
    quickPicks: [], inputBoxes: [], infoMessages: [], infoPrompts: [], errorMessages: [], warnings: [], updates: [],
  }
  /** Values written per scope, so `inspect` can report what a test set up. */
  const scopes = new Map()
  scopes.set('panels', { global: undefined, ...(overrides.workspaceSettings?.panels !== undefined ? { workspace: overrides.workspaceSettings.panels } : {}) })
  if (overrides.workspaceSettings?.panels !== undefined) settings.panels = overrides.workspaceSettings.panels
  const commands = new Map()
  const answers = overrides.answers ?? {}

  const outputChannel = {
    lines: [], cleared: 0,
    appendLine(line) { this.lines.push(line) },
    clear() { this.cleared++; this.lines = [] },
    show() {}, dispose() {},
  }

  const statusItem = {
    text: '', tooltip: '', command: '', visible: false,
    show() { this.visible = true }, hide() { this.visible = false }, dispose() {},
  }

  const globalState = new Map()
  /** An answer may be a value or a function of what was offered. */
  const answer = (configured, items, options) => (typeof configured === 'function' ? configured(items, options) : configured)

  // The real API is overloaded: `(message, ...items)` and
    // `(message, options, ...items)`. Normalizing here keeps tests honest about
    // which buttons are on offer.
    const messageParts = (rest) => {
      const options = rest[0] !== null && typeof rest[0] === 'object' ? rest[0] : undefined
      const items = (options === undefined ? rest : rest.slice(1)).filter((item) => typeof item === 'string')
      return { options, items }
    }

    const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    Uri: {
      file: makeUri,
      parse: (value) => {
        const match = /^([a-z][a-z0-9+.-]*):/i.exec(String(value))
        return { scheme: match ? match[1].toLowerCase() : '', fsPath: String(value), toString: () => String(value) }
      },
      joinPath: (base, ...parts) => makeUri(join(base.fsPath, ...parts)),
    },
    env: {
      language: overrides.language ?? 'zh-cn',
      openExternal: async (uri) => { calls.openedExternal.push(uri.toString()) },
      clipboard: {
        writeText: async (text) => { calls.clipboardWrites.push(text) },
        readText: async () => overrides.clipboardText ?? 'from-host',
      },
    },
    window: {
      createOutputChannel: () => outputChannel,
      createStatusBarItem: () => statusItem,
      registerWebviewViewProvider: (id, provider, options) => {
        calls.viewProvider = { id, provider, options }
        return { dispose() {} }
      },
      showQuickPick: async (items, options) => {
        calls.quickPicks.push({ items, options })
        return answer(answers.quickPick, items, options)
      },
      showInputBox: async (options) => {
        calls.inputBoxes.push(options)
        return answer(answers.inputBox, options)
      },
      showInformationMessage: async (message, ...rest) => {
        const { items } = messageParts(rest)
        calls.infoMessages.push(message)
        calls.infoPrompts.push({ message, items, answer: answers.info })
        return answers.info
      },
      showErrorMessage: async (message) => { calls.errorMessages.push(message) },
      showWarningMessage: async (message, ...rest) => {
        const { options, items } = messageParts(rest)
        calls.warnings.push({ message, items, options })
        return answers.warning
      },
      showTextDocument: async (doc, options) => { calls.shownDocument = { doc, options }; return { doc } },
    },
    workspace: {
      workspaceFolders: overrides.workspaceFolders ?? [],
      getConfiguration: () => ({
        get: (key) => settings[key],
        // Scopes are modelled, not faked away: `inspect` is how the extension
        // decides WHERE to write, and a stub that always answered "global"
        // would hide a real bug (a workspace value silently shadowing it).
        inspect: (key) => ({
          key,
          defaultValue: DEFAULTS[key],
          globalValue: scopes.get(key)?.global,
          workspaceValue: scopes.get(key)?.workspace,
          workspaceFolderValue: scopes.get(key)?.workspaceFolder,
        }),
        update: async (key, value, target) => {
          const scope = target === 2 ? 'workspace' : target === 3 ? 'workspaceFolder' : 'global'
          const entry = scopes.get(key) ?? {}
          entry[scope] = value
          scopes.set(key, entry)
          settings[key] = value
          calls.updates.push({ key, value, target, scope })
          const handler = vscode.__configHandler
          if (handler) await handler({ affectsConfiguration: (section) => section === `hud.${key}` || section === 'hud' })
        },
      }),
      onDidChangeConfiguration: (handler) => {
        vscode.__configHandler = handler
        return { dispose() { vscode.__configHandler = undefined } }
      },
      openTextDocument: async (uri) => { calls.openedDocument = uri; return { uri } },
    },
    commands: {
      registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() { commands.delete(id) } } },
      executeCommand: async (id, ...args) => {
        calls.commands.push({ id, args })
        if (id.endsWith('.focus')) return undefined
        const handler = commands.get(id)
        return handler ? handler(...args) : undefined
      },
    },
  }

  return { vscode, calls, settings, outputChannel, statusItem, globalState, commands, answers, scopes }
}

/** Route `require('vscode')` to whichever mock is current. */
let current = null
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return current.vscode
  return originalLoad.apply(this, arguments)
}

/** A stand-in for `vscode.ExtensionContext`. */
function createContext(extensionRoot, { secrets = new Map(), globalState } = {}) {
  return {
    subscriptions: [],
    extensionUri: makeUri(extensionRoot),
    extension: { packageJSON: { version: '2.0.0' } },
    globalState: {
      keys: () => [...globalState.keys()],
      get: (key) => globalState.get(key),
      update: async (key, value) => {
        if (value === undefined) globalState.delete(key)
        else globalState.set(key, value)
      },
    },
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => { secrets.set(key, value) },
      delete: async (key) => { secrets.delete(key) },
    },
  }
}

/** A stand-in for a resolved `WebviewView`, recording everything posted. */
function createWebviewView() {
  const posted = []
  const messageHandlers = []
  const view = {
    visible: true,
    posted,
    webview: {
      options: null,
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => `vscode-webview://test${String(uri.fsPath).replace(/\\/g, '/').replace(/^.*[\\/](media|hud)[\\/]/, '/$1/')}`,
      postMessage: async (message) => { posted.push(message); return true },
      onDidReceiveMessage: (handler) => { messageHandlers.push(handler); return { dispose() {} } },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    /** Deliver one request and wait for its reply. */
    request: async (method, params) => {
      const id = Math.floor(Math.random() * 1e9)
      await Promise.all(messageHandlers.map((handler) => handler({ id, method, params })))
      for (let i = 0; i < 100; i++) {
        const hit = posted.find((message) => message.id === id)
        if (hit) return hit
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`no reply for ${method}`)
    },
    /** Deliver a raw message — an unsolicited report carries no id. */
    send: async (message) => {
      await Promise.all(messageHandlers.map((handler) => handler(message)))
    },
  }
  return view
}

module.exports = { createMockVscode, createContext, createWebviewView, makeUri, DEFAULTS, setCurrent: (mock) => { current = mock }, getCurrent: () => current }