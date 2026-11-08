// Nano Studio Cut's timeline and editing panels in the real app (docs/cut-architecture.md section 10, timeline agent),
// driven with real mouse events (Input.dispatchMouseEvent) and keys. Every edit is checked in the model and undone
// with Ctrl+Z. Checks:
// - drag a clip (and its linked audio), Ctrl-drag to insert, edge trims with the selection, ripple and rolling edit
//   tools, a razor click, Q and W, Ctrl+K, Shift+Delete, snapping to the playhead with its guide (and S turns it off),
//   zoom keys and the playhead staying put, marquee, Shift / Ctrl / Alt clicks, a locked track, the clip menu;
// - drops on the timeline from the project panel and the source monitor (the shared Cut.ui.dnd payload), thumbnails
//   and a waveform drawn from Cut.thumbs;
// - effect controls: a keyframe made with the stopwatch, a second by typing a value, the values in between, a
//   keyframe dragged in the lane, an ease from its menu;
// - an effect and a transition dragged from the effects panel onto a clip and an edit point, Ctrl+D;
// - the color panel: a slider drag writes color.basic in one undo step, a typed value, the eyedropper neutralizes a
//   warm solid;
// - the program monitor's handles: a drag moves the clip; the Type tool and Korean typed through the IME into a text
//   layer, nothing recorded until the composition and the editor end;
// - 500 clips: scroll and drag frame times;
// - screenshots in the dark and the light theme (verify/out/cut-timeline/*.png).
// Usage: node verify/cut-timeline.mjs   (CUT_TL_ONLY=edits,gestures,drops,controls,effects,color,overlay,text,perf,shots)
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_TL_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-timeline-home');
const ctx = await launch({ fixture: 'core', port: 9756, name: 'cut-timeline', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');

await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['timeline', 'controls', 'effects', 'text', 'color'].every((id) => Cut.ui.panels.has(id)) && !!Cut.ui.overlay?.attach && !!Cut.ui.edit`), 'the timeline area registers its panels, the overlay and the edit helpers');

// ---------- page helpers ----------
await js(`(() => {
  const T = Cut.time.TICKS;
  const H = (window.__tl = {});
  H.app = () => Cut.app;
  H.seq = () => Cut.app.sequence;
  H.media = (id, opts = {}) => ({ path: 'C:\\\\nowhere\\\\' + id + '.mp4', name: id + '.mp4', kind: 'video', size: 1000, mtime: 1, duration: opts.duration ?? 120 * T,
    video: { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 }, audio: opts.audio === false ? null : { rate: 48000, channels: 2 } });
  // A fresh project: one 1080p30 sequence, the media given, clips [{media, at, len, in}] on V1/A1.
  // async: opening a project fits the timeline to it on the next frame; tests set their own zoom after that.
  H.fresh = async (spec = {}) => {
    const C = Cut.commands;
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 1920, h: 1080 } });
    const h = C.createHistory(p);
    Cut.app.setHistory(h, null, 'open');
    const seq = Cut.app.sequence;
    const ids = h.do(C.importMedia(spec.media || [H.media('a'), H.media('b')])).ids;
    for (const c of spec.clips || []) h.do(C.place(seq.id, { source: { media: ids[c.media ?? 0] }, in: c.in ?? 0, out: (c.in ?? 0) + c.len, at: c.at, video: c.video ?? 'V1', audio: c.audio === undefined ? 'A1' : c.audio }));
    // a clean history: the setup is not an undo step
    const h2 = C.createHistory(JSON.parse(JSON.stringify(h.project)));
    Cut.app.setHistory(h2, null, 'open');
    Cut.ui.setSnapping(Cut.app, true);
    Cut.ui.setTargets(Cut.app, null);
    Cut.app.setTool('select');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { media: ids };
  };
  H.clips = (track) => H.seq().clips.filter((c) => !track || c.track === track).map((c) => ({ id: c.id, track: c.track, start: c.start / T, end: Cut.model.clipEnd(c) / T, in: c.in / T, out: c.out / T, link: c.link }))
    .sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
  H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
  H.tl = () => Cut.ui.timeline.current;
  H.pt = (t, track, dy = 0.55) => { const p = Cut.ui.timeline.clientPoint(t * T, track, dy); return { x: p.x, y: Math.round(p.y) }; };
  H.view = (pps = H.pps()) => { const tl = H.tl(); tl.setZoom(pps, { t: 0, x: 0 }); tl.setScroll(0, 0); return true; };
  // 25 px a second (20 on a narrow window): 32 s fit, and every 0.2 s is a whole pixel.
  H.pps = () => (H.tl().root.querySelector('.cut-tl-scroll').clientWidth >= 820 ? 25 : 20);
  H.rect = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
const MOD = { Alt: 1, Ctrl: 2, Shift: 8 };
const mods = (list = []) => list.reduce((m, k) => m | MOD[k], 0);
async function clickAt(p, { modifiers = [], button = 'left', count = 1 } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers: m });
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', p.x, p.y, { modifiers: m, button, buttons: button === 'right' ? 2 : 1, clickCount: i });
    await mouse('mouseReleased', p.x, p.y, { modifiers: m, button, buttons: 0, clickCount: i });
  }
  await sleep(90);
}
// late: the modifiers are pressed once the drag is under way (Ctrl to insert a drop), not on the press itself.
async function drag(a, b, { modifiers = [], steps = 10, pause = 18, late = false } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0, modifiers: late ? 0 : m });
  await mouse('mousePressed', a.x, a.y, { modifiers: late ? 0 : m });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { modifiers: late && i < 2 ? 0 : m });
    await sleep(pause);
  }
  await sleep(60);
  await mouse('mouseReleased', b.x, b.y, { modifiers: m });
  await sleep(120);
}
const pt = (t, track, dy) => js(`__tl.pt(${t}, ${S(track)}, ${dy ?? 0.55})`);
const clips = (track) => js(`__tl.clips(${track ? S(track) : ''})`);
const steps = () => js('__tl.steps()');
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fmt = (list) => list.map((c) => `${c.track}:${c.start.toFixed(3)}-${c.end.toFixed(3)}[${c.in.toFixed(2)}]`).join(' ');
async function undoAll(n, label) {
  for (let i = 0; i < n; i++) await press('Ctrl+z');
  await sleep(80);
  void label;
}
async function focusTimeline() {
  // an empty spot of the lanes on V2, on screen at any zoom; a click that did not reach the timeline (a redraw between
  // press and release on a slow runner) is made once more, as verify/lib.mjs click() does
  for (let i = 0; i < 2; i++) {
    const p = await js(`(() => {
      const tl = Cut.ui.timeline, box = tl.root.querySelector('.cut-tl-scroll').getBoundingClientRect(), r = tl.rowOf('V2');
      const y = r.y + r.h / 2;
      for (let x = box.width - 40; x > 20; x -= 15) if (!tl.hit(x, y).clip && !tl.hit(x, y).transition) return { x: box.left + x, y: box.top + y };
      return { x: box.left + box.width - 40, y: box.top + y };
    })()`);
    await clickAt(p);
    if ((await js('Cut.app.focusPanel')) === 'timeline') return;
    log(`  (the click at ${p.x.toFixed(0)},${p.y.toFixed(0)} to focus the timeline hit ${await js(`(() => { const n = document.elementFromPoint(${p.x}, ${p.y}); return n ? n.className + ' in ' + (n.closest('[data-panel]')?.dataset.panel || '-') : 'nothing'; })()`)}; focus ${await js('Cut.app.focusPanel')})`);
  }
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
}
await js(`Cut.ui.setWorkspace('editing')`);
await sleep(400);

