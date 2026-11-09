// Graphic clips of Nano Studio Cut (`source: { generator: 'graphic', layers }`): motion graphics drawn from a list of
// layers into a Canvas 2D context, which the compositor uploads as the clip's picture (like a text clip's). The layers
// are data an AI or a person writes: shapes (rect, ellipse, polygon, star, line, an SVG path), text, groups and
// particles, each with a transform, a fill (a color or a gradient), a stroke that can be trimmed (a line drawing
// itself), a shadow, a blur, a blend mode and repeated copies. Every number, pair and color field can be animated with
// keyframes on `layers.<id>.<field>` of the clip (keyframes.js); FIELDS says which.
//
// Coordinates are sequence pixels with the origin at the frame's center, y down. A layer's own geometry (a rect's
// size, a path's points) is around its origin; `position` places that origin, `anchor` is the point of the geometry
// it turns and scales around, and a layer with `parent` (a group earlier in the list) moves with that group. Layers
// draw in list order, the first at the bottom. Rotation is in degrees clockwise, scale in %, opacity in %.
//
// `trimStart`, `trimEnd` (0..100, % of the outline's length) and `trimOffset` (% added to both, wrapping) cut the
// stroke; the fill is not trimmed. `repeatCount` draws copies, each moved by `repeatOffset`, turned by
// `repeatRotation` and scaled by `repeatScale` more than the one before, the last one's opacity `repeatOpacity`.
// Particles are a deterministic stream (or one burst) from an emitter area: the same frame always draws the same.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).graphic = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);

  const KINDS = ['rect', 'ellipse', 'polygon', 'star', 'line', 'path', 'text', 'group', 'particles'];
  const BLENDS = { normal: 'source-over', add: 'lighter', screen: 'screen', multiply: 'multiply', overlay: 'overlay', lighten: 'lighten', darken: 'darken' };
  const MAX_LAYERS = 200;
  const MAX_WORK = 20000; // shapes drawn a frame: every layer's copies, times its particles
  const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  const FALLBACK = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

  // field -> [type, default, more]. Types: num (more: [min, max]), int ([min, max]), pair ([min, max] per element),
  // color, color? (or null), enum (more: the values), bool, str (more: max length), id? (a layer id or null),
  // gradient? (or null), dash? ([dash, gap] or null). num, int, pair and color fields animate.
  const P = 20000;
  const FIELDS = {
    name: ['str', '', 80],
    parent: ['id?', null],
    visible: ['bool', true],
    position: ['pair', [0, 0], [-P, P]],
    anchor: ['pair', [0, 0], [-P, P]],
    scale: ['pair', [100, 100], [-10000, 10000]],
    rotation: ['num', 0, [-36000, 36000]],
    opacity: ['num', 100, [0, 100]],
    blend: ['enum', 'normal', Object.keys(BLENDS)],
    blur: ['num', 0, [0, 500]],
    shadowColor: ['color?', null],
    shadowBlur: ['num', 0, [0, 500]],
    shadowOffset: ['pair', [0, 0], [-2000, 2000]],
    repeatCount: ['int', 1, [1, 500]],
    repeatOffset: ['pair', [0, 0], [-P, P]],
    repeatRotation: ['num', 0, [-3600, 3600]],
    repeatScale: ['pair', [100, 100], [1, 1000]],
    repeatOpacity: ['num', 100, [0, 100]],
    fill: ['color?', '#ffffff'],
    gradient: ['gradient?', null],
    stroke: ['color?', null],
    strokeWidth: ['num', 0, [0, 2000]],
    cap: ['enum', 'round', ['butt', 'round', 'square']],
    join: ['enum', 'round', ['miter', 'round', 'bevel']],
    dash: ['dash?', null],
    trimStart: ['num', 0, [0, 100]],
    trimEnd: ['num', 100, [0, 100]],
    trimOffset: ['num', 0, [-100000, 100000]],
    size: ['pair', [400, 200], [0, P]],
    radius: ['num', 0, [0, P]],
    innerRadius: ['num', 50, [0, P]],
    points: ['int', 5, [3, 64]],
    from: ['pair', [-200, 0], [-P, P]],
    to: ['pair', [200, 0], [-P, P]],
    d: ['str', '', 20000],
    text: ['str', 'Text', 2000],
    font: ['str', '', 120],
    fontSize: ['num', 80, [4, 1000]],
    weight: ['int', 700, [100, 900]],
    italic: ['bool', false],
    align: ['enum', 'center', ['left', 'center', 'right']],
    lineHeight: ['num', 1.2, [0.5, 4]],
    letterSpacing: ['num', 0, [-100, 500]],
    value: ['num', 0, [-1e12, 1e12]],
    decimals: ['int', 0, [0, 6]],
    reveal: ['num', 1, [0, 1]],
    count: ['int', 60, [1, 2000]],
    seed: ['int', 1, [0, 1e9]],
    emit: ['enum', 'stream', ['stream', 'burst']],
    emitter: ['pair', [0, 0], [0, P]],
    direction: ['num', 0, [-36000, 36000]],
    spread: ['num', 360, [0, 360]],
    speed: ['num', 300, [0, P]],
    speedVariation: ['num', 30, [0, 100]],
    gravity: ['pair', [0, 0], [-P, P]],
    life: ['num', 2, [0.05, 60]],
    particleSize: ['num', 12, [0.1, 2000]],
    particleSizeEnd: ['num', 4, [0, 2000]],
    fillEnd: ['color?', null],
    opacityEnd: ['num', 0, [0, 100]],
    particleShape: ['enum', 'circle', ['circle', 'square']],
    spin: ['num', 0, [-36000, 36000]],
  };
  const COMMON = ['name', 'parent', 'visible', 'position', 'anchor', 'scale', 'rotation', 'opacity', 'blend', 'blur', 'shadowColor', 'shadowBlur', 'shadowOffset', 'repeatCount', 'repeatOffset', 'repeatRotation', 'repeatScale', 'repeatOpacity'];
  const PAINT = ['fill', 'gradient', 'stroke', 'strokeWidth', 'cap', 'join', 'dash', 'trimStart', 'trimEnd', 'trimOffset'];
  const OWN = {
    rect: ['size', 'radius', ...PAINT],
    ellipse: ['size', ...PAINT],
    polygon: ['points', 'radius', ...PAINT],
    star: ['points', 'radius', 'innerRadius', ...PAINT],
    line: ['from', 'to', 'stroke', 'strokeWidth', 'cap', 'dash', 'trimStart', 'trimEnd', 'trimOffset'],
    path: ['d', ...PAINT],
    text: ['text', 'font', 'fontSize', 'weight', 'italic', 'align', 'lineHeight', 'letterSpacing', 'value', 'decimals', 'reveal', 'fill', 'gradient', 'stroke', 'strokeWidth', 'join'],
    group: [],
    particles: ['count', 'seed', 'emit', 'emitter', 'direction', 'spread', 'speed', 'speedVariation', 'gravity', 'life', 'particleSize', 'particleSizeEnd', 'fill', 'fillEnd', 'opacityEnd', 'particleShape', 'spin'],
  };
  // A group passes on its transform, opacity and visibility; its children draw their own blend, blur and shadow.
  const GROUP = ['name', 'parent', 'visible', 'position', 'anchor', 'scale', 'rotation', 'opacity'];
  const fieldsOf = (kind) => (kind === 'group' ? GROUP : [...COMMON, ...(OWN[kind] || [])]);
  // Defaults that differ by kind.
  const KIND_DEFAULTS = {
    ellipse: { size: [200, 200] },
    polygon: { points: 6, radius: 120 },
    star: { points: 5, radius: 120, innerRadius: 55 },
    line: { stroke: '#ffffff', strokeWidth: 8 },
    path: { fill: null, stroke: '#ffffff', strokeWidth: 6 },
  };
  const ANIMATED = new Set(Object.keys(FIELDS).filter((f) => ['num', 'int', 'pair', 'color', 'color?'].includes(FIELDS[f][0])));

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // ---------- checking ----------
  // '' when value fits field, else what is wrong (for a sentence that starts with the field's name).
  function checkValue(field, v) {
    const f = FIELDS[field];
    if (!f) return 'is not a field';
    const [type, , more] = f;
    const range = () => (more ? ` from ${more[0]} to ${more[1]}` : '');
    switch (type) {
      case 'num': return isNum(v) && v >= more[0] && v <= more[1] ? '' : `must be a number${range()}`;
      case 'int': return Number.isInteger(v) && v >= more[0] && v <= more[1] ? '' : `must be a whole number${range()}`;
      case 'pair': return Array.isArray(v) && v.length === 2 && v.every((x) => isNum(x) && x >= more[0] && x <= more[1]) ? '' : `must be [x, y], each${range()}`;
      case 'color': return typeof v === 'string' && COLOR.test(v) ? '' : 'must be a color #rrggbb or #rrggbbaa';
      case 'color?': return v === null || (typeof v === 'string' && COLOR.test(v)) ? '' : 'must be a color #rrggbb or #rrggbbaa, or null';
      case 'enum': return more.includes(v) ? '' : `must be one of ${more.join(', ')}`;
      case 'bool': return typeof v === 'boolean' ? '' : 'must be true or false';
      case 'str': return typeof v === 'string' && v.length <= more ? '' : `must be text of at most ${more} characters`;
      case 'id?': return v === null || (typeof v === 'string' && /^[\w-]{1,40}$/.test(v)) ? '' : 'must be a layer id or null';
      case 'dash?': return v === null || (Array.isArray(v) && v.length === 2 && v.every((x) => isNum(x) && x >= 0 && x <= P) && v[0] + v[1] > 0) ? '' : 'must be [dash, gap] in pixels, or null';
      case 'gradient?': return v === null ? '' : gradientError(v);
      default: return 'is not a field';
    }
  }
  function gradientError(g) {
    if (!isObj(g)) return 'must be {type, from, to, stops} or null';
    for (const k of Object.keys(g)) if (!['type', 'from', 'to', 'stops'].includes(k)) return `has no field ${k} (type, from, to, stops)`;
    if (!['linear', 'radial'].includes(g.type)) return 'type must be linear or radial';
    for (const k of ['from', 'to']) if (!Array.isArray(g[k]) || g[k].length !== 2 || !g[k].every((x) => isNum(x) && Math.abs(x) <= P)) return `${k} must be [x, y] in the layer's pixels`;
    if (!Array.isArray(g.stops) || g.stops.length < 2 || g.stops.length > 16) return 'stops must be 2 to 16 [offset 0..1, color]';
    for (const s of g.stops) if (!Array.isArray(s) || s.length !== 2 || !isNum(s[0]) || s[0] < 0 || s[0] > 1 || typeof s[1] !== 'string' || !COLOR.test(s[1])) return 'each stop must be [offset 0..1, "#rrggbb" or "#rrggbbaa"]';
    return '';
  }

  // The problems of a layer list, as sentences (at most 20); [] when it is good. Ids must be unique, a parent must be a
  // group earlier in the list, a path's d must parse.
  function validate(layers) {
    const out = [];
    const bad = (m) => { if (out.length < 20) out.push(m); };
    if (!Array.isArray(layers)) return ['layers must be a list'];
    if (layers.length > MAX_LAYERS) bad(`a graphic has at most ${MAX_LAYERS} layers`);
    const work = layers.reduce((n, l) => n + (isObj(l) ? (Number.isInteger(l.repeatCount) ? l.repeatCount : 1) * (l.kind === 'particles' ? (Number.isInteger(l.count) ? l.count : 60) : 1) : 0), 0);
    if (work > MAX_WORK) bad(`the layers draw ${work} shapes a frame (copies × particles); at most ${MAX_WORK}`);
    const seen = new Map();
    layers.forEach((l, i) => {
      const at = `layers[${i}]`;
      if (!isObj(l)) { bad(`${at} must be an object`); return; }
      if (typeof l.id !== 'string' || !/^[\w-]{1,40}$/.test(l.id)) bad(`${at}.id must be a short id (letters, digits, _ or -)`);
      else if (seen.has(l.id)) bad(`${at}.id ${l.id} is used twice`);
      if (!KINDS.includes(l.kind)) { bad(`${at}.kind must be one of ${KINDS.join(', ')}`); return; }
      const own = fieldsOf(l.kind);
      for (const [k, v] of Object.entries(l)) {
        if (k === 'id' || k === 'kind') continue;
        if (!own.includes(k)) { bad(`${at} (${l.kind}) has no field ${k}`); continue; }
        const e = checkValue(k, v);
        if (e) bad(`${at}.${k} ${e}`);
      }
      if (l.parent != null) {
        const p = seen.get(l.parent);
        if (!p) bad(`${at}.parent ${l.parent} must be a group earlier in the list`);
        else if (p.kind !== 'group') bad(`${at}.parent ${l.parent} is a ${p.kind}, not a group`);
      }
      if (l.kind === 'path') {
        if (typeof l.d !== 'string' || !l.d.trim()) bad(`${at}.d needs SVG path data`);
        else { const e = parsePath(l.d).error; if (e) bad(`${at}.d: ${e}`); }
      }
      if (typeof l.id === 'string') seen.set(l.id, l);
    });
    return out;
  }

  // A layer with every field of its kind: the given values over the defaults. Fields of other kinds are dropped.
  function normalize(layer) {
    const kind = KINDS.includes(layer?.kind) ? layer.kind : 'rect';
    const out = { id: layer?.id, kind };
    for (const f of fieldsOf(kind)) {
      const d = KIND_DEFAULTS[kind]?.[f] !== undefined ? KIND_DEFAULTS[kind][f] : FIELDS[f][1];
      const v = layer && layer[f] !== undefined ? layer[f] : d;
      out[f] = Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x.slice() : x)) : isObj(v) ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }
  // The fields that differ from the defaults (what get_clip shows).
  function compact(layer) {
    const n = normalize(layer);
    const ref = normalize({ id: layer.id, kind: n.kind });
    const out = { id: n.id, kind: n.kind };
    for (const f of fieldsOf(n.kind)) if (JSON.stringify(n[f]) !== JSON.stringify(ref[f])) out[f] = n[f];
    return out;
  }

  // ---------- SVG path data ----------
  // -> {subpaths: [{cmds: [['M', x, y] | ['L', x, y] | ['C', x1, y1, x2, y2, x, y] | ['Q', x1, y1, x, y]], closed}],
  // error}. Absolute and relative M L H V C S Q T Z; arcs (A) are refused.
  function parsePath(d) {
    const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const rest = String(d).replace(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[\s,]/g, '');
    if (rest) return { subpaths: [], error: `unexpected "${rest.slice(0, 10)}"` };
    const subpaths = [];
    let cur = null;
    let x = 0, y = 0, sx = 0, sy = 0, lc = null, lq = null, cmd = null, i = 0;
    const num = () => { const v = Number(tokens[i++]); if (!Number.isFinite(v)) throw new Error(`a number is missing after ${cmd}`); return v; };
    const start = () => { if (!cur) { cur = { cmds: [['M', x, y]], closed: false }; subpaths.push(cur); } };
    try {
      while (i < tokens.length) {
        if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
        else if (!cmd) throw new Error('path data must start with M');
        else if (cmd === 'M') cmd = 'L';
        else if (cmd === 'm') cmd = 'l';
        const rel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();
        const ox = rel ? x : 0, oy = rel ? y : 0;
        if (C === 'A') throw new Error('arcs (A) are not supported; draw them with C curves or use an ellipse layer');
        if (!'MLHVCSQTZ'.includes(C)) throw new Error(`unknown command ${cmd}`);
        if (C === 'Z') { if (cur) { cur.closed = true; x = sx; y = sy; cur = null; } lc = lq = null; if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) throw new Error('a number after Z'); cmd = null; continue; }
        if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; cur = { cmds: [['M', x, y]], closed: false }; subpaths.push(cur); lc = lq = null; continue; }
        start();
        if (C === 'L') { x = ox + num(); y = oy + num(); cur.cmds.push(['L', x, y]); lc = lq = null; }
        else if (C === 'H') { x = ox + num(); cur.cmds.push(['L', x, y]); lc = lq = null; }
        else if (C === 'V') { y = (rel ? y : 0) + num(); cur.cmds.push(['L', x, y]); lc = lq = null; }
        else if (C === 'C') { const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]; cur.cmds.push(['C', ...a]); lc = [a[2], a[3]]; lq = null; x = a[4]; y = a[5]; }
        else if (C === 'S') { const c1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y]; const a = [ox + num(), oy + num(), ox + num(), oy + num()]; cur.cmds.push(['C', c1[0], c1[1], ...a]); lc = [a[0], a[1]]; lq = null; x = a[2]; y = a[3]; }
        else if (C === 'Q') { const a = [ox + num(), oy + num(), ox + num(), oy + num()]; cur.cmds.push(['Q', ...a]); lq = [a[0], a[1]]; lc = null; x = a[2]; y = a[3]; }
        else if (C === 'T') { const q = lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y]; const a = [ox + num(), oy + num()]; cur.cmds.push(['Q', q[0], q[1], ...a]); lq = q; lc = null; x = a[0]; y = a[1]; }
      }
    } catch (err) { return { subpaths: [], error: err.message }; }
    if (!subpaths.length) return { subpaths: [], error: 'the path draws nothing' };
    return { subpaths, error: '' };
  }

  // ---------- geometry ----------
  // A layer's outline as polylines [{pts: [[x, y]...], closed}] in its own pixels; `fine` is how many polyline points
  // per pixel of curve length (more when drawn larger).
  function outline(l, fine) {
    const seg = (len) => Math.max(4, Math.min(256, Math.ceil(len * fine / 3)));
    const ring = (n, at) => ({ pts: Array.from({ length: n }, (_, i) => at(i / n)), closed: true });
    switch (l.kind) {
      case 'rect': {
        const [w, h] = l.size;
        const r = Math.max(0, Math.min(l.radius, w / 2, h / 2));
        const x0 = -w / 2, y0 = -h / 2;
        if (r <= 0) return [{ pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], closed: true }];
        const n = seg((Math.PI * r) / 2);
        const pts = [];
        const corner = (cx, cy, a0) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * (Math.PI / 2); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
        corner(x0 + w - r, y0 + r, -Math.PI / 2);
        corner(x0 + w - r, y0 + h - r, 0);
        corner(x0 + r, y0 + h - r, Math.PI / 2);
        corner(x0 + r, y0 + r, Math.PI);
        return [{ pts, closed: true }];
      }
      case 'ellipse': {
        const [w, h] = l.size;
        const n = Math.max(24, seg((Math.PI * (w + h)) / 2));
        return [ring(n, (f) => [(w / 2) * Math.sin(f * 2 * Math.PI), (-h / 2) * Math.cos(f * 2 * Math.PI)])];
      }
      case 'polygon': return [ring(l.points, (f) => [l.radius * Math.sin(f * 2 * Math.PI), -l.radius * Math.cos(f * 2 * Math.PI)])];
      case 'star': return [ring(l.points * 2, (f) => { const r = Math.round(f * l.points * 2) % 2 ? l.innerRadius : l.radius; return [r * Math.sin(f * 2 * Math.PI), -r * Math.cos(f * 2 * Math.PI)]; })];
      case 'line': return [{ pts: [l.from.slice(), l.to.slice()], closed: false }];
      case 'path': {
        const out = [];
        for (const sp of parsePath(l.d).subpaths) {
          const pts = [];
          let px = 0, py = 0;
          for (const c of sp.cmds) {
            if (c[0] === 'M' || c[0] === 'L') { pts.push([c[1], c[2]]); [px, py] = [c[1], c[2]]; continue; }
            if (c[0] === 'C') {
              const n = seg(Math.hypot(c[1] - px, c[2] - py) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4]));
              for (let i = 1; i <= n; i++) {
                const t = i / n, u = 1 - t;
                pts.push([u * u * u * px + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5], u * u * u * py + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]]);
              }
              [px, py] = [c[5], c[6]];
            } else if (c[0] === 'Q') {
              const n = seg(Math.hypot(c[1] - px, c[2] - py) + Math.hypot(c[3] - c[1], c[4] - c[2]));
              for (let i = 1; i <= n; i++) {
                const t = i / n, u = 1 - t;
                pts.push([u * u * px + 2 * u * t * c[1] + t * t * c[3], u * u * py + 2 * u * t * c[2] + t * t * c[4]]);
              }
              [px, py] = [c[3], c[4]];
            }
          }
          out.push({ pts, closed: sp.closed });
        }
        return out;
      }
      default: return [];
    }
  }
  // The parts of the outline between fractions a and b of its whole length (a < b, both 0..1), as open polylines.
  function trimmed(polys, a, b) {
    const runs = polys.map((p) => (p.closed && p.pts.length ? [...p.pts, p.pts[0]] : p.pts));
    const lens = runs.map((pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; });
    const total = lens.reduce((s, x) => s + x, 0);
    if (total <= 0) return [];
    const from = a * total, to = b * total;
    const out = [];
    let base = 0;
    runs.forEach((pts, k) => {
      const lo = Math.max(from, base), hi = Math.min(to, base + lens[k]);
      if (hi > lo) {
        const part = [];
        let s = base;
        for (let i = 1; i < pts.length; i++) {
          const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          const at = (q) => { const f = d > 0 ? (q - s) / d : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]; };
          if (s + d >= lo && s <= hi) {
            if (!part.length) part.push(at(Math.max(lo, s)));
            part.push(at(Math.min(hi, s + d)));
          }
          s += d;
        }
        if (part.length > 1) out.push(part);
      }
      base += lens[k];
    });
    return out;
  }
  // The stroke's visible runs: [{pts, closed}] (whole polylines when nothing is trimmed).
  function strokeRuns(l, polys) {
    let a = l.trimStart / 100, b = l.trimEnd / 100;
    if (b < a) [a, b] = [b, a];
    if (a <= 0 && b >= 1) return polys;
    if (b - a <= 0) return [];
    let off = (l.trimOffset / 100) % 1;
    if (off < 0) off += 1;
    a += off; b += off;
    let parts;
    if (b <= 1) parts = trimmed(polys, a, b);
    else if (a >= 1) parts = trimmed(polys, a - 1, b - 1);
    else {
      const tail = trimmed(polys, a, 1), head = trimmed(polys, 0, b - 1);
      // one closed outline: the run goes on through its start, so the corner there keeps its join
      parts = polys.length === 1 && polys[0].closed && tail.length && head.length ? [...tail.slice(0, -1), [...tail.at(-1), ...head[0].slice(1)], ...head.slice(1)] : [...tail, ...head];
    }
    return parts.map((pts) => ({ pts, closed: false }));
  }

  // ---------- values at a time ----------
  // A keyframed number past its range (an ease that overshoots) at the range's edge; null when it is no number.
  function clampTo(f, v) {
    const [, , [lo, hi]] = FIELDS[f];
    const one = (x) => (isNum(x) ? Math.max(lo, Math.min(hi, x)) : null);
    if (Array.isArray(v)) { const p = v.map(one); return p.length === 2 && p.every((x) => x !== null) ? p : null; }
    return one(v);
  }
  const ROUND = new Set(Object.keys(FIELDS).filter((f) => FIELDS[f][0] === 'int'));
  // The layer as it is at clip time t (ticks from the clip's start): keyframed fields replace the static ones.
  function resolve(layer, clip, t) {
    const out = normalize(layer);
    const kfs = clip?.keyframes;
    if (!kfs) return out;
    const prefix = `layers.${layer.id}.`;
    const valueAt = need('keyframes').valueAt;
    for (const [prop, list] of Object.entries(kfs)) {
      if (!prop.startsWith(prefix) || !list?.length) continue;
      const f = prop.slice(prefix.length);
      if (!ANIMATED.has(f) || !(f in out)) continue;
      let v = valueAt(list, t, out[f]);
      if (ROUND.has(f) && isNum(v)) v = Math.round(v);
      if (checkValue(f, v) === '') out[f] = v;
      else if (FIELDS[f][0] !== 'color' && FIELDS[f][0] !== 'color?') { const c = clampTo(f, v); if (c !== null) out[f] = c; }
    }
    return out;
  }
  // Whether resolved layers change with time beyond their keyframes: a visible particle layer that still emits.
  const hasParticles = (layers, tSec = 0) => (layers || []).some((l) => l?.kind === 'particles' && l.visible !== false && l.opacity !== 0 && (l.emit !== 'burst' || tSec <= l.life));
  // The fonts the text layers name, for textrender.prepare.
  const fontsOf = (layers) => (layers || []).filter((l) => l?.kind === 'text').map((l) => ({ font: l.font || '', weight: l.weight ?? 700, italic: !!l.italic }));

  // ---------- drawing ----------
  const rad = (deg) => (deg * Math.PI) / 180;
  const quote = (family) => `"${String(family || '').replace(/["\\]/g, '')}"`;
  // A deterministic random number in 0..1 for (seed, i, j, k).
  function rand(seed, i, j, k) {
    let h = (seed * 374761393 + i * 668265263 + j * 2246822519 + k * 3266489917) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const full = (c) => (typeof c === 'string' && c.length === 7 ? `${c}ff` : c);
  const mix = (a, b, p) => (a && b ? need('keyframes').mix(full(a), full(b), p) : a || b);

  function paintOf(g, l) {
    if (!l.gradient) return l.fill;
    const gr = l.gradient;
    let p;
    if (gr.type === 'radial') p = g.createRadialGradient(gr.from[0], gr.from[1], 0, gr.from[0], gr.from[1], Math.max(0.001, Math.hypot(gr.to[0] - gr.from[0], gr.to[1] - gr.from[1])));
    else p = g.createLinearGradient(gr.from[0], gr.from[1], gr.to[0], gr.to[1]);
    for (const [o, c] of gr.stops) p.addColorStop(o, c);
    return p;
  }
  const tracePolys = (g, polys) => {
    g.beginPath();
    for (const p of polys) {
      if (!p.pts.length) continue;
      g.moveTo(p.pts[0][0], p.pts[0][1]);
      for (let i = 1; i < p.pts.length; i++) g.lineTo(p.pts[i][0], p.pts[i][1]);
      if (p.closed) g.closePath();
    }
  };
  function drawShape(g, l, polys) {
    const filled = l.kind !== 'line' && !!(l.fill || l.gradient);
    if (filled) { tracePolys(g, polys); g.fillStyle = paintOf(g, l); g.fill('nonzero'); }
    if (l.stroke && l.strokeWidth > 0) {
      const runs = strokeRuns(l, polys);
      if (!runs.length) return;
      if (filled) g.shadowColor = 'transparent';
      g.lineWidth = l.strokeWidth;
      g.lineCap = l.cap || 'round';
      g.lineJoin = l.join || 'round';
      g.setLineDash(l.dash ? l.dash : []);
      g.strokeStyle = l.stroke;
      tracePolys(g, runs);
      g.stroke();
      g.setLineDash([]);
    }
  }
  function drawText(g, l) {
    const fmt = (v) => { try { return new Intl.NumberFormat(undefined, { minimumFractionDigits: l.decimals, maximumFractionDigits: l.decimals }).format(v); } catch { return v.toFixed(l.decimals); } };
    let text = l.text.includes('{value}') ? l.text.split('{value}').join(fmt(l.value)) : l.text;
    if (l.reveal < 1) {
      const chars = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter().segment(text)].map((x) => x.segment) : Array.from(text);
      text = chars.slice(0, Math.round(chars.length * Math.max(0, l.reveal))).join('');
    }
    const lines = text.split('\n');
    g.font = `${l.italic ? 'italic ' : ''}${l.weight} ${l.fontSize}px ${l.font ? `${quote(l.font)}, ` : ''}${FALLBACK}`;
    if ('letterSpacing' in g) g.letterSpacing = `${l.letterSpacing}px`;
    g.textAlign = l.align;
    g.textBaseline = 'middle';
    const lh = l.fontSize * l.lineHeight;
    const y0 = -((lines.length - 1) * lh) / 2;
    if (l.stroke && l.strokeWidth > 0) {
      g.lineWidth = l.strokeWidth;
      g.lineJoin = l.join || 'round';
      g.strokeStyle = l.stroke;
      lines.forEach((s, i) => g.strokeText(s, 0, y0 + i * lh));
    }
    if (l.fill || l.gradient) {
      g.fillStyle = paintOf(g, l);
      lines.forEach((s, i) => g.fillText(s, 0, y0 + i * lh));
    }
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  }
  function drawParticles(g, l, tSec) {
    const n = l.count;
    for (let i = 0; i < n; i++) {
      let age, cycle;
      if (l.emit === 'burst') { age = tSec; cycle = 0; if (age > l.life) continue; }
      else {
        const born = (i / n) * l.life;
        if (tSec < born) continue;
        cycle = Math.floor((tSec - born) / l.life);
        age = tSec - born - cycle * l.life;
      }
      const r = (j) => rand(l.seed, i, cycle, j);
      const p = age / l.life;
      const a = rad(l.direction + (r(3) - 0.5) * l.spread);
      const v = l.speed * (1 + (r(4) - 0.5) * 2 * (l.speedVariation / 100));
      const x = (r(1) - 0.5) * l.emitter[0] + Math.sin(a) * v * age + 0.5 * l.gravity[0] * age * age;
      const y = (r(2) - 0.5) * l.emitter[1] - Math.cos(a) * v * age + 0.5 * l.gravity[1] * age * age;
      const size = l.particleSize + (l.particleSizeEnd - l.particleSize) * p;
      if (size <= 0) continue;
      g.globalAlpha = Math.max(0, Math.min(1, (1 + (l.opacityEnd / 100 - 1) * p))) * g.__alpha;
      g.fillStyle = l.fillEnd ? mix(l.fill || '#ffffff', l.fillEnd, p) : l.fill || '#ffffff';
      if (l.particleShape === 'square') {
        g.save();
        g.translate(x, y);
        g.rotate(rad(l.spin * age + r(5) * 360));
        g.fillRect(-size / 2, -size / 2, size, size);
        g.restore();
      } else {
        g.beginPath();
        g.arc(x, y, size / 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = g.__alpha;
  }

  // Applies a layer's transform (position, rotation, scale, anchor) to g.
  const transform = (g, l) => {
    g.translate(l.position[0], l.position[1]);
    g.rotate(rad(l.rotation));
    g.scale(l.scale[0] / 100, l.scale[1] / 100);
    g.translate(-l.anchor[0], -l.anchor[1]);
  };
  // Draws resolved layers (resolve()) into g. opts: {w, h (the frame in sequence pixels), scale (canvas pixels per
  // sequence pixel), t (seconds from the clip's start, for particles)}.
  function draw(g, layers, { w, h, scale = 1, t = 0 } = {}) {
    const byId = new Map(layers.map((l) => [l.id, l]));
    const chain = (l) => { const out = []; const seen = new Set(); for (let p = l.parent != null ? byId.get(l.parent) : null; p && !seen.has(p.id); p = p.parent != null ? byId.get(p.parent) : null) { seen.add(p.id); out.unshift(p); } return out; };
    for (const l of layers) {
      if (l.kind === 'group' || !l.visible) continue;
      const parents = chain(l);
      if (parents.some((p) => !p.visible)) continue;
      const alpha = [...parents, l].reduce((a, x) => a * (x.opacity / 100), 1);
      if (alpha <= 0) continue;
      const zoom = parents.reduce((z, x) => z * Math.max(Math.abs(x.scale[0]), Math.abs(x.scale[1])) / 100, Math.max(Math.abs(l.scale[0]), Math.abs(l.scale[1])) / 100);
      const unit = Math.max(0.05, scale * zoom);
      g.save();
      g.setTransform(scale, 0, 0, scale, (w / 2) * scale, (h / 2) * scale);
      for (const p of parents) transform(g, p);
      transform(g, l);
      g.globalCompositeOperation = BLENDS[l.blend] || 'source-over';
      if (l.blur > 0) g.filter = `blur(${l.blur * scale}px)`;
      if (l.shadowColor && (l.shadowBlur > 0 || l.shadowOffset[0] || l.shadowOffset[1])) {
        g.shadowColor = l.shadowColor;
        g.shadowBlur = l.shadowBlur * scale;
        g.shadowOffsetX = l.shadowOffset[0] * scale;
        g.shadowOffsetY = l.shadowOffset[1] * scale;
      }
      const copies = l.repeatCount || 1;
      const polys = l.kind === 'text' || l.kind === 'particles' ? null : outline(l, unit);
      for (let i = 0; i < copies; i++) {
        g.save();
        if (i > 0) {
          g.translate(l.anchor[0], l.anchor[1]);
          g.translate(l.repeatOffset[0] * i, l.repeatOffset[1] * i);
          g.rotate(rad(l.repeatRotation * i));
          g.scale((l.repeatScale[0] / 100) ** i, (l.repeatScale[1] / 100) ** i);
          g.translate(-l.anchor[0], -l.anchor[1]);
        }
        const fade = copies > 1 ? 1 + (l.repeatOpacity / 100 - 1) * (i / (copies - 1)) : 1;
        g.__alpha = alpha * fade;
        g.globalAlpha = g.__alpha;
        if (l.kind === 'text') drawText(g, l);
        else if (l.kind === 'particles') drawParticles(g, l, t);
        else drawShape(g, l, polys);
        g.restore();
      }
      g.restore();
    }
  }

  return { KINDS, FIELDS, BLENDS, MAX_LAYERS, ANIMATED, fieldsOf, checkValue, validate, normalize, compact, parsePath, outline, strokeRuns, resolve, draw, hasParticles, fontsOf, rand };
});
