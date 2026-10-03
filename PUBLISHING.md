# Publishing

Everything below is about putting this extension on the **VS Code Marketplace**
(and optionally **Open VSX**). The repository's own checks are in `README.md`;
this file is the release procedure.

---

## 1. Three things a publish needs that a local `.vsix` does not

| | why | state |
|---|---|---|
| **`repository` in `package.json`** | It has TWO consequences, and the second one is fatal. (1) `vsce` warns and then asks *"Do you want to continue? [y/N]"* — answering anything but `y` throws `Aborted`, and with no stdin to answer (CI, a script, a piped command) that is what happens. (2) **A relative link anywhere in `README.md` becomes a hard error**, because without a repository URL `vsce` cannot rewrite it: `ERROR Couldn't detect the repository … The link 'PUBLISHING.md' will be broken in README.md` — and **no `.vsix` is produced at all**. Measured, not guessed. | ✅ `https://github.com/Dingji/vscode-full-featured-hub.git` |
| **A registered publisher id** | the value in `package.json#publisher` must be an ID **you own** — `vsce` compares it against the publisher your token belongs to and refuses to upload on any difference. | ✅ `vscode-full-featured-hub` |
| **A display name nobody has taken** | `displayName` is the listing's **title**, and the Marketplace requires it to be unique. A bare generic word loses: `ERROR This extension display name is taken. Please try a different one.` The `name` and the `publisher` are scoped to you, but this one is global — so it needs something specific in it. | ✅ `Full Featured Hub` |
| **A 128×128 PNG icon** | an SVG is rejected, and the view-container icon is a monochrome glyph that a Marketplace listing would render as a grey blob. | ✅ `media/icon.png` |
| **Third-party notices** | the bundle redistributes MIT code: React + ReactDOM (`media/react.js`), xterm.js (`media/xterm.js`), and `ssh2` + `yaml` as dependencies. The copyright and permission notice must travel with every copy, and a minified bundle is still a copy. | ✅ `THIRD-PARTY-NOTICES.md`, plus the `@license` comments kept at the end of both bundles |

So, once:

```jsonc
{
  "name": "vscode-full-featured-hub",       // the id's second half — scoped to your publisher
  "displayName": "Full Featured Hub",       // the listing TITLE — globally unique, so be specific
  "publisher": "vscode-full-featured-hub",  // the id's first half — MUST be an ID you own
  "repository": { "type": "git", "url": "https://github.com/Dingji/vscode-full-featured-hub.git" },
  "homepage": "https://github.com/Dingji/vscode-full-featured-hub#readme",
  "bugs": { "url": "https://github.com/Dingji/vscode-full-featured-hub/issues" }
}
```

### The display name is the one global namespace

`name`, `publisher` and the extension ID are yours alone once registered; the
**display name is not**. It is what the Marketplace shows as the title and what
users search, and if anyone already holds it the upload stops with:

```
ERROR  This extension display name is taken. Please try a different one.
```

The fix is a name with something specific in it. `HUD` alone was rejected here, so
the listing is `Full Featured Hub` — matching the package and the repository — while
the **in-editor labels stay `HUD`**: the bottom-panel tab, the view name and the
output channel are all `hud.*`/`HUD` and have nothing to do with the listing title.

### The publisher mismatch, in the words `vsce` uses

This one has already been hit once, so it is worth recognising:

```
Publisher ID 'dsh-hud' provided in the extension manifest should match the
publisher ID 'vscode-full-featured-hub' under which you are trying to publish
this extension.
```

It is a **pure string comparison** — no upload happens, and nothing is wrong with
the token. `vsce` resolves your token to the publisher it belongs to and compares it
with the manifest. Two ways out, and only one of them is a good idea:

- **Change the manifest** to the publisher you actually own (what this repository
  does: `vscode-full-featured-hub`), or
- register a *second* publisher whose ID is `dsh-hud` and use that token instead.

Note it is a **different** error from `ERROR The publisher "…" does not exist`,
which means the token is fine but the ID is not registered at all.

**A publisher change renames the extension ID**, and a new ID is a NEW extension to
VS Code: installing it alongside the old one leaves two extensions registering the
same HUD view. Uninstall the old ones first —

```bash
code --uninstall-extension dsh-hud.dsh-hud
code --uninstall-extension dsh-hud.vscode-full-featured-hub
```

The command ids, setting keys, routes and storage paths are all `hud.*` /
`/dsh-hud/…` / `storages/dsh-hud/…` and do **not** follow the package name or the
publisher, so neither rename loses any configuration.

**The listing is `package.json#description` + `keywords` + `README.md`.** The first
two are the search surface, so a feature that is not in them is a feature nobody
finds: the description names the panels and the two cards, and `keywords` carries
`ssh`, `terminal`, `database`, `sql-server`, `stocks`, `candlestick` and so on.
Edit those when a card is added, not after the release.

## 2. A publisher and a token (once)

1. **Publisher** — <https://marketplace.visualstudio.com/manage>, sign in with a
   Microsoft account, *Create publisher*. The **ID** it gives you is the value
   `package.json#publisher` must carry.
2. **Token** — <https://dev.azure.com> → *User settings* → *Personal access
   tokens* → *New Token*:
   - **Organization: All accessible organizations** (not a single org — a
     single-org token is the most common "401 Unauthorized" here)
   - **Scopes: Marketplace → Manage**
3. **Log in once** so no token lands in your shell history:

   ```bash
   npx --yes @vscode/vsce@4 login vscode-full-featured-hub   # paste the token when asked
   ```

   It is kept in `~/.vsce`. (`vsce publish -p <token>` also works and is worse:
   the token ends up in your history and in any log that captures the command.)

