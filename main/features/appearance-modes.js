// View › Appearance modes, main side: full screen for Full Screen, Zen and Presentation Mode. The renderer is told when
// the window leaves full screen some other way, so the mode that needed it ends too.
const { BrowserWindow } = require('electron');

exports.register = (ctx) => {
  const watched = new WeakSet();
  const windowOf = (e) => BrowserWindow.fromWebContents(e.sender);
  const watch = (w) => {
    if (watched.has(w)) return;
    watched.add(w);
    w.on('leave-full-screen', () => { if (!w.isDestroyed()) w.webContents.send('appearance-modes:fullScreenChanged', false); });
    w.on('enter-full-screen', () => { if (!w.isDestroyed()) w.webContents.send('appearance-modes:fullScreenChanged', true); });
  };
  ctx.ipcMain.handle('appearance-modes:setFullScreen', (e, on) => {
    const w = windowOf(e);
    if (!w) return false;
    watch(w);
    if (w.isFullScreen() !== !!on) w.setFullScreen(!!on);
    return w.isFullScreen();
  });
  ctx.ipcMain.handle('appearance-modes:isFullScreen', (e) => !!windowOf(e)?.isFullScreen());
};
