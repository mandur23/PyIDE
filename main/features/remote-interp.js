// Remote interpreters plugin, main side: detection, checking and saving targets, secrets (safeStorage only) and the
// Pyright library sync. Running things in targets is main/remote, which the other features call directly.
const fs = require('fs');
const remote = require('../remote');
const askpass = require('../remote/askpass');
const T = require('../remote/target');
const { runRaw } = require('../remote/session');

exports.register = ({ ipcMain, app, send }) => {
  remote.setNotifier(send);
  ipcMain.handle('remote-interp:messages', (_e, dict) => remote.setMessages(dict));
  ipcMain.handle('remote-interp:detect', () => remote.detect());

  // target: {id, kind, python?, ...kind fields}; secrets: {password?, passphrase?} typed into the form.
  // -> {ok, target: {...target, python, version, executable, label}} | {ok: false, error}
  ipcMain.handle('remote-interp:add', async (_e, target, secrets = {}) => {
    const t = { ...target, id: target.id || T.targetId() };
    const r = await remote.probe(t, secrets.password || secrets.passphrase ? secrets : null);
    if (!r.ok) return r;
    for (const kind of ['password', 'passphrase']) if (secrets[kind]) askpass.setSecret(t.id, kind, secrets[kind]);
    const saved = { ...t, python: r.python, version: r.version };
    return { ok: true, target: { ...saved, executable: T.executableUri(saved), name: T.describe(saved) } };
  });

  ipcMain.handle('remote-interp:secrets', (_e, id) => askpass.hasSecrets(id));
  ipcMain.handle('remote-interp:setSecret', (_e, id, kind, value) => askpass.setSecret(id, kind, value));

  ipcMain.handle('remote-interp:remove', async (_e, target) => {
    askpass.forget(target.id);
    fs.rmSync(remote.libsDir(target.id), { recursive: true, force: true });
    if (target.kind === 'docker' || target.kind === 'compose') {
      const docker = T.findTool('docker');
      if (docker) {
        const ps = await runRaw(docker, ['ps', '-aq', '--filter', `label=dev.pyide.target=${target.id}`], { timeout: 30000 });
        const ids = ps.stdout.split(/\s+/).filter(Boolean);
        if (ids.length) await runRaw(docker, ['rm', '-f', ...ids], { timeout: 60000 });
      }
    }
  });

  ipcMain.handle('remote-interp:syncLibs', async (_e, interp) => {
    try { return await remote.syncLibs(interp); } catch (err) { return { ok: false, error: err.message }; }
  });

  // Uploads the project now (SSH); the other kinds see the folder itself.
  ipcMain.handle('remote-interp:syncProject', async (_e, interp) => {
    try {
      const s = await remote.session(interp.target).ready({ sync: true });
      return { ok: true, uploaded: s.lastUpload || 0, remoteRoot: s.remoteRoot || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  app.on('will-quit', () => remote.stopContainers());
};
