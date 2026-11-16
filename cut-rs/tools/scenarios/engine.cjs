// The picture engine's pure parts for the Rust port (crates/cut-engine): effects.js's registry and uniforms with the
// values a Rust test cannot build in JSON (a LUT object from .cube text), lumetri.js, and compositor.plan summarized
// to plain data (no defs, no clip objects) so both sides can compare it field by field.
const path = require('node:path');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const fx = require(path.join(CUT, 'effects.js'));
const LU = require(path.join(CUT, 'lumetri.js'));
const compositor = require(path.join(CUT, 'compositor.js'));

const lutFrom = (cube) => (cube ? { ...LU.parseCube(cube), id: 'lut-test' } : null);

function item(it) {
  if (!it) return null;
  return {
    clip: it.clip.id, kind: it.kind, local: it.local, srcT: it.srcT, blend: it.blend, key: it.key, seqW: it.seqW, seqH: it.seqH,
    position: it.position, scale: it.scale, rotation: it.rotation, anchor: it.anchor, opacity: it.opacity, crop: it.crop,
    extend: it.extend, masks: it.masks, frameIndex: it.frameIndex,
    effects: it.effects.map((e) => ({ id: e.id, type: e.def.type, params: e.params, masks: e.masks })),
    layers: it.layers ? it.layers.map(layer) : null,
  };
}
function layer(l) {
  if (l.kind === 'clip') return { kind: 'clip', item: item(l.item) };
  return { kind: 'transition', type: l.def.type, params: l.params, progress: l.progress, a: item(l.a), b: item(l.b) };
}

module.exports = {
  resolve: (type, params) => fx.resolve(type, params),
  defaults: (type) => fx.defaults(type),
  categories: (kind) => fx.categories(kind),
  whiteBalance: (c) => fx.whiteBalance(c),
  bindings: (type) => fx.get(type).gpu?.bindings ?? null,
  uniforms: (type, params, info, cube) => fx.get(type).gpu.uniforms(fx.resolve(type, params), { ...info, assets: { lut: lutFrom(cube) } }),
  textureKeys: (type, params, cube) => {
    const t = fx.get(type).gpu.textures?.(fx.resolve(type, params), { assets: { lut: lutFrom(cube) } }) || {};
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v && { key: v.key, size: v.size, data: Array.from(v.data()) }]));
  },
  transition: (type, params, progress) => fx.get(type).gpu.uniforms(fx.resolve(type, params), progress),
  basic: (params, rgb) => {
    const p = fx.resolve('color.basic', params);
    const q = fx.cpu.basicPlan(p);
    return { plan: q, pixel: fx.cpu.basicPixel(rgb, q) };
  },
  // Lumetri Color's whole chain on one linear colour (the CPU reference the GPU output is compared with).
  lumetriPixel: (params, rgb, cube) => {
    const img = fx.cpu.image(1, 1, [...rgb, 1]);
    const out = fx.get('color.basic').cpu(img, fx.resolve('color.basic', params), { width: 1, height: 1, pxScale: 1, assets: { lut: lutFrom(cube) } });
    return Array.from(out.data);
  },
  // A video effect's CPU reference on a flat picture (w x h of one premultiplied linear colour): its pixels.
  effectCpu: (type, params, rgba, w, h, info) => {
    const img = fx.cpu.image(w, h, rgba);
    const out = fx.get(type).cpu(img, fx.resolve(type, params), { width: w, height: h, pxScale: 1, quality: 1, frame: 0, ...info });
    return Array.from(out.data);
  },
  lumetri: (fn, ...args) => {
    const v = LU[fn](...args);
    return v instanceof Float32Array || v instanceof Float64Array || v instanceof Uint16Array ? Array.from(v) : v;
  },
  parseCube: (text) => {
    try {
      const l = LU.parseCube(text);
      return { ...l, data: Array.from(l.data) };
    } catch (e) {
      return { $lut: e.message, params: e.params, code: e.code };
    }
  },
  hslPlan: (p) => {
    const q = LU.hslPlan(p);
    return { ...q, matrix: q.matrix };
  },
  sampleLut: (cube, s) => LU.sampleLut(lutFrom(cube), s),
  lutPixel: (cube, rgb, k) => LU.lutPixel(rgb, lutFrom(cube), k),
  lutHalf: (cube) => Array.from(LU.lutHalf(lutFrom(cube))),
  curvesPixel: (p, rgb) => LU.curvesPixel(rgb, LU.curvesTable(p)),
  store: (cube, name) => LU.store(LU.parseCube(cube), name),
  decode: (entry, id) => {
    const d = LU.decode(entry, id);
    return d && { ...d, data: Array.from(d.data) };
  },
  plan: (projectText, seqId, t) => {
    const project = JSON.parse(projectText);
    const seq = project.sequences.find((s) => s.id === seqId);
    return compositor.plan(project, seq, t).map(layer);
  },
  missingHandles: (projectText, seqId, tnId) => {
    const project = JSON.parse(projectText);
    const seq = project.sequences.find((s) => s.id === seqId);
    return compositor.missingHandles(project, seq, seq.transitions.find((x) => x.id === tnId));
  },
  captionsAt: (projectText, seqId, t, which) => {
    const project = JSON.parse(projectText);
    const seq = project.sequences.find((s) => s.id === seqId);
    return compositor.captionsAt(seq, t, which).map((c) => ({ t: c.t, items: c.items.map((x) => x.id) }));
  },
  extendedSourceTime: (clip, t, d) => compositor.extendedSourceTime(clip, t, d),
  fitScale: (...a) => compositor.fitScale(...a),
};
