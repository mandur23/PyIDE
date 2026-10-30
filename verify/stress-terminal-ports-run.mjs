// Hostile use of the terminal's venv activation, port sharing, Rerun on Save, Sync Python Requirements, Build
// Executable and dragging files out of the project tree. Terminals: venv paths with spaces, Korean, emoji, quotes,
// & % ^ ! ( ) ; $ and 200+ characters, two paths built to inject a command (one for cmd, one for PowerShell), activate
// scripts missing, empty or broken, an interpreter that is not a venv, the interpreter switched while terminals are
// open, 20 terminals at once, a shell that does not exist and odd session options. Ports: port numbers out of range or
// not numbers, one port shared three times at once, Stop Sharing while the server is probed and while the tunnel
// starts, and a tunnel tool that crashes, exits, hangs or prints garbage (an offline stand-in). Rerun on Save: 50 saves
// in a row against a program that never exits and one that floods its output. Requirements: a requirements.txt with
// a BOM, CRLF, -r include loops, lines that are not requirements, a requirement continued over two lines and 3000
// entries. Build Executable: names that leave dist, Korean names, a missing script or data file and a failing build.
// Tree drag-out: 300 files, some deleted before main gets them, and entries that are not paths.
// The IDE is started as from the desktop, its PATH variable named "Path". Port 8640; servers on 28641-28649.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { descendants, launch, openFile, processSnapshot } from './lib.mjs';

const S = JSON.stringify;
const L = (...p) => path.join(...p);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-stress-tpr-'));
// Windows names it Path; a shell started from Explorer gets it that way, not as PATH.
{ const p = process.env.PATH; delete process.env.PATH; process.env.Path = p; }

// ---------- venvs ----------
const basePython = execFileSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
// Python refuses to create a venv whose path has a ; (it splits PATH), but one can be moved there: it is made next to
// it and moved, with activate.bat naming its new place as if it had been made there.
let moved = 0;
const mkvenv = (dir) => {
  const at = dir.includes(';') ? L(scratch, `made-${++moved}`, 'venv') : dir;
  execFileSync('py', ['-3', '-m', 'venv', '--without-pip', at], { stdio: 'ignore' });
  if (at !== dir) {
    mkdirSync(path.dirname(dir), { recursive: true });
    renameSync(at, dir);
    const bat = L(dir, 'Scripts', 'activate.bat');
    writeFileSync(bat, readFileSync(bat, 'utf8').split(at).join(dir));
  }
  return dir;
};
const V = {
  weird: path.join(scratch, "w 한글 😀 it's & ^ ! (a) $HOME", 'venv'),
  // A Scripts folder with a ; in its path cannot be found through PATH (no shell can), so its python is not asked.
  semicolon: path.join(scratch, "s 한글 😀 it's & ; x", 'venv'),
  percent: path.join(scratch, 'p 100% %OS% x', 'venv'),
  // No spaces: a command line leaves it unquoted, and cmd would run what follows the &.
  injCmd: path.join(scratch, 'inj&mkdir;INJ_CMD', 'venv'),
  // PowerShell takes ’ (U+2019) as a single quote too: the subexpression would run.
  injPs: path.join(scratch, 'ps’$(New-Item -ItemType Directory INJ_PS)’x', 'venv'),
  caret: path.join(scratch, 'c^a(r)et!', 'venv'),
  long: path.join(scratch, `long-${'x'.repeat(90)}`, 'y'.repeat(50), 'venv'),
  missing: path.join(scratch, 'missing', 'venv'),
  empty: path.join(scratch, 'empty', 'venv'),
  broken: path.join(scratch, 'broken', 'venv'),
};
for (const dir of Object.values(V)) mkvenv(dir);
const scriptsOf = (v) => path.join(v, 'Scripts');
for (const f of ['Activate.ps1', 'activate.bat']) rmSync(path.join(scriptsOf(V.missing), f));
for (const f of ['Activate.ps1', 'activate.bat']) writeFileSync(path.join(scriptsOf(V.empty), f), '');
writeFileSync(path.join(scriptsOf(V.broken), 'Activate.ps1'), 'function Broken { if ( { ]] \n');
writeFileSync(path.join(scriptsOf(V.broken), 'activate.bat'), '@echo off\r\nif ( (\r\n');
const swA = mkvenv(path.join(scratch, 'sw', 'venv-a'));
const swB = mkvenv(path.join(scratch, 'sw', 'venv-b'));
const termCwd = path.join(scratch, 'cwd');
mkdirSync(termCwd);

