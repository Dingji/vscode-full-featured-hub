/**
 * ── the SSH side of the card: the OS's own ssh, driven carefully ─────────────
 *
 * WHY NOT A HAND-WRITTEN PROTOCOL, when every other driver here is one?
 *
 * TDS, PostgreSQL, MySQL, Oracle, DB2 and the SQLite binding are all implemented in this
 * repository, on purpose, with no dependencies. SSH is the one protocol where that trade
 * goes the other way: a usable client needs a key exchange, a host-key signature check, an
 * AEAD packet layer, `ssh-userauth`, channel multiplexing and `exec` — and the failure mode
 * of getting any one of them slightly wrong is a connection that simply never authenticates,
 * with nothing to debug against. OpenSSH is already installed on every machine this runs on
 * (Windows ships it at `C:\\Windows\\System32\\OpenSSH\\ssh.exe`), it is the implementation
 * that owns `known_hosts`, the agent and every config file a person already has — and the
 * panel gains `available()` as a question it ASKS, exactly like `node:sqlite`.
 *
 * What that buys and what it costs, said plainly:
 *
 *   • it is the USER'S ssh: their agent, their ~/.ssh/config, their known_hosts. A host
 *     that works in a terminal works here, which is the whole point of a HUD panel;
 *   • it runs COMMANDS, not interactive terminals. `-T` and `-n` mean no PTY, so `ls`,
 *     `systemctl status`, `docker ps`, `tail -f`'s first page and `df -h` behave, while
 *     `vim`, `top` and a `sudo` password prompt do not;
 *   • the password never goes on a command line. It travels in the environment of the child
 *     and is printed by `askpass.cjs`, which ssh execs as its own askpass program — the
 *     mechanism OpenSSH defines for exactly this, and the only one that works without a TTY.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Where the askpass program lives. It reads the password from the child's environment. */
export const ASKPASS_SCRIPT = join(here, 'askpass.cjs')

export const DEFAULT_SSH_PORT = 22
export const DEFAULT_SSH_TIMEOUT_MS = 20_000
export const MAX_SSH_TIMEOUT_MS = 300_000
/** Cap the output a card has to render. Reported when it bites, never silently dropped. */
export const MAX_OUTPUT_BYTES = 64 * 1024

/** How many hosts one card will hold. The same shape as the database connection list. */
export const MAX_HOSTS = 12

const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined)

/**
 * A number from a form field, or the fallback — and an EMPTY STRING means "not supplied".
 *
 * `Number('')` is 0, which is finite, so clamping it gives the MINIMUM. That bug shipped
 * once already on the database side (a blank port box became port 1); it is not repeated
 * here.
 */
