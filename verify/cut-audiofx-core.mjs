// Nano Studio Cut's clip audio effects (renderer/features/cut/audiofx.js) and their place in the mixer, in plain Node:
// - every filter's frequency response at chosen frequencies against the analog theory (Butterworth high- and low-pass
//   of 12, 24 and 48 dB/octave, shelves, peaking bands, the hum notches), measured by running sines through the
//   processor, and the EQ graph's response() against those measurements; the default EQ passes the signal unchanged;
// - the compressor's static curve (hard and soft knee, makeup) on steady levels, and its attack and release times on
//   level steps; the hard limiter never above its ceiling (with and without true peak), transparent below it and
//   recovering with its release; the noise gate starting closed, opening, holding and closing to its range;
// - the mixer: a clip with an EQ (keyframed), a compressor, a gain stage, a gate, a limiter and a DeHummer mixed in
//   one block, in many small blocks of random sizes, and from the middle gives the same samples; the same against one
//   continuous run of the chain (the segments' warm-up and cross-fades leave no seam); effect order and the on switch.
// Usage: node verify/cut-audiofx-core.mjs   (CUT_SRC_DIR=<dir> tests a copy of renderer/features/cut)
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const dir = process.env.CUT_SRC_DIR ? path.resolve(process.env.CUT_SRC_DIR) + path.sep : '../renderer/features/cut/';
const time = require(`${dir}time.js`);
const model = require(`${dir}model.js`);
const C = require(`${dir}commands.js`);
const fx = require(`${dir}effects.js`);
const afx = require(`${dir}audiofx.js`);
const ae = require(`${dir}audioengine.js`);

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok || process.env.VERBOSE) console.log(`${ok ? "ok  " : "FAIL"} ${label}`); };
const near = (a, b, eps, label) => check(Math.abs(a - b) <= eps, `${label} (${typeof a === 'number' ? a.toFixed(4) : a} vs ${typeof b === 'number' ? b.toFixed(4) : b}, within ${eps})`);
const FS = 48000;
const SEC = time.TICKS;
const db = (x) => 20 * Math.log10(x);
const params = (type, over = {}) => ({ ...fx.defaults(type), ...over });
const dspOf = (type) => fx.get(type).dsp;

// A sine through a processor: the gain in dB at f, from the amplitude fitted over the last whole periods of 1 s.
function measured(type, over, f, seconds = 1) {
  const n = Math.round(seconds * FS);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * f * i) / FS);
  const [y] = afx.processBuffer(dspOf(type), params(type, over), [x, x], FS);
  const period = FS / f;
  const len = Math.max(1, Math.floor((n * 0.5) / period)) * period;
  const from = Math.floor(n - len);
  let sc = 0;
  let cc = 0;
  for (let i = from; i < n; i++) { sc += y[i] * Math.sin((2 * Math.PI * f * i) / FS); cc += y[i] * Math.cos((2 * Math.PI * f * i) / FS); }
  const amp = (2 / (n - from)) * Math.hypot(sc, cc);
  return db(amp / 0.25);
}
// Analog theory.
const butterworth = (f, fc, order, high) => -10 * Math.log10(1 + (high ? fc / f : f / fc) ** (2 * order));
// RBJ's analog shelf and peaking prototypes at s = j f / f0 (Q as in the cookbook).
function prototype(kind, f, f0, gainDb, Q) {
  const A = 10 ** (gainDb / 40);
  const w = f / f0;
  const c = (re, im) => ({ re, im });
  const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
  const mag = (z) => 20 * Math.log10(Math.hypot(z.re, z.im));
  const s2 = -w * w; // (jw)^2
  if (kind === 'peaking') return mag(div(c(s2 + 1, (w * A) / Q), c(s2 + 1, w / (A * Q))));
  if (kind === 'cut') { const k = 1 - 10 ** (gainDb / 20); const bp = div(c(0, w / Q), c(s2 + 1, w / Q)); return mag(c(1 - k * bp.re, -k * bp.im)); }
  const r = Math.sqrt(A) / Q;
  if (kind === 'lowshelf') return mag(div(c(A * (s2 + A), A * r * w), c(A * s2 + 1, r * w)));
  return mag(div(c(A * (A * s2 + 1), A * r * w), c(s2 + A, r * w))); // highshelf
}

