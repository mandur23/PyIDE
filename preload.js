const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
  localeSync: (lang) => ipcRenderer.sendSync('core:localeSync', lang),
  loadSettingsSync: () => ipcRenderer.sendSync('settings:loadSync'),
  saveSettingsSync: (settings) => ipcRenderer.sendSync('settings:saveSync', settings),
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
  trash: invoke('fs:trash'),
  interpreters: invoke('py:interpreters'),
  input: invoke('proc:input'),
  closeInput: invoke('proc:closeInput'),
  kill: invoke('proc:kill'),
});
