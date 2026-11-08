// Nano Studio Cut's Audio Track Mixer, Essential Sound and clip audio effects in the real app (features §12), with
// real input events (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and the real export:
// - the Audio workspace: its tab, the mixer (a strip per audio track and a master strip), Essential Sound, the meters;
// - a fader drag changes the track volume (the timeline header's percent follows), one undo step, Ctrl+Z puts it back;
//   the top is +6 dB (200%); Alt+click is 0 dB; the master fader is the sequence's masterGain; the pan knob, mute and
//   solo change the track, a knob drag one step; while the program plays the strips' meters show the track's level
//   (and nothing for a muted track);
// - the effect controls show the Parametric Equalizer's parameters and its frequency response graph; a value typed in
//   a field changes the effect; Essential Sound adds its effects to the selected clip in one step and sets its type;
// - an export with an EQ cut at 1 kHz measures lower at 1 kHz than one without it, and the same at 300 Hz;
// - the preview engine's blocks and the export mixer's blocks of a clip with an EQ, a compressor and a limiter are the
//   same samples;
// - screenshots of the Audio workspace in the dark and the light theme (verify/out/cut-mixer/*.png).
// Usage: node verify/cut-mixer.mjs   (CUT_MIXER_ONLY=workspace,fader,meters,controls,export,same,shots)
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_MIXER_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-mixer-home');
const ctx = await launch({ fixture: 'core', port: 9778, name: 'cut-mixer', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['commands', 'model', 'audioengine', 'audiofx', 'effects', 'export', 'media'].every((k) => !!Cut[k]) && ['mixer', 'essential', 'meters', 'controls'].every((p) => Cut.ui.panels.has(p)) && !!Cut.ui.effectViews?.['audio.eq']`),
  'the modules and panels this suite uses are loaded');

const dirs = await js(`ide.api.invoke('cut:home')`);
const P = (name) => path.join(dirs.projects, name);

// ---------- page helpers ----------
await js(`(() => {
  const H = (window.__mx = {});
  const T = Cut.time.TICKS;
  H.seq = () => Cut.app.sequence;
  H.track = (id) => H.seq().tracks.find((t) => t.id === id);
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left }; };
  H.visible = (sel) => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); if (!r.width || !r.height) return false; const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && n.contains(hit); };
  // A WAV of sines [[Hz, dBFS]] in both channels.
  H.wav = async (file, tones, seconds = 10) => {
    const rate = 48000, n = rate * seconds;
    const b = new Uint8Array(44 + n * 4);
    const v = new DataView(b.buffer);
    const str = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (const [f, d] of tones) x += 10 ** (d / 20) * Math.sin((2 * Math.PI * f * i) / rate);
      const s = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
      v.setInt16(44 + i * 4, s, true);
      v.setInt16(46 + i * 4, s, true);
    }
    return (await Cut.export.saveBytes(file, b)).ok;
  };
  // A fresh project in the app with a clip of the file on A1 (no undo steps).
  H.fresh = async (file, seconds = 10) => {
    const C = Cut.commands;
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1] } }), { limit: Infinity });
    Cut.app.setHistory(h, null, 'open');
    const list = await Cut.media.importFiles([file]);
    if (list.some((m) => m.error)) throw new Error(JSON.stringify(list));
    const [m] = h.do(C.importMedia(list)).ids;
    const [clip] = h.do(C.place(H.seq().id, { source: { media: m }, in: 0, out: seconds * T, at: 0, video: null, audio: 'A1', mode: 'overwrite' })).ids;
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project)), { limit: Infinity }), null, 'open');
    Cut.app.setTime(0);
    Cut.app.select([clip]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return clip;
  };
  H.steps = () => Cut.app.history.position;
  H.label = () => Cut.app.history.list()[Cut.app.history.position - 1]?.label;
  // Amplitude of a sine at f over [from, to) seconds of a decoded track (a fit over whole periods).
  H.amp = (pcm, f, from, to) => {
    const x = pcm.data[0];
    const r = pcm.rate;
    const n0 = Math.round(from * r);
    const per = r / f;
    const n1 = n0 + Math.floor(((to - from) * r) / per) * per;
    let s = 0, c = 0;
    for (let i = n0; i < n1; i++) { s += x[i] * Math.sin((2 * Math.PI * f * i) / r); c += x[i] * Math.cos((2 * Math.PI * f * i) / r); }
    return 20 * Math.log10((2 / (n1 - n0)) * Math.hypot(s, c));
  };
  H.decode = async (file) => {
    const reader = await Cut.audioengine.fileReader(file);
    const source = await Cut.probe.open(reader, { name: file });
    return Cut.audioengine.decodeTrack(reader, source.tracks.find((t) => t.kind === 'audio'));
  };
  H.pixel = (canvas, x, y) => { const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width; return [...canvas.getContext('2d').getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data]; };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { modifiers = 0, clickCount = 1 } = {}) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y, { modifiers, clickCount });
  await mouse('mouseReleased', p.x, p.y, { buttons: 0, modifiers, clickCount });
  await sleep(100);
}
async function drag(a, b, { steps = 12, pause = 16 } = {}) {
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await sleep(pause);
  }
  await mouse('mouseReleased', b.x, b.y);
  await sleep(150);
}
const rect = (sel) => js(`__mx.rect(${S(sel)})`);
const steps = () => js('__mx.steps()');
const label = () => js('__mx.label()');
async function workspace(id) {
  await clickAt(await rect(`.cut-ws-tab[data-ws="${id}"]`));
  await until(`Cut.ui.workspace === ${S(id)}`, `the ${id} workspace`, 5000);
  await sleep(200);
}
async function showTab(panel) {
  const r = await rect(`.cut-grid .cut-slot-tab[data-panel="${panel}"]`);
  if (!r) return false;
  await clickAt(r);
  await sleep(150);
  return true;
}
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
  if (await js('Cut.app.playing')) await js('(Cut.ui.monitors.program.player.stop?.(), true)');
  await press('Escape');
  await js(`(document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()), ide.ui.closeMenus(), true)`);
}