// ---------- edits with the tools ----------
await section('edits', async () => {
  // c1 a 0..10 s, c2 b 10..20 s on V1 + A1 (linked)
  await js(`__tl.fresh({ clips: [{ media: 0, at: 0, len: 10 * ${T} }, { media: 1, at: 10 * ${T}, len: 10 * ${T} }] })`);
  await sleep(300);
  await js('__tl.view()');
  await sleep(150);
  const visible = await js(`(() => { const p = __tl.pt(5, 'V1'); const n = document.elementFromPoint(p.x, p.y); return !!n?.closest('.cut-tl-scroll'); })()`);
  check(visible, 'the timeline lanes are on screen where clip c1 is drawn');
  const start = await clips();
  check(start.length === 4, `four clips to start with (${fmt(start)})`);

  // move c2 (with its linked audio) +5 s
  let before = await steps();
  await drag(await pt(15, 'V1'), await pt(20, 'V1'));
  let now = await clips();
  check(now.filter((c) => c.start === 15).length === 2 && now.filter((c) => c.start === 0).length === 2, `dragging a clip moves it and its linked audio by 5 s (${fmt(now)})`);
  check((await steps()) === before + 1, 'the move is one undo step');
  await press('Ctrl+z');
  now = await clips();
  check(S(now) === S(start), 'Ctrl+Z puts the moved clips back');

  // Ctrl-drag c2 to 0: insert, c1 pushed to 10 s
  await drag(await pt(15, 'V1'), await pt(5, 'V1'), { modifiers: ['Ctrl'] });
  now = await clips('V1');
  check(now.length === 2 && now[0].start === 0 && now[0].in === 0 && now[1].start === 10 && Math.abs(now[0].end - 10) < 1e-9 && (await clips('A1')).map((c) => c.start).join() === '0,10', `Ctrl-drag inserts c2 at 0 and pushes c1 to 10 s on both tracks (${fmt(await clips())})`);
  const insertedFirst = (await js(`__tl.seq().clips.find((c) => c.track === 'V1' && c.start === 0).source.media`)) === (await js(`__tl.app().project.media[1].id`));
  check(insertedFirst, 'the clip at 0 after the insert is c2 (media b)');
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the insert');

  // selection tool: trim c1's end -2 s leaves a gap
  await drag(await pt(10 - 0.08, 'V1'), await pt(8 - 0.08, 'V1'));
  now = await clips();
  check(now.find((c) => c.track === 'V1' && c.start === 0)?.end === 8 && now.find((c) => c.track === 'V1' && c.start === 10), `the selection tool trims c1's end to 8 s and c2 stays at 10 s (${fmt(now)})`);
  check(now.find((c) => c.track === 'A1' && c.start === 0)?.end === 8, 'the linked audio is trimmed with it');
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the trim');

  // while trimming, the program monitor shows the frames on both sides of the edit point; after, the picture again
  {
    const e0 = await pt(10 - 0.08, 'V1');
    await mouse('mouseMoved', e0.x, e0.y, { buttons: 0 });
    await mouse('mousePressed', e0.x, e0.y);
    for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', e0.x - i * 8, e0.y); await sleep(30); }
    await sleep(300);
    const during = await js(`!document.querySelector('.cut-panel[data-panel="program"] .cut-trim-view').hidden`);
    await mouse('mouseReleased', e0.x - 40, e0.y);
    await sleep(150);
    const after = await js(`document.querySelector('.cut-panel[data-panel="program"] .cut-trim-view').hidden`);
    check(during && after, `the program monitor shows the two-up trim view while an edge is dragged, and hides it after (${during}, ${after})`);
    await press('Ctrl+z');
  }
  // ripple edit tool (B): the same drag pulls c2 to 8 s
  await focusTimeline();
  await press('b');
  check((await js('__tl.app().tool')) === 'ripple', 'B picks the ripple edit tool');
  await drag(await pt(10 - 0.08, 'V1'), await pt(8 - 0.08, 'V1'));
  now = await clips();
  check(now.filter((c) => c.start === 8 && near(c.end, 18)).length === 2 && now.filter((c) => c.start === 0 && c.end === 8).length === 2, `the ripple edit tool trims c1 to 8 s and pulls c2 to 8 s (${fmt(now)})`);
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the ripple trim');

  // rolling edit tool (N): the edit point moves +1 s, total length kept
  await press('n');
  check((await js('__tl.app().tool')) === 'roll', 'N picks the rolling edit tool');
  await drag(await pt(10 - 0.08, 'V1'), await pt(11 - 0.08, 'V1'));
  now = await clips('V1');
  check(now[0].end === 11 && now[1].start === 11 && near(now[1].in, 1) && now[1].end === 20, `the rolling edit moves the edit point to 11 s, c2 starts 1 s later in its source (${fmt(now)})`);
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the roll');

  // razor (C): a click at 5 s cuts c1 and its audio (zoomed in: a click lands on a frame, not on a pixel's worth)
  await press('c');
  await js('__tl.view(100)');
  await clickAt(await pt(5, 'V1'));
  await js('__tl.view()');
  now = await clips();
  check(now.filter((c) => c.start === 5 || c.end === 5).length === 4 && now.length === 6, `a razor click at 5 s cuts c1 and its linked audio (${fmt(now)})`);
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the cut');
  await press('v');
  check((await js('__tl.app().tool')) === 'select', 'V goes back to the selection tool');

  // Q and W at 4 s
  await js(`__tl.app().setTime(4 * ${T})`);
  await focusTimeline();
  await press('q');
  now = await clips('V1');
  check(now[0].start === 0 && near(now[0].in, 4) && near(now[0].end, 6) && near(now[1].start, 6), `Q ripple-trims from the previous edit to the playhead (${fmt(now)})`);
  check(near(await js(`__tl.app().t / ${T}`), 0), 'Q leaves the playhead on the edit point');
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes Q');
  await js(`__tl.app().setTime(4 * ${T})`);
  await press('w');
  now = await clips('V1');
  check(near(now[0].end, 4) && near(now[1].start, 4), `W ripple-trims from the playhead to the next edit (${fmt(now)})`);
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes W');

  // Ctrl+K at 3 s on the targeted tracks (all)
  await js(`__tl.app().setTime(3 * ${T})`);
  await press('Ctrl+k');
  now = await clips();
  check(now.length === 6 && now.filter((c) => c.start === 3).length === 2, `Ctrl+K cuts every targeted track at the playhead (${fmt(now)})`);
  await press('Ctrl+z');
  // targeting: only V1 targeted -> Ctrl+K cuts V1 alone
  await clickAt(await js(`__tl.rect('.cut-tl-head[data-track="A1"] .target')`));
  await clickAt(await js(`__tl.rect('.cut-tl-head[data-track="A2"] .target')`));
  await clickAt(await js(`__tl.rect('.cut-tl-head[data-track="V2"] .target')`));
  check(S(await js('Cut.ui.editing.targets')) === S(['V1']), 'the track headers target V1 alone');
  await focusTimeline();
  await press('Ctrl+k');
  now = await clips();
  check(now.length === 6, `with V1 targeted and linked selection on, Ctrl+K cuts V1 and the audio linked to it (${fmt(now)})`);
  await press('Ctrl+z');
  await clickAt(await js(`__tl.rect('.cut-tl-toggle[data-role="linked"]')`));
  check((await js('Cut.ui.timeline.view.linked')) === false, 'the linked selection button turns linked selection off');
  await focusTimeline();
  await press('Ctrl+k');
  now = await clips();
  check(now.length === 5 && (await clips('A1')).length === 2 && (await clips('V1')).length === 3, `with V1 targeted and linked selection off, Ctrl+K cuts V1 only (${fmt(now)})`);
  await press('Ctrl+z');
  await clickAt(await js(`__tl.rect('.cut-tl-toggle[data-role="linked"]')`));
  await js('Cut.ui.setTargets(Cut.app, null)');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes Ctrl+K');

  // Shift+Delete on c1: ripple delete
  await clickAt(await pt(5, 'V1'));
  check((await js('__tl.app().selection.size')) === 2, 'clicking c1 selects it and its linked audio');
  await press('Shift+Delete');
  now = await clips();
  check(now.length === 2 && now.every((c) => c.start === 0 && c.end === 10), `Shift+Delete ripple-deletes c1 and pulls c2 to 0 (${fmt(now)})`);
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the ripple delete');

  // a gap: Delete closes it
  await clickAt(await pt(5, 'V1'));
  await press('Delete');
  await clickAt(await pt(5, 'V1'));
  check(!!(await js('Cut.ui.timeline.gap')), 'a click in the gap left by Delete selects the gap');
  await press('Delete');
  now = await clips();
  check(now.length === 2 && now.every((c) => c.start === 0), `Delete on a selected gap closes it (${fmt(now)})`);
  await undoAll(2);
  check(S(await clips()) === S(start), 'Ctrl+Z twice undoes the gap and the delete');

  // snapping: the playhead at 25 s; c2's start dropped 0.2 s (4-5 px) from it snaps there, with the guide on
  await js(`__tl.app().setTime(25 * ${T})`);
  const a = await pt(15, 'V1');
  const b = await pt(15 + 15 + 0.2, 'V1');
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 10, a.y); await sleep(20); }
  await sleep(80);
  const guide = await js(`Cut.ui.timeline.view.guide / ${T}`);
  await mouse('mouseReleased', b.x, b.y);
  await sleep(120);
  now = await clips('V1');
  check(near(guide, 25), `the snap guide shows at the playhead while dragging (${guide})`);
  check(now[1].start === 25, `the clip snaps to the playhead (start ${now[1].start})`);
  await press('Ctrl+z');
  await focusTimeline();
  await press('s');
  check((await js('Cut.ui.editing.snapping')) === false, 'S turns snapping off');
  await drag(a, b);
  now = await clips('V1');
  check(near(now[1].start, 25.2, 1e-6), `without snapping the clip lands where it was dropped (start ${now[1].start})`);
  await press('Ctrl+z');
  await press('s');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the snapping moves');

  // zoom: = and - keep the playhead where it is on screen; \ fits the sequence
  await js(`__tl.app().setTime(6 * ${T})`);
  const x0 = await js(`Cut.ui.timeline.xOf(6 * ${T})`);
  const pps0 = await js('Cut.ui.timeline.view.pps');
  await press('=');
  const pps1 = await js('Cut.ui.timeline.view.pps');
  const x1 = await js(`Cut.ui.timeline.xOf(6 * ${T})`);
  check(pps1 > pps0 * 1.5 && Math.abs(x1 - x0) < 1, `= zooms in around the playhead (${pps0} -> ${pps1} px/s, x ${x0.toFixed(1)} -> ${x1.toFixed(1)})`);
  await press('-');
  check(Math.abs((await js('Cut.ui.timeline.view.pps')) - pps0) < 1e-6, '- zooms back out');
  await press('\\');
  const fit = await js(`(() => { const tl = Cut.ui.timeline.current; return { end: tl.xOf(20 * ${T}), w: tl.root.querySelector('.cut-tl-scroll').clientWidth }; })()`);
  check(fit.end > fit.w * 0.85 && fit.end <= fit.w, `\\ fits the whole sequence in the view (end at ${fit.end.toFixed(0)} of ${fit.w} px)`);
  await js('__tl.view()');
  await sleep(100);

  // marquee over both clips of V1 and A1
  await js(`__tl.app().select([])`);
  await drag(await pt(1, 'V2', 0.3), await pt(12, 'A1', 0.9));
  check((await js('__tl.app().selection.size')) === 4, `a marquee from V2 to A1 across both clips selects all four (${await js('__tl.app().selection.size')})`);
  // Shift, Ctrl and Alt clicks
  await clickAt(await pt(5, 'V1'));
  await clickAt(await pt(15, 'V1'), { modifiers: ['Shift'] });
  check((await js('__tl.app().selection.size')) === 4, 'Shift+click adds c2 and its audio');
  await clickAt(await pt(5, 'V1'), { modifiers: ['Ctrl'] });
  check((await js('__tl.app().selection.size')) === 2 && !(await js(`[...__tl.app().selection].some((id) => __tl.seq().clips.find((c) => c.id === id).start === 0)`)), 'Ctrl+click takes c1 and its audio out');
  await clickAt(await pt(5, 'V1'), { modifiers: ['Alt'] });
  check((await js('__tl.app().selection.size')) === 1, 'Alt+click selects one side of a link');
  // Alt-drag moves only that side
  await drag(await pt(5, 'V1'), await pt(7, 'V1'), { modifiers: ['Alt'] });
  now = await clips();
  check(now.find((c) => c.track === 'V1' && c.start === 2) && now.find((c) => c.track === 'A1' && c.start === 0), `an Alt-selected video clip moves without its audio (${fmt(now)})`);
  await press('Ctrl+z');
  check(S(await clips()) === S(start), 'Ctrl+Z undoes the one-sided move');

  // a locked track: nothing moves
  await clickAt(await js(`__tl.rect('.cut-tl-head[data-track="V1"] .lock')`));
  check((await js(`__tl.seq().tracks.find((t) => t.id === 'V1').locked`)) === true, 'the lock button locks V1');
  before = await steps();
  await drag(await pt(15, 'V1'), await pt(25, 'V1'));
  check(S(await clips()) === S(start) && (await steps()) === before, 'a clip on a locked track does not move');
  await press('Ctrl+z');
  check((await js(`__tl.seq().tracks.find((t) => t.id === 'V1').locked`)) === false, 'Ctrl+Z unlocks it');

  // the clip menu: Ripple Delete
  await clickAt(await pt(5, 'V1'), { button: 'right' });
  await until(`!!document.querySelector('.context-menu .menu-item')`, 'the clip menu', 3000).catch(() => {});
  const row = await js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === tr('Ripple Delete')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  check(!!row, 'right-clicking a clip opens its menu with Ripple Delete');
  if (row) {
    await clickAt(row);
    now = await clips();
    check(now.length === 2 && now.every((c) => c.start === 0), `the menu's Ripple Delete removes c1 and closes the gap (${fmt(now)})`);
    await press('Ctrl+z');
  }
  check(S(await clips()) === S(start), 'all edits undone: the clips are as at the start');
});

