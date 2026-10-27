// The multi-window sync's operational transformation (renderer/core/editors.js: mapPoint, survivors, over, xform),
// without the IDE: every pair of single changes on a short text meets in one text whichever is applied first, and
// 20,000 random sessions of two windows following the protocol of main/windows.js (an op is accepted only on the
// current revision, a refused one is sent again after what it missed) end with the same text everywhere. Before the
// fix, two windows replacing at the same point, or one typing inside a range the other replaced, ended apart.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'core', 'editors.js'), 'utf8');
const grab = (name) => {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} not found in editors.js`);
};
// eslint-disable-next-line no-new-func
const { xform } = new Function(`${['mapPoint', 'survivors', 'over', 'xform'].map(grab).join('\n')}; return { xform };`)();

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const apply = (text, op) => { let out = ''; let pos = 0; for (const c of op.c) { out += text.slice(pos, c.at) + c.ins; pos = c.at + c.del; } return out + text.slice(pos); };

// Every pair of one-change ops on 'abcd'.
const bad = [];
const base = 'abcd';
for (let a1 = 0; a1 <= 4; a1++) for (let d1 = 0; d1 + a1 <= 4; d1++) for (const i1 of ['', 'x', 'xx']) {
  for (let a2 = 0; a2 <= 4; a2++) for (let d2 = 0; d2 + a2 <= 4; d2++) for (const i2 of ['', 'y']) {
    const A = { c: d1 || i1 ? [{ at: a1, del: d1, ins: i1 }] : [] };
    const B = { c: d2 || i2 ? [{ at: a2, del: d2, ins: i2 }] : [] };
    const [[A2], [B2]] = xform([A], [B], true);
    if (apply(apply(base, A), B2) !== apply(apply(base, B), A2)) bad.push({ A: A.c, B: B.c });
  }
}
check(!bad.length, `two concurrent changes meet in one text whichever comes first (${bad.length} pairs apart${bad.length ? `: ${JSON.stringify(bad.slice(0, 3))}` : ''})`);

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function session(seed) {
  const r = rng(seed);
  let serverRev = 0;
  let serverText = 'hello\nworld\n';
  const queue = [];
  const clients = [0, 1].map(() => ({ text: serverText, rev: 0, sent: null, buffer: [], inbox: [] }));
  const flush = (c, id) => {
    if (c.sent || !c.buffer.length) return;
    c.sent = c.buffer;
    c.buffer = [];
    queue.push({ from: id, base: c.rev, ops: c.sent });
  };
  const deliver = () => {
    const m = queue.shift();
    if (m.base !== serverRev) return void clients[m.from].inbox.push({ nack: true });
    serverRev++;
    for (const op of m.ops) serverText = apply(serverText, op);
    clients.forEach((c, id) => c.inbox.push({ rev: serverRev, ops: m.ops, mine: id === m.from }));
  };
  const receive = (c, id) => {
    const m = c.inbox.shift();
    if (m.nack) { if (c.sent) { c.buffer = [...c.sent, ...c.buffer]; c.sent = null; flush(c, id); } return; }
    c.rev = m.rev;
    if (m.mine) { c.sent = null; flush(c, id); return; }
    let remote = m.ops;
    if (c.sent) [remote, c.sent] = xform(remote, c.sent, true);
    [remote, c.buffer] = xform(remote, c.buffer, true);
    for (const op of remote) c.text = apply(c.text, op);
  };
  for (let i = 0; i < 40; i++) {
    const k = r();
    const id = r() < 0.5 ? 0 : 1;
    const c = clients[id];
    if (k < 0.45) {
      const at = Math.floor(r() * (c.text.length + 1));
      const del = r() < 0.5 ? 0 : Math.min(c.text.length - at, Math.floor(r() * 4));
      const ins = ['', 'x', 'y', '\n', 'ab'][Math.floor(r() * 5)];
      if (!del && !ins) continue;
      const op = { c: [{ at, del, ins }] };
      c.text = apply(c.text, op);
      c.buffer.push(op);
      flush(c, id);
    } else if (k < 0.7 && queue.length) deliver();
    else if (c.inbox.length) receive(c, id);
  }
  for (let guard = 0; guard < 10000 && (queue.length || clients.some((c) => c.inbox.length || c.sent || c.buffer.length)); guard++) {
    if (queue.length) deliver();
    clients.forEach((c, id) => { while (c.inbox.length) receive(c, id); flush(c, id); });
  }
  return clients.every((c) => c.text === serverText);
}
let apart = 0;
let firstApart = null;
for (let seed = 1; seed <= 20000; seed++) if (!session(seed)) { apart++; firstApart ??= seed; }
check(!apart, `20,000 random sessions of two windows typing at once end with one text (${apart} apart${apart ? `, first seed ${firstApart}` : ''})`);

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
