// Nano Studio Cut's speech recognition (ui-speech.js, speech.js, main/cut/whisper.js) in the real app with the fake
// backend (PYIDE_WHISPER_BACKEND=fake: one word per burst of sound, so no model is needed), reached the way a person
// does: the Automation menu, the captions panel's button, the Transcript panel, clicked with real mouse events and keys.
// Checks:
// - the setup dialog on first use (sizes, "on this PC"), nothing downloaded until Download is pressed, Cancel leaves
//   everything as it was, the download's progress, then the recognition;
// - Auto Captions on testsrc beeps (40 s, two windows joined at their seam): one caption track, every word once and
//   in order, lines of at most 18 characters, two lines, 6 s, frames, no overlaps; one undo step; again over an In-Out
//   range, replacing only the captions inside it; a second run read from the cache, not recognised again; the
//   dialog's "Highlight each word as it is spoken" (off at first, set on the new track, remembered, showing the state
//   of a track captioned again);
// - a first window whose text stops after 2 s (Whisper under music): the next window starts there, every word kept;
// - the Transcript panel: the words, a click seeks, the word under the playhead lit (also while playing), Shift+click
//   selects, Delete ripple-deletes the words from the video and its linked audio (one undo step), Ctrl+Z, search;
// - Remove Filler Words on a WAV with hesitations and a long pause: the preview overlay and summary, then one ripple
//   delete that takes 음 and 어 and the pause, Ctrl+Z;
// - the words Whisper was unsure of: wavy underlines with the confidence in the Transcript panel, the captions holding
//   them marked with the words under their text, Alt+] and Alt+[ (and the Automation menu) through them, Mark as
//   Checked, an edited caption and a corrected or confirmed transcript word no longer marked (also from the cache), the
//   marks turned off;
// - the word list: in the Auto Captions dialog and Word List…, kept with the project, its own transcript (recognised
//   again, then from the cache), the term heard where the fake was unsure, one undo step;
// - the settings page's Speech Recognition section (large-v3 turbo by default, Download… for small, whose transcript is
//   its own: recognised again, not read from large-v3 turbo's cache); the Window menu; a failed download (offline)
//   explained in Korean;
// - screenshots of the panel and the dialogs in the dark and the light theme (verify/out/cut-whisper/*.png).
// - the chosen model missing with another one on this PC (small, from before large-v3 turbo became the default): the
//   setup dialog offers Use Whisper small, which becomes the setting and recognizes with nothing downloaded;
// Usage: node verify/cut-whisper.mjs   (CUT_WHISPER_ONLY=setup,captions,transcript,uncertain,word list,early stop,fillers,settings,installed,shots,korean)
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir, clickMenuPath } from './lib.mjs';

const ONLY = (process.env.CUT_WHISPER_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-whisper-home');
const env = { PYIDE_CUT_HOME: home, PYIDE_WHISPER_BACKEND: 'fake', PYIDE_WHISPER_FAKE_SETUP: 'ok' };
let ctx = await launch({ fixture: 'core', port: 9768, name: 'cut-whisper', mode: 'cut', env });
const first = ctx;
let { js, until, check, cdp, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const P = (name) => path.join(home, name);
const KO = ['안녕하세요', '음', '오늘은', '자막을', '어', '만들어', '봅니다.', '그', '편집이', '쉬워요.'];

// ---------- page helpers ----------
async function boot() {
  await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
  await js('Cut.loaded');
  await until('window.__cutReady === true', 'the editor started', 30000);
  await js(`(() => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const H = (window.__sp = {});
    H.seq = () => Cut.app.sequence;
    H.src = async (file, opts) => { const r = await Cut.testsrc.write(file, opts); if (!r.ok) throw new Error('testsrc ' + JSON.stringify(r.error)); return true; };
    H.fresh = async (files, clips) => {
      const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
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
          video: vid ? 'V1' : null, audio: m.audio ? 'A1' : null, mode: 'overwrite' }));
      }
      Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
      Cut.app.select([]);
      Cut.app.setTime(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return ids;
    };
    H.clips = (track) => H.seq().clips.filter((c) => !track || c.track === track).map((c) => ({ id: c.id, track: c.track, start: c.start / T, end: Cut.model.clipEnd(c) / T, in: c.in / T, out: c.out / T }))
      .sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
    H.length = (track) => H.clips(track).reduce((n, c) => n + (c.end - c.start), 0);
    H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
    H.last = () => Cut.app.history.list().filter((x) => x.done).at(-1)?.label;
    H.caps = () => (H.seq().captions || []).map((t) => ({ name: t.name, lang: t.lang, items: t.items.map((it) => ({ start: it.start, end: it.end, text: it.text })) }));
    H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
    H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; };
    H.word = (i) => { const n = document.querySelector('.cut-panel[data-panel="transcript"] .cut-tr-word[data-i="' + i + '"]'); if (!n) return null; n.scrollIntoView({ block: 'nearest' }); return H.rect(n); };
    H.words = () => [...document.querySelectorAll('.cut-panel[data-panel="transcript"] .cut-tr-word')].map((n) => ({ text: n.textContent, sel: n.classList.contains('selected'), cur: n.classList.contains('current'), match: n.classList.contains('match') }));
    H.status = () => ide.api.invoke('cut:speechStatus');
    return true;
  })()`);
}
await boot();
check(await js(`['speech', 'analyze', 'testsrc', 'decoder', 'audioengine', 'media', 'commands'].every((m) => !!Cut[m]) && !!Cut.ui.speech?.autoCaptions && Cut.ui.panels.has('transcript')`),
  'the speech modules are loaded and the Transcript panel is registered');

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { button = 'left', modifiers = 0 } = {}) {
  if (!p) throw new Error('nothing to click');
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers });
  await mouse('mousePressed', p.x, p.y, { button, buttons: button === 'right' ? 2 : 1, modifiers });
  await mouse('mouseReleased', p.x, p.y, { button, buttons: 0, modifiers });
  await sleep(120);
}
const KEYS = { Space: [' ', 'Space', 32], Delete: ['Delete', 'Delete', 46], Escape: ['Escape', 'Escape', 27], Enter: ['Enter', 'Enter', 13], ']': [']', 'BracketRight', 221], '[': ['[', 'BracketLeft', 219], End: ['End', 'End', 35] };
async function dblclickAt(p) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  for (const clickCount of [1, 2]) {
    await mouse('mousePressed', p.x, p.y, { clickCount });
    await mouse('mouseReleased', p.x, p.y, { buttons: 0, clickCount });
  }
  await sleep(150);
}
async function key(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
  const [k, code, vk] = KEYS[name] || [name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  const base = { modifiers: mods, key: k, code, windowsVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(80);
}
const tr = (s) => js(`tr(${S(s)})`);
async function automation(label) {
  await clickAt(await js(`__sp.rect('.cut-topbar .cut-auto-btn')`));
  await clickMenuPath(ctx, [await tr(label)]);
  await sleep(150);
}
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__sp.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 10000);
  await clickAt(await js(`__sp.button('#${id}', ${S(name)})`));
}
const idle = (ms = 60000) => until('!Cut.ui.auto.running && !document.querySelector(".cut-auto-task")', 'the recognition to end', ms);
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await js(`ide.ui.closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()); Cut.ui.auto.cancel(); true`).catch(() => {});
  await sleep(200);
}
async function showTranscript() {
  await clickAt(await js(`__sp.rect('.cut-ws-tab[data-ws="captions"]')`));
  await until(`!!document.querySelector('.cut-grid .cut-slot-tab[data-panel="transcript"]')`, 'the Transcript tab in Captions and Graphics');
  await clickAt(await js(`__sp.rect('.cut-grid .cut-slot-tab[data-panel="transcript"]')`));
  await until(`!!__sp.rect('.cut-panel[data-panel="transcript"] .cut-tr-run')?.w`, 'the Transcript panel shown');
}
// 16-bit stereo WAV: bursts of a 440 Hz tone at [from, to] seconds.
function wav(file, seconds, bursts, rate = 48000) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (const [a, b] of bursts) {
    for (let i = Math.round(a * rate); i < Math.min(n, Math.round(b * rate)); i++) {
      const v = Math.round(0.3 * Math.sin((2 * Math.PI * 440 * i) / rate) * 32767);
      buf.writeInt16LE(v, 44 + i * 4);
      buf.writeInt16LE(v, 46 + i * 4);
    }
  }
  writeFileSync(file, buf);
}

