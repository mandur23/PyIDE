// Nano Studio Cut's masks (Premiere's masks of Opacity and of the effects) in the real app, with real input events
// (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and the real export, on a 1280x720 30 fps testsrc:
// - Effect Controls' Create Ellipse Mask and Create 4-point Polygon Mask on Opacity: one undo step each, the mask
//   selected and drawn on the program monitor, the picture cut out to it (the program monitor's pixels inside, outside);
// - on the program monitor: a vertex dragged out (a pixel beyond the old edge now shows the clip), the whole mask
//   dragged, the feather handle (a soft edge in the pixels), the expansion handle, Alt+click (corner <-> smooth),
//   Ctrl+click (a vertex goes), a click on the outline (a vertex there); each one undo step, Ctrl+Z, Ctrl+Shift+Z;
// - the mask follows the clip's motion (position);
// - the Free Draw Bezier pen: points clicked (one dragged into a smooth point) and closed on the first;
// - an effect limited by a mask (Invert inside an ellipse; Lumetri Color's saturation outside an inverted one);
// - Mask Path keyframes: the stopwatch, a drag at another frame making a keyframe there, the frame between showing the
//   path half way (pixels);
// - the export's frames match the program monitor's;
// - screenshots (verify/out/cut-mask/*.png).
// Usage: node verify/cut-mask.mjs   (CUT_MASK_ONLY=create,edit,motion,pen,effect,keys,export,shots runs some)
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_MASK_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-mask-home');
const ctx = await launch({ fixture: 'core', port: 9764, name: 'cut-mask', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const F = T / 30;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'masks', 'compositor', 'export', 'media', 'testsrc', 'decoder'].every((k) => !!Cut[k]) && !!Cut.ui.masks && !!Cut.ui.maskOverlay && ['timeline', 'controls', 'program'].every((p) => Cut.ui.panels.has(p))`),
  'the modules and panels this suite uses are loaded');

const dirs = await js(`ide.api.invoke('cut:home')`);
const P = (name) => path.join(dirs.projects, name);
const mp4 = P('mask-src.mp4');
const made = await js(`(async () => { const r = await Cut.testsrc.write(${S(mp4)}, { seconds: 4, fps: [30, 1], w: 1280, h: 720, beepEvery: 100 }); return r.ok ? 'ok' : JSON.stringify(r.error); })()`);
check(made === 'ok', `a 4 s 1280x720 30 fps test video is written (${made})`);

// ---------- page helpers ----------
await js(`(() => {
  const H = (window.__mk = {});
  const T = Cut.time.TICKS;
  const F = Cut.time.frameTicks([30, 1]);
  const C = Cut.commands;
  H.seq = () => Cut.app.sequence;
  H.clip = () => H.seq().clips.find((c) => c.id === H.id);
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height }; };
  H.steps = () => Cut.app.history.position;
  H.label = () => Cut.app.history.list()[Cut.app.history.position - 1]?.label;
  H.ec = (sel) => { const n = document.querySelector('.cut-panel[data-panel="controls"] ' + sel); if (!n) return null; n.scrollIntoView({ block: 'center' }); return H.rect(n); };
  // V1: the test video's 0-4 s; the clip selected by a click on it (the suite does that), the playhead at frame 15.
  H.fresh = async (file) => {
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1], w: 1280, h: 720 } }), { limit: Infinity });
    Cut.app.setHistory(h, null, 'open');
    const s = H.seq().id;
    const ids = await Cut.ui.media.importPaths(Cut.app, [file]);
    H.media = ids[0];
    H.id = h.do(C.place(s, { source: { media: ids[0] }, in: 0, out: 4 * T, at: 0, video: 'V1', audio: null, mode: 'overwrite' })).ids[0];
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project)), { limit: Infinity }), null, 'open');
    Cut.ui.masks.select(Cut.app, null);
    Cut.app.setTime(15 * F);
    Cut.ui.showPanel('timeline');
    Cut.ui.showPanel('controls');
    Cut.ui.showPanel('program');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tl = Cut.ui.timeline;
    const width = tl.root.querySelector('.cut-tl-scroll').clientWidth;
    tl.setZoom(Math.max(60, Math.floor((width - 40) / 5)), { t: 0, x: 0 });
    tl.setScroll(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = tl.clientPoint(2 * T, 'V1', 0.5);
    return { s, id: H.id, at: { x: Math.round(p.x), y: Math.round(p.y) } };
  };
  // The program monitor drawn at the playhead: its pixels and how to read the one under a client point.
  H.render = async () => {
    const m = Cut.ui.monitors.program;
    await m.player.ready;
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 40)); await m.player.render(); }
    const comp = m.player.compositor;
    const px = await comp.readPixels();
    const cv = m.view.querySelector('canvas');
    const r = cv.getBoundingClientRect();
    H.shot = { px, w: comp.width, h: comp.height, r };
    return true;
  };
  H.at = (pt) => {
    const s = H.shot;
    const x = Math.max(0, Math.min(s.w - 1, Math.floor(((pt.x - s.r.left) * s.w) / s.r.width)));
    const y = Math.max(0, Math.min(s.h - 1, Math.floor(((pt.y - s.r.top) * s.h) / s.r.height)));
    const i = (y * s.w + x) * 4;
    return [s.px[i], s.px[i + 1], s.px[i + 2]];
  };
  // the client point of a picture point (fractions of the clip's picture), through its motion
  H.pic = (u, v) => Cut.ui.masks.clientPoint(u, v);
  H.parts = () => Cut.ui.masks.screen();
  H.mask = (i = 0) => H.clip().masks?.[i] || null;
  // The frame's rectangle of the canvas pixels, averaged into a cols x rows grid of sRGB values (the export check).
  H.grid = (px, w, h, seqW, seqH, cols, rows) => {
    const k = Math.min(w / seqW, h / seqH);
    const fw = seqW * k, fh = seqH * k, ox = (w - fw) / 2, oy = (h - fh) / 2;
    const out = [];
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.round(ox + (gx * fw) / cols), x1 = Math.round(ox + ((gx + 1) * fw) / cols);
      const y0 = Math.round(oy + (gy * fh) / rows), y1 = Math.round(oy + ((gy + 1) * fh) / rows);
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; s += px[i] + px[i + 1] + px[i + 2]; n += 3; }
      out.push(n ? s / n : 0);
    }
    return out;
  };
  H.exportFrames = async (file, frames) => {
    const opened = await Cut.media.openPath(file);
    const src = Cut.decoder.createFrameSource(opened, opened.video, { hardware: false });
    const out = [];
    for (const i of frames) {
      const f = await src.frameAt(Cut.time.frameStart(i, [30, 1]));
      const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(f, 0, 0);
      src.release(f);
      out.push(H.grid(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, 1280, 720, 32, 18));
    }
    src.close();
    return out;
  };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
