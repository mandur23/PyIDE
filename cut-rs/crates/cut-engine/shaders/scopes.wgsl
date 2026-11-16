// Copied from renderer/features/cut/scopes.js (WGSL) by tools/engine-wgsl.mjs: do not edit, rerun the tool.
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
}
