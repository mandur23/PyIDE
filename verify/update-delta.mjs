// Differential (delta) updates, proven without installing anything:
//   node verify/update-delta.mjs [--old <dir> --new <dir>] [--keep-builds]
// Without --old/--new it builds two NSIS installers (this version and the next patch, `npx electron-builder --win nsis
// --x64 -c.extraMetadata.version=…`) into %TEMP%\pyide-delta-*, never into dist/, and deletes them at the end (about
// 600 MB each). --old/--new name folders that each hold a PyIDE-Setup-<v>.exe, its .blockmap and latest.yml.
// Each case runs verify/update-delta-main.cjs, a windowless Electron main process that registers main/features/updater.js
// as an NSIS install (PYIDE_UPDATE_TEST_KIND=nsis) of the old version, with LOCALAPPDATA in a temp folder holding the old
// installer as pyide-updater\installer.exe (where the NSIS installer puts itself). It checks a feed with the new
// installer and downloads it through electron-updater. The test then compares the downloaded file with the new installer
// byte for byte and looks at what the feed server sent. Cases: delta over http and from a folder feed; a stale cached
// current.blockmap; fallbacks to the full installer with no old blockmap on the feed, no cached installer and a corrupt
// cached installer; PYIDE_UPDATE_DIFFERENTIAL=0 and the setting turned off; a delta to a beta (beta.yml, Beta channel).
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ELECTRON = require('electron'); // the path of electron.exe
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const keepBuilds = argv.includes('--keep-builds');

let pass = 0;
let failed = 0;
const check = (ok, label) => { if (ok) pass++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const MB = (n) => `${(n / 1048576).toFixed(2)} MB`;
const temps = [];
const mkTemp = (prefix) => { const d = fs.mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };

// ---------- the two installers ----------
function build(version, out, extra = []) {
  console.log(`building ${version} into ${out} …`);
  const started = Date.now();
  const r = spawnSync(`npx electron-builder --win nsis --x64 --publish never -c.extraMetadata.version=${version} ${extra.join(' ')} "-c.directories.output=${out}"`,
    { cwd: ROOT, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`electron-builder ${version} failed (exit ${r.status}):\n${(r.stdout + r.stderr).slice(-3000)}`);
  console.log(`  built in ${Math.round((Date.now() - started) / 1000)} s`);
}
function readBuild(dir) {
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  const version = /^version:\s*(\S+)/m.exec(yml)[1];
  const exe = path.join(dir, `PyIDE-Setup-${version}.exe`);
  return { dir, version, exe, blockmap: `${exe}.blockmap`, latestYml: path.join(dir, 'latest.yml'), size: fs.statSync(exe).size };
}

let OLD;
let NEW;
let buildRoot = null;
if (arg('--old') && arg('--new')) {
  OLD = readBuild(path.resolve(arg('--old')));
  NEW = readBuild(path.resolve(arg('--new')));
} else {
  buildRoot = fs.mkdtempSync(path.join(tmpdir(), 'pyide-delta-'));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const next = base.replace(/\d+$/, (n) => String(Number(n) + 1));
  build(base, path.join(buildRoot, 'old'));
  build(next, path.join(buildRoot, 'new'), ['"-c.extraMetadata.deltaProbe=second build"']);
  OLD = readBuild(path.join(buildRoot, 'old'));
  NEW = readBuild(path.join(buildRoot, 'new'));
}
console.log(`old ${OLD.version}: ${OLD.exe} (${MB(OLD.size)})\nnew ${NEW.version}: ${NEW.exe} (${MB(NEW.size)})`);

// What electron-updater's plan for this pair downloads: the changed runs of blocks.
const readMap = (f) => JSON.parse(gunzipSync(fs.readFileSync(f)).toString());
const plan = computeOperations(readMap(OLD.blockmap), readMap(NEW.blockmap), { info() {}, warn() {} });
const planDownload = plan.filter((o) => o.kind === OperationKind.DOWNLOAD);
const planBytes = planDownload.reduce((a, o) => a + o.end - o.start, 0);
console.log(`plan: ${planDownload.length} ranges, ${MB(planBytes)} of ${MB(NEW.size)} to download (${(100 * planBytes / NEW.size).toFixed(1)}%)`);

// ---------- byte-for-byte comparison ----------
function sameFile(a, b) {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  const fa = fs.openSync(a, 'r');
  const fb = fs.openSync(b, 'r');
  const ba = Buffer.alloc(1 << 20);
  const bb = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const na = fs.readSync(fa, ba, 0, ba.length, null);
      const nb = fs.readSync(fb, bb, 0, bb.length, null);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (!na) return true;
    }
  } finally { fs.closeSync(fa); fs.closeSync(fb); }
}
const link = (from, to) => { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } };

