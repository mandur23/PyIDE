// Quick fixes for Pyright's type warnings, applied from the Alt+Enter menu on BeautifulSoup's shapes (a stand-in
// module: find() -> Tag | None, tag["href"] -> str | AttributeValueList): assert-not-None before the statement, the
// if-not-None wrap of a one-line statement, assert isinstance with the type read from the hover, str() around a value
// used as text, each one's warning gone after it, and none where a fix would break the code (an elif line, a value
// that may also be None for str()). Port 9788.
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-type-fixes-')), 'project');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'soup.py'), [
  'class AttributeValueList(list[str]):',
  '    pass',
  '',
  '',
  'class Tag:',
  '    def __getitem__(self, key: str) -> "str | AttributeValueList":',
  '        return " /x "',
  '',
  '    def get(self, key: str) -> "str | AttributeValueList | None":',
  '        return " /x "',
  '',
  '',
  'def find(name: str) -> "Tag | None":',
  '    return Tag()',
  '',
].join('\n'));
const MAIN_LINES = [
  'from soup import find',
  '',
  'tag = find("a")',
  'print(tag["href"].strip())',
  'href = tag["href"] if tag else ""',
  'print(href.strip())',
  'item = find("b")',
  'item.get("k")',
  'if False:',
  '    pass',
  'elif find("c")["k"]:',
  '    pass',
  'other = find("d")',
  'print(other.get("k").strip()) if other else None',
  '',
];
writeFileSync(path.join(project, 'main.py'), MAIN_LINES.join('\n'));

const t = await launch({ name: 'type-fixes', port: 9788, projectDir: project });
const { js, until, check, press, sleep } = t;
const S = JSON.stringify;
const MAIN = path.join(project, 'main.py');
const warning = (line, code) => `ide.lsp.diagnostics(${S(MAIN)}).some(d => d.range.start.line === ${line - 1} && d.code === ${S(code)})`;
const lineOf = (text) => js(`ide.editor.getModel().getLinesContent().findIndex(l => l === ${S(text)}) + 1`);

async function fixesAt(line, column) {
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);
  await sleep(400);
  await press('Alt+Enter');
  await until(`document.querySelectorAll('.action-widget .monaco-list-row.action').length > 0`, `quick fix menu on line ${line}`);
  return js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
}
async function choose(label) {
  for (let i = 0; i < 12; i++) {
    if (await js(`!!document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent.includes(${S(label)})`)) { await press('Enter'); return; }
    await press('ArrowDown');
  }
  throw new Error(`could not focus quick fix "${label}"`);
}
const noMenu = async () => { if (await js(`!!document.querySelector('.action-widget')`)) await press('Escape'); };

try {
  await openFile(t, 'main.py');
  await until(`ide.lsp.status() === 'ready' && ${warning(4, 'reportOptionalSubscript')} && ${warning(6, 'reportAttributeAccessIssue')}`, 'Pyright warnings', 60000);

  let titles = await fixesAt(4, 8);
  check(titles.some((s) => s.includes("Add 'assert tag is not None'")) && titles.some((s) => s.includes("Wrap in 'if tag is not None:'")), `a value that may be None gets assert and if fixes: ${S(titles)}`);
  await choose("Add 'assert tag is not None'");
  await until(`ide.editor.getModel().getLineContent(4) === 'assert tag is not None'`, 'assert inserted');
  check(true, 'the assert goes on its own line before the statement');
  await until(`!(${warning(5, 'reportOptionalSubscript')})`, 'the None warning goes', 30000);
  check(true, 'and the None warning goes');

  let line = await lineOf('print(tag["href"].strip())');
  titles = await fixesAt(line, 20);
  check(titles.some((s) => s.includes(`Convert 'tag["href"]' with str()`)), `an attribute that one type lacks gets str() for a str method: ${S(titles)}`);
  await choose('with str()');
  await until(`ide.editor.getModel().getLinesContent().includes('print(str(tag["href"]).strip())')`, 'str() applied');
  check(true, 'str() wraps the value');
  line = await lineOf('print(str(tag["href"]).strip())');
  await until(`!(${warning(line, 'reportAttributeAccessIssue')})`, 'the attribute warning goes', 30000);
  check(true, 'and the attribute warning goes');

  line = await lineOf('print(href.strip())');
  titles = await fixesAt(line, 13);
  check(titles.some((s) => s.includes("Add 'assert isinstance(href, str)'")), `a name gets an isinstance check with the type from the hover: ${S(titles)}`);
  await choose("Add 'assert isinstance(href, str)'");
  await until(`ide.editor.getModel().getLinesContent().includes('assert isinstance(href, str)')`, 'isinstance inserted');
  line = await lineOf('print(href.strip())');
  await until(`!(${warning(line, 'reportAttributeAccessIssue')})`, 'the union warning goes', 30000);
  check(true, 'assert isinstance narrows the value and the warning goes');

  line = await lineOf('item.get("k")');
  titles = await fixesAt(line, 7);
  check(titles.some((s) => s.includes("Wrap in 'if item is not None:'")), `a one-line statement can be wrapped: ${S(titles)}`);
  await choose("Wrap in 'if item is not None:'");
  await until(`ide.editor.getModel().getLinesContent().join('\\n').includes('if item is not None:\\n    item.get("k")')`, 'wrapped');
  check(true, "the statement moves into 'if item is not None:'");

  line = await lineOf('elif find("c")["k"]:');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 7 }), true)`);
  await sleep(400);
  await press('Alt+Enter');
  await sleep(1200);
  titles = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
  check(!titles.some((s) => /assert|Wrap in/.test(s)), `nothing goes before an elif line: ${S(titles)}`);
  await noMenu();

  line = await lineOf('print(other.get("k").strip()) if other else None');
  titles = await fixesAt(line, 22);
  check(!titles.some((s) => s.includes('with str()')), `no str() for a value that may also be None: ${S(titles)}`);
  await noMenu();
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
