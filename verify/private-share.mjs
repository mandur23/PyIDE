// Private sharing's protocol against the threats of docs/craft-private-share-design.md, plain Node with real sockets on
// loopback: main/bore-client.js runs under Electron as Node, as it does in the app, against verify/stand-in-bore.mjs,
// which relays a real public port and can read, change or record the bytes as bore.pub could.
// Every attack runs twice: against the real code, where it must fail, and against a copy with the one defence it tests
// patched out, where it must get through. A patch that does not apply stops the suite, so an attack cannot pass without
// proving it can fail. A second client written with OpenSSL's cipher holds the wire format to the design.
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import Module, { createRequire } from 'module';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { Duplex, PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { frame, standInBore } from './stand-in-bore.mjs';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
// Names are looked up in this stand-in (main/minecraft/hosts.js): localtest.me resolves to loopback as it does on the
// internet. The real DNS is never asked; a lookup that reaches it is recorded and fails.
process.env.PYIDE_MC_DNS = S({
  'localtest.me': ['127.0.0.1'], 'lan.example.test': ['192.168.1.20'], 'link.example.test': ['fe80::1'], 'mapped.example.test': ['::ffff:7f00:1'],
  'mixed.example.test': ['203.0.113.5', '10.0.0.7'], 'srv.example.test': ['203.0.113.6'], '_minecraft._tcp.srv.example.test': [{ name: 'localtest.me', port: 6379 }],
  'play.example.test': ['203.0.113.7'], 'friend.example.test': ['203.0.113.8'], 'packs.example.test': ['203.0.113.9'], 'packs.loop.test': ['127.0.0.1'],
  'redirect.example.test': ['203.0.113.10'], 'inside.example.test': ['192.168.0.9'],
});
const realDns = [];
{
  const dns = require('dns');
  dns.promises.lookup = async (name) => { realDns.push(name); throw new Error(`the real DNS was asked for ${name}`); };
  dns.promises.resolveSrv = async (name) => { realDns.push(name); throw new Error(`the real DNS was asked for ${name}`); };
}
const L = require('../main/minecraft/launcher.js');
const { parseNbt, writeNbt } = require('../main/minecraft/players/nbt.js');
const { mergeServers } = require('../main/minecraft/serversdat.js');
const { createPrivateJoin } = require('../main/minecraft/private-join.js');
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
const realClient = path.join(app, 'main', 'bore-client.js');
const work = mkdtempSync(path.join(tmpdir(), 'pyide-private-'));
const children = new Set();
process.removeAllListeners('warning');
process.on('exit', () => {
  for (const child of children) { try { child.kill(); } catch {} }
  try { rmSync(work, { recursive: true, force: true }); } catch {}
});

let failed = 0;
let passed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (test, label, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = test(); if (v) return v; await sleep(15); }
  throw new Error(`timeout: ${label}`);
};
const listen = (server) => new Promise((r) => { server.listen(0, '127.0.0.1', () => r(server.address().port)); });
const SECRET = crypto.randomBytes(32);
// In the stand-in the host's dial counts against the limit, so this link costs 3h + f = 1.2 s: 2h + f on a real link of 400 ms.
const SLOW_LINK_MS = 300;
const hmac = (secret, label, transcript) => crypto.createHmac('sha256', secret).update(label).update(transcript).digest();
const sum = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

