// Java and C/C++ toolchains: built-in ones from pinned vendor archives, extracted with Windows tar.exe under
// <root>/<kind>/<folder>-<version> for the user's account (no administrator rights), and the ones already on this
// computer (JAVA_HOME, PATH, the usual install folders), which New Project and the Java and C/C++ run configurations
// choose from. A toolchain is {kind: 'jdk' | 'cpp', id, home, bin, version, vendor, builtin, cc?, cxx?}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { download, tarExe } = require('./servers');

const TOOLCHAINS = {
  jdk: {
    kind: 'jdk',
    title: 'Eclipse Temurin JDK',
    version: '25.0.4.1',
    url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jdk_x64_windows_hotspot_25.0.4.1_1.zip',
    size: 141167264,
    // Published by Adoptium (api.adoptium.net and <url>.sha256.txt).
    sha256: '00c847d804f4a78e9f04f2683faf14fed898535b177b7fc704486cb0284e9283',
    folder: 'temurin',
    top: 'jdk-25.0.4.1+1',
    probe: 'bin/javac.exe',
  },
  cpp: {
    kind: 'cpp',
    title: 'w64devkit',
    version: '2.10.1',
    // A 7-Zip self-extracting archive; tar.exe (libarchive) reads it without running it. GCC 16, GDB, make.
    url: 'https://github.com/skeeto/w64devkit/releases/download/v2.10.1/w64devkit-x64-2.10.1.7z.exe',
    size: 67263552,
    // The digest GitHub lists for the release asset.
    sha256: 'add1edf984ce4d473cfeb7c52e0ab38db73a855bba6c7f564d5e16648eb2896a',
    folder: 'w64devkit',
    top: 'w64devkit',
    probe: 'bin/gcc.exe',
  },
  // Code insight for Java (main/features/java-lsp.js runs it on a JDK 21 or later). The archive has no top folder.
  jdtls: {
    kind: 'jdtls',
    title: 'Eclipse JDT Language Server',
    version: '1.63.0',
    url: 'https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz',
    size: 51143565,
    // Published by Eclipse next to the archive (<url>.sha256).
    sha256: 'b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4',
    folder: 'jdtls',
    top: '',
    probe: 'config_win/config.ini',
  },
};

const installRoot = () => process.env.PYIDE_INSTALL_ROOT || path.join(os.homedir(), '.pyide');

// Tests point the downloads at a local server and leave this computer's toolchains out: PYIDE_TOOLCHAINS names a JSON
// file {jdk?: {url, size, sha256, version, top}, cpp?: {...}, system?: false}.
function overrides() {
  const file = process.env.PYIDE_TOOLCHAINS;
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch { return []; } };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
const pathDirs = (env) => String(env.PATH || env.Path || '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);

// The release file every JDK since 9 (and most 8 builds) has at its root.
function jdkInfo(home) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'release'), 'utf8'); } catch {}
  const field = (name) => new RegExp(`^${name}="([^"]*)"`, 'm').exec(text)?.[1];
  return { version: field('JAVA_VERSION') || null, vendor: field('IMPLEMENTOR') || null };
}

function systemJdkHomes(env) {
  const homes = [];
  if (env.JAVA_HOME) homes.push(env.JAVA_HOME);
  // Oracle's installer puts links (Common Files\Oracle\Java\javapath) on PATH; the JDK is where they point.
  for (const dir of pathDirs(env)) if (isFile(path.join(dir, 'javac.exe'))) homes.push(path.dirname(path.dirname(real(path.join(dir, 'javac.exe')))));
  const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  const vendors = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'OpenJDK'];
  for (const pf of programFiles) for (const v of vendors) homes.push(...subdirs(path.join(pf, v)));
  // IntelliJ IDEA's Download JDK puts them here.
  homes.push(...subdirs(path.join(os.homedir(), '.jdks')));
  return homes;
}

function systemCppBins(env) {
  const drive = env.SystemDrive || 'C:';
  return [
    ...pathDirs(env),
    ...['ucrt64', 'mingw64', 'clang64'].map((m) => path.join(drive, '\\msys64', m, 'bin')),
    path.join(drive, '\\w64devkit', 'bin'),
    path.join(os.homedir(), 'w64devkit', 'bin'),
    path.join(drive, '\\mingw64', 'bin'),
    path.join(drive, '\\MinGW', 'bin'),
  ];
}

