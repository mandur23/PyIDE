// Copied from renderer/features/cut/masks.js (WGSL) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
struct MaskU { size: vec4f, info: vec4f };
@group(0) @binding(0) var tex0: texture_2d<f32>;
@group(0) @binding(1) var tex1: texture_2d<f32>;
@group(0) @binding(2) var<uniform> mu: MaskU;
@group(0) @binding(3) var<storage, read> md: array<vec4f>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
  var o: VOut;
  o.pos = vec4f(xy, 0.0, 1.0);
  o.uv = vec2f((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return o;
}
fn shapeAt(i: u32, p: vec2f) -> f32 {
  let h0 = md[1u + i * 3u];
  let h1 = md[2u + i * 3u];
  let bb = md[3u + i * 3u];
  if (p.x < bb.x || p.y < bb.y || p.x > bb.z || p.y > bb.w) { return 0.0; }
  let s0 = u32(h0.x);
  let n = u32(h0.y);
  var d2 = 1e30;
  var inside = false;
  for (var k = 0u; k < n; k++) {
    let s = md[s0 + k];
    let a = s.xy;
    let b = s.zw;
    let ab = b - a;
    let ap = p - a;
    let t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    let q = ap - ab * t;
    d2 = min(d2, dot(q, q));
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
  }
  let d = sqrt(d2) * select(-1.0, 1.0, inside);
  return smoothstep(-h1.x * 0.5, h1.x * 0.5, d + h1.y);
}
fn coverage(p: vec2f) -> f32 {
  let hd = md[0];
  let n = u32(hd.x);
  var acc = hd.y;
  for (var i = 0u; i < n; i++) {
    let h0 = md[1u + i * 3u];
    let h1 = md[2u + i * 3u];
    var c = shapeAt(i, p);
    if (h0.w > 0.5) { c = 1.0 - c; }
    let m = c * h1.z;
    let mode = u32(h0.z);
    if (mode == 0u) { acc = acc + m - acc * m; }
    else if (mode == 1u) { acc = acc * (1.0 - m); }
    else if (mode == 2u) { acc = acc * m; }
    else { acc = acc + m - 2.0 * acc * m; }
  }
  return acc;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let px = vec2i(floor(v.pos.xy));
  let keep = textureLoad(tex0, px, 0);
  let under = textureLoad(tex1, px, 0) * mu.info.x;
  _ = mu.size;
  return mix(under, keep, coverage(v.pos.xy));
}
