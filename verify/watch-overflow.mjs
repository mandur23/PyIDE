// The project watchers when Windows drops their changes, plain Node: a burst of file writes while the event loop is
// busy overflows a recursive fs.watch's change buffer, which then reports one change without a name.
// - Pyright (main/lsp-server.js, the real server from node_modules) hears that the project folder changed and reads
//   the project again: a module changed inside the burst no longer shows its old error in a file that imports it, and
//   a change after the burst still arrives;
// - main/project-watch.js tells the window `overflow` (the tree and every open document are checked again) and keeps
//   watching; a window's older watch:project call that answers after a newer one does not undo it.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fs = require('fs');
const work = mkdtempSync(path.join(tmpdir(), 'pyide-watch-overflow-'));
process.env.PYIDE_USER_DATA = path.join(work, 'userdata');
mkdirSync(process.env.PYIDE_USER_DATA, { recursive: true });

let passed = 0;
let failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (fn, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
};
// Thousands of writes in one turn of the event loop: the watcher cannot read its changes meanwhile.
const burst = (dir, n = 3000) => {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(path.join(dir, `f${i}.txt`), String(i));
};

// ---------- Pyright ----------
{
  const project = path.join(work, 'lsp');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'dep.py'), 'def old_name():\n    return 1\n');
  const user = path.join(project, 'user.py');
  const text = 'from dep import new_name\n\nnew_name()\n';
  writeFileSync(user, text);
  const handlers = {};
  const diagnostics = [];
  require(path.join(APP, 'main/features/lsp.js')).register({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { on: () => {} },
    send: (channel, msg) => { if (channel === 'lsp:diagnostics') diagnostics.push(msg); },
    unpackedDir: APP,
  });
  const uri = pathToFileURL(user).href;
  // Pyright's answers spell the drive letter in lower case and escape the colon.
  const userDiags = () => diagnostics.filter((d) => decodeURIComponent(d.uri).toLowerCase() === decodeURIComponent(uri).toLowerCase()).pop()?.diagnostics || null;
  const unknown = () => (userDiags() || []).some((d) => /new_name/.test(d.message));
  let python;
  try { python = execFileSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim(); } catch {}
  try {
    const started = await handlers['lsp:start'](null, project, python, 'en');
    check(started?.gen > 0, `Pyright starts on the project (${JSON.stringify(started)})`);
    await handlers['lsp:notify'](null, 'textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text } });
    check(await until(unknown, 60000), 'the import of a name dep.py does not have is an error');
    // The fix for the error comes at the end of a burst that overflows the watcher's buffer. (The first change of a
    // burst still gets through: the watcher was waiting for it.)
    burst(path.join(project, 'burst'));
    writeFileSync(path.join(project, 'dep.py'), 'def new_name():\n    return 1\n');
    check(await until(() => userDiags() && !unknown(), 30000), `after the buffer overflows, Pyright reads dep.py again (${JSON.stringify((userDiags() || []).map((d) => d.message))})`);
    writeFileSync(path.join(project, 'dep.py'), 'def old_name():\n    return 1\n');
    check(await until(unknown, 30000), 'a change after the overflow still reaches Pyright');
  } catch (err) {
    check(false, err.stack || err.message);
  }
  await handlers['lsp:stop']?.();
}

// ---------- the project tree and open documents ----------
{
  const watchHandlers = {};
  require(path.join(APP, 'main/project-watch.js')).register({ ipcMain: { handle: (name, fn) => { watchHandlers[name] = fn; } } });
  const events = [];
  const sender = { id: 1, isDestroyed: () => false, send: (channel, msg) => { if (channel === 'watch:changed') events.push(msg); }, once: () => {} };
  const watchProject = (root) => watchHandlers['watch:project']({ sender }, root);
  const a = path.join(work, 'tree-a');
  const b = path.join(work, 'tree-b');
  mkdirSync(a);
  mkdirSync(b);
  try {
    check(await watchProject(a) === true, 'watch:project watches the project folder');
    burst(path.join(a, 'burst'));
    check(await until(() => events.some((e) => e.overflow), 5000), `an overflow reaches the window as overflow: true (${events.length} batches)`);
    events.length = 0;
    writeFileSync(path.join(a, 'after.py'), 'x = 1\n');
    check(await until(() => events.some((e) => e.paths.some((p) => p.endsWith('after.py'))), 5000), 'the watcher reports changes after the overflow');

    // The check that the older call's folder can be reached answers after the newer call has started watching.
    const access = fs.promises.access;
    fs.promises.access = async (p, ...rest) => { if (path.resolve(String(p)) === a) await sleep(800); return access.call(fs.promises, p, ...rest); };
    const older = watchProject(a);
    const newer = await watchProject(b);
    const olderAnswer = await older;
    fs.promises.access = access;
    events.length = 0;
    writeFileSync(path.join(b, 'b.py'), 'y = 1\n');
    writeFileSync(path.join(a, 'a2.py'), 'z = 1\n');
    await sleep(1500);
    check(newer === true && olderAnswer === false && events.some((e) => e.root === b) && !events.some((e) => e.root === a),
      `an older watch:project call that answers late leaves the newer project watched (${JSON.stringify({ newer, olderAnswer, roots: events.map((e) => path.basename(e.root)) })})`);
    await watchProject(null);
  } catch (err) {
    check(false, err.stack || err.message);
  }
}

try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch {}
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
