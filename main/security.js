// Window hardening for content the IDE shows but did not write: README and notebook Markdown, HTML previews, the
// Browser tab, Monaco hovers and links, terminal hyperlinks. The IDE page has the full IPC API through the preload, so a
// page that replaced it (a link, a dropped URL, a popup) would run with that API. Only the IDE's own page may load in
// a window; web links leave for the system browser, everything else is refused.
const { app, session, shell } = require('electron');
const path = require('path');
const { domainToASCII, fileURLToPath } = require('url');

const isWeb = (url) => /^https?:\/\//i.test(String(url));

// A file: URL with a host is a file on a network share (file://server/share/x.png; Chromium reads //server/...,
// \\server\... and file:////server/... that way too). Fetching one makes Windows sign in to that server with the
// user's credentials (NTLM over SMB), so an image in a docstring shown in a Monaco hover or completion details, in a
// notebook output or in a page could send them to any server. Only shares PyIDE has reason to read are fetched: the
// one it runs from and those of projects, folders and files the user opened (allowShare).
const shares = new Set();
const shareOf = (p) => {
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(String(p || ''));
  return m ? `${domainToASCII(m[1]) || m[1]}\\${m[2]}`.toLowerCase() : null; // URLs carry the host in punycode
};
const allowShare = (p) => { const s = shareOf(p); if (s) shares.add(s); };
let captureUntil = 0;
const allowWindowCapture = () => { captureUntil = Date.now() + 10000; };
function blockedFileUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'file:' || !u.hostname) return false;
  let share = u.pathname.split('/')[1] || '';
  try { share = decodeURIComponent(share); } catch {}
  return !shares.has(`${u.hostname}\\${share}`.toLowerCase());
}

function install({ appDir }) {
  allowShare(appDir);
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
  // A window's picture (the Minecraft test client's) is allowed to the IDE page for a few seconds after the IDE asks
  // for it (allowWindowCapture): a desktop capture asks for media with no camera or microphone in it.
  const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const allowed = (permission, url) => ALWAYS.has(permission) || (permission === 'clipboard-read' && isIdePage(url));
  const capturing = (permission, details) => permission === 'media' && captureUntil > Date.now() && isIdePage(details?.requestingUrl)
    && Array.isArray(details.mediaTypes) && !details.mediaTypes.length;
  app.whenReady().then(() => {
    const s = session.defaultSession;
    s.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details?.requestingUrl) || capturing(permission, details)));
    s.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => allowed(permission, details?.requestingUrl || requestingOrigin));
    s.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => callback({ cancel: blockedFileUrl(details.url) }));
  });
}

module.exports = { install, isWeb, allowShare, allowWindowCapture };
