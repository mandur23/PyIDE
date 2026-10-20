// Remote interpreters (WSL, SSH, Docker, Docker Compose) end to end. By default the targets are stand-ins:
// verify/remote-fake builds wsl.exe, ssh.exe and docker.exe that this test puts first on PATH, each running a venv's
// Python behind a path-mapped root (see fakeremote.py). For each kind the test adds the interpreter in Settings, then
// runs a script, follows a traceback, debugs to a breakpoint, runs pytest, lists packages, uses the Python Console,
// opens a terminal and checks Pyright against the target's libraries. Ports 9730-9739.
// REMOTE_REAL=wsl | docker | ssh:<host> runs the same checks against what this machine really has (REMOTE_WSL_DISTRO,
// REMOTE_DOCKER_IMAGE pick the target) and skips with a message when it is not there.
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = process.env.REMOTE_REAL || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = (msg) => { console.log(`SKIP ${msg}`); process.exit(0); };

// ---------- targets ----------
let fake = null;
let kinds;
if (!REAL) {
  fake = setupFakes();
  const projectDir = (p) => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`;
  kinds = [
    { kind: 'wsl', menu: 'On WSL…', fill: { remoteDistro: 'FakeUbuntu' }, name: 'WSL FakeUbuntu', system: 'Windows wsl:FakeUbuntu', dir: projectDir },
    { kind: 'ssh', menu: 'On SSH…', fill: { remoteHost: 'devbox' }, name: 'SSH devbox', system: 'Windows ssh:devbox', dir: () => /\/home\/dev\/pyide-projects\/project-\w+/ },
    { kind: 'ssh', id: 'ssh-password', menu: 'On SSH…', fill: { remoteHost: 'pw@pwbox', remoteAuth: 'password', remotePassword: 's3cret pass' }, wrongPassword: 'nope',
      name: 'SSH pw@pwbox', system: 'Windows ssh:pwbox', dir: () => /\/home\/pw\/pyide-projects\/project-\w+/ },
    { kind: 'docker', menu: 'On Docker…', fill: { remoteImage: 'python:3.12-slim' }, name: 'Docker python:3.12-slim', system: /Windows docker:pyide-\w+/, dir: () => '/opt/project' },
    { kind: 'compose', menu: 'On Docker Compose…', fill: { remoteService: 'web' }, name: 'Compose web', system: /Windows docker:pyide-\w+/, dir: () => '/opt/project' },
  ];
} else if (REAL === 'wsl') {
  const wsl = spawnSync('wsl.exe', ['-l', '-v']);
  if (wsl.error) skip('REMOTE_REAL=wsl: wsl.exe is not installed');
  const text = wsl.stdout.toString(wsl.stdout[1] === 0 ? 'utf16le' : 'utf8').replace(/\0/g, '');
  const distros = text.split(/\r?\n/).slice(1).map((l) => /^\*?\s*(\S+)\s+\S+\s+\d+\s*$/.exec(l.trim())?.[1]).filter(Boolean);
  const distro = process.env.REMOTE_WSL_DISTRO || distros.find((d) => /^Ubuntu/i.test(d)) || distros[0];
  if (!distro) skip('REMOTE_REAL=wsl: no WSL distributions are installed');
  const py = spawnSync('wsl.exe', ['-d', distro, '--exec', 'sh', '-c', 'command -v python3'], { encoding: 'utf8' });
  if (py.status !== 0) skip(`REMOTE_REAL=wsl: ${distro} has no python3`);
  kinds = [{ kind: 'wsl', menu: 'On WSL…', fill: { remoteDistro: distro }, name: `WSL ${distro}`, system: 'Linux', real: true,
    dir: (p) => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}` }];
} else if (REAL === 'docker') {
  const v = spawnSync('docker', ['version', '--format', '{{json .Server}}'], { encoding: 'utf8' });
  if (v.error) skip('REMOTE_REAL=docker: Docker is not installed');
  if (v.status !== 0 || v.stdout.trim() === 'null') skip(`REMOTE_REAL=docker: the Docker daemon is not running (${v.stderr.trim().split('\n')[0]})`);
  const image = process.env.REMOTE_DOCKER_IMAGE || 'python:3.12-slim';
  kinds = [{ kind: 'docker', menu: 'On Docker…', fill: { remoteImage: image }, name: `Docker ${image}`, system: 'Linux', real: true, dir: () => '/opt/project' }];
} else if (REAL.startsWith('ssh:')) {
  const host = REAL.slice(4);
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'command -v python3'], { encoding: 'utf8' });
  if (r.error) skip('REMOTE_REAL=ssh: the OpenSSH client is not installed');
  if (r.status !== 0) skip(`REMOTE_REAL=ssh: cannot log in to ${host} without a password or it has no python3 (${(r.stderr || '').trim()})`);
  kinds = [{ kind: 'ssh', menu: 'On SSH…', fill: { remoteHost: host }, name: `SSH ${host}`, system: /Linux|Darwin/, real: true, dir: () => /\/pyide-projects\/project-\w+/ }];
} else {
  skip(`unknown REMOTE_REAL=${REAL} (use wsl, docker or ssh:<host>)`);
}

