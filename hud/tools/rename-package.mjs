// @ts-check
/**
 * Rename the package — the one operation that has to touch several files, a bundle patch, and the
 * live profile install, all consistently.
 *
 * It exists because the package name is not just a string in `package.json`:
 *
 *   `cordis.patch.yml`  DSH resolves THIS name to find the package; if it does not match the link
 *                       in the profile, startup ABORTS with `Cannot find package`
 *   profile/*.json      the dependency key, the `bundles` roster, and the node_modules link
 *
 * and because a rename must NOT touch a set of things that merely look like the package name:
 *
 *   /dsh-hud/<panel>/<action>   routes (ROUTE_PREFIX is a constant, not the package)
 *   dsh-hud/<panel>             storageDomain — renaming it discards every stored setting
 *   dsh-hud:prefs               the client cell's id, which names the localStorage key
 *   dsh-hud-sql-<id>            credential refs — renaming it orphans stored secrets
 *   the repository directory    it is the target of the profile's junction
 *
 * Usage:
 *   node tools/rename-package.mjs                  # @<npm whoami>/dsh-full-featured-hub
 *   node tools/rename-package.mjs @me/other-name   # explicit scoped name
 *   node tools/rename-package.mjs some-name        # unscoped (availability is checked)
 *   node tools/rename-package.mjs --dry-run […]    # show every change, write nothing
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'dsh-full-featured-hub'
/**
 * Where the backups of renamed files go.
 *
 * NOT beside the file: npm always ships `README*`, `LICENSE*` and `CHANGELOG*` no matter what
 * `files` says, so `README.md.bak-before-rename` was published in the 41-file tarball this tool's
 * first real run produced. A directory nothing looks in cannot be shipped by accident.
 */
const BACKUPS = join(REPO, '.rename-backups')
/**
 * Run npm, WITHOUT a shell.
 *
 * On Windows `npm` is a `.cmd`, and Node refuses to exec one directly (the fix for
 * CVE-2024-27980) — which is why this first passed in a terminal and failed inside the tool,
 * with the tool then blaming the user's login. The obvious repair, `shell: true`, works but
 * concatenates arguments unescaped (DEP0190), so instead npm's own JS entry point is run by the
 * node that is already running this script. `npm_execpath` is set whenever this runs under
 * `npm run rename`; the path beside the running node covers a direct `node tools/…`.
 */
const NPM_CLI = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((path) => typeof path === 'string' && path !== '' && existsSync(path)) ?? 'npm'

function npm(args) {
  return execFileSync(process.execPath, [NPM_CLI, ...args], { encoding: 'utf8' }).trim()
}
/** The files that carry the package name. Tools and tests are not published, so most stay out. */
const FILES = ['package.json', 'cordis.patch.yml', 'index.js', 'tools/build-client.mjs', 'README.md', 'PUBLISHING.md']
/**
 * The spans inside a line that are NOT the package name, even though they contain the same text.
 *
 * These are masked out, the name is replaced in what is left, and the spans are put back. A
 * LINE-level guard cannot do this job: the profile's dependency line is
 * `"dsh-…": "link:E:/Project/DeepseekPlugin/dsh-hud"` — the key IS the package name and must
 * change, while the path at the end merely lives in a directory with the same word in it. A
 * line-level rule got that backwards the first time it was run.
 */
const PROTECTED = [
  /\/dsh-hud\/[A-Za-z0-9_/-]*/g,        // a route
  /dsh-hud\/[A-Za-z0-9_-]+/g,           // a storageDomain
  /dsh-hud:prefs/g,                     // the browser pref key
  /dsh-hud-sql-[A-Za-z0-9_<>-]*/g,      // a credential ref prefix
  /DeepseekPlugin[\\/]dsh-hud/g,        // the repository directory
]

