// Nano Studio Cut's text AI (ui-ai.js, ai.js, main/cut/ai.js) in the real app against a stand-in Claude Code CLI
// (verify/fake-claude-cut.mjs through PYIDE_CLAUDE_PATH: canned answers chosen by the prompt, one of them wrong on
// purpose so the retry runs), reached the way a person does: the Automation menu, the captions panel's Claude button,
// Ctrl+J, real mouse events and keys. Never the real Claude. Checks:
// - the notice before the first request (Cancel sends nothing; Continue is remembered in the settings);
// - Polish Captions: the review list with the changes marked, one change unchecked, Apply as one undo step, the times
//   unchanged, Ctrl+Z; the captions panel's menu;
// - Translate Captions into Japanese: a new track, the same times, lines of at most 16 characters without spaces;
// - YouTube metadata: the chapters fixed (0:00 first, 10 s apart, inside the video), titles of 100 characters at most,
//   tags, Copy, Add as Chapter Markers (one undo step, the old chapter replaced); only text sent (no paths); without
//   captions, the offer to recognise the speech and the transcript's words sent (the fake Whisper backend);
// - Highlights to Shorts: the first (overlapping) answer refused and asked again, the review, a 1080x1920 sequence of
//   the chosen ranges in order with the captions and the video filling the frame; Ctrl+Z takes it away;
// - Edit Command (Ctrl+J): silences longer than 1 s ripple-deleted after the measured preview, the first 10 s cut, the
//   music 6 dB quieter, an unknown operation refused twice and shown as an error with nothing changed, an unknown field
//   refused once then fixed, a request with no edits; each applied plan one undo step;
// - Cancel in the progress box ends a slow request; a signed-out CLI and, in Korean, a missing one are explained;
// - the settings section; screenshots of the dialogs in the dark and the light theme (verify/out/cut-ai/*.png).
// Usage: node verify/cut-ai.mjs   (CUT_AI_ONLY=notice,polish,translate,metadata,transcript,highlights,command,cancel,settings,korean)
import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir, clickMenuPath } from './lib.mjs';

