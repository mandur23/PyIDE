// Nano Studio Cut's nested sequences (Premiere's Nest) in the real app, in Korean, with real input events
// (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and the real export:
// - Clip > 중첩… on three clips (two linked video/audio pairs with a dissolve between them and a text clip above): the
//   name dialog ("중첩된 시퀀스 1"), one undo step, one nest clip on V1 and its linked audio on A1, a new sequence in the
//   project panel, the nest clip drawn in the nest color; Ctrl+Z and Ctrl+Shift+Z; the same through Find Action;
// - the program monitor shows the same picture with the nest as with the clips it holds (testsrc frame numbers and
//   pixels, the dissolve included), and the nest clip's opacity applies on top;
// - a double-click on the nest clip opens its sequence in a timeline tab at the frame it shows, and the program
//   monitor's picture there is the nest's;
// - a sequence dragged from the project panel onto another sequence's timeline becomes a nest clip; the same from the
//   source monitor (Open in Source Monitor, then Overwrite);
// - a drop that would nest a sequence in itself is refused with the Korean message and changes nothing;
// - deleting a nested sequence asks first, naming where it is used; Cancel keeps it, Delete takes its nest clips;
// - an export of the outer sequence over the nest and one of the nested sequence give the same frames and samples;
// - screenshots of a nest clip on the timeline in the dark and the light theme (verify/out/cut-nest/*.png).
// Usage: node verify/cut-nest.mjs   (CUT_NEST_ONLY=menu,program,open,drag,source,loop,delete,export,shots)
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_NEST_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-nest-home');
const ctx = await launch({ fixture: 'core', port: 9784, name: 'cut-nest', mode: 'cut', lang: 'ko-KR', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'compositor', 'audioengine', 'export', 'media', 'testsrc', 'decoder'].every((k) => !!Cut[k]) && ['timeline', 'project', 'program', 'source'].every((p) => Cut.ui.panels.has(p)) && !!Cut.ui.menubar`),
  'the modules and panels this suite uses are loaded');

const dirs = await js(`ide.api.invoke('cut:home')`);
const P = (name) => path.join(dirs.projects, name);
const mp4 = P('nest-src.mp4');
const made = await js(`(async () => { const r = await Cut.testsrc.write(${S(mp4)}, { seconds: 8, fps: [30, 1], w: 1280, h: 720, beepEvery: 1 }); return r.ok ? 'ok' : JSON.stringify(r.error); })()`);
check(made === 'ok', `an 8 s 1280x720 test video with beeps is written (${made})`);

// ---------- page helpers ----------
await js(`(() => {
  const H = (window.__ns = {});
  const T = Cut.time.TICKS;
  const C = Cut.commands;
  H.seq = () => Cut.app.sequence;
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; };
  H.steps = () => Cut.app.history.position;
  H.label = () => Cut.app.history.list()[Cut.app.history.position - 1]?.label;
  H.pt = (t, track, dy = 0.75) => { const p = Cut.ui.timeline.clientPoint(t * T, track, dy); return { x: p.x, y: Math.round(p.y) }; };
  H.view = () => { const tl = Cut.ui.timeline; const w = tl.root.querySelector('.cut-tl-scroll').clientWidth; tl.setZoom(Math.max(40, Math.min(120, Math.floor((w - 40) / 7))), { t: 0, x: 0 }); tl.setScroll(0, 0); return true; };
  H.toast = () => document.querySelector('.cut-root > .cut-toast.shown')?.textContent || '';
  // S1: A (source 0-2 s) at 1 s and B (source 4-6 s) at 3 s on V1 with their sound on A1, a dissolve between them,
  // B's opacity keyframed, and a small text on V2 from 1.5 s to 2.5 s. Then a fresh history on that project.
  H.fresh = async (file) => {
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1], w: 1280, h: 720 } }), { limit: Infinity });
    Cut.app.setHistory(h, null, 'open');
    const s = H.seq().id;
    const ids = await Cut.ui.media.importPaths(Cut.app, [file]);
    const [av, aa] = h.do(C.place(s, { source: { media: ids[0] }, in: 0, out: 2 * T, at: T, video: 'V1', audio: 'A1', mode: 'overwrite' })).ids;
    const [bv, ba] = h.do(C.place(s, { source: { media: ids[0] }, in: 4 * T, out: 6 * T, at: 3 * T, video: 'V1', audio: 'A1', mode: 'overwrite' })).ids;
    h.do(C.addTransition(s, { track: 'V1', at: 3 * T, type: 'dissolve', duration: 10 * Cut.time.frameTicks([30, 1]), align: 'center' }));
    h.do(C.setKeyframes(s, bv, 'opacity', [{ t: 0, v: 100, ease: 'linear' }, { t: 2 * T, v: 40, ease: 'linear' }]));
    const tx = h.do(C.addGenerated(s, { track: 'V2', at: 1.5 * T, duration: T, source: { generator: 'text', layers: [{ text: 'NEST', size: 60, position: [0, 200] }] } })).id;
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project)), { limit: Infinity }), null, 'open');
    Cut.app.setTime(0);
    Cut.ui.showPanel('timeline');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    H.view();
    return { s, media: ids[0], av, aa, bv, ba, tx };
  };
  // The program monitor's picture at sequence time t (seconds) of the active sequence: RGBA, its size, the testsrc
  // frame number it shows.
  H.program = async (t) => {
    const m = Cut.ui.monitors.program;
    await m.player.ready;
    Cut.app.setTime(Math.round(t * T));
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 60)); await m.player.render(); }
    const comp = m.player.compositor;
    const px = await comp.readPixels();
    return { px, w: comp.width, h: comp.height, n: Cut.testsrc.readFrameNumber(px, comp.width, comp.height) };
  };
  H.bright = (a) => { let lit = 0; for (let i = 0; i < a.length; i += 4) lit += a[i] + a[i + 1] + a[i + 2]; return lit / (a.length * 0.75); };
  H.diff = (a, b) => { let sum = 0, max = 0, lit = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); sum += d; if (d > max) max = d; } for (let i = 0; i < a.length; i += 4) lit += a[i] + a[i + 1] + a[i + 2]; return { mean: sum / (a.length * 0.75), max, bright: lit / (a.length * 0.75) }; };
  // Frames and sound of an exported file: [{n, px}] at the given frame indexes, and the PCM.
  H.readExport = async (file, frames) => {
    const opened = await Cut.media.openPath(file);
    const src = Cut.decoder.createFrameSource(opened, opened.video, { hardware: false });
    const out = [];
    const fps = [30, 1];
    for (const i of frames) {
      const f = await src.frameAt(Cut.time.frameStart(i, fps));
      const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(f, 0, 0);
      src.release(f);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      out.push({ n: Cut.testsrc.readFrameNumber(px, c.width, c.height), px });
    }
    src.close();
    const reader = await Cut.audioengine.fileReader(file);
    const source = await Cut.probe.open(reader, { name: file });
    const pcm = await Cut.audioengine.decodeTrack(reader, source.tracks.find((x) => x.kind === 'audio'));
    return { frames: out, pcm };
  };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
