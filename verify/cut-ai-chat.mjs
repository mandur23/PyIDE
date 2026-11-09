// Nano Studio Cut's AI assistant and control API in the real app (ui-assistant.js, control.js, main/cut/control.js,
// main/cut/agent.js), in Korean, against the scripted stand-in CLI (verify/fake-claude-cut.mjs through
// PYIDE_CLAUDE_PATH; it connects to the Cut MCP server and calls its tools). Never the real Claude. Real mouse and keys:
// - Window > AI 어시스턴트 opens the panel; the notice before the first request; a request typed and sent with Enter;
// - while the turn runs: the timeline changes (not only at the end), each tool call shows as a step, the changed
//   clips flash and the playhead moves to the edit; at the end Claude's answer, and the turn is one undo step named
//   after the request that one Ctrl+Z takes back whole (the program monitor's picture with it);
// - a refused call (a clip on a locked track) shows as a refused step with the reason, and nothing changes;
// - Stop in the middle ends the turn at once, keeps a valid project and one step, and nothing lands afterwards;
// - export asks first: Don't Export writes nothing and the AI hears no; Export queues a new file in the project folder;
// - a usage limit is explained (ui-ai.js's explanation);
// - external AIs: the setting is off by default (no token, a token refused when it is turned off again); turned on
//   with a real click it shows the claude mcp add command and the JSON with Copy; a connection without the token or
//   with a wrong one is refused; a scripted external client edits live with the banner up, its steps in the panel;
//   Disconnect in the banner ends it and the old token is refused;
// - screenshots in the dark and the light theme (verify/out/cut-ai-chat/*.png).
// Usage: node verify/cut-ai-chat.mjs   (CUT_CHAT_ONLY=turn,refused,stop,export,quota,external)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir, clickMenuPath } from './lib.mjs';

const ONLY = (process.env.CUT_CHAT_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = tempDir('cut-chat-home');
const fakeDir = tempDir('cut-chat-claude');
const fakeCmd = path.join(fakeDir, 'claude.cmd');
writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${path.join(APP, 'verify', 'fake-claude-cut.mjs')}" %*\r\n`);
writeFileSync(path.join(fakeDir, 'log.jsonl'), '');
const scenario = (s) => writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(s));
scenario({});
const agentLog = () => readFileSync(path.join(fakeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.agent);

const env = { PYIDE_CUT_HOME: home, PYIDE_CLAUDE_PATH: fakeCmd, FAKE_CLAUDE_DIR: fakeDir };
const ctx = await launch({ fixture: 'core', port: 9807, name: 'cut-ai-chat', mode: 'cut', lang: 'ko-KR', env });
const { js, until, check, cdp, sleep } = ctx;
const S = JSON.stringify;
const log = (...a) => console.log(...a);
const T = 254016000000;
const P = (name) => path.join(home, name);

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
function wav(file, seconds, rate = 48000) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(0.2 * Math.sin((2 * Math.PI * 440 * i) / rate) * 32767); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
  writeFileSync(file, buf);
}
// Two pictures (blue, then red) on V1 for 5 s each, a 10 s tone on A1, and a tone on the locked A2.
const BLUE = P('blue.png');
const RED = P('red.png');
const TONE = P('tone.wav');
png(BLUE, 320, 180, [30, 60, 200]);
png(RED, 320, 180, [210, 40, 40]);
wav(TONE, 10);

