// The one private Python runtime behind PyIDE's local AI features (semantic search, code completion), and the
// JSON-lines sidecar protocol they talk to their Python servers with.
// The venv is shared by every PyIDE profile (like the Hugging Face model cache) and keeps the folder name of its
// first user, semantic search, so existing installs keep working. It lives under the home folder: packaged launchers
// virtualize %LOCALAPPDATA%, which would hide it from other launches.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diagnostics = require('../diagnostics');

const dir = path.join(os.homedir(), '.pyide', 'semantic');
const venv = path.join(dir, 'venv');
const python = path.join(venv, 'Scripts', 'python.exe');
const sitePackages = path.join(venv, 'Lib', 'site-packages');
const PIP = ['-m', 'pip', 'install', '--disable-pip-version-check'];

// A file check, not an import: importing torch takes seconds and callers run on the main process.
const hasPackage = (name) => fs.existsSync(path.join(sitePackages, name));
const pythonReady = () => fs.existsSync(python);

function hfCacheDir() {
  const home = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
  return process.env.HF_HUB_CACHE || path.join(home, 'hub');
}
const hfRepoDir = (repo) => path.join(hfCacheDir(), `models--${repo.replace(/\//g, '--')}`);
// Path of `file` in any downloaded snapshot of `repo`, or null.
function hfCachedFile(repo, file) {
  const snaps = path.join(hfRepoDir(repo), 'snapshots');
  try {
    for (const s of fs.readdirSync(snaps)) {
      const p = path.join(snaps, s, file);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// A setup job: runs commands one at a time, streams their output to `log`, and can be cancelled.
function createJob(log) {
  let proc = null;
  let cancelled = false;
  const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    if (cancelled) { reject(new Error('Cancelled')); return; }
    log(`> ${[cmd, ...args].join(' ')}\n`);
    proc = spawn(cmd, args, { windowsHide: true, ...opts, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', ...opts.env } });
    proc.stdout.on('data', (d) => log(d.toString('utf8')));
    proc.stderr.on('data', (d) => log(d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      proc = null;
      if (cancelled) reject(new Error('Cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
  const cancel = () => {
    cancelled = true;
    if (proc) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  };
  return { run, cancel, log };
}

// Setups from different features share one venv, so pip runs are serialized.
let queue = Promise.resolve();
function exclusive(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function findTorchPython(preferred) {
  const candidates = [...(preferred ? [[preferred, []]] : []), ['py', ['-3']], ['python', []]];
  for (const [cmd, args] of candidates) {
    try {
      execFileSync(cmd, [...args, '-c', 'import torch'], { timeout: 60000, windowsHide: true });
      return { cmd, args, torch: true };
    } catch {}
  }
  for (const [cmd, args] of candidates) {
    try { execFileSync(cmd, [...args, '--version'], { timeout: 15000, windowsHide: true }); return { cmd, args, torch: false }; } catch {}
  }
  return null;
}

const canImport = (module) => {
  try { execFileSync(python, ['-c', `import ${module}`], { timeout: 60000, windowsHide: true }); return true; } catch { return false; }
};

async function ensureVenv(job, interpreter) {
  fs.mkdirSync(dir, { recursive: true });
  if (pythonReady()) return;
  const py = findTorchPython(interpreter);
  if (!py) throw new Error('No Python interpreter found');
  // Reusing an installed torch avoids a second multi-hundred-MB download.
  await job.run(py.cmd, [...py.args, '-m', 'venv', ...(py.torch ? ['--system-site-packages'] : []), venv]);
}

const pipInstall = (job, args) => job.run(python, [...PIP, ...args]);

// torchvision must be the build paired with the installed torch (2.X.Y pairs with 0.(X+15).Y) from PyTorch's index
// for the same variant (cpu, cu128, ...); --no-deps stops pip from replacing the reused torch.
async function installTorchvision(job) {
  const torchVersion = execFileSync(python, ['-c', 'import torch; print(torch.__version__)'], { timeout: 60000, windowsHide: true, encoding: 'utf8' }).trim();
  const [, minor, patch, variant] = torchVersion.match(/^2\.(\d+)\.(\d+)(?:\+(\w+))?/) || [];
  if (minor) {
    await pipInstall(job, ['--no-deps', 'pillow', `torchvision==0.${+minor + 15}.${patch}${variant ? `+${variant}` : ''}`,
      '--extra-index-url', `https://download.pytorch.org/whl/${variant || 'cpu'}`]);
  } else await pipInstall(job, ['torchvision']);
}

// Downloads a Hugging Face repo (or only `files` of it) into the standard cache.
function hfDownload(job, repo, files) {
  const code = files
    ? `from huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(files)}: hf_hub_download(${JSON.stringify(repo)}, f)`
    : `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(repo)})`;
  return job.run(python, ['-c', code]);
}

// A long-lived Python server that reads one JSON request per line on stdin and answers with JSON lines on stdout.
// Replies carry the request's id; lines without an id are events. stderr is passed through as log text.
function startSidecar({ script, env, onEvent = () => {}, onLog = () => {}, onExit = () => {} }) {
  const proc = spawn(python, ['-u', script], {
    cwd: dir,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', ...env },
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let alive = true;
  let exited;
  const closed = new Promise((resolve) => { exited = resolve; });
  proc.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else if (msg.event) onEvent(msg);
    }
  });
  proc.stderr.on('data', (d) => onLog(d.toString('utf8')));
  diagnostics.watchProcess(proc, { name: path.basename(script) });
  // A write racing the process's exit fails with EPIPE; the exit handler already answers pending requests.
  proc.stdin.on('error', () => {});
  proc.on('error', (err) => onLog(`${err.message}\n`));
  proc.on('exit', (code) => {
    alive = false;
    for (const resolve of pending.values()) resolve({ error: `server exited (${code})` });
    pending.clear();
    onExit(code);
    exited(code);
  });
  const write = (msg) => { if (alive) proc.stdin.write(`${JSON.stringify(msg)}\n`); };
  return {
    // -> {id, reply: Promise<message>}
    send(msg) {
      const id = nextId++;
      const reply = new Promise((resolve) => {
        if (!alive) { resolve({ error: 'server is not running' }); return; }
        pending.set(id, resolve);
        write({ ...msg, id });
      });
      return { id, reply };
    },
    notify: write,
    alive: () => alive,
    // Resolves once the process has exited and released its files.
    kill() { try { proc.kill(); } catch {} return closed; },
  };
}

module.exports = {
  dir, venv, python, sitePackages, hasPackage, pythonReady, canImport, hfCacheDir, hfRepoDir, hfCachedFile,
  createJob, exclusive, ensureVenv, pipInstall, installTorchvision, hfDownload, startSidecar,
};
