// Collaborative editing without the app (docs/collab-coding-plan.md, step 0): main/shared-docs.js as the host's one
// order of edits, renderer/core/ot.js as every editor's client, links that keep their order but deliver at random
// times. Checks:
// - convergence: two windows and three guests type, delete, paste several changes at once (with CR, CRLF, Korean and
//   emoji) and switch line separators while messages cross. Windows close tabs and reopen them from the disk, close
//   altogether and come back as new windows; guests leave, drop and come back; a guest's disk load finishes or fails
//   at a random step; a guest now and then sends an op Monaco would apply differently, or one that makes the document
//   too large. Every client answers as renderer/core/editors.js does (a doc:share for a document it has not got is
//   answered with doc:leave) and applies ops as Monaco does (a CR in new text is a line break; a position inside a
//   surrogate pair moves out of it). Once every message is delivered, every holder has the host's text and separator,
//   none waits or has unconfirmed edits, and nothing stays behind once all leave. Seeded, so a failure names its seed;
// - the host's documents step by step: one ask per document, an answer no one waits for, a guest's load that ends
//   after the guest left or that fails, a guest never asked or promoted, messages of an earlier join;
// - a guest's ops are checked against the host's text (CR, lone surrogates, split pairs, past the end, too large);
// - the disk load a guest's document starts from takes its separator as the editor does, and refuses binary files;
// - main/collab/protocol.js: framing split anywhere and in linear time, a length over the limit and text that is not
//   JSON end the stream; a guest's messages are checked by type (Object.prototype's names are not types); guest paths
//   cannot leave the project (.., drives, UNC, streams, devices, a link out) or name a hidden file (also by its 8.3
//   short name or through a link inside the project).
// Usage: node verify/collab-core.mjs   (COLLAB_SEEDS=n for another number of seeds)
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const OT = require('../renderer/core/ot.js');
const SD = require('../main/shared-docs.js');
const P = require('../main/collab/protocol.js');
const { createSharedDocs } = SD;

let passed = 0;
let failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const S = JSON.stringify;
const forThis = OT.forThis || (() => true);

// ---------- a tiny seeded random ----------
function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
  return { next, int: (n) => Math.floor(next() * n), pick: (a) => a[Math.floor(next() * a.length)] };
}
// 😀, 😁, 🙂 and 🐍 all start with the same half (U+D83D): a change between two of them is easily cut in two
const CHARS = ['a', 'b', ' ', '\n', '가', '나', 'x', '(', ')', '😀', '😁', '🙂', '🐍', '😀', '🐍', '\r\n', '\r'];

// ---------- Monaco, as far as these ops go ----------
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
const inPair = (t, i) => i > 0 && i < t.length && isHigh(t.charCodeAt(i - 1)) && isLow(t.charCodeAt(i));
// An op applied to an editor's text (as LF) the way renderer/core/editors.js applyOps has Monaco apply it: ranges are
// clamped to the text and moved out of surrogate pairs (TextModel.validateRange), and a CR in the new text is a line
// break of the model, so '\n' here.
function applyMonaco(text, op) {
  let out = '';
  let i = 0;
  for (const c of op.c) {
    let s = Math.min(c.at, text.length);
    let e = Math.min(c.at + c.del, text.length);
    if (s === e) { if (inPair(text, s)) { s--; e--; } } else { if (inPair(text, s)) s--; if (inPair(text, e)) e++; }
    s = Math.max(s, i);
    e = Math.max(e, s);
    out += text.slice(i, s) + OT.lfText(c.ins);
    i = e;
  }
  return out + text.slice(i);
}

