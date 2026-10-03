// TEMPORARY harness: mount the shipped client.js in jsdom, open the weather
// popup, and dump the resulting DOM + stylesheet into a standalone page that a
// headless browser can screenshot. Used to verify popover stacking for real.
import { JSDOM } from 'jsdom'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const OUT = process.argv[2] ?? join(root, '..', 'dsh-hud-acl-recovery', 'repro')
mkdirSync(OUT, { recursive: true })

const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
})

const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal('MouseEvent', dom.window.MouseEvent)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const NOW = Date.now()
const ROUTES = {
  '/dsh-hud/weather/state': {
    ok: true,
    fetchedAt: NOW,
    refreshMs: 600_000,
    air: { usAqi: 76, level: { zh: '良', en: 'moderate' }, pm25: 24.4, pm10: 33.5, ozone: 35, no2: 43.5, so2: 7, co: 325, source: 'open-meteo air-quality' },
    location: { name: '无锡市', region: '江苏', country: '中国', countryCode: 'CN', source: 'ip', latitude: 31.5, longitude: 120.2 },
    current: {
      code: 3, text: '阴', textEn: 'overcast', glyph: '☁', temperature: 20.8, feelsLike: 21.2, humidity: 70,
      precipitation: 0, windSpeed: 8.5, windGust: 21.6, windDeg: 45, windDirection: { zh: '东北', en: 'NE' },
      windForce: 2, isDay: true, observedAt: '2026-10-01T14:15',
    },
    alerts: [{ id: 'a1', title: '大风蓝色预警', phenomenon: '大风', level: '蓝色', tone: 'info', scope: 'city', place: '无锡市', issuedAt: '2026/10/01 10:50' }],
    alertSource: 'nmc',
  },
  '/dsh-hud/market/state': {
    ok: true,
    fetchedAt: NOW,
    session: {
      cn: { label: 'A股', open: false, closed: 'holiday', closedLabel: '国庆', time: '休市' },
      hk: { label: '港股', open: true, time: '13:00-16:00' },
      us: { label: '美股', open: false, time: '21:30-04:00' },
    },
    quotes: [{ secid: '1.000001', name: '上证指数', code: '000001', price: 3842.72, changePct: 0.42 }],
    forex: [{ secid: 'fx.JPY', code: 'JPY', value: 23.5071, decimals: 4, changePct: -0.13, inverse: true }],
    selected: '1.000001',
    periods: [{ key: 'd', label: '日' }],
  },
  '/dsh-hud/market/kline': { ok: true, candles: [], period: 'd' },
  '/dsh-hud/bond/state': { ok: true, fetchedAt: NOW, quotes: [], curve: null },
}
defineGlobal('fetch', async (url) => {
  const path = String(url).split('?')[0]
  const body = ROUTES[path]
  if (body === undefined) return { ok: false, status: 404, json: async () => { throw new Error('not json') } }
  return { ok: true, status: 200, json: async () => body }
})

const loaded = []
dom.window.__ModuleLoader__ = { load(entry) { loaded.push(entry) } }
const source = readFileSync(join(root, 'client.js'), 'utf8')
await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)

const React = (await import('react')).default
const jsxRuntime = await import('react/jsx-runtime')
const exports = loaded[0].factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unknown module: ${spec}`)
})

const registrations = []
const ctx = {
  slots: { inject(name, cb) { cb() }, register(options, Component) { registrations.push({ options, Component }); return () => {} } },
  effect(cb) { return cb() },
}
exports.apply(ctx)

const { createRoot } = await import('react-dom/client')
const act = React.act ?? (async (fn) => { const r = await fn(); await new Promise((res) => setTimeout(res, 20)); return r })

const container = dom.window.document.getElementById('root')
const cell = registrations[0]
const slotProps = cell.options.inject()
slotProps.startTimers = () => () => {}

dom.window.localStorage.clear()
await act(async () => { createRoot(container).render(React.createElement(cell.Component, slotProps)) })
await act(async () => { await new Promise((res) => setTimeout(res, 80)) })

// open the weather popover
const wxButton = container.querySelector('.wx-btn')
if (wxButton === null) throw new Error('no weather button rendered')
await act(async () => { wxButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((res) => setTimeout(res, 40)) })

const pop = container.querySelector('.wx-pop')
if (pop === null) throw new Error('the weather popover did not open')

console.log('cards:', [...container.querySelectorAll('.hud-panel')]
  .map((n) => `${n.getAttribute('data-panel')}${n.hasAttribute('hidden') ? '(hidden)' : ''}`).join(', '))
console.log('card heads:', [...container.querySelectorAll('.hud-card [class$="-head"]')].map((n) => n.className).join(', '))
console.log('crashes:', [...container.querySelectorAll('.hud-crash-msg')].map((n) => n.textContent).join(' | '))

const pluginCss = [...dom.window.document.querySelectorAll('style')].map((tag) => tag.textContent).join('\n')
writeFileSync(join(OUT, 'plugin.css'), pluginCss, 'utf8')

// ── the app's own theme, straight out of the installed package ──────────────
const themeFile = 'C:/Users/dingj/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'
const themeSource = readFileSync(themeFile, 'utf8')
const blocks = themeSource.match(/body(?:\[data-ds-dark-theme\])?\{[^}]{100,60000}\}/g) ?? []
const themeCss = blocks.filter((b) => b.includes('--dsw-alias-bg-')).join('\n')
if (themeCss === '') throw new Error('could not extract the theme CSS')
writeFileSync(join(OUT, 'theme.css'), themeCss, 'utf8')

const body = container.innerHTML
  // jsdom measures every box as zero, so drop the measurement-driven inline styles
  .replace(/\sstyle="[^"]*--hud-[^"]*"/g, '')
writeFileSync(join(OUT, 'hud.html'), body, 'utf8')

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="plugin.css">
<style>
  html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base)}
  #stage{position:relative;width:744px;padding:6px 0 0}
  /* a stand-in for the transcript that scrolls behind the HUD */
  #behind{position:absolute;left:8px;top:0;width:728px;font:13px/22px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-secondary);white-space:pre-line}
  #behind b{color:var(--dsw-alias-label-primary)}
</style></head>
<body data-ds-dark-theme>
<div id="stage">
  <div id="behind">${'14:31:44 刷新 点下面的「添加单号」把单号粘进来，之后每 5 分钟刷新一次；有新的扫描记录就在标题栏和页签上标出来。\\n'.repeat(14)}</div>
  ${body}
</div>
</body></html>
`
writeFileSync(join(OUT, 'repro.html'), page, 'utf8')

console.log('dumped to', OUT)
console.log('popover:', pop.className, '| card heads:', [...container.querySelectorAll('.mk-head')].length)
console.log('styles bytes:', pluginCss.length, '| theme bytes:', themeCss.length, '| html bytes:', body.length)