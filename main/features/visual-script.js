const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The Python a visual script runs as: <userData>/visual-script/<sha1 of the .pyflow path>/<name>.py. One folder per
// script keeps the file name the user sees in tracebacks while two demo.pyflow files in different folders never share
// a file. The path is hashed in lower case because Windows paths are case-insensitive.
exports.register = ({ ipcMain, app }) => {
  ipcMain.handle('visual-script:write', (_e, pyflowPath, code) => {
    if (typeof pyflowPath !== 'string' || !path.isAbsolute(pyflowPath) || typeof code !== 'string') throw new Error('visual-script:write needs an absolute .pyflow path and the code');
    const hash = crypto.createHash('sha1').update(path.resolve(pyflowPath).toLowerCase()).digest('hex');
    const dir = path.join(app.getPath('userData'), 'visual-script', hash);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(pyflowPath).replace(/\.pyflow$/i, '') || 'script';
    // Python puts the script's folder first on sys.path, so random.pyflow run as random.py would import itself
    // instead of the module its Call Python node names.
    const imports = new Set([...code.matchAll(/^(?:import|from)\s+(\w+)/gm)].map((m) => m[1].toLowerCase()));
    const file = path.join(dir, `${imports.has(base.toLowerCase()) ? `${base}_pyflow` : base}.py`);
    fs.writeFileSync(file, code, 'utf8');
    return file;
  });
};
