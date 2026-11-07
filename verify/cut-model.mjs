// Nano Studio Cut's project model, keyframes, edit commands and caption files, in plain Node (no Electron, no media).
// Checks: every command's effect on a small project against the expected timeline, and that undo gives back the exact
// previous JSON and redo the next; 2,000 random valid commands on a random project, each leaving a valid project,
// a failed command changing nothing, and undoing all of them giving back the start; sync lock, linked clips, the
// trim clamps at source ends and neighbours in normal, ripple and roll; frame snapping; keyframe interpolation values;
// history grouping, dirty state and the step limit; SRT and VTT round trips with CP949 and UTF-16 bytes and odd
// timestamps; migrate() of older and newer files.
// Usage: node verify/cut-model.mjs
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const kf = require('../renderer/features/cut/keyframes.js');
const C = require('../renderer/features/cut/commands.js');
const srt = require('../renderer/features/cut/srt.js');

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const near = (a, b, eps, label) => check(Math.abs(a - b) <= eps, `${label} (${a} vs ${b})`);
const throws = (fn, code, label) => {
  try { fn(); check(false, `${label}: did not throw`); } catch (err) { check(!code || err.code === code, `${label} (${err.code}: ${err.message})`); }
};
const SEC = time.TICKS;
const F = time.frameTicks([30, 1]);
const f = (n) => n * F;

const VID = { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 };
const AUD = { rate: 48000, channels: 2 };
const MEDIA = [
  { path: 'D:/clips/a.mp4', name: 'a.mp4', kind: 'video', duration: 20 * SEC + 1234, video: VID, audio: AUD },
  { path: 'D:/clips/music.wav', name: 'music.wav', kind: 'audio', duration: 60 * SEC, video: null, audio: AUD },
  { path: 'D:/clips/pic.png', name: 'pic.png', kind: 'image', duration: 0, video: { w: 640, h: 480 }, audio: null },
  { path: 'D:/clips/b.mp4', name: 'b.mp4', kind: 'video', duration: 10 * SEC, video: VID, audio: null },
];

function setup() {
  const project = model.createProject();
  const h = C.createHistory(project);
  const [a, music, pic, b] = h.do(C.importMedia(MEDIA)).ids;
  return { h, s: project.sequences[0].id, a, music, pic, b, seq: () => h.project.sequences[0] };
}
const clipsOf = (h, s) => h.project.sequences.find((x) => x.id === s).clips;
const clip = (h, s, id) => clipsOf(h, s).find((x) => x.id === id);
const fr = (t) => Math.round((t / F) * 1000) / 1000;
// Each track as "start-end:sourceStart" in frames (sourceStart is out for a reversed clip), sorted by start.
function lay(h, s) {
  const seq = h.project.sequences.find((x) => x.id === s);
  const out = {};
  for (const tr of seq.tracks) {
    out[tr.id] = seq.clips.filter((c) => c.track === tr.id).sort((x, y) => x.start - y.start)
      .map((c) => `${fr(c.start)}-${fr(model.clipEnd(c))}${c.source.media ? `:${fr(c.reverse ? c.out : c.in)}` : ''}`).join(' ');
  }
  return out;
}
// do, check the result validates, undo (exact previous JSON), redo (exact next JSON).
function step(h, cmd, label) {
  const before = h.serialize();
  const r = h.do(cmd);
  const after = h.serialize();
  const valid = model.validate(h.project);
  h.undo();
  const undone = h.serialize();
  h.redo();
  const redone = h.serialize();
  check(valid.ok && after !== before && undone === before && redone === after, `${label}: valid, undo exact, redo exact${valid.ok ? '' : ` ${valid.errors.join('; ')}`}`);
  return r;
}
const unchanged = (h, fn, code, label) => {
  const before = h.serialize();
  throws(fn, code, label);
  check(h.serialize() === before, `${label}: nothing changed`);
};
const place = (h, s, o) => h.do(C.place(s, { mode: 'overwrite', ...o })).ids;

// ---------- model ----------
try {
  const p = model.createProject();
  check(model.validate(p).ok, 'a new project validates');
  eq(p.sequences[0].tracks.map((t) => t.id), ['V1', 'V2', 'A1', 'A2'], 'a new sequence has V1, V2, A1, A2');
  eq([p.sequences[0].fps, p.sequences[0].rate, p.nextId], [[30, 1], 48000, 2], 'sequence defaults and nextId');

  const { h, s, a } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: f(10), out: f(100), at: f(30), video: 'V1', audio: 'A1' });
  const seq = h.project.sequences[0];
  const vc = clip(h, s, v);
  eq([model.clipDuration(vc), model.clipEnd(vc), model.sequenceDuration(seq)], [f(90), f(120), f(120)], 'clipDuration, clipEnd, sequenceDuration');
  eq(model.clipsAt(seq, f(30)).map((c) => c.track), ['V1', 'A1'], 'clipsAt: V1 first, then audio');
  eq(model.clipsAt(seq, f(30), { kind: 'audio' }).map((c) => c.id), [au], 'clipsAt by kind');
  eq([model.clipsAt(seq, f(29)).length, model.clipsAt(seq, f(120)).length], [0, 0], 'clipsAt: start included, end excluded');
  eq(model.sourceTime(vc, f(40)), f(20), 'sourceTime at speed 1');
  eq([model.trackIndex(seq, 'V2'), model.trackIndex(seq, 'A1'), model.trackIndex(seq, 'X')], [1, 0, -1], 'trackIndex within its kind');
  eq(model.linkedClips(seq, vc).map((c) => c.id), [au], 'linkedClips');
  eq(model.mediaOf(h.project, vc).id, a, 'mediaOf');
  const fast = { ...model.clone(vc), speed: 2, in: f(0), out: f(180) };
  eq([model.clipDuration(fast), model.sourceTime(fast, f(40))], [f(90), f(20)], 'speed 2: duration and source time');
  const rev = { ...model.clone(vc), reverse: true };
  eq([model.sourceTime(rev, f(30)), model.sourceTime(rev, f(119))], [f(100) - 1, f(11) - 1], 'reverse: starts just before out');
  eq(model.sourceTime({ ...model.clone(vc), source: { media: a, freeze: true } }, f(90)), f(10), 'freeze shows its in frame');

  const bad = (mut, label) => {
    const q = model.clone(h.project);
    mut(q, q.sequences[0]);
    check(!model.validate(q).ok, `validate refuses ${label}`);
  };
  bad((q, sq) => { sq.clips[0].start = f(30) + 5; }, 'a start off the frame grid');
  bad((q, sq) => { sq.clips.push({ ...model.clone(sq.clips[0]), id: 'c900', link: null, start: f(60) }); q.nextId = 1000; }, 'overlapping clips on a track');
  bad((q, sq) => { sq.clips[1].id = sq.clips[0].id; }, 'an id used twice');
  bad((q, sq) => { sq.clips[0].id = `c${q.nextId + 5}`; }, 'an id at or above nextId');
  bad((q, sq) => { sq.clips[0].source.media = 'm999'; }, 'a clip of missing media');
  bad((q, sq) => { sq.clips[1].link = null; }, 'a link with one clip');
  bad((q, sq) => { sq.transitions.push({ id: 'x1', track: 'V1', at: f(45), type: 'dissolve', duration: f(10), align: 'center', params: {} }); }, 'a transition off a clip edge');
  bad((q, sq) => { sq.clips[0].keyframes.opacity = [{ t: f(5), v: 1, ease: 'linear' }, { t: f(2), v: 0, ease: 'linear' }]; }, 'keyframes out of order');
  bad((q, sq) => { sq.clips[0].keyframes.volume = [{ t: 0, v: 1, ease: 'linear' }]; }, 'a video clip keyframing volume');
  bad((q, sq) => { sq.clips[0].out = 21 * SEC; sq.clips[0].in = 21 * SEC - f(90); }, 'in/out past the media end');
  bad((q, sq) => { sq.clips[0].source.media = q.media[1].id; }, 'audio-only media on a video track');
  bad((q, sq) => { sq.clips[1].props.opacity = 50; }, 'a video property on an audio clip');
  bad((q) => { q.sequences[0].fps = [17, 1]; }, 'a frame rate the editor does not offer');

  // migrate
  throws(() => model.migrate({ format: 'ncut', version: 2 }), 'newer', 'migrate refuses a newer version');
  throws(() => model.migrate('{"hello":1}'), 'notProject', 'migrate refuses a file that is not a project');
  const old = model.migrate({
    format: 'ncut', version: 1,
    media: [{ id: 'm1', path: 'D:/영상/여행_01.mp4', kind: 'video', duration: 5080320000000, video: VID, audio: AUD, interpret: null, proxy: 'cache:ab12' }],
    bins: [{ id: 'b1', name: '촬영본', items: ['m1'] }],
    sequences: [{
      id: 's1', name: '브이로그', w: 1920, h: 1080, fps: [30, 1], rate: 48000,
      tracks: [{ id: 'V1', kind: 'video', locked: false, visible: true, syncLock: true }, { id: 'A1', kind: 'audio', mute: false, solo: false, volume: 0, pan: 0 }],
      clips: [{ id: 'c1', track: 'V1', source: { media: 'm1' }, start: 0, in: 254016000000, out: 2540160000000, speed: 1, reverse: false, link: null, group: null, enabled: true, label: 'blue',
        props: { position: [0, 0], scale: [100, 100], rotation: 0, anchor: [0, 0], opacity: 100 }, keyframes: { opacity: [{ t: 0, v: 0, ease: 'out' }, { t: 7620480000, v: 100 }] },
        effects: [{ id: 'e1', type: 'color.basic', on: true, params: { exposure: 0.3 } }] }],
      transitions: [], markers: [{ id: 'k7', t: 0, name: '인트로', kind: 'chapter', color: 'green' }],
      captions: [{ track: 'CC1', lang: 'ko', items: [{ id: 'q2', start: 0, end: 762048000000, text: '안녕하세요' }] }],
    }],
  });
  const ov = model.validate(old);
  check(ov.ok, `migrate fills an old file to a valid project${ov.ok ? '' : `: ${ov.errors.join('; ')}`}`);
  eq([old.nextId > 7, old.sequences[0].clips[0].keyframes.opacity[0].ease, old.sequences[0].clips[0].props.crop, old.media[0].proxy], [true, 'easeOut', [0, 0, 0, 0], { path: 'cache:ab12' }], 'migrate: nextId above every id, old ease names, missing props, proxy');
  check(C.createHistory(old) && true, 'a migrated project can be edited');
  {
    const seq4k = (style) => model.migrate({ format: 'ncut', version: 1, sequences: [{ id: 's1', w: 3840, h: 2160, fps: [30, 1], tracks: [], clips: [], transitions: [], markers: [], captions: [{ id: 'CC1', lang: 'ko', items: [], style }] }] }).sequences[0].captions[0].style;
    eq([seq4k({ size: 108 }).size, seq4k({ size: 108 }).ref], [54, 1080], 'an old 4K caption size chosen in sequence pixels keeps its look (108 px of 2160 lines is 54 at 1080p)');
    eq(seq4k({ size: 54 }).size, 54, 'the untouched default 54 stays 54 and is now drawn at 1080p proportions');
    eq(seq4k({ size: 80, ref: 1080 }).size, 80, 'a style that already has ref is not converted again');
    eq(model.defaultCaptionStyle().ref, 1080, 'new caption tracks measure their size at 1080p');
  }
  throws(() => C.createHistory({ ...model.createProject(), nextId: 0 }), 'damaged', 'createHistory refuses a damaged project');
} catch (err) {
  check(false, `model: ${err.stack}`);
}

