// The Automation tool window (right side) against a stand-in docker: a Node script that answers `version`,
// `compose config --services`, `compose ps` and the commands the buttons start, keeping the services' state in a file
// beside the compose file, and that refuses to read the file while .env leaves DB_PASSWORD empty, in docker's own
// words. No real Docker, container, image or network; the build task runs a gradlew.bat that only echoes.
// Checks: the window is on the right and lists the compose file, its Dockerfile-less services and the Gradle tasks; an
// empty required variable shows docker's error with what to do, and Refresh after fixing .env lists the services;
// Up starts them through a Run tab named after the command, and their rows turn to running with their ports; a
// service's Stop and Start; Down; Logs; a Gradle task and a typed one run through the wrapper; Docker missing and the
// engine not running each say so; a project without any of it says there is nothing; Korean. A task with "Run in a
// container" ticked runs docker run with the JDK image of the Java the build names, the project mounted and the wrapper
// read with its line endings fixed, and the tick is kept; a project with a Dockerfile alone builds, runs (its EXPOSEd
// port published) and stops it. Port 9942.
// Usage: node verify/automation.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-automation-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
write(path.join(project, 'compose.yaml'), 'services:\n  web:\n    build: .\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD in .env}\n    ports:\n      - "8080:8080"\n  cache:\n    image: redis:7\n');
write(path.join(project, '.env'), 'DB_PASSWORD=\n');
write(path.join(project, 'Dockerfile'), 'FROM scratch\n');
write(path.join(project, 'build.gradle'), "plugins {\n    id 'java'\n    id 'org.springframework.boot' version '3.5.0'\n}\njava {\n    toolchain {\n        languageVersion = JavaLanguageVersion.of(17)\n    }\n}\n");
write(path.join(project, 'gradlew'), '#!/bin/sh\r\necho unix wrapper\r\n');
const only = path.join(work, 'Only App');
write(path.join(only, 'Dockerfile'), 'FROM scratch\nEXPOSE 3000 9000/udp\nEXPOSE 3001/tcp\n');
write(path.join(project, 'settings.gradle'), "rootProject.name = 'demo'\n");
write(path.join(project, 'gradlew.bat'), '@echo off\r\necho gradlew ran: %*\r\n');
write(path.join(project, 'src', 'Main.java'), 'class Main {}\n');
const empty = path.join(work, 'empty');
write(path.join(empty, 'notes.txt'), 'nothing to run\n');

