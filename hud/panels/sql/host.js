// @ts-check
/**
 * dsh-hud › sql panel — host half.
 *
 * Browse a remote database from the card, and run one query against it. Three
 * drivers, no runtime dependencies, and the protocol work lives in `lib/sql/` where
 * it can be tested on its own — this file is only about routes, storage and secrets.
 *
 * ── what this panel refuses to pretend ──────────────────────────────────────
 *
 *   • It does not guess a connection. An empty list says "add one" instead of
 *     inventing a localhost database that probably is not there.
 *   • It does not report an unreachable database as an empty one. "0 tables" for a
 *     server that refused the login is the single most misleading thing this panel
 *     could say, so a failure is a failure.
 *   • It does not hide which read-only mechanism is in force. SQLite refuses at the
 *     file handle; PostgreSQL and MySQL refuse inside a read-only transaction. Three
 *     different guarantees, and the card names the one you have.
 *   • It does not treat `classify()` as security. That function decides what to WARN
 *     about; the server decides what actually runs.
 *
 * ── secrets ────────────────────────────────────────────────────────────────
 *
 * A connection stores a credential NAME, never a password. The name is resolved
 * through the DSH credential store at the moment of connecting, so the value never
 * enters this panel's storage, the state payload, or a log line. A name that does not
 * resolve is reported as exactly that — "password authentication failed" would send
 * someone hunting for the wrong problem.
 */
import { live, panelSettings } from '../../lib/host-kit.js';
import {
  CREDENTIAL_REF_PATTERN, DRIVER_SPECS, capabilities, cleanProfile, cleanProfiles, describeProfile,
  isCredentialRef, toCredentialRef,
  runStatement, testProfile,
} from '../../lib/sql/index.js';
import {
  MAX_HOSTS, available as sshAvailable, cleanHost, cleanHosts, probeHost, runCommand, targetOf as sshTargetOf,
} from '../../lib/ssh/client.js';
import { MAX_SESSIONS, openSession } from '../../lib/ssh/session.js';

/** A trimmed, length-capped string — the same guard the settings route uses. */
const text = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined);

export const id = 'sql';
export const order = 85;
export const label = { zh: '数据库', en: 'SQL' };
export const storageDomain = 'dsh-hud/sql';

const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 3_600_000;

/**
 * The generated settings page.
 *
 * Connections are deliberately `z.array(z.any())` and edited from the CARD: a YAML
 * list of hostnames is a terrible way to add a database, and the array cannot be
 * volatile anyway (`volatile fields require a fixed object path`). What the settings
 * page IS good for is the poll interval and a starting list that a profile can ship.
 *
 * The same goes for the SSH hosts, and for `mode` — which is the one thing here that is
 * worth writing by hand: a profile that ships this card as an SSH client can say so.
 */
export function schema(z) {
  return z.object({
    mode: live(z.union([z.const('db'), z.const('ssh')]).default('db'))
      .description('这张卡是「数据库」还是「SSH 客户端」——同一时间只有一个（db | ssh）'),
    pollMs: live(z.number().min(MIN_POLL_MS).max(MAX_POLL_MS).default(DEFAULT_POLL_MS))
      .description('schema 缓存时间（毫秒）；列目录要开一次连接，不该每次轮询都做'),
    connections: z.array(z.any()).default([])
      .description('数据库连接列表（由卡片维护）。这里只写凭据的名字，不写密码'),
    hosts: z.array(z.any()).default([])
      .description('SSH 主机列表（由卡片维护）。这里只写凭据的名字，不写密码'),
  });
}

/**
 * The settings the CARD owns.
 *
 * Connections live here rather than only in `host.config()`: they are edited from the
 * card, they must take effect immediately, and the card is where a person is looking
 * when they realise a database is missing. Credentials stay OUT — only a name.
 */