// ---------- the project: a venv with a stand-in PyInstaller ----------
const project = path.join(scratch, 'project');
mkdirSync(project);
const projectVenv = mkvenv(path.join(project, '.venv'));
const fakeInstaller = path.join(projectVenv, 'Lib', 'site-packages', 'PyInstaller');
mkdirSync(fakeInstaller, { recursive: true });
writeFileSync(path.join(fakeInstaller, '__init__.py'), '__version__ = "6.99.0"\n');
writeFileSync(path.join(fakeInstaller, '__main__.py'), `import argparse, json, os, sys
p = argparse.ArgumentParser()
for flag in ('--noconfirm', '--clean', '--onefile', '--onedir', '--windowed'):
    p.add_argument(flag, action='store_true')
for opt in ('--name', '--distpath', '--workpath', '--specpath', '--icon'):
    p.add_argument(opt)
p.add_argument('--add-data', action='append', default=[])
p.add_argument('script')
a = p.parse_args()
with open(os.environ['PYIDE_FAKE_PYINSTALLER_LOG'], 'a', encoding='utf-8') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if a.name == 'Broken':
    print('ERROR: something went wrong', file=sys.stderr)
    sys.exit(1)
out = os.path.join(a.distpath, a.name) if a.onedir else a.distpath
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, a.name + '.exe'), 'wb') as f:
    f.write(b'MZ stand-in')
print('INFO: Build complete!')
`);
const runsLog = path.join(scratch, 'runs.log');
// A program that never exits and does not stop for Ctrl+C or Ctrl+Break.
writeFileSync(path.join(project, 'app.py'), `import os, signal, time
for s in ('SIGINT', 'SIGBREAK', 'SIGTERM'):
    if hasattr(signal, s): signal.signal(getattr(signal, s), signal.SIG_IGN)
with open(${S(runsLog)}, 'a') as f:
    f.write('app %d\\n' % os.getpid())
print('app started', flush=True)
while True:
    time.sleep(1)
`);
writeFileSync(path.join(project, 'flood.py'), `import os
with open(${S(runsLog)}, 'a') as f:
    f.write('flood %d\\n' % os.getpid())
line = 'flood ' + 'x' * 300
while True:
    print(line, flush=True)
`);
writeFileSync(path.join(project, 'settings.py'), 'VALUE = 0\n');
writeFileSync(path.join(project, 'main.py'), 'import requests\nimport yaml\nprint("hello")\n');
const reqFile = path.join(project, 'requirements.txt');
const reqLines = ['﻿requests>=2', '-r requirements.txt', '-r requirements-dev.txt', '!!! not a requirement', '==1.0', 'broken[extra>=1',
  '-e .', './local-pkg', 'https://example.invalid/x.whl', 'multi \\', '    >=1.0', ...Array.from({ length: 3000 }, (_, i) => `pkg-${i}==1.0`)];
writeFileSync(reqFile, `${reqLines.join('\r\n')}\r\n`);
writeFileSync(path.join(project, 'requirements-dev.txt'), '-r requirements.txt\n-r requirements-dev.txt\nPyYAML>=6\n');
mkdirSync(path.join(project, 'assets'));
mkdirSync(path.join(project, 'many'));
for (let i = 0; i < 300; i++) writeFileSync(path.join(project, 'many', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);

// ---------- stand-in tunnel tool ----------
const fakeTool = path.join(scratch, 'fake-tunnel.cjs');
const modeFile = path.join(scratch, 'tunnel-mode.txt');
writeFileSync(modeFile, 'ok');
writeFileSync(fakeTool, `const fs = require('fs');
const kind = process.argv[2];
const mode = fs.readFileSync(${S(modeFile)}, 'utf8').trim();
const port = (process.argv.join(' ').match(/(?:localhost|\\]):(\\d+)|local (\\d+)/) || []).slice(1).find(Boolean);
setInterval(() => {}, 1000);
if (mode === 'ok') setTimeout(() => process.stderr.write(kind === 'bore' ? 'INFO listening at bore.pub:40' + port.slice(-3) + '\\n'
  : 'INF |  https://fake-' + port + '.trycloudflare.com  |\\nINF Registered tunnel connection connIndex=0\\n'), 300);
if (mode === 'crash') setTimeout(() => { process.stderr.write('panic: boom\\n'); process.exit(3); }, 200);
if (mode === 'exit0') process.exit(0);
if (mode === 'garbage') {
  let n = 0;
  const t = setInterval(() => {
    const b = Buffer.alloc(65536);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7919 + n * 104729) & 0xff;
    process.stdout.write(b);
    process.stderr.write('\\x1b[31m\\x00\\x1b]0;title\\x07' + 'https://not-a-tunnel.example.com '.repeat(50) + '\\n');
    if (++n >= 48) clearInterval(t);
  }, 10);
}
`);

const env = {
  PYIDE_CLOUDFLARED: S([process.execPath, fakeTool, 'cloudflared']), PYIDE_BORE: S([process.execPath, fakeTool, 'bore']),
  PYIDE_INSTALL_ROOT: L(scratch, 'install-root'), PYIDE_FAKE_PYINSTALLER_LOG: L(scratch, 'pyinstaller.jsonl'),
};
const t = await launch({ name: 'stress-terminal-ports-run', port: 8640, projectDir: project, env });
const { js, until, check, sleep, press } = t;
const section = async (name, fn) => {
  try { await fn(); } catch (err) { check(false, `${name}: ${err.message.split('\n').slice(-1)[0].slice(0, 400)}`); await t.shot(`failure-${name}.png`).catch(() => {}); }
};
const ideTree = () => descendants(processSnapshot(), t.pid);
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]/g;
const dialogs = () => js(`[...document.querySelectorAll('.dialog')].map((d) => d.textContent)`);
const closeDialogs = async () => { for (let i = 0; i < 5 && (await dialogs()).length; i++) { await press('Escape'); await sleep(150); } };
const norm = (p) => path.resolve(p).toLowerCase();