const ONLY = (process.env.CUT_AI_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = tempDir('cut-ai-home');
const fakeDir = tempDir('cut-ai-claude');
const fakeCmd = path.join(fakeDir, 'claude.cmd');
writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${path.join(APP, 'verify', 'fake-claude-cut.mjs')}" %*\r\n`);
writeFileSync(path.join(fakeDir, 'log.jsonl'), '');
const scenario = (s) => writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(s));
scenario({});
const calls = () => readFileSync(path.join(fakeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const env = { PYIDE_CUT_HOME: home, PYIDE_CLAUDE_PATH: fakeCmd, FAKE_CLAUDE_DIR: fakeDir, PYIDE_WHISPER_BACKEND: 'fake' };
let ctx = await launch({ fixture: 'core', port: 9779, name: 'cut-ai', mode: 'cut', env });
const first = ctx;
let { js, until, check, cdp, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const P = (name) => path.join(home, name);

// ---------- page helpers ----------
async function boot() {
  await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
  await js('Cut.loaded');
  await until('window.__cutReady === true', 'the editor started', 30000);
  await js(`(() => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const H = (window.__ai = {});
    H.seq = () => Cut.app.sequence;
    // a project of these files and clips, with caption items [[start, end, text]] (seconds) on one track
    H.fresh = async (files, clips, caps = null, roles = {}) => {
      const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
      const h = C.createHistory(p);
      const list = await Cut.media.importFiles(files);
      const bad = list.filter((m) => m.error);
      if (bad.length) throw new Error(JSON.stringify(bad));
      const ids = h.do(C.importMedia(list)).ids;
      const seq = h.project.sequences[0];
      for (const c of clips) {
        const m = h.project.media.find((x) => x.id === ids[c.file]);
        const vid = m.kind === 'video' || m.kind === 'image';
        const r = h.do(C.place(seq.id, { source: { media: ids[c.file] }, in: 0, out: c.len * T, at: c.at * T,
          video: vid ? 'V1' : null, audio: m.audio ? (c.track || 'A1') : null, mode: 'overwrite' }));
        if (c.role) h.do(C.setRole(seq.id, r.ids, c.role));
      }
      if (caps) h.do(C.addCaptionTrack(seq.id, { name: 'Captions', lang: 'ko', items: caps.map(([a, b, text]) => ({ start: a * T, end: b * T, text })) }));
      Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
      Cut.app.select([]);
      Cut.app.setTime(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return ids;
    };
    H.clips = (track) => H.seq().clips.filter((c) => !track || c.track === track).map((c) => ({ id: c.id, track: c.track, start: c.start / T, end: Cut.model.clipEnd(c) / T, volume: c.props.volume, scale: c.props.scale, position: c.props.position }))
      .sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
    H.length = (track) => H.clips(track).reduce((n, c) => n + (c.end - c.start), 0);
    H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
    H.last = () => Cut.app.history.list().filter((x) => x.done).at(-1)?.label;
    H.caps = () => (H.seq().captions || []).map((t) => ({ name: t.name, lang: t.lang, items: t.items.map((it) => ({ start: it.start / T, end: it.end / T, text: it.text })) }));
    H.markers = () => H.seq().markers.map((m) => ({ t: m.t / T, kind: m.kind, name: m.name }));
    H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
    H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; };
    H.text = (sel) => document.querySelector(sel)?.textContent ?? null;
    H.json = () => Cut.app.history.serialize();
    return true;
  })()`);
}
await boot();
check(await js(`!!Cut.ai?.validatePlan && !!Cut.ui.ai?.editCommand && !!Cut.ui.auto?.silencePlan && ide.actions.some((a) => a.id === 'Cut.auto.aiCommand' && (a.keys || []).includes('Ctrl+J'))`),
  'the text AI modules are loaded and Edit Command has Ctrl+J');

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, modifiers = 0, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { modifiers = 0 } = {}) {
  if (!p) throw new Error('nothing to click');
  await mouse('mouseMoved', p.x, p.y, { buttons: 0, modifiers });
  await mouse('mousePressed', p.x, p.y, { modifiers });
  await mouse('mouseReleased', p.x, p.y, { modifiers });
  await sleep(120);
}
const KEYS = { Delete: ['Delete', 'Delete', 46], Escape: ['Escape', 'Escape', 27], Enter: ['Enter', 'Enter', 13] };
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
const tr = (s, p) => js(`tr(${S(s)}${p ? `, ${S(p)}` : ''})`);
async function automation(label) {
  await clickAt(await js(`__ai.rect('.cut-topbar .cut-auto-btn')`));
  await clickMenuPath(ctx, [await tr(label)]);
  await sleep(150);
}
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__ai.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 15000);
  await clickAt(await js(`__ai.button('#${id}', ${S(name)})`));
}
const idle = (ms = 60000) => until('!Cut.ui.auto.running && !document.querySelector(".cut-auto-task")', 'the Claude request to end', ms);
const editor = async () => clickAt(await js(`__ai.rect('.cut-panel[data-panel="program"] canvas') || __ai.rect('.cut-panel[data-panel="program"]')`));
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await js(`ide.ui.closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()); Cut.ui.auto.cancel(); true`).catch(() => {});
  await idle(20000).catch(() => {});
  scenario({});
  await sleep(200);
}
async function themes(name, fn) {
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${S(theme)})`);
    await until(`document.documentElement.dataset.theme === ${S(theme)}`, `the ${theme} theme`, 5000).catch(() => {});
    await sleep(250);
    if (fn) await fn(theme);
    log(`  saved ${await ctx.shot(`ai-${name}-${theme}.png`)}`);
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);
}
// 16-bit stereo WAV with bursts of a 440 Hz tone at [from, to] seconds.
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

// A 320x180 PNG of one colour (no video encoder needed, so the suite also runs on the CI runner).
function png(file, w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(Buffer.from(type, 'latin1'))), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// The media: a picture and 60 s of talk for the captioned sequence, a 20 s voice WAV with two long pauses and a 20 s
// music WAV for the edit commands.
const PICTURE = P('picture.png');
png(PICTURE, 320, 180, [40, 90, 160]);
const TALK = P('talk.wav');
wav(TALK, 60, [[0, 60]]);
const VOICE = P('voice.wav');
wav(VOICE, 20, [[0, 3], [5.5, 8], [12, 20]]);
const WORDS = P('words.wav');
wav(WORDS, 7, Array.from({ length: 12 }, (_, k) => [k * 0.5, k * 0.5 + 0.3]));
const SONG = P('song.wav');
wav(SONG, 20, [[0, 20]]);
const CAPS = [[0, 2.5, '안녕  하세요'], [3, 5.5, '잘 됬어요'], [6, 8, '편집이 쉬워요.'], [21, 24, 'teh end'], [40, 43, '마지막 자막입니다.']];
const freshTalk = () => js(`__ai.fresh([${S(PICTURE)}, ${S(TALK)}], [{ file: 0, at: 0, len: 60 }, { file: 1, at: 0, len: 60 }], ${S(CAPS)})`);

// ---------- the notice ----------
await section('notice', async () => {
  await freshTalk();
  check((await js(`ide.settings.get('cut.ai.acknowledged', false)`)) === false, 'at first the notice has not been acknowledged');
  await automation('Polish Captions with Claude…');
  await dialogButton('cutAiPolish', 'Polish');
  await until(`!!document.querySelector('#cutAiNotice')`, 'the notice before the first request');
  const text = await js(`__ai.text('#cutAiNotice')`);
  check(/Claude \(Anthropic\)/.test(text) && /No video, sound or file paths are sent/.test(text), `the notice says what goes to Claude (${text.slice(0, 120)}…)`);
  await dialogButton('cutAiNotice', 'Cancel');
  await sleep(300);
  check(calls().length === 0 && !(await js(`!!document.querySelector('.cut-auto-task')`)) && (await js(`ide.settings.get('cut.ai.acknowledged', false)`)) === false, 'Cancel: nothing sent, nothing remembered');
  await automation('Polish Captions with Claude…');
  await dialogButton('cutAiPolish', 'Polish');
  await until(`!!document.querySelector('#cutAiNotice')`, 'the notice again');
  await themes('notice');
  await dialogButton('cutAiNotice', 'Continue');
  await until(`!!document.querySelector('#cutAiPolishReview')`, 'the review after Continue', 30000);
  check((await js(`ide.settings.get('cut.ai.acknowledged', false)`)) === true && calls().length === 1, 'Continue: the acknowledgement is kept in the settings and the request goes out');
});

// ---------- polish ----------
await section('polish', async () => {
  if (!(await js(`!!document.querySelector('#cutAiPolishReview')`))) {
    await freshTalk();
    await automation('Polish Captions with Claude…');
    await dialogButton('cutAiPolish', 'Polish');
    await until(`!!document.querySelector('#cutAiPolishReview')`, 'the review', 30000);
  }
  check(!(await js(`!!document.querySelector('#cutAiNotice')`)), 'no notice once it was acknowledged');
  const sent = calls().filter((c) => c.task === 'polish captions').at(-1);
  check(sent && sent.stdin.includes('안녕  하세요') && sent.stdin.includes('teh end') && !sent.stdin.includes(home) && !/picture|talk\.wav/.test(sent.stdin), 'only the caption text is sent: no path or file name');
  const rows = await js(`[...document.querySelectorAll('#cutAiPolishReview .cut-ai-row')].map((r) => ({ before: r.querySelector('.cut-ai-before').textContent, after: r.querySelector('.cut-ai-after').textContent, del: r.querySelectorAll('del').length, ins: r.querySelectorAll('ins').length }))`);
  check(rows.length === 3 && !rows.some((r) => r.before === '편집이 쉬워요.' || r.before === '마지막 자막입니다.'), `the review lists the three changed captions, not those already right (${rows.length})`);
  check(rows[0].before === '안녕  하세요' && rows[0].after === '안녕 하세요.' && rows[0].del === 1 && rows[0].ins === 1, `the space taken out and the full stop added are marked (${S(rows[0])})`);
  await themes('polish');
  // uncheck the third change ("teh end")
  const steps0 = await js('__ai.steps()');
  await clickAt(await js(`__ai.rect(document.querySelectorAll('#cutAiPolishReview .cut-ai-check')[2])`));
  check((await js(`document.querySelector('#cutAiPolishReview .cut-ai-count').dataset.chosen`)) === '2', 'unchecking one leaves two chosen');
  const times0 = (await js('__ai.caps()'))[0].items.map((it) => [it.start, it.end]);
  await dialogButton('cutAiPolishReview', 'Apply');
  await sleep(200);
  const items = (await js('__ai.caps()'))[0].items;
  eq(items.map((it) => it.text), ['안녕 하세요.', '잘 됐어요.', '편집이 쉬워요.', 'teh end', '마지막 자막입니다.'], 'the chosen changes are applied, the unchecked one is not');
  check(S(items.map((it) => [it.start, it.end])) === S(times0), 'the times do not change');
  check((await js('__ai.steps()')) === steps0 + 1 && (await js('__ai.last()')) === 'Polish Captions', 'one undo step named Polish Captions');
  await editor();
  await key('Ctrl+Z');
  check((await js('__ai.caps()'))[0].items[0].text === '안녕  하세요', 'Ctrl+Z puts the captions back');
  // the captions panel's Claude menu
  await clickAt(await js(`__ai.rect('.cut-ws-tab[data-ws="captions"]')`));
  await until(`!!__ai.rect('.cut-panel[data-panel="captions"] .cut-cap-ai')?.w`, 'the Claude button in the captions panel');
  await clickAt(await js(`__ai.rect('.cut-panel[data-panel="captions"] .cut-cap-ai')`));
  await clickMenuPath(ctx, [await tr('Polish Captions with Claude…')]);
  await until(`!!document.querySelector('#cutAiPolish')`, 'the polish dialog from the captions panel');
  check(true, 'the captions panel opens Polish Captions');
  await dialogButton('cutAiPolish', 'Cancel');
  await clickAt(await js(`__ai.rect('.cut-ws-tab[data-ws="editing"]')`));
});
function eq(got, wantV, label) { check(S(got) === S(wantV), `${label}${S(got) === S(wantV) ? '' : ` (got ${S(got)}, want ${S(wantV)})`}`); }

// ---------- translate ----------
await section('translate', async () => {
  await freshTalk();
  await js(`ide.settings.set('cut.ai.acknowledged', true)`);
  await automation('Translate Captions with Claude…');
  await until(`!!document.querySelector('#cutAiTranslate .cut-ai-lang')`, 'the translate dialog');
  check((await js(`document.querySelector('#cutAiTranslate .cut-ai-lang').value`)) === 'en' && (await js(`[...document.querySelector('#cutAiTranslate .cut-ai-lang').options].map((o) => o.value).join()`)) === 'ko,en,ja,zh,es',
    'Korean captions default to English; the languages are ko, en, ja, zh, es');
  await js(`(() => { const s = document.querySelector('#cutAiTranslate .cut-ai-lang'); s.value = 'ja'; s.dispatchEvent(new Event('change')); return true; })()`);
  const steps0 = await js('__ai.steps()');
  await dialogButton('cutAiTranslate', 'Translate');
  await until(`__ai.caps().length === 2`, 'the translated track', 30000);
  await idle();
  const [src, ja] = await js('__ai.caps()');
  check(ja.lang === 'ja' && ja.name === `Captions (${await tr('Japanese')})`, `a new Japanese track (${ja.name})`);
  check(S(ja.items.map((it) => [it.start, it.end])) === S(src.items.map((it) => [it.start, it.end])), 'with the same times');
  const lines = ja.items.flatMap((it) => it.text.split('\n'));
  check(ja.items.every((it) => it.text.split('\n').length === 2) && lines.every((l) => [...l].length <= 16 && !/\s/.test(l)), `lines broken for Japanese: two of at most 16 characters, no spaces (${S(ja.items[0].text)})`);
  check(ja.items[0].text.replace('\n', '') === '字幕1番の日本語訳です。行の長さを試すために少し長くしています。', 'nothing of the translation lost');
  check(S(src.items.map((it) => it.text)) === S(CAPS.map((c) => c[2])), 'the source track is unchanged');
  check((await js('__ai.steps()')) === steps0 + 1 && (await js('__ai.last()')) === 'Translate Captions', 'one undo step');
  await editor();
  await key('Ctrl+Z');
  check((await js('__ai.caps().length')) === 1, 'Ctrl+Z takes the new track away');
});

// ---------- YouTube metadata ----------
await section('metadata', async () => {
  await freshTalk();
  await js(`(ide.settings.set('cut.ai.acknowledged', true), Cut.app.history.do(Cut.commands.addMarker(__ai.seq().id, { t: 50 * ${T}, name: 'Old', kind: 'chapter' })), true)`);
  const n0 = calls().length;
  await automation('YouTube Title, Description and Chapters…');
  await until(`!!document.querySelector('#cutAiMetadata')`, 'the metadata dialog', 30000);
  const sent = calls().slice(n0);
  check(sent.length === 1 && sent[0].stdin.includes('[0.0-2.5] 안녕 하세요') && sent[0].stdin.includes('50.0 chapter "Old"') && !sent[0].stdin.includes(home), 'the caption text and the markers are sent, no path');
  const d = await js(`(() => { const q = (s) => document.querySelector('#cutAiMetadata ' + s); return {
    titles: [...document.querySelectorAll('#cutAiMetadata .cut-ai-title')].map((n) => n.textContent), chapters: q('.cut-ai-chapters').textContent,
    fixed: q('.cut-ai-fixed').textContent, tags: q('.cut-ai-tags').textContent, desc: q('.cut-ai-description').value, source: q('.cut-ai-source').textContent }; })()`);
  check(d.titles.length === 3 && d.titles.every((t) => [...t].length <= 100), `three titles of at most 100 characters (${d.titles.map((t) => [...t].length)})`);
  eq(d.chapters, '0:00 시작\n0:20 자막\n0:36 편집', 'the chapters fixed for YouTube: 0:00 first, the one 4 s later and the one past the end left out');
  check(/0:00/.test(d.fixed) && d.tags === '자막, 편집, Nano Studio, Cut' && d.desc.startsWith('오늘은'), `the fixes are noted; tags without # or duplicates (${d.tags})`);
  check(/captions/.test(d.source), 'it says it was made from the captions');
  await themes('metadata');
  // copy
  const clip0 = await js(`ide.api.invoke('clipboard:readText')`);
  await clickAt(await js(`__ai.rect('#cutAiMetadata .cut-ai-copy-chapters')`));
  await sleep(200);
  check((await js(`ide.api.invoke('clipboard:readText')`)) === '0:00 시작\n0:20 자막\n0:36 편집', 'Copy puts the chapter lines on the clipboard');
  await clickAt(await js(`__ai.rect('#cutAiMetadata .cut-ai-copy-all')`));
  await sleep(200);
  const all = await js(`ide.api.invoke('clipboard:readText')`);
  check(all.startsWith('오늘은') && all.endsWith('0:00 시작\n0:20 자막\n0:36 편집'), 'Copy with Chapters: the description, then the chapters');
  await js(`ide.api.invoke('clipboard:writeText', ${S(clip0 || '')})`);
  // chapters as markers
  const steps0 = await js('__ai.steps()');
  await clickAt(await js(`__ai.rect('#cutAiMetadata .cut-ai-add-chapters')`));
  await sleep(200);
  eq(await js('__ai.markers()'), [{ t: 0, kind: 'chapter', name: '시작' }, { t: 20, kind: 'chapter', name: '자막' }, { t: 36, kind: 'chapter', name: '편집' }], 'the chapters become chapter markers, replacing the old one');
  check((await js('__ai.steps()')) === steps0 + 1 && (await js('__ai.last()')) === 'Add Chapter Markers', 'one undo step');
  await dialogButton('cutAiMetadata', 'Close');
  await editor();
  await key('Ctrl+Z');
  eq(await js('__ai.markers()'), [{ t: 50, kind: 'chapter', name: 'Old' }], 'Ctrl+Z puts the old chapter back');
});

