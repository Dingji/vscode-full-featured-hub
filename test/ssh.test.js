// The SSH card's host half, against a REAL SSH server.
//
// `ssh2` is a client AND a server library, so this opens an in-process server and
// has the session manager log into it: authentication, a PTY, a shell, bytes in
// both directions, a window change and a clean close. That is the whole path the
// card drives, and the only parts left to the browser are the terminal's own
// rendering.
//
// A fake at the SSH level would test the fake. The framing that actually breaks —
// base64, a Uint8Array, a resize's argument order — is exercised here for real.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { SshSessions, fingerprintOf } = require('../src/ssh')
const sshHosts = require('../src/ssh-hosts')
const { waitFor, tempDir } = require('./harness')

const USER = 'tester'
const PASSWORD = 'Str0ng!Pass'

/** An ssh2 server that authenticates one user and echoes its shell back. */
async function startFakeSshServer() {
  const { Server, utils } = require('ssh2')
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const state = { authenticated: [], ptys: [], shells: 0, window: null, closed: 0 }
  /** Live connections, so `close()` can actually finish — see the note there. */
  const clients = new Set()

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password' || ctx.username !== USER || ctx.password !== PASSWORD) {
        state.authenticated.push({ method: ctx.method, user: ctx.username, ok: false })
        // The remaining methods go WITH the rejection. A bare `reject()` tells the
        // client "no", and then neither side has anything to say: the client waits
        // to be offered a method and the server waits to be asked. That is a stall,
        // and a stall in a test looks exactly like a broken implementation.
        ctx.reject(['password'])
        return
      }
      state.authenticated.push({ method: ctx.method, user: ctx.username, ok: true })
      ctx.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (accept2, reject2, info) => {
          // (accept, reject, info) — three arguments. Naming the second one
          // `info` reads fine and silently makes every field of the real `info`
          // undefined, which is a test that passes on nothing.
          void reject2
          state.ptys.push(info)
          accept2()
        })
        session.on('window-change', (accept2, reject2, info) => {
          // (accept, reject, data) — ssh2's own `server.js` emits three arguments.
          // Binding `data` to the second slot gives you the REJECT function, which is
          // truthy, so a `waitFor(… !== null)` sails past and every field reads
          // undefined. The comment stays because the mistake is invisible.
          void reject2
          state.window = info
          accept2?.()
        })
        session.on('shell', (accept2) => {
          state.shells += 1
          const stream = accept2()
          // A greeting, then an echo — so a test can see both directions.
          stream.write('fake-ssh ready\r\n')
          stream.on('data', (chunk) => {
            if (chunk.toString('utf8').includes('exit')) {
              stream.exit(0)
              stream.end()
              return
            }
            stream.write(chunk)
          })
        })
      })
    })
    client.on('close', () => { state.closed += 1 })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    hostKey,
    state,
    /**
     * `server.close()` only stops LISTENING: a connection that is still open keeps
     * it from calling back, so an `after` hook that awaits it hangs and is reported
     * as a failed hook rather than as the teardown bug it is. Ending the live
     * connections first is what makes the callback arrive.
     */
    close: () => new Promise((resolve) => {
      for (const client of clients) {
        try {
          client.end()
        } catch { /* already gone */ }
      }
      server.close(() => resolve())
    }),
  }
}

/** Every byte the manager pushed for a session, as one string. */
function outputOf(events, id) {
  return events
    .filter((entry) => entry.event === 'ssh.data' && String(entry.payload.id) === String(id))
    .map((entry) => Buffer.from(String(entry.payload.data), 'base64').toString('utf8'))
    .join('')
}

