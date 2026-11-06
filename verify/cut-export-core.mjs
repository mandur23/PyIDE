// Nano Studio Cut's sound and export modules in plain Node (no Electron, no codecs): export presets (codec levels,
// bitrates, size estimates), the resampler and the WSOLA time stretch on sines, BS.1770-4 loudness and true peak
// against theory, the peak normalize and loudness match gains, the mixer on synthetic sources (clip and track volume,
// volume keyframes, pan, fades, mute and solo, constant power crossfades, speed with the pitch kept, reverse, other
// sample rates, master gain, audio effects), the test source's machine-readable frame numbers (painted, scaled,
// noisy), and export's pure parts (frame plan, YouTube chapters, captions in a range, SRT names).
// Usage: node verify/cut-export-core.mjs
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const C = require('../renderer/features/cut/commands.js');
const presets = require('../renderer/features/cut/presets.js');
const ae = require('../renderer/features/cut/audioengine.js');
const testsrc = require('../renderer/features/cut/testsrc.js');
const exp = require('../renderer/features/cut/export.js');

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const near = (a, b, eps, label) => check(Math.abs(a - b) <= eps, `${label} (${a} vs ${b})`);
const SEC = time.TICKS;
const RATE = 48000;

// ---- presets ---------------------------------------------------------------------------------------------------------
{
  const s30 = presets.resolve('youtube-1080p', { fps: [30, 1], w: 1920, h: 1080 });
  eq([s30.width, s30.height, s30.video.codec, s30.video.bitrate, s30.video.keyInterval], [1920, 1080, 'avc1.640028', 10e6, 60], '1080p30: High L4.0, 10 Mbps, key every 2 s');
  const s60 = presets.resolve('youtube-1080p', { fps: [60, 1] });
  eq([s60.video.codec, s60.video.bitrate, s60.video.keyInterval], ['avc1.64002a', 15e6, 120], '1080p60: L4.2, 15 Mbps');
  const s2997 = presets.resolve('youtube-1080p', { fps: [30000, 1001] });
  eq([s2997.video.codec, s2997.video.keyInterval, s2997.fps], ['avc1.640028', 60, [30000, 1001]], '1080p29.97: L4.0, 60 frames, the sequence rate');
  eq(presets.resolve('youtube-4k', { fps: [30, 1] }).video.codec, 'avc1.640033', '4K30: L5.1');
  eq(presets.resolve('youtube-4k', { fps: [60, 1] }).video.codec, 'avc1.640034', '4K60: L5.2');
  eq([s30.loudness, presets.resolve('youtube-1080p', { fps: [30, 1] }, { loudness: null }).loudness, presets.resolve('youtube-1080p', { fps: [30, 1] }, { loudness: -24 }).loudness],
    [-14, null, -24], 'the loudness target: the preset\'s, turned off by a null override, or replaced');
  const shorts = presets.resolve('shorts', { fps: [30, 1], w: 1920, h: 1080 });
  eq([shorts.width, shorts.height, shorts.video.codec], [1080, 1920, 'avc1.640028'], 'Shorts: 1080x1920, L4.0');
  eq(presets.resolve('720p', { fps: [30, 1] }).video.codec, 'avc1.64001f', '720p30: L3.1');
  eq(presets.resolve('youtube-1080p', { fps: [30, 1] }, { codec: 'hevc' }).video.codec, 'hvc1.1.6.L120.B0', 'HEVC 1080p30: level 4');
  eq(presets.resolve('youtube-4k', { fps: [60, 1] }, { codec: 'hevc' }).video.codec, 'hvc1.1.6.L156.B0', 'HEVC 4K60: level 5.2');
  const audio = presets.resolve('audio-m4a', { fps: [30, 1], w: 1920, h: 1080 });
  eq([audio.kind, audio.ext, audio.video, audio.audio.codec, audio.audio.rate, audio.audio.bitrate], ['audio', 'm4a', null, 'mp4a.40.2', 48000, 192000], 'audio only: AAC 48 kHz 192 kbps M4A');
  const custom = presets.resolve('youtube-1080p', { fps: [30, 1] }, { w: 1281, h: 721, audioBitrate: 150000, mode: 'constant' });
  eq([custom.width, custom.height, custom.audio.bitrate, custom.video.mode], [1282, 722, 160000, 'constant'], 'overrides: even size, nearest offered audio bitrate');
  eq(presets.validate(custom), [], 'valid settings');
  check(presets.validate({ ...custom, width: 7, video: { bitrate: 10 } }).length === 3, 'invalid size, odd width and bitrate are reported');
  const bytes = presets.estimate(s30, 60 * SEC);
  near(bytes / 1e6, ((10e6 + 192000) * 60) / 8 / 1e6, 0.1, '60 s at 10.192 Mbps is about 76.4 MB');
  near(presets.estimate('audio-m4a', 600 * SEC) / 1e6, (192000 * 600) / 8 / 1e6 + 0.113, 0.01, '10 min M4A at 192 kbps, with its sample tables');
  near(presets.estimateSeconds(s30, 60 * SEC, { speed: 1920 * 1080 * 30 * 2 }), 30, 1e-6, 'time estimate from a measured speed (2x realtime -> 30 s)');
  eq(presets.sequenceFor({ video: { w: 3840, h: 2160, fps: [30000, 1001], rotation: 0 } }), { w: 3840, h: 2160, fps: [30000, 1001] }, 'sequence for a 29.97 4K clip');
  eq(presets.sequenceFor({ video: { w: 1920, h: 1080, fps: [59.9, 1], rotation: 90 } }), { w: 1080, h: 1920, fps: [60000, 1001] }, 'sequence for a phone clip shot upright');
  eq(presets.sequences().map((p) => p.id), ['youtube-1080p30', 'youtube-4k30', 'shorts', 'square'], 'sequence presets');
}

