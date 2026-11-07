// Nano Studio Cut's voice isolation (ui-voice.js, main/cut/voice.js, main/ai/voice_server.py) in the real app, reached
// the way a person does: the Automation menu, the project panel's item menu, the Auto Captions dialog and the settings
// page, with real mouse events and keys.
// Checks, with the fake backend (PYIDE_VOICE_BACKEND=fake: the vocals are the sound itself, so no model is needed):
// - the setup dialog on first use (the model's size, on this PC), nothing before Download, its progress, then the
//   command: Isolate Voice on a selected video clip gives its linked audio clip a new WAV in the workspace's Media
//   folder (never next to the source), imported into the source's bin, as one undo step (Ctrl+Z, Ctrl+Shift+Z), the
//   clip's place, in, out and link kept; the WAV as long as the media; run again, the same file is used;
// - Cancel while the voice is being isolated leaves nothing: no WAV or .part, no temp file, no media, no undo step;
// - the project panel's Isolate Voice imports the vocals and leaves the timeline as it is;
// - the speech recognition option: the Auto Captions dialog's checkbox and the settings page's, the isolated sound
//   (in the cache) is what Whisper hears, its transcript is its own (off again: recognised again), and the next run
//   with it on reads both from the cache;
// - Isolate Voice on a transcribed clip with speaker labels: the Transcript panel keeps its words, times and speaker
//   paragraphs (the transcript and the turns carry over to the vocals, nothing recognised again), Ctrl+Z restores all;
// then with the real backend and an empty Hugging Face cache (HF_HUB_CACHE, so the model is missing, nothing
// downloaded): the setup dialog with the model's size, Cancel changing nothing, the settings page's Download….
// With CUT_VOICE_REAL=1 also the real HTDemucs on a 10 s test clip: a WAV of the media's length, much quieter than
// the beeps (a tone is not a voice), and its time per minute of sound.
// Usage: node verify/cut-voice.mjs   (CUT_VOICE_ONLY=command,cancel,bin,speech,transcript,missing,real)
import { existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import { launch, tempDir, clickMenuPath } from './lib.mjs';

const ONLY = (process.env.CUT_VOICE_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-voice-home');
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const P = (name) => path.join(home, name);
const listDir = (d) => { try { return readdirSync(d); } catch { return []; } };
const wavs = (d) => listDir(d).filter((n) => /\.wav(\.part)?$/i.test(n));

let ctx;
let js, until, check, cdp, sleep;
const results = [];
async function start(env, name) {
  ctx = await launch({ fixture: 'core', port: 9767, name, mode: 'cut', env: { PYIDE_CUT_HOME: home, ...env } });
  ({ js, until, check, cdp, sleep } = ctx);
  await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
  await js('Cut.loaded');
  await until('window.__cutReady === true', 'the editor started', 30000);
  await js(`(() => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const H = (window.__vo = {});
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
        h.do(C.place(seq.id, { source: { media: ids[c.file] }, in: (c.in || 0) * T, out: ((c.in || 0) + c.len) * T, at: c.at * T, video: 'V1', audio: 'A1', mode: 'overwrite' }));
      }
      Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
      Cut.app.select([]);
      Cut.app.setTime(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return ids;
    };
    H.clips = () => H.seq().clips.map((c) => ({ id: c.id, track: c.track, media: c.source.media, start: c.start / T, in: c.in / T, out: c.out / T, link: c.link })).sort((a, b) => a.track.localeCompare(b.track));
    H.media = () => Cut.app.project.media.map((m) => ({ id: m.id, name: m.name, path: m.path, duration: m.duration / T, audio: !!m.audio }));
    H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
    H.last = () => Cut.app.history.list().filter((x) => x.done).at(-1)?.label;
    H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
    H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; };
    H.status = () => ide.api.invoke('cut:voiceStatus');
    H.speech = () => ide.api.invoke('cut:speechStatus');
    // The RMS of source seconds [a, b) of a media file's sound, all channels.
    H.rms = async (mediaId, a, b) => {
      const o = await Cut.media.open(Cut.app.project, mediaId);
      const r = await Cut.decoder.audioReader(o, o.audio);
      const planes = await r.read(Math.round(a * r.rate), Math.round(b * r.rate));
      let s = 0, n = 0;
      for (const p of planes) for (const x of p) { s += x * x; n++; }
      return Math.sqrt(s / Math.max(1, n));
    };
    return true;
  })()`);
  check(await js(`['commands', 'media', 'decoder', 'audioengine', 'testsrc'].every((m) => !!Cut[m]) && !!Cut.ui.voice?.isolate && !!Cut.commands.replaceAudio`), 'the voice isolation module and its command are loaded');
}
async function stop() {
  results.push(...ctx.results);
  await ctx.close();
}

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, button = 'left', modifiers = 0 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount: 1, modifiers });
async function clickAt(p, { button = 'left' } = {}) {
  if (!p) throw new Error('nothing to click');
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y, { button, buttons: button === 'right' ? 2 : 1 });
  await mouse('mouseReleased', p.x, p.y, { button, buttons: 0 });
  await sleep(120);
}
async function key(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
  const base = { modifiers: mods, key: name.toLowerCase(), code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(100);
}
const tr = (s) => js(`tr(${S(s)})`);
async function automation(label) {
  await clickAt(await js(`__vo.rect('.cut-topbar .cut-auto-btn')`));
  await clickMenuPath(ctx, [await tr(label)]);
  await sleep(150);
}
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__vo.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 10000);
  await clickAt(await js(`__vo.button('#${id}', ${S(name)})`));
}
const idle = (ms = 60000) => until('!Cut.ui.auto.running && !document.querySelector(".cut-auto-task")', 'the task to end', ms);
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await js(`ide.ui.closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()); Cut.ui.auto.cancel(); true`).catch(() => {});
  await sleep(200);
}
async function selectVideoClip() {
  await clickAt(await js(`(() => { const c = __vo.seq().clips.find((x) => x.track === 'V1'); const p = Cut.ui.timeline.clientPoint((c.start + Cut.model.clipEnd(c)) / 2, 'V1', 0.55); return { x: p.x, y: Math.round(p.y) }; })()`));
  await until(`Cut.app.selection.size >= 1`, 'the clip selected', 4000);
}
const media = P('Media');

