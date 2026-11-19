// A Gradle project whose JDK cannot run its Gradle is told so, with the Java that can (main/java-compat.js and the
// toolchains plugin). Offline: this computer's JDKs are left out (PYIDE_TOOLCHAINS system: false), a JDK "25" stands
// installed in a temporary install root, and JDK 21 comes as a fake archive from a local server.
// Checks: Gradle's Java limits by version, and what a project asks for; a project with Gradle 8.14.3 and a toolchain
// of 21 on JDK 25 gets one warning naming Java 21, Gradle 8.14.3, Java 24 and Java 25, with Install JDK 21; the
// install downloads it, makes it the project's JDK and takes the warning away; with JDK 21 there but 25 in use again
// the offer is Use JDK 21, without a download; a Gradle 9.1 project and a project without Gradle get no warning;
// Korean. Port 9944.
// Usage: node verify/java-check.mjs
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import http from 'http';
import { createRequire } from 'module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-java-check-'));
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const gradleProject = (name, gradle, build) => {
  const dir = path.join(work, name);
  write(path.join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties'), `distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${gradle}-bin.zip\n`);
  write(path.join(dir, 'build.gradle'), build);
  write(path.join(dir, 'settings.gradle'), `rootProject.name = '${name}'\n`);
  write(path.join(dir, 'src', 'main', 'java', 'App.java'), 'class App {}\n');
  return dir;
};
const TOOLCHAIN_21 = "plugins {\n    id 'java'\n}\njava {\n    toolchain {\n        languageVersion = JavaLanguageVersion.of(21)\n    }\n}\n";
const old = gradleProject('old-gradle', '8.14.3', TOOLCHAIN_21);
const fresh = gradleProject('new-gradle', '9.1.0', "plugins {\n    id 'java'\n}\n");
const plain = path.join(work, 'plain');
write(path.join(plain, 'notes.txt'), 'no build here\n');

// ---------- the rules, without the app ----------
const compat = createRequire(import.meta.url)('../main/java-compat.js');
check(S(['9.1', '9.0', '8.14.3', '8.10', '8.5', '8.4', '7.6.1', '7.2', '1.0'].map(compat.gradleMaxJava)) === S([25, 24, 24, 23, 21, 20, 19, 16, null]), 'each Gradle version has the newest Java it runs on');
check(S(['25.0.1', '21.0.13', '1.8.0_402', '', null].map(compat.javaMajor)) === S([25, 21, 8, null, null]), 'a JDK version gives its Java number, 1.8 as 8');
const jdk = (v) => ({ id: `c:\\jdks\\${v}`, home: `C:\\jdks\\${v}`, version: v });
const one = compat.check(old, [jdk('25.0.1')], '');
check(one && !one.ok && one.reason === 'gradle' && one.maxJava === 24 && one.wants === 21 && one.recommend === 21 && one.candidate === null && one.installable === 'jdk21',
  `Gradle 8.14.3 on JDK 25 alone: not possible, Java 21 is what to install (${S(one)})`);
const two = compat.check(old, [jdk('25.0.1'), jdk('21.0.2')], 'c:\\jdks\\25.0.1');
check(!two.ok && two.candidate?.version === '21.0.2', 'with a JDK 21 beside it, that one is the JDK to use');
check(compat.check(old, [jdk('25.0.1'), jdk('21.0.2')], 'c:\\jdks\\21.0.2').ok, 'on JDK 21 the project is fine');
const three = compat.check(old, [jdk('17.0.9')], '');
check(!three.ok && three.reason === 'toolchain' && three.recommend === 21, 'a JDK Gradle runs on, but not the Java the build names: the toolchain is missing');
write(path.join(old, 'settings.gradle'), "plugins {\n    id 'org.gradle.toolchains.foojay-resolver-convention' version '0.9.0'\n}\nrootProject.name = 'old-gradle'\n");
check(compat.check(old, [jdk('17.0.9')], '').ok, 'a build that downloads its toolchain itself needs no JDK of that Java');
write(path.join(old, 'settings.gradle'), "rootProject.name = 'old-gradle'\n");
check(compat.check(fresh, [jdk('25.0.1')], '').ok && compat.check(plain, [jdk('25.0.1')], '') === null, 'Gradle 9.1 runs on JDK 25, and a folder without a Gradle wrapper is not judged');

// ---------- fake JDKs: 25 installed, 21 on a local server ----------
const root = path.join(work, 'root');
write(path.join(root, 'jdk', 'temurin-25.0.4', 'jdk-25', 'bin', 'javac.exe'), 'not a program');
write(path.join(root, 'jdk', 'temurin-25.0.4', 'jdk-25', 'release'), 'JAVA_VERSION="25.0.4"\nIMPLEMENTOR="Fake Vendor"\n');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const src = path.join(work, 'src-jdk21');
write(path.join(src, 'jdk-21', 'bin', 'javac.exe'), 'not a program');
write(path.join(src, 'jdk-21', 'release'), 'JAVA_VERSION="21.0.13"\nIMPLEMENTOR="Fake Vendor"\n');
const zip = path.join(work, 'jdk21.zip');
execFileSync(tar, ['-a', '-cf', zip, '-C', src, '.']);
const body = readFileSync(zip);
let downloads = 0;
const server = http.createServer((req, res) => {
  if (req.url !== '/jdk21.zip') { res.writeHead(404); res.end(); return; }
  downloads++;
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feedFile = path.join(work, 'toolchains.json');
writeFileSync(feedFile, S({ system: false, jdk: { version: '25.0.4', top: 'jdk-25' },
  jdk21: { url: `http://127.0.0.1:${server.address().port}/jdk21.zip`, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), version: '21.0.13', top: 'jdk-21' } }));
const env = { PYIDE_INSTALL_ROOT: root, PYIDE_TOOLCHAINS: feedFile };

const notes = `ide.notifications.list().filter((n) => n.group === 'Toolchains' && !n.expired)`;
const warning = `${notes}.find((n) => n.kind === 'warn' || n.kind === 'warning')`;
const pressAction = (t, label) => t.js(`(() => { const n = ${notes}.find((x) => x.actions.some((a) => a.label === ${S(label)})); ide.notifications.runAction(n, n.actions.find((a) => a.label === ${S(label)})); return true; })()`);

let t = await launch({ name: 'java-check', port: 9944, projectDir: old, env });
try {
  const { js, until } = t;
  await until('window.__ideReady === true', 'ready', 60000);
  await until(`!!${warning}`, 'the warning', 20000);
  const w = await js(`(() => { const n = ${warning}; return { title: n.title, text: n.text, actions: n.actions.map((a) => a.label), count: ${notes}.length, balloon: !!document.querySelector('.ide-balloon') }; })()`);
  check(w.title === 'This project needs Java 21' && /Gradle 8\.14\.3 runs on Java 24 at most/.test(w.text) && /JDK in use is Java 25/.test(w.text) && S(w.actions) === S(['Install JDK 21']) && w.count === 1 && w.balloon,
    `a project on Gradle 8.14.3 with JDK 25 alone is told once that it needs Java 21 and why, with Install JDK 21 (${S(w)})`);
  await t.shot('warning.png');
  const key = `'toolchains.jdk:' + ide.root`;
  check(await js(`ide.settings.get(${key}, '')`) === '', 'nothing is chosen for the project before the press');
  await pressAction(t, 'Install JDK 21');
  await until(`/temurin-21\\.0\\.13/.test(ide.settings.get(${key}, ''))`, 'JDK 21 installed and chosen', 60000);
  await until(`!${warning}`, 'the warning gone', 15000);
  const after = await js(`(async () => ({ jdk: ide.settings.get(${key}, ''), ok: ${notes}.filter((n) => n.kind === 'ok' || n.kind === 'info').map((n) => n.title), check: (await ide.toolchains.javaCheck()).ok, list: (await ide.toolchains.list('jdk')).map((j) => j.version + (j.builtin ? '*' : '')) }))()`);
  check(downloads === 1 && after.check && after.ok.some((x) => /JDK 21\.0\.13 is now this project's JDK/.test(x)) && S(after.list) === S(['25.0.4*', '21.0.13*']),
    `Install JDK 21 downloads it once, makes it the project's JDK and says so; the project is fine now (${S(after)})`);

  // JDK 21 is there, but the project is on 25 again: the offer is to use it.
  await js(`(ide.settings.set(${key}, ''), true)`);
  await until(`!!${warning}`, 'the warning again', 15000);
  const again = await js(`${warning}.actions.map((a) => a.label)`);
  check(S(again) === S(['Use JDK 21.0.13']), `with JDK 21 on the computer the offer is Use JDK 21, not a download (${S(again)})`);
  await pressAction(t, 'Use JDK 21.0.13');
  await until(`/temurin-21\\.0\\.13/.test(ide.settings.get(${key}, '')) && !${warning}`, 'used', 15000);
  check(downloads === 1, 'Use JDK 21 downloads nothing');
} catch (err) { check(false, err.message); await t.shot('failure.png').catch(() => {}); } finally { t.close(); }

for (const [dir, name] of [[fresh, 'a Gradle 9.1 project'], [plain, 'a project without Gradle']]) {
  t = await launch({ name: 'java-check', port: 9944, projectDir: dir, env });
  try {
    await t.until('window.__ideReady === true', 'ready', 60000);
    await t.sleep(3500);
    check(await t.js(`${notes}.length`) === 0, `${name} gets no warning`);
  } catch (err) { check(false, err.message); } finally { t.close(); }
}

// Korean, on a computer with JDK 25 alone again.
const root2 = path.join(work, 'root2');
write(path.join(root2, 'jdk', 'temurin-25.0.4', 'jdk-25', 'bin', 'javac.exe'), 'not a program');
write(path.join(root2, 'jdk', 'temurin-25.0.4', 'jdk-25', 'release'), 'JAVA_VERSION="25.0.4"\n');
t = await launch({ name: 'java-check', port: 9944, projectDir: old, lang: 'ko', env: { ...env, PYIDE_INSTALL_ROOT: root2 } });
try {
  await t.until('window.__ideReady === true', 'ready', 60000);
  await t.until(`!!${warning}`, 'the Korean warning', 20000);
  const ko = await t.js(`(() => { const n = ${warning}; return { title: n.title, text: n.text, actions: n.actions.map((a) => a.label) }; })()`);
  check(/Java 21로 빌드해야 합니다/.test(ko.title) && /Gradle 8\.14\.3은 Java 24까지만/.test(ko.text) && S(ko.actions) === S(['JDK 21 설치']), `the warning is in Korean (${S(ko)})`);
  await t.shot('warning-ko.png');
} catch (err) { check(false, err.message); } finally { t.close(); }

server.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
