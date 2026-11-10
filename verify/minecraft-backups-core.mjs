// Craft's world backups in plain Node (main/minecraft/zip64.js, main/minecraft/backups.js and their IPC through
// main/features/minecraft.js): no Electron, no window, no real server, no network. A Node script plays a running server
// (it answers save-off, save-all flush and save-on with the game's own lines, which 26.3's and 1.20.1's en_us.json give,
// and keeps writing its region file while saving is on).
// Checks: ZIP64 past 65,535 files and past 4 GB without writing gigabytes (an extended file reads as zeros; a sparse
// archive with every value past 32 bits), read back here, by zipfile.js and by .NET's ZipFile; what a backup holds and
// leaves out, and its manifest; retention by count and by size, never the user's own or a kept one; a damaged archive
// refused before anything changes; a restore that puts the world and the config back, keeps mods and plugin jars, and
// makes a "before restore" backup; a swap that fails half-way (a folder held by a process) and one cut off by a crash,
// both undone; save-off, save-all flush and save-on around a running server's pack, also when it does not answer, when a
// player types the answer into chat, when it is cancelled, when the server stops or crashes, and when "stop" goes to one
// that ignores it (nothing more is sent; a backup asked for or falling due then is not made); the main process's event loop while
// a 300 MB world is packed.
// Usage: node verify/minecraft-backups-core.mjs
import { spawn, execFileSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, openSync, writeSync, closeSync, ftruncateSync, statfsSync } from 'fs';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
let failed = 0;
let passed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const errOf = async (step) => { try { await step(); return null; } catch (err) { return err; } };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const hashTree = (dir) => {
  if (!existsSync(dir)) return null;
  const h = crypto.createHash('sha1');
  const walk = (d, rel) => { for (const n of readdirSync(d, { withFileTypes: true }).filter((x) => x.name !== 'session.lock').sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(d, n.name);
    h.update(`${rel}/${n.name}${n.isDirectory() ? '/' : ''}\n`);
    if (n.isDirectory()) walk(p, `${rel}/${n.name}`); else h.update(readFileSync(p));
  } };
  walk(dir, '');
  return h.digest('hex');
};

