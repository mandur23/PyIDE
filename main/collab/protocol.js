// The messages of a collaboration session (docs/collab-coding-plan.md) and the rules every guest message passes on the
// host. A guest is untrusted: its messages are checked here before anything else reads them, and its paths are
// project-relative and may not leave the project or name a hidden file.
//
// On the wire a message is JSON, 4-byte big-endian length first, inside the encrypted stream of main/bore-gate.js (whose
// records are at most 16 KB: a message spans as many as it needs).
const fs = require('fs');
const path = require('path');

const MAX_MESSAGE = 8 * 1024 * 1024; // a file sent whole on opening is the largest message
const MAX_OP_TEXT = 1024 * 1024; // the text one op may insert
const MAX_CHANGES = 10000;

// ---------- framing ----------
function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_MESSAGE) throw Object.assign(new Error('the message is too large'), { code: 'tooLarge' });
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}
// Bytes as they arrive -> whole messages, in order. A length over the limit or text that is not JSON ends the stream
// (onError), so a peer cannot make the host buffer without end.
// The bytes not read yet are kept as the chunks they came in and joined once a message is whole: joined on every
// chunk, an 8 MB message in 1 KB records took 7 s. Kept chunks are copies, since a caller may reuse its buffer.
function decoder(onMessage, onError) {
  let parts = [];
  let have = 0; // bytes in parts
  let want = -1; // bytes of the message being read, its length included; -1 while its length is not read
  let dead = false;
  const joined = () => { if (parts.length > 1) parts = [Buffer.concat(parts, have)]; return parts[0]; };
  return (chunk) => {
    if (dead || !chunk.length) return;
    parts.push(Buffer.from(chunk));
    have += chunk.length;
    for (;;) {
      if (want < 0) {
        if (have < 4) return;
        const n = joined().readUInt32BE(0);
        if (n > MAX_MESSAGE) { dead = true; return onError(Object.assign(new Error('a message over the size limit'), { code: 'tooLarge' })); }
        want = 4 + n;
      }
      if (have < want) return;
      const buf = joined();
      const body = buf.subarray(4, want);
      parts = have > want ? [buf.subarray(want)] : [];
      have -= want;
      want = -1;
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { dead = true; return onError(Object.assign(new Error('a message that is not JSON'), { code: 'badMessage' })); }
      onMessage(msg);
    }
  };
}

// ---------- messages ----------
const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
const isStr = (s, max = 4096) => typeof s === 'string' && s.length <= max;
// An op as renderer/core/ot.js makes them: changes sorted, not overlapping, inside sane sizes.
function validOp(op) {
  if (!op || typeof op !== 'object' || !Array.isArray(op.c) || op.c.length > MAX_CHANGES) return false;
  if (op.eol !== undefined && op.eol !== '\n' && op.eol !== '\r\n') return false;
  let end = -1;
  let ins = 0;
  for (const c of op.c) {
    if (!c || !isInt(c.at) || !isInt(c.del) || typeof c.ins !== 'string' || c.at < end) return false;
    end = c.at + c.del;
    ins += c.ins.length;
  }
  return ins <= MAX_OP_TEXT;
}
// What a guest may send, by type: each check takes the message and says whether its fields are as expected. Looked up
// with Object.hasOwn: as a plain lookup, Object.prototype's names (constructor, toString) were types too.
const FROM_GUEST = {
  hello: (m) => isStr(m.name, 64) && isStr(m.version, 32),
  'doc:join': (m) => isStr(m.path),
  'doc:leave': (m) => isStr(m.path),
  'doc:op': (m) => isStr(m.path) && isInt(m.base) && Array.isArray(m.ops) && m.ops.length <= 1000 && m.ops.every(validOp),
  'doc:save': (m) => isStr(m.path) && isInt(m.req),
  // Files and folders, by a guest the host lets edit. req: the guest's number for the answer (fs:result).
  'fs:create': (m) => isStr(m.path) && typeof m.dir === 'boolean' && isInt(m.req),
  'fs:rename': (m) => isStr(m.from) && isStr(m.to) && isInt(m.req),
  'fs:delete': (m) => isStr(m.path) && isInt(m.req),
  // path null: no file of the project is in front (the caret is elsewhere).
  cursor: (m) => (m.path === null || isStr(m.path)) && Array.isArray(m.ranges) && m.ranges.length <= 100 && m.ranges.every((r) => Array.isArray(r) && r.length === 2 && r.every(isInt)),
  view: (m) => (m.path === null || isStr(m.path)) && isInt(m.line),
  tree: (m) => isStr(m.path),
  chat: (m) => isStr(m.text, 4000) && m.text.trim() !== '',
  // A language server request about a file, answered by the host's (lsp:answer). Positions are LSP's: line and
  // character (UTF-16), from 0.
  lsp: (m) => isInt(m.req) && ['completion', 'hover', 'definition', 'signature'].includes(m.method) && isStr(m.path) && isInt(m.line) && isInt(m.character),
  // Running on the host's computer: only ever asked, and the host answers each time (run:answer).
  'run:request': (m) => isInt(m.req) && isStr(m.path),
  // The host's shared terminal: a guest asks to type (term:answer), and types only once allowed.
  'term:ask': () => true,
  'term:input': (m) => isStr(m.data, 4096),
  // A host port the host opened to guests, relayed (main/collab/share.js).
  'tcp:open': (m) => isInt(m.cid) && Number.isInteger(m.port) && m.port > 0 && m.port < 65536,
  'tcp:data': (m) => isInt(m.cid) && isStr(m.data, 70000) && /^[A-Za-z0-9+/]*={0,2}$/.test(m.data),
  'tcp:close': (m) => isInt(m.cid),
  bye: () => true,
};
// -> null when the guest's message may be handled, else why not.
function checkGuest(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'not a message';
  if (typeof msg.type !== 'string' || !Object.hasOwn(FROM_GUEST, msg.type)) return `unknown message ${typeof msg.type === 'string' ? msg.type.slice(0, 40) : typeof msg.type}`;
  const check = FROM_GUEST[msg.type];
  return check(msg) ? null : `a malformed ${msg.type}`;
}

