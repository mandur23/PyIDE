// My Workspace plugin: Launchers tool window (discovery of every kind, runs with output, args memory), port-in-use
// detection with "Stop That Process" / "Run Anyway", local URL detection + Open in Browser, Stop, and the Workspace
// home tab (project, branch, venvs, README, launchers, recent projects).
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

// Opening a browser is stubbed in the main process; the URLs it was asked to open are listed by workspace:openedUrls.
process.env.PYIDE_FAKE_OPEN_EXTERNAL = '1';
const SERVER_PORT = 8799;
const TOML_PORT = 8781;

const t = await launch({ fixture: 'workspace', port: 9461 });
const { js, until, press, type, click, shot, check, sleep } = t;
const q = JSON.stringify;
const blockers = [];

// Holds a port from a separate node process (so "Stop That Process" can terminate it without killing this test).
async function blockPort(port) {
  const p = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`]);
  blockers.push(p);
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => d.toString().includes('ready') && resolve());
    p.on('exit', () => reject(new Error(`blocker for ${port} exited`)));
  });
  return p;
}
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

const entryId = (name) => js(`ide.workspace.entries().find(e => e.name === ${q(name)})?.id`);
const rowExpr = (name) => `[...document.querySelectorAll('#wsList .ws-row')].find(r => r.querySelector('.ws-name').textContent === ${q(name)})`;
async function clickNode(expr, label) {
  const ok = await js(`(() => { document.querySelectorAll('.pick-me').forEach(n => n.classList.remove('pick-me')); const n = ${expr}; if (!n) return false; n.classList.add('pick-me'); n.scrollIntoView({ block: 'nearest' }); return true; })()`);
  if (!ok) throw new Error(`not found: ${label}`);
  await click('.pick-me');
}
const clickButton = (text) => clickNode(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${q(text)})`, `dialog button ${text}`);
const consoleOf = async (name) => js(`[...document.querySelectorAll('.ws-console')].find(h => h.dataset.id === ${q(await entryId(name))})?.querySelector('.console')?.textContent || ''`);
const waitOutput = async (name, text, ms = 20000) => until(`(${q(await entryId(name))} && [...document.querySelectorAll('.ws-console')].find(h => h.dataset.id === ${q(await entryId(name))})?.querySelector('.console')?.textContent.includes(${q(text)}))`, `${name} output "${text}"`, ms);
const running = async (name) => js(`ide.workspace.runs().some(r => r.entry.name === ${q(name)} && (r.running || r.starting))`);