// ---------- placing, frame snapping ----------
try {
  const { h, s, a, music, pic, b } = setup();
  const [v1, a1] = step(h, C.place(s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1', mode: 'overwrite' }), 'place overwrite').ids;
  eq(lay(h, s), { V1: '0-90:0', V2: '', A1: '0-90:0', A2: '' }, 'place puts linked video and audio');
  check(clip(h, s, v1).link && clip(h, s, v1).link === clip(h, s, a1).link, 'placed video and audio share a link');
  eq(h.list().at(-1).label, 'Overwrite', 'history label of an overwrite');
  place(h, s, { source: { media: music }, in: 0, out: f(300), at: 0, video: 'V1', audio: 'A2' });
  eq(lay(h, s).A2, '0-300:0', 'audio-only media ignores the video target');
  step(h, C.place(s, { source: { media: b }, in: 0, out: f(60), at: f(30), video: 'V1', audio: 'A1', mode: 'insert' }), 'place insert');
  eq(lay(h, s), { V1: '0-30:0 30-90:0 90-150:30', V2: '', A1: '0-30:0 90-150:30', A2: '0-30:0 90-360:30' }, 'insert splits and pushes the targeted and every sync-locked track');
  eq(h.list().at(-1).label, 'Insert', 'history label of an insert');
  const sq = h.project.sequences[0];
  const rightV = sq.clips.find((c) => c.track === 'V1' && c.start === f(90));
  const rightA = sq.clips.find((c) => c.track === 'A1' && c.start === f(90));
  check(rightV.link && rightV.link === rightA.link && rightV.link !== clip(h, s, v1).link, 'the right halves of a split linked pair share a new link');
  h.undo();
  h.do(C.setTrack(s, 'A2', { syncLock: false }));
  h.do(C.place(s, { source: { media: b }, in: 0, out: f(60), at: f(30), video: 'V1', mode: 'insert' }));
  eq(lay(h, s).A2, '0-300:0', 'a track without sync lock does not move on insert');
  h.undo();
  h.do(C.setTrack(s, 'A2', { syncLock: true, locked: true }));
  h.do(C.place(s, { source: { media: b }, in: 0, out: f(60), at: f(30), video: 'V1', mode: 'insert' }));
  eq(lay(h, s).A2, '0-300:0', 'a locked track does not move on insert');
  unchanged(h, () => h.do(C.place(s, { source: { media: music }, in: 0, out: f(10), at: 0, audio: 'A2' })), 'locked', 'placing onto a locked track');
  unchanged(h, () => h.do(C.place(s, { source: { media: music }, in: 0, out: f(10), at: 0, video: 'V1' })), 'noTarget', 'audio media with only a video target');
  unchanged(h, () => h.do(C.place(s, { source: { media: a }, in: 0, out: 100, at: 0, video: 'V2' })), 'tooShort', 'a clip shorter than a frame');

  // overwrite trims what is under it; times snap to frames
  const g = setup();
  place(g.h, g.s, { source: { media: g.a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1' });
  step(g.h, C.place(g.s, { source: { media: g.b }, in: f(5) + 1000, out: f(35) + 7, at: f(60) + F / 2, video: 'V1', audio: 'A1' }), 'overwrite over a clip');
  eq(lay(g.h, g.s), { V1: '0-60:0 60-90:5', V2: '', A1: '0-90:0', A2: '' }, 'overwrite trims the clip under it, only on the targeted track; times snap to frame starts');
  step(g.h, C.place(g.s, { source: { media: g.b }, in: 0, out: f(10), at: f(20), video: 'V1' }), 'overwrite inside a clip');
  eq(lay(g.h, g.s).V1, '0-20:0 20-30:0 30-60:30 60-90:5', 'overwrite inside a clip cuts it in two');
  // the end of the media clamps out; a still gets the default length
  step(g.h, C.place(g.s, { source: { media: g.a }, in: f(590), at: f(200), video: 'V2' }), 'place to the media end');
  eq(lay(g.h, g.s).V2, '200-210:590', 'out defaults to the media end, floored to a frame');
  const [still] = step(g.h, C.place(g.s, { source: { media: g.pic }, at: f(300), video: 'V2' }), 'place an image').ids;
  eq([model.clipDuration(clip(g.h, g.s, still)), lay(g.h, g.s).V2], [5 * SEC, '200-210:590 300-450:0'], 'an image gets the still duration');

  // three-point edits
  const t3 = setup();
  step(t3.h, C.placeRange(t3.s, { source: { media: t3.a }, in: f(10), out: f(40), range: { in: f(100) }, video: 'V1', audio: 'A1', mode: 'overwrite' }), 'three-point: source in/out + sequence in');
  eq(lay(t3.h, t3.s).V1, '100-130:10', 'three-point edit at the sequence In');
  t3.h.do(C.placeRange(t3.s, { source: { media: t3.a }, in: f(10), out: f(40), range: { out: f(300) }, video: 'V2' }));
  eq(lay(t3.h, t3.s).V2, '270-300:10', 'three-point edit backtimed from the sequence Out');
  t3.h.do(C.placeRange(t3.s, { source: { media: t3.b }, in: f(20), range: { in: f(400), out: f(415) }, video: 'V2' }));
  eq(lay(t3.h, t3.s).V2, '270-300:10 400-415:20', 'three-point edit: source In, sequence In and Out');
  unchanged(t3.h, () => t3.h.do(C.placeRange(t3.s, { source: { media: t3.b }, range: {}, video: 'V2' })), 'noRange', 'three-point edit without points');
} catch (err) {
  check(false, `placing: ${err.stack}`);
}

// ---------- moving and linked clips ----------
try {
  const { h, s, a, b } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1' });
  const [w] = place(h, s, { source: { media: b }, in: 0, out: f(60), at: f(120), video: 'V1' });
  step(h, C.move(s, [v], { delta: f(10) }), 'move linked');
  eq(lay(h, s), { V1: '10-100:0 120-180:0', V2: '', A1: '10-100:0', A2: '' }, 'linked clips move together');
  h.undo();
  step(h, C.move(s, [v], { delta: f(10), linked: false }), 'move one side');
  eq(lay(h, s), { V1: '10-100:0 120-180:0', V2: '', A1: '0-90:0', A2: '' }, 'linked: false moves one side only');
  h.undo();
  step(h, C.move(s, [v], { delta: f(60) }), 'move over a clip');
  eq(lay(h, s), { V1: '60-150:0 150-180:30', V2: '', A1: '60-150:0', A2: '' }, 'a move overwrites what it lands on');
  h.undo();
  step(h, C.move(s, [v], { trackDelta: 1 }), 'move up a track');
  eq(lay(h, s), { V1: '120-180:0', V2: '0-90:0', A1: '', A2: '0-90:0' }, 'trackDelta moves video up and audio down a track');
  h.undo();
  step(h, C.move(s, [w], { delta: -f(80), insert: true }), 'insert move');
  eq(lay(h, s), { V1: '0-40:0 40-100:0 100-150:40', V2: '', A1: '0-40:0 100-150:40', A2: '' }, 'an insert move pushes the sync-locked tracks apart');
  h.undo();
  const r = h.do(C.move(s, [v], { delta: -f(50) }));
  eq(r.delta, 0, 'a move before 0 stops at 0');
  unchanged(h, () => h.do(C.move(s, [v], { trackDelta: 5 })), 'noTrack', 'a move off the tracks');
  h.do(C.setTrack(s, 'V2', { locked: true }));
  unchanged(h, () => h.do(C.move(s, [v], { trackDelta: 1 })), 'locked', 'a move onto a locked track');
  const n0 = h.list().length;
  eq([h.do(C.move(s, [v], { delta: F / 3 })).delta, h.list().length], [0, n0], 'a move of less than half a frame snaps to no move and no step');
} catch (err) {
  check(false, `moving: ${err.stack}`);
}

// ---------- trimming: modes and clamps ----------
try {
  const { h, s, a, b, pic } = setup();
  // a: 20 s + 1234 ticks of media = 600 whole frames. Clip [30,120) shows source 100..190.
  const [v, au] = place(h, s, { source: { media: a }, in: f(100), out: f(190), at: f(30), video: 'V1', audio: 'A1' });
  const [n] = place(h, s, { source: { media: b }, in: 0, out: f(60), at: f(150), video: 'V1' });
  let r = step(h, C.trim(s, v, { edge: 'end', delta: f(10) }), 'trim end out');
  eq([r, lay(h, s).V1, lay(h, s).A1], [{ applied: f(10), clamped: null }, '30-130:100 150-210:0', '30-130:100'], 'a normal trim of the end, linked audio with it');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'end', delta: f(50) }));
  eq([r, lay(h, s).V1], [{ applied: f(30), clamped: 'neighbour' }, '30-150:100 150-210:0'], 'a normal trim stops at the next clip');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'start', delta: -f(200) }));
  eq([r, lay(h, s).V1], [{ applied: -f(30), clamped: 'neighbour' }, '0-120:70 150-210:0'], 'a start trim stops at 0');
  h.undo();
  h.do(C.move(s, [v], { delta: f(200) }));
  r = h.do(C.trim(s, v, { edge: 'start', delta: -f(50) }));
  eq([r, lay(h, s).V1], [{ applied: -f(20), clamped: 'neighbour' }, '150-210:0 210-320:80'], 'a start trim stops at the clip before');
  h.undo();
  h.undo();
  h.do(C.move(s, [v], { delta: f(300) }));
  r = h.do(C.trim(s, v, { edge: 'start', delta: -f(150) }));
  eq([r, lay(h, s).V1], [{ applied: -f(100), clamped: 'source' }, '150-210:0 230-420:0'], 'a start trim stops at the source start');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'end', delta: f(1000) }));
  eq([r, lay(h, s).A1], [{ applied: f(410), clamped: 'source' }, '330-830:100'], 'an end trim stops at the source end (whole frames)');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'end', delta: -f(500) }));
  eq([r, lay(h, s).A1], [{ applied: -f(89), clamped: 'length' }, '330-331:100'], 'a trim keeps one frame');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'end', delta: f(10), linked: false }));
  eq([lay(h, s).V1, lay(h, s).A1], ['150-210:0 330-430:100', '330-420:100'], 'linked: false trims one side');
  h.undo();
  h.undo();

  // ripple
  place(h, s, { source: { media: b }, in: 0, out: f(30), at: f(400), video: 'V2' });
  r = step(h, C.trim(s, v, { edge: 'end', delta: -f(20), mode: 'ripple' }), 'ripple trim end in');
  eq([r.applied, lay(h, s)], [-f(20), { V1: '30-100:100 130-190:0', V2: '380-410:0', A1: '30-100:100', A2: '' }], 'a ripple trim pulls everything after, on every sync-locked track');
  eq(h.list().at(-1).label, 'Ripple Trim', 'ripple trim label');
  h.undo();
  r = step(h, C.trim(s, v, { edge: 'end', delta: f(100), mode: 'ripple' }), 'ripple trim end out');
  eq([r, lay(h, s)], [{ applied: f(100), clamped: null }, { V1: '30-220:100 250-310:0', V2: '500-530:0', A1: '30-220:100', A2: '' }], 'a ripple trim out pushes instead of stopping at the neighbour');
  h.undo();
  r = step(h, C.trim(s, v, { edge: 'start', delta: f(15), mode: 'ripple' }), 'ripple trim start in');
  eq(lay(h, s), { V1: '30-105:115 135-195:0', V2: '385-415:0', A1: '30-105:115', A2: '' }, 'a ripple trim of the start keeps the start and pulls the rest');
  h.undo();
  r = step(h, C.trim(s, v, { edge: 'start', delta: -f(500), mode: 'ripple' }), 'ripple trim start out');
  eq([r, lay(h, s)], [{ applied: -f(100), clamped: 'source' }, { V1: '30-220:0 250-310:0', V2: '500-530:0', A1: '30-220:0', A2: '' }], 'a ripple trim of the start out stops at the source start');
  h.undo();

  // roll
  h.do(C.move(s, [n], { delta: -f(30) }));
  eq(lay(h, s).V1, '30-120:100 120-180:0', 'roll setup: two touching clips');
  r = step(h, C.trim(s, v, { edge: 'end', delta: f(10), mode: 'roll' }), 'roll right');
  eq([r, lay(h, s).V1, lay(h, s).A1], [{ applied: f(10), clamped: null }, '30-130:100 130-180:10', '30-130:100'], 'a roll moves the edit point, total length the same');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'end', delta: -f(10), mode: 'roll' }));
  eq([r, lay(h, s).V1], [{ applied: 0, clamped: 'source' }, '30-120:100 120-180:0'], 'a roll stops when the next clip has no head');
  r = h.do(C.trim(s, n, { edge: 'start', delta: f(100), mode: 'roll' }));
  eq([r, lay(h, s).V1], [{ applied: f(59), clamped: 'length' }, '30-179:100 179-180:59'], 'a roll from the right clip keeps it one frame');
  h.undo();
  const rl = setup();
  const [ra] = place(rl.h, rl.s, { source: { media: rl.a }, in: 0, out: f(60), at: 0, video: 'V1' });
  const [rb] = place(rl.h, rl.s, { source: { media: rl.a }, in: f(200), out: f(260), at: f(60), video: 'V1' });
  r = rl.h.do(C.trim(rl.s, rb, { edge: 'start', delta: -f(1000), mode: 'roll' }));
  eq([r, lay(rl.h, rl.s).V1], [{ applied: -f(59), clamped: 'neighbour' }, '0-1:0 1-120:141'], 'a roll from the right clip stops when the left one is one frame');
  rl.h.undo();
  r = rl.h.do(C.trim(rl.s, ra, { edge: 'end', delta: f(1000), mode: 'roll' }));
  eq([r, lay(rl.h, rl.s).V1], [{ applied: f(59), clamped: 'neighbour' }, '0-119:0 119-120:259'], 'a roll from the left clip stops when the right one is one frame');
  h.do(C.setClip(s, v, { reverse: true }));
  r = h.do(C.trim(s, v, { edge: 'start', delta: -f(1000) }));
  eq([r, lay(h, s).V1], [{ applied: -f(30), clamped: 'neighbour' }, '0-120:220 120-180:0'], 'a reversed clip extends its start from out');
  h.undo();
  r = h.do(C.trim(s, v, { edge: 'end', delta: f(30), mode: 'roll' }));
  eq(r, { applied: f(30), clamped: null }, 'a reversed clip rolls into the next one');
  h.undo();
  // a still has no source ends
  const [im] = place(h, s, { source: { media: pic }, at: f(600), out: f(30), video: 'V2' });
  r = h.do(C.trim(s, im, { edge: 'start', delta: -f(100) }));
  eq([r, lay(h, s).V2], [{ applied: -f(100), clamped: null }, '400-430:0 500-630:0'], 'a still clip grows past any source length');
  r = h.do(C.trim(s, im, { edge: 'start', delta: -f(100) }));
  eq(r, { applied: -f(70), clamped: 'neighbour' }, 'a still clip stops at the clip before');
  // speed 2: the source room counts double
  const g = setup();
  const [sp] = place(g.h, g.s, { source: { media: g.a }, in: f(500), out: f(560), at: 0, video: 'V1' });
  g.h.do(C.setClip(g.s, sp, { speed: 2 }));
  r = g.h.do(C.trim(g.s, sp, { edge: 'end', delta: f(100) }));
  eq([r, lay(g.h, g.s).V1], [{ applied: f(20), clamped: 'source' }, '0-50:500'], 'at speed 2 the source end comes twice as soon');
  h.do(C.setTrack(s, 'V2', { locked: true }));
  unchanged(h, () => h.do(C.trim(s, im, { edge: 'end', delta: f(5) })), 'locked', 'trimming a clip on a locked track');
  // Slow motion late in a long recording: in/out are large and not whole ticks.
  const lg = setup();
  const [long] = lg.h.do(C.importMedia([{ path: 'D:/clips/stream.mp4', kind: 'video', duration: 9 * 3600 * SEC, video: VID, audio: AUD }])).ids;
  const [lv] = place(lg.h, lg.s, { source: { media: long }, in: 8 * 3600 * SEC + f(7), out: 8 * 3600 * SEC + f(97), at: f(30), video: 'V1', audio: 'A1' });
  let bad = 0;
  const longer = (k) => () => ({ duration: Math.round((model.clipDuration(clip(lg.h, lg.s, lv)) * k) / F) * F });
  for (const [i, sp] of [1 / 3, Math.E / 10, Math.SQRT1_2 / 3, 0.0137, 3.3, longer(0.77), longer(1.31)].entries()) {
    try {
      lg.h.do(C.setClip(lg.s, lv, typeof sp === 'number' ? { speed: sp, ripple: true } : { ...sp(), ripple: true }));
      lg.h.do(C.trim(lg.s, lv, { edge: 'start', delta: f(3 + i) }));
      lg.h.do(C.trim(lg.s, lv, { edge: 'end', delta: -f(2), mode: 'ripple' }));
      lg.h.do(C.trim(lg.s, lv, { edge: 'start', delta: -f(1), mode: 'ripple' }));
      lg.h.do(C.split(lg.s, clip(lg.h, lg.s, lv).start + f(1)));
    } catch (err) {
      bad++;
      console.log(`  slow motion at ${sp}: ${err.message} ${err.detail || ''}`);
    }
  }
  check(!bad && model.validate(lg.h.project).ok && clipsOf(lg.h, lg.s).every((x) => model.clipDuration(x) % F === 0), 'slow and fast speeds late in a 9 hour source keep whole-frame durations through trims and splits');
} catch (err) {
  check(false, `trimming: ${err.stack}`);
}

