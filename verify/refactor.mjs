// End-to-end check for the refactorings (renderer/features/refactor, main/features/refactor.js) and inlay hints
// (renderer/features/inlay-hints) on a multi-file fixture: real rope refactorings through PyCharm's keys, the
// resulting code and imports, the preview and its Cancel, one undo step per refactoring across files, errors, the
// rope install offer, and the Korean UI. The fixture program's output is compared before and after.
// The suite keeps a venv with rope in verify/out/refactor-venv (created on the first run). Ports 9690-9691.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const VENV = path.join(OUT, 'refactor-venv');
const VENV_PY = path.join(VENV, 'Scripts', 'python.exe');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 600000, windowsHide: true, ...opts });

function ensureVenv() {
  if (existsSync(VENV_PY)) {
    try { run(VENV_PY, ['-c', 'import rope']); return; } catch {}
  } else {
    console.log('creating verify/out/refactor-venv (one time)…');
    try { run('py', ['-3', '-m', 'venv', VENV]); } catch { run('python', ['-m', 'venv', VENV]); }
  }
  run(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'rope']);
}
ensureVenv();

// A venv without rope (and without pip, so it is quick to make), for the install offer.
function bareVenv() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-rf-bare-')), 'venv');
  run(run(VENV_PY, ['-c', 'import sys; print(sys._base_executable)']).trim(), ['-m', 'venv', '--without-pip', dir]);
  return path.join(dir, 'Scripts', 'python.exe');
}

async function useInterpreter(t, exe) {
  await t.js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${JSON.stringify(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${JSON.stringify(exe)});
  })()`);
  await t.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${JSON.stringify(exe)})`, 'interpreter selected');
}

const MINE = ['renderer/features/refactor/index.js', 'renderer/features/inlay-hints/index.js']
  .map((f) => readFileSync(path.join(HERE, '..', f), 'utf8')).join('\n');

