// Prettier and ESLint from the project's own node_modules (renderer/features/js-tools, main/features/js-tools.js), in
// the real app over CDP: Ctrl+Alt+L formats with Prettier and its .prettierrc (semi: false, tabWidth: 4) and
// .prettierignore, as one undo step; a syntax error is the error hint; the setting turns it off (Monaco's formatter
// then) and "on save" formats what is written; ESLint findings (no-unused-vars, prefer-const) as markers and in
// Problems, again after typing, with quick fixes (the rule's fix, suppress for the line, fix all in the file); an
// ESLint that cannot load its configuration is one notification, not one per file; a project without Prettier falls
// back to Monaco's formatter; a project in Safe Mode runs neither; the new strings in Korean.
// The fixture's node_modules hold stand-ins for the two CLIs (CI has no network). JS_TOOLS_LIVE=1 runs the same checks
// once against the real prettier@3 and eslint@9 (JS_TOOLS_PRETTIER / JS_TOOLS_ESLINT pick other versions), installed
// with npm into verify/out/js-tools-live (removed afterwards).
// Ports 9876-9877.
import { execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const APP = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'js-tools');
const LIVE = process.env.JS_TOOLS_LIVE === '1';
const LIVE_DIR = path.join(APP, 'verify', 'out', 'js-tools-live');
const KO = JSON.parse(readFileSync(path.join(APP, 'renderer', 'locales', 'ko.json'), 'utf8'));
const KO_OWN = JSON.parse(readFileSync(path.join(APP, 'renderer', 'features', 'js-tools', 'locales', 'ko.json'), 'utf8'));

const ORIGINAL_MESSY = readFileSync(path.join(FIXTURE, 'src', 'messy.js'), 'utf8').replace(/\r\n/g, '\n');
const PRETTIER_MESSY = 'const greet = (name) => {\n    return "Hello, " + name\n}\nconsole.log(greet("x"))\n';
const withoutModules = (src) => !/[\\/]node_modules([\\/]|$)/.test(path.relative(FIXTURE, src));

// ---------- the projects ----------
let versions = 'stand-ins';
function makeProjects() {
  if (!LIVE) {
    const work = mkdtempSync(path.join(tmpdir(), 'pyide-js-tools-'));
    const trusted = path.join(work, 'project');
    const untrusted = path.join(work, 'downloaded');
    cpSync(FIXTURE, trusted, { recursive: true });
    cpSync(FIXTURE, untrusted, { recursive: true });
    return { trusted, untrusted, plain: path.join(work, 'plain') };
  }
  rmSync(LIVE_DIR, { recursive: true, force: true });
  const trusted = path.join(LIVE_DIR, 'project');
  cpSync(FIXTURE, trusted, { recursive: true, filter: withoutModules });
  // npm's cache stays inside the test folder; no install scripts run.
  execSync(`npm install --no-save --no-package-lock --no-audit --no-fund --ignore-scripts --cache "${path.join(LIVE_DIR, 'npm-cache')}" prettier@${process.env.JS_TOOLS_PRETTIER || 3} eslint@${process.env.JS_TOOLS_ESLINT || 9}`,
    { cwd: trusted, stdio: 'inherit' });
  const v = (name) => JSON.parse(readFileSync(path.join(trusted, 'node_modules', name, 'package.json'), 'utf8')).version;
  versions = `prettier ${v('prettier')}, eslint ${v('eslint')}`;
  const untrusted = path.join(LIVE_DIR, 'downloaded');
  cpSync(trusted, untrusted, { recursive: true });
  return { trusted, untrusted, plain: path.join(LIVE_DIR, 'plain') };
}
const projects = makeProjects();
console.log(`js-tools: ${LIVE ? 'live' : 'stand-in'} run (${versions})`);
// Back to the fixture's sources and configuration (a run edits and saves them).
const restore = (dir) => cpSync(FIXTURE, dir, { recursive: true, force: true, filter: withoutModules });
const callsLog = (dir) => path.join(dir, 'node_modules', '.standin-calls.log');

