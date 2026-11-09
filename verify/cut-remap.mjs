// Nano Studio Cut's Time Remapping (Premiere's Time Remapping > Speed) in the real app, with real input events
// (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and the real export, on a 30 fps testsrc whose frames show their
// numbers:
// - the fx badge's menu shows Time Remapping > Speed on the clip's line; Ctrl+click on the line adds a speed key;
// - dragging the line after the key down to 50% shows the speed in a tooltip, makes the clip 5 s long in one undo step,
//   leaves the clip after it and the linked audio where they were, and the program monitor shows each source frame
//   twice after the key; Ctrl+Z and Ctrl+Shift+Z;
// - dragging the key's right half makes a 10-frame speed transition (tooltip, same length, the frames through it);
//   Alt+drag of the key's tab moves it keeping the speeds; Ctrl+drag makes a reverse segment, Ctrl+Alt+drag a hold;
//   a click with the Pen adds a key;
// - Effect Controls shows Time Remapping > Speed: the speed at the playhead, the stopwatch on, a key added with the
//   diamond, a speed typed in;
// - Clip > Time Interpolation > Frame Blending mixes the two source frames on the program monitor;
// - an export of the remapped clip shows the same frames as the program monitor and the mapping;
// - screenshots of the speed line (verify/out/cut-remap/*.png, dark and light).
// Usage: node verify/cut-remap.mjs   (CUT_REMAP_ONLY=band,ramp,keys,controls,blend,export,shots runs some)
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_REMAP_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-remap-home');
const ctx = await launch({ fixture: 'core', port: 9785, name: 'cut-remap', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const F = T / 30;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'remap', 'compositor', 'export', 'media', 'testsrc', 'decoder'].every((k) => !!Cut[k]) && ['timeline', 'controls', 'program'].every((p) => Cut.ui.panels.has(p))`),
  'the modules and panels this suite uses are loaded');

const dirs = await js(`ide.api.invoke('cut:home')`);
const P = (name) => path.join(dirs.projects, name);
const mp4 = P('remap-src.mp4');
const made = await js(`(async () => { const r = await Cut.testsrc.write(${S(mp4)}, { seconds: 8, fps: [30, 1], w: 1280, h: 720, beepEvery: 1 }); return r.ok ? 'ok' : JSON.stringify(r.error); })()`);
check(made === 'ok', `an 8 s 1280x720 30 fps test video is written (${made})`);

// ---------- page helpers ----------
await js(`(() => {
  const H = (window.__rm = {});
  const T = Cut.time.TICKS;
  const F = Cut.time.frameTicks([30, 1]);
  const C = Cut.commands;
  H.seq = () => Cut.app.sequence;
  H.clip = (id) => H.seq().clips.find((c) => c.id === id);
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; };
  H.steps = () => Cut.app.history.position;
  H.label = () => Cut.app.history.list()[Cut.app.history.position - 1]?.label;
  H.tip = () => { const n = document.querySelector('.cut-tl-tip.shown'); return n ? n.textContent : ''; };
  H.toast = () => document.querySelector('.cut-root > .cut-toast.shown')?.textContent || '';
  // a point of the clip's body in its name bar, in client pixels
  H.at = (t, track, dy) => { const p = Cut.ui.timeline.clientPoint(t, track, dy); return { x: Math.round(p.x), y: Math.round(p.y) }; };
  // the client y of a speed on the V1 line (the line's log scale: 10% at the bottom, 1000% at the top)
  H.speedY = (pct) => {
    const r = Cut.ui.timeline.rowOf('V1');
    const box = Cut.ui.timeline.root.querySelector('.cut-tl-scroll').getBoundingClientRect();
    const top = box.top + r.y + 1 + 16;
    const bottom = box.top + r.y + 1 + (r.h - 3) - 4;
    return Math.round(bottom - ((Math.log10(pct) - 1) / 2) * (bottom - top));
  };
  H.line = (id, t, key) => { const p = Cut.ui.timeline.remapPoint(id, t, key); return p && { x: Math.round(p.x), y: Math.round(p.y) }; };
  // V1: the test video's 0-3 s at 0 with its sound on A1, a second clip at 6 s; V1 tall enough to read speeds off the
  // line. A fresh history on that project.
  H.fresh = async (file) => {
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1], w: 1280, h: 720 } }), { limit: Infinity });
    Cut.app.setHistory(h, null, 'open');
    const s = H.seq().id;
    const ids = await Cut.ui.media.importPaths(Cut.app, [file]);
    const [v, a] = h.do(C.place(s, { source: { media: ids[0] }, in: 0, out: 3 * T, at: 0, video: 'V1', audio: 'A1', mode: 'overwrite' })).ids;
    const [w] = h.do(C.place(s, { source: { media: ids[0] }, in: 7 * T, out: 8 * T, at: 6 * T, video: 'V1', audio: null, mode: 'overwrite' })).ids;
    h.do(C.setTrack(s, 'V1', { height: 200 }));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project)), { limit: Infinity }), null, 'open');
    Cut.app.setTime(0);
    Cut.ui.showPanel('timeline');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tl = Cut.ui.timeline;
    const width = tl.root.querySelector('.cut-tl-scroll').clientWidth;
    tl.setZoom(Math.max(60, Math.floor((width - 40) / 7.5)), { t: 0, x: 0 });
    tl.setScroll(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { s, media: ids[0], v, a, w };
  };
  // The program monitor at timeline frame k: its pixels and the testsrc frame number it shows.
  H.program = async (k) => {
    const m = Cut.ui.monitors.program;
    await m.player.ready;
    Cut.app.setTime(k * F);
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 50)); await m.player.render(); }
    const comp = m.player.compositor;
    const px = await comp.readPixels();
    return { px, w: comp.width, h: comp.height, n: Cut.testsrc.readFrameNumber(px, comp.width, comp.height) };
  };
  H.numbers = async (frames) => { const out = []; for (const k of frames) out.push((await H.program(k)).n); return out; };
  H.diff = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]); return sum / (a.length * 0.75); };
  // half of each picture mixed in linear light, as the compositor mixes
  H.mix = (a, b) => {
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const enc = (c) => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    const out = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (i & 3) === 3 ? a[i] : enc((lin(a[i]) + lin(b[i])) / 2);
    return out;
  };
  H.readExport = async (file, frames) => {
    const opened = await Cut.media.openPath(file);
    const src = Cut.decoder.createFrameSource(opened, opened.video, { hardware: false });
    const out = [];
    for (const i of frames) {
      const f = await src.frameAt(Cut.time.frameStart(i, [30, 1]));
      const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(f, 0, 0);
      src.release(f);
      out.push(Cut.testsrc.readFrameNumber(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height));
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
async function clickAt(p, { modifiers = [], button = 'left' } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers: m });
  await mouse('mousePressed', p.x, p.y, { modifiers: m, button, buttons: button === 'right' ? 2 : 1 });
  await mouse('mouseReleased', p.x, p.y, { modifiers: m, buttons: 0, button });
  await sleep(150);
}
// A drag with the real mouse; `during` runs before the release (the tooltip is read there).
async function drag(a, b, { modifiers = [], steps = 16, during = null } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0, modifiers: m });
  await mouse('mousePressed', a.x, a.y, { modifiers: m });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { modifiers: m });
    await sleep(20);
  }
  const seen = during ? await during() : null;
  await mouse('mouseReleased', b.x, b.y, { modifiers: m });
  await sleep(250);
  return seen;
}
const steps = () => js('__rm.steps()');
const curve = (id) => js(`(() => { const c = __rm.clip(${S(id)}); return { remap: c.remap, dur: Cut.model.clipDuration(c) / ${F}, start: c.start / ${F}, in: c.in / ${F}, out: c.out / ${F} }; })()`);
async function menuItem(label) {
  const r = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].reverse().find((x) => x.querySelector('.menu-label')?.textContent === ${S(label)}); return n && !n.classList.contains('disabled') ? __rm.rect(n) : null; })()`);
  if (r) await clickAt(r);
  await sleep(150);
  return !!r;
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await press('Escape');
  await js(`(document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()), ide.ui.closeMenus(), true)`);
}
// The speed line shown on V1 through the clip's fx badge, then a key at 1 s with Ctrl+click on the line.
async function showSpeedAndKey(c) {
  const badge = await js(`(() => { const p = __rm.at(0, 'V1', 0); const r = Cut.ui.timeline.rowOf('V1'); const box = Cut.ui.timeline.root.querySelector('.cut-tl-scroll').getBoundingClientRect(); return { x: Math.round(p.x + 9), y: Math.round(box.top + r.y + 8) }; })()`);
  await clickAt(badge);
  const opened = await menuItem('Time Remapping') && await menuItem('Speed');
  check(opened, 'the fx badge opens a menu with Time Remapping > Speed');
  await sleep(200);
  const p = await js(`__rm.line(${S(c.v)}, ${T})`);
  check(Math.abs(p.y - (await js('__rm.speedY(100)'))) <= 1, `the clip's line now shows its speed: 100% across the middle (y ${p.y})`);
  const before = await steps();
  await clickAt(p, { modifiers: ['Ctrl'] });
  const r = await curve(c.v);
  check(S(r.remap?.keys) === S([{ t: 30 * F, ramp: 0 }]) && r.dur === 90 && (await steps()) === before + 1 && (await js('__rm.label()')) === 'Time Remapping', `Ctrl+click on the line adds a speed key at 1 s in one undo step (${S(r.remap?.keys)}, ${r.dur} frames)`);
}
// After the key, the line dragged down to 50% (Shift: steps of 5%).
async function slowAfterKey(c) {
  const a = await js(`__rm.line(${S(c.v)}, ${2 * T})`);
  const b = { x: a.x, y: await js('__rm.speedY(50)') };
  const before = await steps();
  const tip = await drag(a, b, { modifiers: ['Shift'], during: () => js('__rm.tip()') });
  return { tip, before };
}