// ---------- helpers bound to an instance ----------
function helpers(t) {
  const { js, until, press } = t;
  const P = (rel) => path.join(t.project, rel);
  const disk = (rel) => readFileSync(P(rel), 'utf8').replace(/\r\n/g, '\n');
  const text = () => js(`ide.editor.getModel().getValue(1)`);
  // 1-based position of the nth match of `needle` in the active model (offset moves inside the match).
  const posOf = (needle, nth = 0, offset = 0) => js(`(() => {
    const m = ide.editor.getModel(); const v = m.getValue(1); let i = -1;
    for (let k = 0; k <= ${nth}; k++) { i = v.indexOf(${JSON.stringify(needle)}, i + 1); if (i < 0) return null; }
    const p = m.getPositionAt(i + ${offset}); return { line: p.lineNumber, col: p.column };
  })()`);
  async function select(needle, nth = 0) {
    const a = await posOf(needle, nth);
    if (!a) throw new Error(`"${needle}" not found`);
    const b = await posOf(needle, nth, needle.length);
    await js(`(ide.editor.focus(), ide.editor.setSelection(new monaco.Range(${a.line}, ${a.col}, ${b.line}, ${b.col})), true)`);
  }
  async function caret(needle, nth = 0, offset = 0) {
    const a = await posOf(needle, nth, offset);
    if (!a) throw new Error(`"${needle}" not found`);
    await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${a.line}, column: ${a.col} }), true)`);
  }
  const dialog = (id) => until(`!!document.querySelector('#${id}')`, `#${id}`, 30000);
  const gone = (id) => until(`!document.querySelector('#${id}')`, `#${id} closed`, 30000);
  const setInput = (sel, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); return true; })()`);
  const button = (id, action) => t.click(`#${id} [data-action="${action}"]`);
  const hintText = () => js(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].map(n => n.textContent).join(' | ')`);
  const errorIn = (id) => js(`document.querySelector('#${id} .rf-error')?.textContent || ''`);
  async function waitText(pred, label, ms = 30000) {
    await until(`(() => { const v = ide.editor.getModel().getValue(1); return (${pred})(v); })()`, label, ms);
  }
  return { P, disk, text, posOf, select, caret, dialog, gone, setInput, button, hintText, errorIn, waitText, press };
}

// ======================================================================
const t = await launch({ fixture: 'refactor', port: 9690 });
const { js, until, press, type, check, shot, sleep } = t;
const h = helpers(t);
// The program runs from disk, so unsaved editor changes are saved first.
const appOutput = async () => { await js('ide.saveAll()'); return run(VENV_PY, ['app.py'], { cwd: t.project }).replace(/\r\n/g, '\n'); };

try {
  await useInterpreter(t, VENV_PY);
  await until(`document.querySelector('#lspStatus')?.textContent === 'Pyright: ready'`, 'Pyright ready', 60000);
  const baseline = await appOutput();
  check(baseline.includes('29.25'), 'fixture program runs before refactoring');

  // ---- keys and menus ----
  const keys = await js(`Object.fromEntries(['IntroduceVariable','IntroduceConstant','IntroduceParameter','ExtractMethod','Inline','ChangeSignature','Move','Refactorings.QuickListPopupAction'].map(id => [id, ide.keysFor(id)]))`);
  check(keys.IntroduceVariable === 'Ctrl+Alt+V' && keys.IntroduceConstant === 'Ctrl+Alt+C' && keys.IntroduceParameter === 'Ctrl+Alt+P'
    && keys.ExtractMethod === 'Ctrl+Alt+M' && keys.Inline === 'Ctrl+Alt+N' && keys.ChangeSignature === 'Ctrl+F6' && keys.Move === 'F6'
    && keys['Refactorings.QuickListPopupAction'] === 'Ctrl+Alt+Shift+T', `PyCharm keys (${JSON.stringify(keys)})`);

  await openFile(t, 'shop/pricing.py');
  const original = await h.text();

  // ---- Refactor This popup ----
  await h.caret('net_price(price', 0, 2);
  await press('Ctrl+Alt+Shift+T');
  await until(`!!document.querySelector('#rfRefactorThis')`, 'Refactor This popup');
  const menuText = await js(`document.querySelector('#rfRefactorThis').innerText`);
  check(['Refactor This', 'Rename…', 'Change Signature…', 'Move…', 'Inline…', 'Extract Variable…', 'Extract Constant…', 'Extract Parameter…', 'Extract Method…'].every((s) => menuText.includes(s)),
    'Ctrl+Alt+Shift+T lists the refactorings with their keys');
  check(/Ctrl\+Alt\+M/.test(menuText) && /Ctrl\+F6/.test(menuText), 'the popup shows each key');
  await press('Escape');
  await until(`!document.querySelector('#rfRefactorThis')`, 'popup closed');
  const refactorMenu = await js(`(() => { document.querySelector('#mainMenuBtn').click(); const row = [...document.querySelectorAll('#mainMenu .menu-item')].find(r => r.textContent.trim().startsWith('Refactor')); row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
  await until(`document.querySelectorAll('.context-menu').length > 1`, 'Refactor submenu').catch(() => {});
  const sub = await js(`[...document.querySelectorAll('.context-menu')].slice(1).map(m => m.innerText).join('\\n')`);
  check(refactorMenu && /Extract Method…/.test(sub) && /Change Signature…/.test(sub) && /Move…/.test(sub), 'main menu Refactor lists the refactorings');
  await press('Escape'); await press('Escape');
  await js(`document.querySelectorAll('.context-menu').forEach(m => m.remove()), true`);

  // ---- Extract Variable (Ctrl+Alt+V), one undo step ----
  await h.select('subtotal * 0.1');
  await press('Ctrl+Alt+V');
  await h.dialog('rfExtractDialog');
  check(await js(`document.querySelector('#rfExtractDialog .rf-name').value`) === 'product', 'suggests a name from the expression ("product")');
  check(await js(`document.querySelector('#rfExtractDialog .rf-expression').textContent`) === 'subtotal * 0.1', 'dialog shows the expression');
  await h.setInput('#rfExtractDialog .rf-name', 'discount');
  await press('Enter');
  await h.gone('rfExtractDialog');
  await h.waitText((v) => v.includes('    discount = subtotal * 0.1\n    return subtotal - discount\n'), 'variable extracted');
  check(true, 'Extract Variable inserts the assignment and uses the name');
  check(await js(`ide.editor.getModel().getValueInRange(ide.editor.getSelection())`) === 'discount', 'the new name is selected afterwards');
  await shot('extract-variable.png');
  await press('Ctrl+Z');
  await until(`ide.editor.getModel().getValue(1) === ${JSON.stringify(original)}`, 'undo').catch(() => {});
  check(await h.text() === original, 'one Ctrl+Z restores the file exactly');

  // ---- expression chooser with no selection ----
  await h.caret('value * 100', 0, 1);
  await press('Ctrl+Alt+V');
  await until(`document.querySelector('#popup') && !document.querySelector('#popup').classList.contains('hidden')`, 'expression chooser').catch(() => {});
  const choices = await js(`[...document.querySelectorAll('#popupList .popup-item, #popupList > *')].map(n => n.textContent.trim())`);
  check(choices.some((c) => c.startsWith('value * 100')) && choices.some((c) => c === 'value'), `no selection offers the surrounding expressions (${choices.join(' / ')})`);
  await press('Escape');

  // ---- Extract Constant (Ctrl+Alt+C) ----
  await h.select('0.1');
  await press('Ctrl+Alt+C');
  await h.dialog('rfExtractDialog');
  check(await js(`document.querySelector('#rfExtractDialog .rf-name').value`) === 'NUMBER', 'constant names are upper case');
  await h.setInput('#rfExtractDialog .rf-name', 'DISCOUNT_RATE');
  await press('Enter');
  await h.waitText((v) => v.includes('DISCOUNT_RATE = 0.1'), 'constant extracted');
  const afterConst = await h.text();
  check(afterConst.startsWith('"""Prices and discounts."""\nimport math\n\nDISCOUNT_RATE = 0.1\n\n\ndef net_price'), 'the constant goes after the imports with PEP 8 blank lines');
  check(afterConst.includes('return subtotal - subtotal * DISCOUNT_RATE'), 'the expression is replaced by the constant');

  // errors are explained
  await h.select('subtotal * DISCOUNT_RATE');
  await press('Ctrl+Alt+C');
  await until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some(n => /local variable 'subtotal'/.test(n.textContent))`, 'local variable hint');
  check(true, "Extract Constant on an expression using a local explains why (\"uses local variable 'subtotal'\")");
  await press('Escape');

  // ---- Extract Parameter (Ctrl+Alt+P): Preview, then Cancel leaves everything as it was ----
  await h.select('100');
  await press('Ctrl+Alt+P');
  await h.dialog('rfExtractDialog');
  await h.setInput('#rfExtractDialog .rf-name', 'scale');
  await h.button('rfExtractDialog', 'preview');
  await h.dialog('rfPreview');
  await until(`document.querySelectorAll('#rfPreviewFiles .rf-file').length === 1`, 'preview file list');
  check(await js(`document.querySelector('#rfPreviewFiles .rf-file').dataset.path.endsWith('pricing.py')`), 'preview lists the changed file');
  await until(`document.querySelectorAll('#rfPreview .monaco-diff-editor .line-insert, #rfPreview .monaco-diff-editor .char-insert').length > 0`, 'preview diff').catch(() => {});
  const diffShows = `[...document.querySelectorAll('#rfPreview .monaco-diff-editor .modified .view-line')].some(l => l.textContent.replace(/\\u00a0/g, ' ').includes('def rounded(value, scale=100):'))`;
  await until(diffShows, 'preview diff').catch(() => {});
  check(await js(diffShows), 'preview diff shows the new signature');
  await shot('preview.png');
  await h.button('rfPreview', 'cancel');
  await h.gone('rfPreview');
  check(await h.text() === afterConst, 'Cancel in the preview changes nothing');

  await h.select('100');
  await press('Ctrl+Alt+P');
  await h.dialog('rfExtractDialog');
  await h.setInput('#rfExtractDialog .rf-name', 'scale');
  await h.button('rfExtractDialog', 'preview');
  await h.dialog('rfPreview');
  await h.button('rfPreview', 'apply');
  await h.waitText((v) => v.includes('def rounded(value, scale=100):\n    return math.floor(value * scale + 0.5) / scale'), 'parameter extracted');
  check(true, 'Do Refactor applies Extract Parameter (default value, all occurrences)');

  // ---- Extract Method (Ctrl+Alt+M) ----
  await h.select('    print("total", rounded(total))\n    print("tax", rounded(total * 0.2))\n');
  await press('Ctrl+Alt+M');
  await h.dialog('rfExtractMethodDialog');
  await h.setInput('#rfExtractMethodDialog .rf-name', 'print_totals');
  await press('Enter');
  await h.waitText((v) => v.includes('def print_totals(total):'), 'method extracted');
  const afterMethod = await h.text();
  check(afterMethod.includes('    total = net_price(price, quantity)\n    print_totals(total)\n    return total\n\n\ndef print_totals(total):\n    print("total", rounded(total))\n    print("tax", rounded(total * 0.2))\n\n\nclass Cart:'),
    'Extract Method creates the function with its parameter and PEP 8 spacing');
  await h.caret('net_price(price', 0, 0);
  await press('Ctrl+Alt+M');
  await until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some(n => /Select a code fragment/.test(n.textContent))`, 'no selection hint');
  check(true, 'Extract Method without a selection asks for a code fragment');
  await press('Escape');

  // ---- Inline (Ctrl+Alt+N) ----
  await h.caret('subtotal', 1, 1);
  await press('Ctrl+Alt+N');
  await h.dialog('rfInlineDialog');
  const inlineOptions = await js(`[...document.querySelectorAll('#rfInlineDialog .rf-radio')].map(r => r.textContent)`);
  check(inlineOptions.includes('Inline all and remove the variable') && inlineOptions.includes('Inline this only and keep the variable'), `inline offers PyCharm's choices (${inlineOptions.join(' / ')})`);
  await press('Enter');
  await h.waitText((v) => v.includes('    return price * quantity - price * quantity * DISCOUNT_RATE\n'), 'variable inlined');
  check(!(await h.text()).includes('subtotal ='), 'Inline Variable removes the assignment');
  await h.caret('import math', 0, 2);
  await press('Ctrl+Alt+N');
  await until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some(n => /Caret should be positioned/.test(n.textContent))`, 'inline error hint');
  check(true, 'Inline on an import explains where the caret should be');
  await press('Escape');

  // ---- Change Signature (Ctrl+F6) across files, undo and redo as one step ----
  await press('Ctrl+S');
  const beforeSig = { pricing: await h.text(), app: h.disk('app.py'), daily: h.disk('reports/daily.py') };
  await h.caret('def net_price', 0, 5);
  await press('Ctrl+F6');
  await h.dialog('rfSignatureDialog');
  check(await js(`[...document.querySelectorAll('#rfSignatureDialog .rf-param-name')].map(i => i.value).join(',')`) === 'price,quantity', 'Change Signature lists the parameters');
  await h.setInput('#rfSignatureDialog .rf-name', 'line_total');
  await js(`(document.querySelectorAll('#rfSignatureDialog .rf-param-name')[1].dispatchEvent(new Event('focus')), true)`);
  await t.click('#rfSignatureDialog .rf-up');
  await t.click('#rfSignatureDialog .rf-add');
  await js(`(() => { const rows = document.querySelectorAll('#rfSignatureDialog .rf-param'); const r = rows[rows.length - 1];
    const set = (sel, v) => { const i = r.querySelector(sel); i.value = v; i.dispatchEvent(new Event('input')); };
    set('.rf-param-name', 'rate'); set('.rf-param-default', 'DISCOUNT_RATE'); return true; })()`);
  check(await js(`document.querySelector('#rfSignatureDialog .rf-signature-preview').textContent`) === 'line_total(quantity, price, rate=DISCOUNT_RATE)', 'the signature preview follows the edits');
  await shot('change-signature.png');
  await h.button('rfSignatureDialog', 'preview');
  await h.dialog('rfPreview');
  const sigFiles = await js(`[...document.querySelectorAll('#rfPreviewFiles .rf-file')].map(r => r.dataset.path.split('\\\\').pop())`);
  check(['app.py', 'daily.py', 'pricing.py'].every((f) => sigFiles.includes(f)), `the preview lists every file with calls (${sigFiles.join(', ')})`);
  await h.button('rfPreview', 'apply');
  await h.waitText((v) => v.includes('def line_total(quantity, price, rate=DISCOUNT_RATE):'), 'signature changed');
  const sigApp = h.disk('app.py');
  const sigDaily = h.disk('reports/daily.py');
  check(sigApp.startsWith('from shop.pricing import Cart, line_total, receipt, rounded\n') && sigApp.includes('print(rounded(line_total(5, 4.0)))'), 'calls and imports in a closed file are updated (app.py)');
  check(sigDaily.includes('money(pricing.line_total(q, p))'), 'module-qualified calls are updated (reports/daily.py)');
  check((await h.text()).includes('return sum(line_total(q, p) for p, q in self.items)') && (await h.text()).includes('total = line_total(quantity, price)'), 'calls in the same file are reordered');
  check((await appOutput()) === baseline, 'the program prints the same after the signature change');
  await js(`ide.editor.focus(), true`);
  await press('Ctrl+Z');
  await until(`ide.editor.getModel().getValue(1) === ${JSON.stringify(beforeSig.pricing)}`, 'signature undone in the editor');
  await until(`(async () => (await ide.api.read(ide.util.joinPath(ide.root, 'app.py'))).replace(/\\r\\n/g, '\\n') === ${JSON.stringify(beforeSig.app)})()`, 'app.py restored');
  check(h.disk('reports/daily.py') === beforeSig.daily, 'one Ctrl+Z undoes the refactoring in every file');
  await press('Ctrl+Shift+Z');
  await h.waitText((v) => v.includes('def line_total(quantity, price, rate=DISCOUNT_RATE):'), 'redo');
  await until(`(async () => (await ide.api.read(ide.util.joinPath(ide.root, 'app.py'))).includes('line_total(5, 4.0)'))()`, 'redo in app.py');
  check(h.disk('reports/daily.py') === sigDaily, 'Ctrl+Shift+Z redoes it in every file');
  await press('Ctrl+S');

  // errors stay in the dialog
  await h.caret('def line_total', 0, 5);
  await press('Ctrl+F6');
  await h.dialog('rfSignatureDialog');
  await js(`(() => { const i = document.querySelectorAll('#rfSignatureDialog .rf-param-name')[0]; i.value = 'not valid'; i.dispatchEvent(new Event('input')); return true; })()`);
  await h.button('rfSignatureDialog', 'refactor');
  await until(`/not a valid identifier/.test(document.querySelector('#rfSignatureDialog .rf-error')?.textContent || '')`, 'invalid name error');
  check(true, 'an invalid parameter name is reported in the dialog, which stays open');
  await h.button('rfSignatureDialog', 'cancel');
  await h.caret('"""Prices', 0, 4);
  await press('Ctrl+F6');
  await until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some(n => /name of a function or method/.test(n.textContent))`, 'change signature error hint');
  check(true, 'Change Signature away from a function explains where the caret should be');
  await press('Escape');

  // ---- Move (F6) a top-level function to another module, imports rewritten ----
  await h.caret('def rounded', 0, 5);
  await press('F6');
  await h.dialog('rfMoveDialog');
  check(/Move function 'rounded' from shop\.pricing/.test(await js(`document.querySelector('#rfMoveDialog .rf-message').textContent`)), 'Move names the function and its module');
  await h.setInput('#rfMoveDialog .rf-dest', 'shop\\pricing.py');
  await h.button('rfMoveDialog', 'refactor');
  await until(`/same as the source/.test(document.querySelector('#rfMoveDialog .rf-error')?.textContent || '')`, 'same destination error');
  check(true, 'moving into the same file is refused in the dialog');
  await h.setInput('#rfMoveDialog .rf-dest', 'shop\\formatting.py');
  await h.button('rfMoveDialog', 'refactor');
  await h.waitText((v) => !v.includes('def rounded('), 'function moved');
  const fmt = h.disk('shop/formatting.py');
  check(fmt.startsWith('"""Text helpers."""\nimport math\n') && fmt.endsWith('\n\n\ndef rounded(value, scale=100):\n    return math.floor(value * scale + 0.5) / scale\n'),
    'the function is appended to the destination with the imports it needs');
  const pricingAfterMove = await h.text();
  check(pricingAfterMove.includes('from shop.formatting import rounded') && !pricingAfterMove.includes('import math\n'), 'the source imports the moved function and drops imports only it used');
  const moveApp = h.disk('app.py');
  check(moveApp.includes('from shop.pricing import Cart, line_total, receipt\n') && moveApp.includes('from shop.formatting import rounded'), `importers are rewritten (app.py: ${moveApp.split('\n').slice(0, 3).join(' | ')})`);
  await press('Ctrl+S');
  check((await appOutput()) === baseline, 'the program prints the same after moving the function');

  // ---- Move a class into a file that does not exist yet ----
  await h.caret('class Cart', 0, 7);
  await press('F6');
  await h.dialog('rfMoveDialog');
  check(/Move class 'Cart' from shop\.pricing/.test(await js(`document.querySelector('#rfMoveDialog .rf-message').textContent`)), 'Move names a class as a class');
  await h.setInput('#rfMoveDialog .rf-dest', 'shop\\cart.py');
  await h.button('rfMoveDialog', 'preview');
  await h.dialog('rfPreview');
  check(await js(`[...document.querySelectorAll('#rfPreviewFiles .rf-file')].some(r => r.dataset.path.endsWith('cart.py') && /new file/.test(r.textContent))`), 'the preview marks the destination as a new file');
  check(!existsSync(h.P('shop/cart.py')), 'nothing is created before Do Refactor');
  await h.button('rfPreview', 'apply');
  await h.waitText((v) => !v.includes('class Cart'), 'class moved');
  check(h.disk('shop/cart.py').startsWith('from shop.pricing import line_total\n\n\nclass Cart:'), 'the new file holds the class and imports what it uses');
  check(h.disk('app.py').includes('from shop.cart import Cart'), 'importers of the class are rewritten');
  check((await appOutput()) === baseline, 'the program prints the same after moving the class');

  // ---- Move (F6) a module to another package ----
  await openFile(t, 'reports/daily.py');
  await h.caret('from shop import pricing', 0, 2);
  await press('F6');
  await h.dialog('rfMoveDialog');
  check(/Move module 'daily\.py'/.test(await js(`document.querySelector('#rfMoveDialog .rf-message').textContent`)), 'F6 away from a definition moves the module');
  await h.setInput('#rfMoveDialog .rf-dest', 'shop');
  await h.button('rfMoveDialog', 'refactor');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('shop\\\\daily.py')`, 'moved module reopened', 30000);
  check(!existsSync(h.P('reports/daily.py')) && existsSync(h.P('shop/daily.py')), 'the file moved on disk');
  check(h.disk('app.py').includes('from shop.daily import summary'), 'imports of the moved module are rewritten');
  check((await appOutput()) === baseline, 'the program prints the same after moving the module');
  await js(`ide.editor.focus(), true`);
  await press('Ctrl+Z');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('reports\\\\daily.py')`, 'module move undone', 30000);
  check(existsSync(h.P('reports/daily.py')) && !existsSync(h.P('shop/daily.py')) && h.disk('app.py').includes('from reports.daily import summary'), 'Ctrl+Z in the moved file moves it back and restores the imports');
  check((await appOutput()) === baseline, 'the program still prints the same after undoing the move');

  // ---- Inline (Ctrl+Alt+N) a function into its callers in another file ----
  await openFile(t, 'shop/formatting.py');
  await h.caret('def money', 0, 5);
  await press('Ctrl+Alt+N');
  await h.dialog('rfInlineDialog');
  const methodOptions = await js(`[...document.querySelectorAll('#rfInlineDialog .rf-radio')].map(r => r.textContent)`);
  check(methodOptions.join('|') === 'Inline all and remove the method|Inline all and keep the method', `inline on a definition offers remove or keep (${methodOptions.join(' / ')})`);
  await press('Enter');
  await h.waitText((v) => !v.includes('def money'), 'function inlined');
  // daily.py is open again (the module move's undo reopened it), so the change is in its document.
  const dailyInlined = await js(`ide.tabs.find(t => t.kind === 'file' && /reports[\\\\/]daily\\.py$/i.test(t.path))?.model.getValue(1) ?? null`) ?? h.disk('reports/daily.py');
  check(dailyInlined.includes('f"{pricing.line_total(q, p):.2f} EUR"') && !dailyInlined.includes('import money'), `the body replaces the call and the import goes (daily.py: ${dailyInlined.split('\n')[5]?.trim()})`);
  check((await appOutput()) === baseline, 'the program prints the same after inlining the function');

  // ---- inlay hints ----
  await openFile(t, 'hints.py');
  await until(`(async () => (await ide.inlayHints.hints(ide.editor.getModel())).length >= 3)()`, 'inlay hints', 30000);
  const hints = await js(`(async () => (await ide.inlayHints.hints(ide.editor.getModel())).map(h => h.position.lineNumber + ':' + h.label))()`);
  const lineOf = async (needle) => (await h.posOf(needle)).line;
  const L = { count: await lineOf('count ='), price: await lineOf('price ='), label: await lineOf('label ='), greet: await lineOf('def greeting') };
  check(hints.includes(`${L.count}:: int`), `inferred variable type (count: int) [${hints.join(', ')}]`);
  check(hints.includes(`${L.price}:: float`) && hints.includes(`${L.price}:price:`) && hints.includes(`${L.price}:quantity:`), 'call argument names and the inferred type of the result');
  check(!hints.some((x) => x.startsWith(`${L.label}:`)), 'no type hint for a plain literal');
  check(!hints.some((x) => x.startsWith(`${L.count}:obj`)), 'no name for positional-only parameters (len)');
  check(hints.includes(`${L.greet}:-> str`), 'inferred return type of an unannotated function');
  // Monaco asks for the lines in view; hints for a range are tokenized from the statement around it, not the whole file.
  const tail = await js(`(async () => { const m = ide.editor.getModel(); return (await ide.inlayHints.hints(m, new ide.monaco.Range(${L.price}, 1, m.getLineCount(), 1))).map(h => h.position.lineNumber + ':' + h.label); })()`);
  const expectTail = hints.filter((x) => Number(x.split(':')[0]) >= L.price);
  check(JSON.stringify(tail) === JSON.stringify(expectTail), `hints for a range match the whole file's (${tail.join(', ')})`);
  await until(`[...document.querySelectorAll('.view-line')].some(l => l.textContent.replace(/\\u00a0/g, ' ').includes('count: int = len'))`, 'hint rendered', 15000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.view-line')].some(l => l.textContent.replace(/\\u00a0/g, ' ').includes('count: int = len'))`), 'hints render inline in the editor');
  await shot('inlay-hints.png');
  // Settings › Editor › Inlay Hints
  await js(`ide.openSettings('inlay-hints'), true`);
  await until(`!!document.querySelector('.settings input[data-key="editor.inlayHints.parameterNames"]')`, 'Inlay Hints settings page');
  check(await js(`document.querySelector('.settings input[data-key="editor.inlayHints"]').checked`), 'inlay hints are on by default');
  check(await js(`[...document.querySelectorAll('.settings-nav *')].some(n => n.textContent.trim() === 'Inlay Hints')`), 'the page is listed under Settings › Editor');
  await js(`(() => { const c = document.querySelector('.settings input[data-key="editor.inlayHints.parameterNames"]'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
  await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'OK').click(), true`);
  await until(`(async () => !(await ide.inlayHints.hints(ide.editor.getModel())).some(h => h.label === 'price:'))()`, 'parameter hints off');
  check(await js(`(async () => (await ide.inlayHints.hints(ide.editor.getModel())).some(h => h.label === ': int'))()`), 'turning off parameter names keeps type hints');
  await js(`ide.settings.set('editor.inlayHints', false), true`);
  check(await js(`(async () => (await ide.inlayHints.hints(ide.editor.getModel())).length === 0)()`), 'the master switch turns every hint off');
  await js(`(ide.settings.set('editor.inlayHints', true), ide.settings.set('editor.inlayHints.parameterNames', true), true)`);

  // ---- no rope in the interpreter: a clear offer to install it ----
  const bare = bareVenv();
  await useInterpreter(t, bare);
  await openFile(t, 'shop/pricing.py');
  await h.select('quantity', 1);
  await press('Ctrl+Alt+V');
  await until(`!!document.querySelector('#rfInstallDialog')`, 'install offer', 30000);
  const offer = await js(`document.querySelector('#rfInstallDialog').innerText`);
  check(/needs the rope library/.test(offer) && /Install rope/.test(offer), 'without rope the IDE offers to install it through pip');
  await shot('install-offer.png');
  await js(`[...document.querySelectorAll('#rfInstallDialog .dialog-buttons button')].pop().click(), true`);
  check(await js(`!!ide.installables.find(i => i.id === 'pip:rope')`), 'rope is listed in the Install Manager');
  await h.select('0.2');
  await press('Ctrl+Alt+C');
  await h.dialog('rfExtractDialog');
  check(true, 'Extract Constant needs no rope (it works on the syntax tree)');
  await h.button('rfExtractDialog', 'cancel');
  await useInterpreter(t, VENV_PY);
} catch (err) {
  check(false, `unexpected error: ${err.stack || err.message}`);
  await shot('error.png').catch(() => {});
}
t.close();

