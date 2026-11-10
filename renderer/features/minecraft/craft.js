// Nano Studio Craft's pages of the Minecraft screen (screen.js), over main/minecraft/launcher.js:
// - Play: the instances (instances/<name>, each its own game folder), played through the official Minecraft Launcher,
//   where the user signs in. New Instance (Vanilla, Fabric, Quilt, Forge, NeoForge), From Modpack (the Market's
//   modpacks, or a .mrpack file), the instance's mods turned on and off, their Korean translation, Open Folder and Delete.
// - Servers to Join: servers added by a join code (nanostudio:join?…) or an address. Join plays the server's instance
//   with the server to join, after its client pack is synced.
// A missing launcher is a banner with Mojang's download page: Nano Studio never installs it.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const LOADERS = [['vanilla', 'Vanilla'], ['fabric', 'Fabric'], ['quilt', 'Quilt'], ['forge', 'Forge'], ['neoforge', 'NeoForge']];
  const MEMORY = ['2G', '3G', '4G', '6G', '8G', '12G', '16G'];
  const loaderTitle = (k) => LOADERS.find(([id]) => id === k)?.[1] || k;
  // {play, join, joinBanner, joinList, joinGo}: the page containers, and the parts of Servers to Join that change.
  let view = null;
  let instances = [];
  let joined = []; // the saved servers to join
  let status = null; // launcher:status
  let loaded = false;
  const busy = new Set(); // instances being made, synced or played
  const joining = new Set(); // addresses of the servers Join is working on, also before they have an instance
  let adding = false;
  let launcherNote = null; // the last "launcher is open" balloon: the launcher is one window, so one balloon
  // A job's log lines also go to its progress balloon and status bar task, as the phase they belong to.
  const progress = new Map(); // job id -> (text) => void
  ide.api.on('minecraft:log', ({ job, text }) => progress.get(job)?.(text));

  // main's log lines (main/minecraft/launcher.js, the downloads of main/installer/servers.js) -> the phase the balloon
  // and the status bar show. A line matching none (a loader's own output) leaves the phase as it was; the Run tab keeps
  // the whole log.
  const PHASES = [
    [/^Checking the server's pack/, () => tr('Checking the pack…')],
    [/^The pack has not changed/, () => tr('The pack is up to date.')],
    [/^The pack could not be checked/, () => tr('The pack could not be checked: using the last synced mods.')],
    [/^\((\d+)\/(\d+)\) /, (m) => tr('Downloading mods ({n}/{total})…', { n: m[1], total: m[2] })],
    [/^Removed /, () => tr('Removing files the pack no longer has…')],
    [/the instance follows it\.$/, () => tr('Switching to the pack\'s Minecraft version…')],
    [/: \d+ files$/, () => tr('The pack is synced.')],
    [/^(Fabric|Quilt) \S+ for Minecraft /, () => tr('Installing the loader…')],
    [/^Running the .+ installer/, () => tr('Installing the loader…')],
    [/^Java \d+ is not installed/, () => tr('Downloading Java…')],
    [/^Downloading /, () => tr('Downloading…')],
    [/^(\d+) \/ (\d+) MB$/, (m) => tr('Downloading… {got} / {total} MB', { got: m[1], total: m[2] })],
    [/^\d+ MB$/, () => tr('Downloading…')],
    [/^sha256 /, () => tr('Checking the download…')],
    [/^Extracting /, () => tr('Unpacking…')],
    [/^Opening the private connection/, () => tr('Opening the private connection…')],
    [/^Starting the Minecraft Launcher/, () => tr('Opening the launcher…')],
  ];
  const phaseOf = (line) => {
    for (const [re, text] of PHASES) {
      const m = re.exec(line);
      if (m) return text(m);
    }
    return null;
  };

  // main's messages for what a user runs into here -> the UI's language.
  const ERRORS = [
    [/^Cancelled/, () => tr('Cancelled.')],
    [/^(.+) is busy with another download or Play/, (m) => tr('{name} is busy: wait for its download or Play to finish.', { name: m[1] })],
    [/^instances\/(.+) already exists/, (m) => tr('An instance named {name} already exists.', { name: m[1] })],
    [/^There is no instance/, () => tr('This instance is damaged or gone. Delete it and make it again.')],
    [/is not a server address/, () => tr('That is not a server address (host or host:port).')],
    [/not a Nano Studio join code/, () => tr('That is not a Nano Studio join code (nanostudio:join?…).')],
    [/^The join code has a damaged key/, () => tr('This join code is damaged. Ask your friend for a new one.')],
    [/^The private connection/, () => tr('The private connection could not be opened. Try again.')],
    [/^The pack is not an https address/, () => tr('A server\'s pack must have an https address.')],
    [/^The pack points at a private address/, () => tr('The pack points at a private address, so it was refused.')],
    [/^Checksum mismatch for ([^:]+)/, (m) => tr('A file of the pack is damaged ({file}), so nothing was changed. Try again later.', { file: m[1] })],
    [/^The pack (is not a Modrinth|has a damaged|names|gives no)/, () => tr('The pack cannot be used: it is damaged or not a Modrinth modpack. Ask for a new join code.')],
    [/is larger than the \d+ MB allowed/, () => tr('A file of the pack is larger than it says, so it was not downloaded.')],
    [/plays release versions only/, () => tr('Nano Studio Craft plays release versions only.')],
    [/^Download refused: /, () => tr('The pack\'s address leads somewhere it may not, so it was not downloaded.')],
    [/is refused: its entries overlap/, () => tr('This archive was refused: its contents overlap, as in a zip bomb.')],
    [/^(.+) is in use: close Minecraft/, (m) => tr('{file} is in use. Close Minecraft and try again.', { file: m[1] })],
    [/\bEBUSY\b/, () => tr('A file is in use. Close Minecraft and try again.')],
    [/^Not enough disk space: (\d+) MB needed, (\d+) MB free/, (m) => tr('There is not enough disk space: {need} MB needed, {free} MB free.', { need: m[1], free: m[2] })],
    [/\bENOSPC\b/, () => tr('The disk is full. Free some space and try again.')],
    [/^The (\w+) .+ has no client install without its window/, (m) => tr('This {loader} version cannot be installed without its own window. Choose a newer version.', { loader: m[1] })],
    [/^(\w+) has no loader for Minecraft (.+)$/, (m) => tr('{loader} has no version for Minecraft {mc}.', { loader: m[1], mc: m[2] })],
    [/^The Minecraft Launcher could not be started: (.+)$/, (m) => tr('The Minecraft Launcher could not be started: {error}', { error: m[1] })],
    [/^(.+) is being played: close Minecraft first/, (m) => tr('{name} is being played. Close Minecraft first: the game writes its options.txt when it closes.', { name: m[1] })],
    [/^Launch the instance once first: the resource pack format/, () => tr('Launch the instance once first: the resource pack needs the Minecraft the launcher downloads.')],
    [/^Korean translation needs Minecraft 1\.13 or later/, () => tr('Korean translation needs Minecraft 1.13 or later: older mods keep their text in another format.')],
    [/^(.+) is not valid JSON: fix it, or move it away, before translating/, (m) => tr('{file} is not valid JSON. Fix it or move it away, then translate again: Nano Studio does not write over its lines.', { file: m[1] })],
  ];
  function errorText(err) {
    const text = mc.errorText(err);
    for (const [re, say] of ERRORS) {
      const m = re.exec(text);
      if (m) return say(m);
    }
    return networkText(text) || text;
  }
  const cancelled = (err) => /^Cancelled/.test(mc.errorText(err));
  // A failed job's message in its Run tab, and in a balloon unless the user cancelled it.
  function jobFailed(job, title, err) {
    const text = errorText(err);
    job.con.append(`${text}\n`, cancelled(err) ? undefined : 'err');
    if (!cancelled(err)) ide.notifications?.notify({ title, text, kind: 'error', group: 'Minecraft', raw: true });
  }
  // A download or a version list that could not be fetched: main says "<url>: <cause>" (sources.js) or the download's
  // own message (installer/servers.js).
  function networkText(text) {
    const host = /https?:\/\/([^/\s]+)/.exec(text)?.[1] || null;
    const status = /\bHTTP (\d{3})\b/.exec(text)?.[1];
    if (status) return host ? tr('{host} answered with an error (HTTP {status}). Try again later.', { host, status }) : tr('The server answered with an error (HTTP {status}). Try again later.', { status });
    if (!/fetch failed|bad port|no answer within|stalled|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up|UND_ERR|other side closed/i.test(text)) return null;
    return host ? tr('Could not connect to {host}. Check the internet connection and try again.', { host }) : tr('Could not connect. Check the internet connection and try again.');
  }
  const trusted = () => (ide.trusted === false ? (ide.ui.alert(tr('The project is open in Safe Mode, where Nano Studio runs nothing from it.')), false) : true);

  // ---------- data ----------
  async function refresh() {
    if (!ide.root) { instances = []; joined = []; status = null; return render(); }
    [status, instances, joined] = await Promise.all([
      ide.api.invoke('launcher:status', ide.root).catch(() => null),
      ide.api.invoke('launcher:instances', ide.root).catch(() => []),
      ide.api.invoke('launcher:servers', ide.root).catch(() => []),
    ]);
    loaded = true;
    render();
  }
  const playableInstance = (srv) => instances.find((i) => i.name === srv.instance && !i.damaged) || null;

  // A job: its log in a Run tab, its phase in a balloon and the status bar while it runs.
  function startJob(runTitle, title) {
    const con = mc.jobSession(runTitle);
    const j = mc.job(con);
    const task = ide.tasks?.start({ title });
    const note = ide.notifications?.notify({ title, text: tr('Starting…'), group: 'Minecraft', timeout: 0, raw: true,
      actions: [{ label: tr('Cancel'), run: () => ide.api.invoke('minecraft:cancel', j.id) }] });
    progress.set(j.id, (text) => {
      const phase = String(text).split('\n').map((l) => phaseOf(l.trim())).filter(Boolean).pop();
      if (!phase) return;
      task?.update({ text: phase });
      const t = note?.balloon?.querySelector('.ide-balloon-text');
      if (t) t.textContent = phase;
    });
    return {
      id: j.id, con,
      end() { progress.delete(j.id); task?.done(); note?.expire(); j.done(); },
    };
  }

  // ---------- Play ----------
  // server: {address, name?, pack?} to join, or null for the main menu. approve: the SHA-1 of a pack the user agreed to.
  async function play(name, server = null, approve = null) {
    if (!trusted() || busy.has(name)) return null;
    let approval = null;
    const title = instances.find((i) => i.name === name)?.title || name;
    busy.add(name);
    render();
    const job = startJob(tr('Play {name}', { name: title }), server ? tr('Getting {name} ready to join {server}…', { name: title, server: server.name || server.address })
      : tr('Getting {name} ready to play…', { name: title }));
    try {
      const r = await ide.api.invoke('launcher:play', ide.root, name, server ? { server, approve } : {}, job.id);
      if (r.needsApproval) { approval = r.needsApproval; return r; }
      if (r.launched === false && r.code === 'noLauncher') {
        status = { ...(status || {}), launcher: null, download: r.download };
        job.con.append(`${tr('The official Minecraft Launcher is not installed.')}\n`, 'err');
        noLauncher(r.download);
        return r;
      }
      if (r.launched === false && r.code === 'needsCode') {
        const text = tr('This computer could not keep the key of {server}. Paste its join code into Servers to Join again.', { server: server.name || server.address });
        job.con.append(`${text}\n`, 'err');
        ide.notifications?.notify({ title: tr('Paste the join code again'), text, kind: 'warn', group: 'Minecraft', raw: true });
        return r;
      }
      if (r.launched === false && r.code === 'privateGone') {
        const text = tr('{server} is no longer a private server in Servers to Join, so it was not joined. Add it again with its join code.', { server: server.name || server.address });
        job.con.append(`${text}\n`, 'err');
        ide.notifications?.notify({ title: tr('{server} could not be joined', { server: server.name || server.address }), text, kind: 'warn', group: 'Minecraft', raw: true });
        return r;
      }
      const opened = r.alreadyOpen ? tr('The launcher was already open. If the profile does not show, close the launcher and press Launch again.') : tr('Sign in to the launcher and press Play.');
      const hint = r.private ? `${opened} ${tr('Keep Nano Studio Craft open while you play.')}` : opened;
      job.con.append(`${hint}\n`, 'ok');
      launcherNote?.remove();
      launcherNote = ide.notifications?.notify({ title: tr('The Minecraft Launcher is open'), text: hint, kind: 'ok', group: 'Minecraft' });
      if (r.packStale) {
        ide.notifications?.notify({ title: tr('The server\'s pack could not be checked'), text: tr('Playing with the mods of the last sync. If the server refuses them, ask its owner for a new join code.'), kind: 'warn', group: 'Minecraft' });
      }
      return r;
    } catch (err) {
      jobFailed(job, tr('{name} could not be started', { name: title }), err);
      return null;
    } finally {
      job.end();
      busy.delete(name);
      await refresh();
      if (approval && await confirmPack(server.name || server.address, approval)) await play(name, server, approval.sha1);
    }
  }
  // What a server's pack installs and from where, and the user's yes or no: main applies nothing before it. Cancel is
  // the default, so the Enter that added a join code cannot answer this too.
  function confirmPack(server, a) {
    return new Promise((resolve) => {
      let yes = false;
      const list = el('div', 'mcc-mods');
      for (const m of a.mods) {
        const row = el('div', 'mcc-mod');
        const name = el('span', 'mcc-mod-name', m.file.replace(/^mods\//, ''));
        name.dataset.userText = '';
        row.append(name);
        if (a.update && m.added) row.append(el('span', 'mcc-chip sync', tr('New mod')));
        if (m.inPack) row.append(el('span', 'mcc-chip bad', tr('Inside the pack')));
        list.append(row);
      }
      if (!a.mods.length) list.append(el('div', 'mcc-mods-empty muted', tr('This pack has no mods.')));
      const facts = [a.update ? tr('{server} changed what it installs. The new pack comes from {host}.', { server, host: a.host }) : tr('{server} installs what is listed here from {host}.', { server, host: a.host }),
        tr('Mods run as programs on this computer, with your account\'s rights: install them only if you trust this server\'s owner.')];
      if (a.mods.some((m) => m.inPack)) facts.push(tr('Files marked Inside the pack are not checked against Modrinth or any other source.'));
      if (a.autoModpack) facts.push(tr('This pack has AutoModpack: the server can send more mods when you join, without asking here.'));
      if (a.others) facts.push(tr('It also changes {count} other files, such as settings.', { count: a.others }));
      const body = el('div', 'mc-dialog mcc-review');
      body.append(...facts.map((text) => el('div', 'mc-dialog-note', text)), list);
      ide.ui.dialog({
        title: tr('Install This Server\'s Mods?'), body, width: 600, onClose: () => resolve(yes),
        buttons: [
          { label: tr('Install'), run: () => { yes = true; return true; } },
          { label: tr('Cancel'), primary: true },
        ],
      });
    });
  }
  function noLauncher(download) {
    render();
    ide.ui.dialog({
      title: tr('The official Minecraft Launcher is needed'),
      body: el('div', 'dialog-message', tr('Nano Studio Craft starts the game through the official Minecraft Launcher, where you sign in with your Microsoft account. Install it from Mojang\'s download page, then press Launch again.')),
      buttons: [
        { label: tr('Open the Download Page'), primary: true, run: () => { ide.api.invoke('shell:openExternal', download || status?.download); } },
        { label: tr('Close') },
      ],
    });
  }

  // ---------- dialogs ----------
  function form(rows, error = el('div', 'mc-dialog-error')) {
    const body = el('div', 'mc-dialog');
    for (const [label, control] of rows) {
      if (!label) { body.append(control); continue; }
      const r = el('label', 'mc-dialog-row');
      r.append(el('span', 'mc-dialog-label', label), control);
      body.append(r);
    }
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
  // The loader, its Minecraft versions and its own versions (the recommended one chosen), for New Instance and for a
  // server added by its address alone.
  function versionFields(prefix, error) {
    const loader = select(`${prefix}Loader`, LOADERS, 'fabric');
    const version = select(`${prefix}Version`, []);
    const loaderVersion = select(`${prefix}LoaderVersion`, []);
    const loaderRow = el('label', 'mc-dialog-row');
    loaderRow.append(el('span', 'mc-dialog-label', tr('Loader version:')), loaderVersion);
    let seq = 0;
    let wanted = null; // the Minecraft version prefill asks for, once its list is here
    let touched = false;
    const loadLoaderVersions = async () => {
      const mine = ++seq;
      loaderRow.classList.toggle('hidden', loader.value === 'vanilla');
      loaderVersion.replaceChildren();
      if (loader.value === 'vanilla' || !version.value) return;
      loaderVersion.add(new Option(tr('Loading…'), ''));
      try {
        const r = await ide.api.invoke('launcher:loaderVersions', loader.value, version.value);
        if (mine !== seq) return;
        loaderVersion.replaceChildren(...r.versions.map((v) => new Option(v === r.recommended ? tr('{version} (recommended)', { version: v }) : v, v)));
        if (r.recommended) loaderVersion.value = r.recommended;
        if (!r.versions.length) loaderVersion.add(new Option(tr('None for this Minecraft version'), ''));
      } catch (err) {
        if (mine !== seq) return;
        loaderVersion.replaceChildren(new Option(tr('Could not load the versions'), ''));
        error.textContent = errorText(err);
      }
    };
    const loadVersions = async () => {
      const mine = ++seq;
      version.replaceChildren(new Option(tr('Loading…'), ''));
      version.disabled = true;
      try {
        const vs = await ide.api.invoke('launcher:versions', loader.value);
        if (mine !== seq) return;
        version.replaceChildren(...vs.map((v) => new Option(v, v)));
        if (vs.includes(wanted)) version.value = wanted;
      } catch (err) {
        if (mine !== seq) return;
        version.replaceChildren(new Option(tr('Could not load the versions'), ''));
        error.textContent = errorText(err);
      }
      version.disabled = false;
      loadLoaderVersions();
    };
    loader.onchange = () => { touched = true; loadVersions(); };
    version.onchange = () => { touched = true; loadLoaderVersions(); };
    loadVersions();
    return {
      rows: [[tr('Loader:'), loader], [tr('Minecraft:'), version], [null, loaderRow]],
      // What a server said it runs; a choice the user already made stays.
      prefill: (ping) => {
        if (touched) return;
        wanted = ping.mc;
        loader.value = ping.loader;
        loadVersions();
      },
      value: () => ({ loader: loader.value, mc: version.value, loaderVersion: loader.value === 'vanilla' ? null : loaderVersion.value || null }),
      ready: () => (!version.value ? tr('Choose a Minecraft version.') : loader.value !== 'vanilla' && !loaderVersion.value ? tr('Choose a {loader} version.', { loader: loaderTitle(loader.value) }) : ''),
    };
  }

  function newInstance() {
    if (!ide.root || !trusted()) return;
    const name = input('mccName', '', tr('My World'));
    const memory = select('mccMemory', MEMORY.map((m) => [m, m]), '4G');
    const error = el('div', 'mc-dialog-error');
    const versions = versionFields('mcc', error);
    const f = form([[tr('Name:'), name], ...versions.rows, [tr('Memory:'), memory],
      [null, el('div', 'mc-dialog-note muted', tr('The loader goes into the launcher\'s own folder now; Forge and NeoForge take about a minute and Java is downloaded when it is missing.'))]], error);
    ide.ui.dialog({
      title: tr('New Instance'), body: f.body, width: 520,
      buttons: [
        { label: tr('Create'), primary: true, run: () => {
          const title = name.value.trim() || tr('My World');
          const why = versions.ready() || (instances.some((i) => i.name.toLowerCase() === title.toLowerCase() || i.title === title) ? tr('An instance named {name} already exists.', { name: title }) : '');
          if (why) { f.error.textContent = why; return false; }
          createInstance({ name: title, memory: memory.value, ...versions.value() });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }
  async function createInstance(opts) {
    adding = true;
    render();
    const job = startJob(tr('New Instance'), tr('Making the instance {name}…', { name: opts.name }));
    try {
      const inst = await ide.api.invoke('launcher:create', ide.root, opts, job.id);
      job.con.append(`${tr('The instance {name} is ready.', { name: inst.title || inst.name })}\n`, 'ok');
      ready(inst);
      return inst;
    } catch (err) {
      jobFailed(job, tr('The instance could not be made'), err);
      return null;
    } finally {
      job.end();
      adding = false;
      await refresh();
    }
  }
  function ready(inst) {
    ide.notifications?.notify({
      title: tr('Instance {name} is ready', { name: inst.title || inst.name }), text: `Minecraft ${inst.mc} · ${loaderTitle(inst.loader)}${inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}`,
      kind: 'ok', group: 'Minecraft', raw: true, actions: [{ label: tr('Launch'), run: (n) => { n.expire(); play(inst.name); } }],
    });
    mc.screen?.show('play');
  }

  // A modpack as a new instance: from the Market (a Modrinth project), its address, or a .mrpack file.
  async function installPack(source, title) {
    if (!ide.root || !trusted()) return null;
    adding = true;
    render();
    const job = startJob(tr('Modpack'), tr('Installing {name}…', { name: title || source.url || source.file }));
    try {
      const inst = await ide.api.invoke('launcher:fromPack', ide.root, source, job.id);
      job.con.append(`${tr('The instance {name} is ready.', { name: inst.title || inst.name })}\n`, 'ok');
      ready(inst);
      return inst;
    } catch (err) {
      jobFailed(job, tr('The modpack could not be installed'), err);
      return null;
    } finally {
      job.end();
      adding = false;
      await refresh();
    }
  }
  async function packFile() {
    const picked = await ide.api.invoke('dialog:openFile', [{ name: 'Modrinth modpack', extensions: ['mrpack'] }]).catch(() => null);
    if (picked) installPack({ file: picked });
  }

  // While a server is being added or joined any instance may be its: main says which only after the folder has gone.
  const deletable = (inst) => !busy.has(inst.name) && !adding && !joining.size;
  async function deleteInstance(inst) {
    if (!deletable(inst)) return;
    if (!(await ide.ui.confirm(tr('Move the instance {name} (its worlds, mods and settings) to the Recycle Bin?', { name: inst.title || inst.name }),
      { title: tr('Delete Instance'), ok: tr('Delete') }))) return;
    try {
      // The folder first: a game still running refuses it, and the instance then stays as it was.
      await ide.api.trash(inst.dir);
      const r = await ide.api.invoke('launcher:remove', ide.root, inst.name);
      if (r?.alreadyOpen) ide.ui.alert(tr('{name} is deleted, but the Minecraft Launcher stayed open, so it may keep the profile. If the launcher still lists it, delete it there.', { name: inst.title || inst.name }));
    } catch (err) {
      ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: inst.title || inst.name, error: errorText(err) }));
    }
    await refresh();
  }

  // The instance's mods/, each turned on or off (.jar.disabled, which loaders skip); the user's own can be removed.
  async function modsDialog(inst) {
    const list = el('div', 'mcc-mods');
    const error = el('div', 'mc-dialog-error');
    const paint = (mods) => {
      list.replaceChildren();
      if (!mods.length) list.append(el('div', 'mcc-mods-empty muted', tr('No mods yet. Put .jar files into the mods folder, or join a server whose pack has them.')));
      for (const m of mods) {
        const row = el('div', `mcc-mod${m.enabled ? '' : ' off'}`);
        row.dataset.file = m.name;
        const sw = el('label', 'mcset-switch');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = m.enabled;
        box.setAttribute('aria-label', m.name);
        box.onchange = async () => {
          error.textContent = '';
          try { paint(await ide.api.invoke('launcher:setMod', ide.root, inst.name, m.file, box.checked)); } catch (err) { error.textContent = errorText(err); box.checked = !box.checked; }
        };
        sw.append(box, el('span', 'mcset-knob'));
        const name = el('span', 'mcc-mod-name', m.name.replace(/\.jar$/i, ''));
        name.dataset.userText = '';
        row.append(sw, name);
        if (m.fromPack) row.append(el('span', 'mcc-chip', tr('From the pack')));
        row.append(el('span', 'mcc-mod-size muted', `${Math.max(1, Math.round(m.size / 1024))} KB`));
        if (!m.fromPack) {
          const rm = el('button', 'secondary mcc-mod-remove', tr('Remove'));
          rm.onclick = async () => {
            try { await ide.api.trash(m.path); paint(await ide.api.invoke('launcher:mods', ide.root, inst.name)); } catch (err) { error.textContent = errorText(err); }
            refresh();
          };
          row.append(rm);
        }
        list.append(row);
      }
    };
    try { paint(await ide.api.invoke('launcher:mods', ide.root, inst.name)); } catch (err) { error.textContent = errorText(err); }
    const body = el('div', 'mc-dialog');
    body.append(el('div', 'mc-dialog-note muted', tr('Mods the server\'s pack installed come back with its next sync if removed: turn them off instead, and they stay off.')), list, error);
    ide.ui.dialog({
      title: tr('Mods of {name}', { name: inst.title || inst.name }), body, width: 600,
      onClose: refresh,
      buttons: [
        { label: tr('Open Mods Folder'), run: () => { ide.api.invoke('shell:openPath', `${inst.dir}\\mods`); return false; } },
        { label: tr('Close'), primary: true },
      ],
    });
  }

  // ---------- Korean translation ----------
  // The instance's mods into Korean, as a server's settings tab does (index.js runTranslation), into a resource pack of
  // its own (resourcepacks/Nano Studio Korean) that its options.txt turns on. The game reads options.txt when it starts.
  async function translateInstance(inst) {
    const name = inst.title || inst.name;
    return mc.runTranslation({
      key: inst.dir.toLowerCase(), name,
      run: (id) => ide.api.invoke('launcher:translateMods', ide.root, inst.name, id),
      failed: (text) => { const t = errorText(text); return t === text ? null : t; },
      done: (r, extra) => {
        const on = r.enabled === 'added' || r.enabled === 'on' ? tr('It applies from the next game start: choose 한국어 in the game\'s Language settings if it is not already.')
          : r.enabled === 'pending' ? tr('Minecraft is running, so the pack is turned on at the next Launch here.')
            : r.enabled === 'damaged' ? tr('options.txt could not be read, so the pack is not turned on: turn on Nano Studio Korean in the game\'s Resource Packs.') : '';
        if (!r.translated && r.enabled !== 'added' && r.enabled !== 'pending') return null;
        const lines = r.translated ? tr('{count} lines, in the instance\'s resource pack Nano Studio Korean; edit a line there and it is kept.', { count: r.translated }) : tr('The Korean resource pack is turned on.');
        return { text: [lines, on, extra].filter(Boolean).join(' '), kind: r.enabled === 'damaged' ? 'warn' : 'ok',
          actions: r.files.length ? [{ label: tr('Open File'), run: () => ide.openFile?.(r.files[0].file) }] : [] };
      },
    });
  }
  function koreanDialog(inst) {
    if (!trusted()) return;
    const status = el('div', 'mcc-korean-status muted', tr('Looking for text without Korean…'));
    const go = el('button', 'primary mcc-korean-run', tr('Translate to Korean'));
    go.disabled = true;
    const count = () => ide.api.invoke('launcher:langStatus', ide.root, inst.name).then((st) => {
      const todo = st.mods.filter((m) => m.missing);
      const off = !st.missing && st.lines > 0 && st.enabled === false;
      status.textContent = !st.mods.length ? tr('No mod in mods/ has English text to translate.')
        : st.missing ? tr('{lines} lines in {mods} of the {count} mods have no Korean yet.', { lines: st.missing, mods: todo.length, count: st.mods.length })
          : off ? `${tr('Every line of the {count} mods has Korean.', { count: st.mods.length })} ${tr('The Korean resource pack is not on in this instance yet.')}`
            : tr('Every line of the {count} mods has Korean.', { count: st.mods.length });
      status.title = todo.map((m) => `${m.jar}: ${m.missing}/${m.total}`).join('\n');
      go.textContent = off ? tr('Turn On the Korean Pack') : tr('Translate to Korean');
      go.disabled = !st.missing && !off;
    }, (err) => { status.textContent = errorText(err); go.disabled = true; });
    go.onclick = async () => {
      go.disabled = true;
      await translateInstance(inst);
      count();
    };
    count();
    const body = el('div', 'mc-dialog mcc-korean');
    body.append(status, go, el('div', 'mc-dialog-note muted', tr('Claude (your Claude Code) writes the lines into the instance\'s resource pack, resourcepacks/Nano Studio Korean, and turns it on in its options.txt. The game reads that file when it starts, so the Korean applies from the next game start. Lines already there, and your edits, are kept.')));
    ide.ui.dialog({ title: tr('Korean Translation of {name}', { name: inst.title || inst.name }), body, width: 560, buttons: [{ label: tr('Close'), primary: true }] });
  }

  // ---------- Servers to Join ----------
  // What a pasted code would do that needs a yes. Cancel is the default, so the Enter that added the code cannot answer.
  function confirmCode({ kind, address, name }) {
    const asks = {
      localAddress: [tr('Use a Local Address?'), tr('This join code points at {address}, which is this computer or its own network, not a server on the internet. Continue only if you expected that: a code from someone else could be aiming at another program here.', { address }), tr('Use This Address')],
      newKey: [tr('Replace the Private Key?'), tr('{server} is saved with a different private key. Replace it only if the owner shared the server again and sent you this code.', { server: name }), tr('Replace the Key')],
      noKey: [tr('Make This Server Public?'), tr('This join code has no key. {server} would stop being private, and Join would connect without encryption. Continue only if the owner told you it is public now.', { server: name }), tr('Make It Public')],
    };
    const [title, text, ok] = asks[kind];
    return new Promise((resolve) => {
      let yes = false;
      const body = el('div', 'mc-dialog mcc-code-ask');
      body.dataset.kind = kind;
      body.append(el('div', 'mc-dialog-note', text));
      ide.ui.dialog({
        title, body, width: 520, onClose: () => resolve(yes),
        buttons: [
          { label: ok, run: () => { yes = true; return true; } },
          { label: tr('Cancel'), primary: true },
        ],
      });
    });
  }
  // A join code or an address -> {server, instance}; an address without a pack asks for the version and loader first.
  async function connect(req, label) {
    const job = startJob(tr('Join'), tr('Adding {server}…', { server: label }));
    let r;
    try {
      r = await ide.api.invoke('launcher:join', ide.root, req, job.id);
    } catch (err) {
      job.con.append(`${errorText(err)}\n`, 'err');
      throw err;
    } finally { job.end(); }
    if (r.needsConfirm) return (await confirmCode(r.needsConfirm)) ? connect({ ...req, confirmed: [...(req.confirmed || []), r.needsConfirm.kind] }, label) : null;
    if (r.needsApproval) return (await confirmPack(label, r.needsApproval)) ? connect({ ...req, approve: r.needsApproval.sha1 }, label) : null;
    if (!r.needsVersion) return r;
    const more = await askVersion(r.server, req);
    return more ? connect({ ...req, name: r.server.name, ...more }, label) : null;
  }
  // req: what was asked to be added. A private server's public port answers only through its join code.
  function askVersion(server, req) {
    return new Promise((resolve) => {
      let answer = null;
      const error = el('div', 'mc-dialog-error');
      const versions = versionFields('mccJoin', error);
      const said = el('div', 'mc-dialog-note muted mcc-ping', tr('Asking the server what it runs…'));
      const f = form([[null, el('div', 'mc-dialog-note', tr('{server} gave no pack: choose the Minecraft version and loader the server runs. Ask its owner for a join code to have the mods synced too.', { server: server.name || server.address }))],
        [null, said], ...versions.rows], error);
      ide.api.invoke('launcher:ping', req.code || server.address).catch(() => ({ online: false })).then((r) => {
        if (!r.online) said.textContent = tr('The server did not answer, so choose them yourself.');
        else if (!r.mc) said.textContent = tr('The server answered without its version, so choose them yourself.');
        else {
          said.textContent = tr('The server says Minecraft {mc}, {loader}. Fabric and Quilt servers do not say, so change it if you know better.', { mc: r.mc, loader: loaderTitle(r.loader) });
          versions.prefill(r);
        }
      });
      ide.ui.dialog({
        title: tr('Server Version'), body: f.body, width: 520, onClose: () => resolve(answer),
        buttons: [
          { label: tr('Add'), primary: true, run: () => {
            const why = versions.ready();
            if (why) { f.error.textContent = why; return false; }
            answer = versions.value();
            return true;
          } },
          { label: tr('Cancel') },
        ],
      });
    });
  }
  async function addServer(text, error) {
    const value = text.trim();
    error.textContent = '';
    if (!value || adding || !trusted()) return false;
    let req = { address: value };
    let label = value;
    // Any spelling of a code goes this way: as an address its text would reach the job's log, key included.
    if (/nanostudio:/i.test(value)) {
      try {
        const code = await ide.api.invoke('launcher:parseJoinCode', value);
        req = { code: value };
        label = code.name || code.address;
      } catch (err) { error.textContent = errorText(err); return false; }
    }
    adding = true;
    render();
    try {
      const r = await connect(req, label);
      if (!r) return false;
      const synced = r.stale ? tr('Its pack could not be checked, so the mods of the last sync stay.') : tr('Its mods were synced into the instance {name}.', { name: r.instance.title || r.instance.name });
      ide.notifications?.notify({
        title: tr('{server} added', { server: r.server.name }), text: r.server.pack ? synced : r.server.address,
        kind: 'ok', group: 'Minecraft', raw: true, actions: [{ label: tr('Join'), run: (n) => { n.expire(); joinServer(r.server); } }],
      });
      return true;
    } catch (err) {
      if (!cancelled(err)) error.textContent = errorText(err);
      return false;
    } finally {
      adding = false;
      await refresh();
    }
  }
  // Join: the server's instance (made first when it has none, or it was deleted), played with the server to join.
  async function joinServer(srv) {
    if (!trusted() || joining.has(srv.address)) return;
    joining.add(srv.address);
    render();
    try {
      let name = playableInstance(srv)?.name || null;
      if (!name) {
        try {
          const r = await connect({ address: srv.address, pack: srv.pack || undefined, name: srv.name }, srv.name);
          if (!r) return;
          name = r.instance.name;
          await refresh();
        } catch (err) {
          if (!cancelled(err)) ide.notifications?.notify({ title: tr('{server} could not be joined', { server: srv.name }), text: errorText(err), kind: 'error', group: 'Minecraft', raw: true });
          return;
        }
      }
      await play(name, { address: srv.address, name: srv.name, ...(srv.pack ? { pack: srv.pack } : {}) });
    } finally {
      joining.delete(srv.address);
      render();
    }
  }
  async function removeServer(srv) {
    if (!(await ide.ui.confirm(tr('Remove {server} from the servers to join? Its instance stays on the Play page.', { server: srv.name }), { title: tr('Remove Server'), ok: tr('Remove') }))) return;
    try {
      await ide.api.invoke('launcher:saveServers', ide.root, joined.filter((s) => s !== srv));
    } catch (err) { ide.ui.alert(errorText(err)); }
    await refresh();
  }
  async function copyCode(srv) {
    try {
      const code = await ide.api.invoke('launcher:joinCode', { address: srv.address, pack: srv.pack || undefined, name: srv.name });
      await ide.api.invoke('clipboard:writeText', code);
      ide.notifications?.notify({ title: tr('Join code copied'), text: tr('Friends paste it into Servers to Join in Nano Studio Craft.'), kind: 'ok', group: 'Minecraft' });
    } catch (err) { ide.ui.alert(errorText(err)); }
  }

  // ---------- pages ----------
  function button(label, cls, onClick, icon) {
    const b = el('button', cls);
    if (icon) b.append(ide.icon(icon));
    b.append(el('span', null, label));
    b.onclick = (e) => { e.preventDefault(); onClick(b); };
    return b;
  }
  function head(title, sub, ...tools) {
    const h = el('div', 'mcc-head');
    const text = el('div', 'mcc-head-text');
    text.append(el('div', 'mcc-title', title), el('div', 'mcc-sub muted', sub));
    const t = el('div', 'mcc-tools');
    t.append(...tools);
    h.append(text, t);
    return h;
  }
  function banner() {
    if (!status || status.launcher) return null;
    const b = el('div', 'mcc-banner');
    const text = el('div', 'mcc-banner-text');
    text.append(el('div', 'mcc-banner-title', tr('The official Minecraft Launcher is needed')),
      el('div', 'mcc-banner-sub', tr('The game starts through the official launcher, where you sign in. Install it, then press Check Again.')));
    b.append(ide.icon('warning'), text,
      button(tr('Open the Download Page'), 'primary mcc-download', () => ide.api.invoke('shell:openExternal', status.download)),
      button(tr('Check Again'), 'secondary mcc-recheck', () => refresh()));
    return b;
  }
  const when = (iso) => {
    const t = Date.parse(iso || '');
    if (!t) return tr('Not played yet');
    const s = (t - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: 'auto' });
    for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
    }
    return tr('Just now');
  };

  function renderPlay(host) {
    host.replaceChildren(head(tr('Play Minecraft'), tr('Your instances, each with its own mods, worlds and settings. Launch opens the official launcher with it.'),
      button(tr('New Instance…'), 'primary mcc-new', newInstance, 'add'),
      button(tr('From Modpack'), 'secondary mcc-from-pack', () => mc.market.open({ type: 'modpack' }), 'package'),
      button(tr('.mrpack File…'), 'secondary mcc-pack-file', packFile, 'folder')));
    const b = banner();
    if (b) host.append(b);
    if (!loaded) return host.append(el('div', 'mcc-empty muted', tr('Loading…')));
    if (!instances.length) {
      const empty = el('div', 'mcc-empty');
      empty.append(el('div', 'mcc-empty-title', tr('No instances yet')),
        el('div', 'muted', tr('Make one with the Minecraft version and loader you want, install a modpack, or add a server to join.')));
      return host.append(empty);
    }
    const grid = el('div', 'mcc-grid');
    for (const inst of instances) grid.append(instanceCard(inst));
    host.append(grid);
  }
  // Icons, named by their tooltip, so the card's actions fit on one row in a two-column grid at 900 px.
  function iconButton(icon, label, cls, onClick) {
    const b = el('button', `secondary mcc-icon ${cls}`);
    b.append(ide.icon(icon));
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = (e) => { e.preventDefault(); onClick(); };
    return b;
  }
  function deleteButton(inst) {
    const del = iconButton('clear', tr('Delete…'), 'mcc-delete', () => deleteInstance(inst));
    del.disabled = !deletable(inst);
    return del;
  }
  // A folder of instances/ main cannot play: what can be done is rescuing its worlds and deleting it.
  function damagedCard(inst) {
    const c = el('div', 'mcc-card mcc-damaged');
    c.dataset.name = inst.name;
    const art = el('div', 'mcc-art');
    art.append(ide.icon('warning'));
    const body = el('div', 'mcc-card-body');
    const name = el('div', 'mcc-name', inst.title);
    name.dataset.userText = '';
    const meta = el('div', 'mcc-meta');
    meta.append(el('span', 'mcc-chip bad', tr('Damaged')));
    body.append(name, meta, el('div', 'mcc-facts muted', tr('Its settings cannot be read. Open the folder to rescue its worlds, then delete it.')));
    const actions = el('div', 'mcc-actions');
    actions.append(button(tr('Open Folder'), 'secondary mcc-folder', () => ide.api.invoke('shell:openPath', inst.dir)), deleteButton(inst));
    c.append(art, body, actions);
    return c;
  }
  function instanceCard(inst) {
    if (inst.damaged) return damagedCard(inst);
    const c = el('div', 'mcc-card');
    c.dataset.name = inst.name;
    const art = el('div', `mcc-art ${inst.loader}`);
    art.append(el('span', null, (inst.title || inst.name).slice(0, 1).toUpperCase()));
    const body = el('div', 'mcc-card-body');
    const name = el('div', 'mcc-name', inst.title || inst.name);
    name.dataset.userText = '';
    const meta = el('div', 'mcc-meta');
    meta.append(el('span', 'mcc-chip', `Minecraft ${inst.mc}`), el('span', `mcc-chip loader ${inst.loader}`, `${loaderTitle(inst.loader)}${inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}`));
    const facts = el('div', 'mcc-facts muted');
    facts.append(el('span', null, tr('{count} mods', { count: inst.mods })), el('span', null, when(inst.lastPlayed)));
    if (inst.server) {
      const s = el('span', 'mcc-server-of', inst.server.name || inst.server.address);
      s.dataset.userText = '';
      facts.append(s);
    }
    body.append(name, meta, facts);
    const actions = el('div', 'mcc-actions');
    const working = busy.has(inst.name);
    // The memory the game may use, from the next launch on. A value set by hand in instance.json stays in the list.
    const mem = select(`mccMem-${inst.name}`, [...new Set([...MEMORY, inst.memory || '4G'])].map((m) => [m, m]), inst.memory || '4G');
    mem.classList.add('mcc-memory');
    mem.title = tr('Memory the game may use, from the next launch');
    mem.setAttribute('aria-label', tr('Memory:'));
    mem.addEventListener('change', async () => {
      try {
        await ide.api.invoke('launcher:setMemory', ide.root, inst.name, mem.value);
        inst.memory = mem.value;
      } catch (err) {
        mem.value = inst.memory || '4G';
        ide.notifications?.notify({ title: tr('The memory of {name} was not changed', { name: inst.title || inst.name }), text: errorText(err), group: 'Minecraft', kind: 'error', raw: true });
      }
    });
    const playBtn = button(working ? tr('Getting Ready…') : tr('Launch'), 'primary mcc-play', () => play(inst.name), 'runRun');
    playBtn.disabled = working;
    meta.append(mem);
    actions.append(playBtn,
      button(tr('Mods'), 'secondary mcc-mods-btn', () => modsDialog(inst)),
      iconButton('web', tr('Korean Translation…'), 'mcc-korean-btn', () => koreanDialog(inst)),
      iconButton('folder', tr('Open Folder'), 'mcc-folder', () => ide.api.invoke('shell:openPath', inst.dir)), deleteButton(inst));
    c.append(art, body, actions);
    return c;
  }

  // Servers to Join's head and add form are made once per mount: a render (after any Play, Join or refresh) replaces
  // only the banner and the cards, so what is typed in the field, and an error under it, stay.
  function joinPage(host) {
    const add = el('form', 'mcc-add');
    const field = el('input', 'input mcc-add-input');
    field.id = 'mccAddServer';
    field.placeholder = tr('Join code (nanostudio:join?…) or address (play.example.com:25565)');
    const go = button(tr('Add Server'), 'primary mcc-add-btn', () => add.requestSubmit(), 'add');
    go.type = 'submit';
    const error = el('div', 'mcc-add-error');
    add.onsubmit = async (e) => {
      e.preventDefault();
      if (await addServer(field.value, error)) field.value = '';
    };
    add.append(field, go);
    const joinBanner = el('div', 'mcc-slot');
    const joinList = el('div', 'mcc-slot');
    host.replaceChildren(head(tr('Servers to Join'), tr('A friend\'s server: paste the join code they sent you, or the server\'s address. Join syncs the server\'s mods first.')),
      joinBanner, add, error, joinList);
    return { joinBanner, joinList, joinGo: go };
  }
  function renderJoin() {
    const { joinBanner, joinList, joinGo } = view;
    joinGo.disabled = adding;
    joinGo.querySelector(':scope > span:last-child').textContent = adding ? tr('Adding…') : tr('Add Server');
    joinBanner.replaceChildren(...[banner()].filter(Boolean));
    if (!loaded) return joinList.replaceChildren(el('div', 'mcc-empty muted', tr('Loading…')));
    if (!joined.length) {
      const empty = el('div', 'mcc-empty');
      empty.append(el('div', 'mcc-empty-title', tr('No servers yet')), el('div', 'muted', tr('Servers you add are kept here, each with the instance it is played with.')));
      return joinList.replaceChildren(empty);
    }
    const grid = el('div', 'mcc-grid');
    for (const srv of joined) grid.append(serverCard(srv));
    joinList.replaceChildren(grid);
  }
  function serverCard(srv) {
    const c = el('div', 'mcc-card mcc-joined');
    c.dataset.address = srv.address;
    const art = el('div', 'mcc-art server');
    art.append(ide.icon('gamepad'));
    const body = el('div', 'mcc-card-body');
    const name = el('div', 'mcc-name', srv.name);
    name.dataset.userText = '';
    const addr = el('div', 'mcc-address', srv.address);
    addr.dataset.userText = '';
    const meta = el('div', 'mcc-meta');
    if (srv.private) meta.append(el('span', 'mcc-chip private', tr('Private')));
    if (srv.pack) meta.append(el('span', 'mcc-chip sync', tr('Mods synced automatically')));
    const inst = playableInstance(srv);
    if (inst) meta.append(el('span', 'mcc-chip', `Minecraft ${inst.mc}`), el('span', `mcc-chip loader ${inst.loader}`, loaderTitle(inst.loader)));
    const facts = el('div', 'mcc-facts muted');
    facts.append(el('span', null, inst ? tr('Played with {name}', { name: inst.title || inst.name }) : tr('Its instance is made at the first Join')));
    if (srv.private) facts.append(el('span', 'mcc-private-note', srv.keyMissing ? tr('Paste its join code again to play.') : tr('Keep Nano Studio Craft open while you play.')));
    body.append(name, addr, meta, facts);
    const actions = el('div', 'mcc-actions');
    const working = joining.has(srv.address) || (!!inst && busy.has(inst.name));
    const joinBtn = button(working ? tr('Getting Ready…') : tr('Join'), 'primary mcc-join', () => joinServer(srv), 'runRun');
    joinBtn.disabled = working || adding || !!srv.keyMissing;
    actions.append(joinBtn);
    // A private server's code is a key its owner gave this friend, not one to pass on.
    if (!srv.private) actions.append(button(tr('Copy Join Code'), 'secondary mcc-copy-code', () => copyCode(srv), 'copy'));
    actions.append(button(tr('Remove…'), 'secondary mcc-remove', () => removeServer(srv)));
    c.append(art, body, actions);
    return c;
  }

  function render() {
    if (!view) return;
    renderPlay(view.play);
    renderJoin();
  }

  // screen.js gives the two page containers once per screen.
  function mount(play, join) {
    play.classList.add('mcc-page', 'mcc-play');
    join.classList.add('mcc-page', 'mcc-join-page');
    view = { play, join, ...joinPage(join) };
    render();
    refresh();
  }

  ide.on('projectOpened', () => { loaded = false; refresh(); });
  ide.on('projectClosed', () => { loaded = false; refresh(); });
  ide.registerAction({ id: 'Minecraft.NewInstance', title: tr('New Minecraft Instance…'), needsProject: true, run: newInstance });
  mc.craft = { mount, refresh, play, joinServer, addServer, newInstance, installPack, translateInstance, koreanDialog, head, button, state: () => ({ instances, servers: joined, status }) };
})();
