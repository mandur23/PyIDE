// Nano Studio Cut's speech recognition (ui-speech.js, speech.js, main/cut/whisper.js) in the real app with the fake
// backend (PYIDE_WHISPER_BACKEND=fake: one word per burst of sound, so no model is needed), reached the way a person
// does: the Automation menu, the captions panel's button, the Transcript panel, clicked with real mouse events and keys.
// Checks:
// - the setup dialog on first use (sizes, "on this PC"), nothing downloaded until Download is pressed, Cancel leaves
//   everything as it was, the download's progress, then the recognition;
// - Auto Captions on testsrc beeps (40 s, two windows joined at their seam): one caption track, every word once and
//   in order, lines of at most 18 characters, two lines, 6 s, frames, no overlaps; one undo step; again over an In-Out
//   range, replacing only the captions inside it; a second run read from the cache, not recognised again;
// - the Transcript panel: the words, a click seeks, the word under the playhead lit (also while playing), Shift+click
//   selects, Delete ripple-deletes the words from the video and its linked audio (one undo step), Ctrl+Z, search;
// - Remove Filler Words on a WAV with hesitations and a long pause: the preview overlay and summary, then one ripple
//   delete that takes 음 and 어 and the pause, Ctrl+Z;
// - the settings page's Speech Recognition section; the Window menu; a failed download (offline) explained in Korean;
// - screenshots of the panel and the dialogs in the dark and the light theme (verify/out/cut-whisper/*.png).
// Usage: node verify/cut-whisper.mjs   (CUT_WHISPER_ONLY=setup,captions,transcript,fillers,settings,shots,korean)
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
const KEYS = { Space: [' ', 'Space', 32], Delete: ['Delete', 'Delete', 46], Escape: ['Escape', 'Escape', 27], Enter: ['Enter', 'Enter', 13] };
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
  check(st1.stats.setups === 1 && st1.runtime && st1.models.find((m) => m.id === 'whisper-small').installed, 'one download after the click, and the model is ready');
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
  await until(`document.querySelector('.cut-speech-model-state').dataset.ready === 'true'`, 'whisper-small downloaded');
  const opts = await js(`[...document.querySelector('.cut-speech-model').options].map((o) => o.value)`);
  check(S(opts) === S(['whisper-small', 'whisper-large-v3-turbo']), 'the model choice: Whisper small and large-v3 turbo');
  await js(`(() => { const s = document.querySelector('.cut-speech-model'); s.value = 'whisper-large-v3-turbo'; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(`document.querySelector('.cut-speech-model-state').dataset.ready === 'false' && !document.querySelector('.cut-speech-download').hidden`, 'large-v3 turbo not downloaded, with Download…');
  check(true, 'choosing large-v3 turbo shows that it is not downloaded and offers Download…');
  check((await js('__sp.status()')).models.find((m) => m.id === 'whisper-large-v3-turbo').installed === false, 'choosing it downloads nothing');
  await js(`document.querySelector('.dialog-backdrop .dialog-buttons .secondary')?.click(), true`);
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
