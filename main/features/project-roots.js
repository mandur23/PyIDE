// Mark Directory As (renderer/features/project-roots): the project's roots from main/project-roots.js, which Run, the
// test runner and Pyright read.
const projectRoots = require('../project-roots');

exports.register = ({ ipcMain }) => {
  // -> {sources, tests, excluded, detected: 'src' | null}; detected: the src layout's root became the record just now.
  ipcMain.handle('project-roots:get', (_e, root) => {
    const detected = projectRoots.adoptDetected(root);
    return { ...projectRoots.rootsOf(root), detected };
  });
  // kind: 'sources' | 'tests' | 'excluded', or null to unmark. -> the new roots, or null when refused.
  ipcMain.handle('project-roots:mark', (_e, root, folder, kind) => (root && folder ? projectRoots.mark(root, folder, kind ?? null) : null));
};
