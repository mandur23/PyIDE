// Undo and redo of one's own edits in a shared document (renderer/core/ot.js newHistory, record, rebase, take), without
// the app: main/shared-docs.js numbers the edits, and two or three clients, each answering as renderer/core/editors.js
// does, type, delete, replace, switch line separators, undo and redo, while messages to and from the host arrive at
// random moments. Each client types only its own letters, so it can be told whose text an undo removes. Checks:
// - every client ends with the host's text and separator;
// - an undo never deletes a letter another client typed;
// - once a client has undone everything it did, none of its letters is left anywhere;
// - with one client editing (the others watching), undoing everything gives the original text back in every client,
//   and redoing everything gives back the text from before the undos.
// Seeded, so a failure names its seed. Usage: node verify/ot-undo.mjs   (UNDO_SEEDS=n for another number of seeds)
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const OT = require('../renderer/core/ot.js');
const { createSharedDocs } = require('../main/shared-docs.js');

let passed = 0;
let failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const ORIGINAL = 'def f(x):\n    return x\n\nprint(f(1))\n';
const ALPHABETS = ['ABCDEFGHIJ', 'abcdefghij', '0123456789'];
const PATH = 'C:\\proj\\a.py';

// One session: n clients, `steps` actions. mode 'all': every client edits, undoes and redoes; 'typing': every client
// edits, only the first undoes and redoes; 'first': the first edits, the others watch.
function session(seed, n, steps, mode) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const docs = createSharedDocs({ keyOf: (p) => p.toLowerCase() });
  const problems = [];
  const toHost = []; // [client, kind, msg]
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = { id: i, text: i === 0 ? ORIGINAL : '', eol: '\n', sync: OT.newClient(), hist: null, inbox: [], letters: ALPHABETS[i], ticket: 0 };
    clients.push(c);
  }
  const active = mode === 'first' ? [clients[0]] : clients;
  const otherLetters = (c) => new RegExp(`[${clients.filter((o) => o !== c).map((o) => o.letters).join('')}]`);
  const send = (c, kind, msg) => toHost.push([c, kind, { path: PATH, ...msg }]);
  const sendOps = (c, m) => { if (m) send(c, 'op', m); };
  function startHistory(c) { if (!c.hist) c.hist = OT.newHistory(); }
  // The editor's local edit: applied, recorded, sent.
  function local(c, op, { into = 'undo', join = false, caret } = {}) {
    const before = c.text;
    const eolBefore = c.eol;
    c.text = OT.applyText(before, [op]);
    if (op.eol) c.eol = op.eol;
    if (c.hist) {
      OT.record(c.hist, op, before, eolBefore, { into, join, caret });
      if (into === 'undo' && !c.undoing) c.hist.redo = [];
    }
    sendOps(c, OT.local(c.sync, op));
  }
  function remote(c, ops) {
    for (const op of ops) {
      c.text = OT.applyText(c.text, [op]);
      if (op.eol) c.eol = op.eol;
      if (c.hist) OT.rebase(c.hist, op);
    }
  }
  const HANDLE = {
    'doc:synced'(c, msg) {
      const r = OT.synced(c.sync, msg, c.text);
      c.sync = r.state;
      if (r.state.shared) startHistory(c);
      if (r.apply) remote(c, r.apply);
      if (msg.eol && r.apply) c.eol = r.apply.reduce((e, op) => op.eol || e, c.eol);
      sendOps(c, r.send);
    },
    'doc:share'(c, msg) {
      if (!OT.share(c.sync, msg)) return;
      startHistory(c);
      send(c, 'snapshot', { rev: c.sync.rev, text: c.text, eol: c.eol });
    },
    'doc:unshared'(c, msg) { c.sync = OT.unshared(c.sync, msg); },
    'doc:op'(c, msg) {
      const r = OT.remote(c.sync, msg);
      if (r.apply) remote(c, r.apply);
      sendOps(c, r.send);
    },
    'doc:nack'(c, msg) { sendOps(c, OT.nack(c.sync, msg)); },
  };
  const sender = (c) => (channel, msg) => c.inbox.push([channel, msg]);
  const deliverToHost = () => {
    const [c, kind, msg] = toHost.shift();
    if (kind === 'op') docs.op(c.id, msg);
    else if (kind === 'snapshot') docs.snapshot(c.id, msg);
  };
  const deliverToClient = (c) => { const [channel, msg] = c.inbox.shift(); HANDLE[channel](c, msg); };
  function deliverAll() {
    for (let guard = 0; guard < 1e6; guard++) {
      if (toHost.length) { deliverToHost(); continue; }
      const c = clients.find((x) => x.inbox.length);
      if (!c) return;
      deliverToClient(c);
    }
    problems.push('messages never settled');
  }
  // A random edit of c's own: insert its letters, delete a range, replace, a few changes at once, or a separator switch.
  function randomOp(c) {
    const t = c.text;
    const r = rand();
    if (r < 0.05) return { c: [], eol: c.eol === '\n' ? '\r\n' : '\n' };
    const word = () => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick([...c.letters, '\n', ' '])).join('');
    const at = Math.floor(rand() * (t.length + 1));
    if (r < 0.5 || !t.length) return { c: [{ at, del: 0, ins: word() }] };
    const del = Math.min(t.length - Math.min(at, t.length - 1), 1 + Math.floor(rand() * 5));
    const from = Math.min(at, t.length - 1);
    if (r < 0.75) return { c: [{ at: from, del, ins: '' }] };
    if (r < 0.9) return { c: [{ at: from, del, ins: word() }] };
    const a = Math.floor(rand() * t.length);
    const b = a + 1 + Math.floor(rand() * Math.max(1, t.length - a));
    return b <= t.length ? { c: [{ at: a, del: 0, ins: word() }, { at: b, del: 0, ins: word() }] } : { c: [{ at: a, del: 0, ins: word() }] };
  }
  function undo(c, kind) {
    if (!c.hist) return false;
    const g = OT.take(c.hist, kind);
    if (!g) return false;
    c.undoing = true;
    const into = kind === 'undo' ? 'redo' : 'undo';
    g.ops.forEach((op, k) => {
      if (kind === 'undo') {
        const others = otherLetters(c);
        let shift = 0;
        for (const x of op.c) {
          const gone = c.text.slice(x.at, x.at + x.del);
          if (others.test(gone)) problems.push(`client ${c.id}'s undo deleted another's ${JSON.stringify(gone)}`);
          shift += x.ins.length - x.del;
        }
      }
      local(c, op, { into, join: k > 0, caret: 0 });
    });
    c.undoing = false;
    return true;
  }

  // Everyone joins (the first one alone, the others get its text).
  for (const c of clients) docs.join(c.id, PATH, sender(c), { ticket: c.sync.ticket = ++c.ticket });
  for (const c of clients) c.sync.joining = c.text;
  deliverAll();
  for (let s = 0; s < steps; s++) {
    const r = rand();
    if (r < 0.35 && toHost.length) { deliverToHost(); continue; }
    if (r < 0.6) {
      const waiting = clients.filter((x) => x.inbox.length);
      if (waiting.length) { deliverToClient(pick(waiting)); continue; }
    }
    const c = pick(active);
    if (!c.hist) continue;
    const a = mode === 'typing' && c !== clients[0] ? 0 : rand();
    if (a < 0.6) local(c, randomOp(c), { join: rand() < 0.5 });
    else if (a < 0.85) undo(c, 'undo');
    else undo(c, 'redo');
  }
  deliverAll();
  return { clients, docs, problems, deliverAll, undo, host: () => docs.textOf(PATH) };
}