// ---- DSP -------------------------------------------------------------------------------------------------------------
const sine = (f, rate, seconds, amp = 1, phase = 0) => {
  const n = Math.round(rate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * f * i) / rate + phase);
  return a;
};
// Frequency from rising zero crossings (linear interpolation) over [from, to).
function frequency(a, rate, from = 0, to = a.length) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    if (a[i - 1] < 0 && a[i] >= 0) {
      const x = i - 1 + -a[i - 1] / (a[i] - a[i - 1]);
      if (first < 0) first = x;
      else count++;
      last = x;
    }
  }
  return count > 0 ? (count * rate) / (last - first) : 0;
}
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };
{
  const x = sine(1000, 44100, 1, 0.5);
  const [y] = ae.resample([x], 44100, 48000);
  eq(y.length, 48000, 'resample 44.1 -> 48 kHz: length');
  let err = 0;
  for (let i = 2000; i < 46000; i++) err = Math.max(err, Math.abs(y[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000)));
  check(err < 1e-3, `resampled 1 kHz sine is the ideal one within -66 dB (max error ${err.toExponential(2)})`);
  const [z] = ae.resample([sine(15000, 48000, 0.5, 0.5)], 48000, 22050);
  check(rms(z, 1000, z.length - 1000) < 0.01, `15 kHz is removed going down to 22.05 kHz (rms ${rms(z, 1000, z.length - 1000).toFixed(4)})`);
}
{
  for (const factor of [2, 0.5, 1.25]) {
    const x = sine(440, RATE, 2, 0.5);
    const [y] = ae.stretch([x], factor, RATE);
    eq(y.length, Math.round(x.length * factor), `stretch x${factor}: length`);
    const f = frequency(y, RATE, 4800, y.length - 4800);
    near(f, 440, 440 * 0.01, `stretch x${factor}: the pitch stays 440 Hz`);
    const parts = [];
    for (let i = 4800; i + 4800 < y.length; i += 4800) parts.push(rms(y, i, i + 4800));
    const lo = Math.min(...parts);
    const hi = Math.max(...parts);
    check(lo > 0.5 / Math.SQRT2 * 0.8 && hi < 0.5 / Math.SQRT2 * 1.2, `stretch x${factor}: level steady (${lo.toFixed(3)}..${hi.toFixed(3)})`);
  }
}
{
  const ch = (a) => ({ sampleRate: RATE, numberOfChannels: a.length, getChannelData: (i) => a[i] });
  const s = sine(997, RATE, 20, 0.1);
  near(ae.loudness(ch([s, s])).integrated, -20, 0.05, 'stereo 997 Hz sine at -20 dBFS: -20 LUFS');
  near(ae.loudness(ch([sine(997, RATE, 20, 1)])).integrated, -3.01, 0.05, 'mono full scale 997 Hz sine: -3.01 LUFS (BS.1770 calibration)');
  const s441 = sine(997, 44100, 20, 0.1);
  near(ae.loudness({ sampleRate: 44100, numberOfChannels: 2, getChannelData: () => s441 }).integrated, -20, 0.05, 'the same at 44.1 kHz (filters for the rate)');
  const a23 = sine(1000, RATE, 20, Math.pow(10, -23 / 20));
  near(ae.loudness(ch([a23, a23])).integrated, -23, 0.1, 'EBU Tech 3341 case 1: 1 kHz at -23 dBFS stereo -> -23 LUFS');
  const gated = new Float32Array(RATE * 20);
  gated.set(sine(997, RATE, 10, 0.1));
  near(ae.loudness(ch([gated, gated])).integrated, -20, 0.1, 'silence is gated out (absolute gate)');
  const two = new Float32Array(RATE * 20);
  two.set(sine(997, RATE, 10, 0.1));
  two.set(sine(997, RATE, 10, 0.01), RATE * 10);
  near(ae.loudness(ch([two, two])).integrated, -20, 0.2, 'a part 20 LU quieter is gated out (relative gate)');
  const tp = ae.loudness(ch([sine(12000, RATE, 2, 1, Math.PI / 4)]));
  near(tp.samplePeak, -3.01, 0.05, '12 kHz sine at 45 degrees: samples peak at -3 dBFS');
  near(tp.truePeak, 0, 0.3, 'its true peak is 0 dBTP (4x oversampled)');
  near(ae.loudness(ch([sine(997, RATE, 5, 0.5)])).truePeak, -6.02, 0.1, 'true peak of a -6 dBFS sine');
  check(ae.loudness(ch([new Float32Array(RATE * 2)])).integrated === -Infinity, 'silence: -Infinity LUFS');
  near(ae.normalizeGain(0.5), 5.02, 0.01, 'normalize: a 0.5 peak needs +5.02 dB for -1 dB');
  near(ae.normalizeGain(Float32Array.from([-0.25, 0.1, 0.2])), 11.04, 0.01, 'normalize from min/max peaks');
  near(ae.normalizeGain([Float32Array.from([0.1]), Float32Array.from([-0.8])], -3), -1.06, 0.01, 'normalize over channels to -3 dB');
  eq(ae.normalizeGain(new Float32Array(4)), 0, 'normalize silence: 0 dB');
  eq(ae.matchGain({ integrated: -20, truePeak: -10 }, -14), 6, 'match -20 LUFS to -14: +6 dB');
  eq(ae.matchGain({ integrated: -20, truePeak: -4 }, -14), 3, 'match is held so the true peak stays at -1 dBTP');
}

