// The numbers behind the Lumetri Scopes panel (docs/cut-architecture.md section 8): a luma waveform, an RGB parade, a
// YUV vectorscope and RGB and luma histograms of the picture a monitor shows. The compositor counts them on the GPU
// with WGSL below (a compute pass over its 8-bit output texture) and the Canvas 2D back end with analyze() over the
// canvas's pixels; both count exactly the same integers, so the tests compare them bin by bin. Pure: Node and the page.
//
// Every scope reads the 8-bit sRGB values of the frame's box in the output (not the black bars around it), one pixel in
// `step` across and down (step keeps the count near BUDGET pixels). Integer math, Rec. 709:
//   Y'  = (13933 R + 46871 G + 4732 B + 32768) >> 16              (0..255)
//   Cb  = (-7509 R - 25259 G + 32768 B) >> 7, Cr = (32768 R - 29763 G - 3005 B) >> 7    (130560 per unit of Cb / Cr)
// Bins (u32), in one array (layout(cols, size)):
//   wave   [level * cols + col]           luma level 0..255 at column col = (x - x0) * cols / width
//   parade [(ch * 256 + level) * cols + col]  ch 0 red, 1 green, 2 blue
//   vector [vy * size + vx]               vx from Cb, vy from Cr (up), +-RANGE (0.6) of Cb and Cr across the square
//   hist   [ch * 256 + level]             ch 0 red, 1 green, 2 blue, 3 luma
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).scopes = api;
})(() => {
  const BUDGET = 262144;
  const RANGE = 0.6;
  const UNIT = 130560; // Cb or Cr of 1 after >> 7
  const K = Math.round(RANGE * UNIT);
  const KINDS = ['wave', 'parade', 'vector', 'hist'];

  function layout(cols = 256, size = 256) {
    const wave = 0;
    const parade = cols * 256;
    const vector = parade + 3 * cols * 256;
    const hist = vector + size * size;
    return { cols, size, wave, parade, vector, hist, total: hist + 4 * 256 };
  }
  // The pixels of an output of width x height that show a sequence of seqW x seqH (the compositor's final pass draws
  // it fitted and centered): [x0, x1) x [y0, y1).
  function frameRect(width, height, seqW, seqH) {
    const fit = Math.min(width / seqW, height / seqH);
    const bw = (seqW * fit) / width;
    const bh = (seqH * fit) / height;
    const lo = (b, n) => Math.max(0, Math.ceil(((1 - b) / 2) * n - 0.5));
    const hi = (b, n) => Math.min(n, Math.floor(((1 + b) / 2) * n - 0.5) + 1);
    return { x0: lo(bw, width), y0: lo(bh, height), x1: hi(bw, width), y1: hi(bh, height) };
  }
  const stepFor = (rect, budget = BUDGET) => Math.max(1, Math.ceil(Math.sqrt(((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / budget)));

  const lumaOf = (r, g, b) => (13933 * r + 46871 * g + 4732 * b + 32768) >> 16;
  const cbOf = (r, g, b) => (-7509 * r - 25259 * g + 32768 * b) >> 7;
  const crOf = (r, g, b) => (32768 * r - 29763 * g - 3005 * b) >> 7;
  // The vectorscope bin of an 8-bit color, or null outside the square.
  function vectorBin(r, g, b, size = 256) {
    const vx = Math.floor(((cbOf(r, g, b) + K) * size) / (2 * K));
    const vy = Math.floor(((K - crOf(r, g, b)) * size) / (2 * K));
    return vx >= 0 && vy >= 0 && vx < size && vy < size ? [vx, vy] : null;
  }
  // Where Cb, Cr (as fractions, -0.5..0.5) fall in the square, in bins (the center of the square is size / 2).
  const vectorAt = (cb, cr, size = 256) => [((cb + RANGE) * size) / (2 * RANGE), ((RANGE - cr) * size) / (2 * RANGE)];
  // The angle of a point of the square, degrees counterclockwise from +Cb (3 o'clock), 0..360.
  function angleAt(x, y, size = 256) {
    const a = (Math.atan2(size / 2 - y, x - size / 2) * 180) / Math.PI;
    return (a + 360) % 360;
  }
  // Cb, Cr of sRGB values 0..1 (exact Rec. 709).
  const chroma = (r, g, b) => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [(b - y) / 1.8556, (r - y) / 1.5748];
  };
  // The 75% and 100% color bar targets and the skin tone line (123 degrees, between red and yellow), in bins.
  const BARS = [['R', [1, 0, 0]], ['MG', [1, 0, 1]], ['B', [0, 0, 1]], ['CY', [0, 1, 1]], ['G', [0, 1, 0]], ['YL', [1, 1, 0]]];
  const SKIN_DEGREES = 123;
  function targets(size = 256) {
    return BARS.map(([name, c]) => {
      const [cb75, cr75] = chroma(...c.map((v) => v * 0.75));
      const [cb, cr] = chroma(...c);
      return { name, at75: vectorAt(cb75, cr75, size), at100: vectorAt(cb, cr, size), angle: angleAt(...vectorAt(cb, cr, size), size) };
    });
  }

  // The CPU count over RGBA bytes of width x height (the canvas's pixels); rect and step as frameRect / stepFor give.
  function analyze(rgba, width, height, rect, { cols = 256, size = 256, step = 1 } = {}) {
    const L = layout(cols, size);
    const bins = new Uint32Array(L.total);
    const rw = rect.x1 - rect.x0;
    if (rw <= 0 || rect.y1 <= rect.y0) return { bins, layout: L };
    const plane = cols * 256;
    for (let y = rect.y0; y < rect.y1; y += step) {
      for (let x = rect.x0; x < rect.x1; x += step) {
        const i = (y * width + x) * 4;
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        const col = Math.floor(((x - rect.x0) * cols) / rw);
        const Y = lumaOf(r, g, b);
        bins[L.wave + Y * cols + col]++;
        bins[L.parade + r * cols + col]++;
        bins[L.parade + plane + g * cols + col]++;
        bins[L.parade + 2 * plane + b * cols + col]++;
        const v = vectorBin(r, g, b, size);
        if (v) bins[L.vector + v[1] * size + v[0]]++;
        bins[L.hist + r]++;
        bins[L.hist + 256 + g]++;
        bins[L.hist + 512 + b]++;
        bins[L.hist + 768 + Y]++;
      }
    }
    return { bins, layout: L };
  }

  // The GPU count: one invocation per sampled pixel, the histograms gathered per workgroup first (a flat frame sends
  // every pixel to one bin). su.rect = x0, y0, x1, y1; su.cfg = cols, size, step, K; su.at = wave, parade, vector,
  // hist offsets.
  const WGSL = /* wgsl */ `
struct SU { rect: vec4u, cfg: vec4u, at: vec4u };
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> su: SU;
var<workgroup> wh: array<atomic<u32>, 1024>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  for (var k = li; k < 1024u; k += 256u) { atomicStore(&wh[k], 0u); }
  workgroupBarrier();
  let x = su.rect.x + gid.x * su.cfg.z;
  let y = su.rect.y + gid.y * su.cfg.z;
  if (x < su.rect.z && y < su.rect.w) {
    let v = textureLoad(img, vec2u(x, y), 0);
    let c = vec3u(round(clamp(v.rgb, vec3f(0.0), vec3f(1.0)) * 255.0));
    let r = i32(c.r);
    let g = i32(c.g);
    let b = i32(c.b);
    let cols = su.cfg.x;
    let size = su.cfg.y;
    let col = ((x - su.rect.x) * cols) / (su.rect.z - su.rect.x);
    let Y = u32((13933 * r + 46871 * g + 4732 * b + 32768) >> 16u);
    let plane = cols * 256u;
    atomicAdd(&bins[su.at.x + Y * cols + col], 1u);
    atomicAdd(&bins[su.at.y + c.r * cols + col], 1u);
    atomicAdd(&bins[su.at.y + plane + c.g * cols + col], 1u);
    atomicAdd(&bins[su.at.y + 2u * plane + c.b * cols + col], 1u);
    let K = i32(su.cfg.w);
    let cb = (-7509 * r - 25259 * g + 32768 * b) >> 7u;
    let cr = (32768 * r - 29763 * g - 3005 * b) >> 7u;
    let vx = ((cb + K) * i32(size)) / (2 * K);
    let vy = ((K - cr) * i32(size)) / (2 * K);
    if (cb + K >= 0 && K - cr >= 0 && vx < i32(size) && vy < i32(size)) { atomicAdd(&bins[su.at.z + u32(vy) * size + u32(vx)], 1u); }
    atomicAdd(&wh[c.r], 1u);
    atomicAdd(&wh[256u + c.g], 1u);
    atomicAdd(&wh[512u + c.b], 1u);
    atomicAdd(&wh[768u + Y], 1u);
  }
  workgroupBarrier();
  for (var k = li; k < 1024u; k += 256u) {
    let n = atomicLoad(&wh[k]);
    if (n > 0u) { atomicAdd(&bins[su.at.w + k], n); }
  }
}`;
  // The uniform block for the WGSL above (12 u32).
  function uniforms(rect, L, step) {
    return Uint32Array.from([rect.x0, rect.y0, rect.x1, rect.y1, L.cols, L.size, step, K, L.wave, L.parade, L.vector, L.hist]);
  }
  // Workgroups to dispatch for a rect and step.
  const dispatch = (rect, step) => [Math.ceil(Math.ceil((rect.x1 - rect.x0) / step) / 16), Math.ceil(Math.ceil((rect.y1 - rect.y0) / step) / 16)];

  // Views of one result for the panel and the tests.
  function views(bins, L) {
    const plane = L.cols * 256;
    return {
      wave: bins.subarray(L.wave, L.wave + plane),
      parade: [0, 1, 2].map((c) => bins.subarray(L.parade + c * plane, L.parade + (c + 1) * plane)),
      vector: bins.subarray(L.vector, L.vector + L.size * L.size),
      hist: [0, 1, 2, 3].map((c) => bins.subarray(L.hist + c * 256, L.hist + (c + 1) * 256)),
    };
  }
  // The level with the most pixels in each column of a waveform plane (-1 for an empty column): the tests' line.
  function peaks(plane, cols) {
    const out = new Int32Array(cols).fill(-1);
    for (let c = 0; c < cols; c++) {
      let best = 0;
      for (let l = 0; l < 256; l++) { const n = plane[l * cols + c]; if (n > best) { best = n; out[c] = l; } }
    }
    return out;
  }
  // The fullest vectorscope bin: { x, y, n, angle, radius (0..1 of Cb/Cr magnitude) }.
  function vectorPeak(vector, size) {
    let best = -1;
    let at = 0;
    for (let i = 0; i < vector.length; i++) if (vector[i] > best) { best = vector[i]; at = i; }
    const x = (at % size) + 0.5;
    const y = Math.floor(at / size) + 0.5;
    const cb = ((x * 2 * RANGE) / size) - RANGE;
    const cr = RANGE - ((y * 2 * RANGE) / size);
    return { x, y, n: best, angle: angleAt(x, y, size), magnitude: Math.hypot(cb, cr) };
  }

  return { BUDGET, RANGE, UNIT, K, KINDS, BARS, SKIN_DEGREES, layout, frameRect, stepFor, lumaOf, cbOf, crOf, vectorBin, vectorAt, angleAt, chroma, targets, analyze, WGSL, uniforms, dispatch, views, peaks, vectorPeak };
});