// ---------- the fake backend ----------
if (['command', 'cancel', 'bin', 'speech', 'transcript'].some(want)) {
  await start({ PYIDE_VOICE_BACKEND: 'fake', PYIDE_VOICE_FAKE_SETUP: 'ok', PYIDE_WHISPER_BACKEND: 'fake' }, 'cut-voice');
  mkdirSync(P('src'), { recursive: true });
  const srcFile = P('src/talk.mp4');
  await js(`__vo.src(${S(srcFile)}, { seconds: 12, w: 320, h: 180, beepEvery: 1 })`);

  await section('command', async () => {
    const ids = await js(`__vo.fresh([${S(srcFile)}], [{ file: 0, at: 1, in: 2, len: 8 }])`);
    const before = await js('__vo.clips()');
    const steps = await js('__vo.steps()');
    await selectVideoClip();
    await automation('Isolate Voice');
    await until(`!!document.querySelector('#cutVoiceSetup')`, 'the setup dialog on first use', 8000);
    const text = await js(`document.querySelector('#cutVoiceSetup').textContent`);
    check(text.includes('HTDemucs') && text.includes(await tr('Download')), `the setup dialog names the model and offers Download (${text.slice(0, 160)})`);
    check(!(await js(`__vo.status()`)).model.installed && (await js(`__vo.status()`)).stats.setups === 0, 'nothing is downloaded before Download is pressed');
    await dialogButton('cutVoiceSetup', 'Download');
    await until(`Number(document.querySelector('#cutVoiceSetup .cut-speech-bar')?.dataset.progress) > 0`, 'the download progress', 8000);
    await until(`!document.querySelector('#cutVoiceSetup')`, 'the dialog closes when ready', 15000);
    await idle(30000);
    await until(`__vo.last() === 'Isolate Voice'`, 'the Isolate Voice step', 8000);
    const after = await js('__vo.clips()');
    const list = await js('__vo.media()');
    const files = wavs(media);
    check(files.length === 1 && / voice [0-9a-f]{16}\.wav$/.test(files[0]), `one vocals WAV in the workspace's Media folder (${files.join(', ')})`);
    check(listDir(P('src')).every((n) => !/\.wav/i.test(n)), 'nothing is written next to the source file');
    const vocal = list.find((m) => m.id !== ids[0]);
    check(list.length === 2 && vocal && vocal.name === await js(`tr('{name} (Voice)', { name: 'talk.mp4' })`) && vocal.path.toLowerCase() === path.join(media, files[0]).toLowerCase(), `the WAV is imported as "talk.mp4 (Voice)" (${S(list.map((m) => m.name))})`);
    check(vocal && Math.abs(vocal.duration - list.find((m) => m.id === ids[0]).duration) < 0.05, `the WAV is as long as the media (${vocal?.duration} vs ${list[0].duration})`);
    const a0 = before.find((c) => c.track === 'A1');
    const a1 = after.find((c) => c.track === 'A1');
    const v1 = after.find((c) => c.track === 'V1');
    check(a1.media === vocal?.id && v1.media === ids[0], 'the audio clip plays the vocals, the video clip its own media');
    check(a1.start === a0.start && a1.in === a0.in && a1.out === a0.out && a1.link && a1.link === v1.link, `the clip keeps its place, in, out and link (${S(a0)} -> ${S(a1)})`);
    check(await js('__vo.steps()') === steps + 1, 'one undo step');
    const loud = await js(`__vo.rms(${S(vocal.id)}, 2, 9)`);
    const orig = await js(`__vo.rms(${S(ids[0])}, 2, 9)`);
    check(loud > 0.01 && Math.abs(loud - orig) / orig < 0.1, `the fake's vocals are the sound itself (RMS ${loud.toFixed(4)} vs ${orig.toFixed(4)})`);
    await clickAt(await js(`__vo.rect('.cut-panel[data-panel="program"]') || __vo.rect('.cut-stage')`));
    await key('Ctrl+Z');
    check((await js('__vo.clips()')).find((c) => c.track === 'A1').media === ids[0] && (await js('__vo.media()')).length === 1, 'Ctrl+Z gives the clip its own sound back and takes the WAV out of the project');
    await key('Ctrl+Shift+Z');
    check((await js('__vo.clips()')).find((c) => c.track === 'A1').media === vocal.id, 'Ctrl+Shift+Z isolates it again');
    await key('Ctrl+Z');
    const separations = (await js('__vo.status()')).stats.separations;
    await selectVideoClip();
    await automation('Isolate Voice');
    await idle(30000);
    await until(`__vo.last() === 'Isolate Voice'`, 'the second Isolate Voice step', 8000);
    check((await js('__vo.status()')).stats.separations === separations && wavs(media).length === 1, 'run again, the WAV made before is used');
  });

  await section('cancel', async () => {
    await js(`ide.api.invoke('cut:voiceTestConfig', { delay: 600 })`);
    const longFile = P('src/long.mp4');
    await js(`__vo.src(${S(longFile)}, { seconds: 20, w: 320, h: 180, beepEvery: 1 })`);
    await js(`__vo.fresh([${S(longFile)}], [{ file: 0, at: 0, len: 18 }])`);
    const before = await js('__vo.media()');
    const steps = await js('__vo.steps()');
    const had = wavs(media).length;
    await selectVideoClip();
    await automation('Isolate Voice');
    await until(`Number(document.querySelector('.cut-auto-task')?.dataset.progress) > 0.3`, 'the separation under way', 20000);
    check((await js('__vo.status()')).open === 1 && wavs(media).some((n) => n.endsWith('.part')), 'while it runs, a temp file and a .part are there');
    await clickAt(await js(`__vo.rect('.cut-auto-task .cut-auto-task-cancel')`));
    await idle(15000);
    await sleep(300);
    check(wavs(media).length === had && !wavs(media).some((n) => n.endsWith('.part')), `Cancel leaves no WAV and no .part (${wavs(media).join(', ')})`);
    check((await js('__vo.status()')).open === 0, 'Cancel leaves no temp file');
    check(S(await js('__vo.media()')) === S(before) && await js('__vo.steps()') === steps, 'Cancel changes nothing in the project');
    check((await js('__vo.status()')).stats.cancelled >= 1, 'main saw the cancel');
    await js(`ide.api.invoke('cut:voiceTestConfig', { delay: 0 })`);
  });

  await section('bin', async () => {
    const ids = await js(`__vo.fresh([${S(srcFile)}], [{ file: 0, at: 0, len: 6 }])`);
    const clips = await js('__vo.clips()');
    await clickAt(await js(`__vo.rect('.cut-panel[data-panel="project"] [data-id="${ids[0]}"]')`), { button: 'right' });
    await clickMenuPath(ctx, [await tr('Isolate Voice')]);
    await idle(30000);
    await until(`__vo.media().length === 2`, 'the vocals imported', 8000);
    check(S(await js('__vo.clips()')) === S(clips), 'the project panel\'s Isolate Voice leaves the timeline as it is');
    check(await js('__vo.last()') === 'Isolate Voice', 'and is one undo step');
  });

  await section('speech', async () => {
    await js(`__vo.fresh([${S(srcFile)}], [{ file: 0, at: 0, len: 10 }])`);
    const cacheVoices = () => wavs(P('Cache')).length;
    const v0 = (await js('__vo.status()')).stats.separations;
    const w0 = (await js('__vo.speech()')).stats.windows;
    await automation('Auto Captions…');
    await until(`!!document.querySelector('#cutSpeechCaptions .cut-speech-isolate')`, 'the isolate checkbox in the Auto Captions dialog', 8000);
    check(await js(`document.querySelector('#cutSpeechCaptions .cut-speech-isolate').checked`) === false, 'isolation is off by default');
    await clickAt(await js(`__vo.rect('#cutSpeechCaptions .cut-speech-isolate')`));
    await dialogButton('cutSpeechCaptions', 'Create Captions');
    await idle(60000);
    const st = await js('__vo.status()');
    check(await js(`ide.settings.get('cut.speech.isolateVoice')`) === true, 'the checkbox is remembered in cut.speech.isolateVoice');
    check(st.stats.separations === v0 + 1 && st.stats.last?.place === 'cache' && cacheVoices() >= 1, `the speech was isolated first, into the cache (${S(st.stats)})`);
    const w1 = (await js('__vo.speech()')).stats.windows;
    check(w1 > w0 && (await js(`(Cut.app.sequence.captions || []).find((t) => t.name === tr('Auto Captions'))?.items.length || 0`)) > 0, 'Whisper heard the isolated sound and the captions were made');
    await js(`ide.settings.set('cut.speech.isolateVoice', false)`);
    await js(`Cut.ui.speech.forget()`);
    await automation('Auto Captions…');
    await until(`!!document.querySelector('#cutSpeechCaptions .cut-speech-isolate')`, 'the Auto Captions dialog', 8000);
    check(await js(`document.querySelector('#cutSpeechCaptions .cut-speech-isolate').checked`) === false, 'the dialog follows the setting');
    await dialogButton('cutSpeechCaptions', 'Create Captions');
    await idle(60000);
    const w2 = (await js('__vo.speech()')).stats.windows;
    check(w2 > w1 && (await js('__vo.status()')).stats.separations === v0 + 1, 'off again: the original sound is recognised again, its own transcript, nothing isolated');
    await js(`ide.settings.set('cut.speech.isolateVoice', true)`);
    await js(`Cut.ui.speech.forget()`);
    await automation('Auto Captions…');
    await dialogButton('cutSpeechCaptions', 'Create Captions');
    await idle(60000);
    check((await js('__vo.speech()')).stats.windows === w2 && (await js('__vo.status()')).stats.separations === v0 + 1, 'on again: the transcript of the isolated sound comes from the cache, nothing isolated or recognised');
    await js(`ide.openSettings('cut')`);
    await until(`!!document.querySelector('[data-key="cut.speech.isolateVoice"]') || !!document.querySelector('input[data-setting="cut.speech.isolateVoice"]') || [...document.querySelectorAll('.settings-check')].some((n) => n.textContent.includes(tr('Isolate the voice before recognition (HTDemucs): for speech over music, not over steady noise')))`, 'the speech settings checkbox', 8000);
    check(await js(`[...document.querySelectorAll('.settings-check, label')].some((n) => n.textContent.includes(tr('Isolate the voice before recognition (HTDemucs): for speech over music, not over steady noise')))`), 'the speech settings offer the option');
    check(await js(`!!document.querySelector('.cut-voice-state') && document.querySelector('.cut-voice-state').dataset.ready === 'true'`), 'the Voice Isolation section says the model is there');
    await clickAt(await js(`__vo.rect('#settingsCancel')`));
    await until(`!document.querySelector('.settings-dialog')`, 'the settings window closed', 8000);
    await js(`ide.settings.set('cut.speech.isolateVoice', false)`);
  });

  await section('transcript', async () => {
    const ids = await js(`__vo.fresh([${S(srcFile)}], [{ file: 0, at: 0, len: 10 }])`);
    await js(`Cut.ui.speech.forget()`);
    await clickAt(await js(`__vo.rect('.cut-ws-tab[data-ws="captions"]')`));
    await until(`!!document.querySelector('.cut-grid .cut-slot-tab[data-panel="transcript"]')`, 'the Transcript tab in Captions and Graphics', 8000);
    await clickAt(await js(`__vo.rect('.cut-grid .cut-slot-tab[data-panel="transcript"]')`));
    await until(`!!__vo.rect('.cut-panel[data-panel="transcript"] .cut-tr-run')?.w`, 'the Transcript panel shown', 8000);
    await clickAt(await js(`__vo.rect('.cut-panel[data-panel="transcript"] .cut-tr-run')`));
    await idle(60000);
    await until(`(Cut.ui.transcript?.words.length || 0) > 0`, 'the transcript', 15000);
    const words = await js(`Cut.ui.transcript.words.map((w) => w.text + '@' + (w.t0 / ${T}).toFixed(2))`);
    await js(`(Cut.app.history.do(Cut.commands.setSpeakers({ list: [{ id: 'sp1', name: 'Ana', color: '#e05555' }, { id: 'sp2', name: 'Ben', color: '#3a7bd5' }], turns: { ${S(ids[0])}: [[0, 6, 'sp1'], [6, 12.1, 'sp2']] }, count: 0 })), true)`);
    await until(`document.querySelectorAll('.cut-panel[data-panel="transcript"] .cut-tr-speaker').length >= 2`, 'the speaker paragraphs', 8000);
    const speakers = () => js(`[...document.querySelectorAll('.cut-panel[data-panel="transcript"] .cut-tr-speaker')].map((n) => n.dataset.speaker + ':' + n.textContent.trim())`);
    const shown = await speakers();
    const windows = (await js('__vo.speech()')).stats.windows;
    const steps = await js('__vo.steps()');
    await js(`(Cut.app.select([__vo.seq().clips.find((c) => c.track === 'V1').id]), true)`);
    await automation('Isolate Voice');
    await sleep(600);
    if (await js(`!!document.querySelector('#cutVoiceSetup')`)) await dialogButton('cutVoiceSetup', 'Download');
    await idle(30000);
    await until(`__vo.last() === 'Isolate Voice'`, 'the Isolate Voice step', 8000);
    const vocal = await js(`__vo.clips().find((c) => c.track === 'A1').media`);
    check(vocal !== ids[0], 'the audio clip plays the vocals');
    await until(`Cut.ui.transcript.words.length === ${words.length}`, 'the transcript after Isolate Voice', 8000).catch(() => {});
    const after = await js(`Cut.ui.transcript.words.map((w) => w.text + '@' + (w.t0 / ${T}).toFixed(2))`);
    check(S(after) === S(words), `the Transcript panel keeps every word and its time (${after.length} of ${words.length})`);
    check((await js('__vo.speech()')).stats.windows === windows, 'nothing is recognised again: the transcript carries over to the vocals');
    check(S(await speakers()) === S(shown), `the speaker paragraphs stay, with their names (${S(await speakers())})`);
    check(S(await js(`Cut.app.project.speakers.turns[${S(vocal)}]`)) === S(await js(`Cut.app.project.speakers.turns[${S(ids[0])}]`)) && S(await js('Cut.app.project.speakers.list.map((s) => s.id + s.name + s.color)')) === S(['sp1Ana#e05555', 'sp2Ben#3a7bd5']),
      'the vocals get the source\'s speaker turns; the speakers, their names and colours are the same');
    check(await js('__vo.steps()') === steps + 1, 'still one undo step');
    await clickAt(await js(`__vo.rect('.cut-panel[data-panel="program"]') || __vo.rect('.cut-stage')`));
    await key('Ctrl+Z');
    check((await js('__vo.clips()')).find((c) => c.track === 'A1').media === ids[0] && (await js(`Cut.app.project.speakers.turns[${S(vocal)}] === undefined`)) && (await js('__vo.media()')).length === 1, 'Ctrl+Z gives back the source, its media list and its speaker turns as they were');
    await until(`Cut.ui.transcript.words.length === ${words.length}`, 'the transcript after undo', 8000).catch(() => {});
    check(S(await js(`Cut.ui.transcript.words.map((w) => w.text + '@' + (w.t0 / ${T}).toFixed(2))`)) === S(words) && S(await speakers()) === S(shown), 'and the transcript with its speakers as before');
    await clickAt(await js(`__vo.rect('.cut-ws-tab[data-ws="editing"]')`));
  });
  await stop();
}