const MOD = { Alt: 1, Ctrl: 2, Shift: 8 };
async function clickAt(p, { modifiers = [], button = 'left', count = 1 } = {}) {
  const m = modifiers.reduce((a, k) => a | MOD[k], 0);
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers: m });
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', p.x, p.y, { modifiers: m, clickCount: i, button, buttons: button === 'right' ? 2 : 1 });
    await mouse('mouseReleased', p.x, p.y, { modifiers: m, buttons: 0, clickCount: i, button });
  }
  await sleep(150);
}
async function drag(a, b, { steps = 14, pause = 20 } = {}) {
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await sleep(pause);
  }
  await mouse('mouseReleased', b.x, b.y);
  await sleep(250);
}
const rect = (sel) => js(`__ns.rect(${S(sel)})`);
const pt = (t, track, dy) => js(`__ns.pt(${t}, ${S(track)}, ${dy ?? 0.75})`);
const steps = () => js('__ns.steps()');
const tr = (s, v) => js(`tr(${S(s)}${v ? `, ${S(v)}` : ''})`);
async function menuItem(label) {
  const r = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.querySelector('.menu-label')?.textContent === ${S(label)}); return n && !n.classList.contains('disabled') ? __ns.rect(n) : null; })()`);
  if (r) await clickAt(r);
  return !!r;
}
async function projectItem(id) {
  await js(`(Cut.ui.showPanel('project'), true)`);
  await sleep(250);
  await js(`(document.querySelector('.cut-panel[data-panel="project"] [data-id="${id}"]')?.scrollIntoView({ block: 'nearest' }), true)`);
  return js(`__ns.rect('.cut-panel[data-panel="project"] [data-id="${id}"]')`);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await press('Escape');
  await js(`(document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()), ide.ui.closeMenus(), true)`);
}
// Selects A, B and the text with the real mouse (Shift adds), then Clip > 중첩… and Enter in the name dialog.
async function nestFromMenu(c) {
  await clickAt(await pt(2, 'V1'));
  await clickAt(await pt(3.6, 'V1'), { modifiers: ['Shift'] });
  await clickAt(await pt(2, 'V2'), { modifiers: ['Shift'] });
  const sel = await js(`[...Cut.app.selection].sort().join()`);
  check(sel === [c.av, c.aa, c.bv, c.ba, c.tx].sort().join(), `clicks select the two clips with their sound and the text (${sel})`);
  await clickAt(await rect('.cut-menubar-item[data-menu="clip"]'));
  const nestLabel = await tr('Nest…');
  check(nestLabel === '중첩…', `the Clip menu item is Premiere's Korean "중첩…" (${nestLabel})`);
  check(await menuItem(nestLabel), 'Clip > 중첩… is in the menu and enabled');
  await until(`!!document.querySelector('#cutNestDialog')`, 'the nest dialog', 5000);
}

