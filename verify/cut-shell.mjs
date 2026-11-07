// Nano Studio Cut, the editor's frame (renderer/features/cut/ui-shell.js, ui-project.js, ui-monitors.js, ui-export.js,
// ui-captions.js, ui-keys.js): driven with real mouse and key events in the app. The media comes from Cut.testsrc,
// written into a temporary Cut home; native dialogs answer from PYIDE_CUT_DIALOG (main/features/cut.js).
import { launch, clickMenuPath } from './lib.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync, renameSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const TICKS = 254016000000;
const F = TICKS / 30; // one frame at 30 fps
const home = mkdtempSync(path.join(tmpdir(), 'pyide-cut-shell-'));
const userData = mkdtempSync(path.join(tmpdir(), 'pyide-cut-shell-data-'));
const dialogFile = path.join(home, 'dialogs.json');
const answer = (v) => writeFileSync(dialogFile, JSON.stringify(v));
answer({});
const mediaDir = path.join(home, 'media');
mkdirSync(mediaDir, { recursive: true });
const projectPath = path.join(home, 'Projects', 'shell-test.ncut');
const env = { PYIDE_CUT_HOME: home, PYIDE_CUT_DIALOG: dialogFile };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(name) {
  const ctx = await launch({ fixture: 'core', port: 9755, name, mode: 'cut', userData, env });
  await ctx.until('window.__cutReady === true', 'the editor started', 60000);
  const natural = await ctx.js(`!!(window.Cut && Cut.model && Cut.commands && Cut.srt)`).catch(() => false);
  return { ctx, natural };
}

let { ctx, natural } = await start('cut-shell');
let { js, until, check, cdp, shot } = ctx;
const bind = (c) => ({ js, until, check, cdp, shot } = c);

// ---------- input helpers ----------
const center = async (sel) => {
  const r = await js(`(() => { const n = ${typeof sel === 'string' ? `document.querySelector(${JSON.stringify(sel)})` : sel}; if (!n) return null; n.scrollIntoView({ block: 'nearest' }); const b = n.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, l: b.left, t: b.top }; })()`);
  if (!r) throw new Error(`no element ${sel}`);
  return r;
};
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
async function clickAt(x, y, clickCount = 1) {
  await mouse('mouseMoved', x, y);
  for (let i = 1; i <= clickCount; i++) {
    await mouse('mousePressed', x, y, { clickCount: i });
    await mouse('mouseReleased', x, y, { clickCount: i });
  }
  await sleep(80);
}
const click = async (sel) => { const p = await center(sel); await clickAt(p.x, p.y); };
const dblclick = async (sel) => { const p = await center(sel); await clickAt(p.x, p.y, 2); };
async function drag(from, to) {
  const a = await center(from);
  const b = await center(to);
  await mouse('mouseMoved', a.x, a.y);
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', b.x, b.y);
  await sleep(100);
}
const KEYS = { Space: [' ', 'Space', 32], Comma: [',', 'Comma', 188], Period: ['.', 'Period', 190], Home: ['Home', 'Home', 36], End: ['End', 'End', 35],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40], Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27],
  Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46], Backquote: ['`', 'Backquote', 192] };
