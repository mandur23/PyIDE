// App modes (docs/nano-studio-design.md §1): without --mode or a path the start chooser opens, and each of its cards
// opens the main window in that mode while Esc quits; --mode=craft opens the craft window, whose IDE chrome is hidden
// and whose workspace (PYIDE_CRAFT_HOME here) is created, opened and trusted without the Trust question, firing
// craftReady with #craftHost; plugins load per mode (bundled ones and user plugins with and without "modes", their
// renderer scripts and main modules); a path argument without --mode goes straight to code mode; a restart keeps the
// mode. Screenshots: chooser.png, chooser-ko.png and craft-empty.png in verify/out/app-mode. Ports 9642-9647.
import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, processSnapshot, tempDir } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(APP_DIR, 'verify', 'out', 'app-mode');
mkdirSync(OUT, { recursive: true });
const S = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const PRODUCT = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).productName;
const CRAFT_PLUGINS = ['diagnostics', 'installer', 'minecraft', 'notifications', 'port-sharing', 'problems', 'project-roots', 'run', 'settings', 'terminal', 'updater'];

// User plugins: one for craft only (a renderer script that records craftReady and a main module with an IPC channel),
// one without "modes", which counts as code only.
function userData() {
  const dir = path.join(tempDir('app-mode-data'), 'userdata');
  const plugin = (id, json, files) => {
    const d = path.join(dir, 'plugins', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'plugin.json'), S({ id, name: id, version: '1.0.0', vendor: 'Test', description: 'App mode probe', ...json }));
    for (const [f, text] of Object.entries(files)) writeFileSync(path.join(d, f), text);
  };
  plugin('craft-probe', { modes: ['craft'], main: ['probe-main.js'] }, {
    'index.js': `window.__probeLoaded = true;
ide.on('craftReady', (e) => { window.__craftReady = (window.__craftReady || []).concat([{ host: e?.host?.id, root: ide.root }]); });`,
    'probe-main.js': `exports.register = ({ ipcMain }) => ipcMain.handle('craft-probe:hello', () => 'hello from craft');`,
  });
  plugin('default-probe', {}, { 'index.js': 'window.__defaultProbeLoaded = true;' });
  return dir;
}