let c = null;
let nested = null;

// ---------- Clip > Nest… ----------
await section('menu', async () => {
  c = await js(`__ns.fresh(${S(mp4)})`);
  const before = await steps();
  await nestFromMenu(c);
  const dlg = await js(`(() => { const d = document.querySelector('#cutNestDialog'); return { title: d.querySelector('.dialog-title, .dialog-head, h2')?.textContent || d.textContent.slice(0, 40), value: d.querySelector('input.cut-nest-name').value, focused: document.activeElement === d.querySelector('input.cut-nest-name') }; })()`);
  check(dlg.value === '중첩된 시퀀스 1' && dlg.focused && dlg.title.includes('중첩된 시퀀스 이름'), `the dialog asks for the name, "중첩된 시퀀스 1" ready and focused (${S(dlg)})`);
  await press('Enter');
  await until(`!document.querySelector('#cutNestDialog')`, 'the dialog closed', 5000);
  const r = await js(`(() => { const s = __ns.seq(); const inner = Cut.app.project.sequences.find((x) => x.name === '중첩된 시퀀스 1'); return { steps: __ns.steps(), label: __ns.label(), inner: inner?.id, clips: s.clips.map((x) => [x.track, x.start / ${T}, Cut.model.clipEnd(x) / ${T}, x.source.sequence || null, !!x.link]).sort(), innerClips: inner ? inner.clips.length : 0, innerTransitions: inner?.transitions.length, sel: [...Cut.app.selection].length }; })()`);
  check(r.steps === before + 1 && r.label === 'Nest', `Nest is one undo step (${r.steps - before}, ${r.label})`);
  check(!!r.inner && S(r.clips) === S([['A1', 1, 5, r.inner, true], ['V1', 1, 5, r.inner, true]]), `one linked nest clip on V1 and A1 spans 1-5 s in their place (${S(r.clips)})`);
  check(r.innerClips === 5 && r.innerTransitions === 1 && r.sel === 2, `the nested sequence holds the five clips and the dissolve; the nest clips are selected (${r.innerClips}, ${r.innerTransitions}, ${r.sel})`);
  nested = r.inner;
  const inPanel = await projectItem(nested);
  check(!!inPanel && (await js(`document.querySelector('.cut-panel[data-panel="project"] [data-id="${nested}"]').textContent.includes('중첩된 시퀀스 1')`)), 'the new sequence shows in the project panel');
  await js(`(Cut.ui.showPanel('timeline'), __ns.view(), true)`);
  await sleep(300);
  // the nest clip's look: the nest color in its body
  const color = await js(`(() => {
    const tl = Cut.ui.timeline, p = Cut.ui.timeline.clientPoint(3 * ${T}, 'V1', 0.85);
    const read = (cv) => { const r = cv.getBoundingClientRect(), k = cv.width / r.width; return cv.getContext('2d').getImageData(Math.round((p.x - r.left) * k), Math.round((p.y - r.top) * k), 1, 1).data; };
    const d = [...tl.root.querySelectorAll('canvas')].filter((x) => { const r = x.getBoundingClientRect(); return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom; }).map(read).find((px) => px[3] === 255) || [0, 0, 0, 0];
    const want = getComputedStyle(document.documentElement).getPropertyValue('--cut-clip-nest').trim();
    return { got: [d[0], d[1], d[2]], want };
  })()`);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  check(color.want && hex(color.want).every((v, i) => Math.abs(v - color.got[i]) <= 30), `the nest clip is drawn in the nest color ${color.want} (${S(color.got)})`);
  // undo and redo
  await clickAt(await pt(0.3, 'V1'));
  await press('Ctrl+Z');
  const undone = await js(`[__ns.seq().clips.length, Cut.app.project.sequences.length, __ns.seq().transitions.length]`);
  check(S(undone) === S([5, 1, 1]), `Ctrl+Z puts the five clips and the dissolve back and removes the sequence (${S(undone)})`);
  await press('Ctrl+Shift+Z');
  check((await js(`__ns.seq().clips.filter((x) => x.source.sequence).length`)) === 2, 'Ctrl+Shift+Z nests them again');
  // Find Action: the same command by its name (on A and B only)
  await press('Ctrl+Z');
  await clickAt(await pt(2, 'V1'));
  await clickAt(await pt(3.6, 'V1'), { modifiers: ['Shift'] });
  await clickAt(await rect('.cut-menubar-item[data-menu="help"]'));
  check(await menuItem(await tr('Find Action…')), 'Help > Find Action… opens');
  await until(`document.querySelector('#popup:not(.hidden)')`, 'Find Action', 5000);
  await ctx.type(await js(`ide.actions.find((a) => a.id === 'Cut.nest').title`));
  await until(`[...document.querySelectorAll('#popupList .popup-item')].some((n) => n.textContent.includes('중첩…'))`, 'the action in Find Action', 5000);
  await press('Enter');
  const viaFind = await until(`!!document.querySelector('#cutNestDialog')`, 'the nest dialog from Find Action', 5000).then(() => true, () => false);
  check(viaFind, 'Find Action finds 중첩… and opens the same dialog');
  if (viaFind) {
    await js(`(document.querySelector('#cutNestDialog input.cut-nest-name').value = '', true)`);
    await ctx.type('장면 A');
    await press('Enter');
    await sleep(200);
    check(await js(`Cut.app.project.sequences.some((x) => x.name === '장면 A') && __ns.seq().clips.filter((x) => x.source.sequence).length === 2 && __ns.seq().clips.length === 3`), 'the typed name is the sequence\'s; A and B (no text this time) became a nest clip and its sound, the text stays');
    await press('Ctrl+Z');
  }
  // the nest the next sections use: from the menu again
  await nestFromMenu(c);
  await press('Enter');
  await until(`!document.querySelector('#cutNestDialog')`, 'the dialog closed', 5000);
  nested = await js(`Cut.app.project.sequences.find((x) => x.name === '중첩된 시퀀스 1')?.id`);
  check(!!nested && (await js(`__ns.seq().clips.filter((x) => x.source.sequence === ${S(nested)}).length`)) === 2, 'nested again from the menu for the next sections');
});

