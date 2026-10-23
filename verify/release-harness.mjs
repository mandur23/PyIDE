// Pure-Node checks of scripts/release.mjs (in CI): io (spawnSync, fs, fetch, sleep, exit) is stubbed with a fake world,
// so no git, gh, installer, network or file outside it is touched; it only reads package.json, package-lock.json and
// CHANGELOG.md. Covers failure advice by phase, the order of a release, local-install handling, signals, the
// blockmap rules of differential updates, and the beta channel (a beta publishes only beta.yml and leaves latest.yml
// alone; a stable release writes both). Usage: node verify/release-harness.mjs
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { gzipSync } from 'zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.PYIDE_DIST_DIR; // the fake world's installers are in dist/
const R = await import(pathToFileURL(path.join(ROOT, 'scripts', 'release.mjs')).href);
const { io, state, configure, failureAdvice, run, INSTALL_DIR, previousVersion, oldAssets, liveBeta } = R;
const REPO_ARG = 'mandur23/Portfolio-Nano-';

const V = '0.2.1';
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, `PyIDE-Setup-${V}.exe`);
const BLOCKMAP = `${EXE}.blockmap`;
const PREV = path.join(DIST, 'PyIDE-Setup-0.2.0.exe');
const UNINST = path.join(INSTALL_DIR, 'Uninstall PyIDE.exe');
const INSTALLED = path.join(INSTALL_DIR, 'PyIDE.exe');
const pkgText = readFileSync(PKG, 'utf8').replace(/^(  "version": ")[^"]*/m, '$10.2.0');
const lockText = readFileSync(LOCK, 'utf8');
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

let pass = 0, failed = 0;
// DEBUG=1 prints the output and commands of a failed check's run.
const ok = (cond, name) => {
  if (cond) pass++; else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond && process.env.DEBUG) console.log(W.out.map((l) => `    > ${l}`).join('\n'), '\n    calls:', W.calls.join(' | '));
};

