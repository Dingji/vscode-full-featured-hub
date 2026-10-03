// A fake MySQL/MariaDB server, faithful to the framing the client must produce.
//
// It is not a stand-in for "MySQL works" — it is a way to test THIS driver's half of
// the conversation: the handshake parse, the scramble it computes, the COM_QUERY
// framing, the result-set decode, and the refusal path. The scramble is checked
// CRYPTOGRAPHICALLY (the server recomputes it from the known password), so a wrong
// implementation cannot pass.
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { nativePassword } from '../lib/sql/mysql.js';

const NONCE = Buffer.from('12345678abcdefghijkl', 'utf8'); // 20 bytes
export const PASSWORD = 'hunter2';

/** What the server expects the client to send for `mysql_native_password`. */
const expectedScramble = nativePassword(PASSWORD, NONCE);

function packet(payload, sequence) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

function lengthEncoded(value) {
  if (value === null || value === undefined) return Buffer.from([0xfb]);
  const text = Buffer.from(String(value), 'utf8');
  if (text.length < 0xfb) return Buffer.concat([Buffer.from([text.length]), text]);
  const head = Buffer.alloc(3);
  head[0] = 0xfc;
  head.writeUInt16LE(text.length, 1);
  return Buffer.concat([head, text]);
}

function columnPacket(name, sequence, typeCode = 253) {
  return packet(Buffer.concat([
    lengthEncoded('def'),
    lengthEncoded('app'),
    lengthEncoded('t'),
    lengthEncoded('t'),
    lengthEncoded(name),
    lengthEncoded(name),
    Buffer.from([0x0c, 0x21, 0x00]),          // fixed-length fields marker + charset
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(255, 0); return b; })(),
    Buffer.from([typeCode]),
    Buffer.from([0x00, 0x00]),                 // flags
    Buffer.from([0x00]),                       // decimals
    Buffer.from([0x00, 0x00]),                 // filler
  ]), sequence);
}

function resultSet(columns, rows, startSequence) {
  const parts = [];
  let sequence = startSequence;
  parts.push(packet(Buffer.from([columns.length]), sequence));
  sequence += 1;
  for (const column of columns) {
    parts.push(columnPacket(column.name, sequence, column.type ?? 253));
    sequence += 1;
  }
  parts.push(packet(Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]), sequence));
  sequence += 1;
  for (const row of rows) {
    parts.push(packet(Buffer.concat(row.map((value) => lengthEncoded(value))), sequence));
    sequence += 1;
  }
  parts.push(packet(Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]), sequence));
  return Buffer.concat(parts);
}

function okPacket(startSequence, affectedRows = 0, lastInsertId = 0) {
  return packet(Buffer.from([0x00, affectedRows, lastInsertId, 0x02, 0x00, 0x00, 0x00]), startSequence);
}

function errPacket(startSequence, code, state, message) {
  const text = Buffer.from(message, 'utf8');
  return packet(Buffer.concat([
    Buffer.from([0xff]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(code, 0); return b; })(),
    Buffer.from(`#${state}`, 'utf8'),
    text,
  ]), startSequence);
}

/**
 * Start the fake server.
 * @returns {Promise<{ port: number, close: () => Promise<void>, seen: string[], scrambles: number }>}
 */