// ---------- cutting: split, remove, Q/W, gaps, lift and extract ----------
try {
  const { h, s, a, b, music } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1' });
  h.do(C.setKeyframes(s, v, 'opacity', [{ t: 0, v: 0 }, { t: f(60), v: 100 }]));
  h.do(C.setClip(s, au, { fadeIn: f(10), fadeOut: f(20) }));
  const r = step(h, C.split(s, f(45) + 77), 'split at the playhead');
  eq(lay(h, s), { V1: '0-45:0 45-90:45', V2: '', A1: '0-45:0 45-90:45', A2: '' }, 'split cuts linked clips together at the frame start');
  const right = clip(h, s, r.ids[0]);
  eq([clip(h, s, v).keyframes.opacity, right.keyframes.opacity], [[{ t: 0, v: 0, ease: 'linear' }, { t: f(45), v: 75, ease: 'linear' }], [{ t: 0, v: 75, ease: 'linear' }, { t: f(15), v: 100, ease: 'linear' }]], 'split divides keyframes at the cut');
  for (const t of [f(10), f(44), f(50), f(80)]) {
    const c0 = t < f(45) ? clip(h, s, v) : right;
    near(kf.propValue(c0, 'opacity', t - c0.start, 100), kf.valueAt([{ t: 0, v: 0 }, { t: f(60), v: 100 }], t), 1e-9, `opacity at frame ${t / F} is the same after the split`);
  }
  const ra = clipsOf(h, s).find((c) => c.track === 'A1' && c.start === f(45));
  eq([clip(h, s, au).fadeIn, clip(h, s, au).fadeOut, ra.fadeIn, ra.fadeOut], [f(10), 0, 0, f(20)], 'split keeps the fade in on the left and the fade out on the right');
  eq(h.do(C.split(s, f(45))).ids, [], 'split on an edit point does nothing');
  h.do(C.split(s, f(20), { trackIds: ['A1'], linked: false }));
  eq([lay(h, s).V1, lay(h, s).A1], ['0-45:0 45-90:45', '0-20:0 20-45:20 45-90:45'], 'split on one track with linked: false');
  h.undo();
  h.undo();

  // remove and ripple delete with sync lock
  const k = setup();
  const [kv] = place(k.h, k.s, { source: { media: k.a }, in: 0, out: f(60), at: 0, video: 'V1', audio: 'A1' });
  const [kw] = place(k.h, k.s, { source: { media: k.a }, in: f(100), out: f(160), at: f(60), video: 'V1', audio: 'A1' });
  place(k.h, k.s, { source: { media: k.b }, in: 0, out: f(30), at: f(150), video: 'V2' });
  place(k.h, k.s, { source: { media: k.music }, in: 0, out: f(300), at: 0, audio: 'A2' });
  const cc = k.h.do(C.addCaptionTrack(k.s, { items: [{ start: f(10), end: f(20), text: 'one' }, { start: f(70), end: f(80), text: 'two' }, { start: f(130), end: f(140), text: 'three' }] })).id;
  k.h.do(C.addMarker(k.s, { t: f(130), name: 'chapter', kind: 'chapter' }));
  step(k.h, C.remove(k.s, [kv]), 'delete');
  eq(lay(k.h, k.s), { V1: '60-120:100', V2: '150-180:0', A1: '60-120:100', A2: '0-300:0' }, 'delete leaves a gap, takes the linked audio');
  k.h.undo();
  step(k.h, C.remove(k.s, [kv], { ripple: true }), 'ripple delete');
  eq(lay(k.h, k.s), { V1: '0-60:100', V2: '90-120:0', A1: '0-60:100', A2: '0-240:60' }, 'ripple delete pulls every sync-locked track by the same amount');
  const items = k.h.project.sequences[0].captions[0].items.map((it) => [it.text, fr(it.start), fr(it.end)]);
  eq(items, [['two', 10, 20], ['three', 70, 80]], 'ripple delete moves the sync-locked captions the same amount');
  eq(k.h.project.sequences[0].markers.map((m) => fr(m.t)), [70], 'ripple delete moves the sequence markers');
  eq(k.h.list().at(-1).label, 'Ripple Delete', 'ripple delete label');
  k.h.undo();
  k.h.do(C.setTrack(k.s, 'A2', { syncLock: false }));
  k.h.do(C.setCaptionTrack(k.s, cc, { syncLock: false }));
  k.h.do(C.remove(k.s, [kv], { ripple: true }));
  eq([lay(k.h, k.s).A2, k.h.project.sequences[0].captions[0].items.length, k.h.project.sequences[0].markers[0].t], ['0-300:0', 3, f(130)], 'without sync lock the music, the captions and the markers stay');
  k.h.undo();
  k.h.undo();
  k.h.undo();

  // Q and W
  step(k.h, C.rippleToPlayhead(k.s, f(90), 'before', { trackIds: ['V1'] }), 'Q');
  eq(lay(k.h, k.s), { V1: '0-60:0 60-90:130', V2: '120-150:0', A1: '0-60:0 60-90:130', A2: '0-60:0 60-270:90' }, 'Q removes from the previous edit to the playhead, linked audio and sync-locked tracks too');
  k.h.undo();
  step(k.h, C.rippleToPlayhead(k.s, f(30), 'after', { trackIds: ['V1'] }), 'W');
  eq(lay(k.h, k.s), { V1: '0-30:0 30-90:100', V2: '120-150:0', A1: '0-30:0 30-90:100', A2: '0-30:0 30-270:60' }, 'W removes from the playhead to the next edit');
  k.h.undo();
  eq(k.h.do(C.rippleToPlayhead(k.s, f(500), 'after')).range, null, 'W after the last edit does nothing');

  // gaps
  const q = setup();
  place(q.h, q.s, { source: { media: q.b }, in: 0, out: f(30), at: 0, video: 'V1' });
  place(q.h, q.s, { source: { media: q.b }, in: 0, out: f(30), at: f(60), video: 'V1' });
  step(q.h, C.closeGap(q.s, 'V1', f(45)), 'close a gap');
  eq(lay(q.h, q.s).V1, '0-30:0 30-60:0', 'closing a gap pulls the next clips');
  q.h.undo();
  const qc = q.h.do(C.addCaptionTrack(q.s, { items: [{ start: f(35), end: f(40), text: '빈자리 위' }] })).id;
  unchanged(q.h, () => q.h.do(C.closeGap(q.s, 'V1', f(45))), 'gapBlocked', 'a gap under a sync-locked caption');
  q.h.do(C.setCaptionTrack(q.s, qc, { syncLock: false }));
  place(q.h, q.s, { source: { media: q.music }, in: 0, out: f(10), at: f(40), audio: 'A1' });
  unchanged(q.h, () => q.h.do(C.closeGap(q.s, 'V1', f(45))), 'gapBlocked', 'a gap over a sync-locked clip');
  q.h.do(C.setTrack(q.s, 'A1', { syncLock: false }));
  q.h.do(C.closeGap(q.s, 'V1', f(45)));
  eq([lay(q.h, q.s).V1, lay(q.h, q.s).A1], ['0-30:0 30-60:0', '40-50:0'], 'with sync lock off the gap closes on its own track');
  unchanged(q.h, () => q.h.do(C.closeGap(q.s, 'V1', f(15))), 'noGap', 'closing a gap on a clip');

  // lift and extract
  const l = setup();
  place(l.h, l.s, { source: { media: l.a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1' });
  place(l.h, l.s, { source: { media: l.music }, in: 0, out: f(120), at: 0, audio: 'A2' });
  step(l.h, C.lift(l.s, f(30), f(60), ['V1', 'A1']), 'lift');
  eq(lay(l.h, l.s), { V1: '0-30:0 60-90:60', V2: '', A1: '0-30:0 60-90:60', A2: '0-120:0' }, 'lift leaves a gap on the targeted tracks');
  l.h.undo();
  step(l.h, C.extract(l.s, f(30), f(60), ['V1', 'A1']), 'extract');
  eq(lay(l.h, l.s), { V1: '0-30:0 30-60:60', V2: '', A1: '0-30:0 30-60:60', A2: '0-30:0 30-90:60' }, 'extract closes the gap, and the sync-locked music loses the same range');
  unchanged(l.h, () => l.h.do(C.lift(l.s, f(30), f(30))), 'noRange', 'lift without a range');
} catch (err) {
  check(false, `cutting: ${err.stack}`);
}

// ---------- clip settings, speed, keyframes, links ----------
try {
  const { h, s, a, b } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1' });
  place(h, s, { source: { media: b }, in: 0, out: f(30), at: f(90), video: 'V1' });
  step(h, C.setClip(s, v, { props: { opacity: 50, position: [10, -20] }, name: 'Intro', label: 'blue', enabled: false }), 'clip settings');
  eq([clip(h, s, v).props.opacity, clip(h, s, v).props.position, clip(h, s, v).name, clip(h, s, v).enabled, clip(h, s, au).enabled], [50, [10, -20], 'Intro', false, true], 'setClip sets props and fields on the clip only');
  unchanged(h, () => h.do(C.setClip(s, au, { props: { opacity: 3 } })), 'invalid', 'an audio clip has no opacity');
  unchanged(h, () => h.do(C.setClip(s, v, { props: { opacity: 'x' } })), 'invalidResult', 'a prop of the wrong type');
  h.do(C.setKeyframes(s, v, 'opacity', [{ t: f(30), v: 1 }]));
  step(h, C.setClip(s, v, { speed: 2 }), 'speed 200%');
  eq([lay(h, s).V1, lay(h, s).A1, clip(h, s, v).keyframes.opacity[0].t], ['0-45:0 90-120:0', '0-45:0', f(15)], 'speed 2 halves the linked clips and moves keyframes to their source frames');
  eq(h.list().at(-1).label, 'Speed/Duration', 'speed label');
  h.undo();
  h.do(C.setClip(s, v, { speed: 0.5 }));
  eq([lay(h, s).V1, clip(h, s, v).out], ['0-90:0 90-120:0', f(45)], 'a slower clip without ripple stops at the next clip and shows less source');
  h.undo();
  step(h, C.setClip(s, v, { speed: 0.5, ripple: true }), 'speed 50% with ripple');
  eq(lay(h, s), { V1: '0-180:0 180-210:0', V2: '', A1: '0-180:0', A2: '' }, 'speed with ripple pushes the clips after');
  h.undo();
  h.do(C.setClip(s, v, { speed: 1.5 }));
  eq([model.clipDuration(clip(h, s, v)), model.validate(h.project).ok], [f(60), true], 'speed 1.5 gives whole frames');
  h.undo();
  unchanged(h, () => h.do(C.setClip(s, v, { speed: 0 })), 'speed', 'speed 0');
  step(h, C.setClip(s, v, { reverse: true }), 'reverse');
  check(clip(h, s, v).reverse && clip(h, s, au).reverse, 'reverse turns the linked audio too');
  h.undo();
  step(h, C.setClip(s, au, { fadeIn: f(10) + 3, fadeOut: f(500) }), 'fades');
  eq([clip(h, s, au).fadeIn, clip(h, s, au).fadeOut], [f(10), f(80)], 'fades snap to frames and fit the clip');

  step(h, C.setKeyframes(s, v, 'position', [{ t: f(20), v: [100, 0], ease: 'bezier', h: [0.1, 0.2, 0.3, 0.4] }, { t: 5, v: [0, 0], ease: 'easeIn' }]), 'set keyframes');
  eq(clip(h, s, v).keyframes.position, [{ t: 0, v: [0, 0], ease: 'easeIn' }, { t: f(20), v: [100, 0], ease: 'bezier', h: [0.1, 0.2, 0.3, 0.4] }], 'keyframes snap, sort and keep handles');
  unchanged(h, () => h.do(C.setKeyframes(s, v, 'volume', [{ t: 0, v: 1 }])), 'invalid', 'keyframes on a property the clip lacks');
  h.do(C.setKeyframes(s, v, 'scale', [{ t: 0, v: [100, 100] }]));
  eq(Object.keys(clip(h, s, v).keyframes), ['opacity', 'position', 'scale'], 'keyframed props in the order they were set');
  step(h, C.setKeyframes(s, v, 'opacity', null), 'clear the first keyframed prop');
  step(h, C.setKeyframes(s, v, 'position', null), 'clear keyframes');
  check(!('position' in clip(h, s, v).keyframes) && !('opacity' in clip(h, s, v).keyframes), 'null clears the keyframes');
  h.undo();
  h.undo();
  eq(Object.keys(clip(h, s, v).keyframes), ['opacity', 'position', 'scale'], 'undoing a cleared prop puts it back in its place');

  h.do(C.trim(s, v, { edge: 'start', delta: f(10) }));
  eq(clip(h, s, v).keyframes.opacity[0].t, f(20), 'a start trim keeps keyframes on their frames');

  step(h, C.unlink(s, [v]), 'unlink');
  eq([clip(h, s, v).link, clip(h, s, au).link], [null, null], 'unlink clears both sides');
  step(h, C.link(s, [v, au]), 'link');
  check(clip(h, s, v).link && clip(h, s, v).link === clip(h, s, au).link, 'link joins clips');
  unchanged(h, () => h.do(C.link(s, [v])), 'linkOne', 'linking one clip');
} catch (err) {
  check(false, `clip settings: ${err.stack}`);
}

// ---------- effects, transitions, generators, freeze frame ----------
try {
  const { h, s, a, b } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1', audio: 'A1' });
  const [w] = place(h, s, { source: { media: b }, in: 0, out: f(60), at: f(90), video: 'V1' });
  const e1 = step(h, C.addEffect(s, v, 'blur.gaussian'), 'add effect').id;
  const e2 = h.do(C.addEffect(s, v, 'color.basic', 0, { exposure: 0.5 })).id;
  eq(clip(h, s, v).effects.map((e) => [e.id, e.type]), [[e2, 'color.basic'], [e1, 'blur.gaussian']], 'effects get ids in the clip and go where asked');
  step(h, C.setEffect(s, v, e1, { on: false, params: { radius: 12 } }), 'set effect');
  h.do(C.setEffect(s, v, e2, { params: { exposure: null } }));
  eq([clip(h, s, v).effects[1].on, clip(h, s, v).effects[1].params, clip(h, s, v).effects[0].params], [false, { radius: 12 }, {}], 'setEffect merges params, null takes one back to its default');
  step(h, C.moveEffect(s, v, e1, 0), 'move effect');
  eq(clip(h, s, v).effects.map((e) => e.id), [e1, e2], 'moveEffect reorders');
  h.do(C.setKeyframes(s, v, `effects.${e1}.radius`, [{ t: 0, v: 0 }, { t: f(30), v: 20 }]));
  near(kf.propValue(clip(h, s, v), `effects.${e1}.radius`, f(15)), 10, 1e-9, 'an effect parameter animates');
  eq(kf.propValue(clip(h, s, v), `effects.${e2}.exposure`, 0, 0), 0, 'a parameter at its default reads the fallback');
  step(h, C.removeEffect(s, v, e1), 'remove effect');
  check(!clip(h, s, v).effects.some((e) => e.id === e1) && !Object.keys(clip(h, s, v).keyframes).length, 'removing an effect removes its keyframes');

  const t1 = step(h, C.addTransition(s, { track: 'V1', at: f(90) + 9, type: 'dissolve' }), 'add transition').id;
  const tr = () => h.project.sequences[0].transitions.find((x) => x.id === t1);
  eq([tr().at, tr().duration, tr().align], [f(90), SEC, 'center'], 'a transition snaps to the edit point with the default length');
  unchanged(h, () => h.do(C.addTransition(s, { track: 'V1', at: f(45), type: 'dissolve' })), 'noEdge', 'a transition mid-clip');
  step(h, C.setTransition(s, t1, { duration: f(15), align: 'start' }), 'set transition');
  eq([tr().duration, tr().align], [f(15), 'start'], 'setTransition');
  h.do(C.trim(s, v, { edge: 'end', delta: f(10), mode: 'roll' }));
  eq(tr().at, f(100), 'a transition follows a rolled edit point');
  h.undo();
  h.do(C.trim(s, v, { edge: 'end', delta: -f(30), mode: 'ripple' }));
  eq(tr()?.at, f(60), 'a transition follows a ripple trim');
  h.undo();
  h.do(C.move(s, [w], { delta: f(100) }));
  eq(tr()?.at, f(90), 'a transition between a clip and a moved one stays on the clip that stayed');
  h.undo();
  const t2 = h.do(C.addTransition(s, { track: 'V1', at: f(150), type: 'dipBlack', duration: f(10) })).id;
  h.do(C.move(s, [w], { delta: f(100) }));
  eq(h.project.sequences[0].transitions.find((x) => x.id === t2)?.at, f(250), 'a transition on the moved clip alone goes with it');
  h.undo();
  step(h, C.removeTransition(s, t1), 'remove transition');

  const text = step(h, C.addGenerated(s, { track: 'V2', at: f(10), duration: f(60), source: { generator: 'text', layers: [{ text: '안녕' }, { text: 'two', id: 'x' }] } }), 'add text').id;
  const tc = clip(h, s, text);
  eq([tc.source.layers.map((l) => [l.id, l.text, l.size]), lay(h, s).V2, h.list().at(-1).label], [[['l1', '안녕', 96], ['x', 'two', 96]], '10-70', 'Add Text'], 'a text clip with default layer styles');
  h.do(C.setKeyframes(s, text, 'layers.x.size', [{ t: 0, v: 10 }]));
  h.do(C.trim(s, text, { edge: 'end', delta: f(1000) }));
  eq(lay(h, s).V2, '10-1070', 'a text clip has no source end');
  const solid = h.do(C.addGenerated(s, { track: 'V2', at: f(1100), source: { generator: 'solid', color: '#ff0000' } })).id;
  eq([clip(h, s, solid).source, model.clipDuration(clip(h, s, solid))], [{ generator: 'solid', color: '#ff0000' }, 5 * SEC], 'a solid with the still length');
  unchanged(h, () => h.do(C.addGenerated(s, { track: 'A1', at: 0, source: { generator: 'solid' } })), 'noTrack', 'a generator on an audio track');

  h.do(C.setKeyframes(s, v, 'opacity', [{ t: 0, v: 0 }, { t: f(60), v: 60 }]));
  const fz = step(h, C.freezeFrame(s, v, f(30) + 1, f(60)), 'freeze frame').id;
  eq([lay(h, s).V1, lay(h, s).A1], ['0-30:0 30-90:30 90-150:30 150-210:0', '0-30:0 90-150:30'], 'freeze frame cuts the clip and pushes the rest with its audio');
  const fc = clip(h, s, fz);
  eq([fc.source, fc.keyframes.opacity, model.sourceTime(fc, f(80))], [{ media: a, freeze: true }, [{ t: 0, v: 30, ease: 'linear' }], f(30)], 'the freeze holds the frame and the values at the playhead');
  h.do(C.trim(s, fz, { edge: 'end', delta: f(10), mode: 'ripple' }));
  eq(lay(h, s).V1, '0-30:0 30-100:30 100-160:30 160-220:0', 'a freeze frame trims like a still');
  unchanged(h, () => h.do(C.freezeFrame(s, au, f(10))), 'noFrame', 'freezing an audio clip');
  unchanged(h, () => h.do(C.freezeFrame(s, v, f(500))), 'notOnClip', 'freezing off the clip');
} catch (err) {
  check(false, `effects: ${err.stack}`);
}

// ---------- markers, captions ----------
try {
  const { h, s, a } = setup();
  const [v] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: f(30), video: 'V1' });
  const m1 = step(h, C.addMarker(s, { t: f(60) + 3, name: 'b', kind: 'chapter', color: 'red' }), 'add marker').id;
  const m0 = h.do(C.addMarker(s, { t: f(10), name: 'a' })).id;
  eq(h.project.sequences[0].markers.map((m) => [m.id, fr(m.t), m.name, m.kind, m.color]), [[m0, 10, 'a', 'comment', 'green'], [m1, 60, 'b', 'chapter', 'red']], 'markers snap, default and stay in time order');
  step(h, C.setMarker(s, m1, { t: 0, note: 'start', duration: f(15) }), 'edit marker');
  eq(h.project.sequences[0].markers.map((m) => [m.id, fr(m.t), fr(m.duration), m.note]), [[m1, 0, 15, 'start'], [m0, 10, 0, '']], 'setMarker moves and re-sorts');
  unchanged(h, () => h.do(C.setMarker(s, m1, { kind: 'region' })), 'invalid', 'an unknown marker kind');
  step(h, C.removeMarker(s, m0), 'remove marker');
  const cm = step(h, C.addMarker(s, { t: f(50), name: 'clip' }, { clipId: v }), 'add clip marker').id;
  eq(clip(h, s, v).markers.map((m) => [m.id, fr(m.t)]), [[cm, 20]], 'a clip marker counts from the clip start');
  h.do(C.move(s, [v], { delta: f(10) }));
  h.do(C.split(s, f(60)));
  eq([clip(h, s, v).markers.length, clipsOf(h, s).find((c) => c.start === f(60)).markers.map((m) => fr(m.t))], [0, [0]], 'clip markers move with the clip and go to the right piece of a split');

  const ct = step(h, C.addCaptionTrack(s, { lang: 'ko', name: '한국어' }), 'add caption track').id;
  const track = () => h.project.sequences[0].captions.find((x) => x.id === ct);
  eq([track().style.position, track().syncLock], ['bottom', true], 'a caption track has the default style');
  step(h, C.setCaptions(s, ct, [{ start: 2 * SEC, end: 3 * SEC, text: '둘' }, { start: 1.5 * SEC + 1, end: 1.5 * SEC + 2, text: '하나' }]), 'set captions');
  eq(track().items.map((it) => [it.text, fr(it.start), fr(it.end)]), [['하나', 45, 46], ['둘', 60, 90]], 'setCaptions sorts, snaps to the nearest frame, keeps a frame');
  const c3 = step(h, C.addCaption(s, ct, { start: SEC, end: 1.2 * SEC, text: '영' }), 'add caption').id;
  eq(track().items[0].id, c3, 'addCaption keeps time order');
  step(h, C.setCaption(s, ct, c3, { start: 4 * SEC, end: 5 * SEC, text: '셋' }), 'edit caption');
  eq(track().items.map((it) => it.text), ['하나', '둘', '셋'], 'setCaption re-sorts');
  unchanged(h, () => h.do(C.setCaption(s, ct, c3, { color: 'x' })), 'invalid', 'an unknown caption field');
  step(h, C.removeCaption(s, ct, c3), 'remove caption');
  step(h, C.setCaptionTrack(s, ct, { style: { size: 70, position: 'top' }, name: 'KO' }), 'caption style');
  eq([track().style.size, track().style.position, track().style.font, track().name], [70, 'top', 'Malgun Gothic', 'KO'], 'caption style merges');
  // captions follow insert as a sync-locked track
  h.do(C.place(s, { source: { media: a }, in: 0, out: f(30), at: f(50), video: 'V2', mode: 'insert' }));
  eq(track().items.map((it) => [fr(it.start), fr(it.end)]), [[45, 46], [90, 120]], 'captions after an insert move with it');
  h.do(C.place(s, { source: { media: a }, in: 0, out: f(10), at: f(100), video: 'V2', mode: 'insert' }));
  eq(track().items.map((it) => [it.text, fr(it.start), fr(it.end)]), [['하나', 45, 46], ['둘', 90, 100], ['둘', 110, 130]], 'a caption across an insert shows on both sides');
  step(h, C.removeCaptionTrack(s, ct), 'remove caption track');
} catch (err) {
  check(false, `markers and captions: ${err.stack}`);
}

// ---------- caption word timings (the word-by-word highlight) ----------
try {
  const CW = require('../renderer/features/cut/captionwords.js');
  const Sp = require('../renderer/features/cut/speech.js');
  const ws = (list) => list.map(([a, b, text]) => ({ t0: f(a), t1: f(b), text }));
  const three = ws([[0, 15, 'alpha'], [21, 36, 'beta'], [42, 57, 'gamma']]);
  const D = { frame: F, duration: f(66) };
  const timesOf = (words) => words && words.map((w) => [fr(w.t0), fr(w.t1), w.text]);
  eq(CW.tokens(' alpha  beta\ngamma '), ['alpha', 'beta', 'gamma'], 'a caption\'s tokens run across its lines');
  check(CW.valid(three, 'alpha beta\ngamma') && !CW.valid(three, 'alpha gamma') && !CW.valid(ws([[21, 36, 'alpha'], [0, 15, 'beta'], [42, 57, 'gamma']]), 'alpha beta gamma'),
    'words are valid only one per token, in order, never going back in time');
  eq(CW.realign(three, 'alpha beta gamma', D), three, 'the same text keeps every timing');
  eq(timesOf(CW.realign(three, 'Alpha, beta\ngamma!', D)), [[0, 15, 'Alpha,'], [21, 36, 'beta'], [42, 57, 'gamma!']], 'case, punctuation and line breaks keep the timings');
  eq(timesOf(CW.realign(three, 'alpha bravo gamma', D)), [[0, 15, 'alpha'], [21, 36, 'bravo'], [42, 57, 'gamma']], 'a replaced word takes the time of the word it replaces');
  eq(timesOf(CW.realign(three, 'alpha bravo charlie gamma', D)), [[0, 15, 'alpha'], [21, 29, 'bravo'], [29, 36, 'charlie'], [42, 57, 'gamma']], 'two words for one share its time evenly, on frames');
  eq(timesOf(CW.realign(three, 'alpha beta gamma delta', D)), [[0, 15, 'alpha'], [21, 36, 'beta'], [42, 57, 'gamma'], [57, 66, 'delta']], 'a word added at the end takes the time left in the caption');
  eq(timesOf(CW.realign(three, 'alpha beta new gamma', D)), [[0, 15, 'alpha'], [21, 36, 'beta'], [36, 42, 'new'], [42, 57, 'gamma']], 'a word added in a pause takes the pause');
  eq(CW.realign(ws([[0, 15, 'alpha'], [15, 30, 'beta']]), 'alpha new beta', D), null, 'a word added where there is no time turns the highlight off');
  eq(CW.realign(three, 'something else entirely', D), null, 'a text with no word left from the speech has no timings');
  eq(timesOf(CW.realign(three, 'alpha gamma', D)), [[0, 15, 'alpha'], [42, 57, 'gamma']], 'a deleted word takes its timing with it');
  eq(timesOf(CW.realign([{ t0: 0, t1: f(20), text: 'two words' }], 'two words', D)), [[0, 10, 'two'], [10, 20, 'words']], 'a recognised word holding two tokens shares its time');
  eq([CW.realign('x', 'a'), CW.realign([{ t0: 'a' }], 'a'), CW.realign([], 'a'), CW.realign(three, '')], [null, null, null, null], 'anything else gives null, never an exception');
  eq([-1, 0, 14, 15, 18, 21, 40, 42, 56, 57, 70].map((n) => CW.lit(three, f(n))), [-1, 0, 0, 0, 0, 1, 1, 2, 2, -1, -1],
    'the lit word: the last begun, held through a pause until the next begins, none after the last one ends');
  eq([0, 5, 10].map((n) => CW.lit(ws([[0, 5, 'a'], [5, 5, 'gone'], [5, 10, 'c']]), f(n))), [0, 2, -1], 'a word of no length (cut away) is never lit');
  eq(CW.litAt({ start: f(100), text: 'alpha beta gamma', words: three }, f(122)), 1, 'litAt counts from the caption start');
  eq(CW.litAt({ start: f(100), text: 'alpha beta', words: three }, f(122)), -1, 'words that do not match the text light nothing');

  // speech recognition's captions carry them
  const heard = [[0.5, 1.0, 'alpha'], [1.2, 1.7, 'beta'], [1.9, 2.4, 'gamma']].map(([a, b, text]) => ({ t0: a * SEC, t1: b * SEC, text }));
  const made = Sp.captions(heard, { frame: F });
  eq(made.map((c) => [fr(c.start), fr(c.end), c.text, timesOf(c.words)]), [[15, 81, 'alpha beta gamma', [[0, 15, 'alpha'], [21, 36, 'beta'], [42, 57, 'gamma']]]],
    'Auto Captions\' captions carry each word\'s time from the caption start, on frames');
  check(made.every((c) => CW.valid(c.words, c.text)), 'and they fit the caption text');

  const { h, s, a } = setup();
  const [v] = place(h, s, { source: { media: a }, in: 0, out: f(600), at: 0, video: 'V1' });
  const ct = step(h, C.addCaptionTrack(s, { name: 'Auto Captions', items: made }), 'a caption track with word timings').id;
  const item = () => h.project.sequences[0].captions.find((x) => x.id === ct).items[0];
  eq(timesOf(item().words), [[0, 15, 'alpha'], [21, 36, 'beta'], [42, 57, 'gamma']], 'the command keeps the timings');
  eq([model.defaultCaptionStyle().highlight, model.defaultCaptionStyle().highlightMode], [false, 'color'], 'the highlight is off until it is turned on');
  step(h, C.setCaptionTrack(s, ct, { style: { highlight: true, highlightColor: '#00ff88', highlightMode: 'box' } }), 'turn the highlight on');
  const id = item().id;
  step(h, C.setCaption(s, ct, id, { text: 'Alpha bravo\ngamma delta' }), 'edit a caption with word timings');
  eq(timesOf(item().words), [[0, 15, 'Alpha'], [21, 36, 'bravo'], [42, 57, 'gamma'], [57, 66, 'delta']], 'editing the text keeps the words that still match and fits the new ones');
  h.undo();
  eq(timesOf(item().words), [[0, 15, 'alpha'], [21, 36, 'beta'], [42, 57, 'gamma']], 'undo brings the old timings back');
  h.redo();
  eq(item().text, 'Alpha bravo\ngamma delta', 'redo the edit');
  h.undo();
  step(h, C.setCaption(s, ct, id, { text: 'nothing like it' }), 'a rewritten caption');
  check(item().words === undefined && model.validate(h.project).ok, 'a rewritten caption loses its timings and stays valid');
  h.undo();
  step(h, C.setCaption(s, ct, id, { start: f(25), end: f(91) }), 'move a caption');
  eq(timesOf(item().words)[1], [21, 36, 'beta'], 'a moved caption takes its words along');
  h.undo();
  step(h, C.setCaption(s, ct, id, { start: f(20) }), 'trim a caption start');
  eq(timesOf(item().words), [[-5, 10, 'alpha'], [16, 31, 'beta'], [37, 52, 'gamma']], 'a trimmed start leaves the words where they are spoken');
  h.undo();
  step(h, C.setCaption(s, ct, id, { words: null }), 'turn one caption\'s timings off');
  check(item().words === undefined, 'words: null drops them');
  h.undo();
  unchanged(h, () => h.do(C.setCaption(s, ct, id, { word: [] })), 'invalid', 'an unknown caption field');

  // ripples keep the words with their sound, and the words Whisper was unsure of (doubt) too
  step(h, C.setCaption(s, ct, id, { doubt: [[0, 'alpha'], [21, 'beta'], [42, 'gamma']].map(([at, text]) => ({ at: f(at), text, p: 0.3 })), speaker: 'sp1' }), 'mark all three words uncertain, said by sp1');
  const doubtAt = (items) => items.flatMap((it) => (it.doubt || []).map((d) => [fr(it.start + d.at), d.text]));
  const abs = () => item().words.map((w) => fr(item().start + w.t0));
  step(h, C.place(s, { source: { media: a }, in: 0, out: f(30), at: f(45), video: 'V2', mode: 'insert' }), 'an insert across a caption with word timings');
  const pieces = () => h.project.sequences[0].captions.find((x) => x.id === ct).items;
  eq(pieces().map((it) => [fr(it.start), fr(it.end), timesOf(it.words).map((w) => [fr(it.start) + w[0], fr(it.start) + w[1]])]),
    [[15, 45, [[15, 30], [36, 81], [87, 102]]], [75, 111, [[15, 30], [36, 81], [87, 102]]]],
    'the words after the insert move with their sound (beta, begun before it, ends after it), in both pieces of the caption');
  eq(pieces().map((it) => doubtAt([it])), [[[15, 'alpha'], [36, 'beta']], [[87, 'gamma']]],
    'the uncertain words move with their sound too, each marked on the piece that holds its start');
  eq(pieces().map((it) => it.speaker), ['sp1', 'sp1'], 'both pieces keep who says the caption');
  eq([CW.litAt(pieces()[0], f(20)), CW.litAt(pieces()[0], f(40)), CW.litAt(pieces()[1], f(78)), CW.litAt(pieces()[1], f(90)), CW.litAt(pieces()[1], f(105))], [0, 1, 1, 2, -1],
    'each piece lights what it shows: alpha and beta before the insert, the rest of beta and gamma after');
  h.undo();
  step(h, C.split(s, f(30), { trackIds: ['V1'] }), 'split');
  const [left] = clipsOf(h, s).filter((x) => x.track === 'V1').sort((x, y) => x.start - y.start);
  step(h, C.remove(s, [left.id], { ripple: true }), 'a ripple delete under a caption with word timings');
  eq([fr(item().start), fr(item().end), abs(), CW.litAt(item(), f(0)), CW.litAt(item(), f(6))], [0, 51, [0, 6, 27], -1, 1],
    'a ripple delete pulls the words with the sound: alpha is gone, beta is lit where it is now heard');
  eq(timesOf(item().words)[0].slice(0, 2), [0, 0], 'the word cut away has no length left');
  eq(doubtAt([item()]), [[6, 'beta'], [27, 'gamma']], 'a ripple delete pulls the uncertain words with the sound, and alpha, cut away, is no longer marked');
  h.undo();
  h.undo();
  step(h, C.setSequence(s, { fps: [25, 1] }), 'a new frame rate');
  const F25 = time.frameTicks([25, 1]);
  check(item().words.every((w) => w.t0 % F25 === 0 && w.t1 % F25 === 0) && CW.valid(item().words, item().text), 'word times move to the new frames');
  check(item().doubt.length === 3 && item().doubt.every((d, i) => d.at % F25 === 0 && Math.abs(item().start + d.at - f([15, 36, 57][i])) <= F25 / 2),
    `uncertain words move to the new frames, where they are spoken (${S(item().doubt.map((d) => (item().start + d.at) / F25))})`);
  h.undo();
  step(h, C.setCaption(s, ct, id, { start: f(30) }), 'trim the start of a caption with uncertain words');
  eq(doubtAt([item()]), [[36, 'beta'], [57, 'gamma']], 'a trimmed start leaves the uncertain words where they are spoken, and alpha, before it now, is no longer marked');
  h.undo();

  // files: saved and opened again, written by hand
  const back = model.migrate(h.serialize());
  eq(back.sequences[0].captions[0].items[0].words, item().words, 'the timings survive serialize and migrate');
  eq([back.sequences[0].captions[0].style.highlight, back.sequences[0].captions[0].style.highlightColor], [true, '#00ff88'], 'and so does the highlight style');
  const json = JSON.parse(h.serialize());
  json.sequences[0].captions[0].items[0].text = 'ALPHA beta gamma';
  json.sequences[0].captions[0].items.push({ id: 'cap999', start: f(200), end: f(230), text: 'x', words: [{ t0: 'bad' }] });
  const fixed = model.migrate(JSON.stringify(json));
  eq([timesOf(fixed.sequences[0].captions[0].items[0].words)[0], fixed.sequences[0].captions[0].items[1].words, model.validate(fixed).ok], [[0, 15, 'ALPHA'], undefined, true],
    'migrate fits timings to a text changed by hand and drops ones it cannot read');
  const broken = model.clone(h.project);
  broken.sequences[0].captions[0].items[0].text = 'alpha beta';
  check(!model.validate(broken).ok, 'validate refuses words that do not match the text');
} catch (err) {
  check(false, `caption word timings: ${err.stack}`);
}

// ---------- media, bins, sequences, tracks ----------
try {
  const { h, s, a, b, music } = setup();
  const bin = step(h, C.addBin('Footage'), 'add bin').id;
  const sub = h.do(C.addBin('Day 1', bin)).id;
  const [m] = step(h, C.importMedia([{ path: 'E:\\x\\c.mov', kind: 'video', duration: SEC, video: VID, audio: null }], sub), 'import into a bin').ids;
  eq([h.project.media.at(-1).name, h.project.bins.find((x) => x.id === sub).items], ['c.mov', [m]], 'import names media by file and files it in the bin');
  step(h, C.moveToBin([a, b], bin), 'move to bin');
  step(h, C.moveToBin([a], sub), 'move between bins');
  eq(h.project.bins.map((x) => x.items), [[b], [m, a]], 'an item is in one bin at a time');
  unchanged(h, () => h.do(C.moveToBin([bin], sub)), 'binLoop', 'a bin into its own child');
  step(h, C.renameItem(bin, 'Shots'), 'rename');
  step(h, C.removeBin(sub), 'remove bin');
  eq(h.project.bins.map((x) => [x.name, x.items]), [['Shots', [b, m, a]]], 'removing a bin hands its items to the parent');
  const [v] = place(h, s, { source: { media: a }, in: 0, out: f(30), at: 0, video: 'V1', audio: 'A1' });
  step(h, C.relinkMedia(a, { path: 'F:/moved/a.mp4', size: 99, mtime: 5 }), 'relink');
  eq([h.project.media[0].path, h.project.media[0].size, clip(h, s, v).source.media], ['F:/moved/a.mp4', 99, a], 'relink changes the path, clips keep their media');
  step(h, C.removeMedia([a]), 'remove media');
  eq([clipsOf(h, s).length, h.project.bins[0].items], [0, [b, m]], 'removing media removes its clips and bin entries');
  h.undo();

  const s2 = step(h, C.addSequence({ name: 'Shorts', w: 1080, h: 1920, fps: [60, 1] }), 'add sequence').id;
  const seq2 = h.project.sequences.find((x) => x.id === s2);
  eq([seq2.w, seq2.h, seq2.fps, seq2.tracks.length], [1080, 1920, [60, 1], 4], 'a new sequence with its settings');
  h.do(C.addTransition(s, { track: 'V1', at: f(30), type: 'dissolve' }));
  h.do(C.addMarker(s, { t: f(5) }));
  const s3 = step(h, C.addSequence({ from: s }), 'duplicate sequence').id;
  const dup = h.project.sequences.find((x) => x.id === s3);
  const orig = h.project.sequences.find((x) => x.id === s);
  check(dup.clips.length === 2 && dup.clips.every((c, i) => c.id !== orig.clips[i].id) && dup.clips[0].link !== orig.clips[0].link && dup.clips[0].link === dup.clips[1].link && dup.name === `${orig.name} Copy`,
    'a duplicated sequence has new ids and its own link');
  eq(h.list().at(-1).label, 'Duplicate Sequence', 'duplicate label');
  h.do(C.split(s3, f(10)));
  eq(clipsOf(h, s).length, 2, 'editing the copy leaves the original');
  unchanged(h, () => h.do(C.addSequence({ fps: [17, 1] })), 'fps', 'a sequence with an odd frame rate');
  // 30 -> 25 fps: every time moves to the nearest 25 fps frame
  step(h, C.setSequence(s, { fps: [25, 1], name: 'PAL', background: '#112233' }), 'change the frame rate');
  const F25 = time.frameTicks([25, 1]);
  const o = h.project.sequences.find((x) => x.id === s);
  eq([o.fps, o.clips.map((c) => [c.start / F25, model.clipDuration(c) / F25]), o.transitions[0].at / F25, o.name], [[25, 1], [[0, 25], [0, 25]], 25, 'PAL'], 'a frame rate change re-snaps clips and transitions');
  unchanged(h, () => h.do(C.setSequence(s, { w: 3 })), 'size', 'a frame size too small');
  eq(o.masterGain, 0, 'a new sequence has a master gain of 0 dB');
  step(h, C.setSequence(s, { masterGain: -3.5 }), 'set the master gain');
  eq(h.project.sequences.find((x) => x.id === s).masterGain, -3.5, 'the master gain is kept on the sequence');
  unchanged(h, () => h.do(C.setSequence(s, { masterGain: NaN })), 'gain', 'a master gain that is not a number');
  {
    const p = JSON.parse(h.serialize());
    delete p.sequences[0].masterGain;
    eq(model.migrate(JSON.stringify(p)).sequences[0].masterGain, 0, 'a project saved before master gain opens with 0 dB');
    p.sequences[0].masterGain = 'loud';
    check(!model.validate(p).ok, 'validate refuses a master gain that is not a number');
  }
  step(h, C.removeSequence(s2), 'remove sequence');

  const vt = step(h, C.addTrack(s3, 'video', 0), 'add track').id;
  const at = h.do(C.addTrack(s3, 'audio')).id;
  eq([vt, at, h.project.sequences.find((x) => x.id === s3).tracks.map((t) => t.id)], ['V3', 'A3', ['V3', 'V1', 'V2', 'A1', 'A2', 'A3']], 'tracks go where asked with new ids');
  step(h, C.setTrack(s3, 'A3', { volume: -6, pan: 300, mute: true, name: 'Music' }), 'track settings');
  const t3 = h.project.sequences.find((x) => x.id === s3).tracks.at(-1);
  eq([t3.volume, t3.pan, t3.mute, t3.name], [-6, 100, true, 'Music'], 'track settings, pan clamped');
  unchanged(h, () => h.do(C.setTrack(s3, 'V3', { mute: true })), 'invalid', 'a video track has no mute');
  step(h, C.removeTrack(s3, 'V1'), 'remove track');
  eq(lay(h, s3), { V3: '', V2: '', A1: '0-10:0 10-30:10', A2: '', A3: '' }, 'removing a track removes its clips and clears their links');
  check(clipsOf(h, s3).every((c) => c.link === null), 'links left with one clip are cleared');
} catch (err) {
  check(false, `media and sequences: ${err.stack}`);
}

// ---------- paste, text layers, generators, settings, proxies, speed by duration ----------
try {
  const { h, s, a, b, music } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: f(10), out: f(70), at: f(30), video: 'V1', audio: 'A1' });
  place(h, s, { source: { media: music }, in: 0, out: f(20), at: f(100), audio: 'A2' });
  h.do(C.setKeyframes(s, v, 'opacity', [{ t: 0, v: 0 }, { t: f(10), v: 100 }]));
  h.do(C.addEffect(s, v, 'vignette'));
  // what the timeline copies: clip objects as they are, plus the kind of track they were on
  const copied = clipsOf(h, s).map((x) => ({ ...model.clone(x), kind: h.project.sequences[0].tracks.find((t) => t.id === x.track).kind }));
  const r = step(h, C.paste(s, copied, { at: f(200) }), 'paste');
  eq(lay(h, s), { V1: '30-90:10 200-260:10', V2: '', A1: '30-90:10 200-260:10', A2: '100-120:0 270-290:0' }, 'paste keeps the spacing in time and tracks');
  const pv = clip(h, s, r.ids[0]);
  check(r.ids.length === 3 && pv.link && pv.link !== clip(h, s, v).link && clip(h, s, r.ids[1]).link === pv.link && pv.keyframes.opacity.length === 2 && pv.effects[0].type === 'vignette', 'pasted clips have new ids, a new link of their own, the keyframes and effects');
  step(h, C.paste(s, copied, { at: f(10), video: 'V2', audio: 'A1', mode: 'insert' }), 'paste insert onto other tracks');
  eq(lay(h, s), { V1: '120-180:10 290-350:10', V2: '10-70:10', A1: '10-70:10 120-180:10 290-350:10', A2: '80-100:0 190-210:0 360-380:0' }, 'insert paste: the lowest copied tracks land on the targets, sync-locked tracks make room');
  h.undo();
  h.do(C.setTrack(s, 'V2', { locked: true }));
  unchanged(h, () => h.do(C.paste(s, copied, { at: 0, video: 'V2' })), 'locked', 'pasting onto a locked track');
  unchanged(h, () => h.do(C.paste(s, copied, { at: 0, audio: 'A2' })), 'noTrack', 'pasting two audio tracks from the last one');

  const t = h.do(C.addGenerated(s, { track: 'V1', at: f(400), source: { generator: 'text' } })).id;
  const tc = () => clip(h, s, t);
  step(h, C.setLayer(s, t, 'l1', { text: '제목', size: 120, stroke: { color: '#000000', width: 4 } }), 'edit a text layer');
  eq([tc().source.layers[0].text, tc().source.layers[0].size, tc().source.layers[0].stroke], ['제목', 120, { color: '#000000', width: 4 }], 'setLayer sets fields');
  unchanged(h, () => h.do(C.setLayer(s, t, 'l1', { colour: 'x' })), 'invalid', 'an unknown text layer field');
  const l2 = step(h, C.addLayer(s, t, { text: '부제' }, 0), 'add a text layer').id;
  eq(tc().source.layers.map((l) => [l.id, l.text]), [[l2, '부제'], ['l1', '제목']], 'addLayer puts a new layer where asked');
  h.do(C.setKeyframes(s, t, `layers.${l2}.size`, [{ t: 0, v: 10 }, { t: f(10), v: 50 }]));
  step(h, C.removeLayer(s, t, l2), 'remove a text layer');
  eq([tc().source.layers.map((l) => l.id), Object.keys(tc().keyframes)], [['l1'], []], 'removing a layer removes its keyframes');
  step(h, C.setGenerator(s, t, { layers: [{ text: 'A' }, { text: 'B' }] }), 'replace the layers');
  eq(tc().source.layers.map((l) => [l.id, l.text]), [['l1', 'A'], ['l2', 'B']], 'setGenerator replaces the layers');
  const solid = h.do(C.addGenerated(s, { track: 'V1', at: f(600), source: { generator: 'solid', color: '#000000' } })).id;
  step(h, C.setGenerator(s, solid, { color: '#123456' }), 'solid color');
  eq(clip(h, s, solid).source.color, '#123456', 'a solid changes color');
  unchanged(h, () => h.do(C.setGenerator(s, t, { color: '#ffffff' })), 'invalid', 'a text clip has no color');
  unchanged(h, () => h.do(C.setLayer(s, v, 'l1', { text: 'x' })), 'invalid', 'a video clip has no text layers');

  step(h, C.setSettings({ transitionDuration: f(15), fit: 'fill', textStyles: [{ id: 'st1', name: '제목', style: { size: 100 } }] }), 'project settings');
  eq([h.project.settings.fit, h.project.settings.textStyles[0].name], ['fill', '제목'], 'settings hold the fit mode and saved text styles');
  const tr = h.do(C.addTransition(s, { track: 'V1', at: f(90), type: 'dissolve' })).id;
  eq(h.project.sequences[0].transitions.find((x) => x.id === tr).duration, f(15), 'a new transition takes the default length from the settings');
  unchanged(h, () => h.do(C.setSettings({ fit: 'stretch' })), 'invalid', 'an unknown fit mode');
  unchanged(h, () => h.do(C.setSettings({ stillDuration: -5 })), 'invalid', 'a negative still length');

  step(h, C.setProxy(a, { path: 'cache:proxy-a' }), 'set a proxy');
  eq(h.project.media[0].proxy, { path: 'cache:proxy-a' }, 'a media proxy');
  h.do(C.relinkMedia(a, { path: 'G:/a.mp4' }));
  eq(h.project.media[0].proxy, null, 'relinking drops the proxy of the old file');

  step(h, C.setClip(s, v, { duration: f(30) }), 'speed by duration');
  eq([lay(h, s).V1.split(' ')[0], clip(h, s, v).speed, clip(h, s, au).speed, h.list().at(-1).label], ['30-60:10', 2, 2, 'Speed/Duration'], 'a duration gives the speed that fits the source into it');
  h.do(C.setClip(s, solid, { duration: f(20) }));
  eq(model.clipDuration(clip(h, s, solid)), f(20), 'a still takes the duration as its length');
  unchanged(h, () => h.do(C.setClip(s, v, { duration: f(30), speed: 2 })), 'invalid', 'speed and duration together');
} catch (err) {
  check(false, `paste and text: ${err.stack}`);
}

