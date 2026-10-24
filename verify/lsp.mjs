import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'lsp', port: 9401 });
const { js, until, press, type, check, shot, cdp, sleep } = t;

// Places the caret like a click would and focuses the editor.
const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), ide.editor.revealPositionInCenter({ lineNumber: ${line}, column: ${col} }), true)`);
const where = () => js(`({ file: ide.activeTab()?.title, line: ide.editor.getPosition().lineNumber, col: ide.editor.getPosition().column })`);
const lineOf = (n) => js(`ide.editor.getModel().getLineContent(${n})`);
const problems = (file) => js(`ide.problems.all().filter(p => p.source === 'pyright' && p.path.endsWith(${JSON.stringify(file)}))`);
// Overflow widgets are position: fixed (offsetParent is null), so test the rendered box and visibility instead.
const shown = `n => n.getClientRects().length > 0 && n.getBoundingClientRect().height > 0 && getComputedStyle(n).visibility !== 'hidden'`;
const visible = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].some(${shown})`;
const textOf = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(${shown}).map(n => n.textContent).join(' | ')`);

// Picks the quick-fix menu entry whose text matches, using the arrow keys like a user.
async function chooseQuickFix(match) {
  await until(visible('.action-widget .monaco-list-row'), 'quick fix menu');
  const labels = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(r => r.textContent)`);
  const idx = labels.findIndex((l) => l.includes(match));
  if (idx < 0) throw new Error(`quick fix "${match}" not offered; got ${JSON.stringify(labels)}`);
  for (let i = 0; i < 20; i++) {
    const focused = await js(`document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent || ''`);
    if (focused.includes(match)) break;
    await press('ArrowDown');
  }
  await press('Enter');
  return labels;
}

