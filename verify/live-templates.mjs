// Live templates and postfix completion (renderer/features/live-templates): abbreviation + Tab, the completion list,
// postfix templates on the expression left of the dot, no expansion in strings or comments, Surround With (Ctrl+Alt+J),
// and a user template added in Settings that still works after a reload. Port 9970.
import { launch, openFile } from './lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'live-templates', port: 9970 });
const { js, until, press, type, click, check, sleep, cdp } = t;

const setText = (text, line = 1, col = 1) => js(`(() => { const e = ide.editor; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const state = () => js(`(() => { const e = ide.editor; const s = e.getSelection();
  return { text: e.getModel().getValue().replace(/\\r\\n/g, '\\n'), sel: [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn],
    snippet: !!e.getContribution('snippetController2').isInSnippet() }; })()`);
// Types text at the end of a fresh line (or after prefix) and presses Tab.
async function tabAfter(text, prefix = '') {
  await setText(prefix, prefix.split('\n').length, (prefix.split('\n').pop().length) + 1);
  await type(text);
  await sleep(120);
  await press('Tab');
  await sleep(150);
  return state();
}
const rows = () => `[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]`;

try {
  // Ghost text would take Tab first (ai-complete owns Tab while it is visible); keep this run about templates.
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.liveTemplates && ide.liveTemplates.templates().length >= 16`), 'live-templates plugin loaded with the built-in Python set');
  await openFile(t, 'scratch.py');

  // ---- abbreviation + Tab ----
  let s = await tabAfter('main');
  check(s.text === 'if __name__ == "__main__":\n    ' && J(s.sel) === J([2, 5, 2, 5]), `main+Tab expands, caret in the body (${J(s)})`);
  s = await tabAfter('iter');
  check(s.text === 'for item in items:\n    ' && J(s.sel) === J([1, 5, 1, 9]) && s.snippet, `iter+Tab expands with "item" selected as the first tab stop (${J(s)})`);
  await press('Tab');
  s = await state();
  check(J(s.sel) === J([1, 13, 1, 18]), `Tab moves to the next tab stop, "items" (${J(s.sel)})`);
  s = await tabAfter('pt');
  check(s.text === 'def test_name():\n    ' && J(s.sel) === J([1, 10, 1, 14]) && s.snippet, `pt+Tab expands with the test name selected (${J(s)})`);
  s = await tabAfter('itere', 'def f(xs):\n    ');
  check(s.text === 'def f(xs):\n    for i, item in enumerate(items):\n        ' && J(s.sel) === J([2, 9, 2, 10]), `itere+Tab inside a function keeps the indentation (${J(s)})`);
  s = await tabAfter('log');
  check(s.text === 'import logging\n\nlogger = logging.getLogger(__name__)', `log+Tab adds the logging import (${J(s.text)})`);
  s = await tabAfter('prop', 'class A:\n    ');
  check(s.text === 'class A:\n    @property\n    def name(self):\n        return self._name', `prop mirrors $NAME$ (${J(s.text)})`);
  s = await tabAfter('xmain');
  check(!s.text.includes('__name__'), `a longer word that ends in an abbreviation does not expand (${J(s.text)})`);

  // ---- picked from the completion list ----
  await setText('');
  await type('ite');
  await js(`(ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`${rows()}.some(r => r.querySelector('.label-name')?.textContent === 'iter')`, 'iter in the completion list');
  check(true, 'templates are offered in the completion list');
  await js(`(ide.editor.trigger('t', 'hideSuggestWidget', {}), true)`);

  // ---- postfix ----
  await setText('');
  await type('items.for');
  await js(`(ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  const isPostfixFor = `(r => r.querySelector('.label-name')?.textContent === 'for' && r.textContent.includes('postfix'))`;
  await until(`${rows()}.some(${isPostfixFor})`, 'postfix .for in the completion list');
  for (let i = 0; i < 40 && !(await js(`(${isPostfixFor})(document.querySelector('.suggest-widget.visible .monaco-list-row.focused') || document.body)`)); i++) {
    await js(`(ide.editor.trigger('t', 'selectNextSuggestion', {}), true)`);
    await sleep(40);
  }
  if (!(await js(`!!document.querySelector('.suggest-widget.visible .suggest-details-container .suggest-details:not([style*="display: none"]) .docs')`))) {
    await js(`(ide.editor.trigger('t', 'toggleSuggestionDetails', {}), true)`);
  }
  try {
    await until(`[...document.querySelectorAll('.suggest-details')].some(d => d.textContent.includes('for item in items:'))`, 'preview', 5000);
    check(true, 'the postfix item shows a preview of the result');
  } catch { check(false, 'the postfix item shows a preview of the result'); }
  await press('Enter');
  await sleep(150);
  s = await state();
  check(s.text === 'for item in items:\n    ' && J(s.sel) === J([1, 5, 1, 9]), `items.for picked from the list becomes "for item in items:" (${J(s)})`);
  s = await tabAfter('x.ifn');
  check(s.text === 'if x is None:\n    ' && J(s.sel) === J([2, 5, 2, 5]), `x.ifn+Tab becomes "if x is None:" (${J(s)})`);
  s = await tabAfter('foo(a, b).print');
  check(s.text === 'print(foo(a, b))', `foo(a, b).print wraps the whole call (${J(s.text)})`);
  s = await tabAfter('y = self.data["k"][0].len');
  check(s.text === 'y = len(self.data["k"][0])', `an expression postfix works mid-line on attributes and subscripts (${J(s.text)})`);
  s = await tabAfter('y = x.if');
  check(!s.text.includes('if x'), `a statement postfix does not expand mid-line (${J(s.text)})`);
  s = await tabAfter('"Hi {name}".f');
  check(s.text === 'f"Hi {name}"', `.f turns a string literal into an f-string (${J(s.text)})`);
  s = await tabAfter('users.nn', '    ');
  check(s.text === '    if users is not None:\n        ', `.nn keeps the line's indentation (${J(s.text)})`);
  const scanned = await js(`['a.b(c)', 'f(x)[1]', '(a + b)', 'x = y', 'g("s(", t)', "'it''s'"].map(l => l.slice(ide.liveTemplates.exprStart(l + '.', l.length))).join('|')`);
  check(scanned === `a.b(c)|f(x)[1]|(a + b)|y|g("s(", t)|'it''s'`, `the expression scan is bracket- and string-aware (${scanned})`);

  // ---- not in strings or comments ----
  s = await tabAfter('main', 's = "');
  check(!s.text.includes('__name__'), `no expansion inside a string (${J(s.text)})`);
  s = await tabAfter('iter', '# ');
  check(!s.text.includes('for '), `no expansion inside a comment (${J(s.text)})`);
  s = await tabAfter('main', '"""Docs\n');
  check(!s.text.includes('__name__'), `no expansion inside a triple-quoted string (${J(s.text)})`);
  s = await tabAfter('x.ifn', 's = "');
  check(!s.text.includes('is None'), `no postfix inside a string (${J(s.text)})`);
  await setText('s = "ite');
  await js(`(ide.editor.setPosition({ lineNumber: 1, column: 9 }), ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await sleep(800);
  check(!(await js(`${rows()}.some(r => r.querySelector('.label-name')?.textContent === 'iter')`)), 'templates are not offered inside a string');
  s = await tabAfter('main', 's = "a" + ');
  check(s.text.includes('__name__'), `expansion works again after a closed string (${J(s.text)})`);

  // ---- Surround With ----
  await setText('x = 1\ny = 2');
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 2, 6)), ide.editor.focus(), true)`);
  await press('Ctrl+Alt+J');
  await until(`document.querySelector('#popup') && getComputedStyle(document.querySelector('#popup')).display !== 'none' && [...document.querySelectorAll('#popupList .popup-item')].some(i => i.textContent.includes('try'))`, 'Surround With popup');
  check(!(await js(`[...document.querySelectorAll('#popupList .popup-item .label')].some(i => i.textContent === 'pt')`)), 'Surround With lists only templates with $SELECTION$');
  await type('try');
  await until(`document.querySelector('#popupList .popup-item.active')?.textContent.includes('try')`, 'try selected');
  await press('Enter');
  await until(`ide.editor.getValue().startsWith('try:')`, 'surrounded', 5000).catch(() => {});
  s = await state();
  check(s.text === 'try:\n    x = 1\n    y = 2\nexcept Exception as e:\n    raise', `Surround With wraps the selection in try/except (${J(s.text)})`);
  await setText('def f():\n    a()\n    if b:\n        c()\n');
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(2, 1, 5, 1)), ide.editor.focus(), ide.liveTemplates.surround(ide.editor, 'with'))`);
  s = await state();
  check(s.text === 'def f():\n    with open(path) as f:\n        a()\n        if b:\n            c()\n', `Surround With keeps nested indentation (${J(s.text)})`);

  // ---- Settings: a user template, a disabled built-in and a disabled postfix template ----
  await js(`(ide.editor.trigger('t', 'leaveSnippet', {}), ide.openSettings('live-templates'), true)`);
  await until(`!!document.querySelector('.lt-add') && !!document.querySelector('.lt-row[data-abbr="main"]')`, 'Live Templates page');
  check(await js(`document.querySelectorAll('.lt-postfix-row').length === 14`), 'the page lists the postfix templates');
  await click('.lt-add');
  await js(`(() => { const set = (sel, v, ev) => { const n = document.querySelector(sel); n.value = v; n.dispatchEvent(new Event(ev)); };
    set('.lt-abbr', 'hello', 'change'); set('.lt-desc', 'Say hello', 'input'); set('.lt-body', 'print("Hello, $NAME$")$END$', 'input'); return true; })()`);
  check(await js(`!!document.querySelector('.lt-row.selected[data-abbr="hello"]')`), 'the new template is listed under its abbreviation');
  // Real clicks on rows scrolled into view (the template list and the page both scroll).
  const clickInView = async (sel) => { await js(`(document.querySelector(${J(sel)}).scrollIntoView({ block: 'center' }), true)`); await sleep(50); await click(sel); };
  await clickInView('.lt-row[data-abbr="fstr"] input');
  await clickInView('.lt-postfix-row[data-key="par"] input');
  check(await js(`!document.querySelector('.lt-row[data-abbr="fstr"] input').checked && !document.querySelector('.lt-postfix-row[data-key="par"] input').checked`), 'the switches turn off');
  await click('#settingsOk');
  await sleep(200);
  const saved = await js(`[ide.settings.get('liveTemplates.custom'), ide.settings.get('liveTemplates.postfixDisabled')]`);
  check(saved[0]?.hello?.body === 'print("Hello, $NAME$")$END$' && saved[0]?.fstr?.enabled === false && J(saved[1]) === J(['par']), `OK stores the user template and the switches (${J(saved)})`);
  await js(`ide.settings.flush()`);
  await sleep(300);

  await cdp('Page.reload');
  await sleep(1500);
  await until('window.__ideReady === true', 'IDE ready after reload', 40000);
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await openFile(t, 'scratch.py');
  s = await tabAfter('hello');
  check(s.text === 'print("Hello, ")' && J(s.sel) === J([1, 15, 1, 15]) && s.snippet, `the user template expands after a reload, caret at $NAME$ (${J(s)})`);
  s = await tabAfter('fstr');
  check(!s.text.includes('f"'), `a disabled built-in does not expand (${J(s.text)})`);
  s = await tabAfter('x.par');
  check(!s.text.includes('(x)'), `a disabled postfix template does not expand (${J(s.text)})`);
  s = await tabAfter('main');
  check(s.text.includes('__name__'), 'other templates still expand');
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.finish();
