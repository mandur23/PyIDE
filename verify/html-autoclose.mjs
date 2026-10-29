// HTML tag closing (renderer/features/html-autoclose), typed key by key over CDP into the HTML viewer's editor: `>`
// ending a start tag adds its end tag with the caret between (plain, upper case, attributes, script), one undo step
// removes it; nothing for void elements, `<x/>`, a `>` in an attribute value, a comment, script or style content or
// `<!DOCTYPE`, or when the end tag already follows; `</` completes the innermost open element (also script content,
// past void elements and closed elements), not in comments or with nothing open; several carets; pastes; .xhtml;
// not in plain text; both settings; the Smart Keys page in English and Korean. Ports 9555-9556.
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'html-autoclose', port: 9555 });
const { js, until, press, type, check, sleep } = t;

const edFor = (name) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.path.endsWith('/${name}') && e.getDomNode()?.isConnected)`;
let ED = edFor('index.html');
// Monaco sees every character as typed (onDidType), as from the keyboard.
const keys = async (s) => { for (const ch of s) await type(ch); await sleep(80); };
const setText = (text, line = 1, col = 1) => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const text = () => js(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const caret = () => js(`(() => { const p = ${ED}.getPosition(); return [p.lineNumber, p.column]; })()`);
// Types `typed` into `start` (caret at line, col) and checks the text and the caret.
async function typing(label, start, [line, col], typed, want, wantCaret) {
  await setText(start, line, col);
  await keys(typed);
  const got = await text();
  const pos = await caret();
  const ok = got === want && (!wantCaret || J(pos) === J(wantCaret));
  check(ok, `${label}: ${J(typed)} in ${J(start)} gives ${J(got)}, caret ${J(pos)}${ok ? '' : ` (want ${J(want)}${wantCaret ? `, caret ${J(wantCaret)}` : ''})`}`);
}

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.htmlAutoClose`), 'html-autoclose plugin loaded');
  await openFile(t, 'index.html');
  await until(`!!${ED}`, 'HTML viewer editor');
  check(await js(`${ED}.getModel().getLanguageId()`) === 'html', 'index.html is edited as html');

  // ---------- `>` adds the end tag ----------
  await typing('start tag', '', [1, 1], '<h1>', '<h1></h1>', [1, 5]);
  await press('Ctrl+Z');
  await sleep(100);
  check(await text() === '<h1>' && J(await caret()) === J([1, 5]), `one Ctrl+Z removes only the end tag (${J(await text())}, caret ${J(await caret())})`);
  await press('Ctrl+Z');
  await sleep(100);
  check(!(await text()).includes('>'), `the next Ctrl+Z undoes the typing (${J(await text())})`);
  await typing('upper case', '', [1, 1], '<DIV>', '<DIV></DIV>', [1, 6]);
  await typing('custom element', '', [1, 1], '<my-card>', '<my-card></my-card>', [1, 10]);
  await typing('attributes (the closing quote is overtyped)', '', [1, 1], '<a href="x.html" class="c">', '<a href="x.html" class="c"></a>', [1, 28]);
  await typing('inside an element', '<body>\n\n</body>', [2, 1], '<p>', '<body>\n<p></p>\n</body>', [2, 4]);
  await typing('script start tag', '', [1, 1], '<script>', '<script></script>', [1, 9]);
  await typing('after text on the line', 'Hello ', [1, 7], '<b>', 'Hello <b></b>', [1, 10]);

  // ---------- `>` that adds nothing ----------
  for (const v of ['br', 'img', 'input', 'meta', 'link', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']) {
    await setText('');
    await keys(`<${v}>`);
    const got = await text();
    check(got === `<${v}>`, `void <${v}> gets no end tag (${J(got)})`);
  }
  await typing('void element with attributes', '', [1, 1], '<img src="a.png">', '<img src="a.png">');
  await typing('self-closing', '', [1, 1], '<my-icon/>', '<my-icon/>');
  await typing('self-closing with attributes', '', [1, 1], '<x-y a="1" />', '<x-y a="1" />');
  await typing('> in an attribute value', '', [1, 1], '<a title="1>', '<a title="1>"', [1, 13]);
  await typing('in a comment', '<!--  -->', [1, 6], '<p>', '<!-- <p> -->');
  await typing('in script content', '<script>\n\n</script>', [2, 1], 'a <b>', '<script>\na <b>\n</script>');
  await typing('in style content', '<style>\n\n</style>', [2, 1], '<p>', '<style>\n<p>\n</style>');
  await typing('in a doctype', '<!DOCTYPE html', [1, 15], '>', '<!DOCTYPE html>');
  await typing('end tag already after the caret', '<h1</h1>', [1, 4], '>', '<h1></h1>', [1, 5]);
  await typing('end tag already after the caret (other case)', '<p</P>', [1, 3], '>', '<p></P>', [1, 4]);

  // ---------- `</` completes the end tag ----------
  await typing('innermost open element', '<div><span>a', [1, 13], '</', '<div><span>a</span>', [1, 20]);
  await sleep(700);
  const suggest = await js(`${ED}.getDomNode().querySelector('.suggest-widget.visible')?.textContent ?? null`);
  check(suggest === null, `no completion list left open after </ is completed (${J(suggest)})`);
  await keys('</');
  check(await text() === '<div><span>a</span></div>' && J(await caret()) === J([1, 26]), `again: the next open element (${J(await text())}, caret ${J(await caret())})`);
  await press('Ctrl+Z');
  await sleep(100);
  check(await text() === '<div><span>a</span></', `Ctrl+Z removes only the completed name (${J(await text())})`);
  await typing('past void and closed elements', '<ul>\n  <li><br><img src="x"><b>x</b>\n  ', [3, 3], '</', '<ul>\n  <li><br><img src="x"><b>x</b>\n  </li>');
  await typing('upper case kept', '<DIV>\n', [2, 1], '</', '<DIV>\n</DIV>');
  await typing('in script content', '<script>\nlet a = 1;\n', [3, 1], '</', '<script>\nlet a = 1;\n</script>');
  await typing('nothing open', '<p>x</p>\n', [2, 1], '</', '<p>x</p>\n</');
  await typing('in a comment', '<div><!--  -->', [1, 11], '</', '<div><!-- </ -->');
  await typing('before a name', '<div><p>', [1, 7], '/', '<div></p>');

  // ---------- several carets ----------
  await setText('\n\n');
  await js(`(() => { const e = ${ED}; e.setSelections([1, 2, 3].map(l => new ide.monaco.Selection(l, 1, l, 1))); return true; })()`);
  await keys('<td>');
  const multi = await text();
  const carets = await js(`${ED}.getSelections().map(s => [s.positionLineNumber, s.positionColumn])`);
  check(multi === '<td></td>\n<td></td>\n<td></td>' && J(carets) === J([[1, 5], [2, 5], [3, 5]]),
    `three carets each get an end tag, carets between (${J(multi)}, ${J(carets)})`);
  await press('Ctrl+Z');
  await sleep(100);
  check(await text() === '<td>\n<td>\n<td>', `one Ctrl+Z removes all three end tags (${J(await text())})`);
  await setText('<i></i>');
  await js(`(() => { const e = ${ED}; e.setSelections([new ide.monaco.Selection(1, 1, 1, 1), new ide.monaco.Selection(1, 8, 1, 8)]); return true; })()`);
  await keys('<b>');
  const same = await text();
  const sameCarets = await js(`${ED}.getSelections().map(s => [s.positionLineNumber, s.positionColumn])`);
  check(same === '<b></b><i></i><b></b>' && J(sameCarets) === J([[1, 4], [1, 18]]), `two carets on one line (${J(same)}, ${J(sameCarets)})`);
  await setText('<p>\n<em>');
  await js(`(() => { const e = ${ED}; e.setSelections([new ide.monaco.Selection(1, 4, 1, 4), new ide.monaco.Selection(2, 5, 2, 5)]); return true; })()`);
  await keys('</');
  check(await text() === '<p></p>\n<em></em>', `</ at two carets completes each one's element (${J(await text())})`);

  // ---------- not typed ----------
  await setText('');
  await js(`(${ED}.trigger('keyboard', 'paste', { text: '<h2>' }), true)`);
  await sleep(100);
  check(await text() === '<h2>', `a pasted start tag gets no end tag (${J(await text())})`);

  // ---------- settings ----------
  await js(`(ide.settings.set('editor.htmlCloseTag', false), true)`);
  await typing('Insert closing tag off', '', [1, 1], '<h1>', '<h1>');
  await typing('Insert closing tag off, </ still completes', '<h1>', [1, 5], '</', '<h1></h1>');
  await js(`(ide.settings.set('editor.htmlCloseTag', true), ide.settings.set('editor.htmlCloseOnSlash', false), true)`);
  await typing('Complete on </ off', '<h1>', [1, 5], '</', '<h1></');
  await typing('Complete on </ off, > still closes', '', [1, 1], '<h1>', '<h1></h1>');
  await js(`(ide.settings.set('editor.htmlCloseOnSlash', true), true)`);
  await js(`(ide.openSettings('smart-keys'), true)`);
  await until(`!!document.querySelector('.settings-page input[data-key="editor.htmlCloseTag"]')`, 'Smart Keys page has the HTML options');
  const boxes = await js(`['editor.htmlCloseTag', 'editor.htmlCloseOnSlash', 'editor.autoFString'].map(k => document.querySelector('.settings-page input[data-key="' + k + '"]')?.checked)`);
  check(J(boxes) === J([true, true, true]), `HTML options on by default, next to the f-string option (${J(boxes)})`);
  const legend = await js(`[...document.querySelectorAll('.settings-page legend')].map(n => n.textContent)`);
  check(legend.includes('HTML and XML'), `an HTML and XML section (${J(legend)})`);
  await press('Escape');

  // ---------- other files ----------
  await openFile(t, 'page.xhtml');
  ED = edFor('page.xhtml');
  await until(`!!${ED}`, 'xhtml viewer editor');
  check(await js(`${ED}.getModel().getLanguageId()`) === 'html', '.xhtml is edited as html');
  await typing('.xhtml', '<body>\n\n</body>', [2, 1], '<p>', '<body>\n<p></p>\n</body>', [2, 4]);
  await openFile(t, 'notes.txt');
  ED = 'ide.editor';
  await typing('plain text file', '', [1, 1], '<h1>', '<h1>');
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.close();

// ---------------- Korean ----------------
const k = await launch({ fixture: 'html-autoclose', port: 9556, name: 'html-autoclose-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.openSettings('smart-keys'), true)`);
  await k.until(`!!document.querySelector('.settings-page input[data-key="editor.htmlCloseTag"]')`, 'smart keys page (ko)');
  const labels = await k.js(`['editor.htmlCloseTag', 'editor.htmlCloseOnSlash'].map(k => document.querySelector('.settings-page input[data-key="' + k + '"]').closest('label').textContent)`);
  k.check(J(labels) === J(['>를 입력하면 닫는 태그 삽입', '</를 입력하면 닫는 태그 완성']), `Korean: ${J(labels)}`);
  const missing = (await missingTranslations(k)).filter((s) => /closing tag|end tag|HTML Tag/i.test(s));
  k.check(missing.length === 0, `no untranslated html-autoclose strings (${J(missing)})`);
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
