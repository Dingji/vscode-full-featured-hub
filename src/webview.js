// @ts-check
/**
 * dsh-hud — the webview document.
 *
 * Pure string assembly, so the CSP, the script order and the injected host
 * payload can be asserted without a running VS Code.
 *
 * Order in the document is load-bearing and is why this is one function
 * instead of four `<script>` tags sprinkled through `extension.js`:
 *
 *   1. `theme.css`          the DSH tokens, bound to VS Code's theme variables
 *   2. the host payload     what the runtime reads for its storage seed
 *   3. `react.js`           React + jsx-runtime on `globalThis.__hudReact`
 *   4. `runtime.js`         the loader, the fetch bridge, the API shims
 *   5. `client.js`          the vendor's bundle — calls `__ModuleLoader__.load`
 *   6. `__hudBoot()`        register the dock cell and render it
 *
 * Nothing may move: `client.js` calls the loader synchronously while it
 * evaluates, and `runtime.js` is what defines that loader.
 */

'use strict'

/** A fresh CSP nonce per document. */
function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/**
 * The Content-Security-Policy the card is served under.
 *
 * `style-src` carries a nonce rather than `'unsafe-inline'`, and the runtime
 * stamps that same nonce onto every `<style>` the bundle creates
 * (`media/runtime.js` patches `document.createElement`) — the bundle injects
 * eleven stylesheets that way, so a nonce is what keeps the policy strict
 * without the card losing its styles.
 *
 * `img-src` admits `data:` because the theme adapter and the charts paint
 * inline gradients; `connect-src 'none'` because the card never speaks to the
 * network directly — every request is a same-origin `/dsh-hud/...` path that
 * the runtime routes over the message channel.
 * @param {{ nonce: string, cspSource: string }} options
 */
function buildCsp({ nonce, cspSource }) {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** Escape a JSON payload for embedding inside a `<script>` element. */
function embedJson(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * @param {object} options
 * @param {string} options.nonce
 * @param {string} options.cspSource            `webview.cspSource`
 * @param {string} options.lang                 BCP-47-ish, from `vscode.env.language`
 * @param {string} options.styleText            `media/theme.css`
 * @param {string[]} options.scriptUris         `react.js`, `runtime.js`, `client.js` — in that order
 * @param {object} options.hostPayload          exposed as `window.__hudHost`
 * @param {string} [options.title]
 */
function buildDocument({ nonce, cspSource, lang, styleText, scriptUris, hostPayload, title = 'HUD' }) {
  const scripts = scriptUris.map((uri) => `<script nonce="${nonce}" src="${uri}"></script>`).join('\n')
  return `<!DOCTYPE html>
<html lang="${String(lang || 'en').replace(/[^A-Za-z0-9-]/g, '')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${buildCsp({ nonce, cspSource })}">
<title>${title}</title>
<style nonce="${nonce}" data-plugin="dsh-hud" data-plugin-css="dsh-hud/vscode.css">${styleText}</style>
</head>
<body>
<div id="hud-root"></div>
<script nonce="${nonce}">window.__hudHost = ${embedJson(hostPayload)};</script>
${scripts}
<script nonce="${nonce}">window.__hudBoot()</script>
</body>
</html>`
}

module.exports = { buildDocument, buildCsp, makeNonce, embedJson }