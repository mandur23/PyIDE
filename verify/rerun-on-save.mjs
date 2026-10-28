// Rerun on Save (rerun-on-save plugin): a toggle in a script's Run tab, off by default; while it is on, saving a file
// of the project stops the run that is still going and starts it again, saves close together give one run, a test tab
// keeps its own Auto-test instead, and opening another project turns it off. Port 9796.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile, processSnapshot } from './lib.mjs';

const S = JSON.stringify;
const project = mkdtempSync(path.join(tmpdir(), 'pyide-rerun-on-save-'));
const log = path.join(project, 'runs.log');
// Each run notes its start, then stays alive like a server or a long script.
writeFileSync(path.join(project, 'app.py'), `import os, time\nwith open(${S(log)}, 'a') as f:\n    f.write('start %d\\n' % os.getpid())\nprint('MESSAGE = hello', flush=True)\ntime.sleep(60)\n`);
writeFileSync(path.join(project, 'settings.py'), 'MESSAGE = "hello"\n');
writeFileSync(path.join(project, 'test_app.py'), 'def test_ok():\n    assert True\n');
mkdirSync(path.join(project, 'build'));
writeFileSync(path.join(project, 'build', 'notes.txt'), '');

const t = await launch({ name: 'rerun-on-save', port: 9796, projectDir: project });
const { js, until, check, press, sleep, shot } = t;
const runs = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const untilRuns = async (n, label, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (runs() >= n) return;
  throw new Error(`timeout waiting for: ${label} (${runs()} runs)`);
};
const toggle = () => js(`document.querySelector('#bottomActions button[data-action="rerunOnSave"]')?.getAttribute('aria-pressed') ?? null`);
const badge = () => js(`(() => { const b = document.querySelector('.run-tab.active .run-tab-rerun-on-save'); return !!b && !b.classList.contains('hidden') && b.textContent; })()`);
const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
const edit = async (f, text) => {
  await js(`(ide.getDocument(${P(f)}).model.setValue(${S(text)}), true)`);
  await js(`ide.saveTab(ide.findTab(${P(f)})).then(() => true)`);
};
try {
  await openFile(t, 'app.py');
  await press('Shift+F10');
  await untilRuns(1, 'first run');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'app'`, 'Run tab');
  check(await toggle() === 'false', 'a script Run tab has a Rerun on Save toggle, off by default');
  check(await js(`ide.actions.some((a) => a.id === 'ToggleRerunOnSave')`), 'Rerun on Save is an action (Run menu, Find Action)');

  await openFile(t, 'settings.py');
  await edit('settings.py', 'MESSAGE = "off"\n');
  await sleep(2000);
  check(runs() === 1, `while it is off a save runs nothing (${runs()} runs)`);

  await js(`(document.querySelector('#bottomActions button[data-action="rerunOnSave"]').click(), true)`);
  check(await toggle() === 'true' && await badge() === 'On save', `turned on, the tab is marked (${await badge()})`);
  await shot('rerun-on-save.png');

  const firstPid = readFileSync(log, 'utf8').trim().split(' ')[1];
  await edit('settings.py', 'MESSAGE = "one"\n');
  await untilRuns(2, 'rerun after a save');
  check(true, 'saving a project file reruns the configuration');
  await sleep(500);
  check(!processSnapshot().some((p) => p.pid === Number(firstPid) && /python/i.test(p.name)), 'the run that was going is stopped first');
  check(await js(`ide.run.activeSession().running`), 'the new run is going');

  await edit('settings.py', 'MESSAGE = "two"\n');
  await sleep(150);
  await edit('settings.py', 'MESSAGE = "three"\n');
  await sleep(150);
  await edit('settings.py', 'MESSAGE = "four"\n');
  await untilRuns(3, 'one rerun for three saves');
  await sleep(2500);
  check(runs() === 3, `three saves close together give one rerun (${runs()} runs)`);

  // Rerun by hand with an unsaved edit: its Save All must not arm a second run.
  await js(`(ide.getDocument(${P('settings.py')}).model.setValue('MESSAGE = "by hand"\\n'), true)`);
  const beforeManual = runs();
  await js(`(ide.runAction('Rerun'), true)`);
  await until(`[...document.querySelectorAll('.dialog-buttons button')].some((b) => b.textContent === 'Stop and Rerun')`, 'rerun question');
  await js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Stop and Rerun').click()`);
  await untilRuns(beforeManual + 1, 'manual rerun');
  await sleep(2500);
  check(runs() === beforeManual + 1, `a Rerun by hand with unsaved edits runs once (${runs() - beforeManual} runs)`);

  await openFile(t, 'build/notes.txt');
  await edit(path.join('build', 'notes.txt'), 'output\n');
  await sleep(2000);
  check(runs() === beforeManual + 1, `a save in the project's top-level build folder reruns nothing (${runs()} runs)`);

  await js(`(ide.run.sessions().find((s) => s.title === 'app').select(), document.querySelector('#bottomActions button[data-action="rerunOnSave"]').click(), true)`);
  await openFile(t, 'settings.py');
  await edit('settings.py', 'MESSAGE = "off again"\n');
  await sleep(2000);
  check(runs() === beforeManual + 1 && await toggle() === 'false' && !(await badge()), `turned off again, saves run nothing (${runs()} runs)`);

  await openFile(t, 'test_app.py');
  await js(`(ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await press('Ctrl+Shift+F10');
  await until(`/pytest/.test(document.querySelector('.run-tab.active .run-tab-title')?.textContent || '')`, 'test tab', 30000);
  await sleep(500);
  check(await toggle() === null && await js(`!!document.querySelector('#bottomActions button[data-action="autoTest"]')`), 'a test tab has Auto-test instead');

  await js(`ide.run.sessions().find((s) => s.title === 'app').select()`);
  await js(`(document.querySelector('#bottomActions button[data-action="rerunOnSave"]').click(), true)`);
  check(await toggle() === 'true', 'back on in the script tab');
  await js(`ide.run.sessions().forEach((s) => s.stop())`);
  await until(`ide.run.sessions().every((s) => !s.running)`, 'runs stopped', 15000);
  const other = mkdtempSync(path.join(tmpdir(), 'pyide-rerun-on-save-other-'));
  await js(`ide.openProject(${S(other)}).then(() => true)`);
  await until(`ide.util.samePath(ide.root, ${S(other)})`, 'other project open', 30000);
  check(await js(`ide.run.sessions().length > 0 && ide.run.sessions().every((s) => !ide.rerunOnSave.enabled(s))`), 'opening another project turns it off');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
await js(`ide.run.sessions().forEach((s) => s.stop())`).catch(() => {});
t.finish();
