// Built-in Java and C/C++ toolchains, offline: the Install Manager's Toolchains category (install with progress from a
// local server, a checksum mismatch, Cancel, Remove), New Project's Java and C/C++ types on a computer without a JDK or
// a compiler (the wizard offers the built-in one and installs it in place), a Run configuration without a toolchain
// (the Run tab offers the download), and the Korean UI. This computer's own toolchains are left out (PYIDE_TOOLCHAINS
// system: false). verify/java-cpp-projects.mjs creates and runs projects with real toolchains.
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import http from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-toolchains-env-'));
const root = path.join(work, 'root');
const where = path.join(work, 'projects');
mkdirSync(where);

// ---------- fake archives on a local server ----------
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
function archive(name, files) {
  const src = path.join(work, `src-${name}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    writeFileSync(path.join(src, rel), text);
  }
  const zip = path.join(work, `${name}.zip`);
  execFileSync(tar, ['-a', '-cf', zip, '-C', src, '.']);
  return readFileSync(zip);
}
const served = {
  '/jdk.zip': archive('jdk', { 'jdk-fake/bin/javac.exe': 'not a program', 'jdk-fake/bin/java.exe': 'not a program', 'jdk-fake/release': 'JAVA_VERSION="99.0.1"\nIMPLEMENTOR="Fake Vendor"\n' }),
  '/cpp.zip': archive('cpp', { 'w64devkit/bin/gcc.exe': 'not a program', 'w64devkit/bin/g++.exe': 'not a program' }),
};
const sockets = new Set();
const server = http.createServer((req, res) => {
  // Sends a little and then nothing, until the client gives up.
  if (req.url === '/slow.zip') { res.writeHead(200, { 'content-length': 50000000 }); res.write(Buffer.alloc(65536)); return; }
  const body = served[req.url];
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const feedFile = path.join(work, 'toolchains.json');
const JDK = { url: `${base}/jdk.zip`, size: served['/jdk.zip'].length, sha256: sha(served['/jdk.zip']), version: '99.0.1', top: 'jdk-fake' };
const CPP = { url: `${base}/cpp.zip`, size: served['/cpp.zip'].length, sha256: sha(served['/cpp.zip']), version: '1.0', top: 'w64devkit' };
const feed = (over = {}) => writeFileSync(feedFile, JSON.stringify({ system: false, jdk: JDK, cpp: CPP, ...over }));
feed();
const env = { PYIDE_INSTALL_ROOT: root, PYIDE_TOOLCHAINS: feedFile };

// ---------- Install Manager helpers (as in verify/installer.mjs) ----------
const card = (id) => `.inst-card[data-id="${id}"]`;
const phase = (t, id) => t.js(`document.querySelector('${card(id)}')?.dataset.phase`);
const text = (t, sel) => t.js(`document.querySelector(${q(sel)})?.textContent || ''`);
const waitPhase = async (t, id, want, ms = 30000) => {
  try {
    await t.until(`document.querySelector('${card(id)}')?.dataset.phase === '${want}'`, `${id} ${want}`, ms);
  } catch (err) {
    const c = await t.js(`(() => { const c = document.querySelector('${card(id)}'); return c && { phase: c.dataset.phase, message: c.querySelector('.inst-message').textContent, log: c.querySelector('.inst-log').textContent.slice(-1500) }; })()`);
    throw new Error(`${err.message}; card: ${q(c)}`);
  }
};
const settled = (t) => t.until(`document.querySelectorAll('.inst-card').length && ![...document.querySelectorAll('.inst-card')].some(c => ['unknown', 'checking'].includes(c.dataset.phase))`, 'status checks settled', 60000);
const press = async (t, sel) => {
  await t.until(`!!document.querySelector(${q(sel)})`, sel);
  await t.js(`(() => {
    const n = document.querySelector(${q(sel)});
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit && !n.contains(hit)) for (const b of document.querySelectorAll('.ide-balloon')) b.remove();
    return true;
  })()`);
  await t.click(sel);
};
const count = (t, filter) => t.js(`Number(document.querySelector('.inst-nav[data-filter="${filter}"] .inst-count')?.textContent)`);
const files = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

async function openWizard(t, type) {
  await t.js(`ide.runAction('NewProject')`);
  await t.until(`!!document.querySelector('.np-dialog #npName')`, 'wizard');
  await t.js(`(document.querySelector('.np-type[data-type="${type}"]').click(), true)`);
}
const closeWizard = async (t) => {
  await t.js(`(document.querySelector('#npCancel').click(), true)`);
  await t.until(`!document.querySelector('.np-dialog')`, 'wizard closed');
};

let a;
let b;
try {
  a = await launch({ fixture: 'core', port: 9770, name: 'toolchains', env });
  await a.js(`ide.settings.set('newProject.location', ${q(where)})`);

  // ---------- a run configuration without a toolchain ----------
  await a.js(`(ide.run.runConfig({ ...ide.run.types.get('java').defaults(), id: 'tc-java', type: 'java', name: 'NoJdk', mainClass: 'Main' }), true)`);
  await a.until(`document.querySelector('#runOut')?.textContent.includes('No JDK was found on this computer.')`, 'no JDK message');
  check(await a.js(`ide.toolWindows.get('Run').actionList.some((x) => x.title === 'Download JDK')`), 'a Java Application run without a JDK says so in the Run tab and offers Download JDK');
  await a.js(`(ide.run.runConfig({ ...ide.run.types.get('cpp').defaults(), id: 'tc-cpp', type: 'cpp', name: 'NoGcc' }), true)`);
  await a.until(`document.querySelector('#runOut')?.textContent.includes('No C/C++ compiler was found on this computer.')`, 'no compiler message');
  check(await a.js(`ide.toolWindows.get('Run').actionList.some((x) => x.title === 'Download C/C++ Toolchain')`), 'a C/C++ Application run without a compiler offers Download C/C++ Toolchain');
  const runTypes = await a.js(`['java', 'cpp'].map((t) => ide.run.types.get(t)?.title).join('|')`);
  check(runTypes === 'Java Application|C/C++ Application', `run configuration types Java Application and C/C++ Application are registered (${runTypes})`);

  // ---------- New Project: Java without a JDK ----------
  await openWizard(a, 'java');
  const types = await a.js(`[...document.querySelectorAll('.np-type')].map(n => n.lastChild.textContent).join('|')`);
  check(types === 'Pure Python|Flask|FastAPI|Django|Java|Spring Boot|C/C++', `New Project lists Java, Spring Boot and C/C++ after the Python types (${types})`);
  await a.until(`document.querySelector('#npJdkDownload')?.textContent.includes('99.0.1')`, 'download offer');
  const javaForm = await a.js(`(() => {
    const interp = [...document.querySelectorAll('.np-dialog fieldset')].find((f) => f.querySelector('legend').textContent === 'Interpreter type');
    return { interpHidden: interp.classList.contains('hidden'), title: document.querySelector('.np-title').textContent, jdks: document.querySelector('#npJdk').options.length,
      offer: document.querySelector('#npJdkOffer').classList.contains('hidden') ? null : document.querySelector('#npJdkOffer').textContent,
      builds: [...document.querySelectorAll('input[name="npBuild"]')].map((i) => i.value).join() };
  })()`);
  check(javaForm.interpHidden && javaForm.title === 'Java' && javaForm.builds === 'plain,maven,gradle', `the Java type shows its own options (build system IntelliJ, Maven, Gradle) instead of the Python interpreter ${q(javaForm)}`);
  check(javaForm.jdks === 0 && /No JDK was found on this computer\..*Download Eclipse Temurin JDK 99\.0\.1 \(0 MB\)/.test(javaForm.offer), 'without a JDK the wizard says so and offers to download Eclipse Temurin');
  await a.js(`(() => { const i = document.querySelector('#npName'); i.value = 'nojdk'; i.dispatchEvent(new Event('input')); return true; })()`);
  await a.click('#npCreate');
  await a.until(`document.querySelector('.np-error').textContent.includes('Choose a JDK, or download one.')`, 'no JDK error');
  check(!existsSync(path.join(where, 'nojdk')), 'Create without a JDK keeps the wizard open and creates nothing');
  await a.shot('wizard-no-jdk.png');

  feed({ jdk: { ...JDK, sha256: '0'.repeat(64) } });
  await a.click('#npJdkDownload');
  await a.until(`document.querySelector('#npJdkOffer').textContent.includes('Download failed')`, 'checksum failure', 30000).catch(async (e) => {
    throw new Error(`${e.message} ${q(await a.js(`({ offer: document.querySelector('#npJdkOffer').textContent, state: ide.installer.state('toolchain:jdk') })`))}`);
  });
  check((await text(a, '#npJdkOffer')).includes('Checksum mismatch') && !files(path.join(root, 'jdk')).some((f) => !f.endsWith('.extract')) , 'a download whose sha256 does not match the pinned one fails in the wizard and leaves nothing behind');
  feed();
  await a.click('#npJdkDownload');
  await a.until(`document.querySelector('#npJdk').options.length === 1 && document.querySelector('#npJdkOffer').classList.contains('hidden')`, 'JDK installed from the wizard', 30000);
  check((await text(a, '#npJdk')).includes('JDK 99.0.1 · Fake Vendor (PyIDE)'), `the downloaded JDK is chosen in the wizard (${await text(a, '#npJdk')})`);
  check(existsSync(path.join(root, 'jdk', 'temurin-99.0.1', 'jdk-fake', 'bin', 'javac.exe')) && !files(path.join(root, 'jdk')).some((f) => /\.(zip|part)$/.test(f)),
    'it is extracted under <install root>\\jdk\\temurin-<version> and the archive is removed');
  await closeWizard(a);

  // ---------- New Project: C/C++ without a compiler ----------
  await openWizard(a, 'cpp');
  await a.until(`document.querySelector('#npToolchainDownload')?.textContent.includes('w64devkit 1.0')`, 'toolchain offer');
  const cppForm = await a.js(`(() => {
    const std = () => [...document.querySelector('#npStandard').options].map((o) => o.value).join() + ':' + document.querySelector('#npStandard').value;
    const cpp = std();
    document.querySelector('input[name="npLang"][value="c"]').click();
    return { cpp, c: std(), offer: document.querySelector('#npToolchainOffer').textContent, compilers: document.querySelector('#npToolchain').options.length };
  })()`);
  check(cppForm.cpp === 'c++17,c++20,c++23:c++20' && cppForm.c === 'c11,c17,c23:c17', `C++ and C each offer their language standards ${q(cppForm)}`);
  check(cppForm.compilers === 0 && cppForm.offer.includes('No C/C++ compiler was found on this computer.'), 'without a compiler the wizard offers to download w64devkit');
  await closeWizard(a);

  // ---------- Install Manager: Toolchains ----------
  await a.js(`(ide.installer.open('toolchains'), true)`);
  await a.until(`!!document.querySelector('#installManager')`, 'Install Manager');
  await settled(a);
  check(await count(a, 'cat:toolchains') === 2 && (await text(a, '.inst-nav[data-filter="cat:toolchains"]')).includes('Toolchains'), 'the Install Manager has a Toolchains category with the JDK and w64devkit');
  check(await phase(a, 'toolchain:jdk') === 'installed' && (await text(a, `${card('toolchain:jdk')} .inst-meta`)).includes(path.join(root, 'jdk')), 'the JDK installed from the wizard shows as Installed, with its folder');
  check(await phase(a, 'toolchain:cpp') === 'notInstalled' && (await text(a, `${card('toolchain:cpp')} .inst-meta`)).includes('MB download'), 'w64devkit is not installed and shows its download size');

  feed({ cpp: { ...CPP, url: `${base}/slow.zip`, size: 50000000 } });
  await press(a, `${card('toolchain:cpp')} button[data-op="install"]`);
  await a.until(`(document.querySelector('${card('toolchain:cpp')} .inst-log')?.textContent || '').includes('slow.zip')`, 'download started');
  await press(a, `${card('toolchain:cpp')} button[data-op="cancel"]`);
  await waitPhase(a, 'toolchain:cpp', 'notInstalled');
  check(!files(path.join(root, 'cpp')).length, `Cancel stops the download and removes the partial file (${files(path.join(root, 'cpp'))})`);
  for (const s of sockets) s.destroy();

  feed();
  await press(a, `${card('toolchain:cpp')} button[data-op="install"]`);
  await waitPhase(a, 'toolchain:cpp', 'installed');
  const cppDir = path.join(root, 'cpp', 'w64devkit-1.0');
  check(existsSync(path.join(cppDir, 'w64devkit', 'bin', 'gcc.exe')) && (await text(a, `${card('toolchain:cpp')} .inst-version`)) === 'v1.0', 'Install downloads, checks and extracts w64devkit under <install root>\\cpp');
  check(await a.js(`ide.toolchains.list('cpp').then((l) => l.length === 1 && l[0].builtin && l[0].vendor === 'w64devkit')`), 'the installed toolchain is listed for New Project and the run configurations');
  await press(a, `${card('toolchain:cpp')} button[data-op="uninstall"]`);
  await waitPhase(a, 'toolchain:cpp', 'notInstalled');
  check(!existsSync(cppDir) && await a.js(`ide.toolchains.list('cpp').then((l) => l.length === 0)`), 'Remove deletes its folder and it is no longer listed');
  await a.shot('install-manager.png');
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${q(a.consoleErrors)}` : ''}`);
  a.close();

  // ---------- Korean ----------
  b = await launch({ fixture: 'core', port: 9772, name: 'toolchains-ko', lang: 'ko', env });
  await openWizard(b, 'cpp');
  await b.until(`!!document.querySelector('#npToolchainDownload')?.textContent`, 'ko offer');
  let leaks = await englishLeaks(b, '.np-dialog', ['Flask', 'FastAPI', 'Django', 'Java', 'C/C++', 'C++', 'C', 'w64devkit', 'MB', 'PyIDE', 'Git']);
  check(!leaks.length, `the C/C++ wizard options are in Korean${leaks.length ? ` ${q(leaks)}` : ''}`);
  check((await text(b, '#npToolchainOffer')).includes('C/C++ 컴파일러를 찾을 수 없습니다'), 'the missing compiler is reported in Korean');
  await b.js(`(document.querySelector('.np-type[data-type="java"]').click(), true)`);
  leaks = await englishLeaks(b, '.np-dialog', ['Flask', 'FastAPI', 'Django', 'Java', 'C/C++', 'JDK', 'IntelliJ', 'Maven', 'Gradle', 'GroupId', 'PyIDE', 'Git', 'Fake', 'Vendor']);
  check(!leaks.length, `the Java wizard options are in Korean${leaks.length ? ` ${q(leaks)}` : ''}`);
  await b.shot('wizard-ko.png');
  await closeWizard(b);
  await b.js(`(ide.installer.open('toolchains'), true)`);
  await settled(b);
  leaks = await englishLeaks(b, '#installManager .inst-main', ['Eclipse Temurin JDK', 'w64devkit', 'GCC', 'G++', 'GDB', 'make', 'Windows', 'C', 'C++', 'Java', 'OpenJDK', 'Eclipse Adoptium', 'GPLv2', 'Classpath Exception', 'MB']);
  check(!leaks.length && (await text(b, '.inst-nav[data-filter="cat:toolchains"]')).includes('툴체인'), `the Toolchains category is in Korean${leaks.length ? ` ${q(leaks)}` : ''}`);
  check(b.consoleErrors.length === 0, 'no renderer exceptions (ko)');
  b.close();
} catch (err) {
  check(false, err.message);
  a?.close();
  b?.close();
}
server.close();
for (const s of sockets) s.destroy();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
