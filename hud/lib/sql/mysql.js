/**
 * ── MySQL / MariaDB, over their own wire protocol ──────────────────────────
 *
 * Same approach as the Postgres driver, and the same honesty about edges. What is
 * implemented:
 *
 *   ✔ protocol 10 handshake, capability negotiation, `COM_QUERY`, text result sets
 *   ✔ `mysql_native_password` (MariaDB's default, and MySQL's for years)
 *   ✔ `caching_sha2_password` FAST path (MySQL 8's default when the password is
 *     already cached — which is the case for any client that has connected before)
 *   ✔ `mysql_clear_password` when the server asks for it (it means TLS is carrying
 *     the secret; sending it in the clear on a plain socket is refused instead)
 *
 *   ✘ `caching_sha2_password` FULL authentication: it needs either TLS or the
 *     server's RSA public key, and answering that exchange on an unencrypted socket
 *     is a real downgrade. The card says exactly this rather than reporting "access
 *     denied", which would send someone hunting for a permissions problem that does
 *     not exist.
 *
 * Read-only is NOT enforced by a keyword filter: the statement runs inside
 * `START TRANSACTION READ ONLY`, so an `INSERT` fails with the server's own
 * `Cannot execute statement in a READ ONLY transaction`. MariaDB and MySQL 5.6+ both
 * honour it, which is why it is the mechanism used.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { clampLimit, clampTimeout, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_MS } from './contract.js';

export const id = 'mysql';
export const label = 'MySQL / MariaDB';
/**
 * Attach what the server said to the Error being thrown, so the card can show the code and the
 * SQLSTATE instead of only the sentence.
 */
export function withServer(error, fields) {
  error.server = fields;
  return error;
}

export const fields = ['host', 'port', 'database', 'user', 'passwordRef'];

// Capability flags. Values from the protocol documentation; only the ones used here.
const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_FOUND_ROWS = 0x00000002;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_SSL = 0x00000800;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_CONNECT_ATTRS = 0x00100000;
const CLIENT_DEPRECATE_EOF = 0x01000000;

export function available() {
  return { ok: true };
}

/** `mysql_native_password`: SHA1(password) XOR SHA1(nonce + SHA1(SHA1(password))). */
export function nativePassword(password, nonce) {
  const stage1 = createHash('sha1').update(String(password), 'utf8').digest();
  const stage2 = createHash('sha1').update(stage1).digest();
  const scrambled = createHash('sha1').update(Buffer.concat([nonce, stage2])).digest();
  const out = Buffer.alloc(stage1.length);
  for (let i = 0; i < stage1.length; i += 1) out[i] = stage1[i] ^ scrambled[i];
  return out;
}

/**
 * `caching_sha2_password`, fast path:
 * XOR(SHA256(password), SHA256(SHA256(SHA256(password)) + nonce)).
 */
export function sha2Password(password, nonce) {
  const stage1 = createHash('sha256').update(String(password), 'utf8').digest();
  const stage2 = createHash('sha256').update(stage1).digest();
  const scrambled = createHash('sha256').update(Buffer.concat([stage2, nonce])).digest();
  const out = Buffer.alloc(stage1.length);
  for (let i = 0; i < stage1.length; i += 1) out[i] = stage1[i] ^ scrambled[i];
  return out;
}

