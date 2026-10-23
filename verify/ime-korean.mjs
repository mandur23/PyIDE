// Korean IME composition in Monaco and the other text inputs. Compositions are driven like a Windows IME through CDP
// (Input.imeSetComposition for each jamo step, Input.insertText to commit). While a syllable is being composed in the
// middle of a coloured Python line, the line keeps its syntax colours: no input overlay drawn in the plain foreground
// colour covers the tokens (Monaco's EditContext input renders the composition in the view itself). Also: several
// syllables, Backspace inside a composition, a cancelled composition, and IME text in a notebook cell, the find
// widget and the Python Console input. Port 9170.
import { launch, openFile } from './lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'ime-korean', port: 9170 });
const { js, until, press, check, cdp, sleep, shot } = t;

// One IME step: the composition string becomes `text` (caret at its end). An empty string cancels the composition.
const compose = async (text) => { await cdp('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); await sleep(40); };
const commit = async (text) => { await cdp('Input.insertText', { text }); await sleep(40); };
// Backspace while composing: a Windows IME eats the key (keyCode 229, "Process") and shortens the composition itself.
const imeBackspace = async (rest) => {
  const ev = { key: 'Process', code: 'Backspace', windowsVirtualKeyCode: 229 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
  await compose(rest);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
};
// Types Korean the way the 2-set keyboard composes it: each array is the composition steps of one syllable.
async function typeSyllables(syllables) {
  for (const steps of syllables) {
    for (const s of steps) await compose(s);
    await commit(steps.at(-1));
  }
}

const LINE = 6;
const CARET = 20; // after `compute(`
const ORIGINAL = '    return compute("hello", 42) or None  # note';
const lineText = () => js(`ide.editor.getModel().getLineContent(${LINE})`);
const caret = () => js(`(() => { const p = ide.editor.getPosition(); return [p.lineNumber, p.column]; })()`);
const resetLine = () => js(`(() => { const e = ide.editor, m = e.getModel();
  m.pushEditOperations([], [{ range: new ide.monaco.Range(${LINE}, 1, ${LINE}, m.getLineMaxColumn(${LINE})), text: ${J(ORIGINAL)} }], () => null);
  e.setPosition({ lineNumber: ${LINE}, column: ${CARET} }); e.focus(); return e.hasTextFocus(); })()`);

// The coloured tokens of the line as drawn: for each token, its colour and what is topmost at its centre (an input
// overlay over the line would be hit instead of the token).
const TOKENS = ['return', '"hello"', '42', 'None', '# note'];
const drawn = () => js(`(() => {
  const e = ide.editor, dom = e.getDomNode();
  const top = e.getTopForLineNumber(${LINE}) - e.getScrollTop() + dom.getBoundingClientRect().top;
  const line = [...dom.querySelectorAll('.view-lines .view-line')].find((n) => Math.abs(n.getBoundingClientRect().top - top) < 2);
  if (!line) return null;
  const out = { text: line.textContent.replace(/\\u00a0/g, ' '), tokens: {} };
  for (const span of line.querySelectorAll('span > span')) {
    const text = span.textContent.replace(/\\u00a0/g, ' ').trim();
    if (!${J(TOKENS)}.includes(text)) continue;
    const r = span.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.tokens[text] = { color: getComputedStyle(span).color, covered: !span.contains(hit) && hit !== span,
      hit: hit && (hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.')) };
  }
  // Any visible input element of the editor that overlaps the line (Monaco 0.52 showed its textarea there, .ime-input).
  const lr = line.getBoundingClientRect();
  out.overlays = [...dom.querySelectorAll('textarea, .native-edit-context, .ime-input')].filter((n) => {
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    return r.width > 2 && r.height > 2 && r.bottom > lr.top + 2 && r.top < lr.bottom - 2 && s.visibility !== 'hidden' && s.opacity !== '0'
      && s.color !== 'rgba(0, 0, 0, 0)' && s.display !== 'none';
  }).map((n) => n.tagName.toLowerCase() + '.' + [...n.classList].join('.'));
  out.rect = { x: Math.round(lr.x), y: Math.round(lr.y), width: Math.round(Math.min(lr.width, 640)), height: Math.round(lr.height) };
  return out;
})()`);
const clipShot = async (file, rect) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, rect.x - 60), y: rect.y - 6, width: rect.width + 60, height: rect.height + 12, scale: 1 } });
  const { writeFileSync } = await import('fs');
  const p = (await import('path')).join(t.outDir, file);
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
};

