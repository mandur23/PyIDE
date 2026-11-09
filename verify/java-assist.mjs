// Java and Spring Boot projects as IntelliJ IDEA shows them, on a Maven project in the Spring Boot layout:
// - the project tree's compacted folders (com.example.demo on one row, Maven's src/main/java and src/test/java drawn as
//   roots and never merged), a click on a segment selecting that folder, New, Rename and drag and drop aimed at a
//   segment's folder, Reveal, and Settings › Editor › General › Compact middle packages turning it off and on;
// - New › Java Class (class, interface, a dotted record name) and a plain new file named X.java getting the package
//   of their folder below the source root and a type named after the file, no package line in the default package;
// - with the Eclipse JDT Language Server (its cached archive, installed from a local server) and a JDK 21 or later:
//   accepting @RestController, @GetMapping and a class name adds each import once, in JDT's order, and none for
//   java.lang. Spring's annotations come from a stub jar built here with javac. Without the cached archive or a JDK,
//   that part says SKIP; nothing is downloaded.
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import http from 'http';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir, clickMenuPath, menuRow } from './lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(APP, 'verify', 'fixtures', 'java-assist');
const q = JSON.stringify;
const ARCHIVE_NAME = 'jdt-language-server-1.63.0-202610191322.tar.gz';
const SHA256 = 'b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4';
const archive = path.join(APP, 'verify', 'out', 'downloads-cache', ARCHIVE_NAME);
const haveArchive = existsSync(archive) && createHash('sha256').update(readFileSync(archive)).digest('hex') === SHA256;

const work = tempDir('java-assist');
const project = path.join(work, 'demo');
cpSync(path.join(FIXTURE, 'project'), project, { recursive: true });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-length': statSync(archive).size });
  createReadStream(archive).pipe(res);
});
const env = { PYIDE_INSTALL_ROOT: path.join(work, 'root') };
if (haveArchive) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = path.join(work, 'toolchains.json');
  writeFileSync(feed, q({ jdtls: { url: `http://127.0.0.1:${server.address().port}/${ARCHIVE_NAME}`, size: statSync(archive).size, sha256: SHA256 } }));
  env.PYIDE_TOOLCHAINS = feed;
}

