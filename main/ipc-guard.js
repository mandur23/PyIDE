// Every IPC handler answers the app's own pages only: the top frame of the IDE page (main window, detached windows,
// every mode) and the start chooser, which may use its own few channels. preload.js already hands the API to those
// pages alone; this is the same rule where the messages arrive, for a renderer process that does not run the preload's
// rules (an exploited page process, a frame of the HTML preview). It wraps the methods of Electron's one ipcMain object
// before anything registers, so main.js, main/windows.js, main/diagnostics and every feature module (ctx.ipcMain is the
// same object) go through it without knowing.
const path = require('path');
const { pathToFileURL } = require('url');

// The page URLs main/windows.js passes to the preload (--pyide-page, --pyide-chooser), and the preload's comparison:
// a file: URL without a host, its decoded path in lower case. Query and hash do not matter (?mode=, ?detached=1).
const appPages = (appDir) => ({
  ide: pathToFileURL(path.join(appDir, 'renderer', 'index.html')).href,
  chooser: pathToFileURL(path.join(appDir, 'renderer', 'chooser.html')).href,
});
const pagePath = (href) => { try { const u = new URL(href); return u.protocol === 'file:' && !u.host ? decodeURIComponent(u.pathname).toLowerCase() : null; } catch { return null; } };

// What preload.js gives the chooser (verify/ipc-guard.mjs keeps the two lists equal).
const CHOOSER_CHANNELS = new Set(['core:localeSync', 'settings:loadSync', 'settings:saveSync', 'chooser:pick', 'chooser:close',
  'chooser:updateState', 'chooser:update']);

// once() and prependOnceListener() add their one-shot wrapper through on() and prependListener().
const LISTEN = ['on', 'addListener', 'prependListener'];
const REMOVE = ['removeListener', 'off'];

function guardIpc(ipcMain, { appDir, onRefused = () => {} }) {
  const pages = appPages(appDir);
  const ide = pagePath(pages.ide);
  const chooser = pagePath(pages.chooser);
  // -> null when the sender may use the channel, else why not.
  const refusal = (e, channel) => {
    let frame = null;
    try { frame = e?.senderFrame; } catch {}
    if (!frame) return 'no sender frame';
    if (frame.parent) return 'a subframe';
    const page = pagePath(frame.url);
    if (page && page === ide) return null;
    if (page && page === chooser) return CHOOSER_CHANNELS.has(channel) ? null : 'the chooser';
    return 'a foreign page';
  };
  const refused = (channel, e, why) => {
    let url = '';
    try { url = e.senderFrame?.url || ''; } catch {}
    onRefused({ channel, why, url });
  };

  const wrappers = new WeakMap(); // listener -> Map(channel -> its guarded listener)
  const wrapperOf = (channel, fn) => wrappers.get(fn)?.get(channel) || fn;
  for (const m of LISTEN) {
    const orig = ipcMain[m].bind(ipcMain);
    ipcMain[m] = (channel, fn) => {
      const guarded = function (e, ...args) {
        const why = refusal(e, channel);
        if (!why) return fn.call(this, e, ...args);
        refused(channel, e, why);
        // A sendSync caller waits for a value.
        try { e.returnValue = null; } catch {}
      };
      // A once() wrapper is removed by itself when it fires and by its listener (fn.listener) when taken back.
      for (const key of [fn, fn.listener]) {
        if (typeof key !== 'function') continue;
        if (!wrappers.has(key)) wrappers.set(key, new Map());
        wrappers.get(key).set(channel, guarded);
      }
      return orig(channel, guarded);
    };
  }
  for (const m of REMOVE) {
    const orig = ipcMain[m].bind(ipcMain);
    ipcMain[m] = (channel, fn) => orig(channel, wrapperOf(channel, fn));
  }
  for (const m of ['handle', 'handleOnce']) {
    const orig = ipcMain[m].bind(ipcMain);
    ipcMain[m] = (channel, fn) => orig(channel, (e, ...args) => {
      const why = refusal(e, channel);
      if (!why) return fn(e, ...args);
      refused(channel, e, why);
      throw new Error(`${channel} is not available to ${why}`);
    });
  }
  return { refusal };
}

module.exports = { guardIpc, appPages, CHOOSER_CHANNELS };