// ---- filters ---------------------------------------------------------------------------------------------------
{
  const eq = 'audio.eq';
  const off = { lsOn: false, b1On: false, b2On: false, b3On: false, hsOn: false };
  for (const [slope, order] of [['12', 2], ['24', 4], ['48', 8]]) {
    for (const f of [25, 50, 100, 200, 1000]) {
      near(measured(eq, { ...off, hpOn: true, hpFreq: 100, hpSlope: slope }, f, 2), butterworth(f, 100, order, true), 0.1, `high-pass 100 Hz ${slope} dB/oct at ${f} Hz`);
    }
  }
  for (const [slope, order] of [['12', 2], ['24', 4]]) {
    for (const f of [250, 500, 1000, 2000]) near(measured(eq, { ...off, lpOn: true, lpFreq: 1000, lpSlope: slope }, f), butterworth(f, 1000, order, false), 0.15, `low-pass 1 kHz ${slope} dB/oct at ${f} Hz`);
  }
  near(measured(eq, { ...off, hpOn: true, hpFreq: 100 }, 100, 2), -3.01, 0.05, 'a Butterworth high-pass is -3 dB at its corner');
  for (const f of [20, 50, 100, 200, 500, 2000]) near(measured(eq, { ...off, lsOn: true, lsFreq: 100, lsGain: 6 }, f, 2), prototype('lowshelf', f, 100, 6, Math.SQRT1_2), 0.1, `low shelf +6 dB at 100 Hz, at ${f} Hz`);
  near(measured(eq, { ...off, lsOn: true, lsFreq: 100, lsGain: 6 }, 100, 2), 3, 0.05, 'a shelf is half its gain at its frequency');
  for (const f of [200, 1000, 4000, 8000]) near(measured(eq, { ...off, hsOn: true, hsFreq: 8000, hsGain: -6 }, f), f < 8000 ? prototype('highshelf', f, 8000, -6, Math.SQRT1_2) : -3, 0.15, `high shelf -6 dB at 8 kHz, at ${f} Hz`);
  for (const [g, q] of [[6, 2], [-18, 1], [12, 0.7]]) {
    for (const f of [250, 500, 1000, 2000]) near(measured(eq, { ...off, b2On: true, b2Freq: 1000, b2Gain: g, b2Q: q }, f), prototype('peaking', f, 1000, g, q), 0.1, `peaking ${g} dB Q ${q} at 1 kHz, at ${f} Hz`);
  }
  near(measured(eq, { ...off, b2On: true, b2Freq: 1000, b2Gain: -18, b2Q: 1, output: 4 }, 1000), -14, 0.05, 'the output gain adds to the bands');
  // The defaults (every band on at 0 dB) and every band off pass the signal bit for bit.
  const n = 9600;
  const x = new Float64Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; x[i] = seed / 2 ** 32 - 0.5; }
  const same = (y) => y.every((v, i) => v === x[i]);
  check(same(afx.processBuffer('eq', fx.defaults(eq), [x, x], FS)[0]), 'the equalizer at its defaults passes noise unchanged, bit for bit');
  check(same(afx.processBuffer('bass', fx.defaults('audio.bass'), [x, x], FS)[0]) && same(afx.processBuffer('treble', fx.defaults('audio.treble'), [x, x], FS)[0]), 'bass and treble at 0 dB pass it unchanged');
  for (const f of [30, 200]) near(measured('audio.bass', { boost: 6 }, f, 2), prototype('lowshelf', f, afx.BASS_HZ, 6, Math.SQRT1_2), 0.1, `bass +6 dB at ${f} Hz`);
  near(measured('audio.bass', { boost: 6 }, 5000), 0, 0.1, 'bass leaves 5 kHz alone');
  for (const f of [200, 4000]) near(measured('audio.treble', { boost: -6 }, f), f === 4000 ? -3 : prototype('highshelf', f, afx.TREBLE_HZ, -6, Math.SQRT1_2), 0.1, `treble -6 dB at ${f} Hz`);
  for (const [freq, hs] of [['60', [60, 120, 180, 240]], ['50', [50, 100, 150, 200]]]) {
    for (const f of hs) near(measured('audio.dehum', { frequency: freq, harmonics: 4, reduction: 30, Q: 20 }, f, 2), -30, 0.3, `DeHummer ${freq} Hz removes 30 dB at ${f} Hz`);
  }
  for (const f of [55, 65, 90]) near(measured('audio.dehum', { frequency: '60', harmonics: 4, reduction: 30, Q: 20 }, f, 2), prototype('cut', f, 60, -30, 20), 0.15, `DeHummer's 60 Hz notch at ${f} Hz is as narrow as its Q`);
  near(measured('audio.dehum', { frequency: '60', harmonics: 4, reduction: 30, Q: 20 }, 90, 2), 0, 0.2, 'DeHummer leaves 90 Hz between the harmonics');
  near(measured('audio.dehum', { frequency: '60', harmonics: 4, reduction: 30, Q: 20 }, 300, 2), 0, 0.2, 'DeHummer with 4 harmonics leaves the 5th (300 Hz)');
  // The graph of the effect controls draws what the processor does.
  const pe = { ...off, hpOn: true, hpFreq: 60, hpSlope: '24', b1On: true, b1Freq: 300, b1Gain: 5, b1Q: 1.4, b3On: true, b3Freq: 3000, b3Gain: -9, b3Q: 3, hsOn: true, hsFreq: 9000, hsGain: 4, output: -2 };
  const fr = [40, 300, 1000, 3000, 12000];
  const graph = afx.response('eq', params(eq, pe), fr, FS);
  check(fr.every((f, i) => Math.abs(graph[i] - measured(eq, pe, f, 2)) < 0.1), `the EQ graph's response() matches the processor (${graph.map((v) => v.toFixed(2)).join(', ')} dB)`);
}

