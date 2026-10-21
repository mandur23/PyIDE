// Real terminals: each session is a ConPTY (node-pty) so interactive programs such as the Claude Code CLI,
// Python's REPL, vim or fzf work exactly as in Windows Terminal.
const pty = require('@lydell/node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const claude = require('../ai/claude');
const claudeIde = require('./claude-ide');
const remote = require('../remote');
const { loadFiles } = require('../dotenv');

const sessions = new Map(); // id -> {proc, owner}
let nextId = 1;

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts }, (err, out) => resolve(err ? null : out));
});
const onPath = async (exe) => (await run('where.exe', [exe]))?.split(/\r?\n/).find(Boolean) || null;

async function detectShells() {
  const shells = [];
  const pwsh = await onPath('pwsh.exe');
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
  shells.push({ id: 'powershell', name: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'] });
  shells.push({ id: 'cmd', name: 'Command Prompt', file: process.env.ComSpec || 'cmd.exe', args: [] });
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(p)) { shells.push({ id: 'gitbash', name: 'Git Bash', file: p, args: ['--login', '-i'] }); break; }
  }
  if (fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe'))) {
    shells.push({ id: 'wsl', name: 'WSL', file: 'wsl.exe', args: [] });
  }
  return shells;
}

// The version is asked once per claude.exe build: the status is refreshed on every project open.
let claudeVersion = null; // {path, mtime, version}
async function findClaude() {
  const found = claude.findClaude();
  if (!found) return { installed: false };
  if (process.env.PYIDE_CLAUDE_PATH) return { installed: true, path: found, version: '' };
  const mtime = await fs.promises.stat(found).then((st) => st.mtimeMs, () => null);
  if (claudeVersion?.path !== found || claudeVersion.mtime !== mtime) {
    const out = await run(found, ['--version'], { timeout: 15000, shell: /\.cmd$/i.test(found) });
    claudeVersion = { path: found, mtime, version: (out || '').trim() };
  }
  return { installed: true, path: found, version: claudeVersion.version };
}

// Like PyCharm, a terminal opened while a venv interpreter is selected starts with that venv active.
function venvEnv(interpExe) {
  if (!interpExe) return {};
  const venv = path.dirname(path.dirname(interpExe));
  if (!fs.existsSync(path.join(venv, 'pyvenv.cfg'))) return {};
  return { VIRTUAL_ENV: venv, PATH: `${path.join(venv, 'Scripts')};${process.env.PATH}` };
}

// A session's folder must be a local absolute path (C:\...). A UNC path (\\host\share) is refused before any fs call:
// the folder can come from what a program printed in the terminal (OSC 7 / OSC 9;9), and touching \\host\share
// would open an SMB connection to that host and offer it the user's NTLM credentials.
const localDir = (p) => typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p) && !/[\x00-\x1f]/.test(p);

