const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

// Only the IDE's own page gets the API. A window that somehow loaded anything else (a link target, a dropped file;
// main/security.js refuses those navigations) must not be able to read files or start programs.
const pagePath = (href) => { try { const u = new URL(href); return u.protocol === 'file:' && !u.host ? decodeURIComponent(u.pathname).toLowerCase() : null; } catch { return null; } };
const idePage = pagePath(process.argv.find((a) => a.startsWith('--pyide-page='))?.slice('--pyide-page='.length));
if (idePage && pagePath(location.href) === idePage) contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  // Files dropped from Explorer carry no path in the renderer since Electron 32; webUtils resolves it.
  pathForFile: (file) => webUtils.getPathForFile(file),
  localeSync: (lang) => ipcRenderer.sendSync('core:localeSync', lang),
  loadSettingsSync: () => ipcRenderer.sendSync('settings:loadSync'),
  saveSettingsSync: (settings, changed) => ipcRenderer.sendSync('settings:saveSync', settings, changed),
  relaunch: invoke('core:relaunch'),
  openFolder: invoke('dialog:openFolder'),
  openFileDialog: invoke('dialog:openFile'),
  list: invoke('fs:list'),
  walk: invoke('fs:walk'),
  exists: invoke('fs:exists'),
  read: invoke('fs:read'),
  write: invoke('fs:write'),
  create: invoke('fs:create'),
  rename: invoke('fs:rename'),
  copyInto: invoke('fs:copyInto'),
  stat: invoke('fs:stat'),
  trash: invoke('fs:trash'),
  interpreters: invoke('py:interpreters'),
  input: invoke('proc:input'),
  closeInput: invoke('proc:closeInput'),
  kill: invoke('proc:kill'),
});
