// Diagnostics plugin, main side: the internal error list behind the status-bar icon, the log file, the versions shown
// in About, and Help › Collect Logs and Diagnostic Data, a zip saved where the user chooses. Nothing is uploaded.
// The log and the error collection themselves are core (main/diagnostics), so they work before any plugin loads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { dialog, shell, BrowserWindow } = require('electron');
const { redactObject, scrubText } = require('../diagnostics/redact');
const { zip } = require('../diagnostics/zip');

const pad = (n) => String(n).padStart(2, '0');
const fileStamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

exports.register = ({ ipcMain, app, appDir, vendorDir, diagnostics }) => {
  const pyright = readJson(path.join(appDir, 'node_modules', 'pyright', 'package.json'))?.version || null;
  let ruff;
  const ruffVersion = () => (ruff ??= new Promise((resolve) => {
    execFile(path.join(vendorDir, 'bin', 'ruff.exe'), ['--version'], { timeout: 5000, windowsHide: true },
      (err, out) => resolve(err ? null : String(out).trim().replace(/^ruff\s+/, '')));
  }));

  // interpreters: what the renderer detected ({label, version, executable}); current: the project interpreter's path.
  async function versions({ interpreters = [], current = null } = {}) {
    const v = {
      app: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      pyright,
      ruff: await ruffVersion(),
      os: `${os.type()} ${os.release()}${os.version ? ` (${os.version()})` : ''} ${process.arch}`,
      locale: app.getLocale(),
      cpus: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 2 ** 30),
      packaged: app.isPackaged,
      interpreters: interpreters.map(({ label, version, executable }) => ({ label, version, executable, current: !!current && executable?.toLowerCase() === current.toLowerCase() })),
    };
    const cur = v.interpreters.find((i) => i.current);
    v.text = [
      `PyIDE ${v.app}`,
      `Runtime: Electron ${v.electron}, Chromium ${v.chromium}, Node ${v.node}, V8 ${v.v8}`,
      `Pyright ${v.pyright || 'not found'}, ruff ${v.ruff || 'not found'}`,
      `Python: ${cur ? `${cur.version} (${cur.executable})` : 'no interpreter selected'}`,
      ...v.interpreters.filter((i) => !i.current).map((i) => `  also ${i.version} (${i.executable})`),
      `OS: ${v.os}`,
      `Locale: ${v.locale}, ${v.cpus} CPUs, ${v.memoryGB} GB RAM${v.packaged ? '' : ', running from source'}`,
    ].join('\n');
    return v;
  }

  const errorsText = (list) => list.map((e) => [
    `#${e.id} ${new Date(e.time).toISOString()} ${e.source}${e.window ? ` (${e.window} window)` : ''} ${e.kind}${e.count > 1 ? ` x${e.count}` : ''}`,
    `Plugin: ${e.plugin ? `${e.plugin.name} (${e.plugin.id})` : 'PyIDE core'}`,
    e.title ? `${e.title}: ${e.message}` : e.message,
    e.stack,
  ].join('\n')).join('\n\n----------------------------------------\n\n') || 'No internal errors.';

  // The archive holds: logs/ (scrubbed), about.txt and versions.json, plugins.json, settings.json (secrets
  // redacted) and internal-errors.txt. Data source passwords and other safeStorage files are never read.
  async function collect(sender, { interpreters, current, plugins = [], title, filterName } = {}) {
    const testTarget = process.env.PYIDE_DIAGNOSTICS_TEST === '1' && process.env.PYIDE_DIAGNOSTICS_SAVE_TO;
    let target = testTarget;
    if (!target) {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), {
        title,
        defaultPath: path.join(app.getPath('desktop'), `pyide-logs-${fileStamp()}.zip`),
        filters: [{ name: filterName || 'ZIP', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    if (!/\.zip$/i.test(target)) target += '.zip';

    const entries = [];
    const logDir = diagnostics.logDir();
    for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir).sort() : []) {
      if (/\.log$/i.test(f)) entries.push({ name: `logs/${f}`, data: scrubText(fs.readFileSync(path.join(logDir, f), 'utf8')) });
    }
    const v = await versions({ interpreters, current });
    const settings = readJson(path.join(app.getPath('userData'), 'settings.json')) || {};
    entries.push(
      { name: 'about.txt', data: `${v.text}\n` },
      { name: 'versions.json', data: JSON.stringify(redactObject(v), null, 2) },
      { name: 'plugins.json', data: JSON.stringify(plugins.map(({ id, name, version, vendor, bundled, enabled, loaded, blockedBy }) =>
        ({ id, name, version, vendor, bundled, enabled, loaded, blockedBy })), null, 2) },
      { name: 'settings.json', data: JSON.stringify(redactObject(settings), null, 2) },
      { name: 'internal-errors.txt', data: `${errorsText(diagnostics.listErrors())}\n` },
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zip(entries));
    diagnostics.logger('#diagnostics').info(`diagnostic data saved to ${target}`);
    return { path: target, entries: entries.map((e) => e.name) };
  }

  ipcMain.handle('diagnostics:errors', () => diagnostics.listErrors());
  ipcMain.handle('diagnostics:clear', () => diagnostics.clearErrors());
  ipcMain.handle('diagnostics:markRead', () => diagnostics.markRead());
  ipcMain.handle('diagnostics:logFile', () => diagnostics.logFile());
  ipcMain.handle('diagnostics:showLogInExplorer', () => shell.showItemInFolder(diagnostics.logFile()));
  ipcMain.handle('diagnostics:configure', (_e, cfg) => diagnostics.configure(cfg));
  ipcMain.handle('diagnostics:versions', (_e, info) => versions(info));
  ipcMain.handle('diagnostics:collect', (e, opts) => collect(e.sender, opts));
};
