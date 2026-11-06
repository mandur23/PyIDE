// Nano Studio Cut's automation (ui-auto.js, analyze.js) in the real app, each feature reached the way a person does:
// the top bar's Automation menu, the timeline's clip menu and the color panel's Auto button, clicked with real mouse
// events; the dialogs answered with their buttons. Every result is checked in the project and undone with Ctrl+Z.
// Checks:
// - Remove Silence: a tone with gaps (testsrc) ripple-deleted with its linked video, a locked music track untouched,
//   the preview overlay on the timeline and its summary following the settings, one undo step;
// - Audio Role from the clip menu, Auto Ducking: volume keyframes on the music where the dialogue speaks;
// - Match Loudness (master gain) and Match Clip Loudness (clip volumes) measured again after;
// - Detect Beats on a click track: beat markers on the clicks, every bar on the accents, a clip drag snapping to them;
// - Detect Scene Changes on hard cuts: markers, then splits from the clip menu; waiting while the player plays; Cancel;
// - Auto Color on a warm picture: color.basic set and the rendered frame neutral;
// - a 10-minute file: the silence analysis time and the renderer's memory while it runs.
// Usage: node verify/cut-auto.mjs   (CUT_AUTO_ONLY=silence,duck,loudness,beats,scenes,color,long)
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir, clickMenuPath, processSnapshot, descendants } from './lib.mjs';

const ONLY = (process.env.CUT_AUTO_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-auto-home');
const ctx = await launch({ fixture: 'core', port: 9757, name: 'cut-auto', mode: 'cut', env: { PYIDE_CUT_HOME: home } });
const { js, until, check, cdp, press, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const F = T / 30;
const P = (name) => path.join(home, name);

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['analyze', 'testsrc', 'decoder', 'audioengine', 'media', 'commands'].every((m) => !!Cut[m]) && !!Cut.ui.auto?.removeSilence && !!document.querySelector('.cut-topbar .cut-auto-btn')`),
  'the analysis module and the automation UI are loaded, with the Automation button in the top bar');

// ---------- page helpers ----------
await js(`(() => {
  const C = Cut.commands;
  const T = Cut.time.TICKS;
  const H = (window.__au = {});
  H.seq = () => Cut.app.sequence;
  H.made = {};
  H.src = async (file, opts) => { const r = await Cut.testsrc.write(file, opts); if (!r.ok) throw new Error('testsrc ' + JSON.stringify(r.error)); return true; };
  // A fresh project with the files imported and clips placed: [{file, at, len, in, video, audio, track}] (seconds).
  H.fresh = async (files, clips) => {
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 1280, h: 720 } });
    const h = C.createHistory(p);
    const list = await Cut.media.importFiles(files);
    const bad = list.filter((m) => m.error);
    if (bad.length) throw new Error(JSON.stringify(bad));
    const ids = h.do(C.importMedia(list)).ids;
    const seq = h.project.sequences[0];
    for (const c of clips) {
      const m = h.project.media.find((x) => x.id === ids[c.file]);
      const vid = m.kind === 'video';
      h.do(C.place(seq.id, { source: { media: ids[c.file] }, in: (c.in || 0) * T, out: ((c.in || 0) + c.len) * T, at: c.at * T,
        video: vid ? (c.video ?? 'V1') : null, audio: m.audio ? (c.audio === undefined ? 'A1' : c.audio) : null, mode: 'overwrite' }));
    }
    for (const id of ['A2']) if (clips.some((c) => c.lock === id)) h.do(C.setTrack(seq.id, id, { locked: true }));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
    Cut.app.select([]);
    Cut.app.setTime(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    Cut.ui.timeline.setZoom(Math.max(10, (Cut.ui.timeline.root.querySelector('.cut-tl-scroll').clientWidth - 40) / (Cut.model.sequenceDuration(Cut.app.sequence) / T)), { t: 0, x: 0 });
    Cut.ui.timeline.setScroll(0, 0);
    return ids;
  };
  H.clips = (track) => H.seq().clips.filter((c) => !track || c.track === track).map((c) => ({ id: c.id, track: c.track, start: c.start / T, end: Cut.model.clipEnd(c) / T, in: c.in / T, out: c.out / T, role: c.role }))
    .sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
  H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
  H.last = () => Cut.app.history.list().filter((x) => x.done).at(-1)?.label;
  H.json = () => Cut.app.history.serialize();
  H.pt = (t, track, dy = 0.5) => { const p = Cut.ui.timeline.clientPoint(t * T, track, dy); return { x: p.x, y: Math.round(p.y) }; };
  H.rect = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
  H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; };
  H.measure = async (from, to) => { const s = H.seq(); return Cut.audioengine.measure(Cut.app.project, s.id, from * T, to * T); };
  H.measureClip = async (id) => {
    const s = H.seq();
    const c = s.clips.find((x) => x.id === id);
    const seq = { ...s, masterGain: 0, clips: [c], transitions: [] };
    return Cut.audioengine.measure({ ...Cut.app.project, sequences: [seq] }, s.id, c.start, Cut.model.clipEnd(c));
  };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { button = 'left', modifiers = 0 } = {}) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers });
  await mouse('mousePressed', p.x, p.y, { button, buttons: button === 'right' ? 2 : 1, modifiers });
  await mouse('mouseReleased', p.x, p.y, { button, buttons: 0, modifiers });
  await sleep(120);
}
async function drag(a, b, steps = 12) {
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps); await sleep(18); }
  await sleep(60);
  await mouse('mouseReleased', b.x, b.y);
  await sleep(150);
}
const tr = (s) => js(`tr(${S(s)})`);
// The top bar's Automation menu, then one of its items.
async function automation(label) {
  await clickAt(await js(`__au.rect('.cut-topbar .cut-auto-btn')`));
  await clickMenuPath(ctx, [await tr(label)]);
  await sleep(150);
}
// The clip menu of the clip under (t, track), then a path in it.
async function clipMenu(t, track, labels) {
  await clickAt(await js(`__au.pt(${t}, ${S(track)})`), { button: 'right' });
  const path2 = [];
  for (const l of labels) path2.push(await tr(l));
  await clickMenuPath(ctx, path2);
  await sleep(150);
}
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__au.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 10000);
  await clickAt(await js(`__au.button('#${id}', ${S(name)})`));
}
const idle = (ms = 60000) => until('!Cut.ui.auto.running && !document.querySelector(".cut-auto-task")', 'the analysis to end', ms);
const clips = (track) => js(`__au.clips(${track ? S(track) : ''})`);
const near = (a, b, eps) => Math.abs(a - b) <= eps;
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await js(`ide.ui.closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()); Cut.ui.auto.cancel(); true`).catch(() => {});
  await sleep(200);
}
// 16-bit stereo WAV bytes of fn(t) -> sample (-1..1), written by the test.
function wav(file, seconds, fn, rate = 48000) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(fn(i / rate, i) * 32767)));
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  writeFileSync(file, buf);
  return file;
}
const sine = (hz, amp) => (t) => amp * Math.sin(2 * Math.PI * hz * t);
const dbAmp = (db) => 10 ** (db / 20) * Math.SQRT2; // a sine of this amplitude has an RMS of db dBFS

