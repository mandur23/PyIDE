// Diagnostics plugin, main side: the internal error list behind the status-bar icon, the log file, the versions shown
// in About, and Help › Collect Logs and Diagnostic Data, a zip saved where the user chooses. Nothing is uploaded.
// The log and the error collection themselves are core (main/diagnostics), so they work before any plugin loads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { dialog, shell, BrowserWindow } = require('electron');
const { redactObject, redactPaths, remoteRepoNames, scrubText } = require('../diagnostics/redact');
const { zip } = require('../diagnostics/zip');
const { installKind } = require('./updater');

const pad = (n) => String(n).padStart(2, '0');
const fileStamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// ---------- Report on GitHub ----------
// GitHub refuses longer new-issue links (about 8 KB), so the whole URL stays under this.
const ISSUE_URL_MAX = 8000;
const LOG_LINES = 30;
const KIND_NAMES = { nsis: 'PyIDE installer', msi: 'MSI package', source: 'run from source' };

// The new-issue page of the repository in package.json (`bugs.url`, else `repository`): https only.
function newIssueUrl(appDir) {
  const pkg = readJson(path.join(appDir, 'package.json')) || {};
  const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url;
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const issues = bugs || (repo ? `${String(repo).replace(/^git\+/, '').replace(/\.git$/, '')}/issues` : '');
  let url;
  try { url = new URL(`${String(issues).replace(/\/+$/, '')}/new`); } catch { return null; }
  return url.protocol === 'https:' && !url.search && !url.hash && !url.username ? url.href : null;
}