await until('!!window.Cut && !!Cut.loaded', 'the Cut scripts', 30000);
await js('Cut.loaded');
await until('window.__cutReady === true', 'the editor started', 30000);
check(await js(`!!Cut.control?.call && !!Cut.ui.assistant?.ask && typeof Cut.ui.timeline.flash === 'function' && Cut.ui.panels.has('assistant') && typeof Cut.app.history.squash === 'function'`), 'the control API, the assistant panel and the timeline flash are loaded');
await js(`(() => {
  const C = Cut.commands;
  const H = (window.__chat = {});
  H.seq = () => Cut.app.sequence;
  H.fresh = async () => {
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
    const h = C.createHistory(p);
    const list = await Cut.media.importFiles([${S(BLUE)}, ${S(RED)}, ${S(TONE)}]);
    if (list.some((m) => m.error)) throw new Error(JSON.stringify(list));
    const ids = h.do(C.importMedia(list)).ids;
    const s = h.project.sequences[0];
    h.do(C.place(s.id, { source: { media: ids[0] }, in: 0, out: 5 * Cut.time.TICKS, at: 0, video: 'V1', audio: null }));
    h.do(C.place(s.id, { source: { media: ids[1] }, in: 0, out: 5 * Cut.time.TICKS, at: 5 * Cut.time.TICKS, video: 'V1', audio: null }));
    h.do(C.place(s.id, { source: { media: ids[2] }, in: 0, out: 10 * Cut.time.TICKS, at: 0, video: null, audio: 'A1' }));
    h.do(C.place(s.id, { source: { media: ids[2] }, in: 0, out: 4 * Cut.time.TICKS, at: 0, video: null, audio: 'A2' }));
    h.do(C.setTrack(s.id, 'A2', { locked: true }));
    Cut.app.setHistory(C.createHistory(JSON.parse(JSON.stringify(h.project))), null, 'open');
    Cut.app.select([]);
    Cut.app.setTime(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return ids;
  };
  H.v1 = () => H.seq().clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start).map((c) => [c.start / Cut.time.TICKS, Cut.model.clipEnd(c) / Cut.time.TICKS]);
  H.length = () => Cut.model.sequenceDuration(H.seq()) / Cut.time.TICKS;
  H.done = () => Cut.app.history.list().filter((x) => x.done);
  H.rect = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; };
  H.button = (root, label) => { const b = [...document.querySelectorAll(root + ' button')].find((n) => n.textContent.trim() === label && n.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  H.steps = () => [...document.querySelectorAll('.cut-assistant .cut-as-step')].map((n) => ({ state: n.dataset.state, tool: n.dataset.tool, text: n.querySelector('.cut-as-step-text').textContent, error: n.querySelector('.cut-as-step-error')?.textContent || '' }));
  // the program monitor's picture in the middle: [r, g, b]
  H.pixel = () => { const c = document.querySelector('.cut-panel[data-panel="program"] canvas'); if (!c) return null; const x = document.createElement('canvas'); x.width = c.width; x.height = c.height; const g = x.getContext('2d'); g.drawImage(c, 0, 0); return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)]; };
  return true;
})()`);

