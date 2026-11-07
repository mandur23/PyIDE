// Nano Studio Cut's speaker labels (ui-speakers.js, speakers.js, main/cut/speakers.js) in the real app with the fake
// backends (PYIDE_WHISPER_BACKEND=fake: one word per burst of sound; PYIDE_SPEAKERS_BACKEND=fake: a window's
// embedding is its energy at 24 frequencies, so tones of different pitch are different speakers), reached the way a
// person does: the Transcript panel, the Automation menu, the Auto Captions and Caption Style dialogs, with real mouse
// events and keys. The sound is a WAV of tone bursts: "A" at 300 Hz, "B" at 1500 Hz, "C" at 800 Hz.
// Checks:
// - labels: Label Speakers finds the three speakers (Auto); the transcript's paragraphs break where the speaker
//   changes, each with its speaker's name and color; every word has its speaker; one undo step;
// - rename: double-clicking a speaker's chip, the name in the chips and the paragraphs; undo and redo;
// - a fixed count: 2 speakers labels again without recognising or embedding again (from the cache), then Auto gives
//   three again and the renamed speaker keeps its name;
// - the row's count per project: a count chosen before labelling stays for that project, another project (labelled
//   before or not) starts at Auto and labels with Auto;
// - select by speaker: a chip selects all that speaker's words (and only those); Escape clears it;
// - reassign: a paragraph's label menu, Change Speaker, one undo step, and undo;
// - captions: Auto Captions with "Speaker colors and names" makes captions that each hold one speaker, the compositor
//   draws them in their speaker's color (pixels), SRT text gets the names, the Caption Style dialog turns them off;
// - save and reload: the labels, the names and the captions' speakers come back with the project;
// - the missing model (an empty Hugging Face cache, the real backend): the setup dialog with its size and "on this
//   PC", nothing downloaded, Cancel labels nothing; a failed pretend download explained in Korean;
// - screenshots of the panel in the dark and the light theme (verify/out/cut-speakers/*.png).
// Usage: node verify/cut-speakers.mjs   (CUT_SPEAKERS_ONLY=labels,rename,count,select,reassign,captions,reload,shots,new project,missing,korean)
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir, clickMenuPath } from './lib.mjs';