const work = mkdtempSync(path.join(tmpdir(), 'pyide-backups-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
const Z = require('../main/minecraft/zip64.js');
const zf = require('../main/minecraft/zipfile.js');
const ST = require('../main/minecraft/server-settings.js');
const { createBackups, holdSaves } = require('../main/minecraft/backups.js');
const { markStops } = require('../main/minecraft/health-monitor.js');
const dotnet = (file) => execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -A System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead('${file}'); $n = $z.Entries.Count; $l = ($z.Entries | Measure-Object -Property Length -Maximum).Maximum; $z.Dispose(); "$n $l"`], { encoding: 'utf8' }).trim();
const dotnetCount = (file) => Number(dotnet(file).split(' ')[0]);
const entriesIn = async (file) => { const a = await Z.openArchive(file); const names = a.entries.map((e) => e.name); await a.close(); return names; };
const readOut = async (file, name) => {
  const a = await Z.openArchive(file);
  try {
    const e = a.entries.find((x) => x.name === name);
    if (!e) return null;
    const parts = [];
    await a.stream(e, async (c) => { parts.push(c); });
    return Buffer.concat(parts);
  } finally { await a.close(); }
};

// BACKUPS_QUICK=1 leaves out the two slow parts (the 4.3 GB file, the 300 MB world) while working on the others.
const QUICK = !!process.env.BACKUPS_QUICK;
const holders = [];
try {
  // ---------- ZIP64: past 65,535 files ----------
  {
    const file = path.join(work, 'many.zip');
    const w = await Z.createZipWriter(file, { level: 1 });
    for (let i = 0; i < 70000; i++) await w.add({ name: `world/playerdata/${i}.dat`, data: Buffer.from(`player ${i}`) });
    await w.finish();
    const a = await Z.openArchive(file);
    const last = a.entries.at(-1);
    let back = '';
    await a.stream(last, async (c) => { back += c; });
    await a.close();
    const z = zf.openZip(file);
    const viaZipfile = z.names.length;
    const one = z.read('world/playerdata/65600.dat')?.toString();
    z.close();
    check(a.entries.length === 70000 && back === 'player 69999' && viaZipfile === 70000 && one === 'player 65600',
      `70,000 files make one zip that reads back whole, through zipfile.js's openZip too (${a.entries.length}, ${viaZipfile}, ${one})`);
    check(dotnetCount(file) === 70000, '.NET\'s ZipFile (the reader other Windows programs use) lists all 70,000');
  }

  // ---------- ZIP64: a file past 4 GB, read as zeros from an extended file ----------
  {
    const free = statfsSync(work).bavail * statfsSync(work).bsize;
    const SIZE = 4.3e9;
    if (QUICK) console.log('skip: the 4.3 GB file (BACKUPS_QUICK)');
    else if (free < 12e9) check(true, `skip: a 4.3 GB file needs room (${Math.round(free / 1e9)} GB free)`);
    else {
      const src = path.join(work, 'big.mca');
      const fd = openSync(src, 'w');
      writeSync(fd, Buffer.from('head'), 0, 4, 0);
      ftruncateSync(fd, SIZE);
      writeSync(fd, Buffer.from('tail'), 0, 4, SIZE - 4);
      closeSync(fd);
      const file = path.join(work, 'big.zip');
      const started = Date.now();
      const w = await Z.createZipWriter(file, { level: 1 });
      await w.add({ name: 'before.txt', data: Buffer.from('before') });
      await w.add({ name: 'world/region/r.0.0.mca', file: src });
      await w.add({ name: 'after.txt', data: Buffer.from('after') });
      await w.finish();
      rmSync(src, { force: true });
      const a = await Z.openArchive(file);
      const e = a.entries.find((x) => x.name === 'world/region/r.0.0.mca');
      let size = 0;
      let first = null;
      let lastBytes = Buffer.alloc(0);
      await a.stream(e, async (c) => { if (!first) first = c.subarray(0, 4).toString(); size += c.length; lastBytes = Buffer.concat([lastBytes, c]).subarray(-4); });
      let after = '';
      await a.stream(a.entries.find((x) => x.name === 'after.txt'), async (c) => { after += c; });
      await a.close();
      check(e.size === SIZE && size === SIZE && first === 'head' && lastBytes.toString() === 'tail' && after === 'after',
        `a 4.3 GB file goes in and comes out whole, its CRC checked, and the entry after it reads too (${e.size}, ${statSync(file).size} bytes on disk, ${Math.round((Date.now() - started) / 1000)} s)`);
      const [n, longest] = dotnet(file).split(' ').map(Number);
      check(n === 3 && longest === SIZE, `.NET's ZipFile reads its ZIP64 size (${n} entries, ${longest} bytes)`);
      rmSync(file, { force: true });
    }
  }

  // ---------- ZIP64: offsets past 4 GB, in a sparse archive ----------
  {
    const file = path.join(work, 'far.zip');
    write(file, '');
    try { execFileSync('fsutil', ['sparse', 'setflag', file], { stdio: 'ignore' }); } catch {}
    const at = 5e9;
    const data = Buffer.from('a block far into the archive');
    const name = Buffer.from('world/region/r.9.9.mca');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(45, 4); head.writeUInt16LE(0x0800, 6);
    const crc = require('zlib').crc32(data);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const rec = Z.centralRecord({ name, method: 0, crc, size: data.length, packed: data.length, at });
    const dirAt = at + 30 + name.length + data.length;
    const fd = openSync(file, 'r+');
    for (const [buf, pos] of [[Buffer.concat([head, name, data]), at], [Buffer.concat([rec, Z.endRecords(1, dirAt, rec.length)]), dirAt]]) writeSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    const a = await Z.openArchive(file);
    let back = '';
    await a.stream(a.entries[0], async (c) => { back += c; });
    await a.close();
    const disk = statSync(file).size;
    check(a.entries[0].at === at && back === data.toString() && disk > 5e9, `an entry and a directory past 4 GB are found through the ZIP64 offsets (${a.entries[0].at}, archive ${disk} bytes)`);
    rmSync(file, { force: true });
    const wide = Z.entriesOf(Z.centralRecord({ name: 'x', method: 8, crc: 1, size: 6e9, packed: 5e9, at: 7e9 }), 1)[0];
    check(wide.size === 6e9 && wide.packed === 5e9 && wide.at === 7e9, `a record whose size, packed size and offset are all past 4 GB reads back as written (${S(wide)})`);
  }

  // ---------- a server folder ----------
  const proj = path.join(work, 'project');
  const srv = path.join(proj, 'servers', 'survival');
  const desc = { kind: 'paper', mc: '1.21.11', loader: null, java: 21, memory: '2G', launch: { jar: 'server.jar' }, market: { abc: { version: '1.0', files: ['plugins/Essentials.jar'] } } };
  const bin = path.join(work, 'recycle-bin');
  const lay = () => {
    rmSync(srv, { recursive: true, force: true });
    write(path.join(srv, 'pyide-server.json'), S(desc));
    write(path.join(srv, 'server.properties'), 'level-name=world\nmotd=before\n');
    write(path.join(srv, 'whitelist.json'), S([{ uuid: '8667ba71-b85a-4004-af54-457a9734eed7', name: 'Steve' }]));
    write(path.join(srv, 'ops.json'), '[]');
    write(path.join(srv, 'bukkit.yml'), 'settings: {}\n');
    write(path.join(srv, 'world', 'level.dat'), 'level v1');
    write(path.join(srv, 'world', 'region', 'r.0.0.mca'), crypto.randomBytes(300000));
    write(path.join(srv, 'world', 'session.lock'), 'lock');
    write(path.join(srv, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca'), 'nether v1');
    write(path.join(srv, 'world_the_end', 'DIM1', 'region', 'r.0.0.mca'), 'end v1');
    write(path.join(srv, 'config', 'paper-global.yml'), 'global v1\n');
    write(path.join(srv, 'plugins', 'Essentials.jar'), 'jar');
    write(path.join(srv, 'plugins', 'Essentials', 'config.yml'), 'essentials v1\n');
    write(path.join(srv, 'plugins', 'Essentials', 'libs', 'bundled.jar'), 'bundled jar');
    write(path.join(srv, 'logs', 'latest.log'), 'log');
    write(path.join(srv, 'libraries', 'x.jar'), 'lib');
    write(path.join(srv, 'server.jar'), 'server jar');
    write(path.join(srv, 'mods-not-here.txt'), 'x'.repeat(2 << 20));
  };
  lay();
  const readServer = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, 'pyide-server.json'), 'utf8')); } catch { return null; } };
  const writeServer = (dir, d) => writeFileSync(path.join(dir, 'pyide-server.json'), S(d));
  let clock = new Date(2026, 10, 10, 9, 0, 0).getTime();
  const sent = [];
  const make = (extra = {}) => {
    const b = createBackups({ readServer, writeServer, readProps: ST.readProperties, writeProps: ST.writeProperties, isRunning: () => false, leftOver: async () => null,
      appVersion: () => '0.3.28', now: () => clock, ...extra });
    b.connect({ send: (ch, msg) => sent.push(msg), trash: async (f) => { mkdirSync(bin, { recursive: true }); require('fs').renameSync(f, path.join(bin, path.basename(f))); } });
    return b;
  };
  const B = make();

  // ---------- what a backup holds ----------
  const first = await B.backup(srv, { reason: 'manual' });
  const names = await entriesIn(first.file);
  const man = JSON.parse((await readOut(first.file, 'nano-backup.json')).toString());
  check(/^2026-11-10_09-00-00_manual\.zip$/.test(first.name) && path.dirname(first.file) === path.join(srv, 'backups'), `one file in <server>/backups/, named by its time and reason (${first.name})`);
  check(names[0] === 'nano-backup.json' && ['world/level.dat', 'world/region/r.0.0.mca', 'world_nether/DIM-1/region/r.0.0.mca', 'world_the_end/DIM1/region/r.0.0.mca', 'server.properties', 'whitelist.json', 'ops.json',
    'bukkit.yml', 'pyide-server.json', 'config/paper-global.yml', 'plugins/Essentials/config.yml'].every((n) => names.includes(n)),
  'it holds the world with its Nether and End folders, server.properties, the player lists, pyide-server.json, the top-level configs, config/ and the plugins\' config files');
  check(!names.some((n) => /\.jar$|^logs\/|^libraries\/|session\.lock|mods-not-here/.test(n)), `and not the jars (a plugin's own folder's included), logs, libraries, a large top-level file or the world's session.lock (${names.filter((n) => /\.jar$|logs|librar|lock|mods-not/.test(n))})`);
  check(man.app === '0.3.28' && man.mc === '1.21.11' && man.kind === 'paper' && man.levelName === 'world' && man.reason === 'manual' && man.bytes > 300000 && man.files === names.filter((n) => !n.endsWith('/')).length - 1
    && S(man.worlds) === S(['world', 'world_nether', 'world_the_end']) && ['plugins/*.jar (1)', 'logs/', 'libraries/', 'server.jar', 'mods-not-here.txt'].every((x) => man.leftOut.includes(x)),
  `the manifest says the app and Minecraft versions, the type, the level name, the reason, the sizes and what was left out (${S({ ...man, items: undefined })})`);
  check(dotnetCount(first.file) === names.length, 'the backup is a .zip other programs open');
  const listed = await B.list(srv);
  check(listed.items.length === 1 && listed.items[0].mc === '1.21.11' && listed.items[0].reason === 'manual' && !listed.items[0].auto && listed.used === statSync(first.file).size,
    `the list reads it back with its Minecraft version, reason and size (${S(listed.items[0])})`);
  const progress = sent.filter((m) => m.op === 'backup' && m.phase === 'packing' && m.total);
  check(progress.length > 0 && progress.every((m) => m.done <= m.total) && sent.some((m) => m.state === 'done' && m.file === first.file), `progress went out with a real fraction, then done (${progress.length} updates)`);

  // ---------- retention ----------
  B.setPolicy(srv, { keep: 3 });
  const autos = [];
  for (let i = 0; i < 5; i++) { clock += 3600e3; autos.push(await B.backup(srv, { reason: 'schedule' })); }
  clock += 3600e3;
  const kept = await B.backup(srv, { reason: 'market' });
  const keptFile = await B.keep(srv, kept.file, true);
  clock += 3600e3;
  autos.push(await B.backup(srv, { reason: 'schedule' }));
  const after = (await B.list(srv)).items;
  const autoLeft = after.filter((b) => b.auto && !b.keep).map((b) => b.name);
  check(autoLeft.length === 3 && S(autoLeft) === S(autos.slice(-3).reverse().map((b) => b.name)) && after.some((b) => b.file === first.file) && after.some((b) => b.file === keptFile && b.keep),
    `the newest 3 automatic backups stay, with the manual one and the one marked keep (${S(after.map((b) => b.name))})`);
  check(readdirSync(bin).length === 3 && autos.slice(0, 3).every((b) => existsSync(path.join(bin, b.name))), `the older automatic ones went to the Recycle Bin (${readdirSync(bin)})`);
  B.setPolicy(srv, { keep: 100, maxGB: (statSync(first.file).size * 2.5) / 1024 ** 3 });
  clock += 3600e3;
  const newestOne = await B.backup(srv, { reason: 'schedule' });
  const bySize = (await B.list(srv)).items;
  check(bySize.some((b) => b.file === newestOne.file) && bySize.some((b) => b.file === first.file) && bySize.some((b) => b.file === keptFile) && bySize.filter((b) => b.auto && !b.keep).length === 1,
    `over the size limit, automatic backups go oldest first, but never the one just made, the manual one or the kept one (${S(bySize.map((b) => b.name))})`);
  B.setPolicy(srv, { keep: 10, maxGB: 20 });

  // ---------- restore ----------
  const restoreSrc = await B.backup(srv, { reason: 'manual' });
  const worldBefore = hashTree(path.join(srv, 'world'));
  write(path.join(srv, 'world', 'level.dat'), 'level v2 (griefed)');
  write(path.join(srv, 'world', 'region', 'r.5.5.mca'), 'new region');
  write(path.join(srv, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca'), 'nether v2');
  write(path.join(srv, 'server.properties'), 'level-name=world\nmotd=after\n');
  write(path.join(srv, 'whitelist.json'), '[]');
  write(path.join(srv, 'config', 'paper-global.yml'), 'global v2\n');
  write(path.join(srv, 'config', 'added-later.yml'), 'later\n');
  write(path.join(srv, 'plugins', 'Essentials', 'config.yml'), 'essentials v2\n');
  write(path.join(srv, 'plugins', 'Essentials', 'libs', 'bundled.jar'), 'bundled jar v2');
  write(path.join(srv, 'plugins', 'Essentials.jar'), 'jar v2');
  writeServer(srv, { ...desc, memory: '6G', mc: '1.21.11', market: { abc: { version: '2.0', files: ['plugins/Essentials.jar'] } } });
  const worldGriefed = hashTree(path.join(srv, 'world'));

  // A damaged archive: one byte of the world's region file changed. Nothing changes, and nothing is backed up first.
  const broken = path.join(srv, 'backups', '2026-11-10_23-00-00_manual.zip');
  writeFileSync(broken, readFileSync(restoreSrc.file));
  {
    const a = await Z.openArchive(broken);
    const e = a.entries.find((x) => x.name === 'world/region/r.0.0.mca');
    await a.close();
    const buf = readFileSync(broken);
    buf[e.at + 30 + Buffer.byteLength(e.name) + Math.floor(e.packed / 2)] ^= 0xff;
    writeFileSync(broken, buf);
  }
  const beforeCount = readdirSync(path.join(srv, 'backups')).length;
  const refused = await errOf(() => B.restore(srv, broken));
  check(refused?.code === 'damaged' && /r\.0\.0\.mca/.test(refused.message) && hashTree(path.join(srv, 'world')) === worldGriefed && text(path.join(srv, 'server.properties')).includes('after')
    && readdirSync(path.join(srv, 'backups')).length === beforeCount && !existsSync(path.join(srv, '.nano-restore')),
  `a damaged archive is refused naming the entry, and the world, the settings and the backups folder are as they were (${refused?.message})`);
  rmSync(broken);

  // A restore whose swap fails half-way: config/ is held by a process working in it, so it cannot be moved.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(srv, 'config'), stdio: 'ignore' });
  holders.push(holder);
  await sleep(300);
  const halfway = await errOf(() => B.restore(srv, restoreSrc.file));
  holder.kill();
  await new Promise((r) => { holder.once('exit', r); setTimeout(r, 3000); });
  check(halfway?.code === 'swap' && hashTree(path.join(srv, 'world')) === worldGriefed && text(path.join(srv, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca')) === 'nether v2'
    && text(path.join(srv, 'server.properties')).includes('after') && existsSync(path.join(srv, 'config', 'added-later.yml')) && !existsSync(path.join(srv, '.nano-restore')),
  `a swap that fails half-way (config/ held) puts back the worlds it had swapped already, and leaves no work folder (${halfway?.message})`);

  const done = await B.restore(srv, restoreSrc.file);
  const now = readServer(srv);
  check(hashTree(path.join(srv, 'world')) === worldBefore && !existsSync(path.join(srv, 'world', 'region', 'r.5.5.mca')) && text(path.join(srv, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca')) === 'nether v1',
    'Restore gives back the world exactly as it was, its Nether too, and drops the region made since');
  check(text(path.join(srv, 'server.properties')).includes('before') && text(path.join(srv, 'whitelist.json')).includes('Steve') && text(path.join(srv, 'config', 'paper-global.yml')) === 'global v1\n'
    && !existsSync(path.join(srv, 'config', 'added-later.yml')) && text(path.join(srv, 'plugins', 'Essentials', 'config.yml')) === 'essentials v1\n',
  'and server.properties, the whitelist, config/ and the plugins\' configs');
  check(text(path.join(srv, 'plugins', 'Essentials.jar')) === 'jar v2' && text(path.join(srv, 'plugins', 'Essentials', 'libs', 'bundled.jar')) === 'bundled jar v2' && text(path.join(srv, 'server.jar')) === 'server jar',
    'the plugin jars (one inside a plugin\'s folder too) and the server jar stay as they are now');
  check(now.memory === '2G' && now.market.abc.version === '2.0' && done.kept.includes('pyide-server.json'),
    `pyide-server.json takes back the memory and Java options, and keeps what describes the jars installed now (Market records) (${S({ memory: now.memory, market: now.market })})`);
  const safety = done.safety && (await B.list(srv)).items.find((b) => b.file === done.safety);
  const safetyLevel = done.safety && (await readOut(done.safety, 'world/level.dat'))?.toString();
  check(safety?.reason === 'restore' && safetyLevel === 'level v2 (griefed)' && !existsSync(path.join(srv, '.nano-restore')),
    `a "before restore" backup of what was there was made first, so the restore can itself be undone (${safety?.name}, ${safetyLevel})`);

  // World only: the config files stay; the level name follows the backup's world.
  write(path.join(srv, 'server.properties'), 'level-name=other\nmotd=kept\n');
  write(path.join(srv, 'world', 'level.dat'), 'level v3');
  await B.restore(srv, restoreSrc.file, { worldOnly: true });
  check(text(path.join(srv, 'world', 'level.dat')) === 'level v1' && /motd=kept/.test(text(path.join(srv, 'server.properties'))) && ST.readProperties(path.join(srv, 'server.properties'))['level-name'] === 'world',
    'Restore the world only puts back the world, leaves the settings, and points level-name at the world it gave back');

  // A restore cut off by a crash in the middle of its swap: the next run finds the journal and puts the world back.
  {
    const w = path.join(srv, '.nano-restore');
    write(path.join(w, 'old', 'world', 'level.dat'), 'level before crash');
    write(path.join(w, 'new', 'world_nether', 'x'), 'unswapped');
    write(path.join(srv, 'world', 'level.dat'), 'level half restored');
    rmSync(path.join(srv, 'world'), { recursive: true, force: true });
    write(path.join(srv, 'world', 'level.dat'), 'level half restored');
    write(path.join(w, 'journal.json'), S({ stage: 'swapping', items: ['world', 'world_nether'], swapped: ['world'], had: ['world'] }));
    await B.beforeStart(srv);
    check(text(path.join(srv, 'world', 'level.dat')) === 'level before crash' && !existsSync(w), 'a restore cut off mid-swap is undone before the next start, from its journal');
  }

  // ---------- a running server ----------
  const standIn = path.join(work, 'stand-in.cjs');
  write(standIn, `const fs = require('fs');
const mode = process.env.MODE || 'ok';
const log = (m) => console.log('[12:00:00] [Server thread/INFO]: ' + m);
const region = 'world/region/r.0.0.mca';
let saving = true;
setInterval(() => { if (saving) fs.appendFileSync(region, 'x'); }, 20);
log('Done (1.0s)! For help, type "help"');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    fs.appendFileSync('commands.log', line + '\\n');
    if (line === 'stop' && mode === 'hangStop') { log('Ignoring stop'); continue; }
    if (line === 'save-off') {
      if (mode === 'silent') continue;
      if (mode === 'hangStop') { setTimeout(() => { saving = false; log('Automatic saving is now disabled'); }, 800); continue; }
      if (mode === 'alreadyOff') { saving = false; log('Saving is already turned off'); continue; }
      saving = false; log('Automatic saving is now disabled');
    } else if (line === 'save-all flush') {
      if (mode === 'forged') { console.log('[12:00:01] [Server thread/INFO]: <Mallory> Saved the game'); log('Saving the game (this may take a moment!)'); continue; }
      if (mode === 'noFlush') { log('Saving the game (this may take a moment!)'); continue; }
      log('Saving the game (this may take a moment!)');
      setTimeout(() => { fs.writeFileSync('flushed.txt', String(fs.statSync(region).size)); log('Saved the game'); }, 200);
    } else if (line === 'save-on') { saving = true; log('Automatic saving is now enabled'); }
    else if (line === 'stop') { log('Stopping the server'); setTimeout(() => process.exit(0), 300); }
  }
});
`);
  write(path.join(srv, 'world', 'region', 'r.0.0.mca'), crypto.randomBytes(300000));
  const times = { answer: 1500, flush: 2000, on: 1500 };
  const R = make({ times, isRunning: () => true, firstCheckMs: 3600e3 });
  const startStandIn = (mode) => {
    rmSync(path.join(srv, 'commands.log'), { force: true });
    rmSync(path.join(srv, 'flushed.txt'), { force: true });
    const child = spawn(process.execPath, [standIn], { cwd: srv, env: { ...process.env, MODE: mode }, stdio: ['pipe', 'pipe', 'inherit'] });
    holders.push(child);
    markStops(child);
    R.attach(srv, child);
    return new Promise((resolve) => { child.stdout.once('data', () => resolve(child)); });
  };
  const commands = () => (text(path.join(srv, 'commands.log')) || '').trim().split('\n').filter(Boolean);
  const zips = () => readdirSync(path.join(srv, 'backups')).filter((n) => n.endsWith('.zip') || n.endsWith('.tmp'));
  const stopStandIn = async (child) => { if (child.exitCode === null) { child.stdin.write('stop\n'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); }); } };

  let child = await startStandIn('ok');
  await sleep(300);
  const liveBackup = await R.backup(srv, { reason: 'manual' });
  await sleep(200);
  const packedRegion = (await readOut(liveBackup.file, 'world/region/r.0.0.mca')).length;
  const flushedAt = Number(text(path.join(srv, 'flushed.txt')));
  check(S(commands()) === S(['save-off', 'save-all flush', 'save-on']), `a running server gets save-off, save-all flush, and save-on after the pack (${S(commands())})`);
  check(packedRegion === flushedAt && statSync(path.join(srv, 'world', 'region', 'r.0.0.mca')).size > flushedAt,
    `the region file is packed as it was when the server said it had saved, though it went on writing after save-on (${packedRegion} = ${flushedAt})`);
  check(JSON.parse((await readOut(liveBackup.file, 'nano-backup.json')).toString()).running === true, 'the manifest says it was made while the server ran');
  await stopStandIn(child);

  for (const [mode, label, code] of [['silent', 'does not answer save-off', 'noAnswer'], ['noFlush', 'does not say it has saved', 'noAnswer'], ['forged', 'has a player type "Saved the game" into chat', 'noAnswer']]) {
    child = await startStandIn(mode);
    const before = zips().length;
    const err = await errOf(() => R.backup(srv, { reason: 'manual' }));
    await sleep(300);
    check(err?.code === code && commands().at(-1) === 'save-on' && zips().length === before,
      `a server that ${label} gets no backup and a message saying why, and save-on all the same (${err?.message}; ${S(commands())})`);
    await stopStandIn(child);
  }

  child = await startStandIn('alreadyOff');
  await R.backup(srv, { reason: 'manual' });
  await sleep(300);
  check(S(commands()) === S(['save-off', 'save-all flush']), `when saving was already off (a plugin or the user turned it off), it is left off afterwards (${S(commands())})`);
  await stopStandIn(child);

  // A pack long enough to cancel, and to stop the server under.
  write(path.join(srv, 'world', 'region', 'r.1.1.mca'), crypto.randomBytes(120 << 20));
  for (const how of ['cancel', 'stop']) {
    child = await startStandIn('ok');
    const before = zips().length;
    const job = `job-${how}`;
    const pending = errOf(() => R.backup(srv, { reason: 'manual', job }));
    for (let i = 0; i < 200 && !sent.some((m) => m.job === job && m.phase === 'packing' && m.done > 0); i++) await sleep(25);
    if (how === 'cancel') R.cancel(job); else child.stdin.write('stop\n');
    const err = await pending;
    await sleep(500);
    check((how === 'cancel' ? err?.code === 'cancelled' && commands().at(-1) === 'save-on' : err?.code === 'stopped' && commands().at(-1) === 'stop') && zips().length === before,
      `${how === 'cancel' ? 'Cancel during the pack throws the partial file away and sends save-on' : 'a server that stops during the pack writes its world, so that backup is thrown away and the user told'} (${err?.code}: ${err?.message}; ${S(commands())}; ${before} -> ${zips().length} files)`);
    await stopStandIn(child);
  }

  // A stop sent while a backup runs (main marks every server it starts: markStops). A stopping server is sent nothing
  // more, so its 60 s of silence are not re-armed, and its stop saves the world whether saving is off or not. The stand-in
  // ignores "stop" and prints no "Stopping the server": only the stdin line says it is stopping.
  const killHang = (c) => new Promise((r) => { if (c.exitCode !== null) { r(); return; } c.once('exit', r); c.kill(); });
  for (const at of ['pausing', 'packing']) {
    child = await startStandIn('hangStop');
    const before = zips().length;
    const job = `job-stop-${at}`;
    const pending = errOf(() => R.backup(srv, { reason: 'manual', job }));
    for (let i = 0; i < 400 && !sent.some((m) => m.job === job && m.phase === at && (at === 'pausing' || m.done > 0)); i++) await sleep(25);
    const t0 = Date.now();
    child.stdin.write('stop\n');
    const err = await pending;
    const took = Date.now() - t0;
    await sleep(1000);
    check(err?.code === 'stopped' && took < 1000 && S(commands().slice(commands().indexOf('stop'))) === S(['stop']) && !commands().includes('save-on') && zips().length === before,
      `Stop while a backup is ${at === 'pausing' ? 'waiting for save-off' : 'packing'} ends the backup at once, throws it away and sends the stopping server nothing more (${err?.code} in ${took} ms; ${S(commands())}; ${before} -> ${zips().length} files)`);
    const refused = await errOf(() => R.backup(srv, { reason: 'manual' }));
    await sleep(300);
    check(refused?.code === 'stopping' && S(commands().slice(commands().indexOf('stop'))) === S(['stop']), `a backup asked for while it stops is refused, and nothing is sent (${refused?.code}: ${refused?.message})`);
    await killHang(child);
  }
  // A server that crashes while it is packed: thrown away, nothing sent to the dead process.
  child = await startStandIn('ok');
  {
    const before = zips().length;
    const pending = errOf(() => R.backup(srv, { reason: 'manual', job: 'job-crash' }));
    for (let i = 0; i < 400 && !sent.some((m) => m.job === 'job-crash' && m.phase === 'packing' && m.done > 0); i++) await sleep(25);
    child.kill();
    const err = await pending;
    await sleep(300);
    check(err?.code === 'stopped' && commands().at(-1) === 'save-all flush' && zips().length === before,
      `a server that crashes during the pack: the backup is thrown away and the user told (${err?.code}; ${S(commands())}; ${before} -> ${zips().length} files)`);
  }
  // The schedule: due at once here, it backs up a running server, and not one that is stopping.
  {
    const RS = make({ times, isRunning: () => true, firstCheckMs: 300, now: () => clock + 100 * 24 * 3600e3 });
    const spawnFor = (mode) => {
      rmSync(path.join(srv, 'commands.log'), { force: true });
      const c = spawn(process.execPath, [standIn], { cwd: srv, env: { ...process.env, MODE: mode }, stdio: ['pipe', 'pipe', 'inherit'] });
      holders.push(c);
      markStops(c);
      return new Promise((resolve) => { c.stdout.once('data', () => resolve(c)); });
    };
    rmSync(path.join(srv, 'world', 'region', 'r.1.1.mca'));
    const had = new Set(zips());
    let c = await spawnFor('ok');
    RS.attach(srv, c);
    for (let i = 0; i < 80 && !commands().includes('save-on'); i++) await sleep(50);
    check(commands()[0] === 'save-off', `a scheduled backup that is due runs while the server runs (${S(commands())})`);
    await stopStandIn(c);
    await sleep(300);
    for (const n of zips()) if (!had.has(n)) rmSync(path.join(srv, 'backups', n));
    c = await spawnFor('hangStop');
    RS.attach(srv, c);
    c.stdin.write('stop\n');
    await sleep(1500);
    check(S(commands()) === S(['stop']), `a scheduled backup that falls due while the server stops is not made, and nothing is sent to it (${S(commands())})`);
    await killHang(c);
  }

  // ---------- through main/features/minecraft.js ----------
  {
    process.env.PYIDE_TRUST_ALL = '1';
    const load = Module._load;
    const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => work, on() {}, isPackaged: false, getVersion: () => '0.3.28', getName: () => 'test' } : class {}) });
    Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
    const feature = require('../main/features/minecraft.js');
    Module._load = load;
    const hs = new Map();
    const procs = new Map();
    let n = 0;
    const startProcess = (cmd, args, opts) => { const c = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, MODE: 'ok' } }); holders.push(c); procs.set(++n, c); return n; };
    feature.register({ ipcMain: { handle: (h, fn) => hs.set(h, fn), on() {} }, send() {}, startProcess, procs, diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
    feature.backups.connect({ trash: async (f) => rmSync(f) });
    const call = (name, ...args) => hs.get(name)({}, ...args);
    rmSync(path.join(srv, 'commands.log'), { force: true });
    const id = await call('minecraft:start', proj, { cmd: process.execPath, args: [standIn], cwd: srv });
    await sleep(800);
    const viaIpc = await call('minecraft:backupNow', proj, srv, { reason: 'market' });
    const list2 = await call('minecraft:backups', proj, srv);
    check(viaIpc.ok && viaIpc.reason === 'market' && S(commands()) === S(['save-off', 'save-all flush', 'save-on']) && list2.items.some((i) => i.file === viaIpc.file && i.reason === 'market'),
      `minecraft:backupNow on a server minecraft:start started holds its saves the same way (${S(commands())}; ${S({ ok: viaIpc.ok, reason: viaIpc.reason, file: path.basename(viaIpc.file || ''), listed: list2.items.map((i) => i.name) })})`);
    const outside = await errOf(() => call('minecraft:backups', proj, path.join(work, 'elsewhere')));
    check(/not a server of this project/.test(outside?.message || ''), 'a folder outside the project\'s servers/ is refused');
    const running = await call('minecraft:backupRestore', proj, srv, viaIpc.file);
    check(running.ok === false && running.code === 'running', `Restore is refused while the server runs (${running?.message})`);
    procs.get(id).stdin.write('stop\n');
    await new Promise((r) => { procs.get(id).once('exit', r); setTimeout(r, 3000); });
    await sleep(300);
    const big = path.join(srv, 'world', 'region', 'r.2.2.mca');
    write(big, crypto.randomBytes(80 << 20));
    const slow = call('minecraft:backupNow', proj, srv, { reason: 'manual', job: 'slow' });
    await sleep(150);
    const refusedStart = await errOf(() => call('minecraft:start', proj, { cmd: process.execPath, args: [standIn], cwd: srv }));
    await call('minecraft:backupCancel', 'slow');
    const cancelled = await slow;
    check(refusedStart?.code === 'busy' && /being backed up/.test(refusedStart.message) && cancelled.ok === false && cancelled.code === 'cancelled',
      `a start while the stopped server is being backed up is refused saying why, and minecraft:backupCancel ends the backup (${refusedStart?.message})`);
    rmSync(big);
  }

  // ---------- the event loop while 300 MB is packed ----------
  if (!QUICK) {
    const big = path.join(work, 'bigworld');
    const world = path.join(big, 'world');
    write(path.join(big, 'pyide-server.json'), S(desc));
    write(path.join(big, 'server.properties'), 'level-name=world\n');
    // Region files as the game leaves them: chunks compressed already, in 4 KB sectors with the rest zero.
    for (let i = 0; i < 280; i++) {
      const b = Buffer.alloc(1 << 20);
      for (let s = 0; s < 256; s++) crypto.randomFillSync(b, s * 4096, 2600);
      write(path.join(world, 'region', `r.${i}.0.mca`), b);
    }
    for (let i = 0; i < 4000; i++) write(path.join(world, 'playerdata', `${i}.dat`), crypto.randomBytes(5000));
    const P = make();
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const t0 = process.hrtime.bigint();
    const made = await P.backup(big, { reason: 'manual' });
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    h.disable();
    const bytes = JSON.parse((await readOut(made.file, 'nano-backup.json')).toString()).bytes;
    const maxMs = h.max / 1e6;
    const p99 = h.percentile(99) / 1e6;
    console.log(`MEASURE pack ${(bytes / 1048576).toFixed(0)} MB, 4,280 files in ${secs.toFixed(2)} s = ${(bytes / 1048576 / secs).toFixed(0)} MB/s, archive ${(made.size / 1048576).toFixed(0)} MB; event loop delay p50 ${(h.percentile(50) / 1e6).toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${maxMs.toFixed(1)} ms`);
    check(maxMs < 250, `the event loop keeps turning while 300 MB is packed: its longest stall is ${maxMs.toFixed(0)} ms (p99 ${p99.toFixed(0)} ms)`);
  }
} catch (err) {
  check(false, `suite error: ${err.stack}`);
} finally {
  for (const h of holders) try { h.kill(); } catch {}
}
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