const MOD = { Alt: 1, Ctrl: 2, Shift: 8 };
const mods = (list) => list.reduce((a, k) => a | MOD[k], 0);
async function clickAt(p, { modifiers = [] } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers: m });
  await mouse('mousePressed', p.x, p.y, { modifiers: m });
  await mouse('mouseReleased', p.x, p.y, { modifiers: m, buttons: 0 });
  await sleep(200);
}
async function drag(a, b, { modifiers = [], steps = 14 } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0, modifiers: m });
  await mouse('mousePressed', a.x, a.y, { modifiers: m });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { modifiers: m });
    await sleep(16);
  }
  await mouse('mouseReleased', b.x, b.y, { modifiers: m });
  await sleep(300);
}
const steps = () => js('__mk.steps()');
const label = () => js('__mk.label()');
const lum = (c) => (c[0] + c[1] + c[2]) / 3;
const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
// the pixels under client points, after the monitor drew the playhead
async function sample(points) {
  await js('__mk.render()');
  return js(`${S(points)}.map((p) => __mk.at(p))`);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await press('Escape');
  await js(`(document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()), ide.ui.closeMenus(), true)`);
}
// A fresh project, the clip clicked in the timeline, and the program monitor's picture without masks at a few points.
async function fresh() {
  const c = await js(`__mk.fresh(${S(mp4)})`);
  await clickAt(c.at);
  await sleep(300);
  check(await js(`Cut.app.selection.has(${S(c.id)})`), 'a click on the clip in the timeline selects it');
  return c;
}
const opacityButton = (cls) => js(`__mk.ec('[data-section="opacity"] .${cls}')`);

