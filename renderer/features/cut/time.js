// Time in Nano Studio Cut: integer ticks, 254,016,000,000 a second, so every frame rate the editor offers (23.976, 24,
// 25, 29.97, 30, 50, 59.94, 60) and the 44.1 and 48 kHz sample rates are whole numbers of ticks and edits never drift
// by a frame. A Number holds ticks exactly up to 2^53, about 9.8 hours (MAX_TICKS). A frame rate is [num, den], as
// 30000/1001 for 29.97. Loaded as Cut.time in the page and require()d by the Node tests.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).time = api;
})(() => {
  const TICKS = 254016000000;
  const MAX_TICKS = Math.floor(Number.MAX_SAFE_INTEGER / TICKS) * TICKS;
  const FRAME_RATES = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1]];

  const big = BigInt;
  // n / d rounded half away from zero; BigInt division alone truncates toward zero, which is wrong for negative times
  // (AAC priming, B-frame delay).
  const divRound = (n, d) => Number((n < 0n ? n - d / 2n : n + d / 2n) / d);
  // value * TICKS / scale without the overflow a container's 90 kHz timestamps hit, rounded to the nearest tick.
  const rescale = (value, scale) => divRound(big(Math.round(value)) * big(TICKS), big(scale));
  // ticks -> a timestamp in units of 1/scale (microseconds for WebCodecs: scale 1e6), rounded.
  const toScale = (ticks, scale) => divRound(big(Math.round(ticks)) * big(scale), big(TICKS));
  const fromSeconds = (s) => Math.round(s * TICKS);
  const toSeconds = (t) => t / TICKS;
  const fromMicros = (us) => rescale(us, 1e6);
  const toMicros = (t) => toScale(t, 1e6);
  // One frame's length; exact for every rate in FRAME_RATES.
  const frameTicks = ([num, den]) => (TICKS * den) / num;
  const fpsValue = ([num, den]) => num / den;
  // The frame that is on screen at t (frames start at 0 at t = 0). The division is corrected with exact integer
  // products: near MAX_TICKS a float quotient can be one frame off.
  function frameAt(t, fps) {
    const f = frameTicks(fps);
    const ticks = Math.round(t);
    let q = Math.floor(ticks / f);
    if (q * f > ticks) q -= 1;
    else if ((q + 1) * f <= ticks) q += 1;
    return q;
  }
  const frameStart = (frame, fps) => Math.round(frame * frameTicks(fps));
  // t moved to the start of its frame, or to the nearest frame boundary with { nearest: true }.
  function snap(t, fps, { nearest = false } = {}) {
    const f = frameTicks(fps);
    const q = frameAt(t, fps);
    return nearest && Math.round(t) - q * f >= f / 2 ? (q + 1) * f : q * f;
  }
  // HH:MM:SS:FF in whole frames of a nominal rate (29.97 counts 30 a second: non-drop-frame timecode).
  function timecode(t, fps) {
    const nominal = Math.round(fpsValue(fps));
    const sign = t < 0 ? '-' : '';
    const frames = Math.abs(frameAt(Math.abs(t), fps));
    const ff = frames % nominal;
    const secs = Math.floor(frames / nominal);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${sign}${p2(Math.floor(secs / 3600))}:${p2(Math.floor(secs / 60) % 60)}:${p2(secs % 60)}:${p2(ff)}`;
  }
  // Accepts HH:MM:SS:FF, MM:SS:FF, SS:FF, a frame count, or +N / -N frames from `from`. Returns ticks or null.
  function parseTimecode(text, fps, from = 0) {
    const s = String(text).trim();
    const rel = /^([+-])\s*(\d+)$/.exec(s);
    if (rel) return Math.max(0, from + (rel[1] === '-' ? -1 : 1) * frameStart(Number(rel[2]), fps));
    const parts = s.split(/[:;.]/).map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
    if (!parts.length || parts.length > 4 || parts.some(Number.isNaN)) return null;
    const nominal = Math.round(fpsValue(fps));
    const [h = 0, m = 0, sec = 0, ff = 0] = [0, 0, 0, 0].concat(parts).slice(-4);
    if (parts.length === 1) return frameStart(parts[0], fps);
    return frameStart(((h * 60 + m) * 60 + sec) * nominal + ff, fps);
  }
  return { TICKS, MAX_TICKS, FRAME_RATES, rescale, toScale, fromSeconds, toSeconds, fromMicros, toMicros, frameTicks, fpsValue, frameAt, frameStart, snap, timecode, parseTimecode };
});
