// Every way of opening Nano Studio Cut starts the Rust program (main/cut-launcher.js): --mode=cut, --mode=cut with a
// project, a .ncut file argument (absolute and relative), the start chooser's Cut card, a second launch. The program is a
// stand-in that records its arguments and environment (verify/cut-launch-stub.cs, compiled with the .NET Framework's
// csc.exe), named by PYIDE_CUT_EXE: it gets the project, CUT_HOME, CUT_SIDECAR_DIR with the three Python servers,
// CUT_CLAUDE_PATH and CUT_STUDIO_SETTINGS, and outlives Electron, which leaves no window or process behind. A start that
// fails (no program, a crash, an exit code) shows a message box and logs why; a clean early exit shows nothing.
// Then the real nano-studio-cut.exe, when there is one: it starts on the project in the Cut workspace it was given.
//   node verify/cut-rust-launch.mjs [--stub | --real] [--exe <Nano Studio.exe>]
// --exe tests a built app (dist\win-unpacked) instead of the source tree; its real Cut is resources\cut\nano-studio-cut.exe.
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachPage, descendants, processSnapshot, tempDir } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const argv = process.argv.slice(2);
const exeArg = argv.includes('--exe') ? path.resolve(argv[argv.indexOf('--exe') + 1]) : null;
const only = argv.includes('--stub') ? 'stub' : argv.includes('--real') ? 'real' : null;
const REAL = exeArg ? path.join(path.dirname(exeArg), 'resources', 'cut', 'nano-studio-cut.exe') : path.join(APP_DIR, 'cut-rs', 'target', 'release', 'nano-studio-cut.exe');
const SIDECARS = ['whisper_server.py', 'voice_server.py', 'speaker_server.py'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (x) => JSON.stringify(x);
// 8.3 short names (RUNNER~1 on a GitHub runner) and long ones are one folder.
const long = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
const same = (a, b) => !!a && !!b && long(a).toLowerCase() === long(b).toLowerCase();

let passed = 0, failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const started = new Set();
const kill = (pid) => { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms, step = 150) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
}

// The stand-in, built once per run.
const work = tempDir('cut-rust-launch');
const STUB = path.join(work, 'stub', 'nano-studio-cut.exe');
function buildStub() {
  mkdirSync(path.dirname(STUB), { recursive: true });
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(csc, ['/nologo', '/target:winexe', `/out:${STUB}`, path.join(APP_DIR, 'verify', 'cut-launch-stub.cs')], { stdio: 'pipe' });
}

// One Nano Studio run: Electron with these arguments, a fresh user data folder with settings, and the Cut workspace.
// -> {proc, userData, home, records(), exited (Promise of the exit code), logText()}
function run(name, { args = [], env = {}, cwd = work, settings = { 'appearance.language': 'en' }, stub = true } = {}) {
  const dir = path.join(work, name);
  const userData = path.join(dir, 'userdata');
  const home = path.join(dir, 'Cut Home');
  const records = path.join(dir, 'records');
  mkdirSync(userData, { recursive: true });
  mkdirSync(records, { recursive: true });
  if (settings) writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const full = exeArg ? [...args, '--pyide-test-env'] : [APP_DIR, ...args];
  const childEnv = { ...process.env, PYIDE_USER_DATA: userData, PYIDE_CUT_HOME: home, CUT_STUB_DIR: records, PYIDE_CLAUDE_PATH: FAKE_CLAUDE, ...(stub ? { PYIDE_CUT_EXE: STUB } : {}), ...env };
  delete childEnv.PYIDE_CUT_JS;
  if (!stub) delete childEnv.PYIDE_CUT_EXE;
  const proc = spawn(exeArg || ELECTRON, full, { cwd, env: childEnv, stdio: 'ignore' });
  started.add(proc.pid);
  const exited = new Promise((r) => { proc.once('exit', (code) => r(code)); });
  const read = () => readdirSync(records).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(records, f), 'utf8')));
  const logText = () => { try { return readFileSync(path.join(userData, 'logs', 'pyide.log'), 'utf8'); } catch { return ''; } };
  return { proc, userData, home, records: read, exited, logText };
}
const settled = (p, ms) => Promise.race([p, sleep(ms).then(() => 'still running')]);
// The titles of the visible top-level windows of a process, read with EnumWindows (Get-Process's MainWindowTitle may
// name one of Chromium's hidden windows instead). Nothing is sent to them.
const WINDOWS = 'Add-Type -TypeDefinition \'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public static class Wins { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l); [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); public static string[] Of(int id) { var r = new List<string>(); EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (p == id && IsWindowVisible(h)) { var s = new StringBuilder(512); GetWindowText(h, s, 512); r.Add(s.ToString()); } return true; }, IntPtr.Zero); return r.ToArray(); } }\'; [Wins]::Of(PID) -join "`n"';
const windowTitles = (pid) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', WINDOWS.replace('PID', String(pid))], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean); } catch { return []; }
};
// Electron processes of a run that are still there (its main process, GPU and utility processes).
const electronsOf = (r) => descendants(processSnapshot(), r.proc.pid, { includeRoot: true }).filter((p) => /^(electron|Nano Studio)\.exe$/i.test(p.name));