// ---------- more gestures: track select, hand, zoom tool, ruler, the volume line, fades, copy and paste, speed ----------
await section('gestures', async () => {
  await js(`__tl.fresh({ clips: [{ media: 0, at: 0, len: 10 * ${T} }, { media: 1, at: 10 * ${T}, len: 10 * ${T} }] })`);
  await js('__tl.view()');
  await sleep(200);
  const start = await clips();
  // A: everything from the click to the right, then drag it all 2 s later
  await focusTimeline();
  await press('a');
  await clickAt(await pt(12, 'V1'));
  check((await js('__tl.app().selection.size')) === 2, 'the track select forward tool picks the clips from the click on (c2 and its audio)');
  await drag(await pt(12, 'V1'), await pt(14, 'V1'));
  let now = await clips();
  check(now.filter((c) => c.start === 12).length === 2 && now.filter((c) => c.start === 0).length === 2, `and dragging moves them together (${fmt(now)})`);
  await press('Ctrl+z');
  // Shift+A: everything before the click
  await press('Shift+a');
  await clickAt(await pt(5, 'V1'));
  check((await js(`[...__tl.app().selection].every((id) => __tl.seq().clips.find((c) => c.id === id).start === 0) && __tl.app().selection.size === 2`)), 'the track select backward tool picks the clips before the click');
  // hand: a drag scrolls the view
  await js('__tl.view(60)');
  await press('h');
  const sx0 = await js('Cut.ui.timeline.view.scrollX');
  await drag(await pt(8, 'V2', 0.5), await pt(4, 'V2', 0.5));
  const sx1 = await js('Cut.ui.timeline.view.scrollX');
  check(sx1 - sx0 > 200, `the hand tool drags the view along (${sx0.toFixed(0)} -> ${sx1.toFixed(0)} px)`);
  // zoom tool: a click zooms in at the click, Alt+click out
  await js('__tl.view()');
  await press('z');
  const z0 = await js('Cut.ui.timeline.view.pps');
  const zp = await pt(8, 'V2', 0.5);
  await clickAt(zp);
  const z1 = await js('Cut.ui.timeline.view.pps');
  const at = await js(`Cut.ui.timeline.tOf(${zp.x} - Cut.ui.timeline.root.querySelector('.cut-tl-scroll').getBoundingClientRect().left) / ${T}`);
  check(z1 > z0 * 1.9 && Math.abs(at - 8) < 0.05, `the zoom tool zooms in around the click (${z0} -> ${z1} px/s, 8 s still under the pointer: ${at.toFixed(2)})`);
  await clickAt(zp, { modifiers: ['Alt'] });
  check(Math.abs((await js('Cut.ui.timeline.view.pps')) - z0) < 1e-6, 'Alt+click with the zoom tool zooms back out');
  await press('v');
  // the ruler: press and drag the playhead
  await js('__tl.view()');
  const ruler = await js(`__tl.rect('.cut-tl-ruler')`);
  const rpps = await js('Cut.ui.timeline.view.pps');
  const rx = (t) => ruler.left + t * rpps;
  const ry = ruler.y;
  await drag({ x: rx(3), y: ry }, { x: rx(7), y: ry }, { steps: 6 });
  check(Math.abs((await js(`__tl.app().t / ${T}`)) - 7) < 0.05, `dragging on the ruler moves the playhead with the pointer (${(await js(`__tl.app().t / ${T}`)).toFixed(3)} s)`);
  // the audio volume line: Ctrl+click makes a keyframe, dragging it changes its value
  await js('__tl.view(60)');
  const a1 = await js(`__tl.seq().clips.find((c) => c.track === 'A1' && c.start === 0).id`);
  const bandAt = await js(`(() => { const tl = Cut.ui.timeline; const r = tl.rowOf('A1'); const box = tl.root.querySelector('.cut-tl-scroll').getBoundingClientRect(); for (let y = r.y + 16; y < r.y + r.h; y++) { const h = tl.hit(tl.xOf(4 * ${T}), y); if (h.part === 'band') return { x: box.left + tl.xOf(4 * ${T}), y: box.top + y + 1 }; } return null; })()`);
  check(!!bandAt, 'the audio clip shows its volume line');
  if (bandAt) {
    await clickAt(bandAt, { modifiers: ['Ctrl'] });
    let k = await js(`(__tl.seq().clips.find((c) => c.id === ${S(a1)}).keyframes.volume || []).map((x) => ({ t: x.t / ${T}, v: x.v }))`);
    check(k.length === 1 && Math.abs(k[0].t - 4) < 0.05 && k[0].v === 0, `Ctrl+click on the volume line adds a keyframe there (${S(k)})`);
    await drag({ x: bandAt.x, y: bandAt.y - 1 }, { x: bandAt.x, y: bandAt.y + 12 }, { steps: 6 });
    k = await js(`(__tl.seq().clips.find((c) => c.id === ${S(a1)}).keyframes.volume || []).map((x) => ({ t: x.t / ${T}, v: x.v }))`);
    check(k.length === 1 && k[0].v < -10, `dragging the keyframe down lowers the volume there (${S(k)})`);
    await undoAll(2);
  }
  // the fade-in handle of the audio clip
  await clickAt(await pt(5, 'A1', 0.9));
  const fadeAt = await js(`(() => { const tl = Cut.ui.timeline; const r = tl.rowOf('A1'); const box = tl.root.querySelector('.cut-tl-scroll').getBoundingClientRect(); return { x: box.left + tl.xOf(0) + 1, y: box.top + r.y + 1 + 15 + 3 }; })()`);
  await drag(fadeAt, { x: fadeAt.x + 60, y: fadeAt.y }, { steps: 6 });
  const fade = await js(`__tl.seq().clips.find((c) => c.id === ${S(a1)}).fadeIn / ${T}`);
  check(Math.abs(fade - 1) < 0.05, `dragging the fade handle sets a 1 s fade in (${fade.toFixed(3)} s)`);
  await press('Ctrl+z');
  // copy and paste at the playhead
  await js('__tl.view()');
  await clickAt(await pt(5, 'V1'));
  await press('Ctrl+c');
  await js(`__tl.app().setTime(25 * ${T})`);
  await focusTimeline();
  await press('Ctrl+v');
  now = await clips();
  check(now.filter((c) => c.start === 25 && c.end === 35).length === 2, `Ctrl+C and Ctrl+V copy c1 and its audio to the playhead (${fmt(now)})`);
  check((await js(`(() => { const p = __tl.seq().clips.filter((c) => c.start === 25 * ${T}); return p.length === 2 && p[0].link && p[0].link === p[1].link; })()`)), 'the pasted pair is linked');
  await press('Ctrl+z');
  // speed: Ctrl+R, 50 %, ripple
  await clickAt(await pt(5, 'V1'));
  await press('Ctrl+r');
  await until(`!!document.querySelector('.cut-dialog .cut-number')`, 'the speed dialog', 3000).catch(() => {});
  const field = await js(`__tl.rect('.cut-dialog .cut-number')`);
  check(!!field, 'Ctrl+R opens the speed and duration dialog');
  if (field) {
    await clickAt(field);
    await press('Ctrl+a');
    await ctx.type('50');
    await press('Enter');
    await sleep(150);
    now = await clips('V1');
    check(!(await js(`!!document.querySelector('.cut-dialog')`)) && now[0].end === 20 && now[1].start === 20, `50 % and Enter: c1 is 20 s long and c2 pushed along (${fmt(now)})`);
    await press('Ctrl+z');
  }
  check(S(await clips()) === S(start), 'everything undone');
});

