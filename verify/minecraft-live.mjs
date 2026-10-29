// Minecraft servers against the real services (opt-in, not in CI: it downloads servers, installers and Java, a few
// hundred MB). Creates one server of each kind through the IDE, then starts each Minecraft server with eula.txt set
// back to false, so the real server unpacks or downloads what it needs and stops at Mojang's EULA check: nothing is
// agreed to here. A Velocity proxy has no EULA and runs for real: it is wired to the Paper server and loads a Velocity
// plugin built in the IDE. Also: a plugin built against the real Paper, and resource packs whose format comes from the
// real servers' version.json.
// MC_LIVE_KINDS=paper,velocity limits the kinds. MC_LIVE_LSP=1 opens the Paper plugin with the Eclipse JDT Language
// Server (the pinned archive, cached in verify/out/downloads-cache like verify/java-lsp.mjs) and checks the editor
// knows the Paper API. MC_LIVE_GRADLE=1 builds a renamed mod from the real Forge MDK and from Fabric's example mod with
// Gradle and deploys them (Minecraft and Gradle download, ~15 minutes). MC_LIVE_MODPACK=<Modrinth slug> makes a server
// from that modpack and starts it as far as the EULA check. Port 9792.
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

// The JDT LS archive for MC_LIVE_LSP, handed out by a local server as verify/java-lsp.mjs does.
const env = { PYIDE_INSTALL_ROOT: path.join(work, 'root') };
let lspServer = null;
if (process.env.MC_LIVE_LSP === '1') {
  const name = 'jdt-language-server-1.63.0-202610191322.tar.gz';
  const archive = path.join(APP, 'verify', 'out', 'downloads-cache', name);
  const sha256 = 'b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4';
  if (!existsSync(archive)) {
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, Buffer.from(await (await fetch(`https://download.eclipse.org/jdtls/milestones/1.63.0/${name}`)).arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== sha256) throw new Error('JDT LS archive checksum');
  lspServer = http.createServer((q, r) => { r.writeHead(200, { 'content-length': statSync(archive).size }); createReadStream(archive).pipe(r); });
  await new Promise((r) => lspServer.listen(0, '127.0.0.1', r));
  const feed = path.join(work, 'toolchains.json');
  writeFileSync(feed, S({ jdtls: { url: `http://127.0.0.1:${lspServer.address().port}/${name}`, size: statSync(archive).size, sha256 } }));
  env.PYIDE_TOOLCHAINS = feed;
}

const t = await launch({ name: 'minecraft-live', port: 9792, projectDir: project, env });
const { js, until, check, sleep } = t;
const tab = (title) => `ide.run.sessions().find((s) => s.title === ${S(title)})`;
const tabText = (title) => js(`${tab(title)}?.host.textContent || ''`);
const elapsed = (t0) => `${Math.round((Date.now() - t0) / 1000)} s`;
const serverDir = (name) => path.join(project, 'servers', name);
const runServer = (name) => js(`ide.run.runConfig(ide.run.configs().find((c) => c.type === 'minecraft-server' && c.dir === 'servers/${name}'))`);
const ended = (name, ms) => until(`${tab(name)} && !${tab(name)}.running && !${tab(name)}.starting && /Process finished/.test(${tab(name)}.host.textContent)`, `${name} ended`, ms).catch(() => {});
const buildRun = async (title, cfg, done, ms) => {
  await js(`ide.run.runConfig(ide.run.addTemporary(${S(cfg)}))`);
  await until(`${done}.test(${tab(title)}?.host.textContent || '') || /Process finished with exit code [1-9]|Plugin built and copied|error: /.test(${tab(title)}?.host.textContent || '')`, title, ms).catch(() => {});
  return tabText(title);
};
try {
  await js(`(ide.settings.set('ports.confirmShare', false), ide.toolWindows.get('Minecraft').show(), true)`);
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
    await js(`ide.api.invoke('minecraft:newPlugin', { root: ide.root, name: 'HelloPlugin', pkg: 'com.example.hello', server: 'paper' }).then(() => ide.minecraft.refresh())`);
    const out = await buildRun('Build HelloPlugin', { type: 'minecraft-plugin', name: 'Build HelloPlugin', dir: 'plugins/HelloPlugin' }, '/Plugin built and copied/', 300000);
    check(/Plugin built and copied/.test(out), `the template plugin compiles against the real Paper 1.21.11${/Plugin built/.test(out) ? '' : `: ${out.slice(-3000)}`}`);
    const cp = readFileSync(path.join(project, 'plugins', 'HelloPlugin', '.classpath'), 'utf8');
    check(/paper-api-[^"]+\.jar/.test(cp), `the plugin's .classpath names the real Paper API (${(/paper-api-[^"/]+\.jar/.exec(cp) || ['none'])[0]})`);
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
    // The proxy runs for real: no EULA. It is wired to the Paper servers and loads a plugin built here.
    await js(`ide.api.invoke('minecraft:newPlugin', { root: ide.root, name: 'NetPlugin', pkg: 'com.example.net', server: 'proxy' }).then(() => ide.minecraft.refresh())`);
    await runServer('proxy');
    await until(`/Done \\(|Listening on/.test(${tab('proxy')}?.host.textContent || '')`, 'proxy up', 300000).catch(() => {});
    let out = await tabText('proxy');
    check(/Done \(|Listening on/.test(out) && /Players are sent on to: paper/.test(out), `the real Velocity proxy starts, sent on to the Paper servers${/Done \(/.test(out) ? '' : `: ${out.slice(-2500)}`}`);
    const toml = readFileSync(path.join(serverDir('proxy'), 'velocity.toml'), 'utf8');
    check(/^"paper" = "127\.0\.0\.1:257\d\d"$/m.test(toml) && existsSync(path.join(serverDir('paper'), 'config', 'paper-global.yml')), 'velocity.toml lists the Paper server, and Paper takes the forwarding secret');
    const build = await buildRun('Build NetPlugin', { type: 'minecraft-plugin', name: 'Build NetPlugin', dir: 'plugins/NetPlugin' }, '/Plugin built and copied/', 300000);
    check(/Plugin built and copied/.test(build), `a Velocity plugin compiles against the real Velocity${/Plugin built/.test(build) ? '' : `: ${build.slice(-3000)}`}`);
    await until(`/NetPlugin enabled/.test(${tab('proxy')}?.host.textContent || '') && ${tab('proxy')}.running`, 'plugin loaded', 300000).catch(() => {});
    out = await tabText('proxy');
    check(/NetPlugin enabled/.test(out), `the restarted proxy loads the plugin and runs its initialize handler${/NetPlugin enabled/.test(out) ? '' : `: ${out.slice(-3000)}`}`);
    await js(`${tab('proxy')}.stop()`);
    await ended('proxy', 60000);
    check(!(await js(`${tab('proxy')}.running`)) && !/killed/i.test(await tabText('proxy')), 'Stop ends the real proxy with its own command');
  }

  if (process.env.MC_LIVE_LSP === '1' && has('paper')) {
    const main = path.join(project, 'plugins', 'HelloPlugin', 'src', 'main', 'java', 'com', 'example', 'hello', 'HelloPlugin.java');
    await js(`ide.openFile(${S(main)})`);
    await until(`document.querySelector('#javaLspStatus')?.dataset.state === 'missing' || document.querySelector('#javaLspStatus')?.dataset.state === 'ready'`, 'java lsp state', 120000).catch(() => {});
    if (await js(`document.querySelector('#javaLspStatus')?.dataset.state === 'missing'`)) {
      await js(`ide.installer.run('toolchain:jdtls')`).catch(() => {});
    }
    await until(`document.querySelector('#javaLspStatus')?.dataset.state === 'ready'`, 'java lsp ready', 600000).catch(() => {});
    await sleep(20000);
    const errors = await js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).filter((m) => m.severity === ide.monaco.MarkerSeverity.Error).map((m) => m.startLineNumber + ': ' + m.message)`);
    check(!errors.length, `the editor knows the Paper API: no errors in the plugin (${S(errors).slice(0, 600)})`);
    const line = await js(`ide.editor.getModel().getLinesContent().findIndex((l) => l.includes('getLogger().info')) + 1`);
    await js(`(ide.editor.focus(), ide.editor.executeEdits('t', [{ range: new ide.monaco.Range(${line}, 1, ${line}, 1), text: '        getServer().getPluginM\\n' }]), ide.editor.setPosition({ lineNumber: ${line}, column: 31 }), ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
    await until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].some((n) => n.textContent.startsWith('getPluginManager'))`, 'completion', 60000).catch(() => {});
    const names = await js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].map((n) => n.textContent)`);
    check(names.some((n) => n.startsWith('getPluginManager')), `completion offers Paper's API (getServer().getPluginM… -> ${S(names.slice(0, 5))})`);
  }

  if (process.env.MC_LIVE_GRADLE === '1') {
    for (const [server, id] of [['forge', 'forge_tools'], ['fabric', 'fabric_tools']].filter(([k]) => has(k))) {
      const t2 = Date.now();
      const made = await js(`ide.minecraft.createMod({ id: ${S(id)}, display: 'Live Tools', pkg: ${S(`kr.live.${id}`)}, server: ${S(server)} }).then((r) => !!r)`);
      if (!made) { check(false, `${server} mod created: ${(await tabText('Minecraft: New Mod')).slice(-2000)}`); continue; }
      const out = await buildRun(`Deploy ${id}`, { type: 'minecraft-mod', name: `Deploy ${id}`, dir: `mods/${id}`, task: 'deploy' }, '/Mod copied to/', 2400000);
      const mods = existsSync(path.join(serverDir(server), 'mods')) ? readdirSync(path.join(serverDir(server), 'mods')) : [];
      check(/Mod copied to/.test(out) && mods.some((m) => m.includes(id.replace(/_/g, '')) || m.includes(id) || m.endsWith('.jar')),
        `the renamed ${server} mod builds with Gradle and is deployed in ${elapsed(t2)} (${S(mods)})${/Mod copied/.test(out) ? '' : `: ${out.slice(-3000)}`}`);
    }
    // A Gradle daemon outlives the build and inherits the window's debugging port, so the next run could not start.
    for (const id of ['forge_tools', 'fabric_tools']) {
      const dir = path.join(project, 'mods', id);
      if (existsSync(path.join(dir, 'gradlew.bat'))) spawnSync('cmd.exe', ['/d', '/c', '.\\gradlew.bat', '--stop'], { cwd: dir, stdio: 'ignore', timeout: 60000 });
    }
  }
} catch (err) {
  check(false, err.message);
}
await js(`ide.run.sessions().forEach((s) => s.running && s.stop())`).catch(() => {});
await sleep(3000);
lspServer?.close();
console.log(`work folder: ${work}`);
t.finish();
