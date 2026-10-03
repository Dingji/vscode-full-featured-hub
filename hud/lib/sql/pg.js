/**
 * ── PostgreSQL, over the v3 wire protocol ──────────────────────────────────
 *
 * No dependencies and no CLI: `node:net` plus `node:crypto` are enough, because the
 * protocol is small and stable. What is implemented, and what is not, is stated here
 * rather than discovered by a user:
 *
 *   ✔ authentication: trust, cleartext password, MD5, SCRAM-SHA-256 (the default on
 *     every modern server), and TLS via `sslmode`-style upgrade.
 *   ✘ GSSAPI / SSPI / certificate auth: the server asks, we say so by name.
 *
 *   ✔ the SIMPLE query protocol: one statement per call, one result set.
 *   ✘ the extended protocol (prepared statements with parameters, cursors, COPY).
 *     Binary values are therefore never requested: every value arrives as TEXT, which
 *     is what a grid wants to show anyway — and the type OID is carried alongside so
 *     the card can label a column with what the server says it is.
 *
 * Read-only is enforced by the SERVER, not by inspecting the SQL: the statement runs
 * inside `BEGIN TRANSACTION READ ONLY`, and a write then fails with the server's own
 * `cannot execute INSERT in a read-only transaction`. A keyword filter would be a
 * guess; this is a guarantee. (`WITH x AS (DELETE … RETURNING *) SELECT …` is why the
 * distinction matters.)
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { clampLimit, clampTimeout, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_MS } from './contract.js';

export const id = 'postgres';
export const label = 'PostgreSQL';
export const fields = ['host', 'port', 'database', 'user', 'passwordRef', 'ssl'];

const PROTOCOL_VERSION = 196608; // 3.0
const SSL_REQUEST_CODE = 80877103;

export function available() {
  return { ok: true };
}

/** PostgreSQL type OIDs that matter for labelling a column. */
const TYPE_NAMES = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 22: 'int2vector',
  23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml', 600: 'point', 650: 'cidr',
  700: 'float4', 701: 'float8', 790: 'money', 829: 'macaddr', 869: 'inet', 1042: 'bpchar',
  1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz',
  1186: 'interval', 1266: 'timetz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
};

/** The name a person would use for a type OID. */
export function typeName(oid) {
  return TYPE_NAMES[Number(oid)] ?? `oid:${Number(oid)}`;
}

/**
 * A message-oriented reader over a socket.
 *
 * PostgreSQL frames every message after startup as `type(1) + length(4) + payload`,
 * where the length INCLUDES itself. Buffering is not optional: a socket hands over
 * arbitrary chunks, and a DataRow can straddle two of them — parsing per chunk is the
 * classic way this goes wrong only on large results.
 */
export function createReader() {
  let buffer = Buffer.alloc(0);
  const waiting = [];
  let failure;
  let ended = false;

  const pump = () => {
    while (waiting.length > 0) {
      const next = waiting[0];
      if (next.kind === 'byte') {
        if (buffer.length < 1) return;
        const value = buffer[0];
        buffer = buffer.subarray(1);
        waiting.shift();
        next.resolve(value);
        continue;
      }
      if (next.kind === 'startup') {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const payload = buffer.subarray(4, length);
        buffer = buffer.subarray(length);
        waiting.shift();
        next.resolve({ type: '', payload });
        continue;
      }
      if (buffer.length < 5) return;
      const type = String.fromCharCode(buffer[0]);
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      const payload = buffer.subarray(5, length + 1);
      buffer = buffer.subarray(length + 1);
      waiting.shift();
      next.resolve({ type, payload });
    }
  };

  return {
    /** Push a chunk from the socket. */
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    },
    fail(error) {
      failure = error;
      ended = true;
      for (const next of waiting.splice(0)) next.reject(error);
    },
    end() {
      ended = true;
      const error = failure ?? new Error('连接已被服务器关闭');
      for (const next of waiting.splice(0)) next.reject(error);
    },
    /** Exactly one byte — what an SSLRequest is answered with. */
    byte() {
      return new Promise((resolve, reject) => {
        if (failure !== undefined) return reject(failure);
        waiting.push({
          kind: 'byte',
          resolve: (value) => resolve(value),
          reject,
        });
        pump();
        if (ended && waiting.length > 0) this.end();
        return undefined;
      });
    },
    /** The next startup-phase message (no type byte). */
    startup() {
      return new Promise((resolve, reject) => {
        if (failure !== undefined) return reject(failure);
        waiting.push({ kind: 'startup', resolve, reject });
        pump();
        if (ended && waiting.length > 0) this.end();
        return undefined;
      });
    },
    /** The next typed message. */
    next() {
      return new Promise((resolve, reject) => {
        if (failure !== undefined) return reject(failure);
        waiting.push({ kind: 'typed', resolve, reject });
        pump();
        if (ended && waiting.length > 0) this.end();
        return undefined;
      });
    },
  };
}