const allResults = [];
let t;
let ED = 'ide.editor';
const edFor = (name) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.path.endsWith('/${name}') && e.getDomNode()?.isConnected)`;
async function open(rel) {
  await openFile(t, rel);
  const name = rel.split('/').pop();
  await t.until(`!!${edFor(name)}`, `editor for ${name}`);
  ED = edFor(name);
  await t.js(`(${ED}.focus(), true)`);
}
const text = () => t.js(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const setText = (s) => t.js(`(${ED}.getModel().setValue(${J(s)}), ${ED}.focus(), true)`);
const hint = () => t.js(`(() => { const h = document.getElementById('toolingHint'); return h && !h.classList.contains('hidden') ? h.textContent : ''; })()`);
const hintIsError = () => t.js(`document.getElementById('toolingHint')?.classList.contains('error')`);
const clearHint = () => t.js(`(document.getElementById('toolingHint')?.classList.add('hidden'), true)`);
const eslintProblems = (name) => t.js(`ide.problems.all().filter(p => p.source === 'eslint' && p.path.replace(/\\\\/g, '/').endsWith(${J(`/${name}`)}))`);
const lintedAt = (name) => `(() => { const tab = ide.tabs.find(x => x.path.replace(/\\\\/g, '/').endsWith(${J(`/${name}`)})); const s = tab && ide.jsTools.state(tab.path); return !!s && s.version === tab.model.getVersionId(); })()`;

async function reformat() {
  await clearHint();
  await t.js(`(${ED}.focus(), true)`);
  await t.press('Ctrl+Alt+L');
  await t.until(`(() => { const h = document.getElementById('toolingHint'); return h && !h.classList.contains('hidden'); })()`, 'Reformat Code hint', 30000);
}

async function quickFix(line, column, label) {
  await t.js(`(${ED}.focus(), ${ED}.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);
  await t.sleep(400);
  await t.js(`(${ED}.trigger('verify', 'editor.action.quickFix', null), true)`);
  await t.until(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].some(n => n.textContent.includes(${J(label)}))`, `quick fix "${label}"`);
  for (let i = 0; i < 12; i++) {
    if (await t.js(`!!document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent.includes(${J(label)})`)) return t.press('Enter');
    await t.press('ArrowDown');
  }
  throw new Error(`could not focus quick fix "${label}"`);
}
const quickFixLabels = async (line, column) => {
  await t.js(`(${ED}.focus(), ${ED}.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);
  await t.sleep(400);
  await t.js(`(${ED}.trigger('verify', 'editor.action.quickFix', null), true)`);
  await t.until(`document.querySelectorAll('.action-widget .monaco-list-row.action').length > 0`, 'quick fix menu');
  const labels = await t.js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
  await t.press('Escape');
  return labels;
};
const notesTitled = (title) => t.js(`ide.notifications.list().filter(n => n.title === ${J(title)}).length`);

function done(instance) {
  allResults.push(...instance.results);
  if (instance.consoleErrors.length) {
    console.log(`renderer exceptions:\n  ${instance.consoleErrors.join('\n  ')}`);
    allResults.push({ ok: false, label: 'renderer exceptions' });
  }
  instance.close();
}

