// A tiny Redis stand-in speaking RESP2 over TCP, for verify/database-nosql.mjs: in-memory databases with strings,
// hashes, lists, sets, sorted sets and streams, AUTH, SELECT, SCAN (paged by cursor), TYPE, INFO and friends.
// Every command is recorded in `commands` so the test can check how the IDE talks to the server (SCAN, never KEYS).
import net from 'net';

const ok = { s: 'OK' };
const err = (text) => ({ e: text });

function encode(v) {
  if (v === null || v === undefined) return '$-1\r\n';
  if (typeof v === 'number') return `:${v}\r\n`;
  if (Array.isArray(v)) return `*${v.length}\r\n${v.map(encode).join('')}`;
  if (v.s !== undefined) return `+${v.s}\r\n`;
  if (v.e !== undefined) return `-${v.e}\r\n`;
  const b = Buffer.from(String(v), 'utf8');
  return `$${b.length}\r\n${String(v)}\r\n`;
}

// Parses complete RESP arrays of bulk strings from buf; returns [commands, rest].
function parse(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    if (i >= buf.length || buf[i] !== 0x2a) break;
    const eol = buf.indexOf('\r\n', i);
    if (eol < 0) break;
    const n = Number(buf.toString('latin1', i + 1, eol));
    let j = eol + 2;
    const args = [];
    let complete = true;
    for (let k = 0; k < n; k++) {
      const e = buf.indexOf('\r\n', j);
      if (e < 0 || buf[j] !== 0x24) { complete = false; break; }
      const len = Number(buf.toString('latin1', j + 1, e));
      if (e + 2 + len + 2 > buf.length) { complete = false; break; }
      args.push(buf.toString('utf8', e + 2, e + 2 + len));
      j = e + 2 + len + 2;
    }
    if (!complete) break;
    out.push(args);
    i = j;
  }
  return [out, buf.subarray(i)];
}

