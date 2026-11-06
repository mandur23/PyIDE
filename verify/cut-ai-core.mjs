// Nano Studio Cut's text AI, its pure parts and its main side, in plain Node (no Electron, never the real Claude):
// - JSON out of an answer (fenced, bare, inside prose), the retry prompt with the reason;
// - transcripts as prompt lines, condensed the same way every time within the budget (the first and last line kept);
// - prompts: what each task sends (text only: no paths), polish and translate answers checked line by line;
// - YouTube metadata: chapters fixed for YouTube (0:00 first, 10 s apart, inside the video, the last 10 s long, at
//   least 3 or refused), titles of 100 characters at most, tags without # or duplicates within 500 characters;
// - highlights inside the sequence, within the lengths, on frames, never overlapping; the ranges a shorts copy drops;
//   the scale that fits or fills a 9:16 frame;
// - edit plans: every whitelisted operation checked strictly (unknown operations and fields, prototype names, bad
//   tracks and times refused), described, turned into commands that apply as one undo step on a real project
//   (times those of the timeline before the plan), and undone exactly;
// - caption line breaking for ko, en, ja, zh, es with the editor's rules, the polish diff;
// - main/cut/ai.js: request checks, progress, cancel, the time limit, a window's requests ending with it; the fake CLI
//   (verify/fake-claude-cut.mjs) through main/ai/claude.js, including PYIDE_CLAUDE_PATH=none;
// - ai.js as a page script next to an AMD `require` (Monaco's loader.js), in index.js order.
// Usage: node verify/cut-ai-core.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const C = require('../renderer/features/cut/commands.js');
const AI = require('../renderer/features/cut/ai.js');
const { createAi } = require('../main/cut/ai.js');

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }
const T = time.TICKS;
const F = time.frameTicks([30, 1]);
const chars = (s) => [...s].length;
const refused = (r, re, label) => check(!!r.error && (!re || re.test(r.error)), `${label}${r.error ? ` (${r.error})` : ': accepted'}`);

// ---------- JSON out of answers ----------
await section('json', () => {
  eq(AI.parseJson('```json\n{"a": 1}\n```').value, { a: 1 }, 'a fenced block');
  eq(AI.parseJson('Sure! Here it is:\n```\n[1, 2]\n```\nAnything else?').value, [1, 2], 'a fenced block without a language, inside prose');
  eq(AI.parseJson('{"ops": []}').value, { ops: [] }, 'a bare value');
  eq(AI.parseJson('The plan is {"ops": [{"op": "cut"}]} as asked.').value, { ops: [{ op: 'cut' }] }, 'a value inside prose');
  eq(AI.parseJson('```json\n{bad\n```\n{"x": 2}').value, { x: 2 }, 'a broken fence, then a value that parses');
  check(!!AI.parseJson('no json here').error && !!AI.parseJson('').error && !!AI.parseJson('{"a": ').error, 'no value: an error, never a throw');
  const p = AI.retryPrompt('Task: x\nAsk', 'nonsense', 'The answer has no JSON value.');
  check(p.startsWith('Task: x\nAsk') && p.includes('could not be used: The answer has no JSON value.') && p.includes('nonsense'), 'the retry prompt repeats the request with the reason and the refused answer');
});

// ---------- transcripts ----------
await section('condense', () => {
  const segs = Array.from({ length: 400 }, (_, i) => ({ start: i * 3 * T, end: (i * 3 + 2.5) * T, text: `문장 ${i} ${'가나다라 '.repeat(i % 7)}` }));
  const small = AI.condense(segs.slice(0, 5));
  check(!small.trimmed && small.kept === 5 && small.text.split('\n')[1] === `[3.0-5.5] ${segs[1].text.trim().replace(/\s+/g, ' ')}`, `a short transcript goes whole, as "[start-end] text" (${small.text.split('\n')[1]})`);
  const big = AI.condense(segs, { budget: 3000 });
  check(big.trimmed && big.text.length <= 3000 && big.kept < 400 && big.lines === 400, `a long one is trimmed within the budget (${big.text.length} characters, ${big.kept} of ${big.lines} lines)`);
  const lines = big.text.split('\n');
  check(lines[0].startsWith('[0.0-2.5]') && lines.at(-1).startsWith('[1197.0-1199.5]'), 'the first and the last line are kept');
  eq(AI.condense(segs, { budget: 3000 }).text, big.text, 'condensed the same way every time');
  const long = AI.condense([{ start: 0, end: T, text: 'x'.repeat(5000) }, { start: T, end: 2 * T, text: 'y' }], { budget: 1000 });
  check(long.trimmed && long.text.length <= 1000 && long.text.includes('…'), 'a very long line is cut to fit');
  const words = [{ t0: 0, t1: 0.4 * T, text: 'Hello' }, { t0: 0.5 * T, t1: 0.9 * T, text: 'there.' }, { t0: 3 * T, t1: 3.5 * T, text: 'Next' }];
  const ws = AI.segmentsFromWords(words, { frame: F });
  check(ws.length === 2 && ws[0].text === 'Hello there.' && ws[1].text === 'Next' && ws[1].start === Math.floor((3 * T) / F) * F, `words become sentence segments at pauses (${S(ws.map((x) => x.text))})`);
  eq(AI.segmentsFromCaptions([{ start: 0, end: T, text: '두 줄\n자막' }, { start: T, end: 2 * T, text: ' ' }]).map((s) => s.text), ['두 줄 자막'], 'caption lines join; empty captions are left out');
});