// ---------- paths ----------
// Files a guest never sees or opens unless the host takes them off the list: secrets and the repository's internals.
const DEFAULT_HIDDEN = ['.env', '.env.*', '*.key', '*.pem', '*.pfx', '*.p12', 'id_rsa*', '.git/', '.ssh/'];
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');
// rel: a project-relative path with / -> hidden or not. A pattern ending in / hides that folder and all in it, at any
// depth; another pattern hides files of that name in any folder.
function isHidden(rel, hidden = DEFAULT_HIDDEN) {
  const parts = rel.split('/');
  return hidden.some((g) => (g.endsWith('/') ? parts.some((p) => globRe(g.slice(0, -1)).test(p)) : globRe(g).test(parts[parts.length - 1])));
}
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
// A guest's path (project-relative, / or \) -> the absolute path under root, or throws {code: 'badPath' | 'hidden'}.
// Refused: absolute paths, drives, UNC, .. and . parts, streams (a:b), names Windows changes (a trailing dot or space,
// devices), control characters, and names like 8.3 short names (GIT~1 is .git, ENV~1 is .env, past the hidden list).
// The real path is checked separately (realGuest), because a link may lead out or to a hidden file.
function resolveGuest(root, rel, { hidden = DEFAULT_HIDDEN } = {}) {
  const bad = (why) => { throw Object.assign(new Error(`${why}: ${String(rel).slice(0, 200)}`), { code: 'badPath' }); };
  if (typeof rel !== 'string' || !rel || rel.length > 1024) bad('not a path');
  const norm = rel.replace(/\\/g, '/');
  if (/^[/]|^[A-Za-z]:|^\/\//.test(norm)) bad('not a project path');
  const parts = norm.split('/').filter((p) => p !== '');
  if (!parts.length) bad('not a file');
  for (const p of parts) {
    if (p === '.' || p === '..') bad('a path that leaves its folder');
    if (/[\u0000-\u001f<>:"|?*]/.test(p) || /[. ]$/.test(p) || DEVICE.test(p)) bad('a name Windows does not keep');
    if (/~\d/.test(p)) bad('a short (8.3) name');
  }
  const clean = parts.join('/');
  if (isHidden(clean, hidden)) throw Object.assign(new Error(`${clean} is not shared`), { code: 'hidden' });
  return path.join(root, ...parts);
}
// The real path of an existing file or folder is still inside the project's real path (no link leads out).
async function realUnder(root, abs) {
  const [r, a] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(abs)]);
  const k = (p) => p.toLowerCase().replace(/[\\/]+$/, '');
  return k(a) === k(r) || k(a).startsWith(`${k(r)}${path.sep}`.toLowerCase());
}
// A guest's path -> the real path of the existing file or folder it names, or throws {code: 'badPath' | 'hidden'} (or
// the file system's error, ENOENT). The name is checked (resolveGuest), then where it really leads: a junction or link
// may lead out of the project, or to a hidden file under another name, so the hidden list is checked again on the
// real path.
async function realGuest(root, rel, { hidden = DEFAULT_HIDDEN } = {}) {
  const abs = resolveGuest(root, rel, { hidden });
  const [r, a] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(abs)]);
  const real = relOf(r, a);
  if (real === null) throw Object.assign(new Error(`a path that leads out of the project: ${String(rel).slice(0, 200)}`), { code: 'badPath' });
  if (isHidden(real, hidden)) throw Object.assign(new Error(`${String(rel).slice(0, 200)} is not shared`), { code: 'hidden' });
  return a;
}
// The project-relative path with / of an absolute path under root, or null outside it (or root itself).
function relOf(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

module.exports = { encode, decoder, validOp, checkGuest, resolveGuest, realGuest, realUnder, relOf, isHidden, DEFAULT_HIDDEN, MAX_MESSAGE };
