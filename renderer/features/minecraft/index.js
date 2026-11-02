// Nano Studio Craft's Minecraft servers (main/features/minecraft.js; this plugin loads in craft mode only). My Servers
// lists the servers (servers/<name>) with Start/Stop, Share (the Ports plugin's bore tunnel for the game's TCP port:
// private by default, reached only with a join code, and Share Publicly as the second choice), the address on the same
// network, the resource pack it sends players, and the client pack of a modded server.
// - New Server: Paper, Purpur, Vanilla, Fabric, Forge or NeoForge, any Minecraft version their service offers, after
//   the user accepts the Minecraft EULA; or a Velocity proxy, which sends players on to the project's Paper and Purpur
//   servers. The Java version comes from Mojang's data and is downloaded when missing.
// - A server runs as a "Minecraft Server" run configuration: its console takes server commands (op, whitelist), and
//   Stop sends "stop" so the world is saved, killing the process only if it has not ended 30 s later.
// - Client Pack: a .mrpack of a modded server's mods, which Prism Launcher or the Modrinth App imports in one step.
// - Resource Pack: a resourcepack/ folder for textures and sounds; Send to Players zips it, serves it with a public link
//   and names it in server.properties, so every player's game downloads it when they join.
// - Market (market.js): Modrinth's modpacks, mods, plugins and resource packs, installed into a server in one click.
// - Players (players.js): who is on a server, their inventories, a log of what they did, and actions on them.
// - The Minecraft screen (screen.js) is the whole window: the instances to play and servers to join (craft.js), the
//   servers and the Market.
(() => {
  const { el, basename, dirname } = ide.util;
  const run = ide.run;
  const MEMORY = ['1G', '2G', '4G', '6G', '8G'];
  const EULA = 'https://aka.ms/MinecraftEULA';
  let kinds = [];
  let list = [];
  let host = null; // My Servers' list (screen.js)

  // ---------- jobs: main's log lines go to the console of the job that asked ----------
  const jobs = new Map(); // job id -> console
  let jobSeq = 0;
  ide.api.on('minecraft:log', ({ job, text }) => jobs.get(job)?.append(text, 'sys'));
  function job(con) {
    const id = `mc-${Date.now()}-${++jobSeq}`;
    jobs.set(id, con);
    return { id, done: () => jobs.delete(id) };
  }
  const errorText = (err) => {
    const text = ide.util.errorText(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return /is refused: its entries overlap/.test(text) ? tr('This archive was refused: its contents overlap, as in a zip bomb.') : text;
  };
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
  // starts, the Ports window learns its port is a game server's.
  async function beforeStart(dir, con) {
    const srv = serverAt(dir);
    if (srv?.proxy) {
      const { backends } = await ide.api.invoke('minecraft:wireProxy', ide.root, dir);
      con.append(`${backends.length ? tr('Players are sent on to: {servers}', { servers: backends.map((b) => `${b.name} (${b.port})`).join(', ') })
        : tr('No Paper or Purpur server in the project yet: the proxy has nowhere to send players.')}\n`, backends.length ? 'sys' : 'err');
    }
    const port = srv?.port || 25565;
    ide.ports?.gamePort(port);
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

  run.registerType({
    type: 'minecraft-server', title: tr('Minecraft Server'), icon: 'minecraft', needsInterp: false,
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
        s.attach(id, { onExit: () => { stopping.delete(id); refresh(); } });
        render();
        ide.api.invoke('ports:refresh').catch(() => {});
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
      } finally { j.done(); }
    },
  });

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
  const trusted = () => (ide.trusted === false ? (ide.ui.alert(tr('The project is open in Safe Mode, where Nano Studio runs nothing from it.')), false) : true);
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
    const sync = el('input');
    sync.type = 'checkbox';
    sync.id = 'mcAutoSync';
    sync.checked = true;
    const syncRow = el('label', 'mc-dialog-check');
    syncRow.append(sync, document.createTextNode(` ${tr('Players get the server\'s mods when they join (AutoModpack)')}`));
    const hint = note('');
    const proxy = () => !!kinds.find((x) => x.id === kind.value)?.proxy;
    const describe = () => {
      const k = kinds.find((x) => x.id === kind.value);
      hint.textContent = k?.proxy ? tr('A proxy: players join it and it sends them on to the project\'s Paper and Purpur servers. The versions are Velocity\'s own.')
        : k?.plugins ? tr('Runs plugins. Players join with plain Minecraft and need nothing else.')
          : k?.mods ? (sync.checked ? tr('Players import the Client Pack once (AutoModpack alone); after that AutoModpack gives them the server\'s mods, and every change to them, when they join.')
            : tr('Players need the same mods: Client Pack makes a pack they import once into Prism Launcher or the Modrinth App.'))
            : tr('Vanilla runs no plugins or mods.');
      eulaRow.classList.toggle('hidden', !!k?.proxy);
      syncRow.classList.toggle('hidden', !k?.mods);
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
    sync.onchange = describe;
    const f = form([[tr('Type:'), kind], [tr('Version:'), version], [tr('Name:'), name], [tr('Memory:'), memory], [tr('Port:'), port], [null, syncRow], [null, hint], [null, eulaRow]]);
    describe();
    loadVersions();
    ide.ui.dialog({
      title: tr('New Minecraft Server'), body: f.body, width: 520,
      buttons: [
        { label: tr('Create'), primary: true, run: () => {
          if (!version.value) { f.error.textContent = tr('Choose a version.'); return false; }
          if (!proxy() && !eula.checked) { f.error.textContent = tr('A Minecraft server runs only after you accept the Minecraft EULA.'); return false; }
          const n = name.value.trim();
          const p = Number(port.value.trim() || 25565);
          const why = refused(n, p);
          if (why) { f.error.textContent = why; return false; }
          const k = kinds.find((x) => x.id === kind.value);
          createServer({ name: n, kind: kind.value, mc: version.value, memory: memory.value, port: p, autoSync: !!k?.mods && sync.checked });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // What main refuses for a new server's name and port, said while the dialog still holds what was typed.
  function refused(n, p) {
    return !/^[A-Za-z][\w-]{0,39}$/.test(n) ? tr('Use letters, digits, - and _ for the name, starting with a letter (40 at most).')
      : RESERVED.test(n) ? tr('{name} is a name Windows keeps for a device: choose another.', { name: n })
        : list.some((s) => s.name.toLowerCase() === n.toLowerCase()) ? tr('A server named {name} already exists.', { name: n })
          : !Number.isInteger(p) || p < 1 || p > 65535 ? tr('Use a port from 1 to 65535.') : '';
  }
  // A name main takes for the modpack, after the servers there are: COBBLEVERSE, then COBBLEVERSE-2.
  function freeName(raw) {
    const base = (raw.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32).replace(/-+$/, '') || 'modpack');
    const taken = (n) => RESERVED.test(n) || list.some((s) => s.name.toLowerCase() === n.toLowerCase());
    let n = base;
    for (let i = 2; taken(n); i++) n = `${base}-${i}`;
    return n;
  }

  async function createServer({ autoSync, ...opts }) {
    const con = jobSession(tr('New Server'));
    const j = job(con);
    try {
      const srv = await ide.api.invoke('minecraft:create', { ...opts, root: ide.root, eula: true }, j.id);
      // Without AutoModpack (none for this Minecraft yet, Modrinth unreachable) the server still stands; Auto Sync on
      // its card tries again.
      if (autoSync) await installAutoSync(srv, con);
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

  // ---------- AutoModpack ----------
  // AutoModpack (Modrinth's automodpack, LGPL) in the server's mods and in its client pack: a player's game that has it
  // downloads the server's mods at the first join, and their changes at later ones, over the game's own port.
  const AUTO_MODPACK = 'automodpack';
  async function installAutoSync(srv, con) {
    const j = job(con);
    try {
      await ide.api.invoke('minecraft:marketInstall', ide.root, srv.dir, { id: AUTO_MODPACK, type: 'mod' }, j.id);
      con.append(`${tr('AutoModpack is on: players with the Client Pack get the server\'s mods when they join.')}\n`, 'ok');
      return true;
    } catch (err) {
      con.append(`${tr('AutoModpack could not be installed: {error}', { error: errorText(err) })}\n`, 'err');
      return false;
    } finally { j.done(); }
  }
  async function autoSync(srv) {
    if (!trusted()) return;
    if (!(await ide.ui.confirm(tr('AutoModpack goes into {name}\'s mods and its Client Pack. Players import the new Client Pack once; after that their game downloads the server\'s mods when they join, after they confirm the server\'s certificate. Players who imported the old pack replace it.', { name: srv.name }),
      { title: tr('Auto Sync Mods'), ok: tr('Install AutoModpack') }))) return;
    const con = jobSession(tr('Auto Sync'));
    if (await installAutoSync(srv, con)) await restartIfRunning(srv.dir, con);
    await refresh();
  }

  // ---------- delete ----------
  async function deleteServer(srv) {
    if (runningAt(srv.dir)) return ide.ui.alert(tr('Stop {name} first, so its world is saved.', { name: srv.name }));
    if (!(await ide.ui.confirm(tr('Move the server {name} (its folder, worlds and settings) to the Recycle Bin?', { name: srv.name }),
      { title: tr('Delete Minecraft Server'), ok: tr('Delete') }))) return;
    try {
      if (tunnels.some((t) => t.port === srv.port)) await ide.ports?.unshare(srv.port);
      await ide.api.trash(srv.dir);
    } catch (err) {
      return ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: srv.name, error: errorText(err) }));
    }
    // A proxy that sent players to it sends them on to the servers left.
    if (ide.trusted !== false) await ide.api.invoke('minecraft:rewireProxies', ide.root).catch(() => {});
    run.removeConfigs((c) => c.type === 'minecraft-server' && run.resolvePath(c.dir).toLowerCase() === srv.dir.toLowerCase());
    await ide.documentsMoved?.(srv.dir, null);
    ide.closeTab(ide.minecraft.settings.tabId(srv.dir), true);
    ide.closeTab(ide.minecraft.players.tabId(srv.dir), true);
    ide.refreshTree?.();
    await refresh();
  }

  // ---------- settings ----------
  // Server Settings opens the server's settings tab (server-settings.js).
  function serverSettings(srv) {
    if (trusted()) ide.minecraft.settings.open(srv);
  }
  // Players opens the server's players tab (players.js).
  function serverPlayers(srv) {
    if (trusted()) ide.minecraft.players.open(srv);
  }
  // A line typed into a running server's console; false when the server is not running.
  function sendCommand(dir, line) {
    const s = sessionOf(dir);
    if (!s?.running || !s.procId) return false;
    s.con?.append(`> ${line}
`, 'sys');
    ide.proc.input(s.procId, `${line}
`);
    return true;
  }

  // The mods' text without Korean, translated by Claude (the AI plugins' Claude Code) into resourcepack/, a run at a
  // time per server; Send to Players then gives it to every player.
  const translating = new Set(); // server folders (lower case)
  async function translateKorean(srv) {
    const key = srv.dir.toLowerCase();
    if (translating.has(key)) return;
    translating.add(key);
    const con = jobSession(tr('Korean Translation'));
    const j = job(con);
    const progress = ide.notifications?.notify({ title: tr('Translating the mods of {name} into Korean…', { name: srv.name }), group: 'Minecraft', timeout: 0,
      actions: [{ label: tr('Cancel'), run: () => ide.api.invoke('minecraft:cancel', j.id) }] });
    try {
      const r = await ide.api.invoke('minecraft:translateMods', ide.root, srv.dir, j.id);
      const extra = [r.rejected ? tr('{count} answers changed a format code (%s, §7) and were left out.', { count: r.rejected }) : '',
        r.failed ? tr('{count} lines got no answer.', { count: r.failed }) : ''].filter(Boolean).join(' ');
      con.append(`${tr('{count} lines translated into the resource pack.', { count: r.translated })}${extra ? ` ${extra}` : ''}\n`, r.translated ? 'ok' : 'sys');
      ide.refreshTree?.();
      await refresh();
      if (r.translated) {
        ide.notifications?.notify({
          title: tr('Mods of {name} translated into Korean', { name: srv.name }),
          text: `${tr('{count} lines, in resourcepack/assets/<mod>/lang/ko_kr.json. Send to Players gives them to everyone who plays in Korean; edit a line there and it is kept.', { count: r.translated })}${extra ? ` ${extra}` : ''}`,
          kind: 'ok', group: 'Minecraft',
          actions: [
            ...(ide.ports ? [{ label: tr('Send to Players'), run: (n) => { n.expire(); sendPack(serverAt(srv.dir) || srv); } }] : []),
            { label: tr('Open File'), run: () => ide.openFile?.(r.files[0].file) },
          ],
        });
      }
    } catch (err) {
      const text = /Cancelled/.test(errorText(err)) ? tr('Cancelled. The lines translated so far are kept.')
        : /Claude Code is not installed/.test(errorText(err)) ? tr('Translation uses Claude Code, which is not installed. Install Claude Code and sign in to it, then try again.')
          : errorText(err);
      con.append(`${text}\n`, 'err');
      if (!/Cancelled/.test(errorText(err))) ide.notifications?.notify({ title: tr('The mods of {name} could not be translated', { name: srv.name }), text, kind: 'error', group: 'Minecraft', raw: true });
    } finally {
      progress?.expire();
      j.done();
      translating.delete(key);
    }
  }

  // ---------- sharing files (client pack, resource pack) ----------
  // A server's client-pack/ folder is served by the app (main/minecraft/file-server.js, on loopback) and that port
  // shared, which the Ports plugin gives a public https address. A tunnel that went away is made again.
  const sharing = new Map(); // port -> Promise<base url | null>, while its tunnel is being made
  const tunnelWaits = new Map(); // port -> resolve(url | null)
  const TUNNEL_WAIT = 90000;
  let tunnels = []; // the Ports plugin's tunnels, from its last ports:changed
  let listening = []; // its listening ports, each with its addresses on this network
  ide.api.on('ports:changed', (st) => {
    for (const [port, resolve] of tunnelWaits) {
      const t = st.tunnels.find((x) => x.port === port);
      if (t?.state === 'shared' || t?.state === 'failed') resolve(t.state === 'shared' ? t.url : null);
    }
    // A server's card shows its public address (or that it is being made) and its address on the same network: from
    // this event, which the Ports plugin may not have taken in yet.
    tunnels = st.tunnels || [];
    listening = st.ports || [];
    if (list.some((s) => runningAt(s.dir))) render();
  });
  async function shareFiles(port) {
    // The Ports plugin lists what the IDE's own programs listen on; this server is the app itself.
    await ide.api.invoke('ports:setAdded', [...new Set([...ide.ports.state().added, port])]);
    ide.ports.hint(port, 'http');
    return new Promise((resolve) => {
      const finish = (url) => { clearTimeout(giveUp); tunnelWaits.delete(port); resolve(url); };
      const giveUp = setTimeout(finish, TUNNEL_WAIT, null);
      tunnelWaits.set(port, finish);
      // Declined, or its tool could not be had: no tunnel will come.
      ide.ports.share(port).then(() => { if (!['starting', 'shared'].includes(ide.ports.state().tunnels.find((t) => t.port === port)?.state)) finish(null); }, () => finish(null));
    });
  }
  async function serveFolder(folder) {
    const port = await ide.api.invoke('minecraft:serveFolder', ide.root, folder);
    const tunnel = ide.ports.state().tunnels.find((t) => t.port === port);
    if (tunnel?.state === 'shared') return tunnel.url;
    // A failed tunnel stays listed, and sharing a listed port does nothing.
    if (tunnel?.state === 'failed') await ide.ports.unshare(port);
    if (!sharing.has(port)) sharing.set(port, shareFiles(port).finally(() => sharing.delete(port)));
    return sharing.get(port);
  }

  async function clientPack(srv) {
    if (!trusted()) return;
    try {
      const r = await ide.api.invoke('minecraft:clientPack', ide.root, srv.dir);
      ide.refreshTree?.();
      ide.notifications?.notify({
        title: tr('Client pack for {name}', { name: srv.name }),
        text: r.autoSync ? tr('AutoModpack alone, Minecraft {mc}, {loader}. Players import it once in Prism Launcher or the Modrinth App (Add Instance › Import); at their first join it downloads the server\'s mods.', { mc: r.mc, loader: r.loader })
          : r.modpack ? tr('The modpack {name} (Minecraft {mc}, {loader}). Players import it once in Prism Launcher or the Modrinth App (Add Instance › Import).', { name: r.modpack, mc: r.mc, loader: r.loader })
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
        if (!name.value) name.value = freeName(info.name);
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
          const n = name.value.trim();
          const p = Number(port.value.trim() || 25565);
          const why = refused(n, p);
          if (why) { f.error.textContent = why; return false; }
          if (!eula.checked) { f.error.textContent = tr('A Minecraft server runs only after you accept the Minecraft EULA.'); return false; }
          created = true;
          createFromModpack({ file: info.file, name: n, memory: memory.value, port: p });
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
    bomb: () => tr('Refused: its contents overlap, as in a zip bomb. Nothing was written.'),
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

  // ---------- server list ----------
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
    if (host) renderServers();
    ide.minecraft?.settings?.paintStates();
    ide.minecraft?.players?.paintStates();
  }
  // Start or Debug clicked again before the server runs (its card shows Stop only then) starts it once.
  const launching = new Set(); // server folders (lower case)
  function launchOnce(srv, how) {
    const key = srv.dir.toLowerCase();
    if (launching.has(key) || runningAt(srv.dir)) return undefined;
    launching.add(key);
    return Promise.resolve(how(serverConfig(srv))).catch(() => {}).finally(() => { launching.delete(key); render(); });
  }
  function renderServers() {
    host.replaceChildren();
    if (!list.length) {
      const empty = el('div', 'mcc-empty');
      empty.append(el('div', 'mcc-empty-title', tr('No servers yet')),
        el('div', 'muted', tr('Make a server for your friends with New Server, or start from a modpack with Server from Modpack.')));
      return host.append(empty);
    }
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
      else actions.append(button(tr('Start'), 'mc-start', () => launchOnce(srv, run.runConfig)));
      const tunnel = running && ide.ports ? tunnels.find((t) => t.port === srv.port) : null;
      if (running && ide.ports && tunnel?.state !== 'shared' && tunnel?.state !== 'starting') {
        actions.append(button(tr('Share'), 'mc-share', () => shareServer(srv), tr('A private join code friends use in Nano Studio Craft')),
          button(tr('Share Publicly'), 'mc-share-public', () => shareServer(srv, { publicly: true }), tr('A public address anyone can join (bore.pub)')));
      }
      if (srv.mods || srv.plugins) actions.append(button(tr('Market'), 'mc-server-market', () => ide.minecraft.market.open({ type: srv.mods ? 'mod' : 'plugin', server: srv }), tr('Install mods or plugins from Modrinth')));
      if (srv.mods) actions.append(button(tr('Client Pack'), 'mc-pack', () => clientPack(srv), tr('The mods players need, as a .mrpack to import once')));
      // A modpack's own client pack has its client-only mods, which AutoModpack would not send.
      if (srv.mods && !srv.autoSync && !srv.modpack) actions.append(button(tr('Auto Sync'), 'mc-autosync', () => autoSync(srv), tr('Players get the server\'s mods when they join (AutoModpack)')));
      if (!srv.proxy) {
        actions.append(button(tr('Resource Pack'), 'mc-rp', () => resourcePack(srv), tr('A folder for the textures, sounds and models players get')));
        if (srv.resourcePack && ide.ports) actions.append(button(tr('Send to Players'), 'mc-rp-send', () => sendPack(srv), tr('Players download the resource pack when they join')));
      }
      actions.append(button(tr('Players'), 'mc-players', () => serverPlayers(srv), tr('Who is on, their inventories, a log of what they did, and actions on them')));
      actions.append(button(tr('Settings…'), 'mc-settings', () => serverSettings(srv), srv.mods ? tr('Server settings, and Korean for its mods') : tr('Server settings')));
      actions.append(button(tr('Open Folder'), 'mc-folder', () => ide.api.invoke('shell:openPath', srv.dir)));
      if (!running) actions.append(button(tr('Delete…'), 'mc-delete', () => deleteServer(srv), tr('Moves the server folder to the Recycle Bin')));
      const info = srv.proxy ? tr('Players join this proxy and are sent on to the project\'s Paper and Purpur servers.')
        : srv.plugins ? tr('Plugins run on the server: players need nothing.')
          : srv.autoSync ? tr('AutoModpack is on: players import the Client Pack once, then get the server\'s mods, and every change to them, when they join.')
            : srv.mods ? tr('Players need the same mods: share the Client Pack.') : '';
      card.append(head, actions);
      if (tunnel) card.append(publicRow(srv, tunnel));
      if (running) card.append(...lanRows(srv));
      card.append(el('div', 'mc-server-note muted', info));
      host.append(card);
    }
  }

  // What other computers on the same network connect to: no sharing, no third party.
  function lanRows(srv) {
    const addresses = (listening.find((p) => p.port === srv.port)?.lan || []).map((ip) => `${ip}:${srv.port}`);
    return addresses.map((address) => {
      const row = el('div', 'mc-lan');
      row.title = tr('Address for other computers on the same network');
      const addr = el('span', 'mc-lan-addr', address);
      addr.dataset.userText = '';
      row.append(el('span', 'muted', tr('Same network:')), addr, button(tr('Copy Address'), 'mc-lan-copy', () => ide.api.invoke('clipboard:writeText', address)));
      return row;
    });
  }

  // A private share's row: no address, since it reaches nobody without the code.
  function privateRow(srv, tunnel) {
    const row = el('div', 'mc-public mc-private');
    if (tunnel.state === 'shared') {
      row.append(el('span', 'mcc-chip private', tr('Private')),
        button(tr('Copy Join Code'), 'mc-join-code', () => copyJoinCode(srv, tunnel), tr('The code friends paste into Servers to Join. It is a key: send it only to friends.')),
        button(tr('Stop Sharing'), 'mc-public-stop', () => ide.ports.unshare(srv.port)),
        el('div', 'mc-private-note muted', tr('Friends need Nano Studio Craft and this join code. The join code is a key: send it only to friends.')));
    } else if (tunnel.state === 'starting') row.append(el('span', 'muted', tr('Starting private sharing…')));
    else row.append(el('span', 'mc-public-error', tr('Private sharing failed: {error}', { error: tunnel.error || '' })));
    return row;
  }

  // The address players join with, on the card while the server is shared.
  function publicRow(srv, tunnel) {
    if (tunnel.private) return privateRow(srv, tunnel);
    const row = el('div', 'mc-public');
    if (tunnel.state === 'shared') {
      const addr = el('span', 'mc-public-addr', tunnel.url);
      addr.dataset.userText = '';
      row.append(el('span', 'muted', tr('Public address:')), addr,
        button(tr('Copy Address'), 'mc-public-copy', () => ide.api.invoke('clipboard:writeText', tunnel.url)),
        button(tr('Copy Join Code'), 'mc-join-code', () => copyJoinCode(srv, tunnel), tr('The code friends paste into Servers to Join: this address and, for a modded server, its client pack')),
        button(tr('Stop Sharing'), 'mc-public-stop', () => ide.ports.unshare(srv.port)));
    } else if (tunnel.state === 'starting') row.append(el('span', 'muted', tr('Making a public address…')));
    else row.append(el('span', 'mc-public-error', tr('The public address failed: {error}', { error: tunnel.error || '' })));
    return row;
  }

  // Craft's join code: the public address and, for a modded server, its client pack's link, which Join in a friend's
  // Nano Studio Craft syncs the mods from. A private share's key stays in main, which writes that code itself.
  async function copyJoinCode(srv, tunnel) {
    try {
      let pack = null;
      if (srv.mods) {
        const r = await ide.api.invoke('minecraft:clientPack', ide.root, srv.dir);
        const base = await serveFolder(dirname(r.file));
        if (!base) return ide.ui.alert(tr('The link could not be made; see the Ports window.'));
        pack = `${base}/${encodeURIComponent(basename(r.file))}`;
      }
      const code = await (tunnel.private ? ide.api.invoke('minecraft:privateCode', ide.root, srv.dir, { pack })
        : ide.api.invoke('launcher:joinCode', { address: tunnel.url, pack, name: srv.name }));
      await ide.api.invoke('clipboard:writeText', code);
      ide.notifications?.notify({ title: tr('Join code copied'), text: tr('Friends paste it into Servers to Join in Nano Studio Craft.'), kind: 'ok', group: 'Minecraft' });
    } catch (err) { ide.ui.alert(errorText(err)); }
  }

  // Share is private: strangers who find the port get nothing, so only the account check below is asked. Share Publicly
  // also warns and offers the whitelist.
  // A server with account checks off (behind a proxy) is not shared directly: anyone could join with any name. The
  // project's proxy is shared instead, which checks the accounts and sends players on.
  async function shareServer(card, { publicly = false } = {}) {
    // As the server is now: a proxy started since the card was drawn has turned its account checks off.
    await refresh();
    const srv = list.find((s) => s.dir.toLowerCase() === card.dir.toLowerCase()) || card;
    let target = srv;
    if (srv.offline) {
      const proxy = list.find((s) => s.proxy);
      if (proxy) {
        if (!(await ide.ui.confirm(tr('{name} has account checks off because the proxy {proxy} checks them: joined directly, anyone could play under any name. Share the proxy instead?', { name: srv.name, proxy: proxy.name }),
          { title: tr('Share Minecraft Server'), ok: tr('Share the Proxy') }))) return;
        if (!runningAt(proxy.dir)) return ide.ui.alert(tr('Start the proxy {proxy} first, then share it.', { proxy: proxy.name }));
        target = proxy;
      } else if (!(await ide.ui.confirm(publicly ? tr('{name} has account checks off (online-mode=false): anyone with the address could play under any name, an operator\'s too. Share it anyway?', { name: srv.name })
        : tr('{name} has account checks off (online-mode=false): anyone with the join code could play under any name, an operator\'s too. Share it anyway?', { name: srv.name }),
      { title: tr('Share Minecraft Server'), ok: tr('Share Anyway') }))) return;
    }
    if (publicly && !(await offerWhitelist(target))) return;
    await ide.api.invoke('ports:refresh');
    // A failed tunnel stays listed, and sharing a listed port does nothing.
    if (tunnels.find((t) => t.port === target.port)?.state === 'failed') await ide.ports.unshare(target.port);
    await ide.ports.share(target.port, { private: !publicly });
    render();
  }
  // A public address reaches anyone who finds it, and a server without a whitelist lets them in. false: not shared.
  async function offerWhitelist(srv) {
    const s = await ide.api.invoke('minecraft:settings', ide.root, srv.dir);
    if (s.proxy || s.props['white-list'] === 'true') return true;
    const answer = await new Promise((resolve) => {
      let picked = null;
      ide.ui.dialog({
        title: tr('Share {name}', { name: srv.name }), width: 480, onClose: () => resolve(picked),
        body: el('div', 'dialog-message', tr('A public address lets anyone who finds it join {name}. Turn on the whitelist, so only players you add can join?', { name: srv.name })),
        buttons: [
          { label: tr('Turn On and Share'), primary: true, run: () => { picked = 'on'; return true; } },
          { label: tr('Share Without It'), run: () => { picked = 'off'; return true; } },
          { label: tr('Cancel') },
        ],
      });
    });
    if (answer !== 'on') return answer === 'off';
    try {
      await ide.api.invoke('minecraft:saveSettings', ide.root, srv.dir, { props: { 'white-list': 'true', 'enforce-whitelist': 'true' } });
    } catch (err) { ide.ui.alert(errorText(err)); return false; }
    sendCommand(srv.dir, 'whitelist on');
    ide.notifications?.notify({
      title: tr('Whitelist on'), text: tr('Add your friends, and yourself, in the server\'s settings under Players.'), kind: 'ok', group: 'Minecraft',
      actions: [{ label: tr('Settings…'), run: (n) => { n.expire(); serverSettings(srv); } }],
    });
    return true;
  }

  ide.on('projectOpened', refresh);
  ide.on('projectClosed', refresh);
  // Run tabs starting and stopping change a server's state.
  ide.on('runSessionStarting', () => setTimeout(render, 0));

  ide.registerAction({ id: 'Minecraft.NewServer', title: tr('New Minecraft Server…'), needsProject: true, run: newServer });
  ide.registerAction({ id: 'Minecraft.NewServerFromModpack', title: tr('New Minecraft Server from Modpack…'), needsProject: true, run: () => newFromModpack() });
  ide.minecraft = { refresh, servers: () => list, newServer, createServer, newFromModpack, createFromModpack, dropped, clientPack, autoSync, deleteServer, serverSettings, sendCommand, translateKorean, sharePack, resourcePack, sendPack,
    job, jobSession, errorText, kindTitle, runningAt, restartIfRunning, startServer: (srv) => launchOnce(srv, run.runConfig),
    // The server list (with drops) in the Minecraft screen's My Servers page.
    showServersIn(container) { acceptDrops(container); host = container; refresh(); } };

  const here = document.currentScript.src.replace(/[^/]*$/, '');
  for (const file of ['market.js', 'craft.js', 'screen.js', 'server-settings.js', 'players.js']) {
    const script = el('script');
    script.src = `${here}${file}`;
    script.async = false;
    document.body.appendChild(script);
  }
})();
