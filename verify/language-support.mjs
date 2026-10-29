// Editing support across languages, in the real app over CDP: languages for .tsx/.jsx/.hpp/.cc/.scss/.less/.rb/.xsd and
// Dockerfile; JSX without errors; Ctrl+Shift+/ block comments; Ctrl+Alt+L through Monaco's formatters (JSON, JS) and
// its hint where there is none (YAML); detected indentation (2-space JS, YAML) and the setting that turns it off;
// keyword and word completion for C, Java without its server, Go and SQL, not in comments; Markdown folding by
// headings and list continuation on Enter; Enter indentation and closing-word outdent in Lua and shell; XML tag
// closing; Java, JavaScript/TypeScript and C/C++ live templates and postfix templates, not in strings; the Live
// Templates page's language list; the new strings in Korean. Ports 9870-9871.
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'language-support', port: 9870 });
const { js, until, press, type, check, sleep, cdp } = t;

const edFor = (name) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.path.endsWith('/${name}') && e.getDomNode()?.isConnected)`;
let ED = 'ide.editor';
async function open(name) {
  await openFile(t, name);
  await until(`!!${edFor(name)}`, `editor for ${name}`);
  ED = edFor(name);
  await js(`(${ED}.focus(), true)`);
}
const lang = () => js(`${ED}.getModel().getLanguageId()`);
const setText = (text, line = 1, col = 1) => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const setEnd = (text) => { const lines = text.split('\n'); return setText(text, lines.length, lines.at(-1).length + 1); };
const text = () => js(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const caret = () => js(`(() => { const p = ${ED}.getPosition(); return [p.lineNumber, p.column]; })()`);
// Characters one at a time, as typed (onDidType sees each); Enter as the key, which reaches Monaco's keybindings.
async function keys(s) {
  for (const ch of s) {
    if (ch === '\n') {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(60);
    } else await type(ch);
  }
  await sleep(100);
}
// The labels of the completion list for `prefix` typed at the end of `start`.
async function completions(start, prefix) {
  await setEnd(start);
  await keys(prefix);
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`!!${ED}.getDomNode().querySelector('.suggest-widget.visible .monaco-list-row') || ${ED}.getDomNode().querySelector('.suggest-widget.visible .message')`, `completion list for ${prefix}`, 8000).catch(() => {});
  await sleep(300);
  const labels = await js(`[...(${ED}.getDomNode().querySelector('.suggest-widget.visible')?.querySelectorAll('.monaco-list-row .label-name') || [])].map(n => n.textContent)`);
  await js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`);
  return labels;
}
// hide: closes the completion list first, so Tab cannot accept an item from it.
async function tabAfter(word, start = '', { hide = false } = {}) {
  await setEnd(start);
  await keys(word);
  await sleep(100);
  if (hide) { await sleep(400); await js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`); }
  await press('Tab');
  await sleep(150);
  return { text: await text(), caret: await caret() };
}
const hint = () => js(`document.getElementById('toolingHint')?.classList.contains('hidden') ? '' : document.getElementById('toolingHint')?.textContent`);

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.languageBasics`), 'language-basics plugin loaded');

  // ---------- languages by file name ----------
  const WANT = { 'App.tsx': 'typescript', 'Btn.jsx': 'javascript', 'util.hpp': 'cpp', 'util.cc': 'cpp', 'style.scss': 'scss', 'theme.less': 'less',
    'tool.rb': 'ruby', 'schema.xsd': 'xml', Dockerfile: 'dockerfile', 'main.go': 'go' };
  for (const [file, want] of Object.entries(WANT)) {
    await open(file);
    const got = await lang();
    check(got === want, `${file} is edited as ${want} (${got})`);
  }

  // ---------- JSX ----------
  await open('App.tsx');
  const markers = (name) => js(`ide.monaco.editor.getModelMarkers({ resource: ${edFor(name)}.getModel().uri }).filter(m => m.owner === 'typescript').map(m => m.code + ': ' + m.message)`);
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri }).some(m => m.owner === 'typescript')`, 'TypeScript checked App.tsx', 30000).catch(() => {});
  let ms = await markers('App.tsx');
  check(ms.length && ms.every((m) => !/17004|JSX/.test(m)), `.tsx: the type error is reported, JSX is not (${J(ms)})`);

  // ---------- block comment ----------
  await open('app.js');
  await setText('a();');
  await js(`(${ED}.setSelection(new ide.monaco.Selection(1, 1, 1, 5)), true)`);
  await press('Ctrl+Shift+/');
  await sleep(150);
  check(await text() === '/* a(); */', `Ctrl+Shift+/ wraps the selection in a block comment (${J(await text())})`);
  await press('Ctrl+Shift+/');
  await sleep(150);
  check(await text() === 'a();', `Ctrl+Shift+/ again removes it (${J(await text())})`);

  // ---------- Reformat Code ----------
  await open('data.json');
  await press('Ctrl+Alt+L');
  await until(`${ED}.getModel().getLineCount() > 2`, 'JSON reformatted', 8000).catch(() => {});
  const json = await text();
  check(json.startsWith('{\n') && json.includes('"a": 1,') && json.includes('"b": ['), `Ctrl+Alt+L formats JSON (${J(json)})`);
  check(/^Reformatted code: \d+ lines? changed$/.test(await hint()), `and says how many lines changed (${J(await hint())})`);
  await open('app.js');
  await setText('function g(){\nreturn 1\n}');
  await press('Ctrl+Alt+L');
  await until(`${ED}.getModel().getValue().includes('    return')`, 'JS reformatted', 8000).catch(() => {});
  check(await text() === 'function g() {\n    return 1\n}', `Ctrl+Alt+L formats JavaScript (${J(await text())})`);
  await open('script.lua');
  await press('Ctrl+Alt+L');
  await sleep(300);
  check(await hint() === 'Reformat Code has no formatter for this file type', `Lua: says there is no formatter (${J(await hint())})`);

  // ---------- indentation ----------
  await open('two.js');
  check(await js(`${ED}.getModel().getOptions().tabSize`) === 2, 'a 2-space JavaScript file is edited with 2 spaces');
  await setText('x {}', 1, 4);
  await keys('\n');
  check(await text() === 'x {\n  \n}', `Enter in braces indents 2 spaces there (${J(await text())})`);
  await open('config.yaml');
  check(await js(`${ED}.getModel().getOptions().tabSize`) === 2, 'YAML without indented lines gets 2 spaces');
  await setEnd('a:');
  await keys('\n');
  check(await text() === 'a:\n  ', `Enter after "a:" indents 2 spaces (${J(await text())})`);
  await js(`(ide.settings.set('editor.detectIndent', false), true)`);
  await sleep(200);
  check(await js(`${edFor('two.js')}?.getModel().getOptions().tabSize ?? ide.getDocument(ide.tabs.find(t => t.path.endsWith('two.js')).path).model.getOptions().tabSize`) === 4, 'with detection off, the tab size setting applies');
  await js(`(ide.settings.set('editor.detectIndent', true), true)`);

  // ---------- keyword and word completion ----------
  await open('main.c');
  let labels = await completions('int counter = 0;\n', 'whi');
  check(labels.includes('while'), `C: "whi" lists the keyword while (${J(labels)})`);
  labels = await completions('int counter = 0;\n', 'cou');
  check(labels.includes('counter'), `C: "cou" lists the file's word counter (${J(labels)})`);
  labels = await completions('int counter = 0;\n// ', 'whi');
  check(!labels.includes('while'), `C: no keywords in a comment (${J(labels)})`);
  await open('Main.java');
  labels = await completions('', 'whi');
  check(labels.includes('while'), `Java without its server: "whi" lists while (${J(labels)})`);
  await open('main.go');
  labels = await completions('package main\n', 'fun');
  check(labels.includes('func'), `Go: "fun" lists func (${J(labels)})`);
  await open('query.sql');
  labels = await completions('', 'SELE');
  check(labels.includes('SELECT'), `SQL file: "SELE" lists SELECT (${J(labels)})`);

  // ---------- Markdown ----------
  await open('notes.md');
  await setText('# A\ntext\n## B\nmore\n\n# C\nend\n```\ncode\n```\n');
  await until(`(async () => { const f = await ${ED}.getContribution('editor.contrib.folding').getFoldingModel(); return f?.regions.length >= 4; })()`, 'Markdown folding regions', 8000).catch(() => {});
  const folds = await js(`(async () => { const f = await ${ED}.getContribution('editor.contrib.folding').getFoldingModel(); const r = f.regions; const out = []; for (let i = 0; i < r.length; i++) out.push([r.getStartLineNumber(i), r.getEndLineNumber(i)]); return out; })()`);
  check(J(folds) === J([[1, 4], [3, 4], [6, 10], [8, 10]]), `headings fold their sections and the code block folds (${J(folds)})`);
  await setEnd('- item');
  await keys('\n');
  check(await text() === '- item\n- ' && J(await caret()) === J([2, 3]), `Enter after "- item" starts the next item (${J(await text())})`);
  await keys('\n');
  check(await text() === '- item\n', `Enter in the empty item ends the list (${J(await text())})`);
  await setEnd('1. one');
  await keys('\n');
  check(await text() === '1. one\n2. ', `numbered items count up (${J(await text())})`);
  await setEnd('  - [x] done');
  await keys('\n');
  check(await text() === '  - [x] done\n  - [ ] ', `task items continue unchecked, indented (${J(await text())})`);
  await setEnd('```\n- in code');
  await keys('\n');
  check(await text() === '```\n- in code\n', `no continuation in a fenced code block (${J(await text())})`);

  // ---------- Lua and shell ----------
  await open('script.lua');
  await setEnd('function f()');
  await keys('\nx()\nend');
  check(await text() === 'function f()\n    x()\nend', `Lua: Enter indents the body, "end" moves back (${J(await text())})`);
  await setEnd('if a then');
  await keys('\n');
  check(await text() === 'if a then\n    ', `Lua: Enter after "then" indents (${J(await text())})`);
  await open('run.sh');
  await setEnd('if [ -f x ]; then');
  await keys('\necho hi\nfi');
  check(await text() === 'if [ -f x ]; then\n    echo hi\nfi', `shell: Enter indents after then, "fi" moves back (${J(await text())})`);
  await setEnd('for f in *; do');
  await keys('\n');
  check(await text() === 'for f in *; do\n    ', `shell: Enter after do indents (${J(await text())})`);

  // ---------- XML tag closing ----------
  await open('pom.xml');
  await setText('');
  await keys('<project>');
  check(await text() === '<project></project>' && J(await caret()) === J([1, 10]), `XML: > adds the end tag (${J(await text())})`);
  await setText('');
  await keys('<br>');
  check(await text() === '<br></br>', `XML has no void elements (${J(await text())})`);
  await setText('<a><b>x', 1, 8);
  await keys('</');
  check(await text() === '<a><b>x</b>', `XML: </ completes the innermost element (${J(await text())})`);
  await setText('');
  await keys('<?xml version="1.0"?>');
  check(await text() === '<?xml version="1.0"?>', `XML: nothing after a processing instruction (${J(await text())})`);

  // ---------- live templates: Java ----------
  await open('Main.java');
  let s = await tabAfter('psvm');
  check(s.text === 'public static void main(String[] args) {\n    \n}' && J(s.caret) === J([2, 5]), `Java: psvm+Tab (${J(s)})`);
  s = await tabAfter('sout');
  check(s.text === 'System.out.println();' && J(s.caret) === J([1, 20]), `Java: sout+Tab, caret in the parentheses (${J(s)})`);
  s = await tabAfter('fori');
  check(s.text === 'for (int i = 0; i < n; i++) {\n    \n}', `Java: fori+Tab (${J(s.text)})`);
  s = await tabAfter('"hi".sout');
  check(s.text === 'System.out.println("hi");', `Java: "hi".sout postfix (${J(s.text)})`);
  s = await tabAfter('items.for');
  check(s.text === 'for (var item : items) {\n    \n}', `Java: items.for postfix (${J(s.text)})`);
  s = await tabAfter('x.nn');
  check(s.text === 'if (x != null) {\n    \n}', `Java: x.nn postfix (${J(s.text)})`);
  s = await tabAfter('sout', 'String s = "');
  check(!s.text.includes('System.out'), `Java: no expansion in a string (${J(s.text)})`);
  labels = await completions('', 'sou');
  check(labels.includes('sout') && labels.includes('souf'), `Java: templates are in the completion list (${J(labels)})`);

  // ---------- live templates: JavaScript / TypeScript ----------
  await open('app.js');
  s = await tabAfter('log');
  check(s.text === 'console.log()' && J(s.caret) === J([1, 13]), `JS: log+Tab (${J(s)})`);
  s = await tabAfter('x.log');
  check(s.text === 'console.log(x)', `JS: x.log postfix (${J(s.text)})`);
  s = await tabAfter('rows.for');
  check(s.text === 'for (const row of rows) {\n    \n}', `JS: rows.for postfix (${J(s.text)})`);
  await open('app.ts');
  s = await tabAfter('iter');
  check(s.text === 'for (const item of items) {\n    \n}', `TS: iter+Tab (${J(s.text)})`);

  // ---------- live templates: C / C++ ----------
  await open('main.c');
  s = await tabAfter('main');
  check(s.text === 'int main() {\n    \n    return 0;\n}' && J(s.caret) === J([2, 5]), `C: main+Tab (${J(s)})`);
  s = await tabAfter('cout');
  check(!s.text.includes('std::cout'), `C: the C++-only cout is not expanded in a .c file (${J(s.text)})`);
  await open('main.cpp');
  s = await tabAfter('cout');
  check(s.text === 'std::cout <<  << std::endl;', `C++: cout+Tab (${J(s.text)})`);
  s = await tabAfter('inc');
  check(s.text === '#include <stdio.h>', `C++: inc+Tab (${J(s.text)})`);

  // ---------- Live Templates page ----------
  await js(`(ide.openSettings('live-templates'), true)`);
  await until(`!!document.querySelector('.lt-lang') && !!document.querySelector('.lt-row[data-abbr="main"]')`, 'Live Templates page');
  const pick = (id) => js(`(() => { const s = document.querySelector('.lt-lang'); s.value = ${J(id)}; s.dispatchEvent(new Event('change')); return true; })()`);
  check(await js(`document.querySelectorAll('.lt-postfix-row').length`) === 14, 'Python is listed first, with its postfix templates');
  await pick('java');
  check(await js(`!!document.querySelector('.lt-row[data-abbr="psvm"]') && !!document.querySelector('.lt-postfix-row[data-key="sout"]')`), 'Java lists psvm and the .sout postfix template');
  await js(`(() => { const c = document.querySelector('.lt-row[data-abbr="sout"] input'); c.click(); return true; })()`);
  await pick('c');
  check(await js(`!!document.querySelector('.lt-row[data-abbr="cout"]')`), 'C and C++ lists cout');
  check(await js(`!document.querySelector('.lt-postfix-row')`), 'C and C++ have no postfix templates listed');
  await js(`(document.getElementById('settingsOk').click(), true)`);
  await sleep(300);
  const custom = await js(`ide.settings.get('liveTemplates.custom')`);
  check(custom?.['java:sout']?.enabled === false && !custom?.sout, `a Java template is switched off under java:sout (${J(custom)})`);
  await open('Main.java');
  s = await tabAfter('sout', '', { hide: true });
  check(!s.text.includes('System.out'), `the switched-off Java template does not expand (${J(s.text)})`);
  s = await tabAfter('serr');
  check(s.text === 'System.err.println();', `other Java templates still do (${J(s.text)})`);
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.close();