// ---------- drops from the project panel and the source monitor; thumbnails and waveforms ----------
await section('drops', async () => {
  // real media: an H.264 test source (no audio) made with WebCodecs, and a WAV made here
  const wav = path.join(home, 'tone.wav');
  writeFileSync(wav, wavBytes(4, 440));
  const mp4 = path.join(home, 'frames.mp4');
  const made = await js(`(async () => {
    try {
      const bytes = await Cut.testsrc.make({ seconds: 4, fps: [30, 1], w: 640, h: 360, audio: false });
      const o = await ide.api.invoke('cut:writeOpen', ${S(mp4)});
      if (!o?.id) return 'writeOpen: ' + JSON.stringify(o);
      await ide.api.invoke('cut:writeAt', o.id, bytes);
      const c = await ide.api.invoke('cut:writeClose', o.id, { commit: true });
      return c?.ok ? 'ok' : 'writeClose: ' + JSON.stringify(c);
    } catch (err) { return String(err?.stack || err); }
  })()`);
  check(made === 'ok', `a test source MP4 is made (${made})`);
  await js(`__tl.fresh({ media: [__tl.media('fake')] })`);
  const ids = await js(`Cut.ui.media.importPaths(Cut.app, ${S([mp4, wav])}).then((ids) => ids)`);
  check(ids.length === 2, `the project panel imports the MP4 and the WAV (${S(ids)})`);
  await sleep(500);
  await js('__tl.view(100)');
  await js(`Cut.ui.showPanel('project')`);
  await sleep(300);
  // the video item from the project panel onto V1 at 1 s, with the real mouse (Cut.ui.dnd)
  const item = await js(`__tl.rect('.cut-panel[data-panel="project"] [data-id="${ids[0]}"]')`);
  check(!!item, 'the imported video shows in the project panel');
  let before = await steps();
  if (item) {
    await drag(item, await pt(1, 'V1', 0.5), { steps: 14 });
    const now = await clips();
    const placed = now.filter((c) => near(c.start, 1));
    check(placed.length === 1 && placed[0].track === 'V1' && near(placed[0].end, 5), `the project item dropped on V1 at 1 s places the 4 s clip there (${fmt(now)})`);
    check((await steps()) === before + 1, 'the drop is one undo step');
    // the empty sequence took the clip's settings (640x360 at 30 fps) in that step
    check(S(await js(`[__tl.seq().w, __tl.seq().h]`)) === S([640, 360]), 'the first clip in an empty sequence sets the sequence to its size');
  }
  // the WAV from the project panel onto A2 at 2 s with Ctrl: an insert
  const wavItem = await js(`__tl.rect('.cut-panel[data-panel="project"] [data-id="${ids[1]}"]')`);
  if (wavItem) {
    await drag(wavItem, await pt(2, 'A2', 0.5), { steps: 14, modifiers: ['Ctrl'], late: true });
    const a2 = await clips('A2');
    check(a2.length === 1 && near(a2[0].start, 2) && near(a2[0].end, 6), `the WAV dropped with Ctrl lands on A2 at 2 s (${fmt(a2)})`);
  }
  // thumbnails and the waveform get drawn
  await js(`Cut.ui.timeline.view.pps`);
  const drawn = await until(`(() => { Cut.ui.timeline.invalidate(); const s = Cut.ui.timeline.stats; return s.thumbs > 0 && s.waves > 0; })()`, 'thumbnails and waveform drawn', 30000).catch(() => false);
  check(drawn, `the clips show a thumbnail strip and a waveform from Cut.thumbs (${S(await js('({ thumbs: Cut.ui.timeline.stats.thumbs, waves: Cut.ui.timeline.stats.waves })'))})`);
  // from the source monitor: open the video there, drag its "video only" handle to V2 at 6 s
  await js(`Cut.app.setSource({ mediaId: ${S(ids[0])}, in: ${T}, out: 3 * ${T}, t: ${T} })`);
  await js(`Cut.ui.showPanel('source')`);
  await sleep(500);
  const handle = await js(`__tl.rect('.cut-panel[data-panel="source"] .cut-drag-handle.video')`);
  check(!!handle, 'the source monitor has a drag handle for the video only');
  if (handle) {
    before = await steps();
    await drag(handle, await pt(6, 'V2', 0.5), { steps: 14 });
    const v2 = await clips('V2');
    check(v2.length === 1 && near(v2[0].start, 6) && near(v2[0].end, 8) && near(v2[0].in, 1) && (await clips('A1')).length === 0, `the source clip (In 1 s, Out 3 s) dropped as video only lands on V2 at 6 s (${fmt(v2)})`);
  }
  await js(`Cut.ui.showPanel('controls')`);
  await shot('timeline-media-dark.png');
  const n = (await steps()) - 1; // the import stays
  await undoAll(n);
  check((await clips()).length === 0, 'Ctrl+Z takes the drops back');
});

