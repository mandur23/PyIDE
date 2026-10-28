// Build Executable with the real PyInstaller (opt-in, not in CI: it downloads PyInstaller from PyPI once into
// verify/out/exe-builder-real-venv). A PyInstaller configuration builds one file and one folder from a script that
// reads a bundled data file, and both programs print what the script prints. Port 9799.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const venv = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'exe-builder-real-venv');
const python = path.join(venv, 'Scripts', 'python.exe');
if (!existsSync(python)) execFileSync('py', ['-3', '-m', 'venv', venv]);
execFileSync(python, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'pyinstaller']);
const project = mkdtempSync(path.join(tmpdir(), 'pyide-exe-live-'));
mkdirSync(path.join(project, 'assets'));
writeFileSync(path.join(project, 'assets', 'greeting.txt'), 'hello from the bundled file');
writeFileSync(path.join(project, 'hello.py'), 'import os, sys\nbase = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))\n'
  + 'print(open(os.path.join(base, "assets", "greeting.txt")).read())\n');

const t = await launch({ name: 'exe-builder-live', port: 9799, projectDir: project });
const { js, until, check } = t;
try {
  for (const mode of ['onefile', 'onedir']) {
    const exe = path.join(project, 'dist', ...(mode === 'onedir' ? ['hello', 'hello.exe'] : ['hello.exe']));
    await js(`(() => { const c = ide.run.addTemporary({ type: 'pyinstaller', name: 'Build hello', script: 'hello.py' });
      Object.assign(c, { mode: ${S(mode)}, data: 'assets', interp: ${S(python)} }); ide.run.runConfig(c); return true; })()`);
    await until(`ide.api.exists(${S(exe)}) && ide.run.sessions().some((s) => s.cfg.type === 'pyinstaller' && !s.running && !s.starting)`, `${mode} build`, 300000);
    await until(`document.querySelector('.run-session:not(.hidden)')?.textContent.includes('Executable built')`, `${mode} built`, 20000);
    const out = execFileSync(exe, { encoding: 'utf8' }).trim();
    check(out === 'hello from the bundled file', `the ${mode} program runs and reads its bundled file (${S(out)})`);
  }
} catch (err) {
  check(false, err.message);
}
t.finish();
