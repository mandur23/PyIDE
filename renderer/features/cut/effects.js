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
// each, every pass reading the one before (the separable blur), or none (nothing to do). A transition's WGSL defines
// `fn transition(uv: vec2f) -> vec4f` with tapA(uv), tapB(uv) and the progress u.p[0].x (0 at its start, 1 at its end).
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
  // size = (width, height, 1 / width, 1 / height) of the texture an effect reads and writes.
  const EFFECT_PRELUDE = /* wgsl */ `
struct FxU { size: vec4f, p: array<vec4f, 4> };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: FxU;
${VERTEX}
fn tap(uv: vec2f) -> vec4f { return textureSampleLevel(src, samp, uv, 0.0); }
// A tap outside the frame is transparent unless edge pixels repeat.
fn tapEdge(uv: vec2f, repeat: bool) -> vec4f { if (!repeat && !inside(uv)) { return vec4f(0.0); } return tap(uv); }
`;
  // Every binding is used (an 'auto' pipeline layout leaves out the ones a shader never reads).
  const EFFECT_MAIN = /* wgsl */ `
@fragment fn fs(v: VOut) -> @location(0) vec4f { _ = u.size; return effect(v.uv); }
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
  def({
    type: 'color.basic', name: 'Basic Correction', category: 'Color Correction',
    params: [
      num('temperature', 'Temperature', 0, -100, 100), num('tint', 'Tint', 0, -100, 100),
      num('exposure', 'Exposure', 0, -4, 4, 0.01), num('contrast', 'Contrast', 0, -100, 100),
      num('highlights', 'Highlights', 0, -100, 100), num('shadows', 'Shadows', 0, -100, 100),
      num('whites', 'Whites', 0, -100, 100), num('blacks', 'Blacks', 0, -100, 100),
      pct('saturation', 'Saturation', 100, 0, 200), num('vibrance', 'Vibrance', 0, -100, 100),
    ],
    gpu: {
      wgsl: /* wgsl */ `
fn effect(uv: vec2f) -> vec4f {
  let src4 = tap(uv);
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
      uniforms: (p) => {
        const q = basicPlan(p);
        return [[...q.gain, q.k, ...q.tone, q.vibrance, q.saturation, 0, 0]];
      },
    },
    canvas2d: (p) => {
      const parts = [];
      if (p.exposure) parts.push(`brightness(${(2 ** (p.exposure / 2.2)).toFixed(4)})`);
      if (p.contrast) parts.push(`contrast(${(1 + p.contrast / 100).toFixed(4)})`);
      if (p.saturation !== 100 || p.vibrance) parts.push(`saturate(${Math.max(0, p.saturation / 100 + p.vibrance / 200).toFixed(4)})`);
      if (p.temperature > 0) parts.push(`sepia(${clamp(p.temperature / 300, 0, 1).toFixed(4)})`);
      return { filter: parts.join(' ') };
    },
    cpu: (img, p) => {
      const q = basicPlan(p);
      return mapColor(img, (c) => basicPixel(unpremulCpu(c), q).map((x) => x * c[3]).concat(c[3]));
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

  // ---- audio effects: the audio engine reads gain(params, t, length) (linear gain at t seconds into the clip) ------

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
    cpu: { image, pixel, tap: tapCpu, mapImage },
  };
});
