// File Watchers (PyCharm's Settings › Tools › File Watchers): runs a watcher's program for a file of the project.
// The watchers live in the user's settings, keyed by project, never in the project itself, so a cloned repository
// cannot define programs to start; and nothing runs for a project the user has not trusted (main/trust.js).
const path = require('path');
const { isTrusted } = require('../trust');
const { startTool } = require('./run');

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const inside = (file, root) => norm(file) === norm(root) || norm(file).startsWith(norm(root) + path.sep);

exports.register = (ctx) => {
  // spec: {root, file, program, args, cwd, pyInterpreter}; macros ($FilePath$, $FileDir$…) are expanded here.
  // -> {id, command, cwd} or {error: 'untrusted' | 'outside' | 'noProgram' | 'noCwd' | …}
  ctx.ipcMain.handle('fileWatchers:run', (_e, spec = {}) => {
    const { root, file } = spec;
    if (typeof root !== 'string' || typeof file !== 'string' || !root || !file) return { error: 'badRequest' };
    if (!isTrusted(root)) return { error: 'untrusted' };
    if (!inside(file, root)) return { error: 'outside' };
    const filePath = path.resolve(file);
    return startTool(ctx, {
      program: spec.program, args: spec.args, cwd: spec.cwd, defaultCwd: path.dirname(filePath),
      macros: { projectDir: path.resolve(root), filePath, pyInterpreter: typeof spec.pyInterpreter === 'string' ? spec.pyInterpreter : '' },
    });
  });
};