// ---------- prompts ----------
await section('prompts', () => {
  const lines = [{ i: 1, text: '안녕 하세요' }, { i: 2, text: '편집이  쉬워요' }];
  const p = AI.polishPrompt(lines, { lang: 'ko' });
  check(p.prompt.startsWith('Task: polish captions') && p.prompt.includes('Korean (ko)') && p.prompt.includes(S(lines)) && /fenced block/.test(p.system), 'polish: the task, the language, the captions as JSON, a JSON answer asked for');
  const t = AI.translatePrompt(lines, { from: 'ko', to: 'ja' });
  check(t.prompt.startsWith('Task: translate captions') && t.prompt.includes('Target language: Japanese (ja)') && t.prompt.includes('From: Korean (ko)'), 'translate: from and to');
  const m = AI.metadataPrompt({ name: 'My video', duration: 75 * T, transcript: '[0.0-2.0] hi', markers: [{ t: 12 * T, name: 'Intro', kind: 'chapter' }] });
  check(m.prompt.startsWith('Task: YouTube metadata') && m.prompt.includes('1:15 long (75.0 s)') && m.prompt.includes('12.0 chapter "Intro"') && m.prompt.includes('[0.0-2.0] hi') && /at least 3/.test(m.prompt), 'metadata: length, markers, transcript, the chapter rules');
  check(/no chapters/.test(AI.metadataPrompt({ name: 'x', duration: 20 * T, transcript: '' }).prompt), 'metadata of a 20 s video asks for no chapters');
  const h = AI.highlightsPrompt({ duration: 90 * T, transcript: 't', count: 4, min: 10, max: 30 });
  check(h.prompt.startsWith('Task: highlights') && h.prompt.includes('Pick up to 4') && h.prompt.includes('10 to 30 seconds') && h.prompt.includes('0 to 90.0 s'), 'highlights: count, lengths, the sequence');
  // what an edit command sends about the sequence: names and times, no paths
  const pr = model.createProject();
  const hist = C.createHistory(pr);
  const [m1] = hist.do(C.importMedia([{ path: 'D:/비밀 폴더/talk.mp4', name: 'talk.mp4', kind: 'video', duration: 20 * T, video: { w: 1920, h: 1080, fps: [30, 1] }, audio: { rate: 48000, channels: 2 } }])).ids;
  const seq = hist.project.sequences[0];
  hist.do(C.place(seq.id, { source: { media: m1 }, in: 0, out: 20 * T, at: 0, video: 'V1', audio: 'A1' }));
  hist.do(C.addMarker(seq.id, { t: 5 * T, name: 'Hook', kind: 'chapter' }));
  const sum = AI.sequenceSummary(hist.project, seq, { selection: [seq.clips[0].id] });
  const cmd = AI.commandPrompt({ request: 'cut the  first 10 seconds', summary: sum, transcript: '[0.0-1.0] hi' });
  check(cmd.prompt.startsWith('Task: edit command') && cmd.prompt.includes('Request: cut the first 10 seconds') && cmd.prompt.includes('"talk.mp4"')
    && cmd.prompt.includes(`Selected clips: ${seq.clips[0].id}`) && cmd.prompt.includes('5.0 chapter "Hook"') && cmd.prompt.includes('"op": "removeSilence"'), 'command: the request, clips with names and times, the selection, markers, the whitelist');
  check(!/비밀|D:\//.test(cmd.prompt + m.prompt + p.prompt), 'no file path goes into a prompt');
});

await section('lines', () => {
  const lines = [{ i: 1, text: '안녕 하세요' }, { i: 2, text: '편집' }];
  const ok = AI.validateLines({ lines: [{ i: 2, text: ' 편집. ' }, { i: 1, text: '안녕하세요.\r\n 둘째 ' }] }, lines);
  check(ok.value instanceof Map && ok.value.get(1) === '안녕하세요.\n둘째' && ok.value.get(2) === '편집.', 'every caption back, in any order, trimmed');
  refused(AI.validateLines({ lines: [{ i: 1, text: 'a' }] }, lines), /missing.*2/, 'a missing caption is refused');
  refused(AI.validateLines({ lines: [{ i: 1, text: 'a' }, { i: 1, text: 'b' }, { i: 2, text: 'c' }] }, lines), /twice/, 'a caption given twice is refused');
  refused(AI.validateLines({ lines: [{ i: 3, text: 'a' }, { i: 1, text: 'a' }, { i: 2, text: 'b' }] }, lines), /no caption 3/, 'an unknown number is refused');
  refused(AI.validateLines({ lines: [{ i: 1, text: '  ' }, { i: 2, text: 'b' }] }, lines), /empty/, 'an empty caption is refused');
  refused(AI.validateLines({ lines: [{ i: 1, text: 'x'.repeat(200) }, { i: 2, text: 'b' }] }, lines), /longer/, 'a caption far longer than the original is refused');
  refused(AI.validateLines([{ i: 1 }], lines), /"lines"/, 'the wrong shape is refused');
  eq(AI.chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'long tracks go in chunks');
});

// ---------- YouTube metadata ----------
await section('metadata', () => {
  const { chapters, fixed } = AI.fixChapters([{ t: 3.7, title: '시작' }, { t: 7, title: '가까움' }, { t: 20, title: ' 자막 ' }, { t: 36, title: '편집' }, { t: 65, title: '끝 뒤' }, { t: 'x', title: 'y' }], 60);
  eq(chapters, [{ t: 0, title: '시작' }, { t: 20, title: '자막' }, { t: 36, title: '편집' }], 'chapters: 0:00 first, less than 10 s apart and past the end left out');
  check(fixed.length === 4, `each fix is noted (${S(fixed)})`);
  eq(AI.fixChapters([{ t: 15, title: 'A' }, { t: 30, title: 'B' }], 100, { intro: '인트로' }).chapters, [{ t: 0, title: '인트로' }, { t: 15, title: 'A' }, { t: 30, title: 'B' }], 'a first chapter after 10 s gets an intro at 0:00');
  eq(AI.fixChapters([{ t: 0, title: 'A' }, { t: 20, title: 'B' }, { t: 55, title: 'C' }], 60).chapters.map((c) => c.t), [0, 20], 'a last chapter shorter than 10 s is left out');
  const ok = AI.validateMetadata({ titles: ['A', 'x'.repeat(150), 'A'], description: ' D \r\n', chapters: [{ t: 0, title: 'a' }, { t: 12, title: 'b' }, { t: 30, title: 'c' }], tags: ['#cut', 'Cut', 'video', '', 3, 'a,b'] }, { duration: 60 * T });
  check(ok.value && ok.value.titles.length === 2 && chars(ok.value.titles[1]) === 100 && ok.value.description === 'D', `titles: duplicates out, at most 100 characters (${ok.value?.titles.map(chars)})`);
  eq(ok.value?.tags, ['cut', 'video', 'a b'], 'tags without #, duplicates, empties and commas');
  eq(AI.chapterText(ok.value.chapters), '0:00 a\n0:12 b\n0:30 c', 'chapter lines for the description, 0:00 first');
  eq(AI.chapterText([{ t: 0, title: 'a' }, { t: 3725, title: 'b' }]), '0:00 a\n1:02:05 b', 'hours as H:MM:SS');
  const many = AI.cleanTags(Array.from({ length: 100 }, (_, i) => `tag number ${i}`));
  check(many.join(',').length <= 500 && many.length > 20, `tags stop at 500 characters (${many.join(',').length})`);
  refused(AI.validateMetadata({ titles: ['A'], description: 'D', chapters: [{ t: 0, title: 'a' }, { t: 5, title: 'b' }], tags: [] }, { duration: 60 * T }), /at least 3 chapters/, 'fewer than 3 chapters after fixing: refused (asked again)');
  check(S(AI.validateMetadata({ titles: ['A'], description: 'D', chapters: [{ t: 0, title: 'a' }], tags: [] }, { duration: 25 * T }).value?.chapters) === '[]', 'a video under 30 s gets no chapters, and that is fine');
  refused(AI.validateMetadata({ titles: [], description: 'D', chapters: [], tags: [] }, { duration: 60 * T }), /titles/, 'no titles: refused');
  refused(AI.validateMetadata({ titles: ['A'], chapters: [], tags: [] }, { duration: 60 * T }), /description/, 'no description: refused');
});

// ---------- highlights and shorts ----------
await section('highlights', () => {
  const ctx = { duration: 60 * T, count: 3, min: 5, max: 20, frame: F };
  const ok = AI.validateHighlights({ highlights: [{ start: 30.01, end: 40, title: 'b' }, { start: 1, end: 9.99, title: 'a', reason: 'r' }] }, ctx);
  check(ok.value?.length === 2 && ok.value[0].title === 'a' && ok.value.every((h) => h.start % F === 0 && h.end % F === 0), 'sorted by start, on frames');
  check(ok.value[1].start === 30 * T, `snapped to the nearest frame (${ok.value[1].start / T})`);
  refused(AI.validateHighlights({ highlights: [{ start: 1, end: 10 }, { start: 8, end: 15 }] }, ctx), /overlap/, 'overlapping ranges are refused');
  refused(AI.validateHighlights({ highlights: [{ start: 1, end: 3 }] }, ctx), /5 to 20/, 'too short is refused');
  refused(AI.validateHighlights({ highlights: [{ start: 1, end: 30 }] }, ctx), /5 to 20/, 'too long is refused');
  refused(AI.validateHighlights({ highlights: [{ start: 50, end: 65 }] }, ctx), /outside/, 'past the end is refused');
  refused(AI.validateHighlights({ highlights: [1, 2, 3, 4].map((k) => ({ start: k * 10, end: k * 10 + 6 })) }, ctx), /at most 3/, 'more than asked is refused');
  refused(AI.validateHighlights({ highlights: [{ start: '1', end: 9 }] }, ctx), /numbers/, 'strings are not times');
  const edge = AI.validateHighlights({ highlights: [{ start: -0.2, end: 60.3 }] }, { ...ctx, max: 61 });
  check(edge.value?.[0].start === 0 && edge.value[0].end === 60 * T, 'a hair outside the sequence is clamped into it');
  eq(AI.complement([[10, 20], [30, 40]], 50), [[40, 50], [20, 30], [0, 10]], 'what a shorts copy drops, latest first');
  eq(AI.complement([[0, 20]], 20), [], 'nothing dropped when one range is everything');
  // fit and fill in 1080x1920
  const pr = model.createProject();
  const h = C.createHistory(pr);
  const [m] = h.do(C.importMedia([{ path: 'a.mp4', name: 'a.mp4', kind: 'video', duration: 10 * T, video: { w: 1920, h: 1080, fps: [30, 1] }, audio: null }])).ids;
  const seq = h.project.sequences[0];
  h.do(C.place(seq.id, { source: { media: m }, in: 0, out: 5 * T, at: 0, video: 'V1' }));
  h.do(C.setClip(seq.id, seq.clips[0].id, { props: { position: [100, 50], scale: [50, 50] } }));
  h.do(C.setSequence(seq.id, { w: 1080, h: 1920 }));
  const fill = AI.shortsEdits(h.project, seq, { mode: 'fill' });
  const k = Math.max(1080 / 1920, 1920 / 1080) / Math.min(1080 / 1920, 1920 / 1080);
  check(fill.length === 1 && Math.abs(fill[0].patch.props.scale[0] - 50 * k) < 0.01 && S(fill[0].patch.props.position) === '[0,0]', `fill: the clip's scale times ${k.toFixed(3)}, centered (${S(fill[0].patch.props)})`);
  const fit = AI.shortsEdits(h.project, seq, { mode: 'fit' });
  check(Math.abs(fit[0].patch.props.scale[0] - 50) < 1e-9, 'fit, when the project fits already: the scale stays');
  h.do(C.batch('x', fill));
  check(seq.clips[0].props.scale[0] > 150, 'the edits apply');
});

// ---------- edit plans ----------
function planProject() {
  const pr = model.createProject();
  const h = C.createHistory(pr);
  const VID = { w: 1920, h: 1080, fps: [30, 1] };
  const AUD = { rate: 48000, channels: 2 };
  const [talk, music] = h.do(C.importMedia([
    { path: 'D:/x/talk.mp4', name: 'talk.mp4', kind: 'video', duration: 60 * T, video: VID, audio: AUD },
    { path: 'D:/x/song.wav', name: 'song.wav', kind: 'audio', duration: 60 * T, video: null, audio: AUD },
  ])).ids;
  const seq = h.project.sequences[0];
  h.do(C.place(seq.id, { source: { media: talk }, in: 0, out: 40 * T, at: 0, video: 'V1', audio: 'A1' }));
  h.do(C.place(seq.id, { source: { media: music }, in: 0, out: 40 * T, at: 0, audio: 'A2' }));
  const song = seq.clips.find((c) => c.track === 'A2');
  h.do(C.setRole(seq.id, [song.id], 'music'));
  h.do(C.setKeyframes(seq.id, song.id, 'volume', [{ t: 0, v: -3, ease: 'linear' }, { t: 10 * T, v: 0, ease: 'linear' }]));
  h.do(C.addMarker(seq.id, { t: 30 * T, name: 'Old chapter', kind: 'chapter' }));
  h.do(C.addMarker(seq.id, { t: 25 * T, name: 'Note', kind: 'comment' }));
  return { h, seq, talkV: seq.clips.find((c) => c.track === 'V1'), song };
}
const ctxOf = (seq, selection = []) => ({ duration: model.sequenceDuration(seq), tracks: seq.tracks.map((t) => ({ id: t.id, kind: t.kind })), clips: seq.clips.map((c) => c.id), selection });

await section('plan validation', () => {
  const { seq, talkV } = planProject();
  const ctx = ctxOf(seq);
  const all = { ops: [
    { op: 'cut', from: 0, to: 10 }, { op: 'lift', from: 12, to: 13 }, { op: 'split', at: 20 }, { op: 'marker', at: 5, name: '  Big   hook ', kind: 'chapter' },
    { op: 'marker', at: 6 }, { op: 'removeMarkers', kind: 'comment' }, { op: 'clipVolume', clips: 'music', db: -6 }, { op: 'clipVolume', clips: [talkV.id], db: 2 },
    { op: 'trackVolume', track: 'A2', db: -1.5 }, { op: 'masterGain', db: 1 }, { op: 'removeSilence', longerThan: 1, threshold: -45 },
  ], message: 'ok' };
  const v = AI.validatePlan(all, ctx);
  check(v.value?.ops.length === 11 && v.value.ops[3].name === 'Big hook' && v.value.message === 'ok', `every whitelisted operation passes (${v.error || ''})`);
  check(Object.keys(AI.OPS).length === 9, 'the whitelist has nine operations');
  refused(AI.validatePlan({ ops: [{ op: 'deleteProject' }] }, ctx), /not an allowed operation/, 'an unknown operation is refused');
  refused(AI.validatePlan({ ops: [{ op: 'constructor' }] }, ctx), /not an allowed/, 'a prototype name is not an operation');
  refused(AI.validatePlan({ ops: [{ op: '__proto__' }] }, ctx), /not an allowed/, '__proto__ is not an operation');
  refused(AI.validatePlan({ ops: [{ op: 'cut', from: 0, to: 1, speed: 2 }] }, ctx), /unknown field "speed"/, 'an unknown field is refused');
  refused(AI.validatePlan({ ops: [{ op: 'cut', from: 0, to: 1, toString: 2 }] }, ctx), /unknown field "toString"/, 'a prototype field name is refused');
  refused(AI.validatePlan({ ops: [{ op: 'cut', from: 0 }] }, ctx), /needs "to"/, 'a missing field is refused');
  refused(AI.validatePlan({ ops: [{ op: 'cut', from: 5, to: 5 }] }, ctx), /after "from"/, 'an empty range is refused');
  refused(AI.validatePlan({ ops: [{ op: 'cut', from: 0, to: 99 }] }, ctx), /outside the sequence/, 'a time past the end is refused');
  check(AI.validatePlan({ ops: [{ op: 'cut', from: 0, to: 40.3 }] }, ctx).value?.ops[0].to === 40, 'a hair past the end is clamped to it');
  refused(AI.validatePlan({ ops: [{ op: 'cut', from: '0', to: 1 }] }, ctx), /number of seconds/, 'a string time is refused');
  refused(AI.validatePlan({ ops: [{ op: 'trackVolume', track: 'V1', db: 1 }] }, ctx), /not an audio track/, 'a video track has no volume');
  refused(AI.validatePlan({ ops: [{ op: 'trackVolume', track: 'A9', db: 1 }] }, ctx), /not an audio track/, 'a track that does not exist is refused');
  refused(AI.validatePlan({ ops: [{ op: 'clipVolume', clips: 'selected', db: 1 }] }, ctx), /no clips are selected/, '"selected" without a selection is refused');
  check(!!AI.validatePlan({ ops: [{ op: 'clipVolume', clips: 'selected', db: 1 }] }, ctxOf(seq, [talkV.id])).value, '"selected" with a selection passes');
  refused(AI.validatePlan({ ops: [{ op: 'clipVolume', clips: ['nope'], db: 1 }] }, ctx), /do not exist/, 'clip ids that do not exist are refused');
  refused(AI.validatePlan({ ops: [{ op: 'clipVolume', clips: 'voices', db: 1 }] }, ctx), /one of/, 'an unknown clip set is refused');
  refused(AI.validatePlan({ ops: [{ op: 'masterGain', db: 100 }] }, ctx), /-40 to 40/, 'a huge gain is refused');
  refused(AI.validatePlan({ ops: [{ op: 'marker', at: 1, kind: 'beat' }] }, ctx), /comment.*chapter/, 'a marker is a comment or a chapter');
  refused(AI.validatePlan({ ops: [{ op: 'removeSilence', longerThan: 0 }] }, ctx), /0.1 to 60/, 'a zero silence length is refused');
  refused(AI.validatePlan({ ops: [], extra: 1 }, ctx), /Unknown field "extra"/, 'unknown top-level fields are refused');
  refused(AI.validatePlan({ ops: 'cut' }, ctx), /"ops" list/, 'ops must be a list');
  refused(AI.validatePlan({ ops: Array.from({ length: 201 }, () => ({ op: 'split', at: 1 })) }, ctx), /at most 200/, 'at most 200 operations');
  const none = AI.validatePlan({ ops: [], message: 'Cannot do that.' }, ctx);
  check(none.value?.ops.length === 0 && none.value.message === 'Cannot do that.', 'no operations with a message passes');
});

await section('plan commands', () => {
  const { h, seq, talkV, song } = planProject();
  const silence = [];
  const ops = AI.validatePlan({ ops: [
    { op: 'masterGain', db: -2 },
    { op: 'clipVolume', clips: 'music', db: -6 },
    { op: 'trackVolume', track: 'A1', db: 3 },
    { op: 'removeMarkers', kind: 'chapter' },
    { op: 'marker', at: 20, name: 'Part 2', kind: 'chapter' },
    { op: 'cut', from: 0, to: 10 },
    { op: 'removeSilence', longerThan: 1 },
  ] }, ctxOf(seq)).value.ops;
  silence[6] = { ranges: [[30 * T, 32 * T]], tracks: ['A1', 'V1'] };
  h.do(C.setTrack(seq.id, 'A2', { syncLock: false }));
  const before = h.serialize();
  const steps0 = h.list().length;
  const lines = AI.describePlan(ops, { seq, silence });
  eq(lines.map((l) => l.text), [
    'Change the master gain by {db} dB', 'Change the volume of the music clips by {db} dB ({n} clips)', 'Change the volume of track {track} by {db} dB',
    'Remove the chapter markers ({n})', 'Add a chapter marker at {at}: {name}', 'Cut {from} – {to} ({len} s) from every track',
    'Remove silences longer than {s} s quieter than {threshold} dB ({n} cuts, {time} s)'], 'the preview has a sentence for each operation');
  eq([lines[1].params, lines[5].params, lines[6].params], [{ db: '-6', n: 1 }, { from: '0:00.0', to: '0:10.0', len: '10.0' }, { s: 1, threshold: -40, n: 1, time: '2.0' }], 'with the numbers filled in');
  const cmds = AI.planCommands(ops, { seq, silence });
  check(cmds.every((c) => typeof C[c.type] === 'function'), `only Cut commands (${[...new Set(cmds.map((c) => c.type))].join(', ')})`);
  h.do(C.batch('Edit Command', cmds));
  check(h.list().length === steps0 + 1 && h.list().at(-1).label === 'Edit Command', 'the plan is one undo step');
  const s = h.project.sequences[0];
  const v1End = Math.max(...s.clips.filter((c) => c.track === 'V1').map(model.clipEnd));
  check(Math.abs(v1End - 28 * T) < 1 && Math.abs(model.sequenceDuration(s) - 30 * T) < 1, `the first 10 s and the 2 s of silence are gone from the talk, the first 10 s from the music (${v1End / T} s, ${model.sequenceDuration(s) / T} s)`);
  const songNow = s.clips.filter((c) => c.track === 'A2');
  check(songNow.length >= 1 && songNow.every((c) => c.props.volume === -6), `the music clip is 6 dB quieter (${songNow.map((c) => c.props.volume)})`);
  check(S(s.clips.find((c) => c.id === song.id)?.keyframes.volume.map((k) => k.v) ?? []) !== S([-3, 0]), 'its volume keyframes move with it');
  check(s.masterGain === -2 && s.tracks.find((t) => t.id === 'A1').volume === 3, 'master gain and track volume');
  const markers = s.markers.map((m) => ({ t: m.t / T, kind: m.kind, name: m.name }));
  eq(markers, [{ t: 10, kind: 'chapter', name: 'Part 2' }, { t: 15, kind: 'comment', name: 'Note' }], 'the old chapter is gone; the new one and the note moved with the cut (times of the timeline before the plan)');
  check(s.clips.filter((c) => c.track === 'V1').length === 2 && s.clips.filter((c) => c.track === 'A2').length === 1, 'the silence cut only its own tracks (V1 split in two, the music on a track without sync lock kept whole)');
  check(model.validate(h.project).ok, 'the project still validates');
  h.undo();
  check(h.serialize() === before, 'undo gives back exactly the project before the plan');
  // a selection brings the linked audio of a selected video clip
  eq(AI.volumeClips(seq, 'selected', [talkV.id]).map((c) => c.track), ['A1'], 'a selected video clip brings its linked audio');
  eq(AI.volumeClips(seq, [talkV.id, song.id]).map((c) => c.track).sort(), ['A1', 'A2'], 'clip ids too');
  h.do(C.setTrack(seq.id, 'A2', { locked: true }));
  eq(AI.volumeClips(seq, 'music').length, 0, 'never a clip on a locked track');
  // lift and split keep the length
  const p2 = planProject();
  const ops2 = AI.validatePlan({ ops: [{ op: 'lift', from: 5, to: 6 }, { op: 'split', at: 20 }] }, ctxOf(p2.seq)).value.ops;
  p2.h.do(C.batch('Edit Command', AI.planCommands(ops2, { seq: p2.seq })));
  const v1 = p2.seq.clips.filter((c) => c.track === 'V1').map((c) => [c.start / T, model.clipEnd(c) / T]).sort((a, b) => a[0] - b[0]);
  eq(v1, [[0, 5], [6, 20], [20, 40]], 'lift leaves a gap, split adds an edit');
});

// ---------- caption lines ----------
await section('line breaks', () => {
  const ko = AI.lineBreak('안녕하세요 오늘은 자막을 만들어 봅니다 편집이 정말 쉬워요', 'ko');
  check(ko.split('\n').length === 2 && ko.split('\n').every((l) => chars(l) <= 18), `Korean: two lines of 18 characters at most (${S(ko)})`);
  const en = AI.lineBreak('Caption 3 in English, made a little longer for the line test.', 'en');
  check(en.split('\n').length === 2 && en.split('\n').every((l) => chars(l) <= 42), `English: two lines of 42 at most (${S(en)})`);
  eq(AI.lineBreak('Short one.', 'es'), 'Short one.', 'a short caption stays one line');
  const ja = AI.lineBreak('字幕3番の日本語訳です。行の長さを試すために少し長くしています。', 'ja');
  const jl = ja.split('\n');
  check(jl.length === 2 && jl.every((l) => chars(l) <= 16 && !/^[。、！？」]/.test(l) && !/\s/.test(l)), `Japanese: 16 characters, no spaces, no line starting with a closing mark (${S(ja)})`);
  check(jl.join('') === '字幕3番の日本語訳です。行の長さを試すために少し長くしています。', 'nothing lost or added');
  const zh = AI.lineBreak('这是第12条字幕的中文翻译，为了测试换行而写得长一些。', 'zh');
  check(zh.split('\n').every((l) => chars(l) <= 16) && zh.includes('12') && !zh.split('\n').some((l) => l.startsWith('，')), `Chinese: the number kept whole (${S(zh)})`);
  const long = AI.lineBreak(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '), 'en');
  check(long.split('\n').length > 2 && long.split('\n').every((l) => chars(l) <= 42), 'text too long for two lines wraps on');
  eq(AI.keepLines('안녕 하세요\n반가워요', '안녕하세요\n반가워요.', 'ko'), '안녕하세요\n반가워요.', 'a polished caption keeps its line break when it fits');
  eq(AI.keepLines('one line', 'one line now.', 'en'), 'one line now.', 'and a one-line caption stays one line');
  for (const [a, b] of [['안녕 하세요', '안녕하세요.'], ['teh cat', 'the cat'], ['', 'x'], ['abc', '']]) {
    const d = AI.diffChars(a, b);
    check(d.filter((x) => x.op !== '+').map((x) => x.s).join('') === a && d.filter((x) => x.op !== '-').map((x) => x.s).join('') === b, `the diff of ${S(a)} and ${S(b)} gives both back`);
  }
  eq(AI.diffChars('안녕 하세요', '안녕하세요.'), [{ op: '=', s: '안녕' }, { op: '-', s: ' ' }, { op: '=', s: '하세요' }, { op: '+', s: '.' }], 'the diff marks the space taken out and the full stop added');
  eq([AI.clock(0), AI.clock(59.9), AI.clock(61), AI.clock(3725), AI.clockFine(10), AI.clockFine(62.46)], ['0:00', '0:59', '1:01', '1:02:05', '0:10.0', '1:02.5'], 'clocks');
});

// ---------- main/cut/ai.js ----------
await section('main', async () => {
  const calls = [];
  const sent = [];
  let gate = null;
  const fake = ({ system, prompt, model: m, signal, onText }) => new Promise((resolve, reject) => {
    calls.push({ system, prompt, model: m });
    if (prompt === 'slow') {
      gate = () => resolve({ text: 'late', ms: 1 });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' })));
      return;
    }
    if (prompt === 'auth') return reject(Object.assign(new Error('Not logged in'), { code: 'auth' }));
    for (let i = 1; i <= 5; i++) onText('x'.repeat(i * 100));
    resolve({ text: '{"ok": true}', ms: 3 });
  });
  const sender = { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]) };
  const ai = createAi({ complete: fake, find: () => 'claude.exe' });
  const r = await ai.run(1, { request: 'r1', task: 'polish', system: 's', prompt: 'p', model: 'haiku' }, sender);
  check(r.ok && r.text === '{"ok": true}' && calls[0].model === 'haiku', 'a request is answered with its text');
  check(sent.length >= 1 && sent[0][0] === 'cut:aiProgress' && sent[0][1].request === 'r1' && sent.length < 5, `progress is sent, at most every 100 ms (${sent.length} events)`);
  const bad = await Promise.all([
    ai.run(1, { request: 'r2', system: 's', prompt: 'p', model: 'gpt-4' }),
    ai.run(1, { request: 'bad id!', system: 's', prompt: 'p' }),
    ai.run(1, { request: 'r3', system: '', prompt: 'p' }),
    ai.run(1, { request: 'r4', system: 's', prompt: 'x'.repeat(200001) }),
    ai.run(1, null),
  ]);
  check(bad.every((x) => !x.ok && x.code === 'badArgs') && calls.length === 1, `bad requests are refused before Claude Code runs (${bad.map((x) => x.error).join('; ')})`);
  check((await ai.run(1, { request: 'r5', system: 's', prompt: 'auth' })).code === 'auth', 'a sign-in failure comes back as code auth');
  const slow = ai.run(2, { request: 'r6', system: 's', prompt: 'slow' });
  await new Promise((res) => setTimeout(res, 20));
  check(ai.status().stats.running === 1 && (await ai.run(2, { request: 'r6', system: 's', prompt: 'p' })).code === 'badArgs', 'one request id runs once at a time');
  check(!ai.cancel(1, 'r6').ok, 'another window cannot cancel it');
  check(ai.cancel(2, 'r6').ok && (await slow).code === 'cancelled', 'cancel ends it with code cancelled');
  const gone = ai.run(3, { request: 'r7', system: 's', prompt: 'slow' });
  await new Promise((res) => setTimeout(res, 20));
  ai.ownerGone(3);
  check((await gone).code === 'cancelled' && ai.status().stats.running === 0, 'a window that goes takes its requests with it');
  const timed = createAi({ complete: fake, find: () => 'x', timeoutMs: 50 });
  check((await timed.run(1, { request: 't', system: 's', prompt: 'slow' })).code === 'timeout', 'the time limit gives code timeout');
  check(createAi({ complete: fake, find: () => null }).status().installed === false && ai.status().installed === true, 'status says whether Claude Code is there');
  void gate;
});