let c = null;

// ---------- the rubber band: show it, Ctrl+click a key, drag a segment's speed ----------
await section('band', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  const audio0 = await js(`JSON.stringify(__rm.clip(${S(c.a)}))`);
  await showSpeedAndKey(c);
  const { tip, before } = await slowAfterKey(c);
  check(/^50%/.test(tip), `the drag shows the speed in a tooltip (${S(tip)})`);
  const r = await curve(c.v);
  check(S(r.remap?.speeds) === S([1, 0.5]) && r.dur === 150 && (await steps()) === before + 1, `the segment after the key plays at 50% and the clip is 150 frames (5 s), one undo step (${S(r.remap?.speeds)}, ${r.dur})`);
  const others = await js(`({ w: __rm.clip(${S(c.w)}).start / ${F}, audio: JSON.stringify(__rm.clip(${S(c.a)})) })`);
  check(others.w === 180 && others.audio === audio0, `the next clip stays at 6 s (no ripple, as in Premiere) and the linked audio is not remapped (${others.w}, ${others.audio === audio0})`);
  const nums = await js('__rm.numbers([0, 15, 29, 30, 31, 32, 33, 60, 100, 149])');
  check(S(nums) === S([0, 15, 29, 30, 30, 31, 31, 45, 65, 89]), `the program monitor shows source frames 0-29, then each frame twice up to frame 89 (${S(nums)})`);
  await js(`(Cut.ui.showPanel('timeline'), Cut.ui.timeline.root.focus(), true)`);
  await clickAt(await js(`__rm.at(${0.5 * T}, 'V1', 0.1)`));
  await press('Ctrl+Z');
  const u = await curve(c.v);
  check(S(u.remap?.speeds) === S([1, 1]) && u.dur === 90, `Ctrl+Z takes the drag back in one step (${S(u.remap?.speeds)}, ${u.dur})`);
  await press('Ctrl+Shift+Z');
  check((await curve(c.v)).dur === 150, 'Ctrl+Shift+Z does it again');
  // slower than the room before the next clip: the clip stops there
  const a = await js(`__rm.line(${S(c.v)}, ${2 * T})`);
  const tip2 = await drag(a, { x: a.x, y: await js('__rm.speedY(20)') }, { modifiers: ['Shift'], during: () => js('__rm.tip()') });
  const r2 = await curve(c.v);
  check(/^20%/.test(tip2) && r2.dur === 180 && (await js(`__rm.clip(${S(c.w)}).start / ${F}`)) === 180, `at 20% the clip grows only up to the next clip, which stays (${S(tip2)}, ${r2.dur} frames)`);
  await press('Ctrl+Z');
});

