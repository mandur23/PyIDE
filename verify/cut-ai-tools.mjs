// The control API's tools for everything beyond the timeline edits, used live by the AI assistant in the real app
// (control-project.js, control-auto.js, control-actions.js, ui-control.js), in Korean, against the scripted stand-in
// CLI (verify/fake-claude-cut.mjs through PYIDE_CLAUDE_PATH). Never the real Claude, nothing downloaded: speech
// recognition is the fake backend, its "download" the fake setup. Real mouse and keys:
// - run_action: In and Out at times, Extract (an undo step), a refused action that needs a selection, a marker;
// - the editing tools: a speed ramp and a hold, a mask whose path and feather are animated, Lumetri curves and HSL,
//   the Audio Track Mixer's track volume, pan and master (the mixer panel shows them);
// - import: a file in the project's folder comes in at once, one outside it only after the user confirms it in a
//   dialog that lists it; Don't Import refuses the whole call and changes nothing;
// - an automation job (auto captions): the setup dialog asks before any download (Cancel is a refusal, nothing
//   changes), the job's progress shows on its step, Stop ends it with nothing changed, and a full run makes captions;
// - screenshots in the dark and the light theme (verify/out/cut-ai-tools/*.png).
// Usage: node verify/cut-ai-tools.mjs   (CUT_TOOLS_ONLY=actions,editing,import,automation)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir } from './lib.mjs';

const ONLY = (process.env.CUT_TOOLS_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = tempDir('cut-tools-home');
const fakeDir = tempDir('cut-tools-claude');
const fakeCmd = path.join(fakeDir, 'claude.cmd');
writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${path.join(APP, 'verify', 'fake-claude-cut.mjs')}" %*\r\n`);
writeFileSync(path.join(fakeDir, 'log.jsonl'), '');
const scenario = (s) => writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(s));
scenario({});
const agentLog = () => readFileSync(path.join(fakeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.agent);

const env = { PYIDE_CUT_HOME: home, PYIDE_CLAUDE_PATH: fakeCmd, FAKE_CLAUDE_DIR: fakeDir, PYIDE_WHISPER_BACKEND: 'fake', PYIDE_WHISPER_FAKE_SETUP: 'ok' };
const ctx = await launch({ fixture: 'core', port: 9808, name: 'cut-ai-tools', mode: 'cut', lang: 'ko-KR', env });
const { js, until, check, cdp, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const P = (...name) => path.join(home, ...name);

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
// the project's folder (a project saved there) and a folder outside it
mkdirSync(P('film'), { recursive: true });
mkdirSync(P('elsewhere'), { recursive: true });
const INSIDE = P('film', 'logo.png');
const OUTSIDE = P('elsewhere', 'photo.png');
png(INSIDE, 64, 64, [240, 200, 40]);
png(OUTSIDE, 64, 64, [40, 200, 240]);
const TALK = P('talk.mp4');

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`['control', 'testsrc', 'commands'].every((k) => !!Cut[k]) && !!Cut.ui.controlServices?.automation && !!Cut.ui.assistant?.ask && Cut.control.names().includes('run_action') && Cut.control.names().includes('automation')`), 'the control API with its tool files and the page services are loaded');
const made = await js(`(async () => { const r = await Cut.testsrc.write(${S(TALK)}, { seconds: 12, fps: [30, 1], w: 320, h: 180, beepEvery: 1 }); return r.ok ? 'ok' : JSON.stringify(r.error); })()`);
check(made === 'ok', `a 12 s test video with a beep every second (${made})`);
await js(`(() => {
  const C = Cut.commands;
  const H = (window.__tools = {});
  H.seq = () => Cut.app.sequence;
  H.fresh = async () => {
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
    const h = C.createHistory(p);
    const list = await Cut.media.importFiles([${S(TALK)}]);
    if (list.some((m) => m.error)) throw new Error(JSON.stringify(list));
    const ids = h.do(C.importMedia(list)).ids;
    const s = h.project.sequences[0];
    h.do(C.place(s.id, { source: { media: ids[0] }, in: 0, out: 12 * Cut.time.TICKS, at: 0, video: 'V1', audio: 'A1' }));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), ${S(P('film', 'film.ncut'))}, 'open');
    Cut.app.select([]);
    Cut.app.setInOut({ in: null, out: null });
    Cut.app.setTime(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return ids;
  };
  H.done = () => Cut.app.history.list().filter((x) => x.done);
  H.length = () => Cut.model.sequenceDuration(H.seq()) / Cut.time.TICKS;
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; };
  H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label && n.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  H.steps = () => [...document.querySelectorAll('.cut-assistant .cut-as-msg.assistant')].at(-1) ? [...[...document.querySelectorAll('.cut-assistant .cut-as-msg.assistant')].at(-1).querySelectorAll('.cut-as-step')].map((n) => ({ state: n.dataset.state, tool: n.dataset.tool, text: n.querySelector('.cut-as-step-text').textContent, error: n.querySelector('.cut-as-step-error')?.textContent || '', progress: n.querySelector('.cut-as-step-progress')?.dataset.progress ?? null })) : [];
  H.answer = () => [...document.querySelectorAll('.cut-assistant .cut-as-msg.assistant > .cut-as-text')].at(-1)?.textContent || '';
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1 } = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 0 : buttons, clickCount: 1 });
async function clickAt(p) {
  if (!p) throw new Error('nothing to click');
  await mouse('mouseMoved', p.x, p.y);
  await mouse('mousePressed', p.x, p.y);
  await mouse('mouseReleased', p.x, p.y);
  await sleep(120);
}
async function enter() {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(80);
}
const tr = (s, p) => js(`tr(${S(s)}${p ? `, ${S(p)}` : ''})`);
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__tools.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 20000);
  await clickAt(await js(`__tools.button('#${id}', ${S(name)})`));
}
async function themes(name) {
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${S(theme)})`);
    await until(`document.documentElement.dataset.theme === ${S(theme)}`, `the ${theme} theme`, 5000).catch(() => {});
    await sleep(250);
    log(`  saved ${await ctx.shot(`tools-${name}-${theme}.png`)}`);
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  if (await js('!!Cut.ui.assistant.running')) { await js('Cut.ui.assistant.stop()'); await until('!Cut.ui.assistant.running', 'the turn to end', 15000).catch(() => {}); }
  for (const id of ['cutAsImport', 'cutSpeechSetup', 'cutAsNotice']) if (await js(`!!document.querySelector('#${id}')`)) await js(`document.querySelector('#${id}')?.closest('.dialog-backdrop')?.querySelector('.dialog-buttons button:last-child')?.click(), true`);
  scenario({});
  await js(`ide.api.invoke('cut:speechTestConfig', { delay: 0 })`);
  await sleep(200);
}
async function ask(text) {
  await clickAt(await js(`__tools.rect('.cut-assistant .cut-as-input')`));
  await ctx.type(text);
  await enter();
}
const idle = (ms = 60000) => until('!Cut.ui.assistant.running', 'the turn to end', ms);

