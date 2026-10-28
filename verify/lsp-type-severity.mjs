// Pyright's type findings show as warnings, as PyCharm's do, and errors stay for code that fails whatever the types
// are. Before, a program that ran fine showed red errors where a library's types are wider than its values:
// BeautifulSoup types a["href"] as str | AttributeValueList and find() as Tag | None, so a["href"].strip() was
// "Cannot access attribute "strip" for class "AttributeValueList"". The stand-in module here has the same shapes. A
// project's own pyrightconfig.json still decides. Port 9786.
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-lsp-type-severity-')), 'project');
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
  '',
  'def find(name: str) -> "Tag | None":',
  '    return Tag()',
  '',
].join('\n'));
writeFileSync(path.join(project, 'main.py'), [
  'from soup import find',
  '',
  'tag = find("a")',
  'print(tag["href"].strip())',
  'print(undefined_name)',
  'import not_installed_package',
  'def broken(:',
  '    pass',
  '',
].join('\n'));

const t = await launch({ name: 'lsp-type-severity', port: 9786, projectDir: project });
const { js, until, check } = t;
const MAIN = path.join(project, 'main.py');
const problems = () => js(`ide.problems.all().filter(p => p.source === 'pyright' && p.path === ${JSON.stringify(MAIN)}).map(p => ({ line: p.line, severity: p.severity, msg: p.msg }))`);
const at = (list, line, re) => list.filter((p) => p.line === line && re.test(p.msg));
try {
  await openFile(t, 'main.py');
  await until(`ide.problems.all().some(p => p.source === 'pyright' && /AttributeValueList/.test(p.msg))`, 'pyright diagnostics', 60000);
  let list = await problems();
  const attr = at(list, 4, /AttributeValueList/);
  const optional = at(list, 4, /None/);
  check(attr.length === 1 && attr[0].severity === 'warning', `an attribute missing from one member of a union is a warning: ${JSON.stringify(attr)}`);
  check(optional.length === 1 && optional[0].severity === 'warning', `subscripting a value that may be None is a warning: ${JSON.stringify(optional)}`);
  check(at(list, 5, /undefined_name/).every((p) => p.severity === 'error') && at(list, 5, /undefined_name/).length === 1, 'an undefined name is an error');
  check(at(list, 6, /not_installed_package/).every((p) => p.severity === 'error') && at(list, 6, /not_installed_package/).length === 1, 'an import that cannot be resolved is an error');
  check(list.some((p) => p.line === 7 && p.severity === 'error'), 'a syntax error is an error');
  check(await js(`monaco.editor.getModelMarkers({ owner: 'pyright' }).some(m => /AttributeValueList/.test(m.message) && m.severity === monaco.MarkerSeverity.Warning)`), 'the editor draws it as a warning squiggle');

  writeFileSync(path.join(project, 'pyrightconfig.json'), JSON.stringify({ reportAttributeAccessIssue: 'error' }));
  await until(`ide.problems.all().some(p => p.source === 'pyright' && /AttributeValueList/.test(p.msg) && p.severity === 'error')`, "the project's pyrightconfig.json applies", 60000);
  list = await problems();
  check(at(list, 4, /AttributeValueList/)[0]?.severity === 'error', "a project's pyrightconfig.json still makes it an error");
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
