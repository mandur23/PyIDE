// Hostile project content: notebooks that are not notebooks, a 50 MB one-line file, a 15 MB one-line file, binary
// and NUL bytes, invalid UTF-8, UTF-16 without a BOM, a million lines, 300 nested folders, a junction back to the
// project, a file another process holds locked, a read-only file, names with emoji, Korean, trailing dots and spaces,
// and a folder named like a Python file. Each one opens (or is refused with a readable message) without a crash, a
// hang, an internal error, or a long renderer or main-process stall, which the renderer measures while it works
// (port 9863).
import { launch } from './lib.mjs';
import { spawn, execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'pyide-hostile-project-'));
const project = path.join(work, 'project');
cpSync(path.join(APP_DIR, 'verify', 'fixtures', 'core'), project, { recursive: true });
const P = (...p) => path.join(project, ...p);
const LONG = (p) => `\\\\?\\${p}`; // names Windows would otherwise trim (trailing dots and spaces)
const DEEP = ['deep', ...Array(300).fill('d')];

// ---------- the project ----------
writeFileSync(P('nb_badjson.ipynb'), '{"cells": [ {"cell_type": "code", "source": "print(1)"');
writeFileSync(P('nb_missing.ipynb'), JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code' }, { cell_type: 'markdown' }, {}] }));
writeFileSync(P('nb_kinds.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: 5, cells: [null, 5, 'x', { cell_type: 'code', source: 5, outputs: 'x', metadata: null }, { cell_type: 'code', source: ['a = 1'], outputs: [null, 5, { output_type: 'stream', text: 7 }, { output_type: 'display_data', data: null }, { output_type: 'error', traceback: 'x' }] }] }));
writeFileSync(P('nb_cells_null.ipynb'), JSON.stringify({ nbformat: 4, cells: null }));
writeFileSync(P('nb_huge.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
  { cell_type: 'code', id: 'a', metadata: {}, execution_count: 1, source: ['for i in range(200000): print(i)'], outputs: [{ output_type: 'stream', name: 'stdout', text: Array.from({ length: 200000 }, (_, i) => `line ${i} ${'x'.repeat(40)}\n`) }] },
  { cell_type: 'code', id: 'b', metadata: {}, execution_count: 2, source: ['img'], outputs: [{ output_type: 'display_data', metadata: {}, data: { 'image/png': Buffer.alloc(4 * 1024 * 1024, 7).toString('base64'), 'text/plain': ['<img>'] } }] },
] }));
writeFileSync(P('line50mb.txt'), 'x'.repeat(50 * 1024 * 1024));
writeFileSync(P('line15mb.py'), `s = "${'y'.repeat(15 * 1024 * 1024)}"\n`);
writeFileSync(P('binary.py'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.alloc(5000, 0xab)]));
writeFileSync(P('late_nul.py'), `${'a = 1\n'.repeat(2000)}b = "\u0000\u0000"\n`);
writeFileSync(P('invalid_utf8.py'), Buffer.concat([Buffer.from('s = "'), Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xff, 0xfe, 0xe2, 0x82]), Buffer.from('"\n')]));
writeFileSync(P('utf16_nobom.py'), Buffer.from('print("hello")\n# 한글\n', 'utf16le'));
writeFileSync(P('million.py'), 'x = 1\n'.repeat(1000000));
mkdirSync(LONG(P(...DEEP)), { recursive: true });
writeFileSync(LONG(P(...DEEP, 'bottom.py')), 'print("bottom")\n');
mkdirSync(P('sub'));
execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', P('sub', 'loop'), project], { stdio: 'ignore' });
writeFileSync(P('locked.py'), 'print("locked")\n');
writeFileSync(P('readonly.py'), 'print("readonly")\n');
chmodSync(P('readonly.py'), 0o444);
writeFileSync(P('😀 emoji.py'), 'print("emoji")\n');
writeFileSync(P('한글 파일.py'), 'print("한글")\n');
writeFileSync(LONG(P('trailing.')), 'trailing dot\n');
writeFileSync(LONG(P('trailing ')), 'trailing space\n');
mkdirSync(P('x.py'));
writeFileSync(P('x.py', 'inner.py'), 'print("inner")\n');
// Launchers the project declares, with entries and fields of the wrong kind.
mkdirSync(P('.claude'));
writeFileSync(P('.claude', 'launch.json'), JSON.stringify({ configurations: [null, 5, { name: 'web', runtimeExecutable: 'python', cwd: 5, runtimeArgs: { a: 1 }, env: 'x', port: 'x' }] }));

// Another process holds a file open with no sharing at all, as a running program or a backup tool can.
const lockers = [];
const lock = async (file) => {
  const ps = `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); Write-Output locked; Start-Sleep 600`;
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] });
  lockers.push(p);
  await new Promise((r) => p.stdout.once('data', r));
};
const cleanup = () => {
  for (const p of lockers) p.kill();
  try { execFileSync('cmd.exe', ['/d', '/c', 'rmdir', P('sub', 'loop')], { stdio: 'ignore' }); } catch {}
};

