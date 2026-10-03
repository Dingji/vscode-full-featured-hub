// @ts-check
/**
 * dsh-hud — the in-process route table.
 *
 * The HUD's host half registers same-origin routes through
 * `ctx.webServer.register({ kind, path, handler })` and every panel handler
 * speaks plain Node `req`/`res`. Rather than translate all of that into an RPC
 * protocol — which would mean editing 9 panels — this module keeps the route
 * table and hands each handler a fake `req`/`res` pair shaped exactly like the
 * one the vendor's own host suite uses (`hud/tools/test-host.mjs`), so the
 * panel code runs unmodified.
 *
 * The transport is the webview message channel: the card posts
 * `{ method: 'route', params: { path, method, body } }` and gets back
 * `{ status, body }`.
 */

'use strict'

/** Largest request body any panel route will read (mirrors `MAX_BODY_BYTES`). */
const MAX_BODY_BYTES = 64 * 1024

/**
 * A fake `req` good enough for same-origin checks, body reads and query params.
 * @param {{ method?: string, url?: string, body?: string|object, host?: string, origin?: string }} [options]
 */
function makeRequest({ method = 'GET', url = '/', body, host = 'hud.local', origin } = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  /** @type {Record<string, Function[]>} */
  const listeners = {}
  return {
    method,
    url,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    on(event, fn) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(fn)
      return this
    },
    resume() {},
    destroy() {},
    /** Deliver the body to whoever is listening (mirrors a real socket). */
    flush() {
      if (text !== '') for (const fn of listeners.data ?? []) fn(Buffer.from(text))
      for (const fn of listeners.end ?? []) fn()
    },
  }
}

/**
 * Read a request body, with a bound.
 *
 * Rejects rather than truncating: a body that arrives too large must not be
 * silently read as the empty object, which is a request that "succeeded" with
 * every parameter defaulted.
 *
 * @param {any} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let text = ''
    let over = false
    req.on('data', (chunk) => {
      if (over) return
      text += chunk
      if (Buffer.byteLength(text, 'utf8') > limit) {
        over = true
        const error = new Error(`请求体超过 ${limit} 字节`)
        error.code = 'TOO_LARGE'
        reject(error)
      }
    })
    req.on('end', () => {
      if (!over) resolve(text)
    })
  })
}

/** A fake `res` capturing the status, the headers and the body. */
function makeResponse() {
  return {
    statusCode: 200,
    headers: /** @type {Record<string, string>} */ ({}),
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

/**
 * The route table. One instance per activated extension; panels register into
 * it through the cordis-shaped `webServer` service below.
 */
class RouteTable {
  constructor() {
    /** @type {Map<string, { kind: string, handler: Function }>} */
    this.routes = new Map()
  }

  /**
   * The `ctx.webServer` service. The contract matches DSH exactly:
   * a duplicate path throws, and the returned function unregisters it.
   */
  get service() {
    return {
      register: ({ kind, path, handler }) => {
        if (this.routes.has(path)) throw new Error(`duplicate route ${path}`)
        this.routes.set(path, { kind, handler })
        return () => this.routes.delete(path)
      },
    }
  }

  /** Every registered path — used by the diagnostics command. */
  paths() {
    return [...this.routes.keys()].sort()
  }

  /**
   * Dispatch one request. The route table is matched on the PATHNAME alone, so
   * a query string travels on `req.url` exactly as it does over HTTP.
   *
   * An unmatched path answers 404 with a non-JSON body, which is what the
   * shell's own `fetchJson` reads as "this host route does not exist".
   *
   * @param {{ path: string, method?: string, body?: string, headers?: Record<string, string> }} request
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
   */
  async dispatch(request) {
    const url = String(request?.path ?? '')
    const [pathname] = url.split('?')
    const route = this.routes.get(pathname)
    if (!route) {
      return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `no route for ${pathname}` }
    }
    const req = makeRequest({
      method: String(request?.method ?? 'GET').toUpperCase(),
      url,
      body: request?.body,
      ...(request?.headers && typeof request.headers === 'object' ? { origin: request.headers.origin } : {}),
    })
    const res = makeResponse()
    /** A handler that fails either way answers 500, as the web server would. */
    const failed = (error) => ({
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    })

    let promise
    try {
      // A SYNCHRONOUS throw happens before there is a promise to await, and
      // letting it escape would reject the whole RPC instead of answering 500.
      promise = route.handler(req, res)
    } catch (error) {
      return failed(error)
    }
    // Deliver the body, exactly as a real socket would. The BOUND is not
    // enforced here: a panel reads through `host.readBody`, which is already
    // capped at 64 KB and resolves on its own 2 s timer, and dropping the body
    // instead would leave such a handler waiting for an `end` that never comes.
    // The size a caller may SEND is capped one level up, at the RPC boundary.
    req.flush()
    try {
      await promise
    } catch (error) {
      return failed(error)
    }
    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body === undefined ? '' : res.body,
    }
  }
}

module.exports = { RouteTable, makeRequest, makeResponse, readBody, MAX_BODY_BYTES }