// A copy of the client and the gate with one defence patched out. [file, from, to]: a pattern that is not there stops the
// suite, or the weakened copy would be the real code and prove nothing.
function weakCopy(name, patches) {
  const dir = path.join(work, 'weak', name.replace(/\W+/g, '-'));
  mkdirSync(path.join(dir, 'minecraft'), { recursive: true });
  for (const f of ['bore-client.js', 'bore-gate.js']) copyFileSync(path.join(app, 'main', f), path.join(dir, f));
  copyFileSync(path.join(app, 'main', 'minecraft', 'private-join.js'), path.join(dir, 'minecraft', 'private-join.js'));
  for (const [file, from, to] of patches) {
    const p = path.join(dir, file);
    const source = readFileSync(p, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: the patch does not apply to ${file}: ${from}`);
    writeFileSync(p, source.replace(from, () => to));
  }
  return path.join(dir, 'bore-client.js');
}
const gateBeside = (client) => require(path.join(path.dirname(client), 'bore-gate.js'));
// launcher.js with one defence patched out, compiled in place so its own requires still resolve.
function weakLauncher(name, patches) {
  const file = path.join(app, 'main', 'minecraft', 'launcher.js');
  let source = readFileSync(file, 'utf8');
  for (const [from, to] of patches) {
    if (!source.includes(from)) throw new Error(`${name}: the patch does not apply to launcher.js: ${from}`);
    source = source.replace(from, () => to);
  }
  const compiled = new Module(file);
  compiled.filename = file;
  compiled.paths = Module._nodeModulePaths(path.dirname(file));
  compiled._compile(source, file);
  return compiled.exports;
}

function runClient(client, args, { secret = SECRET, env = {}, prefix = [] } = {}) {
  const child = spawn(electron, [...prefix, client, ...args], { windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(secret ? { PYIDE_BORE_SECRET: secret.toString('base64url') } : {}), ...env } });
  const run = { child, out: '', err: '', code: undefined };
  children.add(child);
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  child.on('exit', (code) => { run.code = code; children.delete(child); });
  return run;
}

// The local server: says something at once, as a scanner would hope, keeps what it receives, and echoes it.
function gameServer(options = {}) {
  const game = { connections: 0, received: [], open: new Set(), bytes: () => Buffer.concat(game.received) };
  game.server = net.createServer(options, (c) => {
    game.connections++;
    game.open.add(c);
    c.on('close', () => game.open.delete(c));
    c.on('error', () => {});
    c.write('MINECRAFT-SERVER-BYTES');
    c.on('data', (d) => { game.received.push(d); c.write(Buffer.concat([Buffer.from('echo:'), d])); });
  });
  return game;
}

// A running private share: the server, the stand-in bore, and the client between them. run gets all three.
async function withHost(client, run, { secret = SECRET, prefix = [], server = {}, bore: link = {} } = {}) {
  const game = gameServer(server);
  const gamePort = await listen(game.server);
  const bore = standInBore({ relay: true, ...link });
  const controlPort = await listen(bore.server);
  const host = runClient(client, ['local', String(gamePort), '--local-host', '127.0.0.1', '--to', '127.0.0.1'], { secret, prefix, env: { PYIDE_BORE_CONTROL_PORT: String(controlPort) } });
  try {
    await until(() => /listening at 127\.0\.0\.1:\d+/.test(host.out) || host.code !== undefined, 'the host to come up', 15000);
    if (host.code !== undefined) throw new Error(`the host stopped: ${host.err}`);
    return await run({ game, bore, host, port: bore.publicPort });
  } finally {
    host.child.kill();
    bore.close();
    bore.server.close();
    for (const c of game.open) c.destroy();
    game.server.close();
  }
}

// A socket that keeps what arrives and says when it closed.
function raw(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    const s = { socket, got: [], closed: false, closedAt: 0, bytes: () => Buffer.concat(s.got) };
    socket.on('data', (d) => s.got.push(d));
    socket.on('error', () => {});
    // Half-open sockets, so the far side's FIN is an end and not a close.
    for (const event of ['end', 'close']) socket.on(event, () => { s.closed = true; s.closedAt ||= Date.now(); });
    s.take =async (n) => { await until(() => s.bytes().length >= n || s.closed, `${n} bytes`); return s.bytes().subarray(0, n); };
    s.closes = async (ms) => { const end = Date.now() + ms; while (!s.closed && Date.now() < end) await sleep(15); return s.closed; };
    socket.once('connect', () => resolve(s));
    socket.once('error', reject);
  });
}

// A friend who holds the key, speaking through the gate beside the client under test: a copy weakened on one side needs
// the same weakening on the other to get as far as the attack.
async function friend(client, port, secret = SECRET) {
  const gate = gateBeside(client);
  const wire = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  await new Promise((r, x) => { wire.once('connect', r); wire.once('error', x); });
  const keys = await gate.clientHandshake(wire, secret);
  const f = { wire, keys, got: [], closed: false, seal: new gate.Seal(keys.client), open: new gate.Open(keys.host), bytes: () => Buffer.concat(f.got) };
  for (const event of ['end', 'close']) wire.on(event, () => { f.closed = true; });
  wire.on('data', (d) => f.got.push(d));
  f.seal.on('error', () => {});
  f.open.on('error', () => {});
  f.send = (data) => new Promise((resolve) => { f.seal.once('data', (record) => { wire.write(record); resolve(record); }); f.seal.write(data); });
  f.end = () => new Promise((resolve) => { f.seal.once('data', (record) => { wire.end(record); resolve(); }); f.seal.end(); });
  return f;
}

const OPENSSL = 'chacha20-poly1305';
function referenceRecord(keys, n, plain) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(plain.length);
  const iv = Buffer.from(keys.iv);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(n));
  for (let i = 0; i < 8; i++) iv[4 + i] ^= counter[i];
  const c = crypto.createCipheriv(OPENSSL, keys.key, iv, { authTagLength: 16 });
  c.setAAD(length);
  return Buffer.concat([length, c.update(plain), c.final(), c.getAuthTag()]);
}
function referenceOpen(keys, n, record) {
  const size = record.readUInt16BE(0);
  const iv = Buffer.from(keys.iv);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(n));
  for (let i = 0; i < 8; i++) iv[4 + i] ^= counter[i];
  const d = crypto.createDecipheriv(OPENSSL, keys.key, iv, { authTagLength: 16 });
  d.setAAD(record.subarray(0, 2));
  d.setAuthTag(record.subarray(2 + size, 2 + size + 16));
  return Buffer.concat([d.update(record.subarray(2, 2 + size)), d.final()]);
}
function referenceKeys(shared, secret, sn, cn) {
  const raw88 = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([shared, secret]), Buffer.concat([sn, cn]), 'nano1-keys', 88));
  return { client: { key: raw88.subarray(0, 32), iv: raw88.subarray(64, 76) }, host: { key: raw88.subarray(32, 64), iv: raw88.subarray(76, 88) } };
}
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
function referenceHello() {
  const pair = crypto.generateKeyPairSync('x25519');
  const cn = crypto.randomBytes(32);
  return { pair, cn, hello: Buffer.concat([cn, pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]) };
}
const referenceShared = (pair, peer) => crypto.diffieHellman({ privateKey: pair.privateKey,
  publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI, peer]), format: 'der', type: 'spki' }) });

// ---------- attacks ----------
const ATTACKS = [];
const attack = (name, patches, run) => ATTACKS.push({ name, patches, run });
const NO_CHECK_HOST = "if (!crypto.timingSafeEqual(answer, proof(secret, 'nano1-client', transcript))) throw new Error('the client does not hold the key');";
const NO_CHECK_CLIENT = "if (!crypto.timingSafeEqual(answer, proof(secret, 'nano1-host', transcript))) throw new Error('the other side does not hold the key');";
const NO_TAG_CHECK = [['bore-gate.js', 'additionalData: length }, state.cryptoKey, sealed));', 'additionalData: length }, state.cryptoKey, sealed).catch(() => sealed.subarray(0, -TAG_SIZE)));']];
const AGREED = "  const shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey });\n  if (shared.every((byte) => byte === 0)) throw new Error('the other side sent a low-order point');\n  return shared;";
const LOW_ORDER = [['bore-gate.js', AGREED, '  try { return crypto.diffieHellman({ privateKey: mine.privateKey, publicKey }); } catch { return Buffer.alloc(32); }']];
const POINTS = [Buffer.alloc(32), Buffer.from('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex')];
// Long enough for a loaded machine, and the wait ends as soon as the attack has its answer either way.
const outcome = (test, ms = 8000) => until(test, 'an outcome', ms).catch(() => {});

attack('wrong key', [['bore-gate.js', NO_CHECK_HOST, '']], (client) => withHost(client, async ({ game, port }) => {
  const s = await raw(port);
  const { hello } = referenceHello();
  s.socket.write(hello);
  const reply = await s.take(64);
  s.socket.write(hmac(crypto.randomBytes(32), 'nano1-client', Buffer.concat([hello, reply])));
  await outcome(() => s.closed || game.connections);
  await sleep(200);
  return { ok: s.closed && game.connections === 0 && s.bytes().length === 64,
    why: `closed ${s.closed}, the server saw ${game.connections} connections, ${s.bytes().length} bytes came back` };
}));

const listens = (client) => withHost(client, async ({ game, port }) => {
  const s = await raw(port);
  await s.closes(8000);
  const seen = s.bytes();
  return { ok: s.closed && seen.length === 0 && game.connections === 0,
    why: `closed ${s.closed}, the scanner got ${seen.length} bytes (${seen.includes('MINECRAFT') ? 'with' : 'without'} the server's own), the server saw ${game.connections} connections` };
});
attack('a scanner that only listens', [['bore-gate.js', 'const hello = await readExactly(wire, HELLO_SIZE);\n    onHello();', 'wire.write(crypto.randomBytes(HELLO_SIZE));\n    const hello = await readExactly(wire, HELLO_SIZE);\n    onHello();']], listens);
attack('a scanner reaching the server', [['bore-client.js', '      keys = await gate.hostHandshake(remote, secret, {', '      (await dial(localHost, localPort)).pipe(remote);\n      keys = await gate.hostHandshake(remote, secret, {']], listens);

attack('junk of the right size', [['bore-gate.js', 'wire.write(Buffer.concat([sn, mine.raw]));', "wire.write(Buffer.concat([Buffer.from('NANO1\\0', 'latin1'), sn.subarray(6), mine.raw]));"]],
  (client) => withHost(client, async ({ game, port }) => {
    const replies = [];
    let closed = 0;
    for (const size of [64, 96, 96, 96]) {
      const s = await raw(port);
      s.socket.write(crypto.randomBytes(size));
      if (await s.closes(8000)) closed++;
      replies.push(s.bytes());
    }
    const fixed = Array.from({ length: 64 }, (_, i) => i).filter((i) => replies.every((r) => r[i] === replies[0][i]));
    return { ok: closed === 4 && replies.every((r) => r.length === 64) && !fixed.length && !game.connections,
      why: `${closed} of 4 closed after ${replies.map((r) => r.length).join(', ')} bytes, ${fixed.length} byte positions the same in every reply, the server saw ${game.connections} connections` };
  }));

attack('replay of a recorded session', [['bore-gate.js', 'const sn = crypto.randomBytes(RANDOM_SIZE);\n    const mine = ephemeral();\n    wire.write', 'const sn = Buffer.alloc(RANDOM_SIZE, 7);\n    const mine = (global.pair ||= ephemeral());\n    wire.write']],
  (client) => withHost(client, async ({ game, bore, port }) => {
    const recorded = [];
    bore.tap = (direction, chunk) => { if (direction === 'toHost') recorded.push(chunk); return chunk; };
    const f = await friend(client, port);
    await f.send('a chat message');
    await until(() => game.received.length, 'the session to reach the server');
    f.wire.destroy();
    bore.tap = null;
    await until(() => !game.open.size, 'the session to end');
    const before = game.bytes().length;
    const s = await raw(port);
    s.socket.write(Buffer.concat(recorded));
    await outcome(() => s.closed || game.bytes().length > before);
    await sleep(200);
    return { ok: s.closed && game.connections === 1 && game.bytes().length === before,
      why: `the replay closed ${s.closed}, the server saw ${game.connections} connections and ${game.bytes().length - before} replayed bytes` };
  }));

attack('a leaked code and a recording', [['bore-gate.js', AGREED, '  return Buffer.alloc(32);']], (client) => withHost(client, async ({ game, bore, port }) => {
  const heard = { toHost: [], toClient: [] };
  bore.tap = (direction, chunk) => { heard[direction].push(chunk); return chunk; };
  const f = await friend(client, port);
  await f.send('a private message');
  await until(() => game.received.length, 'the session to reach the server');
  f.wire.destroy();
  bore.tap = null;
  const up = Buffer.concat(heard.toHost);
  const down = Buffer.concat(heard.toClient);
  const [cn, ce, sn, se] = [up.subarray(0, 32), up.subarray(32, 64), down.subarray(0, 32), down.subarray(32, 64)];
  const holdsTheCode = up.subarray(64, 96).equals(hmac(SECRET, 'nano1-client', Buffer.concat([cn, ce, sn, se])));
  const guesses = [Buffer.alloc(32), ce, se, crypto.createHash('sha256').update(ce).update(se).digest()];
  const opened = guesses.map((shared) => {
    try { return referenceOpen(referenceKeys(shared, SECRET, sn, cn).client, 0, up.subarray(96)).toString(); } catch { return null; }
  }).filter(Boolean);
  return { ok: holdsTheCode && !opened.length,
    why: `with the key the recorded proof ${holdsTheCode ? 'checks out' : 'does not check out'}, and ${opened.length} of ${guesses.length} guesses at the shared secret open the record${opened.length ? ` (${opened[0]})` : ''}` };
}));

// A relay that speaks the handshake with what it has: a hello of its own, and for the proof it cannot make, noise.
async function relayed(client, point) {
  let toRelay = 0;
  let step = 0;
  const relay = net.createServer((c) => {
    c.on('error', () => {});
    c.on('data', (d) => {
      toRelay += d.length;
      if (toRelay >= 64 && step === 0) { step = 1; c.write(Buffer.concat([crypto.randomBytes(32), point()])); }
      if (toRelay >= 96 && step === 1) { step = 2; c.write(crypto.randomBytes(32)); }
    });
  });
  const relayPort = await listen(relay);
  const join = runClient(client, ['join', '--to', `127.0.0.1:${relayPort}`, '--listen', '127.0.0.1:0']);
  try {
    const m = await until(() => /listening at 127\.0\.0\.1:(\d+)/.exec(join.out), 'join to listen', 15000);
    const game = await raw(Number(m[1]));
    game.socket.write('what the player typed');
    await outcome(() => game.closed || toRelay > 96);
    await sleep(200);
    return { closed: game.closed, toRelay };
  } finally { join.child.kill(); relay.close(); }
}
attack('a relay posing as the host', [['bore-gate.js', NO_CHECK_CLIENT, '']], async (client) => {
  const { closed, toRelay } = await relayed(client, () => crypto.randomBytes(32));
  return { ok: closed && toRelay === 96, why: `the game's connection closed ${closed}, the relay received ${toRelay} bytes` };
});
attack('a relay sending a low-order point', LOW_ORDER, async (client) => {
  const { closed, toRelay } = await relayed(client, () => POINTS[0]);
  return { ok: closed && toRelay === 64, why: `the game's connection closed ${closed}, the relay received ${toRelay} bytes: a client that refuses sends no proof` };
});
attack('a low-order point from someone with the key', LOW_ORDER, (client) => withHost(client, async ({ game, port }) => {
  const refused = [];
  for (const point of POINTS) {
    const s = await raw(port);
    const hello = Buffer.concat([crypto.randomBytes(32), point]);
    s.socket.write(hello);
    const reply = await s.take(64);
    s.socket.write(hmac(SECRET, 'nano1-client', Buffer.concat([hello, reply])));
    await outcome(() => s.closed || game.connections);
    await sleep(100);
    refused.push(s.closed && s.bytes().length === 64);
    s.socket.destroy();
  }
  return { ok: refused.every(Boolean) && !game.connections, why: `refused ${refused.join(', ')}, the server saw ${game.connections} connections` };
}));

attack('tampered record', NO_TAG_CHECK, (client) => withHost(client, async ({ game, bore, port }) => {
  const f = await friend(client, port);
  await until(() => game.connections, 'the handshake');
  bore.tap = (direction, chunk) => {
    if (direction !== 'toHost') return chunk;
    const changed = Buffer.from(chunk);
    changed[changed.length - 20] ^= 1;
    return changed;
  };
  await f.send('give me diamonds');
  await outcome(() => (f.closed && !game.open.size) || game.received.length);
  return { ok: f.closed && !game.received.length && !game.open.size, why: `the connection closed ${f.closed}, the server received ${game.bytes().length} bytes` };
}));

attack('records in the wrong order', [['bore-gate.js', '  direction.counter += 1n;\n', '']], (client) => withHost(client, async ({ game, bore, port }) => {
  const f = await friend(client, port);
  await until(() => game.connections, 'the handshake');
  let held = null;
  bore.tap = (direction, chunk) => {
    if (direction !== 'toHost') return chunk;
    if (!held) { held = chunk; return null; }
    return Buffer.concat([chunk, held]);
  };
  await f.send('first ');
  await sleep(50);
  await f.send('second');
  await outcome(() => f.closed || game.bytes().length >= 12);
  await sleep(200);
  return { ok: f.closed && !game.received.length, why: `the connection closed ${f.closed}, the server received ${JSON.stringify(game.bytes().toString())}` };
}));

attack('a record sent back at its sender', [['bore-gate.js', 'host: { key: raw.subarray(32, 64), iv: raw.subarray(76, 88) },', 'host: { key: raw.subarray(0, 32), iv: raw.subarray(64, 76) },']],
  (client) => withHost(client, async ({ game, port }) => {
    const f = await friend(client, port);
    await until(() => f.got.length, 'the first record from the host');
    f.wire.write(f.bytes());
    await outcome(() => f.closed || game.received.length);
    await sleep(200);
    return { ok: f.closed && !game.received.length, why: `the connection closed ${f.closed}, the server received its own ${game.bytes().length} bytes` };
  }));

attack('truncated record', [['bore-gate.js', 'pipeline(wire, open, plain, over);', "wire.pipe(open).pipe(plain);\n  open.on('error', () => {});"]],
  (client) => withHost(client, async ({ game, port }) => {
    const f = await friend(client, port);
    await until(() => game.connections, 'the handshake');
    const record = await new Promise((resolve) => { f.seal.once('data', resolve); f.seal.write('half a message'); });
    f.wire.end(record.subarray(0, 9));
    await outcome(() => !game.open.size, 4000);
    return { ok: !game.open.size && !game.received.length, why: `${game.open.size} connections left open at the server, which received ${game.bytes().length} bytes` };
  }));

// The far end goes at once on an end nobody with the keys wrote. A clean end would leave the server LINGER_MS to finish,
// which this stays under. It writes, because a socket that only waits never learns the far side has gone.
const endsAtOnce = (finish) => (client) => withHost(client, async ({ game, port }) => {
  const f = await friend(client, port);
  await f.send('half a conversation');
  await until(() => game.received.length, 'the record to arrive');
  const server = [...game.open][0];
  const beat = setInterval(() => { if (!server.destroyed) server.write('x'); }, 100);
  const began = Date.now();
  finish(f);
  await outcome(() => !game.open.size, 4000);
  const took = Date.now() - began;
  clearInterval(beat);
  return { ok: !game.open.size, why: `${game.open.size} connections left at the server ${took} ms after the wire ended` };
}, { server: { allowHalfOpen: true } });
attack('a connection cut between records', [['bore-gate.js', "done(this.ended ? undefined : new Error('the connection ended without its last record'));", 'done();']], endsAtOnce((f) => f.wire.end()));
attack('a forged last record', NO_TAG_CHECK, endsAtOnce((f) => f.wire.end(Buffer.concat([Buffer.alloc(2), crypto.randomBytes(16)]))));

attack('a record after the last one', [['bore-gate.js', 'while (data.length >= LENGTH_SIZE && !this.ended) {', 'while (data.length >= LENGTH_SIZE) {'], ['bore-gate.js', "if (this.ended && data.length) throw new Error('something came after the last record');", '']],
  (client) => withHost(client, async ({ game, port }) => {
    const gate = gateBeside(client);
    const f = await friend(client, port);
    await until(() => game.connections, 'the handshake');
    const state = await gate.direction(f.keys.client, 'encrypt');
    f.wire.write(Buffer.concat([await gate.sealRecord(state, Buffer.alloc(0)), await gate.sealRecord(state, Buffer.from('after the end'))]));
    await outcome(() => f.closed || game.received.length);
    await sleep(200);
    return { ok: f.closed && !game.received.length, why: `the connection closed ${f.closed}, the server received ${JSON.stringify(game.bytes().toString())}` };
  }));

attack('a length out of range', [['bore-gate.js', "if (size > MAX_RECORD) throw new Error('a record has a length out of range');", '']],
  (client) => withHost(client, async ({ game, port }) => {
    const left = [];
    for (const length of [0xffff, 16385]) {
      const f = await friend(client, port);
      await until(() => game.open.size, 'the handshake');
      f.wire.write(Buffer.from([length >> 8, length & 255]));
      await outcome(() => f.closed, 3000);
      left.push(f.closed);
      f.wire.destroy();
      await until(() => !game.open.size, 'the session to end');
    }
    return { ok: left.every(Boolean) && !game.received.length, why: `closed at once for 65535 and 16385: ${left.join(', ')}` };
  }));

attack('slow handshake', [['bore-gate.js', 'const HANDSHAKE_MS = 2000;', 'const HANDSHAKE_MS = 600000;']], (client) => withHost(client, async ({ game, port }) => {
  const s = await raw(port);
  const began = Date.now();
  const drip = setInterval(() => { if (!s.closed) s.socket.write(Buffer.alloc(1, 1)); }, 400);
  await s.closes(8000);
  clearInterval(drip);
  const took = Date.now() - began;
  return { ok: s.closed && took >= 1500 && game.connections === 0, why: `closed ${s.closed} after ${took} ms of a byte every 400 ms` };
}));

attack('connection flood', [['bore-client.js', 'const MAX_HANDSHAKES = 64;', 'const MAX_HANDSHAKES = 100000;'], ['bore-gate.js', 'const HANDSHAKE_MS = 2000;', 'const HANDSHAKE_MS = 600000;']],
  (client) => withHost(client, async ({ game, bore, port }) => {
    const flood = await Promise.all(Array.from({ length: 200 }, () => raw(port)));
    await until(() => bore.seen.first.length >= 64, 'the host to take the flood up', 8000);
    await outcome(() => bore.accepted() <= 64 && bore.seen.first.length > 64, 10000);
    const held = bore.accepted();
    const f = await friend(client, port);
    await f.send('still here');
    await until(() => game.received.length, 'a friend after the flood');
    for (const s of flood) s.socket.destroy();
    return { ok: held <= 64 && game.connections === 1, why: `${held} of 200 held a socket at the host, and a friend got through` };
  }));

attack('junk from a client', [['bore-gate.js', 'const chunk = stream.read(n);', 'const chunk = stream.read();']], async (client) => {
  const remote = await withHost(client, async ({ game, port }) => {
    const s = await raw(port);
    s.socket.write(crypto.randomBytes(1 << 20));
    await s.closes(8000);
    return { closed: s.closed, connections: game.connections };
  });
  const wire = new PassThrough();
  wire.write(Buffer.alloc(100096, 1));
  const realRead = wire.read.bind(wire);
  let taken = 0;
  wire.read = (n) => { const chunk = realRead(n); taken += chunk?.length || 0; return chunk; };
  await gateBeside(client).hostHandshake(wire, SECRET).catch(() => {});
  return { ok: remote.closed && !remote.connections && taken === 96, why: `closed ${remote.closed}, the server saw ${remote.connections} connections, the handshake took ${taken} of 100096 bytes` };
});

// A scanner opens rate sockets a second and sends nothing, while a friend tries every ATTEMPT_MS. -> how many tries failed.
const ATTEMPTS = 23;
const ATTEMPT_MS = 1000;
function lockedOut(client, rate, { latency = null, attempts = ATTEMPTS, every = ATTEMPT_MS } = {}) {
  return withHost(client, async ({ port }) => {
    const held = [];
    let stop = false;
    const began = Date.now();
    const scanner = (async () => {
      for (let opened = 0; !stop; await sleep(5)) {
        for (; opened < Math.floor(((Date.now() - began) / 1000) * rate); opened++) {
          const s = net.connect({ host: '127.0.0.1', port });
          s.on('error', () => {});
          held.push(s);
        }
      }
    })();
    const gate = gateBeside(client);
    const once = async () => {
      const wire = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      wire.on('error', () => {});
      const ok = await gate.clientHandshake(wire, SECRET, { timeoutMs: 4000 }).then(() => true, () => false);
      wire.destroy();
      return ok;
    };
    const tries = [];
    for (let i = 0; i < attempts; i++) {
      tries.push(once());
      await sleep(every);
    }
    const got = await Promise.all(tries);
    stop = true;
    await scanner;
    for (const s of held) s.destroy();
    return got.filter((ok) => !ok).length;
  }, { bore: { latency } });
}
const REFUSES_NEWCOMERS = [['bore-client.js', 'const MAX_HANDSHAKES = 64;', 'const MAX_HANDSHAKES = 16;'], ['bore-gate.js', 'const HANDSHAKE_MS = 2000;', 'const HANDSHAKE_MS = 5000;'], ['bore-client.js', 'if (unproven.size >= MAX_HANDSHAKES) dropOne();', 'if (unproven.size >= MAX_HANDSHAKES) return note();']];
for (const rate of [4, 10, 50]) {
  attack(`a silent scanner at ${rate} sockets a second`, REFUSES_NEWCOMERS, async (client) => {
    const failed = await lockedOut(client, rate);
    return { ok: failed === 0, why: `${failed} of ${ATTEMPTS} tries by a friend failed` };
  });
}
attack('a silent scanner at 30 sockets a second, friends 150 ms away', [['bore-client.js', 'const MAX_HANDSHAKES = 64;', 'const MAX_HANDSHAKES = 16;'], ['bore-client.js', '[...unproven].find((h) => !h.spoke) ?? unproven.values().next().value', 'unproven.values().next().value']], async (client) => {
  const failed = await lockedOut(client, 30, { latency: { host: 150, friend: 150 }, attempts: 10 });
  return { ok: failed === 0, why: `${failed} of 10 tries by a friend failed` };
});
attack('a friend on a slow link', [['bore-gate.js', 'const HANDSHAKE_MS = 2000;', 'const HANDSHAKE_MS = 300;']], async (client) => {
  const latency = { host: SLOW_LINK_MS, friend: SLOW_LINK_MS };
  const failed = await withHost(client, async ({ port }) => {
    const gate = gateBeside(client);
    const tries = await Promise.all(Array.from({ length: 5 }, async () => {
      const wire = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      wire.on('error', () => {});
      const ok = await gate.clientHandshake(wire, SECRET).then(() => true, () => false);
      wire.destroy();
      return ok;
    }));
    return tries.filter((ok) => !ok).length;
  }, { bore: { latency } });
  return { ok: failed === 0, why: `${failed} of 5 handshakes failed with ${SLOW_LINK_MS} ms round trips to bore on both sides` };
});

const NAIVE = [['bore-gate.js', 'pipeline(plain, seal, wire, over);', "plain.on('data', (c) => seal.write(c));\n  plain.on('end', () => seal.end());\n  seal.on('data', (c) => wire.write(c));\n  seal.on('end', () => wire.end());"],
  ['bore-gate.js', 'pipeline(wire, open, plain, over);', "wire.on('data', (c) => open.write(c));\n  wire.on('end', () => open.end());\n  open.on('data', (c) => plain.write(c));\n  open.on('end', () => plain.end());"]];
const BURST = crypto.randomBytes(5 << 20);

// A stream on one end that offers the burst as fast as it is taken, and a stream on the other that takes nothing until
// released: how much was taken from the fast end is what the tunnel holds.
function fastEnd(data) {
  const s = new Duplex({
    read() { if (s.at < data.length) { const chunk = data.subarray(s.at, s.at + 65536); s.at += chunk.length; s.push(chunk); } else s.push(null); },
    write(_c, _e, done) { done(); },
  });
  s.at = 0;
  return s;
}
function stalledEnd() {
  const s = new Duplex({
    read() {},
    write(chunk, _e, done) { s.chunks.push(chunk); if (s.flowing) done(); else s.held = done; },
  });
  s.chunks = [];
  s.flowing = false;
  s.release = () => { s.flowing = true; s.held?.(); };
  return s;
}

attack('5 MB from a fast server, friend not reading', NAIVE, async (client) => {
  const gate = gateBeside(client);
  const keys = gate.deriveKeys(crypto.randomBytes(32), SECRET, crypto.randomBytes(32), crypto.randomBytes(32));
  const server = fastEnd(BURST);
  const wire = stalledEnd();
  gate.tunnel(wire, server, keys, 'host');
  await sleep(600);
  const held = server.at;
  wire.release();
  await until(() => wire.writableFinished, 'the burst to pass', 20000);
  const open = new gate.Open(keys.host);
  const out = [];
  open.on('data', (d) => out.push(d));
  for (const c of wire.chunks) open.write(c);
  open.end();
  await new Promise((r, x) => { open.once('end', r); open.once('error', x); });
  const whole = sum(Buffer.concat(out)) === sum(BURST);
  wire.destroy();
  server.destroy();
  return { ok: held < (1 << 20) && whole, why: `${Math.round(held / 1024)} KB of 5120 KB taken from the server while the far side stalled, ${whole ? 'all of it intact after' : 'damaged after'}` };
});

attack('5 MB from a fast player, server not reading', NAIVE, async (client) => {
  const gate = gateBeside(client);
  const keys = gate.deriveKeys(crypto.randomBytes(32), SECRET, crypto.randomBytes(32), crypto.randomBytes(32));
  const seal = new gate.Seal(keys.client);
  const records = [];
  seal.on('data', (d) => records.push(d));
  seal.end(BURST);
  await new Promise((r) => { seal.once('end', r); });
  const wire = fastEnd(Buffer.concat(records));
  const server = stalledEnd();
  gate.tunnel(wire, server, keys, 'host');
  await sleep(600);
  const held = wire.at;
  server.release();
  await until(() => server.chunks.reduce((n, c) => n + c.length, 0) >= BURST.length, 'the burst to pass', 20000);
  const whole = sum(Buffer.concat(server.chunks)) === sum(BURST);
  wire.destroy();
  server.destroy();
  return { ok: held < (1 << 20) && whole, why: `${Math.round(held / 1024)} KB of 5120 KB taken from the wire while the server stalled, ${whole ? 'all of it intact after' : 'damaged after'}` };
});

// Past two real processes, the relay and every kernel buffer between them.
attack('5 MB through both processes', NAIVE, async (client) => {
  let offered = 0;
  // In pieces: one write of it all is handed to the system at once, and says nothing about who took it.
  const game = net.createServer((c) => {
    c.on('error', () => {});
    game.conn = c;
    const pump = () => {
      while (offered < BURST.length) {
        const piece = BURST.subarray(offered, offered + 65536);
        offered += piece.length;
        if (!c.write(piece)) { c.once('drain', pump); return; }
      }
    };
    pump();
  });
  const gamePort = await listen(game);
  const bore = standInBore({ relay: true });
  const controlPort = await listen(bore.server);
  const host = runClient(client, ['local', String(gamePort), '--local-host', '127.0.0.1', '--to', '127.0.0.1'], { env: { PYIDE_BORE_CONTROL_PORT: String(controlPort) } });
  let join = null;
  try {
    await until(() => /listening at/.test(host.out), 'the host', 15000);
    join = runClient(client, ['join', '--to', `127.0.0.1:${bore.publicPort}`, '--listen', '127.0.0.1:0']);
    const m = await until(() => /listening at 127\.0\.0\.1:(\d+)/.exec(join.out), 'join', 15000);
    const socket = net.connect({ host: '127.0.0.1', port: Number(m[1]) });
    socket.on('error', () => {});
    socket.pause();
    await until(() => game.conn, 'the server to be reached', 10000);
    await sleep(1500);
    const accepted = offered;
    const got = [];
    socket.on('data', (d) => got.push(d));
    socket.resume();
    await until(() => got.reduce((n, c) => n + c.length, 0) >= BURST.length, 'the burst to arrive', 30000);
    const whole = sum(Buffer.concat(got)) === sum(BURST);
    socket.destroy();
    return { ok: accepted < BURST.length && whole, why: `the server got ${Math.round(accepted / 1024)} KB of 5120 KB away while the player was not reading, ${whole ? 'all of it intact after' : 'damaged after'}` };
  } finally {
    host.child.kill();
    join?.child.kill();
    bore.close();
    bore.server.close();
    game.conn?.destroy();
    game.close();
  }
});

attack('half-open connection', [['bore-gate.js', 'lingering = setTimeout(close, LINGER_MS);\n    lingering.unref();', 'lingering = { unref() {} };']],
  (client) => withHost(client, async ({ game, port }) => {
    const f = await friend(client, port);
    await until(() => game.open.size, 'the handshake');
    // It stays half-open by writing: a socket that only waits never learns the far side has gone.
    const server = [...game.open][0];
    const beat = setInterval(() => { if (!server.destroyed) server.write('x'); }, 200);
    const began = Date.now();
    await f.end();
    await outcome(() => !game.open.size, 12000);
    const took = Date.now() - began;
    clearInterval(beat);
    return { ok: !game.open.size && took >= 4500, why: `${game.open.size} connections left at the server ${took} ms after the friend half-closed` };
  }, { server: { allowHalfOpen: true } }));

attack('the counter running out', [['bore-gate.js', "if (direction.counter > LAST_COUNTER) throw new Error('the record counter ran out');", ''],
  ['bore-gate.js', 'counter.writeBigUInt64BE(direction.counter);', 'counter.writeBigUInt64BE(BigInt.asUintN(64, direction.counter));']], async (client) => {
  const gate = gateBeside(client);
  const state = await gate.direction({ key: crypto.randomBytes(32), iv: crypto.randomBytes(12) }, 'encrypt');
  state.counter = 2n ** 64n - 1n;
  await gate.sealRecord(state, Buffer.from('the last one'));
  const next = await gate.sealRecord(state, Buffer.from('one too many')).then(() => 'sealed under a nonce already used', (err) => err.message);
  return { ok: /ran out/.test(next), why: `after the last counter value: ${next}` };
});

async function secretLeaks(client) {
  const probe = path.join(work, 'probe.cjs');
  const probeOut = path.join(work, `env-${crypto.randomBytes(4).toString('hex')}.txt`);
  writeFileSync(probe, `const fs = require('fs');
const client = process.argv[2];
process.argv.splice(2, 1);
setTimeout(() => fs.writeFileSync(${JSON.stringify(probeOut)}, String(process.env.PYIDE_BORE_SECRET)), 400);
require(client);
`);
  return withHost(client, async ({ host, port }) => {
    const bad = await raw(port);
    bad.socket.write(crypto.randomBytes(64));
    await bad.take(64);
    bad.socket.write(crypto.randomBytes(32));
    await bad.closes(8000);
    const f = await friend(client, port);
    await f.send('hello');
    await until(() => existsSync(probeOut), 'the probe', 5000);
    const line = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${host.child.pid}").CommandLine`], { encoding: 'utf8' });
    const forms = [SECRET.toString('base64url'), SECRET.toString('base64'), SECRET.toString('hex')];
    const everywhere = `${line}\n${host.out}\n${host.err}`;
    const env = readFileSync(probeOut, 'utf8');
    return { ok: !forms.some((s) => everywhere.includes(s)) && env === 'undefined' && /app|electron/i.test(line),
      why: `the key is ${forms.some((s) => everywhere.includes(s)) ? 'in' : 'not in'} argv or the output (${line.length} characters of command line read), and the process environment holds ${env === 'undefined' ? 'no key' : 'the key'} after start` };
  }, { prefix: [probe] });
}
attack('the key left in the environment', [['bore-client.js', 'delete process.env.PYIDE_BORE_SECRET;', '']], secretLeaks);
attack('the key in the output', [['bore-client.js', '  followParent();\n', "  followParent();\n  if (secret) console.error(secret.toString('base64url'));\n"]], secretLeaks);
attack('the key on the command line', [['minecraft/private-join.js', "'--listen', `127.0.0.1:${port}`]", "'--listen', `127.0.0.1:${port}`, '--key', key]"]], async (client) => {
  const { createPrivateJoin } = require(path.join(path.dirname(client), 'minecraft', 'private-join.js'));
  const joins = createPrivateJoin({ argv: () => [electron, client] });
  const address = `127.0.0.1:${crypto.randomInt(20000, 60000)}`;
  const key = SECRET.toString('base64url');
  await joins.start({ address, key, port: 0 });
  const line = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--to ${address}*' -and $_.Name -eq 'electron.exe' }).CommandLine`], { encoding: 'utf8' });
  await joins.stopAll();
  return { ok: line.includes(address) && !line.includes(key), why: `the join process's command line ${line.includes(key) ? 'holds' : 'does not hold'} the key (${line.length} characters read)` };
});
// Two starts of one server at once (the card's Play and a code pasted again): the process nobody tracks would keep the key
// and the port after stopAll.
attack('two joins of one server at once', [['minecraft/private-join.js', 'const job = (pending.get(id) || Promise.resolve()).catch(() => {}).then(() => begin(options));', 'const job = begin(options);']], async (client) => {
  const { createPrivateJoin } = require(path.join(path.dirname(client), 'minecraft', 'private-join.js'));
  const pids = path.join(work, `pids-${crypto.randomBytes(4).toString('hex')}.txt`);
  const recorder = path.join(work, `${path.basename(pids, '.txt')}.cjs`);
  writeFileSync(recorder, `require('fs').appendFileSync(${S(pids)}, process.pid + '\\n');\nconst client = process.argv[2];\nprocess.argv.splice(2, 1);\nrequire(client);\n`);
  writeFileSync(pids, '');
  const joins = createPrivateJoin({ argv: () => [electron, recorder, client] });
  const address = `127.0.0.1:${crypto.randomInt(20000, 60000)}`;
  const key = SECRET.toString('base64url');
  const ports = await Promise.all([joins.start({ address, key, port: 0 }), joins.start({ address, key, port: 0 })]);
  await joins.stopAll();
  const started = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
  const alive = started.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (const pid of alive) { try { process.kill(pid); } catch {} }
  return { ok: started.length === 1 && !alive.length && ports[0] === ports[1],
    why: `${started.length} join processes started for one server (ports ${ports.join(', ')}), ${alive.length} still running after stopAll` };
});
// A public share: bore resetting a player's connection while the local server is still being reached ends that
// connection, not the client and every other player's with it.
const slowLocal = path.join(work, 'slow-local.cjs');
writeFileSync(slowLocal, `const net = require('net');
const connect = net.connect;
const slow = Number(process.env.SLOW_PORT);
net.connect = (options, ...more) => {
  if (options?.port !== slow) return connect(options, ...more);
  const socket = new net.Socket();
  setTimeout(() => socket.connect(options), 1500);
  return socket;
};
const client = process.argv[2];
process.argv.splice(2, 1);
require(client);
`);
attack('a reset while the server is reached', [['bore-client.js', "    remote.on('error', () => {});\n", '']], async (client) => {
  const game = gameServer();
  const gamePort = await listen(game.server);
  const bore = standInBore();
  const controlPort = await listen(bore.server);
  const host = runClient(client, ['local', String(gamePort), '--local-host', '127.0.0.1', '--to', '127.0.0.1'],
    { secret: null, prefix: [slowLocal], env: { PYIDE_BORE_CONTROL_PORT: String(controlPort), SLOW_PORT: String(gamePort) } });
  try {
    await until(() => /listening at/.test(host.out) || host.code !== undefined, 'the host', 15000);
    bore.seen.control.write(frame({ Connection: 'one' }));
    (await until(() => bore.seen.accepted.get('one'), 'the first Accept')).resetAndDestroy();
    await outcome(() => host.code !== undefined || game.connections, 5000);
    await sleep(300);
    if (host.code === undefined) bore.seen.control.write(frame({ Connection: 'two' }));
    await outcome(() => host.code !== undefined || bore.seen.accepted.has('two'), 5000);
    const alive = host.code === undefined;
    return { ok: alive && bore.seen.accepted.has('two'),
      why: alive ? `the client lived on${bore.seen.accepted.has('two') ? ' and took the next connection' : ', but took no next connection'}` : `the client stopped with code ${host.code}: ${/Error: [^\r\n]*/.exec(host.err)?.[0] ?? host.err.trim()}` };
  } finally {
    host.child.kill();
    bore.server.close();
    for (const c of game.open) c.destroy();
    game.server.close();
  }
});

// ---------- what a friend gets ----------
const KAT_SCRIPT = path.join(work, 'kat.cjs');
writeFileSync(KAT_SCRIPT, `const crypto = require('crypto');
const { subtle } = crypto.webcrypto;
const gate = require(${JSON.stringify(path.join(app, 'main', 'bore-gate.js'))});
process.removeAllListeners('warning');
const hex = (s) => Buffer.from(s, 'hex');
const scalar = (s) => ({ privateKey: crypto.createPrivateKey({ key: Buffer.concat([hex('302e020100300506032b656e04220420'), hex(s)]), format: 'der', type: 'pkcs8' }) });
(async () => {
  const key = await subtle.importKey('raw-secret', Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i)), 'ChaCha20-Poly1305', false, ['encrypt']);
  const text = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  const out = Buffer.from(await subtle.encrypt({ name: 'ChaCha20-Poly1305', iv: hex('070000004041424344454647'), additionalData: hex('50515253c0c1c2c3c4c5c6c7') }, key, Buffer.from(text)));
  const alice = gate.agree(scalar('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'), hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'));
  const bob = gate.agree(scalar('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'), hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'));
  const [one, two] = [gate.ephemeral(), gate.ephemeral()];
  console.log(JSON.stringify({ electron: process.versions.electron, ssl: process.versions.openssl, start: out.subarray(0, 8).toString('hex'), tag: out.subarray(-16).toString('hex'), length: out.length,
    alice: alice.toString('hex'), bob: bob.toString('hex'), agreed: gate.agree(one, two.raw).equals(gate.agree(two, one.raw)), fresh: !one.raw.equals(two.raw), rawSize: one.raw.length }));
})();
`);

async function basics() {
  const unpacked = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')).build.asarUnpack;
  const needs = [...readFileSync(realClient, 'utf8').matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => `main/${m[1]}.js`);
  check(unpacked.includes('main/bore-client.js') && needs.length > 0 && needs.every((f) => unpacked.includes(f)), `every file bore-client.js requires is unpacked with it, where it runs from in a packaged app (${needs.join(', ')})`);
  const kat = JSON.parse(execFileSync(electron, [KAT_SCRIPT], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true }));
  check(!!kat.electron && kat.start === 'd31a8d34648e60db' && kat.tag === '1ae10b594f09e26a7e902ecbd0600691' && kat.length === 130,
    `under Electron ${kat.electron}, the cipher this code reaches gives RFC 8439's vector for ChaCha20-Poly1305 (tag ${kat.tag})`);
  const RFC7748 = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
  check(kat.ssl !== process.versions.openssl && kat.alice === RFC7748 && kat.bob === RFC7748, `under Electron's BoringSSL (OpenSSL version ${kat.ssl}, this Node ${process.versions.openssl}), bore-gate.js's agree gives RFC 7748's vector from both sides (${kat.alice})`);
  check(kat.agreed && kat.fresh && kat.rawSize === 32, 'its ephemeral pairs agree with each other, as 32 raw bytes, and no two are the same');
  const selfCheck = gateBeside(weakCopy('the check of its own', [['bore-gate.js', '  const shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey });', '  let shared;\n  try { shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey }); } catch { shared = Buffer.alloc(32); }']]));
  const allZero = (() => { try { return selfCheck.agree(selfCheck.ephemeral(), Buffer.alloc(32)).toString('hex'); } catch (err) { return err.message; } })();
  check(/low-order/.test(allZero), `an all-zero result is refused by the gate itself, not only by the library that happens to throw today (${allZero})`);
  check(!crypto.getCiphers().includes('nothing') && await new Promise((resolve) => {
    const child = spawn(electron, ['-e', "try { require('crypto').createCipheriv('chacha20-poly1305', Buffer.alloc(32), Buffer.alloc(12)); console.log('there'); } catch (e) { console.log(e.code); }"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(/ERR_CRYPTO_UNKNOWN_CIPHER/.test(out)));
  }), 'createCipheriv still has no chacha20-poly1305 under Electron: the day it does, bore-gate.js can leave WebCrypto');

  await withHost(realClient, async ({ game, port }) => {
    const s = await raw(port);
    const me = referenceHello();
    s.socket.write(me.hello);
    const reply = await s.take(64);
    const transcript = Buffer.concat([me.hello, reply]);
    s.socket.write(hmac(SECRET, 'nano1-client', transcript));
    const answer = (await s.take(96)).subarray(64);
    check(answer.equals(hmac(SECRET, 'nano1-host', transcript)), 'the handshake is the design\'s, as a client written from it with OpenSSL sees: cn, ce, then sn, se, then proofs over cn || ce || sn || se');
    const keys = referenceKeys(referenceShared(me.pair, reply.subarray(32)), SECRET, reply.subarray(0, 32), me.cn);
    s.socket.write(Buffer.concat([referenceRecord(keys.client, 0, Buffer.from('from openssl ')), referenceRecord(keys.client, 1, Buffer.from('records'))]));
    await until(() => game.bytes().toString() === 'from openssl records' || game.bytes().length > 20, 'records sealed by OpenSSL to arrive');
    check(game.bytes().toString() === 'from openssl records', 'keys from X25519 and HKDF over dh || secret with salt sn || cn, and records sealed by OpenSSL\'s own cipher (length as associated data, IV base XOR counter), open in the Electron process');
    await until(() => s.bytes().length > 96 + 2, 'a record from the host');
    check(referenceOpen(keys.host, 0, s.bytes().subarray(96)).toString() === 'MINECRAFT-SERVER-BYTES', 'a record sealed in the Electron process opens with OpenSSL\'s cipher, a 2-byte length, ciphertext and 16-byte tag');
    s.socket.end(referenceRecord(keys.client, 2, Buffer.alloc(0)));
    await until(() => s.closed, 'the host to finish after the last record', 8000);
    await until(() => !game.open.size, 'the server to leave');
    const records = [];
    for (let at = 96; at < s.bytes().length;) {
      const next = at + 2 + s.bytes().readUInt16BE(at) + 16;
      records.push(s.bytes().subarray(at, next));
      at = next;
    }
    const last = records.at(-1);
    check(last.length === 18 && last.readUInt16BE(0) === 0 && referenceOpen(keys.host, records.length - 1, last).length === 0 && game.bytes().toString() === 'from openssl records',
      `an empty record written with OpenSSL ends the connection cleanly, and the host ends with one of its own (${records.length} records, the last ${last.length} bytes)`);
    s.socket.destroy();
  });

  await withHost(realClient, async ({ game, bore, host, port }) => {
    const join = runClient(realClient, ['join', '--to', `127.0.0.1:${port}`, '--listen', '127.0.0.1:0']);
    const m = await until(() => /listening at 127\.0\.0\.1:(\d+)/.exec(join.out), 'join to listen', 15000);
    const local = Number(m[1]);
    check(true, `join prints its address on loopback (127.0.0.1:${local})`);
    const seenOnWire = [];
    bore.tap = (direction, chunk) => { seenOnWire.push(chunk); return chunk; };
    const a = await raw(local);
    await a.take(22);
    check(a.bytes().toString() === 'MINECRAFT-SERVER-BYTES', 'the game hears the server through both Craft processes and bore');
    const sizes = [1, 16384, 16385, 100000];
    for (const size of sizes) {
      const data = crypto.randomBytes(size);
      const before = a.bytes().length;
      a.socket.write(data);
      await until(() => a.bytes().length >= before + 5 + size, `${size} bytes to echo`, 10000);
      if (!a.bytes().subarray(before).equals(Buffer.concat([Buffer.from('echo:'), data])) && size < 16384) check(false, `${size} bytes changed on the way`);
    }
    check(true, `bytes pass both ways at record boundaries and past them (${sizes.join(', ')})`);
    bore.tap = null;
    const everything = Buffer.concat(seenOnWire);
    check(!everything.includes('MINECRAFT') && !everything.includes('echo:'), `bore sees none of the plaintext in ${everything.length} bytes`);
    a.socket.destroy();
    await until(() => !game.open.size, 'the player to leave');
    await sleep(200);
    check(host.code === undefined && join.code === undefined, 'a player leaving ends neither the tunnel nor the join process');
    const b = await raw(local);
    await b.take(22);
    check(game.connections === 2, 'the next connection works');
    [...game.open][0].destroy();
    check(await b.closes(8000), 'the server going away closes the game\'s connection');
    check(host.code === undefined, '... and not the tunnel');
    join.child.kill();
  });

  const refused = await withHost(realClient, async ({ game, host, port }) => {
    game.server.close();
    await sleep(100);
    const f = await friend(realClient, port);
    const closed = await until(() => f.closed, 'the host to close', 8000).then(() => true, () => false);
    return { closed, alive: host.code === undefined, err: host.err };
  });
  check(refused.closed && refused.alive && /connection exited with error/.test(refused.err), 'a local server that refuses ends that connection, not the tunnel');

  const short = runClient(realClient, ['local', '1', '--to', '127.0.0.1'], { secret: Buffer.alloc(16) });
  await until(() => short.code !== undefined, 'a short key to be refused', 10000);
  check(short.code === 1 && /the key is not valid/.test(short.err) && !short.err.includes(Buffer.alloc(16).toString('base64url')), `a key of the wrong size stops the client without printing it (${short.err.trim()})`);
  const nokey = runClient(realClient, ['join', '--to', '127.0.0.1:1', '--listen', '127.0.0.1:0'], { secret: null });
  await until(() => nokey.code !== undefined, 'join without a key to be refused', 10000);
  check(nokey.code === 1 && /usage/.test(nokey.err), 'join without a key refuses to start');
  const everyone = runClient(realClient, ['join', '--to', '127.0.0.1:1', '--listen', '0.0.0.0:0']);
  await until(() => everyone.code !== undefined, 'a listener off loopback to be refused', 10000);
  check(everyone.code === 1, 'join binds loopback only: any other address is refused');
  const quiet = new net.Server();
  const quietPort = await listen(quiet);
  const taken = runClient(realClient, ['join', '--to', '127.0.0.1:1', '--listen', `127.0.0.1:${quietPort}`]);
  await until(() => taken.code !== undefined, 'a taken port to be reported', 10000);
  quiet.close();
  check(taken.code === 1 && /the port is taken/.test(taken.err), `a taken port is said in words private-join can read (${taken.err.trim()})`);

  const parent = path.join(work, 'parent.cjs');
  const pidFile = path.join(work, 'child.pid');
  writeFileSync(parent, `const { spawn } = require('child_process');
const child = spawn(process.execPath, ${JSON.stringify([realClient, 'join', '--to', '127.0.0.1:1', '--listen', '127.0.0.1:0'])}, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
child.stdout.once('data', () => { require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); });
setInterval(() => {}, 1000);
`);
  const app2 = runClient(parent, []);
  await until(() => existsSync(pidFile), 'the join process under a stand-in app', 15000);
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  app2.child.kill();
  const alive = () => { try { process.kill(childPid, 0); return true; } catch { return false; } };
  const gone = await until(() => !alive(), 'the orphan to go', 30000).then(() => true, () => false);
  if (alive()) process.kill(childPid);
  check(gone, 'a process holding the key goes with the app that started it, even when the app is killed');

  // A public share holds no key, but it relays anyone to the server: it goes with the app too.
  const relay = net.createServer((c) => { c.on('error', () => {}); c.write('{"Hello":40999}\0'); });
  const relayPort = await listen(relay);
  const publicParent = path.join(work, 'public-parent.cjs');
  const publicPid = path.join(work, 'public-child.pid');
  writeFileSync(publicParent, `const { spawn } = require('child_process');
const child = spawn(process.execPath, ${JSON.stringify([realClient, 'local', '25565', '--local-host', '127.0.0.1', '--to', '127.0.0.1'])}, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, PYIDE_BORE_CONTROL_PORT: ${JSON.stringify(String(relayPort))} } });
child.stdout.once('data', () => { require('fs').writeFileSync(${JSON.stringify(publicPid)}, String(child.pid)); });
setInterval(() => {}, 1000);
`);
  const app3 = runClient(publicParent, [], { secret: null });
  await until(() => existsSync(publicPid), 'the public share under a stand-in app', 15000);
  const publicChild = Number(readFileSync(publicPid, 'utf8'));
  app3.child.kill();
  const publicAlive = () => { try { process.kill(publicChild, 0); return true; } catch { return false; } };
  const publicGone = await until(() => !publicAlive(), 'the public orphan to go', 30000).then(() => true, () => false);
  if (publicAlive()) process.kill(publicChild);
  relay.close();
  check(publicGone, 'a public share\'s bore client goes with the app that started it, even when the app is killed');
}

// ---------- servers.dat ----------
const B = (...n) => Buffer.from(n);
const u16 = (n) => B(n >> 8, n & 255);
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const named = (type, name, ...body) => Buffer.concat([B(type), u16(name.length), Buffer.from(name), ...body]);
const nbtString = (name, bytes) => named(8, name, u16(bytes.length), bytes);
const nbtText = (name, text) => nbtString(name, Buffer.from(text));
const floatBytes = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const doubleBytes = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const EMOJI = B(0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80); // U+1F600 as the game writes it, each surrogate on its own
const NUL = B(0xc0, 0x80);
const ALL_TAGS = Buffer.concat([
  nbtText('ip', 'play.example.test:25570'),
  nbtString('name', Buffer.concat([Buffer.from('친구'), EMOJI, NUL])),
  nbtText('icon', 'iVBORw0KGgo='),
  named(1, 'acceptTextures', B(1)),
  named(1, 'hidden', B(0)),
  named(2, 'aShort', B(0xff, 0xfe)),
  named(3, 'anInt', i32(-7)),
  named(4, 'aLong', B(0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfd)),
  named(5, 'aFloat', floatBytes(1.5)),
  named(6, 'aDouble', doubleBytes(0.1)),
  named(7, 'bytes', i32(3), B(1, 0xff, 3)),
  named(11, 'ints', i32(2), i32(1), i32(-1)),
  named(12, 'longs', i32(1), B(0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfd)),
  named(9, 'names', B(8), i32(2), u16(1), Buffer.from('a'), u16(1), Buffer.from('b')),
  named(9, 'nested', B(9), i32(1), B(3), i32(1), i32(5)),
  named(9, 'emptyList', B(0), i32(0)),
  named(10, 'fromANewerGame', named(3, 'x', i32(1)), B(0)),
  B(0),
]);
const HIDDEN = Buffer.concat([nbtText('ip', 'quick.example.test:25571'), nbtText('name', 'Minecraft Server'), named(1, 'hidden', B(1)), B(0)]);
const datFile = (entries) => Buffer.concat([B(10, 0, 0), named(9, 'servers', B(10), i32(entries.length), ...entries), named(3, 'unknownTop', i32(9)), B(0)]);
const listIn = (dir) => parseNbt(readFileSync(path.join(dir, 'servers.dat'))).servers;

function serversDat() {
  const fixture = datFile([ALL_TAGS, HIDDEN]);
  check(writeNbt(parseNbt(fixture, { tagged: true })).equals(fixture), `a fixture written by the format comes back byte for byte (${fixture.length} bytes, every tag type, modified UTF-8)`);
  const dir = mkdtempSync(path.join(work, 'dat-'));
  const file = path.join(dir, 'servers.dat');
  writeFileSync(file, fixture);
  const added = mergeServers(dir, [{ ip: '127.0.0.1:50001', name: '친구 서버 😀' }]);
  const after = readFileSync(file);
  check(added.written && after.includes(ALL_TAGS) && after.includes(named(3, 'unknownTop', i32(9))) && after[0] === 10,
    'merging keeps every other entry and every unknown tag byte for byte, in an uncompressed file');
  const list = listIn(dir);
  check(list.length === 3 && list[2].ip === '127.0.0.1:50001' && list[2].name === '친구 서버 😀' && after.includes(EMOJI),
    `a new entry goes last, its name in the game's modified UTF-8 (${JSON.stringify(list[2])})`);
  const stamp = statSync(file).mtimeMs;
  const again = mergeServers(dir, [{ ip: '127.0.0.1:50001', name: 'a different name' }]);
  check(!again.written && statSync(file).mtimeMs === stamp && listIn(dir)[2].name === '친구 서버 😀', 'the same address changes nothing and the file is not touched: a name the user chose stays');
  const moved = mergeServers(dir, [{ ip: '127.0.0.1:50002', name: 'x', was: '127.0.0.1:50001' }]);
  check(moved.written && listIn(dir).length === 3 && listIn(dir)[2].ip === '127.0.0.1:50002' && listIn(dir)[2].name === '친구 서버 😀', 'a moved port replaces its old entry in place, name kept');
  check(mergeServers(dir, [{ ip: 'quick.example.test:25571', name: 'x' }]).written && !parseNbt(readFileSync(file)).servers[1].hidden, 'a server the game hid after Quick Play shows in the list');
  const taken = mergeServers(dir, [{ ip: 'play.example.test:25570', name: 'x', was: '127.0.0.1:50002' }]);
  check(taken.written && listIn(dir).length === 2, 'moving onto an address already listed leaves one entry');

  const fresh = mkdtempSync(path.join(work, 'dat-'));
  check(mergeServers(fresh, [{ ip: 'a.test', name: 'A' }]).written && listIn(fresh)[0].ip === 'a.test', 'a missing file is made');
  check(!readdirSync(fresh).some((n) => n !== 'servers.dat'), 'nothing but the file is left behind');
  const failing = mkdtempSync(path.join(work, 'dat-'));
  writeFileSync(path.join(failing, 'servers.dat'), fixture);
  const refused = (() => { try { return mergeServers(failing, [{ ip: 'b.test', name: 'B' }], { rename: () => { throw new Error('locked'); } }); } catch (err) { return err.message; } })();
  check(refused === 'locked' && readFileSync(path.join(failing, 'servers.dat')).equals(fixture) && readdirSync(failing).length === 1, 'a failed write leaves the old file whole and no temporary file: the write is atomic');

  for (const [what, bytes] of [['cut short', fixture.subarray(0, fixture.length - 9)], ['not NBT', Buffer.from('not a server list')], ['gzip, which the game does not read here', gzipSync(fixture)],
    ['servers that are not a list', Buffer.concat([B(10, 0, 0), nbtText('servers', 'x'), B(0)])], ['a list of numbers', Buffer.concat([B(10, 0, 0), named(9, 'servers', B(3), i32(1), i32(1)), B(0)])], ['empty', Buffer.alloc(0)]]) {
    const hurt = mkdtempSync(path.join(work, 'dat-'));
    const p = path.join(hurt, 'servers.dat');
    writeFileSync(p, bytes);
    const first = mergeServers(hurt, [{ ip: 'c.test', name: 'C' }]);
    const second = mergeServers(hurt, [{ ip: 'c.test', name: 'C' }]);
    const copies = readdirSync(hurt).filter((n) => n.startsWith('servers.dat.damaged-'));
    check(first.damaged && second.damaged && !first.written && readFileSync(p).equals(bytes) && copies.length === 1 && readFileSync(path.join(hurt, copies[0])).equals(bytes),
      `a damaged file (${what}) is left alone, with one copy beside it however often it is met`);
  }
  check(!existsSync(`${file}.nano-tmp`), 'no temporary file stays');
}

// ---------- join codes ----------
function joinCodes() {
  const key = SECRET.toString('base64url');
  const code = L.joinCode({ address: 'bore.pub:33862', key, name: '친구 서버', pack: 'https://example.com/a.mrpack' });
  const read = L.parseJoinCode(`친구가 보낸 코드예요: ${code} 입니다.`);
  check(read.key === key && read.address === 'bore.pub:33862' && read.name === '친구 서버' && read.pack === 'https://example.com/a.mrpack', 'a private join code carries key= and reads back from pasted text');
  check(L.parseJoinCode(L.joinCode({ address: 'bore.pub:33862', name: 'x' })).key === null, 'a code without key is an ordinary code');
  check(L.joinCode({ address: 'mc.example.test:25580', pack: 'https://example.com/a.mrpack', name: 'Test' }) === 'nanostudio:join?addr=mc.example.test:25580&pack=https%3A%2F%2Fexample%2Ecom%2Fa%2Emrpack&name=Test',
    'a public code is spelled exactly as before');
  check(L.parseJoinCode('nanostudio:join?addr=old.example.test:25565&name=old').name === 'old', 'an existing code still works');
  const bad = [['too short', 'AAAA'], ['empty', ''], ['too long', Buffer.alloc(33).toString('base64url')], ['with padding', `${key}=`], ['in plain base64', Buffer.alloc(32, 0xfb).toString('base64')], ['with a stray character', `${key.slice(0, -1)}!`]];
  for (const [what, value] of bad) {
    const said = (() => { try { L.parseJoinCode(`nanostudio:join?addr=a.test:1&key=${value}`); return 'accepted'; } catch (err) { return err.message; } })();
    check(/damaged key/.test(said) && (!value || !said.includes(value)), `a bad key (${what}) refuses the code, never falling back to a public server (${said})`);
  }
  const typed = (() => { try { L.parseAddress(`nanostudio://oops ${code}`); return 'accepted'; } catch (err) { return err.message; } })();
  check(/not a server address/.test(typed) && !typed.includes(key), `a code mistaken for an address is refused without printing it (${typed})`);
}

// ---------- the friend's side ----------
const startsLog = path.join(work, 'starts.jsonl');
const standInLauncher = path.join(work, 'stand-in-launcher.cjs');
writeFileSync(standInLauncher, `require('fs').appendFileSync(${JSON.stringify(startsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
// By game folder: a launcher started for one test can arrive late, in the middle of the next.
const starts = (root) => (existsSync(startsLog) ? readFileSync(startsLog, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).some((arg) => arg.startsWith(root))).length : 0);
const never = () => { throw new Error('nothing is downloaded in this suite'); };
const REVERSED = { seal: (key) => ({ enc: 'safeStorage', data: Buffer.from(key).reverse().toString('base64') }), open: (s) => Buffer.from(s.data, 'base64').reverse().toString() };
// These tests' servers are on loopback, which a code may name only after a yes.
const HERE = ['localAddress'];

function makeCraft(keyring) {
  const joins = createPrivateJoin({ argv: () => [electron, realClient] });
  return { joins, craft: L.createLauncher({ fetchFile: never, ensureJava: never, javaFor: never, run: never, retried: never, keyring, joins }) };
}
const reaches = async (address) => {
  const [host, port] = address.split(':');
  const s = await new Promise((resolve) => {
    const c = net.connect({ host, port: Number(port) });
    const got = [];
    c.on('data', (d) => got.push(d));
    c.on('error', () => resolve({ c, got }));
    c.once('connect', () => resolve({ c, got }));
  });
  await until(() => Buffer.concat(s.got).length >= 22, `the server through ${address}`, 8000).catch(() => {});
  s.c.destroy();
  return Buffer.concat(s.got).toString().startsWith('MINECRAFT-SERVER-BYTES');
};

async function friendSide() {
  process.env.PYIDE_MC_LAUNCHER = JSON.stringify([process.execPath, standInLauncher]);
  const key = SECRET.toString('base64url');
  await withHost(realClient, async ({ game, port }) => {
    const address = `127.0.0.1:${port}`;
    const root = mkdtempSync(path.join(work, 'friend-'));
    const lines = [];
    const log = Object.assign((text) => lines.push(text), {});
    const { craft, joins } = makeCraft(REVERSED);
    const code = L.joinCode({ address, key, name: '친구 서버' });
    const listFile = path.join(root, 'servers-list.json');
    const asked = await craft.join(root, { code, confirmed: HERE }, log);
    check(asked.needsVersion && asked.server.private && !existsSync(listFile), 'a private server without a pack asks for the version, and nothing is saved before it');
    const joined = await craft.join(root, { code, mc: '1.20.1', loader: 'vanilla', confirmed: HERE }, log);
    const onDisk = readFileSync(listFile, 'utf8');
    const saved = JSON.parse(onDisk)[0];
    check(!onDisk.includes(key) && saved.secret?.enc === 'safeStorage' && saved.private === true && Number.isInteger(saved.localPort), `the key goes to safeStorage and never into servers-list.json in the clear (${Object.keys(saved).join(', ')})`);
    check(joined.server.private && joined.server.keyMissing === false && !('secret' in joined.server) && !('secret' in (await craft.servers(root))[0]), 'the window is told a server is private, and gets no sealed key');
    check(joined.instance.name && S(listIn(joined.instance.dir)) === S([{ ip: `127.0.0.1:${saved.localPort}`, name: '친구 서버' }]), `servers.dat is written at create and join, with the local address and not the public one (${S(listIn(joined.instance.dir))})`);
    const inst = joined.instance.name;
    const versionFile = path.join(root, '.launcher', 'versions', `nano-${inst}`, `nano-${inst}.json`);
    const version = () => JSON.parse(readFileSync(versionFile, 'utf8'));
    const before = starts(root);
    const played = await craft.play(root, inst, { server: { address, name: '친구 서버' } }, log);
    const atLocal = `127.0.0.1:${saved.localPort}`;
    await until(() => starts(root) === before + 1, 'the stand-in launcher');
    check(played.launched && played.private && S(version().arguments?.game) === S(['--quickPlayMultiplayer', atLocal]), `Join starts the join process first and Quick Play goes to it (${S(version().arguments)})`);
    check(await reaches(atLocal) && game.connections === 1, 'the game\'s local address reaches the server through the join process and the tunnel');
    await joins.stopAll();
    await craft.play(root, inst, { server: address }, log);
    check(JSON.parse(readFileSync(listFile, 'utf8'))[0].localPort === saved.localPort && S(version().arguments.game) === S(['--quickPlayMultiplayer', atLocal]), 'the local port stays the same for a server when it is free');
    await joins.stopAll();

    const squatter = net.createServer();
    await new Promise((resolve) => { squatter.listen(saved.localPort, '127.0.0.1', resolve); });
    await craft.play(root, inst, { server: address }, log);
    squatter.close();
    const nextPort = JSON.parse(readFileSync(listFile, 'utf8'))[0].localPort;
    const nextLocal = `127.0.0.1:${nextPort}`;
    check(nextPort !== saved.localPort && S(listIn(joined.instance.dir)) === S([{ ip: nextLocal, name: '친구 서버' }]) && S(version().arguments.game) === S(['--quickPlayMultiplayer', nextLocal]),
      `a port taken by something else gets a new one, saved, and servers.dat is rewritten before the launcher opens (${saved.localPort} -> ${nextPort})`);
    check(await reaches(nextLocal), 'the new port reaches the server');
    await joins.stopAll();

    const menu = await craft.play(root, inst, {}, log);
    check(menu.private && !version().arguments && await reaches(nextLocal), 'instance Play opens the main menu with no Quick Play, and its private server\'s join process runs for the list');
    await joins.stopAll();

    const restarted = makeCraft(REVERSED);
    check((await restarted.craft.servers(root))[0].keyMissing === false, 'after a restart the key comes back through safeStorage');
    await restarted.craft.play(root, inst, { server: address }, log);
    check(restarted.joins.running().length === 1 && await reaches(nextLocal), '... and Join works without the code');
    const noPrivate = restarted.craft.saveServers(root, await restarted.craft.servers(root));
    check(JSON.parse(readFileSync(listFile, 'utf8'))[0].secret?.enc === 'safeStorage' && noPrivate[0].private, 'the window giving the list back keeps the sealed key on disk');
    restarted.craft.saveServers(root, []);
    check(!restarted.joins.running().length && !existsSync(listFile) === false && JSON.parse(readFileSync(listFile, 'utf8')).length === 0, 'removing a server stops its join process');

    const output = lines.join('');
    check(!output.includes(key), `the job log never holds the key (${output.length} characters read)`);

    const bare = mkdtempSync(path.join(work, 'friend-'));
    const firstRun = makeCraft(undefined);
    const noStore = await firstRun.craft.join(bare, { code, mc: '1.20.1', loader: 'vanilla', confirmed: HERE }, log);
    const bareList = readFileSync(path.join(bare, 'servers-list.json'), 'utf8');
    check(!bareList.includes(key) && JSON.parse(bareList)[0].secret === null && JSON.parse(bareList)[0].private === true && noStore.server.keyMissing === false, 'without safeStorage the key stays in memory and out of the file');
    const startsBare = starts(bare);
    const memory = await firstRun.craft.play(bare, noStore.instance.name, { server: address }, log);
    check(memory.launched === true && memory.private, '... and works for this session');
    await until(() => starts(bare) === startsBare + 1, 'the stand-in launcher');
    await firstRun.joins.stopAll();
    const nextRun = makeCraft(undefined);
    const lost = await nextRun.craft.play(bare, noStore.instance.name, { server: address }, log);
    await sleep(200);
    check(lost.launched === false && lost.code === 'needsCode' && (await nextRun.craft.servers(bare))[0].keyMissing === true && starts(bare) === startsBare + 1, 'next time the friend is asked for the code again, and no launcher starts');

    const pasted = await nextRun.craft.join(bare, { code }, log);
    check(!pasted.needsConfirm && pasted.server.private && pasted.server.keyMissing === false, 'pasting the code again brings a keyless server back without a question: there is no key left to replace');
    await nextRun.joins.stopAll();
    const publicAgain = await nextRun.craft.join(bare, { code: L.joinCode({ address, name: '친구 서버' }), confirmed: ['noKey'] }, log);
    check(!publicAgain.server.private && !('private' in JSON.parse(readFileSync(path.join(bare, 'servers-list.json'), 'utf8'))[0]), 'a code without a key makes the address a public server again, once the friend has said yes');

    const store = mkdtempSync(path.join(work, 'friend-'));
    const storeWork = path.join(work, 'store-work');
    mkdirSync(storeWork, { recursive: true });
    const kept = process.env.PYIDE_MC_LAUNCHER;
    process.env.PYIDE_MC_LAUNCHER = 'off';
    process.env.PYIDE_MC_STORE = S({ argv: [process.execPath, standInLauncher], work: storeWork });
    const onStore = makeCraft(REVERSED);
    const atStore = await onStore.craft.join(store, { code, mc: '1.20.1', loader: 'vanilla', confirmed: HERE }, log);
    await onStore.craft.play(store, atStore.instance.name, { server: address }, log);
    await onStore.joins.stopAll();
    delete process.env.PYIDE_MC_STORE;
    process.env.PYIDE_MC_LAUNCHER = kept;
    check(listIn(path.join(store, 'instances', atStore.instance.name))[0].ip.startsWith('127.0.0.1:') && !existsSync(path.join(storeWork, 'servers.dat')), 'with the Store launcher too the list goes into the instance\'s game folder, where its profile points, not .minecraft');
  });

  const statusServer = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => {
      const text = Buffer.from(S({ version: { name: '1.20.1', protocol: 763 }, forgeData: { fmlNetworkVersion: 3, mods: [], channels: [] }, players: { online: 2, max: 8 } }));
      const body = Buffer.concat([B(0), B((text.length & 0x7f) | 0x80, text.length >> 7), text]);
      c.end(Buffer.concat([B((body.length & 0x7f) | 0x80, body.length >> 7), body]));
    });
  });
  const statusPort = await listen(statusServer);
  const bore = standInBore({ relay: true });
  const controlPort = await listen(bore.server);
  const host = runClient(realClient, ['local', String(statusPort), '--local-host', '127.0.0.1', '--to', '127.0.0.1'], { env: { PYIDE_BORE_CONTROL_PORT: String(controlPort) } });
  await until(() => /listening at/.test(host.out), 'the host', 15000);
  const { craft, joins } = makeCraft(REVERSED);
  const pinged = await craft.ping(L.joinCode({ address: `127.0.0.1:${bore.publicPort}`, key, name: 'x' }));
  check(pinged.online && pinged.mc === '1.20.1' && pinged.loader === 'forge' && !joins.running().length, `Add Server's version question reaches a private server through a join process that goes again after (${S(pinged)})`);
  host.child.kill();
  bore.close();
  bore.server.close();
  statusServer.close();
}

// ---------- what a pasted code may do ----------
const CODE_ATTACKS = [];
const codeAttack = (name, patches, run) => CODE_ATTACKS.push({ name, patches, run });
const ASKS_FIRST = [["if (ask) return { needsConfirm: { kind: ask, address: target.address, name: known?.name || target.name } };", '']];
const FRIEND_AT = 'friend.example.test:25565';
const THE_KEY = SECRET.toString('base64url');
const PACK = 'https://packs.example.test/a.mrpack';

// A friend's saved private server, with a join process that only records what it was asked to reach.
async function savedPrivate(Launcher, fetchFile = never) {
  const root = mkdtempSync(path.join(work, 'code-'));
  const reached = [];
  const joins = { start: async ({ address, port }) => { reached.push(address); return port || 40000; }, stop: () => {}, stopAll: () => {}, running: () => [] };
  const craft = Launcher.createLauncher({ fetchFile: (...args) => fetchFile(...args), ensureJava: never, javaFor: never, run: never, retried: never, keyring: REVERSED, joins });
  const made = await craft.join(root, { code: Launcher.joinCode({ address: FRIEND_AT, key: THE_KEY, name: '친구 서버' }), mc: '1.20.1', loader: 'vanilla' }, () => {});
  const file = path.join(root, 'servers-list.json');
  const entry = () => JSON.parse(readFileSync(file, 'utf8'))[0];
  return { root, craft, reached, file, entry, keyNow: () => REVERSED.open(entry().secret), instance: made.instance };
}

codeAttack('a pasted code with another key', ASKS_FIRST, async (Launcher) => {
  const { root, craft, keyNow } = await savedPrivate(Launcher);
  const other = crypto.randomBytes(32).toString('base64url');
  const code = Launcher.joinCode({ address: FRIEND_AT, key: other, name: 'x' });
  const first = await craft.join(root, { code }, () => {});
  const kept = keyNow() === THE_KEY;
  const same = await craft.join(root, { code: Launcher.joinCode({ address: FRIEND_AT, key: THE_KEY, name: 'x' }) }, () => {});
  await craft.join(root, { code, confirmed: ['newKey'] }, () => {});
  return { ok: first.needsConfirm?.kind === 'newKey' && kept && !same.needsConfirm && keyNow() === other,
    why: `the answer was ${S(first.needsConfirm ?? 'no question')}, the old key ${kept ? 'stayed' : 'was replaced'} until the yes, and the same key again asked ${same.needsConfirm ? 'something' : 'nothing'}` };
});

codeAttack('a pasted code with no key', ASKS_FIRST, async (Launcher) => {
  const { root, craft, entry, keyNow } = await savedPrivate(Launcher);
  const code = Launcher.joinCode({ address: FRIEND_AT, name: 'x' });
  const first = await craft.join(root, { code }, () => {});
  const kept = entry().private === true && keyNow() === THE_KEY;
  await craft.join(root, { code, confirmed: ['noKey'] }, () => {});
  return { ok: first.needsConfirm?.kind === 'noKey' && kept && !entry().private,
    why: `the answer was ${S(first.needsConfirm ?? 'no question')}, and the server ${kept ? 'stayed private' : 'lost its key'} until the yes` };
});

codeAttack('a code aiming at this computer', [["if (!known && await isLocalAddress(target.address)) asks.push('localAddress');", '']], async (Launcher) => {
  const root = mkdtempSync(path.join(work, 'code-'));
  const craft = Launcher.createLauncher({ fetchFile: never, ensureJava: never, javaFor: never, run: never, retried: never, keyring: REVERSED });
  const local = ['127.0.0.1:6379', 'localhost:5432', '192.168.0.1:80', '10.1.2.3:25565', '172.16.0.1:1', '[::1]:25565', '[fd00::1]:1', '2130706433:6379', '0x7f.1:6379', 'printer.local:9100'];
  const answers = [];
  for (const address of local) answers.push((await craft.join(root, { code: `nanostudio:join?addr=${address}` }, () => {})).needsConfirm?.kind);
  const typed = await craft.join(root, { address: '192.168.0.1:25565' }, () => {});
  const yes = await craft.join(root, { code: 'nanostudio:join?addr=192.168.0.1:25565', confirmed: ['localAddress'] }, () => {});
  const away = await craft.join(root, { code: 'nanostudio:join?addr=play.example.test:25565' }, () => {});
  const missed = local.filter((_, i) => answers[i] !== 'localAddress');
  return { ok: !missed.length && !existsSync(path.join(root, 'servers-list.json')) && typed.needsVersion && yes.needsVersion && away.needsVersion,
    why: `${local.length - missed.length} of ${local.length} local addresses asked first${missed.length ? ` (not ${missed.join(', ')})` : ''}, a typed one and an internet one went on to the version question` };
});

// A name is not an address: localtest.me is 127.0.0.1, and a name without a port is played where its SRV record points.
codeAttack('a code whose name leads to this computer', [['return (await resolvesLocal(name, { srv: !port })).local;', 'return false;']], async (Launcher) => {
  const root = mkdtempSync(path.join(work, 'code-'));
  const craft = Launcher.createLauncher({ fetchFile: never, ensureJava: never, javaFor: never, run: never, retried: never, keyring: REVERSED });
  const local = ['localtest.me:6379', 'lan.example.test:25565', 'link.example.test:1', 'mapped.example.test:80', 'mixed.example.test:25565', 'srv.example.test'];
  const away = ['play.example.test:25565', 'nowhere.example.test:25565', 'srv.example.test:25565'];
  const ask = async (address) => (await craft.join(root, { code: `nanostudio:join?addr=${address}` }, () => {})).needsConfirm?.kind ?? null;
  const asked = [];
  for (const address of local) asked.push(await ask(address));
  const passed = [];
  for (const address of away) passed.push(await ask(address));
  const missed = local.filter((_, i) => asked[i] !== 'localAddress');
  return { ok: !missed.length && passed.every((k) => k === null) && !existsSync(path.join(root, 'servers-list.json')),
    why: `${local.length - missed.length} of ${local.length} names that resolve to a local address (or an SRV record to one) asked first${missed.length ? ` (not ${missed.join(', ')})` : ''}; a public name, one not found and an SRV name given a port asked ${S(passed)}` };
});

// A pack's name that resolves to this computer, directly or on a redirect, is refused before anything is fetched from it.
const packJoin = async (Launcher, pack, fetchFile) => {
  const root = mkdtempSync(path.join(work, 'code-'));
  const craft = Launcher.createLauncher({ fetchFile, ensureJava: never, javaFor: never, run: never, retried: never, keyring: REVERSED });
  try { await craft.join(root, { code: Launcher.joinCode({ address: 'play.example.test:25565', pack, name: 'p' }) }, () => {}); return null; } catch (err) { return err; }
};
codeAttack('a pack whose name leads to this computer', [['    await vetPack(first);\n', '']], async (Launcher) => {
  const fetched = [];
  const take = async (url) => { fetched.push(url); throw new Error('the stand-in serves nothing'); };
  const loop = await packJoin(Launcher, 'https://packs.loop.test/a.mrpack', take);
  const lan = await packJoin(Launcher, 'https://inside.example.test/a.mrpack', take);
  const fine = await packJoin(Launcher, 'https://packs.example.test/a.mrpack', take);
  return { ok: [loop, lan].every((e) => /points at a private address/.test(e?.message || '')) && S(fetched) === S(['https://packs.example.test/a.mrpack']) && /serves nothing/.test(fine?.message || ''),
    why: `the loopback and LAN names ended with ${S([loop?.message, lan?.message])}, and what was fetched is ${S(fetched)}` };
});
codeAttack('a pack that redirects to a name of this computer', [['        await vetPack(next);\n', '']], async (Launcher) => {
  // The download's redirect check, as main/installer/servers.js calls it: a hop it refuses ends the download.
  const reached = [];
  const redirecting = (to) => async (url, dest, { allow }) => {
    if (!allow(to)) throw Object.assign(new Error(`Download refused: it redirects to ${new URL(to).host}`), { code: 'REDIRECT', expected: true });
    reached.push(to);
    throw new Error('the stand-in serves nothing');
  };
  const loop = await packJoin(Launcher, 'https://redirect.example.test/a.mrpack', redirecting('https://packs.loop.test/b.mrpack'));
  const fine = await packJoin(Launcher, 'https://redirect.example.test/a.mrpack', redirecting('https://packs.example.test/b.mrpack'));
  return { ok: /points at a private address/.test(loop?.message || '') && S(reached) === S(['https://packs.example.test/b.mrpack']),
    why: `a redirect to a loopback name ended with ${S(loop?.message)}, a public one with ${S(fine?.message)}, and the download reached ${S(reached)}` };
});

codeAttack('a private server removed during a long sync', [["if (srv?.private && !local.has(srv.address.toLowerCase())) return { launched: false, code: 'privateGone' };", '']], async (Launcher) => {
  let removal = () => {};
  const bench = await savedPrivate(Launcher, async () => { removal(); throw new Error('the tunnel is down'); });
  const { root, craft, reached, file, instance } = bench;
  writeFileSync(file, S([{ ...bench.entry(), pack: PACK }]));
  const instanceFile = path.join(instance.dir, 'nano-instance.json');
  writeFileSync(instanceFile, S({ ...JSON.parse(readFileSync(instanceFile, 'utf8')), pack: { url: PACK, sha1: 'a'.repeat(40), files: [] } }));
  removal = () => craft.saveServers(root, []);
  const started = starts(root);
  const played = await craft.play(root, instance.name, { server: FRIEND_AT }, () => {});
  await sleep(300);
  const versionFile = path.join(root, '.launcher', 'versions', `nano-${instance.name}`, `nano-${instance.name}.json`);
  const quickPlay = existsSync(versionFile) ? S(JSON.parse(readFileSync(versionFile, 'utf8')).arguments?.game) : 'none';
  return { ok: played.launched === false && played.code === 'privateGone' && starts(root) === started && !quickPlay.includes(FRIEND_AT) && !reached.length,
    why: `play answered ${S({ launched: played.launched, code: played.code })}, ${starts(root) - started} launcher started, and the game would join ${quickPlay}` };
});

// ---------- the launcher already open ----------
const CSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
// A real window. On a hidden desktop Windows puts an input overlay of its own into the process, above the form, and
// CloseMainWindow goes to whichever comes first: Process.MainWindowHandle takes the top window. So the form keeps raising
// itself. Fully transparent, so a run on the desktop in use (CI) shows nothing.
const WINDOW_APP = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
class Stand : Form {
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  static string record = "";
  static bool stay = false;
  static string profiles = null;
  static string held = null;
  int ticks = 0;
  void Raise() {
    SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x13);
    if (++ticks == 4) File.WriteAllText(record + ".shown", "");
  }
  protected override void OnFormClosing(FormClosingEventArgs e) {
    if (stay) e.Cancel = true; else File.WriteAllText(record, "asked to close");
    if (profiles != null) File.WriteAllText(profiles, held);
    base.OnFormClosing(e);
  }
  [STAThread] static void Main(string[] a) {
    record = a[0];
    stay = Array.IndexOf(a, "stay") >= 0;
    int kept = Array.IndexOf(a, "rewrites");
    if (kept >= 0) { profiles = a[kept + 1]; held = File.ReadAllText(profiles); }
    var f = new Stand();
    f.Opacity = 0;
    var timer = new Timer();
    timer.Interval = 50;
    timer.Tick += (s, e) => f.Raise();
    f.Shown += (s, e) => timer.Start();
    Application.Run(f);
  }
}`;
const running = (image) => execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`], { encoding: 'utf8' }).includes(image);

