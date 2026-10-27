// Crash recovery's main-process side (main/features/recovery.js) in plain Node, with a stand-in ipcMain and window:
// the session folder made again after it is deleted under a running session, which sessions count as over (a live
// process never, however old its heartbeat; a pid from before the computer restarted always), backups aged out (older
// than 30 days, project deleted, but not a project on a drive that is not connected), and the listing reading only the
// metadata line. Usage: node verify/recovery-main.mjs [path of the module to test].
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { tempDir } from './lib.mjs';

const require = createRequire(import.meta.url);
const modulePath = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main', 'features', 'recovery.js'));
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600000;
const bootTime = Date.now() - os.uptime() * 1000;
const fileOf = (id) => `${createHash('sha1').update(id).digest('hex')}.backup`;
const tryCall = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e.message.split('\n')[0] }; } };

// One PyIDE process as the module sees it: its handlers, one window, and what the window was sent.
async function start(userData) {
  await sleep(5); // two sessions started in one millisecond would share a folder
  const handlers = {};
  const sent = [];
  const wc = { id: 1, on() {}, once() {}, isDestroyed: () => false, send: (ch) => sent.push(ch) };
  require(modulePath).register({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    app: { getPath: () => userData, on() {} },
    getWindow: () => ({ webContents: wc }),
  });
  const call = async (ch, ...args) => {
    if (!handlers[ch]) throw new Error(`no ${ch} handler`);
    return handlers[ch]({ sender: wc }, ...args);
  };
  const put = (name, text, extra = {}) => call('recovery:put', { id: `untitled:${name}`, name, untitled: true, path: null, time: Date.now(), ...extra, text });
  return { call, put, sent };
}

// A backup another (dead or live) session left: {dir: <pid>-<start>, name, meta, text, mtime}.
function leave(userData, { dir, name, meta = {}, text = 'text', mtime = null }) {
  const folder = path.join(userData, 'backups', dir);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, fileOf(`untitled:${name}`));
  writeFileSync(file, `${JSON.stringify({ path: null, name, untitled: true, project: null, time: mtime || Date.now(), ...meta })}\n${text}`);
  if (mtime) utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}
const listed = (list) => list.map((r) => r.name).sort().join();