/** Keep a copy of a file before it is rewritten — outside anything npm can ship. */
function backup(path) {
  mkdirSync(BACKUPS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(path, join(BACKUPS, `${basename(path)}.${stamp}`))
}

/** Replace the package name in one line, leaving every PROTECTED span byte-for-byte intact. */
function renameInLine(line, current, next) {
  const kept = []
  let masked = line
  for (const pattern of PROTECTED) {
    masked = masked.replace(pattern, (match) => {
      kept.push(match)
      return `\u0001${kept.length - 1}\u0001`
    })
  }
  if (!masked.includes(current)) return { line, changed: false, keptCount: kept.length }
  const replaced = masked.split(current).join(next)
  return {
    line: replaced.replace(/\u0001(\d+)\u0001/g, (_, index) => kept[Number(index)]),
    changed: true,
    keptCount: kept.length,
  }
}

/** Rewrite the files that carry the name, and report every line that changes. */
function rewrite(current, next) {
  const changed = []
  const skipped = new Set()
  const preview = []
  for (const file of FILES) {
    const path = join(REPO, file)
    if (!existsSync(path)) continue
    let touched = false
    const out = readFileSync(path, 'utf8').split(/\r?\n/).map((line, index) => {
      if (!line.includes(current)) return line
      const result = renameInLine(line, current, next)
      if (!result.changed) {
        // Only protected spans matched: a route, a storage path, a pref key, the repo directory.
        skipped.add(`${file}: ${line.trim().slice(0, 68)}`)
        return line
      }
      touched = true
      // Names occur in prose, in a dependency key and in a patch row; a rename nobody can read
      // before it happens is a rename nobody can check afterwards.
      preview.push(`${file}:${index + 1}\n    - ${line.trim().slice(0, 96)}\n    + ${result.line.trim().slice(0, 96)}`)
      return result.line
    })
    if (!touched) continue
    if (!dryRun) {
      backup(path)
      writeFileSync(path, out.join('\n'), 'utf8')
    }
    changed.push(file)
  }
  return { changed, skipped, preview }
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const asked = argv.find((arg) => !arg.startsWith('--'))
const say = (line) => console.log(line)

/** How many files the repository holds — the check that a junction swap did not eat the target. */
function repoFileCount(dir = REPO) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) total += repoFileCount(join(dir, entry.name))
    else if (entry.isFile()) total += 1
  }
  return total
}

