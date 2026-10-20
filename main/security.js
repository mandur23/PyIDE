// Window hardening for content the IDE shows but did not write: README and notebook Markdown, HTML previews, the
// Browser tab, Monaco hovers and links, terminal hyperlinks. The IDE page has the full IPC API through the preload, so a
// page that replaced it (a link, a dropped URL, a popup) would run with that API. Only the IDE's own page may load in
// a window; web links leave for the system browser, everything else is refused.
const { app, session, shell } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');

const isWeb = (url) => /^https?:\/\//i.test(String(url));

function install({ appDir }) {
  const indexFile = path.join(appDir, 'renderer', 'index.html').toLowerCase();
  const isIdePage = (url) => {
    try { return new URL(url).protocol === 'file:' && fileURLToPath(url).toLowerCase() === indexFile; } catch { return false; }
  };

  app.on('web-contents-created', (_e, contents) => {
    // window.open, target=_blank, middle-click and Shift+click on a link, Monaco's link opener.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    // A link clicked in rendered content, a URL or file dropped on the window, location.href set by a page.
    contents.on('will-navigate', (e, url) => {
      if (isIdePage(url)) return;
      e.preventDefault();
      if (isWeb(url)) shell.openExternal(url).catch(() => {});
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  // Camera, microphone, location, notifications, devices and external protocol handlers are never granted. The IDE page
  // itself may read the clipboard (Monaco's Paste); framed content may only write it.
  const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const allowed = (permission, url) => ALWAYS.has(permission) || (permission === 'clipboard-read' && isIdePage(url));
  app.whenReady().then(() => {
    const s = session.defaultSession;
    s.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details?.requestingUrl)));
    s.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => allowed(permission, details?.requestingUrl || requestingOrigin));
  });
}

module.exports = { install, isWeb };