// The stand-in: `mode` (a file beside it) is ok, off (the engine does not answer) or absent.
const fake = path.join(work, 'fake-docker.cjs');
write(fake, `const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
const mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8').trim();
if (a[0] === 'version') {
  if (mode === 'off') { console.log('29.0.0|'); console.error('error during connect: the docker daemon is not running'); process.exit(1); }
  console.log('29.0.0|29.0.0'); process.exit(0);
}
if (['run', 'build', 'stop'].includes(a[0])) { console.log('docker did: ' + a.join(' ')); process.exit(0); }
if (a[0] !== 'compose' || a[1] !== '-f') { console.error('unknown: ' + a.join(' ')); process.exit(2); }
const file = a[2];
const dir = path.dirname(file);
const cmd = a[3];
const rest = a.slice(4).filter((x) => !x.startsWith('-') && !/^\\d+$/.test(x) && x !== 'json');
const env = fs.existsSync(path.join(dir, '.env')) ? fs.readFileSync(path.join(dir, '.env'), 'utf8') : '';
if (!/^DB_PASSWORD=.+$/m.test(env)) {
  console.error('time="2026-01-01T00:00:00+09:00" level=warning msg="The \\\\"X\\\\" variable is not set."');
  console.error('error while interpolating services.web.environment.DB_PASSWORD: required variable DB_PASSWORD is missing a value: Set DB_PASSWORD in .env');
  process.exit(1);
}
const stateFile = path.join(dir, 'fake-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const all = ['web', 'cache'];
const picked = rest.length ? rest : all;
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (cmd === 'config') { console.log(all.join('\\n')); process.exit(0); }
if (cmd === 'ps') {
  for (const s of all) if (state[s]) console.log(JSON.stringify({ Service: s, State: state[s], Status: state[s] === 'running' ? 'Up 2 seconds' : 'Exited (0)', Health: '', Publishers: s === 'web' ? [{ PublishedPort: 8080, TargetPort: 8080 }, { PublishedPort: 0, TargetPort: 9 }] : [] }));
  process.exit(0);
}
if (cmd === 'up' || cmd === 'start' || cmd === 'restart') { for (const s of picked) { state[s] = 'running'; console.log(' Container demo-' + s + '-1  Started'); } save(); process.exit(0); }
if (cmd === 'stop') { for (const s of picked) { state[s] = 'exited'; console.log(' Container demo-' + s + '-1  Stopped'); } save(); process.exit(0); }
if (cmd === 'down') { for (const s of all) { delete state[s]; console.log(' Container demo-' + s + '-1  Removed'); } save(); process.exit(0); }
if (cmd === 'build') { console.log('built ' + picked.join(' ')); process.exit(0); }
if (cmd === 'logs') { for (const s of picked) console.log(s + '-1  | ready'); process.exit(0); }
console.error('unknown compose command ' + cmd); process.exit(2);
`);
const setMode = (m) => writeFileSync(path.join(work, 'mode'), m);
setMode('ok');
const DOCKER = S([process.execPath, fake]);

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const list = `document.querySelector('#autoList')`;
const run = async (t) => {
  const { js, until, shot, sleep } = t;
  const serviceRows = () => js(`JSON.stringify([...${list}.querySelectorAll('.auto-service')].map((r) => [r.dataset.service, r.querySelector('.auto-dot').classList.contains('on'), r.querySelector('.auto-state').textContent]))`);
  const tabText = (name) => js(`(ide.run.sessions().find((s) => s.name === ${S(name)} || s.title === ${S(name)})?.host.textContent) || ''`);
  const finished = (name) => until(`/Process finished with exit code 0/.test((ide.run.sessions().find((s) => s.name === ${S(name)} || s.title === ${S(name)})?.host.textContent) || '')`, `${name} finished`, 20000);
  const press = (expr) => js(`(${list}.querySelector(${S(expr)}).click(), true)`);
  await until('window.__ideReady === true', 'ready', 60000);
  await js(`(ide.toolWindows.get('Automation').show(), true)`);
  await until(`!!${list}?.querySelector('.auto-file')`, 'the compose file listed', 15000);
  const place = await js(`(() => { const r = ${list}.getBoundingClientRect(); const e = document.querySelector('#editorArea').getBoundingClientRect(); return { right: r.left >= e.right - 2, button: !!document.querySelector('.stripe-btn[data-tool="Automation"]') }; })()`);
  check(place.right && place.button, `the Automation window opens right of the editor, with its button in the stripe (${S(place)})`);
  const first = await js(`({ file: ${list}.querySelector('.auto-file-name').textContent, tasks: [...${list}.querySelectorAll('.auto-task')].map((r) => r.dataset.task), heads: [...${list}.querySelectorAll('.auto-head-title')].map((n) => n.textContent), note: ${list}.querySelector('.auto-docker .auto-head-note')?.textContent })`);
  check(first.file === 'compose.yaml' && S(first.heads) === S(['Docker', 'Gradle']) && S(first.tasks) === S(['bootRun', 'bootJar', 'build', 'test', 'clean']) && first.note === 'Docker 29.0.0',
    `it lists the compose file, Docker's version and the Gradle tasks a Spring Boot build has (${S(first)})`);

  // ---------- docker's own refusal, and what to do ----------
  await until(`!!${list}.querySelector('.auto-error')`, 'the error', 15000);
  const refused = await js(`({ error: ${list}.querySelector('.auto-file .auto-error').textContent, hint: ${list}.querySelector('.auto-file .auto-hint').textContent, rows: ${list}.querySelectorAll('.auto-service').length })`);
  check(/required variable DB_PASSWORD is missing a value/.test(refused.error) && !/level=warning/.test(refused.error) && /DB_PASSWORD/.test(refused.hint) && /\.env/.test(refused.hint) && refused.rows === 0,
    `an empty required variable shows docker's error without its warnings, and says which value to give in .env (${S(refused)})`);
  await shot('error.png');
  writeFileSync(path.join(project, '.env'), 'DB_PASSWORD=secret\n');
  await js(`(document.querySelector('#autoRefresh').click(), true)`);
  await until(`${list}.querySelectorAll('.auto-service').length === 2 && !${list}.querySelector('.auto-error')`, 'services after the fix', 15000);
  check(await serviceRows() === S([['cache', false, 'Not created'], ['web', false, 'Not created']]), `Refresh after .env is fixed lists the services, not created yet (${await serviceRows()})`);

  // ---------- Up, a service's Stop and Start, Down, Logs ----------
  await press('.auto-up');
  await finished('docker compose up');
  const up = await tabText('docker compose up');
  check(/^docker compose -f .*compose\.yaml up -d/m.test(up) && /demo-web-1\s+Started/.test(up), `Up runs docker compose up -d in a Run tab named after it (${S(up.slice(0, 160))})`);
  await until(`${list}.querySelectorAll('.auto-service .auto-dot.on').length === 2`, 'both running', 15000);
  check(await serviceRows() === S([['cache', true, 'Running'], ['web', true, 'Running · :8080']]), `the services turn to running, with the port published (${await serviceRows()})`);
  await shot('running.png');
  await press('.auto-service[data-service="web"] .auto-stop');
  await finished('docker compose stop web');
  await until(`!${list}.querySelector('.auto-service[data-service="web"] .auto-dot.on')`, 'web stopped', 15000);
  check(await serviceRows() === S([['cache', true, 'Running'], ['web', false, 'Stopped · :8080']]) && await js(`!!${list}.querySelector('.auto-service[data-service="web"] .auto-start')`), `Stop on a service stops that one and offers Start (${await serviceRows()})`);
  await press('.auto-service[data-service="web"] .auto-start');
  await finished('docker compose up web');
  await until(`!!${list}.querySelector('.auto-service[data-service="web"] .auto-dot.on')`, 'web running again', 15000);
  check(true, 'Start on a stopped service starts it again');
  await press('.auto-service[data-service="cache"] .auto-logs');
  await finished('docker compose logs cache');
  check(/cache-1\s+\| ready/.test(await tabText('docker compose logs cache')), 'Logs on a service shows its output in a Run tab');
  await press('.auto-down');
  await finished('docker compose down');
  await until(`${list}.querySelectorAll('.auto-service .auto-dot.on').length === 0`, 'all down', 15000);
  check(await serviceRows() === S([['cache', false, 'Not created'], ['web', false, 'Not created']]), `Down removes the containers (${await serviceRows()})`);

  // ---------- Gradle ----------
  await press('.auto-task[data-task="build"] .auto-run');
  await finished('gradlew build');
  check(/gradlew ran: build/.test(await tabText('gradlew build')), `a Gradle task runs through the project's wrapper (${S((await tabText('gradlew build')).slice(0, 120))})`);
  await js(`(() => { const i = ${list}.querySelector('.auto-gradle .auto-custom-input'); i.value = 'bootJar -x test'; i.closest('form').requestSubmit(); return true; })()`);
  await finished('gradlew bootJar -x test');
  check(/gradlew ran: bootJar -x test/.test(await tabText('gradlew bootJar -x test')), 'a typed task runs too');

  // ---------- the same tasks in a container ----------
  const box = `${list}.querySelector('.auto-gradle .auto-container-box')`;
  check(/Java 17/.test(await js(`${list}.querySelector('.auto-gradle .auto-container').textContent`)) && await js(`!${box}.checked && !${box}.disabled`), 'Run in a container names the Java the build asks for (17), off at first');
  await js(`(${box}.click(), true)`);
  await press('.auto-task[data-task="build"] .auto-run');
  await finished('gradle build (container)');
  const boxed = await tabText('gradle build (container)');
  check(/docker did: run --rm -v .*project:\/workspace -w \/workspace -v nano-studio-gradle:\/root\/\.gradle .*eclipse-temurin:17-jdk sh -c sed 's\/\\r\$\/\/' gradlew \| sh -s -- build/.test(boxed) && !/-p 127/.test(boxed) && /eclipse-temurin:17-jdk/.test(boxed.split('\n')[1] || ''),
    `ticked, a task runs in a container of that JDK with the project mounted and the wrapper's line endings fixed (${S(boxed.slice(0, 420))})`);
  await press('.auto-task[data-task="bootRun"] .auto-run');
  await finished('gradle bootRun (container)');
  check(/-p 127\.0\.0\.1:8080:8080/.test(await tabText('gradle bootRun (container)')) && /localhost:8080/.test(await tabText('gradle bootRun (container)')), 'bootRun in a container publishes the application\'s port and says where it answers');
  await js(`(document.querySelector('#autoRefresh').click(), true)`);
  await sleep(800);
  check(await js(`${box}.checked`), 'the tick is kept');
  await js(`(${box}.click(), true)`);

  // ---------- Docker's engine off, Docker missing ----------
  setMode('off');
  await js(`(document.querySelector('#autoRefresh').click(), true)`);
  await until(`!!${list}.querySelector('.auto-docker-off')`, 'engine off', 15000);
  const off = await js(`({ text: ${list}.querySelector('.auto-docker-off').textContent, disabled: [...${list}.querySelectorAll('.auto-file-head button')].every((b) => b.disabled), tasks: ${list}.querySelectorAll('.auto-task').length })`);
  check(/engine is not running/.test(off.text) && off.disabled && off.tasks === 5, `with the engine off it says so, the compose buttons are off and the Gradle tasks stay (${S(off)})`);
  setMode('ok');
  await sleep(200);
};