const ONLY = (process.env.CUT_SPEAKERS_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const home = tempDir('cut-speakers-home');
const dialogFile = path.join(home, 'dialog.json');
const answer = (v) => writeFileSync(dialogFile, JSON.stringify(v));
answer({});
const env = { PYIDE_CUT_HOME: home, PYIDE_CUT_DIALOG: dialogFile, PYIDE_WHISPER_BACKEND: 'fake', PYIDE_SPEAKERS_BACKEND: 'fake' };
let ctx = await launch({ fixture: 'core', port: 9766, name: 'cut-speakers', mode: 'cut', env });
const runs = [ctx];
let { js, until, check, cdp, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const P = (name) => path.join(home, name);

// The speakers of the WAV: [first word, words, Hz]; words every 0.5 s, 0.35 s long.
const PLAN = [['A', 0, 7, 300], ['B', 4.5, 6, 1500], ['C', 8.5, 6, 800], ['A', 12.5, 4, 300], ['B', 15.5, 4, 1500]];
const expected = PLAN.flatMap(([who, at, n]) => Array.from({ length: n }, () => who));
function wav(file, seconds, rate = 48000) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (const [, at, count, hz] of PLAN) {
    for (let k = 0; k < count; k++) {
      const a = Math.round((at + k * 0.5) * rate);
      for (let i = a; i < Math.min(n, a + Math.round(0.35 * rate)); i++) {
        const v = Math.round(0.3 * Math.sin((2 * Math.PI * hz * i) / rate) * 32767);
        buf.writeInt16LE(v, 44 + i * 4);
        buf.writeInt16LE(v, 46 + i * 4);
      }
    }
  }
  writeFileSync(file, buf);
}
const TALK = P('talk.wav');
wav(TALK, 18);

async function boot() {
  await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
  await js('Cut.loaded');
  await until('window.__cutReady === true', 'the editor started', 30000);
  await js(`(() => {
    const C = Cut.commands;
    const T = Cut.time.TICKS;
    const H = (window.__sk = {});
    H.fresh = async (file) => {
      const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
      const h = C.createHistory(p);
      const list = await Cut.media.importFiles([file]);
      if (list.some((m) => m.error)) throw new Error(JSON.stringify(list));
      const ids = h.do(C.importMedia(list)).ids;
      const seq = h.project.sequences[0];
      h.do(C.place(seq.id, { source: { media: ids[0] }, in: 0, out: 18 * T, at: 0, video: null, audio: 'A1', mode: 'overwrite' }));
      Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
      Cut.app.select([]);
      Cut.app.setTime(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return ids;
    };
    H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
    H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; };
    H.panel = '.cut-panel[data-panel="transcript"]';
    H.words = () => Cut.ui.transcript.words.map((w) => w.speaker);
    H.chips = () => [...document.querySelectorAll(H.panel + ' .cut-spk-chip')].map((c) => ({ id: c.dataset.speaker, name: c.querySelector('.cut-spk-chip-name').textContent, n: Number(c.querySelector('.cut-spk-chip-count').textContent), color: getComputedStyle(c.querySelector('.cut-spk-dot')).backgroundColor }));
    H.paras = () => [...document.querySelectorAll(H.panel + ' .cut-tr-para')].map((p) => ({ speaker: p.querySelector('.cut-tr-speaker')?.dataset.speaker || null, name: p.querySelector('.cut-tr-speaker-name')?.textContent || '', words: p.querySelectorAll('.cut-tr-word').length }));
    H.selected = () => [...document.querySelectorAll(H.panel + ' .cut-tr-word.selected')].map((n) => Number(n.dataset.i));
    H.last = () => Cut.app.history.list().filter((x) => x.done).at(-1)?.label;
    H.steps = () => Cut.app.history.list().filter((x) => x.done).length;
    H.sp = () => Cut.app.project.speakers || null;
    H.whisper = () => ide.api.invoke('cut:speechStatus');
    H.status = () => ide.api.invoke('cut:speakersStatus');
    // the caption track drawn by a compositor of its own: the count of pixels near a color
    H.ink = async (t, trackId, hex) => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      const comp = await Cut.compositor.create(c, { width: 320, height: 180 });
      try {
        await comp.render(Cut.app.project, Cut.app.sequence.id, t, { captions: trackId });
        const px = await comp.readPixels();
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - r) < 40 && Math.abs(px[i + 1] - g) < 40 && Math.abs(px[i + 2] - b) < 40) n++;
        return n;
      } finally { comp.destroy?.(); }
    };
    return true;
  })()`);
}
await boot();
check(await js(`['speakers', 'speech', 'compositor', 'commands', 'model'].every((m) => !!Cut[m]) && !!Cut.ui.speakers?.label && Cut.ui.panels.has('transcript')`), 'the speaker modules are loaded');

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, button = 'left', clickCount = 1, modifiers = 0 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount, modifiers });
async function clickAt(p, { button = 'left' } = {}) {
  if (!p) throw new Error('nothing to click');
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y, { button, buttons: button === 'right' ? 2 : 1 });
  await mouse('mouseReleased', p.x, p.y, { button, buttons: 0 });
  await sleep(150);
}
async function dblclickAt(p) {
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  for (const clickCount of [1, 2]) {
    await mouse('mousePressed', p.x, p.y, { clickCount });
    await mouse('mouseReleased', p.x, p.y, { buttons: 0, clickCount });
  }
  await sleep(200);
}
const KEYS = { Escape: ['Escape', 'Escape', 27], Enter: ['Enter', 'Enter', 13] };
async function key(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
  const [k, code, vk] = KEYS[name] || [name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  const base = { modifiers: mods, key: k, code, windowsVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(100);
}
const tr = (s, p) => js(`tr(${S(s)}${p ? `, ${S(p)}` : ''})`);
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__sk.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 10000);
  await clickAt(await js(`__sk.button('#${id}', ${S(name)})`));
}
const idle = (ms = 60000) => until('!Cut.ui.auto.running && !document.querySelector(".cut-auto-task")', 'the task to end', ms);
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  await js(`ide.ui.closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((n) => n.remove()); Cut.ui.auto.cancel(); true`).catch(() => {});
  await sleep(200);
}
async function showTranscript() {
  await clickAt(await js(`__sk.rect('.cut-ws-tab[data-ws="captions"]')`));
  await until(`!!document.querySelector('.cut-grid .cut-slot-tab[data-panel="transcript"]')`, 'the Transcript tab');
  await clickAt(await js(`__sk.rect('.cut-grid .cut-slot-tab[data-panel="transcript"]')`));
  await until(`!!__sk.rect(__sk.panel + ' .cut-spk-run')?.w`, 'the Transcript panel and its speakers row');
}
async function labelSpeakers() {
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-spk-run')`));
  await sleep(200);
  await idle();
}
// the speaker each word should have, as ids: A, B, C by first appearance (sp ids from the labels' list order)
const truthIds = (sp) => { const map = { A: sp.list[0]?.id, B: sp.list[1]?.id, C: sp.list[2]?.id }; return expected.map((w) => map[w]); };
let named = null;