// ---------- the real backend with an empty Hugging Face cache: the model is missing ----------
if (want('missing')) {
  const empty = tempDir('cut-voice-hf');
  await start({ HF_HUB_CACHE: empty, PYIDE_WHISPER_BACKEND: 'fake' }, 'cut-voice-missing');
  await section('missing', async () => {
    const srcFile = P('src/miss.mp4');
    mkdirSync(P('src'), { recursive: true });
    await js(`__vo.src(${S(srcFile)}, { seconds: 4, w: 320, h: 180 })`);
    await js(`__vo.fresh([${S(srcFile)}], [{ file: 0, at: 0, len: 3 }])`);
    const st = await js('__vo.status()');
    check(st.backend === 'demucs' && st.model.installed === false, `pointed at an empty cache, the model is missing (${S(st.model)}, runtime ${st.runtime})`);
    const steps = await js('__vo.steps()');
    const had = wavs(media).length;
    await selectVideoClip();
    await automation('Isolate Voice');
    await until(`!!document.querySelector('#cutVoiceSetup')`, 'the setup dialog', 8000);
    const text = await js(`document.querySelector('#cutVoiceSetup').textContent`);
    check(text.includes(await js(`tr('{name} model: about {size}', { name: 'HTDemucs', size: Cut.ui.formatBytes(84e6) })`)), `it lists the model and its size (${text.slice(0, 200)})`);
    check(text.includes(await tr('Nothing is downloaded until you press Download. It is downloaded once; after that, voice isolation works offline.')), 'it says nothing is downloaded before Download');
    await dialogButton('cutVoiceSetup', 'Cancel');
    await until(`!document.querySelector('#cutVoiceSetup')`, 'the dialog closed', 4000);
    await sleep(300);
    check(listDir(empty).length === 0, 'Cancel downloads nothing (the empty cache stays empty)');
    check(await js('__vo.steps()') === steps && wavs(media).length === had && (await js('__vo.status()')).stats.setups === 0, 'Cancel changes nothing');
    await js(`ide.openSettings('cut')`);
    await until(`!!document.querySelector('.cut-voice-state')`, 'the Voice Isolation section', 8000);
    check(await js(`document.querySelector('.cut-voice-state').dataset.ready === 'false' && !document.querySelector('.cut-voice-download').hidden`), 'the settings page says it is not downloaded and offers Download…');
    await clickAt(await js(`__vo.rect('.cut-voice-download')`));
    await until(`!!document.querySelector('#cutVoiceSetup')`, 'Download… opens the setup dialog', 8000);
    await dialogButton('cutVoiceSetup', 'Cancel');
    check(listDir(empty).length === 0, 'and nothing is downloaded from there either');
    await clickAt(await js(`__vo.rect('#settingsCancel')`));
    await until(`!document.querySelector('.settings-dialog')`, 'the settings window closed', 8000);
  });
  await stop();
}

