// A mod or a plugin made in Nano Studio Craft, opened here to be edited (main/features/craft-mods.js). Craft's Edit in
// Code opens the folder; the Minecraft tool window then says what the folder is and walks through the three steps:
// - Change the code: the file the mod starts in, with what runs there and when, and the other files worth knowing.
// - Build: the mod's own Gradle build (a plugin: javac against its server's API), shown in a Run tab.
// The window's toolbar repeats Test and Build, so they are in reach wherever the guide is scrolled to.
// - See it: the test client (game.js) starts the mod's development game under the debugger, with its window beside
//   Code or shown in this window, and swaps saved code into it. Or the mod is built, put into an instance of its loader
//   and Minecraft version (Fabric API with it when the instance has none) and the official launcher opens on that
//   instance. A plugin, or a mod for a server, is built and put into a server, which Craft starts again.
// The window shows for such a folder only, and opens with it; the file the code starts in opens when no file is open.
(() => {
  const { el, basename } = ide.util;
  const run = ide.run;
  const TARGET = 'craftMods.target'; // folder (lower case) -> {instance, server}: where it was last tried
  const LOADERS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
  const APIS = { paper: 'Paper', velocity: 'Velocity' };
  let project = null; // main's description of the open folder, when Craft made it
  let busy = null; // {what: 'build' | 'test' | 'server' | 'instance', job}
  let view = null; // the window's scrolling body: the Game View's box (game.js fills it), then the guide
  let guide = null; // the part drawn again by render()
  let gameBox = null;
  let seq = 0;
  let tw = null;

  // ---------- jobs: main's log lines go to the Run tab of the job that asked ----------
  const jobs = new Map();
  let jobSeq = 0;
  ide.api.on('craft-mods:log', ({ job, text }) => jobs.get(job)?.append(text, 'sys'));
  function startJob(what, title) {
    const s = run.outputSession(`craft-mods:${what}`, title);
    s.host.replaceChildren();
    const con = s.console();
    run.show(s);
    const id = `cmod-${Date.now()}-${++jobSeq}`;
    jobs.set(id, con);
    const task = ide.tasks?.start({ title });
    busy = { what, job: id };
    render();
    return { id, con, end() { task?.done(); jobs.delete(id); busy = null; } };
  }
  const notify = (o) => ide.notifications?.notify({ group: 'Minecraft', raw: true, ...o });
  const trusted = () => (ide.trusted === false ? (ide.ui.alert(tr('The project is open in Safe Mode, where Nano Studio runs nothing from it.')), false) : true);
  const rawError = (err) => ide.util.errorText(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  // Main's messages in the user's words; what is not listed is shown as main wrote it.
  const ERRORS = [
    [/^The build failed/, () => tr('The build failed. The Run tab shows where: fix it and build again.')],
    [/^The build finished but left no jar/, () => tr('The build finished but left no file in build/libs.')],
    [/is being built already$/, () => tr('It is being built already.')],
    [/^A JDK of Java (\d+) was not found/, (m) => tr('Java {java} (a JDK) was not found and could not be downloaded.', { java: m[1] })],
    [/needs a (\w+) server to be built against/, (m) => tr('There is no {api} server to build it against. Make one in Nano Studio Craft.', { api: m[1] })],
    [/^Start (\S+) once first/, (m) => tr('Start {name} once in Nano Studio Craft first: a server unpacks what a plugin is built against at its first start.', { name: m[1] })],
    [/^The plugin has no \.java files/, () => tr('The plugin has no .java files in src/main/java.')],
    [/has no gradlew\.bat/, () => tr('This folder has no gradlew.bat, so it cannot be built here.')],
    [/is a snapshot or pre-release/, () => tr('An instance can be made for a release of Minecraft only.')],
    [/has no loader for Minecraft/, () => tr('The loader has no version for this Minecraft yet.')],
    [/is busy with another download or Play$/, () => tr('The instance is busy with another download or launch.')],
    [/^Cancelled/, () => tr('Cancelled.')],
  ];
  function errorText(err) {
    const text = rawError(err);
    for (const [re, say] of ERRORS) { const m = re.exec(text); if (m) return say(m); }
    return text;
  }
  const cancelled = (err) => /^Cancelled/.test(rawError(err));
  const when = (ms) => {
    const s = (ms - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: 'auto' });
    for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
    return tr('Just now');
  };

  const isMod = () => project?.kind === 'mod';
  const kindTitle = (p) => (p.kind === 'plugin' ? tr('{api} plugin', { api: APIS[p.api] || p.api }) : `${LOADERS[p.loader] || p.loader} · Minecraft ${p.mc}`);
  const targetKey = () => String(ide.root || '').toLowerCase();
  const lastTarget = () => ide.settings.get(TARGET, {})[targetKey()] || {};
  const rememberTarget = (patch) => ide.settings.set(TARGET, { ...ide.settings.get(TARGET, {}), [targetKey()]: { ...lastTarget(), ...patch } });
  const picked = (id, list, last) => {
    const now = view?.querySelector(`#${id}`)?.value;
    return list.find((t) => t.name === now) || list.find((t) => t.name === last) || list[0] || null;
  };

  // ---------- what the folder is ----------
  async function load({ open = false } = {}) {
    const mine = ++seq;
    const root = ide.root;
    const found = root ? await ide.api.invoke('craft-mods:project', root).catch(() => null) : null;
    if (mine !== seq) return;
    project = found;
    render();
    // The window is this folder's: another project's has nothing to show in it.
    if (!project && tw?.isVisible()) tw.hide();
    if (!project || !open) return;
    tw?.show();
    // A tab the user (or the last session) already holds stays in front.
    const main = project.files.find((f) => f.role === 'main');
    if (main && !ide.tabs.some((t) => t.kind !== 'custom')) ide.openFile(main.path, { focus: false });
  }

  // ---------- the steps ----------
  async function build() {
    if (!project || busy || !trusted()) return null;
    const job = startJob('build', tr('Build {name}', { name: project.name }));
    try {
      const r = await ide.api.invoke('craft-mods:build', ide.root, job.id);
      job.con.append(`${tr('Built {file}.', { file: r.jar.name })}\n`, 'ok');
      return r;
    } catch (err) {
      const text = errorText(err);
      job.con.append(`${text}\n`, cancelled(err) ? undefined : 'err');
      if (!cancelled(err)) notify({ title: tr('{name} could not be built', { name: project?.name || '' }), text, kind: 'error' });
      return null;
    } finally {
      job.end();
      await load();
    }
  }
  // Builds, puts the jar where it is tried and, for an instance, opens the launcher on it.
  async function send(place) {
    if (!project || busy || !place || !trusted()) return null;
    const toGame = place.type === 'instance';
    rememberTarget(toGame ? { instance: place.name } : { server: place.name });
    const name = project.name;
    const job = startJob(toGame ? 'test' : 'server', toGame ? tr('Test {name}', { name }) : tr('Add {name} to {server}', { name, server: place.title }));
    try {
      const r = await ide.api.invoke('craft-mods:send', ide.root, { places: [{ type: place.type, name: place.name }], play: toGame ? place.name : null }, job.id);
      const added = r.added[0];
      if (!added?.ok) {
        const text = added?.code === 'inUse'
          ? (toGame ? tr('Minecraft holds the file. Close the game, then test again.') : tr('{server} is running and holds the file. Stop it in Nano Studio Craft, then add again.', { server: place.title }))
          : added?.error || tr('The file could not be added.');
        job.con.append(`${text}\n`, 'err');
        notify({ title: tr('{name} could not be added', { name }), text, kind: 'error' });
        return r;
      }
      if (!toGame) {
        const text = tr('Start {server} again in Nano Studio Craft to load it.', { server: place.title });
        job.con.append(`${text}\n`, 'ok');
        notify({ title: tr('{name} added to {server}', { name, server: place.title }), text, kind: 'ok' });
        return r;
      }
      if (r.play?.launched === false && r.play.code === 'noLauncher') {
        job.con.append(`${tr('The official Minecraft Launcher is not installed.')}\n`, 'err');
        ide.ui.dialog({
          title: tr('The official Minecraft Launcher is needed'),
          body: el('div', 'dialog-message', tr('The game starts through the official Minecraft Launcher, where you sign in with your Microsoft account. Install it from Mojang\'s download page, then test again.')),
          buttons: [{ label: tr('Open the Download Page'), primary: true, run: () => { ide.api.invoke('shell:openExternal', r.play.download); } }, { label: tr('Close') }],
        });
        return r;
      }
      if (!r.play?.launched) {
        const text = tr('The mod is in {instance}, but the launcher could not be opened. Launch the instance from Nano Studio Craft.', { instance: place.title });
        job.con.append(`${text}\n`, 'err');
        notify({ title: tr('The launcher did not open'), text, kind: 'warn' });
        return r;
      }
      const lines = [tr('Press Play in the Minecraft Launcher: the game starts with the mod in it.')];
      if (r.fabricApi) lines.push(tr('Fabric API {version} was added to the instance, since the mod needs it.', { version: r.fabricApi.version }));
      if (r.missing.length) lines.push(tr('The instance lacks mods this one needs ({mods}): the game will refuse to start until they are added.', { mods: r.missing.join(', ') }));
      job.con.append(`${lines.join('\n')}\n`, r.missing.length ? 'err' : 'ok');
      notify({ title: tr('{name} is in {instance}', { name, instance: place.title }), text: lines.join(' '), kind: r.missing.length ? 'warn' : 'ok' });
      return r;
    } catch (err) {
      const text = errorText(err);
      job.con.append(`${text}\n`, cancelled(err) ? undefined : 'err');
      if (!cancelled(err)) notify({ title: toGame ? tr('{name} could not be tested', { name }) : tr('{name} could not be added', { name }), text, kind: 'error' });
      return null;
    } finally {
      job.end();
      await load();
    }
  }
  const test = () => send(picked('cmodInstance', project?.instances || [], lastTarget().instance));
  const addToServer = () => send(picked('cmodServer', project?.servers || [], lastTarget().server));
  async function newInstance() {
    if (!isMod() || busy || !trusted()) return null;
    const title = tr('{name} test', { name: project.name });
    const job = startJob('instance', tr('New Test Instance'));
    try {
      const inst = await ide.api.invoke('craft-mods:newInstance', ide.root, title, job.id);
      job.con.append(`${tr('The instance {name} is ready.', { name: inst.title })}\n`, 'ok');
      rememberTarget({ instance: inst.name });
      return inst;
    } catch (err) {
      const text = errorText(err);
      job.con.append(`${text}\n`, cancelled(err) ? undefined : 'err');
      if (!cancelled(err)) notify({ title: tr('The test instance could not be made'), text, kind: 'error' });
      return null;
    } finally {
      job.end();
      await load();
    }
  }
  const cancel = () => { if (busy) ide.api.invoke('craft-mods:cancel', busy.job); };

  // ---------- the window ----------
  const START = {
    fabric: () => tr('Where the mod starts. What onInitialize holds runs once as the game starts.'),
    forge: () => tr('Where the mod starts. Its constructor runs once as the game starts.'),
    neoforge: () => tr('Where the mod starts. Its constructor runs once as the game starts.'),
    paper: () => tr('Where the plugin starts. What onEnable holds runs as the server starts.'),
    velocity: () => tr('Where the plugin starts. What onInitialize holds runs as the proxy starts.'),
  };
  const ROLES = {
    main: (p) => (START[p.kind === 'plugin' ? p.api : p.loader] || START.fabric)(),
    client: () => tr('Code only the player\'s game runs, such as screens and keys.'),
    meta: (p) => (p.kind === 'plugin' ? tr('The plugin\'s name, version and commands, as the server reads them.') : tr('The mod\'s name, description and version, as the game lists them.')),
    resources: (p) => (p.kind === 'plugin' ? tr('Files that go into the plugin beside its code.') : tr('Pictures, translations and other files that go into the mod.')),
    properties: () => tr('The versions of Minecraft, the loader and the mod itself.'),
  };
  function button(label, cls, onClick, { icon, disabled } = {}) {
    const b = el('button', `cmod-btn ${cls}`);
    if (icon) b.append(ide.icon(icon));
    b.append(el('span', null, label));
    b.disabled = !!disabled;
    b.onclick = onClick;
    return b;
  }
  // The button of a step: Cancel while that step runs, and nothing to press while another does.
  const stepButton = (what, label, cls, onClick, opts = {}) => (busy?.what === what ? button(tr('Cancel'), `${cls} cmod-cancel`, cancel)
    : button(label, cls, onClick, { ...opts, disabled: !!busy || opts.disabled }));
  function step(n, title, ...content) {
    const s = el('section', 'cmod-step');
    const head = el('div', 'cmod-step-head');
    head.append(el('span', 'cmod-num', String(n)), el('span', 'cmod-step-title', title));
    s.append(head, ...content.filter(Boolean));
    return s;
  }
  const note = (text, cls = '') => el('div', `cmod-note muted ${cls}`.trim(), text);
  function select(id, list, last) {
    const s = el('select', 'input cmod-select');
    s.id = id;
    for (const t of list) s.add(new Option([t.title, t.mc].filter(Boolean).join(' · '), t.name));
    if (list.some((t) => t.name === last)) s.value = last;
    s.disabled = !!busy;
    return s;
  }
  function fileRow(f) {
    const row = el('button', 'cmod-file');
    row.dataset.role = f.role;
    const text = el('span', 'cmod-file-text');
    text.append(el('span', 'cmod-file-name', basename(f.path)), el('span', 'cmod-file-what muted', ROLES[f.role]?.(project) || ''));
    row.append(ide.fileIcon(basename(f.path), { dir: !!f.dir }), text);
    row.onclick = () => (f.dir ? ide.revealInTree(f.path) : ide.openFile(f.path));
    return row;
  }
  // The window's own toolbar keeps the two things done over and over in reach, whatever the guide is scrolled to.
  function headerActions() {
    if (!project) return [];
    if (busy) return [{ id: 'cmodCancel', icon: 'runStop', title: tr('Cancel'), run: cancel }];
    const game = ide.craftMods?.game;
    return [
      ...(isMod() && game?.available() && !game.running() ? [{ id: 'cmodClient', icon: 'runDebug', title: tr('Test Client'), run: () => game.start() }] : []),
      ...(isMod() && project.instances.length ? [{ id: 'cmodTest', icon: 'gamepad', title: tr('Test in Minecraft'), run: test }] : []),
      ...(!isMod() && project.servers.length ? [{ id: 'cmodAdd', icon: 'add', title: tr('Build and Add'), run: addToServer }] : []),
      { id: 'cmodBuild', icon: 'refresh', title: tr('Build Jar'), run: build },
    ];
  }
  function render() {
    if (!view) return;
    tw?.setActions(headerActions());
    const last = lastTarget();
    // The lists keep what is chosen in them across a redraw.
    const chosen = { instance: view.querySelector('#cmodInstance')?.value || last.instance, server: view.querySelector('#cmodServer')?.value || last.server };
    guide.replaceChildren();
    if (!project) {
      guide.append(el('div', 'cmod-empty muted', tr('A mod or a plugin made in Nano Studio Craft shows its guide here when its folder is open.')));
      return;
    }
    const p = project;
    const head = el('div', 'cmod-head');
    head.append(el('div', 'cmod-name', p.name), el('div', 'cmod-kind muted', kindTitle(p)));
    const intro = note(isMod() ? tr('A mod is Java code the game loads as it starts. Change the code, build it, then see it in the game.')
      : tr('A plugin is Java code a server loads as it starts. Change the code, build it, then put it on your server.'), 'cmod-intro');

    const files = el('div', 'cmod-files');
    files.append(...p.files.map(fileRow));
    const code = step(1, tr('Change the code'), files);

    const built = p.jar ? tr('Last build: {file} · {when}', { file: p.jar.name, when: when(p.jar.time) }) : tr('Not built yet.');
    const buildHint = isMod() ? tr('The first build downloads Gradle and Minecraft, which takes several minutes.')
      : p.against && !p.against.ready ? tr('Start {name} once in Nano Studio Craft first: a server unpacks what a plugin is built against at its first start.', { name: p.against.name })
        : p.against ? tr('It is compiled against the API of {name}.', { name: p.against.name }) : tr('There is no {api} server to build it against. Make one in Nano Studio Craft.', { api: APIS[p.api] || p.api });
    const buildRow = el('div', 'cmod-row');
    buildRow.append(stepButton('build', tr('Build Jar'), 'cmod-build', build, { icon: 'refresh' }), el('span', 'cmod-built muted', built));
    const made = step(2, tr('Build it'), buildRow, note(buildHint));

    const sections = [head, intro, code, made];
    if (isMod()) {
      const loader = LOADERS[p.loader] || p.loader;
      const body = [];
      // Two ways: the development game that stays open while the code changes, and the real game of an instance.
      const game = ide.craftMods?.game;
      if (game?.available()) {
        const row = el('div', 'cmod-row');
        row.append(button(game.running() ? tr('Test Client Running') : tr('Test Client'), 'cmod-client primary', () => game.start(), { icon: 'runDebug', disabled: game.running() }));
        body.push(el('div', 'cmod-sub', tr('While you write')), row,
          note(tr('Starts the mod\'s development game under the debugger, with its window beside this one. While it runs, code you save is swapped into the game (what is inside methods), and saved textures and language files are reloaded. The first start downloads Minecraft, which takes several minutes.')),
          el('div', 'cmod-sub', tr('In the real game')));
      }
      if (p.instances.length) {
        const row = el('div', 'cmod-row');
        row.append(select('cmodInstance', p.instances, chosen.instance), stepButton('test', tr('Test in Minecraft'), `cmod-test${game?.available() ? '' : ' primary'}`, test, { icon: 'gamepad' }));
        body.push(row, note(tr('Builds the mod, puts it into the instance and opens the Minecraft Launcher on it: press Play there. This is the game as players have it, with your account and the instance\'s other mods. After a change, close the game and test again.')));
        if (p.fabricApi) body.push(note(tr('Fabric API {version} is added to the instance when it has none.', { version: p.fabricApi })));
      } else {
        body.push(note(tr('There is no {loader} instance of Minecraft {mc} to try it in yet.', { loader, mc: p.mc }), 'cmod-none'),
          stepButton('instance', tr('Make a Test Instance'), `cmod-new-instance${game?.available() ? '' : ' primary'}`, newInstance, { icon: 'add' }),
          note(tr('It is made in Nano Studio Craft\'s instances, where the loader is downloaded for it.')));
      }
      sections.push(step(3, tr('See it in the game'), ...body));
    }
    if (p.servers.length || !isMod()) {
      const body = [];
      if (p.servers.length) {
        const row = el('div', 'cmod-row');
        row.append(select('cmodServer', p.servers, chosen.server), stepButton('server', tr('Build and Add'), `cmod-add${isMod() ? '' : ' primary'}`, addToServer, { icon: 'add' }));
        body.push(row, note(tr('Start the server again in Nano Studio Craft to load it. A running server holds the file: stop it first.')));
      } else body.push(note(tr('There is no {api} server to put it on. Make one in Nano Studio Craft.', { api: APIS[p.api] || p.api }), 'cmod-none'));
      sections.push(step(isMod() ? 4 : 3, tr('Put it on a server'), ...body));
    }
    guide.append(...sections);
  }

  tw = ide.registerToolWindow({
    id: 'MinecraftMod', title: tr('Minecraft'), iconName: 'minecraft', side: 'right', order: 34,
    available: () => !!project,
    mount(container) {
      container.classList.add('cmod');
      view = el('div', 'cmod-view');
      gameBox = el('div', 'cmod-game hidden');
      guide = el('div', 'cmod-guide');
      view.append(gameBox, guide);
      container.append(view);
      render();
    },
  });

  ide.registerAction({ id: 'CraftMods.Build', title: tr('Build Mod or Plugin'), when: () => !!project, run: build });
  ide.registerAction({ id: 'CraftMods.Test', title: tr('Test Mod in Minecraft'), when: () => isMod() && project.instances.length > 0, run: test });
  ide.registerAction({ id: 'CraftMods.Client', title: tr('Start the Mod\'s Test Client'), when: () => isMod() && !!ide.craftMods.game?.available() && !ide.craftMods.game.running(), run: () => ide.craftMods.game.start() });
  ide.registerAction({ id: 'CraftMods.Guide', title: tr('Show the Mod Guide'), when: () => !!project, run: () => tw.show() });

  ide.on('projectOpened', () => load({ open: true }));
  ide.on('projectClosed', () => { seq++; project = null; render(); });
  // What Craft makes meanwhile (an instance, a server) shows when the window comes back.
  ide.on('toolWindowShown', (id) => { if (id === 'MinecraftMod' && project && !busy) load(); });

  ide.craftMods = { build, test, addToServer, newInstance, cancel, refresh: load, state: () => ({ project, busy: busy?.what || null }),
    // For game.js: a console that takes a job's log lines, the words for main's errors, the window and its Game View box.
    job(con) { const id = `cmod-${Date.now()}-${++jobSeq}`; jobs.set(id, con); return { id, done: () => jobs.delete(id) }; },
    errorText, trusted, render, show: () => tw.show(), gameBox: () => gameBox, game: null };

  const script = el('script');
  script.src = `${document.currentScript.src.replace(/[^/]*$/, '')}game.js`;
  script.async = false;
  document.body.appendChild(script);
})();
