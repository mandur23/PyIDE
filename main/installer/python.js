// PyIDE's own Python: the official python.org build from nuget.org, a zip whose tools/ folder is a complete CPython
// (pip and venv included, tkinter not), extracted under <root>/python/<version>. Per user, no installer and no
// administrator rights; the IDE lists it like any interpreter through the interpreters.extra setting.
const fs = require('fs');
const path = require('path');
const { download } = require('./servers');

const tarExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

// nuget.org publishes the package's SHA512 only inside its signed catalog; this is the sha256 of the file it served
// when this version was pinned. PYIDE_PYTHON_FEED replaces the package URL in tests (a local file server).
const PYTHONS = {
  '3.13': {
    version: '3.13.17',
    url: 'https://api.nuget.org/v3-flatcontainer/python/3.13.17/python.3.13.17.nupkg',
    size: 14826465,
    sha256: 'dce409744b088f94c6e37ba41f8100c384c27e029e843237364c602d30d475e5',
  },
};

function createPythons({ root, run }) {
  const dirOf = (key) => path.join(root, 'python', PYTHONS[key].version);
  const exeOf = (key) => path.join(dirOf(key), 'python.exe');
  const urlOf = (key) => (process.env.PYIDE_PYTHON_FEED ? `${process.env.PYIDE_PYTHON_FEED.replace(/\/$/, '')}/${path.basename(new URL(PYTHONS[key].url).pathname)}` : PYTHONS[key].url);

  async function status(key) {
    const p = PYTHONS[key];
    const exe = exeOf(key);
    let installed = fs.existsSync(exe);
    let version = p.version;
    if (installed) {
      const r = await run(exe, ['-I', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])']);
      installed = r.code === 0;
      if (installed) version = r.stdout.trim() || version;
    }
    return { key, version, size: p.size, dir: dirOf(key), exe, installed };
  }

  async function install(key, { log, progress, signal, exec }) {
    const p = PYTHONS[key];
    const dir = dirOf(key);
    const base = path.join(root, 'python');
    fs.mkdirSync(base, { recursive: true });
    for (const old of fs.readdirSync(base)) if (old.startsWith(`${p.version}.remove-`)) fs.rmSync(path.join(base, old), { recursive: true, force: true });
    const pkg = path.join(base, path.basename(new URL(p.url).pathname));
    if (!fs.existsSync(pkg)) await download(urlOf(key), pkg, { sha256: p.sha256, size: p.size, signal, log, progress: (f) => progress(f * 0.8) });
    progress(0.8);
    const staging = `${dir}.extract`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    log(`Extracting to ${dir}\n`);
    await exec(tarExe(), ['-xf', pkg, '-C', staging, 'tools']);
    if (!fs.existsSync(path.join(staging, 'tools', 'python.exe'))) throw new Error('The package has no tools/python.exe.');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(path.join(staging, 'tools'), dir);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(pkg, { force: true });
    progress(0.95);
    // The interpreter, pip and venv must work before the IDE offers it.
    await exec(exeOf(key), ['-I', '-c', 'import sys, venv, ensurepip, pip; print(sys.version)']);
    progress(1);
  }

  // The binaries a running interpreter has loaded (python.exe, python3*.dll, the .pyd and .dll extension modules, also
  // for a venv made from it) cannot be opened for writing. Windows lets the folder be renamed and other files deleted
  // all the same, so removing it while a program runs would leave a broken interpreter.
  function inUse(dir) {
    const binaries = (d) => { try { return fs.readdirSync(d).filter((f) => /\.(exe|dll|pyd)$/i.test(f)).map((f) => path.join(d, f)); } catch { return []; } };
    for (const f of [...binaries(dir), ...binaries(path.join(dir, 'DLLs'))]) {
      try { fs.closeSync(fs.openSync(f, 'r+')); } catch (err) { if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return f; }
    }
    return null;
  }

  // A program that only ran a moment (a pip list) gets a few seconds to finish. Once nothing runs from it, the folder is
  // renamed aside and deleted; a file another program (a virus scan) still holds is retried, and a folder that stays
  // is removed by the next install.
  async function uninstall(key, { log }) {
    const dir = dirOf(key);
    if (!fs.existsSync(dir)) return;
    log(`Removing ${dir}\n`);
    for (let i = 0; inUse(dir); i++) {
      if (i >= 10) throw new Error(`PyIDE Python ${PYTHONS[key].version} is in use by a running program (a run, the Python Console, a debugger or a terminal). Stop it and try again.`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const aside = `${dir}.remove-${process.pid}-${Date.now()}`;
    fs.renameSync(dir, aside);
    try {
      fs.rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      log(`Some files stay in ${aside} (${err.code || err.message}); the next install removes them.\n`);
    }
  }

  return { names: () => Object.keys(PYTHONS), status, install, uninstall, exeOf };
}

module.exports = { createPythons, PYTHONS };