// ---------- Create Ellipse Mask and Create 4-point Polygon Mask ----------
await section('create', async () => {
  await fresh();
  const pts = await js(`[__mk.pic(0.5, 0.5), __mk.pic(0.03, 0.04), __mk.pic(0.62, 0.5), __mk.pic(0.5, 0.95)]`);
  const ref = await sample(pts);
  check(ref.every((c) => lum(c) > 30), `the test picture is not black where the suite looks (${S(ref)})`);
  const before = await steps();
  await clickAt(await opacityButton('cut-ec-maskellipse'));
  let m = await js('__mk.mask(0)');
  check(m && m.mode === 'add' && m.feather === 10 && m.opacity === 100 && m.expansion === 0 && m.inverted === false && m.path.length === 24, `Create Ellipse Mask puts a mask on Opacity with Premiere's defaults (${S(m && { feather: m.feather, opacity: m.opacity, expansion: m.expansion, vertices: m.path.length / 6 })})`);
  check((await steps()) === before + 1 && (await label()) === 'Add Mask', `one undo step, Add Mask (${await label()})`);
  const ec = await js(`(() => { const s = document.querySelector('.cut-panel[data-panel="controls"] [data-section="opacity"]'); return { head: s.querySelector('.cut-ec-maskhead')?.textContent, selected: !!s.querySelector('.cut-ec-maskhead.selected'), rows: [...s.querySelectorAll('.cut-ec-maskrow .cut-ec-label')].map((n) => n.textContent) }; })()`);
  check(ec.head === 'Mask (1)' && ec.selected && S(ec.rows) === S(['Mask Path', 'Mask Feather', 'Mask Opacity', 'Mask Expansion', 'Inverted', 'Mask Mode']), `Effect Controls shows Mask (1), selected, with its rows (${S(ec)})`);
  const parts = await js('__mk.parts()');
  check(parts && parts.vertices.length === 4 && (await js(`!document.querySelector('.cut-mask-svg').classList.contains('hidden') && document.querySelector('.cut-ov-svg').classList.contains('hidden')`)), 'the program monitor draws the mask (four vertices) instead of the motion handles');
  let got = await sample(pts);
  check(dist(got[0], ref[0]) <= 6 && lum(got[1]) < 3 && lum(got[3]) < 3, `the clip shows only inside the ellipse: center ${S(got[0])} (was ${S(ref[0])}), corner ${S(got[1])}, bottom ${S(got[3])}`);
  await clickAt(await opacityButton('cut-ec-maskpoly'));
  m = await js('__mk.mask(1)');
  check(m && m.path.length === 24 && m.path.every((v, i) => i % 6 < 2 || v === 0), 'Create 4-point Polygon Mask adds four corner vertices');
  got = await sample(pts);
  check((await steps()) === before + 2 && dist(got[2], ref[2]) <= 6, `the second mask adds its square (Add): a point inside the square shows the clip (${S(got[2])})`);
  await press('Ctrl+z');
  await sleep(300);
  check((await js('__mk.clip().masks.length')) === 1, 'Ctrl+Z takes the polygon mask back');
  await press('Ctrl+z');
  await sleep(300);
  got = await sample(pts);
  check((await js('__mk.clip().masks')) === undefined && dist(got[1], ref[1]) <= 6, 'Ctrl+Z again: no mask, the whole picture shows');
  await press('Ctrl+Shift+z');
  await sleep(300);
  check((await js('__mk.clip().masks.length')) === 1, 'Ctrl+Shift+Z brings the ellipse back');
});

