const { spawn } = require('child_process');

const CHECK_SCRIPT = `
import ast, sys, json
src = sys.stdin.buffer.read().decode('utf-8')
try:
    ast.parse(src)
    print('[]')
except SyntaxError as e:
    print(json.dumps([{'line': e.lineno or 1, 'col': e.offset or 1, 'endLine': getattr(e, 'end_lineno', None) or e.lineno or 1, 'endCol': getattr(e, 'end_offset', None) or (e.offset or 1) + 1, 'msg': e.msg}]))
`;

exports.register = ({ ipcMain }) => {
  ipcMain.handle('py:check', (_e, interp, text) => new Promise((resolve) => {
    const p = spawn(interp.cmd, [...interp.args, '-c', CHECK_SCRIPT]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve([]));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve([]); } });
    p.stdin.end(text, 'utf8');
  }));
};
