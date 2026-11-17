// Updates and the Rust Nano Studio Cut. The installer ends every process under the install folder, so before it starts
// main/cut-close.js asks each Cut started from there to close (WM_CLOSE posted to its main window): a Cut with nothing
// unsaved ends its session and exits, one with unsaved changes writes its autosave at once and stays to ask, and the
// update then does not install and says why (the IDE's Restart to Update). Cut's Help › Check for Updates… starts Nano
// Studio with --check-updates, whose start chooser checks at once even when checks at start are off.
// Everything runs on scratch folders: CUT_HOME for Cut, PYIDE_USER_DATA for Electron, a folder feed on this computer.
//   node verify/cut-rust-update.mjs [--cut <nano-studio-cut.exe>]
// The Cut program defaults to the newer of cut-rs\target\{debug,release}\nano-studio-cut.exe.
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachPage, launch, tempDir } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const require = createRequire(import.meta.url);
const cutClose = require('../main/cut-close.js');
const argv = process.argv.slice(2);
const built = ['debug', 'release'].map((p) => path.join(APP_DIR, 'cut-rs', 'target', p, 'nano-studio-cut.exe')).filter(existsSync);
const CUT = argv.includes('--cut') ? path.resolve(argv[argv.indexOf('--cut') + 1]) : built.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (x) => JSON.stringify(x);

let passed = 0, failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const started = new Set();
const kill = (pid) => { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms, step = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
}
// The titles of a process's visible top-level windows (EnumWindows; nothing is sent to them).
const WINDOWS = 'Add-Type -TypeDefinition \'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public static class Wins { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l); [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); public static string[] Of(int id) { var r = new List<string>(); EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (p == id && IsWindowVisible(h)) { var s = new StringBuilder(512); GetWindowText(h, s, 512); r.Add(s.ToString()); } return true; }, IntPtr.Zero); return r.ToArray(); } }\'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Wins]::Of(PID) -join "`n"';
const windowTitles = (pid) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', WINDOWS.replace('PID', String(pid))], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean); } catch { return []; }
};

const work = tempDir('cut-rust-update');
const model = require('../renderer/features/cut/model.js');

// A Cut program on a workspace of its own; open: a project file to open. -> {proc, home}
async function startCut(name, { open = null, env = {} } = {}) {
  const home = path.join(work, name, 'Cut Home');
  mkdirSync(home, { recursive: true });
  const childEnv = { ...process.env, CUT_HOME: home, CUT_OUTPUT_GAIN: '0', ...env };
  for (const k of ['CUT_STUDIO_SETTINGS', 'CUT_STUDIO_APP', 'CUT_STUDIO_VERSION', 'CUT_OPEN']) if (!(k in env)) delete childEnv[k];
  const proc = spawn(CUT, open ? [open] : [], { env: childEnv, stdio: 'ignore', cwd: path.dirname(CUT) });
  started.add(proc.pid);
  const title = await until(() => windowTitles(proc.pid).find((t) => / - Nano Studio Cut$/.test(t)), 60000, 500);
  check(!!title, `${name}: Cut's window is up (${S(title)})`);
  return { proc, home, title };
}
const sessions = (home) => { try { return readdirSync(path.join(home, 'Autosave', '.sessions')); } catch { return []; } };
const latest = (home) => { try { return readdirSync(path.join(home, 'Autosave')).filter((f) => f.endsWith('.latest.ncut')); } catch { return []; } };
// An autosave copy opens unsaved (doc.rs), so the Cut has something to lose.
function autosaveCopy(home) {
  const file = path.join(home, 'Autosave', 'Old Talk-0123abcd-20260101-000000.ncut');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(model.createProject()));
  return file;
}