const t = await launch({ fixture: 'core', port: 9863, name: 'hostile-project', projectDir: project });
const { js, check, sleep } = t;
// A renderer that hangs answers no CDP call at all: the run ends with a failure instead of waiting forever.
setTimeout(() => { console.log('FAIL the IDE stopped answering (watchdog)'); cleanup(); t.close(); process.exit(1); }, 8 * 60 * 1000).unref();
try {
  // Renderer long tasks and IPC round trips to the main process, measured while each case runs.
  await js(`(() => {
    window.__stall = { task: 0, ipc: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) __stall.task = Math.max(__stall.task, e.duration); }).observe({ entryTypes: ['longtask'] });
    (async () => { for (;;) { const t0 = performance.now(); await api.invoke('workspace:openedUrls'); __stall.ipc = Math.max(__stall.ipc, performance.now() - t0); await new Promise((r) => setTimeout(r, 40)); } })();
    return true;
  })()`);
  const dialogText = () => js(`[...document.querySelectorAll('#dialogHost .dialog-message')].map((n) => n.textContent).join(' | ')`);
  const closeDialogs = () => js(`document.querySelectorAll('#dialogHost .dialog-backdrop').forEach((d) => d.remove())`);
  // Runs one case and returns {value, ms, task, ipc, msg}: its result, wall time, longest renderer task, longest IPC
  // round trip, and the text of any message dialog it showed.
  async function scenario(name, run) {
    await js(`(__stall.task = 0, __stall.ipc = 0)`);
    const t0 = Date.now();
    let value;
    try { value = await Promise.race([run(), sleep(60000).then(() => 'TIMEOUT')]); } catch (err) { value = `threw ${err.message.split('\n').pop()}`; }
    const ms = Date.now() - t0;
    await sleep(1200);
    const s = await js(`({ ...__stall })`);
    const msg = await dialogText();
    await closeDialogs();
    const r = { value, ms, task: Math.round(s.task), ipc: Math.round(s.ipc), msg };
    console.log(`  ${name.padEnd(24)} ${String(ms).padStart(6)} ms  task ${String(r.task).padStart(5)}  ipc ${String(r.ipc).padStart(5)}  ${String(value).slice(0, 60)}  ${msg.slice(0, 100)}`);
    return r;
  }
  const open = (...rel) => () => js(`ide.openFile(${JSON.stringify(P(...rel))}).then((t) => t ? { kind: t.viewer?.id || t.kind, lines: t.model?.getLineCount?.() ?? 0, text: t.model?.getValue?.().slice(0, 40) ?? '' } : null)`);
  // No case may hold the renderer or the main process for long: the worst ones (a 15 MB line, a million lines) take
  // about 1.5 s once, when Monaco builds the model and its view.
  const smooth = (r, label, ms = 2500) => check(r.value !== 'TIMEOUT' && r.task < ms && r.ipc < ms, `${label} (renderer ${r.task} ms, IPC ${r.ipc} ms)`);

  for (const f of ['nb_badjson.ipynb', 'nb_missing.ipynb', 'nb_kinds.ipynb', 'nb_cells_null.ipynb']) {
    const r = await scenario(`open ${f}`, open(f));
    smooth(r, `${f} opens as a notebook or with its error`);
    check(r.value?.kind === 'notebook', `${f} shows in the notebook viewer`);
  }
  const huge = await scenario('open nb_huge.ipynb', open('nb_huge.ipynb'));
  smooth(huge, 'a notebook with 200,000 output lines and a 4 MB image opens', 1000);
  check(await js(`[...document.querySelectorAll('.nb-dropped')].some((n) => n.textContent.includes('1 MB'))`), 'its long output says only the last 1 MB is shown');
  const big = await scenario('open line50mb.txt', open('line50mb.txt'));
  check(big.value?.kind === 'binary' && big.task < 1000, 'a 50 MB file opens in the "too large" view');
  const line = await scenario('open line15mb.py', open('line15mb.py'));
  smooth(line, 'a 15 MB single-line Python file opens');
  const typing = await scenario('type on the 15 MB line', async () => {
    await js(`ide.editor.setPosition({ lineNumber: 1, column: 5 })`);
    for (let i = 0; i < 10; i++) await js(`ide.editor.trigger('k', 'type', { text: 'z' })`);
    return js(`ide.activeTab().model.getLineContent(1).slice(0, 16)`);
  });
  // Every edit sends the whole text to Pyright and ruff, which costs the main process about 0.2 s per 15 MB.
  smooth(typing, 'typing on the 15 MB line');
  for (const [f, kind] of [['binary.py', 'binary'], ['utf16_nobom.py', 'binary'], ['late_nul.py', 'file'], ['invalid_utf8.py', 'file']]) {
    const r = await scenario(`open ${f}`, open(f));
    check(r.value?.kind === kind && r.task < 1000, `${f} opens as ${kind === 'file' ? 'text' : 'binary'}`);
  }
  const million = await scenario('open million.py', open('million.py'));
  smooth(million, 'a million-line file opens');
  const edits = await scenario('edit million.py', async () => {
    for (let i = 0; i < 20; i++) await js(`ide.editor.trigger('k', 'type', { text: 'z' })`);
    return js(`ide.activeTab().model.getLineCount()`);
  });
  smooth(edits, 'typing in the million-line file', 1000);
  for (const f of ['😀 emoji.py', '한글 파일.py']) check((await scenario(`open ${f}`, open(f))).value?.lines === 2, `${f} opens`);
  for (const [f, text] of [['trailing.', 'trailing dot'], ['trailing ', 'trailing space']]) {
    const r = await scenario(`open "${f}"`, open(f));
    check(r.value?.text?.startsWith(text) || r.msg, `"${f}" opens with its own text or a message (${JSON.stringify(r.value?.text ?? r.msg)})`);
  }
  const deep = await scenario('open deep bottom.py', open(...DEEP, 'bottom.py'));
  check(deep.value?.lines === 2, 'a file 300 folders deep opens');

  // A folder named x.py, opened as a file, and a locked file: a readable message, not Node's error text.
  const folder = await scenario('open x.py (a folder)', open('x.py'));
  check(folder.value === null && /folder, not a file/.test(folder.msg), `a folder opened as a file says so (${folder.msg})`);
  await lock(P('locked.py'));
  const locked = await scenario('open locked.py', open('locked.py'));
  check(locked.value === null && /in use by another program/.test(locked.msg), `a locked file says it is in use (${locked.msg})`);
  // Saving: a read-only file, and an open file that another program locks afterwards.
  for (const [f, re, before] of [['readonly.py', /Access is denied/, null], ['hello.py', /in use by another program/, () => lock(P('hello.py'))]]) {
    await js(`ide.openFile(${JSON.stringify(P(f))})`);
    if (before) await before();
    const r = await scenario(`save ${f}`, async () => {
      await js(`ide.activeTab().model.setValue('changed = 1\\n')`);
      await js(`ide.saveTab(ide.activeTab())`);
      return js(`ide.isDirty(ide.activeTab())`);
    });
    check(r.value === true && re.test(r.msg), `saving ${f} keeps it modified and says why (${r.msg})`);
  }

  // The tree: the junction is a folder that opens (once, not forever), the deep path reveals.
  const junction = await scenario('tree junction', async () => {
    const entry = (await js(`ide.api.list(${JSON.stringify(P('sub'))})`)).find((e) => e.name === 'loop');
    await js(`ide.revealInTree(${JSON.stringify(P('sub', 'loop', 'hello.py'))})`);
    return { dir: entry?.dir, rows: await js(`ide.selectedTreeEntry()?.path`) };
  });
  check(junction.value?.dir === true && junction.value.rows === P('sub', 'loop', 'hello.py'), 'a junction to a folder lists as a folder and opens');
  smooth(await scenario('tree reveal deep', () => js(`ide.revealInTree(${JSON.stringify(P(...DEEP, 'bottom.py'))}).then(() => ide.selectedTreeEntry()?.name)`)), 'revealing a file 300 folders deep');
  smooth(await scenario('tree refresh', () => js(`ide.refreshTree().then(() => document.querySelectorAll('#tree .node').length)`)), 'refreshing the tree with the junction open');
  // Project-wide walks do not follow the junction back into the project.
  const walk = await scenario('go to file walk', () => js(`ide.api.walk(ide.root).then((l) => l.length)`));
  check(walk.value > 10 && walk.value < 100 && walk.ms < 3000, `Go to File lists the project once (${walk.value} files)`);
  smooth(await scenario('find in files', () => js(`ide.api.invoke('search:find', ide.root, { query: 'print' }, {}).then((r) => JSON.stringify(r).length)`)), 'Find in Files over the project');
  smooth(await scenario('todos', () => js(`ide.api.invoke('search:todos', ide.root, {}).then((r) => JSON.stringify(r).length)`)), 'the TODO scan');
  const launchers = await scenario('workspace scan', () => js(`ide.api.invoke('workspace:scan', ide.root).then((r) => JSON.stringify(r))`));
  smooth(launchers, 'the launcher scan');
  check(String(launchers.value).includes('"web"'), 'a launch.json with entries of the wrong kind still lists its valid launcher');
  await scenario('close all', () => js(`ide.closeAllTabs(true)`));
  check(readFileSync(P('readonly.py'), 'utf8') === 'print("readonly")\n', 'the read-only file is unchanged');
  await sleep(2000);
  const internal = await js(`ide.api.invoke('diagnostics:errors').then((l) => l.map((e) => e.message + ' @ ' + (e.stack || '').split('\\n').slice(1, 3).join(' | ')))`);
  check(internal.length === 0, `no internal errors${internal.length ? `:\n  ${internal.join('\n  ')}` : ''}`);
} catch (err) {
  check(false, err.message);
} finally {
  cleanup();
}
t.finish();