// the panel (the Window menu's way to it is verify/cut-ai-chat.mjs's)
await js('__tools.fresh()');
await js(`ide.settings.set('cut.assistant.acknowledged', true)`);
await js(`Cut.ui.openPanel('assistant')`);
await until(`!!document.querySelector('.cut-panel[data-panel="assistant"] .cut-as-input')`, 'the AI Assistant panel', 10000);

// ---------- run_action ----------
await section('actions', async () => {
  await js('__tools.fresh()');
  const done0 = (await js('__tools.done()')).length;
  await ask('키보드 동작을 해줘');
  await idle();
  const steps = await js('__tools.steps()');
  check(S(steps.map((s) => `${s.tool}:${s.state}`)) === S(['get_sequence:done', 'list_actions:done', 'run_action:done', 'run_action:done', 'run_action:done', 'run_action:refused', 'run_action:done']), `the steps: list_actions, In, Out, Extract, a refused Ripple Delete, a marker (${S(steps.map((s) => `${s.tool}:${s.state}`))})`);
  check(/rippleDelete needs selected clips/.test(steps[5]?.error || ''), `the refused step says what the action needs (${steps[5]?.error})`);
  const extract = await js(`Cut.ui.keys.title('extract')`);
  check(steps.some((s) => s.text.includes(extract)) && extract !== 'extract', `the steps name the actions as the shortcut list does (${S(steps.map((s) => s.text))})`);
  const after = await js(`({ length: __tools.length(), io: Cut.app.inOut, markers: __tools.seq().markers.map((m) => m.t / Cut.time.TICKS), done: __tools.done().length })`);
  check(Math.abs(after.length - (10 - 1 / 30)) < 1e-6, `Extract took In (1 s) to Out (3 s, its frame included) out of the sequence (12 s -> ${after.length} s)`);
  check(after.markers.length === 1 && after.done === done0 + 1, `the marker is there and the whole turn is one undo step (${S(after)})`);
  const calls = agentLog().filter((l) => l.tool === 'run_action');
  check(calls.some((l) => l.args.id === 'markIn' && /"inOut":\{"in":1/.test(l.text)), 'run_action said what changed (the In at 1 s)');
});

// ---------- the editing tools: remap ramps, mask keyframes, Lumetri curves, the mixer ----------
await section('editing', async () => {
  await js('__tools.fresh()');
  await js(`Cut.ui.openPanel('mixer')`);
  await ask('효과 편집을 해줘');
  await idle();
  const steps = await js('__tools.steps()');
  check(steps.length === 8 && steps.every((s) => s.state === 'done'), `every step done (${S(steps.map((s) => `${s.tool}:${s.state}${s.error ? ` ${s.error}` : ''}`))})`);
  const state = await js(`(() => {
    const s = __tools.seq();
    const v = s.clips.find((c) => c.track === 'V1');
    const lum = v.effects.find((e) => e.type === 'color.basic');
    const mask = v.masks?.[0];
    const a1 = s.tracks.find((t) => t.id === 'A1');
    return { speeds: v.remap?.speeds, ramp: v.remap?.keys?.[0]?.ramp / Cut.time.TICKS, hold: Cut.model.sourceTime(v, 6.2 * Cut.time.TICKS) === Cut.model.sourceTime(v, 6.8 * Cut.time.TICKS),
      pathKeys: v.keyframes[\`masks.\${mask?.id}.path\`]?.length, featherKeys: v.keyframes[\`masks.\${mask?.id}.feather\`]?.length,
      curve: lum?.params.curveMaster, hsl: [lum?.params.hslHue, lum?.params.hslSaturation], a1: [a1.volume, a1.pan], master: s.masterGain };
  })()`);
  check(S(state.speeds) === S([1, 0.5, 0, 1]) && state.ramp === 0.5 && state.hold, `the clip ramps to 50 % over 0.5 s and holds a frame (${S(state)})`);
  check(state.pathKeys === 2 && state.featherKeys === 2, 'the mask path and feather are animated');
  check(S(state.curve) === S([0, 0, 0.5, 0.7, 1, 1]) && S(state.hsl) === S([200, 150]), 'Lumetri: the master curve and the HSL secondary');
  check(S(state.a1) === S([-6, 20]) && state.master === -2, 'the mixer: A1 at -6 dB, pan 20, master -2 dB');
  const mixer = await js(`[...document.querySelectorAll('.cut-panel[data-panel="mixer"] .cut-mx-value')].map((n) => n.textContent.trim())`);
  check(mixer.some((v) => /-6/.test(v)) && mixer.some((v) => /-2/.test(v)), `the Audio Track Mixer panel shows them (${S(mixer)})`);
  await themes('editing');
});

// ---------- import: the project's folder, and a file the user confirms ----------
await section('import', async () => {
  await js('__tools.fresh()');
  const json0 = await js('Cut.app.history.serialize()');
  await ask(`이 파일들을 가져와 ${INSIDE} ${OUTSIDE}`);
  await until(`!!document.querySelector('#cutAsImport')`, 'the import question', 20000);
  const listed = await js(`[...document.querySelectorAll('#cutAsImport .cut-as-import-list li')].map((n) => n.textContent)`);
  check(S(listed) === S([OUTSIDE]), `the dialog lists only the file outside the project's folder (${S(listed)})`);
  await themes('import');
  await dialogButton('cutAsImport', "Don't Import");
  await idle();
  let steps = await js('__tools.steps()');
  check(steps.at(-1)?.tool === 'import_media' && steps.at(-1).state === 'refused' && /did not confirm/.test(steps.at(-1).error), `Don't Import refuses the call (${steps.at(-1)?.error})`);
  check((await js('Cut.app.history.serialize()')) === json0, 'and nothing came in, not even the file in the project folder');
  await ask(`다시 가져와 ${INSIDE} ${OUTSIDE}`);
  await dialogButton('cutAsImport', 'Import');
  await idle();
  steps = await js('__tools.steps()');
  const names = await js(`Cut.app.project.media.map((m) => m.name)`);
  check(steps.at(-1)?.state === 'done' && names.includes('logo.png') && names.includes('photo.png'), `confirmed, both came in (${S(names)})`);
  await ask(`프로젝트 폴더 것만 가져와 ${INSIDE}`);
  await sleep(1500);
  check(!(await js(`!!document.querySelector('#cutAsImport')`)), 'a file in the project\'s folder comes in without a question');
  await idle();
  check((await js(`Cut.app.project.media.filter((m) => m.name === 'logo.png').length`)) === 2 && (await js('__tools.steps()')).at(-1)?.state === 'done', 'and it came in');
});

// ---------- an automation job: the setup question, progress, Stop, a full run ----------
await section('automation', async () => {
  await js('__tools.fresh()');
  const json0 = await js('Cut.app.history.serialize()');
  const status0 = await js(`ide.api.invoke('cut:speechStatus')`);
  check(!status0.models.some((m) => m.installed), 'speech recognition starts without its model (the fake setup)');
  await ask('자동 자막 만들어줘');
  await until(`!!document.querySelector('#cutSpeechSetup')`, 'the setup dialog before any download', 20000);
  await dialogButton('cutSpeechSetup', 'Cancel');
  await idle();
  let steps = await js('__tools.steps()');
  check(steps.at(-1)?.tool === 'automation' && steps.at(-1).state === 'refused' && /did not agree to set up speech recognition/.test(steps.at(-1).error), `Cancel in the setup dialog refuses the job (${steps.at(-1)?.error})`);
  check(!(await js(`ide.api.invoke('cut:speechStatus')`)).models.some((m) => m.installed) && (await js('Cut.app.history.serialize()')) === json0, 'nothing was downloaded or changed');

  // Download, then Stop in the middle of the job
  // Each window waits long enough that the job cannot end during the screenshots before Stop (seen on CI); Stop cuts
  // the wait short, so this costs no time.
  await js(`ide.api.invoke('cut:speechTestConfig', { delay: 60000 })`);
  await ask('자동 자막 만들어줘');
  await dialogButton('cutSpeechSetup', 'Download');
  await until(`__tools.steps().some((s) => s.tool === 'automation' && s.progress !== null)`, 'the job\'s progress on its step', 30000);
  const mid = await js('__tools.steps().find((s) => s.tool === "automation")');
  check(mid.state === 'running' && Number(mid.progress) >= 0 && Number(mid.progress) < 1, `the running step shows the job's progress (${mid.progress})`);
  await themes('progress');
  // A notification balloon in the lower right once covered Stop on CI, and the click went to the balloon.
  const stopAt = await js(`__tools.rect('.cut-assistant .cut-as-stop')`);
  const onTop = await js(`(() => { const n = document.elementFromPoint(${stopAt.x}, ${stopAt.y}); return n?.closest('.cut-as-stop') ? 'stop' : (n ? (n.closest('.ide-balloon, .ide-balloons') ? 'a notification balloon' : n.className || n.tagName) : null); })()`);
  check(onTop === 'stop', `nothing covers the Stop button (${onTop})`);
  await clickAt(stopAt);
  await idle();
  check(!(await js('!!Cut.ui.auto.running')), 'Stop ended the job in the page too');
  check((await js('Cut.app.history.serialize()')) === json0, 'nothing changed: no captions');
  check(!(await js('__tools.seq().captions.length')), 'the sequence has no caption track');

  // a full run
  await js(`ide.api.invoke('cut:speechTestConfig', { delay: 0 })`);
  const done0 = (await js('__tools.done()')).length;
  await ask('자동 자막 만들어줘');
  await idle(90000);
  steps = await js('__tools.steps()');
  const caps = await js(`__tools.seq().captions.map((t) => t.items.length)`);
  check(steps.at(-1)?.state === 'done' && caps.length === 1 && caps[0] > 0, `the job made a caption track (${S(caps)}; ${steps.at(-1)?.error || ''})`);
  check((await js('__tools.done()')).length === done0 + 1, 'as one undo step');
  check(/자막 \d+개를 만들었어요/.test(await js('__tools.answer()')), `the answer says how many (${await js('__tools.answer()')})`);
});

ctx.finish();