const count = (value, min, max, fallback) => {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** A path with no shell metacharacters worth worrying about… which is not a judgement this makes. */
const isSafeUser = (user) => /^[A-Za-z0-9._@\\-]{1,64}$/.test(String(user ?? ''))

/**
 * Decode what a child process printed.
 *
 * Two encodings meet in one stream. The REMOTE command's output is UTF-8 (it came from a
 * Linux host over the wire), while ssh's OWN messages are localized by the machine it runs
 * on — and on a Chinese Windows that is GBK, so decoding everything as UTF-8 turns
 * "不知道这样的主机" into `\262\273\326\252…`. Measured, not guessed: that is the encoding
 * this machine's ssh.exe answers DNS failures in.
 *
 * So: strict UTF-8 first, GBK when that fails, and latin1 as the last resort so nothing is
 * ever dropped silently.
 */
export function decodeOutput(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8')
  if (bytes.length === 0) return ''
  try {
    return unescapeOctal(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    /* not UTF-8 — ssh's own message, in the machine's codepage */
  }
  for (const encoding of ['gbk', 'gb18030']) {
    try {
      return unescapeOctal(new TextDecoder(encoding).decode(bytes))
    } catch {
      /* this Node has no such decoder */
    }
  }
  return unescapeOctal(bytes.toString('latin1'))
}

/**
 * Turn `\262\273\326\252` back into text.
 *
 * Microsoft's ssh.exe does not print its localized messages as bytes at all — it prints the
 * BYTES AS OCTAL ESCAPES, so a failed DNS lookup arrives as the literal ASCII
 * `\262\273\326\252\265\300…` instead of `不知道这样的主机`. Decoding that as UTF-8 (or as
 * GBK, or as anything) cannot help, because the bytes are not there any more. This puts
 * them back, then decodes the run for real. Measured against this machine's ssh.exe.
 */
function unescapeOctal(text) {
  if (!/\\[0-7]{3}/.test(text)) return text
  const parts = text.split(/((?:\\[0-7]{3})+)/)
  return parts
    .map((part) => {
      if (!/^(?:\\[0-7]{3})+$/.test(part)) return part
      const bytes = Buffer.from(part.match(/\\[0-7]{3}/g).map((one) => Number.parseInt(one.slice(1), 8)))
      for (const encoding of ['utf-8', 'gbk', 'gb18030']) {
        try {
          return new TextDecoder(encoding, { fatal: true }).decode(bytes)
        } catch {
          /* try the next one */
        }
      }
      return bytes.toString('latin1')
    })
    .join('')
}

/**
 * Find the programs this panel needs, once.
 *
 * `ssh` is looked for where Windows keeps it and then on PATH; the askpass program is a
 * node binary, and the one running THIS process is not always usable (inside a packaged
 * desktop app it is the app's own executable, which would start a second HUD instead of
 * printing a password). So the candidates are checked for existence and, when the running
 * executable is a real node, it is preferred.
 */
function candidates() {
  const ssh = [
    process.env.DSH_HUD_SSH,
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    '/usr/bin/ssh',
    '/usr/local/bin/ssh',
  ].filter((path) => typeof path === 'string' && path !== '')

  /**
   * A node for the askpass program.
   *
   * The one running THIS process is preferred, but inside a packaged desktop app
   * `process.execPath` is the app's own executable — running that with ssh's prompt as an
   * argument would start a second HUD. So the runtime that ships WITH the app is derived
   * from where that executable lives (never from a user name), and the system installs are
   * the fallback.
   */
  const beside = (() => {
    try {
      const appRoot = dirname(process.execPath)
      return join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    } catch {
      return undefined
    }
  })()

  const node = [
    process.env.DSH_HUD_NODE,
    beside,
    process.execPath,
    'C:\\Program Files\\nodejs\\node.exe',
    '/usr/bin/node',
    '/usr/local/bin/node',
  ].filter((path) => typeof path === 'string' && path !== '')
  return { ssh, node }
}

/** The first candidate that exists, or `undefined`. */
const firstExisting = (list) => list.find((path) => {
  try {
    return existsSync(path)
  } catch {
    return false
  }
})

/**
 * What this process can do, asked rather than assumed.
 *
 * `ssh -V` writes its version to STDERR (a detail worth knowing before parsing it) and
 * exits 0; a missing binary throws ENOENT, which is the answer "no" rather than a crash.
 */
export async function available() {
  const { ssh, node } = candidates()
  const binary = firstExisting(ssh) ?? (onPath('ssh') ? 'ssh' : undefined)
  if (binary === undefined) {
    return { ok: false, reason: '这个系统上没有找到 ssh 客户端（Windows 自带 OpenSSH，或 PATH 里的 ssh）' }
  }
  const askpassNode = firstExisting(node) ?? (onPath(process.platform === 'win32' ? 'node.exe' : 'node') ? 'node' : undefined)
  if (askpassNode === undefined) {
    return { ok: false, reason: '没有找到可用于 askpass 的 node（密码认证需要它；密钥认证可以不用）' }
  }
  const probed = spawnSync(binary, ['-V'], { encoding: 'utf8', timeout: 5_000 })
  const version = String(probed.stderr ?? probed.stdout ?? '').trim().split('\n')[0]
  if (probed.error !== undefined && probed.error !== null) {
    return { ok: false, reason: `ssh 无法执行：${probed.error.message}` }
  }
  return { ok: true, ssh: binary, node: askpassNode, version }
}

/** A cheap PATH lookup that does not need a shell. */
function onPath(name) {
  const dirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  return dirs.some((dir) => {
    if (dir === '') return false
    try {
      return existsSync(join(dir, name))
    } catch {
      return false
    }
  })
}

/** Normalise one host profile out of stored settings. */
export function cleanHost(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const id = text(source.id, 40) || `host-${index + 1}`
  return {
    id,
    name: text(source.name, 60) || id,
    host: text(source.host, 200) || '127.0.0.1',
    port: count(source.port, 1, 65_535, DEFAULT_SSH_PORT),
    user: (text(source.user, 64) ?? '').replace(/[^A-Za-z0-9._@-]/g, ''),
    // `password` | `key` | `agent`. Absent means agent: on a machine where `ssh` already
    // works, it is the one that needs nothing typed.
    auth: ['password', 'key', 'agent'].includes(String(source.auth)) ? String(source.auth) : 'agent',
    keyPath: text(source.keyPath, 400) ?? '',
    // A NAME, never a secret — the same rule as the database connections.
    passwordRef: text(source.passwordRef, 120),
    /**
     * Off by default, and it is a security decision rather than a convenience:
     * `StrictHostKeyChecking=yes` means an unknown or changed host key REFUSES to connect,
     * which is what the user's own ssh does with their known_hosts.
     */
    acceptNewHostKey: source.acceptNewHostKey === true,
    timeoutMs: count(source.timeoutMs, 2_000, MAX_SSH_TIMEOUT_MS, DEFAULT_SSH_TIMEOUT_MS),
  }
}

/** Every host in a settings blob, in the order given. */
export function cleanHosts(raw) {
  const list = Array.isArray(raw?.hosts) ? raw.hosts : []
  return list.slice(0, MAX_HOSTS).map((entry, index) => cleanHost(entry, index))
}

/** Where a host points, in words. */
export function targetOf(host) {
  const user = String(host?.user ?? '') === '' ? '' : `${host.user}@`
  return `${user}${host?.host ?? '?'}:${Number(host?.port ?? DEFAULT_SSH_PORT)}`
}

/**
 * The options EVERY ssh invocation here shares — the whole contract with ssh, in one place.
 *
 * Split out because there are now two callers with opposite needs: a one-shot command wants
 * no terminal and no stdin, while an interactive session wants a terminal on both sides.
 * Everything else — port, connect timeout, host-key policy, which authentication methods may
 * be tried — must be identical between them, and the way to guarantee that is to have one
 * copy of it.
 */
export function sshPolicyArgs(host) {
  const args = []
  args.push('-p', String(Number(host.port ?? DEFAULT_SSH_PORT)))
  args.push('-o', `ConnectTimeout=${Math.max(2, Math.min(60, Math.round((host.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS) / 1000)))}`)
  args.push('-o', 'NumberOfPasswordPrompts=1')
  // The destination comes LAST, after `--`, so a host or user that starts with `-` cannot be
  // read as an option.
  args.push('-o', `StrictHostKeyChecking=${host.acceptNewHostKey === true ? 'accept-new' : 'yes'}`)
  if (host.auth === 'key' && String(host.keyPath ?? '') !== '') {
    args.push('-i', String(host.keyPath))
    args.push('-o', 'IdentitiesOnly=yes')
    args.push('-o', 'PreferredAuthentications=publickey')
  } else if (host.auth === 'password') {
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive')
    args.push('-o', 'PubkeyAuthentication=no')
  } else {
    // Agent without a terminal: a missing key FAILS instead of prompting, which is the
    // difference between an error message and a request that never returns. An interactive
    // session drops this one option — see lib/ssh/session.js — because a session is exactly
    // the case where a prompt has somewhere to go.
    args.push('-o', 'BatchMode=yes')
  }
  return args
}

/** The destination argument, guarded against a user name that would read as an option. */
export const destinationOf = (host) => `${isSafeUser(host.user) ? host.user : ''}@${host.host}`

/**
 * The argv for one one-shot command. Exported because it is the whole contract with ssh and
 * a test can pin every flag without opening a socket.
 */
export function sshArgs(host, command) {
  return [
    ...sshPolicyArgs(host),
    // No PTY and no stdin: this runs COMMANDS. `-T` keeps ssh from asking for a terminal and
    // `-n` gives the child /dev/null on stdin, so nothing can block waiting for input that
    // can never arrive. An interactive session passes `-tt` instead.
    '-T', '-n',
    '--', destinationOf(host), command,
  ]
}

/** The environment one ssh run gets: the askpass wiring, and never a password in argv. */
export function sshEnv(host, password) {
  const env = { ...process.env }
  if (host.auth === 'password' && typeof password === 'string' && password !== '') {
    const node = firstExisting(candidates().node) ?? 'node'
    env.SSH_ASKPASS = node
    // `force` is what makes ssh use askpass with no DISPLAY and no TTY — without it the
    // program is only consulted on a machine that has an X display.
    env.SSH_ASKPASS_REQUIRE = 'force'
    // NODE_OPTIONS does NOT support quoting, so the path is passed bare. The preload
    // prints the password and exits before node tries to run the "script" ssh names.
    env.NODE_OPTIONS = `--require ${ASKPASS_SCRIPT}`
    env.DSH_SSH_PASSWORD = password
  } else {
    delete env.DSH_SSH_PASSWORD
  }
  return env
}

/**
 * Resolve a host's secret, or nothing.
 *
 * A named credential that does not resolve is worth SAYING, exactly as on the database
 * side: "permission denied" would send someone hunting for the wrong problem.
 */
async function secretFor(host, { resolve, secrets } = {}) {
  const literal = typeof secrets?.password === 'string' && secrets.password !== '' ? secrets.password : undefined
  if (literal !== undefined) return literal
  if (host.auth !== 'password') return undefined
  const ref = host.passwordRef
  if (typeof ref !== 'string' || ref === '') {
    throw new Error('这个主机用密码认证，但没有可用的密码：在卡片里填一次，或给它一个凭据名')
  }
  if (typeof resolve !== 'function') throw new Error(`凭据「${ref}」没有找到（这个进程没有凭据库）`)
  const value = await resolve(ref)
  if (typeof value !== 'string' || value === '') {
    throw new Error(`凭据「${ref}」没有找到（检查 DSH 的凭据库，或重新填一次密码）`)
  }
  return value
}

/**
 * What ssh's own message MEANS, in terms of what to do about it.
 *
 * The first thing everyone meets with this card is
 *
 *     No ED25519 host key is known for 198.51.100.20 and you have requested strict checking.
 *     Host key verification failed.
 *
 * which is correct, secure, and says nothing about the checkbox that fixes it. The strings
 * below are copied from a real Windows OpenSSH 9.5p2 talking to a real Ubuntu host — not
 * invented — and each is answered with the ACTION rather than a restatement.
 * @returns {string|undefined} a sentence to show, or nothing when ssh already said enough
 */
export function explainSshFailure(stderr, code) {
  const text = String(stderr ?? '')
  const has = (pattern) => pattern.test(text)
  if (has(/Host key verification failed|No .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i)) {
    return '这台机器的密钥不在 known_hosts 里（或者变了）。第一次连它请打开编辑器里的「接受新主机密钥」，也可以先在终端 ssh 一次让它记住'
  }
  if (has(/Permission denied/i)) {
    return '密码或密钥不对（也可能是这个用户不允许密码登录：有些服务器只认密钥）'
  }
  if (has(/Connection refused/i)) return '这台机器上没有 ssh 服务在听 —— 端口填对了吗？'
  if (has(/Connection timed out|No route to host|Network is unreachable/i)) {
    return '网络不通 —— 需要 VPN？还是防火墙挡了 22 端口？'
  }
  if (has(/Could not resolve hostname/i)) return '主机名解析不了 —— 拼写对吗？'
  if (has(/Too many authentication failures/i)) {
    return '认证尝试次数太多 —— 代理里可能挂了太多密钥，用「密钥文件」方式更稳'
  }
  if (has(/Connection closed by|kex_exchange_identification/i)) {
    return '连上了，但对端没把 SSH 握手说完 —— 可能是防火墙、跳板机，或者那台机器在限速'
  }
  return undefined
}

/**
 * Run one command on one host.
 *
 * Everything here is bounded on purpose: a connect timeout inside ssh, an overall deadline
 * outside it, an output cap, and a kill that leaves nothing running. The whole session —
 * spawn, auth, command, exit — is one child process, because running a command per
 * connection is exactly what this card does and what a pooled connection would have to
 * pretend to be.
 */
export async function runCommand(host, { command, secrets, resolve, timeoutMs } = {}) {
  const capability = await available()
  if (capability.ok !== true) throw new Error(capability.reason ?? 'ssh 不可用')

  const text_ = String(command ?? '').trim()
  if (text_ === '') throw new Error('命令是空的')
  if (text_.length > 4_000) throw new Error('命令太长（上限 4000 字符）')

  const started = Date.now()
  const budget = count(timeoutMs ?? host.timeoutMs, 2_000, MAX_SSH_TIMEOUT_MS, DEFAULT_SSH_TIMEOUT_MS)
  const password = await secretFor(host, { resolve, secrets })
  const args = sshArgs(host, text_)
  const env = sshEnv(host, password)

  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(capability.ssh, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolveRun({ ok: false, error: `无法启动 ssh：${error instanceof Error ? error.message : String(error)}`, ms: Date.now() - started })
      return
    }

    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let settled = false
    const collect = (bucket, chunk) => {
      const size = chunk.length
      if (bucket === out) {
        outBytes += size
        if (outBytes > MAX_OUTPUT_BYTES) { truncated = true; return }
      } else {
        errBytes += size
        if (errBytes > MAX_OUTPUT_BYTES) { truncated = true; return }
      }
      bucket.push(chunk)
    }
    child.stdout?.on('data', (chunk) => collect(out, chunk))
    child.stderr?.on('data', (chunk) => collect(err, chunk))

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = decodeOutput(Buffer.concat(out))
      const stderr = decodeOutput(Buffer.concat(err))
      resolveRun({
        ...result,
        ms: Date.now() - started,
        truncated,
        stdout,
        stderr,
        // A failed run carries WHAT TO DO as well as what ssh said — the card shows the hint
        // as the error and the raw text in the output block, so both are available where
        // they belong.
        hint: result.ok === true ? undefined : explainSshFailure(stderr, result.code),
      })
    }

    // A deadline OUTSIDE ssh as well: ConnectTimeout covers the connect, not a command that
    // hangs after it (`tail -f`, a mount that stopped answering, a server that went away).
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({
        ok: false,
        code: null,
        error: `超过 ${Math.round(budget / 1000)} 秒没有结束，已经断开（注意：远端那条命令可能还在跑）`,
      })
    }, budget)
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (error) => finish({ ok: false, code: null, error: `ssh 出错：${error.message}` }))
    child.on('close', (code) => finish({ ok: code === 0, code }))
  })
}

