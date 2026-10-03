// Diagnose why evaluating media/react.js inside jsdom cannot see `window`.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

const ROOT = join(__dirname, '..')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const w = dom.window

console.log('typeof w.eval        :', typeof w.eval)
console.log('eval sees window     :', w.eval('typeof window'))
console.log('eval sees document   :', w.eval('typeof document'))
console.log('eval sees globalThis :', w.eval('typeof globalThis'))

// Reproduce the test's exact sequence: react.js first, then a window lookup.
const react = readFileSync(join(ROOT, 'media', 'react.js'), 'utf8')
console.log('react.js lines       :', react.split('\n').length)
try {
  w.eval(react)
  console.log('after react.js, typeof window :', w.eval('typeof window'))
  console.log('after react.js, window.__hudReact :', typeof w.eval('__hudReact'))
} catch (error) {
  console.log('react.js eval FAILED —', error.message)
}

const runtime = readFileSync(join(ROOT, 'media', 'runtime.js'), 'utf8')
try {
  w.eval(runtime)
  console.log('runtime.js eval      : OK')
} catch (error) {
  console.log('runtime.js eval      : FAILED —', error.message)
}
w.close()