// ---------- editing on the program monitor ----------
await section('edit', async () => {
  await fresh();
  await clickAt(await opacityButton('cut-ec-maskellipse'));
  await sleep(300);
  // the ellipse is a circle of radius 180 px (a quarter of 720) at (640, 360); vertex 1 is its right point
  let parts = await js('__mk.parts()');
  const beyond = await js('__mk.pic((640 + 230) / 1280, 0.5)');
  let got = await sample([beyond]);
  check(lum(got[0]) < 3, `a point 230 px right of the center is outside the mask (${S(got[0])})`);
  let before = await steps();
  const v1 = parts.vertices[1];
  await drag(v1, { x: v1.x + (beyond.x - v1.x) + 40, y: v1.y });
  let m = await js('__mk.mask(0)');
  got = await sample([beyond]);
  check(m.path[6] * 1280 > 640 + 250 && (await steps()) === before + 1 && (await label()) === 'Mask Path' && lum(got[0]) > 30, `dragging the right vertex out moves it (${(m.path[6] * 1280).toFixed(0)} px) in one step (Mask Path), and the point now shows the clip (${S(got[0])})`);
  await press('Ctrl+z');
  await sleep(300);
  got = await sample([beyond]);
  check(lum(got[0]) < 3 && Math.abs((await js('__mk.mask(0)')).path[6] * 1280 - 820) < 0.5, 'Ctrl+Z puts the vertex back');
  // the whole mask
  const left = await js('__mk.pic((640 - 150) / 1280, 0.5)');
  const center = await js('__mk.pic(0.5, 0.5)');
  got = await sample([left]);
  check(lum(got[0]) > 30, 'a point 150 px left of the center is inside');
  before = await steps();
  await drag(center, { x: center.x + (beyond.x - center.x), y: center.y });
  m = await js('__mk.mask(0)');
  got = await sample([left, beyond]);
  check(Math.abs(m.path[0] * 1280 - (640 + 230)) < 3 && (await steps()) === before + 1 && lum(got[0]) < 3 && lum(got[1]) > 30, `dragging inside moves the whole mask 230 px right in one step: the left point is out (${S(got[0])}), the right one in (${S(got[1])})`);
  await press('Ctrl+z');
  await sleep(300);
  // the feather handle: up makes the edge softer (Mask Feather, two picture pixels a pixel dragged)
  parts = await js('__mk.parts()');
  const edgeOut = await js('__mk.pic((640 + 186) / 1280, 0.5)');
  const edgeIn = await js('__mk.pic((640 + 174) / 1280, 0.5)');
  const hard = await sample([edgeOut, edgeIn, center]);
  before = await steps();
  await drag(parts.feather, { x: parts.feather.x + parts.up[0] * 30, y: parts.feather.y + parts.up[1] * 30 });
  m = await js('__mk.mask(0)');
  const soft = await sample([edgeOut, edgeIn, center]);
  const wantFeather = 10 + (2 * 30) / parts.kUp;
  check(Math.abs(m.feather - wantFeather) < 2 && (await steps()) === before + 1 && (await label()) === 'Mask Feather', `dragging the feather handle 30 px out sets Mask Feather to ${m.feather} (want about ${wantFeather.toFixed(1)}) in one step`);
  check(lum(soft[0]) > lum(hard[0]) + 4 && lum(soft[1]) < lum(hard[1]) - 4 && dist(soft[2], hard[2]) <= 6, `the edge gets softer: 6 px outside ${S(hard[0])} -> ${S(soft[0])}, 6 px inside ${S(hard[1])} -> ${S(soft[1])}, the center the same`);
  check(await js(`!!document.querySelector('.cut-mask-guide.feather')?.getAttribute('points')`), 'the feather guide line is drawn');
  // the expansion handle
  parts = await js('__mk.parts()');
  before = await steps();
  await drag(parts.expansion, { x: parts.expansion.x + parts.up[0] * 20, y: parts.expansion.y + parts.up[1] * 20 });
  m = await js('__mk.mask(0)');
  check(Math.abs(m.expansion - 20 / parts.kUp) < 1.5 && (await steps()) === before + 1 && (await label()) === 'Mask Expansion', `dragging the expansion handle sets Mask Expansion (${m.expansion}) in one step`);
  check(await js(`!!document.querySelector('.cut-mask-guide:not(.feather)')?.getAttribute('points')`), 'the expansion guide line is drawn');
  await press('Ctrl+z');
  await press('Ctrl+z');
  await sleep(300);
  // Alt+click: vertex 0 corner <-> smooth; Ctrl+click: it goes; a click on the outline: a vertex there
  parts = await js('__mk.parts()');
  before = await steps();
  await clickAt(parts.vertices[0], { modifiers: ['Alt'] });
  m = await js('__mk.mask(0)');
  check(m.path.slice(2, 6).every((v) => v === 0) && (await steps()) === before + 1, 'Alt+click on a smooth vertex makes it a corner (one step)');
  await clickAt(parts.vertices[0], { modifiers: ['Alt'] });
  m = await js('__mk.mask(0)');
  check(!m.path.slice(2, 6).every((v) => v === 0), 'Alt+click again makes it smooth');
  await clickAt(parts.vertices[2], { modifiers: ['Ctrl'] });
  m = await js('__mk.mask(0)');
  check(m.path.length === 18 && (await steps()) === before + 3, 'Ctrl+click on a vertex deletes it (three left, one step)');
  parts = await js('__mk.parts()');
  await clickAt(parts.edge0);
  m = await js('__mk.mask(0)');
  check(m.path.length === 24 && (await steps()) === before + 4, 'a click on the outline adds a vertex there (one step)');
  await clickAt((await js('__mk.parts()')).edge0, { modifiers: ['Ctrl'] });
  check((await js('__mk.mask(0)')).path.length === 30, 'Ctrl+click on the outline adds one too (Premiere\'s modifier)');
  // a click outside lets the mask go: the motion handles are back
  await clickAt(await js('__mk.pic(0.03, 0.5)'));
  check(await js(`Cut.ui.masks.selected === null && document.querySelector('.cut-mask-svg').classList.contains('hidden') && !document.querySelector('.cut-ov-svg').classList.contains('hidden')`), 'a click outside the mask lets it go and the motion handles come back');
});

