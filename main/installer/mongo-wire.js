// Just enough of the MongoDB wire protocol to manage the portable server without mongosh (which the server zip does
// not include) or the npm driver (installed only on demand): OP_MSG commands over a socket, a small BSON codec, and
// SCRAM-SHA-256 sign-in. Used to create the admin user during init and to shut the server down cleanly.
const crypto = require('crypto');
const net = require('net');

// ---------- BSON ----------
function encodeDoc(obj) {
  const body = Buffer.concat(Object.entries(obj).map(([k, v]) => encodeElement(k, v)));
  const head = Buffer.alloc(4);
  head.writeInt32LE(4 + body.length + 1);
  return Buffer.concat([head, body, Buffer.from([0])]);
}

function encodeElement(key, v) {
  let type;
  let data;
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    data = Buffer.alloc(4 + s.length + 1);
    data.writeInt32LE(s.length + 1);
    s.copy(data, 4);
    type = 0x02;
  } else if (typeof v === 'boolean') {
    type = 0x08;
    data = Buffer.from([v ? 1 : 0]);
  } else if (typeof v === 'number' && Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31) {
    type = 0x10;
    data = Buffer.alloc(4);
    data.writeInt32LE(v);
  } else if (typeof v === 'number') {
    type = 0x01;
    data = Buffer.alloc(8);
    data.writeDoubleLE(v);
  } else if (v === null || v === undefined) {
    type = 0x0a;
    data = Buffer.alloc(0);
  } else if (Buffer.isBuffer(v)) {
    type = 0x05;
    data = Buffer.alloc(5 + v.length);
    data.writeInt32LE(v.length);
    v.copy(data, 5);
  } else if (Array.isArray(v)) {
    type = 0x04;
    data = encodeDoc(Object.fromEntries(v.map((x, i) => [String(i), x])));
  } else {
    type = 0x03;
    data = encodeDoc(v);
  }
  return Buffer.concat([Buffer.from([type]), Buffer.from(key, 'utf8'), Buffer.from([0]), data]);
}

function decodeDoc(buf, off = 0, asArray = false) {
  const end = off + buf.readInt32LE(off) - 1;
  const out = asArray ? [] : {};
  let i = off + 4;
  while (i < end) {
    const type = buf[i++];
    const z = buf.indexOf(0, i);
    const key = buf.toString('utf8', i, z);
    i = z + 1;
    let v = null;
    switch (type) {
      case 0x01: v = buf.readDoubleLE(i); i += 8; break;
      case 0x02: case 0x0d: case 0x0e: { const n = buf.readInt32LE(i); v = buf.toString('utf8', i + 4, i + 3 + n); i += 4 + n; break; }
      case 0x03: case 0x04: { const n = buf.readInt32LE(i); v = decodeDoc(buf, i, type === 0x04); i += n; break; }
      case 0x05: { const n = buf.readInt32LE(i); v = buf.subarray(i + 5, i + 5 + n); i += 5 + n; break; }
      case 0x07: v = buf.toString('hex', i, i + 12); i += 12; break;
      case 0x08: v = buf[i] === 1; i += 1; break;
      case 0x09: v = new Date(Number(buf.readBigInt64LE(i))); i += 8; break;
      case 0x06: case 0x0a: case 0x7f: case 0xff: break;
      case 0x0b: { const a = buf.indexOf(0, i); const b = buf.indexOf(0, a + 1); v = `/${buf.toString('utf8', i, a)}/${buf.toString('utf8', a + 1, b)}`; i = b + 1; break; }
      case 0x0c: { const n = buf.readInt32LE(i); i += 4 + n + 12; break; }
      case 0x0f: i += buf.readInt32LE(i); break;
      case 0x10: v = buf.readInt32LE(i); i += 4; break;
      case 0x11: case 0x12: v = Number(buf.readBigInt64LE(i)); i += 8; break;
      case 0x13: i += 16; break;
      default: throw new Error(`Unsupported BSON type 0x${type.toString(16)}`);
    }
    if (asArray) out.push(v); else out[key] = v;
  }
  return out;
}

