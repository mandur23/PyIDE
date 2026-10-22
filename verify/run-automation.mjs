// Before launch tasks of run configurations (Run Another Configuration, Run External Tool: order, failure stops the
// launch, cycles refused, Debug runs them too, .bat / npm shim arguments) and File Watchers (save trigger with macros,
// debounce, no concurrent runs per file, external changes only when enabled, error notification, nothing in Safe Mode),
// then the Korean UI in an untrusted project, where neither watchers nor before launch tools start. The external
// program is verify/fixtures/run-automation/tool.js run by this Node.
// Ports 9350-9351.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const q = JSON.stringify;
const NODE = process.execPath;
const APP_DIR = path.resolve(import.meta.dirname, '..');

const t = await launch({ fixture: 'run-automation', port: 9350 });
const { js, until, check, click, sleep } = t;
const P = (f) => path.join(t.project, f);
const TOOL = P('tool.js');
const readLog = (f) => (existsSync(P(f)) ? readFileSync(P(f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const num = (f) => Number(readFileSync(P(f), 'utf8'));
const rm = (...fs) => { for (const f of fs) rmSync(P(f), { force: true }); };
const notes = () => js(`ide.notifications.list().map((e) => e.title + ' | ' + e.text)`);
const menuItems = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map((n) => n.textContent)`);
async function clickMenu(text) {
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((n) => n.textContent.includes(${q(text)}))`, `menu item ${text}`, 5000)
    .catch(async () => { throw new Error(`menu item ${text} not found in ${q(await menuItems())}`); });
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.textContent.includes(${q(text)})).classList.add('pick-menu')`);
  await click('.context-menu .menu-item.pick-menu');
}
const setInput = (sel, value) => js(`(() => { const n = document.querySelector(${q(sel)}); n.value = ${q(value)}; n.dispatchEvent(new Event(n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
async function clickButton(label) {
  await js(`[...document.querySelectorAll('.dialog-buttons button')].reverse().find((b) => b.textContent === ${q(label)}).classList.add('pick-btn')`);
  await click('.dialog-buttons button.pick-btn');
  await js(`document.querySelector('.pick-btn')?.classList.remove('pick-btn')`);
}
const blRows = () => js(`[...document.querySelectorAll('.rc-bl-item')].map((n) => n.textContent)`);
const cfgJs = (id) => `ide.run.configs().find((c) => c.id === ${q(id)})`;
const saved = (id) => js(`(ide.settings.get('runConfigs:' + ide.root).configs.find((c) => c.id === ${q(id)}) || {}).beforeLaunch || []`);
// The Before launch section and the watcher list can sit below the fold of their scrolling form.
async function clickSeen(ctx, sel) {
  await ctx.js(`(document.querySelector(${q(sel)}).scrollIntoView({ block: 'center' }), true)`);
  await ctx.click(sel);
}
// Opens a file without waiting for it to be the active tab (a project's first open also shows the Workspace tab).
async function openTab(ctx, rel) {
  await ctx.js(`ide.openFile(ide.util.joinPath(ide.root, ${q(rel.replace(/\//g, '\\'))}))`);
  await ctx.until(`!!ide.findTab(ide.util.joinPath(ide.root, ${q(rel.replace(/\//g, '\\'))}))?.model`, `tab ${rel}`);
}
const toolArgs = (log, label, sleepMs, code, extra = '') => `"${TOOL}" ${log} ${label} ${sleepMs} ${code}${extra ? ` ${extra}` : ''}`;

try {
  // ---------- configurations: A writes dep.txt, Main writes main.txt, Dbg is debugged ----------
  await openFile(t, 'main.py');
  await js(`(() => {
    const py = (id, name, script, params = '') => ({ id, name, type: 'python', script, params, cwd: '', env: '', envFiles: '.env', interp: '' });
    ide.run.configs().push(py('cfg-a', 'Make dep', 'make_marker.py', 'dep.txt'), py('cfg-b', 'Main', 'main.py'), py('cfg-d', 'Dbg', 'dbg.py'));
    ide.run.select('cfg-b');
    return true;
  })()`);

  // ---------- Edit Configurations: add Run Another Configuration and Run External Tool ----------
  await js(`(ide.run.editConfigurations('cfg-b'), true)`);
  await until(`!!document.querySelector('.rc-bl')`, 'Before launch section');
  check((await js(`document.querySelector('.rc-bl-title').textContent`)) === 'Before launch' && (await blRows()).length === 0
    && await js(`!!document.querySelector('.rc-bl-none')`), 'a configuration saved before the feature has an empty Before launch list');
  await clickSeen(t, '.rc-bl-bar [data-bl="add"]');
  const addMenu = await menuItems();
  check(addMenu.some((s) => s.includes('Make dep')) && addMenu.some((s) => s.includes('Dbg')) && !addMenu.some((s) => s.includes('Main'))
    && addMenu.some((s) => s.includes('Run External Tool')), `Add Task lists the other configurations and Run External Tool (${addMenu.join(' | ')})`);
  await clickMenu('Make dep');
  check(q(await blRows()) === q(["Run 'Make dep'"]), 'Run Another Configuration is added');
  await clickSeen(t, '.rc-bl-bar [data-bl="add"]');
  await clickMenu('Run External Tool');
  await until(`!!document.querySelector('[data-bl-key="program"]')`, 'tool fields');
  check(await js(`document.activeElement === document.querySelector('[data-bl-key="program"]')`), 'the Program field takes the focus');
  await setInput('[data-bl-key="name"]', 'Tool One');
  await setInput('[data-bl-key="program"]', NODE);
  await setInput('[data-bl-key="args"]', toolArgs('bl-log.jsonl', 'tool1', 1200, 0, '$ProjectDir$ ${FileName}'));
  check(q(await blRows()) === q(["Run 'Make dep'", 'Run External Tool: Tool One']), 'the tool row shows its name');
  await clickButton('OK');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  const bl = await saved('cfg-b');
  check(bl.length === 2 && bl[0].kind === 'config' && bl[0].id === 'cfg-a' && bl[1].kind === 'tool' && bl[1].program === NODE,
    `the tasks are saved in the configuration (${q(bl)})`);

  // ---------- Run: A, then the tool, then Main; progress in the status bar ----------
  await js(`(ide.run.runConfig(ide.run.selected()), true)`);
  await until(`ide.tasks.list().some((x) => x.title === "Before launch: 'Main'")`, 'before launch progress', 20000);
  check(true, 'a background task shows the before launch progress');
  await until(`ide.tasks.list().some((x) => x.text === 'Run External Tool: Tool One')`, 'progress names the tool', 20000);
  check(true, 'the progress names the running task');
  await until(`(async () => await ide.api.exists(ide.util.joinPath(ide.root, 'main.txt')))()`, 'main.txt', 30000);
  let log = readLog('bl-log.jsonl');
  const tool1 = log.find((l) => l.label === 'tool1' && l.phase === 'start');
  const tool1End = log.find((l) => l.label === 'tool1' && l.phase === 'end');
  check(existsSync(P('dep.txt')) && tool1 && num('dep.txt') <= tool1.t && tool1End && tool1End.t <= num('main.txt'),
    'Run Another Configuration finished, then the tool, then the configuration started');
  check(tool1 && q(tool1.args).toLowerCase() === q([t.project, 'main.py']).toLowerCase() && path.resolve(tool1.cwd).toLowerCase() === path.resolve(t.project).toLowerCase(),
    `the tool gets $ProjectDir$ and \${FileName} expanded and runs in the project folder (${q(tool1)})`);
  const titles = await js(`[...document.querySelectorAll('.run-tab-title')].map((n) => n.textContent)`);
  check(['Make dep', 'Tool One', 'Main'].every((x) => titles.includes(x)), `each task has its Run tab (${titles.join(' | ')})`);
  check(await js(`(() => { const s = ide.run.sessions().find((x) => x.title === 'Tool One'); return s.con.out.textContent.includes('tool1 says hi'); })()`),
    'the tool output shows in the Run window');
  await until(`!ide.tasks.list().length`, 'progress gone');

  // ---------- reorder: the tool first ----------
  await js(`(ide.run.editConfigurations('cfg-b'), true)`);
  await until(`document.querySelectorAll('.rc-bl-item').length === 2`, 'rows');
  check(await js(`document.querySelector('[data-bl="up"]').disabled`), 'Move Up is off for the first task');
  await clickSeen(t, '.rc-bl-item[data-index="1"]');
  await clickSeen(t, '.rc-bl-bar [data-bl="up"]');
  check(q(await blRows()) === q(['Run External Tool: Tool One', "Run 'Make dep'"]), 'Move Up reorders the tasks');
  await clickButton('OK');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  await js(`(${cfgJs('cfg-b')}.beforeLaunch[0].args = ${q(toolArgs('bl-log.jsonl', 'tool2', 0, 0))}, true)`);
  rm('dep.txt', 'main.txt');
  await js(`(ide.run.runConfig(ide.run.selected()), true)`);
  await until(`(async () => await ide.api.exists(ide.util.joinPath(ide.root, 'main.txt')))()`, 'main.txt again', 30000);
  const tool2 = readLog('bl-log.jsonl').find((l) => l.label === 'tool2' && l.phase === 'end');
  check(tool2 && tool2.t <= num('dep.txt') && num('dep.txt') <= num('main.txt'), 'the tasks run in the new order');

  // ---------- a failing task stops the launch and the tasks after it ----------
  await js(`(${cfgJs('cfg-b')}.beforeLaunch[0].args = ${q(toolArgs('bl-log.jsonl', 'tool3', 0, 3))}, true)`);
  rm('dep.txt', 'main.txt');
  await js(`(ide.run.runConfig(ide.run.selected()), true)`);
  await until(`ide.notifications.list().some((e) => e.title === "'Main' was not started")`, 'failure notification', 30000);
  const failNote = (await notes()).find((n) => n.startsWith("'Main' was not started"));
  check(failNote.includes('Before launch task failed: Run External Tool: Tool One') && failNote.includes('Exit code 3'), `the notification says which task failed (${failNote})`);
  await sleep(1500);
  check(!existsSync(P('dep.txt')) && !existsSync(P('main.txt')), 'neither the next task nor the configuration ran');
  check(await js(`ide.run.sessions().find((x) => x.title === 'Tool One').con.out.textContent.includes('tool3 failed')`), "the failed tool's output stays in its Run tab");

  // ---------- cycles ----------
  await js(`(${cfgJs('cfg-b')}.beforeLaunch[0].args = ${q(toolArgs('bl-log.jsonl', 'tool4', 0, 0))}, true)`);
  await js(`(ide.run.editConfigurations('cfg-a'), true)`);
  await until(`!!document.querySelector('.rc-bl')`, 'dialog for A');
  await clickSeen(t, '.rc-bl-bar [data-bl="add"]');
  await clickMenu('Main');
  const cycleErr = await js(`document.querySelector('.rc-bl-error')?.textContent || ''`);
  check(cycleErr.includes("'Make dep' cannot run before itself") && cycleErr.includes('Make dep → Main → Make dep') && (await blRows()).length === 0,
    `adding a configuration that runs this one first is refused (${cycleErr})`);
  await clickButton('Cancel');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  // A cycle written some other way (a hand-edited settings file) is refused when running and on OK.
  await js(`(${cfgJs('cfg-a')}.beforeLaunch = [{ kind: 'config', id: 'cfg-b' }], true)`);
  rm('dep.txt', 'main.txt');
  await js(`(ide.run.runConfig(ide.run.selected()), true)`);
  await until(`ide.notifications.list().some((e) => e.text.includes('Before launch tasks form a cycle'))`, 'cycle notification', 15000);
  check((await notes()).some((n) => n.includes('Main → Make dep → Main')), 'running a configuration in a cycle is refused and names the cycle');
  await sleep(1000);
  check(!existsSync(P('dep.txt')) && !existsSync(P('main.txt')) && !readLog('bl-log.jsonl').some((l) => l.label === 'tool4'), 'nothing in the cycle ran');
  await js(`(ide.run.editConfigurations('cfg-b'), true)`);
  await until(`!!document.querySelector('.rc-bl')`, 'dialog');
  await clickButton('OK');
  await sleep(300);
  check(await js(`!!document.querySelector('.rc-dialog') && (document.querySelector('.rc-bl-error')?.textContent || '').includes('cannot run before itself')`),
    'OK refuses to save configurations in a cycle');
  await clickButton('Cancel');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  await js(`(${cfgJs('cfg-a')}.beforeLaunch = [], true)`);

  // ---------- Debug runs the tasks too ----------
  await js(`(${cfgJs('cfg-d')}.beforeLaunch = [{ kind: 'tool', name: 'Dbg tool', program: ${q(NODE)}, args: ${q(toolArgs('bl-log.jsonl', 'dbgtool', 300, 0))}, cwd: '' }], true)`);
  await js(`(ide.run.debugConfig(${cfgJs('cfg-d')}), true)`);
  await until(`(document.querySelector('#dbgOut')?.textContent || '').includes('Process finished with exit code 0')`, 'debug run finished', 60000);
  const dbgTool = readLog('bl-log.jsonl').find((l) => l.label === 'dbgtool' && l.phase === 'end');
  check(existsSync(P('debugged.txt')) && dbgTool && dbgTool.t <= num('debugged.txt'), 'Debug runs the before launch tasks first');
  rm('debugged.txt');
  await js(`(${cfgJs('cfg-d')}.beforeLaunch[0].args = ${q(toolArgs('bl-log.jsonl', 'dbgtool2', 0, 4))}, true)`);
  await js(`(ide.run.debugConfig(${cfgJs('cfg-d')}), true)`);
  await until(`ide.notifications.list().some((e) => e.title === "'Dbg' was not started")`, 'debug failure notification', 30000);
  await sleep(2000);
  check(!existsSync(P('debugged.txt')) && readLog('bl-log.jsonl').some((l) => l.label === 'dbgtool2'), 'a failing task stops the debug launch');

  // ---------- a .bat / npm shim as the external tool ----------
  // A batch file of the user's own reads "%~1" and gets the argument as written (escaped once for cmd); an npm shim
  // under node_modules\.bin hands %* on and gets its arguments as written too (escaped twice). A node.bat the
  // project ships is not run in place of the "node" a shim names bare (NoDefaultCurrentDirectoryInExePath).
  const BLOG = 'bat-log.jsonl';
  const ODD = 'a & b %PATH% ^ ! (x) <y> 한글';
  writeFileSync(P('argtool.bat'), `@"${NODE}" "%~dp0tool.js" ${BLOG} bat 0 0 "%~1" %2\r\n`);
  mkdirSync(P('node_modules/.bin'), { recursive: true });
  writeFileSync(P('node_modules/.bin/argtool.cmd'), `@"${NODE}" "%~dp0..\\..\\tool.js" %*\r\n`);
  writeFileSync(P('bare.cmd'), `@node "%~dp0tool.js" %*\r\n`);
  writeFileSync(P('node.bat'), '@echo hijacked> hijacked.txt\r\n');
  const startTool = (program, args) => js(`ide.api.invoke('run:startTool', { program: ${q(program)}, args: ${q(args)}, cwd: '', macros: { projectDir: ide.root } })`);
  // The tool's start line (its arguments), once it has logged its end; null after 30 s.
  const ended = async (label) => {
    for (let i = 0; i < 200 && !readLog(BLOG).some((l) => l.label === label && l.phase === 'end'); i++) await sleep(150);
    return readLog(BLOG).find((l) => l.label === label && l.phase === 'start') || null;
  };
  const r1 = await startTool(P('argtool.bat'), `"${ODD}" "plain two"`);
  const bat = await ended('bat');
  check(r1?.id && bat && q(bat.args) === q([ODD, 'plain two']), `a .bat tool gets "%~1" as written (${q(bat?.args)})`);
  await startTool(P('node_modules/.bin/argtool.cmd'), `${BLOG} shim 0 0 "${ODD}" "say hi"`);
  const shim = await ended('shim');
  check(shim && q(shim.args) === q([ODD, 'say hi']), `an npm shim gets its arguments through %* as written (${q(shim?.args)})`);
  await startTool(P('bare.cmd'), `${BLOG} bare 0 0`);
  const bare = await ended('bare');
  check(bare && !existsSync(P('hijacked.txt')), "a shim's bare node is not the project's node.bat");
  rm(BLOG, 'argtool.bat', 'bare.cmd', 'node.bat', 'hijacked.txt');
  rmSync(P('node_modules'), { recursive: true, force: true });

  // ---------- File Watchers: settings page ----------
  const WLOG = P('wlog.jsonl');
  await js(`(ide.openSettings('fileWatchers'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'fileWatchers'`, 'File Watchers page');
  check(await js(`!!document.querySelector('.fw-none')`), 'no watchers in a new project');
  await clickSeen(t, '[data-fw="add"]');
  const tpl = await menuItems();
  check(['Custom', 'Black', 'pyside6-uic', 'pyuic5', 'Sass'].every((x) => tpl.some((s) => s.includes(x))), `templates: ${tpl.join(' | ')}`);
  await clickMenu('Custom');
  await until(`!!document.querySelector('[data-fw-key="program"]')`, 'watcher form');
  check(await js(`document.querySelector('[data-fw-key="cwd"]').value === '$FileDir$' && document.querySelector('[data-fw-key="showConsole"]').value === 'error'
    && !document.querySelector('[data-fw-key="external"]').checked && !document.querySelector('[data-fw-key="autoSave"]').checked`),
    'a new watcher runs in $FileDir$, on save only, and shows the console on error');
  await setInput('[data-fw-key="name"]', 'UI watcher');
  await setInput('[data-fw-key="fileType"]', '*.ui');
  await setInput('[data-fw-key="program"]', NODE);
  await setInput('[data-fw-key="args"]', `"${TOOL}" "${WLOG}" w1 0 0 $FilePath$ $FileName$ $FileNameWithoutExtension$ $FileDir$ $ProjectDir$`);
  check(await js(`document.querySelector('.fw-row.selected .fw-name').textContent === 'UI watcher'`), 'the list follows the form');
  await click('#settingsOk');
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
  const stored = await js(`ide.settings.get('fileWatchers:' + ide.root)`);
  check(stored?.length === 1 && stored[0].name === 'UI watcher' && stored[0].fileType === '*.ui' && stored[0].enabled === true,
    'the watcher is kept in the user settings under the project');
  await js(`(ide.settings.flush?.(), true)`);
  await sleep(300);
  check(readFileSync(path.join(t.userData, 'settings.json'), 'utf8').includes('"fileWatchers:') && !existsSync(P('.idea')) && !existsSync(P('.pyide')),
    'the watcher is saved in settings.json in the user data, not in the project');

  const setWatchers = (list) => js(`(ide.settings.set('fileWatchers:' + ide.root, ${q(list)}), true)`);
  const w1 = (extra = {}) => ({ ...stored[0], ...extra });
  const runsFor = (file) => js(`ide.fileWatchers.history().filter((h) => h.file.toLowerCase().endsWith(${q(file.toLowerCase())})).length`);
  const settle = () => until(`!ide.fileWatchers.busy()`, 'watchers idle', 30000);
  const editSave = (rel, times = 1) => js(`(async () => {
    const tab = ide.findTab(ide.util.joinPath(ide.root, ${q(rel.replace(/\//g, '\\'))}));
    for (let i = 0; i < ${times}; i++) {
      tab.model.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: '<!-- ' + i + ' -->' }], () => null);
      await ide.saveTab(tab);
    }
    return true;
  })()`);

  // ---------- save triggers, macros ----------
  await openFile(t, 'ui/form.ui');
  await editSave('ui/form.ui');
  await until(`ide.fileWatchers.history().length >= 1`, 'first watcher run', 20000);
  await settle();
  const first = readLog('wlog.jsonl').find((l) => l.label === 'w1' && l.phase === 'start');
  const form = P('ui\\form.ui');
  check(first && q(first.args).toLowerCase() === q([form, 'form.ui', 'form', P('ui'), t.project]).toLowerCase(), `macros are substituted (${q(first?.args)})`);
  check(first && path.resolve(first.cwd).toLowerCase() === P('ui').toLowerCase(), 'the watcher runs in $FileDir$');
  check(await js(`ide.fileWatchers.history()[0].code === 0`), 'the run succeeded');
  check(await js(`ide.run.sessions().some((s) => s.title === 'File Watchers' && s.con.out.textContent.includes('w1 says hi'))`), 'the output goes to the File Watchers console');

  // ---------- debounce: rapid saves, one run ----------
  await openFile(t, 'notes.txt');
  await js(`(async () => { const tab = ide.findTab(ide.util.joinPath(ide.root, 'notes.txt')); tab.model.setValue('changed\\n'); await ide.saveTab(tab); return true; })()`);
  await openFile(t, 'ui/form.ui');
  const before = await runsFor('form.ui');
  await editSave('ui/form.ui', 5);
  await until(`ide.fileWatchers.history().length > ${before}`, 'debounced run', 20000);
  await settle();
  await sleep(1000);
  check((await runsFor('form.ui')) === before + 1, `five quick saves run the watcher once (${(await runsFor('form.ui')) - before})`);
  check(!(await js(`ide.fileWatchers.history().some((h) => h.file.endsWith('notes.txt'))`)), 'a file of another type does not trigger it');

  // ---------- never two runs for the same file at once ----------
  await setWatchers([w1({ args: `"${TOOL}" "${WLOG}" slow 900 0 $FileName$` })]);
  const slowStarts = () => readLog('wlog.jsonl').filter((l) => l.label === 'slow' && l.phase === 'start').length;
  await editSave('ui/form.ui');
  for (let end = Date.now() + 20000; Date.now() < end && slowStarts() < 1;) await sleep(100);
  await editSave('ui/form.ui');
  await sleep(500);
  await editSave('ui/form.ui');
  await sleep(600);
  await settle();
  const slow = readLog('wlog.jsonl').filter((l) => l.label === 'slow');
  const runs = [];
  for (const l of slow) if (l.phase === 'start') runs.push({ start: l.t }); else runs[runs.length - 1].end = l.t;
  check(runs.length === 2, `saves during a run queue one more run (${runs.length} runs)`);
  check(runs.every((r, i) => !i || r.start >= runs[i - 1].end), `the runs for one file never overlap (${q(runs)})`);

  // ---------- external changes ----------
  await setWatchers([w1()]);
  const otherRuns = () => runsFor('other.ui');
  writeFileSync(P('ui/other.ui'), '<ui version="4.0"><class>Changed</class></ui>\n');
  await sleep(2500);
  check((await otherRuns()) === 0, 'a change on disk does not trigger a watcher without "Trigger on external changes"');
  await setWatchers([w1({ external: true })]);
  writeFileSync(P('ui/other.ui'), '<ui version="4.0"><class>Changed again</class></ui>\n');
  await until(`ide.fileWatchers.history().some((h) => h.file.toLowerCase().endsWith('other.ui'))`, 'external run', 20000);
  check(true, 'with the option on, a change on disk triggers it');
  await settle();
  const formBefore = await runsFor('form.ui');
  await editSave('ui/form.ui');
  await until(`ide.fileWatchers.history().filter((h) => h.file.toLowerCase().endsWith('form.ui')).length > ${formBefore}`, 'save run', 20000);
  await sleep(2500);
  await settle();
  check((await runsFor('form.ui')) === formBefore + 1, "the IDE's own save is not also taken as an external change");

  // ---------- errors: notification and console ----------
  await setWatchers([w1(), { ...w1(), id: 'fw-bad', name: 'Failing', fileType: '*.bad', args: `"${TOOL}" "${WLOG}" bad 0 5` }]);
  await openFile(t, 'x.bad');
  await editSave('x.bad');
  await until(`ide.notifications.list().some((e) => e.title === "File watcher 'Failing' failed")`, 'watcher error notification', 20000);
  check((await notes()).some((n) => n.startsWith("File watcher 'Failing' failed | Exit code 5")), 'a failing watcher posts an error notification');
  check(await js(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'File Watchers' && ide.run.activeSession().con.out.textContent.includes('bad failed')`),
    'the File Watchers console is shown on error');
  await settle();

  // ---------- disabled watcher, and Safe Mode in the renderer ----------
  const n0 = await js(`ide.fileWatchers.history().length`);
  await setWatchers([w1({ enabled: false })]);
  await editSave('ui/form.ui');
  await sleep(1500);
  check((await js(`ide.fileWatchers.history().length`)) === n0, 'a disabled watcher does not run');
  await setWatchers([w1()]);
  await js(`(ide.trusted = false, true)`);
  await editSave('ui/form.ui');
  await sleep(1500);
  check((await js(`ide.fileWatchers.history().length`)) === n0, 'nothing runs while the project is not trusted');
  await js(`(ide.trusted = true, true)`);

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
t.close();

// ---------- an untrusted project, in Korean ----------
const work = tempDir('run-automation-ko');
const home = path.join(work, 'home');
const repo = path.join(work, 'cloned-repo');
cpSync(path.join(APP_DIR, 'verify', 'fixtures', 'run-automation'), home, { recursive: true });
cpSync(path.join(APP_DIR, 'verify', 'fixtures', 'run-automation'), repo, { recursive: true });
const userData = path.join(work, 'userdata');
mkdirSync(userData);
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ recentProjects: [{ path: home, opened: Date.now() }] }));
const k = await launch({ fixture: 'run-automation', port: 9351, name: 'run-automation-ko', lang: 'ko-KR', projectDir: home, userData, env: { PYIDE_TRUST_ALL: '' } });
const kcheck = (ok, label) => k.check(ok, `[ko] ${label}`);
try {
  k.js(`ide.openProject(${q(repo)})`);
  await k.until(`document.querySelectorAll('.dialog-buttons button').length === 3`, 'trust question');
  await k.js(`(document.querySelectorAll('.dialog-buttons button')[1].click(), true)`);
  await k.until(`ide.root && ide.util.samePath(ide.root, ${q(repo)}) && ide.trusted === false`, 'opened in Safe Mode');
  const RLOG = path.join(repo, 'wlog.jsonl');
  const W = { id: 'fw-x', name: 'UI watcher', enabled: true, fileType: '*.ui', scope: 'project', scopeDir: '', program: NODE,
    args: `"${path.join(repo, 'tool.js')}" "${RLOG}" untrusted 0 0 $FileName$`, cwd: '$FileDir$', autoSave: false, external: true, showConsole: 'error' };
  await k.js(`(ide.settings.set('fileWatchers:' + ide.root, ${q([W])}), true)`);
  await openTab(k, 'ui/form.ui');
  await k.js(`(async () => { const tab = ide.findTab(ide.util.joinPath(ide.root, 'ui\\\\form.ui')); tab.model.setValue('<ui/>\\n'); await ide.saveTab(tab); return true; })()`);
  kcheck(await k.js(`!ide.isDirty(ide.findTab(ide.util.joinPath(ide.root, 'ui\\\\form.ui')))`), 'the edit was saved');
  writeFileSync(path.join(repo, 'ui', 'other.ui'), '<ui/>\n');
  await k.sleep(2500);
  kcheck(!existsSync(RLOG) && (await k.js(`ide.fileWatchers.history().length`)) === 0, 'Safe Mode: saves and changes on disk run no watcher');
  const refused = await k.js(`ide.api.invoke('fileWatchers:run', { root: ide.root, file: ide.util.joinPath(ide.root, 'ui\\\\form.ui'), program: ${q(NODE)}, args: ${q(W.args)}, cwd: '' })`);
  await k.sleep(500);
  kcheck(refused?.error === 'untrusted' && !existsSync(RLOG), `the main process refuses to start a watcher for an untrusted project (${q(refused)})`);
  const refusedTool = await k.js(`ide.api.invoke('run:startTool', { program: ${q(NODE)}, args: ${q(W.args)}, cwd: '', macros: { projectDir: ide.root } })`);
  await k.sleep(500);
  kcheck(refusedTool?.error === 'untrusted' && !existsSync(RLOG), `the main process refuses a before launch tool for an untrusted project (${q(refusedTool)})`);

  // Settings › File Watchers in Korean, with the Safe Mode warning.
  await k.js(`(ide.openSettings('fileWatchers'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'fileWatchers'`, 'File Watchers page');
  await clickSeen(k, '.fw-row[data-id="fw-x"]');
  kcheck(await k.js(`!!document.querySelector('.fw-warn')`), 'the page warns that watchers do not run in Safe Mode');
  kcheck(await k.js(`document.querySelector('.settings-nav-row[data-page="fileWatchers"]').textContent.includes('파일 감시기')`), 'the page is named 파일 감시기');
  const pageLeaks = await englishLeaks(k, '.settings-page', ['FilePath', 'FileDir', 'PyInterpreterPath', 'FileName', 'FileExt', 'FileRelativePath', 'ProjectDir', 'PyInterpreterDirectory', 'FileNameWithoutExtension', 'sass', 'src', 'scss']);
  kcheck(pageLeaks.length === 0, `File Watchers page: no English UI text ${q(pageLeaks)}`);
  await clickSeen(k, '[data-fw="add"]');
  const tplLeaks = await englishLeaks(k, '.context-menu', ['Black', 'Sass', 'pyside', 'uic', 'pyuic', 'scss', 'css']);
  kcheck(tplLeaks.length === 0, `templates menu: no English UI text ${q(tplLeaks)}`);
  await k.click('.settings-crumb');
  await k.until(`!document.querySelector('.context-menu')`, 'menu closed', 3000);
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  await k.until(`!document.querySelector('.settings-dialog')`, 'settings closed');

  // Run/Debug Configurations › Before launch in Korean, and a failure notification.
  await k.js(`(() => {
    const py = (id, name, script, params = '') => ({ id, name, type: 'python', script, params, cwd: '', env: '', envFiles: '.env', interp: '' });
    ide.run.configs().push(py('k-a', 'Dep', 'make_marker.py', 'dep.txt'), { ...py('k-b', 'Target', 'main.py'),
      beforeLaunch: [{ kind: 'config', id: 'k-a' }, { kind: 'tool', name: 'Gen', program: ${q(NODE)}, args: ${q(`"${path.join(repo, 'tool.js')}" bl.jsonl gen 0 7`)}, cwd: '' }] });
    ide.run.select('k-b');
    return true;
  })()`);
  await k.js(`(ide.run.editConfigurations('k-b'), true)`);
  await k.until(`document.querySelectorAll('.rc-bl-item').length === 2`, 'before launch rows');
  await clickSeen(k, '.rc-bl-item[data-index="1"]');
  kcheck((await k.js(`document.querySelector('.rc-bl-title').textContent`)) === '실행 전', 'the section is 실행 전');
  const NAMES = ['Dep', 'Target', 'Gen', 'FilePath', 'ProjectDir', 'FileName', 'FileNameWithoutExtension', 'FileDir', 'PyInterpreterPath', 'node', 'black'];
  const dlgLeaks = await englishLeaks(k, '.rc-dialog', NAMES);
  kcheck(dlgLeaks.length === 0, `Before launch: no English UI text ${q(dlgLeaks)}`);
  await clickSeen(k, '.rc-bl-bar [data-bl="add"]');
  const addLeaks = await englishLeaks(k, '.context-menu', NAMES);
  kcheck(addLeaks.length === 0, `Add Task menu: no English UI text ${q(addLeaks)}`);
  await clickSeen(k, '.rc-bl-title');
  await k.until(`!document.querySelector('.context-menu')`, 'menu closed', 3000);
  await k.js(`([...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === '취소').click(), true)`);
  await k.until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  await k.js(`(ide.run.runConfig(ide.run.selected()), true)`);
  await k.until(`ide.notifications.list().some((e) => e.title === "'Target'이(가) 시작되지 않았습니다")`, 'Korean failure notification', 30000);
  const kNote = await k.js(`ide.notifications.list().find((e) => e.title.startsWith("'Target'")).text`);
  kcheck(kNote.includes('실행 전 작업 실패: 외부 도구 실행: Gen') && kNote.includes('프로젝트를 신뢰하지 않습니다(안전 모드).'), `the notification is in Korean and says the tool did not run in Safe Mode (${kNote})`);
  kcheck(!existsSync(path.join(repo, 'bl.jsonl')), 'Safe Mode: the before launch tool did not start');

  // Every tr() string of the two plugins has a Korean entry.
  const mine = new Set();
  for (const plugin of ['run', 'file-watchers']) {
    const dir = path.join(APP_DIR, 'renderer', 'features', plugin);
    const ko = JSON.parse(readFileSync(path.join(dir, 'locales', 'ko.json'), 'utf8'));
    const src = readFileSync(path.join(dir, 'index.js'), 'utf8');
    for (const m of src.matchAll(/\btr\((['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      const s = m[2].replace(/\\(.)/g, '$1');
      mine.add(s);
      if (!(s in ko)) kcheck(false, `${plugin}: no Korean for ${s}`);
    }
  }
  const missing = (await missingTranslations(k)).filter((s) => mine.has(s));
  kcheck(missing.length === 0, `no missing translations at run time ${q(missing)}`);
  kcheck(k.consoleErrors.length === 0, `no renderer exceptions${k.consoleErrors.length ? ` ${q(k.consoleErrors)}` : ''}`);
} catch (err) {
  kcheck(false, err.message);
  await k.shot('failure.png');
}
k.close();
const results = [...t.results, ...k.results];
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
