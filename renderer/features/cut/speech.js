// Speech recognition's pure half (docs/cut-architecture.md section 9): what is done with Whisper's words, tested in
// Node (verify/cut-speech.mjs). ui-speech.js reads and mixes the sound, main/cut/whisper.js runs the model.
//
// - Windows: long sound is recognised 30 s at a time with 5 s of overlap; mergeWindows takes a window's words up to
//   1.5 s before its end (Whisper's least sure ones are at the end) and the next window's from the last word taken,
//   and drops a word both windows heard.
// - Timeline: words are kept per media file in source seconds and mapped through each clip's in, out, speed and
//   direction (Cut.analyze.toTimeline), so trims, moves and ripple deletes need no new recognition.
// - Captions: words grouped into captions of at most `maxLines` lines of `maxChars` characters (18 for Korean text,
//   42 otherwise), at most `maxDuration` long, split at pauses and after sentence ends (also Korean endings without
//   a full stop: -다, -요, -죠, -까 before a pause), each caption's lines balanced.
// - Fillers and pauses: hesitations (Korean 음, 어, 으음; 그, 저, 뭐 only when a pause follows; English um, uh, er,
//   ah, hmm) and long pauses between words, as timeline ranges to ripple-delete, inside whole frames.
// Word: {t0, t1, text} (ticks on the timeline, or seconds where a function says so), plus `clip` once mapped.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).speech = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const RATE = 16000;
  const WINDOW = 30;
  const OVERLAP = 5;

  const HANGUL = /\p{Script=Hangul}/u;
  const isKorean = (text) => HANGUL.test(text);
  // Lower case without punctuation, for comparing and searching.
  const normalize = (text) => String(text || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, '').trim();
  const length = (text) => [...text].length;

  // ---- windows -----------------------------------------------------------------------------------------------------

  // [from, to) sample ranges covering `total` samples: `size` long, each starting `overlap` before the last one ends.
  function windows(total, { size = WINDOW * RATE, overlap = OVERLAP * RATE } = {}) {
    const out = [];
    if (total <= 0) return out;
    let from = 0;
    for (;;) {
      const to = Math.min(total, from + size);
      out.push([from, to]);
      if (to >= total) break;
      from = to - overlap;
    }
    return out;
  }

  // results: [{from, to, words: [[t0, t1, text]]}] in window order, word times in seconds from the window's start, the
  // window bounds in samples. -> [{t0, t1, text}] in seconds from sample 0.
  // Whisper's words near the end of a window are the least sure (cut off, or squeezed against the end), and a window
  // that starts mid-speech begins with what it half heard. So a window's words count up to `edge` seconds before its
  // end (the last window: all of them), and the next window gives only the words after the last one counted.
  function mergeWindows(results, { rate = RATE, edge = 1.5 } = {}) {
    const out = [];
    let boundary = -Infinity;
    results.forEach((r, k) => {
      const last = k === results.length - 1;
      const trust = last ? Infinity : r.to / rate - edge;
      const words = (r.words || []).map(([a, b, text]) => ({ t0: r.from / rate + a, t1: r.from / rate + b, text: String(text).trim() }))
        .filter((w) => w.text).sort((x, y) => x.t0 - y.t0);
      for (const w of words) {
        const mid = (w.t0 + w.t1) / 2;
        if (mid > trust || mid <= boundary) continue;
        out.push({ ...w, t0: Math.max(w.t0, Math.min(boundary, w.t1)) });
      }
      boundary = Math.max(boundary, out.length ? out[out.length - 1].t1 : -Infinity, trust === Infinity ? -Infinity : trust);
    });
    return dedupe(out.sort((x, y) => x.t0 - y.t0));
  }
  // A word heard twice (the two sides of a seam, two clips of one recording) is kept once: the same text starting
  // within `near` of a kept word, or overlapping it by more than half.
  function dedupe(words, { near = 0.5 } = {}) {
    const out = [];
    for (const w of words) {
      const n = normalize(w.text);
      const twin = out.slice(-4).some((k) => normalize(k.text) === n
        && (Math.abs(k.t0 - w.t0) < near || Math.min(k.t1, w.t1) - Math.max(k.t0, w.t0) > 0.5 * Math.min(k.t1 - k.t0, w.t1 - w.t0)));
      if (!twin) out.push(w);
    }
    return out;
  }

  // ---- timeline ----------------------------------------------------------------------------------------------------

  // A media file's words (seconds of source time) -> the clip's words on the timeline (ticks), those whose middle the
  // clip shows, in timeline order. A freeze frame shows none.
  function clipWords(clip, words, { ticks = need('time').TICKS } = {}) {
    const analyze = need('analyze');
    if (clip.source?.freeze) return [];
    const [lo, hi] = analyze.sourceSpan(clip);
    const out = [];
    for (const w of words) {
      const s0 = (Array.isArray(w) ? w[0] : w.t0) * ticks;
      const s1 = (Array.isArray(w) ? w[1] : w.t1) * ticks;
      const text = Array.isArray(w) ? w[2] : w.text;
      const mid = (s0 + s1) / 2;
      if (mid < lo || mid >= hi) continue;
      const a = analyze.toTimeline(clip, Math.max(lo, s0));
      const b = analyze.toTimeline(clip, Math.min(hi, s1));
      out.push({ t0: Math.min(a, b), t1: Math.max(a, b), text, clip: clip.id });
    }
    return out.sort((x, y) => x.t0 - y.t0);
  }
  // Words of several clips -> one list in timeline order, a word two overlapping clips both hold kept once.
  function joinClips(lists) {
    const all = lists.flat().sort((x, y) => x.t0 - y.t0);
    const out = [];
    for (const w of all) {
      const n = normalize(w.text);
      const twin = out.slice(-4).some((k) => k.clip !== w.clip && normalize(k.text) === n && Math.min(k.t1, w.t1) - Math.max(k.t0, w.t0) > 0.5 * Math.min(k.t1 - k.t0, w.t1 - w.t0));
      if (!twin) out.push(w);
    }
    return out;
  }
  // The index of the word at time t (the last one starting at or before t, while t is before the next one), or -1.
  function wordAt(words, t) {
    let lo = 0;
    let hi = words.length - 1;
    let found = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (words[m].t0 <= t) { found = m; lo = m + 1; } else hi = m - 1;
    }
    return found;
  }

  // ---- captions ----------------------------------------------------------------------------------------------------

  const SENTENCE = /[.?!。…]["')\]]*$/;
  const KOREAN_END = /(다|요|죠|까)$/;
  const SOFT = /[,;:，、]$/;
  // Lines of words, each at most maxChars long (a longer word gets a line of its own), at most maxLines of them, the
  // longest as short as it can be. null when the words do not fit. `sep` joins the words of a line: '' for Japanese
  // and Chinese, whose "words" are characters (Cut.ai.lineBreak).
  function layout(texts, maxChars, maxLines, sep = ' ') {
    const n = texts.length;
    const len = texts.map(length);
    const span = (i, j) => len.slice(i, j).reduce((s, x) => s + x, 0) + sep.length * (j - i - 1);
    if (span(0, n) <= maxChars) return [texts.join(sep)];
    if (maxLines < 2) return null;
    // The smallest longest line laying out texts[i..] in k lines; of equal ones the shorter first line.
    const solve = (i, k) => {
      if (i === n) return { worst: 0, cuts: [] };
      if (k === 0) return null;
      let pick = null;
      for (let j = i + 1; j <= n; j++) {
        const w = span(i, j);
        if (w > maxChars && j > i + 1) break;
        const rest = solve(j, k - 1);
        if (!rest) continue;
        // a cut after a comma reads better: it counts as one character shorter
        const worst = Math.max(w - (j < n && SOFT.test(texts[j - 1]) ? 1 : 0), rest.worst);
        if (!pick || worst < pick.worst) pick = { worst, cuts: [j, ...rest.cuts] };
      }
      return pick;
    };
    const best = solve(0, maxLines);
    if (!best) return null;
    const lines = [];
    let at = 0;
    for (const c of best.cuts) { lines.push(texts.slice(at, c).join(sep)); at = c; }
    return lines;
  }
  const endsSentence = (w, next, pause) => SENTENCE.test(w.text) || (isKorean(w.text) && KOREAN_END.test(w.text) && (!next || next.t0 - w.t1 >= pause / 2));

  // words (ticks, timeline order) -> captions [{start, end, text}] (lines joined with \n), snapped to `frame` ticks.
  function captions(words, opts = {}) {
    const T = opts.ticks || need('time').TICKS;
    const frame = opts.frame || 1;
    const maxLines = opts.maxLines || 2;
    const maxDuration = (opts.maxDuration ?? 6) * T;
    const pause = (opts.pause ?? 0.6) * T;
    const linger = (opts.linger ?? 0.3) * T;
    const minDuration = (opts.minDuration ?? 0.8) * T;
    const list = words.filter((w) => String(w.text).trim());
    const korean = list.filter((w) => isKorean(w.text)).length * 2 >= list.length;
    const maxChars = opts.maxChars > 0 ? opts.maxChars : korean ? 18 : 42;
    const groups = [];
    let cur = [];
    const fits = (g) => !!layout(g.map((w) => w.text), maxChars, maxLines);
    const size = (g) => g.reduce((s, w) => s + length(w.text) + 1, -1);
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (cur.length) {
        const last = cur[cur.length - 1];
        // a sentence end closes a caption that has half a line or more
        const full = size(cur) >= maxChars * 0.5;
        if (w.t0 - last.t1 >= pause || w.t1 - cur[0].t0 > maxDuration || !fits([...cur, w])
          || (full && endsSentence(last, w, pause)) || (size(cur) >= maxChars * 0.9 && SOFT.test(last.text))) {
          groups.push(cur);
          cur = [];
        }
      }
      cur.push(w);
    }
    if (cur.length) groups.push(cur);
    const out = groups.map((g) => ({
      start: g[0].t0,
      end: g[g.length - 1].t1,
      text: (layout(g.map((w) => w.text), maxChars, maxLines) || [g.map((w) => w.text).join(' ')]).join('\n'),
    }));
    // A caption stays a little after its last word and at least minDuration, never into the next one and never past
    // maxDuration (one word sung for 8 s gets an end that long from Whisper); times on frames.
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      const limit = Math.min(out[i + 1] ? out[i + 1].start : Infinity, c.start + Math.max(maxDuration, minDuration));
      const want = Math.max(c.end + linger, c.start + minDuration);
      c.end = Math.min(want, limit);
      c.start = Math.floor(c.start / frame + 1e-9) * frame;
      c.end = Math.max(c.start + frame, Math.floor(c.end / frame + 1e-9) * frame);
    }
    for (let i = 0; i + 1 < out.length; i++) {
      const nextStart = Math.floor(out[i + 1].start / frame + 1e-9) * frame;
      if (out[i].end > nextStart) out[i].end = Math.max(out[i].start + frame, nextStart);
    }
    return out;
  }

  // ---- fillers and pauses ------------------------------------------------------------------------------------------

  // Always hesitations, and hesitations only when a pause follows (they are also words: "that", "I", "what").
  const FILLERS = { ko: /^(음+|어+|으+음*|흠+)$/u, en: /^(u+m+|u+h+|e+r+|e+r+m+|a+h+|h+m+|m+)$/ };
  const MAYBE = { ko: /^(그|저|뭐)$/u, en: null };
  const TRAILING = /(\.\.\.|…|,|-)$/;
  // Whether words[i] is a filler. `pause` (ticks) is the gap after it that makes 그, 저, 뭐 a hesitation.
  function isFiller(words, i, { pause }) {
    const w = words[i];
    const text = normalize(w.text);
    if (!text) return false;
    const lang = isKorean(text) ? 'ko' : 'en';
    if (FILLERS[lang].test(text)) return true;
    if (!MAYBE[lang]?.test(text)) return false;
    const next = words[i + 1];
    return TRAILING.test(String(w.text).trim()) || !next || next.t0 - w.t1 >= pause || normalize(next.text) === text;
  }
  // The timeline range that removes words i..j: the words and the pause around them up to `ext` on each side, never
  // closer than `keep` to the words left on either side.
  function wordRange(words, i, j, { ext, keep }) {
    const first = words[i];
    const last = words[j];
    const prev = words[i - 1];
    const next = words[j + 1];
    let a = first.t0 - ext;
    let b = last.t1 + ext;
    if (prev) a = Math.max(a, prev.t1 + keep);
    if (next) b = Math.min(b, next.t0 - keep);
    a = Math.min(a, first.t0);
    b = Math.max(b, last.t1);
    if (prev) a = Math.max(a, prev.t1);
    if (next) b = Math.min(b, next.t0);
    return [a, b];
  }
  // Ranges (ticks) inside whole frames, joined, empty ones dropped.
  function onFrames(ranges, frame) {
    const analyze = need('analyze');
    return analyze.union(ranges.map(([a, b]) => [Math.ceil(a / frame - 1e-9) * frame, Math.floor(b / frame + 1e-9) * frame]).filter(([a, b]) => b > a));
  }
  // Runs of consecutive indexes: [3, 4, 5, 9] -> [[3, 5], [9, 9]].
  function runs(indexes) {
    const s = [...new Set(indexes)].sort((x, y) => x - y);
    const out = [];
    for (const i of s) {
      const last = out[out.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else out.push([i, i]);
    }
    return out;
  }
  // The ranges that remove the chosen words (the transcript's selection).
  function removalRanges(words, indexes, { ext = 0.25, keep = 0.08, frame = 1, ticks = need('time').TICKS } = {}) {
    return onFrames(runs(indexes).map(([i, j]) => wordRange(words, i, j, { ext: ext * ticks, keep: keep * ticks })), frame);
  }
  // Remove Filler Words: {fillers: [index], pauses: [[a, b]], ranges} with ranges on frames. Pauses longer than
  // `pauseLength` seconds between words are cut down to `keep` on each side.
  function fillerPlan(words, { fillers = true, pauses = true, pauseLength = 1, keep = 0.15, ext = 0.25, hesitation = 0.3, frame = 1, ticks = need('time').TICKS } = {}) {
    const found = fillers ? words.map((_, i) => i).filter((i) => isFiller(words, i, { pause: hesitation * ticks })) : [];
    const gone = new Set(found);
    const cuts = runs(found).map(([i, j]) => wordRange(words, i, j, { ext: ext * ticks, keep: 0.08 * ticks }));
    const gaps = [];
    if (pauses) {
      const kept = words.filter((_, i) => !gone.has(i));
      for (let i = 0; i + 1 < kept.length; i++) {
        const a = kept[i].t1 + keep * ticks;
        const b = kept[i + 1].t0 - keep * ticks;
        if (kept[i + 1].t0 - kept[i].t1 >= pauseLength * ticks && b > a) gaps.push([a, b]);
      }
    }
    return { fillers: found, pauses: onFrames(gaps, frame), ranges: onFrames([...cuts, ...gaps], frame) };
  }

  // ---- search ------------------------------------------------------------------------------------------------------

  // Matches of a query in the words: [[i, j]] index runs whose words hold the query's words in order (the first and
  // last may be partial), case and punctuation ignored.
  function search(words, query) {
    const q = String(query || '').split(/\s+/).map(normalize).filter(Boolean);
    if (!q.length) return [];
    const norm = words.map((w) => normalize(w.text));
    const out = [];
    for (let i = 0; i + q.length <= norm.length; i++) {
      let ok = true;
      for (let k = 0; k < q.length && ok; k++) {
        const w = norm[i + k];
        if (q.length === 1) ok = w.includes(q[0]);
        else if (k === 0) ok = w.endsWith(q[k]);
        else if (k === q.length - 1) ok = w.startsWith(q[k]);
        else ok = w === q[k];
      }
      if (ok) out.push([i, i + q.length - 1]);
    }
    return out;
  }

  return {
    RATE, WINDOW, OVERLAP,
    isKorean, normalize, windows, mergeWindows, dedupe, clipWords, joinClips, wordAt,
    layout, captions, isFiller, wordRange, removalRanges, fillerPlan, runs, search,
  };
});
