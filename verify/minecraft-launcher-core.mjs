// Nano Studio Craft's launcher core (main/minecraft/launcher.js) in plain Node: no Electron, no network, no real
// launcher (a Node script that exits stands in for it), no game. Checks: launcher_profiles.json with a UTF-8 BOM keeps
// the user's profiles, a profiles field that is not an object is backed up before it is replaced, snapshot ids are
// refused for instances and packs, join codes are found in pasted text with punctuation around them, a join code's
// pack is https only, and a pack's files come over https from the hosts Modrinth's format allows, or from the
// PYIDE_MC_SOURCES stand-in's origin only. Usage: node verify/minecraft-launcher-core.mjs
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');
const errOf = async (step) => { try { await step(); return null; } catch (err) { return err; } };

const work = mkdtempSync(path.join(tmpdir(), 'pyide-mclauncher-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
delete process.env.PYIDE_MC_SOURCES;
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
    craft.remove(root, inst.name);
    rmSync(inst.dir, { recursive: true, force: true });
  }
  check(allowed.every(([, ok]) => ok), `pack files from cdn.modrinth.com, github.com, raw.githubusercontent.com and gitlab.com over https are downloaded (${S(allowed)})`);
  const mixed = await files(['http://10.0.0.1/a.jar', 'https://github.com/o/r/releases/download/v1/b.jar']);
  check(fetched.at(-1) === 'https://github.com/o/r/releases/download/v1/b.jar', 'of several download addresses the first allowed one is used');
  craft.remove(root, mixed.name);
  rmSync(mixed.dir, { recursive: true, force: true });

  process.env.PYIDE_MC_SOURCES = S({ modrinth: 'http://127.0.0.1:5999/modrinth', mojang: 'http://127.0.0.1:5999/mojang/manifest.json' });
  const standIn = await files(['http://127.0.0.1:5999/files/a.jar']);
  check(fetched.at(-1) === 'http://127.0.0.1:5999/files/a.jar' && standIn.pack.files.length === 1, 'with PYIDE_MC_SOURCES a pack file may come from the stand-in\'s origin');
  craft.remove(root, standIn.name);
  rmSync(standIn.dir, { recursive: true, force: true });
  const otherPort = await errOf(() => files(['http://127.0.0.1:6000/files/a.jar']));
  const otherHost = await errOf(() => files(['http://localhost:5999/files/a.jar']));
  check(otherPort?.code === 'badPack' && otherHost?.code === 'badPack', 'but not from another port or host: the stand-in is no general bypass');
  check(L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('http://127.0.0.1:5999/packs/p.mrpack')}`).pack === 'http://127.0.0.1:5999/packs/p.mrpack'
    && (await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('http://127.0.0.1:6000/packs/p.mrpack')}`)))?.code === 'badPack',
  'a join code\'s pack may be on the stand-in\'s origin, and only there');
  delete process.env.PYIDE_MC_SOURCES;
} catch (err) {
  check(false, err.stack || err.message);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
