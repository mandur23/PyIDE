// Oracle scenarios for cut-audio: the audio engine's resampler, stretch, loudness meter and effect processors on
// sample buffers (float arrays travel as base64 of their bytes), and whole mixes of test projects built with the
// editor's own commands, with the sources the scenario makes, in any block sizes.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'renderer', 'features', 'cut');
const time = require(path.join(CUT, 'time.js'));
const model = require(path.join(CUT, 'model.js'));
const C = require(path.join(CUT, 'commands.js'));
const fx = require(path.join(CUT, 'effects.js'));
const afx = require(path.join(CUT, 'audiofx.js'));
const ae = require(path.join(CUT, 'audioengine.js'));
const analyze = require(path.join(CUT, 'analyze.js'));

const SEC = time.TICKS;
// Bytes arrive as a Uint8Array (the oracle revives { $bytes }).
const f32 = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const f64 = (u8) => new Float64Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const out = (a) => ({ $bytes: Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64') });

export const resample = (chs, from, to) => ae.resample(chs.map(f32), from, to).map(out);
export const stretch = (chs, factor, rate) => ae.stretch(chs.map(f32), factor, rate).map(out);
export const loudness = (chs, rate) => ae.loudness(chs.map(f32), rate);
export const kFilters = (fs) => ae.kFilters(fs);

// One processor over whole channels with the registry's resolved parameters.
export function processBuffer(type, params, L, R, fs, blocks) {
  const [y0, y1] = afx.processBuffer(fx.get(type).dsp, fx.resolve(type, params), [f64(L), f64(R)], fs, { blocks });
  return [out(Float64Array.from(y0)), out(Float64Array.from(y1))];
}
// A chain of effects [[type, params]] with fixed parameters over whole channels.
export function chain(list, L, R, fs) {
  const stages = list.map(([type, p]) => {
    const def = fx.get(type);
    return def.dsp ? { proc: afx.processors[def.dsp], base: fx.resolve(type, p) } : { gain: (q, t) => def.gain(q, t, 10), base: fx.resolve(type, p) };
  });
  const run = afx.createChain(stages, fs);
  const x = f64(L);
  const y = f64(R);
  run.process(x, y, x.length, { paramsAt: (k) => stages[k].base, secondsAt: (i) => i / fs });
  return { latency: run.latency, out: [out(x), out(y)] };
}
export const resolve = (type, params) => fx.resolve(type, params);
export const response = (type, params, freqs, fs) => afx.response(fx.get(type).dsp, fx.resolve(type, params), freqs, fs);
export const memory = (type, params, fs) => { const d = fx.get(type).dsp; return [afx.processors[d].memory(fx.resolve(type, params), fs), afx.processors[d].latency(fs)]; };
export const gain = (type, params, t, length) => fx.get(type).gain(fx.resolve(type, params), t, length);
export const levels = (chs, rate, windowSec) => {
  const m = analyze.levelMeter(rate, windowSec);
  const planes = chs.map(f32);
  for (let i = 0; i < planes[0].length; i += 4093) m.push(planes.map((p) => p.subarray(i, Math.min(p.length, i + 4093))));
  return { levels: out(m.levels()), step: m.step };
};

// ---- test projects ---------------------------------------------------------------------------------------------------

// A deterministic sound: a slow envelope over two sines and bursts of noise (stereo), or one sine (mono).
function sound(seconds, rate, seed, channels = 2) {
  const n = Math.round(seconds * rate);
  const ch = Array.from({ length: channels }, () => new Float32Array(n));
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.3 + seed * 0.05) * t);
    const burst = Math.floor(t * 2) % 3 === 0 ? 0.5 : 0.04;
    ch[0][i] = env * (0.3 * Math.sin(2 * Math.PI * (220 + 40 * seed) * t) + 0.15 * Math.sin(2 * Math.PI * 60 * t)) + burst * (s / 2 ** 32 - 0.5);
    if (channels > 1) ch[1][i] = env * 0.35 * Math.sin(2 * Math.PI * (330 + 10 * seed) * t + 1) + burst * 0.4 * (s / 2 ** 32 - 0.5);
  }
  return ch;
}
const MED = (name, seconds, rate, channels = 2) => ({ path: `D:/a/${name}.wav`, name: `${name}.wav`, kind: 'audio', size: 1, mtime: 1, duration: seconds * SEC, video: null, audio: { rate, channels } });

