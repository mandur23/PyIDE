// Copied from renderer/features/cut/compositor.js (shaders().final) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
struct OU { box: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: OU;

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

fn toLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn toSrgb(c: vec3f) -> vec3f { return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }
// The source uv a display uv comes from, for a frame that must turn rot.x quarter turns clockwise to be upright.
fn turn(uv: vec2f, q: f32) -> vec2f {
  if (q > 2.5) { return vec2f(1.0 - uv.y, uv.x); }
  if (q > 1.5) { return vec2f(1.0 - uv.x, 1.0 - uv.y); }
  if (q > 0.5) { return vec2f(uv.y, 1.0 - uv.x); }
  return uv;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  if (v.uv.x < u.box.x || v.uv.y < u.box.y || v.uv.x > u.box.z || v.uv.y > u.box.w) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let c = textureSampleLevel(src, samp, (v.uv - u.box.xy) / (u.box.zw - u.box.xy), 0.0);
  return vec4f(toSrgb(clamp(c.rgb, vec3f(0.0), vec3f(1.0))), 1.0);
}
