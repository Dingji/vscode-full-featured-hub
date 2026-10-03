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