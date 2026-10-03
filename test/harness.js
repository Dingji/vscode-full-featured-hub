// Shared test harness: a throwaway HTTP server and a temp DSH home.

'use strict'

const http = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/**
 * Start a local HTTP server standing in for an upstream vendor.
 * @param {Record<string, (req: http.IncomingMessage, body: string) => any>} routes
 *   keyed by `"<METHOD> <pathname>"`. A plain object result is JSON-encoded;
 *   `{ __raw }` is written verbatim, `{ __status, __body }` controls the status.
 */
async function startServer(routes = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url, 'http://127.0.0.1')
      seen.push({ method: req.method, url: req.url, path: url.pathname, query: url.search, headers: req.headers, body })
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) {
        res.statusCode = 404
        res.end('{}')
        return
      }
      const out = handler(req, body)
      res.statusCode = out?.__status ?? 200
      if (out && out.__raw) {
        res.setHeader('content-type', out.__type ?? 'application/octet-stream')
        res.end(out.__raw)
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out?.__body ?? out ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    last: () => seen[seen.length - 1],
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A temp directory removed when `dispose` runs. */
function tempDir(prefix = 'dsh-hud-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Let the microtask/macrotask queues drain (React 18 renders concurrently). */
async function settle(rounds = 4, ms = 15) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until `check()` is true, or give up.
 *
 * The card mounts its panels progressively (each one arms its own poll on
 * mount), so a fixed sleep is either flaky or slow; a bounded condition wait is
 * both fast and honest about what is being asserted.
 * @param {() => boolean} check
 * @param {{ timeoutMs?: number, stepMs?: number, label?: string }} [options]
 */
async function waitFor(check, { timeoutMs = 10_000, stepMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

module.exports = { startServer, tempDir, settle, waitFor }