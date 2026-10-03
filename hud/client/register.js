// dsh-hud — browser half, epilogue.
//
// FRAGMENT CONTRACT: `tools/build-client.mjs` concatenates this file LAST, so
// every `create<Id>Panel` factory declared by a panel fragment is already in
// scope here (function declarations hoist across the whole bundle factory).

/**
 * The panel factories this bundle MOUNTS AS CARDS — one line per card.
 *
 * This is the browser half of the extension point: the host half is `PANELS`
 * in `panels/index.js`. Order is irrelevant here (the shell sorts tabs by each
 * panel's own `order`), but keeping the two lists in the same order keeps them
 * easy to compare.
 *
 * NOT every panel factory. 股市, 债市 and 期货 are three panels sharing ONE card, so their
 * factories are called by that card's own component rather than listed here. Registering one of
 * them would give it a card of its own — and since it ships off by default, a pill in the head
 * row offering to bring that duplicate card back. The rule: a factory is listed here when it IS a
 * card, and called directly when it is a VIEW of one.
 */
const CLIENT_PANELS = [createQuotaPanel, createGithubPanel, createTodoPanel, createWeatherPanel, createParcelPanel, createMarketsPanel, createSqlPanel]

// Instantiate every panel at materialize time. A panel that throws while being
// constructed must not take the HUD down: it is reported and its tab simply
// never appears, while every other panel still mounts.
for (const create of CLIENT_PANELS) {
  try {
    registerPanel(create())
  } catch (error) {
    console.error('[hud] panel factory failed:', error)
  }
}

// ── cordis plugin entry ────────────────────────────────────────────────────
exports.inject = ['slots']
// Test-only handles (the loader only reads name/apply/inject).
exports.__HudShell = HudShell
// The shared toolkit, for tests that need to exercise the shell's own plumbing (its request
// helper, for one) without going through a panel.
exports.__hud = hud
// The arrangement editor's opener. The ⚙ that used to call it is gone from the head row, and this
// is how the suite still exercises the editor.
exports.__openLayoutEditor = (open) => {
  if (typeof openLayoutEditor !== 'function') return false
  openLayoutEditor(open === true)
  return true
}
exports.__panels = PANELS
exports.__registerPanel = registerPanel
/**
 * The layout model, for the test harness.
 *
 * The packing and the migrations are PURE functions, and they are the part of the
 * free grid that a DOM test cannot check properly (a grid that resolves overlaps
 * is a property of the algorithm, not of pixels). Exposing them here means they can
 * be asserted directly, with no editor, no clicks and no jsdom quirks.
 */
exports.__layout = {
  resolveGrid,
  contentHeightOf,
  migrateV2,
  migrateV3,
  migrateV4,
  migrateV5,
  migrateV6,
  migrateV7,
  migrateV8,
  migrateV9,
  migrateV10,
  defaultPrefs,
  clampSpan,
  clampRows,
  clampIndex,
  CARD_SIZES,
  PREFS_VERSION,
  MAX_COLUMNS,
  MAX_ROWS,
  AUTO_MAX_ROWS,
  MIN_ROWS,
  DEFAULT_ROWS,
  ROW_UNIT_PX,
  ROW_GAP_PX,
  LEGACY_DEFAULT_ROWS,
  rowsForHeight,
  layoutModel: () => PANELS.map((panel) => ({ id: panel.id, span: panel.span, defaultOn: panel.defaultOn, hasCard: typeof panel.Component === 'function' })),
}

exports.apply = function apply(ctx) {
  dbg('apply running; slots service:', typeof ctx.slots, 'panels:', PANELS.map((panel) => panel.id).join(',') || '(none)')

  /**
   * ONE dock cell for the whole HUD.
   *
   * `id` must be the package name: the shell loads the plugin row and then
   * asserts `factories.has(id)` against `dsh.client`'s resolved bundle, so the
   * module-loader id and the package name have to agree.
   *
   * `inject` hands every panel the timer factory — a panel reads it from its
   * props (`props.startTimers`), which is how the ported panels kept working
   * unchanged.
   */
  const register = () => {
    try {
      const dispose = ctx.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'dsh-hud',
          order: 90,
          label: 'HUD',
          inject: () => ({ startTimers }),
        },
        HudShell,
      )
      dbg('registered into conversation.input.dock', typeof dispose)
    } catch (error) {
      console.error('[hud] slot registration failed:', error)
    }
  }

  if (typeof ctx.slots.inject === 'function') {
    ctx.slots.inject('conversation.input.dock', register)
  } else {
    ctx.effect(register, 'dsh-hud: registration')
  }
}