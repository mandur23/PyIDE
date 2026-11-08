// Nano Studio Cut's Lumetri Color and Lumetri Scopes math in plain Node (renderer/features/cut: lumetri.js, scopes.js,
// effects.js's color.basic, model.js and commands.js for the LUTs kept in a project). Checks:
// - curves: stored points cleaned (clamped, sorted, close points dropped), the straight line found, the monotone cubic
//   through every point without overshoot, the master and channel curves at chosen pixels against numbers worked out
//   by hand (two-point curves are straight lines);
// - .cube files: good ones (TITLE, comments, CRLF, DOMAIN_MIN/MAX, LUT_3D_INPUT_RANGE, unknown keywords, scientific
//   notation; sizes 2, 17, 33 and 65) and bad ones, each refused with its own message and line; the copy kept in the
//   project (id, base64, decode) and the trilinear lookup of a channel-swapping LUT exact at any point;
// - the HSL secondary's qualifier at chosen pixels (inside, outside, half way down the softness), its correction only
//   inside, Show Mask, the eyedropper's qualifier;
// - Lumetri Color's CPU reference: nothing to do at its defaults, the sections in Lumetri's order;
// - the scopes' counts: each 75% color bar on the vectorscope at its angle and in its target, gray in the middle, skin
//   tone near its line, a ramp as a diagonal on the waveform and the parade, histograms that sum to the pixels, the
//   frame box of a letterboxed output, the sampling step, the WGSL's integers the same as the CPU's;
// - project.luts: addLut, the same LUT twice, undo, a bad entry refused, migrate keeping what effects name and dropping
//   the rest, a save and reopen with the same numbers;
// - the modules as page scripts next to an AMD `require`, effects.js even without lumetri.js; every refusal message
//   translated in ko.json.
// Usage: node verify/cut-color-core.mjs
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import vm from 'vm';

const require = createRequire(import.meta.url);
const dir = '../renderer/features/cut/';
const L = require(`${dir}lumetri.js`);
const SC = require(`${dir}scopes.js`);
const fx = require(`${dir}effects.js`);
const model = require(`${dir}model.js`);
const C = require(`${dir}commands.js`);

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const nearAll = (a, b, eps) => a.length === b.length && a.every((x, i) => near(x, b[i], eps));
const r5 = (v) => v.map((x) => +x.toFixed(5));
const enc = (v) => fx.linearToSrgb(Math.max(0, v));
const dec = (v) => fx.srgbToLinear(Math.max(0, v));
const throwsLut = (text) => { try { L.parseCube(text); return null; } catch (e) { return e; } };