// The media: testsrc with a beep every half second (a word each to the fake), and a WAV with hesitations and a pause.
const TALK = P('talk.mp4');
await js(`__sp.src(${S(TALK)}, { seconds: 40, fps: [30, 1], w: 320, h: 180, beepEvery: 0.5, beepLength: 0.3, keyEvery: 1 })`);
const PAUSES = P('pauses.wav');
// words at 0, 0.5 … 3 s (안녕하세요 음 오늘은 자막을 어 만들어 봅니다.), a 2.65 s pause, then 6, 6.5 … 8 s (오늘은 자막을 어 만들어 봅니다.)
const HALVES = [0, 1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16];
wav(PAUSES, 9, HALVES.map((k) => [k * 0.5, k * 0.5 + (KO[k % 10].length > 1 ? 0.35 : 0.15)]));
const expectTalk = Array.from({ length: 80 }, (_, k) => KO[k % 10]);

// ---------- setup ----------
await section('setup', async () => {
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
  const st0 = await js('__sp.status()');
  check(!st0.runtime && st0.models.every((m) => !m.installed) && st0.stats.setups === 0, 'at first the model and the runtime are missing, and nothing was downloaded');
  const steps0 = await js('__sp.steps()');
  await automation('Auto Captions…');
  await until(`!!document.querySelector('#cutSpeechCaptions')`, 'the Auto Captions dialog');
  check(await js(`document.querySelector('#cutSpeechCaptions .cut-dialog-note').textContent.includes('1')`), 'the dialog says how many clips with speech');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`!!document.querySelector('#cutSpeechSetup')`, 'the setup dialog on first use');
  const text = await js(`document.querySelector('#cutSpeechSetup').textContent`);
  check(/this PC/.test(text) && /never sent/.test(text) && /MB|GB/.test(text) && /Nothing is downloaded until you press Download/.test(text), `the setup dialog explains the size and that it all runs on this PC (${text.slice(0, 160)}…)`);
  await sleep(400);
  check((await js('__sp.status()')).stats.setups === 0, 'nothing downloads while the dialog waits');
  check(await js(`!document.querySelector('#cutSpeechSetup .cut-speech-other') && document.querySelectorAll('#cutSpeechSetup .dialog-buttons button').length === 2`), 'with no model on this PC there is no other model to use instead');
  await dialogButton('cutSpeechSetup', 'Cancel');
  await sleep(300);
  check(!(await js(`!!document.querySelector('#cutSpeechSetup')`)) && (await js('__sp.status()')).stats.setups === 0 && (await js('__sp.steps()')) === steps0 && !(await js('__sp.caps().length')),
    'Cancel: no download, no captions, no undo step');
  // again, and Download this time
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`!!document.querySelector('#cutSpeechSetup')`, 'the setup dialog again');
  await dialogButton('cutSpeechSetup', 'Download');
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const p = await js(`document.querySelector('#cutSpeechSetup .cut-speech-bar')?.dataset.progress ?? null`);
    if (p === null && !(await js(`!!document.querySelector('#cutSpeechSetup')`))) break;
    if (p !== null) seen.push(Number(p));
    await sleep(60);
  }
  check(seen.length >= 2 && seen.some((x) => x > 0 && x < 1), `the dialog shows the download's progress (${S([...new Set(seen)])})`);
  const st1 = await js('__sp.status()');
  check(st1.stats.setups === 1 && st1.runtime && st1.models.find((m) => m.id === 'whisper-large-v3-turbo').installed && !st1.models.find((m) => m.id === 'whisper-small').installed,
    'one download after the click: the default model, large-v3 turbo, is ready');
  await until(`__sp.caps().length === 1`, 'the captions after the download', 60000);
  await idle();
  check((await js('__sp.steps()')) === steps0 + 1 && (await js('__sp.last()')) === 'Auto Captions', 'one undo step named Auto Captions');
});