function setupFakes() {
  const venv = path.join(APP, 'verify', 'out', 'remote-interp-venv');
  const vpy = path.join(venv, 'Scripts', 'python.exe');
  if (!existsSync(vpy)) {
    console.log('creating the targets\' venv with pytest (once)…');
    execFileSync('py', ['-3', '-m', 'venv', venv], { stdio: 'inherit' });
    execFileSync(vpy, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'pytest'], { stdio: 'inherit' });
  }
  // A package only the targets have: Pyright must resolve it from the synced copy of their site-packages.
  const site = execFileSync(vpy, ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(site, 'remote_only_pkg'), { recursive: true });
  writeFileSync(path.join(site, 'remote_only_pkg', '__init__.py'), 'GREETING = "hello from the target"\n');
  // Short: folders in the fake targets become working directories, which Windows limits to MAX_PATH.
  const base = mkdtempSync(path.join(tmpdir(), 'prf-'));
  const bin = path.join(base, 'bin');
  const root = path.join(base, 'root');
  mkdirSync(root);
  execFileSync('py', ['-3', path.join(APP, 'verify', 'remote-fake', 'make_launchers.py'), bin]);
  writeFileSync(path.join(root, 'wsl.json'), JSON.stringify({ distros: [{ name: 'FakeUbuntu', default: true }, { name: 'Other' }] }));
  writeFileSync(path.join(root, 'ssh.json'), JSON.stringify({ hosts: { devbox: { user: 'dev' }, pwbox: { user: 'pw', password: 's3cret pass' } } }));
  writeFileSync(path.join(root, 'docker.json'), JSON.stringify({ images: ['python:3.12-slim'], services: ['web'] }));
  writeFileSync(path.join(root, 'ssh_config'), 'Host devbox\n  HostName devbox.example\n  User dev\n\nHost pwbox\n  User pw\n\nHost *\n  ServerAliveInterval 30\n');
  process.env.PATH = `${bin};${process.env.PATH}`;
  Object.assign(process.env, { PYIDE_FAKE_REMOTE_ROOT: root, PYIDE_FAKE_PYTHON: vpy, PYIDE_SSH_CONFIG: path.join(root, 'ssh_config') });
  return { bin, root, calls: () => readFileSync(path.join(root, 'calls.log'), 'utf8') };
}

// Live local processes whose command line contains `needle` (the fakes run the target's programs here).
const procCount = (needle) => Number(execFileSync('powershell', ['-NoProfile', '-Command',
  `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}') -and $_.Name -notlike 'powershell*' }).Count`],
{ encoding: 'utf8' }).trim());

