#!/usr/bin/env node
// @ts-check
/**
 * dsh-hud — generate `media/theme.css` for VS Code.
 *
 * The card's stylesheets are the vendor's own (injected by `hud/client.js`,
 * byte for byte) and they are written against DSH's design tokens:
 * `var(--dsw-alias-border-l1, rgba(0,0,0,.07))` and so on. A VS Code webview
 * has no such tokens, so every one of them is DEFINED here in terms of the
 * host's own theme variables — the card then follows light, dark and
 * high-contrast themes without a single rule of it changing.
 *
 * The token list is not hand-maintained: it is read out of the bundle, and a
 * token with no mapping FAILS this script. That is the point — a new panel
 * shipping a new token would otherwise silently fall back to the DSH palette
 * and look subtly wrong only in someone else's theme.
 *
 *   node tools/gen-theme.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(root, 'hud', 'client.js')
const OUT = join(root, 'media', 'theme.css')

/**
 * token → [VS Code expression, DSH literal fallback].
 *
 * The fallback is what DSH itself would have drawn, so the stylesheet stays
 * self-contained: if a variable is missing (a theme that does not set it, or a
 * future VS Code that renames one) the card still renders, just in DSH's own
 * palette rather than the host's.
 */
const MAP = {
  // Surfaces. `bg-base` is deliberately transparent: the shell is a strip of
  // cards floating on the dock, and the panel's own background must show through.
  '--dsw-alias-bg-base': ['transparent', 'transparent'],
  '--dsw-alias-bg-layer-1': ['var(--vscode-editorWidget-background, #ffffff)', '#ffffff'],
  '--dsw-alias-bg-layer-2': ['var(--vscode-input-background, rgba(0,0,0,.02))', 'rgba(0,0,0,.02)'],
  // Popovers and the layout editor's overlay sit above the cards.
  '--dsw-alias-bg-overlay': ['var(--vscode-menu-background, var(--vscode-editorWidget-background, #ffffff))', '#ffffff'],

  // Hairlines. l1 is the quiet one (inset tracks, dividers, button outlines),
  // l2 the emphatic one (card edge, inputs, popover edge).
  '--dsw-alias-border-l1': ['var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.28)))', 'rgba(0,0,0,.08)'],
  '--dsw-alias-border-l2': [
    'var(--vscode-contrastBorder, var(--vscode-input-border, var(--vscode-widget-border, rgba(128,128,128,.42))))',
    'rgba(0,0,0,.14)',
  ],

  // Text, in descending emphasis.
  '--dsw-alias-label-primary': ['var(--vscode-foreground, #0f1115)', '#0f1115'],
  '--dsw-alias-label-secondary': ['var(--vscode-descriptionForeground, #61666b)', '#61666b'],
  '--dsw-alias-label-caption': ['var(--vscode-disabledForeground, var(--vscode-descriptionForeground, #81858c))', '#81858c'],
  '--dsw-alias-text-2': ['var(--vscode-descriptionForeground, rgba(38,49,72,.62))', 'rgba(38,49,72,.62)'],

  // The brand accent: VS Code's link colour is the idiomatic blue and is
  // legible on every built-in theme's widget surface.
  '--dsw-alias-brand-primary': ['var(--vscode-textLink-foreground, #4d6bfe)', '#4d6bfe'],
  '--dsw-alias-state-business-primary': ['var(--vscode-textLink-foreground, #3964fe)', '#3964fe'],

  // Hover surfaces.
  '--dsw-alias-interactive-bg-hover': ['var(--vscode-list-hoverBackground, rgba(38,49,72,.05))', 'rgba(38,49,72,.05)'],

  // Semantic states. Each chain ends in a variable every built-in theme sets.
  '--dsw-alias-state-error-primary': ['var(--vscode-errorForeground, #dc2626)', '#dc2626'],
  '--dsw-alias-state-warn-primary': ['var(--vscode-editorWarning-foreground, #b45309)', '#b45309'],
  // The vendor ships both spellings; they mean the same thing.
  '--dsw-alias-state-warning-primary': ['var(--vscode-editorWarning-foreground, #b45309)', '#b45309'],
  '--dsw-alias-state-success-primary': [
    'var(--vscode-charts-green, var(--vscode-testing-iconPassed, #16a34a))',
    '#16a34a',
  ],
  // "Idle" is a neutral, not a colour: a dot for something that is simply off.
  '--dsw-alias-state-idle-primary': ['var(--vscode-descriptionForeground, #b6bac1)', '#b6bac1'],
  '--dsw-static-amber-500': ['var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground, #f59e0b))', '#f59e0b'],
}