try {
  await openFile(t, 'main.py');
  await until(`ide.editor.getModel()?.getLanguageId() === 'python'`, 'main.py in the editor');
  check(await js(`ide.editor.getOption(ide.monaco.editor.EditorOption.editContext) === true`), 'the editor takes keyboard and IME input through EditContext');
  await js(`(ide.editor.revealLineInCenter(${LINE}), true)`);
  check(await resetLine(), 'the editor has the caret mid-line');
  await until(`(() => { const d = document.querySelectorAll('.view-lines .view-line'); return d.length > 5; })()`, 'lines drawn');
  await sleep(300);
  const before = await drawn();
  check(before && TOKENS.every((k) => before.tokens[k]) && new Set(Object.values(before.tokens).map((x) => x.color)).size >= 3,
    `the line is drawn with its token colours (${J(before?.tokens && Object.fromEntries(Object.entries(before.tokens).map(([k, v]) => [k, v.color])))})`);
  await clipShot('before.png', before.rect);

  // ---- one syllable: colours stay while composing ----
  await compose('ㅎ');
  await compose('하');
  await compose('한');
  await sleep(150);
  const during = await drawn();
  await clipShot('composing.png', during.rect);
  const changed = TOKENS.filter((k) => !during.tokens[k] || during.tokens[k].color !== before.tokens[k].color);
  const covered = TOKENS.filter((k) => during.tokens[k]?.covered);
  check(!changed.length, `every token keeps its colour while composing${changed.length ? ` (changed: ${J(changed.map((k) => [k, during.tokens[k]?.color]))})` : ''}`);
  check(!covered.length && !during.overlays.length, `nothing covers the line while composing${covered.length || during.overlays.length ? ` (${J({ covered: covered.map((k) => during.tokens[k].hit), overlays: during.overlays })})` : ''}`);
  check(during.text.includes('compute(한"hello"'), `the syllable being composed is drawn in the line (${J(during.text)})`);
  await commit('한');
  check(await lineText() === ORIGINAL.replace('compute(', 'compute(한'), `committing inserts the syllable (${J(await lineText())})`);
  check(J(await caret()) === J([LINE, CARET + 1]), `the caret follows the committed syllable (${J(await caret())})`);
  const afterCommit = await drawn();
  check(TOKENS.every((k) => afterCommit.tokens[k]?.color === before.tokens[k].color), 'the line keeps its colours after the commit');

  // ---- several syllables, Backspace inside a composition, a cancelled composition ----
  await resetLine();
  await typeSyllables([['ㅎ', '하', '한'], ['ㄱ', '그', '글']]);
  check(await lineText() === ORIGINAL.replace('compute(', 'compute(한글'), `two syllables in a row (${J(await lineText())})`);
  await compose('ㅁ');
  await compose('마');
  await compose('말');
  await imeBackspace('마');
  const mid = await lineText();
  check(mid === ORIGINAL.replace('compute(', 'compute(한글마'), `Backspace while composing removes the last jamo only (${J(mid)})`);
  await commit('마');
  await compose('ㅇ');
  await imeBackspace('');
  await sleep(100);
  check(await lineText() === ORIGINAL.replace('compute(', 'compute(한글마'), `Backspace on a lone jamo cancels the composition and keeps the text (${J(await lineText())})`);
  check(J(await caret()) === J([LINE, CARET + 3]), `the caret is after the typed text (${J(await caret())})`);
  await press('Backspace');
  check(await lineText() === ORIGINAL.replace('compute(', 'compute(한글'), `a plain Backspace after the composition deletes one syllable (${J(await lineText())})`);
  await press('Ctrl+z');
  await sleep(100);
  check(await lineText() === ORIGINAL.replace('compute(', 'compute(한글마'), `undo brings the deleted syllable back (${J(await lineText())})`);
  // A composition over a selection replaces it.
  await resetLine();
  await js(`(ide.editor.setSelection(new ide.monaco.Range(${LINE}, ${CARET}, ${LINE}, ${CARET + 7})), ide.editor.focus(), true)`);
  await compose('ㄴ');
  await compose('나');
  await commit('나');
  check(await lineText() === ORIGINAL.replace('"hello"', '나'), `a composition replaces the selection (${J(await lineText())})`);
  await resetLine();

  // ---- the find widget ----
  await js(`(ide.editor.getModel().pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: '# 한글 메모\\n' }], () => null), true)`);
  await js(`(ide.editor.focus(), true)`);
  await press('Ctrl+f');
  await until(`document.activeElement?.closest('.find-widget') && document.activeElement.matches('textarea, input')`, 'find input focused');
  await js(`(() => { const a = document.activeElement; a.select(); return true; })()`);
  await press('Delete');
  await typeSyllables([['ㅎ', '하', '한'], ['ㄱ', '그', '글']]);
  const findValue = await js(`document.activeElement.value`);
  check(findValue === '한글', `the find input takes Korean through the IME (${J(findValue)})`);
  await until(`/1 of 1/.test(document.querySelector('.find-widget .matchesCount')?.textContent || '')`, 'one match', 5000)
    .then(() => check(true, 'the find widget finds the composed word'), () => check(false, 'the find widget finds the composed word'));
  await press('Escape');

  // ---- a notebook cell ----
  await openFile(t, 'cells.ipynb');
  await until(`ide.activeTab().notebook?.cells().length === 1`, 'notebook shown');
  // The notebook view may still be replaced right after it shows (the document loads), so edit mode is asked again.
  await until(`(ide.activeTab().notebook.edit(0), !!ide.activeTab().notebook.cells()[0].editor)`, 'notebook cell editor');
  await js(`(() => { const ed = ide.activeTab().notebook.cells()[0].editor; ed.setPosition({ lineNumber: 1, column: 12 }); ed.focus(); return true; })()`);
  await until(`ide.activeTab().notebook.cells()[0].editor.hasTextFocus()`, 'cell editor focused');
  await compose('ㅇ');
  await compose('아');
  await compose('안');
  const cellDuring = await js(`(() => { const ed = ide.activeTab().notebook.cells()[0].editor; const n = ed.getDomNode().querySelector('.view-line');
    const s = [...n.querySelectorAll('span > span')].find((x) => x.textContent.includes('hello')); const r = s.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { covered: !s.contains(hit), text: n.textContent }; })()`);
  check(!cellDuring.covered && cellDuring.text.includes('안'), `a notebook cell draws the composition in its line (${J(cellDuring)})`);
  await commit('안');
  await typeSyllables([['ㄴ', '녀', '녕']]);
  const cell = await js(`ide.activeTab().notebook.cells()[0].model.getValue()`);
  check(cell === 'greeting = 안녕"hello"  # note', `Korean typed into a notebook cell (${J(cell)})`);

  // ---- the Python Console input (a textarea) ----
  await press('Alt+8');
  await until(`ide.pyconsole?.isRunning() && document.activeElement?.id === 'pyconsoleIn'`, 'console input focused', 60000)
    .then(async () => {
      await typeSyllables([['ㅎ', '하', '한'], ['ㄱ', '그', '글']]);
      await compose('ㅇ');
      await imeBackspace('');
      const v = await js(`document.querySelector('#pyconsoleIn').value`);
      check(v === '한글', `the Python Console input takes Korean through the IME (${J(v)})`);
    }, (err) => check(false, `the Python Console input takes Korean through the IME (${err.message})`));
  await shot('ime-korean.png');
} catch (err) {
  check(false, err.stack || String(err));
}
t.finish();
