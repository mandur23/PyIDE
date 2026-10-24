// Renaming, moving or deleting from the project tree never throws away unsaved text and reaches every window: a
// renamed file or folder takes its open documents along, unsaved text included (no save first, so a read-only file or
// a File Cache Conflict cannot get in the way), and a detached window follows a rename or a delete made in the main
// window, so its next save does not bring the old file back. Port 9275.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';

const PORT = 9275;
const q = JSON.stringify;
const t = await launch({ fixture: 'tree', port: PORT, name: 'rename-unsaved' });
const { js, until, check, sleep } = t;
const P = (rel) => path.join(t.project, rel);
const lastDialog = `[...document.querySelectorAll('.dialog')].pop()`;
const docState = (p, ctx = t) => ctx.js(`(() => { const t = ide.findTab(${q(p)}); return t ? { text: t.doc.model.getValue(), dirty: ide.isDirty(t) } : null; })()`);
const edit = async (p, text) => {
  await js(`ide.openFile(${q(p)})`);
  await until(`ide.util.samePath(ide.activeTab()?.path, ${q(p)})`, `${path.basename(p)} open`);
  await js(`(ide.editor.getModel().pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: ${q(text)} }], () => null), true)`);
};
// Runs the tree's rename/move; any question it asks is answered with Cancel (or OK) and returned.
const move = async (from, to, dir = false) => {
  await js(`(window.__mv = ide.moveTreeEntry({ name: ${q(path.basename(from))}, path: ${q(from)}, dir: ${dir} }, ${q(to)}).then(() => 'done'), true)`);
  const asked = [];
  for (let i = 0; i < 40; i++) {
    if (await js(`Promise.race([window.__mv, new Promise((r) => setTimeout(() => r(null), 100))])`)) break;
    const text = await js(`${lastDialog}?.textContent ?? null`);
    if (text) {
      asked.push(text);
      await js(`(() => { const b = [...${lastDialog}.querySelectorAll('.dialog-buttons button')]; (b.find((x) => x.textContent === 'Cancel') || b.find((x) => x.textContent === 'OK')).click(); return true; })()`);
    }
  }
  await sleep(300);
  return asked;
};

// Minimal CDP client for the detached window.
async function attach(predicate) {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((p) => p.type === 'page' && predicate(p.url));
  }
  if (!page) throw new Error('detached window not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  ws.addEventListener('close', () => { for (const r of pending.values()) r({}); pending.clear(); });
  const cdp = (method, params = {}) => new Promise((r) => {
    if (ws.readyState !== WebSocket.OPEN) return r({});
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const wjs = async (expr) => (await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const wuntil = async (expr, label, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await wjs(expr)) return true; } catch {} await sleep(150); }
    throw new Error(`timeout (detached): ${label}`);
  };
  return { cdp, js: wjs, until: wuntil, close: () => ws.close() };
}

