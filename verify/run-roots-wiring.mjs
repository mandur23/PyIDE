// The source roots beyond Run and tests (verify/run-roots.mjs): Debug of a file and the Python Console import from the
// src layout's root, and Go to File, the semantic index, Find in Files, TODO and Go to Symbol leave out a folder marked
// Excluded.
import { writeFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';

const t = await launch({ fixture: 'run-roots', port: 9593, name: 'run-roots-wiring' });
const { js, until, check } = t;
try {
  await until(`ide.projectRoots && ide.projectRoots.get().sources.includes('src')`, 'src detected as a source root', 20000);

  await js(`(ide.debugger.debugFile(ide.util.joinPath(ide.root, 'use_src.py')), true)`);
  // A failed import suspends at the uncaught exception instead of printing.
  await until(`(document.querySelector('#dbgOut')?.textContent || '').includes('SRC 5') || !!ide.debugger.stopped()`, 'debug use_src.py', 40000);
  check((await js(`document.querySelector('#dbgOut').textContent`)).includes('SRC 5'),
    `Debug (debugger.debugFile, as Shift+F9 on the file): src is on PYTHONPATH${(await js(`ide.debugger.stopped()?.text || ''`)) ? ` (stopped: ${await js(`ide.debugger.stopped().text`)})` : ''}`);
  if (await js(`ide.debugger.isActive()`)) await js(`(ide.runAction('StopDebug'), true)`);
  await until(`!ide.debugger.isActive()`, 'debug session over', 15000);

  await js(`ide.toolWindows.get('PythonConsole').show()`);
  await until(`ide.pyconsole.isRunning()`, 'console started', 30000);
  await js(`ide.pyconsole.execute("import mypkg.core as m; print('CONSOLE', m.add(4, 5))")`);
  await until(`/CONSOLE 9|Error/.test(document.querySelector('#pyconsoleOut').textContent)`, 'console output', 20000);
  check((await js(`document.querySelector('#pyconsoleOut').textContent`)).includes('CONSOLE 9'), 'the Python Console has the source root on sys.path');

  writeFileSync(path.join(t.project, 'generated', 'todo_junk.py'), '# TODO junk_todo_q7\n');
  const rel = (list) => JSON.stringify(list.map((p) => p.replace(/\\/g, '/')));
  const findJunk = (dir) => js(`ide.api.invoke('search:find', ide.root, { query: 'junk_only_symbol_q7', dir: ${dir ? `ide.util.joinPath(ide.root, '${dir}')` : 'null'} }, {}, {})
    .then((r) => r.files.map((f) => f.path.slice(ide.root.length + 1)))`).then(rel);
  const todoFiles = () => js(`ide.api.invoke('search:todos', ide.root, {}).then((r) => r.files.map((f) => f.path.slice(ide.root.length + 1)))`).then(rel);
  const symbolFiles = () => js(`ide.api.invoke('search:symbols', ide.currentInterp(), ide.root)
    .then((l) => l.filter((s) => s.name === 'junk_only_symbol_q7').map((s) => s.path.slice(ide.root.length + 1)))`).then(rel);
  const todoWindowLists = `[...document.querySelectorAll('#snTodo [data-path]')].some((g) => g.dataset.path.includes('todo_junk.py'))`;
  const JUNK = rel(['generated/junk_mod.py']);
  check((await findJunk()) === JUNK, 'Find in Files finds generated/junk_mod.py before the folder is excluded');
  check((await todoFiles()).includes('generated/todo_junk.py'), 'TODO lists generated/todo_junk.py before');
  check((await symbolFiles()) === JUNK, 'the Go to Symbol index has junk_only_symbol_q7 before');
  await js(`(ide.toolWindows.get('TODO').show(), true)`);
  await until(todoWindowLists, 'the TODO window lists todo_junk.py', 20000);
  const before = await js(`ide.api.walk(ide.root).then((f) => f.map((p) => p.slice(ide.root.length + 1)))`);
  check(before.includes('generated\\junk_mod.py'), 'Go to File lists generated\\junk_mod.py before the folder is excluded');
  const indexed = `ide.api.invoke('semantic:indexInfo', ide.root).then((i) => !i.indexing && i.heavy.some((h) => h.rel === 'generated'))`;
  await until(indexed, 'generated indexed by the semantic index (fake backend)', 60000);
  await js(`ide.projectRoots.mark(ide.util.joinPath(ide.root, 'generated'), 'excluded')`);
  const after = await js(`ide.api.walk(ide.root).then((f) => f.map((p) => p.slice(ide.root.length + 1)))`);
  check(!after.some((p) => p.startsWith('generated\\')) && after.includes('use_src.py'), 'Go to File leaves out the files of an Excluded folder');
  await until(`ide.api.invoke('semantic:indexInfo', ide.root).then((i) => !i.indexing && i.files > 0 && !i.heavy.some((h) => h.rel === 'generated'))`, 'generated left the semantic index', 30000);
  check(true, 'the semantic index drops the files of an Excluded folder');
  check((await findJunk()) === '[]', 'Find in Files leaves out an Excluded folder');
  check((await findJunk('generated')) === JUNK, 'but searches it when it is the directory chosen');
  check(!(await todoFiles()).includes('todo_junk.py'), 'TODO leaves it out');
  check((await symbolFiles()) === '[]', 'the Go to Symbol index drops its symbols');
  await until(`!${todoWindowLists}`, 'the TODO window drops todo_junk.py', 10000);
  check(true, 'the shown TODO window drops it at once (projectRootsChanged)');
  await js(`ide.projectRoots.mark(ide.util.joinPath(ide.root, 'generated'), null)`);
  check((await findJunk()) === JUNK && (await symbolFiles()) === JUNK, 'Cancel Exclusion brings it back to Find in Files and Go to Symbol');
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
