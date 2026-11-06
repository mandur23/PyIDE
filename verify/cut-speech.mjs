// Nano Studio Cut's speech recognition, its pure parts and its main side, in plain Node (no model, no Electron):
// - windows of 30 s with 5 s of overlap and the words joined at their seams (a word in an overlap kept once, from
//   the window where it lies further from the edge), and words heard twice by two clips of one recording;
// - words of a media file mapped to the timeline through a clip's in, out, speed and reverse;
// - caption line breaking: Korean at 18 characters a line and English at 42, at most two balanced lines and 6 s,
//   split at pauses and sentence ends (Korean endings without a full stop too), frames, no overlaps;
// - filler words (Korean 음, 어, 으음 always; 그, 저, 뭐 only before a pause; English um, uh, er, ah, hmm; never
//   "like") and long pauses as ranges on frames; the ranges that delete selected words; the transcript search;
// - main/cut/speech-words.js: word times narrowed to the loud part of their span, bursts, the fake model's words;
// - main/cut/whisper.js with the fake backend: temp files written in pieces and read by window, another window's
//   file refused, windows limited to 31 s, cancel, files deleted on close and when the window goes, the setup
//   flow (missing, progress, ready; offline and disk failures as codes) and the error classification;
// - speech.js as a page script next to an AMD `require` (Monaco's loader.js), in index.js order.
// Usage: node verify/cut-speech.mjs
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const Sp = require('../renderer/features/cut/speech.js');
const W = require('../main/cut/speech-words.js');
const { createSpeech, classify } = require('../main/cut/whisper.js');

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const T = time.TICKS;
const F = time.frameTicks([30, 1]);
const R = 16000;
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }
const word = (t0, t1, text) => ({ t0: t0 * T, t1: t1 * T, text });
const chars = (s) => [...s].length;

// ---------- windows and seams ----------
await section('windows', () => {
  eq(Sp.windows(10 * R), [[0, 10 * R]], 'a short sound is one window');
  const w = Sp.windows(70 * R);
  eq(w.map(([a, b]) => [a / R, b / R]), [[0, 30], [25, 55], [50, 70]], '70 s: 30 s windows, each starting 5 s before the last one ends');
  check(w.every(([a, b], i) => b - a <= 30 * R && (!i || a < w[i - 1][1])), 'no window is longer than 30 s and each overlaps the one before');
  eq(Sp.windows(0), [], 'no sound, no windows');
});

await section('seams', () => {
  // A word every 2 s from 1 s; both windows hear the ones in their overlap (25-30 s), a little apart in time.
  const truth = [];
  for (let t = 1; t < 55; t += 2) truth.push([t, t + 0.4, `w${t}`]);
  const wins = [[0, 30 * R], [25 * R, 55 * R]];
  const results2 = wins.map(([from, to], k) => ({
    from, to,
    words: truth.filter(([a, b]) => a >= from / R && b <= to / R).map(([a, b, text]) => [a - from / R + (k ? 0.04 : -0.03), b - from / R + (k ? 0.04 : -0.03), text]),
  }));
  const merged = Sp.mergeWindows(results2);
  eq(merged.map((x) => x.text), truth.map((x) => x[2]), 'every word once, in order, across the seam');
  const at27 = merged.find((x) => x.text === 'w27');
  check(at27 && Math.abs(at27.t0 - 26.97) < 1e-6, 'a word more than 1.5 s before the first window ends comes from it');
  const at29 = merged.find((x) => x.text === 'w29');
  check(at29 && Math.abs(at29.t0 - 29.04) < 1e-6, 'a word in the last 1.5 s of the first window comes from the second');
  // A word both windows heard a little apart in time.
  const twice = Sp.mergeWindows([{ from: 0, to: 30 * R, words: [[27.3, 27.48, 'seam']] }, { from: 25 * R, to: 55 * R, words: [[2.52, 2.7, 'Seam.']] }]);
  eq(twice.map((x) => x.text), ['seam'], 'a word both windows heard is kept once');
  const two = Sp.mergeWindows([{ from: 0, to: 30 * R, words: [[26, 26.3, 'go'], [27.4, 27.49, 'go']] }, { from: 25 * R, to: 55 * R, words: [[2.4, 2.49, 'go']] }]);
  eq(two.length, 2, 'a word said twice a second apart stays twice');
  // What Whisper does at the edges: words squeezed against the end of the first window, and the second window, which
  // starts mid-speech, stretching its first word back over what it half heard.
  const edges = Sp.mergeWindows([
    { from: 0, to: 30 * R, words: [[26, 26.9, 'before'], [28.8, 29.2, 'voice'], [29.2, 29.98, 'recognition'], [29.98, 29.98, 'runs']] },
    { from: 25 * R, to: 55 * R, words: [[0, 1.1, 'half'], [3.8, 4.2, 'voice'], [4.2, 4.8, 'recognition'], [4.8, 5.3, 'runs'], [6, 6.4, 'here']] },
  ]);
  eq(edges.map((x) => `${x.text}@${x.t0.toFixed(1)}`), ['before@26.0', 'voice@28.8', 'recognition@29.2', 'runs@29.8', 'here@31.0'], 'the squeezed end words come from the second window, its half-heard start is dropped');
});