// ---------- a speed transition from a key's half ----------
await section('ramp', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  await showSpeedAndKey(c);
  await slowAfterKey(c);
  const half = await js(`__rm.line(${S(c.v)}, 0, { index: 0, half: 'right' })`);
  const dx = (await js(`Cut.ui.timeline.xOf(${40 * F}) - Cut.ui.timeline.xOf(${30 * F})`));
  const before = await steps();
  const tip = await drag(half, { x: half.x + dx, y: half.y }, { during: () => js('__rm.tip()') });
  const r = await curve(c.v);
  check(S(r.remap?.keys) === S([{ t: 30 * F, ramp: 10 * F }]) && r.dur === 150 && (await steps()) === before + 1, `dragging the key's right half 10 frames makes a 10-frame speed transition, same length, one step (${S(r.remap?.keys)}, ${r.dur})`);
  check(tip.startsWith('Speed Transition'), `the tooltip names the transition and its length (${S(tip)})`);
  // through the transition the speed falls from 100% to 50%: source 30, 31.9, 34.4, 36.4, 37.5, 38.5 (the integral)
  const nums = await js('__rm.numbers([30, 32, 35, 38, 40, 42])');
  check(S(nums) === S([30, 31, 34, 36, 37, 38]), `the program monitor follows the transition's frames (${S(nums)})`);
  await press('Ctrl+Z');
});

