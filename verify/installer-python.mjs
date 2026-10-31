// PyIDE's own Python (main/installer/python.js, the Install Manager's Python Interpreters): on a computer with no
// Python on PATH a notification offers it; installing downloads the official python.org NuGet package from a feed,
// checks its sha256, extracts tools/ under the install root and lists it as "PyIDE Python" in the interpreter picker,
// a script runs with it, Use as Project Interpreter selects it, removing it takes it off the list, and a tampered
// package is refused with nothing installed. Korean session: the card has no English. Ports 9626-9627.
// The real package (14.8 MB) is downloaded once into verify/out/downloads-cache and served from a local HTTP server.
import { createServer } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const J = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '3.13.17';
const NAME = `python.${VERSION}.nupkg`;
const cache = path.join(HERE, 'out', 'downloads-cache');
mkdirSync(cache, { recursive: true });
const cached = path.join(cache, NAME);
if (!existsSync(cached)) {
  console.log(`downloading ${NAME} into ${cache}`);
  const res = await fetch(`https://api.nuget.org/v3-flatcontainer/python/${VERSION}/${NAME}`);
  if (!res.ok) { console.log(`FAIL could not download ${NAME}: HTTP ${res.status}`); process.exit(1); }
  writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
}
const good = readFileSync(cached);
const tampered = Buffer.from(good);
tampered[tampered.length >> 1] ^= 0xff;
let serve = 'good';
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (!req.url.endsWith(`/${NAME}`)) { res.writeHead(404); res.end(); return; }
  const body = serve === 'good' ? good : tampered;
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feed = `http://127.0.0.1:${server.address().port}/feed`;

const work = mkdtempSync(path.join(tmpdir(), 'pyide-installer-python-'));
const root = path.join(work, 'root');
const exe = path.join(root, 'python', VERSION, 'python.exe');
// No Python on PATH: the py launcher (C:\Windows) and the Store aliases are left out.
const PATH = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Wbem')].join(';');
const env = { PYIDE_INSTALL_ROOT: root, PYIDE_PYTHON_FEED: feed, PATH, Path: PATH };
const ID = 'python:3.13';
const card = `.inst-card[data-id="${ID}"]`;

const t = await launch({ fixture: 'installer-python', port: 9626, name: 'installer-python', env });
const { js, until, check, sleep } = t;
const waitPhase = (want, ms = 120000) => until(`document.querySelector('${card}')?.dataset.phase === '${want}'`, `${ID} ${want}`, ms)
  .catch(async (err) => { throw new Error(`${err.message}; card: ${J(await js(`(() => { const c = document.querySelector('${card}'); return c && { phase: c.dataset.phase, log: c.querySelector('.inst-log')?.textContent.slice(-800) }; })()`))}`); });