// ---------- a raw CDP driver for runs that start at the chooser (verify/lib.mjs launch() waits for the IDE page) ----------
const procs = new Set();
process.on('exit', () => { for (const pid of procs) try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch {} });
function start(port, { lang = 'en-US', env = {}, args = [] } = {}) {
  const data = userData();
  const craft = path.join(tempDir('app-mode-craft'), 'Nano Studio Craft');
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${port}`, `--lang=${lang}`, ...args], {
    env: { PYIDE_SEMANTIC_BACKEND: 'fake', PYIDE_AI_COMPLETE_BACKEND: 'fake', PYIDE_CLAUDE_IDE_DIR: path.join(data, '..', 'claude-ide'), ...process.env,
      PYIDE_TRUST_ALL: '0', PYIDE_USER_DATA: data, PYIDE_CRAFT_HOME: craft, ...env },
    stdio: 'ignore',
  });
  procs.add(child.pid);
  const exited = new Promise((r) => child.on('exit', r));
  return { child, data, craft, exited, kill: () => { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} procs.delete(child.pid); } };
}
async function page(port, match, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && match.test(x.url));
      if (t) return connect(t);
    } catch {}
    await sleep(200);
  }
  throw new Error(`no page matching ${match} on port ${port}`);
}
async function pages(port) {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((x) => x.type === 'page').map((x) => x.url); } catch { return []; }
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  ws.addEventListener('close', () => { for (const r of pending.values()) r({}); pending.clear(); });
  const cdp = (method, params = {}) => new Promise((r) => {
    if (ws.readyState !== WebSocket.OPEN) return r({});
    const id = ++seq;
    pending.set(id, r);
    ws.send(S({ id, method, params }));
  });
  const js = async (expr) => (await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const until = async (expr, label, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(150); }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const click = async (selector) => {
    const box = await js(`(() => { const r = document.querySelector(${S(selector)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element ${selector}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  const key = async (k, code) => {
    for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code });
  };
  const shot = async (file) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
    return path.join(OUT, file);
  };
  return { cdp, js, until, click, key, shot, close: () => ws.close() };
}

const CHOOSER = /\/renderer\/chooser\.html/;
const IDE = /\/renderer\/index\.html/;
const chooserState = (c) => c.js(`({ cards: [...document.querySelectorAll('.chooser-card')].map((n) => ({ mode: n.dataset.mode, name: n.querySelector('.chooser-name').textContent, sub: n.querySelector('.chooser-sub').textContent, icon: !!n.querySelector('svg') })),
  w: innerWidth, h: innerHeight, title: document.title, api: Object.keys(window.api || {}).sort(), ide: typeof window.ide, focused: document.activeElement?.id })`);

try {
  // ---------- no --mode, no path: the chooser, then its Code card ----------
  {
    const run = start(9642);
    const c = await page(9642, CHOOSER);
    await c.until(`document.querySelectorAll('.chooser-card svg').length === 2 && document.visibilityState === 'visible'`, 'chooser drawn');
    const st = await chooserState(c);
    check(st.cards.length === 2 && st.cards[0].name === `${PRODUCT} Code` && st.cards[1].name === `${PRODUCT} Craft` && st.cards.every((x) => x.icon && x.sub),
      `the chooser shows a Code and a Craft card with icons (${S(st.cards)})`);
    check(Math.abs(st.w - 640) <= 20 && Math.abs(st.h - 380) <= 20, `the chooser is about 640x380 (${st.w}x${st.h})`);
    check(S(st.api) === S(['close', 'loadSettingsSync', 'localeSync', 'pick', 'saveSettingsSync']) && st.ide === 'undefined', `the chooser page gets only its own calls (${S(st.api)})`);
    check(st.focused === 'chooseCode' && !(await c.js(`document.body.textContent.toLowerCase().includes('remember')`)), 'the Code card has the focus; there is no remember option');
    check(S(await pages(9642)).match(/index\.html/) === null, 'no main window opens while the chooser is up');
    console.log(`screenshot: ${await c.shot('chooser.png')}`);
    await c.click('#chooseCode');
    const ide = await page(9642, IDE);
    await ide.until('window.__ideReady === true', 'IDE ready after Code');
    const s = await ide.js(`({ mode: ide.appMode, craft: document.body.classList.contains('app-craft'), title: document.title, toolbar: getComputedStyle(document.getElementById('toolbar')).display,
      probe: !!window.__probeLoaded, def: !!window.__defaultProbeLoaded, scripts: [...document.querySelectorAll('script[data-plugin]')].map((n) => n.dataset.plugin) })`);
    check(s.mode === 'code' && !s.craft && s.toolbar !== 'none' && s.title === `${PRODUCT} Code`, `the Code card opens the IDE in code mode (${S({ mode: s.mode, title: s.title, toolbar: s.toolbar })})`);
    await sleep(500);
    check(!(await pages(9642)).some((u) => CHOOSER.test(u)), 'the chooser closed');
    check(s.def && !s.probe && s.scripts.includes('vcs') && s.scripts.includes('minecraft') && !s.scripts.includes('craft-probe'),
      `code mode loads the code plugins, Minecraft and a user plugin without "modes", not a craft-only one (${s.scripts.length} scripts)`);
    const ipc = await ide.js(`Promise.all([ide.api.invoke('db:drivers').then(() => 'ok', (e) => String(e.message)), ide.api.invoke('craft-probe:hello').then(() => 'ok', (e) => String(e.message))])`);
    check(ipc[0] === 'ok' && /No handler registered/.test(ipc[1]), `code mode registers code main modules and not a craft-only plugin's (${S(ipc)})`);
    ide.close();
    run.kill();
  }

  // ---------- Esc on the chooser quits ----------
  {
    const run = start(9643);
    const c = await page(9643, CHOOSER);
    await c.until(`document.querySelectorAll('.chooser-card svg').length === 2`, 'chooser drawn');
    await c.key('Escape', 27);
    const code = await Promise.race([run.exited, sleep(10000).then(() => 'timeout')]);
    check(code !== 'timeout', `Esc on the chooser quits the app (exit ${code})`);
    check(!existsSync(run.craft), 'nothing created the craft workspace');
    run.kill();
  }

  // ---------- the chooser in Korean, then its Craft card ----------
  {
    const run = start(9644, { lang: 'ko-KR' });
    const c = await page(9644, CHOOSER);
    await c.until(`document.querySelectorAll('.chooser-card svg').length === 2 && document.visibilityState === 'visible'`, 'chooser drawn');
    const st = await chooserState(c);
    check(st.cards[0].sub === 'Python·웹 개발' && st.cards[1].sub === '마인크래프트 플레이·서버' && (await c.js(`document.getElementById('chooserClose').title`)) === '닫기',
      `the chooser speaks Korean (${S(st.cards.map((x) => x.sub))})`);
    console.log(`screenshot: ${await c.shot('chooser-ko.png')}`);
    await c.click('#chooseCraft');
    const ide = await page(9644, IDE);
    await ide.until('window.__ideReady === true', 'IDE ready after Craft');
    const s = await ide.js(`({ mode: ide.appMode, craft: document.body.classList.contains('app-craft'), root: ide.root, ready: window.__craftReady, title: document.title })`);
    check(s.mode === 'craft' && s.craft && s.title === `${PRODUCT} Craft`, `the Craft card opens the craft window (${S({ mode: s.mode, title: s.title })})`);
    check(s.root?.toLowerCase() === run.craft.toLowerCase() && existsSync(run.craft) && s.ready?.length === 1, `it opens the craft workspace and fires craftReady (${S(s)})`);
    ide.close();
    run.kill();
  }

  // ---------- --mode=craft in detail ----------
  {
    const data = userData();
    const craft = path.join(tempDir('app-mode-home'), 'Craft Home');
    const t = await launch({ fixture: 'core', port: 9645, name: 'app-mode', mode: 'craft', userData: data, env: { PYIDE_CRAFT_HOME: craft, PYIDE_TRUST_ALL: '0' } });
    const { js } = t;
    const s = await js(`({ mode: ide.appMode, root: ide.root, trusted: ide.trusted, title: document.title, ready: window.__craftReady, dialogs: document.querySelectorAll('.dialog').length,
      trustBar: !document.getElementById('trustBar').classList.contains('hidden') })`);
    check(s.mode === 'craft' && s.title === `${PRODUCT} Craft`, `--mode=craft opens the craft window without the chooser (${S({ mode: s.mode, title: s.title })})`);
    check(existsSync(craft) && s.root?.toLowerCase() === craft.toLowerCase(), `the craft workspace is created and opened as the project, not the path argument (${s.root})`);
    const trusted = JSON.parse(readFileSync(path.join(data, 'trusted-projects.json'), 'utf8'));
    check(s.trusted && !s.dialogs && !s.trustBar && trusted.includes(craft.toLowerCase()), `it is trusted without the Trust question (${S({ trusted: s.trusted, dialogs: s.dialogs, list: trusted })})`);
    check(S(s.ready) === S([{ host: 'craftHost', root: s.root }]), `craftReady fires once, with #craftHost, after the workspace is open (${S(s.ready)})`);

    const ui = await js(`(() => {
      const shown = (id) => { const n = document.getElementById(id); return !!n && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0; };
      const host = document.getElementById('craftHost').getBoundingClientRect();
      const status = document.getElementById('status').getBoundingClientRect();
      return { hidden: ['toolbar', 'mainMenuBtn', 'runWidget', 'stripe', 'stripeRight', 'sidePanel', 'editorArea', 'statusInterp', 'statusPath', 'statusEncodingSlot'].filter(shown),
        host: { x: host.x, y: host.y, w: host.width, h: host.height }, win: { w: innerWidth, h: innerHeight }, statusTop: status.top,
        bottom: shown('bottom'), status: shown('status'),
        items: [...document.querySelectorAll('#statusItems > *')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.id),
        tabs: document.querySelectorAll('.group-tabs').length && shown('editorGroups') };
    })()`);
    check(!ui.hidden.length && !ui.tabs, `the IDE chrome is hidden: menu, toolbar, run widget, stripes, project panel, editor area and tabs (${S(ui.hidden)})`);
    check(ui.host.x === 0 && ui.host.y === 0 && Math.abs(ui.host.w - ui.win.w) <= 1 && Math.abs(ui.host.y + ui.host.h - ui.statusTop) <= 1 && ui.status,
      `#craftHost fills the window above the status bar (${S({ host: ui.host, win: ui.win, statusTop: ui.statusTop })})`);
    check(ui.items.every((id) => ['bgTasks', 'ideErrors', 'updateStatus', 'installerStatus'].includes(id)), `the status bar keeps only tasks, IDE errors, updates and installs (${S(ui.items)})`);
    check(!ui.bottom, 'the bottom tool windows start collapsed');
    await t.sleep(1500);
    const errors = await js(`ide.api.invoke('diagnostics:errors')`);
    check(Array.isArray(errors) && !errors.length, `craft starts without IDE internal errors (${S(errors?.map?.((e) => e.title))})`);
    console.log(`screenshot: ${await t.shot('craft-empty.png')}`);
    await js(`ide.toolWindows.get('Run').show()`);
    const run = await js(`(() => { const b = document.getElementById('bottom').getBoundingClientRect(); return { shown: getComputedStyle(document.getElementById('bottom')).display !== 'none' && b.height > 50, host: document.getElementById('craftHost').getBoundingClientRect().height, tabs: [...document.querySelectorAll('#bottomTabs .bottom-tab:not(.hidden)')].map((n) => n.textContent) }; })()`);
    check(run.shown && run.host > 100 && run.tabs.some((x) => x.startsWith('Run')), `the Run tool window opens under the host for consoles (${S(run)})`);
    await js(`ide.toolWindows.get('Run').hide()`);

    const loaded = await js(`({ scripts: [...document.querySelectorAll('script[data-plugin]')].map((n) => n.dataset.plugin).sort(), list: (await ide.api.invoke('plugins:list')).map((p) => p.id).sort(),
      def: !!window.__defaultProbeLoaded, probe: !!window.__probeLoaded })`);
    const expected = [...CRAFT_PLUGINS, 'craft-probe'].sort();
    check(S(loaded.scripts) === S(expected), `craft loads only the craft plugins and the craft-only user plugin (${S(loaded.scripts)})`);
    check(S(loaded.list) === S(expected) && !loaded.def, `the Plugins list of craft shows the same set, not the code-only plugins (${loaded.list.length})`);
    const ipc = await js(`Promise.all([ide.api.invoke('craft-probe:hello').catch((e) => String(e.message)), ide.api.invoke('db:drivers').then(() => 'ok', (e) => String(e.message)), ide.api.invoke('minecraft:kinds').then((k) => k.length, (e) => String(e.message))])`);
    check(ipc[0] === 'hello from craft' && /No handler registered/.test(ipc[1]) && ipc[2] > 0, `main modules follow the mode: the craft plugin's and Minecraft's load, the database's does not (${S(ipc)})`);

    const fixed = await js(`(async () => { const other = ${S(t.project)}; return { open: await ide.openProject(other), close: await ide.closeProject(), root: ide.root,
      last: localStorage.getItem('lastProject'), recent: ide.settings.get('recentProjects', []).map((p) => p.path) }; })()`);
    check(!fixed.open && !fixed.close && fixed.root?.toLowerCase() === craft.toLowerCase(), `craft keeps its workspace: another project or Close Project is refused (${S({ open: fixed.open, close: fixed.close })})`);
    check(!fixed.last && !fixed.recent.some((p) => p.toLowerCase() === craft.toLowerCase()), `the workspace is not Code mode's last or a recent project (${S(fixed)})`);
    if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
    check(!t.consoleErrors.length, 'no renderer exceptions in craft');

    // A restart (a language change, a plugin turned on) comes back in craft, without the chooser.
    await js(`(ide.restart(), true)`).catch(() => {});
    const gone = Date.now() + 20000;
    const alive = () => { try { process.kill(t.pid, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < gone) await sleep(200);
    check(!alive(), 'the restart quits the running instance');
    t.close();
    let again = null;
    try { again = await page(9645, IDE, 30000); } catch {}
    const after = again && await again.until('window.__ideReady === true', 'IDE ready after restart').then(() => again.js('ide.appMode'), () => null);
    check(after === 'craft' && !(await pages(9645)).some((u) => CHOOSER.test(u)), `a restart keeps craft mode and skips the chooser (${after})`);
    again?.close();
    for (const p of processSnapshot()) if (p.name === 'electron.exe' && p.cmd.includes('--remote-debugging-port=9645')) try { execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }

  // ---------- a path argument without --mode goes to code mode ----------
  {
    const t = await launch({ fixture: 'core', port: 9646, name: 'app-mode-path', mode: null });
    const s = await t.js(`({ mode: ide.appMode, root: ide.root, title: document.title, craft: document.body.classList.contains('app-craft') })`);
    check(s.mode === 'code' && !s.craft && s.root?.toLowerCase() === t.project.toLowerCase() && s.title === `project - ${PRODUCT} Code`,
      `a folder argument opens it in code mode without the chooser (${S(s)})`);
    check(!(await pages(9646)).some((u) => CHOOSER.test(u)), 'no chooser for a path argument');
    t.close();
  }
} catch (err) {
  console.log(`FAIL ${err.stack || err}`);
  results.push(false);
}
// Before verify/lib.mjs removes the temporary folders these instances use.
for (const pid of procs) try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
procs.clear();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
