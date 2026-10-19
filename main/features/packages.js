const { execFile } = require('child_process');

const PIP = ['-m', 'pip', '--disable-pip-version-check', '--no-color'];

exports.register = ({ ipcMain, startProcess }) => {
  // -> {ok, packages: [{name, version}]} | {ok: false, error}
  ipcMain.handle('packages:list', (_e, interp) => new Promise((resolve) => {
    execFile(interp.cmd, [...interp.args, ...PIP, 'list', '--format=json'],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        try { return resolve({ ok: true, packages: JSON.parse(stdout) }); } catch {}
        resolve({ ok: false, error: (stderr || err?.message || 'pip list failed').trim() });
      });
  }));

  const pip = (interp, args) => startProcess(interp.cmd, [...interp.args, ...PIP, ...args], {});
  ipcMain.handle('packages:install', (_e, interp, spec) => pip(interp, ['install', spec]));
  ipcMain.handle('packages:upgrade', (_e, interp, name) => pip(interp, ['install', '--upgrade', name]));
  ipcMain.handle('packages:uninstall', (_e, interp, name) => pip(interp, ['uninstall', '-y', name]));
};