// ---------- the words from the speech (ui-speech.js transcripts) ----------
await section('transcript', async () => {
  // a 7 s WAV with a word every half second (the fake recogniser hears one per burst), no captions
  await js(`__ai.fresh([${S(WORDS)}], [{ file: 0, at: 0, len: 7 }])`);
  await js(`(ide.settings.set('cut.ai.acknowledged', true), true)`);
  const n0 = calls().length;
  await automation('YouTube Title, Description and Chapters…');
  await until(`!!document.querySelector('.dialog-backdrop .dialog-message')`, 'the offer to recognise the speech first');
  check(/Recognize its speech on this PC first/.test(await js(`__ai.text('.dialog-backdrop .dialog-message')`)), 'without captions or a transcript it offers to recognise the speech on this PC');
  await clickAt(await js(`__ai.button('.dialog-backdrop', ${S(await tr('Transcribe'))})`));
  await until(`!!document.querySelector('#cutAiMetadata')`, 'the metadata from the transcript', 60000);
  const sent = calls().slice(n0);
  check(sent.length === 1 && /\[0\.0-[\d.]+\] 안녕하세요 음 오늘은 자막을/.test(sent[0].stdin), `the transcript's words are sent as timed lines (${sent[0]?.stdin.split('\n').find((l) => l.startsWith('[0.0'))})`);
  check(/transcript/.test(await js(`__ai.text('#cutAiMetadata .cut-ai-source')`)), 'it says it was made from the transcript');
  check(/at least 30 seconds/.test(await js(`__ai.text('#cutAiMetadata .cut-ai-chapters')`)) && !(await js(`!!document.querySelector('#cutAiMetadata .cut-ai-add-chapters')`)), 'a 7 s video gets no chapters, and says why');
  await dialogButton('cutAiMetadata', 'Close');
  check(await js(`!document.querySelector('.dialog-backdrop')`), 'Close closes it');
});

