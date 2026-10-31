// Crash recovery of unsaved edits (renderer/features/recovery, main/features/recovery.js): debounced backups of
// modified file and untitled documents, one backup per document across detached windows, a hard kill of the process
// tree, the restore dialog (Restore, Discard), a file changed on disk in between restored as a conflict, a clean quit
// leaving nothing behind, the setting, and Korean. Ports 9060-9064. Then (port 9105) a running session whose backup
// folder is deleted or cannot be written: the backups are written again, and repeated failures are told once.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
let t = null;

const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
const tab = (f) => `ide.findTab(${P(f)})`;
const edit = (f, text) => t.js(`(() => {
  const m = ide.getDocument(${P(f)}).model;
  m.pushStackElement();
  m.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: ${S(text)} }], () => null);
  m.pushStackElement();
  return true;
})()`);
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
// Where the keyboard is, once the restore dialog is gone: in the active tab (its editor, or its page), in the Project
// view when the active tab is a page that cannot take it (the Workspace page), or else where.
const inActiveTab = `(() => {
  const tab = ide.activeTab();
  if (tab?.kind === 'file') return ide.editor.hasTextFocus();
  return !!tab?.host?.contains(document.activeElement) || (!!tab && !tab.host.hasAttribute('tabindex') && document.activeElement?.id === 'tree');
})()`;
const keyboardPlace = async () => {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(150)) if (await t.js(inActiveTab)) return 'active tab';
  return t.js(`(() => { const a = document.activeElement; return a?.tagName + '.' + a?.className + ' (active tab ' + ide.activeTab()?.title + ')'; })()`);
};
async function untilTrue(fn, label, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await fn()) return true;
  throw new Error(`timeout waiting for: ${label}`);
}

let userData = null;
let project = null;
const backupsDir = () => path.join(userData, 'backups');
// Every backup file: {session, file, meta, text}.
function backups() {
  const out = [];
  if (!existsSync(backupsDir())) return out;
  for (const session of readdirSync(backupsDir())) {
    const dir = path.join(backupsDir(), session);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.backup'))) {
      const raw = readFileSync(path.join(dir, file), 'utf8');
      const nl = raw.indexOf('\n');
      out.push({ session, file, meta: JSON.parse(raw.slice(0, nl)), text: raw.slice(nl + 1) });
    }
  }
  return out;
}
const backupOf = (name) => backups().filter((b) => (b.meta.path ? path.basename(b.meta.path) : b.meta.name) === name);

function start(port, opts = {}) {
  return launch({ fixture: 'recovery', port, name: `recovery-${port}`, ...(userData ? { userData, projectDir: project } : {}), ...opts });
}
function retire() {
  if (t.retired) return;
  t.retired = true;
  results.push(...t.results);
  errors.push(...t.consoleErrors);
}
async function crash() {
  const pid = t.pid;
  retire();
  t.close();
  await untilTrue(() => gone(pid), 'PyIDE process gone');
}

// Minimal CDP client for a detached window of the current instance.
async function attachDetached(port) {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === 'page' && p.url.includes('detached=1'));
  }
  if (!page) throw new Error('detached window not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  ws.addEventListener('close', () => { for (const r of pending.values()) r({}); pending.clear(); });
  const js = async (expression) => {
    if (ws.readyState !== WebSocket.OPEN) return undefined;
    const id = ++seq;
    // An evaluation sent while the page is still loading may never be answered.
    const msg = await Promise.race([
      new Promise((r) => { pending.set(id, r); ws.send(S({ id, method: 'Runtime.evaluate', params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } })); }),
      sleep(3000).then(() => ({})),
    ]);
    pending.delete(id);
    return msg.result?.result?.value;
  };
  return { js, close: () => ws.close() };
}