// ---------- the simulation ----------
const PATH = 'C:\\proj\\a.py';
const keyOf = (p) => p.toLowerCase();
const stats = {};
const count = (k) => { stats[k] = (stats[k] || 0) + 1; };
function simulate(seed, { windows = 2, guests = 3, steps = 400, guestFirst = false, maxText } = {}) {
  const r = rng(seed);
  const diskEol = r.next() < 0.5 ? '\n' : '\r\n';
  const diskLf = 'def f():\n    return "가😀🐍"\n';
  const pending = []; // disk loads not finished: {res, rej}
  const docs = createSharedDocs({ keyOf, maxText, load: () => new Promise((res, rej) => pending.push({ res, rej })) });
  const finishLoad = () => {
    const l = pending.splice(r.int(pending.length), 1)[0];
    count('disk loads');
    if (r.next() < 0.15) l.rej(Object.assign(new Error('injected read failure'), { code: 'EINJECT' }));
    else l.res({ text: diskLf.replace(/\n/g, diskEol), eol: diskEol });
  };
  const clients = [];
  const problems = [];
  let gen = 0;
  const makeClient = (name, remote) => {
    const c = { name, id: name, remote, text: '', eol: '\n', state: null, joined: false, bad: false, up: [], down: [] };
    clients.push(c);
    return c;
  };
  const sendUp = (c, channel, msg) => c.up.push({ channel, msg: { path: PATH, ...msg } });
  const apply = (c, ops) => {
    for (const op of ops) {
      c.text = applyMonaco(c.text, op);
      if (op.eol) c.eol = op.eol;
    }
  };
  let joins = 0;
  // A tab opens: a window reads the file from the disk, a guest has nothing until the host answers.
  const join = (c) => {
    c.text = c.remote ? '' : diskLf;
    c.eol = c.remote ? '\n' : diskEol;
    c.bad = false;
    c.state = OT.newClient();
    c.state.joining = c.text;
    c.state.ticket = ++joins;
    c.joined = true;
    count('joins');
    sendUp(c, 'doc:join', { ticket: c.state.ticket });
  };
  // The tab closes (renderer/core/editors.js releaseDoc): the document goes, the messages still on their way stay.
  const close = (c) => { count('tabs closed'); sendUp(c, 'doc:leave', {}); Object.assign(c, { joined: false, state: null, text: '' }); };
  // The window closes or the guest's connection drops: its links go with it, and it comes back as a new one.
  const drop = (c) => {
    count('windows closed or guests dropped');
    docs.leaveAll(c.id);
    Object.assign(c, { joined: false, state: null, text: '', up: [], down: [], id: `${c.name}#${++gen}` });
  };
  // the server side of a link: what a client sends reaches shared-docs
  const toServer = (c, { channel, msg }) => {
    if (channel === 'doc:join') {
      const id = c.id;
      docs.join(id, msg.path, (ch, m) => { if (c.id === id) c.down.push({ channel: ch, msg: m }); }, { remote: c.remote, ticket: msg.ticket });
    } else if (channel === 'doc:snapshot') docs.snapshot(c.id, msg);
    else if (channel === 'doc:op') {
      const before = docs.textOf(PATH)?.text.length;
      docs.op(c.id, msg);
      const after = docs.textOf(PATH)?.text.length;
      if (c.remote && maxText && after > maxText && after > before) problems.push(`${c.id} made the document ${after} characters long`);
    }
    else if (channel === 'doc:leave') docs.leave(c.id, msg.path);
  };
  // the client side: as renderer/core/editors.js handles them
  const toClient = (c, { channel, msg }) => {
    if (channel === 'doc:op' && msg.mine) count('ops applied');
    if (channel === 'doc:nack') count('nacks');
    if (channel === 'doc:share') count('holders asked');
    if (!c.joined) {
      if (channel === 'doc:share') sendUp(c, 'doc:leave', {});
      return;
    }
    const s = c.state;
    if (channel === 'doc:synced') {
      const res = OT.synced(s, msg, c.text);
      c.state = res.state;
      if (res.apply) apply(c, res.apply);
      if (res.send) sendUp(c, 'doc:op', res.send);
    } else if (channel === 'doc:share') {
      if (OT.share(s, msg) === false) return;
      sendUp(c, 'doc:snapshot', { rev: s.rev, text: c.text, eol: c.eol });
    } else if (channel === 'doc:op') {
      if (!s.shared) return;
      const res = OT.remote(s, msg);
      if (res.apply) apply(c, res.apply);
      if (res.send) sendUp(c, 'doc:op', res.send);
    } else if (channel === 'doc:nack') {
      const send = OT.nack(s, msg);
      if (send) sendUp(c, 'doc:op', send);
    } else if (channel === 'doc:unshared') {
      c.state = OT.unshared ? OT.unshared(s, msg) : { ...OT.newClient(), rev: s.rev };
    } else if (channel === 'doc:failed') {
      if (!forThis(s, msg)) return;
      // Expected: the disk load failed, or this guest sent an op the host may not take.
      count(`refused (${msg.code})`);
      if (!c.bad && msg.code !== 'EINJECT' && msg.code !== 'tooLarge') problems.push(`${c.id} refused: ${msg.error}`);
      Object.assign(c, { joined: false, state: null, text: '' });
    }
  };
  // A position of the text that does not split a surrogate pair, as a caret or a selection end in Monaco.
  const boundary = (t, i, right) => (inPair(t, i) ? i + (right ? 1 : -1) : i);
  // a random edit of a client's own text, as Monaco reports it (renderer/core/editors.js opOf: new text as LF)
  const edit = (c) => {
    const typed = (op) => {
      const send = OT.local(c.state, op);
      if (send) sendUp(c, 'doc:op', send);
    };
    if (r.next() < (c.remote ? 0.01 : 0.03)) {
      const eol = c.eol === '\n' ? '\r\n' : '\n';
      c.eol = eol;
      return typed({ c: [], eol });
    }
    const len = c.text.length;
    // now and then a guest sends what no editor would: the host must refuse it, since Monaco applies it differently
    if (c.remote && r.next() < 0.04) {
      const pairs = [...c.text.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)].map((m) => m.index + 1);
      const kind = r.int(4);
      let op;
      if (kind === 0) op = { c: [{ at: r.int(len + 1), del: 0, ins: 'a\rb' }] };
      else if (kind === 1) op = { c: [{ at: boundary(c.text, r.int(len + 1), true), del: 0, ins: '\uD83D' }] };
      else if (kind === 2 && pairs.length) op = { c: [{ at: r.pick(pairs), del: 0, ins: 'Z' }] };
      else op = { c: [{ at: len + 1 + r.int(3), del: 0, ins: 'Q' }] };
      c.bad = true;
      count('ops a guest may not send');
      c.text = OT.applyText(c.text, [op]);
      return typed(op);
    }
    const n = r.next() < 0.2 ? 2 : 1;
    const cuts = Array.from({ length: n }, () => boundary(c.text, r.int(len + 1), false)).sort((a, b) => a - b);
    const changes = [];
    let end = 0;
    for (const at of cuts) {
      if (at < end) continue;
      const del = boundary(c.text, Math.min(at + r.int(4), len), true) - at;
      // a paste now and then: a longer run, with whatever separators it came with
      const runs = r.next() < 0.1 ? 8 + r.int(12) : r.int(4);
      const ins = r.next() < 0.7 ? OT.lfText(Array.from({ length: runs }, () => r.pick(CHARS)).join('')) : '';
      if (!del && !ins) continue;
      changes.push({ at, del, ins });
      end = at + del;
    }
    if (!changes.length) return;
    const op = { c: changes };
    c.text = OT.applyText(c.text, [op]);
    typed(op);
  };

  for (let i = 0; i < windows; i++) makeClient(`w${i + 1}`, false);
  for (let i = 0; i < guests; i++) makeClient(`g${i + 1}`, true);
  const order = guestFirst ? [...clients.filter((c) => c.remote), ...clients.filter((c) => !c.remote)] : clients;
  join(order[0]);
  const deliverOne = () => {
    const links = clients.flatMap((c) => [c.up.length ? [c, 'up'] : null, c.down.length ? [c, 'down'] : null]).filter(Boolean);
    if (!links.length) return false;
    const [c, dir] = r.pick(links);
    if (dir === 'up') toServer(c, c.up.shift()); else toClient(c, c.down.shift());
    return true;
  };
  const settle = () => new Promise((res) => setImmediate(res));
  return (async () => {
    for (let step = 0; step < steps; step++) {
      const roll = r.next();
      const joined = clients.filter((x) => x.joined);
      if (roll < 0.04) { const c = r.pick(clients.filter((x) => !x.joined)); if (c) join(c); }
      else if (roll < 0.40) { const c = r.pick(joined); if (c) edit(c); }
      else if (roll < 0.43) { const c = r.pick(joined); if (c) close(c); }
      else if (roll < 0.44) { const c = r.pick(clients); drop(c); }
      else if (roll < 0.48 && pending.length) { finishLoad(); await settle(); }
      else deliverOne();
    }
    for (let guard = 0; guard < 200000; guard++) {
      if (pending.length) { while (pending.length) finishLoad(); await settle(); }
      if (!deliverOne() && !pending.length) break;
    }
    const shared = docs.textOf(PATH);
    const holders = clients.filter((c) => c.joined && !c.bad);
    const off = [];
    for (const c of holders) {
      if (c.state.joining !== undefined) off.push(`${c.id} still joining`);
      else if (c.state.sent || c.state.buffer.length) off.push(`${c.id} has unconfirmed edits`);
      else if (shared && (c.text !== shared.text || c.eol !== shared.eol)) off.push(`${c.id} has ${S(c.text.slice(0, 30))} ${S(c.eol)}`);
      else if (shared && !c.state.shared) off.push(`${c.id} does not share the shared document`);
    }
    if (!shared && clients.filter((c) => c.joined).length > 1) off.push(`${clients.filter((c) => c.joined).length} holders and no shared text`);
    if (!shared && clients.some((c) => c.joined && c.remote)) off.push('a guest holds a document the host has no text of');
    // everyone leaves: nothing stays behind
    for (const c of clients) docs.leaveAll(c.id);
    if (docs.size) off.push(`${docs.size} documents left after everyone left`);
    return { shared, off: [...off, ...problems] };
  })();
}