const FAKE_CLAUDE = path.join(work, 'claude', 'claude.exe');
mkdirSync(path.dirname(FAKE_CLAUDE), { recursive: true });
writeFileSync(FAKE_CLAUDE, '');
const PROJECT = path.join(work, 'projects', 'Launch Demo.ncut');
mkdirSync(path.dirname(PROJECT), { recursive: true });
{
  const model = (await import('module')).createRequire(import.meta.url)('../renderer/features/cut/model.js');
  writeFileSync(PROJECT, JSON.stringify(model.createProject()));
}

// A start the stand-in records: one record, Electron gone within the watch time plus a margin, the stand-in still alive.
async function startsCut(r, label, { project = null } = {}) {
  const rec = await until(() => r.records()[0], 20000);
  check(!!rec, `${label}: the Cut program starts`);
  if (!rec) return null;
  started.add(rec.pid);
  check(project ? rec.args.length === 1 && same(rec.args[0], project) : rec.args.length === 0, `${label}: ${project ? 'the project is its argument' : 'no project argument'} (${S(rec.args)})`);
  const code = await settled(r.exited, 15000);
  check(code === 0, `${label}: Electron quits by itself, exit code 0 (${code})`);
  check(alive(rec.pid), `${label}: the Cut program outlives Electron (pid ${rec.pid})`);
  const left = electronsOf(r);
  check(!left.length, `${label}: no Electron process stays behind (${S(left.map((p) => p.name))})`);
  return rec;
}

