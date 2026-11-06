// Nano Studio Cut's History, Audio Meters and Markers panels and the keyframe interpolation menus in the real app
// (features §7, §12, §14, §17 [2]). Every check clicks, drags or presses keys with real input events
// (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and reads what the project, the panel or the canvas then shows:
// - the panels sit in the workspaces' tab slots; the top bar's Window menu adds one the workspace lacks to its dock
//   slot, and the tab's close mark takes it out again;
// - History: every step with its label under the start, the current point marked and later steps dimmed; a click
//   undoes or redoes to it in one go; it follows a key edit at once; 1,500 steps keep few rows in the DOM and answer
//   quickly;
// - Markers: sequence and clip markers with time, length, name, type and colour; type, colour and search filters; a
//   click moves the playhead, a double click opens the dialog (renaming is one step), Delete removes one; on the ruler
//   a marker drags on frames (and snaps to a clip end), a range marker's end drags its length, and the right-click
//   menu changes its colour and opens the dialog;
// - keyframe menus: Hold and Bezier in the effect controls lane and on the timeline's keyframe line; a hold segment
//   drawn as a step (canvas pixels); a bezier segment's handle dragged in one undo step changes the values;
// - Audio Meters: the peak and RMS of a 1080p30 test source's beeps (-6 dBFS) while playing, from the canvas pixels;
//   the peak hold after stopping and its fall; the clip lights at +6 dB and a click resets them; dropped frames
//   while playing with the meters shown and without them (NOTE line);
// - screenshots in the dark and the light theme (verify/out/cut-panels/*.png).
// Usage: node verify/cut-panels.mjs   (CUT_PANELS_ONLY=window,history,markers,easing,meters,shots)
import path from 'path';
import { launch, tempDir, menuRow, clickMenuPath } from './lib.mjs';