await js(`Cut.ui.setWorkspace('editing')`);
await sleep(400);

// The dialogue: 10 s of testsrc video with a 1 kHz tone, silent in three gaps (one shorter than the minimum).
const GAPS = [[2, 3], [5, 5.3], [7, 8.2]];
const talk = P('talk.mp4');
await js(`__au.src(${S(talk)}, { seconds: 10, fps: [30, 1], w: 320, h: 180, beepEvery: 0, tone: 1000, toneLevel: 0.3, toneGaps: ${S(GAPS)}, keyEvery: 1 })`);
const music = wav(P('music.wav'), 12, sine(440, dbAmp(-20)));

// ---------- remove silence ----------
await section('silence', async () => {
  await js(`__au.fresh([${S(talk)}, ${S(music)}], [{ file: 0, at: 0, len: 10 }, { file: 1, at: 0, len: 12, audio: 'A2', lock: 'A2' }])`);
  const before = await js('__au.json()');
  const steps0 = await js('__au.steps()');
  await automation('Remove Silence…');
  await until(`!!document.querySelector('#cutAutoSilence')`, 'the Remove Silence dialog', 30000);
  const preview = await js(`({ cuts: Number(document.querySelector('#cutAutoSilence .cut-auto-summary').dataset.cuts), ranges: (Cut.ui.timeline.overlay?.ranges || []).map(([a, b]) => [a / ${T}, b / ${T}]) })`);
  const want2 = [[2.1, 2.9], [7.1, 8.1]];
  check(preview.cuts === 2 && preview.ranges.length === 2 && preview.ranges.every((r, i) => near(r[0], want2[i][0], F / T + 1e-6) && near(r[1], want2[i][1], F / T + 1e-6)),
    `the preview shows two cuts on the timeline before anything changes (${S(preview.ranges.map((r) => r.map((x) => x.toFixed(3))))})`);
  check((await js('__au.json()')) === before, 'the preview changes nothing');
  // the minimum length typed: 0.2 s lets the 0.3 s gap go too
  await clickAt(await js(`__au.rect('#cutAutoSilence .cut-auto-min')`));
  await press('Ctrl+a');
  await ctx.type('0.2');
  await press('Tab');
  await sleep(150);
  const three = await js(`[Number(document.querySelector('#cutAutoSilence .cut-auto-summary').dataset.cuts), Cut.ui.timeline.overlay?.ranges.length]`);
  check(S(three) === S([3, 3]), `a shorter minimum length adds the 0.3 s gap to the preview (${S(three)})`);
  await clickAt(await js(`__au.rect('#cutAutoSilence .cut-auto-min')`));
  await press('Ctrl+a');
  await ctx.type('0.5');
  await press('Tab');
  await sleep(150);
  await dialogButton('cutAutoSilence', 'Remove');
  await sleep(300);
  const v1 = await clips('V1');
  const a1 = await clips('A1');
  const wantV = [[0, 2.1, 0], [2.1, 6.3, 2.9], [6.3, 8.2, 8.1]];
  const ok = (list) => list.length === 3 && list.every((c, i) => near(c.start, wantV[i][0], 0.034) && near(c.end, wantV[i][1], 0.034) && near(c.in, wantV[i][2], 0.034));
  check(ok(v1) && ok(a1), `the silences are ripple-deleted from the dialogue and its linked video (${v1.map((c) => `${c.start.toFixed(3)}-${c.end.toFixed(3)}[${c.in.toFixed(3)}]`).join(' ')})`);
  check(S(await clips('A2')) === S(JSON.parse(before).sequences[0].clips.filter((c) => c.track === 'A2').map((c) => ({ id: c.id, track: 'A2', start: c.start / T, end: (c.start + c.out - c.in) / T, in: c.in / T, out: c.out / T, role: null }))),
    'the locked music track keeps its clip');
  check((await js('__au.steps()')) === steps0 + 1 && (await js('__au.last()')) === 'Remove Silence' && (await js('Cut.ui.timeline.overlay')) === null, 'one undo step named Remove Silence, and the overlay is gone');
  await press('Ctrl+z');
  await sleep(150);
  check((await js('__au.json()')) === before, 'Ctrl+Z gives back the project as it was');
});

