// What main does with a window of 16 kHz mono samples around speech recognition (main/cut/whisper.js), kept pure for
// verify/cut-speech.mjs:
// - refine(samples, words): Whisper's word times come from its attention and run into the pauses around a word (the
//   first word of a window starts at 0, the last word of a sentence ends where the next one starts). Each word is
//   narrowed to the loud part of its span, so the pauses between words are where they are heard.
// - bursts(samples, ...) and fakeWords(...): the test backend (PYIDE_WHISPER_BACKEND=fake) "hears" one word per burst
//   of sound, so the app suites need no model: testsrc's beeps and tone stretches become words with their timing.
const RATE = 16000;
const FRAME = 160; // 10 ms

// Level of each 10 ms frame, dBFS (a full-scale sine is -3).
function frameDb(samples) {
  const n = Math.floor(samples.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += samples[i] * samples[i];
    const ms = s / FRAME;
    out[f] = ms > 0 ? Math.max(-200, 10 * Math.log10(ms)) : -200;
  }
  return out;
}

// words: [[t0, t1, text, lead?]] in seconds from the window's start -> [[t0, t1, text]] with t0 and t1 moved in to
// the sound of the word (never out, and only by more than `slack`). The span's sound is split into runs at quiet gaps
// of `gap` seconds or more: a word's sound is its longest run (Whisper stretches words over the pauses around them,
// and a neighbour's last syllable can reach in), except for the first word of a segment (lead), whose start Whisper
// puts before the pause ahead of it, at a window's start even over speech it did not write out: its sound is its last
// run. A word with no loud frame keeps its times.
function refine(samples, words, { floor = -48, below = 38, slack = 0.08, lead = 0.02, tail = 0.05, gap = 0.25 } = {}) {
  const db = frameDb(samples);
  let peak = -200;
  for (const v of db) if (v > peak) peak = v;
  const thr = Math.max(floor, peak - below);
  const step = FRAME / RATE;
  const join = Math.round(gap / step);
  return words.map(([t0, t1, text, first]) => {
    const f0 = Math.max(0, Math.floor(t0 / step));
    const f1 = Math.min(db.length, Math.ceil(t1 / step));
    const runs = [];
    for (let f = f0; f < f1; f++) {
      if (db[f] <= thr) continue;
      const r = runs[runs.length - 1];
      if (r && f - r[1] <= join) r[1] = f + 1;
      else runs.push([f, f + 1]);
    }
    if (!runs.length) return [t0, t1, text];
    const [s, e] = first ? runs[runs.length - 1] : runs.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
    const a = Math.max(t0, s * step - lead);
    const b = Math.min(t1, e * step + tail);
    const n0 = a - t0 > slack ? a : t0;
    const n1 = t1 - b > slack ? b : t1;
    return n1 > n0 ? [round(n0), round(n1), text] : [t0, t1, text];
  });
}
const round = (x) => Math.round(x * 1000) / 1000;

// Runs of frames louder than `threshold` dBFS, gaps shorter than `join` seconds closed, runs shorter than `min` dropped.
// -> [[t0, t1]] seconds.
function bursts(samples, { threshold = -35, join = 0.03, min = 0.04 } = {}) {
  const db = frameDb(samples);
  const step = FRAME / RATE;
  const out = [];
  let start = -1;
  for (let f = 0; f <= db.length; f++) {
    const loud = f < db.length && db[f] > threshold;
    if (loud && start < 0) start = f;
    else if (!loud && start >= 0) {
      const a = start * step;
      const b = f * step;
      const prev = out[out.length - 1];
      if (prev && a - prev[1] < join) prev[1] = b;
      else out.push([a, b]);
      start = -1;
    }
  }
  return out.filter(([a, b]) => b - a >= min).map(([a, b]) => [round(a), round(b)]);
}

// The fake model's words: one per burst, its text from the burst's half second (rounded) in the file, so every window that
// holds a burst names it the same way. Bursts cut by the window's edge are left to the window that holds them whole,
// except at the start and end of the file.
const FAKE_WORDS = {
  ko: ['안녕하세요', '음', '오늘은', '자막을', '어', '만들어', '봅니다.', '그', '편집이', '쉬워요.'],
  en: ['Hello', 'um', 'today', 'we', 'uh', 'make', 'captions.', 'This', 'is', 'easy.'],
};
function fakeWords(samples, { offset = 0, total = Infinity, language = 'ko' } = {}) {
  const list = FAKE_WORDS[language] || FAKE_WORDS.ko;
  const seconds = samples.length / RATE;
  const atStart = offset <= 0;
  const atEnd = offset + samples.length >= total;
  const edge = 0.02;
  const out = [];
  for (const [a, b] of bursts(samples)) {
    if ((a < edge && !atStart) || (b > seconds - edge && !atEnd)) continue;
    const abs = offset / RATE + a;
    out.push([a, b, list[Math.round(abs * 2) % list.length]]);
  }
  return out;
}

module.exports = { RATE, frameDb, refine, bursts, fakeWords, FAKE_WORDS };
