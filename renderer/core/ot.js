// One document edited from several places at once (operational transformation), with no editor in it: the editor
// (renderer/core/editors.js), the shared documents of the main process (main/shared-docs.js) and the tests use it.
//
// An op is {c: [{at, del, ins}], eol?}: changes sorted by `at`, positions in the text before the op; eol when the op
// switched the line separator. Positions and text count every line break as one '\n', whatever the separator, so a
// conversion ({c: [], eol}) moves nothing and the edits made beside it elsewhere keep their place.
//
// A client (one editor of the document) keeps {rev, shared, sent, buffer, joining, ticket}: the last revision it saw,
// whether the document is shared, the ops it sent and has no answer for, the ops typed since, its text (as LF) when it
// asked to join, and the number of that join. The server numbers ops: one made on its current revision is applied and sent to every client (to its sender
// as the confirmation, `mine`); one made on an older revision is refused (nack) and sent again shifted past the ops the
// client had not seen. So ops typed in several places at the same moment are all kept, everywhere, in one order.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.NanoOT = api;
})(() => {
  const lfText = (s) => s.replace(/\r\n?/g, '\n');
  // The line separator a file's text keeps (renderer/core/editors.js, and the host when it reads a file for a guest):
  // the most frequent one, mixed when there are several. -> {sep: '\n' | '\r\n' | '\r', mixed}, or null with no line
  // break.
  function separatorOf(text) {
    let crlf = 0, lf = 0, cr = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; } else if (c === 10) lf++;
    }
    const kinds = [['\n', lf], ['\r\n', crlf], ['\r', cr]].filter(([, n]) => n);
    if (!kinds.length) return null;
    kinds.sort((a, b) => b[1] - a[1]);
    return { sep: kinds[0][0], mixed: kinds.length > 1 };
  }

  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  // One change that turns text a into text b (both as LF). It does not start or end inside a surrogate pair: 😀 and 🐍
  // share their first half, and Monaco moves a range out of a pair, so the change would not apply as made there.
  function diffOp(a, b) {
    if (a === b) return { c: [] };
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    if (start > 0 && isHigh(a.charCodeAt(start - 1))) start--;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    while (endA < a.length && (isHigh(a.charCodeAt(endA - 1)) || isHigh(b.charCodeAt(endB - 1)))) { endA++; endB++; }
    return { c: [{ at: start, del: endA - start, ins: b.slice(start, endB) }] };
  }

  // `pos` in the text after `op`. after: a point where op inserted text goes behind that text.
  // A point inside a range op replaced lands after op's new text, whatever `after`: every client must agree, and the
  // replacing client puts its text at the start of the range, before what another typed inside it. A point at the
  // start of a replaced range is a tie with op's text and follows `after`.
  function mapPoint(pos, op, after) {
    let shift = 0;
    for (const c of op.c) {
      const end = c.at + c.del;
      if (end < pos || (end === pos && (c.del > 0 || after))) { shift += c.ins.length - c.del; continue; }
      if (c.at < pos) return c.at + shift + c.ins.length;
      if (c.at === pos && after) return pos + shift + c.ins.length;
      break;
    }
    return pos + shift;
  }
  // The parts of [s, e) that `op` left in place, as [start, length] in the text after it: text another client inserted
  // inside a range this one deletes is kept.
  function survivors(s, e, op) {
    const parts = [];
    let x = s;
    for (const c of op.c) {
      if (c.at >= e) break;
      if (c.at + c.del < x) continue;
      if (c.at > x) parts.push([x, c.at]);
      x = Math.max(x, c.at + c.del);
    }
    if (x < e) parts.push([x, e]);
    return parts.map(([p, q]) => [mapPoint(p, op, true), q - p]);
  }
  // Op a made on the same text as op b, moved to apply after b. aFirst: a comes first in the shared order, so at the
  // same point a's insertion goes before b's.
  function over(a, b, aFirst) {
    const out = [];
    const put = (at, del, ins) => {
      const last = out[out.length - 1];
      if (last && last.at + last.del === at) Object.assign(last, { del: last.del + del, ins: last.ins + ins });
      else out.push({ at, del, ins });
    };
    for (const c of a.c) {
      if (!c.del) { put(mapPoint(c.at, b, !aFirst), 0, c.ins); continue; }
      const parts = survivors(c.at, c.at + c.del, b);
      // The new text goes where a plain insertion at the range's start would: the shared order breaks a tie there.
      put(mapPoint(c.at, b, !aFirst), 0, c.ins);
      for (const [p, n] of parts) put(p, n, '');
    }
    const moved = { ...a, c: out.filter((c) => c.del || c.ins) };
    // Both switched the line separator: the one later in the shared order is the one that stays, so the earlier one,
    // moved past it, no longer switches. Kept, two windows that converted at once ended with different separators.
    if (aFirst && b.eol && moved.eol) delete moved.eol;
    return moved;
  }
  // Two op lists made on the same text -> [as after bs, bs after as].
  function xform(as, bs, aFirst) {
    const a = [...as];
    const b2 = bs.map((b) => {
      for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        a[i] = over(ai, b, aFirst);
        b = over(b, ai, !aFirst);
      }
      return b;
    });
    return [a, b2];
  }
  // The text (as LF) after ops.
  const applyText = (text, ops) => ops.reduce((t, op) => {
    let out = '';
    let i = 0;
    for (const c of op.c) { out += t.slice(i, c.at) + c.ins; i = c.at + c.del; }
    return out + t.slice(i);
  }, text);

  // ---------- a client ----------
  // Each step takes the client state and returns what to do: `apply` (ops for the local text, already shifted past
  // what is unconfirmed here) and `send` ({base, ops} to send as this client's ops), either may be null.
  const newClient = () => ({ rev: 0, shared: false, sent: null, buffer: [] });
  // ticket: the number the client joined with, which every message the server sends it for that join carries. A
  // message for an earlier join (the client left the document and opened it again before the message came) is not this
  // join's and changes nothing: taken as this join's, doc:synced put the old text under the new one's, and
  // doc:unshared or doc:share upset the join under way.
  const forThis = (s, msg) => msg.ticket === s.ticket;
  function flush(s) {
    if (!s.shared || s.sent || !s.buffer.length) return null;
    s.sent = s.buffer;
    s.buffer = [];
    return { base: s.rev, ops: s.sent };
  }
  // An op typed here. Alone with the document (not shared, not joining) there is nothing to tell.
  function local(s, op) {
    if (!s.shared && s.joining === undefined) return null;
    s.buffer.push(op);
    return flush(s);
  }
  // Joined: alone with the document (no text: its own stands), or sharing it from `rev` on with the shared text (as LF)
  // and separator. ownText: the local text now (as LF), used when the client did not note it on joining. What was typed
  // meanwhile was made on the text it had when it joined: moved past the difference to the shared text, it is kept and
  // sent. -> {state, apply, send}
  function synced(s, msg, ownText) {
    if (!forThis(s, msg)) return { state: s, apply: null, send: null };
    const { rev, text, eol, shared } = msg;
    const { joining, buffer } = s;
    const next = { ...newClient(), rev, shared, ticket: s.ticket };
    if (text === undefined) return { state: next, apply: null, send: null };
    const [[toShared], typed] = xform([diffOp(joining ?? ownText, text)], buffer, true);
    const ownEol = typed.some((op) => op.eol);
    next.buffer = typed;
    return { state: next, apply: [ownEol ? toShared : { ...toShared, eol }], send: flush(next) };
  }
  // The server's op: the confirmation of this client's (mine), or another's to apply past what is unconfirmed here.
  function remote(s, msg) {
    if (!forThis(s, msg) || !s.shared) return { apply: null, send: null };
    const { rev, ops, mine } = msg;
    s.rev = rev;
    if (mine) { s.sent = null; return { apply: null, send: flush(s) }; }
    let theirs = ops;
    if (s.sent) [theirs, s.sent] = xform(theirs, s.sent, true);
    [theirs, s.buffer] = xform(theirs, s.buffer, true);
    return { apply: theirs, send: null };
  }
  // Refused (another's op came first, and has arrived here since): sent again on top of it.
  function nack(s, msg) {
    if (!forThis(s, msg) || !s.sent) return null;
    s.buffer = [...s.sent, ...s.buffer];
    s.sent = null;
    return flush(s);
  }
  // Another place opened the document: from now on this client sends its ops. -> false for an earlier join's message.
  function share(s, msg) {
    if (!forThis(s, msg)) return false;
    Object.assign(s, { shared: true, sent: null, buffer: [] });
    return true;
  }
  // Alone with the document again: its own text stands, and it stops sending ops. -> the next state.
  const unshared = (s, msg) => (forThis(s, msg) ? { ...newClient(), rev: s.rev, ticket: s.ticket } : s);

  return { lfText, separatorOf, diffOp, mapPoint, survivors, over, xform, applyText, newClient, forThis, flush, local, synced, remote, nack, share, unshared };
});
