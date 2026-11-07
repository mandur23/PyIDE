// Nano Studio Cut's speaker labels, their pure parts and their main side, in plain Node (no model, no Electron):
// - windows from word times (segments at pauses, one window for a short segment and the silence around one too
//   short, 2 s windows every 1 s over a long one);
// - average-linkage clustering of embeddings (Auto by the threshold, a fixed count, stray windows joining the
//   nearest speaker, numbering by first appearance, the same tree as a brute-force greedy one);
// - each word's speaker from the windows, a short flip inside a segment smoothed away, a short turn of its own kept;
// - turns (the silence between speakers split; overlapping word times, a word swallowed by another speaker's and
//   2,000 random lists, always valid), the speaker at a time, a segment given to another speaker, labels made again
//   matched to the speakers of before so names and colors stay, an id a caption still names never given to a new one;
// - the project shape (validate), setSpeakers with undo and redo, a caption's speaker through setCaptions and
//   setCaption, the labels through save and reload (JSON, migrate, a new history);
// - captions: the name before the text and the color for the compositor, the name in SRT text, nothing without
//   the track's options;
// - main/cut/speakers.js: the fake backend's embeddings tell two tones apart, bad windows refused, cancel (also of a
//   closed window's embeddings, not another's), status
//   with an empty Hugging Face cache (missing) and the fake setup (offline, then ready);
// - speakers.js as a page script next to an AMD `require` (Monaco's loader.js), in index.js order.
// Usage: node verify/cut-speakers-core.mjs
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const K = require('../renderer/features/cut/speakers.js');
const C = require('../renderer/features/cut/commands.js');
const { createSpeakers, fakeEmbedding } = require('../main/cut/speakers.js');

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const T = time.TICKS;
const R = 16000;
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }

// A random unit vector near `center` (spread: the noise's size).
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const centers = Array.from({ length: 4 }, () => Array.from({ length: 32 }, gauss));
const near = (k, spread = 0.6) => centers[k].map((x) => x + spread * gauss() * 1.0);

await section('windows', () => {
  const w = [{ t0: 0, t1: 0.4 }, { t0: 0.5, t1: 0.9 }, { t0: 2, t1: 2.3 }, { t0: 5, t1: 6 }, { t0: 6.1, t1: 7 }, { t0: 7.1, t1: 9.5 }];
  eq(K.segments(w), [[0, 1], [2, 2], [3, 5]], 'words split into segments at pauses of 0.3 s');
  const win = K.windowsOf(w);
  eq(win.filter((x) => x.seg === 0).map((x) => [x.t0, +x.t1.toFixed(3)]), [[0, 1]], 'a segment of 0.9 s at the start gets a 1 s window, the missing time taken after it');
  const one = win.filter((x) => x.seg === 1)[0];
  check(Math.abs(one.t1 - one.t0 - 1) < 1e-9 && one.t0 < 2 && one.t1 > 2.3, 'a lone 0.3 s word gets a 1 s window around it');
  eq(win.filter((x) => x.seg === 1)[0].speech.toFixed(2), '0.30', 'the window keeps how much speech it holds');
  eq(win.filter((x) => x.seg === 2).map((x) => [x.t0, x.t1]), [[5, 8], [6.5, 9.5]], 'a 4.5 s segment (over 4 s) gets two 3 s windows from its start to its end');
  const long = K.windowsOf(w, { short: 3, size: 2, hop: 1 }).filter((x) => x.seg === 2);
  check(long.length === 4 && long[0].t0 === 5 && Math.abs(long.at(-1).t1 - 9.5) < 1e-9 && long.every((x) => Math.abs(x.t1 - x.t0 - 2) < 1e-9), 'with short 3 and size 2 it is covered by four 2 s windows from its start to its end');
  check(K.windowsOf([{ t0: 0, t1: 9 }]).length === 5, 'a 9 s segment gets 3 s windows about every 1.5 s');
  // a sentence's end splits a segment even without a pause (noise hides the pause between speakers)
  const s = [{ t0: 0, t1: 1, text: '볼게요.' }, { t0: 1.05, t1: 2, text: '좋습니다' }, { t0: 2.05, t1: 3, text: 'Okay?"' }, { t0: 3.1, t1: 4, text: 'Yes' }];
  eq(K.segments(s), [[0, 0], [1, 2], [3, 3]], 'segments split after . ? ! (and a closing quote)');
  eq(K.segments(s, { sentences: false }), [[0, 3]], 'not with sentences off');
});