// ---------- convergence ----------
// Most seeds: two windows and three guests. Every 5th: the guests open the file first; every 3rd: a small size limit
// for guests' edits; every 7th: windows only, as without a collaboration session; every 10th: four times as long.
const SEEDS = Number(process.env.COLLAB_SEEDS || 5000);
const started = Date.now();
const bad = [];
let steps = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const opts = { guestFirst: seed % 5 === 0, maxText: seed % 3 === 0 ? 120 : undefined, guests: seed % 7 === 0 ? 0 : 3, steps: seed % 10 === 0 ? 1600 : 400 };
  steps += opts.steps;
  const { shared, off } = await simulate(seed, opts);
  if (off.length) bad.push({ seed, ...opts, host: shared?.text.slice(0, 30), off: off.slice(0, 3) });
}
const secs = ((Date.now() - started) / 1000).toFixed(1);
check(!bad.length, `windows and guests editing, closing, reopening and dropping end with one text and separator, and nothing waiting (${SEEDS} seeds, ${steps} steps, ${secs} s; ${S(stats)}${bad.length ? `; ${bad.length} seeds failed, first: ${S(bad.slice(0, 3))}` : ''})`);

// ---------- the host's documents, step by step ----------
const tick = () => new Promise((res) => setImmediate(res));
const recorder = () => { const got = []; const fn = (ch, m) => got.push([ch, m]); fn.got = got; fn.chans = () => got.map(([ch]) => ch); return fn; };
{
  const docs = createSharedDocs({ keyOf, load: async () => ({ text: 'print(1)\n', eol: '\n' }) });
  const g = recorder();
  const w = recorder();
  await docs.join('g', PATH, g, { remote: true, ticket: 7 });
  check(g.got[0]?.[0] === 'doc:synced' && g.got[0][1].text === 'print(1)\n' && g.got[0][1].shared === true && g.got[0][1].ticket === 7, `a guest who opens a file no window has gets it from the disk (${S(g.got[0])})`);
  docs.op('g', { path: PATH, base: 0, ops: [{ c: [{ at: 0, del: 0, ins: '# ' }] }] });
  await docs.join(1, PATH, w, { ticket: 1 });
  check(w.got[0]?.[1].text === '# print(1)\n' && w.got[0][1].rev === 1, 'a window opening it later gets the guest\'s edit');
  docs.leave('g', PATH);
  check(w.chans().includes('doc:unshared') && docs.textOf(PATH) === null, 'when the guest leaves, the window has the document alone again');
  const late = recorder();
  await docs.join('g2', PATH, late, { remote: true, ticket: 3 });
  check(w.got.at(-1)[0] === 'doc:share', 'a guest joining a window\'s document asks that window for its text');
  docs.snapshot(1, { path: PATH, rev: 1, text: '# print(1)\n', eol: '\n' });
  check(late.got[0]?.[1].text === '# print(1)\n', 'and gets it');
  docs.leave(1, PATH);
  check(docs.textOf(PATH)?.text === '# print(1)\n', 'the window closing leaves the guest\'s document shared (its text is the host\'s now)');
  const failing = createSharedDocs({ keyOf: (p) => p, load: async () => { throw new Error('ENOENT'); } });
  const f = recorder();
  await failing.join('g', 'x', f, { remote: true });
  check(f.got[0]?.[0] === 'doc:failed' && failing.size === 0, 'a file that cannot be read tells the guest and leaves nothing behind');
}
{
  // finding: a holder asked twice. A window that opens, closes and opens the document again before the holder answers
  // asks once; the holder's second answer would have rewound the host's text and revision.
  const docs = createSharedDocs({ keyOf: (p) => p });
  const w1 = recorder();
  const w2 = recorder();
  docs.join(1, 'a', w1, { ticket: 1 });
  docs.join(2, 'a', w2, { ticket: 1 });
  docs.leave(2, 'a');
  docs.join(2, 'a', w2, { ticket: 2 });
  check(w1.chans().filter((c) => c === 'doc:share').length === 1, `a holder is asked once while its answer is on its way (${S(w1.chans())})`);
  docs.snapshot(1, { path: 'a', rev: 0, text: 'hello\n', eol: '\n' });
  docs.op(1, { path: 'a', base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'A' }] }] });
  docs.snapshot(1, { path: 'a', rev: 0, text: 'hello\n', eol: '\n' });
  check(S(docs.textOf('a')) === S({ text: 'Ahello\n', eol: '\n', rev: 1 }), `a second answer does not rewind the shared text (${S(docs.textOf('a'))})`);
  // an answer no one waits for any more: the holder is told it is alone again, else its edits wait for confirmations
  const d2 = createSharedDocs({ keyOf: (p) => p });
  const a = recorder();
  d2.join(1, 'b', a, { ticket: 5 });
  d2.join(2, 'b', () => {}, { ticket: 1 });
  d2.leave(2, 'b');
  d2.snapshot(1, { path: 'b', rev: 0, text: 'x', eol: '\n' });
  check(a.got.at(-1)?.[0] === 'doc:unshared' && a.got.at(-1)[1].ticket === 5 && d2.textOf('b') === null, `an answer no one waits for tells the holder it is alone (${S(a.chans())})`);
}
{
  // finding: a window waiting on a guest's disk load. The guest leaves mid-load, or the load fails.
  let release;
  const docs = createSharedDocs({ keyOf: (p) => p, load: () => new Promise((res) => { release = () => res({ text: 'disk\n', eol: '\n' }); }) });
  const w = recorder();
  const p = docs.join('g', 'a', () => {}, { remote: true });
  docs.join('w', 'a', w, { ticket: 4 });
  docs.leave('g', 'a');
  release?.();
  await p;
  await tick();
  const synced = w.got.find(([ch]) => ch === 'doc:synced');
  check(synced?.[1].ticket === 4 && (synced[1].shared === false || synced[1].text === 'disk\n'), `a window waiting on a guest's load gets the document when the guest leaves mid-load (${S(w.chans())})`);
  const w2 = recorder();
  docs.join('w2', 'a', w2, { ticket: 1 });
  check(w2.chans().includes('doc:synced') || w.chans().at(-1) === 'doc:share', `and a second window then joins it (${S(w2.chans())} ${S(w.chans())})`);

  let fail;
  const d2 = createSharedDocs({ keyOf: (p) => p, load: () => new Promise((_res, rej) => { fail = () => rej(new Error('EACCES')); }) });
  const g = recorder();
  const ww = recorder();
  const p2 = d2.join('g', 'a', g, { remote: true, ticket: 9 });
  d2.join('w', 'a', ww, { ticket: 2 });
  fail?.();
  await p2;
  await tick();
  check(g.got[0]?.[0] === 'doc:failed' && g.got[0][1].ticket === 9 && ww.got[0]?.[0] === 'doc:synced' && ww.got[0][1].shared === false && ww.got[0][1].ticket === 2,
    `a failed load tells the guest and gives the waiting window the document as its own (${S(g.chans())} ${S(ww.got)})`);
}
{
  // finding: a guest promoted or asked. The window holding the document closes before it answers a guest's join.
  const docs = createSharedDocs({ keyOf: (p) => p, load: async () => ({ text: 'disk\n', eol: '\n' }) });
  const w = recorder();
  const g = recorder();
  docs.join('w', 'a', w, { ticket: 1 });
  docs.join('g', 'a', g, { remote: true, ticket: 2 });
  docs.leave('w', 'a');
  await tick();
  check(g.got.length === 1 && g.got[0][0] === 'doc:synced' && g.got[0][1].text === 'disk\n' && g.got[0][1].shared === true,
    `a guest whose holder left gets the file from the disk, not the document as its own (${S(g.got)})`);
  const w2 = recorder();
  docs.join('w2', 'a', w2, { ticket: 3 });
  check(w2.got[0]?.[1].text === 'disk\n' && !g.chans().includes('doc:share'), `a guest is never asked for the text (${S(g.chans())})`);
}
{
  // finding: messages of an earlier join. Every message the host sends a holder carries the ticket of its join, and
  // a client takes only those of its current join.
  const docs = createSharedDocs({ keyOf: (p) => p });
  const w1 = recorder();
  const w2 = recorder();
  docs.join(1, 'a', w1, { ticket: 11 });
  docs.join(2, 'a', w2, { ticket: 21 });
  docs.snapshot(1, { path: 'a', rev: 0, text: 'x', eol: '\n' });
  docs.op(2, { path: 'a', base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'y' }] }] });
  docs.op(1, { path: 'a', base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'z' }] }] });
  docs.leave(2, 'a');
  const all = [...w1.got.map(([ch, m]) => [ch, m.ticket, 11]), ...w2.got.map(([ch, m]) => [ch, m.ticket, 21])];
  check(all.length >= 6 && all.every(([, t, want]) => t === want), `every message carries its holder's ticket (${S(all)})`);
  const s = OT.newClient();
  s.ticket = 2;
  s.joining = 'abc';
  const old = { ticket: 1 };
  const shareOld = OT.share(s, old);
  const unsharedOld = OT.unshared ? OT.unshared(s, old) : { ...OT.newClient(), rev: s.rev };
  const nackOld = OT.nack({ ...s, shared: true, sent: [{ c: [] }] }, old);
  const remoteOld = OT.remote({ ...s, shared: true }, { ...old, rev: 1, ops: [{ c: [{ at: 0, del: 0, ins: 'q' }] }] });
  check(shareOld === false && unsharedOld.joining === 'abc' && nackOld === null && remoteOld.apply === null,
    `a client ignores doc:share, doc:unshared, doc:nack and doc:op of an earlier join (${S({ shareOld, unsharedOld, nackOld, remoteOld })})`);
  const st = OT.synced(s, { rev: 3, shared: true, text: 'abc', eol: '\n', ticket: 2 }, 'abc').state;
  const after = OT.unshared ? OT.unshared(st, { ticket: 2 }) : { ...OT.newClient(), rev: st.rev };
  check(st.ticket === 2 && after.ticket === 2 && after.rev === 3, `the ticket stays through doc:synced and doc:unshared (${S({ st, after })})`);
}

