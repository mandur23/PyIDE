// Nano Studio Cut's signal analysis (renderer/features/cut/analyze.js) in plain Node, on synthetic signals:
// - levels of a tone with gaps (and a noise floor), streamed in odd blocks, the silences cut out with a minimum
//   length and margins on frames, and the speech left for ducking;
// - click tracks at known tempos (with an accent on every fourth beat): the tempo, every beat time and the bar phase;
// - small frames with a hard cut and a white flash: the cut found on its exact frame, the flash ignored;
// - auto colour: a warm, dark picture made neutral and mid-grey through the engine's own color.basic math;
// - ducking keyframes with ramps, joined dips and existing keyframes;
// - the range helpers and the source-to-timeline mapping of clips with speed and reverse;
// - the file as a page script next to an AMD `require` (Monaco's loader.js), in index.js order.
// Usage: node verify/cut-analyze.mjs
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import vm from 'vm';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const kf = require('../renderer/features/cut/keyframes.js');
const fx = require('../renderer/features/cut/effects.js');
const A = require('../renderer/features/cut/analyze.js');

const S = JSON.stringify;
const results = [];
const pending = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const T = time.TICKS;
const F = time.frameTicks([30, 1]);
const secs = (list) => list.map(([a, b]) => [+(a / T).toFixed(4), +(b / T).toFixed(4)]);
const section = (name, fn) => { try { fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } };
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ---------- ranges and clip time ----------
section('ranges', () => {
  eq(A.union([[5, 6], [1, 3], [2, 4], [6, 7], [9, 9]]), [[1, 4], [5, 7]], 'union joins overlapping and touching ranges and drops empty ones');
  eq(A.subtract([[0, 10], [20, 30]], [[2, 3], [8, 22], [25, 40]]), [[0, 2], [3, 8], [22, 25]], 'subtract leaves what the cuts do not cover');
  eq(A.intersect([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]], 'intersect keeps what both cover');
  eq(A.total([[1, 4], [5, 7]]), 5, 'total adds the lengths');
  const clip = { ...model.createClip('audio', { id: 'c1', track: 'A1', start: 10 * T, in: 5 * T, out: 15 * T, source: { media: 'm1' } }), speed: 2 };
  eq([A.toTimeline(clip, 7 * T) / T, A.toTimeline(clip, 15 * T) / T, A.toTimeline(clip, 1 * T) / T], [11, 15, 10], 'a clip at double speed shows source 7 s at 11 s; times outside it clamp to its edges');
  const rev = { ...clip, reverse: true };
  eq(secs(A.rangesToTimeline(rev, [[6 * T, 8 * T]])), [[13.5, 14.5]], 'a reversed clip maps a source range backwards');
  eq(A.toTimeline({ ...clip, source: { media: 'm1', freeze: true } }, 7 * T), null, 'a freeze frame maps no source time');
  eq(A.sourceSpan(clip).map((x) => x / T), [5, 15], 'the source span of a clip');
});

