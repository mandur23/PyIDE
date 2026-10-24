const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remote = require('../remote');
const { withEnvFiles } = require('../dotenv');
const { isTrusted } = require('../trust');

// PyCharm adds the content root to PYTHONPATH for every Python run configuration; keep any PYTHONPATH the user set.
const withPath = (env = {}, extra = []) => {
  const parts = [...extra, env.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean);
  return parts.length ? { ...env, PYTHONPATH: parts.join(';') } : env;
};

exports.withPath = withPath;

// ---------- working directory ----------
// Windows starts no process in a working directory longer than this (MAX_PATH less the trailing backslash and the
// NUL), whatever the long path setting; spawn then fails with ENOENT, as if the program were missing.
const MAX_CWD = 258;

// The 8.3 form of a folder (C:\Users\NAME~1\…) when its volume keeps short names; null when it does not, or on error.
const shortPath = (dir) => new Promise((resolve) => {
  if (process.platform !== 'win32') return resolve(null);
  execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`],
    { windowsHide: true, windowsVerbatimArguments: true, timeout: 5000, encoding: 'utf8' },
    (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
});

// A folder a program can be started in for cwd: cwd itself, its 8.3 form (the same folder), or else the first usable
// of fallbacks (the project root) or the home folder. -> {cwd, tooLong}; tooLong: cwd, when another folder stands in.
async function workingDir(cwd, fallbacks = []) {
  if (process.platform !== 'win32' || !cwd || path.resolve(cwd).length <= MAX_CWD) return { cwd, tooLong: null };
  const usable = (d) => !!d && path.resolve(d).length <= MAX_CWD && isDir(d);
  const short = await shortPath(path.resolve(cwd));
  if (usable(short)) return { cwd: short, tooLong: null };
  return { cwd: [...fallbacks, os.homedir()].find(usable) || cwd, tooLong: cwd };
}

// ---------- external tools (before launch tasks, file watchers) ----------
// Shell-like split, as the renderer's ide.run.parseArgs: whitespace separates, quotes group and are removed.
function splitArgs(s) {
  const out = [];
  let cur = null;
  let quote = null;
  for (const ch of String(s || '')) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur ??= '';
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? '') + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// PyCharm's macros for a file, the project and the interpreter. ctx: {projectDir, filePath?, pyInterpreter?}.
function macroValues({ projectDir = '', filePath = '', pyInterpreter = '' } = {}) {
  const v = { ProjectDir: projectDir, ProjectFileDir: projectDir, ProjectName: projectDir ? path.basename(projectDir) : '' };
  if (filePath) {
    const ext = path.extname(filePath);
    const rel = projectDir ? path.relative(projectDir, filePath) : filePath;
    Object.assign(v, {
      FilePath: filePath,
      FileName: path.basename(filePath),
      FileNameWithoutExtension: path.basename(filePath, ext),
      FileNameWithoutAllExtensions: path.basename(filePath).replace(/\..*$/, ''),
      FileExt: ext.replace(/^\./, ''),
      FileDir: path.dirname(filePath),
      FileRelativePath: rel,
      FileDirRelativeToProjectRoot: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      FileParentDir: path.basename(path.dirname(filePath)),
    });
  }
  if (pyInterpreter) Object.assign(v, { PyInterpreterPath: pyInterpreter, PyInterpreterDirectory: path.dirname(pyInterpreter) });
  return v;
}

// $FilePath$ (PyCharm) and ${FilePath} (VS Code style) both work; an unknown macro stays as written.
function expandMacros(text, values) {
  return String(text ?? '').replace(/\$([A-Za-z]+)\$|\$\{([A-Za-z]+)\}/g, (m, a, b) => {
    const name = a || b;
    const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? m : values[key];
  });
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const EXTS = () => {
  const list = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter((e) => ['.com', '.exe', '.bat', '.cmd'].includes(e));
  return list.length ? list : ['.com', '.exe', '.bat', '.cmd'];
};
// A program name or path -> the file to start. A bare name is looked up in the absolute PATH folders (never the
// working folder), with PATHEXT's extensions; an unknown one is returned as written, so spawn reports it.
function resolveProgram(program, cwd) {
  let p = String(program || '').trim().replace(/^"(.*)"$/, '$1');
  if (!p) return p;
  const hasDir = /[\\/]/.test(p);
  if (hasDir && !path.isAbsolute(p) && cwd) p = path.resolve(cwd, p);
  const withExt = (base) => (path.extname(base) && isFile(base) ? base : EXTS().map((e) => base + e).find(isFile));
  if (hasDir || path.isAbsolute(p)) return withExt(p) || p;
  for (const entry of String(process.env.PATH || '').split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!path.isAbsolute(dir) || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(dir)) continue;
    const hit = withExt(path.join(dir, p));
    if (hit) return hit;
  }
  return p;
}

// A .cmd/.bat runs through cmd.exe, which parses the line: each argument is quoted for the C runtime and its cmd
// metacharacters escaped, as cross-spawn does. An npm shim (node_modules\.bin\x.cmd, or one npm/cmd-shim wrote, such as
// %APPDATA%\npm\sass.cmd) hands its arguments on through %*, which cmd parses a second time, so there they are escaped
// twice; a batch file of the user's own reads "%~1" and must get the argument as written, so once.
// cmd.exe looks for a bare command (a shim's "node") in the working folder before PATH unless
// NoDefaultCurrentDirectoryInExePath is set; with it, a node.bat the project ships cannot stand in for node.
const META = /([()\][%!^"`<>&|;, *?])/g;
const cmdArg = (a, twice) => {
  const s = `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1');
  return twice ? s.replace(META, '^$1') : s;
};
function isNpmShim(file) {
  if (/node_modules[\\/]\.bin[\\/][^\\/]+$/i.test(file)) return true;
  try {
    const text = fs.readFileSync(file, 'latin1');
    return text.includes('%*') && /:find_dp0\b|Created by npm/i.test(text);
  } catch { return false; }
}
function toolCommand(file, args) {
  if (!/\.(cmd|bat)$/i.test(file)) return { cmd: file, args, opts: {} };
  const twice = isNpmShim(file);
  const line = [path.normalize(file).replace(META, '^$1'), ...args.map((a) => cmdArg(a, twice))].join(' ');
  return {
    cmd: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    opts: { windowsVerbatimArguments: true, env: { NoDefaultCurrentDirectoryInExePath: '1' } },
  };
}

// Starts an external tool: {program, args (one string), cwd, defaultCwd, macros: {projectDir, filePath, pyInterpreter}}.
// -> {id, command, cwd} or {error}. Output streams as process events (ide.proc.attach).
function startTool(ctx, { program, args, cwd, defaultCwd, macros } = {}) {
  const values = macroValues(macros);
  const prog = expandMacros(program, values).trim();
  if (!prog) return { error: 'noProgram' };
  const dir = expandMacros(cwd, values).trim() || defaultCwd || values.ProjectDir || process.cwd();
  if (!isDir(dir)) return { error: 'noCwd', cwd: dir };
  const argv = splitArgs(args).map((a) => expandMacros(a, values));
  const file = resolveProgram(prog, dir);
  const c = toolCommand(file, argv);
  const id = ctx.startProcess(c.cmd, c.args, { cwd: dir, ...c.opts });
  const show = (a) => (/[\s"]/.test(a) || a === '' ? `"${a}"` : a);
  return { id, command: [file, ...argv].map(show).join(' '), cwd: dir };
}

Object.assign(exports, { splitArgs, macroValues, expandMacros, resolveProgram, isNpmShim, toolCommand, startTool, workingDir });

exports.register = (ctx) => {
  // envFiles: .env files under the explicit env (undefined: the project root's .env, roots[0])
  // The Run and Debug consoles ask first, to say which folder stands in for one that is too long (run:start and
  // debug:start then get a usable one; other callers get the same replacement without a word).
  ctx.ipcMain.handle('run:workingDir', (_e, cwd, fallbacks = []) => workingDir(cwd, fallbacks));
  ctx.ipcMain.handle('run:start', async (_e, interp, file, cwd, params = [], env = {}, roots = [], envFiles) => {
    const args = ['-u', file, ...params];
    const opts = { cwd, env: withPath(withEnvFiles(env, envFiles, roots[0]), roots) };
    if (remote.isRemote(interp)) return remote.startPython(ctx, interp, args, opts);
    opts.cwd = (await workingDir(cwd, roots)).cwd;
    return ctx.startProcess(interp.cmd, [...interp.args, ...args], opts);
  });
  // A before launch "Run External Tool" task. Its definition comes from the run configuration, which lives in the
  // user's settings, never in the project; still, like a file watcher, it starts nothing for a project the user has
  // not trusted (main/trust.js), since the tool runs in and on the project's files.
  ctx.ipcMain.handle('run:startTool', (_e, spec = {}) => {
    const projectDir = spec?.macros?.projectDir;
    if (typeof projectDir !== 'string' || !projectDir || !isTrusted(projectDir)) return { error: 'untrusted' };
    return startTool(ctx, { ...spec, defaultCwd: projectDir });
  });
};