/** `md5` password auth: md5(md5(password + user) + salt). */
export function md5Password(password, user, salt) {
  const inner = createHash('md5').update(`${password}${user}`, 'utf8').digest('hex');
  return `md5${createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex')}`;
}

/**
 * SCRAM-SHA-256.
 *
 * Exported because it is the ONE piece of this protocol that can be checked against
 * the specification's own test vector — a handshake against a real server would pass
 * even if the derivation were subtly wrong in a way that only shows up for another
 * server version.
 */
export function scramClient({ user, password, clientNonce = randomBytes(18).toString('base64') }) {
  const gs2 = 'n,,';
  const bare = `n=${user.replace(/[=,]/g, (ch) => (ch === '=' ? '=3D' : '=2C'))},r=${clientNonce}`;
  const firstMessage = `${gs2}${bare}`;
  let serverFirst = '';
  let saltedPassword;
  const state = {
    /** The `p` message that opens SASL. */
    initial() {
      return {
        mechanism: 'SCRAM-SHA-256',
        data: Buffer.from(firstMessage, 'utf8'),
      };
    },
    /** Answer the server-first-message. */
    final(payload) {
      serverFirst = payload.toString('utf8');
      const parts = Object.fromEntries(serverFirst.split(',').map((piece) => [piece.slice(0, 1), piece.slice(2)]));
      if (parts.r === undefined || !parts.r.startsWith(clientNonce)) {
        throw new Error('SCRAM：服务器返回的 nonce 与客户端的不匹配，握手可能被篡改');
      }
      const iterations = Number(parts.i);
      if (!Number.isFinite(iterations) || iterations <= 0) throw new Error('SCRAM：缺少迭代次数');
      // `s` is base64; a wrong decode here produces a wrong key and an opaque
      // "password authentication failed" much later.
      const salt = Buffer.from(parts.s ?? '', 'base64');
      saltedPassword = pbkdf2Sync(
        Buffer.from(String(password ?? ''), 'utf8'),
        salt,
        iterations,
        32,
        'sha256',
      );
      const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
      const storedKey = createHash('sha256').update(clientKey).digest();
      const withoutProof = `c=${Buffer.from(gs2, 'utf8').toString('base64')},r=${parts.r}`;
      const authMessage = `${bare},${serverFirst},${withoutProof}`;
      const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < clientKey.length; i += 1) proof[i] = clientKey[i] ^ clientSignature[i];
      const finalMessage = `${withoutProof},p=${proof.toString('base64')}`;
      return {
        message: Buffer.from(finalMessage, 'utf8'),
        /** Verify the server's signature, which is what proves the server knows the key. */
        verify(serverFinal) {
          const text = serverFinal.toString('utf8');
          const match = /v=([^,]+)/.exec(text);
          if (match === null) return /e=/.test(text) ? `SCRAM：服务器报错 ${text}` : 'SCRAM：服务器没有返回签名';
          const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
          const expected = createHmac('sha256', serverKey).update(authMessage).digest('base64');
          return match[1] === expected ? undefined : 'SCRAM：服务器签名不匹配';
        },
      };
    },
  };
  return state;
}

/** Parse an ErrorResponse / NoticeResponse payload into something showable. */
/**
 * Attach what the server said to the Error being thrown.
 *
 * The route turns this into the structured payload the card renders, and a driver that keeps
 * only `message` throws away the DETAIL line — which is usually where the actual answer is.
 */
export function withServer(error, fields) {
  error.server = fields;
  return error;
}

export function parseErrorFields(payload) {
  const fields = {};
  let i = 0;
  while (i < payload.length) {
    const code = String.fromCharCode(payload[i]);
    if (code === '\0') break;
    i += 1;
    let end = payload.indexOf(0, i);
    if (end < 0) end = payload.length;
    fields[code] = payload.subarray(i, end).toString('utf8');
    i = end + 1;
  }
  return {
    severity: fields.S ?? 'ERROR',
    code: fields.C,
    message: fields.M ?? '未知错误',
    detail: fields.D,
    hint: fields.H,
    position: fields.P,
  };
}