try {
  await until(`ide.currentInterp()?.executable.toLowerCase().includes('.venv')`, 'project venv selected', 30000);
  await js(`(() => {
    window.__pty = { out: {}, exit: {}, dragEnded: 0 };
    ide.api.on('pty:data', ({ id, data }) => { __pty.out[id] = (__pty.out[id] || '') + data; });
    ide.api.on('pty:exit', ({ id, code }) => { __pty.exit[id] = code; });
    ide.api.on('tree:dragEnded', () => { __pty.dragEnded++; });
    return true;
  })()`);
} catch (err) {
  check(false, err.message);
}

// ---------- terminals: venv paths ----------
await section('venv-paths', async () => {
  const cases = [
    { name: 'weird', venv: V.weird, prompt: true, venvPython: true },
    { name: 'semicolon', venv: V.semicolon, prompt: true, venvPython: false },
    { name: 'percent', venv: V.percent, prompt: true, venvPython: 'powershell' }, // Python's activate.bat expands % itself
    { name: 'injCmd', venv: V.injCmd, prompt: true, venvPython: false },
    { name: 'injPs', venv: V.injPs, prompt: true, venvPython: true },
    { name: 'caret', venv: V.caret, prompt: true, venvPython: true },
    { name: 'long', venv: V.long, prompt: true, venvPython: true },
    { name: 'missing', venv: V.missing, prompt: false, venvPython: true },
    { name: 'empty', venv: V.empty, prompt: false, venvPython: 'powershell' },
    { name: 'broken', venv: V.broken, prompt: false, venvPython: 'powershell' },
    { name: 'noVenv', venv: null, prompt: false, venvPython: false },
  ];
  check(V.long.length > 200, `the long venv path has ${V.long.length} characters`);
  const sessions = [];
  for (const shell of ['powershell', 'cmd']) {
    for (const c of cases) {
      const interpreter = c.venv ? L(scriptsOf(c.venv), 'python.exe') : basePython;
      const out = L(scratch, `out-${shell}-${c.name}.txt`);
      const r = await js(`ide.api.invoke('pty:create', ${S({ shell, cwd: termCwd, cols: 400, rows: 50, interpreter })})`);
      sessions.push({ ...c, shell, out, id: r.id, wantVenvPython: c.venvPython === true || c.venvPython === shell });
    }
  }
  const textOf = async (s) => ((await js(`__pty.out[${s.id}] || ''`)) || '').replace(ANSI, '');
  const promptRe = (s) => (s.shell === 'cmd' ? /[A-Z]:\\[^\n>]*>\s*$/m : /PS [A-Z]:\\[^\n>]*>\s*$/m);
  for (const s of sessions) {
    for (const end = Date.now() + 45000; Date.now() < end && !promptRe(s).test(await textOf(s)); ) await sleep(250);
    await sleep(300);
    const py = s.wantVenvPython ? 'python' : s.shell === 'cmd' ? `"${basePython}"` : `& '${basePython}'`;
    const code = `import os,sys;open(r'${s.out}','w',encoding='utf-8').write(sys.prefix+'|'+os.environ.get('VIRTUAL_ENV',''))`;
    await js(`(ide.api.send('pty:write', { id: ${s.id}, data: ${S(`${py} -c "${code}"\r`)} }), true)`);
  }
  for (const s of sessions) {
    for (const end = Date.now() + 20000; Date.now() < end && !existsSync(s.out); ) await sleep(200);
    await sleep(200);
    const text = await textOf(s);
    const marked = s.shell === 'cmd' ? /\(venv\) [A-Z]:\\/.test(text) : /\(venv\) PS [A-Z]:\\/.test(text);
    const [prefix, ve] = existsSync(s.out) ? readFileSync(s.out, 'utf8').split('|') : [null, null];
    const label = `${s.shell} ${s.name}`;
    const tail = text.trim().split('\n').slice(-4).join(' / ').slice(-300);
    check(prefix !== null, `${label}: the shell starts and runs commands${prefix === null ? ` (${S(tail)})` : ''}`);
    if (s.prompt) check(marked, `${label}: the venv is activated (the prompt shows (venv))${marked ? '' : ` (${S(tail)})`}`);
    else check(!marked, `${label}: no activation is claimed (no (venv) in the prompt)`);
    if (s.wantVenvPython && prefix !== null) check(norm(prefix) === norm(s.venv), `${label}: python is the venv's (${prefix})`);
    if (!s.venv && prefix !== null) check(!ve, `${label}: an interpreter that is not a venv sets no VIRTUAL_ENV (${S(ve)})`);
    if (s.venv && (s.prompt || s.shell === 'powershell') && prefix !== null && !(s.name === 'percent' && s.shell === 'cmd')) check(norm(ve) === norm(s.venv), `${label}: VIRTUAL_ENV names the venv (${ve})`);
  }
  const injected = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = L(dir, n); if (/^INJ_/.test(n)) injected.push(p); else if (statSync(p).isDirectory() && !/^(Lib|Include)$/.test(n)) walk(p); } };
  walk(scratch);
  check(!injected.length, `no command in a venv path runs (${S(injected.map((p) => path.relative(scratch, p)))})`);
  for (const s of sessions) await js(`ide.api.invoke('pty:kill', ${s.id})`);
});

