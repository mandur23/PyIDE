// Copied from renderer/features/cut/effects.js (the 'flip.horizontal' effect's gpu.code) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
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
fn effect(uv: vec2f) -> vec4f { return tap(vec2f(1.0 - uv.x, uv.y)); }
@fragment fn fs(v: VOut) -> @location(0) vec4f { _ = u.size; _ = textureDimensions(orig); return effect(v.uv); }
