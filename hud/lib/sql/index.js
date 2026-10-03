/**
 * ── the SQL panel's engine room: one registry, six drivers, no dependencies ──
 *
 * This module is the only thing the PANEL talks to, so the panel never needs to know
 * whether a value came from a file, a socket or a subprocess. What it does own is the
 * part that must not vary per driver:
 *
 *   • ONE statement per call, enforced before a driver ever sees it;
 *   • the row cap, applied while READING (a bolted-on `LIMIT` would silently answer a
 *     different question for a `UNION`, a CTE or an `ORDER BY`);
 *   • the timeout, clamped, and passed down as the driver can honour it;
 *   • credentials resolved from the credential store by NAME, so a password never
 *     reaches the settings file, the browser, or a log line;
 *   • the read-only decision, with each driver enforcing it the way ITS server can.
 *
 * ── about read-only ──────────────────────────────────────────────────────────
 * The three drivers enforce it in three genuinely different ways, and the card says
 * which one is in force rather than implying they are equivalent:
 *
 *   sqlite    a read-only FILE HANDLE — the engine refuses the write.
 *   postgres  `BEGIN TRANSACTION READ ONLY` — the server refuses the write.
 *   mysql     `START TRANSACTION READ ONLY` — the server refuses the write.
 *   sqlserver NOTHING on the server side: SQL Server has no read-only transaction, so
 *             the refusal happens HERE, before the statement is sent. That is a weaker
 *             guarantee than the other three and the card says so in as many words.
 *   oracle    the same: \`SET TRANSACTION READ ONLY\` exists but applies to a transaction this
 *             driver does not hold open across calls.
 *   db2       the same again: \`FOR READ ONLY\` is a property of a CURSOR, and this driver keeps
 *             no cursor between calls.
 *
 * `classify()` is used only to WARN, never to permit: `WITH x AS (DELETE … RETURNING
 * *) SELECT …` starts with `WITH`, and no amount of regex makes that safe.
 */
import {
  CREDENTIAL_REF_PATTERN, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_MS, DRIVER_SPECS,
  clampLimit, clampTimeout, classify, isCredentialRef, splitStatements, toCredentialRef,
} from './contract.js';
import * as sqlite from './sqlite.js';
import * as postgres from './pg.js';
import * as mysql from './mysql.js';
import * as tds from './tds.js';
import * as oracle from './oracle.js';
import * as db2 from './db2.js';

/** The loaded drivers, by id. */
const DRIVERS = {
  sqlite,
  postgres,
  mysql,
  sqlserver: tds,
  oracle,
  db2,
};

export {
  CREDENTIAL_REF_PATTERN, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_MS, DRIVER_SPECS,
  classify, clampLimit, clampTimeout, isCredentialRef, splitStatements, toCredentialRef,
};

/** The driver module for an id, or `undefined` — no exception for a typo. */
export function driverFor(id) {
  return DRIVERS[String(id ?? '')];
}

/**
 * What this process can actually do, right now.
 *
 * `available()` is ASKED rather than assumed: SQLite depends on the Node running this
 * (`node:sqlite` is recent), and a card that claims support it does not have is worse
 * than one that says why. The other two need nothing but a socket.
 */
