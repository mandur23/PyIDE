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
const { outputBatch } = require('../output-batch');

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
  // By its full path: node-pty looks a bare name up on PATH only, and a PATH without PowerShell's folder (edited by an
  // installer or by hand) would leave the default shell unable to start.
  const winPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  shells.push({ id: 'powershell', name: 'Windows PowerShell', file: fs.existsSync(winPowerShell) ? winPowerShell : 'powershell.exe', args: ['-NoLogo'] });
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

// Like PyCharm, a terminal opened while a venv interpreter is selected starts with that venv active: its Scripts
// first on PATH and VIRTUAL_ENV set for every shell, and in PowerShell and Command Prompt the venv's own activate
// script run as the shell starts (venvActivation), which marks the prompt with the venv's name and defines deactivate.
const venvOf = (interpExe) => {
  if (typeof interpExe !== 'string' || !path.isAbsolute(interpExe)) return null;
  const venv = path.dirname(path.dirname(interpExe));
  return fs.existsSync(path.join(venv, 'pyvenv.cfg')) ? venv : null;
};
// Windows names the variable Path, and so does process.env started from Explorer: a second key spelled PATH would be a
// second variable in the shell's environment, which finds the first one.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
function venvEnv(interpExe, withPath = true) {
  const venv = venvOf(interpExe);
  if (!venv) return {};
  return withPath ? { VIRTUAL_ENV: venv, [PATH_KEY]: `${path.join(venv, 'Scripts')};${process.env.PATH}` } : { VIRTUAL_ENV: venv };
}
// The shell arguments (and variables) that run the venv's activate script after the user's profile, as
// {args, env, setsPath}. PowerShell reads Activate.ps1 as a script block: the execution policy (Restricted on many
// computers) applies to script files, so running the file would be refused, and changing the policy would be a system
// change. -VenvDir tells it where it is, which it otherwise works out from its own file path. PowerShell takes ‘ ’ ‚ ‛
// as single quotes too, so each is doubled like '. Command Prompt gets the script's quoted path in a variable: cmd
// expands it once and reads one quoted name, where on the command line & ^ % ( ) in a folder name would be operators
// (a venv in "a&calc" would run calc). activate.bat puts Scripts on PATH itself; with the venv's path there already,
// its unquoted `set _OLD_VIRTUAL_PATH=%PATH%` would run what follows an & in it.
function venvActivation(shellId, venv) {
  const scripts = path.join(venv, 'Scripts');
  if ((shellId === 'powershell' || shellId === 'pwsh') && fs.existsSync(path.join(scripts, 'Activate.ps1'))) {
    const q = (s) => `'${s.replace(/['‘’‚‛]/g, '$&$&')}'`;
    return { args: ['-NoExit', '-Command', `. ([scriptblock]::Create((Get-Content -Raw -LiteralPath ${q(path.join(scripts, 'Activate.ps1'))}))) -VenvDir ${q(venv)}`], env: {} };
  }
  if (shellId === 'cmd' && fs.existsSync(path.join(scripts, 'activate.bat'))) {
    return { args: ['/k', '%PYIDE_VENV_ACTIVATE%'], env: { PYIDE_VENV_ACTIVATE: `"${path.join(scripts, 'activate.bat')}"` }, setsPath: true };
  }
  return { args: [], env: {} };
}

// A session's folder must be a local absolute path (C:\...). A UNC path (\\host\share) is refused before any fs call:
// the folder can come from what a program printed in the terminal (OSC 7 / OSC 9;9), and touching \\host\share
// would open an SMB connection to that host and offer it the user's NTLM credentials.
const localDir = (p) => typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p) && !/[\x00-\x1f]/.test(p);

// node-pty's ConPTY agent (1.1) never closes the pipe a session's input goes through, and stops the thread that reads
// its output only when the session is killed, not when the shell exits by itself: one pipe, and for an exited shell one
// thread, per terminal ever opened. Its exit event comes after the output is drained, so both go then.
function releasePty(proc) {
  const agent = proc._agent;
  try { agent?._inSocket?.destroy(); } catch {}
  try { agent?._outSocket?.destroy(); } catch {}
  try { agent?._conoutSocketWorker?.dispose(); } catch {}
}

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
  // -> {id, shell, shellName, pid, host}, or {error: 'shellNotFound', shell, shellName, file} when the shell's program
  // cannot be found.
  ipcMain.handle('pty:create', async (e, opts = {}) => {
    opts = { ...opts, cwd: localDir(opts.cwd) ? opts.cwd : undefined };
    const known = await (shells ??= detectShells());
    let shell = known.find((s) => s.id === opts.shell) || known.find((s) => s.id === 'powershell');
    let args = [...shell.args];
    let activation = null;
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
    } else if (venvOf(opts.interpreter)) {
      activation = venvActivation(shell.id, venvOf(opts.interpreter));
      args = [...args, ...activation.args];
    }
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    // claudeIde.ideEnv(): CLAUDE_CODE_SSE_PORT, so claude started in any PyIDE terminal connects to this window.
    // opts.envFiles: the project's .env files (Settings › Terminal); a remote session's shell does not get them.
    const fileEnv = opts.envFiles?.length && !opts.target ? loadFiles(opts.envFiles) : {};
    const env = { ...process.env, ...venvEnv(opts.interpreter, !activation?.setsPath), ...claudeIde.ideEnv(), ...fileEnv, ...opts.env, ...activation?.env,
      TERM_PROGRAM: 'PyIDE', COLORTERM: 'truecolor' };
    // The official Claude Code installer puts claude.exe in ~/.local/bin without adding it to PATH; make `claude` work here.
    const localBin = path.join(os.homedir(), '.local', 'bin');
    if (fs.existsSync(localBin) && !(env[PATH_KEY] || '').toLowerCase().split(';').includes(localBin.toLowerCase())) env[PATH_KEY] = `${localBin};${env[PATH_KEY]}`;
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, targetEnv);
    let proc;
    try {
      proc = pty.spawn(shell.file, args, {
        name: 'xterm-256color',
        cols: Math.max(2, opts.cols || 80),
        rows: Math.max(2, opts.rows || 24),
        cwd,
        env,
        useConpty: true,
      });
    } catch (err) {
      release?.();
      // A shell that is not installed (or not on PATH) is the user's to fix, so it is an answer, not an IDE error.
      // node-pty says only "File not found: " with an empty name.
      if (/file not found/i.test(err?.message)) return { error: 'shellNotFound', shell: shell.id, shellName: shell.name, file: shell.file };
      throw err;
    }
    const id = nextId++;
    const owner = e.sender;
    watchNavigation(owner);
    sessions.set(id, { proc, owner, nav: navigations.get(owner) });
    // ConPTY delivers about one chunk per line and one per event-loop turn, so a flood (a long `dir`, a chatty build)
    // is batched by time: at most one message per 10 ms window, the first after a pause sent at once.
    const batch = outputBatch((data) => { if (!owner.isDestroyed()) owner.send('pty:data', { id, data }); });
    proc.onData((data) => batch.push(data));
    // Closing the window ends its shells; a shell that ends first takes its listener with it, or every session ever
    // opened would keep one on the window (and its proc alive).
    const onWindowGone = () => { try { proc.kill(); } catch {} sessions.delete(id); };
    owner.once('destroyed', onWindowGone);
    proc.onExit(({ exitCode }) => {
      releasePty(proc);
      release?.();
      sessions.delete(id);
      owner.removeListener('destroyed', onWindowGone);
      setImmediate(() => {
        batch.flush();
        if (!owner.isDestroyed()) owner.send('pty:exit', { id, code: exitCode });
      });
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