// ---------- timeline ----------
await section('timeline', () => {
  const words = [[9, 9.5, 'before'], [10.2, 10.6, 'one'], [12, 12.5, 'two'], [19.8, 20.4, 'edge'], [21, 21.5, 'after']];
  const clip = { id: 'c1', start: 5 * T, in: 10 * T, out: 20 * T, speed: 2, reverse: false, source: { media: 'm1' } };
  const tl = Sp.clipWords(clip, words);
  eq(tl.map((x) => x.text), ['one', 'two'], 'only the words whose middle the clip shows');
  eq(tl.map((x) => [+(x.t0 / T).toFixed(3), +(x.t1 / T).toFixed(3)]), [[5.1, 5.3], [6, 6.25]], 'mapped through in and speed (2x: source 12 s at 5 + 2/2 = 6 s)');
  check(tl.every((x) => x.clip === 'c1'), 'each word knows its clip');
  const rev = Sp.clipWords({ ...clip, reverse: true, speed: 1 }, words);
  eq(rev.map((x) => x.text), ['two', 'one'], 'a reversed clip shows its words in reverse order on the timeline');
  eq(Sp.clipWords({ ...clip, source: { media: 'm1', freeze: 12 * T } }, words), [], 'a freeze frame has no words');
  const a = Sp.clipWords({ ...clip, speed: 1, id: 'a' }, words);
  const b = Sp.clipWords({ ...clip, speed: 1, id: 'b' }, words);
  eq(Sp.joinClips([a, b]).map((x) => x.text), ['one', 'two', 'edge'].slice(0, a.length), 'two clips of one recording on two tracks give each word once');
  const list = [word(1, 1.5, 'a'), word(2, 2.5, 'b'), word(4, 4.2, 'c')];
  eq([0.5, 1, 1.7, 2.6, 5].map((t) => Sp.wordAt(list, t * T)), [-1, 0, 0, 1, 2], 'wordAt finds the word that started last');
});