// ---------- levels and silences ----------
section('levels', () => {
  const rate = 48000;
  const n = 10 * rate;
  const gaps = [[2, 3], [5, 5.3], [7, 8.2]];
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const gap = gaps.some(([x, y]) => t >= x && t < y);
    // the gaps hold a noise floor near -60 dBFS
    a[i] = gap ? (rnd() - 0.5) * 0.0035 : 0.3 * Math.sin(2 * Math.PI * 1000 * t);
    b[i] = gap ? 0 : 0.1 * Math.sin(2 * Math.PI * 440 * t);
  }
  const one = A.levels([a, b], rate, 0.01);
  check(one.levels.length === 1000 && Math.abs(one.step - 0.01) < 1e-12, `10 s give 1,000 windows of 10 ms (${one.levels.length})`);
  check(Math.abs(one.levels[50] - 20 * Math.log10(0.3 / Math.SQRT2)) < 0.05, `a 0.3 sine reads its RMS, the louder channel (${one.levels[50].toFixed(2)} dBFS)`);
  check(one.levels[250] < -55 && one.levels[250] > -70, `the noise floor in a gap reads near -60 dBFS (${one.levels[250].toFixed(1)})`);
  const meter = A.levelMeter(rate, 0.01);
  for (let i = 0; i < n;) {
    const len = 1 + Math.floor(rnd() * 9000);
    meter.push([a.subarray(i, i + len), b.subarray(i, i + len)]);
    i += len;
  }
  const streamed = meter.levels();
  let worst = 0;
  for (let i = 0; i < streamed.length; i++) worst = Math.max(worst, Math.abs(streamed[i] - one.levels[i]));
  check(streamed.length === one.levels.length && worst < 1e-3, `levels streamed in odd blocks equal the levels at once (max diff ${worst.toExponential(1)})`);
  const zero = A.levels([new Float32Array(480)], rate).levels[0];
  eq(zero, A.QUIET, 'digital silence reads QUIET, not -Infinity');

  const loud = A.loudRanges(one.levels, one.step, -40).map(([x, y]) => [x * T, y * T]);
  eq(secs(loud), [[0, 2], [3, 5], [5.3, 7], [8.2, 10]], 'the loud windows over -40 dBFS are the tone');
  const cuts = A.silenceRanges([[0, 10 * T]], loud, { minLength: 0.5 * T, margin: 0.1 * T, frame: F });
  eq(secs(cuts), [[2.1, 2.9], [7.1, 8.1]], 'silences of 0.5 s and more are cut, 0.1 s kept on both sides, on frames; the 0.3 s gap stays');
  check(cuts.every(([x, y]) => x % F === 0 && y % F === 0), 'every cut starts and ends on a frame');
  const strict = A.silenceRanges([[0, 10 * T]], A.loudRanges(one.levels, one.step, -70).map(([x, y]) => [x * T, y * T]), { minLength: 0.5 * T, margin: 0.1 * T, frame: F });
  eq(secs(strict), [], 'at -70 dBFS the noise floor counts as sound: nothing is cut');
  const short = A.silenceRanges([[0, 10 * T]], loud, { minLength: 0.25 * T, margin: 0, frame: F });
  eq(secs(short), [[2, 3], [5, 5.3], [7, 8.2]], 'with a 0.25 s minimum and no margin the short gap goes too');
  const spans = [[0, 4 * T], [6 * T, 9 * T]];
  eq(secs(A.silenceRanges(spans, loud, { minLength: 0.5 * T, margin: 0.1 * T, frame: F })), [[2.1, 2.9], [7.1, 8.1]], 'only the parts of the spans count');
  eq(secs(A.speechRanges([[0, 10 * T]], loud, { hold: 0.5 * T })), [[0, 2], [3, 7], [8.2, 10]], 'speech: pauses shorter than the hold stay speech');
});

