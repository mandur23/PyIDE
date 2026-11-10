// Nano Studio Cut's sound and export in the real app (docs/cut-architecture.md §9), driving the modules the way the
// export dialog and the monitors do. Checks:
// - test sources (30, 29.97, 60 fps, VFR, HEVC when the GPU has it) decode with WebCodecs and every frame reads back
//   its number at its time; flashes and 1 kHz beeps line up within a frame;
// - an exported sequence with cuts, a speed change, a dissolve and a title re-decodes with the expected frame numbers
//   at the expected times, PSNR >= 35 dB against the compositor's own frames, beeps on their flashes within a frame,
//   the sped-up beeps still at 1 kHz (pitch kept); the hardware and the software encoder both make valid files, so do
//   HEVC (hardware) and the compositor's 2D back end (no full-range darkening); the files play in a <video> element
//   from a blob URL and show the right frames after seeks;
// - range export, captions burned in and as an SRT next to the file, cancel leaves no file or part file (also with an encoder that stops taking frames), a full disk stops the export at the refused write, export frame
//   as PNG, chapters text;
// - a source that stops giving its picture or sound on the way, or a lost GPU device, fails the export with the clip
//   and the time named and no file; media offline from the start exports as the red picture and is listed; Export
//   renders the project as it was when pressed, whatever is edited while it runs;
// - loudness of a -20 dBFS sine through the mix and through an exported M4A matches theory within 0.5 LU; the preview
//   clock follows the wall clock (and runs at twice the speed at rate 2), the meters read the level being heard;
// - the export speed of a 60 s 1080p30 sequence (reported).
// Usage: node verify/cut-export.mjs   (CUT_EXPORT_ONLY=testsrc,export,range,cancel,fail,live,loudness,speed,video runs some
// sections; CUT_EXPORT_BACKEND=2d exports through the compositor's Canvas 2D back end)
import { existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_EXPORT_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = tempDir('cut-export-home');
const ctx = await launch({ fixture: 'core', port: 9754, name: 'cut-export', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');

const absent = await js(`['time', 'model', 'commands', 'srt', 'probe', 'mp4write', 'effects', 'textrender', 'media', 'decoder', 'compositor', 'presets', 'audioengine', 'export', 'testsrc'].filter((n) => !Cut[n])`);
check(!absent.length, `the modules export needs are loaded${absent.length ? ` (missing: ${absent.join(', ')})` : ''}`);

const dirs = await js(`ide.api.invoke('cut:home')`);
const P = (name) => path.join(dirs.projects, name);

// ---- page helpers ------------------------------------------------------------------------------------------------
await js(`(() => {
  const C = Cut;
  const T = C.time.TICKS;
  const H = (window.__cx = { bytes: new Map(), pixels: new Map(), audio: new Map() });
  H.reader = async (key) => (H.bytes.has(key) ? C.codecs.bufferReader(H.bytes.get(key)) : C.audioengine.fileReader(key));
  H.open = async (key) => {
    const reader = await H.reader(key);
    return { reader, source: await C.probe.open(reader, { name: String(key) }) };
  };
  const lumaOf = (img, w, h, [x0, y0, x1, y1]) => {
    let s = 0, n = 0;
    for (let y = Math.floor(y0 * h); y < y1 * h; y += 2) for (let x = Math.floor(x0 * w); x < x1 * w; x += 2) {
      const i = (y * w + x) * 4;
      s += 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
      n++;
    }
    return n ? s / n : 0;
  };
  // Every frame of the video track, in presentation order: {n (frame number read), us (timestamp), luma (of a patch
  // away from the digits and the title)}. The RGBA of the frames listed in keep stays in H.pixels.get(key).
  H.decodeVideo = async (key, { keep = [], region = null, patch = [0.02, 0.3, 0.15, 0.5] } = {}) => {
    const { reader, source } = await H.open(key);
    const track = source.tracks.find((t) => t.kind === 'video');
    if (!track) return { error: 'no video track' };
    const s = track.samples;
    const w = track.width, h = track.height;
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    const out = [];
    const keepSet = new Set(keep);
    const kept = new Map();
    let error = null;
    const process = () => {
      while (frames.length) {
        const f = frames.shift();
        g.drawImage(f, 0, 0, w, h);
        const us = f.timestamp;
        f.close();
        const img = g.getImageData(0, 0, w, h).data;
        if (keepSet.has(out.length)) kept.set(out.length, new Uint8Array(img));
        out.push({ n: C.testsrc.readFrameNumber(img, w, h, region), us, luma: Math.round(lumaOf(img, w, h, patch)) });
      }
    };
    const dec = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { error = e; } });
    dec.configure({ codec: track.codec, codedWidth: w, codedHeight: h, ...(track.description ? { description: track.description } : {}) });
    for (let i = 0; i < s.count && !error; i += 30) {
      const datas = await C.probe.readSamples(reader, track, i, Math.min(s.count, i + 30));
      datas.forEach((d, k) => dec.decode(new EncodedVideoChunk({ type: s.key[i + k] ? 'key' : 'delta', timestamp: Math.round((s.pts[i + k] * 1e6) / T), data: d })));
      while (dec.decodeQueueSize > 4 && !error) { await new Promise((r) => setTimeout(r, 1)); process(); }
      process();
    }
    if (!error) await dec.flush();
    process();
    dec.close();
    if (error) throw error;
    H.pixels.set(key, kept);
    const a = source.tracks.find((t) => t.kind === 'audio');
    return { count: s.count, frames: out, w, h, codec: track.codec, vfr: track.vfr, frameRate: track.frameRate,
      duration: source.duration / T, audio: a ? { codec: a.codec, rate: a.sampleRate, channels: a.channels, duration: a.duration / T, firstPts: a.samples.pts[0] / T } : null };
  };
  // The first audio track decoded (placed by presentation time) -> {rate, length, onsets (seconds)}.
  H.onsets = (x, rate, thr = 0.1, quiet = 0.05) => {
    const out = [];
    let still = Math.round(quiet * rate);
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) > thr) { if (still >= quiet * rate) out.push(i / rate); still = 0; } else still++;
    }
    return out;
  };
  H.decodeAudio = async (key) => {
    const { reader, source } = await H.open(key);
    const track = source.tracks.find((t) => t.kind === 'audio');
    const pcm = await C.audioengine.decodeTrack(reader, track);
    H.audio.set(key, pcm);
    return { rate: pcm.rate, length: pcm.data[0].length, onsets: H.onsets(pcm.data[0], pcm.rate) };
  };
  // Frequency by rising zero crossings over [from, to) seconds of a decoded track.
  H.freq = (key, from, to) => {
    const { rate, data } = H.audio.get(key);
    const x = data[0];
    let first = -1, last = -1, count = 0;
    for (let i = Math.max(1, Math.round(from * rate)); i < Math.min(x.length, to * rate); i++) {
      if (x[i - 1] < 0 && x[i] >= 0 && Math.abs(x[i]) + Math.abs(x[i - 1]) > 0.02) {
        const p = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
        if (first < 0) first = p; else count++;
        last = p;
      }
    }
    return count ? (count * rate) / (last - first) : 0;
  };
  H.loudness = (key) => C.audioengine.loudness({ sampleRate: H.audio.get(key).rate, numberOfChannels: H.audio.get(key).data.length, getChannelData: (i) => H.audio.get(key).data[i] });
  // A test source made, kept in memory under its path and saved there.
  H.src = async (file, opts) => {
    const r = await C.testsrc.build(opts);
    H.bytes.set(file, r.bytes);
    const saved = await C.export.saveBytes(file, r.bytes);
    return { ok: saved.ok, error: saved.error, frames: r.schedule.frames.map((f) => f.t), durations: r.schedule.frames.map((f) => f.duration), flashes: [...r.schedule.flashes], beeps: r.schedule.beeps.map((b) => b / T), codec: r.codec, audioDelay: r.audioDelay, bytes: r.bytes.length };
  };
  H.importFiles = async (history, paths) => {
    const list = await C.media.importFiles(paths);
    const bad = list.filter((m) => m.error);
    if (bad.length) throw new Error(JSON.stringify(bad));
    return history.do(C.commands.importMedia(list)).ids;
  };
  H.projects = {};
  return true;
})()`);

const SEC = 254016000000;
const F30 = SEC / 30;

// The compositor's WebGPU back end, when it renders without GPU errors; else its Canvas 2D back end stands in (the
// export then checks its own frame path against that back end) and the log says so.
const gpu = await js(`(async () => {
  const C = Cut;
  const project = C.model.createProject({ sequence: { w: 64, h: 64, fps: [30, 1] } });
  const h = C.commands.createHistory(project);
  const seq = h.project.sequences[0].id;
  h.do(C.commands.addGenerated(seq, { track: 'V1', at: 0, duration: C.time.TICKS, source: { generator: 'solid', color: '#ff8000' } }));
  const canvas = new OffscreenCanvas(64, 64);
  const comp = await C.compositor.create(canvas, { width: 64, height: 64 });
  await comp.render(h.project, seq, 0, { quality: 1 });
  await comp.idle?.();
  const vf = comp.videoFrame({ timestamp: 0 });
  const g = new OffscreenCanvas(64, 64).getContext('2d');
  g.drawImage(vf, 0, 0);
  vf.close();
  const px = [...g.getImageData(32, 32, 1, 1).data];
  const out = { backend: comp.backend, errors: (comp.errors || []).length, firstError: String(comp.errors?.[0] || '').split(String.fromCharCode(10))[0], px };
  comp.destroy();
  __cx.backend = out.backend === 'webgpu' && !out.errors && px[0] > 200 && px[2] < 60 ? 'webgpu' : '2d';
  return { ...out, use: __cx.backend };
})()`);
if (gpu.use !== 'webgpu') log(`STAND-IN: the compositor's WebGPU back end draws ${S(gpu.px)} for an orange solid with ${gpu.errors} GPU errors ("${gpu.firstError}"); exports here use its Canvas 2D back end`);
// CUT_EXPORT_BACKEND=2d runs the exports through the compositor's Canvas 2D back end (the PCs without WebGPU).
const BACKEND_FORCED = process.env.CUT_EXPORT_BACKEND || null;
if (BACKEND_FORCED) { await js(`(__cx.backend = ${S(process.env.CUT_EXPORT_BACKEND)})`); log(`compositor back end forced: ${process.env.CUT_EXPORT_BACKEND}`); }
// The compositor's own frame at t, as RGBA, through the same VideoFrame path the export takes.
await js(`(__cx.compFrame = async (comp, project, seq, t, ropts = {}) => {
  await comp.render(project, seq, t, { quality: 1, ...ropts });
  const vf = comp.videoFrame({ timestamp: 0 });
  const g = new OffscreenCanvas(vf.displayWidth, vf.displayHeight).getContext('2d', { willReadFrequently: true });
  g.drawImage(vf, 0, 0);
  const img = g.getImageData(0, 0, vf.displayWidth, vf.displayHeight).data;
  vf.close();
  return img;
}, true)`);

// ---- test sources ------------------------------------------------------------------------------------------------
if (want('testsrc')) {
  const hevc = await js(`VideoEncoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0', width: 640, height: 360, bitrate: 2e6, framerate: 30, hardwareAcceleration: 'prefer-hardware', hevc: { format: 'hevc' } }).then((r) => r.supported).catch(() => false)`);
  const cases = [
    { name: '720p30', opts: { seconds: 4, fps: [30, 1], w: 1280, h: 720 } },
    { name: '29.97', opts: { seconds: 4, fps: [30000, 1001], w: 640, h: 360 } },
    { name: '60', opts: { seconds: 2, fps: [60, 1], w: 640, h: 360 } },
    { name: 'vfr', opts: { seconds: 4, fps: [30, 1], w: 640, h: 360, vfr: true } },
    ...(hevc ? [{ name: 'hevc', opts: { seconds: 2, fps: [30, 1], w: 640, h: 360, codec: 'hevc', hardware: 'prefer-hardware' } }] : []),
  ];
  if (!hevc) log('note: no HEVC hardware encoder here; the HEVC test source is skipped');
  for (const c of cases) {
    const file = P(`src-${c.name}.mp4`);
    const made = await js(`__cx.src(${S(file)}, ${S(c.opts)})`);
    check(made.ok, `testsrc ${c.name}: made and saved (${(made.bytes / 1e6).toFixed(2)} MB, ${made.codec}, AAC delay ${made.audioDelay} samples)`);
    const d = await js(`__cx.decodeVideo(${S(file)})`);
    check(d.count === made.frames.length && d.frames.length === made.frames.length, `testsrc ${c.name}: ${d.frames.length} of ${made.frames.length} frames decode`);
    const wrongN = d.frames.map((f, i) => (f.n === i ? null : `${i}:${f.n}`)).filter(Boolean);
    check(!wrongN.length, `testsrc ${c.name}: every frame reads back its number${wrongN.length ? ` (wrong: ${wrongN.slice(0, 8).join(' ')})` : ''}`);
    const us = (t) => Math.round((t * 1e6) / SEC);
    const wrongT = d.frames.map((f, i) => (Math.abs(f.us - us(made.frames[i])) <= 1 ? null : `${i}:${f.us}/${us(made.frames[i])}`)).filter(Boolean);
    check(!wrongT.length, `testsrc ${c.name}: every frame at its time${wrongT.length ? ` (${wrongT.slice(0, 5).join(' ')})` : ''}`);
    if (c.opts.vfr) check(d.vfr === true && S(d.frameRate) === S([30, 1]), `testsrc vfr: the file reads as VFR with a nominal 30 fps (${d.vfr}, ${S(d.frameRate)})`);
    const flashes = d.frames.map((f, i) => (f.luma > 200 ? i : -1)).filter((i) => i >= 0);
    check(S(flashes) === S(made.flashes), `testsrc ${c.name}: white frames at the beeps (${S(flashes)} vs ${S(made.flashes)})`);
    const a = await js(`__cx.decodeAudio(${S(file)})`);
    const frameLen = (made.durations[0] || F30) / SEC;
    const offs = made.beeps.map((b, k) => (a.onsets[k] ?? NaN) - b);
    check(a.onsets.length === made.beeps.length && offs.every((o) => Math.abs(o) < Math.min(frameLen, 0.01)), `testsrc ${c.name}: beeps at their times within 10 ms (${offs.map((o) => `${(o * 1000).toFixed(1)}ms`).join(' ')})`);
  }
}

// ---- the edit: cuts, a speed change, a dissolve, a title ---------------------------------------------------------
// S1 (1280x720, 30 fps) from a 10 s test source A:
//   clip 1: A 0..3 s at 0 s;  clip 2: A 5.5..7.5 s at 3 s (a 10-frame dissolve on the cut at 3 s);
//   clip 3: A 2..6 s at 5 s at speed 2 (2 s long);  a title on V2 from 1 to 2 s;  a caption from 0.5 to 1.5 s.
// Source frame on screen at sequence frame j (outside the dissolve, frames 85..94):
const expectedN = (j) => (j < 90 ? j : j < 150 ? 165 + (j - 90) : 60 + 2 * (j - 150));
const S1_FRAMES = 210;
const BEEPS = [0, 1, 2, 3.5, 4.5, 5, 5.5, 6, 6.5];
const FLASHES = [0, 30, 60, 105, 135, 150, 165, 180, 195];
let s1 = null;
async function buildS1() {
  if (s1) return s1;
  const srcA = P('A.mp4');
  const made = await js(`__cx.src(${S(srcA)}, { seconds: 10, fps: [30, 1], w: 1280, h: 720 })`);
  if (!made.ok) throw new Error(`test source A: ${made.error}`);
  s1 = await js(`(async () => {
    const C = Cut;
    const T = C.time.TICKS;
    const project = C.model.createProject({ sequence: { w: 1280, h: 720, fps: [30, 1] } });
    const h = C.commands.createHistory(project);
    const [a] = await __cx.importFiles(h, [${S(srcA)}]);
    const seq = h.project.sequences[0].id;
    const place = (inS, outS, at) => h.do(C.commands.place(seq, { source: { media: a }, in: Math.round(inS * T), out: Math.round(outS * T), at: Math.round(at * T), video: 'V1', audio: 'A1', mode: 'overwrite' })).ids;
    place(0, 3, 0);
    place(5.5, 7.5, 3);
    const c3 = place(2, 6, 5);
    const v3 = h.project.sequences[0].clips.find((c) => c3.includes(c.id) && c.track === 'V1');
    h.do(C.commands.setClip(seq, v3.id, { speed: 2 }));
    h.do(C.commands.addTransition(seq, { track: 'V1', at: 3 * T, type: 'dissolve', duration: 10 * T / 30, align: 'center' }));
    h.do(C.commands.addGenerated(seq, { track: 'V2', at: T, duration: T, source: { generator: 'text', layers: [C.model.createTextLayer({ text: 'Title 제목', size: 80, position: [0, 200] })] } }));
    const cc = h.do(C.commands.addCaptionTrack(seq, { lang: 'ko', name: 'Korean', items: [{ start: T / 2, end: 1.5 * T, text: '안녕하세요 captions' }] })).id;
    h.do(C.commands.addMarker(seq, { t: 0, name: 'Start', kind: 'chapter' }));
    h.do(C.commands.addMarker(seq, { t: 3 * T, name: 'Second part', kind: 'chapter' }));
    __cx.projects.s1 = { history: h, seq, cc };
    const s = h.project.sequences[0];
    return { seq, cc, duration: C.model.sequenceDuration(s) / T, clips: s.clips.map((c) => [c.track, c.start / T, C.model.clipEnd(c) / T, c.speed]), valid: C.model.validate(h.project).ok };
  })()`);
  return s1;
}

// Decodes an export and checks frame numbers, times and the beeps against the flashes.
async function checkEdit(label, file, { frames = S1_FRAMES, first = 0, keep = [] } = {}) {
  const d = await js(`__cx.decodeVideo(${S(file)}, { keep: ${S(keep)} })`);
  check(d.count === frames, `${label}: ${d.count} frames (want ${frames})`);
  const wrong = [];
  const dissolve = [];
  d.frames.forEach((f, i) => {
    const j = first + i;
    // In the dissolve a frame reads as the outgoing clip's frame, the incoming one's, or neither (a mix).
    if (j >= 85 && j < 95) { dissolve.push(f.n === j ? 'A' : f.n === 165 + (j - 90) ? 'B' : f.n === -1 ? 'x' : `?${f.n}`); return; }
    if (f.n !== expectedN(j)) wrong.push(`${j}:${f.n}/${expectedN(j)}`);
  });
  check(!wrong.length, `${label}: every frame shows the expected source frame (cuts, speed 2)${wrong.length ? ` wrong: ${wrong.slice(0, 10).join(' ')}` : ''}`);
  const dissolveMixed = dissolve.filter((x) => x === 'x').length;
  if (dissolve.length) check(/^A*x+B*$/.test(dissolve.join('')) && dissolveMixed >= 4, `${label}: the dissolve goes from the outgoing clip through mixes to the incoming one (${dissolve.join('')})`);
  const badT = d.frames.map((f, i) => (Math.abs(f.us - Math.round((i * 1e6) / 30)) <= 1 ? null : `${i}:${f.us}`)).filter(Boolean);
  check(!badT.length, `${label}: frames at 1/30 s steps from 0${badT.length ? ` (${badT.slice(0, 5).join(' ')})` : ''}`);
  return { d, dissolveMixed };
}

if (want('export')) {
  const info = await buildS1();
  check(info.valid && Math.abs(info.duration - 7) < 1e-9, `S1 is a valid 7 s sequence (${S(info.clips)})`);
  const out = P('edit-hw.mp4');
  const r = await js(`(async () => {
    const p = __cx.projects.s1;
    const seen = [];
    const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(out)}, preset: '720p', hardware: 'hardware', backend: __cx.backend, onProgress: (x) => seen.push(x) });
    const video = seen.filter((x) => x.phase === 'video');
    return { ...r, phases: [...new Set(seen.map((x) => x.phase))], videoSteps: video.length, lastVideo: video.at(-1) };
  })()`);
  check(r.ok, `export S1 (720p, hardware H.264): ok ${r.ok ? `${r.bytes} bytes in ${r.seconds.toFixed(2)} s` : `${r.code}: ${r.error}`}`);
  if (r.ok) {
    check(r.encoder?.hardware === true && /^avc1\.64/.test(r.encoder.codec), `the hardware encoder was used (${S(r.encoder)})`);
    check(r.verified?.ok, `export verified itself: ${S(r.verified)}`);
    check(S(r.phases) === S(['audio', 'video', 'finish', 'verify']) && r.videoSteps > 20 && r.lastVideo.done === 210 && r.lastVideo.fraction === 1 && r.lastVideo.eta === 0, `progress was reported (${S(r.phases)}, ${r.videoSteps} video steps, last ${S(r.lastVideo)})`);
    const head = await js(`ide.api.invoke('cut:read', ${S(out)}, 0, 64).then((b) => String.fromCharCode(...b.subarray(4, 8), ...b.subarray(36, 40)))`);
    check(/^ftyp/.test(head) && head.slice(4) === 'moov', `faststart: moov right after ftyp (${head})`);
    const KEEP = [10, 45, 88, 90, 120, 170, 205];
    const { d } = await checkEdit('S1 export', out, { keep: KEEP });
    const flashes = d.frames.map((f, i) => (f.luma > 200 ? i : -1)).filter((i) => i >= 0);
    check(S(flashes) === S(FLASHES), `flashes at the expected frames (${S(flashes)})`);
    // PSNR of the exported frames against the compositor's own frames.
    const ps = await js(`(async () => {
      const p = __cx.projects.s1;
      const comp = await Cut.compositor.create(new OffscreenCanvas(1280, 720), { width: 1280, height: 720, backend: __cx.backend });
      const kept = __cx.pixels.get(${S(out)});
      const out = [];
      const diag = [];
      for (const [i, px] of kept) {
        const ref = await __cx.compFrame(comp, p.history.project, p.seq, Cut.time.frameStart(i, [30, 1]));
        const v = +Cut.export.psnr(px, ref).toFixed(2);
        if (v < 35) {
          const mean = [0, 0, 0];
          for (let k = 0; k < px.length; k += 4) for (let c = 0; c < 3; c++) mean[c] += (px[k + c] - ref[k + c]) / (px.length / 4);
          diag.push(['PSNR', i, v, 'numbers', Cut.testsrc.readFrameNumber(px, 1280, 720), Cut.testsrc.readFrameNumber(ref, 1280, 720), 'mean diff', mean.map((x) => x.toFixed(2)).join(','), 'px', [...px.subarray(4 * (300 * 1280 + 40), 4 * (300 * 1280 + 40) + 4)], 'ref', [...ref.subarray(4 * (300 * 1280 + 40), 4 * (300 * 1280 + 40) + 4)]].join(' '));
        }
        out.push([i, v]);
      }
      const backend = comp.backend;
      comp.destroy();
      return { backend, out, diag };
    })()`);
    for (const line of ps.diag) log(line);
    check(ps.out.length === KEEP.length && ps.out.every(([, v]) => v >= 35), `PSNR >= 35 dB against the compositor (${ps.backend}): ${ps.out.map(([i, v]) => `${i}:${v}`).join(' ')}`);
    const a = await js(`__cx.decodeAudio(${S(out)})`);
    const offs = a.onsets.map((t) => {
      const k = Math.round(t * 30);
      const near = FLASHES.reduce((b, f) => (Math.abs(f / 30 - t) < Math.abs(b / 30 - t) ? f : b), FLASHES[0]);
      return [t, (t - near / 30) * 1000, k];
    });
    check(a.onsets.length === BEEPS.length && offs.every(([, ms]) => Math.abs(ms) <= 1000 / 30), `beeps on their flashes within one frame: ${offs.map(([t, ms]) => `${t.toFixed(3)}s(${ms.toFixed(1)}ms)`).join(' ')}`);
    const f1 = await js(`__cx.freq(${S(out)}, 1.01, 1.09)`);
    const f2 = await js(`__cx.freq(${S(out)}, 5.505, 5.54)`);
    check(Math.abs(f1 - 1000) < 15 && Math.abs(f2 - 1000) < 30, `the beep is 1 kHz at speed 1 (${f1.toFixed(1)} Hz) and at speed 2, pitch kept (${f2.toFixed(1)} Hz)`);
    // The software encoder.
    const sw = P('edit-sw.mp4');
    const r2 = await js(`(async () => { const p = __cx.projects.s1; return Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(sw)}, preset: '720p', hardware: 'software', backend: __cx.backend }); })()`);
    check(r2.ok && r2.encoder?.hardware === false && r2.verified?.ok, `export S1 with the software encoder: ${r2.ok ? S(r2.verified) : `${r2.code}: ${r2.error}`}`);
    if (r2.ok) await checkEdit('S1 software export', sw);

    // Through the compositor's Canvas 2D back end (PCs without WebGPU): its frames come from CPU memory, which the
    // encoders would turn into full-range video shown too dark.
    if (BACKEND_FORCED !== '2d') {
      const f2d = P('edit-2d.mp4');
      const r4 = await js(`(async () => {
        const p = __cx.projects.s1;
        const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(f2d)}, preset: '720p', range: { in: 0, out: Cut.time.TICKS }, backend: '2d' });
        if (!r.ok) return r;
        await __cx.decodeVideo(${S(f2d)}, { keep: [10, 25] });
        const comp = await Cut.compositor.create(new OffscreenCanvas(1280, 720), { width: 1280, height: 720, backend: '2d' });
        const ps = [];
        for (const [i, px] of __cx.pixels.get(${S(f2d)})) ps.push(+Cut.export.psnr(px, await __cx.compFrame(comp, p.history.project, p.seq, Cut.time.frameStart(i, [30, 1]))).toFixed(2));
        comp.destroy();
        return { ...r, ps };
      })()`);
      check(r4.ok && r4.verified?.ok && r4.ps.length === 2 && r4.ps.every((v) => v >= 35), `export through the 2D back end: PSNR ${S(r4.ps)} (${r4.ok ? 'ok' : `${r4.code}: ${r4.error}`})`);
    }

    // HEVC, which the export offers only on a hardware encoder.
    const hevc = P('edit-hevc.mp4');
    const r3 = await js(`(async () => { const p = __cx.projects.s1; const T = Cut.time.TICKS; return Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(hevc)}, preset: '720p', overrides: { codec: 'hevc' }, range: { in: 0, out: 2 * T }, backend: __cx.backend }); })()`);
    if (r3.code === 'noEncoder') log('note: no HEVC hardware encoder here; the HEVC export is skipped');
    else {
      check(r3.ok && /^hvc1\./.test(r3.encoder?.codec) && r3.encoder.hardware && r3.verified?.ok, `HEVC export: ${r3.ok ? `${S(r3.encoder)} ${S(r3.verified)}` : `${r3.code}: ${r3.error}`}`);
      if (r3.ok) await checkEdit('HEVC export', hevc, { frames: 60 });
    }
  }
}

if (want('range')) {
  await buildS1();
  const out = P('range.mp4');
  const r = await js(`(async () => { const p = __cx.projects.s1; const T = Cut.time.TICKS; return Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(out)}, preset: '720p', range: { in: T, out: 2.5 * T }, captions: 'both', backend: __cx.backend }); })()`);
  check(r.ok && r.frames === 45 && r.verified?.ok, `range 1..2.5 s: ${r.ok ? `${r.frames} frames, ${S(r.verified)}` : `${r.code}: ${r.error}`}`);
  if (r.ok) {
    await checkEdit('range export', out, { frames: 45, first: 30, keep: [0, 15] });
    const srtPath = P('range.srt');
    check(r.sidecars?.length === 1 && r.sidecars[0].toLowerCase() === srtPath.toLowerCase(), `an SRT was written next to it (${S(r.sidecars)})`);
    const srt = existsSync(srtPath) ? readFileSync(srtPath, 'utf8') : '';
    check(/00:00:00,000 --> 00:00:00,500/.test(srt) && srt.includes('안녕하세요 captions'), `the SRT has the caption cut to the range and moved to 0 (${S(srt)})`);
    // two caption tracks of one language (both made in the UI's language): two SRT files, not one written twice;
    // and an audio-only export answers Cancel while it encodes (it ran to the end before)
    const two = P('two-ko.m4a');
    const r2 = await js(`(async () => {
      const p = __cx.projects.s1;
      const h = Cut.commands.createHistory(JSON.parse(JSON.stringify(p.history.project)));
      const seq = h.project.sequences.find((s) => s.id === p.seq);
      for (const ct of seq.captions) h.do(Cut.commands.setCaptionTrack(p.seq, ct.id, { lang: 'ko' }));
      const id = h.do(Cut.commands.addCaptionTrack(p.seq, { lang: 'ko', name: '둘째' })).id;
      h.do(Cut.commands.setCaptions(p.seq, id, [{ start: 0, end: Cut.time.TICKS, text: '둘째 트랙' }]));
      const done = await Cut.export.run({ project: h.project, seqId: p.seq, path: ${S(two)}, preset: 'audio-m4a', captions: 'srt' });
      // a couple of minutes of sound (the first clip over and over), cancelled once the audio encode is under way
      const T = Cut.time.TICKS;
      const long = Cut.commands.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1] } }));
      const mid = long.do(Cut.commands.importMedia(JSON.parse(JSON.stringify(p.history.project.media.filter((m) => m.audio))))).ids[0];
      const md = long.project.media.find((m) => m.id === mid).duration;
      const piece = Math.floor(md / T) * T;
      for (let i = 0; i * piece < 120 * T; i++) long.do(Cut.commands.place(long.project.sequences[0].id, { source: { media: mid }, in: 0, out: piece, at: i * piece, video: null, audio: 'A1' }));
      const ac = new AbortController();
      const seen = [];
      const t0 = performance.now();
      const cut = await Cut.export.run({ project: long.project, seqId: long.project.sequences[0].id, path: ${S(P('cancel.m4a'))}, preset: 'audio-m4a', overrides: { loudness: null }, signal: ac.signal,
        onProgress: (q) => { if (q.phase === 'audio' && q.fraction > 0) { seen.push(q.fraction); if (seen.length === 1) ac.abort(); } } });
      return { ok: done.ok, error: done.error, sidecars: done.sidecars, cancelled: cut.code, ms: Math.round(performance.now() - t0), seen: seen.length, tracks: seq.captions.length,
        seconds: Math.round(Cut.model.sequenceDuration(long.project.sequences[0]) / T) };
    })()`);
    const names = (r2.sidecars || []).map((x) => x.split(/[\\/]/).pop());
    check(r2.ok && names.length === r2.tracks && new Set(names.map((x) => x.toLowerCase())).size === names.length && names.every((n) => existsSync(P(n))),
      `caption tracks of one language get an SRT each (${S(names)}${r2.ok ? '' : `, ${r2.error}`})`);
    check(r2.seen >= 1 && r2.cancelled === 'cancelled' && !existsSync(P('cancel.m4a')), `an audio-only export shows its progress and stops on Cancel (${S({ seconds: r2.seconds, progress: r2.seen, code: r2.cancelled, ms: r2.ms })})`);
    // Burned in: the exported frame at 1.2 s (range frame 6) matches the compositor with captions, not without.
    const cap = await js(`(async () => {
      const p = __cx.projects.s1;
      const T = Cut.time.TICKS;
      const d = await __cx.decodeVideo(${S(out)}, { keep: [6] });
      const px = __cx.pixels.get(${S(out)}).get(6);
      const comp = await Cut.compositor.create(new OffscreenCanvas(1280, 720), { width: 1280, height: 720, backend: __cx.backend });
      const t = Cut.time.frameStart(36, [30, 1]);
      const withC = await __cx.compFrame(comp, p.history.project, p.seq, t, { captions: p.cc });
      const without = await __cx.compFrame(comp, p.history.project, p.seq, t);
      comp.destroy();
      // The bottom fifth, where the caption is.
      const part = (a) => a.subarray(1280 * 4 * 576);
      return { withC: Cut.export.psnr(part(px), part(withC)), without: Cut.export.psnr(part(px), part(without)) };
    })()`);
    check(cap.withC >= 35 && cap.without < cap.withC - 5, `captions are burned in (PSNR with ${cap.withC.toFixed(1)} dB, without ${cap.without.toFixed(1)} dB)`);
  }
  const chap = await js(`Cut.export.chapters(__cx.projects.s1.history.project.sequences[0])`);
  check(chap === '00:00 Start\n00:03 Second part', `chapters text (${S(chap)})`);
  const png = P('frame.png');
  const fr = await js(`(async () => { const p = __cx.projects.s1; return Cut.export.exportFrame(p.history.project, p.seq, Cut.time.frameStart(120, [30, 1]), ${S(png)}, { backend: __cx.backend }); })()`);
  const n = fr.ok ? await js(`(async () => {
    const st = await ide.api.invoke('cut:stat', ${S(png)});
    const bytes = await ide.api.invoke('cut:read', ${S(png)}, 0, st.size);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, n: Cut.testsrc.readFrameNumber(g.getImageData(0, 0, bmp.width, bmp.height).data, bmp.width, bmp.height), png: bytes[1] === 0x50 && bytes[2] === 0x4e };
  })()`) : null;
  check(fr.ok && n?.png && n.w === 1280 && n.n === expectedN(120), `export frame: a 1280x720 PNG of source frame ${expectedN(120)} (${S(n || fr)})`);
}

if (want('cancel')) {
  await buildS1();
  const out = P('cancelled.mp4');
  const r = await js(`(async () => {
    const p = __cx.projects.s1;
    const ac = new AbortController();
    let partSeen = false;
    const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(out)}, preset: '720p', signal: ac.signal, backend: __cx.backend,
      onProgress: (x) => { if (x.phase === 'video' && x.fraction > 0.25 && !ac.signal.aborted) { partSeen = true; ac.abort(); } } });
    return { ...r, partSeen };
  })()`);
  check(!r.ok && r.code === 'cancelled' && r.partSeen, `cancel at a quarter: ${S(r)}`);
  const left = await js(`Promise.all([ide.api.invoke('cut:stat', ${S(out)}), ide.api.invoke('cut:stat', ${S(`${out}.part`)})])`);
  check(left.every((x) => x.missing) && !existsSync(out) && !existsSync(`${out}.part`), `cancel leaves no file and no part file (${S(left)})`);

  // a decoder that takes the video but never gives a frame (a codec this PC accepts and cannot decode): the export
  // fails and names the codec, instead of staying at 0 % (a proxy job sat there for good)
  const stuckOut = P('stuck.mp4');
  const stuck = await js(`(async () => {
    const p = __cx.projects.s1;
    const orig = Cut.decoder.createFrameSource;
    Cut.decoder.createFrameSource = (...a) => { const s = orig(...a); s.frameAt = () => new Promise(() => {}); return s; };
    const t0 = performance.now();
    try {
      const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(stuckOut)}, preset: '720p', backend: __cx.backend, frameLimitMs: 1500 });
      return { ok: r.ok, code: r.code, error: String(r.error || ''), ms: Math.round(performance.now() - t0) };
    } finally { Cut.decoder.createFrameSource = orig; }
  })()`);
  check(!stuck.ok && stuck.code === 'decode' && /codec avc1/.test(stuck.error) && stuck.ms < 15000 && !existsSync(stuckOut) && !existsSync(`${stuckOut}.part`),
    `a decoder that never gives a frame ends the export with the codec named, and no file (${S(stuck)})`);

  // the disk fills up on the way: the export stops at the refused write, where it rendered on to 100 % and failed then
  const fullOut = P('full.mp4');
  const full = await js(`(async () => {
    const p = __cx.projects.s1;
    const invoke = ide.api.invoke;
    let done = 0;
    let doneAtFailure = null;
    ide.api.invoke = (channel, ...a) => {
      if (channel === 'cut:writeAt' && doneAtFailure === null) doneAtFailure = done;
      if (channel === 'cut:writeAt') return Promise.resolve({ error: 'the disk is full', code: 'diskFull' });
      return invoke(channel, ...a);
    };
    try {
      const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(fullOut)}, preset: '720p', overrides: { bitrate: 30e6, mode: 'constant' }, backend: __cx.backend,
        onProgress: (x) => { if (x.phase === 'video') done = Math.max(done, x.done); } });
      return { ok: r.ok, code: r.code, error: String(r.error || ''), doneAtFailure, done };
    } finally { ide.api.invoke = invoke; }
  })()`);
  check(!full.ok && full.code === 'diskFull' && /disk is full/.test(full.error) && full.doneAtFailure !== null && full.doneAtFailure < S1_FRAMES * 0.8 && full.done - full.doneAtFailure <= 40,
    `a full disk stops the export within a few frames of the refused write (${S(full)})`);
  check(!existsSync(fullOut) && !existsSync(`${fullOut}.part`), 'and leaves no file and no part file');

  // an encoder that stops taking frames: Cancel still ends the export, where the wait for its queue never ended
  const heldOut = P('held.mp4');
  const held = await js(`(async () => {
    const p = __cx.projects.s1;
    const Real = window.VideoEncoder;
    const ac = new AbortController();
    let n = 0;
    let abortedAt = 0;
    window.VideoEncoder = class extends Real {
      encode(...a) {
        if (++n === 40) setTimeout(() => { abortedAt = performance.now(); ac.abort(); }, 300);
        return super.encode(...a);
      }
      get encodeQueueSize() { return n >= 40 ? 99 : super.encodeQueueSize; }
      flush() { return n >= 40 ? new Promise(() => {}) : super.flush(); }
    };
    try {
      const r = await Promise.race([
        Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(heldOut)}, preset: '720p', backend: __cx.backend, signal: ac.signal }),
        new Promise((resolve) => setTimeout(() => resolve({ code: 'hung' }), 20000)),
      ]);
      return { code: r.code, n, ms: abortedAt ? Math.round(performance.now() - abortedAt) : null };
    } finally { window.VideoEncoder = Real; }
  })()`);
  check(held.code === 'cancelled' && held.ms !== null && held.ms < 3000, `Cancel ends an export whose encoder stopped taking frames (${S(held)})`);
  await sleep(500);
  check(!existsSync(heldOut) && !existsSync(`${heldOut}.part`), 'and leaves no file and no part file');
}

// A source that stops giving its picture or sound during the export (a drive unplugged, a damaged packet), and a lost
// GPU device: the export fails naming the clip and the time and leaves no file, where it wrote red "Media Cannot Be
// Shown" frames and silence and said "Checked". Media offline when the export starts still exports (the dialog asked)
// and the result lists it.
if (want('fail')) {
  await buildS1();
  const gone = (file) => js(`Promise.all([ide.api.invoke('cut:stat', ${S(file)}), ide.api.invoke('cut:stat', ${S(`${file}.part`)})]).then((l) => l.every((x) => x.missing))`);
  const pictureOut = P('unplugged.mp4');
  const pic = await js(`(async () => {
    const p = __cx.projects.s1;
    const orig = Cut.decoder.createFrameSource;
    let unplugged = false;
    Cut.decoder.createFrameSource = (...a) => {
      const s = orig(...a);
      const frameAt = s.frameAt.bind(s);
      s.frameAt = (t) => (unplugged ? Promise.reject(Object.assign(new Error('the device is not ready'), { code: 'io' })) : frameAt(t));
      return s;
    };
    try {
      const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(pictureOut)}, preset: '720p', backend: __cx.backend,
        onProgress: (x) => { if (x.phase === 'video' && x.done >= 60) unplugged = true; } });
      return { ok: r.ok, code: r.code, error: String(r.error || ''), clip: r.clip, t: r.t / Cut.time.TICKS, name: p.history.project.sequences[0].clips.find((c) => c.id === r.clip)?.name };
    } finally { Cut.decoder.createFrameSource = orig; }
  })()`);
  check(!pic.ok && pic.code === 'media' && pic.name && pic.error.includes(pic.name) && /00:00:0[23]:\d\d/.test(pic.error) && /device is not ready/.test(pic.error) && pic.t >= 2 && pic.t < 3.5,
    `a source whose frames stop coming at 2 s ends the export with the clip, the time and the reason named (${S(pic)})`);
  check(await gone(pictureOut), 'and leaves no file and no part file');

  // the sound: a 300 s clip whose reader fails past 130 s of its source (the first load reads 120 s)
  const soundOut = P('unplugged.m4a');
  const snd = await js(`(async () => {
    const C = Cut;
    const T = C.time.TICKS;
    const file = ${S(P('long-sound.wav'))};
    await C.export.saveBytes(file, new Uint8Array(64));
    const h = C.commands.createHistory(C.model.createProject({ sequence: { w: 1280, h: 720, fps: [30, 1] } }));
    const seq = h.project.sequences[0].id;
    const [m] = h.do(C.commands.importMedia([{ path: file, name: 'long-sound.wav', kind: 'audio', size: 64, mtime: 1, duration: 300 * T, video: null, audio: { rate: 48000, channels: 2 } }])).ids;
    const clip = h.do(C.commands.place(seq, { source: { media: m }, in: 0, out: 300 * T, at: 0, video: null, audio: 'A1', mode: 'overwrite' })).ids[0];
    h.do(C.commands.setClip(seq, clip, { name: 'Narration' }));
    const getAudio = async () => ({ rate: 48000, length: 300 * 48000, read: async (a, b) => {
      if (b > 130 * 48000) throw new Error('the device is not ready');
      const L = new Float32Array(b - a).fill(0.1);
      return [L, L.slice()];
    } });
    const r = await C.export.run({ project: h.project, seqId: seq, path: ${S(soundOut)}, preset: 'audio-m4a', overrides: { loudness: null }, getAudio });
    return { ok: r.ok, code: r.code, error: String(r.error || ''), clip: r.clip === clip, t: r.t / T };
  })()`);
  check(!snd.ok && snd.code === 'media' && snd.clip && /Narration/.test(snd.error) && /device is not ready/.test(snd.error) && snd.t > 100 && snd.t <= 130,
    `a sound source that cannot be read past 130 s ends an audio export with the clip and the time named (${S(snd)})`);
  check(await gone(soundOut), 'and leaves no file and no part file');

  // a GPU device lost on the way
  const lostOut = P('lost.mp4');
  const lost = await js(`(async () => {
    const p = __cx.projects.s1;
    const compositor = async (canvas, o) => {
      const c = await Cut.compositor.create(canvas, o);
      let n = 0;
      const render = c.render.bind(c);
      c.render = (...a) => { n++; return render(...a); };
      Object.defineProperty(c, 'lost', { get: () => (n > 30 ? { reason: 'unknown', message: 'the test lost the device' } : null) });
      return c;
    };
    const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(lostOut)}, preset: '720p', backend: __cx.backend, compositor });
    return { ok: r.ok, code: r.code, error: String(r.error || '') };
  })()`);
  check(!lost.ok && lost.code === 'compositor' && /device was lost: the test lost the device/.test(lost.error), `a lost GPU device ends the export (${S(lost)})`);
  check(await gone(lostOut), 'and leaves no file and no part file');

  // offline when the export starts: the red picture and silence, as the dialog said, and the result lists the clip
  const offSrc = P('offline-src.mp4');
  const made = await js(`__cx.src(${S(offSrc)}, { seconds: 2, fps: [30, 1], w: 640, h: 360 })`);
  const offOut = P('offline.mp4');
  await js(`(async () => {
    const C = Cut;
    const T = C.time.TICKS;
    const h = C.commands.createHistory(C.model.createProject({ sequence: { w: 640, h: 360, fps: [30, 1] } }));
    const [m] = await __cx.importFiles(h, [${S(offSrc)}]);
    const seq = h.project.sequences[0].id;
    h.do(C.commands.place(seq, { source: { media: m }, in: 0, out: 2 * T, at: 0, video: 'V1', audio: 'A1', mode: 'overwrite' }));
    __cx.projects.offline = { history: h, seq };
    return true;
  })()`);
  unlinkSync(offSrc);
  const off = await js(`(async () => {
    const p = __cx.projects.offline;
    Cut.media.forget(${S(offSrc)});
    const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(offOut)}, preset: '720p', backend: __cx.backend, overrides: { loudness: null } });
    return { ok: r.ok, code: r.code, error: r.error, frames: r.frames, offline: r.offline?.length, problems: r.verified?.problems?.map((x) => x.code) };
  })()`);
  check(made.ok && off.ok && off.frames === 60 && off.offline === 2 && off.problems?.includes('offline') && !off.problems.includes('frames'),
    `media offline from the start still exports, as the red picture, and the check lists its clips (${S(off)})`);

  // faststart that cannot run (no room for its copy): the finished file is kept and the check says why it is not
  // faststart, where the export failed and pointed at a file that was whole
  const slowOut = P('slow-start.mp4');
  const slow = await js(`(async () => {
    const p = __cx.projects.offline;
    const invoke = ide.api.invoke;
    ide.api.invoke = (channel, ...a) => (channel === 'cut:faststart' ? Promise.resolve({ error: 'there is not enough free space to move the index to the front', code: 'diskFull' }) : invoke(channel, ...a));
    try {
      const r = await Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(slowOut)}, preset: '720p', backend: __cx.backend, overrides: { loudness: null } });
      return { ok: r.ok, faststart: r.faststart, frames: r.verified?.frames, problems: r.verified?.problems?.map((x) => x.code), said: r.verified?.problems?.find((x) => x.code === 'faststart')?.params?.error };
    } finally { ide.api.invoke = invoke; }
  })()`);
  check(slow.ok && slow.faststart === false && slow.frames === 60 && slow.problems?.includes('faststart') && /free space/.test(slow.said) && existsSync(slowOut),
    `a faststart that cannot run keeps the exported file and names the reason in the check (${S(slow)})`);
}

// "Export" renders a copy of the project made when it is pressed: a ripple delete while it runs changes neither the
// file's frames nor its length (it rendered the live project, so the rest of the file showed the edit).
if (want('live')) {
  await buildS1();
  const out = P('live-edit.mp4');
  const r = await js(`(async () => {
    const C = Cut;
    Cut.app.setHistory(C.commands.createHistory(JSON.parse(JSON.stringify(__cx.projects.s1.history.project))), null, 'open');
    const f = Cut.ui.exportDialog.open(Cut.app);
    const set = (sel, v, ev = 'change') => { sel.value = v; sel.dispatchEvent(new Event(ev)); };
    set(f.fields.presetSel, '720p');
    set(f.fields.loudSel, 'off');
    set(f.fields.pathIn, ${S(out)}, 'input');
    const done = f.start();
    const fill = () => parseFloat(document.querySelector('#cutExportDialog .cut-progress-fill')?.style.width || '0');
    for (let i = 0; i < 600 && !(Cut.ui.exportDialog.running && fill() > 30); i++) await new Promise((res) => setTimeout(res, 20));
    const seq = Cut.app.sequence;
    const second = seq.clips.find((c) => c.track === 'V1' && c.start === 3 * C.time.TICKS);
    const during = !!Cut.ui.exportDialog.running;
    Cut.app.history.do(C.commands.remove(seq.id, [second.id], { ripple: true }));
    const shorter = C.model.sequenceDuration(Cut.app.sequence) / C.time.TICKS;
    const res = await done;
    Cut.app.history.undo();
    f.dialog?.close?.();
    document.querySelector('#cutExportDialog')?.closest('.dialog-backdrop')?.querySelector('.dialog-buttons button:last-child')?.click();
    return { ok: res?.ok, code: res?.code, error: res?.error, frames: res?.frames, verified: res?.verified?.ok, during, shorter, path: res?.path };
  })()`);
  check(r.ok && r.during && r.shorter === 5 && r.frames === S1_FRAMES && r.verified, `Export runs on while the timeline is ripple-deleted to ${r.shorter} s (${S(r)})`);
  if (r.ok) await checkEdit('the export of a project edited while it ran', out);
}

if (want('loudness')) {
  // A 10 s 1 kHz sine at -20 dBFS in both channels, as WAV bytes the test builds.
  const wav = P('tone.wav');
  const made = await js(`(async () => {
    const rate = 48000, n = rate * 10, ch = 2;
    const b = new Uint8Array(44 + n * ch * 2);
    const v = new DataView(b.buffer);
    const str = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * ch * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.round(0.1 * Math.sin((2 * Math.PI * 1000 * i) / rate) * 32767);
      v.setInt16(44 + i * 4, s, true);
      v.setInt16(46 + i * 4, s, true);
    }
    const saved = await Cut.export.saveBytes(${S(wav)}, b);
    const C = Cut;
    const T = C.time.TICKS;
    const project = C.model.createProject({ sequence: { w: 1280, h: 720, fps: [30, 1] } });
    const h = C.commands.createHistory(project);
    const [m] = await __cx.importFiles(h, [${S(wav)}]);
    const seq = h.project.sequences[0].id;
    h.do(C.commands.place(seq, { source: { media: m }, in: 0, out: 10 * T, at: 0, video: null, audio: 'A1', mode: 'overwrite' }));
    __cx.projects.tone = { history: h, seq };
    const buf = await C.audioengine.renderOffline(h.project, seq, 0, 10 * T, 48000);
    return { saved: saved.ok, mix: C.audioengine.loudness(buf), length: buf.length };
  })()`);
  check(made.saved && Math.abs(made.mix.integrated + 20) <= 0.5, `the mix of a -20 dBFS 1 kHz sine is -20 LUFS (${made.mix.integrated.toFixed(2)} LUFS, true peak ${made.mix.truePeak.toFixed(2)} dBTP)`);
  const m4a = P('tone.m4a');
  const r = await js(`(async () => { const p = __cx.projects.tone; return Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(m4a)}, preset: 'audio-m4a', overrides: { loudness: null } }); })()`);
  check(r.ok && r.verified?.ok && r.path.toLowerCase().endsWith('.m4a'), `audio only export: ${r.ok ? `${r.path} ${S(r.verified)}` : `${r.code}: ${r.error}`}`);
  if (r.ok) {
    await js(`__cx.decodeAudio(${S(r.path)})`);
    const l = await js(`__cx.loudness(${S(r.path)})`);
    check(Math.abs(l.integrated + 20) <= 0.5, `the exported M4A measures -20 LUFS within 0.5 LU (${l.integrated.toFixed(2)} LUFS, ${l.truePeak.toFixed(2)} dBTP)`);
    const probe = await js(`__cx.open(${S(r.path)}).then(({ source }) => ({ tracks: source.tracks.map((t) => t.kind + ':' + t.codec), duration: source.duration / Cut.time.TICKS }))`);
    check(S(probe.tracks) === S(['audio:mp4a.40.2']) && Math.abs(probe.duration - 10) < 0.05, `the M4A has one AAC track of 10 s (${S(probe)})`);
  }
  const m4aLoud = P('tone-14.m4a');
  const rl = await js(`(async () => { const p = __cx.projects.tone; return Cut.export.run({ project: p.history.project, seqId: p.seq, path: ${S(m4aLoud)}, preset: 'audio-m4a' }); })()`);
  if (rl.ok) {
    await js(`__cx.decodeAudio(${S(rl.path)})`);
    const l = await js(`__cx.loudness(${S(rl.path)})`);
    check(Math.abs(rl.loudnessGain - 6) <= 0.5 && Math.abs(l.integrated + 14) <= 0.5,
      `the preset's -14 LUFS target turns the -20 LUFS mix up to -14 LUFS (gain ${rl.loudnessGain} dB, ${l.integrated.toFixed(2)} LUFS, ${l.truePeak.toFixed(2)} dBTP)`);
  } else check(false, `export with the loudness target: ${rl.code}: ${rl.error}`);
  // The preview: the clock against the wall clock, the meters, mute.
  const pv = await js(`(async () => {
    const p = __cx.projects.tone;
    const app = Cut.state.createApp();
    app.setHistory(p.history);
    const eng = Cut.audioengine.create(app);
    const T = Cut.time.TICKS;
    await eng.start(2 * T);
    const w0 = performance.now();
    const n0 = eng.now();
    const samples = [];
    for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 100)); samples.push([performance.now() - w0, (eng.now() - n0) / T * 1000]); }
    const meters = eng.meters();
    p.history.do(Cut.commands.setTrack(p.seq, 'A1', { mute: true }));
    await new Promise((r) => setTimeout(r, 600));
    const muted = eng.meters();
    const state = eng.context?.state;
    eng.stop();
    const stopped = eng.now();
    await new Promise((r) => setTimeout(r, 200));
    const after = eng.now();
    // A shuttle rate: the clock runs twice as fast.
    await eng.start(T, 2);
    await new Promise((r) => setTimeout(r, 400));
    const a2 = eng.now();
    const w2 = performance.now();
    await new Promise((r) => setTimeout(r, 500));
    const slope = ((eng.now() - a2) / T) / ((performance.now() - w2) / 1000);
    await eng.close();
    p.history.do(Cut.commands.setTrack(p.seq, 'A1', { mute: false }));
    const drift = samples.slice(3).map(([w, n]) => n - w);
    const mono = samples.every((s, i) => i === 0 || s[1] >= samples[i - 1][1]);
    return { state, start: n0 / T, drift: [Math.min(...drift), Math.max(...drift)], mono, meters, muted, held: after === stopped, slope };
  })()`);
  check(pv.state === 'running', `the preview's AudioContext runs (${pv.state})`);
  check(Math.abs(pv.start - 2) < 0.1 && pv.mono && pv.drift[1] - pv.drift[0] < 30, `the preview clock starts at 2 s and follows the wall clock (drift ${pv.drift.map((x) => x.toFixed(1)).join('..')} ms)`);
  check(Math.abs(pv.meters.master + 20) < 0.5 && Math.abs(pv.meters.tracks.A1 + 20) < 0.5, `meters read -20 dBFS peaks (${S(pv.meters)})`);
  check(pv.muted.master === null || pv.muted.master < -100 || pv.muted.master === -Infinity, `a muted track is silent in the meters (${S(pv.muted)})`);
  check(pv.held, 'the clock holds after stop');
  check(Math.abs(pv.slope - 2) < 0.1, `at rate 2 the clock runs twice as fast (${pv.slope.toFixed(3)})`);
}

if (want('speed')) {
  // 60 s of 1080p30: a 10 s 1080p test source six times in a row.
  const srcB = P('B.mp4');
  const made = await js(`__cx.src(${S(srcB)}, { seconds: 10, fps: [30, 1], w: 1920, h: 1080 })`);
  check(made.ok, 'test source B (1080p, 10 s)');
  const out = P('speed.mp4');
  const r = await js(`(async () => {
    const C = Cut;
    const T = C.time.TICKS;
    const project = C.model.createProject({ sequence: { w: 1920, h: 1080, fps: [30, 1] } });
    const h = C.commands.createHistory(project);
    const [b] = await __cx.importFiles(h, [${S(srcB)}]);
    const seq = h.project.sequences[0].id;
    for (let k = 0; k < 6; k++) h.do(C.commands.place(seq, { source: { media: b }, in: 0, out: 10 * T, at: k * 10 * T, video: 'V1', audio: 'A1', mode: 'overwrite' }));
    const r = await C.export.run({ project: h.project, seqId: seq, path: ${S(out)}, preset: 'youtube-1080p', backend: __cx.backend });
    return r;
  })()`);
  check(r.ok && r.frames === 1800 && r.verified?.ok, `60 s 1080p30 export: ${r.ok ? `${r.seconds.toFixed(1)} s, ${S(r.encoder)}, ${S(r.verified)}` : `${r.code}: ${r.error}`}`);
  if (r.ok) log(`EXPORT SPEED: 60 s 1080p30 (youtube-1080p, ${r.encoder.hardware ? 'hardware' : 'software'} H.264) in ${r.seconds.toFixed(1)} s = ${r.speed.toFixed(2)}x realtime, ${(r.bytes / 1e6).toFixed(1)} MB`);
}

// Last: the exports in a <video> element through a blob URL of their bytes. The page's CSP has no blob: in
// media-src, so this step reloads the page with CSP bypassed (CDP Page.setBypassCSP applies to the next document).
if (want('video')) {
  const files = [P('edit-hw.mp4'), P('edit-sw.mp4')].filter((f) => existsSync(f));
  if (!files.length) check(false, 'no exported file to play (run the export section)');
  else {
    await cdp('Page.setBypassCSP', { enabled: true });
    await ctx.reload({ until: 'window.__ideReady === true && !!window.Cut && !!Cut.testsrc' });
    await js('Cut.loaded');
    for (const file of files) {
      const v = await js(`(async () => {
        const st = await ide.api.invoke('cut:stat', ${S(file)});
        const bytes = await ide.api.invoke('cut:read', ${S(file)}, 0, st.size);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        const v = document.createElement('video');
        v.muted = true;
        v.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:99999';
        document.body.appendChild(v);
        const once = (ev, ms = 10000) => new Promise((res, rej) => {
          const tm = setTimeout(() => rej(new Error('no ' + ev)), ms);
          v.addEventListener(ev, () => { clearTimeout(tm); res(); }, { once: true });
          v.addEventListener('error', () => { clearTimeout(tm); rej(new Error('video error ' + v.error?.code + ' ' + (v.error?.message || ''))); }, { once: true });
        });
        v.src = url;
        try {
          await once('loadeddata');
          const out = { duration: v.duration, w: v.videoWidth, h: v.videoHeight, seeks: [] };
          const g = new OffscreenCanvas(1280, 720).getContext('2d', { willReadFrequently: true });
          // Seeks to the middle of sequence frames; the frame is read once the element has presented it.
          for (const j of [120, 30, 200, 120]) {
            const shown = new Promise((res) => { v.requestVideoFrameCallback(() => res()); setTimeout(res, 1000); });
            v.currentTime = (j + 0.5) / 30;
            await once('seeked');
            await shown;
            g.drawImage(v, 0, 0, 1280, 720);
            out.seeks.push([j, Cut.testsrc.readFrameNumber(g.getImageData(0, 0, 1280, 720).data, 1280, 720)]);
          }
          out.n = out.seeks.at(-1)[1];
          const t0 = v.currentTime;
          await v.play();
          await new Promise((r) => setTimeout(r, 700));
          out.advanced = +(v.currentTime - t0).toFixed(3);
          v.pause();
          return out;
        } catch (err) { return { error: err.message }; } finally { v.remove(); URL.revokeObjectURL(url); }
      })()`);
      const name = path.basename(file);
      check(!v.error && Math.abs(v.duration - 7) < 0.05 && v.w === 1280 && v.h === 720, `<video> opens ${name} (${S(v)})`);
      check(v.seeks?.every(([j, n]) => n === expectedN(j)), `<video> shows the expected frames of ${name} after seeks (${S(v.seeks?.map(([j, n]) => `${j}:${n}/${expectedN(j)}`))})`);
      check(v.advanced > 0.3, `<video> plays ${name} (${v.advanced} s in 0.7 s)`);
    }
    await cdp('Page.setBypassCSP', { enabled: false });
  }
}

ctx.finish();