// ---------- roles and ducking ----------
await section('duck', async () => {
  await js(`__au.fresh([${S(talk)}, ${S(music)}], [{ file: 0, at: 0, len: 10 }, { file: 1, at: 0, len: 12, audio: 'A2' }])`);
  await clipMenu(4, 'A1', ['Audio Role', 'Dialogue']);
  await clipMenu(4, 'A2', ['Audio Role', 'Music']);
  const roles = (await clips()).map((c) => `${c.track}:${c.role}`).join(' ');
  check(roles === 'A1:dialogue A2:music V1:dialogue', `the clip menu sets the roles, the linked video with the dialogue (${roles})`);
  const before = await js('__au.json()');
  const steps0 = await js('__au.steps()');
  await automation('Auto Ducking…');
  await dialogButton('cutAutoDuck', 'Duck');
  await idle();
  await sleep(200);
  const duckOf = `(() => { const c = __au.seq().clips.find((x) => x.track === 'A2'); const list = c.keyframes.duck || []; const at = (s) => Cut.keyframes.valueAt(list, s * ${T}, 0);
    return { n: list.length, speech: at(1), shortGap: at(5.15), gap: at(7.6), ramp: at(7.15), after: at(11), volume: c.keyframes.volume || null, json: JSON.stringify(list) }; })()`;
  const k = await js(duckOf);
  check(k.n > 4 && k.speech === -12 && k.shortGap === -12 && k.gap === 0 && k.ramp < -2 && k.ramp > -10 && k.after === 0 && k.volume === null,
    `the music is 12 dB down while the dialogue speaks (and through the short pause), back up in the long gap and after; its volume keyframes are untouched (${S({ ...k, json: undefined })})`);
  check((await js('__au.steps()')) === steps0 + 1 && (await js('__au.last()')) === 'Auto Ducking', 'ducking is one undo step');
  await automation('Auto Ducking…');
  await dialogButton('cutAutoDuck', 'Duck');
  await idle();
  await sleep(200);
  const again = await js(duckOf);
  check(again.json === k.json && again.speech === -12, `ducking again replaces the dips instead of lowering the music twice (${again.speech} dB)`);
  await press('Ctrl+z');
  await sleep(150);
  await press('Ctrl+z');
  await sleep(150);
  check((await js('__au.json()')) === before, 'Ctrl+Z takes the keyframes back');
});

