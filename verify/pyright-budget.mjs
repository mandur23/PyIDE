// What keeps Pyright and the semantic highlighter from working for nothing (ports 9373-9374). A temp project whose
// `area` appears in 321 files:
// - code vision counts a name found in more than 300 files only on click (main/features/code-vision.js counts the
//   files), shows the count after the click, and goes back to the uncounted lens after an edit; a count that takes
//   longer than 2 s shows the uncounted lens, then the count when it comes, and is not asked again automatically
//   for a name in 41 files (`describe`), while a name in one file (`Shape`) is; files written on disk move a name
//   over the limit;
// - semantic highlighting sends no request while the user types and colors the new text after the pause; main
//   answers a request that a newer one for the same file replaced with `superseded`;
// - the decorated document symbols are shared between callers.
// Instance B: the uncounted lens, its tooltip and the Code Vision settings page in Korean.
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const SHAPES = [
  'class Shape:',
  '    def area(self):',
  '        return 0',
  '',
  '    def describe(self):',
  '        return "shape"',
  '',
  '',
  'def rare_helper():',
  '    return Shape().area() + len(Shape().describe())',
  '',
].join('\n');

function makeProject(prefix) {
  const project = path.join(tempDir(prefix), 'proj');
  mkdirSync(path.join(project, 'pkg'), { recursive: true });
  writeFileSync(path.join(project, 'shapes.py'), SHAPES);
  writeFileSync(path.join(project, 'pkg', '__init__.py'), '');
  for (let i = 0; i < 320; i++) writeFileSync(path.join(project, 'pkg', `m${i}.py`), `# the area of field ${i}${i < 40 ? ', describe it' : ''}\nFIELD_${i} = ${i}\n`);
  return project;
}

// __cv(qual): the usages lens title of a declaration in shapes.py ('pending' for a placeholder, null for none);
// __cvTip(text): the tooltip of the drawn lens with that text; __refAt: references requests by line (0-based);
// __delay: line -> ms to hold references requests asked at that line.
const HELPERS = `(() => {
  window.__model = () => ide.getDocument(ide.util.joinPath(ide.root, 'shapes.py'))?.model;
  window.__sym = (qual) => ide.codeVision.symbols(__model()).find((x) => x.qual === qual);
  window.__cv = (qual) => {
    const s = __sym(qual);
    const ls = ide.codeVision.lenses(__model()).filter((l) => l.line === s.line);
    const hit = ls.find((l) => l.kind === 'usages');
    return hit ? hit.title : ls.some((l) => l.kind === 'pending') ? 'pending' : null;
  };
  window.__cvTip = (text) => [...document.querySelectorAll('.codelens-decoration > a')].find((a) => a.textContent === text)?.title ?? null;
  window.__refAt = {};
  window.__delay = {};
  const req = ide.lsp.request;
  ide.lsp.request = function (method, params, ...rest) {
    if (method !== 'textDocument/references') return req.call(this, method, params, ...rest);
    const line = params.position.line;
    __refAt[line] = (__refAt[line] || 0) + 1;
    const ms = __delay[line];
    return ms ? new Promise((r) => setTimeout(r, ms)).then(() => req.call(this, method, params, ...rest)) : req.call(this, method, params, ...rest);
  };
  return true;
})()`;
const addLine = (t, text) => t.js(`(() => { const m = __model(); const n = m.getLineCount(); m.pushEditOperations([], [{ range: new ide.monaco.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n)), text: ${S(`\n${text}`)} }], () => null); return true; })()`);
const settled = `!ide.codeVision.stats().running && !ide.codeVision.stats().scheduled`;

let failed = false;
const tally = { ok: 0, all: 0 };
const count = (t) => { tally.ok += t.results.filter((r) => r.ok).length; tally.all += t.results.length; };
const run = async (name, fn) => {
  try { await fn(); } catch (err) { console.log(`FAIL ${name}: ${err.stack || err.message}`); failed = true; }
};

