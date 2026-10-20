// Run with Coverage: each run gets a temp folder for coverage.py's data file and the summary that
// pyide_coverage_run.py writes when the program ends. The renderer reads the summary once, which removes the folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

exports.register = ({ ipcMain, app, unpackedDir }) => {
  const boot = path.join(unpackedDir, 'renderer', 'features', 'coverage', 'pyide_coverage_run.py');
  const runs = new Set(); // temp folders handed out and not read yet
  // A run whose result is never read (replaced by a rerun while it ran, or never started) leaves its folder until quit.
  app.on('will-quit', () => { for (const dir of runs) fs.rmSync(dir, { recursive: true, force: true }); });

  // -> coverage.py version in the interpreter, or null when it is not installed
  ipcMain.handle('coverage:version', (_e, interp) => new Promise((resolve) => {
    execFile(interp.cmd, [...interp.args, '-c', 'import coverage; print(coverage.__version__)'], { timeout: 30000, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim()));
  }));

  ipcMain.handle('coverage:prepare', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-coverage-'));
    runs.add(dir);
    return { boot, dir, data: path.join(dir, '.coverage'), summary: path.join(dir, 'summary.json') };
  });

  // -> {version, files: {path: {...}}} or null when the run wrote no summary (killed, or coverage failed)
  ipcMain.handle('coverage:result', (_e, dir) => {
    if (!runs.delete(dir)) return null;
    let result = null;
    try { result = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch {}
    fs.rm(dir, { recursive: true, force: true }, () => {});
    return result;
  });
};
