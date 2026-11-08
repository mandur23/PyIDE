// Shared documents: the one order of edits for a file open in several places (windows of this app; remote guests of a
// collaboration session, main/collab). The client side is renderer/core/ot.js.
//
// A document open in one window is that window's alone. Once a second place opens it, this process holds the shared
// text and numbers the edits: an edit made on the current revision is applied and sent to every holder (to its sender as
// the confirmation); one made on an older revision is refused (doc:nack), and its holder sends it again shifted past the
// edits it had not seen yet. One order, so every holder ends with the same text. The text has '\n' for every line
// break, as the ops count them; eol is the document's separator.
//
// A holder is an id and a send(channel, msg). Every message to a holder carries the ticket of its join (renderer/core/
// ot.js forThis), so one sent before it left and joined again is not taken for the new join's.
//
// A remote holder (a guest) has no file of its own: it is never asked for the text nor left with the document as its
// own. When no window holds the document, its text comes from the disk (load), and while a remote holder is in, the
// document stays shared even with one window left, because the guest's text lives here. A guest is untrusted: its
// ops are checked against the text they apply to, and one the editors would apply differently is refused.
const OT = require('../renderer/core/ot.js');

// The longest text a guest's edits may make a shared document (characters): it is sent whole to whoever opens it.
const MAX_REMOTE_TEXT = 4 * 1024 * 1024;

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
const splitsPair = (t, i) => i > 0 && i < t.length && isHigh(t.charCodeAt(i - 1)) && isLow(t.charCodeAt(i));
// A guest's ops applied to the text they were made on -> the text after them, or {refused: why}. Monaco (every editor
// of the document) reads a CR as a line break and moves a position inside a surrogate pair out of it, and the text it
// saves cannot hold a lone surrogate: the host, which applies the op as it is, would end with another text.
function applyRemote(text, ops, maxText) {
  for (const op of ops) {
    for (const c of op.c) {
      if (c.at + c.del > text.length) return { refused: 'a change past the end of the text' };
      if (splitsPair(text, c.at) || splitsPair(text, c.at + c.del)) return { refused: 'a change inside a character' };
      if (c.ins.includes('\r')) return { refused: 'a CR in new text' };
      if (!c.ins.isWellFormed()) return { refused: 'a lone surrogate in new text' };
    }
    const before = text.length;
    text = OT.applyText(text, [op]);
    if (text.length > maxText && text.length > before) return { refused: 'the document would be too large', code: 'tooLarge' };
  }
  return { text };
}

