// Safe Mode against a hostile project, on real Electron, started as `nano .` from inside the project: it holds a git.exe,
// python.exe and py.exe of its own, a .git/config whose core.fsmonitor runs a program, a manage.py, launchers, and a
// .http file reaching for a file outside. Nothing of it may run. The planted programs are a small C# program that writes
// ran.log next to itself and prints PLANTED: whoami.exe, which the review's probes used, leaves no trace when it is
// given git's or Python's arguments, so a test built on it could not fail. The app is started without
// NoDefaultCurrentDirectoryInExePath: a shell that has it set (some harnesses do) hides the bug this suite is for.
// To see the suite fail, run a copy of it next to the code before the fix. Usage: node verify/safe-mode.mjs (ports 9925-9926).
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const { runsWhenOpened } = createRequire(import.meta.url)('../main/trust.js');
const CSC ='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const q = JSON.stringify;
const work = tempDir('safe-mode');
const project = path.join(work, 'downloaded-repo');
mkdirSync(path.join(project, '.claude'), { recursive: true });

const inProject = (name) => path.join(project, name);
const files = {
  'README.md': '# Hostile project\n\nLooks harmless.\n',
  'manage.py': 'import sys\nopen(r"manage-ran.txt", "w").write("ran")\nsys.exit("from django.core.management import execute_from_command_line")\n',
  'start.bat': '@echo off\r\necho ran> bat-ran.txt\r\n',
  'hello.bat': '@echo off\r\necho HELLO-FROM-PROJECT\r\n',
  'links.bat': `@echo off\r\necho File "\\\\127.0.0.1\\s\\termlink.py", line 1\r\necho File "${inProject('hello.py')}", line 1\r\n`,
  'hello.py': 'import os\nprint("hello")\n',
  'json.py': 'open(r"json-ran.txt", "w").write("ran")\n',
  'show_env.py': 'import os\nprint("VAR=" + repr(os.environ.get("NoDefaultCurrentDirectoryInExePath")))\n',
  'debug_env.py': `import os\nopen(r"${inProject('debug-env.txt')}", "w").write(repr(os.environ.get("NoDefaultCurrentDirectoryInExePath")))\n`,
  'notes.txt': 'inside the project\n',
  '.claude/launch.json': q({ configurations: [{ name: 'hostile', runtimeExecutable: '.\\app.exe', env: { A: '1' } }] }),
};
for (const [name, text] of Object.entries(files)) writeFileSync(inProject(name), text);
const secret = path.join(work, 'secret.txt');
writeFileSync(secret, 'TOP-SECRET');
symlinkSync(work, inProject('link'), 'junction');

const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: project, stdio: 'ignore' });
git('init', '-q'); git('add', 'README.md'); git('commit', '-qm', 'init');
writeFileSync(path.join(work, 'planted.cs'), `using System; using System.IO;
class Planted { static int Main(string[] a) {
  File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ran.log"), Path.GetFileName(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName) + " " + string.Join(" ", a) + "\\n");
  Console.WriteLine("PLANTED");
  return 1;
} }`);
execFileSync(CSC, ['/nologo', '/out:planted.exe', 'planted.cs'], { cwd: work, stdio: 'ignore' });
for (const name of ['git.exe', 'python.exe', 'py.exe', 'app.exe', 'fsmonitor.exe']) copyFileSync(path.join(work, 'planted.exe'), inProject(name));
git('config', 'core.fsmonitor', inProject('fsmonitor.exe').replace(/\\/g, '/'));

const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { received.push(body); res.end('ok'); });
});
await new Promise((r) => { server.listen(9926, '127.0.0.1', r); });

const t = await launch({ fixture: 'core', port: 9925, name: 'safe-mode', projectDir: '.', cwd: project,
  env: { PYIDE_TRUST_ALL: '0', NoDefaultCurrentDirectoryInExePath: undefined }, ready: "document.querySelector('.dialog-title')?.textContent === 'Trust and Open Project?'" });