await section('clustering', () => {
  const merges = K.tree([[1, 0], [0.9, 0.1], [0, 1], [0.1, 0.9]].map((v) => { const n = Math.hypot(...v); return v.map((x) => x / n); }));
  eq(merges.length, 3, 'n - 1 merges');
  check(merges[0].sim > merges[1].sim - 1e-12 && merges[1].sim > merges[2].sim, 'merges come most similar first');
  // the NN-chain tree against a brute-force greedy average-linkage tree
  const pts = Array.from({ length: 40 }, (_, i) => near(i % 3, 1.2));
  const unit = pts.map((v) => { const n = Math.hypot(...v); return v.map((x) => x / n); });
  const nn = K.tree(unit).map((m) => m.sim.toFixed(9)).sort();
  const groups = unit.map((_, i) => [i]);
  const sim = (a, b) => { let s = 0; for (const i of a) for (const j of b) s += unit[i].reduce((n, x, d) => n + x * unit[j][d], 0); return s / (a.length * b.length); };
  const brute = [];
  while (groups.length > 1) {
    let best = [-1, -1, -Infinity];
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) { const s = sim(groups[i], groups[j]); if (s > best[2]) best = [i, j, s]; }
    brute.push(best[2].toFixed(9));
    groups[best[0]] = groups[best[0]].concat(groups[best[1]]);
    groups.splice(best[1], 1);
  }
  eq(nn, brute.sort(), 'the NN-chain tree has the same merge heights as the greedy one');

  const emb = [];
  const speech = [];
  const truth = [];
  for (let i = 0; i < 60; i++) { const k = [0, 1, 0, 2][Math.floor(i / 5) % 4]; emb.push(near(k)); speech.push(2); truth.push(k); }
  const auto = K.cluster(emb, speech, { threshold: 0.4 });
  eq(new Set(auto).size, 3, 'Auto finds the three speakers');
  eq(auto.slice(0, 1).concat(auto.slice(5, 6), auto.slice(15, 16)), [0, 1, 2], 'speakers are numbered by first appearance');
  check(auto.every((l, i) => l === truth[i]), 'every window has its speaker');
  eq(new Set(K.cluster(emb, speech, { count: 2 })).size, 2, 'a fixed count of 2 gives two speakers');
  const four = new Set(K.cluster(emb, speech, { count: 4 })).size;
  check(four >= 3 && four <= 4, `a fixed count of 4 gives at most four (${four})`);
  // a stray window (little speech) does not become a speaker of its own
  const stray = [...emb, near(3)];
  const sp = [...speech, 0.5];
  const withStray = K.cluster(stray, sp, { threshold: 0.4 });
  eq(new Set(withStray).size, 3, 'a 0.5 s window unlike the others joins the nearest speaker');
  // a fixed count with one odd short window: cutting the tree at 3 keeps it as a speaker and joins two real ones
  {
    let s2 = 3;
    const r2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; };
    const g2 = () => Math.sqrt(-2 * Math.log(r2() + 1e-12)) * Math.cos(2 * Math.PI * r2());
    const base = () => Array.from({ length: 32 }, g2);
    const A = base();
    const B = base();
    const Cv = A.map((x) => 0.7 * x + 0.71 * g2());
    const jitter = (v) => v.map((x) => x + 0.5 * g2());
    const e2 = [...Array.from({ length: 20 }, () => jitter(A)), ...Array.from({ length: 20 }, () => jitter(B)), ...Array.from({ length: 12 }, () => jitter(Cv)), base()];
    const sp2 = e2.map((_, i) => (i === 52 ? 1 : 2));
    const groupsOf = (l) => [[0, 20], [20, 40], [40, 52]].map(([a, b]) => new Set(l.slice(a, b)));
    const three = groupsOf(K.cluster(e2, sp2, { count: 3 }));
    check(three.every((g) => g.size === 1) && new Set(three.map((g) => [...g][0])).size === 3, 'a fixed count of 3 keeps the three speakers apart and the odd window joins one');
    const naive = groupsOf(K.cluster(e2, sp2, { count: 3, spare: 0 }));
    check(new Set(naive.map((g) => [...g][0])).size < 3, 'cutting the tree at 3 itself would have joined two of them (the case the spare clusters are for)');
  }
  eq(K.cluster([null, near(0), near(0)], [2, 2, 2], {}), [-1, 0, 0], 'a window without an embedding gets -1');
  eq(K.cluster([], [], {}), [], 'no windows, no labels');
});

