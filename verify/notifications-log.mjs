// Pure Node (no window): main/features/notifications.js writes the event log in batches. A burst of notifications
// is one asynchronous write ~250 ms later (temp file + rename), long texts are cut to 2 KB in the saved log, and what
// is still pending at will-quit is written synchronously, so the next start lists it.
import fs from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const cjsFs = require('fs');
const { register, WRITE_DELAY, TEXT_MAX } = require('../main/features/notifications.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = fs.mkdtempSync(path.join(tmpdir(), 'pyide-notifications-log-'));
const file = path.join(userData, 'notifications', 'log.json');
const inDir = (p) => String(p).startsWith(path.join(userData, 'notifications'));
const writes = { async: 0, sync: 0 };
const realWriteFile = cjsFs.promises.writeFile;
const realWriteFileSync = cjsFs.writeFileSync;
cjsFs.promises.writeFile = (p, ...rest) => { if (inDir(p)) writes.async++; return realWriteFile(p, ...rest); };
cjsFs.writeFileSync = (p, ...rest) => { if (inDir(p)) writes.sync++; return realWriteFileSync(p, ...rest); };

function start() {
  const handlers = new Map();
  const quit = [];
  const api = register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, app: { getPath: () => userData, on: (ev, fn) => ev === 'will-quit' && quit.push(fn) } });
  return { api, call: (ch, ...args) => handlers.get(ch)({}, ...args), quit: () => quit.forEach((fn) => fn()) };
}
const saved = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const entry = (i, extra = {}) => ({ time: 1000 + i, title: `n${i}`, text: `text ${i}`, kind: 'info', group: 'g', ...extra });

let failed = 0;
let count = 0;
const check = (ok, label) => { count++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
try {
  // A burst: nothing is written while it lasts, then one write holds all of it.
  const a = start();
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await a.call('notifications:append', entry(i, i === 0 ? { text: 'x'.repeat(20000) } : {}));
  check(writes.async === 0 && writes.sync === 0 && saved() === null, 'a burst of 60 notifications writes nothing synchronously');
  while (saved() === null && Date.now() - t0 < 5000) await sleep(20);
  await a.api.idle();
  const after = Date.now() - t0;
  check(saved()?.length === 60 && writes.async === 1 && writes.sync === 0, `the burst is one asynchronous write (${writes.async} writes, ${after} ms after the first notification)`);
  check(after >= WRITE_DELAY - 20, `the write waits for the burst (${after} ms >= ${WRITE_DELAY} ms)`);
  check(saved()[0].text.length === TEXT_MAX && saved()[1].text === 'text 1', `a 20 KB text is saved as its first ${TEXT_MAX} characters`);
  check(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')), 'no temp file is left behind');

  // More than 200 entries: the oldest go.
  for (let i = 60; i < 260; i++) await a.call('notifications:append', entry(i));
  await sleep(WRITE_DELAY + 100);
  await a.api.idle();
  check(saved().length === 200 && saved()[0].title === 'n60' && writes.async === 2, 'the log keeps the newest 200 entries, again in one write');

  // Pending at quit: written synchronously at will-quit, and no late asynchronous write follows.
  await a.call('notifications:append', [entry(300), entry(301)]);
  a.quit();
  check(writes.sync === 1 && saved().at(-1).title === 'n301', 'notifications still pending at will-quit are written synchronously');
  await sleep(WRITE_DELAY + 150);
  await a.api.idle();
  check(writes.async === 2 && saved().at(-1).title === 'n301', 'no asynchronous write follows the one at quit');

  // The next start lists them as earlier notifications.
  const b = start();
  const previous = await b.call('notifications:previous');
  check(previous.length === 200 && previous.at(-1).title === 'n301', 'the next start lists the log written at quit');
  await b.call('notifications:clear');
  b.quit();
  check(saved()?.length === 0, 'Clear empties the saved log (written at quit at the latest)');
  const quitWrites = writes.sync;
  start().quit();
  check(writes.sync === quitWrites, 'quitting with nothing pending writes nothing');
} catch (err) {
  check(false, err.stack);
} finally {
  cjsFs.promises.writeFile = realWriteFile;
  cjsFs.writeFileSync = realWriteFileSync;
  fs.rmSync(userData, { recursive: true, force: true });
}
console.log(`${count - failed}/${count} passed`);
process.exit(failed ? 1 : 0);
