// The Minecraft content pipeline under hostile input, offline against a local stand-in for Mojang, Fabric and
// Modrinth: what is dropped on the Minecraft window (truncated, empty and misnamed archives, zip-slip entries, zip
// bombs, huge entry counts, names with Korean, emoji, quotes, & and %, paths past MAX_PATH, hundreds of files at once,
// folders that only half look like a server, a world named like the server's own), modpacks (.mrpack files whose
// index points outside the server folder, lacks or breaks checksums, repeats paths, names unknown loaders, and Modrinth
// projects whose answer is broken, hostile or never comes), and the Market (a search that fails, hangs or answers
// nonsense, dependency cycles, a dependency with no version, the same and different projects installed at the same
// time, hostile file names, removal of what was deleted by hand, a server folder deleted under it). For each: a clear
// message, no IDE internal error or renderer exception, nothing written outside the server folder, no temporary file
// left, and the window still usable. CDP port 8610.
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const work = mkdtempSync(path.join(tmpdir(), 'pyide-stress-mc-'));
const write = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); return file; };
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- zips, hostile ones included ----------
// entries: {name, data} (deflated), {name, data, method: 0} (stored), or {name, packed, size, crc, method, flags} as
// given; `overlap` more directory records point at the last entry's data (the overlapping-entries zip bomb).
function zipOf(entries, { overlap = 0 } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  let count = 0;
  const record = (name, e, at) => {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.alloc(46);
    d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt16LE(e.flags ?? 0x800, 8); d.writeUInt16LE(e.method, 10);
    d.writeUInt32LE(e.crc >>> 0, 16); d.writeUInt32LE(e.packed.length, 20); d.writeUInt32LE(e.size >>> 0, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(at, 42);
    central.push(d, n);
    count++;
  };
  let last = null;
  for (const raw of entries) {
    const e = raw.packed ? { crc: 0, ...raw } : { name: raw.name, method: raw.method ?? 8, size: raw.data.length, crc: zlib.crc32(raw.data),
      packed: (raw.method ?? 8) === 0 ? raw.data : zlib.deflateRawSync(raw.data) };
    const n = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(e.flags ?? 0x800, 6); h.writeUInt16LE(e.method, 8);
    h.writeUInt32LE(e.crc >>> 0, 14); h.writeUInt32LE(e.packed.length, 18); h.writeUInt32LE(e.size >>> 0, 22); h.writeUInt16LE(n.length, 26);
    locals.push(h, n, e.packed);
    record(e.name, e, offset);
    last = { e, at: offset };
    offset += 30 + n.length + e.packed.length;
  }
  for (let i = 0; i < overlap; i++) record(`${last.e.name}.${i}`, last.e, last.at);
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
// A deflate stream of `mb` MiB of zeros from about 1 KB per MiB: sync-flushed blocks concatenate, and 03 00 ends it.
const ZERO_MB = zlib.deflateRawSync(Buffer.alloc(1 << 20), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
const zeros = (mb) => Buffer.concat([...Array(mb).fill(ZERO_MB), Buffer.from([3, 0])]);
const bombEntry = (name, mb, declared = mb * 1048576) => ({ name, method: 8, packed: zeros(mb), size: declared });
const mcmeta = { name: 'pack.mcmeta', data: Buffer.from('{"pack": {"pack_format": 15, "description": "stress"}}') };
const pluginJar = (name = 'X') => zipOf([{ name: 'plugin.yml', data: Buffer.from(`name: ${name}\nmain: x.${name}\nversion: 1\n`) }]);
const fabricModJar = () => zipOf([{ name: 'fabric.mod.json', data: Buffer.from('{"id": "x"}') }]);
const paperJar = zipOf([{ name: 'META-INF/versions.list', data: Buffer.from('abc\t1.20.1\tpaper-1.20.1.jar\n') }]);
const fabricServerJar = zipOf([{ name: 'net/fabricmc/installer/ServerLauncher.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }]);
const mrpackOf = (index, extra = []) => zipOf([{ name: 'modrinth.index.json', data: Buffer.from(typeof index === 'string' ? index : S(index)) }, ...extra]);

// ---------- the stand-in services ----------
const HANG = Symbol('hang');
const routes = new Map(); // path -> body | (url) => body | {status, body} | {delay, body} | HANG
const requests = [];
const hung = [];
const server = http.createServer(async (q, r) => {
  requests.push(decodeURIComponent(q.url));
  let route = routes.get(decodeURIComponent(q.url.split('?')[0]));
  if (typeof route === 'function') route = route(decodeURIComponent(q.url));
  if (route === undefined) { r.writeHead(404); return r.end(); }
  if (route === HANG) { hung.push(r); return; }
  if (route?.delay) { await sleep(route.delay); route = route.body; }
  if (route?.status) { r.writeHead(route.status); return r.end(route.body ?? ''); }
  r.writeHead(200);
  r.end(Buffer.isBuffer(route) ? route : typeof route === 'string' ? route : S(route));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const served = (name, data) => { routes.set(`/files/${name}`, data); return `${base}/files/${encodeURIComponent(name)}`; };
routes.set('/mojang/manifest.json', { latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: `${base}/mojang/1.20.1.json` }] });
routes.set('/mojang/1.20.1.json', { javaVersion: { majorVersion: 17 } });
routes.set('/fabric/versions/installer', [{ version: '1.0.0', stable: true }]);
routes.set('/fabric/versions/loader/1.20.1/0.15.0/1.0.0/server/jar', fabricServerJar);

// ---------- the project: a Fabric, a Paper and a resource-pack server, described as PyIDE describes them ----------
const project = path.join(work, 'project');
const outside = path.join(work, 'outside');
const escape = path.join(work, 'escape');
mkdirSync(escape, { recursive: true });
const serverDir = (name) => path.join(project, 'servers', name);
const describe = (name, desc) => write(path.join(serverDir(name), 'pyide-server.json'), `${S({ build: null, java: 17, memory: '2G', launch: { jar: 'server.jar' }, mdk: null, ...desc }, null, 2)}\n`);
describe('fab', { kind: 'fabric', mc: '1.20.1', loader: '0.15.0', launch: { jar: 'fabric-server-mc.1.20.1-loader.0.15.0-launcher.1.0.jar' } });
write(path.join(serverDir('fab'), 'fabric-server-mc.1.20.1-loader.0.15.0-launcher.1.0.jar'), fabricServerJar);
write(path.join(serverDir('fab'), 'server.properties'), 'server-port=25661\n');
mkdirSync(path.join(serverDir('fab'), 'mods'));
describe('pap', { kind: 'paper', mc: '1.20.1' });
write(path.join(serverDir('pap'), 'server.properties'), 'server-port=25662\nlevel-name=world\n');
write(path.join(serverDir('pap'), 'world', 'level.dat'), 'the server\'s own world');
mkdirSync(path.join(serverDir('pap'), 'plugins'));
describe('rp', { kind: 'paper', mc: '1.20.1' });
const sentinel = write(path.join(work, 'sentinel.txt'), 'must survive');

// Files anywhere under the work folder (or next to the temporary folder) that an attack meant to write.
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
// The names the attacks use all start with evil-; beside the temporary folder only those not there before count.
const ROOTS = [path.join(tmpdir(), '..'), tmpdir(), path.parse(tmpdir()).root];
const evilIn = (d) => { try { return readdirSync(d).filter((n) => /^evil-/i.test(n)).map((n) => path.join(d, n)); } catch { return []; } };
const evilBefore = new Set(ROOTS.flatMap(evilIn));
const escaped = () => [...walk(work).filter((p) => /^evil-/i.test(path.basename(p)) && !p.startsWith(outside + path.sep)), ...ROOTS.flatMap(evilIn).filter((p) => !evilBefore.has(p))];
// Downloads of this suite left in %TEMP% (pyide-<hex>-<name>).
const tempBefore = new Set(readdirSync(tmpdir()));
const tempLeft = () => readdirSync(tmpdir()).filter((n) => /^pyide-[0-9a-f]{8}-/.test(n) && !tempBefore.has(n));
const sizeOf = (dir) => (existsSync(dir) ? walk(dir).reduce((s, p) => s + statSync(p).size, 0) : 0);
const desc = (name) => JSON.parse(readFileSync(path.join(serverDir(name), 'pyide-server.json'), 'utf8'));

// What a direct module check needs (sources.js reads PYIDE_MC_SOURCES on every call).
{
  const saved = process.env.PYIDE_MC_SOURCES;
  process.env.PYIDE_MC_SOURCES = S({ modrinth: `${base}/modrinth//`, paper: 5 });
  const sources = require('../main/minecraft/sources.js');
  var unit = { api: sources.modrinthApi(), paperOk: typeof sources.KINDS.paper.versions === 'function' };
  unit.refused = await sources.getJson('http://127.0.0.1:9/x').then(() => null, (e) => ({ message: e.message, expected: e.expected }));
  process.env.PYIDE_MC_SOURCES = 'not json';
  unit.fallback = sources.modrinthApi();
  if (saved === undefined) delete process.env.PYIDE_MC_SOURCES; else process.env.PYIDE_MC_SOURCES = saved;
}

const t = await launch({ name: 'stress-minecraft-content', port: 8610, projectDir: project, env: {
  PYIDE_MC_SOURCES: S({ mojang: `${base}/mojang/manifest.json`, fabric: `${base}/fabric`, paper: `${base}/paper`, forge: `${base}/forge`, forgePromos: `${base}/forge/promos.json`,
    neoforge: `${base}/neoforge`, purpur: `${base}/purpur`, velocity: `${base}/velocity`, adoptium: `${base}/adoptium`, modrinth: `${base}/modrinth` }),
} });
const { js, until, check, cdp } = t;
// An IPC call from the window: {ok} or {err} with the message the window shows.
const call = (channel, ...args) => js(`ide.api.invoke(${S(channel)}, ${args.map((a) => (a === ROOT ? 'ide.root' : S(a))).join(', ')})
  .then((ok) => ({ ok }), (e) => ({ err: ide.util.errorText(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))`);
const ROOT = Symbol('root');
const drop = (dir, paths) => call('minecraft:drop', ROOT, dir, paths, 'stress');
const info = (src) => call('minecraft:modpackInfo', ROOT, src, 'stress');
const fromPack = (opts) => call('minecraft:createFromModpack', { root: project, eula: true, memory: '2G', port: 25670, ...opts }, 'stress');
const install = (dir, id, type = 'mod') => call('minecraft:marketInstall', ROOT, dir, { id, type }, 'stress');
const remove = (dir, id) => call('minecraft:marketRemove', ROOT, dir, id);
const internal = () => js(`ide.api.invoke('diagnostics:errors').then((l) => l.map((e) => e.message))`);
const skippedOf = (r, name) => r.ok?.skipped.find((s) => s.name === name);
const card = (name) => `document.querySelector('#minecraftTool .mc-server[data-name="${name}"]')`;
const runTab = (title) => `ide.run.sessions().find((s) => s.title === ${S(title)})`;
const tabText = (title) => js(`${runTab(title)}?.host.textContent || ''`);
// A real drag of files from outside (CDP, with their paths) onto an element of the window.
const dragOn = async (target, files) => {
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);
  const box = await js(`(() => { const n = ${target}; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); const x = r.x + 20, y = r.y + 10; return { x, y, hit: n.contains(document.elementFromPoint(x, y)) }; })()`);
  if (!box.hit) throw new Error(`the drop point is not on ${target}`);
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
};
const timed = async (step) => { const at = Date.now(); const r = await step(); return { r, ms: Date.now() - at }; };

try {
  await js(`(ide.toolWindows.get('Minecraft').show(), true)`);
  await until(`!!${card('pap')} && !!${card('fab')}`, 'server cards');

  // ---------- sources ----------
  check(unit.api === `${base}/modrinth` && unit.paperOk && unit.fallback === 'https://api.modrinth.com/v2',
    `PYIDE_MC_SOURCES: trailing slashes are dropped, non-text values ignored, malformed JSON falls back (${S(unit)})`);
  check(unit.refused?.expected && /127\.0\.0\.1:9\/x: /.test(unit.refused.message) && !/fetch failed$/.test(unit.refused.message),
    `an unreachable service gives a readable, expected error (${S(unit.refused)})`);

  // ---------- archives ----------
  const plugin = write(path.join(outside, 'good-plugin.jar'), pluginJar('Good'));
  const truncated = write(path.join(outside, 'truncated-plugin.jar'), pluginJar('Cut').subarray(0, 40));
  const truncPack = write(path.join(outside, 'truncated.mrpack'), mrpackOf({ dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' } }).subarray(0, 60));
  const empties = ['empty.jar', 'empty.zip', 'empty.mrpack', 'empty'].map((n) => write(path.join(outside, n), ''));
  const hugeDir = Buffer.alloc(22); hugeDir.writeUInt32LE(0x06054b50, 0); hugeDir.writeUInt16LE(1, 10); hugeDir.writeUInt32LE(0xfffffff0, 12);
  const liar = write(path.join(outside, 'huge-directory.zip'), hugeDir);
  const packAsJar = write(path.join(outside, 'resource-pack.jar'), zipOf([mcmeta]));
  const pluginAsZip = write(path.join(outside, 'plugin-as.zip'), pluginJar('Zip'));
  const upper = write(path.join(outside, 'UPPER.JAR'), pluginJar('Upper'));
  let r = await drop(serverDir('pap'), [plugin, truncated, truncPack, ...empties, liar, packAsJar, pluginAsZip, upper]);
  const plugins = () => readdirSync(path.join(serverDir('pap'), 'plugins'));
  check(r.ok && S(plugins().sort()) === S(['UPPER.JAR', 'good-plugin.jar'])
    && ['truncated-plugin.jar', 'empty.jar', 'empty.zip', 'empty', 'huge-directory.zip', 'resource-pack.jar', 'plugin-as.zip'].every((n) => skippedOf(r, n)?.why === 'unknown')
    && S(r.ok.modpacks) === S([truncPack, empties[2]]),
  `truncated, empty and misnamed archives are skipped as unknown, the good plugins added (${S(r)})`);
  const truncInfo = await info({ file: truncPack });
  const emptyInfo = await info({ file: empties[2] });
  check(/is not a Modrinth modpack/.test(truncInfo.err) && /is not a Modrinth modpack/.test(emptyInfo.err), `a truncated or empty .mrpack: a clear error (${truncInfo.err} | ${emptyInfo.err})`);

  // zip-slip entries in a dropped resource pack
  const abs = path.join(escape, 'evil-3.txt').replace(/\\/g, '/');
  const slip = write(path.join(outside, 'slip.zip'), zipOf([mcmeta, ...['../evil-1.txt', '..\\evil-2.txt', abs, '/evil-4.txt', 'assets/../../evil-5.txt', 'evil-6.txt:stream', 'Z:evil-7.txt',
    `\\\\?\\${path.join(escape, 'evil-8.txt')}`, 'assets/minecraft/ok.txt'].map((name) => ({ name, data: Buffer.from('x') }))]));
  r = await drop(serverDir('pap'), [slip]);
  const rpPap = path.join(serverDir('pap'), 'resourcepack');
  check(r.ok?.done[0]?.what === 'resourcepack' && existsSync(path.join(rpPap, 'pack.mcmeta')) && existsSync(path.join(rpPap, 'assets', 'minecraft', 'ok.txt'))
    && !escaped().length && !readdirSync(escape).length && S(readdirSync(rpPap).sort()) === S(['assets', 'pack.mcmeta']),
  `zip-slip entries (.., \\, absolute, drive, UNC, ADS) are not written; the pack's own files are (${S(escaped())} ${S(readdirSync(rpPap))})`);

  // zip bombs: overlapping entries declaring 6.4 GB; an entry inflating far past what it declares; a huge one
  const bomb = write(path.join(outside, 'bomb.zip'), zipOf([mcmeta, bombEntry('bomb/x.bin', 64)], { overlap: 99 }));
  let tm = await timed(() => drop(serverDir('fab'), [bomb]));
  check(statSync(bomb).size < 200000 && /unpacks to 6401 MB, more than the 2048 MB/.test(skippedOf(tm.r, 'bomb.zip')?.message) && sizeOf(path.join(serverDir('fab'), 'resourcepack')) === 0 && tm.ms < 15000,
    `a ${Math.round(statSync(bomb).size / 1024)} KB overlapping-entries bomb is refused before anything is written (${tm.ms} ms, ${S(tm.r.ok?.skipped)})`);
  const lying = write(path.join(outside, 'lying.zip'), zipOf([mcmeta, bombEntry('assets/big.bin', 256, 1000)]));
  tm = await timed(() => drop(serverDir('fab'), [lying]));
  check(/big\.bin is damaged/.test(skippedOf(tm.r, 'lying.zip')?.message) && !existsSync(path.join(serverDir('fab'), 'resourcepack', 'assets', 'big.bin')) && sizeOf(path.join(serverDir('fab'), 'resourcepack')) < 10000,
    `an entry that inflates to 256 MB while declaring 1000 bytes stops at its declared size (${tm.ms} ms, ${S(tm.r.ok?.skipped)})`);
  rmSync(path.join(serverDir('fab'), 'resourcepack'), { recursive: true, force: true });
  const huge = write(path.join(outside, 'huge-entry.mrpack'), zipOf([bombEntry('modrinth.index.json', 600)]));
  tm = await timed(() => info({ file: huge }));
  check(/not a Modrinth modpack/.test(tm.r.err) && tm.ms < 5000, `an index entry of 600 MB is not inflated (${tm.ms} ms: ${tm.r.err})`);

  // many entries; methods PyIDE does not read; damaged and encrypted data
  const many = write(path.join(outside, 'many-entries.jar'), zipOf([...Array.from({ length: 30000 }, (_v, i) => ({ name: `c/${i}.class`, data: Buffer.alloc(0), method: 0 })), { name: 'plugin.yml', data: Buffer.from('name: Many\n') }]));
  const manyPack = write(path.join(outside, 'many-files.zip'), zipOf([mcmeta, ...Array.from({ length: 3000 }, (_v, i) => ({ name: `assets/t/${i}.png`, data: Buffer.from(String(i)), method: 0 }))]));
  tm = await timed(() => drop(serverDir('rp'), [many, manyPack]));
  check(tm.r.ok?.done.length === 2 && existsSync(path.join(serverDir('rp'), 'plugins', 'many-entries.jar')) && readdirSync(path.join(serverDir('rp'), 'resourcepack', 'assets', 't')).length === 3000 && tm.ms < 60000,
    `a jar of 30000 entries is read and a pack of 3000 files unpacked (${tm.ms} ms)`);
  rmSync(path.join(serverDir('rp'), 'resourcepack'), { recursive: true, force: true });
  const bz = write(path.join(outside, 'bzip2.zip'), zipOf([mcmeta, { name: 'assets/x.png', method: 12, packed: Buffer.from('BZh9'), size: 4 }]));
  const corrupt = write(path.join(outside, 'corrupt.zip'), zipOf([mcmeta, { name: 'assets/y.png', method: 8, packed: crypto.randomBytes(300), size: 1000 }]));
  const locked = write(path.join(outside, 'encrypted.zip'), zipOf([mcmeta, { name: 'assets/z.png', method: 8, packed: crypto.randomBytes(30), size: 10, flags: 0x801 }]));
  r = await drop(serverDir('fab'), [bz, corrupt, locked]);
  check(/x\.png uses a compression Nano Studio does not read \(method 12\)/.test(skippedOf(r, 'bzip2.zip')?.message) && /y\.png is damaged/.test(skippedOf(r, 'corrupt.zip')?.message)
    && /z\.png is encrypted/.test(skippedOf(r, 'encrypted.zip')?.message), `unsupported, damaged and encrypted entries: a clear message each (${S(r.ok?.skipped)})`);
  rmSync(path.join(serverDir('fab'), 'resourcepack'), { recursive: true, force: true });

  // ---------- paths ----------
  const odd = write(path.join(outside, '이상한 이름', "플러그인 😀 'q' & 100% #1.jar"), pluginJar('Odd'));
  await dragOn(card('pap'), [odd]);
  await until(`/plugin added/.test((${runTab('Minecraft: Import')})?.host.textContent || '')`, 'odd name dropped', 15000).catch(() => {});
  check(plugins().includes("플러그인 😀 'q' & 100% #1.jar") && (await tabText('Minecraft: Import')).includes("플러그인 😀 'q' & 100% #1.jar: plugin added → pap"),
    'a real drag of a plugin named with Korean, emoji, quotes, & and % copies it under its name');
  let deep = outside;
  while (deep.length < 300) deep = path.join(deep, 'a-rather-long-folder-name-for-max-path');
  const deepJar = write(path.join(deep, 'deep-plugin.jar'), pluginJar('Deep'));
  const deepWorld = path.join(deep, 'DeepWorld');
  write(path.join(deepWorld, 'level.dat'), 'deep');
  write(path.join(deepWorld, 'region', 'r.0.0.mca'), 'region');
  r = await drop(serverDir('pap'), [deepJar, deepWorld]);
  check(r.ok?.done.length === 2 && plugins().includes('deep-plugin.jar') && existsSync(path.join(serverDir('pap'), 'DeepWorld', 'region', 'r.0.0.mca')),
    `files whose paths are ${deepJar.length} characters long (past MAX_PATH) are dropped like any other (${S(r.ok?.skipped || r.err)})`);
  const bulk = Array.from({ length: 300 }, (_v, i) => write(path.join(outside, 'bulk', `bulk-${String(i).padStart(3, '0')}.jar`), pluginJar(`B${i}`)));
  const at = Date.now();
  await dragOn(card('pap'), bulk);
  await until(`(${runTab('Minecraft: Import')})?.host.textContent.includes('bulk-299.jar: plugin added')`, '300 plugins dropped', 60000).catch(() => {});
  check(plugins().filter((n) => n.startsWith('bulk-')).length === 300 && (await tabText('Minecraft: Import')).split('plugin added').length - 1 === 300,
    `300 files dragged at once are all added and listed (${Date.now() - at} ms)`);

  // worlds named like the server's own, or nothing a folder name keeps
  const world = path.join(outside, 'world');
  write(path.join(world, 'level.dat'), 'dropped world');
  const korean = path.join(outside, '내 월드 😀');
  write(path.join(korean, 'level.dat'), 'korean world');
  r = await drop(serverDir('pap'), [world, world, korean]);
  const props = readFileSync(path.join(serverDir('pap'), 'server.properties'), 'utf8');
  check(S(r.ok?.done.map((d) => path.basename(d.to))) === S(['world-2', 'world-3', 'world-4']) && readFileSync(path.join(serverDir('pap'), 'world', 'level.dat'), 'utf8') === 'the server\'s own world'
    && /^level-name=world-4$/m.test(props) && (props.match(/level-name=/g) || []).length === 1,
  `a world named like the server's own is added beside it, never over it; a Korean name becomes world-N (${S(r.ok?.done.map((d) => d.to))})`);

  // folders that half look like a server, and a server of the project dropped again
  const half1 = path.join(outside, 'Half1');
  write(path.join(half1, 'server.properties'), 'server-port=1\n');
  write(path.join(half1, 'random.jar'), zipOf([{ name: 'readme.txt', data: Buffer.from('not a server') }]));
  const half2 = path.join(outside, 'Half2');
  write(path.join(half2, 'eula.txt'), 'eula=true\n');
  const half3 = path.join(outside, 'Half3');
  write(path.join(half3, 'run.bat'), 'java -jar x.jar\n');
  mkdirSync(path.join(half3, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.1.0'), { recursive: true });
  const fabBefore = readFileSync(path.join(serverDir('fab'), 'pyide-server.json'), 'utf8');
  r = await drop(null, [half1, half2, half3, serverDir('fab')]);
  check(/Half1 does not look like a Minecraft server/.test(skippedOf(r, 'Half1')?.message) && skippedOf(r, 'Half2')?.why === 'unknown' && /Half3 does not look like/.test(skippedOf(r, 'Half3')?.message)
    && S(readdirSync(path.join(project, 'servers')).sort()) === S(['fab', 'pap', 'rp']),
  `folders that only half look like a server are refused with a reason and nothing is copied (${S(r.ok?.skipped)})`);
  check(/fab is one of the project's servers already/.test(skippedOf(r, 'fab')?.message) && readFileSync(path.join(serverDir('fab'), 'pyide-server.json'), 'utf8') === fabBefore,
    'a server of the project dropped on the window is left as it is (its description is not rewritten as an import)');
  const named = path.join(outside, '서버 😀 & 100%');
  write(path.join(named, 'server.jar'), paperJar);
  write(path.join(named, 'server.properties'), 'server-port=25663\n');
  r = await drop(null, [named]);
  check(r.ok?.done[0]?.what === 'server' && desc(path.basename(r.ok.done[0].to)).kind === 'paper' && /^server(-\d+)?$/.test(path.basename(r.ok.done[0].to)),
    `a server folder named with Korean, emoji, & and % is imported under a name the servers accept (${S(r.ok?.done || r.err)})`);
  if (r.ok?.done[0]) rmSync(r.ok.done[0].to, { recursive: true, force: true });
  r = await drop(serverDir('pap'), [path.join(outside, 'does-not-exist.jar'), 'C:\\', path.join(outside, 'bulk')]);
  check(r.ok && r.ok.skipped.length === 3, `a path that is gone, a drive root and a plain folder are skipped (${S(r)})`);

  // ---------- modpacks ----------
  const deps = { minecraft: '1.20.1', 'fabric-loader': '0.15.0' };
  const okMod = Buffer.from('a server mod');
  const okUrl = served('ok-mod.jar', okMod);
  const good = { path: 'mods/ok.jar', hashes: { sha1: sha('sha1', okMod), sha512: sha('sha512', okMod) }, downloads: [okUrl], fileSize: okMod.length };
  const packFile = (name, index, extra) => write(path.join(outside, name), mrpackOf(index, extra));
  const cases = [
    ['malformed index', packFile('malformed.mrpack', '{"name": "x", '), /malformed\.mrpack has a damaged modrinth\.index\.json/],
    ['an index that is not an object', packFile('array.mrpack', '[1, 2]'), /damaged modrinth\.index\.json|names no mod loader/],
    ['an unknown loader', packFile('lite.mrpack', { dependencies: { minecraft: '1.20.1', liteloader: '1.0' } }), /names no mod loader Nano Studio runs/],
    ['Quilt', packFile('quilt.mrpack', { dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.20' } }), /Quilt modpacks are not supported/],
    ['no Minecraft version', packFile('nomc.mrpack', { dependencies: { 'fabric-loader': '0.15.0' } }), /names no Minecraft version/],
    ['a loader version with a path in it', packFile('pathy.mrpack', { dependencies: { minecraft: '1.20.1', 'fabric-loader': '../../x' } }), /names no Fabric version/],
  ];
  for (const [what, file, want] of cases) {
    const got = await info({ file });
    check(want.test(got.err || ''), `a modpack with ${what}: ${got.err || S(got.ok)}`);
  }
  const odd2 = await info({ file: packFile('odd.mrpack', { name: { x: 1 }, versionId: 7, dependencies: deps, files: { not: 'a list' } }) });
  check(odd2.ok?.name === 'odd' && odd2.ok.version === '7' && odd2.ok.serverFiles === 0, `an index with a name that is not text and files that are not a list reads as empty (${S(odd2)})`);

  // a real drag of a hostile .mrpack onto the window opens New Server from Modpack with what it holds
  const hostilePack = packFile('팩 & 100% 😀.mrpack', { name: { evil: true }, versionId: '1', dependencies: deps, files: [good] });
  await dragOn(`document.querySelector('#minecraftTool .mc-bar')`, [hostilePack]);
  await until(`/팩 & 100% 😀 1: Minecraft 1\\.20\\.1, Fabric 0\\.15\\.0\\. 1 files for the server/.test(document.querySelector('#mcPackInfo')?.textContent || '')`, 'hostile modpack dialog', 15000)
    .then(() => check(true, 'a dropped .mrpack with a hostile name and index opens New Server from Modpack with what it holds'),
      async () => check(false, `modpack dialog: ${await js("document.querySelector('#mcPackInfo')?.textContent")} ${await js("document.querySelector('.mc-dialog-error')?.textContent")}`));
  await js(`([...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Cancel')?.click(), true)`);

  // files pointing outside the server folder, duplicates, an empty file, a pack's own pyide-server.json
  const empty = Buffer.alloc(0);
  const emptyUrl = served('empty.txt', empty);
  const outsideFiles = ['../evil-m1.jar', path.join(escape, 'evil-m2.jar').replace(/\\/g, '/'), 'mods/../../evil-m3.jar', 'mods\\..\\..\\evil-m4.jar', '', 'mods/evil-m6.jar:ads', 'Z:evil-m7.jar']
    .map((p) => ({ ...good, path: p }));
  const hostileDesc = { kind: 'fabric', mc: '1.20.1', launch: { argsFile: '../../../evil.txt' }, java: 99 };
  const slipPack = packFile('slip.mrpack', { name: 'Slip Pack', versionId: '1', dependencies: deps, files: [...outsideFiles, good, good,
    { path: 'config/empty.txt', hashes: { sha1: sha('sha1', empty), sha512: sha('sha512', empty) }, downloads: [emptyUrl], fileSize: 0 },
    { path: 'mods/client.jar', env: { server: 'unsupported' }, downloads: [], hashes: {} }] },
  [{ name: 'overrides/../evil-m8.txt', data: Buffer.from('x') }, { name: 'overrides/pyide-server.json', data: Buffer.from(S(hostileDesc)) },
    { name: 'overrides/config/shared.toml', data: Buffer.from('shared = true') }, { name: 'server-overrides/config/server.toml', data: Buffer.from('server = true') },
    { name: `overrides/${path.join(escape, 'evil-m9.txt').replace(/\\/g, '/')}`, data: Buffer.from('x') }, { name: 'client-overrides/options.txt', data: Buffer.from('client') }]);
  r = await fromPack({ file: slipPack, name: 'slip' });
  const slipDir = serverDir('slip');
  check(r.ok && readFileSync(path.join(slipDir, 'mods', 'ok.jar'), 'utf8') === 'a server mod' && statSync(path.join(slipDir, 'config', 'empty.txt')).size === 0
    && existsSync(path.join(slipDir, 'config', 'shared.toml')) && existsSync(path.join(slipDir, 'config', 'server.toml')) && !existsSync(path.join(slipDir, 'options.txt'))
    && !existsSync(path.join(slipDir, 'mods', 'client.jar')) && !escaped().length,
  `a modpack's files and overrides pointing outside the server folder are skipped, the rest installed (${r.err || S(escaped())})`);
  check(desc('slip').kind === 'fabric' && desc('slip').loader === '0.15.0' && !desc('slip').launch.argsFile && desc('slip').java === 17 && desc('slip').modpack?.name === 'Slip Pack',
    `a pack's own pyide-server.json does not replace the server's description (${S(desc('slip'))})`);
  const before = (n) => !existsSync(serverDir(n));
  const failing = [
    ['a file without checksums', { ...good, hashes: {} }, /The modpack gives no checksum for mods\/ok\.jar/],
    ['a file without a download address', { ...good, downloads: undefined }, /gives no download address for mods\/ok\.jar/],
    ['a file:// download address', { ...good, downloads: [`file:///${sentinel.replace(/\\/g, '/')}`] }, /gives no download address/],
    ['a wrong checksum', { ...good, hashes: { sha1: '0'.repeat(40) } }, /Checksum mismatch for mods\/ok\.jar/],
  ];
  for (const [what, f, want] of failing) {
    const name = `bad${failing.findIndex((x) => x[0] === what)}`;
    const got = await fromPack({ file: packFile(`${name}.mrpack`, { name, dependencies: deps, files: [good, f] }), name });
    check(want.test(got.err || '') && before(name), `a modpack with ${what}: ${got.err || 'created'}, and no server folder is left`);
  }
  const bzPack = packFile('bz.mrpack', { name: 'bz', dependencies: deps, files: [] }, [{ name: 'overrides/config/a.toml', method: 12, packed: Buffer.from('BZh9'), size: 4 }]);
  r = await fromPack({ file: bzPack, name: 'bzpack' });
  check(/a\.toml uses a compression Nano Studio does not read/.test(r.err || '') && before('bzpack'), `overrides in a compression Nano Studio does not read: ${r.err}`);
  const bombPack = write(path.join(outside, 'bomb.mrpack'), zipOf([{ name: 'modrinth.index.json', data: Buffer.from(S({ name: 'bomb', dependencies: deps, files: [] })) }, bombEntry('overrides/bomb/x.bin', 64)], { overlap: 99 }));
  tm = await timed(() => fromPack({ file: bombPack, name: 'bombpack' }));
  check(/unpacks to \d+ MB, more than the 2048 MB/.test(tm.r.err || '') && before('bombpack') && tm.ms < 20000, `a modpack whose overrides are a zip bomb is refused (${tm.ms} ms: ${tm.r.err})`);

  // modpacks from Modrinth: hostile names, broken checksums, broken answers, no answer
  const realPack = mrpackOf({ name: 'Remote', versionId: '2', dependencies: deps, files: [good] });
  const notPack = zipOf([{ name: 'readme.txt', data: Buffer.from('no index') }]);
  const mv = (files) => [{ id: 'v', version_number: '1', files }];
  const mfile = (filename, data, more) => ({ filename, url: served(filename, data), primary: true, size: data.length, hashes: { sha1: sha('sha1', data), sha512: sha('sha512', data) }, ...more });
  routes.set('/modrinth/project/evilname/version', mv([mfile('x\\..\\..\\evil-dl.mrpack', realPack)]));
  routes.set('/modrinth/project/badhash/version', mv([mfile('badhash.mrpack', realPack, { hashes: { sha1: '0'.repeat(40) } })]));
  routes.set('/modrinth/project/nohash/version', mv([mfile('nohash.mrpack', realPack, { hashes: null })]));
  routes.set('/modrinth/project/notarray/version', { versions: [] });
  routes.set('/modrinth/project/nofiles/version', [{ id: 'v' }, null, { files: null }]);
  routes.set('/modrinth/project/zipfirst/version', mv([mfile('readme.zip', notPack), { ...mfile('second.mrpack', realPack), primary: false }]));
  routes.set('/modrinth/project/notapack/version', mv([mfile('notapack.mrpack', notPack)]));
  routes.set('/modrinth/project/err500/version', { status: 500, body: 'oops' });
  routes.set('/modrinth/project/badjson/version', '<html>not json');
  routes.set('/modrinth/project/hang/version', HANG);
  routes.set('/modrinth/project/remote/version', mv([mfile('remote.mrpack', realPack)]));
  const hangInfo = js(`(window.__hangInfo = ide.api.invoke('minecraft:modpackInfo', ide.root, { url: 'hang' }, 'stress').then(() => 'answered', (e) => e.message), true)`);
  const evil = await info({ url: 'https://modrinth.com/modpack/evilname' });
  check(evil.ok?.name === 'Remote' && path.dirname(evil.ok.file) === tmpdir() && /^pyide-[0-9a-f]{8}-evil-dl\.mrpack$/.test(path.basename(evil.ok.file)) && !escaped().length,
    `a Modrinth file name with ..\\ stays a name in the temporary folder (${S(evil.ok?.file || evil.err)})`);
  await call('minecraft:discardModpack', evil.ok?.file);
  for (const [slug, want] of [['badhash', /Checksum mismatch for badhash\.mrpack/], ['nohash', /publishes no checksum/], ['notarray', /notarray has no \.mrpack/], ['nofiles', /nofiles has no \.mrpack/],
    ['notapack', /is not a Modrinth modpack/], ['err500', /Modrinth has no modpack err500 \(HTTP 500\)/], ['badjson', /the answer is not JSON/], ['..', /Give a Modrinth modpack address/]]) {
    const got = await info({ url: slug });
    check(want.test(got.err || '') && !tempLeft().length, `Modrinth modpack ${slug}: ${got.err || S(got.ok)}; nothing left in the temporary folder (${S(tempLeft())})`);
  }
  const zf = await info({ url: 'zipfirst' });
  check(zf.ok?.name === 'Remote' && /second\.mrpack$/.test(zf.ok.file), `a version whose primary file is not a .mrpack gives its .mrpack (${S(zf.ok?.file || zf.err)})`);
  await call('minecraft:discardModpack', zf.ok?.file);
  r = await fromPack({ url: 'remote', name: 'pap' });
  check(/servers.pap already exists/.test(r.err || '') && !tempLeft().length && existsSync(path.join(serverDir('pap'), 'pyide-server.json')),
    `a modpack from Modrinth whose server cannot be made leaves no download behind (${r.err}; ${S(tempLeft())})`);

  // ---------- the Market ----------
  const fab = serverDir('fab');
  const mods = () => readdirSync(path.join(fab, 'mods')).sort();
  const project_ = (id, title, more) => routes.set(`/modrinth/project/${id}`, { id, title, server_side: 'required', ...more });
  const versions = (id, list) => routes.set(`/modrinth/project/${id}/version`, list);
  const ver = (vid, number, filename, needs = [], more) => ({ id: vid, version_number: number, version_type: 'release', files: [mfile(filename, Buffer.from(`${filename} ${number}`))],
    dependencies: needs.map((p) => ({ project_id: p, dependency_type: 'required' })), ...more });
  project_('CYA', 'Cycle A'); versions('CYA', [ver('cya1', '1', 'cycle-a.jar', ['CYB'])]);
  project_('CYB', 'Cycle B'); versions('CYB', [ver('cyb1', '1', 'cycle-b.jar', ['CYA'])]);
  r = await install(fab, 'CYA');
  check(S(r.ok?.installed.map((i) => i.title)) === S(['Cycle A', 'Cycle B']) && S(mods()) === S(['cycle-a.jar', 'cycle-b.jar']), `A requires B, B requires A: both installed once (${S(r)})`);
  r = await remove(fab, 'CYA');
  check(S(r.ok?.removed) === S(['Cycle A', 'Cycle B']) && !mods().length && !Object.keys(desc('fab').market).length, `removing A of the cycle removes B too (${S(r)})`);
  project_('TOPC', 'Top C'); versions('TOPC', [ver('c1', '1', 'top-c.jar', ['DA'])]);
  project_('DA', 'Dep A'); versions('DA', [ver('da1', '1', 'dep-a.jar', ['DB'])]);
  project_('DB', 'Dep B'); versions('DB', [ver('db1', '1', 'dep-b.jar', ['DA'])]);
  r = await install(fab, 'TOPC');
  const r2 = await remove(fab, 'TOPC');
  check(r.ok?.installed.length === 3 && S(r2.ok?.removed) === S(['Top C', 'Dep A', 'Dep B']) && !mods().length && !Object.keys(desc('fab').market).length,
    `a dependency cycle under a project goes with it (${S(r2)})`);
  project_('NOVER', 'Needs NV'); versions('NOVER', [ver('nv1', '1', 'needs-nv.jar', ['DEPNV'])]);
  project_('DEPNV', 'Dep NV'); versions('DEPNV', []);
  r = await install(fab, 'NOVER');
  check(/Dep NV has no version for Fabric 1\.20\.1, and a project being installed requires it/.test(r.err || '') && !mods().length, `a dependency with no version for the server: ${r.err}, nothing installed`);
  project_('NOFILES', 'No Files'); versions('NOFILES', [{ id: 'nf', version_number: '1', version_type: 'release' }]);
  project_('NOTLIST', 'Not List'); versions('NOTLIST', { hits: [] });
  project_('NOHASH', 'No Hash'); versions('NOHASH', [ver('nh', '1', 'no-hash.jar', [], {})]); routes.get('/modrinth/project/NOHASH/version')[0].files[0].hashes = {};
  routes.set('/modrinth/project/NOID', { title: 'No Id', server_side: 'required' }); versions('NOID', [ver('ni', '1', 'no-id.jar', ['NOID'])]);
  for (const [id, want] of [['NOFILES', /No Files 1 has no file to download/], ['NOTLIST', /Not List has no version/], ['NOHASH', /publishes no checksum for no-hash\.jar/]]) {
    r = await install(fab, id);
    check(want.test(r.err || '') && !mods().length, `${id}: ${r.err || S(r.ok)}`);
  }
  const noIdAsked = () => requests.filter((u) => u === '/modrinth/project/NOID').length;
  r = await Promise.race([install(fab, 'NOID'), sleep(15000).then(() => ({ err: 'no answer in 15 s' }))]);
  check(r.ok?.installed.length === 1 && noIdAsked() === 1 && S(mods()) === S(['no-id.jar']), `a project whose answer has no id and requires itself is installed once (${S(r)}, asked ${noIdAsked()} times)`);
  await remove(fab, 'NOID');

  // hostile file names
  for (const [id, filename] of [['EVIL1', '../../../evil-k1.jar'], ['EVIL2', '..\\pyide-server.json'], ['EVIL3', 'evil-k3.jar:ads'], ['EVIL4', 'CON.jar'], ['EVIL5', 'mods/evil-k5.jar']]) {
    project_(id, id); versions(id, [{ id: `${id}v`, version_number: '1', version_type: 'release', files: [mfile(filename, Buffer.from('x'))] }]);
    const fabDesc = readFileSync(path.join(fab, 'pyide-server.json'), 'utf8');
    r = await install(fab, id);
    check(/has a name Nano Studio does not write/.test(r.err || '') && !escaped().length && !mods().length && readFileSync(path.join(fab, 'pyide-server.json'), 'utf8') === fabDesc,
      `a Modrinth file named ${S(filename)} is refused: ${r.err || S(r.ok)}`);
  }

  // the same project, and two projects, installed at the same time
  const slow = (id, filename) => { project_(id, id); versions(id, [{ id: `${id}v`, version_number: '1', version_type: 'release', files: [{ ...mfile(filename, Buffer.from(id)), url: `${base}/slow/${filename}` }] }]); routes.set(`/slow/${filename}`, { delay: 1500, body: Buffer.from(id) }); };
  slow('SLOW', 'slow.jar');
  const [s1, s2] = await Promise.all([install(fab, 'SLOW'), install(fab, 'SLOW')]);
  check([s1, s2].filter((x) => x.ok?.installed.length === 1).length === 1 && [s1, s2].some((x) => /installed already, the newest/.test(x.err || '')) && S(mods()) === S(['slow.jar'])
    && readFileSync(path.join(fab, 'mods', 'slow.jar'), 'utf8') === 'SLOW', `the same project installed twice at once: one install, one "installed already" (${S([s1, s2])})`);
  slow('SLOWA', 'slow-a.jar');
  slow('SLOWB', 'slow-b.jar');
  const [sa, sb] = await Promise.all([install(fab, 'SLOWA'), install(fab, 'SLOWB')]);
  check(sa.ok && sb.ok && ['SLOW', 'SLOWA', 'SLOWB'].every((id) => desc('fab').market[id]) && S(mods()) === S(['slow-a.jar', 'slow-b.jar', 'slow.jar']),
    `two projects installed at once are both recorded (${S(Object.keys(desc('fab').market))})`);

  // removal of what was deleted by hand; a server folder deleted; a hostile record
  rmSync(path.join(fab, 'mods', 'slow-a.jar'));
  r = await remove(fab, 'SLOWA');
  check(S(r.ok?.removed) === S(['SLOWA']) && !desc('fab').market.SLOWA, `removing a project whose file was deleted by hand (${S(r)})`);
  describe('gone', { kind: 'fabric', mc: '1.20.1', loader: '0.15.0' });
  await js('ide.minecraft.refresh().then(() => true)');
  rmSync(serverDir('gone'), { recursive: true, force: true });
  r = await install(serverDir('gone'), 'SLOWB');
  check(/is not a Nano Studio Minecraft server/.test(r.err || '') && !existsSync(serverDir('gone')), `installing into a server whose folder was deleted: ${r.err}; the folder is not made again`);
  const papDesc = desc('pap');
  writeFileSync(path.join(serverDir('pap'), 'pyide-server.json'), S({ ...papDesc, market: { HOST: { title: 'Host', version: '1', files: ['../../../sentinel.txt', 'C:\\'], needs: [], dependency: false } } }));
  r = await remove(serverDir('pap'), 'HOST');
  check(r.ok && existsSync(sentinel), `a pyide-server.json naming files outside the server deletes nothing outside it (${S(r)})`);

  // a resource pack update that fails keeps the pack that was there
  const rpDir = serverDir('rp');
  const packV = (n) => zipOf([{ name: 'pack.mcmeta', data: Buffer.from(`{"pack": {"pack_format": 15, "description": "v${n}"}}`) }]);
  project_('RP1', 'Pack One'); versions('RP1', [{ id: 'rp1', version_number: '1', version_type: 'release', files: [mfile('pack-1.zip', packV(1))] }]);
  r = await install(rpDir, 'RP1', 'resourcepack');
  versions('RP1', [{ id: 'rp2', version_number: '2', version_type: 'release', files: [mfile('pack-2.zip', packV(2), { hashes: { sha1: '0'.repeat(40) } })] }]);
  const upd = await install(rpDir, 'RP1', 'resourcepack');
  check(r.ok && /Checksum mismatch for pack-2\.zip/.test(upd.err || '') && /v1/.test(readFileSync(path.join(rpDir, 'resourcepack', 'pack.mcmeta'), 'utf8'))
    && desc('rp').market.RP1?.version === '1' && !existsSync(path.join(rpDir, 'resourcepack.part')) && !tempLeft().length,
  `a resource pack update that fails its checksum keeps the installed pack and its record (${upd.err})`);
  versions('RP1', [{ id: 'rp3', version_number: '3', version_type: 'release', files: [mfile('pack-3.zip', zipOf([{ name: 'readme.txt', data: Buffer.from('no pack') }]))] }]);
  const notRp = await install(rpDir, 'RP1', 'resourcepack');
  check(/pack-3\.zip is not a resource pack/.test(notRp.err || '') && /v1/.test(readFileSync(path.join(rpDir, 'resourcepack', 'pack.mcmeta'), 'utf8')) && !existsSync(path.join(rpDir, 'resourcepack', 'readme.txt')),
    `an update that is not a resource pack leaves the installed one as it was (${notRp.err})`);

  // the Market page against a stand-in search that fails, answers nonsense, hangs or answers a lot
  let mode = 'ok';
  const hit = (id, title, more) => ({ project_id: id, slug: id.toLowerCase(), project_type: 'mod', title, author: 'tester', description: `${title} text`, icon_url: null, downloads: 1234, follows: 5, display_categories: ['utility'], ...more });
  routes.set('/modrinth/search', () => {
    if (mode === '500') return { status: 500, body: 'boom' };
    if (mode === 'html') return '<html>busy</html>';
    if (mode === 'nohits') return { total_hits: 3 };
    if (mode === 'hang') return HANG;
    if (mode === 'weird') {
      return { total_hits: 'many', hits: [null, { title: 'no id' }, hit('W1', 'Weird One', { icon_url: 'javascript:alert(1)', display_categories: 'utility', downloads: 'lots' }),
        hit('W2', '', { slug: 'w-two', icon_url: 'file:///C:/Windows/win.ini', author: null, description: { html: true }, categories: [1, 'x'] , display_categories: null })] };
    }
    if (mode === 'huge') return { total_hits: 1e9, hits: Array.from({ length: 500 }, (_v, i) => hit(`H${i}`, `Huge ${i}`)) };
    return { total_hits: 2, hits: [hit('SLOWD', 'Slow D'), hit('PLAIN', 'Plain')] };
  });
  slow('SLOWD', 'slow-d.jar');
  project_('PLAIN', 'Plain'); versions('PLAIN', [ver('p1', '1', 'plain.jar')]);
  const status = () => js(`document.querySelector('.mcm-status')?.textContent || ''`);
  const marketCard = (id) => `document.querySelector('.mcm-card[data-id="${id}"]')`;
  const resort = (sort) => js(`(() => { const s = document.querySelector('#mcmSort'); s.value = ${S(sort)}; s.onchange(); return true; })()`);
  await js(`ide.minecraft.refresh().then(() => ide.minecraft.market.open({ type: 'mod', server: ide.minecraft.servers().find((s) => s.name === 'fab') })).then(() => true)`);
  await until(`!!${marketCard('SLOWD')}`, 'market results', 15000);
  for (const [m, want] of [['500', /HTTP 500/], ['html', /the answer is not JSON/], ['nohits', /does not understand/]]) {
    mode = m;
    await resort(m === 'html' ? 'downloads' : m === 'nohits' ? 'follows' : 'newest');
    await until(`document.querySelector('.mcm-status')?.classList.contains('mcm-error') && !document.querySelectorAll('.mcm-card').length`, `search ${m}`, 10000).catch(() => {});
    check(want.test(await status()), `a search answered ${m}: the page says so (${await status()})`);
  }
  mode = 'weird';
  await resort('updated');
  await until(`document.querySelectorAll('.mcm-card').length === 2`, 'weird results', 10000).catch(() => {});
  const weird = await js(`[...document.querySelectorAll('.mcm-card')].map((c) => ({ id: c.dataset.id, src: c.querySelector('img').getAttribute('src'), name: c.querySelector('.mcm-name').textContent, chips: c.querySelectorAll('.mcm-chip').length }))`);
  check(S(weird) === S([{ id: 'W1', src: null, name: 'Weird One', chips: 0 }, { id: 'W2', src: null, name: 'w-two', chips: 1 }]) && /2 projects/.test(await status()),
    `hits without an id, with null, javascript: or file: icons and fields of the wrong type show as plain cards (${S(weird)} ${await status()})`);
  mode = 'huge';
  tm = await timed(async () => { await resort('relevance'); await until(`document.querySelectorAll('.mcm-card').length === 500`, 'huge results', 15000).catch(() => {}); });
  check(/1B projects/.test(await status()) && await js(`!document.querySelector('.mcm-more').classList.contains('hidden')`), `a search reporting a billion projects and 500 hits on a page (${tm.ms} ms: ${await status()})`);
  mode = 'hang';
  await js(`(window.__hangSearch = ide.api.invoke('minecraft:marketSearch', { type: 'mod', serverDir: ${S(fab)} }).then(() => 'answered', (e) => e.message), true)`);
  await resort('downloads');
  await sleep(500);
  mode = 'ok';
  await resort('follows');
  await until(`!!${marketCard('SLOWD')}`, 'results after a hung search', 10000).catch(() => {});
  check(await js(`!!${marketCard('SLOWD')}`), 'while a search hangs, the next one shows its results');

  // Install on a card, drawn again mid-install, stays off; a second click installs nothing more
  await js(`(${marketCard('SLOWD')}.querySelector('.mcm-install').click(), true)`);
  await sleep(300);
  await resort('newest');
  await until(`!!${marketCard('SLOWD')}`, 'redrawn', 5000);
  const mid = await js(`(() => { const b = ${marketCard('SLOWD')}.querySelector('.mcm-install'); return b && { disabled: b.disabled, text: b.textContent }; })()`);
  await js(`(${marketCard('SLOWD')}.querySelector('.mcm-install')?.click(), true)`);
  await until(`/Installed 1/.test(${marketCard('SLOWD')}?.textContent || '')`, 'SLOWD installed', 15000).catch(() => {});
  check(mid?.disabled && mid.text === 'Installing…' && requests.filter((u) => u === '/slow/slow-d.jar').length === 1 && mods().includes('slow-d.jar'),
    `a card drawn again while its project installs keeps Install off (${S(mid)}, downloaded ${requests.filter((u) => u === '/slow/slow-d.jar').length} time(s))`);

  // the hung requests give up with a message
  const hungInfo = await js('window.__hangInfo');
  const hungSearch = await js('window.__hangSearch');
  check(/no answer within 30 seconds/.test(hungInfo) && /no answer within 30 seconds/.test(hungSearch), `Modrinth that never answers: "${hungInfo}" / "${hungSearch}"`);
  await sleep(300);
  check(await js(`!!${marketCard('SLOWD')} && !document.querySelector('.mcm-status').classList.contains('mcm-error')`), 'a hung search that gives up late does not replace the results shown since');

  // still usable: the Modpacks tab searches
  await js(`([...document.querySelectorAll('.mcm-tab')].find((b) => b.dataset.type === 'modpack').click(), true)`);
  await until(`document.querySelectorAll('.mcm-card').length === 2 && !!document.querySelector('.mcm-create')`, 'modpack tab', 10000).catch(() => {});
  check(await js(`document.querySelectorAll('.mcm-card .mcm-create').length === 2`), 'after every attack the Market still searches and shows results');

  // ---------- what is left ----------
  const errors = await internal();
  check(!errors.length, `no IDE internal errors (${S(errors)})`);
  check(!escaped().length && existsSync(sentinel), `nothing was written or deleted outside the server folders (${S(escaped())})`);
  check(!tempLeft().length, `no downloads left in the temporary folder (${S(tempLeft())})`);
  const strays = readdirSync(path.join(project, 'servers')).filter((n) => !['fab', 'pap', 'rp', 'slip'].includes(n));
  check(!strays.length, `no half-made server folders (${S(strays)})`);
} catch (err) {
  check(false, `suite error: ${err.stack || err}`);
} finally {
  for (const r of hung) r.destroy();
  server.closeAllConnections?.();
  server.close();
  for (const n of tempLeft()) rmSync(path.join(tmpdir(), n), { force: true });
  for (const p of escaped()) rmSync(p, { force: true });
  t.finish();
}