/** Handshake v10 out of the server's first packet. */
export function parseHandshake(packet) {
  let i = 0;
  const protocol = packet[i];
  i += 1;
  let end = packet.indexOf(0, i);
  const serverVersion = packet.subarray(i, end).toString('utf8');
  i = end + 1;
  const threadId = packet.readUInt32LE(i);
  i += 4;
  const nonce1 = packet.subarray(i, i + 8);
  i += 8;
  i += 1; // filler
  const capabilitiesLow = packet.readUInt16LE(i);
  i += 2;
  let charset;
  let capabilitiesHigh = 0;
  let authPlugin = 'mysql_native_password';
  let nonce2 = Buffer.alloc(0);
  if (packet.length > i) {
    charset = packet[i];
    i += 1;
    i += 2; // status flags
    capabilitiesHigh = packet.readUInt16LE(i);
    i += 2;
    const authLength = packet[i];
    i += 1;
    i += 10; // reserved
    // The second half of the nonce: `max(13, authLength - 8)`, minus the terminator.
    const take = Math.max(13, (authLength || 21) - 8);
    nonce2 = packet.subarray(i, Math.min(packet.length, i + take - 1));
    i += take;
    if (packet.length > i) {
      end = packet.indexOf(0, i);
      if (end < 0) end = packet.length;
      authPlugin = packet.subarray(i, end).toString('utf8') || authPlugin;
    }
  }
  return {
    protocol,
    serverVersion,
    threadId,
    capabilities: capabilitiesLow | (capabilitiesHigh << 16),
    charset: charset ?? 33,
    authPlugin,
    nonce: Buffer.concat([nonce1, nonce2]),
  };
}

/** An OK packet (`0x00` or `0xFE` with `DEPRECATE_EOF`). */
export function parseOk(packet) {
  let i = 1;
  const readLength = () => {
    const first = packet[i];
    if (first < 0xfb) {
      i += 1;
      return first;
    }
    if (first === 0xfc) {
      const value = packet.readUInt16LE(i + 1);
      i += 3;
      return value;
    }
    if (first === 0xfd) {
      const value = packet.readUIntLE(i + 1, 3);
      i += 4;
      return value;
    }
    if (first === 0xfe) {
      const value = Number(packet.readBigUInt64LE(i + 1));
      i += 9;
      return value;
    }
    i += 1;
    return undefined;
  };
  const affectedRows = readLength();
  const lastInsertId = readLength();
  const statusFlags = packet.length >= i + 2 ? packet.readUInt16LE(i) : 0;
  const warnings = packet.length >= i + 4 ? packet.readUInt16LE(i + 2) : 0;
  return { affectedRows, lastInsertId, statusFlags, warnings };
}

/** An ERR packet: `0xff`, code, `#`, five-character SQLSTATE, message. */
export function parseErr(packet) {
  const code = packet.readUInt16LE(1);
  const hasState = packet[3] === 0x23; // '#'
  const sqlState = hasState ? packet.subarray(4, 9).toString('utf8') : undefined;
  const message = packet.subarray(hasState ? 9 : 3).toString('utf8');
  return { code, sqlState, message };
}

/** Read a length-encoded integer, returning the value and the next offset. */
export function readLengthEncoded(buffer, at) {
  const first = buffer[at];
  if (first < 0xfb) return { value: first, next: at + 1 };
  if (first === 0xfb) return { value: null, next: at + 1 };
  if (first === 0xfc) return { value: buffer.readUInt16LE(at + 1), next: at + 3 };
  if (first === 0xfd) return { value: buffer.readUIntLE(at + 1, 3), next: at + 4 };
  return { value: Number(buffer.readBigUInt64LE(at + 1)), next: at + 9 };
}

/** Read a length-encoded string. */
export function readLengthEncodedString(buffer, at) {
  const length = readLengthEncoded(buffer, at);
  if (length.value === null) return { value: null, next: length.next };
  return { value: buffer.subarray(length.next, length.next + length.value).toString('utf8'), next: length.next + length.value };
}

/**
 * The column definition packet.
 *
 * The layout is SIX length-encoded strings, then a length-encoded marker for the
 * fixed-size block, then the fixed fields:
 *
 *   catalog, schema, table, org_table, NAME, org_name, 0x0c,
 *   charset(2), length(4), type(1), flags(2), decimals(1), filler(2)
 *
 * Getting this off by a field does not fail loudly — it reads a length from the middle
 * of a string and throws `ERR_OUT_OF_RANGE` from somewhere unrelated. (It did.)
 */
