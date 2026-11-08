// Nano Studio Cut's Lumetri Color and Lumetri Scopes panels in the real app, with real mouse events
// (Input.dispatchMouseEvent) and keys. Checks:
// - the Color workspace as Premiere's: Lumetri Scopes left of the program monitor, Lumetri Color right of it, its
//   sections (Basic Correction, Creative, Curves, HSL Secondary, Vignette) collapsible;
// - the scopes follow the program monitor: a gray, a 75% red and a 75% blue solid put their vectorscope point at
//   their angles as the playhead moves, a drag on the ruler counts again while it scrubs, playing a 1080p30 source
//   counts about every 150 ms and costs no frames, a ramp image is the waveform's diagonal, the toggles show and hide
//   each scope (kept in the settings);
// - curves: a press on the square adds a point and drags it (one undo step, the program monitor and the waveform get
//   brighter), a channel button edits that channel, Ctrl+click removes a point, a double click straightens, Ctrl+Z;
// - the Look: Browse… through the dialog stand-in (PYIDE_CUT_DIALOG pickLut) loads an inverting .cube into the
//   project (the red solid turns cyan), the intensity, bad files refused with their reason and nothing changed, undo
//   and redo, a save, the .cube deleted, the project opened again still inverting;
// - the HSL secondary: the eyedropper keys the red, saturation 0 turns it gray, Show Mask, the gray clip outside;
// - Effect Controls shows Lumetri Color's groups and the curve's points;
// - screenshots in the dark and the light theme (verify/out/cut-color/*.png).
// Usage: node verify/cut-color.mjs   (CUT_COLOR_ONLY=layout,scopes,play,curves,lut,hsl,controls,shots)
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_COLOR_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-color-home');
const files = path.join(home, 'luts');
mkdirSync(files, { recursive: true });
const dialogFile = path.join(home, 'dialog.json');
const savedProject = path.join(home, 'Projects', 'look.ncut');
// The dialogs' answers (main reads the file at each call); Save As always goes to savedProject.
const answer = (o) => writeFileSync(dialogFile, JSON.stringify({ saveAs: savedProject, ...o }));
answer({});
const ctx = await launch({ fixture: 'core', port: 9781, name: 'cut-color', mode: 'cut', env: { PYIDE_CUT_HOME: home, PYIDE_CUT_DIALOG: dialogFile } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;

// .cube files: an inverting 17-point look, and bad ones.
const cube = (n, f, head = '') => {
  const lines = [head + `TITLE "Invert"`, `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
  return `${lines.join('\n')}\n`;
};
const invertCube = path.join(files, 'invert.cube');
writeFileSync(invertCube, cube(17, (r, g, b) => [1 - r, 1 - g, 1 - b], '# a test look\n'));
const shortCube = path.join(files, 'short.cube');
writeFileSync(shortCube, cube(17, (r, g, b) => [r, g, b]).split('\n').slice(0, -40).join('\n'));
const oneD = path.join(files, 'curve1d.cube');
writeFileSync(oneD, 'LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1\n');

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['lumetri', 'scopes', 'effects', 'compositor'].every((k) => !!Cut[k]) && ['color', 'scopes'].every((p) => Cut.ui.panels.has(p)) && !!Cut.ui.scopes && !!Cut.ui.color?.readLut`),
  'the Lumetri modules load and the Lumetri Color and Lumetri Scopes panels register');

// ---------- page helpers ----------
await js(`(() => {
  const H = (window.__co = {});
  const T = Cut.time.TICKS;
  H.seq = () => Cut.app.sequence;
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
  H.clip = (i) => H.seq().clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start)[i];
  H.lumetri = (i) => H.clip(i).effects.find((e) => e.type === 'color.basic') || null;
  H.params = (i) => H.lumetri(i)?.params || null;
  // with the defaults a parameter left at its default is not stored
  H.resolved = (i) => (H.lumetri(i) ? Cut.effects.resolve('color.basic', H.lumetri(i).params) : null);
  H.write = async (name, bytes) => {
    const home = await ide.api.invoke('cut:home');
    const path = home.projects + '\\\\' + name;
    const o = await ide.api.invoke('cut:writeOpen', path);
    await ide.api.invoke('cut:writeAt', o.id, bytes);
    const c = await ide.api.invoke('cut:writeClose', o.id, { commit: true });
    return c.path || path;
  };
  H.png = async (w, h, paint) => { const c = new OffscreenCanvas(w, h); paint(c.getContext('2d'), w, h); return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); };
  // V1: gray 0-4 s, 75% red 4-8 s, 75% blue 8-12 s, a gray ramp image 12-16 s; extra media appended after.
  H.fresh = async (extra = []) => {
    const C = Cut.commands;
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1], w: 1920, h: 1080 } }));
    Cut.app.setHistory(h, null, 'open');
    const s = Cut.app.sequence;
    for (const [i, color] of ['#808080', '#bf0000', '#0000bf'].entries()) h.do(C.addGenerated(s.id, { track: 'V1', at: i * 4 * T, duration: 4 * T, source: { generator: 'solid', color } }));
    const ramp = await H.write('ramp.png', await H.png(1920, 1080, (g, w, hh) => { for (let x = 0; x < w; x++) { const v = Math.round((x * 255) / (w - 1)); g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; g.fillRect(x, 0, 1, hh); } }));
    const ids = await Cut.ui.media.importPaths(Cut.app, [ramp, ...extra]);
    Cut.app.history.do(C.place(s.id, { source: { media: ids[0] }, at: 12 * T, out: 4 * T, video: 'V1', audio: null, mode: 'overwrite' }));
    const h2 = C.createHistory(JSON.parse(JSON.stringify(Cut.app.history.project)));
    Cut.app.setHistory(h2, null, 'open');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return ids;
  };
  H.scopes = () => { const r = Cut.ui.scopes.last; if (!r) return null; const v = Cut.scopes.views(r.bins, r.layout); const pk = Cut.scopes.vectorPeak(v.vector, r.layout.size);
    const wave = [...Cut.scopes.peaks(v.wave, r.layout.cols)];
    return { backend: r.backend, t: r.t, count: Cut.ui.scopes.count, angle: pk.angle, magnitude: pk.magnitude, waveFirst: wave[0], waveLast: wave[wave.length - 1], waveMid: wave[wave.length >> 1], rising: wave.every((l, i) => !i || l >= wave[i - 1]) }; };
  H.pixel = async () => (await Cut.ui.overlay.pickColorAt(0.5, 0.5)).map((x) => Math.round(x));
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { modifiers = 0, count = 1 } = {}) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers });
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', p.x, p.y, { modifiers, clickCount: i });
    await mouse('mouseReleased', p.x, p.y, { modifiers, buttons: 0, clickCount: i });
  }
  await sleep(120);
}
async function drag(a, b, { steps = 12, pause = 20, during } = {}) {
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await sleep(pause);
    if (during) await during(i);
  }
  await mouse('mouseReleased', b.x, b.y);
  await sleep(150);
}
const rect = (sel) => js(`__co.rect(${S(sel)})`);
async function click(sel) {
  await js(`document.querySelector(${S(sel)})?.scrollIntoView({ block: 'nearest' })`);
  const r = await rect(sel);
  if (!r) throw new Error(`nothing at ${sel}`);
  await clickAt(r);
}
async function space() {
  const base = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
// The scopes once they have counted a render made after `since` (performance.now() in the page).
const scopesAfter = async (since, label) => {
  await until(`(Cut.ui.scopes.last?.at || 0) > ${since} && Cut.ui.scopes.last.t === Cut.app.t`, label, 8000).catch(() => {});
  return js('__co.scopes()');
};
const now = () => js('performance.now()');
// The curve square's point (0..1, 0..1) in the page.
const curvePt = (u, v) => js(`(() => { const c = document.querySelector('.cut-lm-curve'); c.scrollIntoView({ block: 'nearest' }); const r = c.getBoundingClientRect(); const p = Number(c.dataset.pad);
  return { x: r.left + p + ${u} * (r.width - 2 * p), y: r.top + p + (1 - ${v}) * (r.height - 2 * p) }; })()`);
async function focusTimeline() {
  const p = await js(`(() => { const b = document.querySelector('.cut-panel[data-panel="timeline"] .cut-tl-scroll').getBoundingClientRect(); return { x: b.right - 30, y: b.bottom - 12 }; })()`);
  await clickAt(p);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
}

await js(`__co.fresh()`);
await js(`Cut.ui.setWorkspace('color')`);
await sleep(600);

// ---------- the workspace ----------
await section('layout', async () => {
  const lay = await js(`(() => {
    const at = (id) => { const n = document.querySelector('.cut-grid .cut-panel[data-panel="' + id + '"]'); return n && n.offsetParent ? n.getBoundingClientRect().toJSON() : null; };
    return { scopes: at('scopes'), program: at('program'), color: at('color'), tabs: [...document.querySelectorAll('.cut-slot-tab')].map((t) => t.textContent) };
  })()`);
  check(lay.scopes && lay.program && lay.color && lay.scopes.right <= lay.program.left + 2 && lay.program.right <= lay.color.left + 2 && Math.abs(lay.scopes.top - lay.program.top) < 4,
    `the Color workspace: Lumetri Scopes left of the program monitor, Lumetri Color right of it (${S(lay.tabs)})`);
  check(lay.tabs.includes('Lumetri Scopes') && lay.tabs.includes('Lumetri Color'), 'the tabs are named Lumetri Scopes and Lumetri Color');
  const secs = await js(`[...document.querySelectorAll('.cut-lm-sec')].map((s) => s.dataset.section + (s.classList.contains('collapsed') ? '-' : '+'))`);
  check(S(secs) === S(['basic+', 'creative+', 'curves+', 'hsl+', 'vignette-']), `Lumetri Color's sections in Premiere's order, Vignette folded (${S(secs)})`);
  await click('.cut-lm-sec[data-section="hsl"] .cut-lm-secname');
  check(await js(`document.querySelector('.cut-lm-sec[data-section="hsl"]').classList.contains('collapsed') && JSON.stringify(ide.settings.get('cut.color.collapsed')).includes('hsl')`), 'a click on a section\'s name folds it, and the setting keeps it');
  await click('.cut-lm-sec[data-section="hsl"] .cut-lm-twisty');
  check(await js(`!document.querySelector('.cut-lm-sec[data-section="hsl"]').classList.contains('collapsed')`), 'the twisty opens it again');
  const vis = await js(`(() => { const c = document.querySelector('.cut-scope[data-scope="vector"] canvas'); const r = c.getBoundingClientRect(); const n = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { w: r.width, h: r.height, hit: n === c || c.parentElement.contains(n) }; })()`);
  check(vis.w > 60 && vis.h > 60 && vis.hit, `the vectorscope is on screen (${Math.round(vis.w)}x${Math.round(vis.h)})`);
});

// ---------- the scopes follow the program monitor ----------
await section('scopes', async () => {
  const at = async (t, label) => { const s = await now(); await js(`(Cut.app.setTime(${t} * ${T}), true)`); return scopesAfter(s, label); };
  const gray = await at(1, 'the scopes of the gray solid');
  check(gray?.backend === 'webgpu' && gray.magnitude < 0.02 && gray.waveMid >= 126 && gray.waveMid <= 130, `the gray solid: the vectorscope's point in the middle, the waveform at level 128 (${S(gray)})`);
  const red = await at(5, 'the scopes of the red solid');
  check(red && Math.abs(red.angle - 102.9) < 2, `moving the playhead onto the 75% red: the vectorscope point goes to red's angle (${red?.angle.toFixed(1)} degrees, want 102.9)`);
  const blue = await at(9, 'the scopes of the blue solid');
  check(blue && Math.abs(blue.angle - 354.8) < 2, `and onto the 75% blue: blue's angle (${blue?.angle.toFixed(1)} degrees, want 354.8)`);
  const ramp = await at(13, 'the scopes of the ramp');
  check(ramp && ramp.waveFirst <= 2 && ramp.waveLast >= 253 && ramp.rising, `the ramp image is the waveform's diagonal (${ramp?.waveFirst} to ${ramp?.waveLast}, rising)`);
  // scrubbing: a drag along the ruler from 1 s to 5 s
  await js(`(Cut.app.setTime(0), true)`);
  const ruler = await rect('.cut-tl-ruler');
  const x = (t) => js(`Cut.ui.timeline.clientPoint(${t} * ${T}, 'V1', 0.5).x`);
  const before = await js('Cut.ui.scopes.count');
  const seen = [];
  await drag({ x: await x(1), y: ruler.y }, { x: await x(5.5), y: ruler.y }, { steps: 16, pause: 60, during: async () => { seen.push(await js(`({ n: Cut.ui.scopes.count, t: Cut.ui.scopes.last?.t })`)); } });
  const after = await scopesAfter(-1, 'the scopes after the scrub');
  const counted = seen.at(-1).n - before;
  check(counted >= 5 && after && Math.abs(after.angle - 102.9) < 2 && Math.abs(after.t / T - 5.5) < 0.2, `while scrubbing along the ruler the scopes count again and again (${counted} counts in 16 moves) and end on the red (${after?.angle.toFixed(1)} degrees at ${(after?.t / T).toFixed(2)} s)`);
  // the toggles
  await click('.cut-scopes-toggle[data-scope="hist"]');
  await click('.cut-scopes-toggle[data-scope="parade"]');
  let shown = await js('Cut.ui.scopes.shown');
  check(S(shown) === S(['wave', 'parade', 'vector', 'hist']) && await js(`[...document.querySelectorAll('.cut-scopes-grid .cut-scope')].map((n) => n.dataset.scope).join() === 'wave,parade,vector,hist'`), `the toggles add the parade and the histogram, in Premiere's menu order (${S(shown)})`);
  const lit = await js(`(() => { const c = document.querySelector('.cut-scope[data-scope="hist"] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 1] < 90) n++; return n; })()`);
  check(lit > 20, `the histogram is drawn: red bars for the red solid (${lit} red pixels)`);
  await click('.cut-scopes-toggle[data-scope="parade"]');
  shown = await js('Cut.ui.scopes.shown');
  check(S(shown) === S(['wave', 'vector', 'hist']) && S(await js(`ide.settings.get('cut.scopes.show')`)) === S(shown), 'a second click hides the parade; the setting keeps the choice');
});

// ---------- playing ----------
await section('play', async () => {
  const mp4 = path.join(home, 'src-1080p30.mp4');
  const made = await js(`(async () => { const r = await Cut.testsrc.write(${S(mp4)}, { seconds: 12, fps: [30, 1], w: 1920, h: 1080 }); return r.ok ? 'ok' : JSON.stringify(r.error); })()`);
  check(made === 'ok', `a 12 s 1080p30 test source is written (${made})`);
  await js(`(async () => { const ids = await __co.fresh([${S(mp4)}]); Cut.app.history.do(Cut.commands.place(__co.seq().id, { source: { media: ids[1] }, at: 0, video: 'V2', audio: null, mode: 'overwrite' })); return true; })()`);
  await sleep(500);
  const run = async () => {
    await js(`(Cut.app.setTime(0), true)`);
    await focusTimeline();
    const c0 = await js('Cut.ui.scopes.count');
    await space();
    await sleep(6000);
    const st = await js(`(() => { const s = Cut.ui.monitors.program.player.stats(); return { dropped: s.dropped, fps: s.fps, playing: Cut.app.playing }; })()`);
    const c1 = await js('Cut.ui.scopes.count');
    await space();
    await sleep(600);
    return { ...st, counts: c1 - c0 };
  };
  // A first play warms the decoder and the audio clock up (its start is slower, whatever the panels): not measured.
  await run();
  const withScopes = await run();
  // the scopes' slot shows the source monitor instead: the panel is off screen and counts nothing
  await click('.cut-slot-tab[data-panel="source"]');
  const without = await run();
  await click('.cut-slot-tab[data-panel="scopes"]');
  log(`NOTE playing the 1080p30 source for 6 s: with the scopes ${withScopes.dropped} dropped (${withScopes.fps.toFixed(1)} fps, ${withScopes.counts} counts), without ${without.dropped} (${without.fps.toFixed(1)} fps, ${without.counts} counts)`);
  check(withScopes.playing && withScopes.counts >= 20 && withScopes.counts <= 60, `while playing the scopes count about every 150 ms (${withScopes.counts} counts in 6 s)`);
  check(without.counts === 0, `a scopes panel off screen counts nothing (${without.counts})`);
  check(withScopes.dropped <= without.dropped + 6 && withScopes.fps >= without.fps - 2, `the scopes cost no playback frames (${withScopes.dropped} vs ${without.dropped} dropped, ${withScopes.fps.toFixed(1)} vs ${without.fps.toFixed(1)} fps)`);
  await js(`__co.fresh()`);
  await sleep(300);
});

// ---------- curves ----------
await section('curves', async () => {
  await js(`(Cut.app.setTime(1 * ${T}), Cut.app.select([__co.clip(0).id]), true)`);
  await sleep(400);
  const base = await js('__co.pixel()');
  const steps0 = await js('__co.steps()');
  const s0 = await now();
  await drag(await curvePt(0.5, 0.5), await curvePt(0.5, 0.75), { steps: 10 });
  const p = await js('__co.params(0)');
  const pts = p?.curveMaster ? Cut_points(p.curveMaster) : [];
  check(pts.length === 3 && Math.abs(pts[1][0] - 0.5) < 0.03 && Math.abs(pts[1][1] - 0.75) < 0.03, `a press on the curve square adds a point and drags it up: the master curve ${S(p?.curveMaster)}`);
  check((await js('__co.steps()')) === steps0 + 1, 'adding the point and dragging it is one undo step, the new Lumetri Color included');
  const lifted = await js('__co.pixel()');
  check(lifted[0] > base[0] + 25 && lifted[0] === lifted[2], `the program monitor's gray gets brighter (${base[0]} -> ${lifted[0]})`);
  const sc = await scopesAfter(s0, 'the scopes after the curve');
  check(sc && sc.waveMid > 150, `and the waveform shows it: level ${sc?.waveMid} (was 128)`);
  // the red channel
  await click('.cut-lm-chan[data-channel="curveRed"]');
  await drag(await curvePt(0.5, 0.5), await curvePt(0.5, 0.2), { steps: 8 });
  const red = await js('__co.params(0).curveRed');
  const px2 = await js('__co.pixel()');
  check(Array.isArray(red) && red.length === 6 && px2[0] < lifted[0] - 20 && Math.abs(px2[1] - lifted[1]) <= 1, `the red channel's curve lowers red only (${S(lifted)} -> ${S(px2)})`);
  check(await js(`document.querySelector('.cut-lm-chan[data-channel="curveRed"]').classList.contains('changed') && document.querySelector('.cut-lm-chan[data-channel="curveRed"]').getAttribute('aria-checked') === 'true'`), 'the red button is chosen and marked as changed');
  // Ctrl+click on the point removes it, a double click straightens
  await clickAt(await curvePt(red[2], red[3]), { modifiers: 2 });
  check((await js('__co.params(0).curveRed?.length ?? 4')) === 4, `Ctrl+click on the point removes it (${S(await js('__co.params(0).curveRed ?? null'))})`);
  await click('.cut-lm-chan[data-channel="curveMaster"]');
  await clickAt(await curvePt(0.2, 0.9), { count: 2 });
  check(await js('!__co.params(0).curveMaster'), 'a double click on the square straightens the master curve');
  await focusTimeline();
  await press('Ctrl+z');
  await sleep(200);
  check(S(await js('__co.params(0).curveMaster')) === S(p.curveMaster), 'Ctrl+Z brings the bent master curve back');
});
function Cut_points(flat) { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; }

// ---------- the Look ----------
await section('lut', async () => {
  await js(`(Cut.app.setTime(5 * ${T}), Cut.app.select([__co.clip(1).id]), true)`);
  await sleep(400);
  const before = await js('__co.pixel()');
  answer({ pickLut: invertCube, saveAs: savedProject });
  const steps0 = await js('__co.steps()');
  await click('.cut-lm-browse');
  await until(`!!__co.params(1)?.lut`, 'the Look is set', 10000).catch(() => {});
  const st = await js(`(() => { const p = __co.params(1); const e = p && Cut.app.project.luts?.[p.lut]; return { lut: p?.lut, size: e?.size, name: e?.name, sel: document.querySelector('.cut-lm-lutsel').selectedOptions[0]?.textContent, info: document.querySelector('.cut-lm-lutinfo').textContent }; })()`);
  check(st.size === 17 && st.name === 'invert.cube' && st.sel === 'invert.cube' && /Invert/.test(st.info), `Browse… loads the .cube into the project and the Look names it (${S(st)})`);
  check((await js('__co.steps()')) === steps0 + 1, 'loading the Look is one undo step');
  const inv = await js('__co.pixel()');
  check(inv[0] <= 66 && inv[0] >= 62 && inv[1] >= 253 && inv[2] >= 253, `the inverting look turns the 75% red cyan (${S(before)} -> ${S(inv)})`);
  // intensity: typed 50%
  await click('.cut-color-row[data-param="lutIntensity"] .cut-number');
  await until(`!!document.querySelector('.cut-color-row[data-param="lutIntensity"] .cut-number-input')`, 'the intensity field turns into an input');
  await press('Ctrl+a');
  await ctx.type('50');
  await press('Enter');
  await sleep(300);
  const halfway = await js('__co.pixel()');
  check((await js('__co.params(1).lutIntensity')) === 50 && halfway[0] > 110 && halfway[0] < 140 && halfway[1] > 110 && halfway[1] < 140, `at 50% intensity red and cyan meet half way in sRGB values (${S(halfway)})`);
  // bad files: refused with the reason, nothing changes
  const luts0 = await js('JSON.stringify(Object.keys(Cut.app.project.luts))');
  const steps1 = await js('__co.steps()');
  for (const [file, re] of [[shortCube, /has 4874 data lines; LUT_3D_SIZE 17 needs 4913/], [oneD, /1D LUTs are not supported/]]) {
    answer({ pickLut: file });
    await click('.cut-lm-browse');
    await until(`!document.querySelector('.cut-lm-luterror').hidden`, 'the refusal shows', 8000).catch(() => {});
    const msg = await js(`document.querySelector('.cut-lm-luterror').hidden ? null : document.querySelector('.cut-lm-luterror').textContent`);
    check(msg && msg.startsWith(path.basename(file)) && re.test(msg), `${path.basename(file)} is refused with its reason: "${msg}"`);
    check((await js('JSON.stringify(Object.keys(Cut.app.project.luts))')) === luts0 && (await js('__co.steps()')) === steps1 && (await js('__co.params(1).lut')) === st.lut, 'and the project, the Look and the undo steps stay as they were');
  }
  await focusTimeline();
  await press('Ctrl+z');
  await press('Ctrl+z');
  await sleep(200);
  check(await js('!__co.params(1)?.lut && !Object.keys(Cut.app.project.luts || {}).length'), 'Ctrl+Z (twice: intensity, then the load) takes the Look and the LUT out of the project');
  await press('Ctrl+Shift+z');
  await press('Ctrl+Shift+z');
  await sleep(300);
  check((await js('__co.params(1)?.lut')) === st.lut && (await js('__co.params(1).lutIntensity')) === 50, 'redo brings them back');
  // save, delete the .cube, open again: the project carries the LUT
  const saved = await js('Cut.ui.lifecycle.saveAs()');
  check(saved !== false && existsSync(savedProject), `the project is saved (${savedProject})`);
  rmSync(invertCube);
  await js(`__co.fresh()`);
  const opened = await js(`Cut.ui.lifecycle.openPath(${S(savedProject)}, { ask: false })`);
  await js(`(Cut.app.setTime(5 * ${T}), Cut.app.select([__co.clip(1).id]), true)`);
  await sleep(600);
  const again = await js('__co.pixel()');
  check(opened !== false && !existsSync(invertCube) && (await js('Object.values(Cut.app.project.luts || {})[0]?.name')) === 'invert.cube' && Math.abs(again[0] - halfway[0]) <= 1 && Math.abs(again[1] - halfway[1]) <= 1,
    `with the .cube file deleted the reopened project still has its LUT and draws the same look (${S(again)})`);
  await js(`__co.fresh()`);
  await sleep(300);
});

// ---------- HSL secondary ----------
await section('hsl', async () => {
  await js(`(Cut.app.setTime(5 * ${T}), Cut.app.select([__co.clip(1).id]), true)`);
  await sleep(400);
  const program = await rect('.cut-panel[data-panel="program"] canvas.cut-monitor-canvas');
  await click('.cut-lm-hsldropper');
  await sleep(100);
  await clickAt({ x: program.x, y: program.y });
  await until(`__co.resolved(1)?.hslHueRange === 50`, 'the eyedropper sets the key', 8000).catch(() => {});
  const key = await js('__co.resolved(1)');
  check(key && Math.abs(key.hslHue) < 3 && key.hslHueRange === 50 && key.hslSatHigh === 100, `the HSL eyedropper keys the red it was clicked on (${S(key && { hue: key.hslHue, sat: [key.hslSatLow, key.hslSatHigh], lum: [key.hslLumLow, key.hslLumHigh] })})`);
  await click('.cut-color-row[data-param="hslSaturation"] .cut-number');
  await until(`!!document.querySelector('.cut-color-row[data-param="hslSaturation"] .cut-number-input')`, 'the saturation field turns into an input');
  await press('Ctrl+a');
  await ctx.type('0');
  await press('Enter');
  await sleep(400);
  const gray = await js('__co.pixel()');
  check(Math.max(...gray) - Math.min(...gray) <= 2 && gray[0] > 60 && gray[0] < 120, `saturation 0 inside the key turns the red gray at its luminance (${S(gray)})`);
  await click('.cut-lm-mask input');
  await sleep(300);
  const masked = await js('__co.pixel()');
  check((await js('__co.resolved(1).hslMask')) === true && masked[0] > 180 && masked[1] < 10, `Show Mask: the keyed red shows in its color (${S(masked)})`);
  // the same key on the blue solid: outside it, middle gray
  await js(`(() => { const p = __co.params(1); const e = __co.lumetri(1); Cut.app.history.do(Cut.commands.addEffect(__co.seq().id, __co.clip(2).id, 'color.basic', null, p)); Cut.app.setTime(9 * ${T}); return true; })()`);
  await sleep(400);
  const outside = await js('__co.pixel()');
  check(outside.every((v) => Math.abs(v - 128) <= 1), `with Show Mask the blue solid, outside the key, is middle gray (${S(outside)})`);
  await click('.cut-lm-mask input');
  await sleep(200);
  check((await js('__co.resolved(1).hslMask')) === false, 'the checkbox turns the mask off');
});

// ---------- effect controls ----------
await section('controls', async () => {
  await js(`(Cut.app.setTime(1 * ${T}), Cut.app.select([__co.clip(0).id]), true)`);
  await js(`(Cut.app.history.do(Cut.commands.addEffect(__co.seq().id, __co.clip(0).id, 'color.basic', null, { curveMaster: [0, 0, 0.5, 0.7, 1, 1] })), true)`);
  await click('.cut-slot-tab[data-panel="controls"]');
  await sleep(300);
  const ec = await js(`(() => { const sec = [...document.querySelectorAll('.cut-ec-sec')].find((s) => s.querySelector('.cut-ec-secname')?.textContent === 'Lumetri Color'); if (!sec) return null;
    return { heads: [...sec.querySelectorAll('.cut-ec-subhead')].map((n) => n.textContent), curve: sec.querySelector('.cut-ec-row[data-path$=".curveMaster"] .cut-ec-note')?.textContent, look: sec.querySelector('.cut-ec-row[data-path$=".lut"] .cut-ec-note')?.textContent,
      watch: !!sec.querySelector('.cut-ec-row[data-path$=".curveMaster"] .watch, .cut-ec-row[data-path$=".curveMaster"] [aria-label="Toggle Animation"]') }; })()`);
  check(ec && S(ec.heads) === S(['Basic Correction', 'Creative', 'Curves', 'HSL Secondary']) && ec.curve === '3 points' && ec.look === 'None', `Effect Controls shows Lumetri Color in its groups, the curve's points and the Look (${S(ec)})`);
  await click('.cut-slot-tab[data-panel="color"]');
  await sleep(200);
});

// ---------- screenshots ----------
await section('shots', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'cut-color');
  mkdirSync(dir, { recursive: true });
  answer({ pickLut: path.join(files, 'warm.cube') });
  writeFileSync(path.join(files, 'warm.cube'), cube(17, (r, g, b) => [Math.min(1, r * 1.08 + 0.03), g * 0.98 + 0.01, b * 0.85]));
  await js(`(Cut.app.setTime(13 * ${T}), Cut.app.select([__co.clip(3).id]), true)`);
  await sleep(300);
  await click('.cut-lm-browse');
  await sleep(500);
  await drag(await curvePt(0.25, 0.25), await curvePt(0.25, 0.18));
  await drag(await curvePt(0.75, 0.75), await curvePt(0.75, 0.84));
  await click('.cut-scopes-toggle[data-scope="parade"]');
  await sleep(600);
  const shot = async (name) => { const b64 = (await cdp('Page.captureScreenshot', { format: 'png' })).result?.data; const f = path.join(dir, name); writeFileSync(f, Buffer.from(b64, 'base64')); return f; };
  log(`  saved ${await shot('color-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(800);
  log(`  saved ${await shot('color-light.png')}`);
  await js(`document.querySelector('.cut-lm-sec[data-section="hsl"]').scrollIntoView()`);
  await sleep(300);
  log(`  saved ${await shot('color-hsl-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  await sleep(600);
  log(`  saved ${await shot('color-hsl-dark.png')}`);
  const errs = await js('Cut.ui.monitors.program.player.compositor.errors.slice()');
  check(errs.length === 0, `no WebGPU validation errors in the program monitor (${S(errs)})`);
});

await ctx.finish();