const toneWav = P('tone-20.wav');
check(await js(`__mx.wav(${S(toneWav)}, [[1000, -20]])`), 'a 10 s 1 kHz sine at -20 dBFS is written');
const twoWav = P('two-tones.wav');
check(await js(`__mx.wav(${S(twoWav)}, [[300, -20], [1000, -20]])`), 'a 10 s file of 300 Hz and 1 kHz at -20 dBFS each is written');

// ---------- the Audio workspace ----------
await section('workspace', async () => {
  await js(`__mx.fresh(${S(toneWav)})`);
  check(await js(`!!document.querySelector('.cut-ws-tab[data-ws="audio"]')`), 'the top bar has an Audio workspace tab');
  await workspace('audio');
  const tabs = await js(`['mixer', 'essential', 'meters', 'timeline', 'program'].map((p) => !!document.querySelector('.cut-grid .cut-slot-tab[data-panel="' + p + '"]'))`);
  check(tabs.every(Boolean), `the Audio workspace has the Audio Track Mixer, Essential Sound, Audio Meters, the timeline and the program monitor (${S(tabs)})`);
  await showTab('mixer');
  const strips = await js(`[...document.querySelectorAll('.cut-mx-strip')].map((n) => n.dataset.track)`);
  const audio = await js(`__mx.seq().tracks.filter((t) => t.kind === 'audio').map((t) => t.id)`);
  check(S(strips) === S([...audio, 'master']), `a strip per audio track and a master strip (${S(strips)})`);
  check(await js(`__mx.visible('.cut-mx-strip[data-track="A1"] .cut-mx-cap') && __mx.visible('.cut-mx-strip[data-track="master"] .cut-mx-cap')`), 'the faders are on screen');
  const names = await js(`[...document.querySelectorAll('.cut-mx-strip')].map((n) => n.querySelector('.cut-mx-name-text').textContent)`);
  check(names.at(-1) === 'Master' && names[0] === (await js(`__mx.track('A1').name || 'A1'`)), `the strips are named (${S(names)})`);
  check(await js(`ide.actions.some((a) => a.id === 'Cut.window.mixer') && ide.actions.some((a) => a.id === 'Cut.window.essential')`), 'Find Action has Window: Audio Track Mixer and Window: Essential Sound');
});