// ---------- effect controls: keyframes ----------
await section('controls', async () => {
  await js(`__tl.fresh({ clips: [{ media: 0, at: 0, len: 10 * ${T} }, { media: 1, at: 10 * ${T}, len: 10 * ${T} }] })`);
  await js('__tl.view()');
  await js(`__tl.app().setTime(2 * ${T})`);
  await clickAt(await pt(5, 'V1'));
  await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="controls"]')`));
  await sleep(200);
  const watch = '.cut-ec-row[data-path="opacity"] .watch';
  await until(`!!document.querySelector(${S(watch)})`, 'the opacity row in effect controls');
  const c1 = await js(`__tl.seq().clips.find((c) => c.track === 'V1' && c.start === 0).id`);
  const kf = () => js(`(__tl.seq().clips.find((c) => c.id === ${S(c1)}).keyframes.opacity || []).map((k) => ({ t: k.t / ${T}, v: k.v, ease: k.ease }))`);
  const before = await steps();
  await clickAt(await js(`__tl.rect(${S(watch)})`));
  let k = await kf();
  check(k.length === 1 && near(k[0].t, 2) && k[0].v === 100, `the stopwatch makes a keyframe at the playhead (${S(k)})`);
  // 6 s: type 20 into the opacity field
  await js(`__tl.app().setTime(6 * ${T})`);
  await sleep(100);
  await clickAt(await js(`__tl.rect('.cut-ec-row[data-path="opacity"] .cut-number')`));
  await until(`!!document.querySelector('.cut-ec-row[data-path="opacity"] .cut-number-input')`, 'the opacity field turns into an input');
  await press('Ctrl+a');
  await ctx.type('20');
  await press('Enter');
  await sleep(150);
  k = await kf();
  check(k.length === 2 && near(k[1].t, 6) && k[1].v === 20, `a value typed with keyframes on makes a keyframe at 6 s (${S(k)})`);
  const mid = await js(`Cut.keyframes.propValue(__tl.seq().clips.find((c) => c.id === ${S(c1)}), 'opacity', 4 * ${T}, 100)`);
  check(Math.abs(mid - 60) < 1e-6, `the value halfway between the keyframes is 60 (${mid})`);
  await js(`__tl.app().setTime(4 * ${T})`);
  await sleep(200);
  const shown = await js(`document.querySelector('.cut-ec-row[data-path="opacity"] .cut-number-text').textContent`);
  check(shown === '60', `the opacity field shows the value at the playhead (${shown})`);
  // drag the 6 s keyframe in the lane to 8 s
  const lane = await js(`(() => { const n = document.querySelector('.cut-ec-row[data-path="opacity"] .cut-ec-lane'); const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
  const lx = (t) => lane.left + 6 + (t / 10) * (lane.w - 12);
  await drag({ x: lx(6), y: lane.top + lane.h / 2 }, { x: lx(8), y: lane.top + lane.h / 2 }, { steps: 8 });
  k = await kf();
  check(k.length === 2 && Math.abs(k[1].t - 8) < 0.07 && k[1].v === 20, `dragging the keyframe in the lane moves it to 8 s (${S(k)})`);
  // the ease menu of the first keyframe
  await clickAt({ x: lx(2), y: lane.top + lane.h / 2 }, { button: 'right' });
  const easeRow = await js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === tr('Ease Out')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (easeRow) await clickAt(easeRow);
  k = await kf();
  check(k[0]?.ease === 'easeOut', `the lane menu sets Ease Out on the keyframe (${S(k)})`);
  // prev / next keyframe buttons
  await js(`__tl.app().setTime(5 * ${T})`);
  await clickAt(await js(`__tl.rect('.cut-ec-row[data-path="opacity"] .next')`));
  check(Math.abs((await js(`__tl.app().t / ${T}`)) - k[1].t) < 1e-6, 'the next-keyframe button moves the playhead to the next keyframe');
  await clickAt(await js(`__tl.rect('.cut-ec-row[data-path="opacity"] .prev')`));
  check(near(await js(`__tl.app().t / ${T}`), 2), 'the previous-keyframe button moves it back');
  const n = (await steps()) - before;
  check(n === 4, `four undo steps: stopwatch, value, lane drag, ease (${n})`);
  await focusTimeline();
  await undoAll(n);
  check((await kf()).length === 0, 'Ctrl+Z takes every keyframe back');
});

// ---------- effects panel: an effect onto a clip, a transition onto an edit point, Ctrl+D ----------
await section('effects', async () => {
  await js(`__tl.fresh({ clips: [{ media: 0, at: 0, len: 10 * ${T} }, { media: 1, at: 10 * ${T}, len: 10 * ${T} }] })`);
  await js('__tl.view()');
  await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="effects"]')`));
  await sleep(200);
  await clickAt(await js(`__tl.rect('.cut-fx-search')`));
  await ctx.type('Gaussian');
  await sleep(150);
  const item = await js(`__tl.rect('.cut-fx-item[data-type="blur.gaussian"]')`);
  check(!!item, 'searching "Gaussian" shows Gaussian Blur in the effects panel');
  const c1 = await js(`__tl.seq().clips.find((c) => c.track === 'V1' && c.start === 0).id`);
  if (item) {
    await drag(item, await pt(5, 'V1'), { steps: 14 });
    const fx = await js(`__tl.seq().clips.find((c) => c.id === ${S(c1)}).effects.map((e) => e.type)`);
    check(S(fx) === S(['blur.gaussian']), `Gaussian Blur dragged onto c1 lands on it (${S(fx)})`);
    await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="controls"]')`));
    await sleep(200);
    check(!!(await js(`document.querySelector('.cut-ec-sec[data-section^="fx:${c1}:"] .cut-ec-row[data-path$=".blurriness"], .cut-ec-sec[data-section^="fx:${c1}:"] .cut-ec-row')`)), 'effect controls show the effect with rows built from its parameters');
    await press('Ctrl+z');
    check((await js(`__tl.seq().clips.find((c) => c.id === ${S(c1)}).effects.length`)) === 0, 'Ctrl+Z removes the effect');
  }
  await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="effects"]')`));
  await sleep(150);
  await clickAt(await js(`__tl.rect('.cut-fx-search')`));
  await press('Ctrl+a');
  await ctx.type('Dip to Black');
  await sleep(150);
  const dip = await js(`__tl.rect('.cut-fx-item[data-type="dip.black"]')`);
  check(!!dip, 'searching shows Dip to Black');
  if (dip) {
    await drag(dip, await pt(10.1, 'V1', 0.8), { steps: 14 });
    const trs = await js(`__tl.seq().transitions.map((t) => ({ type: t.type, at: t.at / ${T}, align: t.align, track: t.track }))`);
    check(trs.length === 1 && trs[0].type === 'dip.black' && trs[0].at === 10 && trs[0].align === 'center' && trs[0].track === 'V1', `Dip to Black dropped near the edit point sits on it, centered (${S(trs)})`);
    await press('Ctrl+z');
  }
  // Ctrl+D near the playhead
  await js(`__tl.app().setTime(9 * ${T})`);
  await focusTimeline();
  await press('Ctrl+d');
  const trs = await js(`__tl.seq().transitions.map((t) => ({ type: t.type, at: t.at / ${T}, track: t.track }))`);
  check(trs.length === 1 && trs[0].type === 'dissolve' && trs[0].at === 10 && trs[0].track === 'V1', `Ctrl+D puts the default video transition on the edit point nearest the playhead of each targeted video track (${S(trs)}; focus ${await js('Cut.app.focusPanel + " " + document.activeElement?.className')})`);
  await press('Ctrl+z');
  check((await js('__tl.seq().transitions.length')) === 0, 'Ctrl+Z removes it');
  await clickAt(await js(`__tl.rect('.cut-fx-search')`));
  await press('Ctrl+a');
  await press('Delete');
});