const mouse = (type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, button = 'left', clickCount = 1 } = {}) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' && buttons === 0 ? 0 : buttons, clickCount });
async function clickAt(p) {
  if (!p) throw new Error('nothing to click');
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y);
  await mouse('mouseReleased', p.x, p.y);
  await sleep(120);
}
async function key(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
  const KEYS = { Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27] };
  const [k, code, vk] = KEYS[name] || [name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mods, key: k, code, windowsVirtualKeyCode: vk });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: k, code, windowsVirtualKeyCode: vk });
  await sleep(80);
}
const tr = (s, p) => js(`tr(${S(s)}${p ? `, ${S(p)}` : ''})`);
async function dialogButton(id, label) {
  const name = await tr(label);
  await until(`!!__chat.button('#${id}', ${S(name)})`, `the ${label} button of ${id}`, 20000);
  await clickAt(await js(`__chat.button('#${id}', ${S(name)})`));
}
async function themes(name) {
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${S(theme)})`);
    await until(`document.documentElement.dataset.theme === ${S(theme)}`, `the ${theme} theme`, 5000).catch(() => {});
    await sleep(250);
    log(`  saved ${await ctx.shot(`chat-${name}-${theme}.png`)}`);
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);
}
async function section(name, fn) {
  if (!want(name)) return;
  log(`--- ${name}`);
  try { await fn(); } catch (err) { check(false, `${name}: ${err?.stack || err}`); }
  if (await js('!!Cut.ui.assistant.running')) { await js('Cut.ui.assistant.stop()'); await until('!Cut.ui.assistant.running', 'the turn to end', 15000).catch(() => {}); }
  for (const id of ['cutAsExport', 'cutAiMissing', 'cutAsNotice']) if (await js(`!!document.querySelector('#${id}')`)) await js(`document.querySelector('#${id}')?.closest('.dialog-backdrop')?.querySelector('.dialog-buttons button:last-child')?.click(), true`);
  scenario({});
  await sleep(200);
}
// Types a request in the panel and sends it with Enter, as a person does.
async function ask(text) {
  await clickAt(await js(`__chat.rect('.cut-assistant .cut-as-input')`));
  await ctx.type(text);
  await key('Enter');
}
const idle = (ms = 30000) => until('!Cut.ui.assistant.running', 'the turn to end', ms);

// ---------- the panel through the Window menu ----------
await __open();
async function __open() {
  await js('__chat.fresh()');
  await clickAt(await js(`__chat.rect('.cut-topbar .cut-window-btn')`));
  await clickMenuPath(ctx, [await tr('AI Assistant')]);
  await until(`!!document.querySelector('.cut-panel[data-panel="assistant"] .cut-as-input')`, 'the AI Assistant panel', 10000);
  check(await js(`__chat.rect('.cut-panel[data-panel="timeline"]') && __chat.rect('.cut-panel[data-panel="program"]') && __chat.rect('.cut-assistant .cut-as-input') ? true : false`), 'Window > AI 어시스턴트 opens the panel beside the timeline and the program monitor');
}

// ---------- a turn ----------
const REQUEST = '앞 3초 잘라내고 제목 자막 넣어줘';
await section('turn', async () => {
  await js('__chat.fresh()');
  await js('(Cut.app.setTime(6 * Cut.time.TICKS), true)');
  const json0 = await js('Cut.app.history.serialize()');
  const done0 = (await js('__chat.done()')).length;
  const red0 = await js('__chat.pixel()');
  scenario({ stepMs: 900 });
  await ask(REQUEST);
  await until(`!!document.querySelector('#cutAsNotice')`, 'the notice before the first request');
  const notice = await js(`document.querySelector('#cutAsNotice').textContent`);
  check(/Claude ?\(Anthropic\)/.test(notice) && /프로그램 모니터/.test(notice), `the notice says what goes to Claude, the frame pictures too (${notice.slice(0, 90)}…)`);
  await dialogButton('cutAsNotice', 'Continue');
  // sample the editor while the turn runs
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const s = await js(`({ running: !!Cut.ui.assistant.running, v1: __chat.v1(), steps: __chat.steps().length, done: __chat.steps().filter((x) => x.state === 'done').length, flashing: Cut.ui.timeline.flashing.length, t: Cut.app.t / Cut.time.TICKS, history: Cut.app.history.list().filter((x) => x.done).length })`);
    samples.push(s);
    if (s.flashing && s.running && !samples.shot) { samples.shot = true; await themes('flash'); }
    if (!s.running && i > 3) break;
    await sleep(120);
  }
  const live = samples.find((s) => s.running && s.v1[0]?.[1] === 2 && s.v1.length >= 1);
  check(!!live, `the timeline changed while the turn was still running (V1 ${S(live?.v1)})`);
  check(samples.some((s) => s.running && s.steps >= 2 && s.done >= 1) && samples.some((s) => s.running && s.history > done0), 'the steps and the history grew during the turn, each step marked done');
  check(samples.some((s) => s.flashing > 0), 'the changed clips flashed on the timeline');
  check(samples.some((s) => s.running && s.t === 0), 'the playhead moved from 6 s to the edit at 0 s');
  await idle();
  const steps = await js('__chat.steps()');
  check(steps.length === 4 && steps.every((s) => s.state === 'done') && steps.map((s) => s.tool).join() === 'get_sequence,delete_range,add_text,add_marker', `four steps in the chat, all done (${S(steps.map((s) => `${s.tool}:${s.state}`))})`);
  check(steps.some((s) => /0.*3/.test(s.text)) && steps.some((s) => /제목/.test(s.text)), `the steps say what each did, in Korean (${S(steps.map((s) => s.text))})`);
  const answer = await js(`[...document.querySelectorAll('.cut-assistant .cut-as-msg.assistant > .cut-as-text')].at(-1)?.textContent`);
  check(/앞 3초를 잘라내고/.test(answer || ''), `Claude's answer ends the turn (${answer})`);
  const after = await js('({ v1: __chat.v1(), done: __chat.done().map((x) => x.label), length: __chat.length(), title: __chat.seq().clips.find((c) => c.source.generator === "text")?.source.layers[0].text, markers: __chat.seq().markers.length })');
  check(S(after.v1) === S([[0, 2], [2, 7]]) && after.title === '제목' && after.markers === 1 && after.length === 7, `the edit: 3 s cut, a title, a chapter (${S(after)})`);
  check(after.done.length === done0 + 1 && after.done.at(-1) === REQUEST, `the whole turn is one undo step named after the request (${after.done.at(-1)})`);
  check(await js(`[...document.querySelectorAll('.cut-panel[data-panel="history"] .cut-history-label, .cut-history-label')].some((n) => n.textContent === ${S(REQUEST)}) || !document.querySelector('.cut-history-label')`), 'the History panel shows it by that name');
  const sent = agentLog().find((l) => l.start && l.request === REQUEST);
  check(!!sent && !sent.prompt.includes(home) && !/[A-Z]:[\\/]/.test(sent.prompt), 'the request reached the agent, with no file path in it');
  await themes('turn');
  // one Ctrl+Z takes it all back
  await clickAt(await js(`__chat.rect('.cut-panel[data-panel="program"]')`));
  await key('Ctrl+Z');
  await until(`Cut.app.history.serialize() === ${S(json0)}`, 'the project as it was', 5000).catch(() => {});
  check((await js('Cut.app.history.serialize()')) === json0, 'one Ctrl+Z undoes the whole turn exactly');
  await key('Ctrl+Shift+Z');
  check(S(await js('__chat.v1()')) === S([[0, 2], [2, 7]]), 'Ctrl+Shift+Z brings it back');
  // the user edits by hand between turns
  await js('(Cut.app.setTime(1 * Cut.time.TICKS), true)');
  await clickAt(await js(`__chat.rect('.cut-panel[data-panel="timeline"]')`));
  const handSteps = (await js('__chat.done()')).length;
  check(await js(`(Cut.ui.exec(Cut.app, Cut.commands.split(Cut.app.sequence.id, Cut.time.TICKS)), Cut.app.history.list().filter((x) => x.done).length === ${handSteps + 1})`), 'the user can edit by hand between turns (its own step)');
  void red0;
});

