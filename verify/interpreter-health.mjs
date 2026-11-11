// The project interpreter that is gone or does not start is not swapped for another Python behind the user's back:
// it stays selected as invalid, a notification says which and why and offers Choose Interpreter… and Recreate .venv,
// and the venv bar counts a broken .venv as missing. Interpreters older than Python 3.8 are marked unsupported and
// selecting one says what will not work. Port 9274.
import { execFileSync } from 'child_process';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const q = JSON.stringify;
const project = tempDir('interp-health-project');
writeFileSync(path.join(project, 'main.py'), 'print("hello")\n');
writeFileSync(path.join(project, 'requirements.txt'), '# no dependencies yet\n');
const venv = path.join(project, '.venv');
const venvPy = path.join(venv, 'Scripts', 'python.exe');
execFileSync('py', ['-3', '-m', 'venv', '--without-pip', venv]);
const cfg = path.join(venv, 'pyvenv.cfg');
writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^home = .*$/m, 'home = C:\\Python-uninstalled-311'));
const userData = tempDir('interp-health-ud');
writeFileSync(path.join(userData, 'settings.json'), q({ [`interpreter.${project}`]: venvPy, 'appearance.theme': 'dark' }));

const t = await launch({ fixture: 'core', port: 9274, name: 'interpreter-health', projectDir: project, userData });
const { js, until, check, sleep } = t;
const TITLE = 'Invalid Python interpreter selected for the project';
const invalidNotes = () => js(`ide.notifications.list().filter((n) => n.title === ${q(TITLE)}).map((n) => ({ text: n.text, actions: (n.actions || []).map((a) => a.label) }))`);
const lastDialog = `[...document.querySelectorAll('.dialog')].pop()`;

