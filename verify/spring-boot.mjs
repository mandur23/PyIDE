// New Project > Spring Boot against a local Spring Initializr (PYIDE_INITIALIZR_URL), in IntelliJ's two pages: the
// options load (with Retry after a failure) into the first page (server URL, language, type, group, artifact, package,
// JDK, Java, packaging), Next checks it and shows the Spring Boot version and the dependency tree (search, collapsing
// groups, the added list with remove, the hovered one described, the ones outside the version's range disabled), and
// Previous goes back. A refused request keeps the wizard open without a folder; a created project is unpacked with its
// .gitignore and Git repository, opens its application class, remembers its JDK and the wizard's choices, and runs
// with Shift+F10 or `mvnw spring-boot:run` in Launchers (the project's mvnw.cmd with the JDK as JAVA_HOME). A Kotlin
// Gradle war project too. Also in Korean.
// SPRING_REAL=1 uses start.spring.io instead and only checks that a Maven project arrives.
import http from 'http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';
import { launch, openFile } from './lib.mjs';

const REAL = process.env.SPRING_REAL === '1';
const BOOTS = 10; // META.bootVersion's versions
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-spring-'));
const where = path.join(work, 'projects');
mkdirSync(where);

// A stored (uncompressed) zip.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const META = {
  language: { default: 'java', values: [{ id: 'java', name: 'Java' }, { id: 'kotlin', name: 'Kotlin' }, { id: 'groovy', name: 'Groovy' }] },
  packaging: { default: 'jar', values: [{ id: 'jar', name: 'Jar' }, { id: 'war', name: 'War' }] },
  // Initializr's own mix: snapshots and milestones between the releases, one RC named without its kind, and an older
  // server's .BUILD-SNAPSHOT / .RELEASE spelling.
  bootVersion: { default: '4.1.2', values: [
    { id: '4.2.0-SNAPSHOT', name: '4.2.0 (SNAPSHOT)' }, { id: '4.2.0-RC1', name: '4.2.0' }, { id: '4.2.0-M2', name: '4.2.0 (M2)' },
    { id: '4.1.3-SNAPSHOT', name: '4.1.3 (SNAPSHOT)' }, { id: '4.1.2', name: '4.1.2' }, { id: '4.1.1', name: '4.1.1' },
    { id: '4.0.10-SNAPSHOT', name: '4.0.10 (SNAPSHOT)' }, { id: '4.0.9', name: '4.0.9' },
    { id: '3.5.9.BUILD-SNAPSHOT', name: '3.5.9 (SNAPSHOT)' }, { id: '3.5.8.RELEASE', name: '3.5.8' },
  ] },
  javaVersion: { default: '17', values: [{ id: '25', name: '25' }, { id: '21', name: '21' }, { id: '17', name: '17' }] },
  dependencies: { values: [
    { name: 'Web', values: [{ id: 'web', name: 'Spring Web', description: 'Build web apps with Spring MVC.' }, { id: 'webflux', name: 'Spring Reactive Web', description: `${'Build reactive web applications with Spring WebFlux and Netty, a description long enough to wrap over several lines of the box. '.repeat(4)}NoBreakInThisVeryLongWordAtAllxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` }] },
    { name: 'SQL', values: [{ id: 'data-jpa', name: 'Spring Data JPA', description: 'Persist data in SQL stores with the Java Persistence API.' }, { id: 'refused', name: 'Refused Starter' }] },
    { name: 'Cloud', values: [{ id: 'cloud-new', name: 'Cloud From 4.2', description: `${'Cloud services that arrive with Spring Boot 4.2, described at length so the warning could scroll away. '.repeat(3)}`, versionRange: '[4.2.0-M1,4.3.0-M1)' }] },
  ] },
  type: { default: 'maven-project', values: [] },
};
// The fake wrappers' dependency download (:sync) prints a line, then waits until the suite writes <gate>\<tool>-go
// (it then succeeds) or <tool>-fail.
const gate = path.join(work, 'gate');
mkdirSync(gate);
const gated = (tool, line, error) => `:sync\r\n${line}\r\n:wait\r\nif exist "%SPRING_GATE%\\${tool}-fail" (${error}& exit /b 1)\r\n`
  + `if not exist "%SPRING_GATE%\\${tool}-go" (ping -n 2 127.0.0.1 >nul& goto wait)\r\necho BUILD SUCCESSFUL\r\n`;