// ---- dynamics --------------------------------------------------------------------------------------------------
const constant = (pieces) => { // [[seconds, linear level]] -> a stepped DC signal
  const out = [];
  for (const [s, v] of pieces) for (let i = 0; i < Math.round(s * FS); i++) out.push(v);
  return Float64Array.from(out);
};
const lin = (d) => 10 ** (d / 20);
{
  const comp = (over) => params('audio.compressor', { threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, makeup: 0, ...over });
  const level = (over, inDb) => {
    const x = constant([[0.5, lin(inDb)]]);
    const [y] = afx.processBuffer('compressor', comp(over), [x, x], FS);
    return db(y[y.length - 1]);
  };
  for (const [i, o] of [[-40, -40], [-20, -20], [-10, -17.5], [0, -15]]) near(level({}, i), o, 0.01, `compressor 4:1 at -20 dB: ${i} dB in is ${o} dB out`);
  near(level({ ratio: 2 }, 0), -10, 0.01, 'compressor 2:1: 0 dB in is -10 dB out');
  near(level({ knee: 6 }, -20), -20 - (0.75 * 6) / 8, 0.01, 'a 6 dB soft knee at the threshold: 0.56 dB of reduction');
  near(level({ knee: 6 }, -17), -20 + 3 / 4, 0.01, 'the knee joins the 4:1 line at its edge');
  near(level({ knee: 6 }, -26), -26, 0.01, 'and leaves levels below the knee alone');
  near(level({ makeup: 5 }, 0), -10, 0.01, 'makeup gain lifts the output');
  check(Math.abs(afx.compressCurve(-10, -20, 4, 0) + 17.5) < 1e-9, 'compressCurve is the static curve');
  // Attack and release: the reduction reaches 1 - 1/e of a step in the attack time and falls to 1/e in the release.
  const step = (attack, release) => {
    const x = constant([[0.2, lin(-40)], [0.5, lin(-10)], [1.5, lin(-40)]]);
    const [y] = afx.processBuffer('compressor', comp({ attack, release }), [x, x], FS);
    const red = (i) => db(x[i]) - db(y[i]);
    const on = Math.round(0.2 * FS);
    const offAt = Math.round(0.7 * FS);
    const full = 7.5;
    let a = on;
    while (red(a) < full * (1 - Math.exp(-1))) a++;
    let r = offAt;
    while (red(r) > full * Math.exp(-1)) r++;
    return { attackMs: ((a - on) / FS) * 1000, releaseMs: ((r - offAt) / FS) * 1000, settled: red(offAt - 1) };
  };
  const t1 = step(20, 200);
  near(t1.settled, 7.5, 0.01, 'a -10 dB step settles at 7.5 dB of reduction');
  near(t1.attackMs, 20, 0.1, `attack 20 ms: 63% of the reduction after ${t1.attackMs.toFixed(2)} ms`);
  near(t1.releaseMs, 200, 0.5, `release 200 ms: down to 37% after ${t1.releaseMs.toFixed(2)} ms`);
  const t2 = step(2, 50);
  near(t2.attackMs, 2, 0.05, `attack 2 ms (${t2.attackMs.toFixed(3)} ms)`);
  near(t2.releaseMs, 50, 0.2, `release 50 ms (${t2.releaseMs.toFixed(3)} ms)`);
}
{
  // Noise with bursts up to +12 dBFS.
  const n = 5 * FS;
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < n; i++) {
    const burst = (i % FS) < FS / 5 ? 8 : 0.6;
    L[i] = burst * rnd() * Math.sin(i / 7);
    R[i] = burst * Math.sin((2 * Math.PI * 3150 * i) / FS + 0.3) * (0.5 + 0.5 * Math.sin(i / 900));
  }
  const peak = (ch) => Math.max(...ch.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
  for (const truePeak of [false, true]) {
    for (const ceiling of [-1, -6]) {
      const [yl, yr] = afx.processBuffer('limiter', params('audio.limiter', { ceiling, release: 30, truePeak }), [L, R], FS);
      check(peak([yl, yr]) <= lin(ceiling) * (1 + 1e-12), `hard limiter ceiling ${ceiling} dB${truePeak ? ' (true peak)' : ''}: no sample above it (${db(peak([yl, yr])).toFixed(3)} dB from ${db(peak([L, R])).toFixed(1)} dB)`);
      // by a gain that moves smoothly (a line over the look-ahead, then the release), not by clipping the peaks
      let jump = 0;
      let prev = null;
      for (let i = 0; i < n; i++) {
        if (Math.abs(R[i]) < 0.05) { prev = null; continue; }
        const g = yr[i] / R[i];
        if (prev != null) jump = Math.max(jump, Math.abs(g - prev));
        prev = g;
      }
      check(jump < 0.02, `and by a smooth gain, not by clipping (largest gain step ${jump.toFixed(4)} a sample)`);
      if (ceiling === -1) {
        const tp = ae.loudness([Float32Array.from(yl), Float32Array.from(yr)], FS).truePeak;
        if (truePeak) check(tp <= ceiling + 0.3, `with true peak on, the 4x true peak stays within 0.3 dB of the ceiling (${tp.toFixed(2)} dBTP)`);
        else check(tp > ceiling, `without it, the true peak goes over (${tp.toFixed(2)} dBTP): the option matters`);
      }
    }
  }
  // Below the ceiling the limiter passes the signal unchanged, on time (its look-ahead taken out).
  const quiet = [L.map((v) => v * 0.05), R.map((v) => v * 0.05)];
  const [ql, qr] = afx.processBuffer('limiter', params('audio.limiter', { ceiling: -1 }), quiet, FS);
  check(ql.every((v, i) => Math.abs(v - quiet[0][i]) < 1e-15) && qr.every((v, i) => Math.abs(v - quiet[1][i]) < 1e-15), 'below the ceiling the limiter passes the signal unchanged and on time');
  // After a burst the gain comes back with the release time.
  const x = constant([[0.1, 2], [1, 0.5]]);
  const [y] = afx.processBuffer('limiter', params('audio.limiter', { ceiling: -1, release: 50 }), [x, x], FS);
  const g = (s) => y[Math.round(s * FS)] / x[Math.round(s * FS)];
  near(db(g(0.05)), -1 - db(2), 0.01, 'a +6 dB level is held at the ceiling');
  check(g(0.1 + 0.05) < 0.95 * lin(0) && g(0.1 + 0.05) > lin(-1 - db(2)), `50 ms after it the gain is coming back (${db(g(0.15)).toFixed(2)} dB)`);
  near(db(g(0.1 + 0.4)), 0, 0.01, '400 ms after it the gain is back to 0 dB');
}
{
  const gp = (over) => params('audio.gate', { threshold: -40, attack: 1, hold: 50, release: 20, range: 40, ...over });
  const x = constant([[0.3, lin(-70)], [0.5, lin(-12)], [1, lin(-70)]]);
  const [y] = afx.processBuffer('gate', gp({}), [x, x], FS);
  const g = (s) => db(y[Math.round(s * FS)] / x[Math.round(s * FS)]);
  near(g(0.01), -40, 0.01, 'the gate starts closed: the range below');
  near(g(0.29), -40, 0.01, 'and stays closed under the threshold');
  near(g(0.3 + 0.01), 0, 0.01, 'it opens within 10 attack times of the level crossing the threshold');
  near(g(0.79), 0, 1e-6, 'it stays open while the level is above');
  // The 5 ms follower takes 16 ms to fall from -12 to -40 dB; then the 50 ms hold; then the release.
  near(g(0.8 + 0.05), 0, 1e-6, 'it holds open just after the level drops');
  check(g(0.8 + 0.016 + 0.05 + 0.02) < -6, `then closes with the release (${g(0.886).toFixed(2)} dB 20 ms into it)`);
  near(g(0.8 + 0.016 + 0.05 + 0.25), -40, 0.05, 'down to the range');
  const [y2] = afx.processBuffer('gate', gp({ hold: 0 }), [x, x], FS);
  const at876 = (arr) => db(arr[Math.round(0.876 * FS)] / x[Math.round(0.876 * FS)]);
  check(at876(y2) < -20 && at876(y) > -10, `without hold it closes sooner (${at876(y2).toFixed(1)} dB against ${at876(y).toFixed(1)} dB with 50 ms)`);
  const [y3] = afx.processBuffer('gate', gp({ range: 12 }), [x, x], FS);
  near(db(y3[Math.round(1.5 * FS)] / x[Math.round(1.5 * FS)]), -12, 0.01, 'range 12 dB closes to -12 dB');
}
{
  // A processor's result does not depend on the length of the calls it is given.
  const n = FS;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.9 * Math.sin(i / 13) * Math.sin(i / 2000) + 0.3 * Math.sin((2 * Math.PI * 60 * i) / FS);
  const odd = [1, 7, 333, 32, 4096, 5, 1000];
  for (const [type, over] of [['audio.eq', { b2Gain: 9, hpOn: true }], ['audio.compressor', {}], ['audio.limiter', { ceiling: -6, truePeak: true }], ['audio.gate', { threshold: -20 }], ['audio.dehum', {}]]) {
    const a = afx.processBuffer(dspOf(type), params(type, over), [x, x], FS);
    const b = afx.processBuffer(dspOf(type), params(type, over), [x, x], FS, { blocks: odd });
    check(a[0].every((v, i) => v === b[0][i]), `${type}: the same samples processed in calls of ${odd.join(', ')} samples`);
  }
}

