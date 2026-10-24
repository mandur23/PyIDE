// Two PyIDE instances on one user data folder (launching PyIDE twice, one project each): a settings write carries only
// the keys that window changed onto the file's current content, so neither instance drops the other's settings or
// Recent Projects. A settings.json that cannot be written is said once, retried, and written when it can be again.
// Ports 9274-9275.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const q = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
let a;
let b;
try {
  a = await launch({ fixture: 'core', port: 9274, name: 'settings-instances-a' });
  b = await launch({ fixture: 'core', port: 9275, name: 'settings-instances-b', userData: a.userData, projectDir: a.project });
  const file = path.join(a.userData, 'settings.json');
  const disk = () => JSON.parse(readFileSync(file, 'utf8'));
  const set = (t, key, value) => t.js(`(ide.settings.set(${q(key)}, ${value === undefined ? 'undefined' : q(value)}), ide.settings.flush(), true)`);

  await set(a, 'editor.fontSize', 17);
  await set(b, 'editor.tabLimit', 7);
  await set(a, 'editor.rulers', [80]);
  const s1 = disk();
  check(s1['editor.fontSize'] === 17 && s1['editor.tabLimit'] === 7 && q(s1['editor.rulers']) === '[80]',
    `each instance's change survives the other's later write (${q({ fontSize: s1['editor.fontSize'], tabLimit: s1['editor.tabLimit'], rulers: s1['editor.rulers'] })})`);
  await set(b, 'editor.fontSize', 15);
  check(disk()['editor.fontSize'] === 15 && disk()['editor.rulers']?.[0] === 80, 'a key both instances set holds the last write, and the rest stays');
  await set(b, 'test.removed', 1);
  await set(b, 'test.removed', undefined);
  check(!('test.removed' in disk()) && disk()['editor.tabLimit'] === 7, 'a key set to undefined is removed from the file');

  // Recent Projects: each instance opens its own project; the list keeps both.
  const p1 = tempDir('settings-instances-p1');
  const p2 = tempDir('settings-instances-p2');
  writeFileSync(path.join(p1, 'one.py'), 'x = 1\n');
  writeFileSync(path.join(p2, 'two.py'), 'y = 2\n');
  await b.js(`ide.openProject(${q(p1)})`);
  await b.js('(ide.settings.flush(), true)');
  await a.js(`ide.openProject(${q(p2)})`);
  await a.js('(ide.settings.flush(), true)');
  const recent = (disk().recentProjects || []).map((r) => r.path.toLowerCase());
  check(recent[0] === p2.toLowerCase() && recent.includes(p1.toLowerCase()),
    `Recent Projects has the project each instance opened, newest first (${q(recent.slice(0, 3))})`);
  b.close();
  b = null;

  // A settings.json that is not valid JSON when a write comes is kept as settings.json.bak, and the window's settings
  // are written in its place.
  writeFileSync(file, '{ "editor.fontSize": 16, oops');
  await set(a, 'editor.lineNumbers', 'relative');
  check(existsSync(`${file}.bak`) && readFileSync(`${file}.bak`, 'utf8').includes('oops') && disk()['editor.lineNumbers'] === 'relative' && disk()['editor.fontSize'] === 17,
    'an unreadable settings.json found at a write is kept as settings.json.bak and the window writes all of its settings');

  // Cannot be written (a folder in the file's place): one notification, retried, written once possible.
  const notes = `ide.notifications.list().filter((n) => n.title === 'Settings cannot be saved').length`;
  rmSync(file, { force: true });
  mkdirSync(file);
  await set(a, 'editor.fontSize', 19);
  const told = await a.until(`${notes} === 1`, 'settings notification', 5000).then(() => true, () => false);
  const text = await a.js(`ide.notifications.list().find((n) => n.title === 'Settings cannot be saved')?.text || ''`);
  check(told && /retr/i.test(text), `a failed settings write is reported once (${q(text)})`);
  await set(a, 'editor.tabLimit', 9);
  await a.sleep(2500);
  check((await a.js(notes)) === 1, 'more failed writes do not report again');
  rmSync(file, { recursive: true, force: true });
  let written = false;
  for (let i = 0; i < 30 && !written; i++) {
    await a.sleep(200);
    try { written = existsSync(file) && disk()['editor.fontSize'] === 19 && disk()['editor.tabLimit'] === 9; } catch {}
  }
  check(written, 'once the file can be written again, the pending changes are written');
  check(a.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
}
b?.close();
a?.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
