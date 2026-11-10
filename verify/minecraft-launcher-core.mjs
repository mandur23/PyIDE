// Nano Studio Craft's launcher core (main/minecraft/launcher.js) in plain Node: no Electron, no network, no real
// launcher (a Node script that exits stands in for it), no game. Checks: launcher_profiles.json with a UTF-8 BOM keeps
// the user's profiles, a profiles field that is not an object is backed up before it is replaced, snapshot ids are
// refused for instances and packs, join codes are found in pasted text with punctuation around them, a join code's
// pack is https only and not on a private address, and a pack's files come over https from the hosts Modrinth's format
// allows, or from the PYIDE_MC_SOURCES stand-in's origin only. Then what goes wrong: a mod held by a running game (a
// real exclusive lock from PowerShell), a sync that crashed half-way, staging folders left behind, a dead mirror, a
// pack too large for the disk, a pack that cannot be fetched, damaged instances, one name made twice at once, a broken
// servers list. An instance's mods into Korean: its own resource pack, options.txt turning it on, a running game. Consent: a server's pack applied only after the user agrees to its SHA-1, asked again when it changes,
// and typed pack addresses under the join code's rule. Archives that lie about their sizes or share their data, and a
// server's modpack keeping to the allowed hosts. The Store launcher (no --workDir, its own profiles file), the server
// list ping against stand-in TCP servers (real answers and garbage), retries of a service, a download's limit and the
// pack file server. Then the servers' main side (main/features/minecraft.js, Electron stubbed, stand-in services): what
// a quit sends a server, Velocity forwarding for each Paper version and undone with the last proxy, the Market while a
// server runs and a dependency that fails, a modpack server's client pack with added mods, one Java download for two
// starts, a damaged ko_kr.json, and a create cut off half-way.
// Usage: node verify/minecraft-launcher-core.mjs
import { spawn } from 'child_process';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import http from 'http';
import Module, { createRequire } from 'module';
import net from 'net';
import { networkInterfaces, tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');
const errOf = async (step) => { try { await step(); return null; } catch (err) { return err; } };
const readJsonEntry = (file) => require('../main/minecraft/zipfile.js').readEntry(file, 'modrinth.index.json').toString('utf8');

const work = mkdtempSync(path.join(tmpdir(), 'pyide-mclauncher-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
delete process.env.PYIDE_MC_SOURCES;
// Names are looked up in this stand-in (main/minecraft/hosts.js), never in the real DNS, which would also fail the run.
process.env.PYIDE_MC_DNS = S({ 'packs.example': ['203.0.113.10'], 'packs.redirect.test': ['203.0.113.11'], 'loop.example.test': ['127.0.0.1'], 'lan.example.test': ['203.0.113.12', '192.168.1.20'] });
const realDns = [];
{
  const dns = require('dns');
  dns.promises.lookup = async (name) => { realDns.push(name); throw new Error(`the real DNS was asked for ${name}`); };
  dns.promises.resolveSrv = async (name) => { realDns.push(name); throw new Error(`the real DNS was asked for ${name}`); };
}
const noop = path.join(work, 'launcher.cjs');
write(noop, '');
process.env.PYIDE_MC_LAUNCHER = S([process.execPath, noop]);

const L = require('../main/minecraft/launcher.js');
const { writeZip } = require('../main/minecraft/zipfile.js');
const served = new Map();
const fetched = [];
const fetchFile = async (url, dest) => {
  fetched.push(url);
  if (!served.has(url)) throw new Error(`no stand-in serves ${url}`);
  write(dest, served.get(url));
};
const never = () => { throw new Error('nothing here installs Java or runs an installer'); };
const craft = L.createLauncher({ fetchFile, ensureJava: never, javaFor: never, run: never, retried: never });
const logs = [];
const log = (t) => logs.push(t);

const root = path.join(work, 'project');
const launcherDir = path.join(root, '.launcher');
const profilesFile = path.join(launcherDir, 'launcher_profiles.json');
const broken = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.includes('.broken-')) : []);

try {
  write(profilesFile, `﻿${S({ profiles: { abc123: { name: 'Mine', type: 'custom', lastVersionId: '1.20.1' } }, settings: { locale: 'ko-kr' }, version: 3 }, null, 2)}`);
  await craft.create(root, { name: 'bom', mc: '1.20.1' }, log);
  logs.length = 0;
  const played = await craft.play(root, 'bom', { server: 'play.example.test:25570' }, log);
  const pf = readJson(profilesFile);
  check(played.launched && pf.profiles.abc123?.name === 'Mine' && pf.profiles['nano-bom'] && pf.settings.locale === 'ko-kr' && broken(launcherDir).length === 0,
    `launcher_profiles.json with a UTF-8 BOM is read: the user's profile and settings stay, nothing is set aside as broken (${S(Object.keys(pf.profiles))})`);
  // Memory, changed after the instance was made: the next Play writes it into the profile.
  const mem = craft.setMemory(root, 'bom', '6g');
  await craft.play(root, 'bom', { server: 'play.example.test:25570' }, log);
  const badMem = await errOf(() => craft.setMemory(root, 'bom', 'lots'));
  const noInst = await errOf(() => craft.setMemory(root, 'nobody', '4G'));
  check(pf.profiles['nano-bom'].javaArgs === '-Xmx4G' && mem.memory === '6G' && readJson(profilesFile).profiles['nano-bom'].javaArgs === '-Xmx6G' && /number of M or G/.test(badMem?.message || '')
    && noInst?.code === 'noInstance' && readJson(path.join(root, 'instances', 'bom', 'nano-instance.json')).memory === '6G',
    `setMemory changes an instance's memory for the next Play and refuses what is not a size (${readJson(profilesFile).profiles['nano-bom'].javaArgs}; ${badMem?.message})`);
  const v = readJson(path.join(launcherDir, 'versions', 'nano-bom', 'nano-bom.json'));
  check(S(v.arguments) === S({ game: ['--quickPlayMultiplayer', 'play.example.test:25570'] }), `a 1.20.1 instance still joins with Quick Play (${S(v.arguments)})`);
  const playLog = logs.join('');
  check(/Starting the Minecraft Launcher/.test(playLog) && !/Sign in/.test(playLog), `Play's job log names the start and leaves the sign-in hint to the renderer, in the UI's language (${S(playLog)})`);

  const odd = path.join(work, 'odd');
  const arrayProfiles = S({ profiles: ['kept'], settings: { locale: 'ko-kr' }, version: 3 });
  write(path.join(odd, 'a', 'launcher_profiles.json'), arrayProfiles);
  const a = L.readProfiles(path.join(odd, 'a', 'launcher_profiles.json'));
  const backups = broken(path.join(odd, 'a'));
  check(S(a.profiles) === '{}' && a.settings.locale === 'ko-kr' && backups.length === 1 && readFileSync(path.join(odd, 'a', backups[0]), 'utf8') === arrayProfiles,
    `a valid file whose profiles is not an object is backed up before profiles is replaced (${S(backups)})`);
  write(path.join(odd, 'b', 'launcher_profiles.json'), S({ settings: {}, version: 3 }));
  check(S(L.readProfiles(path.join(odd, 'b', 'launcher_profiles.json')).profiles) === '{}' && broken(path.join(odd, 'b')).length === 0, 'a file without profiles gets an empty set and no backup: nothing was lost');
  write(path.join(odd, 'c', 'launcher_profiles.json'), '{ "profiles": ');
  check(S(L.readProfiles(path.join(odd, 'c', 'launcher_profiles.json')).profiles) === '{}' && broken(path.join(odd, 'c')).length === 1, 'a file that is not JSON is still backed up');

  const snap = await errOf(() => craft.create(root, { name: 'snap', mc: '24w14a' }, log));
  check(/24w14a/.test(snap?.message || '') && /release/.test(snap.message) && !existsSync(path.join(root, 'instances', 'snap')),
    `a snapshot id is refused for a new instance, before its folder is made (${snap?.message})`);
  const pack = (mc, files) => {
    const file = path.join(work, 'packs', `${crypto.randomBytes(4).toString('hex')}.mrpack`);
    write(file, writeZip([{ name: 'modrinth.index.json', data: Buffer.from(S({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Core Pack', dependencies: { minecraft: mc }, files })) }]));
    return file;
  };
  const mod = (name, downloads) => {
    const data = Buffer.from(`mod ${name}`);
    for (const u of downloads) served.set(u, data);
    return { path: `mods/${name}`, downloads, hashes: { sha512: sha512(data) }, fileSize: data.length };
  };
  const snapPack = await errOf(() => craft.fromPack(root, { file: pack('24w14a', []), name: 'snappack' }, log));
  check(/24w14a/.test(snapPack?.message || '') && snapPack.code === 'badPack' && !existsSync(path.join(root, 'instances', 'snappack')), `a pack for a snapshot is refused (${snapPack?.message})`);
  const pre = await errOf(() => craft.create(root, { name: 'pre', mc: '1.21-pre1' }, log));
  check(/release/.test(pre?.message || ''), `a pre-release id is refused too (${pre?.message})`);

  const inText = [
    ['join me: nanostudio:join?addr=play.example.com:25565.', 'play.example.com:25565'],
    ['(nanostudio:join?addr=play.example.com)', 'play.example.com'],
    ['"nanostudio:join?addr=play.example.com:25566", he said', 'play.example.com:25566'],
    ['<nanostudio:join?addr=[::1]:25567>!', '[::1]:25567'],
    ['come play nanostudio:join?addr=play.example.com:25568!?', 'play.example.com:25568'],
  ].map(([t, want]) => { try { return [t, L.parseJoinCode(t).address, want]; } catch (err) { return [t, err.message, want]; } });
  check(inText.every(([, got, want]) => got === want), `a join code is found in text with punctuation, quotes, parens or <> around it (${S(inText.map(([, got]) => got))})`);
  const name = "Bob's (best) server!";
  const shared = 'https://abc-def.trycloudflare.com/Core%20Pack.mrpack';
  const code = L.joinCode({ address: 'mc.example.test:25580', pack: shared, name });
  const back = L.parseJoinCode(`(${code}).`);
  check(back.name === name && back.pack === shared && back.address === 'mc.example.test:25580' && !/[\s"'()<>!]/.test(code),
    `a join code survives parens and a full stop around it, a name with quotes, parens and "!" included (${code})`);

  const httpPack = await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('http://192.168.0.5:8000/p.mrpack')}`));
  const loopPack = await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('http://127.0.0.1:5999/p.mrpack')}`));
  check(httpPack?.code === 'badPack' && loopPack?.code === 'badPack', `a join code's pack over plain http is refused, LAN or loopback (${httpPack?.message})`);
  check(await errOf(() => L.joinCode({ address: 'a.test', pack: 'http://192.168.0.5:8000/p.mrpack' })) && L.parseJoinCode(L.joinCode({ address: 'a.test', pack: shared })).pack === shared,
    'joinCode makes only codes that parseJoinCode accepts: https packs');

  const files = (downloads) => craft.fromPack(root, { file: pack('1.20.1', [mod(`${crypto.randomBytes(3).toString('hex')}.jar`, downloads)]), name: 'files' }, log);
  const refused = [];
  for (const u of ['http://cdn.modrinth.com/data/a.jar', 'https://evil.example/a.jar', 'https://127.0.0.1/a.jar', 'https://192.168.0.5/a.jar', 'https://cdn.modrinth.com.evil.example/a.jar', 'http://127.0.0.1:5999/files/a.jar']) {
    const before = fetched.length;
    const err = await errOf(() => files([u]));
    refused.push([u, err?.code === 'badPack' && fetched.length === before && !existsSync(path.join(root, 'instances', 'files'))]);
  }
  check(refused.every(([, ok]) => ok), `pack files over http, from other hosts, loopback or LAN are refused before anything is downloaded (${S(refused)})`);
  const allowed = [];
  for (const u of ['https://cdn.modrinth.com/data/AABB/versions/1/a.jar', 'https://github.com/o/r/releases/download/v1/a.jar', 'https://raw.githubusercontent.com/o/r/main/a.jar', 'https://gitlab.com/o/r/-/raw/main/a.jar']) {
    const inst = await files([u]);
    allowed.push([u, fetched.at(-1) === u && inst.pack.files.length === 1]);
    await craft.remove(root, inst.name);
    rmSync(inst.dir, { recursive: true, force: true });
  }
  check(allowed.every(([, ok]) => ok), `pack files from cdn.modrinth.com, github.com, raw.githubusercontent.com and gitlab.com over https are downloaded (${S(allowed)})`);
  const mixed = await files(['http://10.0.0.1/a.jar', 'https://github.com/o/r/releases/download/v1/b.jar']);
  check(fetched.at(-1) === 'https://github.com/o/r/releases/download/v1/b.jar', 'of several download addresses the first allowed one is used');
  await craft.remove(root, mixed.name);
  rmSync(mixed.dir, { recursive: true, force: true });

  process.env.PYIDE_MC_SOURCES = S({ modrinth: 'http://127.0.0.1:5999/modrinth', mojang: 'http://127.0.0.1:5999/mojang/manifest.json' });
  const standIn = await files(['http://127.0.0.1:5999/files/a.jar']);
  check(fetched.at(-1) === 'http://127.0.0.1:5999/files/a.jar' && standIn.pack.files.length === 1, 'with PYIDE_MC_SOURCES a pack file may come from the stand-in\'s origin');
  await craft.remove(root, standIn.name);
  rmSync(standIn.dir, { recursive: true, force: true });
  const otherPort = await errOf(() => files(['http://127.0.0.1:6000/files/a.jar']));
  const otherHost = await errOf(() => files(['http://localhost:5999/files/a.jar']));
  check(otherPort?.code === 'badPack' && otherHost?.code === 'badPack', 'but not from another port or host: the stand-in is no general bypass');
  check(L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('http://127.0.0.1:5999/packs/p.mrpack')}`).pack === 'http://127.0.0.1:5999/packs/p.mrpack'
    && (await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('http://127.0.0.1:6000/packs/p.mrpack')}`)))?.code === 'badPack',
  'a join code\'s pack may be on the stand-in\'s origin, and only there');
  delete process.env.PYIDE_MC_SOURCES;

  const privatePacks = [];
  for (const host of ['localhost', 'localhost.', 'router.local', '127.0.0.1', '2130706433', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '[::1]', '[::]', '[fd00::1]']) {
    privatePacks.push([host, (await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent(`https://${host}/p.mrpack`)}`)))?.code]);
  }
  check(privatePacks.every(([, code]) => code === 'badPack'), `a join code's pack on this computer or its network is refused, https or not (${S(privatePacks)})`);
  check(L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('https://172.32.0.1/p.mrpack')}`).pack, 'a public address beside a private range is accepted');

  // ---------- a pack that changes under a running game ----------
  const agreed = async (req) => {
    const r = await craft.join(root, req, log);
    return r.needsApproval ? craft.join(root, { ...req, approve: r.needsApproval.sha1 }, log) : r;
  };
  const syncPackFile = (v, mods) => {
    const file = pack('1.20.1', mods);
    served.set(`https://packs.example/p${v}.mrpack`, readFileSync(file));
    return `https://packs.example/p${v}.mrpack`;
  };
  const instDir = (name) => path.join(root, 'instances', name);
  const lockFile = (file) => new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => resolve(child));
    child.once('error', reject);
  });
  const lockA = mod('lock-a.jar', ['https://cdn.modrinth.com/lock/a.jar']);
  const lockB = mod('lock-b.jar', ['https://cdn.modrinth.com/lock/b.jar']);
  const lockC = mod('lock-c.jar', ['https://cdn.modrinth.com/lock/c.jar']);
  const url1 = syncPackFile(1, [lockA, lockB]);
  const url2 = syncPackFile(2, [lockB, lockC]);
  const joined = await agreed({ address: 'lock.example.test:25565', pack: url1, name: 'lock' });
  const lockName = joined.instance.name;
  const before = readJson(path.join(instDir(lockName), 'nano-instance.json'));
  const holder = await lockFile(path.join(instDir(lockName), 'mods', 'lock-a.jar'));
  const inUse = await errOf(() => agreed({ address: 'lock.example.test:25565', pack: url2, name: 'lock' }));
  const after = readJson(path.join(instDir(lockName), 'nano-instance.json'));
  const leftAlone = readdirSync(path.join(instDir(lockName), 'mods')).sort();
  check(inUse?.code === 'inUse' && /lock-a\.jar is in use/.test(inUse.message) && S(leftAlone) === S(['lock-a.jar', 'lock-b.jar']) && after.pack.sha1 === before.pack.sha1
    && !readdirSync(instDir(lockName)).some((n) => n.startsWith('.pack-')),
  `a mod the running game holds stops the sync with nothing changed, and says which file (${inUse?.message}; ${S(leftAlone)})`);
  const lockedMod = await errOf(() => craft.setMod(root, lockName, 'lock-a.jar', false));
  check(lockedMod?.code === 'inUse', `turning off a mod the game holds says it is in use (${lockedMod?.message})`);
  holder.kill();
  await new Promise((r) => { holder.once('exit', r); });
  const synced = await agreed({ address: 'lock.example.test:25565', pack: url2, name: 'lock' });
  check(!synced.stale && S(readdirSync(path.join(instDir(lockName), 'mods')).sort()) === S(['lock-b.jar', 'lock-c.jar']), 'once the game is closed the same sync goes through');

  const url3 = syncPackFile(3, [lockB]);
  const half = readJson(path.join(instDir(lockName), 'nano-instance.json'));
  write(path.join(instDir(lockName), 'nano-instance.json'), S({ ...half, pack: { ...half.pack, sha1: null, files: [...half.pack.files, 'mods/from-a-crash.jar'] } }));
  write(path.join(instDir(lockName), 'mods', 'from-a-crash.jar'), 'half a sync');
  write(path.join(instDir(lockName), 'mods', 'mine.jar'), 'the user\'s');
  const staleStaging = path.join(instDir(lockName), '.pack-crashed');
  const freshStaging = path.join(instDir(lockName), '.pack-other-window');
  write(path.join(staleStaging, 'old-0'), 'x');
  write(path.join(freshStaging, 'old-0'), 'x');
  utimesSync(staleStaging, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
  await agreed({ address: 'lock.example.test:25565', pack: url3, name: 'lock' });
  check(S(readdirSync(path.join(instDir(lockName), 'mods')).sort()) === S(['lock-b.jar', 'mine.jar']) && !existsSync(staleStaging) && existsSync(freshStaging),
    'a sync that crashed half-way is finished by the next one: its files go, the user\'s stay, and only old staging folders are swept');
  rmSync(freshStaging, { recursive: true, force: true });

  // ---------- nothing of a server's pack before the user agrees ----------
  const packed = (mods, entries = {}) => writeZip([{ name: 'modrinth.index.json', data: Buffer.from(S({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Friend Pack', dependencies: { minecraft: '1.20.1' }, files: mods })) },
    ...Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) }))]);
  const askedUrl = 'https://packs.example/asked.mrpack';
  const fileA = mod('asked-a.jar', ['https://cdn.modrinth.com/asked/a.jar']);
  const fileB = mod('asked-b.jar', ['https://cdn.modrinth.com/asked/b.jar']);
  served.set(askedUrl, packed([fileA], { 'overrides/mods/inside.jar': 'code nobody checked', 'overrides/config/a.toml': 'x=1', 'client-overrides/mods/automodpack-4.jar': 'more code' }));
  const fetchedBefore = fetched.length;
  const askReq = { address: 'asked.example.test:25565', pack: askedUrl, name: 'Asked' };
  const first = await craft.join(root, askReq, log);
  const shown = first.needsApproval;
  check(shown?.host === 'packs.example' && !shown.update && shown.autoModpack === true && shown.others === 1 && S(shown.mods.map((m) => [m.file, m.inPack])) === S([['mods/asked-a.jar', false], ['mods/inside.jar', true], ['mods/automodpack-4.jar', true]]),
    `a server's pack first answers with its host and every jar, marking those inside the pack and AutoModpack (${S(shown)})`);
  check(!fetched.slice(fetchedBefore).includes(fileA.downloads[0]) && !existsSync(instDir('Asked')) && !craft.servers(root).some((s) => s.address === askReq.address) && !readdirSync(path.join(root, 'instances')).includes('Asked'),
    'before the user agrees no mod is downloaded, no instance made and no server saved');
  check((await craft.join(root, { ...askReq, approve: '0'.repeat(40) }, log)).needsApproval, 'approving some other pack approves nothing');
  const yes = await craft.join(root, { ...askReq, approve: shown.sha1 }, log);
  const askedName = yes.instance.name;
  const mine = () => craft.servers(root).find((s) => s.address === askReq.address);
  check(existsSync(path.join(instDir(askedName), 'mods', 'asked-a.jar')) && existsSync(path.join(instDir(askedName), 'mods', 'inside.jar')) && mine().approved === shown.sha1, `the SHA-1 agreed to is applied and pinned on the server (${mine().approved})`);
  const quietPlay = await craft.play(root, askedName, { server: askReq }, log);
  check(quietPlay.launched && !quietPlay.needsApproval, 'Play of the same pack asks nothing');
  served.set(askedUrl, packed([fileA, fileB], { 'overrides/mods/inside.jar': 'other code' }));
  const swapped = await craft.play(root, askedName, { server: askReq }, log);
  const stayed = readFileSync(path.join(instDir(askedName), 'mods', 'inside.jar'), 'utf8');
  check(swapped.launched === false && swapped.needsApproval?.update === true && S(swapped.needsApproval.mods.filter((m) => m.added).map((m) => m.file)) === S(['mods/asked-b.jar']) && stayed === 'code nobody checked'
    && !existsSync(path.join(instDir(askedName), 'mods', 'asked-b.jar')) && mine().approved === shown.sha1,
  `when the address starts serving something else Play stops and asks again, naming what is new, and declining leaves the instance as it was (${S(swapped.needsApproval?.mods)})`);
  const applied = await craft.play(root, askedName, { server: askReq, approve: swapped.needsApproval.sha1 }, log);
  check(applied.launched && existsSync(path.join(instDir(askedName), 'mods', 'asked-b.jar')) && mine().approved === swapped.needsApproval.sha1, 'agreeing applies it and pins the new SHA-1');
  await craft.remove(root, askedName);
  rmSync(instDir(askedName), { recursive: true, force: true });
  const again = await craft.join(root, askReq, log);
  check(!again.needsApproval && again.instance, 'a pinned pack is not asked about again when its instance is made anew');
  const typedHttp = await errOf(() => craft.join(root, { address: 'typed.example.test', pack: 'http://packs.example/p.mrpack' }, log));
  const typedPrivate = await errOf(() => craft.join(root, { address: 'typed.example.test', pack: 'https://192.168.0.5/p.mrpack' }, log));
  const urlHttp = await errOf(() => craft.fromPack(root, { url: 'http://packs.example/p.mrpack' }, log));
  check(typedHttp?.code === 'badPack' && typedPrivate?.code === 'badPack' && urlHttp?.code === 'badPack', `a typed pack address follows the join code's rule: https, not private (${typedHttp?.message}; ${urlHttp?.message})`);

  // ---------- archives ----------
  const { openZip, unpackZip } = require('../main/minecraft/zipfile.js');
  const handZip = (entries, data) => {
    const locals = [];
    const central = [];
    for (const e of entries) {
      const n = Buffer.from(e.name);
      if (e.local !== false) {
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(e.method, 8); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(e.size, 22); head.writeUInt16LE(n.length, 26);
        locals.push(head, n, data);
      }
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(e.method, 10); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(e.size, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(e.at ?? 0, 42);
      central.push(dir, n);
    }
    const body = Buffer.concat(locals);
    const dirBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(body.length, 16);
    return Buffer.concat([body, dirBytes, end]);
  };
  const zipFile = (name, bytes) => { const p = path.join(work, 'zips', name); write(p, bytes); return p; };
  const blob = Buffer.alloc(1024 * 1024, 7);
  const overlapping = zipFile('overlap.zip', handZip([{ name: 'a.bin', method: 0, size: 0 }, ...Array.from({ length: 300 }, (_v, i) => ({ name: `b${i}.bin`, method: 0, size: 0, local: false }))], blob));
  const overlapErr = await errOf(() => openZip(overlapping));
  check(/overlap/.test(overlapErr?.message || ''), `a zip whose 300 entries share one blob is refused (${overlapErr?.message})`);
  const lying = zipFile('lying.zip', handZip([{ name: 'a.bin', method: 0, size: 0 }], blob));
  const lieDir = path.join(work, 'zips', 'out');
  const lieErr = await errOf(() => unpackZip(lying, lieDir));
  check(/damaged/.test(lieErr?.message || '') && !existsSync(path.join(lieDir, 'a.bin')), `a stored entry that holds more than it declares is refused, so the size limits cannot be walked around (${lieErr?.message})`);
  const manyFiles = zipFile('many.zip', writeZip(Array.from({ length: 50001 }, (_v, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }))));
  const manyErr = await errOf(() => unpackZip(manyFiles, path.join(work, 'zips', 'many')));
  check(/50001 files/.test(manyErr?.message || '') && !existsSync(path.join(work, 'zips', 'many')), `a zip of too many files writes nothing (${manyErr?.message})`);
  const fair = zipFile('fair.zip', writeZip([{ name: 'a.txt', data: Buffer.from('a') }, { name: 'b.txt', data: Buffer.from('b'.repeat(4096)) }, { name: 'empty.txt', data: Buffer.alloc(0) }]));
  unpackZip(fair, path.join(work, 'zips', 'fair'));
  check(readFileSync(path.join(work, 'zips', 'fair', 'b.txt'), 'utf8').length === 4096 && existsSync(path.join(work, 'zips', 'fair', 'empty.txt')), 'an honest zip, an empty file in it, still unpacks');

  // ---------- a server from a modpack ----------
  const { createImports } = require('../main/minecraft/imports.js');
  const serverPack = pack('1.20.1', [{ path: 'mods/s.jar', downloads: ['https://evil.example/s.jar'], hashes: { sha1: '0'.repeat(40) }, fileSize: 1 }]);
  const fabricPack = path.join(work, 'server-pack.mrpack');
  write(fabricPack, writeZip([{ name: 'modrinth.index.json', data: Buffer.from(S({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Server Pack', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
    files: JSON.parse(readJsonEntry(serverPack)).files })) }]));
  let created = 0;
  const imports = createImports({ root: path.join(work, 'imports'), servers: () => [], create: () => { created++; }, javaFor: never, javaOfJar: never, fetchFile, writeServer: never, readServer: never });
  const serverErr = await errOf(() => imports.createFromModpack({ file: fabricPack, name: 'srv', memory: '2G', port: 25565, eula: true }, log));
  check(/no https download address/.test(serverErr?.message || '') && created === 0, `a server's modpack keeps to the hosts Modrinth's format allows, before anything is made (${serverErr?.message})`);

  // ---------- a sync that fails half-way ----------
  const stopUrl = 'https://packs.example/stop.mrpack';
  const stopA = mod('stop-a.jar', ['https://cdn.modrinth.com/stop/a.jar']);
  const stopB = mod('stop-b.jar', ['https://cdn.modrinth.com/stop/b.jar']);
  served.set(stopUrl, packed([stopA], { 'overrides/config/stop.txt': 'one', 'overrides/mods/dup.jar': 'dup 1', 'client-overrides/mods/dup.jar': 'dup 1' }));
  const stopReq = { address: 'stop.example.test:25565', pack: stopUrl, name: 'stop' };
  const stopName = (await agreed(stopReq)).instance.name;
  const stopFile = (...p) => path.join(instDir(stopName), ...p);
  craft.setMod(root, stopName, 'dup.jar', false);
  const broke = packed([stopB], { 'overrides/config/bad.txt': 'hello hello hello', 'overrides/mods/dup.jar': 'dup 2', 'client-overrides/mods/dup.jar': 'dup 2' });
  const brokenName = broke.lastIndexOf(Buffer.from('overrides/config/bad.txt'));
  broke.writeUInt32LE(broke.readUInt32LE(brokenName - 46 + 24) + 1, brokenName - 46 + 24);
  served.set(stopUrl, broke);
  const brokenAsk = (await craft.join(root, stopReq, log)).needsApproval;
  const halfWay = await errOf(() => craft.play(root, stopName, { server: stopReq, approve: brokenAsk.sha1 }, log));
  const marker = readJson(stopFile('nano-instance.json'));
  check(/damaged/.test(halfWay?.message || '') && existsSync(stopFile('mods', 'stop-a.jar')) && readFileSync(stopFile('config', 'stop.txt'), 'utf8') === 'one' && marker.pack.sha1 === null
    && !readdirSync(instDir(stopName)).some((n) => n.startsWith('.pack-')),
  `a pack that breaks after files began to move is an error, not a Play with "the last sync": the old files are put back and the record says the sync is unfinished (${halfWay?.message})`);
  const stillStopped = await errOf(() => { served.delete(stopUrl); return craft.play(root, stopName, { server: stopReq }, log); });
  check(stillStopped && !/launched/.test(S(stillStopped)), `with the sync unfinished an unreachable pack cannot fall back on it (${stillStopped?.message})`);
  const dupFixed = packed([stopB], { 'overrides/mods/dup.jar': 'dup 2', 'client-overrides/mods/dup.jar': 'dup 2' });
  served.set(stopUrl, dupFixed);
  await craft.play(root, stopName, { server: stopReq, approve: (await craft.play(root, stopName, { server: stopReq }, log)).needsApproval.sha1 }, log);
  const finished = readJson(stopFile('nano-instance.json'));
  check(existsSync(stopFile('mods', 'stop-b.jar')) && !existsSync(stopFile('mods', 'stop-a.jar')) && !existsSync(stopFile('config', 'bad.txt')) && !existsSync(stopFile('config', 'stop.txt')) && finished.pack.sha1
    && readFileSync(stopFile('mods', 'dup.jar.disabled'), 'utf8') === 'dup 2' && !existsSync(stopFile('mods', 'dup.jar')),
  'the next good sync finishes the job and clears what the failed one added, and a disabled mod named in both override folders stays disabled');
  const listedDuring = (() => { const going = craft.play(root, stopName, { server: stopReq }, log); const names = craft.instances(root).map((i) => i.name); return { going, names }; })();
  check(listedDuring.names.includes(stopName), 'an instance a job is working on stays listed');
  await listedDuring.going;
  const cancelledLog = Object.assign(() => {}, { signal: AbortSignal.abort() });
  const cancelledPlay = await errOf(() => craft.play(root, stopName, {}, cancelledLog));
  check(cancelledPlay?.name === 'AbortError', 'a job cancelled during steps that cannot be interrupted does not start the launcher');

  // ---------- a pack that cannot be had ----------
  const mirrored = mod('mirror.jar', ['https://github.com/o/r/releases/download/v1/mirror.jar']);
  const mirrorDead = { ...mirrored, downloads: ['https://cdn.modrinth.com/dead/mirror.jar', ...mirrored.downloads] };
  const viaMirror = await craft.fromPack(root, { file: pack('1.20.1', [mirrorDead]), name: 'mirror' }, log);
  check(existsSync(path.join(viaMirror.dir, 'mods', 'mirror.jar')) && fetched.slice(-2).join() === mirrorDead.downloads.join(), `a dead download address moves on to the pack's next one (${S(fetched.slice(-2))})`);
  const wrong = mod('wrong.jar', ['https://cdn.modrinth.com/wrong/a.jar', 'https://github.com/o/r/releases/download/v1/wrong.jar']);
  served.set(wrong.downloads[0], Buffer.from('tampered'));
  const healed = await craft.fromPack(root, { file: pack('1.20.1', [wrong]), name: 'wrong' }, log);
  check(existsSync(path.join(healed.dir, 'mods', 'wrong.jar')), 'a mirror with a wrong checksum moves on to the next one too');
  const large = await errOf(() => craft.fromPack(root, { file: pack('1.20.1', [{ ...mod('huge.jar', ['https://cdn.modrinth.com/huge/a.jar']), fileSize: 2 ** 50 }]), name: 'huge' }, log));
  check(large?.code === 'noSpace' && /Not enough disk space/.test(large.message) && !fetched.includes('https://cdn.modrinth.com/huge/a.jar') && !existsSync(path.join(root, 'instances', 'huge')),
    `a pack that cannot fit is refused before anything is downloaded (${large?.message})`);

  served.delete(url3);
  const down = await agreed({ address: 'lock.example.test:25565', pack: url3, name: 'lock' });
  const playedStale = await craft.play(root, lockName, { server: { address: 'lock.example.test:25565', pack: url3 } }, log);
  check(down.stale === true && playedStale.launched && playedStale.packStale === true && existsSync(path.join(instDir(lockName), 'mods', 'lock-b.jar')),
    `a pack that cannot be fetched (a tunnel that is down) leaves the last sync in place and still plays, and says so (${S({ stale: down.stale, packStale: playedStale.packStale })})`);
  served.set('https://packs.example/not-a-pack', Buffer.from('<html>tunnel error</html>'));
  check((await craft.join(root, { address: 'lock.example.test:25565', pack: 'https://packs.example/not-a-pack', name: 'lock' }, log)).stale === true, 'so does an error page where the pack should be');
  const never2 = await errOf(() => craft.join(root, { address: 'fresh.example.test', pack: 'https://packs.example/gone.mrpack', name: 'fresh' }, log));
  check(never2 && !existsSync(path.join(root, 'instances', 'fresh')) && !craft.servers(root).some((s) => s.address === 'fresh.example.test'), 'with no earlier sync to fall back on it is an error, and leaves nothing');

  // ---------- damage and races ----------
  write(path.join(root, 'instances', 'damaged', 'nano-instance.json'), '{ "mc": ');
  mkdirSync(path.join(root, 'instances', 'empty', 'mods'), { recursive: true });
  write(path.join(root, 'instances', 'nomc', 'nano-instance.json'), S({ name: 'nomc', mc: null, loader: 'vanilla' }));
  const listed = craft.instances(root);
  const damagedOf = (n) => listed.find((i) => i.name === n)?.damaged === true;
  check(['damaged', 'empty', 'nomc'].every(damagedOf) && !listed.find((i) => i.name === lockName).damaged, `a folder that cannot be played is listed as damaged, not hidden (${S(listed.filter((i) => i.damaged).map((i) => i.name))})`);
  const playDamaged = await errOf(() => craft.play(root, 'damaged', {}, log));
  check(playDamaged?.code === 'noInstance', 'Play of a damaged instance is a clear error');

  const meta = http.createServer((q, r) => {
    const body = /loader\/1\.20\.1$/.test(q.url) ? S([{ loader: { version: '0.15.11', stable: true } }]) : S({ id: 'fabric-loader-0.15.11-1.20.1', inheritsFrom: '1.20.1' });
    setTimeout(() => r.end(body), 150);
  });
  await new Promise((resolve) => { meta.listen(0, '127.0.0.1', resolve); });
  process.env.PYIDE_MC_SOURCES = S({ fabric: `http://127.0.0.1:${meta.address().port}` });
  const twice = await Promise.allSettled([1, 2].map(() => craft.create(root, { name: 'twice', mc: '1.20.1', loader: 'fabric' }, log)));
  const madeOnce = twice.filter((r) => r.status === 'fulfilled');
  check(madeOnce.length === 1 && /busy|already exists/.test(twice.find((r) => r.status === 'rejected')?.reason.message || '') && existsSync(path.join(root, 'instances', 'twice', 'nano-instance.json')),
    `the same name made twice at once gives one instance, and the second try does not delete the first's folder (${twice.map((r) => r.reason?.message || 'made').join('; ')})`);
  delete process.env.PYIDE_MC_SOURCES;
  meta.close();

  const removed = path.join(root, 'servers-list.json');
  write(removed, '[ damaged');
  craft.saveServers(root, [{ address: 'one.example.test' }]);
  check(broken(root).length === 1 && readFileSync(path.join(root, broken(root)[0]), 'utf8') === '[ damaged', 'a servers list that cannot be read is kept before it is replaced');

  // ---------- the launcher from the Microsoft Store ----------
  const storeLog = path.join(work, 'store', 'args.json');
  const storeScript = path.join(work, 'store', 'store.cjs');
  write(storeScript, `require('fs').writeFileSync(${S(storeLog)}, JSON.stringify(process.argv.slice(2)));`);
  const storeWork = path.join(work, 'store', '.minecraft');
  // The real Store launcher's log: it loads launcher_profiles.json, and deletes launcher_profiles_microsoft_store.json.
  const storeProfiles = path.join(storeWork, 'launcher_profiles.json');
  write(storeProfiles, S({ profiles: { mine: { name: 'Mine', type: 'custom', lastVersionId: '1.20.1' } }, settings: {}, version: 3 }));
  const packages = path.join(work, 'store', 'Local');
  mkdirSync(path.join(packages, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe'), { recursive: true });
  const installed = L.launchMethod({ LOCALAPPDATA: packages, APPDATA: path.join(work, 'store'), SystemRoot: 'C:\\Windows' });
  check(installed?.id === 'store' && installed.argv[0] === 'C:\\Windows\\explorer.exe' && installed.argv[1] === 'shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft' && S(installed.args('x')) === '[]'
    && path.resolve(installed.work('r')) === path.join(work, 'store', '.minecraft') && L.launchMethod({ LOCALAPPDATA: path.join(work, 'nowhere'), APPDATA: work }) === null,
  `the Store launcher is found by its package folder and started without arguments, which a Store app cannot take (${S(installed?.argv)})`);
  const classicDir = path.join(work, 'store', 'pf', 'Minecraft Launcher');
  write(path.join(classicDir, 'MinecraftLauncher.exe'), '');
  check(L.launchMethod({ LOCALAPPDATA: packages, APPDATA: path.join(work, 'store'), ProgramFiles: path.join(work, 'store', 'pf') })?.id === 'official', 'an installed launcher that takes --workDir comes first');
  const realLauncher = process.env.PYIDE_MC_LAUNCHER;
  process.env.PYIDE_MC_LAUNCHER = 'off';
  process.env.PYIDE_MC_STORE = S({ argv: [process.execPath, storeScript], work: storeWork });
  const viaStore = await craft.play(root, 'bom', { server: 'store.example.test:25566' }, log);
  for (let i = 0; i < 50 && !existsSync(storeLog); i++) await new Promise((r) => { setTimeout(r, 100); });
  const storeProfile = readJson(storeProfiles);
  check(viaStore.launched && viaStore.method === 'store' && S(readJson(storeLog)) === '[]' && storeProfile.profiles.mine?.name === 'Mine' && path.resolve(storeProfile.profiles['nano-bom']?.gameDir || '') === path.join(root, 'instances', 'bom')
    && S(readJson(path.join(storeWork, 'versions', 'nano-bom', 'nano-bom.json')).arguments) === S({ game: ['--quickPlayMultiplayer', 'store.example.test:25566'] }),
  `Play through the Store launcher writes the version into .minecraft and merges the profile into its own file (${S(Object.keys(storeProfile.profiles))})`);
  await craft.remove(root, 'bom');
  check(!readJson(storeProfiles).profiles['nano-bom'] && readJson(storeProfiles).profiles.mine && !existsSync(path.join(storeWork, 'versions', 'nano-bom')) && !readJson(profilesFile).profiles['nano-bom'],
    'Remove takes the profile and version out of both places, and leaves the user\'s profile');
  process.env.PYIDE_MC_LAUNCHER = realLauncher;
  write(path.join(root, 'instances', 'later', 'nano-instance.json'), S({ mc: '1.20.1', loader: 'vanilla' }));
  const storeData = readJson(storeProfiles);
  write(storeProfiles, S({ ...storeData, profiles: { ...storeData.profiles, 'nano-later': { name: 'later' } } }));
  write(path.join(storeWork, 'versions', 'nano-later', 'nano-later.json'), '{}');
  await craft.remove(root, 'later');
  check(!readJson(storeProfiles).profiles['nano-later'] && !existsSync(path.join(storeWork, 'versions', 'nano-later')), 'Remove finds what the Store launcher had even once a launcher that takes --workDir is the one in use');
  delete process.env.PYIDE_MC_STORE;
  const running = path.basename(process.execPath);
  check(await L.launcherOpen({ PYIDE_MC_LAUNCHER_IMAGE: running }) === true && await L.launcherOpen({ PYIDE_MC_LAUNCHER_IMAGE: 'no-such-launcher.exe' }) === false, `a running launcher is told from none by its process name (${running})`);
  check(await L.launcherOpen({ PYIDE_MC_LAUNCHER_IMAGE: running, SystemRoot: path.join(work, 'nowhere') }) === null, 'tasklist runs from the system folder by its full path, so a planted one is never found on the way, and no answer is neither open nor closed');

  // ---------- Korean for an instance's mods ----------
  // translate.js into resourcepacks/Nano Studio Korean, turned on in options.txt; translate is a stand-in for Claude.
  {
    const KO = 'Nano Studio Korean';
    const optionsOf = (name) => path.join(instDir(name), 'options.txt');
    const koPack = (name) => path.join(instDir(name), 'resourcepacks', KO);
    const koFile = (name) => path.join(koPack(name), 'assets', 'tm', 'lang', 'ko_kr.json');
    const textOf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
    const WORDS = { Gem: '보석', 'Ore of %s': '%s 광석', 'Shiny %s': '반짝이는', Ruby: '루비' };
    const asked = [];
    const translate = async (system, prompt) => { asked.push(JSON.parse(prompt)); return `Here: ${S(Object.fromEntries(Object.entries(JSON.parse(prompt)).map(([k, v]) => [k, WORDS[v] || v])))}`; };
    const withMods = async (name, mc = '1.20.1') => {
      await craft.create(root, { name, mc, loader: 'vanilla' }, log);
      write(path.join(instDir(name), 'mods', 'tm.jar'), writeZip([
        { name: 'assets/tm/lang/en_us.json', data: Buffer.from(S({ 'item.tm.gem': 'Gem', 'block.tm.ore': 'Ore of %s', 'item.tm.shiny': 'Shiny %s', 'itemGroup.tm': 'Test Mod' })) },
        { name: 'assets/tm/lang/ko_kr.json', data: Buffer.from(S({ 'itemGroup.tm': '테스트 모드' })) }]));
      write(path.join(instDir(name), 'mods', 'off.jar.disabled'), writeZip([{ name: 'assets/off/lang/en_us.json', data: Buffer.from(S({ 'item.off.a': 'Off' })) }]));
    };
    await withMods('ko');
    const st0 = craft.koreanStatus(root, 'ko');
    const before = await errOf(() => craft.translateKorean(root, 'ko', { translate, log }));
    check(st0.missing === 3 && st0.mods.length === 1 && st0.lines === 0 && st0.enabled === false && before?.code === 'notPlayed' && !asked.length && !existsSync(koPack('ko')),
      `an instance's status counts the lines its enabled mods lack in Korean; before the launcher has its Minecraft (the pack format) nothing is asked or made (${S(st0)}; ${before?.message})`);
    // The client jar the launcher downloads at the first Play: its version.json gives the pack format.
    write(path.join(launcherDir, 'versions', '1.20.1', '1.20.1.jar'), writeZip([{ name: 'version.json', data: Buffer.from(S({ id: '1.20.1', pack_version: { resource: 15, data: 15 } })) }]));
    const userOptions = 'version:3465\r\nlang:ko_kr\r\nresourcePacks:["vanilla","fabric","file/Mine.zip","file/Second Pack"]\r\nincompatibleResourcePacks:[]\r\nfov:0.0\r\n';
    write(optionsOf('ko'), userOptions);
    const steps = [];
    const r1 = await craft.translateKorean(root, 'ko', { translate, log, progress: (p) => steps.push(`${p.done}/${p.total}`) });
    check(S(steps) === S(['0/3', '3/3']), `the run reports its progress against every line without Korean, the refused one included (${S(steps)})`);
    const lines1 = readJson(koFile('ko'));
    const meta = readJson(path.join(koPack('ko'), 'pack.mcmeta'));
    check(r1.translated === 2 && r1.rejected === 1 && S(lines1) === S({ 'item.tm.gem': '보석', 'block.tm.ore': '%s 광석' }) && meta.pack?.pack_format === 15 && S(Object.keys(asked[0])) === S(['item.tm.gem', 'block.tm.ore', 'item.tm.shiny']),
      `Translate writes Claude's lines into resourcepacks/${KO} with a pack.mcmeta of the instance's format, refusing the answer that lost its %s (${S({ r1, lines1, meta })})`);
    check(r1.enabled === 'added' && textOf(optionsOf('ko')) === userOptions.replace('"fabric","file/Mine.zip"', `"fabric","file/${KO}","file/Mine.zip"`),
      `the pack is turned on in options.txt below the user's packs, which keep their order, with every other line and the CRLF line ends kept (${S(textOf(optionsOf('ko')))})`);
    write(koFile('ko'), S({ ...lines1, 'item.tm.gem': '빛나는 보석' }));
    const r2 = await craft.translateKorean(root, 'ko', { translate, log });
    check(asked.length === 2 && S(Object.keys(asked[1])) === S(['item.tm.shiny']) && readJson(koFile('ko'))['item.tm.gem'] === '빛나는 보석' && r2.enabled === 'on'
      && textOf(optionsOf('ko')).split(`file/${KO}`).length === 2, 'translating again asks only for the line still missing, keeps the user\'s edit, and turns the pack on only once');

    // options.txt without the line, and without the file (an instance never played).
    await withMods('kofresh');
    write(optionsOf('kofresh'), 'version:3465\nlang:en_us\n');
    const fresh = await craft.translateKorean(root, 'kofresh', { translate, log });
    await withMods('konew');
    await craft.translateKorean(root, 'konew', { translate, log });
    check(fresh.enabled === 'added' && textOf(optionsOf('kofresh')) === `version:3465\nlang:en_us\nresourcePacks:["vanilla","file/${KO}"]\n` && textOf(optionsOf('konew')) === `resourcePacks:["vanilla","file/${KO}"]\n`,
      `a missing resourcePacks line is added with the game's own vanilla, and a missing options.txt is made (${S([textOf(optionsOf('kofresh')), textOf(optionsOf('konew'))])})`);

    // What the user broke by hand is not written over.
    await withMods('kobad');
    write(koFile('kobad'), '{\n  "item.tm.gem": "내 줄",\n');
    write(optionsOf('kobad'), userOptions);
    const askedBefore = asked.length;
    const badPack = await errOf(() => craft.translateKorean(root, 'kobad', { translate, log }));
    check(badPack?.code === 'badPack' && badPack.message.includes(koFile('kobad')) && textOf(koFile('kobad')) === '{\n  "item.tm.gem": "내 줄",\n' && asked.length === askedBefore && textOf(optionsOf('kobad')) === userOptions
      && (await errOf(() => craft.koreanStatus(root, 'kobad')))?.code === 'badPack', `a damaged ko_kr.json in the pack is refused with its name, nothing asked and nothing written (${badPack?.message})`);
    await withMods('kooptions');
    const brokenOptions = 'version:3465\nresourcePacks:vanilla,file/Mine.zip\n';
    write(optionsOf('kooptions'), brokenOptions);
    const damaged = await craft.translateKorean(root, 'kooptions', { translate, log });
    check(damaged.translated === 2 && damaged.enabled === 'damaged' && textOf(optionsOf('kooptions')) === brokenOptions && craft.koreanStatus(root, 'kooptions').enabled === null,
      `a resourcePacks line that is not a list is left as it is, and the result says the pack is not on (${damaged.enabled})`);
    await craft.create(root, { name: 'koold', mc: '1.12.2', loader: 'vanilla' }, log);
    check((await errOf(() => craft.translateKorean(root, 'koold', { translate, log })))?.code === 'oldVersion', 'an instance before 1.13, whose mods keep their text in .lang files, is refused');

    // While the instance's game runs it writes options.txt when it closes: nothing is translated then, and a game that
    // starts during a translation leaves the pack to be turned on at the next Play.
    const gameScript = path.join(work, 'game.cjs');
    write(gameScript, 'setInterval(() => {}, 1000);\n');
    process.env.PYIDE_MC_GAME_IMAGE = path.basename(process.execPath);
    const games = [];
    const startGame = (dir) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [gameScript, '--username', 'Steve', '--gameDir', dir, '--assetsDir', path.join(launcherDir, 'assets')], { stdio: 'ignore' });
      games.push(child);
      child.once('spawn', () => resolve(child));
      child.once('error', reject);
    });
    const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    try {
      await withMods('koplay');
      write(optionsOf('koplay'), userOptions);
      const game = await startGame(instDir('koplay'));
      const askedNow = asked.length;
      const playing = await errOf(() => craft.translateKorean(root, 'koplay', { translate, log }));
      check(playing?.code === 'playing' && asked.length === askedNow && !existsSync(koPack('koplay')) && textOf(optionsOf('koplay')) === userOptions,
        `while the instance's game runs, translation is refused before anything is asked or written (${playing?.message})`);
      // instances/koplay is the start of instances/koplay2: a game there is not this one's.
      await withMods('koplay2');
      const beside = await craft.translateKorean(root, 'koplay2', { translate, log });
      check(beside.enabled === 'added', 'a game running in another instance, whose folder starts with this one\'s name, does not stop it');
      await stop(game);

      await withMods('kolate');
      write(optionsOf('kolate'), userOptions);
      let late = null;
      const lateTranslate = async (system, prompt) => { late = await startGame(instDir('kolate')); return translate(system, prompt); };
      const pending = await craft.translateKorean(root, 'kolate', { translate: lateTranslate, log });
      check(pending.translated === 2 && pending.enabled === 'pending' && textOf(optionsOf('kolate')) === userOptions && existsSync(path.join(koPack('kolate'), 'nano-turn-on.txt')),
        `a game started during the translation leaves options.txt alone, and the pack is marked to be turned on later (${pending.enabled})`);
      await stop(late);
      const played = await craft.play(root, 'kolate', {}, log);
      check(played.launched && textOf(optionsOf('kolate')).includes(`"fabric","file/${KO}","file/Mine.zip"`) && !existsSync(path.join(koPack('kolate'), 'nano-turn-on.txt')),
        `the next Play turns it on before the launcher starts (${S(textOf(optionsOf('kolate')))})`);
    } finally {
      for (const g of games) g.kill();
      delete process.env.PYIDE_MC_GAME_IMAGE;
    }
  }

  // ---------- the server list ping ----------
  const P = require('../main/minecraft/ping.js');
  const said = (status) => { const { mc, loader } = P.summarize(status); return [mc, loader]; };
  const answers = [
    [{ version: { name: '1.21.1', protocol: 767 } }, ['1.21.1', 'vanilla']],
    [{ version: { name: 'Paper 1.21.4' } }, ['1.21.4', 'vanilla']],
    [{ version: { name: '26.3' } }, ['26.3', 'vanilla']],
    [{ version: { name: '1.20.1' }, forgeData: { fmlNetworkVersion: 3, truncated: true, mods: [], channels: [] } }, ['1.20.1', 'forge']],
    [{ version: { name: '1.12.2' }, modinfo: { type: 'FML', modList: [] } }, ['1.12.2', 'forge']],
    [{ version: { name: '1.21.1' }, isModded: true }, ['1.21.1', 'neoforge']],
    [{ version: { name: '1.20.1' }, forgeData: { mods: [{ modId: 'neoforge' }] } }, ['1.20.1', 'neoforge']],
    [{ version: { name: 'Velocity 3.1.1-3.4.0' } }, [null, 'vanilla']],
    [{ version: { name: 'BungeeCord 1.8.x-1.21.x' } }, [null, 'vanilla']],
    [{ version: { name: 12 }, forgeData: 'x', players: 'many' }, [null, 'vanilla']],
    [{}, [null, 'vanilla']],
  ];
  check(answers.every(([status, want]) => S(said(status)) === S(want)), `a ping answer gives the version and the loader; a proxy's own version and odd fields give none (${S(answers.map(([s]) => said(s)))})`);
  const pingServer = (reply) => new Promise((resolve) => {
    const seen = [];
    const srv = net.createServer((c) => {
      c.on('error', () => {});
      c.once('data', (d) => { seen.push(d); reply(c); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
  const varInt = (n) => { const out = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n); return Buffer.from(out); };
  const statusPacket = (json) => {
    const text = Buffer.from(json);
    const body = Buffer.concat([varInt(0), varInt(text.length), text]);
    return Buffer.concat([varInt(body.length), body]);
  };
  const good = await pingServer((c) => {
    const p = statusPacket(S({ version: { name: 'Paper 1.20.1' }, players: { online: 3, max: 20 }, forgeData: { mods: [] }, description: '한글 서버', favicon: 'x'.repeat(70000) }));
    c.write(p.subarray(0, 40));
    setTimeout(() => c.end(p.subarray(40)), 30);
  });
  const answered = await P.ping('127.0.0.1', good.port);
  check(answered.online && answered.mc === '1.20.1' && answered.loader === 'forge' && answered.players === 3 && answered.max === 20 && good.seen[0].includes('127.0.0.1'),
    `a ping answer that arrives in pieces is read (${S(answered)})`);
  const bad = [
    await pingServer((c) => c.end('HTTP/1.1 400 Bad Request\r\n\r\n')),
    await pingServer((c) => c.end(Buffer.alloc(16, 0xff))),
    await pingServer((c) => c.end(Buffer.concat([varInt(64 * 1024 * 1024), Buffer.alloc(32)]))),
    await pingServer((c) => c.end(statusPacket('not json'))),
    await pingServer((c) => c.end(statusPacket('[1]'))),
    await pingServer(() => {}),
    await pingServer((c) => { const drip = setInterval(() => { if (!c.destroyed) c.write(Buffer.from([0x80])); }, 100); c.once('close', () => clearInterval(drip)); }),
    await pingServer((c) => { c.write(varInt(1024 * 1024)); const drip = setInterval(() => { if (!c.destroyed) c.write(Buffer.from([1])); }, 100); c.once('close', () => clearInterval(drip)); }),
  ];
  const offline = await Promise.all(bad.map((b) => P.ping('127.0.0.1', b.port, 500)));
  bad.forEach((b) => b.srv.close());
  good.srv.close();
  check(offline.every((r) => S(r) === S({ online: false })) && S(await P.ping('127.0.0.1', 1, 500)) === S({ online: false }),
    'anything that is not a server\'s answer (another protocol, a varint that never ends, a huge length, not JSON, silence, a sender of single bytes that never finishes, nothing listening) is simply no answer');

  // ---------- retries, limits and the pack file server ----------
  const flaky = { hits: new Map() };
  const svc = http.createServer((q, r) => {
    const n = (flaky.hits.get(q.url) || 0) + 1;
    flaky.hits.set(q.url, n);
    if (q.url === '/flaky' && n < 3) { r.writeHead(503); return r.end(); }
    if (q.url === '/limited' && n < 2) { r.writeHead(429, { 'Retry-After': '1' }); return r.end(); }
    if (q.url === '/dropped' && n < 2) return r.destroy();
    if (q.url === '/gone') { r.writeHead(404); return r.end(); }
    if (q.url === '/big') return r.end(Buffer.alloc(4096));
    if (q.url === '/bignolength') { r.write(Buffer.alloc(4096)); return r.end(); }
    if (q.url === '/hop') { r.writeHead(302, { Location: '/landed' }); return r.end(); }
    if (q.url === '/out') { r.writeHead(302, { Location: 'http://192.168.0.5/p.mrpack' }); return r.end(); }
    r.end('{"ok":true}');
  });
  await new Promise((resolve) => { svc.listen(0, '127.0.0.1', resolve); });
  const svcBase = `http://127.0.0.1:${svc.address().port}`;
  const { getJson } = require('../main/minecraft/sources.js');
  const transient = [(await getJson(`${svcBase}/flaky`)).ok, (await getJson(`${svcBase}/limited`)).ok, (await getJson(`${svcBase}/dropped`)).ok];
  const gone = await errOf(() => getJson(`${svcBase}/gone`));
  check(transient.every(Boolean) && flaky.hits.get('/flaky') === 3 && gone?.status === 404 && flaky.hits.get('/gone') === 1,
    `a service's 5xx, 429 and dropped connection are asked again; its 404 is an answer (${S([...flaky.hits])})`);
  const { download } = require('../main/installer/servers.js');
  const quiet = { progress: () => {}, log: () => {} };
  const capped = path.join(work, 'capped.bin');
  const overLength = await errOf(() => download(`${svcBase}/big`, capped, { ...quiet, limit: 1024 }));
  const overStream = await errOf(() => download(`${svcBase}/bignolength`, capped, { ...quiet, limit: 1024 }));
  check(overLength?.code === 'TOO_LARGE' && overStream?.code === 'TOO_LARGE' && !existsSync(capped) && !existsSync(`${capped}.part`), `a download over its limit stops, by its declared length or as it arrives, and leaves no file (${overStream?.message})`);
  const onlyHere = (u) => u.startsWith(svcBase);
  const hopped = path.join(work, 'hopped.bin');
  await download(`${svcBase}/hop`, hopped, { ...quiet, allow: onlyHere });
  const redirected = await errOf(() => download(`${svcBase}/out`, capped, { ...quiet, allow: onlyHere }));
  check(readFileSync(hopped, 'utf8') === '{"ok":true}' && redirected?.code === 'REDIRECT' && !existsSync(capped), `a download from outside follows a redirect only where it may go (${redirected?.message})`);
  svc.close();
  const { serve } = require('../main/minecraft/file-server.js');
  const shareDir = path.join(work, 'share');
  write(path.join(shareDir, 'Friend Pack.mrpack'), 'the pack');
  write(path.join(work, 'secret.txt'), 'not for players');
  const port = await serve(shareDir);
  check(port === await serve(shareDir), 'one server per folder');
  const hit = async (url, opts) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, opts); return [r.status, await r.text()]; };
  const got = await hit('/Friend%20Pack.mrpack');
  const refusedPaths = await Promise.all(['/', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/sub/x', '/missing.mrpack', '/%00', '/%E0%A4%A'].map((u) => hit(u)));
  const posted = await hit('/Friend%20Pack.mrpack', { method: 'POST', body: 'x' });
  const devices = await Promise.all(['/NUL', '/CON', '/Friend%20Pack.mrpack::$DATA', '/Friend%20Pack.mrpack:x', `/${'a'.repeat(5000)}`, '/*', '/%3C%3E%7C', '/a%22b'].map((u) => hit(u)));
  check(got[0] === 200 && got[1] === 'the pack' && refusedPaths.every(([code, body]) => code >= 400 && !body.includes('players')) && posted[0] === 405 && devices.every(([code]) => code === 404),
    `the pack server gives the folder's files by name, and no listing, nothing outside it, no device or stream names and nothing but GET (${S(refusedPaths.map(([c]) => c))})`);
  let linked = false;
  try { symlinkSync(path.join(work, 'secret.txt'), path.join(shareDir, 'link.txt')); linked = true; } catch {}
  if (linked) check((await hit('/link.txt'))[0] === 404, 'a link in the folder is not served');
  const sockets = await new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port }, () => { resolve(c.localAddress); c.destroy(); });
  });
  const open = await new Promise((resolve) => {
    const nic = Object.values(networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
    if (!nic) return resolve(null);
    const c = net.connect({ host: nic, port });
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
  check(sockets === '127.0.0.1' && open !== true, `the pack server listens on loopback only (through this computer's own network address: ${open})`);

  // ---------- the servers' main side ----------
  {
    process.env.PYIDE_TRUST_ALL = '1';
    process.env.PYIDE_INSTALL_ROOT = path.join(work, 'install-root');
    const routes = new Map(); // path -> Buffer | JSON
    const asked = [];
    const stand = http.createServer((q, r) => {
      const p = q.url.split('?')[0];
      asked.push(p);
      const body = routes.get(p);
      if (body === undefined) { r.writeHead(404); return r.end(); }
      // The Java archive takes a moment, so two starts overlap on it.
      setTimeout(() => r.end(Buffer.isBuffer(body) ? body : S(body)), p.endsWith('.zip') ? 400 : 0);
    });
    await new Promise((resolve) => { stand.listen(0, '127.0.0.1', resolve); });
    const sb = `http://127.0.0.1:${stand.address().port}`;
    process.env.PYIDE_MC_SOURCES = S({ paper: `${sb}/paper`, adoptium: `${sb}/adoptium`, modrinth: `${sb}/modrinth`, mojang: `${sb}/mojang/manifest.json` });
    const load = Module._load;
    const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => work, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' } : class {}) });
    Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
    const feature = require('../main/features/minecraft.js');
    Module._load = load;
    const handlers = new Map();
    const procs = new Map();
    const started = [];
    const startProcess = (cmd, args, opts) => { const id = started.length + 1; procs.set(id, new EventEmitter()); started.push(opts); return id; };
    feature.register({ ipcMain: { handle: (h, fn) => handlers.set(h, fn), on() {} }, send() {}, startProcess, procs, diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
    const call = (name, ...args) => handlers.get(name)({}, ...args);
    const proj = path.join(work, 'servers-project');
    const srvDir = (n) => path.join(proj, 'servers', n);
    // A server made by hand: its description and server.properties. `elsewhere` is a folder outside servers/, which no
    // players session watches.
    const serverAt = (dir, desc, props = '') => { write(path.join(dir, 'pyide-server.json'), S({ java: 21, memory: '1G', launch: { jar: 'server.jar' }, ...desc })); write(path.join(dir, 'server.properties'), props); return dir; };
    const elsewhere = (n) => path.join(proj, 'elsewhere', n);
    const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

    // Quitting the app: the server is asked to save, as Stop does, and has a minute.
    serverAt(elsewhere('quitPaper'), { kind: 'paper', mc: '1.20.1' });
    serverAt(elsewhere('quitProxy'), { kind: 'velocity', mc: '3.4.0' });
    const quitPaper = await call('minecraft:start', proj, { cmd: 'java', args: [], cwd: elsewhere('quitPaper') });
    await call('minecraft:start', proj, { cmd: 'java', args: [], cwd: elsewhere('quitProxy') });
    check(started[0].quitInput === 'stop\n' && started[1].quitInput === 'end\n' && started.every((o) => o.quitWaitMs === 60000),
      `a server is started with what a quit sends it: "stop" ("end" for a Velocity proxy) and 60 s to save (${S(started.map((o) => [o.quitInput, o.quitWaitMs]))})`);
    procs.get(quitPaper).emit('close', 0);

    // Velocity: each Paper or Purpur takes modern forwarding in the file its version reads; one older than 1.13 is left out.
    const proxyDir = serverAt(srvDir('proxy'), { kind: 'velocity', mc: '3.4.0' }, 'server-port=25600\n');
    write(path.join(proxyDir, 'forwarding.secret'), 'the-secret');
    serverAt(srvDir('modern'), { kind: 'paper', mc: '1.20.1' }, 'server-port=25601\n');
    serverAt(srvDir('legacy'), { kind: 'purpur', mc: '1.16.5' }, 'server-port=25602\nonline-mode=true\n');
    serverAt(srvDir('ancient'), { kind: 'paper', mc: '1.12.2' }, 'server-port=25603\nonline-mode=false\n');
    // What an older Nano Studio wrote into the 1.12.2 server: paper-global.yml, which it never reads, and account checks off.
    write(path.join(srvDir('ancient'), 'config', 'paper-global.yml'), "proxies:\n  velocity:\n    enabled: true\n    online-mode: true\n    secret: 'the-secret'\n");
    write(path.join(srvDir('legacy'), 'paper.yml'), 'config-version: 20\nsettings:\n  console-has-all-permissions: false\n');
    const wired = await call('minecraft:wireProxy', proj, proxyDir);
    const toml = text(path.join(proxyDir, 'velocity.toml'));
    const legacyYml = text(path.join(srvDir('legacy'), 'paper.yml'));
    const onlineOf = (n) => /^online-mode=(\w+)$/m.exec(text(path.join(srvDir(n), 'server.properties')) || '')?.[1];
    check(/^"modern" = "127\.0\.0\.1:25601"$/m.test(toml) && /^"legacy" = "127\.0\.0\.1:25602"$/m.test(toml) && !/ancient/.test(toml)
      && S(wired.skipped) === S([{ name: 'ancient', mc: '1.12.2' }]), `the proxy sends players to the 1.13+ servers and names the older one it leaves out (${S(wired)})`);
    check(/^proxies:\n {2}velocity:\n {4}enabled: true\n {4}online-mode: true\n {4}secret: 'the-secret'$/m.test(text(path.join(srvDir('modern'), 'config', 'paper-global.yml')) || '') && onlineOf('modern') === 'false',
      'a 1.19+ server takes the secret in config/paper-global.yml');
    check(/^settings:\n {2}velocity-support:\n {4}enabled: true\n {4}online-mode: true\n {4}secret: 'the-secret'\n {2}console-has-all-permissions: false$/m.test(legacyYml || '')
      && /^config-version: 20$/m.test(legacyYml) && !existsSync(path.join(srvDir('legacy'), 'config', 'paper-global.yml')) && onlineOf('legacy') === 'false',
    `a 1.13 to 1.18 server takes it in paper.yml (settings.velocity-support), where that version reads it (${S(legacyYml)})`);
    check(onlineOf('ancient') === 'true' && /enabled: false/.test(text(path.join(srvDir('ancient'), 'config', 'paper-global.yml'))) && !existsSync(path.join(srvDir('ancient'), 'paper.yml')),
      'a server older than 1.13 keeps its account checks, and the ones an older Nano Studio turned off come back on');
    rmSync(proxyDir, { recursive: true, force: true });
    await call('minecraft:rewireProxies', proj);
    const listed = await call('minecraft:servers', proj);
    check(/velocity:\n {4}enabled: false/.test(text(path.join(srvDir('modern'), 'config', 'paper-global.yml'))) && /velocity-support:\n {4}enabled: false/.test(text(path.join(srvDir('legacy'), 'paper.yml')))
      && onlineOf('modern') === 'true' && onlineOf('legacy') === 'true' && !listed.some((s) => s.offline),
    `with the last proxy deleted its servers take direct joins again: forwarding off, account checks on (${S(listed.map((s) => [s.name, s.offline]))})`);

    // The Market while the server runs: Java holds its jars, so an update or a removal waits for Stop.
    const modded = serverAt(elsewhere('modded'), { kind: 'forge', mc: '1.20.1', loader: '47.9.9',
      market: { MODA: { title: 'Mod A', version: '1.0', versionId: 'va1', files: ['mods/mod-a-1.0.jar'], needs: [], dependency: false } } });
    write(path.join(modded, 'mods', 'mod-a-1.0.jar'), 'mod a 1.0');
    const jar = (name, data) => { routes.set(`/files/${name}`, Buffer.from(data)); return { filename: name, url: `${sb}/files/${name}`, primary: true, size: data.length, hashes: { sha512: sha512(Buffer.from(data)) } }; };
    routes.set('/modrinth/project/MODA', { id: 'MODA', title: 'Mod A', server_side: 'required' });
    routes.set('/modrinth/project/MODA/version', [{ id: 'va2', version_number: '2.0', version_type: 'release', files: [jar('mod-a-2.0.jar', 'mod a 2.0')], dependencies: [] }]);
    const moddedRun = await call('minecraft:start', proj, { cmd: 'java', args: [], cwd: modded });
    const mods = () => readdirSync(path.join(modded, 'mods')).sort();
    const record = () => JSON.parse(readFileSync(path.join(modded, 'pyide-server.json'), 'utf8')).market || {};
    const busyUpdate = await errOf(() => call('minecraft:marketInstall', proj, modded, { id: 'MODA', type: 'mod' }, 'job'));
    const busyRemove = await errOf(() => call('minecraft:marketRemove', proj, modded, 'MODA'));
    check(/Stop modded first/.test(busyUpdate?.message || '') && /Stop modded first/.test(busyRemove?.message || '') && S(mods()) === S(['mod-a-1.0.jar'])
      && record().MODA?.version === '1.0' && !asked.includes('/files/mod-a-2.0.jar'),
    `while the server runs, Update and Remove are refused before anything is downloaded or deleted (${busyUpdate?.message})`);
    procs.get(moddedRun).emit('close', 0);
    await call('minecraft:marketInstall', proj, modded, { id: 'MODA', type: 'mod' }, 'job');
    check(S(mods()) === S(['mod-a-2.0.jar']) && record().MODA?.version === '2.0', `once it has stopped, Update replaces the jar (${S(mods())})`);
    // A required dependency that fails its checksum after the project's own jar is in: that jar goes too.
    routes.set('/modrinth/project/MODB', { id: 'MODB', title: 'Mod B', server_side: 'required' });
    routes.set('/modrinth/project/MODB/version', [{ id: 'vb1', version_number: '1.0', version_type: 'release', files: [jar('mod-b-1.0.jar', 'mod b')], dependencies: [{ project_id: 'LIBX', dependency_type: 'required' }] }]);
    routes.set('/modrinth/project/LIBX', { id: 'LIBX', title: 'Lib X', server_side: 'required' });
    routes.set('/modrinth/project/LIBX/version', [{ id: 'vx1', version_number: '1.0', version_type: 'release', files: [{ ...jar('lib-x-1.0.jar', 'lib x'), hashes: { sha512: '0'.repeat(128) } }], dependencies: [] }]);
    const depFailed = await errOf(() => call('minecraft:marketInstall', proj, modded, { id: 'MODB', type: 'mod' }, 'job'));
    check(/Checksum mismatch for lib-x-1\.0\.jar/.test(depFailed?.message || '') && S(mods()) === S(['mod-a-2.0.jar']) && !record().MODB,
      `a dependency that fails takes out the jar installed before it, so mods/ holds nothing pyide-server.json does not record (${S(mods())})`);
    await call('minecraft:marketRemove', proj, modded, 'MODA');
    check(S(mods()) === S([]) && !record().MODA, 'a stopped server\'s project is removed');

    // A modpack server's client pack: the modpack, with the mods added since in its overrides.
    const packSrv = serverAt(srvDir('packsrv'), { kind: 'forge', mc: '1.20.1', loader: '47.9.9', modpack: { name: 'Test Pack', version: '1.0', clientPack: 'client-pack/Test Pack.mrpack' } }, 'server-port=25605\n');
    const packIndex = { formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Test Pack', dependencies: { minecraft: '1.20.1', forge: '47.9.9' }, files: [
      { path: 'mods/server-mod.jar', hashes: { sha1: '1'.repeat(40) }, env: { client: 'required', server: 'required' }, downloads: ['https://cdn.modrinth.com/s.jar'] },
      { path: 'mods/client-mod.jar', hashes: { sha1: '2'.repeat(40) }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://cdn.modrinth.com/c.jar'] }] };
    const originalPack = writeZip([{ name: 'modrinth.index.json', data: Buffer.from(S(packIndex)) }, { name: 'overrides/mods/bundled.jar', data: Buffer.from('bundled') },
      { name: 'client-overrides/options.txt', data: Buffer.from('client') }]);
    write(path.join(packSrv, 'client-pack', 'Test Pack.mrpack'), originalPack);
    for (const m of ['server-mod.jar', 'bundled.jar']) write(path.join(packSrv, 'mods', m), m);
    const plain = await call('minecraft:clientPack', proj, packSrv);
    write(path.join(packSrv, 'mods', 'market-mod.jar'), 'added later');
    const grown = await call('minecraft:clientPack', proj, packSrv);
    const { openZip } = require('../main/minecraft/zipfile.js');
    const grownZip = openZip(grown.file);
    const grownNames = [...grownZip.names].sort();
    const grownIndex = grownZip.read('modrinth.index.json').toString('utf8');
    const addedData = grownZip.read('overrides/mods/market-mod.jar')?.toString('utf8');
    grownZip.close();
    check(plain.file === path.join(packSrv, 'client-pack', 'Test Pack.mrpack') && S(plain.added) === S([]), 'without added mods the client pack is the modpack itself');
    check(grown.file !== plain.file && S(grown.added) === S(['market-mod.jar']) && addedData === 'added later' && grownIndex === S(packIndex)
      && S(grownNames) === S(['client-overrides/options.txt', 'modrinth.index.json', 'overrides/mods/bundled.jar', 'overrides/mods/market-mod.jar'])
      && readFileSync(plain.file).equals(originalPack),
    `a mod added to the server goes into the players' pack with everything of the modpack, its client-only mods too (${S(grownNames)})`);
    const builtAt = statSync(grown.file).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    const again = await call('minecraft:clientPack', proj, packSrv);
    check(again.file === grown.file && statSync(grown.file).mtimeMs === builtAt, 'asked again with nothing changed (Copy Join Code), the pack is not zipped again');
    write(path.join(packSrv, 'mods', 'market-mod.jar'), 'updated');
    const changed = await call('minecraft:clientPack', proj, packSrv);
    const changedZip = openZip(changed.file);
    const updated = changedZip.read('overrides/mods/market-mod.jar')?.toString('utf8');
    changedZip.close();
    check(updated === 'updated', 'a mod that changed is zipped again');

    // A big modded server's pack is zipped without stopping the main process, which answers every window meanwhile.
    const bigSrv = serverAt(srvDir('bigpack'), { kind: 'fabric', mc: '1.20.1', loader: '0.15.11' }, 'server-port=25606\n');
    for (let i = 0; i < 30; i++) write(path.join(bigSrv, 'mods', `big-${i}.jar`), crypto.randomBytes(4 << 20));
    let last = performance.now();
    let longest = 0;
    const beat = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
    const t0 = performance.now();
    const big = await call('minecraft:clientPack', proj, bigSrv);
    const took = performance.now() - t0;
    clearInterval(beat);
    const bigZip = openZip(big.file);
    const bigNames = bigZip.names.length;
    const sameBytes = bigZip.read('overrides/mods/big-7.jar').equals(readFileSync(path.join(bigSrv, 'mods', 'big-7.jar')));
    bigZip.close();
    check(bigNames === 31 && sameBytes && longest < 250, `120 MB of mods are zipped in ${Math.round(took)} ms with the event loop never held longer than ${Math.round(longest)} ms`);
    const tooMany = await errOf(async () => writeZip(Array.from({ length: 65536 }, (_v, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }))));
    check(/65,535/.test(tooMany?.message || ''), `a zip of more entries than a zip holds without ZIP64 is refused, not written damaged (${tooMany?.message})`);

    // Two servers starting at once that need a Java not on this computer: one download.
    const javaZip = writeZip([{ name: 'jdk-99.0.1+1-jre/bin/java.exe', data: Buffer.from('') }]);
    routes.set('/adoptium/java.zip', javaZip);
    routes.set('/adoptium/assets/latest/99/hotspot', [{ binary: { package: { link: `${sb}/adoptium/java.zip`, checksum: crypto.createHash('sha256').update(javaZip).digest('hex'), size: javaZip.length, name: 'java-99.zip' } } }]);
    const j1 = serverAt(elsewhere('java1'), { kind: 'paper', mc: '1.20.1', java: 99 });
    const j2 = serverAt(elsewhere('java2'), { kind: 'paper', mc: '1.20.1', java: 99 });
    const launched = await Promise.allSettled([call('minecraft:launch', proj, j1, 'job'), call('minecraft:launch', proj, j2, 'job')]);
    check(launched.every((r) => r.status === 'fulfilled' && /temurin-99-jre/.test(r.value.cmd)) && asked.filter((p) => p === '/adoptium/java.zip').length === 1,
      `two starts that need the same missing Java share one download (${S(launched.map((r) => r.reason?.message || r.value.cmd))}, ${asked.filter((p) => p === '/adoptium/java.zip').length} downloads)`);
    // The port a start binds is main's to say: the renderer's list may be from before server.properties changed.
    const later = serverAt(elsewhere('portLater'), { kind: 'paper', mc: '1.20.1', java: 99 }, 'server-port=25690\nserver-port = 25691\n');
    const laterProxy = serverAt(elsewhere('portProxy'), { kind: 'velocity', mc: '3.4.0', java: 99 }, 'server-port=25692\n');
    write(path.join(laterProxy, 'velocity.toml'), 'bind = "0.0.0.0:25693"\n');
    const ports = await Promise.all([later, laterProxy].map((d) => call('minecraft:launch', proj, d, 'job').then((r) => r.port, (err) => err.message)));
    check(S(ports) === S([25691, 25693]), `a start says the port the server will bind: server.properties' last line, a proxy's velocity.toml bind (${S(ports)})`);

    // A ko_kr.json the user broke by hand is not written over.
    const translation = require('../main/minecraft/translate.js');
    const tdir = path.join(work, 'translate');
    write(path.join(tdir, 'mods', 'tm.jar'), writeZip([{ name: 'assets/tm/lang/en_us.json', data: Buffer.from(S({ 'item.tm.gem': 'Gem' })) }]));
    const koFile = path.join(tdir, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json');
    write(koFile, '{\n  "item.tm.old": "내가 쓴 줄",\n');
    let asks = 0;
    const badPack = await errOf(async () => translation.translateMods(tdir, { mods: translation.scan(tdir).mods, translate: async () => { asks++; return S({ 'item.tm.gem': '보석' }); }, log() {} }));
    check(badPack?.message.includes(koFile) && /not valid JSON/.test(badPack.message) && text(koFile) === '{\n  "item.tm.old": "내가 쓴 줄",\n' && asks === 0,
      `a damaged ko_kr.json is refused with its name, and neither asked about nor written over (${badPack?.message})`);
    write(koFile, '{"item.tm.old": "내가 쓴 줄"}');
    const fine = await translation.translateMods(tdir, { mods: translation.scan(tdir).mods, translate: async () => S({ 'item.tm.gem': '보석' }), log() {} });
    check(fine.translated === 1 && S(JSON.parse(text(koFile))) === S({ 'item.tm.old': '내가 쓴 줄', 'item.tm.gem': '보석' }), 'a sound one gets the new line beside the user\'s');
    // Several questions at a time: three mods of 300 lines are nine batches, answered in any order.
    {
      const pdir = path.join(work, 'translate-parallel');
      const many = Array.from({ length: 3 }, (_, m) => ({ jar: `p${m}.jar`, ns: `p${m}`, total: 300, missing: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, `Line %s ${i}`])) }));
      let now = 0;
      let peak = 0;
      const steps = [];
      const slow = async (_system, prompt) => {
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
        now--;
        return S(Object.fromEntries(Object.entries(JSON.parse(prompt)).map(([k, v]) => [k, v.replace('Line', '줄')])));
      };
      const par = await translation.translateMods(pdir, { mods: many, translate: slow, log() {}, progress: (p) => steps.push(p.done) });
      const written = many.map((m) => Object.keys(JSON.parse(text(path.join(pdir, 'resourcepack', 'assets', m.ns, 'lang', 'ko_kr.json')))).length);
      check(peak === translation.PARALLEL && par.translated === 900 && S(written) === S([300, 300, 300]) && steps.at(-1) === 900 && steps.every((v, i) => !i || v >= steps[i - 1]),
        `batches are asked ${translation.PARALLEL} at a time, every answer lands in its mod's file, and the progress only rises to the total (${S({ peak, translated: par.translated, written, last: steps.at(-1) })})`);
      // Cancel ends the questions still running, and nothing more is written.
      const ctl = new AbortController();
      let asked = 0;
      let ended = 0;
      const hang = (_system, _prompt, signal) => new Promise((resolve, reject) => {
        asked++;
        const t = setTimeout(() => resolve('{}'), 5000);
        signal.addEventListener('abort', () => { clearTimeout(t); ended++; reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' })); });
      });
      setTimeout(() => ctl.abort(), 50);
      const cdir = path.join(work, 'translate-cancel');
      const stopped = await errOf(() => translation.translateMods(cdir, { mods: many, translate: hang, log() {}, signal: ctl.signal }));
      check(stopped?.code === 'cancelled' && asked === translation.PARALLEL && ended === asked && !existsSync(path.join(cdir, 'resourcepack')),
        `Cancel stops every question that was running and starts no more (${S({ code: stopped?.code, asked, ended })})`);
      // Signed out: the first answer says so, and the run ends without waiting for the others.
      let begun = 0;
      const signedOut = async (_system, _prompt, signal) => {
        if (begun++ === 0) throw Object.assign(new Error('Claude Code is not signed in'), { code: 'auth' });
        return new Promise((resolve, reject) => { const t = setTimeout(() => resolve('{}'), 5000); signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('stopped')); }); });
      };
      const t0 = Date.now();
      const auth = await errOf(() => translation.translateMods(path.join(work, 'translate-auth'), { mods: many, translate: signedOut, log() {} }));
      check(auth?.code === 'auth' && Date.now() - t0 < 2000, `an answer that Claude Code is signed out ends the whole run at once (${auth?.code}, ${Date.now() - t0} ms)`);
    }
    // A literal % before a space and a word is text, not a code the translation must keep; the codes the game fills are.
    const codes = [
      ['Speed +10% per level', '레벨당 속도 +10%', true], ['50% chance to drop %s', '%s 떨어뜨릴 확률 50%', true], ['100% done', '100% 완료', true],
      ['%1$s gave %2$s %3$d', '%1$s 님이 %2$s 님에게 %3$d개', true], ['%.1f hearts', '하트 %.1f개', true], ['§aGreen%%', '§a초록%%', true], ['Line\nTwo', '줄\n둘', true],
      ['Hello %s', '안녕', false], ['%1$s and %2$s', '%1$s 그리고', false], ['%d items', '아이템', false], ['§cRed', '빨강', false], ['Line\nTwo', '줄 둘', false], ['50%%', '50', false],
    ].map(([en, ko, want]) => [en, translation.sameCodes(en, ko), want]);
    check(codes.every(([, got, want]) => got === want), `a translation keeps %s, %d, %1$s, %.1f, %%, § and line breaks, and a literal "10% per" is no code (${S(codes.filter(([, got, want]) => got !== want))})`);

    // A create cut off half-way (the app closed) leaves a folder marked unfinished: not listed, and taken back by the next
    // create of its name. A folder without the mark is the user's and is never removed.
    const paperJar = Buffer.from('a stand-in paper jar');
    routes.set('/mojang/manifest.json', { latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: `${sb}/mojang/1.20.1.json` }] });
    routes.set('/mojang/1.20.1.json', { javaVersion: { majorVersion: 17 } });
    routes.set('/paper/versions/1.20.1/builds', [{ id: 7, channel: 'STABLE', downloads: { 'server:default': { url: `${sb}/files/paper.jar`, size: paperJar.length, checksums: { sha256: crypto.createHash('sha256').update(paperJar).digest('hex') } } } }]);
    routes.set('/files/paper.jar', paperJar);
    const create = (name) => call('minecraft:create', { root: proj, name, kind: 'paper', mc: '1.20.1', memory: '1G', port: 25606, eula: true }, 'job');
    write(path.join(srvDir('Half'), 'pyide-server.unfinished'), '');
    write(path.join(srvDir('Half'), 'pyide-server.json'), S({ kind: 'forge', mc: '1.20.1', java: 17, launch: { jar: 'x.jar' } }));
    write(path.join(srvDir('Half'), 'mods', 'half-downloaded.jar'), 'half');
    write(path.join(srvDir('Mine'), 'notes.txt'), 'the user\'s own folder');
    const before = (await call('minecraft:servers', proj)).map((s) => s.name);
    const blocked = await call('minecraft:blockedNames', proj);
    check(!before.includes('Half') && S(blocked) === S(['Mine']), `a half-made server is not listed and blocks no name; a folder of the user's does (${S(before)}, ${S(blocked)})`);
    // A server whose pyide-server.json cannot be read, or names a type Nano Studio does not know, is listed as damaged
    // with the reason: it keeps its card (Stop, Open Folder) and its name says it is a server, not a folder of the user's.
    write(path.join(srvDir('Garbled'), 'pyide-server.json'), '{ "kind": "paper", ');
    serverAt(srvDir('Spigot'), { kind: 'spigot', mc: '1.20.1' });
    const damagedList = await Promise.resolve().then(() => call('minecraft:damagedServers', proj)).catch((err) => ({ error: err.message }));
    const blockedNow = await call('minecraft:blockedNames', proj);
    const listedNow = (await call('minecraft:servers', proj)).map((s) => s.name);
    check(Array.isArray(damagedList) && S(damagedList.map((s) => [s.name, s.damaged, s.kind ?? null])) === S([['Garbled', 'unreadable', null], ['Spigot', 'kind', 'spigot']]) && S(blockedNow) === S(['Mine']) && !listedNow.some((n) => /Garbled|Spigot/.test(n)),
      `a server with an unreadable pyide-server.json or an unknown type is listed as damaged with the reason, and its name is not taken for a folder of the user's (${S(damagedList)}, blocked ${S(blockedNow)})`);
    rmSync(srvDir('Garbled'), { recursive: true, force: true });
    rmSync(srvDir('Spigot'), { recursive: true, force: true });
    await create('Half');
    check(existsSync(path.join(srvDir('Half'), 'server.jar')) && !existsSync(path.join(srvDir('Half'), 'mods', 'half-downloaded.jar')) && !existsSync(path.join(srvDir('Half'), 'pyide-server.unfinished'))
      && JSON.parse(text(path.join(srvDir('Half'), 'pyide-server.json'))).kind === 'paper' && (await call('minecraft:servers', proj)).some((s) => s.name === 'Half'),
    'a new create of that name replaces what was left and finishes');
    const mine = await errOf(() => create('Mine'));
    check(/not a Nano Studio server/.test(mine?.message || '') && text(path.join(srvDir('Mine'), 'notes.txt')) === 'the user\'s own folder', `a folder of the user's is refused, not removed (${mine?.message})`);
    routes.set('/files/paper.jar', Buffer.from('a different jar of the same size!!!'.slice(0, paperJar.length)));
    const cut = await errOf(() => create('Broken'));
    check(/Checksum|sha/i.test(cut?.message || '') && !existsSync(srvDir('Broken')), `a create that fails leaves nothing (${cut?.message})`);
    const twins = await Promise.allSettled([create('Twin'), create('Twin')]);
    check(twins.filter((r) => r.status === 'rejected' && /being made already/.test(r.reason.message)).length === 1 && !existsSync(srvDir('Twin')),
      `a second create of a name being made is refused, and does not take the first one's folder (${S(twins.map((r) => r.reason?.message))})`);
    stand.close();
    delete process.env.PYIDE_MC_SOURCES;
  }
} catch (err) {
  check(false, err.stack || err.message);
}
check(!realDns.length, `no name was looked up in the real DNS (${S(realDns)})`);

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
