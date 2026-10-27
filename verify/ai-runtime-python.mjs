// main/ai/runtime.js choosing the interpreter and the torch for the shared AI environment, with real interpreters and
// pip against a local package index, so pip itself decides which interpreter has a build and which torchvision fits.
// Before the fix, semantic search setup failed on every try with pip's "No matching distribution found for torch" in an
// environment made from a Python torch has no build for (3.15 before torch caught up, 32-bit, free-threaded); reused a
// system torch older than the 2.6 transformers needs, so the model could not load; and on Python 3.14.1, which every
// torchvision since 0.26 excludes, failed on the pinned torchvision. Needs two Python versions without torch for the
// rebuild checks; with fewer they are skipped.
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'verify', 'out');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-ai-runtime-'));

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const skip = (label) => console.log(`SKIP ${label}`);

const tagOf = (py) => execFileSync(py, ['-c', 'import sys;print(f"cp{sys.version_info[0]}{sys.version_info[1]}")'], { encoding: 'utf8' }).trim();
const hasTorch = (py) => { try { execFileSync(py, ['-c', 'import torch'], { stdio: 'ignore' }); return true; } catch { return false; } };
// Interpreters without torch, one per version: torch already present would be reused and decide the choice.
const bases = [];
for (const line of execFileSync('py', ['-0p'], { encoding: 'utf8' }).split(/\r?\n/)) {
  const exe = line.match(/[A-Za-z]:\\.*\.exe/i)?.[0];
  if (exe && !hasTorch(exe) && !bases.some((b) => tagOf(b) === tagOf(exe))) bases.push(exe);
}
if (!bases.length) { console.log('no Python without torch found'); process.exit(1); }
// Venvs keep the system interpreters' own site-packages out and give each a pip.
const venvOf = (name, base) => {
  const dir = path.join(out, `ai-runtime-${name}-venv`);
  if (!fs.existsSync(path.join(dir, 'Scripts', 'python.exe'))) execFileSync(base, ['-m', 'venv', dir], { stdio: 'ignore' });
  return path.join(dir, 'Scripts', 'python.exe');
};
const [A, B] = bases.slice(0, 2).map((base) => venvOf(tagOf(base), base));
const [tagA, tagB] = [A, B].map((py) => py && tagOf(py));
// An interpreter whose torch is a stand-in package of a chosen version.
const C = venvOf('stand-in-torch', bases[0]);
const standInTorch = (version) => {
  const pkg = path.join(path.dirname(path.dirname(C)), 'Lib', 'site-packages', 'torch');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, '__init__.py'), `__version__ = '${version}'\n`);
};

// Tiny real wheels for the torchvision checks: pip installs and resolves them like the real ones.
const wheels = path.join(home, 'wheels');
fs.mkdirSync(wheels);
const MAKE_WHEEL = `import os, sys, zipfile
out, name, ver, req = sys.argv[1:5]
info = f"{name}-{ver}.dist-info"
files = {f"{name}/__init__.py": f"__version__ = '{ver}'\\n",
         f"{info}/METADATA": f"Metadata-Version: 2.1\\nName: {name}\\nVersion: {ver}\\n" + (f"Requires-Dist: {req}\\n" if req else ""),
         f"{info}/WHEEL": "Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}
files[f"{info}/RECORD"] = "".join(f"{p},,\\n" for p in files) + f"{info}/RECORD,,\\n"
with zipfile.ZipFile(os.path.join(out, f"{name}-{ver}-py3-none-any.whl"), "w") as z:
    for p, c in files.items():
        z.writestr(p, c)
`;
const wheel = (name, version, requires = '') => {
  execFileSync(A, ['-c', MAKE_WHEEL, wheels, name, version, requires]);
  return `${name}-${version}-py3-none-any.whl`;
};

