const remote = require('../remote');

// PyCharm adds the content root to PYTHONPATH for every Python run configuration; keep any PYTHONPATH the user set.
const withPath = (env = {}, extra = []) => {
  const parts = [...extra, env.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean);
  return parts.length ? { ...env, PYTHONPATH: parts.join(';') } : env;
};

exports.withPath = withPath;

exports.register = (ctx) => {
  // opts: {params?: string[], env?: object, roots?: string[]}
  ctx.ipcMain.handle('run:start', (_e, interp, file, cwd, params = [], env = {}, roots = []) => {
    const args = ['-u', file, ...params];
    const opts = { cwd, env: withPath(env, roots) };
    return remote.isRemote(interp) ? remote.startPython(ctx, interp, args, opts) : ctx.startProcess(interp.cmd, [...interp.args, ...args], opts);
  });
};