### Or run `publish.ps1`, which prompts for it instead

```powershell
pwsh -File publish.ps1              # verify, then publish the 2.1.0 .vsix
pwsh -File publish.ps1 -Check       # verify only — publishes nothing
```

It reads the PAT with `Read-Host -AsSecureString` (never echoed, never in history),
runs **`verify-pat` first** and stops if that fails, and then publishes the existing
`.vsix` with `--packagePath` so it does not touch the version. If `VSCE_PAT` is
already set in the environment it uses that instead of prompting, which is what CI
needs — and what makes the script itself testable without a human.

> **The BOM in that file is load-bearing.** Windows PowerShell 5.1 reads a `.ps1`
> without a UTF-8 BOM as ANSI; the script's messages are Chinese, so the parser then
> fails with *"unexpected `}`"* pointing at lines that contain no brace at all.
> Measured, and asserted in `test/extension-activation.test.js` — which is also where
> the "verify before publish" ordering is pinned.

### The two credential errors, and what each one means

| what you see | what it means |
|---|---|
| `Publisher ID '…' provided in the extension manifest should match the publisher ID '…'` | the token is fine; `package.json#publisher` is not the publisher you own (§1) |
| `TF400813: The user 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' is not authorized` | the value is not a usable PAT at all. A real one is **52** lowercase alphanumerics; a 36-character GUID (an Azure AD object/tenant/application id) is not one |
| `An undefined error occurred … Status code 0: error` | the request died before any HTTP response. With a valid token it is a network problem (proxy, TLS interception, IPv6); with a token that identifies nobody it is this same message, which is why `verify-pat` is the test that separates them |

## 3. Every release

```bash
npm run hud:sync          # pull the upstream plugin, if it moved
npm run vendor            # regenerate media/react.js, media/xterm.js, media/theme.css
npm run verify            # verbatim + the vendor's suites + this port's own
npm run package           # build the .vsix locally first, and install it
```

`npm run verify` is the gate: it runs `check:verbatim` (the `hud/` tree is
byte-for-byte upstream), the vendor's three suites (host, browser, config) and this
port's own. A release that fails any of them is a release with a known-false claim
in its README.

Then publish:

```bash
npx --yes @vscode/vsce@4 publish patch    # or minor / major / an explicit x.y.z
```

`vsce` runs the same checks as `package`, uploads the archive, and updates the
listing. The Marketplace page is generated from `README.md`; the changelog tab
from `CHANGELOG.md`; the icon from `media/icon.png`.

- **Pre-release**: `vsce publish --pre-release` — users only get it if they opt
  in, and it needs a version *higher* than the current release (or an odd minor,
  e.g. `2.1.0` after `2.0.0`).
- **Open VSX** (VSCodium, Theia, Gitpod, code-server) needs its own account and
  token — <https://open-vsx.org/user-settings/tokens>, then:

  ```bash
  npx --yes ovsx@latest publish vscode-full-featured-hub-2.1.0.vsix -p <open-vsx-token>
  ```

  The namespace has to exist first (sign in with GitHub, claim `vscode-full-featured-hub`).

## 4. Verify after publishing

```bash
code --install-extension vscode-full-featured-hub.vscode-full-featured-hub
```

Worth eyeballing on the listing: the icon on **both** light and dark themes, the
README tables and code fences, and that the version shown matches
`package.json`. Then a real run: the card must still mount, and
`HUD: Show Diagnostics` must report the panels and their routes.

## 5. Things specific to this repository

- **`hud/` is someone else's plugin, shipped verbatim.** `npm run check:verbatim`
  is the claim; run it in the release you publish, and note the upstream revision
  in `CHANGELOG.md` — "identical to upstream" is only meaningful against a named
  revision. The upstream is developed separately, so a release is a deliberate
  snapshot, not a moving target.
- **Do not relax `.vscodeignore`.** It is what keeps the archive at ~1.6 MB by
  excluding `hud/client/**` (the bundle *fragments* `hud/client.js` is built
  from), `hud/panels/*/client.js`, `hud/tools/**` and `test/**`. Without those
  lines the same extension packs to several megabytes of files nothing loads.
- **`extensionKind: ["ui"]` is deliberate.** The host half reads
  `$DSH_HOME/.credentials.yaml` and `$DSH_HOME/storages/`, and the SQL, IMAP and
  SSH clients open sockets from the extension host — so it must run where the user
  is, not on a remote. Do not "fix" this to `workspace`.
- **Nothing secret is ever packed.** Credentials live in the document the
  extension reads at runtime; connections live in `$DSH_HOME` too. If a release
  ever needs a check, one is cheap:

  ```bash
  npx --yes @vscode/vsce@4 ls --tree
  ```
- **`publisher` and the Marketplace id must agree** — see §1. The failure is a string
  comparison and happens before anything is uploaded, so it costs nothing but a
  round trip; the same manifest must match the token's publisher, every time.
- **`vsce` warns that ~650 files / ~200 JavaScript files "should be bundled".** That
  advice is about extensions whose own source is many modules. Here almost all of
  it is `node_modules/yaml` and `node_modules/ssh2`, which are runtime dependencies
  and cannot be left out, and `hud/**`, which must stay verbatim. Bundling this
  extension would mean bundling someone else's tree, so the warning is accepted —
  it is a `WARNING`, not an error, and `DONE Packaged` follows it.
- **The upstream moves while you work.** It is a separate checkout that the author
  (you) edits continuously, and it has already grown a feature this port had
  implemented independently — same route path, and the duplicate registration took
  the whole card down. So: `npm run hud:sync` first, then **re-read the diff it
  reports** before releasing, and never assume a route path is yours alone.