// ---- curves ----
check(S(L.sanitize([1, 1.4, 0.5, 0.5, 0.501, 0.9, -1, 0])) === S([0, 0, 0.5, 0.5, 1, 1]), `curve points are clamped to 0..1, sorted, and a point closer than MIN_GAP to the one before goes (${S(L.sanitize([1, 1.4, 0.5, 0.5, 0.501, 0.9, -1, 0]))})`);
check(S(L.sanitize([0, 0, 1])) === S([0, 0, 1, 1]) && S(L.sanitize('x')) === S([0, 0, 1, 1]) && S(L.sanitize([0.5, 0.5])) === S([0, 0, 1, 1]), 'an unusable curve is the straight line');
check(L.isIdentityCurve([0, 0, 1, 1]) && L.isIdentityCurve([0, 0, 0.4, 0.4, 1, 1]) && !L.isIdentityCurve([0, 0.1, 1, 1]) && !L.isIdentityCurve([0.2, 0.2, 1, 1]) && !L.isIdentityCurve([0, 0, 0.5, 0.6, 1, 1]),
  'the straight line from (0,0) to (1,1) is found, with or without points on it; a lifted, shortened or bent one is not');
{
  const pts = L.points([0, 0, 0.3, 0.8, 0.6, 0.85, 1, 1]);
  const m = L.slopes(pts);
  check(pts.every(([x, y]) => near(L.evalCurve(pts, x, m), y, 1e-12)), 'the curve goes through every point');
  let mono = true;
  let inside = true;
  for (let i = 0; i < 1000; i++) {
    const x = i / 999;
    const y = L.evalCurve(pts, x, m);
    const y2 = L.evalCurve(pts, Math.min(1, x + 1e-3), m);
    if (y2 < y - 1e-12) mono = false;
    const seg = pts.findIndex((p, k) => k < pts.length - 1 && x >= p[0] && x <= pts[k + 1][0]);
    if (seg >= 0 && (y < Math.min(pts[seg][1], pts[seg + 1][1]) - 1e-12 || y > Math.max(pts[seg][1], pts[seg + 1][1]) + 1e-12)) inside = false;
  }
  check(mono && inside, 'through rising points the curve rises and stays between each pair of points (no overshoot)');
  // A peak and a dip: the curve is flat at each (no bump past 0.8 or below 0.2 next to them).
  const zig = L.points([0, 0, 0.4, 0.8, 0.6, 0.2, 1, 1]);
  const zm = L.slopes(zig);
  let peak = 0;
  let dip = 1;
  for (let i = 0; i <= 1000; i++) { const x = 0.2 + (0.6 * i) / 1000; const y = L.evalCurve(zig, x, zm); if (x <= 0.5) peak = Math.max(peak, y); else dip = Math.min(dip, y); }
  check(zm[1] === 0 && zm[2] === 0 && peak <= 0.8 + 1e-12 && dip >= 0.2 - 1e-12, `at a local peak and dip the curve is flat: it never passes 0.8 or goes below 0.2 (${peak.toFixed(4)}, ${dip.toFixed(4)})`);
  const t = L.curveTable([0, 0, 0.3, 0.8, 0.6, 0.85, 1, 1]);
  check(t.length === L.TABLE && near(t[0], 0, 1e-12) && near(t[L.TABLE - 1], 1, 1e-12) && near(t[Math.round(0.3 * (L.TABLE - 1))], L.evalCurve(pts, Math.round(0.3 * (L.TABLE - 1)) / (L.TABLE - 1), m), 1e-12), 'the table samples the curve evenly from 0 to 1');
  check(near(L.evalCurve(L.points([0.2, 0.3, 0.8, 0.6]), 0.05), 0.3, 0) && near(L.evalCurve(L.points([0.2, 0.3, 0.8, 0.6]), 0.95), 0.6, 0), 'beyond its first and last points the curve is flat');
}
{
  // Two-point curves are straight lines, so the table lookups are exact: master inverts, red is lifted.
  const p = fx.resolve('color.basic', { curveMaster: [0, 1, 1, 0], curveRed: [0, 0.5, 1, 1] });
  const rgb = [0.2, 0.05, 0.6];
  const want = rgb.map((v, i) => { const s = 1 - enc(v); return dec(i === 0 ? 0.5 + 0.5 * s : s); });
  const got = L.curvesPixel(rgb, L.curvesTable(p));
  check(nearAll(got, want, 1e-6), `master curve inverting, red curve lifting black to 0.5: [0.2, 0.05, 0.6] -> ${S(r5(want))} (got ${S(r5(got))})`);
  const img = fx.cpu.image(1, 1, [0.1, 0.025, 0.3, 0.5]);
  const out = fx.cpu.pixel(fx.get('color.basic').cpu(img, p, {}), 0, 0);
  check(nearAll(out, [...want.map((v) => v * 0.5), 0.5], 1e-6), `Lumetri Color's CPU reference does the curves on the unpremultiplied color (${S(r5(out))})`);
  check(fx.get('color.basic').gpu.uniforms(p, {}).length === 1 && fx.get('color.basic').gpu.uniforms(p, {})[0][15] === 2, 'one pass, the curves stage (2)');
  const tex = fx.get('color.basic').gpu.textures(p, {});
  check(tex[4] === null && tex[5]?.dim === '2d' && S(tex[5].size) === S([L.TABLE, 1]) && tex[5].data().length === L.TABLE * 4, 'the curves go to the GPU as a TABLE x 1 rgba16float texture; no LUT texture');
  check(L.toHalf(1) === 0x3c00 && L.toHalf(0.5) === 0x3800 && L.toHalf(-2) === 0xc000 && L.toHalf(0) === 0 && L.toHalf(65504) === 0x7bff && L.toHalf(1e-5) === 0xa8, 'half floats for the tables');
}