let t = await launch({ name: 'automation', port: 9942, projectDir: project, env: { PYIDE_DOCKER: DOCKER } });
try { await run(t); } catch (err) { check(false, err.message); await t.shot('failure.png').catch(() => {}); } finally { t.close(); }

// Korean, Docker missing, and a project with nothing to run.
t = await launch({ name: 'automation', port: 9942, projectDir: project, lang: 'ko', env: { PYIDE_DOCKER: 'none' } });
try {
  const { js, until, shot } = t;
  await until('window.__ideReady === true', 'ready', 60000);
  await js(`(ide.toolWindows.get('Automation').show(), true)`);
  await until(`!!${list}?.querySelector('.auto-docker-missing')`, 'docker missing', 15000);
  const ko = await js(`({ title: document.querySelector('.stripe-btn[data-tool="Automation"]').dataset.tooltip, missing: ${list}.querySelector('.auto-docker-missing').textContent, buttons: [...${list}.querySelectorAll('.auto-file-head button')].map((b) => b.textContent + (b.disabled ? '' : '!')) })`);
  check(ko.title === '자동화' && /Docker를 찾지 못했습니다/.test(ko.missing) && S(ko.buttons) === S(['올리기', '내리기', '빌드', '로그']), `without Docker it says so in Korean and the compose buttons are off (${S(ko)})`);
  await shot('missing-ko.png');
} catch (err) { check(false, err.message); } finally { t.close(); }

