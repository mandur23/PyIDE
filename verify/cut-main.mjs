// Nano Studio Cut's main side (main/features/cut.js and main/cut/*) in plain Node, Electron stubbed: every cut:*
// channel through a stand-in ipcMain, as the renderer calls it. Reads: ranges, short reads at the end, the size limit,
// and the attacks: UNC, \\?\UNC and \\.\ paths (refused without the file system ever being asked about them), a link
// whose target is a network path, a junction to a folder outside, an 8.3 name hiding another extension, an NTFS stream,
// a directory, a disallowed extension. Projects: atomic writes, .bak when the format version changes, a failed write
// keeping the old file. Autosave rotation (20 per key), session markers and the recovery list after sessions that
// never ended (a run that is gone, a crashed renderer) and not after clean ones (ended, window closed, saved after the
// last autosave, a live process). The export sink: appends and positional writes in order, commit and abort, another
// window refused, parts removed when the window closes and after a crashed run. Faststart on handcrafted MP4s (64-bit
// and 32-bit mdat): moov first, every chunk offset still pointing at the same bytes, stco overflowing into co64. The
// cache's LRU eviction order under the size setting, also after a restart. findMedia and listMedia limits, and the
// fonts of the real C:\Windows\Fonts (read-only) with Malgun Gothic, a TTC face served on its own, and a font folder's
// junction to outside refused.
// Usage: node verify/cut-main.mjs
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const skip = (label) => console.log(`SKIP ${label}`);
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (test, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(20); } return !!(await test()); };
const bytesEqual = (a, b) => a && b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const isBytes = (v) => v instanceof Uint8Array;
const brief = (v) => (isBytes(v) ? `${v.length} bytes` : S(v));

// main answers with real paths; the CI runner's %TEMP% is an 8.3 name (C:\Users\RUNNER~1), so expectations start real.
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'pyide-cut-main-')));
process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} });
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(userData, { recursive: true });
process.env.PYIDE_CUT_HOME = home;
delete process.env.PYIDE_CUT_DIALOG;
delete process.env.PYIDE_CUT_FONT_DIRS;
const settingsFile = path.join(userData, 'settings.json');

// Every path the file system is asked about, to prove a network path never reaches it. fakeLinks: path -> link target,
// answered by lstat/readlink as a symbolic link (creating a real one needs a privilege this account may not have).
const touched = [];
const fakeLinks = new Map();
const isUnc = (p) => /^[\\/]{2}/.test(String(p)) && !/^[\\/]{2}\?[\\/][a-z]:/i.test(String(p));
for (const name of ['lstat', 'stat', 'realpath', 'open', 'readlink', 'readdir', 'readFile', 'opendir', 'access', 'writeFile', 'rm', 'rename', 'copyFile', 'mkdir', 'utimes']) {
  const orig = fs.promises[name];
  fs.promises[name] = function spied(p, ...rest) {
    touched.push(String(p));
    const key = String(p).toLowerCase();
    if (fakeLinks.has(key) && name === 'lstat') return Promise.resolve({ isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false });
    if (fakeLinks.has(key) && name === 'readlink') return Promise.resolve(fakeLinks.get(key));
    return orig.call(this, p, ...rest);
  };
}
for (const name of ['statSync', 'lstatSync', 'existsSync', 'realpathSync', 'openSync', 'readFileSync', 'readdirSync']) {
  const orig = fs[name];
  fs[name] = function spied(p, ...rest) { touched.push(String(p)); return orig.call(this, p, ...rest); };
}
const networkTouches = () => touched.filter(isUnc);

// Electron, stubbed: dialogs record what they were asked and answer `dialogAnswer`; Explorer records what it shows.
const asked = [];
let dialogAnswer = { canceled: true, filePaths: [] };
const shown = [];
const electron = {
  app: { getPath: () => userData, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' },
  dialog: {
    showOpenDialog: async (_w, opts) => { asked.push(opts); return dialogAnswer; },
    showSaveDialog: async (_w, opts) => { asked.push(opts); return dialogAnswer; },
  },
  shell: { showItemInFolder: (p) => shown.push(p) },
  BrowserWindow: { fromWebContents: () => null },
};
const load = Module._load;
Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? electron : load.call(this, request, parent, isMain); };
const feature = require('../main/features/cut.js');
const { rewriteMoov } = require('../main/cut/faststart.js');
const fontsModule = require('../main/cut/fonts.js');
Module._load = load;

class Sender extends EventEmitter {
  constructor(id) { super(); this.id = id; this.gone = false; }
  isDestroyed() { return this.gone; }
  close() { this.gone = true; this.emit('destroyed'); }
  crash() { this.emit('render-process-gone', {}, { reason: 'crashed' }); }
}
// One start of the app: a fresh ipcMain with this module registered.
function start() {
  const handlers = new Map();
  feature.register({
    ipcMain: { handle: (c, fn) => { if (handlers.has(c)) throw new Error(`${c} registered twice`); handlers.set(c, fn); }, on() {} },
    app: electron.app,
    getWindow: () => null,
    diagnostics: { logger: () => ({ warn() {}, info() {}, error() {} }) },
  });
  const call = (sender, name, ...args) => {
    if (!handlers.has(name)) throw new Error(`${name} is not registered`);
    return handlers.get(name)({ sender }, ...args);
  };
  return { handlers, call };
}

const win = new Sender(1);
const other = new Sender(2);
const A = start();
const call = (name, ...args) => A.call(win, name, ...args);