await run('A', async () => {
  const project = makeProject('pyright-budget');
  const t = await launch({ fixture: 'core', port: 9373, name: 'pyright-budget', projectDir: project });
  const { js, until, check, sleep, type, press } = t;
  const lens = (qual) => js(`__cv(${S(qual)})`);
  const untilLens = (qual, want, label, ms = 60000) => until(`__cv(${S(qual)}) === ${S(want)}`, label || `${qual} = ${want}`, ms);
  try {
    await js(HELPERS);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`!!__model()`, 'shapes.py open');
    await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
    const areaLine = (await js(`__sym('Shape.area').nameLine`)) - 1;
    const describeLine = (await js(`__sym('Shape.describe').nameLine`)) - 1;

    // ---- a name in 321 files: not counted ----
    await untilLens('Shape', '2 usages', 'Shape counted', 90000);
    await untilLens('Shape.describe', '1 usage');
    await untilLens('rare_helper', 'no usages');
    await untilLens('Shape.area', 'usages', 'area shown uncounted');
    await until(settled, 'counting done', 30000);
    check(!(await js(`__refAt[${areaLine}]`)), `no references request for area, found in 321 files (requests by line ${S(await js('__refAt'))})`);
    check(await js(`ide.codeVision.stats().uncounted`) >= 1, 'code vision reports the uncounted name');
    await until(`!!__cvTip('usages')`, 'uncounted lens drawn');
    const tip = await js(`__cvTip('usages')`);
    check(/Click to count the usages of area: the name appears in 321 files/.test(tip), `the uncounted lens says why (${S(tip)})`);

    // ---- a click counts it ----
    await js(`(() => { const s = __sym('Shape.area'); ide.codeVision.showUsages({ uri: __model().uri.toString(), key: s.key }); return true; })()`);
    await untilLens('Shape.area', '1 usage', 'area counted after the click', 30000);
    check(await js(`__refAt[${areaLine}]`) === 1, 'the click asked Pyright once');
    await until(`ide.editor.getPosition().lineNumber === 10`, 'the single usage opened', 10000);
    check(true, 'one usage: the click goes to it');

    // ---- an edit makes it uncounted again, without asking ----
    await addLine(t, 'x = Shape().area()');
    await untilLens('Shape', '3 usages', 'Shape counted again after the edit', 30000);
    await untilLens('Shape.area', 'usages', 'area uncounted after the edit', 30000);
    await until(settled, 'counting done after the edit', 30000);
    check(await js(`__refAt[${areaLine}]`) === 1, 'the edit asked nothing for area');

    // ---- a count past the 2 s budget ----
    await js(`(__delay[${describeLine}] = 3500, true)`);
    const before = await js(`__refAt[${describeLine}] || 0`);
    await addLine(t, 'y = Shape().describe()');
    await until(`(__refAt[${describeLine}] || 0) > ${before}`, 'describe counted again after the edit', 30000);
    const asked = Date.now();
    await untilLens('Shape.describe', 'usages', 'describe uncounted after 2 s', 10000);
    const shownAfter = Date.now() - asked;
    check(shownAfter >= 1500 && shownAfter < 3400, `a count past 2 s shows the uncounted lens meanwhile (after ${shownAfter} ms)`);
    const slowTip = `[...document.querySelectorAll('.codelens-decoration > a')].some((a) => a.title === 'Click to count the usages of describe: counting took longer than 2 s')`;
    await until(slowTip, 'uncounted describe drawn with its tooltip', 1400).catch(() => {});
    check(await js(slowTip), 'its tooltip says the count took too long');
    await untilLens('Shape.describe', '2 usages', 'the late count shown', 15000);
    check(true, 'the late answer still shows the count');
    await js(`(__delay[${describeLine}] = 0, true)`);
    const slowAsked = await js(`__refAt[${describeLine}]`);
    await addLine(t, 'z = Shape().describe()');
    await untilLens('Shape.describe', 'usages', 'describe uncounted after the next edit', 30000);
    await until(settled, 'counting done after the next edit', 30000);
    check(await js(`__refAt[${describeLine}]`) === slowAsked, 'a name in 41 files that took too long is not counted again automatically');

    // ---- a slow count of a name in one file: Pyright was busy, so it is counted again next time ----
    const shapeLine = (await js(`__sym('Shape').nameLine`)) - 1;
    await js(`(__delay[${shapeLine}] = 3500, true)`);
    const shapeBefore = await js(`__refAt[${shapeLine}] || 0`);
    await addLine(t, 'w = Shape()');
    await untilLens('Shape', 'usages', 'Shape uncounted after 2 s', 15000);
    await untilLens('Shape', '6 usages', 'the late count of Shape', 15000);
    await js(`(__delay[${shapeLine}] = 0, true)`);
    await addLine(t, 'v = Shape()');
    await untilLens('Shape', '7 usages', 'Shape counted again after the next edit', 30000);
    check(await js(`__refAt[${shapeLine}]`) >= shapeBefore + 2, 'a slow count of a name in one file is asked again automatically after the next edit');

    // ---- files written on disk ----
    mkdirSync(path.join(project, 'extra'));
    for (let i = 0; i < 300; i++) writeFileSync(path.join(project, 'extra', `e${i}.py`), `from shapes import rare_helper\nVALUE_${i} = rare_helper()\n`);
    await untilLens('rare_helper', 'usages', 'rare_helper uncounted once it is in 301 files', 60000);
    check(true, 'files written on disk move a name over the limit');

    // ---- shared document symbols ----
    const shared = await js(`(async () => { const p = ide.util.joinPath(ide.root, 'shapes.py'); const a = await ide.lsp.documentSymbols(p); const b = await ide.lsp.documentSymbols(p); return a === b && a.length > 0; })()`);
    check(shared, 'two callers get the same decorated symbol tree for one answer');

    // ---- semantic highlighting waits for a typing pause ----
    await js(`(() => { const e = ide.editor; const m = e.getModel(); const n = m.getLineCount(); m.pushEditOperations([], [{ range: new ide.monaco.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n)), text: String.fromCharCode(10, 10) }], () => null); e.focus(); e.setPosition({ lineNumber: n + 2, column: 1 }); e.revealLine(n + 2); return true; })()`);
    await sleep(2500);
    const sem0 = await js(`ide.semanticHighlight.stats().requests`);
    const typed = 'total = Shape().area() + len("abc")';
    for (const ch of typed) { await type(ch); await sleep(70); }
    const semTyping = (await js(`ide.semanticHighlight.stats().requests`)) - sem0;
    await press('Escape');
    check(semTyping <= 1, `typing ${typed.length} characters sent ${semTyping} semantic token requests`);
    await until(`ide.semanticHighlight.stats().requests > ${sem0 + semTyping}`, 'a semantic token request after the pause', 10000).catch(() => {});
    const classColor = `(() => {
      const line = [...ide.editor.getContainerDomNode().querySelectorAll('.view-line')].find((v) => v.textContent.replace(/\\u00a0/g, ' ') === ${S(typed)});
      const span = line && [...line.querySelectorAll('span span')].find((s) => s.textContent === 'Shape');
      return span ? getComputedStyle(span).color : null;
    })()`;
    await until(`${classColor} === 'rgb(47, 186, 163)'`, 'Shape colored as a class after the pause', 10000).catch(() => {});
    const color = await js(classColor);
    const semAfter = (await js(`ide.semanticHighlight.stats().requests`)) - sem0;
    check(color === 'rgb(47, 186, 163)' && semAfter >= 1, `the new text is colored after the pause (Shape: ${color}; ${semAfter} requests in all)`);

    // ---- main keeps only the newest waiting request per file ----
    const answers = await js(`(async () => {
      const i = ide.currentInterp();
      const cand = [{ cmd: i.cmd, args: i.args || [], executable: i.executable }];
      const text = Array.from({ length: 3000 }, (_, k) => 'def f' + k + '(a, b):\\n    return a + b\\n').join('');
      const ask = () => ide.api.invoke('semantic-highlight:tokens', cand, { text, path: ide.util.joinPath(ide.root, 'same.py'), root: ide.root });
      const rs = await Promise.all([ask(), ask(), ask()]);
      return rs.map((r) => (r.error ? r.error.code : r.result?.data?.length > 0 ? 'tokens' : 'empty'));
    })()`);
    check(S(answers) === S(['tokens', 'superseded', 'tokens']), `of three requests for one file, the middle one is superseded (${S(answers)})`);
  } catch (err) {
    check(false, err.stack || err.message);
  }
  if (t.results.some((r) => !r.ok) || t.consoleErrors.length) failed = true;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  count(t);
  t.close();
});

