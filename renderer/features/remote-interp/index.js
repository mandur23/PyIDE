// Remote interpreters, like PyCharm's Add Interpreter > On WSL / On SSH / On Docker / On Docker Compose.
// Targets live in the `interpreters.remote` setting (no secrets: passwords and passphrases stay in the main process,
// encrypted with safeStorage). Each target becomes an interpreter in ide.interps with a `target` field, and the
// run, debug, test, console, terminal, packages and Pyright features route through main/remote for it.
(() => {
  const { el, joinPath } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(`remote-interp:${ch}`, ...args);
  const KEY = 'interpreters.remote';
  const targets = () => ide.settings.get(KEY, []);
  const saveTargets = (list) => ide.settings.set(KEY, list);

  // Messages the main process shows (consoles, form errors): main/remote/messages.js substitutes {placeholders}.
  const MAIN_MESSAGES = [
    'WSL is not installed (wsl.exe was not found).',
    'The OpenSSH client is not installed (ssh was not found on PATH).',
    'Docker is not installed (docker was not found on PATH).',
    'No WSL distributions are installed.',
    'The Docker daemon is not running.',
    '{what} failed (exit code {code})',
    '{what} failed (exit code {code}): {detail}',
    'Connecting to {target}',
    'Uploading IDE helpers',
    'Uploading the project',
    'Starting a container for {target}',
    'Port {port} of {container} is not published',
    'Finding a free port in the target',
    'All debug ports of the container are in use',
    'Reading the interpreter paths',
    'Listing library files',
    'Downloading library files',
    'No Python interpreter was found in the target.',
    'Python did not start.',
  ];
  invoke('messages', Object.fromEntries(MAIN_MESSAGES.map((m) => [m, tr(m)]))).catch(() => {});

  const KINDS = {
    wsl: { menu: () => tr('On WSL…'), title: () => tr('New Interpreter on WSL'), name: () => tr('WSL') },
    ssh: { menu: () => tr('On SSH…'), title: () => tr('New Interpreter on SSH'), name: () => tr('SSH') },
    docker: { menu: () => tr('On Docker…'), title: () => tr('New Interpreter on Docker'), name: () => tr('Docker') },
    compose: { menu: () => tr('On Docker Compose…'), title: () => tr('New Interpreter on Docker Compose'), name: () => tr('Docker Compose') },
  };

  // ---------- interpreters ----------
  // cmd is what consoles print before a command line. It is deliberately not a program: a feature that still spawns
  // interp.cmd itself fails at once instead of starting ssh or wsl.exe with Windows paths.
  const toInterp = (t, root) => ({
    cmd: t.executable.replace(/#[^#]*$/, ''), args: [], executable: t.executable, version: t.version,
    label: `${t.name} (Python ${t.version})`, target: { ...t, root: root || null },
  });
  ide.interpreterProviders.push(async (root) => targets().map((t) => toInterp(t, root)));

  // Paths a target printed (tracebacks in Run, the console, test output) open the local file.
  const maps = new Map(); // target id -> {root, map: {entries, automount, distro}}
  ide.api.on('remote-interp:map', (m) => maps.set(m.id, m));
  const under = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);
  function toLocal(map, p) {
    if (typeof p !== 'string' || !p.startsWith('/')) return null;
    const hit = [...map.entries].sort((a, b) => b.remote.length - a.remote.length).find((e) => under(p, e.remote));
    if (hit) return `${hit.local}${p.slice(hit.remote.length)}`.replace(/\//g, '\\');
    if (map.automount && p.startsWith(map.automount)) {
      const m = /^([a-z])(\/.*)?$/i.exec(p.slice(map.automount.length));
      if (m) return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`;
    }
    return map.distro ? `\\\\wsl.localhost\\${map.distro}${p.replace(/\//g, '\\')}` : null;
  }
  ide.pathMappers.push((p) => {
    const t = ide.currentInterp()?.target;
    const m = t && maps.get(t.id);
    return m ? toLocal(m.map, p) : null;
  });

  // ---------- Pyright libraries ----------
  // Pyright runs here; main copies the target's site-packages (.py/.pyi) and points Pyright at the copy.
  const statusEl = el('span', 'remote-interp-status hidden');
  statusEl.id = 'remoteInterpStatus';
  ide.registerStatusItem({ order: 21, el: statusEl });
  let syncing = null;
  let again = false;
  let lastSync = null;
  async function syncLibs() {
    if (syncing) { again = true; return syncing; }
    const interp = ide.currentInterp();
    if (!interp?.target) { statusEl.classList.add('hidden'); return null; }
    statusEl.classList.remove('hidden', 'error');
    statusEl.textContent = tr('Syncing {name} libraries…', { name: interp.target.name });
    statusEl.title = tr('Copying the interpreter libraries so Pyright can resolve imports');
    syncing = (async () => {
      const r = await invoke('syncLibs', interp);
      lastSync = { ...r, id: interp.target.id };
      if (r.ok) {
        statusEl.textContent = tr('{name}: {count} library folders', { name: interp.target.name, count: r.local.length });
        statusEl.title = r.paths.join('\n');
        if (ide.currentInterp()?.target?.id === interp.target.id) await ide.lsp?.restart();
      } else {
        statusEl.classList.add('error');
        statusEl.textContent = tr('Pyright library sync failed');
        statusEl.title = r.error;
      }
      return r;
    })();
    try { return await syncing; } finally {
      syncing = null;
      if (again) { again = false; syncLibs(); }
    }
  }
  ide.on('interpreterChanged', () => { syncLibs(); });
  ide.api.on('remote-interp:packagesChanged', (id) => { if (ide.currentInterp()?.target?.id === id) syncLibs(); });

  // ---------- detection ----------
  let detected = null;
  const detect = (fresh) => {
    if (fresh || !detected) detected = invoke('detect').catch((err) => ({ error: String(err.message || err) }));
    return detected;
  };
  const availability = (info, kind) => {
    const d = kind === 'compose' ? info.docker : info[kind];
    if (!d) return { ok: false, reason: info.error || '' };
    if (!d.available) return { ok: false, reason: d.reason + (d.detail ? ` (${d.detail})` : '') };
    if (kind === 'compose' && !d.compose) return { ok: false, reason: tr('Docker Compose is not installed.') };
    return { ok: true, info: d };
  };

  // ---------- Add Interpreter forms (Settings › Python Interpreter) ----------
  const field = (label, control, hint) => {
    const row = el('label', 'field');
    row.append(el('span', null, label), control);
    if (hint) row.appendChild(el('span', 'field-hint muted', hint));
    return row;
  };
  const input = (id, value = '', placeholder = '', type = 'text') => {
    const i = el('input');
    Object.assign(i, { id, value, placeholder, type, spellcheck: false });
    return i;
  };
  const select = (id, options) => {
    const s = el('select');
    s.id = id;
    for (const [v, label] of options) s.add(new Option(label, v));
    return s;
  };

  async function openForm(kind, { form, status, useInterpreter }) {
    const k = KINDS[kind];
    form.classList.remove('hidden');
    const box = el('div', 'remote-form');
    box.id = 'remoteInterpForm';
    box.dataset.kind = kind;
    box.dataset.enter = 'remote'; // Enter submits this form, not the venv form that shares the container
    form.replaceChildren(box);
    const note = el('div', 'muted settings-note', tr('Detecting…'));
    note.id = 'remoteAvailability';
    const fields = el('div', 'remote-fields');
    const add = el('button', 'primary', tr('Add'));
    add.id = 'remoteAdd';
    add.disabled = true;
    const cancel = el('button', 'secondary', tr('Cancel'));
    const btns = el('div', 'venv-buttons');
    btns.append(add, cancel);
    const log = el('pre', 'venv-log');
    log.id = 'remoteLog';
    box.append(el('div', 'settings-subtitle', k.title()), note, fields, btns, log);
    cancel.onclick = () => form.classList.add('hidden');

    const a = availability(await detect(), kind);
    if (!box.isConnected) return;
    if (!a.ok) {
      note.textContent = tr('{kind} is not available: {reason}', { kind: k.name(), reason: a.reason });
      note.classList.add('remote-unavailable');
      return;
    }
    note.textContent = kind === 'wsl' ? tr('{count} WSL distributions found', { count: a.info.distros.length })
      : kind === 'ssh' ? tr('{count} hosts in ~/.ssh/config', { count: a.info.hosts.length })
        : tr('Docker {version}', { version: a.info.version });

    const python = input('remotePython', '', tr('Detect automatically (python3, then python)'));
    let collect;
    if (kind === 'wsl') {
      const distro = select('remoteDistro', a.info.distros.map((d) => [d.name, `${d.name}${d.default ? ` ${tr('(default)')}` : ''} · WSL ${d.version}`]));
      const def = a.info.distros.findIndex((d) => d.default);
      if (def >= 0) distro.selectedIndex = def;
      fields.append(field(tr('Distribution:'), distro));
      collect = () => ({ target: { kind, distro: distro.value } });
    } else if (kind === 'ssh') {
      const list = el('datalist');
      list.id = 'remoteHostList';
      for (const h of a.info.hosts) list.appendChild(new Option(h.hostName ? `${h.hostName}${h.user ? ` (${h.user})` : ''}` : '', h.alias));
      const host = input('remoteHost', '', tr('host name, address or ~/.ssh/config alias'));
      host.setAttribute('list', list.id);
      const port = input('remotePort', '', '22');
      const user = input('remoteUser', '', tr('From ~/.ssh/config or your Windows user'));
      const auth = select('remoteAuth', [['key', tr('Key pair, agent or ~/.ssh/config')], ['password', tr('Password')]]);
      const key = input('remoteKey', '', tr('Optional: private key file'));
      const browse = el('button', 'secondary', tr('Browse…'));
      browse.onclick = async (e) => {
        e.preventDefault();
        const f = await ide.api.openFileDialog([{ name: tr('All files'), extensions: ['*'] }]);
        if (f) key.value = f;
      };
      const keyRow = el('div', 'remote-key');
      keyRow.append(key, browse);
      const passphrase = input('remotePassphrase', '', tr('Only for an encrypted key'), 'password');
      const password = input('remotePassword', '', '', 'password');
      const dir = input('remoteDir', '', tr('Default: ~/pyide-projects/{name}', { name: ide.root ? ide.util.basename(ide.root) : '' }));
      const rows = {
        key: [field(tr('Private key:'), keyRow), field(tr('Passphrase:'), passphrase)],
        password: [field(tr('Password:'), password)],
      };
      fields.append(list, field(tr('Host:'), host), field(tr('Port:'), port), field(tr('Username:'), user), field(tr('Authentication:'), auth),
        ...rows.key, ...rows.password, field(tr('Remote project folder:'), dir, tr('The project is uploaded there before each run')));
      const showAuth = () => {
        for (const r of rows.key) r.classList.toggle('hidden', auth.value !== 'key');
        for (const r of rows.password) r.classList.toggle('hidden', auth.value !== 'password');
      };
      auth.onchange = showAuth;
      showAuth();
      host.onchange = () => {
        const h = a.info.hosts.find((x) => x.alias === host.value.trim());
        if (!h) return;
        if (h.port && !port.value) port.value = String(h.port);
        if (h.identityFile && !key.value) key.value = h.identityFile;
      };
      collect = () => {
        let h = host.value.trim();
        let u = user.value.trim();
        const at = h.lastIndexOf('@');
        if (at > 0) { u ||= h.slice(0, at); h = h.slice(at + 1); }
        if (!h) return { error: tr('Enter a host.') };
        const t = { kind, host: h, ...(u ? { user: u } : {}), ...(Number(port.value) ? { port: Number(port.value) } : {}), ...(dir.value.trim() ? { remoteDir: dir.value.trim() } : {}) };
        if (auth.value === 'key' && key.value.trim()) t.keyFile = key.value.trim();
        const secrets = auth.value === 'password' ? { password: password.value } : { passphrase: passphrase.value };
        return { target: t, secrets };
      };
    } else {
      const mount = input('remoteMount', '/opt/project');
      if (kind === 'docker') {
        const list = el('datalist');
        list.id = 'remoteImageList';
        for (const im of a.info.images) list.appendChild(new Option('', im));
        const image = input('remoteImage', '', 'python:3.12-slim');
        image.setAttribute('list', list.id);
        fields.append(list, field(tr('Image:'), image));
        collect = () => (image.value.trim() ? { target: { kind, image: image.value.trim(), mountPath: mount.value.trim() || '/opt/project' } } : { error: tr('Enter an image.') });
      } else {
        let file = '';
        for (const n of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
          if (ide.root && await ide.api.exists(joinPath(ide.root, n))) { file = joinPath(ide.root, n); break; }
        }
        const composeFile = input('remoteComposeFile', file, tr('Path to compose.yaml'));
        const service = input('remoteService', '', tr('Service name'));
        fields.append(field(tr('Configuration file:'), composeFile), field(tr('Service:'), service));
        collect = () => (composeFile.value.trim() && service.value.trim()
          ? { target: { kind, composeFile: composeFile.value.trim(), service: service.value.trim(), mountPath: mount.value.trim() || '/opt/project' } }
          : { error: tr('Enter the configuration file and a service.') });
      }
      fields.append(field(tr('Project path in container:'), mount, tr('The project folder is bind-mounted there')));
    }
    fields.append(field(tr('Python interpreter path:'), python));
    add.disabled = false;

    const submit = async () => {
      if (add.disabled) return;
      const c = collect();
      if (c.error) { log.textContent = c.error; return; }
      const target = { ...c.target, ...(python.value.trim() ? { python: python.value.trim() } : {}) };
      add.disabled = true;
      log.textContent = `${tr('Connecting and looking for Python…')}\n`;
      let r;
      try { r = await invoke('add', target, c.secrets || {}); } catch (err) { r = { ok: false, error: String(err.message || err) }; }
      add.disabled = false;
      if (!r.ok) { log.textContent = tr('Could not add the interpreter: {error}', { error: r.error }); return; }
      saveTargets([...targets().filter((t) => t.executable !== r.target.executable), r.target]);
      status.textContent = tr('Added {name}', { name: `${r.target.name} (Python ${r.target.version})` });
      form.classList.add('hidden');
      await useInterpreter(r.target.executable);
    };
    add.onclick = submit;
    box.addEventListener('enter', submit);
    (fields.querySelector('input, select') || add).focus();
  }

  ide.interpreterAddActions ||= [];
  for (const kind of Object.keys(KINDS)) ide.interpreterAddActions.push({ label: KINDS[kind].menu, run: (ctx) => openForm(kind, ctx) });

  // ---------- Settings › Remote Interpreters ----------
  async function removeTarget(t) {
    const ok = await new Promise((resolve) => ide.ui.dialog({
      title: tr('Remove Interpreter'),
      body: el('div', null, tr("Remove '{name}'? Its saved password and synced libraries are deleted too.", { name: `${t.name} (Python ${t.version})` })),
      buttons: [{ label: tr('Remove'), primary: true, run: () => resolve(true) }, { label: tr('Cancel'), run: () => resolve(false) }],
      onClose: () => resolve(false),
    }));
    if (!ok) return false;
    saveTargets(targets().filter((x) => x.id !== t.id));
    await invoke('remove', t).catch(() => {});
    await ide.reloadInterpreters();
    return true;
  }

  (ide.settingsPages ||= []).push({
    id: 'remote-interpreters',
    title: () => tr('Remote Interpreters'),
    keywords: 'wsl ssh docker compose remote interpreter target 원격 인터프리터 도커',
    mount(host) {
      const kinds = el('fieldset', 'settings-section');
      kinds.appendChild(el('legend', null, tr('Targets on This Computer')));
      const kindList = el('div', 'remote-kinds');
      kindList.id = 'remoteKinds';
      kindList.appendChild(el('div', 'muted', tr('Detecting…')));
      const refresh = el('button', 'secondary', tr('Detect Again'));
      kinds.append(kindList, refresh);
      const list = el('fieldset', 'settings-section');
      list.appendChild(el('legend', null, tr('Interpreters')));
      const rows = el('div', 'remote-list');
      rows.id = 'remoteList';
      list.appendChild(rows);
      host.append(kinds, list, el('p', 'muted settings-note', tr('Add remote interpreters in Python Interpreter › Add Interpreter.')));

      const renderKinds = async (fresh) => {
        const info = await detect(fresh);
        if (!kindList.isConnected) return;
        kindList.replaceChildren();
        for (const kind of Object.keys(KINDS)) {
          const a = availability(info, kind);
          const row = el('div', `remote-kind ${a.ok ? 'ok' : 'unavailable'}`);
          row.dataset.kind = kind;
          const detail = !a.ok ? a.reason
            : kind === 'wsl' ? a.info.distros.map((d) => d.name).join(', ')
              : kind === 'ssh' ? tr('{count} hosts in ~/.ssh/config', { count: a.info.hosts.length })
                : tr('Docker {version}', { version: a.info.version });
          const d = el('span', 'remote-kind-detail', detail);
          if (a.ok) d.dataset.userText = ''; // distribution names, versions
          row.append(el('span', 'remote-kind-name', KINDS[kind].name()), el('span', 'remote-kind-state', a.ok ? tr('Available') : tr('Unavailable')), d);
          kindList.appendChild(row);
        }
      };
      refresh.onclick = () => renderKinds(true);
      renderKinds(false);

      const renderList = () => {
        rows.replaceChildren();
        if (!targets().length) rows.appendChild(el('div', 'muted', tr('No remote interpreters')));
        for (const t of targets()) {
          const row = el('div', 'remote-row');
          const name = el('span', 'remote-row-name', `${t.name} (Python ${t.version})`);
          name.dataset.userText = '';
          const exe = el('span', 'remote-row-path muted', t.python);
          exe.dataset.userText = '';
          const sync = el('button', 'secondary', tr('Sync Libraries'));
          sync.title = tr('Copy the interpreter libraries again so Pyright sees new packages');
          sync.onclick = async () => {
            sync.disabled = true;
            const r = await invoke('syncLibs', toInterp(t, ide.root));
            sync.disabled = false;
            exe.textContent = r.ok ? tr('{count} library folders synced', { count: r.local.length }) : r.error;
            if (r.ok && ide.currentInterp()?.target?.id === t.id) ide.lsp?.restart();
          };
          const remove = el('button', 'secondary', tr('Remove'));
          remove.onclick = async () => { if (await removeTarget(t)) renderList(); };
          row.append(name, exe, sync, remove);
          rows.appendChild(row);
        }
      };
      renderList();
    },
  });

  window.__remoteInterp = { lastSync: () => lastSync, syncing: () => !!syncing, syncLibs, toLocal: (p) => ide.toLocalPath(p) };
})();