await section('words and turns', () => {
  // A speaks 0-4 s, B 4.6-8 s, inside B one window flips to A
  const words = [];
  for (let t = 0; t < 4; t += 0.5) words.push({ t0: t, t1: t + 0.4 });
  for (let t = 4.6; t < 8; t += 0.5) words.push({ t0: t, t1: t + 0.4 });
  const windows = K.windowsOf(words);
  const labels = windows.map((w) => (w.t0 >= 4.5 ? 1 : 0));
  const flip = windows.findIndex((w) => w.t0 > 5.5 && w.t0 < 6.6);
  labels[flip] = 0;
  const wl = K.wordLabels(words, windows, labels);
  eq(wl.slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0], 'the first speaker\'s words');
  eq(wl.slice(8), [1, 1, 1, 1, 1, 1, 1], 'a flip inside the second speaker\'s segment is smoothed away');
  // a short turn of its own (after a pause) stays
  const w2 = [{ t0: 0, t1: 3 }, { t0: 3.5, t1: 4 }, { t0: 4.5, t1: 8 }];
  const win2 = K.windowsOf(w2);
  eq(K.wordLabels(w2, win2, win2.map((w) => (w.seg === 1 ? 1 : 0))), [0, 1, 0], 'a 0.5 s answer between pauses keeps its speaker');
  const turns = K.turnsOf([{ t0: 0, t1: 1 }, { t0: 1.2, t1: 2 }, { t0: 3, t1: 4 }, { t0: 4.1, t1: 5 }], ['a', 'a', 'b', null]);
  eq(turns, [[0, 2.5, 'a'], [2.5, 4, 'b']], 'turns join a speaker\'s words and split the silence between speakers');
  const spList = ['sp1', 'sp2', 'sp3'].map((id, k) => ({ id, name: '', color: K.PALETTE[k] }));
  const turnsValid = (t) => {
    const p = model.createProject();
    p.speakers = { list: spList, turns: { m1: t }, count: 0 };
    return model.validate(p).ok;
  };
  const swallowed = K.turnsOf([{ t0: 0, t1: 3 }, { t0: 2, t1: 2.5 }, { t0: 2.6, t1: 4 }], ['sp1', 'sp2', 'sp1']);
  eq(swallowed, [[0, 4, 'sp1']], 'a word inside another speaker\'s word is swallowed and the speaker\'s turns join');
  check(turnsValid(swallowed), 'and the turns validate');
  let bad = null;
  let s2 = 11;
  const rnd = () => { s2 = (s2 * 1103515245 + 12345) % 2147483648; return s2 / 2147483648; };
  for (let n = 0; n < 2000 && !bad; n++) {
    const ws = [];
    let t = rnd() * 2;
    for (let k = 0, len = 1 + Math.floor(rnd() * 12); k < len; k++) {
      t += rnd() < 0.3 ? -rnd() * 0.8 : rnd() * 0.6;
      t = Math.max(0, t);
      ws.push({ t0: +t.toFixed(4), t1: +(t + (rnd() < 0.1 ? 0.0004 : rnd() * 1.5)).toFixed(4) });
    }
    ws.sort((a, b) => a.t0 - b.t0);
    const who = ws.map(() => [null, 'sp1', 'sp2', 'sp3'][Math.floor(rnd() * 4)]);
    const got = K.turnsOf(ws, who);
    const joined = got.every((x, k) => k === 0 || got[k - 1][2] !== x[2]);
    if (!turnsValid(got) || !joined) bad = S({ ws, who, got });
  }
  check(!bad, `turns of 2000 random overlapping words always validate, neighbours of one speaker joined${bad ? ` (${bad})` : ''}`);
  eq([K.at(turns, 1), K.at(turns, 3), K.at(turns, 4.5), K.at(turns, 6), K.at([], 1)], ['a', 'b', 'b', null, null], 'the speaker at a time, near a turn within 1 s, else none');
  eq(K.assign(turns, 1, 2, 'b'), [[0, 1, 'a'], [1, 2, 'b'], [2, 2.5, 'a'], [2.5, 4, 'b']], 'a segment given to another speaker splits the turn around it');
  eq(K.assign(turns, 2, 2.5, 'b'), [[0, 2, 'a'], [2, 4, 'b']], 'and joins the neighbouring turn of that speaker');
  const m = K.match({ m1: [[0, 5, 'sp1'], [5, 10, 'sp2']] }, { m1: [[0, 4.8, '1'], [4.8, 10, '0']] }, ['0', '1']);
  eq([m.get('0'), m.get('1')], ['sp2', 'sp1'], 'labels made again are matched to the speakers of before by shared time');
  const before = { list: [{ id: 'sp1', name: 'Mina', color: K.PALETTE[0] }, { id: 'sp2', name: '', color: K.PALETTE[1] }], turns: {}, count: 0 };
  const made = K.listFor(3, before, m);
  eq(made.ids, ['sp2', 'sp1', 'sp3'], 'matched speakers keep their ids; a new one gets the next');
  eq(made.list.map((s) => s.name), ['', 'Mina', ''], 'and their names');
  check(new Set(made.list.map((s) => s.color)).size === 3, 'the new speaker gets a color not used yet');
  const left = { speakers: { list: [before.list[0]], turns: {}, count: 0 }, sequences: [{ captions: [] }, { captions: [{ items: [{ speaker: 'sp2' }, {}] }] }] };
  eq(K.inUse(left), ['sp1', 'sp2'], 'the ids in use: the list and the captions of every sequence');
  const again = K.listFor(2, left.speakers, new Map([['0', 'sp1']]), K.inUse(left));
  eq(again.ids, ['sp1', 'sp3'], 'a speaker that left the list while a caption in another sequence still names it never gives its id to a new one');
  eq(K.nameOf(made, 'sp3'), 'Speaker 3', 'an unnamed speaker is "Speaker N" by its place');
  eq(K.nameOf(made, 'sp1', (s, p) => `화자 ${p.n}`), 'Mina', 'a named one is its name');
});

