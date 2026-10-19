// The Windows installer end to end: installs dist/PyIDE-Setup-*.exe (or the installer given as the first argument)
// per-user into a temp folder, opens a .py with the installed PyIDE.exe the way "Open with PyIDE" does, and checks the
// features that depend on unpacked files (Pyright, the ConPTY terminal, ruff, Git), then uninstalls and checks that the
// shortcut, the "Open with" registration and the uninstall entry are gone.
// Build first with `npm run dist`.
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(APP_DIR, 'dist');
const installer = process.argv[2] || path.join(DIST, readdirSync(DIST).find((f) => /^PyIDE-Setup-.*\.exe$/.test(f)) || '');
if (!existsSync(installer)) throw new Error('no installer: run npm run dist first');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = (...args) => {
  try { return execFileSync('reg', ['query', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const CLASSES = 'HKCU\\Software\\Classes';
const UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const SHORTCUT = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'PyIDE.lnk');
const uninstallEntry = () => (reg(UNINSTALL, '/s', '/f', 'PyIDE', '/d') || '').includes('DisplayName');
const pyKeyBefore = reg(`${CLASSES}\\.py`, '/s');
const pyDefaultBefore = reg(`${CLASSES}\\.py`, '/ve');

const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

const installDir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-installed-')), 'PyIDE');
const exe = path.join(installDir, 'PyIDE.exe');
const r = spawnSync(installer, ['/S', `/D=${installDir}`], { stdio: 'ignore' });
check(r.status === 0 && existsSync(exe), `silent per-user install into ${installDir}`);
const unpacked = path.join(installDir, 'resources', 'app.asar.unpacked');
check(existsSync(path.join(installDir, 'resources', 'app.asar')) && existsSync(path.join(unpacked, 'vendor', 'bin', 'ruff.exe'))
  && existsSync(path.join(unpacked, 'node_modules', 'pyright', 'langserver.index.js'))
  && existsSync(path.join(unpacked, 'main', 'semantic', 'embed_server.py')), 'app.asar plus unpacked ruff.exe, pyright and sidecar scripts');
check(existsSync(SHORTCUT), 'Start menu shortcut');
check(uninstallEntry(), 'Apps & features entry');
check((reg(`${CLASSES}\\.py\\OpenWithProgids`, '/v', 'PyIDE.py') || '').includes('PyIDE.py')
  && (reg(`${CLASSES}\\PyIDE.py\\shell\\open\\command`, '/ve') || '').toLowerCase().includes(exe.toLowerCase()), '.py lists "Open with PyIDE"');
check(pyKeyBefore === null || reg(`${CLASSES}\\.py`, '/ve') === pyDefaultBefore, '.py default program untouched');

let t;
try {
  // ---------- "Open with PyIDE" on a .py: its folder becomes the project and the file opens ----------
  t = await launch({ fixture: 'lsp', port: 9790, name: 'installed', exe, open: 'errors.py' });
  const { js, until, press } = t;
  await until(`ide.activeTab()?.title === 'errors.py'`, 'errors.py tab');
  check(await js(`ide.root.toLowerCase()`) === t.project.toLowerCase(), 'a .py argument opens its folder as the project and the file');

  // ---------- Pyright from app.asar.unpacked ----------
  await until(`document.querySelector('#lspStatus')?.textContent === 'Pyright: ready'`, 'Pyright ready', 60000);
  await until(`ide.problems.all().some(p => p.source === 'pyright' && p.path.endsWith('errors.py') && p.severity === 'error')`, 'pyright diagnostics', 60000);
  check(true, 'Pyright diagnostics appear for errors.py');

  // ---------- ConPTY terminal (node-pty) ----------
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length === 1`, 'terminal session');
  await until(`/PS .*project>/.test(ide.terminal.text())`, 'PowerShell prompt', 30000);
  check(true, 'the terminal opens a PowerShell session in the project');

  // ---------- ruff from vendor/bin ----------
  copyFileSync(path.join(APP_DIR, 'verify', 'fixtures', 'tooling', 'messy.py'), path.join(t.project, 'messy.py'));
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'messy.py'))`);
  await until(`ide.activeTab()?.title === 'messy.py'`, 'messy.py tab');
  await js(`(ide.editor.focus(), true)`);
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getValue().includes('def f(a, b):\\n    return a + b')`, 'ruff reformat', 20000);
  check(true, 'Ctrl+Alt+L reformats with ruff');

  // ---------- Git log ----------
  const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-installed-git-'));
  writeFileSync(path.join(gitHome, 'gitconfig'), '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(gitHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init'], ['add', '-A'], ['commit', '-m', 'Initial commit']]) execFileSync('git', args, { cwd: t.project, env, stdio: 'ignore' });
  await js(`(ide.emit('filesChanged'), true)`);
  await js(`(ide.toolWindows.get('Git').show(), true)`);
  await until(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row .vcs-subject-text')].some(n => n.textContent === 'Initial commit')`, 'git log row', 20000);
  check(true, 'the Git log shows the commit');
  await t.shot('installed.png');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? `: ${t.consoleErrors.join(' / ')}` : ''}`);
} catch (err) {
  check(false, err.message);
} finally {
  t?.close();
}

// ---------- uninstall ----------
await sleep(1500); // let the killed app release its files
spawnSync(path.join(installDir, 'Uninstall PyIDE.exe'), ['/S'], { stdio: 'ignore' });
// The uninstaller copies itself to %TEMP% and returns at once; wait for it to finish removing the app.
for (let i = 0; i < 120 && (existsSync(exe) || uninstallEntry()); i++) await sleep(500);
check(!existsSync(exe), 'uninstall removes the installed files');
check(!existsSync(SHORTCUT), 'uninstall removes the Start menu shortcut');
check(!uninstallEntry(), 'uninstall removes the Apps & features entry');
check(reg(`${CLASSES}\\PyIDE.py`) === null && !(reg(`${CLASSES}\\.py\\OpenWithProgids`) || '').includes('PyIDE.py')
  && reg(`${CLASSES}\\Applications\\PyIDE.exe`) === null, 'uninstall removes the "Open with" registration');
check(reg(`${CLASSES}\\.py`, '/s') === pyKeyBefore, 'HKCU .py key is back to how it was before the install');
try { rmSync(path.dirname(installDir), { recursive: true, force: true }); } catch {}

const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
