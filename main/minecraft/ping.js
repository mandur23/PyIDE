// The server list ping: what the game's multiplayer screen asks a server before joining it (a handshake and a status
// request over TCP; the answer is one JSON text). Craft uses it to preselect the Minecraft version and the loader of a
// server added by its address alone. The answer is a stranger's bytes: its size is capped, its numbers bounded, and
// summarize keeps only what it can read. A wrong guess costs little, since the user sees the choice in the dialog.
const dns = require('dns').promises;
const net = require('net');
const { RELEASE } = require('./sources');

const TIMEOUT = 4000;
const SRV_TIMEOUT = 2000;
const MAX_ANSWER = 2 * 1024 * 1024; // a modded server's answer lists its mods; a favicon is under 64 KB
const DEFAULT_PORT = 25565;
const HANDSHAKE_NO_VERSION = -1; // "not joining": any server answers a status request with it

function varInt(n) {
  const out = [];
  let v = n >>> 0;
  do {
    out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
    v >>>= 7;
  } while (v);
  return Buffer.from(out);
}
const framed = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varInt(body.length), body]);
};
const text = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
};
function handshake(host, port) {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([framed(Buffer.from([0]), varInt(HANDSHAKE_NO_VERSION), text(host), portBytes, Buffer.from([1])), framed(Buffer.from([0]))]);
}
// A VarInt at `at` -> [value, next offset]; null while its bytes have not all arrived. Five bytes at most.
function readVarInt(buf, at) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [value >>> 0, at + i + 1];
  }
  throw new Error('not a Minecraft server');
}
// The status JSON in the bytes received so far; null until they are all here.
function statusText(buf) {
  const length = readVarInt(buf, 0);
  if (!length) return null;
  const [size, bodyAt] = length;
  if (size > MAX_ANSWER) throw new Error('the answer is too long');
  if (buf.length < bodyAt + size) return null;
  const id = readVarInt(buf, bodyAt);
  const stringSize = id && readVarInt(buf, id[1]);
  if (!id || id[0] !== 0 || !stringSize) throw new Error('not a Minecraft server');
  const [n, at] = stringSize;
  if (at + n > bodyAt + size) throw new Error('not a Minecraft server');
  return buf.toString('utf8', at, at + n);
}

// A proxy's own version, or a range it accepts, says nothing of the server behind it.
const PROXY = /velocity|bungee|waterfall|\d\s*[-–]\s*\d|\.x\b/i;
const VERSION_IN = /\b(1\.\d{1,2}(?:\.\d{1,2})?|[2-9]\d\.\d{1,2}(?:\.\d{1,2})?)\b/;
const mcOf = (name) => {
  if (typeof name !== 'string' || PROXY.test(name)) return null;
  const v = VERSION_IN.exec(name)?.[1];
  return v && RELEASE.test(v) ? v : null;
};
// NeoForge marks its servers isModded and lists itself; Forge 1.13+ sends forgeData, and 1.7-1.12 send modinfo. Fabric
// and Quilt say nothing, so a server without these is taken as one a plain client can join.
function loaderOf(status) {
  const data = status.forgeData && typeof status.forgeData === 'object' ? status.forgeData : null;
  const mods = Array.isArray(data?.mods) ? data.mods : [];
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  const neo = mods.some((m) => /neoforge/i.test(m?.modId ?? m?.modmarker ?? '')) || channels.some((c) => /^neoforge:/i.test(c?.res ?? ''));
  if (neo || status.isModded === true) return 'neoforge';
  if (data || status.modinfo?.type === 'FML') return 'forge';
  return 'vanilla';
}
function summarize(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('not a Minecraft server');
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
  return { online: true, mc: mcOf(status.version?.name), loader: loaderOf(status), players: count(status.players?.online), max: count(status.players?.max) };
}

// Domains without a port name their server in an SRV record, as in the game's own server list.
async function srvTarget(host) {
  if (net.isIP(host)) return null;
  const timer = new Promise((resolve) => { setTimeout(resolve, SRV_TIMEOUT, null); });
  const lookup = dns.resolveSrv(`_minecraft._tcp.${host}`).then((r) => r[0] || null, () => null);
  const srv = await Promise.race([lookup, timer]);
  return srv && { host: srv.name, port: srv.port };
}

function ask(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks = [];
    let got = 0;
    let need = 1; // joined and read again only when this much is here: a sender of single bytes costs no more
    // A limit on the whole answer, since a slow one that never ends keeps resetting a socket's idle timeout.
    const limit = setTimeout(() => done(reject, new Error('no answer')), timeout);
    const done = (fn, v) => { clearTimeout(limit); socket.destroy(); fn(v); };
    socket.once('error', (err) => done(reject, err));
    socket.once('close', () => done(reject, new Error('the connection closed')));
    socket.once('connect', () => socket.write(handshake(host, port)));
    socket.on('data', (d) => {
      chunks.push(d);
      got += d.length;
      if (got < need) return;
      try {
        if (got > MAX_ANSWER + 16) throw new Error('the answer is too long');
        const buf = Buffer.concat(chunks.splice(0));
        chunks.push(buf);
        const length = readVarInt(buf, 0);
        need = length ? length[1] + length[0] : got + 1;
        const json = statusText(buf);
        if (json !== null) done(resolve, json);
      } catch (err) { done(reject, err); }
    });
  });
}

// host, port|null -> {online: true, mc, loader, players, max}, or {online: false} for anything that is not a server's
// answer: this only fills in a dialog, so nothing here is an error.
async function ping(host, port, timeout = TIMEOUT) {
  try {
    const target = (port ? null : await srvTarget(host)) || { host, port: port || DEFAULT_PORT };
    return summarize(JSON.parse(await ask(target.host, target.port, timeout)));
  } catch { return { online: false }; }
}

module.exports = { ping, summarize, statusText, handshake };