// ---------- a refused call ----------
await section('refused', async () => {
  await js('__chat.fresh()');
  const json0 = await js('Cut.app.history.serialize()');
  const n0 = (await js('Cut.app.history.list()')).length;
  await ask('잠긴 트랙의 클립을 지워줘');
  await idle();
  const steps = await js('__chat.steps()');
  const bad = steps.at(-1);
  check(bad?.tool === 'delete_clips' && bad.state === 'refused' && /A2.*locked/i.test(bad.error), `the refused call shows as a refused step with the reason (${S(bad)})`);
  check((await js('Cut.app.history.serialize()')) === json0 && (await js('Cut.app.history.list()')).length === n0, 'the project and the history are unchanged');
  await themes('refused');
});

// ---------- Stop ----------
await section('stop', async () => {
  await js('__chat.fresh()');
  const done0 = (await js('__chat.done()')).length;
  scenario({ stepMs: 700 });
  await ask('천천히 표시 여러 개 넣어줘');
  await until('__chat.seq().markers.length >= 2', 'two markers in', 20000);
  await until(`!!__chat.rect('.cut-assistant .cut-as-stop')`, 'the Stop button', 5000);
  const t0 = Date.now();
  await clickAt(await js(`__chat.rect('.cut-assistant .cut-as-stop')`));
  await idle(5000);
  const ms = Date.now() - t0;
  const at = await js('__chat.seq().markers.length');
  check(ms < 4000, `Stop ends the turn at once (${ms} ms)`);
  await sleep(1600);
  const later = await js('({ markers: __chat.seq().markers.length, valid: Cut.model.validate(Cut.app.project).ok, done: __chat.done(), text: [...document.querySelectorAll(".cut-assistant .cut-as-msg.assistant > .cut-as-text")].at(-1)?.textContent })');
  check(later.markers === at && at >= 2 && at < 8, `nothing lands after Stop (${at} of 8 markers)`);
  check(later.valid && later.done.length === done0 + 1 && later.done.at(-1).label === '천천히 표시 여러 개 넣어줘', 'the project is valid and what was done is one undo step');
  check(/멈췄/.test(later.text || ''), `the chat says it stopped (${later.text})`);
  check(await js(`!!__chat.rect('.cut-assistant .cut-as-send') && !document.querySelector('.cut-assistant .cut-as-stop:not([hidden])')`), 'Send is back, Stop is gone');
});