const ONLY = (process.env.CUT_PANELS_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-panels-home');
const ctx = await launch({ fixture: 'core', port: 9762, name: 'cut-panels', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, type, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const F = T / 30;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'keyframes', 'testsrc', 'audioengine', 'player'].every((k) => !!Cut[k]) && ['history', 'meters', 'markers'].every((p) => Cut.ui.panels.has(p)) && !!Cut.ui.markers?.edit && typeof Cut.app.history.goTo === 'function'`),
  'the modules and panels this suite uses are loaded');

// ---------- page helpers ----------
await js(`(() => {
  const T = Cut.time.TICKS;
  const H = (window.__pn = {});
  H.seq = () => Cut.app.sequence;
  H.media = (id) => ({ path: 'C:\\\\nowhere\\\\' + id + '.mp4', name: id + '.mp4', kind: 'video', size: 1000, mtime: 1, duration: 120 * T,
    video: { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 }, audio: { rate: 48000, channels: 2 } });
  // A fresh 1080p30 project with no undo steps: clips [{at, len, video, audio}] (seconds), markers (seconds),
  // keyframes {clip index: {path: [[sec, v, ease]]}}, track heights.
  H.fresh = async (spec = {}) => {
    const C = Cut.commands;
    const p = Cut.model.createProject({ sequence: { fps: [30, 1] } });
    const h = C.createHistory(p, { limit: Infinity });
    Cut.app.setHistory(h, null, 'open');
    const seq = Cut.app.sequence;
    const ids = h.do(C.importMedia(spec.media || [H.media('a')])).ids;
    const clips = [];
    for (const c of spec.clips || []) clips.push(...h.do(C.place(seq.id, { source: { media: ids[c.media ?? 0] }, in: 0, out: c.len * T, at: c.at * T, video: c.video ?? 'V1', audio: c.audio === undefined ? null : c.audio })).ids);
    for (const m of spec.markers || []) h.do(C.addMarker(seq.id, { ...m, t: m.t * T, duration: (m.duration || 0) * T }, m.clip != null ? { clipId: clips[m.clip] } : {}));
    for (const [i, byPath] of Object.entries(spec.keyframes || {})) for (const [path, list] of Object.entries(byPath)) h.do(C.setKeyframes(seq.id, clips[i], path, list.map(([s, v, ease]) => ({ t: s * T, v, ease: ease || 'linear' }))));
    for (const [id, height] of Object.entries(spec.heights || {})) h.do(C.setTrack(seq.id, id, { height }));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project)), { limit: spec.limit ?? 1000 }), null, 'open');
    Cut.ui.setSnapping(Cut.app, true);
    Cut.app.setTool('select');
    Cut.app.setInOut({ in: null, out: null });
    Cut.app.setTime(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tl = Cut.ui.timeline;
    tl.setZoom(100, { t: 0, x: 0 });
    tl.setScroll(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { clips: Cut.app.sequence.clips.map((c) => c.id) };
  };
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left }; };
  H.steps = () => Cut.app.history.position;
  H.label = () => Cut.app.history.list()[Cut.app.history.position - 1]?.label;
  H.visible = (sel) => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); if (!r.width || !r.height) return false; const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && n.contains(hit); };
  // the ruler point of a sequence time (y in the marker flags' band)
  H.ruler = (sec, dy = 17) => { const r = Cut.ui.timeline.root.querySelector('.cut-tl-ruler').getBoundingClientRect(); return { x: r.left + Cut.ui.timeline.xOf(sec * T), y: r.top + dy }; };
  H.marker = (name) => { const m = H.seq().markers.find((x) => x.name === name); return m ? { id: m.id, t: m.t / T, frames: m.t / (T / 30), duration: m.duration / T, color: m.color, kind: m.kind } : null; };
  // a canvas pixel at a client point: [r, g, b, a]
  H.pixel = (canvas, x, y) => { const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width; return [...canvas.getContext('2d').getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data]; };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { button = 'left', clickCount = 1 } = {}) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y, { button, buttons: button === 'right' ? 2 : 1, clickCount });
  await mouse('mouseReleased', p.x, p.y, { button, buttons: 0, clickCount });
  await sleep(90);
}
async function doubleClickAt(p) {
  await clickAt(p);
  await clickAt(p, { clickCount: 2 });
}
async function drag(a, b, { steps = 10, pause = 20, hold = null } = {}) {
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await sleep(pause);
  }
  await sleep(80);
  const held = hold ? await hold() : null;
  await mouse('mouseReleased', b.x, b.y);
  await sleep(150);
  return held;
}
const rect = (sel) => js(`__pn.rect(${S(sel)})`);
const steps = () => js('__pn.steps()');
const label = () => js('__pn.label()');
const fresh = (spec) => js(`__pn.fresh(${S(spec)})`);
const frames = () => new Promise((r) => setTimeout(r, 120));
async function showTab(panel) {
  const r = await rect(`.cut-grid .cut-slot-tab[data-panel="${panel}"]`);
  if (!r) return false;
  await clickAt(r);
  await sleep(120);
  return true;
}
async function workspace(id) {
  await clickAt(await rect(`.cut-ws-tab[data-ws="${id}"]`));
  await sleep(200);
}
async function focusTimeline() {
  for (let i = 0; i < 2; i++) {
    const p = await js(`(() => {
      const tl = Cut.ui.timeline, box = tl.root.querySelector('.cut-tl-scroll').getBoundingClientRect(), r = tl.rowOf('V2');
      const y = r.y + r.h / 2;
      for (let x = box.width - 40; x > 20; x -= 15) if (!tl.hit(x, y).clip && !tl.hit(x, y).transition) return { x: box.left + x, y: box.top + y };
      return { x: box.left + box.width - 40, y: box.top + y };
    })()`);
    await clickAt(p);
    if ((await js('Cut.app.focusPanel')) === 'timeline') return;
  }
  log(`  (the timeline did not take the keyboard: focus ${await js('Cut.app.focusPanel')})`);
}
async function menuClick(label, level = 0) {
  await until(`!!${menuRow(label, level)}`, `menu item ${label}`, 3000);
  const p = await js(`(() => { const r = ${menuRow(label, level)}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await clickAt(p);
}
// Space as the keyboard sends it (lib.mjs press() gives no code for it)
async function space() {
  const base = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await press('Escape');
  await js(`(document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()), ide.ui.closeMenus(), true)`);
}

// ---------- the panels in the workspaces and the Window menu ----------
await section('window', async () => {
  await workspace('editing');
  const tabs = await js(`['history', 'markers', 'meters'].map((p) => !!document.querySelector('.cut-grid .cut-slot-tab[data-panel="' + p + '"]'))`);
  check(tabs.every(Boolean), `the Editing workspace has History, Markers and Audio Meters tabs (${S(tabs)})`);
  check(await js(`__pn.visible('.cut-panel[data-panel="meters"] .cut-meters-canvas')`), 'the audio meters are on screen beside the program monitor');
  check(await js(`!!document.querySelector('.cut-topbar .cut-window-btn')`), 'the top bar has a Window menu');
  await workspace('color');
  check(!(await js(`!!document.querySelector('.cut-grid .cut-slot-tab[data-panel="markers"]')`)), 'the Color workspace has no Markers tab of its own');
  await clickAt(await rect('.cut-topbar .cut-window-btn'));
  const rows = await js(`[...document.querySelectorAll('.context-menu[data-level="0"] > .menu-item')].map((r) => (r.querySelector('.menu-icon').textContent === '✓' ? '+' : '') + r.querySelector('.menu-label').textContent)`);
  check(['Markers', '+History', 'Audio Meters', 'Source', '+Program', '+Timeline'].every((x) => rows.includes(x)), `the Window menu lists every panel, ticking those on screen (${S(rows)})`);
  await menuClick('Markers');
  await sleep(200);
  const shown = await js(`({ tab: !!document.querySelector('.cut-grid .cut-slot-tab.added[data-panel="markers"]'), visible: __pn.visible('.cut-panel[data-panel="markers"] .cut-markers-head'), focus: Cut.app.focusPanel, ws: Cut.ui.workspace })`);
  check(shown.tab && shown.visible && shown.focus === 'markers' && shown.ws === 'color', `Window > Markers adds the panel to the Color workspace's dock slot and gives it the keyboard (${S(shown)})`);
  await workspace('editing');
  await workspace('color');
  check(await js(`!!document.querySelector('.cut-grid .cut-slot-tab.added[data-panel="markers"]')`), 'the added tab is still there when the workspace comes back');
  await clickAt(await rect('.cut-grid .cut-slot-tab[data-panel="markers"] .cut-slot-tab-close'));
  await sleep(150);
  check(!(await js(`!!document.querySelector('.cut-grid .cut-slot-tab[data-panel="markers"]')`)), 'its close mark takes it out of the workspace again');
  check(await js(`ide.actions.some((a) => a.id === 'Cut.window.history') && ide.actions.some((a) => a.id === 'Cut.window.meters')`), 'Find Action has Window: History and Window: Audio Meters');
  await workspace('editing');
});

