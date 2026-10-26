// A .py file as a visual script (renderer/features/visual-script/index.js, python/py2flow.py): Show as Visual Script
// opens a read-only canvas beside the file that follows it as it is typed (a syntax error dims the last graph), a click
// on a node selects its line and the caret selects the node of its line, nothing on the canvas edits it (drag, Delete,
// double-click, Ctrl+Z), Convert to Visual Script writes <name>.pyflow that opens and compiles and asks before it
// overwrites, the editor and tree menus offer both, closing the file closes its preview, and a Korean session shows no
// English in the preview. Ports 9068-9069.
import { launch, menuRow, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const PREVIEW = `document.querySelector('.vs-preview')`;
const nodeCount = `${PREVIEW}?.querySelectorAll('.vs-node').length || 0`;

async function mouse(t, p, { button = 'left', clickCount = 1 } = {}) {
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount });
}
const center = (t, expr) => t.js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + Math.min(30, r.width / 2), y: r.y + Math.min(12, r.height / 2) }; })()`);
// The preview node whose statement starts on `line` (the step, not a value inside it).
const nodeOnLine = (line) => `(() => { const p = ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview;
  const ids = Object.entries(p.lines()).filter(([, r]) => r[0] === ${line}).map(([id]) => id);
  const steps = ids.filter((id) => ['var.set', 'io.print', 'flow.if', 'flow.forEach', 'py.call', 'fn.return'].includes(p.view.graph().nodes.find((n) => n.id === id)?.type));
  return steps[0] || ids[0] || null; })()`;
const nodeEl = (id) => `${PREVIEW}.querySelector('.vs-node[data-id="${id}"]')`;
const caretLine = `ide.editors().find((e) => e.getModel() === ide.getDocument(ide.util.joinPath(ide.root, 'app.py')).model).getPosition().lineNumber`;

async function opened(t) {
  await openFile(t, 'app.py');
  await t.js(`(ide.runAction('VisualScript.ShowAsFlow'), true)`);
  await t.until(`${PREVIEW}?.dataset.preview === 'ok' && ${nodeCount} > 5`, 'preview drawn', 30000);
}

// ---------------- English ----------------
const t = await launch({ fixture: 'visual-script-preview', port: 9068, name: 'visual-script-preview' });
const { js, until, check, sleep, press, type } = t;
try {
  await until(`ide.actions.some((a) => a.id === 'VisualScript.ShowAsFlow')`, 'visual-script actions');
  await openFile(t, 'app.py');

  // Menus: the editor's context menu and the project tree offer the preview and the conversion.
  const lines = await center(t, `document.querySelector('.editor-host .monaco-editor .view-lines')`);
  await mouse(t, lines, { button: 'right' });
  await until(`!!${menuRow('Show as Visual Script')}`, 'editor menu item').then(() => check(true, 'the editor context menu of a .py file offers Show as Visual Script'),
    () => check(false, 'the editor context menu of a .py file offers Show as Visual Script'));
  await press('Escape');
  check(await js(`ide.treeActions?.some?.((a) => a.title === 'Convert to Visual Script…') ?? true`), 'the project tree offers Convert to Visual Script…');

  await opened(t);
  check(await js(`ide.groups().length === 2 && ide.activeTab()?.path.startsWith('visual-script-preview:')`), 'the preview opens in a pane to the right');
  check(await js(`!${PREVIEW}.querySelector('.vs-add')`), 'the preview has no Add Node button');
  check(await js(`[...${PREVIEW}.querySelectorAll('.vs-node .vs-field')].every((f) => f.readOnly || f.disabled)`), 'every field in the preview is read-only');
  const types = await js(`ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.graph().nodes.map((n) => n.type)`);
  check(['fn.define', 'fn.return', 'flow.forEach', 'flow.if', 'var.set', 'py.call', 'io.print', 'ui.comment'].every((x) => types.includes(x)) && !types.includes('py.code'),
    `the file is nodes only (${J([...new Set(types)])})`);
  check(/Every statement is a node/.test(await js(`${PREVIEW}.querySelector('.vs-preview-note').textContent`)), 'the note says every statement is a node');

  // Read-only: a drag, Delete, a double-click and Ctrl+Z change nothing.
  const graphText = `ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.graph() && JSON.stringify(ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.graph())`;
  const before = await js(graphText);
  const printId = await js(nodeOnLine(10));
  check(!!printId, `line 10 has a node (${printId})`);
  await js(`(ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.centerOn(${J(printId)}), true)`);
  await sleep(300);
  const p = await center(t, `${nodeEl(printId)}.querySelector('.vs-title')`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await t.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + i * 20, y: p.y + i * 10, button: 'left', buttons: 1 });
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 100, y: p.y + 50, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  check(await js(graphText) === before, 'dragging a node changes nothing');
  check(await js(`ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.selection().join()`) === printId, 'a click selects the node');
  await until(`${caretLine} === 10`, 'caret follows the node').then(() => check(true, 'selecting a node puts the caret on its line in app.py'),
    async () => check(false, `selecting a node puts the caret on its line in app.py (${await js(caretLine)})`));
  await press('Delete');
  await press('Ctrl+Z');
  await sleep(200);
  check(await js(graphText) === before && await js(nodeCount) === JSON.parse(before).nodes.length, 'Delete and Ctrl+Z change nothing');
  const empty = await js(`(() => { const r = ${PREVIEW}.querySelector('.vs-canvas').getBoundingClientRect(); return { x: r.right - 30, y: r.bottom - 30 }; })()`);
  await mouse(t, empty, { clickCount: 2 });
  await sleep(200);
  check(await js(`!document.querySelector('.vs-palette')`), 'a double-click opens no node palette');

  // The caret selects the node of its line.
  const editorLine = async (line) => js(`(() => { const e = ide.editors().find((x) => x.getModel() === ide.getDocument(ide.util.joinPath(ide.root, 'app.py')).model);
    const v = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 3 }); const r = e.getDomNode().getBoundingClientRect(); return { x: r.x + v.left + 2, y: r.y + v.top + v.height / 2 }; })()`);
  await mouse(t, await editorLine(7));
  const totalId = await js(nodeOnLine(7));
  await until(`ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.selection().join() === ${J(totalId)}`, 'node follows caret')
    .then(() => check(true, 'a click on line 7 selects its Set Variable in the preview'), () => check(false, 'a click on line 7 selects its Set Variable in the preview'));

  // The preview follows typing, and a syntax error keeps the last graph dimmed.
  const v0 = await js(`${PREVIEW}.dataset.version`);
  await js(`(() => { const e = ide.editors().find((x) => x.getModel() === ide.getDocument(ide.util.joinPath(ide.root, 'app.py')).model);
    const m = e.getModel(); e.focus(); e.setPosition({ lineNumber: m.getLineCount(), column: m.getLineMaxColumn(m.getLineCount()) }); return true; })()`);
  await press('Enter');
  await type('print("added")');
  await until(`${PREVIEW}.dataset.version !== ${J(v0)} && JSON.stringify(ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py'))).preview.view.graph()).includes('added')`, 'preview updated', 20000)
    .then(() => check(true, 'typing a line in app.py adds its node to the preview'), () => check(false, 'typing a line in app.py adds its node to the preview'));
  await press('Enter');
  await type('if :');
  await until(`${PREVIEW}.classList.contains('vs-preview-stale')`, 'stale', 20000).then(() => check(true, 'a syntax error dims the preview'), () => check(false, 'a syntax error dims the preview'));
  check(/^Line \d+: /.test(await js(`${PREVIEW}.querySelector('.vs-preview-note').textContent`)), `the note names the line of the error (${await js(`${PREVIEW}.querySelector('.vs-preview-note').textContent`)})`);
  check(await js(nodeCount) > 5, 'the last graph stays shown');
  await press('Ctrl+Z');
  await press('Ctrl+Z');
  await until(`!${PREVIEW}.classList.contains('vs-preview-stale')`, 'fresh', 20000).then(() => check(true, 'undoing the error shows the graph again'), () => check(false, 'undoing the error shows the graph again'));

  // Convert to Visual Script writes app.pyflow and opens it; a second conversion asks before it overwrites.
  await js(`(ide.openCustomTab({ id: 'visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py')) }), true)`);
  await mouse(t, await center(t, `${PREVIEW}.querySelector('.vs-convert')`));
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('app.pyflow') && !!ide.activeTab().visualScript?.graph()`, 'converted script opened', 30000);
  const converted = await js(`(() => { const g = ide.activeTab().visualScript.graph(); const r = PyideVisualScript.compile(g, { fileName: 'app.pyflow' }); return { nodes: g.nodes.length, errors: r.errors.filter((e) => !e.warning).length, code: r.code }; })()`);
  check(converted.nodes > 5 && converted.errors === 0, `Convert to Visual Script opens app.pyflow, which compiles (${converted.nodes} nodes, ${converted.errors} problems)`);
  check(await js(`ide.notifications.list().some((n) => /Converted app\\.py to app\\.pyflow/.test(n.title))`), 'a notification says what was converted');
  await openFile(t, 'app.py');
  await js(`(ide.runAction('VisualScript.ConvertFromPython'), true)`);
  await until(`[...document.querySelectorAll('.dialog')].some((d) => /already exists/.test(d.textContent))`, 'overwrite question')
    .then(() => check(true, 'converting again asks before overwriting app.pyflow'), () => check(false, 'converting again asks before overwriting app.pyflow'));
  await press('Escape');

  // Closing the file (every tab of it) closes its preview.
  await js(`(async () => { for (const tab of ide.groups().flatMap((g) => g.tabs).filter((x) => x.kind === 'file' && ide.util.samePath(x.path, ide.util.joinPath(ide.root, 'app.py')))) await ide.closeTabObject(tab, true); return true; })()`);
  await until(`!ide.findTab('visual-script-preview:' + ide.util.pathKey(ide.util.joinPath(ide.root, 'app.py')))`, 'preview closed')
    .then(() => check(true, 'closing app.py closes its preview'), () => check(false, 'closing app.py closes its preview'));
} catch (err) {
  check(false, err.message);
}
t.close();
const earlier = t.results;

// ---------------- Korean ----------------
const k = await launch({ fixture: 'visual-script-preview', port: 9069, name: 'visual-script-preview-ko', lang: 'ko-KR' });
k.results.push(...earlier);
try {
  await k.until(`ide.actions.some((a) => a.id === 'VisualScript.ShowAsFlow')`, 'visual-script actions');
  await opened(k);
  k.check(await k.js(`ide.activeTab().title`) === 'app.py (비주얼 스크립트)', `the preview tab is titled in Korean (${await k.js('ide.activeTab().title')})`);
  k.check(await k.js(`${PREVIEW}.querySelector('.vs-preview-note').textContent`) === '모든 문장이 노드입니다.', 'the note is Korean');
  const leaks = await englishLeaks(k, '.vs-preview .vs-toolbar, .vs-preview .vs-status');
  k.check(!leaks.length, `the preview's toolbar and status have no English (${J(leaks)})`);
  const missing = await missingTranslations(k);
  k.check(!missing.length, `every string the session used has a Korean entry (${J(missing)})`);
} catch (err) {
  k.check(false, err.message);
}
k.finish();
