// The project files whose class statements may name a class among their bases, for the type-hierarchy gutter markers
// (renderer/features/type-hierarchy). Code vision's word index (main/features/code-vision.js) keeps them on its worker,
// whether or not the code vision plugin is enabled.
const codeVision = require('./code-vision');

exports.register = ({ ipcMain }) => {
  // epoch: changes whenever Python files may have changed on disk.
  ipcMain.handle('type-hierarchy:subclassFiles', (_e, root, names, epoch) => codeVision.subclassFiles(root, names, epoch));
};