// ---- .cube files ----
{
  const text = '# made by hand\r\nTITLE "Tiny"\r\n\r\nLUT_3D_SIZE 2\r\n# data\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0 # yellow\r\n0 0 1\r\n1.0e0 0 1\r\n0 1 1\r\n1 1 1\r\n';
  const lut = L.parseCube(text);
  check(lut.title === 'Tiny' && lut.size === 2 && S(lut.min) === '[0,0,0]' && S(lut.max) === '[1,1,1]' && lut.data.length === 24 && S([...lut.data.slice(9, 12)]) === '[1,1,0]' && S([...lut.data.slice(15, 18)]) === '[1,0,1]',
    'a 2-point .cube with a quoted TITLE, comments (whole lines and after data), CRLF, a blank line and 1.0e0 parses, red changing fastest');
  const dom = L.parseCube(L.identityCube(17, { min: [0, 0, 0], max: [2, 2, 2] }).replace('TITLE', 'LUT_IN_VIDEO_RANGE\nTITLE'));
  check(dom.size === 17 && S(dom.max) === '[2,2,2]' && nearAll(L.sampleLut(dom, [1, 0.5, 2]), [1, 0.5, 2], 1e-6), 'DOMAIN_MAX 2: the domain maps inputs onto the grid (identity over 0..2); an unknown keyword is ignored');
  const rng = L.parseCube('LUT_3D_INPUT_RANGE 0 1\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8));
  check(rng.size === 2 && S(rng.max) === '[1,1,1]', 'Resolve\'s LUT_3D_INPUT_RANGE sets the domain');
  for (const n of [33, 65]) {
    const t0 = Date.now();
    const id = L.parseCube(L.identityCube(n));
    check(id.size === n && id.data.length === n ** 3 * 3 && nearAll(L.sampleLut(id, [0.123, 0.456, 0.789]), [0.123, 0.456, 0.789], 1e-6), `a ${n}-point identity LUT parses and is the identity between its points (${Date.now() - t0} ms)`);
  }
  // A 33-point LUT that swaps channels (r, g, b) -> (b, r, g): linear on each axis, so trilinear lookup is exact anywhere.
  const lines = ['LUT_3D_SIZE 33'];
  for (let b = 0; b < 33; b++) for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) lines.push(`${(b / 32).toFixed(6)} ${(r / 32).toFixed(6)} ${(g / 32).toFixed(6)}`);
  const swap = L.parseCube(lines.join('\n'));
  check(nearAll(L.sampleLut(swap, [0.2, 0.5, 0.9]), [0.9, 0.2, 0.5], 1e-6) && nearAll(L.sampleLut(swap, [1.4, -0.2, 0.31]), [0.31, 1, 0], 1e-6), 'a channel-swapping LUT at (0.2, 0.5, 0.9) gives (0.9, 0.2, 0.5); inputs outside the domain clamp');

  const bad = [
    ['', 'No LUT_3D_SIZE line: this is not a 3D .cube LUT.', null, 'an empty file'],
    ['LUT_3D_SIZE 2\n\0\0\0', 'This file is not a text .cube LUT.', null, 'a binary file'],
    ['LUT_1D_SIZE 1024\n0 0 0', '1D LUTs are not supported. Load a 3D LUT (LUT_3D_SIZE).', null, 'a 1D LUT'],
    ['LUT_3D_SIZE 1\n0 0 0', 'LUT_3D_SIZE must be a whole number from 2 to {max} (it is {size}).', null, 'size 1'],
    ['LUT_3D_SIZE 200\n0 0 0', 'LUT_3D_SIZE must be a whole number from 2 to {max} (it is {size}).', null, 'size 200'],
    ['LUT_3D_SIZE two\n0 0 0', 'LUT_3D_SIZE must be a whole number from 2 to {max} (it is {size}).', null, 'a size that is not a number'],
    ['0 0 0\nLUT_3D_SIZE 2', 'No LUT_3D_SIZE line: this is not a 3D .cube LUT.', null, 'data before the size'],
    [`LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(7)}`, 'The LUT has {count} data lines; LUT_3D_SIZE {size} needs {want}.', null, 'one data line short'],
    [`LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(9)}`, 'The LUT has {count} data lines; LUT_3D_SIZE {size} needs {want}.', null, 'one data line too many'],
    ['LUT_3D_SIZE 2\n0 0 0\n0 0\n', 'Line {line}: a data line needs three numbers.', 3, 'a data line of two numbers'],
    ['TITLE "x"\nLUT_3D_SIZE 2\n0 0 0\n0.5x 0 0\n', 'Line {line}: {value} is not a number.', 4, 'a broken number'],
    ['LUT_3D_SIZE 2\nnan 0 0\n', 'Line {line}: {value} is not a number.', 2, 'nan'],
    ['DOMAIN_MIN 0 0\nLUT_3D_SIZE 2\n', 'Line {line}: {keyword} needs three numbers.', 1, 'DOMAIN_MIN with two numbers'],
    [`DOMAIN_MIN 1 0 0\nDOMAIN_MAX 0 1 1\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`, 'DOMAIN_MIN must be below DOMAIN_MAX in every channel.', null, 'a domain that is upside down'],
    [`LUT_3D_SIZE 2\nLUT_3D_SIZE 3\n${'0 0 0\n'.repeat(8)}`, 'Line {line}: a second LUT_3D_SIZE.', 2, 'two sizes'],
  ];
  for (const [text, message, line, what] of bad) {
    const e = throwsLut(text);
    check(e && e.code === 'lut' && e.message === message && (line === null || e.params.line === line), `${what} is refused: "${e?.message}"${line ? ` at line ${e?.params?.line}` : ''}`);
  }
  const short = throwsLut(`LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(7)}`);
  check(S(short?.params) === S({ count: 7, size: 2, want: 8 }), `the short file's message says how many lines it has and needs (${S(short?.params)})`);

  // ---- the copy in the project ----
  const a = L.store(swap, 'swap.cube');
  const b = L.store(L.parseCube(lines.join('\r\n')), 'other name.cube');
  const c = L.store(L.parseCube(L.identityCube(33)), 'id.cube');
  check(/^lut-[0-9a-f]{16}$/.test(a.id) && a.id === b.id && a.id !== c.id, `the LUT's id is a hash of its numbers: the same file again (another name, other line ends) is the same id, another LUT another (${a.id}, ${c.id})`);
  check(a.entry.name === 'swap.cube' && a.entry.size === 33 && L.validEntry(a.entry) && a.entry.data.length === Math.ceil((33 ** 3 * 12) / 3) * 4, `the entry: name, size, domain, base64 of float32 (${a.entry.data.length} characters)`);
  const d = L.decode(JSON.parse(S(a.entry)), a.id);
  check(d && d.size === 33 && d.data.length === swap.data.length && d.data.every((v, i) => v === swap.data[i]), 'decoding the saved entry gives back the same float32 numbers');
  check(L.decode({ ...a.entry, data: a.entry.data.slice(4) }) === null && L.decode({ ...a.entry, size: 99 }) === null && !L.validEntry({ ...a.entry, min: [1, 1, 1], max: [0, 0, 0] }), 'a damaged entry (short data, wrong size, upside-down domain) decodes to nothing');
  let b64 = true;
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 13) & 255);
    if (L.toBase64(bytes) !== Buffer.from(bytes).toString('base64') || S([...L.fromBase64(L.toBase64(bytes))]) !== S([...bytes])) b64 = false;
  }
  check(b64 && L.fromBase64('a$==') === null, 'base64 is the standard one (0 to 39 bytes, as Node writes it) and a bad character is refused');
  check(L.lutOf({ luts: { [a.id]: a.entry } }, a.id)?.size === 33 && L.lutOf({ luts: {} }, a.id) === null && L.lutOf({}, '') === null && L.lutOf({ luts: { [a.id]: a.entry } }, 'toString') === null, 'lutOf: the project\'s LUT, or nothing for a missing or empty id');
  // LUT at intensity: mixed in sRGB values.
  const rgb = [0.05, 0.4, 0.7];
  const s = rgb.map(enc);
  const half = L.lutPixel(rgb, swap, 0.5);
  check(nearAll(half, [0, 1, 2].map((i) => dec(s[i] + ([s[2], s[0], s[1]][i] - s[i]) * 0.5)), 1e-6), `the Look at 50% intensity: half way to the swapped color in sRGB values (${S(r5(half))})`);
  const idl = L.parseCube(L.identityCube(17));
  check(nearAll(L.lutPixel(rgb, idl, 1), rgb, 1e-5), 'the identity LUT at 100% changes nothing');
  const proj = { luts: { [a.id]: a.entry } };
  const p = fx.resolve('color.basic', { lut: a.id, lutIntensity: 100 });
  const assets = fx.get('color.basic').assets(proj, p);
  const passes = fx.get('color.basic').gpu.uniforms(p, { assets });
  check(passes.length === 1 && passes[0][15] === 1 && passes[0][0] === 1 && passes[0][1] === 33, 'with a LUT: one pass, the LUT stage (1), intensity 1, 33 points');
  const tex = fx.get('color.basic').gpu.textures(p, { assets });
  check(tex[4]?.dim === '3d' && S(tex[4].size) === '[33,33,33]' && tex[4].key === `lut:${a.id}` && tex[4].data().length === 33 ** 3 * 4 && tex[5] === null, 'the LUT goes to the GPU as a 33^3 rgba16float 3D texture named by its id');
  check(fx.get('color.basic').gpu.uniforms(fx.resolve('color.basic', { lut: a.id }), { assets: { lut: null } }).length === 0, 'a Look whose LUT is not in the project draws nothing (no pass)');
  check(fx.get('color.basic').gpu.uniforms(fx.resolve('color.basic', { lut: a.id, lutIntensity: 0 }), { assets }).length === 0, 'intensity 0: no pass');

  // ---- project.luts ----
  const hist = C.createHistory(model.createProject({ sequence: { w: 64, h: 36, fps: [30, 1] } }), { limit: Infinity });
  const seq = hist.project.sequences[0].id;
  const { id: cid } = hist.do(C.addGenerated(seq, { track: 'V1', at: 0, duration: 30 * time30(), source: { generator: 'solid', color: '#808080' } }));
  hist.do(C.batch('Load LUT', [C.addLut(a), C.addEffect(seq, cid, 'color.basic', null, { lut: a.id })]));
  check(hist.project.luts?.[a.id]?.size === 33 && model.validate(hist.project).ok, `addLut keeps the LUT in the project and it validates (${model.validate(hist.project).errors.slice(0, 2)})`);
  const before = S(hist.project.luts);
  const again = hist.do(C.addLut(b));
  check(again.id === a.id && S(hist.project.luts) === before, 'the same LUT again changes nothing');
  hist.undo(); hist.undo();
  check(hist.project.luts === undefined || Object.keys(hist.project.luts).length === 0, 'undo takes the LUT out with the effect');
  hist.redo(); hist.redo();
  check(!!hist.project.luts?.[a.id], 'redo brings it back');
  let refused = null;
  try { hist.do(C.addLut({ id: 'lut-0000000000000000', entry: { ...a.entry, data: 'abc' } })); } catch (e) { refused = e; }
  check(refused?.code === 'invalid', `a damaged LUT is refused (${refused?.message})`);
  hist.do(C.addLut(c));
  const saved = S(hist.project);
  const reopened = model.migrate(saved);
  check(Object.keys(reopened.luts).join() === a.id && model.validate(reopened).ok, 'reopening keeps the LUT an effect names and drops the one no effect names');
  const back = L.lutOf(reopened, a.id);
  check(back && back.data.every((v, i) => v === swap.data[i]), 'after a save and reopen the LUT has the same numbers (the project carries it)');
  const damaged = JSON.parse(saved);
  damaged.luts[a.id].data = 'AAAA';
  const fixed = model.migrate(damaged);
  check(fixed.luts === undefined && model.validate(fixed).ok, 'a damaged LUT in a file is dropped at open (its effect draws without it) and the project opens');
  check(!model.validate({ ...hist.project, luts: { 'not-an-id': a.entry } }).ok && !model.validate({ ...hist.project, luts: [] }).ok, 'validate refuses a LUT under a bad id and luts that are not an object');
}
function time30() { return require(`${dir}time.js`).frameTicks([30, 1]); }