// ---------- the program monitor: the nest's picture is its clips' ----------
// (not on whole source seconds: testsrc flashes white there)
const TIMES = [1.2, 2.1, 2.95, 3, 4.5];
await section('program', async () => {
  if (!nested) throw new Error('no nest from the menu section');
  // the same project before the nest: undo, read the pictures, redo
  await press('Ctrl+Z');
  const flat = await js(`(async () => { const out = []; for (const t of ${S(TIMES)}) { const p = await __ns.program(t); out.push({ n: p.n, px: Array.from(p.px) }); } window.__flat = out; return out.map((x) => x.n); })()`);
  await press('Ctrl+Shift+Z');
  const res = await js(`(async () => { const out = []; for (const [i, t] of ${S(TIMES)}.entries()) { const p = await __ns.program(t); out.push({ n: p.n, ...__ns.diff(Uint8Array.from(window.__flat[i].px), p.px) }); } return out; })()`);
  log(`  frames ${S(flat)} -> ${S(res.map((r) => r.n))}`);
  check(S(flat) === S([6, 33, -1, -1, 165]), `the clips show testsrc frames 6, 33, the dissolve (no number), 165 (${S(flat)})`);
  check(res.every((r, i) => r.n === flat[i]), `with the nest the program monitor shows the same frames (${S(res.map((r) => r.n))})`);
  check(res.every((r) => r.mean < 0.6 && r.max <= 12), `and the same pixels, the dissolve, the text and B's opacity included (mean ${res.map((r) => r.mean.toFixed(3)).join(', ')}; max ${res.map((r) => r.max).join(', ')})`);
  // the Canvas 2D back end draws a nest the same way (times 2.1 s and 4.5 s, against the clips before the nest)
  const twoD = await js(`(async () => {
    const comp = await Cut.compositor.create(new OffscreenCanvas(640, 360), { backend: '2d', width: 640, height: 360 });
    const shot = async (t) => { await comp.render(Cut.app.project, Cut.app.sequenceId, Math.round(t * ${T})); return comp.readPixels(); };
    Cut.app.history.undo();
    const flat = [await shot(2.1), await shot(4.5)];
    Cut.app.history.redo();
    const nest = [await shot(2.1), await shot(4.5)];
    comp.destroy();
    return { backend: comp.backend, n: [...flat, ...nest].map((px) => Cut.testsrc.readFrameNumber(px, 640, 360)), d: flat.map((px, i) => __ns.diff(px, nest[i])) };
  })()`);
  check(twoD.backend === '2d' && S(twoD.n) === S([33, 165, 33, 165]) && twoD.d.every((d) => d.mean < 1.5), `the Canvas 2D back end shows the nest as its clips (${S(twoD.n)}, mean ${twoD.d.map((d) => d.mean.toFixed(3)).join(', ')})`);
  // the nest clip's own opacity applies on top
  const nv = await js(`__ns.seq().clips.find((x) => x.source.sequence && x.track === 'V1').id`);
  await js(`(Cut.app.history.do(Cut.commands.setClip(__ns.seq().id, ${S(nv)}, { props: { opacity: 50 } })), true)`);
  const half = await js(`(async () => { const p = await __ns.program(2.1); return __ns.bright(p.px) / __ns.bright(Uint8Array.from(window.__flat[1].px)); })()`);
  check(half > 0.4 && half < 0.85, `the nest clip at 50% opacity draws the nested picture dimmer (${half.toFixed(3)} of its brightness)`);
  await press('Ctrl+Z');
});