// ---------- fake world ----------
let W;
// The pyide release's assets before this release: the previous version's installers and blockmap, an older blockmap.
const ASSETS = ['latest.yml', 'PyIDE-Setup-0.2.0.exe', 'PyIDE-Setup-0.2.0.exe.blockmap', 'PyIDE-0.2.0.msi', 'PyIDE-Setup-0.1.9.exe.blockmap', 'PyIDE-Setup.exe', `PyIDE-Setup-${V}.exe`];
// A blockmap (gzipped JSON) describing a file of that length.
const blockmapOf = (length) => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: ['a', 'b'], sizes: [length - 3, 3] }] }));
const ymlText = (version, exeName, sha) => `version: ${version}\nfiles:\n  - url: ${exeName}\n    sha512: ${sha}\npath: ${exeName}\nsha512: ${sha}\n`;
// version: what dist holds; a beta has dist/beta.yml instead of latest.yml, and staleLatest adds an old dist/latest.yml.
function world({ version = V, failAt = null, originMaster = 'abc', tagOnOrigin = false, ahead = true, installed = false, testsPass = true, reinstallOk = true, uninstallFails = false, feed = version, ymlVersion = version, onSleep = null, assets = ASSETS, staleLatest = null } = {}) {
  const exeBody = 'fake exe bytes';
  const sha = createHash('sha512').update(exeBody).digest('base64');
  const exe = path.join(DIST, `PyIDE-Setup-${version}.exe`);
  const files = new Map([
    [PKG, pkgText], [LOCK, lockText], [path.join(ROOT, 'CHANGELOG.md'), changelog],
    [exe, exeBody], [`${exe}.blockmap`, blockmapOf(exeBody.length)], [path.join(DIST, `PyIDE-${version}.msi`), 'msi'], [PREV, 'prev exe'],
    [path.join(DIST, version.includes('-') ? 'beta.yml' : 'latest.yml'), ymlText(ymlVersion, path.basename(exe), sha)],
  ]);
  if (staleLatest) files.set(path.join(DIST, 'latest.yml'), ymlText(staleLatest, `PyIDE-Setup-${staleLatest}.exe`, 'old'));
  if (installed) { files.set(UNINST, 'u'); files.set(INSTALLED, 'old'); }
  W = { version, files, calls: [], spawns: [], out: [], fetched: [], exitCode: null, failAt, originMaster, tagOnOrigin, ahead, testsPass, reinstallOk, uninstallFails, feed, onSleep, assets };
  return W;
}
const line = (cmd, args) => [path.basename(cmd), ...args].join(' ');
function fakeSpawn(cmd, args, opts) {
  const l = line(cmd, args);
  W.calls.push(l);
  W.spawns.push({ cmd, args, opts });
  const res = (status, stdout = '') => ({ status, stdout, stderr: status ? 'boom' : '' });
  if (W.failAt && l.includes(W.failAt)) return res(1);
  if (cmd === UNINST) {
    if (W.uninstallFails) return res(1);
    W.files.delete(UNINST); W.files.delete(INSTALLED); return res(0);
  }
  if (cmd === EXE || cmd === PREV) {
    if (!W.reinstallOk) return res(2);
    W.files.set(INSTALLED, cmd); return res(0);
  }
  if (l.startsWith('git rev-parse --abbrev-ref')) return res(0, 'master');
  if (l.startsWith('git status')) return res(0, '');
  if (l.startsWith('git rev-parse -q --verify')) return res(1);
  if (l.startsWith('git rev-parse HEAD')) return res(0, 'abc');
  if (l.startsWith('git ls-remote')) return res(0, `${W.originMaster}\trefs/heads/master\n${W.tagOnOrigin ? `t1\trefs/tags/v${W.version}\n` : ''}`);
  if (l.startsWith('git merge-base')) return res(W.ahead ? 0 : 1);
  if (l.startsWith('git rev-list --count')) return res(0, '2');
  if (l.startsWith('gh release list')) return res(0, 'v1.4.3');
  if (l.startsWith('gh release view')) return res(0, W.assets.join('\n'));
  if (l.startsWith('tasklist')) return res(0, 'INFO: No tasks');
  if (l.startsWith('powershell')) return res(W.testsPass ? 0 : 1);
  return res(0);
}
Object.assign(io, {
  spawnSync: fakeSpawn,
  existsSync: (f) => W.files.has(f),
  readFileSync: (f) => { if (!W.files.has(f)) throw new Error(`ENOENT ${f}`); return W.files.get(f); },
  writeFileSync: (f, d) => { W.files.set(f, String(d)); },
  copyFileSync: (a, b) => { W.files.set(b, W.files.get(a)); },
  mkdtempSync: (p) => `${p}STAGE`,
  rmSync: () => {},
  fetch: async (url) => { W.fetched.push(String(url)); return { ok: true, text: async () => `version: ${W.feed}\n` }; },
  sleep: async () => { if (W.onSleep) { const f = W.onSleep; W.onSleep = null; f(); return new Promise(() => {}); } },
  log: (s) => W.out.push(String(s)),
  error: (s) => W.out.push(String(s)),
  exit: (c) => { W.exitCode = c; },
});
const text = () => W.out.join('\n');
// The feed switch of a stable release: dist/latest.yml (with the staged beta.yml) in one upload.
const FEED_UP = `upload pyide dist${path.sep}latest.yml`;
const idx = (s) => W.calls.findIndex((c) => c.includes(s));
const has = (s) => idx(s) >= 0;
const pkgVersion = () => /"version": "([^"]+)"/.exec(W.files.get(PKG))[1];

// ---------- A. failure advice by phase ----------
console.log('-- A. failureAdvice');
function advice(flags, argv = [V]) { configure(argv, {}); Object.assign(state, flags); return failureAdvice().join('\n'); }
let a = advice({ fromVersion: '0.2.0', versionSet: true });
ok(/Nothing was committed/.test(a), 'before commit: nothing committed');
a = advice({ versionSet: true, committed: true });
ok(/tagging v0.2.1 failed/.test(a) && /git reset --hard HEAD~1/.test(a) && !/tag -d/.test(a), 'commit ok, tag failed: reset only, accurate message');
a = advice({ committed: true, tagged: true });
ok(/git tag -d v0.2.1 && git reset --hard HEAD~1/.test(a) && !/ls-remote/.test(a), 'tagged, not pushed: tag -d + reset');
a = advice({ committed: true, tagged: true, pushAttempted: true });
ok(/ls-remote origin refs\/tags\/v0.2.1/.test(a) && /tag -d/.test(a), 'push failed: check ls-remote first, else tag -d + reset');
a = advice({ committed: true, tagged: true, pushAttempted: true, pushed: true });
ok(/--publish-only/.test(a) && /do not reset/.test(a) && !/reset --hard|tag -d/.test(a), 'pushed: --publish-only, never reset');
a = advice({ pushed: true, installersUploaded: true });
ok(/new installers may already be on the release page/.test(a) && !/reset --hard/.test(a), 'pushed + installers up: feed unchanged');
a = advice({ pushed: true, installersUploaded: true, feedUploadStarted: true });
ok(/did not finish/.test(a) && !/reset --hard/.test(a), 'latest.yml upload interrupted: check the feed');
a = advice({ pushed: true, installersUploaded: true, feedUploadStarted: true, live: true });
ok(/IS LIVE/.test(a) && !/reset --hard|git tag -d/.test(a), 'live: says live, never reset');
ok(advice({ committed: true, tagged: true, pushed: true, live: true }, [V, '--dry-run']) === '', 'dry run: no advice');