// ---- HSL secondary ----
{
  const rgbOf = (s) => s.map(dec);
  const q = L.hslPlan(fx.resolve('color.basic', { hslHue: 0, hslHueRange: 60, hslHueSoft: 20, hslSatLow: 0, hslSatHigh: 100, hslSatSoft: 0, hslLumLow: 0, hslLumHigh: 100, hslLumSoft: 0 }));
  const red = rgbOf([1, 0, 0]);
  const blue = rgbOf([0, 0, 1]);
  const orange40 = rgbOf([1, 2 / 3, 0]); // hue 40 degrees: 10 degrees into the 20-degree softness beyond the range's 30
  check(near(L.hueOf([1, 2 / 3, 0]) * 360, 40, 1e-9) && near(L.hueOf([0, 0, 1]) * 360, 240, 1e-9) && L.hueOf([0.5, 0.5, 0.5]) === 0, 'hues of sRGB values: orange 40, blue 240, gray 0');
  check(near(L.hslMask(red, q), 1, 1e-9) && near(L.hslMask(blue, q), 0, 1e-9) && near(L.hslMask(orange40, q), 0.5, 1e-6),
    `the hue qualifier around red, 60 degrees wide, 20 soft: red 1, blue 0, a 40-degree orange half way down (${L.hslMask(orange40, q).toFixed(4)})`);
  const qs = L.hslPlan(fx.resolve('color.basic', { hslSatLow: 50, hslSatSoft: 0, hslLumLow: 0, hslLumHigh: 60, hslLumSoft: 0 }));
  check(L.hslMask(rgbOf([0.5, 0.5, 0.5]), qs) === 0 && L.hslMask(rgbOf([0.9, 0.2, 0.2]), qs) === 1 && L.hslMask(rgbOf([1, 0.8, 0.8]), qs) === 0,
    'saturation and luma ranges: gray out (no saturation), a strong red in, a light pink out (too light and too pale)');
  const p = fx.resolve('color.basic', { hslHue: 0, hslHueRange: 60, hslHueSoft: 0, hslSaturation: 0 });
  const h = L.hslPlan(p);
  const y = red[0] * fx.LUMA[0];
  check(h.active && nearAll(L.hslPixel(red, h), [y, y, y], 1e-9) && nearAll(L.hslPixel(blue, h), blue, 0), `saturation 0 inside the key: red turns gray at its luminance (${y.toFixed(4)}), blue is untouched`);
  const hs = L.hslPlan(fx.resolve('color.basic', { hslHue: 240, hslHueRange: 40, hslHueSoft: 0, hslHueShift: 120 }));
  const shifted = L.hslPixel(blue, hs);
  check(shifted[0] > shifted[2] && near(L.hslPixel(red, hs)[0], red[0], 0), `a hue shift of 120 degrees inside a blue key turns blue toward red (${S(r5(shifted))}), red stays`);
  const hm = L.hslPlan(fx.resolve('color.basic', { hslHue: 0, hslHueRange: 60, hslHueSoft: 0, hslMask: true }));
  check(hm.active && nearAll(L.hslPixel(red, hm), red, 1e-12) && nearAll(L.hslPixel(blue, hm), [L.MID_GRAY, L.MID_GRAY, L.MID_GRAY], 1e-12), 'Show Mask: the keyed red in its color, the rest middle gray');
  check(!L.hslPlan(fx.resolve('color.basic', { hslHue: 120, hslHueRange: 30 })).active, 'a qualifier with no correction and no mask does nothing (no pass)');
  const key = L.qualifierFor([40, 160, 60]);
  const kq = L.hslPlan(fx.resolve('color.basic', { ...key, hslSaturation: 50 }));
  check(near(L.hslMask(rgbOf([40 / 255, 160 / 255, 60 / 255]), kq), 1, 1e-9) && L.hslMask(rgbOf([0.8, 0.2, 0.6]), kq) === 0, `the eyedropper's qualifier holds the picked green and not a magenta (${S(key)})`);
  const passes = fx.get('color.basic').gpu.uniforms(p, {});
  check(passes.length === 1 && passes[0].length === 16 && passes[0][15] === 3 && fx.get('color.basic').gpu.uniforms(fx.resolve('color.basic', { hslMask: true }), {})[0][15] === 4, 'the HSL stage is pass 3, its mask 4, 16 numbers');
}