// ---------- double-click opens the nested sequence ----------
await section('open', async () => {
  if (!nested) throw new Error('no nest from the menu section');
  await js(`(Cut.ui.showPanel('timeline'), __ns.view(), true)`);
  const outerId = await js('__ns.seq().id');
  const outer = await js(`(async () => { const p = await __ns.program(4.5); return { n: p.n, px: Array.from(p.px) }; })()`);
  await js(`(Cut.app.setTime(Math.round(4.5 * ${T})), true)`);
  await sleep(150);
  await clickAt(await pt(2.2, 'V1'), { count: 2 });
  await until(`Cut.app.sequenceId === ${S(nested)}`, 'the nested sequence is active', 5000).catch(() => {});
  const st = await js(`({ seq: Cut.app.sequenceId, t: Cut.app.t / ${T}, tabs: [...document.querySelectorAll('.cut-tl-tab')].map((n) => [n.dataset.seq, n.classList.contains('active')]) })`);
  check(st.seq === nested && st.tabs.some(([id, on]) => id === nested && on) && st.tabs.some(([id]) => id === outerId), `a double-click on the nest clip opens its sequence in its own active timeline tab, the outer tab kept (${S(st.tabs)})`);
  check(Math.abs(st.t - 3.5) < 1e-6, `the playhead goes to the frame the nest showed (3.5 s for 4.5 s; ${st.t})`);
  await sleep(300);
  const inner = await js(`(async () => { const p = await __ns.program(3.5); const d = __ns.diff(Uint8Array.from(${S(outer.px)}), p.px); return { n: p.n, ...d }; })()`);
  check(inner.n === outer.n && inner.mean < 0.6 && inner.max <= 12, `the program monitor shows the nested sequence's picture as the nest showed it (frame ${inner.n} vs ${outer.n}, mean ${inner.mean.toFixed(3)}, max ${inner.max})`);
  // back to the outer sequence by its tab
  await clickAt(await rect(`.cut-tl-tab[data-seq="${outerId}"]`));
  check((await js('Cut.app.sequenceId')) === outerId, 'the outer tab goes back');
});