// ---------- highlights to shorts ----------
await section('highlights', async () => {
  await freshTalk();
  await js(`ide.settings.set('cut.ai.acknowledged', true)`);
  const n0 = calls().length;
  const seqs0 = await js('Cut.app.project.sequences.length');
  const src = await js('Cut.app.sequenceId');
  await automation('Highlights to Shorts…');
  await until(`!!document.querySelector('#cutAiHighlights')`, 'the highlights dialog');
  await dialogButton('cutAiHighlights', 'Find Highlights');
  await until(`!!document.querySelector('#cutAiHighlightsReview')`, 'the review of the highlights', 30000);
  const sent = calls().slice(n0);
  check(sent.length === 2 && !sent[0].retry && sent[1].retry && /overlap/.test(sent[1].stdin), `the overlapping first answer was refused and Claude asked again with the reason (${sent.length} calls)`);
  const rows = await js(`[...document.querySelectorAll('#cutAiHighlightsReview .cut-ai-row')].map((r) => r.querySelector('.cut-ai-title').textContent)`);
  eq(rows, ['장면 1', '장면 2', '장면 3'], 'three highlights for review');
  await themes('highlights');
  await clickAt(await js(`__ai.rect(document.querySelectorAll('#cutAiHighlightsReview .cut-ai-check')[1])`));
  check((await js(`document.querySelector('#cutAiHighlightsReview .cut-ai-count').dataset.chosen`)) === '2', 'the second one unchecked');
  const steps0 = await js('__ai.steps()');
  await dialogButton('cutAiHighlightsReview', 'Create Shorts Sequence');
  await sleep(300);
  const s = await js(`(() => { const s = __ai.seq(); return { id: s.id, w: s.w, h: s.h, fps: s.fps, n: Cut.app.project.sequences.length, name: s.name }; })()`);
  check(s.id !== src && s.w === 1080 && s.h === 1920 && S(s.fps) === '[30,1]' && s.n === seqs0 + 1, `a new 1080x1920 sequence at the same frame rate, now open (${S(s)})`);
  const v = await js(`__ai.clips('V1')`);
  // the ranges 1-17 s and 39-55 s, in order, end to end
  check(v.length === 2 && Math.abs(v[0].start) < 1e-6 && Math.abs(v[0].end - 16) < 0.04 && Math.abs(v[1].start - v[0].end) < 1e-6 && Math.abs(v[1].end - 32) < 0.04, `the two chosen ranges in order (${S(v.map((c) => [c.start, c.end]))})`);
  const k = Math.max(1080 / 320, 1920 / 180) / Math.min(1080 / 320, 1920 / 180);
  check(v.every((c) => Math.abs(c.scale[0] - 100 * k) < 0.1 && S(c.position) === '[0,0]'), `the picture fills the frame, centered (scale ${v[0].scale[0]})`);
  const a = await js(`__ai.clips('A1')`);
  check(a.length === 2 && Math.abs(a[1].end - 32) < 0.04, 'the sound is cut the same way');
  const caps = (await js('__ai.caps()'))[0].items;
  eq(caps.map((it) => [Math.round(it.start * 10) / 10, Math.round(it.end * 10) / 10, it.text]), [[0, 1.5, '안녕  하세요'], [2, 4.5, '잘 됬어요'], [5, 7, '편집이 쉬워요.'], [17, 20, '마지막 자막입니다.']],
    'the captions inside the ranges came along, moved with them (the one in the unchosen range left out)');
  check((await js('__ai.steps()')) === steps0 + 1 && (await js('__ai.last()')) === 'Create Shorts Sequence', 'one undo step');
  await editor();
  await key('Ctrl+Z');
  check((await js('Cut.app.project.sequences.length')) === seqs0 && (await js('Cut.app.sequenceId')) === src, 'Ctrl+Z takes the shorts sequence away and shows the original again');
});

