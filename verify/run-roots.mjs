// Mark Directory As and the run configuration fields of round 033: the src layout's root marked when the project opens
// (PyCharm's notification, Revert), Run, pytest and Pyright agreeing on imports through the source roots, Mark Directory
// As › Sources Root / Test Sources Root / Excluded from the project tree with the mouse (icons, Unmark, Cancel
// Exclusion, Pyright's file list), the roots after a restart, Interpreter options (Run and Debug), Redirect input from,
// Emulate terminal in output console (isatty, colors, typed input, Stop), the form at 1008x681, and Korean.
// Pure Node first: the src layout rule and PYTHONPATH order of main/project-roots.js.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const require = createRequire(import.meta.url);
const q = JSON.stringify;
const unit = [];
const unitCheck = (ok, label) => { unit.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

// ---------- project-roots.js (pure Node) ----------
{
  const base = tempDir('run-roots-unit');
  process.env.PYIDE_USER_DATA = path.join(base, 'userdata');
  const roots = require('../main/project-roots.js');
  const make = (name, files) => {
    const dir = path.join(base, name);
    for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); }
    return dir;
  };
  const pkg = make('pkg', { 'src/mypkg/__init__.py': '', 'src/mypkg/core.py': '' });
  const ns = make('ns', { 'src/nspkg/mod.py': '' });
  const module = make('module', { 'src/single.py': '' });
  const isPkg = make('ispkg', { 'src/__init__.py': '', 'src/x.py': '' });
  const leftovers = make('leftovers', { 'src/thing.egg-info/PKG-INFO': '', 'src/__pycache__/a.pyc': '', 'src/README.md': '' });
  const none = make('none', { 'main.py': '' });
  unitCheck(roots.srcLayout(pkg) && roots.srcLayout(ns) && roots.srcLayout(module), 'src/ holding a package, a namespace package or a module is a src layout');
  unitCheck(!roots.srcLayout(isPkg) && !roots.srcLayout(leftovers) && !roots.srcLayout(none), 'a src package (__init__.py), build leftovers only, or no src are not');
  unitCheck(q(roots.withSources([pkg])) === q([pkg, path.join(pkg, 'src')]), 'withSources: the project root, then its src root');
  roots.mark(pkg, path.join(pkg, 'tests'), 'tests');
  roots.mark(pkg, path.join(pkg, 'lib'), 'sources');
  unitCheck(q(roots.withSources([pkg, pkg])) === q([pkg, path.join(pkg, 'src'), path.join(pkg, 'lib'), path.join(pkg, 'tests')]),
    'sources roots before test sources roots, each path once');
  roots.mark(pkg, path.join(pkg, 'lib'), 'excluded');
  unitCheck(q(roots.rootsOf(pkg)) === q({ sources: ['src'], tests: ['tests'], excluded: ['lib'] }), 'a folder has one kind at a time');
  unitCheck(roots.mark(pkg, pkg, 'excluded') === null && roots.mark(pkg, path.join(base, 'elsewhere'), 'sources') === null,
    'the project root cannot be excluded, and a folder outside the project cannot be marked');
  roots.mark(pkg, path.join(pkg, 'src'), null);
  unitCheck(q(roots.rootsOf(pkg).sources) === q([]) && !roots.pythonPaths(pkg).includes(path.join(pkg, 'src')), 'unmarking the detected src keeps it unmarked (the record wins over detection)');
  const saved = JSON.parse(readFileSync(path.join(process.env.PYIDE_USER_DATA, 'project-roots.json'), 'utf8'));
  unitCheck(q(saved[path.resolve(pkg).toLowerCase()]) === q({ sources: [], tests: ['tests'], excluded: ['lib'] }), 'the record is saved in <userData>/project-roots.json');
  delete process.env.PYIDE_USER_DATA;
}

const nodes = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name')?.textContent === ${q(name)})`;
const iconOf = (t, name) => t.js(`${nodes(name)}?.querySelector('.file-icon')?.dataset.type || null`);
const menuItem = (label) => `[...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === ${q(label)})`;
const menuLabels = (level) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item .menu-label')].map((n) => n.textContent)`;

