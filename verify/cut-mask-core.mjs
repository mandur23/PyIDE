// Nano Studio Cut's masks in plain Node (renderer/features/cut/masks.js, with model.js, commands.js, keyframes.js and
// compositor.js's plan). Checks:
// - coverage at chosen pixels against numbers worked out here: an ellipse against the true circle, a 4-point polygon
//   and a triangle against exact distances, a path of smooth bezier points against its cubics sampled densely here;
// - feather, expansion (growing and shrinking), Mask Opacity, Inverted, and the five modes combining two masks (and a
//   first mask that subtracts), a None mask left out, no mask counting as no mask;
// - edits that keep the shape (a vertex added on a curve, corner <-> smooth and back), translate, the mirrored handle,
//   three vertices at least; the GPU's data (segments, modes, the starting total) from the same flattening;
// - Mask Path keyframes: vertex by vertex with the keyframe's ease when the counts match, held when they do not, a
//   vertex added on every keyframe; the plan reads them at clip time;
// - the commands (add, set, remove with their keyframes, undo exactly), refusals (audio clip, Edge Extend, too many, a
//   bad mask), paste, razor and freeze frame carrying masks, removeEffect taking its masks' keyframes along;
// - save and open, format version 4, a version 3 file, migrate dropping damaged masks and their keyframes, validate's
//   refusals;
// - the plan of a masked nest clip and of a masked remapped clip;
// - masks.js as a page script next to an AMD `require`; the refusals translated in ko.json.
// Usage: node verify/cut-mask-core.mjs
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import vm from 'vm';

const require = createRequire(import.meta.url);
const dir = '../renderer/features/cut/';
const M = require(`${dir}masks.js`);
const model = require(`${dir}model.js`);
const C = require(`${dir}commands.js`);
const K = require(`${dir}keyframes.js`);
const time = require(`${dir}time.js`);
const compositor = require(`${dir}compositor.js`);
const R = require(`${dir}remap.js`);

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mask = (o) => M.full({ id: 'm1', ...o });
const covAt = (masks, w, h, x, y) => M.coverage(masks, w, h)[y * w + x];
const SEC = time.TICKS;
const F = time.frameTicks([30, 1]);