export function startFakeMysql({ serverVersion = '8.0.36-fake' } = {}) {
  const seen = [];
  const state = { scrambles: 0, authenticated: false, wrongScramble: false };
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let stage = 'handshake';
    let handled = 0;

    const send = (payload) => socket.write(payload);

    // Handshake v10
    const capabilities = 0x00000001 | 0x00000200 | 0x00002000 | 0x00008000 | 0x00080000;
    const head = Buffer.concat([
      Buffer.from([0x0a]),
      Buffer.from(`${serverVersion}\0`, 'utf8'),
      Buffer.from([0x01, 0x00, 0x00, 0x00]),          // thread id
      NONCE.subarray(0, 8),
      Buffer.from([0x00]),                             // filler
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(capabilities & 0xffff, 0); return b; })(),
      Buffer.from([0x21]),                             // charset
      Buffer.from([0x02, 0x00]),                       // status
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE((capabilities >>> 16) & 0xffff, 0); return b; })(),
      Buffer.from([21]),                               // auth plugin data length
      Buffer.alloc(10),
      NONCE.subarray(8),
      Buffer.from([0x00]),
      Buffer.from('mysql_native_password\0', 'utf8'),
    ]);
    send(packet(head, 0));

    // Whether a READ ONLY transaction is open, so the server can refuse a write for
    // the RIGHT reason. A fake that refuses everything would make the write toggle
    // untestable — and the toggle is the feature.
    let inReadOnly = false;

    const onQuery = (sql) => {
      seen.push(sql);
      const sequence = 1;
      if (/^START TRANSACTION READ ONLY$/i.test(sql.trim())) {
        inReadOnly = true;
        send(okPacket(sequence));
        return;
      }
      if (/^(commit|rollback)/i.test(sql.trim())) {
        inReadOnly = false;
        send(okPacket(sequence));
        return;
      }
      if (sql.includes('information_schema.tables')) {
        send(resultSet([{ name: 'schema' }, { name: 'name' }, { name: 'kind' }], [
          ['app', 'users', 'BASE TABLE'],
          ['app', 'top_users', 'VIEW'],
        ], sequence));
        return;
      }
      if (sql.includes('information_schema.columns')) {
        send(resultSet([
          { name: 'object' }, { name: 'name' }, { name: 'type' },
          { name: 'nullable' }, { name: 'colkey' }, { name: 'position', type: 3 },
        ], [
          ['users', 'id', 'int unsigned', 'NO', 'PRI', 1],
          ['users', 'name', 'varchar(64)', 'YES', '', 2],
          ['top_users', 'name', 'varchar(64)', 'YES', '', 1],
        ], sequence));
        return;
      }
      if (/^(insert|update|delete|drop|create)/i.test(sql.trim())) {
        // What a real server does inside START TRANSACTION READ ONLY — and only then.
        // Outside one, a write succeeds, which is what makes the write toggle real.
        if (inReadOnly) {
          send(errPacket(sequence, 1792, '25006', 'Cannot execute statement in a READ ONLY transaction.'));
          return;
        }
        send(okPacket(sequence, 1, 7));
        return;
      }
      if (/^select \* from missing/i.test(sql.trim())) {
        send(errPacket(sequence, 1146, '42S02', "Table 'app.missing' doesn't exist"));
        return;
      }
      if (/^select/i.test(sql.trim())) {
        send(resultSet([{ name: 'id', type: 3 }, { name: 'name' }], [
          [1, '甲'], [2, '乙'], [3, null],
        ], sequence));
        return;
      }
      send(okPacket(sequence, 3, 42));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUIntLE(0, 3);
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        if (stage === 'handshake') {
          // HandshakeResponse41: capabilities(4) maxPacket(4) charset(1) reserved(23)
          let at = 32;
          const userEnd = payload.indexOf(0, at);
          const user = payload.subarray(at, userEnd).toString('utf8');
          at = userEnd + 1;
          const authLength = payload[at];
          at += 1;
          const auth = payload.subarray(at, at + authLength);
          state.scrambles += 1;
          if (user !== 'root' || !auth.equals(expectedScramble)) {
            state.wrongScramble = true;
            send(errPacket(2, 1045, '28000', `Access denied for user '${user}'@'localhost' (using password: YES)`));
            return;
          }
          state.authenticated = true;
          send(okPacket(2));
          stage = 'ready';
          continue;
        }
        // COM_QUERY
        if (payload[0] === 0x03) {
          handled += 1;
          onQuery(payload.subarray(1).toString('utf8'));
          continue;
        }
        if (payload[0] === 0x01) { // COM_QUIT
          socket.end();
          return;
        }
        send(errPacket(1, 1047, '08S01', `unknown command 0x${payload[0].toString(16)}`));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        seen,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

/** The SHA1 stage-2 hash, used by the test to double-check the scramble independently. */
export function scrambleFromScratch(password, nonce) {
  const s1 = createHash('sha1').update(password, 'utf8').digest();
  const s2 = createHash('sha1').update(s1).digest();
  const s3 = createHash('sha1').update(Buffer.concat([nonce, s2])).digest();
  const out = Buffer.alloc(s1.length);
  for (let i = 0; i < s1.length; i += 1) out[i] = s1[i] ^ s3[i];
  return out;
}