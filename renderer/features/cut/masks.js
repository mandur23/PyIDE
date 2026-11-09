// Masks of Nano Studio Cut (docs/cut-architecture.md section 8): Premiere's masks of Opacity and of every video effect.
// A mask is a closed bezier path in the clip's own frame plus its feather, opacity, expansion, inversion and mode. On
// Opacity the masks cut the clip out (the clip shows only inside them); on an effect they limit the effect to their
// area (outside it the effect's input shows). Masks sit before the clip's motion, so they follow its position, scale
// and rotation, as Premiere's do.
//
// The path is one flat list of numbers, six per vertex: [x, y, inX, inY, outX, outY], the vertex and its two bezier
// handles relative to it, all as fractions of the clip's picture (0..1 across its width and height, so a path survives
// a change of the sequence size or of the fit setting). A corner vertex has both handles at 0. Edge i runs from vertex
// i to vertex i + 1 (the last back to the first) as the cubic (v_i, v_i + out_i, v_i+1 + in_i+1, v_i+1).
//
// Mask Path keyframes interpolate vertex by vertex (each of the six numbers, with the keyframe's ease) when both
// keyframes have the same number of vertices, and hold the earlier path until the next keyframe when they do not
// (keyframes.mix). Adding or deleting a vertex on a keyframed path does it on every keyframe, so the counts stay equal.
//
// Coverage at a pixel center p (pixels of the picture the mask is drawn on, feather and expansion in sequence pixels
// times pxScale, as every pixel-sized effect parameter): the path is flattened into line segments (FLATTEN per curved
// edge, one per straight edge); d = the distance to them, positive inside (even-odd); the shape's coverage is
// smoothstep(-w/2, w/2, d + expansion) with w = max(feather, 1) (feather 0 still gets a one-pixel antialiased edge);
// Inverted takes 1 - that; Mask Opacity multiplies it. Several masks combine top to bottom (Mask Mode, as in After
// Effects): the total starts at 0, or at 1 when the first mask that is not None subtracts or intersects;
// Add: a + m - a m, Subtract: a (1 - m), Intersect: a m, Difference: a + m - 2 a m; None masks are left out, and a
// list with no other mask is no mask at all. Those four are exactly Canvas 2D's source-over, destination-out,
// destination-in and xor on alpha, which the 2D back end uses.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).masks = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);

  const MODES = ['add', 'subtract', 'intersect', 'difference', 'none'];
  const FIELDS = ['path', 'feather', 'opacity', 'expansion'];
  const DEFAULTS = { mode: 'add', inverted: false, feather: 10, opacity: 100, expansion: 0 };
  const RANGES = { feather: [0, 1000], opacity: [0, 100], expansion: [-2000, 2000] };
  const MAX_MASKS = 16;
  const MAX_POINTS = 256;
  const MIN_POINTS = 3;
  const FLATTEN = 16;
  const KAPPA = 0.5522847498307936;
  const ID_RE = /^m(\d+)$/;

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // ---- shape and validation ------------------------------------------------------------------------------------------

  const count = (path) => Math.floor(path.length / 6);
  function validPath(path) {
    if (!Array.isArray(path) || path.length % 6 !== 0) return false;
    const n = path.length / 6;
    return n >= MIN_POINTS && n <= MAX_POINTS && path.every((v) => isNum(v) && Math.abs(v) <= 100);
  }
  function validField(field, v) {
    if (field === 'path') return validPath(v);
    const r = RANGES[field];
    return !!r && isNum(v) && v >= r[0] && v <= r[1];
  }
  // -> null when the mask is well formed, else what is wrong.
  function problem(m) {
    if (!isObj(m)) return 'not an object';
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return `id ${m.id}`;
    if (!MODES.includes(m.mode)) return `mode ${m.mode}`;
    if (typeof m.inverted !== 'boolean') return 'inverted';
    for (const f of FIELDS) if (!validField(f, m[f])) return f;
    return null;
  }
  const valid = (m) => problem(m) === null;
  // A mask with every field: what is given over the defaults.
  const full = (m) => ({ id: m.id, mode: m.mode ?? DEFAULTS.mode, inverted: m.inverted ?? DEFAULTS.inverted, path: Array.isArray(m.path) ? m.path.slice() : m.path, feather: m.feather ?? DEFAULTS.feather, opacity: m.opacity ?? DEFAULTS.opacity, expansion: m.expansion ?? DEFAULTS.expansion });

  // Every mask list of a clip with the keyframe prefix of its masks: Opacity's (clip.masks) and each effect's.
  function lists(clip) {
    const out = [{ effectId: null, prefix: 'masks', list: clip.masks || [] }];
    for (const e of clip.effects || []) out.push({ effectId: e.id, prefix: `effects.${e.id}.masks`, list: e.masks || [] });
    return out;
  }
  const prefixOf = (effectId) => (effectId ? `effects.${effectId}.masks` : 'masks');
  // The next free mask id of a clip (unique across its lists, so a keyframe path names one mask).
  function nextId(clip) {
    let n = 1;
    for (const { list } of lists(clip)) for (const m of list) { const r = ID_RE.exec(m?.id || ''); if (r) n = Math.max(n, Number(r[1]) + 1); }
    return `m${n}`;
  }
  // 'masks.m1.path' -> { effectId: null, maskId: 'm1', field: 'path' }; 'effects.e2.masks.m3.feather' -> {...}; else
  // null. Only the keyframable fields, unless `all` (mode and inverted too: what Effect Controls writes).
  function parsePath(prop, all = false) {
    const p = String(prop).split('.');
    const ok = (f) => FIELDS.includes(f) || (all && (f === 'mode' || f === 'inverted'));
    if (p.length === 3 && p[0] === 'masks' && ok(p[2])) return { effectId: null, maskId: p[1], field: p[2] };
    if (p.length === 5 && p[0] === 'effects' && p[2] === 'masks' && ok(p[4])) return { effectId: p[1], maskId: p[3], field: p[4] };
    return null;
  }

  // ---- shapes the Effect Controls buttons make --------------------------------------------------------------------------

  // Create Ellipse Mask: a circle a quarter of the picture's shorter side in radius, centered, four smooth vertices
  // (top, right, bottom, left: clockwise on screen). w, h: the picture's size in pixels, so the circle is round.
  function ellipse(w, h, { cx = 0.5, cy = 0.5, r = 0.25 * Math.min(w, h) } = {}) {
    const rx = r / w;
    const ry = r / h;
    const kx = KAPPA * rx;
    const ky = KAPPA * ry;
    return [
      cx, cy - ry, -kx, 0, kx, 0,
      cx + rx, cy, 0, -ky, 0, ky,
      cx, cy + ry, kx, 0, -kx, 0,
      cx - rx, cy, 0, ky, 0, -ky,
    ];
  }
  // Create 4-point Polygon Mask: a centered square half the shorter side across, four corners.
  function polygon(w, h, { cx = 0.5, cy = 0.5, s = 0.5 * Math.min(w, h) } = {}) {
    const dx = s / 2 / w;
    const dy = s / 2 / h;
    return [cx - dx, cy - dy, 0, 0, 0, 0, cx + dx, cy - dy, 0, 0, 0, 0, cx + dx, cy + dy, 0, 0, 0, 0, cx - dx, cy + dy, 0, 0, 0, 0];
  }
  // The Free Draw Bezier pen's points [{x, y, hx, hy}] (fractions; a dragged point's out handle, its in handle mirrored).
  const fromPoints = (points) => points.flatMap((p) => [p.x, p.y, -(p.hx || 0), -(p.hy || 0), p.hx || 0, p.hy || 0]);

  // ---- geometry in pixels ------------------------------------------------------------------------------------------------

  const vertex = (path, i, w, h) => {
    const k = ((i % count(path)) + count(path)) % count(path) * 6;
    return { x: path[k] * w, y: path[k + 1] * h, ix: path[k + 2] * w, iy: path[k + 3] * h, ox: path[k + 4] * w, oy: path[k + 5] * h };
  };
  const straight = (a, b) => a.ox === 0 && a.oy === 0 && b.ix === 0 && b.iy === 0;
  // Edge i's control points in pixels.
  function edge(path, i, w, h) {
    const a = vertex(path, i, w, h);
    const b = vertex(path, i + 1, w, h);
    return { a, b, p0: [a.x, a.y], p1: [a.x + a.ox, a.y + a.oy], p2: [b.x + b.ix, b.y + b.iy], p3: [b.x, b.y], straight: straight(a, b) };
  }
  function cubic(e, t) {
    const u = 1 - t;
    const A = u * u * u;
    const B = 3 * u * u * t;
    const C = 3 * u * t * t;
    const D = t * t * t;
    return [A * e.p0[0] + B * e.p1[0] + C * e.p2[0] + D * e.p3[0], A * e.p0[1] + B * e.p1[1] + C * e.p2[1] + D * e.p3[1]];
  }
  // The closed polygon the path draws as, in pixels: [[x, y]...], the first point not repeated.
  function flatten(path, w, h) {
    const pts = [];
    const n = count(path);
    for (let i = 0; i < n; i++) {
      const e = edge(path, i, w, h);
      pts.push(e.p0);
      if (!e.straight) for (let s = 1; s < FLATTEN; s++) pts.push(cubic(e, s / FLATTEN));
    }
    return pts;
  }
  // Signed distance (positive inside, even-odd) from p to a flattened polygon.
  function signedDistance(pts, x, y) {
    let d2 = Infinity;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ax, ay] = pts[j];
      const [bx, by] = pts[i];
      const abx = bx - ax;
      const aby = by - ay;
      const apx = x - ax;
      const apy = y - ay;
      const t = clamp((apx * abx + apy * aby) / Math.max(abx * abx + aby * aby, 1e-12), 0, 1);
      const qx = apx - abx * t;
      const qy = apy - aby * t;
      d2 = Math.min(d2, qx * qx + qy * qy);
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return Math.sqrt(d2) * (inside ? 1 : -1);
  }
  const contains = (path, w, h, x, y) => signedDistance(flatten(path, w, h), x, y) > 0;
  function bounds(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }

  // ---- coverage (the CPU reference; WGSL below computes the same) --------------------------------------------------------

  // The masks that count (mode not None), each with its pixel geometry for a picture of w x h at pxScale.
  function prepare(masks, w, h, pxScale = 1) {
    const out = [];
    for (const m of masks || []) {
      if (!m || m.mode === 'none') continue;
      const pts = flatten(m.path, w, h);
      const width = Math.max((m.feather || 0) * pxScale, 1);
      const grow = (m.expansion || 0) * pxScale;
      const reach = width / 2 + Math.max(grow, 0) + 1;
      const [x0, y0, x1, y1] = bounds(pts);
      out.push({ mode: m.mode, inverted: !!m.inverted, opacity: clamp((m.opacity ?? 100) / 100, 0, 1), pts, width, grow, box: [x0 - reach, y0 - reach, x1 + reach, y1 + reach] });
    }
    return out;
  }
  const startOf = (prepared) => (prepared.length && (prepared[0].mode === 'subtract' || prepared[0].mode === 'intersect') ? 1 : 0);
  function shapeAt(q, x, y) {
    if (x < q.box[0] || y < q.box[1] || x > q.box[2] || y > q.box[3]) return 0;
    return smoothstep(-q.width / 2, q.width / 2, signedDistance(q.pts, x, y) + q.grow);
  }
  function combine(acc, mode, m) {
    if (mode === 'add') return acc + m - acc * m;
    if (mode === 'subtract') return acc * (1 - m);
    if (mode === 'intersect') return acc * m;
    return acc + m - 2 * acc * m;
  }
  function coverageAt(prepared, x, y) {
    let acc = startOf(prepared);
    for (const q of prepared) {
      const c = shapeAt(q, x, y);
      acc = combine(acc, q.mode, (q.inverted ? 1 - c : c) * q.opacity);
    }
    return acc;
  }
  // The coverage of every pixel center of a w x h picture (row by row), 1 everywhere when no mask counts.
  function coverage(masks, w, h, pxScale = 1) {
    const prepared = prepare(masks, w, h, pxScale);
    const out = new Float32Array(w * h);
    if (!prepared.length) return out.fill(1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = coverageAt(prepared, x + 0.5, y + 0.5);
    return out;
  }
  // CPU references on effects.js images ({w, h, data: rgba premultiplied linear}): Opacity's masks multiply the
  // picture; an effect's masks mix its output (fx) over its input (base).
  function cutCpu(img, masks, pxScale = 1) {
    const cov = coverage(masks, img.w, img.h, pxScale);
    const data = new Float32Array(img.data.length);
    for (let i = 0; i < cov.length; i++) for (let k = 0; k < 4; k++) data[i * 4 + k] = img.data[i * 4 + k] * cov[i];
    return { w: img.w, h: img.h, data };
  }
  function mixCpu(base, fx, masks, pxScale = 1) {
    const cov = coverage(masks, base.w, base.h, pxScale);
    const data = new Float32Array(base.data.length);
    for (let i = 0; i < cov.length; i++) for (let k = 0; k < 4; k++) data[i * 4 + k] = base.data[i * 4 + k] + (fx.data[i * 4 + k] - base.data[i * 4 + k]) * cov[i];
    return { w: base.w, h: base.h, data };
  }

  // ---- the masks of a clip at a time ---------------------------------------------------------------------------------------

  // A list's masks with their keyframed values at clip time `local` (the compositor's plan), or null when none of
  // them counts (no list, or every mask None): the picture is then drawn as without masks.
  function at(clip, prefix, list, local) {
    if (!Array.isArray(list) || !list.length) return null;
    const K = need('keyframes');
    const out = [];
    for (const m of list) {
      if (!m || m.mode === 'none') continue;
      const v = (f) => K.valueAt(clip.keyframes?.[`${prefix}.${m.id}.${f}`], local, m[f]);
      const path = v('path');
      out.push({ id: m.id, mode: m.mode, inverted: !!m.inverted, path: validPath(path) ? path : m.path, feather: v('feather'), opacity: v('opacity'), expansion: v('expansion') });
    }
    return out.length ? out : null;
  }

  // ---- the GPU's data ------------------------------------------------------------------------------------------------------

  // One storage buffer of vec4f for the WGSL below: [count, start, 0, 0], then per mask three vec4 (segment start,
  // segment count, mode, inverted), (width, expansion, opacity, 0), (box), then the segments (x0, y0, x1, y1), pixels.
  const MODE_INDEX = { add: 0, subtract: 1, intersect: 2, difference: 3 };
  function gpuData(masks, w, h, pxScale = 1) {
    const prepared = prepare(masks, w, h, pxScale);
    const segs = prepared.reduce((s, q) => s + q.pts.length, 0);
    const data = new Float32Array(4 * (1 + 3 * prepared.length + segs));
    data[0] = prepared.length;
    data[1] = startOf(prepared);
    let seg = 1 + 3 * prepared.length;
    prepared.forEach((q, i) => {
      const o = 4 * (1 + 3 * i);
      data.set([seg, q.pts.length, MODE_INDEX[q.mode], q.inverted ? 1 : 0, q.width, q.grow, q.opacity, 0, ...q.box], o);
      for (let k = 0, j = q.pts.length - 1; k < q.pts.length; j = k++) {
        data.set([q.pts[j][0], q.pts[j][1], q.pts[k][0], q.pts[k][1]], 4 * seg);
        seg++;
      }
    });
    return data;
  }
  // The mask pass: tex0 is what the masks keep, tex1 what shows outside them (an effect's input; transparent for
  // Opacity's masks, mu.info.x = 0). Pixel centers are at v.pos.xy, as the CPU's (x + 0.5, y + 0.5).
  const WGSL = /* wgsl */ `
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
`;

  // ---- the Canvas 2D back end -----------------------------------------------------------------------------------------------

  // The coverage as the alpha of a w x h canvas (newCanvas(w, h) makes one). The modes are exact (canvas compositing);
  // expansion is a round-joined stroke of twice its size (exact too); the feather is a Gaussian blur of sigma =
  // width / 3.76, which has the smoothstep's slope at the edge (1.5 / width) and differs from it by at most about 0.03
  // in coverage along the ramp; a feather under 1 pixel is the canvas's own antialiasing.
  const SIGMA = 3.76;
  function path2d(path, w, h) {
    const p = new Path2D();
    const n = count(path);
    for (let i = 0; i < n; i++) {
      const e = edge(path, i, w, h);
      if (i === 0) p.moveTo(e.p0[0], e.p0[1]);
      if (e.straight) p.lineTo(e.p3[0], e.p3[1]);
      else p.bezierCurveTo(e.p1[0], e.p1[1], e.p2[0], e.p2[1], e.p3[0], e.p3[1]);
    }
    p.closePath();
    return p;
  }
  function canvasCoverage(masks, w, h, pxScale, newCanvas) {
    const list = (masks || []).filter((m) => m && m.mode !== 'none');
    const acc = newCanvas(w, h);
    const g = acc.getContext('2d');
    if (list.length && (list[0].mode === 'subtract' || list[0].mode === 'intersect')) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    for (const m of list) {
      const shape = newCanvas(w, h);
      const s = shape.getContext('2d');
      const p = path2d(m.path, w, h);
      const grow = (m.expansion || 0) * pxScale;
      s.fillStyle = '#ffffff';
      s.strokeStyle = '#ffffff';
      s.lineJoin = 'round';
      s.fill(p, 'evenodd');
      if (grow > 0) { s.lineWidth = 2 * grow; s.stroke(p); }
      if (grow < 0) { s.globalCompositeOperation = 'destination-out'; s.lineWidth = -2 * grow; s.stroke(p); s.globalCompositeOperation = 'source-over'; }
      const width = (m.feather || 0) * pxScale;
      let c = shape;
      if (width >= 1) {
        c = newCanvas(w, h);
        const b = c.getContext('2d');
        b.filter = `blur(${(width / SIGMA).toFixed(3)}px)`;
        b.drawImage(shape, 0, 0);
        b.filter = 'none';
      }
      if (m.inverted) {
        const inv = newCanvas(w, h);
        const ig = inv.getContext('2d');
        ig.fillStyle = '#ffffff';
        ig.fillRect(0, 0, w, h);
        ig.globalCompositeOperation = 'destination-out';
        ig.drawImage(c, 0, 0);
        c = inv;
      }
      g.globalAlpha = clamp((m.opacity ?? 100) / 100, 0, 1);
      g.globalCompositeOperation = { add: 'source-over', subtract: 'destination-out', intersect: 'destination-in', difference: 'xor' }[m.mode];
      g.drawImage(c, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
    return acc;
  }

  // ---- edits (pure: each returns a new path) ------------------------------------------------------------------------------

  const translate = (path, du, dv) => path.map((v, k) => (k % 6 === 0 ? v + du : k % 6 === 1 ? v + dv : v));
  function moveVertex(path, i, du, dv) {
    const out = path.slice();
    out[i * 6] += du;
    out[i * 6 + 1] += dv;
    return out;
  }
  // Sets handle `which` ('in' | 'out') of vertex i to (hu, hv) (fractions, relative to the vertex). Unless `broken`
  // (Alt), the other handle turns to point the opposite way and keeps its length (in pixels; the same length when it
  // had none), so a smooth point stays smooth.
  function setHandle(path, i, which, hu, hv, w, h, { broken = false } = {}) {
    const out = path.slice();
    const k = i * 6 + (which === 'in' ? 2 : 4);
    const o = i * 6 + (which === 'in' ? 4 : 2);
    out[k] = hu;
    out[k + 1] = hv;
    if (!broken) {
      const len = Math.hypot(hu * w, hv * h);
      const olen = Math.hypot(out[o] * w, out[o + 1] * h) || len;
      const f = len > 1e-9 ? olen / len : 0;
      out[o] = -hu * f;
      out[o + 1] = -hv * f;
    }
    return out;
  }
  const isCorner = (path, i) => path.slice(i * 6 + 2, i * 6 + 6).every((v) => v === 0);
  // Alt+click: a corner becomes smooth (handles along the line from the previous vertex to the next, a third of the
  // distance to each), a smooth (or broken) vertex becomes a corner.
  function toggleSmooth(path, i, w, h) {
    const out = path.slice();
    const k = i * 6;
    if (!isCorner(path, i)) { out.fill(0, k + 2, k + 6); return out; }
    const n = count(path);
    const v = vertex(path, i, w, h);
    const a = vertex(path, i - 1 + n, w, h);
    const b = vertex(path, i + 1, w, h);
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const li = Math.hypot(v.x - a.x, v.y - a.y) / 3;
    const lo = Math.hypot(b.x - v.x, b.y - v.y) / 3;
    out[k + 2] = (-dx * li) / w;
    out[k + 3] = (-dy * li) / h;
    out[k + 4] = (dx * lo) / w;
    out[k + 5] = (dy * lo) / h;
    return out;
  }
  // A vertex on edge `e` at t (0..1) that keeps the shape: de Casteljau's split of the edge's cubic (a straight edge
  // stays straight, with a corner).
  function insertVertex(path, e, t) {
    const n = count(path);
    const i = ((e % n) + n) % n;
    const j = (i + 1) % n;
    const g = (k) => path[k];
    const P0 = [g(i * 6), g(i * 6 + 1)];
    const P3 = [g(j * 6), g(j * 6 + 1)];
    const P1 = [P0[0] + g(i * 6 + 4), P0[1] + g(i * 6 + 5)];
    const P2 = [P3[0] + g(j * 6 + 2), P3[1] + g(j * 6 + 3)];
    const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const out = path.slice();
    let nv;
    if (g(i * 6 + 4) === 0 && g(i * 6 + 5) === 0 && g(j * 6 + 2) === 0 && g(j * 6 + 3) === 0) {
      const m = lerp(P0, P3);
      nv = [m[0], m[1], 0, 0, 0, 0];
    } else {
      const A = lerp(P0, P1);
      const B = lerp(P1, P2);
      const C = lerp(P2, P3);
      const D = lerp(A, B);
      const E = lerp(B, C);
      const M = lerp(D, E);
      out[i * 6 + 4] = A[0] - P0[0];
      out[i * 6 + 5] = A[1] - P0[1];
      out[j * 6 + 2] = C[0] - P3[0];
      out[j * 6 + 3] = C[1] - P3[1];
      nv = [M[0], M[1], D[0] - M[0], D[1] - M[1], E[0] - M[0], E[1] - M[1]];
    }
    out.splice((i + 1) * 6, 0, ...nv);
    return out;
  }
  const removeVertex = (path, i) => (count(path) <= MIN_POINTS ? path.slice() : [...path.slice(0, i * 6), ...path.slice(i * 6 + 6)]);

  // Hit tests, pixels of the picture.
  function nearestVertex(path, w, h, x, y) {
    let best = { index: -1, distance: Infinity };
    for (let i = 0; i < count(path); i++) {
      const v = vertex(path, i, w, h);
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < best.distance) best = { index: i, distance: d };
    }
    return best;
  }
  function nearestEdge(path, w, h, x, y) {
    let best = { index: -1, t: 0, distance: Infinity };
    for (let i = 0; i < count(path); i++) {
      const e = edge(path, i, w, h);
      for (let s = 0; s <= 64; s++) {
        const p = cubic(e, s / 64);
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < best.distance) best = { index: i, t: s / 64, distance: d };
      }
    }
    return best;
  }
  // The outline grown by d pixels (positive outward): the flattened points moved along their normals. The monitor
  // draws Mask Expansion's and Mask Feather's guide lines with it.
  function outline(path, w, h, d) {
    const pts = flatten(path, w, h);
    if (!d) return pts;
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    const out = area > 0 ? 1 : -1;
    return pts.map((p, i) => {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[(i + 1) % pts.length];
      let nx = b[1] - a[1];
      let ny = -(b[0] - a[0]);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      return [p[0] - out * nx * d, p[1] - out * ny * d];
    });
  }
  // The topmost point of the path, pixels (where the monitor puts the feather and expansion handles).
  function topPoint(path, w, h) {
    let best = null;
    for (const p of flatten(path, w, h)) if (!best || p[1] < best[1]) best = p;
    return best;
  }
  // The same edit on every keyframe of a path (adding or deleting a vertex keeps the counts equal).
  const mapKeyframes = (list, fn) => (list || []).map((k) => ({ ...k, v: validPath(k.v) ? fn(k.v) : k.v }));

  return {
    MODES, FIELDS, DEFAULTS, RANGES, MAX_MASKS, MAX_POINTS, MIN_POINTS, FLATTEN, KAPPA, SIGMA, WGSL,
    count, validPath, validField, valid, problem, full, lists, prefixOf, nextId, parsePath,
    ellipse, polygon, fromPoints, flatten, signedDistance, contains, edge, cubic, vertex, isCorner,
    prepare, coverage, coverageAt, cutCpu, mixCpu, at, gpuData, canvasCoverage, path2d,
    translate, moveVertex, setHandle, toggleSmooth, insertVertex, removeVertex, nearestVertex, nearestEdge, outline, topPoint, mapKeyframes,
  };
});
