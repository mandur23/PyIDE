// What a project had open comes back: after quitting (and after a crash, from the last write) the file tabs in their
// editor groups, the active file, the caret and scroll, a pinned tab, the tool windows and their sizes return, without
// a file that has gone; a file named on the command line ends up in front; another project keeps its own; leaving a project and opening it again brings them back too.
// Ports 9662-9664.
import { rmSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;
const state = (t) => t.js(`(() => {
  const name = (p) => p && ide.util.basename(p);
  const left = document.getElementById('sidePanel');
  return {
    groups: ide.groups().map((g) => ({ tabs: g.tabs.filter((x) => x.path).map((x) => name(x.path)), active: name(g.active?.path) })),
    active: name(ide.activeTab()?.path),
    caret: ide.editor.getPosition(),
    pinned: ide.groups().flatMap((g) => g.tabs).filter((x) => x.pinned).map((x) => name(x.path)),
    todo: ide.toolWindows.get('TODO').isVisible(),
    width: left.style.width,
    side: !left.classList.contains('hidden'),
  };
})()`);
const quit = async (t) => {
  // A window that closes at once never answers the call that closed it.
  await t.js(`(ide.api.invoke('window:closeNow'), true)`).catch((e) => { if (!/the CDP connection closed/.test(e.message)) throw e; });
  for (let i = 0; i < 100; i++) {
    try { process.kill(t.pid, 0); } catch { return; }
    await t.sleep(100);
  }
  t.close();
};
const file = (t, name) => path.join(t.project, name);

let a;
let b;
let c;
try {
  a = await launch({ fixture: 'core', port: 9662, name: 'session' });
  writeFileSync(file(a, 'gone.py'), 'x = 1\n');
  await a.js(`ide.openFile(${q(file(a, 'gone.py'))})`);
  await a.js(`ide.openFile(${q(file(a, 'broken.py'))})`);
  await a.js(`ide.openFile(${q(path.join(a.project, 'pkg', 'util.py'))}, { group: 'right' })`);
  await a.until(`ide.groups().length === 2`, 'a second editor group');
  await a.js(`ide.openFile(${q(file(a, 'hello.py'))}, { line: 10, col: 5, group: 'right' })`);
  await a.js(`ide.openFile(${q(file(a, 'hello.py'))}, { line: 10, col: 5 })`);
  await a.js(`(ide.runAction('PinActiveTab'), true)`);
  await a.js(`(ide.toolWindows.get('TODO').show(), document.getElementById('sidePanel').style.width = '333px', true)`);
  await a.sleep(300);
  const before = await state(a);
  check(before.groups.length === 2 && before.active === 'hello.py' && before.caret.lineNumber === 10 && before.pinned.includes('hello.py') && before.todo, `the session to restore (${q(before)})`);
  await quit(a);

  rmSync(file(a, 'gone.py'));
  b = await launch({ fixture: 'core', port: 9663, name: 'session-2', userData: a.userData, projectDir: a.project });
  await b.until(`ide.tabs.some((t) => t.path?.endsWith('hello.py')) && ide.toolWindows.get('TODO').isVisible()`, 'the tabs to come back', 20000);
  await b.sleep(800);
  const after = await state(b);
  const names = after.groups.flatMap((g) => g.tabs);
  check(after.groups.length === 2 && q(after.groups.map((g) => g.active)) === q(before.groups.map((g) => g.active)), `the editor groups come back with their active files (${q(after.groups)})`);
  check(names.includes('broken.py') && names.includes('util.py') && names.includes('hello.py'), 'the open files come back');
  check(!names.includes('gone.py') && !(await b.js(`!!document.querySelector('.dialog')`)), 'a file that has gone is left out, without a message');
  check(after.active === 'hello.py' && after.caret.lineNumber === 10 && after.caret.column === 5, `the active file and its caret come back (${q({ active: after.active, caret: after.caret })})`);
  check(after.pinned.includes('hello.py'), 'a pinned tab stays pinned');
  check(after.todo && after.width === '333px', `the tool windows and their sizes come back (${after.width})`);
  check(!(await b.js(`ide.isDirty(ide.activeTab())`)), 'nothing is left modified');

  await quit(b);
  b = await launch({ fixture: 'core', port: 9663, name: 'session-file', userData: a.userData, projectDir: a.project, open: 'broken.py' });
  check(await b.js(`ide.tabs.some((t) => t.path?.endsWith('hello.py')) && ide.activeTab()?.path?.endsWith('broken.py')`), 'at ready the tabs are back, and a file named on the command line is in front');

  await b.js(`(ide.runAction('WorkspaceHome'), true)`);
  await b.until(`ide.activeTab()?.path === 'workspace:home'`, 'the Workspace tab');
  await b.sleep(1300);
  await quit(b);
  b = await launch({ fixture: 'core', port: 9663, name: 'session-home', userData: a.userData, projectDir: a.project });
  await b.until(`ide.activeTab()?.path === 'workspace:home'`, 'the Workspace tab in front again', 10000);
  check(await b.js(`ide.tabs.some((t) => t.path?.endsWith('hello.py'))`), 'a project left on the Workspace tab comes back on it, with its files');
  await b.js(`(ide.closeTab(${q(file(a, 'broken.py'))}, true), true)`);
  await b.sleep(1300);
  check(!(await b.js(`ide.settings.get('project.session')[ide.util.pathKey(ide.root)].groups.flatMap((g) => g.tabs).some((t) => t.path.endsWith('broken.py'))`)), 'a closed tab leaves the record: saving goes on after a project change was asked for');

  const other = tempDir('session-other');
  writeFileSync(path.join(other, 'other.py'), 'y = 2\n');
  await b.js(`ide.openProject(${q(other)})`);
  await b.until(`ide.root === ${q(other)} && !ide.tabs.some((t) => t.path?.endsWith('hello.py'))`, 'the other project');
  await b.js(`ide.openFile(${q(path.join(other, 'other.py'))})`);
  await b.sleep(1300);
  await b.js(`ide.openProject(${q(a.project)})`);
  await b.until(`ide.tabs.some((t) => t.path?.endsWith('hello.py'))`, 'the first project again', 20000);
  await b.sleep(800);
  const back = await state(b);
  check(back.groups.flatMap((g) => g.tabs).includes('hello.py') && !back.groups.flatMap((g) => g.tabs).includes('other.py'), `leaving a project and coming back restores its own tabs (${q(back.groups)})`);
  await b.js(`ide.openProject(${q(other)})`);
  await b.until(`ide.tabs.some((t) => t.path?.endsWith('other.py'))`, 'the other project\'s own tab', 20000);
  check(true, 'the other project keeps its own tabs');

  await b.js(`ide.openFile(${q(path.join(other, 'other.py'))}, { line: 1 })`);
  await b.js(`(ide.closeTab(${q(path.join(other, 'other.py'))}, true), true)`);
  await b.sleep(1300);
  b.close();
  c = await launch({ fixture: 'core', port: 9664, name: 'session-3', userData: a.userData, projectDir: other });
  await c.sleep(1200);
  check(!(await c.js(`ide.tabs.some((t) => t.path?.endsWith('other.py'))`)), 'a tab closed before a crash stays closed: the session is written as the tabs change');
  check(!b.consoleErrors.length && !c.consoleErrors.length, `no renderer exceptions (${q([...b.consoleErrors, ...c.consoleErrors])})`);
} catch (err) {
  check(false, err.stack || String(err));
} finally {
  c?.close();
  b?.close();
  a?.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
