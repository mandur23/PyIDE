// Language servers from the Install Manager for C/C++ (clangd), Rust (rust-analyzer), Go (gopls), Kotlin (JetBrains'
// Kotlin Language Server), C# (csharp-ls), Ruby (Ruby LSP) and PHP (Intelephense), each served by main/lsp-server.js
// under its own channel (lsp-<id>:*), and clang-format for Reformat Code in C and C++ files. A server starts only in a
// trusted project and only from the install folder (main/installer/toolchains.js), never from a path the renderer sends.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isTrusted } = require('../trust');
const { createToolchains, findTool } = require('../installer/toolchains');
const { serve } = require('../lsp-server');

const expected = (message, code) => Object.assign(new Error(message), { code, expected: true });
const asNode = { ELECTRON_RUN_AS_NODE: '1' };

// id -> {toolchain, name, spawn(home, root, ctx) -> {cmd, args, env?}, initializationOptions?(root, ctx), watched?}
const SERVERS = {
  clangd: {
    toolchain: 'clangd', name: 'clangd',
    // Without a compile_commands.json clangd uses its fallback flags; C++ files get the newest standard.
    spawn: (home) => ({ cmd: path.join(home, 'bin', 'clangd.exe'), args: ['--background-index', '--header-insertion=never', '--log=error'] }),
    initializationOptions: () => ({ fallbackFlags: ['-Wall'] }),
    watched: /(^|[\\/])(compile_commands\.json|compile_flags\.txt|\.clangd)$/i,
  },
  rust: {
    toolchain: 'rustanalyzer', name: 'rust-analyzer',
    spawn: (home) => ({ cmd: path.join(home, 'rust-analyzer.exe'), args: [] }),
    watched: /(^|[\\/])Cargo\.(toml|lock)$|\.rs$/i,
  },
  go: {
    toolchain: 'gopls', name: 'gopls',
    spawn: (home) => ({ cmd: path.join(home, 'gopls.exe'), args: ['serve'] }),
    watched: /(^|[\\/])go\.(mod|sum|work)$|\.go$/i,
  },
  kotlin: {
    toolchain: 'kotlin', name: 'Kotlin Language Server',
    // Its launcher is a batch file (it starts the bundled Java runtime); the arguments are fixed.
    spawn: (home) => ({ cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', path.join(home, 'kotlin-lsp.cmd'), '--stdio'] }),
    watched: /\.(kts?|gradle)$|(^|[\\/])pom\.xml$/i,
  },
  csharp: {
    toolchain: 'csharpls', name: 'csharp-ls',
    spawn: (home) => ({ cmd: path.join(home, 'csharp-ls.exe'), args: [] }),
    watched: /\.(cs|csproj|sln|slnx)$/i,
  },
  ruby: {
    toolchain: 'rubylsp', name: 'Ruby LSP', runtime: 'gem',
    spawn: (home) => {
      const ruby = findTool('gem');
      if (!ruby) throw expected('Ruby is not on PATH', 'noruntime');
      return { cmd: ruby.cmd, args: [path.join(home, 'bin', 'ruby-lsp')], env: { GEM_HOME: home, GEM_PATH: home } };
    },
    watched: /(^|[\\/])Gemfile(\.lock)?$|\.rb$/i,
  },
  php: {
    toolchain: 'intelephense', name: 'Intelephense',
    // An npm package: runs with the IDE as Node.
    spawn: (home) => ({ cmd: process.execPath, args: [path.join(home, 'node_modules', 'intelephense', 'lib', 'intelephense.js'), '--stdio'], env: asNode }),
    initializationOptions: (root, ctx) => ({ storagePath: path.join(ctx.app.getPath('userData'), 'intelephense'), clearCache: false }),
    watched: /\.php$|(^|[\\/])composer\.(json|lock)$/i,
  },
};

exports.register = (ctx) => {
  const toolchains = createToolchains();
  const { ipcMain } = ctx;

  for (const [id, def] of Object.entries(SERVERS)) {
    serve(ctx, `lsp-${id}`, async (root) => {
      if (!isTrusted(root)) throw expected('The project is not trusted', 'untrusted');
      const st = toolchains.status(def.toolchain);
      if (!st.installed) throw expected(`${def.name} is not installed`, 'missing');
      // Tests run every server as a stand-in script (PYIDE_LSP_STANDIN) once its install folder is there.
      const standIn = process.env.PYIDE_LSP_STANDIN;
      const run = standIn ? { cmd: process.execPath, args: [standIn, id], env: asNode } : def.spawn(st.home, root, ctx);
      return {
        name: def.name,
        processName: def.name,
        shutdownMs: 2000,
        spawn: () => ({ cmd: run.cmd, args: run.args, cwd: root, env: { ...process.env, ...run.env } }),
        initializationOptions: def.initializationOptions?.(root, ctx) || {},
        settingsFor: () => null,
        watched: def.watched,
      };
    });
  }

  // clang-format: the text formatted with the project's .clang-format (found from the file's folder up), else LLVM's
  // style with the editor's indentation. -> {text} | {error} | null (not installed).
  ipcMain.handle('language-servers:clangFormat', async (_e, text, file, { tabSize = 4, insertSpaces = true } = {}) => {
    const st = toolchains.status('clangformat');
    if (!st.installed || typeof text !== 'string' || typeof file !== 'string') return null;
    const exe = path.join(st.home, 'clang_format', 'data', 'bin', 'clang-format.exe');
    const fallback = `{BasedOnStyle: LLVM, IndentWidth: ${Number(tabSize) || 4}, UseTab: ${insertSpaces ? 'Never' : 'Always'}, TabWidth: ${Number(tabSize) || 4}}`;
    const args = ['--style=file', `--fallback-style=${fallback}`, `--assume-filename=${file}`];
    // Tests run a stand-in script instead (PYIDE_CLANG_FORMAT_STANDIN) once the install folder is there.
    const standIn = process.env.PYIDE_CLANG_FORMAT_STANDIN;
    return new Promise((resolve) => {
      const child = standIn
        ? spawn(process.execPath, [standIn, ...args], { windowsHide: true, cwd: path.dirname(file), env: { ...process.env, ...asNode } })
        : spawn(exe, args, { windowsHide: true, cwd: path.dirname(file) });
      const out = [];
      let err = '';
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => resolve({ error: e.message }));
      child.on('close', (code) => resolve(code === 0 ? { text: Buffer.concat(out).toString('utf8') } : { error: err.trim() || `clang-format exited with code ${code}` }));
      child.stdin.end(text, 'utf8');
    });
  });
  // Which servers' package managers are on this computer (Install Manager rows of `via` servers).
  ipcMain.handle('language-servers:tools', () => Object.fromEntries(['go', 'gem', 'dotnet', 'npm'].map((t) => [t, !!findTool(t)])));
  ipcMain.handle('language-servers:installed', () => Object.fromEntries(Object.entries(SERVERS).map(([id, d]) => [id, toolchains.status(d.toolchain).installed])));
  fs.mkdirSync(path.join(ctx.app.getPath('userData'), 'intelephense'), { recursive: true });
};

exports.SERVERS = SERVERS;