// ---------- export asks first ----------
await section('export', async () => {
  await js('__chat.fresh()');
  const projects = path.join(home, 'Projects');
  const files0 = existsSync(projects) ? readdirSync(projects) : [];
  await ask('이 시퀀스 내보내줘');
  await until(`!!document.querySelector('#cutAsExport')`, 'the export question', 20000);
  const q = await js(`document.querySelector('#cutAsExport').textContent`);
  check(/AI export\.mp4/.test(q) && /720p/.test(q), `the question names the new file and the preset (${q.slice(0, 160)})`);
  check(await js('!!Cut.ui.assistant.running') && (existsSync(projects) ? readdirSync(projects) : []).length === files0.length, 'the turn waits for the answer; nothing is written yet');
  await themes('export');
  await dialogButton('cutAsExport', 'Don\'t Export');
  await idle();
  const step = (await js('__chat.steps()')).at(-1);
  check(step.tool === 'export_sequence' && step.state === 'refused' && /no to this export/.test(step.error) && (await js('Cut.ui.exportQueue.jobs().length')) === 0, `Don't Export: the AI hears no and nothing is queued (${S(step)})`);
  await ask('이 시퀀스 내보내줘');
  await dialogButton('cutAsExport', 'Export');
  await idle();
  const jobs = await js('Cut.ui.exportQueue.jobs()');
  check(jobs.length === 1 && jobs[0].path === path.join(projects, 'AI export.mp4'), `Export: one job, a new file in the project folder (${jobs[0]?.path})`);
  await js(`(Cut.ui.exportQueue.cancel(${jobs[0]?.id ?? 0}), true)`).catch(() => {});
  await sleep(500);
});

// ---------- a usage limit ----------
await section('quota', async () => {
  await ask('한도 시험');
  await until(`!!document.querySelector('#cutAiMissing[data-code="quota"], .cut-ai-missing[data-code="quota"]')`, 'the usage limit explanation', 20000);
  const text = await js(`document.querySelector('.cut-ai-missing[data-code="quota"]').textContent`);
  check(/사용 한도/.test(text), `a usage limit is explained in Korean (${text.slice(0, 80)})`);
  await js(`document.querySelector('.cut-ai-missing').closest('.dialog-backdrop').querySelector('.dialog-buttons button')?.click(), true`);
  await idle();
});

