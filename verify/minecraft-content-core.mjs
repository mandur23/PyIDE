// What comes into Nano Studio Craft from outside, in plain Node: no Electron, no network (fetch and downloads are
// stand-ins), no game. Checks: zip entry names Windows reads differently from their text (a trailing \ or dot, a . or ..
// segment) neither land as jars nor hide from the join dialog; the Market keeps a dependency another project needs,
// keeps the server's Korean translations through a resource pack's update and removal and accepts a pack folder that
// holds only them, never deletes a user's file of the same name on a bad checksum, follows dependencies given by
// version, installs no second copy of a mod already in mods/ under another name (Modrinth names it by sha1; a failed
// lookup does not stop the install), and takes a pack's own ko_kr.json with it while leaving ours; a server from a modpack keeps the dialog's port and the app's eula.txt, checks its files as the launcher
// does and picks the newest fitting version on Modrinth; a dropped resource pack replaces the old one; an imported
// server's name and settings; Forge and NeoForge installers checked with .sha1 when no .sha256 is published; a ping of a
// private server leaves the game's join process running; a join code's key under another spelling; CGNAT addresses.
// Usage: node verify/minecraft-content-core.mjs
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
const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const errOf = async (step) => { try { await step(); return null; } catch (err) { return err; } };
const filesUnder = (dir, at = '') => (existsSync(path.join(dir, at)) ? readdirSync(path.join(dir, at), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? filesUnder(dir, `${at}${e.name}/`) : [`${at}${e.name}`])).sort() : []);

const work = mkdtempSync(path.join(tmpdir(), 'pyide-mccontent-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
delete process.env.PYIDE_MC_SOURCES;
process.env.PYIDE_MC_LAUNCHER = 'off';

// Every web request answers from routes (address without its query -> {status, body}, or a function of the request
// that gives one); nothing goes out.
const routes = new Map();
const asked = [];
globalThis.fetch = async (url, init) => {
  const u = String(url).split('?')[0];
  asked.push(String(url));
  const r = typeof routes.get(u) === 'function' ? routes.get(u)(init) : routes.get(u);
  if (r === undefined) return new Response('', { status: 404 });
  const { status = 200, body } = r && typeof r === 'object' && 'body' in r ? r : { body: r };
  return new Response(Buffer.isBuffer(body) || typeof body === 'string' ? body : S(body), { status });
};
// Downloads: what `served` holds for the address, and the options each was asked with.
const served = new Map();
const fetchedOpts = [];
const fetchFile = async (url, dest, opts) => {
  fetchedOpts.push({ url, dest, opts });
  if (!served.has(url)) throw new Error(`no stand-in serves ${url}`);
  write(dest, served.get(url));
};
const never = () => { throw new Error('not in this test'); };
const API = 'https://api.modrinth.test/v2';
process.env.PYIDE_MC_SOURCES = S({ modrinth: API, forge: 'https://maven.test/forge', forgePromos: 'https://maven.test/promos.json', neoforge: 'https://maven.test/neoforge' });

const { writeZip, unpackZip } = require('../main/minecraft/zipfile.js');
const L = require('../main/minecraft/launcher.js');
const { createMarket } = require('../main/minecraft/market.js');
const { createImports } = require('../main/minecraft/imports.js');
const { KINDS } = require('../main/minecraft/sources.js');
const zip = (entries) => writeZip(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(typeof data === 'string' ? data : S(data)) })));
const KEY = crypto.randomBytes(32).toString('base64url');

