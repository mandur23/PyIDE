// Test runner backend: pytest with a JSON-lines reporting plugin, or a unittest runner that writes the same events.
// The renderer polls the report file, so events never race the proc:exit message.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { withPath } = require('./run.js');

exports.register = ({ ipcMain, startProcess, unpackedDir }) => {
  const helpers = path.join(unpackedDir, 'renderer', 'features', 'tests');
  const reports = new Map(); // id -> {file, offset, rest}
  const pytestCache = new Map();

  ipcMain.handle('tests:hasPytest', (_e, interp, fresh) => {
    if (!fresh && pytestCache.has(interp.executable)) return pytestCache.get(interp.executable);
    const p = new Promise((resolve) => {
      execFile(interp.cmd, [...interp.args, '-c', 'import pytest; print(pytest.__version__)'], { timeout: 15000, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout.trim()));
    });
    pytestCache.set(interp.executable, p);
    return p;
  });

  // opts: {runner: 'pytest'|'unittest', targets: string[], args: string[], cwd, root, env}
  ipcMain.handle('tests:start', (_e, interp, { runner, targets = [], args = [], cwd, root, env = {} }) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-tests-')), 'report.jsonl');
    fs.writeFileSync(file, '');
    const runEnv = withPath({ ...env, PYIDE_TEST_REPORT: file }, [helpers, root]);
    const argv = runner === 'pytest'
      ? [...interp.args, '-m', 'pytest', '-p', 'pyide_pytest_plugin', ...args, ...targets]
      : [...interp.args, '-u', path.join(helpers, 'pyide_unittest_runner.py'), root, ...targets];
    const id = startProcess(interp.cmd, argv, { cwd: cwd || root, env: runEnv });
    reports.set(id, { file, offset: 0 });
    return { id, command: [interp.cmd, ...argv].join(' ') };
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