await section('labels', async () => {
  await js(`__sk.fresh(${S(TALK)})`);
  await showTranscript();
  check(await js(`document.querySelector(__sk.panel + ' .cut-spk-bar').classList.contains('empty')`), 'before labelling the speakers row has no chips');
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-tr-run')`));
  await idle();
  await until(`Cut.ui.transcript.words.length === ${expected.length}`, 'the transcript', 20000);
  check(await js(`document.querySelector(__sk.panel + ' .cut-spk-none')?.textContent`) === await tr('No speaker labels yet.'), 'with a transcript and no labels the row says so');
  const steps0 = await js('__sk.steps()');
  await labelSpeakers();
  const sp = await js('__sk.sp()');
  const chips = await js('__sk.chips()');
  check(sp?.list.length === 3 && chips.length === 3, `Label Speakers (Auto) finds the three speakers (${S(chips.map((c) => [c.name, c.n]))})`);
  check(S(await js('__sk.words()')) === S(truthIds(sp)), 'every word has its speaker');
  const paras = await js('__sk.paras()');
  check(S(paras.map((p) => p.speaker)) === S([sp.list[0].id, sp.list[1].id, sp.list[2].id, sp.list[0].id, sp.list[1].id]) && S(paras.map((p) => p.words)) === S(PLAN.map((p) => p[2])),
    `the paragraphs break where the speaker changes, each labelled (${S(paras.map((p) => [p.name, p.words]))})`);
  check(S(paras.map((p) => p.name).slice(0, 3)) === S([await tr('Speaker {n}', { n: 1 }), await tr('Speaker {n}', { n: 2 }), await tr('Speaker {n}', { n: 3 })]), 'unnamed speakers show as Speaker 1, 2, 3');
  check(new Set(chips.map((c) => c.color)).size === 3, `each speaker has its own color (${chips.map((c) => c.color).join(', ')})`);
  check(await js(`__sk.last() === 'Label Speakers' && __sk.steps() === ${steps0 + 1}`), 'labelling is one undo step');
});

