// Two PyIDE instances on one user data folder and one project share Local History's index.json: each keeps the
// revisions and labels the other recorded through both quits, and one instance's garbage collection keeps the blobs
// the other's revisions use. Ports 9282 (A) and 9283 (B).
import { existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const a = await launch({ fixture: 'core', port: 9282, name: 'history-instances-a' });
const b = await launch({ fixture: 'core', port: 9283, name: 'history-instances-b', userData: a.userData, projectDir: a.project });
const { check } = a;
const store = () => {
  const base = path.join(a.userData, 'local-history');
  return path.join(base, readdirSync(base).find((d) => existsSync(path.join(base, d, 'index.json'))) || readdirSync(base)[0]);
};
const blobFile = (h) => path.join(store(), 'blobs', h.slice(0, 2), h);
const revisions = (t, rel) => t.js(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, ${JSON.stringify(rel)}), false).then((r) => r.revisions.map((x) => ({ k: x.k, h: x.h })))`);
const edit = async (t, rel, line) => {
  await openFile(t, rel);
  await t.js(`(ide.editor.getModel().setValue(ide.editor.getModel().getValue() + ${JSON.stringify(`\n${line}\n`)}), true)`);
  await t.js('ide.saveAll().then(() => true)');
};
const quit = async (t) => {
  t.js(`ide.runAction('Exit')`).catch(() => {});
  const end = Date.now() + 20000;
  while (alive(t.pid) && Date.now() < end) await sleep(200);
  return !alive(t.pid);
};

try {
  for (const t of [a, b]) await t.until('ide.localHistory.ready().then((ok) => ok !== null)', 'Local History open');
  await edit(a, 'hello.py', '# saved in A');
  await a.until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'hello.py'), false).then((r) => r.revisions.some((x) => x.k === 'save'))`, 'A save recorded');
  await edit(b, 'broken.py', '# saved in B');
  await b.until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'broken.py'), false).then((r) => r.revisions.some((x) => x.k === 'save'))`, 'B save recorded');
  await b.js(`ide.localHistory.checkpoint('LABEL_FROM_B', { user: true }).then(() => true)`);
  const fromB = (await revisions(b, 'broken.py')).filter((r) => r.h);
  await sleep(2000); // both indexes written

  // Every blob looks old, as after a minute; then A records 200 revisions, which prunes its store and collects garbage.
  const past = new Date(Date.now() - 600000);
  const blobs = path.join(store(), 'blobs');
  for (const sub of readdirSync(blobs)) for (const f of readdirSync(path.join(blobs, sub))) utimesSync(path.join(blobs, sub, f), past, past);
  await a.js(`(async () => {
    const file = ide.util.joinPath(ide.root, 'hello.py');
    for (let i = 0; i < 200; i++) await ide.api.invoke('localHistory:checkpoint', ide.root, 'bulk', false, [{ path: file, text: 'bulk ' + i, encoding: 'utf-8' }]);
    return true;
  })()`);
  await sleep(3000);
  const kept = fromB.filter((r) => existsSync(blobFile(r.h))).length;
  check(fromB.length >= 2 && kept === fromB.length, `A's garbage collection keeps the blobs of B's revisions (${kept}/${fromB.length} kept)`);

  check(await quit(b), 'B quits');
  check(await quit(a), 'A quits');
  const index = JSON.parse(readFileSync(path.join(store(), 'index.json'), 'utf8'));
  const kinds = (rel) => index.files[rel]?.revs.map((r) => r.k) || [];
  console.log(`index after both quit: hello.py ${kinds('hello.py').filter((k) => k !== 'checkpoint').join()} (+${kinds('hello.py').filter((k) => k === 'checkpoint').length} checkpoints), broken.py ${kinds('broken.py').join()}, labels ${[...new Set(index.labels.map((l) => l.l))].join()}`);
  check(kinds('hello.py').includes('save'), "A's save of hello.py is in the index");
  check(kinds('broken.py').includes('save'), "B's save of broken.py is still in the index after A quit");
  check(index.labels.some((l) => l.l === 'LABEL_FROM_B'), "B's label is still in the index after A quit");
  const readable = index.files['broken.py']?.revs.filter((r) => r.h).every((r) => existsSync(path.join(store(), 'blobs', r.h.slice(0, 2), r.h)));
  check(readable, "every revision of B's file can still be read");
  const repeats = Object.values(index.files).flatMap((rec) => rec.revs.filter((r, i) => i > 0 && r.h === rec.revs[i - 1].h).map((r) => `${rec.p}:${r.k}`));
  check(!repeats.length, `a change both instances saw is one revision (${repeats.join()})`);
  const tmp = readdirSync(store()).filter((f) => f.endsWith('.tmp'));
  check(!tmp.length, `no temporary index files are left (${tmp.join()})`);
} catch (err) {
  check(false, err.message);
}
b.close();
a.finish();
