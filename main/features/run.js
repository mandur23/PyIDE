// PyCharm adds the content root to PYTHONPATH for every Python run configuration; keep any PYTHONPATH the user set.
const withPath = (env = {}, extra = []) => {
  const parts = [...extra, env.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean);
  return parts.length ? { ...env, PYTHONPATH: parts.join(';') } : env;
};

exports.withPath = withPath;

exports.register = ({ ipcMain, startProcess }) => {
  // opts: {params?: string[], env?: object, roots?: string[]}
  ipcMain.handle('run:start', (_e, interp, file, cwd, params = [], env = {}, roots = []) =>
    startProcess(interp.cmd, [...interp.args, '-u', file, ...params], { cwd, env: withPath(env, roots) }));
};