t = await launch({ name: 'automation', port: 9942, projectDir: empty, env: { PYIDE_DOCKER: DOCKER } });
try {
  const { js, until } = t;
  await until('window.__ideReady === true', 'ready', 60000);
  await js(`(ide.toolWindows.get('Automation').show(), true)`);
  await until(`!!${list}?.querySelector('.auto-empty')`, 'nothing', 15000);
  check(/Nothing to automate here/.test(await js(`${list}.textContent`)), 'a project without a compose file, a Dockerfile or a build says there is nothing to automate');
} catch (err) { check(false, err.message); } finally { t.close(); }
// A Dockerfile alone: built, run and stopped by itself.
t = await launch({ name: 'automation', port: 9942, projectDir: only, env: { PYIDE_DOCKER: DOCKER } });
try {
  const { js, until } = t;
  await until('window.__ideReady === true', 'ready', 60000);
  await js(`(ide.toolWindows.get('Automation').show(), true)`);
  await until(`!!${list}?.querySelector('.auto-dockerfile') && !${list}.querySelector('.auto-dockerfile button').disabled`, 'the Dockerfile row', 15000);
  const tab = (name) => js(`(ide.run.sessions().find((s) => s.name === ${S(name)} || s.title === ${S(name)})?.host.textContent) || ''`);
  const done = (name) => until(`/Process finished with exit code 0/.test((ide.run.sessions().find((s) => s.name === ${S(name)} || s.title === ${S(name)})?.host.textContent) || '')`, `${name} finished`, 20000);
  check(S(await js(`[...${list}.querySelectorAll('.auto-dockerfile button')].map((b) => b.textContent)`)) === S(['Build Images', 'Run', 'Stop']), 'a project with a Dockerfile and no compose file offers Build, Run and Stop for it');
  await js(`(${list}.querySelector('.auto-image-build').click(), true)`);
  await done('docker build nano-only-app');
  check(/docker did: build -t nano-only-app -f .*Dockerfile .*Only App/.test(await tab('docker build nano-only-app')), `Build makes an image named after the project's folder (${S((await tab('docker build nano-only-app')).slice(0, 200))})`);
  await js(`(${list}.querySelector('.auto-image-run').click(), true)`);
  await done('docker run nano-only-app');
  const ran = await tab('docker run nano-only-app');
  check(/docker did: run --rm --name nano-only-app -p 127\.0\.0\.1:3000:3000 -p 127\.0\.0\.1:3001:3001 nano-only-app/.test(ran) && !/9000/.test(ran), `Run publishes the TCP ports the Dockerfile EXPOSEs (${S(ran.slice(0, 220))})`);
  await js(`(${list}.querySelector('.auto-image-stop').click(), true)`);
  await done('docker stop nano-only-app');
  check(/docker did: stop nano-only-app/.test(await tab('docker stop nano-only-app')), 'Stop stops that container');
} catch (err) { check(false, err.message); } finally { t.close(); }
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