// ---- Lumetri Color, the whole effect ----
{
  const d = fx.get('color.basic');
  const img = fx.cpu.image(2, 1);
  img.data.set([0.2, 0.05, 0.01, 1, 0.5, 0.5, 0.5, 1]);
  const neutral = fx.resolve('color.basic', {});
  check(d.cpu(img, neutral, {}) === img && d.gpu.uniforms(neutral, {}).length === 0, 'at its defaults Lumetri Color leaves the picture alone and has no pass');
  // exposure +1 (x2), then the master curve inverting: the order is basic, then curves.
  const p = fx.resolve('color.basic', { exposure: 1, curveMaster: [0, 1, 1, 0] });
  const got = fx.cpu.pixel(d.cpu(img, p, {}), 0, 0).slice(0, 3);
  const want = [0.4, 0.1, 0.02].map((v) => dec(1 - enc(v)));
  check(nearAll(got, want, 1e-6), `exposure then curves, Lumetri's order (${S(r5(got))} vs ${S(r5(want))})`);
  const order = d.gpu.uniforms(fx.resolve('color.basic', { exposure: 0.5, curveRed: [0, 0.1, 1, 1], hslSaturation: 50, lut: 'x' }), { assets: { lut: L.decode(L.store(L.parseCube(L.identityCube(2)), 'i').entry, 'i') } }).map((x) => x[15]);
  check(S(order) === '[0,1,2,3]', `every section on: the passes run basic, LUT, curves, HSL (${S(order)})`);
  check(d.params.filter((x) => x.group === 'Creative').length === 2 && d.params.filter((x) => x.group === 'Curves').every((x) => x.type === 'curve' && x.keyframable) && d.params.find((x) => x.id === 'lut').keyframable === false,
    'the parameters are grouped as Lumetri\'s sections; curves keyframe as a whole, the Look does not');
  check(S(fx.resolve('color.basic', { curveRed: [1, 1, 0, 0.2, 2, 2] }).curveRed) === S([0, 0.2, 1, 1]), 'resolve cleans a stored curve');
  const kf = require(`${dir}keyframes.js`);
  const glide = kf.valueAt([{ t: 0, v: [0, 0, 0.5, 0.5, 1, 1], ease: 'linear' }, { t: 10, v: [0, 0.2, 0.5, 0.9, 1, 1], ease: 'linear' }], 5);
  const hold = kf.valueAt([{ t: 0, v: [0, 0, 1, 1], ease: 'linear' }, { t: 10, v: [0, 0.2, 0.5, 0.9, 1, 1], ease: 'linear' }], 5);
  check(nearAll(glide, [0, 0.1, 0.5, 0.7, 1, 1], 1e-12) && S(hold) === S([0, 0, 1, 1]), `a keyframed curve glides between keyframes with as many points (${S(glide)}) and holds between ones with different counts`);
  const g = Number(/let g = vec3f\(([\d.]+)\)/.exec(d.gpu.code)?.[1]);
  check(near(g, L.MID_GRAY, 1e-6) && near(enc(L.MID_GRAY) * 255, 128, 1e-6), `Show Mask's gray is sRGB 128 on both sides (WGSL ${g}, CPU ${L.MID_GRAY.toFixed(7)}), not 127.5, which rounds either way`);
  check(/var lutTex: texture_3d<f32>/.test(d.gpu.code) && /var curveTex: texture_2d<f32>/.test(d.gpu.code) && S(d.gpu.bindings) === S({ 4: '3d', 5: '2d' }), 'the WGSL declares the LUT and curve textures the compositor binds');
}