// ---------- a sequence dragged from the project panel ----------
let third = null;
await section('drag', async () => {
  if (!nested) throw new Error('no nest from the menu section');
  third = await js(`(() => { const r = Cut.app.history.do(Cut.commands.addSequence({ name: '세 번째', w: 1280, h: 720, fps: [30, 1] })); Cut.app.setSequence(r.id); return r.id; })()`);
  await js(`(Cut.ui.showPanel('timeline'), __ns.view(), true)`);
  await sleep(300);
  const before = await steps();
  const item = await projectItem(nested);
  check(!!item, 'the nested sequence is in the project panel');
  await js(`(Cut.ui.showPanel('timeline'), true)`);
  await sleep(150);
  const item2 = await js(`__ns.rect('.cut-panel[data-panel="project"] [data-id="${nested}"]')`);
  const visible = item2 && (await js(`(() => { const n = document.elementFromPoint(${item2?.x}, ${item2?.y}); return !!n?.closest('.cut-panel[data-panel="project"]'); })()`));
  check(visible, 'the project panel and the timeline are both on screen');
  await drag(item2, await pt(2, 'V1', 0.5));
  const r = await js(`(() => { const s = __ns.seq(); return { steps: __ns.steps(), clips: s.clips.map((x) => [x.track, x.start / ${T}, Cut.model.clipEnd(x) / ${T}, x.source.sequence, x.in]).sort(), linked: s.clips.length === 2 && s.clips[0].link && s.clips[0].link === s.clips[1].link }; })()`);
  check(r.steps === before + 1 && S(r.clips) === S([['A1', 2, 6, nested, 0], ['V1', 2, 6, nested, 0]]) && r.linked, `the sequence dropped on V1 at 2 s is a linked nest clip on V1 and A1, its whole 4 s, in one step (${S(r)})`);
  const p = await js(`(async () => { const p = await __ns.program(2 + 3.5); return p.n; })()`);
  check(p === 165, `the dropped nest plays the nested sequence in the program monitor (frame ${p} at 5.5 s)`);
});

// ---------- from the source monitor ----------
await section('source', async () => {
  if (!nested || !third) throw new Error('no nest or third sequence');
  const item = await projectItem(nested);
  await clickAt(item, { button: 'right' });
  check(await menuItem(await tr('Open in Source Monitor')), 'the sequence\'s menu has 소스 모니터에서 열기');
  await until(`Cut.app.source?.sequenceId === ${S(nested)}`, 'the sequence in the source monitor', 5000).catch(() => {});
  await sleep(600);
  const title = await js(`document.querySelector('.cut-panel[data-panel="source"] .cut-monitor-title')?.textContent`);
  check(title === '중첩된 시퀀스 1', `the source monitor shows the sequence (${title})`);
  const src = await js(`(async () => { const m = Cut.ui.monitors.source; await m.player.ready; m.seek(Math.round(1.1 * ${T})); for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 80)); await m.player.render(); } const c = m.player.compositor; return Cut.testsrc.readFrameNumber(await c.readPixels(), c.width, c.height); })()`);
  check(src === 33, `the source monitor plays the sequence (frame ${src} at 1.1 s)`);
  await js(`(Cut.app.setSequence(${S(third)}), Cut.app.setTime(Math.round(8 * ${T})), true)`);
  await sleep(200);
  const before = await steps();
  const view = await js(`__ns.rect('.cut-panel[data-panel="source"] .cut-monitor-view')`);
  await clickAt({ x: view.x, y: view.top + 4 });
  await press('.');
  await sleep(200);
  const r = await js(`(() => { const s = __ns.seq(); return { steps: __ns.steps(), at8: s.clips.filter((x) => x.start === 8 * ${T}).map((x) => [x.track, x.source.sequence, Cut.model.clipEnd(x) / ${T}]).sort() }; })()`);
  check(r.steps === before + 1 && S(r.at8) === S([['A1', nested, 12], ['V1', nested, 12]]), `Overwrite (.) from the source monitor places the sequence as a nest clip at the playhead (${S(r)})`);
});