// ---- shapes at chosen pixels ----
{
  // An ellipse on a 200 x 100 picture is a circle of radius 25 px at (100, 50): with feather 20 the coverage at a pixel
  // center is smoothstep(-10, 10, 25 - its distance from the center).
  const W = 200, H = 100;
  const e = [mask({ path: M.ellipse(W, H), feather: 20 })];
  const want = (x, y) => smooth(-10, 10, 25 - Math.hypot(x + 0.5 - 100, y + 0.5 - 50));
  const pts = [[100, 50], [114, 50], [120, 50], [124, 50], [128, 50], [100, 70], [117, 67], [136, 50], [60, 20]];
  const worst = Math.max(...pts.map(([x, y]) => Math.abs(covAt(e, W, H, x, y) - want(x, y))));
  check(worst < 0.004, `an ellipse mask is the circle it draws: coverage at ${pts.length} pixels within ${worst.toFixed(5)} of smoothstep over the true distance`);
  check(covAt(e, W, H, 100, 50) === 1 && covAt(e, W, H, 0, 0) === 0, 'an ellipse covers its center and not the corner');
  const hard = [mask({ path: M.ellipse(W, H), feather: 0 })];
  check(near(covAt(hard, W, H, 124, 50), smooth(-0.5, 0.5, 25 - Math.hypot(24.5, 0.5)), 0.03), `feather 0 leaves a one-pixel antialiased edge (${covAt(hard, W, H, 124, 50).toFixed(3)})`);
  // a 4-point polygon: the square (75, 25)..(125, 75); distances to straight edges are exact
  const p = [mask({ path: M.polygon(W, H), feather: 10 })];
  const sq = (x, y) => { const cx = x + 0.5, cy = y + 0.5; const inside = cx > 75 && cx < 125 && cy > 25 && cy < 75; const d = inside ? Math.min(cx - 75, 125 - cx, cy - 25, 75 - cy) : Math.hypot(Math.max(75 - cx, 0, cx - 125), Math.max(25 - cy, 0, cy - 75)); return smooth(-5, 5, inside ? d : -d); };
  const sqPts = [[80, 50], [77, 50], [75, 50], [73, 50], [70, 50], [100, 26], [123, 73], [127, 77], [130, 80]];
  check(sqPts.every(([x, y]) => near(covAt(p, W, H, x, y), sq(x, y), 1e-6)), `a 4-point polygon mask: exact coverage at ${sqPts.length} pixels, corners included (${S(sqPts.map(([x, y]) => +covAt(p, W, H, x, y).toFixed(4)))})`);
  // a triangle from the pen (three corner points)
  const tri = [mask({ path: M.fromPoints([{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.1, y: 0.9 }]), feather: 0 })];
  check(covAt(tri, W, H, 30, 30) === 1 && covAt(tri, W, H, 110, 80) === 0 && covAt(tri, W, H, 22, 80) > 0.99, 'a pen triangle covers inside its corners only');
  // a path of smooth bezier points: three points with mirrored handles; the expected coverage comes from the cubics
  // sampled 4096 times an edge here
  const path = M.fromPoints([{ x: 0.2, y: 0.2, hx: 0.15, hy: -0.05 }, { x: 0.8, y: 0.4, hx: 0, hy: 0.25 }, { x: 0.3, y: 0.85, hx: -0.2, hy: -0.1 }]);
  const curve = [];
  for (let i = 0; i < 3; i++) {
    const a = path.slice(i * 6, i * 6 + 6);
    const b = path.slice(((i + 1) % 3) * 6, ((i + 1) % 3) * 6 + 6);
    const P = [[a[0], a[1]], [a[0] + a[4], a[1] + a[5]], [b[0] + b[2], b[1] + b[3]], [b[0], b[1]]].map(([x, y]) => [x * W, y * H]);
    for (let s = 0; s < 4096; s++) {
      const t = s / 4096, u = 1 - t;
      curve.push([0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]));
    }
  }
  const sd = (x, y) => {
    let d = Infinity, inside = false;
    for (let i = 0, j = curve.length - 1; i < curve.length; j = i++) {
      d = Math.min(d, Math.hypot(curve[i][0] - x, curve[i][1] - y));
      if ((curve[j][1] > y) !== (curve[i][1] > y) && x < ((curve[i][0] - curve[j][0]) * (y - curve[j][1])) / (curve[i][1] - curve[j][1]) + curve[j][0]) inside = !inside;
    }
    return inside ? d : -d;
  };
  const bz = [mask({ path, feather: 8 })];
  const bzPts = [[100, 40], [150, 40], [158, 45], [162, 55], [90, 80], [60, 76], [40, 20], [100, 60], [170, 70]];
  const worstB = Math.max(...bzPts.map(([x, y]) => Math.abs(covAt(bz, W, H, x, y) - smooth(-4, 4, sd(x + 0.5, y + 0.5)))));
  check(worstB < 0.03 && covAt(bz, W, H, 100, 60) === 1, `a bezier mask of smooth points follows its cubics: ${bzPts.length} pixels within ${worstB.toFixed(4)}`);
  // the same shape after a vertex is added on a curved edge (de Casteljau), and after corner -> smooth -> corner on a square
  const split = [mask({ path: M.insertVertex(path, 1, 0.3), feather: 8 })];
  const a1 = M.coverage(bz, W, H), a2 = M.coverage(split, W, H);
  let dmax = 0;
  for (let i = 0; i < a1.length; i++) dmax = Math.max(dmax, Math.abs(a1[i] - a2[i]));
  check(M.count(split[0].path) === 4 && dmax < 0.04, `a vertex added on a curve keeps the shape (4 vertices, coverage within ${dmax.toFixed(4)})`);
  const rounded = M.toggleSmooth(M.polygon(W, H), 1, W, H);
  check(!M.isCorner(rounded, 1) && M.isCorner(rounded, 0) && S(M.toggleSmooth(rounded, 1, W, H)) === S(M.polygon(W, H)), 'Alt+click: a corner becomes smooth, and back to the same corner');
  check(M.count(M.removeVertex(M.polygon(W, H), 2)) === 3 && M.count(M.removeVertex(M.removeVertex(M.polygon(W, H), 2), 0)) === 3, 'a vertex goes, but three always stay');
  const hdl = M.setHandle(path, 0, 'out', 0.1, 0.05, W, H);
  const lenIn = Math.hypot(path[2] * W, path[3] * H);
  check(near(Math.hypot(hdl[2] * W, hdl[3] * H), lenIn, 1e-9) && near(hdl[2] * W * 0.05 * H, hdl[3] * H * 0.1 * W, 1e-9) && hdl[2] < 0, 'dragging a handle turns the opposite one to point away, keeping its length');
  check(S(M.setHandle(path, 0, 'out', 0.1, 0.05, W, H, { broken: true }).slice(2, 4)) === S(path.slice(2, 4)), 'with Alt the handles break apart');
  const moved = [mask({ path: M.translate(M.polygon(W, H), 0.1, 0), feather: 10 })];
  check(near(covAt(moved, W, H, 100, 50), sq(80, 50), 1e-6) && near(covAt(moved, W, H, 97, 50), sq(77, 50), 1e-6), 'translate moves the whole mask (20 px right)');
}

