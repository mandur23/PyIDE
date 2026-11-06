// Thumbnails and waveform peaks of Nano Studio Cut's media (docs/cut-architecture.md section 8), for the project panel
// and the timeline's clips. Both are cached twice: in memory for this session and in the app's common cache
// (cut:cacheGet / cut:cachePut, least recently used files go first), keyed by the file's path, size and mtime, so a
// changed file gets new ones. Thumbnails and peaks each run in their own queue, one job at a time, both held while the
// player plays.
//
// strip() snaps each time to the frame shown there, so zooming the timeline reuses the thumbnails it already has.
// Bitmaps are shared: callers draw them and never close them.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).thumbs = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);

  const invoke = (...args) => Promise.resolve(globalThis.ide?.api?.invoke?.(...args));
  const cacheGet = (key) => invoke('cut:cacheGet', key).then((r) => (r instanceof Uint8Array && r.length ? r : null)).catch(() => null);
  const cachePut = (key, bytes) => invoke('cut:cachePut', key, bytes).catch(() => {});

  // ---- the work queues -------------------------------------------------------------------------------------------------

  // One queue for pictures and one for sound, each a job at a time: a long file's peaks (seconds of audio decoding)
  // must not hold back the thumbnails asked for after them.
  const lanes = { video: { jobs: [], running: false }, audio: { jobs: [], running: false } };
  let paused = false;
  let resumes = [];
  function enqueue(fn, lane = lanes.video) {
    return new Promise((resolve, reject) => {
      lane.jobs.push({ fn, resolve, reject });
      pump(lane);
    });
  }
  async function pump(lane) {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.jobs.length) {
        while (paused) await new Promise((r) => resumes.push(r));
        const job = lane.jobs.shift();
        try { job.resolve(await job.fn()); } catch (err) { job.reject(err); }
      }
    } finally { lane.running = false; }
  }
  function pause(on) {
    paused = !!on;
    if (!paused) { const r = resumes; resumes = []; for (const f of r) f(); }
  }

  // ---- thumbnails ----------------------------------------------------------------------------------------------------

  const bitmaps = new Map(); // key -> ImageBitmap (LRU)
  const KEEP_BITMAPS = 600;
  function remember(key, bmp) {
    bitmaps.delete(key);
    bitmaps.set(key, bmp);
    while (bitmaps.size > KEEP_BITMAPS) {
      const [k, old] = bitmaps.entries().next().value;
      bitmaps.delete(k);
      old.close?.();
    }
    return bmp;
  }
  const recall = (key) => {
    const b = bitmaps.get(key);
    if (b) { bitmaps.delete(key); bitmaps.set(key, b); }
    return b || null;
  };
  // One frame source per file for thumbnails, closed when idle.
  const thumbSources = new Map(); // path -> { src, timer }
  function thumbSource(opened) {
    let e = thumbSources.get(opened.path);
    if (!e) {
      e = { src: need('decoder').createFrameSource(opened, opened.video, { hardware: true, cacheFrames: 4 }), timer: null };
      thumbSources.set(opened.path, e);
    }
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { e.src.close(); thumbSources.delete(opened.path); }, 10000);
    return e.src;
  }

  function canvasOf(w, h) {
    return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  async function encode(canvas) {
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 }) : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    return new Uint8Array(await blob.arrayBuffer());
  }
  function drawTurned(g, source, w, h, rotation) {
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(((rotation || 0) * Math.PI) / 180);
    const turned = rotation === 90 || rotation === 270;
    g.drawImage(source, turned ? -h / 2 : -w / 2, turned ? -w / 2 : -h / 2, turned ? h : w, turned ? w : h);
    g.restore();
  }

  // `count` thumbnails evenly from `from` to `to` (source ticks), `height` pixels high. Images give `count` copies of
  // one; audio gives none.
  async function strip(project, mediaId, { from = 0, to = null, count = 8, height = 48 } = {}) {
    const m = project.media.find((x) => x.id === mediaId);
    if (!m || m.kind === 'audio') return [];
    const o = await need('media').open(project, mediaId);
    if (o.error) return [];
    const h = Math.max(8, Math.round(height));
    const w = Math.max(8, Math.round((h * (o.width || 16)) / (o.height || 9)));
    const base = `thumb1|${o.path}|${o.size}|${o.mtime}|${h}`;
    if (o.image) {
      const key = `${base}|img`;
      let b = recall(key);
      if (!b) {
        const c = canvasOf(w, h);
        c.getContext('2d').drawImage(o.image, 0, 0, w, h);
        b = remember(key, await createImageBitmap(c));
      }
      return Array.from({ length: Math.max(0, count) }, () => b);
    }
    if (!o.video) return [];
    const end = to ?? o.duration;
    const n = Math.max(0, Math.floor(count));
    const probe = need('probe');
    const times = Array.from({ length: n }, (_, i) => (n === 1 ? from : from + ((end - from) * i) / Math.max(1, n - 1)));
    // Thumbnails far apart show the sync sample before their time when it is within half the spacing: one decoded
    // frame each instead of a sync sample's whole run (64 thumbnails of a 42-minute file took 32 s).
    const spacing = n > 1 ? (end - from) / (n - 1) : 0;
    const vs = o.video.samples;
    const samples = times.map((t) => {
      const idx = Math.max(0, probe.sampleAtTime(o.video, Math.min(t, Math.max(0, o.duration - 1))));
      const key = probe.keyBefore(o.video, idx);
      return key >= 0 && vs.pts[idx] - vs.pts[key] <= spacing / 2 ? key : idx;
    });
    const out = new Array(n).fill(null);
    const missing = [];
    for (let i = 0; i < n; i++) {
      const key = `${base}|${samples[i]}`;
      const b = recall(key);
      if (b) out[i] = b;
      else missing.push(i);
    }
    if (!missing.length) return out;
    // Disk cache first, then decode what is left in time order.
    const left = [];
    await Promise.all(missing.map(async (i) => {
      const key = `${base}|${samples[i]}`;
      const bytes = await cacheGet(key);
      if (!bytes) { left.push(i); return; }
      try { out[i] = recall(key) || remember(key, await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))); } catch { left.push(i); }
    }));
    if (left.length) {
      left.sort((a, b) => o.video.samples.pts[samples[a]] - o.video.samples.pts[samples[b]]);
      await enqueue(async () => {
        const c = canvasOf(w, h);
        const g = c.getContext('2d');
        const keep = async (i, frame) => {
          const key = `${base}|${samples[i]}`;
          g.clearRect(0, 0, w, h);
          drawTurned(g, frame, w, h, o.rotation);
          out[i] = remember(key, await createImageBitmap(c));
          encode(c).then((bytes) => cachePut(key, bytes)).catch(() => {});
        };
        const todo = left.filter((i) => !(out[i] = recall(`${base}|${samples[i]}`)));
        const dec = need('decoder');
        const keys = dec.keyFrames ? todo.filter((i) => vs.key[samples[i]]) : [];
        if (keys.length) {
          const byIndex = new Map(keys.map((i) => [samples[i], i]));
          try { await dec.keyFrames(o, o.video, [...byIndex.keys()], (idx, frame) => keep(byIndex.get(idx), frame)); } catch {}
        }
        for (const i of todo) {
          if (out[i] || (out[i] = recall(`${base}|${samples[i]}`))) continue;
          // Asked for each frame: that keeps the source's idle timer from closing it under a long strip.
          const src = thumbSource(o);
          const frame = await src.frameAt(vs.pts[samples[i]]);
          try { await keep(i, frame); } finally { src.release(frame); }
        }
      });
    }
    // A frame that could not be made shows its neighbour's thumbnail.
    const any = out.find(Boolean) || null;
    return any ? out.map((b) => b || any) : [];
  }

  // ---- peaks ---------------------------------------------------------------------------------------------------------

  // min/max pairs over blocks of `samplesPerPeak` samples, every channel together: [min0, max0, min1, max1, ...].
  function computePeaks(data, samplesPerPeak) {
    const len = data[0]?.length || 0;
    const spp = Math.max(1, Math.round(samplesPerPeak));
    const n = Math.ceil(len / spp);
    const out = new Float32Array(n * 2);
    for (let b = 0; b < n; b++) {
      let lo = Infinity;
      let hi = -Infinity;
      const a = b * spp;
      const e = Math.min(len, a + spp);
      for (const ch of data) {
        for (let i = a; i < e; i++) {
          const v = ch[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      out[b * 2] = lo === Infinity ? 0 : lo;
      out[b * 2 + 1] = hi === -Infinity ? 0 : hi;
    }
    return out;
  }
  // Peaks of `k` neighbouring blocks merged: the peaks of blocks k times as long.
  function coarsen(fine, k) {
    const n = fine.length / 2;
    const out = new Float32Array(Math.ceil(n / k) * 2);
    for (let b = 0; b * k < n; b++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = b * k, e = Math.min(n, i + k); i < e; i++) {
        if (fine[i * 2] < lo) lo = fine[i * 2];
        if (fine[i * 2 + 1] > hi) hi = fine[i * 2 + 1];
      }
      out[b * 2] = lo;
      out[b * 2 + 1] = hi;
    }
    return out;
  }
  // The panel, the timeline and the monitor ask for different block sizes; multiples of this one are merged from it,
  // so a file's audio is decoded once.
  const BASE_SPP = 256;
  const peakMemo = new Map();
  function remembered(key, make) {
    if (peakMemo.has(key)) return peakMemo.get(key);
    const p = make();
    peakMemo.set(key, p);
    p.catch(() => peakMemo.delete(key));
    if (peakMemo.size > 200) peakMemo.delete(peakMemo.keys().next().value);
    return p;
  }
  // Peaks of a file's audio, `samplesPerPeak` samples of the track's own rate each.
  async function peaks(project, mediaId, { samplesPerPeak = BASE_SPP } = {}) {
    const m = project.media.find((x) => x.id === mediaId);
    if (!m || !m.audio) return new Float32Array(0);
    const o = await need('media').open(project, mediaId);
    if (o.error || !o.audio) return new Float32Array(0);
    const spp = Math.max(1, Math.round(samplesPerPeak));
    const key = (s) => `peaks1|${o.path}|${o.size}|${o.mtime}|${o.audio.id}|${s}`;
    if (spp > BASE_SPP && spp % BASE_SPP === 0) {
      return remembered(key(spp), async () => coarsen(await peaks(project, mediaId, { samplesPerPeak: BASE_SPP }), spp / BASE_SPP));
    }
    return remembered(key(spp), async () => {
      const bytes = await cacheGet(key(spp));
      if (bytes && bytes.length % 8 === 0) return new Float32Array(bytes.slice().buffer);
      return enqueue(async () => {
        // About ten seconds (a whole number of peaks) at a time: the whole track's PCM is never held.
        const r = await need('decoder').audioReader(o, o.audio);
        const win = spp * Math.max(1, Math.round((r.rate * 10) / spp));
        const out = new Float32Array(Math.ceil(r.length / spp) * 2);
        for (let a = 0; a < r.length; a += win) out.set(computePeaks(await r.read(a, Math.min(r.length, a + win)), spp), (a / spp) * 2);
        cachePut(key(spp), new Uint8Array(out.buffer.slice(0)));
        return out;
      }, lanes.audio);
    });
  }

  return { strip, peaks, computePeaks, coarsen, pause, get paused() { return paused; }, get queued() { return lanes.video.jobs.length + lanes.audio.jobs.length; } };
});