const { js, until, check, sleep, cdp } = t;
const soon = (expr, ms = 15000) => until(expr, expr, ms).then(() => true, () => false);
const ran = () => (existsSync(inProject('ran.log')) ? readFileSync(inProject('ran.log'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(' ')[0]).join(' ') : '');
const dialogTitle = `[...document.querySelectorAll('.dialog-title')].map(n => n.textContent).join('|')`;
const clickDialog = (label) => js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${q(label)}).click(), true)`);
const closeDialogs = () => js(`([...document.querySelectorAll('.dialog-buttons button')].pop()?.click(), true)`);
// project:exec: a bare program name started by main with the project as working folder, as every feature does.
const exec = (cmd, args, cwd) => js(`(async () => {
  const id = await ide.api.invoke('project:exec', ${q(cmd)}, ${q(args)}, ${cwd ? q(cwd) : 'undefined'});
  return new Promise((resolve) => { let out = ''; ide.proc.attach(id, { data: (x) => { out += x; }, exit: (code) => resolve({ out, code }) }); });
})()`);
const send = (body) => js(`ide.api.invoke('http-client:send', { file: ${q(inProject('api.http'))}, root: ide.root, request: { method: 'POST', url: 'http://127.0.0.1:9926/x', headers: [], body: ${q(body)} } })`);

try {
  await soon(`${dialogTitle}.includes('Trust and Open Project?')`);
  await clickDialog('Preview in Safe Mode');
  check(await soon(`window.__ideReady === true && ide.root && ide.util.samePath(ide.root, ${q(project)})`), `\`nano .\` opens the folder it was started in (${await js('ide.root')})`);
  check(await js('ide.trusted') === false, 'the project is in Safe Mode');
  check(await soon('ide.interps.length > 0', 30000), 'interpreter discovery finds an interpreter');
  const interps = await js('ide.interps.map(i => i.executable)');
  check(interps.every((p) => !p.toLowerCase().startsWith(project.toLowerCase())), `interpreter discovery does not reach the project's python.exe (${interps.join(', ')})`);

  // ---------- a bare name with the project as working folder ----------
  const gitOut = await exec('git', ['--version'], project);
  check(/^git version/.test(gitOut.out) && !gitOut.out.includes('PLANTED'), `"git" finds git on PATH, not the project's git.exe (${gitOut.out.trim()})`);
  const pyOut = await exec('python', ['--version'], project);
  check(!pyOut.out.includes('PLANTED'), `"python" is not the project's python.exe (${pyOut.out.trim()})`);
  const launcherOut = await exec('py', ['--version'], project);
  check(/^Python \d/.test(launcherOut.out) && !launcherOut.out.includes('PLANTED'), `"py" finds the launcher, not the project's py.exe (${launcherOut.out.trim()})`);
  const cd = await exec('cmd.exe', ['/d', '/c', 'cd']);
  check(cd.out.trim().toLowerCase() === t.userData.toLowerCase(), `a child with no working folder runs in the user data folder, not the project (${cd.out.trim()})`);

  // ---------- trust gates ----------
  const info = await js(`ide.api.invoke('workspace:info', ide.root)`);
  check(info.branch === null && info.readme?.title === 'Hostile project', `workspace:info keeps the README and asks git nothing (${q(info)})`);
  const interp = await js('ide.currentInterp()') || { cmd: 'python', args: [] };
  const inspected = await js(`ide.api.invoke('frameworks:inspect', ${q(interp)}, ide.root)`);
  check(inspected.ok && inspected.info === null, `frameworks:inspect answers nothing (${q(inspected).slice(0, 120)})`);
  const commands = await js(`ide.api.invoke('frameworks:manageCommands', ${q(interp)}, ${q(inProject('manage.py'))}, {}, [ide.root])`);
  check(commands.ok && commands.commands.length === 0 && !existsSync(inProject('manage-ran.txt')), `the project's manage.py is not run for the task picker (${q(commands).slice(0, 120)})`);

  await js(`ide.api.invoke('semantic:index', ide.root)`);
  check(await soon(`ide.api.invoke('semantic:indexInfo', ide.root).then(i => i.files > 0 && !i.indexing)`, 30000), 'the semantic index still covers the project');
  check(!ran().includes('fsmonitor'), `the semantic index runs no core.fsmonitor program through git (${ran()})`);

  const scanned = await js(`ide.api.invoke('workspace:scan', ide.root)`);
  const bat = scanned.entries.find((e) => e.kind === 'bat' && e.name === 'start.bat');
  const launchEntry = scanned.entries.find((e) => e.kind === 'launch');
  const refusal = (entry) => js(`ide.api.invoke('workspace:start', ide.root, ${q(entry)}, '', null).then(() => 'started', (e) => e.message)`);
  const batRefused = await refusal(bat);
  const launchRefused = await refusal(launchEntry);
  await sleep(800);
  check(/not trusted/.test(batRefused) && /not trusted/.test(launchRefused) && !existsSync(inProject('bat-ran.txt')) && !ran().includes('app.exe'),
    `workspace:start refuses a .bat and a launch.json entry (${batRefused}; ${launchRefused})`);
  await js(`ide.workspace.run(${q(bat)}).catch(() => {}), true`);
  check(await soon(`${dialogTitle}.includes('Trust Project?')`, 4000), 'a launcher in the UI offers to trust the project first');
  await closeDialogs();

  // ---------- Open with Default App ----------
  const app = inProject('app.exe');
  const opened = await js(`ide.api.invoke('shell:openPath', ${q(app)})`);
  check(opened === 'untrusted', `Open with Default App refuses a program (${opened})`);
  check(await soon(`document.querySelector('.dialog-message')?.textContent.includes('app.exe is a program')`, 4000), 'and says why');
  await closeDialogs();
  check(await js(`ide.api.invoke('shell:openPath', ${q(`${app}.`)})`) === 'untrusted', 'a trailing dot does not get a program past it');
  await closeDialogs();
  check(runsWhenOpened('C:\\p\\Tool.EXE') && runsWhenOpened('C:\\p\\tool.exe. ') && runsWhenOpened('x.lnk') && !runsWhenOpened('C:\\p\\report.pdf') && !runsWhenOpened('C:\\p\\exe'),
    'programs, scripts and shortcuts are told from documents, which open as before');
  await sleep(800);
  check(!ran().includes('app.exe'), `the project's app.exe did not start (${ran()})`);

  // ---------- Pyright without an interpreter ----------
  await js(`ide.openFile(${q(inProject('hello.py'))})`);
  await js(`(() => { ide.__interp = ide.currentInterp; ide.currentInterp = () => null; ide.lsp.restart(); return true; })()`);
  check(await soon(`ide.api.invoke('lsp:log').then(l => /Unable to get Python version from interpreter|Assuming Python version/.test(l))`, 30000), 'Pyright looked for an interpreter by itself');
  await sleep(1500);
  await js(`(() => { ide.currentInterp = ide.__interp; return true; })()`);
  check(!ran().includes('python.exe') && !existsSync(inProject('json-ran.txt')), `Pyright with no pythonPath reaches neither the project's python.exe nor its json.py (${ran()})`);
  rmSync(inProject('json.py'));

  // ---------- .http includes ----------
  const outside = await send('< ../secret.txt');
  check(!outside.ok && outside.error.kind === 'outside', `a body file above the project is refused (${q(outside.error)})`);
  const absolute = await send(`< ${secret}`);
  check(!absolute.ok && absolute.error.kind === 'outside', 'so is an absolute path');
  const spliced = await send(`before\n< ../secret.txt\nafter`);
  check(!spliced.ok && spliced.error.kind === 'outside', 'and a file spliced into a longer body');
  const linked = await send('< link/secret.txt');
  check(!linked.ok && linked.error.kind === 'outside', `and one reached through a junction in the project (${q(linked.error)})`);
  check(await js(`document.documentElement.lang`) !== null && !received.some((b) => b.includes('TOP-SECRET')), `no request carried the file (${received.length} received)`);
  const inside = await send('< notes.txt');
  check(inside.ok && received.at(-1).includes('inside the project'), 'a file inside the project is sent');

  // ---------- links in program output ----------
  const unc = 'File "\\\\127.0.0.1\\s\\x.py", line 1\n';
  const forward = 'File "//127.0.0.1/s/x.py", line 1\n';
  const local = `File "${inProject('hello.py')}", line 1\n`;
  const linksIn = (text) => js(`(async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const con = ide.ui.console(host);
    con.append(${q(text)}, 'err');
    await new Promise((r) => { setTimeout(r, 300); });
    const n = host.querySelectorAll('a').length;
    host.remove();
    return n;
  })()`);
  check(await linksIn(unc) === 0, 'a traceback frame on an unknown share is not a link');
  check(await linksIn(forward) === 0, 'nor with forward slashes');
  check(await linksIn(local) === 1, 'a local frame is');

  // ---------- user programs keep the normal search ----------
  const runId = await js(`ide.api.invoke('run:start', ${q(interp)}, ${q(inProject('show_env.py'))}, ide.root, [], {}, [ide.root])`);
  const runOut = await js(`new Promise((resolve) => { let out = ''; ide.proc.attach(${runId}, { data: (x) => { out += x; }, exit: () => resolve(out) }); })`);
  check(runOut.includes('VAR=None'), `a Run child does not get the variable (${runOut.trim()})`);
  await js(`ide.debugger.debugFile(${q(inProject('debug_env.py'))}, { interp: ${q(interp)} }), true`);
  await until(`ide.api.exists(${q(inProject('debug-env.txt'))})`, 'the debugged program wrote its file', 45000).catch(() => {});
  const debugEnv = existsSync(inProject('debug-env.txt')) ? readFileSync(inProject('debug-env.txt'), 'utf8') : 'not run';
  check(debugEnv === 'None', `a Debug child does not get the variable (${debugEnv})`);

  await js(`ide.terminal.open({ cwd: ${q(project)}, command: 'echo [%NoDefaultCurrentDirectoryInExePath%] & hello' }), true`);
  await soon(`ide.terminal.text().includes('HELLO-FROM-PROJECT')`, 20000);
  const text = await js('ide.terminal.text()');
  check(text.includes('[%NoDefaultCurrentDirectoryInExePath%]'), 'a terminal does not get the variable');
  check(text.includes('HELLO-FROM-PROJECT'), "and its cmd finds hello.bat in the current folder, as a cmd outside the IDE does");

  const asked = [];
  await js(`(() => { window.__exists = []; const real = ide.api; ide.api = { ...real, exists: (p) => { window.__exists.push(p); return real.exists(p); } }; return true; })()`);
  const clickText = async (needle) => {
    await soon(`ide.terminal.locate(${q(needle)})`, 8000);
    const at = await js(`(() => {
      const p = ide.terminal.locate(${q(needle)});
      const g = ide.terminal.geometry();
      const screen = document.querySelector('.term-session:not(.hidden) .xterm-screen').getBoundingClientRect();
      return { x: screen.left + (p.col + 1.5) * screen.width / g.cols, y: screen.top + (p.row - g.viewportY + 0.5) * screen.height / g.rows };
    })()`);
    const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
    await frame();
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await sleep(400);
    await frame();
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(400);
    await frame();
    asked.push(...await js('window.__exists.splice(0)'));
  };
  await js(`(ide.terminal.open({ cwd: ${q(project)}, command: 'links' }), true)`);
  check(await soon(`ide.terminal.text().includes('hello.py", line 1')`, 15000), `the terminal printed the links (${(await js('ide.terminal.text()')).slice(-200)})`);
  await sleep(500);
  await clickText('termlink.py"');
  check(!asked.some((p) => p.includes('127.0.0.1')), `clicking a terminal link to an unknown share touches nothing (${q(asked)})`);
  await clickText('hello.py"');
  check(asked.some((p) => p.toLowerCase().endsWith('hello.py')), `a local terminal link still opens (${q(asked)})`);

  // A share the user opened something on: its links work (main/security.js).
  const allowed = '\\\\127.0.0.1\\allowed';
  await js(`ide.api.invoke('watch:project', ${q(allowed)})`);
  check(await linksIn(`File "${allowed}\\x.py", line 1\n`) === 1, 'a frame on a share the user opened is a link');
  await js(`ide.api.invoke('watch:project', ide.root)`);

  check(ran() === '', `nothing planted ran in the whole session (${ran()})`);
  for (const f of ['manage-ran.txt', 'bat-ran.txt', 'json-ran.txt']) check(!existsSync(inProject(f)), `${f} was not written`);

  // ---------- relaunch ----------
  const before = await js('location.href');
  await js(`(() => { ide.terminal.sessions().forEach((s) => ide.terminal.close(s.id)); return true; })()`);
  await sleep(500);
  await closeDialogs();
  js('ide.api.relaunch()').catch(() => {});
  let again = null;
  for (let i = 0; i < 100 && !again; i++) {
    await sleep(300);
    try {
      const page = (await (await fetch('http://127.0.0.1:9925/json')).json()).find((p) => p.type === 'page' && p.url.includes('index.html'));
      if (page && page.webSocketDebuggerUrl !== t.wsUrl && !(await js('1').then(() => true, () => false))) again = page;
    } catch {}
  }
  check(again && decodeURIComponent(again.url).toLowerCase().includes(project.toLowerCase()),
    `the relaunched app opens the same project, its relative argument resolved against where it was started (${again?.url.slice(0, 40)}, was ${before.slice(0, 40)})`);
  try {
    const browser = new WebSocket((await (await fetch('http://127.0.0.1:9925/json/version')).json()).webSocketDebuggerUrl);
    await new Promise((r, j) => { browser.addEventListener('open', r); browser.addEventListener('error', j); });
    browser.send(q({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
  } catch {}
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
server.close();
t.finish();
