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