// ---------- auto captions ----------
await section('captions', async () => {
  if (!(await js('__sp.caps().length'))) {
    await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
    await js(`ide.api.invoke('cut:speechSetup', { model: 'whisper-small' })`);
    await automation('Auto Captions…');
    await dialogButton('cutSpeechCaptions', 'Create Captions');
    await until(`__sp.caps().length === 1`, 'the captions', 60000);
    await idle();
  }
  const [track] = await js('__sp.caps()');
  check(track.name === (await tr('Auto Captions')) && track.lang === 'ko', `a caption track "Auto Captions" in Korean (${track.name}, ${track.lang})`);
  const words = track.items.map((it) => it.text.replace(/\n/g, ' ')).join(' ').split(' ');
  check(S(words) === S(expectTalk), `every word once and in order across the two windows (${words.length} of 80; ${S(words.slice(52, 60))})`);
  const lines = track.items.map((it) => it.text.split('\n'));
  check(lines.every((l) => l.length <= 2 && l.every((x) => [...x].length <= 18)), 'at most two lines of 18 characters');
  const F = T / 30;
  check(track.items.every((it, i) => it.start % F === 0 && it.end % F === 0 && it.end > it.start && it.end - it.start <= 6.5 * T && (!i || track.items[i - 1].end <= it.start)), 'on frames, at most about 6 s, never overlapping');
  check(Math.abs(track.items[0].start / T - 0) < 0.04, `the first caption starts with the first word (${track.items[0].start / T})`);
  const untimed = await js(`__sp.seq().captions[0].items.filter((it) => !(Cut.captionwords.valid(it.words, it.text) && it.words[0].t0 <= ${F} && it.words.every((w) => w.t0 % ${F} === 0 && w.t1 > w.t0))).map((it) => ({ text: it.text, words: it.words }))`);
  check(!untimed.length, `each caption keeps every recognised word's time from its start, on frames (the word-by-word highlight) (${S(untimed.slice(0, 2))})`);
  const third = track.items.find((it) => it.text.startsWith('편집이') || it.text.includes('\n편집이'));
  void third;
  // Undo and redo with the keys
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="program"]') || __sp.rect('.cut-stage')`));
  await key('Ctrl+Z');
  check((await js('__sp.caps().length')) === 0, 'Ctrl+Z takes the caption track away in one step');
  await key('Ctrl+Shift+Z');
  check((await js('__sp.caps().length')) === 1, 'and Ctrl+Shift+Z brings it back');
  // the In-Out range: only the captions inside it are replaced; the cache answers (no new recognition)
  const before = await js('__sp.caps()[0].items');
  const windows0 = (await js('__sp.status()')).stats.windows;
  await js(`(Cut.ui.speech.forget(), Cut.app.setInOut({ in: 10 * ${T}, out: 20 * ${T} }), true)`);
  await js(`Cut.app.history.do(Cut.commands.setCaptions(__sp.seq().id, __sp.seq().captions[0].id, __sp.seq().captions[0].items.map((it) => ({ start: it.start, end: it.end, text: it.start >= 10 * ${T} && it.end <= 20 * ${T} ? 'old' : it.text }))))`);
  // from the captions panel's own button this time
  await showTranscript();
  await clickAt(await js(`__sp.rect('.cut-grid .cut-slot-tab[data-panel="captions"]')`));
  await until(`!!__sp.rect('.cut-panel[data-panel="captions"] .cut-cap-auto')?.w`, 'the Auto Captions button in the captions panel');
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="captions"] .cut-cap-auto')`));
  await until(`!!document.querySelector('#cutSpeechCaptions')`, 'the dialog from the captions panel');
  check(await js(`document.querySelector('#cutSpeechCaptions .cut-dialog-note').textContent.startsWith(tr('From In to Out'))`), 'the dialog says it works from In to Out');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.last() === 'Auto Captions' && !__sp.caps()[0].items.some((it) => it.text === 'old')`, 'the range captioned again', 30000);
  await idle();
  const after = await js('__sp.caps()[0].items');
  const outside = (list) => list.filter((it) => it.end <= 10 * T || it.start >= 20 * T);
  check(S(outside(after)) === S(outside(before)), 'the captions outside the range are untouched');
  check(after.filter((it) => it.start >= 10 * T && it.end <= 20 * T).length > 0, 'the range has new captions');
  check((await js('__sp.status()')).stats.windows === windows0, 'the transcript came from the cache: no window recognised again');
  // A model that takes a while to load (whisper-small: about 30 s on a real PC, while the first window waits): the
  // progress box says so instead of standing at 10 %.
  await js(`(ide.settings.set('cut.speech.language', 'en'), ide.api.invoke('cut:speechTestConfig', { unload: true, load: 2500 }))`);
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  const loadingText = await tr('Loading the speech model…');
  let sawLoading = false;
  for (let i = 0; i < 60 && !sawLoading; i++) {
    sawLoading = (await js(`document.querySelector('.cut-auto-task .cut-auto-task-text')?.textContent || ''`)) === loadingText;
    await sleep(50);
  }
  await idle();
  check(sawLoading, 'while the model loads, the progress box says "Loading the speech model…"');
  await js(`(ide.settings.set('cut.speech.language', 'auto'), ide.api.invoke('cut:speechTestConfig', { load: 0 }), Cut.ui.speech.forget(), true)`);
  await js(`(Cut.app.setInOut({ in: null, out: null }), true)`);

  // the word-by-word highlight of the track made: off by default, set from the dialog, remembered
  const hlBox = '#cutSpeechCaptions .cut-speech-highlight';
  const style = () => js(`(({ highlight, highlightColor, highlightMode }) => ({ highlight, highlightColor, highlightMode }))(__sp.seq().captions[0].style)`);
  await js(`(Cut.app.history.do(Cut.commands.removeCaptionTrack(__sp.seq().id, __sp.seq().captions[0].id)), true)`);
  await automation('Auto Captions…');
  await until(`!!document.querySelector('${hlBox}')`, 'the highlight checkbox');
  check(await js(`!document.querySelector('${hlBox}').checked && document.querySelector('${hlBox}').parentElement.textContent === tr('Highlight each word as it is spoken')`),
    'the Auto Captions dialog has "Highlight each word as it is spoken", off at first');
  await clickAt(await js(`__sp.rect('${hlBox}')`));
  check(await js(`document.querySelector('${hlBox}').checked`), 'a click ticks it');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1 && __sp.last() === 'Auto Captions'`, 'captions with the highlight', 30000);
  await idle();
  check(S(await style()) === S({ highlight: true, highlightColor: '#ffd23f', highlightMode: 'color' }) && (await js(`ide.settings.get('cut.speech.highlight', false)`)) === true,
    `the new track lights each word (the highlight's color and style as Caption Style starts them), and the choice is remembered (${S(await style())})`);
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="program"]') || __sp.rect('.cut-stage')`));
  await key('Ctrl+Z');
  check((await js('__sp.caps().length')) === 0, 'Ctrl+Z takes that track away');
  await automation('Auto Captions…');
  await until(`!!document.querySelector('${hlBox}')`, 'the highlight checkbox again');
  check(await js(`document.querySelector('${hlBox}').checked`), 'the next Auto Captions starts with the last choice');
  await clickAt(await js(`__sp.rect('${hlBox}')`));
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1 && __sp.last() === 'Auto Captions'`, 'captions without the highlight', 30000);
  await idle();
  check((await style()).highlight === false && (await js(`ide.settings.get('cut.speech.highlight', true)`)) === false, 'unticked, the new track has no highlight, and that is remembered too');
  // run again over a track that lights its words: the box shows the track, and leaving it ticked keeps it
  await js(`(Cut.app.history.do(Cut.commands.setCaptionTrack(__sp.seq().id, __sp.seq().captions[0].id, { style: { highlight: true } })), true)`);
  await automation('Auto Captions…');
  await until(`!!document.querySelector('${hlBox}')`, 'the highlight checkbox over the existing track');
  check(await js(`document.querySelector('${hlBox}').checked`), 'captioning a track again, the box shows that track\'s highlight');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.last() === 'Auto Captions'`, 'the track captioned again', 30000);
  await idle();
  check((await style()).highlight === true, 'the track captioned again keeps its highlight');
  await js(`(ide.settings.set('cut.speech.highlight', false), true)`);
});