function start(media) {
  const h = C.createHistory(model.createProject({ sequence: { w: 1280, h: 720, fps: [30, 1] } }), { limit: Infinity });
  const ids = h.do(C.importMedia(media.map(([name, seconds, rate, channels]) => MED(name, seconds, rate, channels)))).ids;
  const sources = {};
  media.forEach(([name, seconds, rate, channels], k) => { sources[`${name}.wav`] = { rate, data: sound(seconds, rate, k + 1, channels) }; });
  return { h, s: h.project.sequences[0].id, ids, sources };
}
const put = (b, media, { at, inS, outS, track = 'A1' }) => b.h.do(C.place(b.s, { source: { media }, in: inS * SEC, out: outS * SEC, at: at * SEC, video: null, audio: track, mode: 'overwrite' })).ids[0];
const clipOf = (b, id, seq = b.s) => b.h.project.sequences.find((q) => q.id === seq).clips.find((c) => c.id === id);
const lin = (t, v, ease = 'linear') => ({ t: t * SEC, v, ease });

const BUILDERS = {
  // Volume, duck and pan keyframes, fades, a crossfade, track volume and pan, a mono and a 44.1 kHz source, master.
  basic() {
    const b = start([['a', 10, 48000], ['b', 10, 44100], ['m', 10, 48000, 1]]);
    for (let i = 0; i < 2; i++) b.h.do(C.addTrack(b.s, 'audio'));
    const a = put(b, b.ids[0], { at: 0.5, inS: 1, outS: 5 });
    const c = put(b, b.ids[1], { at: 4.5, inS: 2, outS: 6 });
    b.h.do(C.addTransition(b.s, { track: 'A1', at: 4.5 * SEC, type: 'crossfade.power', duration: 0.6 * SEC, align: 'center' }));
    b.h.do(C.setKeyframes(b.s, a, 'volume', [lin(0, -6), lin(1.3, 2, 'easeInOut'), { ...lin(3, -1, 'bezier'), h: [0.3, 0.1, 0.6, 1] }]));
    b.h.do(C.setKeyframes(b.s, c, 'pan', [lin(0, -80), lin(2.5, 60)]));
    b.h.do(C.setClip(b.s, a, { fadeIn: 0.3 * SEC }));
    b.h.do(C.setClip(b.s, c, { fadeOut: 0.7 * SEC }));
    const m = put(b, b.ids[2], { at: 1, inS: 0.25, outS: 4, track: 'A2' });
    b.h.do(C.setClip(b.s, m, { props: { volume: -4, pan: 40 } }));
    b.h.do(C.setKeyframes(b.s, m, 'duck', [lin(0.5, 0), lin(1, -12), lin(2, -12), lin(2.4, 0)]));
    b.h.do(C.setTrack(b.s, 'A1', { volume: 3, pan: -20 }));
    b.h.do(C.setTrack(b.s, 'A2', { volume: -2.5 }));
    const q = put(b, b.ids[0], { at: 2, inS: 6, outS: 8, track: 'A3' });
    b.h.do(C.setClip(b.s, q, { props: { volume: -3, pan: 0 } }));
    b.h.do(C.setTrack(b.s, 'A3', { mute: true }));
    b.h.do(C.setSequence(b.s, { masterGain: -1.5 }));
    return b;
  },
  // Solo: only the solo tracks are heard.
  solo() {
    const b = BUILDERS.basic();
    b.h.do(C.setTrack(b.s, 'A2', { solo: true }));
    b.h.do(C.setTrack(b.s, 'A3', { mute: false, solo: true }));
    return b;
  },
  // Speed 2 and 0.5 with the pitch kept, reverse at speed 1 and 0.7, 1.5 with the pitch not kept, a 44.1 kHz source.
  speed() {
    const b = start([['a', 20, 48000], ['b', 20, 44100]]);
    for (let i = 0; i < 3; i++) b.h.do(C.addTrack(b.s, 'audio'));
    const x = put(b, b.ids[0], { at: 0.25, inS: 1, outS: 9 });
    b.h.do(C.setClip(b.s, x, { speed: 2 }));
    const y = put(b, b.ids[1], { at: 0.5, inS: 3, outS: 6, track: 'A2' });
    b.h.do(C.setClip(b.s, y, { speed: 0.5 }));
    const z = put(b, b.ids[0], { at: 1, inS: 2, outS: 6, track: 'A3' });
    b.h.do(C.setClip(b.s, z, { reverse: true }));
    const w = put(b, b.ids[1], { at: 0, inS: 4, outS: 10, track: 'A4' });
    b.h.do(C.setClip(b.s, w, { speed: 1.5 }));
    clipOf(b, w).keepPitch = false;
    const v = put(b, b.ids[0], { at: 5, inS: 10, outS: 13, track: 'A3' });
    b.h.do(C.setClip(b.s, v, { speed: 0.7, reverse: true }));
    b.h.do(C.setKeyframes(b.s, x, 'volume', [lin(0, 0), lin(2, -9)]));
    return b;
  },
  // The audio effects: a chain with a keyframed EQ, compressor, gain, gate, limiter and DeHummer; bass and treble at
  // 44.1 kHz; gain and fade effects without a processor; an effect switched off.
  fx() {
    const b = start([['a', 12, 48000], ['b', 12, 44100]]);
    for (let i = 0; i < 2; i++) b.h.do(C.addTrack(b.s, 'audio'));
    const x = put(b, b.ids[0], { at: 0.5, inS: 0.2, outS: 9.2 });
    const add = (clip, type, p, keys) => {
      const r = b.h.do(C.addEffect(b.s, clip, type, null, p));
      for (const [param, list] of Object.entries(keys || {})) b.h.do(C.setKeyframes(b.s, clip, `effects.${r.id}.${param}`, list));
      return r.id;
    };
    add(x, 'audio.eq', { hpOn: true, hpFreq: 40, hpSlope: '24', b2Freq: 1000, b2Gain: -12, b2Q: 2, lpOn: true, lpFreq: 9000, lpSlope: '48' }, { b2Gain: [lin(0, -12), lin(4, 6)] });
    add(x, 'audio.compressor', { threshold: -24, ratio: 3, attack: 5, release: 120, makeup: 4 });
    add(x, 'audio.gain', { gain: 3 }, { gain: [lin(1, 3), lin(5, -6)] });
    add(x, 'audio.gate', { threshold: -45, hold: 30 });
    add(x, 'audio.limiter', { ceiling: -3, release: 40, truePeak: true });
    add(x, 'audio.dehum', { frequency: '60', harmonics: 3 });
    b.h.do(C.setKeyframes(b.s, x, 'volume', [lin(0, -3), lin(3, 2)]));
    b.h.do(C.setClip(b.s, x, { fadeIn: 0.25 * SEC, fadeOut: 0.5 * SEC }));
    const y = put(b, b.ids[1], { at: 1, inS: 1, outS: 8, track: 'A2' });
    add(y, 'audio.bass', { boost: 6 });
    add(y, 'audio.treble', { boost: -4 });
    const off = add(y, 'audio.eq', { b2Gain: -24 });
    b.h.do(C.setEffect(b.s, y, off, { on: false }));
    const z = put(b, b.ids[0], { at: 0, inS: 3, outS: 8, track: 'A3' });
    add(z, 'audio.gain', { gain: -5 });
    add(z, 'audio.fade', { fadeIn: 1, fadeOut: 0.5, curve: 'power' });
    add(z, 'audio.fade', { fadeIn: 0.4, fadeOut: 2, curve: 'linear' });
    // A sped-up clip with a chain.
    const s = put(b, b.ids[1], { at: 6, inS: 2, outS: 8, track: 'A2' });
    b.h.do(C.setClip(b.s, s, { speed: 1.25 }));
    add(s, 'audio.compressor', { threshold: -30, ratio: 6, attack: 1, release: 60 });
    return b;
  },
  // A nested sequence on an audio track at speed 1.5 with volume and pan on top; inside, a muted track and a crossfade.
  nest() {
    const b = start([['a', 10, 48000], ['b', 10, 48000], ['c', 10, 44100]]);
    b.h.do(C.addTrack(b.s, 'audio'));
    const a = put(b, b.ids[0], { at: 1, inS: 2, outS: 5 });
    const c = put(b, b.ids[1], { at: 4, inS: 0, outS: 3 });
    b.h.do(C.addTransition(b.s, { track: 'A1', at: 4 * SEC, type: 'crossfade.power', duration: 0.5 * SEC, align: 'center' }));
    const d = put(b, b.ids[2], { at: 2, inS: 1, outS: 4, track: 'A2' });
    b.h.do(C.setClip(b.s, d, { props: { volume: -6, pan: 30 } }));
    const r = b.h.do(C.nest(b.s, [a, c, d], { name: 'Nested Sequence 1' }));
    b.h.do(C.setTrack(r.id, 'A2', { volume: -3 }));
    const n = r.ids[0];
    b.h.do(C.setClip(b.s, n, { props: { volume: -2, pan: -25 } }));
    b.h.do(C.setKeyframes(b.s, n, 'volume', [lin(0, -2), lin(2, 1)]));
    const e = put(b, b.ids[0], { at: 0, inS: 6, outS: 9, track: 'A2' });
    b.h.do(C.setClip(b.s, e, { speed: 1, reverse: true }));
    return b;
  },
};