try {
  // ---------- home tab on project open ----------
  await until(`ide.activeTab()?.path === 'workspace:home' && !!document.querySelector('#wsHome .ws-project-name')`, 'Workspace home tab opened with the project');
  check(true, 'Workspace home opens when the project opens');
  check(await js(`document.querySelector('#wsHome .ws-project-name').textContent`) === path.basename(t.project), 'home shows the project name');
  check(await js(`document.querySelector('.tab.active .name').textContent === 'Workspace'`), 'home tab title is "Workspace"');
  await until(`document.querySelectorAll('#wsHome .ws-pill').length >= 7`, 'launcher summary on the home tab');
  check(await js(`document.querySelector('#wsHome .ws-branch').classList.contains('none') && document.querySelector('#wsHome .ws-branch').textContent.includes('No Git repository')`), 'non-repository is tolerated ("No Git repository")');
  check(await js(`[...document.querySelectorAll('#wsHome .ws-venv')].some(v => v.textContent.includes('ai\\\\.venv') && v.textContent.includes('Python 3.10.11'))`), 'venv ai\\.venv detected with its Python version from pyvenv.cfg');
  check(await js(`document.querySelector('#wsHome .ws-readme-title')?.textContent === '워크스페이스 데모' && document.querySelector('#wsHome .ws-readme-summary').textContent.startsWith('A tiny project')`), 'README headline and summary shown');
  check(await js(`document.querySelectorAll('#wsHome .ws-quick-row .ws-run').length >= 7`), 'home has quick Run buttons for launchers');
  const recent0 = await js(`ide.settings.get('workspace.recent', [])`);
  check(recent0.length === 1 && recent0[0].path.toLowerCase() === t.project.toLowerCase() && !!recent0[0].opened, 'project recorded in workspace.recent with its open date');
  check(await js(`document.querySelector('#wsHome .ws-recent.current .ws-when').textContent === 'Today'`), 'recent project shows "Today"');

  execFileSync('git', ['init', '-q', '-b', 'feature/demo'], { cwd: t.project });
  await click('#wsHome .ws-refresh');
  await until(`document.querySelector('#wsHome .ws-branch-name')?.textContent === 'feature/demo'`, 'git branch after refresh');
  check(true, 'git branch shown after git init (rev-parse in main)');
  await shot('home.png');

  // ---------- Launchers tool window: discovery ----------
  await press('Alt+Shift+L');
  await until(`ide.toolWindows.get('Launchers').isVisible()`, 'Launchers tool window via Alt+Shift+L');
  check(await js(`document.querySelector('#sideTitle').textContent === 'Launchers'`), 'tool window title "Launchers"');
  const groups = await js(`[...document.querySelectorAll('#wsList .ws-group')].map(g => g.dataset.kind)`);
  check(['launch', 'pycharm', 'module', 'script', 'bat', 'ps1', 'maven'].every((k) => groups.includes(k)), `every launcher kind grouped (${groups})`);
  const rows = await js(`[...document.querySelectorAll('#wsList .ws-row')].map(r => r.dataset.kind + ' ' + r.querySelector('.ws-name').textContent + ' | ' + r.querySelector('.ws-sub').textContent + ' | ' + (r.querySelector('.ws-port')?.textContent || ''))`);
  console.log(rows.join('\n'));
  const has = (s) => rows.some((r) => r.startsWith(s));
  check(has('launch Static Server') && rows.find((r) => r.startsWith('launch')).endsWith(':8799'), 'launch.json configuration with its port');
  check(has('pycharm Tool twice') && rows.find((r) => r.startsWith('pycharm')).includes('--count 2'), 'PyCharm run configuration parsed (script + parameters)');
  check(has('module python -m app') && has('module python -m server'), 'python -m packages (dirs with __main__.py)');
  check(rows.some((r) => r.startsWith('script tool.py') && r.includes('--count --verbose <target>')), 'script with __main__ guard shows argparse flags');
  check(has('script train.py'), 'script in a non-package subfolder (ai\\train.py)');
  check(has('bat run.bat') && has('ps1 start-train.ps1'), 'run.bat and start-train.ps1 discovered');
  check(rows.some((r) => r.startsWith('maven mvn jetty:run') && r.endsWith(':8090')), 'pom.xml -> mvn jetty:run with its port');
  check(!rows.some((r) => /run_me|site_tool|start-data|helper/.test(r)), 'venv, data dirs and plain modules are skipped');

  // ---------- run a python -m launcher with remembered arguments ----------
  await clickNode(rowExpr('python -m app'), 'app row');
  await until(`document.querySelector('#wsDetail .ws-detail-name')?.textContent === 'python -m app'`, 'detail of app');
  check(await js(`[...document.querySelectorAll('#wsDetail .ws-chip')].map(c => c.textContent).join(' ') === '--name --verbose'`), 'argparse option chips in the detail pane');
  await click('#wsArgs');
  await type('--name Claude');
  await click('#wsDetail .ws-detail-run');
  await waitOutput('python -m app', 'Process finished with exit code 0');
  const appOut = await consoleOf('python -m app');
  check(appOut.includes('Hello from app, Claude'), 'python -m app ran with the Arguments field');
  check(/-u -m app --name Claude/.test(appOut), 'command line echoed in the launcher console');
  const savedArgs = await js(`ide.settings.get('workspace.args:' + ide.root, {})[${q(await entryId('python -m app'))}]`);
  check(savedArgs === '--name Claude', 'arguments remembered per project in ide.settings');

  // PyCharm configuration: its PARAMETERS are the default arguments and its envs are applied.
  await clickNode(`${rowExpr('Tool twice')}?.querySelector('.ws-run')`, 'Tool twice run button');
  await waitOutput('Tool twice', 'Process finished with exit code 0');
  check((await consoleOf('Tool twice')).includes('tool ran 2/2 mode=pycharm'), 'PyCharm config runs tool.py with its parameters and env');

  await clickNode(`${rowExpr('run.bat')}?.querySelector('.ws-run')`, 'run.bat run button');
  await waitOutput('run.bat', 'Process finished with exit code 0');
  check((await consoleOf('run.bat')).includes('run.bat says hi'), 'run.bat runs through cmd /c');

  await clickNode(`${rowExpr('start-train.ps1')}?.querySelector('.ws-run')`, 'ps1 run button');
  await waitOutput('start-train.ps1', 'Process finished with exit code 0', 30000);
  check((await consoleOf('start-train.ps1')).includes('학습 시작 epochs=1'), 'start-train.ps1 runs with PowerShell (Korean output intact)');
  await shot('launchers.png');

  // ---------- port in use: Cancel, then Stop That Process ----------
  check(!(await portOpen(SERVER_PORT)), `port ${SERVER_PORT} is free before the test`);
  const blocker = await blockPort(SERVER_PORT);
  await clickNode(`${rowExpr('Static Server')}?.querySelector('.ws-run')`, 'Static Server run');
  await until(`!!document.querySelector('.ws-port-dialog')`, 'port-in-use dialog', 20000);
  const dlg = await js(`({ title: document.querySelector('.dialog-title').textContent, body: document.querySelector('.ws-port-dialog').textContent, pid: document.querySelector('.ws-port-dialog').dataset.pid, buttons: [...document.querySelectorAll('.dialog-buttons button')].map(b => b.textContent) })`);
  console.log(JSON.stringify(dlg));
  check(dlg.title === `Port ${SERVER_PORT} Is in Use`, 'dialog title names the port');
  check(Number(dlg.pid) === blocker.pid && /node\.exe/i.test(dlg.body) && dlg.body.includes(`PID ${blocker.pid}`), 'dialog names the process holding the port (netstat + tasklist)');
  check(dlg.buttons.join('|') === 'Stop That Process|Run Anyway|Cancel', 'dialog offers Stop That Process / Run Anyway / Cancel');
  await shot('port-dialog.png');
  await clickButton('Cancel');
  await sleep(300);
  check(!(await running('Static Server')) && blocker.exitCode === null, 'Cancel starts nothing and leaves the other process alone');

  await clickNode(`${rowExpr('Static Server')}?.querySelector('.ws-run')`, 'Static Server run again');
  await until(`!!document.querySelector('.ws-port-dialog')`, 'port dialog again', 20000);
  await clickButton('Stop That Process');
  await until(`!!document.querySelector('.ws-confirm')`, 'confirmation before terminating');
  check((await js(`document.querySelector('.ws-confirm').textContent`)).includes(`PID ${blocker.pid}`), 'terminate confirmation names the PID');
  await clickButton('Terminate');
  await waitOutput('Static Server', `Serving HTTP on 127.0.0.1 port ${SERVER_PORT}`, 30000);
  check(blocker.exitCode !== null || blocker.killed || !(await new Promise((r) => { try { process.kill(blocker.pid, 0); r(true); } catch { r(false); } })), 'the process holding the port was terminated');
  check((await consoleOf('Static Server')).includes(`Stopped node.exe (PID ${blocker.pid})`), 'console reports the stopped process');

  // ---------- URL detection + Open in Browser ----------
  const url = `http://127.0.0.1:${SERVER_PORT}/`;
  await until(`!!document.querySelector('#wsList .ws-open[data-url=${q(url)}]') && !!document.querySelector('#wsDetail .ws-link[data-url=${q(url)}]')`, 'Open in Browser link');
  check(true, 'printed URL detected; Open in Browser shown on the entry and in its console header');
  check(await js(`[...document.querySelectorAll('#wsHome .ws-quick-row .ws-open')].some(a => a.dataset.url === ${q(url)})`), 'home quick list shows the link too');
  check((await fetch(url)).ok, 'the launched server answers');
  await click('#wsDetail .ws-link');
  await until(`ide.api.invoke('workspace:openedUrls').then(u => u.includes(${q(url)}))`, 'openExternal requested');
  check(true, 'Open in Browser asks the main process to open the URL (shell.openExternal stubbed)');
  const rejected = await js(`ide.api.invoke('workspace:openUrl', 'https://example.com/').then(() => 'opened', (e) => 'rejected')`);
  check(rejected === 'rejected', 'non-local URLs are refused by the main process');
  await shot('server-running.png');

  // ---------- Run Anyway, with a port read from the --config .toml ----------
  const tomlBlocker = await blockPort(TOML_PORT);
  await clickNode(rowExpr('python -m server'), 'server row');
  await click('#wsArgs');
  await type('--config serve.toml');
  await click('#wsDetail .ws-detail-run');
  await until(`!!document.querySelector('.ws-port-dialog')`, 'port dialog for the toml port', 20000);
  check(await js(`document.querySelector('.dialog-title').textContent === 'Port ${TOML_PORT} Is in Use'`), 'port found in the --config .toml file');
  await clickButton('Run Anyway');
  await waitOutput('python -m server', 'Process finished with exit code 0');
  const srvOut = await consoleOf('python -m server');
  check(srvOut.includes(`Port ${TOML_PORT} is in use; running anyway.`) && srvOut.includes('server would read serve.toml'), 'Run Anyway starts the launcher');
  check(tomlBlocker.exitCode === null, 'Run Anyway leaves the other process running');

  // ---------- Stop ----------
  await clickNode(rowExpr('Static Server'), 'Static Server row');
  await until(`!document.querySelector('#wsDetail .ws-detail-stop').disabled`, 'stop enabled');
  await click('#wsDetail .ws-detail-stop');
  await waitOutput('Static Server', 'Process finished with exit code');
  await until(`!document.querySelector('#wsList .ws-open') && !${rowExpr('Static Server')}.classList.contains('running')`, 'link removed after stop');
  check(!(await portOpen(SERVER_PORT)), 'Stop ends the server (port released)');

  // ---------- home reopens when nothing is open; toolbar item ----------
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'tool.py'))`);
  await until(`ide.activeTab()?.title === 'tool.py'`, 'tool.py open');
  await js(`ide.closeTab('workspace:home')`);
  await sleep(200);
  check(await js(`!ide.findTab('workspace:home')`), 'closing the home tab while a file is open keeps it closed');
  await js(`ide.closeTab(ide.activeTab().path)`);
  await until(`ide.activeTab()?.path === 'workspace:home'`, 'home back when no file is open');
  check(true, 'home reopens when the last file is closed');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'tool.py'))`);
  await until(`ide.activeTab()?.title === 'tool.py'`, 'tool.py open again');
  await click('#toolbarLeft .ws-home-btn');
  await until(`ide.activeTab()?.path === 'workspace:home'`, 'toolbar Workspace Home');
  check(await js(`document.querySelector('#toolbarLeft .ws-home-btn').title === 'Workspace Home'`), 'toolbar item "Workspace Home" reopens the home tab');

  // ---------- recent projects ----------
  const second = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-workspace-second-')), 'Cover_Music');
  mkdirSync(second);
  writeFileSync(path.join(second, 'run.bat'), '@echo off\r\necho cover\r\n');
  await js(`ide.openProject(${q(second)})`);
  await until(`ide.root === ${q(second)} && document.querySelector('#wsHome .ws-project-name')?.textContent === 'Cover_Music'`, 'second project home');
  await until(`[...document.querySelectorAll('#wsList .ws-row .ws-name')].map(n => n.textContent).join() === 'run.bat'`, 'second project launchers');
  check(true, 'opening another project rescans its launchers');
  const recent = await js(`[...document.querySelectorAll('#wsHome .ws-recent')].map(r => r.dataset.path)`);
  check(recent.length === 2 && recent[0] === second && recent[1].toLowerCase() === t.project.toLowerCase(), 'recent projects list, most recent first');
  check(await js(`document.querySelector('#wsHome .ws-recent').classList.contains('current')`), 'current project highlighted');
  await shot('home-second.png');
  await clickNode(`[...document.querySelectorAll('#wsHome .ws-recent')].find(r => r.dataset.path.toLowerCase() === ${q(t.project.toLowerCase())})`, 'recent first project');
  await until(`ide.root?.toLowerCase() === ${q(t.project.toLowerCase())}`, 'first project reopened from recent list');
  await until(`document.querySelector('#wsHome .ws-project-name')?.textContent === ${q(path.basename(t.project))}`, 'home of the first project');
  check(true, 'clicking a recent project opens it (ide.openProject)');
  check((await js(`ide.settings.get('workspace.recent')`))[0].path.toLowerCase() === t.project.toLowerCase(), 'reopened project moves to the top of workspace.recent');
  await until(`(${rowExpr('python -m app')})?.classList.contains('ws-row')`, 'launchers of the first project again');
  check(await consoleOf('python -m app').then((s) => s.includes('Hello from app, Claude')), 'launcher consoles survive switching projects');
  await shot('final.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
} finally {
  for (const b of blockers) { try { b.kill(); } catch {} }
}
t.finish();