function createSharedDocs({ keyOf, load = null, maxText = MAX_REMOTE_TEXT }) {
  // key -> {path, holders: Set, waiting: Set, remote: Set, tickets: Map, asked: holder id | null, loading, rev,
  // text | null, eol}. asked: the holder asked for the text (doc:share), one at a time; loading: the disk is being read.
  const docs = new Map();
  const senders = new Map(); // holder id -> send(channel, msg)
  const send = (s, id, channel, msg) => senders.get(id)?.(channel, { path: s.path, ...msg, ticket: s.tickets.get(id) });

  function give(s, id) {
    s.holders.add(id);
    send(s, id, 'doc:synced', { rev: s.rev, text: s.text, eol: s.eol, shared: true });
  }
  function giveWaiting(s) {
    for (const w of [...s.waiting]) { s.waiting.delete(w); give(s, w); }
  }
  // Those waiting get the text: from the window holding the document (asked once until it answers or leaves), else a
  // waiting window takes the document as its own and is asked, else (only guests wait) from the disk.
  function askHolder(s) {
    if (s.asked !== null || s.loading || !s.waiting.size) return;
    if (s.text !== null) return giveWaiting(s);
    const holder = [...s.holders].find((h) => !s.remote.has(h));
    if (holder !== undefined) {
      s.asked = holder;
      return send(s, holder, 'doc:share', {});
    }
    const first = [...s.waiting].find((w) => !s.remote.has(w));
    if (first === undefined) return loadFor(s);
    s.waiting.delete(first);
    s.holders.add(first);
    send(s, first, 'doc:synced', { rev: s.rev, shared: false });
    return askHolder(s);
  }
  async function loadFor(s) {
    const k = keyOf(s.path);
    s.loading = true;
    let file;
    let error;
    try { file = await load(s.path); } catch (err) { error = err; }
    if (docs.get(k) !== s) return;
    s.loading = false;
    if (error) {
      // The guests waiting are told; the windows waiting, if any, have their own text.
      for (const g of [...s.waiting].filter((w) => s.remote.has(w))) {
        send(s, g, 'doc:failed', { error: String(error?.message || error), code: error?.code });
        forget(s, g);
      }
      if (!s.waiting.size && !s.holders.size) return void docs.delete(k);
      return askHolder(s);
    }
    if (s.text === null) Object.assign(s, { text: OT.lfText(file.text), eol: file.eol || '\n' });
    giveWaiting(s);
    alone(s);
  }
  // One window left and no guest: it keeps its own text and stops sending edits.
  function alone(s) {
    if (s.holders.size !== 1 || s.waiting.size || s.text === null || s.remote.size) return;
    s.text = null;
    const [last] = s.holders;
    send(s, last, 'doc:unshared', {});
  }
  function forget(s, id) {
    s.holders.delete(id);
    s.waiting.delete(id);
    s.remote.delete(id);
    s.tickets.delete(id);
    if (s.asked === id) s.asked = null;
  }

  // A holder joins only with a new document; one it held before went with its page (a reload), so it joins afresh and
  // always gets its doc:synced.
  // ticket: the holder's number for this join, which every message for it carries back.
  async function join(id, path, sender, { remote = false, ticket } = {}) {
    senders.set(id, sender);
    const k = keyOf(path);
    if (docs.get(k)?.holders.has(id) || docs.get(k)?.waiting.has(id)) leave(id, path);
    const s = docs.get(k) || docs.set(k, { path, holders: new Set(), waiting: new Set(), remote: new Set(), tickets: new Map(), asked: null, loading: false, rev: 0, text: null, eol: '\n' }).get(k);
    if (remote) s.remote.add(id);
    s.tickets.set(id, ticket);
    if (s.text !== null) return give(s, id);
    if (!s.holders.size && !s.waiting.size && !remote) {
      s.holders.add(id);
      return send(s, id, 'doc:synced', { rev: s.rev, shared: false });
    }
    // A guest first reads the file as it is on disk (a window opening it later gets this text, as a second window would).
    s.waiting.add(id);
    return askHolder(s);
  }
  // The holder's answer to doc:share. Only the one asked: a second answer, made after it had shared its edits, would
  // put the host back to an older text and revision.
  function snapshot(id, { path, rev, text, eol }) {
    const s = docs.get(keyOf(path));
    if (!s || s.asked !== id || s.text !== null) return;
    s.asked = null;
    // Those who asked left meanwhile: the holder, which now sends its edits, is alone with the document again.
    if (!s.waiting.size) return void send(s, id, 'doc:unshared', {});
    Object.assign(s, { rev, text, eol });
    giveWaiting(s);
  }
  function op(id, { path, base, ops }) {
    const s = docs.get(keyOf(path));
    if (!s || s.text === null || !s.holders.has(id)) return;
    if (base !== s.rev) return void send(s, id, 'doc:nack', {});
    let next;
    if (s.remote.has(id)) {
      const r = applyRemote(s.text, ops, maxText);
      // The guest's text is no longer the host's: it is out of the document, and may open it again.
      if (r.refused) {
        send(s, id, 'doc:failed', { error: `refused ${r.refused}`, code: r.code || 'badOp' });
        return leave(id, path);
      }
      next = r.text;
    } else next = OT.applyText(s.text, ops);
    s.text = next;
    s.eol = ops.reduce((eol, o) => o.eol || eol, s.eol);
    s.rev++;
    for (const h of s.holders) send(s, h, 'doc:op', { rev: s.rev, ops, mine: h === id });
  }
  function leave(id, path) {
    const k = keyOf(path);
    const s = docs.get(k);
    if (!s || (!s.holders.has(id) && !s.waiting.has(id))) return;
    forget(s, id);
    if (!s.holders.size && !s.waiting.size) return void docs.delete(k);
    if (s.text === null) return askHolder(s);
    alone(s);
  }
  function leaveAll(id) {
    for (const k of [...docs.keys()]) leave(id, docs.get(k).path);
    senders.delete(id);
  }
  // The shared text of a document (as LF) and its revision, or null when no one shares it: what a guest's save writes.
  function textOf(path) {
    const s = docs.get(keyOf(path));
    return s && s.text !== null ? { text: s.text, eol: s.eol, rev: s.rev } : null;
  }
  return { join, snapshot, op, leave, leaveAll, textOf, get size() { return docs.size; } };
}

// A file read for a guest's document no window holds, as the editor reads it (renderer/core/editors.js loadDoc):
// the text as LF and the separator its Monaco model would have, the most frequent one (a CR file's model is CRLF).
// A file the editor would not open as text is refused with a reason the guest can show.
async function loadFromDisk(p) {
  const r = await require('./text-codec').readAsync(p);
  if (r.binary) throw Object.assign(new Error('the file is binary, not text'), { code: 'binary' });
  if (r.tooLarge) throw Object.assign(new Error(`the file is too large to open (${Math.round(r.size / 1048576)} MB)`), { code: 'tooLarge' });
  const found = OT.separatorOf(r.text);
  const eol = found ? (found.sep === '\n' ? '\n' : '\r\n') : (process.platform === 'win32' ? '\r\n' : '\n');
  return { text: OT.lfText(r.text), eol };
}

module.exports = { createSharedDocs, loadFromDisk, MAX_REMOTE_TEXT };