// ---- feather, expansion, opacity, inverted, modes ----
{
  const W = 200, H = 100;
  const sqPath = M.polygon(W, H); // (75, 25)..(125, 75)
  const at = (o, x, y) => covAt([mask({ path: sqPath, feather: 0, ...o })], W, H, x, y);
  check(at({ expansion: 5 }, 72, 50) === 1 && at({}, 72, 50) === 0 && at({ expansion: 5 }, 68, 50) === 0, 'Mask Expansion +5 grows the mask by 5 px (3 px outside is covered, 7 px is not)');
  check(at({ expansion: -5 }, 77, 50) === 0 && at({ expansion: -5 }, 81, 50) === 1, 'Mask Expansion -5 shrinks it by 5 px');
  check(near(at({ expansion: 4, feather: 10 }, 72, 50), smooth(-5, 5, -2.5 + 4), 1e-6), 'expansion moves the feather ramp with the edge');
  check(near(at({ opacity: 40 }, 100, 50), 0.4, 1e-6) && at({ opacity: 40 }, 10, 10) === 0, 'Mask Opacity 40% keeps 40% inside');
  check(at({ inverted: true }, 100, 50) === 0 && at({ inverted: true }, 10, 10) === 1 && near(at({ inverted: true, opacity: 50 }, 10, 10), 0.5, 1e-6), 'Inverted keeps the outside (and Mask Opacity applies after it)');
  // two masks: A the square (75..125), B the square moved 40 px right (115..165); x 90 only in A, 120 in both, 150 only in B, 10 in neither
  const A = mask({ id: 'm1', path: sqPath, feather: 0 });
  const B = (o) => mask({ id: 'm2', path: M.translate(sqPath, 0.2, 0), feather: 0, ...o });
  const four = (list) => [90, 120, 150, 10].map((x) => +covAt(list, W, H, x, 50).toFixed(4));
  check(S(four([A, B({ mode: 'add' })])) === '[1,1,1,0]', `Add: the union (${S(four([A, B({ mode: 'add' })]))})`);
  check(S(four([A, B({ mode: 'subtract' })])) === '[1,0,0,0]', `Subtract: A without B (${S(four([A, B({ mode: 'subtract' })]))})`);
  check(S(four([A, B({ mode: 'intersect' })])) === '[0,1,0,0]', `Intersect: where both are (${S(four([A, B({ mode: 'intersect' })]))})`);
  check(S(four([A, B({ mode: 'difference' })])) === '[1,0,1,0]', `Difference: where one is (${S(four([A, B({ mode: 'difference' })]))})`);
  check(S(four([A, B({ mode: 'none' })])) === '[1,1,0,0]', `None: B is left out (${S(four([A, B({ mode: 'none' })]))})`);
  check(S(four([A, B({ mode: 'add', opacity: 50 })])) === '[1,1,0.5,0]', 'Add with B at 50%: 1 + 0.5 - 0.5 where both are');
  check(S(four([{ ...A, mode: 'subtract' }])) === '[0,0,1,1]' && S(four([{ ...A, mode: 'intersect' }])) === '[1,1,0,0]', 'a first mask that subtracts cuts a hole out of the whole picture; one that intersects keeps only itself');
  check(M.coverage([{ ...A, mode: 'none' }], W, H).every((v) => v === 1) && M.coverage([], W, H).every((v) => v === 1), 'no mask counting is no mask: everything shows');
  // the GPU's data: the same flattening, the modes and the starting total
  const g = M.gpuData([A, B({ mode: 'subtract', inverted: true, opacity: 60, feather: 6, expansion: 2 })], W, H, 0.5);
  const segs = M.flatten(sqPath, W, H).length;
  check(g[0] === 2 && g[1] === 0 && g[4] === 7 && g[5] === segs && g[6] === 0 && g[16] === 7 + segs && g[17] === segs && g[18] === 1 && g[19] === 1 && near(g[20], 3, 1e-6) && near(g[21], 1, 1e-6) && near(g[22], 0.6, 1e-6), `the GPU data has both masks with their modes, inversion, width, expansion and opacity at pxScale 0.5 (${S(Array.from(g.slice(0, 24)).map((v) => +v.toFixed(3)))})`);
  check(S(Array.from(g.slice(28, 32))) === S([75, 75, 75, 25]), `and the segments of the first mask from its flattening (${S(Array.from(g.slice(28, 32)))})`);
  check(M.gpuData([{ ...A, mode: 'intersect' }], W, H)[1] === 1, 'a first mask that intersects starts the GPU total at 1');
}

