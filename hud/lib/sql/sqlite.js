/**
 * ── SQLite, through `node:sqlite` ──────────────────────────────────────────
 *
 * Zero dependencies, and not by writing a database engine: `node:sqlite` ships WITH
 * Node (22.5+). That matters for two reasons beyond convenience:
 *
 *   • it is a real SQL engine, so arbitrary `SELECT`s actually work — a hand-written
 *     SQLite file reader could list a schema and would still have to refuse every
 *     query with a `JOIN` in it;
 *   • `{ readOnly: true }` is a REAL guarantee. The engine refuses the write
 *     ("attempt to write a readonly database") instead of a keyword filter hoping it
 *     spotted one.
 *
 * What it does NOT give us, and the README says so: the API is SYNCHRONOUS. A query
 * that takes a minute blocks this process for a minute; there is no interrupt in
 * `DatabaseSync`. The row cap limits how much is read back, not how long the engine
 * thinks — so the card labels SQLite honestly rather than implying the timeout is a
 * hard stop it cannot be.
 */
import { existsSync, statSync } from 'node:fs';
import { clampLimit, DEFAULT_ROW_LIMIT } from './contract.js';

export const id = 'sqlite';
export const label = 'SQLite';

/** How this driver names the thing that makes a connection. */
export const fields = ['file'];

/**
 * `node:sqlite`, loaded ONCE and cached.
 *
 * It has to be a dynamic `import()`: this file is ESM, where `require` does not
 * exist — a `require('node:sqlite')` here reports "require is not defined" and would
 * have made the card claim SQLite was unavailable on a Node that has it. (It did,
 * for one run: the availability check caught its own reflection.)
 *
 * A rejected import is a permanent answer, so the rejection is cached too — asking
 * twice must not turn into two stack traces per poll.
 */
let sqliteModule;
function loadSqlite() {
  if (sqliteModule === undefined) {
    sqliteModule = import('node:sqlite')
      .then((mod) => (typeof mod?.DatabaseSync === 'function' ? mod : null))
      .catch(() => null);
  }
  return sqliteModule;
}

/**
 * Can this process run SQLite at all?
 *
 * `node:sqlite` is newer than most of Node's standard library, so the answer is
 * genuinely "it depends on the Node running this" — a fact the card should state, not
 * a crash it should produce. Async because the import is.
 */
export async function available() {
  const version = process.versions.node ?? '0.0.0';
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major) || major < 22) {
    return { ok: false, reason: `node:sqlite 需要 Node 22.5 以上，当前是 ${version}` };
  }
  const mod = await loadSqlite();
  if (mod === null) {
    // Version numbers are a guess; this is the fact. Say which one it was.
    return { ok: false, reason: `当前 Node（${version}）没有可用的 node:sqlite（DatabaseSync 未导出）` };
  }
  return { ok: true };
}

/**
 * Values that survive `JSON.stringify`.
 *
 * A BLOB is a `Uint8Array`, and sending one to the browser as an array of a million
 * bytes would freeze the card — so a blob is described, not shipped: its size, and
 * the first bytes as hex. That is what a person actually wants to see and it is
 * honest about being a preview.
 *
 * A BigInt cannot be stringified at all, and a `number` would silently lose precision
 * past 2^53 — which for an id column is exactly the kind of wrongness that is hard to
 * notice, so big integers become strings.
 */