// ---------- the color panel ----------
await section('color', async () => {
  await js(`__tl.fresh({ clips: [{ media: 0, at: 0, len: 10 * ${T} }] })`);
  await js(`Cut.ui.setWorkspace('color')`);
  await sleep(400);
  await js('__tl.view()');
  await clickAt(await pt(5, 'V1'));
  await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="color"]')`));
  await sleep(200);
  const c1 = await js(`__tl.seq().clips.find((c) => c.track === 'V1').id`);
  const basic = () => js(`__tl.seq().clips.find((c) => c.id === ${S(c1)}).effects.filter((e) => e.type === 'color.basic').map((e) => e.params)`);
  const slider = await js(`__tl.rect('.cut-color-row[data-param="exposure"] input[type=range]')`);
  check(!!slider, 'the color panel shows the exposure slider');
  const before = await steps();
  await drag({ x: slider.x, y: slider.y }, { x: slider.left + slider.w * 0.8, y: slider.y }, { steps: 10 });
  let p = await basic();
  check(p.length === 1 && p[0].exposure > 1, `dragging the exposure slider adds color.basic and sets exposure (${S(p)})`);
  check((await steps()) === before + 1, 'the slider drag is one undo step, the new effect included');
  await clickAt(await js(`__tl.rect('.cut-color-row[data-param="temperature"] .cut-number')`));
  await until(`!!document.querySelector('.cut-color-row[data-param="temperature"] .cut-number-input')`, 'the temperature field turns into an input');
  await press('Ctrl+a');
  await ctx.type('25');
  await press('Enter');
  await sleep(150);
  p = await basic();
  check(p[0]?.temperature === 25, `a typed temperature goes to color.basic (${S(p)})`);
  await focusTimeline();
  await undoAll(2);
  check((await basic()).length === 0, 'Ctrl+Z twice takes the temperature and then the whole correction back');

  // the eyedropper on a warm solid at 2 s
  await js(`(() => { const C = Cut.commands; const s = __tl.seq(); const r = Cut.app.history.do(C.addGenerated(s.id, { track: 'V2', at: 0, duration: 10 * ${T}, source: { generator: 'solid', color: '#a8a098' } })); Cut.app.select([r.id]); Cut.app.setTime(2 * ${T}); return r.id; })()`);
  await sleep(600);
  const solid = await js(`[...__tl.app().selection][0]`);
  const program = await js(`__tl.rect('.cut-panel[data-panel="program"] canvas.cut-monitor-canvas')`);
  await clickAt(await js(`__tl.rect('.cut-color-dropper')`));
  await sleep(100);
  await clickAt({ x: program.x, y: program.y });
  await until(`(__tl.seq().clips.find((c) => c.id === ${S(solid)}).effects.find((e) => e.type === 'color.basic')?.params.temperature ?? 0) !== 0`, 'the eyedropper sets the white balance', 10000).catch(() => {});
  const wb = await js(`__tl.seq().clips.find((c) => c.id === ${S(solid)}).effects.find((e) => e.type === 'color.basic')?.params || null`);
  check(wb && wb.temperature < -15 && wb.temperature > -60 && Math.abs(wb.tint) < 10, `the eyedropper on a warm gray cools it (${S(wb)})`);
  // the GPU path is the color math itself (linear light); the Canvas 2D fallback only approximates it with filters
  const backend = await js(`document.querySelector('.cut-panel[data-panel="program"] canvas.cut-monitor-canvas') && (Cut.ui.overlay.active ? 'attached' : 'none')`);
  const neutral = await js(`Cut.ui.overlay.pickColorAt(0.5, 0.5)`).catch(() => null);
  check(backend === 'attached' && Array.isArray(neutral), `the eyedropper reads the rendered frame (rgb ${S(neutral?.map((x) => Math.round(x)))})`);
  if (Array.isArray(neutral)) {
    const spread = Math.max(...neutral) - Math.min(...neutral);
    check(spread < 6, `after the white balance the picked spot renders gray (rgb ${neutral.map((x) => x.toFixed(0)).join(', ')}, spread ${spread.toFixed(1)}; was 168, 160, 152)`);
  }
  await js(`Cut.ui.setWorkspace('editing')`);
  await sleep(300);
});

// ---------- the program monitor's handles ----------
await section('overlay', async () => {
  await js(`__tl.fresh({})`);
  await js(`(() => { const C = Cut.commands; const s = __tl.seq(); const r = Cut.app.history.do(C.addGenerated(s.id, { track: 'V1', at: 0, duration: 10 * ${T}, source: { generator: 'solid', color: '#3070c0' } })); Cut.app.history.do(C.setClip(s.id, r.id, { props: { scale: [50, 50] } })); Cut.app.select([r.id]); Cut.app.setTime(2 * ${T}); return r.id; })()`);
  await sleep(500);
  const g = await until(`!!Cut.ui.overlay.active?.geometry`, 'the overlay frame', 8000).then(() => js(`(() => { const g = Cut.ui.overlay.active.geometry; const v = document.querySelector('.cut-panel[data-panel="program"] .cut-ov').getBoundingClientRect(); return { k: g.fr.k, pts: g.corners.map(([x, y]) => [x + v.left, y + v.top]) }; })()`)).catch(() => null);
  check(!!g, 'the program monitor shows handles around the selected clip');
  if (g) {
    const cx = (g.pts[0][0] + g.pts[2][0]) / 2;
    const cy = (g.pts[0][1] + g.pts[2][1]) / 2;
    const solid = await js(`[...__tl.app().selection][0]`);
    const before = await steps();
    await drag({ x: cx, y: cy }, { x: cx + 60, y: cy + 30 }, { steps: 10 });
    const pos = await js(`__tl.seq().clips.find((c) => c.id === ${S(solid)}).props.position`);
    check(Math.abs(pos[0] - 60 / g.k) < 1.5 && Math.abs(pos[1] - 30 / g.k) < 1.5, `dragging inside the frame moves the clip by the same amount in sequence pixels (${S(pos)}, k ${g.k.toFixed(3)})`);
    check((await steps()) === before + 1, 'the drag is one undo step');
    // a corner scales it uniformly
    const corner = { x: g.pts[2][0] + 60, y: g.pts[2][1] + 30 };
    await sleep(150);
    const g2 = await js(`(() => { const g = Cut.ui.overlay.active.geometry; const v = document.querySelector('.cut-panel[data-panel="program"] .cut-ov').getBoundingClientRect(); return { a: [g.anchorAt[0] + v.left, g.anchorAt[1] + v.top] }; })()`);
    const far = { x: g2.a[0] + (corner.x - g2.a[0]) * 1.5, y: g2.a[1] + (corner.y - g2.a[1]) * 1.5 };
    await drag(corner, far, { steps: 10 });
    const sc = await js(`__tl.seq().clips.find((c) => c.id === ${S(solid)}).props.scale`);
    check(Math.abs(sc[0] - 75) < 2 && sc[0] === sc[1], `dragging a corner 1.5x away from the anchor scales 50% -> 75% (${S(sc)})`);
    await focusTimeline();
    await undoAll(2);
    check(S(await js(`__tl.seq().clips.find((c) => c.id === ${S(solid)}).props.position`)) === S([0, 0]), 'Ctrl+Z puts it back');
  }
});