// ======================================================================
// Korean UI
const k = await launch({ fixture: 'refactor', port: 9691, name: 'refactor-ko', lang: 'ko-KR' });
const hk = helpers(k);
const finishAll = () => {
  const results = [...t.results, ...k.results];
  const errors = [...t.consoleErrors, ...k.consoleErrors];
  k.close();
  if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed || errors.length ? 1 : 0);
};
try {
  await useInterpreter(k, VENV_PY);
  await k.until(`/Pyright/.test(document.querySelector('#lspStatus')?.textContent || '') && document.querySelector('#lspStatus').dataset.state === 'ready'`, 'Pyright ready', 60000);
  await openFile(k, 'shop/pricing.py');
  const leaks = [];
  const look = async (sel, label) => { const l = await englishLeaks(k, sel); if (l.length) leaks.push(`${label}: ${JSON.stringify(l)}`); };

  await hk.caret('net_price(price', 0, 2);
  await k.press('Ctrl+Alt+Shift+T');
  await k.until(`!!document.querySelector('#rfRefactorThis')`, 'Refactor This popup');
  k.check(/이 항목 리팩터링/.test(await k.js(`document.querySelector('#rfRefactorThis').innerText`)), 'Refactor This popup in Korean');
  await look('#rfRefactorThis', 'Refactor This');
  await k.press('Escape');

  await hk.select('subtotal * 0.1');
  await k.press('Ctrl+Alt+V');
  await hk.dialog('rfExtractDialog');
  k.check(await k.js(`document.querySelector('#rfExtractDialog .dialog-title').textContent`) === '변수 추출', 'Extract Variable dialog title in Korean');
  await look('#rfExtractDialog', 'Extract Variable');
  await hk.button('rfExtractDialog', 'preview');
  await hk.dialog('rfPreview');
  await k.until(`document.querySelectorAll('#rfPreviewFiles .rf-file').length > 0`, 'preview files');
  k.check(/리팩터링 미리보기/.test(await k.js(`document.querySelector('#rfPreview .dialog-title').textContent`)), 'preview in Korean');
  await look('#rfPreview .rf-summary, #rfPreview .dialog-title, #rfPreview .dialog-buttons', 'Preview');
  await hk.button('rfPreview', 'cancel');
  await hk.gone('rfPreview');

  await hk.caret('def net_price', 0, 5);
  await k.press('Ctrl+F6');
  await hk.dialog('rfSignatureDialog');
  await look('#rfSignatureDialog', 'Change Signature');
  await hk.button('rfSignatureDialog', 'cancel');

  await hk.caret('def rounded', 0, 5);
  await k.press('F6');
  await hk.dialog('rfMoveDialog');
  await look('#rfMoveDialog', 'Move');
  await hk.setInput('#rfMoveDialog .rf-dest', 'shop\\pricing.py');
  await hk.button('rfMoveDialog', 'refactor');
  await k.until(`/원본과 같습니다/.test(document.querySelector('#rfMoveDialog .rf-error')?.textContent || '')`, 'Korean dialog error');
  k.check(true, 'dialog errors are in Korean');
  await hk.button('rfMoveDialog', 'cancel');

  await hk.caret('subtotal', 1, 1);
  await k.press('Ctrl+Alt+N');
  await hk.dialog('rfInlineDialog');
  await look('#rfInlineDialog', 'Inline');
  await hk.button('rfInlineDialog', 'cancel');

  await hk.caret('net_price(price', 0, 0);
  await k.press('Ctrl+Alt+M');
  await k.until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some(n => /리팩터링을 수행할 수 없습니다/.test(n.textContent))`, 'Korean hint');
  k.check(true, 'editor hints are in Korean');
  await k.press('Escape');

  await k.js(`ide.openSettings('inlay-hints'), true`);
  await k.until(`!!document.querySelector('.settings input[data-key="editor.inlayHints"]')`, 'settings page');
  k.check(await k.js(`[...document.querySelectorAll('.settings-nav *')].some(n => n.textContent.trim() === '인레이 힌트')`), 'Inlay Hints page in Korean');
  await look('.settings-page, .settings-body, .settings .dialog-body', 'Inlay Hints settings');
  await k.js(`[...document.querySelectorAll('.dialog-buttons button')].pop().click(), true`);

  k.check(!leaks.length, `no English left in the refactoring UI${leaks.length ? `:\n  ${leaks.join('\n  ')}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => MINE.includes(JSON.stringify(s).slice(1, -1)) || MINE.includes(s));
  k.check(!missing.length, `every refactoring string has a Korean entry${missing.length ? `: ${JSON.stringify(missing)}` : ''}`);
  await k.shot('korean.png');
} catch (err) {
  k.check(false, `unexpected error (Korean): ${err.stack || err.message}`);
  await k.shot('error-ko.png').catch(() => {});
}
finishAll();
