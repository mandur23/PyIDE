const path = require('path');
const remote = require('../remote');
const { withEnvFiles } = require('../dotenv');
const projectRoots = require('../project-roots');

exports.register = (ctx) => {
  const script = path.join(ctx.unpackedDir, 'renderer', 'features', 'pyconsole', 'pyide_repl.py');
  ctx.ipcMain.handle('pyconsole:start', (_e, interp, cwd, roots = []) => {
    // pyide_repl.py puts its arguments on sys.path: the project root and its source roots (Mark Directory As).
    const args = ['-u', script, ...projectRoots.withSources(roots)];
    // The project root's .env, as for a run configuration with the default env files.
    const opts = { cwd, env: { ...withEnvFiles({}, undefined, roots[0]), PYTHONIOENCODING: 'utf-8' } };
    return remote.isRemote(interp) ? remote.startPython(ctx, interp, args, opts) : ctx.startProcess(interp.cmd, [...interp.args, ...args], opts);
  });
};
