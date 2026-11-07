// Nano Studio Cut's convenience tools in the real app (features §2, §15 [2], §16, §17, §18 [2]), with real clicks and
// keys (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and what the project, the files or the pixels then show:
// - keys: the shortcut editor from the top bar's settings menu and from Find Action; a recorded key works at once,
//   a removed one no longer does, a key two actions share is marked and keeps Save disabled until resolved, Reset and
//   Reset All bring the built-in keys back; the keys live in `cut.keys`; the ? cheat sheet shows the current keys by
//   kind and closes with Esc or another ?;
// - settings: the Video Editor page in the settings window (Code's and Craft's pages stay as they are): the default
//   transition length reaches Ctrl+D at once, the playback quality reaches both monitors, Clear Cache empties the cache
//   and shows the size, the copies to keep rotate the interval autosaves;
// - media: Select Unused (across bins), Remove Unused after a confirmation listing them (one undo step), Find Missing
//   Media relinking from a folder picked through PYIDE_CUT_DIALOG (by name and size, and by name and duration);
// - proxy: the offer on importing a long-GOP 1080p test source, Create Proxies making a 720p H.264 file with a
//   keyframe every 15 frames in the cache, the monitor's Proxy switch drawing it (pixels), export drawing the original
//   (pixels of the written file), a deleted proxy falling back to the original, a proxy job waiting while the program
//   plays and cancelled, the offer dismissed for the project;
// - queue: jobs added from the Export workspace run one at a time in order while the project changes (a later edit
//   does not reach a queued job), move up, cancel, retry and remove, survive workspace switches, and closing the window
//   while one runs asks first;
// - screenshots in the dark and the light theme (verify/out/cut-tools/*.png).
// - drop: files and a folder dragged from Explorer onto the timeline are imported (a file already in the project is
//   used again) and placed where dropped, Ctrl inserting, one undo step, never opened in the code editor;
// - speed: the clip menu's Speed submenu (quick speeds, Reverse, disabled for a still) and the Speed section of Effect
//   Controls (typed speed, Reverse, Reset), later clips moving along;
// - volume: an audio track header's volume, 0 to 200% (drag, Alt+click, double-click to type, the track menu), one
//   undo step a change, and the mix playing the track at that level;
// - highlight: captions made from recognised words light the word being spoken once Caption Style turns it on: read
//   from the program monitor's pixels at each word's first frame and the frame before, while scrubbing its bar, and on
//   every frame read back while playing, and from the exported file's frames; with a second caption track, the monitor
//   and the export panel's burn-in follow the track chosen in the captions panel (the stopped monitor redrawn at once,
//   the export panel naming it, the written file's pixels); editing the caption text in the panel
//   keeps the matching words' timings (undo and redo exact), a rewritten caption shows unlit, the box style, and the
//   timings saved in the project file and opened again;
// Usage: node verify/cut-tools.mjs   (CUT_TOOLS_ONLY=keys,settings,media,proxy,queue,drop,speed,volume,highlight,shots)
import fs from 'fs';
import path from 'path';
import { launch, tempDir, menuRow } from './lib.mjs';