await section('rename', async () => {
  const chip = await js(`__sk.rect(__sk.panel + ' .cut-spk-chip[data-speaker="' + __sk.sp().list[0].id + '"]')`);
  await dblclickAt(chip);
  await until(`!!document.querySelector('#cutSpeakerRename input.cut-spk-name')`, 'the rename dialog', 5000);
  await js(`(() => { const i = document.querySelector('#cutSpeakerRename input.cut-spk-name'); i.focus(); i.select(); return true; })()`);
  await cdp('Input.insertText', { text: 'Mina' });
  await dialogButton('cutSpeakerRename', 'OK');
  await sleep(300);
  named = await js('__sk.sp().list[0].id');
  check((await js('__sk.chips()'))[0].name === 'Mina' && (await js('__sk.paras()')).filter((p) => p.name === 'Mina').length === 2, 'the new name shows on the chip and on both of that speaker\'s paragraphs');
  check(await js(`__sk.last() === 'Rename Speaker'`), 'renaming is one undo step');
  await clickAt(await js(`__sk.rect('.cut-topbar .cut-undo')`));
  await sleep(200);
  check((await js('__sk.chips()'))[0].name === await tr('Speaker {n}', { n: 1 }), 'undo takes the name back');
  await clickAt(await js(`__sk.rect('.cut-topbar .cut-redo')`));
  await sleep(200);
  check((await js('__sk.chips()'))[0].name === 'Mina', 'redo gives it again');
});

await section('count', async () => {
  const whisper0 = (await js('__sk.whisper()')).stats.windows;
  const embeds0 = (await js('__sk.status()')).stats.embeds;
  await js(`(() => { const s = document.querySelector(__sk.panel + ' .cut-spk-count'); s.value = '2'; s.dispatchEvent(new Event('change')); return true; })()`);
  await labelSpeakers();
  const sp = await js('__sk.sp()');
  const chips = await js('__sk.chips()');
  check(chips.length === 2 && sp.count === 2, `with 2 speakers chosen, labelling again gives two (${S(chips.map((c) => [c.name, c.n]))})`);
  check((await js('__sk.whisper()')).stats.windows === whisper0 && (await js('__sk.status()')).stats.embeds === embeds0, 'without recognising or embedding again: the embeddings came from the cache');
  check(chips.some((c) => c.name === 'Mina'), 'the renamed speaker keeps its name');
  const words = await js('__sk.words()');
  check(new Set(words.filter((_, i) => expected[i] === 'A')).size === 1 && new Set(words.filter((_, i) => expected[i] === 'B')).size === 1, 'A and B words stay together; C joins one of them');
  await js(`(() => { const s = document.querySelector(__sk.panel + ' .cut-spk-count'); s.value = '0'; s.dispatchEvent(new Event('change')); return true; })()`);
  await labelSpeakers();
  const back = await js('__sk.sp()');
  check(back.count === 0 && (await js('__sk.chips()')).length === 3 && S(await js('__sk.words()')) === S(truthIds(back)), 'Auto again gives the three speakers');
  check(back.list[0].id === named && back.list[0].name === 'Mina', 'and the first speaker is still Mina');
});

await section('select', async () => {
  const sp = await js('__sk.sp()');
  const b = sp.list[1].id;
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-spk-chip[data-speaker="${b}"]')`));
  const want = expected.map((w, i) => (w === 'B' ? i : -1)).filter((i) => i >= 0);
  check(S(await js('__sk.selected()')) === S(want) && S(await js('Cut.ui.transcript.picked')) === S(want), `a speaker's chip selects all of their words and only those (${(await js('__sk.selected()')).length})`);
  check(!(await js(`document.querySelector(__sk.panel + ' .cut-tr-remove').disabled`)), 'Remove is ready for them');
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-tr-text')`));
  await key('Escape');
  check((await js('__sk.selected()')).length === 0, 'Escape clears the selection');
});

await section('reassign', async () => {
  const sp = await js('__sk.sp()');
  const steps0 = await js('__sk.steps()');
  const label = await js(`__sk.rect([...document.querySelectorAll(__sk.panel + ' .cut-tr-para')][1].querySelector('.cut-tr-speaker'))`);
  await clickAt(label);
  await clickMenuPath(ctx, [await tr('Change Speaker'), 'Mina']);
  await sleep(300);
  const words = await js('__sk.words()');
  const truth = truthIds(sp).map((id, i) => (i >= 7 && i < 13 ? sp.list[0].id : id));
  check(S(words) === S(truth), 'Change Speaker gives the paragraph\'s words to Mina, and only them');
  check(await js(`__sk.last() === 'Change Speaker' && __sk.steps() === ${steps0 + 1}`), 'as one undo step');
  check((await js('__sk.paras()')).length === 4, 'the paragraph joins Mina\'s first one');
  await clickAt(await js(`__sk.rect('.cut-topbar .cut-undo')`));
  await sleep(300);
  check(S(await js('__sk.words()')) === S(truthIds(sp)), 'undo gives them back to their speaker');
});

