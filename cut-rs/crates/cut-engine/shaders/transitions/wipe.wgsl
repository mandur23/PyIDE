// Copied from renderer/features/cut/effects.js (the 'wipe' transition's gpu.code) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
struct FxU { size: vec4f, p: array<vec4f, 4> };
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: FxU;

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

fn tapA(uv: vec2f) -> vec4f { if (!inside(uv)) { return vec4f(0.0); } return textureSampleLevel(srcA, samp, uv, 0.0); }
fn tapB(uv: vec2f) -> vec4f { if (!inside(uv)) { return vec4f(0.0); } return textureSampleLevel(srcB, samp, uv, 0.0); }

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
}
@fragment fn fs(v: VOut) -> @location(0) vec4f { _ = u.size; _ = tapA(v.uv); _ = tapB(v.uv); return transition(v.uv); }