// ---------- the mask follows the clip's motion ----------
await section('motion', async () => {
  const c = await fresh();
  await clickAt(await opacityButton('cut-ec-maskellipse'));
  const inside = await js('__mk.pic(0.5, 0.5)');
  await js(`(Cut.app.history.do(Cut.commands.setClip(${S(c.s)}, ${S(c.id)}, { props: { ...__mk.clip().props, position: [300, 0] } })), true)`);
  await sleep(300);
  const moved = await js('__mk.pic(0.5, 0.5)');
  const got = await sample([inside, moved]);
  check(moved.x > inside.x + 50 && lum(got[0]) < 3 && lum(got[1]) > 30, `with the clip 300 px right the mask goes along: the old center is out (${S(got[0])}), the mask's center in (${S(got[1])})`);
  const parts = await js('__mk.parts()');
  check(Math.abs(parts.vertices[0].x - moved.x) <= 1, 'the monitor draws the mask where the clip is');
});

// ---------- the Free Draw Bezier pen ----------
await section('pen', async () => {
  await fresh();
  const pen = await opacityButton('cut-ec-maskpen');
  await clickAt(pen);
  check(await js(`Cut.ui.masks.pen?.clipId === __mk.id && document.querySelector('.cut-ec-maskpen').getAttribute('aria-pressed') === 'true'`), 'the Free draw bezier button starts the pen');
  const before = await steps();
  const q = await js(`[__mk.pic(0.2, 0.2), __mk.pic(0.7, 0.25), __mk.pic(0.75, 0.8), __mk.pic(0.25, 0.75)]`);
  await clickAt(q[0]);
  await clickAt(q[1]);
  await drag(q[2], { x: q[2].x + 40, y: q[2].y + 10 }, { steps: 6 });
  await clickAt(q[3]);
  check((await steps()) === before && !(await js('__mk.clip().masks')), 'the points so far make no undo step and no mask');
  await clickAt(q[0]);
  const m = await js('__mk.mask(0)');
  check(m && m.path.length === 24 && (await steps()) === before + 1 && (await label()) === 'Add Mask', `clicking the first point closes the path: a mask of four vertices in one step (${m && m.path.length / 6})`);
  check(m && m.path.slice(0, 6).slice(2).every((v) => v === 0) && !m.path.slice(12, 18).slice(2).every((v) => v === 0), 'clicked points are corners, the dragged one is smooth');
  const got = await sample([await js('__mk.pic(0.45, 0.5)'), await js('__mk.pic(0.05, 0.5)'), await js('__mk.pic(0.95, 0.1)')]);
  check(lum(got[0]) > 30 && lum(got[1]) < 3 && lum(got[2]) < 3, `the clip shows inside the drawn mask only (${S(got)})`);
  // Escape gives up a drawing
  await clickAt(pen);
  await clickAt(q[0]);
  await press('Escape');
  check(await js(`Cut.ui.masks.pen === null && __mk.clip().masks.length === 1`), 'Escape gives up a path being drawn');
});