// ---------- the IDE ----------
const t = await launch({ fixture: 'remote-interp', port: REAL ? 9732 : 9730, name: REAL ? `remote-interp-real-${REAL.replace(/\W/g, '-')}` : 'remote-interp' });
const { js, until, press, type, click, check, shot } = t;
const local = (rel) => path.join(t.project, rel);

const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
const matches = (s, want) => (want instanceof RegExp ? want.test(s) : s.includes(want));
const clickWhere = async (sel, pred) => {
  const id = await js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(sel)})].find(${pred}); if (!n) return null; n.id ||= 'ri' + Math.random().toString(36).slice(2); return n.id; })()`);
  if (!id) throw new Error(`no ${sel} matching ${pred}`);
  await click(`#${id}`);
};
const setField = (id, value) => js(`(() => { const n = document.getElementById(${JSON.stringify(id)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('change')); return true; })()`);

async function openAddForm(k) {
  await js(`ide.openSettings('interpreter')`);
  await until(`!!document.querySelector('#addInterpBtn')`, 'interpreter settings page');
  await click('#addInterpBtn');
  await until(`!!document.querySelector('#addInterpMenu')`, 'Add Interpreter menu');
  await js(`[...document.querySelectorAll('#addInterpMenu .menu-item')].find(n => n.textContent === ${JSON.stringify(k.menu)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`!!document.querySelector('#remoteInterpForm') && document.querySelector('#remoteAvailability').textContent !== 'Detecting…'`, `${k.menu} form`, 60000);
}

async function addInterpreter(k) {
  await openAddForm(k);
  check(await js(`!document.querySelector('#remoteAdd').disabled`), `${k.id || k.kind}: ${k.menu} shows a form (${await text('#remoteAvailability')})`);
  for (const [id, v] of Object.entries(k.fill)) await setField(id, v);
  if (k.wrongPassword) {
    await setField('remotePassword', k.wrongPassword);
    await click('#remoteAdd');
    await until(`document.querySelector('#remoteLog').textContent.includes('Could not add')`, 'wrong password rejected', 60000);
    check((await text('#remoteLog')).includes('Permission denied'), `${k.id}: a wrong password is reported by ssh (${await text('#remoteLog')})`);
    await setField('remotePassword', k.fill.remotePassword);
  }
  await click('#remoteAdd');
  await until(`document.querySelector('#interpStatus').textContent.startsWith('Added') || document.querySelector('#remoteLog').textContent.includes('Could not add')`, `${k.kind} added`, 180000);
  const status = await text('#interpStatus');
  check(status.startsWith(`Added ${k.name} (Python `), `${k.id || k.kind}: adding checks the target and its Python (${status || await text('#remoteLog')})`);
  await click('#settingsOk');
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
  await until(`ide.currentInterp()?.target && ide.currentInterp().label.startsWith(${JSON.stringify(k.name)})`, 'remote interpreter selected', 30000);
  check(true, `${k.id || k.kind}: the new interpreter becomes the project interpreter (${await js('ide.currentInterp().label')})`);
}

// Each kind gets its own configuration (and so its own Run tab); temporary ones would be shared by script path.
async function runConfig(name, cfg, done = 'Process finished with exit code') {
  const full = { id: `ri-${name.replace(/\W+/g, '-')}`, name, cwd: '', env: '', ...(cfg.type === 'python' ? { params: '', interp: '' } : { args: '' }), ...cfg };
  await js(`(ide.run.runConfig(${JSON.stringify(full)}), true)`);
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === ${JSON.stringify(name)} && document.querySelector('#runOut')?.textContent.includes(${JSON.stringify(done)})`, `${name} finished`, 180000);
  return text('#runOut');
}

async function exercise(k) {
  const label = k.id || k.kind;
  const dir = k.dir(t.project);

  // ---- Run ----
  const out = await runConfig(`main ${label}`, { type: 'python', script: local('main.py'), params: 'one two' });
  check(out.includes('answer 42') && matches(out, typeof k.system === 'string' ? `system ${k.system}` : k.system) && out.includes('data from-the-project')
    && out.includes('argv one two') && out.includes('exit code 0'), `${label}: Run executes the script in the target with its parameters (${out.replace(/\s+/g, ' ').slice(0, 300)})`);
  if (fake && k.kind === 'ssh') {
    const host = k.fill.remoteHost.split('@').pop();
    const user = host === 'pwbox' ? 'pw' : 'dev';
    const projects = path.join(fake.root, 'fs', `ssh-${host}`, 'home', user, 'pyide-projects');
    const copy = existsSync(projects) ? execFileSync('cmd', ['/c', 'dir', '/b', projects], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : '';
    check(copy && existsSync(path.join(projects, copy, 'data.txt')) && existsSync(path.join(projects, copy, 'helper.py')), `${label}: the project was uploaded to the host (${copy})`);
  }

  // ---- traceback paths ----
  const boom = await runConfig(`boom ${label}`, { type: 'python', script: local('boom.py') });
  const link = await js(`[...document.querySelectorAll('#runOut a')].map(a => a.textContent).find(s => s.includes('boom.py')) || ''`);
  check(boom.includes('ValueError: boom from the target') && matches(link, dir) && link.includes('boom.py'), `${label}: the traceback names the file as the target sees it (${link})`);
  await openFile(t, 'helper.py');
  await clickWhere('#runOut a', `a => a.textContent.includes('boom.py')`);
  await until(`ide.activeTab()?.path.toLowerCase() === ${JSON.stringify(local('boom.py').toLowerCase())}`, 'traceback link opens boom.py', 10000).catch(() => {});
  check(await js(`ide.activeTab()?.path.toLowerCase() === ${JSON.stringify(local('boom.py').toLowerCase())}`), `${label}: clicking that traceback line opens the local file`);

  // ---- Debug with a breakpoint ----
  await openFile(t, 'main.py');
  if (!(await js(`window.__debugger.breakpoints().some(b => b.path.toLowerCase().endsWith('main.py') && b.line === 10)`))) {
    await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 10, column: 5 }))`);
    await press('Ctrl+F8');
  }
  await js(`ide.debugger.debugFile(${JSON.stringify(local('main.py'))})`);
  let hit = false;
  try {
    await until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.toLowerCase() === ${JSON.stringify(local('main.py').toLowerCase())} && f.line === 10; })()`, `${label} breakpoint`, 120000);
    hit = true;
    // 'suspended' comes before the frame's variables are fetched over the tunnel.
    await until(`/value/.test(document.querySelector('#dbgVars')?.textContent || '')`, `${label} variables`, 15000).catch(() => {});
  } catch {}
  const vars = await text('#dbgVars');
  check(hit && /value\s*=?\s*(\{int\}\s*)?42/.test(vars), `${label}: the debugger stops at the breakpoint in the target with local paths and variables (${hit ? vars.slice(0, 120) : (await text('#dbgOut')).slice(-400)})`);
  if (hit) {
    await press('F9');
    await until(`document.querySelector('#dbgOut')?.textContent.includes('exit code')`, 'debugged program finished', 60000).catch(() => {});
  }
  const dbgOut = await text('#dbgOut');
  check(dbgOut.includes('answer 42') && dbgOut.includes('exit code 0'), `${label}: resuming runs the program to the end (${dbgOut.slice(-160).replace(/\s+/g, ' ')})`);
  await js(`ide.debugger.stop?.()`).catch(() => {});

  // ---- pytest ----
  await js(`(ide.run.runConfig(${JSON.stringify({ id: `ri-tests-${label}`, type: 'pytest', name: `tests ${label}`, target: 'test_calc.py', args: '', cwd: '', env: '' })}), true)`);
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === ${JSON.stringify(`tests ${label}`)} && (() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, `${label} tests`, 180000);
  const st = await text('.run-session:not(.hidden) .tr-status');
  const usedPytest = !!(await js(`ide.api.invoke('tests:hasPytest', ide.currentInterp())`));
  check(st.includes('Tests failed: 1, passed: 1 of 2 tests'), `${label}: ${usedPytest ? 'pytest' : 'unittest (no pytest in the target)'} runs in the target and reports results (${st})`);
  if (fake) check(usedPytest, `${label}: the target's pytest is used`);
  await clickWhere('.run-session:not(.hidden) .tr-row', `r => r.dataset.id?.endsWith('test_wrong')`);
  await until(`ide.activeTab()?.path.toLowerCase() === ${JSON.stringify(local('test_calc.py').toLowerCase())}`, 'test navigation', 10000).catch(() => {});
  check(await js(`ide.activeTab()?.path.toLowerCase() === ${JSON.stringify(local('test_calc.py').toLowerCase())} && ide.editor.getPosition().lineNumber === 10`),
    `${label}: a test reported with a target path opens the local file at its line`);

  // ---- packages ----
  const pk = await js(`ide.api.invoke('packages:list', ide.currentInterp())`);
  if (k.real && !pk.ok && /No module named pip/.test(pk.error)) console.log(`SKIP ${label}: pip list (pip is not installed in the target: ${pk.error})`);
  else {
    check(pk.ok && pk.packages.length > 0 && (!fake || pk.packages.some((p) => p.name === 'pytest')), `${label}: pip list runs in the target (${pk.ok ? pk.packages.map((p) => p.name).join(', ') : pk.error})`);
    await js(`ide.toolWindows.get('PythonPackages').show()`);
    await until(`document.querySelector('#pkgList')?.textContent.includes(${JSON.stringify(pk.ok ? pk.packages[0].name : '')})`, 'packages tool window', 60000).catch(() => {});
    check(pk.ok && (await text('#pkgList')).includes(pk.packages[0].name), `${label}: the Python Packages tool window lists the target's packages`);
  }

  // ---- Python Console ----
  // Not awaited inside the page: restart() and execute() resolve only when the console prompt comes back.
  await js(`(ide.toolWindows.get('PythonConsole').show(), window.__riConsole = ide.pyconsole.restart(), true)`);
  await until(`ide.pyconsole.isRunning() && document.querySelector('#pyconsoleOut').textContent.includes('Python 3')`, 'console running', 120000).catch(() => {});
  await sleep(500);
  await js(`(window.__riConsole = ide.pyconsole.execute("import os, platform; print('console', platform.system(), os.environ.get('FAKE_TARGET', ''))"), true)`).catch(() => {});
  const want = typeof k.system === 'string' ? `console ${k.system}` : new RegExp(`console ${k.system.source}`);
  await until(`(() => { const s = document.querySelector('#pyconsoleOut').textContent; return ${want instanceof RegExp ? `${want}.test(s)` : `s.includes(${JSON.stringify(want)})`}; })()`, 'console output', 60000).catch(() => {});
  check(matches(await text('#pyconsoleOut'), want), `${label}: the Python Console runs in the target (${(await text('#pyconsoleOut')).slice(-200).replace(/\s+/g, ' ')})`);

  // ---- terminal ----
  const before = await js(`ide.terminal.sessions().length`);
  await js(`ide.terminal.open()`);
  await until(`ide.terminal.sessions().length === ${before + 1} && ide.terminal.active()?.name === ${JSON.stringify(k.name)}`, 'terminal session', 60000).catch(() => {});
  await sleep(1500);
  await type('pwd');
  await press('Enter');
  const dirRe = dir instanceof RegExp ? dir : new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await until(`${dirRe}.test(ide.terminal.text())`, 'pwd in the target', 60000).catch(() => {});
  await type('python3 -c "print(6*7)"');
  await press('Enter');
  await until(`/\\n42\\r?(\\n|$)/.test(ide.terminal.text())`, 'python3 in the terminal', 60000).catch(() => {});
  const term = await js(`ide.terminal.text()`);
  check((await js(`ide.terminal.active()?.name`)) === k.name && dirRe.test(term) && /\n42\r?(\n|$)/.test(term),
    `${label}: a new terminal is a shell in the target, in the project folder (${term.slice(-200).replace(/\s+/g, ' ')})`);
  await type('exit');
  await press('Enter');

  // ---- Pyright ----
  await until(`window.__remoteInterp.lastSync()?.id === ide.currentInterp().target.id && !window.__remoteInterp.syncing()`, 'libraries synced', 300000).catch(() => {});
  const sync = await js(`window.__remoteInterp.lastSync()`);
  check(sync?.ok && sync.local.length > 0, `${label}: the target's library folders are copied for Pyright (${sync?.ok ? `${sync.files} files from ${sync.paths.join(', ')}` : sync?.error})`);
  // A real target proves the same with a package it has and this machine does not (Ubuntu's python-apt).
  const only = fake ? 'remote_only_pkg' : pk.ok && pk.packages.some((p) => p.name === 'python-apt') ? 'apt' : null;
  if (!fake) writeFileSync(local('uses_libs.py'), `${only ? `import ${only}\n` : ''}import surely_not_installed_anywhere\n`);
  await openFile(t, 'uses_libs.py');
  const probs = `ide.problems.all().filter(p => p.source === 'pyright' && p.path.toLowerCase().endsWith('uses_libs.py')).map(p => p.msg).join('|')`;
  const resolved = only ? `!(${probs}).includes('"${only}"')` : 'true';
  await until(`(${probs}).includes('surely_not_installed_anywhere') && ${resolved}`, 'pyright diagnostics', 120000).catch(() => {});
  const msgs = await js(probs);
  check(msgs.includes('surely_not_installed_anywhere') && (!only || !msgs.includes(`"${only}"`)),
    `${label}: Pyright resolves imports from the target's packages${only ? ` (${only})` : ''} and reports missing ones (${msgs})`);

  await shot(`${label}.png`);
}

