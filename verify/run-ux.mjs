// The Run tool window as a beginner meets it: closed on a project's first open and opened by the first run, the user's
// choice back on the next start; running a file leaves a temporary configuration in the run widget's menu (and a new
// Python configuration is named after its script); the tab shown is always scrolled into view and finished tabs do not
// pile up; a finished run's input box looks closed; output past the console's buffer says that earlier lines were
// dropped; and a project with no virtual environment says once, under its first run, that it runs on the system
// Python, with Create Virtual Environment…. Ports 9953-9954.
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const S = JSON.stringify;
const userData = tempDir('run-ux-ud');
const t = await launch({ fixture: 'core', port: 9953, name: 'run-ux', userData });
const { js, until, check, click, sleep } = t;
const out = () => js(`ide.run.activeSession()?.con?.out?.textContent || ''`);
const finished = (name) => until(`ide.run.sessions().some((s) => s.title === ${S(name)} && !s.running && !s.starting) && (ide.run.activeSession()?.con?.out?.textContent || '').includes('exit code')`, `${name} finished`, 60000);
const menuLabels = () => js(`[...document.querySelectorAll('.context-menu .menu-label')].map((l) => l.textContent)`);
const closeMenu = async () => { await t.press('Escape'); await until(`!document.querySelector('.context-menu')`, 'menu closed'); };