// ---------- faders, pan, mute, solo ----------
await section('fader', async () => {
  await js(`__mx.fresh(${S(toneWav)})`);
  await workspace('audio');
  await showTab('mixer');
  await sleep(150);
  const g = await js(`Cut.ui.mixer.fader('A1')`);
  const unity = await js(`Cut.ui.mixer.posOf(0)`);
  check(Math.abs(g.cap.y - (g.bottom - (g.bottom - g.top) * unity)) < 1.5, `at 0 dB the cap sits at the 0 dB mark (${g.cap.y.toFixed(1)})`);
  const s0 = await steps();
  await drag(g.cap, { x: g.cap.x, y: g.cap.y + 40 });
  const after = await js(`({ db: __mx.track('A1').volume, pct: document.querySelector('.cut-tl-head[data-track="A1"] .cut-tl-hvol-text, [data-track="A1"] .cut-tl-hvol-text')?.textContent, value: document.querySelector('.cut-mx-strip[data-track="A1"] .cut-mx-value').textContent })`);
  const wantDb = await js(`Math.round(Cut.ui.mixer.dbOf(Cut.ui.mixer.posOf(0) - 40 / (${g.bottom} - ${g.top})) * 10) / 10`);
  check(Math.abs(after.db - wantDb) <= 0.2 && after.db < -3, `dragging the A1 fader 40 px down lowers the track volume (${after.db} dB, the scale says ${wantDb} dB; shown ${after.value})`);
  const pct = Math.round(100 * 10 ** (after.db / 20));
  check(after.pct === undefined || after.pct === null || after.pct === `${pct}%`, `the timeline header shows the same volume in percent (${after.pct} for ${pct}%)`);
  check((await steps()) === s0 + 1 && (await label()) === 'Track Volume', `the drag is one undo step (${(await steps()) - s0}, ${await label()})`);
  await press('Ctrl+z');
  await sleep(150);
  check(await js(`__mx.track('A1').volume === 0 && Cut.app.history.position === ${s0}`), 'Ctrl+Z puts the volume back to 0 dB');
  const g2 = await js(`Cut.ui.mixer.fader('A1')`);
  check(Math.abs(g2.cap.y - g.cap.y) < 1, 'and the cap back to its place');
  // up past the top: 200%
  await drag(g2.cap, { x: g2.cap.x, y: g2.top - 60 });
  const top = await js(`__mx.track('A1').volume`);
  check(Math.abs(top - 20 * Math.log10(2)) < 0.05, `the top of the fader is +6 dB, the 200% of the timeline header (${top} dB)`);
  await clickAt(await js(`Cut.ui.mixer.fader('A1').cap`), { modifiers: 1 });
  check(await js(`__mx.track('A1').volume === 0`), 'Alt+click puts it back to 0 dB');
  // the master fader is the sequence's masterGain
  const m = await js(`Cut.ui.mixer.fader('master')`);
  const s1 = await steps();
  await drag(m.cap, { x: m.cap.x, y: m.cap.y + 30 });
  const mg = await js(`__mx.seq().masterGain`);
  check(mg < -2 && (await steps()) === s1 + 1 && (await label()) === 'Master Volume', `the master fader lowers the sequence's master gain in one step (${mg} dB, ${await label()})`);
  await press('Ctrl+z');
  await sleep(150);
  check(await js(`__mx.seq().masterGain === 0`), 'and Ctrl+Z puts it back');
  // the pan knob
  const knob = await js(`__mx.rect('.cut-mx-strip[data-track="A1"] .cut-mx-knob')`);
  const s2 = await steps();
  await drag(knob, { x: knob.x + 30, y: knob.y });
  const pan = await js(`__mx.track('A1').pan`);
  check(pan === 30 && (await steps()) === s2 + 1 && (await label()) === 'Track Pan', `dragging the pan knob 30 px right pans the track to 30 in one step (${pan}, ${await label()})`);
  check(await js(`document.querySelector('.cut-mx-strip[data-track="A1"] .cut-mx-panvalue').textContent === '30'`), 'the knob shows 30');
  await clickAt(knob, { modifiers: 1 });
  check(await js(`__mx.track('A1').pan === 0`), 'Alt+click centers it');
  await clickAt(await js(`__mx.rect('.cut-mx-strip[data-track="A1"] .cut-mx-mute')`));
  check(await js(`__mx.track('A1').mute === true && document.querySelector('.cut-mx-strip[data-track="A1"] .cut-mx-mute').getAttribute('aria-pressed') === 'true'`), 'M mutes the track and shows it pressed');
  await clickAt(await js(`__mx.rect('.cut-mx-strip[data-track="A1"] .cut-mx-mute')`));
  await clickAt(await js(`__mx.rect('.cut-mx-strip[data-track="A2"] .cut-mx-solo')`));
  check(await js(`__mx.track('A1').mute === false && __mx.track('A2').solo === true`), 'M again unmutes; S solos A2');
  await clickAt(await js(`__mx.rect('.cut-mx-strip[data-track="A2"] .cut-mx-solo')`));
  // a value typed into the dB box
  check(await js(`__mx.track('A2').solo === false`), 'S again ends the solo');
  // An edit elsewhere (the timeline header's menu path, here the command) moves the fader.
  await js(`(Cut.app.history.do(Cut.commands.setTrack(__mx.seq().id, 'A1', { volume: -12 })), true)`);
  await sleep(100);
  const g3 = await js(`Cut.ui.mixer.fader('A1')`);
  check(Math.abs(g3.cap.y - (g3.bottom - (g3.bottom - g3.top) * (await js('Cut.ui.mixer.posOf(-12)')))) < 1.5 && (await js(`document.querySelector('.cut-mx-strip[data-track="A1"] .cut-mx-value').textContent`)) === '-12.0 dB',
    'a volume set elsewhere moves the fader and its value');
});