const issueLink = (base, title, body) => `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
// A Markdown code fence longer than any run of backticks inside the text.
const fenced = (text) => {
  const fence = '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
};

// The last lines of a text file, reading at most its last 256 KB.
function tailLines(file, count) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (len < size) lines.shift(); // a partial first line
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(-count);
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Cuts lines (from the start or the end) and then characters until fits(text) holds; -> {text, cut} or null.
function shrink(lines, fits, { fromStart }) {
  for (let n = lines.length; n >= 1; n--) {
    const text = (fromStart ? lines.slice(lines.length - n) : lines.slice(0, n)).join('\n');
    if (fits(text, lines.length - n)) return { text, cut: lines.length - n };
  }
  const one = fromStart ? lines[lines.length - 1] : lines[0];
  for (let len = Math.floor((one || '').length / 2); len >= 20; len = Math.floor(len / 2)) {
    const text = fromStart ? `…${one.slice(-len)}` : `${one.slice(0, len)}…`;
    if (fits(text, lines.length - 1)) return { text, cut: lines.length - 1 };
  }
  return null;
}

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

  // A new GitHub issue for an internal error (errorId) or for a problem in general: the environment, the error with its
  // stack, and the last lines of the IDE log, scrubbed of secrets and of paths that name the user or their projects.
  // The text is shown to the user first; the link only opens the browser, which submits nothing by itself.
  // -> {title, body, url, truncated} or {error}.
  function reportDraft({ errorId = null, plugins = [], root = null } = {}) {
    const base = newIssueUrl(appDir);
    if (!base) return { error: 'package.json has no https bugs URL or repository' };
    const settings = readJson(path.join(app.getPath('userData'), 'settings.json')) || {};
    const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects.map((p) => (typeof p === 'string' ? p : p?.path)) : [];
    // The git remotes named anywhere in the recent log (a failed push, a clone) give repository names to hide too.
    const recentLog = tailLines(diagnostics.logFile(), 5000);
    const names = remoteRepoNames(recentLog.join('\n'));
    const clean = (text) => redactPaths(text, { home: os.homedir(), projects: [root, ...recent].filter((p) => typeof p === 'string' && p), names });
    const e = errorId == null ? null : diagnostics.listErrors().find((x) => x.id === errorId);
    if (errorId != null && !e) return { error: 'That error is no longer in the list' };

    const kind = installKind(app);
    const extra = plugins.filter((p) => p.enabled && !p.bundled).length;
    const environment = [
      '### Environment',
      `- PyIDE ${app.getVersion()} (${KIND_NAMES[kind] || kind})`,
      `- ${os.version ? `${os.version()} ` : ''}${os.release()} ${process.arch}`,
      `- Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
      `- Non-default plugins enabled: ${extra}`,
    ].join('\n');
    const message = e ? clean(`${e.title ? `${e.title}: ` : ''}${e.message}`).split('\n')[0] : '';
    const title = e ? (message.length > 120 ? `${message.slice(0, 119)}…` : message) : '';
    const plugin = e ? (e.plugin ? `${e.plugin.name} (${e.plugin.id})` : 'PyIDE core') : '';
    const stackLines = e ? clean(e.stack && e.stack.includes(e.message) ? e.stack : `${message}\n${e.stack || ''}`).split('\n') : [];
    const logLines = recentLog.slice(-LOG_LINES).map(clean);

    const compose = (stack, stackCut, log, logCut) => [
      '### What happened',
      e ? 'Describe what you were doing when the error appeared.' : 'Describe the problem and the steps that lead to it.',
      '',
      environment,
      ...(e ? ['', '### Error', `Plugin: ${plugin}`, `Source: ${e.source}${e.window ? ` (${e.window} window)` : ''}, ${e.kind}${e.count > 1 ? `, ${e.count} times` : ''}`, '',
        fenced(stack), ...(stackCut ? [`_The stack trace was shortened (${stackCut} more lines) to fit in a link._`] : [])] : []),
      '',
      `### Last ${LOG_LINES} lines of the IDE log`,
      log == null ? '_The log was left out to fit in a link._' : fenced(log || '(empty)'),
      ...(log != null && logCut ? [`_The ${logCut} oldest lines were left out to fit in a link._`] : []),
    ].join('\n');
    const fits = (body) => issueLink(base, title, body).length <= ISSUE_URL_MAX;
    const fullStack = stackLines.join('\n');

    // The log is shortened first (its oldest lines), then left out, then the stack trace (its last frames).
    let body = compose(fullStack, 0, logLines.join('\n'), 0);
    let truncated = !fits(body);
    if (truncated) {
      const log = logLines.length ? shrink(logLines, (text, cut) => fits(compose(fullStack, 0, text, cut)), { fromStart: true }) : null;
      if (log) body = compose(fullStack, 0, log.text, log.cut);
      else {
        const stack = shrink(stackLines, (text, cut) => fits(compose(text, cut, null, 0)), { fromStart: false });
        body = compose(stack ? stack.text : '…', stack ? stack.cut : stackLines.length, null, 0);
      }
    }
    return { title, body, url: issueLink(base, title, body), truncated };
  }

  // Opens the new-issue page for a draft the user has seen. Main builds the link itself from package.json, so the
  // renderer cannot send the browser anywhere else. With PYIDE_DIAGNOSTICS_TEST=1 the link is recorded, not opened.
  const opened = [];
  async function openReport({ title = '', body = '' } = {}) {
    const base = newIssueUrl(appDir);
    if (!base) throw new Error('package.json has no https bugs URL or repository');
    const url = issueLink(base, String(title), String(body));
    if (url.length > ISSUE_URL_MAX) throw new Error('The report is too long for a link');
    if (process.env.PYIDE_DIAGNOSTICS_TEST === '1') opened.push(url);
    else await shell.openExternal(url);
    diagnostics.logger('#diagnostics').info(`opened a GitHub issue draft (${url.length} characters)`);
    return url;
  }

  ipcMain.handle('diagnostics:reportDraft', (_e, opts) => reportDraft(opts));
  ipcMain.handle('diagnostics:openReport', (_e, draft) => openReport(draft));
  if (process.env.PYIDE_DIAGNOSTICS_TEST === '1') ipcMain.handle('diagnostics:testOpened', () => opened.slice());

  ipcMain.handle('diagnostics:errors', () => diagnostics.listErrors());
  ipcMain.handle('diagnostics:clear', () => diagnostics.clearErrors());
  ipcMain.handle('diagnostics:markRead', () => diagnostics.markRead());
  ipcMain.handle('diagnostics:logFile', () => diagnostics.logFile());
  ipcMain.handle('diagnostics:showLogInExplorer', () => shell.showItemInFolder(diagnostics.logFile()));
  ipcMain.handle('diagnostics:configure', (_e, cfg) => diagnostics.configure(cfg));
  ipcMain.handle('diagnostics:versions', (_e, info) => versions(info));
  ipcMain.handle('diagnostics:collect', (e, opts) => collect(e.sender, opts));
};