// ---------- history: grouping, dirty, limit, events, failures ----------
try {
  const { h, s, a } = setup();
  const [v] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1' });
  const reasons = [];
  const off = h.onChange((r) => reasons.push(r));
  const before = h.serialize();
  const steps = h.list().length;
  h.begin('Opacity');
  for (const o of [90, 70, 50, 30]) h.do(C.setClip(s, v, { props: { opacity: o } }));
  h.commit();
  eq([h.list().length - steps, h.list().at(-1).label, clip(h, s, v).props.opacity], [1, 'Opacity', 30], 'a group is one undo step');
  h.undo();
  eq([h.serialize() === before, clip(h, s, v).props.opacity], [true, 100], 'undoing a group takes it all back');
  h.redo();
  eq(clip(h, s, v).props.opacity, 30, 'redo of a group');
  h.undo();
  h.begin('Drag');
  h.begin('inner');
  h.do(C.setClip(s, v, { props: { opacity: 10 } }));
  h.commit();
  check(h.grouping, 'a nested commit leaves the outer group open');
  h.do(C.setClip(s, v, { props: { opacity: 20 } }));
  h.cancel();
  eq([h.serialize() === before, h.grouping, h.canRedo], [true, false, false], 'cancel takes the whole group back and leaves no step');
  eq(reasons.slice(0, 8), ['do', 'do', 'do', 'do', 'commit', 'undo', 'redo', 'undo'], 'onChange reasons (a commit tells the list of steps changed)');
  off();
  h.do(C.setClip(s, v, { name: 'x' }));
  eq(reasons.length, 11, 'a removed listener hears nothing');

  check(h.dirty, 'edits make the project dirty');
  h.markSaved();
  check(!h.dirty, 'markSaved clears dirty');
  h.do(C.setClip(s, v, { name: 'y' }));
  check(h.dirty, 'an edit after saving is dirty');
  h.undo();
  check(!h.dirty, 'undoing back to the saved state is clean');
  h.undo();
  check(h.dirty, 'undoing past the saved state is dirty');
  h.redo();
  check(!h.dirty, 'redo back to the saved state is clean');
  h.undo();
  h.do(C.setClip(s, v, { name: 'z' }));
  h.do(C.setClip(s, v, { name: 'x' }));
  check(h.dirty && !h.canRedo, 'a new edit drops the redo steps; the saved state is gone');

  const noop = h.list().length;
  h.do(C.setClip(s, v, { name: 'x' }));
  h.do(C.move(s, [v], { delta: 0 }));
  eq(h.list().length, noop, 'a command that changes nothing is not a step');
  unchanged(h, () => h.do({ type: 'nope' }), 'invalid', 'an unknown command');
  unchanged(h, () => h.do(C.split('s999', 0)), 'notFound', 'a missing sequence');
  const [bad] = place(h, s, { source: { media: a }, in: 0, out: f(30), at: f(200), video: 'V1' });
  unchanged(h, () => h.do(C.setClip(s, bad, { props: { scale: [1] } })), 'invalidResult', 'a command whose result does not validate');

  const small = setup();
  const lim = C.createHistory(small.h.project, { limit: 3 });
  const [lv] = lim.do(C.place(small.s, { source: { media: small.a }, in: 0, out: f(30), at: 0, video: 'V1' })).ids;
  lim.markSaved();
  for (const n of ['1', '2', '3', '4']) lim.do(C.setClip(small.s, lv, { name: n }));
  eq(lim.list().length, 3, 'the step limit drops the oldest steps');
  while (lim.undo());
  eq([clip(lim, small.s, lv).name, lim.dirty], ['1', true], 'after dropped steps, undoing all stops at the oldest kept step and stays dirty');
  check(JSON.parse(lim.serialize()).format === 'ncut', 'serialize gives the project JSON');
} catch (err) {
  check(false, `history: ${err.stack}`);
}

