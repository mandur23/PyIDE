exports.register = ({ ipcMain, startProcess }) => {
  ipcMain.handle('run:start', (_e, interp, file, cwd, params = [], env = {}) =>
    startProcess(interp.cmd, [...interp.args, '-u', file, ...params], { cwd, env }));
};