let captionTrack = null;
await section('captions', async () => {
  const sp = await js('__sk.sp()');
  await clickAt(await js(`__sk.rect('.cut-topbar .cut-auto-btn')`));
  await clickMenuPath(ctx, [await tr('Auto Captions…')]);
  await until(`!!document.querySelector('#cutSpeechCaptions .cut-spk-captions')`, 'the speakers choice in Auto Captions', 5000);
  await js(`(() => { const s = document.querySelector('#cutSpeechCaptions .cut-spk-captions'); s.value = 'both'; s.dispatchEvent(new Event('change')); return true; })()`);
  await dialogButton('cutSpeechCaptions', 'Create Captions');
  await idle();
  await until(`Cut.app.sequence.captions.length === 1`, 'the caption track', 10000);
  const ct = await js(`(() => { const t = Cut.app.sequence.captions[0]; return { id: t.id, style: t.style, items: t.items.map((it) => ({ start: it.start / Cut.time.TICKS, end: it.end / Cut.time.TICKS, speaker: it.speaker || null })) }; })()`);
  captionTrack = ct.id;
  const whoAt = (t) => { const p = PLAN.filter((x) => x[1] <= t + 0.01).at(-1); return sp.list['ABC'.indexOf(p[0])].id; };
  const bad = ct.items.filter((it) => it.speaker !== whoAt(it.start) || it.speaker !== whoAt(it.end - 0.05));
  check(ct.items.length >= 5 && !bad.length, `every caption holds one speaker and knows it (${ct.items.length} captions, ${S(bad)})`);
  check(ct.style.speakerColor === true && ct.style.speakerName === true, 'the track shows the speakers\' colors and names');
  const bAt = ct.items.find((it) => it.speaker === sp.list[1].id);
  const orange = await js(`__sk.ink(${(bAt.start + 0.1) * 254016000000}, ${S(ct.id)}, ${S(sp.list[1].color)})`);
  const blueThere = await js(`__sk.ink(${(bAt.start + 0.1) * 254016000000}, ${S(ct.id)}, ${S(sp.list[0].color)})`);
  const aAt = ct.items.find((it) => it.speaker === sp.list[0].id);
  const blue = await js(`__sk.ink(${(aAt.start + 0.1) * 254016000000}, ${S(ct.id)}, ${S(sp.list[0].color)})`);
  check(orange > 60 && blue > 60 && blueThere < 5, `captions are drawn in their speaker's color (B's ${orange} px of ${sp.list[1].color}, A's ${blue} px of ${sp.list[0].color}, ${blueThere} of A's color in B's caption)`);
  const srt = await js(`Cut.speakers.written(Cut.app.project, Cut.app.sequence.captions[0], Cut.app.sequence.captions[0].items, tr).map((it) => it.text)`);
  check(srt[0].startsWith('Mina: ') && srt.some((t) => t.startsWith('Speaker 2: ')), `SRT text has the speakers' names (${S(srt.slice(0, 3))})`);
  // the Caption Style dialog turns them off
  await js(`Cut.ui.captions.styleDialog(Cut.app)`);
  await until(`!!document.querySelector('#cutCaptionStyle .cut-cap-speakers')`, 'the speakers choice in Caption Style', 5000);
  check(await js(`document.querySelector('#cutCaptionStyle .cut-cap-speakers').value === 'both'`), 'Caption Style shows the track\'s choice');
  await js(`(() => { const s = document.querySelector('#cutCaptionStyle .cut-cap-speakers'); s.value = 'off'; s.dispatchEvent(new Event('change')); return true; })()`);
  await dialogButton('cutCaptionStyle', 'OK');
  await sleep(200);
  const plain = await js(`__sk.ink(${(bAt.start + 0.1) * 254016000000}, ${S(ct.id)}, ${S(sp.list[1].color)})`);
  const white = await js(`__sk.ink(${(bAt.start + 0.1) * 254016000000}, ${S(ct.id)}, '#ffffff')`);
  check(plain < 5 && white > 60, `with speakers off the caption is white again (${plain} px of B's color, ${white} white)`);
  await clickAt(await js(`__sk.rect('.cut-topbar .cut-undo')`));
  await sleep(200);
  check(await js(`Cut.app.sequence.captions[0].style.speakerColor === true`), 'and undo turns them on again');
});

