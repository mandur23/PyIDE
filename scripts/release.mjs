// Builds, tests and publishes a PyIDE release in one command (see FEATURES.md, Updates):
//   npm run release -- <version> [--dry-run [--no-build]] [--skip-tests] [--notes <file>] [--replace-local-install]
//   npm run release -- <version> --publish-only [--dry-run] [--notes <file>]
// 1. checks: clean tree on master, local master contains origin's, a semver version above package.json's, no tag v<v>
//    here or on origin, release notes, gh signed in
// 2. sets the version in package.json and package-lock.json   3. npm run dist and checks the installers and latest.yml (beta.yml)
// 4. verify/installed.mjs all on a hidden desktop              5. commit "Release <v>" and tag v<v>
// 6. pushes master and the tag (atomic)
// 7. publishes to the `pyide` release of mandur23/Portfolio-Nano- (never marked Latest): the installers and the exe's
//    blockmap, title and notes, then latest.yml and beta.yml (the update feed switches here), then deletes older
//    versions' files except the previous versions' blockmaps, which installed copies of those versions need for a
//    differential update
// 8. reads the feed back
// A beta (x.y.z-beta.N, which electron-builder builds with dist/beta.yml instead of latest.yml) goes only to beta
// installs: step 7 uploads its installers and blockmap and then beta.yml, and leaves latest.yml, PyIDE-Setup.exe, the
// title, the notes and every stable version's files alone. A stable release writes beta.yml too (a copy of latest.yml),
// so beta installs get it, unless the release holds a newer beta.
// Nothing is uploaded before the push and the feed switches last, so a stop leaves one clear way on; the error says which.
// --dry-run runs steps 1-4, prints the git and gh commands of steps 5-8 instead of running them, and puts the version
// (and dist/latest.yml or beta.yml) back at the end. --no-build (a testing aid, --dry-run only) skips step 3 and checks what dist holds.
// --publish-only runs steps 7-8 from dist for a version whose tag is already on origin (after a stop past step 6).
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { constants as osConstants, tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The app's own version order (semver: 0.2.5-beta.1 < 0.2.5), so the release and installed copies agree.
const { compareVersions: compare } = createRequire(import.meta.url)('../main/features/updater.js');
const REPO = 'mandur23/Portfolio-Nano-';
const TAG = 'pyide';
const FEED = `https://github.com/${REPO}/releases/download/${TAG}/`;
const AUTHOR = ['-c', 'user.name=PyIDE', '-c', 'user.email=ms01048913077@gmail.com'];
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
// PYIDE_DIST_DIR builds somewhere else than dist/, for when another program holds files in dist/win-unpacked open
// (the Claude desktop app does in its own workspace folders). verify/installed.mjs reads the same variable.
const DIST = process.env.PYIDE_DIST_DIR ? path.resolve(process.env.PYIDE_DIST_DIR) : path.join(ROOT, 'dist');
if (/["%^&|<>!]/.test(DIST)) throw new Error(`PYIDE_DIST_DIR must not contain " % ^ & | < > !: ${DIST}`);
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');
export const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'PyIDE');
const LOCAL_UNINSTALLER = path.join(INSTALL_DIR, 'Uninstall PyIDE.exe');
const USAGE = 'usage: npm run release -- <version> [--dry-run [--no-build]] [--skip-tests] [--notes <file>] [--replace-local-install]\n'
  + '       npm run release -- <version> --publish-only [--dry-run] [--notes <file>]\n'
  + '       <version> is x.y.z for everyone, or x.y.z-beta.N for beta installs only';
// x.y.z, or x.y.z-beta.N: the prerelease tag names electron-builder's channel file, and PyIDE reads only beta.yml.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/;
const isBeta = (v) => v.includes('-');
const channelFile = (v) => (isBeta(v) ? 'beta.yml' : 'latest.yml');

// Everything that reaches outside the script goes through io, so a test harness can stub it.
export const io = {
  spawnSync,
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  copyFileSync: fs.copyFileSync,
  mkdtempSync: fs.mkdtempSync,
  rmSync: fs.rmSync,
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (s) => console.log(s),
  error: (s) => console.error(s),
  exit: (c) => process.exit(c),
};

class Stop extends Error {}
class UsageError extends Error {}
const fail = (msg) => { throw new Stop(msg); };
const log = (s = '') => io.log(s);
const step = (n, s) => log(`\n== ${n}. ${s}`);

// ---------- arguments and run state ----------
let opts = {};
let V = '';
let dryRun = false;
export function configure(argv, env = process.env) {
  opts = { version: null, dryRun: false, skipTests: false, replace: false, notes: null, publishOnly: false, noBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-tests') opts.skipTests = true;
    else if (a === '--replace-local-install') opts.replace = true;
    else if (a === '--publish-only') opts.publishOnly = true;
    else if (a === '--no-build') opts.noBuild = true;
    else if (a === '--notes') opts.notes = argv[++i];
    else if (a.startsWith('--notes=')) opts.notes = a.slice('--notes='.length);
    else if (a === '-h' || a === '--help') return 'help';
    else if (!a.startsWith('-') && !opts.version) opts.version = a.replace(/^v(?=\d)/, '');
    else throw new UsageError(`unknown argument ${a}`);
  }
  // `npm run release 0.3.0 --dry-run` (no `--`) gives --dry-run to npm, which passes it on only as this variable.
  if (/^(true|1)$/.test(env.npm_config_dry_run || '')) opts.dryRun = true;
  if (!opts.version) throw new UsageError('no version');
  if (opts.noBuild && !opts.dryRun) throw new UsageError('--no-build is a testing aid for --dry-run only');
  if (opts.noBuild && opts.publishOnly) throw new UsageError('--publish-only builds nothing; drop --no-build');
  dryRun = opts.dryRun;
  V = opts.version;
  resetState();
  return 'run';
}

const newState = () => ({
  fromVersion: null, versionSet: false, ymlBefore: null,
  localInstall: null, uninstalled: false, reinstall: null, // reinstall: { installer, ok, status }
  committed: false, tagged: false, pushAttempted: false, pushed: false,
  installersUploaded: false, feedUploadStarted: false, live: false,
  adviceShown: false, interrupted: null,
});
export const state = newState();
export function resetState() { Object.assign(state, newState()); }

// Child processes must not see npm's dry-run flag (npm run dist would then build nothing).
const ENV = { ...process.env };
delete ENV.npm_config_dry_run;

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const show = (cmd, args) => [cmd, ...args].map(quote).join(' ');
// Runs a command without a shell (Node quotes each argument); output goes to the console unless captured.
// Fails the release on a non-zero exit unless allowFail. Only `npm run dist` uses a shell: npm is a .cmd, and the line is fixed apart from a PYIDE_DIST_DIR checked for cmd metacharacters.
function sh(cmd, args = [], { capture = false, allowFail = false, shell = false } = {}) {
  const r = io.spawnSync(cmd, args, { cwd: ROOT, env: ENV, encoding: 'utf8', shell, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (r.error && !allowFail) fail(`${show(cmd, args)}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${show(cmd, args)} failed (exit ${r.status})${capture ? `\n${(r.stderr || r.stdout || '').trim()}` : ''}`);
  return { status: r.error ? -1 : r.status, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trim() };
}
// Commands that change git or GitHub: printed in a dry run, run otherwise.
function act(cmd, args, o) {
  if (dryRun) { log(`  [dry-run] ${show(cmd, args)}`); return { status: 0, out: '' }; }
  log(`  $ ${show(cmd, args)}`);
  return sh(cmd, args, o);
}
const warnings = [];
// A problem that stops a real release; a dry run notes it and goes on.
function blocker(msg) {
  if (!dryRun) fail(msg);
  warnings.push(msg);
  log(`  WARNING (a real release would stop here): ${msg}`);
}

// ---------- versions ----------
// Rewrites only the version lines, so the files keep their formatting (and edits made meanwhile survive a restore).
function withVersion(text, v, lock) {
  let out = text.replace(/^(  "version": ")[^"]*(")/m, `$1${v}$2`);
  if (lock) out = out.replace(/("packages": \{\s*"": \{[^{}]*?"version": ")[^"]*(")/, `$1${v}$2`);
  return out;
}
function checkVersioned(before, after, v, lock, file) {
  const a = JSON.parse(after);
  const b = JSON.parse(before);
  const ok = a.version === v && (!lock || a.packages?.['']?.version === v);
  a.version = b.version;
  if (lock) a.packages[''].version = b.packages[''].version;
  if (!ok || JSON.stringify(a) !== JSON.stringify(b)) fail(`could not set the version in ${file} without changing anything else`);
}
function setVersions(v) {
  for (const [file, lock] of [[PKG, false], [LOCK, true]]) {
    const before = io.readFileSync(file, 'utf8');
    const after = withVersion(before, v, lock);
    checkVersioned(before, after, v, lock, path.basename(file));
    if (after !== before) io.writeFileSync(file, after);
  }
}

// ---------- release notes ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function changelogSection(v) {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!io.existsSync(file)) return null;
  const lines = io.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const head = new RegExp(`^##\\s+v?${escapeRe(v)}(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim() || null;
}
// --notes <file> is used as it is; a CHANGELOG.md section gets the release page's usual frame around it.
function releaseNotes(v) {
  if (opts.notes) {
    const file = path.resolve(opts.notes);
    if (!io.existsSync(file)) fail(`--notes: ${file} does not exist`);
    return { text: io.readFileSync(file, 'utf8'), source: file };
  }
  if (isBeta(v)) {
    // The release page describes the stable version and is not edited; this only makes sure What's New has notes.
    const core = v.split('-')[0];
    const own = changelogSection(v);
    return (own || changelogSection(core)) ? { source: `CHANGELOG.md, ## ${own ? v : core} (a beta leaves the release page's notes alone)`, text: null } : null;
  }
  const section = changelogSection(v);
  if (!section) return null;
  return {
    source: `CHANGELOG.md, ## ${v}`,
    text: [
      'PyCharm 스타일 Python IDE, PyIDE의 Windows 설치 파일입니다. 이 릴리스는 PyIDE 앱의 자동 업데이트 주소로도 쓰입니다.',
      '',
      `**PyIDE ${v}**`,
      section,
      '',
      '**설치 파일**',
      `- \`PyIDE-Setup-${v}.exe\` (또는 \`PyIDE-Setup.exe\`): 일반 설치, 앱 안에서 자동 업데이트`,
      `- \`PyIDE-${v}.msi\`: MSI 패키지`,
      '- 코드 서명이 없어 Windows SmartScreen 경고가 뜰 수 있습니다 (추가 정보 → 실행).',
      '',
      '**소스 코드:** https://github.com/mandur23/PyIDE',
      '',
    ].join('\n'),
  };
}

const noNotes = () => `no release notes: pass --notes <file> or add a "## ${V}" section${isBeta(V) ? ` (or "## ${V.split('-')[0]}", the release it previews)` : ''} to CHANGELOG.md`;

// ---------- git origin and GitHub (read-only queries run in a dry run too) ----------
// ls-remote reads origin without fetching, so nothing local changes (a dry run included).
function originRefs() {
  const r = sh('git', ['ls-remote', 'origin', 'refs/heads/master', `refs/tags/v${V}`], { capture: true, allowFail: true });
  if (r.status !== 0) return { error: r.err || `exit ${r.status}` };
  const refs = new Map(r.out.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t').reverse()));
  return { master: refs.get('refs/heads/master') || null, tag: refs.has(`refs/tags/v${V}`) };
}
function latestRelease() {
  const r = sh('gh', ['release', 'list', '-R', REPO, '--limit', '100', '--json', 'tagName,isLatest', '--jq', '.[] | select(.isLatest) | .tagName'], { capture: true, allowFail: true });
  return r.status === 0 ? { tag: r.out.split(/\r?\n/)[0] || null } : { error: r.err || `exit ${r.status}` };
}
function checkGh() {
  if (sh('gh', ['auth', 'status'], { capture: true, allowFail: true }).status !== 0) return blocker('gh is not signed in (gh auth login)');
  const latest = latestRelease();
  if (latest.error || !latest.tag || latest.tag === TAG) blocker(`the Latest release of ${REPO} is ${latest.tag || latest.error || 'not set'}; it must be one of the other releases (the APK)`);
  else log(`  Latest release of ${REPO}: ${latest.tag}`);
}
function releaseAssets() {
  const r = sh('gh', ['release', 'view', TAG, '-R', REPO, '--json', 'assets', '--jq', '.assets[].name'], { capture: true, allowFail: true });
  return r.status === 0 ? r.out.split(/\r?\n/).filter(Boolean) : null;
}
// The version of an installer or blockmap asset, or null (PyIDE-Setup.exe, latest.yml and beta.yml are replaced, not deleted).
const assetVersion = (name) => (/^PyIDE-Setup-(.+)\.exe(\.blockmap)?$/.exec(name) || /^PyIDE-(.+)\.msi(\.blockmap)?$/.exec(name))?.[1] ?? null;
const versionsOn = (assets) => [...new Set(assets.map(assetVersion).filter((x) => x && VERSION.test(x)))].sort(compare);
// The version installed copies run until this release: the newest stable one (with beta, the newest beta) below v.
export function previousVersion(assets, v, beta = false) {
  return versionsOn(assets).filter((x) => isBeta(x) === beta && compare(x, v) < 0).pop() || null;
}
// The beta that beta.yml offers: the newest beta whose installer is on the release (older ones are deleted).
export const liveBeta = (assets) => versionsOn(assets).filter((x) => isBeta(x) && assets.includes(`PyIDE-Setup-${x}.exe`)).pop() || null;
// What a differential update from a previous version reads from the feed besides the new installer: its old blockmap
// (electron-updater derives <feed>/PyIDE-Setup-<old>.exe.blockmap from the new installer's URL; the old installer itself
// comes from the user's %LOCALAPPDATA%\pyide-updater cache).
export const keptBlockmap = (prev) => (prev ? `PyIDE-Setup-${prev}.exe.blockmap` : null);
// The versions whose blockmaps stay: a stable release keeps the previous stable's and the previous beta's (beta installs
// update to it too); a beta keeps the previous beta's (stable versions' files are not a beta's to delete).
const keptVersions = (assets, v) => [...(isBeta(v) ? [] : [previousVersion(assets, v)]), previousVersion(assets, v, true)].filter(Boolean);
// Files of older versions to delete: a stable release deletes every older version's, a beta only older betas', except
// the kept blockmaps. Newer versions (a beta ahead of a stable fix) stay.
export function oldAssets(assets, v) {
  const keep = keptVersions(assets, v).map(keptBlockmap);
  return assets.filter((n) => { const x = assetVersion(n); return !!x && VERSION.test(x) && compare(x, v) < 0 && (!isBeta(v) || isBeta(x)) && !keep.includes(n); });
}
async function feedVersion(file) {
  const res = await io.fetch(`${FEED}${file}`, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) return `HTTP ${res.status}`;
  return /^version:\s*['"]?([^'"\s]+)/m.exec(await res.text())?.[1] || '(no version line)';
}

// ---------- dist ----------
// yml: the channel file electron-builder writes for v (latest.yml, or beta.yml for a beta).
const distFiles = (v) => ({ exe: path.join(DIST, `PyIDE-Setup-${v}.exe`), blockmap: path.join(DIST, `PyIDE-Setup-${v}.exe.blockmap`), msi: path.join(DIST, `PyIDE-${v}.msi`), yml: path.join(DIST, channelFile(v)) });
// The length of the file a blockmap describes (gzipped JSON; electron-builder writes one file entry).
function blockmapLength(file) {
  const entry = JSON.parse(gunzipSync(io.readFileSync(file)).toString()).files?.[0];
  return (entry?.offset || 0) + (entry?.sizes || []).reduce((a, b) => a + b, 0);
}
// Both installers there, the channel file naming this version's exe with that file's hash, and the exe's blockmap
// describing that exe (differential updates rebuild the exe from it). Returns the problem, or null.
function distProblem({ exe, blockmap, msi, yml: ymlFile }, v) {
  const missing = [exe, blockmap, msi, ymlFile].filter((f) => !io.existsSync(f)).map((f) => path.relative(ROOT, f));
  if (missing.length) return `dist has no ${missing.join(', ')}`;
  const yml = io.readFileSync(ymlFile, 'utf8');
  const name = `dist/${path.basename(ymlFile)}`;
  const field = (k) => new RegExp(`^${k}:\\s*['"]?([^'"\\s]+)`, 'm').exec(yml)?.[1];
  if (field('version') !== v || field('path') !== path.basename(exe)) return `${name} says version ${field('version')}, path ${field('path')}; expected ${v}, ${path.basename(exe)}`;
  const exeBytes = io.readFileSync(exe);
  if (field('sha512') !== createHash('sha512').update(exeBytes).digest('base64')) return `${name}'s sha512 does not match dist/${path.basename(exe)}`;
  let length = null;
  try { length = blockmapLength(blockmap); } catch {}
  if (length !== exeBytes.length) return `dist/${path.basename(blockmap)} does not describe dist/${path.basename(exe)} (${length ?? 'unreadable'} vs ${exeBytes.length} bytes)`;
  return null;
}

// ---------- local install ----------
const pyideRunning = () => /PyIDE\.exe/i.test(sh('tasklist', ['/FI', 'IMAGENAME eq PyIDE.exe', '/NH', '/FO', 'CSV'], { capture: true, allowFail: true }).out);
async function uninstallLocal() {
  if (pyideRunning()) fail('PyIDE.exe is running. Close PyIDE (every window) and run the release again; this script closes nothing.');
  log(`  $ ${show(LOCAL_UNINSTALLER, ['/S', '/currentuser'])}   (settings in %APPDATA%\\PyIDE are kept)`);
  state.uninstalled = true; // from here on, every way out reinstalls
  sh(LOCAL_UNINSTALLER, ['/S', '/currentuser']);
  // The uninstaller copies itself to %TEMP% and returns at once; wait for the files to go.
  for (let i = 0; i < 240 && (io.existsSync(path.join(INSTALL_DIR, 'PyIDE.exe')) || io.existsSync(LOCAL_UNINSTALLER)); i++) await io.sleep(500);
  if (io.existsSync(path.join(INSTALL_DIR, 'PyIDE.exe')) || io.existsSync(LOCAL_UNINSTALLER)) fail(`the uninstall did not remove ${INSTALL_DIR}`);
}
// The new build if the tests passed, else the version the user had when its installer is still in dist.
export function reinstallLocal(passed) {
  const { exe, previous } = state.localInstall;
  const installer = passed || !io.existsSync(previous) ? exe : previous;
  const args = ['/S', '/currentuser', `/D=${INSTALL_DIR}`];
  log(`  $ ${show(installer, args.slice(0, 2))} /D=${INSTALL_DIR}`);
  state.reinstall = { installer, ok: false, status: null };
  // No shell. NSIS wants /D= last and unquoted even with spaces, so the arguments go verbatim and argv[0] is quoted here.
  const r = io.spawnSync(installer, args, { argv0: `"${installer}"`, windowsVerbatimArguments: true, stdio: 'inherit', windowsHide: true });
  state.reinstall.status = r.error ? r.error.message : r.status;
  state.reinstall.ok = r.status === 0 && io.existsSync(path.join(INSTALL_DIR, 'PyIDE.exe'));
  if (state.reinstall.ok) log(`  reinstalled ${path.basename(installer)} into ${INSTALL_DIR}`);
  else io.error(reinstallAlarm());
  return state.reinstall.ok;
}
const reinstallFailed = () => !!state.reinstall && !state.reinstall.ok;
const reinstallAlarm = () => [
  '',
  `!!! PyIDE IS NOT INSTALLED ANY MORE: the release uninstalled ${INSTALL_DIR} and reinstalling it failed (${state.reinstall.status}).`,
  `!!! Install it yourself by running: ${state.reinstall.installer}`,
  `!!!   (silent, same folder: "${state.reinstall.installer}" /S /currentuser /D=${INSTALL_DIR})`,
  '',
].join('\n');

// ---------- failure advice and cleanup ----------
// What to do after a stop depends only on how far the run got.
export function failureAdvice() {
  if (dryRun) return [];
  const pub = `npm run release -- ${V} --publish-only`;
  const push = `git push --atomic origin master refs/tags/v${V}`;
  const yml = channelFile(V);
  const who = isBeta(V) ? 'beta installs' : 'installed copies';
  if (state.live) {
    return [
      `Release ${V} IS LIVE: the feed's ${yml} names ${V} and ${who} will update to it.`,
      `Do not reset, delete the tag v${V} or remove the uploaded files. Fix the problem, then finish with ${pub}`,
      '(it uploads the same files again and repeats the remaining steps) or do the rest by hand.',
    ];
  }
  if (state.pushed) {
    return [
      `The commit "Release ${V}" and tag v${V} are on origin: do not reset or delete the tag.`,
      state.feedUploadStarted
        ? `The ${yml} upload did not finish: if ${FEED}${yml} already names ${V}, the release is live.`
        : `The feed's ${yml} was not changed, so ${who} still see the previous version${state.installersUploaded ? ' (the new installers may already be on the release page)' : ''}.`,
      `Fix the problem, then run ${pub}: it skips steps 1-6 and uploads from dist.`,
    ];
  }
  if (state.tagged) {
    return [
      `Commit "Release ${V}" and tag v${V} are local only; nothing was uploaded.`,
      ...(state.pushAttempted ? [`If git ls-remote origin refs/tags/v${V} lists the tag, the push did go through: run ${pub}.`] : []),
      `Otherwise undo them with: git tag -d v${V} && git reset --hard HEAD~1`,
      `or push them (${push}) and run ${pub}.`,
    ];
  }
  if (state.committed) {
    return [
      `Commit "Release ${V}" was made but tagging v${V} failed; nothing was pushed or uploaded, and package.json stays at ${V} (it is in that commit).`,
      'Undo the commit with: git reset --hard HEAD~1',
      `or tag it (git tag -a v${V} -m "PyIDE ${V}"), push both (${push}) and run ${pub}.`,
    ];
  }
  return state.fromVersion ? ['Nothing was committed, pushed or uploaded.'] : [];
}
function printAdvice() {
  for (const l of failureAdvice()) io.error(l);
  state.adviceShown = true;
}
// Idempotent: the normal exit and a signal handler both call it.
export function cleanup() {
  if (state.uninstalled && !state.reinstall) reinstallLocal(false);
  // A dry run, or a real one that stopped before its commit, leaves the version (and dist's channel file) as it found them.
  if (state.versionSet && (dryRun || !state.committed)) {
    for (const [file, lock] of [[PKG, false], [LOCK, true]]) io.writeFileSync(file, withVersion(io.readFileSync(file, 'utf8'), state.fromVersion, lock));
    state.versionSet = false;
    log(`version in package.json and package-lock.json put back to ${state.fromVersion}`);
  }
  if (state.ymlBefore) {
    io.writeFileSync(path.join(DIST, channelFile(V)), state.ymlBefore);
    state.ymlBefore = null;
    log(`dist/${channelFile(V)} put back`);
  }
}
// Ctrl+C (SIGINT), SIGTERM and Ctrl+Break (SIGBREAK, Windows): the same cleanup, then exit.
// A signal is handled between the script's own steps; a command running at that moment gets the Ctrl+C too and fails.
export function onSignal(sig) {
  if (state.interrupted) return;
  state.interrupted = sig;
  io.error(`\nrelease interrupted (${sig})`);
  cleanup();
  if (!state.adviceShown) printAdvice();
  if (reinstallFailed()) io.error(reinstallAlarm());
  io.exit(128 + (osConstants.signals[sig] || 2));
}
let signalsInstalled = false;
export function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(sig, () => onSignal(sig));
}

// ---------- the release ----------
async function main() {
  log(`PyIDE release ${V}${opts.publishOnly ? ', publish only' : ''}${dryRun ? ' (dry run: nothing is committed, tagged, pushed or uploaded)' : ''}`);
  if (!VERSION.test(V)) fail(`"${V}" is not x.y.z (a release) or x.y.z-beta.N (a beta); PyIDE reads only latest.yml and beta.yml`);
  if (isBeta(V)) log(`  a beta: only installs on the Beta channel get it (beta.yml); latest.yml stays as it is`);
  if (opts.publishOnly) return publishOnly();

  step(1, 'checks');
  const pkg = JSON.parse(io.readFileSync(PKG, 'utf8'));
  if (compare(V, pkg.version) <= 0) fail(`${V} is not greater than package.json's ${pkg.version}`);
  state.fromVersion = pkg.version;
  log(`  version ${pkg.version} -> ${V}`);
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).out;
  if (branch !== 'master') blocker(`on branch ${branch}, not master`);
  const dirty = sh('git', ['status', '--porcelain'], { capture: true }).out;
  if (dirty) blocker(`the working tree has changes:\n${dirty.split(/\r?\n/).map((l) => `      ${l}`).join('\n')}`);
  else log('  working tree clean');
  if (sh('git', ['rev-parse', '-q', '--verify', `refs/tags/v${V}`], { capture: true, allowFail: true }).status === 0) blocker(`tag v${V} already exists`);
  const origin = originRefs();
  if (origin.error) blocker(`could not read origin (git ls-remote): ${origin.error}`);
  else {
    if (origin.tag) blocker(`tag v${V} is already on origin`);
    const head = sh('git', ['rev-parse', 'HEAD'], { capture: true }).out;
    if (!origin.master) blocker('origin has no master branch');
    else if (origin.master === head) log('  master is up to date with origin');
    else if (sh('git', ['merge-base', '--is-ancestor', origin.master, 'HEAD'], { capture: true, allowFail: true }).status === 0) {
      log(`  master is ${sh('git', ['rev-list', '--count', `${origin.master}..HEAD`], { capture: true }).out} commit(s) ahead of origin; step 6 pushes them too`);
    } else blocker(`origin's master (${origin.master.slice(0, 7)}) has commits local master does not (behind or diverged); git pull --ff-only first`);
  }
  const notes = releaseNotes(V);
  if (notes) log(`  release notes: ${notes.source}`);
  else blocker(noNotes());
  checkGh();
  if (!opts.skipTests && io.existsSync(LOCAL_UNINSTALLER) && !opts.replace) {
    fail(`PyIDE is installed per-user in ${INSTALL_DIR}, where the installer tests install and then remove the MSI build.\n`
      + '  Run again with --replace-local-install (close PyIDE first: it uninstalls that copy silently, keeps your settings in\n'
      + '  %APPDATA%\\PyIDE, runs the tests and installs the new build there afterwards), or with --skip-tests.');
  }
  if (!opts.skipTests && opts.replace && !dryRun && io.existsSync(LOCAL_UNINSTALLER) && pyideRunning()) {
    fail('PyIDE.exe is running. Close PyIDE (every window) and run the release again; this script closes nothing.');
  }

  step(2, `set version ${V} in package.json and package-lock.json`);
  setVersions(V);
  state.versionSet = true;
  log('  done');

  const files = distFiles(V);
  const { exe, blockmap, msi, yml } = files;
  const built = `dist/${path.basename(exe)}, dist/${path.basename(blockmap)}, dist/${path.basename(msi)}, dist/${path.basename(yml)} (version ${V})`;
  if (opts.noBuild) {
    step(3, 'npm run dist: skipped (--no-build, a dry-run testing aid); checking what dist already holds');
    const problem = distProblem(files, V);
    if (problem) blocker(problem);
    else log(`  ${built}`);
  } else {
    step(3, 'npm run dist');
    if (dryRun && io.existsSync(yml)) state.ymlBefore = io.readFileSync(yml);
    sh(process.env.PYIDE_DIST_DIR ? `npm run dist -- "-c.directories.output=${DIST}"` : 'npm run dist', [], { shell: true });
    const problem = distProblem(files, V);
    if (problem) fail(`after npm run dist: ${problem}`);
    log(`  ${built}`);
  }

  step(4, 'installer tests (verify/installed.mjs all, on a hidden desktop)');
  if (opts.skipTests) log('  skipped (--skip-tests)');
  else {
    const collision = io.existsSync(LOCAL_UNINSTALLER);
    if (collision && dryRun) {
      log(`  [dry-run] PyIDE is installed in ${INSTALL_DIR}; a dry run leaves it alone and skips the installer tests. A real run would:`);
      log(`  [dry-run] ${show(LOCAL_UNINSTALLER, ['/S', '/currentuser'])}`);
      log('  [dry-run] powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1 -Out verify/out/release-installed.txt -TimeoutMinutes 20 node verify/installed.mjs all');
      log(`  [dry-run] ${show(exe, ['/S', '/currentuser'])} /D=${INSTALL_DIR}`);
      warnings.push('installer tests skipped: PyIDE is installed locally (a dry run does not uninstall it)');
    } else {
      if (collision) state.localInstall = { exe, previous: path.join(DIST, `PyIDE-Setup-${pkg.version}.exe`) };
      let passed = false;
      try {
        if (collision) await uninstallLocal();
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'verify/on-desktop.ps1', '-Out', 'verify/out/release-installed.txt', '-TimeoutMinutes', '20', 'node', 'verify/installed.mjs', 'all'];
        log(`  $ ${show('powershell', args)}`);
        passed = sh('powershell', args, { allowFail: true }).status === 0;
      } finally {
        if (state.uninstalled && !state.reinstall) reinstallLocal(passed);
      }
      if (reinstallFailed()) fail('reinstalling PyIDE failed (see above), so the release stops before committing anything');
      if (!passed) fail('the installer tests failed (verify/out/release-installed.txt)');
    }
  }

  step(5, `commit "Release ${V}" and tag v${V}`);
  act('git', ['add', 'package.json', 'package-lock.json']);
  act('git', [...AUTHOR, 'commit', '-m', `Release ${V}`, '-m', TRAILER]);
  state.committed = !dryRun;
  act('git', [...AUTHOR, 'tag', '-a', `v${V}`, '-m', `PyIDE ${V}`]);
  state.tagged = !dryRun;

  step(6, `push master and tag v${V}`);
  state.pushAttempted = !dryRun;
  act('git', ['push', '--atomic', 'origin', 'master', `refs/tags/v${V}`]);
  state.pushed = !dryRun;

  await publish(files, notes);
}

// After a run that stopped once its commit and tag were pushed: steps 7-8 from dist.
async function publishOnly() {
  step('1-6', 'skipped (--publish-only); checks for publishing what dist holds');
  const files = distFiles(V);
  const problem = distProblem(files, V);
  if (problem) blocker(problem);
  else log(`  dist/${path.basename(files.exe)}, dist/${path.basename(files.blockmap)}, dist/${path.basename(files.msi)}, dist/${path.basename(files.yml)} (version ${V}, hash matches)`);
  const origin = originRefs();
  if (origin.error) blocker(`could not read origin (git ls-remote): ${origin.error}`);
  else if (!origin.tag) blocker(`tag v${V} is not on origin; --publish-only finishes a run that stopped after its push (step 6)`);
  else log(`  tag v${V} is on origin`);
  const notes = releaseNotes(V);
  if (notes) log(`  release notes: ${notes.source}`);
  else blocker(noNotes());
  checkGh();
  state.pushed = !dryRun;
  await publish(files, notes);
}

async function publish({ exe, blockmap, msi, yml }, notes) {
  const beta = isBeta(V);
  step(7, beta ? `publish the beta to the ${TAG} release of ${REPO}: installers, then beta.yml (latest.yml, title and notes stay)`
    : `publish to the ${TAG} release of ${REPO}: installers, title and notes, then latest.yml and beta.yml`);
  const before = latestRelease();
  if (before.error) blocker(`gh release list failed: ${before.error}`);
  else if (!before.tag || before.tag === TAG) blocker(`the Latest release is ${before.tag || 'not set'}; it must be one of the other releases (the APK) before publishing`);
  else log(`  Latest release now: ${before.tag} (must stay so)`);
  // Read before anything is uploaded: which beta beta.yml offers, and which older files go at the end.
  const listed = releaseAssets();
  if (!listed) blocker(`could not list the assets of the ${TAG} release`);
  const assets = listed || [];
  if (dryRun) log(`  current assets: ${assets.join(', ') || '(unknown)'}`);
  const rel = (f) => path.relative(ROOT, f); // gh runs in the repo root
  const stage = io.mkdtempSync(path.join(tmpdir(), 'pyide-release-'));
  // The channel files, uploaded last. A stable release points beta.yml at itself too (beta installs get every stable
  // release), unless the release holds a newer beta for them.
  const feedFiles = [yml];
  try {
    if (!beta) {
      const ahead = liveBeta(assets);
      if (ahead && compare(ahead, V) > 0) log(`  beta.yml stays at ${ahead}, which is newer than ${V}`);
      else {
        feedFiles.push(path.join(stage, 'beta.yml'));
        io.writeFileSync(feedFiles[1], io.readFileSync(yml));
      }
    }
    // The blockmap goes up with the exe, before the channel files: an update to this version reads it first.
    if (beta) {
      act('gh', ['release', 'upload', TAG, rel(exe), rel(blockmap), rel(msi), '-R', REPO, '--clobber']);
      state.installersUploaded = !dryRun;
      log('  PyIDE-Setup.exe, the title and the notes stay as they are (they belong to the stable version)');
    } else {
      const stable = path.join(stage, 'PyIDE-Setup.exe');
      const notesFile = path.join(stage, 'notes.md');
      if (!dryRun) io.copyFileSync(exe, stable);
      io.writeFileSync(notesFile, notes?.text || '');
      act('gh', ['release', 'upload', TAG, rel(exe), rel(blockmap), rel(msi), stable, '-R', REPO, '--clobber']);
      state.installersUploaded = !dryRun;
      act('gh', ['release', 'edit', TAG, '-R', REPO, '--title', `PyIDE ${V}`, '--notes-file', notesFile, '--latest=false']);
      if (dryRun) log(`  [dry-run] notes file ${notesFile}:\n${(notes?.text || '(none)').replace(/^/gm, '      | ')}`);
    }
    if (dryRun) log(`  [dry-run] then gh release list -R ${REPO}: Latest must still be ${before.tag || 'a non-pyide release'}`);
    else {
      const after = latestRelease();
      if (after.error || !after.tag || after.tag === TAG) {
        if (before.tag && before.tag !== TAG) act('gh', ['release', 'edit', before.tag, '-R', REPO, '--latest']);
        fail(`!!! after publishing, gh release list shows Latest = ${after.tag || after.error || 'none'}, not ${before.tag}. `
          + `The APK links (releases/latest/download/...) depend on it: ${before.tag ? `${before.tag} was set back to Latest; check` : 'set the right release as Latest yourself at'} https://github.com/${REPO}/releases`);
      }
      log(`  Latest release is still ${after.tag}`);
    }
    // The feed switches here, last: until now installed copies saw the previous version, whose installers are still up.
    state.feedUploadStarted = !dryRun;
    act('gh', ['release', 'upload', TAG, ...feedFiles.map((f) => (f.startsWith(stage) ? f : rel(f))), '-R', REPO, '--clobber']);
    state.live = !dryRun;
  } finally {
    try { io.rmSync(stage, { recursive: true, force: true }); } catch {} // the uploaded copies and notes are done with
  }
  // Installed copies of the previous versions update differentially with their blockmaps; older versions download in full.
  const kept = keptVersions(assets, V);
  if (!kept.length) log('  no previous version on the release');
  for (const prev of kept) {
    const keep = keptBlockmap(prev);
    if (assets.includes(keep)) log(`  keeping ${keep}: ${prev} updates to ${V} differentially`);
    else log(`  ${keep} is not on the release: copies of ${prev} download the full installer`);
  }
  const old = oldAssets(assets, V);
  for (const name of old) act('gh', ['release', 'delete-asset', TAG, name, '-R', REPO, '--yes']);
  if (!old.length) log('  no assets of older versions to delete');

  const names = feedFiles.map((f) => path.basename(f));
  step(8, `check ${names.map((n) => FEED + n).join(' and ')}`);
  for (const name of names) {
    if (dryRun) {
      log(`  [dry-run] would read ${FEED}${name} (following redirects) until it reports ${V}`);
      log(`  it reports ${await feedVersion(name).catch((e) => e.message)} now`);
      continue;
    }
    let seen = '';
    for (let i = 0; i < 18; i++) {
      seen = await feedVersion(name).catch((e) => e.message);
      if (seen === V) break;
      await io.sleep(10000);
    }
    if (seen !== V) fail(`the feed's ${name} reports ${seen}, not ${V} (after 3 minutes)`);
    log(`  ${name} reports ${seen}`);
  }
}

// Returns the exit code.
export async function run(argv) {
  warnings.length = 0;
  let mode;
  try { mode = configure(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.error(`release: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (mode === 'help') { log(USAGE); return 0; }
  installSignalHandlers();
  let code = 0;
  try {
    await main();
    log(`\n${dryRun ? 'Dry run finished' : `Released PyIDE ${V}`}.${warnings.length ? ` ${warnings.length} warning(s):\n${warnings.map((w) => `  - ${w.split('\n')[0]}`).join('\n')}` : ''}`);
  } catch (err) {
    code = 1;
    io.error(`\nrelease ${dryRun ? 'dry run ' : ''}stopped: ${err instanceof Stop ? err.message : err.stack}`);
    printAdvice();
  } finally {
    cleanup();
  }
  if (reinstallFailed()) { code = 1; io.error(reinstallAlarm()); }
  return code;
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  // Not process.exit(): on Windows it can abort in libuv while fetch's sockets are still closing.
  process.exitCode = await run(process.argv.slice(2));
}
