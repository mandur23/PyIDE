// Speech recognition's pure half (docs/cut-architecture.md section 9): what is done with Whisper's words, tested in
// Node (verify/cut-speech.mjs). ui-speech.js reads and mixes the sound, main/cut/whisper.js runs the model.
//
// - Windows: long sound is recognised 30 s at a time with 5 s of overlap, or from where a window's text stopped when
//   Whisper stopped early (nextWindow, textStop); mergeWindows takes a window's words up to 1.5 s before its end
//   (Whisper's least sure ones are at the end) and the next window's from the last word taken, and drops a word both
//   windows heard.
// - Timeline: words are kept per media file in source seconds and mapped through each clip's in, out, speed and
//   direction (Cut.analyze.toTimeline), so trims, moves and ripple deletes need no new recognition.
// - Captions: words grouped into captions of at most `maxLines` lines of `maxChars` characters (18 for Korean text,
//   42 otherwise), at most `maxDuration` long, split at pauses and after sentence ends (also Korean endings without
//   a full stop: -다, -요, -죠, -까 before a pause), each caption's lines balanced.
// - Fillers and pauses: hesitations (Korean 음, 어, 으음; 그, 저, 뭐 only when a pause follows; English um, uh, er,
//   ah, hmm) and long pauses between words, as timeline ranges to ripple-delete, inside whole frames.
// - Confidence and the word list: a word Whisper was unsure of (p under UNCERTAIN) is marked and goes with its caption
//   as the caption's doubt; the person's word list (names, products, terms) is parsed here and sent with each window.
// Word: {t0, t1, text, p?} (ticks on the timeline, or seconds where a function says so; p: Whisper's confidence 0-1),
// plus `clip` and `src` (the word's index in its transcript) once mapped.
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
  // p: how sure Whisper was of a word (0-1); absent when unknown (transcripts made before it was kept).
  const withP = (w, p) => (p == null ? w : { ...w, p });

  // ---- windows -----------------------------------------------------------------------------------------------------

  // [from, to) sample ranges covering `total` samples: `size` long, each starting `overlap` before the last one ends.
  // (The windows recognise() walks when Whisper's text always reaches the end of each one.)
  function windows(total, { size = WINDOW * RATE, overlap = OVERLAP * RATE } = {}) {
    const out = [];
    for (let from = total > 0 ? 0 : null; from != null;) {
      const to = Math.min(total, from + size);
      out.push([from, to]);
      from = nextWindow(from, to, null, { total, size, overlap }).next;
    }
    return out;
  }

  // After recognising the window [from, to) of `total` samples, whose text stops `end` seconds into it (null: no
  // text) -> {next: where the next window starts (null: that was the last), until: what this window's words count up
  // to (samples; undefined: mergeWindows' usual edge)}. Under music Whisper can stop after one sentence with most of
  // the window's speech left; the next window then starts where its text stopped instead of 5 s before its end (also
  // after the last window, when at least overlap + gap of it is left).
  // `again`: false for a window that itself began at such a stop. Song lyrics have pauses everywhere, and stop after
  // stop the windows advanced a few seconds each (40 minutes of CPU on a 30 s music intro); one stop in a row keeps
  // the windows at most twice the usual number.
  function nextWindow(from, to, end, { total, again = true, rate = RATE, size = WINDOW * rate, overlap = OVERLAP * rate, gap = rate } = {}) {
    const stop = end == null ? null : from + Math.round(end * rate);
    // Not for the last second or so of a file: what follows the last words there is noise or music, and Whisper
    // writes text into it (garbage in a made-up language at the end of the brown noise test).
    if (again && stop != null && stop >= from + gap && stop <= to - overlap - gap && size > overlap) return { next: stop, until: stop };
    return { next: to >= total ? null : to - overlap };
  }
  // Where a window's text stops (seconds into it): the end of the first word followed by `pause` seconds without
  // words (in noise Whisper also jumps over speech in the middle of a window), else `end`.
  function textStop(words, end, { pause = 2.5 } = {}) {
    for (let i = 0; i + 1 < words.length; i++) if (words[i + 1][0] - words[i][1] >= pause) return words[i][1];
    return end;
  }

  // results: [{from, to, until?, words: [[t0, t1, text, p?]]}] in window order, word times in seconds from the window's
  // start, the window bounds in samples. -> [{t0, t1, text, p?}] in seconds from sample 0.
  // Whisper's words near the end of a window are the least sure (cut off, or squeezed against the end), and a window
  // that starts mid-speech begins with what it half heard. So a window's words count up to `edge` seconds before its
  // end, or up to `until` when nextWindow set it (the last window: all of them), and the next window gives only the
  // words after the last one counted.
  function mergeWindows(results, { rate = RATE, edge = 1.5 } = {}) {
    const out = [];
    let boundary = -Infinity;
    results.forEach((r, k) => {
      const last = k === results.length - 1;
      const trust = last ? Infinity : r.until != null ? r.until / rate : r.to / rate - edge;
      const words = (r.words || []).map(([a, b, text, p]) => withP({ t0: r.from / rate + a, t1: r.from / rate + b, text: String(text).trim() }, p))
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
    for (let src = 0; src < words.length; src++) {
      const w = words[src];
      const s0 = (Array.isArray(w) ? w[0] : w.t0) * ticks;
      const s1 = (Array.isArray(w) ? w[1] : w.t1) * ticks;
      const text = Array.isArray(w) ? w[2] : w.text;
      const mid = (s0 + s1) / 2;
      if (mid < lo || mid >= hi) continue;
      const a = analyze.toTimeline(clip, Math.max(lo, s0));
      const b = analyze.toTimeline(clip, Math.min(hi, s1));
      out.push(withP({ t0: Math.min(a, b), t1: Math.max(a, b), text, clip: clip.id, src }, Array.isArray(w) ? w[3] : w.p));
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
      words: g,
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
    // The words Whisper was unsure of (opts.uncertain: the threshold, 0 none) go with their caption as its doubt.
    // Every word's time from the caption's start, on frames, goes with it for the word-by-word highlight
    // (Cut.captionwords).
    const onFrame = (x) => Math.round(x / frame) * frame;
    return out.map(({ words: g, ...c }) => {
      const doubt = g.filter((w) => isUncertain(w, opts.uncertain)).map((w) => ({ at: Math.max(0, Math.round(w.t0 - c.start)), text: w.text, p: w.p }));
      const timed = { ...c, words: g.map((w) => ({ t0: onFrame(w.t0 - c.start), t1: onFrame(w.t1 - c.start), text: String(w.text).trim() })) };
      return doubt.length ? { ...timed, doubt } : timed;
    });
  }

  // ---- confidence and the word list --------------------------------------------------------------------------------

  // Whisper's confidence of a word is its least sure token's probability. Below UNCERTAIN two thirds of the words are
  // wrong and they hold 57% of the wrong ones, the best balance on the noise benchmark (docs/cut-architecture.md,
  // Cut.speech). A word without p (an older transcript) or corrected by the person (p 1) is not uncertain.
  const UNCERTAIN = 0.5;
  const isUncertain = (w, threshold = UNCERTAIN) => threshold > 0 && w.p != null && w.p < threshold;
  // The word list typed by the person (one term a line, or separated by commas) -> its terms, each once, in order.
  const TERMS = { count: 200, chars: 100 };
  function parseTerms(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/[\n,，、;]+/)) {
      const t = raw.replace(/\s+/g, ' ').trim().slice(0, TERMS.chars).trim();
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push(t);
      if (out.length >= TERMS.count) break;
    }
    return out;
  }
  // A short fingerprint of a word list for the transcript cache key ('' for none, so transcripts without a list keep
  // their key): FNV-1a over the terms.
  function termsKey(terms) {
    if (!terms?.length) return '';
    let h = 0x811c9dc5;
    for (const ch of terms.join('\n')) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  // Where there is no speech (the room noise after the last sentence) Whisper can read the word list back as text
  // ("제주도, 한라산, 롯데월드, …"). A run of two or more words that are each a term of the list (or a word of one), all
  // but the last ending with the list's comma, is that echo and goes. A person naming terms says them with particles
  // or "and" between, which this leaves alone. words: [[t0, t1, text, p?]] or [{text}] -> the same without the echo.
  function dropEcho(words, terms) {
    if (!terms?.length) return words;
    const known = new Set(terms.flatMap((t) => [t, ...t.split(' ')]).map(normalize).filter(Boolean));
    const textOf = (w) => String(Array.isArray(w) ? w[2] : w.text).trim();
    const term = (w) => known.has(normalize(textOf(w)));
    const comma = (w) => /[,，、]$/.test(textOf(w));
    const drop = new Set();
    for (let i = 0; i < words.length; i++) {
      if (!term(words[i]) || !comma(words[i])) continue;
      let j = i + 1;
      while (j < words.length && term(words[j]) && comma(words[j - 1])) j++;
      if (j - i >= 2) for (let k = i; k < j; k++) drop.add(k);
      i = j - 1;
    }
    return drop.size ? words.filter((_, k) => !drop.has(k)) : words;
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
    RATE, WINDOW, OVERLAP, UNCERTAIN, TERMS,
    isKorean, normalize, isUncertain, parseTerms, termsKey, dropEcho, windows, nextWindow, textStop, mergeWindows, dedupe, clipWords, joinClips, wordAt,
    layout, captions, isFiller, wordRange, removalRanges, fillerPlan, runs, search,
  };
});