// ================= trusted project, English =================
t = await launch({ fixture: 'js-tools', port: 9876, name: 'js-tools', projectDir: projects.trusted });
let { check, js, until, sleep, press } = t;
try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.jsTools`), 'js-tools plugin loaded');
  const status = await js(`ide.api.invoke('js-tools:status', ide.util.joinPath(ide.root, 'src', 'messy.js'), ide.root)`);
  check(status.prettier && status.eslint && status.eslintConfig === 'flat', `the project's own Prettier and ESLint are found (${J(status)})`);

  // ---------- Prettier: Reformat Code ----------
  await open('src/messy.js');
  await reformat();
  check(await text() === PRETTIER_MESSY, 'Ctrl+Alt+L formats with the project\'s Prettier, its .prettierrc applied (semi: false, tabWidth: 4)');
  check((await hint()).includes('Reformatted code') && !(await hintIsError()), `the Reformat Code hint says what changed ("${await hint()}")`);
  check(await js(`!!document.querySelector('.tab.active .dirty')`), 'the reformat is a buffer edit (not written to disk)');
  await press('Ctrl+Z');
  check(await text() === ORIGINAL_MESSY, 'Ctrl+Z undoes the Prettier reformat in one step');
  await reformat();
  await reformat();
  check((await hint()).includes('No lines changed'), `formatting a formatted file changes nothing ("${await hint()}")`);

  await open('ignored.js');
  const ignoredBefore = await text();
  await reformat();
  check(await text() === ignoredBefore && (await hint()).includes('No lines changed'), 'a file in .prettierignore is left as it is');

  await open('src/bad.js');
  const badBefore = await text();
  await reformat();
  const badHint = await hint();
  check(await hintIsError() && badHint.includes('Prettier cannot format the file') && badHint.includes('SyntaxError'), `a syntax error shows Prettier's message as an error hint ("${badHint}")`);
  check(await text() === badBefore, 'a file Prettier cannot parse is left unchanged');

  // Turned off: Monaco's own formatter (it keeps the semicolons).
  await open('src/messy.js');
  await setText(ORIGINAL_MESSY);
  await js(`(ide.settings.set('jsTools.prettierOnReformat', false), true)`);
  await reformat();
  const monacoText = await text();
  check(monacoText !== ORIGINAL_MESSY && monacoText.includes('name;') && monacoText !== PRETTIER_MESSY, 'with "Run Prettier on Reformat Code" off, Monaco\'s formatter runs instead');
  await js(`(ide.settings.set('jsTools.prettierOnReformat', true), true)`);

  // On save.
  await setText(ORIGINAL_MESSY);
  await js(`(ide.settings.set('jsTools.prettierOnSave', true), true)`);
  await press('Ctrl+S');
  await until(`!document.querySelector('.tab.active .dirty')`, 'saved');
  await sleep(300);
  const disk = readFileSync(path.join(projects.trusted, 'src', 'messy.js'), 'utf8').replace(/\r\n/g, '\n');
  check(disk === PRETTIER_MESSY && await text() === PRETTIER_MESSY, '"Run Prettier on save" formats the text that is written');
  await js(`(ide.settings.set('jsTools.prettierOnSave', false), true)`);
  await setText(ORIGINAL_MESSY);
  await press('Ctrl+S');
  await until(`!document.querySelector('.tab.active .dirty')`, 'saved again');
  await sleep(300);
  check(readFileSync(path.join(projects.trusted, 'src', 'messy.js'), 'utf8').replace(/\r\n/g, '\n') === ORIGINAL_MESSY, 'with it off (the default) a save writes the text as it is');

  // ---------- ESLint ----------
  await open('src/lint.js');
  await until(`ide.problems.all().some(p => p.source === 'eslint' && p.msg.includes('no-unused-vars'))`, 'ESLint problems for lint.js', 30000);
  let probs = await eslintProblems('lint.js');
  const unused = probs.find((p) => p.msg.includes('(no-unused-vars)'));
  const preferConst = probs.find((p) => p.msg.includes('(prefer-const)'));
  check(unused && unused.severity === 'error' && unused.line === 2 && unused.col === 7 && unused.msg.includes("'unused'"), `no-unused-vars ("error" in eslint.config.mjs) is an error at 2:7 (${J(unused)})`);
  check(preferConst && preferConst.severity === 'warning' && preferConst.line === 1, `prefer-const ("warn") is a warning on line 1 (${J(preferConst)})`);
  const markers = await js(`ide.monaco.editor.getModelMarkers({ owner: 'eslint', resource: ${ED}.getModel().uri }).map(m => ({ s: m.severity, l: m.startLineNumber, c: m.startColumn, e: m.endColumn, msg: m.message }))`);
  const um = markers.find((m) => m.msg.includes('no-unused-vars'));
  check(um && um.s === 8 && um.l === 2 && um.c === 7 && um.e === 13, `the finding is an error marker under 'unused' (${J(um)})`);
  check(markers.some((m) => m.msg.includes('prefer-const') && m.s === 4), 'prefer-const is a warning marker');
  await press('Alt+6');
  await until(`document.querySelector('#problemList')?.textContent.includes('no-unused-vars')`, 'Problems tool window lists ESLint');
  const problemRows = await js(`[...document.querySelectorAll('#problemList .problem')].map(r => r.textContent).filter(s => s.includes('lint.js'))`);
  check(problemRows.some((r) => r.includes('lint.js:2:7') && r.includes('no-unused-vars') && r.includes('eslint')) && problemRows.some((r) => r.includes('prefer-const')), `Problems lists the ESLint findings with their place and rule (${J(problemRows)})`);
  await js(`(${ED}.focus(), true)`);

  // Quick fixes.
  await until(lintedAt('lint.js'), 'lint state current');
  const labels = await quickFixLabels(1, 6);
  check(labels.some((l) => l.includes("Fix with ESLint: 'total' is never reassigned")) && labels.some((l) => l.includes('Suppress prefer-const for line')) && labels.some((l) => l.includes('Fix all ESLint problems in file')),
    `Alt+Enter on an ESLint finding offers its fix, suppressing it and fixing the file (${J(labels)})`);
  await quickFix(1, 6, 'Fix with ESLint');
  await until(`${ED}.getModel().getLineContent(1) === 'const total = 1;'`, 'prefer-const fixed', 8000).catch(() => {});
  check(await js(`${ED}.getModel().getLineContent(1)`) === 'const total = 1;', '"Fix with ESLint" applies the rule\'s fix (let -> const)');
  await until(`!ide.problems.all().some(p => p.source === 'eslint' && p.msg.includes('prefer-const'))`, 'prefer-const gone after the fix', 15000).catch(() => {});
  check(!(await eslintProblems('lint.js')).some((p) => p.msg.includes('prefer-const')), 'ESLint runs again after the edit and the fixed finding goes away');
  await until(lintedAt('lint.js'), 'lint state current again');
  await quickFix(2, 8, 'Suppress no-unused-vars for line');
  await until(`${ED}.getModel().getLineContent(2) === '// eslint-disable-next-line no-unused-vars'`, 'suppress comment', 8000).catch(() => {});
  check(await js(`${ED}.getModel().getLineContent(2)`) === '// eslint-disable-next-line no-unused-vars', 'suppressing writes // eslint-disable-next-line <rule> above the line');
  await until(`!ide.problems.all().some(p => p.source === 'eslint' && p.msg.includes('no-unused-vars'))`, 'no-unused-vars suppressed', 15000).catch(() => {});
  check(!(await eslintProblems('lint.js')).length, 'with the comment, ESLint reports nothing for the file');

  // Typing lints again (after a pause).
  await js(`(${ED}.setPosition({ lineNumber: ${ED}.getModel().getLineCount(), column: 1 }), true)`);
  await t.type('const extra = 3;\n');
  await until(`ide.problems.all().some(p => p.source === 'eslint' && p.msg.includes("'extra'"))`, 'lint after typing', 15000).catch(() => {});
  check((await eslintProblems('lint.js')).some((p) => p.msg.includes("'extra'") && p.msg.includes('no-unused-vars')), 'a new finding shows up after typing, without saving');

  // Fix all in file.
  await setText('let a = 1;\nlet b = 2;\nconsole.log(a, b);\n');
  await until(`${lintedAt('lint.js')} && ide.problems.all().filter(p => p.source === 'eslint' && p.msg.includes('prefer-const')).length === 2`, 'two prefer-const findings', 15000);
  await quickFix(1, 6, 'Fix all ESLint problems in file');
  await until(`${ED}.getModel().getValue().startsWith('const a = 1;')`, 'fix all', 15000).catch(() => {});
  check(await text() === 'const a = 1;\nconst b = 2;\nconsole.log(a, b);\n', '"Fix all ESLint problems in file" applies every fix (--fix-dry-run output)');
  await press('Ctrl+Z');
  check((await text()).startsWith('let a = 1;\nlet b = 2;'), 'fixing the file is one undo step');
  await press('Ctrl+S');

  await open('src/clean.js');
  await until(lintedAt('clean.js'), 'clean.js linted', 30000);
  check(!(await eslintProblems('clean.js')).length, 'a clean file has no ESLint problems');

  // ---------- ESLint cannot load its configuration: one notification ----------
  const configFile = path.join(projects.trusted, 'eslint.config.mjs');
  const goodConfig = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, 'export default [\n  { rules: {\n');
  const title = 'ESLint cannot check files';
  const before = await notesTitled(title);
  for (let i = 0; i < 3; i++) {
    for (const name of ['lint.js', 'clean.js']) await js(`ide.jsTools.lint(ide.tabs.find(x => x.path.replace(/\\\\/g, '/').endsWith(${J(`/${name}`)})))`);
  }
  await open('src/lint.js');
  await t.type('// x\n');
  await sleep(2000);
  const failures = await js(`ide.notifications.list().filter(n => n.title === ${J(title)}).map(n => n.text)`);
  check(failures.length - before === 1, `a broken eslint.config.mjs is one notification for every file and run (${failures.length - before}: ${J(failures.at(-1))})`);
  check(!(await eslintProblems('lint.js')).length && !(await eslintProblems('clean.js')).length, 'its stale findings are cleared meanwhile');
  writeFileSync(configFile, goodConfig);
  await js(`ide.jsTools.lint(ide.activeTab())`);
  await until(`ide.problems.all().some(p => p.source === 'eslint')`, 'ESLint back after the config is fixed', 30000).catch(() => {});
  check((await eslintProblems('lint.js')).length > 0, 'once the configuration loads again, ESLint findings are back');

  // ---------- a project without Prettier or ESLint: Monaco's formatter ----------
  mkdirSync(path.join(projects.plain), { recursive: true });
  writeFileSync(path.join(projects.plain, 'messy.js'), ORIGINAL_MESSY);
  await js(`ide.closeAllTabs(true)`);
  await js(`ide.openProject(${J(projects.plain)})`);
  await until(`ide.root && ide.util.samePath(ide.root, ${J(projects.plain)})`, 'plain project open');
  await open('messy.js');
  check(await js(`ide.api.invoke('js-tools:prettier', 'x', ide.util.joinPath(ide.root, 'messy.js'), ide.root)`) === null, 'the main process finds no Prettier in the project');
  await reformat();
  const plain = await text();
  check(plain !== ORIGINAL_MESSY && plain.includes('name;') && (await hint()).includes('Reformatted code'), 'without Prettier in the project, Ctrl+Alt+L uses Monaco\'s formatter');
  await sleep(1500);
  check(!(await js(`ide.problems.all().some(p => p.source === 'eslint')`)), 'without ESLint in the project, nothing is linted');
  await t.shot('js-tools.png');
} catch (err) {
  check(false, `suite error: ${err.message.split('\n')[0]}`);
} finally {
  done(t);
}