async function launcherReopen() {
  const dir = mkdtempSync(path.join(work, 'windows-'));
  writeFileSync(path.join(dir, 'stand.cs'), WINDOW_APP);
  const launcherImage = `nano-test-launcher-${process.pid}.exe`;
  const gameImage = `nano-test-game-${process.pid}.exe`;
  execFileSync(CSC, ['/nologo', '/target:winexe', `/out:${path.join(dir, launcherImage)}`, path.join(dir, 'stand.cs')], { windowsHide: true });
  copyFileSync(path.join(dir, launcherImage), path.join(dir, gameImage));
  const env = { ...process.env, PYIDE_MC_LAUNCHER_IMAGE: launcherImage, PYIDE_MC_GAME_IMAGE: gameImage };
  const start = async (image, ...args) => {
    const record = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.txt`);
    const child = spawn(path.join(dir, image), [record, ...args], { windowsHide: false, stdio: 'ignore' });
    children.add(child);
    let code;
    child.on('exit', (c) => { code = c; children.delete(child); });
    // Its window, not its process: a program tasklist already lists may not have one yet.
    await until(() => existsSync(`${record}.shown`), `${image} to show its window`, 15000);
    return { child, record, exited: () => code };
  };

  const open = await start(launcherImage);
  check(await L.closeLauncher(env) && !running(launcherImage), 'an open launcher with no game is closed');
  await until(() => open.exited() !== undefined, 'the launcher to exit', 30000);
  check(open.exited() === 0 && existsSync(open.record), 'it closed through its own window, not killed: its closing code ran and it exited with 0');

  const stubborn = await start(launcherImage, 'stay');
  const began = Date.now();
  const stayed = await L.closeLauncher(env);
  const took = Date.now() - began;
  check(stayed === false && running(launcherImage) && stubborn.exited() === undefined && took >= 4500, `a launcher that stays open gets its 5 s and is not killed (${took} ms), and today's message stands`);
  stubborn.child.kill();
  await until(() => !running(launcherImage), 'the stubborn stand-in to go', 90000);

  const waiting = await start(launcherImage);
  const game = await start(gameImage, '--assetsDir', 'x', '--version', '1.20.1');
  check(await L.closeLauncher(env) === false && running(launcherImage) && running(gameImage) && !existsSync(waiting.record) && !existsSync(game.record), 'while a game runs nothing is asked to close, the game least of all');
  game.child.kill();
  await until(() => !running(gameImage), 'the stand-in game to go', 90000);
  const unrelated = await start(gameImage);
  check(await L.closeLauncher(env) && running(gameImage) && !existsSync(unrelated.record), 'a Java process that is no game, such as a server, does not hold the launcher back and is left alone');
  unrelated.child.kill();
  await until(() => !running(gameImage), 'the unrelated stand-in to go', 90000);

  const instant = Date.now();
  const guarded = await L.closeLauncher({ ...process.env, PYIDE_MC_LAUNCHER: 'stand-in', PYIDE_MC_LAUNCHER_IMAGE: '' });
  check(guarded === false && Date.now() - instant < 3000, 'a stand-in launcher that names no image can never reach the real launcher: nothing runs at all');

  const root = mkdtempSync(path.join(work, 'reopen-'));
  process.env.PYIDE_MC_LAUNCHER = JSON.stringify([process.execPath, standInLauncher]);
  process.env.PYIDE_MC_LAUNCHER_IMAGE = launcherImage;
  process.env.PYIDE_MC_GAME_IMAGE = gameImage;
  const { craft } = makeCraft(REVERSED);
  const made = await craft.create(root, { name: 'reopen', mc: '1.20.1', loader: 'vanilla' }, () => {});
  const before = starts(root);
  const profiles = path.join(root, '.launcher', 'launcher_profiles.json');
  mkdirSync(path.dirname(profiles), { recursive: true });
  writeFileSync(profiles, S({ profiles: { mine: { name: 'Mine', type: 'custom', lastVersionId: '1.20.1' } }, settings: {}, version: 3 }));
  await start(launcherImage, 'rewrites', profiles);
  const reopened = await craft.play(root, made.name, {}, () => {});
  await until(() => starts(root) === before + 1, 'the launcher to start again', 30000);
  check(reopened.launched && reopened.reopened && reopened.alreadyOpen === false && !running(launcherImage), `Play closes the open launcher and starts it again, so it reads the new profile (${S({ reopened: reopened.reopened, alreadyOpen: reopened.alreadyOpen })})`);
  const left = JSON.parse(readFileSync(profiles, 'utf8')).profiles;
  check(left.mine && left[`nano-${made.name}`], `a launcher that rewrites its profiles as it closes does not take the instance's profile with it (${S(Object.keys(left))})`);
  const stays = await start(launcherImage, 'stay');
  const kept = await craft.play(root, made.name, {}, () => {});
  check(kept.launched && kept.alreadyOpen === true && !kept.reopened, 'a launcher that will not close keeps today\'s message');
  stays.child.kill();
  await until(() => !running(launcherImage), 'the stubborn stand-in to go', 90000);

  // Delete: a launcher left open writes the profiles it read at its start back over the file when it closes later,
  // which would bring the deleted instance's profile back. Remove closes it first, as Play does, and starts nothing.
  const startsBefore = starts(root);
  const rewriting = await start(launcherImage, 'rewrites', profiles);
  const removed = await craft.remove(root, made.name);
  await L.closeLauncher(env);
  await until(() => rewriting.exited() !== undefined, 'the rewriting stand-in to exit', 30000);
  const afterRemove = JSON.parse(readFileSync(profiles, 'utf8')).profiles;
  check(removed?.removed && removed.alreadyOpen === false && !afterRemove[`nano-${made.name}`] && afterRemove.mine && starts(root) === startsBefore,
    `deleting an instance while the launcher is open closes the launcher before the profile goes, so its write-back cannot return it (${S({ removed, profiles: Object.keys(afterRemove) })})`);
  writeFileSync(profiles, S({ profiles: { ...afterRemove, [`nano-${made.name}`]: { name: made.name, type: 'custom', lastVersionId: `nano-${made.name}` } }, settings: {}, version: 3 }));
  const stubbornAtRemove = await start(launcherImage, 'stay');
  const keptOpen = await craft.remove(root, made.name);
  check(keptOpen?.alreadyOpen === true && !JSON.parse(readFileSync(profiles, 'utf8')).profiles[`nano-${made.name}`], `a launcher that will not close is said, and the profile still leaves the file (${S(keptOpen)})`);
  stubbornAtRemove.child.kill();
  await until(() => !running(launcherImage), 'the stubborn stand-in to go', 90000);
  delete process.env.PYIDE_MC_LAUNCHER_IMAGE;
  delete process.env.PYIDE_MC_GAME_IMAGE;
}

async function runAttacks() {
  for (const { name, patches, run } of ATTACKS) {
    const real = await run(realClient);
    check(real.ok, `${name} fails against the real code: ${real.why}`);
    const weak = await run(weakCopy(name, patches));
    check(!weak.ok, `${name} gets through a copy without the defence: ${weak.why}`);
  }
  process.env.PYIDE_MC_LAUNCHER = JSON.stringify([process.execPath, standInLauncher]);
  for (const { name, patches, run } of CODE_ATTACKS) {
    const real = await run(L);
    check(real.ok, `${name} fails against the real code: ${real.why}`);
    const weak = await run(weakLauncher(name, patches));
    check(!weak.ok, `${name} gets through a copy without the defence: ${weak.why}`);
  }
}

try {
  await basics();
  serversDat();
  joinCodes();
  await friendSide();
  await launcherReopen();
  await runAttacks();
} catch (err) {
  check(false, err.stack || err.message);
}
check(!realDns.length, `no name was looked up in the real DNS (${S(realDns)})`);
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