// ---------- connection ----------
async function connect(port, host = '127.0.0.1') {
  const sock = net.connect({ host, port });
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  sock.setTimeout(30000, () => sock.destroy(new Error('MongoDB did not answer within 30 seconds')));
  let pending = Buffer.alloc(0);
  let waiter = null;
  let failure = null;
  const settle = () => {
    if (!waiter) return;
    if (failure) { const w = waiter; waiter = null; w.reject(failure); return; }
    if (pending.length < 4 || pending.length < pending.readInt32LE(0)) return;
    const len = pending.readInt32LE(0);
    const msg = pending.subarray(0, len);
    pending = pending.subarray(len);
    const w = waiter;
    waiter = null;
    if (msg.readInt32LE(12) !== 2013 || msg[20] !== 0) w.reject(new Error('Unexpected reply from MongoDB'));
    else w.resolve(decodeDoc(msg, 21));
  };
  sock.on('data', (d) => { pending = Buffer.concat([pending, d]); settle(); });
  sock.on('error', (err) => { failure = err; settle(); });
  sock.on('close', () => { failure ||= new Error('Connection closed'); settle(); });
  let requestId = 1;
  return {
    command(doc) {
      const body = encodeDoc(doc);
      const head = Buffer.alloc(21);
      head.writeInt32LE(21 + body.length, 0);
      head.writeInt32LE(requestId++, 4);
      head.writeInt32LE(2013, 12);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        sock.write(Buffer.concat([head, body]));
        settle();
      });
    },
    close: () => sock.destroy(),
  };
}

const ok = (reply, what) => {
  if (reply.ok !== 1) throw new Error(`${what} failed: ${reply.errmsg || JSON.stringify(reply)}`);
  return reply;
};

// ---------- SCRAM-SHA-256 ----------
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
async function signIn(conn, user, password) {
  const nonce = crypto.randomBytes(24).toString('base64');
  const firstBare = `n=${user.replace(/=/g, '=3D').replace(/,/g, '=2C')},r=${nonce}`;
  const start = ok(await conn.command({ saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: Buffer.from(`n,,${firstBare}`), autoAuthorize: 1, options: { skipEmptyExchange: true }, $db: 'admin' }), 'Sign-in');
  const serverFirst = Buffer.from(start.payload).toString('utf8');
  const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
  if (!attrs.r?.startsWith(nonce)) throw new Error('Sign-in failed: bad server nonce');
  const salted = crypto.pbkdf2Sync(password, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const finalBare = `c=biws,r=${attrs.r}`;
  const authMessage = `${firstBare},${serverFirst},${finalBare}`;
  const signature = hmac(crypto.createHash('sha256').update(clientKey).digest(), authMessage);
  const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i])).toString('base64');
  let step = ok(await conn.command({ saslContinue: 1, conversationId: start.conversationId, payload: Buffer.from(`${finalBare},p=${proof}`), $db: 'admin' }), 'Sign-in');
  const expected = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
  if (Buffer.from(step.payload).toString('utf8') !== `v=${expected}`) throw new Error('Sign-in failed: the server signature does not match');
  while (!step.done) step = ok(await conn.command({ saslContinue: 1, conversationId: start.conversationId, payload: Buffer.alloc(0), $db: 'admin' }), 'Sign-in');
}

// Runs one admin command, signed in when credentials are given.
async function adminCommand(port, doc, { user, password } = {}) {
  const conn = await connect(port);
  try {
    if (user) await signIn(conn, user, password);
    return ok(await conn.command({ ...doc, $db: 'admin' }), Object.keys(doc)[0]);
  } finally { conn.close(); }
}

// Asks the server to shut down; it closes the connection instead of answering.
async function shutdown(port, auth) {
  try {
    await adminCommand(port, { shutdown: 1 }, auth);
  } catch (err) {
    if (!/Connection closed|ECONNRESET|EPIPE/.test(err.message)) throw err;
  }
}

module.exports = { adminCommand, shutdown, encodeDoc, decodeDoc };