await section('project and commands', () => {
  const p = model.createProject({ sequence: { fps: [30, 1] } });
  const h = C.createHistory(p);
  const ids = h.do(C.importMedia([{ path: 'C:\\x.wav', name: 'x.wav', kind: 'audio', duration: 20 * T, size: 1, mtime: 1, video: null, audio: { rate: 48000, channels: 1, codec: 'pcm-s16' } }])).ids;
  const seq = h.project.sequences[0];
  const list = [{ id: 'sp1', name: '', color: '#4fc3f7' }, { id: 'sp2', name: '', color: '#ffb74d' }];
  h.do(C.batch('Label Speakers', [C.setSpeakers({ list, turns: { [ids[0]]: [[0, 5, 'sp1'], [5, 9, 'sp2']] }, count: 0 })]));
  eq(h.project.speakers.turns[ids[0]].length, 2, 'setSpeakers keeps the turns');
  eq(h.list().at(-1).label, 'Label Speakers', 'as one step with its label');
  check(model.validate(h.project).ok, 'the project validates');
  let threw = null;
  try { h.do(C.setSpeakers({ turns: { [ids[0]]: [[0, 5, 'sp9']] } })); } catch (err) { threw = err; }
  check(threw && h.project.speakers.turns[ids[0]].length === 2, 'a turn of a speaker not in the list is refused and changes nothing');
  try { threw = null; h.do(C.setSpeakers({ turns: { [ids[0]]: [[3, 2, 'sp1']] } })); } catch (err) { threw = err; }
  check(!!threw, 'a turn that ends before it starts is refused');
  h.do(C.setSpeakers({ list: list.map((s) => (s.id === 'sp2' ? { ...s, name: 'Jun' } : s)) }));
  eq(K.nameOf(h.project.speakers, 'sp2'), 'Jun', 'rename');
  h.undo();
  eq(K.nameOf(h.project.speakers, 'sp2'), 'Speaker 2', 'rename undone');
  h.redo();
  eq(K.nameOf(h.project.speakers, 'sp2'), 'Jun', 'rename redone');
  const tid = h.do(C.addCaptionTrack(seq.id, { name: 'A', items: [{ start: 0, end: T, text: 'hi', speaker: 'sp1' }, { start: T, end: 2 * T, text: 'yo' }], style: { speakerName: true, speakerColor: true } })).id;
  const ct = () => h.project.sequences[0].captions.find((c) => c.id === tid);
  eq(ct().items.map((it) => it.speaker ?? null), ['sp1', null], 'a caption keeps its speaker');
  h.do(C.setCaption(seq.id, tid, ct().items[1].id, { speaker: 'sp2' }));
  h.do(C.setCaption(seq.id, tid, ct().items[1].id, { text: 'yo!' }));
  eq(ct().items[1].speaker, 'sp2', 'setCaption sets a speaker, and a text change keeps it');
  h.do(C.setCaption(seq.id, tid, ct().items[1].id, { speaker: null }));
  check(!('speaker' in ct().items[1]), 'speaker: null takes it away');
  h.undo();
  eq(ct().items[1].speaker, 'sp2', 'undone');
  try { threw = null; h.do(C.setCaption(seq.id, tid, ct().items[1].id, { speaker: 'nobody' })); } catch (err) { threw = err; }
  check(!!threw, 'a speaker id of the wrong shape is refused');
  const saved = h.serialize();
  const h2 = C.createHistory(model.migrate(saved));
  eq([h2.project.speakers, h2.project.sequences[0].captions[0].items.map((it) => it.speaker ?? null)], [h.project.speakers, ['sp1', 'sp2']], 'speaker labels and caption speakers survive save and reload');
  // shown and written
  const sp = h.project.speakers;
  const deco = K.decorate(h.project, [{ style: ct().style, items: ct().items }], (s, p) => `Speaker ${p.n}`);
  eq(deco[0].items.map((it) => [it.prefix, it.color]), [['Speaker 1: ', '#4fc3f7'], ['Jun: ', '#ffb74d']], 'the compositor gets each caption\'s name prefix and color');
  eq(K.decorate(h.project, [{ style: {}, items: ct().items }])[0].items[0].prefix, undefined, 'a track without the options is drawn as it was');
  eq(K.written(h.project, ct(), ct().items).map((it) => it.text), ['Speaker 1: hi', 'Jun: yo!'], 'SRT text has the names when the track shows them');
  eq(K.written(h.project, { style: { speakerColor: true } }, ct().items).map((it) => it.text), ['hi', 'yo!'], 'colors alone leave the text');
  eq(K.colorOf(sp, 'sp2'), '#ffb74d', 'colorOf');
  h.do(C.setSpeakers(null));
  check(!h.project.speakers && model.validate(h.project).ok, 'setSpeakers(null) takes the labels away');
  h.undo();
  check(!!h.project.speakers, 'and undo brings them back');
});