export async function capabilities() {
  const out = [];
  for (const spec of DRIVER_SPECS) {
    const driver = DRIVERS[spec.id];
    let verdict = { ok: false, reason: '驱动未加载' };
    try {
      verdict = await driver.available();
    } catch (error) {
      verdict = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    out.push({
      id: spec.id,
      label: spec.label,
      labelZh: spec.labelZh,
      fields: spec.fields,
      // The port this engine listens on when nobody says otherwise. Sent to the card so a
      // new connection can PREFILL it: an empty port box used to mean port 1 (see
      // `cleanProfile`), and showing 1433 in the field removes the trap rather than
      // documenting it.
      defaultPort: spec.defaultPort,
      // How read-only is enforced for THIS driver, in words, because they differ.
      readonly: spec.readonly,
      available: verdict.ok === true,
      reason: verdict.ok === true ? undefined : verdict.reason,
    });
  }
  return out;
}

/** Normalise one connection profile out of stored settings. */
export function cleanProfile(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);
  /**
   * A number from a form field, or the fallback.
   *
   * AN EMPTY FIELD MEANS "NOT SUPPLIED". `Number('')` is 0, which is a finite number, so
   * the clamp below turned it into the MINIMUM — and the minimum port is 1. So a
   * connection whose port box was left blank (the field is empty by default, and the
   * default port is not printed anywhere in it) tried to reach `host:1`, and the driver's
   * careful `defaultPort` never got a chance to apply. Measured on a real server:
   * `port: ''` → "连不上 203.0.113.10:1 —— 10 秒内没有回应".
   */
  const number = (value, min, max, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  const driver = DRIVERS[String(source.driver ?? '')] === undefined ? 'sqlite' : String(source.driver);
  const id = text(source.id, 40) || `conn-${index + 1}`;
  const profile = {
    id,
    driver,
    name: text(source.name, 60) || id,
    // The ONE switch that decides whether a write can run at all. Absent means
    // read-only, because "I did not think about it" must not mean "sure, drop it".
    readOnly: source.readOnly !== false,
    limit: clampLimit(source.limit),
    timeoutMs: clampTimeout(source.timeoutMs),
  };
  if (driver === 'sqlite') {
    profile.file = text(source.file, 400) ?? '';
    return profile;
  }
  profile.host = text(source.host, 200) || '127.0.0.1';
  // Per DRIVER, not "postgres or everything else": that shortcut gave SQL Server port
  // 3306, so a connection to a real server on 1433 was refused before it started.
  const spec = DRIVER_SPECS.find((entry) => entry.id === driver);
  profile.port = number(source.port, 1, 65_535, spec?.defaultPort ?? 5432);
  profile.database = text(source.database, 120) ?? '';
  profile.user = text(source.user, 120) ?? '';
  // A NAME, never the secret: the password is fetched from the credential store at
  // connect time. Storing it here would put it in a JSON file on disk and in every
  // state response the browser asks for.
  //
  // SANITISED on the way in, not only when a new one is generated. A connection stored before
  // the alphabet rule was known holds `dsh-hud-sql-db`, and a hyphen there is not merely
  // unreadable — the store's parser rejects it, so the credential plugin fails to load and DSH
  // will not start. Normalising on READ means an existing settings file heals itself instead of
  // asking its owner to understand why a name they never typed is invalid.
  const askedRef = text(source.passwordRef, 120);
  profile.passwordRef = askedRef === undefined ? undefined : toCredentialRef(askedRef);
  if (driver === 'postgres') profile.ssl = source.ssl === true;
  return profile;
}

/** Every profile in a settings blob, in the order given. */
export function cleanProfiles(raw) {
  const list = Array.isArray(raw?.connections) ? raw.connections : [];
  return list.slice(0, 12).map((entry, index) => cleanProfile(entry, index));
}

/**
 * Resolve the secrets for one profile.
 *
 * Deliberately a separate step with an explicit resolver, so the panel's route
 * handlers are the only place a credential is ever read — and so a test can pass a
 * literal without touching the credential store.
 */
export async function secretsFor(profile, resolve) {
  if (typeof resolve !== 'function') return {};
  const ref = profile?.passwordRef;
  if (typeof ref !== 'string' || ref === '') return {};
  const value = await resolve(ref);
  if (typeof value !== 'string' || value === '') {
    // A named credential that does not resolve is worth SAYING: the alternative is
    // "password authentication failed", which sends someone hunting for the wrong
    // problem.
    throw new Error(`凭据「${ref}」没有找到（检查 DSH 的凭据库，或改用别的名字）`);
  }
  return { password: value };
}

/**
 * Connect, describe, run — one at a time, always closed.
 *
 * Every function here opens a session, uses it, and closes it in a `finally`. A
 * long-lived connection per profile would be faster and is exactly how this kind of
 * panel ends up leaking sockets for databases nobody is looking at.
 */
export async function withSession(profile, { resolve, secrets: literal, run }) {
  const driver = driverFor(profile?.driver);
  if (driver === undefined) throw new Error(`不支持的数据库类型：${profile?.driver}`);
  /**
   * A LITERAL secret wins over the resolver.
   *
   * This is what the connect form needs: the password was just typed, so there is nothing
   * to look up yet. Passing it as `{ secrets: { password } }` used to be silently ignored —
   * `withSession` only knew about `resolve` — so the driver saw no password at all and
   * answered "服务器要求 SCRAM-SHA-256 密码，但没有可用的凭据". A dropped option that reads
   * like a credential problem is a bad way to find out about a missing parameter.
   */
  const secrets = literal !== undefined ? literal : await secretsFor(profile, resolve);
  const session = await driver.open(profile, { secrets });
  try {
    return await run(session);
  } finally {
    try {
      session.close();
    } catch {
      /* closing is best effort */
    }
  }
}

/** The schema tree of one profile. */
export async function describeProfile(profile, options = {}) {
  return withSession(profile, {
    resolve: options.resolve,
    secrets: options.secrets,
    run: async (session) => ({
      driver: session.driver,
      info: session.info ?? {},
      // SQLite has no "info" beyond the file; say the file, so the card has something
      // to show in the same place the others show host/database.
      target: session.info === undefined ? profile.file : (profile.driver === 'sqlite' ? profile.file : undefined),
      schemas: await session.schemas(),
      readOnly: profile.readOnly !== false,
    }),
  });
}

/**
 * Run one statement.
 *
 * The order matters: split first (so a two-statement blob is refused with a sentence
 * instead of a driver error), then classify (so the card learns what it is about to
 * run), then — and only then — connect.
 */
export async function runStatement(profile, { sql, allowWrite = false, resolve, secrets: Literal, limit, timeoutMs } = {}) {
  const split = splitStatements(sql);
  if (split.statements.length === 0) throw new Error('没有可执行的语句');
  if (split.statements.length > 1) {
    throw new Error(`${split.reason ?? '一次只能执行一条语句'}（收到 ${split.statements.length} 条）`);
  }
  const statement = split.statements[0];
  const kind = classify(statement);
  /**
   * TWO switches, and a write needs both.
   *
   *   • the CONNECTION says whether writes are allowed to it at all — a production
   *     database should stay read-only whatever anyone ticks in a hurry;
   *   • the RUN says whether this particular statement is meant to write.
   *
   * "Either one" would make the connection flag useless (one tick undoes it) and "the
   * run flag only" would make a shared read-only profile impossible. And when a write
   * is refused, the message names the switch that is OFF — because "read-only" with
   * two possible causes is a message that costs someone ten minutes.
   */
  const connectionAllows = profile.readOnly === false;
  const runAllows = allowWrite === true;
  const readOnly = !(connectionAllows && runAllows);
  if (readOnly && kind === 'write') {
    const which = connectionAllows ? '这次执行没有勾选「允许写」' : '这个连接被标记为只读';
    throw new Error(`${which}：${statement.split(/\s+/)[0]?.toUpperCase()} 不会被执行。${connectionAllows ? '在卡片上勾选「允许写」即可。' : '要执行写操作，请在连接设置里关掉「只读」。'}`);
  }
  const effectiveLimit = clampLimit(limit ?? profile.limit);
  const effectiveTimeout = clampTimeout(timeoutMs ?? profile.timeoutMs);
  return withSession(profile, {
    resolve,
    // The literal secret, forwarded exactly as `testProfile` forwards it.
    //
    // Without this, a password typed into the connect form worked for 连接 and NOT for 执行:
    // `testProfile` passed it through and `runStatement` did not, so the driver fell back to a
    // credential lookup that has nothing to find yet and answered "服务器要求 SCRAM-SHA-256
    // 密码，但没有可用的凭据". Two functions that both open a session have to forward the same
    // options — the difference is invisible until the credential store is empty.
    secrets: Literal,
    run: async (session) => {
      const result = await session.query(statement, {
        limit: effectiveLimit,
        timeoutMs: effectiveTimeout,
        readOnly,
      });
      return {
        ...result,
        sql: statement,
        classify: kind,
        readOnly,
        limit: effectiveLimit,
        timeoutMs: effectiveTimeout,
        // A write that ran is worth stating plainly: it is the one kind of result that
        // changed something.
        wrote: kind === 'write' || (readOnly === false && /^(insert|update|delete|replace|merge|upsert|create|drop|alter|truncate)/i.test(statement)),
      };
    },
  });
}

/**
 * Try a connection and report what it is, without listing anything.
 *
 * Separate from `describeProfile` because "can I connect at all?" is the question a
 * settings form asks, and answering it by fetching a whole schema is a slow way to
 * find out that the password is wrong.
 */
export async function testProfile(profile, options = {}) {
  const started = Date.now();
  return withSession(profile, {
    resolve: options.resolve,
    // The password someone typed into the connect form, forwarded so the test uses it
    // directly instead of looking up a credential that does not exist yet.
    secrets: options.secrets,
    run: async (session) => ({
      ok: true,
      ms: Date.now() - started,
      driver: session.driver,
      info: session.info ?? {},
      target: profile.driver === 'sqlite' ? profile.file : undefined,
    }),
  });
}