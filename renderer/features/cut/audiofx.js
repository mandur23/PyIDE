// The clip audio effects' signal processing of Nano Studio Cut (docs/cut-architecture.md §9): biquad filters from the
// RBJ Audio EQ Cookbook (the parametric equalizer, bass, treble, the hum notches), a feed-forward compressor, a
// look-ahead hard limiter and a noise gate. The registry (effects.js) names a processor here by its `dsp` field; the
// mixer (audioengine.js) runs a clip's effects as one chain (createChain) for the preview and the export alike.
//
// Everything is deterministic: plain double arithmetic, no randomness, no clock. A processor keeps its state between
// calls (filter memories, envelopes, the limiter's look-ahead), so a signal processed in one call or in many short ones
// comes out the same. Parameters are read once per CONTROL samples (keyframes move them at that rate).
//
// A processor: { latency(rate) -> samples it delays the signal by, memory(params, rate) -> seconds of input after which
// its state no longer depends on what came before (within about -100 dB), create(rate) -> state, process(state, L, R,
// from, to, params) /* in place on Float64Arrays */ }.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).audiofx = api;
})(() => {
  const CONTROL = 32;
  const MAX_MEMORY = 4; // seconds: the longest warm-up the mixer runs before a block (see audioengine.js)
  const dbToGain = (db) => (!(db > -144) ? 0 : Math.pow(10, db / 20));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ---- biquads (RBJ cookbook) ----------------------------------------------------------------------------------------

  // -> [b0, b1, b2, a1, a2] normalized by a0. type: lowpass, highpass, peaking, lowshelf, highshelf, notch, cut. Shelves
  // use Q in the cookbook's alpha (Q = 0.7071 is the shelf slope S = 1). `cut` is 1 - (1 - g) BP with the cookbook's
  // band-pass of 0 dB peak: gainDb at f0 and, unlike a peaking cut, the bandwidth of Q at every depth (the hum notches).
  function design(type, f0, gainDb, Q, fs) {
    const f = clamp(f0, 1, fs * 0.49);
    const w0 = (2 * Math.PI * f) / fs;
    const cs = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(1e-3, Q));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'cut': {
        const g = Math.pow(10, Math.min(0, gainDb || 0) / 20);
        b0 = 1 + g * alpha; b1 = -2 * cs; b2 = 1 - g * alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      }
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cs + s); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s);
        a0 = (A + 1) + (A - 1) * cs + s; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s);
        a0 = (A + 1) - (A - 1) * cs + s; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s;
        break;
      }
      default: // peaking
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  // |H| in dB of a biquad at f Hz.
  function magnitudeDb(c, f, fs) {
    const w = (2 * Math.PI * f) / fs;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2;
    const ni = -(c[1] * s1 + c[2] * s2);
    const dr = 1 + c[3] * c1 + c[4] * c2;
    const di = -(c[3] * s1 + c[4] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  // Samples after which a biquad's impulse response is down by e^-12 (about -104 dB): from its poles' radius.
  function ringSamples(c) {
    const [, , , a1, a2] = c;
    const disc = a1 * a1 - 4 * a2;
    const r = disc < 0 ? Math.sqrt(Math.max(0, a2)) : Math.max(Math.abs((-a1 + Math.sqrt(disc)) / 2), Math.abs((-a1 - Math.sqrt(disc)) / 2));
    if (!(r < 1)) return Infinity;
    return r <= 0 ? 0 : 12 / -Math.log(r);
  }

  const isIdentity = (c) => c[0] === 1 && c[1] === c[3] && c[2] === c[4];

  // One channel pair of transposed direct form II memories per filter.
  const newMem = () => new Float64Array(4); // z1L z2L z1R z2R
  function biquad(c, m, L, R, from, to) {
    const [b0, b1, b2, a1, a2] = c;
    let z1 = m[0];
    let z2 = m[1];
    for (let i = from; i < to; i++) {
      const x = L[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      L[i] = y;
    }
    // A decayed state is flushed to zero: subnormal doubles are a hundred times slower.
    m[0] = Math.abs(z1) < 1e-30 ? 0 : z1;
    m[1] = Math.abs(z2) < 1e-30 ? 0 : z2;
    z1 = m[2];
    z2 = m[3];
    for (let i = from; i < to; i++) {
      const x = R[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      R[i] = y;
    }
    m[2] = Math.abs(z1) < 1e-30 ? 0 : z1;
    m[3] = Math.abs(z2) < 1e-30 ? 0 : z2;
  }

  // Butterworth sections of a high- or low-pass of slope 12, 24 or 48 dB/octave (order 2, 4, 8).
  const BUTTERWORTH = { 12: [Math.SQRT1_2], 24: [0.5411961001461969, 1.3065629648763766], 48: [0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055] };
  const sectionsQ = (slope) => BUTTERWORTH[String(slope)] || BUTTERWORTH[12];

  // ---- the filters of an effect: [{type, f, gain, Q}] ------------------------------------------------------------

  // The parametric equalizer: high-pass, low shelf, three peaking bands, high shelf, low-pass; each with an on switch.
  function eqFilters(p) {
    const out = [];
    if (p.hpOn) for (const q of sectionsQ(p.hpSlope)) out.push({ type: 'highpass', f: p.hpFreq, gain: 0, Q: q });
    if (p.lsOn) out.push({ type: 'lowshelf', f: p.lsFreq, gain: p.lsGain, Q: Math.SQRT1_2 });
    for (const b of ['b1', 'b2', 'b3']) if (p[`${b}On`]) out.push({ type: 'peaking', f: p[`${b}Freq`], gain: p[`${b}Gain`], Q: p[`${b}Q`] });
    if (p.hsOn) out.push({ type: 'highshelf', f: p.hsFreq, gain: p.hsGain, Q: Math.SQRT1_2 });
    if (p.lpOn) for (const q of sectionsQ(p.lpSlope)) out.push({ type: 'lowpass', f: p.lpFreq, gain: 0, Q: q });
    return out;
  }
  const BASS_HZ = 200;
  const TREBLE_HZ = 4000;
  // The hum remover: a cut of `reduction` dB, Q wide, at the mains frequency and each harmonic up to `harmonics`.
  function humFilters(p, fs) {
    const f0 = Number(p.frequency) === 50 ? 50 : 60;
    const out = [];
    for (let k = 1; k <= Math.round(clamp(p.harmonics ?? 4, 1, 10)); k++) {
      if (f0 * k >= fs * 0.45) break;
      out.push({ type: 'cut', f: f0 * k, gain: -Math.abs(p.reduction ?? 30), Q: p.Q ?? 20 });
    }
    return out;
  }

  // A processor over a list of filters that depends on the parameters: coefficients are recomputed only when the
  // parameters change, and a filter that passes the signal unchanged (a 0 dB band) is skipped (its state stays zero,
  // which is the state it would have had).
  function filterBank(filtersOf, outputDb) {
    const signature = (p) => JSON.stringify(p);
    return {
      latency: () => 0,
      memory(p, fs) {
        let worst = 0;
        for (const f of filtersOf(p, fs)) worst = Math.max(worst, ringSamples(design(f.type, f.f, f.gain, f.Q, fs)));
        return Math.min(MAX_MEMORY, worst / fs);
      },
      create: (fs) => ({ fs, sig: null, coeffs: [], mems: [] }),
      process(st, L, R, from, to, p) {
        // The same parameters object (no keyframes) is the same filters.
        const sig = p === st.p ? st.sig : signature(p);
        st.p = p;
        if (sig !== st.sig) {
          st.sig = sig;
          const fl = filtersOf(p, st.fs);
          // Memories belong to a filter's place in the list, so a moving parameter keeps the filter's state.
          st.coeffs = fl.map((f) => design(f.type, f.f, f.gain, f.Q, st.fs));
          while (st.mems.length < st.coeffs.length) st.mems.push(newMem());
          st.mems.length = st.coeffs.length;
          st.out = outputDb ? dbToGain(outputDb(p)) : 1;
        }
        for (let k = 0; k < st.coeffs.length; k++) if (!isIdentity(st.coeffs[k])) biquad(st.coeffs[k], st.mems[k], L, R, from, to);
        if (st.out !== 1) for (let i = from; i < to; i++) { L[i] *= st.out; R[i] *= st.out; }
      },
    };
  }

  // ---- dynamics ----------------------------------------------------------------------------------------------------

  const coef = (ms, fs) => (ms > 0 ? Math.exp(-1000 / (ms * fs)) : 0);
  const levelDb = (x) => (x > 1e-10 ? 20 * Math.log10(x) : -200);

  // The compressor's static curve: output level (dB) for an input level (dB), with a soft knee of `knee` dB.
  function compressCurve(x, threshold, ratio, knee) {
    const d = x - threshold;
    if (knee > 0 && 2 * Math.abs(d) <= knee) return x + ((1 / ratio - 1) * (d + knee / 2) ** 2) / (2 * knee);
    return d > 0 ? threshold + d / ratio : x;
  }

  // Feed-forward, stereo linked (the louder channel), the gain computed per sample and smoothed in dB with the attack
  // time while the reduction grows and the release time while it shrinks (Giannoulis, Massberg and Reiss 2012).
  const compressor = {
    latency: () => 0,
    memory: (p) => Math.min(MAX_MEMORY, (6 * ((p.attack || 0) + (p.release || 0))) / 1000),
    create: (fs) => ({ fs, gs: 0 }),
    process(st, L, R, from, to, p) {
      const fs = st.fs;
      const aA = coef(p.attack, fs);
      const aR = coef(p.release, fs);
      const ratio = Math.max(1, p.ratio);
      const knee = Math.max(0, p.knee);
      const T = p.threshold;
      const makeup = p.makeup || 0;
      let gs = st.gs;
      for (let i = from; i < to; i++) {
        const lev = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        const x = levelDb(lev);
        const gc = compressCurve(x, T, ratio, knee) - x;
        gs = gc < gs ? aA * gs + (1 - aA) * gc : aR * gs + (1 - aR) * gc;
        const g = Math.pow(10, (gs + makeup) / 20);
        L[i] *= g;
        R[i] *= g;
      }
      st.gs = Math.abs(gs) < 1e-12 ? 0 : gs;
    },
  };

  // True peak, roughly: 4x oversampling by a 16-tap Kaiser-windowed sinc between two samples.
  const TP_PHASES = [0.25, 0.5, 0.75];
  const TP_HALF = 8;
  const tpRows = (() => {
    const besselI0 = (x) => { let s = 1; let t = 1; const q = (x * x) / 4; for (let k = 1; k < 40; k++) { t *= q / (k * k); s += t; } return s; };
    const beta = 6;
    const i0b = besselI0(beta);
    return TP_PHASES.map((ph) => {
      const row = new Float64Array(2 * TP_HALF);
      let sum = 0;
      for (let t = 0; t < 2 * TP_HALF; t++) {
        const x = t - (TP_HALF - 1) - ph;
        const u = x / TP_HALF;
        const w = Math.abs(u) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - u * u)) / i0b;
        row[t] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
        sum += row[t];
      }
      for (let t = 0; t < 2 * TP_HALF; t++) row[t] /= sum;
      return row;
    });
  })();

  // A brick-wall limiter that looks LOOKAHEAD ms ahead: the gain needed at each sample (ceiling / peak, the peak
  // between samples too when truePeak is on) pulls the gain down on a straight line over the look-ahead before it, and
  // the gain recovers with the release time. No output sample is ever above the ceiling. The signal comes out
  // latency() samples late; the chain takes that out.
  const LOOKAHEAD_MS = 1.5;
  const lookSamples = (fs) => Math.max(1, Math.round((LOOKAHEAD_MS * fs) / 1000));
  const limiter = {
    latency: (fs) => lookSamples(fs) + TP_HALF,
    memory: (p) => Math.min(MAX_MEMORY, (6 * (p.release || 0)) / 1000 + LOOKAHEAD_MS / 1000),
    create(fs) {
      const look = lookSamples(fs);
      const pow2 = (v) => 2 ** Math.ceil(Math.log2(v));
      const H = pow2(4 * TP_HALF + look + 2);
      const M = pow2(look + 2);
      return { fs, look, xl: new Float64Array(H), xr: new Float64Array(H), xm: H - 1, hr: new Float64Array(M).fill(1), hm: M - 1, n: 0, g: 1, ip: 0, low: -Infinity };
    },
    process(st, L, R, from, to, p) {
      const { look, xl, xr, xm, hr, hm } = st;
      const D = look + TP_HALF;
      const c = dbToGain(p.ceiling);
      const beta = coef(p.release, st.fs);
      const tp = !!p.truePeak;
      const W = 2 * TP_HALF;
      // The largest of the 4x points between samples m and m + 1 (ring indexes wrap by the mask, negatives too).
      const between = (arr, m) => {
        let worst = 0;
        const base = m - (TP_HALF - 1);
        for (let r = 0; r < tpRows.length; r++) {
          const row = tpRows[r];
          let v = 0;
          for (let t = 0; t < W; t++) v += row[t] * arr[(base + t) & xm];
          if (v < 0) v = -v;
          if (v > worst) worst = v;
        }
        return worst;
      };
      let { g, n, ip, low } = st;
      for (let i = from; i < to; i++, n++) {
        xl[n & xm] = L[i];
        xr[n & xm] = R[i];
        // The gain sample q needs: its own peak and, with true peak, the peaks on both sides of it.
        const q = n - TP_HALF;
        let peak = Math.max(Math.abs(xl[q & xm]), Math.abs(xr[q & xm]));
        if (tp) {
          const next = Math.max(between(xl, q), between(xr, q));
          if (ip > peak) peak = ip;
          if (next > peak) peak = next;
          ip = next;
        }
        const r = peak > c ? c / peak : 1;
        hr[q & hm] = r;
        if (r < 1) low = q;
        // The sample going out now, d, and the line down from every gain needed ahead of it (none: no loop).
        const d = n - D;
        let want = g + (1 - g) * (1 - beta);
        if (low >= d) {
          for (let k = 0; k <= look; k++) {
            const rk = hr[(d + k) & hm];
            if (rk < 1) {
              const v = rk + ((1 - rk) * k) / (look + 1);
              if (v < want) want = v;
            }
          }
        }
        g = want;
        let yl = xl[d & xm] * g;
        let yr = xr[d & xm] * g;
        if (yl > c) yl = c; else if (yl < -c) yl = -c;
        if (yr > c) yr = c; else if (yr < -c) yr = -c;
        L[i] = yl;
        R[i] = yr;
      }
      Object.assign(st, { g, n, ip, low });
    },
  };

  // A noise gate: open while the level (a 5 ms peak follower of the louder channel) is at or above the threshold and
  // for `hold` ms after it falls below; the gain moves to 1 with the attack time and to `range` dB with the release
  // time. It starts closed.
  const GATE_FOLLOW_MS = 5;
  const gate = {
    latency: () => 0,
    memory: (p) => Math.min(MAX_MEMORY, ((p.hold || 0) + 6 * ((p.attack || 0) + (p.release || 0)) + 6 * GATE_FOLLOW_MS) / 1000),
    create: (fs) => ({ fs, env: 0, hold: 0, g: -1 }),
    process(st, L, R, from, to, p) {
      const fs = st.fs;
      const thr = dbToGain(p.threshold);
      const floor = dbToGain(-Math.abs(p.range));
      const aA = coef(p.attack, fs);
      const aR = coef(p.release, fs);
      const fall = coef(GATE_FOLLOW_MS, fs);
      const holdN = Math.round(((p.hold || 0) * fs) / 1000);
      let { env, hold, g } = st;
      if (g < 0) g = floor;
      for (let i = from; i < to; i++) {
        const lev = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        env = lev > env ? lev : env * fall;
        let target;
        if (env >= thr) { hold = holdN; target = 1; } else if (hold > 0) { hold--; target = 1; } else target = floor;
        g = target > g ? target + (g - target) * aA : target + (g - target) * aR;
        L[i] *= g;
        R[i] *= g;
      }
      st.env = env < 1e-30 ? 0 : env;
      st.hold = hold;
      st.g = g;
    },
  };

  const processors = {
    eq: filterBank(eqFilters, (p) => p.output || 0),
    bass: filterBank((p) => [{ type: 'lowshelf', f: BASS_HZ, gain: p.boost, Q: Math.SQRT1_2 }]),
    treble: filterBank((p) => [{ type: 'highshelf', f: TREBLE_HZ, gain: p.boost, Q: Math.SQRT1_2 }]),
    dehum: filterBank(humFilters),
    compressor,
    limiter,
    gate,
  };
  // The filters an effect is made of, for a frequency response graph: [{type, f, gain, Q}] (empty for dynamics).
  function filtersOf(dsp, p, fs = 48000) {
    if (dsp === 'eq') return eqFilters(p);
    if (dsp === 'bass') return [{ type: 'lowshelf', f: BASS_HZ, gain: p.boost, Q: Math.SQRT1_2 }];
    if (dsp === 'treble') return [{ type: 'highshelf', f: TREBLE_HZ, gain: p.boost, Q: Math.SQRT1_2 }];
    if (dsp === 'dehum') return humFilters(p, fs);
    return [];
  }
  // The frequency response in dB of a filter effect at the given frequencies (the EQ graph of the effect controls).
  function response(dsp, p, freqs, fs = 48000) {
    const cs = filtersOf(dsp, p, fs).map((f) => design(f.type, f.f, f.gain, f.Q, fs));
    const out = dsp === 'eq' ? (p.output || 0) : 0;
    return freqs.map((f) => cs.reduce((s, c) => s + magnitudeDb(c, f, fs), out));
  }

  // ---- the chain -------------------------------------------------------------------------------------------------

  // stages: [{ proc } | { gain: (params, seconds) -> linear }]. process(L, R, n, ctx) runs them in order over
  // Float64Arrays in place, a CONTROL-sample block at a time: ctx.paramsAt(k, i) gives stage k's parameters at
  // processing index i (moved back by the latency of the stages before it, so a keyframe stays on its sound),
  // ctx.secondsAt(i) the clip time a gain stage reads. The output at index i is the input at i - latency.
  function createChain(stages, fs) {
    const delays = [];
    let latency = 0;
    for (const s of stages) { delays.push(latency); latency += s.proc ? s.proc.latency(fs) : 0; }
    const states = stages.map((s) => (s.proc ? s.proc.create(fs) : null));
    function process(L, R, n, ctx, offset = 0) {
      for (let q = 0; q < n; q += CONTROL) {
        const e = Math.min(n, q + CONTROL);
        for (let k = 0; k < stages.length; k++) {
          const s = stages[k];
          const i0 = offset + q - delays[k];
          if (s.proc) { s.proc.process(states[k], L, R, q, e, ctx.paramsAt(k, i0)); continue; }
          const g0 = s.gain(ctx.paramsAt(k, i0), ctx.secondsAt(i0));
          const g1 = s.gain(ctx.paramsAt(k, i0 + CONTROL), ctx.secondsAt(i0 + CONTROL));
          if (g0 === 1 && g1 === 1) continue;
          for (let i = q; i < e; i++) {
            const g = g0 + ((g1 - g0) * (i - q)) / CONTROL;
            L[i] *= g;
            R[i] *= g;
          }
        }
      }
    }
    return { process, latency, states };
  }

  // Runs one processor with fixed parameters over whole channels: -> new [L, R] (Float64Array), the latency taken
  // out. For the tests and for measuring a curve.
  function processBuffer(dsp, params, channels, fs = 48000, { blocks = null } = {}) {
    const proc = processors[dsp];
    const lat = proc.latency(fs);
    const n = channels[0].length;
    const L = new Float64Array(n + lat);
    const R = new Float64Array(n + lat);
    L.set(channels[0]);
    R.set(channels[1] || channels[0]);
    const st = proc.create(fs);
    const p = { ...params };
    const total = n + lat;
    let at = 0;
    let b = 0;
    while (at < total) {
      const len = blocks ? Math.max(1, blocks[b++ % blocks.length]) : CONTROL;
      const e = Math.min(total, at + len);
      proc.process(st, L, R, at, e, p);
      at = e;
    }
    return [L.subarray(lat), R.subarray(lat)];
  }

  return { CONTROL, MAX_MEMORY, design, magnitudeDb, ringSamples, processors, filtersOf, response, compressCurve, createChain, processBuffer, BUTTERWORTH, BASS_HZ, TREBLE_HZ, LOOKAHEAD_MS };
});
