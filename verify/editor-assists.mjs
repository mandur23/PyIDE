// Editor assists (renderer/features/editor-assists): Sticky Lines in the group editors (Pyright outline model, nested
// class/def, a decorated method with a signature over several lines, click to jump, the max-lines and on/off settings,
// Dark and Light colors, split panes, breadcrumbs, Distraction-Free and Presentation modes, peek, and off in notebook
// cells, embedded editors and diff editors), and automatic f-string conversion (a table of cases, real typing, undo,
// the setting, Korean strings). Ports 9385-9386.
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'editor-assists', port: 9385 });
const { js, until, press, type, check, sleep, cdp } = t;

const OPT = 'ide.monaco.editor.EditorOption.stickyScroll';
// Monaco draws spaces as no-break spaces.
const LINES = `[...ed.getDomNode().querySelectorAll('.sticky-widget .sticky-line-content')].map(n => n.textContent.replace(/[ \\u00a0]+/g, ' ').trim())`;
const stickyOf = (ed = 'ide.editor') => js(`(() => { const ed = ${ed}; return ${LINES}; })()`);
const scrollTo = (line, ed = 'ide.editor') => js(`(() => { const ed = ${ed}; ed.setScrollTop(ed.getTopForLineNumber(${line})); return true; })()`);
const EXPECTED = ['class Outer:', 'class Inner:', 'def method('];
async function waitSticky(want, label, ed = 'ide.editor', ms = 30000) {
  try {
    await until(`(() => { const ed = ${ed}; return ${J(J(want))} === JSON.stringify(${LINES}); })()`, label, ms);
    check(true, label);
  } catch { check(false, `${label} (got ${J(await stickyOf(ed))})`); }
}
async function clickAt(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(100);
}
const setText = (text, line, col) => js(`(() => { const e = ide.editor; e.trigger('t', 'hideSuggestWidget', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const text = () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const caret = () => js(`(() => { const p = ide.editor.getPosition(); return [p.lineNumber, p.column]; })()`);

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.editorAssists`), 'editor-assists plugin loaded');

  // ---------------- Sticky Lines ----------------
  await openFile(t, 'nested.py');
  const opts = await js(`ide.editor.getOption(${OPT})`);
  check(opts.enabled === true && opts.maxLineCount === 5 && opts.defaultModel === 'outlineModel',
    `group editors get sticky lines on by default, 5 lines, Pyright's outline model (${J(opts)})`);
  await js(`ide.lsp.ready()`);
  await until(`ide.lsp.documentSymbols(ide.activeTab().path).then(s => s.length > 0)`, 'Pyright document symbols', 60000);
  await scrollTo(50);
  await waitSticky(EXPECTED, 'scrolled into the decorated method: Outer, Inner and its def line (not the decorator) stick');

  // Why the outline model: the indentation model sticks the `) -> int:` line of a signature over several lines.
  await js(`(ide.editor.updateOptions({ stickyScroll: { ...ide.editorAssists.stickyOptions(), defaultModel: 'indentationModel' } }), true)`);
  await scrollTo(51);
  await waitSticky(['class Outer:', 'class Inner:', ') -> int:'], "Monaco's indentation model would show ') -> int:' instead (so it is not used)");
  await js(`(ide.editor.updateOptions({ stickyScroll: ide.editorAssists.stickyOptions() }), true)`);
  await scrollTo(50);
  await waitSticky(EXPECTED, 'back on the outline model');

  // Line numbers in the sticky gutter match the lines.
  const nums = await js(`[...ide.editor.getDomNode().querySelectorAll('.sticky-widget .sticky-line-number')].map(n => n.textContent.trim())`);
  check(J(nums) === J(['12', '15', '18']), `sticky line numbers are 12, 15, 18 (${J(nums)})`);

  // Click jumps to the line.
  const box = await js(`(() => { const n = ide.editor.getDomNode().querySelectorAll('.sticky-widget .sticky-line-content')[1]; const r = n.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  await clickAt(box.x, box.y);
  await until(`ide.editor.getPosition().lineNumber === 15`, 'caret on line 15', 5000).catch(() => {});
  const jumped = await js(`(() => { const ed = ide.editor; const p = ed.getPosition(); return { line: p.lineNumber, visible: ed.getVisibleRanges().some(r => r.startLineNumber <= 15 && 15 <= r.endLineNumber) }; })()`);
  check(jumped.line === 15 && jumped.visible, `clicking the 'class Inner:' sticky line puts the caret on line 15 and shows it (${J(jumped)})`);

  // Max lines setting.
  await js(`(ide.settings.set('editor.stickyLinesMax', 2), true)`);
  await scrollTo(50);
  await waitSticky(['class Outer:', 'class Inner:'], 'with the maximum at 2, two sticky lines show');
  await js(`(ide.settings.set('editor.stickyLinesMax', 5), true)`);
  await waitSticky(EXPECTED, 'maximum back at 5');

  // Dark and Light colors.
  const colors = () => js(`(() => { const w = ide.editor.getDomNode().querySelector('.sticky-widget'); const s = getComputedStyle(w); return { bg: s.backgroundColor, border: s.borderBottomColor, editorBg: getComputedStyle(ide.editor.getDomNode().querySelector('.monaco-editor-background')).backgroundColor }; })()`);
  let c = await colors();
  check(c.bg === 'rgb(30, 31, 34)' && c.bg === c.editorBg && c.border === 'rgb(57, 59, 64)', `Dark: the editor background with a #393b40 separator (${J(c)})`);
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await sleep(200);
  c = await colors();
  check(c.bg === 'rgb(255, 255, 255)' && c.bg === c.editorBg && c.border === 'rgb(235, 236, 240)', `Light: white with a #ebecf0 separator (${J(c)})`);
  await t.shot('sticky-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');
  await t.shot('sticky-dark.png');

  // Breadcrumbs sit above the editor, the sticky lines at the top of the editor below them.
  const layout = await js(`(() => { const g = ide.groups().find(g => g.editor === ide.editor); const bar = g.el.querySelector('.nb-bar'); const w = ide.editor.getDomNode().querySelector('.sticky-widget');
    return { bar: bar && !bar.classList.contains('hidden') ? bar.getBoundingClientRect().bottom : null, sticky: w.getBoundingClientRect().top, editor: ide.editor.getDomNode().getBoundingClientRect().top }; })()`);
  check(layout.bar !== null && layout.bar <= layout.sticky + 1 && Math.abs(layout.sticky - layout.editor) <= 1, `breadcrumbs above, sticky lines at the editor's top (${J(layout)})`);

  // Setting off and on.
  await js(`(ide.settings.set('editor.stickyLines', false), true)`);
  await until(`ide.editor.getOption(${OPT}).enabled === false`, 'option off');
  await sleep(300);
  check((await stickyOf()).length === 0, 'Show sticky lines off: no sticky lines');
  await js(`(ide.settings.set('editor.stickyLines', true), true)`);
  await scrollTo(50);
  await waitSticky(EXPECTED, 'Show sticky lines on again: they come back');

  // Split editors: the new pane gets sticky lines too.
  await js(`(ide.runAction('SplitVertically'), true)`);
  await until(`ide.editors().length === 2 && ide.editor !== ide.editors()[0]`, 'split pane');
  check(await js(`ide.editor.getOption(${OPT}).enabled`), 'the new split pane has sticky lines on');
  await scrollTo(50);
  await waitSticky(EXPECTED, 'the split pane shows the same sticky lines');
  await js(`(ide.settings.set('editor.stickyLinesMax', 1), true)`);
  check(await js(`ide.editors().every(e => e.getOption(${OPT}).maxLineCount === 1)`), 'a settings change reaches both panes');
  await js(`(ide.settings.set('editor.stickyLinesMax', 5), true)`);
  await js(`(ide.runAction('Unsplit'), true)`);
  await until(`ide.editors().length === 1`, 'unsplit');

  // Distraction-Free Mode (no line numbers) and Presentation Mode (bigger font).
  await js(`(ide.runAction('ToggleDistractionFreeMode'), true)`);
  await until(`ide.appearanceModes.mode() === 'distractionFree'`, 'distraction-free mode');
  await scrollTo(48);
  await waitSticky(EXPECTED, 'Distraction-Free Mode: sticky lines still show');
  check(await js(`ide.editor.getOption(ide.monaco.editor.EditorOption.lineNumbers).renderType === 0 && [...ide.editor.getDomNode().querySelectorAll('.sticky-widget .sticky-line-number')].every(n => !n.textContent.trim())`),
    'Distraction-Free Mode: the sticky lines have no line numbers, like the editor');
  await js(`(ide.runAction('ToggleDistractionFreeMode'), true)`);
  await until(`ide.appearanceModes.mode() === null`, 'left distraction-free mode');
  await js(`(ide.runAction('TogglePresentationMode'), true)`);
  await until(`ide.appearanceModes.mode() === 'presentation'`, 'presentation mode');
  await sleep(300);
  await scrollTo(50);
  await waitSticky(EXPECTED, 'Presentation Mode: sticky lines show');
  const heights = await js(`(() => { const lh = ide.editor.getOption(ide.monaco.editor.EditorOption.lineHeight); return { lh, lines: [...ide.editor.getDomNode().querySelectorAll('.sticky-widget .sticky-line-content')].map(n => n.getBoundingClientRect().height) }; })()`);
  check(heights.lh > 30 && heights.lines.every((h) => Math.abs(h - heights.lh) <= 1), `Presentation Mode: sticky lines take the bigger line height (${J(heights)})`);
  await js(`(ide.runAction('TogglePresentationMode'), true)`);
  await until(`ide.appearanceModes.mode() === null`, 'left presentation mode');

  // Peek Definition on @deco: the peek opens over the sticky lines without errors and follows the editor's option.
  await js(`(() => { const ed = ide.editor; ed.setPosition({ lineNumber: 16, column: 11 }); ed.revealLineInCenter(16); ed.focus(); ed.trigger('t', 'editor.action.peekDefinition', {}); return true; })()`);
  try {
    await until(`!!ide.editor.getDomNode().querySelector('.peekview-widget .monaco-editor')`, 'peek widget', 15000);
    const peek = await js(`(() => { const host = ide.editor.getDomNode().querySelector('.peekview-widget'); const inner = ide.monaco.editor.getEditors().find(e => host.contains(e.getDomNode())); return inner ? inner.getOption(${OPT}).enabled : null; })()`);
    check(peek === true, `Peek Definition opens; its editor follows the pane's sticky option (${peek})`);
  } catch { check(false, 'Peek Definition opens'); }
  await press('Escape');
  await until(`!ide.editor.getDomNode().querySelector('.peekview-widget')`, 'peek closed', 5000).catch(() => {});

  // Off in embedded editors and diff editors.
  const embedded = await js(`(() => { const host = document.createElement('div'); host.style.cssText = 'width:400px;height:200px'; document.body.appendChild(host);
    const model = ide.monaco.editor.createModel('class A:\\n    pass\\n', 'python');
    const ed = ide.createEditor(host, { model }); const own = ed.getOption(${OPT}).enabled; ed.dispose();
    const diff = ide.monaco.editor.createDiffEditor(host, {}); const d = diff.getModifiedEditor().getOption(${OPT}).enabled; diff.dispose();
    model.dispose(); host.remove(); return { own, d }; })()`);
  check(embedded.own === false && embedded.d === false, `editors embedded in viewers and diff editors keep sticky lines off (${J(embedded)})`);

  // Notebook cells.
  await openFile(t, 'cells.ipynb');
  await until(`ide.monaco.editor.getEditors().some(e => e.getModel()?.uri.scheme === 'pyide-nb')`, 'notebook cell editor', 20000);
  const cells = await js(`ide.monaco.editor.getEditors().filter(e => e.getModel()?.uri.scheme === 'pyide-nb').map(e => e.getOption(${OPT}).enabled)`);
  check(cells.length > 0 && cells.every((on) => on === false), `notebook cells have no sticky lines (${J(cells)})`);
  check(await js(`![...ide.activeTab().host.querySelectorAll('.sticky-widget .sticky-line-content')].length`), 'no sticky line is drawn inside the notebook');
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // ---------------- f-string conversion ----------------
  const cases = [
    ['name = "Kim"\nmsg = "Hello {name|}"', true, 'plain string'],
    ['name = 1\nmsg = """Hi {name|}"""', true, 'triple-quoted string that is not a docstring'],
    ['이름 = "철수"\n인사 = "안녕하세요 {이름|}님"', true, 'Korean text and a Korean name'],
    ["d = {'k': 1}\nmsg = \"v={d['k']|}\"", true, 'subscript with the other quote'],
    ['user = 1\nmsg = "{user.name!r:>10|}"', true, 'attribute, conversion and format spec'],
    ['x = 1\nmsg = "{x=|}"', true, 'self-documenting ='],
    ['x = 1\nmsg = "{len(x)|}"', true, 'call of a builtin'],
    ['x = 1\nmsg = "{x|}', true, 'unterminated string while typing'],
    ['name = "Kim"\nmsg = b"Hello {name|}"', false, 'bytes'],
    ['name = "Kim"\nmsg = r"Hello {name|}"', false, 'raw string'],
    ['name = "Kim"\nmsg = f"Hello {name|}"', false, 'already an f-string'],
    ['name = "Kim"\nmsg = u"Hello {name|}"', false, 'u prefix (uf is not valid)'],
    ['name = "Kim"\nmsg = "Hello {name|}".format(name=name)', false, 'string followed by .format()'],
    ['def f(name):\n    """Say {name|}."""\n', false, 'function docstring'],
    ['"""Module {name|}"""\nname = 1', false, 'module docstring'],
    ['msg = "Hello {nobody|}"', false, 'unknown name'],
    ['print("Hello {missing|}", missing=1)', false, 'name used only as a keyword argument'],
    ['import logging\nname = 1\nlogging.info("Hi {name|}")', false, 'logging call'],
    ['name = 1\nself.logger.debug("Hi {name|}")', false, 'logger method call'],
    ['name = 1\nmsg = "%s {name|}" % name', false, '%-formatting'],
    ['name = 1\nmsg = "{{x}} {name|}"', false, 'escaped braces'],
    ['name = 1\nmsg = \'{"a": 1} {name|}\'', false, 'JSON-like braces'],
    ['name = 1\n# "Hello {name|}"', false, 'comment'],
    ['x = 1\nmsg = "{x} and {y|}"', false, 'another field with an unknown name'],
    ['x = 1\nmsg = "{}{x|}"', false, 'empty field'],
    ['x = 1\nd = {x: 2|}', false, 'dict literal in code'],
    ['x = 1\nmsg = "{if|}"', false, 'keyword'],
  ];
  const results = await js(`${J(cases)}.map(([s]) => { const at = s.indexOf('|'); return ide.editorAssists.fstringInsertAt(s.slice(0, at) + s.slice(at + 1), at); })`);
  cases.forEach(([s, want, label], i) => check((results[i] != null) === want, `${want ? 'converts' : 'leaves alone'}: ${label} (${J(s)} -> ${results[i]})`));

  // Real typing, auto-closed brace, undo.
  await openFile(t, 'fstr.py');
  await setText('name = "Kim"\nmsg = ""\n', 2, 8);
  await type('Hello ');
  await type('{');
  await type('name');
  await type('}');
  await until(`ide.editor.getModel().getLineContent(2) === 'msg = f"Hello {name}"'`, 'converted', 3000).catch(() => {});
  check(await js(`ide.editor.getModel().getLineContent(2)`) === 'msg = f"Hello {name}"', `typing "Hello {name}" adds the f prefix (${J(await text())})`);
  check(J(await caret()) === J([2, 21]), `the caret stays after the brace (${J(await caret())})`);
  await press('Ctrl+Z');
  await sleep(150);
  check(await js(`ide.editor.getModel().getLineContent(2)`) === 'msg = "Hello {name}"', `Ctrl+Z removes only the prefix (${J(await text())})`);
  await press('Ctrl+Z');
  await sleep(150);
  check(await js(`ide.editor.getModel().getLineContent(2)`) !== 'msg = "Hello {name}"', 'a second Ctrl+Z undoes the typing');

  // Korean while typing.
  await setText('이름 = "철수"\n인사 = ""\n', 2, 7);
  await type('안녕하세요 ');
  await type('{');
  await type('이름');
  await type('}');
  await sleep(150);
  check(await js(`ide.editor.getModel().getLineContent(2)`) === '인사 = f"안녕하세요 {이름}"', `Korean text and name convert while typing (${J(await text())})`);

  // Not in bytes, nor in a docstring, when typing.
  await setText('name = "Kim"\nmsg = b""\n', 2, 9);
  await type('{');
  await type('name');
  await type('}');
  await sleep(150);
  check(await js(`ide.editor.getModel().getLineContent(2)`) === 'msg = b"{name}"', `typing into bytes leaves them alone (${J(await text())})`);
  await setText('def greet(name):\n    """"""\n', 2, 8);
  await type('Hi {name}');
  await sleep(150);
  check(await js(`ide.editor.getModel().getLineContent(2)`) === '    """Hi {name}"""', `typing into a docstring leaves it alone (${J(await text())})`);

  // Pasting is not typing.
  await setText('name = "Kim"\nmsg = ""\n', 2, 8);
  await js(`(ide.editor.executeEdits('paste', [{ range: new ide.monaco.Range(2, 8, 2, 8), text: 'Hello {name}' }]), true)`);
  await sleep(100);
  check(await js(`ide.editor.getModel().getLineContent(2)`) === 'msg = "Hello {name}"', 'text inserted by an edit (not typed) is not converted');

  // Setting off.
  await js(`(ide.settings.set('editor.autoFString', false), true)`);
  await setText('name = "Kim"\nmsg = ""\n', 2, 8);
  await type('{');
  await type('name');
  await type('}');
  await sleep(150);
  check(await js(`ide.editor.getModel().getLineContent(2)`) === 'msg = "{name}"', `"Convert to f-string automatically" off: no conversion (${J(await text())})`);
  await js(`(ide.settings.set('editor.autoFString', true), true)`);

  // Settings pages.
  await js(`(ide.openSettings('editor'), true)`);
  await until(`!!document.querySelector('.settings-page input[data-key="editor.stickyLines"]')`, 'editor settings page');
  const general = await js(`(() => { const c = document.querySelector('.settings-page input[data-key="editor.stickyLines"]'); const n = document.querySelector('.settings-page input[data-key="editor.stickyLinesMax"]');
    return { checked: c.checked, label: c.closest('fieldset').querySelector('legend').textContent, max: n.value }; })()`);
  check(general.checked && general.label === 'Appearance' && general.max === '5', `Settings › Editor › General › Appearance has "Show sticky lines" (on) and the maximum (5) (${J(general)})`);
  await js(`(document.querySelector('.settings-nav-row[data-page="smart-keys"]').click(), true)`);
  await until(`!!document.querySelector('.settings-page input[data-key="editor.autoFString"]')`, 'smart keys page');
  check(await js(`document.querySelector('.settings-page input[data-key="editor.autoFString"]').checked`), 'Settings › Editor › Smart Keys › Python has "Convert to f-string automatically" (on)');
  await js(`(document.querySelector('.settings-page input[data-key="editor.autoFString"]').click(), true)`);
  await js(`(document.getElementById('settingsOk').click(), true)`);
  await until(`ide.settings.get('editor.autoFString') === false`, 'setting saved', 5000).catch(() => {});
  check(await js(`ide.settings.get('editor.autoFString') === false`), 'unticking it and OK turns the conversion off');
  await js(`(ide.settings.set('editor.autoFString', true), true)`);
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.close();

// ---------------- Korean ----------------
const k = await launch({ fixture: 'editor-assists', port: 9386, name: 'editor-assists-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.openSettings('editor'), true)`);
  await k.until(`!!document.querySelector('.settings-page input[data-key="editor.stickyLines"]')`, 'editor settings page (ko)');
  const label = await k.js(`document.querySelector('.settings-page input[data-key="editor.stickyLines"]').closest('label').textContent`);
  k.check(label === '고정 줄 표시', `Korean: "${label}"`);
  await k.js(`(document.querySelector('.settings-nav-row[data-page="smart-keys"]').click(), true)`);
  await k.until(`!!document.querySelector('.settings-page input[data-key="editor.autoFString"]')`, 'smart keys page (ko)');
  const fl = await k.js(`document.querySelector('.settings-page input[data-key="editor.autoFString"]').closest('label').textContent + ' | ' + document.querySelector('.settings-nav-row[data-page="smart-keys"]').textContent`);
  k.check(fl.includes('자동으로 f-문자열로 변환') && fl.includes('스마트 키'), `Korean: "${fl}"`);
  const missing = (await missingTranslations(k)).filter((s) => /sticky|f-string|Smart Keys|f prefix/i.test(s));
  k.check(missing.length === 0, `no untranslated editor-assists strings (${J(missing)})`);
} catch (err) {
  k.check(false, `unexpected error: ${err.message}`);
}
k.close();

const all = [...t.results, ...k.results];
const errors = [...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