async function mouseAt(t, expr, { button = 'left', move = false } = {}) {
  const box = await t.js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing to click: ${expr.slice(0, 120)}`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  if (move) return t.sleep(250);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: 1, buttons: button === 'right' ? 2 : 1 });
  await t.sleep(80);
}

// Right-click on a tree folder, Mark Directory As › item.
async function markWithMenu(t, folder, item, groupLabel = 'Mark Directory As') {
  await mouseAt(t, nodes(folder), { button: 'right' });
  await t.until(`!!${menuItem(groupLabel)}`, `${groupLabel} in the context menu of ${folder}`, 5000);
  await mouseAt(t, menuItem(groupLabel), { move: true });
  await t.until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'Mark Directory As submenu', 5000);
  const labels = await t.js(menuLabels(1));
  await mouseAt(t, `[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === ${q(item)})`);
  await t.until(`!document.querySelector('.context-menu')`, 'menu closed', 5000);
  return labels;
}

const config = (extra) => `({ ...ide.run.types.get('python').defaults(), id: 'cfg-' + Math.random().toString(36).slice(2), type: 'python', ...${q(extra)}, script: ide.util.joinPath(ide.root, ${q(extra.script)}) })`;
const sessionText = `(document.querySelector('.run-session:not(.hidden) .console')?.textContent || '')`;
async function runAndRead(t, extra, label) {
  await t.js(`ide.run.runConfig(${config({ name: extra.script, ...extra })}).then(() => true)`);
  await t.until(`${sessionText}.includes('Process finished with exit code')`, label, 40000);
  return t.js(sessionText);
}
const termText = `(() => { const b = ide.run.activeSession()?.term?.buffer.active; if (!b) return ''; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`;
const pyProblems = (t, file) => t.js(`ide.problems.all().filter((p) => p.source === 'pyright' && p.path.toLowerCase().endsWith(${q(file.toLowerCase())})).map((p) => p.msg)`);

// ---------- English ----------
const t = await launch({ fixture: 'run-roots', port: 9590, name: 'run-roots' });
const { js, until, check, sleep } = t;
const userData = t.userData;
try {
  check(unit.every((u) => u.ok), `project-roots.js: ${unit.filter((u) => u.ok).length}/${unit.length} pure Node checks (listed above)`);

  // ---------- the src layout on open ----------
  await until(`ide.projectRoots && ide.projectRoots.get().sources.includes('src')`, 'src detected as a source root', 20000);
  const balloon = `[...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes("'src' has been marked as source root"))`;
  await until(`!!${balloon}`, 'source root notification');
  const actions = await js(`[...${balloon}.querySelectorAll('.ide-balloon-action')].map((a) => a.textContent)`);
  check(q(actions) === q(['Ok', 'Revert', "Don't show again"]), `PyCharm's notification "'src' has been marked as source root" with Ok, Revert, Don't show again (${actions})`);
  await until(`${nodes('src')}?.querySelector('.file-icon')?.dataset.type === 'sourceRoot'`, 'src drawn as a sources root');
  check(true, 'the project tree draws src with the sources root folder icon');
  const record = JSON.parse(readFileSync(path.join(userData, 'project-roots.json'), 'utf8'));
  check(Object.values(record).some((r) => q(r) === q({ sources: ['src'], tests: [], excluded: [] })), 'the detected root is written to project-roots.json');

  let out = await runAndRead(t, { script: 'use_src.py' }, 'run use_src.py');
  check(out.includes('SRC 5') && out.includes('exit code 0'), 'Run: an import from the src layout works (src on PYTHONPATH)');

  await js(`ide.run.runConfig({ ...ide.run.types.get('pytest').defaults(), id: 'cfg-src-tests', name: 'src tests', type: 'pytest', target: 'tests\\\\test_src.py' }).then(() => true)`);
  await until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, 'pytest finished', 60000);
  const status = await js(`document.querySelector('.run-session:not(.hidden) .tr-status').textContent`);
  check(status.includes('Tests passed: 1 of 1 test'), `pytest imports the src package too (${status})`);

  await openFile(t, 'use_src.py');
  await until(`ide.lsp.ready()`, 'Pyright ready', 30000);
  const definition = `ide.lsp.request('textDocument/definition', { textDocument: { uri: ide.monaco.Uri.file(ide.util.joinPath(ide.root, 'use_src.py')).toString() }, position: { line: 0, character: 24 } }).then((r) => JSON.stringify(r || []))`;
  await until(`${definition}.then((s) => /src[\\\\/]+mypkg[\\\\/]+core\\.py/i.test(decodeURIComponent(s)))`, 'Pyright resolves add to src/mypkg/core.py', 30000);
  check(true, 'Pyright resolves the same import to src/mypkg/core.py (extraPaths)');

  // ---------- Revert ----------
  await mouseAt(t, `[...${balloon}.querySelectorAll('.ide-balloon-action')].find((a) => a.textContent === 'Revert')`);
  await until(`ide.projectRoots.get().sources.length === 0`, 'src unmarked by Revert');
  await until(`${nodes('src')}?.querySelector('.file-icon')?.dataset.type === 'folder'`, 'src drawn as a plain folder');
  check(true, 'Revert unmarks src and the tree draws a plain folder');
  out = await runAndRead(t, { script: 'use_src.py' }, 'run use_src.py unmarked');
  check(out.includes("ModuleNotFoundError: No module named 'mypkg'"), 'without the source root, Run fails as PyCharm would (ModuleNotFoundError)');
  await until(`ide.problems.all().some((p) => p.source === 'pyright' && p.path.toLowerCase().endsWith('use_src.py') && /mypkg/.test(p.msg))`, 'Pyright reports the import', 30000);
  check(true, `and the editor agrees: Pyright reports the import (${(await pyProblems(t, 'use_src.py')).join(' | ')})`);

  // ---------- Mark Directory As with the mouse ----------
  let labels = await markWithMenu(t, 'src', 'Sources Root');
  check(q(labels) === q(['Sources Root', 'Test Sources Root', 'Excluded']), `Mark Directory As › Sources Root, Test Sources Root, Excluded (${labels})`);
  await until(`${nodes('src')}?.querySelector('.file-icon')?.dataset.type === 'sourceRoot'`, 'src marked again');
  await until(`!ide.problems.all().some((p) => p.source === 'pyright' && p.path.toLowerCase().endsWith('use_src.py') && /mypkg/.test(p.msg))`, 'Pyright import problem gone', 30000);
  check(true, 'marking src again clears the Pyright problem (new settings sent to the running server)');
  out = await runAndRead(t, { script: 'use_src.py' }, 'run use_src.py marked');
  check(out.includes('SRC 5'), 'and Run works again');

  await mouseAt(t, nodes('src'), { button: 'right' });
  await until(`!!${menuItem('Mark Directory As')}`, 'menu on src');
  await mouseAt(t, menuItem('Mark Directory As'), { move: true });
  await until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'submenu on src');
  labels = await js(menuLabels(1));
  check(q(labels) === q(['Unmark as Sources Root', 'Test Sources Root', 'Excluded']), `a sources root offers Unmark as Sources Root (${labels})`);
  await t.press('Escape');
  await t.press('Escape');

  await markWithMenu(t, 'lib2', 'Sources Root');
  out = await runAndRead(t, { script: 'app\\uses_lib2.py' }, 'run app/uses_lib2.py');
  check(out.includes('LIB2 helped'), 'a folder marked as Sources Root by hand goes on PYTHONPATH (app/uses_lib2.py imports from lib2)');

  await markWithMenu(t, 'tests', 'Test Sources Root');
  check((await iconOf(t, 'tests')) === 'testRoot' && q(await js(`ide.projectRoots.get().tests`)) === q(['tests']), 'Test Sources Root: the green test root icon and ide.projectRoots.get().tests');

  // ---------- Excluded ----------
  const symbol = `ide.lsp.request('workspace/symbol', { query: 'junk_only_symbol_q7' }).then((r) => (r || []).length)`;
  await until(`${symbol}.then((n) => n > 0)`, 'the generated/ symbol is in Pyright\'s workspace symbols', 30000);
  await markWithMenu(t, 'generated', 'Excluded');
  check((await iconOf(t, 'generated')) === 'excludeRoot', 'Excluded: the orange excluded folder icon');
  await until(`${symbol}.then((n) => n === 0)`, 'the generated/ symbol leaves Pyright\'s file list', 30000);
  check(true, 'an excluded folder leaves Pyright\'s file list (its symbols are no longer found)');
  await mouseAt(t, nodes('generated'), { button: 'right' });
  await until(`!!${menuItem('Mark Directory As')}`, 'menu on generated');
  await mouseAt(t, menuItem('Mark Directory As'), { move: true });
  await until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'submenu on generated');
  labels = await js(menuLabels(1));
  check(labels[0] === 'Cancel Exclusion', `an excluded folder offers Cancel Exclusion (${labels})`);
  await t.press('Escape');
  await t.press('Escape');
  check(await js(`ide.projectRoots.isExcluded(ide.util.joinPath(ide.root, 'generated', 'junk_mod.py')) && !ide.projectRoots.isExcluded(ide.util.joinPath(ide.root, 'use_src.py'))`),
    'ide.projectRoots.isExcluded answers for files inside an excluded folder');

  // ---------- Interpreter options ----------
  out = await runAndRead(t, { script: 'flags.py', interpOptions: '-X dev -O' }, 'run flags.py with options');
  check(out.includes('FLAGS True 1'), 'Interpreter options -X dev -O reach Python (dev mode on, optimize 1)');
  check(/ -X dev -O .*flags\.py/.test(out), 'the command line shows the options before the script');

  // ---------- Redirect input from ----------
  out = await runAndRead(t, { script: 'read_stdin.py', stdinFile: 'input.txt' }, 'run read_stdin.py with input.txt');
  check(out.includes("GOT 'line1\\nline2\\n' False"), `Redirect input from: the program reads the file to its end (${out.split('\n').find((l) => l.startsWith('GOT'))})`);
  check(await js(`!document.querySelector('.run-session:not(.hidden) .console-input, .run-session:not(.hidden) input')`), 'the console has no input field while input comes from a file');
  await js(`ide.run.runConfig(${config({ name: 'read_stdin', script: 'read_stdin.py', stdinFile: 'missing.txt' })}).then(() => true)`);
  await until(`${sessionText}.includes("Input file doesn't exist:")`, 'missing input file reported');
  check(!(await js(sessionText)).includes('GOT') && !(await js(`ide.run.activeSession().launched`)), 'a missing input file is reported and nothing runs');

  // ---------- Emulate terminal in output console ----------
  await js(`ide.run.runConfig(${config({ name: 'tty_check', script: 'tty_check.py', emulateTerminal: true })}).then(() => true)`);
  await until(`${termText}.includes('Name:')`, 'the program runs in a terminal', 30000);
  let text = await js(termText);
  check(text.includes('TTY True True'), `isatty() is true for stdout and stdin (${text.split('\n').find((l) => l.startsWith('TTY'))})`);
  check(await js(`[...document.querySelectorAll('.run-session:not(.hidden) .run-term .xterm-rows span')].some((s) => s.textContent.includes('RED-TEXT') && (/xterm-fg-1\\b/.test(s.className) || /color/.test(s.getAttribute('style') || '')))`),
    'ANSI colors are drawn (RED-TEXT in red)');
  check(/^PROGRESS 2\/2\s*$/m.test(text) && !text.includes('PROGRESS 0/2PROGRESS'), 'a line rewritten with a carriage return shows its last state (PROGRESS 2/2)');
  check(await js(`document.activeElement?.closest('.run-term') != null`), 'the terminal has the keyboard when the program starts');
  await t.type('민수');
  await t.press('Enter');
  await until(`${termText}.includes('Hello 민수')`, 'typed input reaches the program', 15000);
  await until(`${termText}.includes('Process finished with exit code 0')`, 'terminal run finished', 15000);
  check(true, 'keys typed in the terminal reach input() (Korean text too) and the exit line follows');

  await js(`ide.run.runConfig(${config({ name: 'forever', script: 'forever.py', emulateTerminal: true })}).then(() => true)`);
  await until(`${termText}.includes('LONG')`, 'forever.py runs in a terminal', 30000);
  await sleep(300);
  check(await js(`ide.run.activeSession().running && document.activeElement?.closest('.run-term') != null`), 'the terminal run is running and has the keyboard');
  await t.press('Ctrl+F2');
  await until(`!ide.run.activeSession().running && ${termText}.includes('Process finished with exit code')`, 'Ctrl+F2 ends the terminal run', 15000);
  check(true, "Stop (Ctrl+F2, pressed in the terminal) ends the program: the IDE's shortcuts work there as in PyCharm's Run console");
  await js(`ide.run.runConfig(${config({ name: 'forever', script: 'forever.py', emulateTerminal: true })}).then(() => true)`);
  await until(`${termText}.includes('LONG') && ide.run.activeSession().running`, 'forever.py again', 30000);
  await js(`ide.run.runConfig(${config({ name: 'use_src', script: 'use_src.py' })}).then(() => true)`);
  await until(`${sessionText}.includes('SRC 5')`, 'another run', 30000);
  check(await js(`ide.run.sessions().filter((s) => s.running).length === 1`), 'another configuration runs in its own tab while the terminal run goes on');
  await js(`(ide.run.sessions().filter((s) => s.running).forEach((s) => s.stop()), true)`);
  await until(`!ide.run.sessions().some((s) => s.running)`, 'all stopped', 15000);

  // ---------- Debug with interpreter options ----------
  await js(`ide.run.debugConfig(${config({ name: 'flags', script: 'flags.py', interpOptions: '-X dev' })}).then(() => true)`);
  await until(`!ide.debugger.isActive() && (document.querySelector('#dbgOut')?.textContent || '').includes('FLAGS ')`, 'debug flags.py', 40000);
  check((await js(`document.querySelector('#dbgOut').textContent`)).includes('FLAGS True 0'), 'Debug passes the interpreter options to Python as well');

  // ---------- the form ----------
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await js(`(ide.run.addTemporary(${config({ name: 'flags', script: 'flags.py' })}), ide.run.editConfigurations(), true)`);
  await until(`!!document.querySelector('.rc-form [data-key="interpOptions"]')`, 'configuration form');
  const field = (key) => `document.querySelector('.rc-form [data-key="${key}"]')`;
  const label = (key) => js(`${field(key)}.closest('label').firstChild.textContent`);
  check((await label('interpOptions')) === 'Interpreter options:' && (await label('stdinFile')) === 'Redirect input from:' && (await label('emulateTerminal')) === 'Emulate terminal in output console:',
    'the Python form has Interpreter options, Redirect input from and Emulate terminal in output console');
  check(await js(`${field('emulateTerminal')}.type === 'checkbox' && !!${field('stdinFile')}.closest('.rc-browse')?.querySelector('button')`), 'Emulate terminal is a checkbox; Redirect input from has a browse button');
  const inside = (sel) => js(`(() => { const n = ${sel}; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); const f = document.querySelector('.rc-form').getBoundingClientRect(); return r.width > 0 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
  check(await inside(field('emulateTerminal')) && await js(`[...document.querySelectorAll('.dialog-buttons button')].every((b) => b.getBoundingClientRect().bottom <= innerHeight)`),
    '1008x681: the new fields scroll into view inside the form and the buttons stay in the window');
  await mouseAt(t, field('interpOptions'));
  await t.type('-X utf8');
  await mouseAt(t, field('emulateTerminal'));
  await mouseAt(t, `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'OK')`);
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  const saved = await js(`ide.run.configs().find((c) => c.name === 'flags')`);
  check(saved?.interpOptions === '-X utf8' && saved?.emulateTerminal === true, `the fields are saved with the configuration (${saved?.interpOptions}, ${saved?.emulateTerminal})`);
  await t.cdp('Emulation.clearDeviceMetricsOverride');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await t.shot('failure.png').catch(() => {});
}
t.close();

// ---------- after a restart ----------
const r = await launch({ fixture: 'run-roots', port: 9591, name: 'run-roots-restart', userData, projectDir: t.project });
try {
  await r.until(`ide.projectRoots && ide.projectRoots.get().excluded.length === 1`, 'roots loaded after restart', 20000);
  const got = await r.js(`ide.projectRoots.get()`);
  r.check(q(got) === q({ sources: ['src', 'lib2'], tests: ['tests'], excluded: ['generated'] }), `the roots persist across a restart (${q(got)})`);
  await r.until(`${nodes('generated')}?.querySelector('.file-icon')?.dataset.type === 'excludeRoot'`, 'icons after restart');
  r.check((await iconOf(r, 'src')) === 'sourceRoot' && (await iconOf(r, 'tests')) === 'testRoot', 'and the tree draws them');
  await r.sleep(1500);
  r.check(!(await r.js(`[...document.querySelectorAll('.ide-balloon')].some((b) => b.textContent.includes('marked as source root'))`)), 'no detection notification for a project with a record');
} catch (err) {
  r.check(false, err.message.split('\n')[0]);
}
r.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'run-roots', port: 9592, name: 'run-roots-ko', lang: 'ko-KR' });
try {
  const title = "'src'이(가) 소스 루트로 표시됨";
  await k.until(`[...document.querySelectorAll('.ide-balloon')].some((b) => b.textContent.includes(${q(title)}))`, 'Korean notification', 20000);
  const actions = await k.js(`[...[...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes(${q(title)})).querySelectorAll('.ide-balloon-action')].map((a) => a.textContent)`);
  k.check(q(actions) === q(['확인', '되돌리기', '다시 표시 안 함']), `${title}: 확인, 되돌리기, 다시 표시 안 함 (${actions})`);
  await k.until(`!!${nodes('src')}`, 'tree');
  const labels = await markWithMenu(k, 'tests', '테스트 소스 루트', '디렉터리를 다음으로 표시');
  k.check(q(labels) === q(['소스 루트', '테스트 소스 루트', '제외됨']), `디렉터리를 다음으로 표시 › 소스 루트, 테스트 소스 루트, 제외됨 (${labels})`);
  await mouseAt(k, nodes('src'), { button: 'right' });
  await k.until(`!!${menuItem('디렉터리를 다음으로 표시')}`, 'Korean menu on src');
  await mouseAt(k, menuItem('디렉터리를 다음으로 표시'), { move: true });
  await k.until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'Korean submenu');
  k.check((await k.js(menuLabels(1)))[0] === '소스 루트 표시 해제', 'a sources root offers 소스 루트 표시 해제');
  await k.press('Escape');
  await k.press('Escape');
  await k.js(`(ide.run.addTemporary({ ...ide.run.types.get('python').defaults(), id: 'cfg-ko', type: 'python', name: 'flags', script: ide.util.joinPath(ide.root, 'flags.py') }), ide.run.editConfigurations('cfg-ko'), true)`);
  await k.until(`!!document.querySelector('.rc-form [data-key="interpOptions"]')`, 'Korean form');
  const kl = (key) => k.js(`document.querySelector('.rc-form [data-key="${key}"]').closest('label').firstChild.textContent`);
  k.check((await kl('interpOptions')) === '인터프리터 옵션:' && (await kl('stdinFile')) === '다음 위치의 입력 리디렉션:' && (await kl('emulateTerminal')) === '출력 콘솔에서 터미널 에뮬레이션:',
    '인터프리터 옵션, 다음 위치의 입력 리디렉션, 출력 콘솔에서 터미널 에뮬레이션');
  const leaks = await englishLeaks(k, '.rc-dialog');
  k.check(!leaks.length, `no English in the configuration dialog${leaks.length ? `: ${q(leaks)}` : ''}`);
  await k.js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === '취소').click()`);
  const mine = ['Mark Directory As', 'Sources Root', 'Test Sources Root', 'Excluded', 'Unmark as Sources Root', 'Unmark as Test Sources Root',
    'Cancel Exclusion', "'{name}' has been marked as source root", 'Ok', 'Revert', "Don't show again", 'Interpreter options', 'e.g. -X dev -W error',
    'Redirect input from', 'A file the program reads as its standard input', 'Emulate terminal in output console'];
  const missing = (await missingTranslations(k)).filter((s) => mine.includes(s));
  k.check(!missing.length, `no missing translations among this round's strings${missing.length ? `: ${q(missing)}` : ''}`);
} catch (err) {
  k.check(false, err.message.split('\n')[0]);
  await k.shot('failure-ko.png').catch(() => {});
}
k.close();

const all = [...t.results, ...r.results, ...k.results];
const failed = all.filter((res) => !res.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed ? 1 : 0);