export function parseColumn(packet) {
  let at = 0;
  const readString = () => {
    const read = readLengthEncodedString(packet, at);
    at = read.next;
    return read.value;
  };
  const catalog = readString();
  const schema = readString();
  const table = readString();
  const orgTable = readString();
  const name = readString();
  const orgName = readString();
  const marker = readLengthEncoded(packet, at);
  at = marker.next;
  const charset = packet.readUInt16LE(at);
  const length = packet.readUInt32LE(at + 2);
  const type = packet[at + 6];
  const flags = packet.readUInt16LE(at + 7);
  const decimals = packet[at + 9];
  return {
    name: name ?? orgName ?? '',
    type: mysqlTypeName(type),
    typeCode: type,
    charset,
    length,
    decimals,
    table: table ?? undefined,
    schema: schema ?? undefined,
    // Flag bits: 0x01 NOT_NULL, 0x20 UNSIGNED, 0x200 PRIMARY_KEY-in-result.
    nullable: (flags & 0x01) === 0,
    unsigned: (flags & 0x20) !== 0,
    primaryKey: (flags & 0x200) !== 0,
    catalog,
  };
}

/** MySQL field type code → the word shown in the grid. */
export function mysqlTypeName(code) {
  return {
    0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null',
    7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime',
    13: 'year', 14: 'newdate', 15: 'varchar', 16: 'bit', 17: 'timestamp', 18: 'datetime',
    19: 'time', 245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 249: 'tinyblob',
    250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'var_string', 254: 'string',
    255: 'geometry',
  }[Number(code)] ?? `type:${Number(code)}`;
}