// ---------- edit commands ----------
async function command(text) {
  await editor();
  await key('Ctrl+J');
  await until(`!!document.querySelector('#cutAiCommand .cut-ai-command-input')`, 'the command box from Ctrl+J');
  await js(`(() => { const n = document.querySelector('#cutAiCommand .cut-ai-command-input'); n.value = ''; return true; })()`);
  await clickAt(await js(`__ai.rect('#cutAiCommand .cut-ai-command-input')`));
  await ctx.type(text);
  await key('Enter');
}
await section('command', async () => {
  await js(`__ai.fresh([${S(VOICE)}, ${S(SONG)}], [{ file: 0, at: 0, len: 20 }, { file: 1, at: 0, len: 20, track: 'A2', role: 'music' }])`);
  await js(`(ide.settings.set('cut.ai.acknowledged', true), Cut.app.history.do(Cut.commands.setTrack(__ai.seq().id, 'A2', { syncLock: false })), true)`);
  // silences
  const a0 = await js(`__ai.length('A1')`);
  const steps0 = await js('__ai.steps()');
  await command('remove all silences longer than 1 s');
  await until(`!!document.querySelector('#cutAiPlan .cut-ai-step')`, 'the plan preview', 60000);
  const step = await js(`__ai.text('#cutAiPlan .cut-ai-step')`);
  check(/^Remove silences longer than 1 s quieter than -40 dB \(2 cuts, 6\.[0-2] s\)$/.test(step), `the preview says what will go, measured on this PC, the music not counted (${step})`);
  const overlay = await js(`(Cut.ui.timeline.overlay?.ranges || []).map(([a, b]) => [a / ${T}, b / ${T}])`);
  check(overlay.length === 2 && overlay[0][0] > 3 && overlay[0][1] < 5.5 && overlay[1][0] > 8 && overlay[1][1] < 12, `the timeline shows what will go (${S(overlay)})`);
  await themes('plan');
  check((await js('__ai.steps()')) === steps0, 'nothing changes before Apply');
  await dialogButton('cutAiPlan', 'Apply');
  await sleep(200);
  const a1 = await js(`__ai.length('A1')`);
  check(Math.abs(a0 - a1 - 6.1) < 0.1 && Math.abs((await js(`__ai.length('A2')`)) - 20) < 1e-6, `the two long pauses are ripple-deleted from the voice (${(a0 - a1).toFixed(2)} s), the music track without sync lock is untouched`);
  check((await js('__ai.steps()')) === steps0 + 1 && (await js('__ai.last()')) === 'Edit Command' && (await js('Cut.ui.timeline.overlay')) === null, 'one undo step named Edit Command, and the overlay is gone');
  await editor();
  await key('Ctrl+Z');
  check(Math.abs((await js(`__ai.length('A1')`)) - a0) < 1e-6, 'Ctrl+Z puts them back');
  // the first 10 seconds
  await command('cut the first 10 seconds');
  await until(`!!document.querySelector('#cutAiPlan .cut-ai-step')`, 'the cut plan', 30000);
  check((await js(`__ai.text('#cutAiPlan .cut-ai-step')`)) === await tr('Cut {from} – {to} ({len} s) from every track', { from: '0:00.0', to: '0:10.0', len: '10.0' }), 'the preview reads as a sentence');
  await dialogButton('cutAiPlan', 'Apply');
  await sleep(200);
  check(Math.abs((await js(`__ai.length('A1')`)) - 10) < 1e-6 && Math.abs((await js(`__ai.length('A2')`)) - 10) < 1e-6, 'the first 10 s are gone from every track');
  await editor();
  await key('Ctrl+Z');
  // the music
  await command('make the music 6 dB quieter');
  await until(`!!document.querySelector('#cutAiPlan .cut-ai-step')`, 'the volume plan', 30000);
  await dialogButton('cutAiPlan', 'Apply');
  await sleep(200);
  check(S((await js(`__ai.clips('A2')`)).map((c) => c.volume)) === '[-6]' && S((await js(`__ai.clips('A1')`)).map((c) => c.volume)) === '[0]', 'the music clip is 6 dB quieter, the voice is not');
  await editor();
  await key('Ctrl+Z');
  // refused: an operation outside the whitelist, twice
  const json0 = await js('__ai.json()');
  const n0 = calls().length;
  await command('delete the project');
  await until(`!!document.querySelector('#cutAiError')`, 'the error', 30000);
  const err = await js(`({ text: __ai.text('#cutAiError'), code: document.querySelector('#cutAiError .cut-ai-error').dataset.code })`);
  check(err.code === 'invalid' && /deleteProject/.test(err.text) && /not an allowed operation/.test(err.text) && /Nothing was changed/.test(err.text), `an operation outside the whitelist is refused, asked again, then shown as an error (${err.text.slice(0, 140)})`);
  check(calls().length - n0 === 2 && calls().at(-1).retry, 'Claude was asked twice');
  check((await js('__ai.json()')) === json0 && !(await js(`!!document.querySelector('#cutAiPlan')`)), 'nothing changed, no plan shown');
  await dialogButton('cutAiError', 'OK');
  // refused once, then fixed
  await command('cut with an extra field');
  await until(`!!document.querySelector('#cutAiPlan .cut-ai-step')`, 'the plan after the retry', 30000);
  check(calls().at(-1).retry && /unknown field "speed"/.test(calls().at(-1).stdin), 'an unknown field is refused and fixed on the retry');
  await dialogButton('cutAiPlan', 'Cancel');
  check((await js('__ai.json()')) === json0, 'Cancel changes nothing');
  // no edits
  await command('hello there');
  await until(`!!document.querySelector('#cutAiPlan .cut-ai-message')`, 'the answer without edits', 30000);
  check((await js(`__ai.text('#cutAiPlan .cut-ai-message')`)) === 'Nothing to edit for that.', 'a request without edits shows Claude\'s note');
  await dialogButton('cutAiPlan', 'OK');
  // the shortcut list knows the key
  check(await js(`ide.actions.find((a) => a.id === 'Cut.auto.aiCommand').title === tr('Edit Command…') && Cut.ui.keys.kindOf('auto.aiCommand') === 'automation'`), 'Edit Command is in the shortcut list under Automation');
});

