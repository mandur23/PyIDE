// Java and C/C++: lists the JDKs and C/C++ compilers (built-in and on this computer) and starts their tools (javac,
// java, gcc, g++, a built program) with the toolchain first on PATH, streamed through proc:data / proc:exit.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolchains } = require('../installer/toolchains');

const TOOL = /^[\w+.-]+$/;

// -> {code, out}; a probe that hangs (a broken compiler waiting on something) counts as failed after 10 seconds, and
// one Windows refuses to start (not a program: spawn throws UNKNOWN) right away.
const probe = (cmd, args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout}${stderr}` });
    });
  } catch (err) {
    resolve({ code: -1, out: err.message });
  }
});

exports.register = ({ ipcMain, startProcess, procs }) => {
  const toolchains = createToolchains({ run: probe });
  let argfiles = 0;

  ipcMain.handle('toolchains:list', (_e, kind) => toolchains.detect(kind));

  // spec: {toolchain: {kind, home, bin}, cmd: a tool in its bin folder ('javac') or an absolute path (a built
  // program), args, cwd, env, argfile?: arguments written to an @file (javac and gcc read them) so a long source list
  // fits on the command line, makeDirs?: folders to create first (gcc's -o folder)}.
  ipcMain.handle('toolchains:start', (_e, spec = {}) => {
    const { toolchain = {}, cmd = '', args = [], cwd, env = {}, argfile, makeDirs = [] } = spec;
    if (typeof toolchain.bin !== 'string' || !path.isAbsolute(toolchain.bin)) throw new Error('No toolchain');
    const program = TOOL.test(cmd) ? path.join(toolchain.bin, `${cmd}.exe`) : cmd;
    if (!path.isAbsolute(program)) throw new Error(`Bad program ${cmd}`);
    for (const d of makeDirs) if (typeof d === 'string' && path.isAbsolute(d)) fs.mkdirSync(d, { recursive: true });
    const extra = {};
    if (toolchain.kind === 'jdk' && toolchain.home) extra.JAVA_HOME = toolchain.home;
    const argv = [...args];
    let file = null;
    if (Array.isArray(argfile) && argfile.length) {
      file = path.join(os.tmpdir(), `pyide-args-${process.pid}-${++argfiles}.txt`);
      // Forward slashes and quotes: both tools treat a backslash inside quotes as an escape.
      fs.writeFileSync(file, argfile.map((a) => `"${String(a).replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join('\n'));
      argv.push(`@${file}`);
    }
    // process.env spells it Path; another key spelled PATH would leave two in the child's environment.
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const id = startProcess(program, argv, {
      cwd, windowsHide: true,
      env: { ...env, ...extra, [pathKey]: `${toolchain.bin};${process.env[pathKey] || ''}` },
    });
    if (file) {
      const child = procs.get(id);
      if (child) child.once('exit', () => fs.rm(file, { force: true }, () => {}));
      else fs.rm(file, { force: true }, () => {});
    }
    return id;
  });
};
