// Check RegExp end to end (ports 9397-9398): Alt+Enter on a re.compile pattern offers Check RegExp in the context
// actions; the popup highlights matches in the sample as you type (debounced), lists numbered and named groups of each
// match, takes the call's flags (positional re.I, flags=re.IGNORECASE | re.M, re.X) and lets them be toggled, reports a
// syntax error with its position (raw and non-raw literals, marked in the editor too), decodes non-raw escapes, works
// with Korean and astral characters, uses Python's own re (possessive quantifiers, which JavaScript lacks), survives a
// catastrophically backtracking pattern (timeout, then a fresh helper), prefills the sample from the call's subject
// string, offers nothing on a string that is not a pattern, colors regex syntax in pattern literals, and has a Korean UI
// without English or missing translations. Patterns run in the default local interpreter.
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const q = JSON.stringify;
const results = [];
const env = { PYIDE_REGEX_TIMEOUT_MS: '1500' };
let a;
let b;

// Puts the caret inside the pattern literal of the line that starts with `name =`, `into` characters after its quote.
async function caretOn(t, name, into = 2) {
  return t.js(`(() => {
    const ed = ide.editor; const m = ed.getModel();
    const line = m.getLinesContent().findIndex((l) => l.startsWith(${q(`${name} =`)})) + 1;
    const text = m.getLineContent(line);
    const col = text.indexOf('(', text.indexOf('re.')) + 1;
    const quote = text.slice(col).search(/["']/) + col;
    ed.focus(); ed.setPosition({ lineNumber: line, column: quote + 1 + ${into} });
    return line;
  })()`);
}
// Alt+Enter, then Down to the Check RegExp entry of the context actions and Enter, as a user would.
async function altEnterCheck(t) {
  // Monaco drops a context action request when Pyright publishes new markers meanwhile (see lsp's diagnosticsSettled):
  // the user presses Alt+Enter again, and so does the test.
  const listed = `[...document.querySelectorAll('.action-widget [role="option"]')].some((n) => n.textContent.includes(${q(t.label)}))`;
  for (let attempt = 1; ; attempt++) {
    await t.press('Alt+Enter');
    try { await t.until(listed, 'Check RegExp listed', 8000); break; } catch (err) {
      if (attempt === 3) throw err;
      console.log(`note: Alt+Enter attempt ${attempt} listed no Check RegExp; pressing it again`);
      await t.press('Escape');
      await t.js(`(ide.editor.focus(), true)`);
    }
  }
  for (let i = 0; i < 12 && !(await t.js(`!!document.querySelector('.action-widget [role="option"].focused')?.textContent.includes(${q(t.label)})`)); i++) await t.press('ArrowDown');
  await t.press('Enter');
  await t.until(`!!document.querySelector('#rxPopup') && ide.regexCheck.state()?.result`, 'popup evaluated', 20000);
}
const state = (t) => t.js(`ide.regexCheck.state()`);
const statusText = (t) => t.js(`document.querySelector('#rxPopup .rx-status').textContent`);
const marks = (t) => t.js(`[...document.querySelectorAll('#rxPopup .rx-backdrop mark')].map(m => m.textContent)`);
const groupRows = (t) => t.js(`[...document.querySelectorAll('#rxPopup .rx-group-table tr')].map(r => [...r.children].map(td => td.textContent).join('|'))`);
// Sets the sample like typing would (an input event) and waits for the answer to it.
async function setSample(t, text) {
  const before = await t.js(`Number(document.querySelector('#rxPopup').dataset.evaluated || 0)`);
  await t.js(`(() => { const s = document.querySelector('#rxPopup .rx-sample'); s.value = ${q(text)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await t.until(`Number(document.querySelector('#rxPopup').dataset.evaluated || 0) > ${before} && !document.querySelector('#rxPopup').dataset.busy`, `answer for ${q(text)}`, 20000);
}

try {
  a = await launch({ fixture: 'regex-check', port: 9397, name: 'regex-check', env });
  a.label = 'Check RegExp';
  const { js, until, check } = a;
  await openFile(a, 'patterns.py');
  await until(`ide.interps.length > 0`, 'interpreters', 30000);

  // ---------- regex syntax colors ----------
  await until(`ide.activeTab().model.getAllDecorations().some(d => d.options.inlineClassName === 'rx-group')`, 'regex decorations');
  const decoOn = (line) => js(`ide.activeTab().model.getLineDecorations(${line}).map(d => d.options.inlineClassName).filter(c => /^rx-/.test(c || '')).sort().join(',')`);
  const dateLine = 3;
  const decos = await decoOn(dateLine);
  check(['rx-group', 'rx-escape', 'rx-quant'].every((c) => decos.includes(c)), `the DATE pattern's groups, escapes and quantifiers are colored (${decos})`);
  const groupText = await js(`(() => { const m = ide.activeTab().model; const d = m.getLineDecorations(${dateLine}).filter(d => d.options.inlineClassName === 'rx-group').sort((x, y) => x.range.startColumn - y.range.startColumn)[0]; return m.getValueInRange(d.range); })()`);
  check(groupText === '(?P<year>', `a named group's opening is one token (${q(groupText)})`);
  const notRegexLine = await js(`ide.activeTab().model.getLinesContent().findIndex(l => l.startsWith('NOT_REGEX')) + 1`);
  check(await decoOn(notRegexLine) === '', 'a string that is not a re pattern is not colored');
  const escLine = await js(`ide.activeTab().model.getLinesContent().findIndex(l => l.startsWith('ESCAPED')) + 1`);
  const escTokens = await js(`(() => { const m = ide.activeTab().model; return m.getLineDecorations(${escLine}).filter(d => d.options.inlineClassName === 'rx-escape').sort((x, y) => x.range.startColumn - y.range.startColumn).map(d => m.getValueInRange(d.range)); })()`);
  check(q(escTokens) === q(['\\\\d', '\\\\s', '\\\\w']), `in a non-raw literal "\\\\d" is colored as the regex escape \\d (${q(escTokens)})`);

  // ---------- Alt+Enter → Check RegExp ----------
  await caretOn(a, 'DATE', 5);
  await altEnterCheck(a);
  check(await js(`document.activeElement === document.querySelector('#rxPopup .rx-sample')`), 'the popup opens with the sample text box focused');
  check(await js(`document.querySelector('#rxPopup .rx-pattern').textContent`) === '(?P<year>\\d{4})-(?P<month>\\d\\d)-(\\d\\d)' && await js(`document.querySelector('#rxPopup .rx-fn').textContent`) === 're.compile',
    'it shows the pattern and the function');
  check(/No match/.test(await statusText(a)), `an empty sample: No match (${await statusText(a)})`);
  // Typing, keystroke by keystroke: highlights follow, evaluations are debounced.
  const evalBefore = await js(`Number(document.querySelector('#rxPopup').dataset.evaluated)`);
  for (const chunk of ['Dates: 2024', '-05-06', ' and 1999', '-12-31.']) await a.type(chunk);
  await until(`ide.regexCheck.state().result?.matches?.length === 2 && !document.querySelector('#rxPopup').dataset.busy`, 'two matches', 20000);
  const evals = (await js(`Number(document.querySelector('#rxPopup').dataset.evaluated)`)) - evalBefore;
  check(evals >= 1 && evals <= 2, `typing four pieces quickly is evaluated ${evals} time(s) (debounced)`);
  check(q(await marks(a)) === q(['2024-05-06', '1999-12-31']), `both matches are highlighted in the sample (${q(await marks(a))})`);
  check(/Matches: 2 matches/.test(await statusText(a)), `status: Matches: 2 matches (${await statusText(a)})`);
  let rows = await groupRows(a);
  check(q(rows) === q(['Match|2024-05-06|7–17', '1 ‹year›|2024|7–11', '2 ‹month›|05|12–14', '3|06|15–17']), `numbered and named groups of the first match with spans (${q(rows)})`);
  await a.click('#rxPopup .rx-next');
  rows = await groupRows(a);
  check(rows[1] === '1 ‹year›|1999|22–26' && await js(`document.querySelector('#rxPopup .rx-nav-label').textContent`) === 'Match 2 of 2'
    && await js(`document.querySelector('#rxPopup mark.rx-m-current').textContent`) === '1999-12-31', `› shows the second match and marks it current (${q(rows)})`);
  await a.shot('regex-popup.png');
  await a.press('Escape');
  await until(`!document.querySelector('#rxPopup')`, 'popup closed');
  check(await js(`ide.editor.hasTextFocus()`), 'Esc closes the popup and gives the keyboard back to the editor');
  // The sample is kept for the pattern while the IDE runs.
  await caretOn(a, 'DATE', 1);
  await altEnterCheck(a);
  check(await js(`document.querySelector('#rxPopup .rx-sample').value`) === 'Dates: 2024-05-06 and 1999-12-31.' && (await state(a)).result.matches.length === 2, 'reopening keeps the sample typed for that pattern');
  await a.press('Escape');

  // ---------- flags ----------
  await caretOn(a, 'WORDS');
  await altEnterCheck(a);
  let s = await state(a);
  check(q(s.flags) === q(['I']) && await js(`document.querySelector('#rxPopup .rx-flag[data-flag="I"]').getAttribute('aria-pressed')`) === 'true', `positional re.I is taken from the call (${q(s.flags)})`);
  check(await js(`document.querySelector('#rxPopup .rx-sample').value`) === 'alpha beta' && q(await marks(a)) === q(['alpha', 'beta']), 'the sample starts as the call\'s subject string, and \\b\\w+\\b finds both words');
  await a.press('Escape');

  await caretOn(a, 'CASE');
  await altEnterCheck(a);
  s = await state(a);
  check(q([...s.flags].sort()) === q(['I', 'M']) && s.mode === 'search' && q(await marks(a)) === q(['HELLO']), `flags=re.IGNORECASE | re.M gives I and M; "hello" matches HELLO (${q(s.flags)})`);
  const before = await js(`Number(document.querySelector('#rxPopup').dataset.evaluated)`);
  await a.click('#rxPopup .rx-flag[data-flag="I"]');
  await until(`Number(document.querySelector('#rxPopup').dataset.evaluated) > ${before} && !document.querySelector('#rxPopup').dataset.busy`, 're-evaluated');
  check(/No match/.test(await statusText(a)) && !(await marks(a)).length && await js(`document.querySelector('#rxPopup .rx-flag[data-flag="I"]').getAttribute('aria-pressed')`) === 'false', 'turning I off gives No match');
  check(await js(`ide.activeTab().model.getLineContent(5)`) === 'CASE = re.search("hello", "HELLO world", flags=re.IGNORECASE | re.M)', 'toggling a flag does not change the code');
  await a.press('Escape');

  // ---------- syntax errors ----------
  await caretOn(a, 'BROKEN');
  await altEnterCheck(a);
  s = await state(a);
  check(!s.result.ok && s.result.error.pos === 4 && /Syntax error at position 4: unterminated character set/.test(await statusText(a)), `"(abc[": syntax error at position 4 (${await statusText(a)})`);
  check(await js(`document.querySelector('#rxPopup .rx-error-at').textContent`) === '[', 'the pattern line marks the character at fault');
  const brokenLine = await js(`ide.activeTab().model.getLinesContent().findIndex(l => l.startsWith('BROKEN')) + 1`);
  const marked = await js(`(() => { const m = ide.activeTab().model; const d = m.getLineDecorations(${brokenLine}).find(d => d.options.inlineClassName === 'rx-error-char'); return d && m.getValueInRange(d.range); })()`);
  check(marked === '[', `the editor marks it too (${q(marked)})`);
  await a.press('Escape');
  check(await js(`!ide.activeTab().model.getAllDecorations().some(d => d.options.inlineClassName === 'rx-error-char')`), 'closing the popup removes the mark');

  await caretOn(a, 'BAD_ESCAPED');
  await altEnterCheck(a);
  s = await state(a);
  const badLine = await js(`ide.activeTab().model.getLinesContent().findIndex(l => l.startsWith('BAD_ESCAPED')) + 1`);
  const badMarked = await js(`(() => { const m = ide.activeTab().model; const d = m.getLineDecorations(${badLine}).find(d => d.options.inlineClassName === 'rx-error-char'); return d ? [m.getValueInRange(d.range), d.range.startColumn] : null; })()`);
  check(!s.result.ok && s.result.error.pos === 3 && s.result.pattern === 'a\\d(' && badMarked?.[0] === '(' && badMarked[1] === 'BAD_ESCAPED = re.compile("a\\\\d('.length,
    `"a\\\\d(" (non-raw) decodes to a\\d(; the error at position 3 maps back to the ( in the source (${q(badMarked)})`);
  await a.press('Escape');

  // ---------- escapes, match mode ----------
  await caretOn(a, 'ESCAPED');
  await altEnterCheck(a);
  s = await state(a);
  rows = await groupRows(a);
  check(s.mode === 'match' && s.result.pattern === '\\d+\\s(\\w+)' && /^Matches$/.test((await statusText(a)).replace(/^\W+/, '')) && rows[1] === '1|apples|3–9', `re.match with "\\\\d+\\\\s(\\\\w+)" on "12 apples": Matches, group 1 = apples (${await statusText(a)} ${q(rows)})`);
  await setSample(a, 'x 12 apples');
  check(/No match/.test(await statusText(a)), 're.match anchors at the start: "x 12 apples" does not match');
  await a.press('Escape');

  // ---------- Korean and astral characters ----------
  await caretOn(a, 'KOREAN');
  await altEnterCheck(a);
  check(q(await marks(a)) === q(['안녕', '세계']), `[가-힣]+ finds the Korean words (${q(await marks(a))})`);
  await setSample(a, '😀안녕 🎉세계!');
  s = await state(a);
  check(q(s.result.matches.map((m) => m.span)) === q([[2, 4], [7, 9]]) && q(await marks(a)) === q(['안녕', '세계']), `spans count UTF-16 units past emoji (${q(s.result.matches.map((m) => m.span))})`);
  await a.press('Escape');

  // ---------- Python-only syntax ----------
  await caretOn(a, 'POSSESSIVE');
  await altEnterCheck(a);
  s = await state(a);
  check(s.mode === 'fullmatch' && s.result.ok && s.result.matches.length === 1 && /Matches/.test(await statusText(a)), 'a++b (a possessive quantifier, not valid in JavaScript) fullmatches "aaab" with Python\'s re');
  await setSample(a, 'aaa');
  check(/No match/.test(await statusText(a)), 'and "aaa" does not match');
  await a.press('Escape');

  await caretOn(a, 'VERBOSE', 0);
  await a.js(`(() => { const ed = ide.editor; const p = ed.getPosition(); ed.setPosition({ lineNumber: p.lineNumber + 1, column: 6 }); return true; })()`);
  await altEnterCheck(a);
  await setSample(a, 'weights: 10 kg, 250g');
  rows = await groupRows(a);
  s = await state(a);
  check(q(s.flags) === q(['X']) && s.result.matches.length === 2 && q(rows) === q(['Match|10 kg|9–14', '1|10|9–11', '2|kg|12–14']), `a triple-quoted re.X pattern with comments works from inside its body (${q(rows)})`);
  await a.press('Escape');

  // ---------- catastrophic backtracking ----------
  await caretOn(a, 'SLOW');
  await altEnterCheck(a);
  s = await state(a);
  check(!s.result.ok && s.result.error.kind === 'timeout' && /took longer than/.test(await statusText(a)), `(a+)+$ on a long "aaa…b" times out instead of hanging (${await statusText(a)})`);
  await setSample(a, 'aaaa');
  s = await state(a);
  check(s.result.ok && s.result.matches.length === 1, 'the next check runs in a fresh helper');
  await a.press('Escape');

  // ---------- not a pattern ----------
  await a.js(`(() => { const ed = ide.editor; const line = ed.getModel().getLinesContent().findIndex(l => l.startsWith('NOT_REGEX')) + 1; ed.focus(); ed.setPosition({ lineNumber: line, column: 20 }); return true; })()`);
  check(!(await js(`!!ide.regexCheck.regexAt(ide.activeTab().model, ide.activeTab().model.getOffsetAt(ide.editor.getPosition()))`)), 'a string passed to print is not a pattern');
  await js(`ide.runAction('RegExp.Check')`);
  await a.sleep(300);
  check(await js(`!document.querySelector('#rxPopup')`), 'Check RegExp there opens nothing');

  const errs = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!errs.length && !a.consoleErrors.length, `no internal errors or renderer exceptions (${q(errs.slice(0, 2))} ${q(a.consoleErrors.slice(0, 2))})`);

  // ---------- the helper stops with the project (a venv's python.exe would stay locked) ----------
  const pid = await js(`ide.api.invoke('regex-check:helperPid')`);
  check(pid > 0, `after a check the helper is running (pid ${pid})`);
  await js(`(ide.setInterpreter(ide.currentInterp().executable), true)`);
  await a.sleep(300);
  check((await js(`ide.api.invoke('regex-check:helperPid')`)) === pid, 'selecting the same interpreter again leaves the helper running');
  await js(`ide.closeProject().then(() => true)`);
  await until(`ide.api.invoke('regex-check:helperPid').then((p) => p === null)`, 'helper stopped', 10000);
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) { try { process.kill(pid, 0); await a.sleep(100); } catch { gone = true; } }
  check(gone, 'closing the project stops the helper python process');
  results.push(...a.results);
  a.close();
  a = null;

  // ---------- Korean UI ----------
  b = await launch({ fixture: 'regex-check', port: 9398, name: 'regex-check-ko', lang: 'ko-KR', env });
  b.label = 'RegExp 확인';
  await openFile(b, 'patterns.py');
  await b.until(`ide.interps.length > 0`, 'interpreters', 30000);
  await caretOn(b, 'DATE');
  await altEnterCheck(b);
  await setSample(b, '2024-05-06');
  const leaks = await englishLeaks(b, '#rxPopup');
  b.check(!leaks.length, `the Korean popup has no English UI text (${q(leaks)})`);
  b.check(/일치함/.test(await statusText(b)) && await b.js(`document.querySelector('#rxPopup .rx-title').textContent`) === 'RegExp 확인', `Korean title and status (${await statusText(b)})`);
  await setSample(b, 'none');
  b.check(/일치 없음/.test(await statusText(b)), 'Korean: No match');
  await b.press('Escape');
  await caretOn(b, 'BROKEN');
  await altEnterCheck(b);
  b.check(/위치 4에서 구문 오류/.test(await statusText(b)), `Korean syntax error text (${await statusText(b)})`);
  const missing = await missingTranslations(b);
  b.check(!missing.length, `no missing translations (${q(missing)})`);
  b.check(!b.consoleErrors.length, `no renderer exceptions (${q(b.consoleErrors)})`);
  results.push(...b.results);
  b.close();
  b = null;
} catch (err) {
  console.log(`FAIL ${err.stack || err.message}`);
  results.push({ ok: false });
} finally {
  a?.close();
  b?.close();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