// ---------- an effect limited by a mask ----------
await section('effect', async () => {
  const c = await fresh();
  const inPt = await js('__mk.pic(0.5, 0.5)');
  const outPt = await js('__mk.pic(0.05, 0.5)');
  const ref = await sample([inPt, outPt]);
  const e = await js(`Cut.app.history.do(Cut.commands.addEffect(${S(c.s)}, ${S(c.id)}, 'color.invert')).id`);
  await sleep(300);
  const btn = await js(`__mk.ec('[data-section="fx:${c.id}:${e}"] .cut-ec-maskellipse')`);
  check(!!btn, 'Invert has the mask buttons in Effect Controls');
  await clickAt(btn);
  check((await js(`__mk.clip().effects[0].masks?.length`)) === 1 && (await js('__mk.clip().masks')) === undefined, 'Create Ellipse Mask on the effect puts the mask on the effect, not on Opacity');
  let got = await sample([inPt, outPt]);
  check(got[0].every((v, i) => Math.abs(v - (255 - ref[0][i])) <= 6) && dist(got[1], ref[1]) <= 6, `Invert works inside the ellipse only: inside ${S(ref[0])} -> ${S(got[0])}, outside ${S(ref[1])} -> ${S(got[1])}`);
  // Lumetri Color's exposure outside an inverted mask
  await js(`(Cut.app.history.do(Cut.commands.removeEffect(${S(c.s)}, ${S(c.id)}, ${S(e)})), true)`);
  const lu = await js(`Cut.app.history.do(Cut.commands.addEffect(${S(c.s)}, ${S(c.id)}, 'color.basic', null, { exposure: 1.5 })).id`);
  await sleep(300);
  await clickAt(await js(`__mk.ec('[data-section="fx:${c.id}:${lu}"] .cut-ec-maskellipse')`));
  const sel = `[data-section="fx:${c.id}:${lu}"] [data-path$=".inverted"] input`;
  const inv = await js(`__mk.ec(${S(sel)})`);
  const under = await js(`(() => { const r = __mk.ec(${S(sel)}); const n = r && document.elementFromPoint(r.x, r.y); return n ? n.tagName + '.' + n.className : null; })()`);
  await clickAt(inv);
  check((await js('__mk.clip().effects[0].masks?.[0]?.inverted')) === true && (await label()) === 'Mask', `the Inverted box inverts the effect's mask (one step, Mask; the box ${S(inv)}, under it ${under})`);
  const r0 = await sample([outPt, inPt]);
  check(lum(r0[0]) > lum(ref[1]) + 10 && dist(r0[1], ref[0]) <= 6, `Lumetri Color brightens around the mask and leaves the inside as it was (outside ${S(ref[1])} -> ${S(r0[0])}, inside ${S(ref[0])} -> ${S(r0[1])})`);
});

// ---------- Mask Path keyframes ----------
await section('keys', async () => {
  await fresh();
  await clickAt(await opacityButton('cut-ec-maskellipse'));
  await js(`Cut.app.setTime(0)`);
  await sleep(300);
  await clickAt(await js(`__mk.ec('[data-section="opacity"] [data-path$=".path"] .watch')`));
  let k = await js(`__mk.clip().keyframes['masks.m1.path']`);
  check(k?.length === 1 && k[0].t === 0 && (await js(`document.querySelector('.cut-panel[data-panel="controls"] [data-path$=".path"] .watch').getAttribute('aria-pressed')`)) === 'true', 'the Mask Path stopwatch makes a keyframe at the playhead');
  await js(`Cut.app.setTime(${20 * F})`);
  await sleep(300);
  const center = await js('__mk.pic(0.5, 0.5)');
  const right = await js('__mk.pic((640 + 300) / 1280, 0.5)');
  const before = await steps();
  await drag(center, right);
  k = await js(`__mk.clip().keyframes['masks.m1.path']`);
  check(k?.length === 2 && k[1].t === 20 * F && Math.abs(k[1].v[0] * 1280 - 940) < 3 && Math.abs(k[0].v[0] * 1280 - 640) < 0.5 && (await steps()) === before + 1, `dragging the mask at frame 20 makes a keyframe there; the first stays (${S(k?.map((x) => [x.t / F, Math.round(x.v[0] * 1280)]))})`);
  await js(`Cut.app.setTime(${10 * F})`);
  await sleep(300);
  const mid = await js('__mk.pic((640 + 150) / 1280, 0.5)');
  const farLeft = await js('__mk.pic((640 - 100) / 1280, 0.5)');
  let got = await sample([mid, farLeft]);
  check(lum(got[0]) > 30 && lum(got[1]) < 3, `at frame 10 the mask is half way (150 px right): its center shows the clip ${S(got[0])}, 100 px left of the old center is out ${S(got[1])}`);
  const parts = await js('__mk.parts()');
  check(Math.abs(parts.vertices[0].x - mid.x) <= 2, 'the monitor draws the path half way too');
  await js(`Cut.app.setTime(0)`);
  got = await sample([farLeft]);
  check(lum(got[0]) > 30, 'at frame 0 the path is where the first keyframe has it');
});

