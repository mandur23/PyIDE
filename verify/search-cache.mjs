// Find in Files keeps the text it read per file: a file changed on disk (also to the same size) is searched as it is
// now, a warm search answers what a cold one does, and in a folder with case sensitivity turned on a.py and A.py each
// search and list TODOs from their own unsaved text. Port 9431.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-scache-'));
const project = path.join(work, 'proj');
const cs = path.join(project, 'cs');
const plain = path.join(project, 'plain');
for (const d of [cs, plain]) mkdirSync(d, { recursive: true });
let sensitive = true;
try {
  execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', cs, 'enable'], { stdio: 'pipe' });
} catch (err) {
  sensitive = false;
  console.log(`SKIP case-sensitive folder checks: fsutil could not turn case sensitivity on (${String(err.stderr || err.message).trim().slice(0, 200)})`);
}
const file = (dir, name) => path.join(dir, name);
if (sensitive) {
  writeFileSync(file(cs, 'a.py'), 'LOWER = 1\n');
  writeFileSync(file(cs, 'A.py'), 'UPPER = 2\n');
  writeFileSync(file(cs, 'b.py'), 'DISK_LOWER_B = 1  # TODO disk lower b\n');
  writeFileSync(file(cs, 'B.py'), 'DISK_UPPER_B = 2\n');
}
for (let i = 0; i < 40; i++) writeFileSync(file(plain, `m${i}.py`), `def helper_${i}():\n    return ${i}  # shared_word\n`);
writeFileSync(file(plain, 'same.py'), 'VALUE = "aaaa"\n');
writeFileSync(file(plain, 'edit.py'), 'ON_DISK = 1\n');

const t = await launch({ fixture: 'core', port: 9431, name: 'search-cache', projectDir: project });
const { js, until, check, sleep, press } = t;
const opts = (query) => ({ query, caseSensitive: true, words: false, regex: false, mask: '', dir: null, replacement: '' });
// What the Find dialog sends: the project, the options and every modified tab's text by its path.
const find = (query) => js(`(async () => {
  const unsaved = {};
  for (const t of ide.tabs) if (t.kind === 'file' && ide.isDirty(t)) unsaved[t.path] = t.model.getValue();
  const r = await ide.api.invoke('search:find', ide.root, ${q(opts(query))}, unsaved, {});
  return { count: r.count, files: r.files.map((f) => f.path.slice(ide.root.length + 1)), matches: r.files.map((f) => f.matches) };
})()`);
const edit = (p, text) => js(`(async () => { await ide.openFile(${q(p)}); const m = ide.findTab(${q(p)}).model; m.pushEditOperations([], [{ range: m.getFullModelRange(), text: ${q(text)} }], () => null); return ide.isDirty(ide.findTab(${q(p)})); })()`);
const status = (s) => until(`document.querySelector('#snStatus')?.textContent === ${q(s)}`, `status ${s}`, 10000).then(() => true, () => false);

