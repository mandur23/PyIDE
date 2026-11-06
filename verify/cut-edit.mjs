// Nano Studio Cut's editing keys and tools in the real app (features §6 and §18 [2]): every check presses the real key
// (Input.dispatchKeyEvent) or drags with real mouse events (Input.dispatchMouseEvent) and reads the clip ranges the
// project then holds, one undo step each, undone with Ctrl+Z. Checks:
// - the keys are IDE actions Cut.<id> (Find Action runs one), none taken by another Cut action, the tool bar has the
//   new tools with icons and key hints;
// - Lift (;) and Extract (') of the In-Out range on the targeted tracks, a locked track left alone;
// - Paste Insert (Ctrl+Shift+V) pushes later clips; nudge (Alt+Left/Right, with Shift five frames) with links, a
//   locked track and overwriting like a drag;
// - groups (Ctrl+G, Ctrl+Shift+G): click selects the group, Alt-click one member, drag, Delete and nudge move them all;
// - Select Clip at Playhead (D) on the targeted tracks; Extend Edit (E) rolls or trims to the playhead;
// - Rate Stretch (R) drags an end and changes the speed; Slip (Y) with the first and last frames in the program
//   monitor, stopping at the source start; Slide (U) trims the neighbours; Pen (P) adds keyframes on the volume and
//   opacity lines;
// - Match Frame (F) opens the source at the same frame with the clip's In/Out.
// Usage: node verify/cut-edit.mjs   (CUT_EDIT_ONLY=keys,lift,paste,nudge,groups,select,extend,rate,slip,slide,pen,match)
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_EDIT_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-edit-home');
const ctx = await launch({ fixture: 'core', port: 9759, name: 'cut-edit', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const F = T / 30;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'testsrc', 'compositor'].every((k) => !!Cut[k]) && !!Cut.ui.timeline && !!Cut.ui.monitors && typeof Cut.commands.slip === 'function'`), 'the modules this suite uses are loaded');

// ---------- page helpers ----------
await js(`(() => {
  const T = Cut.time.TICKS;
  const H = (window.__ed = {});
  H.seq = () => Cut.app.sequence;
  H.media = (id, opts = {}) => ({ path: 'C:\\\\nowhere\\\\' + id + '.mp4', name: id + '.mp4', kind: 'video', size: 1000, mtime: 1, duration: opts.duration ?? 120 * T,
    video: { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 }, audio: opts.audio === false ? null : { rate: 48000, channels: 2 } });
  // A fresh 1080p30 project: the media given, clips [{media, at, len, in, video, audio}] (seconds); no undo steps.
  H.fresh = async (spec = {}) => {
    const C = Cut.commands;
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: spec.w ?? 1920, h: spec.h ?? 1080 } });
    const h = C.createHistory(p);
    Cut.app.setHistory(h, null, 'open');
    const seq = Cut.app.sequence;
    const ids = h.do(C.importMedia(spec.media || [H.media('a'), H.media('b')])).ids;
    for (const c of spec.clips || []) h.do(C.place(seq.id, { source: { media: ids[c.media ?? 0] }, in: (c.in ?? 0) * T, out: ((c.in ?? 0) + c.len) * T, at: c.at * T, video: c.video ?? 'V1', audio: c.audio === undefined ? 'A1' : c.audio }));
    for (const [id, height] of Object.entries(spec.heights || {})) h.do(C.setTrack(seq.id, id, { height }));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
    Cut.ui.setSnapping(Cut.app, true);
    Cut.ui.setTargets(Cut.app, null);
    Cut.app.setTool('select');
    Cut.app.setInOut({ in: null, out: null });
    // the playhead out of the way first: moving it off screen scrolls the view
    Cut.app.setTime(60 * T);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tl = Cut.ui.timeline;
    tl.setZoom(H.pps(), { t: 0, x: 0 });
    tl.setScroll(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { media: ids };
  };
  // "V1:0-10[0]" per clip (seconds, in in brackets), sorted
  H.lay = (track) => H.seq().clips.filter((c) => !track || c.track === track).sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start)
    .map((c) => c.track + ':' + +(c.start / T).toFixed(3) + '-' + +(Cut.model.clipEnd(c) / T).toFixed(3) + '[' + +(c.in / T).toFixed(3) + ']').join(' ');
  H.at = (track, sec) => H.seq().clips.find((c) => c.track === track && c.start <= sec * T + 1 && sec * T < Cut.model.clipEnd(c)) || null;
  H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
  H.label = () => Cut.app.history.list().filter((x) => x.done).at(-1)?.label;
  H.pps = () => (Cut.ui.timeline.root.querySelector('.cut-tl-scroll').clientWidth >= 820 ? 25 : 20);
  H.pt = (t, track, dy = 0.55) => { const p = Cut.ui.timeline.clientPoint(t * T, track, dy); return { x: p.x, y: Math.round(p.y) }; };
  // the client point of a clip's keyframe line at t: the middle of the heights the hit test calls 'band'
  H.band = (t, track) => {
    const tl = Cut.ui.timeline, box = tl.root.querySelector('.cut-tl-scroll').getBoundingClientRect(), r = tl.rowOf(track);
    const x = tl.xOf(t * T);
    const ys = [];
    for (let y = r.y; y < r.y + r.h; y++) if (tl.hit(x, y).part === 'band') ys.push(y);
    return ys.length ? { x: box.left + x, y: box.top + (ys[0] + ys[ys.length - 1]) / 2 } : null;
  };
  H.sel = () => [...Cut.app.selection].map((id) => { const c = H.seq().clips.find((x) => x.id === id); return c ? c.track + '@' + +(c.start / T).toFixed(3) : id; }).sort().join(' ');
  H.headButton = (track, cls) => { const n = document.querySelector('.cut-tl-head[data-track="' + track + '"] .cut-tl-hb.' + cls); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
const MOD = { Alt: 1, Ctrl: 2, Shift: 8 };
const mods = (list = []) => list.reduce((m, k) => m | MOD[k], 0);
async function clickAt(p, { modifiers = [], button = 'left' } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers: m });
  await mouse('mousePressed', p.x, p.y, { modifiers: m, button, buttons: button === 'right' ? 2 : 1 });
  await mouse('mouseReleased', p.x, p.y, { modifiers: m, button, buttons: 0 });
  await sleep(90);
}
// hold: called while the button is still down at the end point (to look at the program monitor mid-drag)
async function drag(a, b, { modifiers = [], steps = 10, pause = 20, hold = null } = {}) {
  const m = mods(modifiers);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0, modifiers: m });
  await mouse('mousePressed', a.x, a.y, { modifiers: m });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { modifiers: m });
    await sleep(pause);
  }
  await sleep(80);
  const held = hold ? await hold() : null;
  await mouse('mouseReleased', b.x, b.y, { modifiers: m });
  await sleep(150);
  return held;
}
const pt = (t, track, dy) => js(`__ed.pt(${t}, ${S(track)}, ${dy ?? 0.55})`);
const lay = (track) => js(`__ed.lay(${track ? S(track) : ''})`);
const steps = () => js('__ed.steps()');
const label = () => js('__ed.label()');
const fresh = (spec) => js(`__ed.fresh(${S(spec)})`);
const setTime = (sec) => js(`(Cut.app.setTime(${sec} * ${T}), true)`);
async function focusTimeline() {
  // an empty spot of the lanes on V2 (a click that missed the timeline is made once more, as lib.mjs click() does)
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
async function undo(n = 1) {
  for (let i = 0; i < n; i++) await press('Ctrl+z');
  await sleep(80);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
}
await js(`Cut.ui.setWorkspace('editing')`);
await sleep(400);

// c1 a 0..10 s and c2 b 10..20 s on V1 with linked audio on A1
const TWO = { clips: [{ media: 0, at: 0, len: 10 }, { media: 1, at: 10, len: 10 }] };
const START = 'A1:0-10[0] A1:10-20[0] V1:0-10[0] V1:10-20[0]';

// ---------- the keys, Find Action and the tool bar ----------
await section('keys', async () => {
  const KEYS = {
    lift: [';'], extract: ["'"], pasteInsert: ['Ctrl+Shift+V'], nudgeLeft: ['Alt+ArrowLeft'], nudgeRight: ['Alt+ArrowRight'],
    nudgeLeft5: ['Alt+Shift+ArrowLeft'], nudgeRight5: ['Alt+Shift+ArrowRight'], group: ['Ctrl+G'], ungroup: ['Ctrl+Shift+G'],
    selectAtPlayhead: ['D'], matchFrame: ['F'], extendEdit: ['E'], 'tool.rate': ['R'], 'tool.slip': ['Y'], 'tool.slide': ['U'], 'tool.pen': ['P'],
  };
  const info = await js(`(() => {
    const want = ${S(KEYS)};
    const out = {};
    for (const [id, keys] of Object.entries(want)) {
      const a = ide.actions.find((x) => x.id === 'Cut.' + id);
      const others = ide.actions.filter((x) => x.id !== 'Cut.' + id && x.keys.some((k) => keys.includes(k))).map((x) => x.id);
      out[id] = { keys: a?.keys || null, title: a?.title || null, others };
    }
    return out;
  })()`);
  const bad = Object.entries(KEYS).filter(([id, keys]) => S(info[id].keys) !== S(keys) || !info[id].title);
  check(!bad.length, `every new key is the IDE action Cut.<id> with its key and a title (${bad.map(([id]) => `${id}: ${S(info[id])}`).join('; ') || 'all'})`);
  const cutClash = Object.entries(info).filter(([, x]) => x.others.some((o) => o.startsWith('Cut.')));
  check(!cutClash.length, `no other Cut action has one of the new keys (${cutClash.map(([id, x]) => `${id}: ${x.others}`).join('; ') || 'none'})`);
  const ideKeys = Object.entries(info).filter(([, x]) => x.others.length).map(([id, x]) => `${id}: ${x.others.join(',')}`);
  log(`  IDE actions sharing a new key in this window: ${ideKeys.join('; ') || 'none'}`);
  check(ideKeys.every((s) => /^(nudge(Left|Right): (PreviousTab|NextTab)|group: GotoLine)$/.test(s)), `only the code editor's Previous/Next Tab (Alt+Left/Right) and Go to Line (Ctrl+G) share a key; Cut has no code editor and its actions come first (${ideKeys.join('; ') || 'none'})`);

  await fresh(TWO);
  await focusTimeline();
  for (const [k, tool] of [['r', 'rate'], ['y', 'slip'], ['u', 'slide'], ['p', 'pen'], ['v', 'select']]) {
    await press(k);
    check((await js('Cut.app.tool')) === tool, `${k.toUpperCase()} picks the ${tool} tool`);
  }
  const bar = await js(`['rate', 'slip', 'slide', 'pen'].map((id) => { const b = document.querySelector('.cut-tl-tool[data-tool="' + id + '"]'); return b ? { svg: !!b.querySelector('svg path'), title: b.title } : null; })`);
  check(bar.every((b) => b?.svg) && bar.map((b) => b.title.slice(-3)).join() === '(R),(Y),(U),(P)', `the tool bar has Rate Stretch, Slip, Slide and Pen with icons and keys (${S(bar)})`);
  const order = await js(`[...document.querySelectorAll('.cut-tl-tool')].map((b) => b.dataset.tool).join()`);
  check(order === 'select,trackForward,trackBackward,ripple,roll,rate,razor,slip,slide,pen,hand,zoom,text', `the tools are in the order of the design table (${order})`);
  await clickAt(await js(`(() => { const r = document.querySelector('.cut-tl-tool[data-tool="pen"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  const pen = await js(`[Cut.app.tool, document.querySelector('.cut-tl-tool[data-tool="pen"]').getAttribute('aria-pressed'), Cut.ui.timeline.root.querySelector('.cut-tl-scroll').style.cursor]`);
  check(pen[0] === 'pen' && pen[1] === 'true' && pen[2] === 'cell', `the Pen button picks the tool, shows it pressed and sets its cursor (${S(pen)})`);
  await js(`Cut.app.setTool('select')`);

  // Find Action runs one of them: Select Clip at Playhead at 5 s
  await focusTimeline();
  await setTime(5);
  await press('Ctrl+Shift+A');
  await until(`document.querySelector('#popup:not(.hidden)')`, 'Find Action');
  await ctx.type(await js(`ide.actions.find((a) => a.id === 'Cut.selectAtPlayhead').title`));
  await until(`[...document.querySelectorAll('#popupList .popup-item')].some((n) => n.textContent.includes(ide.actions.find((a) => a.id === 'Cut.selectAtPlayhead').title))`, 'the action in Find Action');
  await press('Enter');
  await sleep(200);
  check((await js('__ed.sel()')) === 'A1@0 V1@0', `Find Action runs Select Clip at Playhead (${await js('__ed.sel()')})`);
});

// ---------- Lift and Extract ----------
await section('lift', async () => {
  await fresh(TWO);
  await focusTimeline();
  await setTime(2);
  await press('i');
  await setTime(5 - 1 / 30);
  await press('o');
  check(S(await js(`[Cut.app.inOut.in / ${T}, Cut.app.inOut.out / ${T}]`)) === S([2, 5]), 'I and O mark 2 s to 5 s');
  let before = await steps();
  await press(';');
  let now = await lay();
  check(now === 'A1:0-2[0] A1:5-10[5] A1:10-20[0] V1:0-2[0] V1:5-10[5] V1:10-20[0]', `; lifts 2-5 s off every track, leaving a gap (${now})`);
  check((await steps()) === before + 1 && (await label()) === 'Lift', 'one undo step named Lift');
  check(S(await js(`[Cut.app.t / ${T}, Cut.app.inOut.in, Cut.app.inOut.out]`)) === S([2, null, null]), 'the playhead goes to the In and the In/Out is cleared');
  await undo();
  check((await lay()) === START, 'Ctrl+Z puts the lifted range back');

  await js(`Cut.app.setInOut({ in: 2 * ${T}, out: 5 * ${T} })`);
  await press("'");
  now = await lay();
  check(now === 'A1:0-2[0] A1:2-7[5] A1:7-17[0] V1:0-2[0] V1:2-7[5] V1:7-17[0]', `' extracts 2-5 s and closes the gap (${now})`);
  check((await label()) === 'Extract', 'the step is named Extract');
  await undo();
  check((await lay()) === START, 'Ctrl+Z undoes the extract');

  // only V1 targeted: lift leaves A1 alone; extract still pulls the sync-locked A1 along
  await clickAt(await js(`__ed.headButton('A1', 'target')`));
  await clickAt(await js(`__ed.headButton('V2', 'target')`));
  await clickAt(await js(`__ed.headButton('A2', 'target')`));
  check(S(await js('Cut.ui.editing.targets')) === S(['V1']), 'the track headers target V1 only');
  await focusTimeline();
  await js(`Cut.app.setInOut({ in: 2 * ${T}, out: 5 * ${T} })`);
  await press(';');
  now = await lay();
  check(now === 'A1:0-10[0] A1:10-20[0] V1:0-2[0] V1:5-10[5] V1:10-20[0]', `lift takes the range off the targeted track only (${now})`);
  await undo();
  await js(`Cut.app.setInOut({ in: 2 * ${T}, out: 5 * ${T} })`);
  await press("'");
  now = await lay();
  check(now === 'A1:0-2[0] A1:2-7[5] A1:7-17[0] V1:0-2[0] V1:2-7[5] V1:7-17[0]', `extract on V1 keeps the sync-locked A1 in step (${now})`);
  await undo();
  await js(`Cut.ui.setTargets(Cut.app, null)`);

  // a locked track keeps its clips
  await clickAt(await js(`__ed.headButton('A1', 'lock')`));
  await focusTimeline();
  await js(`Cut.app.setInOut({ in: 2 * ${T}, out: 5 * ${T} })`);
  before = await steps();
  await press("'");
  now = await lay();
  check(now.startsWith('A1:0-10[0] A1:10-20[0] V1:0-2[0] V1:2-7[5]'), `extract leaves the locked A1 as it was (${now})`);
  await undo(2);
  check((await lay()) === START && (await steps()) === before - 1, 'undo takes back the extract and the lock');
  // nothing marked: a message, no step
  before = await steps();
  await press(';');
  check((await steps()) === before && (await lay()) === START, 'with no In or Out, ; changes nothing');
});

// ---------- Paste Insert ----------
await section('paste', async () => {
  await fresh(TWO);
  await clickAt(await pt(5, 'V1'));
  check((await js('__ed.sel()')) === 'A1@0 V1@0', 'a click selects c1 and its linked audio');
  await press('Ctrl+c');
  await setTime(15);
  const before = await steps();
  await press('Ctrl+Shift+v');
  const now = await lay();
  check(now === 'A1:0-10[0] A1:10-15[0] A1:15-25[0] A1:25-30[5] V1:0-10[0] V1:10-15[0] V1:15-25[0] V1:25-30[5]', `Ctrl+Shift+V pastes at the playhead and pushes the rest of c2 later (${now})`);
  check((await steps()) === before + 1 && (await label()) === 'Paste Insert', 'one undo step named Paste Insert');
  await undo();
  check((await lay()) === START, 'Ctrl+Z undoes the paste insert');
});

// ---------- nudge ----------
await section('nudge', async () => {
  await fresh(TWO);
  await clickAt(await pt(15, 'V1'));
  let before = await steps();
  await press('Alt+ArrowRight');
  let now = await lay();
  check(now === 'A1:0-10[0] A1:10.033-20.033[0] V1:0-10[0] V1:10.033-20.033[0]', `Alt+Right moves c2 and its linked audio one frame later (${now})`);
  await press('Alt+ArrowRight');
  check((await steps()) === before + 2 && (await label()) === 'Nudge', 'each press is one undo step named Nudge');
  await press('Alt+Shift+ArrowLeft');
  now = await lay();
  check(now === 'A1:0-9.9[0] A1:9.9-19.9[0] V1:0-9.9[0] V1:9.9-19.9[0]', `Alt+Shift+Left moves it five frames earlier, over the end of c1 as a drag would (${now})`);
  await undo(3);
  check((await lay()) === START, 'three Ctrl+Z put it back');
  check(await js(`Cut.app.t === 60 * ${T}`), 'the playhead did not move');
  // Alt-click selects the video alone: the audio stays
  await clickAt(await pt(15, 'V1'), { modifiers: ['Alt'] });
  await press('Alt+ArrowLeft');
  now = await lay();
  check(now === 'A1:0-10[0] A1:10-20[0] V1:0-9.967[0] V1:9.967-19.967[0]', `after an Alt-click only the video moves (${now})`);
  await undo();
  // a locked track refuses the move
  await clickAt(await js(`__ed.headButton('A1', 'lock')`));
  await clickAt(await pt(15, 'V1'));
  before = await steps();
  await press('Alt+ArrowRight');
  check((await steps()) === before && (await lay()) === START, 'with the linked audio on a locked track the nudge changes nothing');
  await undo();
});

// ---------- groups ----------
await section('groups', async () => {
  // c1 on V1 + A1, x on V2 at 12-15 s (no audio), y on V2 at 25-28 s
  await fresh({ clips: [{ media: 0, at: 0, len: 10 }, { media: 1, at: 12, len: 3, video: 'V2', audio: null }, { media: 1, at: 25, in: 5, len: 3, video: 'V2', audio: null }] });
  await clickAt(await pt(5, 'V1'));
  await clickAt(await pt(13, 'V2'), { modifiers: ['Shift'] });
  const picked = await js('__ed.sel()');
  let before = await steps();
  await press('Ctrl+g');
  const g = await js(`__ed.seq().clips.map((c) => c.group)`);
  check(g[0] && g[0] === g[2] && g[1] === g[0] && g[3] === null, `Ctrl+G puts the selected clips (${picked}) in one group (${S(g)}; focus ${await js('Cut.app.focusPanel')})`);
  check((await steps()) === before + 1 && (await label()) === 'Group', 'one undo step named Group');
  await focusTimeline();
  await clickAt(await pt(13, 'V2'));
  check((await js('__ed.sel()')) === 'A1@0 V1@0 V2@12', `a click on one member selects the group and its links (${await js('__ed.sel()')})`);
  await drag(await pt(13, 'V2'), await pt(15, 'V2'));
  let now = await lay();
  check(now === 'A1:2-12[0] V1:2-12[0] V2:14-17[0] V2:25-28[5]', `dragging a member moves the whole group (${now})`);
  await undo();
  await press('Alt+ArrowRight');
  now = await lay();
  check(now === 'A1:0.033-10.033[0] V1:0.033-10.033[0] V2:12.033-15.033[0] V2:25-28[5]', `a nudge moves the group (${now})`);
  await undo();
  await clickAt(await pt(13, 'V2'), { modifiers: ['Alt'] });
  check((await js('__ed.sel()')) === 'V2@12', 'Alt-click selects one member');
  await press('Delete');
  now = await lay();
  check(now === 'A1:0-10[0] V1:0-10[0] V2:25-28[5]', `Delete after an Alt-click removes that member only (${now})`);
  await undo();
  await clickAt(await pt(13, 'V2'));
  await press('Delete');
  check((await lay()) === 'V2:25-28[5]', `Delete on a group removes every member (${await lay()})`);
  await undo();
  await clickAt(await pt(13, 'V2'));
  before = await steps();
  await press('Ctrl+Shift+g');
  check(S(await js(`__ed.seq().clips.map((c) => c.group)`)) === S([null, null, null, null]) && (await label()) === 'Ungroup', 'Ctrl+Shift+G ungroups every member, one step');
  await focusTimeline();
  await clickAt(await pt(13, 'V2'));
  check((await js('__ed.sel()')) === 'V2@12', 'after ungrouping a click selects that clip alone');
  await undo(2);
  check((await lay()) === 'A1:0-10[0] V1:0-10[0] V2:12-15[0] V2:25-28[5]' && S(await js(`__ed.seq().clips.map((c) => c.group)`)) === S([null, null, null, null]), 'undo takes the group away again');
});

// ---------- Select Clip at Playhead ----------
await section('select', async () => {
  await fresh({ clips: [{ media: 0, at: 0, len: 10 }, { media: 1, at: 4, len: 3, video: 'V2', audio: null }] });
  await focusTimeline();
  await setTime(5);
  await press('d');
  check((await js('__ed.sel()')) === 'A1@0 V1@0 V2@4', `D selects the clips under the playhead on every track (${await js('__ed.sel()')})`);
  await js(`Cut.ui.setTargets(Cut.app, ['V2'])`);
  await press('d');
  check((await js('__ed.sel()')) === 'V2@4', `with V2 targeted, D selects the clip on V2 only (${await js('__ed.sel()')})`);
  await setTime(8);
  await press('d');
  check((await js('__ed.sel()')) === '', 'where the targeted track is empty, D selects nothing');
  await js(`Cut.ui.setTargets(Cut.app, null)`);
});

// ---------- Extend Edit ----------
await section('extend', async () => {
  await fresh(TWO);
  await focusTimeline();
  await setTime(12);
  let before = await steps();
  await press('e');
  let now = await lay();
  check(now === 'A1:0-12[0] A1:12-20[2] V1:0-12[0] V1:12-20[2]', `E rolls the nearest edit point to the playhead (${now})`);
  check((await steps()) === before + 1 && (await label()) === 'Extend Edit', 'one undo step named Extend Edit');
  await undo();
  await clickAt(await pt(15, 'V1'));
  await setTime(18);
  await press('e');
  now = await lay();
  check(now === 'A1:0-10[0] A1:10-18[0] V1:0-10[0] V1:10-18[0]', `with c2 selected, E trims its nearest end (nothing after it) to the playhead (${now})`);
  await undo();
  check((await lay()) === START, 'Ctrl+Z undoes it');
});

// ---------- Rate Stretch ----------
await section('rate', async () => {
  await fresh({ clips: [{ media: 0, at: 0, in: 2, len: 10 }] });
  await focusTimeline();
  await press('r');
  let before = await steps();
  await drag(await pt(10 - 0.08, 'V1'), await pt(20 - 0.08, 'V1'));
  let now = await lay();
  const sp = await js(`__ed.seq().clips.map((c) => [Math.round(c.speed * 1000) / 1000, c.in / ${T}, c.out / ${T}])`);
  check(now === 'A1:0-20[2] V1:0-20[2]' && S(sp) === S([[0.5, 2, 12], [0.5, 2, 12]]), `the rate stretch tool drags the end to 20 s: speed 50%, source 2-12 s kept, the audio too (${now} ${S(sp)})`);
  check((await steps()) === before + 1 && (await label()) === 'Rate Stretch', 'one undo step named Rate Stretch');
  await undo();
  await drag(await pt(0.08, 'V1'), await pt(5 + 0.08, 'V1'));
  now = await lay();
  const sp2 = await js(`__ed.seq().clips.map((c) => Math.round(c.speed * 1000) / 1000)`);
  check(now === 'A1:5-10[2] V1:5-10[2]' && S(sp2) === S([2, 2]), `dragging the start to 5 s keeps the end and doubles the speed (${now} ${S(sp2)})`);
  await undo();
  check((await lay()) === 'A1:0-10[2] V1:0-10[2]', 'Ctrl+Z undoes it');
  await press('v');
});

// ---------- real media for the monitors ----------
let real = null;
if (want('slip') || want('match')) {
  const mp4 = path.join(home, 'frames.mp4');
  const made = await js(`(async () => {
    try {
      const bytes = await Cut.testsrc.make({ seconds: 6, fps: [30, 1], w: 640, h: 360, audio: false });
      const o = await ide.api.invoke('cut:writeOpen', ${S(mp4)});
      await ide.api.invoke('cut:writeAt', o.id, bytes);
      return (await ide.api.invoke('cut:writeClose', o.id, { commit: true }))?.ok ? 'ok' : 'not written';
    } catch (err) { return String(err?.stack || err); }
  })()`);
  check(made === 'ok', `a 6 s test source is written (${made})`);
  await fresh({ media: [await js(`__ed.media('x')`)] });
  const ids = await js(`Cut.ui.media.importPaths(Cut.app, ${S([mp4])})`);
  real = await js(`(() => { const m = Cut.app.project.media.find((x) => x.id === ${S(ids[0])}); return m ? JSON.parse(JSON.stringify(m)) : null; })()`);
  check(real?.kind === 'video' && real.video?.w === 640, `the test source is imported (${real?.kind}, ${real?.video?.w})`);
}

// ---------- Slip ----------
await section('slip', async () => {
  // the clip at 2-5 s shows source 1-4 s (frames 30-119)
  await fresh({ media: [real], clips: [{ media: 0, at: 2, in: 1, len: 3, audio: null }] });
  await js(`Cut.ui.setWorkspace('editing')`);
  await focusTimeline();
  await press('y');
  const before = await steps();
  const mid = await drag(await pt(3.5, 'V1'), await pt(4, 'V1'), {
    hold: async () => {
      await sleep(700);
      return js(`(async () => { const m = Cut.ui.monitors.program; const tv = m.el.querySelector('.cut-trim-view');
        const px = await m.readTrim();
        const n = (p) => (p ? Cut.testsrc.readFrameNumber(p.px, p.w, p.h) : null);
        const top = (() => { const r = tv.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e?.closest('.cut-trim-view'); })();
        return { shown: !tv.hidden && top, times: m.trimTimes, left: n(px?.[0]), right: n(px?.[1]) }; })()`);
    },
  });
  const now = await lay();
  check(now === 'V1:2-5[0.5]', `dragging right with the slip tool shows source 0.5 s earlier: place and length kept (${now})`);
  check((await steps()) === before + 1 && (await label()) === 'Slip', 'one undo step named Slip');
  check(mid.shown && mid.times && Math.round(mid.times.left / F) === 60 && Math.round(mid.times.right / F) === 149, `while slipping, the program monitor shows the clip's first and last frames (${S(mid)})`);
  check(mid.left === 15 && mid.right === 104, `those frames are the new first and last source frames, 15 and 104 (read ${mid.left}, ${mid.right})`);
  check(await js(`Cut.ui.monitors.program.el.querySelector('.cut-trim-view').hidden`), 'the two-up view goes away on release');
  await undo();
  check((await lay()) === 'V1:2-5[1]', 'Ctrl+Z undoes the slip');
  await drag(await pt(3, 'V1'), await pt(8, 'V1'));
  check((await lay()) === 'V1:2-5[0]', `a slip past the source start stops at its first frame (${await lay()})`);
  await undo();
  await press('v');
});

// ---------- Slide ----------
await section('slide', async () => {
  // p 0-5 s (source 0), q 5-10 s (source 20), r 10-15 s (source 40) on V1, video only
  await fresh({ clips: [{ media: 0, at: 0, in: 0, len: 5, audio: null }, { media: 0, at: 5, in: 20, len: 5, audio: null }, { media: 0, at: 10, in: 40, len: 5, audio: null }] });
  await focusTimeline();
  await press('u');
  const before = await steps();
  await drag(await pt(7, 'V1'), await pt(8, 'V1'));
  let now = await lay();
  check(now === 'V1:0-6[0] V1:6-11[20] V1:11-15[41]', `the slide tool moves q 1 s with its content; p and r trim their touching ends (${now})`);
  check((await steps()) === before + 1 && (await label()) === 'Slide', 'one undo step named Slide');
  await undo();
  await drag(await pt(7, 'V1'), await pt(5, 'V1'));
  now = await lay();
  check(now === 'V1:0-3[0] V1:3-8[20] V1:8-15[38]', `sliding 2 s left lengthens r's head from its source (${now})`);
  await undo();
  check((await lay()) === 'V1:0-5[0] V1:5-10[20] V1:10-15[40]', 'Ctrl+Z undoes it');
  await press('v');
});

// ---------- Pen ----------
await section('pen', async () => {
  await fresh({ clips: [{ media: 0, at: 0, len: 10 }], heights: { V1: 80, A1: 80 } });
  await focusTimeline();
  await press('p');
  const kf = (track, prop) => js(`(__ed.seq().clips.find((c) => c.track === ${S(track)}).keyframes[${S(prop)}] || []).map((k) => [k.t / ${F}, k.v])`);
  const on = await js(`__ed.band(3, 'A1')`);
  check(!!on, 'the volume line of the audio clip is found');
  let before = await steps();
  await clickAt(on);
  check(S(await kf('A1', 'volume')) === S([[90, 0]]), `a pen click on the volume line adds a keyframe at that frame with the line's value (${S(await kf('A1', 'volume'))})`);
  check((await steps()) === before + 1, 'one undo step');
  const above = { ...(await js(`__ed.band(6, 'A1')`)) };
  above.y -= 6;
  await clickAt(above);
  const two = await kf('A1', 'volume');
  check(two.length === 2 && two[1][0] === 180 && two[1][1] > 0, `a click above the line adds a louder keyframe there (${S(two)})`);
  const vline = await js(`__ed.band(4, 'V1')`);
  await clickAt(vline);
  check(S(await kf('V1', 'opacity')) === S([[120, 100]]), `on the video clip it adds an opacity keyframe (${S(await kf('V1', 'opacity'))})`);
  // a pen drag from the line moves the new keyframe
  const from = await js(`__ed.band(8, 'A1')`);
  await drag(from, { x: from.x + (await js('__ed.pps()')), y: from.y + 10 });
  const three = await kf('A1', 'volume');
  check(three.length === 3 && three[2][0] === 270 && three[2][1] < 0, `a pen drag places the new keyframe where it is released (${S(three)})`);
  await undo(4);
  check(S(await kf('A1', 'volume')) === '[]' && S(await kf('V1', 'opacity')) === '[]', 'Ctrl+Z takes the keyframes back one at a time');
  await press('v');
});

// ---------- Match Frame ----------
await section('match', async () => {
  // the clip at 2-5 s shows source 1-4 s
  await fresh({ media: [real], clips: [{ media: 0, at: 2, in: 1, len: 3, audio: null }] });
  await focusTimeline();
  await setTime(3);
  await press('f');
  const src = await js(`Cut.app.source && { media: Cut.app.source.mediaId === __ed.seq().clips[0].source.media, in: Cut.app.source.in / ${T}, out: Cut.app.source.out / ${T} }`);
  check(src?.media && src.in === 1 && src.out === 4, `F opens the clip's source with its In/Out (${S(src)})`);
  await until(`Cut.ui.monitors.source?.app.t === 2 * ${T}`, 'the source monitor at 2 s', 5000).catch(() => {});
  check(await js(`Cut.ui.monitors.source?.app.t === 2 * ${T} && Cut.app.focusPanel === 'source'`), `the source monitor is at the matching source frame, 2 s, and has the keyboard (${await js(`Cut.ui.monitors.source?.app.t / ${T}`)}, ${await js('Cut.app.focusPanel')})`);
  const n = await js(`(async () => {
    const m = Cut.ui.monitors.source;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const comp = m.player?.compositor;
      if (!comp?.readPixels) return null;
      await m.player.render?.(m.app.t);
      const n = Cut.testsrc.readFrameNumber(await comp.readPixels(), comp.width, comp.height);
      if (n === 60) return n;
    }
    return 'other';
  })()`);
  check(n === 60, `the source monitor shows source frame 60 (${n})`);
});

ctx.finish();