// ---------- onsets, tempo, beats ----------
function clickTrack({ bpm, seconds, rate = 22050, offset = 0.25, accent = true, noise = 0 }) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const period = 60 / bpm;
  const clicks = [];
  for (let k = 0; offset + k * period < seconds - 0.05; k++) {
    const at = offset + k * period;
    clicks.push(at);
    const amp = accent && k % 4 === 0 ? 0.9 : 0.35;
    const s0 = Math.round(at * rate);
    for (let i = 0; i < 0.03 * rate && s0 + i < n; i++) out[s0 + i] += amp * Math.exp(-i / (0.006 * rate)) * Math.sin((2 * Math.PI * 2000 * i) / rate);
  }
  if (noise) for (let i = 0; i < n; i++) out[i] += (rnd() - 0.5) * noise;
  return { samples: out, clicks, rate };
}
section('beats', () => {
  for (const [bpm, label] of [[120, '120 BPM'], [90, '90 BPM'], [140, '140 BPM with noise']]) {
    const tr = clickTrack({ bpm, seconds: 40, noise: bpm === 140 ? 0.02 : 0 });
    const flux = A.createFlux(tr.rate, { size: 1024, hop: 256 });
    for (let i = 0; i < tr.samples.length; i += 3001) flux.push(tr.samples.subarray(i, i + 3001));
    const r = A.beats(flux, flux.envelope());
    check(Math.abs(r.bpm - bpm) < 0.3, `${label}: the tempo is ${r.bpm.toFixed(2)}`);
    // every click has a beat within 12 ms (a 30 fps frame is 33 ms) and there is no extra beat
    let worst = 0;
    let missed = 0;
    for (const c of tr.clicks) {
      const d = Math.min(...r.beats.map((b) => Math.abs(b - c)));
      if (d > 0.012) missed++;
      worst = Math.max(worst, d);
    }
    check(missed === 0 && Math.abs(r.beats.length - tr.clicks.length) <= 1, `${label}: ${r.beats.length} beats for ${tr.clicks.length} clicks, each within ${(worst * 1000).toFixed(1)} ms`);
    const downs = r.beats.filter((_, i) => i % 4 === r.phase);
    const accents = tr.clicks.filter((_, k) => k % 4 === 0);
    const onAccent = downs.filter((b) => accents.some((c) => Math.abs(b - c) < 0.012)).length;
    check(onAccent >= downs.length - 1 && downs.length >= accents.length - 1, `${label}: the bars start on the accented clicks (${onAccent}/${downs.length})`);
  }
  const fft = A.createFft(8);
  const re = Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const im = new Float64Array(8);
  fft(re, im);
  check([...re].every((x) => Math.abs(x - 1) < 1e-12) && [...im].every((x) => Math.abs(x) < 1e-12), 'the FFT of an impulse is flat');
  const quiet = A.createFlux(22050);
  quiet.push(new Float32Array(22050 * 5));
  const none = A.beats(quiet, quiet.envelope());
  check(none.beats.length === 0 || none.confidence === 0, `silence has no beats (${none.beats.length}, confidence ${none.confidence})`);
});

// ---------- scenes ----------
section('scenes', () => {
  const w = 64;
  const h = 36;
  const frame = (k) => {
    const px = new Uint8ClampedArray(w * h * 4);
    const flash = k === 15;
    const sceneB = k >= 31;
    const bg = flash ? [255, 255, 255] : sceneB ? [180, 90, 40] : [30, 42, 58];
    for (let i = 0; i < w * h; i++) px.set([...bg, 255], i * 4);
    // a moving square and a number-like blob that change from frame to frame inside a scene
    const x0 = (k * 3) % (w - 8);
    for (let y = 10; y < 18; y++) for (let x = x0; x < x0 + 8; x++) px.set([235, 235, 235, 255], (y * w + x) * 4);
    for (let y = 24; y < 30; y++) for (let x = 20; x < 20 + (k % 10) * 2; x++) px.set([200, 200, 200, 255], (y * w + x) * 4);
    return px;
  };
  const asked = [];
  const histAt = async (k) => { asked.push(k); return A.histogram(frame(k), w, h); };
  const run = async () => {
    const cuts = await A.detectScenes(0, 59, histAt, { threshold: 0.35, step: 2 });
    eq(cuts, [31], 'the hard cut is found on the first frame of the new scene; the white flash is not a cut');
    check(new Set(asked).size < 45, `stepping two frames reads ${new Set(asked).size} of 60 frames`);
    const d = A.histDistance(A.histogram(frame(3), w, h), A.histogram(frame(4), w, h));
    check(d < 0.1, `frames of one scene are close (${d.toFixed(3)})`);
    const ab = A.histDistance(A.histogram(frame(20), w, h), A.histogram(frame(40), w, h));
    check(ab > 0.8, `frames of two scenes are far apart (${ab.toFixed(3)})`);
    const ctl = new AbortController();
    ctl.abort();
    let code = null;
    try { await A.detectScenes(0, 59, histAt, { signal: ctl.signal }); } catch (err) { code = err.code; }
    eq(code, 'cancelled', 'a cancelled detection stops with code cancelled');
    // A fade in from black (a real 4K stage video gave nine "cuts" in its first half second) and, later, a hard cut.
    const faded = (k) => {
      const px = new Uint8ClampedArray(w * h * 4);
      const f = Math.max(0, Math.min(1, (k - 10) / 16));
      const bg = k >= 60 ? [40, 90, 160] : [200, 190, 170].map((v) => Math.round(v * f));
      for (let i = 0; i < w * h; i++) px.set([...bg, 255], i * 4);
      const x0 = (k * 3) % (w - 8);
      for (let y = 10; y < 18; y++) for (let x = x0; x < x0 + 8; x++) px.set(bg.map((v) => Math.min(255, v + 40)).concat(255), (y * w + x) * 4);
      return px;
    };
    const fadeCuts = await A.detectScenes(0, 89, async (k) => A.histogram(faded(k), w, h), { threshold: 0.35, step: 2 });
    check(fadeCuts.filter((k) => k < 40).length <= 1 && fadeCuts.includes(60) && fadeCuts.length <= 2, `a fade in gives at most one cut, the hard cut after it is still found (${S(fadeCuts)})`);
  };
  pending.push(run().catch((err) => check(false, `scenes: ${err.stack}`)));
});