// ---------- captions ----------
await section('captions', () => {
  const ko = '안녕하세요 여러분 오늘은 영상 편집기에서 자막을 자동으로 만드는 방법을 알아보겠습니다. 먼저 타임라인에 클립을 놓고 메뉴를 엽니다.'.split(' ');
  const words = ko.map((t, i) => word(i * 0.45, i * 0.45 + 0.4, t));
  const caps = Sp.captions(words, { frame: F });
  check(caps.length >= 2, `Korean words become several captions (${caps.length})`);
  check(caps.every((c) => c.text.split('\n').length <= 2 && c.text.split('\n').every((l) => chars(l) <= 18)), `two lines at most, 18 characters each (${S(caps.map((c) => c.text))})`);
  check(caps.every((c) => c.end - c.start <= 6.4 * T), 'no caption is much longer than 6 s');
  check(caps.every((c) => c.start % F === 0 && c.end % F === 0 && c.end > c.start), 'times on frames, each caption at least a frame');
  check(caps.every((c, i) => !i || caps[i - 1].end <= c.start), 'captions never overlap');
  check(caps.some((c) => c.text.replace(/\n/g, ' ').endsWith('알아보겠습니다.')), 'a caption ends at the sentence end');
  eq(caps.map((c) => c.text.replace(/\n/g, ' ')).join(' '), ko.join(' '), 'no word lost or doubled');
  // balanced: the two lines of a caption differ little
  const two = caps.filter((c) => c.text.includes('\n'));
  check(two.every((c) => { const [x, y] = c.text.split('\n').map(chars); return Math.abs(x - y) <= 9; }), `the two lines are balanced (${S(two.map((c) => c.text))})`);
  // a pause splits
  const paused = Sp.captions([word(0, 0.4, '하나'), word(0.5, 0.9, '둘'), word(2.2, 2.6, '셋')], { frame: F });
  eq(paused.map((c) => c.text), ['하나 둘', '셋'], 'a pause of 0.6 s or more starts a new caption');
  // Korean ending without a full stop, before a pause
  const end = Sp.captions(['오늘', '날씨가', '좋네요', '그래서', '산책을', '갑니다'].map((t, i) => word(i * 0.5 + (i >= 3 ? 0.35 : 0), i * 0.5 + 0.4 + (i >= 3 ? 0.35 : 0), t)), { frame: F });
  eq(end.map((c) => c.text.replace(/\n/g, ' ')), ['오늘 날씨가 좋네요', '그래서 산책을 갑니다'], 'a Korean ending (-요) before a short pause ends the caption');
  // maximum duration
  const slow = Sp.captions(Array.from({ length: 12 }, (_, i) => word(i * 0.9, i * 0.9 + 0.5, '말')), { frame: F });
  check(slow.length >= 2 && slow.every((c) => c.end - c.start <= 6.4 * T), 'slow speech is split at about 6 s');
  const sung = Sp.captions([word(1, 9.1, '사랑해'), word(9.5, 10, '너를')], { frame: F });
  check(sung[0].text === '사랑해' && sung[0].end - sung[0].start <= 6 * T && sung[1].start >= sung[0].end, `one word sung for 8.1 s shows for 6 s at most (${((sung[0].end - sung[0].start) / T).toFixed(2)} s)`);
  // English: 42 characters
  const en = 'So today we are going to look at how the editor makes captions from speech, and then we will export the video with them.'.split(' ');
  const enCaps = Sp.captions(en.map((t, i) => word(i * 0.3, i * 0.3 + 0.25, t)), { frame: F });
  check(enCaps.every((c) => c.text.split('\n').every((l) => l.length <= 42) && c.text.split('\n').length <= 2), `English lines of at most 42 characters (${S(enCaps.map((c) => c.text))})`);
  check(enCaps.some((c) => c.text.split('\n').some((l) => l.length > 18)), 'English lines are not cut at the Korean length');
  const narrow = Sp.captions(en.map((t, i) => word(i * 0.3, i * 0.3 + 0.25, t)), { frame: F, maxChars: 20 });
  check(narrow.every((c) => c.text.split('\n').every((l) => l.length <= 20 || !l.includes(' '))), 'a chosen line length is kept');
  const lines = Sp.layout(['안녕하세요', '오늘은', '영상', '편집기에서', '자막을', '자동으로'], 18, 2);
  check(lines && lines.length === 2 && lines.every((l) => chars(l) <= 18), `layout: two lines within 18 (${S(lines)})`);
  eq(Sp.layout(['가나다라마바사아자차카타파하가나다라마'], 18, 2), ['가나다라마바사아자차카타파하가나다라마'], 'a word longer than a line gets a line of its own');
  eq(Sp.layout('a b c d e f g h'.split(' ').map((x) => x.repeat(10)), 21, 2), null, 'too many words for two lines do not fit');
  // a caption lingers a little after its last word, never into the next
  const linger = Sp.captions([word(0, 0.5, '하나.'), word(0.6, 1, '둘')], { frame: F, pause: 0.6 });
  check(linger[0].end <= linger[1]?.start || linger.length === 1, 'the linger never runs into the next caption');
});

