// Java code insight through the Eclipse JDT Language Server: the Korean status item and the download offer while it
// is not installed, its install from the offer (a local server hands out the real pinned archive, cached in
// verify/out/downloads-cache), then on a plain project (src as the source root) and a Maven project: completion, a
// live error on a broken line in the editor and Problems, Go to Declaration (into the project and into a JDK class),
// hover documentation, Optimize Imports, the import progress, the workspace kept under user data, and the server
// stopped with the project. Needs a JDK 21 or later on this computer; without one, or offline without the cached
// archive, it says SKIP and passes.
import { createHash } from 'crypto';
import http from 'http';
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile, tempDir, processSnapshot, descendants } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = JSON.stringify;
const ARCHIVE_NAME = 'jdt-language-server-1.63.0-202610191322.tar.gz';
const ARCHIVE_URL = `https://download.eclipse.org/jdtls/milestones/1.63.0/${ARCHIVE_NAME}`;
const SHA256 = 'b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4';
const cache = path.join(APP, 'verify', 'out', 'downloads-cache');
const archive = path.join(cache, ARCHIVE_NAME);

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (!existsSync(archive) || sha(archive) !== SHA256) {
  mkdirSync(cache, { recursive: true });
  try {
    const r = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
    if (sha(archive) !== SHA256) throw new Error('checksum mismatch');
  } catch (err) {
    console.log(`SKIP java-lsp: the Eclipse JDT Language Server archive is not cached and cannot be downloaded (${err.message})`);
    process.exit(0);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-length': statSync(archive).size });
  createReadStream(archive).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const work = tempDir('java-lsp');
const feed = path.join(work, 'toolchains.json');
writeFileSync(feed, q({ jdtls: { url: `http://127.0.0.1:${server.address().port}/${ARCHIVE_NAME}`, size: statSync(archive).size, sha256: SHA256 } }));
const env = { PYIDE_INSTALL_ROOT: path.join(work, 'root'), PYIDE_TOOLCHAINS: feed };
const project = (name) => {
  const dir = path.join(work, name);
  cpSync(path.join(APP, 'verify', 'fixtures', 'java-lsp', name), dir, { recursive: true });
  return dir;
};
const plain = project('plain');
const maven = project('maven');

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const statusOf = (t) => t.js(`(() => { const s = document.querySelector('#javaLspStatus'); return s ? { text: s.textContent, state: s.dataset.state, hidden: s.classList.contains('hidden'), title: s.title } : null; })()`);
const READY = `document.querySelector('#javaLspStatus')?.dataset.state === 'ready'`;
const errorsOn = (t, line) => t.js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).filter((m) => m.startLineNumber === ${line} && m.severity === ide.monaco.MarkerSeverity.Error).map((m) => m.message)`);
const lineOf = (t, needle) => t.js(`ide.editor.getModel().getLinesContent().findIndex((l) => l.includes(${q(needle)})) + 1`);
// Puts the caret inside `word` on the first line that has `needle` (the word itself when omitted).
async function caretAt(t, needle, word = needle, offset = 1) {
  const line = await lineOf(t, needle);
  const col = await t.js(`ide.editor.getModel().getLineContent(${line}).indexOf(${q(word)}) + 1 + ${offset}`);
  await t.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), true)`);
  return line;
}
const suggestions = (t) => t.js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].map((n) => n.textContent)`);
const hoverText = (t) => t.js(`[...document.querySelectorAll('.monaco-hover:not(.hidden) .monaco-hover-content')].map((n) => n.textContent).join(' ')`);
// The JDT LS processes this instance started.
const jdtlsPids = (t) => descendants(processSnapshot(), t.pid, { since: t.spawnedAt })
  .filter((r) => /org\.eclipse\.jdt\.ls\.core/.test(r.cmd || '')).map((r) => r.pid);
// Types `text` on a new line inserted above `line`, indented like it.
async function typeLineAbove(t, line, text) {
  await t.js(`(() => { const m = ide.editor.getModel(); const indent = /^\\s*/.exec(m.getLineContent(${line}))[0]; m.pushEditOperations([], [{ range: new ide.monaco.Range(${line}, 1, ${line}, 1), text: indent + '\\n' }], () => null); ide.editor.focus(); ide.editor.setPosition({ lineNumber: ${line}, column: indent.length + 1 }); return true; })()`);
  await t.type(text);
}

let k;
let a;
try {
  // ---------- Korean, before the server is installed ----------
  k = await launch({ fixture: 'core', port: 9791, name: 'java-lsp-ko', lang: 'ko-KR', projectDir: plain, env });
  const jdks = await k.js(`ide.toolchains.list('jdk').then((l) => l.map((t) => t.version))`);
  if (!jdks.some((v) => parseInt(String(v).replace(/^1\./, ''), 10) >= 21)) {
    console.log(`SKIP java-lsp: no JDK 21 or later on this computer (found ${jdks.join(', ') || 'none'})`);
    k.close();
    server.close();
    process.exit(0);
  }
  await openFile(k, 'src/app/Main.java');
  await k.until(`document.querySelector('#javaLspStatus')?.dataset.state === 'missing'`, 'not installed', 30000);
  const missing = await statusOf(k);
  check(missing.text === 'Java: 설치되지 않음' && !missing.hidden, `status item reads "Java: 설치되지 않음" (${missing.text})`);
  check(missing.title.includes('Eclipse JDT Language Server가 설치되어 있지 않습니다'), `its tooltip says how to get it in Korean (${missing.title})`);
  await k.until(`[...document.querySelectorAll('.ide-balloon')].some((b) => b.textContent.includes('Java 코드 인사이트'))`, 'download offer');
  const offerText = await k.js(`[...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes('Java 코드 인사이트')).textContent`);
  check(offerText.includes('Eclipse JDT Language Server(약 50MB)가 필요합니다') && offerText.includes('다운로드'), `the offer is Korean (${offerText})`);
  const leaks = await englishLeaks(k, '#javaLspStatus, .ide-balloon');
  check(!leaks.length, `no English in the status item or the offer (${q(leaks)})`);
  await k.js(`([...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes('Java 코드 인사이트')).querySelector('.ide-balloon-action').click(), true)`);
  await k.until(`ide.installer.state('toolchain:jdtls')?.phase === 'installed' || ide.installer.state('toolchain:jdtls')?.phase === 'failed'`, 'install from the offer', 120000);
  check(await k.js(`ide.installer.state('toolchain:jdtls').phase`) === 'installed' && existsSync(path.join(work, 'root', 'jdtls', 'jdtls-1.63.0', 'config_win', 'config.ini')),
    'Download installs the pinned server from the offer under <install root>\\jdtls');
  await k.until(READY, 'ready after the install', 180000);
  const ready = await statusOf(k);
  check(ready.text === 'Java: 준비됨', `the server starts by itself after the install: "Java: 준비됨" (${ready.text})`);
  const missingKo = await missingTranslations(k);
  check(!missingKo.length, `every string shown has a Korean entry (${q(missingKo)})`);
  check(!k.consoleErrors.length, `no renderer exceptions (ko) ${k.consoleErrors}`);
  k.close();
  k = null;

  // ---------- plain project ----------
  a = await launch({ fixture: 'core', port: 9790, name: 'java-lsp', projectDir: plain, env });
  await openFile(a, 'src/app/Main.java');
  await a.until(READY, 'JDT LS ready (plain project)', 180000);
  check((await statusOf(a)).text === 'Java: ready', 'status item reads "Java: ready"');
  check(!existsSync(path.join(plain, '.project')) && !existsSync(path.join(plain, '.classpath')) && !existsSync(path.join(plain, 'bin')),
    'no Eclipse files are written into the project');
  const dataRoot = path.join(a.userData, 'java-lsp');
  const dataDirs = existsSync(dataRoot) ? readdirSync(dataRoot) : [];
  check(dataDirs.some((d) => d.startsWith('plain-') && existsSync(path.join(dataRoot, d, 'workspace'))), `its workspace is kept per project under user data (${dataDirs})`);
  const original = await a.js(`ide.editor.getModel().getValue()`);

  // Completion after `helper.`
  await typeLineAbove(a, await lineOf(a, 'System.out.println(text)'), 'helper.');
  await a.until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].some((n) => n.textContent === 'greet')`, 'completion lists greet', 30000);
  const listed = await suggestions(a);
  check(listed.indexOf('greet') >= 0 && !listed.slice(0, listed.indexOf('greet')).includes('cast'), `completion after "helper." offers the project's own method greet, before the postfix templates (${listed.slice(0, 8)})`);
  await a.press('Escape');
  await a.type('par');
  await a.until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].some((n) => n.textContent === 'par')`, 'postfix template listed', 30000);
  await a.press('Enter');
  await a.until(`ide.editor.getModel().getValue().includes('(helper)')`, 'postfix applied', 10000).catch(() => {});
  const postfixLine = await a.js(`ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber).trim()`);
  check(postfixLine === '(helper)', `the postfix template helper.par gives (helper) (${postfixLine})`);
  await a.js(`(ide.editor.getModel().setValue(${q(original)}), true)`);

  // A live error on a broken line.
  await a.until(`!ide.problems.all().some((p) => p.source === 'java' && p.severity === 'error')`, 'no errors before the broken line', 60000);
  const printLine = await lineOf(a, 'System.out.println(text)');
  await typeLineAbove(a, printLine, 'int broken = "text";');
  await a.until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).some((m) => m.startLineNumber === ${printLine} && m.severity === ide.monaco.MarkerSeverity.Error && /String/.test(m.message))`, 'error marker on the broken line', 60000);
  const err = (await errorsOn(a, printLine))[0];
  check(/String|int/.test(err || ''), `the broken line is marked as an error while typing, before any build (${err})`);
  check(await a.js(`ide.problems.all().some((p) => p.source === 'java' && p.line === ${printLine} && p.severity === 'error')`), 'the error is listed in Problems (source java)');
  await a.js(`(ide.editor.getModel().setValue(${q(original)}), true)`);
  await a.until(`!ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).some((m) => m.severity === ide.monaco.MarkerSeverity.Error)`, 'error gone after the fix', 60000);
  check(true, 'the error goes away when the line is fixed');
  const unused = await a.js(`ide.problems.all().filter((p) => p.source === 'java' && /never used/.test(p.msg)).map((p) => p.line)`);
  check(unused.length === 2, `the unused imports are warnings (lines ${unused})`);

  // Hover documentation.
  await caretAt(a, 'helper.greet', 'greet');
  await a.press('Ctrl+Q');
  await a.until(`[...document.querySelectorAll('.monaco-hover .monaco-hover-content')].some((n) => n.textContent.includes('Greets someone by name'))`, 'hover shows the Javadoc', 30000);
  const hover = await hoverText(a);
  check(hover.includes('String app.Helper.greet(String name)') && hover.includes('Greets someone by name'), `Ctrl+Q shows the signature and the Javadoc (${hover.slice(0, 120)})`);
  await a.press('Escape');

  // Go to Declaration into another project file.
  await caretAt(a, 'helper.greet', 'greet');
  await a.press('Ctrl+B');
  await a.until(`ide.activeTab()?.title === 'Helper.java'`, 'Helper.java opened', 30000);
  const at = await a.js(`(() => { const p = ide.editor.getPosition(); return { line: p.lineNumber, text: ide.editor.getModel().getLineContent(p.lineNumber) }; })()`);
  check(at.text.includes('public String greet(String name)'), `Ctrl+B on greet opens Helper.java at its declaration (line ${at.line}: ${at.text.trim()})`);

  // Go to Declaration into a JDK class (jdt://), shown read-only.
  await openFile(a, 'src/app/Main.java');
  await caretAt(a, 'String text', 'String');
  await a.press('Ctrl+B');
  // String.java when the JDK has its sources (src.zip), String.class otherwise.
  await a.until(`['String.java', 'String.class'].includes(ide.activeTab()?.title)`, 'String opened', 60000);
  const jdk = await a.js(`(() => { const t = ide.activeTab(); const m = t.editor?.getModel(); return { readOnly: t.editor?.getOption(ide.monaco.editor.EditorOption.readOnly), line: m?.getLineContent(t.editor.getPosition().lineNumber) || '' }; })()`);
  check(jdk.readOnly === true && /class String\b/.test(jdk.line), `Ctrl+B on String opens the JDK class read-only at its declaration (${jdk.readOnly}: ${jdk.line.trim()})`);
  await a.js(`ide.closeTab(ide.activeTab().path, true)`);

  // Optimize Imports (Ctrl+Alt+O) removes the unused ones.
  await openFile(a, 'src/app/Main.java');
  await a.js(`(ide.editor.focus(), true)`);
  await a.press('Ctrl+Alt+O');
  await a.until(`!ide.editor.getModel().getValue().includes('import java.util')`, 'imports removed', 30000);
  check(!(await a.js(`ide.editor.getModel().getValue()`)).includes('import java.util.List'), 'Ctrl+Alt+O removes the unused imports');

  // Reformat Code (Ctrl+Alt+L) fixes a badly indented line.
  const badLine = await lineOf(a, 'System.out.println(text)');
  await a.js(`(ide.editor.getModel().pushEditOperations([], [{ range: new ide.monaco.Range(${badLine}, 1, ${badLine}, 9), text: '   ' }], () => null), ide.editor.focus(), true)`);
  await a.press('Ctrl+Alt+L');
  await a.until(`ide.editor.getModel().getLineContent(${badLine}) === '        System.out.println(text);'`, 'line reformatted', 30000)
    .catch(() => {});
  check(await a.js(`ide.editor.getModel().getLineContent(${badLine})`) === '        System.out.println(text);', 'Ctrl+Alt+L reindents a badly indented line');

  // Find Usages (Alt+F7) lists the call in Main.java.
  await openFile(a, 'src/app/Helper.java');
  await caretAt(a, 'public String greet', 'greet');
  await a.press('Alt+F7');
  await a.until(`document.querySelectorAll('#lspFindList .lsp-find-row').length > 0`, 'usages listed', 30000);
  check(await a.js(`[...document.querySelectorAll('#lspFindList .lsp-find-row')].some((r) => r.dataset.path.endsWith('Main.java'))`), 'Alt+F7 on greet finds its call in Main.java');

  // Shift+F6 on the class renames its uses and its file.
  await a.js(`ide.saveAll()`);
  await caretAt(a, 'public class Helper', 'Helper');
  await a.press('Shift+F6');
  await a.until(`document.activeElement?.closest('.rename-box') && document.activeElement.value === 'Helper'`, 'rename box with the class name');
  await a.js(`(document.activeElement.select(), true)`);
  await a.type('Greeter');
  await a.press('Enter');
  await a.until(`ide.tabs.some((t) => t.title === 'Greeter.java')`, 'Greeter.java open', 30000)
    .catch(async (err) => { throw new Error(`${err.message} ${q(await a.js(`({ tabs: ide.tabs.map((t) => t.title), active: document.activeElement?.className, value: document.activeElement?.value })`))}`); });
  await a.js(`ide.saveAll()`);
  const mainText = readFileSync(path.join(plain, 'src', 'app', 'Main.java'), 'utf8');
  check(existsSync(path.join(plain, 'src', 'app', 'Greeter.java')) && !existsSync(path.join(plain, 'src', 'app', 'Helper.java'))
    && readFileSync(path.join(plain, 'src', 'app', 'Greeter.java'), 'utf8').includes('public class Greeter') && mainText.includes('Greeter helper = new Greeter()'),
  'Shift+F6 on a class renames it, its file and its uses');
  await a.until(`!ide.problems.all().some((p) => p.source === 'java' && p.severity === 'error')`, 'no errors after the rename', 60000);
  check(true, 'the renamed project has no errors');

  // ---------- Maven project ----------
  await a.js(`ide.saveAll()`);
  await a.js(`(window.__javaStates = [], new MutationObserver(() => __javaStates.push(document.querySelector('#javaLspStatus').textContent)).observe(document.querySelector('#javaLspStatus'), { childList: true, characterData: true, subtree: true }), true)`);
  await a.js(`ide.openProject(${q(maven)})`);
  await a.until(`ide.root?.toLowerCase() === ${q(maven.toLowerCase())}`, 'Maven project opened');
  await a.until(READY, 'JDT LS ready (Maven project)', 300000);
  const states = await a.js('window.__javaStates');
  check(states.some((s) => /^Java: starting \d+%$/.test(s)), `the status item shows the import's progress (${[...new Set(states)].slice(0, 6)})`);
  check(!existsSync(path.join(maven, '.project')) && !existsSync(path.join(maven, '.classpath')) && !existsSync(path.join(maven, '.settings')),
    'the Maven import writes no Eclipse files into the project');
  await openFile(a, 'src/main/java/demo/App.java');
  const app = await a.js(`ide.editor.getModel().getValue()`);
  await typeLineAbove(a, await lineOf(a, 'System.out.println(out)'), 'out.');
  await a.until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].some((n) => n.textContent === 'append')`, 'completion lists append', 60000);
  check((await suggestions(a)).includes('append'), 'completion in the Maven project offers StringBuilder.append');
  await a.press('Escape');
  await a.js(`(ide.editor.getModel().setValue(${q(app)}), true)`);
  const mvnPrint = await lineOf(a, 'System.out.println(out)');
  await typeLineAbove(a, mvnPrint, 'Util.missing();');
  await a.until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).some((m) => m.startLineNumber === ${mvnPrint} && m.severity === ide.monaco.MarkerSeverity.Error)`, 'Maven error marker', 60000);
  check(await a.js(`ide.problems.all().some((p) => p.source === 'java' && p.line === ${mvnPrint} && /missing/.test(p.msg))`), 'a call to a method that does not exist is an error in the Maven project');
  await a.js(`(ide.editor.getModel().setValue(${q(app)}), true)`);
  await caretAt(a, 'Util.twice', 'twice');
  await a.press('Ctrl+Q');
  await a.until(`[...document.querySelectorAll('.monaco-hover .monaco-hover-content')].some((n) => n.textContent.includes('Doubles a number'))`, 'Maven hover', 30000);
  check((await hoverText(a)).includes('int demo.Util.twice(int n)'), 'hover in the Maven project shows Util.twice and its Javadoc');
  await a.press('Escape');
  await caretAt(a, 'Util.twice', 'twice');
  await a.press('Ctrl+B');
  await a.until(`ide.activeTab()?.title === 'Util.java'`, 'Util.java opened', 30000);
  check((await a.js(`ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber)`)).includes('public static int twice'), 'Ctrl+B in the Maven project opens Util.twice');

  // Closing the project stops the server.
  const before = jdtlsPids(a);
  check(before.length === 1, `one JDT LS process runs for the project (${before})`);
  await a.js(`ide.saveAll()`);
  await a.js(`ide.closeProject()`);
  await a.until(`document.querySelector('#javaLspStatus')?.classList.contains('hidden')`, 'status hidden after Close Project', 15000);
  let after = before;
  for (let i = 0; i < 40 && after.length; i++) { await new Promise((r) => setTimeout(r, 250)); after = jdtlsPids(a); }
  check(!after.length, `Close Project stops the Java language server (${after})`);
  check(!a.consoleErrors.length, `no renderer exceptions ${a.consoleErrors}`);
  a.close();
} catch (err) {
  check(false, err.message);
  k?.close();
  a?.close();
}
server.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
