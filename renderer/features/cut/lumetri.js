// The math of Lumetri Color's sections beyond the basic correction (docs/cut-architecture.md section 8): RGB curves,
// the creative LUT (.cube files: parsing, the copy kept in the project, trilinear lookup) and the HSL secondary
// (a hue, saturation and luma qualifier with a correction inside it). effects.js's color.basic (the Lumetri Color
// effect) runs them after the basic correction, in this order; its WGSL does the same math on the GPU and this file is
// the CPU reference the tests compare it with. Pure: Node and the page.
//
// Values: curves, the LUT and the qualifier work on the sRGB values the picture is shown with (0..1, as a colorist
// reads them); the corrections inside the qualifier work in linear light like the basic correction.
//
// A curve is a flat list of points [x0, y0, x1, y1, ...] in 0..1, x increasing, 2 to 16 points; between points it is a
// monotone cubic (Fritsch-Carlson, so it never overshoots between two points), flat beyond the first and the last.
// The GPU reads it from a table of TABLE entries per channel (master, red, green, blue) with linear steps between
// entries; the CPU reference reads the same table.
//
// A LUT in the project: project.luts[id] = { name, title, size, min: [r, g, b], max: [r, g, b], data } where data is
// base64 of little-endian float32 r, g, b triples, red changing fastest (the .cube order), and id is a hash of the
// numbers, so the same file loaded twice is stored once. The project carries it: it opens on any PC, with or without
// the .cube file.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).lumetri = api;
})(() => {
  const LUMA = [0.2126, 0.7152, 0.0722];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  // As the shaders' toSrgb / toLinear: negative values count as 0.
  const enc = (v) => linearToSrgb(Math.max(0, v));
  const dec = (v) => srgbToLinear(Math.max(0, v));

  // ---- curves ----------------------------------------------------------------------------------------------------

  const TABLE = 1024;
  const CURVE_PARAMS = ['curveMaster', 'curveRed', 'curveGreen', 'curveBlue'];
  const IDENTITY = [0, 0, 1, 1];
  const MAX_POINTS = 16;
  const MIN_GAP = 0.005;

  // [[x, y], ...] of a stored curve: numbers clamped to 0..1, sorted by x, points closer than MIN_GAP to the one
  // before dropped; anything unusable is the straight line.
  function points(flat) {
    if (!Array.isArray(flat) || flat.length < 4 || flat.length % 2 || !flat.every((v) => typeof v === 'number' && Number.isFinite(v))) return [[0, 0], [1, 1]];
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([clamp(flat[i], 0, 1), clamp(flat[i + 1], 0, 1)]);
    pts.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const p of pts) if (!out.length || p[0] - out[out.length - 1][0] >= MIN_GAP) out.push(p);
    if (out.length < 2) return [[0, 0], [1, 1]];
    return out.slice(0, MAX_POINTS);
  }
  const flatten = (pts) => pts.flatMap((p) => [p[0], p[1]]);
  const sanitize = (flat) => flatten(points(flat));

  // The slopes of the monotone cubic through pts (Fritsch-Carlson).
  function slopes(pts) {
    const n = pts.length;
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
      const h0 = pts[i][0] - pts[i - 1][0];
      const h1 = pts[i + 1][0] - pts[i][0];
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    return m;
  }
  // y of the curve through pts at x (pts from points()); m from slopes(pts).
  function evalCurve(pts, x, m = slopes(pts)) {
    const n = pts.length;
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > pts[i + 1][0]) i++;
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = x1 - x0;
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1];
    return clamp(y, 0, 1);
  }
  // The curve sampled at TABLE evenly spaced x in 0..1.
  function curveTable(flat) {
    const pts = points(flat);
    const m = slopes(pts);
    const t = new Float64Array(TABLE);
    for (let i = 0; i < TABLE; i++) t[i] = evalCurve(pts, i / (TABLE - 1), m);
    return t;
  }
  // Points on the diagonal from (0, 0) to (1, 1): the monotone cubic through them is the straight line.
  const isIdentityCurve = (flat) => {
    const pts = points(flat);
    return pts[0][0] === 0 && pts[pts.length - 1][0] === 1 && pts.every((p) => Math.abs(p[0] - p[1]) < 1e-9);
  };
  const curvesIdentity = (p) => CURVE_PARAMS.every((k) => isIdentityCurve(p[k]));
  const curveKey = (p) => `curves:${CURVE_PARAMS.map((k) => sanitize(p[k]).map((v) => v.toFixed(6)).join(',')).join('|')}`;

  // The four tables interleaved (master, red, green, blue per entry), kept for the last keys asked.
  const tables = new Map();
  function curvesTable(p) {
    const key = curveKey(p);
    let t = tables.get(key);
    if (t) { tables.delete(key); tables.set(key, t); return t; }
    const ch = CURVE_PARAMS.map((k) => curveTable(p[k]));
    t = new Float32Array(TABLE * 4);
    for (let i = 0; i < TABLE; i++) for (let c = 0; c < 4; c++) t[i * 4 + c] = ch[c][i];
    tables.set(key, t);
    if (tables.size > 32) tables.delete(tables.keys().next().value);
    return t;
  }
  // A table lookup as the shader does it: linear between the two entries around x (clamped to 0..1).
  function lookup(t, x, c) {
    const f = clamp(x, 0, 1) * (TABLE - 1);
    const i = Math.min(Math.floor(f), TABLE - 2);
    const u = f - i;
    return t[i * 4 + c] * (1 - u) + t[(i + 1) * 4 + c] * u;
  }
  // Linear rgb -> linear rgb through the curves: master on every channel, then each channel's own.
  function curvesPixel(rgb, t) {
    const s = rgb.map(enc);
    const m = s.map((v) => lookup(t, v, 0));
    return [lookup(t, m[0], 1), lookup(t, m[1], 2), lookup(t, m[2], 3)].map(dec);
  }

  // ---- .cube LUTs ------------------------------------------------------------------------------------------------

  const MAX_SIZE = 65;
  // A refusal the panel shows as tr(message, params).
  function lutError(message, params) {
    const e = new Error(message);
    e.code = 'lut';
    e.params = params || {};
    return e;
  }
  // Parses the text of a .cube file (Adobe/IRIDAS and Resolve flavors: TITLE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX,
  // LUT_3D_INPUT_RANGE, # comments, other keywords ignored) -> { title, size, min, max, data: Float32Array }; throws
  // lutError for anything it cannot use.
  function parseCube(text) {
    if (typeof text !== 'string' || text.includes('\0')) throw lutError('This file is not a text .cube LUT.');
    let title = '';
    let size = 0;
    let min = [0, 0, 0];
    let max = [1, 1, 1];
    let data = null;
    let count = 0;
    const lines = text.split(/\r\n|\r|\n/);
    const nums = (parts, line) => parts.map((s) => {
      const v = Number(s);
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || !Number.isFinite(v)) throw lutError('Line {line}: {value} is not a number.', { line, value: s.slice(0, 20) });
      return v;
    });
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      const hash = lines[i].indexOf('#');
      const raw = (hash >= 0 ? lines[i].slice(0, hash) : lines[i]).trim();
      if (!raw) continue;
      const parts = raw.split(/\s+/);
      const key = parts[0].toUpperCase();
      // Keywords are upper case words; anything else is a data line (so `nan 0 0` is a bad number, not a keyword).
      if (!/^[A-Z][A-Z0-9_]*$/.test(parts[0])) {
        if (!size) throw lutError('No LUT_3D_SIZE line: this is not a 3D .cube LUT.');
        if (parts.length !== 3) throw lutError('Line {line}: a data line needs three numbers.', { line });
        if (count >= size ** 3) { count++; continue; }
        data.set(nums(parts, line), count * 3);
        count++;
        continue;
      }
      if (key === 'TITLE') {
        title = raw.slice(5).trim().replace(/^"(.*)"$/, '$1').slice(0, 200);
      } else if (key === 'LUT_1D_SIZE') {
        throw lutError('1D LUTs are not supported. Load a 3D LUT (LUT_3D_SIZE).');
      } else if (key === 'LUT_3D_SIZE') {
        const n = Number(parts[1]);
        if (parts.length !== 2 || !Number.isInteger(n) || n < 2 || n > MAX_SIZE) throw lutError('LUT_3D_SIZE must be a whole number from 2 to {max} (it is {size}).', { max: MAX_SIZE, size: (parts[1] || '').slice(0, 20) });
        if (size && n !== size) throw lutError('Line {line}: a second LUT_3D_SIZE.', { line });
        size = n;
        data = new Float32Array(n ** 3 * 3);
      } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
        if (parts.length !== 4) throw lutError('Line {line}: {keyword} needs three numbers.', { line, keyword: key });
        const v = nums(parts.slice(1), line);
        if (key === 'DOMAIN_MIN') min = v; else max = v;
      } else if (key === 'LUT_3D_INPUT_RANGE') {
        if (parts.length !== 3) throw lutError('Line {line}: {keyword} needs two numbers.', { line, keyword: key });
        const [lo, hi] = nums(parts.slice(1), line);
        min = [lo, lo, lo];
        max = [hi, hi, hi];
      }
      // Other keywords (LUT_IN_VIDEO_RANGE, ...) change nothing here.
    }
    if (!size) throw lutError('No LUT_3D_SIZE line: this is not a 3D .cube LUT.');
    if (count !== size ** 3) throw lutError('The LUT has {count} data lines; LUT_3D_SIZE {size} needs {want}.', { count, size, want: size ** 3 });
    if (!min.every((v, k) => v < max[k])) throw lutError('DOMAIN_MIN must be below DOMAIN_MAX in every channel.');
    return { title, size, min, max, data };
  }

  // base64 of bytes and back, the same in Node and the page.
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64I = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;
  function toBase64(bytes) {
    const parts = [];
    let chunk = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
      if (chunk.length >= 65536) { parts.push(chunk); chunk = ''; }
    }
    parts.push(chunk);
    return parts.join('');
  }
  function fromBase64(s) {
    if (typeof s !== 'string' || s.length % 4) return null;
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    const out = new Uint8Array((s.length / 4) * 3 - pad);
    let o = 0;
    for (let i = 0; i < s.length; i += 4) {
      const v = [0, 1, 2, 3].map((k) => (s[i + k] === '=' ? 0 : B64I[s.charCodeAt(i + k)] ?? -1));
      if (v.some((x) => x < 0)) return null;
      const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
      if (o < out.length) out[o++] = (n >> 16) & 255;
      if (o < out.length) out[o++] = (n >> 8) & 255;
      if (o < out.length) out[o++] = n & 255;
    }
    return out;
  }
  const floatBytes = (f) => {
    const b = new Uint8Array(f.length * 4);
    const dv = new DataView(b.buffer);
    for (let i = 0; i < f.length; i++) dv.setFloat32(i * 4, f[i], true);
    return b;
  };
  // A 64-bit FNV-1a of the bytes (two 32-bit halves), as 16 hex digits.
  function hash64(bytes) {
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
      b = Math.imul(b ^ bytes[i] ^ (i & 255), 0x01000193) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
  // What goes into project.luts: { id, entry }.
  function store(lut, name) {
    const bytes = floatBytes(lut.data);
    const head = floatBytes(Float32Array.from([lut.size, ...lut.min, ...lut.max]));
    const all = new Uint8Array(head.length + bytes.length);
    all.set(head, 0);
    all.set(bytes, head.length);
    const id = `lut-${hash64(all)}`;
    return { id, entry: { name: String(name || lut.title || 'LUT').slice(0, 200), title: lut.title || '', size: lut.size, min: lut.min.slice(), max: lut.max.slice(), data: toBase64(bytes) } };
  }
  // Whether an entry of project.luts has the shape store() gives (model.validate).
  function validEntry(e) {
    const n = e?.size;
    const num3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    return !!e && typeof e === 'object' && typeof e.name === 'string' && typeof e.title === 'string' && Number.isInteger(n) && n >= 2 && n <= MAX_SIZE
      && num3(e.min) && num3(e.max) && e.min.every((v, k) => v < e.max[k]) && typeof e.data === 'string' && e.data.length === Math.ceil((n ** 3 * 12) / 3) * 4;
  }
  // The usable LUT of an entry ({ id, size, min, max, data: Float32Array }), decoded once per entry object.
  const decoded = new WeakMap();
  function decode(entry, id) {
    if (!entry || typeof entry !== 'object') return null;
    let d = decoded.get(entry);
    if (d) return d;
    if (!validEntry(entry)) return null;
    const bytes = fromBase64(entry.data);
    if (!bytes || bytes.length !== entry.size ** 3 * 12) return null;
    const dv = new DataView(bytes.buffer);
    const data = new Float32Array(entry.size ** 3 * 3);
    for (let i = 0; i < data.length; i++) data[i] = dv.getFloat32(i * 4, true);
    d = { id: id || '', size: entry.size, min: entry.min.slice(), max: entry.max.slice(), data, name: entry.name };
    decoded.set(entry, d);
    return d;
  }
  const lutOf = (project, id) => (typeof id === 'string' && id && project?.luts && Object.prototype.hasOwnProperty.call(project.luts, id) ? decode(project.luts[id], id) : null);

  // The LUT at sRGB values s (domain-normalized, clamped), trilinear between its points, as the shader reads it.
  function sampleLut(lut, s) {
    const n = lut.size;
    const x = s.map((v, k) => clamp((v - lut.min[k]) / (lut.max[k] - lut.min[k]), 0, 1) * (n - 1));
    const i0 = x.map((v) => Math.min(Math.floor(v), n - 2));
    const f = x.map((v, k) => v - i0[k]);
    const at = (r, g, b, c) => lut.data[((b * n + g) * n + r) * 3 + c];
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = at(i0[0], i0[1], i0[2], c) * (1 - f[0]) + at(i0[0] + 1, i0[1], i0[2], c) * f[0];
      const c10 = at(i0[0], i0[1] + 1, i0[2], c) * (1 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2], c) * f[0];
      const c01 = at(i0[0], i0[1], i0[2] + 1, c) * (1 - f[0]) + at(i0[0] + 1, i0[1], i0[2] + 1, c) * f[0];
      const c11 = at(i0[0], i0[1] + 1, i0[2] + 1, c) * (1 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2] + 1, c) * f[0];
      out[c] = (c00 * (1 - f[1]) + c10 * f[1]) * (1 - f[2]) + (c01 * (1 - f[1]) + c11 * f[1]) * f[2];
    }
    return out;
  }
  // Linear rgb -> linear rgb through the LUT at intensity k (0..1), mixed in sRGB values.
  function lutPixel(rgb, lut, k) {
    const s = rgb.map(enc);
    const v = sampleLut(lut, s);
    return s.map((x, i) => dec(x + (v[i] - x) * k));
  }
  // The identity LUT of n points a side (tests, and the panel's own check of a loaded file).
  function identityCube(n, { title = 'Identity', min = [0, 0, 0], max = [1, 1, 1] } = {}) {
    const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`, `DOMAIN_MIN ${min.join(' ')}`, `DOMAIN_MAX ${max.join(' ')}`];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push([r, g, b].map((v, k) => (min[k] + ((max[k] - min[k]) * v) / (n - 1)).toFixed(6)).join(' '));
    return `${lines.join('\n')}\n`;
  }

  // ---- half floats for the GPU's rgba16float tables ----------------------------------------------------------------

  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  function toHalf(v) {
    f32[0] = v;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 112;
    const m = x & 0x7fffff;
    if (e >= 31) return sign | 0x7c00;
    if (e <= 0) {
      if (e < -10) return sign;
      const mm = (m | 0x800000) >>> (1 - e);
      return sign | ((mm + 0x1000) >>> 13);
    }
    const h = sign | (e << 10) | (m >>> 13);
    return m & 0x1000 ? h + 1 : h;
  }
  // rgb triples (or rgba) -> rgba half floats, alpha 1.
  function halfRgba(values, stride) {
    const n = values.length / stride;
    const out = new Uint16Array(n * 4);
    const one = toHalf(1);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) out[i * 4 + c] = toHalf(values[i * stride + c]);
      out[i * 4 + 3] = stride === 4 ? toHalf(values[i * 4 + 3]) : one;
    }
    return out;
  }
  const halfOfLut = new WeakMap();
  function lutHalf(lut) {
    let h = halfOfLut.get(lut);
    if (!h) { h = halfRgba(lut.data, 3); halfOfLut.set(lut, h); }
    return h;
  }
  const curvesHalf = (p) => halfRgba(curvesTable(p), 4);

  // ---- HSL secondary -----------------------------------------------------------------------------------------------

  // Hue (0..1 turns, 0 red, 1/3 green, 2/3 blue) of sRGB values; 0 for a gray.
  function hueOf(s) {
    const mx = Math.max(s[0], s[1], s[2]);
    const mn = Math.min(s[0], s[1], s[2]);
    const C = mx - mn;
    if (!(C > 0)) return 0;
    let h;
    if (mx === s[0]) { h = (s[1] - s[2]) / C; if (h < 0) h += 6; } else if (mx === s[1]) h = (s[2] - s[0]) / C + 2;
    else h = (s[0] - s[1]) / C + 4;
    return h / 6;
  }
  const W = (w) => Math.max(w, 1e-4);
  // 1 up to edge, 0 from edge + w, smooth between.
  const fall = (x, edge, w) => 1 - smoothstep(edge, edge + W(w), x);
  // 1 inside lo..hi, 0 beyond w outside it.
  const band = (x, lo, hi, w) => smoothstep(lo - W(w), lo, x) * fall(x, hi, w);
  function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
      [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
      [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ];
  }
  const HSL_PARAMS = ['hslHue', 'hslHueRange', 'hslHueSoft', 'hslSatLow', 'hslSatHigh', 'hslSatSoft', 'hslLumLow', 'hslLumHigh', 'hslLumSoft', 'hslMask',
    'hslTemperature', 'hslTint', 'hslContrast', 'hslSaturation', 'hslHueShift'];
  // The qualifier and its correction. Hue: center hslHue degrees, hslHueRange degrees wide in all (360: every hue),
  // fading over hslHueSoft degrees beyond; saturation (the sRGB values' max - min) and luma (Rec. 709 of the sRGB
  // values) inside low..high percent, fading over soft. The correction inside, in linear light: white balance gains
  // as the basic correction's (temperature, tint, luminance kept), contrast around middle gray, a hue rotation, then
  // saturation. Show Mask draws the qualified pixels in their color and the rest middle gray.
  function hslPlan(p) {
    const T = (p.hslTemperature || 0) / 100;
    const M = (p.hslTint || 0) / 100;
    const g = [2 ** (T / 2 + M / 4), 2 ** (-M / 2), 2 ** (-T / 2 + M / 4)];
    const n = g[0] * LUMA[0] + g[1] * LUMA[1] + g[2] * LUMA[2];
    const shift = (((p.hslHueShift || 0) % 360) + 360) % 360;
    const q = {
      hue: ((((p.hslHue || 0) % 360) + 360) % 360) / 360,
      half: clamp(p.hslHueRange ?? 360, 0, 360) / 720,
      hueSoft: clamp(p.hslHueSoft ?? 0, 0, 180) / 360,
      sat: [(p.hslSatLow ?? 0) / 100, (p.hslSatHigh ?? 100) / 100, (p.hslSatSoft ?? 0) / 100],
      lum: [(p.hslLumLow ?? 0) / 100, (p.hslLumHigh ?? 100) / 100, (p.hslLumSoft ?? 0) / 100],
      gain: g.map((x) => x / n),
      k: 1 + (p.hslContrast || 0) / 100,
      saturation: (p.hslSaturation ?? 100) / 100,
      shift: shift > 180 ? shift - 360 : shift,
      mask: !!p.hslMask,
    };
    q.matrix = q.shift ? hueMatrix(q.shift) : null;
    q.active = q.mask || !!T || !!M || q.k !== 1 || q.saturation !== 1 || !!q.shift;
    return q;
  }
  // How much a linear color is inside the qualifier (0..1).
  function hslMask(rgb, q) {
    const s = rgb.map((v) => clamp(enc(v), 0, 1));
    const C = Math.max(s[0], s[1], s[2]) - Math.min(s[0], s[1], s[2]);
    const L = s[0] * LUMA[0] + s[1] * LUMA[1] + s[2] * LUMA[2];
    const x = hueOf(s) - q.hue + 0.5;
    const dh = Math.abs(x - Math.floor(x) - 0.5);
    return fall(dh, q.half, q.hueSoft) * band(C, q.sat[0], q.sat[1], q.sat[2]) * band(L, q.lum[0], q.lum[1], q.lum[2]);
  }
  // sRGB 128 (not 0.5, which is 127.5 and rounds either way); effects.js's WGSL has the same number.
  const MID_GRAY = srgbToLinear(128 / 255);
  function hslPixel(rgb, q) {
    const m = hslMask(rgb, q);
    if (q.mask) return rgb.map((x) => MID_GRAY + (x - MID_GRAY) * m);
    let c = rgb.map((x, i) => x * q.gain[i]);
    if (q.k !== 1) c = c.map((x) => (x > 0 ? 0.18 * (x / 0.18) ** q.k : x));
    if (q.matrix) c = q.matrix.map((row) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]);
    const y = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
    c = c.map((x) => Math.max(0, y + (x - y) * q.saturation));
    return rgb.map((x, i) => x + (c[i] - x) * m);
  }
  // A qualifier around a picked color (sRGB 0..255), the way the HSL secondary's eyedropper sets it.
  function qualifierFor(rgb) {
    const s = rgb.map((v) => clamp(v / 255, 0, 1));
    const C = Math.max(...s) - Math.min(...s);
    const L = s[0] * LUMA[0] + s[1] * LUMA[1] + s[2] * LUMA[2];
    const r = (v) => Math.round(v * 10) / 10;
    return {
      hslHue: r(hueOf(s) * 360), hslHueRange: 50, hslHueSoft: 30,
      hslSatLow: r(clamp(C - 0.3, 0, 1) * 100), hslSatHigh: r(clamp(C + 0.3, 0, 1) * 100), hslSatSoft: 10,
      hslLumLow: r(clamp(L - 0.35, 0, 1) * 100), hslLumHigh: r(clamp(L + 0.35, 0, 1) * 100), hslLumSoft: 10,
    };
  }

  return {
    TABLE, CURVE_PARAMS, IDENTITY, MAX_POINTS, MIN_GAP, points, flatten, sanitize, slopes, evalCurve, curveTable, isIdentityCurve,
    curvesIdentity, curveKey, curvesTable, curvesPixel, lookup,
    MAX_SIZE, parseCube, store, validEntry, decode, lutOf, sampleLut, lutPixel, identityCube, toBase64, fromBase64, hash64,
    toHalf, halfRgba, lutHalf, curvesHalf,
    HSL_PARAMS, hueOf, hslPlan, hslMask, hslPixel, qualifierFor, hueMatrix, MID_GRAY,
  };
});
