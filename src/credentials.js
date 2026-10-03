// @ts-check
/**
 * dsh-hud — credentials (host side).
 *
 * A faithful port of DeepSeek Harness's own file-backed credential provider
 * (`@deepseek-ai/dsh-credentials-local`), so this extension shares ONE
 * credential set with the harness: a key configured for DSH works here with
 * no extra setup, and a key pasted into a card is immediately live in DSH.
 *
 * It plays the part of `ctx.credentials` for the HUD's panel host — the
 * service `hud/lib/host-kit.js` resolves, writes and removes refs through.
 *
 * Layering, most trusted first (identical to DSH):
 *
 *   inherited process environment      (read-only, wins)
 *   > $DSH_HOME/.credentials.yaml      (provider-managed, writable)
 *   > VS Code secret storage           (this build's extra managed layer)
 *   > <invocation cwd>/.env            (read-only fallback)
 *   > $DSH_HOME/.env                   (read-only fallback)
 *
 * The document is parsed with the same `yaml` package and the same rules DSH
 * uses — `version: 1`, a `refs:` mapping of POSIX-identifier names to
 * non-empty strings — and a document this build cannot prove it understands is
 * rejected loudly rather than read as "no credentials stored". Writes edit the
 * parsed document and re-render it, exactly like DSH's `renderRef`, so
 * comments and the formatting of every untouched entry survive.
 *
 * Windows path/name rules match DSH too: environment names resolve
 * case-insensitively, and `$DSH_HOME` falls back to `~/.dsh`.
 */

'use strict'

const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve, dirname } = require('node:path')
const { Document, parseDocument } = require('yaml')

/** Directory name for the default DeepSeek Harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh'
/** Environment variable that overrides the default DeepSeek Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'
/** Basename of the credentials document inside the harness home. */
const CREDENTIALS_FILENAME = '.credentials.yaml'
/** The document layout this build reads and writes. */
const DOCUMENT_VERSION = 1
/**
 * The reference grammar (`@deepseek-ai/dsh-credentials`): a POSIX shell
 * identifier. A name outside it has no reference to miss, and writing one into
 * the document would make the NEXT DSH boot reject the whole file — so it is
 * refused here, at the only place that can still say why.
 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Where a write may land. */
const STORE_DSH = 'dsh'
const STORE_VSCODE = 'vscode'
const STORE_BOTH = 'both'

/** Expand supported tilde prefixes against the operating-system home. */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root harness home. Precedence, highest first: an explicit
 * configured path, `$DSH_HOME`, then `~/.dsh`. An empty or whitespace-only
 * `$DSH_HOME` is treated as unset, so a blank override never resolves the home
 * to the current working directory.
 */
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV]
  return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME))))
}

