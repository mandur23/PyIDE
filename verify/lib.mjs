// Launches an isolated Nano Studio instance (temp user data + temp copy of a fixture project) and drives it over CDP.
import { spawn, execFileSync, execSync } from 'child_process';
import fs, { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Suites that call main-process modules directly (dotenv, git helpers) run outside the app, where nothing is trusted.
process.env.PYIDE_TRUST_ALL ??= '1';
// Installed copies check GitHub Releases for updates by default; tests never do unless they set a feed.
process.env.PYIDE_UPDATE_FEED ??= 'off';
// The vulnerabilities plugin asks osv.dev about listed packages; tests never do unless they set a (fake) server.
process.env.PYIDE_OSV_URL ??= 'off';
// Installed copies read the plugin Marketplace index from GitHub; tests never do unless they set an index.
process.env.PYIDE_MARKETPLACE_URL ??= 'off';
// New installs follow the OS theme; tests run as if the OS were dark, whatever this machine uses (main/system-theme.js).
process.env.PYIDE_OS_THEME ??= 'dark';
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every launch gets a temp folder (project copy, user data with Chromium's profile: tens of MB). They are removed when
// the suite exits, after its instances are ended, since a later launch in the same suite may reuse one's user data.
// PYIDE_KEEP_TEST_DIRS=1 keeps them for debugging. verify/clean.mjs removes what crashed suites left behind.
const workDirs = new Set();
const runningPids = new Set();
let killedAny = false;
const realMkdtemp = fs.mkdtempSync;
export function tempDir(prefix) {
  const dir = realMkdtemp(path.join(tmpdir(), `pyide-${prefix}-`));
  workDirs.add(dir);
  return dir;
}
// Suites also make their own pyide-* folders in %TEMP% with mkdtempSync: those are removed at exit too.
fs.mkdtempSync = (prefix, ...rest) => {
  const dir = realMkdtemp(prefix, ...rest);
  if (/^pyide-/i.test(path.basename(String(prefix))) && path.resolve(path.dirname(String(prefix))).toLowerCase() === path.resolve(tmpdir()).toLowerCase()) workDirs.add(dir);
  return dir;
};
syncBuiltinESMExports();
// Once an hour, a detached verify/clean.mjs removes old test folders that crashed suites left behind.
try {
  const mark = path.join(tmpdir(), 'pyide-clean.stamp');
  if (!existsSync(mark) || Date.now() - statSync(mark).mtimeMs > 3600000) {
    writeFileSync(mark, String(Date.now()));
    spawn(process.execPath, [path.join(APP_DIR, 'verify', 'clean.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
} catch {}
// The system clipboard: suites copy, cut and Copy Path for real, and the hidden desktop shares the user's clipboard.
// It is saved before a suite's first launch and, when a test window wrote to it (a copy or cut event, the clipboard
// IPC, navigator.clipboard), put back when the last suite running at the same time exits. A run that copies nothing
// leaves it alone, also what the user copies meanwhile. verify/clipboard-keeper.cjs, an Electron script without a
// window, reads and writes it. PYIDE_TEST_CLIPBOARD=off turns this off.
const CLIP_DIR = path.join(tmpdir(), 'pyide-clipboard-keeper');
const CLIP_FILE = path.join(CLIP_DIR, 'snapshot.json');
const CLIP_TOUCHED = path.join(CLIP_DIR, 'touched');
const CLIP_HOLDER = path.join(CLIP_DIR, `holder-${process.pid}`);
let clipUserData = null;
let clipTouched = false;
function markClipboardTouched() {
  if (clipTouched || !existsSync(CLIP_HOLDER)) return;
  clipTouched = true;
  try { writeFileSync(CLIP_TOUCHED, ''); } catch {}
}
// Runs in the IDE page: reports each way the page writes the clipboard through the __pyideClipboardTouched binding.
const CLIPBOARD_HOOK = `(() => {
  if (window.__pyideClipboardHook) return true;
  window.__pyideClipboardHook = true;
  const touched = () => { try { window.__pyideClipboardTouched(''); } catch {} };
  for (const ev of ['copy', 'cut']) document.addEventListener(ev, touched, true);
  const c = navigator.clipboard;
  if (c) for (const m of ['writeText', 'write']) { const f = c[m] && c[m].bind(c); if (f) c[m] = (...a) => { touched(); return f(...a); }; }
  window.ide?.on?.('clipboardWritten', touched);
  return true;
})()`;
// Other suites holding the snapshot: their process still runs and their mark is recent (a pid can be reused).
function otherClipHolders() {
  const holders = [];
  try {
    for (const f of readdirSync(CLIP_DIR)) {
      const pid = Number(/^holder-(\d+)$/.exec(f)?.[1]);
      if (!pid || pid === process.pid) continue;
      let alive = Date.now() - statSync(path.join(CLIP_DIR, f)).mtimeMs < 3 * 3600000;
      if (alive) try { process.kill(pid, 0); } catch (err) { alive = err.code === 'EPERM'; }
      if (alive) holders.push(pid); else rmSync(path.join(CLIP_DIR, f), { force: true });
    }
  } catch {}
  return holders;
}
function clipboardKeeper(mode) {
  const env = { ...process.env, PYIDE_CLIPBOARD_MODE: mode, PYIDE_CLIPBOARD_FILE: CLIP_FILE };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(ELECTRON, [path.join(APP_DIR, 'verify', 'clipboard-keeper.cjs'), `--user-data-dir=${clipUserData}`],
    { env, stdio: 'ignore', windowsHide: true, timeout: 30000 });
}
function saveClipboard() {
  if (clipUserData || process.env.PYIDE_TEST_CLIPBOARD === 'off') return;
  clipUserData = tempDir('clipboard');
  try {
    mkdirSync(CLIP_DIR, { recursive: true });
    // A suite running now saved the user's clipboard already: share its snapshot.
    if (!(otherClipHolders().length && existsSync(CLIP_FILE))) {
      rmSync(CLIP_TOUCHED, { force: true });
      clipboardKeeper('save');
    }
    writeFileSync(CLIP_HOLDER, '');
  } catch (err) {
    console.log(`note: the clipboard could not be saved and will not be restored (${err.message.split('\n')[0]})`);
  }
}
function restoreClipboard() {
  if (!existsSync(CLIP_HOLDER)) return;
  rmSync(CLIP_HOLDER, { force: true });
  if (otherClipHolders().length) return;
  try {
    if (existsSync(CLIP_TOUCHED)) clipboardKeeper('restore');
    rmSync(CLIP_FILE, { force: true });
    rmSync(CLIP_TOUCHED, { force: true });
  } catch (err) { console.log(`note: the clipboard could not be restored (${err.message.split('\n')[0]})`); }
}

process.on('exit', () => {
  for (const pid of runningPids) try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
  if (runningPids.size) killedAny = true;
  restoreClipboard();
  if (process.env.PYIDE_KEEP_TEST_DIRS === '1' || !workDirs.size) return;
  // A killed Electron's GPU and utility processes let go of the profile a moment later.
  if (killedAny) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  for (const dir of workDirs) try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

// ---------- process trees ----------
// Every process on the machine, from one Win32_Process query: [{pid, ppid, name, cmd, created (ms since the epoch, 0 when
// Windows does not say), workingSet (bytes), kernelMs, userMs}].
const SUITE_STARTED = Date.now();
export function processSnapshot() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; ' +
    'created = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; ws = $_.WorkingSetSize; k = $_.KernelModeTime; u = $_.UserModeTime } })'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return JSON.parse(out || '[]').map((r) => ({ pid: r.pid, ppid: r.ppid, name: r.name || '', cmd: r.cmd || '', created: Number(r.created) || 0,
    workingSet: Number(r.ws) || 0, kernelMs: (Number(r.k) || 0) / 1e4, userMs: (Number(r.u) || 0) / 1e4 }));
}
// rootPid's descendants in a snapshot, depth first (the root first with includeRoot, when it is still running). A child
// counts only if it started no earlier than its parent: PIDs are reused, so a system process (csrss, services, …) whose
// long-gone parent had the root's PID would otherwise look like the root's child (seen on the CI runner). When the root
// has exited, its children must have started after `since` (by default, when this suite started).
export function descendants(rows, rootPid, { includeRoot = false, since = SUITE_STARTED } = {}) {
  const kids = new Map();
  for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
  const root = rows.find((r) => r.pid === rootPid);
  const out = [];
  const seen = new Set([rootPid]);
  if (root && includeRoot) out.push(root);
  const walk = (pid, after) => {
    for (const c of kids.get(pid) || []) {
      if (seen.has(c.pid) || !c.created || c.created < after) continue;
      seen.add(c.pid);
      out.push(c);
      walk(c.pid, c.created);
    }
  };
  walk(rootPid, root ? root.created : since);
  return out;
}

// lang: UI language for the run (Chromium --lang); tests default to English regardless of the OS language.
// userData: reuse a user-data directory from an earlier launch (to test what persists across restarts).
// exe: an installed "Nano Studio.exe" to run instead of the source tree; open: a project file to pass instead of the folder.
// projectDir: an existing project folder to open in place, instead of a copy of a fixture; args: extra command-line flags.
// mode: the app mode passed as --mode ('code' by default, so suites skip the start chooser; 'craft'; null for none).
export async function launch({ fixture, port, name = fixture, lang = 'en-US', userData, exe, open, projectDir, env = {}, args: extraArgs = [], mode = 'code' }) {
  saveClipboard();
  const work = tempDir(name);
  const project = projectDir || path.join(work, 'project');
  if (!projectDir) cpSync(path.join(APP_DIR, 'verify', 'fixtures', fixture), project, { recursive: true });
  const outDir = path.join(APP_DIR, 'verify', 'out', name);
  mkdirSync(outDir, { recursive: true });

  const args = [open ? path.join(project, open) : project, `--remote-debugging-port=${port}`, `--lang=${lang}`, ...(mode ? [`--mode=${mode}`] : []), ...extraArgs];
  const spawnedAt = Date.now();
  const child = spawn(exe || ELECTRON, exe ? args : [APP_DIR, ...args], {
    // Suites default to the deterministic semantic and completion backends; real installs would otherwise load their
    // models in every test instance. verify/semantic.mjs and verify/ai-complete.mjs opt in to the real ones.
    // Test instances keep their Claude Code IDE lock files to themselves (a killed instance cannot remove its own).
    // Test projects are temporary copies: trusted, so no Trust and Open Project question (verify/trust.mjs turns it off).
    env: { PYIDE_SEMANTIC_BACKEND: 'fake', PYIDE_AI_COMPLETE_BACKEND: 'fake', PYIDE_TRUST_ALL: '1', PYIDE_CLAUDE_IDE_DIR: path.join(work, 'claude-ide'), ...process.env, ...env, PYIDE_USER_DATA: userData || path.join(work, 'userdata') },
    stdio: 'ignore',
  });
  runningPids.add(child.pid);

  let page;
  for (let i = 0; i < 100 && !page; i++) {
    await sleep(200);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!page) throw new Error(`no CDP page on port ${port}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__pyideClipboardTouched') markClipboardTouched();
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  });
  // Once the window is gone, calls fail instead of waiting forever, so until() times out with its label.
  const GONE = { result: { exceptionDetails: { text: 'the CDP connection closed' } } };
  ws.addEventListener('close', () => { for (const r of pending.values()) r(GONE); pending.clear(); });
  const cdp = (method, params = {}) => new Promise((r) => {
    if (ws.readyState !== WebSocket.OPEN) return r(GONE);
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Runtime.addBinding', { name: '__pyideClipboardTouched' });
  // Test windows run beside other windows; without this, losing OS focus closes Monaco hovers and hints mid-check.
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });

  const js = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expr}\n=> ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const until = async (expr, label, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await js(expr)) return true; } catch {}
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label}`);
  };
  // Real key events through the browser input pipeline (reaches Monaco and the global keymap like a user would).
  const KEYCODES = { F1: 112, F2: 113, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F12: 123, Enter: 13,
    Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Backspace: 8, Shift: 16, '/': 191 };
  const press = async (combo) => {
    const parts = combo.split('+');
    const key = parts.pop();
    const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
    const upper = key.length === 1 ? key.toUpperCase() : key;
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${upper}` : /\d/.test(key) ? `Digit${key}` : key === '/' ? 'Slash' : '') : key;
    const windowsVirtualKeyCode = KEYCODES[key] ?? upper.charCodeAt(0);
    const base = { modifiers: mods, key: key.length === 1 ? (mods & 8 ? upper : key.toLowerCase()) : key, code, windowsVirtualKeyCode };
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(60);
  };
  const type = async (text) => { await cdp('Input.insertText', { text }); await sleep(30); };
  const click = async (selector) => {
    const box = await js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(60);
  };
  const shot = async (file) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    const p = path.join(outDir, file);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    return p;
  };

  const results = [];
  const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
  const close = () => {
    ws.close();
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    runningPids.delete(child.pid);
    killedAny = true;
  };
  const finish = () => {
    close();
    if (consoleErrors.length) console.log(`renderer exceptions:\n  ${consoleErrors.join('\n  ')}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed || consoleErrors.length ? 1 : 0);
  };

  try {
    await until('window.__ideReady === true', 'IDE ready', 30000);
  } catch (err) {
    await cdp('Page.reload');
    await sleep(4000);
    close();
    throw new Error(`IDE never became ready; renderer exceptions after reload:\n  ${consoleErrors.join('\n  ') || '(none)'}`);
  }
  await js(CLIPBOARD_HOOK).catch(() => {});
  return { project, outDir, userData: userData || path.join(work, 'userdata'), pid: child.pid, spawnedAt, cdp, js, until, press, type, click, shot, check, results, consoleErrors, close, finish, sleep };
}

// A page expression, true once every code lens of the file shown in `editor` has its view zone above its line. Code
// vision draws its lenses (empty placeholders first) as view zones a moment after a file shows in an editor pane:
// Monaco asks the providers after a debounce, about a second on a busy machine, and each pane asks on its own. The
// zones push the lines below them down, so a suite that clicks at the screen position of a line waits for this
// before taking the position. True when code vision is off or its plugin is not loaded.
export const lensesShown = (editor = 'ide.editor') => `(() => { const e = ${editor}; const m = e?.getModel();
  if (!m || !ide.codeVision) return true;
  const lh = e.getOption(ide.monaco.editor.EditorOption.lineHeight);
  return [...new Set(ide.codeVision.lenses(m).map((l) => l.line))]
    .every((L) => e.getTopForLineNumber(L) - (L > 1 ? e.getTopForLineNumber(L - 1) : -lh) > lh); })()`;

// Opens a project file in the editor and waits for its tab.
export async function openFile(ctx, relPath) {
  await ctx.js(`ide.openFile(ide.util.joinPath(ide.root, ${JSON.stringify(relPath.replace(/\//g, '\\'))}))`);
  await ctx.until(`ide.activeTab()?.path.toLowerCase().endsWith(${JSON.stringify(relPath.replace(/\//g, '\\').toLowerCase())})`, `tab ${relPath}`);
}

// A row of the open IDE context menu (ide.ui.contextMenu, also the editor's): `level` 0 is the menu, 1 its submenu.
export const menuRow = (label, level = 0) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] > .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === ${JSON.stringify(label)})`;

// Moves the pointer onto each submenu of `path` in the open context menu, as a user does, and clicks its last item:
// clickMenuPath(t, ['Git', 'Show History']).
export async function clickMenuPath(ctx, path) {
  for (const [level, label] of path.entries()) {
    await ctx.until(`!!${menuRow(label, level)}`, `menu item ${path.slice(0, level + 1).join(' › ')}`);
    const p = await ctx.js(`(() => { const r = ${menuRow(label, level)}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    if (level === path.length - 1) for (const type of ['mousePressed', 'mouseReleased']) await ctx.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
}