try {
  // ---------- a venv whose base Python is gone ----------
  await until(`ide.notifications.list().some((n) => n.title === ${q(TITLE)})`, 'invalid interpreter notification', 20000).catch(() => {});
  const notes = await invalidNotes();
  check(notes.length === 1 && notes[0].text.includes(venvPy) && /does not start: .*Python-uninstalled-311/.test(notes[0].text) && !notes[0].text.includes('???'),
    `a notification names the interpreter and why it does not start (${q(notes[0]?.text)})`);
  check(q(notes[0]?.actions) === q(['Choose Interpreter…', 'Recreate .venv']), `it offers Choose Interpreter… and Recreate .venv (${q(notes[0]?.actions)})`);
  const sel = await js(`({ current: ide.currentInterp(), label: document.getElementById('statusInterpLabel').textContent, saved: ide.settings.get(${q(`interpreter.${project}`)}), invalid: ide.interps.filter((i) => i.invalid).map((i) => i.executable) })`);
  check(sel.current === null && /Invalid/.test(sel.label) && sel.saved === venvPy && sel.invalid.length === 1,
    `no other Python takes its place: no current interpreter, the status bar says invalid, the setting is kept (${q(sel)})`);
  await js(`ide.openFile(${q(path.join(project, 'main.py'))})`);
  await until(`ide.activeTab()?.title === 'main.py'`, 'main.py open');
  await js(`(ide.runAction('RunClass'), true)`);
  const refused = await until(`document.body.textContent.includes('No Python interpreter found.')`, 'run refused', 8000).then(() => true, () => false);
  check(refused, 'Run does not start main.py with another Python');
  await until(`!document.querySelector('#venvBar').classList.contains('hidden')`, 'venv bar', 15000).catch(() => {});
  const bar = await js(`({ text: document.querySelector('#venvBar').textContent, actions: [...document.querySelectorAll('#venvBar [data-action]')].map((a) => a.dataset.action) })`);
  check(/does not work/.test(bar.text) && bar.actions.includes('recreate'), `the venv bar treats the broken .venv as missing and offers to recreate it (${q(bar)})`);

  // Recreate .venv: the broken one goes to the Recycle Bin (here: renamed beside it) and a new one is made and selected.
  await js(`(ide.api.trash = (p) => ide.api.rename(p, p + '-broken'), true)`);
  await t.click('#venvBar [data-action="recreate"]');
  await until(`${lastDialog}?.textContent.includes('Recycle Bin')`, 'recreate confirmation');
  await js(`([...${lastDialog}.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Recreate').click(), true)`);
  await until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(venvPy)})`, 'recreated venv selected', 120000);
  check(true, 'Recreate .venv makes a working .venv and selects it');
  await sleep(1000);
  check((await invalidNotes()).length === 1, 'a working interpreter brings no new notification');

  // ---------- a venv whose python.exe is gone ----------
  const told = (await invalidNotes()).length;
  renameSync(venvPy, `${venvPy}.gone`);
  await js('ide.reloadInterpreters()');
  await until(`ide.notifications.list().filter((n) => n.title === ${q(TITLE)}).length > ${told}`, 'second notification', 15000);
  const missing = (await invalidNotes()).pop();
  check(missing.text.includes(venvPy) && /does not exist/.test(missing.text) && (await js('ide.currentInterp()')) === null,
    `a deleted python.exe is reported as missing (${q(missing.text)})`);
  await js('ide.reloadInterpreters()');
  await sleep(1500);
  check((await invalidNotes()).length === 2, 'the same problem is not reported again when the list reloads');
  renameSync(`${venvPy}.gone`, venvPy);
  await js('ide.reloadInterpreters()');
  await until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(venvPy)})`, 'venv back');

  // ---------- an interpreter older than 3.8 ----------
  const old = 'C:\\Python27-demo\\python.exe';
  await js(`(ide.interpreterProviders.push(async () => [{ cmd: ${q(old)}, args: [], label: 'Old (Python 2.7.18)', executable: ${q(old)}, version: '2.7.18' }]), true)`);
  await js('ide.reloadInterpreters()');
  const label = await js(`ide.interps.find((i) => i.executable === ${q(old)})?.label`);
  check(/unsupported/.test(label || ''), `an interpreter older than 3.8 is listed as unsupported (${q(label)})`);
  const tooOld = `ide.notifications.list().filter((n) => /Python 3\\.8 or newer/.test(n.text || '')).length`;
  await js(`ide.setInterpreter(${q(old)})`);
  await until(`${tooOld} === 1`, 'unsupported interpreter notification', 5000).catch(() => {});
  check((await js(tooOld)) === 1, 'selecting it says the console, debugger and package tools need Python 3.8 or newer');
  await js(`ide.setInterpreter(${q(venvPy)})`);
  await js(`ide.setInterpreter(${q(old)})`);
  await sleep(500);
  check((await js(tooOld)) === 1 && (await js('ide.currentInterp()?.executable')) === old, 'it stays selectable and is not reported twice');

  const internal = (await js(`ide.api.invoke('diagnostics:errors')`)).map((e) => e.message);
  check(!internal.length, `no internal errors (${q(internal)})`);
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
}
t.close();