// Package name -> file names the index lists. Names under /f/ that exist in `wheels` are served.
let listing = {};
const offer = (tags) => { listing = { torch: tags.map((t) => `torch-2.14.1-${t}-${t}-win_amd64.whl`) }; };
let sidecar = null;
const server = http.createServer((req, res) => {
  const file = /^\/f\/([^/]+)$/.exec(req.url)?.[1];
  if (file && fs.existsSync(path.join(wheels, file))) { res.writeHead(200); res.end(fs.readFileSync(path.join(wheels, file))); return; }
  const name = /^\/simple\/([^/]+)\/?$/.exec(req.url)?.[1];
  const files = name === 'pip' ? ['pip-25.3-py3-none-any.whl'] : listing[name];
  if (!files) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><body>${files.map((f) => `<a href="/f/${f}">${f}</a>`).join('')}</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The runtime reads the home folder and PATH when it runs; PATH holds only A's venv, so `python` is A and `py` is gone.
Object.assign(process.env, {
  USERPROFILE: home, HOME: home, PIP_CONFIG_FILE: os.devnull, PIP_NO_CACHE_DIR: '1', PIP_INDEX_URL: `${base}/simple`,
  PYIDE_TORCH_INDEX: `${base}/whl`, PATH: [path.dirname(A), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter),
});
const runtime = createRequire(import.meta.url)(path.join(root, 'main', 'ai', 'runtime.js'));
const job = () => { const j = runtime.createJob((t) => { j.text += t; }); j.text = ''; return j; };
const cfg = () => fs.readFileSync(path.join(runtime.venv, 'pyvenv.cfg'), 'utf8');
const envVersion = () => cfg().match(/^version\s*=\s*(\d+)\.(\d+)/m).slice(1).join('');
const reusesSystem = () => /^include-system-site-packages\s*=\s*true/im.test(cfg());
const attempt = async (preferred, opts) => { const j = job(); try { await runtime.ensureVenv(j, preferred, opts); return { log: j.text }; } catch (e) { return { log: j.text, error: e.message }; } };
const fresh = async () => { await sidecar?.kill(); fs.rmSync(runtime.venv, { recursive: true, force: true }); };
const distInfo = (name) => fs.readdirSync(runtime.sitePackages).map((n) => new RegExp(`^${name}-(.+)\\.dist-info$`).exec(n)?.[1]).find(Boolean);

try {
  offer([]);
  let r = await attempt(A);
  check(!r.error && `cp${envVersion()}` === tagA, `without a torch need, any interpreter makes the environment (${tagA}): ${r.error || 'ok'}`);

  r = await attempt(A, { torch: true });
  check(/^PyTorch has no build for Python \d/.test(r.error || ''), `torch has no build for any interpreter: setup stops with a clear error (${r.error})`);
  check(fs.existsSync(runtime.python), 'the environment is left as it was');

  offer([tagA]);
  r = await attempt(A, { torch: true });
  check(!r.error && !/recreating/.test(r.log), 'an environment torch has a build for is kept');

  // The pip index check reaches nothing: that proves nothing about torch, so the environment stays.
  process.env.PIP_INDEX_URL = 'http://127.0.0.1:9/simple';
  r = await attempt(A, { torch: true });
  check(!r.error && !/recreating/.test(r.log), `an unreachable index does not count as "no build": ${r.error || 'kept'}`);
  process.env.PIP_INDEX_URL = `${base}/simple`;

  standInTorch('2.4.1');
  await fresh();
  r = await attempt(C, { torch: true });
  check(!r.error && !reusesSystem(), `an interpreter with torch 2.4 (below transformers' 2.6) is not reused for its torch: ${r.error || 'ok'}`);
  standInTorch('2.7.0');
  await fresh();
  r = await attempt(C, { torch: true });
  check(!r.error && reusesSystem(), `an interpreter with torch 2.7 is reused: ${r.error || 'ok'}`);

  const own = path.join(runtime.sitePackages, 'torch-2.4.1.dist-info');
  check(!runtime.torchTooOld(), 'with no torch found, the environment is not called too old');
  fs.mkdirSync(own);
  check(runtime.torchTooOld(), 'an environment whose torch is 2.4.1 shows as too old, so semantic search offers setup again');
  fs.renameSync(own, path.join(runtime.sitePackages, 'torch-2.8.0+cpu.dist-info'));
  check(!runtime.torchTooOld(), 'torch 2.8.0+cpu is new enough');

  // Python 3.14.1 in miniature: torch 2.13 is installed, its paired torchvision 0.28.0 has no build, and the newest
  // torchvision that has one (0.25.0) needs torch 2.10.0.
  await fresh();
  offer([]);
  listing = { torch: [wheel('torch', '2.13.0'), wheel('torch', '2.10.0')], torchvision: [wheel('torchvision', '0.25.0', 'torch==2.10.0')] };
  r = await attempt(A);
  const j = job();
  let error = null;
  try { await runtime.pipInstall(j, ['torch==2.13.0']); j.text = ''; await runtime.installTorchvision(j); } catch (e) { error = e.message; }
  check(!error && distInfo('torchvision') === '0.25.0' && distInfo('torch') === '2.10.0',
    `with no paired torchvision, pip installs a matching pair (torch ${distInfo('torch')}, torchvision ${distInfo('torchvision')}): ${error || 'ok'}`);
  check(/paired with this torch is not available/.test(j.text), 'the setup log says why torch changed');

  if (B) {
    await fresh();
    offer([]);
    r = await attempt(A);
    offer([tagB]);
    // A running server holds python.exe open; Windows could not delete the environment under it.
    const script = path.join(home, 'wait.py');
    fs.writeFileSync(script, 'import sys\nsys.stdin.read()\n');
    let exited = false;
    sidecar = runtime.startSidecar({ script, onExit: () => { exited = true; } });
    r = await attempt(B, { torch: true });
    check(!r.error && `cp${envVersion()}` === tagB, `an environment torch has no build for is recreated from one it has (${tagA} -> ${tagB}): ${r.error || 'ok'}`);
    check(/has no PyTorch build; recreating the AI environment with Python \d/.test(r.log), `the setup log says why: ${r.log.trim().split('\n')[0]}`);
    check(exited, 'the running AI server was stopped first');

    r = await attempt(A, { torch: true });
    check(!r.error && `cp${envVersion()}` === tagB && !/recreating/.test(r.log), 'the next setup keeps the recreated environment');

    // B is reachable only through the IDE's interpreter list, as PyIDE's own Python is.
    await fresh();
    r = await attempt(A, { torch: true, interpreters: [B] });
    check(!r.error && `cp${envVersion()}` === tagB, `a new environment skips the project interpreter torch has no build for (${tagA}) for one the IDE lists (${tagB}): ${r.error || 'ok'}`);
  } else skip('one Python version without torch is installed; the rebuild checks need two');
} finally {
  server.close();
  await sidecar?.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