// ---------- loudness ----------
await section('loudness', async () => {
  const quiet = wav(P('quiet.wav'), 8, sine(1000, dbAmp(-30)));
  await js(`__au.fresh([${S(music)}, ${S(quiet)}], [{ file: 0, at: 0, len: 8 }, { file: 1, at: 8, len: 8 }])`);
  await automation('Match Loudness…');
  await until(`!!document.querySelector('#cutAutoLoudness .cut-auto-loudness-status')?.dataset.lufs`, 'the measured loudness', 30000);
  const m0 = Number(await js(`document.querySelector('#cutAutoLoudness .cut-auto-loudness-status').dataset.lufs`));
  const shown = Number(await js(`document.querySelector('#cutAutoLoudness .cut-auto-loudness-gain').dataset.gain`));
  await dialogButton('cutAutoLoudness', 'Apply');
  await sleep(200);
  const gain = await js('__au.seq().masterGain');
  const m1 = await js(`__au.measure(0, 16)`);
  check(near(gain, shown, 0.01) && near(gain, -14 - m0, 0.05) && near(m1.integrated, -14, 0.3) && m1.truePeak < -1,
    `Match Loudness sets the master gain ${gain} dB: ${m0.toFixed(2)} LUFS measured, ${m1.integrated.toFixed(2)} LUFS after, true peak ${m1.truePeak.toFixed(2)} dBTP`);
  check((await js('__au.last()')) === 'Match Loudness', 'one undo step named Match Loudness');
  await press('Ctrl+z');
  await sleep(150);
  check((await js('__au.seq().masterGain')) === 0, 'Ctrl+Z puts the master gain back to 0 dB');
  // the broadcast target, chosen in the dialog's list
  await automation('Match Loudness…');
  await until(`!!document.querySelector('#cutAutoLoudness .cut-auto-loudness-status')?.dataset.lufs`, 'the measured loudness again', 30000);
  // the list has the keyboard when the dialog opens: two steps down is -24 LUFS
  await press('ArrowDown');
  await press('ArrowDown');
  check((await js(`document.querySelector('#cutAutoLoudness .cut-auto-loudness-target').value`)) === '-24', 'the target list is chosen with the keyboard');
  await dialogButton('cutAutoLoudness', 'Apply');
  await sleep(200);
  const m2 = await js(`__au.measure(0, 16)`);
  check(near(m2.integrated, -24, 0.3), `the -24 LUFS target gives ${m2.integrated.toFixed(2)} LUFS`);
  await press('Ctrl+z');

  // clip loudness: both clips selected with the mouse, each brought to -14 LUFS
  await clickAt(await js(`__au.pt(4, 'A1')`));
  await clickAt(await js(`__au.pt(12, 'A1')`), { modifiers: 8 });
  check((await js('Cut.app.selection.size')) === 2, 'two clips selected with a click and a Shift-click');
  await automation('Match Clip Loudness…');
  await dialogButton('cutAutoClipLoudness', 'Match');
  await idle();
  await sleep(200);
  const ids = await js(`__au.seq().clips.sort((a, b) => a.start - b.start).map((c) => c.id)`);
  const vols = await js(`__au.seq().clips.sort((a, b) => a.start - b.start).map((c) => c.props.volume)`);
  const l0 = await js(`__au.measureClip(${S(ids[0])})`);
  const l1 = await js(`__au.measureClip(${S(ids[1])})`);
  check(near(l0.integrated, -14, 0.3) && near(l1.integrated, -14, 0.3) && near(vols[1] - vols[0], 10, 1),
    `each clip's volume brings it to -14 LUFS (${vols.join(' and ')} dB; ${l0.integrated.toFixed(2)} and ${l1.integrated.toFixed(2)} LUFS)`);
  check((await js('__au.last()')) === 'Match Clip Loudness', 'one undo step named Match Clip Loudness');
  await press('Ctrl+z');
  await sleep(150);
  check(S(await js(`__au.seq().clips.map((c) => c.props.volume)`)) === S([0, 0]), 'Ctrl+Z gives the clips their volume back');
});