// ---------- text: the Type tool and Korean through the IME ----------
await section('text', async () => {
  await js(`__tl.fresh({ clips: [{ media: 0, at: 0, len: 10 * ${T} }] })`);
  await js(`__tl.app().setTime(1 * ${T})`);
  await sleep(300);
  await focusTimeline();
  await press('t');
  check((await js('__tl.app().tool')) === 'text', 'T picks the Type tool');
  const program = await js(`__tl.rect('.cut-panel[data-panel="program"] canvas.cut-monitor-canvas')`);
  const before = await steps();
  await clickAt({ x: program.x, y: program.y + program.h * 0.25 });
  await until(`document.activeElement?.classList.contains('cut-ov-edit')`, 'the in-place text editor has the keyboard', 5000).catch(() => {});
  check(await js(`document.activeElement?.classList.contains('cut-ov-edit')`), 'a click with the Type tool opens a text editor on the monitor');
  const textClip = () => js(`(() => { const c = __tl.seq().clips.find((x) => x.source?.generator === 'text'); return c ? { id: c.id, text: c.source.layers[0].text, track: c.track, start: c.start / ${T}, pos: c.source.layers[0].position } : null; })()`);
  let tc = await textClip();
  check(!!tc && tc.track === 'V2' && near(tc.start, 1), `the text clip goes on the first free track above the video, at the playhead (${S(tc)})`);
  check(tc && tc.pos[1] > 200 && tc.pos[1] < 340 && Math.abs(tc.pos[0]) < 4, `its layer sits where the monitor was clicked (${S(tc?.pos)})`);
  for (const s of ['ㅎ', '하', '한']) { await cdp('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length }); await sleep(40); }
  tc = await textClip();
  check(tc?.text === '한', `the composing syllable shows in the layer at once (${S(tc?.text)})`);
  check((await steps()) === before && (await js('Cut.ui.typing')) === true, 'nothing is recorded while composing, and the keys are held back');
  await cdp('Input.insertText', { text: '한' });
  for (const s of ['ㄱ', '그', '글']) { await cdp('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length }); await sleep(40); }
  await cdp('Input.insertText', { text: '글' });
  await sleep(100);
  tc = await textClip();
  check(tc?.text === '한글', `Korean typed through the IME is the layer's text (${S(tc?.text)})`);
  check((await steps()) === before, 'still no undo step while the editor is open');
  await press('Escape');
  await sleep(150);
  check((await steps()) === before + 1 && !(await js('Cut.ui.typing')), 'closing the editor makes one undo step and frees the keys');
  check((await js('__tl.app().tool')) === 'select', 'the Type tool hands back to the selection tool');
  await shot('text-ime-dark.png');
  // edit it again: a double click on the frame, Latin and Hangul, one step
  const g = await until(`!!Cut.ui.overlay.active?.geometry`, 'handles on the text', 5000).then(() => js(`(() => { const g = Cut.ui.overlay.active.geometry; const v = document.querySelector('.cut-panel[data-panel="program"] .cut-ov').getBoundingClientRect(); return { x: (g.corners[0][0] + g.corners[2][0]) / 2 + v.left, y: (g.corners[0][1] + g.corners[2][1]) / 2 + v.top }; })()`)).catch(() => null);
  if (g) {
    await clickAt(g, { count: 2 });
    await until(`document.activeElement?.classList.contains('cut-ov-edit')`, 'the editor again', 5000).catch(() => {});
    await cdp('Input.insertText', { text: ' 1' });
    await press('Escape');
    await sleep(150);
    tc = await textClip();
    check(tc?.text === '한글 1' && (await steps()) === before + 2, `a double click edits the text again, one more step (${S(tc?.text)})`);
    await focusTimeline();
    await press('Ctrl+z');
    check((await textClip())?.text === '한글', 'Ctrl+Z takes the second edit back');
  }
  await focusTimeline();
  await press('Ctrl+z');
  check(!(await textClip()), 'Ctrl+Z takes the whole new text clip back');
  await press('Ctrl+Shift+z');
  check((await textClip())?.text === '한글', 'redo brings it back with its text');

  // the text panel: a motion preset and a font
  await js(`Cut.ui.setWorkspace('captions')`);
  await sleep(400);
  await js(`Cut.app.select([__tl.seq().clips.find((x) => x.source?.generator === 'text').id])`);
  await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="text"]')`));
  await sleep(300);
  await js(`document.querySelector('.cut-text-preset-in-fade')?.scrollIntoView({ block: 'center' })`);
  await sleep(100);
  const presetBtn = await js(`!document.querySelector('.cut-text-form').hidden && __tl.rect('.cut-text-preset-in-fade')`);
  check(!!presetBtn && presetBtn.w > 0, 'the text panel shows the selected text clip with its motion presets');
  if (presetBtn) {
    await clickAt(presetBtn);
    const keys = await js(`Object.keys(__tl.seq().clips.find((x) => x.source?.generator === 'text').keyframes)`);
    check(keys.some((k) => /^layers\.l1\.opacity$/.test(k)), `the Fade In preset makes opacity keyframes on the layer (${S(keys)})`);
    await press('Ctrl+z');
  }
  const fonts = await js(`document.querySelectorAll('.cut-text-family option').length`);
  check(fonts > 0, `the font list comes from cut:fonts (${fonts} entries)`);
  await js(`Cut.ui.setWorkspace('editing')`);
  await sleep(300);
});

// ---------- 500 clips ----------
await section('perf', async () => {
  await js(`(() => {
    const C = Cut.commands, M = Cut.model, T = Cut.time.TICKS;
    const p = M.createProject({ sequence: { fps: [30, 1], w: 1920, h: 1080 } });
    const h0 = C.createHistory(p);
    const mid = h0.do(C.importMedia([__tl.media('long', { duration: 3600 * T })])).ids[0];
    const seq = h0.project.sequences[0];
    let n = 0;
    for (const [v, a] of [['V1', 'A1'], ['V2', 'A2']]) {
      for (let i = 0; i < 125; i++) {
        const start = i * 2 * T + (v === 'V2' ? T : 0);
        const link = 'L' + h0.project.nextId++;
        for (const [tk, kind] of [[v, 'video'], [a, 'audio']]) {
          const c = M.createClip(kind, { id: 'c' + h0.project.nextId++, track: tk, start, in: i * 2 * T, out: i * 2 * T + 2 * T, source: { media: mid }, name: 'clip ' + (++n) });
          c.link = link;
          seq.clips.push(c);
        }
      }
    }
    const v = M.validate(h0.project);
    if (!v.ok) throw new Error(v.errors.join('; '));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h0.project))), null, 'open');
    return seq.clips.length;
  })()`);
  check((await js('__tl.seq().clips.length')) === 500, 'a sequence of 500 clips');
  await sleep(500);
  await js('__tl.view(12)');
  await sleep(300);
  // scroll: 40 wheel steps sideways, timing each frame
  await js(`(() => { const s = Cut.ui.timeline.stats; s.base.length = 0; s.top.length = 0; window.__frames = []; const tick = (t) => { window.__frames.push(t); if (window.__frames.length < 400 && window.__recording) requestAnimationFrame(tick); }; window.__recording = true; requestAnimationFrame(tick); })()`);
  const area = await pt(30, 'V1', 0.5);
  for (let i = 0; i < 40; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: area.x, y: area.y, deltaX: 0, deltaY: 120, modifiers: MOD.Shift });
    await sleep(16);
  }
  await sleep(200);
  const scroll = await js(`(() => { window.__recording = false; const f = window.__frames; const d = f.slice(1).map((t, i) => t - f[i]); const s = Cut.ui.timeline.stats; const sorted = (a) => a.slice().sort((x, y) => x - y); const q = (a, p) => a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
    return { scrolled: Cut.ui.timeline.view.scrollX, draws: s.base.length, drawMedian: q(s.base, 0.5), drawP95: q(s.base, 0.95), frameMedian: q(d, 0.5), frameP95: q(d, 0.95) }; })()`);
  log(`  scroll: ${S(scroll)}`);
  check(scroll.scrolled > 100 && scroll.draws > 5, `wheel scrolling moves the 500-clip timeline (${scroll.scrolled.toFixed(0)} px, ${scroll.draws} redraws)`);
  check(scroll.drawP95 < 16, `a redraw of the visible clips takes under 16 ms at the 95th percentile (median ${scroll.drawMedian.toFixed(2)} ms, p95 ${scroll.drawP95.toFixed(2)} ms)`);
  // drag one clip across the view
  await js('__tl.view(12)');
  await sleep(200);
  await js(`(() => { const s = Cut.ui.timeline.stats; s.base.length = 0; s.top.length = 0; window.__frames = []; window.__recording = true; const tick = (t) => { window.__frames.push(t); if (window.__recording) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  const from = await pt(41, 'V1');
  const to = await pt(61, 'V1');
  const t0 = Date.now();
  await drag(from, to, { steps: 40, pause: 16 });
  const dragMs = Date.now() - t0;
  const dr = await js(`(() => { window.__recording = false; const f = window.__frames; const d = f.slice(1).map((t, i) => t - f[i]); const s = Cut.ui.timeline.stats; const sorted = (a) => a.slice().sort((x, y) => x - y); const q = (a, p) => a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
    return { topDraws: s.top.length, topP95: q(s.top, 0.95), baseDraws: s.base.length, frameMedian: q(d, 0.5), frameP95: q(d, 0.95), frames: f.length }; })()`);
  log(`  drag: ${S(dr)} in ${dragMs} ms`);
  const moved = await js(`__tl.seq().clips.filter((c) => c.start === 60 * ${T} && c.track === 'V1').length`);
  check(moved === 1, 'the dragged clip lands 20 s later, overwriting what was there');
  check(dr.topP95 < 8 && dr.frameMedian < 34, `a drag over 500 clips stays at frame rate (ghost layer p95 ${dr.topP95.toFixed(2)} ms, frame median ${dr.frameMedian.toFixed(1)} ms, p95 ${dr.frameP95.toFixed(1)} ms)`);
  await press('Ctrl+z');

  // more video clips on screen than the thumbnail cache holds (500): once each has asked, the timeline rests.
  // A real file (a missing one is offline and asks for none); each clip starts a frame later in it, so each has its own strip; 90 a track keeps each over 8 px on an 810 px timeline.
  const manyFile = path.join(home, 'many.mp4');
  check((await js(`Cut.testsrc.write(${S(manyFile)}, { seconds: 33, fps: [30, 1], w: 160, h: 90, audio: false }).then((r) => r.ok)`)) === true, 'a 33 s test source for the thumbnails');
  const many = await js(`(async () => {
    const C = Cut.commands, M = Cut.model, T = Cut.time.TICKS, F = T / 30;
    const h0 = C.createHistory(M.createProject({ sequence: { fps: [30, 1], w: 1920, h: 1080, videoTracks: 6, audioTracks: 0 } }));
    const list = await Cut.media.importFiles([${S(manyFile)}]);
    const mid = h0.do(C.importMedia(list)).ids[0];
    const seq = h0.project.sequences[0];
    let k = 0;
    for (const tk of seq.tracks) {
      tk.height = 32;
      for (let i = 0; i < 90; i++, k++) seq.clips.push(M.createClip('video', { id: 'c' + h0.project.nextId++, track: tk.id, start: i * 2 * T, in: k * F, out: k * F + 2 * T, source: { media: mid }, name: 'm' + i }));
    }
    const v = M.validate(h0.project);
    if (!v.ok) throw new Error(v.errors.slice(0, 3).join('; '));
    const orig = Cut.thumbs.strip;
    let asked = 0;
    Cut.thumbs.strip = (...a) => { asked++; return orig(...a); };
    try {
      Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h0.project))), null, 'open');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tl = __tl.tl();
      tl.setZoom((tl.root.querySelector('.cut-tl-scroll').clientWidth - 10) / 180, { t: 0, x: 0 });
      tl.setScroll(0, 0);
      // until the requests stop (each strip decodes; before the fix they never stopped)
      const t0 = performance.now();
      for (let last = -1, still = 0; still < 4 && performance.now() - t0 < 120000; ) {
        await new Promise((r) => setTimeout(r, 500));
        still = asked === last ? still + 1 : 0;
        last = asked;
      }
      const s = Cut.ui.timeline.stats;
      s.base.length = 0;
      const before = asked;
      await new Promise((r) => setTimeout(r, 2000));
      const box = tl.root.querySelector('.cut-tl-scroll');
      return { clips: seq.clips.length, view: [box.clientWidth, box.clientHeight], asked: before, seconds: Math.round((performance.now() - t0) / 1000), askedAfter: asked - before, draws: s.base.length };
    } finally { Cut.thumbs.strip = orig; }
  })()`);
  check(many.asked > 500 && many.asked <= 600 && many.askedAfter === 0 && many.draws <= 1, `${many.clips} video clips on screen ask for their thumbnails once each, then the timeline stops redrawing (${S(many)})`);
});

// ---------- screenshots in both themes ----------
await section('shots', async () => {
  await js(`(async () => {
    await __tl.fresh({ clips: [{ media: 0, at: 0, len: 6 * ${T} }, { media: 1, at: 6 * ${T}, len: 8 * ${T} }] });
    const C = Cut.commands, s = __tl.seq(), h = Cut.app.history;
    const a = s.clips.find((c) => c.track === 'V1' && c.start === 0);
    h.do(C.addTransition(s.id, { track: 'V1', at: 6 * ${T}, type: 'dissolve', align: 'center' }));
    h.do(C.addGenerated(s.id, { track: 'V2', at: 2 * ${T}, duration: 4 * ${T}, source: { generator: 'text', layers: [{ text: '제목 Title' }] } }));
    h.do(C.setKeyframes(s.id, s.clips.find((c) => c.track === 'A1' && c.start === 0).id, 'volume', [{ t: 0, v: -30 }, { t: 2 * ${T}, v: 0 }, { t: 5 * ${T}, v: -6 }]));
    h.do(C.addMarker(s.id, { t: 3 * ${T}, name: 'Intro', kind: 'chapter', color: 'yellow' }));
    Cut.app.setInOut({ in: 1 * ${T}, out: 11 * ${T} });
    Cut.app.select([a.id]);
    Cut.app.setTime(4 * ${T});
    return true;
  })()`);
  await js('__tl.view(70)');
  await clickAt(await js(`__tl.rect('.cut-slot-tab[data-panel="controls"]')`));
  await sleep(800);
  log(`  saved ${await shot('timeline-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(800);
  log(`  saved ${await shot('timeline-light.png')}`);
  await js(`Cut.ui.setWorkspace('color')`);
  await sleep(600);
  log(`  saved ${await shot('color-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  await sleep(600);
  log(`  saved ${await shot('color-dark.png')}`);
  await js(`Cut.ui.setWorkspace('editing')`);
  check(true, 'screenshots saved');
});

async function shot(name) {
  return ctx.shot(name);
}
function wavBytes(seconds, hz) {
  const rate = 48000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const env = 0.2 + 0.8 * Math.abs(Math.sin((Math.PI * i) / rate));
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.7 * env * 32767);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  return buf;
}

ctx.finish();