try {
  // ---------- channels ----------
  const contract = ['home', 'stat', 'read', 'pickMedia', 'pickFolder', 'pickProject', 'saveAs', 'projectRead', 'projectWrite', 'autosave',
    'sessionStart', 'sessionEnd', 'recovery', 'writeOpen', 'writeAt', 'writeClose', 'faststart', 'cacheGet', 'cachePut', 'cacheInfo',
    'cacheClear', 'findMedia', 'fonts', 'fontData', 'reveal'].map((c) => `cut:${c}`);
  const missingChannels = contract.filter((c) => !A.handlers.has(c));
  check(!missingChannels.length, `every cut:* channel of the contract is registered (missing: ${S(missingChannels)})`);

  const h = await call('cut:home');
  check(h.home === home && ['projects', 'autosave', 'cache'].every((k) => typeof h[k] === 'string' && fs.statSync(h[k]).isDirectory() && h[k].startsWith(home)),
    `cut:home returns the Cut workspace and creates its Projects, Autosave and Cache folders (${S(h)})`);

  // ---------- stat and read ----------
  const media = path.join(work, 'media');
  const clipBytes = Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 7 + (i >> 8)) & 255));
  const clip = write(path.join(media, 'Clip One.mp4'), clipBytes);
  const st = await call('cut:stat', clip);
  check(st.size === clipBytes.length && st.isFile === true && Math.abs(st.mtime - fs.statSync(clip).mtimeMs) < 1, `cut:stat gives size, mtime and isFile (${S(st)})`);
  check(S(await call('cut:stat', path.join(media, 'gone.mp4'))) === S({ missing: true }), 'cut:stat of a missing file is {missing: true}');
  check((await call('cut:stat', media)).isFile === false, 'cut:stat of a folder says it is not a file');

  const whole = await call('cut:read', clip, 0, clipBytes.length);
  check(isBytes(whole) && bytesEqual(whole, clipBytes), `cut:read of the whole file returns its bytes as a Uint8Array (${whole?.length})`);
  const mid = await call('cut:read', clip, 123457, 4096);
  check(bytesEqual(mid, clipBytes.subarray(123457, 123457 + 4096)), 'a ranged read returns exactly that range');
  const tail = await call('cut:read', clip, clipBytes.length - 10, 4096);
  check(bytesEqual(tail, clipBytes.subarray(clipBytes.length - 10)), `a read past the end returns the bytes that are there (${tail?.length})`);
  const past = await call('cut:read', clip, clipBytes.length + 100, 16);
  check(isBytes(past) && past.length === 0, 'a read that starts past the end returns no bytes');
  const big = await call('cut:read', clip, 0, 64 * 1024 * 1024 + 1);
  check(big?.code === 'tooLarge', `a read of more than 64 MB is refused (${S(big?.code ?? big?.length)})`);
  check((await call('cut:read', clip, 0, 64 * 1024 * 1024))?.length === clipBytes.length, 'a read of exactly 64 MB is allowed');
  for (const [offset, length] of [[-1, 10], [0, -5], [1.5, 10], ['0', 10], [0, Infinity]]) {
    check((await call('cut:read', clip, offset, length))?.code === 'badArgs', `a read at offset ${S(offset)} for ${S(length)} bytes is refused as bad arguments`);
  }
  fs.mkdirSync(path.join(media, 'folder.mp4'));
  check((await call('cut:read', path.join(media, 'folder.mp4'), 0, 10))?.code === 'notFile', 'a directory named like a video is not read');
  const secret = write(path.join(work, 'outside', 'secret.txt'), 'password=hunter2');
  check((await call('cut:read', secret, 0, 100))?.code === 'extension', 'a file of a disallowed extension (.txt) is not read');
  check((await call('cut:read', 'media\\Clip One.mp4', 0, 10))?.code === 'badArgs', 'a relative path is refused');
  check((await call('cut:read', 'C:media\\Clip One.mp4', 0, 10))?.code === 'badArgs', 'a drive-relative path (C:media) is refused');
  check((await call('cut:read', `${secret}:hidden.mp4`, 0, 10))?.code === 'badArgs', 'an NTFS stream named like a video (secret.txt:hidden.mp4) is refused');
  check(['.ncut', '.srt', '.vtt', '.cube', '.wav', '.png', '.webm', '.mkv'].every((x) => fs.writeFileSync(path.join(media, `ok${x}`), 'x') || true)
    && (await Promise.all(['.ncut', '.srt', '.vtt', '.cube', '.wav', '.png', '.webm', '.mkv'].map((x) => call('cut:read', path.join(media, `ok${x}`), 0, 1)))).every(isBytes),
  'projects, captions, LUTs and the other media extensions are readable');

  touched.length = 0;
  const attacks = [
    ['a UNC path', '\\\\127.0.0.1\\nothere$\\clip.mp4'],
    ['a UNC path with forward slashes', '//127.0.0.1/nothere$/clip.mp4'],
    ['a \\\\?\\UNC path', '\\\\?\\UNC\\127.0.0.1\\nothere$\\clip.mp4'],
    ['a \\\\.\\ device path', '\\\\.\\PhysicalDrive0'],
    ['a \\\\.\\UNC path', '\\\\.\\UNC\\127.0.0.1\\nothere$\\clip.mp4'],
  ];
  for (const [what, p] of attacks) {
    const r = await call('cut:read', p, 0, 16);
    check(r?.code === 'network', `${what} is refused as a network path (${brief(r)})`);
  }
  check((await call('cut:stat', '\\\\127.0.0.1\\nothere$\\clip.mp4')).code === 'network', 'cut:stat of a UNC path answers network, as missing, without looking');
  check(!networkTouches().length, `no network path reached the file system (${S(networkTouches())})`);
  const longLocal = await call('cut:read', `\\\\?\\${clip}`, 0, 64);
  check(bytesEqual(longLocal, clipBytes.subarray(0, 64)), 'a local \\\\?\\C:\\ long path is read as the local file it is');

  // A link on the way whose target is a share: refused before realpath would open it.
  const linkDir = path.join(media, 'nas');
  fakeLinks.set(linkDir.toLowerCase(), '\\\\127.0.0.1\\videos');
  touched.length = 0;
  const viaLink = await call('cut:read', path.join(linkDir, 'clip.mp4'), 0, 16);
  check(viaLink?.code === 'network' && !touched.some((p) => /realpath|open/.test(p)) && !touched.filter(isUnc).length,
    `a folder that is a link to a network share is refused without following it (${brief(viaLink)}, asked ${S(touched.slice(-4))})`);
  fakeLinks.set(linkDir.toLowerCase(), '\\??\\UNC\\127.0.0.1\\videos');
  check((await call('cut:read', path.join(linkDir, 'clip.mp4'), 0, 16))?.code === 'network', 'a link target in the \\??\\UNC\\ form is refused too');
  fakeLinks.clear();

  // A junction to a folder outside: what is read is decided by the real file behind it.
  const outsideDir = path.join(work, 'outside');
  write(path.join(outsideDir, 'b-roll.mp4'), clipBytes.subarray(0, 1000));
  const junction = path.join(media, 'linked');
  fs.symlinkSync(outsideDir, junction, 'junction');
  check((await call('cut:read', path.join(junction, 'secret.txt'), 0, 100))?.code === 'extension', 'a junction to a folder outside does not open its .txt file');
  check(bytesEqual(await call('cut:read', path.join(junction, 'b-roll.mp4'), 0, 1000), clipBytes.subarray(0, 1000)), 'a video reached through a junction is read (media may be anywhere local)');

  // An 8.3 name whose short extension is allowed while the real file's is not.
  const trick = write(path.join(work, 'outside', 'trick-long-name.mp4x'), 'not media');
  let short = null;
  try { short = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${trick}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim(); } catch {}
  if (short && /\.MP4$/i.test(short) && short.toLowerCase() !== trick.toLowerCase()) {
    const r = await call('cut:read', short, 0, 9);
    check(r?.code === 'extension', `an 8.3 name (${path.basename(short)}) of a .mp4x file is judged by its real name and refused (${brief(r)})`);
  } else skip(`8.3 names are off on this volume (${short}): the short-name check did not run`);

  // ---------- dialogs ----------
  asked.length = 0;
  dialogAnswer = { canceled: false, filePaths: [clip, path.join(media, 'ok.wav')] };
  const picked = await call('cut:pickMedia', { multi: true, title: '미디어 가져오기', filterName: '미디어 파일' });
  check(S(picked) === S([clip, path.join(media, 'ok.wav')]) && asked[0].title === '미디어 가져오기' && asked[0].properties.includes('multiSelections')
    && asked[0].filters[0].name === '미디어 파일' && ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'png', 'jpg'].every((x) => asked[0].filters[0].extensions.includes(x)),
  `cut:pickMedia shows a media dialog with the renderer's title and filter name and returns the paths (${S(asked[0]?.filters?.[0]?.name)})`);
  dialogAnswer = { canceled: true, filePaths: [] };
  check(await call('cut:pickMedia', { multi: false }) === null && !asked[1].properties.includes('multiSelections') && asked[1].title === 'Import Media',
    'cancelled is null; multi: false picks one file; the title falls back to English');
  dialogAnswer = { canceled: false, filePaths: [media] };
  check(await call('cut:pickFolder', {}) === media && asked[2].properties.includes('openDirectory'), 'cut:pickFolder returns the folder');
  dialogAnswer = { canceled: false, filePaths: [path.join(h.projects, 'a.ncut')] };
  check(await call('cut:pickProject') === path.join(h.projects, 'a.ncut') && asked[3].filters[0].extensions[0] === 'ncut' && asked[3].defaultPath === h.projects,
    'cut:pickProject opens in the Projects folder with the .ncut filter');
  dialogAnswer = { canceled: false, filePath: path.join(work, 'exports', 'final') };
  const saved = await call('cut:saveAs', { defaultPath: 'My Video.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }, { name: 'bad', extensions: ['../x'] }] });
  check(saved === path.join(work, 'exports', 'final.mp4') && asked[4].defaultPath === path.join(h.projects, 'My Video.mp4') && asked[4].filters.length === 1,
    `cut:saveAs adds the first filter's extension, puts a bare default name in Projects and drops bad filters (${saved})`);
  const answers = write(path.join(work, 'dialog.json'), S({ pickMedia: [clip], pickFolder: media, saveAs: path.join(work, 'x') }));
  process.env.PYIDE_CUT_DIALOG = answers;
  asked.length = 0;
  check(S(await call('cut:pickMedia')) === S([clip]) && await call('cut:pickFolder') === media && await call('cut:pickProject') === null
    && await call('cut:saveAs', { filters: [{ name: 'SRT', extensions: ['srt'] }] }) === path.join(work, 'x.srt') && !asked.length,
  'PYIDE_CUT_DIALOG answers the dialogs for app tests, without showing any');
  delete process.env.PYIDE_CUT_DIALOG;

  // ---------- projects ----------
  const proj = path.join(h.projects, 'Trip.ncut');
  const v1 = S({ format: 'ncut', version: 1, name: 'first' });
  check(S(await call('cut:projectRead', proj)) === S({ missing: true }), 'cut:projectRead of a project not written yet is {missing: true}');
  const w1 = await call('cut:projectWrite', proj, v1);
  check(w1.ok && fs.readFileSync(proj, 'utf8') === v1 && !fs.existsSync(`${proj}.bak`), `cut:projectWrite writes the project; nothing to keep the first time (${S(w1)})`);
  const r1 = await call('cut:projectRead', proj);
  check(r1.text === v1, 'cut:projectRead returns the text');
  fs.writeFileSync(proj, `\uFEFF${v1}`);
  check((await call('cut:projectRead', proj)).text === v1, 'a byte order mark is dropped on read');
  const v1b = S({ format: 'ncut', version: 1, name: 'second' });
  await call('cut:projectWrite', proj, v1b);
  check(fs.readFileSync(proj, 'utf8') === v1b && !fs.existsSync(`${proj}.bak`), 'a save in the same format version keeps no .bak');
  const v2 = S({ format: 'ncut', version: 2, name: 'migrated' });
  const w2 = await call('cut:projectWrite', proj, v2);
  check(w2.bak === `${proj}.bak` && fs.readFileSync(`${proj}.bak`, 'utf8') === v1b && fs.readFileSync(proj, 'utf8') === v2,
    'a save that changes the format version keeps the previous file as .bak');
  check(!fs.readdirSync(h.projects).some((n) => /\.tmp$/.test(n)), `no temporary files are left (${S(fs.readdirSync(h.projects))})`);
  check((await call('cut:projectWrite', path.join(h.projects, 'evil.bat'), v1))?.code === 'extension' && !fs.existsSync(path.join(h.projects, 'evil.bat')),
    'cut:projectWrite writes .ncut files only');
  check((await call('cut:projectWrite', path.join(h.projects, 'x.ncut'), 'not json'))?.code === 'badArgs', 'a text that is not a project JSON is not written');
  check((await call('cut:projectWrite', path.join(work, 'no-such-folder', 'x.ncut'), v1))?.code === 'missing', 'a project in a folder that does not exist is refused');
  check((await call('cut:projectWrite', '\\\\127.0.0.1\\share$\\x.ncut', v1))?.code === 'network', 'a project on a network path is refused');
  check((await call('cut:projectRead', secret))?.code === 'extension', 'cut:projectRead reads .ncut files only');
  fs.chmodSync(proj, 0o444);
  const locked = await call('cut:projectWrite', proj, S({ format: 'ncut', version: 2, name: 'lost' }));
  fs.chmodSync(proj, 0o666);
  check(locked.code === 'io' && fs.readFileSync(proj, 'utf8') === v2 && !fs.readdirSync(h.projects).some((n) => /\.tmp$/.test(n)),
    `a write that cannot replace the file (read-only) reports an error and leaves the old project whole (${S(locked)})`);

  // ---------- autosave rotation ----------
  const keyA = proj;
  for (let i = 1; i <= 25; i++) await call('cut:autosave', keyA, S({ format: 'ncut', version: 1, n: i }));
  for (let i = 1; i <= 3; i++) await call('cut:autosave', 'untitled-7', S({ format: 'ncut', version: 1, n: i }));
  const auto = fs.readdirSync(h.autosave).filter((n) => n.endsWith('.ncut'));
  const ofA = auto.filter((n) => n.startsWith('Trip-')).sort();
  const ofU = auto.filter((n) => n.startsWith('untitled-7-'));
  const nums = ofA.map((n) => JSON.parse(fs.readFileSync(path.join(h.autosave, n), 'utf8')).n);
  check(ofA.length === 20 && S(nums) === S(Array.from({ length: 20 }, (_, i) => i + 6)), `the 20 newest autosaves of a project are kept, in order (${S(nums)})`);
  check(ofU.length === 3, `another key's autosaves are its own (${ofU.length})`);
  const sameName = path.join(work, 'elsewhere', 'Trip.ncut');
  await call('cut:autosave', sameName, S({ format: 'ncut', version: 1, n: 'other' }));
  check(fs.readdirSync(h.autosave).filter((n) => n.startsWith('Trip-')).length === 21, 'a project of the same name in another folder does not push out the first one\'s autosaves');
  const evil = await call('cut:autosave', '..\\..\\..\\evil', S({ format: 'ncut', version: 1 }));
  check(evil.ok && path.dirname(evil.file) === h.autosave && !fs.existsSync(path.join(work, 'evil.ncut')), `a key with ..\\ stays in the Autosave folder (${evil.file})`);
  check((await call('cut:autosave', '', 'x'))?.code === 'badArgs', 'an empty key is refused');
  // The latest state (the save 2 s after edits) replaces itself and never pushes the interval copies out; copies keep
  // as many as asked.
  const keyL = path.join(work, 'latest', 'Lat.ncut');
  for (let i = 1; i <= 4; i++) await call('cut:autosave', keyL, S({ format: 'ncut', version: 1, n: `c${i}` }), { keep: 3 });
  for (let i = 1; i <= 6; i++) await call('cut:autosave', keyL, S({ format: 'ncut', version: 1, n: `l${i}` }), { latest: true });
  const ofL = fs.readdirSync(h.autosave).filter((n) => n.startsWith('Lat-')).sort();
  const lnums = ofL.map((n) => JSON.parse(fs.readFileSync(path.join(h.autosave, n), 'utf8')).n);
  check(ofL.length === 4 && S(lnums) === S(['c2', 'c3', 'c4', 'l6']) && ofL.filter((n) => n.endsWith('.latest.ncut')).length === 1,
    `copies keep the newest {keep}, the latest state only its newest, and neither pushes out the other (${S(lnums)})`);

  // ---------- sessions and recovery ----------
  const k = (n) => path.join(h.projects, `Session ${n}.ncut`);
  const proj4 = write(k(4), S({ format: 'ncut', version: 1 }));
  await call('cut:sessionStart', k(1)); await call('cut:autosave', k(1), '{"n":1}'); // never ended: the run will be gone
  await call('cut:sessionStart', k(2)); await call('cut:autosave', k(2), '{"n":2}'); await call('cut:sessionEnd', k(2)); // ended cleanly
  await call('cut:sessionStart', k(3)); // never ended, but nothing autosaved
  await call('cut:sessionStart', k(4)); await call('cut:autosave', k(4), '{"n":4}'); await sleep(5); await call('cut:projectWrite', proj4, '{"version":1,"saved":true}'); // saved after
  const w5 = new Sender(5);
  await A.call(w5, 'cut:sessionStart', k(5)); await A.call(w5, 'cut:autosave', k(5), '{"n":5}');
  const w6 = new Sender(6);
  await A.call(w6, 'cut:sessionStart', 'untitled-6'); await A.call(w6, 'cut:autosave', 'untitled-6', '{"n":6}');
  // Another Nano Studio process that is running: its session is not ours to offer.
  write(path.join(h.autosave, '.sessions', `${process.ppid}-feedface-${'0'.repeat(8)}.json`), S({ pid: process.ppid, run: 'feedface', started: Date.now() - 1000, key: k(7), since: Date.now() - 1000 }));
  await call('cut:autosave', k(7), '{"n":7}');
  check(!(await call('cut:recovery')).length, 'while this run lives, its sessions are not offered for recovery');
  w5.close();
  w6.crash();
  await until(async () => (await call('cut:recovery')).some((r) => r.key === 'untitled-6'));
  const sameRun = await call('cut:recovery');
  check(S(sameRun.map((r) => r.key)) === S(['untitled-6']), `a window whose renderer crashed is offered by this run; a window closed normally is not (${S(sameRun.map((r) => r.key))})`);

  const B = start(); // the next start of the app: run A is gone
  const winB = new Sender(11);
  const rec = await B.call(winB, 'cut:recovery');
  const recKeys = rec.map((r) => r.key).sort();
  const newestOf = (key) => fs.readdirSync(h.autosave).filter((n) => n.endsWith('.ncut') && fs.readFileSync(path.join(h.autosave, n), 'utf8') === `{"n":${key}}`);
  check(S(recKeys) === S([k(1), 'untitled-6'].sort()), `after a run that never ended, cut:recovery lists its unfinished sessions only (${S(recKeys)})`);
  const r1rec = rec.find((r) => r.key === k(1));
  check(r1rec && path.basename(r1rec.file) === newestOf(1)[0] && Math.abs(r1rec.time - fs.statSync(r1rec.file).mtimeMs) < 2000,
    `each with its newest autosave and its time (${S(r1rec)})`);
  check(!rec.some((r) => r.key === k(4)), 'a session saved after its last autosave has nothing to recover');
  check(!rec.some((r) => r.key === k(7)), 'a session of another live process is not listed');
  await B.call(winB, 'cut:recoveryDismiss', k(1));
  check(!(await B.call(winB, 'cut:recovery')).some((r) => r.key === k(1)), 'cut:recoveryDismiss removes a recovery offer');
  await B.call(winB, 'cut:sessionStart', 'untitled-6');
  check(!(await B.call(winB, 'cut:recovery')).length, 'starting a session of that key again ends the old offer');
  await B.call(winB, 'cut:sessionEnd', 'untitled-6');

  // ---------- export sink ----------
  const outDir = path.join(work, 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'video.mp4');
  write(out, 'an older export');
  const sink = await call('cut:writeOpen', out);
  check(sink.id && fs.existsSync(`${out}.part`) && fs.readFileSync(out, 'utf8') === 'an older export', `cut:writeOpen writes <path>.part and leaves the final file alone meanwhile (${S(sink)})`);
  const chunks = Array.from({ length: 60 }, (_, i) => Buffer.alloc(1000 + i, i + 1));
  const pending = chunks.map((c) => call('cut:writeAt', sink.id, new Uint8Array(c)));
  pending.push(call('cut:writeAt', sink.id, new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]), 0));
  const writes = await Promise.all(pending);
  const foreign = await A.call(other, 'cut:writeAt', sink.id, new Uint8Array([1]), 0);
  check(foreign.code === 'badArgs', 'another window cannot write to the sink');
  check((await call('cut:writeAt', sink.id, new Uint8Array(4), -1)).code === 'badArgs' && (await call('cut:writeAt', sink.id, 'text')).code === 'badArgs', 'a bad position or something that is not bytes is refused');
  const closed = await call('cut:writeClose', sink.id, { commit: true });
  const expected = Buffer.concat(chunks);
  expected.set([0xaa, 0xbb, 0xcc, 0xdd], 0);
  check(writes.every((w) => w.ok) && closed.ok && closed.path === out && closed.bytes === expected.length && bytesEqual(fs.readFileSync(out), expected) && !fs.existsSync(`${out}.part`),
    `appends sent without waiting land in order, a positional write overwrites, commit replaces the final file (${S(closed)})`);
  check((await call('cut:writeAt', sink.id, new Uint8Array(1))).code === 'badArgs', 'a closed sink takes no more writes');
  const ab = await call('cut:writeOpen', path.join(outDir, 'aborted.mp4'));
  await call('cut:writeAt', ab.id, new Uint8Array(100));
  check((await A.call(other, 'cut:writeClose', ab.id, { commit: true })).code === 'badArgs', 'another window cannot close the sink');
  const abClosed = await call('cut:writeClose', ab.id, { commit: false });
  check(abClosed.ok && abClosed.aborted && !fs.existsSync(path.join(outDir, 'aborted.mp4')) && !fs.existsSync(path.join(outDir, 'aborted.mp4.part')), 'an aborted export leaves no file');
  // the target open in a player (no delete sharing): the finished file is kept as .part, not deleted with the render
  {
    const held = path.join(outDir, 'held.mp4');
    write(held, 'playing in a player');
    const { spawn } = await import('child_process');
    const ps = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${held.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); 'held'; Start-Sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => { ps.stdout.on('data', (d) => { if (/held/.test(String(d))) r(); }); setTimeout(r, 15000); });
    const hs = await call('cut:writeOpen', held);
    await call('cut:writeAt', hs.id, new Uint8Array(2000).fill(7));
    const hc = await call('cut:writeClose', hs.id, { commit: true });
    ps.kill();
    await new Promise((r) => ps.once('exit', r));
    const kept = hc.part && fs.existsSync(hc.part) ? fs.statSync(hc.part).size : 0;
    check(hc.code === 'busy' && kept === 2000 && fs.readFileSync(held, 'utf8') === 'playing in a player', `a target held open keeps the finished file as .part (${S({ code: hc.code, part: hc.part && path.basename(hc.part), kept })})`);
    if (hc.part) fs.rmSync(hc.part, { force: true });
  }
  const w8 = new Sender(8);
  const left = await A.call(w8, 'cut:writeOpen', path.join(outDir, 'left.mp4'));
  await A.call(w8, 'cut:writeAt', left.id, new Uint8Array(500));
  w8.close();
  check(await until(() => !fs.existsSync(path.join(outDir, 'left.mp4.part'))), 'closing the window removes its open part files');
  const crashedWin = new Sender(9);
  const left2 = await A.call(crashedWin, 'cut:writeOpen', path.join(outDir, 'left2.mp4'));
  crashedWin.crash();
  check(left2.id && await until(() => !fs.existsSync(path.join(outDir, 'left2.mp4.part'))), 'a crashed renderer\'s part files are removed too');
  check((await call('cut:writeOpen', path.join(outDir, 'run.exe'))).code === 'extension' && (await call('cut:writeOpen', path.join(outDir, 'run.bat'))).code === 'extension',
    'the export sink writes media, frames and captions only, not programs');
  check((await call('cut:writeOpen', '\\\\127.0.0.1\\share$\\v.mp4')).code === 'network', 'the export sink refuses network paths');
  check((await call('cut:writeOpen', path.join(work, 'nowhere', 'v.mp4'))).code === 'missing', 'the export sink refuses a folder that does not exist');
  const twice = await call('cut:writeOpen', path.join(outDir, 'twice.mp4'));
  check((await call('cut:writeOpen', path.join(outDir, 'twice.mp4'))).code === 'busy', 'one file cannot be opened by two sinks at once');
  await call('cut:writeClose', twice.id, {});
  // A run that crashed with a sink open: the next start removes its part file (and only a .part file).
  const deadPart = write(path.join(outDir, 'crashed.mp4.part'), 'half');
  const notPart = write(path.join(outDir, 'keep.mp4'), 'mine');
  write(path.join(userData, 'cut-exports', '4000000-0badc0de.json'), S({ pid: 4000000, run: '0badc0de', started: Date.now() - 5000, parts: [deadPart, notPart] }));
  start();
  check(await until(() => !fs.existsSync(deadPart)) && fs.existsSync(notPart) && !fs.existsSync(path.join(userData, 'cut-exports', '4000000-0badc0de.json')),
    'the part files a crashed run left are removed at the next start, and nothing else it listed');

  // ---------- faststart ----------
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const box = (type, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
  const box64 = (type, body) => Buffer.concat([u32(1), Buffer.from(type, 'latin1'), u64(16 + body.length), body]);
  const trak = (chunkBox) => box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('mdhd', Buffer.alloc(24)), box('hdlr', Buffer.alloc(25)),
    box('minf', box('vmhd', Buffer.alloc(12)), box('stbl', box('stsd', u32(0), u32(0)), box('stts', u32(0), u32(0)), box('stsc', u32(0), u32(0)), box('stsz', u32(0), u32(0), u32(0)), chunkBox))));
  // Two tracks' chunks interleaved in the mdat, each chunk's bytes unique: a moved offset that is wrong reads others.
  function movie({ wideMdat, gapBox }) {
    const ftyp = box('ftyp', 'isom', u32(512), 'isomiso2avc1mp41');
    const pre = gapBox ? box('wide') : Buffer.alloc(0);
    const chunkList = [];
    for (let i = 0; i < 12; i++) for (const t of [1, 2]) chunkList.push({ t, bytes: Buffer.from(`T${t}C${i}:`.padEnd(40 + i * 3 + t * 5, String.fromCharCode(65 + ((i * 2 + t) % 26)))) });
    const body = Buffer.concat(chunkList.map((c) => c.bytes));
    const mdatStart = ftyp.length + pre.length;
    const hdr = wideMdat ? 16 : 8;
    let pos = mdatStart + hdr;
    for (const c of chunkList) { c.offset = pos; pos += c.bytes.length; }
    const mdat = wideMdat ? box64('mdat', body) : box('mdat', body);
    const offs = (t) => chunkList.filter((c) => c.t === t).map((c) => c.offset);
    const moov = box('moov', box('mvhd', Buffer.alloc(100)), trak(box('stco', u32(0), u32(12), ...offs(1).map(u32))), trak(box('co64', u32(0), u32(12), ...offs(2).map(u64))), box('udta', box('free', 'x')));
    return { bytes: Buffer.concat([ftyp, pre, mdat, box('free', 'between'), moov]), chunkList, moovSize: moov.length };
  }
  const topLevel = (b) => { const out = []; for (let p = 0; p < b.length;) { let s = b.readUInt32BE(p); if (s === 1) s = Number(b.readBigUInt64BE(p + 8)); else if (s === 0) s = b.length - p; out.push({ type: b.toString('latin1', p + 4, p + 8), start: p, size: s }); p += s; } return out; };
  const chunkTables = (b, at, end, found = []) => {
    for (let p = at; p < end;) {
      const s = b.readUInt32BE(p); const type = b.toString('latin1', p + 4, p + 8);
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) chunkTables(b, p + 8, p + s, found);
      else if (type === 'stco' || type === 'co64') {
        const n = b.readUInt32BE(p + 12);
        found.push({ type, offsets: Array.from({ length: n }, (_, i) => (type === 'co64' ? Number(b.readBigUInt64BE(p + 16 + i * 8)) : b.readUInt32BE(p + 16 + i * 4))) });
      }
      p += s;
    }
    return found;
  };
  for (const variant of [{ wideMdat: true, gapBox: false }, { wideMdat: false, gapBox: true }]) {
    const m = movie(variant);
    const file = write(path.join(outDir, `movie-${variant.wideMdat ? '64' : '32'}.mp4`), m.bytes);
    const r = await call('cut:faststart', file);
    const outBytes = fs.readFileSync(file);
    const tops = topLevel(outBytes);
    const order = tops.map((b) => b.type);
    const moovBox = tops.find((b) => b.type === 'moov');
    const tables = chunkTables(outBytes, moovBox.start, moovBox.start + moovBox.size);
    const expectedChunks = (t) => m.chunkList.filter((c) => c.t === t).map((c) => c.bytes);
    const pointsRight = tables.length === 2 && [1, 2].every((t) => tables[t - 1].offsets.every((o, i) => bytesEqual(outBytes.subarray(o, o + expectedChunks(t)[i].length), expectedChunks(t)[i])));
    const mdatBox = tops.find((b) => b.type === 'mdat');
    const mdatOld = topLevel(m.bytes).find((b) => b.type === 'mdat');
    check(r.ok && r.moved && S(order) === S(variant.gapBox ? ['ftyp', 'wide', 'moov', 'mdat', 'free'] : ['ftyp', 'moov', 'mdat', 'free']),
      `faststart (${variant.wideMdat ? '64-bit' : '32-bit'} mdat size) puts the moov before the mdat (${S(order)})`);
    check(pointsRight && tables[0].type === 'stco' && tables[1].type === 'co64', `every stco and co64 chunk offset still points at its chunk's bytes (${variant.wideMdat ? '64' : '32'}-bit mdat)`);
    check(outBytes.length === m.bytes.length && bytesEqual(outBytes.subarray(mdatBox.start, mdatBox.start + mdatBox.size), m.bytes.subarray(mdatOld.start, mdatOld.start + mdatOld.size)),
      'the file keeps its size and the mdat its bytes');
    check(!fs.readdirSync(outDir).some((n) => /\.tmp$/.test(n)), 'faststart leaves no temporary file');
    const again = await call('cut:faststart', file);
    check(again.ok && again.already && bytesEqual(fs.readFileSync(file), outBytes), 'a file already in faststart order is left as it is');
  }
  const broken = movie({ wideMdat: true });
  const brokenBytes = Buffer.from(broken.bytes);
  brokenBytes.writeUInt32BE(0x7fffffff, brokenBytes.length - broken.moovSize);
  const brokenFile = write(path.join(outDir, 'broken.mp4'), brokenBytes);
  const br = await call('cut:faststart', brokenFile);
  check(br.code === 'damaged' && bytesEqual(fs.readFileSync(brokenFile), brokenBytes), `a moov whose size does not fit the file is reported damaged and the file is untouched (${S(br)})`);
  check((await call('cut:faststart', path.join(media, 'ok.png'))).code === 'extension', 'faststart works on MP4-family files only');
  // An stco whose shifted offsets pass 4 GiB becomes a co64; one that still fits stays an stco.
  const nearTop = 0xffffff00;
  const moovIn = box('moov', trak(box('stco', u32(0), u32(2), u32(nearTop), u32(0x10))), trak(box('stco', u32(0), u32(1), u32(0x20))));
  const moovOut = rewriteMoov(moovIn, (o) => o + 0x200);
  const outTables = chunkTables(moovOut, 0, moovOut.length);
  check(S(outTables) === S([{ type: 'co64', offsets: [nearTop + 0x200, 0x210] }, { type: 'stco', offsets: [0x220] }]) && moovOut.readUInt32BE(0) === moovOut.length
    && moovOut.length === moovIn.length + 8, `stco offsets that overflow 32 bits are rewritten as co64 and every box size follows (${S(outTables)})`);

  // ---------- cache ----------
  const setLimit = (bytes) => fs.writeFileSync(settingsFile, S({ 'cut.cacheLimitGB': bytes / 1024 ** 3 }));
  setLimit(1000);
  const blob = (n) => new Uint8Array(300).fill(n);
  await call('cut:cachePut', 'thumb:a', blob(1));
  await call('cut:cachePut', 'thumb:b', blob(2));
  await call('cut:cachePut', 'thumb:c', blob(3));
  check(bytesEqual(await call('cut:cacheGet', 'thumb:a'), blob(1)), 'cut:cacheGet returns what cut:cachePut stored (and counts as a use)');
  check(await call('cut:cacheGet', 'thumb:none') === null, 'a key not in the cache is null');
  await call('cut:cachePut', 'thumb:d', blob(4));
  // One read after another: each read is a use, and the order of uses is what the restart below checks.
  const present = async (keys, at = call) => { const out = []; for (const key of keys) out.push(!!(await at('cut:cacheGet', key))); return out; };
  const info = await call('cut:cacheInfo');
  check(S(await present(['thumb:a', 'thumb:b', 'thumb:c', 'thumb:d'])) === S([true, false, true, true]) && info.bytes === 900 && info.files === 3 && info.limit === 1000,
    `above the limit the least recently used entry goes first: b, not a, which was read since (${S(info)})`);
  // a was written first but is now the latest use: only a use order kept in the files makes c the oldest after a restart.
  await call('cut:cacheGet', 'thumb:a');
  const C = start(); // a restart: the order comes back from the files
  const cCall = (name, ...args) => C.call(win, name, ...args);
  await cCall('cut:cacheGet', 'thumb:d');
  await cCall('cut:cachePut', 'thumb:e', blob(5));
  const afterRestart = await present(['thumb:a', 'thumb:c', 'thumb:d', 'thumb:e'], cCall);
  check(S(afterRestart) === S([true, false, true, true]), `after a restart the use order is read back from the files: c went first, not a, which was written first (${S(afterRestart)})`);
  check((await cCall('cut:cachePut', 'thumb:huge', new Uint8Array(2000))).code === 'tooLarge', 'an entry larger than the whole limit is not stored');
  setLimit(10 * 1024 ** 3);
  check((await cCall('cut:cacheInfo')).limit === 10 * 1024 ** 3, 'the limit follows the cut.cacheLimitGB setting');
  fs.writeFileSync(settingsFile, '{}');
  check((await cCall('cut:cacheInfo')).limit === 10 * 1024 ** 3, 'without the setting the limit is 10 GB');
  const cleared = await cCall('cut:cacheClear');
  check(cleared.ok && cleared.files === 0 && cleared.bytes === 0 && await cCall('cut:cacheGet', 'thumb:e') === null, 'cut:cacheClear empties the cache');

  // ---------- findMedia and listMedia ----------
  const lib = path.join(work, 'library');
  let deep = lib;
  for (let i = 1; i <= 9; i++) { deep = path.join(deep, `level${i}`); write(path.join(deep, `at-depth-${i}.mp4`), Buffer.alloc(i)); }
  write(path.join(lib, 'Shoot', 'B Roll.MOV'), Buffer.alloc(77));
  write(path.join(lib, 'Other', 'B Roll.mov'), Buffer.alloc(78));
  write(path.join(lib, 'notes.txt'), 'x');
  fs.symlinkSync(lib, path.join(lib, 'Shoot', 'loop'), 'junction');
  fs.symlinkSync(path.join(work, 'outside'), path.join(lib, 'away'), 'junction');
  const found = await call('cut:findMedia', lib, [{ name: 'b roll.mov', size: 78 }, { name: 'at-depth-3.mp4', size: 3 }, { name: 'at-depth-9.mp4', size: 9 }, { name: 'b-roll.mp4' }, { name: 'at-depth-2.mp4', size: 99 }]);
  check(found['b roll.mov'] === path.join(lib, 'Other', 'B Roll.mov') && found['at-depth-3.mp4'] === path.join(lib, 'level1', 'level2', 'level3', 'at-depth-3.mp4'),
    `cut:findMedia finds files by name in any case and by size, in subfolders (${S(found)})`);
  check(!('at-depth-9.mp4' in found) && !('b-roll.mp4' in found) && !('at-depth-2.mp4' in found),
    'it goes 8 folders deep, does not follow junctions out of the folder, and a wrong size is no match');
  check((await call('cut:findMedia', '\\\\127.0.0.1\\share$', [{ name: 'a.mp4' }])).code === 'network' && (await call('cut:findMedia', clip, [])).code === 'notFile',
    'cut:findMedia refuses network paths and files');
  const listed = await call('cut:listMedia', lib);
  check(listed.files.length === 10 && !listed.truncated && listed.files.every((f) => !/notes\.txt|loop|away/.test(f.rel)) && listed.files.some((f) => f.rel === path.join('Shoot', 'B Roll.MOV') && f.size === 77),
    `cut:listMedia lists the media files with their relative paths, 8 folders deep, not through junctions (${listed.files.length})`);

  // ---------- fonts ----------
  const t0 = Date.now();
  const families = await call('cut:fonts');
  const took = Date.now() - t0;
  const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts').toLowerCase();
  const malgun = Array.isArray(families) && families.find((f) => f.family === 'Malgun Gothic');
  check(malgun && malgun.localName === '맑은 고딕' && malgun.styles.some((s) => s.weight === 400 && !s.italic) && malgun.styles.some((s) => s.weight === 700)
    && malgun.styles.every((s) => s.file.toLowerCase().startsWith(winFonts)), `cut:fonts reads C:\\Windows\\Fonts and finds Malgun Gothic (맑은 고딕) with its weights (${S(malgun)})`);
  const segoe = families.find((f) => f.family === 'Segoe UI');
  check(families.length > 20 && segoe?.styles.some((s) => s.italic && s.weight === 700) && segoe.styles.some((s) => s.style === 'Semibold' && s.weight === 600),
    `families group their styles by typographic name with weight and italic (${families.length} families, ${took} ms)`);
  check(await call('cut:fonts') === families || S(await call('cut:fonts')) === S(families), 'the font list is cached for the run');
  const regular = malgun.styles.find((s) => s.weight === 400);
  const data = await call('cut:fontData', regular.file, regular.index);
  check(isBytes(data) && data.length === fs.statSync(regular.file).size && data[0] === 0 && data[1] === 1, `cut:fontData returns the font file (${data?.length} bytes)`);
  const ttcFace = families.flatMap((f) => f.styles.map((s) => ({ ...s, family: f.family }))).find((s) => s.index > 0 && /\.ttc$/i.test(s.file));
  if (ttcFace) {
    const one = await call('cut:fontData', ttcFace.file, ttcFace.index);
    const parsed = isBytes(one) ? await fontsModule.faces(fontsModule.bufferReader(Buffer.from(one))) : [];
    check(parsed.length === 1 && parsed[0].family === ttcFace.family && parsed[0].weight === ttcFace.weight, `a face inside a collection (${path.basename(ttcFace.file)} #${ttcFace.index}, ${ttcFace.family}) is served as a font file of its own`);
  } else skip('no font collection with a second face here');
  const copied = path.join(work, 'outside', 'copy.ttf');
  fs.copyFileSync(regular.file, copied);
  check((await call('cut:fontData', copied, 0)).code === 'outside', 'cut:fontData serves the font folders only');
  check((await call('cut:fontData', path.join(path.dirname(regular.file), '..', 'win.ini'), 0)).code === 'extension', 'cut:fontData serves font files only');
  // A font folder holding a junction to outside: not listed, not served.
  const fakeFonts = path.join(work, 'fonts');
  fs.mkdirSync(fakeFonts);
  fs.copyFileSync(regular.file, path.join(fakeFonts, 'mine.ttf'));
  fs.symlinkSync(path.join(work, 'outside'), path.join(fakeFonts, 'escape'), 'junction');
  process.env.PYIDE_CUT_FONT_DIRS = S([fakeFonts]);
  const D = start();
  delete process.env.PYIDE_CUT_FONT_DIRS;
  const fakeList = await D.call(win, 'cut:fonts');
  check(fakeList.length === 1 && fakeList[0].family === 'Malgun Gothic' && fakeList[0].styles[0].file === path.join(fakeFonts, 'mine.ttf'), `the fonts of another folder are listed (${S(fakeList.map((f) => f.family))})`);
  check(isBytes(await D.call(win, 'cut:fontData', path.join(fakeFonts, 'mine.ttf'), 0)) && (await D.call(win, 'cut:fontData', path.join(fakeFonts, 'escape', 'copy.ttf'), 0)).code === 'outside',
    'a font reached through a junction out of the font folder is refused');

  // ---------- reveal ----------
  shown.length = 0;
  check((await call('cut:reveal', clip)).ok && shown[0] === clip, 'cut:reveal shows the file in Explorer');
  check((await call('cut:reveal', path.join(media, 'gone.mp4'))).missing && (await call('cut:reveal', '\\\\127.0.0.1\\share$\\a.mp4')).code === 'network' && shown.length === 1,
    'cut:reveal of a missing file or a network path shows nothing');
  check(!networkTouches().length, `no network path reached the file system in the whole run (${S(networkTouches())})`);
} catch (err) {
  check(false, `the suite ran to the end (${err.stack})`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`FAIL ${r.label}`);
process.exitCode = passed === results.length ? 0 : 1;