// ---- keyframes, commands, plan ----
const h = C.createHistory(model.createProject({ sequence: { w: 1920, h: 1080, fps: [30, 1] } }), { limit: Infinity });
const sid = h.project.sequences[0].id;
const VID = { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 };
const { ids: [mid] } = h.do(C.importMedia([{ path: 'D:/a.mp4', name: 'a.mp4', kind: 'video', size: 1, mtime: 1, duration: 60 * SEC, video: VID, audio: { rate: 48000, channels: 2, codec: 'mp4a.40.2' } }]));
const [vid, aid] = h.do(C.place(sid, { source: { media: mid }, in: 0, out: 4 * SEC, at: 0, video: 'V1', audio: 'A1' })).ids;
const seqOf = () => h.project.sequences.find((s) => s.id === sid);
const clip = (id = vid) => seqOf().clips.find((c) => c.id === id);
{
  const E = M.ellipse(1920, 1080);
  const E2 = M.translate(E, 0.2, 0.1);
  const r = h.do(C.addMask(sid, vid, { path: E }));
  check(r.id === 'm1' && S(clip().masks[0]) === S({ id: 'm1', mode: 'add', inverted: false, path: E, feather: 10, opacity: 100, expansion: 0 }), 'addMask puts a mask with the Premiere defaults (feather 10, opacity 100%, expansion 0) on Opacity');
  h.do(C.setKeyframes(sid, vid, 'masks.m1.path', [{ t: 0, v: E, ease: 'linear' }, { t: 10 * F, v: E2, ease: 'linear' }]));
  const mid5 = K.propValue(clip(), 'masks.m1.path', 5 * F, null);
  check(mid5.every((v, i) => near(v, (E[i] + E2[i]) / 2, 1e-12)), 'Mask Path keyframes with the same vertex count interpolate vertex by vertex (half way at frame 5)');
  h.do(C.setKeyframes(sid, vid, 'masks.m1.path', [{ t: 0, v: E, ease: 'easeIn' }, { t: 10 * F, v: E2, ease: 'linear' }]));
  const eased = K.propValue(clip(), 'masks.m1.path', 5 * F, null);
  const k = K.eased({ ease: 'easeIn' }, 0.5);
  check(near(eased[0], E[0] + (E2[0] - E[0]) * k, 1e-12) && k < 0.5, `with the keyframe's ease (ease in: ${k.toFixed(3)} of the way at the middle)`);
  const tri = M.fromPoints([{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.5, y: 0.7 }]);
  h.do(C.setKeyframes(sid, vid, 'masks.m1.path', [{ t: 0, v: E, ease: 'linear' }, { t: 10 * F, v: tri, ease: 'linear' }]));
  check(S(K.propValue(clip(), 'masks.m1.path', 5 * F, null)) === S(E) && S(K.propValue(clip(), 'masks.m1.path', 9 * F, null)) === S(E) && S(K.propValue(clip(), 'masks.m1.path', 10 * F, null)) === S(tri), 'Mask Path keyframes with different vertex counts hold the earlier path until the next keyframe');
  const both = M.mapKeyframes(clip().keyframes['masks.m1.path'], (p) => M.insertVertex(p, 0, 0.5));
  check(both.map((x) => M.count(x.v)).join() === '5,4', 'a vertex added on a keyframed path is added on every keyframe');
  h.do(C.setKeyframes(sid, vid, 'masks.m1.path', [{ t: 0, v: E, ease: 'linear' }, { t: 10 * F, v: E2, ease: 'linear' }]));
  h.do(C.setKeyframes(sid, vid, 'masks.m1.feather', [{ t: 0, v: 0, ease: 'linear' }, { t: 10 * F, v: 40, ease: 'linear' }]));
  const item = compositor.plan(h.project, seqOf(), 5 * F)[0].item;
  check(item.masks?.length === 1 && near(item.masks[0].feather, 20, 1e-9) && near(item.masks[0].path[0], (E[0] + E2[0]) / 2, 1e-12), 'the plan item carries Opacity\'s masks with their values at t (path and feather keyframes half way)');
  // an effect's masks
  const fx = h.do(C.addEffect(sid, vid, 'blur.gaussian', null, { blurriness: 20 }));
  const fm = h.do(C.addMask(sid, vid, { path: M.polygon(1920, 1080), feather: 0 }, { effectId: fx.id }));
  check(fm.id === 'm2' && clip().effects[0].masks[0].id === 'm2', 'mask ids are unique across Opacity and the effects (m2)');
  h.do(C.setKeyframes(sid, vid, `effects.${fx.id}.masks.m2.expansion`, [{ t: 0, v: 0, ease: 'linear' }, { t: 10 * F, v: 30, ease: 'linear' }]));
  const it2 = compositor.plan(h.project, seqOf(), 5 * F)[0].item;
  check(it2.effects[0].masks?.length === 1 && near(it2.effects[0].masks[0].expansion, 15, 1e-9), 'the effect in the plan carries its masks with their values at t');
  h.do(C.setMask(sid, vid, 'm2', { mode: 'none' }, { effectId: fx.id }));
  check(compositor.plan(h.project, seqOf(), 5 * F)[0].item.effects[0].masks === null, 'an effect whose masks are all None is drawn whole (no masks in the plan)');
  h.do(C.setMask(sid, vid, 'm2', { mode: 'add', inverted: true, opacity: 70 }, { effectId: fx.id }));
  check(clip().effects[0].masks[0].inverted === true && clip().effects[0].masks[0].opacity === 70, 'setMask changes a mask\'s fields');
  // refusals
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  const before = h.serialize();
  check(code(() => h.do(C.addMask(sid, aid, { path: M.polygon(16, 9) }))) === 'notVideo', 'a mask on an audio clip is refused (notVideo)');
  const ext = h.do(C.addEffect(sid, vid, 'edge.extend'));
  check(code(() => h.do(C.addMask(sid, vid, { path: M.polygon(16, 9) }, { effectId: ext.id }))) === 'noMasks', 'Edge Extend takes no masks (noMasks)');
  h.undo();
  check(code(() => h.do(C.addMask(sid, vid, { path: [0.1, 0.1, 0, 0, 0, 0] }))) === 'invalid' && code(() => h.do(C.setMask(sid, vid, 'm1', { feather: -1 }))) === 'invalid' && code(() => h.do(C.setMask(sid, vid, 'm1', { mode: 'lighten' }))) === 'invalid', 'a path of fewer than three vertices, a negative feather and an unknown mode are refused');
  check(code(() => h.do(C.setKeyframes(sid, vid, 'masks.m1.path', [{ t: 0, v: [1, 2, 3], ease: 'linear' }]))) !== null && code(() => h.do(C.setKeyframes(sid, vid, 'masks.m9.path', [{ t: 0, v: E, ease: 'linear' }]))) !== null, 'keyframes of a bad path value or of a missing mask are refused');
  check(h.serialize() === before, 'and none of the refusals changed the project');
  const many = h.serialize();
  let n = clip().masks.length;
  while (n < M.MAX_MASKS) { h.do(C.addMask(sid, vid, { path: M.polygon(16, 9) })); n++; }
  check(code(() => h.do(C.addMask(sid, vid, { path: M.polygon(16, 9) }))) === 'tooMany', `at most ${M.MAX_MASKS} masks a list (tooMany)`);
  while (h.serialize() !== many) h.undo();
  // removing a mask takes its keyframes; undo puts back exactly
  const withMask = h.serialize();
  h.do(C.removeMask(sid, vid, 'm1'));
  check(clip().masks === undefined && !Object.keys(clip().keyframes).some((p) => p.startsWith('masks.m1.')), 'removeMask takes the mask and its keyframes (the empty list goes)');
  h.undo();
  check(h.serialize() === withMask, 'undo of removeMask gives the project back exactly');
  h.do(C.removeEffect(sid, vid, fx.id));
  check(!Object.keys(clip().keyframes).some((p) => p.startsWith(`effects.${fx.id}.`)), 'removeEffect takes its masks\' keyframes along');
  h.undo();
  // razor, paste, freeze frame
  const r2 = h.do(C.split(sid, 5 * F, { clipIds: [vid], linked: false }));
  const right = seqOf().clips.find((c) => c.id === r2.ids.find((x) => x !== vid && seqOf().clips.find((c) => c.id === x)?.track === 'V1'));
  check(right?.masks?.length === 1 && right.effects[0].masks?.length === 1 && right.keyframes['masks.m1.path']?.[0].t === 0 && near(right.keyframes['masks.m1.path'][0].v[0], (E[0] + E2[0]) / 2, 1e-12), 'the right part of a razored clip keeps the masks and continues the path keyframes from the cut');
  h.undo();
  const copy = model.clone({ ...clip(), kind: 'video' });
  const pr = h.do(C.paste(sid, [copy], { at: 20 * SEC, video: 'V2', audio: null }));
  const pasted = seqOf().clips.find((c) => c.id === pr.ids[0]);
  check(S(pasted.masks) === S(clip().masks) && S(pasted.effects[0].masks) === S(clip().effects[0].masks) && S(pasted.keyframes['masks.m1.path']) === S(clip().keyframes['masks.m1.path']), 'paste carries Opacity\'s masks, the effects\' masks and their keyframes');
  h.undo();
  const fz = h.do(C.freezeFrame(sid, vid, 2 * SEC));
  check(S(seqOf().clips.find((c) => c.id === fz.id).masks) === S(clip().masks), 'a freeze frame keeps the clip\'s masks');
  h.undo();
  check(model.validate(h.project).ok, 'the mask test project is valid');
  check(M.parsePath('masks.m1.inverted') === null && M.parsePath('effects.e1.masks.m2.mode', true)?.field === 'mode' && M.parsePath('effects.e1.masks.m2.path')?.effectId === 'e1' && model.validPropPath(clip(), 'video', 'masks.m1.feather') && !model.validPropPath(clip(), 'video', 'masks.m1.inverted'),
    'mask paths: path, feather, opacity and expansion keyframe; mode and inverted are mask fields Effect Controls writes but do not keyframe');

  // ---- save and open, migrate, validate ----
  const back = model.migrate(h.serialize());
  check(back.version === model.VERSION && model.VERSION >= 4 && model.validate(back).ok && S(back.sequences[0].clips.find((c) => c.id === vid).masks) === S(clip().masks) && S(back.sequences[0].clips.find((c) => c.id === vid).keyframes) === S(clip().keyframes), 'a project with masks saves and opens as it was (the current format version)');
  check(code(() => model.migrate({ format: 'ncut', version: model.VERSION + 1 })) === 'newer', 'a file of a newer version is refused as newer');
  const v3 = JSON.parse(h.serialize());
  v3.version = 3;
  for (const s of v3.sequences) for (const c of s.clips) { delete c.masks; for (const e of c.effects) delete e.masks; for (const p of Object.keys(c.keyframes)) if (p.includes('masks.')) delete c.keyframes[p]; }
  const m3 = model.migrate(v3);
  check(model.validate(m3).ok && m3.version === model.VERSION && m3.sequences[0].clips.every((c) => c.masks === undefined), 'a version 3 file opens with no masks');
  const bad = JSON.parse(h.serialize());
  const bc = bad.sequences[0].clips.find((c) => c.id === vid);
  bc.masks[0].path = [0.1, 0.2];
  bc.masks.push({ id: 'm7', path: M.polygon(16, 9) });
  bc.effects[0].masks[0].mode = 'lighten';
  bc.keyframes['masks.m7.feather'] = [{ t: 0, v: 'soft', ease: 'linear' }, { t: F, v: 5, ease: 'linear' }];
  bc.keyframes['masks.m8.path'] = [{ t: 0, v: E, ease: 'linear' }];
  bad.sequences[0].clips.find((c) => c.id === aid).masks = [{ id: 'm1', path: M.polygon(16, 9) }];
  const mb = model.migrate(bad);
  const mc = mb.sequences[0].clips.find((c) => c.id === vid);
  check(model.validate(mb).ok && S(mc.masks.map((m) => [m.id, m.feather, m.mode])) === S([['m7', 10, 'add']]) && mc.effects[0].masks === undefined
    && !mc.keyframes['masks.m1.path'] && S(mc.keyframes['masks.m7.feather'].map((x) => x.v)) === '[5]' && !mc.keyframes['masks.m8.path'] && mb.sequences[0].clips.find((c) => c.id === aid).masks === undefined,
  `migrate: a damaged path and an unknown mode go with their keyframes, a short mask gets the defaults, a bad keyframe value and a missing mask's keyframes go, masks on an audio clip go (${S(mc.masks.map((m) => m.id))})`);
  const refuse = (fn) => { const p = JSON.parse(h.serialize()); fn(p.sequences[0].clips.find((c) => c.id === vid), p); return model.validate(p).ok; };
  check(!refuse((c) => { c.masks[0].feather = 2000; }) && !refuse((c) => { c.effects[0].masks[0].id = 'm1'; }) && !refuse((c) => { c.masks = []; }) && !refuse((c, p) => { p.sequences[0].clips.find((x) => x.id === aid).masks = c.masks; })
    && !refuse((c) => { c.keyframes['masks.m1.opacity'] = [{ t: 0, v: 150, ease: 'linear' }]; }), 'validate refuses a feather out of range, an id twice, an empty list, masks on an audio clip, an opacity keyframe over 100');
}

