// Minecraft servers, plugins and mods in a project (main/features/minecraft.js). The Minecraft tool window lists the
// project's servers (servers/<name>) with Start/Stop, Debug, Share (the Ports plugin's tunnel: bore for the game's TCP
// port), the plugin and mod projects that deploy to each, the resource pack it sends players, and the client pack of
// a modded server.
// - New Server: Paper, Purpur, Vanilla, Fabric, Forge or NeoForge, any Minecraft version their service offers, after
//   the user accepts the Minecraft EULA; or a Velocity proxy, which sends players on to the project's Paper and Purpur
//   servers. The Java version comes from Mojang's data and is downloaded when missing.
// - A server runs as a "Minecraft Server" run configuration: its console takes server commands (op, whitelist), and
//   Stop sends "stop" so the world is saved, killing the process only if it has not ended 30 s later. Debug runs it
//   with the JDWP agent and attaches PyIDE's Java debugger, with the sources of its plugins and mods.
// - New Plugin (Paper, Purpur, Velocity): a plugin project the Java language server understands (Eclipse project files
//   with the server's API), built with javac against the server's own libraries and copied into its plugins folder,
//   then the server restarts. Add Library adds another plugin's API from a Maven repository. Plugins run on the
//   server: players need nothing.
// - New Mod (Fabric, Forge, NeoForge): the official template renamed to the user's mod id, name and package, built
//   with its Gradle wrapper and the server's Java, the jar copied into the server's mods folder. Players need the same
//   mods: Client Pack makes a .mrpack that Prism Launcher or the Modrinth App imports in one step.
// - Resource Pack: a resourcepack/ folder for textures and sounds; Send to Players zips it, serves it with a public link
//   and names it in server.properties, so every player's game downloads it when they join.
// - Market (market.js): Modrinth's modpacks, mods, plugins and resource packs, installed into a server in one click.
// - The Minecraft screen (screen.js) shows the servers and the Market in an editor tab; project-types.js adds Minecraft
//   Mod, Plugin and Server to New Project.
(() => {
  const { el, basename, dirname } = ide.util;
  const run = ide.run;
  const MEMORY = ['1G', '2G', '4G', '6G', '8G'];
  const EULA = 'https://aka.ms/MinecraftEULA';
  const REPOS = () => [['papermc', 'PaperMC'], ['central', 'Maven Central'], ['jitpack', 'JitPack'], ['codemc', 'CodeMC']];
  let kinds = [];
  let list = [];
  const hosts = new Set(); // where the server list is shown: the tool window and the Minecraft screen

  // ---------- jobs: main's log lines go to the console of the job that asked ----------
  const jobs = new Map(); // job id -> console
  let jobSeq = 0;
  ide.api.on('minecraft:log', ({ job, text }) => jobs.get(job)?.append(text, 'sys'));
  function job(con) {
    const id = `mc-${Date.now()}-${++jobSeq}`;
    jobs.set(id, con);
    return { id, done: () => jobs.delete(id) };
  }
  const errorText = (err) => ide.util.errorText(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

  // ---------- run configuration types ----------
  const sessionOf = (dir) => run.sessions().find((s) => s.cfg?.type === 'minecraft-server' && run.resolvePath(s.cfg.dir).toLowerCase() === dir.toLowerCase()) || null;
  const runningAt = (dir) => !!sessionOf(dir)?.running;
  const serverAt = (dir) => list.find((s) => s.dir.toLowerCase() === dir.toLowerCase()) || null;

  // Windows keeps these names for devices: no folder can have one.
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  // Processes of servers asked to stop that have not ended yet (process id -> server folder, lower case): they still
  // hold their ports and worlds.
  const stopping = new Map();

  // Before a proxy starts, its [servers] and the Paper servers' forwarding follow the project; before any server
  // starts, the Ports window learns its port is the game's (TCP).
  async function beforeStart(dir, con) {
    const srv = serverAt(dir);
    if (srv?.proxy) {
      const { backends } = await ide.api.invoke('minecraft:wireProxy', ide.root, dir);
      con.append(`${backends.length ? tr('Players are sent on to: {servers}', { servers: backends.map((b) => `${b.name} (${b.port})`).join(', ') })
        : tr('No Paper or Purpur server in the project yet: the proxy has nowhere to send players.')}\n`, backends.length ? 'sys' : 'err');
    }
    const port = srv?.port || 25565;
    ide.ports?.hint(port, 'tcp');
    // A server still stopping (Rerun of a running one) holds its world and port until it has saved, 30 s at most; a
    // port that another program holds does not come free, so the start ends here instead of failing to bind it.
    const free = () => ide.api.invoke('minecraft:portFree', port);
    const saving = () => [...stopping.values()].includes(dir.toLowerCase());
    if (srv && (saving() || !(await free()))) {
      con.append(`${tr('Waiting for port {port} to be free…', { port })}\n`, 'sys');
      for (let i = 0; i < 80 && (stopping.size || i < 6) && (saving() || !(await free())); i++) await new Promise((r) => setTimeout(r, 500));
      if (!(await free())) throw new Error(tr('Port {port} is in use by another program: stop it, or change server-port in server.properties.', { port }));
    }
  }
  // Stop asks the server to save and quit ("end" for a Velocity proxy); the process is killed only if it is still
  // there 30 s later. By its id: a Rerun has moved the session on to the next process by then.
  function gracefulStop(s, dir) {
    s.kill = (pid) => {
      if (stopping.has(pid)) return;
      stopping.set(pid, dir.toLowerCase());
      ide.proc.input(pid, serverAt(dir)?.proxy ? 'end\n' : 'stop\n');
      setTimeout(() => { if (stopping.has(pid)) ide.proc.kill(pid); }, 30000);
    };
  }
  // A server's exit (its first start unpacks the API its plugins compile against) brings the plugins' classpath and
  // the window up to date.
  const afterExit = (dir) => { ide.api.invoke('minecraft:syncPlugins', ide.root, dir).catch(() => {}); refresh(); };

  run.registerType({
    type: 'minecraft-server', title: tr('Minecraft Server'), icon: '⛏', needsInterp: false,
    fields: [{ key: 'dir', label: tr('Server folder'), placeholder: 'servers/survival' }],
    defaults: () => ({ dir: '' }),
    identity: (c) => run.resolvePath(c.dir).toLowerCase(),
    file: () => null,
    async start(cfg, s) {
      const dir = run.resolvePath(cfg.dir);
      const con = s.console({ input: true, placeholder: tr('Server command (op <player>, whitelist add <player>, stop…)') });
      const j = job(con);
      try {
        const spec = await ide.api.invoke('minecraft:launch', ide.root, dir, j.id);
        await beforeStart(dir, con);
        con.append(`${[spec.cmd, ...spec.args].map(quote).join(' ')}\n`, 'sys');
        const id = await ide.api.invoke('minecraft:start', ide.root, spec);
        gracefulStop(s, dir);
        s.attach(id, { onExit: () => { stopping.delete(id); afterExit(dir); } });
        render();
        ide.api.invoke('ports:refresh').catch(() => {});
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
      } finally { j.done(); }
    },
    // Debug: the server with the JDWP agent (suspended until the breakpoints are set), PyIDE's Java debugger attached,
    // and the server's plugin and mod sources for its breakpoints.
    debug(cfg) {
      const dir = run.resolvePath(cfg.dir);
      return ide.debugger.debugJvm({
        rerun: () => run.debugConfig(cfg),
        async launch({ con, port }) {
          const j = job(con);
          try {
            const spec = await ide.api.invoke('minecraft:launch', ide.root, dir, j.id, { debugPort: port });
            await beforeStart(dir, con);
            con.append(`${[spec.cmd, ...spec.args].map(quote).join(' ')}\n`, 'sys');
            const procId = await ide.api.invoke('minecraft:start', ide.root, spec);
            return { procId, sourceRoots: await ide.api.invoke('minecraft:sourceRoots', ide.root, dir) };
          } catch (err) {
            con.append(`${errorText(err)}\n`, 'err');
            return null;
          } finally { j.done(); }
        },
      });
    },
  });

  run.registerType({
    type: 'minecraft-plugin', title: tr('Minecraft Plugin'), icon: '🧩', needsInterp: false,
    fields: [{ key: 'dir', label: tr('Plugin folder'), placeholder: 'plugins/MyPlugin' }],
    defaults: () => ({ dir: '' }),
    identity: (c) => run.resolvePath(c.dir).toLowerCase(),
    file: () => null,
    async start(cfg, s) {
      const con = s.console();
      const j = job(con);
      try {
        const r = await ide.api.invoke('minecraft:buildPlugin', ide.root, run.resolvePath(cfg.dir), j.id);
        con.append(`${tr('Plugin built and copied to {path}', { path: r.deployed })}\n`, 'ok');
        await restartIfRunning(r.server, con);
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
      } finally { j.done(); }
      s.setIcon('🧩', 'done');
    },
  });

  const MOD_TASKS = () => [['deploy', tr('Build and deploy to the server')], ['runClient', tr('Run a test client (runClient)')], ['build', tr('Build only')]];
  run.registerType({
    type: 'minecraft-mod', title: tr('Minecraft Mod'), icon: '⚙', needsInterp: false,
    fields: [
      { key: 'dir', label: tr('Mod folder'), placeholder: 'mods/mymod' },
      { key: 'task', label: tr('Task'), kind: 'select', options: MOD_TASKS },
    ],
    defaults: () => ({ dir: '', task: 'deploy' }),
    identity: (c) => `${run.resolvePath(c.dir).toLowerCase()}|${c.task}`,
    file: () => null,
    // Debug of the test client: the game waits for PyIDE's Java debugger, breakpoints in the mod stop it, and a saved
    // .java file of the mod is compiled and swapped into the running game (HotSwap). Other tasks just run.
    debug(cfg) {
      if (cfg.task !== 'runClient') return run.runConfig(cfg);
      const dir = run.resolvePath(cfg.dir);
      let mine = null; // this session's HotSwap target: a second session of the same mod has its own
      return ide.debugger.debugJvm({
        rerun: () => run.debugConfig(cfg),
        async launch({ con, port }) {
          const j = job(con);
          try {
            const spec = await ide.api.invoke('minecraft:modTask', ide.root, dir, 'runClient', j.id, { debugPort: port });
            con.append(`gradlew runClient (${tr('debug port {port}', { port })})\n`, 'sys');
            const procId = await ide.api.invoke('minecraft:start', ide.root, spec);
            hotswap = mine = { dir, con };
            // Gradle prepares Minecraft before the game starts: the first time, many minutes.
            return { procId, sourceRoots: ['src\\main\\java', 'src\\client\\java'].map((r) => `${dir}\\${r}`), timeoutMs: 30 * 60000 };
          } catch (err) {
            con.append(`${errorText(err)}\n`, 'err');
            return null;
          } finally { j.done(); }
        },
      }).then((handle) => { handle?.ended?.then(() => { if (hotswap === mine) hotswap = null; }); return handle; });
    },
    async start(cfg, s) {
      const con = s.console({ input: true });
      const j = job(con);
      const dir = run.resolvePath(cfg.dir);
      try {
        const spec = await ide.api.invoke('minecraft:modTask', ide.root, dir, cfg.task === 'deploy' ? 'build' : cfg.task, j.id);
        con.append(`gradlew ${spec.args.slice(-1)[0]}\n`, 'sys');
        const id = await ide.api.invoke('minecraft:start', ide.root, spec);
        s.attach(id, {
          onExit: async (code) => {
            if (code !== 0 || cfg.task !== 'deploy') return;
            try {
              const r = await ide.api.invoke('minecraft:deployMod', ide.root, dir);
              con.append(`${tr('Mod copied to {path}', { path: r.deployed })}\n`, 'ok');
              await restartIfRunning(r.server, con);
              render();
            } catch (err) { con.append(`${errorText(err)}\n`, 'err'); }
          },
        });
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
      } finally { j.done(); }
    },
  });

  // ---------- HotSwap ----------
  // While the test client runs under Debug, saving a .java file of its mod compiles it and redefines its classes in
  // the game. The JVM swaps method bodies only: a new method or field, or a changed signature, needs a restart.
  let hotswap = null; // {dir, con} of the mod whose client is being debugged
  let pending = new Set();
  let swapping = null;
  let timer = 0;
  ide.on('fileSaved', (tab) => {
    const p = tab?.path;
    if (!hotswap || !p || !/\.java$/i.test(p) || !p.toLowerCase().startsWith(`${hotswap.dir.toLowerCase()}\\`)) return;
    pending.add(p);
    clearTimeout(timer);
    timer = setTimeout(swap, 300);
  });
  async function swap() {
    if (swapping) { await swapping; return swap(); }
    const files = [...pending];
    pending = new Set();
    if (!files.length || !hotswap) return;
    const { dir, con } = hotswap;
    swapping = (async () => {
      const j = job(con);
      const started = Date.now();
      try {
        con.append(`${tr('HotSwap: compiling {files}…', { files: files.map((f) => basename(f)).join(', ') })}\n`, 'sys');
        const classes = await ide.api.invoke('minecraft:hotswapCompile', ide.root, dir, files, j.id);
        const r = await ide.debugger.jvmRequest('redefineClasses', { classes });
        con.append(`${tr('HotSwap: {count} classes reloaded in the game ({ms} ms)', { count: r.redefined.length, ms: Date.now() - started })}${r.redefined.length ? `: ${r.redefined.join(', ')}` : ''}\n`, 'ok');
      } catch (err) {
        const text = errorText(err);
        con.append(`${/JDWP error (6\d|7\d)/.test(text) ? tr('HotSwap: the game cannot take this change without a restart ({reason}). Stop and debug the test client again.', { reason: text.replace(/^.*\(([^)]*)\)\s*$/, '$1') })
          : tr('HotSwap failed: {error}', { error: text })}\n`, 'err');
      } finally { j.done(); }
    })();
    await swapping;
    swapping = null;
  }

  // The old process saves its world and frees the port before the new one starts (a Minecraft server takes some
  // seconds to stop).
  async function restartIfRunning(serverDir, con) {
    const s = sessionOf(serverDir);
    if (!s?.running) return;
    con.append(`${tr('Restarting the server to load it…')}\n`, 'sys');
    const ended = new Promise((resolve) => { s.exitHooks.push(resolve); setTimeout(resolve, 35000); });
    s.stop();
    await ended;
    await run.runConfig(s.cfg, { confirm: false, remember: false });
  }

  // A saved configuration (made once per target), leaving the run widget's selection as it was.
  function config(type, name, fields) {
    const previous = run.selected()?.id;
    const key = run.types.get(type).identity({ ...run.types.get(type).defaults(), ...fields });
    let cfg = run.configs().find((c) => c.type === type && run.types.get(type).identity(c) === key);
    if (!cfg) {
      cfg = run.addTemporary({ type, name, ...fields });
      cfg.temporary = false;
    }
    run.select(previous);
    return cfg;
  }
  const rel = (p) => ide.util.rel(p).replace(/\\/g, '/');
  const serverConfig = (srv) => config('minecraft-server', srv.name, { dir: rel(srv.dir) });
  const buildConfig = (p) => (p.type === 'plugin'
    ? config('minecraft-plugin', tr('Build {name}', { name: p.name }), { dir: rel(p.dir) })
    : config('minecraft-mod', tr('Deploy {name}', { name: p.name }), { dir: rel(p.dir), task: 'deploy' }));
  const clientConfig = (p) => config('minecraft-mod', tr('Test client {name}', { name: p.name }), { dir: rel(p.dir), task: 'runClient' });

  // ---------- dialogs ----------
  function form(rows) {
    const body = el('div', 'mc-dialog');
    for (const [label, control] of rows) {
      if (!label) { body.append(control); continue; }
      const r = el('label', 'mc-dialog-row');
      r.append(el('span', 'mc-dialog-label', label), control);
      body.append(r);
    }
    const error = el('div', 'mc-dialog-error');
    body.append(error);
    return { body, error };
  }
  const input = (id, value = '', placeholder = '') => { const i = el('input', 'input'); i.id = id; i.value = value; i.placeholder = placeholder; return i; };
  const select = (id, options, value) => {
    const s = el('select', 'input');
    s.id = id;
    for (const [v, label] of options) s.add(new Option(label, v));
    if (value != null) s.value = value;
    return s;
  };
  const note = (text) => el('div', 'mc-dialog-note muted', text);
  // Runs a job in its own Run tab ("Minecraft: <title>") so its download and installer output stay visible.
  function jobSession(title) {
    const s = run.outputSession(`minecraft:${title}`, `Minecraft: ${title}`);
    s.host.replaceChildren();
    const con = s.console();
    run.show(s);
    return con;
  }
  const trusted = () => (ide.trusted === false ? (ide.ui.alert(tr('The project is open in Safe Mode, where PyIDE runs nothing from it.')), false) : true);
  const kindTitle = (k) => kinds.find((x) => x.id === k)?.title || k;

  async function newServer() {
    if (!ide.root || !trusted()) return;
    kinds = kinds.length ? kinds : await ide.api.invoke('minecraft:kinds');
    const kind = select('mcKind', kinds.map((k) => [k.id, k.title]), 'paper');
    const version = select('mcVersion', []);
    const name = input('mcName', 'survival');
    const memory = select('mcMemory', MEMORY.map((m) => [m, m]), '2G');
    const port = input('mcPort', '25565');
    const eula = el('input');
    eula.type = 'checkbox';
    eula.id = 'mcEula';
    const eulaRow = el('label', 'mc-dialog-check');
    const link = el('a', null, tr('Minecraft EULA'));
    link.href = '#';
    link.onclick = (e) => { e.preventDefault(); ide.api.invoke('shell:openExternal', EULA); };
    eulaRow.append(eula, document.createTextNode(` ${tr('I agree to the')} `), link);
    const hint = note('');
    const proxy = () => !!kinds.find((x) => x.id === kind.value)?.proxy;
    const describe = () => {
      const k = kinds.find((x) => x.id === kind.value);
      hint.textContent = k?.proxy ? tr('A proxy: players join it and it sends them on to the project\'s Paper and Purpur servers. The versions are Velocity\'s own.')
        : k?.plugins ? tr('Runs plugins. Players join with plain Minecraft and need nothing else.')
          : k?.mods ? tr('Players need the same mods: Client Pack makes a pack they import once into Prism Launcher or the Modrinth App.')
            : tr('Vanilla runs no plugins or mods.');
      eulaRow.classList.toggle('hidden', !!k?.proxy);
      if (k?.proxy && name.value === 'survival') { name.value = 'proxy'; port.value = '25577'; }
    };
    const loadVersions = async () => {
      version.replaceChildren(new Option(tr('Loading…'), ''));
      version.disabled = true;
      try {
        const vs = await ide.api.invoke('minecraft:versions', kind.value);
        version.replaceChildren(...vs.map((v) => new Option(v, v)));
      } catch (err) {
        version.replaceChildren(new Option(tr('Could not load the versions'), ''));
        f.error.textContent = errorText(err);
      }
      version.disabled = false;
    };
    kind.onchange = () => { describe(); loadVersions(); };
    const f = form([[tr('Type:'), kind], [tr('Version:'), version], [tr('Name:'), name], [tr('Memory:'), memory], [tr('Port:'), port], [null, hint], [null, eulaRow]]);
    describe();
    loadVersions();
    ide.ui.dialog({
      title: tr('New Minecraft Server'), body: f.body, width: 520,
      buttons: [
        { label: tr('Create'), primary: true, run: () => {
          if (!version.value) { f.error.textContent = tr('Choose a version.'); return false; }
          if (!proxy() && !eula.checked) { f.error.textContent = tr('A Minecraft server runs only after you accept the Minecraft EULA.'); return false; }
          // What main refuses, said while the dialog still holds what was typed.
          const n = name.value.trim();
          const p = Number(port.value.trim() || 25565);
          const why = !/^[A-Za-z][\w-]{0,39}$/.test(n) ? tr('Use letters, digits, - and _ for the name, starting with a letter (40 at most).')
            : RESERVED.test(n) ? tr('{name} is a name Windows keeps for a device: choose another.', { name: n })
              : list.some((s) => s.name.toLowerCase() === n.toLowerCase()) ? tr('A server named {name} already exists.', { name: n })
                : !Number.isInteger(p) || p < 1 || p > 65535 ? tr('Use a port from 1 to 65535.') : '';
          if (why) { f.error.textContent = why; return false; }
          createServer({ name: n, kind: kind.value, mc: version.value, memory: memory.value, port: p });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function createServer(opts) {
    const con = jobSession(tr('New Server'));
    const j = job(con);
    try {
      const srv = await ide.api.invoke('minecraft:create', { ...opts, root: ide.root, eula: true }, j.id);
      con.append(`${tr('Server {name} is ready.', { name: srv.name })}\n`, 'ok');
      const cfg = serverConfig(srv);
      ide.refreshTree?.();
      await refresh();
      ide.notifications?.notify({
        title: tr('Minecraft server {name} created', { name: srv.name }), text: `${kindTitle(srv.kind)} ${srv.mc}`, kind: 'ok', group: 'Minecraft', raw: true,
        actions: [{ label: tr('Start'), run: () => run.runConfig(cfg) }],
      });
      return srv;
    } catch (err) {
      con.append(`${errorText(err)}\n`, 'err');
      return null;
    } finally { j.done(); }
  }

  async function newPlugin(server) {
    if (!ide.root || !trusted()) return;
    const hosts = list.filter((s) => s.plugins);
    if (!hosts.length) return ide.ui.alert(tr('Create a Paper, Purpur or Velocity server first: plugins run on them.'));
    const srv = select('mcPluginServer', hosts.map((s) => [s.name, `${s.name} (${kindTitle(s.kind)} ${s.mc})`]), server?.name);
    const name = input('mcPluginName', 'MyPlugin');
    const pkg = input('mcPluginPkg', 'com.example.myplugin');
    const f = form([[tr('Server:'), srv], [tr('Name:'), name], [tr('Package:'), pkg]]);
    ide.ui.dialog({
      title: tr('New Plugin'), body: f.body, width: 480,
      buttons: [
        { label: tr('Create'), primary: true, run: async () => {
          try {
            await createPlugin({ name: name.value.trim(), pkg: pkg.value.trim(), server: srv.value });
            return true;
          } catch (err) { f.error.textContent = errorText(err); return false; }
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function createPlugin(opts) {
    const r = await ide.api.invoke('minecraft:newPlugin', { root: ide.root, ...opts });
    config('minecraft-plugin', tr('Build {name}', { name: opts.name }), { dir: rel(r.dir) });
    ide.refreshTree?.();
    await ide.openFile(r.main);
    await refresh();
    return r;
  }

  // Another plugin's API (LuckPerms, Vault…) from a Maven repository, for the plugin to compile against.
  function addLibrary(project) {
    if (!trusted()) return;
    const coords = input('mcLibCoords', '', 'net.luckperms:api:5.4');
    const repo = select('mcLibRepo', [...REPOS(), ['custom', tr('Other (address below)')]], 'central');
    const url = input('mcLibUrl', '', 'https://repo.example.com/maven');
    const depend = input('mcLibDepend', '', 'LuckPerms');
    const f = form([[tr('Library:'), coords], [tr('Repository:'), repo], [tr('Address:'), url], [tr('Requires plugin:'), depend],
      [null, note(tr('The jar goes to libs/ and is compiled against, not packed: the plugin that provides it must be on the server. Requires plugin adds it to depend, so the server loads it first.'))]]);
    ide.ui.dialog({
      title: tr('Add Library to {name}', { name: project.name }), body: f.body, width: 560,
      buttons: [
        { label: tr('Add'), primary: true, run: async () => {
          const con = jobSession(tr('Add Library'));
          const j = job(con);
          try {
            const r = await ide.api.invoke('minecraft:addDependency', ide.root, { dir: project.dir, coords: coords.value, repo: repo.value === 'custom' ? url.value.trim() : repo.value, depend: depend.value.trim() || null }, j.id);
            con.append(`${tr('Added {file}', { file: r.file })}\n`, 'ok');
            ide.refreshTree?.();
            return true;
          } catch (err) {
            f.error.textContent = errorText(err);
            return false;
          } finally { j.done(); }
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function newMod(server) {
    if (!ide.root || !trusted()) return;
    const modded = list.filter((s) => s.mods && s.mdk);
    if (!modded.length) return ide.ui.alert(tr('Create a Fabric, Forge or NeoForge server first: a mod is built for its version.'));
    const srv = select('mcModServer', modded.map((s) => [s.name, `${s.name} (${kindTitle(s.kind)} ${s.mc})`]), server?.name);
    const id = input('mcModId', 'mymod');
    const display = input('mcModName', 'My Mod');
    const pkg = input('mcModPkg', 'com.example.mymod');
    id.oninput = () => { if (/^com\.example\./.test(pkg.value)) pkg.value = `com.example.${id.value.replace(/[^a-z0-9_]/g, '')}`; };
    const f = form([[tr('Server:'), srv], [tr('Mod id:'), id], [tr('Name:'), display], [tr('Package:'), pkg],
      [null, note(tr('The official template is downloaded and renamed; its first Gradle build downloads Minecraft and takes several minutes.'))]]);
    ide.ui.dialog({
      title: tr('New Mod'), body: f.body, width: 480,
      buttons: [
        { label: tr('Create'), primary: true, run: () => {
          if (!/^[a-z][a-z0-9_]{1,63}$/.test(id.value.trim())) { f.error.textContent = tr('Use a mod id of lower-case letters, digits and _, starting with a letter.'); return false; }
          if (RESERVED.test(id.value.trim())) { f.error.textContent = tr('{name} is a name Windows keeps for a device: choose another.', { name: id.value.trim() }); return false; }
          if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(pkg.value.trim())) { f.error.textContent = tr('Use a Java package such as com.example.mymod.'); return false; }
          createMod({ id: id.value.trim(), display: display.value.trim(), pkg: pkg.value.trim(), server: srv.value });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function createMod(opts) {
    const con = jobSession(tr('New Mod'));
    const j = job(con);
    try {
      const r = await ide.api.invoke('minecraft:newMod', { root: ide.root, ...opts }, j.id);
      config('minecraft-mod', tr('Deploy {name}', { name: opts.id }), { dir: rel(r.dir), task: 'deploy' });
      config('minecraft-mod', tr('Test client {name}', { name: opts.id }), { dir: rel(r.dir), task: 'runClient' });
      ide.refreshTree?.();
      if (r.main) await ide.openFile(r.main);
      await refresh();
      return r;
    } catch (err) {
      con.append(`${errorText(err)}\n`, 'err');
      return null;
    } finally { j.done(); }
  }

  // ---------- sharing files (client pack, resource pack) ----------
  // A server's client-pack/ folder is served with the project's Python (http.server on loopback) and that port shared,
  // which the Ports plugin gives a public https address; one server per folder, reused while it runs.
  const serving = new Map(); // folder (lower case) -> Promise<base url | null>
  const tunnelWaits = new Map(); // port -> resolve(url | null)
  ide.api.on('ports:changed', (st) => {
    for (const [port, resolve] of tunnelWaits) {
      const t = st.tunnels.find((x) => x.port === port);
      if (t?.state === 'shared' || t?.state === 'failed') { tunnelWaits.delete(port); resolve(t.state === 'shared' ? t.url : null); }
    }
  });
  function serveFolder(folder) {
    const key = folder.toLowerCase();
    const known = serving.get(key);
    if (known) return known;
    const job = (async () => {
      const interp = ide.currentInterp();
      if (!interp) { ide.ui.alert(tr('No Python interpreter found.')); return null; }
      const port = 18700 + Math.floor(Math.random() * 200);
      const s = run.outputSession(`minecraft:serve:${key}`, tr('Files for players'));
      s.host.replaceChildren();
      s.console();
      const id = await ide.api.invoke('minecraft:start', ide.root, { cmd: interp.cmd, args: [...interp.args, '-m', 'http.server', String(port), '--bind', '127.0.0.1'], cwd: folder });
      s.attach(id, { onExit: () => serving.delete(key) });
      return new Promise((resolve) => {
        tunnelWaits.set(port, resolve);
        const tryShare = async (left) => {
          await ide.api.invoke('ports:refresh');
          if (ide.ports.state().ports.some((p) => p.port === port)) ide.ports.share(port);
          else if (left) setTimeout(() => tryShare(left - 1), 500);
          else { tunnelWaits.delete(port); resolve(null); }
        };
        tryShare(20);
      });
    })();
    serving.set(key, job);
    job.then((url) => { if (!url) serving.delete(key); });
    return job;
  }

  async function clientPack(srv) {
    if (!trusted()) return;
    try {
      const r = await ide.api.invoke('minecraft:clientPack', ide.root, srv.dir);
      ide.refreshTree?.();
      ide.notifications?.notify({
        title: tr('Client pack for {name}', { name: srv.name }),
        text: r.modpack ? tr('The modpack {name} (Minecraft {mc}, {loader}). Players import it once in Prism Launcher or the Modrinth App (Add Instance › Import).', { name: r.modpack, mc: r.mc, loader: r.loader })
          : tr('{count} mods, Minecraft {mc}, {loader}. Players import it once in Prism Launcher or the Modrinth App (Add Instance › Import).', { count: r.mods.length, mc: r.mc, loader: r.loader }),
        kind: 'ok', group: 'Minecraft', raw: true,
        actions: [
          { label: tr('Show in Explorer'), run: () => ide.api.invoke('shell:showInFolder', r.file) },
          ...(ide.ports ? [{ label: tr('Share Link'), run: (n) => { n.expire(); sharePack(r.file); } }] : []),
        ],
      });
    } catch (err) { ide.ui.alert(errorText(err)); }
  }
  async function sharePack(file) {
    const base = await serveFolder(dirname(file));
    if (!base) return ide.ui.alert(tr('The link could not be made; see the Ports window.'));
    const link = `${base}/${encodeURIComponent(basename(file))}`;
    ide.notifications?.notify({
      title: tr('Client pack link ready'), text: link, kind: 'ok', group: 'Minecraft', raw: true,
      actions: [{ label: tr('Copy Link'), run: () => ide.api.invoke('clipboard:writeText', link) }],
    });
  }

  async function resourcePack(srv) {
    if (!trusted()) return;
    try {
      const r = await ide.api.invoke('minecraft:newResourcePack', ide.root, srv.dir);
      ide.refreshTree?.();
      await ide.revealInTree?.(r.folder);
      if (r.created) {
        ide.notifications?.notify({
          title: tr('Resource pack folder created'), text: tr('Put textures, sounds and models under resourcepack/assets/minecraft, then Send to Players.'), kind: 'ok', group: 'Minecraft',
        });
      }
      await refresh();
    } catch (err) { ide.ui.alert(errorText(err)); }
  }
  // Zips the pack, serves it with a public link, names it in server.properties (with its SHA-1, required) and restarts
  // the server, so every player's game downloads it when they join. The link lasts while PyIDE shares it.
  async function sendPack(srv) {
    if (!trusted()) return;
    const con = jobSession(tr('Resource Pack'));
    try {
      const pack = await ide.api.invoke('minecraft:packResourcePack', ide.root, srv.dir);
      con.append(`${tr('Packed {count} files into {file}', { count: pack.files, file: pack.file })}\n`, 'sys');
      const base = await serveFolder(dirname(pack.file));
      if (!base) return con.append(`${tr('The link could not be made; see the Ports window.')}\n`, 'err');
      const url = `${base}/resourcepack.zip`;
      await ide.api.invoke('minecraft:applyResourcePack', ide.root, srv.dir, url, pack.sha1);
      con.append(`${tr('server.properties now sends players {url}', { url })}\n`, 'ok');
      await restartIfRunning(srv.dir, con);
    } catch (err) { con.append(`${errorText(err)}\n`, 'err'); }
  }

  // ---------- modpacks ----------
  // A server from a modpack: a .mrpack file (picked or dropped) or a Modrinth address. Its contents are shown before
  // anything is created, and the EULA is asked as for New Server.
  async function newFromModpack(file) {
    if (!ide.root || !trusted()) return;
    const source = input('mcPackSource', file || '', tr('A .mrpack file, or a Modrinth modpack address'));
    const browse = button(tr('Browse…'), 'mc-pack-browse', async () => {
      const picked = await ide.api.invoke('dialog:openFile', [{ name: 'Modrinth modpack', extensions: ['mrpack'] }]).catch(() => null);
      if (picked) { source.value = picked; load(); }
    });
    const sourceRow = el('div', 'mc-dialog-icon');
    sourceRow.append(source, browse);
    const details = note('');
    details.id = 'mcPackInfo';
    const name = input('mcPackName', '');
    const memory = select('mcPackMemory', MEMORY.map((m) => [m, m]), '4G');
    const port = input('mcPackPort', '25565');
    const eula = el('input');
    eula.type = 'checkbox';
    eula.id = 'mcPackEula';
    const eulaRow = el('label', 'mc-dialog-check');
    const link = el('a', null, tr('Minecraft EULA'));
    link.href = '#';
    link.onclick = (e) => { e.preventDefault(); ide.api.invoke('shell:openExternal', EULA); };
    eulaRow.append(eula, document.createTextNode(` ${tr('I agree to the')} `), link);
    const f = form([[tr('Modpack:'), sourceRow], [null, details], [tr('Name:'), name], [tr('Memory:'), memory], [tr('Port:'), port], [null, eulaRow]]);
    let info = null;
    async function load() {
      const value = source.value.trim();
      if (info) ide.api.invoke('minecraft:discardModpack', info.file).catch(() => {});
      info = null;
      f.error.textContent = '';
      if (!value) return;
      details.textContent = tr('Reading the modpack…');
      const con = /^[a-z]:[\\/]|\.mrpack$/i.test(value) ? null : jobSession(tr('Modpack'));
      const j = con ? job(con) : null;
      try {
        info = await ide.api.invoke('minecraft:modpackInfo', ide.root, /^[a-z]:[\\/]|\.mrpack$/i.test(value) ? { file: value } : { url: value }, j?.id);
        details.textContent = tr('{name} {version}: Minecraft {mc}, {loader} {loaderVersion}. {count} files for the server{client}.', {
          name: info.name, version: info.version, mc: info.mc, loader: kindTitle(info.kind), loaderVersion: info.loader, count: info.serverFiles,
          client: info.clientOnly ? tr(' ({count} client-only files stay in the players\' pack)', { count: info.clientOnly }) : '' });
        if (!name.value) name.value = info.name.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32) || 'modpack';
      } catch (err) {
        details.textContent = '';
        f.error.textContent = errorText(err);
      } finally { j?.done(); }
    }
    source.onchange = load;
    // A modpack downloaded for this dialog is not kept when no server is made from it.
    let created = false;
    ide.ui.dialog({
      title: tr('New Server from Modpack'), body: f.body, width: 560,
      onClose: () => { if (!created && info) ide.api.invoke('minecraft:discardModpack', info.file).catch(() => {}); },
      buttons: [
        { label: tr('Create'), primary: true, run: () => {
          if (!info) { f.error.textContent = tr('Choose a modpack first.'); return false; }
          if (!eula.checked) { f.error.textContent = tr('A Minecraft server runs only after you accept the Minecraft EULA.'); return false; }
          created = true;
          createFromModpack({ file: info.file, name: name.value.trim(), memory: memory.value, port: Number(port.value) || 25565 });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
    if (file) load();
  }
  async function createFromModpack(opts) {
    const con = jobSession(tr('New Server'));
    const j = job(con);
    try {
      const srv = await ide.api.invoke('minecraft:createFromModpack', { ...opts, root: ide.root, eula: true }, j.id);
      con.append(`${tr('Server {name} is ready.', { name: srv.name })}\n`, 'ok');
      const cfg = serverConfig(srv);
      ide.refreshTree?.();
      await refresh();
      ide.notifications?.notify({
        title: tr('Minecraft server {name} created', { name: srv.name }), text: `${srv.modpack?.name || ''} · ${kindTitle(srv.kind)} ${srv.mc}`, kind: 'ok', group: 'Minecraft', raw: true,
        actions: [{ label: tr('Start'), run: () => run.runConfig(cfg) }],
      });
      return srv;
    } catch (err) {
      con.append(`${errorText(err)}\n`, 'err');
      return null;
    } finally { j.done(); }
  }

  // ---------- drag and drop ----------
  // Dropped on a server's card: its plugins, mods, resource pack or world. Dropped on the window: server folders are
  // imported, modpacks open New Server from Modpack, and the rest goes to the one server it fits.
  const SKIPPED = {
    'plugin:paper': () => tr('a Paper plugin: drop it on a Paper or Purpur server'),
    'plugin:velocity': () => tr('a Velocity plugin: drop it on a Velocity proxy'),
    'mod:fabric-loader': () => tr('a Fabric mod: drop it on a Fabric server'),
    'mod:forge': () => tr('a Forge mod: drop it on a Forge or NeoForge server'),
    'mod:neoforge': () => tr('a NeoForge mod: drop it on a NeoForge server'),
    target: () => tr('drop it on the server it is for'),
    curseforge: () => tr('a CurseForge modpack, whose mods only CurseForge\'s own service hands out: download its Server Pack from CurseForge and drop that folder here'),
    unknown: () => tr('not a server, world, resource pack, plugin, mod or modpack'),
  };
  const WHAT = { server: () => tr('server imported'), plugin: () => tr('plugin added'), mod: () => tr('mod added'), resourcepack: () => tr('resource pack added'), world: () => tr('world added (level-name)') };
  async function dropped(paths, serverDir) {
    if (!paths.length || !trusted()) return;
    const con = jobSession(tr('Import'));
    const j = job(con);
    try {
      const r = await ide.api.invoke('minecraft:drop', ide.root, serverDir, paths, j.id);
      for (const d of r.done) con.append(`${d.name}: ${WHAT[d.what]()}${d.server ? ` → ${d.server}` : ''}\n`, 'ok');
      for (const s of r.skipped) con.append(`${s.name}: ${s.message || SKIPPED[s.why]?.() || s.why}\n`, 'err');
      for (const d of r.done.filter((x) => x.what === 'server')) serverConfig({ name: basename(d.to), dir: d.to });
      if (r.done.some((d) => (d.what === 'plugin' || d.what === 'mod') && runningAt(list.find((s) => s.name === d.server)?.dir || ''))) {
        con.append(`${tr('Restart the server to load what was added.')}\n`, 'sys');
      }
      ide.refreshTree?.();
      await refresh();
      if (r.modpacks.length) newFromModpack(r.modpacks[0]);
    } catch (err) {
      con.append(`${errorText(err)}\n`, 'err');
    } finally { j.done(); }
  }
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  function acceptDrops(container) {
    let marked = null;
    const mark = (n) => { if (marked !== n) { marked?.classList.remove('mc-drop'); marked = n; n?.classList.add('mc-drop'); } };
    container.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      mark(e.target.closest?.('.mc-server') || container);
    });
    container.addEventListener('dragleave', (e) => { if (!container.contains(e.relatedTarget)) mark(null); });
    container.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const card = e.target.closest?.('.mc-server');
      mark(null);
      dropped([...e.dataTransfer.files].map((f) => ide.api.pathForFile(f)).filter(Boolean), card?.dataset.dir || null);
    });
  }

  // ---------- tool window ----------
  async function refresh() {
    if (!ide.root) { list = []; render(); return; }
    kinds = kinds.length ? kinds : await ide.api.invoke('minecraft:kinds').catch(() => []);
    list = await ide.api.invoke('minecraft:servers', ide.root).catch(() => []);
    render();
  }
  function button(label, cls, onClick, title) {
    const b = el('button', `secondary ${cls}`, label);
    if (title) b.title = title;
    b.onclick = (e) => { e.preventDefault(); onClick(); };
    return b;
  }

  function render() {
    for (const host of hosts) renderInto(host);
  }
  // Start or Debug clicked again before the server runs (its card shows Stop only then) starts it once.
  const launching = new Set(); // server folders (lower case)
  function launchOnce(srv, how) {
    const key = srv.dir.toLowerCase();
    if (launching.has(key) || runningAt(srv.dir)) return;
    launching.add(key);
    Promise.resolve(how(serverConfig(srv))).catch(() => {}).finally(() => { launching.delete(key); render(); });
  }
  function renderInto(host) {
    host.replaceChildren();
    const bar = el('div', 'mc-bar');
    bar.append(button(tr('New Server…'), 'mc-new', newServer), button(tr('From Modpack…'), 'mc-new-pack', () => newFromModpack(), tr('A server from a Modrinth modpack (.mrpack)')),
      button(tr('Market'), 'mc-market', () => ide.minecraft.market.open(), tr('Modpacks, mods, plugins and resource packs from Modrinth')),
      button(tr('New Plugin…'), 'mc-new-plugin', () => newPlugin()),
      button(tr('New Mod…'), 'mc-new-mod', () => newMod()), button(tr('Refresh'), 'mc-refresh', refresh));
    if (host.id === 'minecraftTool') bar.append(button(tr('Open Screen'), 'mc-open-screen', () => ide.minecraft.screen.show('servers'), tr('The servers and the Market in an editor tab')));
    host.append(bar);
    if (!ide.root) return host.append(el('div', 'mc-empty muted', tr('Open a project to keep Minecraft servers in it.')));
    if (!list.length) return host.append(el('div', 'mc-empty muted', tr('No servers yet. New Server creates a Paper, Purpur, Vanilla, Fabric, Forge or NeoForge server, or a Velocity proxy, in servers/.')));
    for (const srv of list) {
      const running = runningAt(srv.dir);
      const card = el('div', 'mc-server');
      card.dataset.name = srv.name;
      card.dataset.dir = srv.dir;
      const head = el('div', 'mc-server-head');
      const title = el('span', 'mc-server-name', srv.name);
      title.dataset.userText = '';
      head.append(el('span', `mc-dot${running ? ' on' : ''}`), title,
        el('span', 'mc-server-kind muted', `${kindTitle(srv.kind)} ${srv.mc} · Java ${srv.java}${srv.loader ? ` · ${srv.loader}` : ''} · :${srv.port}`));
      const actions = el('div', 'mc-server-actions');
      if (running) actions.append(button(tr('Stop'), 'mc-stop', () => sessionOf(srv.dir)?.stop()));
      else {
        actions.append(button(tr('Start'), 'mc-start', () => launchOnce(srv, run.runConfig)));
        if (ide.debugger?.debugJvm) actions.append(button(tr('Debug'), 'mc-debug', () => launchOnce(srv, run.debugConfig), tr('Start with the Java debugger attached: breakpoints in its plugins and mods stop the server')));
      }
      if (running && ide.ports) actions.append(button(tr('Share'), 'mc-share', () => shareServer(srv), tr('A public address friends join with (bore.pub)')));
      if (srv.plugins) actions.append(button(tr('New Plugin…'), 'mc-plugin', () => newPlugin(srv)));
      if (srv.mods && srv.mdk) actions.append(button(tr('New Mod…'), 'mc-mod', () => newMod(srv)));
      if (srv.mods || srv.plugins) actions.append(button(tr('Market'), 'mc-server-market', () => ide.minecraft.market.open({ type: srv.mods ? 'mod' : 'plugin', server: srv }), tr('Install mods or plugins from Modrinth')));
      if (srv.mods) actions.append(button(tr('Client Pack'), 'mc-pack', () => clientPack(srv), tr('The mods players need, as a .mrpack to import once')));
      if (!srv.proxy) {
        actions.append(button(tr('Resource Pack'), 'mc-rp', () => resourcePack(srv), tr('A folder for the textures, sounds and models players get')));
        if (srv.resourcePack && ide.ports) actions.append(button(tr('Send to Players'), 'mc-rp-send', () => sendPack(srv), tr('Players download the resource pack when they join')));
      }
      actions.append(button(tr('Open Folder'), 'mc-folder', () => ide.revealInTree?.(srv.dir)));
      const info = srv.proxy ? tr('Players join this proxy and are sent on to the project\'s Paper and Purpur servers.')
        : srv.plugins ? tr('Plugins run on the server: players need nothing.')
          : srv.mods ? tr('Players need the same mods: share the Client Pack.') : '';
      const builds = el('div', 'mc-builds');
      for (const p of srv.projects || []) {
        const row = el('div', 'mc-build');
        row.dataset.project = p.name;
        const n = el('span', null, `${p.type === 'plugin' ? '🧩' : '⚙'} ${p.name}`);
        n.dataset.userText = '';
        row.append(n, button(tr('Build and Deploy'), 'mc-build-run', () => run.runConfig(buildConfig(p))));
        if (p.type === 'plugin') row.append(button(tr('Add Library…'), 'mc-add-lib', () => addLibrary(p)));
        else row.append(button(tr('Test Client'), 'mc-client', () => run.debugConfig(clientConfig(p)), tr('Starts Minecraft with the mod under the debugger: saving a change to its code reloads it in the running game')));
        builds.append(row);
      }
      card.append(head, actions, el('div', 'mc-server-note muted', info), builds);
      host.append(card);
    }
  }

  async function shareServer(srv) {
    await ide.api.invoke('ports:refresh');
    ide.toolWindows.get('Ports')?.show();
    ide.ports.share(srv.port);
  }

  const tw = ide.registerToolWindow({
    id: 'Minecraft', title: tr('Minecraft'), icon: '⛏', side: 'right', order: 80,
    mount(container) {
      container.id = 'minecraftTool';
      container.classList.add('mc-tool');
      acceptDrops(container);
      hosts.add(container);
      refresh();
    },
  });
  ide.on('projectOpened', refresh);
  ide.on('projectClosed', refresh);
  // Run tabs starting and stopping change a server's state.
  ide.on('runSessionStarting', () => setTimeout(render, 0));

  ide.registerAction({ id: 'Minecraft.NewServer', title: tr('New Minecraft Server…'), needsProject: true, run: newServer });
  ide.registerAction({ id: 'Minecraft.NewPlugin', title: tr('New Minecraft Plugin…'), needsProject: true, run: () => newPlugin() });
  ide.registerAction({ id: 'Minecraft.NewServerFromModpack', title: tr('New Minecraft Server from Modpack…'), needsProject: true, run: () => newFromModpack() });
  ide.registerAction({ id: 'Minecraft.NewMod', title: tr('New Minecraft Mod…'), needsProject: true, run: () => newMod() });
  ide.minecraft = { refresh, servers: () => list, newServer, createServer, newPlugin, createPlugin, newMod, createMod, newFromModpack, createFromModpack, dropped, clientPack, sharePack, resourcePack, sendPack, addLibrary, toolWindow: tw,
    job, jobSession, errorText, kindTitle, runningAt, restartIfRunning, reserved: (name) => RESERVED.test(name),
    // Shows the server list (with drops) in another container too: the Minecraft screen's Servers page.
    addHost(container) { acceptDrops(container); hosts.add(container); refresh(); }, removeHost: (container) => hosts.delete(container) };

  const here = document.currentScript.src.replace(/[^/]*$/, '');
  for (const file of ['market.js', 'screen.js', 'project-types.js']) {
    const script = el('script');
    script.src = `${here}${file}`;
    script.async = false;
    document.body.appendChild(script);
  }
})();
