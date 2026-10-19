// My Workspace: discovers how the open project is launched (.claude/launch.json, run*/start-*.bat|.ps1,
// python -m packages, __main__ scripts, PyCharm run configurations, Maven/Gradle), starts those launchers,
// checks ports before a server starts, and gathers the dashboard facts (git branch, venvs, README).
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { shell } = require('electron');

const MAX_DEPTH = 3;
const MAX_DIRS = 2500;
const MAX_READ = 256 * 1024;
// Folders that never hold launchers: tooling caches, build output, and the data/model folders of ML projects.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.idea', '.vscode', '.claude', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.gradle', '.mvn', '.cache', 'target', 'build', 'dist', 'out',
  'site-packages', 'data', 'dataset', 'datasets', 'model', 'models', 'checkpoints', 'ckpt', 'weights', 'pretrained',
  'logs', 'log', 'output', 'outputs', 'runs', 'wandb', 'mlruns', 'htmlcov', 'coverage', 'venv', 'env', '.eggs']);
const skipDir = (name) => SKIP_DIRS.has(name.toLowerCase()) || /^\.?venv/i.test(name) || name.endsWith('.egg-info');
const SCRIPT_DIRS = /^(scripts?|tools|bin)$/i;
const LAUNCH_NAME = /^(run|start|launch|serve)/i;

const readText = (file, max = MAX_READ) => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8').replace(/^﻿/, '');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
};
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const rel = (root, p) => path.relative(root, p) || '.';
const validPort = (n) => (Number.isInteger(n) && n >= 80 && n <= 65535 ? n : null);