export function jsonSafe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) {
    const head = Buffer.from(value.subarray(0, 8)).toString('hex');
    return `<${value.byteLength} bytes · ${head}${value.byteLength > 8 ? '…' : ''}>`;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** One column, from `pragma table_info`. */
export function columnFrom(row) {
  return {
    name: String(row?.name ?? ''),
    type: String(row?.type ?? '') || '(无类型)',
    nullable: Number(row?.notnull ?? 0) === 0,
    primaryKey: Number(row?.pk ?? 0) > 0,
    default: row?.dflt_value === null || row?.dflt_value === undefined ? undefined : String(row.dflt_value),
  };
}

/** A table or view row out of `sqlite_master`. */
export function objectFrom(row) {
  const type = String(row?.type ?? '');
  return {
    name: String(row?.name ?? ''),
    kind: type === 'view' ? 'view' : type === 'table' ? 'table' : type,
  };
}

/**
 * Open one SQLite file.
 *
 * A read-only profile against a file that does not exist is a MISTAKE worth naming:
 * opening read-write would CREATE an empty database, and then the card would happily
 * report "0 tables" about a file the user never had.
 */
export async function open(profile, _options = {}) {
  const availability = await available();
  if (!availability.ok) throw new Error(availability.reason);
  const file = String(profile?.file ?? '').trim();
  if (file === '') throw new Error('没有指定数据库文件');
  const readOnly = profile?.readOnly !== false;
  if (readOnly && !existsSync(file)) throw new Error(`文件不存在：${file}`);
  const stat = existsSync(file) ? statSync(file) : undefined;
  if (stat !== undefined && stat.isDirectory()) throw new Error(`这是一个目录，不是 SQLite 文件：${file}`);

  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly });
  return {
    driver: id,
    readOnly,
    file,
    /** Every attached database, so `main` is not the only "schema" shown. */
    async schemas() {
      const list = db.prepare('pragma database_list').all();
      const schemas = [];
      for (const entry of list) {
        const name = String(entry?.name ?? 'main');
        const objects = [];
        try {
          // Qualified with the schema name: `temp` and any ATTACHed file have their
          // own sqlite_master, and only one of them is `main`.
          const rows = db
            .prepare(`select type, name from "${name.replace(/"/g, '""')}".sqlite_master where name not like 'sqlite_%' order by type, name`)
            .all();
          for (const row of rows) {
            const object = objectFrom(row);
            // Columns per object: `pragma table_info` understands views too, which is
            // what makes a view as readable in the tree as a table.
            let columns = [];
            try {
              columns = db
                .prepare(`pragma "${name.replace(/"/g, '""')}".table_info("${object.name.replace(/"/g, '""')}")`)
                .all()
                .map(columnFrom);
            } catch (error) {
              columns = [{ name: '(读取列失败)', type: error instanceof Error ? error.message : String(error), nullable: true, primaryKey: false }];
            }
            objects.push({ ...object, schema: name, columns });
          }
        } catch (error) {
          schemas.push({ name, error: error instanceof Error ? error.message : String(error), objects: [] });
          continue;
        }
        schemas.push({ name, file: entry?.file === '' ? undefined : String(entry?.file ?? ''), objects });
      }
      return schemas;
    },
    /** One statement, under a row cap. */
    async query(sql, { limit = DEFAULT_ROW_LIMIT, timeoutMs = undefined } = {}) {
      void timeoutMs;
      const cap = clampLimit(limit);
      const started = Date.now();
      const statement = db.prepare(sql);
      // `columns()` throws on a statement that returns no result set (an INSERT, a
      // CREATE), which is how "does this produce rows" is answered.
      let columns = [];
      try {
        columns = (statement.columns?.() ?? []).map((column) => String(column?.name ?? ''));
      } catch {
        columns = [];
      }
      if (columns.length === 0) {
        const info = statement.run();
        return {
          columns: [],
          rows: [],
          truncated: false,
          ms: Date.now() - started,
          // `changes` and `lastInsertRowid` are the two numbers a write is judged by.
          notice: `影响 ${Number(info?.changes ?? 0)} 行${info?.lastInsertRowid === undefined ? '' : ` · 新行 id ${String(info.lastInsertRowid)}`}`,
        };
      }
      const rows = [];
      let truncated = false;
      for (const row of statement.iterate()) {
        if (rows.length >= cap) {
          truncated = true;
          break;
        }
        // Object → array, in the COLUMN ORDER the statement declared, because that is
        // the order the grid renders and a plain `Object.values` would follow the
        // object's own key order instead.
        rows.push(columns.map((name) => jsonSafe(row?.[name])));
      }
      return { columns, rows, truncated, ms: Date.now() - started };
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** A one-line description of the connection, for the card's header. */
export function describe(profile) {
  return String(profile?.file ?? '(未设置文件)');
}

/** How long a query may take. Kept for the shared contract; see the note above. */
export function timeoutNote() {
  return 'node:sqlite 是同步 API：长查询会占住宿主进程，且无法中途取消 —— 行数上限限制的是读回多少，不是引擎想多久。';
}