// ---------- beats ----------
await section('beats', async () => {
  // 20 s of clicks at 120 BPM from 0.2 s, every fourth one louder
  const clicks = [];
  for (let k = 0; 0.2 + k * 0.5 < 19.9; k++) clicks.push(0.2 + k * 0.5);
  const track = wav(P('clicks.wav'), 20, (t) => {
    const k = Math.floor((t - 0.2) / 0.5);
    const d = t - (0.2 + k * 0.5);
    if (k < 0 || d > 0.03) return 0;
    return (k % 4 === 0 ? 0.9 : 0.35) * Math.exp(-d / 0.006) * Math.sin(2 * Math.PI * 2000 * d);
  });
  const vid = P('short.mp4');
  await js(`__au.src(${S(vid)}, { seconds: 2, fps: [30, 1], w: 160, h: 90, beepEvery: 0, audio: false })`);
  await js(`__au.fresh([${S(track)}, ${S(vid)}], [{ file: 0, at: 0, len: 20 }, { file: 1, at: 13, len: 2, video: 'V2' }])`);
  await clickAt(await js(`__au.pt(6, 'A1')`));
  await automation('Detect Beats…');
  await dialogButton('cutAutoBeats', 'Detect');
  await idle();
  await sleep(200);
  const marks = await js(`__au.seq().markers.map((m) => ({ t: m.t / ${T}, kind: m.kind, name: m.name }))`);
  const onClicks = clicks.filter((c) => marks.some((m) => Math.abs(m.t - c) <= 1 / 30 + 1e-6)).length;
  check(marks.length >= clicks.length - 1 && marks.length <= clicks.length + 1 && onClicks >= clicks.length - 1 && marks.every((m) => m.kind === 'beat'),
    `a beat marker on every click, within a frame (${marks.length} markers, ${onClicks}/${clicks.length} clicks)`);
  check((await js('__au.last()')) === 'Add Beat Markers', 'one undo step named Add Beat Markers');

  // snapping: the V2 clip dragged so its start passes near a beat lands on it
  await js(`(Cut.app.setTime(19.5 * ${T}), Cut.ui.setSnapping(Cut.app, true), true)`);
  const startT = 13;
  const a = await js(`__au.pt(${startT + 1}, 'V2')`);
  const b = await js(`__au.pt(${startT + 1 - 5.38}, 'V2')`);
  await drag(a, b);
  const moved = (await clips('V2'))[0];
  const snappedTo = marks.find((m) => Math.abs(m.t - moved.start) < 1e-6);
  check(!!snappedTo && Math.abs(moved.start - (startT - 5.38)) < 0.3, `a dragged clip snaps to a beat marker (start ${moved.start.toFixed(3)} s)`);
  await press('Ctrl+z');
  await press('Ctrl+z');
  await sleep(150);
  check((await js('__au.seq().markers.length')) === 0, 'Ctrl+Z takes the move and the markers back');

  // every bar: on the accented clicks
  await clickAt(await js(`__au.pt(6, 'A1')`));
  await automation('Detect Beats…');
  await until(`!!document.querySelector('#cutAutoBeats .cut-auto-beats-every')`, 'the Detect Beats dialog', 5000);
  await press('ArrowDown');
  check((await js(`document.querySelector('#cutAutoBeats .cut-auto-beats-every').value`)) === 'bar', 'Every bar chosen in the list with the keyboard');
  await dialogButton('cutAutoBeats', 'Detect');
  await idle();
  await sleep(200);
  const bars = await js(`__au.seq().markers.map((m) => ({ t: m.t / ${T}, name: m.name }))`);
  const accents = clicks.filter((_, k) => k % 4 === 0);
  const onAccent = bars.filter((m) => accents.some((c) => Math.abs(m.t - c) <= 1 / 30 + 1e-6)).length;
  check(bars.length >= accents.length - 1 && onAccent >= bars.length - 1 && bars[0]?.name === '1', `every bar: ${bars.length} markers, ${onAccent} on the accents, numbered from 1`);
  await press('Ctrl+z');
});