// ---------- fillers, pauses, deleting words, search ----------
await section('fillers', () => {
  const ws = [
    word(0, 0.5, '안녕하세요'), word(0.6, 0.8, '음'), word(0.9, 1.4, '오늘은'), word(1.5, 1.6, '어,'), word(1.7, 2.1, '그'),
    word(2.15, 2.6, '사람이'), word(2.7, 2.8, '그'), word(3.3, 3.8, '왔어요'), word(3.9, 4.0, '으음'), word(4.1, 4.5, '뭐'),
    word(4.55, 5.0, '먹을까'), word(6.4, 6.8, '저는'), word(6.85, 7.2, '좋아요'),
  ];
  const isF = ws.map((_, i) => Sp.isFiller(ws, i, { pause: 0.3 * T }));
  eq(ws.filter((_, i) => isF[i]).map((w) => w.text), ['음', '어,', '그', '으음'], 'Korean: 음, 어, 으음 always; 그 only before a pause (not "그 사람이"), 뭐 and 저 not before words');
  const en = [word(0, 0.3, 'Um,'), word(0.4, 0.7, 'I'), word(0.8, 1, 'like'), word(1.1, 1.3, 'uh'), word(1.4, 1.8, 'hmm'), word(1.9, 2.2, 'this'), word(2.3, 2.4, 'er'), word(2.5, 2.6, 'ah'), word(2.7, 3, 'umbrella')];
  eq(en.filter((_, i) => Sp.isFiller(en, i, { pause: 0.3 * T })).map((w) => w.text), ['Um,', 'uh', 'hmm', 'er', 'ah'], 'English: um, uh, hmm, er, ah; never like or umbrella');
  const p = Sp.fillerPlan(ws, { frame: F, pauseLength: 1, keep: 0.15 });
  eq(p.fillers.length, 4, 'the plan finds the four fillers');
  check(p.pauses.length === 1 && Math.abs(p.pauses[0][0] - 5.15 * T) < F && Math.abs(p.pauses[0][1] - 6.25 * T) < F, `the 1.4 s pause before 저는 is cut, 0.15 s kept on each side (${S(p.pauses.map(([a, b]) => [a / T, b / T]))})`);
  check(p.ranges.every(([a, b]) => a % F === 0 && b % F === 0 && b > a), 'ranges on frames');
  const um = p.ranges.find(([a, b]) => a <= 0.6 * T && b >= 0.8 * T);
  check(um && um[0] >= 0.5 * T && um[1] <= 0.9 * T, `음 is cut with the pause around it, never into its neighbours (${S(um && um.map((x) => x / T))})`);
  check(!p.ranges.some(([a, b]) => a < 2.6 * T && b > 2.15 * T), '사람이 is never cut');
  const off = Sp.fillerPlan(ws, { frame: F, fillers: false, pauseLength: 1 });
  eq([off.fillers.length, off.ranges.length], [0, 1], 'fillers off: only the pause');
  const none = Sp.fillerPlan(ws, { frame: F, pauses: false });
  check(none.pauses.length === 0 && none.ranges.length >= 3, 'pauses off: only the fillers');
});

await section('delete words', () => {
  const ws = [word(0, 0.5, 'one'), word(0.7, 1.1, 'two'), word(1.3, 1.6, 'three'), word(2.5, 3, 'four')];
  const r = Sp.removalRanges(ws, [1], { frame: F });
  check(r.length === 1 && r[0][0] >= 0.5 * T && r[0][0] <= 0.7 * T && r[0][1] >= 1.1 * T && r[0][1] <= 1.3 * T, `deleting "two" takes it and the pauses up to its neighbours (${S(r.map(([a, b]) => [a / T, b / T]))})`);
  const both = Sp.removalRanges(ws, [2, 1], { frame: F });
  eq(both.length, 1, 'neighbouring words go as one range');
  const apart = Sp.removalRanges(ws, [0, 3], { frame: F });
  eq(apart.length, 2, 'words apart give a range each');
  check(apart[1][0] >= 1.6 * T + 0.08 * T - F && apart[1][0] >= 2.25 * T - F, 'a long pause before a deleted word is cut only 0.25 s back');
  eq(Sp.runs([5, 3, 4, 9]), [[3, 5], [9, 9]], 'runs of indexes');
});

