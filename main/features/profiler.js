// Profile: each run gets a temp folder for the JSON statistics that pyide_profile_run.py writes when the program
// ends. The renderer reads them once, which removes the folder.
const fs = require('fs');
const os = require('os');
const path = require('path');

exports.register = ({ ipcMain, unpackedDir }) => {
  const boot = path.join(unpackedDir, 'renderer', 'features', 'profiler', 'pyide_profile_run.py');
  const runs = new Set(); // temp folders handed out and not read yet

  ipcMain.handle('profiler:prepare', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-profile-'));
    runs.add(dir);
    return { boot, dir, stats: path.join(dir, 'stats.json') };
  });

  // -> {functions, total} or null when the run wrote no statistics (it was killed)
  ipcMain.handle('profiler:result', (_e, dir) => {
    if (!runs.delete(dir)) return null;
    let result = null;
    try { result = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')); } catch {}
    fs.rm(dir, { recursive: true, force: true }, () => {});
    return result;
  });
};
