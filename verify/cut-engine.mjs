// Nano Studio Cut's engine in the real app (mode 'cut'): media, decoder, compositor, effects, text, player, thumbs.
// The suite makes its own media in the page (no downloads): MP4s whose frame N shows N as a row of 16 black/white
// blocks (VideoEncoder + Cut.mp4write, written through the cut:write* sink), a WAV and an AAC tone, PNG images. It
// drives the engine directly on a canvas of its own (it does not need the editor's screen).
// Checks: frame accuracy (frame N of 24, 29.97, 30 and 60 fps sources is shown where the frame math says in a 30 fps
// sequence, also at speed 2x and reversed, in an order that seeks backwards and far forward); position, scale,
// rotation, anchor, crop, opacity and keyframed position read back from the pixels; every video effect against its
// CPU reference on a known image (grain and glitch at given frames, the same anywhere inside a frame and from a new
// compositor); each transition at known points (the dissolve's midpoint is the average) and every one against its CPU
// reference on two pictures; Korean
// text drawn with the font from cut:fontData; captions burned in; offline media drawn red; import errors; audio decoded
// to PCM (WAV and AAC); a one-GOP clip played through a frame cache that fills by bytes before its frame count, with
// no restart at the sync sample; thumbnails and peaks with their caches; the player playing a 1080p30 H.264 clip for
// 10 s with seeks, the measured fps, and no VideoFrame left open afterwards; the Canvas 2D fallback drawing the same
// layout.
// Usage: powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1 -Out verify/out/cut-engine.log -TimeoutMinutes 20 node verify/cut-engine.mjs
import { rmSync } from 'fs';
import { launch, tempDir } from './lib.mjs';