// ---------- the fake CLI through main/ai/claude.js ----------
await section('fake cli', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cut-ai-core-'));
  try {
    const cmd = path.join(dir, 'claude.cmd');
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${path.join(process.cwd(), 'verify', 'fake-claude-cut.mjs')}" %*\r\n`);
    writeFileSync(path.join(dir, 'scenario.json'), '{}');
    const old = { p: process.env.PYIDE_CLAUDE_PATH, d: process.env.FAKE_CLAUDE_DIR };
    process.env.FAKE_CLAUDE_DIR = dir;
    process.env.PYIDE_CLAUDE_PATH = 'none';
    const claude = require('../main/ai/claude.js');
    const none = await createAi({}).run(1, { request: 'n', system: 's', prompt: 'p' });
    check(none.code === 'not-installed' && createAi({}).status().installed === false, 'PYIDE_CLAUDE_PATH=none: not installed');
    process.env.PYIDE_CLAUDE_PATH = cmd;
    const ai = createAi({});
    check(ai.status().installed && claude.findClaude() === cmd, 'the stand-in CLI is found');
    const lines = [{ i: 1, text: '안녕  하세요' }, { i: 2, text: '잘 됬어요' }];
    const q = AI.polishPrompt(lines, { lang: 'ko' });
    const r = await ai.run(1, { request: 'f1', task: 'polish', ...q });
    const v = AI.validateLines(AI.parseJson(r.text).value, lines);
    check(r.ok && v.value?.get(1) === '안녕 하세요.' && v.value.get(2) === '잘 됐어요.', `the fake polishes (${r.error || S([...(v.value || [])])})`);
    const hq = AI.highlightsPrompt({ duration: 60 * T, transcript: '[0.0-1.0] hi', count: 2, min: 5, max: 20 });
    const first = await ai.run(1, { request: 'f2', task: 'highlights', ...hq });
    const firstCheck = AI.validateHighlights(AI.parseJson(first.text).value, { duration: 60 * T, count: 2, min: 5, max: 20, frame: F });
    const again = await ai.run(1, { request: 'f3', task: 'highlights', system: hq.system, prompt: AI.retryPrompt(hq.prompt, first.text, firstCheck.error) });
    const againCheck = AI.validateHighlights(AI.parseJson(again.text).value, { duration: 60 * T, count: 2, min: 5, max: 20, frame: F });
    check(/overlap/.test(firstCheck.error || '') && againCheck.value?.length === 2, 'the fake answers highlights badly first and well when asked again');
    writeFileSync(path.join(dir, 'scenario.json'), S({ error: 'Not logged in · Please run /login' }));
    check((await ai.run(1, { request: 'f4', task: 'polish', ...q })).code === 'auth', 'a signed-out CLI gives code auth');
    const log = readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check(log.length === 4 && log.every((x) => x.args.includes('--tools') && x.args.includes('--no-session-persistence')) && log[2].retry && !log[1].retry, 'the CLI ran with no tools and no session; the retry was seen as one');
    process.env.PYIDE_CLAUDE_PATH = old.p ?? '';
    if (!old.p) delete process.env.PYIDE_CLAUDE_PATH;
    if (old.d) process.env.FAKE_CLAUDE_DIR = old.d; else delete process.env.FAKE_CLAUDE_DIR;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- as a page script ----------
await section('page', () => {
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, Error, Float32Array, Float64Array, Uint16Array, Uint32Array, Int32Array, Uint8ClampedArray, Promise, RegExp };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const dir = new URL('../renderer/features/cut/', import.meta.url);
  const order = readFileSync(new URL('index.js', dir), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  const mine = ['time.js', 'model.js', 'keyframes.js', 'commands.js', 'effects.js', 'analyze.js', 'speech.js', 'ai.js'];
  check(order.indexOf('ai.js') > order.indexOf('speech.js') && order.indexOf('ui-ai.js') > order.indexOf('ui-speech.js') && order.indexOf('ui-ai.js') < order.indexOf('ui-settings.js')
    && order.indexOf('ui-ai.js') < order.indexOf('ui-shortcuts.js'), 'index.js loads ai.js after speech.js, and ui-ai.js after ui-speech.js and before the settings page and the shortcut editor');
  for (const file of order.filter((x) => mine.includes(x))) vm.runInContext(readFileSync(new URL(file, dir), 'utf8'), page, { filename: file });
  const out = vm.runInContext(`(() => [Cut.ai.parseJson('\`\`\`json\\n{"a":1}\\n\`\`\`').value.a, Cut.ai.lineBreak('안녕하세요 오늘은 자막을 만들어 봅니다 편집이 쉬워요', 'ko').split('\\n').length, Cut.ai.validatePlan({ ops: [{ op: 'nope' }] }, { duration: 1 }).error ? 1 : 0])()`, page);
  eq(out, [1, 2, 1], 'ai.js works as a page script through globalThis.Cut');
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