// ---------- scenes ----------
await section('scenes', async () => {
  const cuts = P('cuts.mp4');
  await js(`__au.src(${S(cuts)}, { seconds: 6, fps: [30, 1], w: 320, h: 180, beepEvery: 0, scenes: [2, 4], keyEvery: 1, tone: 440 })`);
  await js(`__au.fresh([${S(cuts)}], [{ file: 0, at: 1, len: 6 }])`);
  const before = await js('__au.json()');
  await clickAt(await js(`__au.pt(3, 'V1')`));
  await automation('Detect Scene Changes…');
  await dialogButton('cutAutoScenes', 'Detect');
  await idle();
  await sleep(200);
  const marks = await js(`__au.seq().markers.map((m) => m.t / ${T})`);
  check(S(marks.map((x) => x.toFixed(3))) === S(['3.000', '5.000']), `markers at the two hard cuts, on their first frames (${S(marks)})`);
  check((await js('__au.last()')) === 'Add Scene Markers', 'one undo step named Add Scene Markers');
  await press('Ctrl+z');
  await sleep(150);
  check((await js('__au.json()')) === before, 'Ctrl+Z removes them');

  // splitting, from the clip menu's Automation submenu
  await clipMenu(3, 'V1', ['Automation', 'Detect Scene Changes…']);
  await until(`!!document.querySelector('#cutAutoScenes .cut-auto-scene-action')`, 'the Detect Scene Changes dialog', 5000);
  await press('ArrowDown');
  check((await js(`document.querySelector('#cutAutoScenes .cut-auto-scene-action').value`)) === 'split', 'Split chosen in the list with the keyboard');
  await dialogButton('cutAutoScenes', 'Detect');
  await idle();
  await sleep(200);
  const v = (await clips('V1')).map((c) => `${c.start.toFixed(3)}-${c.end.toFixed(3)}`).join(' ');
  const au = (await clips('A1')).map((c) => `${c.start.toFixed(3)}-${c.end.toFixed(3)}`).join(' ');
  check(v === '1.000-3.000 3.000-5.000 5.000-7.000' && au === v, `the clip and its linked audio are split at the cuts (${v} / ${au})`);
  check((await js('__au.last()')) === 'Split at Scene Changes', 'one undo step named Split at Scene Changes');
  await press('Ctrl+z');
  await sleep(150);
  check((await js('__au.json()')) === before, 'Ctrl+Z joins them again');

  // a longer clip: the analysis waits while the player plays, and Cancel stops it
  const long = P('long.mp4');
  await js(`__au.src(${S(long)}, { seconds: 45, fps: [30, 1], w: 320, h: 180, beepEvery: 0, scenes: [15, 30], keyEvery: 2, audio: false })`);
  await js(`__au.fresh([${S(long)}], [{ file: 0, at: 0, len: 45 }])`);
  await automation('Detect Scene Changes…');
  await until(`!!document.querySelector('#cutAutoScenes .cut-auto-scene-action')`, 'the Detect Scene Changes dialog', 5000);
  await press('ArrowUp');
  await dialogButton('cutAutoScenes', 'Detect');
  await until(`Number(document.querySelector('.cut-auto-task')?.dataset.progress) > 0.05`, 'the detection under way', 20000);
  await js('(Cut.ui.monitors.program.player.play(), true)');
  await until(`document.querySelector('.cut-auto-task')?.dataset.paused === 'true'`, 'the analysis paused while playing', 5000);
  const p0 = Number(await js(`document.querySelector('.cut-auto-task').dataset.progress`));
  await sleep(800);
  const p1 = Number(await js(`document.querySelector('.cut-auto-task').dataset.progress`));
  check(p0 === p1 && (await js('Cut.app.playing')) === true, `while the player plays the detection waits (${p0} -> ${p1})`);
  await js('(Cut.ui.monitors.program.player.pause(), true)');
  await until(`document.querySelector('.cut-auto-task') && !document.querySelector('.cut-auto-task').dataset.paused`, 'the analysis going on', 5000);
  await clickAt(await js(`__au.rect('.cut-auto-task .cut-auto-task-cancel')`));
  await idle(10000);
  check((await js('__au.seq().markers.length')) === 0 && (await js('__au.steps()')) === 0, 'Cancel stops the detection and changes nothing');
  await automation('Detect Scene Changes…');
  await dialogButton('cutAutoScenes', 'Detect');
  await idle(120000);
  await sleep(200);
  const lm = await js(`__au.seq().markers.map((m) => m.t / ${T})`);
  check(S(lm.map((x) => x.toFixed(3))) === S(['15.000', '30.000']), `run again, it finds both cuts of the 45 s clip (${S(lm)})`);
});