{
  // diffOp (doc:synced, and the editor's applyText) compared code units: 😀 to 🐍 changed only the second half of a pair
  const ops = [['a😀b', 'a🐍b'], ['😀', '😀😀'], ['x🐍', 'x😀']].map(([a, b]) => [a, b, OT.diffOp(a, b)]);
  check(ops.every(([a, b, op]) => OT.applyText(a, [op]) === b && op.c.every((c) => !inPair(a, c.at) && !inPair(a, c.at + c.del) && c.ins.isWellFormed())),
    `the change from one text to another does not cut a character in two (${S(ops.map(([, , op]) => op))})`);
}

// ---------- a guest's ops against the host's text ----------
{
  const run = (text, ops, opts = {}) => {
    const docs = createSharedDocs({ keyOf: (p) => p, load: async () => ({ text, eol: '\n' }), ...opts });
    const g = recorder();
    const w = recorder();
    return (async () => {
      await docs.join('g', 'a', g, { remote: true, ticket: 1 });
      await docs.join('w', 'a', w, { ticket: 1 });
      docs.op(opts.from || 'g', { path: 'a', base: 0, ops });
      return { refused: g.chans().includes('doc:failed'), text: docs.textOf('a')?.text, applied: w.chans().includes('doc:op') };
    })();
  };
  const emoji = 'a😀b';
  const cases = {
    'a bare CR': [emoji, [{ c: [{ at: 0, del: 0, ins: 'x\ry' }] }]],
    'a CRLF': [emoji, [{ c: [{ at: 0, del: 0, ins: 'x\r\ny' }] }]],
    'a lone high surrogate': [emoji, [{ c: [{ at: 0, del: 0, ins: '\uD83D' }] }]],
    'a lone low surrogate': [emoji, [{ c: [{ at: 0, del: 0, ins: 'q\uDE00' }] }]],
    'an insertion inside a pair': [emoji, [{ c: [{ at: 2, del: 0, ins: 'Z' }] }]],
    'a deletion ending inside a pair': [emoji, [{ c: [{ at: 0, del: 2, ins: '' }] }]],
    'a deletion starting inside a pair': [emoji, [{ c: [{ at: 2, del: 2, ins: '' }] }]],
    'a change past the end': [emoji, [{ c: [{ at: 5, del: 0, ins: 'Q' }] }]],
    'a deletion past the end': [emoji, [{ c: [{ at: 3, del: 5, ins: '' }] }]],
    'a second op past the end of the first': [emoji, [{ c: [{ at: 0, del: 4, ins: '' }] }, { c: [{ at: 1, del: 0, ins: 'Q' }] }]],
  };
  const got = {};
  for (const [name, [text, ops]] of Object.entries(cases)) {
    const res = await run(text, ops);
    got[name] = res.refused && !res.applied && res.text === undefined ? 'refused' : `taken: ${S(res.text)}`;
  }
  check(Object.values(got).every((v) => v === 'refused'), `a guest's op Monaco would apply differently is refused and the guest is out of the document (${S(got)})`);
  const fine = await run(emoji, [{ c: [{ at: 1, del: 2, ins: '🐍\n' }, { at: 4, del: 0, ins: '!' }] }, { c: [], eol: '\r\n' }]);
  check(!fine.refused && fine.applied && fine.text === 'a🐍\nb!', `a guest's op with whole pairs and line breaks is taken (${S(fine)})`);
  const big = await run('abc', [{ c: [{ at: 3, del: 0, ins: 'x'.repeat(200) }] }], { maxText: 100 });
  const shrink = await run('x'.repeat(300), [{ c: [{ at: 0, del: 10, ins: 'y' }] }], { maxText: 100 });
  const window = await run('abc', [{ c: [{ at: 3, del: 0, ins: 'x'.repeat(200) }] }], { maxText: 100, from: 'w' });
  check(big.refused && !big.applied && !shrink.refused && shrink.applied && window.applied,
    `a guest cannot grow a shared document past the limit; shrinking one and a window's edits are taken (${S({ big, shrink: shrink.refused, window: window.applied })})`);
}