// ---------- B. full runs against the fake world ----------
console.log('-- B. runs');
world();
let code = await run([V, '--skip-tests']);
const order = ['git add', ' commit ', ' tag -a', 'git push --atomic origin master refs/tags/v0.2.1', 'release upload pyide dist', 'release edit pyide', 'upload pyide dist' + path.sep + 'latest.yml', 'delete-asset pyide PyIDE-0.2.0.msi'].map(idx);
ok(code === 0 && order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), `success: order commit < tag < push < installers < edit < latest.yml < delete old (${order.join(',')})`);
ok(idx('git ls-remote origin refs/heads/master refs/tags/v0.2.1') >= 0 && idx('git ls-remote') < idx('git add'), 'step 1 reads origin with ls-remote');
ok(/master is up to date with origin/.test(text()), 'origin master = HEAD: up to date');
world({ originMaster: 'old', ahead: true });
code = await run([V, '--skip-tests']);
ok(code === 0 && /2 commit\(s\) ahead of origin/.test(text()) && has('git merge-base --is-ancestor old HEAD'), 'local ahead of origin: allowed, logged');
ok(pkgVersion() === V, 'success: package.json keeps the new version');
ok(!has('git fetch') && !has('reset'), 'no fetch, no reset');

world({ originMaster: 'zzz', ahead: false });
code = await run([V, '--skip-tests']);
ok(code === 1 && /behind or diverged/.test(text()) && !has('npm run dist') && !has(' commit ') && pkgVersion() === '0.2.0', 'origin has commits we lack: stops in step 1, nothing changed');

world({ tagOnOrigin: true });
code = await run([V, '--skip-tests']);
ok(code === 1 && /already on origin/.test(text()) && !has(' commit '), 'tag already on origin: stops in step 1');

world({ failAt: 'npm run dist' });
code = await run([V, '--skip-tests']);
ok(code === 1 && pkgVersion() === '0.2.0' && /Nothing was committed/.test(text()) && /put back to 0.2.0/.test(text()), 'build fails: version restored, nothing committed');

world({ failAt: ' tag -a' });
code = await run([V, '--skip-tests']);
ok(code === 1 && pkgVersion() === V && /tagging v0.2.1 failed/.test(text()) && !/put back/.test(text()) && !has('git push'), 'tag fails after commit: package.json NOT reverted, accurate message, no push');

world({ failAt: 'git push' });
code = await run([V, '--skip-tests']);
ok(code === 1 && !has('gh release upload') && /git tag -d v0.2.1/.test(text()) && /ls-remote/.test(text()), 'push fails: nothing uploaded, tag -d/reset offered');

world({ failAt: 'release upload pyide dist' + path.sep + 'PyIDE-Setup' });
code = await run([V, '--skip-tests']);
ok(code === 1 && !has(FEED_UP) && /--publish-only/.test(text()) && !/reset --hard|tag -d/.test(text()), 'installer upload fails after push: --publish-only, no reset');

world({ failAt: FEED_UP });
code = await run([V, '--skip-tests']);
ok(code === 1 && /did not finish/.test(text()) && !/reset --hard/.test(text()), 'latest.yml upload fails: check feed, no reset');

world({ failAt: 'delete-asset' });
code = await run([V, '--skip-tests']);
ok(code === 1 && /IS LIVE/.test(text()) && !/reset --hard|tag -d/.test(text()), 'old-asset delete fails after feed switch: live, no reset');

world({ feed: '0.2.0' });
code = await run([V, '--skip-tests']);
ok(code === 1 && /after 3 minutes/.test(text()) && /IS LIVE/.test(text()), 'feed check fails: live, no reset');