// ---------- auto colour ----------
await section('color', async () => {
  const warm = P('warm.mp4');
  await js(`__au.src(${S(warm)}, { seconds: 2, fps: [30, 1], w: 320, h: 180, beepEvery: 0, background: '#887c6e', audio: false })`);
  await js(`__au.fresh([${S(warm)}], [{ file: 0, at: 0, len: 2 }])`);
  // the average colour of the rendered frame at 1 s
  await js(`(window.__au.avg = async () => {
    const canvas = new OffscreenCanvas(320, 180);
    const comp = await Cut.compositor.create(canvas, { width: 320, height: 180 });
    try {
      await comp.render(Cut.app.project, Cut.app.sequenceId, ${T});
      const px = await comp.readPixels();
      const s = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) { s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2]; }
      return s.map((v) => v / (px.length / 4));
    } finally { await comp.idle(); comp.destroy?.(); }
  }, true)`);
  const a0 = await js('__au.avg()');
  await clickAt(await js(`__au.pt(1, 'V1')`));
  await js(`(Cut.app.setTime(${T}), true)`);
  await clickAt(await js(`__au.rect('.cut-ws-tab[data-ws="color"]')`));
  await sleep(500);
  await until(`!!document.querySelector('.cut-color-auto') && !document.querySelector('.cut-color-auto').disabled`, 'the Auto button', 5000);
  await clickAt(await js(`__au.rect('.cut-color-auto')`));
  await idle(30000);
  await sleep(300);
  const p = await js(`__au.seq().clips[0].effects.find((e) => e.type === 'color.basic')?.params || null`);
  const a1 = await js('__au.avg()');
  const spread = (c) => Math.max(...c) - Math.min(...c);
  check(p && p.temperature < -10 && Number.isFinite(p.tint) && Number.isFinite(p.exposure), `Auto sets color.basic: a warm picture gets cooler (${S(p)})`);
  check(spread(a1) < spread(a0) / 3, `the rendered frame's average becomes neutral (${a0.map((x) => x.toFixed(0)).join(',')} -> ${a1.map((x) => x.toFixed(0)).join(',')})`);
  check((await js('__au.last()')) === 'Auto Color', 'one undo step named Auto Color');
  await press('Ctrl+z');
  await sleep(150);
  check((await js(`__au.seq().clips[0].effects.length`)) === 0, 'Ctrl+Z removes the correction');
  await js(`Cut.ui.setWorkspace('editing')`);
  // the menu reaches it too
  await js(`(Cut.app.select([__au.seq().clips[0].id]), true)`);
  await automation('Auto Color');
  await idle(30000);
  check((await js(`__au.seq().clips[0].effects.filter((e) => e.type === 'color.basic').length`)) === 1, 'Automation > Auto Color does the same');
});