// ---------- the transcript panel ----------
await section('transcript', async () => {
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
  await showTranscript();
  await until(`__sp.words().length === 80`, 'the transcript of the cached recognition', 20000);
  const ws = await js('__sp.words()');
  check(S(ws.map((w) => w.text)) === S(expectTalk), 'the panel shows the 80 words in order');
  check(await js(`document.querySelectorAll('.cut-panel[data-panel="transcript"] .cut-tr-time').length >= 1`), 'with times');
  // click seeks
  await clickAt(await js('__sp.word(6)'));
  const t6 = await js('Cut.app.t / ' + T);
  check(Math.abs(t6 - 3) < 0.03, `a click on a word moves the playhead to it (${t6})`);
  check((await js('__sp.words()'))[6].sel && (await js('__sp.words()'))[6].cur, 'the clicked word is selected and lit');
  // the word under the playhead
  await js(`(Cut.app.setTime(5.1 * ${T}), true)`);
  await sleep(100);
  check((await js('__sp.words()')).findIndex((w) => w.cur) === 10, 'the word under the playhead is lit');
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="program"] canvas') || __sp.rect('.cut-panel[data-panel="program"]')`));
  await key('Space');
  const lit = new Set();
  for (let i = 0; i < 12; i++) { lit.add((await js('__sp.words()')).findIndex((w) => w.cur)); await sleep(150); }
  await key('Space');
  check([...lit].filter((x) => x >= 10).length >= 2, `while playing the light moves on with the words (${S([...lit])})`);
  // select words 2..4 with a click and a Shift+click, then Delete
  await clickAt(await js('__sp.word(2)'));
  await clickAt(await js('__sp.word(4)'), { modifiers: 8 });
  const sel = await js('Cut.ui.transcript.selection');
  check(S(sel) === S([2, 4]), `Shift+click selects a run of words (${S(sel)})`);
  check(!(await js(`document.querySelector('.cut-tr-remove').disabled`)), 'Remove is enabled with a selection');
  const steps0 = await js('__sp.steps()');
  const v0 = await js(`__sp.length('V1')`);
  const a0 = await js(`__sp.length('A1')`);
  await key('Delete');
  await until(`__sp.steps() === ${steps0 + 1}`, 'the delete', 5000);
  const v1 = await js(`__sp.length('V1')`);
  const a1 = await js(`__sp.length('A1')`);
  check(await js('__sp.last()') === 'Delete Words', 'one undo step named Delete Words');
  check(v0 - v1 > 1.2 && v0 - v1 < 1.6 && Math.abs((a0 - a1) - (v0 - v1)) < 0.001, `the words were ripple-deleted from the video and its linked audio alike (${(v0 - v1).toFixed(3)} s)`);
  const wsAfter = (await js('__sp.words()')).map((w) => w.text);
  check(wsAfter.length === 77 && S(wsAfter.slice(0, 4)) === S([KO[0], KO[1], KO[5], KO[6]]), `the deleted words left the transcript (${S(wsAfter.slice(0, 5))})`);
  const clipsNow = await js(`__sp.clips('V1')`);
  check(clipsNow.length === 2 && Math.abs(clipsNow[1].start - clipsNow[0].end) < 1e-6, 'the clip is cut there and the rest pulled up');
  await key('Ctrl+Z');
  check((await js('__sp.words()')).length === 80 && Math.abs((await js(`__sp.length('V1')`)) - v0) < 1e-6, 'Ctrl+Z brings the words and the clip back');
  // the Remove button
  await clickAt(await js('__sp.word(10)'));
  await clickAt(await js(`__sp.rect('.cut-tr-remove')`));
  check((await js('__sp.words()')).length === 79 && (await js('__sp.last()')) === 'Delete Words', 'the Remove button deletes the selected word');
  await key('Ctrl+Z');
  // search
  await clickAt(await js(`__sp.rect('.cut-tr-search')`));
  await ctx.type('자막');
  await sleep(150);
  const found = await js(`({ count: document.querySelector('.cut-tr-count').textContent, match: __sp.words().filter((w) => w.match).length })`);
  check(found.match === 8 && found.count.includes('8'), `search marks every 자막을 (${S(found)})`);
  await key('Enter');
  check(Math.abs((await js('Cut.app.t / ' + T)) - 1.5) < 0.03, 'Enter in the search goes to the first match');
  await key('Enter');
  check(Math.abs((await js('Cut.app.t / ' + T)) - 6.5) < 0.03, 'and again to the next');
});