// --publish-only
world({ tagOnOrigin: true });
code = await run([V, '--publish-only']);
ok(code === 0 && !has(' commit ') && !has('git push') && !has('npm run dist') && idx('release upload pyide dist' + path.sep + 'PyIDE') < idx(FEED_UP), 'publish-only: no commit/push/build, installers then latest.yml');
world({ tagOnOrigin: false });
code = await run([V, '--publish-only']);
ok(code === 1 && /is not on origin/.test(text()) && !has('gh release upload'), 'publish-only without the tag on origin: stops before uploading');
world({ tagOnOrigin: true, ymlVersion: '0.2.0' });
code = await run([V, '--publish-only']);
ok(code === 1 && /dist\/latest.yml says version 0.2.0/.test(text()) && !has('gh release upload'), 'publish-only with dist/latest.yml of another version: stops');
world({ tagOnOrigin: true });
W.files.set(EXE, 'other bytes');
code = await run([V, '--publish-only']);
ok(code === 1 && /sha512 does not match/.test(text()), 'publish-only: exe hash must match latest.yml');
world();
ok(await run([V, '--no-build']) === 2 && /--dry-run only/.test(text()), '--no-build without --dry-run: usage error');

// ---------- C. local install ----------
console.log('-- C. local install');
world({ installed: true, testsPass: false });
code = await run([V, '--replace-local-install']);
let re = W.spawns.find((s) => s.cmd === PREV || s.cmd === EXE);
ok(code === 1 && re?.cmd === PREV && /installer tests failed/.test(text()) && pkgVersion() === '0.2.0', 'tests fail: previous version reinstalled, version restored');
ok(re && JSON.stringify(re.args) === JSON.stringify(['/S', '/currentuser', `/D=${INSTALL_DIR}`]) && re.opts.windowsVerbatimArguments === true && re.opts.argv0 === `"${PREV}"` && !re.opts.shell, 'reinstall: no shell, args array, verbatim, /D= last unquoted, argv0 quoted');
ok(W.spawns.every((s) => !s.opts?.shell || line(s.cmd, s.args) === 'npm run dist'), 'no other command runs through a shell');

world({ installed: true, testsPass: true });
code = await run([V, '--replace-local-install']);
re = W.spawns.find((s) => s.cmd === PREV || s.cmd === EXE);
ok(code === 0 && re?.cmd === EXE && W.files.get(INSTALLED) === EXE, 'tests pass: new build reinstalled, release goes on');

