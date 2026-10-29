// Emmet (renderer/features/emmet), typed key by key over CDP and expanded with Tab: HTML in the HTML viewer's editor
// (ul>li*3 with its tab stops, div#a.b.c, nav>ul>li.item$*2>a{x}, (header>h1)+main, table>tr*2>td*2, `!`, p>lorem5,
// a known tag in text, an implicit li in a ul, CSS in <style>, undo), nothing for a plain word, in an attribute value or
// in a comment; the completion item with its preview; CSS and SCSS properties (m10, p10-20, w100p, d:f, c#f, fw:b,
// m10!) in a rule and nothing in a selector or comment; JSX with className in a .jsx file, nothing in plain code; the
// setting turns it off; the Smart Keys section in English and Korean. Ports 9872-9873.
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'emmet', port: 9872 });
const { js, until, press, type, check, sleep } = t;

const edFor = (name) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.path.endsWith('/${name}') && e.getDomNode()?.isConnected)`;
let ED = '';
async function use(file) {
  await openFile(t, file);
  ED = edFor(file);
  await until(`!!${ED}`, `editor for ${file}`);
}
// Puts `before` + `after` in the editor with the caret between them.
const setText = (before, after = '') => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
  const m = e.getModel(); m.setValue(${J(before + after)}); e.setPosition(m.getPositionAt(${before.length})); e.focus(); return true; })()`);
const state = () => js(`(() => { const e = ${ED}; const s = e.getSelection();
  return { text: e.getModel().getValue().replace(/\\r\\n/g, '\\n'), sel: [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn],
    snippet: !!e.getContribution('snippetController2').isInSnippet() }; })()`);
const indentUnit = () => js(`(() => { const o = ${ED}.getModel().getOptions(); return o.insertSpaces ? ' '.repeat(o.indentSize || o.tabSize) : '\\t'; })()`);
// Types `typed` between `before` and `after`, one character at a time as from the keyboard, then presses Tab.
async function tabAfter(typed, before = '', after = '') {
  await setText(before, after);
  for (const ch of typed) await type(ch);
  await sleep(250);
  await press('Tab');
  await sleep(250);
  return state();
}
// Expects `want` (with \t standing for one indentation unit) for `typed` + Tab.
async function expands(label, typed, before, after, want, wantSel) {
  const I = await indentUnit();
  const s = await tabAfter(typed, before, after);
  const w = before + want.replace(/\t/g, I) + after;
  const ok = s.text === w && (!wantSel || J(s.sel) === J(wantSel));
  check(ok, `${label}: ${J(typed)} + Tab gives ${J(s.text)}${wantSel ? `, selection ${J(s.sel)}` : ''}${ok ? '' : ` (want ${J(w)}${wantSel ? `, ${J(wantSel)}` : ''})`}`);
  return s;
}
async function staysText(label, typed, before, after = '') {
  const s = await tabAfter(typed, before, after);
  const ok = s.text.startsWith(before + typed) && !s.snippet;
  check(ok, `${label}: ${J(typed)} + Tab does not expand (${J(s.text)})`);
  return s;
}