/** Parse a RowDescription into `{name, typeOid, type}`. */
export function parseRowDescription(payload) {
  const count = payload.readInt16BE(0);
  const columns = [];
  let i = 2;
  for (let index = 0; index < count; index += 1) {
    const end = payload.indexOf(0, i);
    const name = payload.subarray(i, end).toString('utf8');
    i = end + 1;
    const typeOid = payload.readInt32BE(i + 6);
    i += 18;
    columns.push({ name, typeOid, type: typeName(typeOid) });
  }
  return columns;
}

/** Parse one DataRow: `int16 count` then per field `int32 len` + bytes (`-1` = NULL). */
export function parseDataRow(payload) {
  const count = payload.readInt16BE(0);
  const values = [];
  let i = 2;
  for (let index = 0; index < count; index += 1) {
    const length = payload.readInt32BE(i);
    i += 4;
    if (length < 0) {
      values.push(null);
      continue;
    }
    values.push(payload.subarray(i, i + length).toString('utf8'));
    i += length;
  }
  return values;
}

/** Parse a CommandComplete tag: `SELECT 5`, `INSERT 0 1`, `UPDATE 3`. */
export function parseCommandComplete(tag) {
  const text = String(tag ?? '').trim();
  const parts = text.split(/\s+/);
  const command = parts[0] ?? '';
  // `INSERT 0 1` puts the row count LAST, `UPDATE 3` puts it second. Reporting the
  // wrong number for an INSERT is the kind of small lie that costs trust.
  const count = command === 'INSERT' ? parts[2] : parts[1];
  return { command, rows: Number.isFinite(Number(count)) ? Number(count) : undefined, tag: text };
}

/** Build the columns query for every object in one round trip. */
export function columnsQuery() {
  return `
select n.nspname as schema, c.relname as object, a.attname as name,
       format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as notnull, a.attnum as position
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where a.attnum > 0 and not a.attisdropped
  and c.relkind in ('r','p','v','m','f')
  and n.nspname not in ('pg_catalog','information_schema')
order by n.nspname, c.relname, a.attnum`;
}

/** The objects query: tables, views and what kind each is. */
export function objectsQuery() {
  return `
select n.nspname as schema, c.relname as name, c.relkind as kind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p','v','m','f')
  and n.nspname not in ('pg_catalog','information_schema')
order by n.nspname, c.relkind, c.relname`;
}

/** `relkind` → the word the card shows. */
export function kindName(relkind) {
  switch (String(relkind)) {
    case 'r': return 'table';
    case 'p': return 'table';        // partitioned table
    case 'v': return 'view';
    case 'm': return 'view';         // materialized view: readable like a view
    case 'f': return 'foreign';
    default: return String(relkind);
  }
}

/**
 * Open a connection.
 *
 * The sequence is the protocol's own: startup (or SSLRequest first, if asked), the
 * auth exchange, then `ReadyForQuery`. Everything that can be refused — a wrong
 * password, a missing database, a host that does not answer — is reported with the
 * SERVER's words, because a server says exactly what is wrong and paraphrasing it
 * loses the one detail that matters.
 */