if (only !== 'real') {
  buildStub();
  check(existsSync(STUB), 'the stand-in program is built');

  // ---------- --mode=cut ----------
  {
    const r = run('mode', { args: ['--mode=cut'], settings: { 'appearance.language': 'en', 'app.lastMode': 'code' } });
    const rec = await startsCut(r, '--mode=cut');
    if (rec) {
      check(same(rec.env.CUT_HOME, r.home) && existsSync(r.home), `CUT_HOME is the Cut workspace, created (${rec.env.CUT_HOME})`);
      const dir = rec.env.CUT_SIDECAR_DIR;
      const expected = exeArg ? path.join(path.dirname(exeArg), 'resources', 'cut', 'sidecars') : path.join(APP_DIR, 'main', 'ai');
      check(same(dir, expected) && SIDECARS.every((f) => existsSync(path.join(dir, f))), `CUT_SIDECAR_DIR holds ${SIDECARS.join(', ')} (${dir})`);
      check(same(rec.env.CUT_CLAUDE_PATH, FAKE_CLAUDE), `CUT_CLAUDE_PATH is the Claude Code CLI Code finds (${rec.env.CUT_CLAUDE_PATH})`);
      check(same(rec.env.CUT_STUDIO_SETTINGS, path.join(r.userData, 'settings.json')), `CUT_STUDIO_SETTINGS is Nano Studio's settings file (${rec.env.CUT_STUDIO_SETTINGS})`);
      let studioApp = null;
      try { studioApp = JSON.parse(rec.env.CUT_STUDIO_APP); } catch {}
      const appCmd = exeArg ? [exeArg, '--pyide-test-env'] : [ELECTRON, APP_DIR];
      check(Array.isArray(studioApp) && studioApp.length === appCmd.length && studioApp.every((a, i) => same(a, appCmd[i]) || a === appCmd[i]), `CUT_STUDIO_APP starts this Nano Studio again (${rec.env.CUT_STUDIO_APP})`);
      const version = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
      check(exeArg ? /^\d+\.\d+\.\d+/.test(rec.env.CUT_STUDIO_VERSION || '') : rec.env.CUT_STUDIO_VERSION === version, `CUT_STUDIO_VERSION is its version (${rec.env.CUT_STUDIO_VERSION})`);
      check(!rec.env.PYIDE_CUT_JS, 'the JavaScript Cut is not asked for');
      check(same(rec.cwd, path.dirname(STUB)), `it runs in its own folder (${rec.cwd})`);
      const saved = JSON.parse(readFileSync(path.join(r.userData, 'settings.json'), 'utf8'));
      check(saved['app.lastMode'] === 'cut' && saved['appearance.language'] === 'en', `the chooser will offer Cut first next time, other settings kept (${S(saved)})`);
      check(/#cut.*starting .*nano-studio-cut\.exe/.test(r.logText()) && /Cut running \(pid \d+\)/.test(r.logText()), 'the IDE log says what was started and that it runs');
    }
  }

  // ---------- --mode=cut with a project, a .ncut argument, a relative one ----------
  await startsCut(run('mode-project', { args: ['--mode=cut', PROJECT] }), '--mode=cut <project>', { project: PROJECT });
  await startsCut(run('file', { args: [PROJECT] }), 'a .ncut file argument', { project: PROJECT });
  await startsCut(run('relative', { args: [path.basename(PROJECT)], cwd: path.dirname(PROJECT) }), 'a relative .ncut argument (Open with, from its folder)', { project: PROJECT });
  {
    const r = run('folder', { args: ['--mode=cut', path.dirname(PROJECT)] });
    await startsCut(r, '--mode=cut <folder>');
  }

  // ---------- the start chooser ----------
  {
    const r = run('chooser', { args: ['--remote-debugging-port=9908'] });
    let page = null;
    try { page = await attachPage(9908, (t) => t.url.includes('chooser.html'), 20000); } catch {}
    check(!!page, 'the start chooser opens');
    if (page) {
      const value = async (expression) => (await page.cdp('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
      // The Dock grows the icon under the pointer: point at the card, let it grow, then press where it is now.
      const center = 'JSON.stringify((({ x, y, width, height }) => ({ x: x + width / 2, y: y + height / 2 }))(document.getElementById("chooseCut").getBoundingClientRect()))';
      const first = await until(() => value(`document.readyState === 'complete' && !!document.getElementById('chooseCut') && ${center}`), 10000);
      check(!!first, 'the chooser shows the Cut card');
      if (first) {
        const a = JSON.parse(first);
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
        await sleep(400);
        const b = JSON.parse(await value(center));
        const under = await value(`!!document.elementFromPoint(${b.x}, ${b.y})?.closest('#chooseCut')`);
        check(under, 'the pointer is on the Cut card');
        await page.click(b.x, b.y);
      }
      page.close();
      await startsCut(r, 'the chooser\'s Cut card');
    }
  }

  // ---------- a second launch while one runs ----------
  {
    const a = run('second-a', { args: ['--mode=cut'], env: { CUT_STUB_MS: '40000' } });
    const ra = await startsCut(a, 'a first Cut');
    const b = run('second-b', { args: ['--mode=cut', PROJECT] });
    const rb = await startsCut(b, 'a second launch meanwhile', { project: PROJECT });
    check(ra && rb && ra.pid !== rb.pid && alive(ra.pid) && alive(rb.pid), 'a second launch is a second Cut beside the first, as with the JavaScript Cut');
  }

  // ---------- starts that do not work ----------
  // A message box (its title is the process's window title), the reason in the IDE log, Electron waiting on the box.
  async function tells(r, label, re) {
    const why = await until(() => re.exec(r.logText()), 15000);
    check(!!why, `${label}: the IDE log says why (${why?.[0] || r.logText().split(/\r?\n/).filter((l) => /#cut/.test(l)).join(' | ')})`);
    const title = await until(() => windowTitles(r.proc.pid).includes('Nano Studio Cut'), 10000, 300);
    check(!!title, `${label}: a message box says so (Electron's windows ${S(windowTitles(r.proc.pid))})`);
    check(await settled(r.exited, 1000) === 'still running', `${label}: Electron waits for the box to be closed`);
    kill(r.proc.pid);
  }
  await tells(run('missing', { args: ['--mode=cut'], env: { PYIDE_CUT_EXE: path.join(work, 'nowhere', 'nano-studio-cut.exe') } }),
    'no program', /Nano Studio Cut could not start\. The program is missing: \S*nowhere\\nano-studio-cut\.exe/);
  await tells(run('crash', { args: ['--mode=cut'], env: { CUT_STUB_MS: '300', CUT_STUB_EXIT: String(0xC0000005 | 0) } }),
    'a crash at start', /could not start\. It ended right after starting, with exit code 0xC0000005\./);
  await tells(run('crash-ko', { args: ['--mode=cut'], settings: { 'appearance.language': 'ko' }, env: { CUT_STUB_MS: '300', CUT_STUB_EXIT: '2' } }),
    'an exit code, in Korean', /Nano Studio Cut 프로그램을 시작하지 못했습니다\. 시작하자마자 끝났습니다\. 종료 코드: 2/);
  {
    const r = run('quick', { args: ['--mode=cut'], env: { CUT_STUB_MS: '300', CUT_STUB_EXIT: '0' } });
    const code = await settled(r.exited, 15000);
    check(code === 0 && r.records().length === 1 && !/could not start/.test(r.logText()), `a program that ends at once without an error: no message, Electron quits (${code})`);
  }
}

// ---------- the real program ----------
if (only !== 'stub') {
  if (!existsSync(REAL)) {
    if (only === 'real') check(false, `the real Cut program exists (${REAL})`);
    else console.log(`note: no ${REAL}; the real program is not started (cargo build --release -p cut-app in cut-rs)`);
  } else {
    const r = run('real', { args: ['--mode=cut', PROJECT], stub: false, env: { CUT_OUTPUT_GAIN: '0' } });
    const proc = await until(() => processSnapshot().find((p) => /^nano-studio-cut\.exe$/i.test(p.name) && p.cmd.toLowerCase().includes(PROJECT.toLowerCase())), 30000, 500);
    check(!!proc && same(realpathSync.native(proc.cmd.match(/^"?([^"]+?\.exe)"?/i)?.[1] || ''), realpathSync.native(REAL)), `the real nano-studio-cut.exe starts with the project (${proc?.cmd})`);
    if (proc) {
      started.add(proc.pid);
      const title = await until(() => windowTitles(proc.pid).find((t) => /^Launch Demo.* - Nano Studio Cut$/.test(t)), 30000, 500);
      check(!!title, `its window opens the project (${S(title || windowTitles(proc.pid))})`);
      check(['Projects', 'Autosave', 'Cache'].every((d) => existsSync(path.join(r.home, d))), `it works in the Cut workspace it was given (${r.home})`);
      const code = await settled(r.exited, 15000);
      check(code === 0 && !electronsOf(r).length, `Electron quits and leaves no process (${code})`);
      check(alive(proc.pid), 'the Cut program keeps running');
      kill(proc.pid);
    }
  }
}

for (const pid of started) kill(pid);
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
