// Signal analysis for Nano Studio Cut's automation (docs/cut-architecture.md section 9): no models, only measurements
// of the sound and the picture. ui-auto.js reads the samples and frames (Cut.decoder) and turns the answers into edit
// commands; everything here is pure and tested in Node (verify/cut-analyze.mjs).
//
// - Levels: RMS in dBFS over short windows, read a block at a time (levelMeter), so a long file is never all in memory.
//   Quiet stretches of at least a minimum length, less a margin on both sides, are the silences; what is left of the
//   clips is speech (used by ducking).
// - Onsets and beats: spectral flux (the rise of a log-magnitude spectrum, frame after frame), its autocorrelation for
//   the tempo, and a dynamic-programming beat tracker (Ellis 2007) for the beat times; the bar phase is the one whose
//   beats carry the most onset strength.
// - Scenes: colour histograms of small frames; a cut is where neighbouring frames differ by more than a threshold,
//   unless the picture comes back right after (a flash).
// - Colour: the average of a frame made neutral with the engine's own white balance (Cut.effects.whiteBalance) and
//   its log-average luminance brought to mid-grey with the engine's own gains (Cut.effects.cpu.basicPlan).
// - Ducking: volume keyframes that lower a music clip while speech plays, with linear dB ramps.
//
// Times: levels, onsets and beats are in seconds from the start of what was analysed; timeline ranges are ticks.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).analyze = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const QUIET = -200; // the level of digital silence, instead of -Infinity

  // ---- ranges ([a, b] pairs, sorted) -----------------------------------------------------------------------------------

  // Overlapping or touching ranges joined.
  function union(list) {
    const sorted = list.filter((r) => r[1] > r[0]).map((r) => [r[0], r[1]]).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push(r);
    }
    return out;
  }
  // What of `spans` is not in `cuts`.
  function subtract(spans, cuts) {
    const a = union(spans);
    const b = union(cuts);
    const out = [];
    let j = 0;
    for (const [s, e] of a) {
      let at = s;
      while (j < b.length && b[j][1] <= at) j++;
      let k = j;
      while (k < b.length && b[k][0] < e) {
        if (b[k][0] > at) out.push([at, b[k][0]]);
        at = Math.max(at, b[k][1]);
        if (at >= e) break;
        k++;
      }
      if (at < e) out.push([at, e]);
    }
    return out;
  }
  function intersect(x, y) {
    const a = union(x);
    const b = union(y);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const s = Math.max(a[i][0], b[j][0]);
      const e = Math.min(a[i][1], b[j][1]);
      if (e > s) out.push([s, e]);
      if (a[i][1] < b[j][1]) i++;
      else j++;
    }
    return out;
  }
  const total = (list) => list.reduce((n, r) => n + (r[1] - r[0]), 0);

  // ---- clip time ---------------------------------------------------------------------------------------------------------

  // The source ticks [lo, hi) a clip shows.
  const sourceSpan = (clip) => [Math.min(clip.in, clip.out), Math.max(clip.in, clip.out)];
  // The timeline time at which a clip shows source time `src` (ticks), the inverse of model.sourceTime; a reversed
  // clip shows its out point first. null for a freeze frame.
  function toTimeline(clip, src) {
    if (clip.source?.freeze) return null;
    const along = clip.reverse ? clip.out - src : src - clip.in;
    const t = clip.start + along / clip.speed;
    return Math.min(need('model').clipEnd(clip), Math.max(clip.start, t));
  }
  // Source ranges (ticks) -> timeline ranges (ticks) of the clip, in timeline order.
  const rangesToTimeline = (clip, list) => union(list.map(([a, b]) => {
    const x = toTimeline(clip, a);
    const y = toTimeline(clip, b);
    return x === null ? [0, 0] : [Math.min(x, y), Math.max(x, y)];
  }));

  // ---- levels ------------------------------------------------------------------------------------------------------------

  // Streams planes ([Float32Array] per channel) into RMS levels of `windowSec` windows: the louder channel's mean
  // square, in dBFS (a full-scale sine is -3). push() as often as wanted; levels() returns the windows so far, the last
  // partial one included.
  function levelMeter(rate, windowSec = 0.01) {
    const size = Math.max(1, Math.round(rate * windowSec));
    let out = new Float32Array(1024);
    let n = 0;
    let fill = 0;
    let acc = [];
    const put = (v) => {
      if (n === out.length) { const bigger = new Float32Array(out.length * 2); bigger.set(out); out = bigger; }
      out[n++] = v;
    };
    const level = () => {
      let m = 0;
      for (const s of acc) m = Math.max(m, s / Math.max(1, fill));
      return m > 0 ? Math.max(QUIET, 10 * Math.log10(m)) : QUIET;
    };
    return {
      size,
      step: size / rate,
      push(planes) {
        const len = planes[0]?.length || 0;
        if (acc.length !== planes.length) acc = planes.map((_, i) => acc[i] || 0);
        let i = 0;
        while (i < len) {
          const take = Math.min(size - fill, len - i);
          for (let c = 0; c < planes.length; c++) {
            const p = planes[c];
            let s = acc[c];
            for (let k = i; k < i + take; k++) s += p[k] * p[k];
            acc[c] = s;
          }
          fill += take;
          i += take;
          if (fill === size) { put(level()); fill = 0; acc = acc.map(() => 0); }
        }
      },
      levels() {
        const res = out.slice(0, n + (fill ? 1 : 0));
        if (fill) res[n] = level();
        return res;
      },
    };
  }
  const levels = (planes, rate, windowSec = 0.01) => { const m = levelMeter(rate, windowSec); m.push(planes); return { levels: m.levels(), step: m.step }; };

  // The windows louder than `threshold` dBFS as [a, b] seconds.
  function loudRanges(lv, step, threshold = -40) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= lv.length; i++) {
      const loud = i < lv.length && lv[i] > threshold;
      if (loud && start < 0) start = i;
      else if (!loud && start >= 0) { out.push([start * step, i * step]); start = -1; }
    }
    return out;
  }

  // The silences to cut, in ticks: the parts of `spans` that `loud` does not cover, at least `minLength` long, less
  // `margin` at both ends, then inside whole frames of `frame` ticks.
  function silenceRanges(spans, loud, { minLength = 0, margin = 0, frame = 1 } = {}) {
    const out = [];
    for (const [a, b] of subtract(spans, loud)) {
      if (b - a < minLength) continue;
      const s = Math.ceil((a + margin) / frame - 1e-9) * frame;
      const e = Math.floor((b - margin) / frame + 1e-9) * frame;
      if (e > s) out.push([s, e]);
    }
    return out;
  }
  // The speech in `spans`: what is left once silences of `hold` or longer are taken out (pauses shorter than that stay
  // speech, so ducking does not pump between words).
  const speechRanges = (spans, loud, { hold = 0.5 * need('time').TICKS } = {}) => subtract(spans, silenceRanges(spans, loud, { minLength: hold }));

  // ---- spectra -----------------------------------------------------------------------------------------------------------

  // An in-place radix-2 FFT of n (a power of two) points.
  function createFft(n) {
    const levelsN = Math.round(Math.log2(n));
    if (2 ** levelsN !== n) throw new Error('the FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levelsN; b++) r |= ((i >> b) & 1) << (levelsN - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let k = 0; k < half; k++) {
            const wr = cos[k * step];
            const wi = sin[k * step];
            const a = i + k;
            const b = a + half;
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    };
  }

  // Streams mono samples into a spectral flux envelope: frames of `size` samples every `hop`, Hann window, log
  // magnitude, the sum of each bin's rise since the frame before. Frame i is centered on sample i * hop + size / 2.
  function createFlux(rate, { size = 1024, hop = 512 } = {}) {
    const fft = createFft(size);
    const win = new Float64Array(size);
    for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    let prev = null;
    const buf = new Float32Array(size);
    let have = 0; // samples in buf
    let env = new Float32Array(4096);
    let n = 0;
    const frame = () => {
      for (let i = 0; i < size; i++) { re[i] = buf[i] * win[i]; im[i] = 0; }
      fft(re, im);
      const bins = size / 2 + 1;
      const mag = new Float64Array(bins);
      for (let k = 0; k < bins; k++) mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]) / size);
      let flux = 0;
      if (prev) for (let k = 0; k < bins; k++) { const d = mag[k] - prev[k]; if (d > 0) flux += d; }
      prev = mag;
      if (n === env.length) { const bigger = new Float32Array(env.length * 2); bigger.set(env); env = bigger; }
      env[n++] = flux;
      buf.copyWithin(0, hop, size);
      have = size - hop;
    };
    return {
      hop,
      size,
      rate,
      hopSeconds: hop / rate,
      // The time (seconds) of envelope frame i.
      timeOf: (i) => (i * hop + size / 2) / rate,
      push(mono) {
        let i = 0;
        while (i < mono.length) {
          const take = Math.min(size - have, mono.length - i);
          buf.set(mono.subarray(i, i + take), have);
          have += take;
          i += take;
          if (have === size) frame();
        }
      },
      envelope: () => env.slice(0, n),
    };
  }
  // Mono of planes (their mean).
  function mono(planes) {
    const len = planes[0]?.length || 0;
    if (planes.length === 1) return planes[0];
    const out = new Float32Array(len);
    for (const p of planes) for (let i = 0; i < len; i++) out[i] += p[i];
    for (let i = 0; i < len; i++) out[i] /= planes.length;
    return out;
  }

  // The onset strength: the envelope less its local mean (about `windowSec`), rectified and scaled to unit deviation.
  function onsetStrength(env, hopSeconds, windowSec = 0.5) {
    const n = env.length;
    const w = Math.max(1, Math.round(windowSec / hopSeconds / 2));
    const out = new Float32Array(n);
    let sum = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < n; i++) {
      while (hi < Math.min(n - 1, i + w)) sum += env[++hi];
      while (lo < i - w) sum -= env[lo++];
      out[i] = Math.max(0, env[i] - sum / (hi - lo + 1));
    }
    let sq = 0;
    for (let i = 0; i < n; i++) sq += out[i] * out[i];
    const sd = Math.sqrt(sq / Math.max(1, n)) || 1;
    for (let i = 0; i < n; i++) out[i] /= sd;
    return out;
  }

  // The tempo of an onset strength curve: the autocorrelation's best lag between `min` and `max` BPM, weighted toward
  // 120 BPM (one octave of spread) so a half or double tempo loses -> {bpm, period (frames), confidence 0..1}.
  function tempo(strength, hopSeconds, { min = 60, max = 200 } = {}) {
    const n = strength.length;
    const lagOf = (bpm) => 60 / bpm / hopSeconds;
    const l0 = Math.max(1, Math.floor(lagOf(max)));
    const l1 = Math.min(n - 1, Math.ceil(lagOf(min)));
    if (l1 <= l0 + 1) return { bpm: 0, period: 0, confidence: 0 };
    const ac = new Float64Array(l1 + 2);
    let zero = 0;
    for (let i = 0; i < n; i++) zero += strength[i] * strength[i];
    for (let l = l0 - 1; l <= l1 + 1; l++) {
      let s = 0;
      for (let i = 0; i + l < n; i++) s += strength[i] * strength[i + l];
      ac[l] = s / (n - l);
    }
    const weight = (l) => Math.exp(-0.5 * Math.log2(60 / (l * hopSeconds) / 120) ** 2);
    let best = -1;
    let bestScore = -Infinity;
    for (let l = l0; l <= l1; l++) {
      const score = ac[l] * weight(l);
      if (score > bestScore) { bestScore = score; best = l; }
    }
    // parabolic peak of the raw autocorrelation around the best lag
    const y0 = ac[best - 1] ?? ac[best];
    const y1 = ac[best];
    const y2 = ac[best + 1] ?? ac[best];
    const den = y0 - 2 * y1 + y2;
    const period = best + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);
    return { bpm: 60 / (period * hopSeconds), period, confidence: zero > 0 ? Math.max(0, Math.min(1, (ac[best] * n) / zero)) : 0 };
  }

  // Beat frames: the path through the strength curve that collects the most strength while its steps stay near
  // `period` frames (log-ratio penalty times `tightness`), found by dynamic programming and traced back from the best
  // end. Each beat is then moved to the strength peak within two frames and refined to a fraction of a frame.
  function trackBeats(strength, period, { tightness = 100 } = {}) {
    const n = strength.length;
    if (!(period >= 2) || n < 2) return [];
    const score = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2);
    const hi = Math.round(period * 2);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let arg = -1;
      for (let j = i - hi; j <= i - lo; j++) {
        if (j < 0) continue;
        const s = score[j] - tightness * Math.log((i - j) / period) ** 2;
        if (arg < 0 || s > best) { best = s; arg = j; }
      }
      score[i] = strength[i] + (arg >= 0 ? Math.max(0, best) : 0);
      back[i] = arg >= 0 && best > 0 ? arg : -1;
    }
    let end = Math.max(0, n - Math.ceil(period));
    for (let i = end; i < n; i++) if (score[i] > score[end]) end = i;
    const out = [];
    for (let i = end; i >= 0; i = back[i]) out.push(i);
    out.reverse();
    return out.map((b) => {
      let m = b;
      for (let k = Math.max(0, b - 2); k <= Math.min(n - 1, b + 2); k++) if (strength[k] > strength[m]) m = k;
      const y0 = strength[m - 1] ?? 0;
      const y1 = strength[m];
      const y2 = strength[m + 1] ?? 0;
      const den = y0 - 2 * y1 + y2;
      return m + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);
    });
  }

  // Which of the `per` beat phases starts the bars: the one whose beats carry the most strength.
  function barPhase(strength, beatFrames, per = 4) {
    const sums = new Array(per).fill(0);
    beatFrames.forEach((b, i) => { sums[i % per] += strength[Math.round(b)] || 0; });
    let best = 0;
    for (let p = 1; p < per; p++) if (sums[p] > sums[best]) best = p;
    return best;
  }

  // Beats of an envelope (createFlux) -> {bpm, beats: [seconds], phase (the index of the first downbeat), confidence}.
  // The tempo reported is the slope of the beats against their numbers, which is finer than one lag.
  function beats(flux, env, opts = {}) {
    const strength = onsetStrength(env, flux.hopSeconds);
    const t = tempo(strength, flux.hopSeconds, opts);
    const frames = trackBeats(strength, t.period, opts);
    const list = frames.map((f) => flux.timeOf(f));
    let bpm = t.bpm;
    if (list.length >= 4) {
      const k = list.length;
      const mi = (k - 1) / 2;
      const mt = list.reduce((a, b) => a + b, 0) / k;
      let num = 0;
      let den = 0;
      list.forEach((x, i) => { num += (i - mi) * (x - mt); den += (i - mi) ** 2; });
      if (num > 0) bpm = 60 / (num / den);
    }
    return { bpm, beats: list, phase: barPhase(strength, frames, opts.per || 4), confidence: t.confidence };
  }

  // ---- pictures ----------------------------------------------------------------------------------------------------------

  // A joint RGB histogram of RGBA pixels, `bins` steps per channel, summing to 1.
  function histogram(rgba, w, h, bins = 8) {
    const out = new Float32Array(bins * bins * bins);
    const q = 256 / bins;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const r = (rgba[i * 4] / q) | 0;
      const g = (rgba[i * 4 + 1] / q) | 0;
      const b = (rgba[i * 4 + 2] / q) | 0;
      out[(r * bins + g) * bins + b] += 1;
    }
    for (let i = 0; i < out.length; i++) out[i] /= n || 1;
    return out;
  }
  // Half the L1 distance: 0 for the same distribution, 1 for ones that share nothing.
  function histDistance(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / 2;
  }

  // Scene cuts among frames r0..r1 (presentation ranks, r1 inclusive): every `step`-th frame is compared with the one
  // before it; a difference above `threshold` is narrowed to the first frame of the new picture, and dropped when the
  // picture `step` frames later is the old one again (a flash) or still far from this one (a fade or a dissolve: the
  // picture keeps changing, and one cut is kept where it settles). histAt(rank) -> Promise<histogram>. -> [ranks of
  // the first frame of each new scene].
  async function detectScenes(r0, r1, histAt, { threshold = 0.35, step = 2, onProgress, signal } = {}) {
    const cuts = [];
    if (r1 <= r0) return cuts;
    let prevRank = r0;
    let prev = await histAt(r0);
    for (let r = Math.min(r1, r0 + step); r <= r1; r = r === r1 ? r1 + 1 : Math.min(r1, r + step)) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      const cur = await histAt(r);
      if (histDistance(prev, cur) > threshold) {
        let first = r;
        for (let k = prevRank + 1; k < r; k++) {
          if (histDistance(prev, await histAt(k)) > threshold) { first = k; break; }
        }
        const after = Math.min(r1, r + step);
        const next = after > r ? await histAt(after) : null;
        const flash = !!next && histDistance(prev, next) <= threshold / 2;
        const changing = !!next && histDistance(cur, next) > threshold;
        if (!flash && !changing) {
          cuts.push(first);
          prev = cur;
        }
      } else prev = cur;
      prevRank = r;
      onProgress?.((r - r0) / (r1 - r0));
    }
    return cuts;
  }

  // Temperature, tint and exposure for color.basic that make the average of the pictures neutral and bring their
  // log-average luminance to mid-grey (0.18 linear), without pushing the brightest percent past white or below
  // HIGHLIGHT (linear). images: [{rgba (sRGB bytes), w, h}].
  const HIGHLIGHT = 0.8;
  function autoColor(images) {
    const fx = need('effects');
    const L = fx.LUMA;
    const lut = new Float64Array(256);
    for (let i = 0; i < 256; i++) lut[i] = fx.srgbToLinear(i / 255);
    const sum = [0, 0, 0];
    let count = 0;
    const px = [];
    for (const { rgba, w, h } of images) {
      for (let i = 0; i < w * h; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        const c = [lut[r], lut[g], lut[b]];
        px.push(c);
        // clipped and black pixels say nothing about the light
        if (Math.max(r, g, b) >= 250 || c[0] * L[0] + c[1] * L[1] + c[2] * L[2] < 0.002) continue;
        sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        count++;
      }
    }
    if (!px.length) return null;
    const wb = count ? fx.whiteBalance(sum.map((v) => v / count)) : { temperature: 0, tint: 0 };
    const plan = fx.cpu.basicPlan({ ...fx.defaults('color.basic'), temperature: wb.temperature, tint: wb.tint, exposure: 0 });
    const ys = px.map((c) => c[0] * plan.gain[0] * L[0] + c[1] * plan.gain[1] * L[1] + c[2] * plan.gain[2] * L[2]);
    const logAvg = Math.exp(ys.reduce((a, y) => a + Math.log(1e-4 + y), 0) / ys.length);
    let exposure = Math.log2(0.18 / logAvg);
    const sorted = Float64Array.from(ys).sort();
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    // Brighter, but not past white; darker, but the brightest percent stays bright: a light, high-key picture (a white
    // stage, snow) is not pulled down to mid-grey.
    if (exposure > 0 && p99 > 0) exposure = Math.min(exposure, Math.max(0, Math.log2(1 / p99)));
    if (exposure < 0 && p99 > 0) exposure = Math.max(exposure, Math.min(0, Math.log2(HIGHLIGHT / p99)));
    const ep = fx.get('color.basic').params.find((p) => p.id === 'exposure');
    exposure = Math.max(ep.min, Math.min(ep.max, Math.round(exposure * 100) / 100));
    return { temperature: wb.temperature, tint: wb.tint, exposure };
  }

  // ---- ducking -----------------------------------------------------------------------------------------------------------

  // `duck` keyframes (dB added to the volume) for a music clip of `duration` ticks that dip by `amount` dB (negative)
  // during each of `speech` (clip time ticks), ramping over `fade` ticks before and after. Dips whose ramps would meet
  // are joined. Times are whole frames of `frame` ticks. -> [{t, v, ease}] (empty when nothing dips).
  function duckKeyframes({ duration, speech, amount = -12, fade = 0, frame = 1 }) {
    const snap = (t) => Math.max(0, Math.min(duration, Math.round(t / frame) * frame));
    const dips = [];
    for (const [a0, b0] of union(speech)) {
      const a = snap(a0);
      const b = snap(b0);
      if (b <= 0 || a >= duration || b <= a) continue;
      const last = dips[dips.length - 1];
      if (last && a - fade <= last[1] + fade) last[1] = Math.max(last[1], b);
      else dips.push([a, b]);
    }
    if (!dips.length) return [];
    // the dip in dB at t: down inside a dip, a straight ramp `fade` long on either side (joined dips never share one)
    const dipAt = (t) => {
      if (dips.some(([a, b]) => t >= a && t <= b)) return amount;
      for (const [a, b] of dips) {
        if (t > a - fade && t < a) return (amount * (t - (a - fade))) / fade;
        if (t > b && t < b + fade) return (amount * (b + fade - t)) / fade;
      }
      return 0;
    };
    const times = new Set([0, duration]);
    for (const [a, b] of dips) for (const t of [a - fade, a, b, b + fade]) if (t >= 0 && t <= duration) times.add(t);
    const out = [...times].sort((x, y) => x - y).map((t) => ({ t, v: Math.round(dipAt(t) * 100) / 100, ease: 'linear' }));
    // drop corners that sit on a straight line between their neighbours (the same value on both sides)
    return out.filter((k, i) => i === 0 || i === out.length - 1 || !(out[i - 1].v === k.v && out[i + 1].v === k.v));
  }

  return {
    QUIET,
    union, subtract, intersect, total,
    sourceSpan, toTimeline, rangesToTimeline,
    levelMeter, levels, loudRanges, silenceRanges, speechRanges,
    createFft, createFlux, mono, onsetStrength, tempo, trackBeats, barPhase, beats,
    histogram, histDistance, detectScenes,
    autoColor,
    duckKeyframes,
  };
});
