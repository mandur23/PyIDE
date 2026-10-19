// Scientific view: the Python side of the Data View and the Plots tool window (renderer/features/sciview).
//
// Every Python process the IDE starts (Run, Debug, Python Console, notebook kernels) inherits process.env, so this
// module puts the helpers folder on PYTHONPATH and, while "Show plots in tool window" is on, selects the matplotlib
// backend in renderer/features/sciview/python/pyide_sciview_backend.py. That backend sends finished figures to a
// local TCP server here (one JSON line per figure, checked against a per-session token), which forwards them to the
// renderer as 'sciview:plot'. A run configuration that sets MPLBACKEND itself still wins, since its env is applied last.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { dialog } = require('electron');

const BACKEND = 'module://pyide_sciview_backend';
const MAX_MESSAGE = 128 * 1024 * 1024;

exports.register = ({ ipcMain, send, getWindow, appDir, unpackedDir = appDir }) => {
  const helperDir = path.join(unpackedDir, 'renderer', 'features', 'sciview', 'python');
  const token = crypto.randomBytes(16).toString('hex');
  const originalBackend = process.env.MPLBACKEND;

  process.env.PYTHONPATH = [helperDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  process.env.PYIDE_PLOTS_TOKEN = token;

  const setPlots = (on) => {
    if (on) process.env.MPLBACKEND = BACKEND;
    else if (originalBackend === undefined) delete process.env.MPLBACKEND;
    else process.env.MPLBACKEND = originalBackend;
  };
  setPlots(true);

  const server = net.createServer((socket) => {
    const chunks = [];
    let size = 0;
    socket.on('data', (d) => {
      size += d.length;
      if (size > MAX_MESSAGE) { socket.destroy(); return; }
      chunks.push(d);
      if (!d.includes(10)) return;
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { socket.destroy(); return; }
      if (msg.token !== token || typeof msg.png !== 'string') { socket.destroy(); return; }
      delete msg.token;
      send('sciview:plot', msg);
      socket.end('ok\n');
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1', () => { process.env.PYIDE_PLOTS_PORT = String(server.address().port); });
  server.unref();

  ipcMain.handle('sciview:configure', (_e, { showPlots }) => setPlots(showPlots !== false));
  ipcMain.handle('sciview:helperDir', () => helperDir);

  // kind: 'png' | 'svg' | 'csv'. Returns the chosen path or null.
  ipcMain.handle('sciview:savePath', async (_e, kind, defaultName) => {
    const filters = { png: [{ name: 'PNG', extensions: ['png'] }], svg: [{ name: 'SVG', extensions: ['svg'] }],
      csv: [{ name: 'CSV', extensions: ['csv'] }, { name: 'TSV', extensions: ['tsv', 'txt'] }] }[kind];
    const r = await dialog.showSaveDialog(getWindow(), { defaultPath: defaultName, filters });
    return r.canceled ? null : r.filePath;
  });
  // data: base64 for 'png', text for 'svg'.
  ipcMain.handle('sciview:writePlot', (_e, file, kind, data) => {
    fs.writeFileSync(file, kind === 'png' ? Buffer.from(data, 'base64') : data, kind === 'png' ? undefined : 'utf8');
    return true;
  });
};