/**
 * Try a host without running anything that matters.
 *
 * `echo` is the whole test: it proves the transport, the key or password, and the host key
 * policy — and it is a command that exists on every shell this will meet. What it does not
 * prove is that the host is the one the user thinks it is; that is what the host key check
 * is for, and it runs before this does.
 */
export async function probeHost(host, { resolve, secrets } = {}) {
  const result = await runCommand(host, { command: 'echo dsh-hud-ssh-ok', resolve, secrets })
  const capability = await available()
  if (result.ok !== true) {
    const said = String(result.stderr ?? '').trim().split('\n').map((line) => line.trim()).filter((line) => line !== '')
    // WHAT TO DO FIRST, then what ssh said. The other order buries the answer under the
    // sentence a person has already read and not understood.
    const hint = explainSshFailure(result.stderr, result.code)
    const raw = result.error ?? said.slice(-1)[0] ?? `ssh 退出码 ${result.code}`
    return {
      ok: false,
      error: hint === undefined ? raw : `${hint}（ssh 说：${raw}）`,
      hint,
      code: result.code,
      ms: result.ms,
    }
  }
  return {
    ok: true,
    ms: result.ms,
    target: targetOf(host),
    version: capability.version,
    // The answer the remote shell actually produced, so a card can show that something
    // came back rather than only that nothing failed.
    answered: String(result.stdout ?? '').trim(),
  }
}