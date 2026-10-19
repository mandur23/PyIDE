// Main-process failures on demand: an uncaught exception thrown from this module and a Python sidecar that crashes.
const { spawn } = require('child_process');

const CRASH = [
  'import sys',
  "print('diag sidecar starting', file=sys.stderr)",
  "print('Traceback (most recent call last):', file=sys.stderr)",
  "print('  File \"fake_sidecar.py\", line 3, in <module>', file=sys.stderr)",
  "print('RuntimeError: diag sidecar boom', file=sys.stderr)",
  'sys.exit(3)',
].join('\n');

exports.register = ({ ipcMain, diagnostics }) => {
  ipcMain.handle('diagflaky:uncaught', () => {
    setTimeout(function flakyMainTimer() { throw new Error('diag-flaky: main-process failure'); }, 0);
    return true;
  });
  ipcMain.handle('diagflaky:sidecar', (_e, cmd, args = []) => {
    const proc = spawn(cmd, [...args, '-c', CRASH], { windowsHide: true });
    diagnostics.watchProcess(proc, { name: 'fake_sidecar.py' });
    return proc.pid;
  });
};
