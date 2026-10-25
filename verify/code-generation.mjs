// End-to-end check for renderer/features/code-generation on verify/fixtures/code-generation, through real keys:
// Alt+Enter's Create function, Create class, Create local variable, Convert to f-string literal, Add method (on self
// and on an instance of a class in another file) and Implement abstract methods; Code › Override Methods… (Ctrl+O)
// and Implement Methods… with the chooser; one undo step per fix; the files still compile; the Korean UI.
// Runs in the IDE's default interpreter (no rope needed). Ports 9610-9611.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINE = readFileSync(path.join(HERE, '..', 'renderer', 'features', 'code-generation', 'index.js'), 'utf8');
const J = JSON.stringify;

function helpers(t) {
  const { js, until, press, sleep } = t;
  const text = () => js('ide.editor.getModel().getValue(1)');
  const selected = () => js('ide.editor.getModel().getValueInRange(ide.editor.getSelection())');
  async function caret(needle, offset = 0, nth = 0) {
    const ok = await js(`(() => {
      const m = ide.editor.getModel(); const v = m.getValue(1); let i = -1;
      for (let k = 0; k <= ${nth}; k++) { i = v.indexOf(${J(needle)}, i + 1); if (i < 0) return false; }
      const p = m.getPositionAt(i + ${offset}); ide.editor.focus(); ide.editor.setPosition(p); return true;
    })()`);
    if (!ok) throw new Error(`${needle} not found`);
  }
  const rowsExpr = `[...document.querySelectorAll('.action-widget .monaco-list-row.action')]`;
  // Alt+Enter, then the row whose text includes `label`, chosen with the arrow keys and Enter.
  // Monaco replaces an Alt+Enter request with its automatic one when the file's markers change meanwhile (Pyright
  // or ruff answering the last edit), so the menu waits for quiet markers and is asked for again if it did not open.
  async function quietMarkers() {
    await js(`(window.__markersAt ??= (ide.monaco.editor.onDidChangeMarkers(() => { window.__markersAt = Date.now(); }), 0), true)`);
    await until('Date.now() - window.__markersAt > 800', 'markers quiet', 10000).catch(() => {});
  }
  // Opens the Alt+Enter menu until it shows `label`; returns the row expression.
  async function menu(label) {
    const row = `${rowsExpr}.find(n => n.textContent.includes(${J(label)}))`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await quietMarkers();
      await press('Alt+Enter');
      if (await until(`!!${row}`, label, 8000).then(() => true, () => false)) break;
      await press('Escape');
    }
    await until(`!!${row}`, `Alt+Enter offers ${label}`, 15000).catch(async (e) => {
      console.log('rows:', J(await js(`${rowsExpr}.map(n => n.textContent)`)), 'state:', J(await js(`({ pos: ide.editor.getPosition(), focus: ide.editor.hasTextFocus(), active: document.activeElement?.className, msg: [...document.querySelectorAll('.monaco-editor-overlaymessage')].map(n => n.textContent), log: window.__cgLog, dialogs: document.querySelector('#dialogHost').childElementCount })`)));
      throw e;
    });
    return row;
  }
  async function quickFix(label) {
    const row = await menu(label);
    for (let i = 0; i < 20 && !(await js(`!!${row}?.classList.contains('focused')`)); i++) await press('ArrowDown');
    await press('Enter');
    await sleep(150);
    await js('ide.codeGeneration.settled()');
  }
  const rows = () => js(`${rowsExpr}.map(n => n.textContent)`);
  const diagnostic = (file, code) => until(`ide.lsp.diagnostics(ide.util.joinPath(ide.root, ${J(file)})).some(d => d.code === ${J(code)})`, `Pyright reports ${code} in ${file}`, 60000);
  const chooser = (mode) => until(`document.querySelector('#cgChooser')?.dataset.mode === ${J(mode)}`, `${mode} chooser`, 30000);
  const hintText = () => js(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].map(n => n.textContent).join(' | ')`);
  return { text, selected, caret, menu, quickFix, rows, diagnostic, chooser, hintText };
}

const t = await launch({ fixture: 'code-generation', port: 9610 });
const { js, until, press, check, shot } = t;
const h = helpers(t);
const P = (rel) => path.join(t.project, rel);
const disk = (rel) => readFileSync(P(rel), 'utf8').replace(/\r\n/g, '\n');

try {
  await until(`document.querySelector('#lspStatus')?.textContent === 'Pyright: ready'`, 'Pyright ready', 90000);
  await js(`(() => { const orig = ide.refactor.call; window.__cgLog = []; ide.refactor.call = async (m, p) => { const t0 = Math.round(performance.now()); try { return await orig(m, p); } catch (e) { window.__cgLog.push([m, 'error', e.code]); throw e; } finally { window.__cgLog.push([m, t0, Math.round(performance.now()) - t0]); } }; return true; })()`);
  check(await js(`ide.keysFor('OverrideMethods')`) === 'Ctrl+O' && await js(`ide.keysFor('ImplementMethods')`) === '',
    'Override Methods… is Ctrl+O; Implement Methods… has no key (Ctrl+I stays Edit with Claude)');

  // ---------- Create function, then one undo step ----------
  await openFile(t, 'app.py');
  const original = await h.text();
  await h.diagnostic('app.py', 'reportUndefinedVariable');
  await h.caret('compute_total', 3);
  await h.quickFix("Create function 'compute_total'");
  await until(`ide.editor.getModel().getValue(1).includes('def compute_total(items):')`, 'function created', 30000);
  let s = await h.text();
  check(s.startsWith('from shapes import Square\n\n\ndef compute_total(items):\n    pass\n\n\ndef main(items):\n'), `Create function puts it above main, PEP 8 spaced (${J(s.slice(0, 120))})`);
  check(await h.selected() === 'pass', 'the caret selects pass, ready to be typed over');
  await shot('01-create-function.png');
  await press('Ctrl+Z');
  await until(`ide.editor.getModel().getValue(1) === ${J(original)}`, 'undone', 10000).catch(() => {});
  check(await h.text() === original, 'one Ctrl+Z takes the whole fix back');

  // ---------- Create class, Create local variable, Convert to f-string literal ----------
  await h.caret('Report(', 1);
  await h.menu("Create class 'Report'");
  const reportRows = await h.rows();
  await press('Escape');
  check(reportRows.findIndex((r) => r.includes("Create class 'Report'")) >= 0 && reportRows.findIndex((r) => r.includes("Create class 'Report'")) < reportRows.findIndex((r) => r.includes("Create function 'Report'")),
    `a capitalized call offers Create class before Create function (${J(reportRows)})`);
  check(reportRows.findIndex((r) => r.includes("Create class 'Report'")) < reportRows.findIndex((r) => /Suppress/.test(r)), 'the fixes list above the suppress actions');
  await h.quickFix("Create class 'Report'");
  await until(`ide.editor.getModel().getValue(1).includes('class Report:')`, 'class created', 30000);
  check((await h.text()).includes('class Report:\n    def __init__(self, total):\n        pass\n\n\ndef main(items):'), 'Create class writes __init__ with the call\'s argument');

  await h.diagnostic('app.py', 'reportUndefinedVariable');
  await h.caret('scale))', 1);
  await h.quickFix("Create local variable 'scale'");
  await until(`ide.editor.getModel().getValue(1).includes('scale = None')`, 'variable created', 30000);
  s = await h.text();
  check(s.includes('    print(sq.perimeter(), total)\n    scale = None\n    print("Area of %s'), `Create local variable puts scale = None above the statement (${J(s)})`);
  check(await h.selected() === 'None', 'the caret selects None');

  await h.caret('"Area of', 3);
  await h.quickFix('Convert to f-string literal');
  await until(`ide.editor.getModel().getValue(1).includes('f"Area of')`, 'converted', 30000);
  check((await h.text()).includes('print(f"Area of {sq} is {scale:.1f}")'), 'the % string becomes an f-string with the format spec kept');

  // ---------- Add method to a class in another file ----------
  await h.diagnostic('app.py', 'reportAttributeAccessIssue');
  await h.caret('perimeter', 2);
  await h.quickFix('Add method perimeter() to class Square');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('shapes.py') && ide.editor.getModel().getValue(1).includes('def perimeter(self):')`, 'shapes.py opened with the method', 30000);
  s = await h.text();
  check(s.includes('        return self.summary(self.side)\n\n    def perimeter(self):\n        pass\n'), `the method goes at the end of Square in shapes.py (${J(s.slice(-160))})`);
  check(await h.selected() === 'pass' && await js(`ide.editor.getPosition().lineNumber`) === s.split('\n').indexOf('    def perimeter(self):') + 2, 'the editor shows the new method with pass selected');

  // ---------- Add method on self ----------
  await h.diagnostic('shapes.py', 'reportAttributeAccessIssue');
  await h.caret('summary', 2);
  await h.quickFix('Add method summary() to class Square');
  await until(`ide.editor.getModel().getValue(1).includes('def summary(self, side):')`, 'self method added', 30000);
  check((await h.text()).includes('    def perimeter(self):\n        pass\n\n    def summary(self, side):\n        pass\n'), 'self.summary(self.side) adds summary(self, side) to Square');

  // ---------- Implement abstract methods (Alt+Enter on the class header) ----------
  await h.caret('class Square', 8);
  await h.quickFix('Implement abstract methods');
  await h.chooser('implement');
  const implRows = await js(`[...document.querySelectorAll('#cgChooser .cg-method')].map(r => ({ name: r.dataset.name, checked: r.querySelector('input').checked }))`);
  check(J(implRows) === J([{ name: 'area', checked: true }]), `the chooser lists the missing abstract method, checked (${J(implRows)})`);
  check(await js(`document.querySelector('#cgChooser .dialog-title').textContent`) === 'Select Methods to Implement', 'PyCharm\'s title');
  await shot('02-implement-chooser.png');
  await press('Enter');
  await until(`!document.querySelector('#cgChooser') && ide.editor.getModel().getValue(1).includes('def area(self) -> float:\\n        pass')`, 'area implemented', 30000);
  check((await h.text()).trimEnd().endsWith('    def summary(self, side):\n        pass\n\n    def area(self) -> float:\n        pass'), 'Implement writes area(self) -> float with pass at the end of the class');
  check(await h.selected() === 'pass', 'the caret selects its pass');

  // ---------- Override Methods… (Ctrl+O) and Implement Methods… ----------
  await openFile(t, 'circle.py');
  await h.caret('self.r = r');
  await press('Ctrl+O');
  await h.chooser('override');
  const groups = await js(`[...document.querySelectorAll('#cgChooser .cg-owner-name')].map(n => n.textContent)`);
  const overRows = await js(`[...document.querySelectorAll('#cgChooser .cg-method')].map(r => r.dataset.name)`);
  check(J(groups) === J(['Shape', 'object']) && overRows[0] === 'area' && overRows[1] === 'describe' && overRows.includes('__repr__') && !overRows.includes('__init__'),
    `grouped by class: Shape's methods, then object's, without the ones Circle defines (${J(groups)} ${J(overRows)})`);
  check(await js(`document.querySelector('#cgChooser .dialog-buttons .primary').disabled`), 'OK waits for a choice');
  await press('ArrowDown');
  await press(' ');
  await until(`document.querySelector('#cgChooser .cg-method[data-name="describe"] input').checked`, 'describe checked with Down, Space', 5000);
  await press('Enter');
  await until(`ide.editor.getModel().getValue(1).includes('return super().describe()')`, 'describe overridden', 30000);
  s = await h.text();
  check(s === 'from shapes import Shape\n\n\nclass Circle(Shape):\n    def __init__(self, r):\n        self.r = r\n\n    def describe(self) -> str:\n        return super().describe()\n',
    `Override writes describe() calling super() after the method at the caret (${J(s)})`);

  await js(`(ide.runAction('ImplementMethods'), true)`);
  await h.chooser('implement');
  check(J(await js(`[...document.querySelectorAll('#cgChooser .cg-method')].map(r => r.dataset.name)`)) === J(['area']), 'Implement Methods… lists only the abstract area');
  await press('Escape');
  await until(`!document.querySelector('#cgChooser')`, 'chooser closed');
  check(await h.text() === s, 'Esc changes nothing');

  await h.caret('from shapes');
  await press('Ctrl+O');
  await until(`/Caret should be inside a class/.test([...document.querySelectorAll('.monaco-editor-overlaymessage')].map(n => n.textContent).join(' '))`, 'hint outside a class', 15000).catch(() => {});
  check(/Caret should be inside a class/.test(await h.hintText()), `outside a class Ctrl+O says why (${J(await h.hintText())})`);
  await js(`(document.activeElement.blur(), true)`);
  check(await js(`!ide.actions.find(a => a.id === 'OverrideMethods').when()`), 'outside a Python editor Ctrl+O is left to Open Folder…');

  // ---------- the files still compile ----------
  await js('ide.saveAll()');
  await until(`!ide.tabs.some(t => ide.isDirty(t))`, 'saved', 15000);
  let compiled = '';
  try {
    execFileSync('py', ['-3', '-m', 'py_compile', P('app.py'), P('shapes.py'), P('circle.py')], { encoding: 'utf8', windowsHide: true });
    compiled = 'ok';
  } catch (e) { compiled = String(e.stderr || e.message); }
  check(compiled === 'ok', `every changed file compiles (${compiled})`);
  check(disk('shapes.py').includes('def summary(self, side):') && disk('app.py').includes('class Report:'), 'the changes are on disk after Save All');
} catch (err) {
  check(false, `unexpected: ${err.message}`);
  await shot('error.png').catch(() => {});
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'code-generation', port: 9611, name: 'code-generation-ko', lang: 'ko-KR' });
const hk = helpers(k);
try {
  await k.until(`/Pyright/.test(document.querySelector('#lspStatus')?.textContent || '') && ide.lsp.status() === 'ready'`, 'Pyright ready (ko)', 90000);
  await openFile(k, 'app.py');
  await hk.diagnostic('app.py', 'reportUndefinedVariable');
  await hk.caret('compute_total', 3);
  await hk.menu("함수 'compute_total' 생성").catch(() => {});
  const koRows = await hk.rows();
  k.check(koRows.some((r) => r.includes("함수 'compute_total' 생성")) && koRows.some((r) => r.includes("클래스 'compute_total' 생성")), `Alt+Enter in Korean (${J(koRows)})`);
  await k.press('Escape');
  await openFile(k, 'circle.py');
  await hk.caret('self.r = r');
  await k.press('Ctrl+O');
  await hk.chooser('override');
  k.check(await k.js(`document.querySelector('#cgChooser .dialog-title').textContent`) === '오버라이드할 메서드 선택', 'the chooser title in Korean');
  const leaks = await englishLeaks(k, '#cgChooser');
  k.check(!leaks.length, `no English in the chooser (${J(leaks)})`);
  await k.shot('03-chooser-ko.png');
  await k.press('Escape');
  const missing = (await missingTranslations(k)).filter((x) => MINE.includes(J(x).slice(1, -1)) || MINE.includes(x));
  k.check(!missing.length, `every string has a Korean entry (${J(missing)})`);
} catch (err) {
  k.check(false, `unexpected: ${err.message}`);
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
const errors = [...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
