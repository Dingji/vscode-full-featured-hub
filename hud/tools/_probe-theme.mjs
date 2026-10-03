// Temporary probe: what does the INSTALLED theme define for the surface tokens?
import { readFileSync } from 'node:fs'

const FILE = 'C:/Users/dingj/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'
const text = readFileSync(FILE, 'utf8')

const TOKENS = [
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-base',
  '--dsw-static-neutral-bluish-00',
]

for (const token of TOKENS) {
  const re = new RegExp(token.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;}"\']{1,70})', 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 90), m.index).replace(/\s+/g, ' ')
    console.log(`${token} = ${m[1].trim()}\n     …${before}\n`)
  }
}

// Which selectors carry the token blocks?
const blocks = text.match(/body(\[data-ds-dark-theme\])?\{[^}]{0,40000}\}/g) ?? []
console.log(`theme blocks: ${blocks.length}`)
blocks.forEach((b, i) => console.log(`  [${i}] selector head: ${b.slice(0, 40)} … len=${b.length}`))