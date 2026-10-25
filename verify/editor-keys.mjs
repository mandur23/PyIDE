// PyCharm editor keys and docstring stubs (renderer/features/editor-assists, core keymap and Find Action): Start New
// Line, Complete Current Statement (a table of statements and real keys), Start New Line Before Current, Join Lines,
// Toggle Case, Add/Unselect/Select All Occurrences, Move Statement (a table and real keys), Collapse/Expand All, Quick
// Definition, Type Info, Ctrl+F5 Rerun, Ctrl+Shift+T no longer reopening a tab, keys bound by action id to other
// plugins' actions, Find Action listing Monaco's actions, the main menu, triple quotes closed as typed, docstring stubs
// in each format, closing triple quotes typed over, and the Korean titles and settings. Ports 9510-9511.
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'editor-keys', port: 9510 });
const { js, until, check, sleep, cdp } = t;

// Real key events. Chords go through rawKeyDown without text, so only the keymap (or Monaco's keybindings) acts.
const CODES = { '-': ['Minus', 189, '_'], '=': ['Equal', 187, '+'], Enter: ['Enter', 13], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], F5: ['F5', 116], F4: ['F4', 115], Escape: ['Escape', 27] };
async function key(combo) {
  const parts = combo.split('+');
  const k = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Shift') ? 8 : 0);
  const [code, vk, shifted] = CODES[k] || [`Key${k.toUpperCase()}`, k.toUpperCase().charCodeAt(0)];
  const name = CODES[k] ? (mods & 8 && shifted ? shifted : k) : mods & 8 ? k.toUpperCase() : k.toLowerCase();
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mods, key: name, code, windowsVirtualKeyCode: vk });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: name, code, windowsVirtualKeyCode: vk });
  await sleep(80);
}
// Typed characters, as a keyboard sends them (Monaco's auto-closing and onDidType see them).
async function typeKeys(text) {
  for (const ch of text) {
    const enter = ch === '\n';
    const ev = enter ? { key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 } : { key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch === '"' || ch === "'" ? 222 : ch.toUpperCase().charCodeAt(0) };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...ev });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.windowsVirtualKeyCode });
    await sleep(60);
  }
}
const setText = (text, line, col) => js(`(() => { const e = ide.editor; e.trigger('t', 'hideSuggestWidget', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const text = () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const caret = () => js(`(() => { const p = ide.editor.getPosition(); return [p.lineNumber, p.column]; })()`);
const selections = () => js(`ide.editor.getSelections().map((s) => ide.editor.getModel().getValueInRange(s))`);
const keysOf = (id) => js(`ide.actions.find((a) => a.id === ${J(id)})?.keys || null`);
const has = (id) => js(`ide.actions.some((a) => a.id === ${J(id)})`);
// The action a combo runs in the focused main editor (the last matching registration wins, as in the keymap).
const actionFor = (combo) => js(`(() => { const a = ide.actions.findLast((a) => a.keys.includes(${J(combo)}) && (!a.when || a.when()) && ide.actionEnabled(a)); return a?.id || null; })()`);

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await openFile(t, 'keys.py');
  await js(`(ide.editor.focus(), true)`);

  // ---------------- keymap ----------------
  const expected = {
    'Shift+Enter': 'EditorStartNewLine', 'Ctrl+Shift+Enter': 'EditorCompleteStatement', 'Ctrl+Alt+Enter': 'EditorStartNewLineBefore',
    'Ctrl+Shift+J': 'EditorJoinLines', 'Ctrl+Shift+U': 'EditorToggleCase', 'Alt+J': 'SelectNextOccurrence', 'Alt+Shift+J': 'UnselectPreviousOccurrence',
    'Ctrl+Alt+Shift+J': 'SelectAllOccurrences', 'Ctrl+Shift+ArrowUp': 'MoveStatementUp', 'Ctrl+Shift+ArrowDown': 'MoveStatementDown',
    'Ctrl+Shift+-': 'CollapseAllRegions', 'Ctrl+Shift+=': 'ExpandAllRegions', 'Ctrl+Shift+I': 'QuickImplementations',
    'Ctrl+Shift+P': 'ExpressionTypeInfo', 'Ctrl+P': 'ParameterInfo',
  };
  for (const [combo, id] of Object.entries(expected)) {
    const got = await actionFor(combo);
    check(got === id, `in a Python editor ${combo} runs ${id} (${got})`);
  }
  check(J(await keysOf('Rerun')) === J(['Ctrl+F5']), `Rerun, which the run plugin registers without keys, gets PyCharm's Ctrl+F5 by its id (${J(await keysOf('Rerun'))})`);
  check(J(await keysOf('ReopenClosedTab')) === '[]', `Reopen Closed Tab has no shortcut, as in PyCharm (${J(await keysOf('ReopenClosedTab'))})`);
  // Actions other plugins provide get their PyCharm keys by id when they are there.
  for (const [id, combo] of [['GotoImplementation', 'Ctrl+Alt+B'], ['GotoSuperMethod', 'Ctrl+U'], ['GotoTest', 'Ctrl+Shift+T'], ['OverrideMethods', 'Ctrl+O']]) {
    if (!(await has(id))) { console.log(`note: ${id} is not registered in this build; ${combo} stays as it was`); continue; }
    const keys = await keysOf(id);
    const runs = await actionFor(combo);
    check(keys.includes(combo) && runs === id, `${id} is on ${combo} and runs from it in a Python editor (${J(keys)}, ${runs})`);
  }
  check(J(await keysOf('OpenProject')) === '[]', `Open Folder… has no shortcut, as in PyCharm (${J(await keysOf('OpenProject'))})`);

  // ---------------- Start New Line, Start New Line Before Current ----------------
  await setText('def f():\n    return 1\n', 2, 7);
  await key('Shift+Enter');
  check(await text() === 'def f():\n    return 1\n    \n' || await text() === 'def f():\n    return 1\n\n', `Shift+Enter in the middle of "    return 1" keeps the line and opens one below (${J(await text())})`);
  check((await caret())[0] === 3, `the caret is on the new line (${J(await caret())})`);
  await setText('def f():\n    x = 1\n', 2, 6);
  await key('Ctrl+Alt+Enter');
  check(await text() === 'def f():\n    \n    x = 1\n' && J(await caret()) === '[2,5]', `Ctrl+Alt+Enter opens an indented line above and moves there (${J(await text())} ${J(await caret())})`);

  // ---------------- Complete Current Statement ----------------
  const cases = [
    ['if x == 1|', ':', true, 'if without its colon'],
    ['print("a"|', ')', false, 'unclosed call'],
    ['foo(a, [1, 2|', '])', false, 'two unclosed brackets'],
    ['msg = "abc|', '"', false, 'unterminated string'],
    ['def area(r|', '):', true, 'def with an unclosed parameter list'],
    ['def area|', '():', true, 'def without parentheses'],
    ['async def run(|', '):', true, 'async def'],
    ['class Shape|', ':', true, 'class'],
    ['else|', ':', true, 'else'],
    ['try|', ':', true, 'try'],
    ['with open(p) as f|', ':', true, 'with'],
    ['for i in range(3):|', '', true, 'already complete compound statement'],
    ['x = 1|', '', false, 'complete simple statement'],
    ['if x: return 1|', '', false, 'one-line if'],
    ['if (n := 10) > 5|', ':', true, 'walrus inside parentheses'],
    ['while (a and\n       b|', '):', true, 'condition over two lines'],
    ['foo(a,|\n    b)\nx = 1', '', false, 'call that continues on the next line'],
    ['print("a"|\nx = 1', ')', false, 'unclosed call followed by another statement'],
    ['x = foo(a,|\nb)\n', '', false, 'call continued on a line that is not indented'],
    ["data = {|\n'a': 1,\n}\n", '', false, 'dict literal whose lines are not indented'],
    ['foo(a,|\ndef g():\n    pass\n', ')', false, 'unclosed call followed by a def'],
  ];
  const fixed = cases.map(([src]) => { const i = src.indexOf('|'); return src.slice(0, i) + src.slice(i + 1); }).map((s, i) => [s, cases[i][0].indexOf('|')]);
  const results = await js(`${J(fixed)}.map(([s, at]) => ide.editorAssists.statementCompletion(s, at))`);
  cases.forEach(([src, insert, block, label], i) => {
    const r = results[i];
    check(r && r.insert === insert && r.block === block, `Complete Current Statement: ${label} (${J(src)} -> ${J(r && { insert: r.insert, block: r.block })})`);
  });
  const commented = await js(`ide.editorAssists.statementCompletion('if x == 1  # note', 3)`);
  check(commented.at === 9 && commented.end === 17 && commented.insert === ':', `the colon goes before a trailing comment and the new line after it (${J(commented)})`);

  await setText('def f(x):\n    if x == 1\n', 2, 8);
  await key('Ctrl+Shift+Enter');
  check(await text() === 'def f(x):\n    if x == 1:\n        \n' && J(await caret()) === '[3,9]', `Ctrl+Shift+Enter after "if x == 1" adds the colon and moves to an indented new line (${J(await text())} ${J(await caret())})`);
  await key('Ctrl+Z');
  check(await text() === 'def f(x):\n    if x == 1\n', `one Undo takes the whole completion back (${J(await text())})`);
  await setText('total = sum([1, 2\n', 1, 8);
  await key('Ctrl+Shift+Enter');
  check(await text() === 'total = sum([1, 2])\n\n' && (await caret())[0] === 2, `Ctrl+Shift+Enter closes the brackets of "total = sum([1, 2" from the middle of the line (${J(await text())})`);

  // ---------------- Join Lines, Toggle Case, occurrences ----------------
  await setText('items = [\n    1,\n]\n', 1, 3);
  await key('Ctrl+Shift+J');
  check((await text()).startsWith('items = [ 1,\n') || (await text()).startsWith('items = [1,\n'), `Ctrl+Shift+J joins the next line (${J(await text())})`);
  await setText('name = "hello world"\n', 1, 11);
  await key('Ctrl+Shift+U');
  check(await text() === 'name = "HELLO world"\n', `Ctrl+Shift+U with no selection upper-cases the word at the caret (${J(await text())})`);
  await key('Ctrl+Shift+U');
  check(await text() === 'name = "hello world"\n', `again, it lower-cases it (${J(await text())})`);
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 9, 1, 20)), true)`);
  await key('Ctrl+Shift+U');
  check(await text() === 'name = "HELLO WORLD"\n', `with a selection it toggles the selection (${J(await text())})`);
  await setText('foo = 1\nfoo += foo\nprint(foo)\n', 1, 2);
  await key('Alt+J');
  await key('Alt+J');
  await key('Alt+J');
  check(J(await selections()) === J(['foo', 'foo', 'foo']), `Alt+J three times selects foo and its next two occurrences (${J(await selections())})`);
  await key('Alt+Shift+J');
  check((await selections()).length === 2, `Alt+Shift+J takes the last occurrence back out (${(await selections()).length})`);
  await js(`(ide.editor.setPosition({ lineNumber: 1, column: 2 }), true)`);
  await key('Ctrl+Alt+Shift+J');
  check((await selections()).length === 4, `Ctrl+Alt+Shift+J selects all four occurrences (${(await selections()).length})`);

  // ---------------- Move Statement ----------------
  const moveCases = [
    ['def a():\n    return 1\n\n\ndef b():\n    return 2\n', 4, -1, 'def b():\n    return 2\n\n\ndef a():\n    return 1\n', 'def b above def a, blank lines kept'],
    ['@dec\ndef a():\n    pass\n\n@dec2\ndef b():\n    pass\n', 5, -1, '@dec2\ndef b():\n    pass\n\n@dec\ndef a():\n    pass\n', 'decorators move with their functions'],
    ['if x:\n    a()\nelse:\n    b()\nc()\n', 0, 1, 'c()\nif x:\n    a()\nelse:\n    b()\n', 'if moves with its else'],
    ['def f():\n    x = 1\n    y = call(\n        2,\n    )\n', 3, -1, 'def f():\n    y = call(\n        2,\n    )\n    x = 1\n', 'a call over three lines moves as one statement'],
    ['# about a\na = 1\nb = 2\n', 2, -1, 'b = 2\n# about a\na = 1\n', 'the comment right above a statement moves with it'],
  ];
  const moved = await js(`${J(moveCases)}.map(([s, line, dir]) => { const m = ide.editorAssists.statementMove(s, line, dir); if (!m) return m; const lines = s.split('\\n'); lines.splice(m.from, m.to - m.from + 1, ...m.lines); return lines.join('\\n'); })`);
  moveCases.forEach(([src, , , want, label], i) => check(moved[i] === want, `Move Statement: ${label} (${J(moved[i])})`));
  check(await js(`ide.editorAssists.statementMove('def f():\\n    x = 1\\n    y = 2\\n', 1, -1)`) === false, 'the first statement of a body does not move out of it');
  check(await js(`ide.editorAssists.statementMove('x = 1\\n\\ny = 2\\n', 1, -1)`) === null, 'a blank line is left to Move Line');

  await setText('def a():\n    return 1\n\n\ndef b():\n    return 2\n', 5, 5);
  await key('Ctrl+Shift+ArrowUp');
  check(await text() === 'def b():\n    return 2\n\n\ndef a():\n    return 1\n' && J(await caret()) === '[1,5]', `Ctrl+Shift+Up on the def b line moves the function above def a and the caret along (${J(await text())} ${J(await caret())})`);
  await key('Ctrl+Shift+ArrowDown');
  check(await text() === 'def a():\n    return 1\n\n\ndef b():\n    return 2\n' && J(await caret()) === '[5,5]', `Ctrl+Shift+Down moves it back (${J(await caret())})`);
  await setText('def a():\n    return 1\n\n\ndef b():\n    return 2\n\n\nx = 1\n', 5, 5);
  await js(`(ide.editor.setSelections([new ide.monaco.Selection(5, 5, 5, 5), new ide.monaco.Selection(2, 7, 2, 7), new ide.monaco.Selection(9, 3, 9, 3)]), true)`);
  await key('Ctrl+Shift+ArrowUp');
  const carets = await js(`ide.editor.getSelections().map((s) => [s.positionLineNumber, s.positionColumn]).sort((a, b) => a[0] - b[0])`);
  check(await text() === 'def b():\n    return 2\n\n\ndef a():\n    return 1\n\n\nx = 1\n' && J(carets) === J([[1, 5], [6, 7], [9, 3]]),
    `with three carets each moves with its own line: def b to line 1, "return 1" of def a to line 6, the caret on x = 1 stays (${J(carets)})`);

  // ---------------- Collapse All / Expand All ----------------
  await setText('def a():\n    x = 1\n    return x\n\n\ndef b():\n    return 2\n', 1, 1);
  await sleep(500);
  const hidden = () => js(`!ide.editor.getVisibleRanges().some((r) => r.startLineNumber <= 2 && 2 <= r.endLineNumber)`);
  await key('Ctrl+Shift+-');
  await until(hidden(), 'collapsed', 5000).catch(() => {});
  check(await hidden(), 'Ctrl+Shift+Minus collapses every function body');
  await key('Ctrl+Shift+=');
  await until(`!(${await hidden()})`, 'expanded', 5000).catch(() => {});
  check(!(await hidden()), 'Ctrl+Shift+= expands them again');

  // ---------------- Quick Definition, Type Info (Pyright) ----------------
  await openFile(t, 'shapes.py');
  await js(`ide.lsp.ready()`);
  await until(`ide.lsp.documentSymbols(ide.activeTab().path).then((s) => s.length > 0)`, 'Pyright symbols', 60000);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 11, column: 11 }), true)`);
  await key('Ctrl+Shift+I');
  await until(`!!ide.editor.getDomNode().querySelector('.peekview-widget')`, 'peek', 15000).catch(() => {});
  check(await js(`!!ide.editor.getDomNode().querySelector('.peekview-widget')`), 'Ctrl+Shift+I on Shape() shows its definition in place (Quick Definition)');
  await key('Escape');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 7, column: 6 }), true)`);
  await key('Ctrl+Shift+P');
  await until(`[...document.querySelectorAll('.monaco-hover')].some((n) => n.offsetParent && /count: int/.test(n.textContent))`, 'type info', 15000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.monaco-hover')].some((n) => n.offsetParent && /count: int/.test(n.textContent))`), 'Ctrl+Shift+P on count shows its type (count: int)');
  await key('Escape');

  // ---------------- Ctrl+F5, Ctrl+Shift+T ----------------
  await js(`(window.__keysMarker = 1, (() => { const a = ide.actions.find((x) => x.id === 'Rerun'); window.__rerunRun = a.run; a.run = () => { window.__reruns = (window.__reruns || 0) + 1; }; })(), true)`);
  await js(`(ide.editor.focus(), true)`);
  await key('Ctrl+F5');
  check(await js(`window.__reruns === 1 && window.__keysMarker === 1`), 'Ctrl+F5 runs Rerun (and the page does not reload)');
  await js(`(ide.actions.find((x) => x.id === 'Rerun').run = window.__rerunRun, true)`);
  if (!(await has('GotoTest'))) {
    await js(`ide.closeTab(ide.activeTab().path, true)`);
    const before = await js(`ide.groups()[0].tabs.length`);
    await js(`(ide.editor.focus(), true)`);
    await key('Ctrl+Shift+T');
    await sleep(300);
    check(await js(`ide.groups()[0].tabs.length`) === before, 'Ctrl+Shift+T no longer reopens the closed tab');
    await js(`(ide.runAction('ReopenClosedTab'), true)`);
    await until(`ide.groups()[0].tabs.some((t) => t.title === 'shapes.py')`, 'reopened', 5000).catch(() => {});
    check(await js(`ide.groups()[0].tabs.some((t) => t.title === 'shapes.py')`), 'Window › Reopen Closed Tab still reopens it');
  }

  // ---------------- Find Action ----------------
  await openFile(t, 'keys.py');
  await setText('b = 2\na = 1\nc = 3\n', 1, 1);
  await js(`(ide.runAction('GotoAction'), true)`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'Find Action');
  await t.type('Join Lines');
  await until(`[...document.querySelectorAll('#popupList .popup-item')].some((r) => r.querySelector('.label')?.textContent === 'Join Lines')`, 'Join Lines row', 5000).catch(() => {});
  const joinRows = await js(`[...document.querySelectorAll('#popupList .popup-item')].filter((r) => r.querySelector('.label')?.textContent === 'Join Lines').map((r) => r.querySelector('.hint-right')?.textContent || '')`);
  check(J(joinRows) === J(['Ctrl+Shift+J']), `Find Action lists Join Lines once, as the IDE action with its key (${J(joinRows)})`);
  await key('Escape');
  await until(`document.getElementById('popup').classList.contains('hidden')`, 'Find Action closed');
  await js(`(ide.runAction('GotoAction'), true)`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'Find Action');
  await t.type('Sort Lines Ascending');
  await until(`[...document.querySelectorAll('#popupList .popup-item')].some((r) => r.querySelector('.label')?.textContent === 'Sort Lines Ascending')`, 'Monaco action row', 5000).catch(() => {});
  check(await js(`[...document.querySelectorAll('#popupList .popup-item')].some((r) => r.querySelector('.label')?.textContent === 'Sort Lines Ascending')`), "Find Action finds Monaco's Sort Lines Ascending");
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 3, 6)), true)`);
  await js(`([...document.querySelectorAll('#popupList .popup-item')].find((r) => r.querySelector('.label')?.textContent === 'Sort Lines Ascending').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  await until(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n').startsWith('a = 1\\nb = 2')`, 'sorted', 5000).catch(() => {});
  check((await text()).startsWith('a = 1\nb = 2\nc = 3'), `choosing it sorts the selected lines in the editor (${J(await text())})`);
  await js(`(ide.ui.closeMenus?.(), document.getElementById('popup').classList.contains('hidden') || ide.ui.closePopup?.(), true)`);

  // ---------------- main menu ----------------
  const menuRow = (level, label) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].find((n) => n.querySelector('.menu-label').textContent === ${J(label)})`;
  async function submenu(label) {
    await js(`(ide.ui.closeMenus(), true)`);
    await t.click('#mainMenuBtn');
    await until(`!!document.querySelector('#mainMenu')`, 'main menu');
    const p = await js(`(() => { const r = (${menuRow(0, label)}).getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await until(`document.querySelectorAll('.context-menu[data-level="1"] .menu-item').length > 0`, `${label} submenu`);
    const items = await js(`Object.fromEntries([...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].map((n) => [n.querySelector('.menu-label').textContent, n.querySelector('.hint-right')?.textContent || '']))`);
    await js(`(ide.ui.closeMenus(), true)`);
    return items;
  }
  const edit = await submenu('Edit');
  check(edit['Join Lines'] === 'Ctrl+Shift+J' && edit['Toggle Case'] === 'Ctrl+Shift+U' && edit['Complete Current Statement'] === 'Ctrl+Shift+Enter'
    && edit['Start New Line'] === 'Shift+Enter' && edit['Add Selection for Next Occurrence'] === 'Alt+J', `Edit menu lists the editing actions with their keys (${J(edit)})`);
  const code = await submenu('Code');
  check(code['Move Statement Up'] === 'Ctrl+Shift+↑' && code['Collapse All'] === 'Ctrl+Shift+-' && 'Expand All' in code, `Code menu lists Move Statement and Collapse/Expand All (${J(code)})`);
  const view = await submenu('View');
  check(view['Quick Definition'] === 'Ctrl+Shift+I' && view['Type Info'] === 'Ctrl+Shift+P', `View menu lists Quick Definition and Type Info (${J(view)})`);

  // ---------------- triple quotes and docstring stubs ----------------
  const docCases = [
    ['restructuredtext', 'def area(r, pi=3.14):\n', 'def area(r, pi=3.14):\n    """\n    \n    :param r:\n    :param pi:\n    :return:\n    """'],
    ['google', 'def area(r, *args, **kw) -> float:\n', 'def area(r, *args, **kw) -> float:\n    """\n    \n\n    Args:\n        r:\n        *args:\n        **kw:\n\n    Returns:\n    """'],
    ['numpy', 'def area(r):\n', 'def area(r):\n    """\n    \n\n    Parameters\n    ----------\n    r\n\n    Returns\n    -------\n    """'],
    ['plain', 'def area(r):\n', 'def area(r):\n    """\n    \n    """'],
  ];
  for (const [format, src, want] of docCases) {
    await js(`(ide.settings.set('python.docstringFormat', ${J(format)}), true)`);
    await setText(src, 2, 1);
    await typeKeys('    """');
    if (format === 'restructuredtext') check(await text() === `${src}    """"""` && J(await caret()) === '[2,8]', `typing """ under a def closes the quotes, caret between them (${J(await text())} ${J(await caret())})`);
    await typeKeys('\n');
    check(await text() === want, `Enter writes the ${format} stub (${J(await text())})`);
    check(J(await caret()) === '[3,5]', `the caret waits on the summary line (${J(await caret())})`);
  }
  await key('Ctrl+Z');
  check(await text() === 'def area(r):\n    """\n    """', `Undo takes the stub back, keeping the quotes (${J(await text())})`);

  await js(`(ide.settings.set('python.docstringFormat', 'restructuredtext'), true)`);
  const stubFor = async (src, line, col, typed = '"""\n') => { await setText(src, line, col); await typeKeys(typed); return text(); };
  check(await stubFor('class Box:\n    def put(self, item) -> None:\n        \n', 3, 9) === 'class Box:\n    def put(self, item) -> None:\n        """\n        \n        :param item:\n        """\n',
    'a method: self is left out, and -> None gets no return entry');
  check(await stubFor('def run(\n    a,\n    b=(1, 2),\n):\n    \n', 5, 5) === 'def run(\n    a,\n    b=(1, 2),\n):\n    """\n    \n    :param a:\n    :param b:\n    :return:\n    """\n',
    'a signature over several lines');
  check(await stubFor('class Box:\n    \n', 2, 5) === 'class Box:\n    """\n    \n    """\n', 'a class gets an empty stub');
  check(await stubFor('def f(a):\n    x = 1\n    \n', 3, 5) === 'def f(a):\n    x = 1\n    """\n    """\n', 'not the first statement of the body: no stub');
  await js(`(ide.settings.set('python.docstringFormat', ''), true)`);
  check(await stubFor('def g(x):\n    """Do.\n\n    Args:\n        x: value.\n    """\n\n\ndef f(a):\n    \n', 10, 5) === 'def g(x):\n    """Do.\n\n    Args:\n        x: value.\n    """\n\n\ndef f(a):\n    """\n    \n\n    Args:\n        a:\n\n    Returns:\n    """\n',
    'Auto-detect follows the Google docstrings already in the file');
  await js(`(ide.settings.set('python.docstringFormat', 'restructuredtext'), true)`);
  check(await stubFor('def f():\n    """Summary.\n    \n', 3, 5, '"""') === 'def f():\n    """Summary.\n    """\n', 'typing the closing """ of an open docstring adds no more quotes');
  const inComment = await stubFor('x = 1  # \n', 1, 10, '"""');
  check(!inComment.includes('"'.repeat(5)), `in a comment, """ gets no closing quotes (${J(inComment)})`);
  check(await stubFor('s = \n', 1, 5, "'''") === "s = ''''''\n", "''' is closed too");
  check(await stubFor('def f():\n    \n', 2, 5, '"""Summary"""') === 'def f():\n    """Summary"""\n', `typing """Summary""" key by key leaves """Summary""", as in PyCharm (${J(await text())})`);
  check(J(await caret()) === '[2,18]', `the caret ends after the closing quotes (${J(await caret())})`);
  check(await stubFor('s = \n', 1, 5, "'''text''' + x") === "s = '''text''' + x\n", `the same for '''text''' with code after it (${J(await text())})`);
  check(await stubFor('def f():\n    \n', 2, 5, '"""Say "hi" now"""') === 'def f():\n    """Say "hi" now"""\n', `quotes inside the string do not close it early (${J(await text())})`);
  check(await stubFor('def f():\n    \n', 2, 5, '"""Summary') === 'def f():\n    """Summary"""\n', `without the closing quotes typed, the added ones stay (${J(await text())})`);
  await js(`(ide.settings.set('editor.docstringStub', false), true)`);
  check(await stubFor('def f(a):\n    \n', 2, 5) === 'def f(a):\n    """\n    """\n', 'with Insert documentation comment stub off, Enter only opens the line');
  await js(`(ide.settings.set('editor.docstringStub', true), true)`);

  // Settings › Editor › Smart Keys
  await js(`(ide.runAction('ShowSettings'), true)`);
  await until(`!!document.querySelector('.settings-nav-row[data-page="smart-keys"]')`, 'settings');
  await js(`(document.querySelector('.settings-nav-row[data-page="smart-keys"]').click(), true)`);
  await until(`!!document.querySelector('.settings-page input[data-key="editor.docstringStub"]')`, 'smart keys page');
  check(await js(`document.querySelector('.settings-page input[data-key="editor.docstringStub"]').checked`), 'Settings › Editor › Smart Keys has "Insert documentation comment stub" (on)');
  await key('Escape');
} catch (e) {
  check(false, `unexpected error: ${e.message}`);
}
t.close();

const k = await launch({ fixture: 'editor-keys', port: 9511, name: 'editor-keys-ko', lang: 'ko-KR' });
try {
  const titles = await k.js(`Object.fromEntries(['EditorStartNewLine', 'EditorCompleteStatement', 'EditorJoinLines', 'EditorToggleCase', 'MoveStatementUp', 'QuickImplementations', 'ExpressionTypeInfo'].map((id) => [id, ide.actions.find((a) => a.id === id)?.title]))`);
  k.check(titles.EditorStartNewLine === '새 줄 시작' && titles.EditorCompleteStatement === '현재 문 완성' && titles.EditorJoinLines === '줄 연결'
    && titles.EditorToggleCase === '대/소문자 전환' && titles.MoveStatementUp === '문 위로 이동' && titles.QuickImplementations === '빠른 정의' && titles.ExpressionTypeInfo === '타입 정보',
  `action titles are Korean (${J(titles)})`);
  await k.js(`(ide.runAction('ShowSettings'), true)`);
  await k.until(`!!document.querySelector('.settings-nav-row[data-page="smart-keys"]')`, 'settings');
  await k.js(`(document.querySelector('.settings-nav-row[data-page="smart-keys"]').click(), true)`);
  await k.until(`!!document.querySelector('.settings-page input[data-key="editor.docstringStub"]')`, 'smart keys page');
  const label = await k.js(`document.querySelector('.settings-page input[data-key="editor.docstringStub"]').closest('label').textContent`);
  k.check(label.includes('문서 주석 스텁 삽입'), `the stub setting reads "문서 주석 스텁 삽입" (${label})`);
  const missing = (await missingTranslations(k)).filter((s) => /Statement|Line|Case|Occurrence|Collapse|Expand|Definition|Type Info|stub|triple quotes|Editor Assists/i.test(s));
  k.check(!missing.length, `no missing Korean translations for this feature (${J(missing)})`);
} catch (e) {
  k.check(false, `unexpected error: ${e.message}`);
}
k.close();

const all = [...t.results, ...k.results];
const errors = [...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