const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
await new Promise((r) => dead.once('exit', r));
try {
  // ---------- the session folder deleted under a running session ----------
  {
    const userData = tempDir('recovery-main-folder');
    const a = await start(userData);
    await a.put('one.py', 'one');
    await a.put('two.py', 'two');
    const folder = path.join(userData, 'backups', readdirSync(path.join(userData, 'backups'))[0]);
    rmSync(folder, { recursive: true, force: true });
    // Windows finishes a delete only when the last handle closes (an antivirus scan of a file just written); the folder
    // made again before that would vanish with it.
    for (let i = 0; i < 50 && existsSync(folder); i++) await sleep(100);
    const again = await tryCall(() => a.put('one.py', 'one again'));
    const file = path.join(folder, fileOf('untitled:one.py'));
    check(!again.error && existsSync(file) && readFileSync(file, 'utf8').endsWith('\none again'),
      `the next backup after the session folder was deleted makes it again (${again.error || 'written'})`);
    check(a.sent.includes('recovery:lost'), `the windows are asked to write the backups they hold again (${a.sent.join() || 'nothing sent'})`);
    a.sent.length = 0;
    rmSync(folder, { recursive: true, force: true });
    await sleep(11000);
    check(existsSync(folder) && a.sent.includes('recovery:lost'), 'without an edit, the folder is made again and the windows asked within 10 s');
    let session = null;
    try { session = JSON.parse(readFileSync(path.join(folder, 'session.json'), 'utf8')); } catch {}
    check(session?.pid === process.pid && Date.now() - session.beat < 15000 && !existsSync(path.join(folder, 'session.json.tmp')),
      `session.json, which older PyIDE versions read, is complete and current (${JSON.stringify(session)})`);
  }

  // ---------- which sessions are over ----------
  {
    const userData = tempDir('recovery-main-alive');
    const hourAgo = Date.now() - 3600000;
    const started = Date.now() - 60000;
    leave(userData, { dir: `${live.pid}-${started}`, name: 'live-quiet.py' });
    writeFileSync(path.join(userData, 'backups', `${live.pid}-${started}`, 'session.json'), JSON.stringify({ pid: live.pid, beat: hourAgo }));
    leave(userData, { dir: `${live.pid}-${started + 1}`, name: 'live-no-session-json.py' });
    const beforeBoot = Math.round(bootTime - 3600000);
    leave(userData, { dir: `${live.pid}-${beforeBoot}`, name: 'pid-reused-after-restart.py' });
    writeFileSync(path.join(userData, 'backups', `${live.pid}-${beforeBoot}`, 'session.json'), JSON.stringify({ pid: live.pid, beat: Date.now() }));
    leave(userData, { dir: `${dead.pid}-${hourAgo}`, name: 'dead.py' });
    leave(userData, { dir: `${process.pid}-${hourAgo}`, name: 'own-pid-earlier.py' });
    const b = await start(userData);
    const pending = await tryCall(() => b.call('recovery:pending', null));
    const names = pending.error || listed(pending.value);
    check(names === 'dead.py,own-pid-earlier.py,pid-reused-after-restart.py',
      `offered: a dead pid, this process's pid in an earlier folder, a pid from before the computer restarted (${names})`);
    check(existsSync(path.join(userData, 'backups', `${live.pid}-${started}`)) && existsSync(path.join(userData, 'backups', `${live.pid}-${started + 1}`)),
      'a running process\'s folder is kept, with a heartbeat an hour old or no session.json at all');
  }

  // ---------- aging out ----------
  {
    const userData = tempDir('recovery-main-age');
    const other = tempDir('recovery-main-other-project');
    const missing = path.join(os.tmpdir(), `pyide-recovery-no-such-project-${process.pid}`);
    const freeDrive = [...'ZYXWVUTSRQPONMLKJIHG'].find((l) => !existsSync(`${l}:\\`));
    const dir = `${dead.pid}-${Date.now() - 60000}`;
    const files = {
      old: leave(userData, { dir, name: 'old.py', mtime: Date.now() - 31 * DAY }),
      gone: leave(userData, { dir, name: 'gone.py', meta: { project: missing } }),
      other: leave(userData, { dir, name: 'other.py', meta: { project: other } }),
      unplugged: leave(userData, { dir, name: 'unplugged.py', meta: { project: `${freeDrive}:\\project` } }),
      recent: leave(userData, { dir, name: 'recent.py', mtime: Date.now() - 29 * DAY }),
    };
    const c = await start(userData);
    const pending = await tryCall(() => c.call('recovery:pending', null));
    check((pending.error || listed(pending.value)) === 'recent.py', `with no project open only recent.py is offered (${pending.error || listed(pending.value)})`);
    const left = Object.entries(files).filter(([, f]) => existsSync(f)).map(([k]) => k).join();
    check(left === 'other,unplugged,recent', `a backup older than 30 days and one of a deleted project are deleted; another project's, one on drive ${freeDrive}: (not connected) and a 29-day-old one stay (${left})`);
  }

  // ---------- the listing reads only the metadata line ----------
  {
    const userData = tempDir('recovery-main-meta');
    const other = tempDir('recovery-main-big-project');
    const dir = `${dead.pid}-${Date.now() - 60000}`;
    leave(userData, { dir, name: 'small.py', text: 'small text\nline 2' });
    const d = await start(userData);
    const t0 = performance.now();
    await d.call('recovery:pending', null);
    const small = performance.now() - t0;
    const big = 'x'.repeat(40 * 1024 * 1024);
    for (let i = 0; i < 4; i++) leave(userData, { dir, name: `big${i}.py`, meta: { project: other }, text: big });
    const t1 = performance.now();
    const pending = await d.call('recovery:pending', null);
    const withBig = performance.now() - t1;
    check(withBig < small + 100, `four 40 MB backups of another project add little to the listing (${small.toFixed(1)} ms without, ${withBig.toFixed(1)} ms with)`);
    const rec = pending.find((r) => r.name === 'small.py');
    check(rec && !('text' in rec) && typeof rec.ref === 'string', `the listing carries no text, and names the backup to read (${JSON.stringify(rec && Object.keys(rec))})`);
    const text = await tryCall(() => d.call('recovery:text', rec?.ref));
    check(text.value === 'small text\nline 2', `recovery:text reads the backed-up text (${text.error || JSON.stringify(text.value)})`);
    check((await d.call('recovery:text', '../../outside.backup')) === null, 'recovery:text refuses a path that is not a backup');
  }
} catch (err) {
  check(false, err.stack || err.message);
} finally {
  live.kill();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
