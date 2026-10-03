/**
 * ── the shape every SQL driver in this plugin answers to ────────────────────
 *
 * Four drivers, one contract, and no runtime dependencies at all:
 *
 *   sqlite   `node:sqlite`, which ships WITH Node — a real SQL engine, and a real
 *            read-only file handle (the engine refuses a write, which is a
 *            guarantee rather than a keyword filter).
 *   postgres the v3 wire protocol, spoken directly over `node:net`, with SCRAM or
 *            MD5 auth from `node:crypto`.
 *   mysql    the MySQL/MariaDB handshake and COM_QUERY, spoken the same way.
 *
 *   sqlserver TDS — PRELOGIN, LOGIN7 and SQL_BATCH — spoken the same way. Its read-only
 *             guarantee is the odd one out: SQL Server has no read-only transaction, so
 *             `readonly: 'client'` and the plugin is what refuses the write.
 *
 * A driver is asked for exactly four things: say whether it is available, open a
 * session, describe the database, and run ONE statement under a row cap and a
 * timeout. Everything else — credentials, storage, the UI — is the panel's business,
 * so a driver stays testable on its own.
 *
 * @typedef {object} QueryResult
 * @property {string[]} columns   Column names, in order.
 * @property {unknown[][]} rows   Row-major values, already JSON-safe.
 * @property {boolean} truncated  Whether the row cap cut the result short.
 * @property {number} ms          How long the server took.
 * @property {string} [notice]    A sentence worth showing (rows affected, a caveat).
 */

/**
 * The row cap. Applied while READING, not by rewriting the query: a `LIMIT` bolted
 * onto someone else's SQL misunderstands `UNION`, `ORDER BY` and CTEs, and silently
 * answers a different question than the one that was asked.
 */
/**
 * What the DSH credential store accepts as a ref: letters, digits and underscores, not
 * starting with a digit. There is NO hyphen in that set — the store's own parser enforces it,
 * and a ref that breaks the rule makes the credentials plugin fail to load, which takes the
 * whole application's startup down with it.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Is this a ref the store will accept? */
export function isCredentialRef(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value);
}

/**
 * Turn anything into a legal ref.
 *
 * Every character outside the alphabet becomes an underscore, and a leading digit is prefixed
 * with one — because "the id happened to start with a number" must not be a way to write an
 * unloadable credentials file.
 */
export function toCredentialRef(value, fallback = 'credential') {
  const text = String(value ?? '').trim();
  const cleaned = text.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
  return cleaned === '' ? fallback : cleaned;
}

export const DEFAULT_ROW_LIMIT = 200;
export const MAX_ROW_LIMIT = 5_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;