// ---------- a venv the project picked by itself (never chosen by hand) ----------
// Broken, it is reported as a chosen one is, instead of the global Python running the project unannounced; once its
// python.exe is back, coming back to the window clears the invalid mark; a pyvenv.cfg whose home stops naming a Python
// takes the venv off the list although its python.exe is unchanged, and a run that still starts it (a configuration
// naming it) says what is wrong instead of only Windows' "No Python at". Port 9957.
const auto = tempDir('interp-health-auto');
writeFileSync(path.join(auto, 'main.py'), 'print("hello")\n');
const autoVenv = path.join(auto, '.venv');
const autoPy = path.join(autoVenv, 'Scripts', 'python.exe');
execFileSync('py', ['-3', '-m', 'venv', '--without-pip', autoVenv]);
// The venv runs the project once, so that the project knows it: a folder that only looks like a venv is not reported.
const first = await launch({ fixture: 'core', port: 9957, name: 'interpreter-health-auto', projectDir: auto });
await first.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(autoPy)})`, 'the project picks its .venv', 30000).catch(() => {});
const autoData = first.userData;
await first.sleep(1500);
first.close();
renameSync(autoPy, `${autoPy}.gone`);
const a = await launch({ fixture: 'core', port: 9957, name: 'interpreter-health-auto', projectDir: auto, userData: autoData });
try {
  await a.until(`ide.notifications.list().some((n) => n.title === ${q(TITLE)})`, 'invalid notification for the picked venv', 20000).catch(() => {});
  const note = await a.js(`ide.notifications.list().filter((n) => n.title === ${q(TITLE)}).map((n) => ({ text: n.text, actions: (n.actions || []).map((x) => x.label) }))`);
  a.check(note.length === 1 && note[0].text.includes(autoPy) && q(note[0].actions) === q(['Choose Interpreter…', 'Recreate .venv']),
    `a broken venv the project picked by itself gets the same notification (${q(note)})`);
  const st = await a.js(`({ current: ide.currentInterp(), label: document.getElementById('statusInterpLabel').textContent })`);
  a.check(st.current === null && /Invalid interpreter: \.venv/.test(st.label), `the global Python does not take its place (${q(st)})`);

  renameSync(`${autoPy}.gone`, autoPy);
  await a.js(`(window.dispatchEvent(new Event('focus')), true)`);
  await a.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(autoPy)})`, 'venv back after focus', 15000).catch(() => {});
  const back = await a.js(`({ current: ide.currentInterp()?.executable || null, label: document.getElementById('statusInterpLabel').textContent })`);
  a.check(!/Invalid/.test(back.label) && back.current && back.current.toLowerCase() === autoPy.toLowerCase(), `with python.exe back, returning to the window clears the invalid mark (${q(back)})`);

  const autoCfg = path.join(autoVenv, 'pyvenv.cfg');
  writeFileSync(autoCfg, readFileSync(autoCfg, 'utf8').replace(/^home = .*$/m, 'home = C:\\Python-moved-away'));
  await a.js('ide.reloadInterpreters()');
  const homeGone = await a.js(`({ listed: ide.interps.filter((i) => !i.invalid).some((i) => ide.util.samePath(i.executable, ${q(autoPy)})), label: document.getElementById('statusInterpLabel').textContent })`);
  a.check(!homeGone.listed && /Invalid/.test(homeGone.label), `a pyvenv.cfg whose home is gone takes the venv off the list at once (${q(homeGone)})`);

  await a.js(`ide.openFile(${q(path.join(auto, 'main.py'))})`);
  await a.js(`(() => { const c = ide.run.addTemporary({ type: 'python', name: 'main', script: ${q(path.join(auto, 'main.py'))}, interp: ${q(autoPy)} }); ide.run.runConfig(c); return true; })()`);
  await a.until(`(ide.run.activeSession()?.con?.out?.textContent || '').includes('exit code 103')`, 'run with the broken venv', 30000);
  const outText = await a.js(`ide.run.activeSession().con.out.textContent`);
  const fixes = await a.js(`[...ide.run.activeSession().con.out.querySelectorAll('.console-actions a')].map((x) => x.textContent)`);
  a.check(/No Python at|did not find executable at/.test(outText) && /was made from C:\\Python-moved-away.*no longer there/s.test(outText) && q(fixes) === q(['Recreate .venv', 'Choose Interpreter…']),
    `a run that fails with "No Python at" says the venv's base Python is gone and offers the fixes (${q(outText.slice(-300))}, ${q(fixes)})`);
  a.check(a.consoleErrors.length === 0, 'no renderer exceptions (picked venv)');
} catch (err) {
  a.check(false, err.message);
}
a.results.unshift(...t.results);
a.finish();
