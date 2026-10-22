// Commit checks and auto-fetch. A project cloned from a bare repository in a temp folder (a second clone pushes to it).
// Pure Node first: git:backgroundFetch against a remote that asks for credentials (an http server answering 401: no
// askpass, credential helpers told not to prompt, and with the machine's own Git Credential Manager when it has one), an
// unreachable https remote, no remote, a held index lock, an untrusted project. Then in the IDE: the commit options
// popup and its defaults; Optimize imports and Reformat code rewriting only the committed files (open and closed),
// with the steps' progress in order; Analyze code stopping on errors (Cancel, Review, Commit Anyway); Check TODO;
// Commit and Push; Run tests failing, cancelled and passing; the options after a restart; auto-fetch showing ↓3 ↑1
// within its interval and Update Project from it; backing off while offline with no error popup; a remote that needs
// credentials failing quietly; 0 turning it off; then the Korean UI. Also pure Node: Pyright's file list split into
// command lines under Windows' limit, and Pyright (a stand-in, PYIDE_PYRIGHT_CLI) and background-fetch git trees ended
// by Cancel, a window's reload or close, quitting and the fetch time limit. In the IDE: a commit stopped after the
// reformat (Undo and the "Before Commit Checks" Local History checkpoint restore the file), and no Pyright or git
// process left after a reload or Exit (by PID). Ports 9310-9319 (9313: the quit instance, 9316: a server that never
// answers, 9317: fake auth server, 9318: nothing listens).
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { EventEmitter } from 'events';
import http from 'http';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { descendants, launch, processSnapshot } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const q = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- git isolation, with recorders for any prompt git might try ----------
const home = mkdtempSync(path.join(tmpdir(), 'pyide-commit-checks-'));
const askpassLog = path.join(home, 'askpass.log');
const helperLog = path.join(home, 'helper.log');
writeFileSync(path.join(home, 'askpass.cmd'), `@echo %* >> "${askpassLog}"\r\n@echo not-a-password\r\n`);
writeFileSync(path.join(home, 'helper.js'), `require('fs').appendFileSync(${q(helperLog)}, process.argv.slice(2).join(' ') + ' GCM_INTERACTIVE=' + process.env.GCM_INTERACTIVE + ' GIT_TERMINAL_PROMPT=' + process.env.GIT_TERMINAL_PROMPT + '\\n');\n`);
const gitConfig = path.join(home, 'gitconfig');
const fwd = (p) => p.replace(/\\/g, '/');
writeFileSync(gitConfig, `[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\taskPass = ${fwd(path.join(home, 'askpass.cmd'))}\n[credential]\n\thelper = "!node '${fwd(path.join(home, 'helper.js'))}'"\n`);
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '');
const readLog = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

// A server that wants credentials for everything, counting the requests.
let authRequests = 0;
const authServer = http.createServer((req, res) => {
  authRequests++;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pyide-test"', 'Content-Type': 'text/plain' });
  res.end('authentication required');
});
await new Promise((r) => authServer.listen(9317, '127.0.0.1', r));
const AUTH_URL = 'http://127.0.0.1:9317/private/repo.git';
const OFFLINE_URL = 'https://127.0.0.1:9318/repo.git';

// ---------- repositories ----------
const bare = path.join(home, 'remote.git');
const seed = path.join(home, 'seed');
const other = path.join(home, 'other');
const project = path.join(home, 'project');
const write = (dir, rel, data) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), data); };
const MAIN = readFileSync(path.join(APP, 'verify/fixtures/vcs/main.py'), 'utf8');
const TEST_OK = 'import unittest\n\nfrom calc import add\n\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n';
git(home, 'init', '--bare', '-q', bare);
git(home, 'clone', '-q', bare, seed);
write(seed, 'main.py', MAIN);
write(seed, 'calc.py', 'def add(a, b):\n    return a + b\n');
write(seed, 'test_calc.py', TEST_OK);
write(seed, 'todo.py', '# TODO: existing item\nVALUE = 1\n');
write(seed, 'shared.txt', 'base\n');
git(seed, 'add', '-A');
git(seed, 'commit', '-q', '-m', 'Initial commit');
git(seed, 'push', '-q', 'origin', 'main');
git(home, 'clone', '-q', bare, project);
git(home, 'clone', '-q', bare, other);
const commits = () => Number(git(project, 'rev-list', '--count', 'HEAD'));
const atHead = (rel) => git(project, 'show', `HEAD:${rel}`);

// ---------- pure Node: git:backgroundFetch ----------
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
{
  const { backgroundFetch } = require('../main/features/git.js');
  const unit = path.join(home, 'unit');
  git(home, 'clone', '-q', bare, unit);
  let r = await backgroundFetch(unit);
  check(r.ok, `a reachable remote is fetched (${q(r)})`);

  git(unit, 'remote', 'set-url', 'origin', AUTH_URL);
  let started = Date.now();
  r = await backgroundFetch(unit);
  let ms = Date.now() - started;
  check(!r.ok && !r.skipped && ms < 20000, `a remote that wants credentials fails without waiting for anyone (${ms} ms, ${q(r.err)})`);
  check(authRequests > 0, 'the fetch did reach the server that asked for credentials');
  check(readLog(askpassLog) === '', 'no askpass program was started (core.askPass is configured)');
  check(/GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0/.test(readLog(helperLog)), `the credential helper was asked non-interactively (${q(readLog(helperLog).trim())})`);

  // The machine's own configuration (Git for Windows registers Git Credential Manager system-wide).
  delete process.env.GIT_CONFIG_NOSYSTEM;
  const plain = path.join(home, 'gitconfig-plain');
  writeFileSync(plain, '[user]\n\tname = Alice\n\temail = alice@example.com\n');
  process.env.GIT_CONFIG_GLOBAL = plain;
  let systemHelper = '';
  try { systemHelper = git(unit, 'config', '--get-all', 'credential.helper'); } catch {}
  if (systemHelper) {
    started = Date.now();
    r = await backgroundFetch(unit);
    ms = Date.now() - started;
    check(!r.ok && ms < 30000, `with the system credential helper (${systemHelper.split(/\s+/)[0]}) it also fails quietly (${ms} ms, ${q((r.err || '').split('\n').pop())})`);
  } else console.log('(no system credential helper on this machine; skipped that case)');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = gitConfig;

  git(unit, 'remote', 'set-url', 'origin', OFFLINE_URL);
  started = Date.now();
  r = await backgroundFetch(unit);
  check(!r.ok && !r.skipped && Date.now() - started < 20000, `an unreachable remote fails fast (${q(r.err)})`);

  const lock = path.join(unit, '.git', 'index.lock');
  writeFileSync(lock, '');
  r = await backgroundFetch(unit);
  check(r.skipped === 'busy', 'nothing is fetched while another git holds the index lock');
  rmSync(lock);

  git(unit, 'remote', 'remove', 'origin');
  r = await backgroundFetch(unit);
  check(r.skipped === 'noRemote', 'a repository without remotes is skipped');

  process.env.PYIDE_TRUST_ALL = '0';
  r = await backgroundFetch(unit);
  process.env.PYIDE_TRUST_ALL = '1';
  check(r.skipped === 'untrusted', 'an untrusted project is never fetched');
}