// ---------- the words Whisper was unsure of ----------
// The fake is unsure of 자막을 (p 0.31) and 편집이 (0.42): 16 of the talk's 80 words, at 1.5 s, 4 s, 6.5 s, 9 s …
const UNSURE = expectTalk.map((w, k) => (k % 10 === 3 || k % 10 === 8 ? k : -1)).filter((k) => k >= 0);
const capDoubts = () => js(`(__sp.seq().captions[0]?.items || []).map((it) => ({ id: it.id, start: it.start, text: it.text, doubt: it.doubt || null }))`);
const rowsUnsure = () => js(`[...document.querySelectorAll('.cut-panel[data-panel="captions"] .cut-cap-row')].map((r) => r.classList.contains('uncertain'))`);
// the default model downloaded (the setup section does it the person's way; alone, a section does it here)
const ready = () => js(`ide.api.invoke('cut:speechSetup', { model: 'whisper-large-v3-turbo' })`);
const showCaptions = async () => {
  await clickAt(await js(`__sp.rect('.cut-grid .cut-slot-tab[data-panel="captions"]')`));
  await until(`!!__sp.rect('.cut-panel[data-panel="captions"] .cut-cap-list')?.w`, 'the captions panel shown');
};
await section('uncertain', async () => {
  await ready();
  await js(`(Cut.ui.speech.forget(), true)`);
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1`, 'the captions', 60000);
  await idle();
  // the Transcript panel: a wavy underline and the confidence in the tooltip
  await showTranscript();
  await until(`__sp.words().length === 80`, 'the transcript', 20000);
  const marks = await js(`[...document.querySelectorAll('.cut-panel[data-panel="transcript"] .cut-tr-word')].map((n, i) => n.classList.contains('uncertain') ? i : -1).filter((i) => i >= 0)`);
  check(S(marks) === S(UNSURE), `the transcript marks the 16 words the fake was unsure of (${S(marks)})`);
  const look = await js(`(() => { const n = document.querySelector('.cut-tr-word[data-i="3"]'); const s = getComputedStyle(n); return { line: s.textDecorationLine, style: s.textDecorationStyle, title: n.title }; })()`);
  check(look.line.includes('underline') && look.style === 'wavy' && look.title.includes('31%'), `with a wavy underline and the confidence in the tooltip (${S(look)})`);
  check(!(await js(`document.querySelector('.cut-tr-word[data-i="2"]').classList.contains('uncertain')`)), 'a word Whisper was sure of is not marked');
  check((await js(`document.querySelector('.cut-tr-next-uncertain').textContent`)).includes('16'), 'the panel foot counts them');
  // the captions panel: the captions holding them, with the words under the text
  const caps = await capDoubts();
  const holding = caps.filter((c) => c.text.includes('자막을') || c.text.includes('편집이')).map((c) => c.id);
  check(holding.length > 0 && S(caps.filter((c) => c.doubt).map((c) => c.id)) === S(holding), `the captions holding an uncertain word have a doubt, the others none (${holding.length} of ${caps.length})`);
  check(caps.filter((c) => c.doubt).every((c) => c.doubt.every((d) => ['자막을', '편집이'].includes(d.text) && d.p < 0.5)), 'each doubt names the word and its p');
  await showCaptions();
  const rows = await rowsUnsure();
  check(S(rows) === S(caps.map((c) => !!c.doubt)), 'the captions panel marks those captions');
  const chip = await js(`document.querySelector('.cut-cap-row.uncertain .cut-cap-doubt-word')?.textContent`);
  check(/^(자막을 31%|편집이 42%)$/.test(chip), `with the word and how sure Whisper was (${chip})`);
  check((await js(`document.querySelector('.cut-panel[data-panel="captions"] .cut-panel-foot').textContent`)).includes(String(holding.length)), 'the foot counts the captions with uncertain words');
  // Next and Previous Uncertain Word with Alt+] and Alt+[ (the keyboard on the program monitor)
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="program"] canvas') || __sp.rect('.cut-panel[data-panel="program"]')`));
  await js(`(Cut.app.setTime(0), true)`);
  const at = () => js(`Math.round(Cut.app.t / ${T} * 100) / 100`);
  await key('Alt+]');
  const t1 = await at();
  await key('Alt+]');
  const t2 = await at();
  await key('Alt+[');
  const t3 = await at();
  check(t1 === 1.5 && t2 === 4 && t3 === 1.5, `Alt+] goes to the next uncertain word, Alt+[ back (${t1}, ${t2}, ${t3})`);
  const shown = await js(`(() => { const t = Cut.app.t; const it = __sp.seq().captions[0].items.find((x) => x.start <= t && t < x.end); const r = document.querySelector('.cut-cap-row[data-id="' + it.id + '"]'); const b = r.getBoundingClientRect(); const l = r.parentElement.getBoundingClientRect(); return r.classList.contains('current') && b.top >= l.top - 1 && b.bottom <= l.bottom + 1; })()`);
  check(shown, 'the caption holding it is lit and in view');
  // the Automation menu has them, with their keys
  await automation('Next Uncertain Word');
  check((await at()) === 4, 'Next Uncertain Word in the Automation menu');
  check(await js(`ide.keymap.label('Cut.auto.nextUncertain') === 'Alt+]' && ide.keymap.label('Cut.auto.prevUncertain') === 'Alt+['`), 'its keys are Alt+] and Alt+[');
  // Mark as Checked: the caption is right as it is (one undo step)
  const steps0 = await js('__sp.steps()');
  await clickAt(await js(`__sp.rect(document.querySelector('.cut-cap-row.uncertain .cut-cap-doubt-ok'))`));
  await until(`__sp.steps() === ${steps0 + 1}`, 'the check mark', 5000);
  const afterOk = await rowsUnsure();
  check(afterOk.filter(Boolean).length === holding.length - 1 && (await js('__sp.last()')) === 'Edit Caption', 'the check mark clears that caption\'s mark in one undo step');
  await key('Ctrl+Z');
  check((await rowsUnsure()).filter(Boolean).length === holding.length, 'Ctrl+Z brings the mark back');
  // a caption edited by a person stops counting
  const firstUnsure = (await capDoubts()).find((c) => c.doubt);
  await clickAt(await js(`(() => { const t = document.querySelector('.cut-cap-row[data-id="${firstUnsure.id}"] .cut-cap-text'); t.scrollIntoView({ block: 'nearest' }); return __sp.rect(t); })()`));
  await key('Ctrl+End');
  await ctx.type('!');
  await key('Enter');
  await until(`!(__sp.seq().captions[0].items.find((it) => it.id === ${S(firstUnsure.id)}).doubt)`, 'the edited caption', 5000);
  check(!(await js(`document.querySelector('.cut-cap-row[data-id="${firstUnsure.id}"]').classList.contains('uncertain')`)) && (await js(`__sp.seq().captions[0].items.find((it) => it.id === ${S(firstUnsure.id)}).text.endsWith('!')`)),
    'an edited caption is no longer marked');
  await key('Ctrl+Z');
  // the Transcript panel: a double-click corrects a word, which is then no longer uncertain, also after the cache
  await showTranscript();
  await dblclickAt(await js('__sp.word(3)'));
  await until(`!!document.querySelector('.cut-panel[data-panel="transcript"] .cut-tr-edit')`, 'the word field', 5000);
  check((await js(`document.activeElement?.className`)) === 'cut-tr-edit' && (await js(`document.activeElement.value`)) === '자막을', 'a double-click turns the word into a field with its text');
  await ctx.type('자막들을');
  await key('Enter');
  await until(`__sp.words()[3]?.text === '자막들을'`, 'the corrected word', 5000);
  check(!(await js(`document.querySelector('.cut-tr-word[data-i="3"]').classList.contains('uncertain')`)) && (await js(`document.querySelector('.cut-tr-next-uncertain').textContent`)).includes('15'), 'the corrected word is not uncertain any more (15 left)');
  await dblclickAt(await js('__sp.word(8)'));
  await until(`!!document.querySelector('.cut-tr-edit')`, 'the field', 5000);
  await key('Enter');
  await until(`!document.querySelector('.cut-tr-word[data-i="8"]').classList.contains('uncertain')`, 'the confirmed word', 5000);
  check((await js('__sp.words()'))[8].text === '편집이', 'Enter on a word left as it was confirms it: same text, no mark');
  await dblclickAt(await js('__sp.word(13)'));
  await until(`!!document.querySelector('.cut-tr-edit')`, 'the field', 5000);
  await ctx.type('xyz');
  await key('Escape');
  await sleep(150);
  check((await js('__sp.words()'))[13].text === '자막을' && (await js(`document.querySelector('.cut-tr-word[data-i="13"]').classList.contains('uncertain')`)), 'Esc leaves the word as it was');
  await js(`(Cut.ui.speech.forget(), Cut.ui.transcript.refresh(), Cut.ui.speech.loadCached(Cut.app).then(() => Cut.ui.transcript.refresh()), true)`);
  await until(`__sp.words().length === 80`, 'the transcript read again from the cache', 10000);
  check((await js('__sp.words()'))[3].text === '자막들을' && !(await js(`document.querySelector('.cut-tr-word[data-i="3"]').classList.contains('uncertain')`)), 'the correction is kept in the transcript cache');
  // with the keyboard on the Transcript panel, Alt+] walks its words (the corrected ones skipped)
  await clickAt(await js('__sp.word(0)'));
  await key('Alt+]');
  check((await at()) === 6.5 && (await js('Cut.ui.transcript.selection'))?.[0] === 13, `from the Transcript panel Alt+] goes to its next uncertain word and selects it (${await at()})`);
  // the marks can be turned off
  await js(`(ide.settings.set('cut.speech.markUncertain', false), true)`);
  await sleep(200);
  check(!(await js(`document.querySelector('.cut-tr-word.uncertain')`)) && (await js(`document.querySelector('.cut-tr-next-uncertain').hidden`)), 'with the marks off the transcript shows none');
  await showCaptions();
  check(!(await rowsUnsure()).some(Boolean), 'nor the captions panel');
  const t0 = await at();
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="program"] canvas') || __sp.rect('.cut-panel[data-panel="program"]')`));
  await key('Alt+]');
  check((await at()) === t0, 'and Alt+] does not move');
  await js(`(ide.settings.set('cut.speech.markUncertain', true), true)`);
  await sleep(200);
  check((await rowsUnsure()).some(Boolean), 'turned on again, the marks are back');
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${S(theme)})`);
    await sleep(300);
    await js(`(Cut.app.setTime(1.5 * ${T}), Cut.ui.captions.reveal(Cut.app, 1.5 * ${T}), true)`);
    log(`  saved ${await ctx.shot(`whisper-captions-uncertain-${theme}.png`)}`);
    await showTranscript();
    await sleep(200);
    log(`  saved ${await ctx.shot(`whisper-transcript-uncertain-${theme}.png`)}`);
    await showCaptions();
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);
});

// ---------- the word list ----------
await section('word list', async () => {
  await ready();
  await js(`(Cut.ui.speech.forget(), true)`);
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
  const windows0 = (await js('__sp.status()')).stats.windows;
  await automation('Auto Captions…');
  await until(`!!document.querySelector('#cutSpeechCaptions .cut-speech-terms')`, 'the word list in the Auto Captions dialog');
  check((await js(`document.querySelector('#cutSpeechCaptions .cut-speech-terms').value`)) === '', 'a new project has no word list');
  await clickAt(await js(`__sp.rect('#cutSpeechCaptions .cut-speech-terms')`));
  await ctx.type('박지민');
  // Enter as typed into a text field (a key with its character), which the dialog leaves to the list
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: String.fromCharCode(13) } : {}) });
  await ctx.type('Nano Studio');
  check(!!(await js(`document.querySelector('#cutSpeechCaptions')`)), 'Enter in the word list starts a new line, not the recognition');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1`, 'the captions with the word list', 60000);
  await idle();
  check(S(await js(`Cut.app.project.settings.speechTerms`)) === S(['박지민', 'Nano Studio']), 'the list is kept with the project');
  const st = await js('__sp.status()');
  check(st.stats.windows > windows0, `a new list is a new transcript: recognised again, not read from the cache (${st.stats.windows - windows0} windows)`);
  const capsNow = await capDoubts();
  const text = capsNow.map((c) => c.text.replace(/\n/g, ' ')).join(' ');
  check((text.match(/박지민/g) || []).length === 8 && !text.includes('자막을'), 'Whisper was told of the term: it hears it where it misheard before (the fake: 자막을 becomes the first term)');
  check(capsNow.filter((c) => c.doubt).every((c) => c.doubt.every((d) => d.text === '편집이')), 'and is sure of it: only 편집이 is still doubtful');
  const labels = await js(`Cut.app.history.list().filter((x) => x.done).slice(-2).map((x) => x.label)`);
  check(S(labels) === S(['Project Settings', 'Auto Captions']), `the list change is its own undo step before Auto Captions (${S(labels)})`);
  // the same list again: the cache answers
  const windows1 = (await js('__sp.status()')).stats.windows;
  await js(`(Cut.ui.speech.forget(), true)`);
  await automation('Auto Captions…');
  check((await js(`document.querySelector('#cutSpeechCaptions .cut-speech-terms').value`)) === '박지민\nNano Studio', 'the dialog shows the project\'s list');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.last() === 'Auto Captions'`, 'the captions again', 30000);
  await idle();
  check((await js('__sp.status()')).stats.windows === windows1, 'the same list: read from the cache, nothing recognised again');
  // the Transcript panel's Word List… dialog
  await showTranscript();
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="transcript"] .cut-tr-terms')`));
  await until(`!!document.querySelector('#cutSpeechTerms .cut-speech-terms')`, 'the Word List dialog');
  check((await js(`document.querySelector('#cutSpeechTerms .cut-speech-terms').value`)) === '박지민\nNano Studio', 'Word List… shows the list');
  await js(`(() => { const t = document.querySelector('#cutSpeechTerms .cut-speech-terms'); t.value = '김수현, 해운대'; t.dispatchEvent(new Event('input')); return true; })()`);
  await dialogButton('cutSpeechTerms', 'OK');
  await until(`!document.querySelector('#cutSpeechTerms')`, 'the dialog closed');
  check(S(await js(`Cut.app.project.settings.speechTerms`)) === S(['김수현', '해운대']) && (await js('__sp.last()')) === 'Project Settings', 'OK sets the new list in one undo step');
  await key('Ctrl+Z');
  check(S(await js(`Cut.app.project.settings.speechTerms`)) === S(['박지민', 'Nano Studio']), 'Ctrl+Z puts the old list back');
});