try {
  // ---------- names Windows reads differently ----------
  {
    const odd = { 'overrides/mods/a.jar\\': 'a', 'overrides/mods/b.jar/.': 'b', 'client-overrides/mods/c.jar/x/..': 'c', 'overrides/mods/e.jar.': 'e', 'overrides/mods/f.jar ': 'f', 'overrides/config/ok.toml': 'x=1' };
    const z = path.join(work, 'odd.zip');
    write(z, zip(odd));
    const out = path.join(work, 'odd-out');
    unpackZip(z, out, 'overrides/');
    unpackZip(z, out, 'client-overrides/');
    check(S(filesUnder(out)) === S(['config/ok.toml']), `zip entries with a trailing \\, dot or space, or a . or .. segment are not written (${S(filesUnder(out))})`);

    const craft = L.createLauncher({ fetchFile, ensureJava: never, javaFor: never, run: never, retried: never });
    const root = path.join(work, 'craft');
    const index = (files) => ({ 'modrinth.index.json': { formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Odd', dependencies: { minecraft: '1.20.1' }, files } });
    served.set('https://packs.example/odd.mrpack', zip({ ...index([]), ...odd }));
    const req = { address: 'odd.example.test:25565', pack: 'https://packs.example/odd.mrpack', name: 'odd' };
    const ask = (await craft.join(root, req, () => {})).needsApproval;
    const yes = await craft.join(root, { ...req, approve: ask?.sha1 }, () => {});
    const jars = filesUnder(path.join(root, 'instances', yes.instance.name, 'mods'));
    check(ask && S(ask.mods) === '[]' && S(jars) === '[]', `what the join dialog shows as no mods puts no jar in mods/ (shown ${S(ask?.mods)}, written ${S(jars)})`);

    const d = Buffer.from('mod d');
    served.set('https://cdn.modrinth.com/d.jar', d);
    served.set('https://packs.example/listed.mrpack', zip(index([{ path: 'mods/d.jar\\', downloads: ['https://cdn.modrinth.com/d.jar'], hashes: { sha512: sha512(d) }, fileSize: d.length }])));
    const req2 = { address: 'listed.example.test:25565', pack: 'https://packs.example/listed.mrpack', name: 'listed' };
    const ask2 = (await craft.join(root, req2, () => {})).needsApproval;
    const applied = await errOf(() => craft.join(root, { ...req2, approve: ask2?.sha1 }, () => {}));
    const listedJar = readdirSync(path.join(root, 'instances')).some((n) => existsSync(path.join(root, 'instances', n, 'mods', 'd.jar')));
    check(applied?.code === 'badPack' && !listedJar, `a listed file named mods/d.jar\\ is refused, not written as mods/d.jar (${applied?.message})`);

    // ---------- the key under another spelling, CGNAT ----------
    const spelled = await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&k%65y=${KEY}`));
    // URLSearchParams.get gives the first: a plain key= behind it would be the one masked, and not the one used.
    const before = await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&k%65y=${KEY}&key=${crypto.randomBytes(32).toString('base64url')}`));
    const redact = require('../main/diagnostics/redact.js');
    const masked = redact.scrubText(`nanostudio:join?addr=a.test&k%65y=${KEY}`);
    check(spelled?.code === 'badCode' && before?.code === 'badCode' && L.parseJoinCode(`nanostudio:join?addr=a.test&key=${KEY}`).key === KEY,
      `a code whose key parameter is spelled k%65y is refused, alone or before a plain key=; the plain one still reads (${spelled?.message || 'parsed'}, ${before?.message || 'parsed'}; redact ${masked.includes(KEY) ? 'leaves it' : 'masks it'})`);
    const cgnat = [];
    for (const host of ['100.64.0.1', '100.100.100.100', '100.127.255.254']) cgnat.push([host, (await errOf(() => L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent(`https://${host}/p.mrpack`)}`)))?.code]);
    check(cgnat.every(([, c]) => c === 'badPack') && L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('https://100.128.0.1/p.mrpack')}`).pack
      && L.parseJoinCode(`nanostudio:join?addr=a.test&pack=${encodeURIComponent('https://100.63.255.1/p.mrpack')}`).pack,
    `a pack on 100.64.0.0/10 (CGNAT, Tailscale) is private; its neighbours are not (${S(cgnat)})`);

    // ---------- a ping of a private server ----------
    const stopped = [];
    const joins = (running) => ({ start: async () => 1, stop: (a) => { stopped.push(a); return Promise.resolve(); }, stopAll: async () => {}, running: () => running });
    const code = `nanostudio:join?addr=priv.example.test:25565&key=${KEY}`;
    await L.createLauncher({ fetchFile, ensureJava: never, javaFor: never, run: never, retried: never, joins: joins(['priv.example.test:25565']) }).ping(code);
    const keptRunning = stopped.length === 0;
    await L.createLauncher({ fetchFile, ensureJava: never, javaFor: never, run: never, retried: never, joins: joins([]) }).ping(code);
    check(keptRunning && S(stopped) === S(['priv.example.test:25565']), `a ping leaves the join process the game is using, and stops the one it started (${S(stopped)})`);

    // ---------- a Forge installer Maven publishes only a .sha1 for ----------
    const installer = Buffer.from('a forge installer');
    const base = 'https://maven.test/forge/1.20.1-47.1.0/forge-1.20.1-47.1.0-installer.jar';
    routes.set('https://maven.test/promos.json', { promos: { '1.20.1-recommended': '47.1.0' } });
    routes.set(`${base}.sha1`, sha1(installer));
    const viaSha1 = await KINDS.forge.resolve('1.20.1', '47.1.0');
    routes.delete(`${base}.sha1`);
    const said = [];
    const neither = await KINDS.forge.resolve('1.20.1', '47.1.0', (t) => said.push(t));
    routes.set(`${base}.sha256`, { status: 500, body: '' });
    const down = await errOf(() => KINDS.forge.resolve('1.20.1', '47.1.0', () => {}));
    routes.delete(`${base}.sha256`);
    check(viaSha1.sha1 === sha1(installer) && !viaSha1.sha256 && !neither.sha1 && !neither.sha256 && /no published checksum/.test(said.join('')) && /HTTP 500/.test(down?.message || ''),
      `without a .sha256 the installer is checked against Maven's .sha1; with neither it is said; a checksum Maven fails to give is an error (${S({ sha1: viaSha1.sha1, said, down: down?.message })})`);
    routes.set(`${base}.sha1`, sha1(Buffer.from('another installer')));
    served.set(base, installer);
    const forgeInst = await errOf(() => craft.create(root, { name: 'forgy', mc: '1.20.1', loader: 'forge', loaderVersion: '47.1.0' }, () => {}));
    routes.delete(`${base}.sha1`);
    check(/Checksum mismatch/.test(forgeInst?.message || '') && !existsSync(path.join(root, 'instances', 'forgy')), `an instance's Forge installer that fails its .sha1 is not run (${forgeInst?.message})`);
  }

  // ---------- the Market ----------
  const marketOf = () => createMarket({ readServer: (dir) => readJson(path.join(dir, 'pyide-server.json')), writeServer: (dir, desc) => write(path.join(dir, 'pyide-server.json'), S(desc)), fetchFile });
  const serverAt = (name, desc) => { const dir = path.join(work, 'servers', name); write(path.join(dir, 'pyide-server.json'), S(desc)); return dir; };
  const record = (dir) => readJson(path.join(dir, 'pyide-server.json')).market || {};
  const file = (name, data, more = {}) => { const b = Buffer.from(data); served.set(`https://cdn.modrinth.com/${name}`, b); return { filename: name, url: `https://cdn.modrinth.com/${name}`, primary: true, size: b.length, hashes: { sha512: sha512(b) }, ...more }; };
  const project = (id, versions, more = {}) => { routes.set(`${API}/project/${id}`, { id, title: id, server_side: 'required', ...more }); routes.set(`${API}/project/${id}/version`, versions); };
  const ver = (id, files, more = {}) => ({ id, version_number: id, version_type: 'release', loaders: ['forge'], game_versions: ['1.20.1'], files, dependencies: [], ...more });
  {
    const shop = marketOf();
    const dir = serverAt('needed', { kind: 'forge', mc: '1.20.1', market: {
      A: { title: 'Mod A', version: '1', versionId: 'a1', files: ['mods/a.jar'], needs: [], dependency: false },
      B: { title: 'Mod B', version: '1', versionId: 'b1', files: ['mods/b.jar'], needs: ['A'], dependency: false } } });
    write(path.join(dir, 'mods', 'a.jar'), 'a');
    write(path.join(dir, 'mods', 'b.jar'), 'b');
    const out = await shop.remove(dir, 'A');
    check(S(out.neededBy) === S(['Mod B']) && S(out.removed) === '[]' && existsSync(path.join(dir, 'mods', 'a.jar')) && record(dir).A, `Remove of a project another kept project needs is refused, naming it (${S(out)})`);
    await shop.remove(dir, 'B');
    check(!existsSync(path.join(dir, 'mods', 'b.jar')) && existsSync(path.join(dir, 'mods', 'a.jar')), 'the project that needs it still goes, and leaves what was installed for itself');

    // A user's file of the same name, and a download that fails its checksum.
    const mine = serverAt('mine', { kind: 'forge', mc: '1.20.1' });
    write(path.join(mine, 'mods', 'same.jar'), 'the user\'s own');
    project('SAME', [ver('s1', [{ ...file('same.jar', 'the market\'s'), hashes: { sha512: '0'.repeat(128) } }])]);
    const bad = await errOf(() => shop.install(mine, { id: 'SAME', type: 'mod' }, () => {}));
    check(/Checksum mismatch/.test(bad?.message || '') && text(path.join(mine, 'mods', 'same.jar')) === 'the user\'s own' && S(readdirSync(path.join(mine, 'mods'))) === S(['same.jar']),
      `a download that fails its checksum leaves the user's file of that name as it was, and nothing beside it (${S(readdirSync(path.join(mine, 'mods')))})`);

    // Dependencies given by a version.
    const deps = serverAt('deps', { kind: 'forge', mc: '1.20.1' });
    routes.set(`${API}/version/LIBV1`, ver('LIBV1', [file('lib-1.jar', 'lib 1')], { project_id: 'LIB' }));
    project('LIB', [ver('LIBV2', [file('lib-2.jar', 'lib 2')])]);
    routes.set(`${API}/version/PINV1`, ver('PINV1', [file('pin-1.jar', 'pin 1')], { project_id: 'PIN' }));
    project('PIN', [ver('PINV2', [file('pin-2.jar', 'pin 2')])]);
    routes.set(`${API}/version/FABV`, ver('FABV', [file('fab.jar', 'fabric only')], { project_id: 'FAB', loaders: ['fabric'] }));
    project('FAB', [ver('FABV2', [file('fab-forge.jar', 'for forge')])]);
    project('TOP', [ver('top1', [file('top.jar', 'top')], { dependencies: [
      { project_id: null, version_id: 'LIBV1', dependency_type: 'required' }, { project_id: 'PIN', version_id: 'PINV1', dependency_type: 'required' },
      { project_id: null, version_id: 'FABV', dependency_type: 'required' }] })]);
    await errOf(() => shop.install(deps, { id: 'TOP', type: 'mod' }, () => {}));
    const got = filesUnder(path.join(deps, 'mods'));
    check(S(got) === S(['fab-forge.jar', 'lib-1.jar', 'pin-1.jar', 'top.jar']) && record(deps).LIB?.versionId === 'LIBV1' && S([...(record(deps).TOP?.needs || [])].sort()) === S(['FAB', 'LIB', 'PIN']),
      `a dependency given only by its version is installed, a pinned version is the one installed, and one for another loader falls back to the project's own (${S(got)}, needs ${S(record(deps).TOP?.needs)})`);

    // A mod already in mods/ under another name (a modpack's own jar): Modrinth names it by its sha1.
    const twice = serverAt('twice', { kind: 'forge', mc: '1.20.1', market: { OWN: { title: 'Own', version: '1', versionId: 'o1', files: ['mods/own.jar'], needs: [], dependency: false } } });
    write(path.join(twice, 'mods', 'jei-pack-9.jar'), 'jei 9 from the modpack');
    write(path.join(twice, 'mods', 'own.jar'), 'the market\'s own');
    write(path.join(twice, 'mods', 'notes.txt'), 'not a jar');
    const known = { [sha1('jei 9 from the modpack')]: { id: 'jei9', project_id: 'JEI' } };
    const posts = [];
    routes.set(`${API}/version_files`, (init) => {
      const body = JSON.parse(init?.body || '{}');
      posts.push({ method: init?.method, ...body });
      return Object.fromEntries((body.hashes || []).filter((h) => known[h]).map((h) => [h, known[h]]));
    });
    project('JEI', [ver('jei15', [file('jei-15.jar', 'jei 15')])], { title: 'JEI' });
    const said = [];
    const dup = await errOf(async () => { const r = await shop.install(twice, { id: 'JEI', type: 'mod' }, (t) => said.push(t)); if (S(r.duplicate) !== S({ title: 'JEI', file: 'mods/jei-pack-9.jar' }) || r.installed.length) throw new Error(S(r)); });
    check(!dup && S(filesUnder(path.join(twice, 'mods'))) === S(['jei-pack-9.jar', 'notes.txt', 'own.jar']) && !record(twice).JEI
      && posts.length === 1 && posts[0].method === 'POST' && posts[0].algorithm === 'sha1' && S(posts[0].hashes) === S([sha1('jei 9 from the modpack')]),
    `a mod already in mods/ under another file name is not installed again: the result names that file; only jars the Market did not install are asked about (${dup?.message || S(posts)})`);
    project('USES', [ver('uses1', [file('uses.jar', 'uses jei')], { dependencies: [{ project_id: 'JEI', dependency_type: 'required' }] })], { title: 'Uses JEI' });
    const hashed = [];
    const createHash = crypto.createHash;
    crypto.createHash = (algo, ...rest) => { hashed.push(algo); return createHash.call(crypto, algo, ...rest); };
    let usesOut;
    try { usesOut = await shop.install(twice, { id: 'USES', type: 'mod' }, () => {}); } catch (err) { usesOut = { err: err.message }; } finally { crypto.createHash = createHash; }
    check(S(usesOut?.present) === S([{ title: 'JEI', file: 'mods/jei-pack-9.jar' }]) && S(filesUnder(path.join(twice, 'mods'))) === S(['jei-pack-9.jar', 'notes.txt', 'own.jar', 'uses.jar']) && !record(twice).JEI && record(twice).USES,
      `a required dependency already in mods/ under another name is left out and said (${S(usesOut)})`);
    check(posts.length === 1 && !hashed.includes('sha1'), `a jar seen before (same path, size and time) is neither hashed nor asked about again (${posts.length} lookups, hashes ${S(hashed)})`);
    write(path.join(twice, 'mods', 'other.jar'), 'something Modrinth does not know');
    routes.set(`${API}/version_files`, { status: 500, body: 'down' });
    said.length = 0;
    const offline = await errOf(() => shop.install(twice, { id: 'SAME', type: 'mod' }, (t) => said.push(t)));
    routes.set(`${API}/version_files`, () => { throw new TypeError('fetch failed'); });
    project('LONE', [ver('lone1', [file('lone.jar', 'lone')])]);
    const unreachable = await errOf(() => shop.install(twice, { id: 'LONE', type: 'mod' }, (t) => said.push(t)));
    routes.delete(`${API}/version_files`);
    check(/Checksum mismatch/.test(offline?.message || '') && !unreachable && existsSync(path.join(twice, 'mods', 'lone.jar')) && said.filter((t) => /without that check/.test(t)).length === 2,
      `a lookup Modrinth fails (HTTP 500, no network) does not stop an install: it is logged and the install goes on (${unreachable?.message || S(said)})`);
  }
  {
    // The server's Korean (translate.js) in resourcepack/assets/<ns>/lang/ko_kr.json.
    const shop = marketOf();
    const ko = { 'item.tm.gem': '보석' };
    const rp = (id, entries) => { const b = zip(entries); served.set(`https://cdn.modrinth.com/${id}.zip`, b); return { filename: `${id}.zip`, url: `https://cdn.modrinth.com/${id}.zip`, primary: true, size: b.length, hashes: { sha512: sha512(b) } }; };
    project('RP', [ver('rp2', [rp('rp2', { 'pack.mcmeta': '{"pack":{"pack_format":15}}', 'assets/minecraft/textures/new.png': 'new' })], { loaders: ['minecraft'] })]);
    const owned = serverAt('owned', { kind: 'paper', mc: '1.20.1', market: { RP: { title: 'RP', version: 'rp1', versionId: 'rp1', files: ['resourcepack'], needs: [], dependency: false } } });
    write(path.join(owned, 'resourcepack', 'pack.mcmeta'), '{"pack":{"pack_format":15}}');
    write(path.join(owned, 'resourcepack', 'assets', 'minecraft', 'textures', 'old.png'), 'old');
    write(path.join(owned, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json'), S(ko));
    await errOf(() => shop.install(owned, { id: 'RP', type: 'resourcepack' }, () => {}));
    check(S(filesUnder(path.join(owned, 'resourcepack'))) === S(['assets/minecraft/textures/new.png', 'assets/tm/lang/ko_kr.json', 'pack.mcmeta']) && S(readJson(path.join(owned, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json'))) === S(ko),
      `a Market resource pack's update keeps the translations (${S(filesUnder(path.join(owned, 'resourcepack')))})`);
    await errOf(() => shop.remove(owned, 'RP'));
    check(S(filesUnder(path.join(owned, 'resourcepack'))) === S(['assets/tm/lang/ko_kr.json', 'pack.mcmeta']) && !record(owned).RP,
      `its removal keeps them too, with the pack.mcmeta that makes them a pack (${S(filesUnder(path.join(owned, 'resourcepack')))})`);

    const translated = serverAt('translated', { kind: 'paper', mc: '1.20.1' });
    write(path.join(translated, 'resourcepack', 'pack.mcmeta'), '{"pack":{"pack_format":15,"description":"made for translations"}}');
    mkdirSync(path.join(translated, 'resourcepack', 'assets', 'minecraft', 'textures'), { recursive: true });
    write(path.join(translated, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json'), S(ko));
    project('RPK', [ver('rpk1', [rp('rpk1', { 'pack.mcmeta': '{"pack":{"pack_format":15}}', 'assets/tm/lang/ko_kr.json': { 'item.tm.gem': '팩의 보석', 'item.tm.ore': '광석' } })], { loaders: ['minecraft'] })]);
    const accepted = await errOf(() => shop.install(translated, { id: 'RPK', type: 'resourcepack' }, () => {}));
    const merged = existsSync(path.join(translated, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json')) ? readJson(path.join(translated, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json')) : null;
    check(!accepted && record(translated).RPK && S(merged) === S({ 'item.tm.gem': '팩의 보석', 'item.tm.ore': '광석' }),
      `a pack folder that holds only translations takes a Market resource pack, its lines merged in (${accepted?.message || S(merged)})`);
    const own = serverAt('own', { kind: 'paper', mc: '1.20.1' });
    write(path.join(own, 'resourcepack', 'pack.mcmeta'), '{}');
    write(path.join(own, 'resourcepack', 'assets', 'minecraft', 'textures', 'mine.png'), 'mine');
    const refused = await errOf(() => shop.install(own, { id: 'RPK', type: 'resourcepack' }, () => {}));
    check(/own resource pack/.test(refused?.message || '') && text(path.join(own, 'resourcepack', 'assets', 'minecraft', 'textures', 'mine.png')) === 'mine', 'a pack of the user\'s own is still refused and left alone');

    // The pack's own ko_kr.json files go with it; ours (merged into one of them, or written beside) stay.
    const lang = (ns) => path.join('resourcepack', 'assets', ns, 'lang', 'ko_kr.json');
    const packs = serverAt('packs', { kind: 'paper', mc: '1.20.1' });
    write(path.join(packs, lang('tm')), S(ko));
    project('RPL', [ver('rpl1', [rp('rpl1', { 'pack.mcmeta': '{"pack":{"pack_format":15}}', 'assets/pk/lang/ko_kr.json': { 'item.pk.a': '팩' }, 'assets/pk2/lang/ko_kr.json': { 'item.pk2.a': '팩 2' },
      'assets/tm/lang/ko_kr.json': { 'item.tm.ore': '광석' } })], { loaders: ['minecraft'] })]);
    await shop.install(packs, { id: 'RPL', type: 'resourcepack' }, () => {});
    // translate.js later adds a line to one of the pack's files, and a file of its own.
    write(path.join(packs, lang('pk2')), S({ 'item.pk2.a': '팩 2', 'item.pk2.b': '우리 번역' }));
    write(path.join(packs, lang('new')), S({ 'item.new.a': '새것' }));
    project('RPL', [ver('rpl2', [rp('rpl2', { 'pack.mcmeta': '{"pack":{"pack_format":15}}', 'assets/minecraft/textures/v2.png': 'v2' })], { loaders: ['minecraft'] })]);
    await shop.install(packs, { id: 'RPL', type: 'resourcepack' }, () => {});
    const updated = filesUnder(path.join(packs, 'resourcepack'));
    check(S(updated) === S(['assets/minecraft/textures/v2.png', 'assets/new/lang/ko_kr.json', 'assets/pk2/lang/ko_kr.json', 'assets/tm/lang/ko_kr.json', 'pack.mcmeta'])
      && readJson(path.join(packs, lang('pk2')))['item.pk2.b'] === '우리 번역' && S(readJson(path.join(packs, lang('tm')))) === S({ ...ko, 'item.tm.ore': '광석' }),
    `an update leaves out the old pack's own unchanged ko_kr.json and carries the ones with our lines (${S(updated)})`);
    project('RPL', [ver('rpl3', [rp('rpl3', { 'pack.mcmeta': '{"pack":{"pack_format":15}}', 'assets/pk3/lang/ko_kr.json': { 'item.pk3.a': '팩 3' } })], { loaders: ['minecraft'] })]);
    await shop.install(packs, { id: 'RPL', type: 'resourcepack' }, () => {});
    await shop.remove(packs, 'RPL');
    const left = filesUnder(path.join(packs, 'resourcepack'));
    check(S(left) === S(['assets/new/lang/ko_kr.json', 'assets/pk2/lang/ko_kr.json', 'assets/tm/lang/ko_kr.json', 'pack.mcmeta']) && !record(packs).RPL,
      `Remove takes the pack's own ko_kr.json with it and keeps the translations (${S(left)})`);
    const alone = serverAt('alone', { kind: 'paper', mc: '1.20.1' });
    await shop.install(alone, { id: 'RPL', type: 'resourcepack' }, () => {});
    await shop.remove(alone, 'RPL');
    check(!existsSync(path.join(alone, 'resourcepack')), `a pack whose only language files are its own goes entirely (${S(filesUnder(path.join(alone, 'resourcepack')))})`);
  }

  // ---------- imports ----------
  {
    const root = path.join(work, 'imports');
    const made = [];
    const unfinished = { claim: (dir) => mkdirSync(dir, { recursive: true }), done() {}, undo: (dir) => rmSync(dir, { recursive: true, force: true }) };
    const create = async ({ root: r, name, port }) => {
      made.push(name);
      const dir = path.join(r, 'servers', name);
      write(path.join(dir, 'eula.txt'), '# Accepted in Nano Studio\neula=true\n');
      write(path.join(dir, 'server.properties'), `server-port=${port}\nmotd=${name}\n`);
      write(path.join(dir, 'pyide-server.json'), S({ kind: 'fabric', mc: '1.20.1', loader: '0.15.11', memory: '2G' }));
      return { name, dir };
    };
    const servers = [];
    const im = createImports({ root, servers: () => servers, create, unfinished, javaFor: async () => 17, javaOfJar: () => 17, fetchFile,
      writeServer: (dir, desc) => write(path.join(dir, 'pyide-server.json'), S(desc)), readServer: (dir) => { try { return readJson(path.join(dir, 'pyide-server.json')); } catch { return null; } } });
    const mrpack = (name, files, entries = {}) => {
      const p = path.join(work, 'packs', `${crypto.randomBytes(4).toString('hex')}.mrpack`);
      write(p, zip({ 'modrinth.index.json': { formatVersion: 1, game: 'minecraft', versionId: '1', name, dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }, files }, ...entries }));
      return p;
    };
    // The dialog's port and the app's eula.txt survive the pack's overrides.
    const withProps = mrpack('Props', [], { 'overrides/server.properties': 'server-port=25565\nmotd=Pack MOTD\ndifficulty=hard\n', 'overrides/eula.txt': 'eula=false\n', 'server-overrides/config/x.toml': 'x=1' });
    const srv = await im.createFromModpack({ file: withProps, name: 'props', memory: '2G', port: 25999, eula: true }, () => {});
    const props = text(path.join(srv.dir, 'server.properties')) || '';
    check(/^server-port=25999$/m.test(props) && /^difficulty=hard$/m.test(props) && /^motd=Pack MOTD$/m.test(props) && /^eula=true$/m.test(text(path.join(srv.dir, 'eula.txt')) || '') && existsSync(path.join(srv.dir, 'config', 'x.toml')),
      `a modpack's server.properties keeps the dialog's port, its other lines are the pack's, and its eula.txt does not replace the user's agreement (${S(props)}, ${S(text(path.join(srv.dir, 'eula.txt')))})`);

    // The files a pack lists: checksums in capitals, a mirror that serves something else, the size as the limit.
    const m = Buffer.from('server mod');
    served.set('https://cdn.modrinth.com/srv.jar', Buffer.from('tampered'));
    served.set('https://github.com/o/r/releases/download/v1/srv.jar', m);
    const listed = mrpack('Listed', [{ path: 'mods/srv.jar', downloads: ['https://cdn.modrinth.com/srv.jar', 'https://github.com/o/r/releases/download/v1/srv.jar'], hashes: { sha512: sha512(m).toUpperCase() }, fileSize: m.length }]);
    const before = fetchedOpts.length;
    const listedErr = await errOf(() => im.createFromModpack({ file: listed, name: 'listed', memory: '2G', port: 25998, eula: true }, () => {}));
    const asks = fetchedOpts.slice(before);
    check(!listedErr && text(path.join(root, 'servers', 'listed', 'mods', 'srv.jar')) === 'server mod' && asks.every((a) => a.opts.limit === m.length),
      `a server's modpack file is checked as the launcher checks one: any case, the next mirror after a wrong one, its size as the limit (${listedErr?.message || S(asks.map((a) => [a.url, a.opts.limit]))})`);

    // A name Windows keeps for a device is not a folder name.
    made.length = 0;
    await errOf(() => im.createFromModpack({ file: mrpack('aux', []), memory: '2G', port: 25997, eula: true }, () => {}));
    check(made.length === 1 && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(made[0]), `a modpack named aux gets a server name Windows allows (${S(made)})`);

    // Modrinth: the newest version for a loader a server runs, a release before a beta, then its primary .mrpack.
    const mr = (name, primary) => { const b = Buffer.from(name); served.set(`https://cdn.modrinth.com/${name}`, b); return { filename: name, url: `https://cdn.modrinth.com/${name}`, primary, hashes: { sha512: sha512(b) } }; };
    routes.set(`${API}/project/picky/version`, [
      { id: 'v4', version_type: 'beta', loaders: ['fabric'], date_published: '2024-04-01T00:00:00Z', files: [mr('beta.mrpack', true)] },
      { id: 'v3', version_type: 'release', loaders: ['quilt'], date_published: '2024-03-01T00:00:00Z', files: [mr('quilt.mrpack', true)] },
      { id: 'v2', version_type: 'release', loaders: ['fabric'], date_published: '2024-02-01T00:00:00Z', files: [mr('notes.txt', true), mr('newest.mrpack', false)] },
      { id: 'v1', version_type: 'release', loaders: ['fabric'], date_published: '2024-01-01T00:00:00Z', files: [mr('old.mrpack', true)] },
    ]);
    const picked = await errOf(async () => { const p = await im.fromModrinth('picky', () => {}); const t = readFileSync(p, 'utf8'); rmSync(p, { force: true }); if (t !== 'newest.mrpack') throw new Error(`picked ${t}`); });
    check(!picked, `of a Modrinth modpack's versions the newest release for Fabric, Forge or NeoForge is downloaded, not an older one's primary file (${picked?.message || 'newest.mrpack'})`);
    routes.set(`${API}/project/betas/version`, [{ id: 'b2', version_type: 'beta', loaders: ['forge'], date_published: '2024-02-01T00:00:00Z', files: [mr('b2.mrpack', true)] },
      { id: 'b1', version_type: 'alpha', loaders: ['forge'], date_published: '2024-01-01T00:00:00Z', files: [mr('b1.mrpack', true)] }]);
    const beta = await im.fromModrinth('betas', () => {});
    check(readFileSync(beta, 'utf8') === 'b2.mrpack', 'with no release the newest version is taken');
    rmSync(beta, { force: true });

    // A server folder brought in keeps the memory and JVM options its own pyide-server.json gave.
    const src = path.join(work, 'outside', 'MyServer');
    write(path.join(src, 'server.properties'), 'server-port=25565\n');
    write(path.join(src, 'paper.jar'), zip({ 'META-INF/versions.list': 'abc\t1.20.1\tpaper-1.20.1.jar\n' }));
    write(path.join(src, 'pyide-server.json'), S({ kind: 'paper', mc: '1.20.1', memory: '6G', jvmArgs: ['-XX:+UseZGC'] }));
    const imported = await im.importServer(src, () => {});
    const desc = readJson(path.join(imported.dir, 'pyide-server.json'));
    check(desc.memory === '6G' && S(desc.jvmArgs) === S(['-XX:+UseZGC']) && desc.kind === 'paper', `an imported server keeps the memory and JVM options it had (${S(desc)})`);
    const src2 = path.join(work, 'outside', 'Odd');
    write(path.join(src2, 'server.properties'), '');
    write(path.join(src2, 'paper.jar'), zip({ 'META-INF/versions.list': 'abc\t1.20.1\tpaper-1.20.1.jar\n' }));
    write(path.join(src2, 'pyide-server.json'), S({ memory: 'lots', jvmArgs: ['-Xmx99G'] }));
    const desc2 = readJson(path.join((await im.importServer(src2, () => {})).dir, 'pyide-server.json'));
    check(desc2.memory === '2G' && !desc2.jvmArgs, `memory or options that are not valid are not kept (${S(desc2)})`);

    // A dropped resource pack replaces the Market's: nothing of the old one stays, and the Market no longer claims it.
    const card = path.join(root, 'servers', 'card');
    write(path.join(card, 'pyide-server.json'), S({ kind: 'paper', mc: '1.20.1', market: { RP: { title: 'RP', version: '1', versionId: 'r1', files: ['resourcepack'], needs: [], dependency: false } } }));
    write(path.join(card, 'resourcepack', 'pack.mcmeta'), '{}');
    write(path.join(card, 'resourcepack', 'assets', 'minecraft', 'textures', 'old.png'), 'old');
    write(path.join(card, 'resourcepack', 'assets', 'tm', 'lang', 'ko_kr.json'), S({ 'item.tm.gem': '보석' }));
    servers.push({ name: 'card', dir: card, proxy: false });
    const dropped = path.join(work, 'drops', 'new-pack.zip');
    write(dropped, zip({ 'pack.mcmeta': '{"pack":{"pack_format":15}}', 'assets/minecraft/textures/new.png': 'new' }));
    const r = await im.drop(card, [dropped], () => {});
    check(r.done.length === 1 && S(filesUnder(path.join(card, 'resourcepack'))) === S(['assets/minecraft/textures/new.png', 'assets/tm/lang/ko_kr.json', 'pack.mcmeta']) && !readJson(path.join(card, 'pyide-server.json')).market?.RP,
      `a dropped pack replaces the old one, keeps the translations and takes the Market's record of the old (${S(filesUnder(path.join(card, 'resourcepack')))}, ${S(r.skipped)})`);
    const folderPack = path.join(work, 'drops', 'FolderPack');
    write(path.join(folderPack, 'pack.mcmeta'), '{"pack":{"pack_format":15,"description":"folder"}}');
    write(path.join(folderPack, 'assets', 'minecraft', 'textures', 'folder.png'), 'folder');
    const r2 = await im.drop(card, [folderPack], () => {});
    check(r2.done.length === 1 && S(filesUnder(path.join(card, 'resourcepack'))) === S(['assets/minecraft/textures/folder.png', 'assets/tm/lang/ko_kr.json', 'pack.mcmeta']) && !existsSync(path.join(card, 'resourcepack.drop')),
      `a dropped pack folder replaces a pack of the user's own the same way (${S(filesUnder(path.join(card, 'resourcepack')))})`);  }
} catch (err) {
  check(false, err.stack || err.message);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
