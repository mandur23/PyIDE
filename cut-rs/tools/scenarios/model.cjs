// The project model's scenarios for the Rust port (crates/cut-model): projects built by the JavaScript editor's own
// commands, the model's answers about them, and command runs whose every step the Rust side replays.
const path = require('node:path');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const time = require(path.join(CUT, 'time.js'));
const model = require(path.join(CUT, 'model.js'));
const C = require(path.join(CUT, 'commands.js'));
const RM = require(path.join(CUT, 'remap.js'));
const LU = require(path.join(CUT, 'lumetri.js'));

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

// The text both sides compare: keys sorted, a sequence's clips by track, start and id (the file's clip list has no
// meaning of order).
function canonOf(p) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
  };
  const q = JSON.parse(JSON.stringify(p));
  for (const seq of q.sequences || []) {
    if (Array.isArray(seq.clips)) seq.clips.sort((a, b) => (a.track < b.track ? -1 : a.track > b.track ? 1 : a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  }
  return JSON.stringify(sortKeys(q));
}
// Two 32-bit FNV-1a over the UTF-8 bytes, as one 16-digit hex string (the Rust side computes the same).
function hashOf(text) {
  const bytes = Buffer.from(text, 'utf8');
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[i], 0x01000193 + 0x1000) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function setup() {
  const project = model.createProject();
  const h = C.createHistory(project, { limit: Infinity });
  const [a, music, pic, b] = h.do(C.importMedia(MEDIA)).ids;
  return { h, s: project.sequences[0].id, a, music, pic, b };
}
const place = (h, s, o) => h.do(C.place(s, { mode: 'overwrite', ...o })).ids;

// Projects of every kind the editor's tests build, by its own commands.
function built() {
  const out = [];
  const { h, s, a, music, pic, b } = setup();
  out.push(h.serialize());
  const [v1, a1] = place(h, s, { source: { media: a }, in: f(10), out: f(100), at: f(30), video: 'V1', audio: 'A1' });
  place(h, s, { source: { media: music }, in: 0, out: f(300), at: 0, audio: 'A2' });
  place(h, s, { source: { media: pic }, at: f(200), video: 'V2' });
  place(h, s, { source: { media: b }, in: f(3), out: f(50), at: f(130), video: 'V1' });
  h.do(C.addGenerated(s, { track: 'V2', at: f(400), duration: f(60), source: { generator: 'text', layers: [{ text: '자막 "따옴표"\n줄' }] } }));
  h.do(C.addGenerated(s, { track: 'V2', at: f(500), duration: f(30), source: { generator: 'solid', color: '#ff00ff' } }));
  h.do(C.addGenerated(s, { track: 'V2', at: f(540), duration: f(30), source: { generator: 'adjustment' } }));
  out.push(h.serialize());
  h.do(C.setClip(s, v1, { props: { opacity: 40, position: [10.5, -3] } }));
  h.do(C.setKeyframes(s, v1, 'opacity', model.EASES.map((ease, i) => ({ t: f(i * 5), v: i * 10, ease, h: [0.2, -0.3, 0.8, 1.4] }))));
  h.do(C.setKeyframes(s, v1, 'position', [{ t: 0, v: [0, 0], ease: 'linear' }, { t: f(20), v: [100, -50], ease: 'easeInOut' }]));
  h.do(C.addEffect(s, v1, 'blur.gaussian', null, { amount: 3 }));
  h.do(C.addEffect(s, v1, 'color.basic'));
  h.do(C.addMarker(s, { t: f(12), name: '마커', note: 'n', kind: 'chapter', duration: f(5) }));
  h.do(C.addMarker(s, { t: f(5), kind: 'beat' }, { clipId: v1 }));
  h.do(C.addTransition(s, { track: 'V1', at: f(120), type: 'dissolve', duration: f(10), align: 'center' }));
  h.do(C.setClip(s, a1, { fadeIn: f(3), fadeOut: f(4), props: { volume: -6, pan: 20 } }));
  out.push(h.serialize());
  h.do(C.addCaptionTrack(s, { lang: 'ko', items: [
    { start: f(10), end: f(40), text: 'a b\nc', words: [{ t0: 0, t1: f(10), text: 'a' }, { t0: f(12), t1: f(20), text: 'b' }, { t0: f(25), t1: f(35), text: 'c' }] },
    { start: f(100), end: f(130), text: '안녕 하세요', doubt: [{ at: f(2), text: '안녕', p: 0.4 }] },
  ] }));
  h.do(C.setSpeakers({ list: [{ id: 'sp1', name: '', color: '#ff0000' }], turns: { [a]: [[0, 1.5, 'sp1']] }, count: 0 }));
  const ct = h.project.sequences[0].captions[0];
  h.do(C.setCaption(s, ct.id, ct.items[0].id, { speaker: 'sp1' }));
  out.push(h.serialize());
  // masks, time remapping, nests, sequences of other rates, bins and proxies
  h.do(C.addMask(s, v1, { path: [0.2, 0.2, 0, 0, 0, 0, 0.8, 0.2, 0, 0, 0, 0, 0.5, 0.9, -0.1, 0, 0.1, 0] }));
  const e = h.project.sequences[0].clips.find((c) => c.id === v1).effects[0].id;
  h.do(C.addMask(s, v1, { mode: 'subtract', inverted: true, path: [0.1, 0.1, 0, 0, 0, 0, 0.9, 0.1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0], feather: 30 }, { effectId: e }));
  h.do(C.setKeyframes(s, v1, 'masks.m1.feather', [{ t: 0, v: 10, ease: 'linear' }, { t: f(10), v: 200, ease: 'hold' }]));
  const vb = h.project.sequences[0].clips.find((c) => c.track === 'V1' && c.start === f(130)).id;
  let r = model.remapOf(h.project.sequences[0].clips.find((c) => c.id === vb));
  r = RM.addKey(r, f(10)) || r;
  r = RM.setSegmentSpeed(r, 1, 0.5, F);
  h.do(C.setRemap(s, vb, r));
  h.do(C.setClip(s, vb, { sampling: 'blend' }));
  const s2 = h.do(C.addSequence({ fps: [24000, 1001], name: 'film', w: 1280, h: 720 })).id;
  place(h, s2, { source: { media: a }, in: 0, out: 5 * SEC, at: 0, video: 'V1', audio: 'A1' });
  h.do(C.place(s, { source: { sequence: s2 }, at: f(700), video: 'V1', audio: 'A1', mode: 'overwrite' }));
  h.do(C.addSequence({ from: s }));
  const bin = h.do(C.addBin('촬영본')).id;
  const sub = h.do(C.addBin('sub', bin)).id;
  h.do(C.moveToBin([a, music], sub));
  h.do(C.moveToBin([s2], bin));
  h.do(C.setProxy(a, { path: 'cache:ab12' }));
  h.do(C.setClip(s, a1, { speed: 2, ripple: false }));
  h.do(C.setClip(s, v1, { reverse: true }));
  h.do(C.group(s, [v1, vb]));
  h.do(C.setRole(s, [a1], 'dialogue', {}));
  h.do(C.setSettings({ textStyles: [{ id: 'ts1', name: 'Big', style: { size: 120 } }], speechTerms: ['Nano'] }));
  out.push(h.serialize());
  return out;
}

// Files the editor never wrote this way: older versions, missing fields, fields of a newer version.
function handWritten() {
  const old = {
    format: 'ncut', version: 1,
    media: [{ id: 'm1', path: 'D:/영상/여행_01.mp4', kind: 'video', duration: 5080320000000, video: VID, audio: AUD, interpret: null, proxy: 'cache:ab12' }],
    bins: [{ id: 'b1', name: '촬영본', items: ['m1'] }],
    sequences: [{
      id: 's1', name: '브이로그', w: 1920, h: 1080, fps: [30, 1], rate: 48000,
      tracks: [{ id: 'V1', kind: 'video', locked: false, visible: true, syncLock: true }, { id: 'A1', kind: 'audio', mute: false, solo: false, volume: 0, pan: 0 }],
      clips: [{ id: 'c1', track: 'V1', source: { media: 'm1' }, start: 0, in: 254016000000, out: 2540160000000, speed: 1, reverse: false, link: null, group: null, enabled: true, label: 'blue',
        props: { position: [0, 0], scale: [100, 100], rotation: 0, anchor: [0, 0], opacity: 100 }, keyframes: { opacity: [{ t: 0, v: 0, ease: 'out' }, { t: 7620480000 + 3, v: 100 }, { t: 7620480000, v: 50, ease: 'in' }] },
        effects: [{ id: 'e1', type: 'color.basic', on: true, params: { exposure: 0.3 } }], role: 'singing', sampling: 'smooth' }],
      transitions: [], markers: [{ id: 'k7', t: 5, name: '인트로', kind: 'chapter', color: 'green' }],
      captions: [{ track: 'CC1', lang: 'ko', items: [{ id: 'q2', start: 0, end: 762048000000, text: '안녕하세요' }], style: { size: 80 } }],
    }],
  };
  const future = JSON.parse(built()[4]);
  future.someNewThing = { a: [1, 2, 3] };
  future.settings.newSetting = 'x';
  future.media[0].hdr = { transfer: 'pq' };
  future.media[0].video.depth = 10;
  future.bins[0].color = 'red';
  const sq = future.sequences[0];
  sq.colorSpace = 'rec2020';
  sq.tracks[0].targeted = true;
  sq.clips[0].stabilize = { amount: 50 };
  sq.clips[0].source.layer = 2;
  sq.clips[0].effects.forEach((e) => { e.preset = 'p'; });
  sq.markers[0].icon = 'star';
  sq.transitions.forEach((t) => { t.curve = 'smooth'; });
  sq.captions[0].burnIn = true;
  sq.captions[0].items[0].style = { italic: true };
  const badMask = JSON.parse(built()[4]);
  const bc = badMask.sequences[0].clips.find((c) => c.masks);
  bc.masks.push({ id: 'm9', path: [1, 2] }, { id: 'm1', path: bc.masks[0].path });
  bc.keyframes['masks.m77.path'] = [{ t: 0, v: [0, 0], ease: 'linear' }];
  bc.keyframes['masks.m1.opacity'] = [{ t: 0, v: 500, ease: 'linear' }];
  const badRemap = JSON.parse(built()[4]);
  const rc = badRemap.sequences[0].clips.find((c) => c.remap);
  rc.remap.keys.push({ t: 1, ramp: 0 });
  const words = JSON.parse(built()[3]);
  words.sequences[0].captions[0].items[0].text = 'a c\nd e';
  words.sequences[0].captions[0].items[0].start += 7;
  return [old, future, badMask, badRemap, words, { format: 'ncut', version: 2 }, { format: 'ncut', version: 3, sequences: [{ id: 's9', clips: [] }] }].map((p) => JSON.stringify(p));
}

// A random run of the editor's own random-command test (verify/cut-model.mjs), its generator as it is there.
// `extra` mixes in what the editor's test leaves out (graphic clips, LUTs, an effect's masks); without it the run is the
// editor's own, step for step.
function randomRun({ seed = 20261105, steps = 2000, texts = [], every = 0, extra = false } = {}) {
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
  const h = first.h;
  h.do(C.addSequence({ fps: [24000, 1001], name: 'film' }));
  for (let i = 0; i < 12; i++) {
    try { h.do(C.place(s, { source: { media: pick([a, music, pic, b]) }, in: f(int(100)), out: f(100 + int(200)), at: T(), video: pick(['V1', 'V2']), audio: pick(['A1', 'A2']), mode: pick(['insert', 'overwrite']) })); } catch {}
  }
  h.do(C.addCaptionTrack(s, { items: [{ start: f(10), end: f(40), text: 'a' }, { start: f(100), end: f(130), text: 'b' }] }));
  const remapCommand = (sid, seq, cl) => {
    const sf = time.frameTicks(seq.fps);
    const dur = model.clipDuration(cl);
    let r = model.remapOf(cl);
    const i = r.keys.length ? int(r.keys.length) : -1;
    const n = int(10);
    if (n === 0) return C.setRemap(sid, cl.id, null);
    if (n === 1) return C.setClip(sid, cl.id, { sampling: pick(model.SAMPLINGS) });
    if (n <= 3 || i < 0) r = RM.addKey(r, Math.round((rnd() * dur) / sf) * sf) || r;
    else if (n === 4) { const j = int(r.speeds.length); r = RM.setSegmentSpeed(r, j, Math.sign(r.speeds[j] || 1) * pick([0.1, 0.25, 0.5, 2, 4]), sf); }
    else if (n === 5) r = RM.splitKey(r, i, pick(['left', 'right']), (int(25) - 5) * sf, sf);
    else if (n === 6) r = RM.moveKey(r, i, (int(21) - 10) * sf, sf, { keepSpeeds: rnd() < 0.5 });
    else if (n === 7) r = RM.insertReverse(r, i, (1 + int(10)) * sf) || r;
    else if (n === 8) r = RM.insertFreeze(r, i, (1 + int(10)) * sf) || r;
    else r = RM.removeKey(r, i, sf);
    return C.setRemap(sid, cl.id, r);
  };
  const MASK = [0.2, 0.2, 0, 0, 0, 0, 0.8, 0.2, 0, 0, 0, 0, 0.5, 0.9, -0.1, 0, 0.1, 0];
  const extraCommand = (sid, seq, cl, vt) => {
    const graphics = seq.clips.filter((x) => x.source.generator === 'graphic');
    const gx = graphics.length ? pick(graphics) : null;
    const gl = gx ? pick(gx.source.layers) : null;
    const vclips = seq.clips.filter((x) => seq.tracks.find((t) => t.id === x.track)?.kind === 'video');
    const vc = vclips.length ? pick(vclips) : cl;
    const fx = vc && vc.effects.length ? pick(vc.effects) : null;
    const fm = fx?.masks?.length ? pick(fx.masks).id : 'm99';
    const layer = () => pick([
      { kind: 'rect', size: [int(500), int(300)], fill: pick(['#ff0000', null, 'red']) },
      { kind: 'ellipse', position: [int(100), -int(100)] },
      { kind: 'text', text: `t${int(9)}`, fontSize: pick([40, 2000]) },
      { kind: 'path', d: pick(['M0 0 L10 10 Z', 'M0 0 A1 1 0 0 1 2 2', 'm1 1 c1 1 2 2 3 3']) },
      { kind: 'group' },
      { kind: 'star', points: pick([5, 2, 64]), parent: gl?.id ?? null },
      { kind: 'particles', count: pick([60, 3000]), emit: 'burst' },
      { kind: 'line', from: [0, 0], to: [int(300), 0], dash: pick([null, [4, 4], [0, 0]]) },
      { kind: 'blob' },
      { id: `g${int(4)}`, kind: 'rect' },
    ]);
    const lut = rnd() < 0.8 ? LU.store(LU.parseCube(LU.identityCube(2 + int(3))), `l${int(9)}`) : { id: pick(['lut-0', 'lut-0123456789abcdef']), entry: { name: 'x', size: 2 } };
    const orLut = (c) => c || C.addLut(lut);
    return pick([
      C.addGenerated(sid, { track: pick(vt), at: T(), duration: rnd() < 0.5 ? undefined : D() + f(61), source: { generator: 'graphic', layers: [...Array(int(4))].map(layer) }, mode: pick(['insert', 'overwrite']) }),
      C.place(sid, { source: { generator: 'graphic', layers: [layer()] }, in: 0, out: f(1 + int(60)), at: T(), video: pick(vt), mode: 'overwrite' }),
      orLut(gx && C.setGenerator(sid, gx.id, { layers: [...Array(1 + int(3))].map(layer) })),
      orLut(gx && C.setLayer(sid, gx.id, gl.id, pick([{ opacity: int(101) }, { position: [int(50), int(50)] }, { kind: 'text' }, { kind: gl.kind, name: 'k' }, { id: 'zz' }, { fill: 'nope' }, { name: 'n' }]))),
      orLut(gx && C.addLayer(sid, gx.id, layer(), rnd() < 0.5 ? null : int(4))),
      orLut(gx && C.removeLayer(sid, gx.id, rnd() < 0.9 ? gl.id : 'none')),
      orLut(gx && C.setKeyframes(sid, gx.id, `layers.${gl.id}.opacity`, [{ t: 0, v: int(100), ease: 'linear' }])),
      C.addLut(lut),
      orLut(vc && C.addEffect(sid, vc.id, pick(['edge.extend', 'blur.gaussian', 'color.basic', 'audio.gain', 'dissolve', 'nothing']), null)),
      orLut(vc && fx && C.addMask(sid, vc.id, { path: MASK, feather: int(50) }, { effectId: rnd() < 0.9 ? fx.id : 'e99' })),
      orLut(vc && fx && C.setMask(sid, vc.id, fm, pick([{ feather: int(100) }, { opacity: 500 }, { inverted: true }]), { effectId: fx.id })),
      orLut(vc && fx && C.removeMask(sid, vc.id, fm, { effectId: fx.id })),
      orLut(vc && fx && C.setKeyframes(sid, vc.id, `effects.${fx.id}.masks.${fm}.feather`, [{ t: 0, v: int(100), ease: 'linear' }])),
      orLut(vc && fx && C.setEffect(sid, vc.id, fx.id, { params: { lut: rnd() < 0.5 ? lut.id : null } })),
      orLut(vc && fx && C.moveEffect(sid, vc.id, fx.id, rnd() * 3)),
      orLut(vc && C.addMask(sid, vc.id, { path: MASK }, { effectId: vc.effects.find((e) => e.type !== 'edge.extend')?.id ?? null })),
      orLut(vc && fx && C.addMask(sid, vc.id, { path: MASK, opacity: int(100) }, { effectId: fx.id })),
      orLut(cl && C.replaceAudio(sid, [cl.id], pick([music, a, pic]))),
      C.setSpeakers(rnd() < 0.2 ? null : { list: [{ id: 'sp1', name: 'A', color: pick(['#ff0000', 'red']) }], turns: { [a]: [[0, 1 + int(5), 'sp1']] }, count: int(3) }),
    ]);
  };
  const randomCommand = () => {
    const sid = rnd() < 0.85 ? s : pick(h.project.sequences).id;
    const seq = h.project.sequences.find((x) => x.id === sid);
    if (!seq) return C.addSequence({});
    const cl = seq.clips.length ? pick(seq.clips) : null;
    const tracks = seq.tracks.map((t) => t.id);
    const vt = seq.tracks.filter((t) => t.kind === 'video').map((t) => t.id);
    if (extra && rnd() < 0.3) return extraCommand(sid, seq, cl, vt);
    const at = seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.id);
    const some = () => seq.clips.filter(() => rnd() < 0.2).map((x) => x.id).concat(cl ? [cl.id] : []);
    const many = seq.clips.length > 40;
    const r = rnd() * (many ? 0.8 : 1);
    if (rnd() < 0.04) {
      const texts2 = seq.clips.filter((x) => x.source.generator === 'text');
      const solids = seq.clips.filter((x) => x.source.generator === 'solid');
      const tx2 = texts2.length ? pick(texts2) : null;
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
    if (rnd() < 0.05 && cl) return remapCommand(sid, seq, cl);
    if (rnd() < 0.06 && cl) {
      return pick([
        C.slip(sid, cl.id, { delta: D(), linked: rnd() < 0.8 }),
        C.slide(sid, cl.id, { delta: D(), linked: rnd() < 0.8 }),
        C.stretch(sid, cl.id, { edge: pick(['start', 'end']), delta: D(), linked: rnd() < 0.8 }),
        C.extendEdit(sid, T(), rnd() < 0.5 ? { clipIds: some() } : { trackIds: rnd() < 0.5 ? null : [pick(tracks)], linked: rnd() < 0.8 }),
        C.group(sid, some()),
        C.ungroup(sid, some()),
        C.nest(sid, some(), { name: `n${int(9)}`, linked: rnd() < 0.8 }),
      ]);
    }
    if (r < 0.1) return C.place(sid, { source: rnd() < 0.85 ? { media: pick([a, a, music, pic, b]) } : rnd() < 0.4 ? { sequence: pick(h.project.sequences).id } : { generator: pick(['text', 'solid', 'adjustment']) }, in: T() / 4, out: T(), at: T(), video: rnd() < 0.8 ? pick(vt) : null, audio: rnd() < 0.8 ? pick(at) : null, mode: pick(['insert', 'overwrite']) });
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
  const start = h.serialize();
  const out = [];
  for (let i = 0; i < steps; i++) {
    const cmd = randomCommand();
    const step = { cmd };
    try {
      step.result = h.do(cmd) ?? null;
    } catch (err) {
      step.code = err.code || 'error';
    }
    const text = h.serialize();
    step.hash = hashOf(canonOf(JSON.parse(text)));
    if (texts.includes(cmd.type) || (every && i % every === 0)) step.text = text;
    out.push(step);
  }
  return { start, steps: out };
}

// Valid projects each broken one way (the cases of verify/cut-model.mjs and more), as text.
function broken() {
  const base = JSON.parse(built()[4]);
  const cases = [
    (q, sq) => { sq.clips[0].start = f(30) + 5; },
    (q, sq) => { sq.clips.push({ ...model.clone(sq.clips[0]), id: 'c900', link: null, start: sq.clips[0].start + F }); q.nextId = 1000; },
    (q, sq) => { sq.clips[1].id = sq.clips[0].id; },
    (q, sq) => { sq.clips[0].id = `c${q.nextId + 5}`; },
    (q, sq) => { sq.clips[0].source.media = 'm999'; },
    (q, sq) => { const l = sq.clips.find((c) => c.link); sq.clips.filter((c) => c.link === l.link).slice(1).forEach((c) => { c.link = null; }); },
    (q, sq) => { sq.transitions.push({ id: 'x1', track: 'V1', at: f(45) + F * 1000, type: 'dissolve', duration: f(10), align: 'center', params: {} }); },
    (q, sq) => { sq.clips[0].keyframes.opacity = [{ t: f(5), v: 1, ease: 'linear' }, { t: f(2), v: 0, ease: 'linear' }]; },
    (q, sq) => { sq.clips.find((c) => c.track[0] === 'V').keyframes.volume = [{ t: 0, v: 1, ease: 'linear' }]; },
    (q, sq) => { const c = sq.clips.find((x) => x.source.media && !x.remap && q.media.find((m) => m.id === x.source.media).kind !== 'image'); c.out = 70 * SEC * c.speed; c.in = c.out - f(90) * c.speed; },
    (q, sq) => { sq.clips.find((c) => c.track[0] === 'V' && c.source.media).source.media = q.media[1].id; },
    (q) => { q.sequences[0].fps = [17, 1]; },
    (q) => { q.nextId = 0; q.version = 4; q.format = 'x'; },
    (q, sq) => { sq.w = 8; sq.background = 'red'; sq.rate = 44100; },
    (q, sq) => { sq.tracks.push({ ...sq.tracks[0] }); sq.tracks[1].height = 0; },
    (q, sq) => { sq.markers[0].t = 7; sq.markers[0].duration = -F; },
    (q, sq) => { sq.captions[0].items.reverse(); sq.captions[0].items[0].end = 3; },
    (q, sq) => { sq.captions[0].items[0].words[0].text = 'zz'; sq.captions[0].items[1].speaker = 'bob'; },
    (q, sq) => { const c = sq.clips.find((x) => x.fadeIn); c.fadeIn = model.clipDuration(c); c.fadeOut = F; },
    (q, sq) => { q.bins[0].items.push('m1'); q.bins[1].items.push('zz9'); q.bins[0].parent = q.bins[1].id; },
    (q, sq) => { sq.clips.find((c) => c.source.sequence).source.sequence = sq.id; },
    (q) => { const s2 = q.sequences.find((x) => x.name === 'film'); const n = model.clone(q.sequences[0].clips.find((c) => c.source.sequence)); n.id = 'c9999'; n.start = 50 * SEC; n.source.sequence = q.sequences[0].id; s2.clips.push(n); q.nextId = 10000; },
    (q, sq) => { const c = sq.clips.find((x) => x.remap); c.in -= 10; c.speed = 2; },
    (q, sq) => { const c = sq.clips.find((x) => x.masks); c.masks[0].feather = 5000; c.masks.push({ ...c.masks[0] }); },
    (q, sq) => { sq.clips[0].keyframes.opacity = [{ t: 0, v: [], ease: 'bezier' }]; },
    (q, sq) => { sq.transitions.push({ ...sq.transitions[0], id: 'c8888' }); q.nextId = 9000; sq.transitions[0].duration = 0; },
    (q) => { q.speakers.list.push({ id: 'sp1', name: 'x', color: '#000' }); },
    (q) => { q.speakers.turns[q.media[0].id] = [[2, 1, 'sp1']]; },
  ];
  return cases.map((mut) => { const q = model.clone(base); mut(q, q.sequences[0]); return JSON.stringify(q); });
}

// A history driven by a script of its calls ([name, ...args]); after each, what a panel sees of it.
function historyScript(text, ops, limit) {
  const h = C.createHistory(JSON.parse(text), { limit: limit ?? 1000 });
  const events = [];
  h.onChange((r) => events.push(r));
  let mark = null;
  return ops.map(([op, ...args]) => {
    let value = null;
    try {
      if (op === 'do') value = h.do(args[0]) ?? null;
      else if (op === 'amend') value = h.amend(args[0]) ?? null;
      else if (op === 'mark') { mark = h.mark(); }
      else if (op === 'markSaved') h.markSaved(mark ?? undefined);
      else value = h[op](...args) ?? null;
    } catch (err) { value = { $code: err.code || 'error' }; }
    const out = { value, list: h.list(), position: h.position, dirty: h.dirty, canUndo: h.canUndo, canRedo: h.canRedo, grouping: h.grouping, events: events.splice(0), hash: hashOf(canonOf(h.project)) };
    return out;
  });
}

// The benchmark: a project of `n` clips on 20 tracks (10 video, 10 audio, linked in pairs), the times the editor takes
// to load it, to find the clips at a time and to apply and undo a mix of commands, and those commands for the Rust side.
function bench({ n = 10000, queries = 1000, commands = 1000 } = {}) {
  const p = model.createProject({ sequence: { videoTracks: 10, audioTracks: 10 } });
  const long = 10 * 3600 * SEC;
  p.media.push({ id: 'm2', path: 'D:/long.mp4', name: 'long.mp4', kind: 'video', size: 0, mtime: 0, duration: long, video: VID, audio: AUD, interpret: null, proxy: null });
  p.nextId = 3;
  const seq = p.sequences[0];
  const per = n / 20;
  const len = 2 * SEC;
  for (let k = 0; k < per; k++) {
    for (let i = 0; i < 10; i++) {
      const link = model.newId(p, 'L');
      for (const tr of [`V${i + 1}`, `A${i + 1}`]) {
        const c = model.createClip(tr[0] === 'V' ? 'video' : 'audio', { id: model.newId(p, 'c'), track: tr, start: k * len, in: k * len, out: (k + 1) * len, source: { media: 'm2' }, name: 'long.mp4' });
        c.link = link;
        seq.clips.push(c);
      }
    }
  }
  const text = JSON.stringify(p);
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const end = per * len;
  const times = [...Array(queries)].map(() => Math.floor(rnd() * end));
  const ids = seq.clips.map((c) => c.id);
  const cmds = [...Array(commands)].map((_, i) => {
    const id = ids[Math.floor(rnd() * ids.length)];
    const t = Math.floor(rnd() * end);
    switch (i % 5) {
      case 0: return C.setClip('s1', id, { name: `n${i}` });
      case 1: return C.trim('s1', id, { edge: 'end', delta: -F * (1 + Math.floor(rnd() * 10)), mode: 'normal' });
      case 2: return C.split('s1', t, { trackIds: [`V${1 + Math.floor(rnd() * 10)}`] });
      case 3: return C.addMarker('s1', { t });
      default: return C.setKeyframes('s1', id, 'opacity', null);
    }
  });
  const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
  let t0 = process.hrtime.bigint();
  const h = C.createHistory(model.migrate(text), { limit: Infinity });
  const load = ms(t0);
  t0 = process.hrtime.bigint();
  let found = 0;
  for (const t of times) found += model.clipsAt(h.project.sequences[0], t).length;
  const clipsAt = ms(t0);
  t0 = process.hrtime.bigint();
  let applied = 0;
  for (const c of cmds) { try { h.do(c); applied++; } catch {} }
  const apply = ms(t0);
  t0 = process.hrtime.bigint();
  while (h.undo());
  const undo = ms(t0);
  return { text, times, cmds, ms: { load, clipsAt, apply, undo }, found, applied };
}

const answer = (fn) => { try { return fn(); } catch (err) { return { $code: err.code || 'error', $message: String(err.message) }; } };

module.exports = {
  projects: () => [...built(), ...handWritten()],
  broken,
  sampled: (o) => randomRun({ ...o }).steps.filter((s) => s.text).map((s) => s.text),
  randomRun,
  historyScript,
  bench,
  start: () => setup().h.serialize(),
  // the project after step k of a random run (k from 0), for a failure message
  stateAfter: (o, k) => { const r = randomRun({ ...o, steps: k + 1, every: 1 }); return r.steps[k].text; },
  // migrate's result as the canonical text, or the error's code
  migrated: (text) => answer(() => canonOf(model.migrate(text))),
  canon: (text) => canonOf(JSON.parse(text)),
  hash: (text) => hashOf(text),
  validate: (text) => answer(() => model.validate(JSON.parse(text)).errors),
  load: (text) => answer(() => { const p = model.migrate(text); C.createHistory(p); return canonOf(p); }),
  // Every question of the model about each clip and sequence of a project, at the given times.
  queries(text, times) {
    const p = JSON.parse(text);
    const out = { seqs: [] };
    for (const seq of p.sequences) {
      const s = { id: seq.id, duration: model.sequenceDuration(seq), nested: [...model.nestedIds(seq)].sort(), at: [], clips: [], tracks: [] };
      for (const tr of seq.tracks) s.tracks.push(model.trackIndex(seq, tr.id));
      for (const t of times) s.at.push([model.clipsAt(seq, t).map((c) => c.id), model.clipsAt(seq, t, { kind: 'audio' }).map((c) => c.id)]);
      for (const c of seq.clips) {
        const d = model.clipDuration(c);
        const ts = [c.start, c.start + d / 2, c.start + d - 1, c.start - 5, c.start + d + 5];
        const room = model.sourceRoom(p, c);
        s.clips.push({
          id: c.id, duration: d, end: model.clipEnd(c), still: model.isStill(p, c), length: model.sourceLength(p, c),
          source: ts.map((t) => model.sourceTime(c, t)),
          timeline: [c.in, c.out, (c.in + c.out) / 2, c.in - 10, c.out + 10].map((x) => model.timelineTime(c, x)),
          span: [model.sourceSpan(c, c.start, c.start + d), model.sourceSpan(c, c.start + d / 3, c.start + d / 2)],
          room: [room.head, room.tail], remap: model.remapOf(c), linked: model.linkedClips(seq, c).map((x) => x.id).sort(),
        });
      }
      s.clips.sort((x, y) => (x.id < y.id ? -1 : 1));
      out.seqs.push(s);
    }
    out.nest = [];
    for (const x of p.sequences) for (const y of p.sequences) out.nest.push([model.reaches(p, x.id, y.id), model.nestLoop(p, x.id, y.id), model.nestKinds(p, y.id)]);
    out.uses = p.sequences.map((x) => model.nestUses(p, x.id).map((u) => [u.seq.id, u.clips.map((c) => c.id).sort()]));
    return out;
  },
};