// A key stroke: 'J', 'Ctrl+S', 'Shift+ArrowRight', 'Comma'... `text` makes it type (a keyDown with text).
async function key(combo, { down = true, up = true, text } = {}) {
  const parts = combo.split('+');
  const name = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
  const [k, code, vk] = KEYS[name] || [mods & 8 ? name.toUpperCase() : name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  const base = { modifiers: mods, key: k, code, windowsVirtualKeyCode: vk };
  if (down) await cdp('Input.dispatchKeyEvent', text != null ? { type: 'keyDown', ...base, text } : { type: 'rawKeyDown', ...base });
  if (up) await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
const S = (expr) => js(expr);
const app = (expr) => js(`(() => { const app = Cut.app; return ${expr}; })()`);
const focusOf = () => app('app.focusPanel');

try {
  check(natural, 'the project modules (model, commands, srt) load in the Cut window as shipped');

  // ---------- an untitled project with an empty sequence ----------
  check(await app(`Cut.ui.lifecycle.projectName() === 'Untitled' && !app.path && app.project.sequences.length === 1 && app.sequence.clips.length === 0 && !Cut.ui.lifecycle.dirty`),
    'the editor starts with an untitled project and one empty sequence');
  check(await S(`document.querySelector('.cut-project-title').textContent === 'Untitled' && Cut.ui.workspace === 'editing'`), 'the top bar names it and the Editing workspace is shown');
  check(await S(`['project', 'source', 'program', 'timeline'].every((p) => document.querySelector('.cut-grid .cut-panel[data-panel="' + p + '"]')?.getClientRects().length)`),
    'Editing shows the project, source, program and timeline panels');

  // ---------- test media through the import button ----------
  const clipA = path.join(mediaDir, 'clip-a.mp4');
  const clipB = path.join(mediaDir, 'clip-b.mp4');
  for (const [file, seconds] of [[clipA, 4], [clipB, 3]]) {
    const r = await S(`(async () => {
      const bytes = await Cut.testsrc.make({ seconds: ${seconds}, fps: [30, 1], w: 320, h: 180, beepEvery: 1 });
      const o = await ide.api.invoke('cut:writeOpen', ${JSON.stringify(file)});
      await ide.api.invoke('cut:writeAt', o.id, bytes);
      return (await ide.api.invoke('cut:writeClose', o.id, { commit: true })).ok;
    })()`);
    check(r && existsSync(file), `test media ${path.basename(file)} written`);
  }
  const bad = path.join(mediaDir, 'broken.mp4');
  writeFileSync(bad, Buffer.from('this is not a video file at all, just text'.repeat(40)));
  check(await S(`document.querySelector('.cut-project .cut-items').classList.contains('grid')`), 'the project panel starts with thumbnails');
  await click('.cut-project .cut-view-list');
  answer({ pickMedia: [clipA, clipB, bad] });
  await click('.cut-project .cut-import');
  await until(`Cut.app.project.media.length === 2`, 'two media imported', 30000);
  await until(`!!document.querySelector('#cutImportErrors')`, 'the list of files that could not be imported');
  check(await S(`(() => { const d = document.querySelector('#cutImportErrors'); return d.querySelectorAll('li').length === 1 && d.querySelector('.cut-import-error-name').textContent === 'broken.mp4' && d.querySelector('.cut-import-error-reason').textContent.length > 5; })()`),
    'a file that cannot be used is listed with the reason');
  await click('#cutImportErrors .dialog-buttons button');
  const media = await app(`app.project.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, w: m.video?.w, d: m.duration, a: !!m.audio }))`);
  check(media[0].name === 'clip-a.mp4' && media[0].kind === 'video' && media[0].w === 320 && Math.abs(media[0].d - 4 * TICKS) < 2 * F && media[0].a,
    `the import button imports the picked files with their size, length and sound (${JSON.stringify(media[0])})`);
  check(await S(`document.querySelectorAll('.cut-project .cut-item-row[data-kind="media"]').length === 2`), 'the project list shows both files');

  // ---------- bins ----------
  await click('.cut-project .cut-new-bin');
  await until(`document.activeElement?.classList.contains('cut-rename')`, 'the new bin is being named');
  await cdp('Input.insertText', { text: 'Footage' });
  await key('Enter');
  await until(`Cut.app.project.bins[0]?.name === 'Footage'`, 'the bin is named');
  check(true, 'New Bin makes a bin and names it in place');
  await drag(`.cut-project .cut-item-row[data-kind="media"][data-id="${media[1].id}"]`, `.cut-project .cut-item-row[data-kind="bin"]`);
  check(await app(`app.project.bins[0].items.includes('${media[1].id}')`), 'dragging a clip onto a bin moves it into the bin');
  check(await S(`!document.querySelector('.cut-project .cut-item-row[data-id="${media[1].id}"]')`), 'the moved clip leaves the top level');
  await dblclick('.cut-project .cut-item-row[data-kind="bin"]');
  await until(`!!document.querySelector('.cut-project .cut-item-row[data-id="${media[1].id}"]') && !document.querySelector('.cut-project .cut-crumbs').hidden`, 'inside the bin');
  check(true, 'double-clicking a bin opens it, with a path back');
  await click('.cut-project .cut-crumb[data-bin=""]');
  await until(`!!document.querySelector('.cut-project .cut-item-row[data-id="${media[0].id}"]')`, 'back at the top');

  // ---------- search ----------
  await click('.cut-project .cut-search');
  await cdp('Input.insertText', { text: 'clip-b' });
  await until(`document.querySelectorAll('.cut-project .cut-item-row[data-kind="media"]').length === 1`, 'search finds the clip in the bin');
  check(await S(`document.querySelector('.cut-project .cut-item-row[data-kind="media"]').dataset.id === '${media[1].id}'`), 'search looks into bins');
  await key('Ctrl+A');
  await key('Backspace');
  await until(`document.querySelector('.cut-project .cut-search').value === '' && document.querySelectorAll('.cut-project .cut-item-row').length === 3`, 'search cleared');
  check(await app(`app.project.media.length === 2 && app.project.bins.length === 1`), 'Backspace in the search field deletes no project item');

  // ---------- hover scrub in the thumbnail view ----------
  await click('.cut-project .cut-view-grid');
  const thumb = `.cut-project .cut-item-card[data-id="${media[0].id}"] .cut-thumb`;
  await until(`Number(document.querySelector('${thumb}')?.dataset.frames) > 1`, 'the thumbnail strip', 40000);
  const pixels = `(() => { const c = document.querySelector('${thumb} canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0; return h; })()`;
  const tb = await center(thumb);
  await mouse('mouseMoved', tb.l + tb.w * 0.05, tb.y);
  await sleep(150);
  const s1 = await S(`({ i: document.querySelector('${thumb}').dataset.scrub, h: ${pixels} })`);
  await mouse('mouseMoved', tb.l + tb.w * 0.9, tb.y);
  await sleep(150);
  const s2 = await S(`({ i: document.querySelector('${thumb}').dataset.scrub, h: ${pixels} })`);
  check(s1.i === '0' && Number(s2.i) >= 9 && s1.h !== s2.h, `moving over a thumbnail shows other frames (${JSON.stringify([s1, s2])})`);
  const off = await S(`[...document.querySelectorAll('.cut-project .cut-item-card .cut-thumb')].filter((t) => t.querySelector('.ide-icon svg')).map((t) => {
    const a = t.getBoundingClientRect(), s = t.querySelector('.ide-icon svg').getBoundingClientRect();
    return [t.closest('.cut-item-card').dataset.kind, Math.round(s.x + s.width / 2 - a.x - a.width / 2), Math.round(s.y + s.height / 2 - a.y - a.height / 2)]; })`);
  check(off.length > 0 && off.every(([, dx, dy]) => Math.abs(dx) <= 1 && Math.abs(dy) <= 1), `the icon of a card without a picture sits in the middle of its thumbnail (${JSON.stringify(off)})`);
  await click('.cut-project .cut-view-list');

  // ---------- source monitor: In/Out, insert and overwrite ----------
  await dblclick(`.cut-project .cut-item-row[data-id="${media[0].id}"]`);
  await until(`Cut.app.source?.mediaId === '${media[0].id}' && document.querySelector('.cut-monitor-source .cut-monitor-title').textContent === 'clip-a.mp4'`, 'clip A in the source monitor');
  check(true, 'double-clicking a clip opens it in the source monitor');
  await click('.cut-monitor-source .cut-monitor-head');
  check(await focusOf() === 'source', 'clicking the source monitor gives it the keyboard');
  await key('Home');
  for (let i = 0; i < 15; i++) await key('ArrowRight');
  await key('I');
  for (let i = 0; i < 6; i++) await key('Shift+ArrowRight');
  await key('O');
  const src = await app(`({ in: app.source.in, out: app.source.out })`);
  check(src.in === 15 * F && src.out === 46 * F, `I and O mark the source In and Out at the playhead (${src.in / F}..${src.out / F} frames)`);
  check(await app(`app.inOut.in === null && app.inOut.out === null && app.t === 0`), 'the source keys leave the sequence playhead and In/Out alone');
  check(await S(`document.querySelector('.cut-monitor-source .cut-scrub').dataset.in == ${15 * F}`), 'the source scrub bar shows the In');

  await key('Comma');
  await until(`Cut.app.sequence.clips.length === 2`, 'insert placed the clip');
  const placed = await app(`app.sequence.clips.map((c) => ({ track: c.track, start: c.start / ${F}, in: c.in / ${F}, out: c.out / ${F}, link: c.link }))`);
  check(placed.some((c) => c.track === 'V1' && c.start === 0 && c.in === 15 && c.out === 46) && placed.some((c) => c.track === 'A1' && c.start === 0) && placed[0].link && placed[0].link === placed[1].link,
    `',' inserts the source In..Out at the playhead on V1 and A1, linked (${JSON.stringify(placed)})`);
  check(await app(`app.sequence.w === 320 && app.sequence.h === 180 && app.t === 31 * ${F}`), 'the empty sequence took the clip\'s size, and the playhead moved past the clip');
  await key('Period');
  await until(`Cut.app.sequence.clips.length === 4`, 'overwrite placed the clip');
  check(await app(`app.sequence.clips.filter((c) => c.track === 'V1').map((c) => c.start / ${F}).sort((a, b) => a - b).join() === '0,31'`), "'.' overwrites at the playhead");
  await click('.cut-monitor-program .cut-monitor-head');
  await key('Home');
  await click('.cut-monitor-source .cut-monitor-head');
  await key('Comma');
  await until(`Cut.app.sequence.clips.length === 6`, 'second insert');
  check(await app(`app.sequence.clips.filter((c) => c.track === 'V1').map((c) => c.start / ${F}).sort((a, b) => a - b).join() === '0,31,62'`), 'insert at 0 pushes the clips after it');

  // ---------- program monitor: play, J/K/L ----------
  await click('.cut-monitor-program .cut-monitor-head');
  check(await focusOf() === 'program', 'clicking the program monitor gives it the keyboard');
  for (let i = 0; i < 10; i++) await key('ArrowRight');
  await sleep(600);
  const shown = await S(`(async () => {
    const m = Cut.ui.monitors.program; const comp = m.player.compositor; await m.player.render?.(Cut.app.t);
    const px = await comp.readPixels();
    const c = m.canvas.getBoundingClientRect(); const top = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
    return { n: Cut.testsrc.readFrameNumber(px, comp.width, comp.height), top: top === m.canvas || !!top?.closest('.cut-ov') };
  })()`);
  check(shown.n === 25 && shown.top, `the program monitor shows the sequence frame at the playhead (source frame ${shown.n}, canvas on top: ${shown.top})`);
  await click('.cut-monitor-program .cut-tr-safe');
  check(await S(`!document.querySelector('.cut-monitor-program .cut-safe').hidden && document.querySelector('.cut-monitor-program .cut-safe-title').getBoundingClientRect().width > 50`), 'the safe margins show over the picture');
  await click('.cut-monitor-program .cut-tr-safe');
  await S(`(() => { const s = document.querySelector('.cut-monitor-program .cut-monitor-quality'); s.value = '0.5'; s.dispatchEvent(new Event('change')); })()`);
  check(await S(`Cut.ui.monitors.program.player.quality === 0.5`), 'the playback resolution goes to the player');
  await S(`(() => { const s = document.querySelector('.cut-monitor-program .cut-monitor-quality'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await key('Ctrl+Backquote');
  await until(`document.fullscreenElement === document.querySelector('.cut-monitor-program .cut-monitor-view')`, 'full screen', 5000).catch(() => {});
  check(await S(`document.fullscreenElement === document.querySelector('.cut-monitor-program .cut-monitor-view')`), 'Ctrl+` shows the program monitor full screen');
  await key('Ctrl+Backquote');
  await until(`!document.fullscreenElement`, 'full screen left', 5000).catch(() => {});
  const sharp = `(() => { const c = Cut.ui.monitors.program.canvas; return Math.abs(c.width - c.clientWidth * devicePixelRatio) <= 2 && Math.abs(c.height - c.clientHeight * devicePixelRatio) <= 2; })()`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1.25, mobile: false });
  const resized = await until(sharp, 'the stopped program monitor drawn at its new size', 5000).catch(() => false);
  await cdp('Emulation.clearDeviceMetricsOverride');
  check(resized && await until(sharp, 'the program monitor back at the window size', 5000).catch(() => false),
    'a stopped monitor draws again at its new size and scale when the window changes (not the old frame stretched)');
  check(await S(`!document.fullscreenElement`), 'and Ctrl+` again leaves full screen');
  await sleep(500);
  check(await S(`Cut.ui.monitors.program.player && !Cut.ui.monitors.program.player.fallback`), 'the program monitor plays through the engine\'s player');
  await key('Home');
  await key('Space');
  await until(`Cut.app.playing`, 'playing', 5000);
  await sleep(700);
  const tPlay = await app('app.t');
  await key('Space');
  await until(`!Cut.app.playing`, 'stopped', 5000);
  check(tPlay > 5 * F, `Space plays and the playhead moves (${(tPlay / F).toFixed(1)} frames after 0.7 s)`);
  await app(`(app.setTime(${45 * F}), true)`);
  await sleep(200);
  await S(`(() => { window.__heads = []; window.__offHeads = Cut.app.on('time', ({ t }) => window.__heads.push(t)); return true; })()`);
  await key('Space');
  await sleep(900);
  await key('Space');
  await until(`!Cut.app.playing`, 'stopped', 5000);
  const heads = await S(`(() => { window.__offHeads(); return window.__heads; })()`);
  check(heads.length > 5 && heads.every((t, i) => t >= 45 * F && (i === 0 || t >= heads[i - 1])),
    `playing from frame 45 moves the playhead on from there, never back to 0 while the sound starts (${heads.slice(0, 4).map((t) => (t / F).toFixed(0)).join(', ')} … ${heads.length} moves)`);
  // the Play/Stop button with a real click on its icon, held a moment as a person does, while it plays
  const pb = await center('.cut-monitor-program .cut-tr-play svg');
  await key('Home');
  await clickAt(pb.x, pb.y);
  await until(`Cut.app.playing`, 'the button plays', 5000);
  await sleep(300);
  await mouse('mouseMoved', pb.x, pb.y);
  await S(`(() => { const b = document.querySelector('.cut-monitor-program .cut-tr-play'); window.__pb = { icon: b.querySelector('svg'), clicks: 0 }; b.addEventListener('click', () => window.__pb.clicks++); return true; })()`);
  await mouse('mousePressed', pb.x, pb.y);
  // the monitor redraws its controls while the button is held (it used to put a new icon under the pointer)
  const redrawn = await until(`document.querySelector('.cut-monitor-program .cut-tr-play svg') !== window.__pb.icon`, 'the icon redrawn', 400).then(() => true, () => false);
  await sleep(100);
  await mouse('mouseReleased', pb.x, pb.y);
  await sleep(300);
  const pressed = await S(`({ clicks: window.__pb.clicks, playing: Cut.app.playing, t: Cut.app.t, end: Cut.model.sequenceDuration(Cut.app.sequence) })`);
  check(pressed.clicks === 1 && !pressed.playing && pressed.t < pressed.end - 2 * F,
    `clicking Play/Stop while playing stops playback before the end (${JSON.stringify({ ...pressed, redrawn })})`);
  if (pressed.playing) { await key('Space'); await until(`!Cut.app.playing`, 'stopped', 5000).catch(() => {}); }
  await key('Home');
  await key('L');
  await until(`Cut.app.playing && Cut.ui.monitors.program.player.rate === 1`, 'L plays forward', 5000);
  await key('L');
  await until(`Cut.ui.monitors.program.player.rate === 2`, 'L again doubles', 5000);
  check(true, 'L plays forward and a second L doubles the speed');
  await sleep(300);
  await key('K');
  await until(`!Cut.app.playing`, 'K stops', 5000);
  const tK = await app('app.t');
  await key('J');
  await until(`Cut.app.playing && Cut.ui.monitors.program.player.rate === -1`, 'J plays backward', 5000);
  await sleep(250);
  await key('K');
  await until(`!Cut.app.playing`, 'K stops again', 5000);
  const tJ = await app('app.t');
  check(tJ < tK, `J plays backward (${(tK / F).toFixed(1)} -> ${(tJ / F).toFixed(1)} frames)`);
  await key('K', { up: false });
  await key('L');
  await key('K', { down: false });
  const tStep = await app('app.t');
  check(tStep === tJ + F && !(await app('app.playing')), 'L with K held steps one frame');

  // ---------- keys and typing, keys and focus ----------
  const before = await app(`({ t: app.t, n: app.sequence.clips.length })`);
  await click('.cut-project .cut-search');
  for (const [k, ch] of [['L', 'l'], ['Space', ' '], ['Comma', ','], ['J', 'j']]) await key(k, { text: ch });
  const typed = await S(`document.querySelector('.cut-project .cut-search').value`);
  const after = await app(`({ t: app.t, n: app.sequence.clips.length, playing: app.playing })`);
  check(typed === 'l ,j' && after.t === before.t && after.n === before.n && !after.playing, `keys typed in a field only type (${JSON.stringify(typed)})`);
  await key('Ctrl+A');
  await key('Backspace');
  await until(`document.querySelector('.cut-project .cut-search').value === ''`, 'search cleared again');
  await click('.cut-project .cut-panel-foot');
  check(await focusOf() === 'project', 'clicking the project panel gives it the keyboard');
  await key('ArrowRight');
  await key('I');
  await key('Space');
  check(await app(`app.t === ${before.t} && app.inOut.in === null && !app.playing`), 'transport keys do nothing while the project panel has the keyboard');
  await click(`.cut-project .cut-item-row[data-id="${media[0].id}"]`);
  const sel0 = await S(`[...document.querySelectorAll('.cut-project .cut-item-row.selected')].map((r) => r.dataset.kind).join() + ' ' + document.activeElement?.className`);
  await key('ArrowDown');
  const sel1 = await S(`[...document.querySelectorAll('.cut-project .cut-item-row.selected')].map((r) => r.dataset.kind).join()`);
  check(sel1 === 'sequence' && await app(`app.t === ${before.t}`), `the arrows move in the project list while it has the keyboard (${sel0} -> ${sel1})`);

  // ---------- undo and redo ----------
  await click('.cut-monitor-program .cut-monitor-head');
  await key('Ctrl+Z');
  check(await app(`app.sequence.clips.length === 4`), 'Ctrl+Z undoes the last insert');
  await key('Ctrl+Shift+Z');
  check(await app(`app.sequence.clips.length === 6`), 'Ctrl+Shift+Z redoes it');
  await click('.cut-topbar .cut-undo');
  check(await app(`app.sequence.clips.length === 4`), 'the Undo button undoes');
  await click('.cut-topbar .cut-redo');
  check(await app(`app.sequence.clips.length === 6`), 'the Redo button redoes');
  const lanes = await center('.cut-tl-lanes');
  const pic = await center('.cut-monitor-source .cut-monitor-frame');
  await mouse('mouseMoved', pic.x, pic.y);
  await mouse('mousePressed', pic.x, pic.y);
  const to = { x: lanes.l + lanes.w * 0.75, y: lanes.t + lanes.h * 0.4 };
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', pic.x + ((to.x - pic.x) * i) / 10, pic.y + ((to.y - pic.y) * i) / 10, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', to.x, to.y);
  await sleep(300);
  check(await app(`app.sequence.clips.length > 6`), 'dragging the source picture onto the timeline places the clip');
  await click('.cut-monitor-program .cut-monitor-head');
  await key('Ctrl+Z');
  check(await app(`app.sequence.clips.length === 6`), 'and undo takes it back');

  // ---------- save, autosave ----------
  answer({ saveAs: projectPath });
  await key('Ctrl+S');
  await until(`Cut.app.path && !Cut.ui.lifecycle.dirty`, 'saved', 10000);
  check(existsSync(projectPath) && JSON.parse(readFileSync(projectPath, 'utf8')).sequences[0].clips.length === 6, 'Ctrl+S on an untitled project asks where and saves it there');
  check(await S(`document.querySelector('.cut-project-title').textContent === 'shell-test' && !document.querySelector('.cut-root').classList.contains('dirty')`), 'the top bar shows the saved name');
  const autosaveDir = path.join(home, 'Autosave');
  const autosaves = () => (existsSync(autosaveDir) ? readdirSync(autosaveDir).filter((n) => n.startsWith('shell-test-') && n.endsWith('.ncut')) : []);
  const before2 = autosaves().length;
  const saved0 = await S(`Cut.ui.lifecycle.lastAutosave?.time || 0`);
  await key('Escape');
  check(await app(`app.selection.size === 0`), 'Escape clears the clip selection');
  await key('M');
  check(await app(`app.sequence.markers.length === 1 && Cut.ui.lifecycle.dirty`), 'M adds a sequence marker and the project is modified');
  await sleep(1200);
  check(autosaves().length === before2, 'no autosave before the edits have stopped for 2 s');
  await until(`(Cut.ui.lifecycle.lastAutosave?.time || 0) > ${saved0}`, 'autosaved', 8000);
  const saves = autosaves().sort();
  const count = saves.length;
  check(count === before2 + 1 && JSON.parse(readFileSync(path.join(autosaveDir, saves[count - 1]), 'utf8')).sequences[0].markers.length === 1,
    `the autosave file appears 2 s after the edit, with the edit in it (${before2} -> ${count})`);

  // ---------- export ----------
  await key('Ctrl+M');
  await until(`!!document.querySelector('#cutExportDialog')`, 'the export dialog');
  check(true, 'Ctrl+M opens the export dialog');
  await S(`(() => { const s = document.querySelector('#cutExportDialog .cut-export-preset'); s.value = '720p'; s.dispatchEvent(new Event('change')); })()`);
  const outFile = path.join(home, 'out.mp4');
  await S(`(() => { const i = document.querySelector('#cutExportDialog .cut-export-path'); i.value = ${JSON.stringify(outFile)}; i.dispatchEvent(new Event('input')); })()`);
  await sleep(200);
  await click('#cutExportDialog .cut-export-start');
  await until(`!!document.querySelector('#cutExportDialog .cut-export-result:not([hidden])')`, 'the export result', 240000);
  const result = await S(`({ ok: document.querySelector('#cutExportDialog .cut-export-result').dataset.ok, text: document.querySelector('#cutExportDialog .cut-export-result').textContent })`);
  check(result.ok === 'true' && existsSync(outFile) && statSync(outFile).size > 2000, `the export dialog exports the sequence to an MP4 (${result.text})`);
  check(/Checked/.test(result.text), 'the result says the written file was checked');
  await S(`[...document.querySelectorAll('#cutExportDialog .dialog-buttons button')].pop().click()`);
  await until(`!document.querySelector('#cutExportDialog')`, 'dialog closed');
  answer({ saveAs: path.join(home, 'frame.png') });
  await key('Ctrl+Shift+E');
  for (let i = 0; i < 100 && !existsSync(path.join(home, 'frame.png')); i++) await sleep(100);
  check(existsSync(path.join(home, 'frame.png')) && readFileSync(path.join(home, 'frame.png')).subarray(1, 4).toString() === 'PNG', 'Ctrl+Shift+E saves the program frame as a PNG');

  // ---------- captions ----------
  await click('.cut-ws-tab[data-ws="captions"]');
  await until(`Cut.ui.workspace === 'captions' && !!document.querySelector('.cut-grid .cut-captions')?.getClientRects().length`, 'the Captions and Graphics workspace');
  check(true, 'the workspace tab switches to Captions and Graphics');
  check(await S(`!!document.querySelector('.cut-grid .cut-panel[data-panel="program"]') && Cut.ui.monitors.program?.player`), 'the program monitor moved along with its player');
  const srtIn = path.join(home, 'in.srt');
  writeFileSync(srtIn, '1\r\n00:00:00,500 --> 00:00:01,500\r\n안녕하세요\r\n\r\n2\r\n00:00:01,600 --> 00:00:02,000\r\nSecond line\r\n');
  const n = await S(`Cut.ui.captions.importFile(Cut.app, ${JSON.stringify(srtIn)})`);
  await until(`document.querySelectorAll('.cut-captions .cut-cap-row').length === 2`, 'two caption rows');
  check(n === 2 && await app(`app.sequence.captions[0].items.map((x) => x.start / ${F} + '-' + x.end / ${F} + ':' + x.text).join('|') === '15-45:안녕하세요|48-60:Second line'`), 'an SRT file imports into the caption track');
  await click('.cut-captions .cut-cap-row:nth-child(2) .cut-cap-num');
  check(await app(`app.t === 48 * ${F}`), 'clicking a caption row moves the playhead to it');
  await click('.cut-captions .cut-cap-row:nth-child(1) .cut-cap-text');
  await key('Ctrl+A');
  await cdp('Input.insertText', { text: 'Hello captions' });
  check(await app(`app.sequence.captions[0].items[0].text === '안녕하세요'`), 'nothing is recorded while typing');
  await key('Enter');
  check(await app(`app.sequence.captions[0].items[0].text === 'Hello captions'`), 'Enter commits the caption text');
  const srtOut = path.join(home, 'caps.srt');
  answer({ saveAs: srtOut });
  await click('.cut-captions .cut-cap-export');
  for (let i = 0; i < 100 && !existsSync(srtOut); i++) await sleep(100);
  const written = existsSync(srtOut) ? readFileSync(srtOut, 'utf8') : '';
  check(written === '﻿1\r\n00:00:00,500 --> 00:00:01,500\r\nHello captions\r\n\r\n2\r\n00:00:01,600 --> 00:00:02,000\r\nSecond line\r\n' ||
    written.replace(/^﻿/, '').replace(/\r\n$/, '') === '1\r\n00:00:00,500 --> 00:00:01,500\r\nHello captions\r\n\r\n2\r\n00:00:01,600 --> 00:00:02,000\r\nSecond line\r\n',
  `the captions export to SRT (${JSON.stringify(written.slice(0, 80))})`);

  // ---------- screenshots of every workspace, dark and light ----------
  for (const theme of ['dark', 'light']) {
    await S(`ide.settings.set('appearance.theme', '${theme}')`);
    await sleep(300);
    for (const ws of ['editing', 'color', 'captions', 'export']) {
      await click(`.cut-ws-tab[data-ws="${ws}"]`);
      await until(`Cut.ui.workspace === '${ws}'`, ws);
      await sleep(400);
      await shot(`workspace-${ws}-${theme}.png`);
    }
  }
  await S(`ide.settings.set('appearance.theme', 'dark')`);
  await click('.cut-ws-tab[data-ws="editing"]');

  // ---------- new sequence, folder import ----------
  await click('.cut-project .cut-new-item');
  await clickMenuPath(ctx, ['Sequence…']);
  await until(`!!document.querySelector('#cutSequenceDialog')`, 'the new sequence dialog');
  await click('#cutSequenceDialog .dialog-buttons button.primary');
  await until(`Cut.app.project.sequences.length === 2 && Cut.app.sequenceId === Cut.app.project.sequences[1].id`, 'the new sequence is active');
  check(await app(`app.sequence.w === 1920 && app.sequence.clips.length === 0`), 'New Item › Sequence makes an empty 1080p sequence and opens it');
  await dblclick(`.cut-project .cut-item-row[data-id="${await app('app.project.sequences[0].id')}"]`);
  await until(`Cut.app.sequenceId === Cut.app.project.sequences[0].id`, 'back on the first sequence');
  const folder = path.join(home, 'Shoot');
  mkdirSync(path.join(folder, 'Day 2'), { recursive: true });
  copyFileSync(clipA, path.join(folder, 'one.mp4'));
  copyFileSync(clipB, path.join(folder, 'Day 2', 'two.mp4'));
  answer({ pickFolder: folder });
  await click('.cut-project .cut-new-item');
  await clickMenuPath(ctx, ['Import Folder…']);
  await until(`Cut.app.project.media.length === 4`, 'the folder imported', 30000);
  check(await app(`(() => { const p = app.project; const top = p.bins.find((b) => b.name === 'Shoot'); const sub = p.bins.find((b) => b.name === 'Day 2');
    const id = (n) => p.media.find((m) => m.name === n)?.id;
    return !!top && !!sub && sub.parent === top.id && top.items.includes(id('one.mp4')) && sub.items.includes(id('two.mp4')); })()`), 'a folder imports with its subfolders as bins');

  // ---------- closing with unsaved changes ----------
  await js(`ide.api.invoke('window:close')`).catch(() => {});
  await until(`!!document.querySelector('#cutSaveChanges')`, 'the save question before closing', 8000);
  check(await S(`document.querySelector('#cutSaveChanges').dataset.closing === 'true'`), 'closing the window with unsaved changes asks first');
  await click('#cutSaveChanges .dialog-buttons button:nth-child(3)');
  await sleep(500);
  check(await S(`!document.querySelector('#cutSaveChanges') && Cut.ui.lifecycle.dirty`), 'Cancel keeps the window and the changes');

  // ---------- New asks, Don't Save; Open brings the saved project back ----------
  await key('Ctrl+Alt+N');
  await until(`!!document.querySelector('#cutSaveChanges')`, 'the save question before New');
  await click('#cutSaveChanges .dialog-buttons button:nth-child(2)');
  await until(`!Cut.app.path && Cut.app.sequence.clips.length === 0`, 'a new untitled project');
  check(true, "New asks about the unsaved changes and Don't Save starts an untitled project");
  const movedDir = path.join(home, 'moved');
  mkdirSync(path.join(movedDir, 'deep'), { recursive: true });
  renameSync(clipB, path.join(movedDir, 'deep', 'clip-b.mp4'));
  answer({ pickProject: projectPath });
  await click('.cut-topbar .cut-open');
  await until(`Cut.app.path && Cut.app.sequence.clips.length === 6`, 'the saved project reopened', 10000);
  check(await app(`app.sequence.markers.length === 0 && app.sequence.captions.length === 0 && !Cut.ui.lifecycle.dirty && document.querySelector('.cut-project-title').textContent === 'shell-test'`),
    'Open brings back the project as it was saved');
  await until(`!!document.querySelector('#cutRelinkDialog')`, 'the relink dialog', 10000);
  check(await S(`document.querySelectorAll('#cutRelinkDialog .cut-relink-row.offline').length === 1 && document.querySelector('#cutRelinkDialog .cut-relink-name').textContent === 'clip-b.mp4'`),
    'opening a project whose file moved lists that file as offline');
  check(await S(`Cut.ui.offline.size === 1`), 'the project knows it is offline');
  answer({ pickFolder: movedDir });
  await click('#cutRelinkDialog .dialog-buttons button.primary');
  await until(`!document.querySelector('#cutRelinkDialog')`, 'relinked', 10000);
  check(await app(`Cut.ui.offline.size === 0 && app.project.media.find((m) => m.name === 'clip-b.mp4').path.toLowerCase() === ${JSON.stringify(path.join(movedDir, 'deep', 'clip-b.mp4').toLowerCase())}`),
    'Find in Folder relinks the file by name and size');

  // ---------- a crash, then the recovery offer ----------
  const lastSave = await S(`Cut.ui.lifecycle.lastAutosave?.time || 0`);
  await click('.cut-monitor-program .cut-monitor-head');
  await key('Home');
  await key('M');
  await key('ArrowRight');
  await key('M');
  await until(`Cut.app.sequence.markers.length === 2 && Cut.ui.lifecycle.dirty && (Cut.ui.lifecycle.lastAutosave?.time || 0) > ${lastSave}`, 'the edits autosaved', 8000);
  await sleep(300);
  ctx.close();
  const first = ctx;
  ({ ctx } = await start('cut-shell-2'));
  bind(ctx);
  ctx.results.unshift(...first.results);
  ctx.consoleErrors.unshift(...first.consoleErrors);
  ctx.cspViolations.unshift(...first.cspViolations);
  await until(`!!document.querySelector('#cutRecovery')`, 'the recovery offer', 15000);
  check(await S(`document.querySelector('#cutRecovery .cut-recovery-name').textContent === 'shell-test'`), 'after a crash the next start offers the autosave of the project');
  await click('#cutRecovery .dialog-buttons button.primary');
  await until(`Cut.app.sequence?.markers.length === 2`, 'recovered', 10000);
  check(await app(`app.path && app.path.toLowerCase().endsWith('shell-test.ncut') && Cut.ui.lifecycle.dirty && document.querySelector('.cut-root').classList.contains('dirty')`),
    'Recover opens the autosave as the project, modified until saved');
  check(JSON.parse(readFileSync(projectPath, 'utf8')).sequences[0].markers.length === 0, 'recovering does not write over the saved file');

  // ---------- closing: Don't Save closes the window ----------
  await js(`ide.api.invoke('window:close')`).catch(() => {});
  await until(`!!document.querySelector('#cutSaveChanges')`, 'the save question before closing', 8000);
  await mouse('mouseMoved', 0, 0);
  const dont = await center('#cutSaveChanges .dialog-buttons button:nth-child(2)');
  await mouse('mousePressed', dont.x, dont.y).catch(() => {});
  await mouse('mouseReleased', dont.x, dont.y).catch(() => {});
  let closed = false;
  for (let i = 0; i < 50 && !closed; i++) {
    await sleep(100);
    closed = await js('1').then(() => false, () => true);
  }
  check(closed, "Don't Save closes the window");
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await shot('failure.png').catch(() => {});
}
const result = ctx.finish;
try { rmSync(home, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true }); } catch {}
result();