try {
  // ================= backups while editing =================
  t = await start(9060);
  ({ userData, project } = t);
  const { js, check } = t;
  // Auto save would save the files this suite keeps modified.
  await js(`(['autosave.onFrameDeactivation', 'autosave.onTabSwitch', 'autosave.onIdle'].forEach(k => ide.settings.set(k, false)), ide.settings.flush(), true)`);
  check(await js(`ide.settingsPageList().some(p => p.id === 'recovery' && p.group === 'Appearance & Behavior')`), 'Crash Recovery settings page under Appearance & Behavior');
  check(await js(`ide.settings.get('recovery.backup', true) === true`), 'backups are on by default');

  await openFile(t, 'a.py');
  await edit('a.py', '# EDIT_A\n');
  const editedAt = Date.now();
  await sleep(600);
  check(backups().length === 0, 'no backup is written on the keystroke itself (debounced)');
  await untilTrue(() => backupOf('a.py').some((b) => b.text.includes('# EDIT_A')), 'a.py backup');
  check(Date.now() - editedAt < 5000, `a.py is backed up about two seconds after the edit (${Date.now() - editedAt} ms)`);
  const a = backupOf('a.py')[0];
  const diskHashA = await js(`ide.getDocument(${P('a.py')}).diskHash`);
  check(a.meta.path.toLowerCase() === path.join(project, 'a.py').toLowerCase() && a.meta.language === 'python' && a.meta.encoding === 'utf-8'
    && a.meta.lineSeparator === '\n' && a.meta.diskHash === diskHashA && a.meta.time > 0 && a.meta.project.toLowerCase() === project.toLowerCase(),
  `the backup records path, language, encoding, line separator, disk hash, time and project (${S(a.meta)})`);

  await openFile(t, 'u.py');
  await js(`(ide.getDocument(${P('u.py')}).untitled = true, true)`);
  await edit('u.py', '# UNTITLED_TEXT\n');
  await untilTrue(() => backups().some((b) => b.meta.untitled && b.text.includes('# UNTITLED_TEXT')), 'untitled backup');
  const u = backups().find((b) => b.meta.untitled);
  check(u.meta.path === null && u.meta.name === 'u.py', `an untitled document is backed up by name, without a path (${S(u.meta)})`);

  await openFile(t, 'c.py');
  await edit('c.py', '# EDIT_C\n');
  await untilTrue(() => backupOf('c.py').length === 1, 'c.py backup');

  await openFile(t, 'b.py');
  await edit('b.py', '# EDIT_B\n');
  await untilTrue(() => backupOf('b.py').length === 1, 'b.py backup');
  await js(`ide.saveTab(${tab('b.py')})`);
  await untilTrue(() => backupOf('b.py').length === 0, 'b.py backup removed after save', 5000);
  check(true, 'saving a document removes its backup');
  await edit('b.py', '# AGAIN_B\n');
  await untilTrue(() => backupOf('b.py').length === 1, 'b.py backed up again');
  await js(`(ide.getDocument(${P('b.py')}).model.undo(), true)`);
  await untilTrue(() => backupOf('b.py').length === 0, 'b.py backup removed once unmodified', 5000);
  check(true, 'undoing back to the saved text removes the backup');
  await edit('b.py', '# CLOSE_B\n');
  await untilTrue(() => backupOf('b.py').length === 1, 'b.py backed up before close');
  await js(`(ide.closeTab(${P('b.py')}, true), true)`);
  await untilTrue(() => backupOf('b.py').length === 0, 'b.py backup removed after close', 5000);
  check(true, 'closing a document without saving removes its backup');

  // A detached window shares the document: one backup file, kept while any window still has the change.
  await js(`ide.openFile(${P('a.py')}, { group: 'window' })`);
  const w = await attachDetached(9060);
  let detachedState;
  await untilTrue(async () => (detachedState = await w.js(`({ ready: window.__ideReady === true, title: ide.activeTab()?.title, dirty: !!ide.activeTab() && ide.isDirty(ide.activeTab()) })`))?.ready && detachedState.title === 'a.py' && detachedState.dirty, 'detached a.py modified', 60000)
    .catch((e) => { throw new Error(`${e.message} (${JSON.stringify(detachedState)})`); });
  await w.js(`(ide.getDocument(ide.activeTab().path).model.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: '# FROM_DETACHED\\n' }], () => null), true)`);
  await untilTrue(() => backupOf('a.py').some((b) => b.text.includes('# FROM_DETACHED') && b.text.includes('# EDIT_A')), 'backup has the detached edit');
  await sleep(2500);
  check(backupOf('a.py').length === 1, `two windows editing a.py keep one backup file (${backupOf('a.py').length})`);
  await w.js(`(setTimeout(() => ide.closeTab(ide.activeTab().path, true)), true)`);
  await untilTrue(async () => (await (await fetch('http://127.0.0.1:9060/json')).json()).filter((p) => p.type === 'page').length === 1, 'detached window closed');
  w.close();
  await sleep(1000);
  check(backupOf('a.py').length === 1 && backupOf('a.py')[0].text.includes('# FROM_DETACHED'), 'closing the detached window without saving keeps the backup the main window still needs');

  check(backups().length === 3, `backups before the crash: a.py, c.py, untitled (${backups().map((b) => b.meta.name).join(', ')})`);
  const firstSession = backups()[0].session;
  await crash();
  check(backups().length === 3 && backups().every((b) => b.session === firstSession), 'the backups survive a hard kill of the process tree');
  writeFileSync(path.join(project, 'c.py'), "C = 'changed on disk'\n");

  // ================= restart: Restore =================
  t = await start(9061);
  await t.until(`!!document.querySelector('#recoveryDialog')`, 'restore dialog');
  const items = await t.js(`[...document.querySelectorAll('#recoveryDialog li')].map(n => n.textContent)`);
  t.check(items.length === 3 && items.includes('a.py') && items.includes('c.py') && items.includes('u.py (untitled)'), `the dialog lists the backed-up files (${items.join(' | ')})`);
  t.check(await t.js(`document.querySelector('#recoveryDialog .dialog-body').textContent.includes('Nano Studio closed unexpectedly')`), 'the dialog says Nano Studio closed unexpectedly');
  t.check(await t.js(`document.querySelector('#recoveryDialog .dialog-buttons .primary').textContent === 'Restore'`), 'Restore is the main button');
  await t.click('#recoveryDialog .dialog-buttons .primary');
  await t.until(`ide.isDirty(${tab('a.py')}) && ide.isDirty(${tab('c.py')})`, 'a.py and c.py restored');
  t.check(await t.js(`ide.getDocument(${P('a.py')}).model.getValue().startsWith('# FROM_DETACHED\\n# EDIT_A\\ndef a():')`), 'Restore brings back the unsaved text of a.py as an unsaved change');
  t.check(readFileSync(path.join(project, 'a.py'), 'utf8') === "def a():\n    return 'a'\n", 'restoring does not write the file');
  const afterRestore = await keyboardPlace();
  t.check(afterRestore === 'active tab', `after Restore the keyboard is in the active tab (${afterRestore})`);
  await t.until(`ide.tabs.some(t => /scratch\\.py$/.test(t.path) && ide.isDirty(t))`, 'untitled restored');
  t.check(await t.js(`ide.tabs.find(t => /scratch\\.py$/.test(t.path)).model.getValue() === '# UNTITLED_TEXT\\nU = \\'u\\'\\n'`), 'the untitled document comes back, unsaved, in a new scratch file');
  const c = await t.js(`(() => { const d = ide.getDocument(${P('c.py')}); return { text: d.model.getValue(), conflict: !!d.conflict }; })()`);
  t.check(c.text === "# EDIT_C\nC = 'c'\n" && c.conflict, `c.py, changed on disk since the backup, is restored with the backed-up text and marked as a conflict (${S(c)})`);
  t.cdp('Runtime.evaluate', { expression: `setTimeout(() => ide.saveTab(${tab('c.py')}), 0)` });
  await t.until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'File Cache Conflict')`, 'File Cache Conflict', 8000);
  t.check(true, 'saving the conflicting file asks first (File Cache Conflict)');
  await t.js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Cancel').click()`);
  t.check(readFileSync(path.join(project, 'c.py'), 'utf8') === "C = 'changed on disk'\n", 'Cancel leaves the disk version alone');
  await untilTrue(() => backups().length === 3 && backups().every((b) => b.session !== firstSession), 'the old backups replaced by the new session');
  t.check(!existsSync(path.join(backupsDir(), firstSession)), 'the dead session folder is removed once its backups are restored');
  await crash();

  // ================= restart: Discard, the setting =================
  t = await start(9062);
  await t.until(`!!document.querySelector('#recoveryDialog')`, 'restore dialog after the second crash');
  t.check(await t.js(`document.querySelector('#recoveryDialog .dialog-buttons .secondary').textContent === 'Discard'`), 'Discard is the other button');
  await t.click('#recoveryDialog .dialog-buttons .secondary');
  await sleep(1500);
  t.check(await t.js(`!ide.tabs.some(t => ide.isDirty(t))`), 'Discard leaves every document unmodified');
  const afterDiscard = await keyboardPlace();
  t.check(afterDiscard === 'active tab', `after Discard the keyboard is in the active tab, or in the Project view when that is the Workspace page (${afterDiscard})`);
  await untilTrue(() => backups().length === 0, 'backups deleted after Discard', 5000);
  t.check(true, 'Discard deletes the backups');
  t.check((await t.js(`ide.api.invoke('recovery:pending', ide.root)`)).length === 0, 'nothing is offered again after Discard');

  await t.js(`(ide.settings.set('recovery.backup', false), true)`);
  await openFile(t, 'a.py');
  await edit('a.py', '# OFF\n');
  await sleep(3500);
  t.check(backups().length === 0, 'with the setting off no backup is written');
  await t.js(`(ide.settings.set('recovery.backup', true), true)`);
  await untilTrue(() => backupOf('a.py').some((b) => b.text.includes('# OFF')), 'backup after turning the setting on', 5000);
  t.check(true, 'turning the setting on backs up the modified documents');
  await t.js(`(ide.settings.set('recovery.backup', false), true)`);
  await untilTrue(() => backups().length === 0, 'backup removed after turning the setting off', 5000);
  t.check(true, 'turning the setting off removes the backups');
  await t.js(`(ide.settings.set('recovery.backup', true), true)`);
  await untilTrue(() => backupOf('a.py').length === 1, 'backed up again');

  // ================= clean quit =================
  const pid = t.pid;
  t.cdp('Runtime.evaluate', { expression: "setTimeout(() => ide.api.invoke('window:close'), 0)" });
  await t.until(`document.querySelector('.dialog-title')?.textContent === 'Save Changes?'`, 'close confirmation', 8000);
  t.cdp('Runtime.evaluate', { expression: `setTimeout(() => [...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === "Don't Save").click(), 0)` });
  await untilTrue(() => gone(pid), 'PyIDE quit', 20000);
  t.check(backups().length === 0 && readdirSync(backupsDir()).length === 0, `a clean quit leaves no backups (${readdirSync(backupsDir()).join(', ')})`);
  retire();
  t.close();

  // ================= Korean, no dialog after a clean quit =================
  t = await start(9063, { lang: 'ko-KR' });
  await sleep(3000);
  t.check(await t.js(`!document.querySelector('#recoveryDialog')`), 'no restore dialog after a clean quit');
  await openFile(t, 'a.py');
  await edit('a.py', '# KO\n');
  await untilTrue(() => backupOf('a.py').length === 1, 'Korean session backup');
  await crash();

  t = await start(9064, { lang: 'ko-KR' });
  await t.until(`!!document.querySelector('#recoveryDialog')`, 'Korean restore dialog');
  const ko = await t.js(`(() => { const d = document.querySelector('#recoveryDialog'); return { title: d.querySelector('.dialog-title').textContent, buttons: [...d.querySelectorAll('.dialog-buttons button')].map(b => b.textContent) }; })()`);
  t.check(ko.title === '저장되지 않은 변경 사항 복원' && ko.buttons.join() === '복원,폐기', `Korean dialog (${S(ko)})`);
  const leaks = await englishLeaks(t, '#recoveryDialog');
  t.check(leaks.length === 0, `no English in the Korean dialog (${S(leaks)})`);
  await t.js(`[...document.querySelectorAll('#recoveryDialog .dialog-buttons button')].find(b => b.textContent === '복원').click()`);
  await t.until(`ide.isDirty(${tab('a.py')})`, 'restored in Korean');
  await t.js(`(ide.openSettings('recovery'), true)`);
  await t.until(`document.querySelector('.settings-page')?.dataset.page === 'recovery'`, 'Crash Recovery settings page');
  const pageLeaks = await englishLeaks(t, '.settings-page');
  t.check(pageLeaks.length === 0, `no English on the Korean settings page (${S(pageLeaks)})`);
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'features', 'recovery', 'index.js'), 'utf8');
  const missing = (await missingTranslations(t)).filter((m) => source.includes(`'${m}'`));
  t.check(missing.length === 0, `no missing Korean strings for recovery (${missing.join(', ')})`);
  const koDict = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'features', 'recovery', 'locales', 'ko.json'), 'utf8'));
  const untranslated = [...new Set([...source.matchAll(/\btr\('([^']*)'/g)].map((m) => m[1]))].filter((m) => !(m in koDict));
  t.check(untranslated.length === 0, `every string the plugin translates has a Korean entry, also those not shown here (${untranslated.join(', ')})`);
  await t.shot('recovery-ko.png');
  await t.press('Escape');

  // ================= the session folder deleted or unwritable while PyIDE runs =================
  retire();
  t.close();
  t = await launch({ fixture: 'recovery', port: 9105, name: 'recovery-9105' });
  ({ userData, project } = t);
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await t.until(`Math.abs(innerWidth - 1008) <= 1 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await t.js(`(['autosave.onFrameDeactivation', 'autosave.onTabSwitch', 'autosave.onIdle'].forEach(k => ide.settings.set(k, false)), ide.settings.flush(), true)`);
  await openFile(t, 'a.py');
  await edit('a.py', '# LIVE_A\n');
  await openFile(t, 'c.py');
  await edit('c.py', '# LIVE_C\n');
  await untilTrue(() => backupOf('a.py').length === 1 && backupOf('c.py').length === 1, 'a.py and c.py backed up');
  const live = path.join(backupsDir(), backups()[0].session);
  rmSync(live, { recursive: true, force: true });
  await untilTrue(() => backupOf('a.py').some((b) => b.text.includes('# LIVE_A')) && backupOf('c.py').some((b) => b.text.includes('# LIVE_C')), 'backups written again', 20000);
  t.check(true, 'with the session folder deleted under a running PyIDE, both backups are written again without another edit');
  await edit('c.py', '# LIVE_C2\n');
  await untilTrue(() => backupOf('c.py').some((b) => b.text.includes('# LIVE_C2')), 'later edit backed up');
  t.check(true, 'later edits are backed up again');

  rmSync(live, { recursive: true, force: true });
  writeFileSync(live, '');
  await edit('a.py', '# FAILING\n');
  const failNotes = `ide.notifications.list().filter((n) => n.title === 'Unsaved changes are not being backed up')`;
  await t.until(`${failNotes}.length === 1`, 'backup failure notification', 25000);
  const balloon = await t.js(`(() => {
    const b = [...document.querySelectorAll('#balloons > *')].find((n) => n.textContent.includes('Unsaved changes are not being backed up'));
    const r = b?.getBoundingClientRect();
    return r ? { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, text: b.textContent } : null;
  })()`);
  t.check(balloon?.inside, `backups failing again and again are told in a notification balloon, inside a 1008x681 window (${S(balloon)})`);
  await t.shot('recovery-failure-1008.png');
  await sleep(12000);
  t.check(await t.js(`${failNotes}.length`) === 1, `and only once while they keep failing (${await t.js(`${failNotes}.length`)})`);
  rmSync(live, { force: true });
  await untilTrue(() => backupOf('a.py').some((b) => b.text.includes('# FAILING')) && backupOf('c.py').some((b) => b.text.includes('# LIVE_C2')), 'backups after the failure', 20000);
  t.check(true, 'once the folder can be made again, every backup is written again');
} catch (err) {
  t?.check(false, err.message);
}
if (t) { retire(); t.close(); }
const all = results.filter((r) => r.label);
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