// ---------------- Korean ----------------
const k = await launch({ fixture: 'language-support', port: 9871, name: 'language-support-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.openSettings('live-templates'), true)`);
  await k.until(`!!document.querySelector('.lt-lang')`, 'Live Templates page (ko)');
  for (const id of ['java', 'js', 'c']) {
    await k.js(`(() => { const s = document.querySelector('.lt-lang'); s.value = ${J(id)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await k.sleep(100);
  }
  const options = await k.js(`[...document.querySelectorAll('.lt-lang option')].map(o => o.textContent)`);
  k.check(J(options) === J(['Python', 'Java', 'JavaScript 및 TypeScript', 'C 및 C++']), `Korean language list (${J(options)})`);
  await k.js(`(ide.openSettings('codestyle'), true)`);
  await k.until(`!!document.querySelector('.settings-page input[data-key="editor.detectIndent"]')`, 'Code Style page (ko)');
  const label = await k.js(`document.querySelector('.settings-page input[data-key="editor.detectIndent"]').closest('label').textContent`);
  k.check(label === '편집할 때 파일의 기존 들여쓰기를 감지해서 사용', `Korean indent detection label (${J(label)})`);
  const missing = await missingTranslations(k);
  k.check(missing.length === 0, `no untranslated strings (${J(missing)})`);
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