// ---------- meters ----------
await section('meters', async () => {
  // The sine on A1 and again on A2 turned down 12 dB: A1 -20, A2 -32, the master their sum (-18.05 dBFS, in phase).
  const clip = await js(`__mx.fresh(${S(toneWav)})`);
  await js(`(() => { const C = Cut.commands, s = __mx.seq().id, c = __mx.seq().clips.find((x) => x.id === ${S(clip)}); Cut.app.history.do(C.place(s, { source: { media: c.source.media }, in: 0, out: 10 * Cut.time.TICKS, at: 0, video: null, audio: 'A2', mode: 'overwrite' })); Cut.app.history.do(C.setTrack(s, 'A2', { volume: -12 })); return true; })()`);
  await workspace('audio');
  await showTab('mixer');
  await js(`(Cut.app.setTime(Cut.time.TICKS), true)`);
  await clickAt(await rect('.cut-panel[data-panel="program"]'));
  const samples = [];
  await space();
  const t0 = Date.now();
  while (Date.now() - t0 < 1800) { samples.push(await js(`({ playing: Cut.app.playing, s: Cut.ui.mixer.strips })`)); await sleep(80); }
  // The A1 meter's pixels: lit at -40 dB, dark at -6 dB (the level is -20 dBFS).
  const lit = await js(`(() => { const c = document.querySelector('.cut-mx-strip[data-track="A1"] .cut-mx-meter-canvas'); const r = c.getBoundingClientRect(); const y = (d) => r.bottom - ((d + 60) / 60) * r.height; return { at40: __mx.pixel(c, r.left + 2, y(-40)), at6: __mx.pixel(c, r.left + 2, y(-6)) }; })()`);
  // mute A1 while it plays
  await js(`(Cut.app.history.do(Cut.commands.setTrack(__mx.seq().id, 'A1', { mute: true })), true)`);
  await sleep(2200);
  const muted = await js(`({ playing: Cut.app.playing, s: Cut.ui.mixer.strips })`);
  await space();
  const playing = samples.filter((x) => x.playing);
  const top = (id, ch = 0) => Math.max(...playing.map((x) => x.s.find((e) => e.id === id).peak[ch]).filter((v) => v != null));
  const peakOf = (snap, id) => snap.s.find((e) => e.id === id).peak[0];
  check(playing.length > 8 && Math.abs(top('A1') + 20) < 1, `while playing, the A1 strip's meter reads its -20 dBFS sine (${top('A1').toFixed(2)} dB over ${playing.length} samples)`);
  check(Math.abs(top('A2') + 32) < 1, `the A2 strip reads the same sine after its -12 dB fader (${top('A2').toFixed(2)} dB)`);
  check(Math.abs(top('master', 1) + 18.05) < 1, `the master strip reads the sum (${top('master', 1).toFixed(2)} dB)`);
  check(muted.playing && peakOf(muted, 'A1') === null && Math.abs(peakOf(muted, 'A2') + 32) < 1 && Math.abs(peakOf(muted, 'master') + 32) < 1,
    `A1 muted: its meter falls to nothing, A2 and the master read A2 alone (${S(muted.s.map((e) => e.peak))})`);
  check(lit.at40[1] > 120 && lit.at40[1] > lit.at40[0] + 40 && S(lit.at40) !== S(lit.at6), `the A1 meter's canvas is lit green at -40 dB and not at -6 dB (${S(lit)})`);
});

