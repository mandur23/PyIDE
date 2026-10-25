// The main window and a detached editor window on the same documents: edits typed in both at once (also in a CRLF file,
// beside a line separator conversion, and while the second window is still joining), a reload from disk, a rename or
// delete in one window, a save of a file that is gone, and File > Exit with unsaved files in another window. Port 9271.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';

const PORT = 9271;
const t = await launch({ fixture: 'core', port: PORT, name: 'multi-window' });
const { js, until, check, sleep } = t;
const p = (n) => path.join(t.project, n);
const q = JSON.stringify;

async function attach(predicate) {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && predicate(x.url));
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
  const wjs = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`detached: ${expr}\n=> ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const wuntil = async (expr, label, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await wjs(expr)) return; } catch {} await sleep(150); }
    throw new Error(`timeout (detached): ${label}`);
  };
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { cdp, js: wjs, until: wuntil, close: () => ws.close() };
}
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').length;

const doc = (n) => `ide.getDocument(${q(p(n))})`;
const text = (n) => `${doc(n)}?.model.getValue()`;
const dirty = (n) => `ide.isDirty(ide.findTab(${q(p(n))}))`;
const append = (n, s) => `(() => { const m = ${doc(n)}.model; const l = m.getLineCount(); m.pushEditOperations([], [{ range: new ide.monaco.Range(l, m.getLineMaxColumn(l), l, m.getLineMaxColumn(l)), text: ${q(s)} }], () => null); return true; })()`;

const ROWS = [...Array(10).keys()].map((i) => `row${i}`).concat('');
// Runs `body` in a window after keeping that window busy for `ms`: what other windows send meanwhile waits, so the
// edits `body` makes are concurrent with theirs.
const busyThen = (ms, body) => `(setTimeout(() => { const end = Date.now() + ${ms}; while (Date.now() < end); ${body} }, 0), true)`;
const typeAt = (n, line, col, s) => `${doc(n)}.model.pushEditOperations([], [{ range: new ide.monaco.Range(${line}, ${col}, ${line}, ${col}), text: ${q(s)} }], () => null)`;
const removeLine = (n, line) => `${doc(n)}.model.pushEditOperations([], [{ range: new ide.monaco.Range(${line}, 1, ${line}, ${doc(n)}.model.getLineMaxColumn(${line})), text: '' }], () => null)`;

// Each scenario runs even when an earlier one failed.
const section = async (label, fn) => { try { await fn(); } catch (err) { check(false, `${label}: ${err.message}`); } };
let w;
try {
  for (const n of ['b.py', 'c.py', 'd.py', 'r.py', 'e.py', 'notes.txt', 'join.py']) writeFileSync(p(n), `# ${n}\nvalue = 1\n`);
  writeFileSync(p('eol.py'), ROWS.join('\n'));
  writeFileSync(p('crlf.py'), ROWS.join('\r\n'));
  for (const n of ['b.py', 'c.py', 'd.py', 'r.py', 'e.py', 'eol.py', 'crlf.py', 'join.py']) await js(`ide.openFile(${q(p(n))})`);
  await js(`ide.api.invoke('window:openDetached', { files: ${q(['b.py', 'c.py', 'd.py', 'r.py', 'notes.txt', 'eol.py', 'crlf.py'].map((n) => ({ path: p(n) })))} })`);
  w = await attach((url) => url.includes('detached=1'));
  await w.until(`window.__ideReady === true && ide.tabs.length >= 4`, 'detached window with its files');
  await sleep(500);

  // C3: edits made in both windows at the same moment are all kept, and both windows end with the same text.
  await section('concurrent edits', async () => {
    const N = 20;
    await Promise.all([
      js(`(async () => { for (let i = 0; i < ${N}; i++) { ${doc('c.py')}.model.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: 'M' + i + ' ' }], () => null); await new Promise(r => setTimeout(r, 15)); } return true; })()`),
      w.js(`(async () => { for (let i = 0; i < ${N}; i++) { const m = ${doc('c.py')}.model; const l = m.getLineCount(); m.pushEditOperations([], [{ range: new ide.monaco.Range(l, 1, l, 1), text: 'D' + i + ' ' }], () => null); await new Promise(r => setTimeout(r, 15)); } return true; })()`),
    ]);
    await sleep(1500);
    const mainC = await js(text('c.py'));
    const detC = await w.js(text('c.py'));
    const missing = [...Array(N).keys()].flatMap((i) => [`M${i} `, `D${i} `]).filter((s) => !mainC.includes(s) || !detC.includes(s));
    check(mainC === detC && !missing.length, `edits typed in both windows at once all survive, in both windows (missing ${missing.length}: ${missing.slice(0, 6).join(',')})`);
    await w.js(`ide.saveTab(ide.findTab(${q(p('c.py'))}))`);
    await until(`!${dirty('c.py')}`, 'main sees c.py saved', 8000);
    // Random inserts, deletes and replacements (also over each other's ranges and across lines) in both windows.
    const burst = `(async () => {
      const m = ${doc('c.py')}.model;
      for (let i = 0; i < 60; i++) {
        const v = m.getValue();
        const a = Math.floor(Math.random() * (v.length + 1));
        const b = Math.min(v.length, a + Math.floor(Math.random() * 6));
        const ins = ['', 'x', 'yz', '\\n', 'é한'][Math.floor(Math.random() * 5)];
        m.pushEditOperations([], [{ range: ide.monaco.Range.fromPositions(m.getPositionAt(a), m.getPositionAt(Math.random() < 0.5 ? a : b)), text: ins }], () => null);
        await new Promise(r => setTimeout(r, Math.random() * 8));
      }
      return true;
    })()`;
    await Promise.all([js(burst), w.js(burst)]);
    await sleep(1500);
    const [m2, d2] = [await js(text('c.py')), await w.js(text('c.py'))];
    check(m2 === d2, `random edits made at the same time in both windows end with the same text in both (${m2.length} / ${d2.length} characters)`);
    await w.js(`ide.saveTab(ide.findTab(${q(p('c.py'))}))`);
    await until(`!${dirty('c.py')}`, 'main sees c.py saved again', 8000);
    const savedMain = await js(text('c.py'));
    check(readFileSync(p('c.py'), 'utf8') === savedMain && await w.js(text('c.py')) === savedMain && !(await w.js(dirty('c.py'))),
      'saving in one window writes the shared text and both windows are clean');
  });

  // C7: a reload from disk in the main window leaves the detached window clean.
  await section('reload', async () => {
    writeFileSync(p('r.py'), '# changed on disk\n');
    await until(`${text('r.py')} === '# changed on disk\\n'`, 'main reloads r.py', 10000);
    await w.until(`${text('r.py')} === '# changed on disk\\n'`, 'detached gets the reloaded text', 8000);
    await sleep(500);
    check(!(await w.js(dirty('r.py'))), 'the detached window shows the reloaded file as unmodified');
  });

  // Convert line separators in one window while the other edits: the conversion carries no text, so the edits made
  // beside it keep their place, whichever reaches the main process first.
  await section('line separators converted during edits', async () => {
    const both = async () => [await js(text('eol.py')), await w.js(text('eol.py')), await js(`${doc('eol.py')}.model.getEOL()`), await w.js(`${doc('eol.py')}.model.getEOL()`)];
    const rows = [...ROWS];
    await js(busyThen(1200, `ide.lineSeparators.convert(${doc('eol.py')}, '\\r\\n')`));
    await w.js(`(${typeAt('eol.py', 5, 1, 'X')}, ${removeLine('eol.py', 9)}, true)`);
    rows[4] = 'Xrow4';
    rows[8] = '';
    await sleep(2500);
    let [m, d, me, de] = await both();
    check(m === d && m === rows.join('\r\n') && me === '\r\n' && de === '\r\n',
      `a conversion to CRLF made while the other window typed and deleted keeps both edits in place, in both windows (${q(m)} / ${q(d)}, ${q(me)} / ${q(de)})`);
    await w.js(busyThen(1200, `${typeAt('eol.py', 2, 5, 'Y')}; ${removeLine('eol.py', 7)}`));
    await js(`ide.lineSeparators.convert(${doc('eol.py')}, '\\n')`);
    rows[1] = 'row1Y';
    rows[6] = '';
    await sleep(2500);
    [m, d, me, de] = await both();
    check(m === d && m === rows.join('\n') && me === '\n' && de === '\n',
      `edits made while the other window converted to LF land where they were typed, in both windows (${q(m)} / ${q(d)}, ${q(me)} / ${q(de)})`);
    await w.js(`ide.saveTab(ide.findTab(${q(p('eol.py'))}))`);
    await until(`!${dirty('eol.py')}`, 'main sees eol.py saved', 8000);
    check(readFileSync(p('eol.py'), 'utf8') === rows.join('\n'), 'the converted file saves with its edits and LF');
  });

  // Random edits with line breaks in a CRLF file, made in both windows at once.
  await section('concurrent edits in a CRLF file', async () => {
    const burst = `(async () => {
      const m = ${doc('crlf.py')}.model;
      for (let i = 0; i < 60; i++) {
        const v = m.getValue();
        const a = Math.floor(Math.random() * (v.length + 1));
        const b = Math.min(v.length, a + Math.floor(Math.random() * 8));
        const ins = ['', 'x', '\\n', 'a\\r\\nb', '\\r\\n\\r\\n', 'é한'][Math.floor(Math.random() * 6)];
        m.pushEditOperations([], [{ range: ide.monaco.Range.fromPositions(m.getPositionAt(a), m.getPositionAt(Math.random() < 0.5 ? a : b)), text: ins }], () => null);
        await new Promise(r => setTimeout(r, Math.random() * 8));
      }
      return true;
    })()`;
    await Promise.all([js(burst), w.js(burst)]);
    await sleep(1500);
    const [m, d] = [await js(text('crlf.py')), await w.js(text('crlf.py'))];
    check(m === d && !/\r(?!\n)|(^|[^\r])\n/.test(m), `random edits with line breaks in a CRLF file end with the same CRLF text in both windows (${m.length} / ${d.length} characters)`);
    await js(`ide.saveTab(ide.findTab(${q(p('crlf.py'))}))`);
    await w.until(`!${dirty('crlf.py')}`, 'detached sees crlf.py saved', 8000);
    check(readFileSync(p('crlf.py'), 'utf8') === m, 'the CRLF file saves the shared text');
  });

  // Text typed in the window that opens a shared document before the shared text arrives is kept.
  await section('typing while joining', async () => {
    await js(append('join.py', '\nMAIN_UNSAVED = 1'));
    await js(busyThen(1500, ''));
    await w.js(`ide.openFile(${q(p('join.py'))}).then(() => (${typeAt('join.py', 1, 1, 'TYPED_EARLY ')}, true))`);
    await sleep(3000);
    const [m, d] = [await js(text('join.py')), await w.js(text('join.py'))];
    check(m === d && m.startsWith('TYPED_EARLY # join.py') && m.includes('MAIN_UNSAVED = 1'),
      `text typed while the shared text was on its way is kept, with the other window's unsaved edit, in both windows (${q(m)} / ${q(d)})`);
    await js(append('join.py', '\nAFTER = 2'));
    await w.until(`${text('join.py')}?.endsWith('AFTER = 2')`, 'later edits still shared', 8000).catch(() => {});
    check(await w.js(text('join.py')) === await js(text('join.py')), 'edits after the join are shared as before');
  });

  // C2: a rename in one window moves the document in the other, unsaved text included.
  await section('rename', async () => {
    await js(append('b.py', '\nMAIN_EDIT = 1'));
    await w.until(`${text('b.py')}?.includes('MAIN_EDIT')`, 'b.py edit synced', 8000);
    await js(`ide.api.rename(${q(p('b.py'))}, ${q(p('b2.py'))})`);
    await js(`ide.documentsMoved(${q(p('b.py'))}, ${q(p('b2.py'))})`);
    await w.until(`!!ide.findTab(${q(p('b2.py'))})`, 'detached follows the rename', 8000).catch(() => {});
    const state = (run) => run(`[!ide.findTab(${q(p('b.py'))}), !!ide.findTab(${q(p('b2.py'))}), !!${text('b2.py')}?.includes('MAIN_EDIT'), ${dirty('b2.py')}]`);
    const det = await state(w.js);
    check(det.every(Boolean), `after a rename in the main window, the detached window shows the new name with the unsaved edit still there (${det})`);
    const own = await state(js);
    check(own.every(Boolean), `the main window keeps its unsaved edit under the new name too (${own})`);
    await w.js(`(${append('b2.py', '\nDETACHED_EDIT = 2')}, ide.saveTab(ide.findTab(${q(p('b2.py'))})))`);
    await sleep(800);
    check(!existsSync(p('b.py')) && readFileSync(p('b2.py'), 'utf8').includes('DETACHED_EDIT') && readFileSync(p('b2.py'), 'utf8').includes('MAIN_EDIT'),
      'saving in the detached window writes b2.py and does not bring b.py back');
  });
  // The tree's Rename (core's moveTo, which calls ide.documentsMoved), as in the hunt's repro.
  await section('tree rename', async () => {
    await js(append('c.py', '\nTREE_EDIT = 1'));
    await w.until(`${text('c.py')}?.includes('TREE_EDIT')`, 'c.py edit synced', 8000);
    await js(`ide.moveTreeEntry({ name: 'c.py', path: ${q(p('c.py'))}, dir: false }, ${q(p('c3.py'))})`);
    await w.until(`!!ide.findTab(${q(p('c3.py'))})`, 'detached follows the tree rename', 8000).catch(() => {});
    const both = [await w.js(`!ide.findTab(${q(p('c.py'))}) && ${text('c3.py')}?.includes('TREE_EDIT') && ${dirty('c3.py')}`),
      await js(`!ide.findTab(${q(p('c.py'))}) && ${text('c3.py')}?.includes('TREE_EDIT') && ${dirty('c3.py')}`)];
    check(both.every(Boolean) && existsSync(p('c3.py')) && !existsSync(p('c.py')), `Rename in the project tree moves the modified document in both windows (${both})`);
  });
  await section('delete', async () => {
    unlinkSync(p('d.py'));
    await js(`ide.documentsMoved(${q(p('d.py'))}, null)`);
    await w.until(`!ide.findTab(${q(p('d.py'))})`, 'detached closes d.py', 8000).catch(() => {});
    check(await w.js(`!ide.findTab(${q(p('d.py'))})`) && await js(`!ide.findTab(${q(p('d.py'))})`), 'a delete in one window closes the file\'s tabs in every window');
  });

  // An explicit save of a file deleted outside PyIDE asks before recreating it.
  await section('save of a deleted file', async () => {
    await js(`ide.openFile(${q(p('e.py'))})`);
    await js(append('e.py', '\nKEEP = 1'));
    unlinkSync(p('e.py'));
    js(`ide.saveTab(ide.findTab(${q(p('e.py'))}))`).catch(() => {});
    await until(`!!document.querySelector('.dialog .dialog-message')`, 'gone-file question', 5000).catch(() => {});
    const asked = await js(`document.querySelector('.dialog .dialog-message')?.textContent || ''`);
    check(/e\.py/.test(asked) && !existsSync(p('e.py')), `saving a file that no longer exists asks first (${q(asked)})`);
    await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Cancel')?.click()`);
    await sleep(400);
    check(!existsSync(p('e.py')) && await js(dirty('e.py')), 'Cancel leaves it deleted and keeps the unsaved text');
  });

  // C8: File > Exit with unsaved changes only in the detached window asks once, before any window closes.
  await section('exit', async () => {
    await w.js(append('notes.txt', '\nUNSAVED_IN_DETACHED'));
    await w.until(dirty('notes.txt'), 'notes.txt dirty in the detached window');
    await js(`ide.closeTab(${q(p('e.py'))}, true)`);
    await sleep(300);
    js(`ide.runAction('Exit')`).catch(() => {});
    await sleep(1500);
    const openPages = await pages();
    const mainAsks = await js(`document.querySelector('.dialog-title')?.textContent || ''`).catch(() => '');
    const listed = await js(`document.querySelector('.dialog .close-confirm-list')?.textContent || ''`).catch(() => '');
    check(openPages === 2 && mainAsks === 'Save Changes?' && listed.includes('notes.txt'), `Exit keeps both windows and the main window lists notes.txt from the other window (${openPages} windows, ${q(mainAsks)}, ${q(listed)})`);
    await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Cancel')?.click()`).catch(() => {});
    await sleep(800);
    check((await pages()) === 2 && await w.js(dirty('notes.txt')), 'Cancel keeps every window open with its unsaved text');
    js(`ide.runAction('Exit')`).catch(() => {});
    await until(`!!document.querySelector('.dialog .close-confirm-list')`, 'asked again', 8000).catch(() => {});
    js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Save All')?.click()`).catch(() => {});
    for (let i = 0; i < 40 && (await pages().catch(() => 0)) > 0; i++) await sleep(250);
    check(readFileSync(p('notes.txt'), 'utf8').includes('UNSAVED_IN_DETACHED') && (await pages().catch(() => 0)) === 0, 'Save All saves the other window\'s file and then closes every window');
  });
  w.close();
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