try {
  writeFileSync(P('ro.txt'), 'read only\n');
  chmodSync(P('ro.txt'), 0o444);
  writeFileSync(P('conflict.txt'), 'original\n');
  mkdirSync(P('dir'));
  writeFileSync(P('dir/inner.txt'), 'inner\n');
  chmodSync(P('dir/inner.txt'), 0o444);
  writeFileSync(P('ok.txt'), 'fine\n');
  await js('ide.refreshTree()');

  // A read-only file: renamed with its unsaved edit, which stays unsaved.
  await edit(P('ro.txt'), 'EDIT-RO ');
  const a1 = await move(P('ro.txt'), P('ro2.txt'));
  const s1 = await docState(P('ro2.txt'));
  check(!a1.length && !existsSync(P('ro.txt')) && readFileSync(P('ro2.txt'), 'utf8') === 'read only\n' && s1?.text === 'EDIT-RO read only\n' && s1.dirty,
    `a read-only file is renamed and its tab keeps the unsaved edit (asked ${q(a1)}, ${q(s1)})`);

  // A file changed on disk meanwhile: no File Cache Conflict, the edit moves along.
  await edit(P('conflict.txt'), 'MINE ');
  writeFileSync(P('conflict.txt'), 'changed outside\n');
  const a2 = await move(P('conflict.txt'), P('conflict2.txt'));
  const s2 = await docState(P('conflict2.txt'));
  check(!a2.length && readFileSync(P('conflict2.txt'), 'utf8') === 'changed outside\n' && s2?.text === 'MINE original\n' && s2.dirty,
    `a file also changed on disk is renamed without a question and keeps the edit (asked ${q(a2)}, ${q(s2)})`);

  // A folder holding an unsaved file that cannot be saved.
  await edit(P('dir/inner.txt'), 'EDIT-INNER ');
  const a3 = await move(P('dir'), P('dir2'), true);
  const s3 = await docState(P('dir2/inner.txt'));
  check(!a3.length && !existsSync(P('dir')) && s3?.text === 'EDIT-INNER inner\n' && s3.dirty,
    `a renamed folder takes its unsaved file along (asked ${q(a3)}, ${q(s3)})`);

  // An unsaved edit in a file that can be saved: carried along, then saved at the new place.
  await edit(P('ok.txt'), 'SAVED ');
  const a4 = await move(P('ok.txt'), P('ok2.txt'));
  await js(`ide.saveTab(ide.findTab(${q(P('ok2.txt'))}))`);
  const s4 = await docState(P('ok2.txt'));
  check(!a4.length && !existsSync(P('ok.txt')) && readFileSync(P('ok2.txt'), 'utf8') === 'SAVED fine\n' && s4?.text === 'SAVED fine\n' && !s4.dirty,
    `a renamed file saves at its new place (${q(s4)})`);
  chmodSync(P('ro2.txt'), 0o666);
  chmodSync(P('dir2/inner.txt'), 0o666);

  // ---------- a detached window follows the main window's rename and delete ----------
  writeFileSync(P('shared.py'), 'value = 1\n');
  writeFileSync(P('gone.py'), 'gone = 1\n');
  await js(`ide.openFile(${q(P('shared.py'))})`);
  await until(`ide.activeTab()?.title === 'shared.py'`, 'shared.py open');
  await js(`(ide.runAction('OpenInNewWindow'), true)`);
  const w = await attach((url) => url.includes('detached=1'));
  await w.until(`window.__ideReady === true && ide.activeTab()?.title === 'shared.py'`, 'detached window shows shared.py');
  await w.js(`ide.openFile(${q(P('gone.py'))})`);
  await w.until(`!!ide.findTab(${q(P('gone.py'))})`, 'detached window has gone.py');
  await js(`(ide.openFile(${q(P('shared.py'))}), ide.editor.getModel().pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: '# main\\n' }], () => null), true)`);
  await w.until(`ide.findTab(${q(P('shared.py'))})?.doc.model.getValue().startsWith('# main')`, 'edit synced to the detached window');

  const a5 = await move(P('shared.py'), P('shared2.py'));
  const followed = await w.until(`!!ide.findTab(${q(P('shared2.py'))}) && !ide.findTab(${q(P('shared.py'))})`, 'detached tab renamed', 8000).then(() => true, () => false);
  const ds = await docState(P('shared2.py'), w);
  check(!a5.length && followed && ds?.text === '# main\nvalue = 1\n' && ds.dirty, `the detached window's tab follows the rename with the unsaved text (detached ${q(ds)}, main ${q(await docState(P('shared2.py')))})`);
  await w.js(`(ide.findTab(${q(P('shared2.py'))}).doc.model.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: '# detached\\n' }], () => null), true)`);
  await w.js(`ide.saveAll()`);
  await sleep(500);
  const onDisk = { old: existsSync(P('shared.py')) ? readFileSync(P('shared.py'), 'utf8') : null, renamed: readFileSync(P('shared2.py'), 'utf8') };
  check(onDisk.old === null && onDisk.renamed === '# detached\n# main\nvalue = 1\n',
    `saving in the detached window writes the renamed file and does not bring the old one back (${q(onDisk)})`);

  // Delete from the tree (the Recycle Bin is replaced by a move out of the project here).
  await js(`(ide.api.trash = (p) => ide.api.rename(p, ${q(path.join(path.dirname(t.project), 'trashed-'))} + p.split('\\\\').pop()), true)`);
  await js(`ide.revealInTree(${q(P('gone.py'))})`);
  await js(`(document.getElementById('tree').focus(), true)`);
  await t.press('Delete');
  await until(`${lastDialog}?.textContent.includes('Recycle Bin')`, 'delete confirmation');
  await js(`([...${lastDialog}.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Delete').click(), true)`);
  await until(`!ide.findTab(${q(P('gone.py'))})`, 'main tab closed');
  const closed = await w.until(`!ide.findTab(${q(P('gone.py'))})`, 'detached tab closed', 8000).then(() => true, () => false);
  check(closed && !existsSync(P('gone.py')), 'a file deleted in the main window closes in the detached window too');
  w.close();

  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
}
t.finish();