// ---------- effect controls and Essential Sound ----------
await section('controls', async () => {
  const clip = await js(`__mx.fresh(${S(twoWav)})`);
  await workspace('audio');
  const eid = await js(`Cut.app.history.do(Cut.commands.addEffect(__mx.seq().id, ${S(clip)}, 'audio.eq')).id`);
  await showTab('controls');
  await sleep(200);
  const sec = await js(`(() => { const s = document.querySelector('.cut-ec-sec[data-section="fx:${clip}:${eid}"]'); return s ? { name: s.querySelector('.cut-ec-secname').textContent, rows: [...s.querySelectorAll('.cut-ec-row')].map((r) => r.dataset.path), graph: !!s.querySelector('.cut-ec-graph canvas') } : null; })()`);
  check(sec?.name === 'Parametric Equalizer' && sec.rows.length === 25 && sec.rows.includes(`effects.${eid}.b2Gain`) && sec.rows.includes(`effects.${eid}.hpSlope`), `the effect controls list the equalizer's 25 parameters (${sec?.name}, ${sec?.rows?.length})`);
  await js(`(document.querySelector('.cut-ec-graph[data-graph="${eid}"]').scrollIntoView({ block: 'center' }), true)`);
  await sleep(150);
  check(sec?.graph && (await js(`__mx.visible('.cut-ec-graph[data-graph="${eid}"] canvas')`)), 'and its frequency response graph above them');
  // Type -18 into Band 2 Gain (the field scrolled into view first: the panel scrolls).
  await js(`(document.querySelector('.cut-ec-row[data-path="effects.${eid}.b2Gain"]').scrollIntoView({ block: 'center' }), true)`);
  await sleep(150);
  const field = await js(`__mx.rect('.cut-ec-row[data-path="effects.${eid}.b2Gain"] .cut-number')`);
  await clickAt(field, { clickCount: 1 });
  await sleep(100);
  const hasInput = await js(`!!document.querySelector('.cut-ec-row[data-path="effects.${eid}.b2Gain"] input')`);
  if (hasInput) {
    await press('Ctrl+a');
    await ctx.type('-18');
    await press('Enter');
  }
  await sleep(200);
  const g = await js(`__mx.seq().clips.find((c) => c.id === ${S(clip)}).effects[0].params.b2Gain`);
  check(g === -18, `typing -18 into Band 2 Gain sets it (${g})`);
  // The graph's curve dips at 1 kHz: its pixel column at 1 kHz is drawn lower than at 300 Hz.
  await js(`(document.querySelector('.cut-ec-graph[data-graph="${eid}"]').scrollIntoView({ block: 'center' }), true)`);
  await sleep(200);
  const dip = await js(`(() => {
    const n = document.querySelector('.cut-ec-graph[data-graph="${eid}"]');
    const c = n.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const xOf = (f) => r.left + (Math.log10(f / 20) / Math.log10(1000)) * r.width;
    const col = (f) => { const ys = []; for (let y = r.top + 1; y < r.bottom - 1; y++) { const p = __mx.pixel(c, xOf(f), y); if (p[0] > 180 && p[1] > 80 && p[1] < 160 && p[2] < 110) ys.push(y); } return ys.length ? ys.reduce((a, b) => a + b) / ys.length - r.top : null; };
    return { at1k: col(1000), at300: col(300), at60: col(60), h: r.height };
  })()`);
  check(dip.at1k != null && dip.at300 != null && dip.at1k - dip.at60 > dip.h * 0.25 && dip.at300 - dip.at60 < dip.h * 0.1, `the graph's curve dips 18 dB at 1 kHz (accent pixels at y ${S(dip)})`);
  // Essential Sound
  await showTab('essential');
  await sleep(150);
  check(await js(`document.querySelector('.cut-es-sel').textContent === 'Selected audio clips: 1'`), 'Essential Sound sees the selected clip');
  const s0 = await steps();
  await clickAt(await rect('.cut-es-action.clarity'));
  const fx = await js(`__mx.seq().clips.find((c) => c.id === ${S(clip)}).effects.map((e) => e.type)`);
  check(S(fx) === S(['audio.eq', 'audio.eq', 'audio.compressor']) && (await steps()) === s0 + 1, `Clarity adds an equalizer and a compressor in one step (${S(fx)})`);
  await clickAt(await rect('.cut-es-role[data-role="dialogue"]'));
  check(await js(`__mx.seq().clips.find((c) => c.id === ${S(clip)}).role === 'dialogue' && document.querySelector('.cut-es-role[data-role="dialogue"]').getAttribute('aria-pressed') === 'true'`), 'Dialogue marks the clip as dialogue');
  await press('Ctrl+z');
  await press('Ctrl+z');
  await sleep(150);
  check(await js(`__mx.seq().clips.find((c) => c.id === ${S(clip)}).effects.length === 1 && !__mx.seq().clips.find((c) => c.id === ${S(clip)}).role`), 'two Ctrl+Z take both back');
});