// ---------- terminals: odd options, a shell that does not exist ----------
await section('pty-options', async () => {
  const odd = await js(`ide.api.invoke('pty:create', { shell: 'no-such-shell', cwd: ${S(termCwd)}, cols: 80, rows: 24 }).then((r) => r, (e) => ({ thrown: String(e) }))`);
  check(odd.id && odd.shell === 'cmd', `an unknown shell falls back to Command Prompt (${S(odd)})`);
  if (odd.id) await js(`ide.api.invoke('pty:kill', ${odd.id})`);
  const hostile = await js(`ide.api.invoke('pty:create', { shell: 'cmd', cwd: '\\\\\\\\127.0.0.1\\\\nope', cols: -5, rows: 99999, interpreter: { executable: 1 } })
    .then((r) => r, (e) => ({ thrown: String(e) }))`);
  check(hostile.id || hostile.error || hostile.thrown, `odd session options are answered, not left hanging (${S(hostile).slice(0, 200)})`);
  if (hostile.id) await js(`ide.api.invoke('pty:kill', ${hostile.id})`);
  check(!(hostile.thrown && /TypeError/.test(hostile.thrown)), `an interpreter that is not a path is ignored, not a TypeError (${S(hostile).slice(0, 200)})`);
  const after = await js(`ide.api.invoke('pty:create', { shell: 'cmd', cwd: ${S(termCwd)}, cols: 80, rows: 24 })`);
  check(!!after.id, 'terminals still open after odd options');
  await js(`ide.api.invoke('pty:kill', ${after.id})`);
});

