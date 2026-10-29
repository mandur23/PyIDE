// Data formats, in the real app over CDP: schema completion and validation for package.json and tsconfig.json (with
// comments) through Monaco's JSON service, .prettierrc read as JSON; GitHub Actions workflow and Docker Compose key and
// value completion, unknown-key and enum warnings, hover; Ctrl+Alt+L for YAML (a messy file normalized exactly, a
// tab-indented one refused untouched) and XML (pretty-printed, comments, CDATA, mixed content and xml:space kept; a
// broken file refused); the strings in Korean. Ports 9878-9879.
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'data-formats', port: 9878 });
const { js, until, press, type, check, sleep } = t;

const edFor = (name) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.path.endsWith('/${name}') && e.getDomNode()?.isConnected)`;
let ED = 'ide.editor';
async function open(name) {
  await openFile(t, name);
  const base = name.split('/').pop();
  await until(`!!${edFor(base)}`, `editor for ${name}`);
  ED = edFor(base);
  await js(`(${ED}.focus(), true)`);
}
const setText = (text, line = 1, col = 1) => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const setEnd = (text) => { const lines = text.split('\n'); return setText(text, lines.length, lines.at(-1).length + 1); };
const text = () => js(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const indent = (n) => js(`(${ED}.getModel().updateOptions({ tabSize: ${n}, indentSize: ${n}, insertSpaces: true }), true)`);
// The completion list for `prefix` typed at the end of `start`: [{label, icon}] (icon: property, enum-member, value…).
async function completions(start, prefix = '') {
  await setEnd(start);
  for (const ch of prefix) await type(ch);
  await sleep(100);
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`!!${ED}.getDomNode().querySelector('.suggest-widget.visible .monaco-list-row') || ${ED}.getDomNode().querySelector('.suggest-widget.visible .message')`, `completion list for ${J(start.slice(-20) + prefix)}`, 10000).catch(() => {});
  await sleep(400);
  const rows = await js(`[...(${ED}.getDomNode().querySelector('.suggest-widget.visible')?.querySelectorAll('.monaco-list-row') || [])].map(r => ({
    label: r.querySelector('.label-name')?.textContent,
    icon: ([...(r.querySelector('.suggest-icon')?.classList || [])].find(c => c.startsWith('codicon-symbol-')) || '').replace('codicon-symbol-', '') }))`);
  return rows;
}
const hideSuggest = () => js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`);
// The list shows only its first rows: the keys offered for each prefix typed, together.
async function keysFor(start, prefixes) {
  const out = [];
  for (const p of prefixes) {
    out.push(...keysOf(await completions(start, p)));
    await hideSuggest();
  }
  return [...new Set(out)];
}
const keysOf = (rows) => rows.filter((r) => r.icon === 'property').map((r) => r.label);
const labelsOf = (rows) => rows.map((r) => r.label);
const markers = (owner) => js(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: ${J(owner)} }).map(m => ({ line: m.startLineNumber, col: m.startColumn, severity: m.severity, message: m.message }))`);
const hint = () => js(`document.getElementById('toolingHint')?.classList.contains('hidden') ? '' : document.getElementById('toolingHint')?.textContent`);
async function hoverAt(line, col) {
  await js(`(() => { const e = ${ED}; e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); e.trigger('t', 'editor.action.showHover', {}); return true; })()`);
  await until(`[...document.querySelectorAll('.monaco-hover')].some(h => h.textContent.trim() && h.getClientRects().length)`, 'hover', 8000).catch(() => {});
  await sleep(200);
  const s = await js(`[...document.querySelectorAll('.monaco-hover')].filter(h => h.getClientRects().length).map(h => h.textContent).join(' | ')`);
  await press('Escape');
  return s;
}
async function reformat(expectChange = true) {
  const before = await text();
  await js(`(document.getElementById('toolingHint')?.classList.add('hidden'), true)`);
  await press('Ctrl+Alt+L');
  if (expectChange) await until(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n') !== ${J(before)}`, 'reformatted', 8000).catch(() => {});
  await until(`!document.getElementById('toolingHint')?.classList.contains('hidden')`, 'Reformat Code hint', 8000).catch(() => {});
  return { text: await text(), hint: await hint() };
}

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.dataFormats?.yaml && !!ide.dataFormats.xml`), 'data-formats plugin loaded');
  await until(`ide.dataFormats.jsonSchemas.size >= 4`, 'JSON schemas registered', 8000).catch(() => {});
  check(await js(`ide.monaco.json.jsonDefaults.diagnosticsOptions.schemas.filter(s => s.uri.startsWith('inmemory://pyide/schemas/')).length`) === 4,
    'four JSON schemas are set on monaco.json.jsonDefaults');

  // ---------- package.json ----------
  await open('package.json');
  let rows = await completions('{\n  "name": "demo",\n  "scr');
  check(labelsOf(rows).includes('scripts'), `package.json: "scr" completes scripts (${J(labelsOf(rows).slice(0, 8))})`);
  await hideSuggest();
  rows = await completions('{\n  "name": "demo",\n  "');
  check(!labelsOf(rows).includes('name') && labelsOf(rows).includes('devDependencies'), `keys already there are not offered (${J(labelsOf(rows).slice(0, 8))})`);
  await hideSuggest();
  await setText('{\n  "name": "demo",\n  "type": "esm"\n}\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'json' }).some(m => m.startLineNumber === 3 && m.severity === 4)`, 'package.json markers', 15000).catch(() => {});
  let ms = await markers('json');
  check(ms.some((m) => m.line === 3 && m.severity === 4 && /commonjs/.test(m.message)), `"type": "esm" is a warning listing commonjs and module (${J(ms)})`);

  // ---------- tsconfig.json ----------
  await open('tsconfig.json');
  await setText('{\n  // TypeScript settings\n  "compilerOptions": {\n    /* output */\n    "target": "es2020",\n    "strict": "yes",\n  },\n}\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'json' }).length > 0`, 'tsconfig markers', 15000).catch(() => {});
  ms = await markers('json');
  check(ms.length === 1 && ms[0].line === 6, `tsconfig: comments, trailing commas and a lowercase target are fine, "strict": "yes" is not (${J(ms)})`);
  rows = await completions('{\n  // settings\n  "compilerOptions": {\n    "target": ');
  check(labelsOf(rows).some((l) => /ES2020/.test(l)) && labelsOf(rows).filter((l) => /"ES/.test(l)).length >= 6, `compilerOptions.target completes its values (${J(labelsOf(rows).slice(0, 6))})`);
  await hideSuggest();
  rows = await completions('{\n  "compilerOptions": {\n    "target": ', '"ESN');
  check(labelsOf(rows).includes('"ESNext"'), `"ESN" completes "ESNext" (${J(labelsOf(rows).slice(0, 6))})`);
  await hideSuggest();
  rows = await completions('{\n  "compilerOptions": {\n    "modu');
  check(labelsOf(rows).includes('module') && labelsOf(rows).includes('moduleResolution'), `compilerOptions keys complete (${J(labelsOf(rows).slice(0, 6))})`);
  await hideSuggest();

  // ---------- .prettierrc ----------
  await open('.prettierrc');
  check(await js(`${ED}.getModel().getLanguageId()`) === 'json', '.prettierrc with JSON content is edited as JSON');
  await setText('{\n  "trailingComma": "sometimes"\n}\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'json' }).length > 0`, '.prettierrc markers', 15000).catch(() => {});
  ms = await markers('json');
  check(ms.some((m) => m.line === 2 && /es5/.test(m.message)), `.prettierrc: an unknown trailingComma value is reported (${J(ms)})`);

  // ---------- GitHub Actions workflow ----------
  await open('.github/workflows/ci.yml');
  rows = await completions('name: CI\n');
  let keys = keysOf(rows);
  check(['on', 'jobs', 'permissions', 'env', 'concurrency'].every((k) => keys.includes(k)) && !keys.includes('name'), `workflow: top-level keys, without the one already there (${J(keys)})`);
  await hideSuggest();
  rows = await completions('name: CI\n', 'jo');
  check(keysOf(rows)[0] === 'jobs', `"jo" lists jobs first (${J(keysOf(rows))})`);
  await hideSuggest();
  const WF = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n';
  rows = await completions(`${WF}      - `);
  keys = keysOf(rows);
  check(['run', 'uses', 'name', 'with', 'shell', 'env'].every((k) => keys.includes(k)) && !keys.includes('runs-on'), `"- " in steps lists the step keys (${J(keys)})`);
  await hideSuggest();
  rows = await completions(`${WF}        `);
  keys = keysOf(rows);
  check(keys.includes('with') && keys.includes('name') && !keys.includes('uses'), `in a step: its other keys, not uses again (${J(keys)})`);
  await hideSuggest();
  keys = await keysFor('on: push\njobs:\n  build:\n    ', ['', 'st', 'tim']);
  check(['runs-on', 'needs', 'steps', 'strategy', 'timeout-minutes'].every((k) => keys.includes(k)), `job keys (${J(keys)})`);
  keys = await keysFor('on:\n  ', ['pu', 'wor', 'sch']);
  check(['push', 'pull_request', 'workflow_dispatch', 'schedule'].every((k) => keys.includes(k)), `events under on (${J(keys)})`);
  rows = await completions('on: push\njobs:\n  build:\n    runs-on: ');
  check(labelsOf(rows).includes('ubuntu-latest') && labelsOf(rows).includes('windows-latest'), `runs-on suggests runner labels (${J(labelsOf(rows).slice(0, 6))})`);
  await hideSuggest();

  // Accepting a key inserts "key: " (or "key:" and a new indented line for mappings and lists).
  await setEnd('on: push\njobs:\n  build:\n    ');
  for (const ch of 'runs-o') await type(ch);
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`[...(${ED}.getDomNode().querySelector('.suggest-widget.visible')?.querySelectorAll('.monaco-list-row .label-name') || [])].some(n => n.textContent === 'runs-on')`, 'runs-on item', 8000).catch(() => {});
  await sleep(200);
  await press('Enter');
  await sleep(300);
  check((await text()).endsWith('    runs-on: '), `accepting runs-on inserts "runs-on: " (${J((await text()).slice(-20))})`);
  await hideSuggest();

  // Validation.
  await setText('name: CI\non: pusj\njobs:\n  build:\n    runs-on: ${{ matrix.os }}\n    foo: 1\n    permissions:\n      contents: maybe\n    steps:\n      - uses: actions/checkout@v4\n        shel: bash\n        run: |\n          foo: not a key\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'data-formats' }).length >= 4`, 'workflow markers', 8000).catch(() => {});
  ms = await markers('data-formats');
  const msg = (line) => ms.find((m) => m.line === line)?.message || '';
  check(ms.every((m) => m.severity === 4), `workflow problems are warnings (${J(ms.map((m) => m.severity))})`);
  check(/^Value "pusj" is not allowed here\. Allowed values: .*push/.test(msg(2)), `an unknown event is reported (${J(msg(2))})`);
  check(msg(6) === 'Unknown key "foo"' && ms.find((m) => m.line === 6)?.col === 5, `an unknown job key is reported at the key (${J(ms.find((m) => m.line === 6))})`);
  check(/^Value "maybe" is not allowed here\. Allowed values: read, write, none$/.test(msg(8)), `a wrong permission level is reported (${J(msg(8))})`);
  check(msg(11) === 'Unknown key "shel"', `an unknown step key is reported (${J(msg(11))})`);
  check(ms.length === 4, `nothing else: not the \${{ }} expression, not the block scalar's text (${J(ms)})`);

  // Hover.
  let h = await hoverAt(5, 6);
  check(h.includes('runs-on') && h.includes('The machine the job runs on'), `hovering runs-on shows its description (${J(h.slice(0, 120))})`);
  h = await hoverAt(10, 12);
  check(h.includes('The action to run'), `hovering uses in a step shows its description (${J(h.slice(0, 120))})`);

  // ---------- Docker Compose ----------
  await open('compose.yaml');
  const C = 'services:\n  web:\n    image: nginx\n';
  rows = await completions(`${C}    restart: `);
  check(J(labelsOf(rows).filter((l) => ['no', 'always', 'on-failure', 'unless-stopped'].includes(l)).sort()) === J(['always', 'no', 'on-failure', 'unless-stopped']),
    `restart: completes its values (${J(labelsOf(rows))})`);
  await hideSuggest();
  await setEnd(`${C}    restart: `);
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`[...(${ED}.getDomNode().querySelector('.suggest-widget.visible')?.querySelectorAll('.monaco-list-row .label-name') || [])].some(n => n.textContent === 'no')`, 'restart values', 8000).catch(() => {});
  await type('no');
  await sleep(400);
  await press('Enter');
  await sleep(300);
  check((await text()).endsWith('restart: "no"'), `accepting no writes it quoted, so YAML does not read false (${J((await text()).slice(-16))})`);
  keys = await keysFor(`${C}    `, ['', 'po', 'vol', 'envi', 'dep', 'res', 'ima']);
  check(['build', 'ports', 'volumes', 'environment', 'depends_on', 'restart'].every((k) => keys.includes(k)) && !keys.includes('image'), `service keys, without image (${J(keys)})`);
  await setText(`${C}    restart: sometimes\n    portz: []\n    x-custom: 1\n  db:\n    restart: on-failure:3\n    depends_on:\n      web:\n        condition: service_healthy\nvolumes:\n  data:\n`);
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'data-formats' }).length >= 2`, 'compose markers', 8000).catch(() => {});
  ms = await markers('data-formats');
  check(ms.length === 2 && /^Value "sometimes" is not allowed here\. Allowed values: no, always, on-failure, unless-stopped$/.test(ms[0]?.message) && ms[1]?.message === 'Unknown key "portz"',
    `compose: a wrong restart value and an unknown key are reported, x- keys and on-failure:3 are fine (${J(ms)})`);
  h = await hoverAt(4, 6);
  check(h.includes('When the container is restarted') && h.includes('unless-stopped'), `hovering restart shows its description and values (${J(h.slice(0, 160))})`);

  // ---------- YAML Reformat Code ----------
  await open('messy.yaml');
  await indent(2);
  let r = await reformat();
  const WANT_YAML = '# Build settings\nname: demo\nversion: 2\nservices:\n  web:\n    image: nginx   # the web server\n    restart: always\n    ports:\n'
    + '      - "80:80"\n      - "443:443"\n    command: |\n      echo "start"   \n        indented line\n      done\n  # the database\n  db:\n    image: postgres\n'
    + '    environment:\n      POSTGRES_PASSWORD: example\nflow: {a: 1,   b: [x, y]}\nquoted: \'it\'\'s:  here\'\nfolded: >-\n  one\n  two\n';
  check(r.text === WANT_YAML, `Ctrl+Alt+L normalizes the YAML: indentation, "key: value", trailing blanks, one final newline; comments, block scalars (and their trailing blanks), flow and quoted values kept (${J(r.text)})`);
  check(/^Reformatted code: \d+ lines changed$/.test(r.hint), `and says how many lines changed (${J(r.hint)})`);
  r = await reformat(false);
  check(r.text === WANT_YAML && r.hint === 'No lines changed: content is already properly formatted', `again: nothing to change (${J(r.hint)})`);
  await indent(4);
  r = await reformat();
  check(r.text.startsWith('# Build settings\nname: demo\nversion: 2\nservices:\n    web:\n        image: nginx') && r.text.includes('        command: |\n            echo "start"   \n'),
    `with 4-space indentation it indents by 4 (${J(r.text.slice(0, 140))})`);
  await open('tabs.yaml');
  const tabs = await text();
  r = await reformat(false);
  check(r.text === tabs && r.text === 'a:\n\tb: 1\n', `a tab-indented YAML file is left as it is (${J(r.text)})`);
  check(r.hint === 'Cannot reformat: line 2 is indented with a tab', `and Reformat Code says why (${J(r.hint)})`);

  // ---------- XML Reformat Code ----------
  await open('data.xml');
  await indent(2);
  r = await reformat();
  const WANT_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- settings -->\n<config version="2">\n  <name>demo</name>\n  <items>\n    <item id="1"/>\n'
    + '    <item  id="2" kind=\'b\'>two</item>\n  </items>\n  <!-- the script -->\n  <script><![CDATA[ if (a < b) { go(); } ]]></script>\n'
    + '  <note>Hello <b>bold</b> text</note>\n  <raw xml:space="preserve">  keep   <x/>  </raw>\n  <empty></empty>\n</config>\n';
  check(r.text === WANT_XML, `Ctrl+Alt+L pretty-prints XML, keeping the declaration, comments, CDATA, attributes, mixed content and xml:space="preserve" (${J(r.text)})`);
  check(/^Reformatted code: \d+ lines changed$/.test(r.hint), `XML: says how many lines changed (${J(r.hint)})`);
  await open('broken.xml');
  r = await reformat(false);
  check(r.text === '<a><b></a>\n' && r.hint === 'Cannot reformat: the XML is not well-formed (line 1)', `a broken XML file is left alone, with the reason (${J(r)})`);
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.close();

// ---------------- Korean ----------------
const k = await launch({ fixture: 'data-formats', port: 9879, name: 'data-formats-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'compose.yaml');
  const KED = edFor('compose.yaml');
  await k.until(`!!${KED}`, 'compose editor (ko)');
  await k.js(`(${KED}.getModel().setValue('services:\\n  web:\\n    restart: sometimes\\n    portz: 1\\n'), true)`);
  await k.until(`ide.monaco.editor.getModelMarkers({ resource: ${KED}.getModel().uri, owner: 'data-formats' }).length >= 2`, 'markers (ko)', 8000).catch(() => {});
  const kms = await k.js(`ide.monaco.editor.getModelMarkers({ resource: ${KED}.getModel().uri, owner: 'data-formats' }).map(m => m.message)`);
  k.check(kms.length === 2 && kms[0].startsWith('여기에는 "sometimes" 값을 쓸 수 없습니다') && kms[1] === '알 수 없는 키 "portz"', `Korean warnings (${J(kms)})`);
  await k.js(`(() => { const e = ${KED}; e.setPosition({ lineNumber: 3, column: 6 }); e.focus(); e.trigger('t', 'editor.action.showHover', {}); return true; })()`);
  await k.until(`[...document.querySelectorAll('.monaco-hover')].some(h => /컨테이너를 다시 시작/.test(h.textContent))`, 'Korean hover', 8000).then(() => true, () => false)
    .then((ok) => k.check(ok, 'Korean hover text'));
  await openFile(k, 'tabs.yaml');
  await k.until(`!!${edFor('tabs.yaml')}`, 'tabs editor (ko)');
  await k.js(`(${edFor('tabs.yaml')}.focus(), true)`);
  await k.press('Ctrl+Alt+L');
  await k.until(`/탭으로 들여쓰기/.test(document.getElementById('toolingHint')?.textContent || '')`, 'Korean refusal', 8000).then(() => true, () => false)
    .then((ok) => k.check(ok, 'Korean Reformat Code refusal'));
  const plugin = await k.js(`tr('Data Formats')`);
  k.check(plugin === '데이터 형식', `Korean plugin name (${J(plugin)})`);
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
