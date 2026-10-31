// Electron main process for verify/update-delta.mjs: registers main/features/updater.js with a fake ipcMain, checks the
// feed and downloads the update exactly as an NSIS install would (PYIDE_UPDATE_TEST_KIND=nsis), with the real
// electron-updater and Electron's net module, then writes what happened to a JSON file and quits. Nothing is installed.
// PYIDE_DELTA_CASE (JSON): {updaterJs, feedDir, http, differential, channel, userData, out}. LOCALAPPDATA points at a temp folder,
// so electron-updater's cache (<LOCALAPPDATA>\nano-studio-updater) is the test's own.
const { app } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const cfg = JSON.parse(process.env.PYIDE_DELTA_CASE);
app.setPath('userData', cfg.userData);
app.on('window-all-closed', () => {});

// Every HTTP server made here (the test's own feed server, or the one updater.js starts for a folder feed) records its
// requests, their Range headers and the body bytes it sent.
const requests = [];
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args);
  // Before the server's own handler, so every body chunk it writes is counted.
  server.prependListener('request', (req, res) => {
    const entry = { method: req.method, path: decodeURIComponent(new URL(req.url, 'http://x').pathname), range: req.headers.range || null, status: null, bytes: 0 };
    requests.push(entry);
    const count = (chunk) => { if (chunk && typeof chunk !== 'function') entry.bytes += Buffer.byteLength(chunk); };
    const { write, end } = res;
    res.write = function (chunk, ...rest) { count(chunk); return write.call(this, chunk, ...rest); };
    res.end = function (chunk, ...rest) { count(chunk); return end.call(this, chunk, ...rest); };
    res.on('finish', () => { entry.status = res.statusCode; });
  });
  return server;
};

function finish(result) {
  fs.writeFileSync(cfg.out, JSON.stringify({ ...result, requests }, null, 2));
  app.quit();
}

app.whenReady().then(async () => {
  const updater = require(cfg.updaterJs);
  const handlers = {};
  const states = [];
  const logs = [];
  const line = (level) => (msg) => logs.push(`${level} ${msg}`);
  updater.register({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    app,
    send: (channel, state) => { if (channel === 'updater:state') states.push(JSON.parse(JSON.stringify(state))); },
    diagnostics: { logger: () => ({ info: line('INFO'), warn: line('WARN'), error: line('ERROR') }) },
  });
  let feed = cfg.feedDir;
  let server = null;
  if (cfg.http) ({ server, url: feed } = await updater.serveFolder(cfg.feedDir));
  const result = { kind: null, check: null, download: null, error: null, states, logs, file: null };
  try {
    result.kind = (await handlers['updater:state']()).kind;
    result.check = await handlers['updater:check'](null, feed, { channel: cfg.channel });
    const started = Date.now();
    await handlers['updater:download'](null, cfg.differential == null ? undefined : { differential: cfg.differential });
    result.ms = Date.now() - started;
    const final = await handlers['updater:state']();
    result.download = final.download;
    result.phase = final.phase;
    const pending = path.join(process.env.LOCALAPPDATA, 'nano-studio-updater', 'pending');
    const exe = fs.readdirSync(pending).find((n) => /^NanoStudio-Setup-.*\.exe$/.test(n));
    result.file = exe ? path.join(pending, exe) : null;
  } catch (err) {
    result.error = err.stack || String(err);
  }
  server?.close();
  server?.closeAllConnections();
  finish(result);
}).catch((err) => finish({ error: err.stack || String(err) }));