await section('search', () => {
  const ws = ['안녕하세요.', '오늘은', '자막을', '만들어', '봅니다.', 'Hello,', 'World'].map((t, i) => word(i, i + 0.5, t));
  eq(Sp.search(ws, '자막'), [[2, 2]], 'a part of a word');
  eq(Sp.search(ws, '자막을 만들어'), [[2, 3]], 'words in order');
  eq(Sp.search(ws, 'hello world'), [[5, 6]], 'case and punctuation ignored');
  eq(Sp.search(ws, '  '), [], 'an empty query finds nothing');
});

// ---------- main/cut/speech-words.js ----------
const tone = (spans, seconds, { level = 0.3, freq = 440 } = {}) => {
  const a = new Float32Array(Math.round(seconds * R));
  for (const [x, y] of spans) for (let i = Math.round(x * R); i < Math.min(a.length, Math.round(y * R)); i++) a[i] = level * Math.sin((2 * Math.PI * freq * i) / R);
  return a;
};
await section('refine', () => {
  const a = tone([[1, 1.6], [2.4, 3]], 4);
  const out = W.refine(a, [[0, 1.9, 'first'], [1.9, 3.6, 'second'], [3.6, 4, 'quiet']]);
  check(Math.abs(out[0][0] - 0.98) < 0.03 && Math.abs(out[0][1] - 1.65) < 0.03, `a word starting at 0 (the window's start) moves to its sound (${S(out[0])})`);
  check(Math.abs(out[1][0] - 2.38) < 0.03 && Math.abs(out[1][1] - 3.05) < 0.03, `a word running into a pause ends with its sound (${S(out[1])})`);
  eq(out[2], [3.6, 4, 'quiet'], 'a word without sound keeps its times');
  const near = W.refine(a, [[0.95, 1.62, 'tight']]);
  eq(near[0], [0.95, 1.62, 'tight'], 'small differences are left alone');
  // a window starting mid-speech: its first word (lead) stretched back over speech it did not write out
  const b = tone([[0, 1.9], [3.88, 4.26], [4.3, 4.8]], 6);
  const head = W.refine(b, [[0, 4.26, '음성', 1], [4.26, 4.9, '인식은', 0]]);
  check(Math.abs(head[0][0] - 3.86) < 0.03 && Math.abs(head[0][1] - 4.26) < 0.03, `a segment's first word is its last run of sound (${S(head[0])})`);
  // a neighbour's last syllable reaching into a word that took the pause before it
  const c = tone([[1, 1.3], [1.7, 2.3]], 3);
  const leak = W.refine(c, [[1.25, 2.4, 'word', 0]]);
  check(Math.abs(leak[0][0] - 1.68) < 0.03, `any other word is its longest run (${S(leak[0])})`);
});
await section('bursts', () => {
  const a = tone([[0.5, 0.8], [0.82, 1.0], [2, 2.02], [3, 3.5]], 4);
  eq(W.bursts(a), [[0.5, 1], [3, 3.5]], 'bursts: a short gap joined, a 20 ms blip dropped');
  const words = W.fakeWords(tone([[1, 1.3], [2, 2.3], [29.9, 30]], 30), { offset: 0, total: 60 * R, language: 'ko' });
  eq(words.map((w) => w[2]), [W.FAKE_WORDS.ko[2], W.FAKE_WORDS.ko[4]], 'the fake names a burst by its half second; one cut by the window end is left to the next window');
  const later = W.fakeWords(tone([[1, 1.3]], 10), { offset: 25 * R, total: 60 * R, language: 'en' });
  eq(later.map((w) => w[2]), [W.FAKE_WORDS.en[52 % 10]], 'a later window names its bursts by their time in the file');
});