// ---------- one case: a fresh Electron process ----------
// beta: the new installer is offered as <new>-beta.1 in beta.yml only (the same bytes under a beta's file names, so the
// old blockmap's URL is derived from a prerelease version), and the case checks on the Beta channel.
async function runCase(name, { http = true, oldBlockmapOnFeed = true, cachedInstaller = 'old', cachedBlockmap = null, differential = undefined, env = {}, beta = false } = {}) {
  console.log(`\n-- ${name}`);
  const dir = mkTemp('pyide-delta-case-');
  const feedDir = path.join(dir, 'feed');
  const local = path.join(dir, 'local');
  const cache = path.join(local, 'pyide-updater');
  const appDir = path.join(dir, 'app');
  for (const d of [feedDir, cache, appDir]) fs.mkdirSync(d, { recursive: true });
  const offered = beta ? `${NEW.version}-beta.1` : NEW.version;
  const exeName = `PyIDE-Setup-${offered}.exe`;
  link(NEW.exe, path.join(feedDir, exeName));
  fs.copyFileSync(NEW.blockmap, path.join(feedDir, `${exeName}.blockmap`));
  fs.copyFileSync(beta ? OLD.latestYml : NEW.latestYml, path.join(feedDir, 'latest.yml'));
  if (beta) fs.writeFileSync(path.join(feedDir, 'beta.yml'), fs.readFileSync(NEW.latestYml, 'utf8').replaceAll(path.basename(NEW.exe), exeName).replace(/^version: .*$/m, `version: ${offered}`));
  if (oldBlockmapOnFeed) fs.copyFileSync(OLD.blockmap, path.join(feedDir, path.basename(OLD.blockmap)));
  const installer = path.join(cache, 'installer.exe');
  if (cachedInstaller === 'old') link(OLD.exe, installer);
  else if (cachedInstaller === 'corrupt') {
    // Same length, one byte changed inside a block the plan copies from the old file: the rebuilt file fails its hash.
    fs.copyFileSync(OLD.exe, installer);
    const copy = plan.find((o) => o.kind === OperationKind.COPY && o.end - o.start > 4096);
    const fd = fs.openSync(installer, 'r+');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, copy.start + 2048);
    b[0] ^= 0xff;
    fs.writeSync(fd, b, 0, 1, copy.start + 2048);
    fs.closeSync(fd);
  }
  if (cachedBlockmap) fs.copyFileSync(cachedBlockmap, path.join(cache, 'current.blockmap'));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'pyide', productName: 'PyIDE', version: OLD.version, main: 'main.cjs' }));
  fs.writeFileSync(path.join(appDir, 'main.cjs'), `require(${JSON.stringify(path.join(ROOT, 'verify', 'update-delta-main.cjs'))});\n`);
  fs.writeFileSync(path.join(appDir, 'dev-app-update.yml'), 'provider: generic\nurl: http://127.0.0.1:9/\nupdaterCacheDirName: pyide-updater\n');
  const out = path.join(dir, 'result.json');
  const childEnv = { ...process.env, PYIDE_UPDATE_TEST: '1', PYIDE_UPDATE_TEST_KIND: 'nsis', LOCALAPPDATA: local, PYIDE_UPDATE_FEED: 'off',
    PYIDE_DELTA_CASE: JSON.stringify({ updaterJs: path.join(ROOT, 'main', 'features', 'updater.js'), feedDir, http, differential, channel: beta ? 'beta' : 'stable', userData: path.join(dir, 'userData'), out }), ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!('PYIDE_UPDATE_DIFFERENTIAL' in env)) delete childEnv.PYIDE_UPDATE_DIFFERENTIAL;
  const child = spawn(ELECTRON, [appDir], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 5 * 60 * 1000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (!fs.existsSync(out)) {
    check(false, `${name}: the Electron run wrote a result (exit ${code})\n${output.slice(-2000)}`);
    return null;
  }
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  r.exeRequests = r.requests.filter((q) => q.path.endsWith(`/${exeName}`) && q.method === 'GET');
  r.exeBytes = r.exeRequests.reduce((a, q) => a + q.bytes, 0);
  r.blockmapRequests = r.requests.filter((q) => q.path.endsWith('.blockmap'));
  r.same = !!r.file && fs.existsSync(r.file) && sameFile(r.file, NEW.exe);
  if (r.error) console.log(`  error: ${r.error}`);
  console.log(`  download: ${JSON.stringify(r.download)}, ${r.exeRequests.length} request(s) for the exe, ${MB(r.exeBytes)} of it sent, ${r.ms} ms`);
  for (const l of r.logs.filter((x) => /differential|blockmap|full installer|Full:|Cannot download/i.test(x))) console.log(`  log: ${l.split('\n')[0].slice(0, 220)}`);
  check(!r.error && r.kind === 'nsis' && r.check?.available === offered && r.phase === 'downloaded', `${name}: ${OLD.version} finds ${offered} and downloads it`);
  check(r.same, `${name}: the downloaded file equals PyIDE-Setup-${NEW.version}.exe byte for byte`);
  return r;
}