// ---- the plan of a masked nest clip and of a masked remapped clip ----
{
  const ph = C.createHistory(model.createProject(), { limit: Infinity });
  const ps = ph.project.sequences[0].id;
  const { ids: [pm] } = ph.do(C.importMedia([{ path: 'D:/a.mp4', name: 'a.mp4', kind: 'video', duration: 60 * SEC, video: VID, audio: null }]));
  const q1 = ph.do(C.place(ps, { source: { media: pm }, in: 10 * SEC, out: 12 * SEC, at: SEC, video: 'V1', audio: null })).ids[0];
  ph.do(C.addMask(ps, q1, { path: M.polygon(1920, 1080), feather: 0 }));
  const { ids: [n1] } = ph.do(C.nest(ps, [q1], { name: 'Nested Sequence 1' }));
  const E = M.ellipse(1920, 1080);
  ph.do(C.addMask(ps, n1, { path: E, feather: 30 }));
  const fx = ph.do(C.addEffect(ps, n1, 'color.basic', null, { saturation: 0 }));
  ph.do(C.addMask(ps, n1, { path: E, inverted: true }, { effectId: fx.id }));
  ph.do(C.setKeyframes(ps, n1, 'masks.m1.opacity', [{ t: 0, v: 0, ease: 'linear' }, { t: SEC, v: 100, ease: 'linear' }]));
  const outer = () => ph.project.sequences.find((s) => s.id === ps);
  const N = compositor.plan(ph.project, outer(), SEC + SEC / 2)[0].item;
  check(N.kind === 'nest' && N.masks?.length === 1 && near(N.masks[0].opacity, 50, 1e-9) && N.masks[0].feather === 30 && N.effects[0].masks?.[0].inverted === true, 'plan: a nest clip\'s own masks (Opacity\'s and Lumetri Color\'s) are on the nest item with their values at t');
  check(N.layers.length === 1 && N.layers[0].item.masks?.length === 1 && N.layers[0].item.masks[0].feather === 0 && N.layers[0].item.key === `${n1}/${q1}`, 'plan: the clip inside the nest keeps its own mask in the nested layers');
  check(model.validate(ph.project).ok, 'the nest mask project is valid');
  // a remapped clip: mask keyframes are clip time, whatever source time the curve shows
  const rh = C.createHistory(model.createProject(), { limit: Infinity });
  const rs = rh.project.sequences[0].id;
  const { ids: [rm] } = rh.do(C.importMedia([{ path: 'D:/b.mp4', name: 'b.mp4', kind: 'video', duration: 60 * SEC, video: VID, audio: null }]));
  const rc = rh.do(C.place(rs, { source: { media: rm }, in: 0, out: 4 * SEC, at: 0, video: 'V1', audio: null })).ids[0];
  rh.do(C.setRemap(rs, rc, R.setSegmentSpeed(R.addKey(model.remapOf(rh.project.sequences[0].clips[0]), SEC), 1, 0.5, F)));
  rh.do(C.addMask(rs, rc, { path: E }));
  rh.do(C.setKeyframes(rs, rc, 'masks.m1.expansion', [{ t: 0, v: 0, ease: 'linear' }, { t: 2 * SEC, v: 100, ease: 'linear' }]));
  const at = (t) => compositor.plan(rh.project, rh.project.sequences[0], t)[0].item;
  const a = at(SEC + SEC / 2);
  check(a.clip.remap && near(a.srcT, SEC + SEC / 4, 1) && near(a.masks[0].expansion, 75, 1e-9) && a.frameIndex === 45, `plan: a masked remapped clip reads its source through the curve (${(a.srcT / SEC).toFixed(3)} s at 1.5 s) and its mask keyframes at clip time (expansion ${a.masks[0].expansion})`);
  check(model.validate(rh.project).ok, 'the remapped mask project is valid');
}