// ---------- moving a key, reverse and hold ----------
await section('keys', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  await showSpeedAndKey(c);
  await slowAfterKey(c);
  const tab = await js(`__rm.line(${S(c.v)}, 0, { index: 0, half: 'tab' })`);
  const dx5 = await js(`Cut.ui.timeline.xOf(${5 * F}) - Cut.ui.timeline.xOf(0)`);
  await drag(tab, { x: tab.x - dx5, y: tab.y }, { modifiers: ['Alt'] });
  let r = await curve(c.v);
  check(S(r.remap?.keys) === S([{ t: 25 * F, ramp: 0 }]) && S(r.remap?.speeds) === S([1, 0.5]) && r.dur === 150, `Alt+drag of the key's tab moves it 5 frames earlier keeping both speeds and the length (${S(r.remap?.keys)}, ${r.dur})`);
  check(S(await js('__rm.numbers([24, 25, 26, 27])')) === S([24, 25, 25, 26]), 'the 50% part now starts at frame 25');
  await press('Ctrl+Z');
  // a plain drag of the tab keeps the key's frame: the segment before it plays slower to reach it
  await drag(tab, { x: tab.x + dx5 * 2, y: tab.y }, { during: () => js('__rm.tip()') });
  r = await curve(c.v);
  check(r.remap?.keys[0].t === 40 * F && Math.abs(r.remap.speeds[0] - 0.75) < 1e-9 && r.dur === 160 && S(await js('__rm.numbers([40])')) === S([30]), `a drag of the tab 10 frames later keeps frame 30 on the key: 75% before it, 10 frames longer (${S(r.remap?.speeds)}, ${r.dur})`);
  await press('Ctrl+Z');
  // Ctrl+drag: a 10-frame reverse after the key, then forward again to its frame
  const key = await js(`__rm.line(${S(c.v)}, 0, { index: 0, half: 'right' })`);
  const dx10 = await js(`Cut.ui.timeline.xOf(${10 * F}) - Cut.ui.timeline.xOf(0)`);
  const tip = await drag(key, { x: key.x + dx10, y: key.y }, { modifiers: ['Ctrl'], during: () => js('__rm.tip()') });
  r = await curve(c.v);
  check(S(r.remap?.speeds) === S([1, -1, 1, 0.5]) && r.dur === 170 && tip.startsWith('Reverse'), `Ctrl+drag of the key makes a 10-frame reverse and the way back (${S(r.remap?.speeds)}, ${r.dur} frames, ${S(tip)})`);
  const rev = await js('__rm.numbers([29, 30, 31, 35, 39, 40, 45, 50, 51])');
  check(S(rev) === S([29, 29, 28, 24, 20, 20, 25, 30, 30]), `the program monitor plays back from the key and forward again (${S(rev)})`);
  await press('Ctrl+Z');
  // Ctrl+Alt+drag: a hold
  await drag(key, { x: key.x + dx10 * 0.6, y: key.y }, { modifiers: ['Ctrl', 'Alt'] });
  r = await curve(c.v);
  check(S(r.remap?.speeds) === S([1, 0, 0.5]) && r.dur === 156, `Ctrl+Alt+drag makes a 6-frame hold at the key (${S(r.remap?.speeds)}, ${r.dur})`);
  check(S(await js('__rm.numbers([29, 30, 33, 35, 36, 38])')) === S([29, 30, 30, 30, 30, 31]), 'the hold shows frame 30 for 6 frames');
  check(await js(`JSON.stringify(__rm.clip(${S(c.a)}).out / ${F}) === '90' && __rm.clip(${S(c.a)}).speed === 1`), 'the linked audio still plays its 3 s at 100%');
  await press('Ctrl+Z');
  // the Pen (P) adds a speed key where it clicks on the line
  await press('p');
  check((await js('Cut.app.tool')) === 'pen', 'P picks the Pen');
  await clickAt(await js(`__rm.line(${S(c.v)}, ${3 * T})`));
  r = await curve(c.v);
  check(S(r.remap?.keys.map((k) => k.t / F)) === S([30, 90]) && S(r.remap.speeds) === S([1, 0.5, 0.5]), `a Pen click on the speed line adds a key at 3 s (${S(r.remap?.keys.map((k) => k.t / F))})`);
  await press('v');
});