// ---------- a window that stops early ----------
// Whisper under music wrote one sentence for a 30 s window full of speech and stopped ("Good evening." then 28 s
// lost). The fake does the same (stopAfter): the next window starts where the text stopped, so every word is there.
await section('early stop', async () => {
  const STOPS = P('stops.mp4');
  await js(`__sp.src(${S(STOPS)}, { seconds: 40, fps: [30, 1], w: 320, h: 180, beepEvery: 0.5, beepLength: 0.3, keyEvery: 1 })`);
  await js(`(Cut.ui.speech.forget(), ide.api.invoke('cut:speechTestConfig', { stopAfter: 2 }))`);
  await js(`__sp.fresh([${S(STOPS)}], [{ file: 0, at: 0, len: 40 }])`);
  const windows0 = (await js('__sp.status()')).stats.windows;
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1`, 'the captions', 60000);
  await idle();
  await js(`ide.api.invoke('cut:speechTestConfig', { stopAfter: 0 })`);
  const words = (await js('__sp.caps()'))[0].items.map((it) => it.text.replace(/\n/g, ' ')).join(' ').split(' ');
  check(S(words) === S(expectTalk), `the first window stopped after 2 s, yet every word is there once and in order (${words.length} of 80)`);
  const windows = (await js('__sp.status()')).stats.windows - windows0;
  check(windows === 3, `one window more than the usual two (${windows})`);
});

// ---------- filler words ----------
await section('fillers', async () => {
  await js(`__sp.fresh([${S(PAUSES)}], [{ file: 0, at: 0, len: 9 }])`);
  await showTranscript();
  await clickAt(await js(`__sp.rect('.cut-tr-run')`));
  await until(`__sp.words().length === ${HALVES.length}`, 'the transcript of the WAV', 30000);
  await idle();
  const a0 = await js(`__sp.length('A1')`);
  const steps0 = await js('__sp.steps()');
  await clickAt(await js(`__sp.rect('.cut-tr-fillers')`));
  await until(`!!document.querySelector('#cutSpeechFillers .cut-auto-summary')`, 'the Remove Filler Words dialog');
  const sum = await js(`(() => { const n = document.querySelector('#cutSpeechFillers .cut-auto-summary'); return { fillers: Number(n.dataset.fillers), cuts: Number(n.dataset.cuts), text: n.textContent, overlay: (Cut.ui.timeline.overlay?.ranges || []).map(([a, b]) => [a / ${T}, b / ${T}]) }; })()`);
  check(sum.fillers === 3, `three hesitations found: 음 and 어 twice (${S(sum)})`);
  check(sum.overlay.length === sum.cuts && sum.overlay.some(([a, b]) => a < 3.6 && b > 5.8), 'the preview overlay shows the cuts, the long pause among them');
  // pauses off: fewer cuts
  await clickAt(await js(`__sp.rect('#cutSpeechFillers .cut-speech-pauses')`));
  const noPause = await js(`Number(document.querySelector('#cutSpeechFillers .cut-auto-summary').dataset.cuts)`);
  check(noPause === sum.cuts - 1, `without pauses the long pause is not cut (${noPause} cuts)`);
  await clickAt(await js(`__sp.rect('#cutSpeechFillers .cut-speech-pauses')`));
  await dialogButton('cutSpeechFillers', 'Remove');
  await sleep(200);
  const after = (await js('__sp.words()')).map((w) => w.text);
  check(!after.includes('음') && !after.includes('어') && after.length === HALVES.length - 3, `the fillers are gone from the transcript (${S(after)})`);
  const a1 = await js(`__sp.length('A1')`);
  const removed = sum.overlay.reduce((n, [a, b]) => n + (b - a), 0);
  check(Math.abs(a0 - a1 - removed) < 0.01 && removed > 2.5, `the audio is shorter by what the preview showed (${(a0 - a1).toFixed(3)} s)`);
  check((await js('__sp.steps()')) === steps0 + 1 && (await js('__sp.last()')) === 'Remove Filler Words' && (await js('Cut.ui.timeline.overlay')) === null, 'one undo step, and the overlay is gone');
  await clickAt(await js(`__sp.rect('.cut-panel[data-panel="transcript"] .cut-tr-text')`));
  await key('Ctrl+Z');
  check(Math.abs((await js(`__sp.length('A1')`)) - a0) < 1e-6 && (await js('__sp.words()')).length === HALVES.length, 'Ctrl+Z puts them back');
  // from the Automation menu as well
  await automation('Remove Filler Words…');
  await until(`!!document.querySelector('#cutSpeechFillers')`, 'the dialog from the Automation menu');
  await dialogButton('cutSpeechFillers', 'Cancel');
  check((await js('Cut.ui.timeline.overlay')) === null && (await js('__sp.steps()')) === steps0, 'Cancel changes nothing');
});

// ---------- settings and the Window menu ----------
await section('settings', async () => {
  await clickAt(await js(`__sp.rect('.cut-topbar .cut-window-btn')`));
  await clickMenuPath(ctx, [await tr('Transcript')]);
  await until(`!!document.querySelector('.cut-grid .cut-slot-tab[data-panel="transcript"]')`, 'the Transcript tab from the Window menu');
  check(true, 'the Window menu lists the Transcript panel and opens it');
  await js(`(ide.openSettings('cut'), true)`);
  await until(`!!document.querySelector('.cut-speech-model') && document.querySelector('.cut-speech-model').options.length === 2`, 'the Speech Recognition section', 10000);
  await until(`document.querySelector('.cut-speech-model-state').dataset.ready === 'true'`, 'large-v3 turbo downloaded');
  const opts = await js(`[...document.querySelector('.cut-speech-model').options].map((o) => o.value)`);
  check(S(opts) === S(['whisper-small', 'whisper-large-v3-turbo']), 'the model choice: Whisper small and large-v3 turbo');
  check((await js(`document.querySelector('.cut-speech-model').value`)) === 'whisper-large-v3-turbo', 'large-v3 turbo is the default');
  await js(`(() => { const s = document.querySelector('.cut-speech-model'); s.value = 'whisper-small'; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(`document.querySelector('.cut-speech-model-state').dataset.ready === 'false' && !document.querySelector('.cut-speech-download').hidden`, 'small not downloaded, with Download…');
  check(true, 'choosing small shows that it is not downloaded and offers Download…');
  check((await js('__sp.status()')).models.find((m) => m.id === 'whisper-small').installed === false, 'choosing it downloads nothing');
  // Download… there downloads the chosen model; then another model is another transcript: large-v3 turbo's words for
  // the talk are in the cache, yet small recognises it again.
  await clickAt(await js(`(document.querySelector('.cut-speech-download').scrollIntoView({ block: 'center' }), __sp.rect('.cut-speech-download'))`));
  await until(`!!document.querySelector('#cutSpeechSetup')`, 'the setup dialog for small');
  check(await js(`!document.querySelector('#cutSpeechSetup .cut-speech-other')`), 'Download… on the settings page offers no other model: it downloads the one chosen');
  await dialogButton('cutSpeechSetup', 'Download');
  await until(`!document.querySelector('#cutSpeechSetup') && document.querySelector('.cut-speech-model-state').dataset.ready === 'true' && document.querySelector('.cut-speech-download').hidden`, 'small downloaded from the settings page', 20000);
  check((await js('__sp.status()')).models.every((m) => m.installed), 'Download… on the settings page downloads small');
  await clickAt(await js(`__sp.rect('#settingsOk')`));
  await until(`!document.querySelector('.settings-dialog') && ide.settings.get('cut.speech.model') === 'whisper-small'`, 'OK keeps small as the model');
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
  const windows0 = (await js('__sp.status()')).stats.windows;
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1`, "small's captions", 60000);
  await idle();
  const st = await js('__sp.status()');
  check(st.stats.windows > windows0 && st.engine.model === 'whisper-small', `another model recognises the talk again, with that model (${st.stats.windows - windows0} windows, ${st.engine.model})`);
  await js(`(ide.settings.set('cut.speech.model', 'whisper-large-v3-turbo'), true)`);
});

// ---------- the chosen model missing, another one on this PC ----------
// Someone who recognized with small before the default became large-v3 turbo: the setup dialog offers small, which
// becomes the setting, and recognition goes on with nothing downloaded (offline too).
await section('installed', async () => {
  await js(`(ide.settings.set('cut.speech.model', 'whisper-large-v3-turbo'), ide.api.invoke('cut:speechTestConfig', { installed: ['whisper-small'] }))`);
  await js(`(Cut.ui.speech.forget(), true)`);
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 10 }])`);
  const st0 = await js('__sp.status()');
  check(st0.runtime && S(st0.models.filter((m) => m.installed).map((m) => m.id)) === S(['whisper-small']), 'only small is on this PC');
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`!!document.querySelector('#cutSpeechSetup')`, 'the setup dialog for large-v3 turbo');
  const small = st0.models.find((m) => m.id === 'whisper-small').name;
  const note = await js(`document.querySelector('#cutSpeechSetup .cut-speech-other')?.textContent ?? ''`);
  check(note.includes(small) && /nothing to download/.test(note), `the dialog says ${small} is already on this PC (${note})`);
  const use = await js(`tr('Use {name}', { name: ${S(small)} })`);
  await until(`!!__sp.button('#cutSpeechSetup', ${S(use)})`, `the ${use} button`, 10000);
  log(`  saved ${await ctx.shot('whisper-setup-installed-dark.png')}`);
  await clickAt(await js(`__sp.button('#cutSpeechSetup', ${S(use)})`));
  await until(`__sp.caps().length === 1`, "small's captions", 60000);
  await idle();
  const st = await js('__sp.status()');
  check(st.stats.setups === st0.stats.setups && st.engine.model === 'whisper-small' && !st.models.find((m) => m.id === 'whisper-large-v3-turbo').installed,
    `nothing was downloaded and small recognized the talk (${st.stats.setups - st0.stats.setups} downloads, ${st.engine.model})`);
  check((await js(`ide.settings.get('cut.speech.model')`)) === 'whisper-small', 'small is now the setting');
  await js(`(Cut.ui.speech.forget(), __sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 10 }]))`);
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`__sp.caps().length === 1`, 'captions the next time', 60000);
  await idle();
  check(!(await js(`!!document.querySelector('#cutSpeechSetup')`)), 'the next recognition asks nothing');
  await js(`(ide.settings.set('cut.speech.model', 'whisper-large-v3-turbo'), ide.api.invoke('cut:speechTestConfig', { installed: ['whisper-small', 'whisper-large-v3-turbo'] }))`);
});