await section('reload', async () => {
  const projectPath = P('talk.ncut');
  answer({ saveAs: projectPath });
  await clickAt(await js(`__sk.rect('.cut-monitor-program .cut-monitor-head')`));
  await key('Ctrl+S');
  await until(`Cut.app.path && !Cut.ui.lifecycle.dirty`, 'saved', 10000);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  check(saved.speakers?.list.length === 3 && saved.speakers.list[0].name === 'Mina' && saved.sequences[0].captions[0].items.every((it) => /^sp\d+$/.test(it.speaker)), 'the saved file holds the labels, the names and the captions\' speakers');
  const before = await js('__sk.sp()');
  await ctx.reload({ until: 'window.__cutReady === true' });
  await boot();
  answer({ pickProject: projectPath });
  await clickAt(await js(`__sk.rect('.cut-topbar .cut-open')`));
  await until(`Cut.app.path && Cut.app.project.speakers`, 'the project reopened', 10000);
  check(S(await js('__sk.sp()')) === S(before), 'reopened, the labels are as they were saved');
  await showTranscript();
  await until(`Cut.ui.transcript.words.length === ${expected.length}`, 'the transcript from the cache', 20000);
  await sleep(300);
  check(S(await js('__sk.words()')) === S(truthIds(before)) && (await js('__sk.chips()'))[0].name === 'Mina', 'the transcript shows the speakers and Mina again');
  check(await js(`Cut.app.sequence.captions[0].items.every((it) => it.speaker) && Cut.app.sequence.captions[0].style.speakerName === true`), 'the captions keep their speakers');
});

