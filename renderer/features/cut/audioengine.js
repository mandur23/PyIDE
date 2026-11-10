// The sound of Nano Studio Cut (docs/cut-architecture.md §9, features §12): one mixer computes the sequence's audio
// sample by sample (every audio clip with its volume and volume keyframes, pan, fade handles, audio crossfades, track
// volume, pan, mute and solo, speed changes with the pitch kept by a WSOLA time stretch, reverse, and the clip's audio
// effects: gains, and processors (EQ, dynamics, hum removal: audiofx.js) run as a chain), and both the preview
// and the export use it, so what is heard is what is exported. The preview plays the mix through Web Audio in short
// blocks scheduled on the AudioContext clock, which is the sequence clock the player follows (now()). Also: BS.1770-4
// loudness (K-weighting, gating) and true peak, the gain that normalizes a peak to -1 dB, and a resampler.
//
// Pan is a balance law for every source (center: both channels at full level; a mono source is copied to both). Fade
// handles are linear in amplitude; audio transitions are constant power (sin/cos) over the transition's range, using
// source audio past the clip's ends where there is some.
//
// A nest clip on an audio track (model.js: source.sequence) plays the mix of its sequence (its tracks, their volume,
// pan, mute and solo, its master gain) as a source: a store read in blocks like a file's, each block that sequence's
// mix() over those samples. So the nest clip's speed, reverse, effects, volume, pan and fades apply to it as to a file.
// The store's key carries a fingerprint of what the nested sequences hold, so an edit inside them is heard at once.
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

  // Output samples [o0, o1) of resample() of an input of n samples, from `channels` holding its samples [x0, ...).
  function resamplePart(channels, x0, n, from, to, o0, o1) {
    const ratio = from / to;
    const table = rsTable(Math.min(1, to / from) * 0.96);
    const taps = 2 * RS_HALF;
    return channels.map((x) => {
      const y = new Float32Array(Math.max(0, o1 - o0));
      for (let j = o0; j < o1; j++) {
        const pos = j * ratio;
        const i0 = Math.floor(pos);
        const p = Math.round((pos - i0) * RS_PHASES) * taps;
        const base = i0 - (RS_HALF - 1);
        let acc = 0;
        for (let k = 0; k < taps; k++) {
          const i = base + k;
          if (i >= 0 && i < n && i - x0 >= 0 && i - x0 < x.length) acc += x[i - x0] * table[p + k];
        }
        y[j - o0] = acc;
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
    if (Math.abs(factor - 1) < 1e-9) return channels.map((c) => c.slice());
    return stretchPart(channels, 0, inLen, factor, rate, 0, Math.round(inLen * factor), Infinity);
  }
  const stretchHop = (rate) => Math.max(64, Math.round(rate * 0.02));
  // The input samples, [x0, x1) of inLen, that stretchPart reads for output [o0, o1): the frames' nominal places with
  // their search tolerance, the frame length and the correlation's reach.
  function stretchWindow(inLen, factor, rate, o0, o1) {
    const hop = stretchHop(rate);
    const reach = 4 * hop + Math.round(rate * 0.01) + 16;
    return [Math.floor(((o0 - hop) / factor - reach) / 4) * 4, Math.ceil(o1 / factor) + reach];
  }
  // Output samples [o0, o1) of stretching an input of inLen samples, from `channels` holding its samples [x0, ...) (x0
  // a multiple of 4; outside them it is silence). The frames' path starts afresh every `seg` output samples (a
  // multiple of the hop): that frame sits at its nominal place, so each segment can be made on its own, from a window
  // of the input, and the segments join (a long sped-up source is never all in memory).
  function stretchPart(channels, x0, inLen, factor, rate, o0, o1, seg) {
    const hop = stretchHop(rate);
    const N = 2 * hop;
    const tol = Math.round(rate * 0.01);
    const D = 4;
    const L = hop;
    const nCh = channels.length;
    const wLen = channels[0]?.length || 0;
    const mono = new Float32Array(wLen);
    for (const c of channels) for (let i = 0; i < wLen; i++) mono[i] += c[i] / nCh;
    const dLen = Math.floor(inLen / D);
    const d0 = x0 / D;
    const dec = new Float32Array(Math.floor(wLen / D));
    for (let i = 0; i < dec.length; i++) { let s = 0; for (let k = 0; k < D; k++) s += mono[i * D + k]; dec[i] = s / D; }
    const win = new Float32Array(N);
    for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
    const out = channels.map(() => new Float32Array(Math.max(0, o1 - o0)));
    // arr holds samples [off, ...) of a signal of `len`.
    const at = (arr, off, len, i) => (i >= 0 && i < len && i - off >= 0 && i - off < arr.length ? arr[i - off] : 0);

    function corr(arr, off, len, a, b, n, step) {
      let num = 0;
      let eb = 0;
      for (let i = 0; i < n; i += step) {
        const y = at(arr, off, len, b + i);
        num += at(arr, off, len, a + i) * y;
        eb += y * y;
      }
      return eb > 1e-12 ? num / Math.sqrt(eb) : 0;
    }

    let prev = null;
    for (let k = Math.floor(o0 / hop) - 1; k * hop < o1; k++) {
      const outPos = k * hop;
      // A fresh frame is placed so that the output from its middle on reads the input from the nominal place: one at
      // round(outPos / factor) read only silence before a clip's first sample when sped up, and the search that
      // followed matched that silence, so every sped-up clip began with 10 ms of nothing and a 10 ms fade.
      if ((outPos + hop) % seg === 0) prev = null;
      const nominal = Math.round(outPos / factor);
      let best = prev === null ? Math.round((outPos + hop) / factor) - hop : nominal;
      if (prev !== null) {
        const target = prev + hop;
        let bestScore = -Infinity;
        const dt = Math.round(target / D);
        const dn = Math.round(nominal / D);
        const dTol = Math.ceil(tol / D);
        const dL = Math.floor(L / D);
        let coarse = dn;
        for (let d = -dTol; d <= dTol; d++) {
          const s = corr(dec, d0, dLen, dt, dn + d, dL, 1);
          if (s > bestScore) { bestScore = s; coarse = dn + d; }
        }
        bestScore = -Infinity;
        for (let d = -D; d <= D; d++) {
          const cand = coarse * D + d;
          if (Math.abs(cand - nominal) > tol + D) continue;
          const s = corr(mono, x0, inLen, target, cand, L, 2);
          if (s > bestScore) { bestScore = s; best = cand; }
        }
      }
      for (let c = 0; c < nCh; c++) {
        const x = channels[c];
        const y = out[c];
        for (let n = 0; n < N; n++) {
          const o = outPos + n;
          if (o < o0 || o >= o1) continue;
          const i = best + n;
          if (i >= 0 && i < inLen && i - x0 >= 0 && i - x0 < wLen) y[o - o0] += x[i - x0] * win[n];
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
  // instead of decoding and resampling all of it first (11.6 s and about 2 GB). The blocks a load in progress reads
  // are pinned: clips of one mix that read far apart parts of a source evicted each other's blocks, so one of them
  // was silent every other second.
  const BLOCK_SECONDS = 10;
  const MAX_BLOCKS = 48;
  const LOAD_SECONDS = 120; // the most of a range one load() reads ahead (of the source, for a sped-up clip)
  const LOOKAHEAD_SECONDS = 15;
  // A clip at another speed is stretched in segments of at most BLOCK_SECONDS of its output, each from at most about
  // SPEED_INPUT_SECONDS of its source, SPEED_KEEP of them kept (LRU): stretching all of it at once held the whole
  // source range and a copy of it (a 2-hour source at 8x: 7.7 GB in Node).
  const SPEED_INPUT_SECONDS = 40;
  const SPEED_KEEP = 32;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const stereo = (data) => (data.length === 1 ? [data[0], data[0]] : [data[0], data[1]]);

  function createMixer({ rate = 48000, getAudio = defaultGetAudio } = {}) {
    const tps = TICKS / rate; // ticks a sample
    const sources = new Map(); // `${id}|${path}` -> {state: 'loading' | 'ready' | 'failed' | 'none', promise, pcm: store}
    const speedSegs = new Map(); // `${speedOf(...).key}|${j}` -> {data: [L, R], used}: segment j of a clip's sound at its speed
    const keyOf = (m) => `${m.id}|${m.path}`;
    let useTick = 0;

    // A nest clip's source: a stand-in media entry whose id names the sequence and what it and the sequences under it
    // hold (their JSON and their media's, hashed). The stores of earlier contents of that sequence are dropped.
    // The stand-in is the same while the project's revision is (model.revisionOf): mix() asks for it every block, and
    // hashing an 800-clip nest took 2.4 ms a call. A project with no revision is hashed every time.
    const nestIds = new WeakMap(); // project -> { rev, ids: Map(seqId -> media) }
    function nestMedia(project, seqId) {
      const model = mod('model');
      const rev = model.revisionOf(project);
      let memo = rev === null ? null : nestIds.get(project);
      if (memo && memo.rev !== rev) memo = null;
      if (rev !== null && !memo) nestIds.set(project, (memo = { rev, ids: new Map() }));
      const known = memo?.ids.get(seqId);
      if (known) return known;
      const seqs = [];
      const seen = new Set();
      const walk = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        const seq = project.sequences.find((x) => x.id === id);
        if (!seq) return;
        seqs.push(seq);
        for (const next of model.nestedIds(seq)) walk(next);
      };
      walk(seqId);
      const used = new Set(seqs.flatMap((q) => q.clips.map((c) => c.source?.media).filter((m) => m != null)));
      const text = JSON.stringify([seqs, project.media.filter((m) => used.has(m.id))]);
      let h1 = 0x811c9dc5;
      let h2 = 0x01000193;
      for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
      }
      const id = `nest:${seqId}:${h1.toString(16)}${h2.toString(16)}`;
      const prefix = `nest:${seqId}:`;
      for (const k of sources.keys()) if (k.startsWith(prefix) && k !== `${id}|`) sources.delete(k);
      const media = { id, path: '', nest: seqId, project };
      memo?.ids.set(seqId, media);
      return media;
    }
    // The reader of a nest's store: samples [from, to) of its sequence's mix at the mixer's rate.
    function nestReader(project, seqId) {
      const seq = project.sequences.find((x) => x.id === seqId);
      if (!seq) return null;
      return {
        rate,
        length: Math.ceil(mod('model').sequenceDuration(seq) / tps),
        async read(from, to) {
          await load(project, seqId, from * tps, to * tps);
          return mix(project, seqId, from, Math.max(0, to - from)).out;
        },
      };
    }

    function loadMedia(project, media) {
      const key = keyOf(media);
      let s = sources.get(key);
      if (s) return s.promise;
      s = { state: 'loading', pcm: null, error: null, media };
      s.promise = (async () => {
        try {
          const a = media.nest ? nestReader(media.project, media.nest) : await getAudio(project, media);
          if (a && typeof a.read === 'function') {
            if (!a.length) { s.state = 'none'; return; }
            s.pcm = { reader: a, length: Math.round((a.length * rate) / a.rate), size: rate * BLOCK_SECONDS, blocks: new Map(), loading: new Map(), pins: new Map() };
            s.state = 'ready';
            return;
          }
          if (!a || !a.data?.length) { s.state = 'none'; return; }
          let data = stereo(a.data);
          if (a.rate !== rate) data = resample(data, a.rate, rate);
          const length = data[0].length;
          s.pcm = { reader: null, length, size: Math.max(1, length), blocks: new Map([[0, { data, used: 0 }]]), loading: new Map(), pins: new Map() };
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
    // Counts a reader of blocks [a, b) in (by +1) or out (-1); a block with a reader is not evicted.
    function pin(pcm, [a, b], by) {
      for (let i = a; i < b; i++) {
        const n = (pcm.pins.get(i) || 0) + by;
        if (n > 0) pcm.pins.set(i, n);
        else pcm.pins.delete(i);
      }
    }
    function loadBlock(pcm, i) {
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
          for (const [k, e] of pcm.blocks) if (!pcm.pins.has(k) && e.used < oldest) { oldest = e.used; worst = k; }
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
      const range = blockRange(pcm, k0, k1);
      pin(pcm, range, 1);
      try {
        for (let i = range[0]; i < range[1]; i++) await loadBlock(pcm, i);
      } finally { pin(pcm, range, -1); }
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
    // The source samples [k0, k1) a clip at speed 1 plays over the timeline range [t0, t1) (ticks).
    function sourceSpan(x, span, t0, t1) {
      const { clip } = x;
      const a = Math.max(t0, span.from) - clip.start;
      const b = Math.min(t1, span.to) - clip.start;
      return clip.reverse ? [Math.floor((clip.out - b) / tps) - 1, Math.ceil((clip.out - a) / tps) + 1]
        : [Math.floor((clip.in + a) / tps) - 1, Math.ceil((clip.in + b) / tps) + 1];
    }

    function audioClips(project, seq) {
      const model = mod('model');
      const kinds = new Map(seq.tracks.map((t) => [t.id, t.kind]));
      const nests = new Map();
      const nestOf = (id) => { if (!nests.has(id)) nests.set(id, project.sequences.some((q) => q.id === id) ? nestMedia(project, id) : null); return nests.get(id); };
      return seq.clips.filter((c) => c.enabled && kinds.get(c.track) === 'audio' && c.source && (c.source.media != null || model.isNest(c)))
        .map((c) => ({ clip: c, media: model.isNest(c) ? nestOf(c.source.sequence) : model.mediaOf(project, c), dur: model.clipDuration(c) }))
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
      // Read sources: the blocks of the range, at most LOAD_SECONDS of the source from its start; for a clip at another
      // speed, those its stretched segments there are made from.
      const reads = [];
      for (const { x, span } of ranges) {
        const pcm = sources.get(keyOf(x.media))?.pcm;
        if (!pcm?.reader) continue;
        const t0 = Math.max(from, span.from);
        const chain = chainOf(x, span);
        if (x.clip.speed !== 1) {
          const t1 = Math.min(to, span.to, t0 + (LOAD_SECONDS * TICKS) / Math.max(1, x.clip.speed));
          for (const r of speedReads(speedOf(pcm, x, span), chain, Math.ceil(t0 / tps), Math.ceil(t1 / tps))) reads.push({ x, pcm, r });
          continue;
        }
        const t1 = Math.min(to, span.to, t0 + LOAD_SECONDS * TICKS);
        let [k0, k1] = sourceSpan(x, span, t0, t1);
        // A clip with an effect chain also reads its segments' warm-up before and cross-fade tail after.
        if (chain) {
          const reach = 2 * FX_SEGMENT + chain.warm + FX_XFADE + chain.latency;
          k0 -= reach;
          k1 += reach;
        }
        reads.push({ x, pcm, r: [k0, k1] });
      }
      // All of this load's blocks stay until it is done: read one after another, a clip's blocks pushed out those
      // another clip had read a moment before, and the mix after the load missed it.
      for (const { pcm, r } of reads) pin(pcm, blockRange(pcm, r[0], r[1]), 1);
      try {
        await Promise.all(reads.map(({ x, pcm, r }) => ensure(pcm, r[0], r[1]).catch((err) => { const s = sources.get(keyOf(x.media)); s.state = 'failed'; s.error = err; })));
      } finally {
        for (const { pcm, r } of reads) pin(pcm, blockRange(pcm, r[0], r[1]), -1);
      }
      return [...wanted.values()].filter((m) => sources.get(keyOf(m))?.state === 'failed').map((m) => ({ media: m.id, error: String(sources.get(keyOf(m)).error?.message || sources.get(keyOf(m)).error) }));
    }

    // A clip at another speed: its source range [srcFrom, srcTo) (reversed when it plays backwards), stretched (or, with
    // the pitch not kept, resampled) as one stream of outLen samples whose sample 0 is `origin` ticks from clip.start
    // (sequence sample i reads stream sample i - shift), made in segments of `seg` samples (speedSegment).
    function speedOf(pcm, x, span) {
      const { clip, dur } = x;
      const pre = clip.start - span.from;
      const post = span.to - (clip.start + dur);
      const keepPitch = clip.keepPitch !== false;
      const srcFrom = Math.max(0, Math.round((clip.in - pre * clip.speed) / tps));
      const srcTo = Math.max(srcFrom, Math.min(pcm.length, Math.round((clip.out + post * clip.speed) / tps)));
      const factor = 1 / clip.speed;
      const hop = stretchHop(rate);
      const origin = clip.reverse ? -(srcTo * tps - clip.out) / clip.speed : -(clip.in - srcFrom * tps) / clip.speed;
      return {
        srcFrom, srcTo, inLen: srcTo - srcFrom, outLen: Math.round((srcTo - srcFrom) * factor), factor, keepPitch, reverse: !!clip.reverse,
        seg: hop * Math.max(1, Math.round((Math.min(BLOCK_SECONDS, SPEED_INPUT_SECONDS * factor) * rate) / hop)),
        origin, shift: (clip.start + origin) / tps, to: rate / clip.speed,
        key: `${keyOf(x.media)}|${clip.in}|${clip.out}|${clip.speed}|${clip.reverse}|${pre}|${post}|${keepPitch}`,
      };
    }
    // Segment j's output [o0, o1), the input [x0, x1) it reads, the part [c0, c1) of that inside the source range, and
    // the source samples that part is.
    function speedWindow(g, j) {
      const o0 = j * g.seg;
      const o1 = Math.min(g.outLen, o0 + g.seg);
      const [x0, x1] = g.keepPitch ? stretchWindow(g.inLen, g.factor, rate, o0, o1)
        : [Math.floor(o0 / g.factor) - RS_HALF - 2, Math.ceil(o1 / g.factor) + RS_HALF + 2];
      const c0 = Math.max(0, Math.min(g.inLen, x0));
      const c1 = Math.max(c0, Math.min(g.inLen, x1));
      return { o0, o1, x0, x1, c0, c1, src: g.reverse ? [g.srcTo - c1, g.srcTo - c0] : [g.srcFrom + c0, g.srcFrom + c1] };
    }
    // Segment j of the stream, or null while a block of the source it reads is not in memory.
    function speedSegment(pcm, g, j) {
      const k = `${g.key}|${j}`;
      const hit = speedSegs.get(k);
      if (hit) { hit.used = ++useTick; return hit; }
      const w = speedWindow(g, j);
      if (!has(pcm, w.src[0], w.src[1])) return null;
      const input = copyRange(pcm, w.src[0], w.src[1]).map((c) => {
        const x = new Float32Array(w.x1 - w.x0);
        x.set(g.reverse ? c.reverse() : c, w.c0 - w.x0);
        return x;
      });
      const data = g.keepPitch ? stretchPart(input, w.x0, g.inLen, g.factor, rate, w.o0, w.o1, g.seg)
        : resamplePart(input, w.x0, g.inLen, rate, g.to, w.o0, w.o1);
      const entry = { data, used: ++useTick };
      speedSegs.set(k, entry);
      while (speedSegs.size > SPEED_KEEP) {
        let worst = null;
        let oldest = Infinity;
        for (const [key, e] of speedSegs) if (e.used < oldest) { oldest = e.used; worst = key; }
        speedSegs.delete(worst);
      }
      return entry;
    }
    // The source ranges to read before sequence samples [a, b) of a clip at another speed can be mixed: those of the
    // segments they hear (with a chain, over its runs' warm-up and tail too) that are not made yet.
    function speedReads(g, chain, a, b) {
      if (chain) [a, b] = chainSpan(chain, a, b);
      const k0 = Math.max(0, Math.round(a - g.shift));
      const k1 = Math.min(g.outLen - 1, Math.round(b - 1 - g.shift));
      const out = [];
      for (let j = Math.floor(k0 / g.seg); k1 >= k0 && j <= Math.floor(k1 / g.seg); j++) if (!speedSegs.has(`${g.key}|${j}`)) out.push(speedWindow(g, j).src);
      return out;
    }

    // ---- clip effects that process the sound (audiofx.js) ----
    // A clip with a processor among its effects runs them all, in order, as one chain over its source sound, before
    // its volume, fades and pan. So that the sound does not depend on how the mix is cut into blocks (the preview's
    // 2048 samples, the export's second, a seek), the chain runs in fixed segments of FX_SEGMENT samples counted from
    // the clip's first audible sample: each from a warm-up before it (or the clip's start) with fresh state, the
    // warm-up long enough for the state to forget its start (the processors' memory(), at most audiofx.MAX_MEMORY),
    // and on FX_XFADE samples past its end, which cross-fade into the next segment's start. Segments are kept (LRU).
    const FX_SEGMENT = 32768;
    const FX_XFADE = 512;
    const FX_KEEP = 96;
    const fxSegments = new Map(); // `${chain.key}|${j}` -> {body: [L, R], tail: [L, R], used}

    // The clip's chain, or null when none of its effects processes the sound (the gains then stay in gainsAt).
    function chainOf(x, span) {
      const registry = mod('effects');
      const fxm = mod('audiofx');
      if (!registry?.get || !fxm) return null;
      const clip = x.clip;
      const list = (clip.effects || []).filter((e) => e.on !== false).map((e) => ({ e, def: registry.get(e.type) }))
        .filter(({ def }) => def && def.kind === 'audio' && (def.dsp ? !!fxm.processors[def.dsp] : typeof def.gain === 'function'));
      if (!list.some(({ def }) => def.dsp)) return null;
      const durS = x.dur / TICKS;
      const kfs = {};
      let memory = 0;
      let latency = 0;
      const stages = list.map(({ e, def }) => {
        const base = registry.resolve ? registry.resolve(e.type, e.params || {}) : { ...e.params };
        const keyed = Object.keys(base).map((k) => [k, clip.keyframes?.[`effects.${e.id}.${k}`]]).filter(([, l]) => l?.length);
        for (const [k, l] of keyed) kfs[`${e.id}.${k}`] = l;
        const proc = def.dsp ? fxm.processors[def.dsp] : null;
        if (proc) { memory += proc.memory(base, rate); latency += proc.latency(rate); }
        return proc ? { proc, base, keyed } : { gain: (p, t) => def.gain(p, t, durS), base, keyed };
      });
      const C = fxm.CONTROL;
      const warm = Math.max(C, Math.ceil((Math.min(fxm.MAX_MEMORY, memory) * rate) / C) * C);
      const key = JSON.stringify([keyOf(x.media), clip.in, clip.out, clip.speed, !!clip.reverse, clip.keepPitch !== false, clip.start, span.from, span.to, x.dur,
        list.map(({ e }) => [e.id, e.type, e.params]), kfs]);
      const keyframes = mod('keyframes');
      // Stage k's parameters at sequence sample i: the stored ones, keyframes evaluated at that sample.
      const paramsAt = (k, i) => {
        const s = stages[k];
        if (!s.keyed.length) return s.base;
        const tau = i * tps - clip.start;
        const p = { ...s.base };
        for (const [id, l] of s.keyed) p[id] = keyframes.valueAt(l, tau, s.base[id]);
        return p;
      };
      return { stages, warm, latency, key, paramsAt, anchor: Math.ceil(span.from / tps), end: Math.ceil(span.to / tps) };
    }
    // Sequence samples of segment j ([s0, s1)) and of its run ([r0, r1): the warm-up, the segment, its cross-fade
    // tail); the run's input reaches `latency` samples further.
    function segmentRun(chain, j) {
      const s0 = chain.anchor + j * FX_SEGMENT;
      const s1 = Math.min(chain.end, s0 + FX_SEGMENT);
      return { s0, s1, r0: Math.max(chain.anchor, s0 - chain.warm), r1: Math.min(chain.end, s1 + FX_XFADE) };
    }
    // The sequence samples the chain's runs read to give samples [a, b) (as chainRange goes through them).
    function chainSpan(chain, a, b) {
      const jA = Math.floor((a - chain.anchor) / FX_SEGMENT);
      const jB = Math.floor((b - 1 - chain.anchor) / FX_SEGMENT);
      const first = jA > 0 && a - (chain.anchor + jA * FX_SEGMENT) < FX_XFADE ? jA - 1 : jA;
      return [segmentRun(chain, first).r0, Math.min(chain.end, segmentRun(chain, jB).r1 + chain.latency)];
    }
    // The samples of the source store that sequence samples [i0, i1) of a clip at speed 1 (forward or reversed) read.
    function sourceOf(x, i0, i1) {
      const { clip } = x;
      const startS = clip.start / tps;
      if (clip.reverse) return [Math.floor(clip.out / tps - (i1 - startS)) - 2, Math.ceil(clip.out / tps - (i0 - startS)) + 1];
      return [Math.floor(clip.in / tps + (i0 - startS)) - 1, Math.ceil(clip.in / tps + (i1 - startS)) + 1];
    }
    function fxSegment(chain, x, srcAt, j) {
      const k = `${chain.key}|${j}`;
      const hit = fxSegments.get(k);
      if (hit) { hit.used = ++useTick; return hit; }
      const fxm = mod('audiofx');
      const { s0, s1, r0, r1 } = segmentRun(chain, j);
      const lat = chain.latency;
      const n = r1 - r0 + lat;
      const L = new Float64Array(n);
      const R = new Float64Array(n);
      const two = [0, 0];
      for (let i = r0, e = Math.min(chain.end, r0 + n); i < e; i++) {
        srcAt(i, two);
        L[i - r0] = two[0];
        R[i - r0] = two[1];
      }
      const clipStart = x.clip.start;
      fxm.createChain(chain.stages, rate).process(L, R, n, {
        paramsAt: (k2, i) => chain.paramsAt(k2, r0 + i),
        secondsAt: (i) => ((r0 + i) * tps - clipStart) / TICKS,
      });
      // The output for sequence sample i is at (i - r0) + latency.
      const cut = (a, b) => [Float32Array.from(L.subarray(a - r0 + lat, b - r0 + lat)), Float32Array.from(R.subarray(a - r0 + lat, b - r0 + lat))];
      const entry = { body: cut(s0, s1), tail: cut(s1, r1), used: ++useTick };
      fxSegments.set(k, entry);
      while (fxSegments.size > FX_KEEP) {
        let worst = null;
        let oldest = Infinity;
        for (const [key, e] of fxSegments) if (e.used < oldest) { oldest = e.used; worst = key; }
        fxSegments.delete(worst);
      }
      return entry;
    }
    // The chain's output for sequence samples [a, b) -> [L, R], or null while a block of the source it reads is not
    // in memory yet (it is asked for).
    function chainRange(chain, x, pcm, srcAt, a, b, speed1) {
      const jA = Math.floor((a - chain.anchor) / FX_SEGMENT);
      const jB = Math.floor((b - 1 - chain.anchor) / FX_SEGMENT);
      const first = jA > 0 && a - (chain.anchor + jA * FX_SEGMENT) < FX_XFADE ? jA - 1 : jA;
      if (speed1 && pcm.reader) {
        for (let j = first; j <= jB; j++) {
          if (fxSegments.has(`${chain.key}|${j}`)) continue;
          const { r0, r1 } = segmentRun(chain, j);
          const [k0, k1] = sourceOf(x, r0, Math.min(chain.end, r1 + chain.latency));
          if (!has(pcm, k0, k1)) { ensure(pcm, k0, k1).catch(() => {}); return null; }
        }
      }
      const out = [new Float32Array(b - a), new Float32Array(b - a)];
      for (let j = jA; j <= jB; j++) {
        const seg = fxSegment(chain, x, srcAt, j);
        const s0 = chain.anchor + j * FX_SEGMENT;
        const from = Math.max(a, s0);
        const to = Math.min(b, s0 + seg.body[0].length);
        const prev = j > 0 && from - s0 < FX_XFADE ? fxSegment(chain, x, srcAt, j - 1) : null;
        for (let c = 0; c < 2; c++) {
          const body = seg.body[c];
          const tail = prev ? prev.tail[c] : null;
          const o = out[c];
          for (let i = from; i < to; i++) {
            const at = i - s0;
            let v = body[at];
            if (tail && at < tail.length) {
              const w = (at + 0.5) / FX_XFADE;
              v = tail[at] * (1 - w) + v * w;
            }
            o[i - a] = v;
          }
        }
      }
      return out;
    }

    // Adds one clip's sound for samples [s0, s0 + n) into the stereo bus.
    function renderClip(bus, project, seq, x, s0, n) {
      const keyframes = mod('keyframes');
      const { clip, media, dur } = x;
      const src = sources.get(keyOf(media));
      if (src?.state === 'none') return true;
      if (!src || src.state !== 'ready') return false;
      const pcm = src.pcm;
      const span = clipSpan(seq, clip, dur);
      const a = Math.max(s0, Math.ceil(span.from / tps));
      const b = Math.min(s0 + n, Math.ceil(span.to / tps));
      if (b <= a) return true;
      const plain = clip.speed === 1 && !clip.reverse;
      const revPlain = clip.speed === 1 && clip.reverse;
      const chain = chainOf(x, span);
      // A block not read yet: asked for, and this clip is missing from this mix. (A chain checks its segments' input.)
      // A clip at another speed needs the source only of the segments it hears that are not made yet.
      const g = plain || revPlain ? null : speedOf(pcm, x, span);
      if (g) {
        let ready = true;
        for (const [k0, k1] of speedReads(g, chain, a, b)) if (!has(pcm, k0, k1)) { ensure(pcm, k0, k1).catch(() => {}); ready = false; }
        if (!ready) return false;
      } else if (!chain) {
        const need = sourceSpan(x, span, a * tps, b * tps);
        if (pcm.reader && !has(pcm, need[0], need[1])) { ensure(pcm, need[0], need[1]).catch(() => {}); return false; }
      }
      const segs = new Map(); // the segments of g's stream this block has used (one the LRU drops meanwhile stays here)
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
      const startS = startT / tps;
      // The source's sound at sequence sample i -> out [l, r] (0 outside the source).
      const srcAt = (i, out) => {
        const along = i - startS; // samples from the clip start
        out[0] = 0;
        out[1] = 0;
        if (plain || revPlain) {
          const k = plain ? Math.round(inS + along) : Math.round(outS - along) - 1;
          if (k < 0 || k >= pcm.length) return;
          if (k < bStart || k >= bEnd) blockAt(k);
          if (!L) return;
          out[0] = L[k - bStart];
          out[1] = R[k - bStart];
        } else {
          const k = Math.round(along - g.origin / tps);
          if (k < 0 || k >= g.outLen) return;
          const j = Math.floor(k / g.seg);
          let e = segs.get(j);
          if (e === undefined) segs.set(j, (e = speedSegment(pcm, g, j)));
          if (!e) return;
          out[0] = e.data[0][k - j * g.seg];
          out[1] = e.data[1][k - j * g.seg];
        }
      };
      const fxOut = chain ? chainRange(chain, x, pcm, srcAt, a, b, plain || revPlain) : null;
      if (chain && !fxOut) return false;
      const volList = clip.keyframes?.volume;
      const duckList = clip.keyframes?.duck;
      const panList = clip.keyframes?.pan;
      const baseVol = clip.props?.volume ?? 0;
      const basePan = clip.props?.pan ?? 0;
      // Gain effects of the registry (effects.js) on a clip without a chain: gain(params, seconds into the clip, clip
      // seconds) -> linear gain. With a chain they are stages of it, in their place among the processors.
      const registry = mod('effects');
      const fx = chain ? [] : (clip.effects || []).map((e) => ({ e, def: e.on !== false ? registry?.get?.(e.type) : null }))
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
        let g = dbToGain((volList?.length ? keyframes.valueAt(volList, tau, baseVol) : baseVol) + (duckList?.length ? keyframes.valueAt(duckList, tau, 0) : 0));
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
      // Gains are computed every KF_STEP samples on a grid counted from the clip's first audible sample (not from the
      // mix's block, so a sample's gain does not depend on where a block starts) and interpolated linearly between.
      const anchor = Math.ceil(span.from / tps);
      const two = [0, 0];
      for (let seg = anchor + Math.floor((a - anchor) / KF_STEP) * KF_STEP; seg < b; seg += KF_STEP) {
        const segEnd = seg + KF_STEP;
        const [gl0, gr0] = gainsAt(seg * tps - startT);
        const [gl1, gr1] = gainsAt(segEnd * tps - startT);
        for (let i = Math.max(a, seg), e = Math.min(b, segEnd); i < e; i++) {
          const f = (i - seg) / KF_STEP;
          let l;
          let r;
          if (fxOut) { l = fxOut[0][i - a]; r = fxOut[1][i - a]; } else { srcAt(i, two); l = two[0]; r = two[1]; }
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
      const missed = [];
      const seq = project?.sequences.find((s) => s.id === seqId);
      if (!seq) return { out, tracks, master: [0, 0], rms: [0, 0], missing, missed };
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
          if (!renderClip(bus, project, seq, x, s0, n)) { missing++; missed.push({ clip: x.clip.id, media: x.media.nest ? null : x.media.id }); }
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
      let sl = 0;
      let sr = 0;
      for (let i = 0; i < n; i++) {
        const l = (out[0][i] *= mg);
        const r = (out[1][i] *= mg);
        if (Math.abs(l) > ml) ml = Math.abs(l);
        if (Math.abs(r) > mr) mr = Math.abs(r);
        sl += l * l;
        sr += r * r;
      }
      return { out, tracks, master: [ml, mr], rms: n ? [Math.sqrt(sl / n), Math.sqrt(sr / n)] : [0, 0], missing, missed };
    }

    // mix() once the blocks of those samples, and LOOKAHEAD_SECONDS after them, are read: for loops through a range.
    async function mixLoaded(project, seqId, s0, n, opts) {
      await load(project, seqId, s0 * tps, (s0 + n) * tps + LOOKAHEAD_SECONDS * TICKS);
      return mix(project, seqId, s0, n, opts);
    }

    // The sources that could not be read, those of nests included: [{media, error}].
    const failures = () => [...sources.values()].filter((s) => s.state === 'failed').map((s) => ({ media: s.media.nest ? null : s.media.id, error: String(s.error?.message || s.error) }));
    // Bytes of sound held: source blocks and stretched segments.
    function held() {
      let blocks = 0;
      for (const s of sources.values()) for (const e of s.pcm?.blocks.values() || []) blocks += e.data[0].byteLength + e.data[1].byteLength;
      let segments = 0;
      for (const e of speedSegs.values()) segments += e.data[0].byteLength + e.data[1].byteLength;
      return { blocks, segments };
    }
    return { rate, load, mix, mixLoaded, sources, failures, held, forget: () => { sources.clear(); speedSegs.clear(); fxSegments.clear(); } };
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
  // meters() the levels being heard in dBFS: {master (peak), masterChannels: [l, r] (peaks), masterRms: [l, r] (RMS of
  // the block being heard, about 43 ms), tracks: {id: peak dB}, trackChannels: {id: [l, r] peaks dB}} (a track's level
  // after its fader and pan, before the master). opts.onBlock(sample, [L, R], missing) sees every block scheduled.
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
          heard.push({ from: scheduledUntil, to: scheduledUntil + seconds, master: [m.master[0] * g, m.master[1] * g], rms: [m.rms[0] * g, m.rms[1] * g], tracks: m.tracks });
          opts.onBlock?.(nextSample, m.out, m.missing);
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
      const quiet = { master: -Infinity, masterChannels: [-Infinity, -Infinity], masterRms: [-Infinity, -Infinity], tracks: {}, trackChannels: {} };
      if (!playing || !ctx) return quiet;
      const out = outputTime();
      const h = heard.find((x) => x.from <= out && out < x.to) || null;
      if (!h) return quiet;
      const tracks = {};
      const trackChannels = {};
      for (const [id, [l, r]] of Object.entries(h.tracks)) { tracks[id] = gainToDb(Math.max(l, r)); trackChannels[id] = [gainToDb(l), gainToDb(r)]; }
      return { master: gainToDb(Math.max(h.master[0], h.master[1])), masterChannels: h.master.map(gainToDb), masterRms: h.rms.map(gainToDb), tracks, trackChannels };
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
