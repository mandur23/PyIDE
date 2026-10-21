// The Windows installers end to end: installs the NSIS build (dist/PyIDE-Setup-*.exe, into a temp folder) and the MSI
// build (dist/PyIDE-*.msi, with msiexec into its per-user default folder), each without admin rights. For each it opens
// a .py with the installed PyIDE.exe the way "Open with PyIDE" does and checks the features that depend on unpacked
// files (Pyright, the ConPTY terminal, ruff, Git), then uninstalls and checks that the files, the shortcut, the
// "Open with" registration and the install record are gone.
// Usage: node verify/installed.mjs [nsis|msi|all] [installer file]. Build first with `npm run dist`.
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.PYIDE_DIST_DIR ? path.resolve(process.env.PYIDE_DIST_DIR) : path.join(APP_DIR, 'dist');
const OUT = path.join(APP_DIR, 'verify', 'out', 'installed');
mkdirSync(OUT, { recursive: true });
const [kindArg = 'all', fileArg] = process.argv.slice(2);
// dist keeps the installers of earlier versions too: take package.json's version, else the first match.
const VERSION = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const inDist = (pattern, name) => {
  if (existsSync(path.join(DIST, name))) return path.join(DIST, name);
  const f = existsSync(DIST) && readdirSync(DIST).find((n) => pattern.test(n));
  return f ? path.join(DIST, f) : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = (...args) => {
  try { return execFileSync('reg', ['query', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const CLASSES = 'HKCU\\Software\\Classes';
const SHORTCUT = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'PyIDE.lnk');
const hasPyIDE = (key, value) => (reg(key, '/s', '/f', 'PyIDE', '/d') || '').includes(value);
const OPEN_WITH_KEYS = /^Software\\Classes\\(PyIDE\.py|\.py\\OpenWithProgids|Applications\\PyIDE\.exe)(\\|$)/;
const registered = (exe) => (reg(`${CLASSES}\\.py\\OpenWithProgids`, '/v', 'PyIDE.py') || '').includes('PyIDE.py')
  && (reg(`${CLASSES}\\PyIDE.py\\shell\\open\\command`, '/ve') || '').toLowerCase().includes(exe.toLowerCase());
const unregistered = () => reg(`${CLASSES}\\PyIDE.py`) === null && !(reg(`${CLASSES}\\.py\\OpenWithProgids`) || '').includes('PyIDE.py')
  && reg(`${CLASSES}\\Applications\\PyIDE.exe`) === null;
// The "Open with" values msiexec wrote (op 'RegAddValue') or removed ('RegRemoveValue'), from its verbose log.
function loggedOpenWith(log, op) {
  let text = '';
  try { text = readFileSync(log).toString('utf16le'); } catch { return 0; }
  const lines = text.split(/\r?\n/).filter((l) => l.includes('Executing op: Reg'));
  return lines.filter((l, i) => {
    const key = /RegOpenKey\(Root=-?\d+,Key=([^,]*)/.exec(l)?.[1];
    return key && OPEN_WITH_KEYS.test(key) && lines[i + 1]?.includes(`Executing op: ${op}(`);
  }).length;
}
// Shells started by the Claude desktop app (an MSIX package) see the package's private copy of
// HKCU\Software\Classes; msiexec runs as a service and writes the real one. When the registry shows nothing, the MSI's
// "Open with" checks fall back to its log, which lists every registry write and removal.
const msiLog = (name) => path.join(OUT, `msi-${name}.log`);

const KINDS = {
  nsis: {
    file: () => fileArg || inDist(/^PyIDE-Setup-.*\.exe$/, `PyIDE-Setup-${VERSION}.exe`),
    dir: () => path.join(mkdtempSync(path.join(tmpdir(), 'pyide-installed-')), 'PyIDE'),
    install: (file, dir) => spawnSync(file, ['/S', `/D=${dir}`], { stdio: 'ignore' }).status,
    // The uninstaller copies itself to %TEMP% and returns at once; the caller waits for the files to go.
    uninstall: (_file, dir) => spawnSync(path.join(dir, 'Uninstall PyIDE.exe'), ['/S'], { stdio: 'ignore' }).status,
    record: () => hasPyIDE('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'DisplayName'),
    recordLabel: 'Apps & features entry',
    openWith: (exe) => registered(exe) && 'registry',
    openWithGone: () => unregistered() && 'registry',
  },
  msi: {
    file: () => fileArg || inDist(/^PyIDE-.*\.msi$/, `PyIDE-${VERSION}.msi`),
    dir: () => path.join(process.env.LOCALAPPDATA, 'Programs', 'PyIDE'),
    install: (file) => spawnSync('msiexec', ['/i', file, '/qn', '/l*v', msiLog('install')], { stdio: 'ignore' }).status,
    uninstall: (file) => spawnSync('msiexec', ['/x', file, '/qn', '/l*v', msiLog('uninstall')], { stdio: 'ignore' }).status,
    // Per-user MSI products are registered under HKCU (and listed in Apps & features from there).
    record: () => hasPyIDE('HKCU\\Software\\Microsoft\\Installer\\Products', 'ProductName'),
    recordLabel: 'per-user Windows Installer product registration',
    openWith: (exe) => (registered(exe) && 'registry') || (loggedOpenWith(msiLog('install'), 'RegAddValue') === 8 && 'msiexec log'),
    openWithGone: () => unregistered() && loggedOpenWith(msiLog('uninstall'), 'RegRemoveValue') === 8 && 'registry and msiexec log',
  },
};

const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

async function smoke(exe, port, name) {
  let t;
  try {
    // ---------- "Open with PyIDE" on a .py: its folder becomes the project and the file opens ----------
    t = await launch({ fixture: 'lsp', port, name, exe, open: 'errors.py' });
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

    // ---------- spell checker: nspell and the Hunspell dictionary inside app.asar, on a worker thread ----------
    const sugg = await js(`ide.spellcheck.suggest('mispeled').catch((e) => 'error: ' + e.message)`);
    check(Array.isArray(sugg) && sugg.includes('misspelled'), `the spell checker reads its dictionary from the package (${JSON.stringify(sugg)})`);

    // ---------- Git log ----------
    const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-installed-git-'));
    writeFileSync(path.join(gitHome, 'gitconfig'), '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(gitHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    for (const args of [['init'], ['add', '-A'], ['commit', '-m', 'Initial commit']]) execFileSync('git', args, { cwd: t.project, env, stdio: 'ignore' });
    await js(`(ide.emit('filesChanged'), true)`);
    await js(`(ide.toolWindows.get('Git').show(), true)`);
    await until(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row .vcs-subject-text')].some(n => n.textContent === 'Initial commit')`, 'git log row', 20000);
    check(true, 'the Git log shows the commit');
    await t.shot(`${name}.png`);
    check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? `: ${t.consoleErrors.join(' / ')}` : ''}`);
  } catch (err) {
    check(false, err.message);
  } finally {
    t?.close();
  }
}

async function run(kind, port) {
  const k = KINDS[kind];
  const file = k.file();
  if (!file || !existsSync(file)) { check(false, `${kind}: no installer in dist (run npm run dist)`); return; }
  console.log(`---------- ${kind}: ${path.basename(file)} ----------`);
  const dir = k.dir();
  if (existsSync(dir)) { check(false, `${kind}: ${dir} already exists; uninstall PyIDE first`); return; }
  const pyKeyBefore = reg(`${CLASSES}\\.py`, '/s');
  const pyDefaultBefore = reg(`${CLASSES}\\.py`, '/ve');
  const exe = path.join(dir, 'PyIDE.exe');
  for (const log of [msiLog('install'), msiLog('uninstall')]) rmSync(log, { force: true });

  check(k.install(file, dir) === 0 && existsSync(exe), `silent per-user install into ${dir}`);
  const unpacked = path.join(dir, 'resources', 'app.asar.unpacked');
  check(existsSync(path.join(dir, 'resources', 'app.asar')) && existsSync(path.join(unpacked, 'vendor', 'bin', 'ruff.exe'))
    && existsSync(path.join(unpacked, 'node_modules', 'pyright', 'langserver.index.js'))
    && existsSync(path.join(unpacked, 'main', 'semantic', 'embed_server.py')), 'app.asar plus unpacked ruff.exe, pyright and sidecar scripts');
  check(existsSync(SHORTCUT), 'Start menu shortcut');
  check(k.record(), k.recordLabel);
  const openWith = k.openWith(exe);
  check(openWith, `.py lists "Open with PyIDE" (${openWith || 'not found'})`);
  check(pyKeyBefore === null || reg(`${CLASSES}\\.py`, '/ve') === pyDefaultBefore, '.py default program untouched');

  if (existsSync(exe)) await smoke(exe, port, `installed-${kind}`);

  // ---------- uninstall ----------
  await sleep(1500); // let the killed app release its files
  check(k.uninstall(file, dir) === 0, 'silent uninstall');
  for (let i = 0; i < 120 && (existsSync(exe) || k.record()); i++) await sleep(500);
  check(!existsSync(exe), 'uninstall removes the installed files');
  check(!existsSync(SHORTCUT), 'uninstall removes the Start menu shortcut');
  check(!k.record(), `uninstall removes the ${k.recordLabel}`);
  const gone = k.openWithGone();
  check(gone, `uninstall removes the "Open with" registration (${gone || 'still there'})`);
  check(reg(`${CLASSES}\\.py`, '/s') === pyKeyBefore, 'HKCU .py key is back to how it was before the install');
  if (kind === 'nsis') try { rmSync(path.dirname(dir), { recursive: true, force: true }); } catch {}
}

const kinds = kindArg === 'all' ? ['nsis', 'msi'] : [kindArg];
if (!kinds.every((k) => KINDS[k])) throw new Error('usage: node verify/installed.mjs [nsis|msi|all] [installer file]');
for (const [i, kind] of kinds.entries()) await run(kind, 9790 + i);

const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
