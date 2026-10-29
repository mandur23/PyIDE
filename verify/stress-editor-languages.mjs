// Hostile input for the editor's language features, in the real app over CDP: keyword and name completion,
// Markdown lists, Lua/shell indentation (language-basics), Emmet, HTML/XML tag closing, live and postfix templates,
// f-strings and statement assists (editor-assists), JSON/YAML/XML formatting and schemas (data-formats), Prettier and
// ESLint (js-tools, with stand-ins that crash, hang and print garbage), SQL files on an unreachable or deleted data
// source, Reformat Code and block comments (tooling), and languages by file name (core/editors.js).
// Each attack asserts: no renderer exception, no main-thread task over FREEZE_MS (long tasks are measured in the page),
// the document as expected (not corrupted), undo restoring the text, and a clear message where something is refused.
// Big input (5 MB files, 100k-character lines, 10k levels of nesting), broken input, Unicode/RTL/CRLF/mixed
// indentation, exploding Emmet, 50 cursors, 500 characters typed fast with completion open, quick language switches.
// Offline: the project, the stand-in CLIs and the stand-in pg driver are written to %TEMP%. Ports 8630-8631.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { descendants, launch, openFile, processSnapshot } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FREEZE_MS = 2000;
const MB = 1024 * 1024;

// ---------- the project ----------
const work = mkdtempSync(path.join(tmpdir(), 'pyide-stress-editor-languages-'));
const project = path.join(work, 'project');
const put = (rel, text) => { const p = path.join(project, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };
const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length));
put('big.html', `<!DOCTYPE html>\n<html>\n<body>\n${fill('<div class="row"><span>text</span> <a href="#">link</a></div>\n', 5 * MB)}</body>\n</html>\n`);
put('big.css', fill('.row { margin: 0; padding: 1px 2px; color: #fff; }\n', 5 * MB));
put('big.py', fill('def f(x):\n    return x + 1  # comment\n\n', 5 * MB));
put('big.js', fill('function f(a) { return a + 1; }\n', 5 * MB));
put('big.c', fill('int counter = 0; while (counter < 10) counter++;\n', 5 * MB));
put('long.js', `${fill('var a=1;', 100000)}\n`);
put('word.js', `${'x'.repeat(100000)} \n`);
put('paren.html', `${'('.repeat(50000)}\n`);
put('deep.json', `${'['.repeat(10000)}${']'.repeat(10000)}\n`);
put('deep.xml', `${'<a>'.repeat(10000)}${'</a>'.repeat(10000)}\n`);
put('deep.html', `<!DOCTYPE html>\n<html><body>\n${'<div>'.repeat(10000)}\n</body></html>\n`);
put('deep.yaml', `${Array.from({ length: 1000 }, (_, k) => `${' '.repeat(k)}k${k}:`).join('\n')} v\n`);
put('flow.yaml', `a: ${'['.repeat(10000)}${']'.repeat(10000)}\n`);
put('broken.json', '{"a": [1, 2,, "b": }\n');
put('broken.yaml', 'a: [1, 2\nb: "open\n  - c: d: e\n\t- tab\n');
put('broken.xml', '<root><a></b><![CDATA[ x </root>\n');
put('unicode.md', '# 제목 😀\n\n- 항목 é\u0301 שלום\n');
put('crlf.yaml', 'a:\r\n   b: 😀\u0301 שלום\n   c: "é"\r\nd:\r\n e: 1\n');
put('big.md', fill('# Heading\n\n- item one\n- item two\n\n```\ncode\n```\n', 5 * MB));
put('big1.py', fill('def f(x):\n    return x + 1  # comment\n\n', 1.9 * MB));
put('word.py', `${'x'.repeat(100000)} \n`);
put('long.css', `.a { ${fill('color: red; ', 100000)}}\n`);
put('deep500.json', `${'['.repeat(500)}${']'.repeat(500)}\n`);
put('deep1000.xml', `${'<a>'.repeat(1000)}${'</a>'.repeat(1000)}\n`);
put('tabs.yaml', 'a:\n\tb: 1\n');
put('broken.js', 'function f( {\n');
put('mixed.py', 'def f():\n\tif x:\n        return 1\n\treturn 2\n');
put('script.lua', '');
put('run.sh', '');
put('notes.md', '');
put('page.html', '');
put('data.xml', '');
put('app.jsx', '');
put('main.c', '');
put('Main.java', '');
put('app.js', '');
put('app.ts', '');
put('code.py', '');
put('style.css', '');
put('json', '{"a": 1}\n');
put('yaml', 'a: 1\n');
put('data.json.bak', '{"a": 1}\n');
put('Makefile', 'all:\n\techo hi\n');
put('Dockerfile', 'FROM x\n');
put('query.sql', 'SELECT 1;\n');
// Prettier and ESLint stand-ins: node_modules/.mode picks how they misbehave (ok, crash, hang, garbage, empty, json).
put('package.json', '{"name": "stress", "private": true}\n');
put('eslint.config.mjs', 'export default [{ rules: {} }];\n');
put('node_modules/prettier/package.json', J({ name: 'prettier', version: '3.0.0-stress', bin: './bin/prettier.cjs' }));
put('node_modules/eslint/package.json', J({ name: 'eslint', version: '9.0.0-stress', bin: { eslint: './bin/eslint.js' } }));
const STANDIN = (tool) => `const fs = require('fs'); const path = require('path');
let mode = 'ok'; try { mode = fs.readFileSync(path.join(__dirname, '..', '..', '.mode'), 'utf8').trim(); } catch {}
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (mode === 'crash') { process.stderr.write('TypeError: Cannot read properties of undefined (reading \\'x\\')\\n    at Object.<anonymous> (${tool}.js:1:1)\\n'); process.exit(${tool === 'eslint' ? 2 : 1}); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'garbage') { process.stdout.write('\\u0000\\uFFFD\\u001b[31m garbage \\u202e\\n'.repeat(3)); process.exit(0); }
  if (mode === 'empty') { process.exit(0); }
  ${tool === 'eslint'
    ? `if (mode === 'json') { process.stdout.write(JSON.stringify([{ messages: [{ ruleId: 'r', severity: 2, message: 'm', line: 999999, column: -5, endLine: 0, endColumn: 1e9, fix: { range: [-10, 1e9], text: 'Z' } }, { ruleId: null, severity: 1, message: 'nothing' }, { ruleId: 'q', severity: 2, message: 'x', line: 'abc', column: null }] }])); process.exit(1); }
  if (mode === 'notarray') { process.stdout.write(JSON.stringify([{ messages: 'oops' }])); process.exit(1); }
  process.stdout.write(JSON.stringify([{ messages: [] }]));`
    : `process.stdout.write(input.replace(/[ \\t]+$/gm, ''));`}
});`;
put('node_modules/prettier/bin/prettier.cjs', STANDIN('prettier'));
put('node_modules/eslint/bin/eslint.js', STANDIN('eslint'));
const mode = (m) => writeFileSync(path.join(project, 'node_modules', '.mode'), m);
mode('ok');
// A pg stand-in: host "refused" fails at once, "slow" after its connection timeout, anything else answers.
const driverDir = mkdtempSync(path.join(tmpdir(), 'pyide-stress-editor-languages-drivers-'));
mkdirSync(path.join(driverDir, 'node_modules', 'pg'), { recursive: true });
writeFileSync(path.join(driverDir, 'package.json'), J({ name: 'pyide-db-drivers', private: true }));
writeFileSync(path.join(driverDir, 'node_modules', 'pg', 'package.json'), J({ name: 'pg', version: '8.0.0', main: 'index.js' }));
writeFileSync(path.join(driverDir, 'node_modules', 'pg', 'index.js'), `class Client {
  constructor(cfg) { this.cfg = cfg; }
  on() { return this; }
  async connect() {
    if (this.cfg.host === 'refused') { const e = new Error('connect ECONNREFUSED 127.0.0.1:1'); e.code = 'ECONNREFUSED'; throw e; }
    if (this.cfg.host === 'slow') { await new Promise((r) => setTimeout(r, 1500)); throw new Error('Connection terminated due to connection timeout'); }
  }
  async end() {}
  async query(q) { const text = typeof q === 'string' ? q : q.text; if (/version\\(\\)/.test(text)) return { rows: [{ v: 'PostgreSQL 16 (stand-in)' }] }; return { command: 'SELECT', fields: [{ name: 'one', dataTypeID: 23 }], rows: [{ one: 1 }] }; }
}
module.exports = { Client, types: { getTypeParser: () => (s) => s } };`);
process.env.PYIDE_DB_DRIVERS = driverDir;