/** Database engines this plugin can talk to, and how it says so. */
export const DRIVER_SPECS = [
  {
    id: 'sqlite',
    label: 'SQLite',
    labelZh: 'SQLite',
    // What the connection form should ask for, so the card can render it without
    // knowing one driver from another.
    fields: [{ key: 'file', label: '数据库文件', labelEn: 'FILE', placeholder: 'E:/data/app.db', kind: 'text' }],
    defaultPort: 0,
    readonly: 'engine',
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    labelZh: 'PostgreSQL',
    fields: [
      { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
      { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '5432', kind: 'number' },
      { key: 'database', label: '数据库', labelEn: 'DATABASE', placeholder: 'postgres', kind: 'text' },
      { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'postgres', kind: 'text' },
      { key: 'ssl', label: 'SSL', labelEn: 'SSL', kind: 'toggle' },
    ],
    defaultPort: 5432,
    readonly: 'transaction',
  },
  {
    id: 'mysql',
    label: 'MySQL / MariaDB',
    labelZh: 'MySQL / MariaDB',
    fields: [
      { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
      { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '3306', kind: 'number' },
      { key: 'database', label: '数据库', labelEn: 'DATABASE', placeholder: 'app', kind: 'text' },
      { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'root', kind: 'text' },
    ],
    defaultPort: 3306,
    readonly: 'transaction',
  },
  {
    id: 'sqlserver',
    label: 'SQL Server',
    labelZh: 'SQL Server',
    /**
     * 'client', and the only driver here that says so. See lib/sql/tds.js: SQL Server has
     * no read-only transaction, ApplicationIntent=ReadOnly is a routing hint rather than
     * an enforcement, and a read-only login is the user's decision on their own server.
     * So this plugin refuses to send a write — which is a promise about THIS code, not
     * about the server, and the card states the difference.
     */
    defaultPort: 1433,
    readonly: 'client',
    fields: [
      { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
      { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '1433', kind: 'number' },
      { key: 'database', label: '数据库', labelEn: 'DATABASE', placeholder: 'master', kind: 'text' },
      { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'sa', kind: 'text' },
      { key: 'encrypt', label: '强制 TLS', labelEn: 'FORCE TLS', kind: 'toggle' },
      { key: 'trustServerCertificate', label: '不校验证书', labelEn: 'TRUST CERT', kind: 'toggle' },
    ],
  },
  {
    id: 'oracle',
    label: 'Oracle',
    labelZh: 'Oracle',
    // 'client' — see lib/sql/oracle.js: this server's read-only mode belongs to a transaction or
    // a cursor that this driver does not keep open across calls.
    readonly: 'client',
    defaultPort: 1521,
    fields: [
      { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
      { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '1521', kind: 'number' },
      { key: 'service', label: '服务名 / SID', labelEn: 'SERVICE', placeholder: 'ORCLPDB1', kind: 'text' },
      { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'system', kind: 'text' },
    ],
  },
  {
    id: 'db2',
    label: 'DB2',
    labelZh: 'DB2',
    // 'client' — see lib/sql/db2.js: this server's read-only mode belongs to a transaction or
    // a cursor that this driver does not keep open across calls.
    readonly: 'client',
    defaultPort: 50000,
    fields: [
      { key: 'host', label: '主机', labelEn: 'HOST', placeholder: '127.0.0.1', kind: 'text' },
      { key: 'port', label: '端口', labelEn: 'PORT', placeholder: '50000', kind: 'number' },
      { key: 'database', label: '数据库', labelEn: 'DATABASE', placeholder: 'SAMPLE', kind: 'text' },
      { key: 'user', label: '用户', labelEn: 'USER', placeholder: 'db2inst1', kind: 'text' },
    ],
  },
];

/**
 * Is this statement a read?
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * It is NOT a security boundary, and it must never be sold as one. `WITH x AS
 * (DELETE … RETURNING *) SELECT * FROM x` is a write that starts with `WITH`; a
 * string literal can contain the word `drop`. A classifier that pretends to be a
 * sandbox is worse than no classifier, because it stops people from looking for
 * the real one.
 *
 * What it IS: a way for the card to WARN before running something destructive, and
 * a first gate. The real enforcement is elsewhere and is different per driver:
 *   • sqlite   a read-only file handle — the engine itself refuses;
 *   • sqlserver   NOTHING the server enforces: the plugin refuses to send the statement.
 *     Reported as `client` rather than dressed up as a server guarantee.
 *   • postgres / mysql   a READ ONLY transaction, which the SERVER enforces.
 * @returns {'read'|'write'|'unknown'}
 */
export function classify(sql) {
  const text = stripLiteralsAndComments(String(sql ?? '')).trim();
  if (text === '') return 'unknown';
  const first = /^[a-z]+/i.exec(text)?.[0]?.toLowerCase() ?? '';
  if (['select', 'show', 'describe', 'desc', 'explain', 'pragma', 'table', 'values'].includes(first)) return 'read';
  if (['insert', 'update', 'delete', 'replace', 'merge', 'upsert', 'create', 'drop', 'alter', 'truncate',
    'grant', 'revoke', 'comment', 'vacuum', 'attach', 'detach', 'reindex', 'analyze', 'call', 'copy',
    'set', 'use', 'lock', 'rename', 'refresh', 'cluster', 'do', 'begin', 'commit', 'rollback',
    'savepoint', 'release', 'prepare', 'execute', 'deallocate', 'discard', 'listen', 'notify',
    'unlisten', 'load', 'import', 'kill', 'flush', 'reset', 'purge', 'install', 'uninstall',
    'handler', 'optimize', 'repair', 'check', 'checksum', 'shutdown', 'start', 'stop', 'change',
    'xa', 'binlog', 'cache', 'help'].includes(first)) return 'write';
  // `WITH …` is the honest "I cannot tell" — it is a read about half the time, and
  // guessing wrong in the permissive direction is the one direction that can hurt.
  // (The READ ONLY transaction still protects the server; this only decides the
  // wording on the card.)
  return 'unknown';
}

/**
 * Replace the CONTENTS of string literals, quoted identifiers and comments with
 * spaces, so a keyword search cannot be fooled by `select 'drop table x'`.
 * The text is only ever used for classification, never executed.
 */
export function stripLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote !== '`') {
          i += 2;
          continue;
        }
        // A doubled quote is an escaped quote inside the literal, not the end.
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) break;
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Split one SQL blob into statements.
 *
 * Drivers here run ONE statement per call, because that is what the wire protocols
 * do (Postgres' simple query being the exception, and even there a multi-statement
 * blob returns several result sets that a single grid cannot show honestly). So a
 * blob is either one statement or an explanation.
 * @returns {{ statements: string[], reason?: string }}
 */
export function splitStatements(sql) {
  const text = String(sql ?? '');
  const statements = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') {
        current += text[i];
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      current += text.slice(start, i);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\' && quote !== '`') {
          i += 2;
          continue;
        }
        if (text[i] === quote && text[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      i += 1;
      current += text.slice(start, i);
      continue;
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  const kept = statements.map((one) => one.trim()).filter((one) => one !== '');
  if (kept.length > 1) {
    return {
      statements: kept,
      reason: '一次只能执行一条语句',
    };
  }
  return { statements: kept };
}

/** Clamp a number that a panel (or a hand-edited state file) supplied. */
export function clampLimit(value, fallback = DEFAULT_ROW_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(MAX_ROW_LIMIT, Math.max(1, Math.round(number)));
}

export function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(500, Math.round(number)));
}