// ---------- cancel, signed out ----------
await section('cancel', async () => {
  await freshTalk();
  await js(`ide.settings.set('cut.ai.acknowledged', true)`);
  scenario({ delayMs: 30000 });
  const json0 = await js('__ai.json()');
  await automation('Polish Captions with Claude…');
  await dialogButton('cutAiPolish', 'Polish');
  await until(`!!document.querySelector('.cut-auto-task')`, 'the progress box');
  await until(`/Waiting for Claude/.test(document.querySelector('.cut-auto-task-text')?.textContent || '')`, 'the waiting line', 10000);
  await sleep(800);
  const pid = calls().at(-1).pid;
  const t0 = Date.now();
  await clickAt(await js(`__ai.rect('.cut-auto-task-cancel')`));
  await idle(10000);
  check(Date.now() - t0 < 6000 && (await js('__ai.json()')) === json0 && !(await js(`!!document.querySelector('#cutAiPolishReview')`)), `Cancel ends the request at once and changes nothing (${Date.now() - t0} ms)`);
  await sleep(1500);
  check(!alive(pid), 'the CLI process is gone');
  scenario({ error: 'Not logged in · Please run /login' });
  await automation('Polish Captions with Claude…');
  await dialogButton('cutAiPolish', 'Polish');
  await until(`!!document.querySelector('#cutAiMissing')`, 'the sign-in explanation', 30000);
  const m = await js(`({ code: document.querySelector('#cutAiMissing .cut-ai-missing').dataset.code, text: __ai.text('#cutAiMissing') })`);
  check(m.code === 'auth' && /not signed in/.test(m.text) && /run claude/.test(m.text), `a signed-out Claude Code is explained (${m.text.slice(0, 100)})`);
  check((await js('__ai.json()')) === json0, 'and nothing changed');
});