// ---- the mixer -------------------------------------------------------------------------------------------------------
const MED = (name, seconds, rate = RATE) => ({ path: `D:/a/${name}.wav`, name: `${name}.wav`, kind: 'audio', size: 1, mtime: 1, duration: seconds * SEC, video: null, audio: { rate, channels: 2 } });
function project(mediaList) {
  const p = model.createProject();
  const h = C.createHistory(p);
  const ids = h.do(C.importMedia(mediaList)).ids;
  return { h, s: h.project.sequences[0].id, ids };
}
const place = (h, s, media, { at = 0, inS = 0, outS, track = 'A1' }) => h.do(C.place(s, { source: { media }, in: inS * SEC, out: outS * SEC, at: at * SEC, video: null, audio: track, mode: 'overwrite' })).ids[0];
// Sources: constant L/R values, or a function of the sample index.
const dc = (l, r, seconds, rate = RATE) => ({ rate, channels: 2, data: [new Float32Array(rate * seconds).fill(l), new Float32Array(rate * seconds).fill(r)] });
async function mixAt(h, s, sources, seconds, n = 1, opts = {}) {
  const mixer = ae.createMixer({ rate: RATE, getAudio: async (_p, m) => sources[m.name] });
  await mixer.load(h.project, s);
  return mixer.mix(h.project, s, Math.round(seconds * RATE), n, opts);
}
{
  const { h, s, ids } = project([MED('a', 10), MED('b', 10), MED('ramp', 10), MED('slow', 10, 44100)]);
  const src = { 'a.wav': dc(0.5, 0.25, 10), 'b.wav': dc(0.2, 0.2, 10) };
  const ca = place(h, s, ids[0], { at: 0, outS: 4 });
  let m = await mixAt(h, s, src, 1);
  eq([m.out[0][0], m.out[1][0]], [0.5, 0.25], 'a clip plays its source');
  h.do(C.setClip(s, ca, { props: { volume: -6 } }));
  m = await mixAt(h, s, src, 1);
  near(m.out[0][0], 0.5 * Math.pow(10, -6 / 20), 1e-6, 'clip volume -6 dB');
  h.do(C.setClip(s, ca, { props: { volume: 0, pan: 100 } }));
  m = await mixAt(h, s, src, 1);
  eq([m.out[0][0], m.out[1][0]], [0, 0.25], 'pan right: the left channel goes silent');
  h.do(C.setClip(s, ca, { props: { pan: 0 } }));
  h.do(C.setKeyframes(s, ca, 'volume', [{ t: 0, v: 0, ease: 'linear' }, { t: 2 * SEC, v: -20, ease: 'linear' }]));
  m = await mixAt(h, s, src, 1);
  near(m.out[0][0], 0.5 * Math.pow(10, -10 / 20), 2e-4, 'volume keyframes 0 -> -20 dB: -10 dB halfway');
  h.do(C.setKeyframes(s, ca, 'duck', [{ t: 0, v: -12, ease: 'linear' }, { t: 2 * SEC, v: -12, ease: 'linear' }]));
  m = await mixAt(h, s, src, 1);
  near(m.out[0][0], 0.5 * Math.pow(10, -22 / 20), 2e-4, 'Auto Ducking\'s -12 dB adds to the volume curve\'s -10 dB');
  h.do(C.setKeyframes(s, ca, 'duck', null));
  h.do(C.setKeyframes(s, ca, 'volume', null));
  h.do(C.setClip(s, ca, { fadeIn: SEC, fadeOut: SEC }));
  m = await mixAt(h, s, src, 0.5);
  near(m.out[0][0], 0.25, 1e-3, 'fade in: half way through, half the level');
  m = await mixAt(h, s, src, 3.75);
  near(m.out[0][0], 0.125, 1e-3, 'fade out: a quarter before the end, a quarter of the level');
  h.do(C.setClip(s, ca, { fadeIn: 0, fadeOut: 0 }));
  h.do(C.setTrack(s, 'A1', { volume: 6 }));
  m = await mixAt(h, s, src, 1);
  near(m.out[0][0], 0.5 * Math.pow(10, 6 / 20), 1e-6, 'track volume +6 dB');
  near(ae.gainToDb(m.tracks.A1[0]), -6.02 + 6, 0.01, 'the track meter reads after the fader');
  h.do(C.setTrack(s, 'A1', { volume: 0 }));
  place(h, s, ids[1], { at: 0, outS: 4, track: 'A2' });
  m = await mixAt(h, s, src, 1);
  near(m.out[0][0], 0.7, 1e-6, 'two tracks add up');
  h.do(C.setTrack(s, 'A2', { mute: true }));
  m = await mixAt(h, s, src, 1);
  eq([m.out[0][0], m.tracks.A2[0]], [0.5, 0], 'a muted track is not heard');
  h.do(C.setTrack(s, 'A2', { mute: false, solo: true }));
  m = await mixAt(h, s, src, 1);
  near(m.out[0][0], 0.2, 1e-6, 'solo: only the solo track is heard');
  h.do(C.setTrack(s, 'A2', { solo: false }));
  m = await mixAt(h, s, src, 1, 1, { masterGain: -6 });
  near(m.out[0][0], 0.7 * Math.pow(10, -6 / 20), 1e-6, 'master gain');
  near(ae.gainToDb(m.master[0]), ae.gainToDb(0.7) - 6, 0.01, 'master meter');
  m = await mixAt(h, s, src, 5);
  eq([m.out[0][0], m.out[1][0]], [0, 0], 'nothing after the clips');
}
{
  // Crossfade: clip A 0-2 s then clip B 2-4 s on A1, a centered 1 s constant power transition.
  const { h, s, ids } = project([MED('a', 10), MED('b', 10)]);
  const src = { 'a.wav': dc(0.5, 0.5, 10), 'b.wav': dc(0.3, 0.3, 10) };
  place(h, s, ids[0], { at: 0, inS: 2, outS: 4 });
  place(h, s, ids[1], { at: 2, inS: 2, outS: 4 });
  h.do(C.addTransition(s, { track: 'A1', at: 2 * SEC, type: 'crossfade.power', duration: SEC, align: 'center' }));
  let m = await mixAt(h, s, src, 2);
  near(m.out[0][0], (0.5 + 0.3) * Math.SQRT1_2, 2e-3, 'crossfade at the edit point: both at -3 dB');
  m = await mixAt(h, s, src, 1.75);
  near(m.out[0][0], 0.5 * Math.cos(Math.PI / 8) + 0.3 * Math.sin(Math.PI / 8), 2e-3, 'a quarter in: cos/sin gains, B from before its in point');
  m = await mixAt(h, s, src, 2.4);
  near(m.out[0][0], 0.5 * Math.cos((Math.PI / 2) * 0.9) + 0.3 * Math.sin((Math.PI / 2) * 0.9), 2e-3, 'A continues past its out point');
}
{
  // Speed 2 with the pitch kept, reverse, and a 44.1 kHz source.
  const { h, s, ids } = project([MED('tone', 10), MED('ramp', 10), MED('slow', 10, 44100)]);
  const ramp = new Float32Array(RATE * 10);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i / ramp.length;
  const src = { 'tone.wav': { rate: RATE, channels: 1, data: [sine(440, RATE, 10, 0.5)] }, 'ramp.wav': { rate: RATE, channels: 1, data: [ramp] }, 'slow.wav': { rate: 44100, channels: 1, data: [sine(1000, 44100, 10, 0.5)] } };
  const ct = place(h, s, ids[0], { at: 0, inS: 0, outS: 4 });
  h.do(C.setClip(s, ct, { speed: 2 }));
  eq(model.clipDuration(h.project.sequences[0].clips.find((c) => c.id === ct)), 2 * SEC, 'speed 2 halves the clip');
  let m = await mixAt(h, s, src, 0.2, RATE);
  near(frequency(m.out[0], RATE, 2400, RATE - 2400), 440, 4.4, 'speed 2 keeps the pitch (WSOLA)');
  near(rms(m.out[0], 2400, RATE - 2400), 0.5 / Math.SQRT2, 0.05, 'and the level');
  const cr = place(h, s, ids[1], { at: 0, inS: 2, outS: 6, track: 'A2' });
  h.do(C.setClip(s, cr, { reverse: true }));
  h.do(C.setTrack(s, 'A1', { mute: true }));
  m = await mixAt(h, s, src, 0);
  near(m.out[0][0], 0.6, 1e-3, 'reverse starts at the out point');
  m = await mixAt(h, s, src, 3);
  near(m.out[0][0], 0.3, 1e-3, 'and runs backwards');
  h.do(C.setTrack(s, 'A2', { mute: true }));
  place(h, s, ids[2], { at: 0, inS: 0, outS: 5, track: 'A1' });
  h.do(C.setTrack(s, 'A1', { mute: false }));
  m = await mixAt(h, s, src, 3, RATE);
  near(frequency(m.out[0], RATE, 1000, RATE - 1000), 1000, 1, 'a 44.1 kHz source plays at the right pitch at 48 kHz');
  const off = await ae.renderOffline(h.project, s, 0, 2 * SEC, RATE, { getAudio: async (_p, md) => src[md.name] });
  eq([off.sampleRate, off.length, off.numberOfChannels], [RATE, 2 * RATE, 2], 'renderOffline: 2 s of stereo at 48 kHz');
  const meas = await ae.measure(h.project, s, 0, 5 * SEC, { getAudio: async (_p, md) => src[md.name] });
  near(meas.integrated, -20 * Math.log10(1) + 20 * Math.log10(0.5), 0.3, 'measure: the 44.1 kHz sine at -6 dBFS in both channels is about -6 LUFS');
}
{
  // Audio effects from the registry, when it is there.
  let effects = null;
  try { effects = require('../renderer/features/cut/effects.js'); } catch {}
  if (effects?.get?.('audio.gain')) {
    globalThis.Cut = { effects };
    const { h, s, ids } = project([MED('a', 10)]);
    const ca = place(h, s, ids[0], { at: 0, outS: 4 });
    h.do(C.addEffect(s, ca, 'audio.gain', null, { gain: -12 }));
    const mixer = ae.createMixer({ rate: RATE, getAudio: async () => dc(0.5, 0.5, 10) });
    await mixer.load(h.project, s);
    near(mixer.mix(h.project, s, RATE, 1).out[0][0], 0.5 * Math.pow(10, -12 / 20), 1e-6, 'the audio.gain effect');
    delete globalThis.Cut;
  } else check(true, 'effects.js has no audio.gain (skipped)');
}