await run('B', async () => {
  const project = makeProject('pyright-budget-ko');
  const t = await launch({ fixture: 'core', port: 9374, name: 'pyright-budget-ko', projectDir: project, lang: 'ko-KR' });
  const { js, until, check } = t;
  try {
    await js(HELPERS);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`!!__model()`, 'shapes.py open');
    await until(`__cv('Shape.area') === '사용 위치'`, 'Korean uncounted lens', 90000);
    await until(`!!__cvTip('사용 위치')`, 'Korean uncounted lens drawn');
    const tip = await js(`__cvTip('사용 위치')`);
    check(tip === '클릭하면 area의 사용 위치를 계산합니다. 이 이름은 파일 321개에 나옵니다', `Korean: 사용 위치 with its tooltip (${S(tip)})`);
    await js(`(ide.openSettings('code-vision'), true)`);
    await until(`document.querySelector('.settings-page')?.dataset.page === 'code-vision'`, 'Code Vision settings page');
    const leaks = await englishLeaks(t, '.settings-dialog');
    check(leaks.length === 0, `the Code Vision settings page is Korean ${S(leaks)}`);
    check(await js(`document.querySelector('.settings-dialog .settings-note')?.textContent.includes('300개보다 많은')`), 'the settings note gives the limit in Korean');
    await js(`(document.querySelector('#settingsCancel').click(), true)`);
    const missing = await missingTranslations(t);
    check(missing.length === 0, `no missing translations ${S(missing)}`);
  } catch (err) {
    check(false, err.stack || err.message);
  }
  if (t.results.some((r) => !r.ok) || t.consoleErrors.length) failed = true;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  count(t);
  t.close();
});

console.log(`${tally.ok}/${tally.all} passed`);
process.exit(failed || tally.ok !== tally.all ? 1 : 0);