// ---------- auto colour ----------
section('color', () => {
  const w = 48;
  const h = 27;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const cast = [1.25, 1.0, 0.72]; // within what temperature and tint can undo
  for (let i = 0; i < w * h; i++) {
    const g = 0.01 + 0.09 * ((i * 37) % 101) / 100; // dark grays: two stops under
    rgba.set([...cast.map((c) => Math.round(fx.linearToSrgb(Math.min(1, g * c)) * 255)), 255], i * 4);
  }
  const r = A.autoColor([{ rgba, w, h }]);
  check(r && r.temperature < -10 && Math.abs(r.exposure - 1.1) < 1.2 && r.exposure > 0.5, `a warm dark picture gets a cooler temperature and more exposure (${S(r)})`);
  const plan = fx.cpu.basicPlan({ ...fx.defaults('color.basic'), ...r });
  const sum = [0, 0, 0];
  let logSum = 0;
  for (let i = 0; i < w * h; i++) {
    const c = fx.cpu.basicPixel([0, 1, 2].map((k) => fx.srgbToLinear(rgba[i * 4 + k] / 255)), plan);
    c.forEach((v, k) => { sum[k] += v; });
    logSum += Math.log(1e-4 + c[0] * fx.LUMA[0] + c[1] * fx.LUMA[1] + c[2] * fx.LUMA[2]);
  }
  const avg = sum.map((v) => v / (w * h));
  const spread = (Math.max(...avg) - Math.min(...avg)) / Math.max(...avg);
  check(spread < 0.03, `through color.basic the average is neutral (${avg.map((v) => v.toFixed(4)).join(', ')}; ${(spread * 100).toFixed(2)}% apart)`);
  const logAvg = Math.exp(logSum / (w * h));
  check(Math.abs(logAvg - 0.18) < 0.02, `and its log-average luminance is mid-grey (${logAvg.toFixed(4)})`);
  const bright = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) bright.set(i % 10 ? [40, 40, 40, 255] : [245, 245, 245, 255], i * 4);
  const rb = A.autoColor([{ rgba: bright, w, h }]);
  const top = fx.srgbToLinear(245 / 255) * 2 ** rb.exposure;
  check(rb.exposure >= 0 && top <= 1.001, `exposure stops before the brightest percent clips (${rb.exposure}, top ${top.toFixed(3)})`);
  // A light, high-key picture (a white stage: a real 4K video was pulled down 1.6 stops to a dull grey)
  const light = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) light.set(i % 7 ? [205, 205, 212, 255] : [238, 238, 242, 255], i * 4);
  const rl = A.autoColor([{ rgba: light, w, h }]);
  const lightTop = fx.srgbToLinear(238 / 255) * 2 ** rl.exposure;
  check(rl.exposure <= 0 && lightTop >= 0.79, `a light picture is darkened at most until its brightest percent is 0.8 (${rl.exposure}, top ${lightTop.toFixed(3)})`);
  const grey = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) grey.set(i % 7 ? [225, 225, 225, 255] : [255, 255, 255, 255], i * 4);
  check(A.autoColor([{ rgba: grey, w, h }]).exposure < -0.2, 'a picture with clipped whites is still darkened a little');
  eq(A.autoColor([]), null, 'no pictures, no answer');
});