// ---- test source frame numbers --------------------------------------------------------------------------------------
{
  for (const [w, h] of [[320, 180], [1280, 720], [1080, 1920]]) {
    const rgba = new Uint8ClampedArray(w * h * 4).fill(40);
    for (const n of [0, 1, 299, 12345, 1048575]) {
      testsrc.paintBlocks(rgba, w, h, n);
      eq(testsrc.readFrameNumber(rgba, w, h), n, `${w}x${h}: frame ${n} reads back`);
    }
  }
  // Scaled into a region of a bigger frame, with noise.
  const w = 640;
  const h = 360;
  const small = new Uint8ClampedArray(w * h * 4).fill(30);
  testsrc.paintBlocks(small, w, h, 4242);
  const W = 1920;
  const H = 1080;
  const big = new Uint8ClampedArray(W * H * 4);
  const region = { x: 240, y: 135, w: 1440, h: 810 };
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.floor(((x - region.x) * w) / region.w);
    const sy = Math.floor(((y - region.y) * h) / region.h);
    const inside = sx >= 0 && sy >= 0 && sx < w && sy < h;
    for (let c = 0; c < 3; c++) big[(y * W + x) * 4 + c] = (inside ? small[(sy * w + sx) * 4 + c] : 0) + (rnd() - 0.5) * 60;
    big[(y * W + x) * 4 + 3] = 255;
  }
  eq(testsrc.readFrameNumber(big, W, H, region), 4242, 'scaled into a region with noise');
  const blank = new Uint8ClampedArray(64 * 36 * 4).fill(128);
  eq(testsrc.readFrameNumber(blank, 64, 36), -1, 'no block row: -1');
  const mixed = new Uint8ClampedArray(w * h * 4);
  const a = new Uint8ClampedArray(w * h * 4).fill(30);
  const b = new Uint8ClampedArray(w * h * 4).fill(30);
  testsrc.paintBlocks(a, w, h, 0b10101010101010101010);
  testsrc.paintBlocks(b, w, h, 0b01010101010101010101);
  for (let i = 0; i < mixed.length; i++) mixed[i] = (a[i] + b[i]) / 2;
  eq(testsrc.readFrameNumber(mixed, w, h), -1, 'half of two frames (a dissolve) is not read as a number');
  const sch = testsrc.schedule({ seconds: 3, fps: [30, 1], beepEvery: 1 });
  eq([sch.frames.length, sch.beeps.map((t) => t / SEC), [...sch.flashes]], [90, [0, 1, 2], [0, 30, 60]], 'schedule: 90 frames, a beep and flash every second');
  const s2997 = testsrc.schedule({ seconds: 2, fps: [30000, 1001], beepEvery: 1 });
  eq([s2997.frames.length, [...s2997.flashes]], [60, [0, 29]], '29.97: the flash is the frame on screen at the beep');
  const vfr = testsrc.schedule({ seconds: 4, fps: [30, 1], beepEvery: 1, vfr: true });
  const durs = new Set(vfr.frames.map((f) => f.duration / time.frameTicks([30, 1])));
  check(durs.size >= 3 && vfr.frames.every((f, i) => i === 0 || f.t === vfr.frames[i - 1].t + vfr.frames[i - 1].duration), `VFR: varying frame lengths (${[...durs]}) that follow each other`);
  check(vfr.frames.at(-1).t + vfr.frames.at(-1).duration >= 4 * SEC, 'VFR: covers the length');
  eq(testsrc.frameAtTime(vfr, 2 * SEC), vfr.frames.findIndex((f) => f.t <= 2 * SEC && 2 * SEC < f.t + f.duration), 'VFR: the frame on screen at a time');
}