// Shell-like split: whitespace separates, quotes group and are removed.
function parseArgs(s) {
  const out = [];
  let cur = null;
  let quote = null;
  for (const ch of s || '') {
    if (quote) { if (ch === quote) quote = null; else cur += ch; } else if (ch === '"' || ch === "'") { quote = ch; cur ??= ''; } else if (/\s/.test(ch)) { if (cur !== null) out.push(cur); cur = null; } else cur = (cur ?? '') + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const quote = (a) => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

// A port literal written next to "port": --port default, port=8000, PORT = 8765, "port": 8781, <port>8080</port>.
function findPort(text) {
  if (!text) return null;
  const pats = [
    /['"]--port['"][^)]*?default\s*=\s*(\d{2,5})/,
    /--port[= ]+(\d{2,5})\b/,
    /<port>\s*(\d{2,5})\s*<\/port>/i,
    /\bport\b['"]?\s*[:=,]\s*(?:int\()?\s*['"]?(\d{2,5})\b/i,
    /\bport\b[^\n\d]{0,24}?(\d{4,5})\b/i,
  ];
  for (const re of pats) {
    const m = text.match(re);
    const n = m && validPort(Number(m[1]));
    if (n) return n;
  }
  return null;
}

// argparse options of a script, for the hint under its name (long option preferred; positionals as <name>).
function argparseFlags(src) {
  const flags = [];
  for (const m of src.matchAll(/add_argument\(\s*([^)]*)/g)) {
    const head = m[1].split(/\b\w+\s*=/)[0];
    const strs = [...head.matchAll(/(['"])(.*?)\1/g)].map((x) => x[2]);
    const opts = strs.filter((s) => /^-{1,2}[A-Za-z]/.test(s));
    const flag = opts.length ? opts.find((s) => s.startsWith('--')) || opts[0] : /^[A-Za-z_][\w-]*$/.test(strs[0] || '') ? `<${strs[0]}>` : null;
    if (flag && !flags.includes(flag)) flags.push(flag);
  }
  return flags.slice(0, 12);
}

// JSON with // and /* */ comments and trailing commas (what editors accept in launch.json).
function parseJsonc(text) {
  let out = '';
  for (let i = 0, str = false; i < text.length; i++) {
    const c = text[i];
    if (str) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const xmlAttr = (s, name) => {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '';
};
const xmlOption = (body, name) => {
  const m = body.match(new RegExp(`<option\\s+name="${name}"\\s+value="([^"]*)"`));
  return m ? xmlAttr(`v="${m[1]}"`, 'v') : '';
};

// PyCharm Python run configurations (.idea/runConfigurations/*.xml and the RunManager in .idea/workspace.xml).
function pycharmConfigs(root) {
  const out = [];
  const expand = (v) => v.replace(/\$PROJECT_DIR\$/g, root).replace(/\$USER_HOME\$/g, require('os').homedir()).replace(/\//g, '\\');
  const parse = (xml, source) => {
    for (const m of xml.matchAll(/<configuration\b([^>]*)>([\s\S]*?)<\/configuration>/g)) {
      const [, attrs, body] = m;
      if (xmlAttr(attrs, 'type') !== 'PythonConfigurationType' || xmlAttr(attrs, 'default') === 'true') continue;
      const name = xmlAttr(attrs, 'name');
      const moduleMode = xmlOption(body, 'MODULE_MODE') === 'true' || xmlOption(body, 'IS_MODULE_MODE') === 'true';
      const target = xmlOption(body, 'SCRIPT_NAME');
      if (!name || !target) continue;
      const env = {};
      for (const e of body.matchAll(/<env\s+([^>]*)\/>/g)) env[xmlAttr(e[1], 'name')] = xmlAttr(e[1], 'value');
      delete env.PYTHONUNBUFFERED;
      const script = moduleMode ? null : expand(target);
      out.push({
        kind: 'pycharm', name, source, temporary: xmlAttr(attrs, 'temporary') === 'true',
        module: moduleMode ? target : null, script,
        file: script || path.join(root, '.idea'),
        cwd: expand(xmlOption(body, 'WORKING_DIRECTORY')) || (script ? path.dirname(script) : root),
        defaultArgs: xmlOption(body, 'PARAMETERS'), env, python: true,
        port: findPort(xmlOption(body, 'PARAMETERS')) || (script ? findPort(readText(script)) : null),
      });
    }
  };
  const dir = path.join(root, '.idea', 'runConfigurations');
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.xml'))) {
      const xml = readText(path.join(dir, f));
      if (xml) parse(xml, `.idea\\runConfigurations\\${f}`);
    }
  } catch {}
  const ws = readText(path.join(root, '.idea', 'workspace.xml'), 4 * 1024 * 1024);
  const rm = ws?.match(/<component name="RunManager"[\s\S]*?<\/component>/);
  if (rm) parse(rm[0], '.idea\\workspace.xml');
  const seen = new Set();
  return out.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

function launchConfigs(root) {
  const file = path.join(root, '.claude', 'launch.json');
  const text = readText(file);
  if (!text) return [];
  let json;
  try { json = parseJsonc(text); } catch { return []; }
  return (json.configurations || []).filter((c) => c && c.name && c.runtimeExecutable).map((c) => {
    const cwd = c.cwd ? path.resolve(root, c.cwd) : root;
    const raw = String(c.runtimeExecutable);
    // A path (.venv\Scripts\python.exe) is used as written; a bare python/py means the project interpreter.
    const exe = /[\\/]/.test(raw) ? path.resolve(cwd, raw) : raw;
    return {
      kind: 'launch', name: String(c.name), file, source: '.claude\\launch.json',
      exe, runtimeArgs: [].concat(c.runtimeArgs || []).map(String),
      cwd, env: c.env && typeof c.env === 'object' ? c.env : {},
      port: validPort(Number(c.port)), url: typeof c.url === 'string' ? c.url : null,
      python: /^(python3?|py)(\.exe)?$/i.test(raw),
    };
  });
}

// The dotted module name and the folder `python -m` runs from: climb while the parent is a package.
function moduleOf(root, dir) {
  const parts = [path.basename(dir)];
  let p = path.dirname(dir);
  while (p.length > root.length && isFile(path.join(p, '__init__.py'))) { parts.unshift(path.basename(p)); p = path.dirname(p); }
  return { module: parts.join('.'), cwd: p };
}

function venvInfo(root, dir) {
  const cfg = readText(path.join(dir, 'pyvenv.cfg')) || '';
  const get = (k) => cfg.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, 'mi'))?.[1] || '';
  const python = path.join(dir, 'Scripts', 'python.exe');
  return { path: dir, rel: rel(root, dir), version: get('version') || get('version_info'), home: get('home'), python: isFile(python) ? python : null };
}

function scan(root) {
  const entries = [];
  const venvs = [];
  let visited = 0;
  const visit = (dir, depth) => {
    if (++visited > MAX_DIRS) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = ents.filter((e) => e.isFile()).map((e) => e.name);
    const isPkg = files.includes('__init__.py');
    const dirName = path.basename(dir);
    for (const f of files) {
      const abs = path.join(dir, f);
      const ext = path.extname(f).toLowerCase();
      if (['.bat', '.cmd', '.ps1'].includes(ext) && (depth === 0 || LAUNCH_NAME.test(f) || SCRIPT_DIRS.test(dirName))) {
        const text = readText(abs, 64 * 1024);
        entries.push({ kind: ext === '.ps1' ? 'ps1' : 'bat', name: f, file: abs, cwd: dir, port: findPort(text) });
      } else if (f === '__main__.py' && depth > 0) {
        const { module, cwd } = moduleOf(root, dir);
        const src = readText(abs) || '';
        entries.push({ kind: 'module', name: `python -m ${module}`, module, file: abs, cwd, python: true,
          flags: argparseFlags(src), port: findPort(src) });
      } else if (ext === '.py' && (depth === 0 || (depth === 1 && !isPkg && !/^tests?$/i.test(dirName)))
        && !/^(setup|conftest|__init__|__main__)\.py$|^test_|_test\.py$/i.test(f)) {
        const src = readText(abs);
        if (!src || !/^if\s+__name__\s*==\s*(['"])__main__\1\s*:/m.test(src)) continue;
        entries.push({ kind: 'script', name: f, file: abs, cwd: dir, python: true, flags: argparseFlags(src),
          argparse: /\bargparse\b/.test(src), port: findPort(src) });
      } else if (f === 'pom.xml' && depth <= 2) {
        const pom = readText(abs) || '';
        const goal = /jetty-maven-plugin|jetty-ee\d+-maven-plugin/.test(pom) ? 'jetty:run'
          : /spring-boot-maven-plugin/.test(pom) ? 'spring-boot:run'
            : /javafx-maven-plugin/.test(pom) ? 'javafx:run' : /exec-maven-plugin/.test(pom) ? 'exec:java' : 'package';
        entries.push({ kind: 'maven', name: `mvn ${goal}`, goal, file: abs, cwd: dir, port: findPort(pom) });
      } else if (/^build\.gradle(\.kts)?$/.test(f) && depth <= 2) {
        const g = readText(abs) || '';
        const task = /org\.springframework\.boot/.test(g) ? 'bootRun' : /\bapplication\b|org\.openjfx/.test(g) ? 'run' : 'build';
        const wrapper = isFile(path.join(dir, 'gradlew.bat'));
        entries.push({ kind: 'gradle', name: `${wrapper ? 'gradlew' : 'gradle'} ${task}`, task, wrapper, file: abs, cwd: dir, port: findPort(g) });
      }
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      if (depth + 1 <= 2 && isFile(path.join(sub, 'pyvenv.cfg'))) { venvs.push(venvInfo(root, sub)); continue; }
      if (depth + 1 <= MAX_DEPTH && !skipDir(e.name)) visit(sub, depth + 1);
    }
  };
  visit(root, 0);
  const all = [...launchConfigs(root), ...pycharmConfigs(root), ...entries];
  for (const e of all) {
    e.rel = rel(root, e.file);
    e.cwdRel = rel(root, e.cwd);
    e.id = `${e.kind}:${e.rel}:${e.kind === 'launch' || e.kind === 'pycharm' ? e.name : ''}`.toLowerCase();
  }
  return { entries: all, venvs };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000, encoding: 'buffer', ...opts }, (err, stdout) =>
      resolve(err ? null : stdout.toString(opts.decode || 'utf8')));
  });
}

async function gitBranch(root) {
  const b = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }))?.trim();
  if (b && b !== 'HEAD') return b;
  // A repository without commits fails rev-parse but still has a symbolic HEAD; a detached HEAD has none.
  const sym = (await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root }))?.trim();
  return sym || b || null;
}

function readme(root) {
  let name;
  try { name = fs.readdirSync(root).find((f) => /^readme\.(md|rst|txt)$/i.test(f)); } catch {}
  if (!name) return null;
  const text = readText(path.join(root, name), 64 * 1024) || '';
  const lines = text.split(/\r?\n/);
  const strip = (s) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/<[^>]+>/g, '').trim();
  const hi = lines.findIndex((l) => /^#{1,2}\s+\S/.test(l));
  const title = hi >= 0 ? strip(lines[hi].replace(/^#+\s*/, '')) : '';
  const summary = [];
  for (const l of lines.slice(hi + 1)) {
    const s = l.trim();
    if (!s) { if (summary.length) break; continue; }
    if (/^(#|```|\||[-*]{3}|>|<)/.test(s)) { if (summary.length) break; continue; }
    summary.push(strip(s));
    if (summary.join(' ').length > 280) break;
  }
  return { file: path.join(root, name), name, title, summary: summary.join(' ').slice(0, 300) };
}

// ---------- ports ----------
const canListen = (port, host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
});
const canConnect = (port) => new Promise((resolve) => {
  const sock = net.connect({ port, host: '127.0.0.1' });
  const done = (ok) => { sock.destroy(); resolve(ok); };
  sock.setTimeout(500, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});
const portInUse = async (port) => !(await canListen(port, '127.0.0.1')) || canConnect(port);

// netstat's state column is localized ("LISTENING", "수신 대기"), so a listener is recognized by its idle foreign address.
async function portOwner(port) {
  const out = await run('netstat', ['-ano'], { decode: 'latin1' });
  if (!out) return null;
  let pid = null;
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (!/^TCP$/i.test(p[0]) || p.length < 5) continue;
    if (Number(p[1].slice(p[1].lastIndexOf(':') + 1)) !== port) continue;
    const owner = Number(p[p.length - 1]);
    if (!owner) continue;
    if (/^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(p[2])) { pid = owner; break; }
    pid ??= owner;
  }
  if (!pid) return null;
  const list = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { decode: 'latin1' });
  const name = list?.match(/^"([^"]+)","(\d+)"/m);
  return { pid, name: name && Number(name[2]) === pid ? name[1] : null };
}

// The port a launcher will use: --port in its arguments, a port in the --config .toml it is given, or the one
// discovered in its configuration or source.
function resolvePort(root, entry, args) {
  const a = args || '';
  const m = a.match(/--port[= ]+(\d{2,5})\b/) || a.match(/(?:^|\s)-p\s+(\d{2,5})\b/);
  if (m && validPort(Number(m[1]))) return Number(m[1]);
  const cfg = a.match(/--config[= ]+("[^"]+"|\S+)/);
  if (cfg) {
    const f = cfg[1].replace(/"/g, '');
    for (const base of [entry.cwd, root]) {
      const n = findPort(readText(path.resolve(base || root, f)));
      if (n) return n;
    }
  }
  return validPort(Number(entry.port)) || null;
}

const withPath = (env = {}, roots = []) => {
  const parts = [...roots, env.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean);
  return parts.length ? { ...env, PYTHONPATH: parts.join(';') } : env;
};

// A .bat that is plain UTF-8 runs under code page 65001 so its echo output reaches the console intact.
const isUtf8 = (file) => {
  try { new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); return true; } catch { return false; }
};

exports.register = ({ ipcMain, app, startProcess }) => {
  const fakeOpen = process.env.PYIDE_FAKE_OPEN_EXTERNAL === '1';
  const opened = [];
  // Windows PowerShell writes to a pipe in the OEM code page; this wrapper switches it to UTF-8 and forwards
  // every argument (named ones included) to the real script.
  const psWrapper = path.join(app.getPath('userData'), 'workspace', 'run-ps1.ps1');
  const ensureWrapper = () => {
    if (isFile(psWrapper)) return;
    fs.mkdirSync(path.dirname(psWrapper), { recursive: true });
    fs.writeFileSync(psWrapper, '﻿param([string]$__script)\r\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\r\n$OutputEncoding = [Text.Encoding]::UTF8\r\n& $__script @args\r\nexit $LASTEXITCODE\r\n');
  };

  ipcMain.handle('workspace:scan', (_e, root) => scan(root));
  ipcMain.handle('workspace:info', async (_e, root) => ({ branch: await gitBranch(root), readme: readme(root) }));

  ipcMain.handle('workspace:checkPort', async (_e, root, entry, args) => {
    const port = resolvePort(root, entry, args);
    if (!port) return { port: null, inUse: false };
    if (!(await portInUse(port))) return { port, inUse: false };
    return { port, inUse: true, ...(await portOwner(port)) };
  });
  ipcMain.handle('workspace:portInUse', (_e, port) => portInUse(port));
  ipcMain.handle('workspace:killPid', async (_e, pid) => {
    pid = Number(pid);
    if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) throw new Error(`refusing to stop process ${pid}`);
    const out = await new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true },
      (err, stdout, stderr) => resolve(err ? { ok: false, error: (stderr || err.message).toString().trim() } : { ok: true })));
    return out;
  });

  // Only local servers: a link printed by a process must not open arbitrary sites.
  ipcMain.handle('workspace:openUrl', async (_e, url) => {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error(`not a local URL: ${url}`);
    opened.push(u.href);
    if (!fakeOpen) await shell.openExternal(u.href);
    return u.href;
  });
  ipcMain.handle('workspace:openedUrls', () => opened);

  // entry: an item from workspace:scan; args: the user's extra arguments; interp: {cmd, args} for Python kinds.
  ipcMain.handle('workspace:start', (_e, root, entry, args, interp) => {
    const extra = parseArgs(args);
    let cmd;
    let argv;
    let env = entry.env || {};
    const opts = {};
    const py = (rest) => {
      if (!interp?.cmd) throw new Error('no-interpreter');
      cmd = interp.cmd;
      argv = [...(interp.args || []), '-u', ...rest];
      env = withPath(env, [root]);
    };
    switch (entry.kind) {
      case 'launch':
        if (entry.python && interp?.cmd) py([...entry.runtimeArgs, ...extra]);
        else if (path.isAbsolute(entry.exe) && /\.exe$/i.test(entry.exe)) { cmd = entry.exe; argv = [...entry.runtimeArgs, ...extra]; } else {
          // npm, mvn and friends are .cmd shims that only cmd.exe resolves.
          cmd = 'cmd.exe';
          argv = ['/d', '/s', '/c', `"${[entry.exe, ...entry.runtimeArgs, ...extra].map(quote).join(' ')}"`];
          opts.windowsVerbatimArguments = true;
        }
        break;
      case 'script': py([entry.file, ...extra]); break;
      case 'module': py(['-m', entry.module, ...extra]); break;
      case 'pycharm': py(entry.module ? ['-m', entry.module, ...extra] : [entry.script, ...extra]); break;
      case 'bat':
        cmd = 'cmd.exe';
        argv = ['/d', '/s', '/c', `"${isUtf8(entry.file) ? 'chcp 65001>nul & ' : ''}call ${quote(entry.file)}${args?.trim() ? ` ${args.trim()}` : ''}"`];
        opts.windowsVerbatimArguments = true;
        // A non-UTF-8 batch file runs in the console code page, which is CP949 on Korean Windows.
        if (!isUtf8(entry.file)) opts.encoding = 'cp949';
        break;
      case 'ps1':
        ensureWrapper();
        cmd = 'powershell.exe';
        argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psWrapper, entry.file, ...extra];
        break;
      case 'maven':
      case 'gradle': {
        const tool = entry.kind === 'maven' ? `mvn ${entry.goal}` : `${entry.wrapper ? 'gradlew.bat' : 'gradle'} ${entry.task}`;
        cmd = 'cmd.exe';
        argv = ['/d', '/s', '/c', `"${tool}${args?.trim() ? ` ${args.trim()}` : ''}"`];
        opts.windowsVerbatimArguments = true;
        // Java writes piped output in the native code page (CP949 on Korean Windows).
        opts.encoding = 'cp949';
        break;
      }
      default: throw new Error(`unknown launcher kind ${entry.kind}`);
    }
    const shown = entry.kind === 'ps1'
      ? ['powershell', '-ExecutionPolicy', 'Bypass', '-File', entry.file, ...extra].map(quote).join(' ')
      : opts.windowsVerbatimArguments ? `cmd /c ${argv[3].slice(1, -1).replace(/^chcp 65001>nul & /, '').replace(/^call /, '')}` : [cmd, ...argv].map(quote).join(' ');
    const id = startProcess(cmd, argv, { cwd: entry.cwd || root, env, windowsHide: true, ...opts });
    return { id, command: shown };
  });
};
