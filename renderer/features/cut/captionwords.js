// Word timings of a caption (docs/cut-architecture.md section 6): which word of a caption is being spoken, for the
// word-by-word highlight. Pure; tested in Node (verify/cut-model.mjs).
//
// A caption item made from speech carries `words`: one entry per token of its text (a token is a run of characters
// without white space, across its lines), in order:
//   words = [{ t0, t1, text }]   t0, t1: whole ticks from the caption's start; text: the token itself
// Times may lie before the start or past the end (a word the caption no longer shows, after a ripple split); t0 never
// decreases. A caption whose words do not match its text is never highlighted (valid), and every edit that changes
// the text goes through realign, which keeps the timings of the words that still match, spreads the new ones evenly
// over the time of the words they replace, and gives up (null: no highlight for that caption) when there is no room.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).captionwords = api;
})(() => {
  const MODES = ['color', 'box'];
  const TOKEN = /\S+/g;
  const tokens = (text) => String(text ?? '').match(TOKEN) || [];
  // [from, to) of each token of one line, for drawing it.
  function spans(line) {
    const out = [];
    for (const m of String(line).matchAll(TOKEN)) out.push([m.index, m.index + m[0].length]);
    return out;
  }
  // Compared without case and punctuation, so "hello" corrected to "Hello," keeps its time.
  const key = (s) => s.toLowerCase().replace(/[\p{P}\p{S}]+/gu, '') || s;
  const isInt = Number.isInteger;
  const finite = Number.isFinite;

  function valid(words, text) {
    if (!Array.isArray(words)) return false;
    const toks = tokens(text);
    if (words.length !== toks.length) return false;
    let last = -Infinity;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w || typeof w !== 'object' || w.text !== toks[i] || !isInt(w.t0) || !isInt(w.t1) || w.t1 < w.t0 || w.t0 < last) return false;
      last = w.t0;
    }
    return true;
  }

  const snap = (x, f) => Math.round(x / f) * f;
  // Times that never go back: t0 the running maximum, t1 at least t0.
  function ordered(list) {
    let last = -Infinity;
    return list.map((w) => {
      const t0 = Math.max(w.t0, last);
      last = t0;
      return { t0, t1: Math.max(w.t1, t0), text: w.text };
    });
  }

  // words (any shape, maybe stale) fitted to `text` -> words valid for it, or null. frame: the sequence's frame ticks;
  // duration: the caption's length (room for words added at its end).
  function realign(words, text, { frame = 1, duration } = {}) {
    if (!Array.isArray(words)) return null;
    const toks = tokens(text);
    const f = frame > 0 ? frame : 1;
    const old = [];
    for (const w of words) {
      if (!w || typeof w !== 'object' || !finite(w.t0) || !finite(w.t1) || typeof w.text !== 'string') return null;
      // a word holding several tokens shares its time between them
      const parts = tokens(w.text);
      const len = Math.max(0, w.t1 - w.t0);
      parts.forEach((p, i) => old.push({ t0: w.t0 + (len * i) / parts.length, t1: w.t0 + (len * (i + 1)) / parts.length, text: p }));
    }
    const n = old.length;
    const m = toks.length;
    if (!n || !m || n * m > 1e6) return null;
    // the longest common run of tokens, in order
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i][j] = key(old[i].text) === key(toks[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    if (!L[0][0]) return null;
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (key(old[i].text) === key(toks[j])) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    const out = new Array(m);
    for (const [i, j] of pairs) out[j] = { t0: snap(old[i].t0, f), t1: snap(old[i].t1, f), text: toks[j] };
    const end = finite(duration) ? duration : old[n - 1].t1;
    const anchors = [[-1, -1], ...pairs, [n, m]];
    for (let a = 0; a + 1 < anchors.length; a++) {
      const [i0, j0] = anchors[a];
      const [i1, j1] = anchors[a + 1];
      const k = j1 - j0 - 1;
      if (k <= 0) continue;
      // new words take the time of the old ones they replace, or the gap between their neighbours
      let lo;
      let hi;
      if (i1 - i0 > 1) { lo = old[i0 + 1].t0; hi = old[i1 - 1].t1; } else { lo = i0 < 0 ? 0 : old[i0].t1; hi = i1 >= n ? end : old[i1].t0; }
      lo = snap(lo, f);
      hi = snap(hi, f);
      if (hi - lo < k * f) return null;
      const step = (hi - lo) / k / f;
      for (let q = 0; q < k; q++) out[j0 + 1 + q] = { t0: lo + Math.round(step * q) * f, t1: lo + Math.round(step * (q + 1)) * f, text: toks[j0 + 1 + q] };
    }
    return ordered(out);
  }

  // Each word's absolute time (from + t) through fn(x, isEnd), made relative to `to` again: what a ripple does.
  const moved = (t, from, to, fn, isEnd) => fn(from + t, isEnd) - to;
  function remap(words, from, to, fn) {
    return ordered(words.map((w) => ({ t0: moved(w.t0, from, to, fn, false), t1: moved(w.t1, from, to, fn, true), text: w.text })));
  }
  // A caption's doubt ([{at, text, p}], at: the start of a word speech recognition was unsure of) moved the same way.
  // Unlike its words, a doubt stays only while the caption, now `length` ticks long, holds its start.
  function remapDoubt(doubt, from, to, fn, length) {
    return doubt.map((d) => ({ ...d, at: moved(d.at, from, to, fn, false) })).filter((d) => d.at >= 0 && d.at <= length);
  }

  // The word lit at `rel` ticks into its caption: the last one begun, until the next begins (the last one until it
  // ends). Words of no length (cut away by a ripple) are never lit. -> index | -1
  function lit(words, rel) {
    let best = -1;
    let next = -1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.t1 <= w.t0) continue;
      if (w.t0 <= rel) best = i;
      else { next = i; break; }
    }
    if (best < 0) return -1;
    return rel < (next >= 0 ? words[next].t0 : words[best].t1) ? best : -1;
  }
  // The token of an item lit at sequence time t, or -1 (no words, or words that do not match the text).
  const litAt = (item, t) => (item && valid(item.words, item.text) ? lit(item.words, t - item.start) : -1);

  return { MODES, tokens, spans, valid, realign, remap, remapDoubt, lit, litAt };
});