try {
  await until(`document.querySelector('#lspStatus')?.textContent === 'Pyright: ready'`, 'Pyright ready', 30000);
  check(true, 'status bar shows "Pyright: ready"');

  // ---- diagnostics ----
  await js(`[...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('errors.py')).click()`);
  await until(`ide.activeTab()?.title === 'errors.py'`, 'errors.py tab');
  await until(`ide.problems.all().filter(p => p.source === 'pyright' && p.path.endsWith('errors.py')).length >= 3`, 'pyright diagnostics for errors.py', 30000);
  const diags = await problems('errors.py');
  check(diags.some((p) => p.line === 11 && p.severity === 'error' && /not assignable/.test(p.msg)), 'type error reported on line 11');
  check(diags.some((p) => p.line === 12 && /"undefined_name" is not defined/.test(p.msg)), 'undefined name reported on line 12');
  check(diags.some((p) => p.line === 13 && /"os" is not defined/.test(p.msg)), 'missing import reported on line 13');
  check(await js(`monaco.editor.getModelMarkers({ owner: 'pyright' }).length >= 3`), 'diagnostics become editor markers');
  check(await js(`monaco.editor.getModelMarkers({ owner: 'pyright.hints' }).some(m => /sys/.test(m.message) && m.tags?.includes(1))`), 'unused import is greyed out as an unnecessary-code hint');
  check(!diags.some((p) => /"sys" is not accessed/.test(p.msg)), 'hints are kept out of the Problems list');
  check(await js(`[...document.querySelectorAll('#problemList .problem')].some(r => r.textContent.includes('undefined_name'))`), 'Problems tool window lists pyright problems');
  // Pyright checks files on its background thread (main/features/lsp.js), so requests do not wait for a check.
  const pyrightLog = await js(`ide.api.invoke('lsp:log')`);
  check(/BG: Background analysis\(\d+\) started/.test(pyrightLog), 'Pyright runs its background-analysis thread');

  // ---- F2 / Shift+F2 ----
  await caret(1, 1);
  await press('F2');
  let p = await where();
  check(p.line === 11, `F2 jumps to the first error (line ${p.line})`);
  await until(visible('.monaco-hover'), 'hover with the problem after F2');
  check(/not assignable/.test(await textOf('.monaco-hover')), 'F2 shows the error description');
  await press('Escape');
  await press('F2');
  check((await where()).line === 12, 'F2 again goes to the next error');
  await press('Shift+F2');
  check((await where()).line === 11, 'Shift+F2 goes back to the previous error');
  await press('Escape');

  // ---- Alt+Enter: auto-import and suppression ----
  await caret(13, 11);
  await press('Alt+Enter');
  const fixes = await chooseQuickFix("Import 'os'");
  check(true, `Alt+Enter offers Import 'os' (menu: ${fixes.join(', ')})`);
  await until(`ide.editor.getModel().getLineContent(2) === 'import os'`, 'import os inserted');
  check(await lineOf(1) === 'import sys', 'import added after the existing imports');
  await until(`!ide.problems.all().some(p => p.source === 'pyright' && /"os" is not defined/.test(p.msg))`, 'os diagnostic cleared');
  check(true, 'diagnostics update after the edit (didChange)');

  await caret(12, 3);
  await press('Alt+Enter');
  await chooseQuickFix('Suppress');
  await until(`ide.editor.getModel().getLineContent(12).includes('# pyright: ignore[reportAssignmentType]')`, 'suppression comment');
  await until(`!ide.problems.all().some(p => p.source === 'pyright' && /not assignable/.test(p.msg))`, 'type error suppressed');
  check(true, 'Alt+Enter "Suppress for statement" adds a pyright ignore comment');
  await shot('diagnostics.png');
  await press('Ctrl+S');

  // ---- hover / Ctrl+Q ----
  await openFile(t, 'app.py');
  await until(`ide.lsp.status() === 'ready'`, 'ready');
  await caret(6, 25);
  await press('Ctrl+Q');
  await until(`${visible('.monaco-hover')} && /def greet/.test([...document.querySelectorAll('.monaco-hover')].map(n => n.textContent).join(''))`, 'quick documentation');
  check(/Return a greeting/.test(await textOf('.monaco-hover')), 'Ctrl+Q shows the signature and docstring');
  await shot('quick-doc.png');
  await press('Escape');

  // ---- document highlights ----
  // Monaco only highlights after a user-driven caret move, so step with the arrow keys.
  await caret(5, 6);
  await press('ArrowRight');
  await until(`ide.editor.getModel().getAllDecorations().filter(d => /^wordHighlight/.test(d.options.className || '')).length >= 2`, 'usages of greeter highlighted').catch(async (e) => { console.log(await js(`JSON.stringify([ide.editor.hasTextFocus(), document.activeElement?.className, ide.editor.getPosition(), ide.editor.getModel().getAllDecorations().map(d => d.options.description)])`)); throw e; });
  check(true, 'caret on a symbol highlights its usages in the file');

  // ---- Ctrl+B ----
  await caret(6, 25);
  await press('Ctrl+B');
  await until(`ide.activeTab()?.title === 'models.py'`, 'models.py opened by Ctrl+B');
  p = await where();
  check(p.line === 10 && p.col === 9, `Ctrl+B goes to the declaration in another file (models.py:${p.line}:${p.col})`);

  // Ctrl+B on the declaration itself shows usages.
  await press('Ctrl+B');
  await until(`ide.toolWindows.get('FindUsages').isVisible() && document.querySelectorAll('#lspFindList .lsp-find-row').length >= 3`, 'usages shown by Ctrl+B on declaration');
  check(/greet/.test(await textOf('.lsp-find-head')), 'Ctrl+B on a declaration lists its usages');

  // ---- Alt+F7 ----
  await caret(4, 9);
  await press('Alt+F7');
  await until(`/Greeter/.test(document.querySelector('.lsp-find-head')?.textContent)`, 'usages of Greeter');
  const files = await js(`[...document.querySelectorAll('#lspFindList .lsp-find-file .name')].map(n => n.textContent)`);
  const rows = await js(`[...document.querySelectorAll('#lspFindList .lsp-find-row')].map(r => r.textContent)`);
  check(['app.py', 'models.py', 'playground.py'].every((f) => files.includes(f)), `Find window groups usages by file (${files.join(', ')})`);
  check(rows.some((r) => r.startsWith('8') && r.includes('other = Greeter()')), 'usage rows show line number and code');
  check(await js(`ide.toolWindows.get('FindUsages').tab.textContent.startsWith('Find')`), 'tool window is titled Find');
  await shot('find-usages.png');
  await js(`[...document.querySelectorAll('#lspFindList .lsp-find-row')].find(r => r.textContent.includes('other = Greeter()')).scrollIntoView()`);
  await t.click('#lspFindList .lsp-find-row[data-line="8"]');
  await until(`ide.activeTab()?.title === 'app.py' && ide.editor.getPosition().lineNumber === 8`, 'navigated from usage row');
  check(true, 'clicking a usage opens the file at that line');

  // ---- Ctrl+Alt+B ----
  await caret(5, 7);
  await press('Ctrl+Alt+B');
  await until(`ide.activeTab()?.title === 'models.py'`, 'type declaration');
  p = await where();
  check(p.line === 4, `Ctrl+Alt+B goes to the type declaration (models.py:${p.line})`);

  // ---- Ctrl+Click ----
  await openFile(t, 'app.py');
  await caret(5, 1);
  await sleep(300);
  const box = await js(`(() => { const e = ide.editor; e.revealLineInCenter(5); const v = e.getScrolledVisiblePosition({ lineNumber: 5, column: 20 }); const r = e.getDomNode().getBoundingClientRect(); return { x: r.left + v.left + 2, y: r.top + v.top + v.height / 2 }; })()`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 4, y: box.y, modifiers: 2 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, modifiers: 2 });
  await sleep(500);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, modifiers: 2, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, modifiers: 2, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await until(`ide.activeTab()?.title === 'models.py' && ide.editor.getPosition().lineNumber === 15`, 'Ctrl+Click navigation');
  check(true, 'Ctrl+Click on make_greeter opens models.py at its definition');

  // ---- Shift+F6 rename across files (models.py and app.py open, cli.py closed) ----
  await openFile(t, 'app.py');
  await caret(6, 25);
  await press('Shift+F6');
  await until(`${visible('.rename-box input')} && document.activeElement?.closest('.rename-box') && document.activeElement.value === 'greet'`, 'inline rename box with the name selected');
  check(true, 'Shift+F6 opens inline rename prefilled with the symbol');
  await type('say_hello');
  await press('Enter');
  await until(`/say_hello/.test(ide.editor.getModel().getLineContent(6))`, 'rename applied in app.py');
  check(/other\.say_hello\("world"\)/.test(await lineOf(9)), 'rename updates every usage in the current file');
  check(await js(`ide.findTab(ide.util.joinPath(ide.root, 'models.py')).model.getLineContent(10).includes('def say_hello(')`), 'rename updates the declaration in another open file');
  const cli = await js(`ide.api.read(ide.util.joinPath(ide.root, 'cli.py'))`);
  check(cli.includes('.say_hello("cli")'), 'rename rewrites a closed file on disk');
  // A closed CP949 file keeps its encoding (it was written back as UTF-8, breaking its Korean text).
  const kr = await js(`ide.api.invoke('fs:readText', ide.util.joinPath(ide.root, 'kr_cp949.py'))`);
  check(kr.encoding === 'cp949' && kr.text.includes('make_greeter("kr").say_hello("kr"))  # 인사') && kr.text.includes('# 한글 인사'),
    `rename rewrites a closed CP949 file in CP949 (${JSON.stringify(kr)})`);
  await shot('rename.png');
  await press('Ctrl+S');

  // ---- completion with resolve, signature help ----
  await openFile(t, 'playground.py');
  await until(`ide.lsp.status() === 'ready'`, 'ready');
  await caret(3, 14);
  await type('\n'); // CDP rawKeyDown carries no text, so a typed newline stands in for Enter
  await type('g.');
  await until(`${visible('.suggest-widget .monaco-list-row')} && [...document.querySelectorAll('.suggest-widget .monaco-list-row')].some(r => /say_hello/.test(r.getAttribute('aria-label')))`, 'member completion after "."', 20000);
  const sugg = await js(`[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map(r => r.getAttribute('aria-label'))`);
  check(sugg.some((s) => /greeting/.test(s)), `'.' completion lists members (${sugg.slice(0, 4).join(', ')})`);
  check(!sugg.some((s) => /^(pass|return|class|def|while)\b/.test(s || '')), `member completion offers no keywords or statement snippets (${sugg.filter((s) => /^(pass|return|class|def|while)\b/.test(s || '')).join(', ') || 'none'})`);
  await type('say');
  await until(`/say_hello/.test(document.querySelector('.suggest-widget .monaco-list-row.focused')?.getAttribute('aria-label'))`, 'say_hello focused');
  if (!(await js(visible('.suggest-details')))) {
    // Ctrl+Space toggles the documentation pane; lib's press() has no keycode for Space, so send it directly.
    const space = { modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 };
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...space });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
  }
  await until(`${visible('.suggest-details')} && /Return a greeting/.test(document.querySelector('.suggest-details').textContent)`, 'resolved documentation in details');
  check(true, 'completion item documentation is resolved (completionItem/resolve)');
  await shot('completion.png');
  await press('Enter');
  await until(`/g\\.say_hello/.test(ide.editor.getModel().getLineContent(4))`, 'completion inserted');
  check(true, 'Enter inserts the completion');
  await type('(');
  await until(visible('.parameter-hints-widget'), 'signature help on "("');
  check(/name: str/.test(await textOf('.parameter-hints-widget')), 'signature help shows parameters after "("');
  await shot('signature.png');
  await press('Escape');
  await until(`!(${visible('.parameter-hints-widget')})`, 'signature help closed');
  await press('Ctrl+P');
  await until(visible('.parameter-hints-widget'), 'Ctrl+P parameter info');
  check(true, 'Ctrl+P shows parameter info');
  await press('Escape');

  // ---- syntax errors come from Pyright (the interim syntax-check feature is gone) ----
  await openFile(t, 'broken.py');
  await until(`ide.problems.all().some(p => p.source === 'pyright' && p.path.endsWith('broken.py') && p.severity === 'error' && p.line === 1)`, 'syntax error from pyright', 20000);
  check(true, 'syntax errors are reported by Pyright on open');
  await press('Ctrl+F4');
  await until(`!ide.findTab(ide.util.joinPath(ide.root, 'broken.py'))`, 'broken.py closed');
  await until(`!ide.problems.all().some(p => p.path.endsWith('broken.py'))`, 'problems cleared after didClose', 15000);
  check(true, 'closing a file (didClose) clears its diagnostics');

  // ---- incremental document sync: edits reach Pyright as ranges, and its text stays the editor's ----
  // Every didOpen/didChange the plugin sends is replayed on a copy here; LSP positions count UTF-16 units, as Monaco's.
  const incPath = await js(`ide.util.joinPath(ide.root, 'incremental.py')`);
  await js(`ide.api.write(${JSON.stringify(incPath)}, '# 한글 주석 😀\\r\\ngreeting = "안녕 😀"\\r\\n\\r\\n\\r\\nvalue = 1\\r\\n')`);
  await js(`(() => {
    const shadow = window.__lspShadow = {};
    window.__lspSyncs = [];
    const apply = (text, c) => {
      if (!c.range) return c.text;
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\\n') starts.push(i + 1);
      const off = (p) => starts[p.line] + p.character;
      return text.slice(0, off(c.range.start)) + c.text + text.slice(off(c.range.end));
    };
    ide.api = { ...window.api, invoke: (ch, method, params, ...rest) => {
      const uri = params?.textDocument?.uri;
      if (ch === 'lsp:notify' && method === 'textDocument/didOpen') shadow[uri] = params.textDocument.text;
      if (ch === 'lsp:notify' && method === 'textDocument/didChange') {
        __lspSyncs.push(params.contentChanges.every((c) => c.range) ? 'ranges' : 'full');
        shadow[uri] = params.contentChanges.reduce(apply, shadow[uri]);
      }
      return window.api.invoke(ch, method, params, ...rest);
    } };
    return true;
  })()`);
  await openFile(t, 'incremental.py');
  await until(`__lspShadow[ide.editor.getModel().uri.toString()] !== undefined`, 'didOpen of incremental.py');
  const inSync = async () => {
    await sleep(500); // past the plugin's 300 ms change debounce
    return js(`(() => { const m = ide.editor.getModel(); return { same: __lspShadow[m.uri.toString()] === m.getValue(), syncs: __lspSyncs.splice(0) }; })()`);
  };
  // Multi-cursor typing of Korean and emoji at three line ends, then text typed inside a string after an emoji.
  await js(`(() => { const e = ide.editor, m = e.getModel(); e.focus();
    e.setSelections([1, 2, 5].map((l) => new monaco.Selection(l, m.getLineMaxColumn(l), l, m.getLineMaxColumn(l))));
    e.trigger('kb', 'type', { text: '  # 끝😀' });
    const l2 = m.getLineContent(2); const c = l2.lastIndexOf('"') + 1;
    e.setPosition({ lineNumber: 2, column: c }); e.trigger('kb', 'type', { text: '가😀' });
    return true; })()`);
  let s = await inSync();
  check(s.same && s.syncs.length && s.syncs.every((k) => k === 'ranges'), `multi-cursor typing of Korean and emoji in a CRLF file is sent as ranges and Pyright's copy matches (${JSON.stringify(s)})`);
  // A multi-line paste (LF in a CRLF file), a delete across lines, undo twice and redo once.
  await js(`(() => { const e = ide.editor, m = e.getModel();
    e.setPosition({ lineNumber: 3, column: 1 }); e.trigger('kb', 'paste', { text: 'a = 1\\nb = "😀한"\\nc = 3\\n' });
    e.executeEdits('t', [{ range: new monaco.Range(1, 3, 2, 4), text: '' }]);
    e.trigger('kb', 'undo'); e.trigger('kb', 'undo'); e.trigger('kb', 'redo');
    return true; })()`);
  s = await inSync();
  check(s.same && s.syncs.every((k) => k === 'ranges'), `paste, delete across lines, undo and redo keep Pyright's copy identical (${JSON.stringify(s)})`);
  // A diagnostic after Korean and emoji text lands on the right UTF-16 column.
  const diagLine = await js(`(() => { const e = ide.editor, m = e.getModel(); const n = m.getLineCount();
    e.executeEdits('t', [{ range: new monaco.Range(n, 1, n, 1), text: 'print("😀한글😀", undefined_zz)\\r\\n' }]); return n; })()`);
  await until(`ide.problems.all().some(p => p.source === 'pyright' && p.path.endsWith('incremental.py') && /undefined_zz/.test(p.msg))`, 'diagnostic for undefined_zz', 30000);
  const zz = await js(`ide.problems.all().find(p => p.source === 'pyright' && /undefined_zz/.test(p.msg))`);
  const zzCol = await js(`ide.editor.getModel().getLineContent(${diagLine}).indexOf('undefined_zz') + 1`);
  check(zz.line === diagLine && zz.col === zzCol, `Pyright's diagnostic after emoji and Korean text is at ${zz.line}:${zz.col} (expected ${diagLine}:${zzCol})`);
  s = await inSync();
  check(s.same, 'Pyright\'s copy still matches after the edit');
  await js(`(ide.editor.trigger('kb', 'undo'), true)`);
  await until(`!ide.problems.all().some(p => p.source === 'pyright' && /undefined_zz/.test(p.msg))`, 'undefined_zz diagnostic gone after undo', 30000);
  check(true, 'undoing the edit clears its diagnostic');
  // More edits than one sync carries, and an end-of-line change, fall back to the whole text.
  await inSync();
  await js(`(() => { const e = ide.editor, m = e.getModel(); const n = m.getLineCount();
    e.executeEdits('t', [{ range: new monaco.Range(n, 1, n, 1), text: 'w = "' + 'a'.repeat(1200) + '"' }]);
    for (let i = 0; i < 1100; i++) e.executeEdits('t', [{ range: new monaco.Range(n, 6 + i, n, 7 + i), text: 'b' }]);
    return true; })()`);
  s = await inSync();
  check(s.same && s.syncs.length === 1 && s.syncs[0] === 'full', `1,100 edits between two syncs are sent as the whole text (${JSON.stringify(s)})`);
  await js(`(ide.editor.getModel().pushEOL(monaco.editor.EndOfLineSequence.LF), true)`);
  s = await inSync();
  check(s.same && s.syncs.at(-1) === 'full' && !(await js(`ide.editor.getModel().getValue().includes('\\r')`)), `an end-of-line change is sent as the whole text (${JSON.stringify(s)})`);
  await js(`(ide.api = window.api, ide.closeTab(ide.activeTab().path, true), true)`);

  // ---- API for other features ----
  const syms =await js(`ide.lsp.documentSymbols(ide.util.joinPath(ide.root, 'models.py'))`);
  const greeter = syms.find((s) => s.name === 'Greeter');
  check(greeter?.kindName === 'Class' && greeter.line === 4 && greeter.children.some((c) => c.name === '__init__'), 'ide.lsp.documentSymbols returns the outline');
  check(await js(`ide.lsp.ready()`) === true, 'ide.lsp.ready() resolves true');
  const hov = await js(`ide.lsp.request('textDocument/hover', { textDocument: { uri: monaco.Uri.file(ide.util.joinPath(ide.root, 'models.py')).toString() }, position: { line: 14, character: 6 } })`);
  check(/make_greeter/.test(hov?.contents?.value), 'ide.lsp.request forwards raw LSP requests');

  // ---- restart from the status bar, and on an interpreter change ----
  const watchStates = () => js(`(window.__lspStates = [], new MutationObserver(() => __lspStates.push(document.querySelector('#lspStatus').textContent)).observe(document.querySelector('#lspStatus'), { childList: true, characterData: true, subtree: true }), true)`);
  await watchStates();
  await t.click('#lspStatus');
  await until(`document.querySelector('#lspStatus').textContent === 'Pyright: ready'`, 'ready after restart', 30000);
  check(await js(`__lspStates.includes('Pyright: starting')`), 'clicking the status item restarts Pyright (starting -> ready)');
  await until(`ide.problems.all().some(p => p.source === 'pyright' && /undefined_name/.test(p.msg))`, 'diagnostics after restart', 30000);
  check(true, 'restart re-opens documents and republishes diagnostics');

  await watchStates();
  await js(`ide.emit('interpreterChanged', ide.currentInterp())`);
  await sleep(300);
  check(!(await js(`__lspStates.includes('Pyright: starting')`)), 'an unchanged interpreter keeps the running server');
  // Stand in for a second interpreter: same python, different spelling, so the server must restart with it.
  await js(`(() => { const real = ide.currentInterp; window.__realInterp = real; ide.currentInterp = () => ({ ...real(), executable: real().executable.toUpperCase() }); ide.emit('interpreterChanged', ide.currentInterp()); return true; })()`);
  await until(`__lspStates.includes('Pyright: starting') && document.querySelector('#lspStatus').textContent === 'Pyright: ready'`, 'restart on interpreter change', 30000);
  const upper = await js(`ide.currentInterp().executable`);
  await until(`ide.api.invoke('lsp:log').then(l => l.toUpperCase().includes(${JSON.stringify(upper)}))`, 'pythonPath reaches pyright', 20000);
  check(true, 'interpreter change restarts Pyright with the new python.pythonPath');
  await js(`(ide.currentInterp = window.__realInterp, ide.emit('interpreterChanged', ide.currentInterp()), true)`);
  await until(`document.querySelector('#lspStatus').textContent === 'Pyright: ready'`, 'ready again', 30000);

  // A second restart while the first is still starting supersedes it; the first is not reported as an error.
  await watchStates();
  await js(`(ide.lsp.restart(), setTimeout(() => ide.lsp.restart(), 50), true)`);
  await until(`__lspStates.includes('Pyright: starting') && document.querySelector('#lspStatus').textContent === 'Pyright: ready'`, 'ready after two restarts', 30000);
  check(!(await js(`__lspStates.includes('Pyright: error')`)), `restarting twice in a row never shows an error (${await js('JSON.stringify(__lspStates)')})`);

  // Close Project stops Pyright; opening the project again starts it.
  const root = await js(`ide.root`);
  await js(`ide.closeProject()`);
  await until(`document.querySelector('#lspStatus').textContent === 'Pyright: off'`, 'Pyright off after Close Project', 15000);
  check(await js(`ide.api.invoke('lsp:log').then((l) => l === '')`), 'Close Project stops the Pyright server');
  await js(`ide.openProject(${JSON.stringify(root)})`);
  await until(`document.querySelector('#lspStatus').textContent === 'Pyright: ready'`, 'ready after reopening', 30000);
  check(true, 'reopening the project starts Pyright again');
  await shot('final.png');
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
