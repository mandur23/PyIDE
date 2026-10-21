// Monaco previews of a definition in a file with no tab: Peek Definition, Ctrl+hover and the references peek used to
// reject with "Model not found" (reported from an installed 0.2.1). The target now gets a preview model read from disk,
// and a tab opened later takes it over with the current disk text.
import { appendFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'lsp', port: 9260, name: 'peek-definition' });
const { js, until, press, check, cdp, sleep } = t;
const S = JSON.stringify;
const models = path.join(t.project, 'models.py');
const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), ide.editor.revealPositionInCenter({ lineNumber: ${line}, column: ${col} }), true)`);
const shown = `n => n.getClientRects().length > 0 && n.getBoundingClientRect().height > 0 && getComputedStyle(n).visibility !== 'hidden'`;
const peekText = () => js(`[...document.querySelectorAll('.peekview-widget .view-lines')].filter(${shown}).map(n => n.textContent).join(' | ')`);
const rejections = () => js('window.__rejections.splice(0)');
const hasModel = () => js(`!!ide.monaco.editor.getModel(ide.monaco.Uri.file(${S(models)}))`);

try {
  await js(`(window.__rejections = [], addEventListener('unhandledrejection', (e) => window.__rejections.push(String(e.reason?.message || e.reason))), true)`);
  await until(`document.querySelector('#lspStatus')?.textContent === 'Pyright: ready'`, 'Pyright ready', 30000);
  await openFile(t, 'app.py');
  check(!(await hasModel()), 'models.py has no model before (no tab)');

  // The bug, with the preview models turned off: the peek rejects with "Model not found".
  await js('(window.__savedPreview = ide.previewModel, ide.previewModel = undefined, true)');
  await caret(5, 16);
  await js(`(ide.editor.trigger('test', 'editor.action.peekDefinition', null), true)`);
  await until(`window.__rejections.some((m) => /Model not found/.test(m))`, 'Model not found without preview models', 15000);
  check(true, 'without preview models Peek Definition rejects with "Model not found" (the reported bug)');
  await press('Escape');
  await js('(ide.previewModel = window.__savedPreview, true)');
  await rejections();
  // That deliberate rejection is not a renderer exception of the fixed code.
  await sleep(500);
  for (let i = t.consoleErrors.length - 1; i >= 0; i--) if (/Model not found/.test(t.consoleErrors[i])) t.consoleErrors.splice(i, 1);

  // Peek Definition into the closed models.py.
  await caret(5, 16);
  await js(`(ide.editor.trigger('test', 'editor.action.peekDefinition', null), true)`);
  await until(`[...document.querySelectorAll('.peekview-widget .view-lines')].filter(${shown}).some((n) => n.textContent.replace(/\\u00a0/g, ' ').includes('def make_greeter'))`, 'peek shows make_greeter', 15000);
  check(true, `Peek Definition shows the definition from the closed file (${(await peekText()).slice(0, 60)}…)`);
  check(await hasModel(), 'models.py got a preview model');
  check(await js(`ide.activeTab()?.title === 'app.py' && !ide.findTab(${S(models)})`), 'no tab was opened for it');
  await press('Escape');

  // Ctrl+hover over a name defined in the closed file (Monaco's definition link and preview).
  await js(`(() => { const m = ide.monaco.editor.getModel(ide.monaco.Uri.file(${S(models)})); m && m.dispose(); return true; })()`);
  check(!(await hasModel()), 'the preview model is gone before the hover');
  await caret(8, 13);
  const at = await js(`(() => {
    const ed = ide.editor, p = ed.getScrolledVisiblePosition({ lineNumber: 8, column: 13 }), r = ed.getDomNode().getBoundingClientRect();
    return { x: Math.round(r.left + p.left + 4), y: Math.round(r.top + p.top + p.height / 2) };
  })()`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
  for (const dx of [0, 2, 4]) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + dx, y: at.y, modifiers: 2 });
  await until(`!!document.querySelector('.goto-definition-link')`, 'Ctrl+hover link', 15000);
  await sleep(1500);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  check(true, 'Ctrl+hover underlines the name defined in the closed file');
  check(await hasModel(), 'Ctrl+hover loaded the target as a preview model');

  // The references peek lists usages from closed files too.
  await caret(1, 21);
  await js(`(ide.editor.trigger('test', 'editor.action.referenceSearch.trigger', null), true)`);
  await until(`[...document.querySelectorAll('.peekview-widget .monaco-list-row')].filter(${shown}).length >= 2`, 'references peek rows', 15000);
  check(true, 'the references peek lists usages');
  await press('Escape');

  const rej = await rejections();
  check(!rej.some((m) => /Model not found/.test(m)), `no "Model not found" rejections (${S(rej)})`);

  // A tab opened later takes the preview model over with the current disk text.
  appendFileSync(models, '\n# changed on disk after the preview\n');
  await openFile(t, 'models.py');
  await until(`ide.activeTab()?.title === 'models.py'`, 'models.py tab');
  check(await js(`ide.editor.getModel().getValue().includes('changed on disk after the preview')`), 'the tab shows the disk text, not the older preview');
  check(await js(`!ide.isDirty(ide.activeTab())`), 'and it is not marked modified');
  check(await js(`ide.editor.getModel().uri.toString() === ide.monaco.Uri.file(${S(models)}).toString()`), 'the tab uses the same model uri as the previews');
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.finish();