function cppVendor(bin) {
  const p = bin.toLowerCase();
  if (p.includes('w64devkit')) return 'w64devkit';
  if (p.includes('msys64')) return `MSYS2 ${path.basename(path.dirname(bin)).toUpperCase()}`;
  if (p.includes('llvm-mingw')) return 'llvm-mingw';
  return 'MinGW-w64';
}

function createToolchains({ root = installRoot(), run } = {}) {
  const spec = (name) => ({ ...TOOLCHAINS[name], ...overrides()[name] });
  const dirOf = (name) => { const s = spec(name); return path.join(root, s.kind, `${s.folder}-${s.version}`); };
  const homeOf = (name) => path.join(dirOf(name), spec(name).top);
  const installed = (name) => isFile(path.join(homeOf(name), spec(name).probe));

  function status(name) {
    const s = spec(name);
    return { name, kind: s.kind, title: s.title, version: s.version, size: s.size, dir: dirOf(name), home: homeOf(name), installed: installed(name) };
  }

  // Same steps as a portable database server: download (resumed from nothing, checked against the pinned sha256),
  // extract into a staging folder, then swap it in so a cancelled or failed extraction leaves nothing half done.
  async function install(name, { log, progress, signal, exec }) {
    const s = spec(name);
    const dir = dirOf(name);
    if (installed(name)) { progress(1); return; }
    const parent = path.dirname(dir);
    fs.mkdirSync(parent, { recursive: true });
    const archive = path.join(parent, path.basename(new URL(s.url).pathname));
    if (!fs.existsSync(archive)) await download(s.url, archive, { sha256: s.sha256, size: s.size, signal, log, progress: (f) => progress(f * 0.85) });
    progress(0.85);
    const staging = `${dir}.extract`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    log(`Extracting to ${dir}\n`);
    try {
      await exec(tarExe(), ['-xf', archive, '-C', staging]);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    if (!isFile(path.join(staging, s.top, s.probe))) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`The archive has no ${s.top}/${s.probe}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    fs.rmSync(archive, { force: true });
    progress(1);
  }

  async function uninstall(name, { log }) {
    const dir = dirOf(name);
    log(`Removing ${dir}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.extract`, { recursive: true, force: true });
  }

  async function cppToolchain(bin, builtin) {
    const gcc = isFile(path.join(bin, 'gcc.exe'));
    const cc = path.join(bin, gcc ? 'gcc.exe' : 'clang.exe');
    const cxx = path.join(bin, gcc ? 'g++.exe' : 'clang++.exe');
    if (!isFile(cc)) return null;
    const r = run ? await run(cc, gcc ? ['-dumpfullversion'] : ['--version']) : { code: -1, out: '' };
    const version = r.code === 0 ? (gcc ? r.out.trim() : /version (\d+(?:\.\d+)*)/.exec(r.out)?.[1]) || null : null;
    return { kind: 'cpp', id: bin.toLowerCase(), home: path.dirname(bin), bin, version, vendor: cppVendor(bin), compiler: gcc ? 'GCC' : 'Clang',
      builtin, cc, cxx: isFile(cxx) ? cxx : null };
  }

  // Built-in first, then this computer's; one entry per folder.
  async function detect(kind, env = process.env) {
    const seen = new Set();
    const out = [];
    const add = (t) => { if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); } };
    const builtin = Object.keys(TOOLCHAINS).find((n) => TOOLCHAINS[n].kind === kind);
    const system = overrides().system !== false;
    if (kind === 'jdk') {
      const homes = [...(installed(builtin) ? [homeOf(builtin)] : []), ...(system ? systemJdkHomes(env) : [])];
      for (const h of homes) {
        if (!isFile(path.join(h, 'bin', 'javac.exe'))) continue;
        const home = real(h);
        add({ kind, id: home.toLowerCase(), home, bin: path.join(home, 'bin'), ...jdkInfo(home), builtin: !!installed(builtin) && home.toLowerCase() === real(homeOf(builtin)).toLowerCase() });
      }
    } else if (kind === 'cpp') {
      if (installed(builtin)) add(await cppToolchain(real(path.join(homeOf(builtin), 'bin')), true));
      if (system) {
        const bins = [...new Set(systemCppBins(env).map((b) => real(b)).filter((b) => isFile(path.join(b, 'gcc.exe')) || isFile(path.join(b, 'clang.exe'))))];
        for (const b of bins) if (!seen.has(b.toLowerCase())) add(await cppToolchain(b, false));
      }
    }
    return out;
  }

  return { status, install, uninstall, detect, names: () => Object.keys(TOOLCHAINS) };
}

module.exports = { TOOLCHAINS, createToolchains, installRoot };