world({ installed: true, uninstallFails: true });
code = await run([V, '--replace-local-install']);
ok(code === 1 && W.spawns.some((s) => s.cmd === PREV) && /Uninstall PyIDE.exe" \/S \/currentuser failed/.test(text()) && pkgVersion() === '0.2.0', 'uninstaller fails (inside the try): finally still reinstalls');

world({ installed: true, testsPass: true, reinstallOk: false });
code = await run([V, '--replace-local-install']);
ok(code === 1 && /!!! PyIDE IS NOT INSTALLED ANY MORE/.test(text()) && text().includes(`by running: ${EXE}`) && !has(' commit ') && pkgVersion() === '0.2.0', 'reinstall fails: exit 1, loud message naming the installer, nothing committed');

// ---------- D. blockmaps (differential updates) ----------
console.log('-- D. blockmaps');
const deletes = () => W.calls.filter((c) => c.includes('delete-asset')).map((c) => c.split(' ')[4]);
world();
code = await run([V, '--skip-tests']);
const upload = W.calls.find((c) => c.startsWith('gh release upload pyide dist'));
ok(code === 0 && upload.includes(`PyIDE-Setup-${V}.exe.blockmap`) && upload.includes(`PyIDE-Setup-${V}.exe `), 'the exe\'s blockmap is uploaded together with the installers');
ok(idx(`PyIDE-Setup-${V}.exe.blockmap`) < idx(FEED_UP), 'the blockmap is up before latest.yml (which still goes last)');
ok(deletes().sort().join() === ['PyIDE-0.2.0.msi', 'PyIDE-Setup-0.1.9.exe.blockmap', 'PyIDE-Setup-0.2.0.exe'].join(), `previous version's installers and older blockmaps deleted (${deletes().join(', ')})`);
ok(!deletes().some((n) => ['PyIDE-Setup-0.2.0.exe.blockmap', 'PyIDE-Setup.exe', 'latest.yml'].includes(n) || n.includes(V)), 'kept: the previous version\'s blockmap, PyIDE-Setup.exe, latest.yml and this version\'s files');
ok(/keeping PyIDE-Setup-0\.2\.0\.exe\.blockmap: 0\.2\.0 updates to 0\.2\.1 differentially/.test(text()), 'the run says which blockmap it keeps and why');
ok(idx('delete-asset') > idx(FEED_UP), 'deletes come after the feed switch');

world({ assets: ['latest.yml', 'PyIDE-Setup-0.2.0.exe', 'PyIDE-0.2.0.msi', 'PyIDE-Setup.exe'] });
code = await run([V, '--skip-tests']);
ok(code === 0 && /PyIDE-Setup-0\.2\.0\.exe\.blockmap is not on the release: copies of 0\.2\.0 download the full installer/.test(text()), 'previous version without a blockmap on the release: says those copies download in full');

world();
W.files.delete(BLOCKMAP);
code = await run([V, '--skip-tests']);
ok(code === 1 && /after npm run dist: dist has no .*PyIDE-Setup-0\.2\.1\.exe\.blockmap/.test(text()) && !has(' commit ') && pkgVersion() === '0.2.0', 'build without the blockmap: stops before committing, version restored');
world({ tagOnOrigin: true });
W.files.set(BLOCKMAP, blockmapOf(99));
code = await run([V, '--publish-only']);
ok(code === 1 && /does not describe .*\(99 vs 14 bytes\)/.test(text()) && !has('gh release upload'), 'publish-only with a blockmap of another file: stops before uploading');
world({ tagOnOrigin: true });
W.files.set(BLOCKMAP, 'not gzip');
code = await run([V, '--publish-only']);
ok(code === 1 && /does not describe .*unreadable/.test(text()), 'an unreadable blockmap stops the release');

world();
code = await run([V, '--dry-run', '--skip-tests']);
const dry = text();
ok(code === 0 && dry.includes(`[dry-run] gh release upload pyide dist${path.sep}PyIDE-Setup-${V}.exe dist${path.sep}PyIDE-Setup-${V}.exe.blockmap dist${path.sep}PyIDE-${V}.msi`), 'dry run prints the upload with the blockmap');
ok(dry.includes('[dry-run] gh release delete-asset pyide PyIDE-Setup-0.1.9.exe.blockmap') && !dry.includes('delete-asset pyide PyIDE-Setup-0.2.0.exe.blockmap') && /keeping PyIDE-Setup-0\.2\.0\.exe\.blockmap/.test(dry), 'dry run prints the deletes and the kept blockmap');
ok(!W.calls.some((c) => /^gh release (upload|edit|delete-asset)|^git (commit|tag|push)/.test(c)), 'dry run runs no upload, edit, delete, commit, tag or push');

ok(previousVersion(['PyIDE-Setup-0.9.0.exe', 'PyIDE-Setup-0.10.0.exe.blockmap', 'PyIDE-0.10.1.msi', 'PyIDE-Setup.exe'], '0.10.1') === '0.10.0', 'previous version: numeric order (0.10.0 > 0.9.0), this version excluded');
ok(previousVersion(['latest.yml', 'PyIDE-Setup.exe', 'PyIDE-Setup-1.0.0.exe'], '1.0.0') === null, 'previous version: none when only this version is up');
ok(oldAssets(['PyIDE-Setup-0.9.0.exe', 'PyIDE-Setup-0.9.0.exe.blockmap', 'PyIDE-Setup-0.10.0.exe.blockmap', 'PyIDE-Setup-0.10.1.exe', 'PyIDE-Setup.exe', 'latest.yml'], '0.10.1').join() === 'PyIDE-Setup-0.9.0.exe,PyIDE-Setup-0.9.0.exe.blockmap', 'old assets: everything of older versions except the previous blockmap');

// ---------- E. signals ----------
console.log('-- E. signals');
// Ctrl+C while waiting for the uninstaller (the only await before the commit): the handler reinstalls and restores.
world({ installed: true, onSleep: () => process.emit('SIGINT') });
W.uninstallFails = false;
// keep the uninstaller "running": files stay, so the wait loop sleeps
const realSpawn = io.spawnSync;
io.spawnSync = (cmd, args, opts) => (cmd === UNINST ? (W.calls.push(line(cmd, args)), { status: 0, stdout: '', stderr: '' }) : realSpawn(cmd, args, opts));
const pending = run([V, '--replace-local-install']);
await new Promise((r) => setTimeout(r, 50));
io.spawnSync = realSpawn;
re = W.spawns.filter((s) => s.cmd === PREV || s.cmd === EXE);
ok(W.exitCode === 130, `SIGINT mid-run: exit 130 (got ${W.exitCode})`);
ok(re.length === 1 && re[0].cmd === PREV, 'SIGINT mid-run: previous version reinstalled once');
ok(pkgVersion() === '0.2.0' && /interrupted \(SIGINT\)/.test(text()) && /Nothing was committed/.test(text()), 'SIGINT mid-run: version restored, advice printed');
void pending;

// After the commit and tag: no version restore, before-push advice.
world();
configure([V], {});
Object.assign(state, { fromVersion: '0.2.0', versionSet: true, committed: true, tagged: true });
W.files.set(PKG, pkgText.replace('"version": "0.2.0"', `"version": "${V}"`));
process.emit('SIGINT');
ok(W.exitCode === 130 && pkgVersion() === V && /git tag -d v0.2.1/.test(text()), 'SIGINT after commit+tag: package.json kept, tag -d/reset advice');

world();
configure([V], {});
Object.assign(state, { pushed: true, live: true });
process.emit('SIGTERM');
ok(W.exitCode === 143 && /IS LIVE/.test(text()) && !/reset --hard/.test(text()), 'SIGTERM after feed switch: exit 143, live, no reset');

if (process.platform === 'win32') {
  world();
  configure([V], {});
  Object.assign(state, { fromVersion: '0.2.0', versionSet: true });
  W.files.set(PKG, pkgText.replace('"version": "0.2.0"', `"version": "${V}"`));
  process.emit('SIGBREAK');
  ok(W.exitCode === 149 && pkgVersion() === '0.2.0', 'SIGBREAK (Windows): exit 149, version restored');
}

world({ installed: true, reinstallOk: false });
configure([V, '--replace-local-install'], {});
Object.assign(state, { uninstalled: true, localInstall: { exe: EXE, previous: PREV } });
W.files.delete(INSTALLED);
process.emit('SIGINT');
process.emit('SIGINT');
re = W.spawns.filter((s) => s.cmd === PREV || s.cmd === EXE);
ok(W.exitCode === 130 && re.length === 1 && /!!! PyIDE IS NOT INSTALLED ANY MORE/.test(text()) && text().includes(PREV), 'SIGINT, reinstall fails: loud message, non-zero, second signal ignored');

// ---------- F. beta channel ----------
console.log('-- F. beta channel');
const B1 = `${V}-beta.1`;
const B2 = `${V}-beta.2`;
const sep = path.sep;
const uploads = () => W.calls.filter((c) => c.startsWith('gh release upload'));
const betaYmlUp = `upload pyide dist${sep}beta.yml -R`;
// A stable 0.2.0 is live; the previous cycle left a beta blockmap; 0.2.1-beta.1 is the beta.yml version.
const BETA_ASSETS = ['latest.yml', 'beta.yml', 'PyIDE-Setup.exe', 'PyIDE-Setup-0.2.0.exe', 'PyIDE-Setup-0.2.0.exe.blockmap', 'PyIDE-0.2.0.msi', 'PyIDE-Setup-0.1.9.exe.blockmap',
  'PyIDE-Setup-0.2.0-beta.3.exe.blockmap', `PyIDE-Setup-${B1}.exe`, `PyIDE-Setup-${B1}.exe.blockmap`, `PyIDE-${B1}.msi`];

world({ version: B1, staleLatest: '0.2.0', assets: BETA_ASSETS.filter((n) => !n.includes(B1)) });
code = await run([B1, '--skip-tests']);
ok(code === 0 && pkgVersion() === B1 && has(`commit -m Release ${B1}`) && has(`tag -a v${B1}`) && has(`push --atomic origin master refs/tags/v${B1}`), `beta ${B1}: version set, committed, tagged and pushed like a release`);
ok(/release notes: CHANGELOG\.md, ## 0\.2\.1 \(a beta/.test(text()), 'beta without its own CHANGELOG section: the section of the release it previews (## 0.2.1)');
let ups = uploads();
ok(ups.length === 2 && ups[0] === `gh release upload pyide dist${sep}PyIDE-Setup-${B1}.exe dist${sep}PyIDE-Setup-${B1}.exe.blockmap dist${sep}PyIDE-${B1}.msi -R ${REPO_ARG} --clobber`, `beta: installers and blockmap first, without PyIDE-Setup.exe (${ups[0]})`);
ok(ups[1].includes(betaYmlUp) && idx(betaYmlUp) > idx(`PyIDE-Setup-${B1}.exe.blockmap`), 'beta: beta.yml uploaded last, after the blockmap');
ok(!W.calls.some((c) => /latest\.yml/.test(c)), 'beta: latest.yml is neither uploaded nor touched (dist holds a stale one of 0.2.0)');
ok(!has('release edit pyide') && !has('--latest'), 'beta: the release title, notes and Latest flag are not edited');
ok(!deletes().length && /keeping PyIDE-Setup-0\.2\.0-beta\.3\.exe\.blockmap: 0\.2\.0-beta\.3 updates to 0\.2\.1-beta\.1 differentially/.test(text()), `beta: stable versions' files untouched, the previous beta's blockmap kept (deleted: ${deletes().join(', ') || 'none'})`);
ok(W.fetched.length === 1 && W.fetched[0].endsWith('/beta.yml') && /beta\.yml reports 0\.2\.1-beta\.1/.test(text()), `beta: step 8 reads beta.yml back (${W.fetched.join(', ')})`);

world({ version: B2, assets: BETA_ASSETS });
code = await run([B2, '--skip-tests']);
ok(code === 0 && deletes().sort().join() === ['PyIDE-0.2.1-beta.1.msi', 'PyIDE-Setup-0.2.0-beta.3.exe.blockmap', 'PyIDE-Setup-0.2.1-beta.1.exe'].join(), `second beta: the previous beta's installers go, its blockmap stays (${deletes().join(', ')})`);
ok(/keeping PyIDE-Setup-0\.2\.1-beta\.1\.exe\.blockmap: 0\.2\.1-beta\.1 updates to 0\.2\.1-beta\.2 differentially/.test(text()), 'second beta: says it keeps the previous beta\'s blockmap');

// Promotion: the stable release after the betas.
world({ assets: [...BETA_ASSETS, `PyIDE-Setup-${B2}.exe`, `PyIDE-Setup-${B2}.exe.blockmap`, `PyIDE-${B2}.msi`].filter((n) => !n.includes(B1) || n.endsWith('.blockmap')) });
code = await run([V, '--skip-tests']);
ups = uploads();
let feedUp = ups.find((c) => c.includes(FEED_UP));
const stagedBeta = feedUp?.split(' ').find((a) => a.endsWith(`${sep}beta.yml`));
ok(code === 0 && ups.length === 2 && ups[0].includes(`PyIDE-Setup-${V}.exe `) && ups[0].includes('PyIDE-Setup.exe -R'), 'stable after betas: installers and PyIDE-Setup.exe first');
ok(feedUp && stagedBeta && idx(FEED_UP) > idx('release edit pyide') && feedUp.indexOf('latest.yml') < feedUp.indexOf('beta.yml'), `stable: latest.yml and beta.yml uploaded together, last (${feedUp})`);
ok(stagedBeta && W.files.get(stagedBeta) === W.files.get(path.join(DIST, 'latest.yml')), 'stable: the uploaded beta.yml is a copy of dist/latest.yml, so beta installs get the release');
ok(deletes().sort().join() === ['PyIDE-0.2.0.msi', 'PyIDE-0.2.1-beta.2.msi', 'PyIDE-Setup-0.1.9.exe.blockmap', 'PyIDE-Setup-0.2.0-beta.3.exe.blockmap', 'PyIDE-Setup-0.2.0.exe', 'PyIDE-Setup-0.2.1-beta.1.exe.blockmap', 'PyIDE-Setup-0.2.1-beta.2.exe'].join(),
  `stable: older versions and betas deleted except the previous stable's and the previous beta's blockmaps (${deletes().join(', ')})`);
ok(/keeping PyIDE-Setup-0\.2\.0\.exe\.blockmap: 0\.2\.0 updates/.test(text()) && /keeping PyIDE-Setup-0\.2\.1-beta\.2\.exe\.blockmap: 0\.2\.1-beta\.2 updates to 0\.2\.1/.test(text()), 'stable: says which two blockmaps it keeps');
ok(W.fetched.map((u) => u.split('/').pop()).join() === 'latest.yml,beta.yml', `stable: step 8 reads latest.yml and beta.yml back (${W.fetched.join(', ')})`);

// A stable fix while a newer beta is out: beta.yml keeps the beta, whose files stay.
world({ assets: [...ASSETS, 'beta.yml', 'PyIDE-Setup-0.3.0-beta.1.exe', 'PyIDE-Setup-0.3.0-beta.1.exe.blockmap', 'PyIDE-0.3.0-beta.1.msi'] });
code = await run([V, '--skip-tests']);
feedUp = uploads().find((c) => c.includes(FEED_UP));
ok(code === 0 && feedUp && !feedUp.includes('beta.yml') && /beta\.yml stays at 0\.3\.0-beta\.1, which is newer than 0\.2\.1/.test(text()), 'stable with a newer beta out: only latest.yml uploaded, beta.yml stays');
ok(!deletes().some((n) => n.includes('0.3.0')), 'stable with a newer beta out: the beta\'s files are not deleted');

// Advice, versions, notes and dist checks.
world({ version: B1, failAt: betaYmlUp, assets: BETA_ASSETS });
code = await run([B1, '--skip-tests']);
ok(code === 1 && /The beta\.yml upload did not finish: if .*beta\.yml already names 0\.2\.1-beta\.1/.test(text()) && !/reset --hard/.test(text()), 'beta.yml upload fails: advice names beta.yml');
world({ version: B2, failAt: 'delete-asset', assets: BETA_ASSETS });
code = await run([B2, '--skip-tests']);
ok(code === 1 && /IS LIVE: the feed's beta\.yml names 0\.2\.1-beta\.2 and beta installs will update to it/.test(text()), 'beta live: advice says beta installs get it');
for (const bad of [`${V}-rc.1`, `${V}-beta`, `${V}+7`, `${V}-beta.01`]) {
  world({ version: bad });
  code = await run([bad, '--skip-tests']);
  ok(code === 1 && /is not x\.y\.z \(a release\) or x\.y\.z-beta\.N/.test(text()) && !has('npm run dist'), `${bad}: refused before anything runs`);
}
world({ version: '0.2.0-beta.4' });
code = await run(['0.2.0-beta.4', '--skip-tests']);
ok(code === 1 && /0\.2\.0-beta\.4 is not greater than package\.json's 0\.2\.0/.test(text()), 'a beta below package.json\'s release (0.2.0-beta.4 < 0.2.0): refused');
world({ version: B1 });
W.files.set(path.join(ROOT, 'CHANGELOG.md'), `# x\n\n## ${B1}\n\n- beta notes\n\n## 0.2.0\n\n- old\n`);
code = await run([B1, '--skip-tests']);
ok(code === 0 && new RegExp(`release notes: CHANGELOG\\.md, ## ${B1.replace(/\./g, '\\.')} `).test(text()), 'beta with its own CHANGELOG section: that section');
world({ version: B1 });
W.files.set(path.join(ROOT, 'CHANGELOG.md'), '# x\n\n## 0.2.0\n\n- old\n');
code = await run([B1, '--skip-tests']);
ok(code === 1 && /add a "## 0\.2\.1-beta\.1" section \(or "## 0\.2\.1", the release it previews\)/.test(text()), 'beta without any section: stops, naming both headings');
world({ version: B1, tagOnOrigin: true, ymlVersion: '0.2.0-beta.3' });
code = await run([B1, '--publish-only']);
ok(code === 1 && /dist\/beta\.yml says version 0\.2\.0-beta\.3/.test(text()) && !has('gh release upload'), 'beta publish-only checks dist/beta.yml');
world({ version: B1, tagOnOrigin: true, assets: BETA_ASSETS });
code = await run([B1, '--publish-only']);
ok(code === 0 && uploads().at(-1).includes(betaYmlUp) && !W.calls.some((c) => /latest\.yml/.test(c)), 'beta publish-only: installers then beta.yml, latest.yml untouched');
world({ version: B1, staleLatest: '0.2.0', assets: BETA_ASSETS });
const ymlBefore = W.files.get(path.join(DIST, 'beta.yml'));
const latestBefore = W.files.get(path.join(DIST, 'latest.yml'));
code = await run([B1, '--dry-run', '--skip-tests']);
const dryBeta = text();
ok(code === 0 && dryBeta.includes(`[dry-run] gh release upload pyide dist${sep}beta.yml -R`) && !dryBeta.includes(`dist${sep}latest.yml`) && !W.calls.some((c) => /^gh release (upload|edit|delete-asset)|^git (commit|tag|push)/.test(c)), 'beta dry run: prints the beta.yml upload, runs nothing');
ok(/dist\/beta\.yml put back/.test(dryBeta) && W.files.get(path.join(DIST, 'beta.yml')) === ymlBefore && W.files.get(path.join(DIST, 'latest.yml')) === latestBefore && pkgVersion() === '0.2.0', 'beta dry run: dist/beta.yml and the version put back, dist/latest.yml untouched');

ok(previousVersion(['PyIDE-Setup-0.2.5-beta.9.exe.blockmap', 'PyIDE-Setup-0.2.5-beta.10.exe', 'PyIDE-Setup-0.2.4.exe'], '0.2.5', true) === '0.2.5-beta.10', 'previous beta: numeric prerelease order (beta.10 > beta.9)');
ok(previousVersion(['PyIDE-Setup-0.2.5-beta.1.exe', 'PyIDE-Setup-0.2.4.exe'], '0.2.5') === '0.2.4', 'previous stable: betas are not stable versions');
ok(liveBeta(['PyIDE-Setup-0.3.0-beta.1.exe.blockmap', 'PyIDE-Setup-0.2.9-beta.2.exe']) === '0.2.9-beta.2', 'the beta beta.yml offers: the newest beta with its installer on the release');

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