exports.register = ({ ipcMain, app }) => {
  // A page reload (Trust Project reopens the page) leaves nothing to show a window's sessions: they end, or they would
  // keep running unseen until quit. The renderer asks the user first.
  const navigations = new WeakMap(); // webContents -> main-frame navigations since its first session
  const watchNavigation = (wc) => {
    if (navigations.has(wc)) return;
    navigations.set(wc, 0);
    wc.on('did-navigate', () => {
      const n = navigations.get(wc) + 1;
      navigations.set(wc, n);
      for (const [id, s] of sessions) {
        if (s.owner !== wc || s.nav >= n) continue;
        try { s.proc.kill(); } catch {}
        sessions.delete(id);
      }
    });
  };
  let shells = null; // promise of the detected shells
  ipcMain.handle('pty:shells', () => (shells ??= detectShells()));
  ipcMain.handle('claude:status', () => findClaude());

  // opts: {shell, cwd, cols, rows, interpreter, command?: string to run in the shell, env?, target?}
  // target: a remote interpreter's target (WSL, SSH, Docker); the session is then a login shell in it.
  ipcMain.handle('pty:create', async (e, opts = {}) => {
    opts = { ...opts, cwd: localDir(opts.cwd) ? opts.cwd : undefined };
    const known = await (shells ??= detectShells());
    let shell = known.find((s) => s.id === opts.shell) || known.find((s) => s.id === 'powershell');
    let args = [...shell.args];
    let release;
    let targetEnv = {}; // ssh's askpass runs the IDE as Node, so this goes on after ELECTRON_RUN_AS_NODE is cleared
    if (opts.target) {
      try {
        const t = await remote.terminal(opts.target, opts.cwd);
        shell = { id: `remote:${opts.target.kind}`, name: t.name, file: t.file };
        args = t.args;
        opts = { ...opts, interpreter: undefined };
        targetEnv = t.env;
        release = t.release;
      } catch (err) {
        // The shell reports why the target is unreachable instead of the session failing silently.
        shell = known.find((s) => s.id === 'cmd');
        args = ['/k', `echo ${String(err.message).replace(/[&|<>^%]/g, '')}`];
      }
    } else if (opts.command) {
      if (shell.id === 'cmd') args = ['/k', opts.command];
      else if (shell.id === 'gitbash' || shell.id === 'wsl') args = [...args.filter((a) => a !== '-i'), '-c', `${opts.command}; exec bash -i`];
      else args = [...args, '-NoExit', '-Command', opts.command];
    }
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    // claudeIde.ideEnv(): CLAUDE_CODE_SSE_PORT, so claude started in any PyIDE terminal connects to this window.
    // opts.envFiles: the project's .env files (Settings › Terminal); a remote session's shell does not get them.
    const fileEnv = opts.envFiles?.length && !opts.target ? loadFiles(opts.envFiles) : {};
    const env = { ...process.env, ...venvEnv(opts.interpreter), ...claudeIde.ideEnv(), ...fileEnv, ...opts.env, TERM_PROGRAM: 'PyIDE', COLORTERM: 'truecolor' };
    // The official Claude Code installer puts claude.exe in ~/.local/bin without adding it to PATH; make `claude` work here.
    const localBin = path.join(os.homedir(), '.local', 'bin');
    if (fs.existsSync(localBin) && !(env.PATH || '').toLowerCase().split(';').includes(localBin.toLowerCase())) env.PATH = `${localBin};${env.PATH}`;
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, targetEnv);
    const proc = pty.spawn(shell.file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols || 80),
      rows: Math.max(2, opts.rows || 24),
      cwd,
      env,
      useConpty: true,
    });
    const id = nextId++;
    const owner = e.sender;
    watchNavigation(owner);
    sessions.set(id, { proc, owner, nav: navigations.get(owner) });
    // Output is coalesced per tick so a flood (e.g. a long `dir`) costs a few IPC messages, not thousands.
    let buffer = '';
    let scheduled = false;
    proc.onData((data) => {
      buffer += data;
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        if (!owner.isDestroyed()) owner.send('pty:data', { id, data: buffer });
        buffer = '';
      });
    });
    // Closing the window ends its shells; a shell that ends first takes its listener with it, or every session ever
    // opened would keep one on the window (and its proc alive).
    const onWindowGone = () => { try { proc.kill(); } catch {} sessions.delete(id); };
    owner.once('destroyed', onWindowGone);
    proc.onExit(({ exitCode }) => {
      release?.();
      sessions.delete(id);
      owner.removeListener('destroyed', onWindowGone);
      if (!owner.isDestroyed()) setImmediate(() => owner.send('pty:exit', { id, code: exitCode }));
    });
    // host: this computer's name, the only host besides localhost whose OSC 7 file:// URLs the renderer accepts.
    return { id, shell: shell.id, shellName: shell.name, pid: proc.pid, host: os.hostname() };
  });

  ipcMain.on('pty:write', (_e, { id, data }) => sessions.get(id)?.proc.write(data));
  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
    try { sessions.get(id)?.proc.resize(Math.max(2, cols), Math.max(2, rows)); } catch {}
  });
  ipcMain.handle('pty:kill', (_e, id) => {
    const s = sessions.get(id);
    if (!s) return;
    try { s.proc.kill(); } catch {}
    sessions.delete(id);
  });

  app.on('before-quit', () => {
    for (const { proc } of sessions.values()) { try { proc.kill(); } catch {} }
    sessions.clear();
  });
};