/** The map key one variable name resolves under (Windows folds case). */
function lookupKey(name) {
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/** Read one variable out of a plain environment mapping, DSH-style. */
function envValue(env, name) {
  const key = lookupKey(name)
  for (const [k, v] of Object.entries(env)) {
    if (lookupKey(k) === key) {
      return typeof v === 'string' && v.length > 0 ? v : undefined
    }
  }
  return undefined
}

/**
 * Parse a dotenv file into a plain mapping. Deliberately conservative: only
 * `NAME=value` lines are admitted, with optional `export `, `#` comments,
 * single/double quoting, and `\n`-style escapes inside double quotes.
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseDotenv(text) {
  const out = {}
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      // An unquoted value ends at an unescaped ` #` comment marker.
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    out[m[1]] = value
  }
  return out
}

/** Describe one YAML parse failure without quoting the source (it holds secrets). */
function describeYamlError(error) {
  const at = error.linePos?.[0]
  const where = at === void 0 ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`
  return `${error.code}${where}`
}

/**
 * Parse one credentials document. Everything is rejected rather than skipped —
 * an unversioned root, an unknown top-level key, a key that is not addressable,
 * a wrong-typed value — because this file holds nothing but credentials and a
 * silently ignored entry reads as "the credential I stored has no effect".
 * @param {string} text
 * @param {string} filename absolute path, quoted in errors.
 * @returns {{ refs: Map<string,string>, records: Map<string,unknown> }}
 */
function parseCredentialsDocument(text, filename) {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`凭据文件无效 ${filename}：${document.errors.map(describeYamlError).join('; ')}`)
  }
  const root = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new TypeError(`凭据文件 ${filename} 必须是映射（mapping）`)
  }
  const fields = root
  const keys = Object.keys(fields)
  const refs = new Map()
  const records = new Map()
  if (keys.length === 0) return { refs, records }
  if (!('version' in fields)) {
    throw new Error(`凭据文件 ${filename} 是旧的扁平布局：请加上 \`version: 1\` 并把现有条目缩进到 \`refs:\` 下（值都不用改）`)
  }
  if (fields.version !== DOCUMENT_VERSION) {
    throw new Error(`凭据文件 ${filename} 声明 version ${JSON.stringify(fields.version)}；本版本只读 version ${DOCUMENT_VERSION}`)
  }
  for (const key of keys) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw new Error(`凭据文件 ${filename} 里有未知的顶层键 "${key}"`)
    }
  }
  for (const [key, value] of Object.entries(asSection(fields.refs, 'refs', filename))) {
    if (!REF_PATTERN.test(key)) throw new TypeError(`凭据引用 "${key}" 必须匹配 ${String(REF_PATTERN)}`)
    if (typeof value !== 'string') throw new TypeError(`凭据文件 ${filename} 里 "${key}" 的值必须是字符串`)
    if (value.length === 0) throw new Error(`凭据文件 ${filename} 里 "${key}" 的值为空；请删掉这一行`)
    refs.set(key, value)
  }
  // Records (authorization grants) belong to DSH: this build only has to prove
  // it can still parse the document before writing to it.
  for (const [key, value] of Object.entries(asSection(fields.records, 'records', filename))) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`凭据文件 ${filename} 里 record "${key}" 必须是映射（mapping）`)
    }
    records.set(key, value)
  }
  return { refs, records }
}

/** One section of the document as a plain mapping; absent and null both mean empty. */
function asSection(section, name, filename) {
  if (section === void 0 || section === null) return {}
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new TypeError(`凭据文件 ${filename} 里的 "${name}" 必须是映射（mapping）`)
  }
  return section
}

/**
 * Render the next document text with one reference set or deleted — the same
 * edit DSH's `renderRef` performs, so an untouched entry keeps its comments and
 * its exact spelling.
 * @param {string|undefined} text current document text, `undefined` while absent.
 * @param {string} ref
 * @param {string|undefined} value new value, or `undefined` to delete the key.
 * @returns {string}
 */
function renderRef(text, ref, value) {
  const document = text === void 0 ? new Document({}) : parseDocument(text)
  document.setIn(['version'], DOCUMENT_VERSION)
  if (value === void 0) document.deleteIn(['refs', ref])
  else document.setIn(['refs', ref], value)
  return document.toString()
}

/**
 * The credential store the collectors resolve against.
 *
 * `secretStorage` is optional and injected so the module stays usable (and
 * testable) outside VS Code: pass anything with `get(key)` / `store(key, value)`
 * / `delete(key)`, e.g. `context.secrets`.
 */
class CredentialStore {
  /**
   * @param {{ credentialsFile?: string, dshHome?: string, secretStorage?: any, cwd?: string, cacheMs?: number, target?: string }} [options]
   */
  constructor(options = {}) {
    this.dshHome = resolveDshHome(options.dshHome)
    this.filename = resolve(options.credentialsFile && options.credentialsFile.trim().length > 0
      ? expandHomePath(options.credentialsFile)
      : join(this.dshHome, CREDENTIALS_FILENAME))
    this.secretStorage = options.secretStorage
    this.cwd = options.cwd ?? process.cwd()
    this.cacheMs = options.cacheMs ?? 1_000
    /**
     * Where a bare `write(ref, value)` lands, from `hud.credentialStore`.
     * `hud/lib/host-kit.js` calls `write(ref, value)` with no third argument,
     * so this is what decides whether a secret pasted into a card goes to the
     * shared DSH document or to VS Code secret storage.
     */
    this.target = [STORE_DSH, STORE_VSCODE, STORE_BOTH].includes(options.target) ? options.target : STORE_DSH
    /** Raw text of the last read document; `undefined` while the file is absent. */
    this.text = undefined
    /** Parsed reference snapshot; replaced wholesale on every reload. */
    this.values = new Map()
    this.loadedAt = 0
    this.loaded = false
    /** Cached dotenv layers, keyed by source. */
    this.dotenv = { 'project-env': undefined, 'user-env': undefined }
  }