// ---------- the real model ----------
if (process.env.CUT_VOICE_REAL === '1' && want('real')) {
  await start({ PYIDE_WHISPER_BACKEND: 'fake' }, 'cut-voice-real');
  await section('real', async () => {
    const st = await js('__vo.status()');
    check(st.backend === 'demucs' && st.runtime && st.model.installed, `HTDemucs and its packages are on this PC (${S(st)})`);
    const srcFile = P('src/real.mp4');
    mkdirSync(P('src'), { recursive: true });
    await js(`__vo.src(${S(srcFile)}, { seconds: 10, w: 320, h: 180, beepEvery: 1 })`);
    const ids = await js(`__vo.fresh([${S(srcFile)}], [{ file: 0, at: 0, len: 9 }])`);
    await selectVideoClip();
    const t0 = Date.now();
    await automation('Isolate Voice');
    await idle(180000);
    const seconds = (Date.now() - t0) / 1000;
    await until(`__vo.last() === 'Isolate Voice'`, 'the Isolate Voice step', 8000);
    const list = await js('__vo.media()');
    const vocal = list.find((m) => m.id !== ids[0]);
    check(!!vocal && Math.abs(vocal.duration - list[0].duration) < 0.05, `the real model wrote a WAV of the media's length (${vocal?.duration} s)`);
    const loud = await js(`__vo.rms(${S(vocal.id)}, 0.5, 9.5)`);
    const orig = await js(`__vo.rms(${S(ids[0])}, 0.5, 9.5)`);
    check(loud < orig * 0.5, `the beeps are not a voice: the vocals are much quieter (RMS ${loud.toFixed(4)} vs ${orig.toFixed(4)})`);
    log(`real HTDemucs: 10 s of sound in ${seconds.toFixed(1)} s, the model load (${(await js('__vo.status()')).engine?.loadMs} ms) and the decoding included`);
  });
  await stop();
}

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`FAIL ${r.label}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