// ---------- driving the editor ----------
const t = await launch({ fixture: 'language-support', projectDir: project, name: 'stress-editor-languages', port: 8630 });
const { js, until, press, check, sleep, cdp } = t;
const edFor = (name) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.path.endsWith('/${name}') && e.getDomNode()?.isConnected)`;
let ED = 'ide.editor';
async function open(name) {
  await openFile(t, name);
  await until(`!!${edFor(name)}`, `editor for ${name}`, 30000);
  ED = edFor(name);
  await js(`(${ED}.focus(), true)`);
}
const setText = (text, line = 1, col = 1) => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const setEnd = (text) => { const lines = text.split('\n'); return setText(text, lines.length, lines.at(-1).length + 1); };
const text = () => js(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const caretToEnd = () => js(`(() => { const e = ${ED}; const m = e.getModel(); const l = m.getLineCount(); e.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); e.focus(); return true; })()`);
const undo = () => js(`(${ED}.trigger('t', 'undo', null), true)`);
const redo = () => js(`(${ED}.trigger('t', 'redo', null), true)`);
const typeChar = (ch) => cdp('Input.insertText', { text: ch });
async function keys(s) {
  for (const ch of s) {
    if (ch === '\n') {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    } else await typeChar(ch);
    await sleep(25);
  }
  await sleep(150);
}
const hint = () => js(`(() => { const h = document.getElementById('toolingHint'); return h && !h.classList.contains('hidden') ? h.textContent : ''; })()`);
const clearHint = () => js(`(document.getElementById('toolingHint')?.classList.add('hidden'), true)`);

// Long tasks: the longest main-thread task since the last reset, in ms (the page's PerformanceObserver).
await js(`(() => { window.__stress = { max: 0 }; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__stress.max = Math.max(window.__stress.max, e.duration); }).observe({ entryTypes: ['longtask'] }); return true; })()`);
const resetLong = () => js(`(window.__stress.max = 0, true)`);
const longest = async () => { await sleep(200); return Math.round(await js('window.__stress.max')); };
// Runs `fn`, then checks that no main-thread task took longer than FREEZE_MS and that no renderer exception happened.
// known: {errors: RegExp, slow: true} for what code outside the features under test does (reported as NOTE lines, see
// the summary at the end), so the run still checks everything else.
const notes = [];
async function guarded(label, fn, known = {}) {
  const errorsBefore = t.consoleErrors.length;
  await resetLong();
  const started = Date.now();
  let result;
  try { result = await fn(); } catch (err) { check(false, `${label}: ${err.message.split('\n')[0]}`); }
  const ms = await longest();
  const all = t.consoleErrors.splice(errorsBefore);
  const errors = all.filter((e) => !known.errors?.test(e));
  t.consoleErrors.push(...errors);
  const ignored = all.length - errors.length;
  if (ignored || (known.slow && ms >= FREEZE_MS)) notes.push(`${label}: ${ms} ms${ignored ? `, ${ignored} exception(s) ${J(all.find((e) => known.errors.test(e)).split('\n')[0])}` : ''}`);
  const frozen = ms >= FREEZE_MS && !known.slow;
  check(!frozen && !errors.length, `${label}: longest task ${ms} ms, ${Date.now() - started} ms in all${errors.length ? `, exceptions ${J(errors.map((e) => e.split('\n')[0]))}` : ''}`);
  return result;
}
const closeAll = () => js(`ide.closeAllTabs(true).then(() => true)`);

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await js(`(ide.settings.set('jsTools.eslint', false), true)`);

  // ---------- languages by file name ----------
  for (const [file, want] of Object.entries({ json: 'plaintext', yaml: 'plaintext', 'data.json.bak': 'plaintext', Makefile: null, Dockerfile: 'dockerfile' })) {
    await open(file);
    const got = await js(`${ED}.getModel().getLanguageId()`);
    check(want === null ? !!got : got === want, `a file named ${file} is edited as ${want ?? 'some language'} (${got})`);
  }

  // ---------- quick language switches ----------
  await open('app.js');
  const SWITCHED = 'function f() {\n  return <div>{x}</div>;\n}\n<a href="x">\n- item\n';
  await setEnd(SWITCHED);
  await guarded('switching the language 200 times while typing', async () => {
    const langs = ['javascript', 'html', 'markdown', 'lua', 'shell', 'xml', 'yaml', 'json', 'python', 'sql', 'c', 'java', 'css', 'typescript', 'plaintext'];
    for (let k = 0; k < 200; k++) {
      await js(`(ide.monaco.editor.setModelLanguage(${ED}.getModel(), ${J(langs[k % langs.length])}), true)`);
      if (k % 10 === 0) await typeChar('z');
    }
    await js(`(ide.monaco.editor.setModelLanguage(${ED}.getModel(), 'javascript'), true)`);
  });
  check(await text() === `${SWITCHED}${'z'.repeat(20)}`, `the document survives the switches (${J((await text()).slice(-30))})`);

  // ---------- 5 MB files: typing at the end ----------
  for (const [file, typed] of [['big.html', '<p>x</p> ul>li*3'], ['big.css', '.a { m10 }'], ['big.py', 'x = "{len}" """'], ['big.js', 'x.log fori'],
    ['big.c', 'whi cou'], ['big.md', '\n- 항목 😀\n\n']]) {
    await open(file);
    await caretToEnd();
    const length = await js(`${ED}.getModel().getValueLength()`);
    // The Markdown preview beside the editor renders the whole file again after each edit (renderer/features/viewers).
    await guarded(`${file} (${Math.round(length / MB)} MB): typing ${J(typed)} at the end`, () => keys(typed), file === 'big.md' ? { slow: true } : {});
    check(await js(`${ED}.getModel().getValueLength()`) >= length + typed.length - 4, `${file}: what was typed is in the document`);
    if (file === 'big.html') {
      // 50 carets at the ends of 50 new lines, each after "<p".
      await js(`(() => { const e = ${ED}; const m = e.getModel(); const l = m.getLineCount();
        m.applyEdits([{ range: new ide.monaco.Range(l, m.getLineMaxColumn(l), l, m.getLineMaxColumn(l)), text: '\\n<p'.repeat(50) }]);
        e.setSelections(Array.from({ length: 50 }, (_, k) => new ide.monaco.Selection(l + 1 + k, 3, l + 1 + k, 3))); return true; })()`);
      await guarded('big.html: ">" typed at 50 carets', () => keys('>'));
      check(await js(`${ED}.getModel().getLinesContent().slice(-50).every(l => l === '<p></p>')`), 'big.html: each of the 50 lines got its end tag');
    }
    await closeAll();
  }

  // ---------- 100k-character lines ----------
  for (const [file, typed] of [['long.js', 'x.log'], ['word.js', 'iter'], ['paren.html', 'a'], ['word.py', 'main'], ['long.css', 'm10']]) {
    await open(file);
    await js(`(() => { const e = ${ED}; e.setPosition({ lineNumber: 1, column: e.getModel().getLineMaxColumn(1) }); e.focus(); return true; })()`);
    const before = await text();
    await guarded(`${file}: typing ${J(typed)} and Tab at the end of a 100k-character line`, async () => { await keys(typed); await press('Tab'); await sleep(300); });
    await guarded(`${file}: Ctrl+Shift+/ on the whole line`, async () => {
      await js(`(${ED}.setSelection(new ide.monaco.Selection(1, 1, 1, ${ED}.getModel().getLineMaxColumn(1))), true)`);
      await press('Ctrl+Shift+/');
      await sleep(300);
    });
    for (let k = 0; k < 6; k++) await undo();
    check(await text() === before, `${file}: undo restores the line`);
  }
  await closeAll();

  // ---------- deep nesting and broken files: Reformat Code ----------
  // The project's Prettier stand-in formats JSON and YAML first when it is on: off here, but for broken.js.
  await js(`(ide.settings.set('jsTools.prettierOnReformat', false), true)`);
  // -> {before, after, hint} once the hint shows (or after `ms`).
  async function reformat(file, ms = 8000) {
    await open(file);
    await sleep(1000);
    const before = await text();
    await clearHint();
    await press('Ctrl+Alt+L');
    await until(`(() => { const h = document.getElementById('toolingHint'); return h && !h.classList.contains('hidden'); })()`, `hint for ${file}`, ms).catch(() => {});
    return { before, after: await text(), hint: await hint() };
  }
  const JSON_WORKER = { errors: /json\.worker/, slow: true };
  await guarded('deep.json (10,000 levels) opened', async () => { await open('deep.json'); await sleep(3000); }, JSON_WORKER);
  let r = await guarded('deep.json: Ctrl+Alt+L', () => reformat('deep.json'), JSON_WORKER);
  check(r?.after === r?.before && r?.hint === 'Cannot reformat: the JSON is nested too deeply (line 1)', `deep.json: refused, untouched (${J(r?.hint)})`);
  r = await guarded('deep500.json (500 levels): Ctrl+Alt+L', () => reformat('deep500.json'));
  check(r?.after.split('\n').length > 500 && /^Reformatted code/.test(r?.hint), `deep500.json: formatted (${J(r?.hint)})`);
  r = await guarded('deep.xml (10,000 levels): Ctrl+Alt+L', () => reformat('deep.xml'));
  check(r?.after === r?.before && r?.hint === 'Cannot reformat: the XML is nested too deeply (line 1)', `deep.xml: refused, untouched (${J(r?.hint)})`);
  r = await guarded('deep1000.xml (1,000 levels): Ctrl+Alt+L', () => reformat('deep1000.xml'));
  check(r?.after.split('\n').length > 1000 && /^Reformatted code/.test(r?.hint), `deep1000.xml: formatted (${J(r?.hint)})`);
  r = await guarded('deep.yaml (1,000 levels): Ctrl+Alt+L', () => reformat('deep.yaml'));
  check(r?.after.replace(/ +/g, ' ') === r?.before.replace(/ +/g, ' ') && /^(Reformatted code|No lines changed)/.test(r?.hint), `deep.yaml: formatted (${J(r?.hint)})`);
  r = await guarded('flow.yaml ([ 10,000 levels ]): Ctrl+Alt+L', () => reformat('flow.yaml'));
  check(r?.after === r?.before && r?.hint, `flow.yaml: unchanged (${J(r?.hint)})`);
  for (const [file, want] of [['broken.json', /./], ['broken.yaml', /^Cannot reformat: the YAML on line 1 cannot be reformatted safely$/],
    ['tabs.yaml', /^Cannot reformat: line 2 is indented with a tab$/], ['broken.xml', /^Cannot reformat: the XML is not well-formed \(line 1\)$/],
    ['broken.js', /^Prettier cannot format the file: /]]) {
    if (file === 'broken.js') { mode('crash'); await js(`(ide.settings.set('jsTools.prettierOnReformat', true), true)`); }
    r = await guarded(`${file}: Ctrl+Alt+L`, () => reformat(file));
    // Monaco's JSON formatter works on tokens and re-spaces broken JSON too, as PyCharm does: only blanks may change.
    const same = file === 'broken.json' ? r?.after.replace(/\s/g, '') === r?.before.replace(/\s/g, '') : r?.after === r?.before;
    check(same && want.test(r?.hint), `${file}: not corrupted, hint ${J(r?.hint)}`);
  }
  mode('ok');
  await js(`(ide.settings.set('jsTools.prettierOnReformat', false), true)`);
  r = await guarded('crlf.yaml (CRLF and LF mixed, emoji, RTL, combining marks): Ctrl+Alt+L', () => reformat('crlf.yaml'));
  const ind = /\n( +)b/.exec(r?.after || '')?.[1] || '';
  check(r?.after === `a:\n${ind}b: 😀\u0301 שלום\n${ind}c: "é"\nd:\n${ind}e: 1\n` && /^Reformatted code/.test(r?.hint), `crlf.yaml: one indentation, text kept (${J(r?.after)}, ${J(r?.hint)})`);
  await undo();
  check(await text() === r?.before, 'crlf.yaml: undo restores it');
  r = await guarded('deep.html (10,000 open divs): Ctrl+Alt+L', () => reformat('deep.html', 60000), { slow: true });
  notes.push(`deep.html: Monaco's HTML formatter turned ${r?.before.length} characters into ${r?.after.length}`);
  await guarded('deep.html: undo after Reformat Code', async () => { await undo(); await sleep(500); }, { slow: true });
  check(await text() === r?.before, 'deep.html: undo restores the text');
  await closeAll();

  // ---------- 500 characters typed fast with the completion list open ----------
  const FAST = 'counter alpha.beta gamma '.repeat(20);
  for (const [file, start] of [['main.c', 'int counter = 0;\n'], ['app.js', 'const counter = 0;\n'], ['code.py', 'counter = 0\n'], ['page.html', '<body>\n']]) {
    await open(file);
    await setEnd(start);
    await typeChar('c');
    await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
    await until(`!!${ED}.getDomNode().querySelector('.suggest-widget.visible')`, 'completion list', 5000).catch(() => {});
    await guarded(`${file}: ${FAST.length} characters typed fast with the completion list open`, async () => {
      for (const ch of FAST) await typeChar(ch);
      await sleep(1000);
    });
    const got = await text();
    check(got === `${start}c${FAST}`, `${file}: the text is exactly what was typed (${J(got.slice(-40))})`);
    await js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`);
  }

  // ---------- Emmet ----------
  await open('page.html');
  const B = '<!DOCTYPE html>\n<html>\n<body>\n';
  const E = '\n</body>\n</html>\n';
  const at = (before, after = E) => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
    const m = e.getModel(); m.setValue(${J(before)} + ${J(after)}); e.setPosition(m.getPositionAt(${before.length})); e.focus(); return true; })()`);
  const emmet = (abbr) => js(`ide.emmet.expand(${J(abbr)}, { syntax: 'html' })`);
  const deep = `${'div>'.repeat(999)}div`;
  const cases = [['div*100000', (s) => s?.split('<div>').length - 1 === 200, 'is capped at 200 elements'],
    [deep, (s) => typeof s === 'string' && s.split('<div>').length - 1 === 1000, 'expands (1000 levels)'],
    [`${deep}>p`, (s) => s === null, 'is refused past 1000 elements'],
    ['(div>(p', (s) => s === null, 'unbalanced ( is refused'], ['div)', (s) => s === null, 'unbalanced ) is refused'],
    ['div{open', (s) => s === null, 'unclosed { is refused'], ['div[a="x', (s) => s === null, 'unclosed [ is refused'],
    [`${'('.repeat(5000)}div${')'.repeat(5000)}`, (s) => s === null || typeof s === 'string', 'is answered (5000 groups)'],
    ['(lorem1000*200)*5', (s) => s === null, 'is refused (1000 elements of 1000 words)'],
    ['p{😀 שלום é\u0301}', (s) => s === '<p>😀 שלום é\u0301</p>', 'keeps emoji, RTL and combining marks'],
    ['a[href="${x}"]{$$$}', (s) => typeof s === 'string' && !/\$\{x\}/.test(s.replace(/\\\$/g, '')), 'escapes $ and braces']];
  for (const [abbr, ok, what] of cases) {
    const s = await guarded(`Emmet ${J(abbr.length > 40 ? `${abbr.slice(0, 20)}…${abbr.slice(-12)}` : abbr)}`, () => emmet(abbr));
    check(ok(s), `Emmet ${J(abbr.slice(0, 30))}: ${what} (${J(typeof s === 'string' ? `${s.length} chars` : s)})`);
  }
  for (const abbr of ['div*100000', `${'div>'.repeat(200)}div`, 'lorem1000*200', 'ul>li*50>a{$$$ 😀}']) {
    await at(B);
    await guarded(`Emmet typed and Tab: ${J(abbr.slice(0, 24))}`, async () => { for (const ch of abbr) await typeChar(ch); await sleep(300); await press('Tab'); await sleep(500); });
    const expanded = await text();
    check(expanded.length > (B + abbr + E).length && !expanded.includes(abbr), `${J(abbr.slice(0, 24))} expanded (${expanded.length} chars)`);
    await js(`(${ED}.trigger('t', 'leaveSnippet', {}), true)`);
    await undo();
    check(await text() === B + abbr + E, `${J(abbr.slice(0, 24))}: undo restores the abbreviation`);
    await redo();
    check(await text() === expanded, `${J(abbr.slice(0, 24))}: redo expands it again`);
  }

  // ---------- tag closing in attributes, comments, CDATA, script and style ----------
  const closes = [['page.html', '<a title="x', '"></a>', '>', 'in an attribute value'], ['page.html', '<!-- <b', ' -->', '>', 'in a comment'],
    ['page.html', '<script>if (a <b', '', '>', 'in <script>'], ['page.html', '<style>a <b', '', '>', 'in <style>'],
    ['page.html', '<script>x<', '', '', 'after </ in <script>', '<script>x</script>'],
    ['data.xml', '<r><![CDATA[ <b', ']]></r>', '>', 'in CDATA'], ['data.xml', '<r a="<b', '"/>', '>', 'in an XML attribute value'],
    ['data.xml', '<!-- <b', ' -->', '>', 'in an XML comment'], ['data.xml', '<?pi <b', '?>', '>', 'in a processing instruction'],
    ['page.html', '<태그', '', '>', 'after a Korean "tag"'], ['page.html', '<a😀', '', '>', 'after a tag name with an emoji', '<a😀></a😀>']];
  for (const [file, before, after, typed, where, want] of closes) {
    await open(file);
    await at(before, after);
    await guarded(`tag closing ${where}`, () => keys(typed || '/'));
    const got = await text();
    const expect = want ? want + after : before + (typed || '/') + after;
    check(got === expect, `nothing inserted ${where}${want ? ' but the end tag' : ''} (${J(got)})`);
  }
  // 50 carets in a small file: 50 end tags, one undo step.
  await open('page.html');
  await setText(Array.from({ length: 50 }, () => '<div').join('\n'));
  await js(`(${ED}.setSelections(Array.from({ length: 50 }, (_, k) => new ide.monaco.Selection(k + 1, 5, k + 1, 5))), true)`);
  await guarded('">" typed at 50 carets', () => keys('>'));
  check(await text() === Array.from({ length: 50 }, () => '<div></div>').join('\n'), '50 carets: 50 end tags');
  await undo();
  check(await text() === Array.from({ length: 50 }, () => '<div>').join('\n'), '50 carets: one undo takes the 50 end tags away');
  await redo();
  check(await text() === Array.from({ length: 50 }, () => '<div></div>').join('\n'), '50 carets: redo puts them back');
  await guarded('50 carets: "</" after 10,000 open divs', async () => {
    await setText(`${'<div>'.repeat(10000)}\n${Array.from({ length: 50 }, () => '').join('\n')}`);
    await js(`(${ED}.setSelections(Array.from({ length: 50 }, (_, k) => new ide.monaco.Selection(k + 2, 1, k + 2, 1))), true)`);
    await keys('</');
  }, { errors: /html\.worker/ });
  check(await js(`${ED}.getModel().getLinesContent().slice(1).every(l => l === '</div>')`), '50 carets: each "</" completed to </div>');

  // ---------- live templates ----------
  await js(`(ide.settings.set('liveTemplates.custom', ${J({
    'js:empty': { body: '' }, 'js:vars': { body: '$A$-$B$-$A$$END$' }, 'js:rec': { body: 'rec $END$ rec' },
    'js:weird': { body: '${1:x} \\ } $ $$ $NOEND $END$$END$' }, 'js:sel': { body: '$SELECTION$' }, 'js:uni': { body: '😀 $שלום$ é\u0301 $END$' },
    'java:big': { body: `${'x'.repeat(100000)}$END$` },
  })}), true)`);
  await sleep(200);
  await open('app.js');
  const templates = [['empty', ''], ['vars', '--'], ['rec', 'rec  rec'], ['weird', '${1:x} \\ } $ $ $NOEND '], ['sel', ''], ['uni', '😀 $שלום$ é\u0301 ']];
  for (const [abbr, want] of templates) {
    await setEnd('');
    await guarded(`live template ${abbr} + Tab`, async () => { await keys(abbr); await press('Tab'); await sleep(200); });
    const got = await text();
    check(got === want, `live template ${J(abbr)} expands to ${J(want)} (${J(got)})`);
    await js(`(${ED}.trigger('t', 'leaveSnippet', {}), true)`);
    await undo();
    check(await text() === abbr, `live template ${J(abbr)}: undo restores the abbreviation (${J(await text())})`);
  }
  // A template expanded over and over: each Tab adds one, nothing recurses.
  await setEnd('');
  await guarded('live template rec + Tab, 30 times', async () => {
    for (let k = 0; k < 30; k++) { await js(`(${ED}.trigger('t', 'leaveSnippet', {}), true)`); await keys(' rec'); await press('Tab'); }
  });
  check((await text()).split('rec').length - 1 === 60, `30 expansions give 60 words (${(await text()).split('rec').length - 1})`);
  await setEnd(`${'x'.repeat(50000)}.log`);
  await guarded('postfix .log after a 50,000-character name', async () => { await press('Tab'); await sleep(300); });
  check(await text() === `console.log(${'x'.repeat(50000)})`, 'the postfix template wraps the long name');
  await setEnd(`${'x'.repeat(50000)}().for`);
  await guarded('postfix .for after a 50,000-character call', async () => { await press('Tab'); await sleep(300); });
  check((await text()).startsWith('for (const item of xxx'), `the postfix template wraps the long call (${J((await text()).slice(0, 30))})`);
  await open('Main.java');
  await setEnd('');
  await guarded('live template with a 100,000-character body', async () => { await keys('big'); await press('Tab'); await sleep(500); });
  check(await js(`${ED}.getModel().getValueLength()`) === 100000, 'the 100,000-character body is inserted');
  await js(`(${ED}.trigger('t', 'leaveSnippet', {}), true)`);
  await open('big1.py');
  await sleep(3000);
  await caretToEnd();
  await guarded('Python live template main + Tab at the end of a 1.9 MB file', async () => { await keys('\nmain'); await press('Tab'); await sleep(300); });
  check((await text()).endsWith('if __name__ == "__main__":\n    '), 'the template expands at the end of the big file');
  await js(`(${ED}.trigger('t', 'leaveSnippet', {}), true)`);

  // ---------- editor assists on a 1.9 MB Python file ----------
  await caretToEnd();
  await guarded('f-string: "{len}" typed at the end of a 1.9 MB file', () => keys('\nx = "{len}'));
  check((await text()).endsWith('x = f"{len}"'), `the string becomes an f-string (${J((await text()).slice(-14))})`);
  await undo();
  check((await text()).endsWith('x = "{len}"'), `undo takes the f prefix away (${J((await text()).slice(-14))})`);
  await caretToEnd();
  await guarded('Complete Current Statement (Ctrl+Shift+Enter) at the end of a 1.9 MB file', async () => { await keys('\nprint("x"'); await press('Ctrl+Shift+Enter'); await sleep(500); });
  check(/\n *print\("x"\)\n *$/.test(await text()), `the statement is completed (${J((await text()).slice(-20))})`);
  await guarded('Move Statement Up (Ctrl+Shift+ArrowUp) at the end of a 1.9 MB file', async () => { await keys('y = 1'); await press('Ctrl+Shift+ArrowUp'); await sleep(500); });
  check(/\n *y = 1\n *print\("x"\)\n?$/.test(await text()), `the statement moves up (${J((await text()).slice(-24))})`);
  await closeAll();

  // ---------- Markdown, Lua and shell ----------
  await open('notes.md');
  for (const [start, want] of [['- 항목 😀 שלום', '- 항목 😀 שלום\n- '], ['999999999. x', '999999999. x\n1000000000. '], ['1234567890. x', '1234567890. x\n'],
    ['  - [x] é\u0301', '  - [x] é\u0301\n  - [ ] '], ['```\n- x', '```\n- x\n'], ['- ', '']]) {
    await setEnd(start);
    await guarded(`Markdown: Enter after ${J(start)}`, () => keys('\n'));
    check(await text() === want, `Markdown: ${J(start)} + Enter gives ${J(want)} (${J(await text())})`);
    await undo();
    check(await text() === start, `Markdown: undo restores ${J(start)} (${J(await text())})`);
  }
  await js(`(${ED}.getModel().setEOL(ide.monaco.editor.EndOfLineSequence.CRLF), true)`);
  await setEnd('- a\r\n- b');
  await keys('\n');
  check(await js(`${ED}.getModel().getValue()`) === '- a\r\n- b\r\n- ', 'Markdown in a CRLF file: the new item uses CRLF');
  // 50 carets: no list continuation (one item at a time), Monaco's Enter at every caret.
  await setText(Array.from({ length: 50 }, () => '- x').join('\n'));
  await js(`(${ED}.setSelections(Array.from({ length: 50 }, (_, k) => new ide.monaco.Selection(k + 1, 4, k + 1, 4))), true)`);
  await guarded('Markdown: Enter at 50 carets', () => keys('\n'));
  check(await js(`${ED}.getModel().getLineCount()`) === 100, '50 carets: 50 new lines');
  await open('script.lua');
  await js(`(${ED}.getModel().updateOptions({ insertSpaces: false, tabSize: 4 }), true)`);
  await setEnd('function f()');
  await keys('\nx()\nend');
  check(await text() === 'function f()\n\tx()\nend', `Lua with tabs: the body indents with a tab, "end" moves back (${J(await text())})`);
  await undo();
  check(await text() === 'function f()\n\tx()\n\tend', `Lua: undo puts "end" back where it was typed (${J(await text())})`);
  await setText(Array.from({ length: 50 }, () => '    en').join('\n'));
  await js(`(${ED}.setSelections(Array.from({ length: 50 }, (_, k) => new ide.monaco.Selection(k + 1, 7, k + 1, 7))), true)`);
  await guarded('Lua: "d" typed at 50 carets', () => keys('d'));
  check(await text() === Array.from({ length: 50 }, () => '    end').join('\n'), 'Lua: 50 carets type "end" without outdenting');
  await open('run.sh');
  await setEnd('if [ "😀" = "שלום" ]; then');
  await keys('\necho é\u0301\nfi');
  check(await text() === 'if [ "😀" = "שלום" ]; then\n    echo é\u0301\nfi', `shell with emoji and RTL: indents and outdents (${J(await text())})`);

  // ---------- mixed indentation ----------
  await open('mixed.py');
  const opts = await js(`(() => { const o = ${ED}.getModel().getOptions(); return [o.insertSpaces, o.tabSize]; })()`);
  check(Array.isArray(opts), `a file indented with tabs and spaces opens (insertSpaces, tabSize: ${J(opts)})`);
  await guarded('mixed.py: Enter after "if x:"', async () => { await js(`(${ED}.setPosition({ lineNumber: 2, column: 7 }), true)`); await keys('\n'); });
  await closeAll();

  // ---------- Prettier and ESLint that misbehave ----------
  await js(`(ide.settings.set('jsTools.prettierOnReformat', true), true)`);
  await js(`(ide.settings.set('jsTools.eslint', true), true)`);
  const standins = () => descendants(processSnapshot(), t.pid).filter((p) => /eslint[\\/]bin[\\/]eslint\.js/.test(p.cmd)).length;
  for (const m of ['garbage', 'empty']) {
    mode(m);
    r = await guarded(`Prettier that prints ${m}: Ctrl+Alt+L`, () => reformat('app.js'));
    check(r?.after === r?.before && /^Prettier cannot format the file: /.test(r?.hint), `Prettier ${m}: the file is left alone (${J(r?.hint)})`);
  }
  mode('hang');
  await open('app.js');
  await setText('const a = 1;   \n');
  await clearHint();
  await guarded('Prettier that hangs: Ctrl+Alt+L, then typing', async () => { await press('Ctrl+Alt+L'); await sleep(500); await keys('x'); });
  check(await text() === 'xconst a = 1;   \n', 'Prettier hangs: typing goes on, the text is not touched');
  // ESLint that hangs: typing with pauses must not start one lint per pause.
  await guarded('ESLint that hangs: typing with 6 pauses', async () => { for (let k = 0; k < 6; k++) { await keys('y'); await sleep(1100); } });
  const running = standins();
  check(running <= 2, `ESLint hangs: ${running} stand-in(s) running at once`);
  for (const m of ['crash', 'garbage', 'json', 'notarray']) {
    mode(m);
    await setText(`const v${m} = 1;\n`);
    await sleep(1500);
    await guarded(`ESLint that prints ${m}: lint and quick fixes`, async () => {
      await js(`ide.jsTools.lint(ide.activeTab())`);
      await js(`(${ED}.setPosition({ lineNumber: 1, column: 3 }), ${ED}.trigger('t', 'editor.action.quickFix', {}), true)`);
      await sleep(800);
      await press('Escape');
    });
  }
  const failures = await js(`ide.notifications.list().filter(n => n.title === 'ESLint cannot check files').length`);
  check(failures >= 1 && failures <= 4, `ESLint failures are notifications, not one per keystroke (${failures})`);
  mode('ok');
  await js(`(ide.settings.set('jsTools.eslint', false), true)`);
  await closeAll();

  // ---------- SQL files on an unreachable or deleted data source ----------
  await js(`ide.database.addDataSource({ kind: 'postgres', name: 'refused', host: 'refused', port: 1, user: 'u', password: 'p', database: 'd' })`);
  const slow = await js(`ide.database.addDataSource({ kind: 'postgres', name: 'slow', host: 'slow', port: 2, user: 'u', password: 'p', database: 'd' })`);
  const refused = await js(`ide.database.list().find(s => s.name === 'refused').id`);
  await open('query.sql');
  const sqlPath = await js(`ide.activeTab().path`);
  const resultText = `(document.querySelector('.db-file-results.active .db-error-text')?.textContent || document.querySelector('.db-file-results.active .db-result-status')?.textContent || '')`;
  for (const [name, id, want] of [['refused', refused, /ECONNREFUSED/], ['slow', slow, /connection timeout/]]) {
    await js(`ide.database.sqlFiles.attach(${J(sqlPath)}, ${J(id)})`);
    await setText('SELECT 1;\n');
    await guarded(`SQL file on an unreachable source (${name}): completion`, async () => {
      await js(`(${ED}.setPosition({ lineNumber: 1, column: 8 }), ${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
      await sleep(2500);
      await js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`);
    });
    await guarded(`SQL file on an unreachable source (${name}): Ctrl+Enter twice, typing meanwhile`, async () => {
      await js(`(${ED}.setPosition({ lineNumber: 1, column: 3 }), ${ED}.focus(), true)`);
      await press('Ctrl+Enter');
      await press('Ctrl+Enter');
      await js(`(${ED}.setPosition({ lineNumber: 1, column: 1 }), ${ED}.focus(), true)`);
      await keys('-- ');
      await until(`${want}.test(${resultText})`, `${name}: the error shows`, 20000).catch(() => {});
    });
    check(want.test(await js(resultText)), `${name}: the connection error is shown (${J(await js(resultText))})`);
    check(await text() === '-- SELECT 1;\n', `${name}: the file is as typed (${J(await text())})`);
  }
  // A statement running when its data source goes away (removed in another window: only the settings know).
  await js(`ide.database.sqlFiles.attach(${J(sqlPath)}, ${J(slow)})`);
  await guarded('SQL file: the data source removed during a run', async () => {
    await js(`(${ED}.setPosition({ lineNumber: 2, column: 1 }), ${ED}.focus(), true)`);
    await setText('SELECT 2;\n');
    await press('Ctrl+Enter');
    await sleep(200);
    await js(`ide.api.invoke('db:remove', ${J(slow)}).then(() => (ide.database.sqlFiles.sourceRemoved(${J(slow)}), true))`);
    await sleep(2500);
  });
  check(!(await js(`ide.database.sqlFiles.attachmentOf(${J(sqlPath)})`)), 'the removed source is no longer attached');
  // Attachments to sources that do not exist, and garbage in the setting.
  for (const value of [{ 'query.sql': { source: 'gone' } }, { 'query.sql': null }, { 'query.sql': 'text' }, { 'query.sql': { source: 42 } }, 'text', [1, 2]]) {
    await guarded(`SQL file attachments set to ${J(value)}`, async () => {
      await js(`(ide.settings.set('database.sqlFiles.' + ide.root, ${J(value)}), true)`);
      await js(`(ide.emit('dataSourcesChanged'), true)`);
      await sleep(200);
      await js(`(${ED}.focus(), true)`);
      await press('Ctrl+Enter');
      await sleep(400);
      await press('Escape');
    });
    check((await js(`document.querySelector('#statusSqlSource')?.textContent || ''`)).includes('<No data source>'), `${J(value)}: the widget shows <No data source>`);
  }
  await closeAll();
} catch (err) {
  check(false, `unexpected error: ${err.stack}`);
}
t.close();

// ---------------- Korean ----------------
const k = await launch({ fixture: 'language-support', projectDir: project, name: 'stress-editor-languages-ko', port: 8631, lang: 'ko-KR' });
try {
  await openFile(k, 'deep.xml');
  await k.js(`(ide.editor.focus(), true)`);
  await k.press('Ctrl+Alt+L');
  await k.until(`!document.getElementById('toolingHint')?.classList.contains('hidden')`, 'hint (ko)', 8000).catch(() => {});
  const h = await k.js(`document.getElementById('toolingHint')?.textContent`);
  k.check(h === '서식을 다시 지정할 수 없음: XML 요소가 너무 깊게 중첩되어 있습니다(1번째 줄)', `Korean: the XML depth refusal (${J(h)})`);
  const missing = await missingTranslations(k);
  k.check(missing.length === 0, `Korean: no untranslated strings (${J(missing)})`);
} catch (err) {
  k.check(false, `unexpected error (ko): ${err.message}`);
}
k.close();

if (notes.length) console.log(`NOTE (outside the features under test):\n  ${notes.join('\n  ')}`);
const all = [...t.results, ...k.results];
const errors = [...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((x) => !x.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