export function cleanSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // An empty field means "not supplied": `Number('')` is 0, which is finite, so clamping
  // it gave the MINIMUM — a blank poll box became 5 seconds instead of the default 60.
  // Same trap as the connection port; fixed in the same place and the same way.
  const number = (value, min, max, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  const connections = cleanProfiles(source);
  const active = typeof source.active === 'string' ? source.active.slice(0, 40) : '';
  const hosts = cleanHosts(source);
  const activeHost = typeof source.activeHost === 'string' ? source.activeHost.slice(0, 40) : '';
  return {
    /**
     * WHICH CARD THIS IS — and there is only ever one.
     *
     * `db` or `ssh`, not a set of features: a card that showed both a query box and a
     * command box would be two panels in one slot, and the person looking at it would have
     * to work out which one a button belonged to. The other side's settings are KEPT (a
     * mode switch must not delete a connection list), they are simply not rendered and not
     * polled.
     */
    mode: source.mode === 'ssh' ? 'ssh' : 'db',
    connections,
    hosts,
    pollMs: number(source.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
    // Which connection the card is looking at, remembered so a reload comes back to
    // the same database instead of the first one in the list.
    active: connections.some((entry) => entry.id === active) ? active : (connections[0]?.id ?? ''),
    // …and the same for the SSH side, which has its own list.
    activeHost: hosts.some((entry) => entry.id === activeHost) ? activeHost : (hosts[0]?.id ?? ''),
  };
}

/** Where a connection points, in words — used by the header and by errors. */
export function targetOf(connection) {
  if (connection?.driver === 'sqlite') return String(connection.file ?? '(未设置文件)');
  const database = String(connection?.database ?? '').trim();
  return `${connection?.user ?? '?'}@${connection?.host ?? '127.0.0.1'}:${Number(connection?.port ?? 0)}${database === '' ? '' : `/${database}`}`;
}

/** @param {import('../../lib/host-kit.js').PanelHost} host */
export function mount(host) {
  /**
   * The schema cache.
   *
   * In MEMORY on purpose: a cached listing is a fact about this process's view of a
   * database, not something to persist. Writing it to `state.json` would let a stale
   * schema outlive the process that could verify it.
   */
  let cache = { id: '', at: 0, payload: undefined };
  let lastResult = null;
  /** The last SSH run, kept for the same reason: a reload should not lose what you just did. */
  let lastSsh = null;
  /**
   * ── live terminals ──────────────────────────────────────────────────────────
   *
   * One per host, IN MEMORY, and deliberately not persisted: a session is a process, and a
   * `state.json` that claims a terminal is open after a restart would be a lie. The cap
   * closes the OLDEST, because the alternative is a card that quietly holds an unbounded
   * number of live shells on somebody's servers.
   */
  const sessions = new Map();
  let settingsStore;

  const cfg = () => settingsStore.read() ?? cleanSettings({});
  const pollMs = () => cfg().pollMs ?? DEFAULT_POLL_MS;

  /** One connection by id, or the active one. Throws a sentence when there are none. */
  function pick(idWanted) {
    const list = cfg().connections;
    if (list.length === 0) throw new Error('还没有连接：在卡片里点 ⚙ 添加一个');
    const wanted = typeof idWanted === 'string' && idWanted !== '' ? idWanted : cfg().active;
    return list.find((entry) => entry.id === wanted) ?? list[0];
  }

  /** One SSH host by id, or the active one — the same rule, on the other list. */
  function pickHost(idWanted) {
    const list = cfg().hosts;
    if (list.length === 0) throw new Error('还没有 SSH 主机：在卡片里点「＋ 新建主机」');
    const wanted = typeof idWanted === 'string' && idWanted !== '' ? idWanted : cfg().activeHost;
    return list.find((entry) => entry.id === wanted) ?? list[0];
  }

  /** Credentials are read HERE and nowhere else. */
  const resolve = (ref) => host.credential.resolve(ref);

  async function collect({ force = false, now = Date.now(), id: idWanted } = {}) {
    const settings = cfg();
    /**
     * WHICH CONNECTIONS WOULD ACTUALLY OPEN, asked before anyone clicks one.
     *
     * A connection whose credential was deleted (or never written) fails at connect time
     * with a sentence about a missing credential — and with several connections stored,
     * "which one is broken?" is exactly the question a manager has to answer. `present()`
     * is a read of the credential store, not of the database, so asking for every
     * connection costs nothing and opens no sockets.
     */
    const presence = await Promise.all(settings.connections.map(async (entry) => {
      if (typeof entry.passwordRef !== 'string' || entry.passwordRef === '') return 'none';
      try {
        return await host.credential.present(entry.passwordRef) === true ? 'present' : 'missing';
      } catch {
        return 'unknown';
      }
    }));
    const payload = {
      ok: true,
      now,
      // Which card this is. Reported by the database side too, because a card that can read
      // its state still needs to know when a settings patch has switched it away.
      mode: settings.mode,
      connections: settings.connections.map((entry, index) => ({ ...entry, target: targetOf(entry), credential: presence[index] })),
      active: settings.active,
      pollMs: pollMs(),
      empty: settings.connections.length === 0,
      // Which engines this process can actually use, asked rather than assumed.
      drivers: await capabilities(),
    };
    if (payload.empty) return payload;
    const connection = pick(idWanted);
    payload.active = connection.id;
    payload.target = targetOf(connection);
    payload.readOnly = connection.readOnly !== false;
    // A backstop under everything above: whatever this route waits for (a wedged
    // credential service, a server that stops answering), the CARD must get an answer
    // inside its own fetch window rather than a bare timeout with no explanation.
    const fresh = force !== true && cache.id === connection.id && now - cache.at < pollMs();
    if (fresh) return { ...payload, schema: cache.payload, cached: true };
    try {
      const described = await describeProfile(connection, { resolve });
      const schemaPayload = {
        driver: described.driver,
        info: described.info,
        target: targetOf(connection),
        schemas: described.schemas,
        readOnly: connection.readOnly !== false,
        at: Date.now(),
      };
      cache = { id: connection.id, at: Date.now(), payload: schemaPayload };
      return { ...payload, schema: schemaPayload, cached: false };
    } catch (error) {
      return { ...payload, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const guard = (req, res, methods) => {
    if (!host.sameOrigin(req)) {
      host.json(res, 403, { ok: false, error: 'cross-origin' });
      return false;
    }
    if (req.method === 'HEAD') {
      host.json(res, 200, { ok: true });
      return false;
    }
    if (!methods.includes(req.method ?? '')) {
      host.json(res, 405, { ok: false, error: 'method' });
      return false;
    }
    return true;
  };

  /**
   * A failure, in as much detail as the driver managed to extract.
   *
   * `error` alone is what the card used to get, which meant a SQL error arrived as one string
   * with its DETAIL and HINT already glued on or lost. The drivers attach what the server said
   * (`error.server`, or the fields a PostgreSQL ErrorResponse carries), so those are passed
   * through by name and the card can lay them out the way a database console does.
   */
  const fail = (res, error, status = 500) => {
    const server = error?.server ?? error?.fields;
    host.json(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      queryError: {
        message: error instanceof Error ? error.message : String(error),
        code: server?.code ?? server?.number ?? error?.code,
        detail: server?.detail ?? error?.detail,
        hint: server?.hint ?? error?.hint,
        position: server?.position ?? error?.position,
      },
    });
  };

  /** The card's poll: connections + the cached schema (or the reason there is none). */
  host.route('state', async (req, res) => {
    if (!guard(req, res, ['GET', 'POST'])) return;
    try {
      host.json(res, 200, await collect({ force: req.method === 'POST' }));
    } catch (error) {
      fail(res, error);
    }
  });

  /** Re-read the schema, skipping the cache. */
  host.route('refresh', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      cache = { id: '', at: 0, payload: undefined };
      host.json(res, 200, await collect({ force: true }));
    } catch (error) {
      fail(res, error);
    }
  });

  /** Run one statement. Read-only unless BOTH switches allow otherwise. */
  host.route('query', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const connection = pick(body?.id);
      const result = await runStatement(connection, {
        sql: String(body?.sql ?? ''),
        allowWrite: body?.allowWrite === true,
        resolve,
        limit: body?.limit,
      });
      lastResult = {
        ...result,
        at: Date.now(),
        id: connection.id,
        target: targetOf(connection),
        driver: connection.driver,
      };
      // A write can change the schema (CREATE, DROP, ALTER), so the cache goes.
      cache = { id: '', at: 0, payload: undefined };
      host.json(res, 200, { ok: true, result: lastResult });
    } catch (error) {
      // A refused or failed query is a 200 with `ok: false`: it is an ANSWER about
      // the query, not a failure of the route, and the card shows the sentence.
      fail(res, error, 200);
    }
  });

  /** Try ONE connection without saving it — what the form's test button does. */
  host.route('test', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      // The profile under test may be one that is not saved yet, which is the whole
      // point: test it before you add it.
      const profile = cleanProfile(body?.connection ?? body, 0);
      // A password typed into the form, used for THIS test only. The alternative —
      // insisting on a credential name that already exists — is what produced
      // "凭据无效" for someone who had just typed their password.
      const typed = typeof body?.password === 'string' ? body.password : '';
      const info = typed === ''
        ? await testProfile(profile, { resolve })
        : await testProfile(profile, { secrets: { password: typed } });
      host.json(res, 200, { ok: true, ...info, target: targetOf(profile) });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  /**
   * ── the SSH side of the card ───────────────────────────────────────────────
   *
   * Three routes, and one thing they deliberately do NOT pretend: there is no read-only
   * mode here. The database card can promise that it will not send a write; a shell cannot
   * promise anything about a command it was asked to run, and dressing that up as a safety
   * feature would be a lie about what a shell is. What it does promise is that everything
   * is bounded — a connect timeout, a statement deadline, an output cap — and that the
   * password never reaches a command line.
   */
  host.route('ssh/state', async (req, res) => {
    if (!guard(req, res, ['GET', 'POST'])) return;
    try {
      const settings = cfg();
      // Asked BEFORE the map, because `map` is not async: the same per-host question the
      // database list answers ("which of these would actually open?"), answered in one pass.
      const presence = await Promise.all(settings.hosts.map(async (entry) => {
        if (entry.auth !== 'password') return 'none';
        if (typeof entry.passwordRef !== 'string' || entry.passwordRef === '') return 'none';
        try {
          return await host.credential.present(entry.passwordRef) === true ? 'present' : 'missing';
        } catch {
          return 'unknown';
        }
      }));
      host.json(res, 200, {
        ok: true,
        now: Date.now(),
        mode: settings.mode,
        empty: settings.hosts.length === 0,
        activeHost: settings.activeHost,
        hosts: settings.hosts.map((entry, index) => ({
          ...entry,
          target: sshTargetOf(entry),
          credential: presence[index],
        })),
        // Asked, not assumed: a machine without an ssh client must say so here rather than
        // fail on the first command.
        capability: await sshAvailable(),
        last: lastSsh,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /** Try one host without saving it — what the editor's test button does. */
  host.route('ssh/test', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const candidate = cleanHost(body?.host ?? body, 0);
      const typed = typeof body?.password === 'string' ? body.password : '';
      const info = typed === ''
        ? await probeHost(candidate, { resolve })
        : await probeHost(candidate, { secrets: { password: typed } });
      host.json(res, 200, { ...info, target: sshTargetOf(candidate) });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  /** Run one command on one host. */
  host.route('ssh/run', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const candidate = pickHost(body?.id);
      const typed = typeof body?.password === 'string' && body.password !== '' ? body.password : undefined;
      const result = await runCommand(candidate, {
        command: String(body?.command ?? ''),
        resolve,
        secrets: typed === undefined ? undefined : { password: typed },
        timeoutMs: body?.timeoutMs,
      });
      lastSsh = {
        ...result,
        at: Date.now(),
        id: candidate.id,
        target: sshTargetOf(candidate),
        command: String(body?.command ?? ''),
      };
      host.json(res, 200, {
        ok: result.ok === true,
        result: lastSsh,
        // WHAT TO DO, not a restatement. "Host key verification failed" is true and tells
        // nobody about the checkbox that fixes it; the card shows this line as the error and
        // keeps the raw stderr in the output block, where it belongs.
        error: result.ok === true
          ? undefined
          : (result.hint ?? String(result.stderr ?? '').trim().split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-1)[0]),
      });
    } catch (error) {
      // A refused or failed command is an ANSWER about the command, not a failure of the
      // route — the same rule the query route follows.
      fail(res, error, 200);
    }
  });

  /**
   * ── the interactive session ────────────────────────────────────────────────
   *
   * Four routes, and together they are a terminal: open one, poll for what the far side has
   * printed since a cursor, send keystrokes, close it. Polling rather than a socket because
   * the panel already has a request/response transport to the host and one more mechanism
   * would be one more thing to keep working; at a second per poll it is a terminal to anyone
   * using it.
   */
  function pickSession(idWanted, { create = false } = {}) {
    const wanted = typeof idWanted === 'string' && idWanted !== '' ? idWanted : cfg().activeHost;
    if (!create) return sessions.get(wanted);
    return sessions.get(wanted);
  }

  host.route('ssh/open', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const candidate = pickHost(body?.id);
      // Already open? Answer with the one that exists rather than starting a second shell on
      // the same host — two prompts for one host is a bug a person would have to clean up.
      const existing = sessions.get(candidate.id);
      if (existing !== undefined && existing.state.status === 'open') {
        return host.json(res, 200, {
          ok: true, reused: true,
          session: { id: candidate.id, target: candidate && sshTargetOf(candidate), startedAt: existing.state.startedAt, cursor: 0 },
        });
      }
      // The cap: close the oldest before adding another.
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.state.startedAt - b.state.startedAt)[0];
        if (oldest !== undefined) {
          oldest.close('evicted');
          sessions.delete(oldest.state.id);
        }
      }
      const typed = typeof body?.password === 'string' && body.password !== '' ? body.password : undefined;
      const session = await openSession(candidate, {
        resolve,
        secrets: typed === undefined ? undefined : { password: typed },
      });
      sessions.set(candidate.id, session);
      host.json(res, 200, {
        ok: true,
        reused: false,
        session: {
          id: candidate.id,
          target: sshTargetOf(candidate),
          startedAt: session.state.startedAt,
          cursor: 0,
          cols: session.state.cols,
          rows: session.state.rows,
        },
      });
    } catch (error) {
      // A session that could not start is an ANSWER about the host, not a broken route.
      fail(res, error, 200);
    }
  });

  host.route('ssh/session', async (req, res) => {
    if (!guard(req, res, ['POST', 'GET'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const session = sessions.get(typeof body?.id === 'string' && body.id !== '' ? body.id : cfg().activeHost);
      if (session === undefined) {
        return host.json(res, 200, { ok: false, error: '这个主机上没有打开的终端', closed: true });
      }
      const read = session.read(body?.since);
      if (read.status === 'closed' && read.lost !== true) {
        // Keep it until it has been read once after closing, then forget it: a session that
        // is gone must not look open on the next poll.
        sessions.delete(session.state.id);
      }
      host.json(res, 200, { ok: true, ...read });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  host.route('ssh/input', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const session = sessions.get(typeof body?.id === 'string' && body.id !== '' ? body.id : cfg().activeHost);
      if (session === undefined) return host.json(res, 200, { ok: false, error: '这个主机上没有打开的终端' });
      // The terminal size travels with the keystrokes: it is the only moment the card knows
      // both, and a resize must reach the far side before the next redraw.
      if (body?.cols !== undefined || body?.rows !== undefined) session.resize(body?.cols, body?.rows);
      const written = session.write(body?.data);
      host.json(res, 200, { ok: true, written });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  host.route('ssh/close', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const id = typeof body?.id === 'string' && body.id !== '' ? body.id : cfg().activeHost;
      const session = sessions.get(id);
      if (session === undefined) return host.json(res, 200, { ok: true, already: true });
      session.close('asked');
      sessions.delete(id);
      host.json(res, 200, { ok: true });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  /**
   * Store a password in the DSH credential store, and answer with the NAME to reference it
   * by. The card calls this after a successful test, so the secret is only ever written
   * once it is known to work — and the connection still stores nothing but a name.
   */
  host.route('credential', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' });
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const asked = text(body?.ref, 120);
      const value = typeof body?.value === 'string' ? body.value : '';
      if (asked === undefined || asked === '') return host.json(res, 200, { ok: false, error: '缺少凭据名' });
      // REFUSED BEFORE IT IS WRITTEN. The store's rule is letters, digits and underscores: a
      // hyphen in a ref makes the credentials plugin fail to load, and that stops the whole
      // app from starting — an error nobody would trace back to a database card. Better to
      // refuse here, and to hand back a name that works.
      const ref = toCredentialRef(asked);
      if (!isCredentialRef(ref)) {
        return host.json(res, 200, {
          ok: false,
          error: `凭据名 ${asked} 无法使用：只允许字母、数字和下划线，且不能以数字开头（${CREDENTIAL_REF_PATTERN.source}）`,
        });
      }
      if (value === '') return host.json(res, 200, { ok: false, error: '密码是空的' });
      await host.credential.write(ref, value);
      host.json(res, 200, { ok: true, ref });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  /**
   * Delete a credential — the second half of deleting a connection.
   *
   * Deliberately NOT automatic: a credential can be shared by two connections (the same
   * database with and without writes, say), so removing one connection must not quietly
   * break the other. The card asks, and this route refuses outright if any REMAINING
   * connection still references the ref — the check belongs here rather than in the
   * browser, because the browser's copy of the list can be a poll behind.
   */
  host.route('credential/remove', async (req, res) => {
    if (!guard(req, res, ['POST'])) return;
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      const ref = text(body?.ref, 120);
      if (ref === undefined || !isCredentialRef(ref)) {
        return host.json(res, 200, { ok: false, error: `凭据名 ${String(body?.ref ?? '')} 不合法` });
      }
      const stillUsed = cfg().connections.filter((entry) => entry.passwordRef === ref);
      if (stillUsed.length > 0) {
        return host.json(res, 200, {
          ok: false,
          error: `还有 ${stillUsed.length} 个连接在用凭据「${ref}」（${stillUsed.map((entry) => entry.name).join('、')}），没有删除`,
        });
      }
      const where = await host.credential.remove(ref);
      host.json(res, 200, { ok: true, ref, where });
    } catch (error) {
      fail(res, error, 200);
    }
  });

  /** The card's ⚙: read, patch, or reset the connection list. */
  host.route('settings', async (req, res) => {
    if (!host.sameOrigin(req)) return host.json(res, 403, { ok: false, error: 'cross-origin' });
    if (req.method === 'GET') {
      return host.json(res, 200, {
        ok: true,
        settings: cfg(),
        fromPanelConfig: host.storage.read()?.settings === undefined,
        drivers: await capabilities(),
      });
    }
    if (req.method !== 'POST') return host.json(res, 405, { ok: false, error: 'method' });
    try {
      const body = JSON.parse((await host.readBody(req)) || '{}');
      if (body?.reset === true) {
        settingsStore.clear();
        cache = { id: '', at: 0, payload: undefined };
        lastResult = null;
        return host.json(res, 200, { ok: true, reset: true, settings: cfg() });
      }
      const patch = body?.settings && typeof body.settings === 'object' ? body.settings : body;
      const next = settingsStore.write(patch);
      // Every connection just became suspect: a changed host, user or file is a
      // different database, and reusing the old listing would be a lie.
      cache = { id: '', at: 0, payload: undefined };
      host.json(res, 200, { ok: true, settings: next });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  // The store is built BEFORE the routes: `cfg()` is called by every handler, and a
// handler that ran while the store was still undefined would throw on the first poll
// rather than at mount, which is much harder to see.
  settingsStore = panelSettings(host, { clean: cleanSettings, fallback: () => host.config() });

  host.log(`sql panel mounted at ${host.basePath}/*`);
  return {
    collect,
    lastResult: () => lastResult,
    lastSsh: () => lastSsh,
    /** Test handle: which hosts have a live terminal right now. */
    sessions: () => [...sessions.keys()],
    closeSessions: () => {
      for (const session of sessions.values()) session.close('teardown');
      sessions.clear();
    },
    connections: () => cfg().connections,
    hosts: () => cfg().hosts,
    mode: () => cfg().mode,
    /** Test handle: forget the schema cache so a test can force a real read. */
    dropCache: () => {
      cache = { id: '', at: 0, payload: undefined };
    },
  };
}

export const __test = {
  cleanSettings,
  cleanProfile,
  cleanProfiles,
  cleanHost,
  cleanHosts,
  sshTargetOf,
  MAX_HOSTS,
  targetOf,
  DRIVER_SPECS,
  capabilities,
};