// A part of Effect Controls' Time Remapping > Speed row, scrolled into view: its client rectangle, and that it is the
// element under that point.
async function ecRect(part) {
  const sel = `.cut-panel[data-panel="controls"] [data-path="remap.speed"] ${part}`;
  await js(`(document.querySelector(${S(sel)})?.scrollIntoView({ block: 'center' }), true)`);
  await sleep(200);
  const r = await js(`__rm.rect(${S(sel)})`);
  check(r && (await js(`(() => { const n = document.elementFromPoint(${r.x}, ${r.y}); return !!n && !!n.closest(${S(sel)}); })()`)), `Effect Controls' ${part} is on screen where it is clicked`);
  return r;
}
// ---------- Effect Controls: Time Remapping > Speed ----------
await section('controls', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  await showSpeedAndKey(c);
  await slowAfterKey(c);
  await clickAt(await js(`__rm.at(${0.5 * T}, 'V1', 0.1)`));
  await js(`(Cut.ui.showPanel('controls'), Cut.app.setTime(${60 * F}), true)`);
  await sleep(400);
  const ec = await js(`(() => {
    const sec = document.querySelector('.cut-panel[data-panel="controls"] [data-section="remap:${c.v}"]');
    const row = sec?.querySelector('[data-path="remap.speed"]');
    return sec && { name: sec.querySelector('.cut-ec-secname')?.textContent, label: row?.querySelector('.cut-ec-label')?.textContent, value: row?.querySelector('.cut-number-text')?.textContent, watch: row?.querySelector('.watch')?.getAttribute('aria-pressed') };
  })()`);
  check(ec && ec.name === 'Time Remapping' && ec.label === 'Speed' && ec.value === '50.00' && ec.watch === 'true', `Effect Controls shows Time Remapping > Speed: 50% at the playhead, animation on (${S(ec)})`);
  check(!(await js(`!!document.querySelector('.cut-panel[data-panel="controls"] [data-section="speed:${c.v}"]')`)), 'a remapped clip has no Speed section (its speed is the curve)');
  // the diamond adds a key at the playhead (frame 90)
  await js(`Cut.app.setTime(${90 * F})`);
  await sleep(200);
  await clickAt(await ecRect('.addkey'));
  let r = await curve(c.v);
  check(S(r.remap?.keys.map((k) => k.t / F)) === S([30, 90]), `Add/Remove Keyframe adds a speed key at the playhead (${S(r.remap?.keys.map((k) => k.t / F))})`);
  // a speed typed in sets the segment under the playhead
  await clickAt(await ecRect('.cut-number'));
  await until(`!!document.querySelector('.cut-panel[data-panel="controls"] [data-path="remap.speed"] input')`, 'the speed field takes typing', 3000);
  await ctx.type('200');
  await press('Enter');
  await sleep(200);
  r = await curve(c.v);
  check(S(r.remap?.speeds) === S([1, 0.5, 2]) && r.dur === 105 && S(await js('__rm.numbers([90, 91, 92])')) === S([60, 62, 64]), `typing 200 sets the last segment to 200% (${S(r.remap?.speeds)}, ${r.dur} frames)`);
  // the stopwatch turns time remapping off: a constant speed again
  await clickAt(await ecRect('.watch'));
  r = await curve(c.v);
  check(r.remap === null && (await js(`__rm.clip(${S(c.v)}).speed`)) === 1, `Toggle Animation off leaves a constant speed (remap ${S(r.remap)})`);
  await sleep(300);
  check(await js(`!!document.querySelector('.cut-panel[data-panel="controls"] [data-section="speed:${c.v}"]')`), 'and the Speed section is back');
});

