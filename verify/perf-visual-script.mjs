// The first frame of a pan on a 300-node visual script (port 9067): pans with the middle button, the right button and
// Space + drag, each after a second of rest, and after a zoom. Not in CI (it times things), like perf-index.mjs.
//   node verify/perf-visual-script.mjs [--viewport 1008x681]
// firstFrame: from the first mousemove of the gesture to the second animation frame after it, when the frame that
// drew the move has been produced; releaseFrame: the same from the mouseup; long tasks: those within 500 ms of the
// first move or of the mouseup.
// Before -> after (30 middle-button pans per side over 5 interleaved runs, other suites running): first frame 41 ms
// [36-62] -> 24 ms [20-30], worst later frame interval 51 ms [50-83] -> 17 ms [17-18]. Before, the pan restyled all
// 6,700 elements of the graph at its start and end (grab cursor, pointer-events) and painted the layer anew.
import { writeFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { launch, openFile } from './lib.mjs';

const require = createRequire(import.meta.url);
const VSDIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'renderer', 'features', 'visual-script');
require(path.join(VSDIR, 'model.js'));
require(path.join(VSDIR, 'nodes.js'));
const VS = require(path.join(VSDIR, 'codegen.js'));
const BUDGET = { medianMs: 34, worstMs: 50, longTaskMs: 50 };

const t = await launch({ fixture: 'visual-script', port: 9067, name: 'perf-visual-script' });
const { js, until, cdp, sleep, check, project } = t;
const viewport = process.argv.find((a) => a.startsWith('--viewport='))?.slice(11).split('x').map(Number);
if (viewport) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
  await until(`Math.abs(innerWidth - ${viewport[0]}) <= 1 && Math.abs(innerHeight - ${viewport[1]}) <= 1`, 'the emulated viewport');
}
let g = VS.newGraph();
const kinds = ['io.print', 'math.binary', 'var.set'];
for (let i = 0; i < 299; i++) g = VS.addNode(g, { type: kinds[i % 3], x: 64 + (i % 20) * 256, y: 64 + Math.floor(i / 20) * 192 });
const execs = g.nodes.filter((n) => n.type !== 'math.binary');
for (let i = 1; i < execs.length; i++) g = VS.connect(g, { node: execs[i - 1].id, pin: 'next' }, { node: execs[i].id, pin: 'in' });
writeFileSync(path.join(project, 'big.pyflow'), VS.serialize(g));

const V = 'ide.activeTab().visualScript';
const BUTTONS = { left: 1, right: 2, middle: 4 };
const mouse = (type, p, button, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers,
  button: button || 'none', buttons: type === 'mouseReleased' || !button ? 0 : BUTTONS[button] });
const SETUP = `(() => { const s = window.__g = { frames: [], long: [], firstMove: null, up: null, stop: false };
  s.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) s.long.push([e.startTime, e.duration]); }); s.obs.observe({ entryTypes: ['longtask'] });
  s.onMove = (e) => { if (e.buttons && s.firstMove === null) s.firstMove = e.timeStamp; };
  s.onUp = (e) => { s.up ??= e.timeStamp; };
  window.addEventListener('mousemove', s.onMove, { capture: true });
  window.addEventListener('mouseup', s.onUp, { capture: true });
  const loop = (now) => { s.frames.push(now); if (!s.stop) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return 1; })()`;
const COLLECT = `(() => { const s = window.__g; s.stop = true; s.obs.disconnect();
  window.removeEventListener('mousemove', s.onMove, { capture: true }); window.removeEventListener('mouseup', s.onUp, { capture: true });
  const second = (t) => { const after = s.frames.filter((f) => f > t); return after.length > 1 ? Math.round(after[1] - t) : null; };
  const near = (t) => ([st, d]) => st + d > t && st < t + 500;
  const long = s.long.filter((e) => near(s.firstMove)(e) || near(s.up)(e));
  return { firstFrame: second(s.firstMove), releaseFrame: second(s.up), long: long.map(([, d]) => Math.round(d)) }; })()`;

// One pan: rest, press, 30 moves 16 ms apart, release. -> {firstFrame, long, moved}
async function pan(spot, { button = 'middle', space = false } = {}) {
  await mouse('mouseMoved', spot);
  if (space) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
  await sleep(1000);
  const before = await js(`${V}.view().tx`);
  await js(SETUP);
  await mouse('mousePressed', spot, button);
  for (let i = 1; i <= 30; i++) { await mouse('mouseMoved', { x: spot.x - i * 6, y: spot.y - i * 3 }, button); await sleep(16); }
  await mouse('mouseReleased', { x: spot.x - 180, y: spot.y - 90 }, button);
  await sleep(300);
  if (space) await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  const r = await js(COLLECT);
  r.moved = Math.round(before - (await js(`${V}.view().tx`)));
  await js(`${V}.setView({ s: 1, tx: 0, ty: 0 })`);
  return r;
}

try {
  await openFile(t, 'big.pyflow');
  await until(`${V}?.host.dataset.nodes === '300'`, '300 nodes', 30000);
  await js(`${V}.setView({ s: 1, tx: 0, ty: 0 })`);
  await js(`document.querySelector('.vs-host:not(.hidden) .vs-canvas').focus()`);
  const spot = await js(`(() => { const r = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push({ how: 'middle', ...(await pan(spot)) });
  for (let i = 0; i < 2; i++) runs.push({ how: 'right', ...(await pan(spot, { button: 'right' })) });
  for (let i = 0; i < 2; i++) runs.push({ how: 'space', ...(await pan(spot, { button: 'left', space: true })) });
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < 6; k++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY: -120 }); await sleep(40); }
    await sleep(800);
    runs.push({ how: 'after zoom', ...(await pan(spot)) });
  }
  console.log(`PAN ${JSON.stringify(runs)}`);
  const sorted = (k) => runs.map((r) => r[k]).sort((a, b) => a - b);
  const median = (xs) => xs[Math.floor((xs.length - 1) / 2)];
  const first = sorted('firstFrame');
  const release = sorted('releaseFrame');
  const worstLong = Math.max(0, ...runs.flatMap((r) => r.long));
  check(runs.every((r) => r.moved >= 150), `every gesture panned the view (${runs.map((r) => r.moved).join(', ')} px)`);
  check(median(first) < BUDGET.medianMs && first.at(-1) < BUDGET.worstMs, `first frame of a pan: ${median(first)} ms median (< ${BUDGET.medianMs}), ${first.at(-1)} ms worst (< ${BUDGET.worstMs}) over ${runs.length} gestures`);
  check(median(release) < BUDGET.medianMs && release.at(-1) < BUDGET.worstMs, `frame after the button is released: ${median(release)} ms median, ${release.at(-1)} ms worst`);
  check(worstLong < BUDGET.longTaskMs, `no long task when a pan starts or ends (longest ${worstLong} ms, < ${BUDGET.longTaskMs})`);
} catch (err) {
  check(false, err.message);
}
t.finish();