test('the session manager logs in, streams bytes both ways, and closes', async (t) => {
  const server = await startFakeSshServer()
  t.after(() => server.close())

  const events = []
  const sessions = new SshSessions({ push: (event, payload) => events.push({ event, payload }), log: () => {} })
  t.after(() => sessions.closeAll())

  const host = {
    id: 'fake',
    name: 'fake',
    host: '127.0.0.1',
    port: server.port,
    user: USER,
    auth: 'password',
    readOnly: true,
  }

  const result = await sessions.open(host, { password: PASSWORD, cols: 100, rows: 30 })
  assert.equal(result.id, 'fake')
  // The client's FIRST attempt is `none` — a real SSH client tries it before
  // anything else — so the assertion is about the password attempt, not about
  // whatever happened to arrive first.
  assert.ok(
    server.state.authenticated.some((attempt) => attempt.method === 'password' && attempt.ok === true),
    `the password really was accepted — saw ${JSON.stringify(server.state.authenticated)}`,
  )
  assert.equal(server.state.ptys[0]?.cols, 100,
    `the PTY was opened at the size the card asked for — saw ${JSON.stringify(server.state.ptys)}`)
  assert.equal(server.state.ptys[0]?.rows, 30)
  assert.equal(server.state.ptys[0]?.term, 'xterm-256color')
  assert.equal(server.state.shells, 1)
  // The key the server presented, recorded so `hud.sshStrictHostKey` can mean
  // something on the NEXT connection.
  assert.match(result.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/)

  await waitFor(() => outputOf(events, 'fake').includes('fake-ssh ready'), { label: 'the greeting' })

  // Keystrokes go out as base64 of the typed bytes, and come back echoed.
  sessions.write('fake', Buffer.from('echo hi\r', 'utf8').toString('base64'))
  await waitFor(() => outputOf(events, 'fake').includes('echo hi'), { label: 'the echo' })

  // A non-UTF8 byte must survive the round trip: this is why the wire is base64
  // and not text, and a card that decoded as UTF-8 would corrupt exactly this.
  sessions.write('fake', Buffer.from([0xff, 0xfe, 0x41]).toString('base64'))
  await waitFor(
    () => events
      .filter((entry) => entry.event === 'ssh.data')
      .some((entry) => Buffer.from(String(entry.payload.data), 'base64').includes(Buffer.from([0xff, 0xfe, 0x41]))),
    { label: 'the raw bytes' },
  )

  assert.equal(sessions.resize('fake', 132, 43), true)
  await waitFor(() => server.state.window?.cols === 132, {
    label: `the window change (saw ${JSON.stringify(server.state.window)})`,
  })
  // ssh2's `setWindow(rows, cols, …)` is the reverse of every other call in
  // `src/ssh.js`, so the two are asserted separately: a swap gives 132 rows and 43
  // columns, which is a terminal that looks wrong only in full-screen programs.
  assert.equal(server.state.window.rows, 43, 'rows first, as ssh2 wants them')
  assert.equal(server.state.window.cols, 132)

  assert.equal(sessions.close('fake'), true)
  await waitFor(() => events.some((entry) => entry.event === 'ssh.exit'), { label: 'the exit event' })
  assert.equal(sessions.close('fake'), false, 'closing twice is not an error, it is just false')
})

test('a wrong password fails, and says so', async (t) => {
  const server = await startFakeSshServer()
  t.after(() => server.close())
  const events = []
  const sessions = new SshSessions({ push: (event, payload) => events.push({ event, payload }), log: () => {} })
  t.after(() => sessions.closeAll())

  await assert.rejects(
    sessions.open(
      { id: 'nope', name: 'nope', host: '127.0.0.1', port: server.port, user: USER, auth: 'password' },
      { password: 'wrong', cols: 80, rows: 24 },
    ),
    /authentication|All configured/i,
  )
  assert.equal(server.state.authenticated.at(-1).ok, false, 'and the server really did refuse it')
  assert.equal(sessions.sessions.size, 0, 'a failed login leaves no session behind')
})