/** The name to move to: the argument, or this npm user's scope. */
function targetName() {
  if (asked !== undefined) {
    requireNameCharset(asked)
    return asked
  }
  let user
  try {
    user = npm(['whoami'])
  } catch (error) {
    console.error('读不到 npm 用户名：')
    console.error(`  ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
    console.error('')
    console.error('两种走法：')
    console.error('  1. 先登录，再重跑：npm login')
    console.error(`  2. 或者直接把名字传进来：node tools/rename-package.mjs @your-name/${BASE}`)
    console.error('     （用户名在 npmjs.com 右上角，或登录后 `npm whoami`）')
    process.exit(1)
  }
  if (user === '') throw new Error('npm whoami 返回了空字符串')
  return `@${user}/${BASE}`
}

/** npm's charset for a name, checked before anything reaches a shell or the registry. */
function requireNameCharset(name) {
  if (typeof name !== 'string' || name === '') throw new Error('包名是空的')
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
    throw new Error(`不是合法的 npm 包名：${name}（只允许小写字母、数字、- . _ ~，scoped 形如 @scope/name）`)
  }
  if (name.length > 214) throw new Error('包名太长（上限 214 字符）')
  return name
}

/** The charset, plus the availability question for an unscoped name. */
function validate(name) {
  requireNameCharset(name)
  if (name.startsWith('@')) {
    const scope = name.slice(1, name.indexOf('/'))
    say(`  是 scoped 名字：只有 ${scope} 这个账号/组织能发布它 —— 唯一性有保证`)
    return
  }
  let published = ''
  try {
    published = npm(['view', name, 'version'])
  } catch {
    published = '' // E404 — free
  }
  if (published !== '') throw new Error(`名字 ${name} 已被占用（npm 上是 ${published}）—— 换一个，或用 scope`)
  say('  在 npm 上还是空的（先到先得：发布之后才真正归你）')
}

/**
 * Rewrite the files that carry the name, and report the lines that were left alone.
 */

/**
 * The live profile: dependency key, bundle roster, and the link.
 *
 * The link swap uses `cmd /c rmdir` and `mklink /J`, never `Remove-Item -Recurse`: on a junction
 * that can delete the TARGET's contents, and the target here is the whole repository. The file
 * count is checked around it for the same reason.
 */
function migrateProfile(current, next) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  const notes = []
  if (!existsSync(profiles)) return ['没有 profile 目录 —— 装到别处的话请手动同步这一个名字']
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(profiles, entry.name)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const raw = readFileSync(manifest, 'utf8')
    if (!raw.includes(current)) continue

    const parsed = JSON.parse(raw)
    if (parsed.dependencies?.[current] !== undefined) {
      parsed.dependencies[next] = parsed.dependencies[current]
      delete parsed.dependencies[current]
    }
    if (Array.isArray(parsed.dsh?.profile?.bundles)) {
      parsed.dsh.profile.bundles = parsed.dsh.profile.bundles.map((one) => (one === current ? next : one))
    }
    if (!dryRun) {
      backup(manifest)
      writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    }
    notes.push(`profile ${entry.name}: dependencies 与 bundles 指向 ${next}`)

    const modules = join(dir, 'node_modules')
    if (!existsSync(modules)) { notes.push('  node_modules 不在，跳过链接'); continue }
    const oldLink = join(modules, current)
    const newLink = join(modules, next)
    if (existsSync(newLink)) { notes.push(`  链接已存在：${newLink}`); continue }
    if (!existsSync(oldLink)) { notes.push(`  没有 ${oldLink}（不是 junction 安装？）`); continue }

    const before = repoFileCount()
    if (dryRun) {
      notes.push(`  链接 ${current} → ${next}（仓库文件数 ${before}，dry-run 未改动）`)
      continue
    }
    execFileSync('cmd', ['/c', 'rmdir', oldLink])
    const scopeDir = dirname(newLink)
    if (!existsSync(scopeDir)) execFileSync('cmd', ['/c', 'mkdir', scopeDir])
    execFileSync('cmd', ['/c', 'mklink', '/J', newLink, REPO])
    const after = repoFileCount()
    if (after !== before) throw new Error(`仓库文件数变了（${before} → ${after}）—— 立刻检查 ${REPO}`)
    const linked = statSync(newLink)
    notes.push(`  链接 ${current} → ${next}（仓库文件数 ${before} 前后一致，${linked.isDirectory() ? '可读' : '异常'}）`)
  }
  return notes.length === 0 ? ['profile 里没有引用这个名字，无需改动'] : notes
}

// ── go ─────────────────────────────────────────────────────────────────────
const current = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).name
const next = targetName()
console.log(`\n包名：${current} → ${next}${dryRun ? '   （dry-run：只报告，不写文件）' : ''}\n`)
if (current === next) {
  console.log('已经是这个名字，什么都不用做。')
  process.exit(0)
}
validate(next)

console.log('\n仓库：')
const { changed, skipped, preview } = rewrite(current, next)
for (const file of changed) say(`  改写 ${file}${dryRun ? '（未落盘）' : ''}`)
if (changed.length === 0) say('  没有文件需要改')

console.log('\n每一行的前后：')
for (const block of preview) console.log(`  ${block}`)
if (preview.length === 0) console.log('  （没有行需要改）')

if (skipped.size > 0) {
  console.log('\n故意没动 —— 里面出现的只是同名的路径片段：')
  for (const line of [...skipped].slice(0, 12)) console.log(`  ${line}`)
  if (skipped.size > 12) console.log(`  …另有 ${skipped.size - 12} 行同类`)
}

console.log('\n本地安装：')
for (const note of migrateProfile(current, next)) console.log(`  ${note}`)

console.log(`
下一步：
  npm test          # 改完先跑一遍（npm publish 自己也会跑，红着发不出去）
  npm version minor # 或 patch / major
  npm publish       # 测试 → 重建 bundle → 上传
发布之后重启一次 DSH：bundle 名单是启动时读的。`)