// ---- scopes ----
{
  const L0 = SC.layout(256, 256);
  check(L0.total === 256 * 256 * 4 + 256 * 256 + 1024 && L0.vector === 256 * 256 * 4, `the bins' layout (${L0.total} u32)`);
  check(S(SC.frameRect(640, 360, 1920, 1080)) === S({ x0: 0, y0: 0, x1: 640, y1: 360 }) && S(SC.frameRect(800, 360, 1920, 1080)) === S({ x0: 80, y0: 0, x1: 720, y1: 360 }) && S(SC.frameRect(640, 480, 1920, 1080)) === S({ x0: 0, y0: 60, x1: 640, y1: 420 }),
    'the frame box leaves out the bars of a pillarboxed or letterboxed output');
  check(SC.stepFor({ x0: 0, y0: 0, x1: 640, y1: 360 }) === 1 && SC.stepFor({ x0: 0, y0: 0, x1: 1920, y1: 1080 }) === 3, 'the sampling step keeps the count near BUDGET pixels (1 for 640x360, 3 for 1920x1080)');
  const solid = (w, h, c) => { const px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) px.set([...c, 255], i * 4); return px; };
  const rect = { x0: 0, y0: 0, x1: 64, y1: 36 };
  for (const t of SC.targets(256)) {
    const c = SC.BARS.find(([n]) => n === t.name)[1].map((v) => Math.round(v * 0.75 * 255));
    const r = SC.analyze(solid(64, 36, c), 64, 36, rect, { cols: 256, size: 256 });
    const v = SC.views(r.bins, r.layout);
    const pk = SC.vectorPeak(v.vector, 256);
    const [cb, cr] = SC.chroma(...c.map((x) => x / 255));
    const angle = ((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360;
    check(pk.n === 64 * 36 && Math.abs(pk.angle - angle) < 1.5 && Math.hypot(pk.x - t.at75[0], pk.y - t.at75[1]) < 1.5, `75% ${t.name} ${S(c)}: one vectorscope bin at ${pk.angle.toFixed(1)} degrees (exact ${angle.toFixed(1)}), inside its 75% target`);
  }
  check(Math.abs(SC.targets(256).find((t) => t.name === 'R').angle - 102.9) < 0.1 && Math.abs(SC.targets(256).find((t) => t.name === 'YL').angle - 174.8) < 0.1, 'the targets sit at their Rec. 709 Cb/Cr angles (red 102.9, yellow 174.8)');
  const gray = SC.vectorPeak(SC.views(SC.analyze(solid(8, 8, [128, 128, 128]), 8, 8, { x0: 0, y0: 0, x1: 8, y1: 8 }).bins, L0).vector, 256);
  check(Math.abs(gray.x - 128) <= 1 && Math.abs(gray.y - 128) <= 1 && gray.magnitude < 0.01, `gray falls in the middle (${gray.x}, ${gray.y})`);
  const skin = SC.vectorPeak(SC.views(SC.analyze(solid(8, 8, [224, 172, 140]), 8, 8, { x0: 0, y0: 0, x1: 8, y1: 8 }).bins, L0).vector, 256);
  check(Math.abs(skin.angle - SC.SKIN_DEGREES) < 8, `a skin tone (224, 172, 140) lies near the skin tone line at ${SC.SKIN_DEGREES} degrees (${skin.angle.toFixed(1)})`);
  // A ramp: column x has value x (256 wide), and a 512-wide one.
  const ramp = (w, h, f) => { const px = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...f(x, w), 255], (y * w + x) * 4); return px; };
  const r1 = SC.analyze(ramp(256, 20, (x) => [x, x, x]), 256, 20, { x0: 0, y0: 0, x1: 256, y1: 20 });
  const pk1 = SC.peaks(SC.views(r1.bins, r1.layout).wave, 256);
  check(pk1.every((l, c) => l === c), 'a 256-wide gray ramp is the waveform\'s diagonal: column c at level c');
  const r2 = SC.analyze(ramp(512, 30, (x, w) => { const v = Math.round((x * 255) / (w - 1)); return [v, v, v]; }), 512, 30, { x0: 0, y0: 0, x1: 512, y1: 30 });
  const pk2 = [...SC.peaks(SC.views(r2.bins, r2.layout).wave, 256)];
  const n = pk2.length;
  const mx = (n - 1) / 2;
  const my = pk2.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  pk2.forEach((l, c) => { sxy += (c - mx) * (l - my); sxx += (c - mx) ** 2; syy += (l - my) ** 2; });
  const slope = sxy / sxx;
  const corr = sxy / Math.sqrt(sxx * syy);
  check(pk2[0] === 0 && pk2[n - 1] === 255 && pk2.every((l, c) => c === 0 || l >= pk2[c - 1]) && Math.abs(slope - 1) < 0.01 && corr > 0.9999, `a 512-wide ramp is a rising diagonal from 0 to 255 (slope ${slope.toFixed(4)}, correlation ${corr.toFixed(6)})`);
  const r3 = SC.analyze(ramp(256, 10, (x) => [x, 128, 255 - x]), 256, 10, { x0: 0, y0: 0, x1: 256, y1: 10 });
  const v3 = SC.views(r3.bins, r3.layout);
  const [pr, pg, pb] = v3.parade.map((pl) => [...SC.peaks(pl, 256)]);
  check(pr.every((l, c) => l === c) && pg.every((l) => l === 128) && pb.every((l, c) => l === 255 - c), 'the RGB parade: red rising, green flat at 128, blue falling');
  check(v3.hist.slice(0, 3).every((hh) => hh.reduce((a, b) => a + b, 0) === 2560) && v3.hist[1][128] === 2560 && v3.hist[0][0] === 10 && v3.hist[0][255] === 10, 'the histograms count every pixel once per channel');
  check([[255, 255, 255], [0, 0, 0], [12, 200, 77]].every((c) => Math.abs(SC.lumaOf(...c) - (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])) <= 0.5), 'the integer luma is Rec. 709 to the nearest level');
  const big = SC.analyze(new Uint8ClampedArray(1920 * 1080 * 4), 1920, 1080, { x0: 0, y0: 0, x1: 1920, y1: 1080 }, { step: 3 });
  check(SC.views(big.bins, big.layout).hist[3].reduce((a, b) => a + b, 0) === 640 * 360, 'with step 3 a 1920x1080 frame counts 640 x 360 pixels');
  check(['13933', '46871', '4732', '-7509', '25259', '32768', '29763', '3005', '>> 7u', '>> 16u'].every((k) => SC.WGSL.includes(k)) && S([...SC.uniforms({ x0: 1, y0: 2, x1: 3, y1: 4 }, L0, 2)]) === S([1, 2, 3, 4, 256, 256, 2, SC.K, L0.wave, L0.parade, L0.vector, L0.hist]),
    'the compute shader counts with the same integers and offsets as the CPU');
}

