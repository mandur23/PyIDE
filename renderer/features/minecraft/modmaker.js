// My Mods and Plugins, a page of the Minecraft screen (main/minecraft/modmaker.js): the mods (mods/<id> of the craft
// folder) and the plugins (plugins/<Name>) the user makes.
// - New Mod starts a mod from the example mod its loader's project publishes (Fabric, Forge, NeoForge), under the user's
//   mod id, name and package; its Build is its own Gradle build.
// - New Plugin writes a plugin for one of the user's Paper, Purpur or Velocity servers; its Build compiles it against
//   that server's API, which the server unpacks at its first start.
// - Build shows in a Run tab (Cancel ends it). Add to… copies the built jar into the servers (and, for a mod, the
//   instances) that take it, over an earlier build of the same mod or plugin; Add a File… does the same with a jar
//   made elsewhere.
// Both are edited in Nano Studio Code, which Edit in Code opens on the folder. A mod is tried by adding it to an
// instance and launching that: nothing here starts the game.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const LOADERS = [['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge']];
  const loaderTitle = (k) => LOADERS.find(([id]) => id === k)?.[1] || (k === 'quilt' ? 'Quilt' : k);
  const APIS = { paper: 'Paper', velocity: 'Velocity' };
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  const KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final '
    + 'finally float for goto if implements import instanceof int interface long native new package private protected public return short '
    + 'static strictfp super switch synchronized this throw throws transient try void volatile while true false null').split(' '));
  const javaPackage = (pkg) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg) && !pkg.split('.').some((w) => KEYWORDS.has(w));
  let view = null; // the page's list, once screen.js has mounted it
  let mods = []; // the mods and the plugins, as main lists them: {kind: 'mod' | 'plugin', id, ...}
  let loaded = false;
  const busy = new Set(); // keys of what is being built
  let creating = false;
  const keyOf = (m) => `${m.kind}:${m.id}`;
  // How main is told which one: a mod by its id, a plugin by its name.
  const refOf = (m) => (m.kind === 'plugin' ? { plugin: m.id } : { id: m.id });
  const kindTitle = (m) => (m.kind === 'plugin' ? tr('{api} plugin', { api: APIS[m.api] || m.api }) : loaderTitle(m.loader));
  const notify = (o) => ide.notifications?.notify({ group: 'Minecraft', raw: true, ...o });
  const trusted = () => (ide.trusted === false ? (ide.ui.alert(tr('The project is open in Safe Mode, where Nano Studio runs nothing from it.')), false) : true);

  // Main's messages in the user's words; what is not listed is shown as main wrote it (a download's own error).
  const ERRORS = [
    [/^A mod with the id (\S+) already exists/, (m) => tr('A mod with the id {id} already exists.', { id: m[1] })],
    [/^mods\/(\S+) is a folder that is not a mod/, (m) => tr('mods/{id} is a folder that is not a mod: choose another id, or move that folder away.', { id: m[1] })],
    [/^A plugin named (\S+) already exists/, (m) => tr('A plugin named {name} already exists.', { name: m[1] })],
    [/^plugins\/(\S+) is a folder that is not a plugin/, (m) => tr('plugins/{name} is a folder that is not a plugin: choose another name, or move that folder away.', { name: m[1] })],
    [/^(\w+) has no mod template for Minecraft (\S+)/, (m) => tr('{loader} has no mod template for Minecraft {mc}. Choose another version.', { loader: m[1], mc: m[2] })],
    [/^Forge has no build for (\S+)/, (m) => tr('{loader} has no mod template for Minecraft {mc}. Choose another version.', { loader: 'Forge', mc: m[1] })],
    [/^The mod template has no gradlew\.bat/, () => tr('The template that was downloaded is not a mod project. Try another version.')],
    [/needs a (\w+) server to be built against/, (m) => tr('There is no {api} server to build it against. Make one in My Servers.', { api: m[1] })],
    [/^Start (\S+) once first/, (m) => tr('Start {name} once first: a server unpacks what a plugin is built against at its first start.', { name: m[1] })],
    [/^The plugin has no \.java files/, () => tr('The plugin has no .java files in src/main/java.')],
    [/^The build failed/, () => tr('The build failed. The Run tab shows where: fix it in Nano Studio Code and build again.')],
    [/^The build finished but left no jar/, () => tr('The build finished but left no file in build/libs.')],
    [/is being built already$/, () => tr('It is being built already.')],
    [/^A JDK of Java (\d+) was not found/, (m) => tr('Java {java} (a JDK) was not found and could not be downloaded.', { java: m[1] })],
    [/^Build .* first: it has no jar yet/, () => tr('Build it first: it has no file yet.')],
    [/is not a mod or a plugin Nano Studio knows$/, () => tr('That file is not a mod or a plugin Nano Studio knows.')],
    [/^Choose a mod's or a plugin's \.jar file/, () => tr('Choose a .jar file.')],
    [/^Cancelled/, () => tr('Cancelled.')],
  ];
  function errorText(err) {
    const text = mc.errorText(err);
    for (const [re, say] of ERRORS) { const m = re.exec(text); if (m) return say(m); }
    return text;
  }
  const cancelled = (err) => /^Cancelled/.test(mc.errorText(err));
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const when = (ms) => {
    const s = (ms - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: 'auto' });
    for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
    }
    return tr('Just now');
  };

  async function refresh() {
    if (!ide.root) { mods = []; loaded = false; return render(); }
    mods = await ide.api.invoke('modmaker:list', ide.root).catch(() => []);
    loaded = true;
    render();
  }

  // A job: its log in a Run tab, a balloon with Cancel and the status bar's task while it runs.
  function startJob(runTitle, title, text) {
    const con = mc.jobSession(runTitle);
    const j = mc.job(con);
    const task = ide.tasks?.start({ title });
    const note = notify({ title, text, timeout: 0, actions: [{ label: tr('Cancel'), run: () => ide.api.invoke('minecraft:cancel', j.id) }] });
    return { id: j.id, con, end() { task?.done(); note?.expire(); j.done(); } };
  }

  // ---------- dialogs ----------
  const input = (id, value = '', placeholder = '') => { const i = el('input', 'input'); i.id = id; i.value = value; i.placeholder = placeholder; return i; };
  const select = (id, options, value) => {
    const s = el('select', 'input');
    s.id = id;
    for (const [v, label] of options) s.add(new Option(label, v));
    if (value != null) s.value = value;
    return s;
  };
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

  // ---------- New Mod ----------
  // A mod id from a name: its Latin letters and digits, lower case, the rest as _; a name without any gives none.
  const idFrom = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 32);
  // What main refuses, said while the dialog still holds what was typed.
  function refused({ name, id, pkg, mc: version }) {
    return /["\\]/.test(name) || name.length > 48 ? tr('The name may hold up to 48 characters, without " and \\.')
      : !/^[a-z][a-z0-9_]{1,63}$/.test(id) ? tr('Use lower-case letters, digits and _ for the mod id, starting with a letter (2 to 64 characters).')
        : RESERVED.test(id) ? tr('{name} is a name Windows keeps for a device: choose another.', { name: id })
          : mods.some((m) => m.kind === 'mod' && m.id === id) ? tr('A mod with the id {id} already exists.', { id })
            : !javaPackage(pkg) ? tr('Use a Java package of two or more parts, such as com.example.mymod.')
              : !version ? tr('Choose a Minecraft version.') : '';
  }
  function newMod() {
    if (!ide.root || !trusted()) return;
    const name = input('mcwName', '', tr('My Mod'));
    const id = input('mcwId', '', 'mymod');
    const pkg = input('mcwPackage', '', 'com.example.mymod');
    const loader = select('mcwLoader', LOADERS, 'fabric');
    const version = select('mcwVersion', []);
    // The id follows the name, and the package the id, until the user types their own.
    let ownId = false;
    let ownPkg = false;
    const follow = () => {
      if (!ownId) id.value = idFrom(name.value);
      if (!ownPkg) pkg.value = id.value ? `com.example.${id.value}` : '';
    };
    name.oninput = follow;
    id.oninput = () => { ownId = true; follow(); };
    pkg.oninput = () => { ownPkg = true; };
    const f = form([[tr('Name:'), name], [tr('Mod ID:'), id], [tr('Package:'), pkg], [tr('Loader:'), loader], [tr('Minecraft:'), version],
      [null, el('div', 'mc-dialog-note muted', tr('The loader\'s own example mod is downloaded and given these names. Edit it in Nano Studio Code, build it here, then add it to a server or an instance.'))]]);
    // Only the last loader's answer fills the list: a slow answer for the loader before cannot land under the new one.
    let seq = 0;
    const loadVersions = async () => {
      const mine = ++seq;
      version.replaceChildren(new Option(tr('Loading…'), ''));
      version.disabled = true;
      f.error.textContent = '';
      let vs = null;
      let failed = null;
      try { vs = await ide.api.invoke('modmaker:versions', loader.value); } catch (err) { failed = err; }
      if (mine !== seq) return;
      if (failed) {
        version.replaceChildren(new Option(tr('Could not load the versions'), ''));
        f.error.textContent = errorText(failed);
      } else version.replaceChildren(...vs.map((v) => new Option(v, v)));
      version.disabled = false;
    };
    loader.onchange = loadVersions;
    loadVersions();
    ide.ui.dialog({
      title: tr('New Mod'), body: f.body, width: 520,
      buttons: [
        { label: tr('Create'), primary: true, run: () => {
          const opts = { name: name.value.trim(), id: id.value.trim() || 'mymod', pkg: pkg.value.trim(), loader: loader.value, mc: version.value };
          if (!opts.pkg) opts.pkg = `com.example.${opts.id}`;
          const why = refused(opts);
          if (why) { f.error.textContent = why; return false; }
          createMod(opts);
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }
  // What a new mod or plugin is told with: where it is edited and how it is built.
  const createdNote = (m, text) => notify({ title: m.kind === 'plugin' ? tr('Plugin {name} created', { name: m.name }) : tr('Mod {name} created', { name: m.name }), text, kind: 'ok',
    actions: [{ label: tr('Edit in Code'), run: (n) => { n.expire(); openInCode(m); } }, { label: tr('Build'), run: (n) => { n.expire(); build(m); } }] });
  async function createMod(opts) {
    creating = true;
    render();
    const title = opts.name || opts.id;
    const job = startJob(tr('New Mod'), tr('Making the mod {name}…', { name: title }), tr('Downloading the {loader} example mod for Minecraft {mc}.', { loader: loaderTitle(opts.loader), mc: opts.mc }));
    try {
      const mod = await ide.api.invoke('modmaker:create', ide.root, opts, job.id);
      job.con.append(`${tr('The mod {name} is ready.', { name: mod.name })}\n`, 'ok');
      mc.screen?.show('mods');
      createdNote(mod, `${loaderTitle(mod.loader)} · Minecraft ${mod.mc}`);
      return mod;
    } catch (err) {
      const text = errorText(err);
      job.con.append(`${text}\n`, cancelled(err) ? undefined : 'err');
      if (!cancelled(err)) notify({ title: tr('The mod could not be made'), text, kind: 'error' });
      return null;
    } finally {
      job.end();
      creating = false;
      await refresh();
    }
  }

  // ---------- New Plugin ----------
  async function newPlugin() {
    if (!ide.root || !trusted()) return;
    const servers = await ide.api.invoke('modmaker:pluginServers', ide.root).catch(() => []);
    if (!servers.length) {
      ide.ui.dialog({
        title: tr('New Plugin'), width: 480,
        body: tr('A plugin is made for a Paper, Purpur or Velocity server, whose API it is built against. Make such a server in My Servers first.'),
        buttons: [{ label: tr('New Server…'), primary: true, run: () => { mc.screen?.show('servers'); mc.newServer(); return true; } }, { label: tr('Close') }],
      });
      return;
    }
    const name = input('mcwPluginName', '', 'MyPlugin');
    const pkg = input('mcwPluginPackage', '', 'com.example.myplugin');
    const server = select('mcwPluginServer', servers.map((s) => [s.name, `${s.name} · ${mc.kindTitle(s.kind)} ${s.mc}`]), servers[0].name);
    // The package follows the name until the user types their own.
    let ownPkg = false;
    name.oninput = () => { if (!ownPkg) pkg.value = /^[A-Za-z][A-Za-z0-9]*$/.test(name.value.trim()) ? `com.example.${name.value.trim().toLowerCase()}` : ''; };
    pkg.oninput = () => { ownPkg = true; };
    const hint = el('div', 'mc-dialog-note muted');
    const describe = () => {
      const s = servers.find((x) => x.name === server.value);
      hint.textContent = s?.ready ? tr('The plugin is built against the API of {name} and can be added to any server of the same kind.', { name: s.name })
        : tr('Start {name} once before you build: a server unpacks the API a plugin is built against at its first start.', { name: s?.name || '' });
    };
    server.onchange = describe;
    describe();
    const f = form([[tr('Name:'), name], [tr('Package:'), pkg], [tr('Server:'), server], [null, hint]]);
    ide.ui.dialog({
      title: tr('New Plugin'), body: f.body, width: 520,
      buttons: [
        { label: tr('Create'), primary: true, run: async () => {
          const opts = { name: name.value.trim(), pkg: pkg.value.trim(), server: server.value };
          const why = !/^[A-Z][A-Za-z0-9]{0,39}$/.test(opts.name) ? tr('Use a class-style name: a capital letter first, then letters and digits (40 at most).')
            : RESERVED.test(opts.name) ? tr('{name} is a name Windows keeps for a device: choose another.', { name: opts.name })
              : mods.some((m) => m.kind === 'plugin' && m.id.toLowerCase() === opts.name.toLowerCase()) ? tr('A plugin named {name} already exists.', { name: opts.name })
                : !javaPackage(opts.pkg) ? tr('Use a Java package of two or more parts, such as com.example.mymod.') : '';
          if (why) { f.error.textContent = why; return false; }
          try {
            const plugin = await ide.api.invoke('modmaker:createPlugin', ide.root, opts);
            mc.screen?.show('mods');
            await refresh();
            createdNote(plugin, tr('For {server} · {api}', { server: plugin.server, api: APIS[plugin.api] || plugin.api }));
          } catch (err) { f.error.textContent = errorText(err); return false; }
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- build ----------
  async function build(m) {
    if (busy.has(keyOf(m)) || !trusted()) return null;
    busy.add(keyOf(m));
    render();
    const job = startJob(tr('Build {name}', { name: m.name }), tr('Building {name}…', { name: m.name }),
      m.kind === 'plugin' ? tr('Compiling it against the API of your server.') : tr('The first build downloads Gradle and Minecraft, which takes several minutes.'));
    try {
      const r = await ide.api.invoke('modmaker:build', ide.root, refOf(m), job.id);
      job.con.append(`${tr('{file} is built.', { file: r.jar.name })}\n`, 'ok');
      notify({ title: tr('{name} is built', { name: m.name }), text: r.jar.name, kind: 'ok', actions: [{ label: tr('Add to…'), run: (n) => { n.expire(); addDialog(refOf(m)); } }] });
      return r;
    } catch (err) {
      const text = errorText(err);
      job.con.append(`${text}\n`, cancelled(err) ? undefined : 'err');
      if (!cancelled(err)) notify({ title: tr('{name} was not built', { name: m.name }), text, kind: 'error' });
      return null;
    } finally {
      job.end();
      busy.delete(keyOf(m));
      await refresh();
    }
  }

  // ---------- adding a mod or a plugin to servers and instances ----------
  const sourceName = (info) => info.mod.file || info.mod.name;
  // What a jar is for: its loaders, or the plugin API it is written for.
  const forWhat = (info) => (info.mod.kind === 'plugin' ? APIS[info.mod.api] || info.mod.api : info.mod.loaders.map(loaderTitle).join(', '));
  // What each place said, in one balloon: where the file went, and for a place that refused it, why.
  function report(info, results) {
    const done = results.filter((r) => r.ok);
    const refusals = results.filter((r) => !r.ok);
    const lines = [
      ...done.map((r) => `${r.title}: ${r.replaced.length ? tr('replaced') : tr('added')}${r.restart ? ` · ${tr('restart the server to load it')}` : ''}`),
      ...refusals.map((r) => `${r.title || r.name}: ${r.code === 'inUse' ? (r.type === 'server' ? tr('stop the server, then add it again') : tr('close Minecraft, then add it again')) : r.error}`),
    ];
    if (done.length) notify({ title: tr('{file} added to {n} places', { file: sourceName(info), n: done.length }), text: lines.join('\n'), kind: refusals.length ? 'warn' : 'ok' });
    else if (refusals.length) notify({ title: tr('{file} was not added', { file: sourceName(info) }), text: lines.join('\n'), kind: 'error' });
    mc.refresh?.();
    mc.craft?.refresh?.();
  }
  // source: {id} one of the user's mods, {plugin} one of their plugins, {file} a jar from elsewhere. only: {type, name},
  // the one place asked from.
  async function addDialog(source, only = null) {
    if (!ide.root || !trusted()) return;
    let info;
    try { info = await ide.api.invoke('modmaker:targets', ide.root, source); } catch (err) { ide.ui.alert(errorText(err)); return; }
    if (!info.mod.built) { ide.ui.alert(tr('Build it first: it has no file yet.')); return; }
    const plugin = info.mod.kind === 'plugin';
    const places = only ? info.list.filter((t) => t.type === only.type && t.name === only.name) : info.list;
    const what = forWhat(info);
    const body = el('div', 'mc-dialog mcw-add-dialog');
    const error = el('div', 'mc-dialog-error');
    const file = el('div', 'mcw-add-file');
    file.dataset.userText = '';
    file.append(el('span', 'mcw-add-file-name', sourceName(info)), el('span', 'mcc-chip', plugin ? tr('{api} plugin', { api: what }) : what), ...(info.mod.mc ? [el('span', 'mcc-chip', `Minecraft ${info.mod.mc}`)] : []));
    body.append(file);
    const title = plugin ? tr('Add the Plugin') : tr('Add the Mod');
    if (!places.length) {
      body.append(el('div', 'mcw-add-none muted', only ? tr('This is made for {loaders}, which this one does not run.', { loaders: what })
        : plugin ? tr('There is no {api} server yet. Make one in My Servers, then add the plugin.', { api: what })
          : tr('There is no {loaders} server or instance yet. Make one in My Servers or Play Minecraft, then add the mod.', { loaders: what })));
      ide.ui.dialog({ title, body, width: 520, buttons: [{ label: tr('Close'), primary: true }] });
      return;
    }
    const rows = el('div', 'mcw-places');
    const boxes = places.map((t) => {
      const row = el('label', 'mcw-place');
      row.dataset.type = t.type;
      row.dataset.name = t.name;
      const box = el('input');
      box.type = 'checkbox';
      // What has it already is updated; with one place to choose from, that one; a plugin's own server.
      box.checked = t.has.length > 0 || places.length === 1 || (plugin && t.name === info.mod.server);
      const name = el('span', 'mcw-place-name', t.title);
      name.dataset.userText = '';
      const meta = el('span', 'mcw-place-meta');
      meta.append(el('span', 'mcc-chip', t.type === 'server' ? tr('Server') : tr('Instance')), el('span', `mcc-chip${t.sameMc ? '' : ' bad'}`, plugin ? `${mc.kindTitle(t.loader)} ${t.mc}` : `Minecraft ${t.mc}`));
      if (!t.sameMc) meta.append(el('span', 'mcw-place-why muted', tr('another Minecraft version: the mod may not load')));
      if (t.has.length) meta.append(el('span', 'mcc-chip sync', tr('Has it: replaced')));
      if (t.running) meta.append(el('span', 'mcc-chip', tr('Running')));
      row.append(box, Object.assign(ide.icon(t.type === 'server' ? 'desktop' : 'runRun'), { className: 'ide-icon mcw-place-icon' }), name, meta);
      rows.append(row);
      return { t, box };
    });
    body.append(rows, el('div', 'mc-dialog-note muted', plugin ? tr('The plugin\'s file is copied into each plugins folder, over an earlier build of the same plugin. A server loads it at its next start.')
      : tr('The mod\'s file is copied into each mods folder, over an earlier build of the same mod. A server loads it at its next start.')), error);
    ide.ui.dialog({
      title, body, width: 560,
      buttons: [
        { label: tr('Add'), primary: true, run: async () => {
          const wanted = boxes.filter((b) => b.box.checked).map((b) => ({ type: b.t.type, name: b.t.name }));
          if (!wanted.length) { error.textContent = tr('Choose where to add it.'); return false; }
          try { report(info, await ide.api.invoke('modmaker:addTo', ide.root, source, wanted)); } catch (err) { error.textContent = errorText(err); return false; }
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }
  // A jar made elsewhere, added the same way.
  async function addFile(only = null) {
    if (!ide.root || !trusted()) return;
    const picked = await ide.api.invoke('dialog:openFile', [{ name: tr('Minecraft mod or plugin'), extensions: ['jar'] }]).catch(() => null);
    if (picked) addDialog({ file: picked }, only);
  }
  // Asked from one server or instance ({type, name, title, mc, loader} for mods, {..., plugins} for a server that runs
  // plugins): the user's mods or plugins that fit it, each with Add, and a jar from elsewhere.
  async function addInto(place) {
    if (!ide.root || !trusted()) return;
    await refresh();
    const fits = { fabric: ['fabric', 'quilt'], forge: ['forge'], neoforge: ['neoforge'] };
    const mine = mods.filter((m) => (place.plugins ? m.kind === 'plugin' && m.api === place.plugins : m.kind === 'mod' && fits[m.loader]?.includes(place.loader)));
    const body = el('div', 'mc-dialog mcw-add-dialog');
    const rows = el('div', 'mcw-places');
    let dialog = null;
    for (const m of mine) {
      const row = el('div', 'mcw-place mcw-mine');
      row.dataset.id = m.id;
      const name = el('span', 'mcw-place-name', m.name);
      name.dataset.userText = '';
      const meta = el('span', 'mcw-place-meta');
      if (m.kind === 'mod') meta.append(el('span', `mcc-chip${m.mc === place.mc ? '' : ' bad'}`, `Minecraft ${m.mc}`));
      meta.append(el('span', 'muted', m.jar ? m.jar.name : tr('Not built yet')));
      const add = mc.craft.button(tr('Add'), 'secondary mcw-mine-add', () => { dialog?.close(); addDialog(refOf(m), place); }, 'add');
      add.disabled = !m.jar;
      row.append(name, meta, add);
      rows.append(row);
    }
    if (!mine.length) {
      rows.append(el('div', 'mcw-add-none muted', place.plugins ? tr('You have no {api} plugin yet. Make one in My Mods and Plugins, or add a file.', { api: APIS[place.plugins] || place.plugins })
        : tr('You have no {loader} mod yet. Make one in My Mods and Plugins, or add a file.', { loader: loaderTitle(place.loader) })));
    }
    body.append(rows);
    dialog = ide.ui.dialog({
      title: place.plugins ? tr('Add My Plugin to {name}', { name: place.title || place.name }) : tr('Add My Mod to {name}', { name: place.title || place.name }), body, width: 560,
      buttons: [
        { label: tr('Jar File…'), run: () => { addFile(place); return true; } },
        { label: tr('My Mods and Plugins'), run: () => { mc.screen?.home(true); mc.screen?.show('mods'); return true; } },
        { label: tr('Close'), primary: true },
      ],
    });
  }

  async function openInCode(m) {
    if (!trusted()) return;
    try {
      await ide.api.invoke('modmaker:openInCode', ide.root, refOf(m));
      notify({ title: tr('Opening {name} in Nano Studio Code', { name: m.name }), text: tr('Save your changes there, then build it here.'), kind: 'info', timeout: 6000 });
    } catch (err) { ide.ui.alert(errorText(err)); }
  }
  async function deleteOne(m) {
    if (busy.has(keyOf(m))) return;
    const ask = m.kind === 'plugin' ? tr('Move the plugin {name} (its source code and builds) to the Recycle Bin? Copies added to servers stay.', { name: m.name })
      : tr('Move the mod {name} (its source code and builds) to the Recycle Bin? Copies added to servers and instances stay.', { name: m.name });
    if (!(await ide.ui.confirm(ask, { title: m.kind === 'plugin' ? tr('Delete Plugin') : tr('Delete Mod'), ok: tr('Delete') }))) return;
    try { await ide.api.trash(m.dir); } catch (err) {
      ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: m.name, error: errorText(err) }));
    }
    await refresh();
  }

  // ---------- the page ----------
  function iconButton(icon, label, cls, onClick) {
    const b = el('button', `secondary mcc-icon ${cls}`);
    b.append(ide.icon(icon));
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = (e) => { e.preventDefault(); onClick(); };
    return b;
  }
  function card(m) {
    const plugin = m.kind === 'plugin';
    const c = el('div', 'mcc-card mcw-card');
    c.dataset.id = m.id;
    c.dataset.kind = m.kind;
    const art = el('div', `mcc-art ${plugin ? `plugin ${m.api}` : m.loader}`);
    art.append(ide.icon(plugin ? 'plugin' : 'code'));
    const body = el('div', 'mcc-card-body');
    const name = el('div', 'mcc-name', m.name);
    name.dataset.userText = '';
    const meta = el('div', 'mcc-meta');
    const working = busy.has(keyOf(m)) || m.building;
    if (!plugin) meta.append(el('span', 'mcc-chip', `Minecraft ${m.mc}`));
    meta.append(el('span', `mcc-chip loader ${plugin ? m.api : m.loader}`, kindTitle(m)),
      working ? el('span', 'mcc-chip mcw-state building', tr('Building')) : m.jar ? el('span', 'mcc-chip sync mcw-state built', tr('Built')) : el('span', 'mcc-chip mcw-state', tr('Not built yet')));
    const facts = el('div', 'mcc-facts muted');
    if (plugin) {
      const srv = el('span', 'mcw-against', m.against ? tr('Built against {server}', { server: m.against.name }) : tr('No {api} server to build it against', { api: APIS[m.api] || m.api }));
      srv.dataset.userText = '';
      facts.append(srv);
    } else {
      const id = el('span', 'mcw-id', m.id);
      id.dataset.userText = '';
      facts.append(id);
    }
    if (m.jar) {
      const file = el('span', 'mcw-jar', m.jar.name);
      file.dataset.userText = '';
      facts.append(file, el('span', null, size(m.jar.size)), el('span', null, when(m.jar.time)));
    } else if (plugin && m.against && !m.against.ready) facts.append(el('span', 'mcw-start-first', tr('Start {name} once, then build.', { name: m.against.name })));
    else facts.append(el('span', null, tr('Build it to get its file.')));
    body.append(name, meta, facts);
    const actions = el('div', 'mcc-actions');
    const buildBtn = mc.craft.button(working ? tr('Building…') : tr('Build'), 'primary mcw-build', () => build(m), 'runRun');
    buildBtn.disabled = working;
    buildBtn.title = plugin ? tr('Compiles the plugin against the API of your server') : tr('Builds the mod\'s file with its own Gradle build');
    const addBtn = mc.craft.button(tr('Add to…'), 'secondary mcw-add', () => addDialog(refOf(m)), 'add');
    addBtn.disabled = !m.jar || working;
    addBtn.title = !m.jar ? tr('Build it first: it has no file yet.') : plugin ? tr('Copies the built plugin into your servers') : tr('Copies the built mod into your servers and instances');
    const del = iconButton('clear', tr('Delete…'), 'mcw-delete', () => deleteOne(m));
    del.disabled = working;
    actions.append(buildBtn, addBtn,
      iconButton('code', tr('Edit in Code'), 'mcw-code', () => openInCode(m)),
      iconButton('folder', tr('Open Folder'), 'mcw-folder', () => ide.api.invoke('shell:openPath', m.dir)), del);
    c.append(art, body, actions);
    c.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      e.preventDefault();
      ide.ui.contextMenu(e.clientX, e.clientY, [
        { label: tr('Build'), icon: 'runRun', disabled: working, run: () => build(m) },
        { label: tr('Add to…'), icon: 'add', disabled: !m.jar || working, run: () => addDialog(refOf(m)) },
        { separator: true },
        { label: tr('Edit in Code'), icon: 'code', run: () => openInCode(m) },
        { label: tr('Open Folder'), icon: 'folder', run: () => ide.api.invoke('shell:openPath', m.dir) },
        { separator: true }, { label: tr('Delete…'), icon: 'clear', disabled: working, run: () => deleteOne(m) },
      ]).classList.add('mc-actions-menu');
    });
    return c;
  }
  function render() {
    if (!view) return;
    view.newBtn.disabled = creating;
    view.newBtn.querySelector(':scope > span:last-child').textContent = creating ? tr('Making…') : tr('New Mod…');
    if (!loaded) return view.list.replaceChildren(el('div', 'mcc-empty muted', tr('Loading…')));
    if (!mods.length) {
      const empty = el('div', 'mcc-empty');
      empty.append(el('div', 'mcc-empty-title', tr('Nothing made yet')),
        el('div', 'muted', tr('Start a Fabric, Forge or NeoForge mod with New Mod, or a Paper or Velocity plugin with New Plugin. A jar made elsewhere goes in with Add a File.')));
      return view.list.replaceChildren(empty);
    }
    const grid = el('div', 'mcc-grid');
    for (const m of mods) grid.append(card(m));
    view.list.replaceChildren(grid);
  }
  // screen.js gives the page's container once per screen. The head is made once: a render replaces the cards only.
  function mount(page) {
    page.classList.add('mcc-page', 'mcw-page');
    const newBtn = mc.craft.button(tr('New Mod…'), 'primary mcw-new', newMod, 'add');
    const list = el('div', 'mcc-slot mcw-list');
    page.replaceChildren(mc.craft.head(tr('My Mods and Plugins'), tr('Mods and plugins you make yourself. Edit one in Nano Studio Code, build it, then add it to a server or an instance.'),
      newBtn, mc.craft.button(tr('New Plugin…'), 'primary mcw-new-plugin', newPlugin, 'add'),
      mc.craft.button(tr('Add a File…'), 'secondary mcw-add-file', () => addFile(), 'folder')), list);
    view = { newBtn, list };
    render();
    refresh();
  }

  ide.on('projectOpened', () => { loaded = false; refresh(); });
  ide.on('projectClosed', () => { loaded = false; refresh(); });
  ide.registerAction({ id: 'Minecraft.NewMod', title: tr('New Minecraft Mod…'), needsProject: true, run: newMod });
  ide.registerAction({ id: 'Minecraft.NewPlugin', title: tr('New Minecraft Plugin…'), needsProject: true, run: newPlugin });
  mc.modmaker = { mount, refresh, newMod, createMod, newPlugin, build, addDialog, addFile, addInto, openInCode, state: () => ({ mods, busy: [...busy] }) };
})();
