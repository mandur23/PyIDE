// Launches an isolated PyIDE instance (temp user data + temp copy of a fixture project) and drives it over CDP.
import { spawn, execSync } from 'child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ fixture, port, name = fixture }) {
  const work = mkdtempSync(path.join(tmpdir(), `pyide-${name}-`));
  const project = path.join(work, 'project');
  cpSync(path.join(APP_DIR, 'verify', 'fixtures', fixture), project, { recursive: true });
  const outDir = path.join(APP_DIR, 'verify', 'out', name);
  mkdirSync(outDir, { recursive: true });

  const child = spawn(ELECTRON, [APP_DIR, project, `--remote-debugging-port=${port}`], {
    env: { ...process.env, PYIDE_USER_DATA: path.join(work, 'userdata') },
    stdio: 'ignore',
  });

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
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cdp('Runtime.enable');

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
  };
  const finish = () => {
    close();
    if (consoleErrors.length) console.log(`renderer exceptions:\n  ${consoleErrors.join('\n  ')}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed || consoleErrors.length ? 1 : 0);
  };

  await until('window.__ideReady === true', 'IDE ready', 30000);
  return { project, outDir, cdp, js, until, press, type, click, shot, check, results, consoleErrors, close, finish, sleep };
}

// Opens a project file in the editor and waits for its tab.
export async function openFile(ctx, relPath) {
  await ctx.js(`ide.openFile(ide.util.joinPath(ide.root, ${JSON.stringify(relPath.replace(/\//g, '\\'))}))`);
  await ctx.until(`ide.activeTab()?.path.toLowerCase().endsWith(${JSON.stringify(relPath.replace(/\//g, '\\').toLowerCase())})`, `tab ${relPath}`);
}