// ---------- the IDE ----------
function helpers(t) {
  const { js, cdp } = t;
  const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
  async function until(expr, label, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await frame();
      try { if (await js(expr)) return true; } catch {}
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label}`);
  }
  async function mouse(expr, label = expr) {
    await frame();
    const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${label}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(120);
  }
  const row = (name) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith(${q(`\\${name}`)}))`;
  async function tick(name, on) {
    await until(`!!${row(name)}`, `${name} listed`);
    if ((await js(`${row(name)}.querySelector('input').checked`)) !== on) await mouse(`${row(name)}.querySelector('input')`, `tick ${name}`);
    await until(`${row(name)}.querySelector('input').checked === ${on}`, `${name} ${on ? 'ticked' : 'unticked'}`);
  }
  const dialogTitle = () => js(`document.querySelector('#dialogHost .dialog-title')?.textContent || ''`);
  const dialogText = () => js(`document.querySelector('#dialogHost .dialog-body')?.textContent || ''`);
  const button = (label) => `[...document.querySelectorAll('#dialogHost .dialog-buttons button')].find(b => b.textContent === ${q(label)})`;
  const option = (id) => `document.querySelector('#vcsChecksPopup [data-check="${id}"] input')`;
  const menuItem = (label) => `[...document.querySelectorAll('#menuHost .menu-item')].find(m => m.firstChild.textContent === ${q(label)})`;
  const errorNotes = () => js(`(ide.notifications ? ide.notifications.list().filter(e => e.kind === 'error').length : 0) + document.querySelectorAll('.vcs-note.error').length`);
  async function setMessage(text) {
    await js(`(ide.toolWindows.get('Commit').show(), true)`);
    await until(`!!document.querySelector('.vcs-msg') && !!document.querySelector('.vcs-msg').offsetParent`, 'commit message box');
    await js(`(document.querySelector('.vcs-msg').value = ${q(text)}, true)`);
  }
  async function popup(open) {
    const shown = await js(`!!document.querySelector('#vcsChecksPopup')`);
    if (shown !== open) await mouse(`document.querySelector('#vcsCommitOptions')`, 'commit options gear');
    await until(`!!document.querySelector('#vcsChecksPopup') === ${open}`, open ? 'options popup' : 'options popup closed');
  }
  async function setOption(id, on) {
    await popup(true);
    if ((await js(`${option(id)}.checked`)) !== on) await mouse(option(id), `option ${id}`);
    await until(`${option(id)}.checked === ${on} && ide.settings.get('vcs.commitChecks.${id}') === ${on}`, `${id} ${on ? 'on' : 'off'}`);
  }
  const refresh = () => js(`ide.vcs.refresh().then(() => true)`);
  return { frame, until, mouse, row, tick, dialogTitle, dialogText, button, option, menuItem, errorNotes, setMessage, popup, setOption, refresh };
}

const waitFor = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  throw new Error(`timeout waiting for: ${label}`);
};
const ruff = (args, input) => execFileSync(path.join(APP, 'vendor', 'bin', 'ruff.exe'), [...args, '--stdin-filename', path.join(project, 'fmt.py'), '-'], { input, encoding: 'utf8', cwd: project });

