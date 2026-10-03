# Changelog

## 2.1.0

Follows the upstream plugin to **2.1.0** — the version this extension reports is
the version of the tree it ships.

**The rightmost card can now be an SSH terminal instead of the database client.**
`hud.rightCard` decides which, and the two are ONE slot rather than two cards: the
card that is not chosen is not registered at all, so there is no half-state where
both are reachable. Switch with `HUD: Right Card: Database / SSH…` or the button in
the HUD panel's title bar; changing it re-creates the card, like `hud.language`.

- **A real PTY** — xterm.js in the webview, `ssh2` in the host: `vim`, `top`,
  `Ctrl-C` and window changes all work. Keystrokes and output cross the webview
  channel as **base64**, because a shell's output is a byte stream and a UTF-8
  round trip mangles exactly the things a terminal exists to show.
- **Host management** in three places that share one list: the card's ⚙,
  `HUD: Manage SSH Hosts…`, and `$DSH_HOME/storages/dsh-hud/ssh/state.json`.
  Passwords and passphrases stay in the DSH credential document — a host entry
  carries only a credential NAME, the same split the SQL card makes.
- **Host keys are recorded and shown**, and `hud.sshStrictHostKey` refuses a
  changed fingerprint. Off by default: a self-signed key on a box you built
  yourself is the normal case, and the fingerprint is displayed either way, so
  "not verified" is something you can see rather than something you must trust.
- **Sessions belong to the webview that opened them.** `hud.retainContext`
  defaults to false, so switching away destroys the view; it closes what it opened
  rather than leaving a login running on somebody's server.

**`HUD: Manage SQL Connections…`** — the same add/edit/delete the card's ⚙ offers,
reachable from the command palette, going through the panel's own routes so
validation and storage stay one implementation. Its fields come from the host's own
driver table, so a driver or field added upstream appears here for free.

**SQL Server now connects.** Four defects in the TDS driver, found against a live
instance and each isolated by replaying a reference client's bytes:

- the plaintext fallback re-offered `ENCRYPT_OFF` and then sent a plaintext login —
  a contradiction a real server answers by closing the socket without a token. It
  now offers `ENCRYPT_NOT_SUP`, which is what a plaintext login means;
- `readMessage` listened only for `data` and `error`, so a server that hung up left
  the promise pending for ever — that was the whole of 登录超时;
- `session.query`, the method the panel calls on every driver, did not exist on the
  TDS, Oracle or DB2 sessions, so a connection that logged in fine could not run a
  statement;
- an unknown token (`0xEE`, FEDAUTHINFO) killed the reply instead of being skipped
  by its own width — and a length that cannot fit is still an error, because a
  misaligned stream must not be decoded as if it were real.

**Credit where it is due:** 今日涨跌榜 in the markets card — 涨幅榜/跌幅榜, 20 rows,
the hover intraday K-line, the 新股/退市 filter — is the UPSTREAM's feature. This
port had implemented its own version, at the same route path; the duplicate
registration took the whole card down, so the port's copy was removed and a test
now covers the upstream's.

## 2.0.0

First VS Code release, ported from the DeepSeek Harness plugin `dsh-hud` 2.0.0.

**The card is the vendor's own code, not a reimplementation.** `hud/` is a
byte-for-byte copy of the upstream plugin, and `npm run check:verbatim` proves
it on every run: every file the extension host imports or the webview loads must
hash identically. Only three seams are supplied from outside —

- **React**, bundled into `media/react.js` (the bundle's factory does exactly
  two `require`s: `react` and `react/jsx-runtime`);
- **a module loader**, `window.__ModuleLoader__`, in `media/runtime.js`;
- **the host services**, `ctx.webServer` and `ctx.credentials`, in
  `src/ctx.js` + `src/router.js` + `src/credentials.js`.

and the browser half's single `fetch` helper is bridged to an in-process route
table over the webview message channel. All nine host panels, all seven cards,
the column grid, the ⚙ layout editor and its ten prefs migrations, keep-alive,
the five hand-written SQL drivers and the hand-written IMAP client come across
untouched.

The vendor's own test suite runs against this copy unchanged — 1163 assertions
(693 host, 433 browser, 37 config) — which is possible because that suite
mounts the host against a mock cordis context with fake `req`/`res`, and the
card in jsdom with real React and a stubbed fetch: exactly the two seams a VS
Code port needs.

Adapted for VS Code:

- the card lives in a bottom-panel webview view instead of the composer dock;
- same-origin HTTP routes become webview RPC over an in-process route table,
  with handlers still handed a plain `req`/`res`;
- the three browser APIs the card uses — `Notification`, `navigator.clipboard`,
  `window.open` — are forwarded to VS Code notifications, the host clipboard and
  `openExternal`;
- the card's layout `localStorage` is backed by the host's `globalState`, with
  the seed injected into the document so the synchronous reads the shell does
  while mounting still see it;
- `media/theme.css` maps all 19 `--dsw-*` design tokens the bundle references
  onto VS Code theme variables, and a generator fails the build if the bundle
  ever ships a token with no mapping;
- the card's eleven self-injected stylesheets are covered by a CSP nonce rather
  than `'unsafe-inline'`: the runtime stamps the document's nonce onto every
  `<style>` as it is created.

Credentials are shared with DeepSeek Harness: the same document, the same
`yaml` parser, the same four-layer resolution order, the same
comment-preserving atomic write, so a key configured in either tool works in
both. Panel storage is unchanged too — still `$DSH_HOME/storages/<domain>/`.

56 tests of this port's own, on top of the vendor's 1163: an end-to-end mount of
the real bundle against the real host half in jsdom, activation against a mocked
`vscode` API, and units for the settings mapping, the route table and the
context adapter.

Two upstream edits were needed to make the port possible — neither is in
`hud/`:

- the extension owns a `package.json` of its own, and the HUD tree keeps its
  original one under `hud/`, so the panels still report the version the plugin
  ships;
- `tools/sync-hud.mjs` re-copies the tree from the upstream checkout, so
  following upstream is a copy rather than a merge.