  /** The VS Code secret-storage key for one reference. */
  static secretKey(ref) {
    return `hud.credential.${ref}`
  }

  /** Drop the cache so the next resolve re-reads the document. */
  invalidate() {
    this.loaded = false
    this.dotenv = { 'project-env': undefined, 'user-env': undefined }
  }

  /** Where the credentials document lives (for diagnostics and the open command). */
  get file() {
    return this.filename
  }

  /** Every reference name currently stored in the managed document. */
  refs() {
    this.ensureFresh()
    return [...this.values.keys()]
  }

  /** The inherited-environment value for a reference, or `undefined` when empty or unset. */
  inherited(ref) {
    return envValue(process.env, ref)
  }

  /** Read the `<cwd>/.env` or `$DSH_HOME/.env` layer. */
  dotenvLayer(source) {
    if (this.dotenv[source] === undefined) {
      const file = source === 'project-env' ? join(this.cwd, '.env') : join(this.dshHome, '.env')
      try {
        this.dotenv[source] = parseDotenv(readFileSync(file, 'utf8'))
      } catch {
        this.dotenv[source] = {} // an absent or unreadable fallback is simply empty
      }
    }
    return this.dotenv[source]
  }

  /**
   * Re-read the managed document. Absence is an empty store; anything present
   * that cannot be understood throws, so a write can never overwrite a
   * document this build failed to parse.
   */
  reload() {
    let text
    try {
      text = readFileSync(this.filename, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      text = undefined
    }
    const next = text === undefined ? new Map() : parseCredentialsDocument(text, this.filename).refs
    this.text = text
    this.values = next
    this.loaded = true
    this.loadedAt = Date.now()
  }

  /** Reload when the cache has aged out. */
  ensureFresh() {
    if (!this.loaded || Date.now() - this.loadedAt >= this.cacheMs) this.reload()
  }

  /**
   * Resolve one reference through the documented layering.
   * @param {string} ref
   * @returns {Promise<{ value: string, source: string, path?: string } | undefined>}
   */
  async resolve(ref) {
    if (typeof ref !== 'string' || ref === '') return undefined
    const inherited = this.inherited(ref)
    if (inherited !== void 0) return { value: inherited, source: 'env' }
    this.ensureFresh()
    const stored = this.values.get(ref)
    if (stored !== void 0) return { value: stored, source: 'file', path: this.filename }
    const secret = await this.readSecret(ref)
    if (secret !== void 0) return { value: secret, source: 'secret' }
    for (const source of ['project-env', 'user-env']) {
      const value = this.dotenvLayer(source)[ref]
      if (typeof value === 'string' && value.length > 0) return { value, source }
    }
    return undefined
  }

  /** The VS Code secret-storage value for a reference, or `undefined`. */
  async readSecret(ref) {
    if (!this.secretStorage || typeof this.secretStorage.get !== 'function') return undefined
    try {
      const value = await this.secretStorage.get(CredentialStore.secretKey(ref))
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Describe one reference without revealing its value (diagnostics only).
   * @param {string} ref
   */
  async describe(ref) {
    if (this.inherited(ref) !== void 0) return { configured: true, source: 'env', writable: false }
    this.ensureFresh()
    if (this.values.get(ref) !== void 0) return { configured: true, source: 'file', writable: true, path: this.filename }
    if (await this.readSecret(ref)) return { configured: true, source: 'secret', writable: true }
    for (const source of ['project-env', 'user-env']) {
      if (this.dotenvLayer(source)[ref]) return { configured: true, source, writable: true }
    }
    return { configured: false, writable: true }
  }

  /**
   * Store one reference. Refused when the launching environment would shadow
   * the write into apparent no-effect — the same rule DSH enforces.
   * @param {string} ref
   * @param {string} value
   * @param {'dsh'|'vscode'|'both'} [target]
   * @returns {Promise<string>} where it landed (never the value)
   */
  async write(ref, value, target = this.target) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`不能为 "${ref}" 存空值`)
    }
    const landed = []
    if (target === STORE_DSH || target === STORE_BOTH) {
      if (this.inherited(ref) !== void 0) {
        throw new Error(`"${ref}" 由启动环境提供且只读，写入会被覆盖；请在启动 VS Code 的环境里取消它`)
      }
      if (!REF_PATTERN.test(ref)) {
        throw new Error(`凭据引用 "${ref}" 必须匹配 ${String(REF_PATTERN)}，否则 DSH 下次启动会拒绝整个凭据文件`)
      }
      this.writeToDocument(ref, value)
      landed.push('credentials.yaml')
    }
    if (target === STORE_VSCODE || target === STORE_BOTH) {
      if (!this.secretStorage || typeof this.secretStorage.store !== 'function') {
        throw new Error('VS Code 密钥存储不可用')
      }
      await this.secretStorage.store(CredentialStore.secretKey(ref), value)
      landed.push('VS Code secret storage')
    }
    if (landed.length === 0) throw new Error(`未知的凭据存放位置：${String(target)}`)
    return landed.join(' + ')
  }