// ---------- ducking ----------
section('ducking', () => {
  const D = 20 * T;
  const fade = 9 * F; // 0.3 s
  const k = A.duckKeyframes({ duration: D, speech: [[2 * T, 5 * T], [5.4 * T, 8 * T], [12 * T, 14 * T]], amount: -12, fade, frame: F });
  eq(k.map((x) => [+(x.t / T).toFixed(3), x.v]), [[0, 0], [1.7, 0], [2, -12], [8, -12], [8.3, 0], [11.7, 0], [12, -12], [14, -12], [14.3, 0], [20, 0]],
    'dips 12 dB under each speech with 0.3 s ramps; two dips whose ramps meet are one');
  check(k.every((x) => x.t % F === 0 && x.ease === 'linear'), 'keyframes are on frames and linear');
  check(Math.abs(kf.valueAt(k, 1.85 * T, 0) + 6) < 1e-9 && kf.valueAt(k, 3 * T, 0) === -12 && kf.valueAt(k, 10 * T, 0) === 0, 'the dip is halfway down mid-ramp, down during speech, back up between');
  const edge = A.duckKeyframes({ duration: 10 * T, speech: [[0, 2 * T], [9 * T, 12 * T]], amount: -10, fade, frame: F });
  eq(edge.map((x) => [+(x.t / T).toFixed(3), x.v]), [[0, -10], [2, -10], [2.3, 0], [8.7, 0], [9, -10], [10, -10]], 'speech at the clip edges starts and ends down');
  eq(A.duckKeyframes({ duration: D, speech: [[25 * T, 30 * T]], amount: -12, fade, frame: F }), [], 'speech outside the clip changes nothing');
});

// ---------- as a page script ----------
section('page', () => {
  // The page has Monaco's AMD require as a global function: the modules must not take it for Node's.
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, Error, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8ClampedArray, Promise };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const dir = new URL('../renderer/features/cut/', import.meta.url);
  const order = readFileSync(new URL('index.js', dir), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  const mine = ['time.js', 'model.js', 'keyframes.js', 'effects.js', 'analyze.js'];
  check(order.indexOf('analyze.js') > Math.max(...mine.slice(0, -1).map((x) => order.indexOf(x))) && order.indexOf('ui-auto.js') > order.indexOf('ui-timeline.js'), 'index.js loads analyze.js after what it uses, and ui-auto.js after the timeline');
  for (const file of order.filter((x) => mine.includes(x))) vm.runInContext(readFileSync(new URL(file, dir), 'utf8'), page, { filename: file });
  const out = vm.runInContext(`(() => {
    const k = Cut.analyze.duckKeyframes({ duration: 10, speech: [[2, 4]], amount: -6, fade: 1, frame: 1 });
    return [Cut.analyze.union([[0, 2], [1, 3]]), k.length, Cut.analyze.autoColor([{ rgba: new Uint8ClampedArray([200, 100, 50, 255]), w: 1, h: 1 }]).temperature < 0];
  })()`, page);
  eq(out, [[[0, 3]], 6, true], 'analyze.js works as a page script through globalThis.Cut');
});

await Promise.all(pending);
const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
