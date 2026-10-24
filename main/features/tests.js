// Test runner backend: pytest with a JSON-lines reporting plugin, or a unittest runner that writes the same events.
// The renderer polls the report file, so events never race the proc:exit message.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { withPath, workingDir } = require('./run.js');
const { withEnvFiles } = require('../dotenv');
const remote = require('../remote');

exports.register = (ctx) => {
  const { ipcMain, startProcess, unpackedDir } = ctx;
  const helpers = path.join(unpackedDir, 'renderer', 'features', 'tests');
  const reports = new Map(); // id -> {file, offset, rest}
  const pytestCache = new Map();

  ipcMain.handle('tests:hasPytest', (_e, interp, fresh) => {
    if (!fresh && pytestCache.has(interp.executable)) return pytestCache.get(interp.executable);
    const p = remote.isRemote(interp)
      ? remote.execPython(interp, ['-c', 'import pytest; print(pytest.__version__)'], { timeout: 60000 }).then((r) => (r.code === 0 ? r.stdout.trim() : null))
      : new Promise((resolve) => {
        execFile(interp.cmd, [...interp.args, '-c', 'import pytest; print(pytest.__version__)'], { timeout: 15000, windowsHide: true },
          (err, stdout) => resolve(err ? null : stdout.trim()));
      });
    pytestCache.set(interp.executable, p);
    return p;
  });

  // A test run's report file, environment and arguments. opts: {runner: 'pytest'|'unittest', targets: string[],
  // args: string[], cwd, root, env, envFiles?} (envFiles as for run:start).
  function prepare({ runner, targets = [], args = [], cwd, root, env = {}, envFiles }) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-tests-')), 'report.jsonl');
    fs.writeFileSync(file, '');
    const runEnv = withPath({ ...withEnvFiles(env, envFiles, root), PYIDE_TEST_REPORT: file }, [helpers, root]);
    // A folder longer than Windows allows runs from its 8.3 form (run.js workingDir), from which pytest picks a rootdir
    // above the project (the temp folder) and collects whatever else is there; the project root is the rootdir then.
    const rootdir = cwd && path.resolve(cwd).length > 258 && !args.some((x) => x.startsWith('--rootdir')) ? [`--rootdir=${root}`] : [];
    const pyArgs = runner === 'pytest'
      ? ['-m', 'pytest', '-p', 'pyide_pytest_plugin', ...rootdir, ...args, ...targets]
      : ['-u', path.join(helpers, 'pyide_unittest_runner.py'), root, ...targets];
    return { file, pyArgs, cwd: cwd || root, env: runEnv };
  }

  ipcMain.handle('tests:start', async (_e, interp, opts) => {
    const { file, pyArgs, cwd, env } = prepare(opts);
    // A local test folder longer than Windows allows runs from its short form or the project root, as Run does.
    const id = await (remote.isRemote(interp) ? remote.startPython(ctx, interp, pyArgs, { cwd, env })
      : startProcess(interp.cmd, [...interp.args, ...pyArgs], { cwd: (await workingDir(cwd, [opts.root])).cwd, env }));
    reports.set(id, { file, offset: 0 });
    return { id, command: [interp.cmd, ...interp.args, ...pyArgs].join(' ') };
  });

  // The same run for the debugger, which starts the process (debug:start): what to hand to it, and the report id for
  // tests:poll. The env already holds the .env files, so debug:start applying them again changes nothing.
  let debugRuns = 0;
  ipcMain.handle('tests:debugTarget', (_e, interp, opts) => {
    const { file, pyArgs, cwd, env } = prepare(opts);
    const id = `debug-${++debugRuns}`;
    reports.set(id, { file, offset: 0 });
    const [script, ...params] = pyArgs[0] === '-u' ? pyArgs.slice(1) : pyArgs;
    return { id, script, params, cwd, env, command: [interp.cmd, ...interp.args, '-m', 'debugpy', ...pyArgs].join(' ') };
  });

  // Returns events appended since the last poll; `final` releases the report.
  ipcMain.handle('tests:poll', (_e, id, final) => {
    const r = reports.get(id);
    if (!r) return [];
    let chunk = '';
    try {
      const buf = fs.readFileSync(r.file);
      // Consume whole lines only, so a write in progress never splits a UTF-8 sequence.
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end > r.offset) {
        chunk = buf.subarray(r.offset, end).toString('utf8');
        r.offset = end;
      }
    } catch {}
    const lines = chunk.split('\n');
    lines.pop();
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    if (final) {
      reports.delete(id);
      fs.rm(path.dirname(r.file), { recursive: true, force: true }, () => {});
    }
    return events;
  });
};
