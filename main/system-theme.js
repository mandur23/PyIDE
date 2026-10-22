// The OS light/dark preference for the "Sync with OS" theme (appearance.theme = 'system'). The renderer asks
// `theme:system` and every window hears `theme:systemChanged` when Windows switches (nativeTheme 'updated').
//
// Tests: Chromium's prefers-color-scheme emulation (CDP Emulation.setEmulatedMedia) never reaches nativeTheme, so
// PYIDE_OS_THEME=dark|light starts the app as if the OS used that mode (nativeTheme.themeSource) and adds
// `theme:testSetOs(mode)`, which switches it later through the same 'updated' event a real OS change sends.
// verify/lib.mjs sets PYIDE_OS_THEME=dark, so suites never depend on the machine's own setting.
const { nativeTheme, BrowserWindow } = require('electron');

exports.register = ({ ipcMain }) => {
  const fake = process.env.PYIDE_OS_THEME;
  if (fake === 'dark' || fake === 'light') nativeTheme.themeSource = fake;
  const state = () => ({ dark: nativeTheme.shouldUseDarkColors });
  ipcMain.handle('theme:system', state);
  let last = state().dark;
  nativeTheme.on('updated', () => {
    const s = state();
    if (s.dark === last) return;
    last = s.dark;
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('theme:systemChanged', s);
  });
  if (fake) ipcMain.handle('theme:testSetOs', (_e, mode) => { nativeTheme.themeSource = mode === 'light' ? 'light' : 'dark'; return state(); });
};