// ================= Korean, trusted and Safe Mode =================
restore(projects.trusted);
rmSync(callsLog(projects.trusted), { force: true });
const userData = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-js-tools-ud-')), 'userdata');
mkdirSync(userData, { recursive: true });
writeFileSync(path.join(userData, 'settings.json'), J({ recentProjects: [{ path: projects.trusted, opened: Date.now() }] }));
t = await launch({ fixture: 'js-tools', port: 9877, name: 'js-tools-ko', lang: 'ko', projectDir: projects.trusted, userData, env: { PYIDE_TRUST_ALL: '' } });
({ check, js, until, sleep, press } = t);
try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js('ide.trusted') === true, 'the project opened before is trusted');
  await open('src/messy.js');
  await reformat();
  check(await text() === PRETTIER_MESSY, 'Korean UI: Ctrl+Alt+L formats with Prettier');
  await open('src/bad.js');
  await reformat();
  check((await hint()).startsWith(KO_OWN['Prettier cannot format the file: {error}'].split('{error}')[0]), `Korean UI: the syntax error hint is Korean ("${await hint()}")`);
  await open('src/lint.js');
  await until(`${lintedAt('lint.js')} && ide.problems.all().some(p => p.source === 'eslint')`, 'lint in Korean', 30000);
  const labels = await quickFixLabels(1, 6);
  check(labels.some((l) => l.includes('ESLint로 수정')) && labels.some((l) => l.includes('파일의 모든 ESLint 문제 수정')), `Korean UI: the quick fixes are Korean (${J(labels)})`);
  await press('Ctrl+Alt+S');
  await until(`!!document.querySelector('.settings-dialog')`, 'settings dialog');
  await js(`(document.querySelector('.settings-nav-row[data-page="js-tools"]').scrollIntoView({ block: 'center' }), true)`);
  await t.click('.settings-nav-row[data-page="js-tools"]');
  await until(`document.querySelector('.settings-page')?.dataset.page === 'js-tools'`, 'Prettier and ESLint page');
  const page = await js(`document.querySelector('.settings-page').textContent`);
  check(page.includes('코드 서식 다시 지정 시 Prettier 실행') && page.includes('저장 시 Prettier 실행') && page.includes('ESLint로 JavaScript 및 TypeScript 파일 검사'), 'Korean UI: Settings › Prettier and ESLint is Korean');
  check(await js(`document.querySelector('[data-key="jsTools.prettierOnReformat"]').checked && !document.querySelector('[data-key="jsTools.prettierOnSave"]').checked && document.querySelector('[data-key="jsTools.eslint"]').checked`),
    'defaults: Prettier on Reformat Code on, on save off, ESLint on');
  await press('Escape');
  const configFile = path.join(projects.trusted, 'eslint.config.mjs');
  const goodConfig = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, 'export default [\n');
  await js(`ide.jsTools.lint(ide.activeTab())`);
  await until(`ide.notifications.list().some(n => n.title === ${J(KO_OWN['ESLint cannot check files'])})`, 'Korean ESLint failure notification', 30000).catch(() => {});
  check(await notesTitled(KO_OWN['ESLint cannot check files']) === 1, 'Korean UI: the ESLint failure notification is Korean');
  writeFileSync(configFile, goodConfig);
  const missing = (await missingTranslations(t)).filter((s) => /eslint|prettier/i.test(s) || s in KO_OWN);
  check(!missing.length, `every new string has Korean (${J(missing)})`);

  // ---------- Safe Mode ----------
  if (!LIVE) check(existsSync(callsLog(projects.trusted)), 'sanity: the stand-ins ran in the trusted project');
  rmSync(callsLog(projects.untrusted), { force: true });
  await js(`ide.closeAllTabs(true)`);
  js(`ide.openProject(${J(projects.untrusted)})`).catch(() => {});
  await until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === ${J(KO['Trust and Open Project?'])})`, 'trust question');
  await js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${J(KO['Preview in Safe Mode'])}).click(), true)`);
  await until(`ide.root && ide.util.samePath(ide.root, ${J(projects.untrusted)}) && ide.trusted === false`, 'opened in Safe Mode');
  await sleep(800);
  await open('src/lint.js');
  await open('src/messy.js');
  await reformat();
  const safe = await text();
  check(safe !== PRETTIER_MESSY && safe.includes('name;'), "Safe Mode: Ctrl+Alt+L does not run the project's Prettier (Monaco's formatter instead)");
  await sleep(2500);
  check(!(await js(`ide.problems.all().some(p => p.source === 'eslint')`)), "Safe Mode: the project's ESLint does not run");
  const refused = await js(`Promise.all([ide.api.invoke('js-tools:prettier', 'x', ide.util.joinPath(ide.root, 'src', 'messy.js'), ide.root), ide.api.invoke('js-tools:eslint', 'x', ide.util.joinPath(ide.root, 'src', 'lint.js'), ide.root)])`);
  check(refused.every((r) => r?.skipped === 'untrusted'), `the main process refuses both in an untrusted project (${J(refused)})`);
  if (!LIVE) check(!existsSync(callsLog(projects.untrusted)), 'Safe Mode: neither CLI was started (the stand-ins log every run)');
} catch (err) {
  check(false, `suite error: ${err.message.split('\n')[0]}`);
} finally {
  done(t);
}

if (LIVE) rmSync(LIVE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const failed = allResults.filter((r) => !r.ok).length;
console.log(`${allResults.length - failed}/${allResults.length} passed (${LIVE ? `live: ${versions}` : 'stand-ins'})`);
process.exit(failed ? 1 : 0);