// ---------- pure Node: Pyright's command lines, and no Pyright or git process outliving the window or the IDE ----------
// Process trees (as verify/terminal-split.mjs checks them): the pids and all their descendants {pid, name, cmd}, from
// one snapshot; `match` keeps only the subtrees under processes whose command line matches it.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function withDescendants(pids, match = null) {
  const rows = processSnapshot();
  const all = [];
  for (const p of pids) {
    if (!rows.some((r) => r.pid === p)) continue;
    const tree = descendants(rows, p, { includeRoot: true });
    const tops = match ? tree.filter((r) => match.test(r.cmd)) : [tree[0]];
    for (const top of tops) for (const r of descendants(rows, top.pid, { includeRoot: true })) if (!all.some((x) => x.pid === r.pid)) all.push(r);
  }
  return all;
}
async function gone(procs, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!procs.some((p) => alive(p.pid))) return true;
    await sleep(200);
  }
  return false;
}
const procNames = (procs) => procs.map((p) => `${p.name}:${p.pid}`).join(', ');
// Stand-ins for the bundled Pyright (PYIDE_PYRIGHT_CLI): one reporting a warning per file and logging how many files
// each run got, and one that starts a child (as Pyright starts the interpreter) and never finishes.
const pyrightRuns = path.join(home, 'pyright-runs.log');
const FAKE_PYRIGHT = path.join(home, 'pyright-echo.js');
writeFileSync(FAKE_PYRIGHT, `const path = require('path');
const a = process.argv.slice(2);
const files = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--pythonpath');
require('fs').appendFileSync(${q(pyrightRuns)}, files.length + '\\n');
console.log(JSON.stringify({ generalDiagnostics: files.map((f) => ({ file: path.resolve(f).toUpperCase(), severity: 'warning', message: 'seen', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } })) }));
`);
const HANG_PYRIGHT = path.join(home, 'pyright-hang.js');
writeFileSync(HANG_PYRIGHT, `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
setInterval(() => {}, 1000);
`);
// A server that accepts connections and never answers: a fetch from it hangs.
const silentSockets = new Set();
const silentServer = net.createServer((sock) => { silentSockets.add(sock); sock.on('error', () => {}); });
await new Promise((r) => silentServer.listen(9316, '127.0.0.1', r));
const SILENT_URL = 'http://127.0.0.1:9316/repo.git';
const closeSilent = () => { for (const sock of silentSockets) sock.destroy(); silentServer.close(); };
// A stand-in for Electron: ipcMain with its handlers, the app and windows as event emitters.
function stubElectron() {
  const handlers = new Map();
  const app = new EventEmitter();
  app.getPath = () => home;
  return { app, handlers, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} }, sender: () => new EventEmitter() };
}
{
  process.env.PYIDE_TRUST_ALL = '1';
  const checks = require('../main/features/vcs-checks.js');
  // What libuv puts on the Windows command line for an argument (quote_cmd_arg).
  const quoted = (a) => {
    if (!a) return '""';
    if (!/[\s"]/.test(a)) return a;
    if (!/["\\]/.test(a)) return `"${a}"`;
    let out = '';
    let slashes = 0;
    for (const ch of a) {
      if (ch === '\\') { slashes++; continue; }
      out += '\\'.repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
      slashes = 0;
    }
    return `"${out}${'\\'.repeat(slashes * 2)}"`;
  };
  const commandLine = (args) => args.map(quoted).join(' ');
  const deep = 'C:\\Users\\Some Developer\\Projects\\a rather long project name\\src\\package_with_a_long_name\\sub package';
  const many = Array.from({ length: 3000 }, (_, i) => `${deep}\\module_number_${String(i).padStart(4, '0')}_with_a_descriptive_name.py`);
  const fixed = [process.execPath, path.join(APP, 'node_modules', 'pyright', 'index.js'), '--outputjson', '--pythonpath', 'C:\\Program Files\\Python 3.12\\python.exe'];
  const chunks = checks.chunkFiles(fixed, many);
  const longest = Math.max(...chunks.map((c) => commandLine([...fixed, ...c]).length));
  check(chunks.length > 1 && longest < checks.MAX_COMMAND_LINE && chunks.flat().join('|') === many.join('|'),
    `3000 long paths (${commandLine(many).length} characters) go to Pyright in ${chunks.length} runs, the longest command line ${longest} < ${checks.MAX_COMMAND_LINE}, every file once and in order`);
  // Windows itself takes a chunk and refuses the whole list.
  const probe = ['-e', 'console.log(process.argv.length - 1)'];
  const fit = execFileSync(process.execPath, [...probe, ...chunks[0]], { encoding: 'utf8' }).trim();
  let whole = '';
  try { execFileSync(process.execPath, [...probe, ...many], { encoding: 'utf8', stdio: 'pipe' }); whole = 'started'; } catch (err) { whole = err.code || err.message; }
  check(fit === String(chunks[0].length) && whole !== 'started', `a chunk starts (${fit} arguments); all 3000 at once do not (${whole})`);

  // analyze() over 3000 files: several runs, every file's diagnostics given back with the caller's spelling.
  const s = stubElectron();
  checks.register({ ipcMain: s.ipcMain, app: s.app, unpackedDir: APP });
  const analyzeCh = s.handlers.get('vcs-checks:analyze');
  process.env.PYIDE_PYRIGHT_CLI = FAKE_PYRIGHT;
  const projectFiles = Array.from({ length: 3000 }, (_, i) => path.join(project, 'a rather long package name', 'with a sub package', `module_number_${String(i).padStart(4, '0')}_with_a_descriptive_name.py`));
  const outside = path.join(home, 'outside the project.py');
  const res = await analyzeCh({ sender: s.sender() }, 'many', project, [...projectFiles, outside], null);
  const runs = readLog(pyrightRuns).trim().split('\n').map(Number);
  check(res.ok && res.diagnostics.length === 3001 && new Set(res.diagnostics.map((d) => d.path)).size === 3001 && res.diagnostics.every((d) => d.path === outside || projectFiles.includes(d.path)),
    `Analyze code on 3001 files: ${runs.length} Pyright runs (${runs.join(' + ')} files), each file's problems under its own path (${res.ok ? res.diagnostics.length : q(res)})`);

  // A run that never ends: Cancel, the window reloading, the window closing and quitting each end its whole tree.
  process.env.PYIDE_PYRIGHT_CLI = HANG_PYRIGHT;
  const hung = async (label, sender, stop) => {
    const id = `hang-${label}`;
    const pending = analyzeCh({ sender }, id, project, [path.join(project, 'main.py')], null);
    await waitFor(() => checks.runningPids().length === 1 && withDescendants(checks.runningPids()).length >= 2, `Pyright and its child running (${label})`);
    const tree = withDescendants(checks.runningPids());
    stop(id);
    const r = await Promise.race([pending, sleep(15000).then(() => ({ timeout: true }))]);
    check(await gone(tree) && r.cancelled && !checks.runningPids().length, `${label} ends Pyright and its child (${procNames(tree)}; ${q(r)})`);
  };
  await hung('Cancel', s.sender(), (id) => s.handlers.get('vcs-checks:cancel')({}, id));
  const wc = s.sender();
  await hung('reloading the window', wc, () => wc.emit('did-navigate'));
  const wc2 = s.sender();
  await hung('closing the window', wc2, () => wc2.emit('destroyed'));
  await hung('quitting the IDE', s.sender(), () => s.app.emit('will-quit'));
  // another window's reload leaves a run alone
  const pending = analyzeCh({ sender: s.sender() }, 'other-window', project, [path.join(project, 'main.py')], null);
  await waitFor(() => checks.runningPids().length === 1, 'Pyright running for one window');
  s.sender().emit('did-navigate');
  wc.emit('did-navigate');
  await sleep(1000);
  check(checks.runningPids().length === 1 && alive(checks.runningPids()[0]), "another window's reload leaves the run alone");
  s.app.emit('will-quit');
  await pending;
  delete process.env.PYIDE_PYRIGHT_CLI;

  // Auto-fetch from the silent server: git and its remote helper run until the window reloads or closes, or the IDE
  // quits, and the time limit ends the whole tree too.
  const hangRepo = path.join(home, 'hang');
  git(home, 'clone', '-q', bare, hangRepo);
  git(hangRepo, 'remote', 'set-url', 'origin', SILENT_URL);
  const gitMod = require('../main/features/git.js');
  const g = stubElectron();
  gitMod.register({ ipcMain: g.ipcMain, app: g.app });
  const fetchCh = g.handlers.get('git:backgroundFetch');
  const fetching = async (label, sender, stop) => {
    const pendingFetch = fetchCh({ sender }, hangRepo);
    await waitFor(() => gitMod.fetchPids().length === 1 && withDescendants(gitMod.fetchPids()).some((p) => /remote-http/i.test(p.name)), `git fetch and its remote helper running (${label})`);
    const tree = withDescendants(gitMod.fetchPids());
    stop();
    const r = await Promise.race([pendingFetch, sleep(15000).then(() => ({ timeout: true }))]);
    check(await gone(tree) && r.stopped && !gitMod.fetchPids().length, `${label} ends the background fetch's git tree (${procNames(tree)}; ${q(r)})`);
  };
  const fw = g.sender();
  await fetching('reloading the window', fw, () => fw.emit('did-navigate'));
  const fw2 = g.sender();
  await fetching('closing the window', fw2, () => fw2.emit('destroyed'));
  await fetching('quitting the IDE', g.sender(), () => g.app.emit('will-quit'));
  // the time limit (a fresh copy of the module reads PYIDE_GIT_FETCH_TIMEOUT_MS)
  delete require.cache[require.resolve('../main/features/git.js')];
  process.env.PYIDE_GIT_FETCH_TIMEOUT_MS = '4000';
  const gitShort = require('../main/features/git.js');
  delete process.env.PYIDE_GIT_FETCH_TIMEOUT_MS;
  const timed = gitShort.backgroundFetch(hangRepo);
  await waitFor(() => gitShort.fetchPids().length === 1 && withDescendants(gitShort.fetchPids()).some((p) => /remote-http/i.test(p.name)), 'git fetch running (time limit)');
  const tree = withDescendants(gitShort.fetchPids());
  const timedOut = await timed;
  check(timedOut.timedOut && await gone(tree), `the time limit ends git and its remote helper (${procNames(tree)}; ${q(timedOut.err)})`);
}

let t = await launch({ fixture: 'vcs', port: 9310, name: 'commit-checks', projectDir: project });
let h = helpers(t);
const userData = t.userData;
// Results and renderer exceptions of an instance that is closed before the end.
const retire = (inst) => {
  results.push(...inst.results);
  for (const e of inst.consoleErrors) results.push({ ok: false, label: `renderer exception: ${e}` });
  inst.results.length = 0;
  inst.consoleErrors.length = 0;
  inst.close();
};
const finishAll = (inst) => {
  for (const r of results) inst.results.unshift(r);
  authServer.close();
  closeSilent();
  inst.finish();
};
try {
  const { js } = t;
  const { until, mouse, tick, dialogTitle, dialogText, button, option, setMessage, popup, setOption, refresh } = h;
  await js(`(ide.settings.set('vcs.autoFetchMinutes', 0), true)`);
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected');
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await until(`!!document.querySelector('#vcsCommitOptions')`, 'commit options gear');

  // ---------- options popup and defaults ----------
  await popup(true);
  const opts = await js(`[...document.querySelectorAll('#vcsChecksPopup .vcs-checks-option')].map(r => r.dataset.check + ':' + r.querySelector('input').checked + ':' + r.textContent.trim()).join('|')`);
  check(opts === 'reformat:false:Reformat code|optimizeImports:false:Optimize imports|analyze:true:Analyze code|todo:true:Check TODO|runTests:false:Run tests:No run configurations',
    `the gear lists Before Commit options with PyCharm's defaults (${opts})`);
  check(await js(`document.querySelector('#vcsChecksPopup .vcs-checks-head').textContent`) === 'Before Commit', 'the popup is headed Before Commit');
  await t.press('Escape');
  await until(`!document.querySelector('#vcsChecksPopup')`, 'Esc closes the popup');
  await setOption('reformat', true);
  await setOption('optimizeImports', true);
  await popup(false);

  // ---------- Optimize imports + Reformat code, only on the committed files ----------
  const FMT = 'import sys\nimport os\nx=[1,2,\n3]\nprint( os.getcwd(),x )\n';
  const SKIP = 'import sys\ny=( 1 )\n';
  write(project, 'fmt.py', FMT);
  write(project, 'skip.py', SKIP);
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'main.py'))`);
  await until(`ide.activeTab()?.title === 'main.py'`, 'main.py open');
  // an unsaved edit in the open document, badly formatted
  await js(`(() => { const m = ide.activeTab().model; m.pushEditOperations([], [{ range: m.getFullModelRange(), text: m.getValue().replace('def add(a, b):\\n    return a + b', 'def add(a,b):\\n    return   a+b') }], () => null); return true; })()`);
  await refresh();
  await tick('fmt.py', true);
  await tick('skip.py', false);
  await js(`(window.__progress = [], new MutationObserver(() => { const s = document.querySelector('#vcsChecksProgress .vcs-checks-progress-text')?.textContent; if (s && window.__progress[window.__progress.length - 1] !== s) window.__progress.push(s); }).observe(document.querySelector('#vcsChecksProgress'), { subtree: true, childList: true, characterData: true, attributes: true }), true)`);
  let before = commits();
  await setMessage('Format and sort');
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await waitFor(() => commits() === before + 1, 'formatted commit', 90000);
  const expected = ruff(['format'], ruff(['check', '--select', 'I,F401', '--fix', '--exit-zero', '--quiet'], FMT));
  check(atHead('fmt.py').replace(/\r\n/g, '\n') === expected.replace(/\s+$/, ''), `the committed fmt.py has its imports optimized and is reformatted (${q(atHead('fmt.py'))})`);
  check(!atHead('fmt.py').includes('import sys') && atHead('fmt.py').includes('x = [1, 2, 3]'), 'the unused import is gone and the list reformatted');
  check(readFileSync(path.join(project, 'fmt.py'), 'utf8') === expected, 'the work tree file was rewritten too');
  check(atHead('main.py').includes('def add(a, b):\n    return a + b'), 'the open document was reformatted before it was committed');
  check(await js(`!ide.isDirty(ide.findTab(ide.util.joinPath(ide.root, 'main.py'))) && ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model.getValue().includes('def add(a, b):')`), 'the open document shows the result and is saved');
  check(readFileSync(path.join(project, 'skip.py'), 'utf8') === SKIP, 'a file not being committed is not touched');
  const progress = await js('window.__progress');
  check(q(progress) === q(['Optimizing imports… 1/4', 'Reformatting code… 2/4', 'Analyzing code… 3/4', 'Checking TODO… 4/4']), `the checks ran in order with progress (${q(progress)})`);
  check(await js(`document.querySelector('#vcsChecksProgress').classList.contains('hidden')`), 'the progress strip is gone afterwards');
  // The newest notification whose title matches the pattern.
  const noteOf = (pattern) => js(`(() => { const e = ide.notifications.list().reverse().find(n => new RegExp(${q(pattern)}).test(n.title)); return e ? { title: e.title, text: e.text, kind: e.kind, actions: e.actions.map(a => a.label) } : null; })()`);
  const done = await noteOf('^Reformatted \\d+ files before commit$');
  check(done?.kind === 'info' && done.text.startsWith('Undo restores the files as they were before the checks.') && done.actions[0] === 'Undo'
    && (await js('ide.vcsChecks.lastRewrite()?.count')) >= 2, `a notification reports the rewrite of fmt.py and main.py with Undo (${q(done)})`);

  // ---------- a commit stopped after the reformat: Undo, and the Local History checkpoint ----------
  // undo.py was never opened: only the project watcher may have recorded it before the checks.
  const UNDO_SRC = 'import os\nx=( 1 )\nprint(undefined_in_undo)\n';
  const undoPath = path.join(project, 'undo.py');
  write(project, 'undo.py', UNDO_SRC);
  await refresh();
  await tick('undo.py', true);
  await tick('skip.py', false);
  await setMessage('Reformat, then stop');
  before = commits();
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Code Analysis'`, 'Code Analysis dialog after the reformat', 60000);
  await mouse(button('Cancel'), 'Cancel');
  await until(`!document.querySelector('#dialogHost .dialog') && document.querySelector('#vcsChecksProgress').classList.contains('hidden')`, 'checks stopped after the reformat');
  const reformatted = readFileSync(undoPath, 'utf8');
  check(commits() === before && reformatted.includes('x = 1') && !reformatted.includes('import os'), `the commit stopped with undo.py rewritten on disk (${q(reformatted)})`);
  const stopped = await noteOf('^Reformatted 1 file before commit$');
  check(stopped?.kind === 'warn' && stopped.text.startsWith('The commit was stopped. Undo restores the files as they were before the checks.')
    && stopped.text.includes('"Before Commit Checks"') && q(stopped.actions) === q(['Undo', 'Show Local History']), `the notification says the commit stopped and offers Undo (${q(stopped)})`);
  // A label stands for each file's latest revision at or before it, as the Local History view shows it: the checkpoint's
  // own revision, or the "Created" one when the project watcher recorded undo.py first (the checkpoint then adds no
  // revision with the same content).
  const lh = await js(`ide.api.invoke('localHistory:list', ide.root, ${q(undoPath)}, false).then(async (r) => {
    const label = r.labels.find((l) => l.l === 'Before Commit Checks');
    const c = label && r.revisions.find((v) => v.t <= label.t);
    return { labels: r.labels.map((l) => l.l), kind: c?.k, text: c?.h ? (await ide.api.invoke('localHistory:content', ide.root, c.h)).text : null };
  })`);
  check(lh.text === UNDO_SRC && lh.labels.includes('Before Commit Checks'), `Local History keeps undo.py's text from before the checks under "Before Commit Checks" (${q(lh)})`);
  await mouse(`[...document.querySelectorAll('.ide-balloon')].find(b => b.querySelector('.ide-balloon-title')?.textContent === 'Reformatted 1 file before commit')?.querySelector('.ide-balloon-actions button')`, 'Undo');
  await waitFor(() => readFileSync(undoPath, 'utf8') === UNDO_SRC, 'undo.py restored by Undo', 15000);
  check(commits() === before && (await js(`ide.notifications.list().find(n => n.title === 'Reformatted 1 file before commit').expired`)), 'Undo restores the file in one step and the action is used up');
  rmSync(undoPath);
  await refresh();
  await setOption('reformat', false);
  await setOption('optimizeImports', false);
  await popup(false);

  // ---------- Analyze code ----------
  write(project, 'bad.py', 'def f() -> int:\n    return "x"\n\n\nprint(undefined_name)\n');
  await refresh();
  await tick('bad.py', true);
  await setMessage('Add bad.py');
  before = commits();
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Code Analysis'`, 'Code Analysis dialog', 60000);
  const analysis = await dialogText();
  const errs = Number(/(\d+) errors?/.exec(analysis)?.[1]);
  const warns = Number(/(\d+) warnings?/.exec(analysis)?.[1]);
  check(errs >= 2 && warns >= 1, `errors stop the commit: "${analysis}"`);
  check(await js(`[...document.querySelectorAll('#dialogHost .dialog-buttons button')].map(b => b.textContent).join('|')`) === 'Review|Commit Anyway|Cancel', 'the dialog offers Review, Commit Anyway and Cancel');
  await mouse(button('Cancel'), 'Cancel');
  await until(`!document.querySelector('#dialogHost .dialog') && document.querySelector('#vcsChecksProgress').classList.contains('hidden')`, 'checks stopped');
  check(commits() === before && await js(`document.querySelector('.vcs-msg').value`) === 'Add bad.py', 'Cancel commits nothing and keeps the message');
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Code Analysis'`, 'Code Analysis dialog again', 60000);
  await mouse(button('Review'), 'Review');
  await until(`document.querySelectorAll('#vcsChecksResults .vcs-checks-row.error').length >= 2`, 'review tab with the errors');
  check(commits() === before, 'Review commits nothing');
  check(await js(`[...document.querySelectorAll('#vcsChecksResults .vcs-checks-row')].every(r => r.dataset.path.endsWith('bad.py')) && [...document.querySelectorAll('#vcsChecksResults .vcs-checks-row.error')].some(r => r.textContent.includes('undefined_name'))`), 'the review lists the problems of bad.py');
  await mouse(`[...document.querySelectorAll('#vcsChecksResults .vcs-checks-row.error')].find(r => r.dataset.line === '5')`, 'problem row');
  await until(`ide.activeTab()?.title === 'bad.py' && ide.editor.getPosition().lineNumber === 5`, 'a problem row opens the file at its line');
  check(true, 'a review row opens the file at the problem');
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Code Analysis'`, 'Code Analysis dialog a third time', 60000);
  await mouse(button('Commit Anyway'), 'Commit Anyway');
  await waitFor(() => commits() === before + 1, 'commit anyway');
  check(atHead('bad.py').includes('undefined_name'), 'Commit Anyway commits the file');

  // ---------- Check TODO ----------
  write(project, 'todo.py', '# TODO: existing item\nVALUE = 2  # TODO: new item here\n# FIXME: and this one\n');
  await refresh();
  await tick('todo.py', true);
  await setMessage('More TODOs');
  before = commits();
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Check TODO'`, 'Check TODO dialog', 60000);
  check((await dialogText()) === 'The changes add 2 TODO items.', `new TODO and FIXME comments stop the commit, the old one does not count (${await dialogText()})`);
  await mouse(button('Review'), 'Review');
  await until(`[...document.querySelectorAll('#vcsChecksResults .vcs-checks-row.todo')].length === 2`, 'TODO review');
  check(await js(`[...document.querySelectorAll('#vcsChecksResults .vcs-checks-row.todo .vcs-checks-msg')].map(n => n.textContent).join('|')`) === 'TODO: new item here|FIXME: and this one', 'the review lists the new items');
  check(commits() === before, 'Review commits nothing');

  // Commit and Push runs the same checks
  await mouse(`document.querySelector('.vcs-commit-push-btn')`, 'Commit and Push');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Check TODO'`, 'Check TODO dialog from Commit and Push', 60000);
  await mouse(button('Cancel'), 'Cancel');
  await until(`!document.querySelector('#dialogHost .dialog')`, 'dialog closed');
  check(commits() === before, 'Commit and Push stops on the checks too');
  await mouse(`document.querySelector('.vcs-commit-push-btn')`, 'Commit and Push');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Check TODO'`, 'Check TODO dialog once more', 60000);
  await mouse(button('Commit Anyway'), 'Commit Anyway');
  await until(`(document.querySelector('#dialogHost .dialog-title')?.textContent || '').startsWith('Push Commits to')`, 'push dialog', 30000);
  check(commits() === before + 1, 'Commit Anyway commits, then the push dialog opens');
  await mouse(button('Push'), 'Push');
  await waitFor(() => git(bare, 'log', '-1', '--format=%s', 'main') === 'More TODOs', 'pushed to the bare remote');
  check(true, 'Commit and Push pushed the commit');

  // ---------- Run tests ----------
  const cfgId = await js(`ide.run.addTemporary({ type: 'pytest', name: 'pytest in test_calc.py', target: 'test_calc.py' }).id`);
  await popup(true);
  await js(`(() => { const s = document.querySelector('#vcsChecksTestConfig'); s.value = ${q(cfgId)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(`${option('runTests')}.checked && ide.settings.get('vcs.commitChecks.runTests') === true && ide.settings.get('vcs.commitChecks.testConfig:' + ide.root) === ${q(cfgId)}`, 'choosing a configuration turns Run tests on');
  check(true, 'choosing a test configuration turns Run tests on and remembers it for the project');
  await popup(false);
  write(project, 'test_calc.py', TEST_OK.replace('add(2, 3), 5', 'add(2, 3), 6'));
  write(project, 'calc.py', 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');
  await refresh();
  await tick('calc.py', true);
  await tick('test_calc.py', true);
  await setMessage('Add sub');
  before = commits();
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Tests Failed'`, 'Tests Failed dialog', 90000);
  check((await dialogText()).startsWith('pytest in test_calc.py failed.'), `failing tests stop the commit (${await dialogText()})`);
  await mouse(button('Review'), 'Review');
  await until(`!document.querySelector('#dialogHost .dialog') && ide.toolWindows.get('Run').isVisible() && ide.run.activeSession()?.cfg.id === ${q(cfgId)}`, 'Run window with the test session');
  check(commits() === before, 'Review shows the test run and commits nothing');
  // a slow test, cancelled while it runs
  write(project, 'test_calc.py', TEST_OK.replace('    def test_add(self):\n', '    def test_add(self):\n        import time\n        time.sleep(60)\n'));
  await refresh();
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await until(`(document.querySelector('#vcsChecksProgress .vcs-checks-progress-text')?.textContent || '').startsWith('Running tests: pytest in test_calc.py…') && ide.run.sessions().some(s => s.running)`, 'tests running', 60000);
  await mouse(`document.querySelector('#vcsChecksCancel')`, 'Cancel');
  await until(`document.querySelector('#vcsChecksProgress').classList.contains('hidden') && !ide.run.sessions().some(s => s.running)`, 'cancelled', 20000);
  await sleep(500);
  check(commits() === before && !(await js(`!!document.querySelector('#dialogHost .dialog')`)), 'Cancel stops the test run and the commit');
  write(project, 'test_calc.py', TEST_OK);
  await refresh();
  await until(`!${h.row('test_calc.py')}`, 'test_calc.py unchanged again');
  await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
  await waitFor(() => commits() === before + 1, 'commit after passing tests', 90000);
  check(atHead('calc.py').includes('def sub'), 'passing tests let the commit through');
  retire(t);

  // ---------- options after a restart ----------
  t = await launch({ fixture: 'vcs', port: 9311, name: 'commit-checks-2', projectDir: project, userData });
  h = helpers(t);
  {
    const { js } = t;
    const { until, mouse, popup, menuItem, errorNotes } = h;
    await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected after restart');
    await js(`(ide.toolWindows.get('Commit').show(), true)`);
    await popup(true);
    const kept = await js(`[...document.querySelectorAll('#vcsChecksPopup .vcs-checks-option')].map(r => r.dataset.check + ':' + r.querySelector('input').checked).join('|') + '|' + document.querySelector('#vcsChecksTestConfig').value`);
    check(kept === `reformat:false|optimizeImports:false|analyze:true|todo:true|runTests:true|${cfgId}`, `the options and the project's test configuration survive a restart (${kept})`);
    await js(`(ide.settings.set('vcs.commitChecks.runTests', false), ide.settings.set('vcs.commitChecks.reformat', true), true)`);
    await popup(false);
    await popup(true);
    check(await js(`document.querySelector('#vcsChecksPopup [data-check="reformat"] input').checked && !document.querySelector('#vcsChecksPopup [data-check="runTests"] input').checked`), 'the popup reads the settings when it opens');
    await js(`(ide.settings.set('vcs.commitChecks.reformat', false), true)`);
    await popup(false);

    // ---------- auto-fetch ----------
    check(await js(`ide.settings.get('vcs.autoFetchMinutes')`) === 0 && (await js('ide.vcs.autoFetch.state().nextDelay')) === 0, '0 minutes: no fetch is scheduled');
    for (const n of [1, 2, 3]) {
      git(other, 'pull', '-q', '--no-rebase', 'origin', 'main');
      write(other, `remote-${n}.txt`, `remote change ${n}\n`);
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '-m', `Remote change ${n}`);
    }
    git(other, 'push', '-q', 'origin', 'main');
    check(git(project, 'rev-list', '--count', 'HEAD..origin/main') === '0', 'the project has not fetched the new commits yet');
    const errorsBefore = await errorNotes();
    const setAt = Date.now();
    await js(`(ide.settings.set('vcs.autoFetchMinutes', 0.05), true)`); // 3 s
    await until(`document.querySelector('#vcsSync')?.dataset.behind === '3' && document.querySelector('#vcsSync').dataset.ahead === '1'`, 'auto-fetch shows ↓3 ↑1', 20000);
    const took = Date.now() - setAt;
    check(took < 15000, `auto-fetch updated the counts within the interval (${took} ms)`);
    check(await js(`document.querySelector('#vcsSync').textContent`) === '↓3↑1' && await js(`!document.querySelector('#vcsSync').classList.contains('hidden')`), 'the toolbar shows ↓3 ↑1 next to the branch');
    const tip = await js(`document.querySelector('#vcsSync').title`);
    check(tip.includes('3 incoming commits from origin/main') && tip.includes('1 outgoing commit to origin/main') && tip.includes('Last fetched at') && tip.includes('Click to update the project'), `its tooltip explains the counts (${q(tip)})`);
    check(await js(`document.querySelector('#vcsSync').previousElementSibling === document.querySelector('.vcs-branch') || document.querySelector('.vcs-branch').nextElementSibling === document.querySelector('#vcsSync')`), 'it sits right after the branch widget');
    await mouse(`document.querySelector('#vcsSync')`, 'sync widget');
    await until(`!!${menuItem('Update Project…')}`, 'menu with Update Project');
    check(await js(`[...document.querySelectorAll('#menuHost .menu-item')].map(m => m.firstChild.textContent).join('|')`) === 'Update Project…|Push…|Fetch', 'a click offers Update Project (and Push, Fetch)');
    await mouse(menuItem('Update Project…'), 'Update Project…');
    await until(`document.querySelector('#vcsSync')?.dataset.behind === '0' || document.querySelector('#vcsSync').classList.contains('hidden')`, 'up to date after Update Project', 30000);
    check(existsSync(path.join(project, 'remote-3.txt')), 'Update Project pulled the incoming commits');
    check((await errorNotes()) === errorsBefore, 'no error notification so far');

    // offline: failures back off, quietly
    git(project, 'remote', 'set-url', 'origin', OFFLINE_URL);
    await js(`(ide.settings.set('vcs.autoFetchMinutes', 0.02), true)`); // 1.2 s
    await until(`ide.vcs.autoFetch.state().failures >= 3`, 'three failed fetches', 40000);
    const st = await js('ide.vcs.autoFetch.state()');
    check(st.nextDelay === 1200 * 2 ** st.failures, `each failure doubles the wait (${st.failures} failures, next in ${st.nextDelay} ms)`);
    const attempts = st.attempts;
    await sleep(4000);
    check((await js('ide.vcs.autoFetch.state().attempts')) === attempts, 'no fetch is tried before the stretched interval is over');
    check((await errorNotes()) === errorsBefore && !(await js(`!!document.querySelector('#dialogHost .dialog')`)), 'failing fetches show no error popup and no dialog');
    const log = readLog(path.join(userData, 'logs', 'pyide.log'));
    check(/WARN - #git - Background fetch failed/.test(log), 'the failures are written to the IDE log');

    // a remote that wants credentials
    git(project, 'remote', 'set-url', 'origin', AUTH_URL);
    const requests = authRequests;
    const targets = (await (await fetch('http://127.0.0.1:9311/json')).json()).length;
    await js(`(ide.settings.set('vcs.autoFetchMinutes', 0.03), true)`);
    await until(`ide.vcs.autoFetch.state().failures >= 1 && !ide.vcs.autoFetch.state().running`, 'fetch from a remote needing credentials failed', 30000);
    check(authRequests > requests, 'the fetch asked the server, which wanted credentials');
    check(readLog(askpassLog) === '' && !(await js(`!!document.querySelector('#dialogHost .dialog')`)) && (await errorNotes()) === errorsBefore, 'no askpass, no dialog, no error popup');
    check((await (await fetch('http://127.0.0.1:9311/json')).json()).length === targets, 'no window was opened');
    // git's own wording for credential.interactive=never ("unable to get password from user"), or older gits'
    check(/unable to get password|could not read Username|terminal prompts disabled|Authentication failed/i.test(await js('ide.vcs.autoFetch.state().lastError')), `the reason is kept for the log (${q(await js('ide.vcs.autoFetch.state().lastError'))})`);

    // 0 turns it off
    await js(`(ide.settings.set('vcs.autoFetchMinutes', 0), true)`);
    const off = await js('ide.vcs.autoFetch.state().attempts');
    await sleep(3000);
    check((await js('ide.vcs.autoFetch.state().attempts')) === off && (await js('ide.vcs.autoFetch.state().nextDelay')) === 0, '0 turns auto-fetch off');
    git(project, 'remote', 'set-url', 'origin', bare);
  }
  retire(t);

  // ---------- Korean ----------
  t = await launch({ fixture: 'vcs', port: 9312, name: 'commit-checks-ko', projectDir: project, userData, lang: 'ko-KR' });
  h = helpers(t);
  {
    const { js } = t;
    const { until, mouse, popup, tick, button, setMessage, refresh } = h;
    await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected (Korean)');
    await js(`(ide.toolWindows.get('Commit').show(), true)`);
    await popup(true);
    const labels = await js(`[...document.querySelectorAll('#vcsChecksPopup .vcs-checks-option > span')].map(n => n.textContent).join('|')`);
    check(labels === '코드 서식 다시 지정|import 최적화|코드 분석|TODO 확인|테스트 실행:', `the options are in Korean (${labels})`);
    check(await js(`document.querySelector('#vcsChecksPopup .vcs-checks-head').textContent`) === '커밋 전', 'Before Commit is in Korean');
    const leaks = await englishLeaks(t, '#vcsChecksPopup');
    check(!leaks.length, `no English in the popup (${q(leaks)})`);
    check(await js(`document.querySelector('#vcsCommitOptions').title`) === '커밋 옵션', 'the gear tooltip is in Korean');
    await popup(false);
    // the sync widget (ahead after the merge of Update Project)
    await js(`ide.vcs.refresh().then(() => true)`);
    await until(`!document.querySelector('#vcsSync').classList.contains('hidden')`, 'sync widget shown');
    const tipKo = await js(`document.querySelector('#vcsSync').title`);
    check(/나가는 커밋 \d+개/.test(tipKo) && tipKo.includes('클릭하여 프로젝트 업데이트'), `the counts' tooltip is in Korean (${q(tipKo)})`);
    await mouse(`document.querySelector('#vcsSync')`, 'sync widget');
    await until(`[...document.querySelectorAll('#menuHost .menu-item')].some(m => m.firstChild.textContent === '프로젝트 업데이트…')`, 'Korean menu');
    check(await js(`[...document.querySelectorAll('#menuHost .menu-item')].map(m => m.firstChild.textContent).join('|')`) === '프로젝트 업데이트…|푸시…|페치', 'the menu is in Korean');
    await t.press('Escape');
    // the code analysis dialog
    write(project, 'bad2.py', 'def g() -> str:\n    return 1\n');
    await refresh();
    await tick('bad2.py', true);
    await setMessage('Korean check');
    await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
    await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === '코드 분석'`, 'Korean Code Analysis dialog', 60000);
    const body = await js(`document.querySelector('#dialogHost .dialog-body').textContent`);
    check(/오류 \d+개, 경고 \d+개/.test(body) && body.includes('코드 분석에서 커밋할 파일의 문제를 발견했습니다'), `the dialog is in Korean (${body})`);
    check(await js(`[...document.querySelectorAll('#dialogHost .dialog-buttons button')].map(b => b.textContent).join('|')`) === '검토|그래도 커밋|취소', 'its buttons are in Korean');
    const dlgLeaks = await englishLeaks(t, '#dialogHost .dialog');
    check(!dlgLeaks.length, `no English in the dialog (${q(dlgLeaks)})`);
    await mouse(button('검토'), 'Review');
    await until(`document.querySelectorAll('#vcsChecksResults .vcs-checks-row').length > 0`, 'Korean review tab');
    const resLeaks = await englishLeaks(t, '#vcsChecksResults');
    check(!resLeaks.length, `no English in the review tab (${q(resLeaks)})`);
    await js(`ide.openSettings('vcs-git')`);
    await until(`[...document.querySelectorAll('.settings-main input[data-key="vcs.autoFetchMinutes"]')].length === 1`, 'Git settings page');
    const pageLeaks = await englishLeaks(t, '.settings-main');
    check(!pageLeaks.length, `the Git settings page is in Korean (${q(pageLeaks)})`);
    await t.press('Escape');
    const own = new Set([
      ...Object.keys(JSON.parse(readFileSync(path.join(APP, 'renderer/features/vcs-checks/locales/ko.json'), 'utf8'))),
      ...Object.keys(JSON.parse(readFileSync(path.join(APP, 'renderer/features/vcs/locales/ko.json'), 'utf8'))),
    ]);
    for (const src of ['renderer/features/vcs-checks/index.js', 'renderer/features/vcs/index.js']) {
      const code = readFileSync(path.join(APP, src), 'utf8');
      for (const m of code.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) own.add(m[2].replace(/\\'/g, "'"));
      for (const m of code.matchAll(/\btrn\([^,]+,\s*'([^']*)',\s*'([^']*)'/g)) { own.add(m[1]); own.add(m[2]); }
    }
    const missing = (await missingTranslations(t)).filter((s) => own.has(s));
    check(!missing.length, `no missing translations (${q(missing)})`);
    // Every string the commit checks pass to tr() has a Korean entry, shown or not.
    const ko = { ...JSON.parse(readFileSync(path.join(APP, 'renderer/locales/ko.json'), 'utf8')), ...JSON.parse(readFileSync(path.join(APP, 'renderer/features/vcs-checks/locales/ko.json'), 'utf8')) };
    const code = readFileSync(path.join(APP, 'renderer/features/vcs-checks/index.js'), 'utf8');
    const used = [...code.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    for (const m of code.matchAll(/\btrn\([^,]+,\s*'([^']*)',\s*'([^']*)'/g)) used.push(m[1], m[2]);
    const lacking = used.filter((s) => !(s in ko));
    check(used.length > 30 && !lacking.length, `every commit-checks string has a Korean entry (${used.length} strings; missing ${q(lacking)})`);
  }
  await t.shot('korean.png');
  retire(t);

  // ---------- no Pyright or git process outlives a reload or the IDE ----------
  // Pyright is the stand-in that never finishes (and starts a child, as Pyright starts the interpreter); the
  // background fetch hangs on the silent server.
  t = await launch({ fixture: 'vcs', port: 9313, name: 'commit-checks-quit', projectDir: project, userData, env: { PYIDE_PYRIGHT_CLI: HANG_PYRIGHT } });
  h = helpers(t);
  {
    const { js, cdp } = t;
    const { until, mouse, tick, setMessage, refresh } = h;
    const repoShown = (label) => until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, label);
    await repoShown('repository detected (quit)');
    await js(`(ide.settings.set('vcs.autoFetchMinutes', 0), ide.settings.set('vcs.commitChecks.analyze', true), ide.settings.set('vcs.commitChecks.runTests', false), true)`);
    write(project, 'hang.py', 'VALUE = 1\n');
    const PYRIGHT = /pyright-hang\.js/;
    const startAnalysis = async (label) => {
      await js(`(ide.toolWindows.get('Commit').show(), true)`);
      await refresh();
      await tick('hang.py', true);
      await setMessage('Never committed');
      await mouse(`document.querySelector('.vcs-commit-btn')`, 'Commit');
      await until(`(document.querySelector('#vcsChecksProgress .vcs-checks-progress-text')?.textContent || '').startsWith('Analyzing code…')`, `analysis running (${label})`, 60000);
      await waitFor(() => withDescendants([t.pid], PYRIGHT).length >= 2, `Pyright and its child running under the IDE (${label})`);
      return withDescendants([t.pid], PYRIGHT);
    };
    let tree = await startAnalysis('reload');
    await cdp('Page.reload');
    await until('window.__ideReady === true', 'IDE ready after the reload', 40000);
    check(await gone(tree), `reloading the window ends Pyright and its child (${procNames(tree)})`);
    await repoShown('repository detected after the reload');
    tree = await startAnalysis('quit');
    git(project, 'remote', 'set-url', 'origin', SILENT_URL);
    await js(`ide.vcs.refresh().then(() => (ide.vcs.autoFetch.now(), true))`);
    await waitFor(() => withDescendants([t.pid], /\bfetch\b/).some((p) => /remote-http/i.test(p.name)), 'background fetch hanging on the silent server');
    const fetchTree = withDescendants([t.pid], /\bfetch\b/);
    js(`ide.runAction('Exit')`).catch(() => {});
    const end = Date.now() + 20000;
    while (alive(t.pid) && Date.now() < end) await sleep(250);
    check(!alive(t.pid), 'Exit quits the IDE while the checks and a fetch run');
    check(await gone(tree), `no Pyright process is left after the IDE closed (${procNames(tree)})`);
    check(await gone(fetchTree), `no git process is left after the IDE closed (${procNames(fetchTree)})`);
    git(project, 'remote', 'set-url', 'origin', bare);
    rmSync(path.join(project, 'hang.py'));
  }
} catch (err) {
  console.log(`FAIL ${err.message}`);
  t.results.push({ ok: false, label: err.message });
  try { await t.shot('failure.png'); } catch {}
}
finishAll(t);
