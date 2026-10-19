const { execFile } = require('child_process');
const remote = require('../remote');

const PIP = ['-m', 'pip', '--disable-pip-version-check', '--no-color'];

const parseList = (stdout, stderr, message) => {
  try { return { ok: true, packages: JSON.parse(stdout) }; } catch {}
  return { ok: false, error: (stderr || message || 'pip list failed').trim() };
};

exports.register = (ctx) => {
  const { ipcMain, startProcess } = ctx;
  // -> {ok, packages: [{name, version}]} | {ok: false, error}
  ipcMain.handle('packages:list', async (_e, interp) => {
    if (remote.isRemote(interp)) {
      const r = await remote.execPython(interp, [...PIP, 'list', '--format=json'], { timeout: 120000 });
      return parseList(r.stdout, r.stderr);
    }
    return new Promise((resolve) => {
      execFile(interp.cmd, [...interp.args, ...PIP, 'list', '--format=json'],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (err, stdout, stderr) => resolve(parseList(stdout, stderr, err?.message)));
    });
  });

  const pip = (interp, args) => (remote.isRemote(interp)
    ? remote.startPython(ctx, interp, [...PIP, ...args], {})
    : startProcess(interp.cmd, [...interp.args, ...PIP, ...args], {}));
  ipcMain.handle('packages:install', (_e, interp, spec) => pip(interp, ['install', spec]));
  ipcMain.handle('packages:upgrade', (_e, interp, name) => pip(interp, ['install', '--upgrade', name]));
  ipcMain.handle('packages:uninstall', (_e, interp, name) => pip(interp, ['uninstall', '-y', name]));
};
