// Copied from renderer/features/cut/effects.js (the 'color.basic' effect's gpu.code) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
struct FxU { size: vec4f, p: array<vec4f, 4> };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: FxU;
@group(0) @binding(3) var orig: texture_2d<f32>;

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
}
@fragment fn fs(v: VOut) -> @location(0) vec4f { _ = u.size; _ = textureDimensions(orig); return effect(v.uv); }