const home = tempDir('cut-engine-home');
const ctx = await launch({ fixture: 'core', port: 9753, name: 'cut-engine', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, check, until } = ctx;
const S = JSON.stringify;
const MINE = /(effects|textrender|media|decoder|compositor|player|thumbs)\.js/;

// ---- page helpers ------------------------------------------------------------------------------------------------
function pageHelpers() {
  const T = Cut.time;
  const H = {};
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  H.sleep = sleep;

  H.home = null;
  H.write = async (name, bytes) => {
    if (!H.home) H.home = await ide.api.invoke('cut:home');
    const path = `${H.home.projects}\\${name}`;
    const o = await ide.api.invoke('cut:writeOpen', path);
    if (o.error) throw new Error(`writeOpen: ${o.error}`);
    const STEP = 8 << 20;
    for (let i = 0; i < bytes.length; i += STEP) {
      const r = await ide.api.invoke('cut:writeAt', o.id, bytes.subarray(i, i + STEP));
      if (r.error) throw new Error(`writeAt: ${r.error}`);
    }
    const c = await ide.api.invoke('cut:writeClose', o.id, { commit: true });
    if (!c.ok) throw new Error(`writeClose: ${c.error}`);
    return c.path || path;
  };

  // Frame n: a gray picture with n in 16 blocks across the top sixth (white = 1, most significant first) and in digits.
  H.drawNumber = (g, n, w, h) => {
    g.fillStyle = '#404040';
    g.fillRect(0, 0, w, h);
    const bh = Math.round(h / 6);
    for (let b = 0; b < 16; b++) {
      const x0 = Math.round((b * w) / 16);
      const x1 = Math.round(((b + 1) * w) / 16);
      g.fillStyle = (n >> (15 - b)) & 1 ? '#ffffff' : '#000000';
      g.fillRect(x0, 0, x1 - x0, bh);
    }
    g.fillStyle = '#ffffff';
    g.font = `700 ${Math.round(h / 3)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), w / 2, h * 0.6);
  };
  H.readNumber = (rgba, w, h) => {
    let n = 0;
    const y = Math.round(h / 12);
    for (let b = 0; b < 16; b++) {
      const x = Math.floor(((b + 0.5) * w) / 16);
      const i = (y * w + x) * 4;
      n = (n << 1) | ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 > 128 ? 1 : 0);
    }
    return n;
  };

  function memorySink() {
    const parts = [];
    const patches = [];
    let size = 0;
    return {
      sink: {
        write: async (bytes, position) => {
          if (position === undefined) { parts.push(bytes.slice()); size += bytes.length; } else patches.push({ position, bytes: bytes.slice() });
        },
      },
      bytes() {
        const out = new Uint8Array(size);
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        for (const p of patches) out.set(p.bytes, p.position);
        return out;
      },
    };
  }

  // An H.264 MP4 of numbered frames.
  // times: presentation times (ticks) for a variable frame rate; else frame i is at frameStart(i, fps).
  H.makeMp4 = async ({ w, h, fps, frames, gop = 30, hw = 'prefer-software', bitrate = 2e6, times = null }) => {
    const at = (i) => (times ? times[i] : T.frameStart(i, fps));
    const lengthOf = (i) => (times ? (i + 1 < times.length ? times[i + 1] - times[i] : times[i] - times[i - 1]) : T.frameTicks(fps));
    const chunks = [];
    let config = null;
    let err = null;
    const byMicros = new Map();
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig && !config) config = meta.decoderConfig;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, key: chunk.type === 'key', us: chunk.timestamp });
      },
      error: (e) => { err = e; },
    });
    enc.configure({ codec: 'avc1.640028', width: w, height: h, bitrate, framerate: fps[0] / fps[1], hardwareAcceleration: hw, avc: { format: 'avc' }, latencyMode: 'quality' });
    const cv = new OffscreenCanvas(w, h);
    const g = cv.getContext('2d');
    for (let i = 0; i < frames && !err; i++) {
      H.drawNumber(g, i, w, h);
      const us = T.toMicros(at(i));
      byMicros.set(us, i);
      const f = new VideoFrame(cv, { timestamp: us, duration: T.toMicros(T.frameTicks(fps)) });
      enc.encode(f, { keyFrame: i % gop === 0 });
      f.close();
      while (enc.encodeQueueSize > 6) await sleep(1);
    }
    await enc.flush();
    enc.close();
    if (err) throw err;
    const desc = config.description instanceof ArrayBuffer ? new Uint8Array(config.description) : new Uint8Array(config.description.buffer, config.description.byteOffset, config.description.byteLength);
    // Decode order is output order; dts are frame slots shifted so that no pts comes before its dts.
    const index = chunks.map((c) => byMicros.get(c.us));
    const pts = index.map(at);
    const sorted = pts.slice().sort((a, b) => a - b);
    const shift = Math.max(0, ...sorted.map((d, j) => d - pts[j]));
    const m = memorySink();
    const writer = Cut.mp4write.create({ video: { codec: config.codec, width: w, height: h, description: desc, frameRate: fps }, audio: null, sink: m.sink });
    let reordered = 0;
    for (let j = 0; j < chunks.length; j++) {
      const dts = sorted[j] - shift;
      if (pts[j] !== sorted[j]) reordered++;
      await writer.addVideo({ data: chunks[j].data, timestamp: pts[j], duration: lengthOf(index[j]), key: chunks[j].key, compositionOffset: pts[j] - dts });
    }
    await writer.finish();
    return { bytes: m.bytes(), codec: config.codec, reordered, keys: chunks.filter((c) => c.key).length };
  };

  H.makeWav = (seconds, freq, rate = 48000) => {
    const n = Math.round(seconds * rate);
    const b = new DataView(new ArrayBuffer(44 + n * 4));
    const s = (o, t) => { for (let i = 0; i < 4; i++) b.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); b.setUint32(4, 36 + n * 4, true); s(8, 'WAVE'); s(12, 'fmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 2, true); b.setUint32(24, rate, true);
    b.setUint32(28, rate * 4, true); b.setUint16(32, 4, true); b.setUint16(34, 16, true); s(36, 'data'); b.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      b.setInt16(44 + i * 4, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767), true);
      b.setInt16(46 + i * 4, 0, true);
    }
    return new Uint8Array(b.buffer);
  };
  H.makeAac = async (seconds, freq) => {
    const rate = 48000;
    const support = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 2, bitrate: 128000 }).catch(() => null);
    if (!support?.supported) return null;
    const chunks = [];
    let config = null;
    const enc = new AudioEncoder({ output: (c, meta) => { if (meta?.decoderConfig && !config) config = meta.decoderConfig; const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ d, us: c.timestamp, dur: c.duration }); }, error: () => {} });
    enc.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 2, bitrate: 128000 });
    const block = 1024;
    const total = Math.round(seconds * rate);
    for (let at = 0; at < total; at += block) {
      const n = Math.min(block, total - at);
      const pcm = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) pcm[i] = Math.sin((2 * Math.PI * freq * (at + i)) / rate) * 0.5;
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at / rate) * 1e6), data: pcm }));
    }
    await enc.flush();
    enc.close();
    const m = memorySink();
    const desc = config.description ? new Uint8Array(config.description instanceof ArrayBuffer ? config.description : config.description.buffer) : null;
    const writer = Cut.mp4write.create({ video: null, audio: { codec: 'mp4a.40.2', sampleRate: rate, channels: 2, description: desc }, sink: m.sink });
    for (const c of chunks) await writer.addAudio({ data: c.d, timestamp: T.fromMicros(c.us), duration: T.fromMicros(c.dur || Math.round((1024 / rate) * 1e6)) });
    await writer.finish();
    return m.bytes();
  };
  H.png = async (w, h, paint) => {
    const c = new OffscreenCanvas(w, h);
    paint(c.getContext('2d'), w, h);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  };

  H.history = (w, h, fps = [30, 1]) => Cut.commands.createHistory(Cut.model.createProject({ sequence: { w, h, fps } }));
  H.importAll = async (hist, paths) => {
    const list = await Cut.media.importFiles(paths);
    const bad = list.filter((m) => m.error);
    if (bad.length) throw new Error(`import: ${JSON.stringify(bad)}`);
    return hist.do(Cut.commands.importMedia(list)).ids;
  };
  H.canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  H.px = (rgba, w, x, y) => { const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  H.bbox = (rgba, w, h, test) => {
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (test(rgba[i], rgba[i + 1], rgba[i + 2])) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1];
  };
  // The linear premultiplied image of a bitmap, as the CPU references take it.
  H.linearOf = (bitmap) => {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d');
    g.drawImage(bitmap, 0, 0);
    const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const img = Cut.effects.cpu.image(bitmap.width, bitmap.height);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      img.data.set([Cut.effects.srgbToLinear(d[i] / 255) * a, Cut.effects.srgbToLinear(d[i + 1] / 255) * a, Cut.effects.srgbToLinear(d[i + 2] / 255) * a, a], i);
    }
    return img;
  };
  // A CPU image composited over a background color, encoded to sRGB bytes.
  H.encode = (img, bg = [0, 0, 0]) => {
    const out = new Uint8Array(img.w * img.h * 4);
    for (let i = 0; i < img.w * img.h; i++) {
      const a = img.data[i * 4 + 3];
      for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(Cut.effects.linearToSrgb(Math.max(0, Math.min(1, img.data[i * 4 + k] + bg[k] * (1 - a)))) * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  };
  H.diff = (a, b) => {
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = Math.abs(a[i + k] - b[i + k]); max = Math.max(max, d); sum += d; n++; }
    return { max, mean: sum / n };
  };
  return H;
}

try {
  await until('!!(window.Cut && Cut.loaded)', 'Cut scripts', 30000);
  await js('Cut.loaded');
  const engine = await js(`['effects', 'textrender', 'media', 'decoder', 'compositor', 'player', 'thumbs', 'model', 'commands'].filter((n) => !Cut[n])`);
  check(engine.length === 0, `the engine's modules are loaded (${engine.join(', ') || 'all'})`);
  await js(`(window.__eng = (${pageHelpers.toString()})(), true)`);

  // ---- WebGPU, pipelines ----
  const gpu = await js(`(async () => {
    const c = __eng.canvas(640, 360);
    window.__comp = await Cut.compositor.create(c, { width: 640, height: 360 });
    return { backend: __comp.backend, info: __comp.info };
  })()`);
  check(gpu.backend === 'webgpu', `the compositor runs on WebGPU (${S(gpu.info)})`);
  console.log(`NOTE WebGPU adapter: ${S(gpu.info)}`);

  // ---- media: numbered clips at 24, 29.97, 30, 60 fps ----
  const made = await js(`(async () => {
    const out = {};
    for (const [name, fps] of [['24', [24, 1]], ['2997', [30000, 1001]], ['30', [30, 1]], ['60', [60, 1]]]) {
      const frames = Math.round(3 * fps[0] / fps[1]) + (name === '2997' ? 1 : 0);
      const r = await __eng.makeMp4({ w: 640, h: 360, fps, frames, gop: Math.round(fps[0] / fps[1]) });
      out[name] = { path: await __eng.write('num-' + name + '.mp4', r.bytes), frames, fps, reordered: r.reordered, keys: r.keys };
    }
    return out;
  })()`);
  check(Object.keys(made).length === 4, `four numbered clips made (${Object.values(made).map((m) => `${m.frames}f/${m.keys} keys/${m.reordered} reordered`).join(', ')})`);
  const imported = await js(`(async () => {
    const list = await Cut.media.importFiles(${S(Object.values(made).map((m) => m.path))});
    return list.map((m) => ({ kind: m.kind, w: m.video?.w, h: m.video?.h, fps: m.video?.fps, duration: m.duration, codec: m.video?.codec, error: m.error }));
  })()`);
  check(imported.every((m) => m.kind === 'video' && m.w === 640 && m.h === 360 && !m.error), `import: video entries 640x360 (${S(imported.map((m) => m.codec))})`);
  check(S(imported.map((m) => m.fps)) === S(Object.values(made).map((m) => m.fps)), `import: frame rates ${S(imported.map((m) => m.fps))}`);

  // ---- frame accuracy ----
  // Expected frame numbers come from exact rational arithmetic, not from the engine: a 30 fps sequence frame k is at
  // k/30 s; at speed s the source time is s*k/30; the frame shown is the last one starting at or before it.
  const ks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 80, 81, 5, 60, 61, 62, 30, 89, 0, 45, 46, 44, 29, 31, 88, 2, 70, 71];
  for (const [name, m] of Object.entries(made)) {
    const [fn, fd] = m.fps;
    for (const mode of ['normal', 'speed2', 'reverse']) {
      const r = await js(`(async () => {
        const T = Cut.time;
        const hist = __eng.history(640, 360, [30, 1]);
        const seq = hist.project.sequences[0].id;
        const [mid] = await __eng.importAll(hist, [${S(m.path)}]);
        const { ids: [cid] } = hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, video: 'V1', audio: null }));
        if (${S(mode)} === 'speed2') hist.do(Cut.commands.setClip(seq, cid, { speed: 2 }));
        if (${S(mode)} === 'reverse') hist.do(Cut.commands.setClip(seq, cid, { reverse: true }));
        const clip = hist.project.sequences[0].clips.find((c) => c.id === cid);
        const frames = Cut.model.clipDuration(clip) / T.frameTicks([30, 1]);
        const shown = [];
        for (const k of ${S(ks)}) {
          if (k >= frames) continue;
          await __comp.render(hist.project, seq, T.frameStart(k, [30, 1]));
          const px = await __comp.readPixels();
          shown.push([k, __eng.readNumber(px, 640, 360)]);
        }
        return { shown, frames, inT: clip.in, outT: clip.out };
      })()`);
      const ft = (254016000000 * fd) / fn;
      const want = (k) => {
        if (mode === 'normal') return Number((BigInt(k) * BigInt(fn)) / (30n * BigInt(fd)));
        if (mode === 'speed2') return Number((2n * BigInt(k) * BigInt(fn)) / (30n * BigInt(fd)));
        // Reversed: the first timeline frame shows the last source frame; along = k/30 s back from the out point.
        return Math.floor((r.outT - k * (254016000000 / 30) - 1) / ft);
      };
      const wrong = r.shown.filter(([k, n]) => n !== want(k));
      check(r.shown.length >= 20 && wrong.length === 0, `frame accuracy ${name} fps, ${mode}: ${r.shown.length} frames in seek order${wrong.length ? `; wrong [k, shown, want]: ${S(wrong.slice(0, 8).map(([k, n]) => [k, n, want(k)]))}` : ''}`);
    }
  }
  // A variable frame rate source: frames last 1, 2, 1 and 3 sixtieths of a second in turn.
  const vfr = await js(`(async () => {
    const T = Cut.time;
    const sixtieth = T.frameTicks([60, 1]);
    const times = [0];
    for (let i = 1; i < 100; i++) times.push(times[i - 1] + [1, 2, 1, 3][(i - 1) % 4] * sixtieth);
    const r = await __eng.makeMp4({ w: 640, h: 360, fps: [30, 1], frames: 100, gop: 30, times });
    const path = await __eng.write('vfr.mp4', r.bytes);
    const hist = __eng.history(640, 360, [30, 1]);
    const seq = hist.project.sequences[0].id;
    const list = await Cut.media.importFiles([path]);
    const [mid] = hist.do(Cut.commands.importMedia(list)).ids;
    hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, video: 'V1', audio: null }));
    const wrong = [];
    let n = 0;
    for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 20, 21, 9, 40, 41, 2, 55, 30, 31]) {
      const t = T.frameStart(k, [30, 1]);
      if (t >= times[99]) continue;
      let want = 0;
      while (want + 1 < times.length && times[want + 1] <= t) want++;
      await __comp.render(hist.project, seq, t);
      const got = __eng.readNumber(await __comp.readPixels(), 640, 360);
      n++;
      if (got !== want) wrong.push([k, got, want]);
    }
    return { vfr: list[0].video.vfr, fps: list[0].video.fps, n, wrong };
  })()`);
  check(vfr.vfr && vfr.n >= 15 && vfr.wrong.length === 0, `frame accuracy, variable frame rate source (vfr ${vfr.vfr}, nominal ${S(vfr.fps)}): ${vfr.n} frames${vfr.wrong.length ? `; wrong [k, shown, want]: ${S(vfr.wrong)}` : ''}`);
  const leakAfterSeeks = await js(`(async () => { await __comp.idle(); const s = __comp.stats(); return { open: Cut.decoder.stats().open, cached: s.decoders.reduce((n, d) => n + d.cached, 0), borrowed: s.decoders.reduce((n, d) => n + d.borrowed, 0), restarts: s.decoders.map((d) => d.restarts), hw: s.decoders.map((d) => d.hardware) }; })()`);
  check(leakAfterSeeks.borrowed === 0 && leakAfterSeeks.open === leakAfterSeeks.cached, `after the seeks every frame is back: open ${leakAfterSeeks.open} = cached ${leakAfterSeeks.cached}, lent 0 (restarts ${S(leakAfterSeeks.restarts)}, ${S(leakAfterSeeks.hw)})`);

  // ---- a compositor that stops rendering (a paused monitor) closes the decoders its last render did not use ----
  const idle = await js(`(async () => {
    const T = Cut.time.TICKS;
    const hist = __eng.history(640, 360);
    const [a, b] = await __eng.importAll(hist, [${S(made['30'].path)}, ${S(made['24'].path)}]);
    const seq = hist.project.sequences[0].id;
    hist.do(Cut.commands.place(seq, { source: { media: a }, in: 0, out: T, at: 0, video: 'V1', audio: null }));
    hist.do(Cut.commands.place(seq, { source: { media: b }, in: 0, out: T, at: T, video: 'V1', audio: null }));
    const comp = await Cut.compositor.create(__eng.canvas(640, 360), { width: 640, height: 360 });
    try {
      await comp.render(hist.project, seq, T / 2);
      await comp.render(hist.project, seq, T + T / 2);
      await comp.idle();
      const both = comp.stats().sources;
      await __eng.sleep(4500);
      return { both, left: comp.stats().sources };
    } finally { comp.destroy(); }
  })()`);
  check(idle.both === 2 && idle.left === 1, `left alone, the decoder of a clip the last frame did not show closes; the shown clip's stays (${S(idle)})`);

  // ---- the source monitor, proxies, software decoding, video in the 2D fallback ----
  const more = await js(`(async () => {
    const T = Cut.time;
    const hist = __eng.history(640, 360);
    const seq = hist.project.sequences[0].id;
    const [m30, m60] = await __eng.importAll(hist, [${S(made['30'].path)}, ${S(made['60'].path)}]);
    const app = Cut.state.createApp();
    app.setHistory(hist);
    const canvas = __eng.canvas(640, 360);
    const player = Cut.player.create({ app, canvas, mode: 'source' });
    await player.ready;
    app.setSource({ mediaId: m30, in: null, out: null, t: T.frameStart(45, [30, 1]) });
    await player.render();
    const source = __eng.readNumber(await player.compositor.readPixels(), 640, 360);
    player.destroy();
    hist.do(Cut.commands.place(seq, { source: { media: m30 }, at: 0, video: 'V1', audio: null }));
    hist.do(Cut.commands.setProxy(m30, { path: ${S(made['60'].path)} }));
    await __comp.render(hist.project, seq, T.fromSeconds(1));
    const original = __eng.readNumber(await __comp.readPixels(), 640, 360);
    await __comp.render(hist.project, seq, T.fromSeconds(1), { proxy: true });
    const proxied = __eng.readNumber(await __comp.readPixels(), 640, 360);
    const o = await Cut.media.open(hist.project, m60);
    const sw = Cut.decoder.createFrameSource(o, o.video, { hardware: false });
    const nums = [];
    for (const n of [0, 100, 37, 179]) {
      const f = await sw.frameAt(T.frameStart(n, [60, 1]));
      const c = new OffscreenCanvas(640, 360);
      const g = c.getContext('2d');
      g.drawImage(f, 0, 0);
      sw.release(f);
      nums.push(__eng.readNumber(g.getImageData(0, 0, 640, 360).data, 640, 360));
    }
    const swInfo = sw.stats().hardware;
    sw.close();
    const c2 = __eng.canvas(640, 360);
    const comp2 = await Cut.compositor.create(c2, { width: 640, height: 360, backend: '2d' });
    await comp2.render(hist.project, seq, T.frameStart(50, [30, 1]));
    const twoD = __eng.readNumber(await comp2.readPixels(), 640, 360);
    comp2.destroy();
    await comp2.idle();
    return { source, original, proxied, nums, swInfo, twoD };
  })()`);
  check(more.source === 45, `the source monitor player shows the media at its source time (frame ${more.source})`);
  check(more.original === 30 && more.proxied === 60, `a proxy file replaces the original when asked (frame ${more.original} -> ${more.proxied} of the 60 fps proxy)`);
  check(S(more.nums) === '[0,100,37,179]' && more.swInfo === 'prefer-software', `the software decoder gives the right frames too (${S(more.nums)}, ${more.swInfo})`);
  check(more.twoD === 50, `the 2D fallback draws video frames (frame ${more.twoD})`);

  // ---- prefetch stops where the cache's bytes run out, not only its frame count (4K frames: 31 of 48) ----
  const byBytes = await js(`(async () => {
    const T = Cut.time;
    const fps = [30, 1];
    const r = await __eng.makeMp4({ w: 640, h: 360, fps, frames: 240, gop: 240 });
    const path = await __eng.write('one-gop.mp4', r.bytes);
    const hist = __eng.history(640, 360);
    const [mid] = await __eng.importAll(hist, [path]);
    const o = await Cut.media.open(hist.project, mid);
    const src = Cut.decoder.createFrameSource(o, o.video, { hardware: false, cacheBytes: 12 * 640 * 368 * 1.5 });
    const wrong = [];
    for (let i = 0; i < 200; i++) {
      src.prefetch(T.frameStart(i, fps), T.frameStart(i + 60, fps));
      await __eng.sleep(8);
      const f = await src.frameAt(T.frameStart(i, fps));
      const c = new OffscreenCanvas(640, 360);
      c.getContext('2d').drawImage(f, 0, 0);
      src.release(f);
      if (i % 20 === 0) { const n = __eng.readNumber(c.getContext('2d').getImageData(0, 0, 640, 360).data, 640, 360); if (n !== i) wrong.push([i, n]); }
    }
    const st = src.stats();
    src.close();
    return { keys: r.keys, restarts: st.restarts, why: st.why, capacity: st.capacity, hw: st.hardware, wrong };
  })()`);
  // Played to 5 s, paused, clicked back to 1 s, played: the window prefetched at 5 s must not pull the run back there.
  const stale = await js(`(async () => {
    const T = Cut.time;
    const fps = [30, 1];
    const r = await __eng.makeMp4({ w: 640, h: 360, fps, frames: 240, gop: 30 });
    const path = await __eng.write('gop30.mp4', r.bytes);
    const hist = __eng.history(640, 360);
    const [mid] = await __eng.importAll(hist, [path]);
    const o = await Cut.media.open(hist.project, mid);
    const src = Cut.decoder.createFrameSource(o, o.video, { hardware: false });
    const show = async (k) => { const f = await src.frameAt(T.frameStart(k, fps)); src.release(f); };
    src.prefetch(T.frameStart(150, fps), T.frameStart(210, fps));
    await show(150);
    await __eng.sleep(300);
    await show(40);
    await __eng.sleep(500);
    const before = src.stats();
    for (let k = 41; k <= 50; k++) { src.prefetch(T.frameStart(k, fps), T.frameStart(k + 60, fps)); await show(k); }
    const after = src.stats();
    src.close();
    return { restarts: after.restarts - before.restarts, run: before.run, why: after.why };
  })()`);
  check(stale.restarts === 0 && stale.run.start === 30, `after a seek back while paused, the old prefetch window does not move the run (run from ${stale.run.start}, then ${stale.restarts} restarts, ${S(stale.why)})`);
  check(byBytes.keys === 1 && byBytes.restarts === 1 && !byBytes.why.dropped && byBytes.wrong.length === 0, `playing a long GOP through a cache that fills by bytes (${byBytes.capacity} frames) never restarts at the sync sample (restarts ${byBytes.restarts}, ${S(byBytes.why)}, ${byBytes.hw}${byBytes.wrong.length ? `, wrong frames ${S(byBytes.wrong)}` : ''})`);

  // ---- transforms and opacity by pixels ----
  const tf = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const seq = hist.project.sequences[0].id;
    const P = Cut.commands;
    const { id } = hist.do(P.addGenerated(seq, { track: 'V1', at: 0, duration: 254016000000 * 2, source: { generator: 'solid', color: '#ff0000' } }));
    const shot = async (patch, t = 0) => {
      if (patch) hist.do(P.setClip(seq, id, { props: { ...hist.project.sequences[0].clips.find((c) => c.id === id).props, ...patch } }));
      await __comp.render(hist.project, seq, t);
      return __comp.readPixels();
    };
    const red = (r, g, b) => r > 200 && g < 40 && b < 40;
    const out = {};
    let px = await shot(null);
    out.full = __eng.bbox(px, 640, 360, red);
    px = await shot({ scale: [50, 50], position: [100, 50] });
    out.scaled = __eng.bbox(px, 640, 360, red);
    out.edge = [__eng.px(px, 640, 259, 200), __eng.px(px, 640, 260, 200), __eng.px(px, 640, 579, 200), __eng.px(px, 640, 580, 200)];
    px = await shot({ rotation: 90 });
    out.rotated = __eng.bbox(px, 640, 360, red);
    px = await shot({ rotation: 0, scale: [100, 100], position: [0, 0], anchor: [100, 0] });
    out.anchor = __eng.bbox(px, 640, 360, red);
    px = await shot({ anchor: [0, 0], crop: [10, 0, 0, 25] });
    out.crop = __eng.bbox(px, 640, 360, red);
    hist.do(P.setClip(seq, id, { props: { ...hist.project.sequences[0].clips.find((c) => c.id === id).props, crop: [0, 0, 0, 0], opacity: 50 } }));
    hist.do(P.setGenerator(seq, id, { color: '#ffffff' }));
    px = await shot(null);
    out.opacity = __eng.px(px, 640, 320, 180);
    hist.do(P.setClip(seq, id, { props: { ...hist.project.sequences[0].clips.find((c) => c.id === id).props, opacity: 100, scale: [50, 50] } }));
    hist.do(P.setKeyframes(seq, id, 'position', [{ t: 0, v: [0, 0], ease: 'linear' }, { t: 254016000000, v: [200, 0], ease: 'linear' }]));
    px = await shot(null, 254016000000 / 2);
    out.keyframed = __eng.bbox(px, 640, 360, (r, g, b) => r > 200 && g > 200 && b > 200);
    return out;
  })()`);
  check(S(tf.full) === '[0,0,639,359]', `a full-frame solid covers the frame (${S(tf.full)})`);
  check(S(tf.scaled) === '[260,140,579,319]', `scale 50% at position (100, 50): the rectangle lands on exact pixels (${S(tf.scaled)})`);
  check(tf.edge[0][0] < 10 && tf.edge[1][0] > 245 && tf.edge[2][0] > 245 && tf.edge[3][0] < 10, `scaled edges are sharp (${S(tf.edge)})`);
  check(tf.rotated && Math.abs(tf.rotated[0] - 330) <= 1 && Math.abs(tf.rotated[2] - 509) <= 1 && tf.rotated[1] <= 71 && tf.rotated[3] === 359, `rotation 90 turns the rectangle about its center (${S(tf.rotated)})`);
  check(S(tf.anchor) === '[0,0,539,359]', `anchor (100, 0) moves the picture left by 100 (${S(tf.anchor)})`);
  check(S(tf.crop) === '[160,36,639,359]', `crop top 10%, left 25% (${S(tf.crop)})`);
  check(Math.abs(tf.opacity[0] - 187.5) <= 1.5 && tf.opacity[0] === tf.opacity[2], `opacity 50% of white over black is half the light: sRGB ${tf.opacity[0]} (want 188)`);
  check(S(tf.keyframed) === '[260,90,579,269]', `keyframed position half way: x + 100 (${S(tf.keyframed)})`);

  // ---- every effect against its CPU reference on a known image ----
  const fxr = await js(`(async () => {
    const W = 64, H = 36;
    const bytes = await __eng.png(W, H, (g) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { g.fillStyle = 'rgb(' + Math.round(x * 4) + ',' + Math.round(y * 7) + ',' + Math.round(((x + y) % 9) * 28) + ')'; g.fillRect(x, y, 1, 1); }
      g.fillStyle = '#ff0000'; g.fillRect(4, 4, 10, 10);
      g.fillStyle = '#00ff00'; g.fillRect(20, 6, 8, 8);
      g.fillStyle = '#ffffff'; g.fillRect(40, 20, 12, 10);
    });
    const path = await __eng.write('fx.png', bytes);
    const hist = __eng.history(W, H);
    const seq = hist.project.sequences[0].id;
    const [mid] = await __eng.importAll(hist, [path]);
    const { ids: [cid] } = hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, out: 254016000000, video: 'V1', audio: null }));
    const c = __eng.canvas(W, H);
    const comp = await Cut.compositor.create(c, { width: W, height: H });
    const opened = await Cut.media.open(hist.project, mid);
    const input = __eng.linearOf(opened.image);
    await comp.render(hist.project, seq, 0);
    const plain = await comp.readPixels();
    const base = __eng.diff(plain, __eng.encode(input));
    const cases = [
      ['flip.horizontal', {}], ['flip.vertical', {}], ['crop', { left: 20, top: 10, right: 5, bottom: 30, feather: 3 }],
      ['blur.gaussian', { blurriness: 6 }], ['blur.gaussian', { blurriness: 9, dimensions: 'vertical', repeat: true }],
      ['blur.directional', { direction: 45, length: 12 }], ['mosaic', { horizontal: 8, vertical: 4 }], ['mosaic', { horizontal: 5, vertical: 3, sharp: true }],
      ['color.bw', {}], ['color.tint', { black: '#102030', white: '#ffe0a0', amount: 80 }], ['color.brightnessContrast', { brightness: 30, contrast: 40 }],
      ['color.basic', { temperature: 40, tint: -20, exposure: 0.5, contrast: 25, highlights: -30, shadows: 40, whites: 10, blacks: -10, saturation: 130, vibrance: 30 }],
      ['color.basic', { saturation: 0 }], ['vignette', { amount: -80, midpoint: 40, feather: 40, roundness: 50, center: [8, -4] }], ['vignette', { amount: 60 }],
      ['sharpen', { amount: 150, radius: 1.5 }], ['sharpen', { amount: 80, radius: 3, threshold: 10 }], ['glow', { threshold: 50, radius: 8, intensity: 120 }],
      ['color.invert', {}], ['color.invert', { amount: 40 }], ['color.hue', { hue: 120 }], ['color.hue', { hue: -45 }], ['posterize', { levels: 4 }],
      ['chromatic', { amount: 4 }], ['chromatic', { amount: 2.5, mode: 'linear', direction: 60 }], ['glitch', { amount: 60, shift: 12, bandHeight: 4 }, 5], ['glitch', { amount: 100, shift: 20, bandHeight: 6, hold: 3 }, 11],
      ['distort.lens', { curvature: -60 }], ['distort.lens', { curvature: 50, repeat: true }],
      ['key.chroma', { similarity: 30, smoothness: 20, spill: 30 }], ['key.chroma', { similarity: 30, smoothness: 20, output: 'matte' }],
      ['noise.grain', { amount: 40 }, 7], ['noise.grain', { amount: 30, size: 2.5, color: true }, 3],
      // Lumetri Color's other sections: curves (an S on the master, a lifted blue), the Look (a 17-point LUT kept in
      // the project, at full and part intensity, then a 33-point one with a domain), the HSL secondary (a correction
      // inside a key, Show Mask), and every section at once.
      ['color.basic', { curveMaster: [0, 0, 0.25, 0.15, 0.75, 0.88, 1, 1], curveBlue: [0, 0.2, 1, 0.9] }],
      ['color.basic', { curveRed: [0, 0, 0.3, 0.6, 1, 1], curveGreen: [0, 0, 0.6, 0.3, 1, 1] }],
      ['color.basic', { lut: '@look17', lutIntensity: 100 }], ['color.basic', { lut: '@look17', lutIntensity: 40 }], ['color.basic', { lut: '@look33' }],
      ['color.basic', { hslHue: 0, hslHueRange: 70, hslHueSoft: 40, hslSatLow: 20, hslSatSoft: 15, hslSaturation: 30, hslHueShift: 60, hslTemperature: 30, hslContrast: 20 }],
      ['color.basic', { hslHue: 120, hslHueRange: 60, hslHueSoft: 30, hslMask: true }],
      ['color.basic', { exposure: 0.4, saturation: 120, lut: '@look17', lutIntensity: 70, curveMaster: [0, 0.05, 0.5, 0.55, 1, 0.95], hslHue: 220, hslHueRange: 80, hslHueSoft: 30, hslSaturation: 150 }],
    ];
    // The Looks those cases name: LUTs made here (a curved, crossed look), kept in the project as the panel does.
    const look = (n, max) => {
      const lines = ['TITLE "test look"', 'LUT_3D_SIZE ' + n, 'DOMAIN_MAX ' + max.join(' ')];
      for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
        const [x, y, z] = [r / (n - 1), g / (n - 1), b / (n - 1)];
        lines.push([0.85 * x ** 0.8 + 0.15 * z, 0.1 + 0.8 * y ** 1.3, Math.min(1, 0.3 * x + 0.7 * Math.sqrt(z))].map((v) => v.toFixed(6)).join(' '));
      }
      return Cut.lumetri.store(Cut.lumetri.parseCube(lines.join('\\n')), 'look' + n + '.cube');
    };
    const looks = { '@look17': look(17, [1, 1, 1]), '@look33': look(33, [1.2, 1, 0.9]) };
    for (const l of Object.values(looks)) hist.do(Cut.commands.addLut(l));
    for (const c of cases) if (typeof c[1].lut === 'string') c[1] = { ...c[1], lut: looks[c[1].lut].id };
    // Every video effect of the registry is here (edge.extend has its own check below).
    const missing = Cut.effects.list('video').map((d) => d.type).filter((t) => t !== 'edge.extend' && !cases.some((c) => c[0] === t));
    const out = [{ type: 'none', ...base }];
    for (const [type, params, frame = 0] of cases) {
      const clip = () => hist.project.sequences[0].clips.find((x) => x.id === cid);
      for (const e of [...clip().effects]) hist.do(Cut.commands.removeEffect(seq, cid, e.id));
      hist.do(Cut.commands.addEffect(seq, cid, type, null, params));
      await comp.render(hist.project, seq, Cut.time.frameStart(frame, [30, 1]));
      const got = await comp.readPixels();
      const def = Cut.effects.get(type);
      const resolved = Cut.effects.resolve(type, params);
      const want = __eng.encode(def.cpu(input, resolved, { width: W, height: H, pxScale: 1, frame, assets: def.assets ? def.assets(hist.project, resolved) : null }));
      let over3 = 0;
      for (let i = 0; i < got.length; i += 4) for (let k = 0; k < 3; k++) if (Math.abs(got[i + k] - want[i + k]) > 3) over3++;
      out.push({ type, params, frame, ...__eng.diff(got, want), over3, changed: __eng.diff(got, plain).mean });
    }
    // Grain and glitch are a function of the frame: any time inside a frame, and another compositor (an export makes
    // its own), give the same picture; the next frame another one.
    const frameLook = {};
    const clip0 = () => hist.project.sequences[0].clips.find((x) => x.id === cid);
    for (const [type, params] of [['noise.grain', { amount: 50 }], ['glitch', { amount: 80, shift: 16, bandHeight: 4, hold: 1 }]]) {
      for (const e of [...clip0().effects]) hist.do(Cut.commands.removeEffect(seq, cid, e.id));
      hist.do(Cut.commands.addEffect(seq, cid, type, null, params));
      const F = Cut.time.frameTicks([30, 1]);
      await comp.render(hist.project, seq, 7 * F);
      const start = await comp.readPixels();
      await comp.render(hist.project, seq, 7 * F + F * 0.6);
      const inside = await comp.readPixels();
      await comp.render(hist.project, seq, 8 * F);
      const next = await comp.readPixels();
      const cOther = __eng.canvas(W, H);
      const other = await Cut.compositor.create(cOther, { width: W, height: H });
      await other.render(hist.project, seq, 7 * F);
      const fresh = await other.readPixels();
      await other.idle();
      other.destroy();
      frameLook[type] = { inside: __eng.diff(start, inside).max, fresh: __eng.diff(start, fresh).max, next: __eng.diff(start, next).mean };
    }
    // Edge extend: a half-size picture with its edges stretched to the frame instead of black around it.
    for (const e of [...hist.project.sequences[0].clips[0].effects]) hist.do(Cut.commands.removeEffect(seq, cid, e.id));
    hist.do(Cut.commands.setClip(seq, cid, { props: { ...hist.project.sequences[0].clips[0].props, scale: [50, 50] } }));
    await comp.render(hist.project, seq, 0);
    const small = await comp.readPixels();
    hist.do(Cut.commands.addEffect(seq, cid, 'edge.extend'));
    await comp.render(hist.project, seq, 0);
    const extended = await comp.readPixels();
    // The picture's bottom-right pixel is (252, 245, 224); without the effect the frame's corner is black.
    out.push({ type: 'edge.extend', corner: __eng.px(small, W, W - 1, H - 1), extendedCorner: __eng.px(extended, W, W - 1, H - 1), edge: __eng.px(small, W, 47, 26), centerSame: __eng.diff(__eng.px(small, W, 32, 18), __eng.px(extended, W, 32, 18)).max });
    const errors = comp.errors.slice();
    comp.destroy();
    return { out, errors, missing, frameLook };
  })()`);
  const noneCase = fxr.out[0];
  check(noneCase.max <= 2, `the image without effects comes out as it went in (max diff ${noneCase.max})`);
  for (const r of fxr.out.slice(1)) {
    if (r.type === 'edge.extend') {
      check(r.corner.every((v) => v === 0) && S(r.extendedCorner) === '[252,245,224]' && r.centerSame <= 1, `edge.extend fills the frame around a smaller picture with its edge (${S(r.corner)} -> ${S(r.extendedCorner)}, the picture's corner pixel is [252,245,224])`);
      continue;
    }
    // Lens distortion samples between texels at positions that vary continuously. The sampler's bilinear weights have 8
    // bits: on the test picture's hard edges a dark pixel lands up to 4 codes from the exact reference (and within 1 of a
    // CPU tap with weights rounded to 1/256), so a few values may pass 3.
    const sub = r.type === 'distort.lens';
    check((sub ? r.max <= 6 && r.over3 <= 12 : r.max <= 3) && r.mean <= 0.6 && r.changed > 1, `${r.type} ${S(r.params)}${r.frame ? ` at frame ${r.frame}` : ''}: GPU = CPU reference (max ${r.max}${sub ? `, ${r.over3} values over 3` : ''}, mean ${r.mean.toFixed(3)}), changes the picture (${r.changed.toFixed(1)})`);
  }
  check(fxr.missing.length === 0, `every video effect of the registry is checked against its CPU reference (missing ${S(fxr.missing)})`);
  for (const [type, f] of Object.entries(fxr.frameLook)) {
    check(f.inside === 0 && f.fresh === 0 && f.next > 0.5, `${type} is a function of the frame: the same at 0.6 of the frame and from a new compositor (max diff ${f.inside}, ${f.fresh}), different on the next frame (${f.next.toFixed(2)})`);
  }
  check(fxr.errors.length === 0, `no WebGPU validation errors (${S(fxr.errors)})`);
  // On a video clip the decoded picture rides on the plan item too; grain and glitch must still get the frame number.
  const vidLook = await js(`(async () => {
    const W = 640, H = 360, fps = [30, 1];
    const r = await __eng.makeMp4({ w: W, h: H, fps, frames: 30, gop: 30 });
    const path = await __eng.write('fx-video.mp4', r.bytes);
    const hist = __eng.history(W, H);
    const seq = hist.project.sequences[0].id;
    const [mid] = await __eng.importAll(hist, [path]);
    const { ids: [cid] } = hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, out: 254016000000, video: 'V1', audio: null }));
    const comp = await Cut.compositor.create(__eng.canvas(W, H), { width: W, height: H });
    const F = Cut.time.frameTicks(fps);
    const at = async (t) => { await comp.render(hist.project, seq, t); return comp.readPixels(); };
    const linear = (d) => {
      const img = Cut.effects.cpu.image(W, H);
      for (let i = 0; i < d.length; i += 4) img.data.set([Cut.effects.srgbToLinear(d[i] / 255), Cut.effects.srgbToLinear(d[i + 1] / 255), Cut.effects.srgbToLinear(d[i + 2] / 255), 1], i);
      return img;
    };
    const plain = { 7: await at(7 * F), 8: await at(8 * F) };
    const out = {};
    for (const [type, params] of [['noise.grain', { amount: 60 }], ['glitch', { amount: 100, shift: 24, bandHeight: 6, hold: 1 }]]) {
      for (const e of [...hist.project.sequences[0].clips.find((x) => x.id === cid).effects]) hist.do(Cut.commands.removeEffect(seq, cid, e.id));
      hist.do(Cut.commands.addEffect(seq, cid, type, null, params));
      const def = Cut.effects.get(type);
      const resolved = Cut.effects.resolve(type, params);
      const ref = {};
      for (const frame of [7, 8]) {
        const got = await at(frame * F);
        const want = __eng.encode(def.cpu(linear(plain[frame]), resolved, { width: W, height: H, pxScale: 1, frame }));
        ref[frame] = { ...__eng.diff(got, want), changed: __eng.diff(got, plain[frame]).mean };
      }
      const inside = __eng.diff(await at(7 * F), await at(7 * F + F * 0.6)).max;
      out[type] = { ref, inside };
    }
    const errors = comp.errors.slice();
    await comp.idle();
    comp.destroy();
    return { out, errors };
  })()`);
  for (const [type, f] of Object.entries(vidLook.out)) {
    for (const [frame, r] of Object.entries(f.ref)) {
      check(r.max <= 4 && r.mean <= 0.6 && r.changed > 1, `${type} on a video clip at frame ${frame}: GPU = CPU reference of that frame (max ${r.max}, mean ${r.mean.toFixed(3)}), changes the picture (${r.changed.toFixed(1)})`);
    }
    check(f.inside === 0, `${type} on a video clip: the same anywhere inside a frame (max diff ${f.inside})`);
  }
  check(vidLook.errors.length === 0, `no WebGPU errors with effects on video (${S(vidLook.errors)})`);

  // ---- Lumetri Scopes: the GPU's count against the CPU's of the same pixels, and pictures with known scopes ----
  const sc = await js(`(async () => {
    const SC = Cut.scopes;
    const S = JSON.stringify;
    const F = Cut.time.frameTicks([30, 1]);
    const out = { errors: [] };
    // Counts of one render, from the GPU (comp.scopes) and from the CPU over the pixels read back.
    const both = async (comp, hist, seq) => {
      await comp.render(hist.project, seq, 0);
      const g = await comp.scopes();
      const px = await comp.readPixels();
      const c = SC.analyze(px, comp.width, comp.height, g.rect, { step: g.step });
      let bins = 0;
      let sum = 0;
      for (let i = 0; i < g.bins.length; i++) if (g.bins[i] !== c.bins[i]) { bins++; sum += Math.abs(g.bins[i] - c.bins[i]); }
      return { g, c, bins, sum, total: SC.views(g.bins, g.layout).hist[3].reduce((a, b) => a + b, 0) };
    };
    const pic = async (name, w, h, paint) => {
      const hist = __eng.history(w, h);
      const seq = hist.project.sequences[0].id;
      const [mid] = await __eng.importAll(hist, [await __eng.write(name, await __eng.png(w, h, paint))]);
      hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, out: 30 * F, video: 'V1', audio: null }));
      return { hist, seq };
    };
    // A colorful picture: hues across, light down, a gray ramp at the bottom.
    const rich = await pic('scope-rich.png', 640, 360, (g, w, h) => {
      for (let x = 0; x < w; x++) { const gr = g.createLinearGradient(0, 0, 0, h * 0.8); gr.addColorStop(0, 'hsl(' + (x / w) * 360 + ',90%,85%)'); gr.addColorStop(1, 'hsl(' + (x / w) * 360 + ',70%,15%)'); g.fillStyle = gr; g.fillRect(x, 0, 1, h * 0.8); }
      for (let x = 0; x < w; x++) { g.fillStyle = 'rgb(' + [x, x, x].map((v) => Math.round((v * 255) / (w - 1))).join(',') + ')'; g.fillRect(x, h * 0.8, 1, h * 0.2); }
    });
    for (const [W, H] of [[640, 360], [800, 360], [1920, 1080]]) {
      const comp = await Cut.compositor.create(__eng.canvas(W, H), { width: W, height: H });
      const r = await both(comp, rich.hist, rich.seq);
      out['rich' + W] = { backend: r.g.backend, bins: r.bins, sum: r.sum, total: r.total, rect: r.g.rect, step: r.g.step, nonzero: r.g.bins.filter((v) => v > 0).length };
      out.errors.push(...comp.errors);
      await comp.idle();
      comp.destroy();
    }
    // Solid 75% color bars, each its own frame: one vectorscope point at the bar's angle, in its target.
    const comp = await Cut.compositor.create(__eng.canvas(320, 180), { width: 320, height: 180 });
    out.bars = [];
    for (const [name, c] of SC.BARS) {
      const hist = __eng.history(1280, 720);
      const seq = hist.project.sequences[0].id;
      const hex = '#' + c.map((v) => Math.round(v * 0.75 * 255).toString(16).padStart(2, '0')).join('');
      hist.do(Cut.commands.addGenerated(seq, { track: 'V1', at: 0, duration: 30 * F, source: { generator: 'solid', color: hex } }));
      const r = await both(comp, hist, seq);
      const pk = SC.vectorPeak(SC.views(r.g.bins, r.g.layout).vector, r.g.layout.size);
      const t = SC.targets(r.g.layout.size).find((x) => x.name === name);
      const [cb, cr] = SC.chroma(...c.map((v) => Math.round(v * 0.75 * 255) / 255));
      out.bars.push({ name, hex, angle: pk.angle, want: ((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360, n: pk.n, total: r.total, fromTarget: Math.hypot(pk.x - t.at75[0], pk.y - t.at75[1]), bins: r.bins });
    }
    // A horizontal gray ramp: the waveform's diagonal, the same on the parade's three channels.
    const ramp = await pic('scope-ramp.png', 1280, 720, (g, w, h) => { for (let x = 0; x < w; x++) { const v = Math.round((x * 255) / (w - 1)); g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; g.fillRect(x, 0, 1, h); } });
    const rr = await both(comp, ramp.hist, ramp.seq);
    const v = SC.views(rr.g.bins, rr.g.layout);
    const pk = [...SC.peaks(v.wave, rr.g.layout.cols)];
    const n = pk.length;
    const mx = (n - 1) / 2;
    const my = pk.reduce((a, b) => a + b, 0) / n;
    let sxy = 0; let sxx = 0; let syy = 0;
    pk.forEach((l, i) => { sxy += (i - mx) * (l - my); sxx += (i - mx) ** 2; syy += (l - my) ** 2; });
    out.ramp = { first: pk[0], last: pk[n - 1], rising: pk.every((l, i) => !i || l >= pk[i - 1]), slope: sxy / sxx, corr: sxy / Math.sqrt(sxx * syy), parade: v.parade.every((p) => S(SC.peaks(p, rr.g.layout.cols)) === S(SC.peaks(v.wave, rr.g.layout.cols))), bins: rr.bins };
    out.errors.push(...comp.errors);
    // The Canvas 2D back end counts on the CPU: the same ramp and red.
    const c2 = await Cut.compositor.create(__eng.canvas(320, 180), { width: 320, height: 180, backend: '2d' });
    await c2.render(ramp.hist.project, ramp.seq, 0);
    const r2 = await c2.scopes();
    const pk2 = [...SC.peaks(SC.views(r2.bins, r2.layout).wave, r2.layout.cols)];
    out.twoD = { backend: r2.backend, first: pk2[0], last: pk2[pk2.length - 1], rising: pk2.every((l, i) => !i || l >= pk2[i - 1] - 1) };
    await comp.idle();
    comp.destroy();
    c2.destroy();
    return out;
  })()`);
  for (const W of [640, 800, 1920]) {
    const r = sc[`rich${W}`];
    check(r.backend === 'webgpu' && r.bins === 0 && r.nonzero > 1000 && r.total === Math.ceil((r.rect.x1 - r.rect.x0) / r.step) * Math.ceil((r.rect.y1 - r.rect.y0) / r.step),
      `scopes of a colorful frame on a ${W}-wide canvas: the GPU's compute count equals the CPU's over the same pixels, bin for bin (${r.bins} bins differ by ${r.sum}; ${r.nonzero} bins used; frame box ${S(r.rect)}, step ${r.step})`);
  }
  check(sc.rich800.rect.x0 === 80 && sc.rich800.rect.x1 === 720, `a pillarboxed canvas: the scopes count the frame, not the bars (${S(sc.rich800.rect)})`);
  check(sc.rich1920.step === 3, `a 1920x1080 canvas is counted every third pixel (${sc.rich1920.step})`);
  for (const b of sc.bars) check(b.bins === 0 && b.n === b.total && Math.abs(b.angle - b.want) < 1.5 && b.fromTarget < 1.5, `75% ${b.name} (${b.hex}): one vectorscope point at ${b.angle.toFixed(1)} degrees (want ${b.want.toFixed(1)}), ${b.fromTarget.toFixed(2)} bins from its target; GPU = CPU`);
  check(sc.ramp.bins === 0 && sc.ramp.first <= 1 && sc.ramp.last >= 254 && sc.ramp.rising && Math.abs(sc.ramp.slope - 1) < 0.02 && sc.ramp.corr > 0.999 && sc.ramp.parade,
    `a gray ramp is a diagonal on the waveform (${sc.ramp.first} to ${sc.ramp.last}, slope ${sc.ramp.slope.toFixed(4)}, correlation ${sc.ramp.corr.toFixed(5)}) and on each parade channel; GPU = CPU`);
  check(sc.twoD.backend === '2d' && sc.twoD.first <= 1 && sc.twoD.last >= 254 && sc.twoD.rising, `the Canvas 2D back end counts the scopes on the CPU: the ramp's diagonal (${S(sc.twoD)})`);
  check(sc.errors.length === 0, `no WebGPU validation errors from the scopes (${S(sc.errors)})`);

  // ---- transitions ----
  const tr = await js(`(async () => {
    const S1 = 254016000000;
    const out = {};
    for (const [type, params] of [['dissolve', {}], ['dip.black', {}], ['dip.white', {}], ['push', { direction: 'left' }], ['wipe', { direction: 'fromLeft' }], ['slide', { direction: 'left' }], ['iris.round', {}], ['zoom.cross', {}]]) {
      const hist = __eng.history(640, 360);
      const seq = hist.project.sequences[0].id;
      hist.do(Cut.commands.addGenerated(seq, { track: 'V1', at: 0, duration: S1, source: { generator: 'solid', color: '#ff0000' } }));
      hist.do(Cut.commands.addGenerated(seq, { track: 'V1', at: S1, duration: S1, source: { generator: 'solid', color: '#0000ff' } }));
      hist.do(Cut.commands.addTransition(seq, { track: 'V1', at: S1, type, duration: S1 / 3, align: 'center', params }));
      const at = async (t) => { await __comp.render(hist.project, seq, t); const p = await __comp.readPixels(); return [__eng.px(p, 640, 100, 180), __eng.px(p, 640, 540, 180), __eng.px(p, 640, 320, 180), __eng.px(p, 640, 2, 2)]; };
      out[type] = { mid: await at(S1), before: await at(S1 - S1 / 6 - S1 / 30), after: await at(S1 + S1 / 6), start: await at(S1 - S1 / 6) };
    }
    return out;
  })()`);
  const enc = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  const close = (a, b, e = 2) => a.every((x, i) => Math.abs(x - b[i]) <= e);
  check(close(tr.dissolve.mid[0], [enc(0.5), 0, enc(0.5)]) && close(tr.dissolve.mid[1], [enc(0.5), 0, enc(0.5)]), `dissolve at its midpoint is the average in linear light (${S(tr.dissolve.mid[0])}, want ${S([enc(0.5), 0, enc(0.5)])})`);
  check(close(tr.dissolve.before[0], [255, 0, 0]) && close(tr.dissolve.after[0], [0, 0, 255]) && close(tr.dissolve.start[0], [255, 0, 0]), 'dissolve: A before, A at its first frame, B after');
  check(close(tr['dip.black'].mid[0], [0, 0, 0]) && close(tr['dip.white'].mid[0], [255, 255, 255]), `dips are black / white at the middle (${S(tr['dip.black'].mid[0])}, ${S(tr['dip.white'].mid[0])})`);
  check(close(tr.push.mid[0], [255, 0, 0]) && close(tr.push.mid[1], [0, 0, 255]), `push left half way: A left, B right (${S(tr.push.mid)})`);
  check(close(tr.wipe.mid[0], [0, 0, 255]) && close(tr.wipe.mid[1], [255, 0, 0]), `wipe from left half way: B left, A right (${S(tr.wipe.mid)})`);
  check(close(tr.slide.mid[0], [255, 0, 0]) && close(tr.slide.mid[1], [0, 0, 255]), `slide left half way: A still on the left, B in from the right (${S(tr.slide.mid)})`);
  check(close(tr['iris.round'].mid[2], [0, 0, 255]) && close(tr['iris.round'].mid[3], [255, 0, 0]) && close(tr['iris.round'].mid[0], [255, 0, 0]), `iris round half way: B in the middle, A in the corner and at 0.6 of the radius (${S(tr['iris.round'].mid)})`);
  check(close(tr['zoom.cross'].mid[2], [enc(0.5), 0, enc(0.5)]) && close(tr['zoom.cross'].mid[3], [enc(0.5), 0, enc(0.5)]), `cross zoom half way: the linear average everywhere (${S(tr['zoom.cross'].mid)})`);
  for (const t of ['slide', 'iris.round', 'zoom.cross']) check(close(tr[t].before[2], [255, 0, 0]) && close(tr[t].after[3], [0, 0, 255]) && close(tr[t].start[3], [255, 0, 0]), `${t}: A before, A at its first frame, B after`);

  // ---- every video transition against its CPU reference on two pictures ----
  const trr = await js(`(async () => {
    const W = 64, H = 36, S1 = 254016000000;
    const pa = await __eng.write('tr-a.png', await __eng.png(W, H, (g) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { g.fillStyle = 'rgb(' + Math.round(x * 4) + ',' + Math.round(y * 7) + ',' + Math.round(((x + y) % 9) * 28) + ')'; g.fillRect(x, y, 1, 1); }
      g.fillStyle = '#ffffff'; g.fillRect(28, 14, 8, 8);
    }));
    const pb = await __eng.write('tr-b.png', await __eng.png(W, H, (g) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { g.fillStyle = 'rgb(' + (255 - x * 4) + ',' + ((x * y) % 256) + ',' + Math.round(y * 7) + ')'; g.fillRect(x, y, 1, 1); }
    }));
    const cases = [['dissolve', {}], ['dip.black', {}], ['dip.white', {}], ['push', { direction: 'up' }], ['wipe', { direction: 'fromRight', feather: 20 }],
      ['slide', { direction: 'right' }], ['slide', { direction: 'down' }], ['iris.round', { feather: 15 }], ['iris.round', { direction: 'close', feather: 10 }], ['zoom.cross', {}], ['zoom.cross', { zoom: 150 }]];
    const missing = Cut.effects.transitions('video').map((d) => d.type).filter((t) => !cases.some((c) => c[0] === t));
    const c = __eng.canvas(W, H);
    const comp = await Cut.compositor.create(c, { width: W, height: H });
    const out = [];
    for (const [type, params] of cases) {
      const hist = __eng.history(W, H);
      const seq = hist.project.sequences[0].id;
      const [ma, mb] = await __eng.importAll(hist, [pa, pb]);
      hist.do(Cut.commands.place(seq, { source: { media: ma }, at: 0, out: S1, video: 'V1', audio: null }));
      hist.do(Cut.commands.place(seq, { source: { media: mb }, at: S1, out: S1, video: 'V1', audio: null }));
      hist.do(Cut.commands.addTransition(seq, { track: 'V1', at: S1, type, duration: S1 / 3, align: 'center', params }));
      const ia = __eng.linearOf((await Cut.media.open(hist.project, ma)).image);
      const ib = __eng.linearOf((await Cut.media.open(hist.project, mb)).image);
      const def = Cut.effects.get(type);
      for (const t of [S1 - S1 / 12, S1, S1 + S1 / 10]) {
        const layer = Cut.compositor.plan(hist.project, hist.project.sequences[0], t).find((l) => l.kind === 'transition');
        await comp.render(hist.project, seq, t);
        const got = await comp.readPixels();
        const want = __eng.encode(def.cpu(ia, ib, layer.progress, Cut.effects.resolve(type, params)));
        out.push({ type, params, progress: +layer.progress.toFixed(3), ...__eng.diff(got, want), fromA: __eng.diff(got, __eng.encode(ia)).mean, fromB: __eng.diff(got, __eng.encode(ib)).mean });
      }
    }
    const errors = comp.errors.slice();
    await comp.idle();
    comp.destroy();
    return { out, missing, errors };
  })()`);
  for (const r of trr.out) check(r.max <= 3 && r.mean <= 0.6 && r.fromA > 1 && r.fromB > 1, `${r.type} ${S(r.params)} at ${r.progress}: GPU = CPU reference (max ${r.max}, mean ${r.mean.toFixed(3)}), neither picture alone (${r.fromA.toFixed(1)}, ${r.fromB.toFixed(1)})`);
  check(trr.missing.length === 0, `every video transition of the registry is checked against its CPU reference (missing ${S(trr.missing)})`);
  check(trr.errors.length === 0, `no WebGPU validation errors in the transitions (${S(trr.errors)})`);

  // ---- text: Korean through FontFace, captions ----
  const tx = await js(`(async () => {
    const loaded = await Cut.textrender.loadFont('Malgun Gothic', { weight: 700 });
    const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Malgun Gothic' && f.status === 'loaded').map((f) => f.weight);
    const hist = __eng.history(640, 360);
    const seq = hist.project.sequences[0].id;
    const { id } = hist.do(Cut.commands.addGenerated(seq, { track: 'V1', at: 0, duration: 254016000000, source: { generator: 'text', layers: [{ text: '안', size: 200, weight: 700, font: 'Malgun Gothic' }] } }));
    const draw = async (text) => {
      const layer = hist.project.sequences[0].clips.find((c) => c.id === id).source.layers[0];
      hist.do(Cut.commands.setLayer(seq, id, layer.id, { text }));
      await __comp.render(hist.project, seq, 0);
      return __comp.readPixels();
    };
    const white = (r, g, b) => r > 128 && g > 128 && b > 128;
    const a = await draw('안');
    const b = await draw('녕');
    const tofu = await draw('\\u{10FFFD}');
    const count = (p) => { let n = 0; for (let i = 0; i < p.length; i += 4) if (white(p[i], p[i + 1], p[i + 2])) n++; return n; };
    hist.do(Cut.commands.remove(seq, [id]));
    hist.do(Cut.commands.addCaptionTrack(seq, {}));
    const ct = hist.project.sequences[0].captions[0].id;
    hist.do(Cut.commands.setCaptions(seq, ct, [{ start: 0, end: 254016000000, text: '자막이 보입니다' }]));
    await __comp.render(hist.project, seq, 0);
    const none = await __comp.readPixels();
    await __comp.render(hist.project, seq, 0, { captions: true });
    const cap = await __comp.readPixels();
    const layer0 = { ...Cut.model.createTextLayer({ text: '안', size: 200, weight: 700, font: 'Malgun Gothic' }) };
    const g0 = new OffscreenCanvas(4, 4).getContext('2d');
    const mbox = Cut.textrender.measure(layer0, g0).box;
    return { loaded, faces, a: count(a), b: count(b), tofu: count(tofu), ab: __eng.diff(a, b).mean, atofu: __eng.diff(a, tofu).mean, boxA: __eng.bbox(a, 640, 360, white),
      mbox: [mbox.x + 320, mbox.y + 180, mbox.x + mbox.w + 320, mbox.y + mbox.h + 180],
      capBox: __eng.bbox(cap, 640, 360, white), capNone: __eng.bbox(none, 640, 360, white) };
  })()`);
  check(tx.loaded && tx.faces.length > 0, `Malgun Gothic loaded as a FontFace from cut:fontData (weights ${S(tx.faces)})`);
  check(tx.a > 2000 && tx.b > 2000 && tx.ab > 2 && tx.atofu > 2, `Korean glyphs are drawn, not boxes: 안 ${tx.a} px, 녕 ${tx.b} px, differ by ${tx.ab.toFixed(2)}, from a missing glyph by ${tx.atofu.toFixed(2)}`);
  check(tx.boxA && Math.abs((tx.boxA[0] + tx.boxA[2]) / 2 - 320) <= 12 && Math.abs((tx.boxA[1] + tx.boxA[3]) / 2 - 180) <= 16, `the text layer is centered on its position (ink ${S(tx.boxA)})`);
  check(tx.boxA && tx.mbox && tx.boxA[0] >= tx.mbox[0] - 4 && tx.boxA[1] >= tx.mbox[1] - 4 && tx.boxA[2] <= tx.mbox[2] + 4 && tx.boxA[3] <= tx.mbox[3] + 4, `the ink is inside the box measure() gives (${S(tx.mbox.map(Math.round))})`);
  check(tx.capNone === null && tx.capBox && tx.capBox[1] > 250, `captions burn in near the bottom only when asked (${S(tx.capBox)})`);
  const capScale = await js(`(async () => {
    const white = (r, g, b) => r > 128 && g > 128 && b > 128;
    const share = async (w, h) => {
      const hist = __eng.history(w, h);
      const seq = hist.project.sequences[0].id;
      hist.do(Cut.commands.addCaptionTrack(seq, {}));
      hist.do(Cut.commands.setCaptions(seq, hist.project.sequences[0].captions[0].id, [{ start: 0, end: 254016000000, text: '자막이 보입니다' }]));
      await __comp.render(hist.project, seq, 0, { captions: true });
      // The compositor draws every sequence into its 640x360 canvas.
      const b = __eng.bbox(await __comp.readPixels(), 640, 360, white);
      return b && [(b[2] - b[0]) / 640, (b[3] - b[1]) / 360];
    };
    return { small: await share(640, 360), large: await share(1280, 720) };
  })()`);
  check(capScale.small && capScale.large && Math.abs(capScale.small[0] - capScale.large[0]) < 0.03 && Math.abs(capScale.small[1] - capScale.large[1]) < 0.03,
    `a caption covers the same share of the frame at 360 and 720 lines (width, height shares ${S(capScale.small?.map((v) => +v.toFixed(3)))} and ${S(capScale.large?.map((v) => +v.toFixed(3)))})`);

  // ---- offline media, import errors ----
  const off = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const seq = hist.project.sequences[0].id;
    const { ids: [mid] } = hist.do(Cut.commands.importMedia([{ path: __eng.home.projects + '\\\\gone.mp4', name: 'gone.mp4', kind: 'video', duration: 254016000000 * 5, video: { w: 640, h: 360, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 }, audio: null }]));
    hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, video: 'V1', audio: null }));
    await __comp.render(hist.project, seq, 0);
    const px = await __comp.readPixels();
    const junk = await __eng.write('junk.mp4', new Uint8Array(5000).map((_, i) => (i * 31) & 255));
    const png = await __eng.write('pic.png', await __eng.png(320, 200, (g) => { g.fillStyle = '#00ff00'; g.fillRect(0, 0, 320, 200); }));
    const list = await Cut.media.importFiles([__eng.home.projects + '\\\\missing.mp4', junk, png]);
    return { red: __eng.px(px, 640, 30, 30), list: list.map((m) => ({ kind: m.kind, code: m.error?.code, w: m.video?.w, h: m.video?.h })) };
  })()`);
  check(off.red[0] > 150 && off.red[1] < 80 && off.red[2] < 80, `offline media is drawn red (${S(off.red)})`);
  check(off.list[0].code === 'missing' && ['unsupported', 'damaged'].includes(off.list[1].code) && off.list[2].kind === 'image' && off.list[2].w === 320 && off.list[2].h === 200, `import results: missing, unreadable, an image (${S(off.list)})`);

  // ---- audio decoding, peaks, thumbnails ----
  const au = await js(`(async () => {
    const wav = await __eng.write('tone.wav', __eng.makeWav(1, 1000));
    const aac = await __eng.makeAac(1, 1000);
    const paths = [wav].concat(aac ? [await __eng.write('tone.m4a', aac)] : []);
    const hist = __eng.history(640, 360);
    const ids = await __eng.importAll(hist, paths);
    const out = [];
    for (const id of ids) {
      const o = await Cut.media.open(hist.project, id);
      const pcm = await Cut.decoder.decodeAudio(o, o.audio);
      const L = pcm.data[0];
      let cross = 0, peak = 0, sum = 0;
      for (let i = 1; i < L.length; i++) { if ((L[i - 1] < 0) !== (L[i] < 0)) cross++; peak = Math.max(peak, Math.abs(L[i])); sum += L[i] * L[i]; }
      const again = await Cut.decoder.decodeAudio(o, o.audio);
      const peaks = await Cut.thumbs.peaks(hist.project, id, { samplesPerPeak: 480 });
      out.push({ codec: o.audio.codec, rate: pcm.rate, channels: pcm.channels, length: L.length, cross, peak, rms: Math.sqrt(sum / L.length), right: Math.max(...pcm.data[1].slice(0, 2000).map(Math.abs)), cached: again === pcm, peaks: peaks.length, peakMax: Math.max(...peaks) });
    }
    return { out, aac: !!aac };
  })()`);
  const wav = au.out[0];
  check(wav.rate === 48000 && wav.channels === 2 && wav.length === 48000 && Math.abs(wav.cross - 2000) <= 2 && Math.abs(wav.peak - 0.5) < 0.01 && wav.right === 0 && wav.cached, `WAV decoded to PCM: 1 s, 1 kHz on the left, silence on the right (${S(wav)})`);
  check(Math.abs(wav.peaks - 200) <= 1 && Math.abs(wav.peakMax - 0.5) < 0.01, `peaks: 200 min/max pairs of 480 samples, max 0.5 (${wav.peaks}, ${wav.peakMax})`);
  if (au.aac) {
    const a = au.out[1];
    check(a.codec.startsWith('mp4a') && Math.abs(a.length - 48000) <= 1100 && Math.abs(a.cross / (a.length / 48000) - 2000) <= 40 && Math.abs(a.rms - 0.5 / Math.SQRT2) < 0.05, `AAC decoded through AudioDecoder: about 1 s of the 1 kHz tone (${S(a)})`);
  } else console.log('NOTE no AAC encoder here; AAC decoding not checked');
  // Long files are read in windows (decoder.audioReader) and mixed from 10 s blocks: the same samples as decoding
  // all of it, across a block's edge, through the resampler (44.1 kHz WAV) and AudioDecoder (AAC).
  const win = await js(`(async () => {
    const aac = await __eng.makeAac(25, 440);
    const paths = [await __eng.write('tone-44k.wav', __eng.makeWav(25, 440, 44100))].concat(aac ? [await __eng.write('tone-25s.m4a', aac)] : []);
    const out = [];
    for (const p of paths) {
      const hist = __eng.history(640, 360);
      const seq = hist.project.sequences[0].id;
      const [id] = await __eng.importAll(hist, [p]);
      hist.do(Cut.commands.place(seq, { source: { media: id }, at: 0, video: null, audio: 'A1' }));
      const o = await Cut.media.open(hist.project, id);
      const whole = await Cut.decoder.decodeAudio(o, o.audio);
      const r = await Cut.decoder.audioReader(o, o.audio);
      let readDiff = 0;
      for (const [a, b] of [[0, 4000], [r.rate * 9 + 17, r.rate * 11], [r.rate * 20, r.length]]) {
        const part = await r.read(a, b);
        for (let i = 0; i < part[0].length; i++) readDiff = Math.max(readDiff, Math.abs(part[0][i] - whole.data[0][a + i]));
      }
      const blocks = Cut.audioengine.createMixer({ rate: 48000 });
      const flat = Cut.audioengine.createMixer({ rate: 48000, getAudio: async () => whole });
      const s0 = 48000 * 9;
      const n = 48000 * 2;
      const ma = await blocks.mixLoaded(hist.project, seq, s0, n);
      const mb = await flat.mixLoaded(hist.project, seq, s0, n);
      let mixDiff = 0;
      let peak = 0;
      for (let i = 0; i < n; i++) { mixDiff = Math.max(mixDiff, Math.abs(ma.out[0][i] - mb.out[0][i])); peak = Math.max(peak, Math.abs(ma.out[0][i])); }
      out.push({ codec: o.audio.codec, rate: r.rate, length: r.length, wholeLength: whole.data[0].length, readDiff, mixDiff, peak, missing: ma.missing });
    }
    return out;
  })()`);
  for (const w of win) {
    check(w.length === w.wholeLength && w.readDiff < 1e-3 && w.mixDiff < 1e-4 && w.peak > 0.2 && !w.missing,
      `${w.codec} read in windows and mixed from 10 s blocks gives the samples of the whole decode, across the block edge at 10 s (${S(w)})`);
  }

  const th = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const [id] = await __eng.importAll(hist, [${S(made['30'].path)}]);
    const t0 = performance.now();
    const a = await Cut.thumbs.strip(hist.project, id, { from: 0, to: 254016000000 * 2, count: 5, height: 180 });
    const first = performance.now() - t0;
    const t1 = performance.now();
    const b = await Cut.thumbs.strip(hist.project, id, { from: 0, to: 254016000000 * 2, count: 5, height: 180 });
    const second = performance.now() - t1;
    const nums = a.map((bmp) => { const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return __eng.readNumber(g.getImageData(0, 0, bmp.width, bmp.height).data, bmp.width, bmp.height); });
    await __eng.sleep(800);
    const info = await ide.api.invoke('cut:cacheInfo');
    return { n: a.length, size: [a[0].width, a[0].height], nums, same: a.every((x, i) => x === b[i]), first, second, files: info.files };
  })()`);
  check(th.n === 5 && S(th.size) === '[320,180]' && S(th.nums) === '[0,15,30,45,60]', `thumbnail strip: 5 frames at 0, 0.5 ... 2 s (${S(th.nums)}, ${S(th.size)})`);
  check(th.same && th.second < th.first, `thumbnails come from memory the second time (${th.first.toFixed(0)} ms, then ${th.second.toFixed(1)} ms)`);
  check(th.files >= 5, `thumbnails and peaks are in the cache folder (${th.files} files)`);

  // Play pauses thumbnails also inside a strip already being made: its frames would compete with the player's.
  const held = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const [id] = await __eng.importAll(hist, [${S(made['60'].path)}]);
    const orig = Cut.decoder.createFrameSource;
    let asked = 0;
    Cut.decoder.createFrameSource = (...a) => { const s = orig(...a); const fa = s.frameAt; s.frameAt = (t) => { asked++; return fa(t); }; return s; };
    try {
      let done = false;
      const strip = Cut.thumbs.strip(hist.project, id, { from: 254016000000 / 10, to: 254016000000 * 2.9, count: 24, height: 90 }).then((x) => { done = true; return x; });
      const end = performance.now() + 5000;
      while (asked < 2 && !done && performance.now() < end) await __eng.sleep(1);
      Cut.thumbs.pause(true);
      await __eng.sleep(50);
      const atPause = asked;
      await __eng.sleep(700);
      const whilePaused = asked - atPause;
      const doneWhilePaused = done;
      Cut.thumbs.pause(false);
      const list = await strip;
      return { atPause, whilePaused, doneWhilePaused, n: list.length, asked };
    } finally { Cut.decoder.createFrameSource = orig; Cut.thumbs.pause(false); }
  })()`);
  check(held.atPause >= 2 && held.whilePaused === 0 && !held.doneWhilePaused && held.n === 24 && held.asked > held.atPause, `a strip under way waits while the player plays and finishes after (${S(held)})`);

  // A strip its caller no longer wants (the project was closed) stops decoding, also one under way. Another file than
  // the check above: the thumbnails keep a file's frame source open for 10 s, made before this wrapper.
  const unwanted = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const [id] = await __eng.importAll(hist, [${S(made['2997'].path)}]);
    const orig = Cut.decoder.createFrameSource;
    let asked = 0;
    Cut.decoder.createFrameSource = (...a) => { const s = orig(...a); const fa = s.frameAt; s.frameAt = (t) => { asked++; return fa(t); }; return s; };
    try {
      let want = true;
      const strip = Cut.thumbs.strip(hist.project, id, { from: 254016000000 / 10, to: 254016000000 * 2.9, count: 24, height: 72, wanted: () => want });
      const end = performance.now() + 5000;
      while (asked < 2 && performance.now() < end) await __eng.sleep(1);
      want = false;
      const atStop = asked;
      const t0 = performance.now();
      await strip;
      return { atStop, asked, ms: Math.round(performance.now() - t0) };
    } finally { Cut.decoder.createFrameSource = orig; }
  })()`);
  check(unwanted.atStop >= 2 && unwanted.asked <= unwanted.atStop + 1, `a strip no longer wanted stops decoding (${S(unwanted)})`);

  // A long file's peaks (its audio decoded while the reader is held here) do not hold back thumbnails asked for after
  // them, and the coarser peaks the panel and the monitor ask for come from the same decode.
  const lane = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const [vid, aud] = await __eng.importAll(hist, [${S(made['30'].path)}, await __eng.write('tone-lanes.wav', __eng.makeWav(5, 1000))]);
    const orig = Cut.decoder.audioReader;
    let open;
    const gate = new Promise((r) => { open = r; });
    let reads = 0;
    Cut.decoder.audioReader = async (...a) => { reads++; await gate; return orig(...a); };
    try {
      let peaksDone = false;
      const fine = Cut.thumbs.peaks(hist.project, aud, { samplesPerPeak: 256 }).then((p) => { peaksDone = true; return p; });
      const coarse = Cut.thumbs.peaks(hist.project, aud, { samplesPerPeak: 1024 });
      const strip = await Promise.race([Cut.thumbs.strip(hist.project, vid, { from: 254016000000, to: 254016000000 * 2, count: 3, height: 72 }), __eng.sleep(10000).then(() => null)]);
      const stripFirst = !!strip?.length && !peaksDone;
      open();
      const [f, c] = await Promise.all([fine, coarse]);
      const merged = Cut.thumbs.coarsen(f, 4);
      return { stripFirst, reads, fine: f.length, coarse: c.length, same: c.length === merged.length && c.every((v, i) => v === merged[i]) };
    } finally { Cut.decoder.audioReader = orig; open(); }
  })()`);
  check(lane.stripFirst, `thumbnails are made while a file's peaks are still being computed (${S(lane)})`);
  check(lane.reads === 1 && lane.fine === 1876 && lane.same, `peaks of 1024 samples are merged from the 256-sample ones, one decode of the audio (${S(lane)})`);

  // ---- 2D fallback: the same layout ----
  const two = await js(`(async () => {
    const hist = __eng.history(640, 360);
    const seq = hist.project.sequences[0].id;
    const P = Cut.commands;
    const { id } = hist.do(P.addGenerated(seq, { track: 'V1', at: 0, duration: 254016000000 * 2, source: { generator: 'solid', color: '#ff0000' } }));
    const props = hist.project.sequences[0].clips.find((c) => c.id === id).props;
    hist.do(P.setClip(seq, id, { props: { ...props, scale: [40, 60], position: [-80, 30], rotation: 0, crop: [0, 0, 0, 10] } }));
    hist.do(P.addGenerated(seq, { track: 'V2', at: 0, duration: 254016000000 * 2, source: { generator: 'text', layers: [{ text: '레이아웃', size: 60, position: [120, -100], font: 'Malgun Gothic' }] } }));
    const c2 = __eng.canvas(640, 360);
    const comp2 = await Cut.compositor.create(c2, { width: 640, height: 360, backend: '2d' });
    await comp2.render(hist.project, seq, 0);
    const a = await comp2.readPixels();
    await __comp.render(hist.project, seq, 0);
    const b = await __comp.readPixels();
    const red = (r, g, bb) => r > 200 && g < 40 && bb < 40;
    const white = (r, g, bb) => r > 160 && g > 160 && bb > 160;
    // Dissolve in 2D at the midpoint.
    const h2 = __eng.history(640, 360);
    const s2 = h2.project.sequences[0].id;
    h2.do(P.addGenerated(s2, { track: 'V1', at: 0, duration: 254016000000, source: { generator: 'solid', color: '#ff0000' } }));
    h2.do(P.addGenerated(s2, { track: 'V1', at: 254016000000, duration: 254016000000, source: { generator: 'solid', color: '#0000ff' } }));
    h2.do(P.addTransition(s2, { track: 'V1', at: 254016000000, type: 'dissolve', duration: 254016000000 / 3, align: 'center' }));
    await comp2.render(h2.project, s2, 254016000000);
    const d = await comp2.readPixels();
    // An effect 2D cannot do is left out (the chroma key draws the green unkeyed); one with a CSS filter is drawn.
    const h3 = __eng.history(640, 360);
    const s3 = h3.project.sequences[0].id;
    const g3 = h3.do(P.addGenerated(s3, { track: 'V1', at: 0, duration: 254016000000, source: { generator: 'solid', color: '#00ff00' } })).id;
    h3.do(P.addEffect(s3, g3, 'key.chroma'));
    h3.do(P.addEffect(s3, g3, 'noise.grain', null, { amount: 80 }));
    await comp2.render(h3.project, s3, 0);
    const keyed2d = __eng.px(await comp2.readPixels(), 640, 320, 180);
    await __comp.render(h3.project, s3, 0);
    const keyedGpu = __eng.px(await __comp.readPixels(), 640, 320, 180);
    h3.do(P.addEffect(s3, g3, 'color.invert'));
    await comp2.render(h3.project, s3, 0);
    const inverted2d = __eng.px(await comp2.readPixels(), 640, 320, 180);
    return { backend: comp2.backend, red2d: __eng.bbox(a, 640, 360, red), redGpu: __eng.bbox(b, 640, 360, red), text2d: __eng.bbox(a, 640, 360, white), textGpu: __eng.bbox(b, 640, 360, white), mean: __eng.diff(a, b).mean, dissolve: __eng.px(d, 640, 320, 180),
      keyed2d, keyedGpu, inverted2d, errors2d: comp2.errors.slice() };
  })()`);
  const boxNear = (a, b, e) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= e);
  check(two.backend === '2d', 'the 2D fallback can be chosen');
  check(boxNear(two.red2d, two.redGpu, 1), `2D draws the scaled, moved, cropped rectangle where WebGPU does (${S(two.red2d)} vs ${S(two.redGpu)})`);
  check(boxNear(two.text2d, two.textGpu, 3), `2D draws the text where WebGPU does (${S(two.text2d)} vs ${S(two.textGpu)})`);
  check(two.mean < 3, `2D and WebGPU pictures nearly match (mean diff ${two.mean.toFixed(2)})`);
  // Canvas 2D mixes the stored sRGB values (not linear light): the midpoint is half of 255.
  check(Math.abs(two.dissolve[0] - 127.5) <= 2 && Math.abs(two.dissolve[2] - 127.5) <= 2 && two.dissolve[1] < 4, `2D dissolve mixes the two clips at the midpoint, in sRGB values (${S(two.dissolve)})`);
  check(S(two.keyed2d) === '[0,255,0]' && S(two.keyedGpu) === '[0,0,0]' && two.errors2d.length === 0, `an effect 2D cannot do is left out: the green stays unkeyed in 2D (${S(two.keyed2d)}), keyed to the black background in WebGPU (${S(two.keyedGpu)})`);
  check(S(two.inverted2d) === '[255,0,255]', `2D draws invert with its CSS filter: green -> magenta (${S(two.inverted2d)})`);

  // ---- the player: 1080p30 H.264 for 10 s, seeks, dropped frames, no frame left open ----
  const perfClip = await js(`(async () => {
    const t0 = performance.now();
    const r = await __eng.makeMp4({ w: 1920, h: 1080, fps: [30, 1], frames: 420, gop: 60, hw: 'prefer-hardware', bitrate: 8e6 });
    return { path: await __eng.write('perf-1080p30.mp4', r.bytes), mb: r.bytes.length / 1e6, ms: performance.now() - t0, codec: r.codec, reordered: r.reordered };
  })()`);
  console.log(`NOTE 1080p30 test clip: ${perfClip.mb.toFixed(1)} MB ${perfClip.codec}, ${perfClip.reordered} reordered samples, made in ${(perfClip.ms / 1000).toFixed(1)} s`);
  const pl = await js(`(async () => {
    const T = Cut.time;
    const app = Cut.state.createApp();
    const hist = __eng.history(1920, 1080);
    const seq = hist.project.sequences[0].id;
    const [mid] = await __eng.importAll(hist, [${S(perfClip.path)}]);
    hist.do(Cut.commands.place(seq, { source: { media: mid }, at: 0, video: 'V1', audio: null }));
    app.setHistory(hist);
    const canvas = __eng.canvas(960, 540);
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:99999';
    document.body.appendChild(canvas);
    const player = Cut.player.create({ app, canvas });
    await player.ready;
    // Raw throughput first: frames rendered back to back, as fast as decode + composite go.
    const comp = player.compositor;
    let n = 0;
    const r0 = performance.now();
    while (performance.now() - r0 < 3000) { await comp.render(hist.project, seq, T.frameStart(n % 400, [30, 1])); n++; }
    const throughput = n / ((performance.now() - r0) / 1000);
    await comp.idle();
    app.setTime(0);
    let times = [];
    const off = app.on('time', ({ t }) => times.push(t));
    const gaps = [];
    let last = performance.now();
    let watching = true;
    const watch = (now) => { gaps.push(now - last); last = now; if (watching) requestAnimationFrame(watch); };
    requestAnimationFrame(watch);
    const slow = [];
    const offFrame = player.on((e) => { if (e.type === 'frame' && e.ms > 40) slow.push([+T.toSeconds(e.t).toFixed(3), Math.round(e.ms)]); });
    player.play(1);
    const p0 = performance.now();
    await __eng.sleep(10000);
    watching = false;
    offFrame();
    const dec10 = player.compositor.stats().decoders.map((d) => ({ restarts: d.restarts, stalls: d.stalls, delay: d.delay, dropped: d.dropped, misses: d.misses, hits: d.hits }));
    const s10 = player.stats();
    const wall = (performance.now() - p0) / 1000;
    const advanced = T.toSeconds(app.t);
    // Seeks while playing, then backwards shuttle, then stop.
    for (const s of [2, 9, 0.5, 12, 4]) { player.seek(T.fromSeconds(s)); await __eng.sleep(400); }
    player.play(-2);
    await __eng.sleep(1000);
    const backwards = app.t;
    player.pause();
    // Pausing draws once more at full quality on the next animation frame; let that start, then wait for it.
    await __eng.sleep(150);
    await player.render();
    await comp.idle();
    off();
    const st = comp.stats();
    const lent = st.decoders.reduce((x, d) => x + d.borrowed, 0);
    const info = { fps: s10.fps, dropped: s10.dropped, shown: s10.shown, renderMs: s10.renderMs, renderMaxMs: s10.renderMaxMs, advanced, wall, throughput, lent, hw: st.decoders.map((d) => d.hardware), backwards: T.toSeconds(backwards), backend: comp.backend, slow: slow.slice(0, 20), dec10, raf: { n: gaps.length, over40: gaps.filter((g) => g > 40).length, max: Math.max(...gaps) }, monotonic: times.slice(0, 200).every((t, i, a) => i === 0 || t >= a[i - 1]) };
    player.destroy();
    canvas.remove();
    return info;
  })()`);
  console.log(`NOTE playback 1080p30: ${pl.fps.toFixed(1)} fps shown, ${pl.dropped} dropped, ${pl.renderMs.toFixed(1)} ms a frame (max ${pl.renderMaxMs.toFixed(1)} of the last 60), back-to-back throughput ${pl.throughput.toFixed(1)} fps, decoder ${S(pl.hw)}, animation frames ${S(pl.raf)}, slow frames [s, ms] ${S(pl.slow)}, decoder ${S(pl.dec10)}`);
  check(Math.abs(pl.advanced - pl.wall) < 0.6, `the playhead follows the clock: ${pl.advanced.toFixed(2)} s in ${pl.wall.toFixed(2)} s`);
  check(pl.fps >= 25 && pl.dropped <= 15, `1080p30 H.264 plays at ${pl.fps.toFixed(1)} fps with ${pl.dropped} dropped frames in 10 s`);
  check(pl.throughput >= 30, `decode + composite keep up with 30 fps back to back (${pl.throughput.toFixed(1)} fps)`);
  check(pl.monotonic, 'the playhead only moves forward while playing at 1x');
  check(pl.backwards < 4, `shuttle -2 plays backwards (${pl.backwards.toFixed(2)} s after starting at 4 s)`);
  check(pl.lent === 0, 'no frame is still lent out once the player stops');
  const openAfter = await js(`(async () => {
    await __comp.idle();
    __comp.destroy();
    await __eng.sleep(300);
    const end = performance.now() + 15000;
    while (performance.now() < end && Cut.decoder.stats().open > 0) await __eng.sleep(100);
    return Cut.decoder.stats();
  })()`);
  // Thumbnail sources close themselves 10 s after their last use.
  check(openAfter.open === 0, `no VideoFrame left open after playing, seeking and closing (${S(openAfter)})`);
} catch (err) {
  console.log(`FAIL the suite stopped: ${err.stack || err}`);
  check(false, 'the suite ran to the end');
}

// Exceptions from files outside the engine are reported, not counted here.
const foreign = ctx.consoleErrors.filter((e) => !MINE.test(e));
if (foreign.length) console.log(`NOTE renderer exceptions outside the engine:\n  ${foreign.join('\n  ')}`);
ctx.consoleErrors.splice(0, Infinity, ...ctx.consoleErrors.filter((e) => MINE.test(e)));
try { rmSync(home, { recursive: true, force: true }); } catch {}
ctx.finish();
