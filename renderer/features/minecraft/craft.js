// Nano Studio Craft's pages of the Minecraft screen (screen.js), over main/minecraft/launcher.js:
// - Play: the instances (instances/<name>, each its own game folder), played through the official Minecraft Launcher,
//   where the user signs in. New Instance (Vanilla, Fabric, Quilt, Forge, NeoForge), From Modpack (the Market's
//   modpacks, or a .mrpack file), the instance's mods turned on and off, Open Folder and Delete.
// - Servers to Join: servers added by a join code (nanostudio:join?…) or an address. Join plays the server's instance
//   with the server to join, after its client pack is synced.
// In craft mode they are the app; in code mode they are pages of the editor tab too. A missing launcher is a banner
// with Mojang's download page: Nano Studio never installs it.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const LOADERS = [['vanilla', 'Vanilla'], ['fabric', 'Fabric'], ['quilt', 'Quilt'], ['forge', 'Forge'], ['neoforge', 'NeoForge']];
  const MEMORY = ['2G', '3G', '4G', '6G', '8G', '12G'];
  const loaderTitle = (k) => LOADERS.find(([id]) => id === k)?.[1] || k;
  // {play, join, joinBanner, joinList, joinGo}: the page containers, and the parts of Servers to Join that change.
  let view = null;
  let instances = [];
  let joined = []; // the saved servers to join
  let status = null; // launcher:status
  let loaded = false;
  const busy = new Set(); // instances being made, synced or played
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
    [/^Starting the Minecraft Launcher/, () => tr('Opening the launcher…')],
  ];
  const phaseOf = (line) => {
    for (const [re, text] of PHASES) {
      const m = re.exec(line);
      if (m) return text(m);
    }
    return null;
  };

  // main's messages for what a user runs into here, in the UI's language; anything else as main said it.
  function errorText(err) {
    const text = mc.errorText(err);
    let m;
    if ((m = /^(.+) is busy with another download or Play/.exec(text))) return tr('{name} is busy: wait for its download or Play to finish.', { name: m[1] });
    if ((m = /^instances\/(.+) already exists/.exec(text))) return tr('An instance named {name} already exists.', { name: m[1] });
    if (/is not a server address/.test(text)) return tr('That is not a server address (host or host:port).');
    if (/not a Nano Studio join code/.test(text)) return tr('That is not a Nano Studio join code (nanostudio:join?…).');
    if ((m = /^Checksum mismatch for ([^:]+)/.exec(text))) return tr('A file of the pack is damaged ({file}), so nothing was changed. Try again later.', { file: m[1] });
    if ((m = /^The (\w+) .+ has no client install without its window/.exec(text))) return tr('This {loader} version cannot be installed without its own window. Choose a newer version.', { loader: m[1] });
    if ((m = /^(\w+) has no loader for Minecraft (.+)$/.exec(text))) return tr('{loader} has no version for Minecraft {mc}.', { loader: m[1], mc: m[2] });
    return networkText(text) || text;
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
  const instanceOf = (name) => instances.find((i) => i.name === name) || null;

  // A job: its log in a Run tab, its phase in a balloon and the status bar while it runs.
  function startJob(runTitle, title) {
    const con = mc.jobSession(runTitle);
    const j = mc.job(con);
    const task = ide.tasks?.start({ title });
    const note = ide.notifications?.notify({ title, text: tr('Starting…'), group: 'Minecraft', timeout: 0, raw: true });
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
  // server: {address, name?, pack?} to join, or null for the main menu.
  async function play(name, server = null) {
    if (!trusted() || busy.has(name)) return null;
    const inst = instanceOf(name);
    const title = inst?.title || name;
    busy.add(name);
    render();
    const job = startJob(tr('Play {name}', { name: title }), server ? tr('Getting {name} ready to join {server}…', { name: title, server: server.name || server.address })
      : tr('Getting {name} ready to play…', { name: title }));
    try {
      const r = await ide.api.invoke('launcher:play', ide.root, name, server ? { server } : {}, job.id);
      if (r.launched === false && r.code === 'noLauncher') {
        status = { ...(status || {}), launcher: null, download: r.download };
        job.con.append(`${tr('The official Minecraft Launcher is not installed.')}\n`, 'err');
        noLauncher(r.download);
        return r;
      }
      job.con.append(`${tr('Sign in to the launcher and press Play.')}\n`, 'ok');
      launcherNote?.remove();
      launcherNote = ide.notifications?.notify({
        title: tr('The Minecraft Launcher is open'), text: tr('Sign in to the launcher and press Play.'), kind: 'ok', group: 'Minecraft',
      });
      return r;
    } catch (err) {
      const text = errorText(err);
      job.con.append(`${text}\n`, 'err');
      ide.notifications?.notify({ title: tr('{name} could not be started', { name: title }), text, kind: 'error', group: 'Minecraft', raw: true });
      return null;
    } finally {
      job.end();
      busy.delete(name);
      await refresh();
    }
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
      } catch (err) {
        if (mine !== seq) return;
        version.replaceChildren(new Option(tr('Could not load the versions'), ''));
        error.textContent = errorText(err);
      }
      version.disabled = false;
      loadLoaderVersions();
    };
    loader.onchange = loadVersions;
    version.onchange = loadLoaderVersions;
    loadVersions();
    return {
      rows: [[tr('Loader:'), loader], [tr('Minecraft:'), version], [null, loaderRow]],
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
      const text = errorText(err);
      job.con.append(`${text}\n`, 'err');
      ide.notifications?.notify({ title: tr('The instance could not be made'), text, kind: 'error', group: 'Minecraft', raw: true });
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
      const text = errorText(err);
      job.con.append(`${text}\n`, 'err');
      ide.notifications?.notify({ title: tr('The modpack could not be installed'), text, kind: 'error', group: 'Minecraft', raw: true });
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

  async function deleteInstance(inst) {
    if (busy.has(inst.name)) return;
    if (!(await ide.ui.confirm(tr('Move the instance {name} (its worlds, mods and settings) to the Recycle Bin?', { name: inst.title || inst.name }),
      { title: tr('Delete Instance'), ok: tr('Delete') }))) return;
    try {
      await ide.api.invoke('launcher:remove', ide.root, inst.name);
      await ide.api.trash(inst.dir);
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

  // ---------- Servers to Join ----------
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
    if (!r.needsVersion) return r;
    const more = await askVersion(r.server);
    return more ? connect({ address: r.server.address, name: r.server.name, ...more }, label) : null;
  }
  function askVersion(server) {
    return new Promise((resolve) => {
      let answer = null;
      const error = el('div', 'mc-dialog-error');
      const versions = versionFields('mccJoin', error);
      const f = form([[null, el('div', 'mc-dialog-note', tr('{server} gave no pack: choose the Minecraft version and loader the server runs. Ask its owner for a join code to have the mods synced too.', { server: server.name || server.address }))],
        ...versions.rows], error);
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
    if (/nanostudio:join\?/i.test(value)) {
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
      ide.notifications?.notify({
        title: tr('{server} added', { server: r.server.name }), text: r.server.pack ? tr('Its mods were synced into the instance {name}.', { name: r.instance.title || r.instance.name }) : r.server.address,
        kind: 'ok', group: 'Minecraft', raw: true, actions: [{ label: tr('Join'), run: (n) => { n.expire(); joinServer(r.server); } }],
      });
      return true;
    } catch (err) {
      error.textContent = errorText(err);
      return false;
    } finally {
      adding = false;
      await refresh();
    }
  }
  // Join: the server's instance (made first when it has none, or it was deleted), played with the server to join.
  async function joinServer(srv) {
    if (!trusted()) return;
    let name = srv.instance && instanceOf(srv.instance) ? srv.instance : null;
    if (!name) {
      try {
        const r = await connect({ address: srv.address, pack: srv.pack || undefined, name: srv.name }, srv.name);
        if (!r) return;
        name = r.instance.name;
        await refresh();
      } catch (err) {
        ide.notifications?.notify({ title: tr('{server} could not be joined', { server: srv.name }), text: errorText(err), kind: 'error', group: 'Minecraft', raw: true });
        return;
      }
    }
    await play(name, { address: srv.address, name: srv.name, ...(srv.pack ? { pack: srv.pack } : {}) });
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
  function instanceCard(inst) {
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
    const playBtn = button(working ? tr('Getting Ready…') : tr('Launch'), 'primary mcc-play', () => play(inst.name), 'runRun');
    playBtn.disabled = working;
    // An icon, so the card's actions fit on one row in a two-column grid at 900 px.
    const del = el('button', 'secondary mcc-delete');
    del.append(ide.icon('clear'));
    del.title = tr('Delete…');
    del.setAttribute('aria-label', tr('Delete…'));
    del.onclick = (e) => { e.preventDefault(); deleteInstance(inst); };
    del.disabled = working;
    actions.append(playBtn,
      button(tr('Mods'), 'secondary mcc-mods-btn', () => modsDialog(inst)),
      button(tr('Open Folder'), 'secondary mcc-folder', () => ide.api.invoke('shell:openPath', inst.dir)), del);
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
    if (srv.pack) meta.append(el('span', 'mcc-chip sync', tr('Mods synced automatically')));
    const inst = srv.instance ? instanceOf(srv.instance) : null;
    if (inst) meta.append(el('span', 'mcc-chip', `Minecraft ${inst.mc}`), el('span', `mcc-chip loader ${inst.loader}`, loaderTitle(inst.loader)));
    const facts = el('div', 'mcc-facts muted');
    facts.append(el('span', null, inst ? tr('Played with {name}', { name: inst.title || inst.name }) : tr('Its instance is made at the first Join')));
    body.append(name, addr, meta, facts);
    const actions = el('div', 'mcc-actions');
    const working = !!inst && busy.has(inst.name);
    const joinBtn = button(working ? tr('Getting Ready…') : tr('Join'), 'primary mcc-join', () => joinServer(srv), 'runRun');
    joinBtn.disabled = working || adding;
    actions.append(joinBtn, button(tr('Copy Join Code'), 'secondary mcc-copy-code', () => copyCode(srv), 'copy'),
      button(tr('Remove…'), 'secondary mcc-remove', () => removeServer(srv)));
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
  const unmount = () => { view = null; };

  ide.on('projectOpened', () => { loaded = false; refresh(); });
  ide.on('projectClosed', () => { loaded = false; refresh(); });
  ide.registerAction({ id: 'Minecraft.NewInstance', title: tr('New Minecraft Instance…'), needsProject: true, run: newInstance });
  mc.craft = { mount, unmount, refresh, play, joinServer, addServer, newInstance, installPack, head, button, state: () => ({ instances, servers: joined, status }) };
})();