const t = await launch({ fixture: 'java-assist', port: 9827, projectDir: project, env });
const { js, until, press, type, check, sleep, cdp } = t;
const p = (rel) => path.join(project, ...rel.split('/'));
const read = (rel) => readFileSync(p(rel), 'utf8').replace(/\r\n/g, '\n');
const names = `[...document.querySelectorAll('#tree .node:not(.tree-extra) .name')].map((n) => n.textContent)`;
// The row whose entry (a compacted row's last folder) is at rel, and a segment of a compacted row.
const rowAt = (rel) => `[...document.querySelectorAll('#tree .node')].find((n) => ide.util.samePath(n._entry?.path || '', ${q(p(rel))}))`;
const segAt = (rel) => `[...document.querySelectorAll('#tree .node .seg')].find((s) => ide.util.samePath(s._entry.path, ${q(p(rel))}))`;
const selectedPath = `ide.selectedTreeEntry()?.path`;
const isSelected = (rel) => `ide.util.samePath(${selectedPath} || '', ${q(p(rel))})`;
// A real press of the mouse on what `expr` gives (a row's icon, so no segment takes it, or a segment), scrolled into
// view first.
async function mouseOn(expr, button = 'left') {
  await until(`!!(${expr})`, `on screen: ${expr.slice(0, 120)}`);
  const box = await js(`(() => { const hit = ${expr}; const n = hit.classList.contains('node') ? hit.querySelector('.icon') : hit; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: box.x, y: box.y, button, clickCount: 1 });
  await sleep(120);
}
const waitFile = async (rel, ms = 10000) => { for (const end = Date.now() + ms; !existsSync(p(rel)) && Date.now() < end;) await sleep(100); };
// New › Java Class on what `expr` gives: the name, then Down `down` times to pick the kind.
async function newJavaClass(expr, name, down = 0) {
  await mouseOn(expr, 'right');
  await clickMenuPath(t, ['New', 'Java Class']);
  await until(`!!document.querySelector('.ft-java-name')`, 'New Java Class dialog');
  await until(`document.activeElement === document.querySelector('.ft-java-name')`, 'the name field has the keyboard');
  await type(name);
  for (let i = 0; i < down; i++) await press('ArrowDown');
  await press('Enter');
}

try {
  // ---------- the tree ----------
  for (const f of ['src/main/java/com/example/demo/web/HelloController.java', 'src/main/resources/application.properties', 'src/test/java/com/example/demo/DemoApplicationTests.java']) {
    await js(`ide.revealInTree(${q(p(f))})`);
  }
  const expected = ['demo', 'src', 'main', 'java', 'com.example.demo', 'web', 'HelloController.java', 'DemoApplication.java', 'resources', 'application.properties',
    'test', 'java', 'com.example.demo', 'DemoApplicationTests.java', 'pom.xml'];
  await until(`${names}.join() === ${q(expected.join())}`, 'compacted rows').catch(() => {});
  check(await js(`${names}.join()`) === expected.join(), `a folder holding only a folder shares its row (com.example.demo); src/main/java and src/test/java keep their own rows (${await js(`${names}.join(' | ')`)})`);
  const icons = await js(`[${rowAt('src/main/java')}, ${rowAt('src/test/java')}].map((n) => n?.querySelector('.file-icon')?.dataset.type)`);
  check(icons.join() === 'sourceRoot,testRoot', `Maven's java folders are drawn as a sources root and a test sources root (${icons})`);
  const compact = await js(`(() => { const n = ${rowAt('src/main/java/com/example/demo')}; return { title: n.querySelector('.name').title, chain: n._entry.compact.map((c) => c.name), segs: [...n.querySelectorAll('.seg')].map((s) => s.textContent) }; })()`);
  check(compact.title === 'com/example/demo' && compact.chain.join() === 'com,example,demo' && compact.segs.join() === 'com,example,demo',
    `the compacted row is the last folder, with one segment per folder (${q(compact)})`);

  await mouseOn(segAt('src/main/java/com/example'));
  await until(`!${names}.includes('HelloController.java')`, 'the row closes on a click');
  check(await js(isSelected('src/main/java/com/example')) && await js(`${segAt('src/main/java/com/example')}.classList.contains('picked')`),
    'a click on the segment "example" selects that folder and marks it, and the row closes');
  await mouseOn(segAt('src/main/java/com/example'));
  await until(`${names}.includes('HelloController.java')`, 'the row opens again');
  await press('ArrowDown');
  check(await js(isSelected('src/main/java/com/example/demo/web')), 'Down goes from the segment to the next row (web)');

  await newJavaClass(segAt('src/main/java/com/example'), 'Util');
  await until(`ide.activeTab()?.title === 'Util.java'`, 'Util.java opened');
  check(read('src/main/java/com/example/Util.java') === 'package com.example;\n\npublic class Util {\n}\n', `New › Java Class on the segment "example" makes com/example/Util.java in package com.example (${q(read('src/main/java/com/example/Util.java'))})`);
  await until(`${names}.includes('com.example') && ${names}.includes('Util.java')`, 'the row splits').catch(() => {});
  const split = await js(`${names}.slice(${names}.indexOf('com.example'), ${names}.indexOf('com.example') + 5)`);
  check(split.join() === 'com.example,demo,web,HelloController.java,DemoApplication.java', `a file in a middle folder splits the row; the folders stay open (${split})`);

  // ---------- new Java files ----------
  await newJavaClass(rowAt('src/main/java/com/example/demo/web'), 'Greeting', 1);
  await until(`ide.activeTab()?.title === 'Greeting.java'`, 'Greeting.java opened');
  check(read('src/main/java/com/example/demo/web/Greeting.java') === 'package com.example.demo.web;\n\npublic interface Greeting {\n}\n', 'Down picks Interface: web/Greeting.java is an interface in com.example.demo.web');
  await newJavaClass(rowAt('src/main/java/com/example/demo'), 'model.User', 3);
  await until(`ide.activeTab()?.title === 'User.java'`, 'User.java opened');
  check(existsSync(p('src/main/java/com/example/demo/model/User.java')) && read('src/main/java/com/example/demo/model/User.java') === 'package com.example.demo.model;\n\npublic record User() {\n}\n',
    'the dotted name model.User makes the package model and a record in com.example.demo.model');

  await mouseOn(rowAt('src/test/java/com/example/demo'), 'right');
  await clickMenuPath(t, ['New', 'File']);
  await until(`!!document.querySelector('#popup:not(.hidden) #popupIn')`, 'file name prompt');
  await type('Plain.java');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'Plain.java'`, 'Plain.java opened');
  check(read('src/test/java/com/example/demo/Plain.java') === 'package com.example.demo;\n\npublic class Plain {\n}\n', 'New › File named Plain.java gets its package (from src/test/java) and a class Plain');
  await js(`ide.revealInTree(${q(p('src/test/java'))})`);
  check(await js(isSelected('src/test/java')), 'Reveal selects the test sources root');
  await js(`(ide.runAction('NewPythonFile'), true)`);
  await until(`!!document.querySelector('#popup:not(.hidden) #popupIn')`, 'new file prompt');
  await type('Root.java');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'Root.java'`, 'Root.java opened');
  check(read('src/test/java/Root.java') === 'public class Root {\n}\n', `a Java file in the default package has no package line (${q(read('src/test/java/Root.java'))})`);
  const menuWithout = async (expr) => {
    await mouseOn(expr, 'right');
    await until(`!!${menuRow('New')}`, 'menu');
    const at = await js(`(() => { const r = ${menuRow('New')}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'New submenu');
    const labels = await js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-label')].map((n) => n.textContent)`);
    await press('Escape');
    await press('Escape');
    return labels;
  };
  check(!(await menuWithout(rowAt('src/main/resources'))).includes('Java Class'), 'New › Java Class is not offered outside a Java source root (resources)');

  // ---------- rename and drag and drop on a segment ----------
  await js(`ide.revealInTree(${q(p('src/test/java/com/example'))})`);
  check(await js(isSelected('src/test/java/com/example')) && await js(`${segAt('src/test/java/com/example')}.classList.contains('picked')`), 'Reveal of a middle folder selects its segment');
  await mouseOn(segAt('src/test/java/com/example'), 'right');
  await clickMenuPath(t, ['Rename…']);
  await until(`document.querySelector('#popup:not(.hidden) #popupIn')?.value === 'example'`, 'rename prompt with the segment name');
  await press('Ctrl+A');
  await type('sample');
  await press('Enter');
  await until(`${names}.includes('com.sample.demo')`, 'renamed row').catch(() => {});
  check(existsSync(p('src/test/java/com/sample/demo/Plain.java')) && await js(isSelected('src/test/java/com/sample')),
    `Rename on the segment renames that folder (com.sample.demo) and keeps it selected (${await js(selectedPath)})`);

  await js(`(() => {
    const dt = new DataTransfer();
    ${rowAt('src/main/java/com/example/Util.java')}.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const seg = ${segAt('src/test/java/com/sample')};
    const r = seg.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 4, clientY: r.y + 6 };
    seg.dispatchEvent(new DragEvent('dragover', at));
    seg.dispatchEvent(new DragEvent('drop', at));
  })()`);
  await until(`[...document.querySelectorAll('.dialog-buttons .primary')].some((b) => b.textContent === 'Move')`, 'move confirmation');
  const question = await js(`document.querySelector('.dialog-body').textContent`);
  // A click: the confirmation has no field, so the keyboard is still in the editor (Root.java), which takes Enter.
  await t.click('.dialog-buttons .primary');
  await waitFile('src/test/java/com/sample/Util.java');
  check(existsSync(p('src/test/java/com/sample/Util.java')) && /src\\test\\java\\com\\sample/.test(question), `a drop on the segment "sample" moves the file into that folder (${question})`);

  // ---------- the setting ----------
  await js(`ide.settings.set('projectTree.compactFolders', false)`);
  await until(`${names}.includes('example') && ${names}.includes('sample')`, 'one row per folder').catch(() => {});
  const plainRows = await js(`${names}.join()`);
  check(!plainRows.includes('com.example') && plainRows.includes('java,com,example,demo,model'), `turned off, every folder has its own row and the opened ones stay open (${plainRows})`);
  await js(`ide.settings.set('projectTree.compactFolders', true)`);
  await until(`${names}.includes('com.example.demo') && ${names}.includes('com.sample')`, 'compacted again');
  check(true, 'turned on again, the rows are compacted again');
  await js(`(ide.openSettings('editor'), true)`);
  await until(`!!document.querySelector('input[data-key="projectTree.compactFolders"]')`, 'setting shown');
  check(await js(`document.querySelector('input[data-key="projectTree.compactFolders"]').checked`), 'Settings › Editor › General shows Compact middle packages, on');
  await press('Escape');

  // ---------- auto-import through JDT LS ----------
  const jdks = await js(`ide.toolchains.list('jdk').then((l) => l.map((x) => ({ home: x.home, version: x.version })))`);
  const major = (v) => parseInt(String(v).replace(/^1\./, ''), 10) || 0;
  const javac = jdks.map((j) => path.join(j.home, 'bin', 'javac.exe')).find(existsSync);
  if (!haveArchive || !javac || !jdks.some((j) => major(j.version) >= 21)) {
    console.log(`SKIP java-assist auto-import: ${!haveArchive ? `${ARCHIVE_NAME} is not in verify/out/downloads-cache` : 'no JDK 21 or later with javac on this computer'}`);
  } else {
    const classes = path.join(work, 'stub-classes');
    mkdirSync(classes, { recursive: true });
    const stubs = path.join(FIXTURE, 'stub', 'org', 'springframework', 'web', 'bind', 'annotation');
    const built = spawnSync(javac, ['--release', '17', '-d', classes, ...readdirSync(stubs).map((f) => path.join(stubs, f))], { encoding: 'utf8' });
    mkdirSync(p('lib'), { recursive: true });
    const jarred = spawnSync(path.join(path.dirname(javac), 'jar.exe'), ['cf', p('lib/spring-web-stub.jar'), '-C', classes, '.'], { encoding: 'utf8' });
    if (built.status || jarred.status) throw new Error(`stub jar: ${built.stderr}${jarred.stderr}`);
    await js(`ide.installer.run('toolchain:jdtls')`);
    await until(`ide.installer.state('toolchain:jdtls')?.phase === 'installed'`, 'JDT LS installed', 120000);
    await js(`(ide.runAction('Java.RestartLanguageServer'), true)`);
    await js(`ide.openFile(${q(p('src/main/java/com/example/demo/web/HelloController.java'))})`);
    await until(`document.querySelector('#javaLspStatus')?.dataset.state === 'ready'`, 'JDT LS ready', 300000);
    const text = () => js(`ide.editor.getModel().getValue()`);
    const lineOf = (needle) => js(`ide.editor.getModel().getLinesContent().findIndex((l) => l.includes(${q(needle)})) + 1`);
    const typeAbove = async (needle, typed) => {
      const line = await lineOf(needle);
      await js(`(() => { const m = ide.editor.getModel(); const indent = /^\\s*/.exec(m.getLineContent(${line}))[0]; m.pushEditOperations([], [{ range: new ide.monaco.Range(${line}, 1, ${line}, 1), text: indent + '\\n' }], () => null); ide.editor.focus(); ide.editor.setPosition({ lineNumber: ${line}, column: indent.length + 1 }); return true; })()`);
      await type(typed);
    };
    // Accepts the completion `label` (whose description holds `pkg`, when given) once it is focused in the list.
    const accept = async (label, pkg = '') => {
      const row = `[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].find((r) => r.querySelector('.label-name')?.textContent === ${q(label)} && (r.textContent.includes(${q(pkg)})))`;
      await until(`!!${row}`, `completion lists ${label}`, 60000);
      for (let i = 0; i < 20 && !(await js(`${row}?.classList.contains('focused')`)); i++) await press('ArrowDown');
      await press('Enter');
    };
    const imports = async () => (await text()).split('\n').filter((l) => l.startsWith('import '));
    const count = async (line) => (await imports()).filter((l) => l === line).length;
    const REST = 'import org.springframework.web.bind.annotation.RestController;';
    const GET = 'import org.springframework.web.bind.annotation.GetMapping;';

    await typeAbove('public class HelloController', '@RestCon');
    await accept('RestController');
    await until(`ide.editor.getModel().getValue().includes(${q(REST)})`, 'RestController imported', 30000).catch(() => {});
    const lines = (await text()).split('\n');
    check(await count(REST) === 1 && lines[0] === 'package com.example.demo.web;' && lines.indexOf(REST) > 0 && lines.indexOf(REST) < lines.findIndex((l) => l.trim() === '@RestController'),
      `accepting @RestController adds its import once, below the package line (${q(lines.slice(0, 6))})`);
    await typeAbove('public String hello()', '@GetMap');
    await accept('GetMapping');
    await until(`ide.editor.getModel().getValue().includes(${q(GET)})`, 'GetMapping imported', 30000).catch(() => {});
    const both = await imports();
    check(both.join() === [GET, REST].join(), `accepting @GetMapping adds its import beside it, in order, and RestController's stays single (${q(both)})`);
    // Fields of the class: each completes a declaration, so the file stays valid Java for the next completion.
    await typeAbove('public String hello()', 'private RestControll');
    await accept('RestController');
    await type(' r;');
    await sleep(2000);
    check(await count(REST) === 1, 'accepting RestController again adds no second import');
    await typeAbove('public String hello()', 'private ArrayLis');
    await accept('ArrayList', 'java.util');
    await type('<String> a;');
    await until(`ide.editor.getModel().getValue().includes('import java.util.ArrayList;')`, 'ArrayList imported', 30000).catch(() => {});
    const all = await imports();
    check(all[0] === 'import java.util.ArrayList;' && all.length === 3, `a class name's completion imports it too, java.util before org (${q(all)})`);
    await typeAbove('public String hello()', 'private StringBuil');
    await accept('StringBuilder', 'java.lang');
    await type(' b;');
    await sleep(2000);
    check(!(await text()).includes('import java.lang.') && (await text()).includes('StringBuilder'), 'a java.lang class is never imported');
  }
  check(!t.consoleErrors.length, `no renderer exceptions ${t.consoleErrors}`);
} catch (err) {
  check(false, err.message);
}
server.close();
t.finish();
