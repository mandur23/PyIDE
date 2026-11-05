// Decoding for Nano Studio Cut (docs/cut-architecture.md section 8): a frame source per video track that answers
// "the frame shown at source time t" with WebCodecs, and whole audio tracks decoded to PCM.
//
// A frame source keeps one VideoDecoder and feeds it samples in decode order from a sync sample (a "run"). The frame
// for t is the sample with the last pts <= t (probe.sampleAtTime), the one rounding rule preview and export share.
// Decoded frames stay in a cache limited by count and bytes (hardware decoders hand out frames from a small pool, and a
// decoder whose frames are all held stops), evicting those farthest from the playhead, behind it first. A request the
// run cannot reach by decoding forward (before the run, a frame the cache dropped, or past a later sync sample) resets
// the decoder and starts a new run at keyBefore. Chunks carry the sample's presentation rank as their timestamp, so a
// frame coming out maps back to its sample exactly whatever the container's times are.
//
// Frames frameAt returns are clones the caller owns until release(frame). Every VideoFrame this module creates or
// receives is counted (stats().open) and closed exactly once, so the tests can see a leak.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).decoder = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const time = need('time');

  const counts = { open: 0, sources: 0, decoders: 0, cacheBytes: 0 };
  // All frame caches together stay under this many bytes (features section 16: the frame cache has a memory limit).
  // WebGPU does not tell the VRAM size, so it is a setting rather than a share of it.
  const budget = { bytes: 1536 * 1024 * 1024 };
  const live = new Set();
  const closeFrame = (f) => {
    if (!f) return;
    try { f.close(); } catch {}
    counts.open--;
  };
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const frameBytes = (f) => {
    const w = f.codedWidth || f.displayWidth || 1;
    const h = f.codedHeight || f.displayHeight || 1;
    return /^(RGB|BGR)/.test(f.format || '') ? w * h * 4 : Math.ceil(w * h * 1.5);
  };

  // Which decoder configs to try, best first.
  // Up to 1080p the software decoder goes first: a hardware decoder lends its frames from a pool of about ten and holds
  // up to twenty back for reordering, so with B-frame footage the small cache that pool allows dropped frames before
  // they were shown and every drop restarted the run at a sync sample (12-16 fps and 10 frames dropped a second on a
  // 1080p30 YouTube file; software kept up with none dropped). Larger pictures, and codecs only hardware decodes, keep
  // the hardware decoder.
  const SOFTWARE_FIRST_PIXELS = 1920 * 1088;
  async function configs(track, hardware) {
    const media = need('media');
    const order = hardware === false ? ['prefer-software', 'no-preference']
      : (track.width || 0) * (track.height || 0) <= SOFTWARE_FIRST_PIXELS ? ['prefer-software', 'prefer-hardware', 'no-preference']
        : ['prefer-hardware', 'prefer-software', 'no-preference'];
    const out = [];
    for (const pref of order) {
      const cfg = media.videoConfig(track, pref);
      try { if ((await VideoDecoder.isConfigSupported(cfg)).supported) out.push(cfg); } catch {}
    }
    return out;
  }

  function createFrameSource(opened, track, opts = {}) {
    const probe = need('probe');
    const s = track.samples;
    const count = s.count;
    if (!count) throw new Error('the track has no samples');
    const rank = new Uint32Array(count);
    for (let r = 0; r < count; r++) rank[s.order[r]] = r;
    const hardwareWanted = opts.hardware !== false;
    // The frame limit follows the decoder in use (makeDecoder): a hardware decoder whose pool is all in the cache stops.
    const cacheFramesFor = (cfg) => opts.cacheFrames ?? (cfg?.hardwareAcceleration === 'prefer-software' ? 48 : 8);
    const limits = { frames: cacheFramesFor(hardwareWanted ? null : { hardwareAcceleration: 'prefer-software' }), bytes: opts.cacheBytes ?? 384 * 1024 * 1024 };

    const cache = new Map(); // sample index -> { frame, bytes }
    let cacheBytes = 0;
    let borrowed = 0;
    let decoder = null;
    let cfgs = null; // configs left to try; cfgs[0] is the one in use
    let run = null; // { start, fed, outputs: Set, flushed }
    let delay = 1; // samples fed past a frame before waiting for it; grows while a decoder holds frames back
    let focus = 0; // presentation rank of the frame asked for last
    let dir = 1;
    let waiters = [];
    let prefetchRange = null; // [first, last] presentation ranks
    let closed = false;
    let failure = null;
    let wake = null;
    const st = { restarts: 0, decoded: 0, fed: 0, hits: 0, misses: 0, dropped: 0, stalls: 0, why: {} };
    counts.sources++;

    const notify = () => { const w = wake; wake = null; w?.(); };
    const waitEvent = (ms) => new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      wake = () => finish(true);
      setTimeout(() => finish(false), ms);
    });

    function borrow(entry) {
      const f = entry.frame.clone();
      counts.open++;
      borrowed++;
      return f;
    }
    function drop(idx) {
      const e = cache.get(idx);
      if (!e) return;
      cache.delete(idx);
      cacheBytes -= e.bytes;
      counts.cacheBytes -= e.bytes;
      closeFrame(e.frame);
    }
    // Lower is more worth keeping: the distance ahead of the playhead in frames; any frame behind it (in the playing
    // direction) is worth less than every frame the cache can hold ahead.
    const keepScore = (idx) => {
      const d = (rank[idx] - focus) * dir;
      return d >= 0 ? d : limits.frames - d * 4;
    };
    // Drops the cached frame least worth keeping, never one a waiter wants.
    function evictOne() {
      let worst = -1;
      let score = -1;
      for (const idx of cache.keys()) {
        if (waiters.some((w) => w.idx === idx)) continue;
        const v = keepScore(idx);
        if (v > score) { score = v; worst = idx; }
      }
      if (worst < 0) return false;
      drop(worst);
      st.dropped++;
      return true;
    }
    const full = () => cache.size >= limits.frames || cacheBytes >= limits.bytes;

    function onFrame(frame) {
      counts.open++;
      const r = frame.timestamp;
      const idx = Number.isInteger(r) && r >= 0 && r < count ? s.order[r] : -1;
      if (closed || idx < 0 || !run) return void closeFrame(frame);
      st.decoded++;
      run.outputs.add(idx);
      if (cache.has(idx)) drop(idx);
      // The new frame competes with the cached ones: the farthest from the playhead goes, which may be this one.
      const bytes = frameBytes(frame);
      cache.set(idx, { frame, bytes });
      cacheBytes += bytes;
      counts.cacheBytes += bytes;
      while (cache.size > limits.frames || cacheBytes > limits.bytes || (counts.cacheBytes > budget.bytes && cache.size > 1)) if (!evictOne()) break;
      serve();
      notify();
    }
    function onError(err) {
      failure = err;
      notify();
    }
    // Resolves every waiter whose frame is in the cache.
    function serve() {
      if (!waiters.length) return;
      const keep = [];
      for (const w of waiters) {
        const e = cache.get(w.idx);
        if (e) { st.hits++; w.resolve(borrow(e)); } else keep.push(w);
      }
      waiters = keep;
    }

    async function makeDecoder() {
      if (!cfgs) cfgs = await configs(track, hardwareWanted);
      if (!cfgs.length) throw Object.assign(new Error(`this PC cannot decode ${track.codec}`), { code: 'unsupported' });
      limits.frames = cacheFramesFor(cfgs[0]);
      decoder = new VideoDecoder({ output: onFrame, error: onError });
      counts.decoders++;
      decoder.configure(cfgs[0]);
      run = null;
    }
    function discardDecoder() {
      if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch {} }
      if (decoder) counts.decoders--;
      decoder = null;
      run = null;
    }
    function restart(start) {
      st.restarts++;
      if (decoder.state === 'configured') {
        decoder.reset();
        decoder.configure(cfgs[0]);
      }
      run = { start, fed: start, outputs: new Set(), flushed: false };
    }
    // Why the run cannot reach `goal` by decoding forward (null: it can).
    function restartReason(goal) {
      if (!run) return 'start';
      if (goal < run.start) return 'before';
      if (run.outputs.has(goal)) return cache.has(goal) ? null : 'dropped';
      if (goal >= run.fed) {
        if (run.flushed) return 'flushed';
        return probe.keyBefore(track, goal) > run.fed ? 'jump' : null;
      }
      return run.flushed ? 'flushed' : null;
    }
    function needsRestart(goal) {
      const why = restartReason(goal);
      if (why) st.why[why] = (st.why[why] || 0) + 1;
      return !!why;
    }

    const BATCH = 12;
    async function feed(until) {
      const end = Math.min(count, until);
      const from = run.fed;
      const to = Math.min(end, from + BATCH);
      const myRun = run;
      const datas = await probe.readSamples(opened.reader, track, from, to);
      if (closed || run !== myRun || !decoder || decoder.state !== 'configured') return;
      for (let i = 0; i < datas.length; i++) {
        const idx = from + i;
        decoder.decode(new EncodedVideoChunk({ type: s.key[idx] ? 'key' : 'delta', timestamp: rank[idx], data: datas[i] }));
        st.fed++;
      }
      run.fed = to;
      while (decoder && decoder.state === 'configured' && decoder.decodeQueueSize > 6 && !closed && run === myRun) await waitEvent(20);
    }
    async function flush() {
      run.flushed = true;
      const myRun = run;
      try { await decoder.flush(); } catch { /* reset or closed meanwhile */ }
      if (run === myRun) notify();
    }

    // The next sample the work list wants: the oldest waiter's, else the next frame of the prefetch window that the
    // cache can still take without dropping a nearer one.
    function goalNow() {
      if (waiters.length) return { idx: waiters[0].idx, waiter: waiters[0] };
      if (!prefetchRange) return null;
      const [ra, rb] = prefetchRange;
      // Frames ahead of the playhead in the cache and still inside the decoder: decoding more than the cache holds
      // would push out frames that are about to be shown.
      let ahead = run ? run.fed - run.start - run.outputs.size : 0;
      for (const idx of cache.keys()) if ((rank[idx] - focus) * dir >= 0) ahead++;
      if (ahead >= limits.frames - 1) return null;
      for (let r = ra; r <= rb; r++) {
        const idx = s.order[r];
        if (cache.has(idx) || run?.outputs.has(idx)) continue;
        // Prefetch decodes forward only: it never resets a run that is under way.
        if (run && !run.flushed && idx < run.start) continue;
        if (run && run.flushed) return null;
        return { idx, waiter: null };
      }
      return null;
    }

    let driving = null;
    function kick() {
      if (driving || closed) return;
      driving = drive().catch((err) => fail(err)).finally(() => {
        driving = null;
        if (!closed && !failure && goalNow()) kick();
      });
    }
    function fail(err) {
      const e = err instanceof Error ? err : new Error(String(err?.message || err));
      for (const w of waiters) w.reject(e);
      waiters = [];
    }
    async function drive() {
      let stuck = 0;
      while (!closed) {
        if (failure) {
          const err = failure;
          failure = null;
          discardDecoder();
          cfgs?.shift();
          if (!cfgs?.length) {
            cfgs = [];
            throw Object.assign(new Error(`the video cannot be decoded: ${err?.message || err}`), { code: 'decode' });
          }
          continue;
        }
        serve();
        const g = goalNow();
        if (!g) return;
        if (!decoder || decoder.state === 'closed') await makeDecoder();
        if (needsRestart(g.idx)) restart(probe.keyBefore(track, g.idx));
        // A waiter's frame needs the decoder fed a little past it; prefetch feeds one frame at a time, so it never
        // decodes more than the cache can hold.
        const target = Math.min(count, g.waiter ? g.idx + 1 + delay + 1 : g.idx + 1);
        if (run.fed < target) { stuck = 0; await feed(target); continue; }
        if (run.outputs.has(g.idx)) {
          if (!g.waiter) continue;
          // Output but dropped at once (a full cache): the waiter takes the next run.
          if (!cache.has(g.idx)) { run.outputs.delete(g.idx); restart(probe.keyBefore(track, g.idx)); }
          continue;
        }
        if (run.fed >= count && !run.flushed) { await flush(); continue; }
        if (run.flushed) {
          // Flushed and the frame never came: the stream lacks it. Give the nearest frame decoded before it.
          const near = [...cache.keys()].filter((i) => rank[i] <= rank[g.idx]).sort((a, b) => rank[b] - rank[a])[0];
          if (g.waiter) {
            waiters.shift();
            if (near !== undefined) g.waiter.resolve(borrow(cache.get(near)));
            else g.waiter.reject(Object.assign(new Error(`frame ${g.idx} cannot be decoded`), { code: 'decode' }));
          } else {
            prefetchRange = null;
          }
          continue;
        }
        const progressed = await waitEvent(decoder.decodeQueueSize ? 100 : 40);
        if (progressed) { stuck = 0; continue; }
        stuck++;
        st.stalls++;
        // Nothing comes out: the decoder may be out of output buffers (they are all in the cache); free one.
        if (stuck >= 3 && cache.size && evictOne()) { stuck = 0; continue; }
        // It holds frames back for reordering: feed one more, or flush at the end.
        if (stuck >= 2) {
          if (run.fed < count) { delay = Math.min(64, delay + 2); await feed(run.fed + 1); } else await flush();
        }
      }
    }

    const sampleAt = (t) => {
      const idx = probe.sampleAtTime(track, t);
      return idx < 0 ? 0 : idx;
    };

    return {
      track,
      get hardware() { return cfgs?.[0]?.hardwareAcceleration || null; },
      async frameAt(t) {
        if (closed) throw new Error('the frame source is closed');
        const idx = sampleAt(t);
        const r = rank[idx];
        if (r !== focus) dir = r > focus ? 1 : -1;
        focus = r;
        const hit = cache.get(idx);
        if (hit) { st.hits++; return borrow(hit); }
        st.misses++;
        return new Promise((resolve, reject) => {
          waiters.push({ idx, resolve, reject });
          kick();
        });
      },
      // The sample (index) frameAt(t) shows: callers use it to skip a frame they already have.
      sampleAt,
      // Decodes ahead what will be asked for between two source times, as far as the cache can hold.
      prefetch(from, to) {
        if (closed) return;
        const a = rank[sampleAt(Math.min(from, to))];
        const b = rank[sampleAt(Math.max(from, to))];
        prefetchRange = [a, b];
        kick();
      },
      release(frame) {
        if (!frame) return;
        borrowed--;
        closeFrame(frame);
      },
      stats: () => ({ ...st, why: { ...st.why }, cached: cache.size, cacheBytes, borrowed, hardware: cfgs?.[0]?.hardwareAcceleration || null, delay, run: run && { start: run.start, fed: run.fed } }),
      close() {
        if (closed) return;
        closed = true;
        fail(new Error('the frame source is closed'));
        for (const idx of [...cache.keys()]) drop(idx);
        discardDecoder();
        counts.sources--;
        notify();
      },
    };
  }

  function trackedSource(opened, track, opts) {
    const src = createFrameSource(opened, track, opts);
    live.add(src);
    const close = src.close;
    src.close = () => { live.delete(src); close(); };
    return src;
  }

  // ---- audio ---------------------------------------------------------------------------------------------------------

  const audioCache = new Map(); // key -> Promise<{rate, channels, data}>
  const AUDIO_KEEP_BYTES = 1.5 * 1024 ** 3;

  async function decodeWithAudioDecoder(opened, track) {
    const probe = need('probe');
    const s = track.samples;
    const pieces = [];
    let rate = track.sampleRate;
    let channels = track.channels;
    let error = null;
    const dec = new AudioDecoder({
      output: (ad) => {
        try {
          rate = ad.sampleRate;
          channels = ad.numberOfChannels;
          const planes = [];
          for (let c = 0; c < ad.numberOfChannels; c++) {
            const p = new Float32Array(ad.numberOfFrames);
            ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
            planes.push(p);
          }
          pieces.push({ at: ad.timestamp / 1e6, planes });
        } finally { ad.close(); }
      },
      error: (e) => { error = e; },
    });
    dec.configure(need('media').audioConfig(track));
    const BATCH = 256;
    for (let i = 0; i < s.count && !error; i += BATCH) {
      const datas = await probe.readSamples(opened.reader, track, i, Math.min(s.count, i + BATCH));
      for (let k = 0; k < datas.length; k++) {
        const idx = i + k;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: time.toMicros(s.pts[idx]), data: datas[k] }));
      }
      while (dec.decodeQueueSize > 64 && !error) await sleep(5);
    }
    if (!error) await dec.flush().catch((e) => { error = error || e; });
    if (dec.state !== 'closed') dec.close();
    if (error) throw error;
    return { rate, channels, pieces };
  }

  async function decodePcm(opened, track) {
    const probe = need('probe');
    const codecs = need('codecs');
    const s = track.samples;
    const pieces = [];
    for (let i = 0; i < s.count; i += 64) {
      const datas = await probe.readSamples(opened.reader, track, i, Math.min(s.count, i + 64));
      datas.forEach((d, k) => pieces.push({ at: time.toSeconds(s.pts[i + k]), planes: codecs.pcmToFloat(d, track.codec, track.channels) }));
    }
    return { rate: track.sampleRate, channels: track.channels, pieces };
  }

  // The browser's own decoder over the whole file, for audio files AudioDecoder does not take. It resamples to 48 kHz.
  async function decodeWhole(opened) {
    const bytes = await need('codecs').readRange(opened.reader, 0, opened.reader.size);
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    const planes = [];
    for (let c = 0; c < buf.numberOfChannels; c++) planes.push(buf.getChannelData(c).slice());
    return { rate: buf.sampleRate, channels: buf.numberOfChannels, pieces: [{ at: 0, planes }] };
  }

  // Places decoded pieces on one timeline from t = 0 (samples before 0, the encoder's priming, are left out) over the
  // track's length.
  function assemble({ rate, channels, pieces }, seconds) {
    let end = Math.round(seconds * rate);
    for (const p of pieces) end = Math.max(end, Math.round(p.at * rate) + p.planes[0].length);
    if (seconds > 0) end = Math.min(end, Math.round(seconds * rate));
    const data = Array.from({ length: channels }, () => new Float32Array(Math.max(0, end)));
    for (const p of pieces) {
      const at = Math.round(p.at * rate);
      for (let c = 0; c < channels; c++) {
        const src = p.planes[Math.min(c, p.planes.length - 1)];
        const skip = Math.max(0, -at);
        const n = Math.min(src.length - skip, end - Math.max(0, at));
        if (n > 0) data[c].set(src.subarray(skip, skip + n), Math.max(0, at));
      }
    }
    return { rate, channels, data };
  }

  // A whole audio track as PCM: { rate, channels, data: [Float32Array per channel] } from source time 0. Cached.
  function decodeAudio(opened, track) {
    const key = `${opened.path}|${opened.size}|${opened.mtime}|${track.id}`;
    const hit = audioCache.get(key);
    if (hit) {
      audioCache.delete(key);
      audioCache.set(key, hit);
      return hit.promise;
    }
    const entry = { bytes: 0, promise: null };
    entry.promise = (async () => {
      const seconds = time.toSeconds(track.duration || opened.duration || 0);
      let raw;
      if (/^pcm-/.test(track.codec)) raw = await decodePcm(opened, track);
      else {
        let ok = false;
        try { ok = !!(await AudioDecoder.isConfigSupported(need('media').audioConfig(track))).supported; } catch {}
        raw = ok ? await decodeWithAudioDecoder(opened, track) : await decodeWhole(opened);
      }
      const out = assemble(raw, seconds);
      entry.bytes = out.data.reduce((n, d) => n + d.byteLength, 0);
      let total = 0;
      for (const e of [...audioCache.values()].reverse()) {
        total += e.bytes;
        if (total > AUDIO_KEEP_BYTES && e !== entry) for (const [k, v] of audioCache) if (v === e) audioCache.delete(k);
      }
      return out;
    })();
    entry.promise.catch(() => audioCache.delete(key));
    audioCache.set(key, entry);
    return entry.promise;
  }

  // Sync samples one by one, each decoded alone and flushed out: a thumbnail of a sync sample costs one frame's
  // decode, where a frame source feeds a run and waits for the frames a decoder holds back (a software decoder holds
  // several). draw(index, frame) uses the frame before it is closed.
  async function keyFrames(opened, track, indices, draw) {
    const probe = need('probe');
    const list = await configs(track, true);
    if (!list.length) throw Object.assign(new Error(`this PC cannot decode ${track.codec}`), { code: 'unsupported' });
    let got = null;
    let error = null;
    const dec = new VideoDecoder({ output: (f) => { got?.close(); got = f; }, error: (e) => { error = e; } });
    try {
      dec.configure(list[0]);
      for (const idx of indices) {
        const [data] = await probe.readSamples(opened.reader, track, idx, idx + 1);
        dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
        await dec.flush();
        if (error) throw error;
        const f = got;
        got = null;
        if (f) { try { await draw(idx, f); } finally { f.close(); } }
      }
    } finally {
      got?.close();
      if (dec.state !== 'closed') dec.close();
    }
  }

  // Part of an audio track on demand, for long files: decoding all of a 42-minute track took 11.6 s and 0.9 GB before
  // the first sound. -> Promise<{ rate, channels, length, read(from, to) }>, rate the decoder's output rate (HE-AAC
  // doubles the track's) and length in samples at it. read(from, to) -> Promise<[Float32Array per channel]> of samples
  // [from, to), zeros where the track has none. Each read decodes PREROLL packets before `from` and drops them, so an
  // AAC frame's overlap and an MP3 frame's bit reservoir are whole at the window's edge. Raw PCM reads its bytes; a
  // format AudioDecoder does not take is decoded whole once (decodeAudio) and sliced.
  const PREROLL = 12;
  async function audioReader(opened, track) {
    const probe = need('probe');
    const s = track.samples;
    const seconds = time.toSeconds(track.duration || opened.duration || 0);
    const cfg = need('media').audioConfig(track);
    let supported = false;
    if (!/^pcm-/.test(track.codec)) { try { supported = !!(await AudioDecoder.isConfigSupported(cfg)).supported; } catch {} }
    if (!/^pcm-/.test(track.codec) && !supported) {
      const whole = await decodeAudio(opened, track);
      const length = whole.data[0]?.length || 0;
      const read = async (from, to) => whole.data.map((d) => { const out = new Float32Array(Math.max(0, to - from)); const a = Math.max(0, from); const b = Math.min(length, to); if (b > a) out.set(d.subarray(a, b), a - from); return out; });
      return { rate: whole.rate, channels: whole.channels, length, read };
    }
    // Decodes samples [i0, i1) -> { rate, channels, pieces: [{ at: seconds, planes }] }.
    async function decodeSamples(i0, i1) {
      if (/^pcm-/.test(track.codec)) {
        const codecs = need('codecs');
        const datas = await probe.readSamples(opened.reader, track, i0, i1);
        return { rate: track.sampleRate, channels: track.channels, pieces: datas.map((d, k) => ({ at: time.toSeconds(s.pts[i0 + k]), planes: codecs.pcmToFloat(d, track.codec, track.channels) })) };
      }
      const pieces = [];
      let rate = track.sampleRate;
      let channels = track.channels;
      let error = null;
      const dec = new AudioDecoder({
        output: (ad) => {
          try {
            rate = ad.sampleRate;
            channels = ad.numberOfChannels;
            const planes = [];
            for (let c = 0; c < ad.numberOfChannels; c++) {
              const p = new Float32Array(ad.numberOfFrames);
              ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
              planes.push(p);
            }
            pieces.push({ at: ad.timestamp / 1e6, planes });
          } finally { ad.close(); }
        },
        error: (e) => { error = e; },
      });
      dec.configure(cfg);
      const datas = await probe.readSamples(opened.reader, track, i0, i1);
      for (let k = 0; k < datas.length && !error; k++) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: time.toMicros(s.pts[i0 + k]), data: datas[k] }));
      if (!error) await dec.flush().catch((e) => { error = error || e; });
      if (dec.state !== 'closed') dec.close();
      if (error) throw error;
      return { rate, channels, pieces };
    }
    const first = s.count ? await decodeSamples(0, Math.min(s.count, 2)) : { rate: track.sampleRate, channels: track.channels };
    const rate = first.rate || track.sampleRate;
    const channels = first.channels || track.channels;
    const length = Math.round(seconds * rate);
    async function read(from, to) {
      const out = Array.from({ length: channels }, () => new Float32Array(Math.max(0, to - from)));
      if (!s.count || to <= from || to <= 0 || from >= length) return out;
      const ia = Math.max(0, probe.sampleAtTime(track, time.fromSeconds(Math.max(0, from) / rate)) - PREROLL);
      const ib = Math.min(s.count, probe.sampleAtTime(track, time.fromSeconds(to / rate)) + 2);
      const raw = await decodeSamples(ia, ib);
      for (const p of raw.pieces) {
        const at = Math.round(p.at * rate) - from;
        for (let c = 0; c < channels; c++) {
          const src = p.planes[Math.min(c, p.planes.length - 1)];
          const skip = Math.max(0, -at);
          const n = Math.min(src.length - skip, out[c].length - Math.max(0, at));
          if (n > 0) out[c].set(src.subarray(skip, skip + n), Math.max(0, at));
        }
      }
      return out;
    }
    return { rate, channels, length, read };
  }

  return {
    createFrameSource: trackedSource,
    decodeAudio,
    audioReader,
    keyFrames,
    assemble,
    // Every frame source: open = VideoFrames not closed yet (cached and lent out), sources and decoders alive.
    stats: () => ({ ...counts, live: live.size, budget: budget.bytes }),
    // The memory all frame caches may use together, in bytes.
    setBudget(bytes) { if (bytes > 0) budget.bytes = bytes; },
    forgetAudio: () => audioCache.clear(),
  };
});