// ---------- a 10-minute file ----------
await section('long', async () => {
  // 10 minutes of a 1 kHz tone with a 1 s gap every 5 s: 115 MB of 16-bit stereo PCM
  const file = wav(P('ten-minutes.wav'), 600, (t) => ((t % 5) >= 4 ? 0 : 0.25 * Math.sin(2 * Math.PI * 1000 * t)));
  await js(`__au.fresh([${S(file)}], [{ file: 0, at: 0, len: 600 }])`);
  const heap = async () => { const r = await cdp('Runtime.getHeapUsage'); return (r.result?.usedSize || 0) + (r.result?.backingStorageSize || 0); };
  const retained = async () => { await cdp('HeapProfiler.collectGarbage'); return heap(); };
  const mb = (x) => (x / 1048576).toFixed(1);
  // the renderer's working set, the largest one among the app's renderer processes (the editor's page)
  const rendererWs = () => Math.max(0, ...descendants(processSnapshot(), ctx.pid).filter((r) => /--type=renderer/.test(r.cmd)).map((r) => r.workingSet));
  // first run: the time, and the working set before and after
  const wsBase = rendererWs();
  const t0 = Date.now();
  await js(`(Cut.ui.auto.removeSilence(Cut.app), true)`);
  await until(`!!document.querySelector('#cutAutoSilence')`, 'the analysis of 10 minutes', 120000);
  const ms = Date.now() - t0;
  const wsAfter = rendererWs();
  const cuts = Number(await js(`document.querySelector('#cutAutoSilence .cut-auto-summary')?.dataset.cuts`));
  await dialogButton('cutAutoSilence', 'Cancel');
  log(`  silence analysis of 10 minutes (115 MB of PCM): ${ms} ms; renderer working set ${mb(wsBase)} MB before, ${mb(wsAfter)} MB after`);
  check(cuts === 120, `120 silences found in the 10-minute file (${cuts})`);
  check(ms < 30000, `the analysis takes ${(ms / 1000).toFixed(1)} s (under 30 s)`);
  // second run (the levels forgotten): what the page keeps while it reads, garbage collected at each sample
  await js('(Cut.ui.auto.forget(), true)');
  const base = await retained();
  let most = base;
  let samples = 0;
  await js(`(Cut.ui.auto.removeSilence(Cut.app), true)`);
  const t1 = Date.now();
  while (!(await js(`!!document.querySelector('#cutAutoSilence')`)) && Date.now() - t1 < 120000) {
    most = Math.max(most, await retained());
    samples++;
    await sleep(150);
  }
  log(`  live memory while reading (${samples} samples after a garbage collection): ${mb(base)} MB before, ${mb(most)} MB at most`);
  check(samples >= 3 && most - base < 24 * 1048576, `the memory the analysis keeps stays flat (+${mb(most - base)} MB over ${samples} samples; the decoded file would be 230 MB)`);
  await dialogButton('cutAutoSilence', 'Cancel');
});

// ---------- screenshots in both themes (verify/out/cut-auto/*.png) ----------
await section('shots', async () => {
  await js(`__au.fresh([${S(talk)}, ${S(music)}], [{ file: 0, at: 0, len: 10 }, { file: 1, at: 0, len: 12, audio: 'A2', lock: 'A2' }])`);
  // beat markers (every half second, a bar every two seconds) to see how the ruler draws them
  await js(`(Cut.app.history.do(Cut.commands.batch('Add Beat Markers', Array.from({ length: 24 }, (_, i) => Cut.commands.addMarker(__au.seq().id, { t: i * ${T} / 2, kind: 'beat', color: 'cyan', name: i % 4 ? '' : String(i / 4 + 1) })))), true)`);
  for (const theme of ['dark', 'light']) {
    await js(`(ide.settings.set('appearance.theme', ${S(theme)}), true)`);
    await until(`document.documentElement.dataset.theme === ${S(theme)} || ${S(theme)} === 'dark'`, `the ${theme} theme`, 5000).catch(() => {});
    await sleep(500);
    await automation('Remove Silence…');
    await until(`!!document.querySelector('#cutAutoSilence')`, 'the Remove Silence dialog', 30000);
    await sleep(300);
    log(`  saved ${await ctx.shot(`silence-${theme}.png`)}`);
    await dialogButton('cutAutoSilence', 'Cancel');
    await clickAt(await js(`__au.rect('.cut-topbar .cut-auto-btn')`));
    await sleep(300);
    log(`  saved ${await ctx.shot(`menu-${theme}.png`)}`);
    await press('Escape');
    await js(`(Cut.ui.setWorkspace('color'), Cut.app.select([__au.seq().clips.find((c) => c.track === 'V1').id]), true)`);
    // a task box held open while the player plays
    await js(`(Cut.ui.auto.task(Cut.app, tr('Detecting scene changes…'), async (c) => { c.progress(0.4); await new Promise((r) => setTimeout(r, 1500)); }), true)`);
    await sleep(500);
    log(`  saved ${await ctx.shot(`color-task-${theme}.png`)}`);
    await idle(5000);
    await js(`(Cut.ui.setWorkspace('editing'), true)`);
  }
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  check(true, 'screenshots saved');
});

ctx.finish();
