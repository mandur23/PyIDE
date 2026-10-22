// Main side of the venv-setup plugin: what the project has (dependency files, a virtual environment, uv) and creating
// the environment with `python -m venv` or `uv venv`. Nothing runs for a project the user has not trusted.
const fs = require('fs');
const path = require('path');
const deps = require('../packages/deps');
const { findTool, venvOf } = require('./packages');
const trust = require('../trust');
const { scan } = require('../fs-scan');

const DEP_FILE = /^(requirements[^\\/]*\.txt|pyproject\.toml|pipfile)$/i;

exports.register = ({ ipcMain, startProcess }) => {
  // executables: the local interpreters the IDE lists. -> {trusted: false} | {trusted, files: [names], venv: path|null,
  // manager: 'pip'|'uv'|'poetry', uv: path|null (only for a uv project), bases: [executables that are not venvs]}
  ipcMain.handle('venv-setup:inspect', async (_e, root, executables = []) => {
    if (!root || !trust.isTrusted(root)) return { trusted: false };
    let names = [];
    try { names = await fs.promises.readdir(root); } catch {}
    const files = names.filter((n) => DEP_FILE.test(n)).sort();
    const venvs = await scan('venvs', root).catch(() => []);
    const { manager } = files.length ? deps.detect(root) : { manager: 'pip' };
    return {
      trusted: true, files, venv: venvs[0] || null, manager,
      uv: manager === 'uv' ? findTool('uv', null) : null,
      bases: executables.filter((exe) => typeof exe === 'string' && !venvOf(exe)),
    };
  });

  // opts: {dir: absolute folder to create, base: {executable} | null, uv: use `uv venv`} -> {id, command} | {error}
  ipcMain.handle('venv-setup:create', (_e, root, { dir, base, uv } = {}) => {
    if (!root || !trust.isTrusted(root)) return { error: 'The project is not trusted.' };
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { error: 'Invalid location.' };
    if (fs.existsSync(dir)) return { error: `${dir} already exists` };
    const shown = path.relative(root, dir) || dir;
    const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (uv) {
      const exe = findTool('uv', null);
      if (!exe) return { error: 'uv not found' };
      return { id: startProcess(exe, ['venv', dir], { cwd: root }), command: `uv venv ${quote(shown)}` };
    }
    if (!base?.executable) return { error: 'No base interpreter.' };
    return { id: startProcess(base.executable, ['-m', 'venv', dir], { cwd: root }), command: `${quote(base.executable)} -m venv ${quote(shown)}` };
  });
};