// ---------- keyframes ----------
try {
  const lin = [{ t: 0, v: 0, ease: 'linear' }, { t: 100, v: 10, ease: 'linear' }, { t: 200, v: 30, ease: 'hold' }, { t: 300, v: 0 }];
  eq([kf.valueAt(lin, -5), kf.valueAt(lin, 0), kf.valueAt(lin, 50), kf.valueAt(lin, 150), kf.valueAt(lin, 250), kf.valueAt(lin, 300), kf.valueAt(lin, 999)], [0, 0, 5, 20, 30, 0, 0], 'linear and hold values, clamped before and after');
  eq([kf.valueAt([], 5, 7), kf.valueAt(null, 5, 7), kf.valueAt([{ t: 9, v: 3 }], 0, 7)], [7, 7, 3], 'no keyframes: the fallback; one keyframe: its value');
  // An independent cubic-bezier: sample the curve densely and read y where x crosses.
  const ref = (h, x) => {
    let best = 0;
    for (let i = 0; i <= 200000; i++) {
      const s = i / 200000;
      const bx = 3 * (1 - s) ** 2 * s * h[0] + 3 * (1 - s) * s * s * h[2] + s ** 3;
      if (bx >= x) return 3 * (1 - s) ** 2 * s * h[1] + 3 * (1 - s) * s * s * h[3] + s ** 3;
      best = s;
    }
    return best;
  };
  for (const [ease, h] of [['easeIn', [0.42, 0, 1, 1]], ['easeOut', [0, 0, 0.58, 1]], ['easeInOut', [0.42, 0, 0.58, 1]]]) {
    for (const u of [0.1, 0.25, 0.5, 0.8]) near(kf.valueAt([{ t: 0, v: 0, ease }, { t: 1000, v: 100 }], u * 1000), 100 * ref(h, u), 0.01, `${ease} at ${u}`);
  }
  near(kf.valueAt([{ t: 0, v: 0, ease: 'easeIn' }, { t: 1000, v: 100 }], 500), 31.53, 0.01, 'ease-in at the middle is about 31.5%');
  const handles = [0.68, -0.55, 0.27, 1.55];
  for (const u of [0.2, 0.5, 0.9]) near(kf.valueAt([{ t: 0, v: 0, ease: 'bezier', h: handles }, { t: 1, v: 1 }], u), ref(handles, u), 1e-4, `bezier with overshooting handles at ${u}`);
  near(kf.valueAt([{ t: 0, v: 0, ease: 'bezier', h: [0, 0, 1, 1] }, { t: 10, v: 1 }], 3), 0.3, 1e-6, 'bezier (0,0,1,1) is linear');
  eq(kf.valueAt([{ t: 0, v: [0, 100], ease: 'linear' }, { t: 10, v: [10, 0] }], 5), [5, 50], 'arrays interpolate per element');
  eq(kf.valueAt([{ t: 0, v: '#000000', ease: 'linear' }, { t: 10, v: '#ff8040' }], 5), '#804020', 'colors interpolate per channel');
  eq(kf.valueAt([{ t: 0, v: 'a', ease: 'linear' }, { t: 10, v: 'b' }], 5), 'a', 'other values hold');
  const shared = [{ t: 0, v: [1, 2], ease: 'linear' }];
  kf.valueAt(shared, 0).push(9);
  eq(shared[0].v, [1, 2], 'a returned array is a copy');
  const list = [{ t: 0, v: 1, ease: 'linear' }, { t: 20, v: 2, ease: 'linear' }];
  const ins = kf.insert(list, { t: 10, v: 5, ease: 'bezier' });
  eq([list.length, ins.map((k) => k.t), ins[1].h.length, kf.insert(ins, { t: 10, v: 6 }).map((k) => k.v)], [2, [0, 10, 20], 4, [1, 6, 2]], 'insert returns a new sorted list and replaces a keyframe at the same time');
  eq([kf.remove(ins, 10).map((k) => k.t), kf.next(ins, 10).t, kf.prev(ins, 10).t, kf.next(ins, 20), kf.prev(ins, 0)], [[0, 20], 20, 0, null, null], 'remove, next, prev');
  const cl = { props: { opacity: 40 }, keyframes: {}, effects: [{ id: 'e1', params: { amount: 3 } }], source: { layers: [{ id: 'l1', size: 50 }] } };
  eq([kf.propValue(cl, 'opacity', 5, 100), kf.propValue(cl, 'effects.e1.amount', 0, 0), kf.propValue(cl, 'effects.e1.other', 0, 8), kf.propValue(cl, 'layers.l1.size', 0, 1)], [40, 3, 8, 50], 'propValue reads static values');
} catch (err) {
  check(false, `keyframes: ${err.stack}`);
}