let metaFails = 1;
const requests = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    if (metaFails-- > 0) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/vnd.initializr.v2.2+json' });
    res.end(JSON.stringify({ ...META, accept: req.headers.accept }));
    return;
  }
  if (u.pathname === '/starter.zip') {
    const p = Object.fromEntries(u.searchParams);
    requests.push(p);
    if ((p.dependencies || '').includes('refused')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: "Unknown dependency 'refused' check project metadata" }));
      return;
    }
    const pkg = p.packageName.split('.').join('/');
    // Initializr names the application class applicationName and puts the name in pom.xml's <name>. Without
    // applicationName it would make the class from the name (주문 관리 -> 주문관리Application), so this server makes
    // one the tests notice.
    const app = p.applicationName || 'NoApplicationNameSent';
    res.writeHead(200, { 'content-type': 'application/zip' });
    if (p.type === 'gradle-project-kotlin') {
      res.end(zip({
        'build.gradle.kts': 'plugins {\n    java\n    id("org.springframework.boot") version "4.1.2"\n}\n',
        'settings.gradle.kts': `rootProject.name = "${p.name}"\n`,
        'gradlew.bat': `@echo off\r\necho gradle wrapper %*\r\nif "%1"=="classes" goto sync\r\necho Tomcat started on port 18482 (http) with context path '/'\r\nping -n 120 127.0.0.1 >nul\r\nexit /b\r\n${gated('gradle', 'echo ^> Task :compileJava', 'echo FAILURE: Could not resolve all files for configuration')}`,
        [`src/main/kotlin/${pkg}/${app}.kt`]: `package ${p.packageName}\n\n@SpringBootApplication\nclass ${app}\n`,
      }));
      return;
    }
    res.end(zip({
      '.gitignore': 'target/\n!.mvn/wrapper/maven-wrapper.jar\n',
      'pom.xml': `<project><artifactId>${p.artifactId}</artifactId><name>${p.name}</name><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>\n`,
      'mvnw.cmd': `@echo off\r\nif "%1"=="busy" (echo Web server failed to start. Port 18481 was already in use.& exit /b 1)\r\necho wrapper %*\r\nif "%2"=="dependency:go-offline" goto sync\r\necho JAVA_HOME=%JAVA_HOME%\r\necho Tomcat started on port 18481 (http) with context path '/'\r\nping -n 120 127.0.0.1 >nul\r\nexit /b\r\n${gated('mvn', 'echo Downloading from central: https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-starter-web/4.1.2/spring-boot-starter-web-4.1.2.pom', 'echo [ERROR] Failed to execute goal dependency:go-offline')}`,
      '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip\n',
      [`src/main/java/${pkg}/${app}.java`]: `package ${p.packageName};\n\n@SpringBootApplication\npublic class ${app} {}\n`,
      'src/main/resources/application.properties': `spring.application.name=${p.name}\n`,
    }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// An empty home: the first Maven or Gradle run is announced as one that downloads.
const buildHome = path.join(work, 'home');
mkdirSync(buildHome);
const env = REAL ? {} : { PYIDE_INITIALIZR_URL: `http://127.0.0.1:${server.address().port}/`, PYIDE_BUILD_HOME: buildHome, SPRING_GATE: gate, PYIDE_TEST_NODE: process.execPath };

const setValue = (t, sel, value) => t.js(`(() => { const i = document.querySelector(${q(sel)}); i.value = ${q(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const toggle = (t, id) => t.js(`(() => { const b = document.querySelector('#npSpringDeps input[value="${id}"]'); b.click(); return b.checked; })()`);
const visibleDeps = (t) => t.js(`[...document.querySelectorAll('#npSpringDeps .sb-dep')].map((r) => r.querySelector('input').value)`);
async function openSpring(t) {
  await t.js(`ide.runAction('NewProject')`);
  await t.until(`!!document.querySelector('.np-dialog #npName')`, 'wizard');
  await t.js(`(document.querySelector('.np-type[data-type="spring"]').click(), true)`);
}
const shown = (sel) => `(() => { const n = document.querySelector(${q(sel)}); return !!n && !!n.offsetParent; })()`;
const pageState = (t) => t.js(`({ one: ${shown('#npSpringPage1')}, two: ${shown('#npSpringPage2')}, name: ${shown('#npName')}, prev: ${shown('#npPrevious')}, button: document.querySelector('#npCreate').textContent })`);
const chips = (t) => t.js(`[...document.querySelectorAll('#npSpringAdded .sb-chip')].map((c) => c.dataset.id).join()`);
const chooseJdk = (t, id) => t.js(`(document.querySelector('#npSpringJdk').value = ${q(id)}, document.querySelector('#npSpringJdk').dispatchEvent(new Event('change')), true)`);

let a;
let b;
try {
  a = await launch({ fixture: 'core', port: 9773, name: 'spring-boot', env });
  await a.js(`ide.settings.set('newProject.location', ${q(where)})`);
  const jdks = await a.js(`ide.toolchains.list('jdk').then((l) => l.map((t) => ({ id: t.id, version: t.version, home: t.home })))`);
  const jdk = jdks.filter((j) => parseInt(j.version, 10) >= 17).sort((x, y) => parseInt(y.version, 10) - parseInt(x.version, 10))[0];
  if (!jdk) throw new Error('SKIP: no JDK 17 or newer on this computer');

  await openSpring(a);
  check(await a.js(`[...document.querySelectorAll('.np-type')].map((n) => n.dataset.type).join() .includes('java,spring')`), 'New Project lists Spring Boot after Java');
  if (REAL) {
    await a.until(`document.querySelector('#npSpringBoot').options.length > 0`, 'options from start.spring.io', 30000);
    await setValue(a, '#npName', 'realdemo');
    await chooseJdk(a, jdk.id);
    await a.click('#npCreate');
    await a.until(`document.querySelector('#npCreate').textContent === 'Create'`, 'second page');
    await a.click('#npCreate');
    const dir = path.join(where, 'realdemo');
    await a.until(`ide.root && ide.root.toLowerCase() === ${q(dir.toLowerCase())}`, 'realdemo opened', 90000);
    check(existsSync(path.join(dir, 'mvnw.cmd')) && readFileSync(path.join(dir, 'pom.xml'), 'utf8').includes('spring-boot-starter-web'), 'start.spring.io sends a Maven project with mvnw.cmd and Spring Web');
  } else {
    await a.until(`!!document.querySelector('#npSpringRetry')`, 'the failed options request offers Retry', 15000);
    check(/Could not reach Spring Initializr: .*503/.test(await a.js(`document.querySelector('#npSpringStatus').textContent`)), 'a failed options request is explained');
    await a.click('#npSpringRetry');
    await a.until(`document.querySelector('#npSpringBoot').options.length === ${BOOTS}`, 'options after Retry', 15000);
    check(await a.js(`document.querySelector('#npSpringBoot').value === '4.1.2' && document.querySelector('#npSpringStatus').textContent === ''`), 'Retry loads the options; Spring Boot defaults to Initializr\'s 4.1.2');
    check((await a.js(`ide.api.invoke('spring:metadata')`)).bootVersion.values.length === BOOTS, 'the options are read from the local Initializr');
    const picker = await a.js(`[...document.querySelectorAll('#npSpringBoot optgroup')].map((g) => ({ label: g.label, options: [...g.children].map((o) => o.value + '=' + o.textContent) }))`);
    check(q(picker) === q([
      { label: 'Releases', options: ['4.1.2=4.1.2', '4.1.1=4.1.1', '4.0.9=4.0.9', '3.5.8.RELEASE=3.5.8'] },
      { label: 'Snapshots and milestones', options: ['4.2.0-SNAPSHOT=4.2.0 (SNAPSHOT)', '4.2.0-RC1=4.2.0 (RC1)', '4.2.0-M2=4.2.0 (M2)', '4.1.3-SNAPSHOT=4.1.3 (SNAPSHOT)',
        '4.0.10-SNAPSHOT=4.0.10 (SNAPSHOT)', '3.5.9.BUILD-SNAPSHOT=3.5.9 (SNAPSHOT)'] },
    ]) && META.bootVersion.values.every((v) => picker.some((g) => g.options.some((o) => o.startsWith(`${v.id}=`)))),
    `the Spring Boot picker lists every version the server offers, releases first, the snapshots and milestones labelled as such ${q(picker)}`);
    check(await a.js(`document.querySelector('#npSpringServer').value`) === env.PYIDE_INITIALIZR_URL, 'the server URL shows the server in use');
    check(await a.js(`[...document.querySelectorAll('#npSpringLanguage input')].map((i) => i.value + (i.checked ? '*' : '')).join() + '|' + [...document.querySelectorAll('#npSpringPackaging input')].map((i) => i.value + (i.checked ? '*' : '')).join()`) === 'java*,kotlin,groovy|jar*,war',
      'language (Java, Kotlin, Groovy) and packaging (Jar, War) come from the server');
    check(q(await pageState(a)) === q({ one: true, two: false, name: true, prev: false, button: 'Next' }), `the first page shows with Next and no Previous ${q(await pageState(a))}`);

    await chooseJdk(a, jdk.id);
    const javaWant = ['25', '21', '17'].find((v) => Number(v) <= parseInt(jdk.version, 10));
    check(await a.js(`document.querySelector('#npSpringJava').value`) === javaWant, `Java follows the chosen JDK ${jdk.version} -> ${javaWant}`);
    await setValue(a, '#npName', 'shop-api');
    check(await a.js(`document.querySelector('#npSpringArtifact').placeholder === 'shop-api' && document.querySelector('#npSpringPackage').placeholder === 'com.example.shopapi'`), 'the artifact and package follow the project name');
    await setValue(a, '#npSpringGroup', 'com example');
    await a.click('#npCreate');
    await a.until(`/valid GroupId/.test(document.querySelector('.np-error').textContent)`, 'group error');
    check((await pageState(a)).one, 'Next checks the first page and stays on it with an error');
    await setValue(a, '#npSpringGroup', 'com.example');
    await a.click('#npCreate');
    await a.until(`document.querySelector('#npCreate').textContent === 'Create'`, 'second page');
    check(q(await pageState(a)) === q({ one: false, two: true, name: false, prev: true, button: 'Create' }), 'Next shows the Spring Boot version and dependencies, hides the name and location, and offers Previous and Create');
    await a.shot('spring-page2.png');

    check(await chips(a) === 'web' && await a.js(`document.querySelector('#npSpringDeps input[value="web"]').checked`), 'Spring Web is added to start with');
    check(await a.js(`document.querySelector('#npSpringDeps input[value="cloud-new"]').disabled`), 'a dependency outside the Spring Boot version\'s range is disabled');
    await a.js(`(() => { const s = document.querySelector('#npSpringBoot'); s.value = '4.2.0-SNAPSHOT'; s.dispatchEvent(new Event('change')); return true; })()`);
    check(!(await a.js(`document.querySelector('#npSpringDeps input[value="cloud-new"]').disabled`)), 'it is enabled for a Spring Boot version inside its range');
    await a.js(`(() => { const s = document.querySelector('#npSpringBoot'); s.value = '4.1.2'; s.dispatchEvent(new Event('change')); return true; })()`);

    await setValue(a, '#npSpringFilter', 'jpa');
    check(q(await visibleDeps(a)) === q(['data-jpa']), 'the search box filters the dependencies');
    await toggle(a, 'data-jpa');
    await setValue(a, '#npSpringFilter', '');
    check(await chips(a) === 'web,data-jpa', 'picks survive the filter and are listed under Added dependencies');
    await a.js(`(document.querySelector('#npSpringAdded .sb-chip[data-id="data-jpa"] .sb-chip-x').click(), true)`);
    check(await chips(a) === 'web' && !(await a.js(`document.querySelector('#npSpringDeps input[value="data-jpa"]').checked`)), 'the × of an added dependency removes it');
    await toggle(a, 'data-jpa');
    await a.js(`(document.querySelector('#npSpringDeps .sb-dep-group[data-group="SQL"]').click(), true)`);
    check(q(await visibleDeps(a)) === q(['web', 'webflux', 'cloud-new']), 'clicking a group collapses it');
    await a.js(`(document.querySelector('#npSpringDeps .sb-dep-group[data-group="SQL"]').click(), true)`);
    await a.js(`(document.querySelector('#npSpringDeps input[value="web"]').closest('.sb-dep').dispatchEvent(new MouseEvent('mouseenter')), true)`);
    check(await a.js(`document.querySelector('#npSpringDesc').textContent`) === 'Spring WebBuild web apps with Spring MVC.', 'the hovered dependency is described below the tree');
    const layout = await a.js(`(() => { const d = document.querySelector('#npSpringDesc').getBoundingClientRect(); const body = document.querySelector('.np-dialog .dialog-body').getBoundingClientRect(); return { bottom: Math.round(d.bottom), body: Math.round(body.bottom) }; })()`);
    check(layout.bottom <= layout.body, `the second page fits without scrolling the wizard ${q(layout)}`);
    // Hovering with the real mouse, sweeping over the rows in small steps, swaps the description but moves and resizes
    // nothing: not the dialog, the lists or the description box. A long description wraps and scrolls inside the box.
    const rects = () => a.js(`Object.fromEntries(['.np-dialog', '#npSpringDeps', '#npSpringAdded', '#npSpringDesc', '#npSpringBoot'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect(); return [s, [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10).join()]; }))`);
    const centre = (sel) => a.js(`(() => { const n = document.querySelector(${q(sel)}).closest('.sb-dep, .sb-chip'); const r = n.getBoundingClientRect(); const l = document.querySelector('#npSpringDeps').getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2), inside: r.top >= l.top && r.bottom <= l.bottom || !n.closest('#npSpringDeps') }; })()`);
    const rectsBefore = await rects();
    let mouse = await centre('#npSpringDeps input[value="web"]');
    await a.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x, y: mouse.y });
    const hovers = [];
    for (const [sel, name] of [['#npSpringDeps input[value="webflux"]', 'Spring Reactive Web'], ['#npSpringDeps input[value="data-jpa"]', 'Spring Data JPA'],
      ['#npSpringDeps input[value="cloud-new"]', 'Cloud From 4.2'], ['#npSpringAdded .sb-chip[data-id="data-jpa"]', 'Spring Data JPA'],
      ['#npSpringDeps input[value="web"]', 'Spring Web'], ['#npSpringDeps input[value="webflux"]', 'Spring Reactive Web']]) {
      const to = await centre(sel);
      await a.js(`(() => { const d = document.querySelector('#npSpringDesc'); d.scrollTop = d.scrollHeight; return true; })()`);
      for (let i = 1; i <= 8; i++) {
        await a.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(mouse.x + (to.x - mouse.x) * i / 8), y: Math.round(mouse.y + (to.y - mouse.y) * i / 8) });
      }
      mouse = to;
      const shownName = await a.until(`document.querySelector('#npSpringDesc b')?.textContent === ${q(name)}`, `hover describes ${name}`, 5000).then(() => true, () => false);
      // The box was scrolled to its end on the last one; the next starts at the top, with the range warning in view.
      const desc = await a.js(`(() => { const d = document.querySelector('#npSpringDesc'); const box = d.getBoundingClientRect(); const w = d.querySelector('.sb-desc-warn')?.getBoundingClientRect();
        return { scrolls: d.scrollHeight > d.clientHeight, wraps: d.scrollWidth <= d.clientWidth, top: d.scrollTop, warn: w ? w.top >= box.top && w.bottom <= box.bottom : null }; })()`);
      hovers.push({ name, inside: to.inside, shownName, ...desc, same: q(await rects()) === q(rectsBefore) });
    }
    check(hovers.every((h) => h.inside && h.shownName && h.wraps && h.same && h.top === 0), `hovering across dependencies and an added chip with the mouse describes each one and leaves the dialog, the lists and the description box where and as large as they were ${q({ before: rectsBefore, hovers })}`);
    const long = ['Spring Reactive Web', 'Cloud From 4.2'];
    check(hovers.filter((h) => long.includes(h.name)).every((h) => h.scrolls) && hovers.filter((h) => !long.includes(h.name)).every((h) => !h.scrolls),
      'a long description wraps and scrolls inside the description box; short ones fit');
    check(hovers.every((h) => (h.name === 'Cloud From 4.2' ? h.warn === true : h.warn === null)),
      `a disabled dependency's "Needs Spring Boot" warning stays in view above a long description ${q(hovers.map((h) => [h.name, h.warn]))}`);
    await a.shot('spring-hover.png');

    await a.click('#npPrevious');
    check(q(await pageState(a)) === q({ one: true, two: false, name: true, prev: false, button: 'Next' }), 'Previous goes back to the first page with its fields kept');
    await a.click('#npCreate');
    await a.until(`document.querySelector('#npCreate').textContent === 'Create'`, 'second page again');

    await toggle(a, 'refused');
    await a.click('#npCreate');
    await a.until(`/Unknown dependency 'refused'/.test(document.querySelector('.np-error').textContent)`, 'refused request error', 15000);
    check(await a.js(`!!document.querySelector('.np-dialog #npName')`) && (await pageState(a)).two && !existsSync(path.join(where, 'shop-api')), 'a refused request keeps the wizard open on its page and creates no folder');
    await toggle(a, 'refused');

    const runShown = await a.js(`ide.toolWindows.get('Run').isVisible()`);
    await a.click('#npCreate');
    const dir = path.join(where, 'shop-api');
    await a.until(`ide.root && ide.root.toLowerCase() === ${q(dir.toLowerCase())}`, 'shop-api opened', 60000);
    const req = requests.at(-1);
    check(req.type === 'maven-project' && req.language === 'java' && req.packaging === 'jar' && req.bootVersion === '4.1.2' && req.javaVersion === javaWant && req.groupId === 'com.example'
      && req.artifactId === 'shop-api' && req.name === 'shop-api' && req.packageName === 'com.example.shopapi' && req.dependencies === 'web,data-jpa', `the request carries the form ${q(req)}`);
    const main = path.join(dir, 'src', 'main', 'java', 'com', 'example', 'shopapi', 'ShopApiApplication.java');
    check(existsSync(main) && existsSync(path.join(dir, 'mvnw.cmd')) && existsSync(path.join(dir, '.mvn', 'wrapper', 'maven-wrapper.properties')), 'the project is unpacked into the folder');
    check(readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('maven-wrapper.jar') && existsSync(path.join(dir, '.git')), 'Initializr\'s .gitignore wins and a Git repository is made');
    await a.until(`ide.activeTab()?.title === 'ShopApiApplication.java'`, 'application class opened');
    check(true, 'the application class is opened');
    check(await a.js(`ide.settings.get(${q(`toolchains.jdk:${dir}`)}) === ${q(jdk.id)}`), 'the project remembers the JDK');
    check(await a.js(`ide.toolWindows.get('Project').isVisible()`), 'the project tree stays in view');

    // The dependency download New Project starts in the background.
    const syncText = (n) => `ide.run.sessions().find((s) => s.title === 'Sync: ${n}')?.con?.out.textContent || ''`;
    const syncTask = `ide.tasks.list().find((t) => t.title === 'Downloading dependencies…')`;
    await a.until(`(${syncText('shop-api')}).includes('Downloading from central')`, 'Maven dependency download', 30000);
    const syncOut = await a.js(syncText('shop-api'));
    check(syncOut.startsWith('.\\mvnw.cmd -B dependency:go-offline') && syncOut.includes('wrapper -B dependency:go-offline'), `New Project runs mvnw -B dependency:go-offline in a "Sync: shop-api" Run tab (${q(syncOut.slice(0, 160))})`);
    await a.until(`document.querySelector('#bgTasks').title.includes('spring-boot-starter-web-4.1.2.pom')`, 'status bar task text', 10000);
    const bar =await a.js(`(() => { const w = document.querySelector('#bgTasks'); return { shown: !!w.offsetParent, text: w.textContent, title: w.title }; })()`);
    check(bar.shown && bar.text === 'Downloading dependencies…' && bar.title.includes('shop-api: Downloading from central: spring-boot-starter-web-4.1.2.pom')
      && (await a.js(`${syncTask}`)).cancellable, `the status bar shows "Downloading dependencies…" with the latest output line and Cancel ${q(bar)}`);
    const calm = await a.js(`({ tab: ide.activeTab()?.title, dialog: !!document.querySelector('.dialog-backdrop'), run: ide.toolWindows.get('Run').isVisible(), selected: ide.run.activeSession()?.title })`);
    check(q(calm) === q({ tab: 'ShopApiApplication.java', dialog: false, run: runShown, selected: 'Sync: shop-api' }), `the editor stays usable: no dialog, the Run tool window stays as it was and shows the Sync tab when opened ${q(calm)}`);
    await a.shot('spring-sync.png');

    await a.until(`ide.workspace.entries().some((e) => e.name === 'mvnw spring-boot:run')`, 'mvnw launcher', 30000);
    check(await a.js(`ide.workspace.entries().map((e) => e.name).join()`) === 'mvnw spring-boot:run', 'Launchers lists mvnw spring-boot:run, not the wrapper script on its own');
    const id = await a.js(`ide.workspace.entries().find((e) => e.name === 'mvnw spring-boot:run').id`);
    const consoleText = `[...document.querySelectorAll('.ws-console')].find((h) => h.dataset.id === ${q(id)})?.querySelector('.console')?.textContent || ''`;
    await a.js(`(ide.workspace.run(ide.workspace.entries().find((e) => e.name === 'mvnw spring-boot:run')), true)`);
    await a.until(`(${consoleText}).includes('Waiting for the dependency download to finish')`, 'launcher waits', 10000);

    const cfg = await a.js(`(() => { const c = ide.run.selected(); return c && { type: c.type, name: c.name, tool: c.tool, goals: c.goals, temporary: !!c.temporary }; })()`);
    check(cfg?.type === 'build' && cfg.name === 'ShopApiApplication' && cfg.tool === 'maven' && cfg.goals === 'spring-boot:run' && !cfg.temporary, `a saved Maven configuration "ShopApiApplication" (spring-boot:run) is selected ${q(cfg)}`);
    const gutter = await a.js(`ide.run.types.get('java').forFile(${q(main)})`);
    check(gutter?.type === 'build' && gutter.goals === 'spring-boot:run', `running the application class from its gutter or the project tree uses the build tool, not javac ${q(gutter)}`);
    const runText = `document.querySelector('#runOut')?.textContent || ''`;
    await a.press('Shift+F10');
    await a.until(`ide.run.activeSession()?.title === 'ShopApiApplication' && (${runText}).includes('Waiting for the dependency download to finish')`, 'Run waits', 10000);
    await a.js(`(ide.run.activeSession().stop(), true)`);
    await a.until(`(${runText}).includes('Run cancelled.')`, 'Run cancelled', 10000);
    check(!(await a.js(runText)).includes('spring-boot:run') && await a.js(`!!${syncTask}`), 'Shift+F10 during the download waits for it; Stop cancels the run and the download goes on');
    check(!(await a.js(consoleText)).includes('wrapper spring-boot:run'), 'a Launchers run waits for the download too');
    await a.press('Shift+F10');
    await a.until(`(${runText}).includes('Waiting for the dependency download to finish') && !(${runText}).includes('Run cancelled.')`, 'Run waits again', 10000);

    writeFileSync(path.join(gate, 'mvn-go'), '');
    await a.until(`!${syncTask}`, 'download finished', 30000);
    check((await a.js(syncText('shop-api'))).includes('Dependencies downloaded.') && await a.js(`[...document.querySelectorAll('.ide-balloon.ok')].some((b) => b.textContent.includes('Dependencies downloaded') && b.textContent.includes('Show Output'))`),
      'the download ends: the task leaves the status bar, the tab and a balloon (with Show Output) say the dependencies were downloaded');

    await a.until(`(${consoleText}).includes('Tomcat started')`, 'Tomcat line', 30000).catch(async (err) => { console.log(await a.js(consoleText)); throw err; });
    await a.until(`!!document.querySelector('#wsList .ws-open[data-url="http://localhost:18481/"]')`, 'Tomcat link', 10000);
    const out = await a.js(consoleText);
    check(out.includes('cmd /c .\\mvnw.cmd spring-boot:run') && out.includes('wrapper spring-boot:run'), `then the launcher runs the project's mvnw.cmd (${q(out.slice(0, 300))})`);
    check(out.toLowerCase().includes(`java_home=${jdk.home.toLowerCase()}`), 'with the project\'s JDK as JAVA_HOME');
    check(true, 'the Tomcat port is offered as http://localhost:18481/');
    await a.shot('spring-launcher.png');

    await a.until(`(${runText}).includes('Tomcat started')`, 'Shift+F10 run', 30000);
    const runOut = await a.js(runText);
    check(runOut.includes('.\\mvnw.cmd spring-boot:run') && runOut.includes('wrapper spring-boot:run') && runOut.toLowerCase().includes(`java_home=${jdk.home.toLowerCase()}`), `then Shift+F10 runs mvnw spring-boot:run with the project's JDK in the Run tool window (${q(runOut.slice(0, 300))})`);
    check(await a.js(`!ide.problems.all().some((p) => /does not exist|cannot find symbol/.test(p.msg))`), 'no javac errors about missing Spring classes');
    check(!runOut.includes('The first run downloads'), 'after the download the first run says nothing about downloading');
    check(runOut.includes('The application is running at http://localhost:18481/') && await a.js(`[...document.querySelectorAll('button')].some((b) => b.title === 'Open in Browser' && b.offsetParent)`),
      'the Run tab says where the application runs and offers Open in Browser');
    await a.shot('spring-run.png');

    const before = await a.js(`ide.tasks.list().length`);
    await a.js(`(ide.trusted = false, ide.toolchains.sync(${q(dir)}, 'maven'), true)`);
    check(await a.js(`ide.tasks.list().length`) === before, 'in Safe Mode nothing is downloaded');
    await a.js(`(ide.trusted = true, true)`);
    check(await a.js(`ide.api.invoke('toolchains:build', { tool: 'maven', sync: true, cwd: ${q(dir)}, goals: 'clean' }).then((r) => (ide.proc.kill(r.id), r.command))`) === '.\\mvnw.cmd -B dependency:go-offline', 'a download runs only its own goals, whatever the renderer asks');

    await a.js(`(window.__oldOut = document.querySelector('#runOut'), ide.run.runContext({ type: 'build', name: 'busy', tool: 'maven', goals: 'busy' }), true)`);
    await a.until(`(() => { const o = document.querySelector('#runOut'); return !!o && o !== window.__oldOut && /exit code/.test(o.textContent); })()`, 'busy run', 30000);
    check(/Port 18481 is in use, perhaps by this application started from Launchers or another Run tab/.test(await a.js(`document.querySelector('#runOut').textContent`)), 'a port already in use is explained');

    await openSpring(a);
    await a.until(`document.querySelector('#npSpringBoot').options.length === ${BOOTS}`, 'options again', 15000);
    await chooseJdk(a, jdk.id);
    await a.js(`([['npSpringBuild', 'gradle-project-kotlin'], ['npSpringLanguage', 'kotlin'], ['npSpringPackaging', 'war']].forEach(([n, v]) => document.querySelector('#' + n + ' input[value="' + v + '"]').click()), true)`);
    await setValue(a, '#npName', 'kt-api');
    await a.click('#npCreate');
    await a.until(`document.querySelector('#npCreate').textContent === 'Create'`, 'kt second page');
    await a.click('#npCreate');
    const kt = path.join(where, 'kt-api');
    await a.until(`ide.root && ide.root.toLowerCase() === ${q(kt.toLowerCase())}`, 'kt-api opened', 60000);
    await a.until(`ide.activeTab()?.title === 'KtApiApplication.kt'`, 'Kotlin application class opened');
    const ktCfg = await a.js(`(() => { const c = ide.run.selected(); return c && { type: c.type, name: c.name, tool: c.tool, goals: c.goals }; })()`);
    const ktReq = requests.at(-1);
    check(ktReq.type === 'gradle-project-kotlin' && ktReq.language === 'kotlin' && ktReq.packaging === 'war' && ktCfg?.tool === 'gradle' && ktCfg.goals === 'bootRun' && ktCfg.name === 'KtApiApplication',
      `a Kotlin, Gradle - Kotlin, War project opens its .kt class and gets a Gradle bootRun configuration ${q(ktCfg)}`);
    await a.until(`ide.workspace.entries().some((e) => e.name === 'gradlew bootRun')`, 'gradlew launcher', 30000);
    check(await a.js(`ide.workspace.entries().map((e) => e.name).join()`) === 'gradlew bootRun', 'Launchers lists gradlew bootRun, not gradlew.bat on its own');
    await a.until(`(${syncText('kt-api')}).includes('Task :compileJava') && !!${syncTask}`, 'Gradle dependency download', 30000);
    check((await a.js(syncText('kt-api'))).startsWith('.\\gradlew.bat classes testClasses'), 'a Gradle project downloads with gradlew classes testClasses');
    await a.js(`ide.tasks.cancel(${syncTask}.id)`);
    await a.until(`(${syncText('kt-api')}).includes('Dependency download cancelled.')`, 'Gradle download cancelled', 15000);
    check(await a.js(`!${syncTask} && ![...document.querySelectorAll('.ide-balloon.error')].some((b) => b.textContent.includes('Dependency download failed'))`), 'Cancel in the status bar stops the download without an error');
    await a.js(`(window.__oldOut = document.querySelector('#runOut'), true)`);
    await a.press('Shift+F10');
    await a.until(`(() => { const o = document.querySelector('#runOut'); return !!o && o !== window.__oldOut && o.textContent.includes('Tomcat started'); })()`, 'Gradle Shift+F10 run', 30000);
    const ktOut = await a.js(`document.querySelector('#runOut').textContent`);
    check(ktOut.startsWith('.\\gradlew.bat bootRun') && ktOut.includes('gradle wrapper bootRun') && ktOut.includes('http://localhost:18482/'), `Shift+F10 runs gradlew bootRun (${q(ktOut.slice(0, 160))})`);
    check(ktOut.includes("The first run downloads Gradle and the project's dependencies"), 'without a finished download the first run says it downloads Gradle and the dependencies');

    writeFileSync(path.join(gate, 'gradle-fail'), '');
    await a.js(`(ide.run.sessions().find((s) => s.title === 'Sync: kt-api').rerun(), true)`);
    await a.until(`[...document.querySelectorAll('.ide-balloon.error')].some((b) => b.textContent.includes('Dependency download failed') && b.textContent.includes('kt-api: exit code 1'))`, 'failure balloon', 30000);
    const failOut = await a.js(syncText('kt-api'));
    check(failOut.includes('FAILURE: Could not resolve') && failOut.includes('The dependency download failed. Running the project downloads them again.') && !failOut.includes('cancelled')
      && await a.js(`!${syncTask}`), 'Rerun in the Sync tab downloads again; a failure is an error balloon and a line in the tab');

    await openSpring(a);
    await a.until(`document.querySelector('#npSpringBoot').options.length === ${BOOTS}`, 'options for the remembered choices', 15000);
    const again = await a.js(`['npSpringLanguage', 'npSpringBuild', 'npSpringPackaging'].map((n) => document.querySelector('#' + n + ' input:checked').value).join()`);
    check(again === 'kotlin,gradle-project-kotlin,war', `the wizard comes back with the last project's language, type and packaging (${again})`);

    // ---------- a project name of the user's own ----------
    // The name is typed freely: the artifact follows it until typed, a name Windows would not keep as a folder is
    // refused at Next with the project tree's message, and Initializr gets the name itself (the application class and
    // pom.xml's <name>), while the artifact stays the user's.
    await chooseJdk(a, jdk.id);
    await a.js(`([['npSpringBuild', 'maven-project'], ['npSpringLanguage', 'java'], ['npSpringPackaging', 'jar']].forEach(([n, v]) => document.querySelector('#' + n + ' input[value="' + v + '"]').click()), true)`);
    await setValue(a, '#npName', 'Order Desk');
    const follows = await a.js(`document.querySelector('#npSpringArtifact').placeholder + '|' + document.querySelector('#npSpringPackage').placeholder`);
    check(follows === 'order-desk|com.example.orderdesk', `the artifact and package follow a typed project name (${follows})`);
    // Next refuses an empty name (Create would, with the name field hidden) and one longer than Initializr's 100.
    const nextError = async (value) => {
      await setValue(a, '#npName', value);
      await a.click('#npCreate');
      await a.until(`!!document.querySelector('.np-error').textContent`, `error for ${value.slice(0, 20)}`);
      return `${await a.js(`document.querySelector('.np-error').textContent`)}|${(await pageState(a)).one}`;
    };
    check(await nextError('') === 'Enter a valid project name.|true', 'Next refuses an empty project name');
    check(await nextError('가'.repeat(101)) === 'The project name is too long: at most 100 characters.|true', 'Next refuses a name over 100 characters');
    // The application class is an ASCII identifier whatever the name: the name's ASCII words in PascalCase, else the
    // artifact's, else Demo. A refused request shows what Create sends without making a folder.
    const sentFor = async (value) => {
      await setValue(a, '#npName', value);
      await a.click('#npCreate');
      await a.until(`document.querySelector('#npCreate').textContent === 'Create'`, `second page for ${value}`);
      if (!(await a.js(`document.querySelector('#npSpringDeps input[value="refused"]').checked`))) await toggle(a, 'refused');
      const count = requests.length;
      await a.click('#npCreate');
      await a.until(`/Unknown dependency 'refused'/.test(document.querySelector('.np-error').textContent)`, `refused request for ${value}`, 15000);
      const r = requests.at(-1);
      await a.click('#npPrevious');
      return requests.length > count ? `${r.name}=${r.applicationName}` : 'no request';
    };
    const classes = [await sentFor('주문 관리'), await sentFor('1app'), await sentFor('my.shop app')];
    check(q(classes) === q(['주문 관리=DemoApplication', '1app=DemoApplication', 'my.shop app=MyShopAppApplication']),
      `a Korean name, a leading digit and a dotted name give ASCII application classes and keep the name as typed ${q(classes)}`);
    await setValue(a, '#npSpringArtifact', 'orders');
    const fromArtifact = await sentFor('주문 관리');
    check(fromArtifact === '주문 관리=OrdersApplication', `a name without ASCII letters takes the class from the artifact (${fromArtifact})`);
    await toggle(a, 'refused');
    await setValue(a, '#npName', 'Order Desk:2');
    await a.click('#npCreate');
    await a.until(`!!document.querySelector('.np-error').textContent`, 'bad name error');
    const badMsg = await a.js(`document.querySelector('.np-error').textContent`);
    check(badMsg === 'Order Desk:2 is not a valid name: Windows does not allow : in a name.' && (await pageState(a)).one, `a name Windows would not keep is refused at Next with the project tree's message (${badMsg})`);
    await setValue(a, '#npName', 'Order Desk.');
    await a.click('#npCreate');
    await a.until(`/ends with a dot/.test(document.querySelector('.np-error').textContent)`, 'trailing dot error');
    check((await pageState(a)).one, 'a name ending with a dot is refused too');
    await setValue(a, '#npName', 'Order Desk');
    check(await a.js(`document.querySelector('#npSpringArtifact').value`) === 'orders', 'an artifact typed by hand stays when the name changes');
    await a.click('#npCreate');
    await a.until(`document.querySelector('#npCreate').textContent === 'Create'`, 'order desk second page');
    await a.click('#npCreate');
    const desk = path.join(where, 'Order Desk');
    await a.until(`ide.root && ide.root.toLowerCase() === ${q(desk.toLowerCase())}`, 'Order Desk opened', 60000);
    await a.until(`ide.activeTab()?.title === 'OrderDeskApplication.java'`, 'OrderDeskApplication opened', 15000).catch(() => {});
    const deskReq = requests.at(-1);
    const deskMain = path.join(desk, 'src', 'main', 'java', 'com', 'example', 'orders', 'OrderDeskApplication.java');
    const deskPom = existsSync(path.join(desk, 'pom.xml')) ? readFileSync(path.join(desk, 'pom.xml'), 'utf8') : '';
    check(deskReq.name === 'Order Desk' && deskReq.artifactId === 'orders' && deskReq.packageName === 'com.example.orders' && existsSync(deskMain)
      && deskPom.includes('<artifactId>orders</artifactId><name>Order Desk</name>') && await a.js(`ide.activeTab()?.title`) === 'OrderDeskApplication.java',
      `the project is made in the folder "Order Desk", Initializr gets the name (OrderDeskApplication, <name>Order Desk</name>) and the artifact orders ${q({ name: deskReq.name, artifactId: deskReq.artifactId, packageName: deskReq.packageName })}`);
    const deskCfg = await a.js(`ide.run.selected()?.name`);
    check(deskCfg === 'OrderDeskApplication', `its run configuration is named after the application class (${deskCfg})`);

    // ---------- debugging (Shift+F9 on the Maven / Gradle configuration) ----------
    // A project whose wrappers stand in for Maven and Gradle: they read the debug agent the IDE passes (Maven's
    // -Dspring-boot.run.jvmArguments, Gradle's init script), compile the application and run it in a real JVM.
    const app = path.join(where, 'debugapp');
    const putApp = (rel, text) => { mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); writeFileSync(path.join(app, rel), text); };
    putApp('pom.xml', '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>\n');
    putApp('build.gradle', "plugins { id 'org.springframework.boot' version '4.1.2' }\n");
    putApp('src/main/java/demo/DemoApplication.java', 'package demo;\n\npublic class DemoApplication {\n    public static void main(String[] args) {\n        int answer = 6 * 7;\n        System.out.println("answer " + answer);\n    }\n}\n');
    putApp('fake-build.cjs', `const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
console.log('build tool got: ' + args.join(' '));
let agent = (args.find((a) => a.startsWith('-Dspring-boot.run.jvmArguments=')) || '').slice('-Dspring-boot.run.jvmArguments='.length);
const init = args[args.indexOf('--init-script') + 1];
if (args.includes('--init-script')) agent = /jvmArgs '([^']+)'/.exec(fs.readFileSync(init, 'utf8'))[1];
const bin = path.join(process.env.JAVA_HOME, 'bin');
const out = path.join(__dirname, 'target', 'classes');
spawnSync(path.join(bin, 'javac.exe'), ['-g', '-d', out, path.join(__dirname, 'src', 'main', 'java', 'demo', 'DemoApplication.java')], { stdio: 'inherit' });
const r = spawnSync(path.join(bin, 'java.exe'), [...(agent ? [agent] : []), '-cp', out, 'demo.DemoApplication'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
    putApp('mvnw.cmd', '@"%PYIDE_TEST_NODE%" "%~dp0fake-build.cjs" %*\r\n');
    putApp('gradlew.bat', '@"%PYIDE_TEST_NODE%" "%~dp0fake-build.cjs" %*\r\n');
    await a.js(`ide.openProject(${q(app)})`);
    await a.until(`ide.root && ide.root.toLowerCase() === ${q(app.toLowerCase())}`, 'debugapp opened', 30000);
    await a.js(`ide.settings.set(${q(`toolchains.jdk:${app}`)}, ${q(jdk.id)})`);
    await openFile(a, 'src/main/java/demo/DemoApplication.java');
    // A breakpoint on line 6 (the println), set from the gutter as a user would. On a slow runner code lenses still move
    // the lines when the first click lands, and a debug run without the breakpoint goes straight through.
    const breakpointSet = 'ide.debugger.breakpoints?.().some((b) => b.line === 6) ?? window.__debugger.breakpoints().some((b) => b.line === 6)';
    for (let i = 0; i < 4 && !(await a.js(breakpointSet)); i++) {
      const p6 = await a.js(`(() => { const e = ide.editor; const li = e.getLayoutInfo(); const pos = e.getScrolledVisiblePosition({ lineNumber: 6, column: 1 });
        const r = e.getDomNode().getBoundingClientRect(); return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
      await a.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p6.x, y: p6.y });
      for (const type of ['mousePressed', 'mouseReleased']) await a.cdp('Input.dispatchMouseEvent', { type, x: p6.x, y: p6.y, button: 'left', clickCount: 1, buttons: 1 });
      await a.until(breakpointSet, 'breakpoint set', 5000).catch(() => {});
    }
    const stoppedAt6 = `(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return !!f && f.path?.endsWith('DemoApplication.java') && f.line === 6; })()`;
    for (const [tool, goals, sign] of [['maven', 'spring-boot:run', '-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:'], ['gradle', 'bootRun', '--init-script']]) {
      await a.js(`(ide.run.debugConfig({ ...ide.run.types.get('build').defaults(), id: 'dbg-${tool}', type: 'build', name: 'DemoApplication', tool: '${tool}', goals: '${goals}' }), true)`);
      const hit = await a.until(stoppedAt6, `${tool} stops at the breakpoint`, 120000).then(() => true, () => false);
      const out = await a.js(`document.querySelector('#dbgOut')?.textContent || ''`);
      const vars = await a.js(`document.querySelector('#dbgVars')?.textContent || ''`);
      const ok = hit && out.includes(sign) && vars.includes('answer = {int} 42');
      // A failure shows the whole Debug console, so a run on CI says where it stopped.
      check(ok, `Debug on a ${tool} ${goals} configuration stops at a breakpoint in the application, with its variables (${ok ? q(out.split('\n').slice(0, 2).join(' | ').slice(0, 220)) : q(out.slice(-1500))}; ${q(vars.slice(0, 80))})`);
      await a.js(`(ide.runAction('Resume'), true)`);
      await a.until(`(document.querySelector('#dbgOut')?.textContent || '').includes('answer 42') && !ide.debugger.isActive()`, `${tool} run finishes`, 60000).catch(() => {});
      check((await a.js(`document.querySelector('#dbgOut')?.textContent || ''`)).includes('answer 42') && !(await a.js('ide.debugger.isActive()')), `after Resume the ${tool} application finishes`);
      // The build tool's own processes (cmd.exe, the wrapper) end a moment after the application; the next debug waits.
      await new Promise((r) => setTimeout(r, 1500));
    }
    check(!readdirSync(tmpdir()).some((n) => /^pyide-debug-\d+-\d+\.gradle$/.test(n)), 'the Gradle init script is deleted when the build ends');

    // ---------- the Spring Boot fields of a Maven / Gradle configuration ----------
    const build = (spec) => a.js(`ide.api.invoke('toolchains:build', ${q({ cwd: app, ...spec })}).then((r) => (ide.api.kill(r.id).catch(() => {}), r.command), (e) => 'refused: ' + e.message)`);
    const fields = { profiles: 'dev, local', port: '8097', vmOptions: '-Xmx400m  -Dmy.flag=1', args: '--a=b' };
    const maven = await build({ tool: 'maven', goals: 'spring-boot:run', spring: fields });
    check(maven.includes('"-Dspring-boot.run.jvmArguments=-Xmx400m -Dmy.flag=1"') && maven.includes('"-Dspring-boot.run.profiles=dev,local"') && maven.includes('"-Dspring-boot.run.arguments=--server.port=8097 --a=b"'), `Maven gets the Spring Boot fields as the plugin's properties (${maven})`);
    const gradle = await build({ tool: 'gradle', goals: 'bootRun', spring: fields });
    check(gradle.includes('"--args=--server.port=8097 --spring.profiles.active=dev,local --a=b"') && gradle.includes('--init-script'), `Gradle gets them as --args and the init script (${gradle})`);
    check(!(await build({ tool: 'maven', goals: 'clean package', spring: fields })).includes('spring-boot.run'), 'other goals leave the Spring Boot fields out');
    const refused = await Promise.all(['-Dx=1 & calc', '-Dx="1"', '-Dx=%PATH%', 'a|b', 'a^b', 'C:\\dir\\'].map((vmOptions) => build({ tool: 'maven', goals: 'spring-boot:run', spring: { vmOptions } })));
    check(refused.every((r) => r.startsWith('refused:')), `what cmd.exe would read as syntax is refused (${q(refused.map((r) => r.slice(0, 40)))})`);
    check((await build({ tool: 'maven', goals: 'spring-boot:run', spring: { port: '70000' } })).startsWith('refused:'), 'a port out of range is refused');
  }
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${q(a.consoleErrors)}` : ''}`);
  const internal = await a.js(`ide.api.invoke('diagnostics:errors')`);
  check(!internal.length, `no IDE internal errors${internal.length ? ` ${q(internal).slice(0, 1500)}` : ''}`);
  await a.close();
  a = null;

  if (!REAL) {
    metaFails = 0;
    b = await launch({ fixture: 'core', port: 9776, name: 'spring-boot-ko', lang: 'ko', env });
    await openSpring(b);
    await b.until(`document.querySelector('#npName').value === 'demo'`, 'Spring Boot suggests the name demo', 10000);
    check(true, 'choosing Spring Boot suggests the project name demo');
    await b.until(`document.querySelector('#npSpringBoot').options.length === ${BOOTS}`, 'options', 15000);
    const labels = () => b.js(`[...document.querySelectorAll('#npSpring .field > span, #npSpring .sb-added-title, #npSpring .sb-deps-title')].filter((n) => n.offsetParent).map((n) => n.textContent).join('|') + '|' + document.querySelector('#npCreate').textContent`);
    const one = await labels();
    check(one.startsWith('서버 URL:|언어:|유형:|그룹:|아티팩트:|패키지 이름:|JDK:|Java:|패키징:') && one.endsWith('|다음'), `the first page is in Korean (${one})`);
    await b.shot('spring-wizard-ko.png');
    await setValue(b, '#npName', 'a|b');
    await b.click('#npCreate');
    await b.until(`!!document.querySelector('.np-error').textContent`, 'Korean bad name error');
    const badKo = await b.js(`document.querySelector('.np-error').textContent`);
    check(badKo === '쓸 수 없는 이름입니다(a|b). Windows에서는 이름에 | 문자를 쓸 수 없습니다.', `a refused project name is explained in Korean as in the project tree (${badKo})`);
    await setValue(b, '#npName', 'demo');
    await chooseJdk(b, jdk.id);
    await b.click('#npCreate');
    await b.until(`document.querySelector('#npCreate').textContent === '생성'`, 'Korean second page');
    const two = await labels();
    check(two === 'Spring Boot:|의존성:|추가된 의존성|생성' && await b.js(`document.querySelector('#npPrevious').textContent`) === '이전', `the second page is in Korean (${two})`);
    await b.shot('spring-wizard-ko-2.png');
    check(b.consoleErrors.length === 0, `no renderer exceptions in Korean${b.consoleErrors.length ? ` ${q(b.consoleErrors)}` : ''}`);
    await b.close();
    b = null;

    // ---------- the Spring Boot plugin turned off ----------
    // Spring Boot is a plugin of its own (renderer/features/spring-boot) on top of toolchains: turned off, New Project
    // has no Spring Boot type and its channel is gone, while Java and C/C++ and the Maven / Gradle configuration stay.
    const off = mkdtempSync(path.join(tmpdir(), 'pyide-spring-off-'));
    writeFileSync(path.join(off, 'plugin-state.json'), q({ disabled: ['spring-boot'] }));
    b = await launch({ fixture: 'core', port: 9777, name: 'spring-boot-off', env, userData: off });
    await b.js(`ide.runAction('NewProject')`);
    await b.until(`!!document.querySelector('.np-dialog #npName')`, 'wizard without Spring Boot');
    const typesOff = await b.js(`[...document.querySelectorAll('.np-type')].map((n) => n.dataset.type).join()`);
    check(typesOff.includes('java') && typesOff.includes('cpp') && !typesOff.includes('spring'), `with the Spring Boot plugin off, New Project keeps Java and C/C++ and has no Spring Boot (${typesOff})`);
    check(await b.js(`!!ide.run.types.get('build') && !!ide.run.types.get('java') && !document.querySelector('#npSpring')`), 'the Maven / Gradle and Java Application configurations stay with the toolchains plugin');
    check(await b.js(`ide.api.invoke('spring:defaultServer').then(() => false, () => true)`), 'the Spring Initializr channels are not registered');
    check(b.consoleErrors.length === 0, `no renderer exceptions with the plugin off${b.consoleErrors.length ? ` ${q(b.consoleErrors)}` : ''}`);
  }
} catch (err) {
  if (/^SKIP/.test(err.message)) console.log(err.message);
  else { console.log(`FAIL ${err.stack || err.message}`); results.push(false); }
} finally {
  await a?.close();
  await b?.close();
  server.close();
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