// ---------- Frame Blending ----------
await section('blend', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  await showSpeedAndKey(c);
  await slowAfterKey(c);
  const A = await js('__rm.program(30).then((x) => ({ n: x.n, px: Array.from(x.px) }))');
  const B = await js('__rm.program(32).then((x) => ({ n: x.n, px: Array.from(x.px) }))');
  const sampled = await js('__rm.program(31).then((x) => ({ n: x.n, px: Array.from(x.px) }))');
  await clickAt(await js(`__rm.at(${0.5 * T}, 'V1', 0.1)`), { button: 'right' });
  const picked = await menuItem('Time Interpolation') && await menuItem('Frame Blending');
  check(picked && (await js(`__rm.clip(${S(c.v)}).sampling`)) === 'blend', 'Clip > Time Interpolation > Frame Blending is set on the clip');
  const blended = await js('__rm.program(31).then((x) => ({ n: x.n, px: Array.from(x.px) }))');
  const d = await js(`(() => { const a = ${S(A.px)}, b = ${S(B.px)}; return { ab: __rm.diff(a, b), toA: __rm.diff(${S(blended.px)}, a), toMix: __rm.diff(${S(blended.px)}, __rm.mix(a, b)), sampledToA: __rm.diff(${S(sampled.px)}, a) }; })()`);
  check(A.n === 30 && B.n === 31 && sampled.n === 30 && d.sampledToA < d.ab / 10, `with Frame Sampling the frame between shows source frame 30 as it is (${A.n}, ${B.n}, ${sampled.n}, ${d.sampledToA.toFixed(2)} of ${d.ab.toFixed(2)})`);
  check(d.toA > d.ab / 4 && d.toMix < d.ab / 6, `with Frame Blending it mixes frames 30 and 31 half and half (difference to the mix ${d.toMix.toFixed(2)}, to frame 30 ${d.toA.toFixed(2)}, between the frames ${d.ab.toFixed(2)})`);
});

// ---------- the export shows the same frames ----------
await section('export', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  await showSpeedAndKey(c);
  await slowAfterKey(c);
  const frames = [0, 29, 30, 31, 32, 60, 100, 149];
  const shown = await js(`__rm.numbers(${S(frames)})`);
  const r = await js(`(async () => {
    const out = await Cut.export.run({ project: Cut.app.project, seqId: __rm.seq().id, path: ${S(P('remap-out.mp4'))}, preset: '720p', range: { in: 0, out: 150 * ${F} }, overrides: { loudness: null } });
    if (!out.ok) return { error: out.error };
    return { frames: out.frames, nums: await __rm.readExport(out.path, ${S(frames)}) };
  })()`);
  check(!r.error, `the export finishes (${r.error || 'ok'})`);
  if (r.error) return;
  check(r.frames === 150 && S(r.nums) === S(shown) && S(r.nums) === S([0, 29, 30, 30, 31, 45, 65, 89]), `the exported frames are the program monitor's and the curve's (${S(r.nums)} vs ${S(shown)})`);
});

// ---------- screenshots ----------
await section('shots', async () => {
  c = await js(`__rm.fresh(${S(mp4)})`);
  await showSpeedAndKey(c);
  await slowAfterKey(c);
  const half = await js(`__rm.line(${S(c.v)}, 0, { index: 0, half: 'right' })`);
  await drag(half, { x: half.x + (await js(`Cut.ui.timeline.xOf(${10 * F}) - Cut.ui.timeline.xOf(0)`)), y: half.y });
  await js(`(Cut.app.select([${S(c.v)}]), Cut.app.setTime(${35 * F}), true)`);
  await sleep(500);
  log(`  saved ${await ctx.shot('remap-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(500);
  log(`  saved ${await ctx.shot('remap-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

ctx.finish();