// ---------- a loop is refused ----------
await section('loop', async () => {
  if (!nested) throw new Error('no nest from the menu section');
  const outerId = await js(`Cut.app.project.sequences.find((x) => x.clips.some((c) => c.source.sequence === ${S(nested)}) && x.name !== '세 번째')?.id`);
  await js(`(Cut.app.setSequence(${S(nested)}), Cut.ui.showPanel('timeline'), __ns.view(), true)`);
  await sleep(300);
  const before = await js('Cut.app.history.serialize()');
  const item = await projectItem(outerId);
  await js(`(Cut.ui.showPanel('timeline'), true)`);
  await sleep(150);
  const p = await js(`__ns.rect('.cut-panel[data-panel="project"] [data-id="${outerId}"]')`);
  await drag(p || item, await pt(0.5, 'V2', 0.5));
  const msg = await js('__ns.toast()');
  check(msg === '시퀀스를 자기 자신 안에 중첩할 수 없습니다.', `dropping the outer sequence into the one it holds is refused in Korean (${msg})`);
  check((await js('Cut.app.history.serialize()')) === before, 'the refused drop changes nothing');
  const self = await projectItem(nested);
  await js(`(Cut.ui.showPanel('timeline'), true)`);
  await sleep(150);
  await drag(await js(`__ns.rect('.cut-panel[data-panel="project"] [data-id="${nested}"]')`) || self, await pt(0.5, 'V2', 0.5));
  check((await js('__ns.toast()')) === '시퀀스를 자기 자신 안에 중첩할 수 없습니다.' && (await js('Cut.app.history.serialize()')) === before, 'and a sequence dropped on its own timeline too');
  const cmd = await js(`(() => { try { Cut.app.history.do(Cut.commands.place(${S(nested)}, { source: { sequence: ${S(outerId)} }, at: 0, video: 'V2', audio: null })); return 'placed'; } catch (e) { return e.code + ': ' + tr(e.message); } })()`);
  check(cmd === 'nestLoop: 시퀀스를 자기 자신 안에 중첩할 수 없습니다.', `the command refuses it as well (${cmd})`);
  await js(`(Cut.app.setSequence(${S(outerId)}), true)`);
});

// ---------- deleting a nested sequence asks ----------
await section('delete', async () => {
  if (!nested) throw new Error('no nest from the menu section');
  const before = await js('Cut.app.history.serialize()');
  const item = await projectItem(nested);
  await clickAt(item);
  await press('Delete');
  await until(`[...document.querySelectorAll('.dialog')].some((d) => d.textContent.includes('중첩되어 있습니다'))`, 'the question', 5000).catch(() => {});
  const text = await js(`[...document.querySelectorAll('.dialog')].map((d) => d.textContent).find((x) => x.includes('중첩되어 있습니다')) || ''`);
  check(/"중첩된 시퀀스 1" 시퀀스는 "Sequence 1" 시퀀스 안에 중첩되어 있습니다\(클립 2개\)/.test(text) && text.includes('세 번째') && text.includes('삭제하시겠습니까?'), `Delete asks first and says where it is used (${text.slice(0, 200)})`);
  const cancel = await js(`(() => { const d = [...document.querySelectorAll('.dialog')].find((x) => x.textContent.includes('중첩되어 있습니다')); const b = [...d.querySelectorAll('button')].find((x) => x.textContent === tr('Cancel')); return __ns.rect(b); })()`);
  await clickAt(cancel);
  check((await js('Cut.app.history.serialize()')) === before, 'Cancel deletes nothing');
  await clickAt(await projectItem(nested));
  await press('Delete');
  await until(`[...document.querySelectorAll('.dialog')].some((d) => d.textContent.includes('중첩되어 있습니다'))`, 'the question again', 5000);
  const ok = await js(`(() => { const d = [...document.querySelectorAll('.dialog')].find((x) => x.textContent.includes('중첩되어 있습니다')); const b = [...d.querySelectorAll('button')].find((x) => x.textContent === tr('Delete')); return __ns.rect(b); })()`);
  await clickAt(ok);
  await sleep(200);
  check(await js(`!Cut.app.project.sequences.some((x) => x.id === ${S(nested)}) && !Cut.app.project.sequences.some((x) => x.clips.some((c) => c.source.sequence === ${S(nested)}))`), 'Delete removes the sequence and every nest clip of it');
  await clickAt(await rect('.cut-menubar-item[data-menu="edit"]'));
  await menuItem(await js(`Cut.ui.keys.title('undo')`));
  await sleep(200);
  check((await js('Cut.app.history.serialize()')) === before, 'Edit > Undo brings it all back');
});