export async function open(profile, { secrets } = {}) {
  const host = String(profile?.host ?? '127.0.0.1').trim();
  const port = Number(profile?.port ?? 5432);
  const user = String(profile?.user ?? '').trim();
  const database = String(profile?.database ?? user).trim();
  const password = secrets?.password;
  const timeoutMs = clampTimeout(profile?.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  if (user === '') throw new Error('没有指定用户');

  let socket = await new Promise((resolve, reject) => {
    const attempt = netConnect({ host, port });
    const fail = (error) => reject(new Error(`无法连接 ${host}:${port} —— ${error instanceof Error ? error.message : String(error)}`));
    attempt.once('error', fail);
    attempt.once('connect', () => {
      attempt.removeListener('error', fail);
      resolve(attempt);
    });
  });
  socket.setNoDelay(true);

  const reader = createReader();
  let closed = false;
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
  };
  socket.on('data', (chunk) => reader.push(chunk));
  socket.on('error', (error) => reader.fail(error));
  socket.on('close', () => reader.end());
  // A backstop, not the primary limit: the real one is the server's own
  // `statement_timeout`, set through the startup packet below.
  socket.setTimeout(timeoutMs + 5_000, () => {
    reader.fail(new Error(`等待服务器超过 ${Math.round((timeoutMs + 5_000) / 1000)} 秒`));
    closeSocket();
  });

  const send = (buffer) => {
    if (closed) throw new Error('连接已关闭');
    socket.write(buffer);
  };

  // ── TLS, when asked for ──
  if (profile?.ssl === true) {
    const request = Buffer.alloc(8);
    request.writeInt32BE(8, 0);
    request.writeInt32BE(SSL_REQUEST_CODE, 4);
    send(request);
    // ONE byte, not a framed message: 'S' for yes, 'N' for no.
    const answerByte = await reader.byte();
    const byte = String.fromCharCode(answerByte);
    if (byte === 'S') {
      // The upgrade has to happen on a socket that has no unread bytes: the server
      // answers with a single byte and then waits, which it has.
      const upgraded = await new Promise((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: host, rejectUnauthorized: false });
        secure.once('error', reject);
        secure.once('secureConnect', () => resolve(secure));
      });
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      socket = upgraded;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => reader.push(chunk));
      socket.on('error', (error) => reader.fail(error));
      socket.on('close', () => reader.end());
    } else if (byte !== 'N') {
      closeSocket();
      throw new Error(`服务器对 SSL 请求的回答无法识别（0x${answerByte.toString(16)}）`);
    }
    // 'N' means the server does not do TLS. Continuing in the clear is what every
    // client does with `sslmode=prefer`; saying so beats failing silently.
  }

  // ── startup ──
  const params = [`user\0${user}\0`, `database\0${database}\0`, 'application_name\0dsh-hud\0',
    // Server-enforced timeout. A socket deadline can only give up; this makes the
    // server stop working too.
    `options\0-c statement_timeout=${timeoutMs}\0`, '\0'];
  const body = Buffer.concat([Buffer.from(params.join(''), 'utf8')]);
  const startup = Buffer.alloc(8 + body.length);
  startup.writeInt32BE(8 + body.length, 0);
  startup.writeInt32BE(PROTOCOL_VERSION, 4);
  body.copy(startup, 8);
  send(startup);

  let scram;
  let scramVerify;
  let serverVersion;
  for (;;) {
    // TYPED — every server message is, starting with the auth request itself.
    const message = await reader.next();
    if (message.type !== 'R') {
      // AuthenticationOk is sent as an empty 'R'; anything else this early is the
      // server telling us something is wrong.
      if (message.type === 'E') {
        closeSocket();
        const parsed = parseErrorFields(message.payload);
        throw withServer(new Error(parsed.message + (parsed.hint === undefined ? '' : `（${parsed.hint}）`)), parsed);
      }
      closeSocket();
      throw new Error(`认证阶段收到了意料之外的消息（${message.type}）`);
    }
    const code = message.payload.readInt32BE(0);
    // AuthenticationOk — this is where the auth loop ENDS.
    //
    // The `continue` that used to be here is the bug behind
    // "认证阶段收到了意料之外的消息（S）". The server does NOT stop talking after
    // AuthenticationOk: it sends ParameterStatus ('S') for every setting it volunteers,
    // BackendKeyData ('K'), and only then ReadyForQuery ('Z'). Staying in this loop kept
    // demanding another 'R', so the first 'S' looked like a protocol violation — SCRAM
    // succeeded and the connection was thrown away immediately afterwards.
    //
    // `break` hands the same stream to the loop below, which is already written to expect
    // exactly those messages.
    if (code === 0) break;
    const payload = message.payload.subarray(4);
    if (code === 3) {
      if (password === undefined) {
        closeSocket();
        throw new Error('服务器要求明文密码，但没有可用的凭据（在连接表单里填密码，或在设置里填凭据名）');
      }
      send(passwordMessage(Buffer.from(`${password}\0`, 'utf8')));
      continue;
    }
    if (code === 5) {
      if (password === undefined) {
        closeSocket();
        throw new Error('服务器要求 MD5 密码，但没有可用的凭据（在连接表单里填密码，或在设置里填凭据名）');
      }
      send(passwordMessage(Buffer.from(`${md5Password(password, user, payload.subarray(0, 4))}\0`, 'utf8')));
      continue;
    }
    if (code === 10) {
      // SASL: the list of mechanisms follows, and we must pick one we implement.
      const mechanisms = payload.toString('utf8').split('\0').filter((one) => one !== '');
      if (!mechanisms.includes('SCRAM-SHA-256')) {
        closeSocket();
        throw new Error(`服务器只接受这些认证方式：${mechanisms.join(', ')} —— 本插件只实现了 SCRAM-SHA-256`);
      }
      if (password === undefined) {
        closeSocket();
        throw new Error('服务器要求 SCRAM-SHA-256 密码，但没有可用的凭据（在连接表单里填密码，或在设置里填凭据名）');
      }
      scram = scramClient({ user, password });
      const initial = scram.initial();
      const mechanism = Buffer.from(`${initial.mechanism}\0`, 'utf8');
      const length = 4 + mechanism.length + 4 + initial.data.length;
      const message2 = Buffer.alloc(1 + length);
      message2[0] = 0x70; // 'p'
      message2.writeInt32BE(length, 1);
      mechanism.copy(message2, 5);
      message2.writeInt32BE(initial.data.length, 5 + mechanism.length);
      initial.data.copy(message2, 9 + mechanism.length);
      send(message2);
      continue;
    }
    if (code === 11) {
      if (scram === undefined) {
        closeSocket();
        throw new Error('服务器在没有开始 SASL 的情况下发来了 SASL 继续消息');
      }
      const final = scram.final(payload);
      const length = 4 + final.message.length;
      const message2 = Buffer.alloc(1 + length);
      message2[0] = 0x70;
      message2.writeInt32BE(length, 1);
      final.message.copy(message2, 5);
      send(message2);
      // Remember the verifier so the server-final message can be checked. Kept in a
      // LOCAL: a module-level variable would be shared by every open connection.
      scramVerify = final.verify;
      continue;
    }
    if (code === 12) {
      const problem = scramVerify?.(payload);
      if (problem !== undefined) {
        closeSocket();
        throw new Error(problem);
      }
      continue;
    }
    // 2 = KerberosV5, 6 = SCMCredential, 7 = GSS, 8 = GSSContinue, 9 = SSPI
    closeSocket();
    throw new Error(`服务器要求的认证方式（代码 ${code}）本插件没有实现：GSSAPI/SSPI 需要系统凭据，不在零依赖的范围内`);
  }

  // ── read until ReadyForQuery, collecting what the server volunteers ──
  for (;;) {
    const message = await reader.next();
    if (message.type === 'S') {
      const text = message.payload.toString('utf8');
      const end = text.indexOf('\0');
      if (end > 0 && text.startsWith('server_version')) serverVersion = text.slice(end + 1).replace(/\0.*$/, '');
      continue;
    }
    if (message.type === 'K' || message.type === 'N') continue;
    if (message.type === 'E') {
      closeSocket();
      const parsed = parseErrorFields(message.payload);
      throw withServer(new Error(parsed.message + (parsed.hint === undefined ? '' : `（${parsed.hint}）`)), parsed);
    }
    if (message.type === 'Z') break;
  }

  /** Run one simple query and read its result set. */
  async function simple(sql, { limit, transaction } = {}) {
    const cap = clampLimit(limit ?? DEFAULT_ROW_LIMIT);
    const statements = [];
    if (transaction !== undefined) statements.push(transaction);
    statements.push(sql);
    let columns = [];
    const rows = [];
    let truncated = false;
    let notice;
    let failure;
    let started = Date.now();
    for (const statement of statements) {
      const payload = Buffer.from(`${statement}\0`, 'utf8');
      // ── THE 4 THAT WERE MISSING ──
      //
      // A PostgreSQL message is `type | int32 length | payload`, so the buffer needs
      // 1 + 4 + payload.length bytes. This allocated `1 + payload.length` — four short — and
      // `Buffer.copy` does NOT complain when the destination runs out: it copies what fits and
      // silently drops the rest. So every query went out with its last four bytes missing while
      // the length field still claimed they were there. The server blocked waiting for the rest
      // of the message, the client blocked waiting for a reply, and fifteen seconds later the
      // socket gave up with "等待服务器超过 15 秒".
      //
      // The credential store was fine, the password was fine, the connection was fine — the
      // Query message simply never arrived whole. And the auth path was fine all along, because
      // `passwordMessage` below allocates `1 + 4 + payload.length` correctly; only this one
      // builder was wrong, which is why connecting worked and every statement afterwards hung.
      const message = Buffer.alloc(1 + 4 + payload.length);
      message[0] = 0x51; // 'Q'
      message.writeInt32BE(4 + payload.length, 1);
      payload.copy(message, 5);
      started = Date.now();
      send(message);
      let sawRows = false;
      for (;;) {
        const incoming = await reader.next();
        if (incoming.type === 'T') {
          columns = parseRowDescription(incoming.payload);
          sawRows = true;
          continue;
        }
        if (incoming.type === 'D') {
          if (rows.length >= cap) {
            truncated = true;
            // Keep DRAINING: the protocol has no way to abandon a result mid-stream,
            // and leaving unread messages on the socket corrupts the NEXT query.
            continue;
          }
          rows.push(parseDataRow(incoming.payload));
          continue;
        }
        if (incoming.type === 'C') {
          if (!sawRows) {
            const parsed = parseCommandComplete(incoming.payload.toString('utf8'));
            notice = parsed.rows === undefined ? parsed.tag : `${parsed.tag}`;
          }
          continue;
        }
        if (incoming.type === 'N') {
          const parsed = parseErrorFields(incoming.payload);
          notice = `${parsed.severity}: ${parsed.message}`;
          continue;
        }
        if (incoming.type === 'E') {
          failure = parseErrorFields(incoming.payload);
          continue;
        }
        if (incoming.type === 'Z') break;
        // 'I' (empty query), 'n' (NoData), 's' (PortalSuspended), '1'/'2'/'3' (extended
        // protocol) — nothing to do, keep reading.
      }
      if (failure !== undefined) break;
    }
    if (failure !== undefined) {
      const detail = failure.detail === undefined ? '' : ` · ${failure.detail}`;
      throw new Error(`${failure.message}${detail}${failure.hint === undefined ? '' : `（${failure.hint}）`}`);
    }
    return { columns: columns.map((column) => column.name), types: columns.map((column) => column.type), rows, truncated, ms: Date.now() - started, notice };
  }

  return {
    driver: id,
    /** Everything the card can show about where it is connected. */
    info: { host, port, database, user, serverVersion },
    async schemas() {
      const objects = await simple(objectsQuery(), { limit: 5_000 });
      const columns = await simple(columnsQuery(), { limit: 20_000 });
      const byObject = new Map();
      for (const row of columns.rows) {
        const key = `${row[0]}.${row[1]}`;
        if (!byObject.has(key)) byObject.set(key, []);
        byObject.get(key).push({
          name: String(row[2] ?? ''),
          type: String(row[3] ?? ''),
          nullable: String(row[4] ?? '') !== 't',
          primaryKey: false,
          position: Number(row[5] ?? 0),
        });
      }
      const schemas = [];
      for (const row of objects.rows) {
        const schema = String(row[0] ?? '');
        const name = String(row[1] ?? '');
        const kind = kindName(row[2]);
        let bucket = schemas.find((one) => one.name === schema);
        if (bucket === undefined) {
          bucket = { name: schema, objects: [] };
          schemas.push(bucket);
        }
        bucket.objects.push({ name, kind, schema, columns: byObject.get(`${schema}.${name}`) ?? [] });
      }
      return schemas;
    },
    async query(sql, { limit = DEFAULT_ROW_LIMIT, readOnly = true } = {}) {
      // SERVER-enforced read-only: the statement runs inside a read-only transaction,
      // so a write fails with the server's own words. A filter on the SQL text would
      // be a guess about SQL, and SQL is very good at not being guessed.
      const transaction = readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN';
      return simple(sql, { limit, transaction });
    },
    close() {
      try {
        socket.end();
      } catch {
        /* already gone */
      }
      closeSocket();
    },
  };
}

/** The `p` message (PasswordMessage). */
function passwordMessage(payload) {
  const message = Buffer.alloc(1 + 4 + payload.length);
  message[0] = 0x70; // 'p'
  message.writeInt32BE(4 + payload.length, 1);
  payload.copy(message, 5);
  return message;
}

export function describe(profile) {
  return `${profile?.user ?? '?'}@${profile?.host ?? '127.0.0.1'}:${Number(profile?.port ?? 5432)}/${profile?.database ?? profile?.user ?? '?'}`;
}