// ── read the tokens out of the bundle ──────────────────────────────────────
const source = readFileSync(BUNDLE, 'utf8')
const found = new Map()
for (const match of source.matchAll(/var\((--dsw-[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/g)) {
  const token = match[1]
  if (!found.has(token)) found.set(token, new Set())
  const fallback = (match[2] ?? '').trim()
  if (fallback) found.get(token).add(fallback)
}

const unmapped = [...found.keys()].filter((token) => !(token in MAP)).sort()
if (unmapped.length > 0) {
  console.error(`refused to write — ${unmapped.length} token(s) in hud/client.js have no VS Code mapping:`)
  for (const token of unmapped) console.error(`  ${token}   (fallbacks seen: ${[...found.get(token)].join(' | ')})`)
  console.error('Add them to MAP in tools/gen-theme.mjs.')
  process.exit(1)
}

const stale = Object.keys(MAP).filter((token) => !found.has(token))
// Not fatal: the vendor may drop a token, and keeping a spare mapping is harmless.
if (stale.length > 0) console.log(`note: ${stale.length} mapped token(s) no longer used: ${stale.join(', ')}`)

const declarations = Object.keys(MAP)
  .filter((token) => found.has(token))
  .sort()
  .map((token) => `  ${token}: ${MAP[token][0]};`)
  .join('\n')

const header = `/* dsh-hud — VS Code theme adapter. GENERATED by tools/gen-theme.mjs — DO NOT EDIT.
 *
 * Defines every \`--dsw-*\` design token the card's own stylesheets reference
 * (read out of hud/client.js, ${found.size} of them) in terms of VS Code's theme
 * variables, so the card follows light / dark / high-contrast themes without a
 * single rule of its own changing. Each declaration carries DSH's literal value
 * as the last fallback, which is what keeps the card renderable in a host that
 * sets none of these.
 */

/* ── the panel surface ──────────────────────────────────────────────────────
 * \`.hud-root\` is a strip of cards floating on the dock, so the hosting
 * document supplies the margins, the type scale and a transparent background.
 */
html,
body {
  margin: 0;
  padding: 0;
  background: transparent;
}

body {
  box-sizing: border-box;
  padding: 0;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  line-height: normal;
  -webkit-font-smoothing: antialiased;
}

/* The card can outgrow a short panel; the scrollbar is the panel's, dressed in
 * VS Code's own scrollbar colours so it does not look bolted on. */
body::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

body::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, .4));
}

body::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, .7));
}

/* A dropdown's option list is painted by the OS, not by the page: \`color-scheme\`
 * is what tells it whether to draw light or dark rows. */
:root {
  color-scheme: light dark;
}

/* ── the panel IS the container ─────────────────────────────────────────────
 * In DSH the HUD sits in the composer dock: the shell measures the window,
 * subtracts \`COMPOSER_RESERVE_PX\` (72 px) so the composer stays visible, caps
 * the grid with that number, and sizes it from each card's \`rows\` preference —
 * which is what an arrangement means when the page, not the card, is what
 * scrolls.
 *
 * A VS Code panel has no composer, and the panel's own edge is the height
 * control. So the HUD fills it, always, and a card's \`rows\` becomes a MINIMUM
 * (that is what \`minmax()\` encodes) rather than a fixed height. The whole card
 * then reflows the instant the panel is dragged.
 *
 * These declarations are UNCONDITIONAL and \`!important\` on purpose. The first
 * two attempts at this keyed off the shell's own \`data-mode\` through \`:has()\`,
 * which made a working layout depend on (a) one selector feature and (b) the
 * shell still rendering a height preference the same way. Neither is a promise
 * this port can hold the vendor to, and the failure mode — a card that silently
 * ignores every panel resize — is exactly the bug being fixed. The vendor's own
 * stylesheet cannot win here: \`max-height\` comes from a normal declaration in
 * it, so an \`!important\` author declaration beats it whichever order the two
 * stylesheets land in.
 *
 * The card's own resize grip is REMOVED rather than left inert: it resized the
 * HUD against a dock this host does not have, and with the panel driving the
 * height it could only ever lie about what it did. Dragging the panel's edge is
 * the same gesture, and it is the one the user already reaches for.
 */
.hud-root {
  display: flex !important;
  flex-direction: column !important;
  box-sizing: border-box !important;
  height: 100vh !important;
  min-height: 0 !important;
}

.hud-root > .hud-card {
  flex: 1 1 auto !important;
  min-height: 0 !important;
}

.hud-root .hud-body {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  /* The shell's window-minus-composer cap would clip the grid and leave the
   * dead strip this replaces. */
  max-height: none !important;
  grid-auto-rows: minmax(var(--hud-row-h, 78px), 1fr) !important;
}

.hud-resize {
  display: none !important;
}

/* ── DSH design tokens → VS Code theme tokens ───────────────────────────── */
:root {
${declarations}
}
`

writeFileSync(OUT, header, 'utf8')
console.log(`media/theme.css written: ${found.size} tokens mapped, ${header.length} bytes`)