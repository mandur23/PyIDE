// Django, Flask and FastAPI support, like PyCharm Professional's. A static inspection of the project
// (pyide_frameworks.py: ast only, nothing is imported) detects each framework and lists its apps, models, admin
// registrations, routes, templates and template tag libraries. This file owns that state, the dev server run
// configuration types, manage.py tasks and the actions; views.js adds the tool windows, the browser pane and the
// view gutter icons, and templates.js the Django/Jinja2 template languages and template navigation.
(() => {
  const { el, basename, dirname, samePath } = ide.util;
  const here = document.currentScript.src.replace(/[^/]*$/, '');

  // ---------- inspection state ----------
  // info: {root, django: {manage, baseDir, settingsModule, settingsFile, rootUrlconf, installedApps, apps, urlconfs} | null,
  //   flask: {apps: [{var, module, file, line, factory}]} | null, fastapi: (same) | null,
  //   routes: [{framework, methods, path, name, view, file, line, viewFile, viewLine}],
  //   templateDirs, templates: [{name, path}], templateLibs: {lib: {tags, filters}}}
  let info = null;
  let error = null;
  let seq = 0;
  let current = Promise.resolve(null);
  const listeners = new Set();
  let isReady = false;
  const readyFns = [];

  const emit = () => { for (const fn of listeners) { try { fn(info); } catch (err) { console.error(err); } } };

  function inspect() {
    const my = ++seq;
    const root = ide.root;
    const interp = ide.currentInterp();
    current = (async () => {
      if (!root || !interp) return null;
      const r = await ide.api.invoke('frameworks:inspect', interp, root).catch((err) => ({ ok: false, error: String(err.message || err) }));
      if (my !== seq || !samePath(root, ide.root || '')) return info;
      info = r.ok ? r.info : null;
      error = r.ok ? null : r.error;
      if (error) console.warn('frameworks: inspection failed', error);
      emit();
      if (info) autoConfigure();
      return info;
    })();
    return current;
  }

  let timer = null;
  const scheduleInspect = (ms = 700) => { clearTimeout(timer); timer = setTimeout(inspect, ms); };
  ide.on('projectOpened', () => { info = null; emit(); inspect(); });
  ide.on('projectClosed', () => { seq++; info = null; emit(); });
  ide.on('interpreterChanged', () => scheduleInspect(100));
  ide.on('fileSaved', (tab) => /\.py$/i.test(tab?.path || '') && scheduleInspect());
  ide.on('filesChanged', () => scheduleInspect());

  const kinds = () => ['django', 'flask', 'fastapi'].filter((k) => info?.[k]);
  const FRAMEWORK_NAMES = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI' };
  const SERVER_TYPES = { django: 'django-server', flask: 'flask-server', fastapi: 'fastapi-server' };
  const DEFAULT_PORTS = { django: '8000', flask: '5000', fastapi: '8000' };

  // ---------- templates ----------
  const templateByName = (name) => info?.templates?.find((t) => t.name === name.replace(/\\/g, '/').replace(/^\.?\//, '')) || null;
  const isTemplatePath = (path) => !!info?.templateDirs?.some((d) => ide.util.isUnder(path, d));
  // The template language for a file, or null: Django templates in a Django project, Jinja2 for Flask and FastAPI.
  function templateLanguage(path) {
    if (!info || !/\.(html?|jinja2?|j2)$/i.test(path)) return null;
    if (!isTemplatePath(path) && !(/\.(jinja2?|j2)$/i.test(path) && ide.util.isUnder(path, info.root))) return null;
    return info.django ? 'django-html' : (info.flask || info.fastapi) ? 'jinja2' : null;
  }

  // ---------- servers and URLs ----------
  const run = () => ide.run;
  const serverSession = (fw) => run()?.sessions().find((s) => s.cfg.type === SERVER_TYPES[fw] && (s.running || s.starting)) || null;
  const serverConfig = (fw) => run()?.configs().find((c) => c.type === SERVER_TYPES[fw]) || null;
  function serverBase(fw) {
    const cfg = serverSession(fw)?.cfg || serverConfig(fw);
    let host = (cfg?.host || '127.0.0.1').trim();
    if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
    return `http://${host}:${(cfg?.port || DEFAULT_PORTS[fw]).toString().trim()}`;
  }
  // Path parameters (<int:pk>, <name>, {item_id}, (?P<x>...)) become 1 so the page can be opened.
  const samplePath = (path) => path.replace(/\(\?P<\w+>[^)]*\)/g, '1').replace(/<[^>]+>/g, '1').replace(/\{[^}]+\}/g, '1');
  const routeUrl = (route) => serverBase(route.framework) + samplePath(route.path);

  // Starts the framework's dev server (creating its configuration if needed) and resolves once it answers.
  async function ensureServer(fw) {
    if (!serverSession(fw)) {
      const cfg = serverConfig(fw) || createServerConfig(fw);
      if (!cfg) return false;
      run().runConfig(cfg);
    }
    const status = await ide.api.invoke('frameworks:probe', serverBase(fw), 60000);
    return status !== null;
  }

  // ---------- run configuration types ----------
  const quoteArg = (a) => (/\s/.test(a) ? `"${a}"` : a);
  const commandLine = (interp, args) => `${[interp.cmd, ...interp.args, ...args].map(quoteArg).join(' ')}\n`;
  const projectCwd = (cfg) => run().resolvePath(cfg.cwd) || ide.root;

  function serverFields(extra) {
    return [
      ...extra,
      { key: 'host', label: tr('Host'), placeholder: '127.0.0.1' },
      { key: 'port', label: tr('Port'), placeholder: '8000' },
      { key: 'params', label: tr('Additional options') },
      { key: 'reload', label: tr('Reload on code changes'), kind: 'checkbox' },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
    ];
  }

  // Each server type turns a configuration into what `python` runs: {script ('-m' for a module), cwd, args, env}.
  // Debugging drops the reloader, whose worker process the debugger would not be attached to.
  const SERVERS = {
    django: {
      type: 'django-server', title: tr('Django Server'), icon: '🌐',
      fields: serverFields([{ key: 'settings', label: tr('Settings module'), placeholder: tr('e.g. mysite.settings') }]),
      defaults: () => ({ host: '127.0.0.1', port: '8000', settings: '', params: '', reload: true, env: '', interp: '' }),
      launch(cfg, debug) {
        const manage = info?.django?.manage;
        if (!manage) throw new Error(tr('No manage.py was found in this project.'));
        const reload = cfg.reload && !debug;
        return {
          script: manage, cwd: dirname(manage),
          args: ['runserver', `${(cfg.host || '127.0.0.1').trim()}:${(cfg.port || '8000').toString().trim()}`, ...(reload ? [] : ['--noreload']), ...run().parseArgs(cfg.params)],
          env: { ...run().parseEnv(cfg.env), ...(cfg.settings?.trim() ? { DJANGO_SETTINGS_MODULE: cfg.settings.trim() } : {}) },
        };
      },
    },
    flask: {
      type: 'flask-server', title: tr('Flask Server'), icon: '🍶',
      fields: serverFields([
        { key: 'target', label: tr('Target (FLASK_APP)'), placeholder: tr('e.g. app or app:create_app()') },
        { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project folder') },
      ]),
      defaults: () => ({ target: flaskTarget(), cwd: '', host: '127.0.0.1', port: '5000', params: '', reload: true, env: '', interp: '' }),
      launch(cfg, debug) {
        const reload = cfg.reload && !debug;
        return {
          script: '-m', cwd: projectCwd(cfg),
          args: ['flask', 'run', '--host', (cfg.host || '127.0.0.1').trim(), '--port', (cfg.port || '5000').toString().trim(), reload ? '--reload' : '--no-reload', ...run().parseArgs(cfg.params)],
          env: { FLASK_APP: (cfg.target || flaskTarget()).trim(), ...(cfg.reload ? { FLASK_DEBUG: '1' } : {}), ...run().parseEnv(cfg.env) },
        };
      },
    },
    fastapi: {
      type: 'fastapi-server', title: tr('FastAPI (uvicorn)'), icon: '⚡',
      fields: serverFields([
        { key: 'target', label: tr('Application (module:app)'), placeholder: tr('e.g. main:app') },
        { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project folder') },
      ]),
      defaults: () => ({ target: fastapiTarget(), cwd: '', host: '127.0.0.1', port: '8000', params: '', reload: true, env: '', interp: '' }),
      launch(cfg, debug) {
        const target = (cfg.target || fastapiTarget()).trim();
        const factory = info?.fastapi?.apps.find((a) => `${a.module}:${a.factory}` === target);
        const reload = cfg.reload && !debug;
        return {
          script: '-m', cwd: projectCwd(cfg),
          args: ['uvicorn', target, ...(factory ? ['--factory'] : []), '--host', (cfg.host || '127.0.0.1').trim(), '--port', (cfg.port || '8000').toString().trim(), ...(reload ? ['--reload'] : []), ...run().parseArgs(cfg.params)],
          env: run().parseEnv(cfg.env),
        };
      },
    },
  };

  // FLASK_APP: the module of a module-level app (flask finds `app` and `create_app` in it by itself).
  function flaskTarget() {
    const app = info?.flask?.apps[0];
    if (!app) return 'app';
    return app.factory && app.factory !== 'create_app' && app.factory !== 'make_app' ? `${app.module}:${app.factory}()` : app.module;
  }
  function fastapiTarget() {
    const app = info?.fastapi?.apps[0];
    return app ? `${app.module}:${app.factory || app.var}` : 'main:app';
  }

  function registerServerType(fw) {
    const s = SERVERS[fw];
    run().registerType({
      type: s.type, title: s.title, icon: s.icon, fields: s.fields, defaults: s.defaults,
      identity: () => fw,
      file: () => (fw === 'django' ? info?.django?.manage : null),
      async start(cfg, session, interp) {
        const con = session.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
        const l = s.launch(cfg, false);
        const env = { PYTHONUNBUFFERED: '1', ...l.env };
        con.append(commandLine(interp, ['-u', l.script, ...l.args]), 'sys');
        const id = await ide.api.invoke('run:start', interp, l.script, l.cwd, l.args, env, ide.root ? [ide.root] : []);
        session.attach(id);
        session.setActions([{ icon: '🌐', title: tr('Open in Browser'), run: () => openUrl(serverBase(fw) + '/') }]);
      },
      debugTarget(cfg) {
        const l = s.launch(cfg, true);
        return { script: l.script, cwd: l.cwd, params: l.args, env: { PYTHONUNBUFFERED: '1', ...l.env } };
      },
    });
  }

  // manage.py tasks run in one Run tab ("manage.py"); saved manage.py configurations are possible too.
  function registerManageType() {
    run().registerType({
      type: 'django-manage', title: tr('Django manage.py Task'), icon: '⚙',
      fields: [
        { key: 'task', label: tr('Task'), placeholder: tr('e.g. migrate') },
        { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
        { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
      ],
      defaults: () => ({ task: '', env: '', interp: '' }),
      identity: (c) => (c.task || '').trim(),
      file: () => info?.django?.manage,
      async start(cfg, session, interp) {
        const con = session.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
        const manage = info?.django?.manage;
        if (!manage) return con.append(`${tr('No manage.py was found in this project.')}\n`, 'err');
        const args = run().parseArgs(cfg.task);
        con.append(commandLine(interp, ['-u', manage, ...args]), 'sys');
        const id = await ide.api.invoke('run:start', interp, manage, dirname(manage), args, { PYTHONUNBUFFERED: '1', ...run().parseEnv(cfg.env) }, ide.root ? [ide.root] : []);
        session.attach(id, { onExit: (code) => { if (code === 0 && /^(makemigrations|startapp)\b/.test(cfg.task.trim())) { ide.refreshTree?.(); scheduleInspect(200); } } });
      },
    });
  }

  function runManageTask(task) {
    task = task.trim();
    if (!task || !info?.django) return null;
    return run().runConfig({ ...run().types.get('django-manage').defaults(), type: 'django-manage', id: `manage:${ide.root}`, name: `manage.py ${task}`, task });
  }

  // Like PyCharm, a detected framework gets a saved server configuration once per project, selected if nothing was.
  function autoConfigure() {
    if (!run() || !ide.root) return;
    const key = `frameworks.autoConfigured:${ide.root}`;
    const done = new Set(ide.settings.get(key, []));
    for (const fw of kinds()) {
      if (done.has(fw)) continue;
      done.add(fw);
      if (!serverConfig(fw)) createServerConfig(fw);
    }
    ide.settings.set(key, [...done]);
  }

  function createServerConfig(fw) {
    if (!info?.[fw]) return null;
    const previous = run().selected()?.id || null;
    const cfg = run().addTemporary({ type: SERVER_TYPES[fw], name: basename(ide.root), ...SERVERS[fw].defaults() });
    cfg.temporary = false;
    run().select(previous || cfg.id);
    return cfg;
  }

  function runServer(fw, { debug = false } = {}) {
    const cfg = serverConfig(fw) || createServerConfig(fw);
    if (!cfg) return null;
    run().select(cfg.id);
    return debug ? run().debugConfig(cfg) : run().runConfig(cfg);
  }

  // ---------- manage.py task popup (Ctrl+Alt+R) ----------
  const commandCache = new Map(); // `${interp}|${manage}` -> Promise<{ok, commands} | {ok: false, error}>
  function manageCommands() {
    const interp = ide.currentInterp();
    const manage = info?.django?.manage;
    if (!interp || !manage) return Promise.resolve({ ok: false, error: tr('No manage.py was found in this project.') });
    const key = `${interp.executable}|${manage}`;
    if (!commandCache.has(key)) {
      const p = ide.api.invoke('frameworks:manageCommands', interp, manage, {}, [ide.root]);
      p.then((r) => { if (!r.ok) commandCache.delete(key); });
      commandCache.set(key, p);
    }
    return commandCache.get(key);
  }
  ide.on('interpreterChanged', () => commandCache.clear());

  async function manageTaskPopup() {
    if (!info?.django) return;
    const choice = await ide.ui.pick({
      placeholder: tr('manage.py task, e.g. makemigrations polls'),
      items: async (query) => {
        const r = await manageCommands();
        const q = query.trim();
        if (!r.ok) return [{ label: tr('Could not list the manage.py commands'), detail: r.error, icon: '⚠', value: { task: q } }];
        const [word = '', ...rest] = q.split(/\s+/);
        const args = rest.length ? ` ${rest.join(' ')}` : '';
        const starts = r.commands.filter((c) => c.startsWith(word));
        const contains = r.commands.filter((c) => !c.startsWith(word) && c.includes(word));
        const items = [...starts, ...contains].slice(0, 60).map((c) => ({ label: `${c}${args}`, icon: '⚙', value: { task: `${c}${args}` } }));
        if (q && !r.commands.includes(word)) items.push({ label: q, detail: tr('Run as typed'), icon: '▶', value: { task: q } });
        return items;
      },
    });
    if (choice?.task) runManageTask(choice.task);
  }

  // ---------- browser ----------
  let browserTab = null;
  function openUrl(url, { external = false } = {}) {
    if (external) return ide.api.invoke('shell:openExternal', url);
    const tab = ide.openCustomTab({
      id: 'frameworks:browser', title: tr('Browser'), icon: '🌐',
      mount(host) {
        host.classList.add('fw-browser');
        const bar = el('div', 'fw-browser-bar');
        const reload = el('button', 'fw-browser-btn', '⟳');
        reload.title = tr('Reload');
        const address = el('input', 'fw-browser-url');
        address.spellcheck = false;
        const ext = el('button', 'fw-browser-btn', '↗');
        ext.title = tr('Open in External Browser');
        const frame = el('iframe', 'fw-browser-frame');
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals');
        bar.append(reload, address, ext);
        host.append(bar, frame);
        const go = (u) => { address.value = u; frame.src = u; host.dataset.url = u; };
        reload.onclick = () => go(address.value);
        address.onkeydown = (e) => { if (e.key === 'Enter') go(/^https?:\/\//i.test(address.value) ? address.value : `http://${address.value}`); };
        ext.onclick = () => ide.api.invoke('shell:openExternal', address.value);
        frame.addEventListener('load', () => { host.dataset.loaded = String(Date.now()); });
        browserTab = { go, frame, address, host };
      },
      onClose: () => { browserTab = null; },
    });
    browserTab?.go(url);
    return tab;
  }

  async function openRoute(route, opts = {}) {
    if (!(await ensureServer(route.framework))) {
      ide.ui.dialog({ title: tr('Browser'), body: tr('The {name} server did not start. See the Run tool window.', { name: FRAMEWORK_NAMES[route.framework] }) });
      return null;
    }
    return openUrl(routeUrl(route), opts);
  }

  // ---------- actions, menus, installables ----------
  function onReady(fn) { if (isReady) fn(); else readyFns.push(fn); }
  ide.on('ready', () => {
    if (ide.run) {
      for (const fw of Object.keys(SERVERS)) registerServerType(fw);
      registerManageType();
    }
    const django = () => !!info?.django;
    [
      { id: 'Django.RunManageTask', title: tr('Run manage.py Task…'), keys: 'Ctrl+Alt+R', when: django, run: manageTaskPopup },
      { id: 'Django.MakeMigrations', title: tr('Make Migrations'), when: django, run: () => runManageTask('makemigrations') },
      { id: 'Django.Migrate', title: tr('Migrate'), when: django, run: () => runManageTask('migrate') },
      { id: 'Frameworks.RunServer', title: tr('Run Development Server'), when: () => kinds().length > 0, run: () => runServer(kinds()[0]) },
      { id: 'Frameworks.DebugServer', title: tr('Debug Development Server'), when: () => kinds().length > 0, run: () => runServer(kinds()[0], { debug: true }) },
      { id: 'Frameworks.Refresh', title: tr('Refresh Framework Detection'), run: inspect },
    ].forEach(ide.registerAction);

    if (ide.installer?.pip) {
      const category = tr('Web Frameworks');
      (ide.installables ||= []).push(
        ide.installer.pip({ package: 'django', name: 'Django', description: tr('The web framework for perfectionists with deadlines.'), category }),
        ide.installer.pip({ package: 'flask', name: 'Flask', description: tr('A lightweight WSGI web application framework.'), category }),
        ide.installer.pip({ package: 'fastapi', name: 'FastAPI', description: tr('A modern, fast web framework for building APIs with Python type hints.'), category }),
        ide.installer.pip({ package: 'uvicorn', name: 'Uvicorn', description: tr('An ASGI web server, used to run FastAPI applications.'), category }),
        ide.installer.pip({ package: 'jinja2', name: 'Jinja2', description: tr('The template engine used by Flask, also for FastAPI templates.'), category }),
      );
      ide.emit('installablesChanged');
    }
    isReady = true;
    for (const fn of readyFns.splice(0)) fn();
  });

  ide.frameworks = {
    info: () => info,
    error: () => error,
    kinds,
    refresh: inspect,
    // Resolves with the inspection for the current project once it has run.
    ready: () => current,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onReady,
    names: FRAMEWORK_NAMES,
    serverTypes: SERVER_TYPES,
    serverBase,
    routeUrl,
    openUrl,
    openRoute,
    runServer,
    runManageTask,
    manageTaskPopup,
    manageCommands,
    templateByName,
    templateLanguage,
    isTemplatePath,
    browser: () => browserTab,
  };

  for (const file of ['templates.js', 'views.js']) {
    const s = el('script');
    s.src = here + file;
    s.async = false;
    document.body.appendChild(s);
  }
})();