const B = '<!DOCTYPE html>\n<html>\n<body>\n';
const E = '\n</body>\n</html>\n';
try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.emmet`), 'emmet plugin loaded');
  const ex = (abbr, syntax) => js(`ide.emmet.expand(${J(abbr)}, { syntax: ${J(syntax)} })`);
  check(await ex('ul>li*2', 'html') === '<ul>\n\t<li>${1}</li>\n\t<li>${2}</li>\n</ul>', `ide.emmet.expand gives a snippet (${J(await ex('ul>li*2', 'html'))})`);
  check(await ex('m10-20', 'css') === 'margin: 10px 20px;', `ide.emmet.expand for CSS (${J(await ex('m10-20', 'css'))})`);
  check(await ex('div>', 'html') === null && await ex('m', 'css') === 'margin: $1;' && await ex('zz9', 'css') === null, 'invalid abbreviations give null');
  check(await ex('ul>li.x$$@3*2', 'html') === '<ul>\n\t<li class="x03">${1}</li>\n\t<li class="x04">${2}</li>\n</ul>', `$$@3 numbering (${J(await ex('ul>li.x$$@3*2', 'html'))})`);

  // ---------- HTML ----------
  await use('index.html');
  check(await js(`${ED}.getModel().getLanguageId()`) === 'html', 'index.html is edited as html');
  let s = await expands('list', 'ul>li*3', B, E, '<ul>\n\t<li></li>\n\t<li></li>\n\t<li></li>\n</ul>');
  const I = await indentUnit();
  check(s.snippet && J(s.sel) === J([5, I.length + 5, 5, I.length + 5]), `the caret is in the first item, in snippet mode (${J(s.sel)}, ${s.snippet})`);
  await press('Tab');
  s = await state();
  check(J(s.sel) === J([6, I.length + 5, 6, I.length + 5]), `Tab moves to the second item (${J(s.sel)})`);
  await press('Escape');
  await expands('id and classes', 'div#a.b.c', B, E, '<div id="a" class="b c"></div>', [4, 25, 4, 25]);
  await expands('numbering, text and nesting', 'nav>ul>li.item$*2>a{x}', B, E,
    '<nav>\n\t<ul>\n\t\t<li class="item1"><a href="">x</a></li>\n\t\t<li class="item2"><a href="">x</a></li>\n\t</ul>\n</nav>');
  await expands('group and sibling', '(header>h1)+main', B, E, '<header>\n\t<h1></h1>\n</header>\n<main></main>');
  await expands('table rows and cells', 'table>tr*2>td*2', B, E,
    '<table>\n\t<tr>\n\t\t<td></td>\n\t\t<td></td>\n\t</tr>\n\t<tr>\n\t\t<td></td>\n\t\t<td></td>\n\t</tr>\n</table>');
  s = await expands('boilerplate', '!', '', '',
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>Document</title>\n</head>\n<body>\n\t\n</body>\n</html>');
  check(J(s.sel) === J([6, I.length + 8, 6, I.length + 16]), `"Document" is selected first (${J(s.sel)})`);
  s = await tabAfter('p>lorem5', B, E);
  const lorem = /<p>([^<]*)<\/p>/.exec(s.text)?.[1] || '';
  check(lorem.trim().split(/\s+/).length === 5 && /^Lorem ipsum/.test(lorem), `p>lorem5 writes a paragraph of 5 words (${J(lorem)})`);
  await expands('known tag in text', 'b', `${B}<p>Some `, `</p>${E}`, '<b></b>');
  await staysText('plain word in a paragraph', 'hello', `${B}<p>`, `</p>${E}`);
  await staysText('unknown name with a dot', 'file.txt', `${B}<p>See `, `</p>${E}`);
  await expands('implicit li in a ul', '.item', `${B}<ul>\n`, `\n</ul>${E}`, '<li class="item"></li>');
  await staysText('in an attribute value', 'ul>li', `${B}<a title="`, `"></a>${E}`);
  await staysText('in a comment', 'ul>li', `${B}<!-- `, ` -->${E}`);
  await expands('CSS in <style>', 'm10', '<style>\n.a {\n  ', '\n}\n</style>\n', 'margin: 10px;');
  await staysText('<style> outside a rule', 'm10', '<style>\n', '\n</style>\n');
  // One Ctrl+Z gives the abbreviation back.
  await tabAfter('ul>li', B, E);
  await press('Escape');
  await press('Ctrl+Z');
  await sleep(150);
  s = await state();
  check(s.text === `${B}ul>li${E}`, `Ctrl+Z undoes the expansion (${J(s.text)})`);

  // ---------- completion list ----------
  await setText(B, E);
  for (const ch of 'ul>li*2') await type(ch);
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  const rows = `[...${ED}.getDomNode().querySelectorAll('.suggest-widget.visible .monaco-list-row')]`;
  try {
    await until(`${rows}.some(r => r.querySelector('.label-name')?.textContent === 'ul>li*2')`, 'the abbreviation in the completion list', 8000);
    check(true, 'the abbreviation is offered in the completion list');
  } catch { check(false, `the abbreviation is offered in the completion list (${J(await js(`${rows}.map(r => r.textContent)`))})`); }
  if (!(await js(`!!document.querySelector('.suggest-widget.visible .suggest-details-container .suggest-details:not([style*="display: none"]) .docs')`))) {
    await js(`(${ED}.trigger('t', 'toggleSuggestionDetails', {}), true)`);
  }
  try {
    await until(`[...document.querySelectorAll('.suggest-details')].some(d => d.textContent.includes('<li></li>'))`, 'preview', 5000);
    check(true, 'the completion item shows a preview of the expansion');
  } catch { check(false, 'the completion item shows a preview of the expansion'); }
  await press('Enter');
  await sleep(200);
  s = await state();
  check(s.text === `${B}<ul>\n${I}<li></li>\n${I}<li></li>\n</ul>${E}`, `picking it expands the abbreviation (${J(s.text)})`);
  await setText(`${B}<p>`, `</p>${E}`);
  await type('hello');
  await sleep(600);
  const shown = await js(`${rows}.map(r => r.querySelector('.label-name')?.textContent)`);
  check(!shown.includes('hello'), `a plain word is not offered while typing (${J(shown)})`);

  // ---------- CSS ----------
  await use('style.css');
  const RULE = '.a {\n  ';
  const END = '\n}\n';
  for (const [abbr, want] of [['m10', 'margin: 10px;'], ['p10-20', 'padding: 10px 20px;'], ['w100p', 'width: 100%;'], ['d:f', 'display: flex;'],
    ['c#f', 'color: #fff;'], ['fw:b', 'font-weight: bold;'], ['m10!', 'margin: 10px !important;']]) {
    await expands(`CSS ${abbr}`, abbr, RULE, END, want);
  }
  await expands('CSS after a declaration', 'ta:c', '.a {\n  color: red;\n  ', END, 'text-align: center;');
  await staysText('CSS selector at the top level', 'p10', '.a {}\n', '');
  await staysText('CSS selector before a rule', 'm10', '', ' {\n}\n');
  await staysText('CSS comment', 'm10', '.a {\n  /* ', ' */\n}\n');
  await staysText('CSS value', 'm10', '.a {\n  color: ', ';\n}\n');
  await use('theme.scss');
  await expands('SCSS nested rule', 'm10', '.a {\n  .b {\n    ', '\n  }\n}\n', 'margin: 10px;');
  await staysText('SCSS line comment', 'm10', '.a {\n  // ', '\n}\n');

  // ---------- JSX ----------
  await use('App.jsx');
  const JI = await indentUnit();
  await expands('JSX after return (', 'div.card>p', 'export function App() {\n  return (\n    ', '\n  );\n}\n',
    `<div className="card">\n    ${JI}<p></p>\n    </div>`.replace(/\t/g, JI));
  await expands('JSX child of a tag', 'label[for=x]+br', 'export function App() {\n  return (\n    <div>\n      ', '\n    </div>\n  );\n}\n',
    '<label htmlFor="x"></label><br />');
  await staysText('JSX: not in plain code', 'b', 'export function App() {\n  const a = ', ';\n}\n');
  await staysText('JSX: not in a string', 'ul>li', "export function App() {\n  const a = '", "';\n}\n");

  // ---------- setting ----------
  await js(`(ide.settings.set('editor.emmet', false), true)`);
  await staysText('setting off (JSX)', 'div.card', 'export function App() {\n  return (\n    ', '\n  );\n}\n');
  await use('style.css');
  await staysText('setting off (CSS)', 'm10', RULE, END);
  await use('index.html');
  await staysText('setting off (HTML)', 'ul>li', B, E);
  await js(`(ide.settings.set('editor.emmet', true), true)`);
  await expands('setting back on', 'ul>li', B, E, '<ul>\n\t<li></li>\n</ul>');
  await js(`(ide.openSettings('smart-keys'), true)`);
  await until(`!!document.querySelector('.settings-page input[data-key="editor.emmet"]')`, 'Smart Keys page has the Emmet option');
  check(await js(`document.querySelector('.settings-page input[data-key="editor.emmet"]').checked`) === true, 'Emmet is on by default');
  const legends = await js(`[...document.querySelectorAll('.settings-page legend')].map(n => n.textContent)`);
  check(legends.includes('Emmet'), `an Emmet section (${J(legends)})`);
  await press('Escape');
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.close();

// ---------------- Korean ----------------
const k = await launch({ fixture: 'emmet', port: 9873, name: 'emmet-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await openFile(k, 'style.css');
  ED = edFor('style.css');
  await k.until(`!!${ED}`, 'style.css editor (ko)');
  await k.js(`(() => { const e = ${ED}; const m = e.getModel(); m.setValue('.a {\\n  \\n}'); e.setPosition({ lineNumber: 2, column: 3 }); e.focus(); return true; })()`);
  for (const ch of 'm10') await k.type(ch);
  await k.js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await k.until(`[...${ED}.getDomNode().querySelectorAll('.suggest-widget.visible .monaco-list-row')].some(r => r.textContent.includes('m10'))`, 'completion item (ko)', 8000).catch(() => {});
  const desc = await k.js(`[...${ED}.getDomNode().querySelectorAll('.suggest-widget.visible .monaco-list-row')].map(r => r.textContent).find(x => x.includes('m10')) || ''`);
  k.check(desc.includes('Emmet 약어'), `Korean completion item (${J(desc)})`);
  await k.js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`);
  await k.js(`(ide.openSettings('smart-keys'), true)`);
  await k.until(`!!document.querySelector('.settings-page input[data-key="editor.emmet"]')`, 'smart keys page (ko)');
  const label = await k.js(`document.querySelector('.settings-page input[data-key="editor.emmet"]').closest('label').textContent`);
  k.check(label === 'Tab으로 Emmet 약어 펼치기', `Korean: ${J(label)}`);
  const note = await k.js(`[...document.querySelectorAll('.settings-page .settings-note')].map(n => n.textContent).find(x => x.includes('ul>li*3')) || ''`);
  k.check(/[가-힣]/.test(note), `Korean note (${J(note)})`);
  const missing = (await missingTranslations(k)).filter((s) => /emmet|abbreviation|ul>li/i.test(s));
  k.check(missing.length === 0, `no untranslated Emmet strings (${J(missing)})`);
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
