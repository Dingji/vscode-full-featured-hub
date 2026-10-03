/**
 * ── a real interactive session, not a command runner ─────────────────────────
 *
 * The command box answers "run this and show me what came back". That is not a terminal:
 * `cd` does not stick, a `sudo` prompt has nowhere to go, `top` has no screen, and an editor
 * cannot open. This is the other thing — one `ssh -tt` process kept alive for as long as the
 * person is using it, with keystrokes going in and the terminal's own output coming back.
 *
 * Three decisions worth stating, because each one is where this could have gone wrong:
 *
 * 1. **`-tt` forces a remote PTY**, so the far side runs an interactive shell with job
 *    control, colours and prompts. Our side has no TTY (the panel is a web page), so
 *    OpenSSH is told the terminal size separately — see {@link resize} — and apps that ask
 *    believe they are on an 80x24 until the card says otherwise.
 *
 * 2. **The password still goes through askpass, not the PTY.** `SSH_ASKPASS_REQUIRE=force`
 *    makes ssh consult the askpass program *even when a terminal is available*, which is
 *    exactly this case: the session gets a PTY for the shell, and the login password never
 *    appears in the stream, in a prompt, or in the scrollback. `sudo` inside the session is
 *    the user's own business — that prompt is theirs to answer, and it is answered by typing
 *    into the terminal like any other.
 *
 * 3. **Output is a ring buffer with absolute offsets.** The card polls for "what is new
 *    since cursor N", so a slow poll cannot lose bytes and a screen nobody is watching
 *    cannot grow without bound. When the reader falls behind further than the buffer, it is
 *    TOLD (a `lost` flag) rather than shown a stream with a hole in it.
 */
import { spawn } from 'node:child_process'
import { available, destinationOf, sshPolicyArgs, sshEnv, targetOf, decodeOutput } from './client.js'

/** How much scrollback one session keeps, in bytes. */
export const SESSION_BUFFER_BYTES = 256 * 1024
/** How long a session may sit with no input before it is closed. */
export const SESSION_IDLE_MS = 15 * 60_000
/** The terminal the card claims to be, until it says otherwise. */
export const DEFAULT_COLS = 100
export const DEFAULT_ROWS = 30
/** One card shows one terminal per host; this many hosts may stay open at once. */
export const MAX_SESSIONS = 3

/**
 * The argv for an interactive session.
 *
 * Same policy as the command runner (host keys strict unless the host says otherwise, one
 * password prompt, `--` before the destination) with three differences that ARE the feature:
 * `-tt` asks for a PTY on both sides, there is no command to run, and keepalives are on so a
 * connection that died is noticed instead of looking like an idle terminal.
 */
export function sessionArgs(host, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  /**
   * The remote PTY's size has to be SET, because there is no local terminal to ask.
   *
   * The panel is a web page: `ssh` would normally read the window size from the terminal it
   * was started in, find none, and tell the far side `0 0` — measured, not guessed:
   * `stty size` in a session opened without this answered exactly that. A shell survives it,
   * but `top`, `less` and anything that draws a screen do not.
   *
   * `RemoteCommand` runs this on the far side before the session's shell starts, so the size
   * is right from the first prompt — and unlike typing `stty` INTO the shell, it never
   * appears as if the user had typed it. `exec` keeps it a real login shell: the process the
   * PTY talks to is the user's own `$SHELL`, not a wrapper.
   */
  const sizing = `stty cols ${Math.max(20, Math.min(400, Number(cols) || DEFAULT_COLS))} rows ${Math.max(5, Math.min(200, Number(rows) || DEFAULT_ROWS))} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`
  return [
    // A PTY on BOTH sides, and no command: that is the whole difference from the one-shot
    // runner. `ssh host` with no command starts the login shell.
    '-tt',
    // `BatchMode=yes` is dropped: it exists to make a one-shot command fail instead of
    // hanging on a prompt, and a session is the case where a prompt belongs.
    ...sshPolicyArgs(host).filter((arg) => arg !== 'BatchMode=yes'),
    // A connection that died must be noticed. Without keepalives a terminal on a laptop that
    // changed networks looks exactly like an idle one.
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', `RemoteCommand=${sizing}`,
    '--', destinationOf(host),
  ]
}

/**
 * Open one interactive session.
 *
 * `spawnTarget` exists as a seam for the tests: it is the same `{ file, args }` shape the
 * real spawn uses, so the session's buffering, polling, writing and closing can be driven by
 * a real child process in the suite without a network host. Production never passes it.
 */