// ---------- screenshots, dark and light ----------
await section('shots', async () => {
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 40 }])`);
  await showTranscript();
  await until(`__sp.words().length === 80`, 'the transcript', 20000);
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${S(theme)})`);
    await until(`document.documentElement.dataset.theme === ${S(theme)}`, `the ${theme} theme`, 5000).catch(() => {});
    await sleep(300);
    await js(`(Cut.ui.transcript.select(12, 15), Cut.app.setTime(7.05 * ${T}), true)`);
    await clickAt(await js(`__sp.rect('.cut-tr-search')`));
    await js(`(() => { const s = document.querySelector('.cut-tr-search'); s.value = '오늘은'; s.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(300);
    log(`  saved ${await ctx.shot(`whisper-transcript-${theme}.png`)}`);
    await automation('Remove Filler Words…');
    await until(`!!document.querySelector('#cutSpeechFillers')`, 'the fillers dialog');
    await sleep(300);
    log(`  saved ${await ctx.shot(`whisper-fillers-${theme}.png`)}`);
    await dialogButton('cutSpeechFillers', 'Cancel');
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

// ---------- a failed download, in Korean ----------
await section('korean', async () => {
  first.close();
  await sleep(1500);
  ctx = await launch({ fixture: 'core', port: 9768, name: 'cut-whisper-ko', mode: 'cut', lang: 'ko-KR', env: { ...env, PYIDE_WHISPER_FAKE_SETUP: 'offline' } });
  ({ js, until, check, cdp, sleep } = ctx);
  await boot();
  await js(`__sp.fresh([${S(TALK)}], [{ file: 0, at: 0, len: 10 }])`);
  await automation('Auto Captions…');
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await until(`!!document.querySelector('#cutSpeechSetup')`, 'the setup dialog');
  const body = await js(`document.querySelector('#cutSpeechSetup').textContent`);
  check(/이 PC에서/.test(body) && /내려받기를 누르기 전에는 아무것도 내려받지 않습니다/.test(body), `the dialog is in Korean (${body.slice(0, 120)}…)`);
  log(`  saved ${await ctx.shot('whisper-setup-ko-dark.png')}`);
  await dialogButton('cutSpeechSetup', 'Download');
  await until(`!document.querySelector('#cutSpeechSetup .cut-speech-error').hidden`, 'the error', 15000);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await sleep(400);
  log(`  saved ${await ctx.shot('whisper-setup-error-ko-light.png')}`);
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  const err = await js(`({ text: document.querySelector('#cutSpeechSetup .cut-speech-error').textContent, code: document.querySelector('#cutSpeechSetup .cut-speech-error').dataset.code, again: document.querySelector('#cutSpeechSetup .dialog-buttons .primary').textContent })`);
  check(err.code === 'offline' && /인터넷에 연결할 수 없어/.test(err.text) && err.again === '다시 시도', `an offline download is explained in plain Korean, with Try Again (${S(err)})`);
  await dialogButton('cutSpeechSetup', 'Cancel');
  check(!(await js('__sp.caps().length')), 'no captions after the failed download');
});

// finish() counts only its own ctx: the first window's results join the second's.
if (ctx !== first) {
  ctx.results.unshift(...first.results);
  ctx.consoleErrors.unshift(...first.consoleErrors);
  ctx.cspViolations.unshift(...first.cspViolations);
}
ctx.finish();