// ---- the mixer -------------------------------------------------------------------------------------------------
const tone = (seconds, rate = FS) => {
  const n = Math.round(seconds * rate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 3;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t);
    const burst = Math.floor(t * 2) % 3 === 0 ? 0.6 : 0.05;
    L[i] = env * (0.3 * Math.sin(2 * Math.PI * 1000 * t) + 0.2 * Math.sin(2 * Math.PI * 60 * t)) + burst * (seed / 2 ** 32 - 0.5);
    R[i] = env * 0.4 * Math.sin(2 * Math.PI * 330 * t + 1) + burst * 0.5 * (seed / 2 ** 32 - 0.5);
  }
  return [L, R];
};
function build(effects, { rate = FS, seconds = 8, start = 0.5, volumeKeys = true } = {}) {
  const project = model.createProject({ sequence: { w: 1280, h: 720, fps: [30, 1] } });
  const h = C.createHistory(project, { limit: Infinity });
  const [m] = h.do(C.importMedia([{ path: 'D:/a/tone.wav', name: 'tone.wav', kind: 'audio', size: 1, mtime: 1, duration: seconds * SEC, video: null, audio: { rate, channels: 2 } }])).ids;
  const s = h.project.sequences[0].id;
  h.do(C.place(s, { source: { media: m }, in: 0.2 * SEC, out: (seconds - 0.5) * SEC, at: start * SEC, video: null, audio: 'A1', mode: 'overwrite' }));
  const clip = h.project.sequences[0].clips[0].id;
  for (const [type, p, keys] of effects) {
    const r = h.do(C.addEffect(s, clip, type, null, p));
    for (const [param, list] of Object.entries(keys || {})) h.do(C.setKeyframes(s, clip, `effects.${r.id}.${param}`, list));
  }
  if (volumeKeys) h.do(C.setKeyframes(s, clip, 'volume', [{ t: 0, v: -3, ease: 'linear' }, { t: 3 * SEC, v: 2, ease: 'linear' }]));
  h.do(C.setClip(s, clip, { fadeIn: 0.25 * SEC, fadeOut: 0.5 * SEC }));
  return { h, s, clip };
}
const src = tone(8);
const store = (rate = FS) => (rate === FS ? src : tone(8, rate));
// The default getAudio shape: read on demand in blocks.
const reader = (rate = FS, data = null) => async () => { const d = data || store(rate); return { rate, length: d[0].length, read: async (a, b) => d.map((c) => c.slice(Math.max(0, a), Math.min(c.length, b))) }; };
async function mixAll(b, blocks, { rate = FS, from = 0, to = 8.5, data = null } = {}) {
  const mixer = ae.createMixer({ rate: FS, getAudio: reader(rate, data) });
  const s0 = Math.round(from * FS);
  const total = Math.round(to * FS) - s0;
  const out = [new Float32Array(total), new Float32Array(total)];
  let at = 0;
  let k = 0;
  while (at < total) {
    const n = Math.min(total - at, blocks[k++ % blocks.length]);
    const m = await mixer.mixLoaded(b.h.project, b.s, s0 + at, n);
    if (m.missing) throw new Error(`missing at ${s0 + at}`);
    out[0].set(m.out[0], at);
    out[1].set(m.out[1], at);
    at += n;
  }
  return out;
}
const maxDiff = (a, b, off = 0) => { let d = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < b[c].length; i++) d = Math.max(d, Math.abs(a[c][i + off] - b[c][i])); return d; };
const CHAIN = [
  ['audio.eq', { hpOn: true, hpFreq: 40, hpSlope: '24', b2Freq: 1000, b2Gain: -12, b2Q: 2 }, { b2Gain: [{ t: 0, v: -12, ease: 'linear' }, { t: 4 * SEC, v: 6, ease: 'linear' }] }],
  ['audio.compressor', { threshold: -24, ratio: 3, attack: 5, release: 120, makeup: 4 }],
  ['audio.gain', { gain: 3 }],
  ['audio.gate', { threshold: -45, hold: 30 }],
  ['audio.limiter', { ceiling: -3, release: 40, truePeak: true }],
  ['audio.dehum', { frequency: '60', harmonics: 3 }],
];
{
  const b = build(CHAIN);
  const whole = await mixAll(b, [Infinity]);
  let seed = 11;
  const sizes = Array.from({ length: 64 }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return 1 + (seed % 3000); });
  const small = await mixAll(b, sizes);
  check(maxDiff(whole, small) === 0, `a clip with EQ (keyframed), compressor, gain, gate, limiter and DeHummer: one block and blocks of 1..3000 samples give the same samples (max difference ${maxDiff(whole, small)})`);
  const preview = await mixAll(b, [2048]);
  check(maxDiff(whole, preview) === 0, 'and the preview\'s 2048-sample blocks too');
  const middle = await mixAll(b, [2048], { from: 3.3 });
  check(maxDiff(whole, middle, Math.round(3.3 * FS)) === 0, `started from 3.3 s (a seek), the same samples there (max difference ${maxDiff(whole, middle, Math.round(3.3 * FS))})`);
  const peakOut = Math.max(...whole.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
  check(peakOut > 0.05 && peakOut <= lin(-3) * 1.0001 * lin(2), `the chain is heard (peak ${db(peakOut).toFixed(2)} dB: the limiter's -3 dB, the volume keyframe's +2 dB after it)`);
  // 44.1 kHz source: resampled blocks, the same in any block size.
  const w44 = await mixAll(b, [Infinity], { rate: 44100 });
  const s44 = await mixAll(b, sizes, { rate: 44100 });
  check(maxDiff(w44, s44) === 0, 'from a 44.1 kHz source too');
}
// Against one continuous run of the chain over the whole clip (no segments). The clip plays at 0 dB without fades so
// the mix is the chain's output. -> {worst, worstAt, step}: the largest difference, where, and the largest change of
// the difference from one sample to the next (a seam would be a step).
async function againstOneRun(chain, data = src) {
  const b = build(chain, { volumeKeys: false });
  b.h.do(C.setClip(b.s, b.clip, { fadeIn: 0, fadeOut: 0 }));
  const mix = await mixAll(b, [4800], { data });
  const clip = b.h.project.sequences[0].clips[0];
  const a0 = Math.round(clip.start / (SEC / FS));
  const n = Math.round(model.clipDuration(clip) / (SEC / FS));
  const inS = Math.round(clip.in / (SEC / FS));
  const stages = chain.map(([type, p]) => ({ proc: afx.processors[fx.get(type).dsp], base: fx.resolve(type, p) }));
  const run = afx.createChain(stages, FS);
  const L = new Float64Array(n + run.latency);
  const R = new Float64Array(n + run.latency);
  for (let i = 0; i < n; i++) { L[i] = data[0][inS + i]; R[i] = data[1][inS + i]; }
  run.process(L, R, n + run.latency, { paramsAt: (k) => stages[k].base, secondsAt: () => 0 });
  let worst = 0;
  let worstAt = 0;
  let step = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const e = mix[0][a0 + i] - L[i + run.latency];
    const d = Math.max(Math.abs(e), Math.abs(mix[1][a0 + i] - R[i + run.latency]));
    if (d > worst) { worst = d; worstAt = i; }
    if (i) step = Math.max(step, Math.abs(e - prev));
    prev = e;
  }
  return { worst, worstAt: worstAt / FS, step };
}
{
  const r = await againstOneRun([CHAIN[0].slice(0, 2), CHAIN[1], CHAIN[4]]);
  check(r.worst < 1e-5, `the segmented chain matches one continuous run within -100 dB everywhere (worst ${db(r.worst).toFixed(1)} dB at ${r.worstAt.toFixed(3)} s into the clip)`);
  // A compressor releasing over 2 s remembers more than the longest warm-up (audiofx.MAX_MEMORY): after a loud second
  // it still releases 6 s later, so a segment that starts from fresh state starts off the continuous run; the
  // cross-fade makes that a slow drift, never a step.
  const loudThenQuiet = [0, 1].map((c) => Float32Array.from({ length: 8 * FS }, (_, i) => (i < FS ? 0.9 : 0.03) * Math.sin((2 * Math.PI * (300 + 200 * c) * i) / FS)));
  const slow = await againstOneRun([['audio.compressor', { threshold: -40, ratio: 10, attack: 1, release: 2000 }]], loudThenQuiet);
  check(slow.worst > 1e-4, `with a 2 s release the segments differ a little from one run (worst ${db(slow.worst).toFixed(1)} dB at ${slow.worstAt.toFixed(3)} s)`);
  // (the difference rides on a 300 and a 500 Hz sine, which move it about 7% of its size a sample)
  check(slow.step < slow.worst / 10, `but the difference moves smoothly: no step where segments join (largest change ${db(slow.step).toFixed(1)} dB a sample against ${db(slow.worst).toFixed(1)} dB)`);
}
{
  // Order and the on switch.
  const gc = await mixAll(build([['audio.gain', { gain: 12 }], ['audio.compressor', { threshold: -30, ratio: 8 }]], { volumeKeys: false }), [Infinity]);
  const cg = await mixAll(build([['audio.compressor', { threshold: -30, ratio: 8 }], ['audio.gain', { gain: 12 }]], { volumeKeys: false }), [Infinity]);
  check(maxDiff(gc, cg) > 0.05, `a gain before a compressor is not the same as after it (${maxDiff(gc, cg).toFixed(3)})`);
  const b = build([['audio.eq', { b2Gain: -24 }]], { volumeKeys: false });
  const on = await mixAll(b, [Infinity]);
  b.h.do(C.setEffect(b.s, b.clip, b.h.project.sequences[0].clips[0].effects[0].id, { on: false }));
  const offMix = await mixAll(b, [Infinity]);
  const plain = await mixAll(build([], { volumeKeys: false }), [Infinity]);
  check(maxDiff(offMix, plain) === 0 && maxDiff(on, plain) > 0.01, 'an effect switched off leaves the clip as it is without it');
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