// ---------- the disk load of a guest's document ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-load-'));
  const put = (name, data) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  const load = SD.loadFromDisk;
  const res = async (p) => { try { return await load(p); } catch (e) { return { error: e.code, message: e.message }; } };
  if (typeof load !== 'function') check(false, 'main/shared-docs.js exports the disk load main/windows.js uses (loadFromDisk)');
  else {
    const mostlyLf = await res(put('lf.py', 'a\nb\nc\nd\r\n'));
    const cr = await res(put('cr.py', 'a\rb\rc\r'));
    const crlf = await res(put('crlf.py', 'a\r\nb\r\n'));
    check(mostlyLf.eol === '\n' && cr.eol === '\r\n' && cr.text === 'a\nb\nc\n' && crlf.eol === '\r\n',
      `the separator is the most frequent one, as the editor's, and a CR file is CRLF as in its Monaco model (${S({ mostlyLf, cr, crlf })})`);
    const binary = await res(put('b.bin', Buffer.from([0, 1, 2, 0, 0, 255, 0, 3])));
    check(binary.error === 'binary' && /binary/i.test(binary.message), `a binary file is refused with a clear error (${S(binary)})`);
    const fd = fs.openSync(path.join(dir, 'huge.txt'), 'w');
    fs.ftruncateSync(fd, 21 * 1024 * 1024);
    fs.closeSync(fd);
    const huge = await res(path.join(dir, 'huge.txt'));
    check(huge.error === 'tooLarge' && /large/i.test(huge.message), `a file over the editor's size limit is refused with a clear error (${S(huge)})`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- framing ----------
{
  const msgs = [{ type: 'hello', name: '민지', version: '0.3.20' }, { type: 'chat', text: 'x'.repeat(40000) }, { type: 'bye' }];
  const wire = Buffer.concat(msgs.map(P.encode));
  const out = [];
  const errs = [];
  const feed = P.decoder((m) => out.push(m), (e) => errs.push(e));
  for (let i = 0; i < wire.length; i += 7) feed(wire.subarray(i, i + 7));
  check(S(out) === S(msgs) && !errs.length, 'messages split into 7-byte pieces arrive whole and in order');
  const big = [];
  const fb = P.decoder(() => {}, (e) => big.push(e.code));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(P.MAX_MESSAGE + 1, 0);
  fb(head);
  fb(P.encode({ type: 'bye' }));
  check(S(big) === '["tooLarge"]', 'a length over the limit ends the stream without waiting for the bytes');
  const junk = [];
  const fj = P.decoder(() => {}, (e) => junk.push(e.code));
  const j = Buffer.from('{nope');
  const h2 = Buffer.alloc(4);
  h2.writeUInt32BE(j.length, 0);
  fj(Buffer.concat([h2, j]));
  check(S(junk) === '["badMessage"]', 'text that is not JSON ends the stream');
  // finding: a large message in small records took time quadratic in its size (8 MB in 1 KB records: 7 s)
  const huge = P.encode({ type: 'chat', text: 'x'.repeat(P.MAX_MESSAGE - 40) });
  let n = 0;
  const fh = P.decoder(() => n++, () => {});
  const t0 = Date.now();
  for (let i = 0; i < huge.length; i += 1024) fh(huge.subarray(i, i + 1024));
  const ms = Date.now() - t0;
  check(n === 1 && ms < 2000, `an 8 MB message in 1 KB records is read in linear time (${ms} ms)`);
  // a caller that reuses its buffer for the next record does not change the bytes still queued
  const reused = [];
  const fr = P.decoder((m) => reused.push(m), (e) => reused.push(e.code));
  const one = P.encode({ type: 'bye' });
  const scratch = Buffer.alloc(one.length);
  one.copy(scratch, 0, 0, 6);
  fr(scratch.subarray(0, 6));
  scratch.fill(0x41);
  one.copy(scratch, 0, 6);
  fr(scratch.subarray(0, one.length - 6));
  check(S(reused) === S([{ type: 'bye' }]), `bytes kept between records are a copy (${S(reused)})`);
}

// ---------- guest messages ----------
{
  const ok = [
    { type: 'hello', name: '민지', version: '0.3.20' },
    { type: 'doc:op', path: 'a.py', base: 3, ops: [{ c: [{ at: 0, del: 1, ins: 'x' }, { at: 5, del: 0, ins: 'y' }] }] },
    { type: 'cursor', path: 'a.py', ranges: [[1, 4]] },
  ];
  const no = [
    null, [], { type: 'exec', cmd: 'calc' }, { type: 'doc:op', path: 'a.py', base: -1, ops: [] },
    { type: 'doc:op', path: 'a.py', base: 0, ops: [{ c: [{ at: 5, del: 0, ins: 'a' }, { at: 2, del: 0, ins: 'b' }] }] },
    { type: 'doc:op', path: 'a.py', base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'z'.repeat(2 * 1024 * 1024) }] }] },
    { type: 'doc:op', path: 'a.py', base: 0, ops: [{ c: [], eol: '\r' }] },
    { type: 'hello', name: 'x'.repeat(65), version: '1' },
  ];
  check(ok.every((m) => P.checkGuest(m) === null), 'well-formed guest messages pass');
  const why = no.map((m) => P.checkGuest(m));
  check(why.every(Boolean), `unknown types, unsorted or huge ops, bad separators and long names are refused (${S(why)})`);
  // finding: Object.prototype's names were types (constructor, toString passed; __proto__ threw mid-chunk)
  const protoNames = ['constructor', 'toString', 'toLocaleString', '__proto__', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf'];
  const proto = protoNames.map((type) => { try { return P.checkGuest(JSON.parse(`{"type":"${type}"}`)) ? 'refused' : 'ACCEPTED'; } catch (e) { return `throws ${e.message}`; } });
  const nonString = [{ type: ['bye'] }, { type: { toString: () => 'bye' } }, { type: 1 }].map((m) => { try { return P.checkGuest(m) ? 'refused' : 'ACCEPTED'; } catch (e) { return `throws ${e.message}`; } });
  check([...proto, ...nonString].every((v) => v === 'refused'), `Object.prototype's names and types that are not strings are refused without throwing (${S({ proto, nonString })})`);
}