const built = new Map();
function project(name) {
  if (!built.has(name)) built.set(name, BUILDERS[name]());
  return built.get(name);
}
// The project and its sources as the Rust side reads them.
export function build(name) {
  const b = project(name);
  const sources = {};
  for (const [k, v] of Object.entries(b.sources)) sources[k] = { rate: v.rate, data: v.data.map(out) };
  return { project: JSON.stringify(b.h.project), seq: b.s, sources };
}
const getAudioOf = (b, shape) => async (_p, m) => {
  const v = b.sources[m.name];
  if (!v) return null;
  if (shape === 'whole') return { rate: v.rate, channels: v.data.length, data: v.data };
  return { rate: v.rate, channels: v.data.length, length: v.data[0].length, read: async (a, z) => v.data.map((c) => { const o = new Float32Array(Math.max(0, z - a)); const lo = Math.max(0, a); const hi = Math.min(c.length, z); if (hi > lo) o.set(c.subarray(lo, hi), lo - a); return o; }) };
};
// The mix of samples [s0, s0 + total) in blocks of the given sizes (in turn), each block mixed once loaded.
export async function mix(name, s0, total, blocks, shape = 'reader', masterGain = 0) {
  const b = project(name);
  const mixer = ae.createMixer({ rate: 48000, getAudio: getAudioOf(b, shape) });
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let missing = 0;
  for (let at = 0, k = 0; at < total; k++) {
    const n = Math.min(total - at, blocks[k % blocks.length]);
    const m = await mixer.mixLoaded(b.h.project, b.s, s0 + at, n, { masterGain });
    missing += m.missing;
    L.set(m.out[0], at);
    R.set(m.out[1], at);
    at += n;
  }
  return { out: [out(L), out(R)], missing };
}
// The levels mix() reports for one block.
export async function meters(name, s0, n) {
  const b = project(name);
  const mixer = ae.createMixer({ rate: 48000, getAudio: getAudioOf(b, 'reader') });
  const m = await mixer.mixLoaded(b.h.project, b.s, s0, n);
  return { tracks: m.tracks, master: m.master, rms: m.rms, missing: m.missing };
}
// Milliseconds for the offline mix of `seconds` of a project (the best of `rounds`), sources in memory.
export async function timeMix(name, seconds, rounds) {
  const b = project(name);
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    await ae.renderOffline(b.h.project, b.s, 0, seconds * SEC, 48000, { getAudio: getAudioOf(b, 'reader') });
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}
// An 8-track project for the benchmark: a minute of sound on each track, effects on every other clip.
BUILDERS.bench = () => {
  const b = start([['a', 70, 48000], ['b', 70, 44100], ['c', 70, 48000, 1]]);
  for (let i = 0; i < 6; i++) b.h.do(C.addTrack(b.s, 'audio'));
  for (let t = 0; t < 8; t++) {
    const track = `A${t + 1}`;
    for (let k = 0; k < 3; k++) {
      const id = put(b, b.ids[(t + k) % 3], { at: k * 20, inS: k * 3 + t * 0.5, outS: k * 3 + t * 0.5 + 20, track });
      b.h.do(C.setKeyframes(b.s, id, 'volume', [lin(0, -6), lin(10, 0)]));
      if ((t + k) % 2 === 0) {
        b.h.do(C.addEffect(b.s, id, 'audio.eq', null, { b2Gain: 4, hsGain: -3 }));
        b.h.do(C.addEffect(b.s, id, 'audio.compressor', null, { threshold: -24 }));
      }
      if (t === 7 && k === 1) b.h.do(C.addEffect(b.s, id, 'audio.limiter', null, { truePeak: true }));
    }
  }
  return b;
};

// Milliseconds (the best of `rounds`) for the waveform peaks, the resampler and the loudness meter on `seconds` of
// the scenario's stereo sound.
const thumbs = require(path.join(CUT, 'thumbs.js'));
function best(rounds, fn) {
  let b = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    fn();
    b = Math.min(b, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return b;
}
export function timeDsp(seconds, rounds) {
  const x48 = sound(seconds, 48000, 1);
  const x44 = sound(seconds, 44100, 2);
  return {
    peaks: best(rounds, () => { for (let a = 0; a < x48[0].length; a += 480000) thumbs.computePeaks(x48.map((c) => c.subarray(a, a + 480000)), 256); }),
    resample: best(rounds, () => ae.resample(x44, 44100, 48000)),
    loudness: best(rounds, () => ae.loudness(x48, 48000)),
    stretch: best(rounds, () => ae.stretch(x48, 0.5, 48000)),
  };
}