// The real cache of an installed PyIDE must not change.
const realCache = path.join(process.env.LOCALAPPDATA || '', 'pyide-updater');
const snapshot = () => {
  const rows = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); rows.push(`${p}|${s.size}|${s.mtimeMs}`); } } };
  if (fs.existsSync(realCache)) walk(realCache);
  return rows.sort().join('\n');
};
const before = snapshot();

try {
  const deltaOk = (r, name, version = NEW.version) => {
    if (!r) return;
    const ranged = r.exeRequests.every((q) => q.range && q.status === 206);
    check(r.download?.mode === 'delta' && r.download.bytes === planBytes && r.download.size === NEW.size, `${name}: state.download says delta, ${MB(planBytes)} of ${MB(NEW.size)}`);
    check(ranged && r.exeRequests.length === planDownload.length && r.exeBytes === planBytes, `${name}: only the ${planDownload.length} changed ranges of the exe were sent (${MB(r.exeBytes)}, ${(100 * r.exeBytes / NEW.size).toFixed(1)}%)`);
    check(r.states.some((s) => s.phase === 'downloading' && s.download?.mode === 'delta' && s.download.bytes === planBytes), `${name}: progress states carry the delta size (status bar "(delta ${(planBytes / 1048576).toFixed(1)} MB)")`);
    check(r.logs.some((l) => l.includes(`downloaded ${version} differentially`)), `${name}: the log says the download was differential`);
  };
  const fullOk = (r, name, reason) => {
    if (!r) return;
    check(r.download?.mode === 'full' && r.download.reason === reason, `${name}: state.download says full (${reason})`);
    check(r.exeRequests.some((q) => !q.range && q.status === 200 && q.bytes === NEW.size), `${name}: the whole exe was sent`);
  };

  let r = await runCase('delta over http', { http: true });
  deltaOk(r, 'delta over http');
  check(r && r.blockmapRequests.map((q) => q.path).sort().join() === [`/${path.basename(NEW.blockmap)}`, `/${path.basename(OLD.blockmap)}`].sort().join(), 'delta over http: both blockmaps were read from the feed (old one by the derived URL)');

  r = await runCase('delta from a local folder feed', { http: false });
  deltaOk(r, 'folder feed');

  r = await runCase('delta to a beta on the Beta channel', { beta: true });
  deltaOk(r, 'beta', `${NEW.version}-beta.1`);
  check(r && r.blockmapRequests.map((q) => q.path).sort().join() === [`/PyIDE-Setup-${NEW.version}-beta.1.exe.blockmap`, `/${path.basename(OLD.blockmap)}`].sort().join(), 'beta: the old blockmap URL is derived from the beta file name');

  r = await runCase('stale cached current.blockmap', { cachedBlockmap: NEW.blockmap });
  deltaOk(r, 'stale current.blockmap');
  check(r && r.logs.some((l) => /removed .*current\.blockmap/.test(l)), 'stale current.blockmap: removed, the feed\'s old blockmap used');

  r = await runCase('old blockmap missing on the feed', { oldBlockmapOnFeed: false });
  fullOk(r, 'no old blockmap', 'fallback');
  check(r && r.logs.some((l) => l.includes('not possible')) && r.blockmapRequests.some((q) => q.status === 404), 'no old blockmap: a 404, logged, then the full installer');

  r = await runCase('no cached installer', { cachedInstaller: null });
  fullOk(r, 'no cached installer', 'fallback');

  r = await runCase('corrupt cached installer', { cachedInstaller: 'corrupt' });
  fullOk(r, 'corrupt cached installer', 'fallback');
  check(r && r.logs.some((l) => /sha512 checksum mismatch/i.test(l)) && r.exeRequests.some((q) => q.range), 'corrupt cached installer: the rebuilt file failed its sha512 check, then the full installer');

  r = await runCase('PYIDE_UPDATE_DIFFERENTIAL=0', { env: { PYIDE_UPDATE_DIFFERENTIAL: '0' } });
  fullOk(r, 'PYIDE_UPDATE_DIFFERENTIAL=0', 'off');
  check(r && !r.blockmapRequests.length && r.logs.some((l) => l.includes('differential download is off (PYIDE_UPDATE_DIFFERENTIAL=0)')), 'PYIDE_UPDATE_DIFFERENTIAL=0: no blockmap read, logged');

  r = await runCase('updates.differential off', { differential: false });
  fullOk(r, 'setting off', 'off');
  check(r && !r.blockmapRequests.length && r.logs.some((l) => l.includes('differential download is off (updates.differential)')), 'updates.differential off: no blockmap read, logged');

  check(snapshot() === before, `the real ${realCache} was not touched`);
} catch (err) {
  check(false, `unexpected error: ${err.stack || err}`);
} finally {
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  if (buildRoot && !keepBuilds) {
    try { fs.rmSync(buildRoot, { recursive: true, force: true }); console.log(`\nremoved the builds in ${buildRoot}`); } catch (e) { console.log(`could not remove ${buildRoot}: ${e.message}`); }
  } else if (buildRoot) console.log(`\nbuilds kept in ${buildRoot}`);
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