await section('shots', async () => {
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${S(theme)})`);
    await sleep(400);
    log(`  saved ${await ctx.shot(`speakers-transcript-${theme}.png`)}`);
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  check(true, 'screenshots saved');
});

// the row's count belongs to its project: another video starts at Auto
await section('new project', async () => {
  const pick = (v) => js(`(() => { const s = document.querySelector(__sk.panel + ' .cut-spk-count'); s.value = ${S(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
  const shown = () => js(`document.querySelector(__sk.panel + ' .cut-spk-count').value`);
  await js(`__sk.fresh(${S(TALK)})`);
  await showTranscript();
  await until(`document.querySelector(__sk.panel + ' .cut-spk-count').value === '0'`, 'Auto in a project without labels', 5000).catch(() => {});
  await pick('3');
  await js(`(Cut.app.setTime(Cut.time.TICKS), true)`);
  await sleep(300);
  check((await shown()) === '3' && !(await js('__sk.sp()')), 'a count chosen before labelling stays in the row for that project');
  await js(`__sk.fresh(${S(TALK)})`);
  await sleep(500);
  check((await shown()) === '0', `another project without labels starts at Auto (${await shown()})`);
  await labelSpeakers();
  const sp = await js('__sk.sp()');
  check(sp?.count === 0 && (await js('__sk.chips()')).length === 3, `and Label Speakers there labels with Auto (count ${sp?.count}, ${(await js('__sk.chips()')).length} speakers)`);
  await pick('2');
  await labelSpeakers();
  await js(`__sk.fresh(${S(TALK)})`);
  await sleep(500);
  check((await shown()) === '0', 'a project after one labelled with 2 speakers starts at Auto too');
});

// ---------- the model missing: an empty Hugging Face cache and the real backend ----------
await section('missing', async () => {
  ctx.close();
  await sleep(1500);
  const emptyHub = tempDir('cut-speakers-hub');
  ctx = await launch({ fixture: 'core', port: 9766, name: 'cut-speakers-missing', mode: 'cut', env: { ...env, PYIDE_SPEAKERS_BACKEND: '', HF_HUB_CACHE: emptyHub } });
  runs.push(ctx);
  ({ js, until, check, cdp, sleep } = ctx);
  await boot();
  const st = await js('__sk.status()');
  check(st.backend === 'wespeaker' && !st.model.installed, 'with an empty model cache the real backend reports the model missing');
  await js(`__sk.fresh(${S(TALK)})`);
  await showTranscript();
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-tr-run')`));
  await idle();
  await until(`Cut.ui.transcript.words.length === ${expected.length}`, 'the transcript', 20000);
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-spk-run')`));
  await until(`!!document.querySelector('#cutSpeakersSetup')`, 'the setup dialog', 10000);
  const body = await js(`document.querySelector('#cutSpeakersSetup').textContent`);
  check(/WeSpeaker ResNet34-LM/.test(body) && /on this PC/.test(body) && /never sent anywhere/.test(body) && /Nothing is downloaded until you press Download/.test(body) && /\d+(\.\d+)? MB/.test(body),
    `the dialog says what is downloaded, its size, and that it runs on this PC (${body.slice(0, 160)}…)`);
  log(`  saved ${await ctx.shot('speakers-setup-dark.png')}`);
  await dialogButton('cutSpeakersSetup', 'Cancel');
  await sleep(300);
  check((await js('__sk.status()')).stats.setups === 0 && !(await js('__sk.sp()')), 'Cancel downloads nothing and labels nothing');
});

await section('korean', async () => {
  ctx.close();
  await sleep(1500);
  ctx = await launch({ fixture: 'core', port: 9766, name: 'cut-speakers-ko', mode: 'cut', lang: 'ko-KR', env: { ...env, PYIDE_SPEAKERS_FAKE_SETUP: 'offline' } });
  runs.push(ctx);
  ({ js, until, check, cdp, sleep } = ctx);
  await boot();
  await js(`__sk.fresh(${S(TALK)})`);
  await showTranscript();
  check(await js(`document.querySelector(__sk.panel + ' .cut-spk-run').textContent === '화자 구분'`), 'the speakers row is in Korean');
  await clickAt(await js(`__sk.rect(__sk.panel + ' .cut-spk-run')`));
  await until(`!!document.querySelector('#cutSpeakersSetup')`, 'the setup dialog', 20000);
  const body = await js(`document.querySelector('#cutSpeakersSetup').textContent`);
  check(/이 PC에서/.test(body) && /내려받기를 누르기 전에는 아무것도 내려받지 않습니다/.test(body), `the dialog is in Korean (${body.slice(0, 100)}…)`);
  await dialogButton('cutSpeakersSetup', 'Download');
  await until(`!document.querySelector('#cutSpeakersSetup .cut-speech-error').hidden`, 'the error', 15000);
  const err = await js(`({ text: document.querySelector('#cutSpeakersSetup .cut-speech-error').textContent, code: document.querySelector('#cutSpeakersSetup .cut-speech-error').dataset.code })`);
  check(err.code === 'offline' && /인터넷에 연결할 수 없어/.test(err.text), `an offline download is explained in Korean (${S(err)})`);
  log(`  saved ${await ctx.shot('speakers-setup-error-ko-dark.png')}`);
  await dialogButton('cutSpeakersSetup', 'Cancel');
});

const last = runs.at(-1);
for (const r of runs.slice(0, -1)) {
  last.results.unshift(...r.results);
  last.consoleErrors.unshift(...r.consoleErrors);
  last.cspViolations.unshift(...r.cspViolations);
}
last.finish();