// ---------- SRT, VTT, encodings ----------
try {
  const MS = SEC / 1000;
  const file = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n첫 줄\r\n둘째 줄\r\n\r\n\r\n  \r\n3\r\n0:00:03.5 --> 0:00:04.25 X1:10 X2:20\r\n<i>기울임</i>\r\n\r\n00:05,000 --> 00:06,000\r\n번호 없음\r\n7\r\n00:00:07,000 --> 00:00:08,001\r\n빈 줄 없이 다음\r\n00:00:09,000 --> 00:00:09,500\r\n번호도 빈 줄도 없이\r\n\r\n100:00:00,000 --> 100:00:01,000\r\n긴 시간\r\n\r\nnot a cue\r\n\r\n';
  const items = srt.parse(file);
  eq(items.map((it) => [it.start / MS, it.end / MS, it.text]), [
    [1000, 2500, '첫 줄\n둘째 줄'], [3500, 4250, '<i>기울임</i>'], [5000, 6000, '번호 없음'], [7000, 8001, '빈 줄 없이 다음'], [9000, 9500, '번호도 빈 줄도 없이'],[360000000, 360001000, '긴 시간'],
  ], 'SRT: BOM, CRLF, extra blank lines, . for ,, one or two fraction digits, no hours, settings, missing number, no blank line between cues, 100 hours, junk');
  const back = srt.parse(srt.write(items));
  eq(back, items, 'SRT write then parse is the same');
  check(srt.write(items).startsWith('1\r\n00:00:01,000 --> 00:00:02,500\r\n첫 줄\r\n둘째 줄\r\n\r\n2\r\n'), 'SRT is written numbered with CRLF');
  eq(srt.write([{ start: SEC / 30, end: SEC, text: 'a\n\nb' }]), '1\r\n00:00:00,033 --> 00:00:01,000\r\na\r\nb\r\n', 'a frame time rounds to the millisecond; a blank line inside a caption collapses');
  eq(srt.parse('1\n00:00:00,000 --> 00:00:01,000\nx\r2\r00:00:01,000 --> 00:00:02,000\ry\r'), [{ start: 0, end: SEC, text: 'x' }, { start: SEC, end: 2 * SEC, text: 'y' }], 'SRT with mixed LF and CR line ends');

  const vtt = 'WEBVTT - 제목\nKind: captions\n\nNOTE 메모\n여러 줄\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.000 align:start\nA &amp; B &lt;3\n\n01:00:00.250 --> 01:00:01.000\n<v Kim>안녕</v>\n';
  const vi = srt.parseVtt(vtt);
  eq(vi.map((it) => [it.start / MS, it.end / MS, it.text]), [[1000, 2000, 'A & B <3'], [3600250, 3601000, '<v Kim>안녕</v>']], 'VTT: header, NOTE, STYLE, cue ids, settings, entities');
  const plain = [{ start: 0, end: 1500 * MS, text: 'Tom & Jerry <3 -->' }, { start: 2 * SEC, end: 3 * SEC, text: '두 줄\n자막' }];
  eq(srt.parseVtt(srt.writeVtt(plain)), plain, 'VTT write then parse is the same, with & < > escaped');
  check(srt.writeVtt(plain).startsWith('WEBVTT\n\n00:00.000 --> 00:01.500\nTom &amp; Jerry &lt;3 --&gt;\n'), 'VTT is written with short times and escapes');
  eq([srt.parseAny(vtt, 'x.srt').length, srt.parseAny(file, 'x.srt').length, srt.isVtt('', 'a.VTT'), srt.isVtt('1 ', 'a.srt')], [2, 6, true, false], 'parseAny picks the parser by content or name');

  // CP949: the KS X 1001 part from the platform's EUC-KR decoder (rows 0xA1-0xFE), the UHC extension syllables (which
  // Node's decoder lacks) from published code points, so the test does not reuse the code under test.
  const dec = new TextDecoder('euc-kr');
  const table = new Map([['갂', [0x81, 0x41]], ['똠', [0x8c, 0x63]], ['뷁', [0x94, 0xee]], ['햏', [0xc1, 0x64]]]);
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const ch = dec.decode(Uint8Array.of(lead, trail));
      if (ch.length === 1 && ch !== '\uFFFD' && !table.has(ch)) table.set(ch, [lead, trail]);
    }
  }
  const cp949 = (text) => Uint8Array.from([...text].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : table.get(ch) || (() => { throw new Error(`no CP949 for ${ch}`); })())));
  const korean = '1\r\n00:00:01,000 --> 00:00:02,000\r\n안녕하세요, 똠방각하! 뷁 갂 햏\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n가나다 ABC 123\r\n';
  const bytes = cp949(korean);
  check(bytes.length < Buffer.byteLength(korean) && (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false; } catch { return true; } })(), 'the CP949 bytes are not UTF-8');
  eq(srt.decode(bytes), korean, 'CP949 bytes (with the UHC-only syllables 똠, 뷁, 갂, 햏) decode');
  eq(srt.parse(srt.decode(bytes)).map((it) => it.text), ['안녕하세요, 똠방각하! 뷁 갂 햏', '가나다 ABC 123'], 'a CP949 SRT parses');
  const utf8 = Buffer.from(korean, 'utf8');
  eq([srt.decode(utf8), srt.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]))], [korean, korean], 'UTF-8 with and without a BOM');
  const le = Buffer.from(korean, 'utf16le');
  const be = Buffer.from(le).swap16();
  eq([srt.decode(Buffer.concat([Buffer.from([0xff, 0xfe]), le])), srt.decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), srt.decode(le), srt.decode(be)], [korean, korean, korean, korean], 'UTF-16 LE and BE, with a BOM and without');
  eq(srt.decode(new Uint8Array([0x41, 0x42])), 'AB', 'a tiny ASCII file');
} catch (err) {
  check(false, `captions files: ${err.stack}`);
}

// ---------- the page loads them as plain scripts ----------
try {
  // As index.js does: no require, no module; each file adds itself to globalThis.Cut, in index.js order.
  const page = { TextDecoder, console, JSON, Math, Number, String, Array, Object, Map, Set, BigInt, Error, RegExp, Uint8Array };
  page.globalThis = page;
  vm.createContext(page);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'features', 'cut');
  const order = readFileSync(path.join(dir, 'index.js'), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  const mine = ['time.js', 'state.js', 'captionwords.js', 'model.js', 'keyframes.js', 'commands.js', 'srt.js'];
  check(mine.every((x) => order.includes(x)) && order.indexOf('captionwords.js') < order.indexOf('model.js') && order.indexOf('model.js') < order.indexOf('keyframes.js') && order.indexOf('keyframes.js') < order.indexOf('commands.js'), 'index.js loads captionwords, model, keyframes, commands and srt after time');
  for (const file of order.filter((x) => mine.includes(x))) vm.runInContext(readFileSync(path.join(dir, file), 'utf8'), page, { filename: file });
  const out = vm.runInContext(`(() => {
    const p = Cut.model.createProject();
    const h = Cut.commands.createHistory(p);
    const [m] = h.do(Cut.commands.importMedia([{ path: 'a.mp4', kind: 'video', duration: 10 * Cut.time.TICKS, video: { w: 8, h: 8 }, audio: null }])).ids;
    h.do(Cut.commands.place('s1', { source: { media: m }, in: 0, out: Cut.time.TICKS, at: 0, video: 'V1' }));
    h.do(Cut.commands.split('s1', Cut.time.TICKS / 2));
    const n = h.project.sequences[0].clips.length;
    h.undo();
    const fl = Cut.time.frameTicks([30, 1]);
    const ct = h.do(Cut.commands.addCaptionTrack('s1', { items: [{ start: 0, end: Cut.time.TICKS, text: 'a b', words: [{ t0: 0, t1: 10 * fl, text: 'a' }, { t0: 10 * fl, t1: 20 * fl, text: 'b' }] }] })).id;
    h.do(Cut.commands.setCaption('s1', ct, h.project.sequences[0].captions[0].items[0].id, { text: 'a c' }));
    const words = h.project.sequences[0].captions[0].items[0].words.map((w) => w.text).join();
    return [n, h.project.sequences[0].clips.length, Cut.keyframes.valueAt([{ t: 0, v: 0 }, { t: 2, v: 4 }], 1), Cut.srt.parse('1\\n00:00:01,000 --> 00:00:02,000\\nx\\n').length, words, Cut.model.validate(h.project).ok];
  })()`, page);
  eq(out, [2, 1, 2, 1, 'a,c', true], 'the modules work as page scripts through globalThis.Cut (caption word timings too)');
} catch (err) {
  check(false, `page scripts: ${err.stack}`);
}

// ---------- edit tools: slip, slide, rate stretch, extend edit, groups, nudge ----------
try {
  const { h, s, a, b, pic } = setup();
  // a: 600 whole frames with sound. v/au: [30,120) showing source 100..190.
  const [v, au] = place(h, s, { source: { media: a }, in: f(100), out: f(190), at: f(30), video: 'V1', audio: 'A1' });
  let r = step(h, C.slip(s, v, { delta: f(10) }), 'slip');
  eq([r, lay(h, s).V1, lay(h, s).A1], [{ applied: f(10), clamped: null }, '30-120:110', '30-120:110'], 'slip moves in and out of the clip and its linked audio, place and length kept');
  eq(h.list().at(-1).label, 'Slip', 'slip label');
  h.undo();
  r = h.do(C.slip(s, v, { delta: -f(150) }));
  eq([r, lay(h, s).V1, lay(h, s).A1], [{ applied: -f(100), clamped: 'source' }, '30-120:0', '30-120:0'], 'slip stops at the source start');
  h.undo();
  r = h.do(C.slip(s, v, { delta: f(1000) }));
  eq([r, clip(h, s, v).out / F], [{ applied: f(410), clamped: 'source' }, 600], 'slip stops at the last whole frame of the source');
  h.undo();
  r = h.do(C.slip(s, v, { delta: f(10) + 5000 }));
  eq([r.applied, clip(h, s, v).in % F, lay(h, s).V1], [f(10), 0, '30-120:110'], 'a slip delta goes to whole frames');
  h.undo();
  h.do(C.slip(s, v, { delta: f(5), linked: false }));
  eq([lay(h, s).V1, lay(h, s).A1], ['30-120:105', '30-120:100'], 'slip with linked: false moves one side');
  h.undo();
  h.do(C.setKeyframes(s, v, 'opacity', [{ t: f(10), v: 0 }, { t: f(40), v: 100 }]));
  h.do(C.slip(s, v, { delta: f(20) }));
  eq(clip(h, s, v).keyframes.opacity.map((k) => fr(k.t)), [10, 40], 'keyframes stay on the clip frames through a slip');
  h.undo();
  h.undo();
  h.do(C.setTrack(s, 'A1', { locked: true }));
  unchanged(h, () => h.do(C.slip(s, v, { delta: f(5) })), 'locked', 'slip with the linked audio on a locked track');
  h.do(C.setTrack(s, 'A1', { locked: false }));
  const [still] = place(h, s, { source: { media: pic }, at: f(300), video: 'V2' });
  unchanged(h, () => h.do(C.slip(s, still, { delta: f(5) })), 'still', 'a still has no source to slip');
  h.undo();
  h.do(C.setClip(s, v, { speed: 2, ripple: true }));
  eq(lay(h, s).V1, '30-75:100', 'speed 2 clip');
  h.do(C.slip(s, v, { delta: f(10) }));
  eq([clip(h, s, v).in / F, clip(h, s, v).out / F, lay(h, s).V1], [120, 210, '30-75:120'], 'at speed 2 a slip of 10 frames shows source 20 frames later');
  h.undo();
  h.undo();

  // slide: x [0,60):0, y [60,120):100, z [120,180):300 on V2, nothing else there
  const [x] = place(h, s, { source: { media: a }, in: 0, out: f(60), at: f(400), video: 'V2' });
  const [y] = place(h, s, { source: { media: a }, in: f(100), out: f(160), at: f(460), video: 'V2' });
  const [z] = place(h, s, { source: { media: a }, in: f(300), out: f(360), at: f(520), video: 'V2' });
  h.do(C.addTransition(s, { track: 'V2', at: f(460), type: 'dissolve', duration: f(10) }));
  r = step(h, C.slide(s, y, { delta: f(10) }), 'slide right');
  eq([r, lay(h, s).V2], [{ applied: f(10), clamped: null }, '400-470:0 470-530:100 530-580:310'], 'slide: the clip moves with its content, the neighbours trim their touching ends, the length stays');
  eq(h.project.sequences[0].transitions.map((t) => fr(t.at)), [470], 'the transition on the edit point slides with it');
  eq(h.list().at(-1).label, 'Slide', 'slide label');
  h.undo();
  h.do(C.slide(s, y, { delta: -f(10) }));
  eq(lay(h, s).V2, '400-450:0 450-510:100 510-580:290', 'slide left');
  h.undo();
  r = h.do(C.slide(s, y, { delta: -f(100) }));
  eq([r, lay(h, s).V2], [{ applied: -f(59), clamped: 'length' }, '400-401:0 401-461:100 461-580:241'], 'slide stops with the clip before at one frame');
  h.undo();
  place(h, s, { source: { media: b }, in: 0, out: f(60), at: f(580), video: 'V2' });
  const before = h.serialize();
  r = h.do(C.slide(s, z, { delta: -f(10) }));
  eq([r, h.serialize() === before], [{ applied: 0, clamped: 'source' }, true], 'a slide left stops when the clip after has no head left (b starts at 0)');
  r = h.do(C.slide(s, z, { delta: f(10) }));
  eq([r.applied, lay(h, s).V2], [f(10), '400-460:0 460-530:100 530-590:300 590-640:10'], 'the same clip slides right, trimming the head of the one after');
  h.undo();
  h.do(C.move(s, [x], { delta: -f(20) }));
  r = h.do(C.slide(s, y, { delta: -f(500) }));
  eq([r, lay(h, s).V2], [{ applied: -f(20), clamped: 'neighbour' }, '380-440:0 440-500:100 500-580:280 580-640:0'], 'with a gap before it the clip slides into the gap and stops at the clip beyond');
  h.undo();
  h.undo();
  h.do(C.setTrack(s, 'V2', { locked: true }));
  unchanged(h, () => h.do(C.slide(s, y, { delta: f(5) })), 'locked', 'slide on a locked track');
  h.do(C.setTrack(s, 'V2', { locked: false }));
  // linked: the audio of three linked pairs slides with the video
  {
    const L = setup();
    for (const [inF, atF] of [[0, 0], [100, 60], [300, 120]]) place(L.h, L.s, { source: { media: L.a }, in: f(inF), out: f(inF + 60), at: f(atF), video: 'V1', audio: 'A1' });
    const mid = clipsOf(L.h, L.s).find((c) => c.track === 'V1' && c.start === f(60)).id;
    step(L.h, C.slide(L.s, mid, { delta: f(5) }), 'linked slide');
    eq([lay(L.h, L.s).V1, lay(L.h, L.s).A1], ['0-65:0 65-125:100 125-180:305', '0-65:0 65-125:100 125-180:305'], 'a linked slide moves the audio and trims its neighbours too');
  }

  // rate stretch: v [30,120) source 100..190, n on V1 at 150
  const [n] = place(h, s, { source: { media: b }, in: 0, out: f(60), at: f(150), video: 'V1' });
  r = step(h, C.stretch(s, v, { edge: 'end', delta: f(30) }), 'rate stretch the end');
  eq([r.applied, r.clamped, Math.round(r.speed * 1000) / 1000, lay(h, s).V1, lay(h, s).A1], [f(30), null, 0.75, '30-150:100 150-210:0', '30-150:100'], 'rate stretch: 90 frames of source over 120, speed 75%, the linked audio too');
  eq([clip(h, s, v).in / F, clip(h, s, v).out / F, clip(h, s, au).speed === clip(h, s, v).speed], [100, 190, true], 'the source range is kept');
  eq(h.list().at(-1).label, 'Rate Stretch', 'rate stretch label');
  h.undo();
  r = h.do(C.stretch(s, v, { edge: 'end', delta: f(50) }));
  eq([r.applied, r.clamped, lay(h, s).V1], [f(30), 'neighbour', '30-150:100 150-210:0'], 'rate stretch stops at the next clip');
  h.undo();
  r = h.do(C.stretch(s, v, { edge: 'start', delta: f(45) + 999 }));
  eq([r.applied, r.speed, lay(h, s).V1], [f(45), 2, '75-120:100 150-210:0'], 'rate stretch of the start: the end stays, speed 200%, a whole-frame delta');
  h.undo();
  r = h.do(C.stretch(s, v, { edge: 'start', delta: -f(100) }));
  eq([r.applied, r.clamped, lay(h, s).V1], [-f(30), 'neighbour', '0-120:100 150-210:0'], 'rate stretch of the start stops at 0');
  h.undo();
  h.do(C.setKeyframes(s, v, 'opacity', [{ t: f(30), v: 50 }]));
  h.do(C.stretch(s, v, { edge: 'end', delta: f(30) }));
  eq(clip(h, s, v).keyframes.opacity.map((k) => fr(k.t)), [40], 'keyframes stay on their source frames');
  h.undo();
  h.undo();
  {
    const L = setup();
    const [long] = place(L.h, L.s, { source: { media: L.a }, in: 0, out: f(300), at: 0, video: 'V1', audio: null });
    r = L.h.do(C.stretch(L.s, long, { edge: 'end', delta: -f(299) }));
    eq([r.applied, r.clamped, lay(L.h, L.s).V1, r.speed], [-f(297), 'speed', '0-3:0', 100], 'rate stretch stops at 10000%');
    const [ph] = place(L.h, L.s, { source: { media: L.pic }, at: f(100), video: 'V2' });
    L.h.do(C.stretch(L.s, ph, { edge: 'end', delta: f(10) }));
    eq([lay(L.h, L.s).V2, clip(L.h, L.s, ph).speed], ['100-260:0', 1], 'a still is trimmed, its speed stays');
  }
  h.do(C.setTrack(s, 'A1', { locked: true }));
  unchanged(h, () => h.do(C.stretch(s, v, { edge: 'end', delta: f(5) })), 'locked', 'rate stretch with the linked audio locked');
  h.do(C.setTrack(s, 'A1', { locked: false }));
  h.do(C.remove(s, [n]));

  // extend edit: p [0,60):0 and q [60,120):100 linked with audio, touching
  {
    const E = setup();
    const [p, pa] = place(E.h, E.s, { source: { media: E.a }, in: 0, out: f(60), at: 0, video: 'V1', audio: 'A1' });
    const [q] = place(E.h, E.s, { source: { media: E.a }, in: f(100), out: f(160), at: f(60), video: 'V1', audio: 'A1' });
    r = step(E.h, C.extendEdit(E.s, f(70), { trackIds: ['V1', 'A1'] }), 'extend edit');
    eq([r, lay(E.h, E.s).V1, lay(E.h, E.s).A1], [{ at: f(60), applied: f(10), clamped: null }, '0-70:0 70-120:110', '0-70:0 70-120:110'], 'extend edit rolls the nearest edit point to the playhead on the targeted tracks');
    eq(E.h.list().at(-1).label, 'Extend Edit', 'extend edit label');
    E.h.undo();
    r = E.h.do(C.extendEdit(E.s, f(100), { clipIds: [q] }));
    eq([r.at, lay(E.h, E.s).V1, lay(E.h, E.s).A1], [f(120), '0-60:0 60-100:100', '0-60:0 60-100:100'], 'extend edit of a selected clip moves its nearest edge; with nothing after it, a trim');
    E.h.undo();
    r = E.h.do(C.extendEdit(E.s, f(130) + 77, { clipIds: [q] }));
    eq([r.applied, lay(E.h, E.s).V1], [f(10), '0-60:0 60-130:100'], 'extend edit to a playhead off the frame grid lands on its frame');
    E.h.undo();
    r = E.h.do(C.extendEdit(E.s, f(70), { trackIds: ['V1'], linked: false }));
    eq([lay(E.h, E.s).V1, lay(E.h, E.s).A1], ['0-70:0 70-120:110', '0-60:0 60-120:100'], 'extend edit with linked: false leaves the audio');
    E.h.undo();
    E.h.do(C.setTrack(E.s, 'A1', { locked: true }));
    unchanged(E.h, () => E.h.do(C.extendEdit(E.s, f(70), { trackIds: ['V1'] })), 'locked', 'extend edit when the linked audio is locked');
    E.h.do(C.setTrack(E.s, 'A1', { locked: false }));
    void p; void pa;
    const empty = setup();
    unchanged(empty.h, () => empty.h.do(C.extendEdit(empty.s, f(10))), 'noEdit', 'extend edit with no edit point');
  }

  // groups: v (+ au) on V1/A1 at 30, g2 on V2 at 300
  groups(setup());
} catch (err) {
  check(false, `edit tools: ${err.stack}`);
}
function groups({ h, s, a, b }) {
  const [v, au] = place(h, s, { source: { media: a }, in: f(100), out: f(190), at: f(30), video: 'V1', audio: 'A1' });
  const [g2] = place(h, s, { source: { media: b }, in: 0, out: f(30), at: f(300), video: 'V2' });
  let r;
  r = step(h, C.group(s, [v, g2]), 'group');
  check(/^G\d+$/.test(r.group) && clip(h, s, v).group === r.group && clip(h, s, g2).group === r.group && clip(h, s, au).group === null, `group gives the clips one group id (${r.group})`);
  check(model.validate(h.project).ok, 'a grouped project validates');
  step(h, C.move(s, [g2], { delta: f(10), nudge: true }), 'move a group member');
  eq([lay(h, s).V1, lay(h, s).A1, lay(h, s).V2], ['40-130:100', '40-130:100', '310-340:0'], 'moving one member moves the group and the members\' linked clips');
  eq(h.list().at(-1).label, 'Nudge', 'a nudge is labelled Nudge');
  h.undo();
  h.do(C.move(s, [g2], { delta: f(10), linked: false }));
  eq([lay(h, s).V1, lay(h, s).V2], ['30-120:100', '310-340:0'], 'linked: false (Alt) moves one member');
  h.undo();
  h.do(C.split(s, f(310), { clipIds: [g2] }));
  eq([lay(h, s).V1, lay(h, s).V2], ['30-120:100', '300-310:0 310-330:10'], 'a split of a member cuts only that clip');
  h.undo();
  h.do(C.trim(s, g2, { edge: 'end', delta: -f(10) }));
  eq([lay(h, s).V1, lay(h, s).V2], ['30-120:100', '300-320:0'], 'a trim of a member trims only that clip');
  h.undo();
  step(h, C.remove(s, [g2]), 'remove a group member');
  eq([lay(h, s).V1, lay(h, s).A1, lay(h, s).V2], ['', '', ''], 'removing one member removes the group');
  h.undo();
  h.do(C.setTrack(s, 'V1', { locked: true }));
  unchanged(h, () => h.do(C.move(s, [g2], { delta: f(10) })), 'locked', 'a group with a member on a locked track does not move');
  h.do(C.setTrack(s, 'V1', { locked: false }));
  const dup = h.do(C.addSequence({ from: s })).id;
  const dg = clipsOf(h, dup).filter((c) => c.group);
  check(dg.length === 2 && dg[0].group === dg[1].group && dg[0].group !== r.group, 'a duplicated sequence has its own group');
  h.undo();
  const pasted = h.do(C.paste(s, [v, g2].map((id) => ({ ...model.clone(clip(h, s, id)), kind: 'video' })), { at: f(500) })).ids;
  const pg = pasted.map((id) => clip(h, s, id).group);
  check(pg[0] && pg[0] === pg[1] && pg[0] !== clip(h, s, v).group, 'pasted members form a new group');
  h.undo();
  h.do(C.remove(s, [g2], { linked: false }));
  eq(clip(h, s, v).group, null, 'a group left with one clip is cleared');
  h.undo();
  step(h, C.ungroup(s, [g2]), 'ungroup');
  eq([clip(h, s, v).group, clip(h, s, g2).group], [null, null], 'ungroup clears every member');
  h.undo();
  unchanged(h, () => h.do(C.group(s, [v])), 'groupOne', 'a group of one clip');
  eq(model.migrate(h.serialize()).sequences[0].clips.find((c) => c.id === v).group, r.group, 'the group survives save and migrate');
}