// ---- export's pure parts --------------------------------------------------------------------------------------------
{
  const seq = model.createSequence({ fps: [30, 1] });
  seq.markers = [
    { id: 'k1', t: 0, duration: 0, name: 'Intro', note: '', kind: 'chapter', color: 'green' },
    { id: 'k2', t: 75 * SEC, duration: 0, name: 'Part one', note: '', kind: 'chapter', color: 'green' },
    { id: 'k3', t: 30 * SEC, duration: 0, name: 'not a chapter', note: '', kind: 'comment', color: 'green' },
    { id: 'k4', t: 3725 * SEC, duration: 0, name: 'Late', note: '', kind: 'chapter', color: 'green' },
  ];
  eq(exp.chapters(seq), '0:00:00 Intro\n0:01:15 Part one\n1:02:05 Late', 'chapters: hours when the last one is past an hour');
  seq.markers = seq.markers.slice(1, 3);
  eq(exp.chapters(seq, { firstName: 'Start' }), '00:00 Start\n01:15 Part one', 'chapters: the first one is put at 00:00');
  eq(exp.chapters(seq, { firstName: 'Start', range: { in: 60 * SEC, out: 100 * SEC } }), '00:00 Start\n00:15 Part one', 'chapters of a range count from its in point');
  const N = [30000, 1001];
  const plan = exp.framePlan({ fps: N }, time.frameStart(300, N), time.frameStart(600, N));
  eq([plan.count, plan.first], [300, time.frameStart(300, N)], 'frame plan of a 29.97 range on frames');
  eq(exp.framePlan({ fps: N }, 10 * SEC, 20 * SEC).count, 301, 'a range off the frames takes every frame it touches (299 to 599)');
  check(plan.timeOf(1) - plan.timeOf(0) === time.frameTicks([30000, 1001]) && plan.ptsOf(0) === 0, 'frame times from the range start');
  const items = [{ id: 'c1', start: 0, end: 2 * SEC, text: 'a' }, { id: 'c2', start: 9 * SEC, end: 12 * SEC, text: 'b' }, { id: 'c3', start: 15 * SEC, end: 16 * SEC, text: 'c' }];
  eq(exp.captionsInRange(items, { in: 10 * SEC, out: 15 * SEC }).map((x) => [x.start / SEC, x.end / SEC, x.text]), [[0, 2, 'b']], 'captions in a range: cut to it and moved to 0');
  eq(exp.captionsAt(items, 9.5 * SEC).map((x) => x.text), ['b'], 'the caption on screen at a time');
  eq(exp.sidecarPath('C:\\out\\My video.mp4', null, 1), 'C:\\out\\My video.srt', 'SRT next to the video');
  eq(exp.sidecarPath('C:\\out\\My video.mp4', 'ko', 2), 'C:\\out\\My video.ko.srt', 'one SRT per language when there are several');
  eq(exp.withExt('C:\\out\\clip.mov', 'mp4'), 'C:\\out\\clip.mp4', 'the export file gets the preset extension');
  eq(exp.psnr(new Uint8Array([10, 20, 30, 255]), new Uint8Array([10, 20, 30, 255])), null, 'PSNR of equal images is Infinity (JSON null)');
  near(exp.psnr(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]), new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255])), 20 * Math.log10(255) - 10 * Math.log10((255 * 255) / 2), 1e-9, 'PSNR over RGB');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
