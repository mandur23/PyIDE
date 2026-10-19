const path = require('path');

exports.register = ({ ipcMain, startProcess, unpackedDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'pyconsole', 'pyide_repl.py');
  ipcMain.handle('pyconsole:start', (_e, interp, cwd, roots = []) =>
    startProcess(interp.cmd, [...interp.args, '-u', script, ...roots], { cwd, env: { PYTHONIOENCODING: 'utf-8' } }));
};