async function stopKillsRemote(k) {
  await runConfig(`slow ${k.kind}`, { type: 'python', script: local('slow.py') }, 'slow started');
  await sleep(500);
  await js(`document.querySelector('.stop-btn').click()`);
  await until(`document.querySelector('#runOut').textContent.includes('Process finished')`, 'slow stopped', 30000).catch(() => {});
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    gone = fake ? procCount(local('slow.py')) === 0 && procCount('slow.py') === 0
      : spawnSync('wsl.exe', ['-d', k.fill.remoteDistro, '--exec', 'sh', '-c', 'pgrep -f "[s]low.py" || true' /* the brackets keep pgrep from matching this sh */], { encoding: 'utf8' }).stdout.trim() === '';
    if (!gone) await sleep(500);
  }
  check(gone && (!fake || /kill -TERM \d+/.test(fake.calls())), `${k.kind}: Stop ends the program in the target, not only the local client`);
}

// REMOTE_KINDS=wsl,docker limits a fake run to some kinds while working on one of them.
if (process.env.REMOTE_KINDS) kinds = kinds.filter((k) => process.env.REMOTE_KINDS.split(',').includes(k.id || k.kind));

try {
  for (const k of kinds) {
    await addInterpreter(k);
    await exercise(k);
    if (k.kind === 'wsl' || k.kind === 'docker') await stopKillsRemote(k);
  }

  if (fake) {
    // ---- secrets stay out of settings ----
    const settingsFile = readFileSync(path.join(t.userData, 'settings.json'), 'utf8');
    const secretsFile = path.join(t.userData, 'remote-interp', 'secrets.json');
    const saved = await js(`ide.settings.get('interpreters.remote')`);
    const pw = saved.find((x) => x.host === 'pwbox');
    if (pw) {
      check(!settingsFile.includes('s3cret') && !JSON.stringify(saved).includes('s3cret') && existsSync(secretsFile)
        && !readFileSync(secretsFile, 'utf8').includes('s3cret') && JSON.parse(readFileSync(secretsFile, 'utf8'))[pw.id]?.password?.enc === 'safeStorage',
      'the SSH password is stored only with safeStorage, never in the settings file');
      // The stand-in ssh only lets pwbox in when SSH_ASKPASS answers with the password, as OpenSSH does.
      check(fake.calls().split('\n').some((l) => l.includes('pwbox') && l.includes('NumberOfPasswordPrompts=1')), 'ssh gets the password from the IDE\'s askpass, not from a prompt');
    }

    // ---- availability with reasons ----
    await js(`ide.openSettings('remote-interpreters')`);
    await until(`document.querySelectorAll('#remoteKinds .remote-kind').length === 4`, 'targets on this computer', 60000);
    check(await js(`[...document.querySelectorAll('#remoteKinds .remote-kind')].every(r => r.classList.contains('ok'))`), 'Remote Interpreters lists WSL, SSH, Docker and Docker Compose as available');
    check(await js(`document.querySelectorAll('#remoteList .remote-row').length === ${kinds.length}`), 'and every added interpreter');
    writeFileSync(path.join(fake.root, 'wsl.json'), JSON.stringify({ distros: [] }));
    writeFileSync(path.join(fake.root, 'docker.json'), JSON.stringify({ images: [], services: [], daemon: false }));
    await clickWhere('.settings-body button', `b => b.textContent === 'Detect Again'`);
    await until(`document.querySelector('#remoteKinds .remote-kind[data-kind="wsl"]')?.classList.contains('unavailable')`, 'WSL unavailable', 30000);
    const row = (kind) => js(`document.querySelector('#remoteKinds .remote-kind[data-kind="${kind}"]').textContent`);
    check((await row('wsl')).includes('No WSL distributions are installed.'), `a kind that cannot work says why: ${await row('wsl')}`);
    check((await row('docker')).includes('The Docker daemon is not running.') && (await row('compose')).includes('Unavailable'), `Docker without its daemon: ${await row('docker')}`);
    renameSync(path.join(fake.bin, 'docker.exe'), path.join(fake.bin, 'docker.exe.off'));
    await clickWhere('.settings-body button', `b => b.textContent === 'Detect Again'`);
    await until(`document.querySelector('#remoteKinds .remote-kind[data-kind="docker"]')?.textContent.includes('not installed')`, 'docker missing', 30000).catch(() => {});
    check((await row('docker')).includes('Docker is not installed (docker was not found on PATH).'), `Docker missing: ${await row('docker')}`);
    await click('#settingsCancel');
    await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
    await openAddForm({ menu: 'On WSL…' });
    check((await text('#remoteAvailability')).startsWith('WSL is not available: No WSL distributions are installed.') && await js(`document.querySelector('#remoteAdd').disabled`),
      'the On WSL… form shows the reason instead of failing');
    await click('#settingsCancel');
    await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
    renameSync(path.join(fake.bin, 'docker.exe.off'), path.join(fake.bin, 'docker.exe'));

    // ---- removing an interpreter forgets its password ----
    if (pw) {
      await js(`ide.openSettings('remote-interpreters')`);
      await until(`document.querySelectorAll('#remoteList .remote-row').length === ${kinds.length}`, 'interpreter list');
      await js(`[...document.querySelectorAll('#remoteList .remote-row')].find(r => r.textContent.includes('pwbox')).querySelector('button:last-child').click()`);
      await until(`document.querySelectorAll('.dialog-backdrop').length === 2`, 'confirm remove', 10000);
      await js(`[...document.querySelectorAll('.dialog-backdrop')].pop().querySelector('.dialog-buttons .primary').click()`);
      await until(`document.querySelectorAll('#remoteList .remote-row').length === ${kinds.length - 1}`, 'removed', 15000).catch(() => {});
      check(!(await js(`ide.interps.some(i => i.target?.host === 'pwbox')`)) && !(pw.id in JSON.parse(readFileSync(secretsFile, 'utf8'))), 'Remove drops the interpreter and its saved password');
      await click('#settingsCancel');
    }
  }
} catch (err) {
  console.log(`ERROR ${err.stack || err}`);
  check(false, `remote interpreter flow: ${err.message}`);
  await shot('error.png').catch(() => {});
}