try {
  // With no interpreter at all, a notification offers PyIDE Python; its button installs it.
  await until(`[...document.querySelectorAll('.ide-balloon')].some((b) => /No Python interpreter found/.test(b.textContent))`, 'no-interpreter notification', 30000)
    .then(() => check(true, 'with no Python on the computer, a notification offers Nano Studio Python'), () => check(false, 'with no Python on the computer, a notification offers Nano Studio Python'));
  check(await js(`!(ide.interps || []).some((i) => !i.invalid)`), 'no interpreter is listed before the install');
  await js(`(() => { const b = [...document.querySelectorAll('.ide-balloon')].find((x) => /No Python interpreter found/.test(x.textContent));
    [...b.querySelectorAll('.ide-balloon-action')].find((a) => /Install Nano Studio Python 3\\.13/.test(a.textContent)).click(); return true; })()`);
  await until(`!!document.querySelector('${card}')`, 'Install Manager shows the card');
  await waitPhase('installed');
  check(existsSync(exe), `the interpreter is extracted to ${exe}`);
  check(!existsSync(path.join(root, 'python', NAME)) && !existsSync(path.join(root, 'python', `${VERSION}.extract`)), 'the package and the staging folder are gone');
  check(requests.some((u) => u === `/feed/${NAME}`), `the package came from the feed (${J(requests)})`);
  check(await js(`ide.settings.get('interpreters.extra', []).some((p) => ide.util.samePath(p, ${J(exe)}))`), 'it is added to interpreters.extra');
  await until(`(ide.interps || []).some((i) => ide.util.samePath(i.executable, ${J(exe)}))`, 'listed', 20000);
  const label = await js(`ide.interps.find((i) => ide.util.samePath(i.executable, ${J(exe)})).label`);
  check(label === `Nano Studio Python (Python ${VERSION})`, `the picker lists it as Nano Studio Python (${label})`);

  // Use as Project Interpreter, then a script runs with it.
  await js(`(() => { [...document.querySelectorAll('${card} button')].find((b) => b.textContent === 'Use as Project Interpreter').click(); return true; })()`);
  await until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${J(exe)})`, 'selected', 10000)
    .then(() => check(true, 'Use as Project Interpreter selects it'), () => check(false, 'Use as Project Interpreter selects it'));
  await openFile(t, 'main.py');
  await js(`(ide.runAction('RunClass'), true)`);
  await until(`(ide.run.activeSession()?.con?.out?.textContent || '').includes('exit code')`, 'run finished', 60000);
  const out = await js(`ide.run.activeSession().con.out.textContent`);
  check(out.includes(`RUNNING ${VERSION}`) && out.toLowerCase().includes(path.join(root, 'python', VERSION).toLowerCase()), `main.py runs with Nano Studio Python (${J(out.slice(-200))})`);

  // While a program runs with it, Remove keeps it whole and says why.
  const remove = async () => {
    await js(`(() => { document.querySelector('${card} [data-op="uninstall"]').click(); return true; })()`);
    await until(`[...document.querySelectorAll('.dialog')].some((d) => /stop working/.test(d.textContent))`, 'remove confirmation');
    await js(`(() => { const d = [...document.querySelectorAll('.dialog')].find((x) => /stop working/.test(x.textContent)); [...d.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Remove').click(); return true; })()`);
  };
  await openFile(t, 'wait.py');
  await js(`(ide.runAction('RunClass'), true)`);
  await until(`(ide.run.activeSession()?.con?.out?.textContent || '').includes('WAITING')`, 'wait.py running', 60000);
  await remove();
  await waitPhase('failed');
  const busy = await js(`document.querySelector('${card} .inst-message')?.textContent || ''`);
  check(/in use by a running program/.test(busy), `removing it while a program runs with it is refused (${busy.slice(0, 160)})`);
  check(existsSync(exe) && existsSync(path.join(path.dirname(exe), 'Lib', 'site-packages', 'pip', '__init__.py')), 'and the interpreter is left whole');
  await js(`(ide.run.activeSession().stop(), true)`);
  await until(`ide.run.activeSession()?.running === false`, 'wait.py stopped', 20000);
  await sleep(500);

  // Remove: off the disk and off the list.
  await remove();
  await waitPhase('notInstalled');
  check(!existsSync(path.dirname(exe)), 'removing it deletes its folder');
  check(await js(`!ide.settings.get('interpreters.extra', []).some((p) => ide.util.samePath(p, ${J(exe)}))`), 'removing it takes it out of interpreters.extra');
  check(await js(`!ide.currentInterp() || !ide.util.isUnder(ide.currentInterp().executable, ${J(path.dirname(exe))})`), "the project no longer uses it once it is removed (the IDE's own helpers let go of it first)");

  // A tampered package fails its checksum and leaves nothing behind.
  serve = 'tampered';
  await js(`(ide.installer.run(${J(ID)}, 'install'), true)`);
  await waitPhase('failed');
  const message = await js(`document.querySelector('${card} .inst-message')?.textContent || ''`);
  check(/Checksum mismatch/.test(message), `a tampered package is refused (${message.slice(0, 160)})`);
  check(!existsSync(path.dirname(exe)) && !existsSync(path.join(root, 'python', `${NAME}.part`)), 'nothing is installed from it');
  serve = 'good';
} catch (err) {
  check(false, err.message);
}
t.close();
const earlier = t.results;

// ---------------- Korean ----------------
const k = await launch({ fixture: 'installer-python', port: 9627, name: 'installer-python-ko', lang: 'ko-KR', env });
k.results.push(...earlier);
try {
  await k.js(`(ide.installer.open('interpreters'), true)`);
  await k.until(`document.querySelector('${card}')?.dataset.phase === 'notInstalled'`, 'card checked', 30000);
  const title = await k.js(`document.querySelector('${card}').textContent`);
  k.check(title.includes('Nano Studio Python 3.13') && title.includes('관리자 권한이 필요 없고'), 'the card is in Korean');
  const leaks = await englishLeaks(k, card, ['PyIDE', 'Python', 'NuGet', 'pip', 'venv', 'tkinter', 'PATH']);
  k.check(!leaks.length, `the card has no English (${J(leaks)})`);
  k.check(await k.js(`[...document.querySelectorAll('.ide-balloon')].some((b) => /Python 인터프리터를 찾을 수 없습니다/.test(b.textContent))`), 'the notification is in Korean');
} catch (err) {
  k.check(false, err.message);
}
server.close();
k.finish();