try {
  // ---------- cache: changes on disk, warm equals cold ----------
  let r = await find('shared_word');
  check(r.count === 40 && r.files.length === 40, `a first search finds all 40 files (${r.count})`);
  const cold = JSON.stringify(r);
  await js(`ide.api.invoke('search:find', ide.root, ${q(opts('helper_'))}, {}, {}).then(() => true)`);
  r = await find('shared_word');
  check(JSON.stringify(r) === cold, 'a warm search answers exactly what the cold one did');

  writeFileSync(file(plain, 'm7.py'), 'def helper_7():\n    return 7  # changed_outside\n');
  r = await find('changed_outside');
  check(r.count === 1 && r.files[0] === 'plain\\m7.py', `a file rewritten outside the IDE is searched as it is now (${q(r.files)})`);
  r = await find('shared_word');
  check(r.count === 39 && !r.files.includes('plain\\m7.py'), `its old text is no longer found (${r.count})`);

  const before = readFileSync(file(plain, 'same.py'));
  await find('aaaa');
  writeFileSync(file(plain, 'same.py'), 'VALUE = "bbbb"\n');
  check(readFileSync(file(plain, 'same.py')).length === before.length, 'the rewrite keeps the size');
  r = await find('bbbb');
  const gone = await find('aaaa');
  check(r.count === 1 && gone.count === 0, `a change to the same size is searched as it is now (bbbb ${r.count}, aaaa ${gone.count})`);

  writeFileSync(file(plain, 'fresh.py'), 'BRAND_NEW = 1\n');
  r = await find('BRAND_NEW');
  check(r.count === 1, 'a file created outside the IDE is found');
  rmSync(file(plain, 'fresh.py'));
  r = await find('BRAND_NEW');
  check(r.count === 0, 'a deleted file is no longer found');

  // ---------- unsaved text in an ordinary folder ----------
  check(await edit(file(plain, 'edit.py'), 'IN_EDITOR = 1\n'), 'edit.py is modified in the editor');
  r = await find('IN_EDITOR');
  const disk = await find('ON_DISK');
  check(r.count === 1 && disk.count === 0, `a modified file is searched in its unsaved text (editor ${r.count}, disk ${disk.count})`);

  if (sensitive) {
    // ---------- case-sensitive folder: a.py and A.py both modified ----------
    check(await edit(file(cs, 'a.py'), 'LOWER = "needle_lower"\n') && await edit(file(cs, 'A.py'), 'UPPER = "needle_upper"\n'), 'a.py and A.py are both modified');
    const lo = await find('needle_lower');
    const up = await find('needle_upper');
    check(lo.count === 1 && lo.files[0] === 'cs\\a.py', `needle_lower is found in a.py's unsaved text only (${q(lo.files)})`);
    check(up.count === 1 && up.files[0] === 'cs\\A.py', `needle_upper is found in A.py's unsaved text only (${q(up.files)})`);

    // ---------- only B.py modified: b.py is searched on disk ----------
    check(await edit(file(cs, 'B.py'), 'UNSAVED_UPPER_B = 2  # TODO unsaved upper B\n'), 'B.py is modified, b.py is not');
    const diskB = await find('DISK_LOWER_B');
    const unsavedB = await find('UNSAVED_UPPER_B');
    check(diskB.count === 1 && diskB.files[0] === 'cs\\b.py', `b.py is searched in its text on disk, not B.py's unsaved text (${q(diskB.files)})`);
    check(unsavedB.count === 1 && unsavedB.files[0] === 'cs\\B.py', `B.py's unsaved text is searched for B.py only (${q(unsavedB.files)})`);

    // The Find dialog end to end.
    await js(`(ide.actions.find((a) => a.id === 'FindInPath').run(), true)`);
    await until(`!!document.getElementById('snQuery')`, 'find dialog');
    await js(`(() => { const i = document.getElementById('snQuery'); i.value = 'UNSAVED_UPPER_B'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const shown = await status('1 match in 1 file');
    const loc = await js(`[...document.querySelectorAll('#snPreview .sn-ploc')].map((n) => n.textContent)`);
    check(shown && loc.length === 1 && loc[0].startsWith('B.py'), `the Find dialog shows B.py's unsaved line once (${q(loc)})`);
    await press('Escape');

    // ---------- TODO tool window: each file's own TODO ----------
    await js(`(ide.toolWindows.get('TODO').show(), true)`);
    await until(`[...document.querySelectorAll('#snTodo .sn-todo')].some((n) => n.textContent.includes('unsaved upper B'))`, 'TODO of B.py', 10000).catch(() => {});
    const todos = await js(`[...document.querySelectorAll('#snTodo .sn-todo')].map((n) => n.textContent)`);
    check(todos.filter((s) => s.includes('unsaved upper B')).length === 1 && todos.filter((s) => s.includes('disk lower b')).length === 1,
      `TODO lists B.py's unsaved TODO and b.py's TODO on disk once each (${q(todos)})`);
  }
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.close();
await sleep(1000);
try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {}
t.finish();