// ---------- the export shows what the monitor shows ----------
await section('export', async () => {
  const c = await fresh();
  await clickAt(await opacityButton('cut-ec-maskellipse'));
  await js(`(Cut.app.history.do(Cut.commands.setMask(${S(c.s)}, ${S(c.id)}, 'm1', { feather: 60 })), Cut.app.history.do(Cut.commands.setKeyframes(${S(c.s)}, ${S(c.id)}, 'masks.m1.path', [{ t: 0, v: __mk.mask(0).path, ease: 'linear' }, { t: ${30 * F}, v: Cut.masks.translate(__mk.mask(0).path, 0.25, 0), ease: 'linear' }])), true)`);
  const e = await js(`Cut.app.history.do(Cut.commands.addEffect(${S(c.s)}, ${S(c.id)}, 'color.invert')).id`);
  await js(`(Cut.app.history.do(Cut.commands.addMask(${S(c.s)}, ${S(c.id)}, { path: Cut.masks.polygon(1280, 720, { cx: 0.3, cy: 0.4, s: 300 }), feather: 0 }, { effectId: ${S(e)} })), true)`);
  const frames = [0, 15, 29];
  const shown = [];
  for (const f of frames) {
    await js(`Cut.app.setTime(${f * F})`);
    await js('__mk.render()');
    shown.push(await js(`(() => { const s = __mk.shot; return __mk.grid(s.px, s.w, s.h, 1280, 720, 32, 18); })()`));
  }
  const r = await js(`(async () => {
    const out = await Cut.export.run({ project: Cut.app.project, seqId: __mk.seq().id, path: ${S(P('mask-out.mp4'))}, preset: '720p', range: { in: 0, out: ${30 * F} }, overrides: { loudness: null } });
    if (!out.ok) return { error: out.error };
    return { frames: out.frames, grids: await __mk.exportFrames(out.path, ${S(frames)}) };
  })()`);
  check(!r.error, `the export finishes (${r.error || 'ok'})`);
  if (r.error) return;
  const cmp = frames.map((f, i) => {
    let sum = 0, max = 0;
    shown[i].forEach((v, j) => { const d = Math.abs(v - r.grids[i][j]); sum += d; max = Math.max(max, d); });
    return { frame: f, mean: +(sum / shown[i].length).toFixed(2), max: +max.toFixed(1) };
  });
  const moving = frames.map((f, i) => shown[i].reduce((s, v, j) => s + Math.abs(v - shown[0][j]), 0) / shown[0].length);
  check(r.frames === 30 && cmp.every((x) => x.mean < 3 && x.max < 16), `the exported frames match the program monitor's, 32 x 18 blocks (${S(cmp)})`);
  check(moving[2] > 5, `and the mask moves through them (${moving.map((v) => v.toFixed(1)).join(', ')})`);
});

// ---------- screenshots ----------
await section('shots', async () => {
  const c = await fresh();
  await clickAt(await opacityButton('cut-ec-maskellipse'));
  await js(`(Cut.app.history.do(Cut.commands.setMask(${S(c.s)}, ${S(c.id)}, 'm1', { feather: 40, expansion: 12 })), true)`);
  await sleep(500);
  log(`  saved ${await ctx.shot('mask-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(500);
  log(`  saved ${await ctx.shot('mask-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

ctx.finish();