export function startRespMock({ user = 'default', password = null, version = '7.2.0-mock', seed = {} } = {}) {
  const dbs = new Map();
  const commands = [];
  const db = (n) => { if (!dbs.has(n)) dbs.set(n, new Map()); return dbs.get(n); };
  for (const [n, entries] of Object.entries(seed)) for (const [k, v] of Object.entries(entries)) db(Number(n)).set(k, v);

  const range = (len, start, stop) => {
    let a = Number(start);
    let b = Number(stop);
    if (a < 0) a += len;
    if (b < 0) b += len;
    return [Math.max(0, a), Math.min(len - 1, b)];
  };

  function run(state, [name, ...a]) {
    const cmd = name.toUpperCase();
    commands.push([cmd, ...a]);
    if (cmd === 'AUTH') {
      const [u, p] = a.length === 2 ? a : [user, a[0]];
      if (u === user && p === password) { state.authed = true; return ok; }
      return err('WRONGPASS invalid username-password pair or user is disabled.');
    }
    if (!state.authed) return err('NOAUTH Authentication required.');
    const keys = db(state.db);
    const typed = (k, type) => {
      const v = keys.get(k);
      if (v && v.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      return v;
    };
    switch (cmd) {
      case 'PING': return { s: 'PONG' };
      case 'ECHO': return a[0];
      case 'QUIT': return ok;
      case 'CLIENT': return ok;
      case 'SELECT': state.db = Number(a[0]); return ok;
      case 'DBSIZE': return keys.size;
      case 'CONFIG': return ['databases', '16'];
      case 'INFO': {
        const section = (a[0] || 'all').toLowerCase();
        let text = '';
        if (section === 'server' || section === 'all') text += `# Server\r\nredis_version:${version}\r\nredis_mode:standalone\r\n`;
        if (section === 'keyspace' || section === 'all') {
          text += '# Keyspace\r\n';
          for (const [n, m] of [...dbs].sort(([x], [y]) => x - y)) if (m.size) text += `db${n}:keys=${m.size},expires=0,avg_ttl=0\r\n`;
        }
        return text;
      }
      case 'SCAN': {
        const opt = (name) => { const i = a.findIndex((x) => x.toUpperCase() === name); return i > 0 ? a[i + 1] : null; };
        const count = Number(opt('COUNT')) || 10;
        // Glob as Redis reads it: * and ? wildcards, a backslash escapes the next character.
        const pattern = opt('MATCH');
        const re = pattern && new RegExp(`^${pattern.replace(/\\(.)|([*?])|([.+^${}()|[\]])/g, (_m, esc, wild, special) => (esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : wild ? (wild === '*' ? '.*' : '.') : `\\${special}`))}$`, 's');
        const all = [...keys.keys()].sort();
        const at = Number(a[0]);
        const next = at + count >= all.length ? '0' : String(at + count);
        return [next, all.slice(at, at + count).filter((k) => !re || re.test(k))];
      }
      case 'KEYS': return [...keys.keys()];
      case 'TYPE': return { s: keys.get(a[0])?.type || 'none' };
      case 'EXISTS': return a.filter((k) => keys.has(k)).length;
      case 'DEL': return a.filter((k) => keys.delete(k)).length;
      case 'GET': return typed(a[0], 'string')?.value ?? null;
      case 'SET': keys.set(a[0], { type: 'string', value: a[1] }); return ok;
      case 'INCR': { const v = Number(typed(a[0], 'string')?.value || 0) + 1; keys.set(a[0], { type: 'string', value: String(v) }); return v; }
      case 'HSET': {
        const h = typed(a[0], 'hash') || { type: 'hash', value: new Map() };
        let added = 0;
        for (let i = 1; i < a.length; i += 2) { if (!h.value.has(a[i])) added++; h.value.set(a[i], a[i + 1]); }
        keys.set(a[0], h);
        return added;
      }
      case 'HGET': return typed(a[0], 'hash')?.value.get(a[1]) ?? null;
      case 'HGETALL': return [...(typed(a[0], 'hash')?.value || [])].flat();
      case 'RPUSH': case 'LPUSH': {
        const l = typed(a[0], 'list') || { type: 'list', value: [] };
        for (const x of a.slice(1)) if (cmd === 'RPUSH') l.value.push(x); else l.value.unshift(x);
        keys.set(a[0], l);
        return l.value.length;
      }
      case 'LRANGE': { const l = typed(a[0], 'list')?.value || []; const [s, e] = range(l.length, a[1], a[2]); return l.slice(s, e + 1); }
      case 'SADD': {
        const s = typed(a[0], 'set') || { type: 'set', value: new Set() };
        const before = s.value.size;
        for (const x of a.slice(1)) s.value.add(x);
        keys.set(a[0], s);
        return s.value.size - before;
      }
      case 'SMEMBERS': return [...(typed(a[0], 'set')?.value || [])];
      case 'ZADD': {
        const z = typed(a[0], 'zset') || { type: 'zset', value: new Map() };
        for (let i = 1; i < a.length; i += 2) z.value.set(a[i + 1], Number(a[i]));
        keys.set(a[0], z);
        return (a.length - 1) / 2;
      }
      case 'ZRANGE': {
        const z = [...(typed(a[0], 'zset')?.value || [])].sort(([, x], [, y]) => x - y);
        const [s, e] = range(z.length, a[1], a[2]);
        const part = z.slice(s, e + 1);
        return a.some((x) => x.toUpperCase() === 'WITHSCORES') ? part.flatMap(([m, sc]) => [m, String(sc)]) : part.map(([m]) => m);
      }
      case 'XADD': {
        const x = typed(a[0], 'stream') || { type: 'stream', value: [] };
        const id = a[1] === '*' ? `${Date.now()}-${x.value.length}` : a[1];
        x.value.push([id, a.slice(2)]);
        keys.set(a[0], x);
        return id;
      }
      case 'XRANGE': {
        const entries = typed(a[0], 'stream')?.value || [];
        const ci = a.findIndex((x) => x.toUpperCase() === 'COUNT');
        return ci > 0 ? entries.slice(0, Number(a[ci + 1])) : entries;
      }
      default: return err(`ERR unknown command '${name}', with args beginning with: ${a.slice(0, 3).map((x) => `'${x}'`).join(' ')}`);
    }
  }

  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const state = { db: 0, authed: !password };
    let pending = Buffer.alloc(0);
    sock.on('data', (d) => {
      const [cmds, rest] = parse(Buffer.concat([pending, d]));
      pending = rest;
      for (const c of cmds) {
        let reply;
        try { reply = run(state, c); } catch (e) { reply = err(e.message); }
        sock.write(encode(reply));
        if (c[0].toUpperCase() === 'QUIT') sock.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    commands,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  })));
}
