// New Project and Get from VCS: create the project folder and its files, and run the setup commands (venv, pip,
// git) as streamed processes the renderer shows in the wizard.
const fs = require('fs');
const os = require('os');
const path = require('path');

function register({ ipcMain, app, startProcess }) {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${os.type()} ${os.release()} ${process.arch}`,
    home: os.homedir(),
  }));

  // Fails if the folder exists and is not empty, so a project is never written over another.
  // files: {relative path: text content | null for an empty folder}
  ipcMain.handle('project:create', (_e, dir, files = {}) => {
    if (!path.isAbsolute(dir)) throw new Error('The location must be an absolute path');
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const target = path.resolve(dir, rel);
      if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Bad path ${rel}`);
      if (content === null) fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
      }
    }
    return true;
  });

  // A setup step (python -m venv, pip install, git init, django-admin) streamed through proc:data / proc:exit.
  ipcMain.handle('project:exec', (_e, cmd, args, cwd) => startProcess(cmd, args, { cwd, windowsHide: true }));

  ipcMain.handle('project:clone', (_e, url, dir) => {
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    return startProcess('git', ['clone', '--progress', url, dir], { cwd: path.dirname(dir), windowsHide: true });
  });

  ipcMain.handle('project:suggestName', (_e, parent, base) => {
    let name = base;
    for (let i = 1; fs.existsSync(path.join(parent, name)); i++) name = `${base}${i}`;
    return name;
  });
}

module.exports = { register };