const SEEDS = Number(process.env.UNDO_SEEDS) || 400;
const converged = (s) => {
  const h = s.host();
  return !!h && s.clients.every((c) => c.text === h.text && c.eol === h.eol);
};

// Several clients editing, undoing and redoing at once; then the first undoes everything it did. Text another client
// brought back with its own undo is that client's edit, so the check for leftovers runs where the others only type.
{
  let apart = null;
  let deleted = null;
  let left = null;
  for (let seed = 1; seed <= 2 * SEEDS; seed++) {
    const mode = seed > SEEDS ? 'typing' : 'all';
    const s = session(seed, seed % 2 ? 2 : 3, 400, mode);
    if (!converged(s) && !apart) apart = seed;
    const c = s.clients[0];
    while (s.undo(c, 'undo')) s.deliverAll();
    s.deliverAll();
    if (!converged(s) && !apart) apart = seed;
    if (s.problems.length && !deleted) deleted = `${seed}: ${s.problems[0]}`;
    const mine = new RegExp(`[${c.letters}]`);
    if (mode === 'typing' && s.clients.some((x) => mine.test(x.text)) && !left) left = `${seed}: ${JSON.stringify(s.host().text.slice(0, 80))}`;
  }
  check(!apart, `two and three clients editing, undoing and redoing at once end with the host's text (${SEEDS} seeds${apart ? `; seed ${apart} apart` : ''})`);
  check(!deleted, `an undo never deletes text another client typed${deleted ? ` (seed ${deleted})` : ''}`);
  check(!left, `once a client undid everything it did while the others typed, none of its text is left${left ? ` (seed ${left})` : ''}`);
}

// One client editing while the others watch.
{
  let bad = null;
  for (let seed = 1; seed <= SEEDS && !bad; seed++) {
    const s = session(seed + 100000, 2 + (seed % 2), 300, 'first');
    const c = s.clients[0];
    const beforeUndo = c.text;
    let undone = 0;
    while (s.undo(c, 'undo')) { undone++; s.deliverAll(); }
    s.deliverAll();
    if (!s.clients.every((x) => x.text === ORIGINAL)) bad = `seed ${seed}: undoing everything left ${JSON.stringify(c.text.slice(0, 60))}`;
    for (let i = 0; i < undone && !bad; i++) { s.undo(c, 'redo'); s.deliverAll(); }
    s.deliverAll();
    if (!bad && !s.clients.every((x) => x.text === beforeUndo)) bad = `seed ${seed}: redoing everything did not give the text back`;
    if (!bad && s.problems.length) bad = `seed ${seed}: ${s.problems[0]}`;
  }
  check(!bad, `one client editing: undoing everything gives the original text back everywhere, redoing everything the text before (${SEEDS} seeds)${bad ? `: ${bad}` : ''}`);
}

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