// ---------- main/cut/whisper.js with the fake backend ----------
await section('main', async () => {
  eq(['No Python interpreter found', 'PyTorch has no build for Python 3.14', 'OSError: [Errno 28] No space left on device', 'ERROR: Could not find a version that satisfies the requirement torch\nERROR: No matching distribution found for torch',
    'requests.exceptions.ConnectionError: Failed to establish a new connection: [Errno 11001] getaddrinfo failed', 'Cancelled', 'python.exe exited with code 1']
    .map(classify), ['noPython', 'noTorch', 'disk', 'offline', 'offline', 'cancelled', 'failed'], 'setup errors are classified for the screen');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cut-speech-'));
  try {
    const sp = createSpeech({ script: 'none.py', tmpDir: tmp, env: { PYIDE_WHISPER_BACKEND: 'fake' } });
    const st = sp.status();
    check(st.backend === 'fake' && st.runtime && st.models.every((m) => m.installed) && st.models.map((m) => m.id).join() === 'whisper-small,whisper-large-v3-turbo', 'status: the fake backend, both models ready');
    const f = await sp.open(1);
    check(/^s\d+$/.test(f.id) && readdirSync(tmp).length === 1, 'open makes one temp file');
    const sound = tone([[1, 1.3], [2, 2.3], [3, 3.3]], 40);
    const bytes = new Uint8Array(sound.buffer);
    const half = Math.floor(bytes.length / 8) * 4;
    const w1 = await sp.write(1, f.id, bytes.slice(0, half));
    const w2 = await sp.write(1, f.id, bytes.slice(half));
    check(w1.ok && w2.ok && w2.samples === sound.length, 'writes append');
    eq((await sp.write(2, f.id, bytes.slice(0, 4))).code, 'notFound', 'another window cannot write into it');
    eq((await sp.write(1, f.id, bytes.slice(0, 6))).code, 'badArgs', 'only whole float32 samples');
    eq((await sp.transcribe(1, f.id, { offset: 0, length: 32 * R })).code, 'tooLarge', 'a window is 31 s at most');
    eq((await sp.transcribe(2, f.id, { offset: 0, length: R })).code, 'notFound', 'another window cannot read it');
    const r = await sp.transcribe(1, f.id, { offset: 0, length: 30 * R, language: 'ko', request: 'a' });
    eq(r.words.map((x) => x[2]), [2, 4, 6].map((k) => W.FAKE_WORDS.ko[k]), 'the fake hears the three bursts');
    check(Math.abs(r.words[0][0] - 1) < 0.02 && Math.abs(r.words[0][1] - 1.3) < 0.02, 'with their times');
    const r2 = await sp.transcribe(1, f.id, { offset: R * 1.5, length: 10 * R, language: 'en', request: 'b' });
    check(r2.words.length === 2 && Math.abs(r2.words[0][0] - 0.5) < 0.02 && r2.words[0][2] === W.FAKE_WORDS.en[4], 'a window later in the file: times from its start, words named by the file time');
    sp.testConfig({ delay: 2000 });
    const slow = sp.transcribe(1, f.id, { offset: 0, length: R * 10, request: 'c' });
    setTimeout(() => sp.cancel(1, 'c'), 50);
    const t0 = Date.now();
    check((await slow).cancelled && Date.now() - t0 < 1500, 'a cancelled window answers at once');
    sp.testConfig({ delay: 0 });
    await sp.close(1, f.id);
    eq(readdirSync(tmp).length, 0, 'close deletes the temp file');
    const g = await sp.open(7);
    await sp.write(7, g.id, bytes.slice(0, 400));
    await sp.ownerGone(7);
    eq(readdirSync(tmp).length, 0, 'a window that goes takes its files');
    // the setup flow
    const fresh = createSpeech({ script: 'none.py', tmpDir: tmp, env: { PYIDE_WHISPER_BACKEND: 'fake', PYIDE_WHISPER_FAKE_SETUP: 'ok' } });
    const s0 = fresh.status();
    check(!s0.runtime && s0.models.every((m) => !m.installed), 'with a pretend setup, nothing is ready at first');
    const h = await fresh.open(1);
    await fresh.write(1, h.id, bytes.slice(0, R * 4));
    eq((await fresh.transcribe(1, h.id, { offset: 0, length: R })).code, 'notInstalled', 'recognising before the download says so');
    const events = [];
    const sender = { send: (ch, p) => events.push([ch, p]), isDestroyed: () => false };
    const done = await fresh.setup('whisper-small', sender);
    check(done.ok && fresh.status().runtime && fresh.status().models.find((m) => m.id === 'whisper-small').installed, 'the setup makes the runtime and the model ready');
    check(!fresh.status().models.find((m) => m.id === 'whisper-large-v3-turbo').installed, 'only the chosen model');
    const fr = events.filter(([ch, p]) => ch === 'cut:speechProgress' && p.phase === 'download').map(([, p]) => p.fraction);
    check(fr.length === 10 && fr.every((x, i) => !i || x > fr[i - 1]) && fr.at(-1) === 1, `download progress rises to 1 (${S(fr)})`);
    check(events.some(([, p]) => p.phase === 'runtime'), 'the runtime step is reported');
    await fresh.close(1, h.id);
    for (const code of ['offline', 'disk', 'noPython']) {
      const bad = createSpeech({ script: 'none.py', tmpDir: tmp, env: { PYIDE_WHISPER_BACKEND: 'fake', PYIDE_WHISPER_FAKE_SETUP: code } });
      const res = await bad.setup('whisper-small', sender);
      check(!res.ok && res.code === code && !bad.status().runtime, `a failed setup (${code}) says why and leaves nothing ready`);
    }
    const cancelMe = createSpeech({ script: 'none.py', tmpDir: tmp, env: { PYIDE_WHISPER_BACKEND: 'fake', PYIDE_WHISPER_FAKE_SETUP: 'ok' } });
    const pending = cancelMe.setup('whisper-small', sender);
    setTimeout(() => cancelMe.cancelSetup(), 150);
    eq((await pending).code, 'cancelled', 'the setup can be cancelled');
    // files left by a process that is gone are removed at start
    const { writeFileSync } = await import('fs');
    writeFileSync(path.join(tmp, '999999-s1.f32'), 'x');
    createSpeech({ script: 'none.py', tmpDir: tmp, env: { PYIDE_WHISPER_BACKEND: 'fake' } });
    await new Promise((r3) => setTimeout(r3, 100));
    check(!existsSync(path.join(tmp, '999999-s1.f32')), 'a temp file of an ended process is removed at start');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- as a page script ----------
await section('page', () => {
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, Error, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8ClampedArray, Promise, RegExp };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const dir = new URL('../renderer/features/cut/', import.meta.url);
  const order = readFileSync(new URL('index.js', dir), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  const mine = ['time.js', 'model.js', 'keyframes.js', 'effects.js', 'analyze.js', 'speech.js'];
  check(order.indexOf('speech.js') > order.indexOf('analyze.js') && order.indexOf('ui-speech.js') > order.indexOf('ui-auto.js'), 'index.js loads speech.js after analyze.js and ui-speech.js after ui-auto.js');
  for (const file of order.filter((x) => mine.includes(x))) vm.runInContext(readFileSync(new URL(file, dir), 'utf8'), page, { filename: file });
  const out = vm.runInContext(`(() => {
    const T = Cut.time.TICKS;
    const c = Cut.speech.captions([{ t0: 0, t1: T / 2, text: '안녕하세요.' }, { t0: 1.5 * T, t1: 2 * T, text: '반갑습니다.' }], { frame: Cut.time.frameTicks([30, 1]) });
    return [c.length, Cut.speech.clipWords({ id: 'c', start: 0, in: 0, out: 10 * T, speed: 1, source: {} }, [[1, 2, 'x']]).length];
  })()`, page);
  eq(out, [2, 1], 'speech.js works as a page script through globalThis.Cut');
  check(!!model.clipEnd, 'model loads');
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