// ---------- settings ----------
await section('settings', async () => {
  await js(`(ide.openSettings('cut'), true)`);
  await until(`!!document.querySelector('.cut-ai-state[data-installed]')`, 'the Claude section', 10000);
  const st = await js(`({ options: [...(document.querySelector('select[data-key="cut.ai.model"]')?.options || [])].map((o) => o.value), value: document.querySelector('select[data-key="cut.ai.model"]')?.value, installed: document.querySelector('.cut-ai-state').dataset.installed, ack: document.querySelector('input[data-key="cut.ai.acknowledged"]')?.checked ?? null })`);
  check(st.installed === 'true' && S(st.options) === S(['haiku', 'sonnet', 'opus']) && st.value === 'sonnet', `the settings page's Claude section: the model and that Claude Code is found (${S(st)})`);
  await js(`document.querySelector('.dialog-backdrop .dialog-buttons .secondary')?.click(), true`);
});

// ---------- Korean, no Claude Code ----------
await section('korean', async () => {
  first.close();
  await sleep(1500);
  ctx = await launch({ fixture: 'core', port: 9779, name: 'cut-ai-ko', mode: 'cut', lang: 'ko-KR', env: { ...env, PYIDE_CLAUDE_PATH: 'none' } });
  ({ js, until, check, cdp, sleep } = ctx);
  await boot();
  await freshTalk();
  const n0 = calls().length;
  await editor();
  await key('Ctrl+J');
  await until(`!!document.querySelector('#cutAiCommand .cut-ai-command-input')`, 'the command box');
  await clickAt(await js(`__ai.rect('#cutAiCommand .cut-ai-command-input')`));
  await ctx.type('처음 10초를 잘라 내');
  await key('Enter');
  await until(`!!document.querySelector('#cutAiNotice')`, 'the notice in Korean');
  const notice = await js(`__ai.text('#cutAiNotice')`);
  check(/Claude\(Anthropic\)/.test(notice) && /파일 경로는 보내지 않습니다/.test(notice), `the notice is in Korean (${notice.slice(0, 80)}…)`);
  await dialogButton('cutAiNotice', 'Continue');
  await until(`!!document.querySelector('#cutAiMissing')`, 'the missing Claude Code explanation');
  const m = await js(`({ code: document.querySelector('#cutAiMissing .cut-ai-missing').dataset.code, text: __ai.text('#cutAiMissing') })`);
  check(m.code === 'not-installed' && /이 PC에 Claude Code가 설치되어 있지 않습니다/.test(m.text) && /claude\.com\/claude-code/.test(m.text) && /로그인/.test(m.text), `a missing Claude Code is explained in plain Korean (${m.text.slice(0, 120)}…)`);
  check(calls().length === n0, 'nothing was run');
  await themes('missing-ko');
});

// finish() counts only its own ctx: the first window's results join the second's.
if (ctx !== first) {
  ctx.results.unshift(...first.results);
  ctx.consoleErrors.unshift(...first.consoleErrors);
  ctx.cspViolations.unshift(...first.cspViolations);
}
ctx.finish();
