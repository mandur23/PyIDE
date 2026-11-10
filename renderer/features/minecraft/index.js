// Nano Studio Craft's Minecraft servers (main/features/minecraft.js; this plugin loads in craft mode only). My Servers
// lists the servers (servers/<name>) with Start/Stop, Share (the Ports plugin's bore tunnel for the game's TCP port:
// private by default, reached only with a join code, and Share Publicly as the second choice), the address on the same
// network, the resource pack it sends players, and the client pack of a modded server.
// - New Server: Paper, Purpur, Vanilla, Fabric, Forge or NeoForge, any Minecraft version their service offers, after
//   the user accepts the Minecraft EULA; or a Velocity proxy, which sends players on to the project's Paper and Purpur
//   servers. The Java version comes from Mojang's data and is downloaded when missing.
// - A server runs as a "Minecraft Server" run configuration: its console takes server commands (op, whitelist), and
//   Stop sends "stop" so the world is saved, killing the process only once it has printed nothing for 60 s.
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
  let blocked = []; // names in servers/ that are not servers
  let damaged = []; // servers whose pyide-server.json cannot be used: {name, dir, damaged: 'unreadable' | 'kind', kind}
  let host = null; // My Servers' list (screen.js)

  // ---------- jobs: main's log lines go to the console of the job that asked ----------
  const jobs = new Map(); // job id -> console
  let jobSeq = 0;
  ide.api.on('minecraft:log', ({ job, text }) => jobs.get(job)?.append(text, 'sys'));
  const progressOf = new Map(); // job id -> ({done, total}) => void, while a job that reports its progress runs
  ide.api.on('minecraft:progress', ({ job, done, total }) => progressOf.get(job)?.({ done, total }));
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
  // The port each server's process was started with (folder, lower case): a server-port saved while it runs applies at
  // its next start, and until then its share and its addresses stay at this one.
  const livePorts = new Map();
  const portAt = (srv) => (runningAt(srv.dir) && livePorts.get(srv.dir.toLowerCase())) || srv.port;

  // Windows keeps these names for devices: no folder can have one.
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  // Processes of servers asked to stop that have not ended yet (process id -> server folder, lower case): they still
  // hold their ports and worlds.
  const stopping = new Map();
  // A stopping server is killed once it has printed nothing for STOP_WAIT: a big modpack saves for minutes, printing as
  // it goes, and one that has hung is silent. One that never stops printing is killed STOP_LIMIT after Stop. (A quit
  // gives each server main's fixed minute.)
  const STOP_WAIT = 60000;
  const STOP_LIMIT = 15 * 60000;
  const quietTimers = new Map(); // process id -> rearm(), while it stops
  ide.api.on('proc:data', ({ id }) => quietTimers.get(id)?.());
  const stoppingAt = (dir) => [...stopping.values()].includes(dir.toLowerCase());
  // A server whose folder is in use: running, starting (a Java download, say), or still saving after Stop or Rerun.
  // A process still running there that this window did not start (main's list says so: leftOver).
  const busyAt = (dir) => runningAt(dir) || !!sessionOf(dir)?.starting || launching.has(dir.toLowerCase()) || stoppingAt(dir) || !!serverAt(dir)?.leftOver;

  // Before a proxy starts, its [servers] and the Paper servers' forwarding follow the project; before any server
  // starts, the Ports window learns its port is a game server's. The port is main's, read from the files as the server
  // will (launch): the list may be from before server.properties changed.
  async function beforeStart(dir, con, port) {
    const srv = serverAt(dir);
    if (srv?.proxy) {
      const { backends, skipped = [] } = await ide.api.invoke('minecraft:wireProxy', ide.root, dir);
      con.append(`${backends.length ? tr('Players are sent on to: {servers}', { servers: backends.map((b) => `${b.name} (${b.port})`).join(', ') })
        : tr('No Paper or Purpur server in the project yet: the proxy has nowhere to send players.')}\n`, backends.length ? 'sys' : 'err');
      for (const s of skipped) con.append(`${tr('{name} runs Minecraft {mc}, older than 1.13, which has no modern forwarding: the proxy does not send players there, and it keeps its own account checks.', s)}\n`, 'err');
    }
    ide.ports?.gamePort(port);
    // A server still stopping (Rerun of a running one) holds its world and port until it has saved or been killed; a
    // port that another program holds does not come free, so the start ends here instead of failing to bind it.
    const free = () => ide.api.invoke('minecraft:portFree', port);
    const saving = () => stoppingAt(dir);
    if (srv && (saving() || !(await free()))) {
      con.append(`${tr('Waiting for port {port} to be free…', { port })}\n`, 'sys');
      const longer = (i) => saving() || ((stopping.size || i < 6) && i < (STOP_WAIT + 10000) / 500);
      for (let i = 0; longer(i) && (saving() || !(await free())); i++) await new Promise((r) => setTimeout(r, 500));
      if (!(await free())) throw new Error(tr('Port {port} is in use by another program: stop it, or change server-port in server.properties.', { port }));
    }
    livePorts.set(dir.toLowerCase(), port);
  }
  // Stop asks the server to save and quit ("end" for a Velocity proxy); the process is killed only when it has gone
  // quiet (above), and the console and a notification say so: its world may be half saved. By its id: a Rerun has
  // moved the session on to the next process by then.
  function gracefulStop(s, dir) {
    s.kill = (pid) => {
      if (stopping.has(pid)) return;
      stopping.set(pid, dir.toLowerCase());
      ide.proc.input(pid, serverAt(dir)?.proxy ? 'end\n' : 'stop\n');
      const asked = Date.now();
      let timer = null;
      const kill = () => {
        quietTimers.delete(pid);
        if (!stopping.has(pid)) return;
        const name = basename(dir);
        const text = tr('{name} did not finish stopping: it printed nothing for {seconds} seconds after "stop", so it was ended. Its world may not have been saved completely.', { name, seconds: STOP_WAIT / 1000 });
        s.con?.append(`\n${text}\n`, 'err');
        ide.notifications?.notify({ title: tr('{name} was ended without finishing its save', { name }), text, kind: 'error', group: 'Minecraft', raw: true });
        ide.proc.kill(pid);
      };
      const rearm = () => { clearTimeout(timer); timer = setTimeout(kill, Math.min(STOP_WAIT, Math.max(0, STOP_LIMIT - (Date.now() - asked)))); };
      quietTimers.set(pid, rearm);
      rearm();
      render();
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
        await beforeStart(dir, con, spec.port);
        con.append(`${[spec.cmd, ...spec.args].map(quote).join(' ')}\n`, 'sys');
        const id = await ide.api.invoke('minecraft:start', ide.root, spec);
        gracefulStop(s, dir);
        s.attach(id, { onExit: () => { stopping.delete(id); quietTimers.delete(id); refresh(); } });
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
    const ended = new Promise((resolve) => { s.exitHooks.push(resolve); setTimeout(resolve, STOP_LIMIT + 5000); });
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
    // A name no server has yet: a second New Server suggests survival-2, not a name Create refuses.
    const suggested = { name: freeName('survival'), proxy: freeName('proxy') };
    const name = input('mcName', suggested.name);
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
      // The suggestions follow the type while the user has not typed their own; back from Velocity they go back too.
      if (k?.proxy && name.value === suggested.name) { name.value = suggested.proxy; port.value = '25577'; }
      else if (!k?.proxy && name.value === suggested.proxy) { name.value = suggested.name; if (port.value === '25577') port.value = '25565'; }
    };
    // Only the last type's answer fills the list: a slow answer for the type before cannot land under the new one.
    let versionsSeq = 0;
    const loadVersions = async () => {
      const mine = ++versionsSeq;
      version.replaceChildren(new Option(tr('Loading…'), ''));
      version.disabled = true;
      f.error.textContent = '';
      let vs = null;
      let failed = null;
      try { vs = await ide.api.invoke('minecraft:versions', kind.value); } catch (err) { failed = err; }
      if (mine !== versionsSeq) return;
      if (failed) {
        version.replaceChildren(new Option(tr('Could not load the versions'), ''));
        f.error.textContent = errorText(failed);
      } else version.replaceChildren(...vs.map((v) => new Option(v, v)));
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

  // What main refuses for a new server's name and port, said while the dialog still holds what was typed. A folder
  // in servers/ that is no server (the user's own) takes its name too.
  function refused(n, p) {
    return !/^[A-Za-z][\w-]{0,39}$/.test(n) ? tr('Use letters, digits, - and _ for the name, starting with a letter (40 at most).')
      : RESERVED.test(n) ? tr('{name} is a name Windows keeps for a device: choose another.', { name: n })
        : [...list, ...damaged].some((s) => s.name.toLowerCase() === n.toLowerCase()) ? tr('A server named {name} already exists.', { name: n })
          : blocked.some((b) => b.toLowerCase() === n.toLowerCase()) ? tr('servers/{name} is a folder that is not a server: choose another name, or move that folder away.', { name: n })
            : !Number.isInteger(p) || p < 1 || p > 65535 ? tr('Use a port from 1 to 65535.') : '';
  }
  // A name main takes for the modpack, after the servers there are: COBBLEVERSE, then COBBLEVERSE-2.
  function freeName(raw) {
    const base = (raw.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32).replace(/-+$/, '') || 'modpack');
    const taken = (n) => RESERVED.test(n) || [...list, ...damaged].map((s) => s.name).concat(blocked).some((x) => x.toLowerCase() === n.toLowerCase());
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
    if (busyAt(srv.dir)) return ide.ui.alert(tr('Stop {name} first, so its world is saved.', { name: srv.name }));
    if (!(await ide.ui.confirm(tr('Move the server {name} (its folder, worlds and settings) to the Recycle Bin?', { name: srv.name }),
      { title: tr('Delete Minecraft Server'), ok: tr('Delete') }))) return;
    try {
      // A share is a port's, and 25565 is every server's default: one another running server owns stays.
      const owned = list.some((s) => s.dir.toLowerCase() !== srv.dir.toLowerCase() && portAt(s) === srv.port && runningAt(s.dir));
      if (!owned && tunnels.some((t) => t.port === srv.port)) await ide.ports?.unshare(srv.port);
      await ide.api.trash(srv.dir);
    } catch (err) {
      return ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: srv.name, error: errorText(err) }));
    }
    // A proxy that sent players to it sends them on to the servers left.
    if (ide.trusted !== false) {
      await ide.api.invoke('minecraft:rewireProxies', ide.root).catch((err) => ide.ui.alert(tr('{name} was deleted, but the proxies could not be updated: {error}', { name: srv.name, error: errorText(err) })));
    }
    run.removeConfigs((c) => c.type === 'minecraft-server' && run.resolvePath(c.dir).toLowerCase() === srv.dir.toLowerCase());
    await ide.documentsMoved?.(srv.dir, null);
    ide.closeTab(ide.minecraft.settings.tabId(srv.dir), true);
    ide.closeTab(ide.minecraft.players.tabId(srv.dir), true);
    ide.closeTab(ide.minecraft.backups.tabId(srv.dir), true);
    ide.refreshTree?.();
    await refresh();
  }

  // A server still running from before (the app closed or crashed while it ran) has no console here to send "stop" to:
  // its process can only be ended, which is pulling the plug on its world.
  async function endLeftOver(srv) {
    if (!(await ide.ui.confirm(tr('{name} is still running from before (process {pid}), and this window cannot reach its console to ask it to save. Ending it is like pulling the plug: what happened in the world since its last autosave (every 5 minutes) is lost, and players on it are dropped. If another Nano Studio is running it, stop it there instead. End it now?', { name: srv.name, pid: srv.leftOver.pid }),
      { title: tr('End Minecraft Server'), ok: tr('End Without Saving') }))) return;
    try {
      const r = await ide.api.invoke('minecraft:endLeftOver', ide.root, srv.dir);
      if (!r.ended) ide.ui.alert(tr('{name} could not be ended. Open Task Manager and end its java.exe there.', { name: srv.name }));
    } catch (err) { ide.ui.alert(errorText(err)); }
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

  // The mods' text without Korean, translated by Claude (the AI plugins' Claude Code) into a resource pack, a run at a
  // time per folder: a server's resourcepack/, which Send to Players then gives to every player, or an instance's own
  // pack (craft.js). run(job id) -> main's result; done(r, extra) -> the result's notification {text, actions}, or null
  // for none; failed(text) -> the UI's language for an error, or null for errorText's.
  const translating = new Set(); // folders (lower case)
  async function runTranslation({ key, name, run, done, failed = () => null }) {
    if (translating.has(key)) return null;
    translating.add(key);
    const con = jobSession(tr('Korean Translation'));
    const j = job(con);
    const title = tr('Translating the mods of {name} into Korean…', { name });
    const progress = ide.notifications?.notify({ title, text: tr('Looking for text without Korean…'), group: 'Minecraft', timeout: 0, raw: true,
      actions: [{ label: tr('Cancel'), run: () => ide.api.invoke('minecraft:cancel', j.id) }] });
    // One bar for the whole run: every line without Korean in all the mods is 100 %. In the balloon, and in the status
    // bar's task, which stays when the balloon is closed.
    const task = ide.tasks?.start({ title, onCancel: () => ide.api.invoke('minecraft:cancel', j.id) });
    const bar = el('div', 'mc-tr-bar');
    bar.appendChild(el('div', 'mc-tr-fill'));
    progress?.balloon?.querySelector('.ide-balloon-text')?.after(bar);
    progressOf.set(j.id, ({ done, total }) => {
      if (!total) return;
      const fraction = Math.min(1, done / total);
      const percent = Math.floor(fraction * 100);
      const text = tr('{percent}% · {done} / {total} lines', { percent, done: done.toLocaleString(), total: total.toLocaleString() });
      task?.update({ fraction, text });
      bar.firstChild.style.width = `${percent}%`;
      bar.dataset.percent = String(percent);
      const t = progress?.balloon?.querySelector('.ide-balloon-text');
      if (t) t.textContent = text;
    });
    try {
      const r = await run(j.id);
      const extra = [r.rejected ? tr('{count} answers changed a format code (%s, §7) and were left out.', { count: r.rejected }) : '',
        r.failed ? tr('{count} lines got no answer.', { count: r.failed }) : ''].filter(Boolean).join(' ');
      con.append(`${tr('{count} lines translated into the resource pack.', { count: r.translated })}${extra ? ` ${extra}` : ''}\n`, r.translated ? 'ok' : 'sys');
      ide.refreshTree?.();
      const said = done(r, extra);
      if (said) ide.notifications?.notify({ title: tr('Mods of {name} translated into Korean', { name }), kind: 'ok', group: 'Minecraft', ...said });
      return r;
    } catch (err) {
      const text = /Cancelled/.test(errorText(err)) ? tr('Cancelled. The lines translated so far are kept.')
        : /Claude Code is not installed/.test(errorText(err)) ? tr('Translation uses Claude Code, which is not installed. Install Claude Code and sign in to it, then try again.')
          : failed(errorText(err)) || errorText(err);
      con.append(`${text}\n`, 'err');
      if (!/Cancelled/.test(errorText(err))) ide.notifications?.notify({ title: tr('The mods of {name} could not be translated', { name }), text, kind: 'error', group: 'Minecraft', raw: true });
      return null;
    } finally {
      progressOf.delete(j.id);
      task?.done();
      progress?.expire();
      j.done();
      translating.delete(key);
    }
  }
  const translateKorean = (srv) => runTranslation({
    key: srv.dir.toLowerCase(), name: srv.name,
    run: async (id) => { const r = await ide.api.invoke('minecraft:translateMods', ide.root, srv.dir, id); await refresh(); return r; },
    done: (r, extra) => (!r.translated ? null : {
      text: `${tr('{count} lines, in resourcepack/assets/<mod>/lang/ko_kr.json. Send to Players gives them to everyone who plays in Korean; edit a line there and it is kept.', { count: r.translated })}${extra ? ` ${extra}` : ''}`,
      actions: [
        ...(ide.ports ? [{ label: tr('Send to Players'), run: (n) => { n.expire(); sendPack(serverAt(srv.dir) || srv); } }] : []),
        { label: tr('Open File'), run: () => ide.openFile?.(r.files[0].file) },
      ],
    }),
  });

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
          : r.modpack && r.added?.length ? tr('The modpack {name} and the {count} mods added to the server since (Minecraft {mc}, {loader}). Players import it once in Prism Launcher or the Modrinth App (Add Instance › Import).', { name: r.modpack, count: r.added.length, mc: r.mc, loader: r.loader })
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
    modpack: () => tr('another modpack: a server is made from one modpack at a time, so drop this one again after that'),
    unknown: () => tr('not a server, world, resource pack, plugin, mod or modpack'),
    bomb: () => tr('Refused: its contents overlap, as in a zip bomb. Nothing was written.'),
    dimension: () => tr('the Nether or the End of a Paper world: drop it together with its world folder'),
  };
  const WHAT = { server: () => tr('server imported'), plugin: () => tr('plugin added'), mod: () => tr('mod added'), resourcepack: () => tr('resource pack added'), world: () => tr('world added (level-name)'),
    dimension: () => tr('added with its world') };
  async function dropped(paths, serverDir) {
    if (!paths.length || !trusted()) return;
    // A world dropped on a server's card becomes its level: the world it had is backed up first (backups.js).
    const target = serverDir && serverAt(serverDir);
    if (target && (await Promise.all(paths.map((p) => ide.api.invoke('fs:exists', `${p}\\level.dat`).catch(() => false)))).some(Boolean)
      && !(await ide.minecraft.backups.before(target, 'world'))) return;
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
    if (!ide.root) { list = []; blocked = []; damaged = []; render(); return; }
    kinds = kinds.length ? kinds : await ide.api.invoke('minecraft:kinds').catch(() => []);
    [list, blocked, damaged] = await Promise.all([ide.api.invoke('minecraft:servers', ide.root).catch(() => []), ide.api.invoke('minecraft:blockedNames', ide.root).catch(() => []),
      ide.api.invoke('minecraft:damagedServers', ide.root).catch(() => [])]);
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
    ide.minecraft?.backups?.paintStates();
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
    if (!list.length && !damaged.length) {
      const empty = el('div', 'mcc-empty');
      empty.append(el('div', 'mcc-empty-title', tr('No servers yet')),
        el('div', 'muted', tr('Make a server for your friends with New Server, or start from a modpack with Server from Modpack.')));
      return host.append(empty);
    }
    for (const srv of list) {
      const running = runningAt(srv.dir);
      const port = portAt(srv);
      const card = el('div', 'mc-server');
      card.dataset.name = srv.name;
      card.dataset.dir = srv.dir;
      const head = el('div', 'mc-server-head');
      const title = el('span', 'mc-server-name', srv.name);
      title.dataset.userText = '';
      head.append(el('span', `mc-dot${running || srv.leftOver ? ' on' : ''}`), title,
        el('span', 'mc-server-kind muted', `${kindTitle(srv.kind)} ${srv.mc} · Java ${srv.java}${srv.loader ? ` · ${srv.loader}` : ''} · :${port}`));
      const load = ide.minecraft.health?.chip(srv);
      if (load) head.append(load);
      const actions = el('div', 'mc-server-actions');
      // Starting (a Java download, a busy port being waited out) and saving after Stop take a while, and a second
      // press does nothing then: the card says so instead of offering a button that cannot work.
      const wait = (label, cls) => Object.assign(button(label, cls, () => {}), { disabled: true });
      if (srv.leftOver && !running) {
        card.append(head, actions, el('div', 'mc-server-note mc-leftover-why', tr('Still running from before: an earlier Nano Studio started it (or another one did), and this window cannot reach its console.')));
        actions.append(button(tr('End Server…'), 'mc-end-leftover', () => endLeftOver(srv), tr('Ends its process without saving')),
          button(tr('Open Folder'), 'mc-folder', () => ide.api.invoke('shell:openPath', srv.dir)));
        host.append(card);
        continue;
      }
      if (stoppingAt(srv.dir)) actions.append(wait(tr('Stopping…'), 'mc-stopping'));
      else if (running) actions.append(button(tr('Stop'), 'mc-stop', () => sessionOf(srv.dir)?.stop()));
      else if (busyAt(srv.dir)) actions.append(wait(tr('Starting…'), 'mc-starting'));
      else actions.append(button(tr('Start'), 'mc-start', () => launchOnce(srv, run.runConfig)));
      const tunnel = running && ide.ports ? tunnels.find((t) => t.port === port) : null;
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
      if (!srv.proxy) actions.append(button(tr('Backups'), 'mc-backups', () => ide.minecraft.backups.open(srv), tr('Back up the world, or put an earlier one back')));
      actions.append(button(tr('Open Folder'), 'mc-folder', () => ide.api.invoke('shell:openPath', srv.dir)));
      if (!busyAt(srv.dir)) actions.append(button(tr('Delete…'), 'mc-delete', () => deleteServer(srv), tr('Moves the server folder to the Recycle Bin')));
      const info = srv.proxy ? tr('Players join this proxy and are sent on to the project\'s Paper and Purpur servers.')
        : srv.plugins ? tr('Plugins run on the server: players need nothing.')
          : srv.autoSync ? tr('AutoModpack is on: players import the Client Pack once, then get the server\'s mods, and every change to them, when they join.')
            : srv.mods ? tr('Players need the same mods: share the Client Pack.') : '';
      card.append(head, actions, ...(ide.minecraft.health?.panels(srv) || []));
      if (tunnel) card.append(publicRow(srv, tunnel));
      if (running) card.append(...lanRows(srv));
      card.append(el('div', 'mc-server-note muted', info));
      host.append(card);
    }
    for (const srv of damaged) host.append(damagedCard(srv));
  }
  // A server whose pyide-server.json cannot be used: it cannot start, but one running still stops, and its folder opens
  // for the file to be fixed.
  function damagedCard(srv) {
    const card = el('div', 'mc-server mc-damaged');
    card.dataset.name = srv.name;
    card.dataset.dir = srv.dir;
    const head = el('div', 'mc-server-head');
    const title = el('span', 'mc-server-name', srv.name);
    title.dataset.userText = '';
    head.append(el('span', `mc-dot${runningAt(srv.dir) ? ' on' : ''}`), title, el('span', 'mcc-chip bad mc-damaged-chip', tr('Damaged')));
    const actions = el('div', 'mc-server-actions');
    if (stoppingAt(srv.dir)) actions.append(Object.assign(button(tr('Stopping…'), 'mc-stopping', () => {}), { disabled: true }));
    else if (runningAt(srv.dir)) actions.append(button(tr('Stop'), 'mc-stop', () => sessionOf(srv.dir)?.stop()));
    // Repair only where it has something to go on (srv.repair): a server type from elsewhere with no jar Nano Studio
    // knows can only be fixed by hand.
    if (srv.repair) actions.append(button(tr('Repair'), 'mc-repair', () => repairServer(srv), tr('Puts back the copy Nano Studio saved last, or reads the server type again from its files. The damaged file is kept as pyide-server.json.damaged.')));
    actions.append(button(tr('Open Folder'), 'mc-folder', () => ide.api.invoke('shell:openPath', srv.dir)));
    const kind = { kind: srv.kind ?? '—' };
    const why = el('div', 'mc-server-note muted mc-damaged-why', srv.damaged === 'kind'
      ? (srv.repair ? tr('Its pyide-server.json names a server type Nano Studio does not know ({kind}). Repair it, or open the folder to fix it.', kind)
        : tr('Its pyide-server.json names a server type Nano Studio does not know ({kind}). Open the folder to fix it.', kind))
      : srv.repair ? tr('Its pyide-server.json cannot be read. Repair it, or open the folder to fix it.')
        : tr('Its pyide-server.json cannot be read. Open the folder to fix it.'));
    card.append(head, actions, why);
    return card;
  }

  async function repairServer(srv) {
    if (!trusted()) return;
    try {
      if (!(await ide.minecraft.backups.before(srv, 'repair'))) return;
      const r = await ide.api.invoke('minecraft:repairServer', ide.root, srv.dir);
      ide.notifications?.notify({ title: tr('{name} repaired', { name: srv.name }), group: 'Minecraft', kind: 'ok', raw: true,
        text: r.from === 'backup' ? tr('Its pyide-server.json is the copy Nano Studio saved last. The damaged one is pyide-server.json.damaged.')
          : tr('Its pyide-server.json was written again from what the folder runs, with the default memory. The damaged one is pyide-server.json.damaged.') });
    } catch (err) { ide.ui.alert(errorText(err)); }
    await refresh();
  }

  // What other computers on the same network connect to: no sharing, no third party.
  function lanRows(srv) {
    const port = portAt(srv);
    const addresses = (listening.find((p) => p.port === port)?.lan || []).map((ip) => `${ip}:${port}`);
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
        button(tr('Stop Sharing'), 'mc-public-stop', () => ide.ports.unshare(tunnel.port)),
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
        button(tr('Stop Sharing'), 'mc-public-stop', () => ide.ports.unshare(tunnel.port)));
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
      const code = await (tunnel.private ? ide.api.invoke('minecraft:privateCode', ide.root, srv.dir, { pack, port: tunnel.port })
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
      // A proxy that checks accounts itself; a proxy with its own checks off (online-mode = false in velocity.toml, as
      // one imported from elsewhere may have) is warned about as a server is.
      const proxy = !srv.proxy && list.find((s) => s.proxy && !s.offline);
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
    const port = portAt(target);
    if (tunnels.find((t) => t.port === port)?.state === 'failed') await ide.ports.unshare(port);
    await ide.ports.share(port, { private: !publicly });
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
    // The running server saves its own copy of server.properties for the command, from its start: main reads the file
    // as just saved before the command is sent, and puts it back once the server has written.
    if (runningAt(srv.dir)) {
      await ide.api.invoke('minecraft:keepProperties', ide.root, srv.dir).catch(() => {});
      sendCommand(srv.dir, 'whitelist on');
    }
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
  ide.minecraft = { refresh, servers: () => list, newServer, createServer, newFromModpack, createFromModpack, dropped, clientPack, autoSync, deleteServer, serverSettings, sendCommand, translateKorean, runTranslation, sharePack, resourcePack, sendPack,
    job, jobSession, errorText, kindTitle, runningAt, stoppingAt, restartIfRunning, startServer: (srv) => launchOnce(srv, run.runConfig), render,
    // The server list (with drops) in the Minecraft screen's My Servers page.
    showServersIn(container) { acceptDrops(container); host = container; refresh(); } };

  const here = document.currentScript.src.replace(/[^/]*$/, '');
  for (const file of ['market.js', 'craft.js', 'screen.js', 'server-settings.js', 'players.js', 'health.js', 'backups.js']) {
    const script = el('script');
    script.src = `${here}${file}`;
    script.async = false;
    document.body.appendChild(script);
  }
})();