export async function openSession(host, { secrets, resolve, idleMs = SESSION_IDLE_MS, spawnTarget } = {}) {
  const capability = await available()
  if (capability.ok !== true) throw new Error(capability.reason ?? 'ssh 不可用')

  /**
   * The password, and the askpass wiring, belong to the REAL ssh child.
   *
   * When a `spawnTarget` is given (the seam the tests use) the child is a local process — and
   * the askpass preload would ambush it: `NODE_OPTIONS=--require askpass.cjs` applies to any
   * node child, so a fake shell started with `node` printed the PASSWORD and exited before
   * running a single line. Measured, after chasing an empty read for a while.
   */
  const viaSeam = spawnTarget !== undefined
  const password = viaSeam
    ? undefined
    : (typeof secrets?.password === 'string' && secrets.password !== ''
      ? secrets.password
      : (host.auth === 'password' && typeof resolve === 'function' && host.passwordRef
        ? await resolve(host.passwordRef)
        : undefined))
  if (!viaSeam && host.auth === 'password' && (typeof password !== 'string' || password === '')) {
    throw new Error(host.passwordRef
      ? `凭据「${host.passwordRef}」没有找到（检查 DSH 的凭据库，或重新填一次密码）`
      : '这个主机用密码认证，但没有可用的密码：在卡片里填一次，或给它一个凭据名')
  }

  const target = spawnTarget ?? { file: capability.ssh, args: sessionArgs(host) }
  const child = spawn(target.file, target.args, {
    env: viaSeam ? { ...process.env } : sshEnv(host, password),
    windowsHide: true,
    // The session OWNS stdin: that is the keyboard.
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const state = {
    id: host.id,
    hostId: host.id,
    target: targetOf(host),
    startedAt: Date.now(),
    lastInputAt: Date.now(),
    lastOutputAt: Date.now(),
    /** Absolute byte offsets: `produced` counts everything, `from` is where the buffer starts. */
    produced: 0,
    from: 0,
    buffer: Buffer.alloc(0),
    status: 'open',
    exitCode: null,
    error: null,
    /** Everything the child printed goes through here, stdout first: a terminal has one stream. */
  }

  const append = (chunk) => {
    state.produced += chunk.length
    state.lastOutputAt = Date.now()
    state.buffer = Buffer.concat([state.buffer, chunk])
    if (state.buffer.length > SESSION_BUFFER_BYTES) {
      const drop = state.buffer.length - SESSION_BUFFER_BYTES
      state.buffer = state.buffer.subarray(drop)
      state.from += drop
    }
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', (error) => {
    state.status = 'closed'
    state.error = `ssh 出错：${error.message}`
  })
  child.on('close', (code) => {
    state.status = 'closed'
    state.exitCode = code
  })

  /**
   * The idle timer. A terminal left open on a laptop that went to sleep is a live shell on
   * somebody's server; after {@link SESSION_IDLE_MS} with no input it is closed, and the card
   * says why rather than showing a prompt that no longer works.
   */
  const idle = setInterval(() => {
    if (state.status !== 'open') return
    if (Date.now() - state.lastInputAt > idleMs) {
      state.error = `闲置超过 ${Math.round(idleMs / 60_000)} 分钟，已经断开`
      close('idle')
    }
  }, 30_000)
  if (typeof idle.unref === 'function') idle.unref()

  const close = (reason) => {
    clearInterval(idle)
    if (state.status === 'open') {
      state.status = 'closed'
      state.closedBecause = reason
      try { child.stdin?.end() } catch { /* already gone */ }
      try { child.kill() } catch { /* already gone */ }
    }
    return state
  }

  return {
    state,
    /** Send keystrokes. Bounded: one paste should not be able to fill the socket. */
    write(data) {
      const text = String(data ?? '')
      if (text === '' || state.status !== 'open') return 0
      const capped = text.length > 8_192 ? text.slice(0, 8_192) : text
      state.lastInputAt = Date.now()
      try {
        child.stdin?.write(capped)
      } catch {
        /* the pipe is gone; the close handler will say so */
      }
      return capped.length
    },
    /** The card's terminal size, so `top` and friends draw the right shape. */
    resize(cols, rows) {
      state.cols = Math.max(20, Math.min(400, Number(cols) || DEFAULT_COLS))
      state.rows = Math.max(5, Math.min(200, Number(rows) || DEFAULT_ROWS))
    },
    /**
     * What is new since `since`, decoded for a terminal (not for a log): UTF-8 first, GBK when
     * that fails — the same rule the one-shot runner uses, because ssh's own messages come
     * from the machine this runs on.
     */
    read(since = 0) {
      const cursor = Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0
      const lost = cursor < state.from
      const start = Math.max(cursor, state.from) - state.from
      return {
        status: state.status,
        cursor: state.produced,
        lost,
        data: lost ? '' : decodeOutput(state.buffer.subarray(start)),
        exitCode: state.exitCode,
        error: state.error,
        startedAt: state.startedAt,
        lastOutputAt: state.lastOutputAt,
        target: state.target,
      }
    },
    close,
  }
}