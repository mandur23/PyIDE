const path = require('path');
const remote = require('../remote');

exports.register = (ctx) => {
  const script = path.join(ctx.unpackedDir, 'renderer', 'features', 'pyconsole', 'pyide_repl.py');
  ctx.ipcMain.handle('pyconsole:start', (_e, interp, cwd, roots = []) => {
    const args = ['-u', script, ...roots];
    const opts = { cwd, env: { PYTHONIOENCODING: 'utf-8' } };
    return remote.isRemote(interp) ? remote.startPython(ctx, interp, args, opts) : ctx.startProcess(interp.cmd, [...interp.args, ...args], opts);
  });
};
