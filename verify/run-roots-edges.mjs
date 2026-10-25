// Edges of the source roots and run configuration fields (round 034): a namespace package under src (src/acme/tools,
// no __init__.py anywhere) is a src layout for Run and Pyright alike; excluding a folder keeps a virtualenv named venv
// out of Pyright's file list; Redirect input from releases the input file when the program exits without reading it;
// a run with Emulate terminal ends when the page reloads; Debug works with the interpreter options -E and -I.
// Port 9633.
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const require = createRequire(import.meta.url);
const q = JSON.stringify;
const unit = [];
const unitCheck = (ok, label) => { unit.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
};

// ---------- project-roots.js (pure Node) ----------
{
  const base = tempDir('run-roots-edges-unit');
  process.env.PYIDE_USER_DATA = path.join(base, 'userdata');
  const roots = require('../main/project-roots.js');
  const deepNs = write(path.join(base, 'deepns'), { 'src/acme/tools/helper.py': '' });
  const webSrc = write(path.join(base, 'websrc'), { 'src/app/components/button.js': '', 'src/app/index.html': '' });
  unitCheck(roots.srcLayout(deepNs), 'src/ whose top folder holds only subfolders of Python code (a namespace package) is a src layout');
  unitCheck(!roots.srcLayout(webSrc), 'a src/ holding no Python code at any depth is not');
  delete process.env.PYIDE_USER_DATA;
}

const project = write(path.join(tempDir('run-roots-edges'), 'proj'), {
  'src/acme/tools/helper.py': 'def nsfunc():\n    return 7\n',
  'use_ns.py': 'from acme.tools.helper import nsfunc\n\nprint("NS", nsfunc())\n',
  'venv/pyvenv.cfg': 'home = C:\\nowhere\n',
  'venv/Lib/site-packages/fakevenvpkg/__init__.py': 'class ZzVenvOnlySymbol:\n    pass\n',
  'generated/gen_mod.py': 'class ZzGeneratedSymbol:\n    pass\n',
  'quiet.py': 'print("QUIET")\n',
  'flags_env.py': 'import sys\n\nprint("FLAGS", sys.flags.ignore_environment, sys.flags.isolated)\n',
  'forever_child.py': [
    'import os, subprocess, sys, time',
    '',
    'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])',
    'print(f"PIDS {os.getpid()} {child.pid}", flush=True)',
    'while True:',
    '    time.sleep(0.2)',
    '',
  ].join('\n'),
});
const inputs = path.join(project, 'inputs');
write(inputs, { 'big.txt': 'x'.repeat(8 << 20) });