const ONLY = (process.env.CUT_TOOLS_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = fs.realpathSync.native(tempDir('cut-tools-home'));
const dialogFile = path.join(home, 'dialog.json');
const answer = (o) => fs.writeFileSync(dialogFile, JSON.stringify(o));
answer({});
const ctx = await launch({ fixture: 'core', port: 9765, name: 'cut-tools', mode: 'cut', env: { PYIDE_CUT_HOME: home, PYIDE_CUT_DIALOG: dialogFile } });
const { js, until, check, cdp, press, type, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'testsrc', 'export', 'probe', 'audioengine', 'media'].every((k) => !!Cut[k]) && !!Cut.ui.shortcuts && !!Cut.ui.proxy && !!Cut.ui.exportQueue && Cut.ui.panels.has('queue') && typeof Cut.ui.settingsButton === 'function'`),
  'the modules and panels this suite uses are loaded');

// ---------- page helpers ----------
await js(`(() => {
  const T = Cut.time.TICKS;
  const H = (window.__ct = {});
  H.seq = () => Cut.app.sequence;
  H.fake = (id, secs = 20) => ({ path: 'C:\\\\nowhere\\\\' + id + '.mp4', name: id + '.mp4', kind: 'video', size: 1000, mtime: 1, duration: secs * T,
    video: { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 }, audio: null });
  // A fresh 1080p30 project: media entries, clips [{media, in, len, at}] (seconds), bins {name: [media index]}.
  H.fresh = async (spec = {}) => {
    const C = Cut.commands;
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1] }, settings: Cut.ui.projectDefaults() }));
    const seq = h.project.sequences[0];
    const ids = spec.media?.length ? h.do(C.importMedia(spec.media)).ids : [];
    for (const c of spec.clips || []) h.do(C.place(seq.id, { source: { media: ids[c.media ?? 0] }, in: (c.in || 0) * T, out: ((c.in || 0) + c.len) * T, at: c.at * T, video: 'V1', audio: null, mode: 'overwrite' }));
    for (const [name, list] of Object.entries(spec.bins || {})) { const b = h.do(C.addBin(name, null)).id; h.do(C.moveToBin(list.map((i) => ids[i]), b)); }
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
    Cut.app.setTime(0);
    Cut.app.select([]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tl = Cut.ui.timeline;
    tl?.setZoom?.(60, { t: 0, x: 0 });
    tl?.setScroll?.(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { media: Cut.app.project.media.map((m) => m.id), clips: Cut.app.sequence.clips.map((c) => c.id) };
  };
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
  H.visible = (sel) => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); if (!r.width || !r.height) return false; const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && n.contains(hit); };
  H.write = async (file, opts) => { const r = await Cut.testsrc.write(file, opts); return r.ok ? 'ok' : JSON.stringify(r.error); };
  // A file's video track: size, codec, frame count, the longest run of frames between keyframes, audio or not.
  H.probe = async (file) => {
    const rd = await Cut.audioengine.fileReader(file);
    const src = await Cut.probe.open(rd, { name: file });
    const vt = src.tracks.find((t) => t.kind === 'video');
    let last = -1, gop = 0;
    for (let i = 0; i < (vt?.samples.count || 0); i++) if (vt.samples.key[i]) { if (last >= 0) gop = Math.max(gop, i - last); last = i; }
    if (vt) gop = Math.max(gop, vt.samples.count - last);
    return { w: vt?.width, h: vt?.height, codec: vt?.codec, frames: vt?.samples.count, gop, audio: src.tracks.some((t) => t.kind === 'audio'), duration: vt ? src.duration / T : 0 };
  };
  // The background of a picture (left of the digits, above the moving bar): [r, g, b].
  const at = (px, w, h) => { const x = Math.round(w * 0.08), y = Math.round(h * 0.7), i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  // The program monitor's picture is letterboxed in its canvas: the point is taken inside the frame.
  H.programBackground = async () => {
    const m = Cut.ui.monitors.program;
    await m.player.render();
    const comp = m.player.compositor;
    await comp.idle?.();
    const px = await comp.readPixels();
    const fr = m.player.frameRect();
    const k = comp.width / (m.canvas.clientWidth || comp.width);
    const x = Math.round((fr.x + fr.w * 0.08) * k), y = Math.round((fr.y + fr.h * 0.7) * k), i = (y * comp.width + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  H.fileBackground = async (file, index = 0) => {
    const rd = await Cut.audioengine.fileReader(file);
    const src = await Cut.probe.open(rd, { name: file });
    const vt = src.tracks.find((t) => t.kind === 'video');
    const k = Cut.probe.keyBefore(vt, index);
    const r = await Cut.export.decodeRange(rd, vt, k, index, { pixels: true });
    return r.pixels ? at(r.pixels, vt.width, vt.height) : null;
  };
  return true;
})()`);

const mouse = (t, x, y, { buttons = t === 'mouseReleased' ? 0 : 1, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type: t, x, y, button, buttons: t === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount });
async function clickAt(p, { button = 'left' } = {}) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y, { button, buttons: button === 'right' ? 2 : 1 });
  await mouse('mouseReleased', p.x, p.y, { button, buttons: 0 });
  await sleep(100);
}
const rect = (sel) => js(`__ct.rect(${S(sel)})`);
async function clickSel(sel, opts) {
  await until(`!!__ct.rect(${S(sel)})?.w`, `the element ${sel}`, 8000);
  await js(`(document.querySelector(${S(sel)}).scrollIntoView({ block: 'nearest' }), true)`);
  await clickAt(await rect(sel), opts);
}
async function menuClick(label, level = 0) {
  await until(`!!${menuRow(label, level)}`, `menu item ${label}`, 4000);
  const p = await js(`(() => { const r = ${menuRow(label, level)}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await clickAt(p);
}
const menuLabels = () => js(`[...document.querySelectorAll('.context-menu[data-level="0"] > .menu-item')].map((r) => r.querySelector('.menu-label')?.textContent)`);
async function space() {
  const base = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
async function workspace(id) {
  await clickSel(`.cut-ws-tab[data-ws="${id}"]`);
  await sleep(200);
}
async function showTab(panel) {
  await clickSel(`.cut-grid .cut-slot-tab[data-panel="${panel}"]`);
  await sleep(150);
}
// An empty spot of the V2 row: the timeline takes the keyboard.
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
async function focusProgram() {
  await clickSel('.cut-monitor-program .cut-monitor-head');
}
const markers = () => js('__ct.seq().markers.length');
async function closeDialogs() {
  await js(`(document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()), ide.ui.closeMenus?.(), Cut.ui.shortcuts.closeSheet(), true)`);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await closeDialogs();
}

// ---------- the shortcut editor and the ? cheat sheet ----------
await section('keys', async () => {
  await workspace('editing');
  await js(`__ct.fresh({ media: [__ct.fake('a')], clips: [{ at: 0, len: 6 }, { at: 6, len: 6, in: 7 }] })`);
  check(S(await js(`Cut.ui.shortcuts.current('Cut.addMarker')`)) === S(['M']), 'Add Marker starts with its built-in key M');
  // from the top bar's settings menu
  await clickSel('.cut-topbar .cut-settings-btn');
  const items = await menuLabels();
  check(['Video Editor Settings…', 'Keyboard Shortcuts…', 'Keyboard Shortcut Overview'].every((x) => items.includes(x)), `the top bar's settings menu has the settings, the shortcut editor and the overview (${S(items)})`);
  await menuClick('Keyboard Shortcuts…');
  await until(`!!document.querySelector('#cutKeysDialog')`, 'the shortcut editor');
  const listed = await js(`(() => { const ids = [...document.querySelectorAll('#cutKeysDialog .cut-keys-row')].map((r) => r.dataset.id); const cut = ide.actions.filter((a) => a.id.startsWith('Cut.') && a.title).map((a) => a.id);
    return { rows: ids.length, all: cut.every((id) => ids.includes(id)), kinds: [...document.querySelectorAll('#cutKeysDialog .cut-keys-kind')].map((k) => k.textContent) }; })()`);
  check(listed.all && listed.rows > 80 && listed.kinds.includes('Playback and Navigation') && listed.kinds.includes('Tools'), `the editor lists every Cut action, grouped by kind (${listed.rows} rows; ${S(listed.kinds)})`);
  // search, then record Shift+M for Add Marker
  await clickSel('#cutKeysDialog .cut-keys-search');
  await type('Add Marker');
  await sleep(150);
  check(await js(`[...document.querySelectorAll('#cutKeysDialog .cut-keys-row')].map((r) => r.dataset.id).join(',') === 'Cut.addMarker'`), 'the search finds Add Marker by its name');
  await clickSel('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-keys-record');
  check(await js(`!!document.querySelector('#cutKeysDialog .cut-keys-row.recording .cut-keys-listening')`), 'Record waits for a key');
  await press('Shift+M');
  await sleep(100);
  check(await js(`[...document.querySelectorAll('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-key-chip')].map((c) => c.dataset.key).join(',') === 'M,Shift+M' && !!document.querySelector('#cutKeysDialog')`),
    'the pressed key joins the action (and the dialog stays open)');
  await clickSel('#cutKeysDialog .cut-keys-save');
  await until(`!document.querySelector('#cutKeysDialog')`, 'saved');
  check(S(await js(`ide.settings.get('cut.keys')`)) === S({ 'Cut.addMarker': ['M', 'Shift+M'] }), `Save stores only the change in cut.keys (${S(await js(`ide.settings.get('cut.keys')`))})`);
  await focusTimeline();
  await js(`(Cut.app.setTime(${2 * T}), true)`);
  const m0 = await markers();
  await press('Shift+M');
  check((await markers()) === m0 + 1, 'the recorded key works at once, without a restart');
  await js(`(Cut.app.setTime(${3 * T}), true)`);
  await press('M');
  check((await markers()) === m0 + 2, 'the built-in key still works too');

  // the cheat sheet shows the current keys
  await press('Shift+/');
  await until(`!!document.querySelector('.cut-keysheet')`, 'the cheat sheet', 3000);
  const sheet = await js(`(() => { const row = document.querySelector('.cut-keysheet-row[data-id="Cut.addMarker"]'); return { visible: __ct.visible('.cut-keysheet-box'),
    groups: [...document.querySelectorAll('.cut-keysheet-group h3')].map((h) => h.textContent), keys: row ? [...row.querySelectorAll('kbd')].map((k) => k.textContent) : null,
    split: [...(document.querySelector('.cut-keysheet-row[data-id="Cut.split"]')?.querySelectorAll('kbd') || [])].map((k) => k.textContent) }; })()`);
  check(sheet.visible && ['Playback and Navigation', 'Marking', 'Editing', 'Tools', 'Project'].every((g) => sheet.groups.includes(g)), `? shows the cheat sheet grouped by kind (${S(sheet.groups)})`);
  check(S(sheet.keys) === S(['M', 'Shift+M']) && S(sheet.split) === S(['Ctrl+K']), `the sheet shows the current keys (${S(sheet.keys)}, ${S(sheet.split)})`);
  await press('Escape');
  check(!(await js(`!!document.querySelector('.cut-keysheet')`)), 'Esc closes the cheat sheet');
  await press('Shift+/');
  check(await js(`!!document.querySelector('.cut-keysheet')`), '? opens it again');
  await press('Shift+/');
  check(!(await js(`!!document.querySelector('.cut-keysheet')`)), 'another ? closes it');

  // conflicts: Ctrl+K is Add Edit's
  await js(`(ide.runAction('Cut.keyboardShortcuts'), true)`);
  await until(`!!document.querySelector('#cutKeysDialog')`, 'the shortcut editor from Find Action');
  check(true, 'the editor opens as the action Cut.keyboardShortcuts (Find Action)');
  await clickSel('#cutKeysDialog .cut-keys-search');
  await type('Add Marker');
  await sleep(120);
  await clickSel('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-keys-record');
  await press('Ctrl+K');
  await sleep(100);
  const clash = await js(`({ chip: !!document.querySelector('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-key-chip.conflict[data-key="Ctrl+K"]'),
    note: document.querySelector('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-keys-conflict')?.textContent || '',
    disabled: document.querySelector('#cutKeysDialog .cut-keys-save').disabled, status: document.querySelector('#cutKeysDialog .cut-keys-status').textContent })`);
  check(clash.chip && /Add Edit/.test(clash.note) && clash.disabled && /more than one action: 1/.test(clash.status), `a key Add Edit has is marked as a conflict and Save is disabled (${S(clash)})`);
  await clickSel('#cutKeysDialog .cut-keys-save');
  check(await js(`!!document.querySelector('#cutKeysDialog')`) && S(await js(`ide.settings.get('cut.keys')`)) === S({ 'Cut.addMarker': ['M', 'Shift+M'] }), 'Save does nothing while the conflict stands');
  await clickSel('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-key-chip[data-key="Ctrl+K"] .cut-key-remove');
  await clickSel('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-key-chip[data-key="M"] .cut-key-remove');
  check(await js(`!document.querySelector('#cutKeysDialog .cut-keys-save').disabled && !document.querySelector('#cutKeysDialog .cut-key-chip.conflict')`), 'removing the clashing key clears the conflict');
  await clickSel('#cutKeysDialog .cut-keys-save');
  await until(`!document.querySelector('#cutKeysDialog')`, 'saved');
  await focusTimeline();
  await js(`(Cut.app.setTime(${4 * T}), true)`);
  const m1 = await markers();
  await press('M');
  check((await markers()) === m1, 'a removed key no longer adds a marker');
  await press('Shift+M');
  check((await markers()) === m1 + 1, 'the remaining key still does');
  const split0 = await js('__ct.seq().clips.length');
  await js(`(Cut.app.setTime(${2.5 * T}), true)`);
  await press('Ctrl+K');
  check((await js('__ct.seq().clips.length')) === split0 + 1, 'Ctrl+K stays Add Edit');

  // Reset and Reset All
  await clickSel('.cut-topbar .cut-settings-btn');
  await menuClick('Keyboard Shortcuts…');
  await until(`!!document.querySelector('#cutKeysDialog')`, 'the shortcut editor');
  await clickSel('#cutKeysDialog .cut-keys-search');
  await type('Add Marker');
  await sleep(120);
  check(await js(`document.querySelector('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"]').classList.contains('modified')`), 'a changed action is marked modified');
  await clickSel('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-keys-reset');
  check(await js(`[...document.querySelectorAll('#cutKeysDialog .cut-keys-row[data-id="Cut.addMarker"] .cut-key-chip')].map((c) => c.dataset.key).join(',') === 'M'`), 'Reset brings back the built-in key');
  // Record Q for Zoom In too, then Reset All
  await js(`(() => { const s = document.querySelector('#cutKeysDialog .cut-keys-search'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
  await js(`(document.querySelector('#cutKeysDialog .cut-keys-row[data-id="Cut.zoomIn"]').scrollIntoView({ block: 'center' }), true)`);
  await clickSel('#cutKeysDialog .cut-keys-row[data-id="Cut.zoomIn"] .cut-keys-record');
  await press('Alt+Shift+Z');
  check(await js(`[...document.querySelectorAll('#cutKeysDialog .cut-keys-row[data-id="Cut.zoomIn"] .cut-key-chip')].map((c) => c.dataset.key).includes('Alt+Shift+Z')`), 'another key recorded');
  await clickSel('#cutKeysDialog .cut-keys-reset-all');
  check(await js(`[...document.querySelectorAll('#cutKeysDialog .cut-keys-row.modified')].length === 0 && document.querySelector('#cutKeysDialog .cut-keys-reset-all').disabled`), 'Reset All brings every action back to its built-in keys');
  await clickSel('#cutKeysDialog .cut-keys-save');
  await until(`!document.querySelector('#cutKeysDialog')`, 'saved');
  check(S(await js(`ide.settings.get('cut.keys')`)) === S({}), 'after Reset All nothing is stored');
  await focusTimeline();
  await js(`(Cut.app.setTime(${5 * T}), true)`);
  const m2 = await markers();
  await press('Shift+M');
  await press('M');
  check((await markers()) === m2 + 1, 'M adds a marker again and Shift+M no longer does');
  // a key in a field is typing, not an action
  await js(`(ide.settings.set('cut.keys', { 'Cut.window.history': ['G'] }), true)`);
  await clickSel('.cut-panel[data-panel="project"] .cut-search').catch(() => {});
  await press('G');
  check((await js(`Cut.app.focusPanel`)) !== 'history', 'a single-letter key of a Window action does not fire while typing in a field');
  await js(`(ide.settings.set('cut.keys', {}), true)`);
});

// ---------- the Video Editor settings page ----------
await section('settings', async () => {
  await workspace('editing');
  // a project the shell adopted (its autosaves count its edits)
  await js(`Cut.ui.lifecycle.newProject({ ask: false }).then(() => { const C = Cut.commands, h = Cut.app.history, s = __ct.seq(); const id = h.do(C.importMedia([__ct.fake('a')])).ids[0];
    h.do(C.place(s.id, { source: { media: id }, in: 0, out: ${4 * T}, at: 0, video: 'V1', audio: null, mode: 'overwrite' }));
    h.do(C.place(s.id, { source: { media: id }, in: ${5 * T}, out: ${9 * T}, at: ${4 * T}, video: 'V1', audio: null, mode: 'overwrite' })); return true; })`);
  await clickSel('.cut-topbar .cut-settings-btn');
  await menuClick('Video Editor Settings…');
  await until(`document.querySelector('.settings-page')?.dataset.page === 'cut'`, 'the Video Editor page', 8000);
  const nav = await js(`[...document.querySelectorAll('.settings-nav-row')].filter((n) => n.offsetParent).map((n) => n.dataset.page || n.dataset.group)`);
  check(nav.includes('cut') && nav.includes('appearance') && !nav.includes('editor') && !nav.includes('interpreter'), `Cut's settings window shows its page and the shared ones, not the IDE's (${S(nav)})`);
  const fields = await js(`['cut.autosave.minutes', 'cut.autosave.keep', 'cut.cacheLimitGB', 'cut.transitionSeconds', 'cut.stillSeconds', 'cut.quality', 'cut.proxy', 'cut.proxy.offer', 'cut.proxy.height'].filter((k) => !document.querySelector('.settings-page [data-key="' + k + '"]'))`);
  check(!fields.length, `the page has every setting (${S(fields)} missing)`);
  // the default transition length
  const setField = async (key, value) => {
    await clickSel(`.settings-page [data-key="${key}"]`);
    await press('Ctrl+A');
    await type(String(value));
    await sleep(80);
  };
  await setField('cut.transitionSeconds', 2);
  await setField('cut.autosave.keep', 3);
  await js(`(() => { const s = document.querySelector('.settings-page [data-key="cut.quality"]'); s.value = '0.5'; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(`!!document.querySelector('.cut-cache-size')?.dataset.bytes`, 'the cache size', 8000);
  await clickSel('#settingsOk');
  await until(`!document.querySelector('.settings-dialog')`, 'the settings window closed');
  check(await js(`Cut.app.project.settings.transitionDuration === ${2 * T} && Cut.app.history.list().at(-1)?.label === 'Project Settings'`), 'the new default transition length reaches the open project as one undo step');
  check(await js(`ide.settings.get('cut.program.quality') === 0.5 && Cut.ui.monitors.program.player.quality === 0.5 && Cut.ui.monitors.program.qualitySelect.value === '0.5'`), 'the playback quality reaches the program monitor at once');
  // Ctrl+D on the edit at 4 s makes a 2 s transition
  await focusTimeline();
  const clipA = await js(`__ct.seq().clips.find((c) => c.start === 0).id`);
  await js(`(Cut.app.select([${S(clipA)}]), true)`);
  await press('Ctrl+D');
  const trs = await js(`__ct.seq().transitions.map((t) => ({ at: t.at / ${T}, d: t.duration / ${T} }))`);
  check(trs.some((t) => t.at === 4 && t.d === 2), `Ctrl+D uses the new default length (${S(trs)})`);
  check(await js(`Cut.ui.projectDefaults().transitionDuration === ${2 * T}`), 'a new project takes it too');

  // autosave copies keep the newest 3
  for (let i = 0; i < 5; i++) {
    await js(`(Cut.app.history.do(Cut.commands.addMarker(__ct.seq().id, { t: ${(i + 1) * T} })), true)`);
    await js(`Cut.ui.lifecycle.autosaveCopy().then(() => true)`);
  }
  const key = await js('Cut.ui.lifecycle.key');
  const copies = fs.readdirSync(path.join(home, 'Autosave')).filter((n) => n.startsWith(key) && n.endsWith('.ncut') && !n.endsWith('.latest.ncut'));
  check(copies.length === 3, `the interval copies keep the newest 3 as set (${copies.length})`);
  await js(`Cut.ui.lifecycle.autosaveNow().then(() => true)`);
  const latest = fs.readdirSync(path.join(home, 'Autosave')).filter((n) => n.startsWith(key) && n.endsWith('.latest.ncut'));
  check(latest.length === 1 && fs.readdirSync(path.join(home, 'Autosave')).filter((n) => n.startsWith(key) && !n.endsWith('.latest.ncut') && n.endsWith('.ncut')).length === 3,
    'the 2 s save keeps one latest state beside the copies');

  // Clear Cache
  await js(`ide.api.invoke('cut:cachePut', 'thumb:test', new Uint8Array(4096)).then(() => true)`);
  await js(`(ide.openSettings('cut'), true)`);
  await until(`Number(document.querySelector('.cut-cache-size')?.dataset.bytes) >= 4096`, 'the cache size with the entry', 8000);
  const before = await js(`document.querySelector('.cut-cache-size').textContent`);
  await clickSel('.cut-cache-clear');
  await until(`!!document.querySelector('.dialog-backdrop:last-child .dialog-buttons button.primary')`, 'the clear question');
  await js(`(document.querySelector('.dialog-backdrop:last-child .dialog-buttons button.primary').scrollIntoView(), true)`);
  await clickSel('.dialog-backdrop:last-child .dialog-buttons button.primary');
  await until(`document.querySelector('.cut-cache-size')?.dataset.bytes === '0'`, 'the cache cleared', 8000);
  check((await js(`ide.api.invoke('cut:cacheGet', 'thumb:test')`)) === null, `Clear Cache empties the cache and shows the new size (${before} -> ${await js(`document.querySelector('.cut-cache-size').textContent`)})`);
  await clickSel('#settingsCancel');
  // back to the defaults for the other sections
  await js(`(['cut.transitionSeconds', 'cut.autosave.keep', 'cut.quality'].forEach((k) => ide.settings.set(k, Cut.ui.settingDefaults[k])), true)`);
});

// ---------- media cleanup and relink ----------
await section('media', async () => {
  await workspace('editing');
  const dir = path.join(home, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, n);
  for (const [n, secs] of [['a.mp4', 3], ['b.mp4', 2], ['c.mp4', 2]]) {
    const r = await js(`__ct.write(${S(file(n))}, { seconds: ${secs}, fps: [30, 1], w: 320, h: 180, keyEvery: 1 })`);
    if (r !== 'ok') throw new Error(`testsrc ${n}: ${r}`);
  }
  await js(`__ct.fresh({})`);
  await showTab('project');
  answer({ pickMedia: [file('a.mp4'), file('b.mp4'), file('c.mp4')] });
  await clickSel('.cut-panel[data-panel="project"] .cut-import');
  await until(`Cut.app.project.media.length === 3`, 'imported', 20000);
  const ids = await js(`Cut.app.project.media.map((m) => m.id)`);
  await js(`(() => { const C = Cut.commands, h = Cut.app.history, s = __ct.seq(); h.do(C.place(s.id, { source: { media: ${S(ids[0])} }, in: 0, out: ${2 * T}, at: 0, video: 'V1', audio: null, mode: 'overwrite' }));
    const b = h.do(C.addBin('Old', null)).id; h.do(C.moveToBin([${S(ids[2])}], b)); return true; })()`);
  await sleep(200);
  await clickSel('.cut-panel[data-panel="project"] .cut-project-more');
  await menuClick('Select Unused Media');
  await sleep(200);
  const sel = await js(`({ shown: [...document.querySelectorAll('.cut-panel[data-panel="project"] .cut-items [data-id]')].map((n) => n.dataset.id), selected: Cut.ui.media.selected(),
    crumb: document.querySelector('.cut-panel[data-panel="project"] .cut-crumb-search')?.textContent })`);
  check(S(sel.selected.sort()) === S([ids[1], ids[2]].sort()) && S(sel.shown.sort()) === S([ids[1], ids[2]].sort()) && /Unused/.test(sel.crumb || ''),
    `Select Unused shows and selects the media no sequence uses, also the one in a bin (${S(sel)})`);
  await clickSel('.cut-panel[data-panel="project"] .cut-crumb-all');
  check(await js(`Cut.ui.media.filter() === null`), 'Show All goes back to the bins');
  const steps0 = await js('Cut.app.history.position');
  await clickSel('.cut-panel[data-panel="project"] .cut-project-more');
  await menuClick('Remove Unused Media…');
  await until(`!!document.querySelector('#cutRemoveUnused')`, 'the confirmation');
  const listedNames = await js(`[...document.querySelectorAll('#cutRemoveUnused li')].map((li) => li.textContent)`);
  check(S(listedNames.sort()) === S(['b.mp4', 'c.mp4']), `the confirmation lists what goes (${S(listedNames)})`);
  await clickSel('#cutRemoveUnused .dialog-buttons button.primary');
  await until(`Cut.app.project.media.length === 1`, 'removed');
  check(await js(`Cut.app.history.position === ${steps0 + 1} && Cut.app.history.list().at(-1).label === 'Remove Media' && Cut.app.project.media[0].name === 'a.mp4' && __ct.seq().clips.length === 1`),
    'Remove Unused takes them out in one undo step and keeps the used one and its clip');
  check(fs.existsSync(file('b.mp4')) && fs.existsSync(file('c.mp4')), 'the files stay on disk');
  await clickSel('.cut-topbar .cut-undo');
  await until(`Cut.app.project.media.length === 3`, 'undone');
  check(await js(`Cut.app.project.bins[0].items.includes(${S(ids[2])})`), 'undo brings them back, into their bin');

  // a moved file (same size) and a re-encoded one (same name and duration, another size)
  const moved = path.join(home, 'moved', 'deep');
  fs.mkdirSync(moved, { recursive: true });
  fs.renameSync(file('a.mp4'), path.join(moved, 'a.mp4'));
  fs.rmSync(file('c.mp4'));
  const r = await js(`__ct.write(${S(path.join(moved, 'c.mp4'))}, { seconds: 2, fps: [30, 1], w: 320, h: 180, keyEvery: 1, bitrate: 900000 })`);
  if (r !== 'ok') throw new Error(`testsrc c again: ${r}`);
  check(fs.statSync(path.join(moved, 'c.mp4')).size !== (await js(`Cut.app.project.media.find((m) => m.name === 'c.mp4').size`)), 'the new c.mp4 has another size');
  await clickSel('.cut-panel[data-panel="project"] .cut-project-more');
  await menuClick('Find Missing Media…');
  await until(`!!document.querySelector('#cutRelinkDialog')`, 'the relink dialog', 10000);
  const offline = await js(`[...document.querySelectorAll('#cutRelinkDialog .cut-relink-row.offline .cut-relink-name')].map((n) => n.textContent).sort()`);
  check(S(offline) === S(['a.mp4', 'c.mp4']), `Find Missing Media checks every file and lists the missing ones (${S(offline)})`);
  answer({ pickFolder: path.join(home, 'moved') });
  await clickSel('#cutRelinkDialog .dialog-buttons button.primary');
  await until(`!document.querySelector('#cutRelinkDialog')`, 'relinked', 15000);
  const paths = await js(`Object.fromEntries(Cut.app.project.media.map((m) => [m.name, m.path.toLowerCase()]))`);
  check(paths['a.mp4'] === path.join(moved, 'a.mp4').toLowerCase() && paths['c.mp4'] === path.join(moved, 'c.mp4').toLowerCase() && paths['b.mp4'] === file('b.mp4').toLowerCase() && (await js('Cut.ui.offline.size')) === 0,
    `the folder picked relinks by name and size, and by name and duration (${S(paths)})`);
  await clickSel('.cut-panel[data-panel="project"] .cut-project-more');
  await menuClick('Find Missing Media…');
  await sleep(400);
  check(!(await js(`!!document.querySelector('#cutRelinkDialog')`)), 'with nothing missing no dialog opens');
});

// ---------- proxies ----------
await section('proxy', async () => {
  await workspace('editing');
  const dir = path.join(home, 'proxy-media');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'p.mp4');
  for (const [f, opts] of [[p, { seconds: 3, keyEvery: 5 }], [path.join(dir, 'long.mp4'), { seconds: 20, keyEvery: 1 }], [path.join(dir, 'q.mp4'), { seconds: 4, keyEvery: 5 }], [path.join(dir, 'q2.mp4'), { seconds: 4, keyEvery: 5 }]]) {
    const r = await js(`__ct.write(${S(f)}, { fps: [30, 1], w: 1920, h: 1080, ...${S(opts)} })`);
    if (r !== 'ok') throw new Error(`testsrc ${f}: ${r}`);
  }
  await js(`(ide.settings.set('cut.proxy', false), true)`);
  await js(`__ct.fresh({})`);
  await showTab('project');
  answer({ pickMedia: [p] });
  await clickSel('.cut-panel[data-panel="project"] .cut-import');
  await until(`Cut.app.project.media.length === 1`, 'imported', 20000);
  await until(`!!document.querySelector('.cut-proxy-offer')`, 'the proxy offer', 8000);
  check(/keyframes far apart/.test(await js(`document.querySelector('.cut-proxy-offer-text').textContent`)), 'importing a 1080p file with keyframes 5 s apart offers proxies and says why');
  await clickSel('.cut-proxy-offer-create');
  const id = await js(`Cut.app.project.media[0].id`);
  await until(`!!Cut.app.project.media[0].proxy`, 'the proxy made', 60000);
  const pp = await js(`Cut.app.project.media[0].proxy.path`);
  const info = await js(`__ct.probe(${S(pp)})`);
  check(pp.toLowerCase().startsWith(path.join(home, 'Cache').toLowerCase()) && fs.existsSync(pp), `the proxy is written in the Cut cache (${pp})`);
  check(info.w === 1280 && info.h === 720 && /^avc1/.test(info.codec) && info.frames === 90 && info.gop <= 15 && !info.audio,
    `it is 720p H.264, every frame, a keyframe at least every 15 frames, no sound (${S(info)})`);
  check(await js(`Cut.app.history.list().at(-1).label === 'Proxy' && document.querySelector('.cut-panel[data-panel="project"] [data-id="${id}"] .cut-proxy-badge')?.dataset.state === 'ready'`),
    'the media gets its proxy in one undo step and the panel shows it');
  // A proxy with another picture, so the pixels tell which file a monitor or an export draws.
  const red = path.join(dir, 'red.mp4');
  const rr = await js(`__ct.write(${S(red)}, { seconds: 3, fps: [30, 1], w: 1280, h: 720, keyEvery: 0.5, background: '#c03030' })`);
  if (rr !== 'ok') throw new Error(`testsrc red: ${rr}`);
  fs.copyFileSync(red, pp);
  await js(`(() => { const C = Cut.commands, s = __ct.seq(); Cut.app.history.do(C.place(s.id, { source: { media: ${S(id)} }, in: 0, out: ${3 * T}, at: 0, video: 'V1', audio: null, mode: 'overwrite' })); Cut.app.setTime(${1.5 * T}); return true; })()`);
  await sleep(300);
  const original = await js('__ct.programBackground()');
  await clickSel('.cut-monitor-program .cut-tr-proxy');
  await sleep(400);
  const proxied = await js('__ct.programBackground()');
  check(original[0] < 80 && original[2] > original[0] && proxied[0] > 140 && proxied[1] < 100, `the program monitor's Proxy switch draws the proxy (${S(original)} -> ${S(proxied)})`);
  check(await js(`ide.settings.get('cut.proxy') === true`), 'the switch is the setting cut.proxy');
  // export reads the original even with proxies on
  const out = path.join(home, 'with-proxy-on.mp4');
  const ex = await js(`Cut.export.run({ project: Cut.app.project, seqId: __ct.seq().id, path: ${S(out)}, preset: '720p', overrides: { loudness: null } }).then((r) => ({ ok: r.ok, error: r.error }))`);
  const exported = ex.ok ? await js(`__ct.fileBackground(${S(out)}, 45)`) : null;
  check(ex.ok && exported && exported[0] < 80 && exported[2] > exported[0], `export draws the original, not the proxy (${S(ex)}, ${S(exported)})`);
  // the proxy file goes: the original plays, not "offline"
  fs.rmSync(pp);
  await sleep(2600);
  await js(`(Cut.app.setTime(${2.5 * T}), true)`);
  await sleep(300);
  const after = await js('__ct.programBackground()');
  check(after[0] < 80 && after[2] > after[0], `a deleted proxy falls back to the original (${S(after)})`);
  await until(`document.querySelector('.cut-panel[data-panel="project"] [data-id="${id}"] .cut-proxy-badge')?.dataset.state === 'missing'`, 'the missing badge', 4000).catch(() => {});
  check(await js(`document.querySelector('.cut-panel[data-panel="project"] [data-id="${id}"] .cut-proxy-badge')?.dataset.state === 'missing'`), 'the panel says the proxy file is missing');
  await clickSel('.cut-monitor-program .cut-tr-proxy');

  // a job waits while the program plays, and is cancelled
  answer({ pickMedia: [path.join(dir, 'long.mp4')] });
  await clickSel('.cut-panel[data-panel="project"] .cut-import');
  await until(`Cut.app.project.media.length === 2`, 'imported', 20000);
  check(!(await js(`!!document.querySelector('.cut-proxy-offer')`)), 'a 1080p file with keyframes every second is not offered proxies');
  const longId = await js(`Cut.app.project.media[1].id`);
  await js(`(() => { const C = Cut.commands, s = __ct.seq(); Cut.app.history.do(C.place(s.id, { source: { media: ${S(longId)} }, in: 0, out: ${20 * T}, at: ${3 * T}, video: 'V1', audio: null, mode: 'overwrite' })); Cut.app.setTime(0); return true; })()`);
  await focusProgram();
  await space();
  await until('Cut.app.playing', 'playing', 4000);
  await clickSel(`.cut-panel[data-panel="project"] [data-id="${longId}"]`, { button: 'right' });
  await menuClick('Create Proxy');
  await until(`Cut.ui.proxy.running?.paused === true`, 'the job waiting', 8000);
  await sleep(800);
  check(await js(`Cut.app.playing && Cut.ui.proxy.running?.paused === true && Cut.ui.proxy.running.fraction === 0`), 'the proxy job waits while the program plays');
  await focusProgram();
  await space();
  await until(`!Cut.app.playing && (Cut.ui.proxy.running?.fraction || 0) > 0`, 'the job going on after the stop', 20000);
  check(true, 'it goes on once playback stops');
  await clickSel(`.cut-panel[data-panel="project"] [data-id="${longId}"]`, { button: 'right' });
  await menuClick('Cancel Proxy');
  await until(`!Cut.ui.proxy.running`, 'cancelled', 10000);
  const longPath = await js(`Cut.ui.proxy.pathOf(Cut.app.project.media[1])`);
  check(await js(`!Cut.app.project.media[1].proxy`) && !fs.existsSync(longPath) && !fs.existsSync(`${longPath}.part`), 'Cancel stops it: no proxy, no file left');

  // the offer dismissed is remembered for this project, not for another one
  answer({ pickMedia: [path.join(dir, 'q.mp4')] });
  await clickSel('.cut-panel[data-panel="project"] .cut-import');
  await until(`!!document.querySelector('.cut-proxy-offer')`, 'the offer again', 10000);
  await clickSel('.cut-proxy-offer-dismiss');
  check(!(await js(`!!document.querySelector('.cut-proxy-offer')`)), "Don't Ask for This Project hides the offer");
  answer({ pickMedia: [path.join(dir, 'q2.mp4')] });
  await clickSel('.cut-panel[data-panel="project"] .cut-import');
  await until(`Cut.app.project.media.length === 4`, 'imported', 20000);
  await sleep(800);
  check(!(await js(`!!document.querySelector('.cut-proxy-offer')`)) && (await js(`ide.settings.get('cut.proxy.dismissed').includes(Cut.ui.lifecycle.key.toLowerCase())`)), 'the next import in this project does not ask');
  await js(`Cut.ui.lifecycle.newProject({ ask: false }).then(() => true)`);
  await showTab('project');
  answer({ pickMedia: [path.join(dir, 'q2.mp4')] });
  await clickSel('.cut-panel[data-panel="project"] .cut-import');
  await until(`!!document.querySelector('.cut-proxy-offer')`, 'the offer in a new project', 10000).catch(() => {});
  check(await js(`!!document.querySelector('.cut-proxy-offer')`), 'another project asks again');
});

// ---------- the export queue ----------
await section('queue', async () => {
  const dir = path.join(home, 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'src.mp4');
  const r = await js(`__ct.write(${S(src)}, { seconds: 10, fps: [30, 1], w: 640, h: 360, keyEvery: 1 })`);
  if (r !== 'ok') throw new Error(`testsrc: ${r}`);
  await js(`__ct.fresh({})`);
  const made = await js(`Cut.ui.media.importPaths(Cut.app, [${S(src)}])`);
  await js(`(() => { const C = Cut.commands, s = __ct.seq(); Cut.app.history.do(C.place(s.id, { source: { media: ${S(made[0])} }, in: 0, out: ${4 * T}, at: 0, video: 'V1', audio: null, mode: 'overwrite' })); return true; })()`);
  await workspace('export');
  await showTab('export');
  const panel = '.cut-panel[data-panel="export"]';
  await js(`(() => { const s = document.querySelector('${panel} .cut-export-preset'); s.value = 'youtube-1080p'; s.dispatchEvent(new Event('change')); const l = document.querySelector('${panel} .cut-export-loudness'); l.value = 'off'; l.dispatchEvent(new Event('change')); return true; })()`);
  const out = (n) => path.join(dir, `${n}.mp4`);
  async function queue(name) {
    await clickSel(`${panel} .cut-export-path`);
    await press('Ctrl+A');
    await type(out(name));
    await clickSel(`${panel} .cut-export-queue`);
    await until(`Cut.ui.exportQueue.jobs().some((j) => j.path.toLowerCase() === ${S(out(name).toLowerCase())})`, `job ${name} queued`, 5000).catch(async (err) => {
      log(`  (not queued: ${S(await js(`({ toast: document.querySelector('.cut-toast')?.textContent, path: document.querySelector('${panel} .cut-export-path').value, dialogs: [...document.querySelectorAll('.dialog-backdrop')].map((d) => d.textContent.slice(0, 120)), problems: Cut.ui.exportDialog.panelForm?.problems })`))})`);
      throw err;
    });
  }
  // record the order the jobs run and finish in
  await js(`(() => { window.__q = { order: [], both: false }; Cut.app.on('exportQueue', () => { const js = Cut.ui.exportQueue.jobs(); if (js.filter((j) => j.state === 'running').length > 1) __q.both = true;
    for (const j of js) if ((j.state === 'running' || j.state === 'done') && !__q.order.includes(j.state + ':' + j.path)) __q.order.push(j.state + ':' + j.path); }); return true; })()`);
  await queue('A');
  await queue('B');
  await queue('C');
  // a later edit: the sequence becomes 8 s long; the queued jobs keep the 4 s they were added with
  await js(`(() => { const C = Cut.commands, s = __ct.seq(); Cut.app.history.do(C.place(s.id, { source: { media: ${S(made[0])} }, in: ${4 * T}, out: ${8 * T}, at: ${4 * T}, video: 'V1', audio: null, mode: 'overwrite' })); return true; })()`);
  check((await js(`Cut.model.sequenceDuration(__ct.seq()) / ${T}`)) === 8, 'the project changed after the jobs were queued');
  await showTab('queue');
  await until(`document.querySelectorAll('.cut-queue-job').length === 3`, 'three rows', 5000);
  const rows = await js(`[...document.querySelectorAll('.cut-queue-job')].map((r) => ({ name: r.querySelector('.cut-queue-name').textContent, details: r.querySelector('.cut-queue-details').textContent, state: r.dataset.state }))`);
  check(rows[0].name === 'A.mp4' && /YouTube 1080p/.test(rows[0].details) && /Entire sequence/.test(rows[0].details) && rows.slice(1).every((x) => x.state === 'waiting'), `the queue lists the jobs with preset, range and state (${S(rows)})`);
  check(await js(`__ct.visible('.cut-queue-note')`) && /slower/.test(await js(`document.querySelector('.cut-queue-note').textContent`)), 'a note says playback may be slower while exporting');
  // C up above B, then cancel C
  await clickSel(`.cut-queue-job[data-id="${await js(`Cut.ui.exportQueue.jobs()[2].id`)}"] .cut-queue-up`);
  await sleep(150);
  check(await js(`Cut.ui.exportQueue.jobs().map((j) => j.path.slice(-5)).join(',') === 'A.mp4,C.mp4,B.mp4'`), 'Move Up puts C before B');
  const cId = await js(`Cut.ui.exportQueue.jobs()[1].id`);
  await clickSel(`.cut-queue-job[data-id="${cId}"] .cut-queue-cancel`);
  check(await js(`Cut.ui.exportQueue.jobs()[1].state === 'cancelled'`), 'Cancel takes C out of the run');
  // closing the window while a job runs asks first
  await until(`Cut.ui.exportQueue.busy`, 'a job running', 10000);
  await js(`ide.api.invoke('window:close')`).catch(() => {});
  await until(`!!document.querySelector('#closeConfirmDialog')`, 'the close question', 8000).catch(() => {});
  const asked = await js(`[...document.querySelectorAll('#closeConfirmDialog .close-confirm-running li')].map((li) => li.textContent)`);
  check(asked.some((x) => /A\.mp4|B\.mp4/.test(x)), `closing the window while the queue runs asks first (${S(asked)})`);
  await clickSel('#closeConfirmDialog .dialog-buttons button:last-child').catch(() => {});
  // switching workspaces changes nothing
  await workspace('editing');
  await workspace('export');
  await until(`Cut.ui.exportQueue.jobs().filter((j) => j.state === 'done').length === 2`, 'A and B done', 120000);
  const order = await js('__q');
  const idx = (s) => order.order.findIndex((x) => x.toLowerCase() === s.toLowerCase());
  check(!order.both && idx(`done:${out('A')}`) < idx(`running:${out('B')}`) && idx(`running:${out('B')}`) >= 0, `the jobs ran one at a time, A finished before B started (${S(order.order.map((x) => x.replace(dir, '')))})`);
  for (const n of ['A', 'B']) {
    const pinfo = await js(`__ct.probe(${S(out(n))})`);
    check(Math.abs(pinfo.duration - 4) < 0.05 && pinfo.frames === 120 && pinfo.w === 1920, `${n}.mp4 has the 4 s the project had when it was queued, not the later edit (${S(pinfo)})`);
  }
  check(!fs.existsSync(out('C')), 'the cancelled job wrote nothing');
  await showTab('queue');
  check(await js(`document.querySelectorAll('.cut-queue-job[data-state="done"] .cut-queue-open').length === 2`), 'done jobs have Open Folder');
  await clickSel(`.cut-queue-job[data-id="${cId}"] .cut-queue-retry`);
  await until(`Cut.ui.exportQueue.jobs().find((j) => j.id === ${cId}).state === 'done'`, 'C done after Retry', 60000);
  check(fs.existsSync(out('C')), 'Retry runs the cancelled job');
  await clickSel(`.cut-queue-job[data-id="${cId}"] .cut-queue-remove`);
  check(await js(`!Cut.ui.exportQueue.jobs().some((j) => j.id === ${cId}) && document.querySelectorAll('.cut-queue-job').length === 2`), 'Remove takes a job off the list');
  await clickSel('.cut-queue-clear');
  check(await js(`!Cut.ui.exportQueue.jobs().length`), 'Clear Finished empties the list');
  // the export dialog has Add to Queue too
  await js(`(Cut.ui.exportDialog.open(Cut.app), true)`);
  await until(`!!document.querySelector('#cutExportDialog .cut-export-queue')`, 'the dialog');
  check(await js(`__ct.visible('#cutExportDialog .cut-export-queue')`), 'the export dialog has Add to Queue next to Export');
  await clickSel('#cutExportDialog .dialog-buttons button:last-child');
});

// ---------- files dropped from Explorer on the timeline ----------
await section('drop', async () => {
  await workspace('editing');
  const dir = path.join(home, 'drop');
  const sub = path.join(dir, 'folder');
  fs.mkdirSync(sub, { recursive: true });
  const file = (n) => path.join(dir, n);
  for (const [f, secs] of [[file('a.mp4'), 3], [file('b.mp4'), 2], [path.join(sub, 'c.mp4'), 1]]) {
    const r = await js(`__ct.write(${S(f)}, { seconds: ${secs}, fps: [30, 1], w: 320, h: 180, keyEvery: 1 })`);
    if (r !== 'ok') throw new Error(`testsrc ${f}: ${r}`);
  }
  await js(`__ct.fresh({})`);
  const tabs = await js('ide.tabs.length');
  const point = (t, track) => js(`Cut.ui.timeline.clientPoint(${t * T}, ${S(track)})`);
  const dragEvent = async (type, files, p, modifiers = 0) => cdp('Input.dispatchDragEvent', { type, x: p.x, y: p.y, modifiers, data: { items: [], files, dragOperationsMask: 1 } });
  const drop = async (files, t, track, modifiers = 0) => {
    const p = await point(t, track);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await dragEvent(type, files, p, modifiers);
  };
  const clips = () => js(`__ct.seq().clips.map((c) => ({ track: c.track, start: Math.round(c.start / ${T} * 100) / 100, end: Math.round(Cut.model.clipEnd(c) / ${T} * 100) / 100, media: Cut.app.project.media.find((m) => m.id === c.source.media)?.name })).sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start)`);

  const two = [file('a.mp4'), file('b.mp4')];
  const p2 = await point(2, 'V1');
  await dragEvent('dragEnter', two, p2);
  await dragEvent('dragOver', two, p2);
  const guide = await js('Cut.ui.timeline.view.guide');
  check(guide != null && Math.abs(guide / T - 2) < 0.05, `dragging files over the timeline shows where they go (${guide == null ? null : guide / T} s)`);
  await dragEvent('drop', two, p2);
  await until(`__ct.seq().clips.length === 4`, 'the dropped files placed', 20000);
  let cl = await clips();
  const v1 = cl.filter((c) => c.track === 'V1');
  const a1 = cl.filter((c) => c.track === 'A1');
  check(S(v1) === S([{ track: 'V1', start: 2, end: 5, media: 'a.mp4' }, { track: 'V1', start: 5, end: 7, media: 'b.mp4' }]),
    `two files dropped on V1 at 2 s are imported and placed there one after the other (${S(v1)})`);
  check(a1.length === 2 && a1[0].start === 2 && a1[1].start === 5, `their sound goes on A1 under them (${S(a1)})`);
  check(await js(`Cut.app.project.media.length === 2 && ide.tabs.length === ${tabs} && Cut.app.selection.size === 4`), 'the files are in the project, selected on the timeline, and not opened in the code editor');
  check(await js(`Cut.ui.timeline.view.guide == null`), 'the drop guide goes after the drop');

  // Ctrl inserts; a file already in the project is used again, not imported twice
  await drop([file('a.mp4')], 0, 'V1', 2);
  await until(`__ct.seq().clips.length === 6`, 'the second drop placed', 20000);
  cl = (await clips()).filter((c) => c.track === 'V1');
  check(await js('Cut.app.project.media.length') === 2, 'a file already in the project is not imported again');
  check(S(cl.map((c) => [c.start, c.media])) === S([[0, 'a.mp4'], [5, 'a.mp4'], [8, 'b.mp4']]), `Ctrl+drop inserts and moves the later clips along (${S(cl)})`);
  await focusTimeline();
  await press('Ctrl+z');
  await sleep(150);
  cl = (await clips()).filter((c) => c.track === 'V1');
  check(S(cl.map((c) => c.start)) === S([2, 5]) && await js('Cut.app.project.media.length') === 2, `one undo takes the inserted clip back (${S(cl)})`);

  // a folder: its files are imported into a bin and placed
  await drop([sub], 9, 'V2');
  await until(`__ct.seq().clips.some((c) => c.track === 'V2')`, 'the folder placed', 20000);
  cl = (await clips()).filter((c) => c.track === 'V2');
  check(S(cl) === S([{ track: 'V2', start: 9, end: 10, media: 'c.mp4' }]) && await js(`Cut.app.project.bins.some((b) => b.name === 'folder')`), `a dropped folder goes into a bin and its file onto V2 at 9 s (${S(cl)})`);

  // the project panel's own drop still only imports, and does not open the file in the code editor
  await js(`__ct.fresh({})`);
  await showTab('project');
  const pp = await rect('.cut-panel[data-panel="project"] .cut-items');
  for (const type of ['dragEnter', 'dragOver', 'drop']) await dragEvent(type, [file('b.mp4')], pp);
  await until(`Cut.app.project.media.length === 1`, 'the project panel import', 20000);
  await sleep(300);
  check(await js(`__ct.seq().clips.length === 0 && ide.tabs.length === ${tabs}`), 'a file dropped on the project panel is imported without a clip and not opened in the code editor');
});

// ---------- the clip's speed from its menu and Effect Controls ----------
await section('speed', async () => {
  await workspace('editing');
  await js(`__ct.fresh({ media: [__ct.fake('a')], clips: [{ at: 0, len: 4 }, { at: 4, len: 4, in: 8 }] })`);
  const state = () => js(`__ct.seq().clips.filter((c) => c.track === 'V1').map((c) => ({ start: c.start / ${T}, len: Math.round(Cut.model.clipDuration(c) / ${T} * 1000) / 1000, speed: c.speed, reverse: c.reverse })).sort((a, b) => a.start - b.start)`);
  const first = await js(`__ct.seq().clips.find((c) => c.start === 0).id`);
  const at = await js(`Cut.ui.timeline.clientPoint(${1 * T}, 'V1')`);
  await clickAt(at);
  await clickAt(at, { button: 'right' });
  await menuClick('Speed');
  await until(`!!${menuRow('50%', 1)}`, 'the Speed submenu', 4000);
  const items = await js(`[...document.querySelectorAll('.context-menu[data-level="1"] > .menu-item')].map((r) => r.querySelector('.menu-label')?.textContent)`);
  check(S(items) === S(['25%', '50%', '75%', '100%', '150%', '200%', '400%', 'Reverse Speed']), `the clip menu's Speed submenu offers quick speeds and Reverse (${S(items)})`);
  const before = await js('Cut.app.history.position');
  await menuClick('50%', 1);
  await sleep(150);
  let st = await state();
  check(S(st) === S([{ start: 0, len: 8, speed: 0.5, reverse: false }, { start: 8, len: 4, speed: 1, reverse: false }]), `50% doubles the clip and moves the next one along (${S(st)})`);
  check(await js('Cut.app.history.position') === before + 1, 'the speed change is one undo step');
  await focusTimeline();
  await press('Ctrl+z');
  await sleep(150);
  st = await state();
  check(st[0].speed === 1 && st[1].start === 4, `undo brings the speed and the next clip back (${S(st)})`);
  await clickAt(at);
  await clickAt(at, { button: 'right' });
  await menuClick('Speed');
  await until(`!!${menuRow('Reverse Speed', 1)}`, 'the Speed submenu', 4000);
  await menuClick('Reverse Speed', 1);
  await sleep(150);
  check((await state())[0].reverse === true, 'Reverse Speed in the submenu reverses the clip');

  // a still has no speed
  await js(`(() => { const C = Cut.commands, h = Cut.app.history, s = __ct.seq(); h.do(C.addGenerated(s.id, { track: 'V2', at: 0, duration: 2 * ${T}, source: { generator: 'solid', color: '#ff0000' } })); return true; })()`);
  const sp = await js(`Cut.ui.timeline.clientPoint(${1 * T}, 'V2')`);
  await clickAt(sp);
  await clickAt(sp, { button: 'right' });
  await until(`!!${menuRow('Speed')}`, 'the clip menu', 4000);
  check(await js(`${menuRow('Speed')}.classList.contains('disabled')`), 'a still clip has Speed disabled');
  await js(`(ide.ui.closeMenus?.(), true)`);
  await press('Escape');
  await sleep(100);

  // Effect Controls: a Speed section with the speed and Reverse
  await clickAt(at);
  await showTab('controls');
  await until(`!!document.querySelector('.cut-ec-sec[data-section="speed:${first}"] .cut-ec-row[data-path="speed"] .cut-number')`, 'the Speed section in Effect Controls', 5000);
  check(await js(`document.querySelector('.cut-ec-row[data-path="speed"] .cut-number-text').textContent === '100.00' && document.querySelector('.cut-ec-row[data-path="reverse"] input').checked === true`),
    'Effect Controls shows the clip speed (100%) and Reverse on');
  check(await js(`!document.querySelector('.cut-ec-row[data-path="speed"] .watch') && !document.querySelector('.cut-ec-row[data-path="reverse"] .watch')`), 'the speed rows have no stopwatch (not keyframed)');
  await clickSel('.cut-ec-row[data-path="speed"] .cut-number');
  await until(`!!document.querySelector('.cut-ec-row[data-path="speed"] .cut-number-input')`, 'the speed field turns into an input');
  await press('Ctrl+a');
  await type('200');
  await press('Enter');
  await sleep(200);
  st = await state();
  check(st[0].speed === 2 && st[0].len === 2 && st[1].start === 2, `200% typed in Effect Controls halves the clip and pulls the next one in (${S(st)})`);
  check(await js(`document.querySelector('.cut-ec-row[data-path="speed"] .cut-number-text').textContent`) === '200.00', 'the field shows 200.00');
  await clickSel('.cut-ec-row[data-path="reverse"] input');
  await sleep(150);
  check((await state())[0].reverse === false, 'the Reverse box turns reverse off');
  await clickSel(`.cut-ec-sec[data-section="speed:${first}"] .cut-ec-sectools button`);
  await sleep(150);
  st = await state();
  check(st[0].speed === 1 && st[0].len === 4 && st[1].start === 4, `Reset puts the speed back to 100% (${S(st)})`);
});

await section('volume', async () => {
  await workspace('editing');
  await js(`__ct.fresh({ media: [{ ...__ct.fake('a'), audio: { rate: 48000, channels: 2, codec: 'mp4a.40.2' } }] })`);
  await js(`(() => { const C = Cut.commands, s = __ct.seq(), m = Cut.app.project.media[0].id; Cut.app.history.do(C.place(s.id, { source: { media: m }, in: 0, out: 4 * ${T}, at: 0, video: null, audio: 'A1', mode: 'overwrite' })); return true; })()`);
  const vol = '.cut-tl-head.audio[data-track="A1"] .cut-tl-hvol';
  const db = () => js(`__ct.seq().tracks.find((t) => t.id === 'A1').volume ?? 0`);
  const text = () => js(`document.querySelector(${S(vol)}).textContent`);
  await until(`!!__ct.rect(${S(vol)})?.w`, 'the volume control in the A1 header', 5000);
  check(await text() === '100%' && await js(`__ct.visible(${S(vol)})`), `an audio track header shows its volume, 100% (${await text()})`);
  const bar = await rect(`${vol} .cut-tl-hvol-bar`);
  const node = await rect(vol);
  const drag = async (dx, { alt = false } = {}) => {
    await mouse('mouseMoved', node.x, node.y, { buttons: 0 });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: node.x, y: node.y, button: 'left', buttons: 1, clickCount: 1, modifiers: alt ? 1 : 0 });
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', node.x + (dx * i) / 8, node.y);
    await mouse('mouseReleased', node.x + dx, node.y, { buttons: 0 });
    await sleep(150);
  };
  const before = await js('Cut.app.history.position');
  await drag(bar.w / 4);
  check(Math.abs(await db() - 3.52) < 0.01 && await text() === '150%', `dragging right by a quarter of the bar raises it to 150% (+3.52 dB) (${await db()} dB, ${await text()})`);
  check(await js('Cut.app.history.position') === before + 1, 'one drag is one undo step');
  await drag(bar.w * 2);
  check(Math.abs(await db() - 6.02) < 0.01 && await text() === '200%', `it stops at 200% (+6.02 dB) (${await db()} dB, ${await text()})`);
  await drag(-bar.w * 3);
  check(await db() === -144 && await text() === '0%', `dragging left stops at 0%, silence (${await db()} dB, ${await text()})`);
  const pos = await js('Cut.app.history.position');
  await drag(0);
  check(await js('Cut.app.history.position') === pos && await db() === -144, 'a click without moving changes nothing');
  await drag(0, { alt: true });
  check(await db() === 0 && await text() === '100%', `Alt+click puts it back to 100% (${await db()} dB)`);
  await focusTimeline();
  await press('Ctrl+z');
  await sleep(150);
  check(await db() === -144, `undo takes the Alt+click back (${await db()} dB)`);

  // the track menu
  await clickAt(await rect('.cut-tl-head.audio[data-track="A1"] .cut-tl-hb.target'), { button: 'right' });
  await menuClick('Track Volume');
  await until(`!!${menuRow('50%', 1)}`, 'the Track Volume submenu', 4000);
  const items = await js(`[...document.querySelectorAll('.context-menu[data-level="1"] > .menu-item')].map((r) => r.querySelector('.menu-label')?.textContent)`);
  check(S(items) === S(['0%', '50%', '100%', '150%', '200%', 'Set Volume…']), `the track menu's Track Volume submenu (${S(items)})`);
  await menuClick('50%', 1);
  await sleep(150);
  check(Math.abs(await db() + 6.02) < 0.01 && await text() === '50%', `50% in the menu sets -6.02 dB (${await db()} dB, ${await text()})`);

  // double-click types a value and does not rename the track
  const name = await js(`__ct.seq().tracks.find((t) => t.id === 'A1').name`);
  await mouse('mouseMoved', node.x, node.y, { buttons: 0 });
  for (const clickCount of [1, 2]) {
    await mouse('mousePressed', node.x, node.y, { clickCount });
    await mouse('mouseReleased', node.x, node.y, { buttons: 0, clickCount });
  }
  await until(`document.querySelector('#popup:not(.hidden)') && document.querySelector('#popupIn').placeholder === 'Track volume (0 to 200%)'`, 'the volume prompt', 4000);
  await press('Ctrl+a');
  await type('75');
  await press('Enter');
  await sleep(200);
  check(Math.abs(await db() + 2.5) < 0.01 && await text() === '75%', `typing 75 sets 75% (${await db()} dB, ${await text()})`);
  check(await js(`__ct.seq().tracks.find((t) => t.id === 'A1').name`) === name, 'double-clicking the volume does not rename the track');

  // what the mix plays: a steady 0.25 signal at 0, 50, 100 and 200%
  const levels = await js(`(async () => {
    const out = {};
    for (const pct of [0, 50, 100, 200]) {
      const p = JSON.parse(JSON.stringify(Cut.app.project));
      const s = p.sequences.find((x) => x.id === __ct.seq().id);
      s.tracks.find((t) => t.id === 'A1').volume = pct === 0 ? -144 : Math.round(2000 * Math.log10(pct / 100)) / 100;
      const mixer = Cut.audioengine.createMixer({ rate: 48000, getAudio: async () => ({ rate: 48000, length: 48000 * 4, data: [new Float32Array(48000 * 4).fill(0.25)] }) });
      const m = await mixer.mixLoaded(p, s.id, 48000, 4800);
      out[pct] = Math.round(m.out[0][100] * 1000) / 1000;
    }
    return out;
  })()`);
  check(levels[0] === 0 && levels[50] === 0.125 && levels[100] === 0.25 && levels[200] === 0.5, `the mix plays the track at its volume: 0, 50, 100, 200% (${S(levels)})`);

  // a small track has no room for it
  await js(`(Cut.app.history.do(Cut.commands.setTrack(__ct.seq().id, 'A1', { height: 32 })), true)`);
  await sleep(150);
  check(await js(`document.querySelector(${S(vol)}).hidden`), 'a small audio track hides the volume control (the track menu still has it)');
});

// ---------- the word-by-word caption highlight ----------
await section('highlight', async () => {
  const dir = path.join(home, 'highlight');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'src.mp4');
  const r = await js(`__ct.write(${S(src)}, { seconds: 4, fps: [30, 1], w: 640, h: 360, keyEvery: 1, beepEvery: 0, audio: false })`);
  if (r !== 'ok') throw new Error(`testsrc: ${r}`);
  await js(`__ct.fresh({})`);
  const made = await js(`Cut.ui.media.importPaths(Cut.app, [${S(src)}])`);
  // the captions as Auto Captions makes them from recognised words: alpha 0.5-1.0 s, beta 1.2-1.7 s, gamma 1.9-2.4 s
  await js(`(() => {
    const C = Cut.commands, s = __ct.seq(), T = Cut.time.TICKS;
    Cut.app.history.do(C.place(s.id, { source: { media: ${S(made[0])} }, in: 0, out: 4 * T, at: 0, video: 'V1', audio: null, mode: 'overwrite' }));
    const words = [[0.5, 1.0, 'alpha'], [1.2, 1.7, 'beta'], [1.9, 2.4, 'gamma']].map(([a, b, text]) => ({ t0: a * T, t1: b * T, text }));
    const items = Cut.speech.captions(words, { frame: Cut.time.frameTicks(s.fps) });
    Cut.app.history.do(C.batch('Auto Captions', [C.addCaptionTrack(s.id, { name: 'Auto Captions', lang: 'en', items })]));
    // the highlight's pixels (#ffd23f: red and green high, blue low) and the caption's white ones in the band the
    // caption sits in (below the test picture's digits and time)
    __ct.lit = (px, W, box) => {
      let sx = 0, n = 0, white = 0;
      for (let y = Math.round(box.y + box.h * 0.84); y < Math.round(box.y + box.h); y++) {
        for (let x = Math.round(box.x); x < Math.round(box.x + box.w); x++) {
          const i = (y * W + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
          if (r > 190 && g > 150 && b < 110) { sx += x; n++; } else if (r > 200 && g > 200 && b > 200) white++;
        }
      }
      return { n, white, x: n ? +((sx / n - box.x) / box.w).toFixed(4) : null };
    };
    __ct.monitorLit = async () => {
      const m = Cut.ui.monitors.program;
      await m.player.render();
      const comp = m.player.compositor;
      await comp.idle?.();
      const px = await comp.readPixels();
      const fr = m.player.frameRect();
      const k = comp.width / (m.canvas.clientWidth || comp.width);
      return __ct.lit(px, comp.width, { x: fr.x * k, y: fr.y * k, w: fr.w * k, h: fr.h * k });
    };
    __ct.litAt = async (t) => { Cut.app.setTime(t); return __ct.monitorLit(); };
    __ct.fileLit = async (file, index) => {
      const rd = await Cut.audioengine.fileReader(file);
      const src = await Cut.probe.open(rd, { name: file });
      const vt = src.tracks.find((t) => t.kind === 'video');
      const d = await Cut.export.decodeRange(rd, vt, Cut.probe.keyBefore(vt, index), index, { pixels: true });
      return d.pixels ? __ct.lit(d.pixels, vt.width, { x: 0, y: 0, w: vt.width, h: vt.height }) : null;
    };
    __ct.item = () => __ct.seq().captions[0].items[0];
    // which word the project says is lit at t (on its frame)
    __ct.expect = (t) => { const s = __ct.seq(); const it = s.captions[0].items.find((x) => x.start <= t && t < x.end); return it ? Cut.captionwords.litAt(it, Cut.time.snap(t, s.fps)) : -1; };
    return true;
  })()`);
  check(await js(`!!Cut.captionwords && Cut.captionwords.valid(__ct.item().words, __ct.item().text)`), 'captions made from speech carry a timing for each word');
  const F = await js('Cut.time.frameTicks([30, 1])');
  const starts = await js(`__ct.item().words.map((w) => __ct.item().start + w.t0)`);
  const ends = await js(`__ct.item().words.map((w) => __ct.item().start + w.t1)`);
  await workspace('captions');
  await showTab('captions');
  const off = await js(`__ct.litAt(${starts[1] + F})`);
  check(off.n === 0 && off.white > 200, `the program monitor shows the caption, and nothing is lit before the highlight is on (${S(off)})`);

  // the Caption Style dialog turns it on
  await clickSel('.cut-cap-style');
  await until(`!!document.querySelector('#cutCaptionStyle .cut-cap-hl')`, 'the caption style dialog', 5000);
  check(/1 of 1 captions have word timings/.test(await js(`document.querySelector('#cutCaptionStyle .cut-cap-hl-note').textContent`)), 'the dialog says how many captions have word timings');
  await clickSel('#cutCaptionStyle .cut-cap-hl');
  check(await js(`document.querySelector('#cutCaptionStyle .cut-cap-hl').checked`), 'a click ticks Highlight each word as it is spoken');
  await clickSel('#cutCaptionStyle .dialog-buttons button.primary');
  await until(`!document.querySelector('#cutCaptionStyle')`, 'the dialog closed', 5000);
  check(await js(`(() => { const st = __ct.seq().captions[0].style; return st.highlight === true && st.highlightColor === '#ffd23f' && st.highlightMode === 'color' && Cut.app.history.list().at(-1)?.label === 'Caption Track Settings'; })()`),
    'OK turns the highlight on for the track in one undo step');

  // each word lights at its own frame; the frame before still shows the word before
  const ref = [];
  // the same word: the lit pixels' center within 0.4% of the frame (edge pixels blend with the moving picture)
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.004;
  for (let i = 0; i < 3; i++) {
    const at = await js(`__ct.litAt(${starts[i]})`);
    const mid = await js(`__ct.litAt(${starts[i] + 5 * F})`);
    const before = await js(`__ct.litAt(${starts[i] - F})`);
    ref.push(at.x);
    check(at.n > 30 && same(mid.x, at.x), `word ${i + 1} is lit from its first frame on (${S(at)}, ${S(mid)})`);
    if (i === 0) check(before.n === 0 && before.white < 50, `the frame before the first word shows no caption yet (${S(before)})`);
    else check(same(before.x, ref[i - 1]), `the frame before word ${i + 1} still lights word ${i} (${S(before)})`);
  }
  check(ref[0] < ref[1] - 0.02 && ref[1] < ref[2] - 0.02, `the lit word moves left to right through the caption (${S(ref)})`);
  const after = await js(`__ct.litAt(${ends[2] + F})`);
  check(after.n === 0 && after.white > 200, `after the last word the caption stays a moment with nothing lit (${S(after)})`);
  const xOf = (t) => js(`__ct.expect(${t})`);

  // scrubbing the program monitor's bar
  const bar = await rect('.cut-monitor-program .cut-scrub');
  const dur = await js(`Cut.model.sequenceDuration(__ct.seq())`);
  const xAt = (t) => bar.x - bar.w / 2 + (t / dur) * bar.w;
  const scrubbed = [];
  await mouse('mouseMoved', xAt(starts[0] + 2 * F), bar.y, { buttons: 0 });
  await mouse('mousePressed', xAt(starts[0] + 2 * F), bar.y);
  for (const t of [starts[0] + 8 * F, starts[1] + 3 * F, starts[2] + 2 * F, starts[1] + 9 * F]) {
    await mouse('mouseMoved', xAt(t), bar.y);
    await sleep(120);
    const now = await js('Cut.app.t');
    const want = await xOf(now);
    scrubbed.push({ want, got: (await js('__ct.monitorLit()')).x });
  }
  await mouse('mouseReleased', xAt(starts[1] + 9 * F), bar.y);
  check(scrubbed.every((s) => s.want >= 0 && same(s.got, ref[s.want])) && new Set(scrubbed.map((s) => s.want)).size === 3, `while scrubbing, the monitor lights the word under the playhead (${S(scrubbed)})`);

  // playing: frames read back as they are shown
  await js(`(() => {
    const m = Cut.ui.monitors.program, p = m.player, comp = p.compositor;
    window.__hl = { samples: [], busy: false };
    __hl.off = p.on(async (e) => {
      if (e.type !== 'frame' || __hl.busy) return;
      __hl.busy = true;
      try {
        const px = await comp.readPixels();
        const fr = p.frameRect();
        const k = comp.width / (m.canvas.clientWidth || comp.width);
        __hl.samples.push({ t: e.t, ...__ct.lit(px, comp.width, { x: fr.x * k, y: fr.y * k, w: fr.w * k, h: fr.h * k }) });
      } finally { __hl.busy = false; }
    });
    Cut.app.setTime(${starts[0] - 3 * F});
    return true;
  })()`);
  await focusProgram();
  await space();
  await until(`Cut.app.t > ${ends[2] + 3 * F} || !Cut.app.playing`, 'playback past the last word', 15000).catch(() => {});
  await space();
  const samples = await js(`(__hl.off(), __hl.samples.map((s) => ({ t: s.t, x: s.x, n: s.n, want: __ct.expect(s.t) })))`);
  const wrong = samples.filter((s) => (s.want < 0 ? s.n !== 0 : !same(s.x, ref[s.want])));
  check(samples.length >= 8 && new Set(samples.map((s) => s.want)).size >= 3 && !wrong.length,
    `while playing, every frame read back lights the word spoken at its time (${samples.length} frames, wrong: ${S(wrong.slice(0, 4))})`);

  // export burns in the same highlight
  const out = path.join(dir, 'burned.mp4');
  const ex = await js(`Cut.export.run({ project: Cut.app.project, seqId: __ct.seq().id, path: ${S(out)}, preset: '720p', overrides: { loudness: null }, captions: 'burn' }).then((r) => ({ ok: r.ok, error: r.error }))`);
  check(ex.ok, `the sequence exports with the captions burned in (${S(ex)})`);
  const frames = [];
  for (const t of [starts[0], starts[1] - F, starts[1], starts[2] - F, starts[2] + 5 * F, ends[2] + F]) {
    const want = await xOf(t);
    const file = await js(`__ct.fileLit(${S(out)}, ${Math.round(t / F)})`);
    const shown = await js(`__ct.litAt(${t})`);
    frames.push({ frame: Math.round(t / F), want, file: file?.x ?? null, monitor: shown.x });
  }
  check(frames.every((x) => (x.want < 0 ? x.file === null && x.monitor === null : x.file !== null && Math.abs(x.file - x.monitor) < 0.01)),
    `each exported frame lights the word the monitor lights at that frame (${S(frames)})`);

  // a second caption track at the top: the monitor and export follow the track the captions panel shows
  await js(`(() => {
    const s = __ct.seq(), T = Cut.time.TICKS;
    Cut.app.history.do(Cut.commands.addCaptionTrack(s.id, { name: 'Top', lang: 'en', style: { position: 'top' }, items: [{ start: 0, end: 4 * T, text: 'TOP LINE HERE' }] }));
    // white pixels in the top sixth of a frame, and the bottom band's highlight (__ct.lit)
    __ct.bands = (px, W, box) => {
      let top = 0;
      for (let y = Math.round(box.y); y < Math.round(box.y + box.h * 0.16); y++) {
        for (let x = Math.round(box.x); x < Math.round(box.x + box.w); x++) { const i = (y * W + x) * 4; if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) top++; }
      }
      return { top, bottom: __ct.lit(px, W, box) };
    };
    // what the program monitor shows now, without asking it to draw
    __ct.shown = async () => {
      const m = Cut.ui.monitors.program, comp = m.player.compositor;
      await comp.idle?.();
      const px = await comp.readPixels();
      const fr = m.player.frameRect();
      const k = comp.width / (m.canvas.clientWidth || comp.width);
      return __ct.bands(px, comp.width, { x: fr.x * k, y: fr.y * k, w: fr.w * k, h: fr.h * k });
    };
    __ct.fileBands = async (file, index) => {
      const rd = await Cut.audioengine.fileReader(file);
      const src = await Cut.probe.open(rd, { name: file });
      const vt = src.tracks.find((t) => t.kind === 'video');
      const d = await Cut.export.decodeRange(rd, vt, Cut.probe.keyBefore(vt, index), index, { pixels: true });
      return __ct.bands(d.pixels, vt.width, { x: 0, y: 0, w: vt.width, h: vt.height });
    };
    return true;
  })()`);
  const [firstTrack, topTrack] = await js(`__ct.seq().captions.map((c) => c.id)`);
  const tWord = starts[1] + 2 * F;
  await js(`__ct.litAt(${tWord})`);
  const shownFirst = await js(`__ct.shown()`);
  check(shownFirst.bottom.n > 30 && (await js(`Cut.ui.captions.trackOf(Cut.app).id`)) === firstTrack, `with two caption tracks the monitor shows the panel's track, the first one by default (${S(shownFirst)})`);
  const pickTrack = (id) => js(`(() => { const s = document.querySelector('.cut-panel[data-panel="captions"] .cut-cap-track'); s.value = ${S(id)}; s.dispatchEvent(new Event('change')); return true; })()`);
  check(await js(`[...document.querySelector('.cut-panel[data-panel="captions"] .cut-cap-track').options].map((o) => o.value).join()`) === `${firstTrack},${topTrack}`, 'the captions panel lists both tracks');
  await pickTrack(topTrack);
  const switched = await until(`__ct.shown().then((b) => b.bottom.n === 0 && b.top > ${shownFirst.top + 150})`, 'the monitor drawn again with the top track', 5000).then(() => true, () => false);
  const shownTop = await js(`__ct.shown()`);
  check(switched && shownTop.bottom.white < 50 && (await js('Cut.app.t')) === tWord, `choosing the top track in the captions panel redraws the stopped monitor with it, the playhead unmoved (${S(shownFirst)} -> ${S(shownTop)})`);

  // the export panel burns in the same track and says which
  await workspace('export');
  await showTab('export');
  const xp = '.cut-panel[data-panel="export"]';
  await js(`(() => { for (const [c, v] of [['preset', '720p'], ['loudness', 'off'], ['captions', 'burn']]) { const s = document.querySelector('${xp} .cut-export-' + c); s.value = v; s.dispatchEvent(new Event('change')); } return true; })()`);
  await until(`!document.querySelector('${xp} .cut-export-burn-track').hidden`, 'the burned-in track note', 5000).catch(() => {});
  const note = await js(`document.querySelector('${xp} .cut-export-burn-track').textContent`);
  check(await js(`(document.querySelector('${xp} .cut-export-burn-track').scrollIntoView({ block: 'nearest' }), __ct.visible('${xp} .cut-export-burn-track'))`) && note === await js(`tr('Burns in the caption track shown in the Captions panel: {name}', { name: 'Top' })`), `the export panel names the track it burns in (${note})`);
  const topOut = path.join(dir, 'burned-top.mp4');
  await clickSel(`${xp} .cut-export-path`);
  await press('Ctrl+A');
  await type(topOut);
  await clickSel(`${xp} .cut-export-queue`);
  await until(`Cut.ui.exportQueue.jobs().some((j) => j.path.toLowerCase() === ${S(topOut.toLowerCase())} && j.state === 'done')`, 'the top track export done', 60000);
  const fileFirst = await js(`__ct.fileBands(${S(out)}, ${Math.round(tWord / F)})`);
  const fileTop = await js(`__ct.fileBands(${S(topOut)}, ${Math.round(tWord / F)})`);
  check(fileTop.bottom.n === 0 && fileTop.bottom.white < 50 && fileTop.top > fileFirst.top + 150 && fileFirst.bottom.n > 30,
    `the export burns in the track the panel and the monitor show (first track ${S(fileFirst)}, top track ${S(fileTop)})`);
  await js(`(() => { const s = document.querySelector('${xp} .cut-export-captions'); s.value = 'none'; s.dispatchEvent(new Event('change')); return true; })()`);
  await workspace('captions');
  await showTab('captions');
  await pickTrack(firstTrack);
  const back = await until(`__ct.shown().then((b) => b.bottom.n > 30)`, 'the monitor back on the first track', 5000).then(() => true, () => false);
  check(back, 'choosing the first track again brings its caption and highlight back to the monitor');
  await js(`(Cut.app.history.undo(), true)`);
  check(await js(`__ct.seq().captions.length === 1`), 'the top track taken away again');

  // editing the text in the captions panel keeps the timings of the words that still match
  const before = await js(`__ct.item().words`);
  await clickSel('.cut-cap-row .cut-cap-text');
  await press('Ctrl+A');
  await type('alpha bravo gamma delta');
  await press('Enter');
  await until(`__ct.item().text === 'alpha bravo gamma delta'`, 'the edited caption', 5000);
  const edited = await js(`__ct.item().words`);
  check(edited.length === 4 && edited[0].t0 === before[0].t0 && edited[1].t0 === before[1].t0 && edited[1].t1 === before[1].t1 && edited[2].t0 === before[2].t0 && edited[3].t0 >= before[2].t1 && await js(`Cut.captionwords.valid(__ct.item().words, __ct.item().text)`),
    `the edit keeps alpha and gamma, gives bravo beta's time and delta the time after gamma (${S(edited.map((w) => [w.text, w.t0 / F, w.t1 / F]))})`);
  const bravo = await js(`__ct.litAt(${starts[1] + 2 * F})`);
  const delta = await js(`__ct.litAt(${starts[0] + edited[3].t0 + F})`);
  check(bravo.n > 30 && delta.n > 30 && delta.x > bravo.x, `the monitor lights bravo at beta's time and delta after gamma (${S(bravo)}, ${S(delta)})`);
  await focusProgram();
  await press('Ctrl+Z');
  check(await js(`__ct.item().text === 'alpha beta gamma' && JSON.stringify(__ct.item().words) === ${S(S(before))}`), 'Ctrl+Z brings back the text and its exact timings');
  await press('Ctrl+Shift+Z');
  check(await js(`__ct.item().text === 'alpha bravo gamma delta' && __ct.item().words.length === 4`), 'Ctrl+Shift+Z redoes the edit');
  await press('Ctrl+Z');
  await clickSel('.cut-cap-row .cut-cap-text');
  await press('Ctrl+A');
  await type('nothing like it');
  await press('Enter');
  await until(`__ct.item().text === 'nothing like it'`, 'the rewritten caption', 5000);
  const rewritten = await js(`__ct.litAt(${starts[1] + 2 * F})`);
  check(await js(`__ct.item().words === undefined && Cut.model.validate(Cut.app.project).ok`) && rewritten.n === 0 && rewritten.white > 100,
    `a caption rewritten with no word left from the speech shows unlit, never a wrong word (${S(rewritten)})`);
  await focusProgram();
  await press('Ctrl+Z');

  // the box style: the word on a box of the highlight color, its text dark on it
  const colorOnly = await js(`__ct.litAt(${starts[1] + 2 * F})`);
  await clickSel('.cut-cap-style');
  await until(`!!document.querySelector('#cutCaptionStyle .cut-cap-hl-mode')`, 'the caption style dialog', 5000);
  await js(`(() => { const s = document.querySelector('#cutCaptionStyle .cut-cap-hl-mode'); s.value = 'box'; s.dispatchEvent(new Event('change')); return true; })()`);
  await clickSel('#cutCaptionStyle .dialog-buttons button.primary');
  await until(`__ct.seq().captions[0].style.highlightMode === 'box'`, 'the box style', 5000);
  const boxed = await js(`__ct.litAt(${starts[1] + 2 * F})`);
  check(boxed.n > 3 * colorOnly.n && Math.abs(boxed.x - colorOnly.x) < 0.01, `Word color and box puts a box of the color behind the same word (${S(colorOnly)} -> ${S(boxed)})`);
  await js(`Cut.app.setTime(${starts[1] + 2 * F})`);
  await sleep(300);
  log(`  saved ${await ctx.shot('tools-highlight-box-dark.png')}`);

  // saved and opened again
  const projectPath = path.join(dir, 'highlight.ncut');
  answer({ saveAs: projectPath });
  await focusProgram();
  await press('Ctrl+S');
  await until(`Cut.app.path && !Cut.ui.lifecycle.dirty`, 'saved', 10000);
  const saved = JSON.parse(fs.readFileSync(projectPath, 'utf8')).sequences[0].captions[0];
  check(saved.style.highlight === true && saved.style.highlightMode === 'box' && S(saved.items[0].words) === S(before), 'the project file keeps the highlight style and the word timings');
  await js(`__ct.fresh({})`);
  check(await js(`__ct.seq().captions.length === 0`), 'another project is open');
  answer({ pickProject: projectPath });
  await clickSel('.cut-topbar .cut-open');
  await until(`Cut.app.path && __ct.seq().captions.length === 1`, 'the saved project reopened', 10000);
  const reopened = await js(`__ct.litAt(${starts[1] + 2 * F})`);
  check(await js(`JSON.stringify(__ct.item().words) === ${S(S(before))}`) && Math.abs(reopened.x - boxed.x) < 0.005 && reopened.n > 30, `opened again, the captions light the same word (${S(reopened)})`);
  answer({});
});

// ---------- screenshots ----------
await section('shots', async () => {
  await workspace('export');
  await js(`(Cut.ui.exportQueue.add({ project: JSON.parse(JSON.stringify(Cut.app.project)), seqId: __ct.seq().id, seqName: __ct.seq().name, fps: [30, 1], path: ${S(path.join(home, 'shot.mp4'))}, settings: { ...Cut.presets.resolve('720p', __ct.seq()), loudness: null }, range: null, captions: null, presetName: '720p light' }), true)`);
  await showTab('queue');
  await sleep(300);
  log(`  saved ${await ctx.shot('tools-queue-dark.png')}`);
  await workspace('editing');
  await js(`(Cut.ui.shortcuts.sheet(), true)`);
  await sleep(200);
  log(`  saved ${await ctx.shot('tools-keysheet-dark.png')}`);
  await js(`(Cut.ui.shortcuts.closeSheet(), Cut.ui.shortcuts.open(), true)`);
  await sleep(200);
  log(`  saved ${await ctx.shot('tools-keys-dark.png')}`);
  await closeDialogs();
  await js(`(ide.openSettings('cut'), true)`);
  await sleep(500);
  log(`  saved ${await ctx.shot('tools-settings-dark.png')}`);
  await closeDialogs();
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(400);
  await js(`(Cut.ui.shortcuts.open(), true)`);
  await sleep(200);
  log(`  saved ${await ctx.shot('tools-keys-light.png')}`);
  await closeDialogs();
  await js(`(Cut.ui.shortcuts.sheet(), true)`);
  await sleep(200);
  log(`  saved ${await ctx.shot('tools-keysheet-light.png')}`);
  await closeDialogs();
  await js(`(ide.openSettings('cut'), true)`);
  await sleep(500);
  log(`  saved ${await ctx.shot('tools-settings-light.png')}`);
  await closeDialogs();
  await workspace('export');
  await showTab('queue');
  await sleep(300);
  log(`  saved ${await ctx.shot('tools-queue-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  await until(`!Cut.ui.exportQueue.busy`, 'the last job', 60000).catch(() => {});
  check(true, 'screenshots saved');
});

ctx.finish();