// ---- page scripts ----
{
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, WeakMap, Error, Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, Uint8ClampedArray, DataView, Promise, RegExp };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const base = new URL(dir, import.meta.url);
  const order = readFileSync(new URL('index.js', base), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  check(order.indexOf('lumetri.js') < order.indexOf('effects.js') && order.indexOf('scopes.js') < order.indexOf('compositor.js') && order.indexOf('ui-scopes.js') > order.indexOf('ui-color.js'), 'index.js loads lumetri.js before effects.js, scopes.js before the compositor, the scopes panel after the color panel');
  let alone = null;
  try {
    for (const f of ['time.js', 'effects.js']) vm.runInContext(readFileSync(new URL(f, base), 'utf8'), page, { filename: f });
    alone = vm.runInContext("Cut.effects.get('color.basic').name", page);
  } catch (err) { alone = String(err?.message || err); }
  check(alone === 'Lumetri Color', `effects.js loads as a page script even without lumetri.js (it reads it when used): ${alone}`);
  for (const f of ['lumetri.js', 'scopes.js']) vm.runInContext(readFileSync(new URL(f, base), 'utf8'), page, { filename: f });
  const out = vm.runInContext(`(() => {
    const p = Cut.effects.resolve('color.basic', { curveMaster: [0, 1, 1, 0] });
    const img = Cut.effects.cpu.image(1, 1, [0.5, 0.5, 0.5, 1]);
    return [Cut.effects.get('color.basic').cpu(img, p, {}).data[0] < 0.25, Cut.lumetri.parseCube(Cut.lumetri.identityCube(2)).size, Cut.scopes.layout().cols];
  })()`, page);
  check(S(out) === '[true,2,256]', `lumetri.js, effects.js and scopes.js work as page scripts through globalThis.Cut (${S(out)})`);
}

// ---- strings ----
{
  const ko = JSON.parse(readFileSync(new URL(`${dir}locales/ko.json`, import.meta.url), 'utf8'));
  const src = readFileSync(new URL(`${dir}lumetri.js`, import.meta.url), 'utf8');
  const msgs = [...src.matchAll(/lutError\('([^']+)'/g)].map((m) => m[1]);
  const ui = readFileSync(new URL(`${dir}ui-color.js`, import.meta.url), 'utf8');
  const uiMsgs = [...ui.matchAll(/new Error\('([^']+)'\)/g)].map((m) => m[1]).filter((m) => m !== 'write failed');
  const missing = [...msgs, ...uiMsgs].filter((m) => !ko[m]);
  check(msgs.length >= 10 && !missing.length, `every LUT refusal (${msgs.length + uiMsgs.length}) is translated in ko.json (missing ${S(missing)})`);
  const params = msgs.filter((m) => /\{/.test(m) && ko[m]).filter((m) => (m.match(/\{\w+\}/g) || []).some((k) => !ko[m].includes(k)));
  check(!params.length, `the Korean refusals keep their {placeholders} (${S(params)})`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