// ---- page scripts, strings ----
{
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, Error, Float32Array, Float64Array, Uint8Array, Uint32Array, Promise, RegExp };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const base = new URL(dir, import.meta.url);
  const order = readFileSync(new URL('index.js', base), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  check(order.indexOf('keyframes.js') < order.indexOf('masks.js') && order.indexOf('masks.js') < order.indexOf('compositor.js') && order.indexOf('ui-masks.js') > order.indexOf('ui-controls.js'), 'index.js loads masks.js after keyframes.js and before the compositor, ui-masks.js after Effect Controls');
  for (const f of ['time.js', 'keyframes.js', 'masks.js']) vm.runInContext(readFileSync(new URL(f, base), 'utf8'), page, { filename: f });
  const out = vm.runInContext(`(() => { const m = Cut.masks.full({ id: 'm1', path: Cut.masks.polygon(20, 10), feather: 0 }); return [Cut.masks.coverage([m], 20, 10)[5 * 20 + 10], Cut.masks.at({ keyframes: {} }, 'masks', [m], 0).length]; })()`, page);
  check(S(out) === '[1,1]', `masks.js works as a page script through globalThis.Cut (${S(out)})`);
  const ko = JSON.parse(readFileSync(new URL(`${dir}locales/ko.json`, import.meta.url), 'utf8'));
  const src = readFileSync(new URL(`${dir}commands.js`, import.meta.url), 'utf8');
  const msgs = ['Masks go on video clips.', 'This effect takes no masks.', 'There are as many masks as there can be.'].filter((m) => src.includes(`'${m}'`));
  check(msgs.length === 3 && msgs.every((m) => ko[m]), 'the mask refusals are in commands.js and translated in ko.json');
  const terms = { Mask: '마스크', 'Mask Path': '마스크 패스', 'Mask Feather': '마스크 페더', 'Mask Expansion': '마스크 확장', Inverted: '반전됨', 'Create ellipse mask': '타원 마스크 만들기', 'Create 4-point polygon mask': '4포인트 다각형 마스크 만들기', 'Free draw bezier': '자유 그리기 베지어' };
  check(Object.entries(terms).every(([k, v]) => ko[k] === v), 'the Korean names are Premiere Pro\'s (마스크, 마스크 패스, 마스크 페더, 마스크 확장, 반전됨, 타원 마스크 만들기, 4포인트 다각형 마스크 만들기, 자유 그리기 베지어)');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
