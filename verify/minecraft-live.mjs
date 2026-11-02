// Craft's Minecraft servers against the real services (opt-in, not in CI: it downloads servers, installers and Java,
// a few hundred MB). Creates one server of each kind in a craft window, then starts each Minecraft server with eula.txt
// set back to false, so the real server unpacks or downloads what it needs and stops at Mojang's EULA check: nothing is
// agreed to here. A Velocity proxy has no EULA and runs for real, wired to the Paper server. Also: resource packs whose
// format comes from the real servers' version.json.
// MC_LIVE_KINDS=paper,velocity limits the kinds. MC_LIVE_MODPACK=<Modrinth slug> makes a server from that modpack and
// starts it as far as the EULA check. Port 9792.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'mclive-'));
const project = path.join(work, 'p');
mkdirSync(project);
const SERVERS = [
  { kind: 'paper', mc: '1.21.11', name: 'paper', java: 21 },
  { kind: 'purpur', mc: '1.21.11', name: 'purpur', java: 21 },
  { kind: 'velocity', mc: '4.3.1', name: 'proxy', java: 25 },
  { kind: 'vanilla', mc: '26.3', name: 'vanilla', java: 25 },
  { kind: 'fabric', mc: '26.3', name: 'fabric', java: 25 },
  { kind: 'forge', mc: '1.20.1', name: 'forge', java: 17 },
  { kind: 'neoforge', mc: '1.21.1', name: 'neoforge', java: 21 },
].filter((s) => !process.env.MC_LIVE_KINDS || process.env.MC_LIVE_KINDS.split(',').includes(s.kind));
const has = (kind) => SERVERS.some((s) => s.kind === kind);

