// Files changed outside PyIDE (git pull in a terminal, a script, another editor): the project watcher reloads an
// unmodified open document and shows new files in the tree (also outside Git); saving a document that changed both in
// the editor and on disk asks (File Cache Conflict) and each answer does what it says.
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'core', port: 9886, name: 'external-changes' });
const { js, until, press, type, check, sleep } = t;
const p = (f) => path.join(t.project, f);
const disk = (f) => readFileSync(p(f), 'utf8');
const dialogTitle = () => js(`document.querySelector('.dialog-title')?.textContent || ''`);
const clickButton = (label) => js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${JSON.stringify(label)}).click(), true)`);
try {
  // ---------- an unmodified open file follows the disk, without any focus change ----------
  await openFile(t, 'hello.py');
  writeFileSync(p('hello.py'), 'print("changed outside")\n');
  await until(`ide.editor.getModel().getValue() === 'print("changed outside")\\n'`, 'reloaded by the watcher', 10000);
  check(!(await js(`ide.isDirty(ide.activeTab())`)), 'an unmodified open file reloads when it changes on disk, and stays unmodified');

  // ---------- own saves do not ask ----------
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await type('# mine\n');
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'saved');
  await type('# again\n');
  await sleep(1200); // the watcher reports the first save meanwhile
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'saved again');
  check((await dialogTitle()) === '' && disk('hello.py').startsWith('# mine\n# again\n'), 'saving twice in a row writes without asking (PyIDE\'s own writes are not conflicts)');

  // ---------- changed in the editor and on disk ----------
  const conflict = async (answer) => {
    await openFile(t, 'broken.py');
    await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await type(`# editor ${answer}\n`);
    writeFileSync(p('broken.py'), `OUTSIDE_${answer.replace(/\W/g, '')} = 1\n`);
    await sleep(1200);
    check((await js(`ide.editor.getModel().getValue()`)).startsWith(`# editor ${answer}`), `${answer}: the editor keeps its unsaved text when the file changes on disk`);
    await press('Ctrl+S');
    await until(`document.querySelector('.dialog-title')?.textContent === 'File Cache Conflict'`, `${answer}: conflict dialog`, 8000);
    await clickButton(answer);
    await until(`!document.querySelector('.dialog-title')`, `${answer}: dialog closed`);
    await sleep(500);
  };
  await conflict('Cancel');
  check(disk('broken.py') === 'OUTSIDE_Cancel = 1\n' && await js(`ide.isDirty(ide.activeTab())`), 'Cancel writes nothing and keeps the edit');
  await js(`(ide.editor.getModel().setValue(${JSON.stringify(disk('broken.py'))}), true)`);
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'reset');
  await conflict('Keep Memory Changes');
  check(disk('broken.py').startsWith('# editor Keep Memory Changes') && !(await js(`ide.isDirty(ide.activeTab())`)), 'Keep Memory Changes writes the editor text');
  await conflict('Show Difference');
  await until(`!!ide.compare.view()`, 'the difference opens in a diff tab');
  const sides = await js(`(() => { const d = ide.compare.view().diff; return { left: d.getOriginalEditor().getValue(), right: d.getModifiedEditor().getValue(), editable: !d.getModifiedEditor().getOption(ide.monaco.editor.EditorOption.readOnly) }; })()`);
  check(sides.left === 'OUTSIDE_ShowDifference = 1\n' && sides.right.startsWith('# editor Show Difference') && sides.editable && disk('broken.py') === 'OUTSIDE_ShowDifference = 1\n',
    `Show Difference opens the disk text against the editor's, writes nothing, and the editor side stays editable (${JSON.stringify(sides)})`);
  await js(`(ide.closeTab(ide.activeTab().path, true), true)`);
  await until(`ide.activeTab()?.title === 'broken.py'`, 'back to broken.py');
  await conflict('Load File System Changes');
  check(disk('broken.py') === 'OUTSIDE_LoadFileSystemChanges = 1\n' && await js(`ide.editor.getModel().getValue()`) === 'OUTSIDE_LoadFileSystemChanges = 1\n'
    && !(await js(`ide.isDirty(ide.activeTab())`)), 'Load File System Changes replaces the editor text with the disk text');

  // ---------- the tree follows the disk in a project without Git ----------
  writeFileSync(p('made_outside.py'), 'X = 1\n');
  await until(`[...document.querySelectorAll('#tree .node .name')].some(n => n.textContent === 'made_outside.py')`, 'new file in tree', 10000);
  check(true, 'a file created outside appears in the tree (no Git repository)');
  unlinkSync(p('made_outside.py'));
  await until(`![...document.querySelectorAll('#tree .node .name')].some(n => n.textContent === 'made_outside.py')`, 'deleted file leaves tree', 10000);
  check(true, 'a file deleted outside leaves the tree');

  // ---------- an open file deleted outside ----------
  writeFileSync(p('gone.py'), 'G = 1\n');
  await openFile(t, 'gone.py');
  const goneTab = `[...document.querySelectorAll('.tab')].find(n => n.textContent.includes('gone.py'))`;
  const goneNotes = `ide.notifications.list().filter(e => e.text.includes('gone.py was deleted outside the IDE')).length`;
  unlinkSync(p('gone.py'));
  await until(`${goneTab}?.classList.contains('gone')`, 'the tab of a deleted file is marked', 10000);
  const struck = await js(`getComputedStyle(${goneTab}.querySelector('.name')).textDecorationLine`);
  check(struck === 'line-through' && (await js(`${goneTab}.title`)).includes('deleted on disk'), `the tab of a file deleted outside is struck through and says so (${struck})`);
  await js(`window.dispatchEvent(new Event('focus'))`);
  await sleep(1500);
  check(await js(goneNotes) === 1, 'the user is told once, not again on the next check');
  writeFileSync(p('gone.py'), 'G = 1\n');
  await until(`!${goneTab}?.classList.contains('gone')`, 'the file came back', 10000);
  check(true, 'a deleted file that comes back is shown as a normal tab again');
  await js(`(ide.closeTab(${JSON.stringify(p('gone.py'))}, true), true)`);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
t.finish();