// ---------- an exported EQ cut ----------
await section('export', async () => {
  const r = await js(`(async () => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const make = async (eq) => {
      const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1] } }));
      const list = await Cut.media.importFiles([${S(twoWav)}]);
      const [m] = h.do(C.importMedia(list)).ids;
      const s = h.project.sequences[0].id;
      const [clip] = h.do(C.place(s, { source: { media: m }, in: 0, out: 10 * T, at: 0, video: null, audio: 'A1', mode: 'overwrite' })).ids;
      if (eq) h.do(C.addEffect(s, clip, 'audio.eq', null, { b2Freq: 1000, b2Gain: -18, b2Q: 2 }));
      const out = ${S(P('eq'))} + (eq ? '-cut' : '-flat') + '.m4a';
      const r = await Cut.export.run({ project: h.project, seqId: s, path: out, preset: 'audio-m4a', overrides: { loudness: null } });
      if (!r.ok) return { error: r.code + ': ' + r.error };
      const pcm = await __mx.decode(r.path);
      return { at1k: __mx.amp(pcm, 1000, 2, 8), at300: __mx.amp(pcm, 300, 2, 8) };
    };
    return { flat: await make(false), cut: await make(true) };
  })()`);
  check(!r.flat.error && !r.cut.error, `both exports finish (${S(r)})`);
  if (!r.flat.error && !r.cut.error) {
    check(Math.abs(r.flat.at1k + 20) < 0.5 && Math.abs(r.flat.at300 + 20) < 0.5, `without the EQ the M4A has both tones at -20 dBFS (${r.flat.at1k.toFixed(2)}, ${r.flat.at300.toFixed(2)})`);
    const d1k = r.flat.at1k - r.cut.at1k;
    const d300 = r.flat.at300 - r.cut.at300;
    const theory300 = await js(`Cut.audiofx.response('eq', Cut.effects.resolve('audio.eq', { b2Freq: 1000, b2Gain: -18, b2Q: 2 }), [300])[0]`);
    check(Math.abs(d1k - 18) < 1, `the EQ's -18 dB cut at 1 kHz measures ${d1k.toFixed(2)} dB lower at 1 kHz in the exported file`);
    check(Math.abs(d300 + theory300) < 0.5, `and ${d300.toFixed(2)} dB at 300 Hz (the curve says ${(-theory300).toFixed(2)} dB)`);
  }
});