const config = (extra) => `({ ...ide.run.types.get('python').defaults(), id: 'cfg-' + Math.random().toString(36).slice(2), type: 'python', ...${q(extra)}, script: ide.util.joinPath(ide.root, ${q(extra.script)}) })`;
const sessionText = `(document.querySelector('.run-session:not(.hidden) .console')?.textContent || '')`;
const termText = `(() => { const b = ide.run.activeSession()?.term?.buffer.active; if (!b) return ''; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`;
const DBG_OUT = `(document.querySelector('#dbgOut')?.textContent || '')`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const t = await launch({ port: 9633, name: 'run-roots-edges', projectDir: project });
const { js, until, check, sleep } = t;
const leftovers = [];
try {
  check(unit.every((u) => u.ok), `project-roots.js: ${unit.filter((u) => u.ok).length}/${unit.length} pure Node checks (listed above)`);
  const runAndRead = async (extra, label) => {
    await js(`ide.run.runConfig(${config({ name: extra.script, ...extra })}).then(() => true)`);
    await until(`${sessionText}.includes('Process finished with exit code')`, label, 40000);
    return js(sessionText);
  };

  // ---------- a namespace package under src ----------
  await until(`ide.projectRoots && ide.projectRoots.get().sources.includes('src')`, 'src detected as a source root', 20000).catch(() => {});
  check(await js(`ide.projectRoots.get().sources.includes('src')`), `src holding src/acme/tools/helper.py is marked as a sources root (${q(await js('ide.projectRoots.get()'))})`);
  let out = await runAndRead({ script: 'use_ns.py' }, 'run use_ns.py');
  check(out.includes('NS 7') && out.includes('exit code 0'), `Run imports acme.tools.helper from src (${q(out.slice(-200))})`);
  await openFile(t, 'use_ns.py');
  await until(`ide.lsp.ready()`, 'Pyright ready', 60000);
  const definition = `ide.lsp.request('textDocument/definition', { textDocument: { uri: ide.monaco.Uri.file(ide.util.joinPath(ide.root, 'use_ns.py')).toString() }, position: { line: 0, character: 32 } }).then((r) => JSON.stringify(r || []))`;
  const resolved = await until(`${definition}.then((s) => /src[\\\\/]+acme[\\\\/]+tools[\\\\/]+helper\\.py/i.test(decodeURIComponent(s)))`, 'Pyright resolves nsfunc', 30000).catch(() => false);
  const problems = await js(`ide.problems.all().filter((p) => p.source === 'pyright' && p.path.toLowerCase().endsWith('use_ns.py')).map((p) => p.msg)`);
  check(resolved && !problems.some((m) => /could not be resolved/.test(m)), `the editor resolves the same import to src/acme/tools/helper.py, with no unresolved import (${q(problems)})`);

  // ---------- Excluded keeps venv/ out of Pyright's files ----------
  const symbols = (name) => `ide.lsp.request('workspace/symbol', { query: ${q(name)} }).then((r) => (r || []).map((s) => s.location?.uri || '').join(' '))`;
  await until(`${symbols('ZzGeneratedSymbol')}.then((s) => s.length > 0)`, 'generated/ symbol indexed', 30000);
  check((await js(symbols('ZzVenvOnlySymbol'))) === '', 'before any exclusion, the virtualenv venv/ is not in Pyright\'s files');
  await js(`ide.projectRoots.mark(ide.util.joinPath(ide.root, 'generated'), 'excluded').then(() => true)`);
  await until(`${symbols('ZzGeneratedSymbol')}.then((s) => s === '')`, 'generated/ leaves Pyright\'s files', 30000);
  let venvSeen = '';
  for (let i = 0; i < 16 && !venvSeen; i++) { venvSeen = await js(symbols('ZzVenvOnlySymbol')); await sleep(500); }
  check(!venvSeen, `after Mark Directory As › Excluded on generated/, venv/ still stays out (${venvSeen ? decodeURIComponent(venvSeen) : 'not found'})`);

  // ---------- Redirect input from releases the file ----------
  out = await runAndRead({ script: 'quiet.py', stdinFile: 'inputs\\big.txt' }, 'run quiet.py with an 8 MB input');
  check(out.includes('QUIET') && out.includes('exit code 0'), 'a program that reads none of its 8 MB input file runs and exits');
  let moved = null;
  for (let i = 0; i < 10 && moved === null; i++) {
    try { renameSync(inputs, `${inputs}-moved`); moved = true; } catch (err) { if (i === 9) moved = err.code; else await sleep(300); }
  }
  check(moved === true, `after it exits, the input file's folder can be renamed: nothing holds the file open (${moved})`);

  // ---------- a terminal run and a page reload ----------
  await js(`ide.run.runConfig(${config({ name: 'forever_child', script: 'forever_child.py', emulateTerminal: true })}).then(() => true)`);
  await until(`/PIDS \\d+ \\d+/.test(${termText})`, 'forever_child.py runs in a terminal', 30000);
  const pids = (/PIDS (\d+) (\d+)/.exec(await js(termText)) || []).slice(1).map(Number);
  leftovers.push(...pids);
  check(pids.length === 2 && pids.every(alive), `the program and its child run (${pids})`);
  await js(`(setTimeout(() => location.reload(), 50), true)`);
  await sleep(1500);
  await until(`!!window.ide?.root && !!ide.run`, 'the page is back', 30000);
  for (let i = 0; i < 30 && pids.some(alive); i++) await sleep(300);
  check(!pids.some(alive), `reloading the page ends the terminal run and its child (${pids.map((p) => `${p} ${alive(p) ? 'alive' : 'gone'}`)})`);

  // ---------- Debug with -E and -I ----------
  for (const [opts, want] of [['-E', 'FLAGS 1 0'], ['-I', 'FLAGS 1 1']]) {
    await js(`(window.__lastDebugOut = ${DBG_OUT}, true)`);
    await js(`ide.run.debugConfig(${config({ name: `flags ${opts}`, script: 'flags_env.py', interpOptions: opts })}).then(() => true, () => true)`);
    await until(`!ide.debugger.isActive() && ${DBG_OUT} !== window.__lastDebugOut && ${DBG_OUT}.includes('Process finished')`, `debug with ${opts}`, 40000).catch(() => {});
    const text = await js(DBG_OUT);
    check(text.includes(want) && text.includes('exit code 0'), `Debug with the interpreter option ${opts} starts and runs the program (${q(text.slice(-300))})`);
  }
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await t.shot('failure.png').catch(() => {});
} finally {
  for (const pid of leftovers) if (alive(pid)) { try { process.kill(pid); } catch {} }
}
t.finish();