// ---------- external AIs ----------
async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: S(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, session: res.headers.get('mcp-session-id') };
}
await section('external', async () => {
  await js('__chat.fresh()');
  check((await js(`ide.settings.get('cut.control.external', null)`)) !== true && (await js('Cut.ui.assistant.external.info')) === null, 'external AIs are off by default: no token');
  await js(`(ide.openSettings('cut'), true)`);
  await until(`!!document.querySelector('input[data-key="cut.control.external"]')`, 'the AI control section', 10000);
  check(!(await js(`document.querySelector('input[data-key="cut.control.external"]').checked`)) && (await js(`document.querySelector('.cut-as-connect').hidden`)), 'the setting is unchecked and shows no connection');
  const toggle = async () => {
    await clickAt(await js(`__chat.rect('input[data-key="cut.control.external"]')`));
    await clickAt(await js(`__chat.button('.dialog-backdrop', ${S(await tr('Apply'))})`));
    await sleep(300);
  };
  await clickAt(await js(`__chat.rect('input[data-key="cut.control.external"]')`));
  check(await js(`!!document.querySelector('.cut-as-connect-pending') && !document.querySelector('.cut-as-connect-command')`), 'checked but not applied: it says Apply turns it on, no token yet');
  await clickAt(await js(`__chat.button('.dialog-backdrop', ${S(await tr('Apply'))})`));
  await until(`!!document.querySelector('.cut-as-connect-command .cut-as-code')`, 'how to connect', 10000);
  const cmdText = await js(`document.querySelector('.cut-as-connect-command .cut-as-code').textContent`);
  const json = JSON.parse(await js(`document.querySelector('.cut-as-connect-json .cut-as-code').textContent`));
  const server = json.mcpServers['nano-cut'];
  const token = server.headers.Authorization.replace('Bearer ', '');
  check(/^claude mcp add --transport http nano-cut http:\/\/127\.0\.0\.1:\d+\/mcp --header "Authorization: Bearer [0-9a-f]{48}"$/.test(cmdText) && server.type === 'http' && cmdText.includes(token), `the claude mcp add command and the JSON with the URL and token (${cmdText.replace(token, '<token>')})`);
  await clickAt(await js(`__chat.rect('.cut-as-connect-command .cut-as-copy')`));
  await sleep(300);
  check((await js(`ide.api.invoke('clipboard:readText')`)) === cmdText, 'Copy copies the command');
  await js(`(document.querySelector('.cut-as-connect-foot').scrollIntoView({ block: 'end' }), true)`);
  await themes('settings');
  // off again: the token is refused
  await toggle();
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Test Agent' } } };
  let r = await post(server.url, init, { Authorization: `Bearer ${token}` });
  check(r.status === 401, 'with the setting off the token is refused');
  await toggle();
  await until(`!!document.querySelector('.cut-as-connect-command .cut-as-code')`, 'the connection again', 10000);
  check((await js(`document.querySelector('.cut-as-connect-command .cut-as-code').textContent`)) === cmdText, 'on again: the same URL and token');
  await js(`document.querySelector('.dialog-backdrop .dialog-buttons .secondary')?.click(), true`);
  await sleep(300);
  r = await post(server.url, init);
  check(r.status === 401, 'a connection without the token is refused');
  r = await post(server.url, init, { Authorization: 'Bearer 0123456789abcdef0123456789abcdef0123456789abcdef' });
  check(r.status === 401, 'a wrong token is refused');
  check(!(await js(`!!document.querySelector('.cut-as-banner:not([hidden])')`)), 'no banner while nobody is connected');
  // the external client connects and edits, step by step
  r = await post(server.url, init, { Authorization: `Bearer ${token}` });
  check(r.status === 200 && !!r.session, 'with the token the external AI connects');
  const auth = { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': r.session };
  await until(`!!document.querySelector('.cut-as-banner:not([hidden])')`, 'the banner', 5000);
  const banner = await js(`document.querySelector('.cut-as-banner').textContent`);
  check(/외부 AI/.test(banner) && /Test Agent/.test(banner), `the banner says an external AI is editing (${banner})`);
  const call = (name, args) => post(server.url, { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }, auth);
  const list = await post(server.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
  check(list.json.result.tools.length > 40, 'it lists the tools');
  r = await call('delete_range', { from: 0, to: 1 });
  const mid = await js(`({ v1: __chat.v1(), flashing: Cut.ui.timeline.flashing.length })`);
  check(r.json.result.isError === false && mid.v1[0][1] === 4 && mid.flashing > 0, `its edit lands live and flashes (${S(mid)})`);
  await themes('external');
  r = await call('add_text', { text: '외부', at: 0, duration: 1 });
  r = await call('delete_clips', { clip_ids: ['c999'] });
  check(r.json.result.isError === true, 'its refused call is refused');
  const ext = await js(`[...document.querySelectorAll('.cut-assistant .cut-as-msg.external .cut-as-step')].map((n) => n.dataset.tool + ':' + n.dataset.state)`);
  check(S(ext.slice(-3)) === S(['delete_range:done', 'add_text:done', 'delete_clips:refused']), `its steps show in the panel (${S(ext)})`);
  r = await call('get_frame', { time: 0.5, width: 320 });
  const img = r.json.result.content.find((c) => c.type === 'image');
  check(img?.mimeType === 'image/png' && Buffer.from(img.data, 'base64').subarray(1, 4).toString() === 'PNG', 'get_frame gives it a PNG of the program monitor');
  await clickAt(await js(`__chat.rect('.cut-as-banner .cut-as-disconnect')`));
  await sleep(400);
  check(!(await js(`!!document.querySelector('.cut-as-banner:not([hidden])')`)), 'Disconnect takes the banner away');
  r = await post(server.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, auth);
  check(r.status === 401, 'the old token is refused after Disconnect');
  await js(`ide.settings.set('cut.control.external', false)`);
});

const left = existsSync(path.join(process.env.TEMP || '', 'pyide-claude')) ? readdirSync(path.join(process.env.TEMP, 'pyide-claude')).filter((f) => f.startsWith('cut-mcp-')) : [];
check(!left.length, `no MCP settings file is left behind (${left.length})`);
ctx.finish();
