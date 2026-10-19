exports.register = ({ ipcMain, startProcess }) => {
  ipcMain.handle('term:exec', (_e, command, cwd) =>
    startProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], { cwd }));
};
