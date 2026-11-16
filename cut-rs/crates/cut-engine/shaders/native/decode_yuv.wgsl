// The native stand-in for compositor.js's decodeExternal: there the browser converts a VideoFrame to RGB on import
// (texture_external); here the decoder's NV12 or P010 planes arrive as two integer textures and this does the
// conversion the browser does, with the track's matrix and range. The output is the same as decodeExternal's: the
// frame turned rot.x quarter turns clockwise, linear light, premultiplied, rot.y the weight of a Frame Blending frame
// drawn over the one before (0: an opaque frame). Planes are read with textureLoad and interpolated here, as a
// sampler would (clamp to edge, texel centers at i + 0.5), since integer textures cannot be filtered.
struct YU { rot: vec4f, size: vec4f, r0: vec4f, r1: vec4f, r2: vec4f, range: vec4f };
@group(0) @binding(0) var lumaTex: texture_2d<u32>;
@group(0) @binding(1) var chromaTex: texture_2d<u32>;
@group(0) @binding(2) var<uniform> u: YU;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(xy[i], 0.0, 1.0);
  o.uv = vec2f((xy[i].x + 1.0) * 0.5, (1.0 - xy[i].y) * 0.5);
  return o;
}
fn toLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn turn(uv: vec2f, q: f32) -> vec2f {
  if (q > 2.5) { return vec2f(1.0 - uv.y, uv.x); }
  if (q > 1.5) { return vec2f(1.0 - uv.x, 1.0 - uv.y); }
  if (q > 0.5) { return vec2f(uv.y, 1.0 - uv.x); }
  return uv;
}
fn lumaAt(p: vec2i, n: vec2i) -> f32 { return f32(textureLoad(lumaTex, clamp(p, vec2i(0), n - 1), 0).r); }
fn chromaAt(p: vec2i, n: vec2i) -> vec2f { return vec2f(textureLoad(chromaTex, clamp(p, vec2i(0), n - 1), 0).rg); }
fn luma(uv: vec2f) -> f32 {
  let n = vec2i(u.size.xy);
  let x = uv * u.size.xy - 0.5;
  let i = vec2i(floor(x));
  let f = x - floor(x);
  let a = mix(lumaAt(i, n), lumaAt(i + vec2i(1, 0), n), f.x);
  let b = mix(lumaAt(i + vec2i(0, 1), n), lumaAt(i + vec2i(1, 1), n), f.x);
  return mix(a, b, f.y);
}
fn chroma(uv: vec2f) -> vec2f {
  let n = vec2i(u.size.zw);
  let x = uv * u.size.zw - 0.5;
  let i = vec2i(floor(x));
  let f = x - floor(x);
  let a = mix(chromaAt(i, n), chromaAt(i + vec2i(1, 0), n), f.x);
  let b = mix(chromaAt(i + vec2i(0, 1), n), chromaAt(i + vec2i(1, 1), n), f.x);
  return mix(a, b, f.y);
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let uv = turn(v.uv, u.rot.x);
  // range: black and zero-chroma codes, the code ranges of Y and Cb/Cr (fractions of the largest code), the largest code
  let y = (luma(uv) / u.r2.w - u.range.x) / u.range.z;
  let c = (chroma(uv) / u.r2.w - u.range.y) / u.range.w;
  let yuv = vec3f(y, c);
  let rgb = vec3f(dot(u.r0.xyz, yuv), dot(u.r1.xyz, yuv), dot(u.r2.xyz, yuv));
  let a = select(1.0, u.rot.y, u.rot.y > 0.0);
  return vec4f(toLinear(clamp(rgb, vec3f(0.0), vec3f(1.0))) * a, a);
}