/** `information_schema` queries, parameterised by the connection's database. */
export function objectsQuery(database) {
  const escaped = String(database ?? '').replace(/'/g, "''");
  return `select table_schema as \`schema\`, table_name as name, table_type as kind
from information_schema.tables
where table_schema = '${escaped}'
order by table_type, table_name`;
}

export function columnsQuery(database) {
  const escaped = String(database ?? '').replace(/'/g, "''");
  return `select table_name as object, column_name as name, column_type as type,
       is_nullable as nullable, column_key as colkey, ordinal_position as position
from information_schema.columns
where table_schema = '${escaped}'
order by table_name, ordinal_position`;
}

export function kindName(tableType) {
  return /view/i.test(String(tableType)) ? 'view' : 'table';
}

/**
 * Open a connection.
 *
 * A socket reader is built here rather than shared with the Postgres driver: the two
 * protocols frame differently (MySQL prefixes every packet with a 3-byte length and a
 * sequence id; Postgres types its messages), and one reader pretending to serve both
 * is how a subtle framing bug hides in the driver nobody is testing.
 */
export async function open(profile, { secrets } = {}) {
  const host = String(profile?.host ?? '127.0.0.1').trim();
  const port = Number(profile?.port ?? 3306);
  const user = String(profile?.user ?? '').trim();
  const database = String(profile?.database ?? '').trim();
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

  // ── packet reader: 3-byte little-endian length + 1-byte sequence, then payload ──
  let buffer = Buffer.alloc(0);
  const waiting = [];
  let failure;
  let ended = false;
  let sequence = 0;

  const pump = () => {
    while (waiting.length > 0) {
      if (buffer.length < 4) return;
      const length = buffer.readUIntLE(0, 3);
      if (buffer.length < 4 + length) return;
      const packet = buffer.subarray(4, 4 + length);
      sequence = buffer[3] + 1;
      buffer = buffer.subarray(4 + length);
      const next = waiting.shift();
      next.resolve(packet);
    }
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.on('error', (error) => {
    failure = error;
    ended = true;
    for (const next of waiting.splice(0)) next.reject(error);
  });
  socket.on('close', () => {
    ended = true;
    const error = failure ?? new Error('连接已被服务器关闭');
    for (const next of waiting.splice(0)) next.reject(error);
  });
  socket.setTimeout(timeoutMs + 5_000, () => {
    failure = new Error(`等待服务器超过 ${Math.round((timeoutMs + 5_000) / 1000)} 秒`);
    socket.destroy();
    for (const next of waiting.splice(0)) next.reject(failure);
  });

  const readPacket = () =>
    new Promise((resolve, reject) => {
      if (failure !== undefined) return reject(failure);
      if (ended) return reject(new Error('连接已关闭'));
      waiting.push({ resolve, reject });
      pump();
      return undefined;
    });
  const writePacket = (payload) => {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = sequence;
    sequence += 1;
    socket.write(Buffer.concat([header, payload]));
  };

  const closeSocket = () => {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  };

  const greeting = await readPacket();
  if (greeting[0] === 0xff) {
    closeSocket();
    const error = parseErr(greeting);
    throw new Error(`服务器拒绝连接：${error.message}`);
  }
  const handshake = parseHandshake(greeting);
  if (handshake.protocol !== 10) {
    closeSocket();
    throw new Error(`不支持的握手协议版本 ${handshake.protocol}（本插件实现的是 10）`);
  }

  // ── TLS, when the server offers it and the profile asks ──
  if (profile?.ssl === true) {
    if ((handshake.capabilities & CLIENT_SSL) === 0) {
      closeSocket();
      throw new Error('服务器不支持 SSL，而设置里要求了 SSL');
    }
    const request = Buffer.alloc(32 + 4);
    request.writeUInt32LE(
      (CLIENT_LONG_PASSWORD | CLIENT_LONG_FLAG | CLIENT_PROTOCOL_41 | CLIENT_SSL | CLIENT_TRANSACTIONS | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH) >>> 0,
      0,
    );
    request.writeUInt32LE(16 * 1024 * 1024, 4);
    request[8] = handshake.charset;
    writePacket(request);
    const secure = await new Promise((resolve, reject) => {
      const upgraded = tlsConnect({ socket, servername: host, rejectUnauthorized: false });
      upgraded.once('error', reject);
      upgraded.once('secureConnect', () => resolve(upgraded));
    });
    socket.removeAllListeners('data');
    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    socket = secure;
    socket.setNoDelay(true);
    buffer = Buffer.alloc(0);
    sequence = 2; // the SSLRequest consumed sequence 1
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', (error) => {
      failure = error;
      for (const next of waiting.splice(0)) next.reject(error);
    });
    socket.on('close', () => {
      ended = true;
      const error = failure ?? new Error('连接已被服务器关闭');
      for (const next of waiting.splice(0)) next.reject(error);
    });
  }

  const scrambles = {
    mysql_native_password: (nonce) => nativePassword(password, nonce),
    caching_sha2_password: (nonce) => sha2Password(password, nonce),
    mysql_clear_password: () => Buffer.from(`${String(password ?? '')}\0`, 'utf8'),
  };

  const plugin = handshake.authPlugin;
  if (password === undefined && plugin !== 'mysql_native_password') {
    closeSocket();
    throw new Error(`服务器要求 ${plugin} 认证，但没有可用的凭据（在设置里填凭据名）`);
  }
  if (plugin === 'mysql_clear_password' && profile?.ssl !== true) {
    closeSocket();
    // Sending a password in the clear over a plain socket is a real downgrade, and
    // "access denied" would send someone looking for a permissions problem.
    throw new Error('服务器要求明文密码（mysql_clear_password），但当前连接没有启用 SSL —— 明文密码只在 TLS 里发送');
  }
  if (typeof scrambles[plugin] !== 'function') {
    closeSocket();
    throw new Error(`服务器要求的认证插件 ${plugin} 本插件没有实现（已实现：${Object.keys(scrambles).join('、')}）`);
  }

  const capabilities =
    CLIENT_LONG_PASSWORD | CLIENT_FOUND_ROWS | CLIENT_LONG_FLAG | CLIENT_PROTOCOL_41 |
    CLIENT_TRANSACTIONS | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH |
    // NOT CLIENT_MULTI_STATEMENTS: one statement per call is this driver's contract,
    // and enabling it would let a stray semicolon run something nobody asked for.
    (database === '' ? 0 : CLIENT_CONNECT_WITH_DB) |
    (profile?.ssl === true ? CLIENT_SSL : 0);

  const authResponse = scrambles[plugin](handshake.nonce);
  const parts = [
    (() => {
      const head = Buffer.alloc(4 + 4 + 1 + 23);
      head.writeUInt32LE(capabilities >>> 0, 0);
      head.writeUInt32LE(16 * 1024 * 1024, 4);
      head[8] = handshake.charset;
      return head;
    })(),
    Buffer.from(`${user}\0`, 'utf8'),
    Buffer.from([authResponse.length]),
    authResponse,
    database === '' ? Buffer.alloc(0) : Buffer.from(`${database}\0`, 'utf8'),
    Buffer.from(`${plugin}\0`, 'utf8'),
  ];
  writePacket(Buffer.concat(parts));

  // ── authentication replies ──
  for (;;) {
    const packet = await readPacket();
    if (packet[0] === 0x00) break; // OK
    if (packet[0] === 0xff) {
      closeSocket();
      const error = parseErr(packet);
      throw new Error(`${error.message}${error.sqlState === undefined ? '' : `（SQLSTATE ${error.sqlState} / ${error.code}）`}`);
    }
    if (packet[0] === 0xfe) {
      // AuthSwitchRequest: the server wants a different plugin than we guessed.
      let at = 1;
      let end = packet.indexOf(0, at);
      const wanted = packet.subarray(at, end).toString('utf8');
      at = end + 1;
      const nonce = packet.subarray(at).subarray(0, packet.length - at - 1);
      if (typeof scrambles[wanted] !== 'function') {
        closeSocket();
        throw new Error(`服务器切换到认证插件 ${wanted}，本插件没有实现（已实现：${Object.keys(scrambles).join('、')}）`);
      }
      if (wanted === 'mysql_clear_password' && profile?.ssl !== true) {
        closeSocket();
        throw new Error('服务器要求明文密码（mysql_clear_password），但当前连接没有启用 SSL —— 明文密码只在 TLS 里发送');
      }
      writePacket(scrambles[wanted](nonce));
      continue;
    }
    if (packet[0] === 0x01) {
      // AuthMoreData: only `caching_sha2_password` sends this.
      const status = packet[1];
      if (status === 0x03) continue;            // fast auth succeeded; an OK follows
      if (status === 0x04) {
        // Full authentication. It needs TLS or the server's RSA public key, and
        // doing it on a plain socket is the downgrade this driver refuses.
        closeSocket();
        throw new Error(
          'caching_sha2_password 需要完整认证（服务器没有缓存这个密码的哈希）：'
          + '完整认证需要 SSL 或服务器的 RSA 公钥，在明文连接上做这件事等于降级。'
          + '请在设置里打开 SSL，或先用其它客户端连一次以填充服务器缓存。',
        );
      }
      closeSocket();
      throw new Error(`认证阶段收到未知的 AuthMoreData 状态 0x${status.toString(16)}`);
    }
    closeSocket();
    throw new Error(`认证阶段收到未知的包类型 0x${packet[0].toString(16)}`);
  }

  // ── one query at a time, text protocol ──
  async function comQuery(sql, { limit, readOnly } = {}) {
    const cap = clampLimit(limit ?? DEFAULT_ROW_LIMIT);
    const started = Date.now();
    const statements = readOnly === true ? ['START TRANSACTION READ ONLY', sql] : [sql];
    let columns = [];
    let rows = [];
    let truncated = false;
    let notice;
    for (const statement of statements) {
      writePacket(Buffer.concat([Buffer.from([0x03]), Buffer.from(statement, 'utf8')]));
      const first = await readPacket();
      if (first[0] === 0xff) {
        const error = parseErr(first);
        throw withServer(new Error(`${error.message}${error.sqlState === undefined ? '' : `（SQLSTATE ${error.sqlState}）`}`), { code: error.code, sqlState: error.sqlState });
      }
      if (first[0] === 0x00) {
        const ok = parseOk(first);
        notice = `影响 ${ok.affectedRows ?? 0} 行${ok.lastInsertId ? ` · 新行 id ${ok.lastInsertId}` : ''}`;
        columns = [];
        rows = [];
        continue;
      }
      // A result set: column count, then the definitions, then rows.
      const count = readLengthEncoded(first, 0).value ?? 0;
      const definitions = [];
      for (let index = 0; index < count; index += 1) definitions.push(parseColumn(await readPacket()));
      // The terminator after the definitions: EOF (0xfe, length < 9) or an OK.
      const afterDefinitions = await readPacket();
      void afterDefinitions;
      columns = definitions.map((column) => column.name);
      rows = [];
      truncated = false;
      for (;;) {
        const packet = await readPacket();
        // EOF: 0xfe with a short length. (With DEPRECATE_EOF it would be an OK packet,
        // which this driver does not request — so the classic form is what arrives.)
        if (packet[0] === 0xfe && packet.length < 9) break;
        if (packet[0] === 0xff) {
          const error = parseErr(packet);
          throw withServer(new Error(`${error.message}${error.sqlState === undefined ? '' : `（SQLSTATE ${error.sqlState}）`}`), { code: error.code, sqlState: error.sqlState });
        }
        if (rows.length >= cap) {
          truncated = true;
          // Keep reading: the protocol has no way to abandon a result mid-stream.
          continue;
        }
        const values = [];
        let at = 0;
        for (let index = 0; index < count; index += 1) {
          const read = readLengthEncodedString(packet, at);
          values.push(read.value);
          at = read.next;
        }
        rows.push(values);
      }
      notice = notice ?? `${rows.length} 行`;
    }
    return { columns, rows, truncated, ms: Date.now() - started, notice };
  }

  const databaseName = database;

  return {
    driver: id,
    info: { host, port, database: databaseName, user, serverVersion: handshake.serverVersion, authPlugin: plugin },
    async schemas() {
      const objects = await comQuery(objectsQuery(databaseName), { limit: 5_000 });
      const columns = await comQuery(columnsQuery(databaseName), { limit: 20_000 });
      const byObject = new Map();
      for (const row of columns.rows) {
        const key = String(row[0] ?? '');
        if (!byObject.has(key)) byObject.set(key, []);
        byObject.get(key).push({
          name: String(row[1] ?? ''),
          type: String(row[2] ?? ''),
          nullable: String(row[3] ?? '').toUpperCase() === 'YES',
          primaryKey: String(row[4] ?? '').toUpperCase() === 'PRI',
          position: Number(row[5] ?? 0),
        });
      }
      return [{
        name: databaseName === '' ? '(未选择数据库)' : databaseName,
        objects: objects.rows.map((row) => ({
          name: String(row[1] ?? ''),
          kind: kindName(row[2]),
          schema: String(row[0] ?? ''),
          columns: byObject.get(String(row[1] ?? '')) ?? [],
        })),
      }];
    },
    async query(sql, { limit = DEFAULT_ROW_LIMIT, readOnly = true } = {}) {
      // SERVER-enforced: a write inside START TRANSACTION READ ONLY is refused by the
      // engine, so this is a guarantee rather than a guess about SQL text.
      return comQuery(sql, { limit, readOnly });
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

export function describe(profile) {
  const database = String(profile?.database ?? '').trim();
  return `${profile?.user ?? '?'}@${profile?.host ?? '127.0.0.1'}:${Number(profile?.port ?? 3306)}${database === '' ? '' : `/${database}`}`;
}

/** Unused constants are kept for the capability negotiation, documented above. */
export const __caps = { CLIENT_SSL, CLIENT_DEPRECATE_EOF, CLIENT_CONNECT_ATTRS };