try {
  // ---------- the bottom panel on a project's first open ----------
  await sleep(1500);
  const first = await js(`({ run: ide.toolWindows.get('Run').isVisible(), panel: !document.getElementById('bottom').classList.contains('hidden') })`);
  check(!first.run && !first.panel, `a project opened for the first time does not show an empty Run window (${S(first)})`);

  for (let i = 1; i <= 8; i++) writeFileSync(path.join(t.project, `job${i}.py`), `print('job ${i} ran')\n`);
  writeFileSync(path.join(t.project, 'ask.py'), "name = input('Name? ')\nprint('hi', name)\n");
  await openFile(t, 'job1.py');
  await js(`(ide.run.runCurrentFile(), true)`);
  await finished('job1');
  check(await js(`ide.toolWindows.get('Run').isVisible()`), 'the first run opens the Run window');

  // ---------- system Python, once ----------
  const note = await out();
  const link = await js(`[...ide.run.activeSession().con.out.querySelectorAll('.console-actions a')].map((a) => a.textContent)`);
  check(/This project has no virtual environment/.test(note) && S(link) === S(['Create Virtual Environment…']),
    `a project without a virtual environment says, under its first run, that it runs on the system Python (${S(note.slice(-220))}, ${S(link)})`);
  await click('.run-session:not(.hidden) .console-actions a');
  await until(`[...document.querySelectorAll('#dialogHost .dialog-title')].some((n) => n.textContent === 'Create Virtual Environment')`, 'venv dialog', 8000)
    .then(() => check(true, 'its link opens Create Virtual Environment'), () => check(false, 'its link opens Create Virtual Environment'));
  await t.press('Escape');
  await js(`(ide.run.runCurrentFile(), true)`);
  await sleep(500);
  await finished('job1');
  check(!/no virtual environment/.test(await out()), 'the next run does not say it again');

  // ---------- temporary configuration ----------
  const temps = await js(`ide.run.configs().filter((c) => c.temporary).map((c) => ({ name: c.name, script: c.script }))`);
  check(temps.length === 1 && temps[0].name === 'job1' && /job1\.py$/.test(temps[0].script), `running the file left a temporary configuration for it (${S(temps)})`);
  await click('.run-target');
  await until(`!!document.querySelector('.context-menu')`, 'run target menu');
  const targets = await menuLabels();
  check(targets.includes('job1') && targets.includes('Current File') && targets.includes('Edit Configurations…'), `the run widget's menu lists it beside Current File (${S(targets)})`);
  check(await js(`document.querySelector('.run-target-name').textContent`) === 'Current File', 'Current File stays selected');
  await closeMenu();
  await js(`(ide.run.editConfigurations(), true)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'Edit Configurations');
  check(await js(`[...document.querySelectorAll('.rc-item')].some((n) => n.textContent === 'job1' && n.classList.contains('temporary'))`), 'Edit Configurations shows it, marked temporary, to edit or save');
  await click('.rc-tool[data-tool="add"]');
  await until(`[...document.querySelectorAll('.context-menu .menu-label')].some((l) => l.textContent === 'Python')`, 'add menu');
  await js(`([...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Python').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  await until(`document.querySelectorAll('.rc-item').length === 2 && !document.querySelector('.rc-item.selected')?.classList.contains('temporary')`, 'new configuration form');
  const named = await js(`({ name: document.querySelector('.rc-form input[data-key="name"]').value, script: document.querySelector('.rc-form input[data-key="script"]').value })`);
  check(named.name === 'job1' && /job1\.py$/.test(named.script), `a new Python configuration filled in with the open script is named after it (${S(named)})`);
  await js(`([...document.querySelectorAll('#dialogHost .dialog-buttons button')].find((b) => b.textContent === 'Cancel').click(), true)`);
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');

  // ---------- many runs: the active tab in view, finished tabs capped ----------
  for (let i = 2; i <= 8; i++) {
    await openFile(t, `job${i}.py`);
    await js(`(ide.run.runCurrentFile(), true)`);
    await finished(`job${i}`);
  }
  const bar = await js(`(() => { const b = document.querySelector('.run-tabs').getBoundingClientRect(); const a = document.querySelector('.run-tab.active').getBoundingClientRect();
    return { tabs: document.querySelectorAll('.run-tab').length, active: document.querySelector('.run-tab.active .run-tab-title').textContent, inside: a.left >= b.left - 1 && a.right <= b.right + 1 }; })()`);
  check(bar.active === 'job8' && bar.inside, `after 8 runs the newest tab is the active one and is scrolled into view (${S(bar)})`);
  check(bar.tabs <= 6, `finished tabs do not pile up: ${bar.tabs} tabs for 8 runs`);
  check((await js(`ide.run.configs().filter((c) => c.temporary).length`)) <= 5, 'at most five temporary configurations are kept');
  await js(`(() => { const r = document.querySelector('.run-tab.active').getBoundingClientRect(); document.querySelector('.run-tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 })); return true; })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tab menu');
  const tabMenu = await menuLabels();
  check(tabMenu.includes('Close All Finished Tabs'), `a Run tab's menu offers Close All Finished Tabs (${S(tabMenu)})`);
  await js(`([...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Close All Finished Tabs').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  await until(`document.querySelectorAll('.run-tab').length === 0`, 'finished tabs closed', 5000)
    .then(() => check(true, 'Close All Finished Tabs closes them'), () => check(false, 'Close All Finished Tabs closes them'));

  // ---------- the input box of a finished run ----------
  await openFile(t, 'ask.py');
  await js(`(ide.run.runCurrentFile(), true)`);
  await until(`(ide.run.activeSession()?.con?.out?.textContent || '').includes('Name?') && !document.getElementById('runIn')?.disabled`, 'ask.py waiting', 30000);
  const live = await js(`(() => { const i = document.getElementById('runIn'); return { bg: getComputedStyle(i).backgroundColor, ph: i.placeholder }; })()`);
  await js(`(document.getElementById('runIn').focus(), true)`);
  await t.type('Kim');
  await t.press('Enter');
  await finished('ask');
  const dead = await js(`(() => { const i = document.getElementById('runIn'); return { disabled: i.disabled, bg: getComputedStyle(i).backgroundColor, ph: i.placeholder }; })()`);
  check(dead.disabled && dead.bg !== live.bg && /finished/.test(dead.ph) && dead.ph !== live.ph,
    `after the run ends its input box looks closed and says why (${S({ live, dead })})`);

  // ---------- output beyond the console's buffer ----------
  writeFileSync(path.join(t.project, 'flood.py'), 'for i in range(200000):\n    print(f"line {i}")\n');
  await openFile(t, 'flood.py');
  await js(`(ide.run.runCurrentFile(), true)`);
  await finished('flood');
  const head = await js(`(() => { const o = ide.run.activeSession().con.out; return { cls: o.firstElementChild?.className, first: o.firstElementChild?.textContent, text: o.textContent.slice(0, 200) }; })()`);
  check(head.cls === 'console-dropped' && /Earlier output was dropped/.test(head.first) && /1024 KB/.test(head.first), `a run that printed more than the console keeps starts with a line saying earlier output was dropped (${S(head)})`);
  check(/line 199999/.test(await out()), 'the latest output is still there');

  // Saved with the tabs: the next start comes back with the Run window open, as the user left it.
  await openFile(t, 'hello.py');
  await sleep(1800);
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.close();

const again = await launch({ fixture: 'core', port: 9954, name: 'run-ux-again', userData, projectDir: t.project });
try {
  await again.sleep(2500);
  again.check(await again.js(`ide.toolWindows.get('Run').isVisible()`), 'reopened, the project keeps the Run window the user had open');
} catch (err) {
  again.check(false, err.message);
}
again.results.unshift(...t.results);
again.finish();
