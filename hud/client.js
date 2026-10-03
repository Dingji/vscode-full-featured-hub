// @dingji_cherubino/dsh-full-featured-hub — browser half. GENERATED FILE — DO NOT EDIT.
//
// Hand-authored client bundle in the DSH module-loader factory format:
//   window.__ModuleLoader__.load({ id, factory: (require) => exports })
// Only the platform module table may be required (react / react/jsx-runtime).
//
// Built by `node tools/build-client.mjs` from:
//   - client/shell.js
//   - panels/bond/client.js
//   - panels/futures/client.js
//   - panels/fx/client.js
//   - panels/github/client.js
//   - panels/market/client.js
//   - panels/markets/client.js
//   - panels/parcel/client.js
//   - panels/quota/client.js
//   - panels/sql/client.js
//   - panels/todo/client.js
//   - panels/weather/client.js
//   - client/register.js
//
// Edit those fragments, never this file. A fragment is concatenated verbatim
// into the factory below, so it may not contain top-level import/export/return.

window.__ModuleLoader__.load({
  id: "@dingji_cherubino/dsh-full-featured-hub",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const { jsx, jsxs } = require('react/jsx-runtime')
    const React = require('react')

// ──────────────────────────────────────────────────────────────────────────
// ── client/shell.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud — browser half, shell.
//
// FRAGMENT CONTRACT: `tools/build-client.mjs` concatenates this file, every
// `panels/<id>/client.js` and `client/register.js` into ONE `client.js` bundle,
// inside a single factory scope. So: no top-level `import` / `export` /
// `return` here, and every name declared here is visible to every panel.
//
// ── the layout model ───────────────────────────────────────────────────────
//
// The HUD is a COLUMN GRID, not a tab strip: several cards are on screen at the
// same time, side by side.
//
//   - the grid has `columns` tracks (default 3, settable 1–3);
//   - every panel declares a `span` (1–3 tracks) and the user can override it
//     per panel from the ⚙ menu;
//   - a panel that does not fit in the tracks left on the current row simply
//     wraps to the next row (ordinary CSS grid auto-placement), so a card is
//     never dropped and never overlaps;
//   - a panel the user switched OFF is not placed at all. It stays MOUNTED but
//     `hidden`, and it reappears as a small pill in the head row — so a panel
//     with something to say (an unread badge) is visible even while it is off.
//
// So "how many columns a card takes" is one number per card, and everything
// else — what sits next to what, what wraps, what is left over — falls out of
// the grid instead of being computed here.
//
// ── what the shell owns ────────────────────────────────────────────────────
//
//  - the ONE `conversation.input.dock` cell. A panel is not a dock entry any
//    more; it is a grid cell. Adding a panel no longer risks fighting another
//    plugin for an `order`.
//  - **keep-alive.** Every panel stays MOUNTED, on or off: an off panel is only
//    `hidden`. Switching one on therefore never restarts a poll, never resets a
//    carousel position and never loses an open drawer.
//  - the card frame, the placement, the grid, the ⚙ layout editor.
//  - the poll/clock timer factory (`startTimers`), passed to every panel.
//  - a tiny shared toolkit (`hud`) so panels stop re-implementing the same
//    fetch / locale / clamp helpers.
//
// The panel contract (browser side) is deliberately tiny:
//
//   function createExamplePanel() {
//     function Example() { return jsx('div', { children: '…' }) }
//     function ExampleHead() { return jsx('span', { children: '现在 24°C' }) }
//     return {
//       id: 'example', order: 30, span: 1,
//       label: { zh: '示例', en: 'Example' },
//       Component: Example,   // → a card in the column grid
//       head: ExampleHead,    // → a widget in the title bar
//     }
//   }
//
// and then one line in `client/register.js`. A panel may provide EITHER half:
// `head` only means a title-bar widget that never consumes a grid column (that
// is what the weather readout is), `Component` only means an ordinary card, and
// both means one panel in two places.

const dbg = (...args) => {
  try {
    console.log('[hud]', ...args)
  } catch {
    /* console unavailable */
  }
}

// ── constants ──────────────────────────────────────────────────────────────
const CLOCK_MS = 1_000
const DEFAULT_POLL_MS = 60_000
/** Hard floor of the refresh cadence — mirrored by every panel's host config. */
const MIN_POLL_MS = 30_000
const MAX_POLL_MS = 600_000
/** Browser-local presentation preferences (per browser, not per machine). */
const PREFS_KEY = 'dsh-hud:prefs'
/**
 * Bumped whenever the STORED SHAPE or the rules that validate it change.
 *
 * v2 = the single-row rule. A v1 layout could legally hold 8 columns of cards
 * across three rows; it is invalid by construction now, and migrating it would
 * mean silently choosing which of the user's cards to throw away. So a v1 blob
 * is dropped once and the panels' own defaults take over — a decision the user
 * can see (the ⚙ editor) rather than guess at.
 */
const PREFS_VERSION = 11
/**
 * The row count the old defaults wrote into EVERY card. Kept as a named constant
 * because v3 → v4 has to recognise it: a stored 3 is that old default, not a choice.
 */
const LEGACY_DEFAULT_ROWS = 3
/** Grid tracks the HUD can be divided into. Rows are unbounded — see below. */
const MAX_COLUMNS = 3
const DEFAULT_COLUMNS = 3
const COLUMN_OPTIONS = [1, 2, 3]
/** Tracks a single card takes when nothing else is said. */
const DEFAULT_SPAN = 1
/**
 * ── rows: there is no limit, and there is a reason it used to be one ────────
 *
 * The first build allowed exactly ONE row, because the dock slot sits inside the
 * app's composer stack: every pixel the HUD takes is a pixel the input bar does
 * not get. That trade-off is real, but making it a hard rule was the wrong half
 * of the answer — it turned "I want a fourth card" into an error message.
 *
 * Now the grid is as tall as the cards need, and the ceiling moved to where it
 * belongs: the HUD area scrolls inside `--hud-max`, so the composer keeps its
 * `COMPOSER_RESERVE_PX` whatever the layout says. Many rows, one scrollbar.
 */
const MIN_ROWS = 1
const MAX_ROWS = 12
/**
 * How tall AUTO height may grow a card.
 *
 * Lower than `MAX_ROWS` on purpose: 8 is how tall a card may be SET, and a measurement
 * has no idea it is being greedy — one long event list would take the whole HUD the
 * moment its panel loaded. Past this the card scrolls inside itself, and it is one
 * click away in the ⚙ editor if you do want it taller.
 */
const AUTO_MAX_ROWS = 12
/**
 * The height of one grid row, in px.
 *
 * Fixed rather than `auto`, because a row has to mean the same thing for every card in it: with
 * `auto` a single tall card silently stretches its neighbours, and "make this card two rows tall"
 * stops being predictable. A card that needs more room than its rows allow scrolls inside itself.
 *
 * This is also the single number that sets the height of the whole HUD, because every card is
 * measured in rows: the shipped arrangement is 7 rows tall, so the HUD is 7 × (unit + gap) and
 * nothing else.
 *
 * It was 78, which made a 7-row arrangement 616px — and the screenshot that prompted this showed
 * what that meant in practice: cards whose content needs 200px were given 264px, and the surplus
 * was spent as empty space BETWEEN their own rows, because a card's layout distributes into
 * whatever height it is handed. Shrinking the unit shrinks every card and the gaps inside them,
 * which is the only lever that fixes all of them at once.
 *
 * 54 with a 6px gap is a 60px stride: the 7-row arrangement is 414px. Against the 606px it started
 * at that is a third off, and it is the ROW COUNT that could not give more: the middle column is
 * 用量限额 (3) + 快递 (2) + GitHub (2) and has to equal the two full-height cards, so taking a row
 * off means 用量限额 in two — about 110px for content that needs 180, which is a scrollbar.
 */
const ROW_UNIT_PX = 54
const DEFAULT_ROWS = 3
/**
 * Which event family this environment speaks.
 *
 * The drag and resize handles that once needed this are GONE — moving a card is now an
 * order change in the settings. The constant stays because it is the honest answer to
 * "does this browser have pointer events", and the lesson it encodes is worth keeping:
 * a browser fires `pointerdown` AND `mousedown` for the same gesture, so registering
 * both runs every handler twice.
 *
 * Pointer events are the right answer in a browser (they cover mouse, pen and
 * touch with one code path), but jsdom does not implement `PointerEvent` — so the
 * harness, which has no `PointerEvent`, still behaves like a browser that does not.
 * the test suite exercises the same logic through mouse events.
 */
const POINTER_EVENTS = typeof window !== 'undefined' && typeof window.PointerEvent === 'function'

function clampRows(value) {
  return clamp(Math.round(num(value) ?? DEFAULT_ROWS), MIN_ROWS, MAX_ROWS)
}

/** The gap between rows, in px. Kept here because the maths below needs it. */
const ROW_GAP_PX = 6

/**
 * How many rows a card of this height needs.
 *
 * Pure, so it can be tested without a layout engine — jsdom has none, and a rule
 * that decides how tall every card is should not be untestable.
 */
function rowsForHeight(heightPx, { collapsed = false } = {}) {
  if (collapsed) return 1
  const height = num(heightPx)
  // No measurement (jsdom, a hidden card, a card mid-mount) is NOT the same as
  // "zero tall": answering 1 here would collapse every card the moment one
  // measurement came back missing.
  if (height === undefined || height <= 0) return undefined
  const stride = ROW_UNIT_PX + ROW_GAP_PX
  return clamp(Math.ceil((height + ROW_GAP_PX) / stride), MIN_ROWS, AUTO_MAX_ROWS)
}

/**
 * How tall a card's CONTENT is, in pixels.
 *
 * Deliberately not `panel.scrollHeight`: the panel does not scroll, its BODY does, so the
 * panel reports the height it was GIVEN. Measuring it made the loop agree with the layout
 * it exists to correct — a card one row short of its content stayed one row short for ever,
 * and the "已用 (CNY)" row of the quota card was simply cut off.
 *
 * The flex column is head + gap + body + padding, so that is what is summed. `undefined`
 * means "nothing to measure" (jsdom, a card mid-mount), never "zero tall".
 */
function contentHeightOf(panel) {
  if (panel === null || panel === undefined || typeof window === 'undefined') return undefined
  const head = panel.querySelector(':scope > .hud-panel-head')
  const body = panel.querySelector(':scope > .hud-panel-body')
  const bodyHeight = body?.scrollHeight ?? 0
  const headHeight = head?.offsetHeight ?? 0
  if (bodyHeight === 0 && headHeight === 0) return undefined
  const style = window.getComputedStyle(panel)
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  const gap = parseFloat(style.rowGap ?? style.gap) || 0
  return headHeight + bodyHeight + padding + (head !== null && body !== null ? gap : 0)
}

function clampIndex(value, max) {
  return clamp(Math.round(num(value) ?? 0), 0, Math.max(0, max - 1))
}

/**
 * ── the placement algorithm ────────────────────────────────────────────────
 *
 * Cards are arranged by an explicit ORDER, edited in the settings panel (↑/↓ and a
 * size), not by dragging them around the grid. The order is packed first-fit from the
 * top-left, so the HUD is always tight: no hole above or to the left of any card,
 * whatever was resized, reordered, folded or switched off.
 *
 * Rules, in order:
 *
 *   1. Cards are sorted by their stored `order`. Ties break on the card's ID, never on
 *      its index in the input array — the panel registry gaining a row must not shuffle
 *      the grid, and the same preferences must always produce the same layout.
 *   2. Each card, in that order, takes the FIRST slot it fits in, scanning row-major
 *      from the top-left. A row therefore fills to three tracks before the next row
 *      starts — and a short card lands beside a tall neighbour rather than below it,
 *      which is what keeps a 中 next to a 小 from leaving a hole.
 *
 * ── why order, and not coordinates ─────────────────────────────────────────
 *
 * Two earlier versions stored where a card SAT. Both were wrong, in opposite
 * directions: honouring the coordinates literally left a large empty region in the
 * middle of the HUD (a card dropped at row 3 stayed at row 3 and everything flowed
 * around the hole), and packing the dropped coordinates as a sort key meant a card
 * could not be put anywhere at all. An explicit order removes the ambiguity: the list
 * IS the layout, the settings panel edits the list, and packing makes it tight.
 *
 * The only hole this can leave is one nothing can fill — a free track beside a wide
 * card when every remaining card is wider than the gap. That is arithmetic, not slack.
 *
 * PURE, and exported for the test harness: the whole layout contract is here.
 */
function resolveGrid(items, columns) {
  const tracks = clampColumns(columns);
  /** A card may never be wider than the grid, or packing could not terminate. */
  const sized = items.map((item) => ({
    ...item,
    span: clamp(item.span, 1, tracks),
    rows: clampRows(item.rows),
    want: Math.max(0, Math.round(num(item.order) ?? 0)),
  }));
  const sorted = [...sized].sort((a, b) => (
    a.want - b.want
    || String(a.id).localeCompare(String(b.id))
  ));
  const occupied = new Set();
  const key = (row, col) => `${row}:${col}`;
  const fits = (row, col, span, rows) => {
    if (col + span > tracks) return false;
    for (let r = row; r < row + rows; r++) {
      for (let c = col; c < col + span; c++) {
        if (occupied.has(key(r, c))) return false;
      }
    }
    return true;
  };
  const take = (row, col, span, rows) => {
    for (let r = row; r < row + rows; r++) {
      for (let c = col; c < col + span; c++) occupied.add(key(r, c));
    }
  };
  const placed = new Map();
  for (const item of sorted) {
    let spot;
    // FIRST-FIT from the top-left, always. The bound is generous rather than exact:
    // every card needs `span * rows` cells, so `n * (rows + 1)` rows is more than any
    // packing of them can require, and the loop therefore cannot run away.
    const limit = Math.max(1, sized.length) * (item.rows + 1) + 1;
    for (let row = 0; row <= limit && spot === undefined; row++) {
      for (let col = 0; col + item.span <= tracks; col++) {
        if (fits(row, col, item.span, item.rows)) {
          spot = { row, col };
          break;
        }
      }
    }
    // Unreachable with the bound above, but a placement algorithm must never return
    // "nowhere" and leave a card out of the grid.
    spot = spot ?? { row: 0, col: 0 };
    take(spot.row, spot.col, item.span, item.rows);
    placed.set(item.id, spot);
  }
  const rows = sized.reduce((max, item) => {
    const spot = placed.get(item.id);
    return Math.max(max, spot.row + item.rows);
  }, 0);
  return {
    /** `id → { row, col }` for every card that was resolved. */
    place: placed,
    rows: Math.max(MIN_ROWS, rows),
    tracks,
  };
}
/**
 * Below this width the grid collapses to ONE track (see the stylesheet).
 *
 * Deliberately LOW. The track count is the user's setting — a three-column HUD
 * at 700px is cramped but it is what they asked for, and `minmax(0,1fr)` means
 * the tracks shrink instead of overflowing. This is only a safety net for a
 * genuinely tiny dock, where three tracks would be unreadable rather than
 * merely tight.
 */
const NARROW_PX = 560
/**
 * Breathing room between the card and the dock's edges, in px.
 *
 * The card fills the dock's width, but flush against both edges it reads as
 * cramped — a surface whose border touches the transcript's gutter looks like a
 * layout accident. One number, both sides; `.hud-root` is border-box so this
 * padding is INSET rather than added on top of 100% (it used to be content-box,
 * which made the root 4px wider than its container and pushed the card off
 * centre).
 */
const HUD_GUTTER_PX = 8
/**
 * The gap between the HUD's BOX and the region it spans — separate from the HUD's own inner
 * padding above, and deliberately not the same number: the two add up, and 8 + 8 is what
 * reads as "not touching the edge". Without this the span ran edge to edge and the cards sat
 * against the window.
 */
const PAGE_GUTTER_PX = 10
/**
 * Room the composer keeps for itself, in the same column as the HUD.
 *
 * The dock slot sits inside the app's composer stack, directly above the input
 * bar, so this is not politeness — it is the space the input needs to stay
 * usable. Measured against the shell: the composer card with one line of text is
 * ~96px, plus the stack's own 6px gap.
 */
const COMPOSER_RESERVE_PX = 72

/**
 * The draggable range for the HUD's own height, in pixels.
 *
 * The floor is the same as the measured floor has always been. There is no clever ceiling:
 * the value may exceed the column, which pushes the composer below the fold and lets the
 * PAGE scroll instead of a card — see the note on the handle below. 2400 is a sanity cap,
 * not a design limit.
 */
/**
 * The four cards that make up the shipped arrangement, in packing order.
 *
 * They are named here rather than derived because this list IS the layout: a migration that
 * re-applies the arrangement has to know which cards the arrangement is made of. In packing
 * order: 股市债市 takes the first column, 用量 and GitHub stack in the middle, 数据库 takes
 * the third.
 */
const SHIPPED_ARRANGEMENT = ['markets', 'quota', 'sql', 'parcel', 'github']

const MIN_HUD_PX = 140
const MAX_HUD_PX = 2400
/** One press of the arrow keys, and one press of PageUp/PageDown. */
const HUD_HEIGHT_STEP_PX = 20
/**
 * Raised from 104 to 88 pixels of reserve, i.e. the HUD gets 16px more of the column.
 * The shipped layout is now four rows tall (about 342px plus the head row), and a
 * layout that scrolls by default is a layout that looks broken. 88 is still well over
 * the composer input's own height — this is slack, not the input's box.
 */
// There is deliberately NO width cap and NO placement mode here.
//
// This HUD fills the dock, always: `.hud-root` spans it and `.hud-card` fills
// that. An earlier build offered 通栏/居中/靠右/靠左 with a 620px cap for the
// non-stretch modes, and the preference it wrote outlived the mode: a stale
// `align: 'center'` in localStorage kept pinning the card to a narrow centred
// column long after full width became the intent. One unconditional rule
// cannot be overridden by a key nobody remembers writing.

// ── shared helpers ─────────────────────────────────────────────────────────

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function clampColumns(value) {
  return clamp(Math.round(num(value) ?? DEFAULT_COLUMNS), 1, MAX_COLUMNS)
}

/**
 * The three sizes a card can be, as the settings panel presents them.
 *
 * Named rather than numeric because that is how they are chosen: "大" is a decision, and
 * "3" is an implementation detail that the user should not have to translate. The span
 * is clamped against the grid at render time either way, so a 大 on a 2-column grid is
 * a 2.
 */
const CARD_SIZES = [
  { span: 3, zh: '大', en: 'Large' },
  { span: 2, zh: '中', en: 'Medium' },
  { span: 1, zh: '小', en: 'Small' },
]

function clampSpan(value, columns) {
  return clamp(Math.round(num(value) ?? DEFAULT_SPAN), 1, Math.max(1, clampColumns(columns)))
}

/** The card follows the document language, exactly like the panels did. */
function pickLocale() {
  try {
    const html = document.documentElement.lang || ''
    if (/^zh/i.test(html)) return 'zh'
    if (navigator.language && /^zh/i.test(navigator.language)) return 'zh'
  } catch {
    /* no document yet */
  }
  return 'en'
}

/**
 * Fetch JSON from one of our own same-origin routes. A bounded wait: an
 * unresponsive host must fail the poll, never hang it.
 */
async function fetchJson(url, init) {
  let res
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000), ...init })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(/timeout|abort/i.test(msg) ? '请求超时（20s）' : `网络错误：${msg}`)
  }
  const json = await res.json().catch(() => null)
  if (!res.ok || !json || json.ok === false) {
    let text = String(json?.error || (json ? `HTTP ${res.status}` : `HTTP ${res.status}（响应不是 JSON）`))
    /**
     * A 404 or 405 on a plugin route has one overwhelmingly likely cause, and the bare status
     * code does not hint at it.
     *
     * The browser half is loaded fresh on every page load, but the HOST half is a Node module
     * cached by URL — so a route added since the process started does not exist yet, and every
     * request to it answers 404 (or 405, if the request was not a GET: the web server checks the
     * method before it checks whether the path is registered).
     *
     * "HTTP 405（响应不是 JSON）" is true, and completely unactionable. This is the same lesson as
     * the dropped `secrets` parameter earlier: a failure that reads like something else costs
     * whoever hits it far more than the sentence it would have taken to explain.
     */
    // ONLY when the body is not JSON.
    //
    // A 404/405 with a non-JSON body is the web server's own answer for a path it has no route
    // for — that is the missing-host-route case. A JSON body means the ROUTE answered, and it
    // knows its own reason ("method-not-allowed" from a route that exists, for instance). Adding
    // the restart advice to that sends someone to restart a process that does not need it, which
    // is worse than saying nothing.
    if (json === null && (res.status === 404 || res.status === 405) && url.startsWith('/')) {
      text += ' —— 宿主的这个路由还不存在。插件宿主半区是按 URL 缓存的 Node 模块，新加或改过的路由需要重启 Harness 才会挂载（刷新页面不够）。'
    }
    const error = new Error(text)
    // The WHOLE body goes on the error, not just the sentence.
    //
    // Several panels report a failure as DATA — the SQL card's query answers HTTP 200 with
    // `ok: false` and the server's own code, DETAIL and HINT — and a caller that wants those
    // cannot get them back out of a message string. This throws for every panel alike, so the
    // payload has to travel with it.
    error.payload = json ?? undefined
    error.status = res.status
    throw error
  }
  return json
}

/**
 * Poll + clock timers for one panel. Built from window timers ONLY: reading
 * `ctx.timer` / `ctx.interval` on the guarded client context throws
 * `cannot get property "timer" without inject` and would crash the slot entry.
 * Every step is best-effort so a failed timer never takes a panel down.
 */
function startTimers(onPoll, pollMs, onTick, tickMs) {
  const stops = []
  const cadence = clamp(num(pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS)
  try {
    stops.push(window.setInterval(onPoll, cadence))
  } catch (error) {
    console.error('[hud] poll timer unavailable:', error)
  }
  if (typeof onTick === 'function') {
    try {
      stops.push(window.setInterval(onTick, tickMs || CLOCK_MS))
    } catch (error) {
      console.error('[hud] clock timer unavailable:', error)
    }
  }
  return () => {
    for (const stop of stops) {
      try {
        window.clearInterval(stop)
      } catch {
        /* already cleared */
      }
    }
  }
}

// ── presentation preferences (browser-local) ───────────────────────────────
/**
 * `layout` is per panel: `{ [panelId]: { span?: 1|2|3, hidden?: boolean } }`.
 *
 * The defaults are DERIVED from the panels, not hard-coded here: a panel may
 * declare `defaultOn: false` to arrive switched off, and the rest come on in
 * order until the single row is full. That keeps the shell from knowing any
 * panel's name while still producing a legal, useful starting layout.
 */
function defaultPrefs() {
  const layout = {}
  // Sorted by each panel's own `order`, which is the same number the shell sorts cards
  // by — so the registry array stays a SET and the arrangement is declared where the
  // panel is declared. (Sorting by array position instead would make the default layout
  // depend on the order of import statements.)
  const cards = [...PANELS].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  let index = 0
  for (const panel of cards) {
    if (typeof panel.Component !== 'function') {
      // A head-only panel consumes no column; it is simply on.
      layout[panel.id] = { hidden: false }
      continue
    }
    const span = clampSpan(num(panel.span) ?? DEFAULT_SPAN, MAX_COLUMNS)
    const entry = { hidden: panel.defaultOn === false, span, order: index++ }
    // A panel may DECLARE a default height, and the four cards of the shipped layout do:
    // 股市债市 is two rows, 用量限额 and 机器 are one each beside it, 数据库 is two. That
    // arrangement is a design decision, not a measurement — a "two rows tall" card is
    // what makes the first column read as one block. Every other card is measured, and
    // any card can be handed back to the measurement with 自动 in ⚙.
    if (num(panel.defaultRows) !== undefined) entry.rows = clampRows(panel.defaultRows)
    // A ceiling applies from the first run too, so a fresh install and an existing one agree
    // about how tall the card is. The default IS the ceiling: a ceiling means "as tall as
    // this card ever needs to be", and the measurement then refines it downwards in the
    // browser. `Math.min(floor, ceiling)` would have pinned it to the FLOOR instead, which
    // is how this first read 2 where the test expected 3.
    if (num(panel.maxRows) !== undefined) entry.rows = clampRows(panel.maxRows)
    layout[panel.id] = entry
  }
  // Nothing hidden on a fresh install: the shipped arrangement is the three columns it draws.
  return { v: PREFS_VERSION, columns: DEFAULT_COLUMNS, layout, hiddenColumns: [] }
}

/**
 * v2 → v3. Keeps every choice the user actually made (on/off, span, folded) and
 * derives the new positional fields by packing the cards in their old order.
 *
 * Migrating rather than discarding is deliberate: v2's single-row rule and v3's
 * multi-row grid describe the SAME first row, so there is nothing to guess at and
 * nothing to throw away. (v1 was discarded because it could hold a layout that is
 * invalid by construction — see the note above PREFS_VERSION.)
 */
function migrateV2(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const columns = clampColumns(base.columns)
  const layout = {}
  let order = 0
  for (const panel of PANELS) {
    const entry = stored[panel.id] && typeof stored[panel.id] === 'object' ? stored[panel.id] : {}
    if (typeof panel.Component !== 'function') {
      layout[panel.id] = { hidden: entry.hidden === true }
      continue
    }
    const span = clampSpan(num(entry.span) ?? panel.span ?? DEFAULT_SPAN, columns)
    layout[panel.id] = {
      hidden: entry.hidden === true,
      span,
      collapsed: entry.collapsed === true,
      order: order++,
    }
  }
  return { v: PREFS_VERSION, columns, layout }
}

/**
 * v3 → v4: cards stop having a FIXED height and start being measured.
 *
 * A stored `rows` of exactly 3 is dropped, because 3 is what the old defaults wrote
 * for every card — it says nothing about what the user wanted. Any other value is
 * kept: 5 meant 5, and the measurement must not overrule it.
 */
function migrateV3(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const layout = {}
  for (const [id, entry] of Object.entries(stored)) {
    if (entry === null || typeof entry !== 'object') continue
    const next = { ...entry }
    if (num(next.rows) === LEGACY_DEFAULT_ROWS) delete next.rows
    layout[id] = next
  }
  return { v: PREFS_VERSION, columns: base.columns, layout }
}

/**
 * v4 → v5: the arrangement becomes an explicit ORDER.
 *
 * v4 stored where each card sat (`col`, `row`) and let the packer honour it. v5 stores
 * a position in a single ordered list, because that is what the settings panel edits —
 * you move a card up or down the list, you do not place it at coordinates. The mapping
 * is exact rather than a guess: reading the old layout in its own order (row, then
 * column, then id) gives precisely the sequence the user was looking at.
 *
 * `col`/`row` are then DELETED. Keeping them would leave two sources of truth for the
 * same question — where does this card go — and the stale one would keep winning in
 * whichever code path forgot to ignore it.
 */
function migrateV4(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const layout = {}
  const ordered = []
  for (const panel of PANELS) {
    const entry = stored[panel.id] && typeof stored[panel.id] === 'object' ? stored[panel.id] : {}
    const next = { hidden: entry.hidden === true }
    if (typeof panel.Component !== 'function') {
      layout[panel.id] = next
      continue
    }
    if (num(entry.span) !== undefined) next.span = entry.span
    if (num(entry.rows) !== undefined) next.rows = entry.rows
    if (entry.collapsed === true) next.collapsed = true
    layout[panel.id] = next
    ordered.push({
      id: panel.id,
      row: Math.max(0, Math.round(num(entry.row) ?? 0)),
      col: Math.max(0, Math.round(num(entry.col) ?? 0)),
    })
  }
  ordered.sort((a, b) => (
    a.row - b.row
    || a.col - b.col
    || String(a.id).localeCompare(String(b.id))
  ))
  ordered.forEach((item, index) => {
    layout[item.id] = { ...layout[item.id], order: index }
  })
  return { v: PREFS_VERSION, columns: base.columns, layout }
}

/**
 * v5 → v6: re-apply the shipped arrangement, once.
 *
 * Why a reset rather than a nudge: the PANEL SET changed. 股市 and 债市 are one card now,
 * so the old arrangement's entries for them describe cards that no longer exist, and the
 * new card has no entry at all. Re-deriving "what the user meant" from that would be
 * guesswork dressed up as migration.
 *
 * What is KEPT: every card's on/off state and folded state — those are the user's
 * decisions and they still mean exactly what they meant. Sizes and order come from the
 * shipped layout, and any card can be changed again in ⚙ (which is also where 自动 hands
 * a card back to the measurement).
 */
function migrateV5(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const fresh = defaultPrefs()
  const layout = {}
  for (const [id, entry] of Object.entries(fresh.layout)) {
    const before = stored[id] && typeof stored[id] === 'object' ? stored[id] : {}
    layout[id] = { ...entry }
    if (before.hidden !== undefined) layout[id].hidden = before.hidden === true
    if (before.collapsed === true) layout[id].collapsed = true
  }
  return { v: PREFS_VERSION, columns: clampColumns(base.columns), layout }
}

/**
 * v6 → v7: give the measurement its job back.
 *
 * A card with a stored height is never re-measured — correct, because a height the user
 * chose by hand must survive. But v6 stored the DECLARED height of every shipped card, so
 * the four cards that most needed measuring were exactly the four that could not be, and a
 * chart with more to show than its design allowed simply scrolled.
 *
 * So: a stored height that EQUALS the panel's declared height is dropped. That value
 * cannot be the user's — it is what v6 wrote — and dropping it yields
 * `max(measured, declared)`: the declared height or taller, never shorter. A stored height
 * that differs from the declaration is the user's own, and is kept exactly.
 */
function migrateV6(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const fresh = defaultPrefs()
  const layout = {}
  for (const [id, entry] of Object.entries(fresh.layout)) {
    const before = stored[id] && typeof stored[id] === 'object' ? stored[id] : {}
    layout[id] = { ...entry }
    if (before.hidden !== undefined) layout[id].hidden = before.hidden === true
    if (before.collapsed === true) layout[id].collapsed = true
    const declared = num(PANELS.find((panel) => panel.id === id)?.defaultRows)
    // The CEILING counts as machine-written too: `defaultPrefs` seeds `rows` from it, so a
    // card that declared one would otherwise look as if the user had chosen that height and
    // stay pinned there instead of being measured.
    const ceiling = num(PANELS.find((panel) => panel.id === id)?.maxRows)
    const kept = num(before.rows)
    if (kept !== undefined && kept !== declared && kept !== ceiling) {
      layout[id].rows = clampRows(kept)
    } else {
      // DELETE it — `defaultPrefs()` seeds `rows` from `defaultRows`, so declining to
      // overwrite leaves the declared value in place and the card stays un-measurable.
      // The declaration belongs in `defaultRows`, where it acts as a FLOOR.
      delete layout[id].rows
    }
  }
  return { v: PREFS_VERSION, columns: clampColumns(base.columns), layout }
}

/**
 * v7 → v8: the middle column's lower cell changed hands.
 *
 * GitHub took the machine card's place, and NOTHING else about the arrangement moved. So
 * the on/off state of those two cards is taken from the shipped layout again, and every
 * other decision the user made is left alone: sizes, order, folded state, and the on/off
 * state of every other card.
 *
 * Why not a general "re-apply the whole layout" like v6? Because v6 had to: the panel SET
 * changed (股市 and 债市 became one card), so the old arrangement described cards that no
 * longer existed. Here the set is the same and only one cell changed hands — a full reset
 * would throw away real decisions to fix one line of them.
 */
function migrateV7(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const fresh = defaultPrefs()
  const layout = { ...stored }
  for (const id of ['github', 'machine']) {
    if (layout[id] === undefined || layout[id] === null) continue
    // `fresh.layout[id]` is read with `?.` because the list above is HISTORICAL: `machine` was
    // a panel when this migration was written and has since been deleted, so on a later build
    // there is no fresh entry to take a default from. Without the guard, opening the HUD with a
    // v7 blob threw `Cannot read properties of undefined` and the whole card failed to render —
    // a migration that crashes on the very users it exists to serve.
    const wanted = fresh.layout[id]?.hidden;
    if (wanted === undefined) continue
    layout[id] = { ...layout[id], hidden: wanted === true }
  }
  return { v: PREFS_VERSION, columns: clampColumns(base.columns), layout }
}

/**
 * v8 → v9: the ARRANGEMENT, not just the two cards that swapped.
 *
 * v8 re-applied `hidden` for GitHub and the machine card and left the order alone, on the
 * grounds that order is the user's decision. That was too conservative in one specific way:
 * the ORDER is the geometry. A stored order of quota < markets < github < sql packs as
 * quota+sql on the left, markets in the middle and GitHub on the right — which is a legal
 * layout, just not the one anybody asked for, and no amount of changing `defaultOn` can
 * move a card whose position comes from a preference written by an older version.
 *
 * So the four cards that MAKE UP the shipped arrangement get their geometry from the layout:
 * order, span, rows and visibility. Everything else is untouched — a fifth card's size, any
 * card's folded state, and every other card's on/off.
 */
function migrateV8(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const fresh = defaultPrefs()
  const layout = { ...stored }
  for (const id of SHIPPED_ARRANGEMENT) {
    const entry = fresh.layout[id]
    if (entry === undefined) continue
    layout[id] = { ...(layout[id] ?? {}), ...entry }
  }
  return { v: PREFS_VERSION, columns: clampColumns(base.columns), layout }
}

/**
 * v9 → v10: the arrangement is now seven rows tall, not six.
 *
 * 股市债市 and 数据库 each go to seven rows so that all three columns end on the same row —
 * the middle column is 用量 (4) + GitHub (3). This is the same migration shape as v9 and for
 * the same reason: the four cards of the shipped arrangement take their geometry from the
 * layout, and a height is part of that geometry. A card OUTSIDE the arrangement keeps
 * whatever height it has.
 */
function migrateV9(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const fresh = defaultPrefs()
  const layout = { ...stored }
  for (const id of SHIPPED_ARRANGEMENT) {
    const entry = fresh.layout[id]
    if (entry === undefined) continue
    layout[id] = { ...(layout[id] ?? {}), ...entry }
  }
  return { v: PREFS_VERSION, columns: clampColumns(base.columns), layout }
}

/**
 * v10 → v11: 快递 joins the middle column, the arrangement becomes 3 × 10, and the
 * 机器 card is gone.
 *
 * Three things change at once, and all three are the same kind of change — the shipped layout.
 *
 *   1. The arrangement is ten rows tall. 股市债市 and 数据库 are full-height columns; the middle
 *      is 用量限额 (4) + 快递 (3) + GitHub (3), and 4 + 3 + 3 = 10 is what makes all three
 *      columns end on the same row.
 *   2. 快递 is now one of those five cards. It used to be off by default, with a pill in the
 *      head row as the way in; a card that is part of the layout cannot also be hidden from it.
 *   3. **机器 is REMOVED, not hidden.** The panel is deleted from the source tree, so a stored
 *      preference for it would be a card the shell knows nothing about — it would sit in the
 *      layout object for ever, invisible and unremovable, and ⚙ would have no row to offer for
 *      it. Deleting the key is the only honest migration for a feature that no longer exists.
 */
function migrateV10(base) {
  const stored = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
  const fresh = defaultPrefs()
  const layout = { ...stored }
  // The card that no longer exists. See (3) above: a layout entry for a deleted panel is not
  // harmless baggage, it is an entry nothing can ever show or clean up.
  delete layout.machine
  for (const id of SHIPPED_ARRANGEMENT) {
    const entry = fresh.layout[id]
    if (entry === undefined) continue
    layout[id] = { ...(layout[id] ?? {}), ...entry }
  }
  return { v: PREFS_VERSION, columns: clampColumns(base.columns), layout }
}

function readPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    // v2 knows nothing about rows, so it is MIGRATED. v3 pinned every card to a
    // fixed 3 rows; v4 drops that value so the content sets the height. v4 stored
    // coordinates; v5 turns them into the explicit order the settings panel edits.
    // Anything else older than the current version is discarded (see PREFS_VERSION).
    if (base.v === 2) return migrateV2(base)
    if (base.v === 3) return migrateV3(base)
    if (base.v === 4) return migrateV4(base)
    if (base.v === 5) return migrateV10(migrateV9(migrateV8(migrateV7(migrateV6(migrateV5(base))))))
    if (base.v === 6) return migrateV10(migrateV9(migrateV8(migrateV7(migrateV6(base)))))
    if (base.v === 7) return migrateV10(migrateV9(migrateV8(migrateV7(base))))
    if (base.v === 8) return migrateV10(migrateV9(migrateV8(base)))
    if (base.v === 9) return migrateV10(migrateV9(base))
    if (base.v === 10) return migrateV10(base)
    if (base.v !== PREFS_VERSION) return defaultPrefs()
    const layout = base.layout && typeof base.layout === 'object' && !Array.isArray(base.layout) ? base.layout : {}
    // ONLY known keys are read. An older build of this HUD stored an `align`
    // (placement) preference, and inheriting it is exactly what kept the card
    // pinned to a 620px centred column after full width became the intent —
    // a stale browser key silently overriding the design. Unknown keys are
    // dropped, never carried forward; `writePrefs` on mount clears them out.
    const height = num(base.hudHeight)
    return {
      v: PREFS_VERSION,
      columns: clampColumns(base.columns),
      layout: { ...layout },
      // Which of the three columns are hidden. Filtered on READ rather than trusted: a stored
      // index outside the grid would hide a column that does not exist, and the cards in it would
      // vanish with no control drawn to bring them back.
      hiddenColumns: Array.isArray(base.hiddenColumns)
        ? base.hiddenColumns.filter((one) => Number.isInteger(one) && one >= 0 && one < MAX_COLUMNS)
        : [],
      // undefined means AUTO. A number is the user's own choice, and only a number.
      ...(height === undefined ? {} : { hudHeight: clamp(height, MIN_HUD_PX, MAX_HUD_PX) }),
    }
  } catch {
    return defaultPrefs()
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* private mode / storage disabled — prefs simply do not persist */
  }
}

// ── the panel registry ─────────────────────────────────────────────────────
/** @type {Array<{ id: string, order: number, span: number, label: any, Component?: Function, head?: Function, __test?: any }>} */
const PANELS = []

/**
 * Register one panel. A bad panel is reported and skipped — it must never be
 * able to take the HUD (or a sibling panel) down with it.
 *
 * A panel needs at least one of `Component` (a card in the grid) or `head` (a
 * widget in the title bar). `span` is only the panel's PREFERENCE for how many
 * grid columns its card takes: the user's stored layout wins, and a span larger
 * than the current column count is clamped at render time.
 */
function registerPanel(panel) {
  const hasCard = typeof panel?.Component === 'function'
  const hasHead = typeof panel?.head === 'function'
  if (!panel || typeof panel.id !== 'string' || panel.id === '' || (!hasCard && !hasHead)) {
    console.error('[hud] registerPanel needs { id, Component } or { id, head }:', panel)
    return
  }
  if (PANELS.some((existing) => existing.id === panel.id)) {
    console.error(`[hud] duplicate panel id "${panel.id}" — ignored`)
    return
  }
  PANELS.push({
    id: panel.id,
    order: num(panel.order) ?? 100,
    span: clampSpan(num(panel.span) ?? DEFAULT_SPAN, MAX_COLUMNS),
    label: panel.label && typeof panel.label === 'object' ? panel.label : { zh: panel.id, en: panel.id },
    Component: hasCard ? panel.Component : undefined,
    head: hasHead ? panel.head : undefined,
    // A head widget asks for a side. `right` puts it beside the ⚙, which is
    // where a "what needs me today" widget belongs; the default keeps the
    // reading-order side for everything else.
    headSide: panel.headSide === 'right' ? 'right' : 'left',
    // Cards that need the row more than this one get to say so.
    defaultOn: panel.defaultOn !== false,
    // A panel may DECLARE how tall it is in the shipped layout. It has to be copied
    // here explicitly: this object is a WHITELIST, so a field that is not listed is
    // silently dropped — which is exactly how the four cards of the default layout came
    // out measured instead of the sizes they asked for.
    defaultRows: num(panel.defaultRows) === undefined ? undefined : clampRows(panel.defaultRows),
    // A CEILING, for a card whose row count would otherwise be decided by rounding: the row
    // unit is 88px, so 280px of content becomes four 78px rows and the difference shows as
    // empty space at the bottom of the card. Listed here explicitly — this object is a
    // whitelist, and a field that is not listed is silently dropped. (That is exactly how
    // `defaultRows` failed the first time.)
    maxRows: num(panel.maxRows) === undefined ? undefined : clampRows(panel.maxRows),
    __test: panel.__test,
  })
  // Cards follow each panel's declared order, never the registration order.
  PANELS.sort((a, b) => a.order - b.order)
}

/** The panel's label in the active locale. */
function labelOf(panel, lang) {
  return lang === 'zh' ? (panel.label.zh ?? panel.id) : (panel.label.en ?? panel.id)
}

// ── tab badges + cross-panel navigation ────────────────────────────────────
const badges = new Map()
const badgeListeners = new Set()

/**
 * Report a count for one panel. Panels call this from an effect; the shell
 * renders nothing when the count is 0, so a panel can report freely.
 */
function setBadge(id, count) {
  const raw = num(count)
  const next = raw === undefined || raw <= 0 ? 0 : Math.floor(raw)
  if ((badges.get(id) ?? 0) === next) return
  badges.set(id, next)
  for (const listener of badgeListeners) {
    try {
      listener()
    } catch (error) {
      console.error('[hud] badge listener failed:', error)
    }
  }
}

function useBadge(id) {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const listener = () => bump((n) => n + 1)
    badgeListeners.add(listener)
    return () => badgeListeners.delete(listener)
  }, [])
  return badges.get(id) ?? 0
}

/** Cross-panel navigation: `hud.showPanel('github')` puts a card back on screen. */
const panelRequests = new Set()

function showPanel(id) {
  for (const listener of panelRequests) {
    try {
      listener(id)
    } catch (error) {
      console.error('[hud] showPanel listener failed:', error)
    }
  }
}

/**
 * Close a popover opened from the title bar on Escape or a click outside it.
 *
 * `containerRef` must wrap BOTH the trigger and the panel, so the click that
 * opens it counts as inside and cannot immediately close it again. Shared
 * because this is the third widget to need it and getting it subtly wrong is
 * invisible until someone is stuck with an open panel.
 *
 * @param {{ current: any }} containerRef
 * @param {boolean} open
 * @param {() => void} close
 */
function useDismiss(containerRef, open, close) {
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    const onDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [containerRef, open, close])
}

/**
 * Set by the shell while it is mounted, so the suite can open the arrangement editor.
 *
 * A TEST HOOK, not a feature. Removing the ⚙ took the only interface route into the editor, and this
 * is how its assertions still run — nothing in the browser calls it.
 */
let openLayoutEditor = null

/** The shared toolkit every panel receives as `hud`. */
const hud = {
  dbg,
  num,
  clamp,
  fetchJson,
  pickLocale,
  startTimers,
  registerPanel,
  panels: PANELS,
  setBadge,
  showPanel,
  useDismiss,
  CandleChart,
  SettingsForm,
  SettingsGear,
  useSettings,
  MAX_COLUMNS,
}

/**
 * ── the card-owned settings UI, shared by every panel that has one ─────────
 *
 * Three cards (machine, services, git) need the same thing: a ⚙ in the card
 * header, a small form inside the card, and a route to persist what it changes.
 * They differ ONLY in which fields they have — so the fields are the argument, and
 * the behaviour (patch one field at a time, show what is in force, offer "back to
 * the settings page") lives here once.
 *
 * ── why a PATCH per interaction, not a whole-object save ────────────────────
 *
 * "Add a disk" writes `{ volumes: [...existing, 'E:'] }`. Sending the whole object
 * would let a render that is one poll out of date overwrite a change made a second
 * earlier in another tab — the classic last-writer-wins bug, in a form where the
 * user cannot even see that a second writer exists.
 */

/**
 * The settings half of a card: read them, patch them, and know whether the settings
 * page is still in charge.
 *
 * @param {string} base the panel's route prefix, e.g. `/dsh-hud/machine`
 * @param {(json: any) => void} [onApplied] called with the response of every write,
 *   so a card can fold the new settings straight back into its own snapshot instead
 *   of waiting for the next poll.
 */
function useSettings(base, onApplied) {
  const [state, setState] = React.useState({ loading: false, busy: false, error: null })
  const aliveRef = React.useRef(true)
  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const post = React.useCallback(async (body) => {
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      const json = await fetchJson(`${base}/settings`, { method: 'POST', body: JSON.stringify(body) })
      if (!aliveRef.current) return null
      if (json?.ok === false) {
        setState((current) => ({ ...current, busy: false, error: json.error ?? '保存失败' }))
        return null
      }
      setState((current) => ({ ...current, busy: false, error: null }))
      // The callback runs on EVERY write, including a reset: the card's snapshot
      // has to reflect what is actually stored either way.
      if (typeof onApplied === 'function') onApplied(json)
      return json
    } catch (failure) {
      if (aliveRef.current) {
        setState((current) => ({ ...current, busy: false, error: failure instanceof Error ? failure.message : String(failure) }))
      }
      return null
    }
  }, [base, onApplied])

  /** Write a patch. `patch` is one field, not the whole object. */
  const patch = React.useCallback((fields) => post({ settings: fields }), [post])
  /** Drop the stored override and go back to what the settings page says. */
  const reset = React.useCallback(() => post({ reset: true }), [post])
  /** Ask the host something that is not a write — "which drives exist?" */
  const ask = React.useCallback(async (path, body) => {
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      const json = await fetchJson(`${base}/${path}`, body === undefined
        ? undefined
        : { method: 'POST', body: JSON.stringify(body) })
      if (aliveRef.current) setState((current) => ({ ...current, busy: false }))
      return json
    } catch (failure) {
      if (aliveRef.current) {
        setState((current) => ({ ...current, busy: false, error: failure instanceof Error ? failure.message : String(failure) }))
      }
      return null
    }
  }, [base])

  return { ...state, patch, reset, ask }
}

/**
 * The ⚙ that opens a card's settings.
 *
 * A plain button so it can live anywhere in a header row; `aria-expanded` is set
 * because the thing it controls is inside the same card.
 */
function SettingsGear({ open, onToggle, label, zh }) {
  return jsx('button', {
    type: 'button',
    className: `hud-sgear${open ? ' is-on' : ''}`,
    'aria-expanded': open ? 'true' : 'false',
    'aria-label': label ?? (zh ? '设置' : 'Settings'),
    title: label ?? (zh ? '设置' : 'Settings'),
    onClick: onToggle,
    children: '⚙',
  })
}

/**
 * A declarative settings form.
 *
 * `fields` is a list of descriptors, one per setting:
 *
 *   { kind: 'list',   key, label, hint, placeholder, values, detect }
 *   { kind: 'number', key, label, hint, min, max, step, unit }
 *   { kind: 'text',   key, label, hint, placeholder }
 *   { kind: 'toggle', key, label, hint }
 *
 * `list` renders as add/remove rows; `detect` (optional) is an async function
 * returning candidate values with an optional label, which is how the machine card
 * offers "the drives this machine actually has" instead of asking the user to type
 * `C:` from memory.
 */
function SettingsForm(props) {
  const { open, fields, settings, busy, error, note, zh, onPatch, onReset, onAsk } = props
  const [drafts, setDrafts] = React.useState({})
  const [options, setOptions] = React.useState({})
  const [detecting, setDetecting] = React.useState('')
  /** Why the last entry was refused — a bad value must not vanish silently. */
  const [rejected, setRejected] = React.useState(null)

  if (open !== true) return null
  const current = settings ?? {}

  const draftOf = (key) => drafts[key] ?? ''
  const setDraft = (key, value) => setDrafts((all) => ({ ...all, [key]: value }))
  /** One field, written on its own. */
  const write = (key, value) => {
    if (typeof onPatch === 'function') onPatch({ [key]: value })
  }

  const rows = fields.map((field) => {
    const value = current[field.key]
    if (field.kind === 'list') {
      const values = Array.isArray(value) ? value : []
      const candidates = options[field.key] ?? []
      /**
       * Add one entry, through the field's own coercion.
       *
       * The coercion lives on the FIELD, because only the field knows what its
       * values are: a port is a number on the host, and storing the string "11434"
       * would be dropped by the host's validator with nothing said. A rejected entry
       * is reported beside the input rather than disappearing.
       */
      const add = (raw) => {
        const text = String(raw).trim()
        if (text === '') return
        const coerced = typeof field.coerce === 'function' ? field.coerce(text) : text
        if (coerced === undefined || coerced === null) {
          setRejected(`${text} ${zh ? '不是有效值' : 'is not a valid value'}`)
          return
        }
        if (values.some((entry) => String(entry) === String(coerced))) return
        setRejected(null)
        write(field.key, [...values, coerced])
        setDraft(field.key, '')
      }
      return jsxs('div', { className: 'hud-sfield', 'data-field': field.key, children: [
        jsx('span', { className: 'hud-slabel', children: field.label }),
        values.length === 0
          ? jsx('span', { className: 'hud-shint', children: zh ? '（空：面板会用默认值）' : '(empty: the panel uses its defaults)' })
          : null,
        ...values.map((entry) => jsxs('div', { className: 'hud-srow', children: [
          jsx('span', {
            className: 'hud-svalue',
            title: String(entry),
            // `format` lets a field DISPLAY more than it stores — a mount shown with
            // its free space, for instance — without changing what is written.
            children: typeof field.format === 'function' ? field.format(entry) : String(entry),
          }),
          jsx('button', {
            type: 'button',
            className: 'hud-sx',
            disabled: busy,
            'aria-label': zh ? `移除 ${entry}` : `Remove ${entry}`,
            onClick: () => write(field.key, values.filter((item) => item !== entry)),
            children: '×',
          }),
        ] }, `${field.key}-${entry}`)),
        jsxs('div', { className: 'hud-sadd', children: [
          jsx('input', {
            className: 'hud-sinput',
            value: draftOf(field.key),
            placeholder: field.placeholder ?? '',
            onChange: (event) => setDraft(field.key, event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') add(draftOf(field.key))
            },
          }),
          jsx('button', {
            type: 'button',
            className: 'hud-sbtn',
            disabled: busy || draftOf(field.key).trim() === '',
            onClick: () => add(draftOf(field.key)),
            // Named in Chinese because the card is: a bare "+" would be ambiguous
            // next to the ✕ that removes.
            children: zh ? '添加' : 'Add',
          }),
          typeof field.detect === 'function'
            ? jsx('button', {
                type: 'button',
                className: 'hud-sbtn is-ghost',
                disabled: busy || detecting === field.key,
                title: field.detectHint ?? (zh ? '让宿主列出可选项' : 'Ask the host what exists'),
                onClick: async () => {
                  setDetecting(field.key)
                  const found = await onAsk(field.detectPath ?? field.key)
                  setDetecting('')
                  const list = Array.isArray(found) ? found : []
                  setOptions((all) => ({ ...all, [field.key]: list }))
                  // Nothing found is a FACT worth stating: the alternative is a
                  // button that appears to do nothing.
                  if (list.length === 0) setRejected(zh ? '宿主没有列出任何可选项' : 'the host listed nothing')
                },
                children: detecting === field.key ? (zh ? '检测中…' : 'detecting…') : (zh ? '检测' : 'Detect'),
              })
            : null,
        ] }),
        candidates.length > 0
          ? jsxs('div', { className: 'hud-sopts', children: [
              jsx('span', { className: 'hud-shint', children: zh ? '可添加：' : 'available:' }),
              ...candidates.map((candidate) => {
                const key = typeof candidate === 'string' ? candidate : candidate.value
                const text = typeof candidate === 'string' ? candidate : (candidate.label ?? candidate.value)
                const already = values.some((entry) => String(entry) === String(key))
                return jsx('button', {
                  type: 'button',
                  className: `hud-sopt${already ? ' is-on' : ''}`,
                  disabled: busy || already,
                  title: already ? (zh ? '已添加' : 'already added') : (zh ? '添加' : 'add'),
                  onClick: () => add(key),
                  children: text,
                }, `${field.key}-opt-${key}`)
              }),
            ] })
          : null,
        rejected === null ? null : jsx('span', { className: 'hud-serr', role: 'alert', children: rejected }),
        field.hint ? jsx('span', { className: 'hud-shint', children: field.hint }) : null,
      ] }, field.key)
    }
    if (field.kind === 'number') {
      return jsxs('div', { className: 'hud-sfield', 'data-field': field.key, children: [
        jsx('span', { className: 'hud-slabel', children: field.label }),
        jsxs('span', { className: 'hud-snum', children: [
          jsx('input', {
            className: 'hud-sinput is-num',
            type: 'number',
            value: num(value) === undefined ? '' : String(value),
            min: field.min,
            max: field.max,
            step: field.step ?? 1,
            disabled: busy,
            onChange: (event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) write(field.key, next)
            },
          }),
          field.unit ? jsx('span', { className: 'hud-shint', children: field.unit }) : null,
        ] }),
        field.hint ? jsx('span', { className: 'hud-shint', children: field.hint }) : null,
      ] }, field.key)
    }
    if (field.kind === 'toggle') {
      return jsxs('div', { className: 'hud-sfield is-inline', 'data-field': field.key, children: [
        jsxs('label', { className: 'hud-slabel', children: [
          jsx('input', {
            type: 'checkbox',
            checked: value === true,
            disabled: busy,
            onChange: (event) => write(field.key, event.target.checked),
          }),
          jsx('span', { children: field.label }),
        ] }),
        field.hint ? jsx('span', { className: 'hud-shint', children: field.hint }) : null,
      ] }, field.key)
    }
    // text
    return jsxs('div', { className: 'hud-sfield', 'data-field': field.key, children: [
      jsx('span', { className: 'hud-slabel', children: field.label }),
      jsx('input', {
        className: 'hud-sinput',
        value: typeof value === 'string' ? value : '',
        placeholder: field.placeholder ?? '',
        disabled: busy,
        onChange: (event) => write(field.key, event.target.value),
      }),
      field.hint ? jsx('span', { className: 'hud-shint', children: field.hint }) : null,
    ] }, field.key)
  })

  return jsxs('div', { className: 'hud-sform', children: [
    note ? jsx('span', { className: 'hud-shint', children: note }) : null,
    ...rows,
    error ? jsx('span', { className: 'hud-serr', role: 'alert', children: error }) : null,
    jsx('button', {
      type: 'button',
      className: 'hud-sbtn is-ghost is-reset',
      disabled: busy,
      title: zh ? '放弃卡片里的设置，回到插件设置页里的值' : 'Drop the card settings and use the settings page again',
      onClick: () => {
        if (typeof onReset === 'function') onReset()
      },
      children: zh ? '恢复为设置页的值' : 'Use the settings page',
    }),
  ] })
}

// ── the shared candlestick chart ───────────────────────────────────────────
/** 红涨绿跌 — the domestic convention, and a prop so a panel can differ. */
const K_UP = '#d0503f'
const K_DOWN = '#1f9463'
const K_MA = [
  { period: 5, color: '#d9a13b' },
  { period: 10, color: '#4f7fe0' },
  { period: 20, color: '#a05fd0' },
]

/** Moving average of closes; `null` until the window is full. */
function movingAverage(candles, period) {
  const out = []
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close
    if (i >= period) sum -= candles[i - period].close
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

/** `2026-09-30 09:31` → `09:31`; a plain date is returned unchanged. */
function shortStamp(value) {
  const text = String(value ?? '')
  const space = text.indexOf(' ')
  return space === -1 ? text : text.slice(space + 1)
}

/**
 * A candlestick chart with moving averages, a volume strip and a hover readout.
 *
 * Hand-written SVG: the platform module table carries only `react`, and a
 * charting library is not going to be added for this. Three details make it read
 * like a real terminal chart rather than a sketch:
 *
 *   - candle BODIES are fills and every STROKE carries
 *     `vector-effect="non-scaling-stroke"`. The SVG stretches to the card width
 *     (`preserveAspectRatio="none"`), which distorts anything stroked; fills
 *     stretch as a unit and stay correct.
 *   - all TEXT lives in HTML positioned by percentage, outside the SVG, so
 *     labels never inherit the stretch.
 *   - the volume strip disappears when every candle has zero volume, which is
 *     the case for a YIELD series — a yield has no traded size, and an empty
 *     strip would be decoration pretending to be data.
 *
 * Shared on purpose: the share panel and the bond panel both draw K-lines, and
 * two copies of this would drift apart.
 */
function CandleChart(props) {
  const lang = props.lang
  const zh = lang === 'zh'
  const [hover, setHover] = React.useState(null)
  const candles = (Array.isArray(props.candles) ? props.candles : [])
    .filter((candle) => candle && [candle.open, candle.close, candle.high, candle.low].every((value) => typeof value === 'number' && Number.isFinite(value)))
  const n = candles.length
  const decimals = num(props.decimals) ?? 2
  const fmt = (value) => (typeof props.format === 'function' ? props.format(value) : value.toFixed(decimals))

  if (n === 0) {
    return jsx('div', { className: 'hud-k-empty', children: props.empty ?? (zh ? '没有拿到 K 线数据' : 'no candles') })
  }

  const W = 720
  const showVolume = candles.some((candle) => (num(candle.volume) ?? 0) > 0)
  const H = num(props.height) ?? (showVolume ? 200 : 150)
  const TOP = 6
  const VOL_H = showVolume ? 34 : 0
  const VOL_GAP = showVolume ? 8 : 0
  const PLOT_H = H - TOP - 18 - VOL_H - VOL_GAP
  const VOL_TOP = TOP + PLOT_H + VOL_GAP
  const series = K_MA.map((entry) => ({ ...entry, values: movingAverage(candles, entry.period) }))

  let hi = -Infinity
  let lo = Infinity
  for (const candle of candles) {
    if (candle.high > hi) hi = candle.high
    if (candle.low < lo) lo = candle.low
  }
  for (const entry of series) {
    for (const value of entry.values) {
      if (value === null) continue
      if (value > hi) hi = value
      if (value < lo) lo = value
    }
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === lo) {
    hi = (Number.isFinite(hi) ? hi : 1) + 1
    lo = (Number.isFinite(lo) ? lo : 0) - 1
  }
  const headroom = (hi - lo) * 0.06
  hi += headroom
  lo -= headroom

  const slot = W / n
  const bodyW = Math.max(1.2, slot * 0.62)
  const xAt = (index) => (index + 0.5) * slot
  const yAt = (value) => TOP + ((hi - value) / (hi - lo)) * PLOT_H
  let maxVolume = 0
  for (const candle of candles) if ((num(candle.volume) ?? 0) > maxVolume) maxVolume = candle.volume
  const yVol = (value) => VOL_TOP + VOL_H - ((num(value) ?? 0) / (maxVolume || 1)) * VOL_H

  const hovered = hover === null ? null : candles[hover]
  /**
   * The readout's numbers, and they are the ones a terminal shows:
   *
   *   change    against the PREVIOUS CLOSE, not against the candle's own open.
   *             `(close - open) / open` is the candle's body, which is a
   *             different (and non-standard) number; 涨跌幅 means "versus the
   *             last close". The first candle has no predecessor, so it falls
   *             back to its own open rather than printing nothing.
   *   amplitude (high - low) / previous close — 振幅.
   */
  const prevClose = hover === null || hover === 0 ? undefined : num(candles[hover - 1]?.close)
  const base = prevClose ?? num(hovered?.open)
  const hoveredChange = hovered && base ? hovered.close - base : undefined
  const hoveredPct = hoveredChange !== undefined && base ? (hoveredChange / base) * 100 : undefined
  const hoveredAmp = hovered && base ? ((hovered.high - hovered.low) / base) * 100 : undefined
  const unit = props.unit ? ` ${props.unit}` : ''
  /** Money, in the units a Chinese terminal uses. */
  const money = (value) => {
    const amount = num(value)
    if (amount === undefined) return '--'
    if (amount >= 1e8) return `${(amount / 1e8).toFixed(2)} 亿`
    if (amount >= 1e4) return `${(amount / 1e4).toFixed(1)} 万`
    return String(Math.round(amount))
  }
  // Fewer, wider candles deserve more axis labels: a month of daily bars can
  // afford five stamps, a year of them cannot. Deduped, because on a very short
  // series two fractions can round to the same candle (and a repeated label
  // looks like a rendering bug).
  const xStops = n <= 40 ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1]
  const xIndexes = [...new Set(xStops.map((fraction) => Math.min(n - 1, Math.max(0, Math.round((n - 1) * fraction)))))]

  return jsxs('div', { className: 'hud-k', children: [
    jsxs('div', { className: 'hud-k-head', children: [
      jsx('span', { className: 'hud-k-legend', children: series.map((entry) => {
        const last = [...entry.values].reverse().find((value) => value !== null)
        return jsxs('span', { className: 'hud-k-lg', children: [
          jsx('span', { className: 'hud-k-dot', style: { background: entry.color } }),
          jsx('span', { children: `MA${entry.period}` }),
          jsx('span', { style: { color: 'var(--dsw-alias-label-primary,#0f1115)' }, children: last === undefined ? '--' : fmt(last) }),
        ] }, entry.period)
      }) }),
      Array.isArray(props.periods) && props.periods.length > 0
        ? jsx('span', { className: 'hud-k-periods', children: props.periods.map((option) => jsx('button', {
            type: 'button',
            className: 'hud-k-btn',
            'aria-pressed': props.period === option.value ? 'true' : 'false',
            onClick: () => props.onPeriod?.(option.value),
            children: zh ? option.label : (option.labelEn ?? option.label),
          }, option.value)) })
        : null,
    ] }),
    jsxs('div', { className: 'hud-k-canvas', children: [
      jsxs('svg', {
        className: 'hud-k-svg',
        viewBox: `0 0 ${W} ${H}`,
        // The height is the DESIGN height, not the width times the ratio: the SVG stretches
        // horizontally (that is what preserveAspectRatio="none" is for) and keeps its height,
        // so the card's height does not depend on how wide the window is.
        style: { height: `${H}px` },
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': props.ariaLabel ?? (zh ? 'K 线图' : 'candlestick chart'),
        onMouseLeave: () => setHover(null),
        children: [
          ...[0, 0.25, 0.5, 0.75, 1].map((fraction) => jsx('line', {
            x1: 0, x2: W, y1: TOP + PLOT_H * fraction, y2: TOP + PLOT_H * fraction,
            stroke: 'var(--dsw-alias-border-l1,rgba(0,0,0,.07))',
            strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke',
          }, `g${fraction}`)),
          showVolume
            ? jsx('line', {
                x1: 0, x2: W, y1: VOL_TOP + VOL_H, y2: VOL_TOP + VOL_H,
                stroke: 'var(--dsw-alias-border-l2,rgba(0,0,0,.14))',
                strokeWidth: 1,
                vectorEffect: 'non-scaling-stroke',
              }, 'vbase')
            : null,
          ...candles.map((candle, index) => {
            const up = candle.close >= candle.open
            const color = up ? (props.upColor ?? K_UP) : (props.downColor ?? K_DOWN)
            const yOpen = yAt(candle.open)
            const yClose = yAt(candle.close)
            const bodyTop = Math.min(yOpen, yClose)
            const bodyH = Math.max(1, Math.abs(yClose - yOpen))
            const volTop = showVolume ? yVol(candle.volume) : 0
            return jsxs('g', { children: [
              jsx('line', {
                x1: xAt(index), x2: xAt(index), y1: yAt(candle.high), y2: yAt(candle.low),
                stroke: color, strokeWidth: 1, vectorEffect: 'non-scaling-stroke',
              }),
              jsx('rect', { x: xAt(index) - bodyW / 2, y: bodyTop, width: bodyW, height: bodyH, fill: color }),
              showVolume
                ? jsx('rect', {
                    x: xAt(index) - bodyW / 2, y: volTop, width: bodyW,
                    height: Math.max(0.5, VOL_TOP + VOL_H - volTop), fill: color, opacity: 0.38,
                  })
                : null,
            ] }, `${candle.date}-${index}`)
          }),
          ...series.map((entry) => {
            const points = entry.values
              .map((value, index) => (value === null ? null : `${xAt(index).toFixed(2)},${yAt(value).toFixed(2)}`))
              .filter(Boolean)
              .join(' ')
            if (points === '') return null
            return jsx('polyline', {
              points, fill: 'none', stroke: entry.color, strokeWidth: 1,
              strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke',
            }, `ma${entry.period}`)
          }),
          hovered
            ? jsx('line', {
                x1: xAt(hover), x2: xAt(hover), y1: TOP, y2: TOP + PLOT_H,
                stroke: 'var(--dsw-alias-label-caption,#81858c)', strokeWidth: 1,
                strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke',
              }, 'guide')
            : null,
          ...candles.map((candle, index) => jsx('rect', {
            x: xAt(index) - slot / 2, y: 0, width: slot, height: H, fill: 'transparent',
            onMouseEnter: () => setHover(index),
          }, `hit${index}`)),
        ],
      }),
      ...[0, 0.5, 1].map((fraction) => jsx('span', {
        className: 'hud-k-ylab',
        style: { top: `${((TOP + PLOT_H * fraction) / H) * 100}%` },
        children: fmt(hi - (hi - lo) * fraction),
      }, `y${fraction}`)),
      // Intraday candles carry `2026-09-30 09:31`; on an axis the TIME is the
      // interesting half (the date is already in the card's header), so an
      // intraday stamp is shortened to `09:31`.
      ...xIndexes.map((index, position) => jsx('span', {
        className: 'hud-k-xlab',
        // Spread positions evenly across the axis rather than using the candle's
        // own x: the first and last labels would otherwise be clipped by the
        // half-label overhang on each side.
        style: { left: xIndexes.length === 1 ? '50%' : `${3 + (position / (xIndexes.length - 1)) * 94}%` },
        children: shortStamp(candles[index].date),
      }, `x${index}`)),
      hovered
        ? jsxs('div', {
            className: 'hud-k-tip',
            style: { left: `${Math.min(78, Math.max(22, ((hover + 0.5) / n) * 100))}%` },
            children: [
              // The stamp as a header, then a 2×2 grid of the four prices, then
              // the derived numbers on their own row. The first version ran them
              // all together on one line, which is unreadable precisely when you
              // are moving the mouse and need to read it fast.
              jsx('span', { className: 'hud-k-tip-head', children: hovered.date }),
              jsxs('span', { className: 'hud-k-tip-grid', children: [
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: zh ? '开' : 'O' }),
                  jsxs('b', { children: [fmt(hovered.open), unit] }),
                ] }),
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: zh ? '高' : 'H' }),
                  jsxs('b', { children: [fmt(hovered.high), unit] }),
                ] }),
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: zh ? '低' : 'L' }),
                  jsxs('b', { children: [fmt(hovered.low), unit] }),
                ] }),
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: zh ? '收' : 'C' }),
                  jsxs('b', { children: [fmt(hovered.close), unit] }),
                ] }),
              ] }),
              jsxs('span', { className: 'hud-k-tip-foot', children: [
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: zh ? '涨跌' : 'chg' }),
                  jsx('b', {
                    className: (num(hoveredPct) ?? 0) === 0 ? '' : hoveredPct > 0 ? 'hud-k-up' : 'hud-k-down',
                    children: num(hoveredPct) === undefined ? '--' : `${hoveredPct > 0 ? '+' : ''}${hoveredPct.toFixed(2)}%`,
                  }),
                  jsx('b', {
                    className: (num(hoveredChange) ?? 0) === 0 ? '' : hoveredChange > 0 ? 'hud-k-up' : 'hud-k-down',
                    children: num(hoveredChange) === undefined ? '' : `${hoveredChange > 0 ? '+' : ''}${fmt(hoveredChange)}`,
                  }),
                ] }),
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: zh ? '振幅' : 'amp' }),
                  jsx('b', { children: num(hoveredAmp) === undefined ? '--' : `${hoveredAmp.toFixed(2)}%` }),
                ] }),
              ] }),
              jsxs('span', { className: 'hud-k-tip-foot', children: [
                showVolume
                  ? jsxs('span', { className: 'hud-k-kv', children: [
                      jsx('i', { children: zh ? '量' : 'vol' }),
                      jsx('b', { children: num(hovered.volume) === undefined ? '--' : `${(hovered.volume / 10_000).toFixed(1)} 万` }),
                    ] })
                  : null,
                num(hovered.amount) === undefined
                  ? null
                  : jsxs('span', { className: 'hud-k-kv', children: [
                      jsx('i', { children: zh ? '额' : 'amt' }),
                      jsx('b', { children: money(hovered.amount) }),
                    ] }),
                jsxs('span', { className: 'hud-k-kv', children: [
                  jsx('i', { children: 'MA5' }),
                  jsx('b', { children: num(series[0]?.values?.[hover]) === undefined || series[0].values[hover] === null ? '--' : fmt(series[0].values[hover]) }),
                ] }),
              ] }),
            ],
          })
        : null,
    ] }),
  ] })
}

// ── styles ─────────────────────────────────────────────────────────────────
const CSS_ID = 'dsh-hud/shell.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-hud'
  tag.dataset.pluginCss = CSS_ID
  tag.textContent = [
    // ── the shell: TRANSPARENT, deliberately ───────────────────────────────
    // The HUD no longer paints a box of its own. It sits directly on whatever is
    // behind it, and the CARDS are the surfaces you see — so the widget reads as
    // part of the app instead of a panel bolted onto it. Everything that OPENS
    // (a weather detail, a chart tooltip, the ⚙ editor) does the opposite and is
    // opaque, because a popover you have to read through is just broken.
    //
    // Per-HUD design tokens live here, once, so a new panel inherits the same
    // radius, surface and hairline instead of inventing its own.
    // `--hud-pop` is the surface for anything that FLOATS (the editor, a chart
    // tooltip, the weather detail). It is the same clean raised-surface token the
    // cards use — NOT the theme's `bg-overlay`, which is a scrim: compositing a
    // scrim onto a surface is what made the editor look muddy grey in both
    // themes. Depth comes from the border and the shadow instead.
    `.hud-root{--hud-radius:12px;--hud-tile:var(--dsw-alias-bg-layer-1,#ffffff);--hud-pop:var(--dsw-alias-bg-layer-1,#ffffff);--hud-line:var(--dsw-alias-border-l1,rgba(0,0,0,.08));--hud-line-2:var(--dsw-alias-border-l2,rgba(0,0,0,.14));--hud-shadow:0 1px 2px rgba(15,17,21,.04),0 10px 26px -22px rgba(15,17,21,.38);position:sticky;top:0;z-index:1000;display:block;box-sizing:border-box;width:100%;padding:2px ${HUD_GUTTER_PX}px 8px;font-family:inherit;color:var(--dsw-alias-label-primary,#0f1115)}`,
    '.hud-card{box-sizing:border-box;width:100%;max-width:none;display:flex;flex-direction:column;gap:7px;padding:2px 0 0;border:0;background:transparent;box-shadow:none}',
    // ── head row: brand · hidden-panel pills · gear ────────────────────────
    // `position:relative;z-index` on the head row is what makes a POPOVER opened
    // from a head widget (the weather detail) paint ABOVE the cards. Without it
    // the head row is a static box that comes first in DOM order, and a popover
    // inside it competes with the grid on equal footing — which is how the
    // weather detail ended up being overlapped by the quota card.
    //
    // The number matters as much as the property, and 5 was NOT enough: a card
    // HEADER is also `z-index:5` (see the shared header rule below), and a TIE is
    // broken by DOM order — the head row comes first, so every card header painted
    // over anything opened from it. That is exactly what the user saw: the market
    // card's header (股市 · 14:31:44 · ＋ 添加标的 · 刷新) read straight through the
    // open weather detail, while the same card's BODY stayed behind it. So this is
    // the HUD's top CHROME tier, and it must stay strictly above the card headers'.
    //
    // The row keeps a faint scrim and a blur: with the shell now transparent,
    // the transcript scrolls directly behind these controls, and a title row you
    // cannot read while scrolling is worse than a hairline.
    '.hud-head{position:relative;z-index:20;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;padding:4px 2px 5px;margin-bottom:1px;border-bottom:1px solid var(--hud-line);background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03));background:linear-gradient(to bottom,color-mix(in srgb,var(--hud-tile) 62%,transparent),color-mix(in srgb,var(--hud-tile) 26%,transparent));backdrop-filter:blur(8px) saturate(1.15);border-radius:8px 8px 0 0}',
    '.hud-brand{flex:none;padding:0 2px;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
    // Title-bar widgets contributed by panels (`head`). They sit between the
    // brand and the hidden-panel pills and never consume a grid column.
    '.hud-heads{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}',
    // One slot per head widget, so a switched-off widget stays MOUNTED (hidden)
    // exactly like a switched-off card.
    '.hud-head-slot{display:inline-flex;align-items:center;min-width:0}',
    '.hud-head-slot[hidden]{display:none}',
    '.hud-where{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
    '.hud-right{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none}',
    '.hud-cols{display:inline-flex;align-items:center;gap:3px;flex:none}',
  '.hud-cols-label{font-size:9.5px;letter-spacing:.08em;color:var(--dsw-alias-label-caption,#81858c);margin-right:2px}',
  '.hud-col{width:19px;height:19px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--hud-line-1);border-radius:5px;background:transparent;font-family:inherit;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
  '.hud-col:hover{border-color:var(--hud-line-2);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
  '.hud-col.is-off{opacity:.42;text-decoration:line-through}',
  // The last one is disabled rather than hidden: a control that vanishes when it becomes
  // unavailable is a control nobody can learn.
  '.hud-col:disabled{cursor:default;opacity:.62}',
  '.hud-gear{width:20px;height:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}',
    '.hud-gear:hover{border-color:var(--hud-line-2);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-gear[aria-expanded="true"]{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
    // A switched-off panel is still reachable: a small pill in the head row,
    // carrying its badge, one click from coming back.
    '.hud-pills{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
    '.hud-pills-label{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
    '.hud-pill{display:inline-flex;align-items:center;gap:5px;padding:0 9px;border:1px solid var(--hud-line);border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03));background:color-mix(in srgb,var(--hud-tile) 72%,transparent);font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease}',
    '.hud-pill:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
    '.hud-pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
    '.hud-count{font-style:normal;padding:0 5px;border-radius:999px;background:rgba(57,100,254,.14);font-size:10px;line-height:14px;color:var(--dsw-alias-state-business-primary,#3964fe);font-variant-numeric:tabular-nums}',
    // ── shell preferences + layout editor ──────────────────────────────────
    // A POPOVER, not a block: anchored under the head row, right-aligned to the
    // ⚙ that opens it, opaque, and height-capped with its own scroll. Opening it
    // must not change the HUD's height — that is what used to push the ⚙ off the
    // top of a tall HUD and leave no way to close the thing.
    '.hud-prefs{position:absolute;top:calc(100% + 6px);right:0;z-index:8;width:min(540px,calc(100vw - 28px));max-height:min(62vh,440px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;display:flex;flex-direction:column;gap:9px;padding:0 12px 11px;border:1px solid var(--hud-line-2);border-radius:12px;background:var(--hud-pop);box-shadow:0 3px 10px rgba(15,17,21,.07),0 24px 52px -28px rgba(15,17,21,.5);font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
    // The header band sticks to the top of the scroll box, so the budget and the
    // close button stay reachable however long the list gets.
    '.hud-prefs-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;margin:0 -12px;padding:9px 12px 8px;border-bottom:1px solid var(--hud-line);border-radius:12px 12px 0 0;background:var(--hud-pop)}',
    '.hud-prefs-title{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.hud-prefs-close{margin-left:auto;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--hud-line);border-radius:999px;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}',
    '.hud-prefs-close:hover{border-color:var(--hud-line-2);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
    // The budget sits next to the title, not pushed to the far edge: it belongs
    // to the header, and `margin-left:auto` is the close button's job now.
    '.hud-prefs .hud-budget{margin-left:0}',
    '.hud-prefs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.hud-prefs-label{min-width:52px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
    // The footnote in here is explanatory text, not fine print.
    '.hud-prefs .hud-note{color:var(--dsw-alias-label-secondary,#61666b)}',
    '.hud-seg{display:inline-flex;border:1px solid var(--hud-line);border-radius:999px;overflow:hidden}',
    '.hud-seg button{padding:0 9px;border:0;background:transparent;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
    '.hud-seg button+button{border-left:1px solid var(--hud-line)}',
    '.hud-seg button[aria-pressed="true"]{background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
    '.hud-seg button:disabled{opacity:.35;cursor:default}',
    // The size segment and the two arrows: the arrangement, edited in words.
    '.hud-sizes button{min-width:22px}',
    '.hud-move button{min-width:20px;padding:0 5px;font-size:12px;line-height:1}',
    '.hud-move button:disabled{opacity:.25}',
    // A row of the editor can now hold four controls; let them wrap instead of
    // pushing the label off the edge on a narrow dock.
    '.hud-layout-ctl{flex-wrap:wrap;justify-content:flex-end;row-gap:4px}',
    // Two columns when the width allows: five panels in a single column is a
    // long thin list that reads like a form.
    '.hud-layout{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:2px 16px;padding-top:9px;border-top:1px solid var(--hud-line)}',
    '.hud-layout-row{display:flex;align-items:center;gap:8px;padding:1px 0}',
    '.hud-vis{flex:1 1 auto;display:inline-flex;align-items:center;gap:6px;min-width:0;padding:0 8px;border:1px solid var(--hud-line);border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease}',
    '.hud-vis:hover{border-color:var(--hud-line-2);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
    '.hud-vis.is-on{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-vis>span:first-child{font-size:9px;line-height:1;color:var(--dsw-alias-state-idle-primary,#b6bac1)}',
    '.hud-vis.is-on>span:first-child{color:var(--dsw-alias-state-business-primary,#3964fe)}',
    // A control that would overflow the single row, or a card whose span would:
    // the SPAN button is what refuses, dashed and struck through, rather than the
    // whole row wearing a red outline — the row is still a perfectly good row.
    '.hud-vis.is-blocked{border-style:dashed;border-color:var(--hud-line-2);color:var(--dsw-alias-label-caption,#81858c)}',
    // The fold control sits with the span control: both answer "how much of the
    // row does this card cost".
    '.hud-layout-ctl{display:inline-flex;align-items:center;gap:5px;flex:none}',
    '.hud-fold{padding:0 7px;border:1px solid var(--hud-line);border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer}',
    '.hud-fold:hover{border-color:var(--hud-line-2);color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-fold.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
    '.hud-pill.is-blocked{border-style:dashed;border-color:var(--dsw-alias-state-error-primary,#dc2626);opacity:.72}',
    '.hud-seg button.is-blocked{color:var(--dsw-alias-label-caption,#81858c);text-decoration:line-through}',
    // The budget: how much of the row is spent, and whether anything can be added.
    '.hud-budget{margin-left:auto;padding:0 8px;border-radius:999px;border:1px solid var(--hud-line);font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.hud-budget.is-full{border-color:rgba(245,158,11,.45);color:var(--dsw-alias-state-warn-primary,#b45309);background:rgba(245,158,11,.12)}',
    '.hud-error{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#dc2626);word-break:break-word}',
    // ── the shared candlestick chart ───────────────────────────────────────
    // Lives in the shell because MORE THAN ONE panel draws K-lines (share
    // prices AND bond instruments), and a chart duplicated per panel is a chart
    // that drifts per panel. Class names are `hud-k-*` so they cannot collide
    // with a panel's own sheet.
    '.hud-k{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.hud-k-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.hud-k-legend{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.hud-k-lg{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}',
    '.hud-k-dot{width:7px;height:2px;border-radius:1px}',
    '.hud-k-periods{display:inline-flex;gap:5px;margin-left:auto}',
    '.hud-k-btn{padding:0 7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
    '.hud-k-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
    '.hud-k-btn[aria-pressed="true"]{background:rgba(57,100,254,.10);border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
    '.hud-k-canvas{position:relative;width:100%}',
    '.hud-k-svg{display:block;width:100%}',
    // ── the resize handle ────────────────────────────────────────────────────
    //
    // Six pixels of hoverable edge with a 2px grip line in the middle: enough to hit
    // without aiming, thin enough that it does not read as chrome. It is transparent until
    // you touch it, because a permanent bar across the HUD is noise on every screenshot.
    '.hud-resize{position:relative;flex:none;height:8px;margin-top:2px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;touch-action:none;border-radius:0 0 8px 8px}',
    '.hud-resize-grip{width:56px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));transition:background .12s ease,width .12s ease}',
    '.hud-resize:hover .hud-resize-grip,.hud-resize:focus-visible .hud-resize-grip{width:96px;background:var(--dsw-alias-brand-primary,#4d6bfe)}',
    '.hud-resize:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}',
    // The label names the state (自动高度 / 1234px) and stays out of the way until asked.
    '.hud-resize-label{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:10.5px;line-height:1;padding:1px 5px;border-radius:5px;opacity:0;pointer-events:none;transition:opacity .12s ease;background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.06));color:var(--dsw-alias-text-2,rgba(38,49,72,.62))}',
    '.hud-resize:hover .hud-resize-label,.hud-resize:focus-visible .hud-resize-label{opacity:1}',
    // A manual height is worth showing without hovering: it is a state you can forget you
    // are in, and then wonder why the window stops mattering.
    '.hud-resize[data-mode="manual"] .hud-resize-grip{width:96px;background:var(--dsw-alias-brand-primary,#4d6bfe)}',
    '.hud-resize[data-mode="manual"] .hud-resize-label{opacity:.75}',
    // ── floating surfaces: OPAQUE, always ──────────────────────────────────
    // `--dsw-alias-bg-overlay` is the documented "overlay and popover" token, but
    // it is NOT reliably opaque — in a design system an "overlay" is often the
    // translucent scrim that sits BEHIND a dialog. Over the flat card surface
    // that is invisible; over the chart's red and green candles it made the
    // tooltip text unreadable, which is exactly what happened.
    //
    // So every floating surface is built in two layers: an opaque `bg-layer-1`
    // base, then the overlay tint on top of it. Whichever way the theme defines
    // the tint, the result cannot be see-through.
    '.hud-k-ylab{position:absolute;right:0;transform:translateY(-50%);padding:0 3px;font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums;background:var(--hud-pop)}',
    '.hud-k-xlab{position:absolute;bottom:-2px;transform:translateX(-50%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-caption,#81858c)}',
    '.hud-k-tip{position:absolute;top:6px;transform:translateX(-50%);z-index:3;pointer-events:none;display:flex;flex-direction:column;gap:3px;min-width:132px;padding:6px 9px 7px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:9px;background:var(--hud-pop);box-shadow:0 2px 6px rgba(15,17,21,.10),0 14px 30px -18px rgba(15,17,21,.55);color:var(--dsw-alias-label-primary,#0f1115);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}',
    // A caret pointing down at the candle the readout belongs to.
    '.hud-k-tip::after{content:"";position:absolute;left:50%;bottom:-4.5px;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);background:var(--hud-pop);border-right:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-bottom:1px solid var(--hud-line-2,rgba(0,0,0,.14))}',
    '.hud-k-tip-head{padding-bottom:3px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.08));font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-k-tip-grid{display:grid;grid-template-columns:auto auto;gap:1px 12px}',
    '.hud-k-kv{display:inline-flex;align-items:baseline;gap:6px;justify-content:space-between;min-width:0}',
    '.hud-k-kv i{font-style:normal;color:var(--dsw-alias-label-caption,#81858c)}',
    '.hud-k-kv b{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}',
    '.hud-k-tip-foot{display:flex;gap:12px;padding-top:3px;border-top:1px solid var(--hud-line,rgba(0,0,0,.08))}',
    '.hud-k-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
    // 红涨绿跌 — and this is a SPECIFICITY fix as much as a colour one: the plain
    // `.hud-k-kv b` rule above is (0,1,1) and outranked the old single-class
    // `.hud-k-up` (0,1,0), so the change value was never actually being coloured.
    // The compound selectors here are (0,2,1) and win wherever they are written.
    //
    // The hues come from the theme's state tokens rather than the hardcoded
    // candle colours, because this is TEXT on a themed (possibly dark) surface:
    // `#c0392b` on a dark tooltip would be the unreadable half of "coloured",
    // which is the one thing the colour must not cost. The hex stays as the
    // fallback for a theme that defines no state tokens at all.
    '.hud-k-kv b.hud-k-up,.hud-k-up{color:var(--dsw-alias-state-error-primary,#c0392b)}',
    '.hud-k-kv b.hud-k-down,.hud-k-down{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
    '.hud-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
    // ── the column grid ────────────────────────────────────────────────────
    // Track count and per-card span are DATA ATTRIBUTES, not inline styles, so
    // the narrow-width fallback below can override them with a later rule of
    // equal specificity — an inline style would need !important to beat.
    // The cap is MEASURED (`--hud-max`), not guessed. `100vh` was wrong: the dock
    // renders inside the composer stack, in the same flex column as the input bar
    // (`.composerStack{flex-direction:column}` holding the dock entries and then
    // `inputBar`, per the app's own stylesheet), so a tall HUD eats the composer's
    // room and the input ends up crowded or clipped. The fallback below only
    // applies for the instant before the first measurement.
    // ── the grid ─────────────────────────────────────────────────────────────
    //
    // `align-items` is deliberately NOT `start`. With explicit `grid-row: span N`, a
    // card whose content is taller than its N rows would otherwise keep its natural
    // height and grow DOWNWARD past its own area — covering the card below it. That is
    // the overlap this replaced: the packer was right, and the card was simply allowed
    // to be bigger than the space it had been given.
    //
    // Stretching makes the geometry do the enforcing: a card's box IS its area, always,
    // so two cards cannot collide however tall their content turns out to be. Anything
    // that does not fit now scrolls inside the card, which is visible and honest.
    //
    // `min-height:0` on the panels is the other half of that: a flex item refuses to
    // shrink below its content by default, so without it the stretch would be ignored
    // and the overflow would come straight back.
    // Content-box is the browser default, and every panel that writes `width:100%` next to
    // a padding has to remember to opt out — the ones that forgot added a horizontal
    // scrollbar to their card. Setting it once here means a panel cannot forget.
    '.hud-root,.hud-root *,.hud-root *::before,.hud-root *::after{box-sizing:border-box}',
    '.hud-body{display:grid;gap:10px;align-items:stretch;min-width:0;max-height:var(--hud-max,calc(100vh - 210px));overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}',
    // The width animates. It can only do that because the track COUNT never changes — see the
  // note on `--hud-tracks`: three tracks on both sides of the change is what makes the two
  // templates interpolatable at all.
  '.hud-body{transition:grid-template-columns .3s cubic-bezier(.4,0,.2,1)}',
  // An animation nobody asked to keep is an animation that can make someone ill, and this one runs
  // on a layout the user is looking straight at. Reduced motion turns it off completely rather than
  // shortening it.
  '@media (prefers-reduced-motion:reduce){.hud-body{transition:none}}',
  '.hud-body[data-cols="1"]{grid-template-columns:var(--hud-tracks,minmax(0,1fr))}',
    '.hud-body[data-cols="2"]{grid-template-columns:var(--hud-tracks,repeat(2,minmax(0,1fr)))}',
    '.hud-body[data-cols="3"]{grid-template-columns:var(--hud-tracks,repeat(3,minmax(0,1fr)))}',
    // ── rows ─────────────────────────────────────────────────────────────────
    // Explicit rows of a FIXED height, because a row has to mean the same thing
    // for every card in it: with `auto`, one tall card silently stretches its
    // neighbours and "make this card two rows taller" stops being predictable.
    // `grid-auto-rows` is the belt to the inline `grid-row`'s braces — a card
    // whose span exceeds the declared row count still gets real rows.
    '.hud-body{grid-auto-rows:var(--hud-row-h,78px);row-gap:10px}',
    // A card taller than its rows scrolls INSIDE itself, rather than stretching
    // the grid or spilling over its neighbour.
    '.hud-panel.is-shown{overflow:hidden}',
    // A long unbroken line (a config sample, a path, a URL) must WRAP, not push the
    // card wider than its cell and get clipped — which is what cut the services card
    // off at the right edge, header buttons and all. (`min-width:0` on the card
    // itself is already in the card's own rule; repeating it as a second rule only
    // made the first `.hud-panel` rule — the one that must carry the surface colour —
    // look like it had lost it.)
    '.hud-panel :where(pre,code){white-space:pre-wrap;overflow-wrap:anywhere}',
    '.hud-panel.is-shown>.hud-panel-body{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}',
    // ── the card settings form (machine / services / git) ─────────────────────
    // It lives INSIDE the card, so it uses the card's own type scale rather than
    // the ⚙ editor's: two different surfaces with two different jobs.
    '.hud-sgear{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-caption,#81858c);font-size:12px;line-height:1;cursor:pointer}',
    '.hud-sgear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-sgear.is-on{color:var(--dsw-alias-brand-primary,#3964fe)}',
    '.hud-sform{display:flex;flex-direction:column;gap:8px;padding:8px 0 4px;border-top:1px solid var(--hud-line,rgba(0,0,0,.08))}',
    '.hud-sfield{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.hud-sfield.is-inline{flex-direction:row;align-items:center;gap:8px}',
    '.hud-slabel{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
    '.hud-slabel input{margin-right:5px;vertical-align:middle}',
    '.hud-shint{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c)}',
    '.hud-serr{font-size:10.5px;line-height:14px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
    '.hud-srow{display:flex;align-items:center;gap:6px;min-width:0}',
    '.hud-svalue{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-sx{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer;line-height:1}',
    '.hud-sx:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}',
    '.hud-sadd{display:flex;align-items:center;gap:5px;min-width:0}',
    '.hud-sinput{flex:1 1 auto;min-width:0;box-sizing:border-box;height:22px;padding:0 6px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:11.5px}',
    '.hud-sinput.is-num{flex:0 0 92px}',
    '.hud-snum{display:flex;align-items:center;gap:6px}',
    '.hud-sbtn{flex:none;height:22px;padding:0 8px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:11px;cursor:pointer}',
    '.hud-sbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    '.hud-sbtn:disabled{opacity:.45;cursor:default}',
    '.hud-sbtn.is-ghost{color:var(--dsw-alias-label-secondary,#61666b)}',
    '.hud-sbtn.is-reset{align-self:flex-start;margin-top:2px}',
    '.hud-sopts{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
    '.hud-sopt{height:20px;padding:0 7px;border:1px dashed var(--hud-line-2,rgba(0,0,0,.14));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:10.5px;cursor:pointer}',
    '.hud-sopt:hover:not(:disabled){border-style:solid;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    '.hud-sopt.is-on{opacity:.4;cursor:default}',
    // Each card is now THE surface: with the shell transparent, a card has to
    // hold its own against whatever the app paints behind it. A real tile — soft
    // radius, a hairline, an opaque raised surface and a lifted shadow — reads as
    // a card on the page rather than a region of a big box.
    '.hud-panel{position:relative;box-sizing:border-box;min-width:0;min-height:0;display:flex;flex-direction:column;gap:9px;padding:10px 12px 11px;border:1px solid var(--hud-line);border-radius:var(--hud-radius);background:var(--hud-tile);box-shadow:var(--hud-shadow);transition:border-color .15s ease}',
    '.hud-panel:hover{border-color:var(--hud-line-2)}',
    // ── folding a card ─────────────────────────────────────────────────────
    // A folded card is ONE LINE: the wrapper is clipped to the height of the
    // panel's own first row, which every panel has (its header). Nothing about a
    // panel's internals has to change, and the clipping is uniform across panels
    // whose markup nests differently.
    '.hud-panel-body{min-width:0;min-height:0;display:flex;flex-direction:column;gap:9px}',
    '.hud-panel.is-collapsed .hud-panel-body{max-height:22px;overflow:hidden;gap:0}',
    // The unfold affordance lives BELOW the clipped row, so it can never fight a
    // panel's own controls for space in its header.
    '.hud-unfold{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin-top:7px;padding:2px 6px;border:1px solid transparent;border-top-color:var(--hud-line);border-radius:0 0 8px 8px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer;text-align:left}',
    '.hud-unfold:hover{border-color:var(--hud-line);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05));color:var(--dsw-alias-label-primary,#0f1115)}',
    '.hud-unfold-mark{font-size:9px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
    '.hud-unfold-hint{margin-left:auto;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
    // One header rhythm across every card. Each panel draws its own header row,
    // so the SHELL gives them the same separator and spacing instead of five
    // panels each inventing one — that is what makes them read as one product.
    // (0,2,0) specificity, so it wins over a panel's own `.ghh-head{padding:…}`
    // regardless of which stylesheet was injected first.
    '.hud-card .ocq-head,.hud-card .ghh-head,.hud-card .mk-head,.hud-card .bd-head,.hud-card .pk-head,.hud-card .mc-head,.hud-card .sv-head,.hud-card .gt-head{padding:0 0 7px;border-bottom:1px solid var(--hud-line)}',
    // ── the header sits ABOVE the shell's own affordances ────────────────────
    // The resize strips run down the card's right edge and along its bottom edge,
    // and a card's controls live at the RIGHT of its header — so without this the
    // strip silently swallowed clicks on the ⚙ and on the panel's own buttons.
    // A real bug, found by a test that clicked a card's gear and got nothing.
    //
    // 5 is a tier, not a preference: it has to beat the resize strips (which are
    // `z-index:auto`) and it has to stay strictly BELOW the title bar, which is
    // `z-index:20`. Equal numbers are decided by DOM order, the title bar comes
    // first, and that is how a card header ended up painted over the weather
    // detail opened from it. Raise a header only with that tie-break in mind.
    '.hud-card .ocq-head,.hud-card .ghh-head,.hud-card .mk-head,.hud-card .bd-head,.hud-card .pk-head,.hud-card .mc-head,.hud-card .sv-head,.hud-card .gt-head{position:relative;z-index:5}',
    // A card that leaves the grid is hidden, never unmounted: its polling and
    // its drawers survive being switched off and on again.
    '.hud-panel[hidden]{display:none}',
    '.hud-panel.is-shown{animation:hud-swap .26s cubic-bezier(.22,.7,.3,1)}',
    '.hud-panel[data-span="1"]{grid-column-end:span 1}',
    '.hud-panel[data-span="2"]{grid-column-end:span 2}',
    '.hud-panel[data-span="3"]{grid-column-end:span 3}',
    '@keyframes hud-swap{from{opacity:0;transform:translateY(5px)}}',
    // A crashed panel: named, contained, and never silent. Before the merge
    // each HUD owned its own dock cell, so a broken panel only broke itself;
    // now the shell has to guarantee that — see PanelBoundary.
    '.hud-crash{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
    '.hud-crash-title{font-size:12px;font-weight:600;color:var(--dsw-alias-state-error-primary,#dc2626)}',
    '.hud-crash-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
    // ── panel chrome, flattened ────────────────────────────────────────────
    // A panel used to BE a card: it brought sticky positioning, centring, its
    // own border, radius, background and shadow. The grid cell owns the frame
    // now. Specificity (0,2,0) beats each panel's own (0,1,0) rule whatever the
    // injection order, so the panel sources stay byte-identical to the
    // standalone plugins they were ported from — nothing here edits them.
    '.hud-card .ocq-root,.hud-card .ghh-root{position:static;z-index:auto;display:block;width:100%;padding:0}',
    '.hud-card .ocq-card,.hud-card .ghh-card{box-sizing:border-box;width:100%;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}',
    // Narrow docks cannot hold three readable decks: collapse to one track and
    // neutralise every span. Same specificity as the rules above, declared
    // later, so it simply wins.
    `@media (max-width:${NARROW_PX}px){.hud-body[data-cols]{grid-template-columns:minmax(0,1fr)}.hud-panel[data-span]{grid-column:1 / span 1 !important}}`,
    // Honour the OS setting: never animate for users who opted out.
    '@media (prefers-reduced-motion:reduce){.hud-panel.is-shown{animation:none}}',
  ].join('')
  document.head.appendChild(tag)
}

// ── components ─────────────────────────────────────────────────────────────

/**
 * Fault isolation, one per panel.
 *
 * This is the price of merging: a panel is no longer its own dock cell, so a
 * render throw inside one panel would otherwise take down the whole card —
 * including every panel that was working. The boundary keeps the blast radius
 * at one cell and says out loud which panel failed and why.
 *
 * Effects and event handlers are NOT caught here (React only routes render
 * errors to boundaries); every panel already treats its own timer/fetch
 * failures as best-effort, which is the same guarantee it had standalone.
 */
class PanelBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(`[hud] panel "${this.props.panelId}" crashed:`, error, info?.componentStack ?? '')
  }

  render() {
    if (this.state.error) {
      const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
      return jsxs('div', { className: 'hud-crash', children: [
        jsx('div', { className: 'hud-crash-title', children: `面板 "${this.props.panelId}" 渲染失败` }),
        jsx('div', { className: 'hud-crash-msg', children: message }),
        jsx('div', { className: 'hud-crash-msg', children: '其它面板不受影响；刷新页面可重试。' }),
      ] })
    }
    return this.props.children
  }
}

/** A switched-off panel, as a pill in the head row. Hook-safe: a component. */
function HudPill(props) {
  const count = useBadge(props.panel.id)
  const label = labelOf(props.panel, props.lang)
  const zh = props.lang === 'zh'
  const blocked = props.blocked === true
  return jsxs('button', {
    type: 'button',
    className: `hud-pill${blocked ? ' is-blocked' : ''}`,
    'data-panel': props.panel.id,
    title: blocked
      ? (zh ? `一行放不下「${label}」了，先在 ⚙ 里腾出栏位` : `no room in the row for ${label} — free a column in ⚙ first`)
      : (zh ? `显示「${label}」` : `Show ${label}`),
    onClick: props.onShow,
    children: [
      label,
      count > 0 ? jsx('em', { className: 'hud-count', children: count > 99 ? '99+' : String(count) }) : null,
    ],
  })
}

/** One row of the ⚙ layout editor: visibility, size, height, and the card's place. */
function HudLayoutRow(props) {
  const count = useBadge(props.panel.id)
  const label = labelOf(props.panel, props.lang)
  const zh = props.lang === 'zh'
  const blocked = props.blocked === true
  return jsxs('div', { className: 'hud-layout-row', children: [
    jsxs('button', {
      type: 'button',
      className: `hud-vis${props.cell.hidden ? '' : ' is-on'}${blocked ? ' is-blocked' : ''}`,
      'data-panel': props.panel.id,
      'aria-pressed': props.cell.hidden ? 'false' : 'true',
      title: props.cell.hidden
        ? (blocked
            ? (zh ? '这一行已经排满，放不下了' : 'the row is full')
            : (zh ? '点击显示这张卡片' : 'Click to show this card'))
        : (zh ? '点击隐藏这张卡片' : 'Click to hide this card'),
      onClick: () => props.onPatch({ hidden: !props.cell.hidden }),
      children: [
        jsx('span', { 'aria-hidden': true, children: props.cell.hidden ? '○' : '●' }),
        label,
        count > 0 ? jsx('em', { className: 'hud-count', children: count > 99 ? '99+' : String(count) }) : null,
      ],
    }),
    // A head-only panel consumes no grid column, so a size control would be a lie.
    // Say where the panel actually lives instead.
    props.cell.hasCard
      ? jsxs('span', { className: 'hud-layout-ctl', children: [
          // ── the size: 大 / 中 / 小, and nothing else ──
          //
          // These were numbered buttons ("2栏"). Named sizes are what the arrangement
          // is actually made of, and the number is an implementation detail: the span is
          // clamped against the grid either way, so a 大 on a two-column HUD is a 2.
          jsx('span', { className: 'hud-seg hud-sizes', children: CARD_SIZES.map((size) => {
            const tooWide = size.span > props.columns
            return jsx('button', {
              type: 'button',
              className: `hud-size${props.cell.span === size.span ? ' is-on' : ''}`,
              'data-size': String(size.span),
              'aria-pressed': props.cell.span === size.span ? 'true' : 'false',
              disabled: tooWide,
              title: tooWide
                ? (zh ? `当前只有 ${props.columns} 栏` : `only ${props.columns} column(s)`)
                : (zh ? `${size.zh}：占 ${size.span} 栏` : `${size.en}: ${size.span} column(s)`),
              onClick: () => props.onPatch({ span: size.span }),
              children: zh ? size.zh : size.en,
            }, size.span)
          }) }),
          // ── where the card sits in the arrangement ──
          //
          // This replaced dragging. Moving a card is a decision about ORDER — "put it
          // before that one" — and a pair of buttons says exactly that, needs no pixel
          // geometry, and cannot leave a hole behind.
          jsxs('span', { className: 'hud-seg hud-move', children: [
            jsx('button', {
              type: 'button',
              className: 'hud-up',
              'data-act': 'up',
              disabled: props.first === true || props.cell.hidden === true,
              title: props.cell.hidden
                ? (zh ? '这张卡是隐藏的，先显示它' : 'hidden — show it first')
                : (zh ? '往前排' : 'Move earlier'),
              onClick: () => props.onMove(-1),
              children: '↑',
            }),
            jsx('button', {
              type: 'button',
              className: 'hud-down',
              'data-act': 'down',
              disabled: props.last === true || props.cell.hidden === true,
              title: props.cell.hidden
                ? (zh ? '这张卡是隐藏的，先显示它' : 'hidden — show it first')
                : (zh ? '往后排' : 'Move later'),
              onClick: () => props.onMove(1),
              children: '↓',
            }),
          ] }),
          jsx('button', {
            type: 'button',
            className: `hud-fold${props.cell.collapsed ? ' is-on' : ''}`,
            'aria-pressed': props.cell.collapsed ? 'true' : 'false',
            title: props.cell.collapsed
              ? (zh ? '展开：折叠时只占 1 栏' : 'Expand (a folded card costs one column)')
              : (zh ? '折叠成一行，只占 1 栏' : 'Fold to one line, costing one column'),
            onClick: () => props.onPatch({ collapsed: !props.cell.collapsed }),
            children: props.cell.collapsed ? (zh ? '折叠' : 'folded') : (zh ? '展开' : 'open'),
          }),
          // Auto height: the default. The edge grips are gone, so this is the only
          // control that changes a card's height — and the measurement is still what
          // decides unless a height has been set here.
          jsx('button', {
            type: 'button',
            className: `hud-fit${props.cell.manualRows ? '' : ' is-on'}`,
            'aria-pressed': props.cell.manualRows ? 'false' : 'true',
            title: props.cell.manualRows
              ? (zh ? '改为按内容自动定高' : 'Size this card to its content again')
              : (zh ? '当前按内容自动定高' : 'Sized to its content'),
            // `rows: null` deletes the stored height — see patchLayout.
            onClick: () => props.onPatch({ rows: null }),
            children: props.cell.manualRows
              ? (zh ? `${props.cell.rows}行` : `${props.cell.rows} rows`)
              : (zh ? '自动' : 'auto'),
          }),
        ] })
      : jsx('span', { className: 'hud-where', children: zh ? '标题栏显示' : 'title bar' }),
  ] })
}

/**
 * The HUD: a head row over a column grid of keep-alive cards.
 *
 * Every slot prop the dock hands us (`useProjection`, `startTimers`, …) is
 * forwarded untouched to every panel, so a panel behaves exactly as it did
 * when it owned its own dock cell.
 */
function HudShell(props = {}) {
  const lang = pickLocale()
  const zh = lang === 'zh'
  const [prefs, setPrefs] = React.useState(readPrefs)
  /**
   * The HUD height the user dragged, or `undefined` for AUTO.
   *
   * Held in the prefs state (so it persists) AND mirrored in a ref, because the measure
   * effect is mounted ONCE and must see the current value without being re-created — a
   * re-created effect would tear down and re-attach the ResizeObserver on every drag frame.
   */
  const hudHeight = num(prefs.hudHeight)
  const hudHeightRef = React.useRef(hudHeight)
  hudHeightRef.current = hudHeight

  /**
   * Set (or clear) the HUD height. Clearing is how `自动` works: the key is REMOVED rather
   * than set to the measured value, so a later window resize still moves the HUD instead of
   * freezing whatever the height happened to be when the button was pressed.
   */
  /**
   * The drag.
   *
   * `POINTER_EVENTS ? onPointerDown : onMouseDown` — NOT both. A browser fires
   * `pointerdown` AND `mousedown` for one physical press, and an earlier version of this
   * HUD registered a handler for each: every delta was applied twice and the card slammed
   * to its maximum on the first twitch of the mouse. That is why this is written as a
   * choice rather than as two handlers that "both work".
   *
   * The move and up listeners live on `window`, so a fast drag that leaves the six-pixel
   * handle keeps working — losing a resize because the cursor outran a rectangle is its own
   * kind of broken.
   */
  const startResize = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    const root = rootRef.current
    if (root === null) return
    const startY = event.clientY
    // The CURRENT height, from the element when it has been laid out and from the
    // variable when it has not (jsdom reports zeros for every box).
    const startHeight = root.getBoundingClientRect().height
      || num(parseFloat(window.getComputedStyle(root).getPropertyValue('--hud-max')))
      || MIN_HUD_PX
    event.preventDefault()
    const move = (moveEvent) => {
      // Up is taller: the handle sits at the BOTTOM edge of the HUD.
      setHudHeight(startHeight + (startY - moveEvent.clientY))
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', finish)
    }
    if (POINTER_EVENTS) {
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    } else {
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', finish)
    }
  }

  const setHudHeight = (pixels) => {
    setPrefs((current) => {
      const next = { ...current }
      if (pixels === undefined) delete next.hudHeight
      else next.hudHeight = clamp(Math.round(pixels), MIN_HUD_PX, MAX_HUD_PX)
      writePrefs(next)
      return next
    })
  }
  const [showPrefs, setShowPrefs] = React.useState(false)
  // TEST HOOK, not a feature. Removing the ⚙ took the only interface route into the arrangement
  // editor; this keeps it reachable from the suite so its assertions still run. It is exposed as
  // exports.__openLayoutEditor below.
  React.useEffect(() => {
    openLayoutEditor = setShowPrefs
    return () => { openLayoutEditor = null }
  }, [])
  /** Why the last layout change was refused — null when nothing was refused. */
  const [layoutError, setLayoutError] = React.useState(null)
  /** The grid itself: needed to turn a pointer position into a grid cell. */
  const bodyRef = React.useRef(null)
  const prefsRef = React.useRef(null)
  const gearRef = React.useRef(null)
  const rootRef = React.useRef(null)
  const headRef = React.useRef(null)

  /**
   * Cap the HUD to the room the shell actually gives it.
   *
   * This cannot be a constant. The dock slot renders INSIDE the composer stack —
   * `composerStack` is the flex column that also holds `inputBar` (that is what
   * the app's stylesheet says, and what "full-width entries above the composer
   * card" means) — so every pixel the HUD takes is a pixel the composer loses,
   * and the app's own column is whatever the window, the sidebar and the
   * transcript leave over.
   *
   * So measure it: the nearest scrollable ancestor is the space we live in, and
   * the composer gets a reserve of its own on top of that. The grid then scrolls
   * INSIDE the HUD instead of pushing the input around.
   */
  React.useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof window === 'undefined') return undefined
    let scroller = root.parentElement
    while (scroller !== null && scroller !== document.body) {
      const overflowY = window.getComputedStyle(scroller).overflowY
      if (/auto|scroll|hidden/.test(overflowY)) break
      scroller = scroller.parentElement
    }
    const host = scroller === null || scroller === document.body ? null : scroller
    /**
     * The region the HUD spans is the WINDOW's content box — not an ancestor.
     *
     * Four rounds of walking the app's ancestors (the first scrollable one, the first on
     * screen, the first wider than the column) each guessed wrong in a different way, and
     * every guess was a guess about markup this code cannot see. The last one found nothing
     * at all, so the HUD fell back to the composer's width and the whole exercise did
     * nothing.
     *
     * The requirement does not need any of it. The HUD should span the window with a gutter
     * and never leave it, and both of those are measurable directly. The app centres a narrow
     * dock column inside a wide area, so the HUD has to be able to move OUT of its column —
     * which no ancestor-based rule can express.
     */
    const measure = () => {
      const available = (host?.clientHeight || window.innerHeight || 0) - (headRef.current?.offsetHeight ?? 0)
      // AUTO is the measurement; an explicit height is the user's, clamped only to the
      // draggable range. It is NOT clamped to the column on purpose: a grid that needs
      // more room than the viewport has is exactly the case this preference exists for,
      // and the page scrolls instead of a card.
      const chosen = hudHeightRef.current
      const target = chosen === undefined
        ? Math.max(MIN_HUD_PX, Math.round(available - COMPOSER_RESERVE_PX))
        : clamp(chosen, MIN_HUD_PX, MAX_HUD_PX)
      // Only when it CHANGED: assigning the same value to a CSS custom property still
      // invalidates style, and this runs on every frame the observer fires.
      if (root.style.getPropertyValue('--hud-max') !== `${target}px`) {
        root.style.setProperty('--hud-max', `${target}px`)
      }
      // The dock column is the composer's width in some app states (the welcome screen
      // centres it), and `width:100%` cannot escape its parent. Span the scroll region
      // instead — `100vw` would swallow the sidebar, so this is measured, and it is
      // re-measured on resize by the observer that is already here.
      // Only when the REGION changed. Everything below forces a synchronous layout twice,
      // and this effect runs on every render — a card ticking a clock is enough to trigger
      // it. The region's width changes when the window does, which is exactly what the
      // observer is for.
      // ── the WIDTH is the app's to give ──
      //
      // The HUD used to compute a width so it could span the window on the welcome screen,
      // where the app centres a narrow dock column. It cannot: `margin-left` moves an element
      // INSIDE its parent, and the column clips its overflow, so the box reached the window
      // edge while the cards were still cut off at the left. Escaping that needs
      // `position:fixed`, which would take the HUD out of the dock flow, break the reserve
      // that keeps the composer visible, and depend on no ancestor having a transform.
      //
      // In a conversation — where the HUD spends its time — the app's column IS the window,
      // so `width:100%` already does the right thing. On the welcome screen it is as wide as
      // the composer, and that is the app's layout, not this plugin's.
    }
    measure()
    // Both are optional: jsdom has neither, and the CSS fallback covers the gap.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(host ?? document.documentElement)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  /**
   * ── how tall each card should be, measured from what is IN it ─────────────
   *
   * Run after every render (through a frame), because a card's content changes
   * when its data does: a quote list grows a row, a chart loads, a section
   * appears. Only cards whose height DIFFERS are written, so this settles
   * instead of looping.
   *
   * The number measured is the PANEL's own scrollHeight, not the body's. A card is
   * header + body + padding, and the grid allots rows to the WHOLE card — measuring
   * only the body under-counts by the header and the padding, which is how a card ends
   * up a few pixels short of its own content and shows a scrollbar for no reason. The
   * panel's scrollHeight is the height the card actually wants.
   *
   * `scrollHeight` is the whole content, including whatever the card is currently
   * clipping — which is exactly the number needed to stop clipping it.
   */
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const frame = window.requestAnimationFrame(() => {
      const container = bodyRef.current
      if (container === null) return
      const next = {}
      for (const cell of cells) {
        if (!cell.hasCard || cell.hidden || cell.collapsed || cell.manualRows) continue
        const panel = container.querySelector('.hud-panel[data-panel="' + cell.panel.id + '"]')
        // The PANEL's own scrollHeight: the height the card wants, header and padding
        // included. A clipped panel still reports its full content here, which is
        // exactly the number needed to stop clipping it. Zero (jsdom, not laid out
        // yet) means "no measurement", never "zero tall".
        const rows = rowsForHeight(contentHeightOf(panel))
        // `undefined` means "no measurement to be had": jsdom, a card not laid out
        // yet, a hidden card. Skipping is the only safe answer — treating it as
        // zero would collapse every card.
        if (rows === undefined || rows === cell.rows) continue
        next[cell.panel.id] = rows
      }
      if (Object.keys(next).length > 0) setMeasuredRows((current) => ({ ...current, ...next }))
    })
    return () => window.cancelAnimationFrame(frame)
  })

  // Two ways out of the editor that do not depend on hitting a 24px target:
  // Escape, and a click anywhere outside it. A popover you cannot dismiss is
  // worse than no popover, and this one is opened by a control that can end up
  // scrolled away on a tall HUD.
  React.useEffect(() => {
    if (!showPrefs) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setShowPrefs(false)
    }
    const onDown = (event) => {
      const target = event.target
      if (prefsRef.current?.contains(target) || gearRef.current?.contains(target)) return
      setShowPrefs(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [showPrefs])

  const update = React.useCallback((patch) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      writePrefs(next)
      return next
    })
  }, [])

  /**
   * Show or hide one of the three columns.
   *
   * REFUSES to hide the last visible column. Three hidden columns is a HUD with nothing in it and
   * no control left to bring anything back — the buttons live in the head row, which is inside the
   * area being emptied. Refusing the third press is the whole safety property, so it lives here
   * rather than only in the buttons' disabled state.
   */
  const toggleColumn = React.useCallback((index) => {
    setPrefs((current) => {
      const on = Array.isArray(current.hiddenColumns) ? current.hiddenColumns : []
      const next = on.includes(index) ? on.filter((one) => one !== index) : [...on, index].sort()
      const columns = clampColumns(current.columns)
      if (next.length >= columns) return current
      const updated = { ...current, hiddenColumns: next }
      writePrefs(updated)
      return updated
    })
  }, [])

  /** Patch one panel's layout entry without touching any other panel's. */
  const patchLayout = React.useCallback((id, patch) => {
    setPrefs((current) => {
      const layout = { ...(current.layout ?? {}) }
      const merged = { ...(layout[id] ?? {}), ...patch }
      // A `null` in a patch DELETES the key. A spread cannot do that — it keeps the
      // old value — so "hand this card back to auto height" would otherwise look
      // like it worked and change nothing. Doing it here means every layout change
      // goes through one place that understands the protocol.
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key]
      }
      layout[id] = merged
      const next = { ...current, layout }
      writePrefs(next)
      return next
    })
  }, [])

  /**
   * ── moving a card in the arrangement ───────────────────────────────────────
   *
   * `delta` is -1 for ↑ and +1 for ↓. The card swaps places with its neighbour in the
   * VISIBLE order, and every visible card's `order` is then rewritten to its new index
   * — renumbering rather than swapping two numbers, because stored orders drift (a fresh
   * install, a migration and a hand-edited blob can all leave gaps or duplicates) and a
   * swap would faithfully preserve the drift.
   *
   * Hidden cards are left alone: they are not in the grid, so their order decides nothing
   * until they are switched on, and rewriting preferences the user cannot see the effect
   * of is how a layout editor starts lying.
   *
   * ONE write, not one per card: `patchLayout` writes the whole prefs blob, so calling it
   * in a loop would write N times and re-render N times for a single click.
   */
  const moveCard = React.useCallback((id, delta) => {
    setLayoutError(null)
    setPrefs((current) => {
      const layout = { ...(current.layout ?? {}) }
      const visible = PANELS
        .map((panel, index) => ({
          id: panel.id,
          hasCard: typeof panel.Component === 'function',
          stored: layout[panel.id] ?? {},
          index,
        }))
        .filter((entry) => entry.hasCard && entry.stored.hidden !== true)
        .map((entry) => ({ id: entry.id, order: num(entry.stored.order) ?? entry.index }))
        .sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)))
      const from = visible.findIndex((entry) => entry.id === id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= visible.length) return current
      const reordered = [...visible]
      const [moved] = reordered.splice(from, 1)
      reordered.splice(to, 0, moved)
      for (const [index, entry] of reordered.entries()) {
        layout[entry.id] = { ...layout[entry.id], order: index }
      }
      const updated = { ...current, layout }
      writePrefs(updated)
      return updated
    })
    return true
  }, [])

  /**
 * Measured row counts, by panel id. NOT persisted: a measurement describes this
 * window, this font size and this content — storing it would freeze all three.
 */
const [measuredRows, setMeasuredRows] = React.useState({})

const columns = clampColumns(prefs.columns)
  /**
   * The columns switched off from the head row. Absent means none, which is also the correct
   * reading of every prefs file written before this existed — see the note in readPrefs, and why
   * there is no version bump.
   */
  const hiddenColumns = Array.isArray(prefs.hiddenColumns) ? prefs.hiddenColumns : []

  /**
   * Resolve every panel's layout ONCE per render: the user's stored entry when
   * present, otherwise the panel's own preference, clamped to the live column
   * count so lowering `columns` can never leave a span hanging outside the grid.
   */
  const cells = PANELS.map((panel, registryIndex) => {
    const stored = prefs.layout?.[panel.id]
    return {
      panel,
      hasCard: typeof panel.Component === 'function',
      hasHead: typeof panel.head === 'function',
      span: clampSpan(num(stored?.span) ?? panel.span ?? DEFAULT_SPAN, columns),
      hidden: stored?.hidden === true,
      // Collapsed to one line. It consumes NO column when collapsed — that is
      // the entire point: folding a card is how more of them fit in the row.
      collapsed: stored?.collapsed === true,
      // Where the card sits in the arrangement. This is what the settings panel edits
      // (↑/↓), and it is read in the packer below. A card with no stored order — a
      // panel that arrived after the prefs were written — falls back to its place in
      // the registry, which is where a new card should appear anyway.
      order: num(stored?.order) ?? registryIndex,
      // A stored `rows` means the user set this card's height by hand: from then on it
      // is theirs, and the measurement leaves it alone. No stored value means "as tall
      // as the content needs", which is the default.
      manualRows: num(stored?.rows) !== undefined,
      // ── how tall this card is ────────────────────────────────────────────────
      //
      // An explicit height the user set wins outright. Otherwise the card is as tall as
      // its CONTENT needs and never shorter than the layout declares:
      //
      //     max(measured, declared)
      //
      // The declared number alone was a ceiling, so a chart with more to show than its
      // design allowed scrolled — with empty space right below it. The measurement alone
      // collapses a nearly-empty card to one line and breaks the column heights. The
      // maximum is the only rule that satisfies both: nothing scrolls, and no card is
      // smaller than the layout meant it to be.
      rows: Math.min(
        clampRows(
          num(stored?.rows) !== undefined
            ? num(stored?.rows)
            : Math.max(measuredRows[panel.id] ?? 0, num(panel.defaultRows) ?? 0) || DEFAULT_ROWS,
        ),
        // A declared ceiling wins over both the measurement and the floor. It is the only
        // way to say "this card is three rows, whatever the rounding thinks" — and a manual
        // height from ⚙ still overrides it, because that is a decision, not a measurement.
        num(stored?.rows) === undefined && num(panel.maxRows) !== undefined
          ? clampRows(num(panel.maxRows))
          : MAX_ROWS,
      ),
    }
  })
  const hiddenCells = cells.filter((cell) => cell.hidden)
  const cardCells = cells.filter((cell) => cell.hasCard)

  /**
   * The resolved grid: which slot each visible card actually gets, and how many rows
   * the whole thing needs. Recomputed every render from the stored ORDER, so the layout
   * is a pure function of the preferences — there is no second source of truth to drift.
   *
   * A FOLDED card is one line tall, so it asks for a single row: that is what makes
   * folding useful next to a tall neighbour.
   */
    const toItem = (cell) => ({
      id: cell.panel.id,
      span: cell.collapsed ? 1 : cell.span,
      rows: cell.collapsed ? 1 : cell.rows,
      order: cell.order,
    })
    const visibleItems = cardCells.filter((cell) => !cell.hidden).map(toItem)
    /**
     * ONE resolve, at the full width, always.
     *
     * The cards in a hidden column are then hidden individually rather than re-packed away. Keeping
     * the placements stable is what lets the WIDTH animate: the grid has the same number of tracks
     * before and after, so the browser can interpolate between them, and the cards that stay put
     * simply grow.
     */
    const hiddenSet = new Set(hiddenColumns)
    const layoutGrid = resolveGrid(visibleItems, columns)
  const totalRows = layoutGrid.rows
  /** How many slots are actually occupied — the number the editor reports. */
  const usedSlots = cardCells
    .filter((cell) => !cell.hidden)
    .reduce((sum, cell) => sum + (cell.collapsed ? 1 : cell.span) * (cell.collapsed ? 1 : cell.rows), 0)

  /**
   * The row budget. ONE row, `columns` tracks, and the sum of the visible cards'
   * spans may never exceed it — that is the whole rule, and every path that can
   * change the layout (⚙ toggles, span buttons, hidden-panel pills, a panel
   * calling `hud.showPanel`) goes through `attemptLayout` below.
   *
   * A COLLAPSED card is one line tall, so it costs one track instead of its own
   * span. That is what makes folding useful: three folded cards and one open one
   * can share a row that a single wide card used to fill.
   */
  const usedColumns = cardCells
    .filter((cell) => !cell.hidden)
    .reduce((sum, cell) => sum + (cell.collapsed ? 1 : cell.span), 0)
  /**
   * How full the grid is — a REPORT now, not a budget.
   *
   * There is no longer a "the row is full" state: a card that does not fit goes
   * on the next row, which is the whole point of the change. What is left is the
   * number the editor shows so the user can see the cost of what they turned on.
   */
  const usedLines = cardCells
    .filter((cell) => !cell.hidden)
    .reduce((sum, cell) => sum + (cell.collapsed ? 1 : cell.rows), 0)

  /**
   * Apply a layout change.
   *
   * It REFUSES nothing. Overflow used to be an error ("一行最多 3 栏"); now it is
   * another row, and a span wider than the grid is clamped to it, because a card
   * cannot be wider than the grid it lives in. The function stays as the single
   * gate every mutation goes through, which is what keeps the layout a pure
   * function of the stored preferences.
   *
   * Always returns true; the return value is kept because panels and the editor
   * both read it.
   */
  const attemptLayout = React.useCallback((id, patch) => {
    setLayoutError(null)
    const next = { ...patch }
    // `rows: null` asks for AUTO height, and it has to be handled BEFORE the clamps
    // because `Number(null)` is 0, not "no value" — clamping it would silently pin
    // the card to one row instead of handing it back to the measurement.
    if (next.rows === null) delete next.rows
    // Every positional field is clamped HERE, once, so a stored value can never
    // be out of range however it got in (the editor, a migration, a hand-edited blob).
    if (num(next.span) !== undefined) next.span = clampSpan(next.span, columns)
    if (num(next.rows) !== undefined) next.rows = clampRows(next.rows)
    if (num(next.order) !== undefined) next.order = Math.max(0, Math.round(num(next.order)))
    patchLayout(id, next)
    return true
  }, [cells, columns, lang, patchLayout, zh])

  /**
   * Narrowing the grid is always allowed now: a card whose span no longer fits is
   * clamped by `clampSpan` at render time and re-packed, instead of the whole
   * change being refused. That was only necessary while the row was a hard
   * budget; with rows, the worst case is a card moving down.
   */
  const attemptColumns = React.useCallback((next) => {
    setLayoutError(null)
    update({ columns: next })
    return true
  }, [update])


  // Normalize what is on disk, once per mount. `readPrefs` already ignores
  // unknown keys; writing the pruned object back is what actually removes a
  // stale one (e.g. the `align` an older build stored) from the browser.
  React.useEffect(() => {
    writePrefs(prefs)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount on purpose
  }, [])

  // `hud.showPanel('github')` — how one panel puts another card back on screen.
  // It goes through the SAME budget check as the ⚙ editor, so a panel asking for
  // the row cannot end up in a layout the user could not have made by hand.
  React.useEffect(() => {
    const listener = (id) => {
      if (!PANELS.some((panel) => panel.id === id)) return
      if (!attemptLayout(id, { hidden: false })) setShowPrefs(true)
    }
    panelRequests.add(listener)
    return () => panelRequests.delete(listener)
  }, [attemptLayout])

  // A HUD with no panels is nothing to look at; stay out of the dock entirely.
  if (PANELS.length === 0) return null
  // Head widgets sit next to the brand, in panel order, and follow the same
  // on/off switch as the cards — so the ⚙ visibility toggle means the same
  // thing wherever a panel appears.
  //
  // A switched-off widget is `hidden`, NOT unmounted: the whole point of the
  // keep-alive promise is that turning something off never restarts its polling
  // or drops its data, and a head widget is no exception. (Rendering only the
  // visible ones was a real bug caught by the browser test asserting the node
  // was still connected.)
  const headCells = cells.filter((cell) => cell.hasHead)
  const leftHeadCells = headCells.filter((cell) => cell.panel.headSide !== 'right')
  const rightHeadCells = headCells.filter((cell) => cell.panel.headSide === 'right')

  return jsx('div', {
    className: 'hud-root',
    ref: rootRef,
    children: jsxs('div', { className: 'hud-card', children: [
      jsxs('div', { className: 'hud-head', ref: headRef, children: [
        jsx('span', { className: 'hud-brand', children: 'HUD' }),
        leftHeadCells.length > 0
          ? jsx('span', { className: 'hud-heads', children: leftHeadCells.map((cell) => jsx('span', {
              className: 'hud-head-slot',
              'data-panel': cell.panel.id,
              hidden: cell.hidden,
              children: jsx(PanelBoundary, {
                panelId: cell.panel.id,
                children: jsx(cell.panel.head, { ...props, active: !cell.hidden }),
              }),
            }, cell.panel.id)) })
          : null,
        hiddenCells.length > 0
          ? jsxs('span', { className: 'hud-pills', children: [
              jsx('span', { className: 'hud-pills-label', children: lang === 'zh' ? '未显示' : 'HIDDEN' }),
              hiddenCells.map((cell) => jsx(HudPill, {
                panel: cell.panel,
                lang,
                // Always one click from coming back. Nothing is ever "blocked" any more:
                // a card that does not fit the first row simply starts a new one.
                blocked: false,
                onShow: () => attemptLayout(cell.panel.id, { hidden: false }),
              }, cell.panel.id)),
            ] })
          : null,
        jsxs('span', { className: 'hud-right', children: [
          // Widgets that asked for the right-hand side. They sit before the ⚙ so
          // the gear stays the last, most predictable target in the row — and
          // they are MOUNTED even when switched off, like every other widget.
          rightHeadCells.map((cell) => jsx('span', {
            className: 'hud-head-slot',
            'data-panel': cell.panel.id,
            'data-side': 'right',
            hidden: cell.hidden,
            children: jsx(PanelBoundary, {
              panelId: cell.panel.id,
              children: jsx(cell.panel.head, { ...props, active: !cell.hidden }),
            }),
          }, cell.panel.id)),
          // ── 左 / 中 / 右 ──────────────────────────────────────────────────────
          //
          // The three regions of the HUD, each toggled from the head row. A hidden column does not leave a
          // hole: the other columns CLOSE UP over it (see the two-pass resolve in the grid), so hiding 左
          // hands its width to 中 and 右.
          //
          // The last visible column cannot be switched off. These buttons live in the head row, which is
          // inside the area being emptied — a third press would leave nothing left to press. `toggleColumn`
          // enforces that; `disabled` only says so.
          jsxs('span', { className: 'hud-cols', children: [
            jsx('span', { className: 'hud-cols-label', children: lang === 'zh' ? '区域' : 'Panes' }),
            ...[0, 1, 2].slice(0, clampColumns(prefs.columns)).map((index) => {
              const off = hiddenColumns.includes(index)
              const last = hiddenColumns.length >= clampColumns(prefs.columns) - 1
              const name = lang === 'zh'
                ? `${['左', '中', '右'][index]}栏`
                : `${['left', 'middle', 'right'][index]} column`
              return jsx('button', {
                type: 'button',
                className: `hud-col${off ? ' is-off' : ''}`,
                'data-col': String(index),
                'data-act': 'toggle-column',
                'aria-pressed': off ? 'false' : 'true',
                // The label names the region AND its state: a button whose only content is 左 says
                // nothing about what pressing it will do.
                'aria-label': lang === 'zh'
                  ? `${name}：${off ? '已隐藏，点击显示' : '显示中，点击隐藏'}`
                  : `${name}: ${off ? 'hidden, click to show' : 'shown, click to hide'}`,
                title: lang === 'zh' ? `${off ? '显示' : '隐藏'}${name}` : `${off ? 'show' : 'hide'} ${name}`,
                disabled: !off && last,
                onClick: () => toggleColumn(index),
                children: lang === 'zh' ? ['左', '中', '右'][index] : ['L', 'M', 'R'][index],
              }, index)
            }),
          ] }),
          // The layout gear used to sit here — the last control in the head row. Removed on
          // request: the row reads better ending on the panels' own pills.
          //
          // It was also the ONLY way into the arrangement editor below, so that editor is now
          // unreachable from the interface. The code is left intact and still correct: putting the
          // button back is this one block, and deleting the editor is equally small if it should
          // stay gone.
        ] }),
        // The editor lives INSIDE the head row and is absolutely positioned, so
        // opening it does not add a pixel of height to the HUD. It used to be an
        // in-flow block between the head row and the grid: on a tall HUD that
        // pushed the head row off the top of the screen, which took the ⚙ itself
        // with it and left no way to close the panel again. An overlay cannot do
        // that, and it also gets a height cap of its own so a short viewport
        // scrolls inside it instead of cutting it off.
        showPrefs
          ? jsxs('div', {
              className: 'hud-prefs',
              role: 'dialog',
              'aria-label': lang === 'zh' ? 'HUD 布局设置' : 'HUD layout settings',
              ref: prefsRef,
              children: [
                jsxs('div', { className: 'hud-prefs-head', children: [
                  jsx('span', { className: 'hud-prefs-title', children: zh ? '布局' : 'LAYOUT' }),
                  // A REPORT, not a budget: how much grid is in use, and how tall it grew.
                  // Rows are unbounded, so this cannot block anything any more —
                  // it tells the user the cost of what they turned on.
                  jsx('span', {
                    className: 'hud-budget',
                    'data-used': String(usedColumns),
                    'data-columns': String(columns),
                    'data-rows': String(totalRows),
                    'data-lines': String(usedLines),
                    title: zh ? '已占用的栏位 · 网格行数 · 卡片总行数' : 'columns · grid rows · card lines in use',
                    children: zh ? `${usedColumns} 栏 · ${totalRows} 行` : `${usedColumns} cols · ${totalRows} rows`,
                  }),
                  // An explicit way out that does not depend on reaching the ⚙.
                  jsx('button', {
                    type: 'button',
                    className: 'hud-prefs-close',
                    'aria-label': zh ? '关闭设置' : 'Close settings',
                    title: zh ? '关闭设置' : 'Close settings',
                    onClick: () => setShowPrefs(false),
                    children: '✕',
                  }),
                ] }),
                jsxs('div', { className: 'hud-prefs-row', children: [
                  jsx('span', { className: 'hud-prefs-label', children: zh ? '栏位数' : 'COLUMNS' }),
                  jsx('span', { className: 'hud-seg', children: COLUMN_OPTIONS.map((option) => {
                    // Narrowing is ALWAYS allowed now: a card wider than the new
                    // grid is clamped and re-packed, so the worst case is a card
                    // moving down a row instead of the whole change being refused.
                    return jsx('button', {
                      type: 'button',
                      'aria-pressed': columns === option ? 'true' : 'false',
                      title: zh ? `一行 ${option} 栏` : `${option} column(s) per row`,
                      onClick: () => attemptColumns(option),
                      children: String(option),
                    }, option)
                  }) }),
                ] }),
                // Cards only: a head-only panel has nothing to lay out in the grid,
                // so it gets a visibility toggle and no size control.
                //
                // The list is the ARRANGEMENT, not the registry: the arrows edit the
                // order, so a list in registry order would move a card somewhere other
                // than where it appears — and "first"/"last" would disable the wrong
                // buttons. Hidden cards come last: they have a place in the order but no
                // place in the grid, and they are not moved by the arrows at all.
                jsxs('div', { className: 'hud-layout', children: [...cells]
                  // The order the list READS in: the cards that are in the grid (the
                  // arrangement itself), then the head-only widgets, then the cards that
                  // are switched off. Nothing is hidden from the user; it is just filed
                  // the way the grid is built, so the ↑/↓ buttons act on a contiguous run
                  // and the ends of that run are the ends of the arrangement.
                  .sort((a, b) => (
                    Number(!(a.hasCard && !a.hidden)) - Number(!(b.hasCard && !b.hidden))
                    || a.order - b.order
                    || String(a.panel.id).localeCompare(String(b.panel.id))
                  ))
                  .map((cell, index, list) => jsx(HudLayoutRow, {
                    panel: cell.panel,
                    cell,
                    lang,
                    columns,
                    free: columns,
                    // Nothing is blocked any more — a card that does not fit the
                    // first row starts a new one.
                    blocked: false,
                    // The ends of the MOVABLE run. Hidden cards sort to the bottom of
                    // this list, and the arrows do not act on them at all — so "last"
                    // is the last card that is IN the grid. Marking the final row of the
                    // list instead would enable a ↓ on the last visible card that moves
                    // it past a hidden one and changes nothing on screen: a button that
                    // does nothing visible is indistinguishable from a broken one.
                    first: index === 0,
                    last: index === list.filter((one) => one.hasCard && !one.hidden).length - 1,
                    // Where the packer actually put it, so the editor can show the
                    // slot instead of pretending the request is the truth.
                    place: layoutGrid.place.get(cell.panel.id),
                    onPatch: (patch) => attemptLayout(cell.panel.id, patch),
                    onMove: (delta) => moveCard(cell.panel.id, delta),
                  }, cell.panel.id)) }),
                layoutError
                  ? jsx('span', { className: 'hud-error', role: 'alert', children: layoutError })
                  : null,
                jsx('span', { className: 'hud-note', children: zh
                  ? '行数不设上限：装不下就换一行。用这里的 大/中/小 定尺寸、↑/↓ 定先后 —— 每行最多 3 栏，排完自动收紧，不留空隙。关掉的卡片仍在后台运行，只在标题栏留一个胶囊。布局只保存在本浏览器。'
                  : 'No row limit: a card that does not fit starts a new row. Set the size here with Large/Medium/Small and the order with ↑/↓ — three columns per row at most, packed tight with no gaps. A card that is off keeps running — it just becomes a pill in the head row. Layout lives in this browser only.' }),
              ],
            })
          : null,
      ] }),
      // Keep-alive grid: EVERY panel renders on every pass; switching one off
      // only sets `hidden`. Panels therefore keep polling, keep their carousel
      // position and keep their open drawers while they are off screen.
      //
      // Placement is EXPLICIT (`grid-column` / `grid-row`, from the packer) rather
      // than auto-flow. That is what lets a card hold a fixed slot, lets a
      // deliberate gap exist, and lets a card two rows tall reserve the rows under
      // it instead of being overlapped by the next one.
      jsxs('div', {
          className: 'hud-body',
        // Always the FULL count. The track count must not change when a column is hidden — that
        // is what the animation needs — so the stylesheet always declares every track and the
        // hidden ones are collapsed to 0fr through `--hud-tracks` above.
        'data-cols': String(clampColumns(columns)),
        'data-rows': String(totalRows),
        ref: bodyRef,
        style: {
          // The three tracks, with a hidden column at 0fr so its neighbours take the width.
          //
          // Set ONLY when something is hidden: with nothing hidden the stylesheet's own
          // `data-cols` rule stands, which is what keeps the narrow-screen override working —
          // an inline template would outrank it and break the one-column layout on a phone.
          //
          // The count here is always `columns`, never `columns - hidden`. Three tracks either
          // way is what makes the change interpolatable, and the number of tracks is not the same
          // thing as the number of visible columns.
          ...(hiddenSet.size === 0 ? {} : {
            '--hud-tracks': Array.from({ length: clampColumns(columns) }, (_, index) => (
              hiddenSet.has(index) ? '0fr' : 'minmax(0, 1fr)'
            )).join(' '),
          }),
          // One variable drives every row's height, so "two rows taller" means the
          // same thing for every card.
          '--hud-row-h': `${ROW_UNIT_PX}px`,
          '--hud-grid-rows': String(totalRows),
        },
        children: [
          ...cells.filter((cell) => cell.hasCard).map((cell) => {
            // A card in a HIDDEN COLUMN has no placement: the grid was resolved without it.
            //
            // It is drawn hidden rather than positioned at a fallback. The fallback is not harmless
            // — `{ row: 0, col: 0 }` is the top-left cell, so a dropped card would render ON TOP of
            // whichever card is actually there. "Hidden" would have looked like "moved to the
            // corner and overlapped something", which is a worse bug than not hiding at all.
            const place = layoutGrid.place.get(cell.panel.id)
            const rows = cell.collapsed ? 1 : cell.rows
            const span = cell.collapsed ? 1 : cell.span
            // Hidden either because the card was switched off, or because its whole COLUMN was.
            // Both render the same way; they are different controls with one effect.
            const gone = place === undefined || hiddenSet.has(place.col)
            return jsxs('div', {
              className: `hud-panel${cell.hidden ? '' : ' is-shown'}${cell.collapsed ? ' is-collapsed' : ''}`,
              'data-panel': cell.panel.id,
              'data-span': String(span),
              'data-rows': String(rows),
              'data-col': String(place?.col ?? 0),
              'data-row': String(place?.row ?? 0),
              'data-collapsed': cell.collapsed ? 'true' : 'false',
              // `gone` covers the column switch; `cell.hidden` covers the per-card switch. They are
              // different controls with the same effect on this element, and both have to work.
              hidden: cell.hidden || gone,
              'data-col-hidden': gone ? 'true' : 'false',
              role: 'group',
              'aria-label': labelOf(cell.panel, lang),
              // The stylesheet sets these too, but the inline values are what the
              // tests read and what a stylesheet-less render still lays out by.
              style: {
                gridColumn: `${(place?.col ?? 0) + 1} / span ${span}`,
                gridRow: `${(place?.row ?? 0) + 1} / span ${rows}`,
              },
              // The panel is wrapped so the collapsed state can clip it to one line
              // without knowing anything about its internals. Panels differ in depth
              // (the ported ones have a root AND a card), so a selector that reached
              // for "every child but the first" would work on some and not others;
              // a max-height on ONE wrapper works on all of them.
              children: [
                jsx('div', {
                  className: 'hud-panel-body',
                  // Double-clicking a card folds it, and the footer row unfolds it —
                  // two gestures that need no space in a header row already full of
                  // a panel's own controls.
                  onDoubleClick: () => attemptLayout(cell.panel.id, { collapsed: !cell.collapsed }),
                  children: jsx(PanelBoundary, {
                    panelId: cell.panel.id,
                    children: jsx(cell.panel.Component, { ...props, active: !cell.hidden }),
                  }),
                }),
                cell.collapsed
                  ? jsxs('button', {
                      type: 'button',
                      className: 'hud-unfold',
                      title: lang === 'zh' ? '展开这张卡片' : 'Expand this card',
                      onClick: () => attemptLayout(cell.panel.id, { collapsed: false }),
                      children: [
                        jsx('span', { className: 'hud-unfold-mark', 'aria-hidden': true, children: '▸' }),
                        jsx('span', { children: labelOf(cell.panel, lang) }),
                        jsx('span', { className: 'hud-unfold-hint', children: lang === 'zh' ? '已折叠' : 'folded' }),
                      ],
                    })
                  : null,
              ],
            }, cell.panel.id)
          }),
        ],
      }),
    // ── the resize handle ──────────────────────────────────────────────────
    //
    // A separator, not a decoration: focusable, arrow-key resizable, and it says in words
    // what it does. It sits at the BOTTOM edge, so dragging UP makes the HUD taller — the
    // direction everyone already expects from a panel edge.
    //
    // It is allowed to make the HUD taller than the app's column. That pushes the composer
    // below the fold and lets the PAGE scroll instead of a card, which is a decision about
    // your own screen — and it is the only way to see a twelve-row grid whole. Double-click
    // (or Home) puts it back to 自动, and the label says which of the two you are looking at.
    jsxs('div', {
      className: 'hud-resize',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': zh ? '调整 HUD 高度' : 'resize the HUD',
      'aria-valuenow': String(Math.round(hudHeight ?? 0)),
      'aria-valuemin': String(MIN_HUD_PX),
      'aria-valuemax': String(MAX_HUD_PX),
      'data-mode': hudHeight === undefined ? 'auto' : 'manual',
      tabIndex: 0,
      title: hudHeight === undefined
        ? (zh ? '拖动调整 HUD 高度 · 当前：自动（跟随窗口）· 方向键微调' : 'drag to resize · now: auto')
        : `${zh ? '拖动调整 HUD 高度 · 当前' : 'drag to resize · now'} ${Math.round(hudHeight)}px · ${zh ? '双击或 Home 恢复自动' : 'double-click or Home for auto'}`,
      onDoubleClick: () => setHudHeight(undefined),
      onKeyDown: (keyEvent) => {
        // Home rather than a reset button: a keyboard user needs the SAME two states a mouse
        // user gets, and "back to auto" is the one that is hard to reach by nudging.
        if (keyEvent.key === 'Home') {
          keyEvent.preventDefault()
          setHudHeight(undefined)
          return
        }
        const page = keyEvent.key === 'PageUp' || keyEvent.key === 'PageDown'
        const up = keyEvent.key === 'ArrowUp' || keyEvent.key === 'PageUp'
        const down = keyEvent.key === 'ArrowDown' || keyEvent.key === 'PageDown'
        if (!up && !down) return
        keyEvent.preventDefault()
        const step = page ? ROW_UNIT_PX + ROW_GAP_PX : HUD_HEIGHT_STEP_PX
        const from = hudHeight ?? (rootRef.current?.getBoundingClientRect().height || MIN_HUD_PX)
        setHudHeight(from + (up ? step : -step))
      },
      ...(POINTER_EVENTS ? { onPointerDown: startResize } : { onMouseDown: startResize }),
      children: [
        jsx('span', { className: 'hud-resize-grip', 'aria-hidden': 'true' }),
        jsx('span', {
          className: 'hud-resize-label',
          children: hudHeight === undefined
            ? (zh ? '自动高度' : 'AUTO')
            : `${Math.round(hudHeight)}px`,
        }),
    ] }),
      ],
    }),
  })
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/bond/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › bond panel — browser half.
//
// FRAGMENT CONTRACT: concatenated into the single `client.js` bundle by
// `tools/build-client.mjs`. No top-level `import` / `export` / `return`;
// `React`, `jsx`, `jsxs` and `hud` come from the bundle scope.
//
// A bond view is not a stock view with different numbers, so this card is not a
// candlestick chart:
//
//   期限结构 (the term structure) is the headline — a curve across tenors, which
//   is what "债市走势" means to anyone who works with bonds. One line, dots on
//   the quoted tenors, the value printed at each dot.
//
//   走势 comes from a bond ETF rather than from a yield series. A yield has no
//   OHLC — it is a single number per day, published once a day, and drawing
//   candles for it would be a lie dressed as professionalism. Chinamoney also
//   returns ~75 rows per trading day (one per tenor), so a 45-day 10Y history
//   costs ~57 paged requests and gets you an anti-scraping page; a bond ETF's
//   daily closes are the same signal, from a source built to be polled, and the
//   UI labels it as a PRICE (which moves inverse to yield) instead of pretending
//   it is a yield.
//
// Yields are therefore NOT coloured 红涨绿跌: a yield rising is not "up" in the
// sense a price is. They carry `+3.2bp` and an arrow, and only the tradeable
// bond ETFs — which ARE prices — get the red/green treatment.

const BD_FALLBACK_MS = 1_800_000
const BD_MIN_MS = 300_000
const BD_MAX_MS = 24 * 60 * 60_000
const BD_CN = '#2f6fd0'

function createBondPanel() {
  const CSS_ID = 'dsh-hud/bond.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.bd-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.bd-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;flex-wrap:wrap}',
      '.bd-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.bd-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.bd-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.bd-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.bd-btn:disabled{opacity:.55;cursor:default}',
      '.bd-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-btn.is-on{background:rgba(57,100,254,.10);border-color:rgba(57,100,254,.35);font-weight:600}',
      '.bd-sec{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.bd-sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-seclabel{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c)}',
      '.bd-secnote{color:var(--dsw-alias-label-caption,#81858c);font-size:10.5px}',
      // ── chart ─────────────────────────────────────────────────────────────
      '.bd-chart{position:relative;width:100%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));padding:5px 7px 3px}',
      '.bd-svg{display:block;width:100%;height:auto}',
      '.bd-ylab{position:absolute;right:2px;transform:translateY(-50%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 3px}',
      '.bd-xlab{position:absolute;bottom:0;transform:translateX(-50%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.bd-ptlab{position:absolute;top:0;transform:translate(-50%,-100%);font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.bd-tip{position:absolute;top:2px;transform:translateX(-50%);z-index:3;pointer-events:none;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 6px 18px -12px rgba(15,17,21,.55);font-size:10.5px;line-height:14px;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-tip b{color:var(--dsw-alias-label-primary,#0f1115)}',
      // ── numbers ───────────────────────────────────────────────────────────
      '.bd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:4px 12px}',
      '.bd-kv{display:flex;align-items:baseline;gap:6px;font-size:11.5px}',
      '.bd-kv span{color:var(--dsw-alias-label-caption,#81858c)}',
      '.bd-kv b{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}',
      '.bd-bp{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.bd-etfs{display:flex;flex-direction:column;gap:1px}',
      '.bd-etf{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:6px;font-size:11.5px}',
      '.bd-etf:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
      '.bd-etfname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.bd-code{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.bd-px{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.bd-chg{flex:none;width:62px;text-align:right;font-variant-numeric:tabular-nums}',
      '.bd-up{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.bd-down{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.bd-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.bd-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.bd-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num
  const toNum = (value) => (num(value) === undefined ? null : value)

  /**
   * One line chart, used for the term structure AND both time series — a yield
   * curve is a line chart whose x axis happens to be tenors instead of dates, so
   * one component with a `formatX` is enough and keeps them looking identical.
   *
   * Same SVG technique as the market candles: the drawing stretches to the card
   * (`preserveAspectRatio="none"`), every stroke opts out with
   * `vector-effect="non-scaling-stroke"`, and every label is HTML positioned by
   * percentage so text never inherits the stretch.
   */
  function BondLine(props) {
    const lang = props.lang
    const zh = lang === 'zh'
    const [hover, setHover] = React.useState(null)
    const points = (Array.isArray(props.points) ? props.points : [])
      .map((point) => ({ ...point, value: toNum(point.value) }))
      .filter((point) => point.value !== null)
    const n = points.length
    if (n === 0) {
      return jsx('div', { className: 'bd-msg', children: props.empty ?? (zh ? '暂无数据' : 'no data') })
    }

    const W = 720
    const H = props.height ?? 120
    const TOP = 8
    const BOTTOM = H - 16
    let hi = -Infinity
    let lo = Infinity
    for (const point of points) {
      if (point.value > hi) hi = point.value
      if (point.value < lo) lo = point.value
    }
    if (hi === lo) {
      hi += 0.05
      lo -= 0.05
    }
    const pad = (hi - lo) * 0.12
    hi += pad
    lo -= pad

    const slot = W / Math.max(1, n - 1)
    const xAt = (index) => index * slot
    const yAt = (value) => TOP + ((hi - value) / (hi - lo)) * (BOTTOM - TOP)
    const line = points.map((point, index) => `${xAt(index).toFixed(2)},${yAt(point.value).toFixed(2)}`).join(' ')
    const area = `0,${BOTTOM} ${line} ${W},${BOTTOM}`
    const color = props.color ?? BD_CN
    const gradientId = props.gradientId ?? 'bd-fill'
    const hovered = hover === null ? null : points[hover]
    // Only label every dot when there are few enough that the labels do not
    // collide; a 45-point series gets its values in the tooltip instead.
    const showPointLabels = props.labelPoints === true && n <= 12

    return jsxs('div', { className: 'bd-chart', children: [
      jsxs('svg', {
        className: 'bd-svg',
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': props.ariaLabel ?? 'chart',
        onMouseLeave: () => setHover(null),
        children: [
          jsx('defs', { children: // `jsxs`, not `jsx`: this element has an ARRAY of children, and React's
          // non-static path validates each keyless child in an array — which is
          // the warning the browser test caught here.
          jsxs('linearGradient', {
            id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1,
            children: [
              jsx('stop', { offset: '0%', stopColor: color, stopOpacity: 0.22 }, 'top'),
              jsx('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }, 'bottom'),
            ],
          }) }),
          ...[0, 0.5, 1].map((fraction) => jsx('line', {
            x1: 0, x2: W, y1: TOP + (BOTTOM - TOP) * fraction, y2: TOP + (BOTTOM - TOP) * fraction,
            stroke: 'var(--dsw-alias-border-l1,rgba(0,0,0,.07))',
            strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke',
          }, `g${fraction}`)),
          jsx('polygon', { points: area, fill: `url(#${gradientId})` }),
          jsx('polyline', {
            points: line, fill: 'none', stroke: color, strokeWidth: 1.6,
            strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
          }),
          ...points.map((point, index) => jsx('circle', {
            cx: xAt(index), cy: yAt(point.value), r: n <= 12 ? 2.6 : 0,
            fill: 'var(--dsw-alias-bg-layer-1,#fff)', stroke: color, strokeWidth: 1.4,
            vectorEffect: 'non-scaling-stroke',
          }, `d${index}`)),
          hovered
            ? jsx('line', {
                x1: xAt(hover), x2: xAt(hover), y1: TOP, y2: BOTTOM,
                stroke: 'var(--dsw-alias-label-caption,#81858c)', strokeWidth: 1,
                strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke',
              }, 'guide')
            : null,
          ...points.map((point, index) => jsx('rect', {
            x: xAt(index) - slot / 2, y: 0, width: slot, height: H, fill: 'transparent',
            onMouseEnter: () => setHover(index),
          }, `hit${index}`)),
        ],
      }),
      jsx('span', { className: 'bd-ylab', style: { top: `${(TOP / H) * 100}%` }, children: hi.toFixed(2) }),
      jsx('span', { className: 'bd-ylab', style: { top: `${(BOTTOM / H) * 100}%` }, children: lo.toFixed(2) }),
      ...(showPointLabels
        ? points.map((point, index) => jsx('span', {
            className: 'bd-ptlab',
            style: { left: `${Math.min(94, Math.max(6, (xAt(index) / W) * 100))}%`, top: `${(yAt(point.value) / H) * 100}%` },
            children: point.value.toFixed(2),
          }, `l${index}`))
        : []),
      jsx('span', { className: 'bd-xlab', style: { left: '6%' }, children: props.formatX ? props.formatX(points[0], 0) : points[0].label }),
      n > 2
        ? jsx('span', { className: 'bd-xlab', style: { left: '50%' }, children: props.formatX ? props.formatX(points[Math.floor(n / 2)], Math.floor(n / 2)) : points[Math.floor(n / 2)].label })
        : null,
      n > 1
        ? jsx('span', { className: 'bd-xlab', style: { left: '94%' }, children: props.formatX ? props.formatX(points[n - 1], n - 1) : points[n - 1].label })
        : null,
      hovered
        ? jsxs('div', {
            className: 'bd-tip',
            style: { left: `${Math.min(86, Math.max(14, (xAt(hover) / W) * 100))}%` },
            children: [
              jsx('b', { children: props.formatX ? props.formatX(hovered, hover) : hovered.label }),
              ' ',
              hovered.value.toFixed(4),
              props.unit ? ` ${props.unit}` : '',
            ],
          })
        : null,
    ] })
  }

  /** The card. */
  function BondCard(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [kline, setKline] = React.useState(null)
    const [klineError, setKlineError] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const aliveRef = React.useRef(true)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    /**
     * The candles are their OWN request, not part of `/state`: a K-line is
     * fetched when the selection changes and on a slower clock than the
     * summary, so folding it into the summary would refetch 240 candles every
     * time the card polls.
     */
    const loadKline = React.useCallback((secid, period, force) => {
      if (!secid) return
      const url = `/dsh-hud/bond/kline?secid=${encodeURIComponent(secid)}&period=${encodeURIComponent(period ?? 'day')}${force ? '&refresh=1' : ''}`
      hud.fetchJson(url).then((json) => {
        if (!aliveRef.current) return
        setKline(json)
        setKlineError(json?.ok === false ? (json.error ?? 'kline failed') : null)
      }, (failure) => {
        if (aliveRef.current) setKlineError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/bond/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
        // The FIRST summary decides which instrument the K-line is for; after
        // that the selection is the user's and this never overrides it.
        loadKline(json?.chart, json?.chartPeriod, false)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [loadKline])

    const pollMs = clamp(num(snapshot?.pollMs) ?? BD_FALLBACK_MS, BD_MIN_MS, BD_MAX_MS)

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    React.useEffect(() => {
      let stop
      try {
        stop = typeof props.startTimers === 'function'
          ? props.startTimers(poll, pollMs, undefined, 0)
          : (() => {
              const id = window.setInterval(poll, pollMs)
              return () => window.clearInterval(id)
            })()
      } catch (failure) {
        console.error('[bd] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, pollMs, props.startTimers])

    const refresh = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        const json = await hud.fetchJson('/dsh-hud/bond/refresh', { method: 'POST' })
        if (aliveRef.current) {
          setSnapshot(json)
          setError(null)
        }
        loadKline(json?.chart, json?.chartPeriod, true)
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy, loadKline])

    /**
     * Switching instrument or period writes the choice to the HOST (it survives
     * a reload) and refetches that instrument's candles — the selection is host
     * state because the K-line cache lives there too.
     */
    const choose = React.useCallback(async (patch) => {
      try {
        const json = await hud.fetchJson('/dsh-hud/bond/chart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!aliveRef.current) return
        setSnapshot(json)
        loadKline(json?.chart, json?.chartPeriod, false)
      } catch (failure) {
        if (aliveRef.current) setKlineError(failure instanceof Error ? failure.message : String(failure))
      }
    }, [loadKline])
    const chooseChart = (secid) => choose({ secid })
    const choosePeriod = (value) => choose({ period: value })


    const cn = snapshot?.cn ?? {}
    const stamp = snapshot?.fetchedAt
      ? new Date(snapshot.fetchedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false })
      : null

    return jsxs('div', { className: 'bd-root', 'data-panel': 'bond', children: [
      jsxs('div', { className: 'bd-head', children: [
        jsx('span', { className: 'bd-title', children: zh ? '债市' : 'Bonds' }),
        jsx('span', { className: 'bd-secnote', children: cn.date
          ? (zh ? `中债曲线 ${cn.date}` : `CN curve ${cn.date}`)
          : (zh ? '中债曲线 --' : 'CN curve --') }),
        jsxs('span', { className: 'bd-right', children: [
          stamp ? jsx('span', { children: stamp }) : null,
          jsx('button', { type: 'button', className: 'bd-btn', onClick: refresh, disabled: busy, children: busy ? (zh ? '刷新中' : 'loading') : (zh ? '刷新' : 'refresh') }),
        ] }),
      ] }),
      error ? jsx('div', { className: 'bd-msg is-err', children: error }) : null,

      // ── the headline: the term structure ──────────────────────────────────
      jsxs('div', { className: 'bd-sec', children: [
        jsxs('div', { className: 'bd-sechead', children: [
          jsx('span', { className: 'bd-seclabel', children: zh ? '国债收益率曲线（期限结构）' : 'GOVERNMENT CURVE' }),
          jsx('span', { className: 'bd-secnote', children: zh ? '中债国债，单位 %' : 'China government, %' }),
        ] }),
        cn.error
          ? jsx('div', { className: 'bd-msg is-err', children: cn.error })
          : jsx(BondLine, {
              lang,
              points: cn.curve ?? [],
              formatX: (point) => point.label,
              height: 118,
              labelPoints: true,
              color: BD_CN,
              gradientId: 'bd-cn',
              unit: '%',
              ariaLabel: zh ? '国债收益率曲线' : 'government yield curve',
              empty: zh ? '没有拿到中债曲线' : 'no CN curve',
            }),
      ] }),

      // ── the K-line: 实时 / 5分 / 15分 / 60分 / 日K / 周K / 月K ────────────
      // The CN YIELD CURVE cannot be candled (the host's banner explains the
      // measured limits), so this charts what CAN be: the domestic bond ETFs.
      jsxs('div', { className: 'bd-sec', children: [
        jsxs('div', { className: 'bd-sechead', children: [
          jsx('span', { className: 'bd-seclabel', children: zh ? 'K 线' : 'CANDLES' }),
          jsx('span', { className: 'bd-secnote', children: zh ? '场内价格：涨 = 收益率下行' : 'price: up = yields down' }),
          jsxs('span', { className: 'bd-kv', children: [
            jsx('span', { children: zh ? '10Y' : '10Y' }),
            jsx('b', { children: num(cn.ten) === undefined ? '--' : `${cn.ten.toFixed(3)}%` }),
          ] }),
        ] }),
        jsx('span', { className: 'bd-charts', children: (snapshot?.charts ?? []).map((entry) => jsx('button', {
          type: 'button',
          className: `bd-btn is-quiet${entry.secid === snapshot?.chart ? ' is-on' : ''}`,
          onClick: () => chooseChart(entry.secid),
          children: entry.name,
        }, entry.secid)) }),
        klineError
          ? jsx('div', { className: 'bd-msg is-err', children: klineError })
          : kline === null
            ? jsx('div', { className: 'bd-msg', children: zh ? '正在取 K 线…' : 'loading candles…' })
            : jsx('div', { className: 'bd-kline', children: jsx(hud.CandleChart, {
                lang,
                candles: kline.candles ?? [],
                // A bond ETF price needs three decimals to say anything (134.804).
                decimals: 3,
                height: 176,
                period: snapshot?.chartPeriod ?? kline.period,
                periods: snapshot?.periods ?? [],
                onPeriod: (value) => choosePeriod(value),
                ariaLabel: zh ? '债市 K 线图' : 'bond candlestick chart',
                empty: zh ? '这只标的没有 K 线数据' : 'no candles',
              }) }),
      ] }),

      // ── tradeable proxies ─────────────────────────────────────────────────
      (snapshot?.etfs ?? []).length > 0
        ? jsxs('div', { className: 'bd-sec', children: [
            jsx('span', { className: 'bd-sechead', children: jsx('span', { className: 'bd-seclabel', children: zh ? '国债 ETF' : 'BOND ETFs' }) }),
            jsx('div', { className: 'bd-etfs', children: (snapshot?.etfs ?? []).map((etf) => jsxs('div', { className: 'bd-etf', children: [
              jsx('span', { className: 'bd-etfname', children: etf.name }),
              jsx('span', { className: 'bd-code', children: etf.code }),
              jsx('span', { className: 'bd-px', children: num(etf.price) === undefined ? '--' : etf.price.toFixed(3) }),
              jsx('span', {
                className: `bd-chg ${num(etf.changePct) === undefined || etf.changePct === 0 ? '' : etf.changePct > 0 ? 'bd-up' : 'bd-down'}`,
                children: num(etf.changePct) === undefined ? '--' : `${etf.changePct > 0 ? '+' : ''}${etf.changePct.toFixed(2)}%`,
              }),
            ] }, etf.secid)) }),
          ] })
        : null,
    ] })
  }

  return {
    id: 'bond',
    order: 60,
    // ONE column by default: the row holds three, and the share panel asks for
    // two of them — see the shell's single-row rule. Widen it in ⚙ if you would
    // rather give the curve the room and shrink the share card.
    span: 1,
    label: { zh: '债市', en: 'Bonds' },
    Component: BondCard,
    __test: { BondCard, BondLine },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/futures/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › 期货 panel — browser half.
//
// THE THREE THINGS THAT MAKE THIS A FUTURES VIEW RATHER THAN A STOCK LIST, all visible on screen:
//
//   1. every row is a 主连 (main-continuous) contract, so the liquid month is whoever it is today;
//   2. 持仓量 sits beside the price, because it is the number that says whether a move is new
//      money or the same money changing hands — and a stock has no such number;
//   3. the 期限结构 strip under the chart: every listed month of the selected product, which is
//      how 升水/贴水 is read. Nothing here has a stock equivalent.
//
// The chart is the shell's shared `CandleChart` — the same one the 股市 and 债市 views draw with,
// so a candle looks the same wherever it appears in this HUD.

/**
 * The contracts a filter leaves.
 *
 * Matches the short label, the name the exchange reports, the code and the secid — because `rb` is
 * what someone who trades this types and 螺纹钢 is what someone who does not. Both have to work, and
 * neither is a guess about the other.
 *
 * A hook rather than an inline `useMemo` because TWO places need the same answer: the list, and the
 * "showing 3 / 69" counter beside the box. A counter computed from a different filter than the list
 * is a counter that lies.
 */
function useFilteredContracts(contracts, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  return React.useMemo(() => {
    if (needle === '') return contracts ?? []
    return (contracts ?? []).filter((row) => [row.short, row.name, row.code, row.secid]
      .some((field) => String(field ?? '').toLowerCase().includes(needle)))
  }, [contracts, needle])
}

function FuturesRows(props) {
  const { contracts, sectors, selected, onSelect, zh, query, favorites, onStar } = props
  const starred = React.useMemo(() => new Set(favorites ?? []), [favorites])
  const shown = useFilteredContracts(contracts, query)
  // Grouped by sector in the order the host declares, and a contract whose sector is unknown
  // lands in a trailing group rather than disappearing: a row that vanishes is indistinguishable
  // from a row that was never there.
  const groups = React.useMemo(() => {
    const bySector = new Map()
    for (const row of shown) {
      const key = sectors.includes(row.sector) ? row.sector : '其他'
      if (!bySector.has(key)) bySector.set(key, [])
      bySector.get(key).push(row)
    }
    return [...bySector.entries()]
  }, [shown, sectors])

  // 收藏 goes FIRST, above the sectors: it is a statement about what matters to the reader, and
  // the sector order is a statement about the exchange. Only rendered when it has something in it —
  // an empty group with a heading is a promise the card cannot keep.
  const groupsToDraw = React.useMemo(() => {
    const starred = (contracts ?? []).filter((row) => (favorites ?? []).includes(row.secid))
    return starred.length === 0 ? groups : [['★ 收藏', starred], ...groups]
  }, [groups, contracts, favorites])

  const drawRow = (row) => {
    const up = (row.changePercent ?? 0) >= 0
    const isStarred = starred.has(row.secid)
    return jsxs('div', {
      className: `ft-line${isStarred ? ' is-starred' : ''}`,
      children: [
        jsxs('button', {
          type: 'button',
          className: `ft-row${row.secid === selected ? ' is-on' : ''}`,
          'data-secid': row.secid,
          'data-act': 'select',
          onClick: () => onSelect(row.secid),
          children: [
            jsx('span', { className: 'ft-name', title: row.name, children: row.short }),
            jsx('span', { className: 'ft-price', children: row.price === undefined ? '—' : fmt(row.price) }),
            jsx('span', {
              className: `ft-chg ${up ? 'is-up' : 'is-down'}`,
              children: row.changePercent === undefined ? '—' : `${up ? '+' : ''}${row.changePercent.toFixed(2)}%`,
            }),
            // 持仓量 and 成交量, in that order: open interest is the futures number, volume is the
            // one every market has, and leading with the ordinary one would be a stock panel
            // wearing a futures title.
            jsx('span', {
              className: 'ft-oi',
              title: zh ? '持仓量' : 'open interest',
              children: row.openInterest === undefined ? '—' : compact(row.openInterest),
            }),
            // 仓差, in its own column and coloured like the price change, because that is how it
            // reads: green/red says which way the money moved, the sign says in or out.
            jsx('span', {
              className: `ft-doi ${(row.openInterestChange ?? 0) >= 0 ? 'is-up' : 'is-down'}`,
              title: zh ? '仓差 · 持仓量较昨日的变化' : 'open-interest change',
              children: row.openInterestChange === undefined
                ? '—'
                : `${row.openInterestChange >= 0 ? '+' : ''}${compact(row.openInterestChange)}`,
            }),
            jsx('span', {
              className: 'ft-vol',
              title: zh ? '成交量' : 'volume',
              children: row.volume === undefined ? '—' : compact(row.volume),
            }),
          ],
        }, row.secid),
        jsx('button', {
          type: 'button',
          className: `ft-star${isStarred ? ' is-on' : ''}`,
          'data-act': 'star',
          'data-secid': row.secid,
          'aria-pressed': isStarred ? 'true' : 'false',
          title: isStarred ? (zh ? '取消收藏' : 'unstar') : (zh ? '收藏' : 'star'),
          // The label is the star; the state is in aria-pressed. A button whose only content is a
          // symbol says nothing to a screen reader without one of the two.
          'aria-label': `${isStarred ? (zh ? '取消收藏' : 'unstar') : (zh ? '收藏' : 'star')} ${row.short}`,
          onClick: () => onStar(row.secid, !isStarred),
          children: isStarred ? '★' : '☆',
        }),
      ],
    }, row.secid)
  }

  return jsx('div', { className: 'ft-list', children: groupsToDraw.map(([sector, rows]) => jsxs('div', {
    className: `ft-group${sector.startsWith('★') ? ' is-favorites' : ''}`,
    children: [
      jsx('div', { className: 'ft-grouphead', children: sector }),
      ...rows.map(drawRow),
    ],
  }, sector)) })
}

/**
 * 量仓关系: what the price change and the open-interest change say TOGETHER.
 *
 * Four combinations, and the two that matter most are the ones people get wrong: 增仓上涨 is new
 * money pushing the price (the trend has fuel), 减仓上涨 is shorts closing (the fuel is leaving).
 * Same direction, opposite meaning — which is the whole reason a futures panel shows 仓差 at all.
 */
function verdictOf(row, zh) {
  const up = (row?.changePercent ?? 0) >= 0
  const adding = (row?.openInterestChange ?? 0) >= 0
  if (row?.openInterestChange === undefined) return zh ? '—' : '—'
  if (up && adding) return zh ? '增仓上涨' : 'up, OI up'
  if (up && !adding) return zh ? '减仓上涨' : 'up, OI down'
  if (!up && adding) return zh ? '增仓下跌' : 'down, OI up'
  return zh ? '减仓下跌' : 'down, OI down'
}

/** A price without a fixed number of decimals: gold is 910.58 and 沪铜 is 109680. */
function fmt(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10000) return value.toFixed(0)
  if (Math.abs(value) >= 1000) return value.toFixed(1)
  return value.toFixed(2)
}

/** 1592266 → 159万 — an open interest is read for its magnitude, not its last digit. */
function compact(value) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(Math.round(value))
}

/**
 * 期限结构: the listed months of one product, front to back.
 *
 * The bar is the price relative to the front month, so the SHAPE of the curve is visible without
 * reading twelve numbers: rising to the right is 升水 (later delivery costs more), falling is
 * 贴水. The months are whatever the exchange lists, which is the point — nothing here decides
 * which months matter.
 */
function TermStructure(props) {
  const { curve, zh } = props
  if (curve === undefined || curve === null) {
    return jsx('div', { className: 'ft-curve is-loading', children: zh ? '读取月份…' : 'loading months…' })
  }
  if (curve.error !== undefined) {
    return jsx('div', { className: 'ft-curve is-err', children: curve.error })
  }
  if (curve.note !== undefined) {
    return jsx('div', { className: 'ft-curve is-note', children: curve.note })
  }
  const months = curve.months ?? []
  if (months.length === 0) {
    return jsx('div', { className: 'ft-curve is-note', children: zh ? '没有月份序列' : 'no listed months' })
  }
  const front = months[0].price
  const prices = months.map((one) => one.price).filter(Number.isFinite)
  const high = Math.max(...prices)
  const low = Math.min(...prices)
  const span = high - low || 1
  return jsxs('div', { className: 'ft-curve', children: [
    jsxs('div', { className: 'ft-curvehead', children: [
      jsx('span', { children: zh ? '期限结构' : 'term structure' }),
      // The direction is stated rather than left to the reader: 升水 and 贴水 are the two words a
      // futures desk uses, and a reader who has to infer the sign from a bar chart will not.
      jsx('span', { className: months.at(-1).price >= front ? 'is-up' : 'is-down', children: zh
        ? (months.at(-1).price >= front ? '远月升水' : '远月贴水')
        : (months.at(-1).price >= front ? 'contango' : 'backwardation') }),
    ] }),
    jsxs('div', { className: 'ft-curvebody', children: months.map((one) => jsxs('div', {
      className: 'ft-month',
      title: `${one.code}  ${fmt(one.price)}  ${one.openInterest === undefined ? '' : `持仓 ${compact(one.openInterest)}`}`,
      children: [
        jsx('span', { className: 'ft-mlabel', children: one.month }),
        jsx('span', { className: 'ft-mbar', children: jsx('span', {
          className: 'ft-mfill',
          style: { width: `${20 + 80 * ((one.price - low) / span)}%` },
        }) }),
        jsx('span', { className: 'ft-mprice', children: fmt(one.price) }),
      ],
    }, one.code)) }),
  ] })
}

function FuturesCard(props) {
  const { startTimers } = props
  // `hud` is the shell's shared toolkit and is in scope for every fragment — it is NOT a prop.
  //
  // Reading it from props is what made this card throw on its first poll:
  // `Cannot read properties of undefined (reading 'fetchJson')`. The SQL card has always called
  // `hud.fetchJson(...)` directly, and that is the convention: the shell declares the toolkit once
  // and every panel uses it. The language comes from `hud.pickLocale()` for the same reason.
  const zh = hud.pickLocale() === 'zh'
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState('')
  const [period, setPeriod] = React.useState('day')
  const [chart, setChart] = React.useState(null)
  const [curve, setCurve] = React.useState(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  /** The filter box. Component state on purpose: a search is not a preference, and it must not be
   *  still there tomorrow. Sixty-nine contracts is a list nobody reads; typing `rb` or `螺纹` is. */
  const [query, setQuery] = React.useState('')
  /**
   * The starred list, held locally for instant feedback and replaced by the server's answer.
   *
   * A star that waits for a round trip before it fills in feels broken on a slow link, and one that
   * keeps only the local answer drifts the moment two tabs are open. So: set it now, send it, and
   * take whatever comes back.
   */
  const [favorites, setFavorites] = React.useState(null)
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const read = React.useCallback(async (force = false) => {
    try {
      const json = await hud.fetchJson(`/dsh-hud/futures/${force ? 'refresh' : 'state'}`, force ? { method: 'POST' } : undefined)
      if (!aliveRef.current) return
      setSnapshot(json)
      setSelected((current) => current !== '' ? current : (json?.contracts?.[0]?.secid ?? ''))
      setError(null)
    } catch (failure) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  React.useEffect(() => {
    read(false).catch(() => {})
    const tick = () => { read(true).catch(() => {}) }
    // `startTimers` when the shell provides it: that is the timer that knows about a hidden tab,
    // and a futures card polling an exchange from a tab nobody is looking at is exactly the
    // traffic this panel spends its effort not making.
    if (typeof startTimers === 'function') {
      const stop = startTimers(tick, snapshot?.pollMs ?? 60_000)
      return () => { if (typeof stop === 'function') stop() }
    }
    const stop = setInterval(tick, snapshot?.pollMs ?? 60_000)
    return () => clearInterval(stop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, snapshot?.pollMs])

  // The chart follows the selection and the period, and both can change faster than the request
  // completes — so a late answer for the previous selection is dropped rather than drawn.
  React.useEffect(() => {
    if (selected === '') return undefined
    let live = true
    setChart(null)
    hud.fetchJson(`/dsh-hud/futures/kline?secid=${encodeURIComponent(selected)}&period=${period}`)
      .then((json) => { if (live) setChart(json) })
      .catch((failure) => { if (live) setChart({ ok: false, error: failure instanceof Error ? failure.message : String(failure) }) })
    return () => { live = false }
  }, [selected, period])

  React.useEffect(() => {
    if (selected === '') return undefined
    let live = true
    setCurve(null)
    hud.fetchJson(`/dsh-hud/futures/curve?secid=${encodeURIComponent(selected)}`)
      .then((json) => { if (live) setCurve(json) })
      .catch((failure) => { if (live) setCurve({ error: failure instanceof Error ? failure.message : String(failure) }) })
    return () => { live = false }
  }, [selected])

  // The server's list wins whenever it arrives; the local one covers the gap until then.
  React.useEffect(() => {
    if (Array.isArray(snapshot?.favorites)) setFavorites(snapshot.favorites)
  }, [snapshot?.favorites])

  const toggleStar = (secid, on) => {
    setFavorites((current) => {
      const list = current ?? []
      return on ? (list.includes(secid) ? list : [...list, secid]) : list.filter((one) => one !== secid)
    })
    hud.fetchJson('/dsh-hud/futures/favorite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secid, on }),
    }).then((json) => {
      if (Array.isArray(json?.favorites)) setFavorites(json.favorites)
    }).catch(() => {})
  }

  const contracts = snapshot?.contracts ?? []
  // The same filter the list uses, so the counter cannot disagree with what is on screen.
  const shown = useFilteredContracts(contracts, query)
  const session = snapshot?.session ?? {}
  const selectedRow = contracts.find((one) => one.secid === selected)
  const stamp = snapshot?.now === undefined ? '' : new Date(snapshot.now).toLocaleTimeString('zh-CN', { hour12: false })

  return jsxs('div', { className: 'ft-root', children: [
    jsxs('div', { className: 'ft-head', children: [
      jsx('span', { className: 'ft-title', children: zh ? '期货' : 'Futures' }),
      // The session chips name the EXCHANGE GROUPS, not the products: the night windows differ
      // per group and a chip per product would be sixty chips.
      jsxs('span', { className: 'ft-sessions', children: [
        ['cffex', '中金所'], ['metal', '金属'], ['bulk', '商品'], ['global', '外盘'],
      ].map(([key, name]) => {
        const one = session[key] ?? {}
        const why = one.closed === 'holiday' && one.closedLabel ? ` ${one.closedLabel}` : ''
        return jsx('span', {
          className: `ft-sess${one.open ? ' is-open' : ''}${one.tradingDay === false ? ' is-off' : ''}`,
          title: [name, one.time, one.night === true ? (zh ? '有夜盘' : 'night') : '', why.trim()].filter(Boolean).join(' '),
          children: `${name}${why}`,
        }, key)
      }) }),
      jsxs('span', { className: 'ft-right', children: [
        stamp === '' ? null : jsx('span', { className: 'ft-stamp', children: stamp }),
        jsx('button', {
          type: 'button',
          className: 'ft-btn',
          'data-act': 'refresh',
          onClick: () => { read(true).catch(() => {}) },
          children: zh ? '刷新' : 'Refresh',
        }),
      ] }),
    ] }),

    error === null ? null : jsx('span', { className: 'ft-err', role: 'alert', children: error }),
    // The upstream's complaint is reported instead of an empty list: "no contracts" and "the
    // endpoint refused" are different problems and must not look the same.
    snapshot?.error === undefined || snapshot.error === null
      ? null
      : jsx('span', { className: 'ft-err', children: snapshot.error }),

    // ── the filter ──
    //
    // Above the list, full width, and it filters as you type. Not a search ROUTE: the sixty-nine
    // rows are already in memory, and a round trip to narrow a list you are holding would be
    // slower than typing and would stop working the moment the network does.
    jsxs('label', { className: 'ft-filter', children: [
      jsx('span', { className: 'ft-filter-icon', 'aria-hidden': true, children: '⌕' }),
      jsx('input', {
        type: 'search',
        className: 'ft-filter-input',
        value: query,
        spellCheck: false,
        'data-act': 'filter',
        placeholder: zh ? '搜索合约：螺纹钢 / rb / 沪深' : 'filter: 螺纹钢 / rb / 沪深',
        'aria-label': zh ? '搜索期货合约' : 'filter contracts',
        onChange: (event) => setQuery(event.target.value),
      }),
      query === ''
        ? null
        : jsx('span', {
            className: 'ft-filter-count',
            children: `${shown.length} / ${contracts.length}`,
          }),
    ] }),

    jsx(FuturesRows, {
      contracts,
      sectors: snapshot?.sectors ?? [],
      selected,
      onSelect: setSelected,
      zh,
      query,
      favorites: favorites ?? snapshot?.favorites ?? [],
      onStar: toggleStar,
    }),

    jsxs('div', { className: 'ft-detail', children: [
      jsxs('div', { className: 'ft-detailhead', children: [
        jsx('span', { className: 'ft-dname', children: selectedRow?.name ?? (zh ? '选择合约' : 'pick a contract') }),
        selectedRow?.openInterest === undefined ? null : jsxs('span', { className: 'ft-dmeta', children: [
          jsx('span', { children: `${zh ? '持仓' : 'OI'} ${compact(selectedRow.openInterest)}` }),
          jsx('span', { children: `${zh ? '成交' : 'vol'} ${compact(selectedRow.volume)}` }),
          // 量仓关系 — the four-way reading, said in words.
          //
          // Open interest alone says how many contracts are open; the CHANGE says whether a move is
          // new money or the same money changing hands. 增仓上涨 is the strong one (new longs are
          // paying up), 减仓上涨 is the weak one (shorts covering), and the two falling readings
          // differ the same way. A trader reads this before the price.
          jsx('span', {
            className: 'ft-verdict',
            title: zh ? '量仓关系' : 'price vs open interest',
            children: verdictOf(selectedRow, zh),
          }),
        ] }),
        jsxs('span', { className: 'ft-periods', children: (snapshot?.periods ?? []).map((one) => jsx('button', {
          type: 'button',
          className: `ft-period${one.value === period ? ' is-on' : ''}`,
          'data-period': one.value,
          onClick: () => setPeriod(one.value),
          children: zh ? one.label : one.labelEn,
        }, one.value)) }),
      ] }),
      chart === null
        ? jsx('div', { className: 'ft-chart is-loading', children: zh ? '读取K线…' : 'loading candles…' })
        : chart.ok === false
          ? jsx('div', { className: 'ft-chart is-err', children: chart.error })
          : jsx(CandleChart, {
              candles: chart.candles,
              height: 168,
              label: zh ? `${chart.name} ${chart.period}` : `${chart.name} ${chart.period}`,
            }),
      jsx(TermStructure, { curve, zh }),
    ] }),
  ] })
}

function createFuturesPanel() {
  if (document.querySelector('style[data-plugin="dsh-hud-futures"]') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud-futures'
    tag.textContent = [
      '.ft-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.ft-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.ft-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ft-sessions{display:inline-flex;align-items:center;gap:5px}',
      '.ft-sess{padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-sess.is-open{border-color:rgba(34,160,107,.4);color:#1a7f52;background:rgba(34,160,107,.08)}',
      '.ft-sess.is-off{text-decoration:line-through;opacity:.75}',
      '.ft-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.ft-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      // The filter box: full width, above the list, small enough not to cost a row.
      '.ft-filter{display:flex;align-items:center;gap:5px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.ft-filter-icon{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-filter-input{flex:1 1 auto;min-width:0;height:22px;border:0;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:inherit;outline:none}',
      '.ft-filter-count{flex:none;font-size:10px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.ft-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // The list scrolls INSIDE its own box: this card is a grid cell, and a list that grew with
      // its contents would push the chart out of the cell it was measured for.
      '.ft-list{display:flex;flex-direction:column;gap:4px;max-height:190px;overflow-y:auto;padding-right:2px;scrollbar-width:thin}',
      // A row is two sibling buttons, not a button inside a button: the browser silently
      // repairs nested buttons, which is how a control ends up existing and not working.
      '.ft-line{display:grid;grid-template-columns:1fr auto;gap:2px;align-items:center;border-radius:5px}',
      '.ft-line.is-starred{background:rgba(217,161,59,.09)}',
      '.ft-star{flex:none;padding:0 5px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer}',
      '.ft-star:hover{color:#d9a13b}',
      '.ft-star.is-on{color:#d9a13b}',
      '.ft-group.is-favorites .ft-grouphead{color:#d9a13b}',
      '.ft-group{display:flex;flex-direction:column;gap:1px}',
      '.ft-grouphead{font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c);padding:3px 2px 1px}',
      '.ft-row{display:grid;grid-template-columns:minmax(46px,1fr) minmax(50px,.85fr) minmax(44px,.75fr) minmax(42px,.7fr) minmax(44px,.75fr) minmax(46px,.8fr);gap:5px;align-items:center;width:100%;padding:1px 4px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11px;line-height:16px;color:inherit;text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.ft-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
      '.ft-row.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.ft-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ft-price,.ft-oi,.ft-vol,.ft-chg{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ft-oi,.ft-vol{color:var(--dsw-alias-label-caption,#81858c);font-size:10.5px}',
      '.ft-doi{text-align:right;font-size:10.5px}',
      '.ft-doi.is-up{color:#d0503f}',
      '.ft-doi.is-down{color:#1f9463}',
      '.ft-doi-spacer{display:none}',
      // 红涨绿跌 — the domestic convention, the same pair the shell's chart uses.
      '.ft-chg.is-up{color:#d0503f}',
      '.ft-chg.is-down{color:#1f9463}',
      '.ft-detail{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.ft-detailhead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.ft-dname{font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ft-dmeta{display:inline-flex;gap:7px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.ft-periods{margin-left:auto;display:inline-flex;gap:3px;flex:none}',
      '.ft-period{padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.ft-period.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.ft-chart{min-height:168px}',
      '.ft-chart.is-loading,.ft-chart.is-err,.ft-curve.is-loading,.ft-curve.is-err,.ft-curve.is-note{font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-chart.is-err,.ft-curve.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.ft-curve{display:flex;flex-direction:column;gap:3px}',
      '.ft-curvehead{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-curvehead .is-up{color:#d0503f}',
      '.ft-curvehead .is-down{color:#1f9463}',
      '.ft-curvebody{display:flex;flex-direction:column;gap:1px}',
      '.ft-month{display:grid;grid-template-columns:38px 1fr auto;gap:6px;align-items:center;font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums}',
      '.ft-mlabel{color:var(--dsw-alias-label-caption,#81858c)}',
      '.ft-mbar{display:block;height:7px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));overflow:hidden}',
      '.ft-mfill{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#3964fe,#7aa2ff)}',
      '.ft-mprice{color:var(--dsw-alias-label-secondary,#61666b)}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  return {
    id: 'futures',
    order: 55,
    label: { zh: '期货', en: 'Futures' },
    // One column, like the other two views of this card.
    span: 1,
    // OFF by default: the markets card ships as 股市, and 期货 is a tab away. The card's own
    // switch mounts all three views, so this only decides which one is in front.
    defaultOn: false,
    defaultRows: 8,
    Component: FuturesCard,
    __test: { FuturesCard, FuturesRows, TermStructure, fmt, compact },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/fx/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › 汇率 view — browser half.
//
// A VIEW of the markets card, not a card: it is composed by `panels/markets/client.js` like 股市,
// 债市 and 期货. That distinction matters twice over — a registered panel would get a card and a
// pill of its own (the mistake this card already made once with 期货), and this view needs no host
// of its own at all: it reads `/dsh-hud/market/fx` and `/dsh-hud/market/kline`, routes the 股市
// panel has had all along.
//
// Three groups, because a rate means nothing without knowing what it is quoted AGAINST:
//
//   对人民币     — what one unit costs in yuan (and 100日元, which the board quotes that way)
//   主要货币对   — the majors, which do not involve the yuan at all
//   指数         — 美元指数, the single number a currency desk looks at first
//
// The 100日元 row is labelled as such rather than as 日元: eastmoney quotes the board in 100-yen
// lots, and a rate read as "one yen costs 4.2 yuan" is wrong by two orders of magnitude. Saying
// which unit is being priced is the whole job of a label here.

function FxRows(props) {
  const { rates, groups, selected, onSelect, zh } = props
  const byGroup = React.useMemo(() => {
    const map = new Map()
    for (const rate of rates ?? []) {
      const key = groups.includes(rate.group) ? rate.group : '其他'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(rate)
    }
    return [...map.entries()]
  }, [rates, groups])

  return jsx('div', { className: 'fx-list', children: byGroup.map(([group, rows]) => jsxs('div', {
    className: 'fx-group',
    children: [
      jsx('div', { className: 'fx-grouphead', children: group }),
      ...rows.map((rate) => {
        const up = (rate.changePct ?? 0) >= 0
        return jsxs('button', {
          type: 'button',
          className: `fx-row${rate.secid === selected ? ' is-on' : ''}${rate.index ? ' is-index' : ''}`,
          'data-secid': rate.secid,
          'data-act': 'select',
          onClick: () => onSelect(rate.secid),
          children: [
            jsx('span', { className: 'fx-name', title: rate.nameEn ?? rate.name, children: rate.name }),
            jsx('span', {
              className: 'fx-value',
              children: rate.value === undefined ? '—' : rate.value.toFixed(rate.decimals ?? 4),
            }),
            // Three periods, because one is a ticker and three are a trend. This is the standard
            // shape of a professional rate table: the daily move answers "what happened", the
            // 60-day and year-to-date answers "which way is this going", and neither is readable
            // without the other.
            jsx('span', {
              className: `fx-chg ${up ? 'is-up' : 'is-down'}`,
              children: rate.changePct === undefined ? '—' : `${up ? '+' : ''}${rate.changePct.toFixed(2)}%`,
            }),
            // NOT for the dollar index, and that is a measured decision rather than a hunch.
            //
            // `f24`/`f25` were checked against the K-line for three instruments. For the two FX
            // pairs they match to the hundredth: USDCNH -1.12% / -3.85% against a computed -1.12% /
            // -3.85%, EURUSD -1.43% / -4.21% against -1.43% / -4.21%. For 美元指数 they do not:
            // the fields read -0.10% while 60 days is +0.96% and the year is +3.72% — they merely
            // echo the daily change. A column that is right on twelve rows and wrong on the
            // thirteenth is worse than no column, so the index gets dashes and a reason.
            rate.index === true
              ? jsxs(React.Fragment, { children: [
                  jsx('span', {
                    className: 'fx-chg fx-chg-na',
                    title: zh ? '指数不提供这两个周期' : 'not available for an index',
                    children: '—',
                  }),
                  jsx('span', { className: 'fx-chg fx-chg-na', children: '—' }),
                ] })
              : jsxs(React.Fragment, { children: [
                  jsx('span', {
                    className: `fx-chg fx-chg-60 ${(rate.change60d ?? 0) >= 0 ? 'is-up' : 'is-down'}`,
                    title: zh ? '60 日' : '60 days',
                    children: rate.change60d === undefined ? '—' : `${rate.change60d >= 0 ? '+' : ''}${rate.change60d.toFixed(2)}%`,
                  }),
                  jsx('span', {
                    className: `fx-chg fx-chg-ytd ${(rate.changeYtd ?? 0) >= 0 ? 'is-up' : 'is-down'}`,
                    title: zh ? '年初至今' : 'year to date',
                    children: rate.changeYtd === undefined ? '—' : `${rate.changeYtd >= 0 ? '+' : ''}${rate.changeYtd.toFixed(2)}%`,
                  }),
                ] }),
          ],
        }, rate.secid)
      }),
    ],
  }, group)) })
}

function FxCard(props) {
  const { startTimers } = props
  const zh = hud.pickLocale() === 'zh'
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState('133.USDCNH')
  const [period, setPeriod] = React.useState('day')
  const [chart, setChart] = React.useState(null)
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const read = React.useCallback(async () => {
    try {
      const json = await hud.fetchJson('/dsh-hud/market/fx')
      if (!aliveRef.current) return
      setSnapshot(json)
      setError(null)
    } catch (failure) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  React.useEffect(() => {
    read().catch(() => {})
    // The majors and the index move around the clock on weekdays, so this view has no
    // closed-market arithmetic of its own: the host's cadence already carries it.
    const tick = () => { read().catch(() => {}) }
    if (typeof startTimers === 'function') {
      const stop = startTimers(tick, 60_000)
      return () => { if (typeof stop === 'function') stop() }
    }
    const stop = setInterval(tick, 60_000)
    return () => clearInterval(stop)
  }, [read])

  // The 股市 panel's own kline route — the same one the candlestick chart in that view uses. It
  // validates a secid with the `market.code` shape, which every FX secid here satisfies.
  React.useEffect(() => {
    let live = true
    setChart(null)
    hud.fetchJson(`/dsh-hud/market/kline?secid=${encodeURIComponent(selected)}&period=${period}`)
      .then((json) => { if (live) setChart(json) })
      .catch((failure) => { if (live) setChart({ ok: false, error: failure instanceof Error ? failure.message : String(failure) }) })
    return () => { live = false }
  }, [selected, period])

  const rates = snapshot?.rates ?? []
  const selectedRow = rates.find((one) => one.secid === selected)
  const periods = [
    { value: 'day', zh: '日K', en: 'D' },
    { value: 'week', zh: '周K', en: 'W' },
    { value: 'month', zh: '月K', en: 'M' },
  ]

  return jsxs('div', { className: 'fx-root', children: [
    jsxs('div', { className: 'fx-head', children: [
      jsx('span', { className: 'fx-title', children: zh ? '汇率' : 'FX' }),
      // Said out loud rather than implied: a currency rate is only meaningful against a named
      // base, and this board's base is the yuan (except for the majors, which say so themselves).
      jsx('span', { className: 'fx-base', children: zh ? '离岸人民币为基准' : 'base: offshore CNH' }),
      // The column headings, because three unlabelled percentages in a row are three numbers
      // nobody can tell apart — the first is today, the second is 60 days, the third is the year.
      jsxs('span', { className: 'fx-cols', children: [
        jsx('span', { children: zh ? '1日' : '1D' }),
        jsx('span', { children: zh ? '60日' : '60D' }),
        jsx('span', { children: zh ? '今年' : 'YTD' }),
      ] }),
      jsxs('span', { className: 'fx-right', children: [
        jsx('button', {
          type: 'button',
          className: 'fx-btn',
          'data-act': 'refresh',
          onClick: () => { read().catch(() => {}) },
          children: zh ? '刷新' : 'Refresh',
        }),
      ] }),
    ] }),

    error === null ? null : jsx('span', { className: 'fx-err', role: 'alert', children: error }),

    jsx(FxRows, { rates, groups: snapshot?.groups ?? [], selected, onSelect: setSelected, zh }),

    jsxs('div', { className: 'fx-detail', children: [
      jsxs('div', { className: 'fx-detailhead', children: [
        jsx('span', { className: 'fx-dname', children: selectedRow?.name ?? (zh ? '选择货币' : 'pick a pair') }),
        selectedRow === undefined ? null : jsx('span', {
          className: 'fx-dvalue',
          children: selectedRow.value.toFixed(selectedRow.decimals ?? 4),
        }),
        jsxs('span', { className: 'fx-periods', children: periods.map((one) => jsx('button', {
          type: 'button',
          className: `fx-period${one.value === period ? ' is-on' : ''}`,
          'data-period': one.value,
          onClick: () => setPeriod(one.value),
          children: zh ? one.zh : one.en,
        }, one.value)) }),
      ] }),
      chart === null
        ? jsx('div', { className: 'fx-chart is-loading', children: zh ? '读取K线…' : 'loading candles…' })
        : chart.ok === false
          ? jsx('div', { className: 'fx-chart is-err', children: chart.error })
          : jsx(CandleChart, {
              candles: chart.candles,
              height: 150,
              // The candle chart has no name of its own: the endpoint's `name` is absent for a
              // currency pair (there is no instrument name to report), so the row's label is used.
              label: `${selectedRow?.name ?? chart.secid} ${period}`,
            }),
    ] }),
  ] })
}

function createFxPanel() {
  if (document.querySelector('style[data-plugin="dsh-hud-fx"]') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud-fx'
    tag.textContent = [
      '.fx-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.fx-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.fx-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.fx-base{font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.fx-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none}',
      '.fx-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.fx-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.fx-list{display:flex;flex-direction:column;gap:4px;max-height:196px;overflow-y:auto;padding-right:2px;scrollbar-width:thin}',
      '.fx-group{display:flex;flex-direction:column;gap:1px}',
      '.fx-grouphead{font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c);padding:3px 2px 1px}',
      '.fx-row{display:grid;grid-template-columns:minmax(56px,1fr) auto auto auto auto;gap:6px;align-items:center;width:100%;padding:1px 4px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11px;line-height:16px;color:inherit;text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.fx-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
      '.fx-row.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      // The index is not a pair and is not traded: set apart rather than mixed in with the rates.
      '.fx-row.is-index .fx-name{font-weight:600}',
      '.fx-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fx-value{text-align:right;min-width:56px}',
      '.fx-chg{text-align:right;min-width:44px;font-size:10.5px}',
      '.fx-chg-60,.fx-chg-ytd{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.fx-chg-na{color:var(--dsw-alias-label-caption,#81858c)}',
      '.fx-cols{margin-left:auto;display:inline-flex;gap:6px;font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.fx-cols span{min-width:44px;text-align:right}',
      '.fx-chg.is-up{color:#d0503f}',
      '.fx-chg.is-down{color:#1f9463}',
      '.fx-detail{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.fx-detailhead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.fx-dname{font-size:11.5px;font-weight:600}',
      '.fx-dvalue{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.fx-periods{margin-left:auto;display:inline-flex;gap:3px;flex:none}',
      '.fx-period{padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.fx-period.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.fx-chart{min-height:150px}',
      '.fx-chart.is-loading,.fx-chart.is-err{font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.fx-chart.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  return {
    id: 'fx',
    // 57: after 期货 (55) and before 债市 (60) in any list that sorts panels; the TAB order is the
    // card's own list.
    order: 57,
    label: { zh: '汇率', en: 'FX' },
    span: 1,
    defaultRows: 7,
    Component: FxCard,
    __test: { FxCard, FxRows },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/github/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud — browser half of the `github` panel.
//
// This file is a FRAGMENT: `tools/build-client.mjs` concatenates every
// `panels/<id>/client.js` verbatim into the single `dsh-hud` bundle, inside one
// factory scope. It therefore carries no top-level `import` / `export` /
// `return` — everything lives inside `createGithubPanel()` below, and the
// enclosing scope supplies `React`, `jsx`, `jsxs`, `hud` and `registerPanel`.
//
// The shell owns the dock cell, the card's placement and the tab strip (this
// panel only reports its unread count through `hud.setBadge`). Styling is
// inline CSS over the shell's own `--dsw-alias-*` design tokens so the card
// matches the shipped dock entries without importing their internals.
//
// Behaviour:
//  - sign-in has two paths: the GitHub device flow (a code, a link, and the
//    card polls GitHub's own interval) or a pasted personal access token;
//  - repositories are chosen from the account's OWN repos, and every watched
//    repo gets a page in the feed; several pages carousel on a timer, pause
//    while hovered, and the dots switch them by hand;
//  - the host owns the token and the polling; the card only reads
//    `/dsh-hud/github/state` on the cadence the host reports (`pollMs`).
function createGithubPanel() {
    /** Self-diagnostics, filterable in the console with `ghh`. */
    const dbg = (...args) => {
      try {
        console.log('[ghh]', ...args)
      } catch {
        /* console unavailable */
      }
    }

    // ── constants ──────────────────────────────────────────────────────────
    const CLOCK_MS = 15_000
    const FETCH_TIMEOUT_MS = 20_000
    const DEFAULT_POLL_MS = 60_000
    const MIN_POLL_MS = 20_000
    const DEFAULT_CAROUSEL_MS = 9_000
    const MIN_CAROUSEL_MS = 4_000
    /** Feed rows rendered per page; the body scrolls beyond this. */
    const VISIBLE_ROWS = 6
    /** Sentinel id for the "everything, merged" page. */
    const ALL_PAGE = '__all__'

    /**
     * Event kinds → badge label and tone. `tone` maps to one of the palette
     * classes in the stylesheet; the label is the human word for the row.
     */
    const KINDS = {
      release: { zh: '发布', en: 'release', tone: 'brand' },
      update: { zh: '更新', en: 'update', tone: 'brand' },
      push: { zh: '推送', en: 'push', tone: 'info' },
      branch: { zh: '分支', en: 'branch', tone: 'ok' },
      tag: { zh: '标签', en: 'tag', tone: 'ok' },
      merge: { zh: '合并', en: 'merge', tone: 'ok' },
      pr: { zh: 'PR', en: 'PR', tone: 'info' },
      review: { zh: '评审', en: 'review', tone: 'muted' },
      issue: { zh: 'Issue', en: 'issue', tone: 'warn' },
      comment: { zh: '评论', en: 'comment', tone: 'muted' },
      delete: { zh: '删除', en: 'delete', tone: 'danger' },
      fork: { zh: 'Fork', en: 'fork', tone: 'muted' },
      star: { zh: 'Star', en: 'star', tone: 'warn' },
      wiki: { zh: 'Wiki', en: 'wiki', tone: 'muted' },
      member: { zh: '成员', en: 'member', tone: 'muted' },
      public: { zh: '公开', en: 'public', tone: 'brand' },
      create: { zh: '新建', en: 'create', tone: 'ok' },
      other: { zh: '动态', en: 'event', tone: 'muted' },
    }

    const TONES = ['brand', 'info', 'ok', 'warn', 'danger', 'muted']

    // ── helpers ────────────────────────────────────────────────────────────
    function pickLocale() {
      try {
        const html = document.documentElement.lang || ''
        if (/^zh/i.test(html)) return 'zh'
        if (navigator.language && /^zh/i.test(navigator.language)) return 'zh'
      } catch {
        /* no document: fall through */
      }
      return 'en'
    }

    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    /** Compact relative time; falls back to an absolute stamp past a week. */
    function sinceLabel(at, now, lang) {
      const ms = num(at)
      if (ms === undefined) return ''
      const delta = Math.max(0, now - ms)
      const minutes = Math.floor(delta / 60_000)
      if (minutes < 1) return lang === 'zh' ? '刚刚' : 'now'
      if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`
      const days = Math.floor(hours / 24)
      if (days < 7) return lang === 'zh' ? `${days} 天前` : `${days}d ago`
      return new Date(ms).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit' })
    }

    function clockLabel(at, lang) {
      const ms = num(at)
      if (ms === undefined) return ''
      return new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
    }

    function kindMeta(kind, lang) {
      const meta = KINDS[kind] ?? KINDS.other
      return { label: lang === 'zh' ? meta.zh : meta.en, tone: TONES.includes(meta.tone) ? meta.tone : 'muted' }
    }

    /** `3 分钟前` — an age is what you act on; a timestamp is what you look up. */
    function relativeTime(at, now, lang) {
      const ms = num(at)
      if (ms === undefined) return ''
      const seconds = Math.max(0, Math.round(((num(now) ?? Date.now()) - ms) / 1000))
      if (lang === 'zh') {
        if (seconds < 60) return `${seconds} 秒前`
        if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
        if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
        return `${Math.floor(seconds / 86_400)} 天前`
      }
      if (seconds < 60) return `${seconds}s ago`
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
      if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
      return `${Math.floor(seconds / 86_400)}d ago`
    }

    /**
     * One CI line for a repository: the newest run, its verdict as a WORD, and how
     * long ago it started.
     *
     * A run that is still going says so. `conclusion === null` is the trap here —
     * treating "not success" as failure reports every running build as broken, and
     * a real response (verified against GitHub) is exactly
     * `status: in_progress, conclusion: null`.
     */
    function CiLine(props) {
      const { ci, lang, now } = props
      if (ci === undefined || ci === null) return null
      if (ci.available === false) {
        return jsx('span', { className: 'ghh-ci is-muted', children: ci.reason ?? (lang === 'zh' ? '读不到 CI' : 'CI unavailable') })
      }
      const latest = ci.latest
      if (latest === undefined) {
        return jsx('span', { className: 'ghh-ci is-muted', children: lang === 'zh' ? '没有 CI 记录' : 'no CI runs' })
      }
      const running = latest.conclusion === undefined
      const tone = running ? 'is-running' : /success|neutral|skipped/i.test(latest.conclusion ?? '') ? 'is-ok' : 'is-bad'
      return jsxs('span', { className: `ghh-ci ${tone}`, title: latest.url, children: [
        jsx('span', { className: 'ghh-ci-dot', 'aria-hidden': true }),
        jsx('span', { className: 'ghh-ci-name', children: latest.name }),
        jsx('span', { className: 'ghh-ci-verdict', children: running ? (lang === 'zh' ? '进行中' : latest.status) : latest.conclusion }),
        latest.branch ? jsx('span', { className: 'ghh-ci-branch', children: latest.branch }) : null,
        jsx('span', { className: 'ghh-ci-at', children: relativeTime(latest.at, now, lang) }),
        // Counts make a fleet readable at a glance: one failing run out of five is
        // a different situation from five.
        (ci.failing ?? 0) > 1 ? jsx('span', { className: 'ghh-ci-count', children: `${ci.failing} ${lang === 'zh' ? '失败' : 'failed'}` }) : null,
        (ci.running ?? 0) > 1 ? jsx('span', { className: 'ghh-ci-count', children: `${ci.running} ${lang === 'zh' ? '进行中' : 'running'}` }) : null,
      ] })
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    /** Bounded fetch: an unresponsive host fails the poll instead of hanging it. */
    async function fetchJson(url, init) {
      let res
      try {
        res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(/timeout|abort/i.test(message) ? `请求超时（${FETCH_TIMEOUT_MS / 1000}s）` : `网络错误：${message}`)
      }
      const json = await res.json().catch(() => null)
      if (!json) throw new Error(`HTTP ${res.status}（响应不是 JSON）`)
      if (json.ok === false) throw new Error(String(json.error ?? `HTTP ${res.status}`))
      return json
    }

    const postJson = (url, body) =>
      fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          return ok
        } catch {
          return false
        }
      }
    }

    // ── styles ─────────────────────────────────────────────────────────────
    /**
     * Every colour is a design token so the card follows the active theme.
     * The root stays sticky with an opaque surface: the transcript scrolls
     * behind it rather than through it.
     */
    const CSS_ID = 'dsh-hud/github.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-hud'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        '.ghh-root{position:sticky;top:0;z-index:999;isolation:isolate;display:flex;width:100%;padding:0 2px 2px;font-family:inherit;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-root.is-left{justify-content:flex-start}',
        '.ghh-root.is-center{justify-content:center}',
        '.ghh-root.is-right{justify-content:flex-end}',
        '.ghh-card{box-sizing:border-box;width:min(100%,460px);display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:inset 0 1px 0 rgba(255,255,255,.65),0 1px 2px rgba(0,0,0,.05),0 10px 28px -18px rgba(15,17,21,.45);overflow:hidden}',
        '.ghh-root.is-stretch .ghh-card{width:100%}',
        // header
        '.ghh-head{display:flex;align-items:center;gap:8px;padding:8px 11px;font-size:12px;line-height:16px}',
        '.ghh-mark{flex:none;width:15px;height:15px;color:var(--dsw-alias-label-primary,#0f1115);opacity:.9}',
        '.ghh-title{font-weight:600;letter-spacing:.01em;flex:none}',
        '.ghh-who{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        // unread badge
        '.ghh-unread{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff;font-size:10px;font-weight:600;line-height:16px}',
        // quiet buttons
        '.ghh-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;padding:1px 8px;border-radius:999px;color:var(--dsw-alias-state-business-primary,#3964fe);font-size:11px;line-height:16px;cursor:pointer;transition:background .15s ease,border-color .15s ease;font-family:inherit}',
        '.ghh-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
        '.ghh-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
        '.ghh-btn:disabled{opacity:.55;cursor:default}',
        '.ghh-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-btn.is-quiet:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-btn.is-primary{background:var(--dsw-alias-state-business-primary,#3964fe);border-color:transparent;color:#fff}',
        '.ghh-btn.is-primary:hover{background:var(--dsw-alias-state-business-primary,#3964fe);filter:brightness(1.08)}',
        // repository tabs
        '.ghh-tabs{display:flex;align-items:center;gap:6px;padding:0 11px 7px;overflow-x:auto;scrollbar-width:none}',
        '.ghh-tabs::-webkit-scrollbar{display:none}',
        '.ghh-tab{flex:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap;font-family:inherit;display:inline-flex;align-items:center;gap:5px}',
        '.ghh-tab:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}',
        '.ghh-tab.is-active{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
        '.ghh-tabdot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);flex:none}',
        // body
        // The BODY only: the head and the tab strip keep their own rows, because a title bar that wrapped
      // into the content would stop reading as a title bar.
      //
      // Two panes: the left rail holds what DESCRIBES the card (a CI line, a review request, the
      // "nothing happened" note), the right pane holds the event LIST. Everything a reader scans
      // repeatedly is in one column, and the column is on the right because that is where a list
      // is read from.
      '.ghh-body{display:grid;grid-template-columns:minmax(90px,40%) minmax(0,1fr);align-items:start;gap:5px 12px;max-height:184px;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
        '.ghh-body::-webkit-scrollbar{width:8px}',
        '.ghh-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:4px}',
        // The events go in the right-hand pane. Every other child of the body falls into the left
      // rail by default, which is exactly the split wanted and needs no change to the render tree.
      '.ghh-row{grid-column:2;display:flex;align-items:flex-start;gap:8px;padding:6px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));text-decoration:none;color:inherit;cursor:pointer}',
        '.ghh-row:last-child{border-bottom:0}',
        '.ghh-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
        '.ghh-row.is-unread .ghh-rowtitle{font-weight:600}',
        '.ghh-row.is-unread::before{content:"";flex:none;width:5px;height:5px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe)}',
        // badges
        '.ghh-badge{flex:none;display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;font-size:10px;font-weight:600;letter-spacing:.02em;white-space:nowrap}',
        '.ghh-badge.t-brand{background:rgba(57,100,254,.13);color:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ghh-badge.t-info{background:rgba(14,140,190,.14);color:#0e7fa8}',
        '.ghh-badge.t-ok{background:rgba(34,160,107,.14);color:#1c8459}',
        '.ghh-badge.t-warn{background:rgba(245,158,11,.16);color:#a96800}',
        '.ghh-badge.t-danger{background:rgba(239,68,68,.14);color:#c53030}',
        '.ghh-badge.t-muted{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.07));color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.ghh-rowtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-rowmeta{display:flex;align-items:center;gap:6px;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ghh-rowmeta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ghh-avatar{flex:none;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(0,0,0,.15));object-fit:cover}',
        '.ghh-repo{flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-when{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,#81858c)}',
        // footer
        '.ghh-foot{display:flex;align-items:center;gap:8px;padding:6px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ghh-foot .ghh-spacer{margin-left:auto}',
        // panels (login, picker, settings)
        '.ghh-panel{display:flex;flex-direction:column;gap:9px;padding:11px}',
        '.ghh-panelhead{display:flex;align-items:center;gap:8px}',
        '.ghh-paneltitle{font-size:12px;font-weight:600}',
      // ── waiting on me ──────────────────────────────────────────────────
      // A review request is addressed to a person, so this block reads like a
      // list of things to do rather than like a feed.
      '.ghh-reviews{border-left:2px solid var(--dsw-alias-state-business-primary,#3964fe);padding-left:8px}',
      '.ghh-review{display:flex;align-items:baseline;gap:7px;padding:2px 0;text-decoration:none;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ghh-review:hover .ghh-review-title{text-decoration:underline}',
      '.ghh-review-repo{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.ghh-review-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ghh-review-draft{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.ghh-review-at{flex:none;font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── CI ─────────────────────────────────────────────────────────────
      // Colour is the second signal; the verdict is always a word too, because
      // "queued" and "cancelled" are not distinguishable by hue.
      '.ghh-cipanel{padding:5px 0}',
      '.ghh-ci{display:inline-flex;align-items:baseline;gap:6px;font-size:11px;line-height:16px;min-width:0;font-variant-numeric:tabular-nums}',
      '.ghh-ci-dot{flex:none;align-self:center;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#b6bac1)}',
      '.ghh-ci.is-ok .ghh-ci-dot{background:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.ghh-ci.is-bad .ghh-ci-dot{background:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.ghh-ci.is-running .ghh-ci-dot{background:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.ghh-ci-name{color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}',
      '.ghh-ci.is-bad .ghh-ci-verdict{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}',
      '.ghh-ci.is-ok .ghh-ci-verdict{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.ghh-ci.is-running .ghh-ci-verdict{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.ghh-ci.is-muted{color:var(--dsw-alias-label-caption,#81858c)}',
      '.ghh-ci-branch{color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}',
      '.ghh-ci-at,.ghh-ci-count{margin-left:auto;color:var(--dsw-alias-label-caption,#81858c);font-size:10px}',
      '.ghh-ci-count{margin-left:6px}',
        '.ghh-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-note.is-error{color:var(--dsw-alias-state-error-primary,#d33)}',
        '.ghh-note.is-ok{color:#1c8459}',
        '.ghh-notice{padding:6px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
        '.ghh-steps{display:flex;flex-direction:column;gap:4px}',
        '.ghh-step{position:relative;padding-left:13px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ghh-step::before{content:"›";position:absolute;left:3px;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-code{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
        '.ghh-usercode{flex:1 1 auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:17px;font-weight:600;letter-spacing:.14em;color:var(--dsw-alias-state-business-primary,#3964fe);user-select:all;text-align:center}',
        '.ghh-input{box-sizing:border-box;width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px;line-height:16px}',
        '.ghh-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
        '.ghh-input.is-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
        '.ghh-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.ghh-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none;border-bottom:1px dotted currentColor;word-break:break-all}',
        '.ghh-link:hover{border-bottom-style:solid}',
        // repository picker list
        '.ghh-repolist{display:flex;flex-direction:column;max-height:186px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px}',
        '.ghh-repolist::-webkit-scrollbar{width:8px}',
        '.ghh-repolist::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:4px}',
        '.ghh-repoitem{display:flex;align-items:center;gap:8px;padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));font-size:11.5px}',
        '.ghh-repoitem:last-child{border-bottom:0}',
        '.ghh-repoitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
        '.ghh-reponame{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ghh-repodesc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-lock{flex:none;font-size:9.5px;padding:0 5px;height:15px;line-height:15px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.07));color:var(--dsw-alias-label-caption,#81858c)}',
        '.ghh-grid{display:grid;grid-template-columns:auto 1fr;gap:7px 10px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
        // settings drawer
        '.ghh-drawer{display:flex;flex-direction:column;gap:8px;padding:9px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
        '.ghh-drawer-btn{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px;cursor:pointer;font-family:inherit}',
        '.ghh-drawer-btn:hover{color:var(--dsw-alias-state-business-primary,#3964fe)}',
        // motion: draw-in only, and never for reduced-motion users
        '.ghh-fade{animation:ghh-fade .24s ease-out backwards}',
        '@keyframes ghh-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
        '@media (prefers-reduced-motion:reduce){.ghh-fade{animation:none}}',
        // narrow docks: the side alignment would waste width, so fill it
        '@media (max-width:720px){.ghh-card{width:100%}}',
      ].join('')
      document.head.appendChild(tag)
    }

    // ── small presentational pieces ────────────────────────────────────────

    /** GitHub's mark, inline so the bundle stays dependency-free. */
    function GithubMark(props) {
      return jsx('svg', {
        className: 'ghh-mark',
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
        fill: 'currentColor',
        ...props,
        children: jsx('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        }),
      })
    }

    function KindBadge(props) {
      const meta = kindMeta(props.kind, props.lang)
      return jsx('span', { className: `ghh-badge t-${meta.tone}`, title: props.kind, children: meta.label })
    }

    /** One feed row. A real anchor, so middle-click and copy-link both work. */
    function EventRow(props) {
      const { item, lang, now, showRepo } = props
      const meta = []
      if (item.detail) meta.push(item.detail)
      return jsxs('a', {
        className: `ghh-row${item.unread ? ' is-unread' : ''}`,
        href: item.url || undefined,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: `${clockLabel(item.at, lang)}${item.actor ? ` · ${item.actor}` : ''}`,
        children: [
          jsx(KindBadge, { kind: item.kind, lang }),
          jsxs('span', { className: 'ghh-main', children: [
            jsx('span', { className: 'ghh-rowtitle', children: item.title }),
            jsxs('span', { className: 'ghh-rowmeta', children: [
              item.avatar
                ? jsx('img', { className: 'ghh-avatar', src: item.avatar, alt: '', loading: 'lazy' })
                : null,
              item.actor ? jsx('span', { children: item.actor }) : null,
              showRepo && item.repo ? jsx('span', { className: 'ghh-repo', children: item.repo }) : null,
              meta.length > 0 ? jsx('span', { children: meta.join(' · ') }) : null,
            ] }),
          ] }),
          jsx('span', { className: 'ghh-when', children: sinceLabel(item.at, now, lang) }),
        ],
      })
    }

    function Note(props) {
      return jsx('div', { className: `ghh-note${props.tone ? ` is-${props.tone}` : ''}`, children: props.children })
    }

    // ── main card ──────────────────────────────────────────────────────────
    /**
     * All hooks run unconditionally at the top: a conditional hook would shift
     * the order between renders and take the whole dock entry down with
     * React's "Rendered fewer hooks than expected".
     */
    function GithubHud(props = {}) {
      const lang = pickLocale()
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const [page, setPage] = React.useState(0)
      const [hovering, setHovering] = React.useState(false)
      const [panel, setPanel] = React.useState(null) // 'login' | 'picker' | 'settings' | null
      const [loginMode, setLoginMode] = React.useState('device')
      const [device, setDevice] = React.useState(null)
      const [deviceBusy, setDeviceBusy] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [notice, setNotice] = React.useState(null) // { tone, text }
      const [pickerQuery, setPickerQuery] = React.useState('')
      const [pickerRepos, setPickerRepos] = React.useState([])
      const [form, setForm] = React.useState(null)
      const mounted = React.useRef(true)
      const pollRef = React.useRef(null)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      /** One poll: read the host snapshot, and never stack requests. */
      const poll = React.useCallback(async (force) => {
        if (pollRef.current) return
        pollRef.current = true
        try {
          const json = force ? await postJson('/dsh-hud/github/refresh') : await fetchJson('/dsh-hud/github/state')
          if (!mounted.current) return
          setSnapshot(json)
          setError(null)
        } catch (caught) {
          if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          pollRef.current = false
        }
      }, [])

      // First load, then the host's own cadence (rebuilt whenever it changes).
      const pollMs = clamp(num(snapshot?.pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, 900_000)
      React.useEffect(() => {
        poll(false)
      }, [poll])
      React.useEffect(() => {
        const timer = window.setInterval(() => poll(false), pollMs)
        return () => window.clearInterval(timer)
      }, [poll, pollMs])

      // A cheap clock so relative stamps age without re-fetching.
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
        return () => window.clearInterval(timer)
      }, [])

      // Device-flow polling runs on GitHub's interval, only while a code is live.
      React.useEffect(() => {
        if (!device?.pending) return undefined
        const interval = clamp(num(device.interval) ?? 5, 3, 60) * 1000
        const timer = window.setInterval(async () => {
          try {
            const result = await postJson('/dsh-hud/github/device/poll')
            if (!mounted.current) return
            if (result.status === 'ok') {
              setDevice(null)
              setNotice({ tone: 'ok', text: lang === 'zh' ? '已登录 GitHub' : 'signed in to GitHub' })
              setPanel(null)
              poll(true)
            } else if (result.status === 'error' || result.status === 'expired') {
              setDevice(null)
              setNotice({ tone: 'error', text: result.error ?? 'sign-in failed' })
            } else if (result.status === 'pending' && num(result.interval)) {
              setDevice((current) => (current ? { ...current, interval: result.interval } : current))
            }
          } catch (caught) {
            if (mounted.current) setNotice({ tone: 'error', text: caught instanceof Error ? caught.message : String(caught) })
          }
        }, interval)
        return () => window.clearInterval(timer)
      }, [device, lang, poll])

      // A pending sign-in lives on the host, so a page reload resumes it
      // instead of silently dropping a code the user is about to approve.
      React.useEffect(() => {
        const remote = snapshot?.device
        if (!remote || device) return
        setDevice({
          userCode: remote.userCode,
          verificationUri: remote.verificationUri,
          expiresAt: remote.expiresAt,
          interval: remote.interval,
          pending: true,
        })
      }, [snapshot, device])

      const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : []
      const watched = Array.isArray(snapshot?.watched) ? snapshot.watched : []
      const auth = snapshot?.auth ?? { status: 'missing' }
      const signedIn = auth.status === 'ok'

      // Pages: one per watched repo, plus a merged page once there are several.
      const pages = React.useMemo(() => {
        if (repos.length === 0) return []
        if (repos.length === 1) return [{ id: repos[0].fullName, repo: repos[0] }]
        const merged = {
          fullName: ALL_PAGE,
          items: repos
            .flatMap((repo) => (repo.items ?? []).map((item) => ({ ...item, repo: repo.fullName })))
            .sort((a, b) => b.at - a.at),
          unread: repos.reduce((sum, repo) => sum + (repo.unread ?? 0), 0),
          // A repo that failed must not vanish from the merged page — its error
          // is the only sign the user would otherwise get.
          errors: repos.filter((repo) => repo.error).map((repo) => `${repo.fullName}: ${repo.error}`),
          meta: null,
        }
        return [{ id: ALL_PAGE, repo: merged }, ...repos.map((repo) => ({ id: repo.fullName, repo }))]
      }, [repos])

      // Carousel: only when there is something to rotate, and never mid-hover.
      const carouselMs = clamp(num(snapshot?.carouselMs) ?? DEFAULT_CAROUSEL_MS, MIN_CAROUSEL_MS, 60_000)
      const pageCount = pages.length
      React.useEffect(() => {
        if (pageCount < 2 || hovering || panel !== null) return undefined
        const timer = window.setInterval(() => {
          setPage((current) => (current + 1) % pageCount)
        }, carouselMs)
        return () => window.clearInterval(timer)
      }, [pageCount, hovering, panel, carouselMs])

      React.useEffect(() => {
        if (page >= pageCount && pageCount > 0) setPage(0)
      }, [page, pageCount])

      // ── actions ─────────────────────────────────────────────────────────
      const run = async (label, fn) => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
        } catch (caught) {
          setNotice({ tone: 'error', text: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          if (mounted.current) setBusy(false)
        }
        void label
      }

      const startDevice = () =>
        run('device', async () => {
          setDeviceBusy(true)
          try {
            const result = await postJson('/dsh-hud/github/device/start')
            setDevice({
              userCode: result.userCode,
              verificationUri: result.verificationUri,
              expiresAt: result.expiresAt,
              interval: result.interval,
              pending: true,
            })
            setNotice({ tone: undefined, text: lang === 'zh' ? '在 GitHub 页面输入下面这串代码，然后回到这里等它自动完成。' : 'Enter the code on GitHub, then wait here — this card finishes on its own.' })
          } finally {
            if (mounted.current) setDeviceBusy(false)
          }
        })

      const cancelDevice = () =>
        run('cancel', async () => {
          await postJson('/dsh-hud/github/device/cancel')
          setDevice(null)
          setNotice(null)
        })

      const saveToken = () =>
        run('token', async () => {
          const value = draft.trim()
          if (value === '') return
          const result = await postJson('/dsh-hud/github/credential', { value })
          setDraft('')
          setNotice({ tone: 'ok', text: `${lang === 'zh' ? '已保存到' : 'saved to'} ${result.how}（${result.account?.login ?? ''}）` })
          setPanel(null)
          await poll(true)
        })

      const loadRepos = (force) =>
        run('repos', async () => {
          const result = await fetchJson(`/dsh-hud/github/repos${force ? '?refresh=1' : ''}`)
          setPickerRepos(Array.isArray(result.repos) ? result.repos : [])
        })

      const watch = (repo, action) =>
        run('watch', async () => {
          await postJson('/dsh-hud/github/watch', { action, repo })
          const result = await fetchJson('/dsh-hud/github/repos')
          setPickerRepos(Array.isArray(result.repos) ? result.repos : [])
          await poll(true)
        })

      const markRead = () =>
        run('read', async () => {
          await postJson('/dsh-hud/github/read', {})
          await poll(true)
        })

      const saveSettings = () =>
        run('settings', async () => {
          const result = await postJson('/dsh-hud/github/settings', {
            pollMs: Number(form.pollMs),
            carouselMs: Number(form.carouselMs),
            perRepoLimit: Number(form.perRepoLimit),
            proxy: form.proxy,
            align: form.align,
            scopes: form.scopes,
            clientId: form.clientId,
          })
          setForm(null)
          setNotice({ tone: 'ok', text: lang === 'zh' ? '设置已保存' : 'settings saved' })
          void result
          await poll(true)
        })

      const logout = () =>
        run('logout', async () => {
          await postJson('/dsh-hud/github/logout')
          setSnapshot(null)
          setNotice({ tone: undefined, text: lang === 'zh' ? '已退出 GitHub' : 'signed out of GitHub' })
          await poll(false)
        })

      const openPanel = (name) => {
        setNotice(null)
        setPanel((current) => (current === name ? null : name))
        if (name === 'picker') loadRepos(false)
        if (name === 'settings' && snapshot) {
          setForm({
            pollMs: snapshot.settings?.pollMs ?? DEFAULT_POLL_MS,
            carouselMs: snapshot.settings?.carouselMs ?? DEFAULT_CAROUSEL_MS,
            perRepoLimit: snapshot.settings?.perRepoLimit ?? 30,
            proxy: snapshot.settings?.proxy ?? 'auto',
            align: snapshot.settings?.align ?? 'right',
            scopes: snapshot.settings?.scopes ?? 'repo read:user',
            clientId: snapshot.settings?.clientId ?? '',
          })
        }
      }

      // ── derived view state ──────────────────────────────────────────────
      const align = ['left', 'center', 'right', 'stretch'].includes(snapshot?.align) ? snapshot.align : 'right'
      const active = pages.length > 0 ? pages[Math.min(page, pages.length - 1)] : null
      const unread = num(snapshot?.unread) ?? 0
      // ── what is waiting on ME ───────────────────────────────────────────
      // The badge is "things that need a human", so it is not just unread events:
      // a review request and a failing pipeline are both that, and both are easy
      // to miss in a dock. `available === false` CI is a state, not a failure.
      const reviews = snapshot?.reviews ?? { total: 0, items: [], error: null }
      const reviewItems = Array.isArray(reviews.items) ? reviews.items : []
      const reviewCount = num(reviews.total) ?? reviewItems.length
      const ciFailing = num(snapshot?.ciFailing) ?? 0
      const ciRunning = num(snapshot?.ciRunning) ?? 0
      const attention = unread + reviewCount + ciFailing

      React.useEffect(() => {
        hud.setBadge('github', attention)
      }, [attention])
      /** The merged page's display name, shared by the header and the tabs. */
      const allPagesLabel = lang === 'zh' ? '全部' : 'all'
      const tokenPresent = snapshot?.credentials?.some((row) => row.ref === snapshot?.settings?.tokenRef && row.present) ?? false
      const transportLabel = snapshot?.transport?.label ?? ''
      const rateLimit = snapshot?.rateLimit

      const headerSub = signedIn
        ? [
            auth.account?.login,
            active ? (active.id === ALL_PAGE ? allPagesLabel : repoTitle(active.id)) : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : lang === 'zh'
          ? '未登录'
          : 'not signed in'

      const showLoginPanel = panel === 'login' || (!signedIn && panel === null)
      const deviceStillPending = Boolean(device?.pending)

      return jsx('div', {
        className: `ghh-root is-${align}`,
        onMouseEnter: () => setHovering(true),
        onMouseLeave: () => setHovering(false),
        children: jsxs('div', { className: 'ghh-card', children: [
          // ── header ──────────────────────────────────────────────────────
          jsxs('div', { className: 'ghh-head', children: [
            jsx(GithubMark, {}),
            jsx('span', { className: 'ghh-title', children: 'GitHub' }),
            jsx('span', { className: 'ghh-who', title: headerSub, children: headerSub }),
            jsxs('span', { className: 'ghh-right', children: [
              unread > 0
                ? jsx('span', { className: 'ghh-unread', title: lang === 'zh' ? `${unread} 条未读` : `${unread} unread`, children: String(unread) })
                : null,
              signedIn
                ? jsx('button', {
                    type: 'button',
                    className: 'ghh-btn is-quiet',
                    onClick: () => openPanel('picker'),
                    disabled: busy,
                    title: lang === 'zh' ? '关注仓库' : 'watched repositories',
                    children: lang === 'zh' ? '仓库' : 'repos',
                  })
                : null,
              signedIn
                ? jsx('button', {
                    type: 'button',
                    className: 'ghh-btn',
                    onClick: () => run('refresh', () => poll(true)),
                    disabled: busy,
                    title: snapshot?.fetchedAt ? `${lang === 'zh' ? '上次更新' : 'updated'} ${clockLabel(snapshot.fetchedAt, lang)}` : undefined,
                    children: busy ? (lang === 'zh' ? '刷新中' : '…') : lang === 'zh' ? '刷新' : 'refresh',
                  })
                : null,
            ] }),
          ] }),

          // ── repository tabs ─────────────────────────────────────────────
          pages.length > 1
            ? jsxs('div', { className: 'ghh-tabs', children: [
                ...pages.map((entry, index) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      className: `ghh-tab${index === page ? ' is-active' : ''}`,
                      onClick: () => setPage(index),
                      title: entry.id === ALL_PAGE ? (lang === 'zh' ? '全部仓库' : 'all repositories') : entry.id,
                      children: [
                        entry.repo.unread > 0 ? jsx('span', { className: 'ghh-tabdot' }) : null,
                        jsx('span', { children: entry.id === ALL_PAGE ? allPagesLabel : repoTitle(entry.id) }),
                      ],
                    },
                    entry.id,
                  ),
                ),
              ] })
            : null,

          // ── body ────────────────────────────────────────────────────────
          showLoginPanel
            ? renderLoginPanel()
            : panel === 'picker'
              ? renderPicker()
              : panel === 'settings' && form
                ? renderSettings()
                : renderFeed(),

          // A single notice slot OUTSIDE the panels: a sign-in confirmation
          // must survive the panel that triggered it closing.
          notice
            ? jsx('div', { className: 'ghh-notice ghh-fade', children: jsx(Note, { tone: notice.tone, children: notice.text }) })
            : null,

          // ── footer ──────────────────────────────────────────────────────
          jsxs('div', { className: 'ghh-foot', children: [
            jsx('button', {
              type: 'button',
              className: 'ghh-drawer-btn',
              onClick: () => openPanel('settings'),
              children: `▸ ${lang === 'zh' ? '设置' : 'settings'}`,
            }),
            signedIn && unread > 0
              ? jsx('button', { type: 'button', className: 'ghh-drawer-btn', onClick: markRead, disabled: busy, children: lang === 'zh' ? '全部已读' : 'mark all read' })
              : null,
            signedIn
              ? jsx('button', { type: 'button', className: 'ghh-drawer-btn', onClick: logout, disabled: busy, children: lang === 'zh' ? '退出' : 'sign out' })
              : null,
            jsx('span', { className: 'ghh-spacer' }),
            rateLimit && num(rateLimit.remaining) !== undefined
              ? jsx('span', { title: lang === 'zh' ? 'GitHub API 剩余额度' : 'GitHub API remaining', children: `${rateLimit.remaining}` })
              : null,
            transportLabel
              ? jsx('span', { title: `${lang === 'zh' ? '网络通道' : 'transport'}: ${transportLabel}`, children: transportLabel === 'direct' ? (lang === 'zh' ? '直连' : 'direct') : 'proxy' })
              : null,
          ] }),
        ] }),
      })

      // ── panel renderers (plain functions: no hooks, so hook order is fixed)

      function repoTitle(fullName) {
        return String(fullName ?? '').split('/').filter(Boolean).slice(-1)[0] || String(fullName ?? '')
      }

      function renderFeed() {
        if (error) {
          return jsx('div', { className: 'ghh-panel', children: jsxs('div', { className: 'ghh-steps', children: [
            jsx(Note, { tone: 'error', children: error }),
            jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '宿主侧未响应——确认插件已启用，然后刷新页面。' : 'The host did not answer — check that the plugin is enabled, then reload.' }),
          ] }) })
        }
        if (!signedIn) return null
        if (watched.length === 0) {
          return jsx('div', { className: 'ghh-panel', children: jsxs('div', { className: 'ghh-steps', children: [
            jsx(Note, { children: lang === 'zh' ? '还没有关注仓库。挑一个自己的仓库开始监控吧。' : 'No repositories watched yet — pick one of your own to start.' }),
            jsx('div', { className: 'ghh-actions', children: jsx('button', { type: 'button', className: 'ghh-btn is-primary', onClick: () => openPanel('picker'), children: lang === 'zh' ? '添加关注仓库' : 'add a repository' }) }),
          ] }) })
        }
        const items = active?.repo?.items ?? []
        // The CI line belongs to a REPOSITORY page, and the merged "all" page has
        // no single pipeline to describe — so it is shown only where it is true.
        const ciRow = active?.id === ALL_PAGE || active?.repo === undefined
          ? null
          : jsx('div', { className: 'ghh-panel ghh-cipanel', children: jsx(CiLine, { ci: active.repo.ci, lang, now }) })
        const errorRows =
          active?.id === ALL_PAGE
            ? active.repo.errors ?? []
            : active?.repo?.error
              ? [active.repo.error]
              : []
        if (items.length === 0) {
          return jsx('div', { className: 'ghh-panel', children: jsxs('div', { className: 'ghh-steps', children: [
            ...errorRows.map((row, index) => jsx(Note, { tone: 'error', children: row }, `err-${index}`)),
            errorRows.length === 0
              ? jsx(Note, {
                  children: lang === 'zh'
                    ? '这个仓库最近没有动静（近 90 天无事件）。'
                    : 'No recent activity in this repository (nothing in the last 90 days).',
                })
              : null,
          ] }) })
        }
        return jsxs('div', { className: 'ghh-body', children: [
          ciRow,
          ...errorRows.map((row, index) =>
            jsx('div', { className: 'ghh-panel', children: jsx(Note, { tone: 'error', children: row }) }, `err-${index}`),
          ),
          // ── waiting on me ────────────────────────────────────────────────
          // Above the feed, because a review request is addressed to YOU and the
          // feed is only news. A search that FAILED says so instead of showing an
          // empty list: `review-requested:@me` is an authenticated query, and
          // signed out it is a 422 rather than "nothing waiting".
          reviewCount > 0 || reviews.error
            ? jsxs('div', { className: 'ghh-panel ghh-reviews', children: [
                jsxs('div', { className: 'ghh-panelhead', children: [
                  jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '等待我评审' : 'Waiting on my review' }),
                  jsx('span', { className: 'ghh-count', children: reviewCount > 0 ? String(reviewCount) : '' }),
                ] }),
                reviews.error ? jsx(Note, { tone: 'error', children: reviews.error }) : null,
                ...reviewItems.slice(0, 4).map((item) => jsxs('a', {
                  className: 'ghh-review',
                  href: item.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  children: [
                    jsx('span', { className: 'ghh-review-repo', children: item.repo ?? '' }),
                    jsx('span', { className: 'ghh-review-title', children: `#${item.number} ${item.title}` }),
                    item.draft ? jsx('span', { className: 'ghh-review-draft', children: lang === 'zh' ? '草稿' : 'draft' }) : null,
                    jsx('span', { className: 'ghh-review-at', children: relativeTime(item.at, now, lang) }),
                  ],
                }, item.id)),
              ] })
            : null,
          ...items.slice(0, Math.max(VISIBLE_ROWS, num(snapshot?.settings?.perRepoLimit) ?? VISIBLE_ROWS)).map((item) =>
            jsx(EventRow, { item, lang, now, showRepo: active?.id === ALL_PAGE }, item.id),
          ),
        ] })
      }

      function renderLoginPanel() {
        return jsxs('div', { className: 'ghh-panel ghh-fade', children: [
          // A host that never answered would otherwise leave this panel looking
          // perfectly normal while nothing can possibly work.
          error ? jsx(Note, { tone: 'error', children: error }) : null,
          jsxs('div', { className: 'ghh-panelhead', children: [
            jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '登录 GitHub' : 'Sign in to GitHub' }),
            jsxs('span', { className: 'ghh-right', children: [
              jsx('button', {
                type: 'button',
                className: `ghh-tab${loginMode === 'device' ? ' is-active' : ''}`,
                onClick: () => setLoginMode('device'),
                children: lang === 'zh' ? '设备码' : 'device code',
              }),
              jsx('button', {
                type: 'button',
                className: `ghh-tab${loginMode === 'token' ? ' is-active' : ''}`,
                onClick: () => setLoginMode('token'),
                children: lang === 'zh' ? '粘贴 Token' : 'paste token',
              }),
            ] }),
          ] }),

          loginMode === 'device'
            ? jsxs('div', { className: 'ghh-steps', children: [
                deviceStillPending
                  ? jsxs('div', { className: 'ghh-steps', children: [
                      jsxs('div', { className: 'ghh-code', children: [
                        jsx('span', { className: 'ghh-usercode', children: device.userCode }),
                        jsx('button', {
                          type: 'button',
                          className: 'ghh-btn',
                          onClick: async () => {
                            const ok = await copyText(device.userCode)
                            setNotice({ tone: ok ? 'ok' : 'error', text: ok ? (lang === 'zh' ? '代码已复制' : 'code copied') : (lang === 'zh' ? '复制失败，请手动选中' : 'copy failed — select it manually') })
                          },
                          children: lang === 'zh' ? '复制' : 'copy',
                        }),
                      ] }),
                      jsxs('div', { className: 'ghh-actions', children: [
                        jsx('a', { className: 'ghh-link', href: device.verificationUri, target: '_blank', rel: 'noreferrer noopener', children: lang === 'zh' ? '打开 GitHub 授权页 →' : 'open GitHub →' }),
                        jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: cancelDevice, disabled: busy, children: lang === 'zh' ? '取消' : 'cancel' }),
                      ] }),
                      jsx('div', { className: 'ghh-step', children: lang === 'zh' ? `授权后本卡片会自动完成登录（每 ${device.interval ?? 5} 秒检查一次，代码 15 分钟内有效）。` : `This card finishes on its own once you approve (checks every ${device.interval ?? 5}s; the code lives 15 minutes).` }),
                    ] })
                  : jsxs('div', { className: 'ghh-steps', children: [
                      jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '点下面的按钮，GitHub 会给出一串一次性代码。' : 'Get a one-time code from GitHub.' }),
                      jsx('div', { className: 'ghh-actions', children: jsx('button', {
                        type: 'button',
                        className: 'ghh-btn is-primary',
                        onClick: startDevice,
                        disabled: busy || deviceBusy,
                        children: deviceBusy ? (lang === 'zh' ? '获取中…' : 'starting…') : lang === 'zh' ? '开始设备码登录' : 'start device sign-in',
                      }) }),
                      jsx('div', { className: 'ghh-step', children: lang === 'zh' ? `默认使用公开的 GitHub CLI OAuth 应用（client id ${snapshot?.settings?.clientId ?? ''}），申请范围 ${snapshot?.settings?.scopes ?? ''}；也可在设置里换成你自己的 OAuth 应用。` : `Uses the public GitHub CLI OAuth app by default (client id ${snapshot?.settings?.clientId ?? ''}) with scopes ${snapshot?.settings?.scopes ?? ''}; supply your own OAuth app in settings if you prefer.` }),
                    ] }),
              ] })
            : jsxs('div', { className: 'ghh-steps', children: [
                jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '推荐细粒度 token，只勾选你愿意开放的内容（仓库读取即可）。' : 'A fine-grained token with read-only repository access is enough.' }),
                jsx('a', { className: 'ghh-link', href: 'https://github.com/settings/tokens?type=beta', target: '_blank', rel: 'noreferrer noopener', children: lang === 'zh' ? '打开 GitHub Token 设置 →' : 'open GitHub token settings →' }),
                jsx('input', {
                  className: 'ghh-input is-mono',
                  type: 'password',
                  value: draft,
                  placeholder: 'github_pat_… / ghp_…',
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') saveToken()
                  },
                }),
                jsxs('div', { className: 'ghh-actions', children: [
                  jsx('button', { type: 'button', className: 'ghh-btn is-primary', onClick: saveToken, disabled: busy || draft.trim() === '', children: busy ? (lang === 'zh' ? '保存中…' : 'saving…') : lang === 'zh' ? '保存并验证' : 'save and verify' }),
                  jsx('button', {
                    type: 'button',
                    className: 'ghh-btn is-quiet',
                    onClick: async () => {
                      try {
                        const text = await navigator.clipboard.readText()
                        if (text) setDraft(text.trim())
                      } catch {
                        setNotice({ tone: 'error', text: lang === 'zh' ? '剪贴板读取被拒，请手动粘贴' : 'clipboard blocked — paste manually' })
                      }
                    },
                    children: lang === 'zh' ? '读取剪贴板' : 'from clipboard',
                  }),
                ] }),
              ] }),

          
          !tokenPresent && snapshot ? jsx('div', { className: 'ghh-step', children: lang === 'zh' ? `凭据保存在 ${snapshot.settings?.tokenRef ?? 'GITHUB_TOKEN'}，只存在宿主侧，浏览器拿不到。` : `Stored as ${snapshot.settings?.tokenRef ?? 'GITHUB_TOKEN'} on the host only; the browser never sees it.` }) : null,
        ] })
      }

      function renderPicker() {
        const query = pickerQuery.trim().toLowerCase()
        const rows = pickerRepos.filter((repo) => query === '' || repo.fullName.toLowerCase().includes(query))
        return jsxs('div', { className: 'ghh-panel ghh-fade', children: [
          jsxs('div', { className: 'ghh-panelhead', children: [
            jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '关注仓库' : 'Watched repositories' }),
            jsxs('span', { className: 'ghh-right', children: [
              jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => loadRepos(true), disabled: busy, children: lang === 'zh' ? '重新读取' : 'reload' }),
              jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => setPanel(null), children: lang === 'zh' ? '收起' : 'close' }),
            ] }),
          ] }),
          jsx('input', {
            className: 'ghh-input',
            value: pickerQuery,
            placeholder: lang === 'zh' ? '筛选仓库…' : 'filter repositories…',
            onChange: (event) => setPickerQuery(event.target.value),
          }),
          rows.length === 0
            ? jsx(Note, { children: busy ? (lang === 'zh' ? '正在读取你的仓库…' : 'loading your repositories…') : lang === 'zh' ? '没有匹配的仓库。本插件只列出你自己拥有的仓库。' : 'No match. Only repositories you own are listed.' })
            : jsx('div', { className: 'ghh-repolist', children: rows.map((repo) =>
                jsxs('div', { className: 'ghh-repoitem', children: [
                  jsxs('span', { className: 'ghh-main', children: [
                    jsx('span', { className: 'ghh-reponame', title: repo.fullName, children: repo.fullName }),
                    repo.description ? jsx('span', { className: 'ghh-repodesc', title: repo.description, children: repo.description }) : null,
                  ] }),
                  repo.private ? jsx('span', { className: 'ghh-lock', children: lang === 'zh' ? '私有' : 'private' }) : null,
                  num(repo.stars) ? jsx('span', { className: 'ghh-repodesc', children: `★${repo.stars}` }) : null,
                  repo.watched
                    ? jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => watch(repo.fullName, 'remove'), disabled: busy, children: lang === 'zh' ? '取消关注' : 'unwatch' })
                    : jsx('button', { type: 'button', className: 'ghh-btn', onClick: () => watch(repo.fullName, 'add'), disabled: busy, children: lang === 'zh' ? '关注' : 'watch' }),
                ] }, repo.fullName),
              ) }),
          
        ] })
      }

      function renderSettings() {
        const field = (label, key, extra) =>
          jsxs(React.Fragment, { children: [
            jsx('label', { children: label }),
            jsx('input', {
              className: `ghh-input${extra?.mono ? ' is-mono' : ''}`,
              type: extra?.type ?? 'text',
              value: form[key] ?? '',
              onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.value })),
            }),
          ] }, key)
        return jsxs('div', { className: 'ghh-panel ghh-fade', children: [
          jsxs('div', { className: 'ghh-panelhead', children: [
            jsx('span', { className: 'ghh-paneltitle', children: lang === 'zh' ? '设置' : 'Settings' }),
            jsx('span', { className: 'ghh-right', children: jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => setPanel(null), children: lang === 'zh' ? '收起' : 'close' }) }),
          ] }),
          jsxs('div', { className: 'ghh-grid', children: [
            field(lang === 'zh' ? '轮询间隔 (ms)' : 'poll (ms)', 'pollMs'),
            field(lang === 'zh' ? '轮播间隔 (ms)' : 'carousel (ms)', 'carouselMs'),
            field(lang === 'zh' ? '每仓库条数' : 'rows per repo', 'perRepoLimit'),
            field(lang === 'zh' ? '代理' : 'proxy', 'proxy', { mono: true }),
            field(lang === 'zh' ? 'OAuth client id' : 'OAuth client id', 'clientId', { mono: true }),
            field(lang === 'zh' ? '授权范围' : 'scopes', 'scopes', { mono: true }),
          ] }),
          jsxs('div', { className: 'ghh-steps', children: [
            jsx('div', { className: 'ghh-step', children: lang === 'zh' ? '代理填 auto 会自动探测（环境变量 → 直连 → 本地 7890/7897/10809 等端口）；填 off 强制直连。' : 'proxy "auto" probes (env → direct → local 7890/7897/10809 …); "off" forces a direct connection.' }),
          ] }),
          jsxs('div', { className: 'ghh-actions', children: [
            jsx('button', { type: 'button', className: 'ghh-btn is-primary', onClick: saveSettings, disabled: busy, children: busy ? (lang === 'zh' ? '保存中…' : 'saving…') : lang === 'zh' ? '保存' : 'save' }),
            jsx('button', { type: 'button', className: 'ghh-btn is-quiet', onClick: () => setPanel(null), children: lang === 'zh' ? '取消' : 'cancel' }),
          ] }),
          
        ] })
      }
    }

    // ── fragment entry point ───────────────────────────────────────────────
    // The HUD shell owns the dock cell, the grid and the layout editor, so this
    // panel contributes its identity and its component — nothing else.
    // `span: 1` is only this panel's PREFERENCE: one track is what an activity
    // feed reads well in, and the user's own layout choice (⚙) overrides it.
    return {
      id: 'github',
      // AFTER the database card (30), because the packer is first-fit in ORDER: that is
      // what puts this card in the middle column's lower cell, under the quota card,
      // rather than in the third cell of the first row. Order is the whole geometry.
      order: 40,
      span: 1,
      label: { zh: 'GitHub', en: 'GitHub' },
      // ON by default now: it takes the middle column's lower cell, under the quota card,
      // where the machine card used to sit. The machine card is still registered and one
      // click away in ⚙ — this is a LAYOUT decision, not a deletion.
      defaultOn: true,
      // ONE row, and it is the ARRANGEMENT's number rather than the card's: the middle column is
      // 用量限额 (3) + 快递 (1) + GitHub (1), and that sum has to equal the 5 the two full-height
      // cards claim or the middle column ends a row early and leaves a hole.
      //
      // One row is honest for the EMPTY state, which is what this card shows most of the time. A
      // busy afternoon scrolls — inside the body, which already had its own scrollbar and its own
      // max-height — rather than making every day taller for everyone.
      defaultRows: 1,
      Component: GithubHud,
      __test: { Hud: GithubHud, kinds: KINDS },
    }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/market/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › market panel — browser half.
//
// FRAGMENT CONTRACT: concatenated into the single `client.js` bundle by
// `tools/build-client.mjs`, inside the same factory scope as the shell. No
// top-level `import` / `export` / `return`; `React`, `jsx`, `jsxs` and `hud`
// come from the bundle scope.
//
// The chart is hand-written SVG — the same approach as the quota panel's usage
// chart, because the platform module table only carries react, and a charting
// library is not going to be added for one panel. Three details make it read
// like a real terminal chart rather than a sketch:
//
//   - candle BODIES are fills and every STROKE carries
//     `vector-effect="non-scaling-stroke"`. The SVG stretches to the card width
//     (`preserveAspectRatio="none"`), which distorts anything stroked; fills
//     stretch as a unit and stay correct.
//   - all TEXT lives in HTML positioned by percentage, outside the SVG, so
//     labels never inherit the stretch.
//   - it follows the domestic convention: 红涨绿跌.
//
// The candlestick chart itself lives in the SHELL (`hud.CandleChart`), because
// the bond panel draws K-lines too. This panel only frames it and supplies what
// is specific to shares: the day/week/month periods and the price formatting.
const MK_FALLBACK_MS = 30_000
const MK_MIN_MS = 10_000
const MK_MAX_MS = 60 * 60_000
// Five rows: enough to see the watch list move, few enough that the card stays
// short. The rest are still polled and counted, just not drawn (the note below
// says how many are hidden).
const MK_VISIBLE_ROWS = 5

function createMarketPanel() {
  const CSS_ID = 'dsh-hud/market.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.mk-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      // The rate row: dense, aligned on the decimal point, and never wrapped per rate.
      '.mk-fx{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;padding-top:7px;border-top:1px solid var(--hud-line,rgba(0,0,0,.08));font-variant-numeric:tabular-nums}',
      '.mk-fx-label{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-fx-item{display:inline-flex;align-items:baseline;gap:4px;font-size:11px;line-height:16px}',
      '.mk-fx-code{color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px}',
      '.mk-fx-value{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',
      '.mk-fx-chg{font-size:10.5px}',
      '.mk-fx-inv{padding:0 4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));font-size:9px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;flex-wrap:wrap}',
      '.mk-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-sessions{display:inline-flex;align-items:center;gap:5px}',
      '.mk-sess{padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-sess.is-open{border-color:rgba(34,160,107,.4);color:#1a7f52;background:rgba(34,160,107,.08)}',
      // A market that is not trading TODAY is a different state from one that is merely between
      // sessions: struck through, because the whole day is off rather than the next hour.
      '.mk-sess.is-off{text-decoration:line-through;opacity:.75}',
      '.mk-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.mk-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.mk-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.mk-btn:disabled{opacity:.55;cursor:default}',
      '.mk-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
      // The word beside the ＋ only when there is room for it: the head row already carries the
      // title, three session chips and 刷新, and a fourth label wraps the whole row on a narrow
      // card. The ＋ and the tooltip carry the meaning at that size.
      '.mk-add-wide{display:inline}',
      '@container (max-width:420px){.mk-add-wide{display:none}}',
      '.mk-btn.is-on{background:rgba(57,100,254,.10);border-color:rgba(57,100,254,.35);font-weight:600}',
      // ── watch list ────────────────────────────────────────────────────────
      '.mk-watch{display:flex;flex-direction:column;gap:1px}',
    // The shared chart brings its own layout; the panel only frames it.
    '.mk-chart{width:100%;box-sizing:border-box;padding:5px 7px 3px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}',
      '.mk-wrow{display:flex;align-items:center;gap:7px;width:100%;padding:4px 7px;border:1px solid transparent;border-radius:7px;background:transparent;font-family:inherit;text-align:left;cursor:pointer}',
      '.mk-wrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
      '.mk-wrow.is-sel{border-color:rgba(57,100,254,.30);background:rgba(57,100,254,.07)}',
      '.mk-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-code{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.mk-px{margin-left:auto;flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-chg{flex:none;width:62px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums}',
      '.mk-up{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      // The view switch and the ranking table. Same type scale as the watch rows, so the two
      // lists read as the same card.
      '.mk-views{display:inline-flex;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;overflow:hidden;margin-right:2px}',
      '.mk-view{padding:0 8px;border:0;background:transparent;font-family:inherit;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap}',
      '.mk-view.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.mk-rank{display:flex;flex-direction:column;gap:0}',
      '.mk-rhead,.mk-rrow{display:grid;grid-template-columns:18px minmax(0,1fr) 60px 62px 62px 62px 20px;align-items:center;gap:4px;padding:1px 2px}',
      '.mk-rhead{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c);border-bottom:1px solid var(--hud-line,rgba(0,0,0,.08))}',
      '.mk-rrow{font-size:11.5px;line-height:17px;border-radius:5px}',
      '.mk-rrow:nth-child(odd){background:var(--hud-tile,rgba(0,0,0,.02))}',
      '.mk-rno{font-variant-numeric:tabular-nums;font-size:10px;color:var(--dsw-alias-label-caption,#81858c);text-align:right}',
      '.mk-rrow .mk-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mk-ramt{font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b);text-align:right}',
      '.mk-radd{padding:0 4px;font-size:11px;line-height:15px}',
      '.mk-rnote{display:flex;flex-wrap:wrap;gap:8px;padding-top:4px;font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      // The hover chart: fixed to the viewport, never in the way, above everything.
      '.mk-hover{position:fixed;z-index:40;width:300px;padding:5px 6px 2px;border:1px solid var(--hud-line,rgba(0,0,0,.14));border-radius:9px;background:var(--hud-card-bg,#fff);box-shadow:0 6px 22px rgba(0,0,0,.16);pointer-events:none}',
      '.mk-hover-head{display:flex;align-items:center;gap:6px;padding-bottom:2px}',
      '.mk-hover-name{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mk-hover-wait{height:104px;display:flex;align-items:center;justify-content:center;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-rrow.is-hover{background:rgba(57,100,254,.10)}',
      '.mk-rrow{cursor:pointer}',
      // The pinned chart: the card's own chart slot, used the way the watch view uses it.
      '.mk-pin{display:flex;flex-direction:column;gap:4px;padding:5px 6px 2px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:9px;background:var(--hud-tile,rgba(0,0,0,.02))}',
      '.mk-pin-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.mk-pin-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.mk-pin-px{font-size:12px;font-variant-numeric:tabular-nums}',
      '.mk-pin-space{flex:1 1 auto}',
      '.mk-pin-facts{display:flex;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.mk-pin-wait{height:220px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-rrow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-2px}',
      '.mk-down{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.mk-x{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-caption,#81858c);font-family:inherit;font-size:12px;line-height:14px;cursor:pointer;padding:0 2px}',
      '.mk-x:hover{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // ── chart ─────────────────────────────────────────────────────────────
      '.mk-chart{position:relative;width:100%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));padding:6px 8px 4px}',
      // ── add / search ──────────────────────────────────────────────────────
      '.mk-add{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
      '.mk-input{box-sizing:border-box;width:100%;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px;line-height:16px}',
      '.mk-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
      '.mk-hits{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow-y:auto}',
      '.mk-hit{display:flex;align-items:center;gap:7px;padding:3px 7px;border:1px solid transparent;border-radius:6px;background:transparent;font-family:inherit;text-align:left;cursor:pointer;font-size:11.5px}',
      '.mk-hit:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
      '.mk-hit .mk-code{margin-left:auto}',
      '.mk-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.mk-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.mk-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.mk-empty{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b)}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num

  const pct = (value) => (num(value) === undefined ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)
  const toneOf = (value) => (num(value) === undefined || value === 0 ? '' : value > 0 ? 'mk-up' : 'mk-down')
  const price = (value) => (num(value) === undefined ? '--' : value.toFixed(value >= 1000 ? 2 : value >= 10 ? 2 : 3))

/**
 * ── 今日涨跌榜 ───────────────────────────────────────────────────────────────
 *
 * Three views on one card: 自选 (what it always showed), 涨幅榜 and 跌幅榜. The ranking is a
 * different upstream call from the quotes — eastmoney's own screen, sorted by 涨跌幅 — and it
 * is read here rather than in a card of its own because it is the same subject, from the same
 * host, on the same cadence.
 *
 * What the rows say, and what they deliberately do not:
 *   • the day's move, the price, and 成交额 — a percentage with no money behind it is a story;
 *   • the 沪京深 session state, because a ranking on a non-trading day is the LAST trading
 *     day's, and a list that does not say so looks like live data on a holiday;
 *   • how many rows the host dropped (新股 and 退市整理: real moves, not the market's).
 *     A list that silently hides rows is a list nobody can check.
 */
const RANK_VIEWS = [
  { id: 'watch', zh: '自选', en: 'Watch' },
  { id: 'up', zh: '涨幅榜', en: 'Gainers' },
  { id: 'down', zh: '跌幅榜', en: 'Losers' },
]

/** 成交额 in the units a person reads: 亿 / 万, and nothing at all when it is unknown. */
const money = (value) => (num(value) === undefined
  ? '--'
  : value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿`
    : value >= 1e4 ? `${(value / 1e4).toFixed(0)}万`
      : String(Math.round(value)))

/** One ranking: 20 rows, the day's move, and the one action that makes them useful. */
function RankTable(props) {
  const { zh, half, session, busy, error, onPick, hover, hoverChart, pinned, pinnedChart, pinnedBusy } = props
  const rows = Array.isArray(half?.rows) ? half.rows : []
  if (error !== undefined && error !== null && rows.length === 0) {
    return jsx('div', { className: 'mk-msg is-err', 'data-act': 'rank-error', children: error })
  }
  if (rows.length === 0) {
    return jsx('div', { className: 'mk-empty', children: busy === true
      ? (zh ? '读取榜单…' : 'loading…')
      : (zh ? '没有拿到榜单数据' : 'no ranking data') })
  }
  return jsxs('div', { className: 'mk-rank', 'data-act': 'rank-table', children: [
    jsxs('div', { className: 'mk-rhead', children: [
      jsx('span', { className: 'mk-rno', children: '#' }),
      jsx('span', { className: 'mk-name', children: zh ? '名称' : 'NAME' }),
      jsx('span', { className: 'mk-code', children: zh ? '代码' : 'CODE' }),
      jsx('span', { className: 'mk-px', children: zh ? '最新' : 'LAST' }),
      jsx('span', { className: 'mk-chg', children: zh ? '涨跌幅' : 'CHG' }),
      jsx('span', { className: 'mk-ramt', children: zh ? '成交额' : 'AMOUNT' }),
      jsx('span', { className: 'mk-radd' }),
    ] }),
    ...rows.map((row, index) => jsxs('div', {
      className: `mk-rrow${hover?.secid === row.secid ? ' is-hover' : ''}`,
      'data-secid': row.secid,
      // The handlers live on the ROW, not on a wrapper: the row is what the pointer is on.
      // A click PINS this row's chart: a hover is a glance, a click says "this one".
      onClick: () => props.onPin?.(row),
      onMouseEnter: (event) => props.onHover?.(row, event.currentTarget),
      onMouseLeave: () => props.onLeave?.(),
      // Keyboard users get the same chart: focus is a hover that does not need a mouse.
      onFocus: (event) => props.onHover?.(row, event.currentTarget),
      onBlur: () => props.onLeave?.(),
      tabIndex: 0,
      children: [
        jsx('span', { className: 'mk-rno', children: String(index + 1) }),
        jsx('span', { className: 'mk-name', title: row.name, children: row.name }),
        jsx('span', { className: 'mk-code', children: row.code }),
        jsx('span', { className: 'mk-px', children: price(row.price) }),
        jsx('span', { className: `mk-chg ${toneOf(row.changePct)}`, children: pct(row.changePct) }),
        jsx('span', { className: 'mk-ramt', children: money(row.amount) }),
        /**
         * ONE action, and it is add-then-select: the host's `add` already selects what it
         * added, so this single click is what puts the stock on the card with its K-line —
         * which is the only reason to look at a ranking row twice.
         */
        jsx('button', {
          type: 'button',
          className: 'mk-btn is-quiet mk-radd',
          'data-act': 'rank-add',
          'data-secid': row.secid,
          title: zh ? '加入自选并看它的 K 线' : 'add to the watch list',
          onClick: () => onPick(row),
          children: '＋',
        }),
      ],
    }, row.secid)),
    /**
     * The hover chart, drawn where the row is.
     *
     * Deliberately NOT interactive: `pointer-events: none` means the pointer never enters it, so
     * the row underneath cannot flicker between entered and left — which is how this feature
     * usually ends up unusable. Whatever needs clicking is on the row.
     */
    hover === null || hover === undefined
      ? null
      : jsxs('div', {
          className: 'mk-hover',
          'data-act': 'rank-hover',
          'data-secid': hover.secid,
          style: { left: `${hover.left}px`, top: `${hover.top}px` },
          children: [
            jsxs('div', { className: 'mk-hover-head', children: [
              jsx('span', { className: 'mk-hover-name', children: hover.name }),
              jsx('span', { className: 'mk-code', children: hover.code }),
              jsx('span', { className: 'mk-note', children: zh ? '当日分时' : 'today' }),
            ] }),
            hoverChart === null
              ? jsx('div', { className: 'mk-hover-wait', 'data-act': 'rank-hover-wait', children: zh ? '读取中…' : 'loading…' })
              : jsx(hud.CandleChart, {
                  lang: zh ? 'zh' : 'en',
                  candles: hoverChart,
                  height: 104,
                  ariaLabel: zh ? `${hover.name} 当日分时` : `${hover.name} today`,
                  empty: zh ? '今天没有分时数据' : 'no intraday data',
                }),
          ],
        }),
/**
     * The pinned chart, in the slot the watch view uses for its own K-line.
     *
     * Full width and 220px tall: the chart draws its crosshair readout inside its own box, so a
     * chart too small to hover is a chart with no numbers in it — which is precisely what the
     * first version of this was.
     */
    pinned === null || pinned === undefined
      ? null
      : jsxs('div', { className: 'mk-pin', 'data-act': 'rank-pin', 'data-secid': pinned.secid, children: [
          jsxs('div', { className: 'mk-pin-head', children: [
            jsx('span', { className: 'mk-pin-name', children: pinned.name }),
            jsx('span', { className: 'mk-code', children: pinned.code }),
            jsx('span', { className: `mk-pin-px ${toneOf(pinned.changePct)}`, children: price(pinned.price) }),
            jsx('span', { className: `mk-chg ${toneOf(pinned.changePct)}`, children: pct(pinned.changePct) }),
            jsx('span', { className: 'mk-pin-space' }),
            // The day's shape in words, because that is what the candles are saying and reading
            // it off a chart is work: 最高/最低/成交额 come from the ranking row already in hand.
            jsxs('span', { className: 'mk-pin-facts', children: [
              jsx('span', { children: `${zh ? '最高' : 'H'} ${price(pinned.high)}` }),
              jsx('span', { children: `${zh ? '最低' : 'L'} ${price(pinned.low)}` }),
              jsx('span', { children: `${zh ? '成交额' : 'AMT'} ${money(pinned.amount)}` }),
              jsx('span', { children: zh ? '当日分时' : 'today' }),
            ] }),
            jsx('button', {
              type: 'button',
              className: 'mk-btn is-quiet',
              'data-act': 'rank-pin-close',
              title: zh ? '关闭（切换页签也会关闭）' : 'close',
              onClick: () => props.onUnpin?.(),
              children: zh ? '关闭' : 'close',
            }),
          ] }),
          pinned.error !== undefined && pinned.error !== null
            ? jsx('div', { className: 'mk-msg is-err', children: pinned.error })
            : null,
          pinnedChart === null
            ? jsx('div', { className: 'mk-pin-wait', 'data-act': 'rank-pin-wait', children: pinnedBusy === true
              ? (zh ? '读取当日分时…' : 'loading…')
              : (zh ? '没有拿到分时数据' : 'no intraday data') })
            : jsx(hud.CandleChart, {
                lang: zh ? 'zh' : 'en',
                candles: pinnedChart,
                height: 220,
                ariaLabel: zh ? `${pinned.name} 当日分时` : `${pinned.name} today`,
                empty: zh ? '今天没有分时数据' : 'no intraday data',
              }),
        ]}),
    jsxs('div', { className: 'mk-rnote', children: [
      // jsxs, not jsx: an array of children needs keys, and the checker (and React) say so.
      jsxs('span', { children: [
        session?.open === true
          ? (zh ? '沪深京 交易中' : 'CN session open')
          : session?.tradingDay === true
            ? (zh ? '沪深京 休市中（当日数据）' : 'CN closed (today)')
            : (zh ? '沪深京 非交易日 —— 这是最近一个交易日的榜单' : 'CN non-trading day — last session'),
      ] }),
      num(half?.filtered) > 0
        ? jsx('span', { title: zh ? '新股与退市整理股的涨跌幅不是市场的涨跌幅' : 'new listings and delistings are not the market', children: zh
          ? `已滤掉 ${half.filtered} 只新股/退市`
          : `${half.filtered} filtered` })
        : null,
      num(half?.total) > 0
        ? jsx('span', { children: zh ? `全市场 ${half.total} 只` : `${half.total} listed` })
        : null,
    ] }),
  ] })
}

/**
 * ── hovering a ranking row ───────────────────────────────────────────────────
 *
 * The ranking answers "what moved today" and then stops: the next question is always "what did
 * it LOOK like", which the list cannot answer and the selected instrument's chart answers only
 * for one stock at a time. So a row, on hover, shows its own intraday candles.
 *
 * Three decisions that are the whole feature:
 *
 * 1. **Debounced.** Sweeping the mouse down twenty rows must not be twenty upstream calls.
 *    Hovering waits {@link HOVER_DELAY_MS}, and only the row the pointer SETTLES on is asked
 *    for. This endpoint is a real request per secid; a hover that fires per row is a hover that
 *    gets the card rate-limited.
 * 2. **Cached, and not forever.** The candles for a secid are kept in memory for as long as the
 *    card is on screen (bounded), so going back over a row is instant — but the cache is the
 *    CLIENT's, with the same one-minute life the host gives an intraday chart. Two caches with
 *    different lifetimes would disagree in a way nobody could explain.
 * 3. **It never takes the mouse.** The popover is `pointer-events: none`: a tooltip that
 *    captures the pointer makes the row underneath flicker between entered and left, which is
 *    the classic way this feature is ruined.
 */
const HOVER_DELAY_MS = 160
const HOVER_CACHE_MS = 60_000
const HOVER_CACHE_MAX = 40

/** Where to put a popover so it is always fully on screen, next to the row it belongs to. */
function hoverPosition(rect, width, height) {
  const margin = 8
  const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1280
  const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 720
  // To the RIGHT of the row when there is room, because the row's own numbers are on the left.
  let left = rect.right + margin
  if (left + width > viewportWidth - margin) left = rect.left - width - margin
  if (left < margin) left = Math.max(margin, viewportWidth - width - margin)
  let top = rect.top - 6
  if (top + height > viewportHeight - margin) top = viewportHeight - height - margin
  if (top < margin) top = margin
  return { left: Math.round(left), top: Math.round(top) }
}
  /** The card: watch list + the selected instrument's K-line. */
  function MarketCard(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [kline, setKline] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [adding, setAdding] = React.useState(false)
    const [query, setQuery] = React.useState('')
    const [hits, setHits] = React.useState([])
    const [addMsg, setAddMsg] = React.useState(null)
    /**
     * Which of the three views is on screen, and the ranking behind it.
     *
     * `view` is client state, not settings: it is where the eye is, not a preference — and a
     * card that reopens on the ranking because that is where it was left is a card that
     * hides the watch list on every reload.
     */
    const [view, setView] = React.useState('watch')
    const [rank, setRank] = React.useState(null)
    const [rankError, setRankError] = React.useState(null)
    const [rankBusy, setRankBusy] = React.useState(false)
/**
     * The hover chart: which row the pointer is on, where it is on screen, and the candles.
     *
     * `hover` is the row and its position; `hoverChart` is what came back for it. Kept apart
     * because the popover must appear IMMEDIATELY (with 读取中…) — a tooltip that only shows up
     * after the network answers feels broken for exactly as long as the request takes.
     */
    const [hover, setHover] = React.useState(null)
    const [hoverChart, setHoverChart] = React.useState(null)
/**
     * The PINNED chart: what a click on a row produces.
     *
     * A hover preview is a glance — small, floating, gone the moment the pointer moves. Clicking
     * says "I want to look at THIS", and the two are different enough to be different states:
     * the pinned chart goes in the slot the card already uses for its K-line (full width, tall
     * enough for the chart's own crosshair readout to be legible), carries the day's numbers in
     * its header, and stays until it is closed or the view changes.
     */
    const [pinned, setPinned] = React.useState(null)
    const [pinnedChart, setPinnedChart] = React.useState(null)
    const [pinnedBusy, setPinnedBusy] = React.useState(false)
    const aliveRef = React.useRef(true)
    /** secid → { at, candles }: the client's own minute, matching the host's intraday cache. */
    const hoverCache = React.useRef(new Map())
    const hoverTimer = React.useRef(null)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/market/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    // The host decides the cadence (it knows which sessions are open), except
    // that a 0/undefined value must never arm a hot loop.
    /**
     * The ranking is fetched only while it is being LOOKED at.
     *
     * The quote poll runs whatever the view is, because the head needs the session state —
     * but a ranking nobody has opened is a request nobody asked for, and this endpoint is a
     * screen over 5900 stocks, not a handful of secids.
     */
    const readRank = React.useCallback(() => {
      setRankBusy(true)
      return hud.fetchJson('/dsh-hud/market/rank').then((json) => {
        if (!aliveRef.current) return
        setRank(json)
        setRankError(null)
      }, (failure) => {
        if (aliveRef.current) setRankError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => {
        if (aliveRef.current) setRankBusy(false)
      })
    }, [])

/**
     * Point at a row; after a moment, ask for its intraday candles.
     *
     * Both halves matter: the popover opens on the hover itself, and the REQUEST only happens
     * once the pointer has settled — sweeping the list is not a reason to call upstream twenty
     * times, and the row a person stops on is the row they meant.
     */
    /** Read inside the hover callback, which must not be re-created on every pin. */
    const pinnedRef = React.useRef(null)
    React.useEffect(() => { pinnedRef.current = pinned }, [pinned])

    const showHover = React.useCallback((row, element) => {
      if (element === null || element === undefined) return
      const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
      if (rect === null) return
      // Measured at the moment of the hover rather than on every render: the layout is known
      // here, and a rect captured earlier is stale as soon as anything scrolls.
      // While a chart is PINNED, hovering does not open previews: the pinned chart is what the
      // person is looking at, and a second floating one on top of it is noise.
      if (pinnedRef.current !== null) return
      const place = hoverPosition(rect, 300, 168)
      setHover({ secid: row.secid, name: row.name, code: row.code, ...place })
      setHoverChart(hoverCache.current.get(row.secid)?.candles ?? null)
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => {
        const hit = hoverCache.current.get(row.secid)
        if (hit !== undefined && Date.now() - hit.at < HOVER_CACHE_MS) return
        hud.fetchJson(`/dsh-hud/market/kline?secid=${encodeURIComponent(row.secid)}&period=realtime`)
          .then((json) => {
            const candles = Array.isArray(json?.candles) ? json.candles : []
            hoverCache.current.set(row.secid, { at: Date.now(), candles })
            // Bounded: a card that keeps every candle of every row it ever hovered grows all day.
            if (hoverCache.current.size > HOVER_CACHE_MAX) {
              const oldest = [...hoverCache.current.entries()].sort((a, b) => a[1].at - b[1].at)[0]
              if (oldest !== undefined) hoverCache.current.delete(oldest[0])
            }
            if (!aliveRef.current) return
            // Only if the pointer is STILL on that row: an answer that arrives after the mouse
            // has moved on must not paint itself over the row that is there now.
            setHover((current) => {
              if (current === null || current.secid !== row.secid) return current
              setHoverChart(candles)
              return current
            })
          }, () => {
            /* a hover chart that failed says nothing: the row is still readable, and an error
               banner per missed hover would be noise. The K-line view itself reports failures. */
          })
      }, HOVER_DELAY_MS)
    }, [])

    const hideHover = React.useCallback(() => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      setHover(null)
      setHoverChart(null)
    }, [])

    React.useEffect(() => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    }, [])

/**
     * Pin a row's chart, reusing the hover cache when it is still fresh.
     *
     * The cache is shared on purpose: hovering a row and then clicking it is ONE look at one
     * stock, and asking upstream twice for it would be the kind of waste that only shows up on
     * somebody's rate limit.
     */
    const pinRow = React.useCallback((row) => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      setHover(null)
      setHoverChart(null)
      setPinned(row)
      const hit = hoverCache.current.get(row.secid)
      const fresh = hit !== undefined && Date.now() - hit.at < HOVER_CACHE_MS
      setPinnedChart(fresh ? hit.candles : null)
      if (fresh) return
      setPinnedBusy(true)
      hud.fetchJson(`/dsh-hud/market/kline?secid=${encodeURIComponent(row.secid)}&period=realtime`)
        .then((json) => {
          const candles = Array.isArray(json?.candles) ? json.candles : []
          hoverCache.current.set(row.secid, { at: Date.now(), candles })
          if (!aliveRef.current) return
          // Only if the pin is still on that row: an answer that arrives after another row was
          // clicked must not paint itself over the one that is there now.
          setPinned((current) => {
            if (current === null || current.secid !== row.secid) return current
            setPinnedChart(candles)
            return current
          })
        }, (failure) => {
          if (!aliveRef.current) return
          setPinned((current) => (current === null || current.secid !== row.secid
            ? current
            : { ...current, error: failure instanceof Error ? failure.message : String(failure) }))
        })
        .finally(() => { if (aliveRef.current) setPinnedBusy(false) })
    }, [])

    const unpin = React.useCallback(() => {
      setPinned(null)
      setPinnedChart(null)
      setPinnedBusy(false)
    }, [])

    const pollMs = clamp(num(snapshot?.pollMs) ?? MK_FALLBACK_MS, MK_MIN_MS, MK_MAX_MS)
    const selected = snapshot?.selected ?? ''
    const period = snapshot?.period ?? 'day'

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    React.useEffect(() => {
      let stop
      try {
        stop = typeof props.startTimers === 'function'
          ? props.startTimers(poll, pollMs, undefined, 0)
          : (() => {
              const id = window.setInterval(poll, pollMs)
              return () => window.clearInterval(id)
            })()
      } catch (failure) {
        console.error('[mk] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, pollMs, props.startTimers])

    // The K-line is fetched whenever the selection or the period changes, and on
    // the host's slower K-line cadence in between — a daily candle does not move
    // every 30 seconds.
    const loadKline = React.useCallback((secid, want, force) => {
      if (!secid) return
      const url = `/dsh-hud/market/kline?secid=${encodeURIComponent(secid)}&period=${encodeURIComponent(want)}${force ? '&refresh=1' : ''}`
      hud.fetchJson(url).then((json) => {
        if (aliveRef.current) setKline(json)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    React.useEffect(() => {
      loadKline(selected, period, false)
      const cadence = clamp(num(snapshot?.klineMs) ?? 300_000, 60_000, 24 * 60 * 60_000)
      const id = window.setInterval(() => loadKline(selected, period, false), cadence)
      return () => window.clearInterval(id)
    }, [selected, period, loadKline, snapshot?.klineMs])

    const post = React.useCallback(async (action, body) => {
      const json = await hud.fetchJson(`/dsh-hud/market/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (aliveRef.current) {
        setSnapshot(json)
        setError(null)
      }
      return json
    }, [])

    const refresh = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        await post('refresh')
        loadKline(selected, period, true)
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy, post, loadKline, selected, period])

    const runSearch = React.useCallback(async (input) => {
      setQuery(input)
      setAddMsg(null)
      if (input.trim().length < 1) {
        setHits([])
        return
      }
      try {
        const json = await post('search', { input })
        if (aliveRef.current) setHits(Array.isArray(json?.results) ? json.results : [])
      } catch (failure) {
        if (aliveRef.current) {
          setHits([])
          setAddMsg(failure instanceof Error ? failure.message : String(failure))
        }
      }
    }, [post])

      // The yuan, from the same payload as the quotes.
      const forex = Array.isArray(snapshot?.forex) ? snapshot.forex : []
      // Armed by the view, on the same cadence as everything else on this card.
    React.useEffect(() => {
      if (view === 'watch') return undefined
      readRank().catch(() => {})
      let stop
      try {
        stop = typeof props.startTimers === 'function'
          ? props.startTimers(() => { readRank().catch(() => {}) }, pollMs, undefined, 0)
          : (() => {
              const id = window.setInterval(() => { readRank().catch(() => {}) }, pollMs)
              return () => window.clearInterval(id)
            })()
      } catch {
        /* the timer is optional; the first read already happened */
      }
      return () => { try { if (typeof stop === 'function') stop() } catch { /* already stopped */ } }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, pollMs])

    const forexError = typeof snapshot?.forexError === 'string' ? snapshot.forexError : undefined
      const quotes = Array.isArray(snapshot?.quotes) ? snapshot.quotes : []
    const sessions = snapshot?.session ?? {}
    const shown = quotes.slice(0, MK_VISIBLE_ROWS)
    const stamp = snapshot?.fetchedAt
      ? new Date(snapshot.fetchedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false })
      : null

    return jsxs('div', { className: 'mk-root', 'data-panel': 'market', children: [
      jsxs('div', { className: 'mk-head', children: [
        jsx('span', { className: 'mk-title', children: zh ? '股市' : 'Markets' }),
        jsxs('span', { className: 'mk-sessions', children: ['cn', 'hk', 'us'].map((market) => {
          const one = sessions[market] ?? {}
          // The chip says WHY a market is shut when the reason is a holiday, because "A股" greyed
          // out with no explanation reads like a broken feed while "A股 国庆" reads like a
          // calendar. A weekend gets no label: everyone knows what a Saturday is.
          const why = one.closed === 'holiday' && one.closedLabel ? ` ${one.closedLabel}` : ''
          const title = [one.label ?? market, one.time, why.trim()].filter(Boolean).join(' ')
          return jsx('span', {
            className: `mk-sess${one.open ? ' is-open' : ''}${one.tradingDay === false ? ' is-off' : ''}`,
            title,
            children: `${one.label ?? market}${why}`,
          }, market)
        }) }),
        jsxs('span', { className: 'mk-right', children: [
          jsxs('span', { className: 'mk-views', role: 'group', children: RANK_VIEWS.map((one) => jsx('button', {
            type: 'button',
            className: `mk-view${view === one.id ? ' is-on' : ''}`,
            'data-act': `view-${one.id}`,
            'aria-pressed': view === one.id ? 'true' : 'false',
            title: one.id === 'watch' ? (zh ? '自选与 K 线' : 'watch list') : (zh ? '今日涨跌榜前 20' : "today's top 20"),
            // A pin belongs to the ranking that produced it: changing the view is changing the
            // question, so the answer goes away with it.
            onClick: () => { setView(one.id); setPinned(null); setPinnedChart(null); setPinnedBusy(false) },
            children: zh ? one.zh : one.en,
          }, one.id)) }),
          stamp ? jsx('span', { children: stamp }) : null,
          // In the HEAD row, not at the foot of the card: a control that adds to a list
          // belongs beside the list, and the row it used to occupy was a whole line of height
          // below the chart. The `＋` is the label because that is what the eye looks for; the
          // word appears only when the card is wide enough for it.
          jsx('button', {
            type: 'button',
            className: 'mk-btn is-quiet',
            'data-act': 'add',
            disabled: adding === true,
            title: zh ? '添加标的' : 'add an instrument',
            onClick: () => { setAdding(true); setAddMsg(null) },
            children: jsxs('span', { children: [
              '＋',
              jsx('span', { className: 'mk-add-wide', children: zh ? ' 添加标的' : ' add' }),
            ] }),
          }),
          jsx('button', {
            type: 'button',
            className: 'mk-btn',
            'data-act': 'refresh',
            disabled: busy,
            onClick: () => { refresh(); if (view !== 'watch') readRank().catch(() => {}) },
            children: busy ? (zh ? '刷新中' : 'loading') : (zh ? '刷新' : 'refresh'),
          }),
        ] }),
      ] }),
      error ? jsx('div', { className: 'mk-msg is-err', children: error }) : null,
      view !== 'watch'
        ? jsx(RankTable, {
            zh,
            half: rank?.[view],
            session: rank?.session,
            busy: rankBusy,
            error: rankError ?? rank?.error,
            hover: hover,
            hoverChart: hoverChart,
            onHover: showHover,
            onLeave: hideHover,
            pinned: pinned,
            pinnedChart: pinnedChart,
            pinnedBusy: pinnedBusy,
            onPin: pinRow,
            onUnpin: unpin,
            onPick: (row) => {
              // Add-then-select in one click: the host's `add` selects what it added, so this
              // lands the person on the stock's own chart — which is the only reason to look
              // at a ranking row a second time.
              post('add', { secid: row.secid, name: row.name })
                .then(() => { if (aliveRef.current) setView('watch') })
                .catch((failure) => { if (aliveRef.current) setAddMsg(failure instanceof Error ? failure.message : String(failure)) })
            },
          })
        : null,
      addMsg !== null && view !== 'watch' ? jsx('div', { className: 'mk-msg is-err', children: addMsg }) : null,
      view !== 'watch' || quotes.length > 0
        ? null
        : jsx('div', { className: 'mk-empty', children: zh ? '自选是空的，点右上角的「＋」添加标的。' : 'the watch list is empty — use ＋ above' }),
      view === 'watch' && quotes.length > 0
        ? jsx('div', { className: 'mk-watch', children: shown.map((row) => jsxs('div', {
            className: `mk-wrow${row.secid === selected ? ' is-sel' : ''}`,
            role: 'button',
            tabIndex: 0,
            onClick: () => { post('select', { secid: row.secid }).catch(() => {}) },
            children: [
              jsx('span', { className: 'mk-name', children: row.name }),
              jsx('span', { className: 'mk-code', children: row.code }),
              jsx('span', { className: 'mk-px', children: price(row.price) }),
              jsx('span', { className: `mk-chg ${toneOf(row.changePct)}`, children: pct(row.changePct) }),
              jsx('button', {
                type: 'button',
                className: 'mk-x',
                title: zh ? '从自选移除' : 'remove',
                onClick: (event) => { event.stopPropagation(); post('remove', { secid: row.secid }).catch(() => {}) },
                children: '×',
              }),
            ],
          }, row.secid)) })
        : null,
      view === 'watch' && quotes.length > shown.length
        ? jsx('div', { className: 'mk-note', children: zh ? `还有 ${quotes.length - shown.length} 个自选未显示` : `${quotes.length - shown.length} more hidden` })
        : null,
      // ── the yuan ────────────────────────────────────────────────────────
      // One compact row of rates, under the indices: `1 USD = 6.7186 CNH`. It is
      // here rather than in a card of its own because it is read TOGETHER with the
      // indices — and it comes from the same upstream as they do.
      forex.length > 0
        ? jsxs('div', { className: 'mk-fx', children: [
            jsx('span', { className: 'mk-fx-label', children: zh ? '汇率' : 'FX' }),
            ...forex.map((rate) => jsxs('span', {
              className: 'mk-fx-item',
              title: rate.inverse
                ? (zh ? `1 离岸人民币 = ${rate.value} ${rate.code}` : `1 CNH = ${rate.value} ${rate.code}`)
                : (zh ? `1 ${rate.code} = ${rate.value} 离岸人民币` : `1 ${rate.code} = ${rate.value} CNH`),
              children: [
                jsx('span', { className: 'mk-fx-code', children: rate.code }),
                jsx('span', { className: 'mk-fx-value', children: rate.value.toFixed(rate.decimals) }),
                jsx('span', { className: `mk-fx-chg ${toneOf(rate.changePct)}`, children: pct(rate.changePct) }),
                // The inverse pair is flagged, so nobody reads "1 JPY = 23.5 CNY".
                rate.inverse ? jsx('span', { className: 'mk-fx-inv', children: zh ? '反向' : 'inv' }) : null,
              ],
            }, rate.secid)),
          ] })
        : forexError !== undefined
          ? jsx('div', { className: 'mk-note', children: `${zh ? '汇率读取失败' : 'FX failed'}：${forexError}` })
          : null,
      // The chart is the shell's shared one (`hud.CandleChart`): the bond panel
        // draws K-lines too, and two copies of a chart drift apart. This panel
        // supplies only what is specific to shares — the periods, the width and
        // the compact height.
        view !== 'watch'
        ? null
        : jsx('div', { className: 'mk-chart', children: jsx(hud.CandleChart, {
          lang,
          candles: kline?.candles ?? [],
          height: 176,
          decimals: 2,
          period,
          // The menu is the HOST's: it owns what each period costs upstream (one
          // session of bars for 实时/5分/15分/60分, the last year for 日/周/月).
          periods: snapshot?.periods ?? [],
          onPeriod: (value) => { post('period', { period: value }).catch(() => {}) },
          ariaLabel: zh ? 'K 线图' : 'candlestick chart',
          empty: zh ? '没有拿到 K 线数据' : 'no candles',
        }) }),
        adding
        ? jsxs('div', { className: 'mk-add', children: [
            jsx('input', {
              className: 'mk-input',
              value: query,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: zh ? '输入名称或代码，如 茅台 / 600519 / AAPL' : 'name or code, e.g. AAPL',
              onChange: (event) => runSearch(event.target.value),
            }),
            hits.length > 0
              ? jsx('div', { className: 'mk-hits', children: hits.map((hit) => jsxs('button', {
                  type: 'button',
                  className: 'mk-hit',
                  onClick: async () => {
                    try {
                      await post('add', { secid: hit.secid, name: hit.name })
                      if (!aliveRef.current) return
                      setQuery('')
                      setHits([])
                      setAdding(false)
                    } catch (failure) {
                      if (aliveRef.current) setAddMsg(failure instanceof Error ? failure.message : String(failure))
                    }
                  },
                  children: [
                    jsx('span', { children: hit.name }),
                    jsx('span', { className: 'mk-code', children: `${hit.code}${hit.kind ? ` · ${hit.kind}` : ''}` }),
                  ],
                }, hit.secid)) })
              : null,
            addMsg ? jsx('div', { className: 'mk-msg is-err', children: addMsg }) : null,
            jsx('button', { type: 'button', className: 'mk-btn is-quiet', onClick: () => { setAdding(false); setAddMsg(null); setHits([]) }, children: zh ? '取消' : 'cancel' }),
          ] })
        // The form itself, with its results. The trigger is in the head row now, so this is
        // only ever the "adding" state.
        : null,
    ] })
  }

  return {
    id: 'market',
    order: 50,
    // Two columns: a candle chart in a third of the dock is unreadable.
    span: 2,
    label: { zh: '股市', en: 'Markets' },
    Component: MarketCard,
    __test: { MarketCard },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/markets/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud — the markets card: 股市 and 债市 in ONE card, switched by a toggle.
//
// Why one card instead of two: they answer the same question ("what are my instruments
// doing") and they were being placed as two cards in a three-column grid, which is two
// thirds of a row spent on tabular data. One card with a switch fits in a single column
// and leaves the rest of the row for cards that are not the same shape.
//
// BOTH sub-cards stay MOUNTED and the inactive one is `hidden`. That is the same
// keep-alive rule the shell uses for cards: switching the view must not restart a poll
// or empty a chart you were looking at, and switching back has to be instant. The cost
// is that both keep polling — which is exactly what happened when they were two cards.
//
// The host half is untouched: `market` and `bond` remain real panels with their own
// routes, state files and settings. This card is a CLIENT composition of the two, so
// nothing about the data they fetch changes.

/**
 * The tab strip. Named sizes of chrome are the shell's business; this is the one control
 * that belongs to the composition, so it is small and it lives at the top.
 */
function MarketsSwitch(props) {
  const zh = props.lang === 'zh'
  return jsxs('div', {
    className: 'mks-switch',
    role: 'tablist',
    'aria-label': zh ? '行情类别' : 'Market type',
    children: props.tabs.map((tab) => jsx('button', {
      type: 'button',
      role: 'tab',
      className: `mks-tab${props.tab === tab.id ? ' is-on' : ''}`,
      'data-tab': tab.id,
      'aria-selected': props.tab === tab.id ? 'true' : 'false',
      onClick: () => props.onPick(tab.id),
      children: zh ? tab.zh : tab.en,
    }, tab.id)),
  })
}

function MarketsCard(props = {}) {
  const lang = pickLocale()
  const zh = lang === 'zh'
  const [tab, setTab] = React.useState('market')
  // The sub-panels are built ONCE per mount: their components are closed over by the
  // two views below, and rebuilding them on every render would remount the cards.
  const panels = React.useMemo(() => ({
    market: createMarketPanel(),
    bond: createBondPanel(),
    // 期货 is a full panel of its own — its own routes, its own state file, its own polling —
    // composed into this card the same way 债市 is. The card is the frame; each view keeps its
    // own data and its own schedule.
    futures: createFuturesPanel(),
    // 汇率 needs no host of its own: it reads the 股市 panel's own routes, which have served FX
    // since the beginning. Composing it here is the whole implementation.
    fx: createFxPanel(),
  }), [])
  const tabs = [
    { id: 'market', zh: '股市', en: 'Markets' },
    { id: 'bond', zh: '债市', en: 'Bonds' },
    { id: 'futures', zh: '期货', en: 'Futures' },
    { id: 'fx', zh: '汇率', en: 'FX' },
  ]
  const view = (id) => {
    const Component = panels[id].Component
    return jsx('div', {
      className: 'mks-view',
      // Which card this is, so a test (or a stylesheet) can address one of them without
      // guessing: the two cards share class names on purpose — the bond card draws the
      // same chart component — and an unscoped selector matches both.
      'data-view': id,
      // `hidden`, not unmounted — see the note at the top of this file.
      hidden: tab !== id,
      children: jsx(Component, props),
    })
  }
  return jsxs('div', { className: 'mks-root', children: [
    jsx(MarketsSwitch, { tabs, tab, lang, onPick: setTab }),
    view('market'),
    view('bond'),
    view('futures'),
    view('fx'),
  ] })
}

function createMarketsPanel() {
  const CSS_ID = 'dsh-hud/markets.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.mks-root{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.mks-switch{display:inline-flex;align-self:flex-start;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;overflow:hidden}',
      '.mks-tab{padding:2px 12px;border:0;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.mks-tab+.mks-tab{border-left:1px solid var(--hud-line,rgba(0,0,0,.1))}',
      '.mks-tab.is-on{background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      // The hidden view keeps its layout: a card that is merely not shown must not
      // reflow, or switching back would move everything the user was reading.
      '.mks-view[hidden]{display:none}',
      '.mks-view{display:flex;flex-direction:column;gap:8px;min-width:0}',
    ].join('\n')
    document.head.appendChild(tag)
  }
  return {
    id: 'markets',
    // 10: the first card in the default arrangement — it is the tallest and the one the
    // eye should land on first.
    order: 10,
    label: { zh: '股市债市', en: 'Markets & Bonds' },
    // One column. The card used to claim two, which is fine for a chart on its own and
    // wasteful now that it shares a row with three other cards — and ⚙ can widen it.
    span: 1,
    defaultOn: true,
    /**
     * Five rows tall — the full height of the shipped arrangement.
     *
     * The layout is a 3 × 10 rectangle: 股市债市 on the left, 用量限额 / 快递 / GitHub stacked
     * in the middle (4 + 3 + 3), 数据库 on the right. This is one of the two full-height
     * columns, so its height is not a measurement — it has to BE 10 for all three columns to
     * end on the same row.
     */
    defaultRows: 5,
    Component: MarketsCard,
    __test: { MarketsCard, MarketsSwitch },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/parcel/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › parcel panel — browser half.
//
// FRAGMENT CONTRACT: concatenated into the single `client.js` bundle by
// `tools/build-client.mjs`, inside the same factory scope as the shell. No
// top-level `import` / `export` / `return`; `React`, `jsx`, `jsxs` and `hud`
// come from the bundle scope.
//
// A CARD (it has `Component`), one column wide by default: a compact list of
// watched shipments that expands into full timelines. Every parcel row carries
// what a courier app puts on its list screen — carrier, status chip, the place
// of the newest scan, how long ago — and the expansion carries the whole track.
//
// Two honest details this UI is careful about:
//
//   - the newest scan's place is shown as TEXT and labelled as coming from the
//     scan text. The API carries no coordinates (verified: the union of every
//     node's keys is exactly `time`, `context`, `ftime`), so there is no pin to
//     draw and this card does not draw one;
//   - "unread" means the timeline MOVED since the card last acknowledged it, so
//     the tab badge counts real news rather than new parcels.

const PK_FALLBACK_POLL_MS = 300_000
const PK_MIN_POLL_MS = 60_000
const PK_MAX_POLL_MS = 6 * 60 * 60_000
/** Nodes rendered before the timeline is truncated with a "more" line. */
const PK_VISIBLE_NODES = 12

function createParcelPanel() {
  const CSS_ID = 'dsh-hud/parcel.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      // Two panes, the same shape as the GitHub card: the left rail holds the empty-state line, the
      // 添加单号 button and the refresh note; the right pane holds the parcel LIST. A parcel row was
      // always meant to be read as a list, and a list that sits under the controls is a list that
      // moves every time a control changes width.
      //
      // `minmax(0, 1fr)` rather than `1fr`: a track's default minimum is its content, so a long
      // tracking line would widen the pane past the card and put a scrollbar on the whole HUD.
      '.pk-root{display:grid;grid-template-columns:minmax(90px,40%) minmax(0,1fr);align-items:start;gap:5px 10px;min-width:0}',
      '.pk-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}',
      '.pk-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 3px rgba(57,100,254,.14)}',
      '.pk-status.is-ok{background:#22a06b;box-shadow:0 0 0 3px rgba(34,160,107,.15)}',
      '.pk-status.is-warn{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16)}',
      '.pk-status.is-crit{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}',
      '.pk-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.pk-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-right{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.pk-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.pk-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.pk-btn:disabled{opacity:.55;cursor:default}',
      '.pk-btn.is-quiet{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-btn.is-quiet:hover{border-color:var(--dsw-alias-label-caption,#81858c)}',
      '.pk-list{display:flex;flex-direction:column;gap:7px}',
      // The parcels go in the right-hand pane; everything else falls into the left rail.
      '.pk-row{grid-column:2;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));overflow:hidden}',
      '.pk-row.is-unread{border-color:rgba(57,100,254,.35)}',
      '.pk-rowhead{display:flex;align-items:center;gap:7px;width:100%;padding:7px 9px;border:0;background:transparent;font-family:inherit;text-align:left;cursor:pointer}',
      '.pk-caret{flex:none;width:9px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.pk-name{flex:none;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.pk-nu{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.pk-chip{flex:none;padding:0 7px;border-radius:999px;border:1px solid transparent;font-size:10.5px;line-height:16px}',
      '.pk-chip.t-brand{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe);background:rgba(57,100,254,.10)}',
      '.pk-chip.t-ok{border-color:rgba(34,160,107,.35);color:#1a7f52;background:rgba(34,160,107,.10)}',
      '.pk-chip.t-warn{border-color:rgba(245,158,11,.45);color:#b45309;background:rgba(245,158,11,.10)}',
      '.pk-chip.t-crit{border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.10)}',
      '.pk-chip.t-info{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14));color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-new{flex:none;padding:0 6px;border-radius:999px;background:rgba(57,100,254,.14);font-size:10px;line-height:15px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.pk-meta{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:7px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.pk-where{flex:none;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.pk-body{display:flex;flex-direction:column;gap:6px;padding:0 9px 9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.pk-sum{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word;padding-top:6px}',
      '.pk-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.pk-steps{display:flex;flex-direction:column;gap:0;padding-top:2px}',
      '.pk-step{position:relative;display:flex;gap:8px;padding:4px 0 4px 14px;font-size:11px;line-height:16px}',
      '.pk-step::before{content:"";position:absolute;left:3px;top:11px;bottom:-3px;width:1px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14))}',
      '.pk-step:last-child::before{display:none}',
      '.pk-dot{position:absolute;left:0;top:9px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}',
      '.pk-step.is-latest .pk-dot{background:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.pk-step.is-ok .pk-dot{background:#22a06b}',
      '.pk-step.is-new{background:rgba(57,100,254,.06);border-radius:6px}',
      '.pk-step.is-new .pk-dot{background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 2px rgba(57,100,254,.18)}',
      '.pk-time{flex:none;width:88px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.pk-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.pk-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding-top:4px}',
      '.pk-add{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
      '.pk-field{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.pk-field label{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c);min-width:52px}',
      '.pk-input{box-sizing:border-box;flex:1 1 140px;min-width:0;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px;line-height:16px}',
      '.pk-input.is-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.pk-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
      '.pk-select{flex:1 1 120px;min-width:0;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:11.5px}',
      '.pk-cands{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.pk-cand{padding:1px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.pk-cand:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.pk-cand[aria-pressed="true"]{border-color:rgba(57,100,254,.45);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.pk-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.pk-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.pk-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '@keyframes pk-swap{from{opacity:0;transform:translateY(4px)}}',
      '.pk-row.is-unread{animation:pk-swap .24s cubic-bezier(.22,.7,.3,1)}',
      '@media (prefers-reduced-motion:reduce){.pk-row.is-unread{animation:none}}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num

  /** `2 小时前` style, for the newest scan. */
  function ago(at, lang) {
    if (!at) return ''
    const then = Date.parse(String(at).replace(/-/g, '/'))
    if (!Number.isFinite(then)) return String(at).slice(5, 16)
    const minutes = Math.floor((Date.now() - then) / 60_000)
    if (minutes < 1) return lang === 'zh' ? '刚刚' : 'just now'
    if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`
    const days = Math.floor(hours / 24)
    return lang === 'zh' ? `${days} 天前` : `${days}d ago`
  }

  function ParcelRow(props) {
    const { parcel, lang, open, onToggle, onCheck, onRemove, onRead, busy } = props
    const zh = lang === 'zh'
    const nodes = Array.isArray(parcel.nodes) ? parcel.nodes : []
    // Newest first, which is how every courier app reads.
    const ordered = nodes.slice().reverse()
    const newCount = num(parcel.newNodes) ?? 0
    const shown = ordered.slice(0, PK_VISIBLE_NODES)
    const statusTone = parcel.tone === 'ok' ? 'is-ok' : parcel.tone === 'crit' ? 'is-crit' : parcel.tone === 'warn' ? 'is-warn' : ''

    return jsxs('div', { className: `pk-row${parcel.unread ? ' is-unread' : ''}`, 'data-nu': parcel.nu, children: [
      jsxs('button', {
        type: 'button',
        className: 'pk-rowhead',
        'aria-expanded': open ? 'true' : 'false',
        // The row is name-first (the user's label if there is one), so the
        // carrier has to be reachable somewhere: it heads the expanded body and
        // it is here in the tooltip.
        title: `${parcel.carrier} ${parcel.nu}${parcel.label ? ` · ${parcel.label}` : ''}`,
        onClick: () => {
          onToggle()
          if (!open && parcel.unread) onRead()
        },
        children: [
          jsx('span', { className: 'pk-caret', 'aria-hidden': true, children: open ? '▾' : '▸' }),
          jsx('span', { className: 'pk-name', children: parcel.label || parcel.carrier }),
          jsx('span', { className: 'pk-nu', children: parcel.nu }),
          jsx('span', { className: `pk-chip t-${parcel.tone || 'info'}`, children: zh ? parcel.stateText : (parcel.stateTextEn || parcel.stateText) }),
          parcel.unread ? jsx('span', { className: 'pk-new', children: zh ? `${newCount || 1} 新` : `${newCount || 1} new` }) : null,
          jsxs('span', { className: 'pk-meta', children: [
            parcel.location ? jsx('span', { className: 'pk-where', children: parcel.location }) : null,
            jsx('span', { children: ago(parcel.latestAt, lang) }),
          ] }),
        ],
      }),
      open
        ? jsxs('div', { className: 'pk-body', children: [
            jsx('div', { className: 'pk-note', children: [
              parcel.carrier,
              ' · ',
              parcel.nu,
              parcel.label ? ` · ${parcel.label}` : '',
              parcel.phone ? ` · ${zh ? '尾号' : 'phone'} ${parcel.phone}` : '',
            ].join('') }),
            parcel.error
              ? jsx('div', { className: 'pk-msg is-err', children: parcel.error })
              : null,
            parcel.summary
              ? jsx('div', { className: 'pk-sum', children: parcel.summary })
              : jsx('div', { className: 'pk-empty', children: parcel.noData
                  ? (zh ? '这家快递还没有这个单号的轨迹 —— 刚发货时常见，过几小时再看。' : 'no scans yet — normal right after dispatch')
                  : (zh ? '暂无轨迹数据' : 'no tracking data') }),
            // The place is a NAME taken from the scan text, not a coordinate.
            parcel.location
              ? jsx('div', { className: 'pk-note pk-src', children: zh
                  ? `最新位置：${parcel.location}（取自扫描文案，接口不提供经纬度）`
                  : `latest place: ${parcel.location} (from the scan text — the API carries no coordinates)` })
              : null,
            shown.length > 0
              ? jsxs('div', { className: 'pk-steps', children: [
                  ...shown.map((node, index) => {
                    const isNew = index < newCount
                    const isLatest = index === 0
                    const isOk = isLatest && parcel.signed
                    return jsxs('div', {
                      className: `pk-step${isNew ? ' is-new' : ''}${isLatest ? ' is-latest' : ''}${isOk ? ' is-ok' : ''}`,
                      children: [
                        jsx('span', { className: 'pk-dot', 'aria-hidden': true }),
                        jsx('span', { className: 'pk-time', children: String(node.at).slice(0, 16) }),
                        jsx('span', { className: 'pk-text', children: node.text }),
                      ],
                    }, `${node.at}-${index}`)
                  }),
                  ordered.length > shown.length
                    ? jsx('div', { className: 'pk-note', children: zh ? `还有 ${ordered.length - shown.length} 条更早的记录` : `${ordered.length - shown.length} older scans` })
                    : null,
                ] })
              : null,
            jsxs('div', { className: 'pk-actions', children: [
              jsx('button', { type: 'button', className: 'pk-btn', disabled: busy, onClick: onCheck, children: busy ? (zh ? '查询中…' : 'checking…') : (zh ? '刷新这个' : 'refresh') }),
              parcel.unread
                ? jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: onRead, children: zh ? '标记已读' : 'mark read' })
                : null,
              jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: onRemove, children: zh ? '不再关注' : 'remove' }),
              jsx('span', { className: 'pk-note', children: parcel.fetchedAt
                ? (zh ? `${ago(new Date(parcel.fetchedAt).toISOString().slice(0, 19).replace('T', ' '), lang)}查询` : `checked ${ago(new Date(parcel.fetchedAt).toISOString().slice(0, 19).replace('T', ' '), lang)}`)
                : (zh ? '尚未查询' : 'not checked yet') }),
            ] }),
          ] })
        : null,
    ] })
  }

  /**
   * The card. Hook order is fixed — nothing returns before every hook has run,
   * so the loading / error / ready states cannot shift the hook count.
   */
  function ParcelCard(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [openNu, setOpenNu] = React.useState(null)
    const [busyNu, setBusyNu] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [adding, setAdding] = React.useState(false)
    const [draft, setDraft] = React.useState({ nu: '', phone: '', label: '', com: '' })
    const [candidates, setCandidates] = React.useState([])
    const [addMsg, setAddMsg] = React.useState(null)
    const aliveRef = React.useRef(true)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/parcel/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    const pollMs = clamp(num(snapshot?.pollMs) ?? PK_FALLBACK_POLL_MS, PK_MIN_POLL_MS, PK_MAX_POLL_MS)

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    React.useEffect(() => {
      let stop
      try {
        stop = typeof props.startTimers === 'function'
          ? props.startTimers(poll, pollMs, undefined, 0)
          : (() => {
              const id = window.setInterval(poll, pollMs)
              return () => window.clearInterval(id)
            })()
      } catch (failure) {
        console.error('[pk] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, pollMs, props.startTimers])

    /** The badge counts parcels whose timeline MOVED since we acknowledged it. */
    const parcels = Array.isArray(snapshot?.parcels) ? snapshot.parcels : []
    const unread = parcels.filter((parcel) => parcel.unread).length
    React.useEffect(() => {
      hud.setBadge('parcel', unread)
    }, [unread])

    const post = React.useCallback(async (action, body) => {
      const json = await hud.fetchJson(`/dsh-hud/parcel/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (aliveRef.current) {
        setSnapshot(json)
        setError(null)
      }
      return json
    }, [])

    const refreshAll = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        await post('refresh')
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy, post])

    const checkOne = React.useCallback(async (nu) => {
      setBusyNu(nu)
      try {
        await post('check', { nu })
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusyNu(null)
      }
    }, [post])

    /** Suggest carriers as the number is typed — offline, no request. */
    const detect = React.useCallback(async (nu) => {
      if (nu.trim().length < 6) {
        setCandidates([])
        return
      }
      try {
        const json = await post('detect', { nu })
        if (!aliveRef.current) return
        setCandidates(Array.isArray(json?.candidates) ? json.candidates : [])
        setDraft((current) => (current.com === '' && json?.candidates?.length > 0 ? { ...current, com: json.candidates[0].code } : current))
      } catch {
        if (aliveRef.current) setCandidates([])
      }
    }, [post])

    const submit = React.useCallback(async () => {
      if (!draft.nu.trim() || !draft.com) return
      setAddMsg(null)
      try {
        await post('add', { nu: draft.nu, com: draft.com, phone: draft.phone, label: draft.label })
        if (!aliveRef.current) return
        setDraft({ nu: '', phone: '', label: '', com: '' })
        setCandidates([])
        setAdding(false)
      } catch (failure) {
        if (aliveRef.current) setAddMsg(failure instanceof Error ? failure.message : String(failure))
      }
    }, [draft, post])

    const carrierList = Array.isArray(snapshot?.carriers) ? snapshot.carriers : []
    const tone = parcels.some((parcel) => parcel.unread) ? 'is-warn'
      : parcels.some((parcel) => parcel.tone === 'brand') ? ''
        : parcels.length > 0 && parcels.every((parcel) => parcel.tone === 'ok') ? 'is-ok' : ''
    const stamp = snapshot?.fetchedAt
      ? new Date(snapshot.fetchedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false })
      : null

    return jsxs('div', { className: 'pk-root', 'data-panel': 'parcel', children: [
      jsxs('div', { className: 'pk-head', children: [
        jsx('span', { className: `pk-status ${tone}`.trim(), 'aria-hidden': true }),
        jsx('span', { className: 'pk-title', children: zh ? '快递' : 'Parcels' }),
        jsx('span', { className: 'pk-sub', children: parcels.length === 0
          ? (zh ? '还没有关注任何包裹' : 'nothing watched yet')
          : (zh ? `${parcels.length} 个包裹${unread > 0 ? ` · ${unread} 个有新动态` : ''}` : `${parcels.length} watched${unread > 0 ? ` · ${unread} updated` : ''}`) }),
        jsxs('span', { className: 'pk-right', children: [
          stamp ? jsx('span', { children: stamp }) : null,
          jsx('button', { type: 'button', className: 'pk-btn', onClick: refreshAll, disabled: busy, children: busy ? (zh ? '刷新中' : 'refreshing') : (zh ? '刷新' : 'refresh') }),
        ] }),
      ] }),
      error ? jsx('div', { className: 'pk-msg is-err', children: error }) : null,
      parcels.length > 0
        ? jsx('div', { className: 'pk-list', children: parcels.map((parcel) => jsx(ParcelRow, {
            parcel,
            lang,
            open: openNu === parcel.nu,
            busy: busyNu === parcel.nu,
            onToggle: () => setOpenNu((current) => (current === parcel.nu ? null : parcel.nu)),
            onCheck: () => checkOne(parcel.nu),
            onRemove: () => { post('remove', { nu: parcel.nu }).catch(() => {}) },
            onRead: () => { post('read', { nu: parcel.nu }).catch(() => {}) },
          }, parcel.nu)) })
        : jsx('div', { className: 'pk-empty', children: zh
            ? '点下面的「添加单号」把快递单号粘进来，之后每 5 分钟自动看一次；有新的扫描记录就会在标题栏和页签上标出来。'
            : 'Add a tracking number below. It is checked every 5 minutes and new scans are flagged on the tab.' }),
      adding
        ? jsxs('div', { className: 'pk-add', children: [
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '单号' : 'number' }),
              jsx('input', {
                className: 'pk-input is-mono',
                value: draft.nu,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: zh ? '粘贴快递单号' : 'paste a tracking number',
                onChange: (event) => {
                  const nu = event.target.value
                  setDraft((current) => ({ ...current, nu }))
                  setAddMsg(null)
                  detect(nu)
                },
              }),
            ] }),
            candidates.length > 0
              ? jsxs('div', { className: 'pk-cands', children: [
                  jsx('span', { className: 'pk-note', children: zh ? '可能是' : 'maybe' }),
                  ...candidates.slice(0, 5).map((candidate) => jsx('button', {
                    type: 'button',
                    className: 'pk-cand',
                    'aria-pressed': draft.com === candidate.code ? 'true' : 'false',
                    title: candidate.confidence >= 3 ? (zh ? '单号前缀明确' : 'clear prefix') : (zh ? '按单号格式推测，请确认' : 'guessed from the format — please confirm'),
                    onClick: () => setDraft((current) => ({ ...current, com: candidate.code })),
                    children: candidate.name,
                  }, candidate.code)),
                ] })
              : null,
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '快递' : 'carrier' }),
              jsxs('select', {
                className: 'pk-select',
                value: draft.com,
                onChange: (event) => setDraft((current) => ({ ...current, com: event.target.value })),
                children: [
                  jsx('option', { value: '', children: zh ? '请选择' : 'choose' }),
                  ...carrierList.map((carrier) => jsx('option', { value: carrier.code, children: carrier.name }, carrier.code)),
                ],
              }),
            ] }),
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '手机后四位' : 'phone (last 4)' }),
              jsx('input', {
                className: 'pk-input is-mono',
                value: draft.phone,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: zh ? '顺丰等隐私面单需要，可留空' : 'needed by some carriers',
                onChange: (event) => setDraft((current) => ({ ...current, phone: event.target.value })),
              }),
            ] }),
            jsxs('div', { className: 'pk-field', children: [
              jsx('label', { children: zh ? '备注' : 'label' }),
              jsx('input', {
                className: 'pk-input',
                value: draft.label,
                spellCheck: false,
                placeholder: zh ? '比如「键盘」' : 'e.g. keyboard',
                onChange: (event) => setDraft((current) => ({ ...current, label: event.target.value })),
              }),
            ] }),
            addMsg ? jsx('div', { className: 'pk-msg is-err', children: addMsg }) : null,
            jsxs('div', { className: 'pk-actions', children: [
              jsx('button', { type: 'button', className: 'pk-btn', disabled: !draft.nu.trim() || !draft.com, onClick: submit, children: zh ? '添加并查询' : 'add' }),
              jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: () => { setAdding(false); setAddMsg(null) }, children: zh ? '取消' : 'cancel' }),
              jsx('span', { className: 'pk-note', children: zh
                ? '快递公司必须选：接口的自动识别现在需要 key，这里改用本地单号格式推测。'
                : 'Carrier is required: the online detector needs a key now, so the suggestion above is a local pattern guess.' }),
            ] }),
          ] })
        : jsx('button', { type: 'button', className: 'pk-btn is-quiet', onClick: () => setAdding(true), children: zh ? '＋ 添加单号' : '+ add a number' }),
      jsx('span', { className: 'pk-note', children: zh
        ? `每 ${Math.round(pollMs / 60_000)} 分钟自动看一次；接口免费无限流保证，实际查询间隔不低于 ${Math.round((num(snapshot?.refreshMs) ?? 0) / 60_000) || 15} 分钟。`
        : `Checked every ${Math.round(pollMs / 60_000)} min; upstream queries are spaced at least ${Math.round((num(snapshot?.refreshMs) ?? 0) / 60_000) || 15} min.` }),
    ] })
  }

  return {
    id: 'parcel',
    // 30: packed third, right after 用量限额 (20) and 数据库 (25).
    //
    // THE ORDER IS THE GEOMETRY. The packer scans top-left first, row by row, so a card lands
    // in the first hole big enough for it. With 股市债市 (10 rows) and 数据库 (10 rows) already
    // filling columns 1 and 3, the hole at row 4 of the MIDDLE column is the first one this card
    // fits — which is what puts it under 用量限额 rather than somewhere else.
    order: 30,
    // One column: a compact list that expands. Widen it in ⚙ if you like long
    // timelines.
    span: 1,
    // On by default now: it is one of the three cards of the middle column, and a column with a
    // hole in the middle of it is the layout this card exists to fill.
    defaultOn: true,
    /**
     * ONE row. Not a measurement: the content is a single horizontal line once the blocks sit side
     * by side, and the middle column is 用量限额 (3) + 快递 (1) + GitHub (1), which has to add up to
     * the 5 the two full-height cards claim.
     */
    defaultRows: 1,
    label: { zh: '快递', en: 'Parcels' },
    Component: ParcelCard,
    __test: { ParcelCard, ago },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/quota/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud — browser half of the `quota` panel.
//
// A FRAGMENT, not a standalone module: tools/build-client.mjs concatenates the
// panel fragments verbatim into ONE `dsh-hud` bundle, inside a single factory
// scope. So this file has no top-level import/export/return — the whole panel
// is nested in `createQuotaPanel()` below, which returns its registry entry.
// The enclosing bundle scope already provides `React`, `jsx`, `jsxs`, `hud` and
// `registerPanel`; this fragment declares none of them.
//
// The shell owns the dock cell, the placement and the timers: it builds
// `startTimers` and passes the platform props (`startTimers`, `useProjection`)
// straight through to the panel's `Component`.
//
// Behaviour:
//  - registers a compact usage card into the `conversation.input.dock` list
//    slot (the strip directly above the composer card, session scope);
//  - the card is stacked ABOVE the scrolling transcript (sticky + z-index +
//    opaque surface) so content scrolling past never shows behind or over it;
//  - each configured `opencode*` subscription gets its own window set and the
//    card auto-rotates through them (8 s), pausing while hovered; dots switch
//    manually;
//  - two bars per window: a usage bar with a SEGMENTED gradient that cools to
//    amber past 60 % and to red past 80 %, and a REVERSE time bar counting
//    down to the reset (hover it for the exact reset time);
//  - session decode rate plus this-run instant rate, from the `sessionStats`
//    projection (same source as the composer status line);
//  - polls the host's same-origin `/dsh-hud/quota/usage` route on the live
//    `pollMs` cadence (configurable host-side, hard floor 30 s).
//
// Visual language: quiet and native — DSH theme tokens, no glow, no gradient
// text, no ambient animation beyond the bar width transition.
function createQuotaPanel() {
    /** Self-diagnostics, filterable in the console with `ocq`. */
    const dbg = (...args) => {
      try {
        console.log('[ocq]', ...args)
      } catch {}
    }
    dbg('factory materialized')

    // ── constants ──────────────────────────────────────────────────────────
    const CLOCK_MS = 1_000
    const DEFAULT_POLL_MS = 60_000
    /** Hard floor of the refresh cadence — mirrored by the host config. */
    const MIN_POLL_MS = 30_000
    const MAX_POLL_MS = 600_000
    /** How long one subscription stays on screen before rotating. */
    const CAROUSEL_MS = 8_000
    const OCGO_PROVIDER = 'opencode-go'
    /** Thresholds: ≥60 warn, ≥80 danger (mirrored by the gradient stops). */
    const WARN_AT = 60
    const DANGER_AT = 80

    /** Window lengths used to derive time-elapsed when a reset time is known. */
    const WINDOWS = [
      { key: 'rolling', zh: '5 小时限额', en: '5-hour limit', spanMs: 5 * 3600_000 },
      { key: 'weekly', zh: '周限额', en: 'Weekly limit', spanMs: 7 * 86400_000 },
      { key: 'monthly', zh: '月限额', en: 'Monthly limit', spanMs: 30 * 86400_000 },
    ]
    const WINDOW_META = Object.fromEntries(WINDOWS.map((m) => [m.key, m]))

    /** Localized labels for the prepaid-balance keys the collectors emit. */
    const BALANCE_LABELS = {
      available: ['可用余额', 'available'],
      granted: ['赠金', 'granted'],
      toppedUp: ['充值余额', 'topped-up'],
      voucher: ['代金券', 'voucher'],
      cash: ['现金', 'cash'],
      gift: ['赠金', 'gift'],
      charge: ['充值余额', 'charged'],
      bonus: ['赠送余额', 'bonus'],
      total: ['总额', 'total'],
      used: ['已用', 'used'],
      credits: ['剩余额度', 'credits'],
    }

    /**
     * Normalize one host row into the shape the card renders:
     *   `{ id, label, plan?, windows: [{key, percent, resetsAt?}], balances, error? }`
     * Legacy payloads carrying `usage.{rolling,weekly,monthly}` are converted
     * here so an old host half still renders.
     */
    function normalizeRow(row) {
      const windows = []
      if (Array.isArray(row?.windows) && row.windows.length > 0) {
        for (const w of row.windows) {
          const pct = num(w?.percent)
          if (pct === undefined) continue
          windows.push({
            key: String(w.key ?? ''),
            // Custom sources may ship their own label (e.g. "Token 套餐").
            label: typeof w.label === 'string' && w.label ? w.label : undefined,
            percent: clamp(pct, 0, 100),
            resetsAt: num(w.resetsAt),
            // Optional absolute credits (千问 Token Plan): 13,284 / 180,000.
            used: num(w.used),
            total: num(w.total),
            unit: typeof w.unit === 'string' && w.unit ? w.unit : undefined,
          })
        }
      } else if (row?.usage && typeof row.usage === 'object') {
        for (const meta of WINDOWS) {
          const w = row.usage[meta.key]
          const pct = percentOf(w)
          if (pct === undefined) continue
          windows.push({ key: meta.key, percent: pct, resetsAt: resetsAtOf(w) })
        }
      }
      return {
        id: String(row?.id ?? ''),
        label: String(row?.label ?? ''),
        kind: String(row?.kind ?? ''),
        plan: typeof row?.plan === 'string' && row.plan ? row.plan : undefined,
        // Drawer status: [{ ref, present }] — refs only, values never ship.
        credentials: Array.isArray(row?.credentials)
          ? row.credentials
              .filter((c) => c && typeof c.ref === 'string')
              .map((c) => ({ ref: c.ref, present: Boolean(c.present) }))
          : [],
        windows,
        balances: Array.isArray(row?.balances)
          ? row.balances.filter((b) => b && typeof b === 'object' && typeof b.key === 'string')
          : [],
        // Structured fix-it panel: “请安装 XXX” + command + steps.
        hint: row?.hint && typeof row.hint === 'object' && typeof row.hint.title === 'string'
          ? {
              title: row.hint.title,
              install: typeof row.hint.install === 'string' ? row.hint.install : undefined,
              steps: Array.isArray(row.hint.steps) ? row.hint.steps.filter((s) => typeof s === 'string') : [],
            }
          : undefined,
        // Usage series (last 30 days) → line chart.
        series: Array.isArray(row?.series)
          ? row.series
              .filter((p) => p && typeof p.t === 'number' && typeof p.v === 'number')
              .map((p) => ({ t: p.t, v: p.v, c: typeof p.c === 'number' ? p.c : undefined }))
          : [],
        granularity: row?.granularity === 'hour' || row?.granularity === 'day' ? row.granularity : undefined,
        seriesTokens: num(row?.seriesTokens),
        seriesCost: num(row?.seriesCost),
        error: typeof row?.error === 'string' && row.error ? row.error : undefined,
      }
    }

    /**
     * The usage ramp, designed to be ANCHORED TO THE TRACK (the fill scales
     * it with `background-size`, so colours line up with absolute usage — a
     * 20 % bar shows only blue, never a squeezed rainbow).
     *
     * Palette logic: brand blue below the warn line, a cool sand bridge that
     * crosses 60 % exactly on amber, then a short amber → red move that lands
     * on danger at 80 %. Every stop is a mid-saturation solid so the ramp
     * stays clean in both light and dark themes, and the hue never passes
     * through a muddy blue-brown blend.
     */
    const USAGE_GRADIENT =
      'linear-gradient(90deg,#3b6ff2 0%,#5b8bf5 38%,#a9b7d9 51%,#f0b93f 60%,#f2a733 70%,#e8623f 80%,#dd3b34 90%,#d83b34 100%)'

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS_ID = 'dsh-hud/quota.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-hud'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        // Stacked above the transcript: sticky + z-index + an opaque surface,
        // so scrolling content passes behind the card and never overlaps it.
        '.ocq-root{position:sticky;top:0;z-index:1000;isolation:isolate;display:flex;justify-content:center;width:100%;padding:0 2px 8px;font-family:inherit;color:var(--dsw-alias-label-primary,#0f1115)}',
        // Surface: layered shadow (edge + soft ambient) and a hairline top
        // highlight read as a real card without any glow or gradient chrome.
        '.ocq-card{box-sizing:border-box;width:min(100%,560px);display:flex;flex-direction:column;gap:10px;padding:11px 13px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#ffffff);box-shadow:inset 0 1px 0 rgba(255,255,255,.65),0 1px 2px rgba(0,0,0,.05),0 10px 28px -18px rgba(15,17,21,.45)}',
        '.ocq-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}',
        // Status LED: worst window's severity at a glance (neutral blue when
        // the row reports balances instead of windows).
        '.ocq-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 3px rgba(57,100,254,.14)}',
        '.ocq-status.is-ok{background:#22a06b;box-shadow:0 0 0 3px rgba(34,160,107,.15)}',
        '.ocq-status.is-warn{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16)}',
        '.ocq-status.is-crit{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}',
        '.ocq-title{font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#0f1115);flex:none}',
        '.ocq-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-right{margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        // Refresh: a quiet pill instead of bare text, with a real focus ring.
        '.ocq-refresh{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;padding:1px 9px;border-radius:999px;color:var(--dsw-alias-state-business-primary,#3964fe);font-size:11px;line-height:16px;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
        '.ocq-refresh:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
        '.ocq-refresh:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
        '.ocq-refresh:disabled{opacity:.55;cursor:default}',
        '.ocq-rates{display:flex;align-items:center;gap:14px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
        '.ocq-rate b{margin-left:4px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ocq-rate em{margin-left:4px;font-style:normal;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px 18px}',
        // Side column: a tracked micro-label over the balances, then rows with
        // a dotted leader — table-like alignment without extra chrome. The
        // primary balance (可用) is larger and brand-coloured for hierarchy.
        '.ocq-sidehead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-balances{display:flex;flex-direction:column;gap:8px}',
        '.ocq-balance{display:flex;align-items:baseline;gap:6px;font-size:12px}',
        '.ocq-lead{flex:1 1 auto;min-width:8px;border-bottom:1px dotted var(--dsw-alias-border-l2,rgba(0,0,0,.20));transform:translateY(-3px)}',
        '.ocq-balance span{color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-balance b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ocq-balance.is-primary b{font-size:14.5px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
        // Prepaid + chart mode (DeepSeek): balances left, chart right, so the
        // card stacks nothing vertically and stays short. Wraps to two lines
        // when the dock is too narrow for both (min-widths force the break
        // instead of squeezing the chart to nothing).
        '.ocq-split{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}',
        '.ocq-side{flex:0 1 148px;min-width:132px;display:flex;flex-direction:column;gap:6px}',
        '.ocq-main{flex:1 1 240px;min-width:180px}',
        // Structured fix-it panel (“请安装 XXX” + command + steps).
        '.ocq-hint{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}',
        '.ocq-hint-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.ocq-code{display:block;box-sizing:border-box;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-state-business-primary,#3964fe);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;overflow-x:auto;white-space:nowrap;user-select:all}',
        '.ocq-step{position:relative;padding-left:14px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
        '.ocq-step::before{content:"›";position:absolute;left:4px;color:var(--dsw-alias-label-caption,#81858c)}',
        // Copy affordances: every command-like line and the install block can
        // go to the clipboard in one click; URLs become real links.
        '.ocq-coderow{display:flex;align-items:center;gap:6px}',
        '.ocq-coderow .ocq-code{flex:1 1 auto;min-width:0}',
        '.ocq-copybtn{flex:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));background:transparent;border-radius:5px;padding:1px 6px;margin-left:6px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:border-color .15s ease,color .15s ease}',
        '.ocq-copybtn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ocq-copybtn.is-done{color:#22a06b;border-color:rgba(34,160,107,.45)}',
        '.ocq-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none;border-bottom:1px dotted currentColor;word-break:break-all}',
        '.ocq-link:hover{border-bottom-style:solid}',
        // Credential drawer: paste a Cookie/token/key (or a whole cURL) and
        // save it without opening the YAML file.
        '.ocq-drawer{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.03))}',
        '.ocq-drawer.is-open{border-color:rgba(57,100,254,.35)}',
        '.ocq-drawer-btn{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#3964fe);font-size:11.5px;cursor:pointer;text-align:left}',
        '.ocq-drawer-caret{width:10px;color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-drawer-btn em{font-style:normal;padding:0 5px;border-radius:4px;background:rgba(57,100,254,.12);font-size:10px;color:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ocq-drawer-body{display:flex;flex-direction:column;gap:6px}',
        '.ocq-drawer-input{box-sizing:border-box;width:100%;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#0f1115);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}',
        '.ocq-drawer-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
        '.ocq-drawer-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.ocq-drawer-ghost{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;border-radius:999px;padding:1px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
        '.ocq-drawer-ghost:hover{border-color:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-drawer-save{border:1px solid var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff;border-radius:999px;padding:1px 11px;font-size:11px;cursor:pointer}',
        '.ocq-drawer-save:disabled{opacity:.5;cursor:default}',
        '.ocq-drawer-msg{font-size:11px;color:#22a06b}',
        '.ocq-drawer-msg.is-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.ocq-drawer-note{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
        // Usage line chart: full content width, small side gutters.
        '.ocq-chart{display:flex;flex-direction:column;gap:5px;padding:3px 4px 0}',
        '.ocq-chart-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:11px}',
        '.ocq-chart-title{color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-chart-meta{color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ocq-chart-box{position:relative;width:100%;height:104px}',
        '.ocq-chart-svg{display:block;width:100%;height:104px}',
        // Shorter plot when the chart shares a row with the balance column.
        '.ocq-chart--sm .ocq-chart-box{height:74px}',
        '.ocq-chart--sm .ocq-chart-svg{height:74px}',
        '.ocq-chart-grid{stroke:var(--dsw-alias-border-l1,rgba(0,0,0,.07));stroke-width:1;stroke-dasharray:3 4;vector-effect:non-scaling-stroke}',
        '.ocq-chart-area{fill:url(#ocq-chart-fill)}',
        '.ocq-chart-line{fill:none;stroke:var(--dsw-alias-state-business-primary,#3964fe);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}',
        '.ocq-chart-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ocq-chart-now{color:var(--dsw-alias-state-business-primary,#3964fe)}',
        // Chart polish: a hairline baseline under the plot, the y-extremes as
        // HTML (never stretched), and a static marker on the newest point.
        '.ocq-chart-base{stroke:var(--dsw-alias-border-l2,rgba(0,0,0,.12));stroke-width:1;vector-effect:non-scaling-stroke;opacity:.55}',
        '.ocq-chart-yaxis{position:absolute;right:3px;top:1px;font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-caption,#81858c);opacity:.85;pointer-events:none;font-variant-numeric:tabular-nums}',
        '.ocq-chart-yaxis.is-zero{top:auto;bottom:2px;opacity:.6}',
        '.ocq-chart-mark{position:absolute;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#ffffff));transform:translate(-50%,-50%);pointer-events:none}',
        // Hover tooltip: a dashed guide marks the column, the bubble states
        // date · tokens · cost in words. Sibling of the SVG (box is relative),
        // pointer-events:none so it never steals the hover it is showing.
        '.ocq-hoverline{stroke:var(--dsw-alias-label-caption,#81858c);stroke-width:1;stroke-dasharray:2 3;vector-effect:non-scaling-stroke;opacity:.9}',
        '.ocq-tip{position:absolute;top:3px;z-index:2;pointer-events:none;padding:3px 7px;border-radius:6px;background:rgba(23,26,32,.94);color:#fff;font-size:10.5px;line-height:15px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.22);font-variant-numeric:tabular-nums;animation:ocq-fade .12s ease-out}',
        '.ocq-tip b{font-weight:600}',
        '.ocq-tip i{font-style:normal;opacity:.62;margin-left:5px}',
        '.ocq-cell{display:flex;flex-direction:column;gap:5px;min-width:0}',
        '.ocq-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
        '.ocq-name{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.ocq-pct{min-width:4ch;text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
        // Usage bar: a neutral inset track; the fill carries the ramp, scaled
        // to the track width so each colour marks its absolute usage level.
        '.ocq-track{position:relative;height:7px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));box-shadow:inset 0 1px 1px rgba(0,0,0,.05)}',
        '.ocq-fill{position:relative;height:100%;border-radius:4px;background-repeat:no-repeat;box-shadow:inset 0 1px 0 rgba(255,255,255,.22);transition:width .35s ease}',
        '.ocq-fill::after{content:"";position:absolute;top:0;right:0;bottom:0;width:2px;border-radius:0 4px 4px 0;background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,.3))}',
        // Reverse time bar: shrinks towards zero as the window drains.
        '.ocq-time{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));overflow:hidden;cursor:default}',
        '.ocq-timefill{height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(129,133,140,.30),rgba(129,133,140,.72));transition:width .5s ease}',
        '.ocq-foot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
        '.ocq-warn{color:var(--dsw-static-amber-500,#f59e0b)}',
        '.ocq-crit{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.ocq-dots{display:flex;align-items:center;gap:6px;padding-top:1px}',
        '.ocq-dotbtn{width:16px;height:14px;padding:0;border:0;background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
        '.ocq-dotbtn::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));transition:background .15s ease,width .15s ease}',
        '.ocq-dotbtn:hover::before{background:var(--dsw-alias-label-caption,#81858c)}',
        '.ocq-dotbtn[aria-current="true"]::before{width:14px;border-radius:3px;background:var(--dsw-alias-state-business-primary,#3964fe)}',
        '.ocq-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
        '.ocq-msg.ocq-crit{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        // ── motion ────────────────────────────────────────────────────────
        // Two moments only: DRAW (bars grow from 0, the line strokes itself,
        // cells fade up staggered) and SWITCH (the whole body swaps in, keyed
        // by the active subscription). No idle animation — the card stays
        // quiet while data sits still.
        '@keyframes ocq-grow{from{width:0}}',
        '@keyframes ocq-fade{from{opacity:0}}',
        '@keyframes ocq-swap{from{opacity:0;transform:translateY(5px)}}',
        '@keyframes ocq-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}',
        '.ocq-body{display:flex;flex-direction:column;gap:9px;animation:ocq-swap .26s cubic-bezier(.22,.7,.3,1)}',
        '.ocq-cell{animation:ocq-fade .3s ease-out both}',
        '.ocq-cell:nth-child(2){animation-delay:.05s}',
        '.ocq-cell:nth-child(3){animation-delay:.1s}',
        '.ocq-cell:nth-child(4){animation-delay:.15s}',
        // `backwards` on delayed animations: hold the from-state (width 0 /
        // hidden) during the delay instead of flashing the final frame first.
        '.ocq-fill{animation:ocq-grow .55s cubic-bezier(.22,.7,.3,1)}',
        '.ocq-timefill{animation:ocq-grow .55s .1s cubic-bezier(.22,.7,.3,1) backwards}',
        '.ocq-chart-line{stroke-dasharray:1;animation:ocq-draw .9s .12s ease-out backwards}',
        '.ocq-chart-area{animation:ocq-fade .9s .3s ease-out backwards}',
        '.ocq-hint{animation:ocq-fade .28s ease-out}',
        '.ocq-dots{animation:ocq-fade .28s ease-out}',
        // Honour the OS setting: never animate for users who opted out.
        '@media (prefers-reduced-motion:reduce){.ocq-body,.ocq-cell,.ocq-fill,.ocq-timefill,.ocq-chart-line,.ocq-chart-area,.ocq-hint,.ocq-dots,.ocq-tip{animation:none}}',
      ].join('')
      document.head.appendChild(tag)
    }

    // ── locale ─────────────────────────────────────────────────────────────
    function pickLocale() {
      try {
        const html = document.documentElement.lang || ''
        if (/^zh/i.test(html)) return 'zh'
        if (navigator.language && /^zh/i.test(navigator.language)) return 'zh'
      } catch {}
      return 'en'
    }

    // ── data helpers ───────────────────────────────────────────────────────
    const isOpenCodeGo = (provider) =>
      provider === OCGO_PROVIDER || String(provider ?? '').startsWith(`${OCGO_PROVIDER}/`)

    /**
     * Providers this plugin has a collector for — mirrors the host's
     * `inferKind`. The card stays visible for any of them (and for unknown
     * providers, fail-open), so selecting DeepSeek/Kimi/GLM doesn't hide the
     * subscriptions those vendors contribute.
     */
    const SUPPORTED_PROVIDER_RE = /opencode|deepseek|moonshot|kimi|glm|zai|zhipu|bigmodel|grok|xai|mimo|xiaomi|openrouter|siliconflow|silicon|qwen|qianwen|dashscope|aliyun|alibaba|token-plan|commandcode|command-code/i
    const isSupportedProvider = (provider) => {
      if (typeof provider !== 'string' || provider === '') return true // unknown → fail-open
      return SUPPORTED_PROVIDER_RE.test(provider)
    }

    /** Mirror of the host's `inferKind`: provider id → collector kind. */
    function providerKind(provider) {
      const s = String(provider ?? '').toLowerCase()
      if (s.includes('opencode')) return 'opencode-go'
      if (s.includes('deepseek')) return 'deepseek'
      if (s.includes('moonshot') || s.includes('kimi')) return 'moonshot'
      if (s.includes('glm') || s.includes('zai') || s.includes('zhipu') || s.includes('bigmodel')) return 'zai'
      if (s.includes('grok') || s.includes('xai')) return 'grok'
      if (s.includes('mimo') || s.includes('xiaomi')) return 'mimo'
      if (s.includes('openrouter')) return 'openrouter'
      if (s.includes('siliconflow') || s.includes('silicon')) return 'siliconflow'
      if (s.includes('qwen') || s.includes('qianwen') || s.includes('dashscope') || s.includes('token-plan')
          || s.includes('aliyun') || s.includes('alibaba') || s.includes('bailian')) return 'qwen'
      if (s.includes('commandcode') || s.includes('command-code')) return 'commandcode'
      return null
    }

    /**
     * The card follows the session's provider: pick ONLY the subscriptions
     * belonging to it, so switching models switches the billing view and hides
     * every other vendor.
     *
     * Match order:
     *   1. exact id            `deepseek` → `deepseek`, `qwen-token-plan-cn` → same,
     *                          user-defined ids match their provider name
     *   2. id/provider prefix  `opencode` → `opencode` (NOT `opencode-go`),
     *                          `deepseek-v4` → `deepseek`
     *   3. collector kind      `xai` → the `grok` row, `zhipu` → the `zai` row
     * Nothing matched → [] : the Hud explains it. Showing the full list here
     * was the bug that surfaced OpenCode billing while another model was
     * selected, so a non-empty provider NEVER borrows another vendor's row.
     * Only an empty provider (no model selected yet) keeps the whole list.
     */
    function filterForProvider(rows, provider) {
      const p = String(provider ?? '').trim().toLowerCase()
      if (!p || !Array.isArray(rows) || rows.length === 0) return rows
      const idOf = (r) => String(r.id ?? '').toLowerCase()
      let hit = rows.filter((r) => idOf(r) === p)
      if (hit.length === 0) {
        hit = rows.filter((r) => {
          const id = idOf(r)
          return id.startsWith(`${p}-`) || id.startsWith(`${p}/`) || p.startsWith(`${id}-`)
        })
      }
      if (hit.length > 0) return hit
      const kind = providerKind(p)
      if (kind) hit = rows.filter((r) => r.kind === kind)
      return hit // may be [] → explained by the Hud, never another vendor
    }

    function num(v) {
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    /** Percent used in [0,100] from any plausible field name. */
    function percentOf(w) {
      if (!w) return undefined
      const direct = num(w.percent) ?? num(w.percentUsed) ?? num(w.usedPercent) ?? num(w.usagePercent)
      if (direct !== undefined) return clamp(direct, 0, 100)
      const used = num(w.used)
      const total = num(w.total) ?? num(w.limit) ?? num(w.cap)
      if (used !== undefined && total !== undefined && total > 0) {
        return clamp((used / total) * 100, 0, 100)
      }
      return undefined
    }

    function resetsAtOf(w) {
      if (!w) return undefined
      const raw = w.resetsAt ?? w.resetAt ?? w.resets_at ?? w.windowEnd ?? w.expiresAt
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw
      if (typeof raw === 'string') {
        const t = new Date(raw).getTime()
        return Number.isFinite(t) ? t : undefined
      }
      return undefined
    }

    /** Compact countdown: 4天 6时 / 2时 15分 / 8分 / 即将重置. */
    function countdown(ms, lang) {
      if (!Number.isFinite(ms) || ms <= 0) return lang === 'zh' ? '即将重置' : 'soon'
      const m = Math.floor(ms / 60000)
      if (m < 60) return lang === 'zh' ? `${m} 分` : `${m}m`
      const h = Math.floor(m / 60)
      if (h < 24) return lang === 'zh' ? `${h} 时 ${m % 60} 分` : `${h}h ${m % 60}m`
      const d = Math.floor(h / 24)
      return lang === 'zh' ? `${d} 天 ${h % 24} 时` : `${d}d ${h % 24}h`
    }

    /** Threshold class for the percentage text: ≥80 danger, ≥60 warn. */
    function severity(pct) {
      if (pct >= DANGER_AT) return 'ocq-crit'
      if (pct >= WARN_AT) return 'ocq-warn'
      return ''
    }

    /** Tokens-per-second display: one decimal below 10, whole above. */
    function formatTps(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return null
      const v = Math.max(0, value)
      return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
    }

    async function fetchJson(url, init) {
      let res
      try {
        // A bounded wait: an unresponsive host must fail the poll, never hang
        // it — the in-flight guard below would otherwise stop future polls.
        res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000), ...init })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(/timeout|abort/i.test(msg) ? '请求超时（20s）' : `网络错误：${msg}`)
      }
      const json = await res.json().catch(() => null)
      if (!res.ok || !json || json.ok === false) {
        throw new Error(String(json?.error || (json ? `HTTP ${res.status}` : `HTTP ${res.status}（响应不是 JSON）`)))
      }
      return json
    }

    // ── usage line chart ────────────────────────────────────────────────────
    /**
     * Full-content-width line chart (small side gutters so it never touches
     * the card edge), time on x, tokens on y. The SVG stretches to 100 %
     * (`preserveAspectRatio: none`) with non-scaling strokes, so the line
     * stays 2 px whatever the card width; axis labels are HTML, not SVG text,
     * so they never distort.
     */
    function LineChart(props) {
      // Hook FIRST — the early return below must not change the hook count
      // between renders (a series growing from 1 to 2 points would otherwise
      // trip React's "Rendered fewer hooks" guard and kill the slot entry).
      const [hover, setHover] = React.useState(null)
      // Box measured on every pointer event so the bubble can sit at the
      // cursor's own coordinates inside it.
      const boxRef = React.useRef(null)
      const { points, from, to, granularity, tokens, cost, lang } = props
      if (!Array.isArray(points) || points.length < 2) return null
      const W = 1000
      const H = 104
      const TOP = 12
      const BOTTOM = 14
      const plotH = H - TOP - BOTTOM
      const max = Math.max(...points.map((p) => p.v), 1)
      // Raw maximum (0 for an all-zero month) — used by the y-axis label, so
      // an empty month reads "0" instead of the scale floor of 1.
      const maxRaw = Math.max(0, ...points.map((p) => p.v))
      const span = Math.max(1, to - from)
      const x = (t) => clamp((t - from) / span, 0, 1) * W
      const y = (v) => TOP + (1 - v / max) * plotH
      const linePath = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`)
        .join(' ')
      const baseY = (H - BOTTOM).toFixed(1)
      const areaPath = `${linePath} L${x(points[points.length - 1].t).toFixed(1)} ${baseY} L${x(points[0].t).toFixed(1)} ${baseY} Z`
      const stampOf = (t) => new Date(t).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      })
      const fmtNum = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)))
      const hitWidth = W / Math.max(points.length, 1)
      const title = lang === 'zh'
        ? (granularity === 'hour' ? '用量曲线（小时级）' : '用量曲线（按日聚合）')
        : (granularity === 'hour' ? 'Usage (hourly)' : 'Usage (daily buckets)')
      const tokensLabel = tokens === undefined ? ''
        : (lang === 'zh' ? `共 ${fmtNum(tokens)} tok` : `${fmtNum(tokens)} tok total`)
      const costLabel = cost === undefined || !cost ? '' : (lang === 'zh' ? ` · ¥${cost.toFixed(2)}` : ` · $${cost.toFixed(2)}`)
      // Split mode (shares a row with the balances column): drop the prose
      // title — the axis already states the range — and keep only the numbers.
      const compact = Boolean(props.compact)
      const meta = tokensLabel || costLabel ? `${tokensLabel}${costLabel}` : ''

      // Hover → text tooltip. The bubble FOLLOWS THE CURSOR on both axes: it
      // is anchored to the mouse, never to the data point, so pointer position
      // and tooltip position can never disagree (anchoring to the point left a
      // visible offset — up to half a column — and the edge-flip made it worse).
      // The dashed guide still marks the point: that is the exact datum.
      const track = (event, i) => {
        const el = boxRef.current
        let px
        let py
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            px = ((event.clientX - r.left) / r.width) * 100
            py = ((event.clientY - r.top) / r.height) * 100
          }
        }
        setHover({ i, px, py })
      }
      // Index is clamped so a poll that shortens the series can never point
      // the bubble at a removed point.
      const hi = hover && hover.i >= 0 && hover.i < points.length ? hover.i : null
      const tipPoint = hi === null ? null : points[hi]
      // Fallback to the point's x when an event carries no coordinates.
      // NOTE: `hover` itself is null before any pointer event — `??` only
      // guards the value, so the host needs optional chaining too. Reading
      // `hover.py` directly here crashed the whole slot entry on first paint.
      const tipPct = tipPoint ? (hover?.px ?? (x(tipPoint.t) / W) * 100) : 0
      const tipPctY = hover?.py ?? 4
      // Keep the bubble inside the card: flip horizontally near both edges,
      // and lift it ABOVE the cursor in the lower half of the plot.
      const tipAlignX = tipPct < 16 ? '0' : tipPct > 84 ? '-100%' : '-50%'
      const tipAlignY = tipPctY > 58 ? 'calc(-100% - 6px)' : '10px'
      const tipTransform = `translate(${tipAlignX}, ${tipAlignY})`
      const dayLabel = (t) => new Date(t).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit', day: '2-digit',
      })
      const money = lang === 'zh' ? '¥' : '$'
      const tipText = tipPoint
        ? `${granularity === 'day' ? dayLabel(tipPoint.t) : stampOf(tipPoint.t)} · ${fmtNum(tipPoint.v)} tok${tipPoint.c ? ` · ${money}${tipPoint.c.toFixed(2)}` : ''}`
        : ''

      return jsxs('div', { className: `ocq-chart${compact ? ' ocq-chart--sm' : ''}`, children: [
        compact
          ? (meta
              ? jsx('div', { className: 'ocq-chart-head', children: jsx('span', { className: 'ocq-chart-meta', children: meta }) })
              : null)
          : jsxs('div', { className: 'ocq-chart-head', children: [
              jsx('span', { className: 'ocq-chart-title', children: title }),
              meta ? jsx('span', { className: 'ocq-chart-meta', children: meta }) : null,
            ] }),
        jsxs('div', {
          className: 'ocq-chart-box',
          ref: boxRef,
          // Clear on LEAVING the whole box (not per column): crossing from one
          // column to the next then never flickers the tooltip away.
          onMouseLeave: () => setHover(null),
          children: [
            jsxs('svg', {
              className: 'ocq-chart-svg',
              viewBox: `0 0 ${W} ${H}`,
              preserveAspectRatio: 'none',
              role: 'img',
              'aria-label': title,
              children: [
                jsxs('defs', { children: jsxs('linearGradient', {
                  id: 'ocq-chart-fill',
                  x1: 0, y1: 0, x2: 0, y2: 1,
                  children: [
                    jsx('stop', { offset: '0%', 'stop-color': 'var(--dsw-alias-state-business-primary,#3964fe)', 'stop-opacity': 0.3 }),
                    jsx('stop', { offset: '100%', 'stop-color': 'var(--dsw-alias-state-business-primary,#3964fe)', 'stop-opacity': 0 }),
                  ],
                }) }),
                [0.25, 0.5, 0.75].map((f) => jsx('line', {
                  x1: 0, x2: W, y1: TOP + plotH * f, y2: TOP + plotH * f, className: 'ocq-chart-grid',
                }, `g${f}`)),
                // Hairline baseline: the plotted area sits on something.
                jsx('line', {
                  x1: 0, x2: W, y1: H - BOTTOM, y2: H - BOTTOM,
                  className: 'ocq-chart-base',
                }, 'base'),
                jsx('path', { d: areaPath, className: 'ocq-chart-area' }),
                // pathLength=1 lets CSS stroke the line in (dashoffset 1 → 0)
                // without measuring the path in JS.
                jsx('path', { d: linePath, className: 'ocq-chart-line', pathLength: 1 }),
                // Hovered column: a dashed vertical guide (a vertical line is
                // the one stroke the non-uniform x/y stretch cannot distort).
                tipPoint
                  ? jsx('line', {
                      x1: x(tipPoint.t), x2: x(tipPoint.t), y1: 0, y2: H,
                      className: 'ocq-hoverline',
                    }, 'guide')
                  : null,
                points.map((p, i) => jsx('rect', {
                  x: clamp(x(p.t) - hitWidth / 2, 0, W),
                  y: 0,
                  width: hitWidth,
                  height: H,
                  fill: 'transparent',
                  // Enter picks the column; move keeps the bubble pinned to the
                  // cursor while it travels across it.
                  onMouseEnter: (e) => track(e, i),
                  onMouseMove: (e) => track(e, i),
                }, `h${i}`)),
              ],
            }, 'svg'),
            // Text tooltip: date · tokens · cost, pinned at the CURSOR's
            // coordinates inside the chart box (guide line stays on the point).
            tipPoint
              ? jsx('div', {
                  className: 'ocq-tip',
                  'aria-hidden': true,
                  style: {
                    left: `${tipPct}%`,
                    top: `${tipPctY}%`,
                    transform: tipTransform,
                  },
                  children: tipText,
                }, 'tip')
              : null,
            // Y-extremes as HTML — SVG text would stretch with the box — and a
            // static marker on the newest point (HTML dot: a circle inside the
            // non-uniform viewBox would render as an ellipse).
            jsx('div', { className: 'ocq-chart-yaxis', children: maxRaw === 0 ? '0' : fmtNum(maxRaw) }, 'ymax'),
            jsx('div', { className: 'ocq-chart-yaxis is-zero', children: '0' }, 'yzero'),
            jsx('div', {
              className: 'ocq-chart-mark',
              style: {
                left: `${(x(points[points.length - 1].t) / W) * 100}%`,
                top: `${(y(points[points.length - 1].v) / H) * 100}%`,
              },
            }, 'mark'),
          ],
        }),
        jsxs('div', { className: 'ocq-chart-axis', children: [
          jsx('span', { children: stampOf(from) }),
          jsx('span', { children: stampOf((from + to) / 2) }),
          jsx('span', { className: 'ocq-chart-now', children: lang === 'zh' ? '现在' : 'now' }),
        ] }),
      ] })
    }

    // ── paste helpers for the credential drawer ─────────────────────────────
    /**
     * Normalize whatever the user pasted into something a collector can use.
     * Handles: whole `curl …` commands (Copy as cURL), `Cookie:`/`Authorization:`
     * header lines, bare `Bearer …`, and JSON wrappers. NEVER logs the value.
     * @param {string} raw
     * @param {string} ref
     * @returns {{ value: string, kind: string, note: string }}
     */
    function parseSecret(raw, ref) {
      let text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) return { value: '', kind: 'empty', note: '' }
      const wantCookie = /cookie/i.test(String(ref ?? ''))
      const stripBearer = (s) => s.replace(/^bearer\s+/i, '').trim()

      if (/^curl[\s'"]/i.test(text)) {
        // Copy as cURL → extract the auth headers (order: requested kind first).
        const headers = {}
        for (const m of text.matchAll(/(?:-H|--header)\s+(['"])([^'"]*)\1/g)) {
          const idx = m[2].indexOf(':')
          if (idx > 0) headers[m[2].slice(0, idx).trim().toLowerCase()] = m[2].slice(idx + 1).trim()
        }
        const cookie = headers.cookie
        const auth = headers.authorization ?? headers['x-api-key'] ?? headers['x-auth-token']
        const picked = wantCookie || (!auth && cookie) ? cookie : auth
        if (!picked) return { value: '', kind: 'curl', note: 'cURL 里没有 Cookie / Authorization 头' }
        const isCookie = picked === cookie
        return {
          value: isCookie ? picked : stripBearer(picked),
          kind: isCookie ? 'cookie' : 'bearer',
          note: `已从 cURL 解析出${isCookie ? ' Cookie 头' : '认证头'}`,
        }
      }
      if (/^cookie:\s*/i.test(text)) {
        return { value: text.replace(/^cookie:\s*/i, '').trim(), kind: 'cookie', note: '识别为 Cookie 头' }
      }
      if (/^(authorization|x-api-key|x-auth-token):/i.test(text)) {
        return { value: stripBearer(text.replace(/^[^:]+:\s*/i, '')), kind: 'bearer', note: '识别为认证头' }
      }
      if (/^bearer\s+/i.test(text)) {
        return { value: stripBearer(text), kind: 'bearer', note: '已去掉 Bearer 前缀' }
      }
      if (text.startsWith('{')) return { value: text, kind: 'json', note: '识别为 JSON 包装（按原样保存，插件会取 value）' }
      return { value: text, kind: wantCookie ? 'cookie' : 'key', note: '' }
    }

    /** Hint steps that are obviously shell commands / code worth copying. */
    const looksCopyable = (s) =>
      /^(npm|pnpm|yarn|npx|node|grok|qianwen|codex|opencode|curl|dsh|copy\(|localStorage|GET |POST )\b/i.test(String(s).trim())
      || /`[^`]+`/.test(String(s))
    const codeOf = (s) => {
      const m = /`([^`]+)`/.exec(String(s))
      return m ? m[1] : (looksCopyable(s) ? String(s).trim() : null)
    }
    const urlOf = (s) => (String(s).match(/https?:\/\/[^\s，。；）)]+/) || [])[0] ?? null

    // ── component ──────────────────────────────────────────────────────────
    function Hud(props = {}) {
      const lang = pickLocale()
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [, setTick] = React.useState(0)
      const [subIndex, setSubIndex] = React.useState(0)
      const [hovering, setHovering] = React.useState(false)
      // Credential drawer: paste → POST → refresh. Never holds state longer
      // than the interaction (the draft is cleared after a successful save).
      const [drawerOpen, setDrawerOpen] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveMsg, setSaveMsg] = React.useState(null) // { ok, text } | null
      const [copiedKey, setCopiedKey] = React.useState(null)

      // ── rates: session average + this run's instant rate ────────────────
      // Same source as the composer status line (`sessionStats` projection).
      // A missing or throwing projection must not take the card down — the
      // rates simply read as "—" while everything else keeps working.
      let stats
      try {
        stats = typeof props?.useProjection === 'function' ? props.useProjection('sessionStats') : undefined
      } catch (e) {
        dbg('sessionStats projection unavailable', e)
        stats = undefined
      }
      const sampleRef = React.useRef({ tokens: undefined, at: 0, instant: null })
      const decodeMs = num(stats?.decodeMs) ?? 0
      const decodeTokens = num(stats?.decodeTokens) ?? 0
      const avgTps = decodeMs > 0 && decodeTokens > 0 ? decodeTokens / (decodeMs / 1000) : null
      const sampleNow = Date.now()
      if (decodeTokens > 0) {
        const s = sampleRef.current
        if (s.tokens === undefined) {
          s.tokens = decodeTokens
          s.at = sampleNow
        } else if (decodeTokens > s.tokens) {
          const dt = (sampleNow - s.at) / 1000
          if (dt >= 0.35) {
            s.instant = (decodeTokens - s.tokens) / dt
            s.tokens = decodeTokens
            s.at = sampleNow
          }
        }
      }
      const instantTps = sampleRef.current.instant

      // One poll at a time: the interval fires every `pollMs`, and a slow host
      // would otherwise stack overlapping requests (and stale responses) —
      // the last writer must not be an out-of-order reply.
      const inFlightRef = React.useRef(false)
      // Set false on unmount so late responses never setState on a dead card.
      const aliveRef = React.useRef(true)
      React.useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      const poll = React.useCallback(() => {
        if (inFlightRef.current) return
        inFlightRef.current = true
        fetchJson('/dsh-hud/quota/usage').then((json) => {
          if (aliveRef.current) {
            setSnapshot(json)
            setError(null)
          }
        }, (e) => {
          if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
        }).then(() => { inFlightRef.current = false }, () => { inFlightRef.current = false })
      }, [])

      // Live cadence from the host (`pollMs`), clamped to the 30 s floor and
      // re-armed whenever the configured value changes.
      const pollMs = React.useMemo(
        () => clamp(num(snapshot?.pollMs) ?? DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS),
        [snapshot],
      )
      const onTick = React.useCallback(() => setTick((n) => n + 1), [])

      // First fetch + refresh when the tab comes back.
      React.useEffect(() => {
        dbg('hud mounted', { model: props.model, pollMs })
        poll()
        const onVisible = () => {
          if (document.visibilityState === 'visible') poll()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [poll])

      // Poll + clock timers, re-armed when the cadence changes.
      React.useEffect(() => {
        let stop
        try {
          if (typeof props.startTimers === 'function') {
            stop = props.startTimers(poll, pollMs, onTick, CLOCK_MS)
          } else {
            const a = window.setInterval(poll, pollMs)
            const b = window.setInterval(onTick, CLOCK_MS)
            stop = () => {
              window.clearInterval(a)
              window.clearInterval(b)
            }
          }
        } catch (e) {
          // A timer failure must never take the card down: the mount fetch
          // already painted it and visibilitychange keeps it fresh.
          console.error('[ocq] timers unavailable:', e)
        }
        return () => {
          try {
            if (typeof stop === 'function') stop()
          } catch {}
        }
      }, [poll, onTick, pollMs, props.startTimers])

      const refresh = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const json = await fetchJson('/dsh-hud/quota/refresh', { method: 'POST' })
          if (aliveRef.current) {
            setSnapshot(json)
            setError(null)
          }
        } catch (e) {
          if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [busy])

      const subscriptions = React.useMemo(() => {
        const list = Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions : []
        let rows
        if (list.length > 0) rows = filterForProvider(list.map(normalizeRow), props.provider)
        else if (snapshot?.usage != null) rows = [normalizeRow({ id: 'opencode-go', label: 'opencode-go', usage: snapshot.usage })]
        else rows = []
        // Nothing matched the provider (fallback list): put any row mentioning
        // it first so its billing still opens on top.
        const p = String(props.provider ?? '').toLowerCase()
        if (!p || rows.length < 2) return rows
        const hit = rows.findIndex((r) => String(r.id).toLowerCase().includes(p))
        return hit > 0 ? [rows[hit], ...rows.slice(0, hit), ...rows.slice(hit + 1)] : rows
      }, [snapshot, props.provider])

      // Switching model jumps straight to the new vendor's billing view
      // instead of keeping the old carousel position.
      React.useEffect(() => {
        setSubIndex(0)
      }, [props.provider])

      const count = subscriptions.length
      const activeIndex = count > 0 ? Math.abs(subIndex) % count : 0
      const active = count > 0 ? subscriptions[activeIndex] : undefined

      // Auto-rotate through the subscriptions while not hovered — and while
      // the tab is visible: re-mounting the body in a background tab would
      // replay animations nobody sees (and burn frames).
      React.useEffect(() => {
        if (count <= 1 || hovering) return undefined
        const id = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          setSubIndex((i) => i + 1)
        }, CAROUSEL_MS)
        return () => window.clearInterval(id)
      }, [count, hovering])

      // ── credential drawer: parse the paste → POST → force refresh ────────
      const missingCreds = React.useMemo(
        () => (active?.credentials ?? []).filter((c) => !c.present),
        [active],
      )
      const missingRef = missingCreds[0]?.ref ?? null
      const parsedSecret = React.useMemo(() => parseSecret(draft, missingRef), [draft, missingRef])

      /** Copy with a visible "已复制" tick; falls back to execCommand. */
      const copyText = React.useCallback(async (text) => {
        let ok = false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            ok = true
          }
        } catch { ok = false }
        if (!ok) {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body?.appendChild(ta)
            ta.select()
            document.execCommand?.('copy')
            ta.remove?.()
            ok = true
          } catch { ok = false }
        }
        if (!ok || !aliveRef.current) return
        setCopiedKey(text)
        window.setTimeout(() => {
          if (aliveRef.current) setCopiedKey((cur) => (cur === text ? null : cur))
        }, 1400)
      }, [])

      const readClipboard = React.useCallback(async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (text && aliveRef.current) {
            setDraft(text.trim())
            setSaveMsg(null)
          }
        } catch {
          if (aliveRef.current) {
            setSaveMsg({
              ok: false,
              text: lang === 'zh' ? '剪贴板读取被拒，请直接在输入框粘贴（Ctrl+V）' : 'Clipboard blocked — paste into the field instead',
            })
          }
        }
      }, [lang])

      const saveCredential = React.useCallback(async () => {
        if (saving || !missingRef) return
        const secret = parseSecret(draft, missingRef)
        if (!secret.value) return
        setSaving(true)
        try {
          const json = await fetchJson('/dsh-hud/quota/credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ref: missingRef, value: secret.value }),
          })
          if (!aliveRef.current) return
          setDraft('') // the secret leaves the DOM immediately after the write
          setSaveMsg({
            ok: true,
            text: lang === 'zh' ? `已保存到 ${json.how ?? 'credentials'}` : `Saved to ${json.how ?? 'credentials'}`,
          })
          await refresh() // present:true → the drawer moves to the next ref
        } catch (e) {
          if (aliveRef.current) setSaveMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
        } finally {
          if (aliveRef.current) setSaving(false)
        }
      }, [saving, missingRef, draft, lang, refresh])

      /** Save-drawer target + the paste preview shown while open. */
      const missingCredsText = missingCreds.length > 1 ? `(+${missingCreds.length - 1})` : ''

      /**
       * One hint line: URLs become real links (open the platform in a click),
       * command-looking lines get a copy button. Keeps the host's step strings
       * untouched — all rendering logic lives here.
       */
      const stepNodes = (text, id) => {
        const raw = String(text)
        const url = urlOf(raw)
        const code = codeOf(raw)
        const parts = url ? raw.split(url) : [raw]
        const children = []
        parts.forEach((part, idx) => {
          children.push(part)
          if (url && idx < parts.length - 1) {
            children.push(jsx('a', {
              className: 'ocq-link',
              href: url,
              target: '_blank',
              rel: 'noreferrer noopener',
              key: `${id}-link`,
              children: url,
            }))
          }
        })
        if (code) {
          const done = copiedKey === code
          children.push(jsx('button', {
            type: 'button',
            key: `${id}-copy`,
            className: `ocq-copybtn${done ? ' is-done' : ''}`,
            title: lang === 'zh' ? '复制到剪贴板' : 'Copy to clipboard',
            onClick: () => copyText(code),
            children: done
              ? (lang === 'zh' ? '已复制' : 'Copied')
              : (lang === 'zh' ? '复制' : 'Copy'),
          }))
        }
        return children
      }

      const now = Date.now()
      // Only the windows the subscription actually reports are drawn — a plan
      // with 5h+weekly draws two cells, a monthly-only plan draws one.
      const cells = []
      for (const win of active?.windows ?? []) {
        // Built-ins use the localized catalog; a user-defined source may ship
        // its own key/label, so fall back instead of dropping the cell.
        const meta = WINDOW_META[win.key] ?? {
          key: win.key,
          zh: win.label ?? win.key,
          en: win.label ?? win.key,
          spanMs: 7 * 86400_000,
        }
        if (!meta) continue
        const pct = win.percent
        const cls = severity(pct)
        const width = `${clamp(pct, 0, 100)}%`
        const end = win.resetsAt
        const elapsed = end === undefined ? undefined : clamp((meta.spanMs - (end - now)) / meta.spanMs, 0, 1)
        const remaining = elapsed === undefined ? null : clamp((1 - elapsed) * 100, 0, 100)
        const resetAt = end === undefined ? null : new Date(end).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
        const resetTip = end === undefined
          ? (lang === 'zh' ? '重置时间未知' : 'reset time unknown')
          : (lang === 'zh'
              ? `重置于 ${resetAt}（${countdown(end - now, lang)}后）`
              : `resets at ${resetAt} (${countdown(end - now, lang)} left)`)
        // Absolute quota detail when the source reports it (千问 Token Plan):
        // `13,284 / 180,000 Credits` — more informative than repeating 7%.
        const credits = win.used !== undefined && win.total !== undefined
          ? `${win.used.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')} / ${win.total.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}${win.unit ? ` ${win.unit}` : ''}`
          : null
        const barTitle = lang === 'zh'
          ? (credits ? `已用 ${Math.round(pct)}% · ${credits}` : `已用 ${Math.round(pct)}%`)
          : (credits ? `${Math.round(pct)}% used · ${credits}` : `${Math.round(pct)}% used`)
        cells.push(
          jsxs('div', { className: 'ocq-cell', children: [
            jsxs('div', { className: 'ocq-row', children: [
              jsx('span', { className: 'ocq-name', children: lang === 'zh' ? meta.zh : meta.en }),
              jsx('span', { className: `ocq-pct ${cls}`.trim(), children: `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%` }),
            ] }),
            jsx('div', {
              className: 'ocq-track',
              title: barTitle,
              children: jsx('div', {
                className: 'ocq-fill',
                style: {
                  width,
                  backgroundImage: USAGE_GRADIENT,
                  // Anchor the ramp to the TRACK, not the fill: a 30 % bar
                  // shows the first 30 % of the palette, never a squashed one.
                  backgroundSize: pct > 0 ? `${10000 / pct}% 100%` : '100% 100%',
                },
              }),
            }),
            // Reverse time bar: only when a reset time is known.
            end === undefined
              ? null
              : jsx('div', {
                  className: 'ocq-time',
                  title: resetTip,
                  children: jsx('div', {
                    className: 'ocq-timefill',
                    style: { width: remaining === null ? '0%' : `${remaining}%` },
                  }),
                }),
            jsxs('div', { className: 'ocq-foot', children: [
              jsx('span', {
                children: credits
                  ? credits
                  : (elapsed === undefined
                      ? (lang === 'zh' ? '窗口进度 —' : 'window —')
                      : (lang === 'zh' ? `已过 ${Math.round(elapsed * 100)}%` : `${Math.round(elapsed * 100)}% elapsed`)),
              }),
              jsx('span', {
                children: end === undefined
                  ? ''
                  : (lang === 'zh' ? `${countdown(end - now, lang)}后重置` : `resets in ${countdown(end - now, lang)}`),
              }),
            ] }),
          ] }, win.key),
        )
      }

      // Prepaid subscriptions (DeepSeek / Kimi) report balances, not windows.
      const balances = active?.balances ?? []
      const series = Array.isArray(active?.series) ? active.series : []
      // A row carrying BOTH balances and a usage chart (DeepSeek) renders side
      // by side — balances left, chart right — so the card never stacks the
      // two vertically. Window-only plans (OpenCode, Qwen…) are untouched.
      const splitMode = balances.length > 0 && series.length > 1
      const balanceRows = balances.map((b, idx) => {
        const label = BALANCE_LABELS[b.key] ?? [b.key, b.key]
        const value = typeof b.value === 'number' && Number.isFinite(b.value)
          ? b.value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 4 })
          : String(b.value ?? '—')
        // In split mode the currency heads the column once, not every row.
        const suffix = !splitMode && b.currency ? ` (${b.currency})` : ''
        return jsxs('div', { className: `ocq-balance${idx === 0 ? ' is-primary' : ''}`, children: [
          jsx('span', { children: `${lang === 'zh' ? label[0] : label[1]}${suffix}` }),
          // Dotted leader: rows align like a table without extra borders.
          jsx('i', { className: 'ocq-lead', 'aria-hidden': true }),
          jsx('b', { children: value }),
        ] }, b.key)
      })
      const balanceCurrency = splitMode
        ? (balances.find((b) => b.currency)?.currency ?? '')
        : ''

      const stamp = snapshot?.fetchedAt
        ? new Date(snapshot.fetchedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
        : null
      const avgText = formatTps(avgTps)
      const instantText = formatTps(instantTps)
      // Split mode with no session running: two rows of "—" say nothing, so
      // the rate line disappears until there is a number to show.
      const showRates = !(splitMode && avgText === null && instantText === null)

      // The provider is a known vendor but no subscription row exists for it:
      // explain instead of borrowing another vendor's billing.
      const unmatched = Array.isArray(snapshot?.subscriptions)
        && snapshot.subscriptions.length > 0
        && count === 0
      const providerName = String(props.provider ?? '').trim()
      const unmatchedHint = unmatched
        ? {
            title: lang === 'zh' ? `未发现 ${providerName || '当前供应商'} 的订阅` : `No subscription for ${providerName || 'this provider'}`,
            steps: lang === 'zh'
              ? [
                  '不会拿别家的额度顶替显示',
                  '订阅来自三处：llm-pi-ai provider 表 + 内置发现（如官方 deepseek-official）+ subscriptions 显式配置',
                  '自定义：设置 → 插件 → 配置 → subscriptions 加 { "id": "<与 provider 同名>", "kind": "custom2", "url", "windows": [...] }（id 必须等于 provider 名才会匹配）',
                ]
              : [
                  "Another vendor's quota is never substituted",
                  'Rows come from the llm-pi-ai provider table, built-in discovery (e.g. deepseek-official), and explicit subscriptions',
                  'Custom source: add { "id": "<same as provider>", "kind": "custom2", "url", "windows": [...] } under Settings → Plugins → subscriptions (the id must equal the provider name)',
                ],
          }
        : undefined
      const shownHint = active?.hint ?? unmatchedHint

      // Title follows what the subscription reports: window limits vs balance.
      const titleText = cells.length > 0 || balanceRows.length === 0
        ? (lang === 'zh' ? '用量限额' : 'Usage limits')
        : (lang === 'zh' ? '账户余额' : 'Account balance')
      const subText = active
        ? (active.plan ? `${active.label} · ${active.plan}` : active.label)
        : (unmatched && providerName ? providerName : null)

      // Status LED in the header: the WORST window's severity at a glance;
      // balance-only rows stay neutral blue, a failed query lights it red.
      const worstPct = cells.length > 0
        ? Math.max(...(active?.windows ?? []).map((w) => num(w.percent) ?? 0))
        : null
      const statusCls = active?.error
        ? ' is-crit'
        : worstPct === null ? '' : worstPct >= 80 ? ' is-crit' : worstPct >= 60 ? ' is-warn' : ' is-ok'
      const statusTitle = active?.error
        ? (lang === 'zh' ? '查询失败' : 'query failed')
        : worstPct === null
          ? (lang === 'zh' ? '订阅状态' : 'subscription status')
          : (lang === 'zh' ? `最高用量 ${Math.round(worstPct)}%` : `peak usage ${Math.round(worstPct)}%`)

      return jsx('div', {
        className: 'ocq-root',
        onMouseEnter: () => setHovering(true),
        onMouseLeave: () => setHovering(false),
        children: jsxs('div', { className: 'ocq-card', children: [
          jsxs('div', { className: 'ocq-head', children: [
            jsx('span', { className: `ocq-status${statusCls}`, title: statusTitle, 'aria-hidden': true }),
            jsx('span', { className: 'ocq-title', children: titleText }),
            subText
              ? jsx('span', { className: 'ocq-sub', title: subText, children: subText })
              : null,
            jsxs('span', { className: 'ocq-right', children: [
              // Timestamp lives in the refresh button's tooltip in split mode —
              // repeating it in the header just adds a line for nothing.
              stamp && !splitMode
                ? jsx('span', { title: lang === 'zh' ? '上次更新' : 'Last updated', children: stamp })
                : null,
              jsx('button', {
                type: 'button',
                className: 'ocq-refresh',
                onClick: refresh,
                disabled: busy,
                title: stamp
                  ? (lang === 'zh' ? `上次更新 ${stamp}` : `Last updated ${stamp}`)
                  : undefined,
                children: busy
                  ? (lang === 'zh' ? '刷新中' : 'refreshing')
                  : (lang === 'zh' ? '刷新' : 'refresh'),
              }),
            ] }),
          ] }),
          showRates
            ? jsxs('div', { className: 'ocq-rates', children: [
                jsxs('span', { className: 'ocq-rate', children: [
                  lang === 'zh' ? '速率' : 'rate',
                  jsx('b', { children: avgText === null ? '—' : `${avgText} tok/s` }),
                ] }),
                jsxs('span', { className: 'ocq-rate', children: [
                  lang === 'zh' ? '本次速率' : 'this run',
                  jsx('b', { children: instantText === null ? '—' : `${instantText} tok/s` }),
                  instantText === null && avgText !== null
                    ? jsx('em', { children: lang === 'zh' ? '（待开始）' : '(idle)' })
                    : null,
                ] }),
              ] })
            : null,
          // Everything from here down re-mounts as ONE unit when the active
          // subscription changes (provider switch or carousel step). That key
          // is what triggers the swap animation — bars, chart and cells then
          // draw themselves in again via their own CSS animations.
          jsxs('div', {
            className: 'ocq-body',
            children: [
              active?.error && cells.length === 0 && balanceRows.length === 0
                ? jsx('div', { className: 'ocq-msg ocq-crit', children: `${active.label}: ${active.error}` })
                : null,
              !active?.error && cells.length === 0 && balanceRows.length === 0 && !error && !unmatched
                ? jsx('div', { className: 'ocq-msg', children: lang === 'zh' ? '正在获取用量数据…' : 'Loading usage data…' })
                : null,
              // Structured fix-it panel: “请安装 XXX” / “未发现该供应商的订阅”.
              // Commands are one click from the clipboard, URLs open the
              // platform directly — no re-typing anything.
              shownHint
                ? jsxs('div', { className: 'ocq-hint', children: [
                    jsx('div', { className: 'ocq-hint-title', children: shownHint.title }),
                    shownHint.install
                      ? jsxs('div', { className: 'ocq-coderow', children: [
                          jsx('code', { className: 'ocq-code', children: shownHint.install }),
                          jsx('button', {
                            type: 'button',
                            className: `ocq-copybtn${copiedKey === shownHint.install ? ' is-done' : ''}`,
                            title: lang === 'zh' ? '复制到剪贴板' : 'Copy to clipboard',
                            onClick: () => copyText(shownHint.install),
                            children: copiedKey === shownHint.install
                              ? (lang === 'zh' ? '已复制' : 'Copied')
                              : (lang === 'zh' ? '复制' : 'Copy'),
                          }),
                        ] })
                      : null,
                    ...shownHint.steps.map((s, i) => jsx('div', { className: 'ocq-step', children: stepNodes(s, `s${i}`) }, `s${i}`)),
                  ] })
                : null,
              // Credential drawer: save a Cookie/token/key straight from the
              // card — no YAML editing. Shows only REFS (never values), and
              // walks to the next missing ref after each save.
              missingRef
                ? jsxs('div', { className: `ocq-drawer${drawerOpen ? ' is-open' : ''}`, children: [
                    jsxs('button', {
                      type: 'button',
                      className: 'ocq-drawer-btn',
                      onClick: () => { setDrawerOpen((v) => !v); setSaveMsg(null) },
                      children: [
                        jsx('span', { className: 'ocq-drawer-caret', children: drawerOpen ? '▾' : '▸' }),
                        lang === 'zh' ? `配置 ${missingRef}` : `Configure ${missingRef}`,
                        missingCredsText ? jsx('em', { children: missingCredsText }) : null,
                      ],
                    }),
                    drawerOpen
                      ? jsxs('div', { className: 'ocq-drawer-body', children: [
                          jsx('input', {
                            className: 'ocq-drawer-input',
                            type: 'text',
                            value: draft,
                            spellCheck: false,
                            autoComplete: 'off',
                            'aria-label': missingRef,
                            placeholder: lang === 'zh'
                              ? '粘贴 Cookie / token / key / 整条 Copy as cURL'
                              : 'Paste a Cookie, token, key or a whole cURL command',
                            onChange: (e) => { setDraft(e.target.value); setSaveMsg(null) },
                          }),
                          jsxs('div', { className: 'ocq-drawer-actions', children: [
                            jsx('button', {
                              type: 'button',
                              className: 'ocq-drawer-ghost',
                              onClick: readClipboard,
                              children: lang === 'zh' ? '读取剪贴板' : 'From clipboard',
                            }),
                            jsx('button', {
                              type: 'button',
                              className: 'ocq-drawer-save',
                              disabled: saving || !draft.trim(),
                              onClick: saveCredential,
                              children: saving
                                ? (lang === 'zh' ? '保存中…' : 'Saving…')
                                : (lang === 'zh' ? '保存' : 'Save'),
                            }),
                            saveMsg
                              ? jsx('span', { className: `ocq-drawer-msg${saveMsg.ok ? '' : ' is-err'}`, children: saveMsg.text })
                              : null,
                          ] }),
                          parsedSecret.note
                            ? jsx('div', { className: 'ocq-drawer-note', children: parsedSecret.note })
                            : null,
                        ] })
                      : null,
                  ] })
                : null,
              cells.length > 0 ? jsx('div', { className: 'ocq-grid', children: cells }) : null,
              // Prepaid + chart (DeepSeek): balances and the month-long usage
              // chart share ONE row — this is what makes the card short. One
              // currency label heads the column instead of repeating every row.
              splitMode
                ? jsxs('div', { className: 'ocq-split', children: [
                    jsxs('div', { className: 'ocq-side', children: [
                      jsxs('div', { className: 'ocq-sidehead', children: [
                        jsx('span', { children: lang === 'zh' ? '余额' : 'Balance' }),
                        balanceCurrency ? jsx('span', { children: balanceCurrency }) : null,
                      ] }),
                      jsx('div', { className: 'ocq-balances', children: balanceRows }),
                    ] }),
                    jsx('div', { className: 'ocq-main', children: jsx(LineChart, {
                      points: series,
                      // Host ships the exact window (last 30 days); fall back
                      // to a month only for payloads without the bounds.
                      from: active.seriesFrom ?? now - 30 * 86400_000,
                      to: active.seriesTo ?? now,
                      granularity: active.granularity,
                      tokens: active.seriesTokens,
                      cost: active.seriesCost,
                      lang,
                      compact: true,
                    }) }),
                  ] })
                : null,
              !splitMode && balanceRows.length > 0
                ? jsx('div', { className: 'ocq-balances', children: balanceRows })
                : null,
              // Usage line chart, stacked only when it shares no row.
              !splitMode && series.length > 1
                ? jsx(LineChart, {
                    points: series,
                    from: active.seriesFrom ?? now - 30 * 86400_000,
                    to: active.seriesTo ?? now,
                    granularity: active.granularity,
                    tokens: active.seriesTokens,
                    cost: active.seriesCost,
                    lang,
                  })
                : null,
              count > 1
                ? jsxs('div', { className: 'ocq-dots', children: subscriptions.map((sub, i) =>
                    jsx('button', {
                      type: 'button',
                      className: 'ocq-dotbtn',
                      'aria-current': i === activeIndex ? 'true' : 'false',
                      'aria-label': sub.label,
                      title: sub.label,
                      onClick: () => setSubIndex(i),
                    }, sub.id || String(i)),
                  ) })
                : null,
              error && cells.length > 0
                ? jsx('div', { className: 'ocq-msg ocq-crit', children: error })
                : null,
            ],
          }, active?.id ?? (unmatched ? `unmatched:${providerName}` : 'idle')),
        ] }),
      })
    }

    // ── provider gate ──────────────────────────────────────────────────────
    /** Normalize a `{ provider, model }`-ish selection. */
    function fromSelection(sel) {
      if (!sel) return undefined
      if (typeof sel === 'string') {
        const [provider, ...rest] = sel.split('/')
        return provider ? { provider, model: rest.length ? rest.join('/') : undefined } : undefined
      }
      const provider = sel.provider ?? sel.providerId
      if (typeof provider !== 'string' || provider === '') return undefined
      const model = sel.model ?? sel.name ?? sel.id
      return { provider, model: typeof model === 'string' && model !== '' ? model : undefined }
    }

    /**
     * The session's live model selection, read from the `modelSelection`
     * projection face — the same source the composer's submit state uses
     * (`session.projections.faceOf("modelSelection")` → `{ next?, lastUsed? }`).
     */
    // The slot runtime sometimes invokes the component with NO props object at
    // all (seen in the wild as `reading 'useProjection' of undefined`) — every
    // entry point therefore defaults to `{}` and reads defensively.
    function projectionSelection(props) {
      const hook = props?.useProjection
      if (typeof hook !== 'function') return undefined
      let face
      try {
        face = hook('modelSelection')
      } catch {
        return undefined
      }
      if (!face || typeof face !== 'object') return undefined
      return fromSelection(face.next) ?? fromSelection(face.lastUsed) ?? fromSelection(face)
    }

    /** Fallback probe across the other session-scoped standard hooks. */
    function hookSelection(props) {
      const hooks = [props?.useConversation, props?.useSession, props?.useSessions]
      for (const hook of hooks) {
        if (typeof hook !== 'function') continue
        let snap
        try {
          snap = hook((s) => s)
        } catch {
          continue
        }
        if (!snap) continue
        const hit = fromSelection(snap.model ?? snap.currentModel ?? snap.selection)
        if (hit) return hit
      }
      return undefined
    }

    /**
     * Read the model selection from BOTH hook families, in a FIXED order every
     * render. React counts hooks per render: a short-circuiting `a ?? b` that
     * skips a family on one render but not the next shifts the hook order and
     * crashes the whole slot entry ("Rendered fewer hooks than expected") —
     * exactly the failure mode that took this card down once already.
     */
    function gateSelection(props = {}) {
      let fromProjection
      try {
        fromProjection = projectionSelection(props)
      } catch (e) {
        dbg('projectionSelection failed', e)
        fromProjection = undefined
      }
      let fromHook
      try {
        fromHook = hookSelection(props)
      } catch (e) {
        dbg('hookSelection failed', e)
        fromHook = undefined
      }
      return fromProjection ?? fromHook
    }

    /**
     * The card always renders; whether it shows a vendor's quota is decided by
     * `filterForProvider` inside the Hud (matched row → that vendor only;
     * nothing matched → explanation panel, never another vendor's billing).
     * Hiding here on an unrecognized provider name would break user-defined
     * `custom2` subscriptions, whose provider ids we cannot know in advance.
     */
    let lastGate = null
    function Gate(props = {}) {
      const sel = gateSelection(props)
      const provider = sel?.provider
      const gateKey = `${provider ?? 'unknown'}:${sel?.model ?? ''}`
      if (gateKey !== lastGate) {
        lastGate = gateKey
        dbg('gate selection', {
          hasProjectionHook: typeof props.useProjection === 'function',
          provider: provider ?? null,
          model: sel?.model ?? null,
          knownVendor: isSupportedProvider(provider),
        })
      }
      const label = sel?.model ? `${provider}/${sel.model}` : (provider ?? 'OpenCode')
      return jsx(Hud, {
        model: label,
        provider: provider ?? '',
        startTimers: props.startTimers,
        useProjection: props.useProjection,
      })
    }

    // ── panel entry ────────────────────────────────────────────────────────
    // The registry entry the shell collects. What used to be the module exports
    // now rides in `__test`: the isolation test wants filterForProvider /
    // providerKind, and the layout tests render `Hud` / `Gate` under a stubbed
    // React. Registration into `conversation.input.dock` and the timers belong
    // to the shell, so neither is built here any more.
    //
    // `span: 2` is this panel's PREFERENCE, not a rule: the quota card carries
    // up to three limit windows plus a usage chart, so it reads badly in a
    // single 1/3 track. The user's own layout choice (⚙) always wins over it,
    // and the shell clamps it to however many columns the HUD currently has.
    return {
      id: 'quota',
      order: 20,
      span: 1,
      label: { zh: '用量', en: 'Quota' },
      // ON by default, and one column wide: it is the second card of the shipped layout,
      // stacked above the machine card — but NOT tied to it. Each card in that column has
      // its own height, and this one is set from what it shows.
      defaultOn: true,
      // FOUR rows is the floor, and it is a floor rather than a measurement on purpose:
      // the rate line, the monthly bar with its reset countdown, the credit totals and the
      // CNY figure together need more than three, and three is where it kept landing. There
      // is no ceiling — the measurement can still make it taller.
      defaultRows: 3,
      Component: Gate,
      __test: { filterForProvider, providerKind, Hud, Gate },
    }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/sql/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › sql panel — browser half.
//
// The card is a database browser: pick a connection, read its schema, write one
// statement, read the answer. It owns nothing but presentation — every decision that
// could be wrong (which statement runs, whether a write is allowed, what the row cap
// is) is made on the host, where it can be enforced.
//
// Three things this card is deliberate about:
//
//   • A FAILED CONNECTION IS NOT AN EMPTY DATABASE. "0 tables" for a server that
//     refused the login is the most misleading thing this panel could say, so the
//     error takes the whole card and says which database it was about.
//   • THE READ-ONLY MECHANISM IS NAMED. SQLite refuses at the file handle, Postgres
//     and MySQL refuse in a read-only transaction — so the card says which one is
//     protecting you rather than a generic "read-only" that means three things.
//   • A WRITE NEEDS TWO TICKS. The connection must be writable AND the run must be
//     ticked, and the refusal names the one that is missing.
//
// Rendered with `jsx`/`jsxs` only — the shell provides them (see the fragment
// contract), and the suite checks for array children passed to `jsx`.

/** The result grid. A value is never rendered as `undefined` or as `[object Object]`. */
function SqlResult(props) {
  const { result, zh } = props
  if (result === null || result === undefined) return null
  /**
   * Show a value the way a person reads it.
   *
   * `null` is shown as a dimmed NULL rather than as an empty cell, because an empty
   * string and a NULL are different answers and a grid that draws them the same is
   * a grid that lies about one of them.
   */
  const show = (value) => {
    if (value === null) return jsx('span', { className: 'sq-null', children: 'NULL' })
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    const text = String(value)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }
  return jsxs('div', { className: 'sq-result', children: [
    // ── the headline says WHICH of the two things happened ──
    //
    // A read and a write are different answers, and the card used to report both as "执行结果"
    // with a row count of zero for a write. Someone who ran an UPDATE wants to know how many
    // rows it touched; someone who ran a SELECT wants the grid. The distinction is the whole
    // reason this card exists rather than a generic console.
    jsxs('div', { className: 'sq-reshead', children: [
      jsx('span', {
        className: `sq-restitle${result.columns.length === 0 ? ' is-ok' : ''}`,
        children: result.columns.length === 0
          ? (zh ? '执行成功' : 'statement succeeded')
          : `${zh ? '查询' : 'query'} · ${result.rows.length} ${zh ? '行' : 'rows'}`,
      }),
      result.columns.length === 0 && result.rowCount !== undefined && result.rowCount !== null
        ? jsx('span', { className: 'sq-affected', children: zh
          ? `影响 ${result.rowCount} 行`
          : `${result.rowCount} rows affected` })
        : null,
      result.truncated
        ? jsx('span', { className: 'sq-warn', children: zh
          ? `已截断到 ${result.limit} 行 —— 上限可在设置里调`
          : `truncated at ${result.limit} rows` })
        : null,
      jsx('span', { className: 'sq-ms', children: `${result.ms}ms` }),
      result.readOnly
        ? jsx('span', { className: 'sq-chip', children: zh ? '只读' : 'read-only' })
        : jsx('span', { className: 'sq-chip is-write', children: zh ? '可写' : 'writable' }),
    ] }),
    result.notice !== undefined && result.columns.length === 0
      ? jsx('span', { className: 'sq-notice', children: result.notice })
      : null,
    result.columns.length > 0
      ? jsx('div', { className: 'sq-scroll', children: jsxs('table', { className: 'sq-table', children: [
          jsx('thead', { children: jsx('tr', { children: result.columns.map((name, index) => jsx('th', {
            title: result.types?.[index] ?? name,
            children: name,
          }, `${name}-${index}`)) }) }),
          jsx('tbody', { children: result.rows.length === 0
            ? jsx('tr', { children: jsx('td', { colSpan: result.columns.length, className: 'sq-empty', children: zh ? '没有数据' : 'no rows' }) })
            : result.rows.map((row, rowIndex) => jsx('tr', {
                children: row.map((value, colIndex) => jsx('td', {
                  title: value === null ? 'NULL' : String(value),
                  children: show(value),
                }, `${rowIndex}-${colIndex}`)),
              }, `r${rowIndex}`)) }),
        ] }) })
      : null,
    result.notice !== undefined && result.columns.length > 0
      ? jsx('span', { className: 'sq-notice', children: result.notice })
      : null,
  ] })
}


/**
 * ── connecting to a database, in three steps and in the card ───────────────
 *
 * Pick the engine, fill in what THAT engine needs, press Connect. The parameters change
 * with the engine because they come from the same list the host exports for its own
 * form — there is no second opinion about what PostgreSQL asks for.
 *
 * Why this is in the card and not only in ⚙: "add a connection" is the FIRST thing
 * anyone does with this panel, and the empty state used to answer it with a paragraph
 * telling them to go and find the gear. The gear still edits an existing connection;
 * this is how one gets made.
 *
 * Connect TESTS BEFORE SAVING. A connection that is written to the settings file and
 * then fails is a broken thing to hand someone — the button is called Connect, so it
 * connects, and only a connection that worked becomes the active one.
 */
/**
 * Which engine — one control, used by both connection forms.
 *
 * Extracted the moment there were two forms (connect, and edit a stored connection):
 * two lists of engine buttons would drift, and the second one would eventually offer an
 * engine the first one disables. An engine this process cannot use is DISABLED here and
 * says why — offering it and failing at connect time would look like a network problem.
 */
function DriverChips({ zh, drivers, value, onPick }) {
  return jsxs('div', { className: 'sq-dtypes', role: 'group', children: drivers.map((driver) => jsxs('button', {
    type: 'button',
    className: `sq-dtype${value === driver.id ? ' is-on' : ''}`,
    'data-driver': driver.id,
    'aria-pressed': value === driver.id ? 'true' : 'false',
    disabled: driver.available !== true,
    title: driver.available === true
      ? (zh ? `连接 ${driver.labelZh ?? driver.label}` : `Connect to ${driver.label}`)
      : `${driver.labelZh ?? driver.label}：${driver.reason}`,
    onClick: () => onPick(driver.id),
    children: [
      driver.labelZh ?? driver.label,
      driver.available === true ? null : jsx('em', { children: zh ? '不可用' : 'n/a' }),
    ],
  }, driver.id)) })
}

/**
 * What one engine needs, plus the password box — shared by both forms.
 *
 * The password is NOT part of the driver's field list, because it is not part of the
 * connection: the connection stores a credential NAME. But asking someone to pre-create a
 * named credential before they can connect is how they end up reading "凭据无效" after
 * typing a perfectly good password. So the secret is typed here, used for the test, and
 * written to the credential store under a name the form shows.
 */
function SqlFields({ zh, drivers, driver, value, onChange, passwordHint }) {
  // SQLite is a file: it has no password, so it does not get a password box. Every other
  // driver authenticates, and every one of them stores the secret in the credential store
  // rather than in the connection.
  const needsPassword = driver !== 'sqlite'
  return jsxs('div', { className: 'sq-dfields', children: [
    ...driverFields(driver, drivers, zh).map((field) => jsxs('label', {
      className: `sq-dfield is-${field.kind}`,
      children: [
        jsx('span', { className: 'sq-dlabel', children: field.label }),
        field.kind === 'toggle'
          ? jsx('input', {
              type: 'checkbox',
              'data-field': field.key,
              checked: value[field.key] === true,
              onChange: (event) => onChange({ [field.key]: event.target.checked }),
            })
          : jsx('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              'data-field': field.key,
              value: value[field.key] === undefined ? '' : String(value[field.key]),
              placeholder: field.placeholder ?? '',
              min: field.min,
              max: field.max,
              spellCheck: false,
              onChange: (event) => onChange({
                [field.key]: field.kind === 'number'
                  ? (event.target.value === '' ? '' : Number(event.target.value))
                  : event.target.value,
              }),
            }),
        field.hint === undefined ? null : jsx('span', { className: 'sq-dhint', children: field.hint }),
      ],
    }, field.key)),
    needsPassword
      ? jsxs('label', { className: 'sq-dfield is-password', children: [
          jsx('span', { className: 'sq-dlabel', children: zh ? '密码' : 'PASSWORD' }),
          jsx('input', {
            type: 'password',
            'data-field': 'password',
            autoComplete: 'new-password',
            value: value.password === undefined ? '' : String(value.password),
            placeholder: zh ? '数据库密码' : 'database password',
            spellCheck: false,
            onChange: (event) => onChange({ password: event.target.value }),
          }),
          jsx('span', {
            className: 'sq-dhint',
            children: passwordHint ?? (value.passwordRef === undefined || String(value.passwordRef).trim() === ''
              ? (zh ? '连接成功后写入 DSH 凭据库，连接里只留名字。' : 'stored in the DSH credential store on success; the connection keeps only a name.')
              : (zh ? `写入凭据「${String(value.passwordRef).trim()}」。` : `written to the credential "${String(value.passwordRef).trim()}".`)),
          }),
        ] })
      : null,
  ] })
}

/**
 * ── the connection manager ───────────────────────────────────────────────────
 *
 * Several connections can be stored, and until now the only way to manage them was a row
 * of chips followed by a row of ✕ buttons — so with three connections on screen, the
 * third ✕ belonged to the third chip only by counting, and EDITING anything meant first
 * making it active and then editing "the connection", whatever that was. Add, remove and
 * modify all existed; none of them were safe.
 *
 * This is the list: ONE row per connection, each carrying its own actions, with a draft
 * editor underneath. What it deliberately does NOT do:
 *
 *   • it does not save as you type — the draft is local until 保存, so a half-typed
 *     hostname never reaches the settings file (the shell form writes on every keystroke,
 *     which is fine for a city name and wrong for a database host);
 *   • it does not delete on one click — deleting a connection is destructive and the
 *     credential behind it may be shared;
 *   • it does not hide a missing credential. A connection whose credential was removed
 *     fails with a sentence about the credential; showing that HERE means the list answers
 *     "which one is broken?" before anyone clicks it.
 */
function SqlConnectionRow(props) {
  const { zh, entry, drivers, active, busy, confirming, dropCredential } = props
  const spec = drivers.find((one) => one.id === entry.driver)
  const isActive = entry.id === active
  const missing = entry.credential === 'missing'
  return jsxs('div', {
    className: `sq-connrow${isActive ? ' is-on' : ''}${confirming ? ' is-confirming' : ''}`,
    'data-conn': entry.id,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'sq-connpick',
        'data-act': 'conn-pick',
        'aria-pressed': isActive ? 'true' : 'false',
        title: zh ? `正在使用：${entry.target}` : `in use: ${entry.target}`,
        onClick: () => props.onSelect(entry.id),
        children: [
          jsx('span', { className: 'sq-connname', children: entry.name }),
          jsx('span', { className: 'sq-conntarget', children: entry.target }),
        ],
      }),
      jsxs('span', { className: 'sq-connmeta', children: [
        jsx('em', { className: 'sq-tag', children: spec?.labelZh ?? entry.driver }),
        entry.readOnly === false
          ? jsx('em', { className: 'sq-tag is-write', children: zh ? '可写' : 'writes' })
          : null,
        missing
          ? jsx('em', {
              className: 'sq-tag is-warn',
              title: zh
                ? `凭据「${entry.passwordRef}」不在凭据库里，这个连接会连不上`
                : `credential "${entry.passwordRef}" is not in the store`,
              children: zh ? '凭据缺失' : 'no credential',
            })
          : null,
      ] }),
      confirming
        ? jsxs('span', { className: 'sq-connconfirm', children: [
            jsx('span', { className: 'sq-note', children: zh ? `删除「${entry.name}」？` : `Delete "${entry.name}"?` }),
            entry.passwordRef === undefined || entry.passwordRef === ''
              ? null
              : jsxs('label', {
                  className: 'sq-dfield is-toggle is-tight',
                  title: zh
                    ? '默认保留：别的连接可能也在用同一个凭据'
                    : 'kept by default: another connection may name the same credential',
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      'data-field': 'dropCredential',
                      checked: dropCredential === true,
                      onChange: (event) => props.onDropCredential(event.target.checked),
                    }),
                    jsx('span', { className: 'sq-dhint', children: zh ? `同时删除凭据 ${entry.passwordRef}` : `also delete ${entry.passwordRef}` }),
                  ],
                }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-danger',
              'data-act': 'conn-del-confirm',
              disabled: busy,
              onClick: () => props.onDelete(entry),
              children: zh ? '删除' : 'Delete',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'conn-del-cancel',
              disabled: busy,
              onClick: () => props.onCancelConfirm(),
              children: zh ? '取消' : 'Cancel',
            }),
          ] })
        : jsxs('span', { className: 'sq-connactions', children: [
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'conn-edit',
              disabled: busy,
              title: zh ? '修改这个连接' : 'edit this connection',
              onClick: () => props.onEdit(entry),
              children: zh ? '改' : 'edit',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'conn-copy',
              disabled: busy || props.full === true,
              title: zh ? '复制一份（共用同一个凭据）' : 'duplicate (shares the credential)',
              onClick: () => props.onCopy(entry),
              children: zh ? '复制' : 'copy',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-danger',
              'data-act': 'conn-del',
              disabled: busy,
              title: zh ? '删除这个连接' : 'delete this connection',
              onClick: () => props.onAskDelete(entry.id),
              children: zh ? '删除' : 'delete',
            }),
          ] }),
    ],
  })
}

/**
 * The draft editor — for a new connection, or for an existing one.
 *
 * ONE editor for both, because "add" and "modify" differ only in what happens on save:
 * add appends, modify replaces in place. Two forms would drift, and the second one would
 * forget the test-before-saving rule.
 */
function SqlConnectionEditor(props) {
  const { zh, drivers, mode, draft, outcome, testing, saving, tested } = props
  return jsxs('div', { className: 'sq-editor', children: [
    jsx('span', {
      className: 'sq-connect-head',
      children: mode === 'new' ? (zh ? '新建连接' : 'NEW CONNECTION') : (zh ? '修改连接' : 'EDIT CONNECTION'),
    }),
    jsxs('div', { className: 'sq-dfields', children: [
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '显示名' : 'NAME' }),
        jsx('input', {
          type: 'text',
          'data-field': 'name',
          value: draft.name === undefined ? '' : String(draft.name),
          placeholder: zh ? '例如 生产库' : 'e.g. production',
          spellCheck: false,
          onChange: (event) => props.onDraft({ name: event.target.value }),
        }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-number', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '行数上限' : 'ROW LIMIT' }),
        jsx('input', {
          type: 'number',
          'data-field': 'limit',
          min: 1,
          max: 5000,
          value: draft.limit === undefined ? '' : String(draft.limit),
          onChange: (event) => props.onDraft({ limit: event.target.value === '' ? '' : Number(event.target.value) }),
        }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-toggle', children: [
        jsx('input', {
          type: 'checkbox',
          'data-field': 'readOnly',
          checked: draft.readOnly !== false,
          onChange: (event) => props.onDraft({ readOnly: event.target.checked }),
        }),
        jsx('span', { className: 'sq-dlabel', children: zh ? '只读连接' : 'READ-ONLY' }),
        jsx('span', { className: 'sq-dhint', children: zh ? '关掉之后还要在卡片上勾选「允许写」才会真的写。' : 'still needs the card tick to write.' }),
      ] }),
    ] }),
    jsx(DriverChips, { zh, drivers, value: draft.driver, onPick: (id) => props.onDriver(id) }),
    jsx(SqlFields, {
      zh,
      drivers,
      driver: draft.driver,
      value: draft,
      onChange: (patch) => props.onDraft(patch),
      // An existing connection that already names a credential: leaving the box empty
      // KEEPS it, which is the only sane reading of an empty password box on an edit.
      passwordHint: mode === 'edit' && typeof draft.passwordRef === 'string' && draft.passwordRef !== ''
        ? (zh ? `留空则继续用凭据「${draft.passwordRef}」；填了就覆盖它。` : `leave empty to keep the credential "${draft.passwordRef}".`)
        : undefined,
    }),
    jsxs('div', { className: 'sq-dorun', children: [
      jsx('button', {
        type: 'button',
        className: 'sq-connect-cancel',
        'data-act': 'conn-test',
        disabled: testing === true || saving === true,
        onClick: () => props.onTest(),
        children: testing === true ? (zh ? '测试中…' : 'testing…') : (zh ? '测试' : 'Test'),
      }),
      jsx('button', {
        type: 'button',
        className: 'sq-connect-go',
        'data-act': 'conn-save',
        disabled: saving === true || testing === true,
        onClick: () => props.onSave(),
        // The LABEL carries the warning rather than a hidden rule: a connection that has
        // not been tested still saves, because the server being briefly unreachable must
        // not lock someone out of fixing a typo — but they are told what they are doing.
        children: saving === true
          ? (zh ? '保存中…' : 'saving…')
          : tested === true
            ? (zh ? '保存' : 'Save')
            : (zh ? '未测试，仍要保存' : 'save untested'),
      }),
      jsx('button', {
        type: 'button',
        className: 'sq-connect-cancel',
        'data-act': 'conn-cancel',
        disabled: saving === true,
        onClick: () => props.onCancel(),
        children: zh ? '取消' : 'Cancel',
      }),
      outcome === null
        ? null
        : jsx('span', {
            className: `sq-outcome${outcome.ok ? ' is-ok' : ' is-bad'}`,
            role: outcome.ok ? 'status' : 'alert',
            children: outcome.text,
          }),
    ] }),
    jsx('span', { className: 'sq-dhint', children: zh
      ? '「测试」先连一次再决定要不要保存；密码只在测试通过后写入 DSH 凭据库，连接里只留名字。'
      : 'Test connects once before anything is stored; the password is only written to the credential store after it works.' }),
  ] })
}

/**
 * How many connections a card will hold.
 *
 * The same number the host enforces (`cleanProfiles` slices at 12), named here so the
 * button that adds the thirteenth is disabled rather than silently ignored.
 */
const MAX_CONNECTIONS = 12

/**
 * The engine's default port, from what the host exports.
 *
 * Prefilled rather than left blank: the port box being empty is what used to mean port 1
 * (see `cleanProfile`), and a field that shows 1433 is better than a field that has to be
 * known to be left alone.
 */
function defaultPortFor(driver, drivers) {
  const spec = drivers.find((one) => one.id === driver)
  return driver === 'sqlite' ? undefined : spec?.defaultPort
}

/** A fresh draft, in the same shape a stored connection has. */
function blankConnection(drivers, zh) {
  const driver = drivers.find((one) => one.available === true)?.id ?? 'sqlite'
  const port = defaultPortFor(driver, drivers)
  return { driver, name: '', readOnly: true, limit: 200, password: '', ...(port === undefined ? {} : { port }) }
}

/**
 * Move a draft to another engine.
 *
 * The driver-specific fields are rebuilt from the NEW driver's list and nothing else is
 * carried over: a host left behind by PostgreSQL has no meaning in SQLite, and a stored
 * field the target engine does not have is how a settings file ends up with values nobody
 * can see or remove.
 */
function withDriver(draft, driver, drivers, zh) {
  /**
   * Only the DRIVER-SPECIFIC part is rebuilt.
   *
   * Everything else — the name, the row limit, the read-only switch, the id — is the
   * connection's own and is carried over untouched. Rebuilding the whole object from the
   * field list is what dropped `readOnly` and `limit` on an engine switch, which no test
   * of the editor noticed and the older connect-panel test caught: a connection saved
   * after picking PostgreSQL came out with neither.
   */
  const driverKeys = new Set(drivers.flatMap((one) => (one.fields ?? []).map((field) => field.key)))
  const next = {}
  for (const [key, value] of Object.entries(draft)) {
    if (!driverKeys.has(key)) next[key] = value
  }
  next.driver = driver
  for (const field of driverFields(driver, drivers, zh)) {
    next[field.key] = draft[field.key] === undefined ? '' : draft[field.key]
  }
  /**
   * A port that was PREFILLED follows the engine; a port somebody typed is theirs to keep.
   *
   * The distinction is `previousDefault`: 1433 sitting in the box because SQL Server put it
   * there is not a decision, while 1444 is. (`port` here is the NEW engine's default — it
   * was briefly missing from this function, which made every engine switch throw.)
   */
  const port = defaultPortFor(driver, drivers)
  const previousDefault = defaultPortFor(draft.driver, drivers)
  const carried = next.port
  if (port !== undefined && (carried === '' || carried === null || carried === undefined || carried === previousDefault)) {
    next.port = port
  }
  return next
}

/** An id nothing else is using: `db`, then `db2`, `db3`… */
function nextConnectionId(connections) {
  const used = new Set(connections.map((entry) => String(entry.id)))
  let n = 1
  let id = 'db'
  while (used.has(id)) {
    n += 1
    id = `db${n}`
  }
  return id
}

/** What to call a connection that has no name yet. */
function defaultConnectionName(draft, id) {
  const own = String(draft.name ?? '').trim()
  if (own !== '') return own
  if (draft.driver === 'sqlite') return String(draft.file ?? '').trim() || id
  return String(draft.database ?? '').trim() || String(draft.host ?? '').trim() || id
}

function SqlConnect(props) {
  const { zh, drivers, draft, busy, outcome } = props
  const available = drivers.filter((driver) => driver.available === true)
  return jsxs('div', { className: 'sq-connect', children: [
    jsx('span', { className: 'sq-connect-head', children: zh ? '连接数据库' : 'CONNECT TO A DATABASE' }),
    // ── step 1: which engine ──
    jsx(DriverChips, {
      zh,
      drivers,
      value: draft.driver,
      // Through `withDriver`, so switching engine here behaves exactly as it does in the ⚙
      // editor: the field list is rebuilt, and a prefilled port follows the engine.
      onPick: (id) => (typeof props.onDriver === 'function' ? props.onDriver(id) : props.onDraft({ driver: id })),
    }),
    available.length === 0
      ? jsx('span', { className: 'sq-note', children: zh
        ? '这个进程里没有可用的数据库驱动。'
        : 'No database driver is available in this process.' })
      : null,
    // ── step 2: what that engine needs ──
    jsx(SqlFields, {
      zh,
      drivers,
      driver: draft.driver,
      value: draft,
      onChange: (patch) => props.onDraft(patch),
    }),
    // ── step 3: connect ──
    jsxs('div', { className: 'sq-dorun', children: [
      jsx('button', {
        type: 'button',
        className: 'sq-connect-go',
        'data-act': 'connect',
        disabled: busy === true || available.length === 0,
        onClick: () => props.onConnect(),
        children: busy === true ? (zh ? '连接中…' : 'connecting…') : (zh ? '连接' : 'Connect'),
      }),
      jsx('button', {
        type: 'button',
        className: 'sq-connect-cancel',
        'data-act': 'cancel',
        disabled: busy === true,
        onClick: () => props.onCancel(),
        children: zh ? '取消' : 'Cancel',
      }),
      outcome === null
        ? null
        : jsx('span', {
            className: `sq-outcome${outcome.ok ? ' is-ok' : ' is-bad'}`,
            role: outcome.ok ? 'status' : 'alert',
            children: outcome.text,
          }),
    ] }),
  ] })
}

/**
 * ── the SQL completer ────────────────────────────────────────────────────────
 *
 * WHAT THIS IS: identifier completion. It knows the words that exist — the SQL keywords, and
 * every schema, table and column the connection has actually reported — and offers the ones
 * that start with what is being typed. Pressing Tab puts the rest of the word in.
 *
 * WHAT THIS IS NOT: a SQL parser. It does not know that `select * from |` wants a table and
 * `where |` wants a column, so it offers both and lets the user choose. Ranking candidates by
 * what the grammar would accept is a real feature and a much larger one; claiming it with a
 * list that is merely alphabetical would be worse than the honest version, because people
 * would trust the order.
 *
 * The vocabulary comes from the SCHEMA, not from a hard-coded list, which is the whole point:
 * the names it offers are the names that exist in the database being queried.
 */

/** The keywords worth completing. Not exhaustive — the ones a hand-written query uses. */
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'INNER JOIN', 'OUTER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL',
  'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'ASC', 'DESC',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'WITH', 'UNION', 'UNION ALL',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
]

/**
 * Every word the schema makes available, most-specific first.
 *
 * `schema.table.column` and `table.column` are offered alongside the bare names, because the
 * qualified form is what a query with a JOIN needs and typing it by hand is where the typos
 * come from.
 */
function buildVocabulary(schema) {
  const words = new Set(SQL_KEYWORDS)
  for (const one of schema?.schemas ?? []) {
    if (one?.name) words.add(one.name)
    for (const object of one?.objects ?? []) {
      if (!object?.name) continue
      words.add(object.name)
      if (one.name) words.add(`${one.name}.${object.name}`)
      for (const column of object.columns ?? []) {
        if (!column?.name) continue
        words.add(column.name)
        words.add(`${object.name}.${column.name}`)
      }
    }
  }
  return [...words]
}

/**
 * The candidates for the word under the caret.
 *
 * `word` is the partial identifier being typed — empty after a space, which is the moment a
 * completer is most useful and also the moment a naive one shows all 400 words. So an empty
 * word offers only the KEYWORDS (a sensible starting point), and a non-empty one offers every
 * matching identifier.
 */
function completionsFor(vocabulary, word, limit = 8) {
  if (word === '') return SQL_KEYWORDS.slice(0, limit)
  const needle = word.toLowerCase()
  const starts = []
  const contains = []
  for (const candidate of vocabulary) {
    const lower = candidate.toLowerCase()
    if (lower === needle) continue
    if (lower.startsWith(needle)) starts.push(candidate)
    else if (lower.includes(needle)) contains.push(candidate)
    if (starts.length >= limit) break
  }
  // Prefix matches first: `ord` should offer `order_id` before `sales_order_id`.
  return [...starts, ...contains].slice(0, limit)
}

/** The identifier being typed at `caret`, and the range it occupies. */
function wordAt(text, caret) {
  const before = text.slice(0, caret)
  const match = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before)
  return { word: match?.[0] ?? '', from: caret - (match?.[0]?.length ?? 0), to: caret }
}

/**
 * Where the caret is, for a box that may not have focus.
 *
 * `selectionStart` only MEANS something while the element has focus — on an unfocused textarea
 * it is whatever the implementation last left there, and jsdom leaves 0. Reading it blindly
 * put the completion word at position 0, so completing after a programmatic value change (a
 * restored draft, a test) looked at the wrong end of the statement and offered nothing.
 *
 * Unfocused, the only sane caret is the end: that is where text goes next.
 */
function caretOf(element, value) {
  const end = String(value ?? '').length
  if (element === null || element === undefined) return end
  const focused = typeof element.ownerDocument?.activeElement === 'object'
    && element.ownerDocument.activeElement === element
  if (!focused) return end
  const at = element.selectionStart
  return typeof at === 'number' && at >= 0 && at <= end ? at : end
}

/**
 * ── the SSH half of the card ─────────────────────────────────────────────────
 *
 * The card is a database OR an SSH client, never both at once — so this is a separate
 * render path rather than a section underneath the query box. Two panels sharing one slot
 * would leave a person working out which button belonged to which, and the answer would
 * change with the mode.
 *
 * What it is honest about:
 *   • it runs COMMANDS, not a terminal. There is no PTY, so vim, top and a sudo password
 *     prompt do not work here — "systemctl status", "docker ps", "df -h", "tail -n 50" do;
 *   • there is no read-only switch, because a shell has none. The database side can promise
 *     not to send a write; this cannot promise anything about a command it was asked to run;
 *   • the engine is the SYSTEM's ssh (its agent, its ~/.ssh/config, its known_hosts), and
 *     the card says so on screen rather than only in a README.
 */
const SSH_AUTH = [
  { id: 'password', zh: '密码', en: 'PASSWORD', hint: '密码只写进 DSH 凭据库，主机里留一个名字' },
  { id: 'key', zh: '密钥文件', en: 'KEY FILE', hint: '用你本机的私钥，和 ssh -i 一样' },
  { id: 'agent', zh: '代理 / 配置', en: 'AGENT', hint: '交给 ssh-agent 和 ~/.ssh/config，什么都不用填' },
]

/** A fresh host draft: port 22, password auth, and strict host keys. */
function blankHost() {
  return { name: '', host: '', port: 22, user: '', auth: 'password', keyPath: '', password: '', acceptNewHostKey: false, timeoutMs: 20_000 }
}

/** An id nothing else is using. */
function nextHostId(hosts) {
  const used = new Set(hosts.map((entry) => String(entry.id)))
  let n = 1
  let id = 'ssh1'
  while (used.has(id)) {
    n += 1
    id = `ssh${n}`
  }
  return id
}

/** One stored host, with its own actions — the same shape as the connection rows. */
function SshHostRow(props) {
  const { zh, entry, active, busy, confirming } = props
  const isActive = entry.id === active
  const missing = entry.credential === 'missing'
  const auth = SSH_AUTH.find((one) => one.id === entry.auth)
  return jsxs('div', {
    className: `sq-connrow${isActive ? ' is-on' : ''}${confirming ? ' is-confirming' : ''}`,
    'data-host': entry.id,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'sq-connpick',
        'data-act': 'host-pick',
        'aria-pressed': isActive ? 'true' : 'false',
        title: zh ? `正在使用：${entry.target}` : `in use: ${entry.target}`,
        onClick: () => props.onSelect(entry.id),
        children: [
          jsx('span', { className: 'sq-connname', children: entry.name }),
          jsx('span', { className: 'sq-conntarget', children: entry.target }),
        ],
      }),
      jsxs('span', { className: 'sq-connmeta', children: [
        jsx('em', { className: 'sq-tag', children: zh ? (auth?.zh ?? entry.auth) : (auth?.en ?? entry.auth) }),
        entry.acceptNewHostKey === true
          ? jsx('em', { className: 'sq-tag is-write', title: zh ? '未知主机密钥会被自动接受' : 'unknown host keys are accepted', children: zh ? '接受新密钥' : 'accept-new' })
          : null,
        missing
          ? jsx('em', {
              className: 'sq-tag is-warn',
              title: zh ? `凭据「${entry.passwordRef}」不在凭据库里，这个主机会连不上` : `credential "${entry.passwordRef}" is missing`,
              children: zh ? '凭据缺失' : 'no credential',
            })
          : null,
      ] }),
      confirming
        ? jsxs('span', { className: 'sq-connconfirm', children: [
            jsx('span', { className: 'sq-note', children: zh ? `删除「${entry.name}」？` : `Delete "${entry.name}"?` }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-danger',
              'data-act': 'host-del-confirm',
              disabled: busy,
              onClick: () => props.onDelete(entry),
              children: zh ? '删除' : 'Delete',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'host-del-cancel',
              disabled: busy,
              onClick: () => props.onCancelConfirm(),
              children: zh ? '取消' : 'Cancel',
            }),
          ] })
        : jsxs('span', { className: 'sq-connactions', children: [
            jsx('button', {
              type: 'button', className: 'sq-connbtn', 'data-act': 'host-edit', disabled: busy,
              title: zh ? '修改这个主机' : 'edit this host',
              onClick: () => props.onEdit(entry), children: zh ? '改' : 'edit',
            }),
            jsx('button', {
              type: 'button', className: 'sq-connbtn', 'data-act': 'host-copy', disabled: busy || props.full === true,
              title: zh ? '复制一份' : 'duplicate',
              onClick: () => props.onCopy(entry), children: zh ? '复制' : 'copy',
            }),
            jsx('button', {
              type: 'button', className: 'sq-connbtn is-danger', 'data-act': 'host-del', disabled: busy,
              title: zh ? '删除这个主机' : 'delete this host',
              onClick: () => props.onAskDelete(entry.id), children: zh ? '删除' : 'delete',
            }),
          ] }),
    ],
  })
}

/** The host editor: new, or an existing one. One form for both, as on the database side. */
function SshHostEditor(props) {
  const { zh, mode, draft, outcome, testing, saving, tested } = props
  const field = (key) => ({
    'data-field': key,
    value: draft[key] === undefined || draft[key] === null ? '' : String(draft[key]),
    spellCheck: false,
    onChange: (event) => props.onDraft({ [key]: event.target.value }),
  })
  return jsxs('div', { className: 'sq-editor', children: [
    jsx('span', { className: 'sq-connect-head', children: mode === 'new' ? (zh ? '新建主机' : 'NEW HOST') : (zh ? '修改主机' : 'EDIT HOST') }),
    jsxs('div', { className: 'sq-dfields', children: [
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '显示名' : 'NAME' }),
        jsx('input', { type: 'text', ...field('name'), placeholder: zh ? '例如 跳板机' : 'e.g. bastion' }),
      ] }),
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '主机' : 'HOST' }),
        jsx('input', { type: 'text', ...field('host'), placeholder: '10.0.0.10' }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-number', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '端口' : 'PORT' }),
        jsx('input', { type: 'number', min: 1, max: 65535, ...field('port') }),
      ] }),
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '用户' : 'USER' }),
        jsx('input', { type: 'text', ...field('user'), placeholder: 'root' }),
      ] }),
    ] }),
    jsxs('div', { className: 'sq-dtypes', role: 'group', children: SSH_AUTH.map((one) => jsx('button', {
      type: 'button',
      className: `sq-dtype${draft.auth === one.id ? ' is-on' : ''}`,
      'data-auth': one.id,
      'aria-pressed': draft.auth === one.id ? 'true' : 'false',
      onClick: () => props.onDraft({ auth: one.id }),
      children: zh ? one.zh : one.en,
    }, one.id)) }),
    jsx('span', { className: 'sq-dhint', children: zh
      ? (SSH_AUTH.find((one) => one.id === draft.auth)?.hint ?? '')
      : 'How this card authenticates.' }),
    draft.auth === 'key'
      ? jsxs('div', { className: 'sq-dfields', children: [
          jsxs('label', { className: 'sq-dfield', children: [
            jsx('span', { className: 'sq-dlabel', children: zh ? '私钥文件' : 'KEY FILE' }),
            jsx('input', { type: 'text', ...field('keyPath'), placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' }),
          ] }),
        ] })
      : null,
    draft.auth === 'password'
      ? jsxs('div', { className: 'sq-dfields', children: [
          jsxs('label', { className: 'sq-dfield is-password', children: [
            jsx('span', { className: 'sq-dlabel', children: zh ? '密码' : 'PASSWORD' }),
            jsx('input', {
              type: 'password',
              'data-field': 'password',
              autoComplete: 'new-password',
              value: draft.password === undefined ? '' : String(draft.password),
              onChange: (event) => props.onDraft({ password: event.target.value }),
            }),
            jsx('span', { className: 'sq-dhint', children: mode === 'edit' && typeof draft.passwordRef === 'string' && draft.passwordRef !== ''
              ? (zh ? `留空则继续用凭据「${draft.passwordRef}」；填了就覆盖它。` : `leave empty to keep "${draft.passwordRef}".`)
              : (zh ? '测试通过后写进 DSH 凭据库，主机里只留名字。' : 'stored in the credential store after a successful test.') }),
          ] }),
        ] })
      : null,
    jsxs('div', { className: 'sq-dfields', children: [
      jsxs('label', { className: 'sq-dfield is-toggle', title: zh ? '默认关：未知或变更的主机密钥会拒绝连接（和你的 ssh 一样）' : 'off by default: unknown host keys refuse to connect', children: [
        jsx('input', {
          type: 'checkbox',
          'data-field': 'acceptNewHostKey',
          checked: draft.acceptNewHostKey === true,
          onChange: (event) => props.onDraft({ acceptNewHostKey: event.target.checked }),
        }),
        jsx('span', { className: 'sq-dlabel', children: zh ? '接受新主机密钥' : 'ACCEPT NEW HOST KEY' }),
        jsx('span', { className: 'sq-dhint', children: zh ? '第一次连某台机器时要打开它。' : 'needed the first time you reach a host.' }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-number', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '超时（毫秒）' : 'TIMEOUT (ms)' }),
        jsx('input', { type: 'number', min: 2000, max: 300000, step: 1000, ...field('timeoutMs') }),
      ] }),
    ] }),
    jsxs('div', { className: 'sq-dorun', children: [
      jsx('button', {
        type: 'button', className: 'sq-connect-cancel', 'data-act': 'host-test',
        disabled: testing === true || saving === true,
        onClick: () => props.onTest(),
        children: testing === true ? (zh ? '测试中…' : 'testing…') : (zh ? '测试' : 'Test'),
      }),
      jsx('button', {
        type: 'button', className: 'sq-connect-go', 'data-act': 'host-save',
        disabled: saving === true || testing === true,
        onClick: () => props.onSave(),
        children: saving === true
          ? (zh ? '保存中…' : 'saving…')
          : tested === true ? (zh ? '保存' : 'Save') : (zh ? '未测试，仍要保存' : 'save untested'),
      }),
      jsx('button', {
        type: 'button', className: 'sq-connect-cancel', 'data-act': 'host-cancel',
        disabled: saving === true, onClick: () => props.onCancel(), children: zh ? '取消' : 'Cancel',
      }),
      outcome === null ? null : jsx('span', {
        className: `sq-outcome${outcome.ok ? ' is-ok' : ' is-bad'}`,
        role: outcome.ok ? 'status' : 'alert',
        children: outcome.text,
      }),
    ] }),
  ] })
}

/** The SSH card: hosts, a command box, and what came back. */
/**
 * ── a small terminal, because a terminal is what was asked for ───────────────
 *
 * The command box answered "run this and show me what came back". This answers the other
 * question: a live shell where `cd` sticks, a program can ask a question, and what is on
 * screen is what the far side drew.
 *
 * It is a SCREEN, not a log. A log appends bytes; a terminal has a grid, a cursor, and
 * programs that overwrite what they wrote a moment ago — which is why `less`, `top`, a
 * progress bar and line editing all look like nothing at all in a log, and work here.
 *
 * The subset is deliberate and covers what a shell actually does:
 *   • CR, LF, BS, TAB, BEL
 *   • CSI: cursor moves (A B C D H f G d), erase (J K), SGR colours, save/restore (s u),
 *     and `?…h/l` mode sets, ignored rather than obeyed
 *   • OSC: skipped to its terminator. Ubuntu's shell sends `]3008;…` on every prompt; a
 *     terminal that renders that as text is unreadable.
 * Full-screen apps that use the alternate screen (`?1049h`) are drawn into the same grid —
 * they work, but their output also lands in the scrollback, which is the one honest
 * difference from xterm.
 */
const TERMINAL_COLS = 100
const TERMINAL_ROWS = 26
const SCROLLBACK_LINES = 400

/** The 16 basic colours, as class names the stylesheet owns. */
const BASIC_FG = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
/** The xterm 256-colour palette, so `ls --color` and `git log` are not monochrome. */
function palette256(n) {
  const index = Number(n)
  if (!Number.isFinite(index) || index < 0 || index > 255) return undefined
  if (index < 16) return undefined // handled by the basic classes
  if (index < 232) {
    const i = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    return `rgb(${steps[Math.floor(i / 36) % 6]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`
  }
  const grey = 8 + (index - 232) * 10
  return `rgb(${grey},${grey},${grey})`
}

const blankCell = () => ({ ch: ' ', fg: '', bg: '', bold: false, dim: false })

/**
 * One screen: a grid of cells plus a scrollback of the lines that scrolled off the top.
 * @returns {{feed: (text: string) => boolean, rows: () => Array, scrolled: () => Array, reset: () => void}}
 */
function createScreen(cols = TERMINAL_COLS, rows = TERMINAL_ROWS) {
  let width = cols
  let height = rows
  const makeGrid = () => Array.from({ length: height }, () => Array.from({ length: width }, blankCell))
  let grid = makeGrid()
  let x = 0
  let y = 0
  let style = { fg: '', bg: '', bold: false, dim: false }
  let saved = { x: 0, y: 0 }
  const scrollback = []
  let state = 'text'
  let buffer = ''

  const clearRow = (row) => { grid[row] = Array.from({ length: width }, blankCell) }

  const scrollUp = () => {
    // The top line leaves the screen and joins the scrollback: that is what makes scrolling
    // back through `cat` output possible at all.
    scrollback.push(grid[0])
    if (scrollback.length > SCROLLBACK_LINES) scrollback.splice(0, scrollback.length - SCROLLBACK_LINES)
    grid = [...grid.slice(1), Array.from({ length: width }, blankCell)]
    y = Math.max(0, y - 1)
  }

  const newline = () => {
    y += 1
    if (y >= height) {
      y = height - 1
      scrollUp()
    }
  }

  const put = (ch) => {
    if (x >= width) {
      // No wrapping modes are implemented: a line that runs past the edge wraps, which is
      // what every terminal does by default.
      x = 0
      newline()
    }
    grid[y][x] = { ch, ...style }
    x += 1
  }

  /** SGR — the colour and weight codes. */
  const sgr = (params) => {
    const codes = params === '' ? [0] : params.split(';').map((one) => Number(one === '' ? 0 : one))
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]
      if (code === 0) style = { fg: '', bg: '', bold: false, dim: false }
      else if (code === 1) style = { ...style, bold: true }
      else if (code === 2) style = { ...style, dim: true }
      else if (code === 22) style = { ...style, bold: false, dim: false }
      else if (code === 39) style = { ...style, fg: '' }
      else if (code === 49) style = { ...style, bg: '' }
      else if (code >= 30 && code <= 37) style = { ...style, fg: BASIC_FG[code - 30] }
      else if (code >= 90 && code <= 97) style = { ...style, fg: `${BASIC_FG[code - 90]} bright` }
      else if (code >= 40 && code <= 47) style = { ...style, bg: BASIC_FG[code - 40] }
      else if (code >= 100 && code <= 107) style = { ...style, bg: `${BASIC_FG[code - 100]} bright` }
      else if (code === 38 || code === 48) {
        // 38;5;N (256) and 38;2;R;G;B (truecolour). Both are worth honouring: `ls --color`
        // uses the first and modern tools use the second.
        const extended = codes[i + 1]
        if (extended === 5) {
          const rgb = palette256(codes[i + 2])
          if (rgb !== undefined) style = code === 38 ? { ...style, fg: rgb } : { ...style, bg: rgb }
          i += 2
        } else if (extended === 2) {
          const rgb = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
          style = code === 38 ? { ...style, fg: rgb } : { ...style, bg: rgb }
          i += 4
        } else {
          i += 1
        }
      }
    }
  }

  /** One CSI sequence, once its final byte has arrived. */
  const csi = (raw) => {
    // A private-mode sequence (`?25l`) is a mode set, not a movement: ignored on purpose.
    const priv = raw.startsWith('?') || raw.startsWith('>') || raw.startsWith('=')
    const body = priv ? raw.slice(1) : raw
    const final = body.slice(-1)
    const params = body.slice(0, -1)
    if (priv) return
    const first = Number(params.split(';')[0] === '' ? 0 : params.split(';')[0])
    const n = Number.isFinite(first) && first !== 0 ? first : 1
    switch (final) {
      case 'A': y = Math.max(0, y - n); break
      case 'B': y = Math.min(height - 1, y + n); break
      case 'C': x = Math.min(width - 1, x + n); break
      case 'D': x = Math.max(0, x - n); break
      case 'G': x = Math.max(0, Math.min(width - 1, n - 1)); break
      case 'd': y = Math.max(0, Math.min(height - 1, n - 1)); break
      case 'H': case 'f': {
        const parts = params.split(';')
        const row = Number(parts[0] === '' || parts[0] === undefined ? 1 : parts[0])
        const col = Number(parts[1] === '' || parts[1] === undefined ? 1 : parts[1])
        y = Math.max(0, Math.min(height - 1, (Number.isFinite(row) && row > 0 ? row : 1) - 1))
        x = Math.max(0, Math.min(width - 1, (Number.isFinite(col) && col > 0 ? col : 1) - 1))
        break
      }
      case 'J': {
        const mode = Number(params === '' ? 0 : params)
        if (mode === 2 || mode === 3) {
          for (let row = 0; row < height; row += 1) clearRow(row)
          if (mode === 3) scrollback.length = 0
        } else if (mode === 0) {
          for (let col = x; col < width; col += 1) grid[y][col] = blankCell()
          for (let row = y + 1; row < height; row += 1) clearRow(row)
        } else if (mode === 1) {
          for (let col = 0; col <= x && col < width; col += 1) grid[y][col] = blankCell()
          for (let row = 0; row < y; row += 1) clearRow(row)
        }
        break
      }
      case 'K': {
        const mode = Number(params === '' ? 0 : params)
        if (mode === 0) for (let col = x; col < width; col += 1) grid[y][col] = blankCell()
        else if (mode === 1) for (let col = 0; col <= x && col < width; col += 1) grid[y][col] = blankCell()
        else clearRow(y)
        break
      }
      case 'm': sgr(params); break
      case 's': saved = { x, y }; break
      case 'u': x = saved.x; y = saved.y; break
      default: break // r, h, l, t, n, c, q … not needed for a shell
    }
  }

  return {
    feed(text) {
      if (text === '') return false
      let changed = false
      for (const ch of String(text)) {
        if (state === 'osc') {
          // OSC runs to BEL or ST. Ubuntu's prompt sends `]3008;…` every time.
          if (ch === '\u0007') state = 'text'
          else if (ch === '\u001b') state = 'osc-esc'
          continue
        }
        if (state === 'osc-esc') {
          state = ch === '\\' ? 'text' : 'osc'
          continue
        }
        if (state === 'esc') {
          if (ch === '[') { state = 'csi'; buffer = ''; continue }
          if (ch === ']') { state = 'osc'; continue }
          // ESC ( B, ESC ) 0, ESC =, ESC > …: single-character introductions, all ignorable.
          state = 'text'
          continue
        }
        if (state === 'csi') {
          buffer += ch
          if (ch >= '@' && ch <= '~') {
            csi(buffer)
            state = 'text'
            changed = true
          }
          continue
        }
        if (ch === '\u001b') { state = 'esc'; continue }
        if (ch === '\r') { x = 0; changed = true; continue }
        if (ch === '\n') { newline(); changed = true; continue }
        if (ch === '\b') { x = Math.max(0, x - 1); changed = true; continue }
        if (ch === '\t') { x = Math.min(width - 1, (Math.floor(x / 8) + 1) * 8); continue }
        if (ch === '\u0007' || ch === '\u0000') continue
        if (ch < ' ') continue
        put(ch)
        changed = true
      }
      return changed
    },
    /** The visible screen as rows of styled runs, ready to render. */
    rows() {
      return grid.map((row) => {
        const runs = []
        for (const cell of row) {
          const key = `${cell.fg}|${cell.bg}|${cell.bold ? 1 : 0}${cell.dim ? 1 : 0}`
          const last = runs[runs.length - 1]
          if (last !== undefined && last.key === key) last.text += cell.ch
          else runs.push({ key, text: cell.ch, fg: cell.fg, bg: cell.bg, bold: cell.bold, dim: cell.dim })
        }
        // Trailing blanks are not worth rendering; the grid is fixed-width.
        while (runs.length > 0 && /^ +$/.test(runs[runs.length - 1].text) && runs[runs.length - 1].fg === '') runs.pop()
        return runs
      })
    },
    /** What scrolled off the top, oldest first. */
    scrolled() {
      return scrollback.map((row) => row.map((cell) => cell.ch).join('').replace(/\s+$/, ''))
    },
    /** How many characters are on screen — the card uses it to decide whether to auto-scroll. */
    animated() {
      return grid.some((row) => row.some((cell) => cell.ch !== ' '))
    },
    reset() {
      grid = makeGrid()
      scrollback.length = 0
      x = 0
      y = 0
      style = { fg: '', bg: '', bold: false, dim: false }
      state = 'text'
      return true
    },
    /** The card tells the far side its size through `stty`; the grid follows. */
    resize(nextCols, nextRows) {
      width = Math.max(20, Math.min(400, Number(nextCols) || cols))
      height = Math.max(5, Math.min(200, Number(nextRows) || rows))
      grid = makeGrid()
      x = 0
      y = 0
      return true
    },
  }
}

/** Which key a card button sends, and what the terminal calls it. */
const TERMINAL_KEYS = [
  { id: 'ctrl-c', zh: 'Ctrl-C', en: 'Ctrl-C', data: '\u0003' },
  { id: 'tab', zh: 'Tab', en: 'Tab', data: '\t' },
  { id: 'up', zh: '↑', en: '↑', data: '\u001b[A' },
  { id: 'down', zh: '↓', en: '↓', data: '\u001b[B' },
  { id: 'ctrl-d', zh: 'Ctrl-D', en: 'Ctrl-D', data: '\u0004' },
  { id: 'ctrl-l', zh: 'Ctrl-L', en: 'Ctrl-L', data: '\u000c' },
]

/** The live terminal: what the far side drew, and a line to send it. */
function SshTerminal(props) {
  const { zh, session, pending, onKey, onLine, onClose, onSend } = props
  const [line, setLine] = React.useState('')
  const runs = session?.runs ?? []
  const scrolled = session?.scrolled ?? []

  const send = (data) => { if (data !== '' && data !== undefined) onSend(data) }
  const submit = () => {
    // A shell reads a line terminator, not a newline. Sending `\n` leaves the prompt waiting
    // for the rest of a line that never comes — a real terminal sends CR.
    send(`${line}\r`)
    setLine('')
  }

  return jsxs('div', { className: 'sq-term', children: [
    jsxs('div', { className: 'sq-termbar', children: [
      jsx('span', { className: `sq-termdot${session?.closed === true ? ' is-off' : ''}` }),
      jsx('span', { className: 'sq-termtarget', children: session?.target ?? '' }),
      jsx('span', { className: 'sq-note', children: pending === true
        ? (zh ? '连接中…' : 'connecting…')
        : session?.closed === true
          ? (zh ? `已断开${session.exitCode === null || session.exitCode === undefined ? '' : `（退出码 ${session.exitCode}）`}` : 'closed')
          : (zh ? '已连接' : 'open') }),
      jsx('span', { className: 'sq-termspace' }),
      ...TERMINAL_KEYS.map((key) => jsx('button', {
        type: 'button', className: 'sq-connbtn sq-termkey', 'data-key': key.id,
        disabled: session?.closed === true,
        title: zh ? `发送 ${key.zh}` : `send ${key.en}`,
        onClick: () => send(key.data),
        children: zh ? key.zh : key.en,
      }, key.id)),
      jsx('button', {
        type: 'button', className: 'sq-connbtn is-danger', 'data-act': 'term-close',
        onClick: () => onClose(),
        children: session?.closed === true ? (zh ? '清掉' : 'clear') : (zh ? '断开' : 'close'),
      }),
    ] }),
    scrolled.length === 0
      ? null
      : jsx('pre', { className: 'sq-termscroll', 'data-act': 'term-scrollback', children: scrolled.join('\n') }),
    jsxs('pre', {
      className: 'sq-termscreen',
      'data-act': 'term-screen',
      // Clicking the screen puts the caret back in the input: a terminal you have to aim at
      // is a terminal nobody uses.
      onClick: () => { props.focus() },
      children: runs.map((row, index) => jsx('div', { className: 'sq-termrow', children: row.length === 0
        ? ' '
        : row.map((run, at) => jsx('span', {
            className: `sq-termrun${run.bold ? ' is-bold' : ''}${run.dim ? ' is-dim' : ''}${run.fg === '' ? '' : ` fg-${run.fg.replace(/\s+/g, '-')}`}${run.bg === '' ? '' : ` bg-${run.bg.replace(/\s+/g, '-')}`}`,
            style: {
              ...(run.fg.startsWith('rgb') ? { color: run.fg } : {}),
              ...(run.bg.startsWith('rgb') ? { background: run.bg } : {}),
            },
            children: run.text === '' ? ' ' : run.text,
          }, `${index}-${at}`)) }, index)),
    }),
    jsxs('div', { className: 'sq-termline', children: [
      jsx('input', {
        className: 'sq-terminput',
        'data-field': 'terminal',
        ref: props.inputRef,
        value: line,
        spellCheck: false,
        autoComplete: 'off',
        placeholder: session?.closed === true ? (zh ? '已断开' : 'closed') : (zh ? '在这里输入，回车发送' : 'type here, Enter sends'),
        disabled: session?.closed === true,
        onChange: (event) => setLine(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); submit(); return }
          if (event.key === 'ArrowUp' && line === '') { event.preventDefault(); send('\u001b[A'); return }
          if (event.key === 'ArrowDown' && line === '') { event.preventDefault(); send('\u001b[B'); return }
          if (event.key === 'Tab') { event.preventDefault(); send('\t'); return }
          if (event.key === 'c' && event.ctrlKey === true) { event.preventDefault(); send('\u0003'); return }
          if (event.key === 'd' && event.ctrlKey === true && line === '') { event.preventDefault(); send('\u0004'); return }
          onKey?.(event)
        },
      }),
      jsx('button', {
        type: 'button', className: 'sq-connect-go', 'data-act': 'term-send',
        disabled: session?.closed === true,
        onClick: () => submit(),
        children: zh ? '发送' : 'Send',
      }),
    ] }),
  ] })
}

function SshCard(props) {

  const { zh, payload, busy, error, actions, modeSwitch } = props
  const hosts = payload?.hosts ?? []
  const capability = payload?.capability
  const active = payload?.activeHost ?? ''
  const host = hosts.find((entry) => entry.id === active)
  const [editing, setEditing] = React.useState(null)
  const [confirmId, setConfirmId] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [runError, setRunError] = React.useState(null)

  const last = result ?? payload?.last ?? null
  const ready = capability?.ok === true

  /**
   * ── the live terminal ───────────────────────────────────────────────────────
   *
   * The SCREEN lives in a ref, not in state: it is a grid that thousands of bytes get poured
   * into, and re-rendering on every byte would be a re-render per keystroke of the shell's
   * echo. State holds only a counter that says "the screen changed", plus where the reader
   * has got to on the far side's stream.
   */
  const screenRef = React.useRef(null)
  if (screenRef.current === null) screenRef.current = createScreen()
  const cursorRef = React.useRef(0)
  const inputRef = React.useRef(null)
  const [screenVersion, setScreenVersion] = React.useState(0)
  const [term, setTerm] = React.useState(null)
  const [starting, setStarting] = React.useState(false)

  const startTerminal = async () => {
    setStarting(true)
    setRunError(null)
    try {
      const json = await actions.openTerm(active)
      if (json?.ok !== true) {
        setRunError(json?.error ?? (zh ? '打不开终端' : 'could not open a terminal'))
        return
      }
      screenRef.current.reset()
      cursorRef.current = 0
      screenVersionRef.current += 1
      setScreenVersion(screenVersionRef.current)
      setTerm({ id: json.session?.id ?? active, target: json.session?.target ?? '', closed: false, exitCode: null, error: null })
      // The caret goes into the terminal: a terminal you have to click before typing is a
      // terminal that looks broken for the first second.
      setTimeout(() => { try { inputRef.current?.focus?.() } catch { /* not focused, fine */ } }, 0)
    } catch (failure) {
      setRunError(failure?.payload?.error ?? (failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setStarting(false)
    }
  }

  const screenVersionRef = React.useRef(0)
  const paint = () => {
    screenVersionRef.current += 1
    setScreenVersion(screenVersionRef.current)
  }

  const endTerminal = async () => {
    const id = term?.id ?? active
    setTerm(null)
    try { await actions.closeTerm(id) } catch { /* the session may already be gone */ }
  }

  const sendToTerminal = async (data) => {
    if (typeof data !== 'string' || data === '') return
    try {
      // The size travels with the keystrokes, which is the only moment the card knows both
      // its own width and which session it is talking to.
      await actions.sendTerm(term?.id ?? active, data, 100, 26)
    } catch {
      /* a keystroke that did not arrive is not worth an error banner */
    }
  }

  const run = async () => {
    if (String(command).trim() === '') return
    setRunning(true)
    setRunError(null)
    try {
      const json = await actions.run({ id: active, command })
      if (json?.ok === true) setResult(json.result)
      else {
        setResult(json?.result ?? null)
        setRunError(json?.error ?? (zh ? '执行失败' : 'failed'))
      }
    } catch (failure) {
      /**
       * A failed COMMAND is reported as data, and the shell turns `ok: false` into a throw
       * with the body attached — so the result has to be read back out of the error.
       *
       * Without this, a command that failed left the PREVIOUS command's output on screen:
       * exit 0, the old stdout, and a person concluding it worked. (The test that caught it
       * asked for a failing command and found the successful one still rendered.)
       */
      const payload = failure?.payload
      if (payload?.result !== undefined && payload.result !== null) setResult(payload.result)
      setRunError(payload?.error ?? (failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setRunning(false)
    }
  }

  React.useEffect(() => {
    if (term === null || term.closed === true) return undefined
    let alive = true
    const tick = async () => {
      try {
        const json = await actions.pollTerm(term.id, cursorRef.current)
        if (!alive) return
        if (json?.ok !== true) {
          setTerm((current) => (current === null ? current : { ...current, closed: true, error: json?.error ?? null }))
          return
        }
        cursorRef.current = json.cursor ?? cursorRef.current
        if (typeof json.data === 'string' && json.data !== '') {
          screenRef.current.feed(json.data)
          paint()
        }
        if (json.status === 'closed') {
          setTerm((current) => (current === null ? current : { ...current, closed: true, exitCode: json.exitCode, error: json.error ?? current.error }))
        }
      } catch {
        /* a poll that failed is retried in 700ms; a banner per dropped poll would be noise */
      }
    }
    const timer = setInterval(() => { tick().catch(() => {}) }, 700)
    tick().catch(() => {})
    return () => { alive = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term?.id, term?.closed])

  const summary = capability === undefined
    ? (zh ? '读取中…' : 'reading…')
    : ready !== true
      ? (zh ? `ssh 不可用：${capability.reason}` : `ssh unavailable: ${capability.reason}`)
      : hosts.length === 0
        ? (zh ? '还没有主机' : 'no hosts')
        : host === undefined
          ? (zh ? '没有选中的主机' : 'no active host')
          : `${host.target} · ${String(capability.version ?? '').split(',')[0]}`

  return jsxs('div', { className: 'sq-root', children: [
    jsxs('div', { className: 'sq-head', children: [
      jsx('span', { className: 'sq-title', children: 'SSH' }),
      jsx('span', { className: 'sq-sub', title: host?.target ?? '', children: summary }),
      jsxs('span', { className: 'sq-right', children: [
        modeSwitch,
        jsx('button', {
          type: 'button', className: 'sq-ghost', 'data-act': 'ssh-refresh', disabled: busy === true,
          onClick: () => actions.refresh(), children: busy === true ? (zh ? '读取中…' : 'reading…') : (zh ? '刷新' : 'Refresh'),
        }),
      ] }),
    ] }),

    error === null || error === undefined
      ? null
      : jsx('span', { className: 'sq-err', 'data-act': 'ssh-error', role: 'alert', children: error }),

    ready !== true
      ? jsx('span', { className: 'sq-note is-warn', 'data-act': 'ssh-unavailable', children: zh
        ? `这台机器上没有可用的 ssh 客户端：${capability?.reason ?? '未知原因'}`
        : `no usable ssh client here: ${capability?.reason ?? 'unknown'}` })
      : jsxs('div', { className: 'sq-sshrun', children: [
          // ── the live terminal, or the button that opens one ──
          term === null
            ? jsxs('div', { className: 'sq-dorun', children: [
                jsx('button', {
                  type: 'button', className: 'sq-connect-go', 'data-act': 'term-open',
                  disabled: starting === true || hosts.length === 0,
                  onClick: () => { startTerminal().catch(() => {}) },
                  children: starting === true
                    ? (zh ? '正在连接…' : 'connecting…')
                    : (zh ? '打开终端（可交互）' : 'open a terminal'),
                }),
                jsx('span', { className: 'sq-hint', children: zh
                  ? '一个常驻的登录 shell：cd 会保持、程序能提问、屏幕就是远端画的样子。'
                  : 'a live login shell: cd sticks, programs can ask questions.' }),
              ] })
            : jsx(SshTerminal, {
                zh,
                focus: () => { try { inputRef.current?.focus?.() } catch { /* fine */ } },
                inputRef,
                version: screenVersion,
                pending: starting,
                session: {
                  target: term.target,
                  closed: term.closed,
                  exitCode: term.exitCode,
                  runs: term.closed === true && term.error ? [[{ key: 'x', text: term.error, fg: 'red', bg: '', bold: false, dim: false }]] : screenRef.current.rows(),
                  scrolled: screenRef.current.scrolled(),
                },
                onSend: (data) => { sendToTerminal(data).catch(() => {}) },
                onClose: () => { endTerminal().catch(() => {}) },
              }),
          jsxs('div', { className: 'sq-dorun', children: [
            jsx('input', {
              className: 'sq-sshcmd',
              'data-field': 'command',
              value: command,
              placeholder: zh ? '在这台主机上执行一条命令，例如 systemctl status nginx' : 'run one command, e.g. uptime',
              spellCheck: false,
              onChange: (event) => setCommand(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') run().catch(() => {}) },
            }),
            jsx('button', {
              type: 'button', className: 'sq-connect-go', 'data-act': 'ssh-run',
              disabled: running === true || hosts.length === 0 || String(command).trim() === '',
              onClick: () => { run().catch(() => {}) },
              children: running === true ? (zh ? '执行中…' : 'running…') : (zh ? '执行' : 'Run'),
            }),
          ] }),
          jsxs('div', { className: 'sq-sshpresets', children: [
            [['uptime', 'uptime'], ['磁盘', 'df -h'], ['内存', 'free -m'], ['我是谁', 'id']].map(([label, text]) => jsx('button', {
              type: 'button', className: 'sq-connbtn', 'data-act': `ssh-preset-${text.split(' ')[0]}`,
              disabled: running === true || hosts.length === 0,
              onClick: () => setCommand(text),
              children: zh ? label : text,
            }, text)),
          ] }),
          runError === null
            ? null
            : jsx('span', { className: 'sq-err', role: 'alert', children: runError }),
          last === null
            ? jsx('span', { className: 'sq-hint', children: zh ? '单条命令的输出会显示在这里 —— 需要连续操作、需要程序提问、需要看屏幕，就用上面的终端。' : 'one-shot output appears here; use the terminal above when you need to interact.' })
            : jsxs('div', { className: 'sq-sshout', children: [
                jsxs('div', { className: 'sq-sshmeta', children: [
                  jsx('code', { children: last.command }),
                  jsx('span', { className: `sq-exit${last.ok ? ' is-ok' : ' is-bad'}`, children: last.code === null || last.code === undefined ? '—' : `exit ${last.code}` }),
                  jsx('span', { className: 'sq-note', children: `${last.ms}ms${last.truncated ? (zh ? ' · 输出已截断' : ' · truncated') : ''}` }),
                ] }),
                String(last.stdout ?? '') === ''
                  ? null
                  : jsx('pre', { className: 'sq-sshstdout', 'data-act': 'ssh-stdout', children: last.stdout }),
                String(last.stderr ?? '') === ''
                  ? null
                  : jsx('pre', { className: 'sq-sshstderr', 'data-act': 'ssh-stderr', children: last.stderr }),
              ] }),
        ] }),

    jsxs('div', { className: 'sq-conns', children: [
      hosts.length === 0
        ? jsx('span', { className: 'sq-note', children: zh
          ? '还没有主机。先测试，通过了才写进设置。'
          : 'No hosts yet. Test first — only a working one is stored.' })
        : null,
      ...hosts.map((entry) => jsx(SshHostRow, {
        zh,
        entry,
        active,
        busy: busy === true,
        full: hosts.length >= 12,
        confirming: confirmId === entry.id,
        onSelect: (id) => actions.selectHost(id),
        onEdit: (one) => { setConfirmId(''); setEditing({ mode: 'edit', draft: { ...one, password: '' }, outcome: null, tested: false }) },
        onCopy: (one) => actions.copyHost(one),
        onAskDelete: (id) => setConfirmId(id),
        onCancelConfirm: () => setConfirmId(''),
        onDelete: (one) => { setConfirmId(''); actions.deleteHost(one) },
      }, `host-${entry.id}`)),
      jsxs('div', { className: 'sq-connsrow', children: [
        jsx('button', {
          type: 'button', className: 'sq-connbtn is-add', 'data-act': 'host-new',
          disabled: busy === true || hosts.length >= 12,
          onClick: () => { setConfirmId(''); setEditing({ mode: 'new', draft: blankHost(), outcome: null, tested: false }) },
          children: zh ? '＋ 新建主机' : '+ new host',
        }),
        jsx('span', { className: 'sq-note', children: `${hosts.length}/12` }),
      ] }),
    ] }),
    editing === null
      ? null
      : jsx(SshHostEditor, {
          zh,
          mode: editing.mode,
          draft: editing.draft,
          outcome: editing.outcome,
          testing: editing.testing === true,
          saving: editing.saving === true,
          tested: editing.tested === true,
          onDraft: (patch) => setEditing((current) => (current === null ? current : { ...current, draft: { ...current.draft, ...patch }, tested: false })),
          onTest: () => actions.testHost(editing, setEditing),
          onSave: () => actions.saveHost(editing, setEditing),
          onCancel: () => setEditing(null),
        }),
  ] })
}

function SqlCard(props = {}) {

  const { startTimers } = props
  const zh = hud.pickLocale() === 'zh'
  /**
   * ── the alive guard, and the trap in it ────────────────────────────────────
   *
   * The ref starts `true`, so the ONE-LINE form of this effect looks right:
   *
   *     useEffect(() => () => { aliveRef.current = false }, [])
   *
   * It is wrong. If the cleanup ever runs while the component stays on screen — which
   * is what StrictMode's simulated unmount does, and what any host that re-runs effects
   * will do — the ref is left `false` FOREVER, because nothing sets it back. Every
   * `if (!aliveRef.current) return` then silently drops its update: the card keeps its
   * DOM, keeps its handlers, answers clicks, and never repaints again.
   *
   * That is exactly what happened to this card, and it is why its result grid looked
   * broken while every other panel was fine — they all use the version below, which
   * RE-ARMS the flag in the effect body. A guard on a live component has to be re-armed
   * every time the effect runs.
   */
  const aliveRef = React.useRef(true)
  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  /**
   * The last result and the last failure — their OWN state, not part of the snapshot.
   *
   * They used to live in the snapshot, which the poll REPLACES wholesale: a minute later the
   * table someone was reading vanished, and the only way to see it again was to run the query
   * a second time. A result is not a polled fact — it is the answer to a question the user
   * asked, and it stays on screen until they ask a different one.
   *
   * The host still caches the last result and reports it in `/state`, so a page reload brings
   * it back; `read` only adopts that when there is nothing local to keep.
   */
  const [result, setResult] = React.useState(null)
  const [queryError, setQueryError] = React.useState(null)
  /**
   * The completion list, or null when it is not showing.
   *
   * `{ items, index, from, to }` — the range matters: accepting a candidate replaces the word
   * under the caret and leaves the rest of the statement exactly as it was. Replacing the whole
   * box would be simpler and would destroy the query someone is halfway through writing.
   */
  const [suggest, setSuggest] = React.useState(null)
  const boxRef = React.useRef(null)
  /**
   * What the user has folded away in the schema tree.
   *
   * Two SETS of ids — `schema` and `schema.object` — rather than a flag per node, because the
   * tree arrives from the host on every poll and a node's open state must not be part of it.
   * Held as "closed" rather than "open" so the DEFAULT is expanded: a tree that starts folded
   * hides the very thing someone opened the card to look at, and nothing here is large enough
   * to need protecting from.
   */
  const [folded, setFolded] = React.useState(() => ({ schemas: new Set(), objects: new Set() }))
  const toggleFold = (kind, id) => setFolded((current) => {
    const next = new Set(current[kind])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { ...current, [kind]: next }
  })
  const [busy, setBusy] = React.useState(false)
  const [sql, setSql] = React.useState('')
  const [running, setRunning] = React.useState(false)
  /** The per-run write switch. Component state: it must not survive a reload. */
  const [allowWrite, setAllowWrite] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  /**
   * The connection being built, or null when the panel is closed.
   *
   * A draft, not a saved connection: nothing reaches the settings file until it has
   * actually connected. It starts on SQLite because that is the one engine that needs
   * no credential and no server, so the first try has a chance of working.
   */
  const [draft, setDraft] = React.useState(null)
  const [connecting, setConnecting] = React.useState(false)
  const [outcome, setOutcome] = React.useState(null)
  /**
   * The manager's own state: which connection is being edited, which row is asking to be
   * deleted, and whether that deletion should take the credential with it.
   *
   * `editing.draft` is LOCAL — nothing is written until 保存 — which is the difference
   * between this and the shared settings form it replaced: that one wrote every keystroke
   * into the settings file, so a half-typed hostname became the connection's host for as
   * long as it took to type the rest.
   */
  const [editing, setEditing] = React.useState(null)
  const [confirmId, setConfirmId] = React.useState('')
  const [dropCredential, setDropCredential] = React.useState(false)
  /** Whether the footer is asking before dropping every connection for the settings page. */
  const [resetAsk, setResetAsk] = React.useState(false)

  const read = React.useCallback(async (force = false) => {
    try {
      const json = force === true
        ? await hud.fetchJson('/dsh-hud/sql/refresh', { method: 'POST' })
        : await hud.fetchJson('/dsh-hud/sql/state')
      if (!aliveRef.current) return
      setSnapshot(json)
      // A page reload finds the host's cached last result; a POLL must never take the place of
      // the answer already on screen. Adopting only when there is nothing local means both.
      setResult((current) => current ?? json?.result ?? null)
      setQueryError((current) => current ?? json?.queryError ?? null)
      setError(null)
    } catch (failure) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  React.useEffect(() => {
    read(false).catch(() => {})
    // The snapshot is the CONNECTIONS and the cached schema; the poll only matters
    // when a connection is configured, which the host decides.
    const stop = startTimers?.(() => {
      // One card, one poll: the SSH side is not a database and has nothing to re-read on a
      // timer, so it re-reads its own (cheap) state instead of opening a database session.
      if (mode === 'ssh') readSsh().catch(() => {})
      else read(true).catch(() => {})
    }, snapshot?.pollMs ?? 60_000)
    return () => { if (typeof stop === 'function') stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, snapshot?.pollMs])

  const applySettings = (json) => {
    if (json?.settings === undefined) return
    setSnapshot((current) => (current === null ? current : { ...current, settings: json.settings }))
    /**
     * …and the panel-level facts the card needs even when there is NO snapshot.
     *
     * The mode switch goes through this: `mode`, `hosts` and `activeHost` live in the same
     * settings blob, and a switch that only landed in a snapshot the card may not have
     * would do nothing until a reload. That is the same mistake as the engine list coming
     * from the state payload — the fix is the same: the answer is kept where the card can
     * always see it.
     */
    setPanelInfo((current) => ({
      ...current,
      mode: json.settings.mode ?? current.mode,
      hosts: Array.isArray(json.settings.hosts) ? json.settings.hosts : current.hosts,
      activeHost: json.settings.activeHost ?? current.activeHost,
    }))
  }
  const settings = hud.useSettings('/dsh-hud/sql', applySettings)

  // `result` and `queryError` are their own state now — they must outlive the poll.
  const connections = snapshot?.connections ?? []
  const active = snapshot?.active ?? ''
  const schema = snapshot?.schema
  // Rebuilt only when the schema changes: the poll returns a new object every minute, and
  // rebuilding a few hundred strings each time would be work with no purpose.
  const vocabulary = React.useMemo(() => buildVocabulary(schema), [schema])
  const connection = connections.find((entry) => entry.id === active)
  const readOnly = connection?.readOnly !== false
  /**
   * The engines, from a route that does NOT touch a database.
   *
   * They used to come only from the state payload, so a card that could not read its state
   * had NO engine list — the 新建连接 form rendered no engine buttons at all and silently
   * stayed on SQLite ("数据库文件"), which is a form nobody can fill in to reach PostgreSQL
   * or SQL Server. Choosing an engine has nothing to do with whether a database is
   * reachable, so it is asked for separately, and the settings route answers it without
   * opening a socket.
   */
  const [panelInfo, setPanelInfo] = React.useState({ drivers: [], mode: undefined, hosts: [], activeHost: '' })
  React.useEffect(() => {
    let alive = true
    hud.fetchJson('/dsh-hud/sql/settings')
      .then((json) => {
        if (!alive) return
        setPanelInfo((current) => ({
          drivers: Array.isArray(json?.drivers) && json.drivers.length > 0 ? json.drivers : current.drivers,
          // WHICH CARD THIS IS comes from here as well as from the state payload, and that
          // matters: a card that cannot reach a database must still be able to switch to SSH.
          mode: json?.settings?.mode ?? current.mode,
          hosts: Array.isArray(json?.settings?.hosts) ? json.settings.hosts : current.hosts,
          activeHost: json?.settings?.activeHost ?? current.activeHost,
        }))
      })
      .catch(() => { /* the snapshot's own copy is the fallback */ })
    return () => { alive = false }
  }, [])
  const drivers = (snapshot?.drivers?.length ?? 0) > 0 ? snapshot.drivers : panelInfo.drivers
  // WHO is enforcing read-only, not just whether it is on. PostgreSQL and MySQL refuse a
  // write in a read-only transaction — the SERVER refuses. SQL Server has no read-only
  // transaction, so for that driver the refusal happens in this plugin, which is a weaker
  // promise and is labelled as such instead of borrowing the other drivers' wording.
  const engineReadOnly = (drivers.find((one) => one.id === connection?.driver)?.readonly ?? 'engine') !== 'client'
  /** The panel is open, or the card has nothing to show and is asking for a database. */
  const showConnect = draft !== null || (snapshot !== null && connections.length === 0)
  const openDraft = () => {
    setOutcome(null)
    // The same starting point the ⚙ editor uses, port included: one description of what a
    // new connection begins as, so the two forms cannot start differently.
    setDraft(blankConnection(drivers, zh))
  }
  /**
   * Test the draft, and only then keep it.
   *
   * "Connect" that writes a broken connection into the settings file is a lie about
   * what happened: the entry appears, the card looks configured, and every later read
   * fails. So the test comes first, and a failure leaves the settings untouched —
   * the draft stays on screen with the reason next to it.
   */
  const connect = async () => {
    if (draft === null) return
    const typed = typeof draft.password === 'string' ? draft.password : ''
    setConnecting(true)
    setOutcome(null)
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/test', {
        method: 'POST',
        // The password is sent WITH the test rather than looked up first. Asking for the
        // NAME of a credential that must already exist is what produced "凭据无效" for
        // someone who had just typed their password.
        body: JSON.stringify({ connection: draft, password: typed }),
      })
      if (!aliveRef.current) return
      if (json?.ok !== true) {
        setOutcome({ ok: false, text: json?.error ?? (zh ? '连接失败' : 'connection failed') })
        return
      }
      // A stable id that cannot collide with one already in use.
      const used = new Set(connections.map((entry) => entry.id))
      let id = 'db'
      let n = 1
      while (used.has(id)) { n += 1; id = `db${n}` }
      // The secret goes to the credential store and only its NAME goes into the
      // connection, so the settings file — and every state response the browser asks for —
      // still contains no password. Written AFTER the test passed: nothing is stored
      // before it is known to work.
      let passwordRef = String(draft.passwordRef ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_')
      if (typed !== '') {
        // UNDERSCORES, not hyphens: the credential store's refs match
        // /^[A-Za-z_][A-Za-z0-9_]*$/, and this name is generated from a connection id that can
        // contain anything. A hyphen here does not fail locally — it makes the credentials
        // plugin fail to load, and DSH will not start until the line is deleted by hand.
        if (passwordRef === '') passwordRef = `dsh_hud_sql_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`
        const stored = await hud.fetchJson('/dsh-hud/sql/credential', {
          method: 'POST',
          body: JSON.stringify({ ref: passwordRef, value: typed }),
        })
        if (!aliveRef.current) return
        if (stored?.ok !== true) {
          setOutcome({ ok: false, text: stored?.error ?? (zh ? '密码没能存进凭据库' : 'could not store the password') })
          return
        }
      }
      // The draft CARRIES the typed password, so it has to be taken out again by name.
      // Spreading the draft whole is what put `"password":"sup3r-s3cret"` into the settings
      // file — the test reads the actual request body, which is how it was caught. The
      // whole point of the credential store is that this file never holds a secret.
      const { password: _typed, ...withoutSecret } = draft
      const saved = {
        ...withoutSecret,
        passwordRef: passwordRef === '' ? undefined : passwordRef,
        id,
        name: String(draft.name ?? '').trim() || String(draft.database ?? '').trim() || String(draft.file ?? '').trim() || id,
      }
      settings.patch({ connections: [...connections.map((entry) => ({ ...entry })), saved], active: id })
      // `info` is an OBJECT (host, port, database, serverVersion…), so it is summarised
      // rather than interpolated — `已连接：[object Object]` is the kind of thing that
      // makes a working feature look broken.
      const info = json.info ?? {}
      const detail = [info.serverVersion, info.database, info.host].filter((part) => typeof part === 'string' && part !== '').join(' · ')
      setOutcome({
        ok: true,
        text: [
          zh ? '已连接' : 'connected',
          detail,
          json.ms === undefined ? '' : `${json.ms}ms`,
          // Say where the password went. A secret that disappears into a store the user
          // cannot see is a secret they will type again next time.
          typed === '' ? '' : (zh ? `密码已存入凭据 ${passwordRef}` : `password stored as ${passwordRef}`),
        ]
          .filter((part) => part !== '' && part !== undefined).join(' · '),
      })
      setDraft(null)
      // Read it back from the host rather than trusting the local copy: the settings
      // route is where the two can disagree, and the host is the one that opens sockets.
      await read(true)
    } catch (failure) {
      if (aliveRef.current) setOutcome({ ok: false, text: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      if (aliveRef.current) setConnecting(false)
    }
  }

  // ── the manager's handlers ─────────────────────────────────────────────
  //
  // Every one of them writes the WHOLE `connections` array plus `active`. A partial write
  // is how a settings screen silently deletes things, and the host stores the array whole.

  /** Open the editor on a connection that is already stored. */
  const startEdit = (entry) => {
    setConfirmId('')
    setEditing({
      mode: 'edit',
      // A copy, so typing cannot touch the snapshot the list is rendered from. `password`
      // starts empty and means "keep what is stored" — see the editor's own hint.
      draft: { ...entry, password: '' },
      outcome: null,
      tested: false,
      testing: false,
      saving: false,
    })
  }

  /** Open the editor on a new one. Nothing is stored until 保存. */
  const startNew = () => {
    setConfirmId('')
    setEditing({ mode: 'new', draft: blankConnection(drivers, zh), outcome: null, tested: false, testing: false, saving: false })
  }

  /** Test the draft against the host, without storing anything. */
  const testEditing = async () => {
    if (editing === null) return
    setEditing((current) => (current === null ? current : { ...current, testing: true, outcome: null }))
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/test', {
        method: 'POST',
        body: JSON.stringify({ connection: editing.draft, password: String(editing.draft.password ?? '') }),
      })
      if (!aliveRef.current) return
      const info = json?.info ?? {}
      const detail = [info.serverVersion, info.database, info.host, info.file].filter((part) => typeof part === 'string' && part !== '').join(' · ')
      setEditing((current) => (current === null ? current : {
        ...current,
        testing: false,
        tested: json?.ok === true,
        outcome: json?.ok === true
          ? { ok: true, text: [zh ? '测试通过' : 'ok', detail, json.ms === undefined ? '' : `${json.ms}ms`].filter((part) => part !== '').join(' · ') }
          : { ok: false, text: json?.error ?? (zh ? '连接失败' : 'connection failed') },
      }))
    } catch (failure) {
      if (aliveRef.current) {
        setEditing((current) => (current === null ? current : {
          ...current, testing: false, tested: false,
          outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
        }))
      }
    }
  }

  /**
   * Save the draft: the credential first (only when a password was typed), then the list.
   *
   * The password is written AFTER the test where there was one, exactly like the connect
   * flow — a secret that is stored for a connection that never worked is a secret written
   * for nothing. When there was no successful test the save still goes through, because a
   * server that is briefly down must not stop someone fixing a typo; the button says so.
   */
  const saveEditing = async () => {
    if (editing === null) return
    const { mode, draft: pending } = editing
    setEditing((current) => (current === null ? current : { ...current, saving: true }))
    try {
      const typed = typeof pending.password === 'string' ? pending.password : ''
      const id = mode === 'edit' ? String(pending.id) : nextConnectionId(connections)
      let passwordRef = String(pending.passwordRef ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_')
      if (typed !== '') {
        // UNDERSCORES, not hyphens: the credential store's refs match
        // /^[A-Za-z_][A-Za-z0-9_]*$/, and a hyphen here does not fail locally — it makes
        // the credentials plugin fail to load, and DSH will not start until the line is
        // deleted by hand.
        if (passwordRef === '') passwordRef = `dsh_hud_sql_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
        const stored = await hud.fetchJson('/dsh-hud/sql/credential', {
          method: 'POST',
          body: JSON.stringify({ ref: passwordRef, value: typed }),
        })
        if (!aliveRef.current) return
        if (stored?.ok !== true) {
          setEditing((current) => (current === null ? current : {
            ...current, saving: false, outcome: { ok: false, text: stored?.error ?? (zh ? '密码没能存进凭据库' : 'could not store the password') },
          }))
          return
        }
      }
      // The draft carries the typed password, so it is taken out AGAIN by name. Spreading
      // it whole is what once put `"password":"sup3r-s3cret"` into the settings file.
      const { password: _typed, target: _target, credential: _credential, ...rest } = pending
      const entry = {
        ...rest,
        id,
        name: defaultConnectionName(pending, id),
        passwordRef: passwordRef === '' ? undefined : passwordRef,
      }
      const next = mode === 'edit'
        // REPLACED IN PLACE: the list order is the order someone arranged for themselves,
        // and an edit that jumped the connection to the end would be a different list.
        ? connections.map((one) => (one.id === id ? entry : one))
        : [...connections, entry]
      /**
       * EDITING DOES NOT SWITCH CONNECTIONS.
       *
       * `active` is a separate decision from `connections`, and someone fixing a typo in
       * the standby connection should still be querying the one they were querying. Only
       * ADDING one makes it active — because you have just said you want to use it.
       */
      const stillThere = connections.some((one) => one.id === active)
      const nextActive = mode === 'edit' && stillThere ? active : id
      await settings.patch({ connections: next, active: nextActive })
      if (!aliveRef.current) return
      setEditing(null)
      // Read it back from the host rather than trusting the local copy: the host cleans
      // and defaults what it stores, and it is the one that opens sockets.
      await read(true)
    } catch (failure) {
      if (aliveRef.current) {
        setEditing((current) => (current === null ? current : {
          ...current, saving: false, outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
        }))
      }
    }
  }

  /** Copy a connection: same settings, same credential, new id and name. */
  const copyConnection = async (entry) => {
    if (connections.length >= MAX_CONNECTIONS) return
    const id = nextConnectionId(connections)
    const { target: _target, credential: _credential, ...rest } = entry
    const copy = { ...rest, id, name: `${entry.name} ${zh ? '副本' : 'copy'}` }
    const at = connections.findIndex((one) => one.id === entry.id)
    const next = [...connections.slice(0, at + 1), copy, ...connections.slice(at + 1)]
    await settings.patch({ connections: next, active: copy.id })
    await read(true)
  }

  /**
   * Delete a connection — and the credential only if it was asked for.
   *
   * The credential is KEPT by default: two connections can name the same one (the same
   * database with and without writes), so removing one must not break the other. The host
   * refuses anyway while another connection still references it, and its refusal is shown
   * here rather than swallowed.
   */
  const deleteConnection = async (entry) => {
    const next = connections.filter((one) => one.id !== entry.id)
    const stillActive = snapshot?.active === entry.id ? (next[0]?.id ?? '') : (snapshot?.active ?? '')
    await settings.patch({ connections: next, active: stillActive })
    if (dropCredential === true && typeof entry.passwordRef === 'string' && entry.passwordRef !== '') {
      const removed = await hud.fetchJson('/dsh-hud/sql/credential/remove', {
        method: 'POST',
        body: JSON.stringify({ ref: entry.passwordRef }),
      })
      if (aliveRef.current && removed?.ok !== true && removed?.error !== undefined) {
        setEditing({ mode: 'new', draft: blankConnection(drivers, zh), outcome: { ok: false, text: removed.error }, tested: false, testing: false, saving: false })
      }
    }
    if (aliveRef.current) {
      setConfirmId('')
      setDropCredential(false)
    }
    await read(true)
  }

  /**
   * Show or hide the completion list for the caret's current word.
   *
   * Called on typing and on caret movement, and it does NOT run while a completion is being
   * accepted — otherwise the list would reopen on the word just completed and Tab would appear
   * to do nothing.
   */
  const refreshSuggest = (value, caret) => {
    const { word, from, to } = wordAt(value, caret)
    // One character is enough to be useful and short enough not to flash a list at every
    // keystroke; Ctrl+Space forces it even on an empty word.
    const items = word.length >= 1 ? completionsFor(vocabulary, word) : []
    setSuggest(items.length === 0 ? null : { items, index: 0, from, to })
  }

  /** Put a candidate into the box, replacing the word under the caret. */
  const acceptSuggest = (candidate) => {
    const box = boxRef.current
    const caret = box?.selectionStart ?? suggest?.to ?? sql.length
    const from = suggest?.from ?? caret
    const to = suggest?.to ?? caret
    const next = `${sql.slice(0, from)}${candidate}${sql.slice(to)}`
    setSql(next)
    setSuggest(null)
    // The caret goes AFTER the inserted word — in a `useEffect`, because React has not written
    // the new value into the DOM yet and setting selectionStart on the old value puts it back.
    const at = from + candidate.length
    React.startTransition?.(() => {})
    setTimeout(() => {
      const element = boxRef.current
      if (element === null) return
      element.focus()
      element.setSelectionRange(at, at)
    }, 0)
  }

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/query', {
        method: 'POST',
        body: JSON.stringify({ id: active, sql, allowWrite }),
      })
      if (!aliveRef.current) return
      // `ok: false` here is an ANSWER about the query (a refusal, a SQL error), not a
      // broken route — so it is shown where the result would be.
      if (json?.ok === false) {
        // The structured form when the host sent one, and the plain string when it did not —
        // a card that renders `undefined` for an old host is worse than one that shows less.
        const detail = json.queryError ?? { message: json.error ?? (zh ? '查询失败' : 'query failed') }
        setResult(null)
        setQueryError(detail)
      } else {
        setResult(json.result ?? null)
        setQueryError(null)
      }
    } catch (failure) {
      // The shell's fetchJson THROWS on `ok: false`, so a SQL error — which is an ANSWER about
      // the statement, not a broken route — arrives here rather than in the branch above. The
      // whole body is on the error, so the server's code, DETAIL and HINT survive instead of
      // being flattened into one sentence.
      const body = failure?.payload
      const detail = body?.queryError ?? {
        message: body?.error ?? (failure instanceof Error ? failure.message : String(failure)),
        code: body?.code,
      }
      if (aliveRef.current) {
        setResult(null)
        setQueryError(detail)
      }
    } finally {
      if (aliveRef.current) setRunning(false)
    }
  }

  /**
   * NO STATE AT ALL is a different thing from "no connections", and saying the wrong one
   * scares people: a page whose first state read failed has `snapshot === null`, and the
   * card used to render that as an empty list — "我的配置怎么都没有了" — when the settings
   * file had never been touched. A failed read says it failed.
   */
  /**
   * ── which card this is ──────────────────────────────────────────────────────
   *
   * `db` or `ssh`, and never both: the other side is not rendered and not polled. The
   * settings route answers this even when the database side is unreachable, which is the
   * only way to switch AWAY from a card that cannot read its own state.
   */
  const mode = panelInfo.mode ?? snapshot?.mode ?? 'db'

  const [ssh, setSsh] = React.useState(null)
  const [sshBusy, setSshBusy] = React.useState(false)
  const [sshError, setSshError] = React.useState(null)
  const readSsh = React.useCallback(async () => {
    setSshBusy(true)
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/ssh/state')
      if (!aliveRef.current) return
      setSsh(json)
      setSshError(null)
    } catch (failure) {
      if (aliveRef.current) setSshError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (aliveRef.current) setSshBusy(false)
    }
  }, [])

  /**
   * Ask once, as soon as the card becomes an SSH client.
   *
   * Without this the card sat on "读取中…" until the next poll — a whole minute of a card
   * that looks broken, on the very screen a person switched to on purpose. Asked ONCE (a
   * ref, not state): a failed read must not turn into a retry loop, and the 刷新 button is
   * right there.
   */
  const sshAsked = React.useRef(false)
  React.useEffect(() => {
    if (mode !== 'ssh' || sshAsked.current) return
    sshAsked.current = true
    readSsh().catch(() => {})
  }, [mode, readSsh])

  // The hosts the SETTINGS route knows about, used when the ssh route itself cannot answer
  // — the same fallback the engine list has, for the same reason.
  const settingsHosts = (panelInfo.hosts ?? []).map((one) => ({
    ...one,
    target: `${one.user === undefined || one.user === '' ? '' : `${one.user}@`}${one.host}:${one.port}`,
  }))
  const sshHosts = (ssh?.hosts?.length ?? 0) > 0 ? ssh.hosts : settingsHosts
  const activeHost = ssh?.activeHost ?? panelInfo.activeHost ?? ''

  const sshActions = {
    refresh: () => { readSsh().catch(() => {}) },
    selectHost: (id) => settings.patch({ activeHost: id }),
    copyHost: async (entry) => {
      if (sshHosts.length >= 12) return
      const id = nextHostId(sshHosts)
      const { target: _target, credential: _credential, ...rest } = entry
      const copy = { ...rest, id, name: `${entry.name} ${zh ? '副本' : 'copy'}` }
      const at = sshHosts.findIndex((one) => one.id === entry.id)
      const next = [...sshHosts.slice(0, at + 1), copy, ...sshHosts.slice(at + 1)].map(({ target: _t, credential: _c, ...keep }) => keep)
      await settings.patch({ hosts: next, activeHost: copy.id })
      await readSsh()
    },
    deleteHost: async (entry) => {
      const next = sshHosts
        .filter((one) => one.id !== entry.id)
        .map(({ target: _t, credential: _c, ...keep }) => keep)
      const stillThere = sshHosts.some((one) => one.id === activeHost)
      await settings.patch({ hosts: next, activeHost: stillThere && activeHost !== entry.id ? activeHost : (next[0]?.id ?? '') })
      await readSsh()
    },
    testHost: async (editing, setEditing) => {
      setEditing((current) => (current === null ? current : { ...current, testing: true, outcome: null }))
      try {
        const json = await hud.fetchJson('/dsh-hud/sql/ssh/test', {
          method: 'POST',
          body: JSON.stringify({ host: editing.draft, password: String(editing.draft.password ?? '') }),
        })
        if (!aliveRef.current) return
        setEditing((current) => (current === null ? current : {
          ...current,
          testing: false,
          tested: json?.ok === true,
          outcome: json?.ok === true
            ? { ok: true, text: [zh ? '测试通过' : 'ok', json.target, json.answered, json.ms === undefined ? '' : `${json.ms}ms`].filter((part) => typeof part === 'string' && part !== '').join(' · ') }
            : { ok: false, text: json?.error ?? (zh ? '连不上' : 'failed') },
        }))
      } catch (failure) {
        if (aliveRef.current) {
          setEditing((current) => (current === null ? current : {
            ...current, testing: false, tested: false,
            outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
          }))
        }
      }
    },
    saveHost: async (editing, setEditing) => {
      setEditing((current) => (current === null ? current : { ...current, saving: true }))
      try {
        const pending = editing.draft
        const typed = typeof pending.password === 'string' ? pending.password : ''
        const id = editing.mode === 'edit' ? String(pending.id) : nextHostId(sshHosts)
        let passwordRef = String(pending.passwordRef ?? '').trim()
        if (typed !== '') {
          // Underscores only: the credential store's refs match /^[A-Za-z_][A-Za-z0-9_]*$/, and
          // a hyphen there stops the credentials plugin from loading at all.
          if (passwordRef === '') passwordRef = `dsh_hud_ssh_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
          const stored = await hud.fetchJson('/dsh-hud/sql/credential', {
            method: 'POST',
            body: JSON.stringify({ ref: passwordRef, value: typed }),
          })
          if (!aliveRef.current) return
          if (stored?.ok !== true) {
            setEditing((current) => (current === null ? current : {
              ...current, saving: false, outcome: { ok: false, text: stored?.error ?? (zh ? '密码没能存进凭据库' : 'could not store the password') },
            }))
            return
          }
        }
        const { password: _typed, target: _target, credential: _credential, ...rest } = pending
        const entry = {
          ...rest,
          id,
          name: String(pending.name ?? '').trim() === '' ? (String(pending.host ?? '').trim() || id) : String(pending.name).trim(),
          port: Number(pending.port) || 22,
          timeoutMs: Number(pending.timeoutMs) || 20_000,
          passwordRef: passwordRef === '' ? undefined : passwordRef,
        }
        const clean = (one) => { const { target: _t, credential: _c, ...keep } = one; return keep }
        const next = editing.mode === 'edit'
          ? sshHosts.map((one) => (one.id === id ? entry : one)).map(clean)
          : [...sshHosts, entry].map(clean)
        await settings.patch({ hosts: next, activeHost: editing.mode === 'edit' && activeHost !== '' ? activeHost : id })
        if (!aliveRef.current) return
        setEditing(null)
        await readSsh()
      } catch (failure) {
        if (aliveRef.current) {
          setEditing((current) => (current === null ? current : {
            ...current, saving: false, outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
          }))
        }
      }
    },
    run: ({ id, command }) => hud.fetchJson('/dsh-hud/sql/ssh/run', { method: 'POST', body: JSON.stringify({ id, command }) }),
    /**
     * The live terminal. Four calls, and the third one is a poll: the panel's transport to
     * the host is request/response, so "what has the far side printed since cursor N" is
     * asked rather than pushed. At 700 ms it is a terminal to anyone using it.
     */
    openTerm: (id) => hud.fetchJson('/dsh-hud/sql/ssh/open', { method: 'POST', body: JSON.stringify({ id }) }),
    pollTerm: (id, since) => hud.fetchJson('/dsh-hud/sql/ssh/session', { method: 'POST', body: JSON.stringify({ id, since }) }),
    sendTerm: (id, data, cols, rows) => hud.fetchJson('/dsh-hud/sql/ssh/input', { method: 'POST', body: JSON.stringify({ id, data, cols, rows }) }),
    closeTerm: (id) => hud.fetchJson('/dsh-hud/sql/ssh/close', { method: 'POST', body: JSON.stringify({ id }) }),
  }

  const modeSwitch = jsxs('span', { className: 'sq-modes', role: 'group', children: [
    jsx('button', {
      type: 'button', className: `sq-mode${mode !== 'ssh' ? ' is-on' : ''}`, 'data-act': 'mode-db',
      'aria-pressed': mode !== 'ssh' ? 'true' : 'false',
      title: zh ? '这张卡显示数据库' : 'this card is a database',
      onClick: () => settings.patch({ mode: 'db' }),
      children: zh ? '数据库' : 'DB',
    }),
    jsx('button', {
      type: 'button', className: `sq-mode${mode === 'ssh' ? ' is-on' : ''}`, 'data-act': 'mode-ssh',
      'aria-pressed': mode === 'ssh' ? 'true' : 'false',
      title: zh ? '这张卡显示 SSH 客户端（同一时间只有一个）' : 'this card is an SSH client (one at a time)',
      onClick: () => settings.patch({ mode: 'ssh' }),
      children: 'SSH',
    }),
  ] })

  /**
   * THE BRANCH. In SSH mode the database side is not rendered and not polled: `collect` is
   * never called, so a card that is an SSH client does not open a database connection at all.
   */
  if (mode === 'ssh') {
    return jsx(SshCard, { zh, payload: ssh ?? { hosts: settingsHosts, activeHost, capability: undefined }, busy: sshBusy, error: sshError, actions: sshActions, modeSwitch })
  }

  const noState = snapshot === null
  const summary = noState
    ? (error === null ? (zh ? '连接中…' : 'connecting…') : (zh ? `读不到状态：${error}` : `cannot read state: ${error}`))
    : connections.length === 0
      ? (zh ? '还没有连接' : 'no connections')
      : snapshot.error !== undefined
        ? snapshot.error
        : schema === undefined
          ? (zh ? '读取 schema…' : 'reading schema…')
          : `${(schema.schemas ?? []).reduce((sum, one) => sum + (one.objects?.length ?? 0), 0)} ${zh ? '个对象' : 'objects'}`

  return jsxs('div', {
    className: 'sq-root',
    children: [
    jsxs('div', { className: 'sq-head', children: [
      jsx('span', { className: 'sq-title', children: zh ? '数据库' : 'SQL' }),
      jsx('span', { className: 'sq-sub', title: snapshot?.target ?? '', children: summary }),
      jsxs('span', { className: 'sq-right', children: [
        modeSwitch,
        connections.length > 1
          ? jsx('span', { className: 'sq-picks', children: connections.map((entry) => jsx('button', {
              type: 'button',
              className: `sq-pick${entry.id === active ? ' is-on' : ''}`,
              title: entry.target,
              'aria-pressed': entry.id === active ? 'true' : 'false',
              onClick: () => settings.patch({ active: entry.id }),
              children: entry.name,
            }, `head-${entry.id}`)) })
          : null,
        jsx('button', {
          type: 'button',
          className: 'sq-ghost',
          'data-act': 'new',
          // The host stores at most 12 (`cleanProfiles`), so a 13th would be dropped on the
          // way in — and it would be the NEW one that vanished, leaving the click looking
          // like it did nothing. Disabled, with the reason in the tooltip, is the honest
          // version. (Opening the panel to inspect the draft is still allowed.)
          disabled: connecting || drivers.every((driver) => driver.available !== true)
            || (connections.length >= MAX_CONNECTIONS && draft === null),
          title: connections.length >= MAX_CONNECTIONS && draft === null
            ? (zh ? `最多 ${MAX_CONNECTIONS} 个连接：先删掉一个，或在 ⚙ 里管理` : `at most ${MAX_CONNECTIONS} connections`)
            : (zh ? '连接另一个数据库' : 'Connect another database'),
          onClick: () => (draft === null ? openDraft() : setDraft(null)),
          children: draft === null ? (zh ? '＋ 连接' : '+ connect') : (zh ? '收起' : 'close'),
        }),
        jsx('button', {
          type: 'button',
          className: 'sq-ghost',
          'data-act': 'refresh',
          // Disabled with nothing to refresh — but a card that could not READ its state has
          // something to retry, and that is exactly when someone is looking for a way to.
          disabled: busy || (connections.length === 0 && snapshot !== null),
          onClick: async () => {
            setBusy(true)
            await read(true)
            if (aliveRef.current) setBusy(false)
          },
          children: busy ? (zh ? '读取中…' : 'reading…') : (zh ? '刷新' : 'Refresh'),
        }),
        jsx(hud.SettingsGear, {
          open: settingsOpen,
          zh,
          label: zh ? '数据库设置' : 'SQL settings',
          onToggle: () => setSettingsOpen((open) => !open),
        }),
      ] }),
    ] }),

    // ── the connection manager ─────────────────────────────────────────────
    //
    // One row per stored connection, each with its own 改/复制/删除, and a draft editor
    // underneath. This replaced a row of chips followed by a row of ✕ buttons — where
    // the third ✕ belonged to the third chip only by counting — and the shared settings
    // form, which wrote every keystroke straight into the settings file and could only
    // ever edit whichever connection happened to be active.
    settingsOpen
      ? jsxs('div', { className: 'sq-conns', children: [
          noState
            ? jsxs('span', { className: 'sq-note is-warn', 'data-act': 'no-state', role: 'alert', children: [
                zh
                  ? `读不到状态，所以这里看不到连接列表 —— 存好的连接没有被删除：${error ?? ''}`
                  : `cannot read state, so the list cannot be shown — nothing has been deleted: ${error ?? ''}`,
              ] })
            : connections.length === 0
              ? jsx('span', { className: 'sq-note', children: zh
                ? '还没有连接。管道里说的话都算数：先测试，通过了才写进设置。'
                : 'No connections yet. Test first — only a working one is stored.' })
              : null,
          ...connections.map((entry) => jsx(SqlConnectionRow, {
            zh,
            entry,
            drivers,
            active,
            busy: settings.busy,
            full: connections.length >= MAX_CONNECTIONS,
            confirming: confirmId === entry.id,
            dropCredential: dropCredential === true,
            onSelect: (id) => settings.patch({ active: id }),
            onEdit: (one) => startEdit(one),
            onCopy: (one) => copyConnection(one),
            onAskDelete: (id) => {
              setDropCredential(false)
              setConfirmId(id)
            },
            onCancelConfirm: () => setConfirmId(''),
            onDropCredential: (on) => setDropCredential(on === true),
            onDelete: (one) => deleteConnection(one),
          }, `conn-${entry.id}`)),
          jsxs('div', { className: 'sq-connsrow', children: [
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-add',
              'data-act': 'conn-new',
              disabled: settings.busy || connections.length >= MAX_CONNECTIONS,
              title: connections.length >= MAX_CONNECTIONS
                ? (zh ? `最多 ${MAX_CONNECTIONS} 个连接` : `at most ${MAX_CONNECTIONS}`)
                : (zh ? '新建一个连接（先测试，再保存）' : 'add a connection (test, then save)'),
              onClick: () => startNew(),
              children: zh ? '＋ 新建连接' : '+ new connection',
            }),
            jsxs('label', { className: 'sq-dfield is-number is-tight', title: zh ? '目录缓存时间' : 'how long a schema listing is reused' , children: [
              jsx('span', { className: 'sq-dlabel', children: zh ? '目录缓存' : 'SCHEMA CACHE' }),
              jsx('input', {
                type: 'number',
                'data-field': 'pollMs',
                min: 5000,
                max: 3600000,
                step: 5000,
                value: String(snapshot?.pollMs ?? 60_000),
                disabled: settings.busy,
                onChange: (event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next >= 5000) settings.patch({ pollMs: next })
                },
              }),
              jsx('span', { className: 'sq-dhint', children: zh ? '毫秒' : 'ms' }),
            ] }),
            jsx('span', { className: 'sq-note', children: noState ? '—' : `${connections.length}/${MAX_CONNECTIONS}` }),
            // The reset the shared form used to offer, kept but made deliberate: it drops
            // EVERY card-managed connection and goes back to whatever the settings page
            // ships, so one click is not enough. (The route itself is driven directly in
            // test-host.mjs; this is only the affordance.)
            resetAsk === true
              ? jsxs('span', { className: 'sq-connconfirm', children: [
                  jsx('span', { className: 'sq-note', children: zh
                    ? `放弃卡片里的 ${connections.length} 个连接，改用设置页的值？`
                    : `Drop the card's ${connections.length} connections and use the settings page?` }),
                  jsx('button', {
                    type: 'button',
                    className: 'sq-connbtn is-danger',
                    'data-act': 'conn-reset-confirm',
                    disabled: settings.busy,
                    onClick: () => {
                      setResetAsk(false)
                      settings.reset()
                    },
                    children: zh ? '恢复' : 'Reset',
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'sq-connbtn',
                    'data-act': 'conn-reset-cancel',
                    disabled: settings.busy,
                    onClick: () => setResetAsk(false),
                    children: zh ? '取消' : 'Cancel',
                  }),
                ] })
              : jsx('button', {
                  type: 'button',
                  className: 'sq-connbtn',
                  'data-act': 'conn-reset',
                  disabled: settings.busy,
                  title: zh ? '放弃卡片里保存的连接，回到插件设置页里的连接列表' : 'drop the card settings and use the settings page again',
                  onClick: () => setResetAsk(true),
                  children: zh ? '恢复为设置页的值' : 'use the settings page',
                }),
          ] }),
        ] })
      : null,
    editing === null
      ? null
      : jsx(SqlConnectionEditor, {
          zh,
          drivers,
          mode: editing.mode,
          draft: editing.draft,
          outcome: editing.outcome,
          testing: editing.testing === true,
          saving: editing.saving === true,
          tested: editing.tested === true,
          onDraft: (patch) => setEditing((current) => (current === null ? current : { ...current, draft: { ...current.draft, ...patch }, tested: false })),
          onDriver: (id) => setEditing((current) => (current === null ? current : { ...current, draft: withDriver(current.draft, id, drivers, zh), tested: false })),
          onTest: () => testEditing(),
          onSave: () => saveEditing(),
          onCancel: () => setEditing(null),
        }),
    // The settings error is the manager's too: a refused write has to be visible next to
    // the list it refused to change, not only in the shell's own banner.
    settings.error === null || settings.error === undefined
      ? null
      : jsx('span', { className: 'sq-err', 'data-act': 'settings-error', role: 'alert', children: settings.error }),

    // A state read that failed is shown WHENEVER it failed, result on screen or not.
    //
    // It used to be hidden while a result was displayed, which meant a card that had stopped
    // being able to read its own state looked perfectly healthy — the rows on screen were
    // simply the last ones it managed to get. Stale data with no warning is worse than a
    // warning next to stale data.
    error !== null && snapshot !== null
      ? jsx('span', { className: 'sq-err', 'data-act': 'state-error', role: 'alert', children: error })
      : null,

    // ── the connection panel ───────────────────────────────────────────────
    // Shown when there is nothing configured — the card's whole job at that point is to
    // ask for a database — or when the user opened it to add another one.
    showConnect
      ? jsx(SqlConnect, {
          zh,
          drivers,
          draft: draft ?? blankConnection(drivers, zh),
          busy: connecting,
          outcome,
          onDraft: (patch) => setDraft((current) => ({
            ...(current ?? blankConnection(drivers, zh)),
            ...patch,
          })),
          onDriver: (id) => setDraft((current) => withDriver(current ?? blankConnection(drivers, zh), id, drivers, zh)),
          onConnect: () => { connect().catch(() => {}) },
          onCancel: () => { setDraft(null); setOutcome(null) },
        })
      : null,

    connections.length === 0
      ? jsx('span', { className: 'sq-note', children: zh
        ? '密码只在上面填一次；连接成功后写进 DSH 凭据库，设置文件里只留一个名字。'
        : 'For a password, give the CREDENTIAL NAME (e.g. pg-main); the value stays in the DSH credential store.' })
      : null,

    // A driver this process cannot use says so, once, at the top — rather than
    // failing at connect time with something that looks like a network problem.
    (snapshot?.drivers ?? []).filter((driver) => driver.available !== true).length > 0
      ? jsx('span', { className: 'sq-note', children: (snapshot.drivers ?? [])
        .filter((driver) => driver.available !== true)
        .map((driver) => `${driver.labelZh ?? driver.label}：${driver.reason}`)
        .join(' · ') })
      : null,

    schema !== undefined && (schema.schemas ?? []).length > 0
      ? jsxs('div', { className: 'sq-tree', children: (schema.schemas ?? []).map((one) => {
        const schemaFolded = folded.schemas.has(one.name)
        return jsxs('div', {
          className: `sq-schema${schemaFolded ? ' is-folded' : ''}`,
          children: [
            // A real BUTTON, not a click handler on the row. A div with an onClick cannot be
            // reached by the keyboard, and it is also what made an earlier version of this
            // untestable — the harness clicked the row and nothing happened. A button is
            // focusable, announces its state through aria-expanded, and is clickable by a test
            // for the same reason it is clickable by a person.
            jsxs('button', {
              type: 'button',
              className: 'sq-schemahead',
              'data-act': 'fold-schema',
              'data-schema': one.name,
              'aria-expanded': !schemaFolded,
              onClick: () => toggleFold('schemas', one.name),
              children: [
                jsx('span', { className: 'sq-twist', 'aria-hidden': true, children: schemaFolded ? '▸' : '▾' }),
                jsx('span', { className: 'sq-schemaname', children: one.name }),
                jsx('span', { className: 'sq-cols', children: String(one.objects?.length ?? 0) }),
                one.file !== undefined && one.file !== ''
                  ? jsx('span', { className: 'sq-file', title: one.file, children: one.file })
                  : null,
              ],
            }),
            one.error !== undefined
              ? jsx('span', { className: 'sq-err', children: one.error })
              : null,
            schemaFolded ? null : (one.objects ?? []).map((object) => {
              const key = `${one.name}.${object.name}`
              const objectFolded = folded.objects.has(key)
              return jsxs('div', {
                className: `sq-obj${objectFolded ? ' is-folded' : ''}`,
                children: [
                  jsxs('button', {
                    type: 'button',
                    className: 'sq-objhead',
                    'data-act': 'fold-object',
                    'data-object': key,
                    'aria-expanded': !objectFolded,
                    onClick: () => toggleFold('objects', key),
                    children: [
                      jsx('span', { className: 'sq-twist', 'aria-hidden': true, children: objectFolded ? '▸' : '▾' }),
                      jsx('span', { className: 'sq-icon', 'aria-hidden': true, children: object.kind === 'view' ? '◫' : object.kind === 'foreign' ? '⇥' : '▤' }),
                      jsx('span', { className: 'sq-objname', title: key, children: object.name }),
                      jsx('span', { className: 'sq-kind', children: object.kind === 'view' ? (zh ? '视图' : 'view') : (zh ? '表' : 'table') }),
                      jsx('span', { className: 'sq-cols', title: zh ? '列数' : 'columns', children: String(object.columns?.length ?? 0) }),
                    ],
                  }),
                  objectFolded ? null : jsx('div', { className: 'sq-collist', children: (object.columns ?? []).map((column) => jsxs('div', {
                    className: 'sq-col',
                    children: [
                      jsx('span', { className: 'sq-colname', title: column.name, children: column.name }),
                      jsx('span', { className: 'sq-coltype', title: column.type, children: column.type }),
                      column.primaryKey ? jsx('span', { className: 'sq-pk', title: zh ? '主键' : 'primary key', children: 'PK' }) : null,
                      column.nullable === false ? jsx('span', { className: 'sq-nn', title: zh ? '非空' : 'not null', children: 'NN' }) : null,
                    ],
                  }, `${key}.${column.name}`)) }),
                ],
              }, key)
            }),
          ],
        }, one.name)
      }) })
      : null,

    connections.length > 0
      ? jsxs('div', { className: 'sq-editor', children: [
          // Which database this box talks to, and the way out of it. Without the name, a card
          // with several connections gives no clue which one a statement will run against —
          // and running `delete` against the wrong database is a bad surprise.
          jsxs('div', { className: 'sq-editorhead', children: [
            jsx('span', { className: 'sq-target', title: active, children: connection?.name ?? active }),
            jsx('span', { className: 'sq-driver', children: drivers.find((one) => one.id === connection?.driver)?.labelZh
              ?? connection?.driver ?? '' }),
            jsxs('span', { className: 'sq-editorright', children: [
              readOnly
                ? jsx('span', { className: 'sq-chip', children: zh ? '只读' : 'read-only' })
                : jsx('span', { className: 'sq-chip is-write', children: zh ? '可写' : 'writable' }),
              jsx('button', {
                type: 'button',
                className: 'sq-mini',
                'data-act': 'disconnect',
                title: zh ? '回到连接界面（连接本身不会被删除）' : 'back to the connect form (the connection is kept)',
                onClick: () => { setDraft(null); setOutcome(null); setResult(null); setError(null) },
                children: zh ? '断开' : 'disconnect',
              }),
            ] }),
          ] }),
          jsx('textarea', {
            className: 'sq-sql',
            ref: boxRef,
            value: sql,
            spellCheck: false,
            rows: 3,
            placeholder: zh ? 'select * from users limit 20' : 'select * from users limit 20',
            'aria-label': zh ? 'SQL 语句' : 'SQL statement',
            // A listbox nobody is told about is a listbox only sighted users have.
            'aria-autocomplete': 'list',
            'aria-expanded': suggest !== null,
            'aria-controls': suggest === null ? undefined : 'sq-suggest',
            onChange: (event) => {
              setSql(event.target.value)
              refreshSuggest(event.target.value, caretOf(event.target, event.target.value))
            },
            onKeyDown: (event) => {
              // Ctrl/Cmd+Enter runs: the one keyboard habit every SQL client shares.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                setSuggest(null)
                run()
                return
              }
              // Ctrl+Space asks for the list even on an empty word — how anyone who has used a
              // completion UI before expects to open one.
              if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                const caret = caretOf(event.target, sql)
                const here = wordAt(sql, caret)
                const items = completionsFor(vocabulary, here.word)
                setSuggest(items.length === 0 ? null : { items, index: 0, ...here })
                return
              }
              if (suggest === null) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setSuggest((current) => (current === null ? null : {
                  ...current,
                  index: (current.index + step + current.items.length) % current.items.length,
                }))
                return
              }
              if (event.key === 'Escape') {
                setSuggest(null)
                return
              }
              // Tab and Enter accept. Enter only while the list is open, so Enter by itself
              // still inserts a newline — this box is for writing SQL, not for one line of it.
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault()
                acceptSuggest(suggest.items[suggest.index])
              }
            },
            // Clicking or arrowing inside the box moves the caret, and the list belongs to the
            // word the caret is in.
            onKeyUp: (event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                refreshSuggest(sql, caretOf(event.target, sql))
              }
            },
            onClick: (event) => refreshSuggest(sql, caretOf(event.target, sql)),
            onBlur: () => setSuggest(null),
          }),
          // ── the completion list ──
          //
          // Under the box and over the run row, only as tall as its candidates: this card sits
          // in a grid cell, so a dropdown that pushed the layout around would move the Run
          // button out from under the pointer mid-keystroke.
          suggest === null
            ? null
            : jsxs('div', {
                className: 'sq-suggest',
                id: 'sq-suggest',
                role: 'listbox',
                'aria-label': zh ? '补全建议' : 'completions',
                children: [
                  ...suggest.items.map((item, index) => jsx('button', {
                    type: 'button',
                    role: 'option',
                    'aria-selected': index === suggest.index,
                    className: `sq-suggest-item${index === suggest.index ? ' is-active' : ''}`,
                    'data-act': 'complete',
                    'data-value': item,
                    // mousedown, not click: the textarea's blur fires first and would close the
                    // list before a click ever landed.
                    onMouseDown: (event) => {
                      event.preventDefault()
                      acceptSuggest(item)
                    },
                    children: item,
                  }, `s${index}-${item}`)),
                  jsx('span', {
                    className: 'sq-suggest-hint',
                    children: zh ? 'Tab 补全 · Esc 关闭' : 'Tab completes · Esc closes',
                  }),
                ],
              }),
          jsxs('div', { className: 'sq-runrow', children: [
            // ── the write switch, then the RUN button, then the hints ──
            //
            // The button comes BEFORE the explanation, because it is the thing people are
            // looking for: the row used to open with a lock chip or a checkbox, push the
            // button to the far right, and put "Ctrl+Enter 执行" in between.
            readOnly
              ? jsx('span', {
                className: 'sq-lock',
                'data-enforced-by': engineReadOnly ? 'engine' : 'plugin',
                title: engineReadOnly
                  ? (zh ? '在连接设置里关掉「只读」才能写' : 'turn off read-only in the connection to write')
                  : (zh ? 'SQL Server 没有只读事务：这条连接由插件拦截写语句，而不是服务器拒绝' : 'SQL Server has no read-only transaction: this plugin blocks writes, the server does not'),
                children: engineReadOnly
                  ? (zh ? '🔒 只读 · 服务器保证' : '🔒 read-only · server')
                  : (zh ? '🔒 只读 · 插件拦截' : '🔒 read-only · plugin'),
              })
              : jsxs('label', { className: 'sq-write', children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: allowWrite,
                    onChange: (event) => setAllowWrite(event.target.checked),
                  }),
                  zh ? '允许写' : 'allow write',
                ] }),
            jsx('button', {
              type: 'button',
              className: 'sq-run',
              'data-act': 'run',
              disabled: running || sql.trim() === '',
              // A write without the tick is refused by the host, so the button says what will
              // happen instead of letting the refusal be the teacher.
              title: !readOnly && allowWrite ? (zh ? '会执行写操作' : 'this may write') : undefined,
              onClick: run,
              children: running ? (zh ? '执行中…' : 'running…') : (zh ? '执行' : 'Run'),
            }),
            jsx('span', { className: 'sq-hint', children: zh ? 'Ctrl+Enter' : 'Ctrl+Enter' }),
          ] }),
        ] })
      : null,

    result === null ? null : jsx(SqlResult, { result, zh }),
    // ── a failure, in the SERVER's own words ──
    //
    // Not a one-line summary: the message, the code, the DETAIL and any HINT the server
    // offered. A card that says only "执行失败" makes people guess, and the guess is usually
    // about their SQL when the real answer is sitting in the DETAIL line.
    queryError !== null && queryError !== undefined
      ? jsxs('div', { className: 'sq-failure', role: 'alert', children: [
          jsxs('div', { className: 'sq-failhead', children: [
            jsx('span', { className: 'sq-failtitle', children: zh ? '执行失败' : 'statement failed' }),
            queryError.code === undefined || queryError.code === ''
              ? null
              : jsx('span', { className: 'sq-failcode', children: String(queryError.code) }),
          ] }),
          // `pre` and not `span`: a server message has newlines in it, and collapsing them
          // into one paragraph is how a stack-like error becomes unreadable.
          jsx('pre', { className: 'sq-failtext', children: queryError.message }),
          queryError.detail === undefined || queryError.detail === ''
            ? null
            : jsxs('div', { className: 'sq-failrow', children: [
                jsx('span', { className: 'sq-faillabel', children: 'DETAIL' }),
                jsx('span', { children: queryError.detail }),
              ] }),
          queryError.hint === undefined || queryError.hint === ''
            ? null
            : jsxs('div', { className: 'sq-failrow', children: [
                jsx('span', { className: 'sq-faillabel', children: 'HINT' }),
                jsx('span', { children: queryError.hint }),
              ] }),
          queryError.position === undefined || queryError.position === ''
            ? null
            : jsxs('div', { className: 'sq-failrow', children: [
                jsx('span', { className: 'sq-faillabel', children: zh ? '位置' : 'POSITION' }),
                jsx('span', { children: String(queryError.position) }),
              ] }),
        ] })
      : null,
  ] })
}

/**
 * The fields ONE driver needs, from the list the host exports.
 *
 * Extracted so the connect panel and the connection editor cannot drift apart: there is
 * one description of what PostgreSQL asks for, and both render it.
 */
function driverFields(driverId, drivers, zh) {
  const spec = drivers.find((one) => one.id === driverId)
  return (spec?.fields ?? [{ key: 'file', label: '数据库文件', labelEn: 'FILE', kind: 'text' }]).map((field) => ({
    kind: field.kind === 'number' ? 'number' : field.kind === 'toggle' ? 'toggle' : 'text',
    key: field.key,
    label: zh ? field.label : (field.labelEn ?? field.label),
    placeholder: field.placeholder,
    min: field.kind === 'number' ? 1 : undefined,
    max: field.kind === 'number' ? 65_535 : undefined,
    hint: field.key === 'passwordRef'
      ? (zh ? '只写凭据的名字，值从 DSH 凭据库读，不存进设置文件。' : 'The credential NAME only; the value stays in the credential store.')
      : undefined,
  }))
}

/** Which fields a driver's connection needs — from the ONE list the host exports. */
function createSqlPanel() {
  const CSS_ID = 'dsh-hud/sql.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.sq-root{display:flex;flex-direction:column;gap:8px;min-width:0;font-variant-numeric:tabular-nums}',
      '.sq-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}',
      '.sq-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-sub{margin-left:2px;color:var(--dsw-alias-label-caption,#81858c);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42%}',
      '.sq-right{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none}',
      '.sq-ghost{padding:0 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-ghost:hover{border-color:var(--hud-line-2,rgba(0,0,0,.18))}',
      '.sq-ghost:disabled{opacity:.4;cursor:default}',
      '.sq-picks{display:inline-flex;gap:4px;flex-wrap:wrap}',
      // NOT a native `<select>`: the suite forbids one in this panel (and it is right
      // to — a native dropdown cannot be themed to match the card, and it was caught
      // by exactly that assertion).
      '.sq-pick{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-pick.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.sq-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);word-break:break-word}',
      '.sq-note.is-warn{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // The SSH half: the mode switch, the command box, and the output block.
      '.sq-modes{display:inline-flex;gap:0;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;overflow:hidden}',
      '.sq-mode{padding:0 9px;border:0;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-mode.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.sq-sshrun{display:flex;flex-direction:column;gap:6px}',
      '.sq-sshcmd{flex:1 1 auto;min-width:0;padding:4px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:7px;background:transparent;font-family:inherit;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-sshpresets{display:flex;flex-wrap:wrap;gap:5px}',
      '.sq-sshout{display:flex;flex-direction:column;gap:4px}',
      '.sq-sshmeta{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-sshmeta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-exit{font-variant-numeric:tabular-nums}',
      '.sq-exit.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sq-exit.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-sshstdout,.sq-sshstderr{margin:0;padding:7px 9px;border-radius:7px;max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;scrollbar-width:thin}',
      '.sq-sshstdout{background:var(--hud-tile,rgba(0,0,0,.035));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-sshstderr{background:rgba(220,38,38,.06);color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      // The live terminal: a real grid, so the styling is monospace and nothing else.
      '.sq-term{display:flex;flex-direction:column;gap:5px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;padding:6px;background:var(--hud-tile,rgba(0,0,0,.02))}',
      '.sq-termbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.sq-termdot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16a34a);flex:0 0 auto}',
      '.sq-termdot.is-off{background:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-termtarget{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-termspace{flex:1 1 auto}',
      '.sq-termkey{padding:0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}',
      '.sq-termscroll{margin:0;max-height:120px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:15px;white-space:pre;color:var(--dsw-alias-label-caption,#81858c);scrollbar-width:thin}',
      '.sq-termscreen{margin:0;padding:6px 7px;border-radius:6px;background:var(--hud-term-bg,rgba(0,0,0,.055));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:15px;white-space:pre;overflow-x:auto;cursor:text;scrollbar-width:thin}',
      '.sq-termrow{min-height:15px}',
      '.sq-termrun.is-bold{font-weight:700}',
      '.sq-termrun.is-dim{opacity:.65}',
      '.sq-termrun.fg-black{color:#1f2328}.sq-termrun.fg-red{color:#c02b2b}.sq-termrun.fg-green{color:#137a3a}',
      '.sq-termrun.fg-yellow{color:#8a6100}.sq-termrun.fg-blue{color:#2b5fd9}.sq-termrun.fg-magenta{color:#9b2fa8}',
      '.sq-termrun.fg-cyan{color:#0d7b86}.sq-termrun.fg-white{color:#6b7280}',
      '.sq-termrun.fg-black-bright{color:#4b5563}.sq-termrun.fg-red-bright{color:#e5484d}.sq-termrun.fg-green-bright{color:#22a06b}',
      '.sq-termrun.fg-yellow-bright{color:#b7791f}.sq-termrun.fg-blue-bright{color:#4a7dff}.sq-termrun.fg-magenta-bright{color:#c05bd6}',
      '.sq-termrun.fg-cyan-bright{color:#12a3b0}.sq-termrun.fg-white-bright{color:#9aa1ab}',
      '.sq-termrun.bg-black{background:rgba(31,35,40,.85);color:#f6f7f9}.sq-termrun.bg-red{background:rgba(192,43,43,.14)}',
      '.sq-termrun.bg-green{background:rgba(19,122,58,.14)}.sq-termrun.bg-yellow{background:rgba(138,97,0,.16)}',
      '.sq-termrun.bg-blue{background:rgba(43,95,217,.14)}.sq-termrun.bg-magenta{background:rgba(155,47,168,.14)}',
      '.sq-termrun.bg-cyan{background:rgba(13,123,134,.14)}.sq-termrun.bg-white{background:rgba(0,0,0,.07)}',
      '.sq-termline{display:flex;gap:5px;align-items:center}',
      '.sq-terminput{flex:1 1 auto;min-width:0;padding:4px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:7px;background:transparent;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-err{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#dc2626);word-break:break-word}',
      '.sq-code{display:block;margin-top:4px;padding:7px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:15px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#61666b)}',
      // ── connecting: engine → parameters → connect ──
      '.sq-connect{display:flex;flex-direction:column;gap:9px;padding:9px 10px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}',
      '.sq-connect-head{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-dtypes{display:flex;flex-wrap:wrap;gap:6px}',
      '.sq-dtype{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:inherit;cursor:pointer}',
      '.sq-dtype.is-on{border-color:var(--dsw-alias-brand-primary,#3964fe);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-dtype:disabled{opacity:.4;cursor:default}',
      '.sq-dtype em{font-style:normal;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.75}',
      // The parameters change with the engine, so they are laid out as a grid that can
      // hold four short fields in two rows on a narrow card.
      '.sq-dfields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px 9px}',
      '.sq-dfield{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.sq-dlabel{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-dfield input{box-sizing:border-box;width:100%;min-width:0;padding:4px 7px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);font-family:inherit;font-size:11.5px;line-height:17px;color:inherit}',
      '.sq-dfield.is-toggle{flex-direction:row;align-items:center;gap:7px}',
      '.sq-dfield.is-toggle input{width:auto}',
      '.sq-dhint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);word-break:break-word}',
      '.sq-dorun{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      // The accent is written out rather than taken from --dsw-alias-brand-primary: that token is
      // a BORDER/text colour in this design system, and using it as a fill produced a grey pill
      // with grey text. The value below is the same one the shell uses for its own filled
      // controls (the pressed ⚙, the layout thumb).
      '.sq-connect-go{padding:3px 14px;border:1px solid transparent;border-radius:999px;background:#3964fe;font-family:inherit;font-size:11.5px;line-height:18px;font-weight:500;color:#fff;cursor:pointer}',
      '.sq-connect-go:hover:not(:disabled){background:#2f55e0}',
      '.sq-connect-go:disabled{opacity:.5;cursor:default}',
      '.sq-connect-cancel{padding:3px 10px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:18px;color:inherit;cursor:pointer}',
      '.sq-outcome{font-size:11px;line-height:16px;word-break:break-word}',
      '.sq-outcome.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sq-outcome.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // ── the tree ──
      '.sq-tree{display:flex;flex-direction:column;gap:5px;max-height:180px;overflow-y:auto;scrollbar-width:thin}',
      '.sq-schema{display:flex;flex-direction:column;gap:2px}',
      '.sq-schemahead{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-file{font-weight:400;letter-spacing:0;text-transform:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%;opacity:.8}',
      '.sq-obj{display:flex;flex-direction:column}',
      '.sq-objhead{display:flex;align-items:center;gap:6px;width:100%;padding:1px 4px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary,#0f1115);text-align:left}',
      '.sq-icon{width:12px;flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-objname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-kind{margin-left:auto;flex:none;font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-cols{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-collist{display:flex;flex-direction:column;gap:1px;padding:1px 0 3px 18px}',
      '.sq-col{display:flex;align-items:baseline;gap:6px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-colname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-coltype{margin-left:auto;font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.sq-pk,.sq-nn{flex:none;padding:0 4px;border-radius:3px;font-size:9px;line-height:13px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-pk{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      // ── the editor ──
      // ── the connected view: which database, and the way out ──
      '.sq-editorhead{display:flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;line-height:17px}',
      // ── the tree: two buttons, not two divs ──
      //
      // Both headers were plain divs with text in them. They are buttons now so the fold is
      // reachable by keyboard and announceable (aria-expanded), and so a click lands on a real
      // control — an earlier version put the handler on the row and nothing reached it.
      '.sq-schemahead,.sq-objhead{display:flex;align-items:center;gap:6px;width:100%;padding:2px 4px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:inherit;text-align:left;cursor:pointer}',
      '.sq-schemahead:hover,.sq-objhead:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
      '.sq-schemahead:focus-visible,.sq-objhead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
      '.sq-twist{flex:none;width:9px;font-size:9px;line-height:1;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-obj.is-folded .sq-objhead,.sq-schema.is-folded .sq-schemahead{opacity:.82}',
      // ── the completer ──
      //
      // In the flow, under the box: a positioned popup would be clipped by the card, and this
      // card is a grid cell with `overflow` on its body.
      '.sq-suggest{display:flex;flex-direction:column;gap:1px;margin-top:-4px;padding:4px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 6px 16px rgba(0,0,0,.10);max-height:168px;overflow-y:auto}',
      '.sq-suggest-item{display:block;width:100%;padding:2px 7px;border:0;border-radius:5px;background:transparent;font-family:var(--hud-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:inherit;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sq-suggest-item.is-active{background:rgba(57,100,254,.14);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-suggest-hint{padding:1px 7px 0;font-size:9.5px;letter-spacing:.03em;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-target{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-driver{flex:none;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-editorright{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none}',
      '.sq-mini{padding:1px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-mini:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22));color:var(--dsw-alias-label-primary,#0f1115)}',
      // The RUN button leads the row: it is what people look for first. The write switch and
      // the keyboard hint come after it.
      '.sq-run{padding:3px 16px;border:1px solid transparent;border-radius:999px;background:#3964fe;font-family:inherit;font-size:11.5px;line-height:18px;font-weight:500;color:#fff;cursor:pointer}',
      '.sq-run:hover:not(:disabled){background:#2f55e0}',
      '.sq-run:disabled{opacity:.45;cursor:default}',
      '.sq-kbd{font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── the failure block ──
      //
      // A server message is a paragraph with newlines in it, so it is rendered in a `pre` that
      // WRAPS: a horizontal scrollbar for an error message hides the end of the sentence, which
      // is usually the useful part.
      '.sq-failure{display:flex;flex-direction:column;gap:5px;padding:8px 9px;border:1px solid rgba(220,38,38,.35);border-radius:8px;background:rgba(220,38,38,.06)}',
      '.sq-failhead{display:flex;align-items:center;gap:7px;font-size:11.5px;line-height:16px}',
      '.sq-failtitle{font-weight:600;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-failcode{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(220,38,38,.14);color:var(--dsw-alias-state-error-primary,#dc2626);font-variant-numeric:tabular-nums}',
      '.sq-failtext{margin:0;font-family:inherit;font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-failrow{display:flex;gap:7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-faillabel{flex:none;font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c);padding-top:1px}',
      '.sq-restitle.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sq-affected{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-editor{display:flex;flex-direction:column;gap:5px}',
      '.sq-sql{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary,#0f1115);resize:vertical}',
      '.sq-sql:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-runrow{display:flex;align-items:center;gap:8px;font-size:10.5px}',
      '.sq-write{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-lock{color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-spacer{margin-left:auto}',
      '.sq-hint{color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-run{padding:0 12px;border:1px solid rgba(57,100,254,.35);border-radius:999px;background:rgba(57,100,254,.10);font-family:inherit;font-size:11px;line-height:19px;font-weight:600;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.sq-run:disabled{opacity:.45;cursor:default}',
      // ── the result ──
      '.sq-result{display:flex;flex-direction:column;gap:5px}',
      '.sq-reshead{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-restitle{font-weight:600;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.sq-ms{margin-left:auto}',
      '.sq-chip{padding:0 6px;border-radius:999px;border:1px solid var(--hud-line,rgba(0,0,0,.1));font-size:9.5px;line-height:15px}',
      '.sq-chip.is-write{border-color:rgba(245,158,11,.45);color:var(--dsw-alias-state-warn-primary,#b45309);background:rgba(245,158,11,.12)}',
      '.sq-notice{font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-scroll{max-height:220px;overflow:auto;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:7px;scrollbar-width:thin}',
      '.sq-table{border-collapse:collapse;width:100%;font-size:11px;line-height:16px}',
      '.sq-table th{position:sticky;top:0;padding:3px 8px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.1));background:var(--hud-tile,var(--dsw-alias-bg-layer-1,#fff));text-align:left;font-weight:600;white-space:nowrap;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-table td{padding:2px 8px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.05));white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-table tr:last-child td{border-bottom:0}',
      '.sq-null{color:var(--dsw-alias-label-caption,#81858c);font-style:italic}',
      '.sq-empty{padding:8px;text-align:center;color:var(--dsw-alias-label-caption,#81858c)}',
      // The connection manager: one row per stored connection, each with its own actions.
      //
      // It used to be a row of chips followed by a row of ✕ buttons — which meant the third
      // ✕ belonged to the third chip only by counting. A row cannot be miscounted.
      '.sq-conns{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}',
      '.sq-connrow{display:flex;align-items:center;gap:7px;padding:4px 6px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:8px;min-width:0;flex-wrap:wrap}',
      '.sq-connrow.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.07)}',
      '.sq-connrow.is-confirming{border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.05)}',
      '.sq-connpick{display:flex;flex-direction:column;align-items:flex-start;gap:1px;flex:1 1 auto;min-width:0;padding:1px 2px;border:0;background:transparent;font-family:inherit;text-align:left;cursor:pointer}',
      '.sq-connname{font-size:11.5px;font-weight:600;line-height:15px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.sq-connrow.is-on .sq-connname{color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-conntarget{font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.sq-connmeta{display:inline-flex;align-items:center;gap:4px;flex:none;flex-wrap:wrap;justify-content:flex-end}',
      '.sq-tag{padding:0 5px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;font-style:normal;font-size:9.5px;line-height:15px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}',
      '.sq-tag.is-write{border-color:rgba(217,161,59,.45);color:#a1770f}',
      '.sq-tag.is-warn{border-color:rgba(220,38,38,.4);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-connactions,.sq-connconfirm{display:inline-flex;align-items:center;gap:4px;flex:none}',
      // The confirmation takes its OWN line: it carries a question, a checkbox and two
      // buttons, and sharing a line with the connection's name is how the last button ends
      // up clipped at the card's edge — measured in a 480px harness, not guessed.
      '.sq-connconfirm{flex:1 1 100%;flex-wrap:wrap;justify-content:flex-end;padding-top:2px}',
      '.sq-connbtn{padding:0 7px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap}',
      '.sq-connbtn:hover:not(:disabled){border-color:var(--hud-line-2,rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-connbtn:disabled{opacity:.4;cursor:default}',
      '.sq-connbtn.is-danger:hover:not(:disabled){border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-connbtn.is-add{border-style:dashed}',
      '.sq-connsrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.sq-dfield.is-tight{flex-direction:row;align-items:center;gap:5px}',
      '.sq-dfield.is-tight input{width:auto;min-width:0;max-width:110px}',
      '.sq-editor{display:flex;flex-direction:column;gap:9px;margin-bottom:6px;padding:9px 10px;border:1px solid rgba(57,100,254,.3);border-radius:8px;background:rgba(57,100,254,.04)}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  return {
    id: 'sql',
    // 25: packed THIRD — after 用量限额 (20) and before 快递 (30).
    //
    // The order is the geometry, and this one is load-bearing: the packer fills the topmost
    // hole first, so if this card were packed after 快递 it would land at the top of column 3
    // and 快递 would take the middle hole instead. Being third is what puts 数据库 in the right
    // column and leaves the middle free for the stack under 用量限额.
    order: 25,
    label: { zh: '数据库', en: 'SQL' },
    // One column: the third column of the shipped layout. The schema tree and the result grid
    // stack instead of sitting side by side — and ⚙ can widen it to two columns for anyone who
    // wants them beside each other.
    span: 1,
    // ON by default: it is part of the shipped layout, and it opens with the connection form
    // rather than with a paragraph telling you to find the gear.
    defaultOn: true,
    /**
     * Five rows — the full height of the arrangement.
     *
     * A connection form, a schema tree and a result grid need the room, and it is also
     * arithmetic: the middle column is 4 + 3 + 3, so this card has to be 10 for the three
     * columns to end on the same row.
     */
    defaultRows: 5,
    Component: SqlCard,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/todo/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › todo panel — browser half.
//
// A title-bar entry on the RIGHT of the head row (next to the ⚙), carrying how
// many things are open and what is next, plus a click-open list.
//
// ── why the notifier lives here and not in the host ────────────────────────
//
// The host has no clock the user can hear. It publishes the SCHEDULE — `leads`
// (60/30/5 minutes before `dueAt`) and `digestAt` (16:30 by default) — and this
// half fires them, because this half is the one with `Notification`, the user's
// local clock, and their permission. The split is the same one every panel here
// uses: host owns data, browser owns the user's moment.
//
// The honest limitation, stated in the UI as well: a notification needs THIS
// PAGE to be open. Nothing can fire while DeepSeek Harness is closed, because
// nothing of ours is running then.
//
// ── dedupe ─────────────────────────────────────────────────────────────────
//
// Every firing is recorded in `localStorage` as `<id>@<lead>` (and `<day>` for
// the digest), so a page refresh does not re-announce the meeting that starts in
// five minutes. Entries older than a week are pruned on write.

const TD_STORAGE_KEY = 'dsh-hud:todo:notified'
const TD_TICK_MS = 30_000
const TD_FALLBACK_REFRESH_MS = 300_000
const TD_MIN_REFRESH_MS = 30_000
const TD_MAX_REFRESH_MS = 3_600_000
/** A fired lead stays on the line this long before it stops being news. */
const TD_ALERT_MS = 10 * 60_000

/** Read the fired-notification ledger, pruning anything older than a week. */
function tdReadLedger(now = Date.now()) {
  try {
    const parsed = JSON.parse(localStorage.getItem(TD_STORAGE_KEY) ?? '{}')
    const fresh = {}
    for (const [key, at] of Object.entries(parsed ?? {})) {
      if (typeof at === 'number' && now - at < 7 * 86_400_000) fresh[key] = at
    }
    return fresh
  } catch {
    return {}
  }
}

function tdWriteLedger(ledger) {
  try {
    localStorage.setItem(TD_STORAGE_KEY, JSON.stringify(ledger))
  } catch {
    /* storage disabled: notifications are best-effort anyway */
  }
}

/**
 * Which leads are due to fire right now.
 *
 * `leads` are minutes BEFORE the due moment; a lead fires when the clock is at
 * or past `dueAt - lead` but the item is not yet due — a 5-minute warning that
 * arrives after the meeting started is not a warning.
 *
 * Exported for the test harness, because this is the part that must be exactly
 * right and is invisible when it is wrong.
 */
function tdDueLeads(item, leads, now, fired) {
  const dueAt = typeof item?.dueAt === 'number' ? item.dueAt : undefined
  if (dueAt === undefined || dueAt < now) return []
  // ONLY the closest passed lead fires:
  //   T-60 passed={60}         → 60
  //   T-30 passed={60,30}      → 30      (the 60 fired an hour ago)
  //   T-5  passed={60,30,5}    → 5
  //   T-31 passed={60}         → 60      (late, but it is the current news)
  //   added at T-20            → 30      (one notification, not three)
  // Firing every passed lead would mean three at once for anything added or
  // opened late, which is how people turn notifications off. A stale lead is
  // skipped: nobody needs "in an hour" about something starting in five minutes.
  const current = leads.filter((lead) => now >= dueAt - lead * 60_000).sort((a, b) => a - b)[0]
  if (current === undefined) return []
  if (fired[`${item.id}@${current}`] !== undefined) return []
  return [current]
}

/** Minutes until a moment, rounded, for "还有 25 分钟". */
function tdMinutesUntil(at, now) {
  return Math.round((at - now) / 60_000)
}

/** `今天 14:30` / `明天 09:00` / `10-05 09:00` — as short as it can be. */
function tdWhen(at, now, zh) {
  const pad = (value) => String(value).padStart(2, '0')
  const at2 = new Date(at)
  const clock = `${pad(at2.getHours())}:${pad(at2.getMinutes())}`
  const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const delta = Math.round((day(at2) - day(new Date(now))) / 86_400_000)
  if (delta === 0) return clock
  if (delta === -1) return zh ? `昨天 ${clock}` : `yesterday ${clock}`
  if (delta === 1) return zh ? `明天 ${clock}` : `tomorrow ${clock}`
  if (delta < 0 && delta > -8) return zh ? `${-delta} 天前` : `${-delta}d ago`
  return `${pad(at2.getMonth() + 1)}-${pad(at2.getDate())} ${clock}`
}

/** The signed lead label: `30 分钟后` / `已过 5 分钟`. */
function tdLeadLabel(minutes, zh) {
  if (minutes >= 0) return zh ? `${minutes} 分钟后` : `in ${minutes}m`
  return zh ? `已过 ${-minutes} 分钟` : `${-minutes}m ago`
}

/**
 * Derive the colour scheme from the surface we actually paint with.
 *
 * Native widgets that cannot be styled — the `<input type="time">` picker, the
 * scrollbar of a scrolling list — are painted from `color-scheme`. The app
 * implements dark mode with its own tokens and marks it on `<body>`, so relying
 * on the platform's guess is how a popup ends up light under light text. Asking
 * the surface token directly is deterministic, and it follows a third-party
 * palette override too.
 */
function tdSurfaceScheme() {
  try {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;color:var(--dsw-alias-bg-layer-1,#ffffff)'
    document.body.appendChild(probe)
    const painted = getComputedStyle(probe).color
    probe.remove()
    const parts = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(painted)
    if (parts === null) return 'light'
    const luminance = 0.2126 * Number(parts[1]) + 0.7152 * Number(parts[2]) + 0.0722 * Number(parts[3])
    return luminance < 128 ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * A themed dropdown.
 *
 * Deliberately not a `<select>`: see the `.td-menu` note above. It behaves like
 * one where it matters — a button that opens a list of options, Escape and a
 * click outside to close, arrows and Enter to choose.
 */
function TdSelect(props) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const ref = React.useRef(null)
  const options = Array.isArray(props.options) ? props.options : []
  const current = options.find((option) => option.value === props.value)
  hud.useDismiss(ref, open, React.useCallback(() => setOpen(false), []))
  const choose = (value) => {
    setOpen(false)
    props.onChange?.(value)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(Math.max(0, options.findIndex((option) => option.value === props.value)))
        return
      }
      if (event.key === 'ArrowDown') setActive((index) => Math.min(options.length - 1, index + 1))
      else if (event.key === 'ArrowUp') setActive((index) => Math.max(0, index - 1))
      else if (active >= 0 && active < options.length) choose(options[active].value)
    }
  }
  return jsxs('span', { className: 'td-drop', ref, children: [
    jsxs('button', {
      type: 'button',
      className: 'td-sel',
      'aria-haspopup': 'listbox',
      'aria-expanded': open ? 'true' : 'false',
      disabled: props.disabled === true,
      title: props.title,
      onClick: () => setOpen((value) => !value),
      onKeyDown,
      children: [
        jsx('span', { children: current?.label ?? props.placeholder ?? '' }),
        jsx('span', { className: 'td-caret', 'aria-hidden': true, children: '▾' }),
      ],
    }),
    open
      ? jsx('span', { className: 'td-menu', role: 'listbox', children: options.map((option, index) => jsx('button', {
          type: 'button',
          role: 'option',
          'aria-selected': option.value === props.value ? 'true' : 'false',
          className: `td-opt${option.value === props.value ? ' is-on' : ''}${index === active ? ' is-active' : ''}`,
          onClick: () => choose(option.value),
          children: option.label,
        }, option.value)) })
      : null,
  ] })
}

function createTodoPanel() {
  const CSS_ID = 'dsh-hud/todo.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      // ── the title-bar entry ───────────────────────────────────────────────
      '.td-root{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.td-btn{display:inline-flex;align-items:center;gap:6px;min-width:0;padding:0 6px;border:1px solid transparent;border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:18px;color:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}',
      '.td-btn:hover{border-color:var(--hud-line,rgba(0,0,0,.1));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-btn[aria-expanded="true"]{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
      '.td-mark{flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
      // The count chip: the one number this widget exists to show.
      '.td-count{font-style:normal;min-width:16px;padding:0 5px;border-radius:999px;background:rgba(57,100,254,.14);font-size:10px;line-height:15px;text-align:center;color:var(--dsw-alias-state-business-primary,#3964fe);font-variant-numeric:tabular-nums}',
      '.td-count.is-overdue{background:rgba(220,38,38,.14);color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}',
      '.td-next{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-zero{color:var(--dsw-alias-label-caption,#81858c)}',
      // A fired reminder, on the line, until it stops being news.
      '.td-alert{display:inline-flex;align-items:center;gap:5px;max-width:260px;padding:0 9px;border:1px solid rgba(245,158,11,.45);border-radius:999px;background:rgba(245,158,11,.12);font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#b45309);cursor:pointer}',
      '.td-alert b{font-weight:600}',
      '.td-alert span{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // ── the popover ───────────────────────────────────────────────────────
      '.td-pop{position:absolute;top:calc(100% + 7px);right:0;z-index:9;box-sizing:border-box;width:min(440px,calc(100vw - 28px));max-height:min(66vh,520px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:12px;background:var(--hud-pop,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 3px 10px rgba(15,17,21,.07),0 24px 52px -28px rgba(15,17,21,.5);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);text-align:left;white-space:normal}',
      '.td-pop-head{display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.08))}',
      // The timer reads as a strip above the list: it is set going and then ignored,
          // so it must be legible at a glance and never compete with the items.
            '.td-pomo{display:flex;flex-direction:column;gap:4px;padding:7px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
            '.td-pomo-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
            '.td-pomo-phase{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
            '.td-pomo.is-running .td-pomo-phase{color:var(--dsw-alias-state-business-primary,#3964fe)}',
            '.td-pomo.is-break .td-pomo-phase{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
          // Tabular figures: a countdown that shifts width every second is unreadable.
            '.td-pomo-time{font-size:17px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#0f1115)}',
            '.td-pomo.is-running .td-pomo-time{color:var(--dsw-alias-state-business-primary,#3964fe)}',
            '.td-pomo-total,.td-pomo-done{font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
            '.td-pomo-done{font-variant-numeric:tabular-nums}',
      '.td-pop-title{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-pop-head .td-spacer{margin-left:auto}',
      '.td-ghost{padding:0 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      '.td-ghost:hover{border-color:var(--hud-line-2,rgba(0,0,0,.18));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
      '.td-ghost[aria-pressed="true"]{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-ghost:disabled{opacity:.4;cursor:default}',
      // add row
      '.td-add{display:flex;align-items:center;gap:6px}',
      '.td-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:3px 9px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:transparent;font-family:inherit;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-time{flex:none;box-sizing:border-box;padding:3px 6px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
      // groups
      '.td-group{display:flex;flex-direction:column;gap:3px}',
      '.td-group-head{display:flex;align-items:baseline;gap:7px;padding-top:2px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-group-head em{font-style:normal;font-weight:600;letter-spacing:0;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-row{display:flex;align-items:flex-start;gap:7px;padding:3px 5px;border-radius:8px}',
      '.td-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
      '.td-check{flex:none;width:14px;height:14px;margin-top:2px;padding:0;border:1px solid var(--hud-line-2,rgba(0,0,0,.2));border-radius:4px;background:transparent;font-family:inherit;font-size:10px;line-height:12px;color:transparent;cursor:pointer}',
      '.td-check:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-check[aria-pressed="true"]{border-color:var(--dsw-alias-state-success-primary,#1a7f52);background:rgba(26,127,82,.14);color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.td-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.td-title{color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.td-row.is-done .td-title{color:var(--dsw-alias-label-caption,#81858c);text-decoration:line-through}',
      '.td-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-due{font-variant-numeric:tabular-nums}',
      '.td-due.is-overdue{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}',
      '.td-due.is-soon{color:var(--dsw-alias-state-warn-primary,#b45309);font-weight:600}',
      '.td-src{padding:0 6px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;font-size:9.5px;line-height:14px}',
      '.td-approx{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.td-note{color:var(--dsw-alias-label-caption,#81858c);word-break:break-word}',
      '.td-acts{flex:none;display:inline-flex;align-items:center;gap:3px;opacity:0;transition:opacity .15s ease}',
      '.td-row:hover .td-acts,.td-row:focus-within .td-acts{opacity:1}',
      '.td-mini{padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);cursor:pointer}',
      '.td-mini:hover{border-color:var(--hud-line,rgba(0,0,0,.12));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-empty{padding:5px 2px;color:var(--dsw-alias-label-caption,#81858c)}',
      // settings
      '.td-set{display:flex;flex-direction:column;gap:7px;padding-top:8px;border-top:1px solid var(--hud-line,rgba(0,0,0,.08))}',
      '.td-set-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.td-set-label{min-width:62px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-feed{display:flex;align-items:center;gap:6px}',
      '.td-feed-state{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-feed-state.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.td-msg{font-size:11px;line-height:16px;word-break:break-word}',
      '.td-msg.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.td-msg.is-good{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.td-note-line{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── credentials that come from a LOGIN ────────────────────────────────
      '.td-sec{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.035))}',
      '.td-sec-head{display:flex;align-items:center;gap:7px}',
      '.td-sec-title{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.td-sec-state{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-sec-state.is-on{color:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.td-sel{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:3px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:transparent;font-family:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.td-sel:hover{border-color:var(--hud-line-2,rgba(0,0,0,.18))}',
      '.td-sel:disabled{opacity:.4;cursor:default}',
      '.td-caret{font-size:8px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── our own dropdown, NOT a <select> ─────────────────────────────────
      // A native popup is painted by the platform from the element's
      // `color-scheme`, not from its `color`. The app's palette and its declared
      // canvas scheme can disagree, and the result is a LIGHT popup under LIGHT
      // text — an unreadable list that no page CSS can reach. This one is ours,
      // so it is themed by the same tokens as everything else.
      '.td-drop{position:relative;display:inline-flex;min-width:0}',
      '.td-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:10;box-sizing:border-box;min-width:100%;max-height:220px;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:1px;padding:3px;border:1px solid var(--hud-line-2,rgba(0,0,0,.14));border-radius:9px;background:var(--hud-pop,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 2px 6px rgba(15,17,21,.08),0 16px 34px -20px rgba(15,17,21,.5)}',
      '.td-opt{display:block;width:100%;box-sizing:border-box;padding:3px 9px;border:0;border-radius:6px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);text-align:left;white-space:nowrap;cursor:pointer}',
      '.td-opt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-opt.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.td-wide{flex:1 1 140px}',
      '.td-mail-row{display:flex;align-items:baseline;gap:7px;padding:3px 4px;border-radius:6px}',
      '.td-mail-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05))}',
      '.td-mail-sub{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.td-mail-from{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#81858c)}',
      '.td-unread{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.td-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none}',
      '.td-link:hover{text-decoration:underline}',
    ].join('')
    document.head.appendChild(tag)
  }

  /**
   * The whole panel, in the title bar.
   *
   * Hook order is fixed: nothing below returns before every hook has run, so the
   * "no reading yet" / "error" / "ready" states cannot change the hook count and
   * take the slot entry down.
   */
  function TodoHead(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [showSet, setShowSet] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [draft, setDraft] = React.useState('')
    const [draftTime, setDraftTime] = React.useState('')
    const [notice, setNotice] = React.useState(null)
    const [alert, setAlert] = React.useState(null)
    const [permission, setPermission] = React.useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
    const [feedDraft, setFeedDraft] = React.useState({ url: '', label: '' })
    const [mailDraft, setMailDraft] = React.useState(null)
    const [loginDraft, setLoginDraft] = React.useState(null)
    const [mailList, setMailList] = React.useState(null)
    const [mailBusy, setMailBusy] = React.useState(false)
    const [digestDraft, setDigestDraft] = React.useState('')
    const [leadsDraft, setLeadsDraft] = React.useState('')
    const rootRef = React.useRef(null)
    const aliveRef = React.useRef(true)
    /**
     * The latest snapshot, for the timer callback. The tick is created once and
     * fires on a 30 s interval, so it cannot close over a `snapshot` state value
     * that changes every poll — it reads the ref instead.
     */
    const snapshotRef = React.useRef(null)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    // Native widgets inside this widget (the time picker, scrollbars) are painted
    // from `color-scheme`, so it is set from the surface token once, on mount.
    React.useEffect(() => {
      const root = rootRef.current
      if (root === null || root === undefined) return
      try {
        root.style.colorScheme = tdSurfaceScheme()
      } catch {
        /* a widget without a style object is not worth failing over */
      }
    }, [])

    const accept = React.useCallback((json) => {
      setSnapshot(json)
      setError(null)
      if (json?.digestAt && digestDraft === '') setDigestDraft(json.digestAt)
      if (Array.isArray(json?.leads) && leadsDraft === '') setLeadsDraft(json.leads.join(','))
      // Seed the credential forms from the host once, then leave them alone: a
      // poll landing while someone is typing a 授权码 must not wipe the field.
      if (json?.mail) setMailDraft((current) => (current === null ? { ...json.mail, secret: '' } : current))
      if (json?.oauth) {
        setLoginDraft((current) => (current === null
          ? { provider: json.oauth.provider, clientId: json.oauth.clientId, redirectUri: json.oauth.redirectUri, clientSecret: '' }
          : current))
      }
    }, [digestDraft, leadsDraft])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/todo/state').then((json) => {
        if (!aliveRef.current) return
        accept(json)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [accept])

      // ── 番茄钟 ──────────────────────────────────────────────────────────
      // The HOST owns the clock: this half only renders `endsAt - now`, so a
      // refresh, a hidden tab or a sleeping laptop resumes the same session
      // instead of losing it.
      const pomo = snapshot?.pomodoro ?? {
        phase: 'work', running: false, remainingMs: 25 * 60_000, totalMs: 25 * 60_000,
        started: false, completedToday: 0, cycleId: 0, settings: {}, justEnded: null,
      }
      const [pomoNow, setPomoNow] = React.useState(() => Date.now())
      // One tick per second while a session RUNS, and nothing at all otherwise:
      // an idle timer does not need a frame loop.
      React.useEffect(() => {
        if (pomo.running !== true) return undefined
        setPomoNow(Date.now())
        const timer = window.setInterval(() => setPomoNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [pomo.running, pomo.endsAt])
      const pomoLive = pomo.running === true && typeof pomo.endsAt === "number"
        ? { ...pomo, remainingMs: Math.max(0, pomo.endsAt - pomoNow) }
        : pomo

    const send = React.useCallback(async (path, body) => {
      setBusy(true)
      try {
        const json = await hud.fetchJson(`/dsh-hud/todo/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
        if (!aliveRef.current) return null
        if (json?.ok === false) setNotice({ bad: true, text: json.error ?? '操作失败' })
        else {
          setNotice(null)
          accept(json)
        }
        return json
      } catch (failure) {
        if (aliveRef.current) setNotice({ bad: true, text: failure instanceof Error ? failure.message : String(failure) })
        return null
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [accept])

    const refreshMs = hud.clamp(hud.num(snapshot?.refreshMs) ?? TD_FALLBACK_REFRESH_MS, TD_MIN_REFRESH_MS, TD_MAX_REFRESH_MS)

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    // ── 番茄钟到点 ──────────────────────────────────────────────────────
    //
    // Two things happen when a phase ends, and they are deliberately separate:
    //
    //   1. the card ASKS the host to settle the timer the moment its own
    //      countdown reaches zero, so the transition is recorded within a
    //      second instead of at the next five-minute poll;
    //   2. a notification fires for the phase that just ended.
    //
    // The host is the source of truth for BOTH: `justEnded` arrives in the
    // response and `cycleId` identifies the transition, so the same one cannot
    // be announced twice — not by a cached payload, a re-render, or two tabs.
    React.useEffect(() => {
      if (pomo.running !== true || typeof pomo.endsAt !== "number") return undefined
      if (pomo.endsAt - pomoNow > 0) return undefined
      // Past due: settle it. The host is idempotent here, so a burst is harmless.
      send("pomodoro", { action: "settle" }).catch(() => {})
      return undefined
    }, [pomo.running, pomo.endsAt, pomoNow, send])

    const pomoNoticed = React.useRef(0)
    React.useEffect(() => {
      const ended = pomo.justEnded
      if (ended === null || ended === undefined) return undefined
      if (pomo.cycleId <= pomoNoticed.current) return undefined
      pomoNoticed.current = pomo.cycleId
      // The SAME ledger the reminders use, so a refresh cannot re-announce a
      // session that already ended.
      const ledgerKey = `pomodoro@${pomo.cycleId}@${ended.at}`
      const ledger = tdReadLedger()
      if (ledger[ledgerKey] !== undefined) return undefined
      ledger[ledgerKey] = Date.now()
      tdWriteLedger(ledger)
      // A finished FOCUS session is the one worth interrupting for; a finished
      // break only needs a line in the panel.
      if (ended.phase === "work") {
        tdNotify(
          zh ? "专注结束" : "Focus finished",
          zh ? `完成第 ${ended.completedToday} 段，该休息 ${Math.round(ended.nextMs / 60_000)} 分钟了` : `Session ${ended.completedToday} done — take ${Math.round(ended.nextMs / 60_000)} minutes`,
        )
      } else {
        tdNotify(zh ? "休息结束" : "Break over", zh ? "回到专注吧。" : "Back to it.")
      }
      // Stated inline too: a notification needs THIS PAGE to be open, because
      // nothing of ours runs while the Harness is closed.
      //
      // This is the title-bar ALERT line — the same one a reminder uses — because a
      // finished session has to be visible WITHOUT the panel being open. The
      // popover strip already says which phase is running.
      setAlert({ text: ended.phase === 'work'
        ? (zh ? `专注结束 · 完成第 ${ended.completedToday} 段` : `Focus finished · session ${ended.completedToday}`)
        : (zh ? '休息结束' : 'Break over') })
      return undefined
    }, [pomo.justEnded, pomo.cycleId, zh])

    // ── the notifier ───────────────────────────────────────────────────────
    /**
     * One tick every 30 seconds, always running — including while the card is
     * switched off and the popover is closed, because a reminder that only works
     * with the list open is not a reminder.
     */
    const tick = React.useCallback(() => {
      const current = snapshotRef.current
      if (current === null) return
      const now = Date.now()
      const leads = Array.isArray(current.leads) ? current.leads : []
      const ledger = tdReadLedger(now)
      const schedule = Array.isArray(current.schedule) ? current.schedule : []
      let fired = null
      for (const item of schedule) {
        for (const lead of tdDueLeads(item, leads, now, ledger)) {
          ledger[`${item.id}@${lead}`] = now
          // The soonest lead wins the line: if three fire together, the one that
          // matters is the closest to the deadline.
          if (fired === null || lead < fired.lead) fired = { item, lead }
        }
      }
      // The end-of-day digest: once per day, and only when tomorrow has items.
      const digest = current.digest
      if (digest && digest.day && ledger[`digest@${digest.day}`] === undefined) {
        ledger[`digest@${digest.day}`] = now
        tdWriteLedger(ledger)
        tdNotify(zh ? digest.title : `Tomorrow: ${digest.items.length} item(s)`,
          digest.items.map((entry) => entry.title).join('、') + (digest.more > 0 ? (zh ? ` 等 ${digest.more} 项` : ` +${digest.more}`) : ''))
        setAlert({ text: zh ? `下班提醒 · ${digest.title}` : `End of day · ${digest.items.length} tomorrow`, at: now, digest: true })
        return
      }
      if (fired === null) {
        tdWriteLedger(ledger)
        return
      }
      tdWriteLedger(ledger)
      const minutes = tdMinutesUntil(fired.item.dueAt, now)
      const title = zh ? `${tdLeadLabel(minutes, zh)}：${fired.item.title}` : `${fired.item.title} in ${minutes}m`
      tdNotify(zh ? '待办提醒' : 'To-do reminder', title)
      setAlert({ text: title, at: now, id: fired.item.id })
    }, [zh])

    React.useEffect(() => {
      snapshotRef.current = snapshot
    }, [snapshot])

    React.useEffect(() => {
      let stop
      try {
        if (typeof props.startTimers === 'function') {
          stop = props.startTimers(poll, refreshMs, tick, TD_TICK_MS)
        } else {
          const pollTimer = window.setInterval(poll, refreshMs)
          const tickTimer = window.setInterval(tick, TD_TICK_MS)
          stop = () => {
            window.clearInterval(pollTimer)
            window.clearInterval(tickTimer)
          }
        }
      } catch (failure) {
        console.error('[td] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, refreshMs, tick, props.startTimers])

    // The fired reminder clears itself: news that never expires is clutter.
    React.useEffect(() => {
      if (alert === null) return undefined
      const timer = window.setTimeout(() => setAlert(null), TD_ALERT_MS)
      return () => window.clearTimeout(timer)
    }, [alert])

    // The count reaches the head row AND the ⚙ editor through the shell's badge.
    const openCount = hud.num(snapshot?.counts?.open) ?? 0
    const overdueCount = hud.num(snapshot?.counts?.overdue) ?? 0
    React.useEffect(() => {
      hud.setBadge('todo', overdueCount > 0 ? overdueCount : openCount)
    }, [openCount, overdueCount])

    hud.useDismiss(rootRef, open, React.useCallback(() => setOpen(false), []))

    const askPermission = React.useCallback(async () => {
      if (typeof Notification === 'undefined') return
      try {
        const result = await Notification.requestPermission()
        setPermission(result)
        if (result !== 'granted') {
          setNotice({ bad: true, text: zh ? '未获授权：提醒只会显示在 HUD 里' : 'Not granted: reminders stay in the HUD' })
        } else {
          setNotice({ good: true, text: zh ? '已开启系统通知' : 'System notifications on' })
        }
      } catch (failure) {
        setNotice({ bad: true, text: failure instanceof Error ? failure.message : String(failure) })
      }
    }, [zh])

    const addItem = React.useCallback(async () => {
      const title = draft.trim()
      if (title === '') return
      const json = await send('add', { title, dueAt: draftTime === '' ? undefined : `${snapshot?.todayDate ?? ''}T${draftTime}` })
      if (json?.ok !== false) {
        setDraft('')
        setDraftTime('')
      }
    }, [draft, draftTime, send, snapshot?.todayDate])

    const groups = snapshot?.groups ?? {}
    const nextItem = (groups.today ?? [])[0] ?? (groups.overdue ?? [])[0] ?? (groups.tomorrow ?? [])[0]
    const rowsOf = (list) => (Array.isArray(list) ? list : []).map((item) => jsx(TodoRow, {
      item,
      zh,
      now: snapshot?.now ?? Date.now(),
      busy,
      onPatch: (patch) => send('update', { id: item.id, patch }),
      onRemove: () => send('remove', { id: item.id }),
      // NO `key` in this object: React wants it as the third argument, and a key
      // inside spread props is a warning today and a wrong-row bug tomorrow.
    }, item.id))

    return jsxs('span', { className: 'td-root', ref: rootRef, children: [
      jsxs('button', {
        type: 'button',
        className: 'td-btn',
        'aria-expanded': open ? 'true' : 'false',
        title: zh ? '待办事项' : 'To-do',
        onClick: () => setOpen((value) => !value),
        children: [
          jsx('span', { className: 'td-mark', 'aria-hidden': true, children: '☑' }),
          jsx('span', { children: zh ? '待办' : 'To-do' }),
          openCount > 0
            ? jsx('em', { className: `td-count${overdueCount > 0 ? ' is-overdue' : ''}`, children: openCount > 99 ? '99+' : String(openCount) })
            : jsx('span', { className: 'td-zero', children: zh ? '无' : '0' }),
          nextItem
            ? jsx('span', { className: 'td-next', children: `${tdWhen(nextItem.dueAt, snapshot?.now ?? Date.now(), zh)} ${nextItem.title}` })
            : null,
        ],
      }),
      alert
        ? jsxs('button', {
            type: 'button',
            className: 'td-alert',
            title: zh ? '点击查看' : 'Open',
            onClick: () => {
              setOpen(true)
              setAlert(null)
            },
            children: [
              jsx('b', { children: zh ? '提醒' : 'ALERT' }),
              jsx('span', { children: alert.text }),
            ],
          })
        : null,
      open
        ? jsxs('div', { className: 'td-pop', role: 'dialog', 'aria-label': zh ? '待办事项' : 'To-do', children: [
            // ── 番茄钟 ──────────────────────────────────────────────────────
            // At the TOP, above the list: it is the thing you set going and then
            // stop looking at, so it must be visible the moment the panel opens.
            jsx('div', { className: `td-pomo${pomo.running ? ' is-running' : ''}${pomo.phase === 'break' ? ' is-break' : ''}`, children:
              jsxs('div', { className: 'td-pomo-row', children: [
                jsx('span', { className: 'td-pomo-phase', children: pomo.phase === 'break' ? (zh ? '休息' : 'break') : (zh ? '专注' : 'focus') }),
                // The countdown is DERIVED from `endsAt` every second; the browser
                // never owns the elapsed time, so a refresh loses nothing.
                jsx('span', { className: 'td-pomo-time', children: tdClock(pomoLive.remainingMs) }),
                jsx('span', { className: 'td-pomo-total', children: zh ? `共 ${Math.round(pomoLive.totalMs / 60_000)} 分钟` : `${Math.round(pomoLive.totalMs / 60_000)} min` }),
                jsx('span', { className: 'td-spacer' }),
                pomo.completedToday > 0
                  ? jsx('span', { className: 'td-pomo-done', title: zh ? '今天完成的专注时段' : 'focus sessions finished today', children: zh ? `今天 ${pomo.completedToday}` : `today ${pomo.completedToday}` })
                  : null,
                jsx('button', {
                  type: 'button',
                  className: 'td-ghost',
                  disabled: busy,
                  title: pomo.running ? (zh ? '暂停' : 'Pause') : (pomo.started ? (zh ? '继续' : 'Resume') : (zh ? '开始一个专注时段' : 'Start a focus session')),
                  onClick: () => send('pomodoro', { action: pomo.running ? 'pause' : (pomo.started ? 'resume' : 'start') }),
                  children: pomo.running ? (zh ? '暂停' : 'Pause') : (pomo.started ? (zh ? '继续' : 'Resume') : (zh ? '开始' : 'Start')),
                }),
                pomo.started || pomo.running
                  ? jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy,
                      title: zh ? '跳到下一段（不计入完成数）' : 'Skip to the next phase (no credit)',
                      onClick: () => send('pomodoro', { action: 'skip' }),
                      children: zh ? '跳过' : 'Skip',
                    })
                  : null,
                pomo.started || pomo.running
                  ? jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy,
                      title: zh ? '重置计时器（保留今天的计数）' : 'Reset the timer (keeps today\'s count)',
                      onClick: () => send('pomodoro', { action: 'reset' }),
                      children: zh ? '重置' : 'Reset',
                    })
                  : null,
              ] }),
            }),
            jsxs('div', { className: 'td-pop-head', children: [
              jsx('span', { className: 'td-pop-title', children: zh ? '待办' : 'TO-DO' }),
              jsx('span', { className: 'td-note-line', children: snapshot === null
                ? (error === null ? (zh ? '正在读取…' : 'loading…') : error)
                : (zh
                    ? `${openCount} 项未完成 · 逾期 ${overdueCount}`
                    : `${openCount} open · ${overdueCount} overdue`) }),
              jsx('span', { className: 'td-spacer' }),
              jsx('button', {
                type: 'button',
                className: 'td-ghost',
                disabled: busy,
                title: zh ? '重新读取（含订阅）' : 'Refresh (feeds too)',
                onClick: () => send('refresh'),
                children: zh ? '刷新' : 'Refresh',
              }),
              jsx('button', {
                type: 'button',
                className: 'td-ghost',
                'aria-pressed': showSet ? 'true' : 'false',
                title: zh ? '订阅与提醒设置' : 'Feeds and reminders',
                onClick: () => setShowSet((value) => !value),
                children: zh ? '设置' : 'Settings',
              }),
            ] }),
            // ── add ──────────────────────────────────────────────────────────
            jsxs('div', { className: 'td-add', children: [
              jsx('input', {
                className: 'td-input',
                value: draft,
                placeholder: zh ? '添加待办，回车即可' : 'Add a to-do, press Enter',
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addItem()
                },
              }),
              jsx('input', {
                className: 'td-time',
                type: 'time',
                value: draftTime,
                title: zh ? '时间（留空则无日期）' : 'Time (empty = no date)',
                onChange: (event) => setDraftTime(event.target.value),
              }),
              jsx('button', {
                type: 'button',
                className: 'td-ghost',
                disabled: busy || draft.trim() === '',
                onClick: addItem,
                children: zh ? '添加' : 'Add',
              }),
            ] }),
            permission === 'default'
              ? jsxs('div', { className: 'td-set-row', children: [
                  jsx('button', {
                    type: 'button',
                    className: 'td-ghost',
                    onClick: askPermission,
                    children: zh ? '开启系统通知' : 'Enable notifications',
                  }),
                  jsx('span', { className: 'td-note-line', children: zh
                    ? '提醒需要这个页面开着；关掉 Harness 就不会响。'
                    : 'Reminders need this page open; nothing fires while Harness is closed.' }),
                ] })
              : permission === 'denied'
                ? jsx('span', { className: 'td-note-line', children: zh
                    ? '系统通知被拒绝，提醒只显示在标题栏（可在浏览器设置里改回）。'
                    : 'System notifications are blocked; reminders show in the title bar only.' })
                : null,
            notice
              ? jsx('span', { className: `td-msg${notice.bad ? ' is-bad' : notice.good ? ' is-good' : ''}`, children: notice.text })
              : null,
            // ── the list ─────────────────────────────────────────────────────
            openCount === 0 && (groups.done ?? []).length === 0
              ? jsx('span', { className: 'td-empty', children: zh ? '没有待办。上面输入一行就能加。' : 'Nothing to do. Add one above.' })
              : null,
            (groups.overdue ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '逾期' : 'OVERDUE', jsx('em', { children: String(groups.overdue.length) })] }),
                  rowsOf(groups.overdue),
                ] })
              : null,
            (groups.today ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '今天' : 'TODAY', jsx('em', { children: String(groups.today.length) })] }),
                  rowsOf(groups.today),
                ] })
              : null,
            (groups.tomorrow ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '明天' : 'TOMORROW', jsx('em', { children: String(groups.tomorrow.length) })] }),
                  rowsOf(groups.tomorrow),
                ] })
              : null,
            (groups.later ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '以后' : 'LATER', jsx('em', { children: String(groups.later.length) })] }),
                  rowsOf(groups.later),
                ] })
              : null,
            (groups.someday ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '无日期' : 'NO DATE', jsx('em', { children: String(groups.someday.length) })] }),
                  rowsOf(groups.someday),
                ] })
              : null,
            (groups.done ?? []).length > 0
              ? jsxs('div', { className: 'td-group', children: [
                  jsxs('span', { className: 'td-group-head', children: [zh ? '已完成' : 'DONE', jsx('em', { children: String((groups.done ?? []).length) })] }),
                  rowsOf((groups.done ?? []).slice(0, 5)),
                ] })
              : null,
            // ── settings ─────────────────────────────────────────────────────
            showSet
              ? jsxs('div', { className: 'td-set', children: [
                  jsxs('div', { className: 'td-set-row', children: [
                    jsx('span', { className: 'td-set-label', children: zh ? '日历订阅' : 'FEEDS' }),
                    jsx('span', { className: 'td-note-line', children: zh
                      ? '粘贴 .ics 订阅地址（飞书/钉钉日历共享、Outlook、邮箱日历都可以），只读同步。'
                      : 'Paste an .ics subscription URL (Feishu/DingTalk calendar share, Outlook, mail calendar). Read-only.' }),
                  ] }),
                  (snapshot?.feedSettings ?? []).map((feed) => {
                    const status = (snapshot?.feeds ?? []).find((entry) => entry.url === feed.url)
                    return jsxs('div', { className: 'td-feed', key: feed.url }, [
                      jsx('span', { className: 'td-title', children: feed.label }),
                      jsx('span', { className: `td-feed-state${status?.error ? ' is-bad' : ''}`, children: status?.error
                        ?? (status?.count === undefined ? (zh ? '未同步' : 'not synced') : `${status.count} 项`)
                        ?? '' }),
                      status?.unsupported?.length > 0
                        ? jsx('span', { className: 'td-approx', title: status.unsupported.join(', '), children: zh ? '部分规则未展开' : 'partial rules' })
                        : null,
                      jsx('span', { className: 'td-spacer', style: { marginLeft: 'auto' } }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-mini',
                        title: feed.enabled ? (zh ? '暂停这个订阅' : 'Pause') : (zh ? '启用' : 'Enable'),
                        onClick: () => send('settings', {
                          feeds: (snapshot?.feedSettings ?? []).map((entry) => (entry.url === feed.url ? { ...entry, enabled: !entry.enabled } : entry)),
                        }),
                        children: feed.enabled ? (zh ? '暂停' : 'Pause') : (zh ? '启用' : 'On'),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-mini',
                        title: zh ? '删除这个订阅' : 'Remove',
                        onClick: () => send('settings', { feeds: (snapshot?.feedSettings ?? []).filter((entry) => entry.url !== feed.url) }),
                        children: zh ? '删除' : 'Del',
                      }),
                    ])
                  }),
                  jsxs('div', { className: 'td-add', children: [
                    jsx('input', {
                      className: 'td-input',
                      value: feedDraft.url,
                      placeholder: 'https://…/basic.ics',
                      onChange: (event) => setFeedDraft((current) => ({ ...current, url: event.target.value })),
                    }),
                    jsx('input', {
                      className: 'td-time',
                      style: { width: '88px' },
                      value: feedDraft.label,
                      placeholder: zh ? '名称' : 'name',
                      onChange: (event) => setFeedDraft((current) => ({ ...current, label: event.target.value })),
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy || feedDraft.url.trim() === '',
                      onClick: async () => {
                        // Probe BEFORE saving: the reason a subscription fails is
                        // only useful while the URL is still on screen.
                        const probe = await send('feed', { url: feedDraft.url.trim(), label: feedDraft.label.trim() })
                        if (probe?.ok !== true) return
                        const feeds = [...(snapshot?.feedSettings ?? []), { url: feedDraft.url.trim(), label: feedDraft.label.trim() || `订阅 ${(snapshot?.feedSettings ?? []).length + 1}`, enabled: true }]
                        const saved = await send('settings', { feeds })
                        if (saved?.ok !== false) {
                          setFeedDraft({ url: '', label: '' })
                          setNotice({ good: true, text: zh ? `已添加，读到 ${probe.counts?.occurrences ?? 0} 项` : `Added, ${probe.counts?.occurrences ?? 0} items` })
                        }
                      },
                      children: zh ? '测试并添加' : 'Test + add',
                    }),
                  ] }),
                  jsxs('div', { className: 'td-set-row', children: [
                    jsx('span', { className: 'td-set-label', children: zh ? '下班提醒' : 'DIGEST' }),
                    jsx('input', {
                      className: 'td-time',
                      style: { width: '72px' },
                      value: digestDraft,
                      placeholder: '16:30',
                      onChange: (event) => setDigestDraft(event.target.value),
                    }),
                    jsx('span', { className: 'td-note-line', children: zh ? '到点提醒明天的事项（没有就不打扰）' : 'Reminds you about tomorrow (only if there is something)' }),
                  ] }),
                  jsxs('div', { className: 'td-set-row', children: [
                    jsx('span', { className: 'td-set-label', children: zh ? '提前提醒' : 'LEADS' }),
                    jsx('input', {
                      className: 'td-input',
                      style: { maxWidth: '150px' },
                      value: leadsDraft,
                      placeholder: '60,30,5',
                      onChange: (event) => setLeadsDraft(event.target.value),
                    }),
                    jsx('span', { className: 'td-note-line', children: zh ? '分钟，逗号分隔' : 'minutes, comma separated' }),
                    jsx('button', {
                      type: 'button',
                      className: 'td-ghost',
                      disabled: busy,
                      onClick: () => send('settings', {
                        digestAt: digestDraft || snapshot?.digestAt,
                        leads: leadsDraft.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0),
                      }),
                      children: zh ? '保存' : 'Save',
                    }),
                  ] }),
                  jsx('span', { className: 'td-note-line', children: zh
                    ? '飞书/钉钉的待办 API 需要企业应用与用户授权，邮箱需要 IMAP 凭据 —— 本插件不走这两条路，日历订阅覆盖了同样的信息。'
                    : 'Feishu/DingTalk task APIs need an enterprise app and user OAuth; mail needs IMAP credentials. Neither is used — calendar subscription covers the same ground.' }),
                  // ── 邮箱：IMAP + 授权码 ────────────────────────────────────
                  // Neither of these is an API key from a dashboard. Both are
                  // logins the user already has, which is why the card asks for a
                  // 授权码 (mail) or an app id + secret (OAuth) and nothing else.
                  jsxs('div', { className: 'td-sec', children: [
                    jsxs('div', { className: 'td-sec-head', children: [
                      jsx('span', { className: 'td-sec-title', children: zh ? '邮箱（IMAP）' : 'MAIL (IMAP)' }),
                      jsx('span', {
                        className: `td-sec-state${snapshot?.mail?.host && mailList !== null ? ' is-on' : ''}`,
                        children: !snapshot?.mail?.host
                          ? (zh ? '未配置' : 'not set')
                          : mailList === null
                            ? (zh ? '已配置' : 'set')
                            : (zh ? `读到 ${mailList.length} 封` : `${mailList.length} read`),
                      }),
                    ] }),
                    jsx('span', { className: 'td-note-line', children: zh
                      ? '用「授权码 / 应用专用密码」，不是账号密码（163、126、QQ、腾讯企业邮、阿里云都支持）。只读最近的邮件标题，读信不会把它们标成已读。'
                      : 'Use the app password (授权码), not the account password. Headers only, and reading does not mark mail as read.' }),
                    jsxs('div', { className: 'td-add', children: [
                      jsx(TdSelect, {
                        value: mailDraft?.preset ?? 'custom',
                        title: zh ? '常见的 IMAP 服务商' : 'common IMAP providers',
                        options: Object.entries(snapshot?.mailPresets ?? {}).map(([key, value]) => ({ value: key, label: value.label })),
                        onChange: (preset) => {
                          const known = snapshot?.mailPresets?.[preset]
                          setMailDraft((current) => ({ ...(current ?? {}), preset, host: known?.host ?? current?.host ?? '', port: known?.port ?? 993 }))
                        },
                      }),
                      jsx('input', {
                        className: 'td-input td-wide',
                        value: mailDraft?.host ?? '',
                        placeholder: zh ? 'IMAP 服务器' : 'IMAP host',
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), host: event.target.value })),
                      }),
                      jsx('input', {
                        className: 'td-time',
                        style: { width: '62px' },
                        value: String(mailDraft?.port ?? 993),
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), port: Number(event.target.value) || 993 })),
                      }),
                    ] }),
                    jsxs('div', { className: 'td-add', children: [
                      jsx('input', {
                        className: 'td-input',
                        value: mailDraft?.user ?? '',
                        placeholder: zh ? '邮箱账号' : 'account',
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), user: event.target.value })),
                      }),
                      jsx('input', {
                        className: 'td-input',
                        type: 'password',
                        value: mailDraft?.secret ?? '',
                        placeholder: snapshot?.mailHasSecret === true ? (zh ? '授权码（已保存，留空不改）' : 'app password (saved)') : (zh ? '授权码' : 'app password'),
                        onChange: (event) => setMailDraft((current) => ({ ...(current ?? {}), secret: event.target.value })),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy || mailBusy,
                        onClick: async () => {
                          setMailBusy(true)
                          try {
                            const saved = await send('mail', {
                              preset: mailDraft?.preset,
                              host: mailDraft?.host,
                              port: mailDraft?.port,
                              user: mailDraft?.user,
                              mailbox: mailDraft?.mailbox,
                              limit: mailDraft?.limit,
                              secret: mailDraft?.secret,
                            })
                            if (saved?.ok !== false) {
                              const listed = await send('mail/list', {})
                              if (listed?.ok === true) {
                                setMailList(listed.messages ?? [])
                                setNotice({ good: true, text: zh ? `连接成功，${listed.mailbox} 共 ${listed.total} 封` : `Connected: ${listed.total} in ${listed.mailbox}` })
                              } else {
                                setMailList(null)
                                setNotice({ bad: true, text: listed?.error ?? '读取失败' })
                              }
                            }
                          } finally {
                            setMailBusy(false)
                          }
                        },
                        children: mailBusy ? (zh ? '连接中…' : 'connecting…') : (zh ? '保存并连接' : 'Save + connect'),
                      }),
                    ] }),
                    mailList === null
                      ? null
                      : mailList.length === 0
                        ? jsx('span', { className: 'td-note-line', children: zh ? '这个目录里没有邮件。' : 'No mail in that mailbox.' })
                        : jsxs('div', { children: [
                            jsx('span', { className: 'td-note-line', children: zh
                              ? '点一封加为待办。不自动猜哪封是待办 —— 猜错就是把垃圾塞进清单。'
                              : 'Click one to turn it into a to-do. Nothing guesses which mail is actionable.' }),
                            ...mailList.slice(0, 8).map((message) => jsxs('div', { className: 'td-mail-row', key: String(message.uid ?? message.subject) }, [
                              message.seen === false ? jsx('span', { className: 'td-unread', title: zh ? '未读' : 'unread' }) : null,
                              jsx('span', { className: 'td-mail-sub', title: message.subject, children: message.subject }),
                              jsx('span', { className: 'td-mail-from', title: message.from, children: message.from }),
                              jsx('button', {
                                type: 'button',
                                className: 'td-mini',
                                disabled: busy,
                                onClick: async () => {
                                  const json = await send('add', { title: message.subject, note: message.from })
                                  if (json?.ok !== false) setNotice({ good: true, text: zh ? '已加入待办' : 'Added' })
                                },
                                children: zh ? '加为待办' : 'Add',
                              }),
                            ])),
                          ] }),
                  ] }),
                  // ── 飞书 / 钉钉：登录换 token ────────────────────────────
                  jsxs('div', { className: 'td-sec', children: [
                    jsxs('div', { className: 'td-sec-head', children: [
                      jsx('span', { className: 'td-sec-title', children: zh ? '飞书 / 钉钉（登录）' : 'FEISHU / DINGTALK' }),
                      jsx('span', {
                        className: `td-sec-state${(snapshot?.oauth?.expiresAt ?? 0) > Date.now() ? ' is-on' : ''}`,
                        children: snapshot?.oauth?.provider === ''
                          ? (zh ? '未选择' : 'pick one')
                          : (snapshot?.oauth?.expiresAt ?? 0) > Date.now()
                            ? (zh ? '已登录' : 'signed in')
                            : (zh ? '未登录' : 'not signed in'),
                      }),
                    ] }),
                    // The one thing a plugin cannot do, said plainly and first.
                    jsxs('span', { className: 'td-note-line', children: [
                      zh ? '需要你先在开放平台创建一个「自建应用」并把回调地址填成 ' : 'You must first create a self-built app and set its redirect URI to ',
                      jsx('code', { children: snapshot?.oauth?.redirectUri || `${location.origin}/dsh-hud/todo/callback` }),
                      zh ? '。插件无法替你创建应用，也无法替你通过企业审批。' : '. A plugin cannot create the app or approve it for you.',
                    ] }),
                    jsxs('div', { className: 'td-add', children: [
                      jsx(TdSelect, {
                        value: loginDraft?.provider ?? '',
                        placeholder: zh ? '选择服务商' : 'choose',
                        options: [
                          { value: '', label: zh ? '选择服务商' : 'choose' },
                          { value: 'feishu', label: zh ? '飞书' : 'Feishu' },
                          { value: 'dingtalk', label: zh ? '钉钉' : 'DingTalk' },
                        ],
                        onChange: (provider) => setLoginDraft((current) => ({ ...(current ?? {}), provider })),
                      }),
                      jsx('input', {
                        className: 'td-input',
                        value: loginDraft?.clientId ?? '',
                        placeholder: snapshot?.oauth?.idField ?? 'client_id',
                        onChange: (event) => setLoginDraft((current) => ({ ...(current ?? {}), clientId: event.target.value })),
                      }),
                      jsx('input', {
                        className: 'td-input',
                        type: 'password',
                        value: loginDraft?.clientSecret ?? '',
                        placeholder: snapshot?.oauth?.secretField ?? 'client_secret',
                        onChange: (event) => setLoginDraft((current) => ({ ...(current ?? {}), clientSecret: event.target.value })),
                      }),
                    ] }),
                    jsxs('div', { className: 'td-set-row', children: [
                      jsx('input', {
                        className: 'td-input td-wide',
                        value: loginDraft?.redirectUri ?? '',
                        placeholder: 'redirect_uri',
                        onChange: (event) => setLoginDraft((current) => ({ ...(current ?? {}), redirectUri: event.target.value })),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy,
                        onClick: async () => {
                          const saved = await send('login', {
                            provider: loginDraft?.provider,
                            clientId: loginDraft?.clientId,
                            clientSecret: loginDraft?.clientSecret,
                            redirectUri: loginDraft?.redirectUri || `${location.origin}/dsh-hud/todo/callback`,
                          })
                          if (saved?.ok === true && saved.authorizeUrl) {
                            setNotice({ good: true, text: zh ? '已保存，点「打开授权页」登录' : 'Saved — open the authorize page' })
                          }
                        },
                        children: zh ? '保存' : 'Save',
                      }),
                      snapshot?.oauth?.provider
                        ? jsx('a', {
                            className: 'td-ghost td-link',
                            href: `/dsh-hud/todo/login?open=1#${encodeURIComponent(loginDraft?.provider ?? '')}`,
                            onClick: async (event) => {
                              // The host builds the URL (parameter names differ per
                              // vendor), so ask for it and open THAT.
                              event.preventDefault()
                              const saved = await send('login', {
                                provider: loginDraft?.provider,
                                clientId: loginDraft?.clientId,
                                clientSecret: loginDraft?.clientSecret,
                                redirectUri: loginDraft?.redirectUri || `${location.origin}/dsh-hud/todo/callback`,
                              })
                              if (saved?.authorizeUrl) window.open(saved.authorizeUrl, '_blank', 'noopener')
                              else setNotice({ bad: true, text: zh ? '还没有填 client id' : 'no client id yet' })
                            },
                            children: zh ? '打开授权页' : 'Open authorize page',
                          })
                        : null,
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy || (snapshot?.oauth?.provider ?? '') === '',
                        onClick: async () => {
                          const json = await send('tasks', {})
                          if (json?.ok === true) setNotice({ good: true, text: zh ? `拉取到 ${json.count} 条待办` : `${json.count} tasks` })
                          else setNotice({ bad: true, text: json?.error ?? '拉取失败' })
                        },
                        children: zh ? '拉取待办' : 'Fetch tasks',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'td-ghost',
                        disabled: busy || (snapshot?.oauth?.provider ?? '') === '',
                        onClick: () => send('login', { logout: true }),
                        children: zh ? '退出登录' : 'Sign out',
                      }),
                    ] }),
                    snapshot?.oauth?.lastError
                      ? jsx('span', { className: 'td-msg is-bad', children: snapshot.oauth.lastError })
                      : null,
                    snapshot?.oauth?.account
                      ? jsx('span', { className: 'td-note-line', children: `${zh ? '当前账号' : 'account'}：${snapshot.oauth.account}` })
                      : null,
                    jsx('span', { className: 'td-note-line', children: zh
                      ? '接口地址按开放平台当前文档预置，可在这里改。若你的租户返回的字段不同，拉取会把原始响应显示出来，而不是假装成功。'
                      : 'Endpoint defaults come from the vendors\' docs and are editable here. If your tenant answers differently, the raw response is shown.' }),
                  ] }),
                ] })
              : null,
          ] })
        : null,
    ] })
  }

  /** One row: checkbox, title, when, source, actions. */
  function TodoRow(props) {
    const { item, zh, now, busy } = props
    const minutes = item.dueAt === undefined ? undefined : tdMinutesUntil(item.dueAt, now)
    const overdue = minutes !== undefined && minutes < 0
    const soon = minutes !== undefined && minutes >= 0 && minutes <= 60
    return jsxs('div', { className: `td-row${item.done ? ' is-done' : ''}`, 'data-id': item.id, children: [
      jsx('button', {
        type: 'button',
        className: 'td-check',
        'aria-pressed': item.done ? 'true' : 'false',
        'aria-label': item.done ? (zh ? '标记未完成' : 'Mark not done') : (zh ? '标记完成' : 'Mark done'),
        disabled: busy || item.readOnly === true,
        title: item.readOnly === true ? (zh ? '来自订阅，不能在这里勾选' : 'From a feed; not editable here') : undefined,
        onClick: () => props.onPatch?.({ done: !item.done }),
        children: item.done ? '✓' : '',
      }),
      jsxs('div', { className: 'td-body', children: [
        jsx('span', { className: 'td-title', children: item.title }),
        jsxs('span', { className: 'td-meta', children: [
          item.dueAt === undefined
            ? null
            : jsx('span', {
                className: `td-due${overdue ? ' is-overdue' : soon ? ' is-soon' : ''}`,
                children: `${tdWhen(item.dueAt, now, zh)}${overdue ? (zh ? ' · 已过' : ' · late') : soon ? ` · ${tdLeadLabel(minutes, zh)}` : ''}`,
              }),
          item.readOnly === true ? jsx('span', { className: 'td-src', children: item.source ?? 'ics' }) : null,
          item.approx === true ? jsx('span', { className: 'td-approx', children: zh ? '重复规则未完全展开' : 'rule approximated' }) : null,
          item.note ? jsx('span', { className: 'td-note', children: item.note.slice(0, 80) }) : null,
        ] }),
      ] }),
      jsxs('span', { className: 'td-acts', children: [
        item.readOnly === true || item.done
          ? null
          : jsx('button', {
              type: 'button',
              className: 'td-mini',
              disabled: busy,
              title: zh ? '推迟一小时' : 'Snooze an hour',
              onClick: () => props.onPatch?.({ snoozeMinutes: 60 }),
              children: zh ? '+1h' : '+1h',
            }),
        item.readOnly === true || item.done
          ? null
          : jsx('button', {
              type: 'button',
              className: 'td-mini',
              disabled: busy,
              title: zh ? '推迟到明天同一时间' : 'Snooze to tomorrow',
              onClick: () => props.onPatch?.({ snoozeMinutes: 60 * 24 }),
              children: zh ? '明天' : 'tmrw',
            }),
        jsx('button', {
          type: 'button',
          className: 'td-mini',
          disabled: busy,
          title: item.readOnly === true ? (zh ? '不再显示（不会改动日历）' : 'Hide here (does not touch the calendar)') : (zh ? '删除' : 'Delete'),
          onClick: props.onRemove,
          children: item.readOnly === true ? (zh ? '隐藏' : 'Hide') : (zh ? '删除' : 'Del'),
        }),
      ] }),
    ] })
  }

  return {
    id: 'todo',
    order: 20,
    label: { zh: '待办', en: 'To-do' },
    span: 1,
    defaultOn: false,
    // The whole point of the ask: it belongs on the RIGHT of the title bar.
    headSide: 'right',
    head: TodoHead,
    __test: { tdDueLeads, tdWhen, tdLeadLabel, tdMinutesUntil, tdReadLedger, tdWriteLedger, tdClock, TD_STORAGE_KEY, TD_TICK_MS },
  }
}

/**
 * A countdown as `mm:ss`. Past an hour it grows an hours field rather than
 * printing `90:00`, which reads like a mistake.
 */
function tdClock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** Fire a system notification when allowed; the HUD line covers the rest. */
function tdNotify(title, body) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
    // `tag` collapses repeats of the same reminder instead of stacking them.
    new Notification(title, { body, tag: 'dsh-hud-todo', silent: false })
    return true
  } catch {
    return false
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── panels/weather/client.js
// ──────────────────────────────────────────────────────────────────────────

// dsh-hud › weather panel — browser half.
//
// FRAGMENT CONTRACT: `tools/build-client.mjs` concatenates this file into the
// single `client.js` bundle, inside the same factory scope as the shell and the
// other panels. No top-level `import` / `export` / `return`; everything lives
// inside `createWeatherPanel()`. `React`, `jsx`, `jsxs` and `hud` come from the
// enclosing bundle scope.
//
// This panel contributes ONLY `head` — a widget in the HUD's title bar. It has
// no `Component`, so it never takes a grid column and never disturbs the card
// layout; the ⚙ editor still gets a row for it, because "is the weather line
// showing" is a thing the user should be able to switch off.
//
// The title bar has room for one line, so it carries exactly what was asked
// for — condition, temperature, humidity, wind — and pushes everything else
// (feels-like, precipitation, gusts, 风力等级, the alert list, the refresh
// button) into a click-open panel. The alert chip is the exception: an extreme
// weather warning is the one thing that must not need a click to notice, so it
// sits inline next to the reading.
//
// Cadence: the host ships `refreshMs` (default 600 000 = 10 minutes) and it is
// what the poll interval is armed with, so the host and the browser can never
// disagree about how fresh "fresh" is.

const WX_CLOCK_MS = 0 // no clock tick: nothing in the line counts down
const WX_FALLBACK_REFRESH_MS = 600_000
const WX_MIN_REFRESH_MS = 60_000
const WX_MAX_REFRESH_MS = 6 * 60 * 60_000
/** Severity order for picking which alert earns the inline chip. */
const WX_LEVEL_RANK = { 红色: 4, 橙色: 3, 黄色: 2, 蓝色: 1, '': 0 }

function createWeatherPanel() {
  const CSS_ID = 'dsh-hud/weather.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      // The widget is one line of small text; the card's own surface and the
      // title bar's border already frame it, so there is no chrome here.
      '.wx-root{position:relative;display:inline-flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.wx-btn{display:inline-flex;align-items:center;gap:6px;min-width:0;padding:1px 2px;border:0;border-radius:6px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:inherit;cursor:pointer}',
      '.wx-btn:hover{color:var(--dsw-alias-label-primary,#0f1115)}',
      '.wx-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:1px}',
      '.wx-glyph{flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-temp{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      // Air quality in the head row: a dot for the band AND the band's name,
      // because an AQI number alone tells most people nothing.
      '.wx-air{display:inline-flex;align-items:baseline;gap:4px}',
      '.wx-air-band{font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-air-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#b6bac1);vertical-align:middle}',
      '.wx-air-dot.is-good{background:var(--dsw-alias-state-success-primary,#1a7f52)}',
      '.wx-air-dot.is-moderate{background:#c8a02a}',
      '.wx-air-dot.is-poor{background:var(--dsw-alias-state-warning-primary,#b45309)}',
      '.wx-air-dot.is-bad{background:#c2410c}',
      '.wx-air-dot.is-severe{background:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.wx-sep{color:var(--dsw-alias-border-l2,rgba(0,0,0,.18))}',
      '.wx-dim{color:var(--dsw-alias-label-caption,#81858c)}',
      // The alert chip: the one element here allowed to raise its voice, and it
      // still only changes colour and weight.
      '.wx-alert{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid transparent;font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;background:transparent}',
      '.wx-alert.lv-blue{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe);background:rgba(57,100,254,.08)}',
      '.wx-alert.lv-yellow{border-color:rgba(245,158,11,.45);color:#b45309;background:rgba(245,158,11,.10)}',
      '.wx-alert.lv-orange{border-color:rgba(234,88,12,.45);color:#c2410c;background:rgba(234,88,12,.10)}',
      '.wx-alert.lv-red{border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.10);font-weight:600}',
      '.wx-alert-count{font-style:normal;opacity:.75}',
      // Click-open detail panel.
      '.wx-pop{position:absolute;top:100%;left:0;z-index:6;margin-top:7px;box-sizing:border-box;width:min(340px,78vw);display:flex;flex-direction:column;gap:6px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#ffffff);box-shadow:0 2px 6px rgba(0,0,0,.06),0 14px 32px -18px rgba(15,17,21,.5);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);text-align:left;white-space:normal}',
      '.wx-pop-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:5px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
      '.wx-pop-place{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.wx-pop-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.wx-pop-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:4px 12px}',
      '.wx-kv{display:flex;align-items:baseline;gap:6px}',
      '.wx-kv span{color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-kv b{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}',
      '.wx-pop-sec{padding-top:5px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));display:flex;flex-direction:column;gap:4px}',
      '.wx-pop-sechead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-item{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:16px}',
      '.wx-lv{flex:none;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;border:1px solid transparent}',
      '.wx-lv.lv-blue{border-color:rgba(57,100,254,.35);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.wx-lv.lv-yellow{border-color:rgba(245,158,11,.45);color:#b45309}',
      '.wx-lv.lv-orange{border-color:rgba(234,88,12,.45);color:#c2410c}',
      '.wx-lv.lv-red{border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.wx-item-title{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.wx-item-meta{flex:none;color:var(--dsw-alias-label-caption,#81858c);font-variant-numeric:tabular-nums}',
      '.wx-link{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none;border-bottom:1px dotted currentColor}',
      '.wx-hint{display:flex;flex-direction:column;gap:3px;padding:6px 8px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));font-size:11px}',
      '.wx-hint b{color:var(--dsw-alias-label-primary,#0f1115)}',
      '.wx-hint-step{position:relative;padding-left:13px;color:var(--dsw-alias-label-secondary,#61666b);word-break:break-word}',
      '.wx-hint-step::before{content:"›";position:absolute;left:3px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.wx-actions{display:flex;align-items:center;gap:8px;padding-top:4px}',
      '.wx-ghost{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.wx-ghost:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.wx-ghost:disabled{opacity:.55;cursor:default}',
      '.wx-msg{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
    ].join('')
    document.head.appendChild(tag)
  }

  const clamp = hud.clamp
  const num = hud.num

  /** Highest severity wins the inline chip; ties keep source order. */
  function worstAlert(alerts) {
    let best
    let rank = -1
    for (const alert of alerts) {
      const value = WX_LEVEL_RANK[alert?.level] ?? 0
      if (value > rank) {
        rank = value
        best = alert
      }
    }
    return best
  }

  const levelClass = (level) => `lv-${({ 蓝色: 'blue', 黄色: 'yellow', 橙色: 'orange', 红色: 'red' })[level] ?? 'blue'}`

  /** The condition in the reader's language, falling back to the Chinese one. */
  const conditionText = (current, zh) => (zh ? current.text : (current.textEn || current.text))

/** A µg/m³ reading, or `--` when the upstream omitted it. */
  const fmtAir = (value) => (num(value) === undefined ? '--' : String(Math.round(num(value) * 10) / 10))

  /**
   * The AQI band as a colour class.
   *
   * The same six EPA bands the host uses, so the dot and the WORD always agree —
   * a green dot beside 重度污染 would be worse than having no colour at all.
   */
  const airTone = (aqi) => {
    const value = num(aqi)
    if (value === undefined) return 'is-unknown'
    if (value <= 50) return 'is-good'
    if (value <= 100) return 'is-moderate'
    if (value <= 150) return 'is-poor'
    if (value <= 200) return 'is-bad'
    return 'is-severe'
  }
  const fmtTemp = (value, lang) => (num(value) === undefined ? '--' : `${Math.round(value * 10) / 10}°C`)
  const fmtSpeed = (value) => (num(value) === undefined ? '--' : `${Math.round(value * 10) / 10} km/h`)
  const fmtWind = (current, lang) => {
    if (!current) return '--'
    const direction = current.windDirection ? (lang === 'zh' ? current.windDirection.zh : current.windDirection.en) : ''
    const speed = fmtSpeed(current.windSpeed)
    const force = num(current.windForce)
    if (lang === 'zh') {
      return `${direction ? `${direction}风 ` : ''}${speed}${force === undefined ? '' : ` (${force} 级)`}`
    }
    return `${direction ? `${direction} ` : ''}${speed}${force === undefined ? '' : ` (force ${force})`}`
  }

  /**
   * The title-bar widget.
   *
   * Hook order is fixed: nothing below returns before every hook has run, so the
   * "no reading yet" / "error" / "ready" states cannot shift the hook count and
   * take the slot entry down.
   */
  function WeatherHead(props = {}) {
    const lang = hud.pickLocale()
    const zh = lang === 'zh'
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const rootRef = React.useRef(null)
    const aliveRef = React.useRef(true)

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const poll = React.useCallback(() => {
      hud.fetchJson('/dsh-hud/weather/state').then((json) => {
        if (!aliveRef.current) return
        setSnapshot(json)
        setError(null)
      }, (failure) => {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, [])

    // The refresh cadence is the host's number (10 minutes by default), clamped
    // the same way the shell clamps every other cadence.
    const refreshMs = clamp(num(snapshot?.refreshMs) ?? WX_FALLBACK_REFRESH_MS, WX_MIN_REFRESH_MS, WX_MAX_REFRESH_MS)

    React.useEffect(() => {
      poll()
      const onVisible = () => {
        if (document.visibilityState === 'visible') poll()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => document.removeEventListener('visibilitychange', onVisible)
    }, [poll])

    React.useEffect(() => {
      let stop
      try {
        if (typeof props.startTimers === 'function') {
          // No clock tick: nothing on this line counts down.
          stop = props.startTimers(poll, refreshMs, undefined, WX_CLOCK_MS)
        } else {
          const id = window.setInterval(poll, refreshMs)
          stop = () => window.clearInterval(id)
        }
      } catch (failure) {
        console.error('[wx] timer unavailable:', failure)
      }
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch {
          /* already stopped */
        }
      }
    }, [poll, refreshMs, props.startTimers])

    // Close the detail panel on a click anywhere outside it. The listener is
    // attached while open, so the click that opened it cannot close it.
    React.useEffect(() => {
      if (!open) return undefined
      const onDown = (event) => {
        if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
      }
      document.addEventListener('pointerdown', onDown)
      return () => document.removeEventListener('pointerdown', onDown)
    }, [open])

    const refresh = React.useCallback(async () => {
      if (busy) return
      setBusy(true)
      try {
        const json = await hud.fetchJson('/dsh-hud/weather/refresh', { method: 'POST' })
        if (aliveRef.current) {
          setSnapshot(json)
          setError(null)
        }
      } catch (failure) {
        if (aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    }, [busy])

    // Air quality rides along with the weather: same provider family, separate
  // failure. irError is shown beside the readings rather than replacing them.
  const air = snapshot?.air ?? null
  const airError = typeof snapshot?.airError === 'string' ? snapshot.airError : undefined
  const current = snapshot?.current
    const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : []
    const worst = worstAlert(alerts)
    const hint = snapshot?.hint
    /**
     * A 404 here has one overwhelmingly likely cause: the browser half was
     * updated (a page refresh is enough for that) while the host half is still
     * the module Node cached at startup, so `/dsh-hud/weather/*` does not exist
     * yet. Say that, instead of showing a generic failure the user cannot act on.
     */
    const routeMissing = typeof error === 'string' && /\b404\b/.test(error)
    const place = snapshot?.location
      ? [snapshot.location.name, snapshot.location.region].filter(Boolean).join(' · ')
      : ''

    // One line, in the order it was asked for: condition, temperature,
    // humidity, wind.
    const headline = current
      ? [
          `${current.glyph} ${conditionText(current, zh)}`,
          fmtTemp(current.temperature, lang),
          `${zh ? '湿度' : 'humidity'} ${num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%`}`,
          fmtWind(current, lang),
        ]
      : null

    const tooltip = current
      ? `${place ? `${place} ` : ''}${conditionText(current, zh)} ${fmtTemp(current.temperature, lang)}`
        + ` · ${zh ? '体感' : 'feels'} ${fmtTemp(current.feelsLike, lang)}`
        + ` · ${zh ? '湿度' : 'humidity'} ${num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%`}`
        + ` · ${fmtWind(current, lang)}`
        + (alerts.length > 0 ? ` · ${zh ? `${alerts.length} 条预警` : `${alerts.length} alert(s)`}` : '')
      : (routeMissing
          ? (zh ? '宿主半区还没有天气路由：重启一次 DeepSeek Harness 即可（浏览器半区刷新就够了，宿主半区不行）'
                : 'the host half has no weather route yet — restart DeepSeek Harness once (a page refresh updates the browser half only)')
          : error ? `${zh ? '天气获取失败' : 'weather failed'}: ${error}` : (zh ? '正在获取天气…' : 'loading weather…'))

    const summary = headline
      ? jsxs('button', {
          type: 'button',
          className: 'wx-btn',
          title: tooltip,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
          children: [
            jsx('span', { className: 'wx-glyph', 'aria-hidden': true, children: current.glyph }),
            jsx('span', { children: conditionText(current, zh) }),
            jsx('span', { className: 'wx-temp', children: fmtTemp(current.temperature, lang) }),
            jsx('span', { className: 'wx-sep', 'aria-hidden': true, children: '·' }),
            jsx('span', { children: `${zh ? '湿度' : 'humidity'} ${num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%`}` }),
            jsx('span', { className: 'wx-sep', 'aria-hidden': true, children: '·' }),
            jsx('span', { children: fmtWind(current, lang) }),
            // Air quality, in the head row: it is the other number that decides
            // whether the window gets opened, and the band is spelled out because
            // an AQI value alone means nothing to most people.
            air?.usAqi === undefined
              ? null
              : jsxs('span', { className: 'wx-air', title: zh ? '空气质量（美国 AQI）' : 'air quality (US AQI)', children: [
                  jsx('span', { className: 'wx-sep', 'aria-hidden': true, children: '·' }),
                  jsx('span', { className: `wx-air-dot ${airTone(air.usAqi)}`, 'aria-hidden': true }),
                  jsx('span', { children: `AQI ${Math.round(air.usAqi)}` }),
                  air.level === undefined ? null : jsx('span', { className: 'wx-air-band', children: zh ? air.level.zh : air.level.en }),
                ] }),
          ],
        })
      : jsx('button', {
          type: 'button',
          className: 'wx-btn',
          title: tooltip,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
          children: jsx('span', { className: 'wx-dim', children: routeMissing
            ? (zh ? '天气 -- 需重启宿主' : 'weather -- restart host')
            : error ? (zh ? '天气获取失败' : 'weather failed') : (zh ? '天气 --' : 'weather --') }),
        })

    return jsxs('span', {
      className: 'wx-root',
      ref: rootRef,
      'data-panel': 'weather',
      children: [
        summary,
        // An extreme-weather warning must be visible without a click.
        worst
          ? jsxs('button', {
              type: 'button',
              className: `wx-alert ${levelClass(worst.level)}`,
              title: worst.title,
              onClick: () => setOpen(true),
              children: [
                jsx('span', { 'aria-hidden': true, children: '⚠' }),
                jsx('span', { children: `${worst.phenomenon}${worst.level}${zh ? '预警' : ''}` }),
                alerts.length > 1 ? jsx('em', { className: 'wx-alert-count', children: `+${alerts.length - 1}` }) : null,
              ],
            })
          : null,
        open
          ? jsxs('div', { className: 'wx-pop', children: [
              jsxs('div', { className: 'wx-pop-head', children: [
                jsx('span', { className: 'wx-pop-place', children: place || (zh ? '未知地点' : 'unknown place') }),
                jsx('span', { className: 'wx-dim', children: current?.observedAt
                  ? `${zh ? '观测' : 'obs'} ${String(current.observedAt).slice(11, 16) || current.observedAt}`
                  : '' }),
              ] }),
              current
                ? jsxs('div', { className: 'wx-pop-grid', children: [
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '天气' : 'sky' }), jsx('b', { children: conditionText(current, zh) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '温度' : 'temp' }), jsx('b', { children: fmtTemp(current.temperature, lang) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '体感' : 'feels' }), jsx('b', { children: fmtTemp(current.feelsLike, lang) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '湿度' : 'humidity' }), jsx('b', { children: num(current.humidity) === undefined ? '--' : `${Math.round(current.humidity)}%` })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '风' : 'wind' }), jsx('b', { children: fmtWind(current, lang) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '阵风' : 'gusts' }), jsx('b', { children: fmtSpeed(current.windGust) })] }),
                    jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '降水' : 'precip' }), jsx('b', { children: num(current.precipitation) === undefined ? '--' : `${current.precipitation} mm` })] }),
                  ] })
                : null,
              // ── air quality ───────────────────────────────────────────────
              // Its own section because the numbers are read as a group, and every
              // one of them is in the same unit.
              air !== null && air !== undefined && air.usAqi !== undefined
                ? jsxs('div', { className: 'wx-pop-sec', children: [
                    jsxs('div', { className: 'wx-pop-sechead', children: [
                      jsx('span', { children: zh ? '空气质量' : 'AIR' }),
                      jsxs('span', { children: [
                        jsx('span', { className: `wx-air-dot ${airTone(air.usAqi)}`, 'aria-hidden': true }),
                        ` AQI ${Math.round(air.usAqi)}`,
                        air.level === undefined ? '' : ` ${zh ? air.level.zh : air.level.en}`,
                      ] }),
                    ] }),
                    jsxs('div', { className: 'wx-pop-grid', children: [
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: 'PM2.5' }), jsx('b', { children: fmtAir(air.pm25) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: 'PM10' }), jsx('b', { children: fmtAir(air.pm10) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '臭氧' : 'O₃' }), jsx('b', { children: fmtAir(air.ozone) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '二氧化氮' : 'NO₂' }), jsx('b', { children: fmtAir(air.no2) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '二氧化硫' : 'SO₂' }), jsx('b', { children: fmtAir(air.so2) })] }),
                      jsxs('span', { className: 'wx-kv', children: [jsx('span', { children: zh ? '一氧化碳' : 'CO' }), jsx('b', { children: fmtAir(air.co) })] }),
                    ] }),
                    jsx('span', { className: 'wx-dim', children: air.source ?? '' }),
                  ] })
                : airError === undefined
                  ? null
                  // An air outage is stated NEXT TO the weather, never instead of it.
                  : jsx('span', { className: 'wx-dim', children: `${zh ? '空气质量读取失败' : 'air failed'}：${airError}` }),
              // ── extreme weather alerts ────────────────────────────────────
              alerts.length > 0
                ? jsxs('div', { className: 'wx-pop-sec', children: [
                    jsxs('div', { className: 'wx-pop-sechead', children: [
                      jsx('span', { children: zh ? '预警' : 'ALERTS' }),
                      jsx('span', { children: `${alerts[0].scope === 'city' ? (zh ? '本地' : 'local') : (zh ? '本省' : 'province')} ${alerts.length}` }),
                    ] }),
                    ...alerts.map((alert, index) => jsxs('div', { className: 'wx-item', children: [
                      jsx('span', { className: `wx-lv ${levelClass(alert.level)}`, children: alert.level || (zh ? '预警' : 'alert') }),
                      jsx('span', { className: 'wx-item-title', children: `${alert.phenomenon || alert.title}${alert.place ? ` · ${alert.place}` : ''}` }),
                      jsx('span', { className: 'wx-item-meta', children: String(alert.issuedAt).slice(5) }),
                      alert.url
                        ? jsx('a', { className: 'wx-link', href: alert.url, target: '_blank', rel: 'noreferrer noopener', children: zh ? '详情' : 'more' })
                        : null,
                    ] }, alert.id || `a${index}`)),
                  ] })
                : jsxs('div', { className: 'wx-pop-sec', children: [
                    jsx('div', { className: 'wx-pop-sechead', children: jsx('span', { children: zh ? '预警' : 'ALERTS' }) }),
                    jsx('div', { className: 'wx-dim', children: snapshot?.alertSource === 'unsupported'
                      ? (zh ? '当前地区暂无预警数据源（目前接入中央气象台，仅中国境内）' : 'no alert source for this region (NMC covers China only)')
                      : snapshot?.alertSource === 'off'
                        ? (zh ? '预警已在设置中关闭' : 'alerts are switched off in settings')
                        : snapshot?.alertSource === 'error'
                          ? (zh ? `预警查询失败：${snapshot?.alertsError ?? ''}` : `alert lookup failed: ${snapshot?.alertsError ?? ''}`)
                          : (zh ? '本地与本省当前没有生效的预警' : 'no active alerts locally or in this province') }),
                  ] }),
              hint
                ? jsxs('div', { className: 'wx-hint', children: [
                    jsx('b', { children: hint.title }),
                    ...(hint.steps ?? []).map((step, index) => jsx('div', { className: 'wx-hint-step', children: step }, `h${index}`)),
                  ] })
                : null,
              error
                ? jsx('div', { className: 'wx-msg', children: routeMissing
                    ? (zh
                        ? '宿主半区还没加载天气路由 —— 重启一次 DeepSeek Harness。浏览器半区刷新就会更新，宿主半区不会（Node 按 URL 缓存了模块）。'
                        : 'The host half has no weather route yet — restart DeepSeek Harness. A page refresh updates the browser half only; the host module is cached by URL.')
                    : error })
                : null,
              jsxs('div', { className: 'wx-actions', children: [
                jsx('button', { type: 'button', className: 'wx-ghost', onClick: refresh, disabled: busy, children: busy ? (zh ? '刷新中…' : 'refreshing…') : (zh ? '刷新' : 'refresh') }),
                jsx('span', { className: 'wx-dim', children: zh
                  ? `每 ${Math.round(refreshMs / 60_000)} 分钟自动刷新`
                  : `auto-refresh every ${Math.round(refreshMs / 60_000)} min` }),
              ] }),
            ] })
          : null,
      ],
    })
  }

  return {
    id: 'weather',
    order: 30,
    label: { zh: '天气', en: 'Weather' },
    // Head-only: no `Component`, so this panel takes no grid column.
    head: WeatherHead,
    __test: { WeatherHead, worstAlert, fmtWind },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ── client/register.js
// ──────────────────────────────────────────────────────────────────────────

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

    return module.exports
  },
})