// ---------- automation: clip roles, batches, beat markers ----------
try {
  const { h, s, a, music } = setup();
  const [v, au] = place(h, s, { source: { media: a }, in: 0, out: f(300), at: 0, video: 'V1', audio: 'A1' });
  const [m] = place(h, s, { source: { media: music }, in: 0, out: f(600), at: 0, audio: 'A2' });
  eq([clip(h, s, v).role, clip(h, s, m).role], [null, null], 'a new clip has no role');
  step(h, C.setRole(s, [v], 'dialogue'), 'set a role');
  eq([clip(h, s, v).role, clip(h, s, au).role, clip(h, s, m).role], ['dialogue', 'dialogue', null], 'setRole sets the linked audio too');
  h.do(C.setRole(s, [m], 'music', { linked: false }));
  eq(h.list().at(-1).label, 'Audio Role', 'setRole label');
  unchanged(h, () => h.do(C.setRole(s, [m], 'narration')), undefined, 'an unknown role');
  step(h, C.setClip(s, m, { role: 'ambience' }), 'setClip with a role');
  h.undo();
  unchanged(h, () => h.do(C.setClip(s, m, { role: 'speech' })), undefined, 'setClip with an unknown role');
  h.do(C.setTrack(s, 'A2', { locked: true }));
  unchanged(h, () => h.do(C.setRole(s, [m], null)), 'locked', 'setRole on a locked track');
  h.do(C.setTrack(s, 'A2', { locked: false }));
  const bad = model.clone(h.project);
  bad.sequences[0].clips[0].role = 'narration';
  check(!model.validate(bad).ok, 'validate refuses an unknown role');
  const mig = model.clone(h.project);
  delete mig.sequences[0].clips[0].role;
  mig.sequences[0].clips[1].role = 'narration';
  const mp = model.migrate(mig);
  eq([mp.sequences[0].clips[0].role, mp.sequences[0].clips[1].role, model.validate(mp).ok], [null, null, true], 'migrate fills a missing role and drops an unknown one');
  step(h, C.setKeyframes(s, m, 'duck', [{ t: 0, v: 0 }, { t: f(30), v: -12 }]), 'an audio clip takes duck keyframes');
  unchanged(h, () => h.do(C.setKeyframes(s, v, 'duck', [{ t: 0, v: -12 }])), undefined, 'a video clip has no duck curve');
  const pasted = h.do(C.paste(s, [{ ...model.clone(clip(h, s, m)), kind: 'audio' }], { at: f(600), audio: 'A2' })).ids;
  eq(clip(h, s, pasted[0]).role, 'music', 'paste keeps the role');
  h.undo();
  check(model.MARKER_KINDS.includes('beat') && model.ROLES.join() === 'dialogue,music,effects,ambience', 'beat markers and the four roles are in the model');

  // a batch is one undo step; a failing part takes back the others
  const steps = h.list().filter((x) => x.done).length;
  const before = h.serialize();
  const r = step(h, C.batch('Remove Silence', [C.extract(s, f(200), f(250), ['V1', 'A1']), C.extract(s, f(50), f(100), ['V1', 'A1'])]), 'a batch of extracts');
  eq(lay(h, s), { V1: '0-50:0 50-150:100 150-200:250', V2: '', A1: '0-50:0 50-150:100 150-200:250', A2: '0-50:0 50-150:100 150-500:250' }, 'two ranges removed from the end first: linked and sync-locked tracks follow');
  eq([h.list().filter((x) => x.done).length, h.list().at(-1).label, r.results.map((x) => x.range.map(fr))], [steps + 1, 'Remove Silence', [[200, 250], [50, 100]]], 'the batch is one step with its label and each result');
  h.undo();
  check(h.serialize() === before, 'one undo takes the whole batch back');
  h.do(C.setTrack(s, 'A2', { locked: true }));
  h.do(C.batch('Remove Silence', [C.extract(s, f(50), f(100), ['V1', 'A1'])]));
  eq([lay(h, s).V1, lay(h, s).A2], ['0-50:0 50-250:100', '0-600:0'], 'a locked track keeps its clips through the batch');
  h.undo();
  h.do(C.setTrack(s, 'A2', { locked: false }));
  unchanged(h, () => h.do(C.batch('Edit', [C.addMarker(s, { t: f(10), kind: 'beat' }), C.addMarker(s, { t: f(20), kind: 'nope' })])), undefined, 'a batch whose second part fails');
  unchanged(h, () => h.do(C.batch('Edit', [C.batch('Edit', [])])), undefined, 'a batch inside a batch');
  const beats = h.do(C.batch('Add Beat Markers', [10, 25, 40].map((n) => C.addMarker(s, { t: f(n), kind: 'beat', color: 'cyan' }))));
  eq([h.project.sequences[0].markers.map((x) => [fr(x.t), x.kind]), beats.results.length], [[[10, 'beat'], [25, 'beat'], [40, 'beat']], 3], 'beat markers in one step');
  h.undo();
  // a split at several scene cuts, from the last one back, keeps the first part's id
  const sp = h.do(C.batch('Split at Scene Changes', [f(200), f(100)].map((t) => C.split(s, t, { clipIds: [v] }))));
  eq([lay(h, s).V1, lay(h, s).A1, clip(h, s, v).start], ['0-100:0 100-200:100 200-300:200', '0-100:0 100-200:100 200-300:200', 0], 'splits at the scene cuts take the linked audio along');
  eq(sp.results.map((x) => x.ids.length), [2, 2], 'each split made a video and an audio piece');
} catch (err) {
  check(false, `automation: ${err.stack}`);
}

// ---------- panels: history jumps, keyframe interpolation, markers ----------
try {
  const { h, s, a } = setup();
  const start = h.serialize();
  const [v] = place(h, s, { source: { media: a }, in: 0, out: f(90), at: 0, video: 'V1' });
  const states = [start, h.serialize()];
  for (const o of [80, 60, 40]) { h.do(C.setClip(s, v, { props: { opacity: o } })); states.push(h.serialize()); }
  const reasons = [];
  h.onChange((r) => reasons.push(r));
  eq([h.position, h.list().length], [5, 5], 'position counts the steps done');
  // states[i] is the project after i + 1 steps (the import is the first)
  check(h.goTo(2) && h.serialize() === states[1] && h.position === 2, 'goTo(2) undoes three steps at once to the state after the second');
  eq([reasons, h.list().map((x) => x.done)], [['undo'], [true, true, false, false, false]], 'one change event for the jump; the later steps can be redone');
  check(h.goTo(5) && h.serialize() === states[4], 'goTo forward redoes them all');
  check(h.goTo(0) && !h.canUndo && h.project.media.length === 0, 'goTo(0) is the start');
  eq([h.goTo(0), h.goTo(-3), h.position], [false, false, 0], 'goTo the current point (or before the start) does nothing');
  h.goTo(99);
  eq([h.position, h.serialize() === states[4]], [5, true], 'goTo past the end stops at the last step');
  h.goTo(3);
  h.do(C.setClip(s, v, { name: 'new' }));
  eq([h.list().length, h.canRedo], [4, false], 'an edit after a jump back drops the steps after it');
  h.begin('Drag');
  h.do(C.setClip(s, v, { props: { opacity: 10 } }));
  check(h.goTo(1) && !h.grouping && h.list().length === 5 && h.list()[4].label === 'Drag', 'goTo during a drag first commits the drag as a step');
  reasons.length = 0;
  h.goTo(5);
  h.begin('Drag');
  h.do(C.setClip(s, v, { props: { opacity: 20 } }));
  h.commit();
  eq(reasons, ['redo', 'do', 'commit'], 'a committed group tells the listeners the list changed');

  // interpolation: hold keeps the value to the next keyframe; bezier through the command keeps its handles
  h.do(C.setKeyframes(s, v, 'opacity', [{ t: 0, v: 0, ease: 'hold' }, { t: f(30), v: 100, ease: 'linear' }, { t: f(60), v: 50 }]));
  const ck = () => clip(h, s, v);
  eq([0, 15, 29, 30, 45].map((n) => kf.propValue(ck(), 'opacity', f(n), 0)), [0, 0, 0, 100, 75], 'a hold keyframe keeps its value until the next one');
  for (const ease of ['linear', 'easeIn', 'easeOut', 'easeInOut']) {
    const before = [0.2, 0.5, 0.8].map((u) => kf.valueAt([{ t: 0, v: 0, ease }, { t: 1000, v: 100 }], u * 1000));
    const after = [0.2, 0.5, 0.8].map((u) => kf.valueAt([{ t: 0, v: 0, ease: 'bezier', h: kf.handles(ease) }, { t: 1000, v: 100 }], u * 1000));
    check(before.every((x, i) => Math.abs(x - after[i]) < 0.05), `${ease} turned into bezier with handles(${ease}) keeps its values (${S(before.map((x) => +x.toFixed(2)))} vs ${S(after.map((x) => +x.toFixed(2)))})`);
  }
  eq([kf.handles('hold'), kf.handles({ ease: 'bezier', h: [0.1, 0.9, 0.2, 1.3] }), kf.handles({ ease: 'bezier' })], [null, [0.1, 0.9, 0.2, 1.3], kf.DEFAULT_HANDLES], 'handles of hold, of a bezier keyframe and of one without handles');
  const n0 = h.list().length;
  h.do(C.setKeyframes(s, v, 'opacity', ck().keyframes.opacity.map((k, i) => (i === 1 ? { ...k, ease: 'bezier', h: [0.3, 1.4, 0.6, 1] } : k))));
  eq([ck().keyframes.opacity[1], h.list().length - n0], [{ t: f(30), v: 100, ease: 'bezier', h: [0.3, 1.4, 0.6, 1] }, 1], 'a bezier keyframe with handles that overshoot is one step');
  const lowest = Math.min(...[36, 40, 44, 48, 52, 56].map((n) => kf.propValue(ck(), 'opacity', f(n), 0)));
  check(lowest < 50, `the overshooting handle takes the value past the next keyframe's 50 (${lowest.toFixed(1)})`);
  unchanged(h, () => h.do(C.setKeyframes(s, v, 'opacity', [{ t: 0, v: 0, ease: 'bezier' }])), undefined, 'a bezier keyframe without handles');

  // markers: clip markers of an older file get their fields; range markers keep a frame-aligned duration
  const old = JSON.parse(h.serialize());
  old.sequences[0].clips[0].markers = [{ id: 'mk900', t: f(3) + 7 }];
  old.sequences[0].markers = [{ id: 'mk901', t: f(5), duration: f(10) + 5 }];
  const mg = model.migrate(old);
  eq([mg.sequences[0].clips[0].markers[0], mg.sequences[0].markers[0].duration, model.validate(mg).ok], [{ id: 'mk900', t: f(3), duration: 0, name: '', note: '', kind: 'comment', color: 'green' }, f(10), true], 'migrate fills clip markers and snaps range markers');
} catch (err) {
  check(false, `panels: ${err.stack}`);
}