const t = await launch({ name: 'minecraft-live', port: 9792, mode: 'craft', projectDir: project, env: { PYIDE_CRAFT_HOME: project, PYIDE_MC_LAUNCHER_IMAGE: 'nano-no-such-launcher.exe', PYIDE_INSTALL_ROOT: path.join(work, 'root') } });
const { js, until, check, sleep, shot } = t;
const tab = (title) => `ide.run.sessions().find((s) => s.title === ${S(title)})`;
const tabText = (title) => js(`${tab(title)}?.host.textContent || ''`);
const elapsed = (t0) => `${Math.round((Date.now() - t0) / 1000)} s`;
const serverDir = (name) => path.join(project, 'servers', name);
const runServer = (name) => js(`ide.run.runConfig(ide.run.configs().find((c) => c.type === 'minecraft-server' && c.dir === 'servers/${name}'))`);
const ended = (name, ms) => until(`${tab(name)} && !${tab(name)}.running && !${tab(name)}.starting && /Process finished/.test(${tab(name)}.host.textContent)`, `${name} ended`, ms).catch(() => {});
try {
  await js(`(ide.settings.set('ports.confirmShare', false), ide.settings.set('ports.confirmShareTcp', false), ide.minecraft.screen.show('servers'), true)`);
  for (const s of SERVERS) {
    const t0 = Date.now();
    await js(`(window.__mcDone = null, ide.minecraft.createServer({ name: ${S(s.name)}, kind: ${S(s.kind)}, mc: ${S(s.mc)}, memory: '2G', port: ${25700 + SERVERS.indexOf(s)} }).then((r) => { window.__mcDone = r ? 'ok' : 'failed'; }), true)`);
    await until('window.__mcDone !== null', `${s.kind} created`, 1200000);
    const made = await js(`ide.minecraft.servers().find((x) => x.name === ${S(s.name)}) || null`);
    if (!made) {
      check(false, `${s.kind} ${s.mc} is created (${(await tabText('Minecraft: New Server')).slice(-2500)})`);
      continue;
    }
    check(made.java === s.java, `${s.kind} ${s.mc} is created in ${elapsed(t0)} with Java ${made.java} (${S(made.launch)}${made.loader ? `, loader ${made.loader}` : ''}${made.build ? `, build ${made.build}` : ''})`);
    if (s.kind === 'velocity') continue;
    writeFileSync(path.join(serverDir(s.name), 'eula.txt'), 'eula=false\n');
    const t1 = Date.now();
    await runServer(s.name);
    await ended(s.name, 900000);
    const out = await tabText(s.name);
    const eulaStop = /agree to the EULA|EULA/i.test(out);
    check(eulaStop, `${s.kind} starts with its Java and stops at the EULA check (${elapsed(t1)})${eulaStop ? '' : `: ${out.slice(-2500)}`}`);
  }

  if (process.env.MC_LIVE_MODPACK) {
    // A real Modrinth modpack by its address: the server gets its Minecraft, exact loader and server mods, and is
    // started as far as the EULA check (Fabric loads the mods before it).
    const t3 = Date.now();
    const info = await js(`ide.api.invoke('minecraft:modpackInfo', ide.root, { url: ${S(`https://modrinth.com/modpack/${process.env.MC_LIVE_MODPACK}`)} }, 'live')`);
    check(info?.mc && info.serverFiles > 0, `the modpack ${process.env.MC_LIVE_MODPACK} is read from Modrinth (${S({ name: info?.name, version: info?.version, mc: info?.mc, kind: info?.kind, loader: info?.loader, serverFiles: info?.serverFiles, clientOnly: info?.clientOnly })})`);
    const made = await js(`ide.minecraft.createFromModpack({ file: ${S(info.file)}, name: 'pack', memory: '2G', port: 25790 }).then((r) => !!r)`);
    const packDir = serverDir('pack');
    const mods = existsSync(path.join(packDir, 'mods')) ? readdirSync(path.join(packDir, 'mods')) : [];
    check(made && mods.length > 0, `a server is made from it in ${elapsed(t3)} with its server mods (${mods.length}: ${mods.slice(0, 4).join(', ')}…)${made ? '' : `: ${(await tabText('Minecraft: New Server')).slice(-2000)}`}`);
    if (made) {
      writeFileSync(path.join(packDir, 'eula.txt'), 'eula=false\n');
      await runServer('pack');
      await ended('pack', 900000);
      const out = await tabText('pack');
      check(/EULA/i.test(out) && /Loading \d+ mods|Loaded \d+ mods|mods? loaded/i.test(out), `the modpack server loads its mods and stops at the EULA check${/EULA/.test(out) ? '' : `: ${out.slice(-2500)}`}`);
    }
  }

  if (has('paper')) {
    const rp = await js(`ide.api.invoke('minecraft:newResourcePack', ide.root, ${S(serverDir('paper'))}).then((r) => r, (e) => ({ error: e.message }))`);
    const meta = rp.error ? rp.error : readFileSync(path.join(serverDir('paper'), 'resourcepack', 'pack.mcmeta'), 'utf8');
    check(!rp.error && /"min_format": 75|"pack_format": \d+|"min_format": \d+/.test(meta), `the resource pack's format comes from the real Paper's Minecraft jar: ${meta.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (has('vanilla')) {
    const rp = await js(`ide.api.invoke('minecraft:newResourcePack', ide.root, ${S(serverDir('vanilla'))}).then((r) => r, (e) => ({ error: e.message }))`);
    const meta = rp.error ? rp.error : readFileSync(path.join(serverDir('vanilla'), 'resourcepack', 'pack.mcmeta'), 'utf8');
    check(!rp.error && /"min_format"/.test(meta), `Minecraft 26.3's resource pack uses min_format/max_format: ${meta.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  if (has('velocity') && has('paper')) {
    // The proxy runs for real: no EULA. It is wired to the Paper servers.
    await runServer('proxy');
    await until(`/Done \\(|Listening on/.test(${tab('proxy')}?.host.textContent || '')`, 'proxy up', 300000).catch(() => {});
    const out = await tabText('proxy');
    check(/Done \(|Listening on/.test(out) && /Players are sent on to: paper/.test(out), `the real Velocity proxy starts, sent on to the Paper servers${/Done \(/.test(out) ? '' : `: ${out.slice(-2500)}`}`);
    const toml = readFileSync(path.join(serverDir('proxy'), 'velocity.toml'), 'utf8');
    check(/^"paper" = "127\.0\.0\.1:257\d\d"$/m.test(toml) && existsSync(path.join(serverDir('paper'), 'config', 'paper-global.yml')), 'velocity.toml lists the Paper server, and Paper takes the forwarding secret');
    await js(`${tab('proxy')}.stop()`);
    await ended('proxy', 60000);
    check(!(await js(`${tab('proxy')}.running`)) && !/killed/i.test(await tabText('proxy')), 'Stop ends the real proxy with its own command');
  }
} catch (err) {
  check(false, err.message);
}
await js(`ide.run.sessions().forEach((s) => s.running && s.stop())`).catch(() => {});
await sleep(3000);
console.log(`work folder: ${work}`);
t.finish();
