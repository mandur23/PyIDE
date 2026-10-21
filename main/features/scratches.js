// Scratch files (PyCharm's File › New Scratch File): one folder, <userData>/scratches, outside every project and shared
// by all of them. New files are named scratch.<ext>, scratch_1.<ext>, … (the first free name), created exclusively so
// two windows never get the same one. A watcher tells the renderer when files appear, go or are renamed there.
const fs = require('fs');
const path = require('path');

exports.register = (ctx) => {
  const dir = path.join(ctx.app.getPath('userData'), 'scratches');
  let watcher = null;
  let timer = null;

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
    if (!watcher) {
      try {
        watcher = fs.watch(dir, () => {
          clearTimeout(timer);
          timer = setTimeout(() => ctx.send('scratches:changed', { dir }), 150);
        });
        watcher.on('error', () => { watcher?.close(); watcher = null; });
      } catch { watcher = null; }
    }
    return dir;
  }

  ctx.ipcMain.handle('scratches:dir', () => ensureDir());

  ctx.ipcMain.handle('scratches:list', () => {
    ensureDir();
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(dir, d.name));
  });

  ctx.ipcMain.handle('scratches:create', (_e, ext, text = '') => {
    if (!/^[a-z0-9]{1,10}$/i.test(String(ext))) throw new Error(`invalid scratch file extension: ${ext}`);
    ensureDir();
    for (let i = 0; i < 10000; i++) {
      const file = path.join(dir, i ? `scratch_${i}.${ext}` : `scratch.${ext}`);
      try {
        fs.writeFileSync(file, String(text), { flag: 'wx' });
        return file;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw new Error('too many scratch files');
  });
};
