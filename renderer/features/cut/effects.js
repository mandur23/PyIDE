// The effect and transition registry of Nano Studio Cut (docs/cut-architecture.md section 8). Each entry is data: its
// parameters (the effect controls panel builds its UI from them), a WGSL body the compositor wraps into a render
// pipeline, the uniform values for given parameters, a hint for the Canvas 2D fallback, and a CPU reference of the same
// math (Node tests and the app suite compare the GPU output with it).
//
// Pixels inside the engine are linear light, premultiplied alpha, RGBA float. Colors in parameters are sRGB #rrggbb and
// are converted to linear before they reach a shader. An effect works in its clip's own frame (before the clip's
// position, scale and rotation), so a pixel-sized parameter is in sequence pixels at full quality and the compositor
// passes pxScale (texels per sequence pixel) to keep it the same size at 1/2 and 1/4 playback quality.
//
// A video effect's WGSL defines `fn effect(uv: vec2f) -> vec4f`, reading its input with tap(uv) and its parameters
// from u.p[0..3] (16 floats, in the order uniforms() returns them). uniforms() may return several arrays: one pass
// each, every pass reading the one before (the separable blur) with tapOrig(uv) still reading the effect's own input
// (sharpen and glow combine it with a blur), or none (nothing to do). uniforms() and cpu() get info = {width, height,
// pxScale, quality, frame}; frame is the clip-local frame number, so anything random (grain, glitch) is a hash of the
// pixel and the frame and every render of a frame agrees. A transition's WGSL defines `fn transition(uv: vec2f) ->
// vec4f` with tapA(uv), tapB(uv) and the progress u.p[0].x (0 at its start, 1 at its end).
//
// canvas2d(params, info) returns what the Canvas 2D back end can do of an effect (a CSS filter, flips, a crop...);
// `{ skip: true }` says it cannot, and the 2D back end draws the picture without the effect. Transitions have no hint:
// the 2D back end draws push and wipe and a cross dissolve for every other transition.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).effects = api;
})(() => {
  const LUMA = [0.2126, 0.7152, 0.0722];

  // ---- color helpers -------------------------------------------------------------------------------------------------

  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  // #rrggbb or #rrggbbaa -> [r, g, b, a] linear, not premultiplied.
  function hexToLinear(hex, fallback = [0, 0, 0, 1]) {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || ''));
    if (!m) return fallback.slice();
    const n = parseInt(m[1], 16);
    return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255), m[2] ? parseInt(m[2], 16) / 255 : 1];
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // The shaders' toSrgb / toLinear: negative values count as 0.
  const encCpu = (v) => linearToSrgb(Math.max(0, v));
  const decCpu = (v) => srgbToLinear(Math.max(0, v));
  // Randomness that is a function of integers only (pixel, frame), so preview, export and tests agree: the PCG hash in
  // u32 arithmetic, as the shaders' hashU / hash3 compute it, giving 24 bits in [0, 1).
  function hashU(x) {
    const s = (Math.imul(x, 747796405) + 2891336453) >>> 0;
    const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
  }
  const hash3 = (x, y, z) => (hashU((x ^ hashU((y ^ hashU(z >>> 0)) >>> 0)) >>> 0) >>> 8) / 16777216;
  // The clip-local frame an effect is drawn for (info.frame from the compositor, 0 when absent).
  const frameOf = (info) => Math.trunc(info?.frame || 0);

  // ---- WGSL shared by every effect and transition ----------------------------------------------------------------------

  const VERTEX = /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
  var o: VOut;
  o.pos = vec4f(xy, 0.0, 1.0);
  o.uv = vec2f((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return o;
}
const LUMA = vec3f(0.2126, 0.7152, 0.0722);
fn luma(c: vec3f) -> f32 { return dot(c, LUMA); }
fn unpremul(c: vec4f) -> vec3f { if (c.a <= 0.0) { return vec3f(0.0); } return c.rgb / c.a; }
fn inside(uv: vec2f) -> bool { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
`;
  // size = (width, height, 1 / width, 1 / height) of the texture an effect reads and writes. src is the pass's input
  // (the previous pass of the effect), orig the effect's own input (the same texture in its first pass), so a last pass
  // can combine a separable blur with the unblurred picture (sharpen, glow).
  const EFFECT_PRELUDE = /* wgsl */ `
struct FxU { size: vec4f, p: array<vec4f, 4> };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: FxU;
@group(0) @binding(3) var orig: texture_2d<f32>;
${VERTEX}
fn tap(uv: vec2f) -> vec4f { return textureSampleLevel(src, samp, uv, 0.0); }
fn tapOrig(uv: vec2f) -> vec4f { return textureSampleLevel(orig, samp, uv, 0.0); }
// A tap outside the frame is transparent unless edge pixels repeat.
fn tapEdge(uv: vec2f, repeat: bool) -> vec4f { if (!repeat && !inside(uv)) { return vec4f(0.0); } return tap(uv); }
// The integer texel under uv.
fn texel(uv: vec2f) -> vec2i { return vec2i(floor(uv * u.size.xy)); }
fn toSrgb(c: vec3f) -> vec3f { let x = max(c, vec3f(0.0)); return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308)); }
fn toLinear(c: vec3f) -> vec3f { let x = max(c, vec3f(0.0)); return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045)); }
fn hashU(x: u32) -> u32 { let s = x * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn hash3(x: i32, y: i32, z: i32) -> f32 { return f32(hashU(bitcast<u32>(x) ^ hashU(bitcast<u32>(y) ^ hashU(bitcast<u32>(z)))) >> 8u) / 16777216.0; }
`;
  // Every binding is used (an 'auto' pipeline layout leaves out the ones a shader never reads).
  const EFFECT_MAIN = /* wgsl */ `
@fragment fn fs(v: VOut) -> @location(0) vec4f { _ = u.size; _ = textureDimensions(orig); return effect(v.uv); }
`;
  const TRANSITION_PRELUDE = /* wgsl */ `
struct FxU { size: vec4f, p: array<vec4f, 4> };
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: FxU;
${VERTEX}
fn tapA(uv: vec2f) -> vec4f { if (!inside(uv)) { return vec4f(0.0); } return textureSampleLevel(srcA, samp, uv, 0.0); }
fn tapB(uv: vec2f) -> vec4f { if (!inside(uv)) { return vec4f(0.0); } return textureSampleLevel(srcB, samp, uv, 0.0); }
`;
  const TRANSITION_MAIN = /* wgsl */ `
@fragment fn fs(v: VOut) -> @location(0) vec4f { _ = u.size; _ = tapA(v.uv); _ = tapB(v.uv); return transition(v.uv); }
`;

  // ---- CPU images: {w, h, data: Float32Array rgba premultiplied linear} ----------------------------------------------

  function image(w, h, fill) {
    const data = new Float32Array(w * h * 4);
    if (fill) for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
    return { w, h, data };
  }
  const pixel = (img, x, y) => {
    const i = (y * img.w + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  // Bilinear sampling with clamp-to-edge, as the GPU sampler does (texel centers at (i + 0.5) / size).
  function tapCpu(img, u, v) {
    const x = u * img.w - 0.5;
    const y = v * img.h - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const cx = (i) => clamp(i, 0, img.w - 1);
    const cy = (i) => clamp(i, 0, img.h - 1);
    const a = pixel(img, cx(x0), cy(y0));
    const b = pixel(img, cx(x0 + 1), cy(y0));
    const c = pixel(img, cx(x0), cy(y0 + 1));
    const d = pixel(img, cx(x0 + 1), cy(y0 + 1));
    return a.map((_, k) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy);
  }
  const insideUv = (u, v) => u >= 0 && v >= 0 && u <= 1 && v <= 1;
  const tapEdgeCpu = (img, u, v, repeat) => (!repeat && !insideUv(u, v) ? [0, 0, 0, 0] : tapCpu(img, u, v));
  // Runs fn(u, v) -> rgba at every pixel center.
  function mapImage(img, fn) {
    const out = image(img.w, img.h);
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) out.data.set(fn((x + 0.5) / img.w, (y + 0.5) / img.h, x, y), (y * img.w + x) * 4);
    }
    return out;
  }
  // A per-pixel color function (rgba premultiplied -> rgba premultiplied).
  const mapColor = (img, fn) => mapImage(img, (u, v, x, y) => fn(pixel(img, x, y)));
  const unpremulCpu = (c) => (c[3] <= 0 ? [0, 0, 0] : [c[0] / c[3], c[1] / c[3], c[2] / c[3]]);
  const lumaCpu = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

  // ---- parameters --------------------------------------------------------------------------------------------------------

  const num = (id, name, def, min, max, step = 1, extra = {}) => ({ id, name, type: 'number', min, max, step, default: def, keyframable: true, ...extra });
  const pct = (id, name, def, min = 0, max = 100) => ({ id, name, type: 'percent', min, max, step: 1, default: def, keyframable: true });
  const angle = (id, name, def) => ({ id, name, type: 'angle', min: -36000, max: 36000, step: 1, default: def, keyframable: true });
  const color = (id, name, def) => ({ id, name, type: 'color', default: def, keyframable: true });
  const bool = (id, name, def) => ({ id, name, type: 'bool', default: def, keyframable: false });
  const choice = (id, name, def, choices) => ({ id, name, type: 'choice', default: def, choices, keyframable: false });
  const point = (id, name, def) => ({ id, name, type: 'point', default: def, keyframable: true });
  // Lumetri Color's curves (a flat list of points, keyframed as a whole) and its creative LUT (an id of project.luts).
  const curve = (id, name) => ({ id, name, type: 'curve', default: [0, 0, 1, 1], keyframable: true });
  const lutRef = (id, name) => ({ id, name, type: 'lut', default: '', keyframable: false });
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page. Read when used, so a page
  // that loads effects.js alone (the auto color tests) still works.
  const NODE = typeof module === 'object' && !!module.exports;
  const lumetri = () => (NODE ? require('./lumetri.js') : globalThis.Cut.lumetri);

  // ---- video effects ---------------------------------------------------------------------------------------------------

  const VIDEO = [];
  const def = (d) => { VIDEO.push({ kind: 'video', params: [], ...d }); };

  def({
    type: 'flip.horizontal', name: 'Horizontal Flip', category: 'Transform',
    gpu: { wgsl: 'fn effect(uv: vec2f) -> vec4f { return tap(vec2f(1.0 - uv.x, uv.y)); }', uniforms: () => [[]] },
    canvas2d: () => ({ flipX: true }),
    cpu: (img) => mapImage(img, (u, v) => tapCpu(img, 1 - u, v)),
  });
  def({
    type: 'flip.vertical', name: 'Vertical Flip', category: 'Transform',
    gpu: { wgsl: 'fn effect(uv: vec2f) -> vec4f { return tap(vec2f(uv.x, 1.0 - uv.y)); }', uniforms: () => [[]] },
    canvas2d: () => ({ flipY: true }),
    cpu: (img) => mapImage(img, (u, v) => tapCpu(img, u, 1 - v)),
  });

  // Crop with an optional soft edge (feather, in pixels).
  const cropMask = (u, v, p, w, h) => {
    const d = Math.min((u - p.left / 100) * w, (1 - p.right / 100 - u) * w, (v - p.top / 100) * h, (1 - p.bottom / 100 - v) * h);
    if (p.feather <= 0) return d >= 0 ? 1 : 0;
    return clamp(d / p.feather + 0.5, 0, 1);
  };
  def({
    type: 'crop', name: 'Crop', category: 'Transform',
    params: [pct('left', 'Left', 0), pct('top', 'Top', 0), pct('right', 'Right', 0), pct('bottom', 'Bottom', 0), num('feather', 'Edge Feather', 0, 0, 500)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let r = u.p[0];
  let px = uv * u.size.xy;
  let d = min(min(px.x - r.x * u.size.x, (1.0 - r.z) * u.size.x - px.x), min(px.y - r.y * u.size.y, (1.0 - r.w) * u.size.y - px.y));
  let f = u.p[1].x;
  var m = select(0.0, 1.0, d >= 0.0);
  if (f > 0.0) { m = clamp(d / f + 0.5, 0.0, 1.0); }
  return tap(uv) * m;
}`,
      uniforms: (p, info) => [[p.left / 100, p.top / 100, p.right / 100, p.bottom / 100, p.feather * info.pxScale]],
    },
    canvas2d: (p) => ({ crop: [p.top, p.right, p.bottom, p.left] }),
    cpu: (img, p, info) => {
      const q = { ...p, feather: p.feather * info.pxScale };
      return mapImage(img, (u, v, x, y) => {
        const m = cropMask(u, v, q, img.w, img.h);
        return pixel(img, x, y).map((c) => c * m);
      });
    },
  });
  // Fills the empty part of the frame around a smaller clip with its edge pixels stretched outwards. The compositor
  // does it while placing the clip (layer.extend); the pass itself changes nothing.
  def({
    type: 'edge.extend', name: 'Edge Extend', category: 'Transform', layer: { extend: true },
    gpu: { wgsl: 'fn effect(uv: vec2f) -> vec4f { return tap(uv); }', uniforms: () => [] },
    canvas2d: () => ({ extend: true }),
    cpu: (img) => img,
  });

  // Gaussian blur: sigma = blurriness / 3 (the blur reaches about `blurriness` pixels), two separable passes. Wide
  // blurs take 64 taps a side with a stride, using the sampler's interpolation between texels.
  const blurPlan = (sigma) => {
    const reach = sigma * 3;
    const stride = Math.max(1, reach / 64);
    return { stride, n: Math.ceil(reach / stride) };
  };
  function blurCpu(img, dx, dy, sigma, repeat) {
    const { stride, n } = blurPlan(sigma);
    return mapImage(img, (u, v) => {
      const acc = [0, 0, 0, 0];
      let wsum = 0;
      for (let k = -n; k <= n; k++) {
        const o = k * stride;
        const w = Math.exp(-(o * o) / (2 * sigma * sigma));
        const c = tapEdgeCpu(img, u + (dx * o) / img.w, v + (dy * o) / img.h, repeat);
        for (let i = 0; i < 4; i++) acc[i] += c[i] * w;
        wsum += w;
      }
      return acc.map((x) => x / wsum);
    });
  }
  def({
    type: 'blur.gaussian', name: 'Gaussian Blur', category: 'Blur & Sharpen',
    params: [num('blurriness', 'Blurriness', 10, 0, 500, 0.1), choice('dimensions', 'Blur Dimensions', 'both', [['both', 'Horizontal and Vertical'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']]), bool('repeat', 'Repeat Edge Pixels', false)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let q = u.p[0];
  let dir = q.xy * u.size.zw;
  let sigma = q.z;
  let repeat = q.w > 0.5;
  let stride = u.p[1].x;
  let n = i32(u.p[1].y);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let o = f32(k) * stride;
    let w = exp(-(o * o) / (2.0 * sigma * sigma));
    acc += tapEdge(uv + dir * o, repeat) * w;
    wsum += w;
  }
  return acc / wsum;
}`,
      uniforms: (p, info) => {
        const sigma = (p.blurriness * info.pxScale) / 3;
        if (!(sigma > 0.05)) return [];
        const { stride, n } = blurPlan(sigma);
        const r = p.repeat ? 1 : 0;
        const passes = [];
        if (p.dimensions !== 'vertical') passes.push([1, 0, sigma, r, stride, n]);
        if (p.dimensions !== 'horizontal') passes.push([0, 1, sigma, r, stride, n]);
        return passes;
      },
    },
    canvas2d: (p, info) => ({ filter: p.blurriness > 0 ? `blur(${((p.blurriness * info.pxScale) / 3).toFixed(2)}px)` : '' }),
    cpu: (img, p, info) => {
      const sigma = (p.blurriness * info.pxScale) / 3;
      if (!(sigma > 0.05)) return img;
      let out = img;
      if (p.dimensions !== 'vertical') out = blurCpu(out, 1, 0, sigma, p.repeat);
      if (p.dimensions !== 'horizontal') out = blurCpu(out, 0, 1, sigma, p.repeat);
      return out;
    },
  });

  // Directional blur: an even average along a line through the pixel, `length` pixels long, at `direction` degrees
  // clockwise from vertical (0 blurs up and down, 90 left and right).
  const dirPlan = (p, info) => {
    const len = p.length * info.pxScale;
    const a = (p.direction * Math.PI) / 180;
    return { len, dx: Math.sin(a), dy: -Math.cos(a), n: clamp(Math.ceil(len) + 1, 1, 65) };
  };
  def({
    type: 'blur.directional', name: 'Directional Blur', category: 'Blur & Sharpen',
    params: [angle('direction', 'Direction', 0), num('length', 'Blur Length', 10, 0, 1000, 0.1)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let q = u.p[0];
  let n = i32(q.w);
  if (n <= 1) { return tap(uv); }
  var acc = vec4f(0.0);
  for (var k = 0; k < n; k++) {
    let o = (f32(k) / f32(n - 1) - 0.5) * q.z;
    acc += tapEdge(uv + q.xy * o * u.size.zw, false);
  }
  return acc / f32(n);
}`,
      uniforms: (p, info) => {
        const d = dirPlan(p, info);
        return d.len > 0 ? [[d.dx, d.dy, d.len, d.n]] : [];
      },
    },
    canvas2d: (p, info) => ({ filter: p.length > 0 ? `blur(${((p.length * info.pxScale) / 6).toFixed(2)}px)` : '' }),
    cpu: (img, p, info) => {
      const d = dirPlan(p, info);
      if (!(d.len > 0) || d.n <= 1) return img;
      return mapImage(img, (u, v) => {
        const acc = [0, 0, 0, 0];
        for (let k = 0; k < d.n; k++) {
          const o = (k / (d.n - 1) - 0.5) * d.len;
          const c = tapEdgeCpu(img, u + (d.dx * o) / img.w, v + (d.dy * o) / img.h, false);
          for (let i = 0; i < 4; i++) acc[i] += c[i];
        }
        return acc.map((x) => x / d.n);
      });
    },
  });

  // The separable Gaussian of an effect whose last pass combines the blur with the effect's input (u.p[0] = dx, dy,
  // sigma, 1 in the last pass; u.p[1] = stride, taps a side, two values of the effect's own). Sharpen and glow.
  const BLUR_LOOP = /* wgsl */ `
fn blurAlong(uv: vec2f, repeat: bool) -> vec4f {
  let q = u.p[0];
  let dir = q.xy * u.size.zw;
  let stride = u.p[1].x;
  let n = i32(u.p[1].y);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let o = f32(k) * stride;
    let w = exp(-(o * o) / (2.0 * q.z * q.z));
    acc += tapEdge(uv + dir * o, repeat) * w;
    wsum += w;
  }
  return acc / wsum;
}`;
  const blurPasses = (sigma, a, b) => {
    const { stride, n } = blurPlan(sigma);
    return [[1, 0, sigma, 0, stride, n, a, b], [0, 1, sigma, 1, stride, n, a, b]];
  };

  // Sharpen (an unsharp mask): input + amount x (input - Gaussian blur of radius pixels), where the blur's sigma is the
  // radius. Pixels whose difference from the blur is below threshold (luminance x 255) stay as they are.
  const sharpenCpu = (img, p, info) => {
    const sigma = Math.max(p.radius * info.pxScale, 0.05);
    const blur = blurCpu(blurCpu(img, 1, 0, sigma, true), 0, 1, sigma, true);
    const a = p.amount / 100;
    return mapImage(img, (u, v, x, y) => {
      const o = pixel(img, x, y);
      const d = o.map((c, i) => c - pixel(blur, x, y)[i]);
      if (Math.abs(lumaCpu(d)) * 255 < p.threshold) return o;
      const s = o.map((c, i) => c + d[i] * a);
      return [Math.max(0, s[0]), Math.max(0, s[1]), Math.max(0, s[2]), clamp(s[3], 0, 1)];
    });
  };
  def({
    type: 'sharpen', name: 'Sharpen', category: 'Blur & Sharpen',
    params: [pct('amount', 'Amount', 100, 0, 500), num('radius', 'Radius', 1.5, 0.1, 50, 0.1), num('threshold', 'Threshold', 0, 0, 255)],
    gpu: {
      wgsl: /* wgsl */ `${BLUR_LOOP}
fn effect(uv: vec2f) -> vec4f {
  let b = blurAlong(uv, true);
  if (u.p[0].w < 0.5) { return b; }
  let o = tapOrig(uv);
  let d = o - b;
  if (abs(luma(d.rgb)) * 255.0 < u.p[1].w) { return o; }
  let s = o + d * u.p[1].z;
  return vec4f(max(s.rgb, vec3f(0.0)), clamp(s.a, 0.0, 1.0));
}`,
      uniforms: (p, info) => (p.amount > 0 ? blurPasses(Math.max(p.radius * info.pxScale, 0.05), p.amount / 100, p.threshold) : []),
    },
    // Canvas 2D has no sharpening filter: the 2D back end draws the picture without it.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p, info) => (p.amount > 0 ? sharpenCpu(img, p, info) : img),
  });

  // Mosaic: blocks across and down; each block is the average of a 4 x 4 grid of points inside it, or its center
  // pixel with sharp colors.
  def({
    type: 'mosaic', name: 'Mosaic', category: 'Stylize',
    params: [num('horizontal', 'Horizontal Blocks', 10, 1, 4000), num('vertical', 'Vertical Blocks', 10, 1, 4000), bool('sharp', 'Sharp Colors', false)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let blocks = max(floor(u.p[0].xy), vec2f(1.0));
  let id = min(floor(uv * blocks), blocks - 1.0);
  if (u.p[0].z > 0.5) { return tap((id + 0.5) / blocks); }
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) { acc += tap((id + (vec2f(f32(i), f32(j)) + 0.5) / 4.0) / blocks); }
  }
  return acc / 16.0;
}`,
      uniforms: (p) => [[p.horizontal, p.vertical, p.sharp ? 1 : 0, 0]],
    },
    canvas2d: (p) => ({ mosaic: [Math.max(1, Math.floor(p.horizontal)), Math.max(1, Math.floor(p.vertical))] }),
    cpu: (img, p) => {
      const bx = Math.max(1, Math.floor(p.horizontal));
      const by = Math.max(1, Math.floor(p.vertical));
      return mapImage(img, (u, v) => {
        const ix = Math.min(Math.floor(u * bx), bx - 1);
        const iy = Math.min(Math.floor(v * by), by - 1);
        if (p.sharp) return tapCpu(img, (ix + 0.5) / bx, (iy + 0.5) / by);
        const acc = [0, 0, 0, 0];
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 4; i++) {
            const c = tapCpu(img, (ix + (i + 0.5) / 4) / bx, (iy + (j + 0.5) / 4) / by);
            for (let k = 0; k < 4; k++) acc[k] += c[k];
          }
        }
        return acc.map((x) => x / 16);
      });
    },
  });

  // Black & White: Rec. 709 luminance of the linear color.
  def({
    type: 'color.bw', name: 'Black & White', category: 'Color Correction',
    gpu: { wgsl: 'fn effect(uv: vec2f) -> vec4f { let c = tap(uv); return vec4f(vec3f(luma(c.rgb)), c.a); }', uniforms: () => [[]] },
    canvas2d: () => ({ filter: 'grayscale(1)' }),
    cpu: (img) => mapColor(img, (c) => { const y = lumaCpu(c); return [y, y, y, c[3]]; }),
  });

  // Tint: luminance mapped from the black color to the white color, mixed in by amount.
  def({
    type: 'color.tint', name: 'Tint', category: 'Color Correction',
    params: [color('black', 'Map Black To', '#000000'), color('white', 'Map White To', '#ffffff'), pct('amount', 'Amount to Tint', 100)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let rgb = unpremul(c);
  let t = mix(u.p[0].rgb, u.p[1].rgb, clamp(luma(rgb), 0.0, 1.0));
  return vec4f(mix(rgb, t, u.p[0].w) * c.a, c.a);
}`,
      uniforms: (p) => {
        const b = hexToLinear(p.black);
        const w = hexToLinear(p.white);
        return [[b[0], b[1], b[2], p.amount / 100, w[0], w[1], w[2], 0]];
      },
    },
    canvas2d: (p) => ({ filter: p.amount > 0 ? `grayscale(${clamp(p.amount / 100, 0, 1)}) sepia(${clamp(p.amount / 200, 0, 1)})` : '' }),
    cpu: (img, p) => {
      const b = hexToLinear(p.black);
      const w = hexToLinear(p.white);
      const a = p.amount / 100;
      return mapColor(img, (c) => {
        const rgb = unpremulCpu(c);
        const y = clamp(lumaCpu(rgb), 0, 1);
        return [0, 1, 2].map((i) => (rgb[i] + (b[i] + (w[i] - b[i]) * y - rgb[i]) * a) * c[3]).concat(c[3]);
      });
    },
  });

  // Brightness & Contrast in linear light: brightness is a gain of 2^(b / 50) (two stops at 100); contrast is a power
  // around middle gray, x -> 0.18 * (x / 0.18)^(1 + c / 100) (-100 makes every channel middle gray).
  const bcChannel = (x, gain, k) => {
    const v = x * gain;
    return k === 1 || v <= 0 ? v : 0.18 * (v / 0.18) ** k;
  };
  def({
    type: 'color.brightnessContrast', name: 'Brightness & Contrast', category: 'Color Correction',
    params: [num('brightness', 'Brightness', 0, -100, 100), num('contrast', 'Contrast', 0, -100, 100)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  var rgb = unpremul(c) * u.p[0].x;
  let k = u.p[0].y;
  if (k != 1.0) { rgb = select(rgb, 0.18 * pow(max(rgb, vec3f(1e-12)) / 0.18, vec3f(k)), rgb > vec3f(0.0)); }
  return vec4f(rgb * c.a, c.a);
}`,
      uniforms: (p) => [[2 ** (p.brightness / 50), 1 + p.contrast / 100, 0, 0]],
    },
    canvas2d: (p) => ({ filter: `brightness(${(2 ** (p.brightness / 50)).toFixed(4)}) contrast(${(1 + p.contrast / 100).toFixed(4)})` }),
    cpu: (img, p) => {
      const gain = 2 ** (p.brightness / 50);
      const k = 1 + p.contrast / 100;
      return mapColor(img, (c) => unpremulCpu(c).map((x) => bcChannel(x, gain, k) * c[3]).concat(c[3]));
    },
  });

  // The color panel's basic correction (features section 10), all in linear light, in this order:
  // 1. white balance: channel gains [2^(T/2 + M/4), 2^(-M/2), 2^(-T/2 + M/4)] for temperature T and tint M in -1..1
  //    (at 100, red and blue are a stop apart), divided by their luminance so a neutral gray keeps its brightness
  //    (warm: red up, blue down; tint +: magenta);
  // 2. exposure: x 2^stops; 3. contrast: x -> 0.18 * (x / 0.18)^(1 + c) per channel;
  // 4. tone: on L = Y^(1/2.2), L += (shadows * 6.75 L (1-L)^2 + highlights * 6.75 L^2 (1-L) + whites * L^3 +
  //    blacks * (1-L)^3) / 4, then the color is scaled by the new luminance over the old (hue holds);
  // 5. vibrance: chroma x (1 + v (1 - S)) with S = (max - min) / max, so dull colors gain most;
  // 6. saturation: chroma x s; chroma is the distance from the luminance gray. Negative results clamp to 0.
  function basicPlan(p) {
    const T = p.temperature / 100;
    const M = p.tint / 100;
    const g = [2 ** (T / 2 + M / 4), 2 ** (-M / 2), 2 ** (-T / 2 + M / 4)];
    const n = g[0] * LUMA[0] + g[1] * LUMA[1] + g[2] * LUMA[2];
    return {
      gain: g.map((x) => (x / n) * 2 ** p.exposure),
      k: 1 + p.contrast / 100,
      tone: [p.shadows / 100, p.highlights / 100, p.whites / 100, p.blacks / 100],
      vibrance: p.vibrance / 100,
      saturation: p.saturation / 100,
    };
  }
  function basicPixel(rgb, q) {
    let c = rgb.map((x, i) => x * q.gain[i]);
    if (q.k !== 1) c = c.map((x) => (x > 0 ? 0.18 * (x / 0.18) ** q.k : x));
    const [s, h, w, b] = q.tone;
    if (s || h || w || b) {
      const y = lumaCpu(c);
      const L = Math.max(y, 0) ** (1 / 2.2);
      const d = (s * 6.75 * L * (1 - L) ** 2 + h * 6.75 * L * L * (1 - L) + w * L ** 3 + b * (1 - L) ** 3) / 4;
      const y2 = Math.max(L + d, 0) ** 2.2;
      c = y > 1e-6 ? c.map((x) => (x * y2) / y) : c.map((x) => x + y2 - Math.max(y, 0));
    }
    let y = lumaCpu(c);
    if (q.vibrance) {
      const mx = Math.max(c[0], c[1], c[2]);
      const mn = Math.min(c[0], c[1], c[2]);
      const S = mx > 0 ? (mx - mn) / mx : 0;
      const f = 1 + q.vibrance * (1 - S);
      c = c.map((x) => y + (x - y) * f);
      y = lumaCpu(c);
    }
    if (q.saturation !== 1) c = c.map((x) => y + (x - y) * q.saturation);
    return c.map((x) => Math.max(0, x));
  }
  // Lumetri Color: the basic correction above, then (lumetri.js) the creative LUT, the RGB curves and the HSL secondary,
  // one pass each and only the sections that change something (u.p[3].w says which: 0 basic, 1 LUT, 2 curves, 3 HSL,
  // 4 HSL showing its mask). The LUT is a 3D texture (binding 4) and the curves a TABLE x 1 texture (binding 5),
  // both rgba16float read with textureLoad and interpolated here, as the CPU reference does (the sampler's 8-bit
  // weights would differ). The panel (ui-color.js) groups the parameters by `group`.
  const basicNeutral = (p) => !p.temperature && !p.tint && !p.exposure && !p.contrast && !p.highlights && !p.shadows && !p.whites && !p.blacks && p.saturation === 100 && !p.vibrance;
  const grouped = (group, list) => list.map((d) => ({ ...d, group }));
  function lumetriStages(p, info) {
    const L = lumetri();
    const out = [];
    if (!basicNeutral(p)) { const q = basicPlan(p); out.push({ pass: [...q.gain, q.k, ...q.tone, q.vibrance, q.saturation, 0, 0, 0, 0, 0, 0], cpu: (rgb) => basicPixel(rgb, q) }); }
    const lut = info?.assets?.lut || null;
    const k = clamp((p.lutIntensity ?? 100) / 100, 0, 1);
    if (lut && k > 0) out.push({ pass: [k, lut.size, 0, 0, ...lut.min, 0, ...lut.max, 0, 0, 0, 0, 1], cpu: (rgb) => L.lutPixel(rgb, lut, k) });
    if (!L.curvesIdentity(p)) { const t = L.curvesTable(p); out.push({ pass: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], cpu: (rgb) => L.curvesPixel(rgb, t) }); }
    const h = L.hslPlan(p);
    if (h.active) out.push({ pass: [h.hue, h.half, h.hueSoft, ...h.sat, ...h.lum, ...h.gain, h.k, h.saturation, h.shift, h.mask ? 4 : 3], cpu: (rgb) => L.hslPixel(rgb, h) });
    return out;
  }
  def({
    type: 'color.basic', name: 'Lumetri Color', category: 'Color Correction',
    params: [
      ...grouped('Basic Correction', [
        num('temperature', 'Temperature', 0, -100, 100), num('tint', 'Tint', 0, -100, 100),
        num('exposure', 'Exposure', 0, -4, 4, 0.01), num('contrast', 'Contrast', 0, -100, 100),
        num('highlights', 'Highlights', 0, -100, 100), num('shadows', 'Shadows', 0, -100, 100),
        num('whites', 'Whites', 0, -100, 100), num('blacks', 'Blacks', 0, -100, 100),
        pct('saturation', 'Saturation', 100, 0, 200), num('vibrance', 'Vibrance', 0, -100, 100),
      ]),
      ...grouped('Creative', [lutRef('lut', 'Look'), pct('lutIntensity', 'Intensity', 100)]),
      ...grouped('Curves', [curve('curveMaster', 'Master Curve'), curve('curveRed', 'Red Curve'), curve('curveGreen', 'Green Curve'), curve('curveBlue', 'Blue Curve')]),
      ...grouped('HSL Secondary', [
        num('hslHue', 'Hue Center', 0, 0, 360, 1, { unit: '°' }), num('hslHueRange', 'Hue Range', 360, 0, 360, 1, { unit: '°' }), num('hslHueSoft', 'Hue Softness', 30, 0, 180, 1, { unit: '°' }),
        pct('hslSatLow', 'Saturation Low', 0), pct('hslSatHigh', 'Saturation High', 100), pct('hslSatSoft', 'Saturation Softness', 10),
        pct('hslLumLow', 'Luma Low', 0), pct('hslLumHigh', 'Luma High', 100), pct('hslLumSoft', 'Luma Softness', 10),
        bool('hslMask', 'Show Mask', false),
        num('hslTemperature', 'Temperature', 0, -100, 100), num('hslTint', 'Tint', 0, -100, 100), num('hslContrast', 'Contrast', 0, -100, 100),
        pct('hslSaturation', 'Saturation', 100, 0, 200), num('hslHueShift', 'Hue Shift', 0, -180, 180, 1, { unit: '°' }),
      ]),
    ],
    // The LUT the Look names, from project.luts (compositor.planItem asks; the result reaches uniforms, textures and
    // cpu as info.assets).
    assets: (project, p) => ({ lut: lumetri().lutOf(project, p.lut) }),
    gpu: {
      bindings: { 4: '3d', 5: '2d' },
      wgsl: /* wgsl */ `
@group(0) @binding(4) var lutTex: texture_3d<f32>;
@group(0) @binding(5) var curveTex: texture_2d<f32>;
fn lutTap(r: i32, g: i32, b: i32) -> vec3f { return textureLoad(lutTex, vec3i(r, g, b), 0).rgb; }
fn lutStage(c4: vec4f) -> vec4f {
  let q = u.p[0];
  let n = i32(q.y);
  let s = toSrgb(unpremul(c4));
  let x = clamp((s - u.p[1].xyz) / (u.p[2].xyz - u.p[1].xyz), vec3f(0.0), vec3f(1.0)) * f32(n - 1);
  let i = min(vec3i(floor(x)), vec3i(n - 2));
  let f = x - vec3f(i);
  let c00 = mix(lutTap(i.x, i.y, i.z), lutTap(i.x + 1, i.y, i.z), f.x);
  let c10 = mix(lutTap(i.x, i.y + 1, i.z), lutTap(i.x + 1, i.y + 1, i.z), f.x);
  let c01 = mix(lutTap(i.x, i.y, i.z + 1), lutTap(i.x + 1, i.y, i.z + 1), f.x);
  let c11 = mix(lutTap(i.x, i.y + 1, i.z + 1), lutTap(i.x + 1, i.y + 1, i.z + 1), f.x);
  let v = mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
  return vec4f(toLinear(mix(s, v, q.x)) * c4.a, c4.a);
}
fn curveAt(x: f32, ch: u32) -> f32 {
  let n = textureDimensions(curveTex).x;
  let f = clamp(x, 0.0, 1.0) * f32(n - 1u);
  let i = min(u32(floor(f)), n - 2u);
  let t = f - f32(i);
  return mix(textureLoad(curveTex, vec2u(i, 0u), 0)[ch], textureLoad(curveTex, vec2u(i + 1u, 0u), 0)[ch], t);
}
fn curvesStage(c4: vec4f) -> vec4f {
  let s = toSrgb(unpremul(c4));
  let m = vec3f(curveAt(s.r, 0u), curveAt(s.g, 0u), curveAt(s.b, 0u));
  return vec4f(toLinear(vec3f(curveAt(m.r, 1u), curveAt(m.g, 2u), curveAt(m.b, 3u))) * c4.a, c4.a);
}
fn hueOf(s: vec3f) -> f32 {
  let mx = max(s.r, max(s.g, s.b));
  let C = mx - min(s.r, min(s.g, s.b));
  if (C <= 0.0) { return 0.0; }
  var h = 0.0;
  if (mx == s.r) { h = (s.g - s.b) / C; if (h < 0.0) { h = h + 6.0; } }
  else if (mx == s.g) { h = (s.b - s.r) / C + 2.0; }
  else { h = (s.r - s.g) / C + 4.0; }
  return h / 6.0;
}
fn fallW(x: f32, e: f32, w: f32) -> f32 { return 1.0 - smoothstep(e, e + max(w, 1e-4), x); }
fn bandW(x: f32, lo: f32, hi: f32, w: f32) -> f32 { let ww = max(w, 1e-4); return smoothstep(lo - ww, lo, x) * fallW(x, hi, ww); }
fn hueRotate(c: vec3f, deg: f32) -> vec3f {
  let a = radians(deg);
  let co = cos(a);
  let si = sin(a);
  let r0 = vec3f(0.213 + co * 0.787 - si * 0.213, 0.715 - co * 0.715 - si * 0.715, 0.072 - co * 0.072 + si * 0.928);
  let r1 = vec3f(0.213 - co * 0.213 + si * 0.143, 0.715 + co * 0.285 + si * 0.14, 0.072 - co * 0.072 - si * 0.283);
  let r2 = vec3f(0.213 - co * 0.213 - si * 0.787, 0.715 - co * 0.715 + si * 0.715, 0.072 + co * 0.928 + si * 0.072);
  return vec3f(dot(r0, c), dot(r1, c), dot(r2, c));
}
fn hslStage(c4: vec4f, showMask: bool) -> vec4f {
  let q0 = u.p[0];
  let q1 = u.p[1];
  let q2 = u.p[2];
  let q3 = u.p[3];
  let rgb = unpremul(c4);
  let s = clamp(toSrgb(rgb), vec3f(0.0), vec3f(1.0));
  let C = max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b));
  let dh = abs(fract(hueOf(s) - q0.x + 0.5) - 0.5);
  let m = fallW(dh, q0.y, q0.z) * bandW(C, q0.w, q1.x, q1.y) * bandW(luma(s), q1.z, q1.w, q2.x);
  if (showMask) { let g = vec3f(0.2158605); return vec4f(mix(g, rgb, m) * c4.a, c4.a); }
  var c = rgb * q2.yzw;
  if (q3.x != 1.0) { c = select(c, 0.18 * pow(max(c, vec3f(1e-12)) / 0.18, vec3f(q3.x)), c > vec3f(0.0)); }
  if (q3.z != 0.0) { c = hueRotate(c, q3.z); }
  let y = luma(c);
  c = max(vec3f(y) + (c - vec3f(y)) * q3.y, vec3f(0.0));
  return vec4f(mix(rgb, c, m) * c4.a, c4.a);
}
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let st = u.p[3].w;
  if (st < 0.5) { return basicStage(c); }
  if (st < 1.5) { return lutStage(c); }
  if (st < 2.5) { return curvesStage(c); }
  return hslStage(c, st > 3.5);
}
fn basicStage(src4: vec4f) -> vec4f {
  var c = unpremul(src4) * u.p[0].xyz;
  let k = u.p[0].w;
  if (k != 1.0) { c = select(c, 0.18 * pow(max(c, vec3f(1e-12)) / 0.18, vec3f(k)), c > vec3f(0.0)); }
  let t = u.p[1];
  if (any(t != vec4f(0.0))) {
    let y = luma(c);
    let L = pow(max(y, 0.0), 1.0 / 2.2);
    let d = (t.x * 6.75 * L * (1.0 - L) * (1.0 - L) + t.y * 6.75 * L * L * (1.0 - L) + t.z * L * L * L + t.w * (1.0 - L) * (1.0 - L) * (1.0 - L)) / 4.0;
    let y2 = pow(max(L + d, 0.0), 2.2);
    if (y > 1e-6) { c = c * (y2 / y); } else { c = c + vec3f(y2 - max(y, 0.0)); }
  }
  var y = luma(c);
  let vib = u.p[2].x;
  if (vib != 0.0) {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let S = select(0.0, (mx - mn) / mx, mx > 0.0);
    c = vec3f(y) + (c - vec3f(y)) * (1.0 + vib * (1.0 - S));
    y = luma(c);
  }
  let sat = u.p[2].y;
  if (sat != 1.0) { c = vec3f(y) + (c - vec3f(y)) * sat; }
  c = max(c, vec3f(0.0));
  return vec4f(c * src4.a, src4.a);
}`,
      uniforms: (p, info) => lumetriStages(p, info).map((s) => s.pass),
      // binding -> { key (the compositor keeps one texture per key), dim, size, data() -> rgba half floats } | null
      textures: (p, info) => {
        const L = lumetri();
        const lut = info?.assets?.lut || null;
        return {
          4: lut && (p.lutIntensity ?? 100) > 0 ? { key: `lut:${lut.id}`, dim: '3d', size: [lut.size, lut.size, lut.size], data: () => L.lutHalf(lut) } : null,
          5: L.curvesIdentity(p) ? null : { key: L.curveKey(p), dim: '2d', size: [L.TABLE, 1], data: () => L.curvesHalf(p) },
        };
      },
    },
    // Canvas 2D does the basic correction through CSS filters; it has no LUT, curves or HSL secondary.
    canvas2d: (p) => {
      const parts = [];
      if (p.exposure) parts.push(`brightness(${(2 ** (p.exposure / 2.2)).toFixed(4)})`);
      if (p.contrast) parts.push(`contrast(${(1 + p.contrast / 100).toFixed(4)})`);
      if (p.saturation !== 100 || p.vibrance) parts.push(`saturate(${Math.max(0, p.saturation / 100 + p.vibrance / 200).toFixed(4)})`);
      if (p.temperature > 0) parts.push(`sepia(${clamp(p.temperature / 300, 0, 1).toFixed(4)})`);
      return { filter: parts.join(' ') };
    },
    cpu: (img, p, info) => {
      const stages = lumetriStages(p, info);
      if (!stages.length) return img;
      return mapColor(img, (c) => {
        let rgb = unpremulCpu(c);
        for (const s of stages) rgb = s.cpu(rgb);
        return rgb.map((x) => x * c[3]).concat(c[3]);
      });
    },
  });

  // Invert: each channel's sRGB value v becomes 1 - v (in sRGB values, as CSS invert() does, so middle gray stays
  // middle gray), mixed in by amount.
  def({
    type: 'color.invert', name: 'Invert', category: 'Color Correction',
    params: [pct('amount', 'Amount', 100)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let s = clamp(toSrgb(unpremul(c)), vec3f(0.0), vec3f(1.0));
  return vec4f(toLinear(mix(s, vec3f(1.0) - s, u.p[0].x)) * c.a, c.a);
}`,
      uniforms: (p) => (p.amount > 0 ? [[p.amount / 100]] : []),
    },
    canvas2d: (p) => ({ filter: p.amount > 0 ? `invert(${clamp(p.amount / 100, 0, 1)})` : '' }),
    cpu: (img, p) => {
      if (!(p.amount > 0)) return img;
      const a = p.amount / 100;
      return mapColor(img, (c) => unpremulCpu(c).map((x) => {
        const s = clamp(encCpu(x), 0, 1);
        return decCpu(s * (1 - a) + (1 - s) * a) * c[3];
      }).concat(c[3]));
    },
  });

  // Hue Shift: the hue-rotate matrix of CSS filters (luminance and grays kept, colors turned around the gray axis),
  // applied to the linear color; negative results clamp to 0.
  function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
      [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
      [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ];
  }
  const hueOff = (p) => ((p.hue % 360) + 360) % 360 === 0;
  def({
    type: 'color.hue', name: 'Hue Shift', category: 'Color Correction',
    params: [angle('hue', 'Hue', 0)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let rgb = vec3f(dot(u.p[0].xyz, c.rgb), dot(u.p[1].xyz, c.rgb), dot(u.p[2].xyz, c.rgb));
  return vec4f(max(rgb, vec3f(0.0)), c.a);
}`,
      uniforms: (p) => (hueOff(p) ? [] : [hueMatrix(p.hue).flatMap((row) => [...row, 0])]),
    },
    canvas2d: (p) => ({ filter: hueOff(p) ? '' : `hue-rotate(${p.hue}deg)` }),
    cpu: (img, p) => {
      if (hueOff(p)) return img;
      const m = hueMatrix(p.hue);
      return mapColor(img, (c) => m.map((row) => Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])).concat(c[3]));
    },
  });

  // Vignette: darkens (amount < 0) or lightens (amount > 0) toward the edges. d is the distance from the center over
  // the distance to a corner, the frame's ellipse at roundness -100 and a circle at 100; the edge of the effect sits at
  // d = midpoint and is feather wide. center is in pixels from the clip's center.
  function vignettePlan(p, info) {
    const w = info.width;
    const h = info.height;
    return {
      cx: 0.5 + (p.center[0] * info.pxScale) / w,
      cy: 0.5 + (p.center[1] * info.pxScale) / h,
      aspect: w / h,
      round: (p.roundness + 100) / 200,
      mid: p.midpoint / 100,
      feather: Math.max(p.feather / 100, 1e-3),
      amount: p.amount / 100,
    };
  }
  function vignetteMask(q, u, v) {
    let x = (u - q.cx) * 2;
    let y = (v - q.cy) * 2;
    const r = Math.max(q.aspect, 1 / q.aspect);
    if (q.aspect >= 1) x *= 1 + (r - 1) * q.round;
    else y *= 1 + (r - 1) * q.round;
    const corner = Math.SQRT2 * (1 + (r - 1) * q.round);
    const d = Math.hypot(x, y) / corner;
    return smoothstep(q.mid - q.feather / 2, q.mid + q.feather / 2, d);
  }
  def({
    type: 'vignette', name: 'Vignette', category: 'Stylize',
    params: [num('amount', 'Amount', -50, -100, 100), point('center', 'Center', [0, 0]), num('midpoint', 'Midpoint', 60, 0, 100), num('roundness', 'Roundness', 0, -100, 100), num('feather', 'Feather', 50, 0, 100)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let q = u.p[0];
  let r = u.p[1];
  let big = max(q.z, 1.0 / q.z);
  var x = (uv.x - q.x) * 2.0;
  var y = (uv.y - q.y) * 2.0;
  let s = 1.0 + (big - 1.0) * q.w;
  if (q.z >= 1.0) { x = x * s; } else { y = y * s; }
  let d = length(vec2f(x, y)) / (sqrt(2.0) * s);
  let m = smoothstep(r.x - r.y / 2.0, r.x + r.y / 2.0, d);
  let a = r.z;
  if (a < 0.0) { return vec4f(c.rgb * (1.0 + a * m), c.a); }
  return vec4f(c.rgb + (vec3f(c.a) - c.rgb) * a * m, c.a);
}`,
      uniforms: (p, info) => {
        const q = vignettePlan(p, info);
        return q.amount ? [[q.cx, q.cy, q.aspect, q.round, q.mid, q.feather, q.amount, 0]] : [];
      },
    },
    canvas2d: (p) => ({ vignette: p.amount / 100 }),
    cpu: (img, p, info) => {
      const q = vignettePlan(p, info);
      if (!q.amount) return img;
      return mapImage(img, (u, v, x, y) => {
        const c = pixel(img, x, y);
        const m = vignetteMask(q, u, v);
        if (q.amount < 0) return [c[0] * (1 + q.amount * m), c[1] * (1 + q.amount * m), c[2] * (1 + q.amount * m), c[3]];
        return [0, 1, 2].map((i) => c[i] + (c[3] - c[i]) * q.amount * m).concat(c[3]);
      });
    },
  });

  // Glow: the parts brighter than threshold (luminance of the linear color, a soft knee 0.1 wide) blurred by a
  // Gaussian reaching about radius pixels (sigma = radius / 3, edges not repeated) and added onto the picture times
  // intensity; the glow's own coverage extends the alpha.
  const glowCpu = (img, p, info) => {
    const sigma = Math.max((p.radius * info.pxScale) / 3, 0.05);
    const t = p.threshold / 100;
    const bright = mapColor(img, (c) => c.map((x) => x * smoothstep(t, t + 0.1, lumaCpu(unpremulCpu(c)))));
    const g = blurCpu(blurCpu(bright, 1, 0, sigma, false), 0, 1, sigma, false);
    const k = p.intensity / 100;
    return mapImage(img, (u, v, x, y) => {
      const o = pixel(img, x, y);
      const gi = pixel(g, x, y).map((c) => c * k);
      return [o[0] + gi[0], o[1] + gi[1], o[2] + gi[2], o[3] + (1 - o[3]) * clamp(gi[3], 0, 1)];
    });
  };
  def({
    type: 'glow', name: 'Glow', category: 'Stylize',
    params: [pct('threshold', 'Threshold', 60), num('radius', 'Radius', 20, 0, 500, 0.1), pct('intensity', 'Intensity', 100, 0, 400)],
    gpu: {
      wgsl: /* wgsl */ `${BLUR_LOOP}
fn effect(uv: vec2f) -> vec4f {
  if (u.p[0].w > 1.5) { let c = tap(uv); return c * smoothstep(u.p[1].z, u.p[1].z + 0.1, luma(unpremul(c))); }
  let g = blurAlong(uv, false);
  if (u.p[0].w < 0.5) { return g; }
  let o = tapOrig(uv);
  let gi = g * u.p[1].w;
  return vec4f(o.rgb + gi.rgb, o.a + (1.0 - o.a) * clamp(gi.a, 0.0, 1.0));
}`,
      // A bright pass (u.p[0].w = 2), then the blur's two.
      uniforms: (p, info) => {
        if (!(p.intensity > 0)) return [];
        const passes = blurPasses(Math.max((p.radius * info.pxScale) / 3, 0.05), p.threshold / 100, p.intensity / 100);
        return [[0, 0, 1, 2, 1, 0, p.threshold / 100, p.intensity / 100], ...passes];
      },
    },
    // Canvas 2D cannot blur only the bright parts: the 2D back end draws the picture without the glow.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p, info) => (p.intensity > 0 ? glowCpu(img, p, info) : img),
  });

  // Posterize: each channel's sRGB value rounded to one of `levels` even steps from 0 to 1.
  const posterLevels = (p) => Math.max(2, Math.round(p.levels));
  def({
    type: 'posterize', name: 'Posterize', category: 'Stylize',
    params: [num('levels', 'Levels', 6, 2, 64)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let n = u.p[0].x - 1.0;
  let s = clamp(toSrgb(unpremul(c)), vec3f(0.0), vec3f(1.0));
  return vec4f(toLinear(floor(s * n + 0.5) / n) * c.a, c.a);
}`,
      uniforms: (p) => [[posterLevels(p)]],
    },
    // Canvas 2D filters cannot quantize: the 2D back end draws the picture without it.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p) => {
      const n = posterLevels(p) - 1;
      return mapColor(img, (c) => unpremulCpu(c).map((x) => decCpu(Math.floor(clamp(encCpu(x), 0, 1) * n + 0.5) / n) * c[3]).concat(c[3]));
    },
  });

  // Chromatic Aberration: red taken from one side and blue from the other, green in place. Radial: like a lens, the
  // split grows from nothing at the center to `amount` pixels at the corners; Linear: `amount` pixels everywhere, at
  // `direction` degrees clockwise from vertical (90 splits left and right). Edge pixels repeat.
  function chromaPlan(p, info) {
    const amt = p.amount * info.pxScale;
    if (p.mode === 'linear') {
      const a = (p.direction * Math.PI) / 180;
      return { radial: false, k: 0, ox: (Math.sin(a) * amt) / info.width, oy: (-Math.cos(a) * amt) / info.height };
    }
    return { radial: true, k: amt / (0.5 * Math.hypot(info.width, info.height)), ox: 0, oy: 0 };
  }
  def({
    type: 'chromatic', name: 'Chromatic Aberration', category: 'Stylize',
    params: [num('amount', 'Amount', 4, 0, 200, 0.1), choice('mode', 'Mode', 'radial', [['radial', 'Radial'], ['linear', 'Linear']]), angle('direction', 'Direction', 90)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let q = u.p[0];
  var off = q.zw;
  if (q.x > 0.5) { off = (uv - 0.5) * q.y; }
  let r = tap(uv + off);
  let g = tap(uv);
  let b = tap(uv - off);
  return vec4f(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`,
      uniforms: (p, info) => {
        if (!(p.amount > 0)) return [];
        const q = chromaPlan(p, info);
        return [[q.radial ? 1 : 0, q.k, q.ox, q.oy]];
      },
    },
    // Canvas 2D cannot move channels apart: the 2D back end draws the picture without it.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p, info) => {
      if (!(p.amount > 0)) return img;
      const q = chromaPlan(p, info);
      return mapImage(img, (u, v) => {
        const ox = q.radial ? (u - 0.5) * q.k : q.ox;
        const oy = q.radial ? (v - 0.5) * q.k : q.oy;
        const r = tapCpu(img, u + ox, v + oy);
        const g = tapCpu(img, u, v);
        const b = tapCpu(img, u - ox, v - oy);
        return [r[0], g[1], b[2], Math.max(r[3], g[3], b[3])];
      });
    },
  });

  // Glitch: the picture cut into bands `bandHeight` pixels tall; for `hold` frames at a time, each band is picked with
  // a chance of amount and moved sideways by up to `shift` pixels (wrapping around), its red and blue split by 30% of
  // the move. Which bands move and how far is a hash of the band and the frame, so every render of a frame agrees.
  function glitchPlan(p, info) {
    return { amount: Math.fround(p.amount / 100), shift: (p.shift * info.pxScale) / info.width, band: Math.max(p.bandHeight * info.pxScale, 1), step: Math.floor(frameOf(info) / Math.max(1, Math.round(p.hold))) };
  }
  def({
    type: 'glitch', name: 'Glitch', category: 'Stylize',
    params: [pct('amount', 'Amount', 30), num('shift', 'Shift', 40, 0, 1000), num('bandHeight', 'Band Height', 16, 1, 500), num('hold', 'Hold Frames', 2, 1, 60, 1, { keyframable: false })],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let q = u.p[0];
  let band = i32(floor((f32(texel(uv).y) + 0.5) / q.z));
  let st = i32(q.w);
  if (hash3(band, st, 1) >= q.x) { return tap(uv); }
  let o = (hash3(band, st, 2) * 2.0 - 1.0) * q.y;
  let c = o * 0.3;
  let r = tap(vec2f(fract(uv.x + o + c), uv.y));
  let g = tap(vec2f(fract(uv.x + o), uv.y));
  let b = tap(vec2f(fract(uv.x + o - c), uv.y));
  return vec4f(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`,
      uniforms: (p, info) => {
        if (!(p.amount > 0 && p.shift > 0)) return [];
        const q = glitchPlan(p, info);
        return [[q.amount, q.shift, q.band, q.step]];
      },
    },
    // Canvas 2D has no per-band displacement: the 2D back end draws the picture without it.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p, info) => {
      if (!(p.amount > 0 && p.shift > 0)) return img;
      const q = glitchPlan(p, info);
      const fract = (x) => x - Math.floor(x);
      return mapImage(img, (u, v, x, y) => {
        const band = Math.floor((y + 0.5) / q.band);
        if (hash3(band, q.step, 1) >= q.amount) return pixel(img, x, y);
        const o = (hash3(band, q.step, 2) * 2 - 1) * q.shift;
        const c = o * 0.3;
        const r = tapCpu(img, fract(u + o + c), v);
        const g = tapCpu(img, fract(u + o), v);
        const b = tapCpu(img, fract(u + o - c), v);
        return [r[0], g[1], b[2], Math.max(r[3], g[3], b[3])];
      });
    },
  });

  // Lens Distortion: each pixel shows the picture at center + d (1 + k r^2), r the distance from the center over the
  // distance to a corner and k = curvature / 200. Positive curvature bulges the picture like a fisheye (barrel),
  // negative pinches it (pincushion, to straighten a wide lens). Beyond the edges is transparent unless edge pixels
  // repeat.
  def({
    type: 'distort.lens', name: 'Lens Distortion', category: 'Distort',
    params: [num('curvature', 'Curvature', 0, -100, 100), bool('repeat', 'Repeat Edge Pixels', false)],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let d = (uv - 0.5) * u.size.xy;
  let r2 = dot(d, d) / (0.25 * dot(u.size.xy, u.size.xy));
  return tapEdge(0.5 + (uv - 0.5) * (1.0 + u.p[0].x * r2), u.p[0].y > 0.5);
}`,
      uniforms: (p) => (p.curvature ? [[p.curvature / 200, p.repeat ? 1 : 0]] : []),
    },
    // Canvas 2D cannot warp a picture: the 2D back end draws it without the distortion.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p) => {
      if (!p.curvature) return img;
      const k = p.curvature / 200;
      return mapImage(img, (u, v) => {
        const dx = (u - 0.5) * img.w;
        const dy = (v - 0.5) * img.h;
        const f = 1 + (k * (dx * dx + dy * dy)) / (0.25 * (img.w * img.w + img.h * img.h));
        return tapEdgeCpu(img, 0.5 + (u - 0.5) * f, 0.5 + (v - 0.5) * f, p.repeat);
      });
    },
  });

  // Chroma Key: in the sRGB values' Y'CbCr (Rec. 709), d is the CbCr distance from the key color minus similarity
  // (both 0..1). Alpha is multiplied by clamp(d / smoothness)^1.5; within `spill` of the key the color is pulled toward
  // its own luma by 1 - clamp(d / spill)^1.5, taking the key's tint off edges and reflections (0 turns that off).
  // Output Matte shows the alpha as gray instead.
  const cbcr = (s) => {
    const y = s[0] * LUMA[0] + s[1] * LUMA[1] + s[2] * LUMA[2];
    return [y, (s[2] - y) / 1.8556, (s[0] - y) / 1.5748];
  };
  function keyPlan(p) {
    const [, cb, cr] = cbcr(hexToLinear(p.color, [0, 1, 0, 1]).slice(0, 3).map(linearToSrgb));
    return { cb, cr, sim: p.similarity / 100, smooth: Math.max(p.smoothness / 100, 1e-4), spill: Math.max(p.spill / 100, 1e-4), matte: p.output === 'matte' };
  }
  def({
    type: 'key.chroma', name: 'Chroma Key', category: 'Keying',
    params: [
      { ...color('color', 'Key Color', '#00ff00'), keyframable: false }, pct('similarity', 'Similarity', 40), pct('smoothness', 'Smoothness', 8),
      pct('spill', 'Spill Suppression', 10), choice('output', 'Output', 'composite', [['composite', 'Composite'], ['matte', 'Matte']]),
    ],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let q = u.p[0];
  let s = toSrgb(unpremul(c));
  let y = luma(s);
  let d = distance(vec2f((s.b - y) / 1.8556, (s.r - y) / 1.5748), q.xy) - q.z;
  let a = c.a * pow(clamp(d / q.w, 0.0, 1.0), 1.5);
  if (u.p[1].y > 0.5) { return vec4f(vec3f(a), 1.0); }
  let keep = pow(clamp(d / u.p[1].x, 0.0, 1.0), 1.5);
  return vec4f(toLinear(mix(vec3f(y), s, keep)) * a, a);
}`,
      uniforms: (p) => {
        const q = keyPlan(p);
        return [[q.cb, q.cr, q.sim, q.smooth, q.spill, q.matte ? 1 : 0, 0, 0]];
      },
    },
    // Canvas 2D filters cannot key a color out: the 2D back end draws the picture unkeyed.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p) => {
      const q = keyPlan(p);
      return mapColor(img, (c) => {
        const s = unpremulCpu(c).map(encCpu);
        const [y, cb, cr] = cbcr(s);
        const d = Math.hypot(cb - q.cb, cr - q.cr) - q.sim;
        const a = c[3] * clamp(d / q.smooth, 0, 1) ** 1.5;
        if (q.matte) return [a, a, a, 1];
        const keep = clamp(d / q.spill, 0, 1) ** 1.5;
        return s.map((x) => decCpu(y * (1 - keep) + x * keep) * a).concat(a);
      });
    },
  });

  // Film Grain: value noise (a hash per lattice point, smoothly interpolated; at size 1 every pixel is a lattice point)
  // with lattice cells `size` pixels across, in -1..1, times 0.3 x amount, added to the sRGB values; one noise for all channels, or one each with Color Grain.
  // It is a hash of the pixel and the clip's frame, so it changes every frame (Animated) and every render of a frame
  // agrees; without Animated it is the same every frame.
  function grainPlan(p, info) {
    return { amount: (p.amount / 100) * 0.3, cell: Math.max(p.size * info.pxScale, 0.25), color: !!p.color, frame: p.animated ? frameOf(info) : 0 };
  }
  function grainCpu(qx, qy, z) {
    const ix = Math.floor(qx);
    const iy = Math.floor(qy);
    const fx = qx - ix;
    const fy = qy - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const lerp = (a, b, t) => a * (1 - t) + b * t;
    return lerp(lerp(hash3(ix, iy, z), hash3(ix + 1, iy, z), sx), lerp(hash3(ix, iy + 1, z), hash3(ix + 1, iy + 1, z), sx), sy) * 2 - 1;
  }
  def({
    type: 'noise.grain', name: 'Film Grain', category: 'Noise & Grain',
    params: [pct('amount', 'Amount', 20), num('size', 'Size', 1, 0.5, 20, 0.1), bool('color', 'Color Grain', false), bool('animated', 'Animated', true)],
    gpu: {
      wgsl: /* wgsl */ `
fn grainAt(q: vec2f, z: i32) -> f32 {
  let i = vec2i(floor(q));
  let f = q - floor(q);
  let s = f * f * (3.0 - 2.0 * f);
  let a = mix(hash3(i.x, i.y, z), hash3(i.x + 1, i.y, z), s.x);
  let b = mix(hash3(i.x, i.y + 1, z), hash3(i.x + 1, i.y + 1, z), s.x);
  return mix(a, b, s.y) * 2.0 - 1.0;
}
fn effect(uv: vec2f) -> vec4f {
  let c = tap(uv);
  let q = u.p[0];
  let at = vec2f(texel(uv)) / q.y;
  let z = i32(q.w) * 4;
  let g0 = grainAt(at, z);
  var g = vec3f(g0);
  if (q.z > 0.5) { g = vec3f(g0, grainAt(at, z + 1), grainAt(at, z + 2)); }
  return vec4f(toLinear(toSrgb(unpremul(c)) + g * q.x) * c.a, c.a);
}`,
      uniforms: (p, info) => {
        if (!(p.amount > 0)) return [];
        const q = grainPlan(p, info);
        return [[q.amount, q.cell, q.color ? 1 : 0, q.frame]];
      },
    },
    // Canvas 2D has no noise filter: the 2D back end draws the picture without grain.
    canvas2d: () => ({ skip: true }),
    cpu: (img, p, info) => {
      if (!(p.amount > 0)) return img;
      const q = grainPlan(p, info);
      const z = Math.trunc(q.frame) * 4;
      return mapImage(img, (u, v, x, y) => {
        const c = pixel(img, x, y);
        const qx = x / q.cell;
        const qy = y / q.cell;
        const g0 = grainCpu(qx, qy, z);
        const g = q.color ? [g0, grainCpu(qx, qy, z + 1), grainCpu(qx, qy, z + 2)] : [g0, g0, g0];
        return unpremulCpu(c).map((x2, i) => decCpu(encCpu(x2) + g[i] * q.amount) * c[3]).concat(c[3]);
      });
    },
  });

  // ---- audio effects: the audio engine reads gain(params, t, length) (linear gain at t seconds into the clip) ------

  const SLOPES = [['12', '12 dB/oct'], ['24', '24 dB/oct'], ['48', '48 dB/oct']];
  const AUDIO = [
    {
      type: 'audio.gain', name: 'Gain', category: 'Audio', kind: 'audio',
      params: [num('gain', 'Gain', 0, -96, 24, 0.1, { unit: 'dB' })],
      gain: (p) => 10 ** (p.gain / 20),
    },
    {
      type: 'audio.fade', name: 'Fade', category: 'Audio', kind: 'audio',
      params: [num('fadeIn', 'Fade In', 1, 0, 60, 0.01, { unit: 's' }), num('fadeOut', 'Fade Out', 1, 0, 60, 0.01, { unit: 's' }), choice('curve', 'Curve', 'power', [['power', 'Constant Power'], ['linear', 'Linear']])],
      gain: (p, t, length) => {
        let g = 1;
        if (p.fadeIn > 0 && t < p.fadeIn) g *= clamp(t / p.fadeIn, 0, 1);
        if (p.fadeOut > 0 && t > length - p.fadeOut) g *= clamp((length - t) / p.fadeOut, 0, 1);
        return p.curve === 'power' ? Math.sin((g * Math.PI) / 2) : g;
      },
    },
    // Processors (audiofx.js, named by `dsp`): the mixer runs a clip's effects in order as one chain, before the clip's
    // volume, fades and pan, with their state kept across the mix's blocks.
    {
      type: 'audio.eq', name: 'Parametric Equalizer', category: 'Filter and EQ', kind: 'audio', dsp: 'eq',
      params: [
        bool('hpOn', 'High-Pass', false), num('hpFreq', 'High-Pass Frequency', 80, 20, 20000, 1, { unit: 'Hz' }), choice('hpSlope', 'High-Pass Slope', '12', SLOPES),
        bool('lsOn', 'Low Shelf', true), num('lsFreq', 'Low Shelf Frequency', 100, 20, 20000, 1, { unit: 'Hz' }), num('lsGain', 'Low Shelf Gain', 0, -24, 24, 0.1, { unit: 'dB' }),
        ...[[1, 250], [2, 1000], [3, 4000]].flatMap(([b, f]) => [
          bool(`b${b}On`, `Band ${b}`, true), num(`b${b}Freq`, `Band ${b} Frequency`, f, 20, 20000, 1, { unit: 'Hz' }),
          num(`b${b}Gain`, `Band ${b} Gain`, 0, -24, 24, 0.1, { unit: 'dB' }), num(`b${b}Q`, `Band ${b} Q`, 1, 0.1, 30, 0.01),
        ]),
        bool('hsOn', 'High Shelf', true), num('hsFreq', 'High Shelf Frequency', 8000, 20, 20000, 1, { unit: 'Hz' }), num('hsGain', 'High Shelf Gain', 0, -24, 24, 0.1, { unit: 'dB' }),
        bool('lpOn', 'Low-Pass', false), num('lpFreq', 'Low-Pass Frequency', 16000, 20, 20000, 1, { unit: 'Hz' }), choice('lpSlope', 'Low-Pass Slope', '12', SLOPES),
        num('output', 'Output Gain', 0, -24, 24, 0.1, { unit: 'dB' }),
      ],
    },
    { type: 'audio.bass', name: 'Bass', category: 'Filter and EQ', kind: 'audio', dsp: 'bass', params: [num('boost', 'Boost', 0, -24, 24, 0.1, { unit: 'dB' })] },
    { type: 'audio.treble', name: 'Treble', category: 'Filter and EQ', kind: 'audio', dsp: 'treble', params: [num('boost', 'Boost', 0, -24, 24, 0.1, { unit: 'dB' })] },
    {
      type: 'audio.compressor', name: 'Compressor', category: 'Dynamics', kind: 'audio', dsp: 'compressor',
      params: [
        num('threshold', 'Threshold', -20, -60, 0, 0.1, { unit: 'dB' }), num('ratio', 'Ratio', 4, 1, 20, 0.1, { unit: ':1' }),
        num('attack', 'Attack', 10, 0.1, 200, 0.1, { unit: 'ms' }), num('release', 'Release', 100, 5, 2000, 1, { unit: 'ms' }),
        num('knee', 'Knee', 6, 0, 24, 0.1, { unit: 'dB' }), num('makeup', 'Makeup Gain', 0, 0, 24, 0.1, { unit: 'dB' }),
      ],
    },
    {
      type: 'audio.limiter', name: 'Hard Limiter', category: 'Dynamics', kind: 'audio', dsp: 'limiter',
      params: [num('ceiling', 'Ceiling', -1, -24, 0, 0.1, { unit: 'dB' }), num('release', 'Release', 50, 1, 1000, 1, { unit: 'ms' }), bool('truePeak', 'True Peak (4x)', false)],
    },
    {
      type: 'audio.gate', name: 'Noise Gate', category: 'Dynamics', kind: 'audio', dsp: 'gate',
      params: [
        num('threshold', 'Threshold', -50, -90, 0, 0.1, { unit: 'dB' }), num('attack', 'Attack', 2, 0.1, 100, 0.1, { unit: 'ms' }),
        num('hold', 'Hold Time', 50, 0, 1000, 1, { unit: 'ms' }), num('release', 'Release', 100, 5, 2000, 1, { unit: 'ms' }), num('range', 'Range', 40, 0, 90, 0.1, { unit: 'dB' }),
      ],
    },
    {
      type: 'audio.dehum', name: 'DeHummer', category: 'Noise Reduction', kind: 'audio', dsp: 'dehum',
      params: [
        choice('frequency', 'Frequency', '60', [['50', '50 Hz'], ['60', '60 Hz']]), { ...num('harmonics', 'Harmonics', 4, 1, 10, 1), keyframable: false },
        num('reduction', 'Reduction', 30, 0, 60, 0.1, { unit: 'dB' }), num('Q', 'Q', 20, 4, 100, 0.1),
      ],
    },
  ];

  // ---- transitions ---------------------------------------------------------------------------------------------------

  const TRANSITIONS = [];
  const tdef = (d) => { TRANSITIONS.push({ kind: 'video', params: [], ...d }); };
  const mix4 = (a, b, p) => a.map((x, i) => x + (b[i] - x) * p);
  function transitionCpu(a, b, fn) {
    const out = image(a.w, a.h);
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const tA = (u, v) => (insideUv(u, v) ? tapCpu(a, u, v) : [0, 0, 0, 0]);
        const tB = (u, v) => (insideUv(u, v) ? tapCpu(b, u, v) : [0, 0, 0, 0]);
        out.data.set(fn((x + 0.5) / a.w, (y + 0.5) / a.h, tA, tB), (y * a.w + x) * 4);
      }
    }
    return out;
  }

  tdef({
    type: 'dissolve', name: 'Cross Dissolve', category: 'Dissolve',
    gpu: { wgsl: 'fn transition(uv: vec2f) -> vec4f { return mix(tapA(uv), tapB(uv), u.p[0].x); }', uniforms: (p, progress) => [progress] },
    cpu: (a, b, progress) => transitionCpu(a, b, (u, v, tA, tB) => mix4(tA(u, v), tB(u, v), progress)),
  });
  const DIP = /* wgsl */ `
fn transition(uv: vec2f) -> vec4f {
  let p = u.p[0].x;
  let k = u.p[1];
  if (p < 0.5) { return mix(tapA(uv), k, p * 2.0); }
  return mix(k, tapB(uv), p * 2.0 - 1.0);
}`;
  const dipCpu = (k) => (a, b, progress) => transitionCpu(a, b, (u, v, tA, tB) => (progress < 0.5 ? mix4(tA(u, v), k, progress * 2) : mix4(k, tB(u, v), progress * 2 - 1)));
  tdef({
    type: 'dip.black', name: 'Dip to Black', category: 'Dissolve',
    gpu: { wgsl: DIP, uniforms: (p, progress) => [progress, 0, 0, 0, 0, 0, 0, 1] },
    cpu: dipCpu([0, 0, 0, 1]),
  });
  tdef({
    type: 'dip.white', name: 'Dip to White', category: 'Dissolve',
    gpu: { wgsl: DIP, uniforms: (p, progress) => [progress, 0, 0, 0, 1, 1, 1, 1] },
    cpu: dipCpu([1, 1, 1, 1]),
  });
  // Push: the incoming clip slides in from the side opposite `direction` and pushes the outgoing one out.
  const PUSH = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  const pushChoices = [['left', 'Left'], ['right', 'Right'], ['up', 'Up'], ['down', 'Down']];
  tdef({
    type: 'push', name: 'Push', category: 'Slide',
    params: [choice('direction', 'Direction', 'left', pushChoices)],
    gpu: {
      wgsl: /* wgsl */ `
fn transition(uv: vec2f) -> vec4f {
  let p = u.p[0].x;
  let d = u.p[0].yz;
  let ua = uv - d * p;
  if (inside(ua)) { return tapA(ua); }
  return tapB(ua + d);
}`,
      uniforms: (p, progress) => [progress, ...(PUSH[p.direction] || PUSH.left), 0],
    },
    cpu: (a, b, progress, p) => {
      const d = PUSH[p.direction] || PUSH.left;
      return transitionCpu(a, b, (u, v, tA, tB) => {
        const ua = u - d[0] * progress;
        const va = v - d[1] * progress;
        return insideUv(ua, va) ? tA(ua, va) : tB(ua + d[0], va + d[1]);
      });
    },
  });
  // Slide: the incoming clip slides in over the outgoing one, which stays put, moving the way `direction` names
  // (left: in from the right edge). The incoming clip covers by its alpha.
  tdef({
    type: 'slide', name: 'Slide', category: 'Slide',
    params: [choice('direction', 'Direction', 'left', pushChoices)],
    gpu: {
      wgsl: /* wgsl */ `
fn transition(uv: vec2f) -> vec4f {
  let p = u.p[0].x;
  let b = tapB(uv + u.p[0].yz * (1.0 - p));
  return b + tapA(uv) * (1.0 - b.a);
}`,
      uniforms: (p, progress) => [progress, ...(PUSH[p.direction] || PUSH.left), 0],
    },
    cpu: (a, b, progress, p) => {
      const d = PUSH[p.direction] || PUSH.left;
      return transitionCpu(a, b, (u, v, tA, tB) => {
        const cb = tB(u + d[0] * (1 - progress), v + d[1] * (1 - progress));
        const ca = tA(u, v);
        return ca.map((x, i) => cb[i] + x * (1 - cb[3]));
      });
    },
  });
  // Wipe: an edge crosses the frame from the side `direction` names and uncovers the incoming clip; feather is the
  // edge's softness as a percent of the frame.
  const WIPE = { fromLeft: [1, 0, 0], fromRight: [-1, 0, 1], fromTop: [0, 1, 0], fromBottom: [0, -1, 1] };
  const wipeAlong = (w, u, v) => (w[0] > 0 ? u : w[0] < 0 ? 1 - u : w[1] > 0 ? v : 1 - v);
  tdef({
    type: 'wipe', name: 'Wipe', category: 'Wipe',
    params: [choice('direction', 'Direction', 'fromLeft', [['fromLeft', 'From Left'], ['fromRight', 'From Right'], ['fromTop', 'From Top'], ['fromBottom', 'From Bottom']]), pct('feather', 'Feather', 0, 0, 100)],
    gpu: {
      wgsl: /* wgsl */ `
fn transition(uv: vec2f) -> vec4f {
  let p = u.p[0].x;
  let f = u.p[0].y;
  let w = u.p[1];
  var x = uv.x;
  if (w.x < 0.0) { x = 1.0 - uv.x; }
  if (w.x == 0.0 && w.y > 0.0) { x = uv.y; }
  if (w.x == 0.0 && w.y < 0.0) { x = 1.0 - uv.y; }
  let e = p * (1.0 + f) - f;
  var m = select(0.0, 1.0, x < e);
  if (f > 0.0) { m = 1.0 - smoothstep(e, e + f, x); }
  return mix(tapA(uv), tapB(uv), m);
}`,
      uniforms: (p, progress) => [progress, p.feather / 100, 0, 0, ...(WIPE[p.direction] || WIPE.fromLeft), 0],
    },
    cpu: (a, b, progress, p) => {
      const w = WIPE[p.direction] || WIPE.fromLeft;
      const f = p.feather / 100;
      return transitionCpu(a, b, (u, v, tA, tB) => {
        const x = wipeAlong(w, u, v);
        const e = progress * (1 + f) - f;
        const m = f > 0 ? 1 - smoothstep(e, e + f, x) : x < e ? 1 : 0;
        return mix4(tA(u, v), tB(u, v), m);
      });
    },
  });
  // Iris Round: a circle around the frame's center, its radius in units of the distance to a corner, opens to show the
  // incoming clip (Open) or closes on the outgoing one (Close); feather is the edge's softness in the same units.
  const irisMask = (progress, f, close, d) => {
    const q = close ? 1 - progress : progress;
    const e = q * (1 + f) - f;
    const m = f > 0 ? 1 - smoothstep(e, e + f, d) : d < e ? 1 : 0;
    return close ? 1 - m : m;
  };
  tdef({
    type: 'iris.round', name: 'Iris Round', category: 'Wipe',
    params: [choice('direction', 'Direction', 'open', [['open', 'Open'], ['close', 'Close']]), pct('feather', 'Feather', 0, 0, 100)],
    gpu: {
      wgsl: /* wgsl */ `
fn transition(uv: vec2f) -> vec4f {
  let f = u.p[0].y;
  let close = u.p[0].z > 0.5;
  let d = length((uv - 0.5) * u.size.xy) / (0.5 * length(u.size.xy));
  var q = u.p[0].x;
  if (close) { q = 1.0 - q; }
  let e = q * (1.0 + f) - f;
  var m = select(0.0, 1.0, d < e);
  if (f > 0.0) { m = 1.0 - smoothstep(e, e + f, d); }
  if (close) { m = 1.0 - m; }
  return mix(tapA(uv), tapB(uv), m);
}`,
      uniforms: (p, progress) => [progress, p.feather / 100, p.direction === 'close' ? 1 : 0, 0],
    },
    cpu: (a, b, progress, p) => transitionCpu(a, b, (u, v, tA, tB) => {
      const d = Math.hypot((u - 0.5) * a.w, (v - 0.5) * a.h) / (0.5 * Math.hypot(a.w, a.h));
      return mix4(tA(u, v), tB(u, v), irisMask(progress, p.feather / 100, p.direction === 'close', d));
    }),
  });
  // Cross Zoom: the outgoing clip zooms in from 100% to `zoom` while the incoming one zooms back from `zoom` to 100%,
  // both about the center, crossing over with a smoothstep of the progress.
  tdef({
    type: 'zoom.cross', name: 'Cross Zoom', category: 'Zoom',
    params: [pct('zoom', 'Zoom Amount', 300, 100, 1000)],
    gpu: {
      wgsl: /* wgsl */ `
fn transition(uv: vec2f) -> vec4f {
  let p = u.p[0].x;
  let z = u.p[0].y - 1.0;
  let a = tapA(0.5 + (uv - 0.5) / (1.0 + p * z));
  let b = tapB(0.5 + (uv - 0.5) / (1.0 + (1.0 - p) * z));
  return mix(a, b, smoothstep(0.0, 1.0, p));
}`,
      uniforms: (p, progress) => [progress, p.zoom / 100, 0, 0],
    },
    cpu: (a, b, progress, p) => {
      const z = p.zoom / 100 - 1;
      const sa = 1 + progress * z;
      const sb = 1 + (1 - progress) * z;
      return transitionCpu(a, b, (u, v, tA, tB) => mix4(tA(0.5 + (u - 0.5) / sa, 0.5 + (v - 0.5) / sa), tB(0.5 + (u - 0.5) / sb, 0.5 + (v - 0.5) / sb), smoothstep(0, 1, progress)));
    },
  });
  // Constant power crossfade: the audio engine takes gains(progress) -> [outgoing, incoming].
  TRANSITIONS.push({
    type: 'crossfade.power', name: 'Constant Power', category: 'Crossfade', kind: 'audio', params: [],
    gains: (progress) => [Math.cos((clamp(progress, 0, 1) * Math.PI) / 2), Math.sin((clamp(progress, 0, 1) * Math.PI) / 2)],
  });

  // ---- registry ------------------------------------------------------------------------------------------------------

  const ALL = [...VIDEO, ...AUDIO];
  const byType = new Map([...ALL, ...TRANSITIONS].map((d) => [d.type, d]));
  for (const d of [...VIDEO, ...TRANSITIONS]) {
    if (!d.gpu) continue;
    const video = d.kind === 'video';
    const effect = VIDEO.includes(d);
    if (video) d.gpu.code = effect ? EFFECT_PRELUDE + d.gpu.wgsl + EFFECT_MAIN : TRANSITION_PRELUDE + d.gpu.wgsl + TRANSITION_MAIN;
  }

  const list = (kind) => (kind ? ALL.filter((d) => d.kind === kind) : ALL.slice());
  const get = (type) => byType.get(type) || null;
  const transitions = (kind) => (kind ? TRANSITIONS.filter((d) => d.kind === kind) : TRANSITIONS.slice());
  function defaults(type) {
    const d = get(type);
    if (!d) return {};
    const out = {};
    for (const p of d.params) out[p.id] = Array.isArray(p.default) ? p.default.slice() : p.default;
    return out;
  }
  // An effect's parameters with the registry defaults under the stored ones, numbers kept in range and choices valid.
  function resolve(type, params = {}) {
    const d = get(type);
    if (!d) return { ...params };
    const out = defaults(type);
    for (const p of d.params) {
      const v = params[p.id];
      if (v === undefined || v === null) continue;
      if ((p.type === 'number' || p.type === 'percent' || p.type === 'angle') && typeof v === 'number' && Number.isFinite(v)) out[p.id] = clamp(v, p.min ?? -Infinity, p.max ?? Infinity);
      else if (p.type === 'bool') out[p.id] = !!v;
      else if (p.type === 'choice') out[p.id] = p.choices.some(([id]) => id === v) ? v : p.default;
      else if (p.type === 'color' && typeof v === 'string') out[p.id] = v;
      else if (p.type === 'point' && Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) out[p.id] = v.slice();
      else if (p.type === 'curve' && Array.isArray(v)) out[p.id] = lumetri().sanitize(v);
      else if (p.type === 'lut' && typeof v === 'string') out[p.id] = v;
    }
    return out;
  }
  // The white balance eyedropper: the temperature and tint (color.basic) that make a picked color neutral. c is the
  // linear color as it is before the correction; the gains of basicPlan are solved for g_r c_r = g_g c_g = g_b c_b.
  function whiteBalance(c) {
    const l = c.slice(0, 3).map((v) => Math.log2(Math.max(v, 1e-6)));
    const T = l[2] - l[0];
    const M = (l[1] - l[0] - T / 2) / 0.75;
    const round = (v) => Math.round(clamp(v * 100, -100, 100) * 10) / 10;
    return { temperature: round(T), tint: round(M) };
  }
  const defaultTransition = (kind = 'video') => (kind === 'audio' ? 'crossfade.power' : 'dissolve');
  const categories = (kind) => [...new Set([...list(kind), ...transitions(kind)].map((d) => d.category))];

  return {
    list, get, defaults, resolve, transitions, defaultTransition, categories, whiteBalance,
    srgbToLinear, linearToSrgb, hexToLinear, LUMA,
    // For the compositor and the tests.
    wgsl: { VERTEX, EFFECT_PRELUDE, EFFECT_MAIN, TRANSITION_PRELUDE, TRANSITION_MAIN },
    cpu: { image, pixel, tap: tapCpu, mapImage, basicPlan, basicPixel, hash3 },
  };
});