if (!CUT) {
  check(false, 'a built nano-studio-cut.exe (cargo build -p cut-app in cut-rs)');
} else {
  console.log(`Cut: ${CUT}`);
  const dir = path.dirname(CUT);

  // ---------- a start from Nano Studio: the JavaScript Cut's settings and export leftovers ----------
  {
    const studioDir = path.join(work, 'carry', 'userdata');
    const studioFile = path.join(studioDir, 'settings.json');
    mkdirSync(path.join(studioDir, 'cut-exports'), { recursive: true });
    const studioText = JSON.stringify({ 'appearance.language': 'en', 'appearance.theme': 'light', 'cut.keyPreset': 'classic', 'cut.autosave.minutes': 9, 'cut.layoutSaved': { editing: { sizes: { rows: [1, 2] } } } });
    writeFileSync(studioFile, studioText);
    const part = path.join(work, 'carry', 'talk.mp4.part');
    writeFileSync(part, 'x');
    const journal = path.join(studioDir, 'cut-exports', '4242-abcdef.json');
    writeFileSync(journal, JSON.stringify({ pid: 4242, run: 'abcdef', started: 1, parts: [part] }));
    const c = await startCut('carry', { env: { CUT_STUDIO_SETTINGS: studioFile } });
    check(/^Untitled - Nano Studio Cut$/.test(c.title || ''), `Nano Studio's language (en) is Cut's while Cut has none (${S(c.title)})`);
    const own = await until(() => { try { return JSON.parse(readFileSync(path.join(c.home, '.cut-rs', 'settings.json'), 'utf8')); } catch { return null; } }, 10000);
    check(own?.keyPreset === 'classic' && own?.autosaveMinutes === 9 && own?.studioCarriedOver && !('layoutSaved' in own) && !('language' in own) && !('theme' in own),
      `the cut.* settings are carried into Cut's own file, the layout and appearance are not (${S(own)})`);
    check(readFileSync(studioFile, 'utf8') === studioText, 'Nano Studio\'s settings file is left as it was');
    check(!!(await until(() => !existsSync(part) && !existsSync(journal), 10000)), 'the JavaScript Cut\'s leftover export part and its journal are removed');
    kill(c.proc.pid);
  }

  // ---------- main/cut-close.js ----------
  {
    const clean = await startCut('clean');
    check((await cutClose.runningUnder(dir)).includes(clean.proc.pid), 'a Cut started from the install folder is found');
    check(!(await cutClose.runningUnder(path.join(work, 'elsewhere'))).includes(clean.proc.pid), 'a Cut of another folder is not this update\'s');
    check(sessions(clean.home).length === 1, `a running Cut has its session marker (${S(sessions(clean.home))})`);
    const r = await cutClose.closeAll({ dir, waitMs: 20000 });
    check(r.asked.includes(clean.proc.pid) && !r.left.length && !alive(clean.proc.pid), `a Cut with nothing unsaved closes when asked (${S(r)})`);
    check(sessions(clean.home).length === 0, 'it ended its session as a close does (no crash offered next time)');
  }
  {
    const home = path.join(work, 'dirty', 'Cut Home');
    const dirty = await startCut('dirty', { open: autosaveCopy(home) });
    check(/●/.test(dirty.title || ''), `the autosave copy is open with unsaved changes (${S(dirty.title)})`);
    const t0 = Date.now();
    const r = await cutClose.closeAll({ dir, waitMs: 4000 });
    check(r.left.includes(dirty.proc.pid) && alive(dirty.proc.pid), `a Cut with unsaved changes stays open to ask (${S(r)})`);
    check(Date.now() - t0 < 15000, `asking ends within its wait (${Date.now() - t0} ms)`);
    // the autosave clock writes it 2 s after the change too; tests/installed.rs shows the close request writes it at once
    check(latest(dirty.home).length === 1, `its unsaved work is in the latest autosave (${S(latest(dirty.home))})`);
    check(windowTitles(dirty.proc.pid).some((t) => / ● - Nano Studio Cut$/.test(t)), 'its window is still there with the unsaved work');

    // ---------- the IDE's Restart to Update with that Cut open ----------
    const ctx = await launch({ fixture: 'core', port: 9918, name: 'cut-rust-update-ide',
      env: { PYIDE_UPDATE_TEST: '1', PYIDE_UPDATE_INSTALL_DIR: dir, PYIDE_UPDATE_CUT_WAIT_MS: '3000' } });
    try {
      await ctx.js("ide.api.invoke('updater:testPhase', { phase: 'downloaded', available: '99.0.0', signature: 'verified' })");
      const button = "[...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Restart to Update')";
      await ctx.until(`!!${button}`, 'the Update Ready dialog', 15000);
      await ctx.js(`${button}.click()`);
      await ctx.until("document.body.innerText.includes('Nano Studio Cut is still open, so Nano Studio was not updated.')", 'the refusal', 30000);
      check(true, 'Restart to Update says Cut is open and does not install');
      check(alive(dirty.proc.pid) && alive(ctx.pid), 'neither Cut nor Nano Studio was ended');
    } catch (err) {
      check(false, `Restart to Update with Cut open: ${err.message.split('\n')[0]}`);
    } finally {
      ctx.close();
      kill(ctx.pid);
    }
    kill(dirty.proc.pid);
  }
}

