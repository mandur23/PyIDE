// The sound of Nano Studio Cut (docs/cut-architecture.md §9, features §12): one mixer computes the sequence's audio
// sample by sample (every audio clip with its volume and volume keyframes, pan, fade handles, audio crossfades, track
// volume, pan, mute and solo, speed changes with the pitch kept by a WSOLA time stretch, reverse), and both the preview
// and the export use it, so what is heard is what is exported. The preview plays the mix through Web Audio in short
// blocks scheduled on the AudioContext clock, which is the sequence clock the player follows (now()). Also: BS.1770-4
// loudness (K-weighting, gating) and true peak, the gain that normalizes a peak to -1 dB, and a resampler.
//
// Pan is a balance law for every source (center: both channels at full level; a mono source is copied to both). Fade
// handles are linear in amplitude; audio transitions are constant power (sin/cos) over the transition's range, using
// source audio past the clip's ends where there is some.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).audioengine = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  // Looked up when used: a module listed before this one may be (re)loaded after it.
  const mod = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const time = mod('time');
  const { TICKS } = time;

  const dbToGain = (db) => (!(db > -144) ? 0 : Math.pow(10, db / 20));
  const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

  // ---- resampling --------------------------------------------------------------------------------------------------

  function besselI0(x) {
    let sum = 1;
    let term = 1;
    const q = (x * x) / 4;
    for (let k = 1; k < 60; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < 1e-14 * sum) break;
    }
    return sum;
  }

  // Windowed-sinc interpolation: HALF taps each side, PHASES fractional positions, Kaiser window.
  const RS_HALF = 16;
  const RS_PHASES = 1024;
  const RS_BETA = 8.6;
  const rsTables = new Map();
  function rsTable(cutoff) {
    const key = cutoff.toFixed(6);
    if (rsTables.has(key)) return rsTables.get(key);
    const taps = 2 * RS_HALF;
    const table = new Float32Array((RS_PHASES + 1) * taps);
    const i0b = besselI0(RS_BETA);
    for (let p = 0; p <= RS_PHASES; p++) {
      const frac = p / RS_PHASES;
      for (let k = 0; k < taps; k++) {
        const x = k - (RS_HALF - 1) - frac;
        const u = x / RS_HALF;
        const w = Math.abs(u) >= 1 ? 0 : besselI0(RS_BETA * Math.sqrt(1 - u * u)) / i0b;
        const s = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
        table[p * taps + k] = cutoff * s * w;
      }
    }
    rsTables.set(key, table);
    return table;
  }

  // channels: [Float32Array] at `from` Hz -> new arrays at `to` Hz (length scaled, rounded).
  function resample(channels, from, to) {
    if (from === to) return channels.map((c) => c.slice());
    const ratio = from / to;
    const cutoff = Math.min(1, to / from) * 0.96;
    const table = rsTable(cutoff);
    const taps = 2 * RS_HALF;
    return channels.map((x) => {
      const n = x.length;
      const outLen = Math.round((n * to) / from);
      const y = new Float32Array(outLen);
      for (let j = 0; j < outLen; j++) {
        const pos = j * ratio;
        const i0 = Math.floor(pos);
        const p = Math.round((pos - i0) * RS_PHASES) * taps;
        const base = i0 - (RS_HALF - 1);
        let acc = 0;
        if (base >= 0 && base + taps <= n) {
          for (let k = 0; k < taps; k++) acc += x[base + k] * table[p + k];
        } else {
          for (let k = 0; k < taps; k++) {
            const i = base + k;
            if (i >= 0 && i < n) acc += x[i] * table[p + k];
          }
        }
        y[j] = acc;
      }
      return y;
    });
  }

  // ---- time stretch (WSOLA) ----------------------------------------------------------------------------------------

  // channels -> channels about `factor` times as long (2: half speed), the pitch kept. Hann frames of 40 ms at a
  // 20 ms output hop; each frame is taken from within 10 ms of its nominal input position where it continues the
  // previous frame best (cross-correlation, searched on a 4x decimated mono mix, then refined).
  function stretch(channels, factor, rate = 48000) {
    const inLen = channels[0]?.length || 0;
    const outLen = Math.round(inLen * factor);
    if (Math.abs(factor - 1) < 1e-9) return channels.map((c) => c.slice());
    const N = 2 * Math.max(64, Math.round(rate * 0.02));
    const hop = N / 2;
    const tol = Math.round(rate * 0.01);
    const D = 4;
    const L = hop;
    const nCh = channels.length;
    const mono = new Float32Array(inLen);
    for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] += c[i] / nCh;
    const dLen = Math.floor(inLen / D);
    const dec = new Float32Array(dLen);
    for (let i = 0; i < dLen; i++) { let s = 0; for (let k = 0; k < D; k++) s += mono[i * D + k]; dec[i] = s / D; }
    const win = new Float32Array(N);
    for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
    const out = channels.map(() => new Float32Array(outLen));
    const at = (arr, i) => (i >= 0 && i < arr.length ? arr[i] : 0);

    function corr(arr, a, b, len, step) {
      let num = 0;
      let eb = 0;
      for (let i = 0; i < len; i += step) {
        const y = at(arr, b + i);
        num += at(arr, a + i) * y;
        eb += y * y;
      }
      return eb > 1e-12 ? num / Math.sqrt(eb) : 0;
    }

    let prev = null;
    for (let k = -1; k * hop < outLen; k++) {
      const outPos = k * hop;
      const nominal = Math.round(outPos / factor);
      let best = nominal;
      if (prev !== null) {
        const target = prev + hop;
        let bestScore = -Infinity;
        const dt = Math.round(target / D);
        const dn = Math.round(nominal / D);
        const dTol = Math.ceil(tol / D);
        const dL = Math.floor(L / D);
        let coarse = dn;
        for (let d = -dTol; d <= dTol; d++) {
          const s = corr(dec, dt, dn + d, dL, 1);
          if (s > bestScore) { bestScore = s; coarse = dn + d; }
        }
        bestScore = -Infinity;
        for (let d = -D; d <= D; d++) {
          const cand = coarse * D + d;
          if (Math.abs(cand - nominal) > tol + D) continue;
          const s = corr(mono, target, cand, L, 2);
          if (s > bestScore) { bestScore = s; best = cand; }
        }
      }
      for (let c = 0; c < nCh; c++) {
        const x = channels[c];
        const y = out[c];
        for (let n = 0; n < N; n++) {
          const o = outPos + n;
          if (o < 0 || o >= outLen) continue;
          const i = best + n;
          if (i >= 0 && i < inLen) y[o] += x[i] * win[n];
        }
      }
      prev = best;
    }
    return out;
  }

  // ---- loudness (ITU-R BS.1770-4) ----------------------------------------------------------------------------------

  // The two K-weighting biquads for sample rate fs ([b0, b1, b2, a1, a2] each), from the filter's analog prototype.
  function kFilters(fs) {
    let f0 = 1681.974450955533;
    const G = 3.999843853973347;
    let Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / fs);
    a0 = 1 + K / Q + K * K;
    const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
    return [shelf, hp];
  }

  const channelWeights = (n) => (n === 6 ? [1, 1, 1, 0, 1.41, 1.41] : n === 5 ? [1, 1, 1, 1.41, 1.41] : new Array(n).fill(1));

  // True peak: the signal oversampled 4x (2x at 96 kHz and up, 1x at 192 kHz and up) by a polyphase windowed sinc.
  const TP_TAPS = 16;
  const tpTables = new Map();
  function tpTable(L) {
    if (tpTables.has(L)) return tpTables.get(L);
    const half = TP_TAPS / 2;
    const table = [];
    const i0b = besselI0(8);
    for (let p = 0; p < L; p++) {
      const frac = p / L;
      const row = new Float32Array(TP_TAPS);
      for (let k = 0; k < TP_TAPS; k++) {
        const x = k - (half - 1) - frac;
        const u = x / half;
        const w = Math.abs(u) >= 1 ? 0 : besselI0(8 * Math.sqrt(1 - u * u)) / i0b;
        row[k] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
      }
      table.push(row);
    }
    tpTables.set(L, table);
    return table;
  }

  // A streaming meter: push([Float32Array per channel]) as audio comes, result() -> {integrated, truePeak,
  // momentaryMax, shortTermMax, samplePeak}. LUFS / dBTP / dBFS; -Infinity for silence.
  function createMeter(rate, nCh) {
    const [shelf, hp] = kFilters(rate);
    const weights = channelWeights(nCh);
    const st = Array.from({ length: nCh }, () => new Float64Array(8)); // x1 x2 y1 y2 of each biquad
    const seg = Math.round(rate / 10);
    const segPower = []; // weighted mean square of each 100 ms segment
    let acc = new Float64Array(nCh);
    let accN = 0;
    const L = rate >= 192000 ? 1 : rate >= 96000 ? 2 : 4;
    const tp = tpTable(L);
    const hist = Array.from({ length: nCh }, () => new Float32Array(TP_TAPS));
    let truePeak = 0;
    let samplePeak = 0;

    function push(channels) {
      const n = channels[0]?.length || 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < nCh; c++) {
          const x = channels[c][i];
          const s = st[c];
          const y1 = shelf[0] * x + shelf[1] * s[0] + shelf[2] * s[1] - shelf[3] * s[2] - shelf[4] * s[3];
          s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y1;
          const y2 = hp[0] * y1 + hp[1] * s[4] + hp[2] * s[5] - hp[3] * s[6] - hp[4] * s[7];
          s[5] = s[4]; s[4] = y1; s[7] = s[6]; s[6] = y2;
          acc[c] += y2 * y2;
          const ax = x < 0 ? -x : x;
          if (ax > samplePeak) samplePeak = ax;
          const h = hist[c];
          h.copyWithin(0, 1);
          h[TP_TAPS - 1] = x;
          if (L > 1) {
            for (let p = 0; p < L; p++) {
              const row = tp[p];
              let v = 0;
              for (let k = 0; k < TP_TAPS; k++) v += h[k] * row[k];
              if (v < 0) v = -v;
              if (v > truePeak) truePeak = v;
            }
          }
        }
        if (++accN === seg) {
          let p = 0;
          for (let c = 0; c < nCh; c++) p += weights[c] * (acc[c] / seg);
          segPower.push(p);
          acc = new Float64Array(nCh);
          accN = 0;
        }
      }
    }

    const lufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
    function result() {
      const blocks = [];
      for (let j = 0; j + 4 <= segPower.length; j++) blocks.push((segPower[j] + segPower[j + 1] + segPower[j + 2] + segPower[j + 3]) / 4);
      let momentaryMax = -Infinity;
      for (const b of blocks) momentaryMax = Math.max(momentaryMax, lufs(b));
      let shortTermMax = -Infinity;
      for (let j = 0; j + 30 <= segPower.length; j++) {
        let s = 0;
        for (let k = 0; k < 30; k++) s += segPower[j + k];
        shortTermMax = Math.max(shortTermMax, lufs(s / 30));
      }
      const abs = blocks.filter((b) => lufs(b) > -70);
      let integrated = -Infinity;
      if (abs.length) {
        const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
        const rel = lufs(mean) - 10;
        const gated = abs.filter((b) => lufs(b) > rel);
        if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
      }
      return { integrated, truePeak: gainToDb(Math.max(truePeak, samplePeak)), samplePeak: gainToDb(samplePeak), momentaryMax, shortTermMax };
    }
    return { push, result };
  }

  const channelsOf = (buffer) => {
    if (Array.isArray(buffer)) return buffer;
    const out = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  };

  // audioBuffer (an AudioBuffer, or {sampleRate, numberOfChannels, getChannelData}) -> the meter's result.
  function loudness(audioBuffer, rate = audioBuffer.sampleRate) {
    const chans = channelsOf(audioBuffer);
    const meter = createMeter(rate, chans.length);
    const STEP = 65536;
    const n = chans[0]?.length || 0;
    for (let i = 0; i < n; i += STEP) meter.push(chans.map((c) => c.subarray(i, Math.min(n, i + STEP))));
    return meter.result();
  }

  // The gain in dB that brings the highest peak to `target` dBFS ("normalize max peak to -1 dB"). `peaks` is a
  // peak value, a Float32Array (thumbs.peaks min/max pairs, or samples), a list of those, or an AudioBuffer.
  function normalizeGain(peaks, target = -1) {
    let max = 0;
    const scan = (a) => { for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > max) max = v; } };
    if (typeof peaks === 'number') max = Math.abs(peaks);
    else if (ArrayBuffer.isView(peaks)) scan(peaks);
    else if (Array.isArray(peaks)) for (const p of peaks) (typeof p === 'number' ? (max = Math.max(max, Math.abs(p))) : scan(p));
    else if (peaks && typeof peaks.getChannelData === 'function') for (const c of channelsOf(peaks)) scan(c);
    if (!(max > 0)) return 0;
    return target - gainToDb(max);
  }

  // The master gain that brings a measured mix to `target` LUFS without its true peak going above `ceiling` dBTP.
  function matchGain(measured, target, { ceiling = -1 } = {}) {
    if (!Number.isFinite(measured?.integrated)) return 0;
    let g = target - measured.integrated;
    if (Number.isFinite(measured.truePeak)) g = Math.min(g, ceiling - measured.truePeak);
    return Math.round(g * 100) / 100;
  }

  // ---- decoding (when the engine's Cut.decoder is not there) -------------------------------------------------------

  const micros = (t) => Math.round((t * 1e6) / TICKS);

  // A track of a probed source -> {rate, channels, data: [Float32Array]}: samples placed at their presentation time
  // (so encoder priming that an edit list moves before 0 is dropped).
  async function decodeTrack(reader, track) {
    const codecs = mod('codecs');
    const probe = mod('probe');
    const rate = track.sampleRate;
    const chans = track.channels;
    const s = track.samples;
    let total = 0;
    for (let i = 0; i < s.count; i++) total = Math.max(total, s.pts[i] + s.duration[i]);
    const length = Math.max(0, Math.ceil((total * rate) / TICKS));
    const data = Array.from({ length: chans }, () => new Float32Array(length));
    const put = (planes, at) => {
      for (let c = 0; c < chans; c++) {
        const src = planes[Math.min(c, planes.length - 1)];
        const from = Math.max(0, -at);
        const to = Math.min(src.length, length - at);
        if (to > from) data[c].set(src.subarray(from, to), at + from);
      }
    };
    const BATCH = 256;
    if (/^pcm-/.test(track.codec)) {
      for (let i = 0; i < s.count; i += BATCH) {
        const parts = await probe.readSamples(reader, track, i, Math.min(s.count, i + BATCH));
        parts.forEach((bytes, k) => put(codecs.pcmToFloat(bytes, track.codec, chans), Math.round((s.pts[i + k] * rate) / TICKS)));
      }
      return { rate, channels: chans, data };
    }
    let failure = null;
    const decoder = new AudioDecoder({
      output: (ad) => {
        try {
          const n = ad.numberOfFrames;
          const planes = [];
          for (let c = 0; c < ad.numberOfChannels; c++) {
            const p = new Float32Array(n);
            ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
            planes.push(p);
          }
          put(planes, Math.round((ad.timestamp * rate) / 1e6));
        } finally { ad.close(); }
      },
      error: (e) => { failure = e; },
    });
    decoder.configure({ codec: track.codec, sampleRate: rate, numberOfChannels: chans, ...(track.description ? { description: track.description } : {}) });
    for (let i = 0; i < s.count && !failure; i += BATCH) {
      const parts = await probe.readSamples(reader, track, i, Math.min(s.count, i + BATCH));
      parts.forEach((bytes, k) => {
        const j = i + k;
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: micros(s.pts[j]), duration: micros(s.duration[j]), data: bytes }));
      });
      while (decoder.decodeQueueSize > 64 && !failure) await new Promise((r) => setTimeout(r, 1));
    }
    if (!failure) await decoder.flush().catch((e) => { failure = failure || e; });
    if (decoder.state !== 'closed') decoder.close();
    if (failure) throw failure;
    return { rate, channels: chans, data };
  }

  // A reader over cut:read for a file path.
  async function fileReader(path) {
    const st = await globalThis.ide.api.invoke('cut:stat', path);
    if (!st || st.missing || st.error) throw new Error(st?.error || 'missing');
    return {
      size: st.size,
      async read(offset, length) {
        const r = await globalThis.ide.api.invoke('cut:read', path, offset, length);
        if (!(r instanceof Uint8Array)) throw new Error(r?.error || 'read failed');
        return r;
      },
    };
  }

  // media -> {rate, channels, data} of its first audio track, or null. The engine's decoder when it is loaded.
  async function defaultGetAudio(project, media) {
    const C = globalThis.Cut || {};
    if (C.media?.open && C.decoder?.decodeAudio) {
      const opened = await C.media.open(project, media.id);
      if (opened.error) throw Object.assign(new Error(opened.error.detail || opened.error.code), { code: opened.error.code });
      const track = opened.audio || opened.source?.tracks?.find((t) => t.kind === 'audio');
      if (!track) return null;
      return C.decoder.audioReader ? C.decoder.audioReader(opened, track) : C.decoder.decodeAudio(opened, track);
    }
    const reader = await fileReader(media.path);
    const source = await mod('probe').open(reader, { name: media.name });
    const track = source.tracks.find((t) => t.kind === 'audio');
    return track ? decodeTrack(reader, track) : null;
  }

  // ---- the mixer ---------------------------------------------------------------------------------------------------

  // The range a transition covers: [from, to) in sequence ticks.
  function transitionRange(tr) {
    if (tr.align === 'start') return [tr.at, tr.at + tr.duration];
    if (tr.align === 'end') return [tr.at - tr.duration, tr.at];
    const half = Math.round(tr.duration / 2);
    return [tr.at - half, tr.at - half + tr.duration];
  }

  // A clip's sound on the timeline: the range it is heard over (fade-in/out handles of transitions included) and the
  // gain shape of its transitions.
  function clipSpan(seq, clip, dur) {
    const end = clip.start + dur;
    let from = clip.start;
    let to = end;
    let fadeIn = null;
    let fadeOut = null;
    for (const tr of seq.transitions) {
      if (tr.track !== clip.track) continue;
      if (tr.at === clip.start) { const r = transitionRange(tr); from = Math.min(from, r[0]); fadeIn = r; }
      if (tr.at === end) { const r = transitionRange(tr); to = Math.max(to, r[1]); fadeOut = r; }
    }
    return { from, to, fadeIn, fadeOut };
  }

  // progress -> [outgoing gain, incoming gain] of the audio transition at an edit point: the registry's gains(), else
  // constant power.
  const POWER = (u) => [Math.cos((Math.PI / 2) * u), Math.sin((Math.PI / 2) * u)];
  function transitionGains(seq, track, at) {
    const tr = seq.transitions.find((x) => x.at === at && x.track === track);
    const def = tr ? mod('effects')?.get?.(tr.type) : null;
    return typeof def?.gains === 'function' ? (u) => def.gains(u, tr.params || {}) : POWER;
  }

  const KF_STEP = 32;

  // A source's sound at the mixer's rate is kept in blocks of BLOCK_SECONDS: one block of all of it when getAudio gives
  // the whole track ({rate, data}), else read on demand from the reader it gives ({rate, length, read(from, to)}), at
  // most MAX_BLOCKS kept and the least recently used dropped. A 42-minute file then starts after one block's decode
  // instead of decoding and resampling all of it first (11.6 s and about 2 GB).
  const BLOCK_SECONDS = 10;
  const MAX_BLOCKS = 48;
  const LOAD_SECONDS = 120; // the most of a range one load() reads ahead
  const LOOKAHEAD_SECONDS = 15;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const stereo = (data) => (data.length === 1 ? [data[0], data[0]] : [data[0], data[1]]);

  function createMixer({ rate = 48000, getAudio = defaultGetAudio } = {}) {
    const tps = TICKS / rate; // ticks a sample
    const sources = new Map(); // `${id}|${path}` -> {state: 'loading' | 'ready' | 'failed' | 'none', promise, pcm: store}
    const stretched = new Map(); // a clip's sound at its speed -> {data, origin}
    const keyOf = (m) => `${m.id}|${m.path}`;
    let useTick = 0;

    function loadMedia(project, media) {
      const key = keyOf(media);
      let s = sources.get(key);
      if (s) return s.promise;
      s = { state: 'loading', pcm: null, error: null };
      s.promise = (async () => {
        try {
          const a = await getAudio(project, media);
          if (a && typeof a.read === 'function') {
            if (!a.length) { s.state = 'none'; return; }
            s.pcm = { reader: a, length: Math.round((a.length * rate) / a.rate), size: rate * BLOCK_SECONDS, blocks: new Map(), loading: new Map() };
            s.state = 'ready';
            return;
          }
          if (!a || !a.data?.length) { s.state = 'none'; return; }
          let data = stereo(a.data);
          if (a.rate !== rate) data = resample(data, a.rate, rate);
          const length = data[0].length;
          s.pcm = { reader: null, length, size: Math.max(1, length), blocks: new Map([[0, { data, used: 0 }]]), loading: new Map() };
          s.state = 'ready';
        } catch (err) {
          s.state = 'failed';
          s.error = err;
        }
      })();
      sources.set(key, s);
      return s.promise;
    }

    // Block indexes [a, b) covering samples [k0, k1) of a store, inside its length.
    function blockRange(pcm, k0, k1) {
      const a = Math.max(0, Math.floor(Math.max(0, k0) / pcm.size));
      const b = Math.min(Math.ceil(pcm.length / pcm.size), Math.ceil(Math.min(pcm.length, k1) / pcm.size));
      return [a, b];
    }
    // Whether samples [k0, k1) are all in memory; marks their blocks used.
    function has(pcm, k0, k1) {
      const [a, b] = blockRange(pcm, k0, k1);
      useTick++;
      for (let i = a; i < b; i++) {
        const e = pcm.blocks.get(i);
        if (!e) return false;
        e.used = useTick;
      }
      return true;
    }
    function loadBlock(pcm, i, keep) {
      if (pcm.blocks.has(i)) return Promise.resolve();
      if (pcm.loading.has(i)) return pcm.loading.get(i);
      const p = (async () => {
        const r = pcm.reader;
        const o0 = i * pcm.size;
        const o1 = Math.min(pcm.length, o0 + pcm.size);
        let data;
        if (r.rate === rate) data = stereo(await r.read(o0, o1));
        else {
          // A window whose first sample falls on an output sample, with the resampling filter's reach on both sides,
          // so the blocks join without a seam.
          const g = gcd(r.rate, rate);
          const si = r.rate / g;
          const so = rate / g;
          const w0 = Math.max(0, Math.floor(((o0 * r.rate) / rate - RS_HALF - 2) / si)) * si;
          const w1 = Math.ceil((o1 * r.rate) / rate) + RS_HALF + 2;
          const res = resample(stereo(await r.read(w0, w1)), r.rate, rate);
          const off = o0 - (w0 / si) * so;
          data = res.map((c) => { const out = new Float32Array(o1 - o0); out.set(c.subarray(off, off + (o1 - o0))); return out; });
        }
        pcm.blocks.set(i, { data, used: ++useTick });
        while (pcm.blocks.size > MAX_BLOCKS) {
          let worst = -1;
          let oldest = Infinity;
          for (const [k, e] of pcm.blocks) if (!keep?.has(k) && e.used < oldest) { oldest = e.used; worst = k; }
          if (worst < 0) break;
          pcm.blocks.delete(worst);
        }
      })().finally(() => pcm.loading.delete(i));
      pcm.loading.set(i, p);
      return p;
    }
    // Loads samples [k0, k1) of a store (a whole store has them already).
    async function ensure(pcm, k0, k1) {
      if (!pcm.reader) return;
      const [a, b] = blockRange(pcm, k0, k1);
      const keep = new Set();
      for (let i = a; i < b; i++) keep.add(i);
      for (let i = a; i < b; i++) await loadBlock(pcm, i, keep);
    }
    // Samples [k0, k1) as one array per channel (a clip played at another speed or backwards is stretched from it).
    function copyRange(pcm, k0, k1) {
      const n = Math.max(0, k1 - k0);
      const out = [new Float32Array(n), new Float32Array(n)];
      const [a, b] = blockRange(pcm, k0, k1);
      for (let i = a; i < b; i++) {
        const e = pcm.blocks.get(i);
        if (!e) continue;
        const s0 = i * pcm.size;
        const from = Math.max(k0, s0);
        const to = Math.min(k1, s0 + e.data[0].length);
        if (to > from) for (let c = 0; c < 2; c++) out[c].set(e.data[c].subarray(from - s0, to - s0), from - k0);
      }
      return out;
    }
    // The source samples [k0, k1) a clip plays over the timeline range [t0, t1) (ticks); all of the clip when it plays
    // at another speed (it is stretched whole).
    function sourceSpan(x, span, t0, t1) {
      const { clip } = x;
      if (clip.speed !== 1) {
        const pre = clip.start - span.from;
        const post = span.to - (clip.start + x.dur);
        return [Math.max(0, Math.round((clip.in - pre * clip.speed) / tps)), Math.round((clip.out + post * clip.speed) / tps)];
      }
      const a = Math.max(t0, span.from) - clip.start;
      const b = Math.min(t1, span.to) - clip.start;
      return clip.reverse ? [Math.floor((clip.out - b) / tps) - 1, Math.ceil((clip.out - a) / tps) + 1]
        : [Math.floor((clip.in + a) / tps) - 1, Math.ceil((clip.in + b) / tps) + 1];
    }

    function audioClips(project, seq) {
      const model = mod('model');
      const kinds = new Map(seq.tracks.map((t) => [t.id, t.kind]));
      return seq.clips.filter((c) => c.enabled && kinds.get(c.track) === 'audio' && c.source && c.source.media != null)
        .map((c) => ({ clip: c, media: model.mediaOf(project, c), dur: model.clipDuration(c) }))
        .filter((x) => x.media);
    }

    // Decodes every source the clips heard in [from, to) need (all of the sequence when from/to are not given).
    // -> [{media, error}] of the ones that failed.
    async function load(project, seqId, from = -Infinity, to = Infinity) {
      const seq = project.sequences.find((s) => s.id === seqId);
      if (!seq) return [];
      const wanted = new Map();
      const ranges = [];
      for (const x of audioClips(project, seq)) {
        const span = clipSpan(seq, x.clip, x.dur);
        if (span.to > from && span.from < to) { wanted.set(keyOf(x.media), x.media); ranges.push({ x, span }); }
      }
      await Promise.all([...wanted.values()].map((m) => loadMedia(project, m)));
      // Read sources: the blocks of the range, at most LOAD_SECONDS of it from its start (all of a sped-up clip).
      await Promise.all(ranges.map(({ x, span }) => {
        const pcm = sources.get(keyOf(x.media))?.pcm;
        if (!pcm?.reader) return null;
        const t0 = Math.max(from, span.from);
        const t1 = Math.min(to, span.to, t0 + LOAD_SECONDS * TICKS);
        const [k0, k1] = sourceSpan(x, span, t0, t1);
        return ensure(pcm, k0, k1).catch((err) => { const s = sources.get(keyOf(x.media)); s.state = 'failed'; s.error = err; });
      }));
      return [...wanted.values()].filter((m) => sources.get(keyOf(m))?.state === 'failed').map((m) => ({ media: m.id, error: String(sources.get(keyOf(m)).error?.message || sources.get(keyOf(m)).error) }));
    }

    // The clip's sound at its speed, kept while the clip's source range, speed and handles stay the same.
    function stretchedOf(pcm, clip, span, dur, mediaKey) {
      const pre = clip.start - span.from;
      const post = span.to - (clip.start + dur);
      const keepPitch = clip.keepPitch !== false;
      const key = `${mediaKey}|${clip.in}|${clip.out}|${clip.speed}|${clip.reverse}|${pre}|${post}|${keepPitch}`;
      const hit = stretched.get(key);
      if (hit) { hit.used = performance.now?.() || Date.now(); return hit; }
      const srcFrom = Math.max(0, Math.round((clip.in - pre * clip.speed) / tps));
      const srcTo = Math.min(pcm.length, Math.round((clip.out + post * clip.speed) / tps));
      if (!has(pcm, srcFrom, srcTo)) return null;
      let seg = copyRange(pcm, srcFrom, Math.max(srcFrom, srcTo));
      if (clip.reverse) seg = seg.map((c) => c.reverse());
      const out = keepPitch ? stretch(seg, 1 / clip.speed, rate) : resample(seg, rate, rate / clip.speed);
      // origin: the timeline offset from clip.start of sample 0 of `out`, in ticks.
      const origin = clip.reverse ? -(srcTo * tps - clip.out) / clip.speed : -(clip.in - srcFrom * tps) / clip.speed;
      const entry = { data: out, origin, used: Date.now() };
      stretched.set(key, entry);
      if (stretched.size > 64) {
        const oldest = [...stretched.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, stretched.size - 64);
        for (const [k] of oldest) stretched.delete(k);
      }
      return entry;
    }

    // Adds one clip's sound for samples [s0, s0 + n) into the stereo bus.
    function renderClip(bus, project, seq, x, s0, n) {
      const keyframes = mod('keyframes');
      const { clip, media, dur } = x;
      const src = sources.get(keyOf(media));
      if (!src || src.state !== 'ready') return false;
      const pcm = src.pcm;
      const span = clipSpan(seq, clip, dur);
      const a = Math.max(s0, Math.ceil(span.from / tps));
      const b = Math.min(s0 + n, Math.ceil(span.to / tps));
      if (b <= a) return true;
      const plain = clip.speed === 1 && !clip.reverse;
      const revPlain = clip.speed === 1 && clip.reverse;
      // A block not read yet: asked for, and this clip is missing from this mix.
      const need = sourceSpan(x, span, a * tps, b * tps);
      if (pcm.reader && !has(pcm, need[0], need[1])) { ensure(pcm, need[0], need[1]).catch(() => {}); return false; }
      const st = plain || revPlain ? null : stretchedOf(pcm, clip, span, dur, keyOf(media));
      if (!plain && !revPlain && !st) return false;
      let bStart = 0;
      let bEnd = 0;
      let L = null;
      let R = null;
      const blockAt = (k) => {
        const i = Math.floor(k / pcm.size);
        const e = pcm.blocks.get(i);
        bStart = i * pcm.size;
        bEnd = bStart + pcm.size;
        L = e ? e.data[0] : null;
        R = e ? e.data[1] : null;
      };
      const inS = clip.in / tps;
      const outS = clip.out / tps;
      const startT = clip.start;
      const volList = clip.keyframes?.volume;
      const panList = clip.keyframes?.pan;
      const baseVol = clip.props?.volume ?? 0;
      const basePan = clip.props?.pan ?? 0;
      // Audio effects of the registry (effects.js): gain(params, seconds into the clip, clip seconds) -> linear gain.
      const registry = mod('effects');
      const fx = (clip.effects || []).map((e) => ({ e, def: e.on !== false ? registry?.get?.(e.type) : null }))
        .filter((x) => x.def && x.def.kind === 'audio' && typeof x.def.gain === 'function')
        .map(({ e, def }) => ({ def, id: e.id, params: registry.resolve ? registry.resolve(e.type, e.params || {}) : { ...e.params } }));
      const durS = dur / TICKS;
      const effectGain = (tau) => {
        let g = 1;
        for (const x of fx) {
          let p = x.params;
          for (const key of Object.keys(p)) {
            const list = clip.keyframes?.[`effects.${x.id}.${key}`];
            if (list?.length) { if (p === x.params) p = { ...p }; p[key] = keyframes.valueAt(list, tau, p[key]); }
          }
          g *= x.def.gain(p, tau / TICKS, durS);
        }
        return g;
      };
      const tin = span.fadeIn ? transitionGains(seq, clip.track, clip.start) : null;
      const tout = span.fadeOut ? transitionGains(seq, clip.track, clip.start + dur) : null;
      const gainsAt = (tau) => {
        let g = dbToGain(volList?.length ? keyframes.valueAt(volList, tau, baseVol) : baseVol);
        if (fx.length) g *= effectGain(tau);
        if (tau >= 0 && tau < dur) {
          if (clip.fadeIn > 0 && tau < clip.fadeIn) g *= tau / clip.fadeIn;
          if (clip.fadeOut > 0 && tau > dur - clip.fadeOut) g *= (dur - tau) / clip.fadeOut;
        }
        const t = startT + tau;
        if (span.fadeIn && t < span.fadeIn[1]) g *= tin(Math.max(0, (t - span.fadeIn[0]) / (span.fadeIn[1] - span.fadeIn[0])))[1];
        if (span.fadeOut && t >= span.fadeOut[0]) g *= tout(Math.min(1, (t - span.fadeOut[0]) / (span.fadeOut[1] - span.fadeOut[0])))[0];
        const p = Math.max(-1, Math.min(1, (panList?.length ? keyframes.valueAt(panList, tau, basePan) : basePan) / 100));
        return [g * (p > 0 ? 1 - p : 1), g * (p < 0 ? 1 + p : 1)];
      };
      // Gains are computed every KF_STEP samples and interpolated linearly between.
      const startS = startT / tps;
      for (let seg = a; seg < b; seg += KF_STEP) {
        const segEnd = Math.min(b, seg + KF_STEP);
        const [gl0, gr0] = gainsAt(seg * tps - startT);
        const [gl1, gr1] = gainsAt(segEnd * tps - startT);
        const len = segEnd - seg;
        for (let i = seg; i < segEnd; i++) {
          const f = (i - seg) / len;
          const along = i - startS; // samples from the clip start
          let k;
          let l;
          let r;
          if (plain || revPlain) {
            k = plain ? Math.round(inS + along) : Math.round(outS - along) - 1;
            if (k < 0 || k >= pcm.length) continue;
            if (k < bStart || k >= bEnd) blockAt(k);
            if (!L) continue;
            l = L[k - bStart]; r = R[k - bStart];
          } else {
            k = Math.round(along - st.origin / tps);
            if (k < 0 || k >= st.data[0].length) continue;
            l = st.data[0][k]; r = st.data[1][k];
          }
          bus[0][i - s0] += l * (gl0 + (gl1 - gl0) * f);
          bus[1][i - s0] += r * (gr0 + (gr1 - gr0) * f);
        }
      }
      return true;
    }

    // The mix of samples [s0, s0 + n) at the mixer's rate -> {out: [L, R], tracks: {id: [peakL, peakR]},
    // master: [peakL, peakR], missing} (peaks linear, after the faders; missing: sources not decoded yet).
    function mix(project, seqId, s0, n, { masterGain = 0 } = {}) {
      const out = [new Float32Array(n), new Float32Array(n)];
      const tracks = {};
      let missing = 0;
      const seq = project?.sequences.find((s) => s.id === seqId);
      if (!seq) return { out, tracks, master: [0, 0], missing };
      const t0 = s0 * tps;
      const t1 = (s0 + n) * tps;
      const audio = seq.tracks.filter((t) => t.kind === 'audio');
      const anySolo = audio.some((t) => t.solo);
      const clips = audioClips(project, seq);
      const bus = [new Float32Array(n), new Float32Array(n)];
      for (const track of audio) {
        bus[0].fill(0);
        bus[1].fill(0);
        let any = false;
        for (const x of clips) {
          if (x.clip.track !== track.id) continue;
          const span = clipSpan(seq, x.clip, x.dur);
          if (span.to <= t0 || span.from >= t1) continue;
          any = true;
          if (!renderClip(bus, project, seq, x, s0, n)) missing++;
        }
        const audible = !track.mute && (!anySolo || track.solo);
        if (!any || !audible) { tracks[track.id] = [0, 0]; continue; }
        const g = dbToGain(track.volume ?? 0);
        const p = Math.max(-1, Math.min(1, (track.pan ?? 0) / 100));
        const gl = g * (p > 0 ? 1 - p : 1);
        const gr = g * (p < 0 ? 1 + p : 1);
        let pl = 0;
        let pr = 0;
        for (let i = 0; i < n; i++) {
          const l = bus[0][i] * gl;
          const r = bus[1][i] * gr;
          out[0][i] += l;
          out[1][i] += r;
          if (Math.abs(l) > pl) pl = Math.abs(l);
          if (Math.abs(r) > pr) pr = Math.abs(r);
        }
        tracks[track.id] = [pl, pr];
      }
      const mg = dbToGain(masterGain + (seq.masterGain ?? 0));
      let ml = 0;
      let mr = 0;
      for (let i = 0; i < n; i++) {
        out[0][i] *= mg;
        out[1][i] *= mg;
        if (Math.abs(out[0][i]) > ml) ml = Math.abs(out[0][i]);
        if (Math.abs(out[1][i]) > mr) mr = Math.abs(out[1][i]);
      }
      return { out, tracks, master: [ml, mr], missing };
    }

    // mix() once the blocks of those samples, and LOOKAHEAD_SECONDS after them, are read: for loops through a range.
    async function mixLoaded(project, seqId, s0, n, opts) {
      await load(project, seqId, s0 * tps, (s0 + n) * tps + LOOKAHEAD_SECONDS * TICKS);
      return mix(project, seqId, s0, n, opts);
    }

    return { rate, load, mix, mixLoaded, sources, forget: () => { sources.clear(); stretched.clear(); } };
  }

  function makeBuffer(channels, rate) {
    const length = channels[0].length;
    if (typeof AudioBuffer === 'function') {
      const buf = new AudioBuffer({ length: Math.max(1, length), numberOfChannels: channels.length, sampleRate: rate });
      channels.forEach((c, i) => buf.copyToChannel(c, i));
      return buf;
    }
    return { sampleRate: rate, length, numberOfChannels: channels.length, duration: length / rate, getChannelData: (i) => channels[i] };
  }

  // The mix of [from, to) (sequence ticks) -> AudioBuffer (stereo at `rate`). opts: {masterGain, getAudio, mixer}.
  async function renderOffline(project, seqId, from, to, rate = 48000, opts = {}) {
    const mixer = opts.mixer || createMixer({ rate, getAudio: opts.getAudio || defaultGetAudio });
    const tps = TICKS / mixer.rate;
    const s0 = Math.round(from / tps);
    const total = Math.max(0, Math.round(to / tps) - s0);
    const out = [new Float32Array(total), new Float32Array(total)];
    const STEP = 48000;
    for (let i = 0; i < total; i += STEP) {
      const n = Math.min(STEP, total - i);
      const m = await mixer.mixLoaded(project, seqId, s0 + i, n, { masterGain: opts.masterGain || 0 });
      out[0].set(m.out[0], i);
      out[1].set(m.out[1], i);
    }
    return makeBuffer(out, mixer.rate);
  }

  // Loudness of the mix of [from, to) without holding all of it: -> the meter's result.
  async function measure(project, seqId, from, to, { rate = 48000, masterGain = 0, getAudio, onProgress, signal } = {}) {
    const mixer = createMixer({ rate, getAudio: getAudio || defaultGetAudio });
    const tps = TICKS / rate;
    const s0 = Math.round(from / tps);
    const total = Math.max(0, Math.round(to / tps) - s0);
    const meter = createMeter(rate, 2);
    const STEP = rate;
    for (let i = 0; i < total; i += STEP) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      meter.push((await mixer.mixLoaded(project, seqId, s0 + i, Math.min(STEP, total - i), { masterGain })).out);
      onProgress?.(Math.min(1, (i + STEP) / total));
      if ((i / STEP) % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
    return meter.result();
  }

  // ---- preview -----------------------------------------------------------------------------------------------------

  const BLOCK = 2048;
  const AHEAD = 0.3; // seconds of sound scheduled ahead of the output
  const LEAD = 0.06; // seconds between start() and the first sample

  // The preview of app's active sequence: start(t, rate) plays from t (rate 0.25..4 forward plays the mix faster or
  // slower like tape; other rates are silent but the clock runs), now() is the sequence time being heard,
  // meters() the peaks being heard in dBFS: {master, masterChannels: [l, r], tracks: {id: dB}}.
  function create(app, opts = {}) {
    const rate = opts.rate || 48000;
    const tps = TICKS / rate;
    const mixer = createMixer({ rate, getAudio: opts.getAudio || defaultGetAudio });
    let ctx = null;
    let master = null;
    let masterDb = 0;
    let playing = false;
    let t0 = 0; // sequence ticks at ctxT0
    let ctxT0 = 0;
    let playRate = 1;
    let nextSample = 0; // the next timeline sample to schedule
    let scheduledUntil = 0; // context time
    let timer = null;
    let lastNow = 0;
    let gen = 0;
    let aheadFrom = -Infinity; // where the preview last asked the mixer to read ahead from
    const live = new Set();
    let heard = [];

    function ensure() {
      if (ctx) return;
      ctx = new AudioContext({ sampleRate: rate, latencyHint: 'playback' });
      master = ctx.createGain();
      master.gain.value = dbToGain(masterDb);
      master.connect(ctx.destination);
    }

    function outputTime() {
      const ts = ctx.getOutputTimestamp?.();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    }

    function pump() {
      if (!playing || !ctx) return;
      const project = app.project;
      const seqId = app.sequenceId;
      const audible = playRate >= 0.25 && playRate <= 4;
      while (scheduledUntil < ctx.currentTime + AHEAD) {
        const span = audible ? Math.round(BLOCK * playRate) : BLOCK;
        const seconds = BLOCK / rate;
        if (audible && project && seqId) {
          const m = mixer.mix(project, seqId, nextSample, span);
          const buf = ctx.createBuffer(2, span, rate);
          buf.copyToChannel(m.out[0], 0);
          buf.copyToChannel(m.out[1], 1);
          const node = ctx.createBufferSource();
          node.buffer = buf;
          node.playbackRate.value = playRate;
          node.connect(master);
          node.onended = () => live.delete(node);
          node.start(Math.max(scheduledUntil, ctx.currentTime));
          live.add(node);
          const g = dbToGain(masterDb);
          heard.push({ from: scheduledUntil, to: scheduledUntil + seconds, master: [m.master[0] * g, m.master[1] * g], tracks: m.tracks });
          if (m.missing) mixer.load(project, seqId, nextSample * tps, (nextSample + span) * tps + 5 * TICKS);
        }
        nextSample += audible ? span : Math.round(BLOCK * playRate);
        scheduledUntil += seconds;
      }
      if (project && seqId && nextSample * tps - aheadFrom > TICKS) {
        aheadFrom = nextSample * tps;
        mixer.load(project, seqId, aheadFrom, aheadFrom + LOOKAHEAD_SECONDS * TICKS * Math.max(1, playRate));
      }
      const now = outputTime();
      while (heard.length > 1 && heard[0].to < now) heard.shift();
    }

    async function start(t, r = 1) {
      stop();
      ensure();
      const my = ++gen;
      playRate = r;
      // Until the sound starts, now() is where it will start: it said the last stop (0 the first time), and the
      // playhead jumped there and back on every play.
      lastNow = Math.max(0, Math.round(t));
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((res) => setTimeout(res, 1000))]);
      const project = app.project;
      const seqId = app.sequenceId;
      // Wait for the first seconds' sources, but not long: the picture is waiting for the clock.
      if (project && seqId) await Promise.race([mixer.load(project, seqId, t - TICKS, t + 3 * TICKS), new Promise((res) => setTimeout(res, 1500))]);
      if (my !== gen) return;
      playing = true;
      t0 = Math.max(0, Math.round(t));
      lastNow = t0;
      ctxT0 = ctx.currentTime + LEAD;
      scheduledUntil = ctxT0;
      nextSample = Math.round(t0 / tps);
      heard = [];
      aheadFrom = -Infinity;
      pump();
      timer = setInterval(pump, 40);
    }

    function now() {
      if (!playing || !ctx) return lastNow;
      const out = outputTime();
      const v = t0 + Math.max(0, out - ctxT0) * playRate * TICKS;
      lastNow = playRate >= 0 ? Math.max(lastNow, v) : Math.min(lastNow, Math.max(0, v));
      return Math.max(0, Math.round(lastNow));
    }

    function stop() {
      gen++;
      if (playing) lastNow = now();
      playing = false;
      clearInterval(timer);
      timer = null;
      for (const node of live) { try { node.stop(); } catch {} }
      live.clear();
      heard = [];
    }

    function meters() {
      const quiet = { master: -Infinity, masterChannels: [-Infinity, -Infinity], tracks: {} };
      if (!playing || !ctx) return quiet;
      const out = outputTime();
      const h = heard.find((x) => x.from <= out && out < x.to) || null;
      if (!h) return quiet;
      const tracks = {};
      for (const [id, [l, r]] of Object.entries(h.tracks)) tracks[id] = gainToDb(Math.max(l, r));
      return { master: gainToDb(Math.max(h.master[0], h.master[1])), masterChannels: h.master.map(gainToDb), tracks };
    }

    function setMasterGain(db) {
      masterDb = Number(db) || 0;
      if (master) master.gain.setTargetAtTime(dbToGain(masterDb), ctx.currentTime, 0.01);
    }

    const offProject = app?.on?.('project', ({ reason } = {}) => { if (reason === 'open') mixer.forget(); });

    async function close() {
      stop();
      offProject?.();
      mixer.forget();
      if (ctx) await ctx.close().catch(() => {});
      ctx = null;
    }

    return {
      start, stop, now, meters, setMasterGain, close,
      get playing() { return playing; },
      get rate() { return playRate; },
      get masterGain() { return masterDb; },
      get context() { return ctx; },
      mixer,
    };
  }

  return {
    create, renderOffline, measure, loudness, createMeter, normalizeGain, matchGain, createMixer, transitionRange,
    resample, stretch, kFilters, dbToGain, gainToDb, decodeTrack, fileReader, defaultGetAudio, makeBuffer,
  };
});
