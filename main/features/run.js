const remote = require('../remote');
const { withEnvFiles } = require('../dotenv');

// PyCharm adds the content root to PYTHONPATH for every Python run configuration; keep any PYTHONPATH the user set.
const withPath = (env = {}, extra = []) => {
  const parts = [...extra, env.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean);
  return parts.length ? { ...env, PYTHONPATH: parts.join(';') } : env;
};

exports.withPath = withPath;

exports.register = (ctx) => {
  // envFiles: .env files under the explicit env (undefined: the project root's .env, roots[0])
  ctx.ipcMain.handle('run:start', (_e, interp, file, cwd, params = [], env = {}, roots = [], envFiles) => {
    const args = ['-u', file, ...params];
    const opts = { cwd, env: withPath(withEnvFiles(env, envFiles, roots[0]), roots) };
    return remote.isRemote(interp) ? remote.startPython(ctx, interp, args, opts) : ctx.startProcess(interp.cmd, [...interp.args, ...args], opts);
  });
};