// ---------- History ----------
await section('history', async () => {
  const { clips } = await fresh({ clips: [{ at: 0, len: 10 }], heights: { V1: 60 } });
  await showTab('history');
  check(await js(`[...document.querySelectorAll('.cut-history-row')].map((r) => r.textContent).join('|') === 'Start' && document.querySelector('.cut-history-row.current')?.textContent === 'Start'`), 'a new project shows only the start, marked as the current point');
  // four edits: opacity 80, 60, 40, a name; then one by a real key (M adds a marker)
  await js(`(() => { const C = Cut.commands, s = __pn.seq().id, c = ${S(clips[0])}; for (const o of [80, 60, 40]) Cut.app.history.do(C.setClip(s, c, { props: { opacity: o } })); Cut.app.history.do(C.setClip(s, c, { name: 'named' })); return true; })()`);
  await focusTimeline();
  await js(`(Cut.app.setTime(2 * ${T}), true)`);
  await press('m');
  await frames();
  const labels = await js(`[...document.querySelectorAll('.cut-history-row')].map((r) => r.textContent)`);
  check(S(labels) === S(['Start', 'Clip Settings', 'Clip Settings', 'Clip Settings', 'Clip Settings', 'Add Marker']), `each step is listed with its label, the key edit at once (${S(labels)})`);
  check(await js(`document.querySelector('.cut-history-row.current')?.dataset.index === '5'`), 'the last step is the current point');
  await showTab('history');
  const r2 = await js(`(() => { const r = Cut.ui.history.rowRect(2); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  await clickAt(r2);
  const after = await js(`({ pos: Cut.app.history.position, opacity: __pn.seq().clips[0].props.opacity, markers: __pn.seq().markers.length, undone: [...document.querySelectorAll('.cut-history-row.undone')].map((r) => +r.dataset.index), current: document.querySelector('.cut-history-row.current')?.dataset.index })`);
  check(after.pos === 2 && after.opacity === 60 && after.markers === 0 && S(after.undone) === S([3, 4, 5]) && after.current === '2', `a click on the second step undoes the three after it in one go (${S(after)})`);
  const dim = await js(`(() => { const c = (i) => getComputedStyle(document.querySelector('.cut-history-row[data-index="' + i + '"] .cut-history-label')).color; return { done: c(1), undone: c(4) }; })()`);
  check(dim.done !== dim.undone, `the steps after the current point are drawn dimmed (${S(dim)})`);
  check(await js(`Cut.app.history.canRedo && !document.querySelector('.cut-topbar .cut-redo').disabled`), 'Redo is available after the jump');
  await clickAt(await js(`(() => { const r = Cut.ui.history.rowRect(0); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`));
  check(await js(`Cut.app.history.position === 0 && __pn.seq().clips[0].props.opacity === 100`), 'a click on the start undoes everything');
  await clickAt(await js(`(() => { const r = Cut.ui.history.rowRect(5); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`));
  check(await js(`Cut.app.history.position === 5 && __pn.seq().clips[0].props.opacity === 40 && __pn.seq().markers.length === 1`), 'a click on the last step redoes them all');
  await press('ArrowUp');
  check(await js(`Cut.app.history.position === 4 && __pn.seq().markers.length === 0`), 'Up in the list steps back one');
  await press('Ctrl+z');
  await frames();
  check(await js(`Cut.app.history.position === 3 && document.querySelector('.cut-history-row.current')?.dataset.index === '3'`), 'Ctrl+Z moves the current point in the list');
  await js(`(Cut.app.history.do(Cut.commands.setClip(__pn.seq().id, ${S(clips[0])}, { name: 'other' })), true)`);
  await frames();
  check(await js(`document.querySelectorAll('.cut-history-row').length === 5 && !document.querySelector('.cut-history-row.undone')`), 'an edit after going back drops the later steps from the list');
  // a drag is one step: the list shows it once it is committed
  await js(`(() => { const h = Cut.app.history; h.begin('Opacity'); for (const o of [10, 20, 30]) h.do(Cut.commands.setClip(__pn.seq().id, ${S(clips[0])}, { props: { opacity: o } })); h.commit(); return true; })()`);
  await frames();
  check(await js(`[...document.querySelectorAll('.cut-history-row')].at(-1)?.textContent === 'Opacity' && document.querySelectorAll('.cut-history-row').length === 6`), 'a committed drag appears as one step');

  // 1,500 steps
  await fresh({ clips: [{ at: 0, len: 10 }], limit: 5000 });
  const long = await js(`(async () => {
    const C = Cut.commands, s = __pn.seq().id, c = __pn.seq().clips[0].id, h = Cut.app.history;
    const t0 = performance.now();
    for (let i = 0; i < 1500; i++) h.do(C.setClip(s, c, { props: { opacity: i % 100 } }));
    const doMs = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t1 = performance.now();
    h.do(C.setClip(s, c, { name: 'one more' }));
    await new Promise((r) => requestAnimationFrame(r));
    const oneMs = performance.now() - t1;
    return { doMs, oneMs, rows: Cut.ui.history.rows, dom: document.querySelectorAll('.cut-history-row').length, last: document.querySelector('.cut-history-row.current')?.dataset.index };
  })()`);
  check(long.rows === 1502 && long.dom < 80 && long.last === '1501', `1,501 steps keep ${long.dom} rows in the DOM with the last one current and in view (${S(long)})`);
  check(long.oneMs < 100, `the list follows an edit within ${long.oneMs.toFixed(1)} ms of 1,501 steps`);
  const r700 = await js(`(() => { const r = Cut.ui.history.rowRect(700); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  const t0 = Date.now();
  await clickAt(r700);
  const jump = await js(`({ pos: Cut.app.history.position, opacity: __pn.seq().clips[0].props.opacity })`);
  check(jump.pos === 700 && jump.opacity === 699 % 100, `a click 800 steps back undoes them in one go (${S(jump)}, ${Date.now() - t0} ms with the click)`);
});

// ---------- Markers ----------
await section('markers', async () => {
  const beats = Array.from({ length: 40 }, (_, i) => ({ t: 12 + i * 0.5, kind: 'beat', color: 'cyan' }));
  await fresh({
    clips: [{ at: 0, len: 6 }, { at: 8, len: 3 }],
    markers: [{ t: 2, name: 'Intro', kind: 'comment', color: 'red', note: 'the opening words' }, { t: 4.5, name: 'Part 2', kind: 'chapter', color: 'green', duration: 1 }, ...beats, { t: 9, name: 'Clip note', color: 'yellow', clip: 1 }],
  });
  await showTab('markers');
  await sleep(100);
  const items = await js(`Cut.ui.markers.panel.items`);
  const clipItem = items.find((x) => x.clip);
  check(items.length === 43 && items[0].name === 'Intro' && clipItem?.t === 9 * T, `the panel lists the sequence and clip markers in time order (${items.length}, clip marker at ${clipItem?.t / T} s)`);
  const row0 = await js(`[...document.querySelectorAll('.cut-mk-row')][0] && [...document.querySelectorAll('.cut-mk-row')][0].innerText.replace(/\\s+/g, ' ')`);
  check(/Intro/.test(row0) && /00:00:02:00/.test(row0) && /Comment/.test(row0), `a row shows the time, the name and the type (${row0})`);
  const sw = await js(`getComputedStyle(document.querySelector('.cut-mk-row[data-id="' + Cut.ui.markers.panel.items[0].id + '"] .cut-mk-swatch')).backgroundColor`);
  check(sw === 'rgb(224, 85, 85)', `the swatch has the marker's colour (${sw})`);
  // search: real typing
  await clickAt(await rect('.cut-markers-search'));
  await type('part');
  await frames();
  const found = await js(`Cut.ui.markers.panel.items.map((x) => x.name).join()`);
  check(found === 'Part 2', `the search finds names (${found})`);
  await press('Ctrl+a');
  await type('opening');
  await frames();
  check(await js(`Cut.ui.markers.panel.items.map((x) => x.name).join() === 'Intro'`), 'the search finds comments');
  await press('Ctrl+a');
  await press('Backspace');
  await frames();
  // the type and colour filters (native selects: the value is chosen as the select's own popup would)
  const pick = (cls, v) => js(`(() => { const s = document.querySelector('.cut-markers .${cls}'); s.value = ${S(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await pick('cut-markers-kind', 'beat');
  await frames();
  check(await js(`Cut.ui.markers.panel.items.length === 40 && /40 of 43/.test(document.querySelector('.cut-markers .cut-panel-foot').textContent)`), 'the type filter keeps the beat markers and says how many of all');
  await pick('cut-markers-kind', '');
  await pick('cut-markers-color', 'red');
  await frames();
  check(await js(`Cut.ui.markers.panel.items.map((x) => x.name).join() === 'Intro'`), 'the colour filter');
  await pick('cut-markers-color', '');
  await frames();
  // click: the playhead
  const id2 = await js(`__pn.marker('Part 2').id`);
  await clickAt(await js(`(() => { const r = Cut.ui.markers.panel.rowRect(${S(id2)}); return { x: r.x + 120, y: r.y + r.height / 2 }; })()`));
  check(await js(`Cut.app.t === 4.5 * ${T} && Cut.ui.markers.panel.selected === ${S(id2)}`), `a click puts the playhead on the marker (${await js(`Cut.app.t / ${T}`)} s)`);
  // double click: the dialog, renaming is one step
  const id1 = await js(`__pn.marker('Intro').id`);
  const n0 = await steps();
  await doubleClickAt(await js(`(() => { const r = Cut.ui.markers.panel.rowRect(${S(id1)}); return { x: r.x + 120, y: r.y + r.height / 2 }; })()`));
  await until(`!!document.querySelector('#cutMarkerDialog')`, 'the marker dialog', 3000).catch(() => {});
  check(await js(`!!document.querySelector('#cutMarkerDialog') && document.activeElement?.classList.contains('cut-marker-name')`), 'a double click opens the marker dialog with the name to type');
  await type('Opening');
  await clickAt(await rect('#cutMarkerDialog .dialog-buttons button.primary'));
  await frames();
  check(await js(`__pn.marker('Opening')?.id === ${S(id1)}`) && (await steps()) === n0 + 1 && (await label()) === 'Edit Marker', `OK renames it in one step (${await label()})`);
  // the dialog's time field moves it
  await doubleClickAt(await js(`(() => { const r = Cut.ui.markers.panel.rowRect(${S(id1)}); return { x: r.x + 120, y: r.y + r.height / 2 }; })()`));
  await until(`!!document.querySelector('#cutMarkerDialog')`, 'the marker dialog', 3000).catch(() => {});
  await clickAt(await rect('#cutMarkerDialog .cut-marker-time'));
  await press('Ctrl+a');
  await type('00:00:03:15');
  await press('Enter');
  await frames();
  check(await js(`__pn.marker('Opening')?.frames === 105`) && !(await js(`!!document.querySelector('#cutMarkerDialog')`)), `a time typed in the dialog and Enter move the marker (${S(await js(`__pn.marker('Opening')`))})`);
  // Delete
  const n1 = await steps();
  await clickAt(await js(`(() => { const r = Cut.ui.markers.panel.rowRect(${S(id1)}); return { x: r.x + 120, y: r.y + r.height / 2 }; })()`));
  await press('Delete');
  await frames();
  check(!(await js(`__pn.marker('Opening')`)) && (await steps()) === n1 + 1 && (await js('Cut.ui.markers.panel.items.length')) === 42, 'Delete removes the selected marker in one step');
  await press('Ctrl+z');
  await frames();
  check(await js(`!!__pn.marker('Opening') && Cut.ui.markers.panel.items.length === 43`), 'Ctrl+Z brings it back into the list');

  // ---- on the ruler ----
  await js(`(Cut.ui.setSnapping(Cut.app, false), Cut.ui.timeline.setZoom(100, { t: 0, x: 0 }), Cut.ui.timeline.setScroll(0, 0), true)`);
  await sleep(100);
  const n2 = await steps();
  const a = await js(`__pn.ruler(3.5)`);
  const held = await drag(a, { x: a.x + 87, y: a.y }, {
    hold: () => js(`(() => { const c = Cut.ui.timeline.root.querySelector('.cut-tl-ruler canvas'); const p = __pn.ruler(3.5 + 0.87); return { at: __pn.pixel(c, p.x, p.y), old: __pn.pixel(c, ${a.x}, ${a.y}) }; })()`),
  });
  const moved = await js(`__pn.marker('Opening')`);
  check(moved.frames === 131 && (await steps()) === n2 + 1 && (await label()) === 'Edit Marker', `dragging a flag 0.87 s moves the marker to frame 131 (on a frame) in one step (${S(moved)})`);
  check(held && held.at[0] > 180 && held.at[1] < 120 && !(held.old[0] > 180 && held.old[1] < 120), `while dragging, the flag is drawn where it lands (${S(held)})`);
  // snapping: Part 2 (4.5 s) dragged near the first clip's end (6 s) lands on it
  await js(`(Cut.ui.setSnapping(Cut.app, true), true)`);
  const b = await js(`__pn.ruler(4.5)`);
  await drag(b, { x: b.x + 146, y: b.y });
  check(await js(`__pn.marker('Part 2').t === 6`), `with snapping on, a marker dropped 4 px from a clip end lands on it (${await js(`__pn.marker('Part 2').t`)} s)`);
  await js(`(Cut.ui.setSnapping(Cut.app, false), true)`);
  // the end of a range marker (Part 2: 6 s for 1 s) drags its length
  const e = await js(`__pn.ruler(7)`);
  await drag(e, { x: e.x + 50, y: e.y });
  check(await js(`__pn.marker('Part 2').duration === 1.5 && __pn.marker('Part 2').t === 6`), `dragging a range marker's end changes its length (${S(await js(`__pn.marker('Part 2')`))})`);
  check(await js(`Cut.ui.markers.panel.items.find((x) => x.name === 'Part 2').duration === 1.5 * ${T} && /00:00:01:15/.test(document.querySelector('.cut-mk-row[data-id="${id2}"]')?.innerText || '')`), 'the panel shows the new length');
  // right-click: colour and the dialog
  await clickAt(await js(`__pn.ruler(6)`), { button: 'right' });
  await clickMenuPath(ctx, ['Color', 'Blue']);
  await frames();
  check(await js(`__pn.marker('Part 2').color === 'blue'`), `the ruler's right-click menu changes the colour (${await js(`__pn.marker('Part 2').color`)})`);
  await clickAt(await js(`__pn.ruler(6)`), { button: 'right' });
  await menuClick('Edit Marker…');
  await until(`!!document.querySelector('#cutMarkerDialog')`, 'the marker dialog', 3000).catch(() => {});
  check(await js(`document.querySelector('#cutMarkerDialog .cut-marker-name')?.value === 'Part 2' && document.querySelector('#cutMarkerDialog .cut-marker-color')?.value === 'blue'`), 'Edit Marker… opens the dialog of that marker');
  await press('Escape');
  await js(`(Cut.ui.setSnapping(Cut.app, true), true)`);
});

// ---------- keyframe interpolation ----------
await section('easing', async () => {
  const { clips } = await fresh({ clips: [{ at: 0, len: 10 }], heights: { V1: 64 }, keyframes: { 0: { opacity: [[0, 0], [3, 100], [6, 50]] } } });
  await js(`(Cut.app.select([${S(clips[0])}]), true)`);
  await showTab('controls');
  await until(`!!Cut.ui.controls.lanePoint('opacity', 0)`, 'the opacity lane', 5000);
  const kf = (i) => js(`__pn.seq().clips[0].keyframes.opacity[${i}]`);
  const val = (sec) => js(`Cut.keyframes.propValue(__pn.seq().clips[0], 'opacity', ${sec} * ${T}, 0)`);
  // Hold from the lane's menu
  const n0 = await steps();
  await clickAt(await js(`Cut.ui.controls.lanePoint('opacity', 3 * ${T})`), { button: 'right' });
  const items = await js(`[...document.querySelectorAll('.context-menu[data-level="0"] > .menu-item .menu-label')].map((n) => n.textContent)`);
  check(['Linear', 'Ease In', 'Ease Out', 'Ease In and Out', 'Bezier', 'Hold'].every((x) => items.includes(x)), `the lane's keyframe menu offers Bezier and Hold (${S(items)})`);
  await menuClick('Hold');
  await frames();
  check((await kf(1)).ease === 'hold' && (await val(5)) === 100 && (await steps()) === n0 + 1, `Hold keeps 100 until the next keyframe (${await val(5)} at 5 s)`);
  // the hold segment (100 -> 50, falling) is a step: along the top of the lane, then down at the next keyframe
  const px = await js(`(() => {
    const c = document.querySelector('.cut-ec-row[data-path="opacity"] .cut-ec-lanecanvas'), r = c.getBoundingClientRect();
    const a = Cut.ui.controls.lanePoint('opacity', 3 * ${T}), b = Cut.ui.controls.lanePoint('opacity', 6 * ${T});
    const x = (a.x + b.x) / 2;
    return { top: __pn.pixel(c, x, r.top + 4)[3], bottom: __pn.pixel(c, x, r.bottom - 4)[3], drop: __pn.pixel(c, b.x, r.top + r.height * 0.3)[3] };
  })()`);
  check(px.top > 100 && px.bottom < 40 && px.drop > 100, `the lane draws the hold as a step (alpha top ${px.top}, bottom ${px.bottom}, the drop ${px.drop})`);
  // Bezier on the first keyframe keeps the values, then its handle reshapes the segment
  await clickAt(await js(`Cut.ui.controls.lanePoint('opacity', 0)`), { button: 'right' });
  await menuClick('Bezier');
  await frames();
  const k0 = await kf(0);
  check(k0.ease === 'bezier' && Math.abs((await val(1.5)) - 50) < 0.5, `Bezier from linear keeps the value (${S(k0)}, ${(await val(1.5)).toFixed(2)} at 1.5 s)`);
  const h1 = await js(`Cut.ui.controls.lanePoint('opacity', 0, 0)`);
  const end = await js(`Cut.ui.controls.lanePoint('opacity', 3 * ${T})`);
  check(h1?.shown, `the bezier segment shows its handles (${S(h1)})`);
  const n1 = await steps();
  const start = await js(`Cut.ui.controls.lanePoint('opacity', 0)`);
  const laneBottom = await js(`document.querySelector('.cut-ec-row[data-path="opacity"] .cut-ec-lane').getBoundingClientRect().bottom - 4`);
  await drag(h1, { x: start.x + (end.x - start.x) * 0.8, y: laneBottom });
  const k0b = await kf(0);
  check(k0b.ease === 'bezier' && k0b.h[0] > 0.7 && k0b.h[0] < 0.9 && Math.abs(k0b.h[1]) < 0.15, `dragging the handle sets it (${S(k0b.h)})`);
  check((await steps()) === n1 + 1 && (await label()) === 'Keyframes' && (await val(1.5)) < 40, `the drag is one undo step and the motion starts slower (${(await val(1.5)).toFixed(1)} at 1.5 s)`);
  await press('Ctrl+z');
  check(Math.abs((await kf(0)).h[0] - 1 / 3) < 0.01, 'Ctrl+Z gives the handle back');
  // the timeline's keyframe line
  const p = await js(`(() => {
    const tl = Cut.ui.timeline, box = tl.root.querySelector('.cut-tl-scroll').getBoundingClientRect(), r = tl.rowOf('V1'), x = tl.xOf(6 * ${T});
    for (let y = r.y; y < r.y + r.h; y++) if (tl.hit(x, y).part === 'kf') return { x: box.left + x, y: box.top + y + 1 };
    return null;
  })()`);
  check(!!p, "the timeline shows the keyframe on the clip's opacity line");
  if (p) {
    await clickAt(p, { button: 'right' });
    const items2 = await js(`[...document.querySelectorAll('.context-menu[data-level="0"] > .menu-item .menu-label')].map((n) => n.textContent)`);
    check(items2.includes('Bezier') && items2.includes('Hold') && items2.includes('Delete Keyframe'), `the keyframe line's menu offers the interpolations (${S(items2)})`);
    await menuClick('Ease In');
    await frames();
    check((await kf(2)).ease === 'easeIn', `the timeline menu sets the keyframe's interpolation (${(await kf(2)).ease})`);
  }
});

// ---------- Audio Meters ----------
await section('meters', async () => {
  const mp4 = path.join(home, 'beeps-1080p30.mp4');
  const made = await js(`(async () => { const r = await Cut.testsrc.write(${S(mp4)}, { seconds: 12, fps: [30, 1], w: 1920, h: 1080, beepEvery: 1, beepLength: 0.3 }); return r.ok ? 'ok' : JSON.stringify(r.error); })()`);
  check(made === 'ok', `a 12 s 1080p30 test source with beeps is written (${made})`);
  await fresh({ media: [await js(`__pn.media('x')`)] });
  const ids = await js(`Cut.ui.media.importPaths(Cut.app, ${S([mp4])})`);
  const placed = await js(`(() => { const r = Cut.app.history.do(Cut.commands.place(__pn.seq().id, { source: { media: ${S(ids[0])} }, at: 0, video: 'V1', audio: 'A1', mode: 'overwrite' })); return r.ids; })()`);
  check(placed?.length === 2, 'the source is on V1 and A1');
  await workspace('editing');
  await js(`(Cut.ui.meters.reset(), Cut.app.setTime(0), true)`);
  await focusTimeline();
  const play = async (seconds, sample) => {
    await space();
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) { if (sample) out.push(await sample()); await sleep(sample ? 60 : 250); }
    await space();
    return out;
  };
  check(await js('Cut.app.playing === false'), 'stopped before playing');
  const samples = await play(4, () => js(`(() => { const g = Cut.ui.meters.geometry(), c = Cut.ui.meters.canvas, st = Cut.ui.meters.state; const x = (g.bars[0].x0 + g.bars[0].x1) / 2;
    return { playing: Cut.app.playing, peak: st.peak[0], rms: st.rms[0], lit: __pn.pixel(c, x, g.y(-20)), dark: __pn.pixel(c, x, g.y(-1) - 2), running: Cut.ui.meters.running }; })()`));
  const playing = samples.filter((s) => s.playing);
  const peaks = playing.map((s) => s.peak).filter((v) => v != null);
  const maxPeak = Math.max(...peaks);
  const withRms = playing.filter((s) => s.rms != null && s.peak != null);
  check(playing.length > 20 && Math.abs(maxPeak + 6.02) < 1.5, `while playing the peak reaches the beeps' -6 dBFS (${maxPeak.toFixed(2)} dB over ${playing.length} samples)`);
  check(withRms.length > 0 && withRms.every((s) => s.rms <= s.peak + 0.01) && Math.max(...withRms.map((s) => s.rms)) > -12, `the RMS bar is under the peak (RMS max ${Math.max(...withRms.map((s) => s.rms)).toFixed(1)} dB)`);
  const lit = playing.filter((s) => s.peak > -20 && s.lit[3] > 200 && s.lit[1] > 120);
  check(lit.length > 0 && playing.some((s) => s.running), `the bar is lit at -20 dB on the canvas during a beep (${lit.length} samples)`);
  check(playing.every((s) => !(s.dark[0] > 200 && s.dark[1] < 100)), 'the bar stays below -1 dB');
  // the peak hold after stopping, then its fall
  const hold = await js(`(() => { const st = Cut.ui.meters.state, g = Cut.ui.meters.geometry(), c = Cut.ui.meters.canvas; const x = (g.bars[0].x0 + g.bars[0].x1) / 2; const y = g.y(st.hold[0]);
    return { hold: st.hold[0], line: __pn.pixel(c, x, y), clip: st.clip }; })()`);
  check(hold.hold != null && hold.hold > -10 && hold.hold <= -5.5 && hold.line[0] > 200 && hold.line[1] > 200, `after stopping the peak hold line stays near the last peak (${hold.hold?.toFixed(1)} dB, it falls 1.5 s after the beep; ${S(hold.line)})`);
  check(!hold.clip[0] && !(await js(`!!document.querySelector('.cut-meter-clip.on')`)), 'no clip light at -6 dBFS');
  await sleep(3500);
  const fallen = await js(`({ hold: Cut.ui.meters.state.hold[0], running: Cut.ui.meters.running })`);
  check(fallen.hold === null && !fallen.running, `the hold falls away and the meters stop drawing (${S(fallen)})`);
  // +12 dB: the beeps reach +6 dBFS and the clip lights come on until clicked
  await js(`(Cut.app.history.do(Cut.commands.setClip(__pn.seq().id, ${S(placed[1])}, { props: { volume: 12 } })), Cut.app.setTime(0), true)`);
  await focusTimeline();
  await play(2.5);
  const lights = await js(`({ on: document.querySelectorAll('.cut-meter-clip.on').length, color: getComputedStyle(document.querySelector('.cut-meter-clip')).backgroundColor, st: Cut.ui.meters.state.clip })`);
  check(lights.on === 2 && /rgb\(224, 85, 85\)/.test(lights.color), `a level of +6 dBFS lights the clip indicators (${S(lights)})`);
  await clickAt(await rect('.cut-meter-clip'));
  check(await js(`!document.querySelector('.cut-meter-clip.on') && Cut.ui.meters.state.clip.every((x) => !x)`), 'a click on an indicator resets them');
  await press('Ctrl+z');

  // dropped frames while playing 8 s, with the meters and without them
  const run = async () => {
    await js(`(Cut.app.setTime(0), true)`);
    await focusTimeline();
    await space();
    await sleep(8000);
    const st = await js(`(() => { const s = Cut.ui.monitors.program.player.stats(); return { dropped: s.dropped, fps: s.fps, meters: Cut.ui.meters.running }; })()`);
    await space();
    await sleep(500);
    return st;
  };
  const withMeters = await run();
  await js(`(Cut.ui.mountedPanel('meters').remove(), true)`);
  const without = await run();
  await js(`(Cut.ui.setWorkspace('editing'), true)`);
  console.log(`NOTE dropped frames playing the 1080p30 source for 8 s: with the meters ${withMeters.dropped} (${withMeters.fps.toFixed(1)} fps, drawing ${withMeters.meters}), without them ${without.dropped} (${without.fps.toFixed(1)} fps, drawing ${without.meters})`);
  check(withMeters.meters && !without.meters, 'the meters drew in the first run and not in the second');
  await sleep(3500);
  check(await js(`(() => { const st = Cut.ui.meters.state; return [...st.peak, ...st.rms, ...st.hold].every((x) => x === null) && !Cut.ui.meters.running; })()`), 'back on screen, levels left from before fall away instead of staying frozen');
  check(withMeters.dropped <= without.dropped + 6 && withMeters.fps >= without.fps - 2, `the meters cost no playback frames (${withMeters.dropped} vs ${without.dropped} dropped)`);
});

// ---------- screenshots ----------
await section('shots', async () => {
  await fresh({
    clips: [{ at: 0, len: 6 }],
    markers: [{ t: 1, name: 'Intro', kind: 'comment', color: 'red' }, { t: 3, name: 'Chapter 2', kind: 'chapter', color: 'green', duration: 1.5 }],
  });
  await js(`(() => { const C = Cut.commands, s = __pn.seq().id, c = __pn.seq().clips[0].id; for (const o of [80, 60, 40]) Cut.app.history.do(C.setClip(s, c, { props: { opacity: o } })); Cut.app.history.goTo(2); return true; })()`);
  await workspace('editing');
  await showTab('markers');
  log(`  saved ${await ctx.shot('panels-markers-dark.png')}`);
  await showTab('history');
  log(`  saved ${await ctx.shot('panels-history-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(400);
  log(`  saved ${await ctx.shot('panels-history-light.png')}`);
  await showTab('markers');
  log(`  saved ${await ctx.shot('panels-markers-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

ctx.finish();
