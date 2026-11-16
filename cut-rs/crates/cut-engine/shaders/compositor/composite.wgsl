// Copied from renderer/features/cut/compositor.js (shaders().composite) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
struct CU { frame: vec4f, rot: vec4f, layer: vec4f, crop: vec4f, misc: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: CU;

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

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let D = v.uv * u.frame.xy - u.frame.xy * 0.5 - u.frame.zw;
  let R = vec2f(u.rot.x * D.x + u.rot.y * D.y, -u.rot.y * D.x + u.rot.x * D.y);
  let Q = R * u.rot.zw + u.layer.xy * 0.5 + u.layer.zw;
  var luv = Q / u.layer.xy;
  let lo = u.crop.xy;
  let hi = vec2f(1.0) - u.crop.zw;
  if (hi.x <= lo.x || hi.y <= lo.y) { return vec4f(0.0); }
  var cover = 1.0;
  if (u.misc.y > 0.5) {
    luv = clamp(luv, lo, hi);
  } else {
    let dl = (luv - lo) * u.layer.xy;
    let dh = (hi - luv) * u.layer.xy;
    cover = clamp(min(min(dl.x, dl.y), min(dh.x, dh.y)) * u.misc.z + 0.5, 0.0, 1.0);
    if (cover <= 0.0) { return vec4f(0.0); }
  }
  return textureSampleLevel(src, samp, luv, 0.0) * (u.misc.x * cover);
}