// ---------- terminals: switching the interpreter, 20 terminals ----------
await section('switch-interp', async () => {
  await js(`(ide.settings.set('interpreters.extra', [${S(L(scriptsOf(swA), 'python.exe'))}, ${S(L(scriptsOf(swB), 'python.exe'))}]), ide.reloadInterpreters()).then(() => true)`);
  check(await js(`ide.setInterpreter(${S(L(scriptsOf(swA), 'python.exe'))})`), 'venv-a selected');
  const open = (shell) => js(`ide.terminal.open({ shell: '${shell}', cwd: ${S(termCwd)} }).then((s) => s.id)`);
  const a = await open('powershell');
  await until(`/\\(venv-a\\) PS /.test(ide.terminal.text(${a}))`, 'venv-a prompt', 30000);
  await js(`ide.setInterpreter(${S(L(scriptsOf(swB), 'python.exe'))})`);
  const b = await open('cmd');
  await until(`/\\(venv-b\\) [A-Z]:/.test(ide.terminal.text(${b}))`, 'venv-b prompt', 30000);
  check(true, 'after switching the interpreter, a new terminal has the new venv');
  await js(`ide.setInterpreter(${S(basePython)}) || ide.setInterpreter(ide.interps.find((i) => !/venv/i.test(i.executable))?.executable)`);
  const c = await open('powershell');
  await until(`/PS [A-Z]:.*>\\s*$/.test(ide.terminal.text(${c}))`, 'plain prompt', 30000);
  check(!/\(venv/.test(await js(`ide.terminal.text(${c})`)), 'with an interpreter that is not a venv, a new terminal starts plain');
  await js(`(ide.terminal.focus(${a}), ide.terminal.send('echo STILL-$env:VIRTUAL_ENV-OK\\r'), true)`);
  await until(`/STILL-.*venv-a-OK/.test(ide.terminal.text(${a}))`, 'first terminal still works', 15000)
    .then(() => check(true, 'a terminal opened before the switch keeps its venv and keeps working'), () => check(false, 'the first terminal keeps working'));
  await js(`ide.setInterpreter(${S(L(projectVenv, 'Scripts', 'python.exe'))})`);
  await js(`ide.terminal.sessions().forEach((s) => ide.terminal.close(s.id))`);

  const shellsBefore = ideTree().filter((p) => /^(cmd|OpenConsole|conhost)\.exe$/i.test(p.name)).length;
  const twenty = await js(`Promise.all(Array.from({ length: 20 }, (_, i) => ide.terminal.open({ shell: i % 2 ? 'cmd' : 'powershell', cwd: ${S(termCwd)} }).then((s) => s.id)))`);
  const started = await js(`ide.terminal.sessions().filter((s) => ${S(twenty)}.includes(s.id) && s.pid && !s.exited).length`);
  check(twenty.every(Boolean) && started === 20, `20 terminals opened at once all start (${started} with a process)`);
  const total = await js(`ide.terminal.sessions().length`);
  check(total === 20, `opening 20 at once makes 20 sessions, not a default one besides each (${total})`);
  await until(`ide.terminal.sessions().every((s) => /(PS [A-Z]:|[A-Z]:\\\\).*>\\s*$/.test(ide.terminal.text(s.id)))`, '20 prompts', 60000)
    .then(() => check(true, 'each of the 20 shows its prompt'), () => check(false, 'each of the 20 shows its prompt'));
  const pids = await js(`ide.terminal.sessions().map((s) => s.pid)`);
  await js(`ide.terminal.sessions().forEach((s) => ide.terminal.close(s.id))`);
  await sleep(3000);
  const alive = processSnapshot().filter((p) => pids.includes(p.pid));
  check(!alive.length && await js(`ide.terminal.sessions().length`) === 0, `closing them ends every shell (${alive.length} left)`);
  const shellsAfter = ideTree().filter((p) => /^(cmd|OpenConsole|conhost)\.exe$/i.test(p.name)).length;
  check(shellsAfter <= shellsBefore, `no console processes are left behind (${shellsBefore} -> ${shellsAfter})`);
});

// ---------- port sharing ----------
const fakeProcs = (port) => processSnapshot().filter((p) => p.cmd.includes('fake-tunnel.cjs') && (port == null || p.cmd.includes(String(port))));
const tunnelOf = (port) => js(`ide.api.invoke('ports:state').then((s) => s.tunnels.find((x) => x.port === ${port}) || null)`);
const startServer = (code) => js(`ide.api.invoke('project:exec', ${S(process.execPath)}, ['-e', ${S(code)}], ide.root)`);
const mode = (m) => writeFileSync(modeFile, m);
await section('ports', async () => {
  const http = await startServer(`require('http').createServer((q, r) => r.end('hi')).listen(28641, '127.0.0.1')`);
  // Takes connections and never answers: a probe waits for both of its timeouts.
  const silent = await startServer(`require('net').createServer((s) => s.on('error', () => {})).listen(28642, '127.0.0.1')`);
  await until(`ide.api.invoke('ports:refresh').then((s) => [28641, 28642].every((p) => s.ports.some((r) => r.port === p)))`, 'servers listed', 30000);

  const bad = [0, 65536, -1, 'abc', '28641', null, 1.5, {}, 1e100];
  const answers = [];
  for (const port of bad) answers.push(await js(`ide.api.invoke('ports:share', ${S(port)}).then(() => 'shared', (e) => String(e.message))`));
  check(answers.every((a) => /Nothing the IDE started listens on port/.test(a)), `ports out of range or not numbers are refused with a reason (${S(answers.map((a) => a.slice(-50)))})`);
  check(!(await js(`ide.api.invoke('ports:state').then((s) => s.tunnels.length)`)) && !fakeProcs().length, 'no tunnel starts for them');
  const before = await js(`ide.settings.get('ports.added', [])`);
  for (const port of [0, 65536, -1, 'abc', 1.5, NaN]) {
    await js(`(ide.ports.addPort(${port === 'abc' ? "'abc'" : String(port)}), true)`);
    await until(`[...document.querySelectorAll('.dialog')].some((d) => d.textContent.includes('Enter a port number from 1 to 65535.'))`, `alert for ${port}`, 5000);
    await closeDialogs();
  }
  check(S(await js(`ide.settings.get('ports.added', [])`)) === S(before), 'Add Port says which numbers are ports and adds none of the others');
  const added = await js(`ide.api.invoke('ports:setAdded', [0, 65536, -1, 'x', 1e10, null, 28649, '28648']).then((s) => s.added)`);
  check(S(added) === S([28649, 28648]), `main keeps only real port numbers from the added list (${S(added)})`);
  await js(`ide.api.invoke('ports:setAdded', [])`);

  // Stop Sharing while the server is still being probed: nothing may start afterwards.
  mode('ok');
  const raced = js(`ide.api.invoke('ports:share', 28642).then(() => 'ok', (e) => String(e.message))`);
  await sleep(300);
  await js(`ide.api.invoke('ports:unshare', 28642)`);
  await raced;
  await sleep(2500);
  const racedTunnel = await tunnelOf(28642);
  check(!racedTunnel && !fakeProcs(28642).length, `Stop Sharing during the probe leaves no tunnel (${S(racedTunnel)}, ${fakeProcs(28642).length} processes)`);
  await js(`ide.api.invoke('ports:unshare', 28642)`);
  await sleep(500);

  // The same port shared three times at once: one tunnel.
  const three = await js(`Promise.all([1, 2, 3].map(() => ide.api.invoke('ports:share', 28641).then(() => 'ok', (e) => String(e.message))))`);
  await until(`ide.api.invoke('ports:state').then((s) => s.tunnels.some((x) => x.port === 28641 && x.state === 'shared'))`, 'shared once', 20000);
  check(fakeProcs(28641).length === 1, `sharing one port three times at once starts one tunnel (${S(three)}, ${fakeProcs(28641).length} processes)`);
  await js(`ide.api.invoke('ports:unshare', 28641)`);
  await sleep(1500);
  check(!fakeProcs(28641).length, 'Stop Sharing ends it');

  for (const [m, want] of [['crash', /exited with code 3.*boom/], ['exit0', /\S/]]) {
    mode(m);
    await js(`ide.api.invoke('ports:share', 28641)`);
    await until(`ide.api.invoke('ports:state').then((s) => s.tunnels.some((x) => x.port === 28641 && x.state === 'failed'))`, `${m} fails`, 15000);
    const tun = await tunnelOf(28641);
    check(want.test(tun.error || ''), `a tunnel tool that ${m === 'crash' ? 'crashes' : 'exits at once'} ends in "failed" with its reason (${S(tun.error)})`);
    await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Port 28641 could not be shared'))`, 'failure note', 5000)
      .then(() => check(true, `${m}: the failure is announced`), () => check(false, `${m}: the failure is announced`));
    await js(`ide.api.invoke('ports:unshare', 28641)`);
    await js(`[...document.querySelectorAll('.ide-balloon')].forEach((n) => n.remove())`);
  }

  mode('hang');
  await js(`ide.api.invoke('ports:share', 28641)`);
  await sleep(4000);
  check((await tunnelOf(28641))?.state === 'starting' && fakeProcs(28641).length === 1, 'a tunnel tool that hangs stays "starting"');
  await js(`ide.api.invoke('ports:unshare', 28641)`);
  await sleep(1500);
  check(!(await tunnelOf(28641)) && !fakeProcs(28641).length, 'Stop Sharing ends a hanging tunnel tool');

  mode('garbage');
  await js(`ide.api.invoke('ports:share', 28641)`);
  await sleep(3000);
  const t0 = Date.now();
  const garbage = await tunnelOf(28641);
  check(Date.now() - t0 < 2000, `the IDE stays responsive while the tool prints 3 MB of garbage (${Date.now() - t0} ms)`);
  check(garbage && garbage.state !== 'shared' && garbage.log.length <= 1500, `garbage is no address and the kept log is bounded (${garbage?.state}, ${garbage?.log.length})`);
  await js(`ide.api.invoke('ports:unshare', 28641)`);
  await sleep(1000);

  // Stop Sharing in the Ports window while the tunnel starts.
  mode('hang');
  await js(`(ide.settings.set('ports.confirmShare', false), ide.toolWindows.get('Ports').show(), true)`);
  await until(`!!document.querySelector('#portsList .ports-row[data-port="28641"] .ports-share')`, 'row with Share', 15000);
  await js(`(document.querySelector('#portsList .ports-row[data-port="28641"] .ports-share').click(), true)`);
  await until(`!!document.querySelector('#portsList .ports-row[data-port="28641"] .ports-stop')`, 'Starting… with Stop Sharing', 15000);
  await js(`(document.querySelector('#portsList .ports-row[data-port="28641"] .ports-stop').click(), true)`);
  await until(`!!document.querySelector('#portsList .ports-row[data-port="28641"] .ports-share')`, 'Share again', 10000);
  await sleep(1000);
  check(!fakeProcs(28641).length, 'Stop Sharing while the tunnel starts ends it and the row offers Share again');

  // The server goes away while its tunnel starts.
  await js(`ide.api.invoke('ports:share', 28642)`);
  await until(`ide.api.invoke('ports:state').then((s) => s.tunnels.some((x) => x.port === 28642))`, 'tcp tunnel starting', 15000);
  await js(`ide.proc.kill(${silent})`);
  await until(`ide.api.invoke('ports:state').then((s) => !s.tunnels.length && !s.ports.some((p) => p.port === 28642))`, 'tunnel gone with the server', 20000);
  await sleep(1000);
  check(!fakeProcs(28642).length, 'a server that stops while its tunnel starts takes the tunnel with it');
  await js(`ide.proc.kill(${http})`);
  await js(`(ide.toolWindows.get('Ports').hide?.(), true)`);
});

// ---------- Rerun on Save ----------
const runs = (kind) => { try { return readFileSync(runsLog, 'utf8').trim().split('\n').filter((l) => l.startsWith(kind)).map((l) => Number(l.split(' ')[1])); } catch { return []; } };
const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
const save = (f, text) => js(`(ide.getDocument(${P(f)}).model.setValue(${S(text)}), ide.saveTab(ide.findTab(${P(f)}))).then(() => true)`);
const livePython = (script) => processSnapshot().filter((p) => /python/i.test(p.name) && p.cmd.includes(script));
await section('rerun-on-save', async () => {
  await openFile(t, 'app.py');
  await press('Shift+F10');
  await until(`ide.run.activeSession()?.running && ide.run.activeSession().title === 'app'`, 'app running', 30000);
  for (let end = Date.now() + 15000; Date.now() < end && !runs('app').length; ) await sleep(100);
  await js(`(document.querySelector('#bottomActions button[data-action="rerunOnSave"]').click(), true)`);
  await openFile(t, 'settings.py');
  for (let i = 0; i < 50; i++) await save('settings.py', `VALUE = ${i}\n`);
  for (let end = Date.now() + 30000; Date.now() < end && runs('app').length < 2; ) await sleep(200);
  await sleep(4000);
  const app = runs('app');
  check(app.length >= 2 && app.length <= 3, `50 saves in a row rerun the program once or twice, not 50 times (${app.length - 1} reruns)`);
  await sleep(1000);
  const live = livePython('app.py');
  check(live.length >= 1 && live.length <= 2 && live.some((p) => p.pid === app.at(-1)) && !live.some((p) => app.slice(0, -1).includes(p.pid)),
    `a program that ignores Ctrl+C is stopped before its rerun: only the last run lives (${live.length} python processes)`);
  await js(`(ide.run.activeSession().stop(), true)`);
  await until(`!ide.run.activeSession().running`, 'app stopped', 20000);

  await openFile(t, 'flood.py');
  await press('Shift+F10');
  await until(`ide.run.activeSession()?.running && ide.run.activeSession().title === 'flood'`, 'flood running', 30000);
  await js(`(document.querySelector('#bottomActions button[data-action="rerunOnSave"]').click(), true)`);
  await sleep(2000);
  const t0 = Date.now();
  await js('1');
  check(Date.now() - t0 < 10000, `the window answers while a program floods its output (${Date.now() - t0} ms)`);
  await openFile(t, 'settings.py');
  // Under the flood a save can take longer than Rerun on Save's wait, so the saves fold into a few reruns.
  const saving = Date.now();
  for (let i = 0; i < 10; i++) await save('settings.py', `VALUE = "flood ${i}"\n`);
  const savedIn = Date.now() - saving;
  for (let end = Date.now() + 40000; Date.now() < end && runs('flood').length < 2; ) await sleep(200);
  await sleep(5000);
  const flood = runs('flood');
  check(flood.length >= 2 && flood.length <= 5, `10 saves during a flood fold into a few reruns, not 10 (${flood.length - 1} reruns, the saves took ${savedIn} ms)`);
  const floodLive = livePython('flood.py');
  check(!floodLive.some((p) => flood.slice(0, -1).includes(p.pid)), `each flooding run is stopped before the next: runs never overlap (${floodLive.length} alive)`);
  await js(`ide.run.sessions().forEach((s) => s.stop())`);
  await until(`ide.run.sessions().every((s) => !s.running)`, 'runs stopped', 20000);
  await sleep(1500);
  check(!livePython('app.py').length && !livePython('flood.py').length, 'no program is left running');
  await js(`ide.run.sessions().forEach((s) => ide.rerunOnSave.set(s, false))`);
});

// ---------- Sync Python Requirements ----------
await section('requirements-sync', async () => {
  const t0 = Date.now();
  const r = await js(`ide.requirementsSync.compare().then((r) => ({ missing: r.missing.map((m) => m.name), unused: r.unused.map((u) => u.name), target: r.target.path }), (e) => ({ error: String(e) }))`);
  check(!r.error && Date.now() - t0 < 90000, `a requirements.txt of 3000 lines with -r loops, a BOM and CRLF is read (${((Date.now() - t0) / 1000).toFixed(1)} s${r.error ? `, ${r.error}` : ''})`);
  check(r.missing && !r.missing.some((n) => /requests|yaml/i.test(n)), `requests (after the BOM) and PyYAML (from the -r file) count as declared (${S(r.missing)})`);
  check(r.unused?.includes('multi') && r.unused.length >= 3000, `unused requirements are found, the one continued over two lines too (${r.unused?.length})`);
  await js(`(ide.runAction('SyncPythonRequirements'), true)`);
  await until(`!!document.querySelector('#reqSync [data-id="remove:multi"]')`, 'sync dialog', 90000);
  await js(`(document.querySelector('#reqSync [data-id="remove:multi"]').click(), document.querySelector('#reqSync [data-id="remove:pkg-7"]').click(), true)`);
  await js(`[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('#reqSync')).querySelector('.dialog-buttons button').click()`);
  for (let end = Date.now() + 20000; Date.now() < end && readFileSync(reqFile, 'utf8').includes('pkg-7=='); ) await sleep(200);
  const text = readFileSync(reqFile, 'utf8').replace(/^﻿/, '');
  const lines = text.split('\r\n');
  check(!lines.includes('pkg-7==1.0') && lines.includes('pkg-8==1.0'), 'a requirement chosen for removal is removed');
  check(!lines.some((l) => /^multi\b|^\s+>=1\.0$/.test(l)), `the requirement continued over two lines is removed with both its lines (${S(lines.slice(8, 12))})`);
  check(!/[^\r]\n/.test(text) && lines[0] === 'requests>=2' && lines.includes('-r requirements.txt') && lines.includes('!!! not a requirement'),
    'the rest of the file is kept as it was, CRLF included');
});

// ---------- Build Executable ----------
const runText = () => js(`document.querySelector('.run-session:not(.hidden)')?.textContent || ''`);
await section('exe-builder', async () => {
  await openFile(t, 'main.py');
  const build = (fields) => js(`(ide.exeBuilder.build(ide.util.joinPath(ide.root, 'main.py'), ${S({ mode: 'onefile', windowed: false, icon: '', ...fields })}), true)`);
  const outside = L(scratch, 'escaped.exe');
  await build({ exeName: '..\\..\\escaped' });
  await sleep(6000);
  check(!existsSync(outside) && !existsSync(L(project, 'escaped.exe')), 'a configuration\'s name with ..\\ cannot put the program outside dist');
  check(/name/i.test(await runText()) && !/Executable built/.test(await runText()), `it is refused with a reason (${S((await runText()).slice(-160))})`);
  await build({ exeName: '..' });
  await sleep(5000);
  check(!/Executable built/.test(await runText()), `the name ".." is refused (${S((await runText()).slice(-120))})`);

  await js(`(ide.runAction('BuildExecutable'), true)`);
  await until(`!!document.querySelector('#exeDlgName')`, 'dialog');
  for (const name of ['..', '   ', 'a/b', 'x:y']) {
    await js(`(document.querySelector('#exeDlgName').value = ${S(name)}, [...[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('#exeDlgName')).querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Build').click(), true)`);
    await sleep(300);
    check(await js(`!!document.querySelector('#exeDlgName') && !!document.querySelector('.exe-dialog-error').textContent`), `the dialog refuses the name ${S(name)} with a message (${S(await js(`document.querySelector('.exe-dialog-error')?.textContent`))})`);
  }
  const korean = '내 앱 😀 v1.0';
  await js(`(document.querySelector('#exeDlgName').value = ${S(korean)}, [...[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('#exeDlgName')).querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Build').click(), true)`);
  await until(`ide.api.exists(${S(L(project, 'dist', `${korean}.exe`))})`, 'Korean name built', 60000)
    .then(() => check(true, 'a Korean name with an emoji, spaces and dots builds'), () => check(false, 'a Korean name with an emoji builds'));

  await js(`(() => { const c = ide.run.addTemporary({ type: 'pyinstaller', name: 'gone', script: 'gone.py' }); c.temporary = false; ide.run.runConfig(c, { remember: false }); return true; })()`);
  await until(`document.querySelector('.run-session:not(.hidden)')?.textContent.includes('Script not found')`, 'missing script', 30000)
    .then(() => check(true, 'a missing script is a clear error'), () => check(false, 'a missing script is a clear error'));
  await js(`(() => { const c = ide.run.configs().find((x) => x.type === 'pyinstaller' && x.script === 'main.py'); c.data = 'nope;assets'; ide.run.runConfig(c, { remember: false }); return true; })()`);
  await until(`document.querySelector('.run-session:not(.hidden)')?.textContent.includes('Data file or folder not found')`, 'missing data', 30000)
    .then(() => check(true, 'a missing data file is a clear error'), () => check(false, 'a missing data file is a clear error'));
  await js(`(() => { const c = ide.run.configs().find((x) => x.type === 'pyinstaller' && x.script === 'main.py'); c.data = ''; return true; })()`);
  await build({ exeName: 'Broken' });
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Building Broken.exe failed'))`, 'failure', 60000)
    .then(() => check(true, 'a failing build is reported'), () => check(false, 'a failing build is reported'));
});

check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors).slice(0, 800)}` : ''}`);
const internal = await js(`ide.api.invoke('diagnostics:errors')`).catch(() => []);
check(!internal.length, `no IDE internal errors${internal.length ? ` ${S(internal).slice(0, 800)}` : ''}`);
await js(`ide.terminal.sessions().forEach((s) => ide.terminal.close(s.id))`).catch(() => {});
await js(`ide.run.sessions().forEach((s) => s.stop())`).catch(() => {});
// ---------- tree drag-out ----------
// Last: Windows runs a system drag in a loop of main's that ends at once only while no mouse button is held, and the
// window answers nothing until it ends. On a desktop where something holds the button, the section gives up.
let dragDone = false;
await Promise.race([section('tree-drag', async () => {
  const many = Array.from({ length: 300 }, (_, i) => L(project, 'many', `f${String(i).padStart(3, '0')}.txt`));
  for (const p of many.slice(0, 40)) rmSync(p);
  const before = await js('__pty.dragEnded');
  await js(`(window.api.send('tree:startDrag', ${S(many)}), true)`);
  await until(`__pty.dragEnded > ${before}`, 'drag of 300 files ends', 20000)
    .then(() => check(true, 'a drag of 300 files, 40 of them deleted, ends and is reported'), () => check(false, 'a drag of 300 files ends'));
  const b2 = await js('__pty.dragEnded');
  await js(`(window.api.send('tree:startDrag', [null, 5, {}, 'relative.txt', '', ${S(L(project, 'many', 'gone.txt'))}]), window.api.send('tree:startDrag', 'not a list'), true)`);
  await until(`__pty.dragEnded >= ${b2 + 2}`, 'odd drags end', 20000)
    .then(() => check(true, 'drags of entries that are not files end too'), () => check(false, 'drags of entries that are not files end'));
  check(await js(`ide.api.exists(ide.root)`), 'the IDE still answers');
}).then(() => { dragDone = true; }), sleepMs(90000).then(() => dragDone || check(false, 'tree-drag: main stayed in the system drag for 90 s (a mouse button held on this desktop?)'))]);

t.close();
await sleepMs(1500);
check(!fakeProcs().length, 'quitting leaves no tunnel tool running');
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
