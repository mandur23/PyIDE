const path = require('path');

// Starts one kernel bridge (renderer/features/notebook/kernel_bridge.py) per open notebook in the project interpreter.
// The bridge speaks JSON lines over stdin/stdout, so the renderer drives it through ide.proc like any other process.
// Python runs the scripts from the unpacked copy in packaged builds; it cannot read app.asar.
exports.register = ({ ipcMain, startProcess, appDir, unpackedDir = appDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'notebook', 'kernel_bridge.py');
  ipcMain.handle('notebook:start', (_e, interp, cwd, paths = []) =>
    startProcess(interp.cmd, [...interp.args, '-u', script, cwd, ...paths], { cwd, env: { PYTHONIOENCODING: 'utf-8' } }));
};
