// Real terminals: each session is a ConPTY (node-pty) so interactive programs such as the Claude Code CLI,
// Python's REPL, vim or fzf work exactly as in Windows Terminal.
const pty = require('@lydell/node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const claude = require('../ai/claude');

const sessions = new Map(); // id -> {proc, owner}
let nextId = 1;

function onPath(exe) {
  try {
    return execFileSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}

function detectShells() {
  const shells = [];
  const pwsh = onPath('pwsh.exe');
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

function findClaude() {
  const found = claude.findClaude();
  if (!found) return { installed: false };
  if (process.env.PYIDE_CLAUDE_PATH) return { installed: true, path: found, version: '' };
  let version = '';
  try { version = execFileSync(found, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: /\.cmd$/i.test(found) }).trim(); } catch {}
  return { installed: true, path: found, version };
}

// Like PyCharm, a terminal opened while a venv interpreter is selected starts with that venv active.
function venvEnv(interpExe) {
  if (!interpExe) return {};
  const venv = path.dirname(path.dirname(interpExe));
  if (!fs.existsSync(path.join(venv, 'pyvenv.cfg'))) return {};
  return { VIRTUAL_ENV: venv, PATH: `${path.join(venv, 'Scripts')};${process.env.PATH}` };
}

exports.register = ({ ipcMain, app }) => {
  let shells = null;
  ipcMain.handle('pty:shells', () => (shells ??= detectShells()));
  ipcMain.handle('claude:status', () => findClaude());

  // opts: {shell, cwd, cols, rows, interpreter, command?: string to run in the shell, env?}
  ipcMain.handle('pty:create', (e, opts = {}) => {
    shells ??= detectShells();
    const shell = shells.find((s) => s.id === opts.shell) || shells.find((s) => s.id === 'powershell');
    let args = [...shell.args];
    if (opts.command) {
      if (shell.id === 'cmd') args = ['/k', opts.command];
      else if (shell.id === 'gitbash' || shell.id === 'wsl') args = [...args.filter((a) => a !== '-i'), '-c', `${opts.command}; exec bash -i`];
      else args = [...args, '-NoExit', '-Command', opts.command];
    }
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    const env = { ...process.env, ...venvEnv(opts.interpreter), ...opts.env, TERM_PROGRAM: 'PyIDE', COLORTERM: 'truecolor' };
    // The official Claude Code installer puts claude.exe in ~/.local/bin without adding it to PATH; make `claude` work here.
    const localBin = path.join(os.homedir(), '.local', 'bin');
    if (fs.existsSync(localBin) && !(env.PATH || '').toLowerCase().split(';').includes(localBin.toLowerCase())) env.PATH = `${localBin};${env.PATH}`;
    delete env.ELECTRON_RUN_AS_NODE;
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
    sessions.set(id, { proc, owner });
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
    proc.onExit(({ exitCode }) => {
      sessions.delete(id);
      if (!owner.isDestroyed()) setImmediate(() => owner.send('pty:exit', { id, code: exitCode }));
    });
    owner.once('destroyed', () => { try { proc.kill(); } catch {} sessions.delete(id); });
    return { id, shell: shell.id, shellName: shell.name, pid: proc.pid };
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
