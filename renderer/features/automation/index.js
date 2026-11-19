// The Automation tool window (right side): what the project runs besides its code. Docker Compose files with their
// services and state (Up, Down, Build, Logs; start, stop, restart and the logs of one service), and the Gradle or Maven
// build's usual tasks. Every button starts a run in the Run tool window: a compose command through this plugin's
// "Docker Compose" run type (main/features/automation.js starts docker), a build task through the toolchains plugin's
// Maven / Gradle type. Nothing runs in Safe Mode.
(() => {
  const { el } = ide.util;
  const invoke = (ch, ...a) => ide.api.invoke(`automation:${ch}`, ...a);
  const errorText = (err) => ide.util.errorText(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const POLL_MS = 5000;

  let host = null;
  let found = { compose: [], dockerfiles: [], builds: [] };
  let docker = null; // automation:docker's answer; null until asked
  const services = new Map(); // compose file -> {services} | {error}
  let others = []; // the computer's containers that are not this project's services
  let stats = {}; // container name -> {cpu, memory}, of the running ones
  let storage = null; // {images, volumes}, read while its part of the window is open
  const opened = new Set(ide.settings.get('automation.opened', [])); // the parts that start folded (images, volumes)
  const collapsed = new Set(ide.settings.get('automation.collapsed', []));
  let seq = 0;
  let serviceTurn = 0;
  let timer = 0;

  const trusted = () => (ide.trusted === false ? (ide.ui.alert(tr('The project is open in Safe Mode, where Nano Studio runs nothing from it. Trust the project to use Docker and build tasks here.')), false) : true);

  // ---------- running ----------
  const composeTitle = (action, service) => `docker compose ${action}${service ? ` ${service}` : ''}`;
  ide.run.registerType({
    type: 'docker-compose', title: tr('Docker Compose'), icon: 'automation', needsInterp: false,
    fields: [
      { key: 'file', label: tr('Compose file'), placeholder: 'compose.yaml' },
      { key: 'action', label: tr('Command'), kind: 'select', options: () => ['up', 'build', 'down', 'logs', 'start', 'stop', 'restart'].map((a) => [a, a]) },
      { key: 'service', label: tr('Service'), placeholder: tr('Every service when empty') },
    ],
    defaults: () => ({ file: 'compose.yaml', action: 'up', service: '' }),
    identity: (c) => `${(c.file || '').toLowerCase()}|${c.action}|${c.service || ''}`,
    file: () => null,
    async start(cfg, s) {
      const con = s.console({});
      if (!ide.root) return con.append(`${tr('Open a project first.')}\n`, 'err');
      const file = ide.run.resolvePath(cfg.file) || cfg.file;
      try {
        const { id, command } = await invoke('compose', { root: ide.root, file, action: cfg.action, service: (cfg.service || '').trim() });
        con.append(`${command}\n`, 'sys');
        // The services' state follows what the command did.
        s.attach(id, { onExit: () => refreshServices() });
        setTimeout(refreshServices, 1500);
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
        s.setIcon?.('error', 'failed');
      }
    },
  });

  // A build task in a container, and a Dockerfile's image: runs named after what they start.
  ide.run.registerType({
    type: 'container-build', title: tr('Build Task in a Container'), icon: 'automation', needsInterp: false,
    fields: [
      { key: 'tool', label: tr('Build tool'), kind: 'select', options: () => [['gradle', 'Gradle'], ['maven', 'Maven']] },
      { key: 'goals', label: tr('Goals or tasks'), placeholder: 'build' },
    ],
    defaults: () => ({ tool: 'gradle', goals: '' }),
    identity: (c) => `${c.tool}:${(c.goals || '').trim()}`,
    file: () => null,
    async start(cfg, s) {
      const con = s.console({});
      if (!ide.root) return con.append(`${tr('Open a project first.')}\n`, 'err');
      try {
        const r = await invoke('buildInContainer', { root: ide.root, tool: cfg.tool, goals: cfg.goals });
        con.append(`${r.command}\n`, 'sys');
        con.append(`${tr('Runs in a container of {image}: the first run downloads the image and the build\'s dependencies.', { image: r.image })}\n`, 'sys');
        if (r.port) con.append(`${tr('The application answers on http://localhost:{port}; a database on this computer is host.docker.internal to it.', { port: r.port })}\n`, 'sys');
        s.attach(r.id);
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
        s.setIcon?.('error', 'failed');
      }
    },
  });
  ide.run.registerType({
    type: 'docker-image', title: tr('Dockerfile'), icon: 'automation', needsInterp: false,
    fields: [
      { key: 'file', label: tr('Dockerfile'), placeholder: 'Dockerfile' },
      { key: 'action', label: tr('Command'), kind: 'select', options: () => ['build', 'run', 'stop'].map((a) => [a, a]) },
    ],
    defaults: () => ({ file: 'Dockerfile', action: 'build' }),
    identity: (c) => `${(c.file || '').toLowerCase()}|${c.action}`,
    file: () => null,
    async start(cfg, s) {
      const con = s.console({});
      if (!ide.root) return con.append(`${tr('Open a project first.')}\n`, 'err');
      try {
        const r = await invoke('image', { root: ide.root, file: ide.run.resolvePath(cfg.file) || cfg.file, action: cfg.action });
        con.append(`${r.command}\n`, 'sys');
        s.attach(r.id);
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
        s.setIcon?.('error', 'failed');
      }
    },
  });
  ide.run.registerType({
    type: 'docker-container', title: tr('Docker Container'), icon: 'automation', needsInterp: false,
    fields: [
      { key: 'container', label: tr('Container'), placeholder: 'id' },
      { key: 'action', label: tr('Command'), kind: 'select', options: () => ['start', 'stop', 'restart', 'logs', 'rm'].map((a) => [a, a]) },
    ],
    defaults: () => ({ container: '', action: 'start' }),
    identity: (c) => `${c.container}|${c.action}`,
    file: () => null,
    async start(cfg, s) {
      const con = s.console({});
      try {
        const r = await invoke('container', { root: ide.root, id: cfg.container, action: cfg.action });
        con.append(`${r.command}\n`, 'sys');
        s.attach(r.id, { onExit: () => refreshServices() });
        setTimeout(refreshServices, 1500);
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
        s.setIcon?.('error', 'failed');
      }
    },
  });
  function container(c, action) {
    if (!trusted()) return;
    const type = ide.run.types.get('docker-container');
    ide.run.runConfig({ ...type.defaults(), id: `automation:container:${c.id}:${action}`, type: 'docker-container', name: `docker ${action} ${c.name}`, container: c.id, action });
  }
  ide.run.registerType({
    type: 'docker-remove', title: tr('Docker Image or Volume'), icon: 'automation', needsInterp: false,
    fields: [{ key: 'kind', label: tr('Kind'), kind: 'select', options: () => [['image', 'image'], ['volume', 'volume']] }, { key: 'target', label: tr('Name'), placeholder: '' }],
    defaults: () => ({ kind: 'image', target: '' }),
    identity: (c) => `${c.kind}|${c.target}`,
    file: () => null,
    async start(cfg, s) {
      const con = s.console({});
      try {
        const r = await invoke('remove', { root: ide.root, kind: cfg.kind, id: cfg.target });
        con.append(`${r.command}\n`, 'sys');
        s.attach(r.id, { onExit: () => refreshServices() });
      } catch (err) {
        con.append(`${errorText(err)}\n`, 'err');
        s.setIcon?.('error', 'failed');
      }
    },
  });
  function removeObject(kind, id, name) {
    if (!trusted()) return;
    const ask = kind === 'image' ? tr('Remove the image {name}? Docker refuses one a container still uses.', { name }) : tr('Remove the volume {name}? What is stored in it is lost. Docker refuses one a container still uses.', { name });
    removeAfterAsking(ask, () => {
      const type = ide.run.types.get('docker-remove');
      ide.run.runConfig({ ...type.defaults(), id: `automation:remove:${kind}:${id}`, type: 'docker-remove', name: `docker ${kind === 'image' ? 'rmi' : 'volume rm'} ${name}`, kind, target: id });
    }, kind === 'image' ? tr('Remove Image') : tr('Remove Volume'));
  }
  // A shell inside a running container, in the Terminal tool window.
  function terminal(name) {
    if (!trusted()) return;
    if (!ide.terminal) return ide.ui.alert(tr('The Terminal plugin is disabled.'));
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    // sh is in every image; bash is used when the image has it.
    ide.terminal.open({ name: `${name} (docker)`, shell: 'powershell', command: `& ${q(docker.exe)} exec -it ${q(name)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'` });
  }
  const usageOf = (name) => { const u = stats[name]; return u ? `${u.cpu} · ${u.memory}` : ''; };
  // Under an ended service or container that ended with an error: its exit code and the last lines it wrote.
  function whyBox(exit, why) {
    const box = el('div', 'auto-why');
    box.append(el('div', 'auto-why-code', tr('Ended with exit code {code}', { code: exit })));
    if (why) { const pre = el('pre', 'auto-why-log', why); pre.dataset.userText = ''; box.append(pre); }
    return box;
  }
  const isUp = (state) => state === 'running' || state === 'restarting' || state === 'paused';
  // Ports as links: a click opens http://localhost:<port> in the browser.
  function portLinks(ports) {
    const box = el('span', 'auto-ports');
    for (const p of String(ports || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const a = el('a', 'auto-port', `:${p}`);
      a.title = tr('Open http://localhost:{port} in the browser', { port: p });
      a.onclick = (e) => { e.stopPropagation(); ide.api.invoke('shell:openExternal', `http://localhost:${p}`); };
      box.append(a);
    }
    return box;
  }
  function menuButton(cls, items) {
    const b = iconButton('moreVertical', tr('More'), cls, () => { const r = b.getBoundingClientRect(); ide.ui.contextMenu(r.right - 180, r.bottom + 4, items()).classList.add('auto-menu'); });
    return b;
  }
  async function removeAfterAsking(what, run, title = tr('Remove Containers')) {
    if (await ide.ui.confirm(what, { title, ok: tr('Remove') })) run();
  }

  const inContainer = (tool) => !!ide.settings.get(`automation.container:${tool}:${ide.root}`, false);
  function image(d, action) {
    if (!trusted()) return;
    const type = ide.run.types.get('docker-image');
    ide.run.runConfig({ ...type.defaults(), id: `automation:image:${d.file.toLowerCase()}:${action}`, type: 'docker-image', name: `docker ${action} ${d.image}`, file: d.file, action });
  }

  function compose(file, action, service = '') {
    if (!trusted()) return;
    const type = ide.run.types.get('docker-compose');
    ide.run.runConfig({ ...type.defaults(), id: `automation:${file.toLowerCase()}:${action}:${service}`, type: 'docker-compose', name: composeTitle(action, service), file, action, service });
  }
  function task(build, goals) {
    if (!trusted()) return;
    if (inContainer(build.tool)) {
      const kind = ide.run.types.get('container-build');
      return ide.run.runConfig({ ...kind.defaults(), id: `automation:container:${build.tool}:${goals}`, type: 'container-build', name: `${build.tool === 'gradle' ? 'gradle' : 'mvn'} ${goals} (${tr('container')})`, tool: build.tool, goals });
    }
    const type = ide.run.types.get('build');
    if (!type) return ide.ui.alert(tr('Gradle and Maven tasks run through the Toolchains plugin, which is turned off. Turn it on in Settings › Plugins.'));
    ide.run.runConfig({ ...type.defaults(), id: `automation:${build.tool}:${goals}`, type: 'build', name: `${build.wrapper ? (build.tool === 'gradle' ? 'gradlew' : 'mvnw') : build.tool === 'gradle' ? 'gradle' : 'mvn'} ${goals}`, tool: build.tool, goals });
  }

  // ---------- data ----------
  async function refresh() {
    const mine = ++seq;
    if (!ide.root) { found = { compose: [], dockerfiles: [], builds: [] }; docker = null; services.clear(); return render(); }
    const [f, d] = await Promise.all([invoke('detect', ide.root).catch(() => ({ compose: [], dockerfiles: [], builds: [] })),
      invoke('docker').catch((err) => ({ found: true, error: errorText(err) }))]);
    if (mine !== seq) return;
    found = f;
    docker = d;
    for (const k of [...services.keys()]) if (!found.compose.some((c) => c.file === k)) services.delete(k);
    render();
    await refreshServices();
  }
  async function refreshServices() {
    if (!ide.root || !docker?.found || docker.error || ide.trusted === false) return;
    // A reading asked for earlier may answer later (docker was busy starting things): only the newest one is shown.
    const mine = seq;
    const turn = ++serviceTurn;
    const read = new Map();
    const [all] = await Promise.all([invoke('containers').catch(() => ({ containers: [] })), ...found.compose.map(async (c) => {
      read.set(c.file, await invoke('services', ide.root, c.file).catch((err) => ({ error: errorText(err) })));
    })]);
    if (mine !== seq || turn !== serviceTurn) return;
    for (const [file, r] of read) services.set(file, r);
    const own = new Set([...services.values()].flatMap((r) => (r.services || []).map((s) => s.container)).filter(Boolean));
    // The Ports tool window lists what the project's running services publish, so each can be opened and shared there.
    const published = [...services.values()].flatMap((r) => (r.services || []).filter((s) => isUp(s.state)).flatMap((s) => (s.published || []).map((p) => ({ port: p.port, address: p.address, name: s.name }))));
    ide.ports?.setContainers?.(published);
    others = (all.containers || []).filter((c) => !own.has(c.name));
    render();
    // What the running ones use takes docker a second or two to measure: it follows, and the list does not wait for it.
    const running = (all.containers || []).some((c) => isUp(c.state)) || [...services.values()].some((r) => (r.services || []).some((x) => isUp(x.state)));
    const [st, sto] = await Promise.all([running ? invoke('stats').catch(() => ({})) : {}, opened.has('images') || opened.has('volumes') ? invoke('storage').catch(() => null) : storage]);
    if (mine !== seq || turn !== serviceTurn) return;
    stats = st;
    storage = sto;
    render();
  }
  const visible = () => tw.isVisible();
  function poll() {
    clearInterval(timer);
    timer = setInterval(() => { if (visible() && (found.compose.length || found.dockerfiles.length) && document.visibilityState === 'visible') refreshServices(); }, POLL_MS);
  }

  // ---------- drawing ----------
  function iconButton(icon, title, cls, onClick) {
    const b = el('button', `auto-icon ${cls}`);
    b.append(ide.icon(icon));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  }
  function textButton(label, cls, onClick, title) {
    const b = el('button', `secondary auto-btn ${cls}`, label);
    if (title) b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  }
  function section(id, icon, title, note, body) {
    const open = !collapsed.has(id);
    const box = el('div', `auto-section auto-${id}`);
    const head = el('div', 'auto-head');
    const arrow = ide.ui.twisty('auto-twisty', open);
    const name = el('span', 'auto-head-title', title);
    head.append(arrow, icon, name);
    if (note) head.append(el('span', 'auto-head-note muted', note));
    head.onclick = () => {
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      ide.settings.set('automation.collapsed', [...collapsed]);
      render();
    };
    box.append(head);
    if (open) box.append(...body());
    return box;
  }
  const STATE = () => ({ running: tr('Running'), exited: tr('Stopped'), created: tr('Created'), paused: tr('Paused'), restarting: tr('Restarting'), dead: tr('Stopped'), '': tr('Not created') });

  function serviceRow(c, s) {
    const row = el('div', `auto-row auto-service ${s.state || 'none'}`);
    row.dataset.service = s.name;
    const name = el('span', 'auto-name', s.name);
    name.dataset.userText = '';
    const state = el('span', 'auto-state muted', `${STATE()[s.state] ?? s.state}${s.health && s.health !== 'healthy' ? ` · ${s.health}` : ''}`);
    state.title = [s.status, s.image].filter(Boolean).join(' · ');
    const running = isUp(s.state);
    const items = () => [
      running ? { label: tr('Stop'), icon: 'runStop', run: () => compose(c.file, 'stop', s.name) } : { label: tr('Start'), icon: 'runRun', run: () => compose(c.file, 'up', s.name) },
      { label: tr('Restart'), icon: 'rerun', run: () => compose(c.file, 'restart', s.name) },
      { label: tr('Logs'), icon: 'text', run: () => compose(c.file, 'logs', s.name) },
      { label: tr('Open a Terminal in It'), icon: 'terminal', disabled: !running || !s.container, run: () => terminal(s.container) },
      { separator: true },
      { label: tr('Build Images'), run: () => compose(c.file, 'build', s.name) },
    ];
    if (s.exit) row.classList.add('failed');
    row.append(el('span', `auto-dot${running ? ' on' : ''}${s.exit ? ' bad' : ''}`), name, state, portLinks(s.ports), el('span', 'auto-usage muted', running ? usageOf(s.container) : ''), el('span', 'spacer'),
      running ? iconButton('runStop', tr('Stop {name}', { name: s.name }), 'auto-stop', () => compose(c.file, 'stop', s.name))
        : iconButton('runRun', tr('Start {name}', { name: s.name }), 'auto-start', () => compose(c.file, 'up', s.name)),
      iconButton('text', tr('Logs of {name}', { name: s.name }), 'auto-logs', () => compose(c.file, 'logs', s.name)),
      menuButton('auto-service-more', items));
    row.oncontextmenu = (e) => { e.preventDefault(); ide.ui.contextMenu(e.clientX, e.clientY, items()).classList.add('auto-menu'); };
    return row;
  }
  // A container that is not one of the project's services: the same row, by its own id.
  function containerRow(c) {
    const row = el('div', `auto-row auto-service auto-other ${c.state || 'none'}`);
    row.dataset.container = c.name;
    const name = el('span', 'auto-name', c.name);
    name.dataset.userText = '';
    const state = el('span', 'auto-state muted', STATE()[c.state] ?? c.state);
    state.title = [c.status, c.image, c.project && tr('compose project {name}', { name: c.project })].filter(Boolean).join(' · ');
    const running = isUp(c.state);
    const remove = () => removeAfterAsking(tr('Remove the container {name}? What it wrote inside itself is lost; its volumes stay.', { name: c.name }), () => container(c, 'rm'));
    const items = () => [
      running ? { label: tr('Stop'), icon: 'runStop', run: () => container(c, 'stop') } : { label: tr('Start'), icon: 'runRun', run: () => container(c, 'start') },
      { label: tr('Restart'), icon: 'rerun', run: () => container(c, 'restart') },
      { label: tr('Logs'), icon: 'text', run: () => container(c, 'logs') },
      { label: tr('Open a Terminal in It'), icon: 'terminal', disabled: !running, run: () => terminal(c.name) },
      { separator: true },
      { label: tr('Remove…'), icon: 'clear', run: remove },
    ];
    if (c.exit) { row.classList.add('failed'); state.textContent = `${state.textContent} (${c.exit})`; }
    row.append(el('span', `auto-dot${running ? ' on' : ''}${c.exit ? ' bad' : ''}`), name, state, portLinks(c.ports), el('span', 'auto-usage muted', running ? usageOf(c.name) : ''), el('span', 'spacer'),
      running ? iconButton('runStop', tr('Stop {name}', { name: c.name }), 'auto-stop', () => container(c, 'stop'))
        : iconButton('runRun', tr('Start {name}', { name: c.name }), 'auto-start', () => container(c, 'start')),
      iconButton('text', tr('Logs of {name}', { name: c.name }), 'auto-logs', () => container(c, 'logs')),
      menuButton('auto-other-more', items));
    row.oncontextmenu = (e) => { e.preventDefault(); ide.ui.contextMenu(e.clientX, e.clientY, items()).classList.add('auto-menu'); };
    return row;
  }

  function composeBox(c) {
    const box = el('div', 'auto-file');
    box.dataset.file = c.rel;
    const head = el('div', 'auto-row auto-file-head');
    const name = el('span', 'auto-name auto-file-name', c.rel);
    name.dataset.userText = '';
    name.title = tr('Open {file}', { file: c.rel });
    name.onclick = () => ide.openFile(c.file);
    const usable = docker?.found && !docker.error;
    const r = services.get(c.file);
    const list = r?.services || [];
    const up = list.filter((s) => isUp(s.state)).length;
    const made = list.filter((s) => s.state).length;
    // As Docker Desktop's row of a compose project: how many of its containers run, and one button for all of them.
    const summary = el('span', `auto-summary muted${up ? ' on' : ''}`, !list.length ? '' : up ? tr('Running ({up}/{all})', { up, all: list.length }) : made ? tr('Stopped') : tr('Not created'));
    const down = () => removeAfterAsking(tr('Stop and remove the containers of {file}? Its images and volumes stay.', { file: c.rel }), () => compose(c.file, 'down'));
    const items = () => [
      { label: tr('Start All'), icon: 'runRun', run: () => compose(c.file, 'up') },
      { label: tr('Stop All'), icon: 'runStop', disabled: !up, run: () => compose(c.file, 'stop') },
      { label: tr('Restart All'), icon: 'rerun', disabled: !made, run: () => compose(c.file, 'restart') },
      { label: tr('Logs'), icon: 'text', disabled: !made, run: () => compose(c.file, 'logs') },
      { separator: true },
      { label: tr('Build Images'), run: () => compose(c.file, 'build') },
      { label: tr('Open {file}', { file: c.rel }), run: () => ide.openFile(c.file) },
      { separator: true },
      { label: tr('Remove Containers…'), icon: 'clear', disabled: !made, run: down },
    ];
    const buttons = [
      up ? iconButton('runStop', tr('Stop every service (docker compose stop)'), 'auto-stop-all', () => compose(c.file, 'stop'))
        : iconButton('runRun', tr('Build what is missing and start every service, waiting until each runs and is healthy (docker compose up -d --wait)'), 'auto-up', () => compose(c.file, 'up')),
      iconButton('text', tr('Follow the output of every service (docker compose logs -f)'), 'auto-logs-all', () => compose(c.file, 'logs')),
      iconButton('clear', tr('Stop and remove the containers (docker compose down)'), 'auto-down', down),
      menuButton('auto-file-more', items),
    ];
    for (const b of buttons) b.disabled = !usable;
    if (!made) { buttons[1].disabled = true; buttons[2].disabled = true; }
    head.append(ide.fileIcon(c.file), name, summary, el('span', 'spacer'), ...buttons);
    head.oncontextmenu = (e) => { if (!usable) return; e.preventDefault(); ide.ui.contextMenu(e.clientX, e.clientY, items()).classList.add('auto-menu'); };
    box.append(head);
    if (r?.error) {
      const why = el('div', 'auto-error', r.error);
      why.dataset.userText = '';
      box.append(why);
      const hint = hintOf(r.error);
      if (hint) box.append(el('div', 'auto-hint muted', hint));
      const missing = /required variable (\w+) is missing a value/.exec(r.error)?.[1];
      if (missing || /env file .* not found/i.test(r.error)) {
        const open = el('a', 'auto-link auto-open-env', tr('Open .env'));
        open.onclick = () => openEnv(c.file, missing);
        const line = el('div', 'auto-hint');
        line.append(open);
        box.append(line);
      }
    } else if (r?.services) {
      if (!r.services.length) box.append(el('div', 'auto-hint muted', tr('This file has no services.')));
      for (const s of r.services) {
        box.append(serviceRow(c, s));
        if (s.exit) box.append(whyBox(s.exit, s.why));
      }
    } else if (usable && ide.trusted !== false) box.append(el('div', 'auto-hint muted', tr('Reading the services…')));
    return box;
  }
  // The .env beside a compose file, at the line of a variable (made from .env.example when there is none yet).
  async function openEnv(composePath, variable) {
    const dir = composePath.replace(/[\\/][^\\/]+$/, '');
    const file = `${dir}\\.env`;
    if (!(await ide.api.exists(file))) {
      const sample = `${dir}\\.env.example`;
      const text = (await ide.api.exists(sample)) ? await ide.api.invoke('fs:readText', sample).catch(() => '') : '';
      await ide.api.invoke('fs:writeText', file, typeof text === 'string' ? text : text?.text || '').catch(() => {});
      ide.refreshTree?.();
    }
    await ide.openFile(file, { asText: true });
    const model = ide.editor?.getModel?.();
    if (!variable || !model) return;
    const at = model.getLinesContent().findIndex((l) => new RegExp(`^\\s*${variable}\\s*=`).test(l));
    if (at < 0) return;
    const col = model.getLineMaxColumn(at + 1);
    ide.editor.setPosition({ lineNumber: at + 1, column: col });
    ide.editor.revealLineInCenter(at + 1);
    ide.editor.focus();
  }
  // What to do about the errors docker compose gives most.
  function hintOf(error) {
    const env = /required variable (\w+) is missing a value/.exec(error);
    if (env) return tr('Give {name} a value in the .env file next to the compose file, then press Refresh.', { name: env[1] });
    if (/env file .* not found/i.test(error)) return tr('Make the .env file the compose file names (often a copy of .env.example), then press Refresh.');
    if (/port is already allocated|address already in use/i.test(error)) return tr('Another program uses that port. Stop it, or change the port in the compose file.');
    return '';
  }

  function dockerBody() {
    const out = [];
    if (!docker) out.push(el('div', 'auto-hint muted', tr('Looking for Docker…')));
    else if (!docker.found) {
      out.push(el('div', 'auto-error auto-docker-missing', tr('Docker was not found on this computer.')),
        el('div', 'auto-hint muted', tr('Install Docker Desktop and start it, then press Refresh.')));
    } else if (docker.error) {
      const why = el('div', 'auto-error auto-docker-off', tr('Docker is installed, but its engine is not running.'));
      why.title = docker.error;
      out.push(why, el('div', 'auto-hint muted', tr('Start Docker Desktop and wait until it says it is running, then press Refresh.')));
    }
    if (ide.trusted === false) out.push(el('div', 'auto-hint muted', tr('Safe Mode: the services are not read and nothing is started.')));
    for (const c of found.compose) out.push(composeBox(c));
    // Without a compose file each Dockerfile is built and run by itself.
    if (!found.compose.length) {
      const usable = docker?.found && !docker.error;
      for (const d of found.dockerfiles) {
        const row = el('div', 'auto-row auto-file-head auto-dockerfile');
        row.dataset.file = d.rel;
        const name = el('span', 'auto-name auto-file-name', d.rel);
        name.dataset.userText = '';
        name.onclick = () => ide.openFile(d.file);
        const buttons = [
          textButton(tr('Build Images'), 'auto-image-build', () => image(d, 'build'), tr('Builds the image {image} from this Dockerfile (docker build)', { image: d.image })),
          textButton(tr('Run'), 'auto-image-run', () => image(d, 'run'), tr('Runs a container of {image}, its EXPOSEd ports on the same numbers of this computer (docker run --rm)', { image: d.image })),
          textButton(tr('Stop'), 'auto-image-stop', () => image(d, 'stop'), tr('Stops the container {image} (docker stop)', { image: d.image })),
        ];
        for (const b of buttons) b.disabled = !usable;
        row.append(ide.fileIcon(d.file), name, el('span', 'spacer'), ...buttons);
        out.push(row);
      }
    }
    if (others.length && docker?.found && !docker.error) {
      out.push(el('div', 'auto-subhead muted', tr('Other containers on this computer')));
      for (const c of others) out.push(containerRow(c));
    }
    if (docker?.found && !docker.error) out.push(...storagePart('images', tr('Images')), ...storagePart('volumes', tr('Volumes')));
    return out;
  }

  // Images and volumes: folded at first, read when opened.
  function storagePart(kind, title) {
    const open = opened.has(kind);
    const head = el('div', `auto-subhead auto-fold auto-${kind}-head muted`);
    const list = storage?.[kind] || [];
    head.append(ide.ui.twisty('auto-twisty', open), el('span', null, open && storage ? `${title} (${list.length})` : title));
    head.onclick = () => {
      open ? opened.delete(kind) : opened.add(kind);
      ide.settings.set('automation.opened', [...opened]);
      render();
      if (!open) refreshServices();
    };
    if (!open) return [head];
    if (!storage) return [head, el('div', 'auto-hint muted', tr('Reading…'))];
    const rows = list.map((o) => {
      const row = el('div', `auto-row auto-service auto-object auto-${kind}-row`);
      row.dataset.name = o.name;
      const name = el('span', 'auto-name', o.name);
      name.dataset.userText = '';
      row.append(name, el('span', 'auto-state muted', kind === 'images' ? [o.size, o.created, o.used ? tr('in use') : ''].filter(Boolean).join(' · ') : ''), el('span', 'spacer'),
        iconButton('clear', tr('Remove…'), 'auto-object-remove', () => removeObject(kind === 'images' ? 'image' : 'volume', kind === 'images' ? o.id : o.name, o.name)));
      return row;
    });
    return [head, ...(rows.length ? rows : [el('div', 'auto-hint muted', tr('None'))])];
  }

  function buildBody(b) {
    // In a container the tasks need no JDK on this computer: the build's Java comes with the image.
    const where = el('label', 'auto-row auto-container');
    const box = el('input');
    box.type = 'checkbox';
    box.className = 'auto-container-box';
    box.checked = inContainer(b.tool);
    box.disabled = !(docker?.found && !docker.error);
    box.onchange = () => ide.settings.set(`automation.container:${b.tool}:${ide.root}`, box.checked);
    where.append(box, el('span', null, tr('Run in a container (Java {java})', { java: b.java })));
    where.title = tr('Runs the tasks inside a Docker container of the JDK this build asks for, with the project mounted in it. No JDK on this computer is used.');
    const out = [where, ...b.tasks.map((t) => {
      const row = el('div', 'auto-row auto-task');
      row.dataset.task = t;
      row.append(el('span', 'auto-name', t), el('span', 'spacer'), iconButton('runRun', tr('Run {task}', { task: t }), 'auto-run', () => task(b, t)));
      row.ondblclick = () => task(b, t);
      return row;
    })];
    const form = el('form', 'auto-row auto-custom');
    const input = el('input', 'input auto-custom-input');
    input.placeholder = b.tool === 'gradle' ? tr('Another task, such as bootJar -x test') : tr('Another goal, such as verify');
    input.setAttribute('aria-label', input.placeholder);
    form.append(input, iconButton('runRun', tr('Run'), 'auto-run-custom', () => form.requestSubmit()));
    form.onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (v) task(b, v); };
    out.push(form);
    return out;
  }

  function render() {
    if (!host) return;
    const top = host.scrollTop;
    host.replaceChildren();
    const hasDocker = found.compose.length || found.dockerfiles.length;
    if (!ide.root || (!hasDocker && !found.builds.length)) {
      const empty = el('div', 'auto-empty', ide.root ? tr('Nothing to automate here') : tr('Open a project to see what it can run'));
      host.append(empty);
      if (ide.root) host.append(el('div', 'auto-hint muted', tr('A compose.yaml, a Dockerfile, a build.gradle or a pom.xml in the project shows here with buttons to run it.')));
      return;
    }
    if (hasDocker) {
      const note = docker?.found && !docker.error ? `Docker ${docker.server}` : '';
      host.append(section('docker', ide.fileIcon('Dockerfile'), 'Docker', note, dockerBody));
    }
    for (const b of found.builds) host.append(section(b.tool, ide.icon(b.tool), b.title, b.wrapper ? tr('wrapper') : '', () => buildBody(b)));
    host.scrollTop = top;
  }

  const tw = ide.registerToolWindow({
    id: 'Automation', title: tr('Automation'), iconName: 'automation', icon: '⚙', side: 'right', order: 30,
    mount(container) {
      container.classList.add('auto-tool');
      host = el('div', 'auto-list');
      host.id = 'autoList';
      container.append(host);
      render();
    },
  });
  tw.setActions([{ icon: 'refresh', title: tr('Refresh'), domId: 'autoRefresh', run: () => refresh() }]);

  let fsTimer = 0;
  ide.on('projectOpened', () => { services.clear(); refresh(); });
  ide.on('projectClosed', () => { services.clear(); ide.ports?.setContainers?.([]); refresh(); });
  ide.on('filesChanged', () => { clearTimeout(fsTimer); fsTimer = setTimeout(() => { if (visible()) refresh(); }, 1500); });
  ide.on('toolWindowShown', (id) => { if (id === 'Automation') refresh(); });
  poll();
  if (ide.root) refresh();

  ide.registerAction({ id: 'Automation.Show', title: tr('Automation: Docker and Build Tasks'), run: () => tw.show() });
  ide.automation = { refresh, state: () => ({ found, docker, services: Object.fromEntries(services) }) };
})();