await section('main side', async () => {
  // two tones are two speakers to the fake backend
  const tone = (f) => Float32Array.from({ length: R * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / R));
  const unit = (v) => { const n = Math.hypot(...v); return [...v].map((x) => x / n); };
  const cos = (a, b) => unit(a).reduce((n, x, i) => n + x * unit(b)[i], 0);
  const a1 = fakeEmbedding(tone(300));
  const a2 = fakeEmbedding(tone(300).map((x, i) => x * (1 + 0.1 * Math.sin(i / 900))));
  const b = fakeEmbedding(tone(1500));
  check(cos(a1, a2) > 0.95 && cos(a1, b) < 0.3, `the fake embedding: same tone ${cos(a1, a2).toFixed(2)}, other tone ${cos(a1, b).toFixed(2)}`);
  const sound = new Float32Array(R * 4);
  sound.set(tone(300), 0);
  sound.set(tone(1500), R * 2);
  const speech = { sound: async (owner, id) => (owner === 1 && id === 's1' ? { file: 'x.f32', samples: sound.length, read: async (o, n) => sound.subarray(o, o + n) } : null) };
  const sk = createSpeakers({ script: 'none.py', speech, env: { PYIDE_SPEAKERS_BACKEND: 'fake' } });
  const st = sk.status();
  check(st.backend === 'fake' && st.runtime && st.model.installed, 'the fake backend is ready');
  const r = await sk.embed(1, 's1', { windows: [[0, R], [R, R], [2 * R, R], [3 * R, R]], request: 'a' });
  const rows = [0, 1, 2, 3].map((k) => new Float32Array(r.data.buffer, r.data.byteOffset + k * r.dim * 4, r.dim));
  check(r.dim === 24 && r.data.length === 4 * 24 * 4, 'one row of 24 floats per window');
  eq(K.cluster(rows, [1, 1, 1, 1], { threshold: 0.45 }), [0, 0, 1, 1], 'the fake\'s embeddings cluster into the two tones');
  eq((await sk.embed(2, 's1', { windows: [[0, R]] })).code, 'notFound', 'another window\'s sound file is refused');
  eq((await sk.embed(1, 's1', { windows: [[0, 31 * R]] })).code, 'badArgs', 'a window over 30 s is refused');
  eq((await sk.embed(1, 's1', { windows: [[-1, R]] })).code, 'badArgs', 'a negative offset is refused');
  sk.testConfig({ delay: 30 });
  const slow = sk.embed(1, 's1', { windows: Array.from({ length: 50 }, () => [0, R]), request: 'b' });
  setTimeout(() => sk.cancel(1, 'b'), 60);
  eq(await slow, { cancelled: true }, 'cancel stops an embedding between windows');
  const anyOwner = { sound: async () => ({ file: 'x.f32', samples: sound.length, read: async (o, n) => sound.subarray(o, o + n) }) };
  const two = createSpeakers({ script: 'none.py', speech: anyOwner, env: { PYIDE_SPEAKERS_BACKEND: 'fake' } });
  two.testConfig({ delay: 20 });
  const many = Array.from({ length: 20 }, () => [0, R]);
  const mine = two.embed(4, 's1', { windows: many, request: 'x' });
  const other = two.embed(5, 's1', { windows: many, request: 'x' });
  setTimeout(() => two.ownerGone?.(4), 60);
  eq([!!(await mine).cancelled, !!(await other).cancelled], [true, false], 'a window that goes cancels its own embeddings, not another window\'s');

  // the real backend's status with an empty Hugging Face cache: the model is missing
  const empty = mkdtempSync(path.join(os.tmpdir(), 'spk-hf-'));
  const old = process.env.HF_HUB_CACHE;
  process.env.HF_HUB_CACHE = empty;
  try {
    const real = createSpeakers({ script: 'none.py', speech, env: {} });
    const s2 = real.status();
    check(s2.backend === 'wespeaker' && s2.model.installed === false && s2.model.repo === 'Wespeaker/wespeaker-voxceleb-resnet34-LM', 'with an empty model cache the model is missing');
    eq((await real.embed(1, 's1', { windows: [[0, R]] })).code, 'notInstalled', 'and embedding says it is not installed');
  } finally {
    if (old === undefined) delete process.env.HF_HUB_CACHE; else process.env.HF_HUB_CACHE = old;
    rmSync(empty, { recursive: true, force: true });
  }
  const sent = [];
  const sender = { send: (ch, p) => sent.push([ch, p.phase, p.fraction]), isDestroyed: () => false };
  const off = createSpeakers({ script: 'none.py', speech, env: { PYIDE_SPEAKERS_BACKEND: 'fake', PYIDE_SPEAKERS_FAKE_SETUP: 'offline' } });
  check(!off.status().model.installed, 'the fake setup starts with the model missing');
  eq((await off.setup(sender)).code, 'offline', 'its download fails offline with a code');
  const ok = createSpeakers({ script: 'none.py', speech, env: { PYIDE_SPEAKERS_BACKEND: 'fake', PYIDE_SPEAKERS_FAKE_SETUP: 'ok' } });
  eq((await ok.setup(sender)).ok, true, 'the pretend download succeeds');
  check(ok.status().model.installed && sent.some(([ch, ph]) => ch === 'cut:speakersProgress' && ph === 'done'), 'then the model is there, with progress on cut:speakersProgress');
});

await section('page', () => {
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, Error, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8ClampedArray, Promise, RegExp };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const dir = new URL('../renderer/features/cut/', import.meta.url);
  const order = readFileSync(new URL('index.js', dir), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  check(order.indexOf('speakers.js') > order.indexOf('speech.js') && order.indexOf('ui-speakers.js') > order.indexOf('ui-speech.js') && order.indexOf('speakers.js') < order.indexOf('ui-base.js'), 'index.js loads speakers.js after speech.js and ui-speakers.js after ui-speech.js');
  vm.runInContext(readFileSync(new URL('speakers.js', dir), 'utf8'), page, { filename: 'speakers.js' });
  const out = vm.runInContext('Cut.speakers.cluster([[1, 0], [0.9, 0.1], [0, 1]], [2, 2, 2], { count: 2 })', page);
  eq([...out], [0, 0, 1], 'speakers.js works as a page script through globalThis.Cut');
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