  /**
   * Patch only this reference inside the document and replace the file
   * atomically, so a watcher (DSH's chokidar, our own readers) never sees a
   * half-written file. The directory is created when missing.
   */
  writeToDocument(ref, value) {
    this.ensureFresh()
    const nextText = renderRef(this.text, ref, value)
    mkdirSync(dirname(this.filename), { recursive: true })
    const tmp = `${this.filename}.${process.pid}.${Date.now().toString(36)}.tmp`
    writeFileSync(tmp, nextText, 'utf8')
    renameSync(tmp, this.filename)
    this.text = nextText
    this.values.set(ref, value)
    this.loaded = true
    this.loadedAt = Date.now()
  }

  /**
   * Remove one reference — the "log out" half of the drawer, which the HUD's
   * panels call (`host.credential.remove`).
   *
   * The line is DELETED, never blanked: this document treats an empty ref
   * value as a hard parse error, so writing `REF: ''` would break every other
   * credential in the file.
   *
   * @param {string} ref
   * @param {string} [target]
   * @returns {Promise<string>} what happened (diagnostics only)
   */
  async remove(ref, target = this.target) {
    if (typeof ref !== 'string' || ref === '') throw new Error('缺少要删除的凭据引用名')
    const landed = []
    if (target === STORE_DSH || target === STORE_BOTH) {
      if (this.inherited(ref) !== void 0) {
        throw new Error(`"${ref}" 由启动环境提供且只读，删除无效；请在启动 VS Code 的环境里取消它`)
      }
      landed.push(this.removeFromDocument(ref))
    }
    if (target === STORE_VSCODE || target === STORE_BOTH) {
      if (this.secretStorage && typeof this.secretStorage.delete === 'function') {
        await this.secretStorage.delete(CredentialStore.secretKey(ref))
        landed.push('VS Code secret storage')
      }
    }
    if (landed.length === 0) throw new Error(`未知的凭据存放位置：${String(target)}`)
    return landed.join(' + ')
  }

  /** Delete one key from the managed document, atomically. */
  removeFromDocument(ref) {
    this.ensureFresh()
    if (!this.values.has(ref)) return 'credentials.yaml (unchanged)'
    const nextText = renderRef(this.text, ref, undefined)
    mkdirSync(dirname(this.filename), { recursive: true })
    const tmp = `${this.filename}.${process.pid}.${Date.now().toString(36)}.tmp`
    writeFileSync(tmp, nextText, 'utf8')
    renameSync(tmp, this.filename)
    this.text = nextText
    this.values.delete(ref)
    this.loaded = true
    this.loadedAt = Date.now()
    return 'credentials.yaml'
  }
}

module.exports = {
  CredentialStore,
  resolveDshHome,
  parseCredentialsDocument,
  renderRef,
  parseDotenv,
  envValue,
  expandHomePath,
  CREDENTIALS_FILENAME,
  DSH_HOME_ENV,
  DSH_HOME_DIR_NAME,
  DOCUMENT_VERSION,
  REF_PATTERN,
  STORE_DSH,
  STORE_VSCODE,
  STORE_BOTH,
}