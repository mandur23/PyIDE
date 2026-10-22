// File and Code Templates (file-templates plugin): the ${USER} variable, the operating system's user name.
const os = require('os');

exports.register = (ctx) => {
  ctx.ipcMain.handle('file-templates:user', () => {
    try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || ''; }
  });
};