// ---------- export: the nest and its sequence give the same file ----------
await section('export', async () => {
  const r = await js(`(async () => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1], w: 1280, h: 720 } }));
    const list = await Cut.media.importFiles([${S(mp4)}]);
    const [m] = h.do(C.importMedia(list)).ids;
    const s = h.project.sequences[0].id;
    const a = h.do(C.place(s, { source: { media: m }, in: 0, out: 2 * T, at: T, video: 'V1', audio: 'A1', mode: 'overwrite' })).ids;
    const b = h.do(C.place(s, { source: { media: m }, in: 4 * T, out: 6 * T, at: 3 * T, video: 'V1', audio: 'A1', mode: 'overwrite' })).ids;
    h.do(C.addTransition(s, { track: 'V1', at: 3 * T, type: 'dissolve', duration: 10 * Cut.time.frameTicks([30, 1]), align: 'center' }));
    h.do(C.setClip(s, b[1], { props: { volume: -6 } }));
    const n = h.do(C.nest(s, [...a, ...b], { name: 'N' }));
    const run = (seqId, file, range) => Cut.export.run({ project: h.project, seqId, path: ${S(P('nest'))} + file, preset: '720p', range, overrides: { loudness: null } });
    const outer = await run(s, '-outer.mp4', { in: T, out: 5 * T });
    const inner = await run(n.id, '-inner.mp4', null);
    if (!outer.ok || !inner.ok) return { error: (outer.error || '') + ' / ' + (inner.error || '') };
    const frames = [3, 15, 40, 50, 60, 70, 100, 119];
    const A = await __ns.readExport(outer.path, frames);
    const B = await __ns.readExport(inner.path, frames);
    const pairs = frames.map((f, i) => ({ f, a: A.frames[i].n, b: B.frames[i].n, psnr: Math.min(999, Cut.export.psnr(A.frames[i].px, B.frames[i].px)) }));
    let diff = 0, rms = 0;
    const len = Math.min(A.pcm.data[0].length, B.pcm.data[0].length);
    for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) { diff = Math.max(diff, Math.abs(A.pcm.data[c][i] - B.pcm.data[c][i])); rms += B.pcm.data[c][i] ** 2; }
    return { frames: [outer.frames, inner.frames], pairs, diff, rms: Math.sqrt(rms / (2 * len)), lens: [A.pcm.data[0].length, B.pcm.data[0].length] };
  })()`);
  check(!r.error, `both exports finish (${r.error || 'ok'})`);
  if (r.error) return;
  log(`  ${S(r.pairs.map((p) => [p.f, p.a, p.b, p.psnr >= 999 ? 'same' : +p.psnr.toFixed(1)]))}`);
  check(r.frames[0] === 120 && r.frames[1] === 120, `the outer range over the nest and the nested sequence are 120 frames each (${S(r.frames)})`);
  check(r.pairs.every((p) => p.a === p.b) && S(r.pairs.map((p) => p.a)) === S([3, 15, 40, 50, -1, 130, 160, 179]), `the frames show the same testsrc frames (${S(r.pairs.map((p) => p.a))})`);
  check(r.pairs.every((p) => p.psnr >= 45), `and the same pictures, the dissolve included (PSNR ${r.pairs.map((p) => (p.psnr >= 999 ? 'identical' : p.psnr.toFixed(1))).join(', ')} dB)`);
  check(r.rms > 0.005 && r.diff < 0.002 && Math.abs(r.lens[0] - r.lens[1]) <= 1024, `the sound is the same samples (largest difference ${r.diff.toExponential(2)}, RMS ${r.rms.toFixed(4)}, lengths ${S(r.lens)})`);
});

// ---------- screenshots: a nest clip on the timeline, dark and light ----------
await section('shots', async () => {
  c = await js(`__ns.fresh(${S(mp4)})`);
  await js(`(Cut.app.history.do(Cut.commands.nest(__ns.seq().id, [${S(c.av)}, ${S(c.bv)}, ${S(c.tx)}], { name: '중첩된 시퀀스 1' })), Cut.app.select([]), Cut.app.setTime(Math.round(2.1 * ${T})), true)`);
  await sleep(600);
  log(`  saved ${await ctx.shot('nest-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(500);
  log(`  saved ${await ctx.shot('nest-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

ctx.finish();