// ---------- --check-updates ----------
const feed = path.join(work, 'feed');
mkdirSync(feed, { recursive: true });
writeFileSync(path.join(feed, 'latest.yml'), 'version: 0.0.1\nfiles:\n  - url: NanoStudio-Setup-0.0.1.exe\n    sha512: AA==\n    size: 1\npath: NanoStudio-Setup-0.0.1.exe\nsha512: AA==\nreleaseDate: 2026-01-01T00:00:00.000Z\n');
function nanoStudio(name, args, env = {}) {
  const userData = path.join(work, name, 'userdata');
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ 'appearance.language': 'en', 'updates.feedUrl': feed, 'updates.checkOnStartup': false }));
  const childEnv = { ...process.env, PYIDE_USER_DATA: userData, ...env };
  delete childEnv.PYIDE_CUT_JS;
  return { userData, env: childEnv, proc: args && spawn(ELECTRON, [APP_DIR, ...args], { env: childEnv, stdio: 'ignore' }) };
}
async function chooserChecks(port, ms) {
  let page = null;
  try { page = await attachPage(port, (t) => t.url.includes('chooser.html'), 30000); } catch {}
  if (!page) return { page: false };
  const state = async () => (await page.cdp('Runtime.evaluate', { expression: 'JSON.stringify(api.updateState())', returnByValue: true })).result?.result?.value;
  const done = await until(async () => { const s = JSON.parse((await state()) || 'null'); return s && s.checks > 0 && s.phase !== 'checking' ? s : null; }, ms, 300);
  const last = done || JSON.parse((await state()) || 'null');
  page.close();
  return { page: true, state: last };
}
{
  const forced = nanoStudio('forced', ['--check-updates', '--remote-debugging-port=9919']);
  started.add(forced.proc.pid);
  const r = await chooserChecks(9919, 20000);
  check(r.page, 'Nano Studio --check-updates opens the start chooser');
  check(r.state?.checks === 1 && r.state?.phase === 'idle' && r.state?.lastCheck, `it checks the feed at once though checks at start are off (${S(r.state && { checks: r.state.checks, phase: r.state.phase, error: r.state.error })})`);
  kill(forced.proc.pid);
  const plain = nanoStudio('plain', ['--remote-debugging-port=9927']);
  started.add(plain.proc.pid);
  const p = await chooserChecks(9927, 5000);
  check(p.page && p.state?.checks === 0, `without it the setting holds: no check (${S(p.state?.checks)})`);
  kill(plain.proc.pid);
}
if (CUT) {
  // Cut's Help › Check for Updates… (the action checkForUpdates, run by CUT_ACTIONS once the window is up).
  const studio = nanoStudio('from-cut', null);
  const cut = await startCut('from-cut', { env: { ...studio.env, CUT_ACTIONS: 'checkForUpdates', CUT_STUDIO_APP: JSON.stringify([ELECTRON, APP_DIR, '--remote-debugging-port=9919']), CUT_STUDIO_VERSION: '9.9.9' } });
  const r = await chooserChecks(9919, 30000);
  check(r.page && r.state?.checks === 1, `Cut's Check for Updates… starts Nano Studio's chooser, which checks (${S(r.state && { checks: r.state.checks, phase: r.state.phase })})`);
  check(alive(cut.proc.pid), 'Cut keeps running meanwhile');
  kill(cut.proc.pid);
}

for (const pid of started) kill(pid);
// Electron started by Cut is not a child of this process: end the one on port 9919 by its command line.
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*remote-debugging-port=9919*' -and $_.CommandLine -like '*--check-updates*' } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8' });
  for (const pid of out.split(/\s+/).filter(Boolean)) kill(Number(pid));
} catch {}
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
