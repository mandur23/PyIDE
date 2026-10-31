// PostgreSQL and MySQL stand-ins for verify/database-tls.mjs: just enough of each wire protocol for the real pg and mysql2
// drivers to negotiate TLS, log in and ask for the version. Each server records what the client did, so the test can
// see whether TLS was asked for and whether a password ever crossed in clear text.
import { readFileSync } from 'fs';
import net from 'net';
import path from 'path';
import { Duplex } from 'stream';
import tls from 'tls';
import { fileURLToPath } from 'url';

const CERTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'port-sharing');
export const CERT_FILE = path.join(CERTS, 'localhost-cert.pem');
const secureContext = () => ({ key: readFileSync(path.join(CERTS, 'localhost-key.pem')), cert: readFileSync(CERT_FILE) });

const SSL_REQUEST = 80877103;
const pgMessage = (type, body = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');
const VERSION = 'PostgreSQL 16.0 stand-in, compiled by test';

function pgVersionRows() {
  const field = Buffer.concat([cstr('v'), int32(0), Buffer.from([0, 0]), int32(25), Buffer.from([255, 255]), int32(-1), Buffer.from([0, 0])]);
  const text = Buffer.from(VERSION, 'utf8');
  return Buffer.concat([
    pgMessage('T', Buffer.concat([Buffer.from([0, 1]), field])),
    pgMessage('D', Buffer.concat([Buffer.from([0, 1]), int32(text.length), text])),
    pgMessage('C', cstr('SELECT 1')),
    pgMessage('Z', Buffer.from('I')),
  ]);
}

// One connection after any TLS upgrade: the startup packet, a cleartext password request, then queries.
function pgSession(socket, seen, encrypted) {
  let buf = Buffer.alloc(0);
  let started = false;
  const conn = { encrypted, password: null };
  seen.connections.push(conn);
  socket.on('error', () => {});
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!started) {
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        buf = buf.subarray(buf.readInt32BE(0));
        started = true;
        socket.write(pgMessage('R', int32(3)));
        continue;
      }
      if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
      const type = String.fromCharCode(buf[0]);
      const body = buf.subarray(5, 1 + buf.readInt32BE(1));
      buf = buf.subarray(1 + buf.readInt32BE(1));
      if (type === 'p') {
        conn.password = body.toString('utf8').replace(/\0$/, '');
        socket.write(Buffer.concat([pgMessage('R', int32(0)), pgMessage('Z', Buffer.from('I'))]));
      } else if (type === 'Q') {
        socket.write(/version\(\)/i.test(body.toString('utf8')) ? pgVersionRows() : Buffer.concat([pgMessage('C', cstr('BEGIN')), pgMessage('Z', Buffer.from('I'))]));
      } else if (type === 'X') socket.end();
    }
  });
}

// tls: whether the server answers S to an SSL request; otherwise it answers N, as a server without TLS does.
export async function startPostgres({ tls: offersTls }) {
  const seen = { sslRequests: 0, connections: [] };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (first) => {
      if (first.length >= 8 && first.readInt32BE(4) === SSL_REQUEST) {
        seen.sslRequests++;
        if (!offersTls) { socket.write('N'); return; }
        socket.write('S');
        const secure = new tls.TLSSocket(socket, { isServer: true, ...secureContext() });
        secure.on('error', () => {});
        pgSession(secure, seen, true);
        return;
      }
      pgSession(socket, seen, false);
      socket.emit('data', first);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}

const CLIENT_SSL = 0x800;
const CAPABILITIES = 0x1 | 0x8 | 0x200 | 0x8000 | 0x80000; // LONG_PASSWORD, CONNECT_WITH_DB, PROTOCOL_41, SECURE_CONNECTION, PLUGIN_AUTH
const myPacket = (seq, payload) => {
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  head[3] = seq;
  return Buffer.concat([head, payload]);
};
function myHandshake(offersTls) {
  const caps = CAPABILITIES | (offersTls ? CLIENT_SSL : 0);
  const payload = Buffer.concat([
    Buffer.from([10]), cstr('8.0.0-stand-in'), int32(1).reverse(), Buffer.from('abcdefgh'), Buffer.from([0]),
    Buffer.from([caps & 0xff, (caps >> 8) & 0xff, 45, 2, 0, (caps >> 16) & 0xff, (caps >> 24) & 0xff, 21]), Buffer.alloc(10),
    Buffer.from('ijklmnopqrst'), Buffer.from([0]), cstr('mysql_native_password'),
  ]);
  return myPacket(0, payload);
}
const MY_OK = Buffer.from([0, 0, 0, 2, 0, 0, 0]);
const MY_EOF = Buffer.from([0xfe, 0, 0, 2, 0]);
const lenenc = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); };
function myVersionRows(seq) {
  const column = Buffer.concat([lenenc('def'), lenenc(''), lenenc(''), lenenc(''), lenenc('v'), lenenc(''),
    Buffer.from([0x0c, 45, 0, 0, 1, 0, 0, 0xfd, 0, 0, 0, 0, 0])]);
  return Buffer.concat([myPacket(seq, Buffer.from([1])), myPacket(seq + 1, column), myPacket(seq + 2, MY_EOF),
    myPacket(seq + 3, lenenc('8.0.0-stand-in')), myPacket(seq + 4, MY_EOF)]);
}

function mySession(socket, seen, encrypted, loginSeq) {
  let buf = Buffer.alloc(0);
  let loggedIn = false;
  const conn = { encrypted, passwordSent: false };
  seen.connections.push(conn);
  socket.on('error', () => {});
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4 || buf.length < 4 + buf.readUIntLE(0, 3)) return;
      const len = buf.readUIntLE(0, 3);
      const seq = buf[3];
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      if (!loggedIn) {
        loggedIn = true;
        // After 32 bytes of flags and a NUL-ended user comes the length-prefixed scrambled password.
        conn.passwordSent = payload[payload.indexOf(0, 32) + 1] > 0;
        socket.write(myPacket(loginSeq, MY_OK));
      } else if (payload[0] === 3) socket.write(myVersionRows(seq + 1));
      else if (payload[0] === 1) socket.end();
      else socket.write(myPacket(seq + 1, MY_OK));
    }
  });
}

export async function startMysql({ tls: offersTls }) {
  const seen = { sslRequests: 0, connections: [] };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(myHandshake(offersTls));
    socket.once('data', (first) => {
      const flags = first.readUInt32LE(4);
      // An SSL request is the first 32 bytes of the login packet, sent alone.
      if (flags & CLIENT_SSL && first.readUIntLE(0, 3) === 32) {
        seen.sslRequests++;
        // mysql2 sends its TLS hello right behind the request, so both may arrive in this one chunk.
        const raw = new Duplex({ read() {}, write(chunk, _enc, done) { socket.write(chunk, done); } });
        socket.on('data', (d) => raw.push(d));
        socket.on('end', () => raw.push(null));
        const secure = new tls.TLSSocket(raw, { isServer: true, ...secureContext() });
        secure.on('error', () => {});
        mySession(secure, seen, true, 3);
        if (first.length > 36) raw.push(first.subarray(36));
        return;
      }
      mySession(socket, seen, false, 2);
      socket.emit('data', first);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}