test('two sessions to one host are refused, because one terminal has one shell', async (t) => {
  const server = await startFakeSshServer()
  t.after(() => server.close())
  const sessions = new SshSessions({ push: () => {}, log: () => {} })
  t.after(() => sessions.closeAll())

  const host = { id: 'fake', host: '127.0.0.1', port: server.port, user: USER, auth: 'password' }
  await sessions.open(host, { password: PASSWORD, cols: 80, rows: 24 })
  await assert.rejects(sessions.open(host, { password: PASSWORD, cols: 80, rows: 24 }), /已经连着了/)
})

test('a host with no usable credential is refused before any socket is opened', async () => {
  const sessions = new SshSessions({ push: () => {}, log: () => {} })
  await assert.rejects(
    sessions.open({ id: 'x', name: 'x', host: '127.0.0.1', port: 1, user: 'u', auth: 'password' }, { cols: 80, rows: 24 }),
    /没有可用的认证方式/,
  )
})

test('the fingerprint is the one ssh-keygen would print', () => {
  // A known key, hashed by the same rule: SHA256, base64, no padding.
  const key = Buffer.from('not really a key, but the hash does not care')
  const digest = require('node:crypto').createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  assert.equal(fingerprintOf(key), `SHA256:${digest}`)
  assert.equal(fingerprintOf(key).includes('='), false, 'ssh-keygen strips the padding')
})

// ── the host list ─────────────────────────────────────────────────────────
test('hosts round-trip through the panel storage, atomically', () => {
  const tmp = tempDir()
  try {
    assert.deepEqual(sshHosts.read(tmp.dir).hosts, [], 'a missing file is an empty list, not an error')

    const host = sshHosts.normalize({ host: '10.0.0.1', port: '2222', user: 'root', name: 'web' })
    sshHosts.write(tmp.dir, { hosts: [{ ...host, id: 'ssh-1' }], active: 'ssh-1' })

    const back = sshHosts.read(tmp.dir)
    assert.equal(back.hosts[0].host, '10.0.0.1')
    assert.equal(back.hosts[0].port, 2222, 'a port typed as text is stored as a number')
    assert.equal(back.active, 'ssh-1')
    assert.match(back.file, /storages[\\/]dsh-hud[\\/]ssh[\\/]state\.json$/, 'where every panel keeps its state')
    assert.equal(require('node:fs').existsSync(`${back.file}.tmp`), false, 'the temporary file does not survive')
  } finally {
    tmp.dispose()
  }
})

test('a host entry refuses what it cannot use, instead of storing it', () => {
  assert.throws(() => sshHosts.normalize({ host: '', user: 'root' }), /主机名不能为空/)
  assert.throws(() => sshHosts.normalize({ host: 'x', user: '' }), /用户名不能为空/)
  assert.throws(() => sshHosts.normalize({ host: 'x', user: 'u', port: '0' }), /1\.\.65535/)
  assert.throws(() => sshHosts.normalize({ host: 'x', user: 'u', port: 'http' }), /1\.\.65535/)

  const named = sshHosts.normalize({ host: 'x', user: 'root' })
  assert.equal(named.name, 'root@x', 'a host with no name is still selectable')
  assert.equal(named.port, 22)
  assert.equal(named.auth, 'password', 'an unknown auth kind falls back to the one that always exists')
  assert.equal(named.readOnly, false)
  assert.equal('keyFile' in sshHosts.normalize({ host: 'x', user: 'u', keyFile: '' }), false,
    'an empty path is absent, not present-and-empty')
})

test('the generated credential names are ones the store will accept', () => {
  const { CREDENTIAL_REF_PATTERN } = require('../hud/lib/sql/contract.js')
  for (const id of ['ssh-1', 'web', '2web', 'a b/c', '']) {
    assert.match(sshHosts.passwordRefFor(id), CREDENTIAL_REF_PATTERN, `${id} → password ref`)
    assert.match(sshHosts.passphraseRefFor(id), CREDENTIAL_REF_PATTERN, `${id} → passphrase ref`)
  }
})