// ---------- the preview and the export: the same samples ----------
await section('same', async () => {
  const r = await js(`(async () => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const h = C.createHistory(Cut.model.createProject({ sequence: { fps: [30, 1] } }));
    const list = await Cut.media.importFiles([${S(twoWav)}]);
    const [m] = h.do(C.importMedia(list)).ids;
    const s = h.project.sequences[0].id;
    const [clip] = h.do(C.place(s, { source: { media: m }, in: 0.5 * T, out: 9 * T, at: 0.25 * T, video: null, audio: 'A1', mode: 'overwrite' })).ids;
    h.do(C.addEffect(s, clip, 'audio.eq', null, { hpOn: true, hpFreq: 120, b2Gain: -9, b2Q: 1.5 }));
    h.do(C.addEffect(s, clip, 'audio.compressor', null, { threshold: -30, ratio: 4, makeup: 6 }));
    h.do(C.addEffect(s, clip, 'audio.limiter', null, { ceiling: -6, truePeak: true }));
    h.do(C.setKeyframes(s, clip, 'effects.e1.b2Gain', [{ t: 0, v: -9, ease: 'linear' }, { t: 4 * T, v: 3, ease: 'linear' }]));
    // the preview: an engine like the program monitor's, every block it schedules kept
    const app = Cut.state.createApp();
    app.setHistory(h);
    const heard = new Map();
    let missing = 0;
    const eng = Cut.audioengine.create(app, { onBlock: (at, out, miss) => { if (miss) missing++; heard.set(at, [out[0].slice(), out[1].slice()]); } });
    await eng.start(1.5 * T);
    await new Promise((res) => setTimeout(res, 2500));
    eng.stop();
    await eng.close();
    // the export: every block the export's mixer gives, kept
    const exported = new Map();
    const orig = Cut.audioengine.createMixer;
    Cut.audioengine.createMixer = (o) => {
      const mixer = orig(o);
      const ml = mixer.mixLoaded;
      mixer.mixLoaded = async (p, q, s0, n, opts) => { const res = await ml(p, q, s0, n, opts); exported.set(s0, [res.out[0].slice(), res.out[1].slice()]); return res; };
      return mixer;
    };
    let ex;
    try { ex = await Cut.export.run({ project: h.project, seqId: s, path: ${S(P('same.m4a'))}, preset: 'audio-m4a', overrides: { loudness: null } }); } finally { Cut.audioengine.createMixer = orig; }
    const full = new Float32Array(48000 * 10);
    const fullR = new Float32Array(48000 * 10);
    for (const [s0, [l, rr]] of exported) { full.set(l.subarray(0, Math.max(0, full.length - s0)), s0); fullR.set(rr.subarray(0, Math.max(0, fullR.length - s0)), s0); }
    let n = 0, worst = 0, energy = 0;
    for (const [at, [l, rr]] of heard) for (let i = 0; i < l.length; i++) {
      if (at + i >= full.length) break;
      worst = Math.max(worst, Math.abs(l[i] - full[at + i]), Math.abs(rr[i] - fullR[at + i]));
      energy += l[i] * l[i];
      n++;
    }
    return { ok: ex.ok, error: ex.error, blocks: heard.size, samples: n, missing, worst, rms: Math.sqrt(energy / Math.max(1, n)), first: Math.min(...heard.keys()) / 48000 };
  })()`);
  check(r.ok, `the export of the clip with effects finishes (${r.error || ''})`);
  check(r.blocks > 30 && r.samples > 48000 * 2 && r.missing === 0 && r.rms > 0.01, `the preview played ${(r.samples / 48000).toFixed(2)} s from ${r.first.toFixed(2)} s in ${r.blocks} blocks, none missing (RMS ${r.rms.toFixed(3)})`);
  check(r.worst === 0, `the preview and the export give the same samples for the clip with an EQ (keyframed), a compressor and a limiter (largest difference ${r.worst})`);
});

// ---------- screenshots ----------
await section('shots', async () => {
  const clip = await js(`__mx.fresh(${S(toneWav)})`);
  await js(`(() => { const C = Cut.commands, s = __mx.seq().id; Cut.app.history.do(C.setTrack(s, 'A1', { volume: -4.5, pan: -35 })); Cut.app.history.do(C.setTrack(s, 'A2', { mute: true })); Cut.app.history.do(C.addEffect(s, ${S(clip)}, 'audio.eq', null, { hpOn: true, b1Gain: 4, b2Gain: -8, b3Gain: 3, hsGain: -3 })); return true; })()`);
  await workspace('audio');
  await showTab('mixer');
  await js(`(Cut.app.setTime(Cut.time.TICKS), true)`);
  await clickAt(await rect('.cut-panel[data-panel="program"]'));
  await space();
  await sleep(1200);
  log(`  saved ${await ctx.shot('mixer-dark.png')}`);
  await space();
  await showTab('controls');
  await sleep(200);
  await js(`(document.querySelector('.cut-ec-graph').closest('.cut-ec-sec').scrollIntoView({ block: 'start' }), true)`);
  await sleep(200);
  log(`  saved ${await ctx.shot('controls-eq-dark.png')}`);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000).catch(() => {});
  await sleep(400);
  log(`  saved ${await ctx.shot('controls-eq-light.png')}`);
  await showTab('mixer');
  await space();
  await sleep(1200);
  log(`  saved ${await ctx.shot('mixer-light.png')}`);
  await space();
  await showTab('essential');
  await sleep(200);
  log(`  saved ${await ctx.shot('essential-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

ctx.finish();