// ---------- 2,000 random commands ----------
try {
  let seed = 20261105;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(rnd() * n);
  const pick = (list) => list[int(list.length)];
  const T = () => (rnd() < 0.85 ? f(int(400)) : int(400 * F));
  const D = () => (rnd() < 0.85 ? f(int(121) - 60) : int(120 * F) - 60 * F);

  const first = setup();
  const { s, a, music, pic, b } = first;
  // Unlimited steps, so undoing all of them reaches the start.
  const h = C.createHistory(first.h.project, { limit: Infinity });
  let changes = 0;
  h.onChange((reason) => { if (reason === 'do') changes++; });
  h.do(C.addSequence({ fps: [24000, 1001], name: 'film' }));
  // a random start: a few clips on each track
  for (let i = 0; i < 12; i++) {
    try { h.do(C.place(s, { source: { media: pick([a, music, pic, b]) }, in: f(int(100)), out: f(100 + int(200)), at: T(), video: pick(['V1', 'V2']), audio: pick(['A1', 'A2']), mode: pick(['insert', 'overwrite']) })); } catch {}
  }
  h.do(C.addCaptionTrack(s, { items: [{ start: f(10), end: f(40), text: 'a' }, { start: f(100), end: f(130), text: 'b' }] }));
  const hash = () => crypto.createHash('sha1').update(h.serialize()).digest('hex');
  const start = hash();
  const states = [start];
  const kinds = {};
  let failed = 0;
  let rollbackBad = 0;
  let invalid = 0;
  let exactBad = 0;
  const randomCommand = () => {
    const sid = rnd() < 0.85 ? s : pick(h.project.sequences).id;
    const seq = h.project.sequences.find((x) => x.id === sid);
    if (!seq) return C.addSequence({});
    const cl = seq.clips.length ? pick(seq.clips) : null;
    const tracks = seq.tracks.map((t) => t.id);
    const vt = seq.tracks.filter((t) => t.kind === 'video').map((t) => t.id);
    const at = seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.id);
    const some = () => seq.clips.filter(() => rnd() < 0.2).map((x) => x.id).concat(cl ? [cl.id] : []);
    const many = seq.clips.length > 40;
    const r = rnd() * (many ? 0.8 : 1);
    if (rnd() < 0.04) {
      const texts = seq.clips.filter((x) => x.source.generator === 'text');
      const solids = seq.clips.filter((x) => x.source.generator === 'solid');
      const tx2 = texts.length ? pick(texts) : null;
      const layer = tx2?.source.layers.length ? pick(tx2.source.layers).id : 'l1';
      return pick([
        cl ? C.paste(sid, seq.clips.filter(() => rnd() < 0.15).concat([cl]).map((x) => ({ ...model.clone(x), kind: seq.tracks.find((t) => t.id === x.track).kind })), { at: T(), mode: pick(['insert', 'overwrite']), video: rnd() < 0.5 ? pick(vt) : null }) : C.addBin('p'),
        tx2 ? C.setLayer(sid, tx2.id, layer, { text: `t${int(9)}`, size: 10 + int(100) }) : C.setSettings({ fit: pick(['fit', 'fill', 'original']) }),
        tx2 ? C.addLayer(sid, tx2.id, { text: 'n' }, int(3)) : C.setSettings({ transitionDuration: f(1 + int(40)) }),
        tx2 ? C.removeLayer(sid, tx2.id, layer) : C.setProxy(pick(h.project.media).id, rnd() < 0.5 ? null : { path: `cache:p${int(9)}` }),
        tx2 && rnd() < 0.5 ? C.setGenerator(sid, tx2.id, { layers: [{ text: 'x' }] }) : solids.length ? C.setGenerator(sid, pick(solids).id, { color: '#00ff00' }) : C.setProxy(a, { path: 'cache:a' }),
        cl ? C.setClip(sid, cl.id, { duration: f(1 + int(200)), ripple: rnd() < 0.5 }) : C.addBin('d'),
        cl ? C.setRole(sid, some(), pick([null, ...model.ROLES]), { linked: rnd() < 0.7 }) : C.addBin('r'),
        C.batch('Edit', [0, 1, 2].slice(0, 1 + int(3)).map(() => (rnd() < 0.5 ? C.extract(sid, T(), T() + f(1 + int(30)), null) : C.addMarker(sid, { t: T(), kind: 'beat' })))),
      ]);
    }
    if (rnd() < 0.06 && cl) {
      return pick([
        C.slip(sid, cl.id, { delta: D(), linked: rnd() < 0.8 }),
        C.slide(sid, cl.id, { delta: D(), linked: rnd() < 0.8 }),
        C.stretch(sid, cl.id, { edge: pick(['start', 'end']), delta: D(), linked: rnd() < 0.8 }),
        C.extendEdit(sid, T(), rnd() < 0.5 ? { clipIds: some() } : { trackIds: rnd() < 0.5 ? null : [pick(tracks)], linked: rnd() < 0.8 }),
        C.group(sid, some()),
        C.ungroup(sid, some()),
      ]);
    }
    if (r < 0.1) return C.place(sid, { source: rnd() < 0.85 ? { media: pick([a, a, music, pic, b]) } : { generator: pick(['text', 'solid', 'adjustment']) }, in: T() / 4, out: T(), at: T(), video: rnd() < 0.8 ? pick(vt) : null, audio: rnd() < 0.8 ? pick(at) : null, mode: pick(['insert', 'overwrite']) });
    if (r < 0.13) return C.placeRange(sid, { source: { media: pick([a, b, music]) }, in: rnd() < 0.7 ? f(int(100)) : undefined, out: rnd() < 0.5 ? f(100 + int(100)) : undefined, range: { in: rnd() < 0.8 ? T() : undefined, out: rnd() < 0.5 ? T() + f(30) : undefined }, video: pick(vt), audio: pick(at), mode: pick(['insert', 'overwrite']) });
    if (r < 0.22 && cl) return C.move(sid, some(), { delta: D(), trackDelta: pick([0, 0, 0, 1, -1, { video: 1, audio: 0 }]), insert: rnd() < 0.3, linked: rnd() < 0.8 });
    if (r < 0.36 && cl) return C.trim(sid, cl.id, { edge: pick(['start', 'end']), mode: pick(['normal', 'ripple', 'roll']), delta: D(), linked: rnd() < 0.85 });
    if (r < 0.42) return C.split(sid, T(), pick([{}, { allTracks: true }, { trackIds: [pick(tracks)] }, { clipIds: cl ? [cl.id] : [], linked: rnd() < 0.5 }]));
    if (r < 0.47 && cl) return C.remove(sid, some(), { ripple: rnd() < 0.5, linked: rnd() < 0.8 });
    if (r < 0.51) return C.rippleToPlayhead(sid, T(), pick(['before', 'after']), rnd() < 0.5 ? {} : { trackIds: [pick(tracks)] });
    if (r < 0.53) return C.closeGap(sid, pick(tracks), T());
    if (r < 0.56) {
      const t = T();
      return (rnd() < 0.5 ? C.lift : C.extract)(sid, t, t + f(1 + int(60)), rnd() < 0.5 ? null : [pick(tracks)]);
    }
    if (r < 0.62 && cl) {
      const audio = seq.tracks.find((t) => t.id === cl.track).kind === 'audio';
      return C.setClip(sid, cl.id, pick([
        { props: audio ? { volume: -int(20) } : { opacity: int(101), position: [int(100), int(100)] } },
        { speed: pick([0.25, 0.5, 1, 1.5, 2, 3]), ripple: rnd() < 0.5 },
        { reverse: rnd() < 0.5 }, { enabled: rnd() < 0.5 }, { fadeIn: D(), fadeOut: D() }, { name: `n${int(9)}`, label: pick([null, 'red']) },
      ]), { linked: rnd() < 0.8 });
    }
    if (r < 0.66 && cl) {
      const audio = seq.tracks.find((t) => t.id === cl.track).kind === 'audio';
      const prop = audio ? pick(['volume', 'pan']) : pick(['opacity', 'position', 'scale', ...cl.effects.map((e) => `effects.${e.id}.amount`)]);
      const v = () => (prop === 'position' || prop === 'scale' ? [int(100), int(100)] : int(100));
      return C.setKeyframes(sid, cl.id, prop, rnd() < 0.2 ? null : [...Array(1 + int(3))].map(() => ({ t: D() + f(60), v: v(), ease: pick(model.EASES), h: [rnd(), rnd() * 2 - 0.5, rnd(), rnd()] })));
    }
    if (r < 0.68 && cl) return rnd() < 0.5 ? C.link(sid, some()) : C.unlink(sid, some());
    if (r < 0.72 && cl) {
      const withFx = seq.clips.filter((x) => x.effects.length);
      if (!withFx.length || rnd() < 0.4) return C.addEffect(sid, cl.id, pick(['blur.gaussian', 'color.basic', 'vignette']), rnd() < 0.5 ? 0 : null);
      const x = pick(withFx);
      const e = pick(x.effects).id;
      return pick([C.removeEffect(sid, x.id, e), C.setEffect(sid, x.id, e, { on: rnd() < 0.5, params: { amount: rnd() < 0.3 ? null : int(10) } }), C.moveEffect(sid, x.id, e, int(3))]);
    }
    if (r < 0.77) {
      const t = seq.transitions.length ? pick(seq.transitions).id : 'none';
      if (rnd() < 0.6 && cl) return C.addTransition(sid, { track: cl.track, at: rnd() < 0.5 ? cl.start : model.clipEnd(cl), type: 'dissolve', duration: rnd() < 0.5 ? undefined : D(), align: pick(model.ALIGNS) });
      return rnd() < 0.5 ? C.removeTransition(sid, t) : C.setTransition(sid, t, { duration: D(), align: pick(model.ALIGNS) });
    }
    if (r < 0.79) return C.addGenerated(sid, { track: pick(vt), at: T(), duration: rnd() < 0.5 ? undefined : D() + f(61), source: { generator: 'text', layers: [{ text: '자막' }] }, mode: pick(['insert', 'overwrite']) });
    if (r < 0.81 && cl) return C.freezeFrame(sid, cl.id, cl.start + int(Math.max(1, model.clipDuration(cl) / F)) * F, rnd() < 0.5 ? null : f(1 + int(60)));
    if (r < 0.85) {
      const m = seq.markers.length ? pick(seq.markers).id : 'x';
      return pick([C.addMarker(sid, { t: T(), kind: pick(model.MARKER_KINDS), duration: rnd() < 0.3 ? f(int(30)) : 0 }, rnd() < 0.3 && cl ? { clipId: cl.id } : {}), C.setMarker(sid, m, { t: T(), name: 'm' }), C.removeMarker(sid, m)]);
    }
    if (r < 0.9) {
      const ct = seq.captions.length ? pick(seq.captions) : null;
      if (!ct || rnd() < 0.05) return C.addCaptionTrack(sid, { syncLock: rnd() < 0.8 });
      if (seq.captions.length > 1 && rnd() < 0.1) return C.removeCaptionTrack(sid, ct.id);
      const it = ct.items.length ? pick(ct.items).id : 'x';
      return pick([
        C.addCaption(sid, ct.id, { start: T(), end: T() + f(1 + int(60)), text: 't' }), C.setCaption(sid, ct.id, it, { start: T(), end: T() + f(30) }), C.removeCaption(sid, ct.id, it),
        C.addCaption(sid, ct.id, { start: T(), end: T() + f(40), text: 'a b\nc', words: [{ t0: 0, t1: f(10), text: 'a' }, { t0: f(12), t1: f(20), text: 'b' }, { t0: f(25), t1: f(35), text: 'c' }] }),
        C.setCaption(sid, ct.id, it, pick([{ text: pick(['a x c', 'a b c d', 'z', 'A, b']) }, { start: T() }, { end: T() + f(5) }])),
        C.setCaptions(sid, ct.id, [...Array(int(4))].map(() => ({ start: T(), end: T() + f(20), text: 'x' }))), C.setCaptionTrack(sid, ct.id, { syncLock: rnd() < 0.7 }),
      ]);
    }
    if (r < 0.96) {
      const tid = pick(tracks);
      return pick([C.addTrack(sid, pick(['video', 'audio']), int(3)), C.setTrack(sid, tid, pick([{ locked: rnd() < 0.15 }, { syncLock: rnd() < 0.7 }, { height: 20 + int(100) }])), seq.tracks.length > 5 ? C.removeTrack(sid, tid) : C.setTrack(sid, tid, { name: 'T' })]);
    }
    return pick([
      C.addSequence(rnd() < 0.5 ? { from: sid } : { fps: pick(time.FRAME_RATES) }), C.setSequence(sid, { fps: pick(time.FRAME_RATES) }), C.setSequence(sid, { name: 'x', w: 1280, h: 720 }),
      h.project.sequences.length > 3 ? C.removeSequence(pick(h.project.sequences.filter((x) => x.id !== s)).id) : C.addBin('b'),
      C.importMedia([{ path: `D:/r${int(99)}.mp4`, kind: 'video', duration: 30 * SEC, video: VID, audio: AUD }], h.project.bins.length ? pick(h.project.bins).id : null),
      C.moveToBin([pick(h.project.media).id], h.project.bins.length ? pick(h.project.bins).id : null),
      C.renameItem(pick([...h.project.media, ...h.project.bins, ...h.project.sequences]).id, `r${int(9)}`),
      C.relinkMedia(pick(h.project.media).id, { path: `E:/moved${int(9)}.mp4`, size: int(1000), mtime: int(1000) }),
      h.project.media.length > 4 ? C.removeMedia([pick(h.project.media.slice(4)).id]) : C.addBin('m'),
      h.project.bins.length > 2 ? C.removeBin(pick(h.project.bins).id) : C.addBin('n', h.project.bins.length ? pick(h.project.bins).id : null),
    ]);
  };
  let done = 0;
  let tries = 0;
  let timed = 0; // steps that left a caption with word timings in the project
  const noops = {};
  const refusals = {};
  const t0 = Date.now();
  while (done < 2000 && tries < 12000) {
    tries++;
    const cmd = randomCommand();
    const steps = changes;
    try {
      h.do(cmd);
    } catch (err) {
      failed++;
      refusals[err.code] = (refusals[err.code] || 0) + 1;
      // Nothing changed: the project is still the last recorded state.
      if (hash() !== states[states.length - 1]) rollbackBad++;
      if (err.code === 'invalidResult') {
        invalid++;
        if (invalid < 4) console.log(`  invalid result from ${S(cmd)}: ${err.detail}`);
      }
      continue;
    }
    if (changes === steps) {
      noops[cmd.type] = (noops[cmd.type] || 0) + 1;
      if (hash() !== states[states.length - 1]) rollbackBad++;
      continue;
    }
    kinds[cmd.type] = (kinds[cmd.type] || 0) + 1;
    if (!model.validate(h.project).ok) invalid++;
    if (h.project.sequences.some((sq) => sq.captions.some((ct) => ct.items.some((it) => it.words)))) timed++;
    done++;
    states.push(hash());
    if (done % 97 === 0) {
      h.undo();
      if (hash() !== states[states.length - 2]) exactBad++;
      h.redo();
      if (hash() !== states[states.length - 1]) exactBad++;
    }
  }
  console.log(`  random: ${done} commands in ${tries} tries (${failed} refused: ${S(refusals)}) in ${Date.now() - t0} ms`);
  console.log(`  applied ${S(kinds)}`);
  console.log(`  no change ${S(noops)}`);
  check(done === 2000, `2,000 random commands applied (${done})`);
  check(timed >= 200, `the random commands edit and ripple captions with word timings (${timed} steps had some)`);
  check(Object.keys(kinds).length >= 50, `the random commands cover the command set (${Object.keys(kinds).length} kinds)`);
  eq([invalid, rollbackBad, exactBad], [0, 0, 0], 'no random command left an invalid project, a refused one changed nothing, undo/redo spot checks were exact');
  let stepBad = 0;
  for (let i = states.length - 2; i >= 0; i--) {
    h.undo();
    if (hash() !== states[i]) stepBad++;
  }
  eq([stepBad, hash() === start, h.canUndo], [0, true, true], 'undoing all 2,000 steps passes every earlier state and returns to the start');
  for (let i = 1; i < states.length; i++) {
    h.redo();
    if (hash() !== states[i]) stepBad++;
  }
  eq([stepBad, h.canRedo], [0, false], 'redoing all of them passes every state again');
  check(model.validate(h.project).ok && model.validate(model.migrate(h.serialize())).ok, 'the final project survives serialize and migrate');
} catch (err) {
  check(false, `random: ${err.stack}`);
}

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
