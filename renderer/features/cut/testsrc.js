// Test media of Nano Studio Cut, made here so no test needs a downloaded or copyrighted file (docs/cut-architecture.md
// §9): an MP4 whose frame N shows N in big digits and as a row of black and white blocks a test reads back
// (readFrameNumber), with a 1 kHz beep and a white frame every `beepEvery` seconds, at any frame rate (29.97 and
// variable frame rates too), H.264 or HEVC through VideoEncoder and AAC through AudioEncoder, muxed by mp4write.
//
// The block row: 24 cells across the top of the picture, white, black, the frame number in 20 bits (most significant
// first, white = 1), even parity, white. It is read relative to the picture, so it survives scaling and compression;
// a picture that is a mix of two frames (a dissolve) fails the guards or the parity and reads as -1.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).testsrc = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const mod = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const time = mod('time');
  const { TICKS } = time;

  const CELLS = 24;
  const BITS = 20;
  // Frame lengths of the variable frame rate, in nominal frames: the average stays the nominal rate.
  const VFR_PATTERN = [1, 1, 2, 0.5, 0.5, 1, 1.5, 0.5];

  function blockLayout(w, h) {
    const x0 = Math.round(w * 0.04);
    const x1 = Math.round(w * 0.96);
    const y0 = Math.round(h * 0.05);
    const y1 = Math.round(h * 0.15);
    const pad = Math.round((y1 - y0) * 0.12);
    return { x0, x1, y0, y1, cy0: y0 + pad, cy1: y1 - pad, cell: (x1 - x0) / CELLS };
  }

  function cellValues(n) {
    const v = new Array(CELLS);
    v[0] = 1;
    v[1] = 0;
    let parity = 0;
    for (let b = 0; b < BITS; b++) {
      const bit = Math.floor(n / 2 ** (BITS - 1 - b)) & 1;
      v[2 + b] = bit;
      parity ^= bit;
    }
    v[22] = parity;
    v[23] = 1;
    return v;
  }

  // Paints the block row of frame n into RGBA pixels (the Node tests; drawFrame draws the same with Canvas 2D).
  function paintBlocks(rgba, w, h, n) {
    const L = blockLayout(w, h);
    const v = cellValues(n);
    const fill = (x0, y0, x1, y1, c) => {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
          const i = (y * w + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = c;
          rgba[i + 3] = 255;
        }
      }
    };
    fill(L.x0, L.y0, L.x1, L.y1, 128);
    for (let k = 0; k < CELLS; k++) fill(Math.round(L.x0 + k * L.cell), L.cy0, Math.round(L.x0 + (k + 1) * L.cell), L.cy1, v[k] ? 255 : 0);
  }

  // The frame number in RGBA pixels of a w x h image, -1 when there is no readable block row. `region` is where the
  // test picture is inside the image ({x, y, w, h}, the whole image by default), for a clip scaled or moved.
  function readFrameNumber(rgba, w, h, region = null) {
    const r = region || { x: 0, y: 0, w, h };
    const L = blockLayout(r.w, r.h);
    const cy0 = r.y + L.cy0 + (L.cy1 - L.cy0) * 0.3;
    const cy1 = r.y + L.cy0 + (L.cy1 - L.cy0) * 0.7;
    const luma = [];
    for (let k = 0; k < CELLS; k++) {
      const cx0 = r.x + L.x0 + (k + 0.3) * L.cell;
      const cx1 = r.x + L.x0 + (k + 0.7) * L.cell;
      const sx = Math.max(1, (cx1 - cx0) / 6);
      const sy = Math.max(1, (cy1 - cy0) / 6);
      let sum = 0;
      let n = 0;
      for (let y = cy0; y < cy1; y += sy) {
        for (let x = cx0; x < cx1; x += sx) {
          const xi = Math.floor(x);
          const yi = Math.floor(y);
          if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
          const i = (yi * w + xi) * 4;
          sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
          n++;
        }
      }
      luma.push(n ? sum / n : -1);
    }
    const white = luma[0];
    const black = luma[1];
    if (white - black < 80) return -1;
    const mid = (white + black) / 2;
    // A cell must be near black or near white: a mix of two frames (a dissolve) leaves gray cells.
    const margin = (white - black) * 0.3;
    let value = 0;
    let parity = 0;
    for (let b = 0; b < BITS; b++) {
      const l = luma[2 + b];
      if (Math.abs(l - mid) < margin) return -1;
      const bit = l > mid ? 1 : 0;
      value = value * 2 + bit;
      parity ^= bit;
    }
    const p = luma[22];
    if (Math.abs(p - mid) < margin || (p > mid ? 1 : 0) !== parity) return -1;
    if (luma[23] < mid + margin) return -1;
    return value;
  }

  // The frames, beeps and flashed frames of a test source: {frames: [{t, duration}], beeps: [t], flashes: Set of frame
  // indexes, duration} (ticks). A beep is at every multiple of beepEvery seconds from 0; the frame on screen then is white.
  function schedule({ seconds = 10, fps = [30, 1], beepEvery = 1, vfr = false } = {}) {
    const total = Math.round(seconds * TICKS);
    const f = time.frameTicks(fps);
    const frames = [];
    if (vfr) {
      for (let t = 0, i = 0; t < total; i++) {
        const d = Math.round(f * VFR_PATTERN[i % VFR_PATTERN.length]);
        frames.push({ t, duration: d });
        t += d;
      }
    } else {
      const n = Math.round((seconds * fps[0]) / fps[1]);
      for (let i = 0; i < n; i++) frames.push({ t: time.frameStart(i, fps), duration: time.frameStart(i + 1, fps) - time.frameStart(i, fps) });
    }
    const beeps = [];
    if (beepEvery > 0) for (let k = 0; k * beepEvery * TICKS < total - 1; k++) beeps.push(Math.round(k * beepEvery * TICKS));
    const out = { frames, beeps, flashes: new Set(), duration: frames.length ? frames.at(-1).t + frames.at(-1).duration : 0 };
    for (const b of beeps) out.flashes.add(frameAtTime(out, b));
    return out;
  }

  function frameAtTime(sch, t) {
    const fr = sch.frames;
    let lo = 0;
    let hi = fr.length - 1;
    if (!fr.length || t < fr[0].t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fr[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Draws frame i on a Canvas 2D context.
  function drawFrame(ctx, w, h, i, { flash = false, t = 0 } = {}) {
    ctx.fillStyle = flash ? '#ffffff' : '#1d2a3a';
    ctx.fillRect(0, 0, w, h);
    // A bar that moves a little every frame, so frames differ beyond their digits.
    ctx.fillStyle = flash ? '#c0c0c0' : '#3a6ea5';
    const bw = Math.max(4, Math.round(w / 40));
    ctx.fillRect(Math.round(((i * 7) % 40) * (w / 40)), Math.round(h * 0.86), bw, Math.round(h * 0.06));
    ctx.fillStyle = flash ? '#000000' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(h * 0.42)}px sans-serif`;
    ctx.fillText(String(i), w / 2, h * 0.55);
    ctx.font = `${Math.max(10, Math.round(h * 0.045))}px monospace`;
    ctx.fillText(`${(t / TICKS).toFixed(3)} s`, w / 2, h * 0.8);
    const L = blockLayout(w, h);
    const v = cellValues(i);
    ctx.fillStyle = '#808080';
    ctx.fillRect(L.x0, L.y0, L.x1 - L.x0, L.y1 - L.y0);
    for (let k = 0; k < CELLS; k++) {
      ctx.fillStyle = v[k] ? '#ffffff' : '#000000';
      const x0 = Math.round(L.x0 + k * L.cell);
      ctx.fillRect(x0, L.cy0, Math.round(L.x0 + (k + 1) * L.cell) - x0, L.cy1 - L.cy0);
    }
  }

  // The sound: silence with a 1 kHz sine (amplitude `beepLevel`) of `beepLength` seconds at each beep, or a steady
  // tone of `tone` Hz all along. -> [Float32Array per channel]
  function soundOf(sch, { sampleRate = 48000, channels = 2, beepLength = 0.1, beepLevel = 0.5, tone = 0, toneLevel = 0.1 } = {}) {
    const n = Math.round((sch.duration * sampleRate) / TICKS);
    const a = new Float32Array(n);
    if (tone > 0) {
      for (let i = 0; i < n; i++) a[i] = toneLevel * Math.sin((2 * Math.PI * tone * i) / sampleRate);
    } else {
      const len = Math.round(beepLength * sampleRate);
      for (const b of sch.beeps) {
        const at = Math.round((b * sampleRate) / TICKS);
        for (let k = 0; k < len && at + k < n; k++) a[at + k] = beepLevel * Math.sin((2 * Math.PI * 1000 * k) / sampleRate);
      }
    }
    return Array.from({ length: channels }, () => a);
  }

  function memorySink() {
    const parts = [];
    let end = 0;
    return {
      write(bytes, position) {
        const at = position ?? end;
        parts.push({ at, bytes: position == null ? bytes : bytes.slice() });
        end = Math.max(end, at + bytes.length);
        return Promise.resolve();
      },
      bytes() {
        const out = new Uint8Array(end);
        for (const p of parts) out.set(p.bytes, p.at);
        return out;
      },
    };
  }

  // -> {bytes, schedule, codec, hardware, audioDelay}. Options: seconds, fps, w, h, codec ('avc' | 'hevc' | a codec
  // string), beepEvery, vfr, audio (false for none), beepLength, tone (a steady tone instead of beeps), hardware
  // ('no-preference' | 'prefer-hardware' | 'prefer-software'), bitrate, keyEvery (seconds), sampleRate, channels.
  async function build(o = {}) {
    const opts = { seconds: 10, fps: [30, 1], w: 1280, h: 720, codec: 'avc', beepEvery: 1, vfr: false, audio: true, hardware: 'no-preference', keyEvery: 1, sampleRate: 48000, channels: 2, ...o };
    const presets = mod('presets');
    const mp4write = mod('mp4write');
    const exporter = mod('export');
    const sch = schedule(opts);
    const fpsV = time.fpsValue(opts.fps);
    const { w, h } = opts;
    const family = /^(hevc|hvc1|hev1)/.test(opts.codec) ? 'hevc' : 'avc';
    const bitrate = opts.bitrate || Math.round(w * h * fpsV * 0.12);
    const codec = opts.codec.includes('.') ? opts.codec : family === 'hevc' ? presets.hevcCodec(w, h, fpsV, bitrate) : presets.avcCodec(w, h, fpsV, bitrate);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    const chunks = [];
    let description = null;
    let colorSpace = null;
    let failure = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !description) description = new Uint8Array(ArrayBuffer.isView(meta.decoderConfig.description) ? meta.decoderConfig.description.buffer.slice(0) : meta.decoderConfig.description.slice(0));
        if (meta?.decoderConfig?.colorSpace && !colorSpace) colorSpace = { ...meta.decoderConfig.colorSpace };
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, key: chunk.type === 'key' });
      },
      error: (e) => { failure = e; },
    });
    enc.configure({ codec, width: w, height: h, bitrate, framerate: fpsV, hardwareAcceleration: opts.hardware, latencyMode: 'quality',
      ...(family === 'avc' ? { avc: { format: 'avc' } } : { hevc: { format: 'hevc' } }) });
    let nextKey = 0;
    for (let i = 0; i < sch.frames.length; i++) {
      if (failure) break;
      const f = sch.frames[i];
      drawFrame(ctx, w, h, i, { flash: sch.flashes.has(i), t: f.t });
      const frame = new VideoFrame(canvas, { timestamp: time.toMicros(f.t), duration: time.toMicros(f.duration), alpha: 'discard' });
      const key = f.t >= nextKey;
      while (nextKey <= f.t) nextKey += opts.keyEvery * TICKS;
      enc.encode(frame, { keyFrame: key });
      frame.close();
      while (enc.encodeQueueSize > 6 && !failure) await new Promise((r) => setTimeout(r, 1));
    }
    if (!failure) await enc.flush().catch((e) => { failure = failure || e; });
    if (enc.state !== 'closed') enc.close();
    if (failure) throw failure;
    if (chunks.length !== sch.frames.length) throw new Error(`the encoder gave ${chunks.length} frames for ${sch.frames.length}`);

    let audio = null;
    if (opts.audio) audio = await exporter.encodeAudio(soundOf(sch, opts), opts.sampleRate, { bitrate: opts.audioBitrate || 128000 });
    const sink = memorySink();
    const writer = mp4write.create({
      video: { codec, width: w, height: h, description, frameRate: opts.fps, colorSpace: colorSpace || { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } },
      audio: audio ? { codec: 'mp4a.40.2', sampleRate: opts.sampleRate, channels: opts.channels, description: audio.description } : null,
      sink,
      timescale: opts.vfr ? 2 * mp4write.videoTimescale(opts.fps) : undefined,
    });
    // In time order across the tracks, as an export adds them.
    let a = 0;
    const aud = audio ? audio.chunks : [];
    for (let i = 0; i < chunks.length; i++) {
      const f = sch.frames[i];
      while (a < aud.length && aud[a].timestamp <= f.t) writer.addAudio(aud[a++]);
      writer.addVideo({ data: chunks[i].data, timestamp: f.t, duration: f.duration, key: chunks[i].key });
    }
    while (a < aud.length) writer.addAudio(aud[a++]);
    await writer.finish();
    return { bytes: sink.bytes(), schedule: sch, codec, hardware: opts.hardware, audioDelay: audio?.delay ?? null };
  }

  const make = async (opts) => (await build(opts)).bytes;

  // Makes a test source and saves it at `path` -> {ok, path, bytes, schedule} (through the export file sink).
  async function write(path, opts) {
    const r = await build(opts);
    const saved = await mod('export').saveBytes(path, r.bytes);
    return { ...saved, schedule: r.schedule, codec: r.codec };
  }

  return { make, build, write, schedule, frameAtTime, readFrameNumber, paintBlocks, blockLayout, drawFrame, soundOf, memorySink, CELLS, BITS };
});