// ---------- guest paths ----------
{
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-core-')));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', 'a.py'), 'x');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  const res = (rel) => { try { return P.resolveGuest(root, rel); } catch (e) { return e.code; } };
  check(res('pkg/a.py') === path.join(root, 'pkg', 'a.py') && res('pkg\\a.py') === path.join(root, 'pkg', 'a.py'), 'a project path with / or \\ resolves under the project');
  const refused = ['..\\..\\Windows\\win.ini', 'pkg/../../x', 'C:\\Windows', 'c:x', '/etc/passwd', '\\\\server\\share\\x', 'a.py:hidden', 'notes.', 'con', 'aux.txt', 'pkg/\u0001x', ''];
  const got = refused.map(res);
  check(got.every((g) => g === 'badPath'), `paths that leave the project or that Windows changes are refused (${S(got)})`);
  const hid = ['.env', '.env.local', 'pkg/server.key', 'cert.pem', '.git/config', 'sub/.git/HEAD', '.ssh/id_rsa'].map(res);
  check(hid.every((g) => g === 'hidden') && res('envelope.py') !== 'hidden' && res('pkg/key.py') !== 'hidden', `secrets and .git are not shared (${S(hid)})`);
  check(P.relOf(root, path.join(root, 'pkg', 'a.py')) === 'pkg/a.py' && P.relOf(root, outside) === null && P.relOf(root, path.join(root, '..x')) === '..x', 'relOf gives project paths with / and nothing outside');
  check(await P.realUnder(root, path.join(root, 'pkg', 'a.py')), 'a file of the project is under its real path');
  // finding: 8.3 short names reached hidden files (ENV~1 is .env, GIT~1 is .git)
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=2');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'url=token');
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_ed25519'), 'key');
  const real = async (rel) => {
    if (typeof P.realGuest === 'function') { try { return await P.realGuest(root, rel); } catch (e) { return e.code; } }
    try { const abs = P.resolveGuest(root, rel); return (await P.realUnder(root, abs)) ? `READS ${fs.readFileSync(abs, 'utf8')}` : 'badPath'; } catch (e) { return e.code; }
  };
  const short = {};
  for (const rel of ['ENV~1', 'env~1.loc', 'GIT~1/config', 'SSH~1/id_ed25519']) short[rel] = await real(rel);
  check(Object.values(short).every((v) => v === 'badPath' || v === 'hidden'), `8.3 short names of hidden files are refused (${S(short)})`);
  check(await real('pkg/a.py') === path.join(root, 'pkg', 'a.py'), 'a project file resolves to its real path');
  let linked = false;
  try { execFileSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'out'), outside], { stdio: 'ignore' }); linked = true; } catch {}
  try { execFileSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'repo'), path.join(root, '.git')], { stdio: 'ignore' }); } catch { linked = false; }
  if (linked) {
    const viaLink = P.resolveGuest(root, 'out/secret.txt');
    check(!(await P.realUnder(root, viaLink)) && ['badPath', 'hidden'].includes(await real('out/secret.txt')), 'a file reached through a junction to outside is not under the project');
    const toGit = await real('repo/config');
    check(toGit === 'hidden', `a hidden file reached through a junction inside the project is refused (${S(toGit)})`);
    fs.rmdirSync(path.join(root, 'out'));
    fs.rmdirSync(path.join(root, 'repo'));
  } else check(false, 'junctions to test with');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