if (!fake) t.finish();

// ---------- Korean ----------
t.close();
const ko = await launch({ fixture: 'remote-interp', port: 9731, name: 'remote-interp-ko', lang: 'ko-KR' });
try {
  const src = readFileSync(path.join(APP, 'renderer', 'features', 'remote-interp', 'index.js'), 'utf8');
  const mine = new Set([...src.matchAll(/\btr\(\s*'((?:\\.|[^'])*)'/g)].map((m) => m[1].replace(/\\'/g, "'")));
  await ko.js(`ide.openSettings('interpreter')`);
  await ko.until(`!!document.querySelector('#addInterpBtn')`, 'interpreter page');
  await ko.click('#addInterpBtn');
  await ko.until(`!!document.querySelector('#addInterpMenu')`, 'menu');
  const items = await ko.js(`[...document.querySelectorAll('#addInterpMenu .menu-item')].map(n => n.textContent)`);
  ko.check(['WSL에서…', 'SSH에서…', 'Docker에서…', 'Docker Compose에서…'].every((s) => items.includes(s)), `Add Interpreter lists the remote kinds in Korean (${items.join(', ')})`);
  await ko.js(`[...document.querySelectorAll('#addInterpMenu .menu-item')].find(n => n.textContent === 'SSH에서…').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await ko.until(`!!document.querySelector('#remoteHost')`, 'SSH form', 60000);
  await ko.js(`(() => { const a = document.querySelector('#remoteAuth'); a.value = 'password'; a.dispatchEvent(new Event('change')); })()`);
  const leaks = await englishLeaks(ko, '#remoteInterpForm', ['WSL', 'SSH', 'Docker', 'Compose']);
  ko.check(!leaks.length, `the SSH form is Korean (${JSON.stringify(leaks)})`);
  await ko.js(`(() => { const h = document.querySelector('#remoteHost'); h.value = 'nosuchhost'; })()`);
  await ko.click('#remoteAdd');
  await ko.until(`document.querySelector('#remoteLog').textContent.includes('인터프리터를 추가할 수 없습니다')`, 'Korean error', 60000).catch(() => {});
  ko.check((await ko.js(`document.querySelector('#remoteLog').textContent`)).includes('인터프리터를 추가할 수 없습니다'), `errors are Korean (${await ko.js(`document.querySelector('#remoteLog').textContent`)})`);
  await ko.click('#settingsCancel');
  await ko.until(`!document.querySelector('.settings-dialog')`, 'closed');
  await ko.js(`ide.openSettings('remote-interpreters')`);
  await ko.until(`document.querySelectorAll('#remoteKinds .remote-kind').length === 4`, 'remote page', 60000);
  const pageLeaks = await englishLeaks(ko, '.settings-body', ['WSL', 'SSH', 'Docker', 'Compose', 'FakeUbuntu', 'Other']);
  ko.check(!pageLeaks.length, `Settings › Remote Interpreters is Korean (${JSON.stringify(pageLeaks)})`);
  const missing = (await missingTranslations(ko)).filter((s) => mine.has(s));
  ko.check(!missing.length, `every remote-interp string has a Korean entry (${missing.join(' | ')})`);
  await ko.click('#settingsCancel');
} catch (err) {
  console.log(`ERROR ${err.stack || err}`);
  ko.check(false, `Korean: ${err.message}`);
}
ko.results.unshift(...t.results);
ko.consoleErrors.unshift(...t.consoleErrors);
ko.finish();
