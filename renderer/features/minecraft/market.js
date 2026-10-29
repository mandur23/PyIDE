// The Minecraft Market (main/minecraft/market.js): the Minecraft screen's Market page (screen.js), which browses
// Modrinth's modpacks, mods, plugins and resource packs like a store. Mods, plugins and resource packs are searched for the chosen server (its Minecraft
// version and loader or plugin API) and installed into it with one click, required dependencies included; a modpack
// opens New Server from Modpack. Cards show what the server has installed from the Market, with Update and Remove.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const TYPES = () => [['modpack', tr('Modpacks')], ['mod', tr('Mods')], ['plugin', tr('Plugins')], ['resourcepack', tr('Resource Packs')]];
  const SORTS = () => [['relevance', tr('Relevance')], ['downloads', tr('Downloads')], ['follows', tr('Follows')], ['newest', tr('Newest')], ['updated', tr('Recently updated')]];
  const LOADERS = () => [['', tr('Any loader')], ['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge']];
  const fits = { mod: (s) => !!s.mods, plugin: (s) => !!s.plugins, resourcepack: (s) => !s.proxy };
  const state = { type: 'modpack', query: '', sort: 'relevance', server: null, loader: '', version: '', hits: [], total: 0, seq: 0, error: '' };
  let view = null;
  // Projects being installed or removed: a card drawn again meanwhile keeps its buttons off.
  const working = new Set();
  const compact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const serverOf = () => mc.servers().find((s) => s.dir === state.server) || null;
  const hosts = () => (state.type === 'modpack' ? [] : mc.servers().filter(fits[state.type]));

  async function open({ type, server } = {}) {
    await mc.refresh();
    if (type) state.type = type;
    if (server) state.server = server.dir;
    state.hits = [];
    mc.screen.show('market');
  }
  // The screen builds the page once per tab, and shows it: the first time, or after open(), it searches.
  const mount = (container) => { view = build(container); };
  function shown() {
    syncControls();
    if (!state.hits.length && !state.error) search();
  }

  function build(host) {
    host.classList.add('mcm');
    const tabs = el('div', 'mcm-tabs');
    for (const [id, label] of TYPES()) {
      const b = el('button', 'mcm-tab', label);
      b.dataset.type = id;
      b.onclick = () => { state.type = id; syncControls(); search(); };
      tabs.append(b);
    }
    const query = el('input', 'input mcm-query');
    query.id = 'mcmQuery';
    query.placeholder = tr('Search Modrinth');
    let timer = 0;
    query.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state.query = query.value.trim(); search(); }, 300); };
    const server = el('select', 'input mcm-server');
    server.id = 'mcmServer';
    server.onchange = () => { state.server = server.value; search(); };
    const loader = el('select', 'input mcm-loader');
    loader.id = 'mcmLoader';
    for (const [v, label] of LOADERS()) loader.add(new Option(label, v));
    loader.onchange = () => { state.loader = loader.value; search(); };
    const version = el('input', 'input mcm-version');
    version.id = 'mcmVersion';
    version.placeholder = tr('Minecraft version');
    version.onchange = () => { state.version = version.value.trim(); search(); };
    const sort = el('select', 'input mcm-sort');
    sort.id = 'mcmSort';
    for (const [v, label] of SORTS()) sort.add(new Option(label, v));
    sort.onchange = () => { state.sort = sort.value; search(); };
    const filters = el('div', 'mcm-filters');
    filters.append(query, server, loader, version, sort);
    const status = el('div', 'mcm-status muted');
    const grid = el('div', 'mcm-grid');
    const more = el('button', 'secondary mcm-more', tr('Show more'));
    more.onclick = () => search(true);
    const foot = el('div', 'mcm-foot muted', tr('Projects come from Modrinth (modrinth.com); each download is checked against the checksum Modrinth publishes.'));
    host.append(tabs, filters, status, grid, more, foot);
    return { host, tabs, query, server, loader, version, sort, status, grid, more };
  }

  // The filters that fit the tab: a server for what installs into one, a loader and version for modpacks.
  function syncControls() {
    if (!view) return;
    for (const b of view.tabs.children) b.classList.toggle('active', b.dataset.type === state.type);
    const list = hosts();
    if (!list.some((s) => s.dir === state.server)) state.server = list[0]?.dir || null;
    view.server.replaceChildren(...list.map((s) => new Option(`${s.name} (${mc.kindTitle(s.kind)} ${s.mc})`, s.dir)));
    if (state.server) view.server.value = state.server;
    view.server.classList.toggle('hidden', state.type === 'modpack');
    view.loader.classList.toggle('hidden', state.type !== 'modpack');
    view.version.classList.toggle('hidden', state.type !== 'modpack');
    view.query.value = state.query;
    view.sort.value = state.sort;
  }

  async function search(append = false) {
    if (!view) return;
    const seq = ++state.seq;
    if (!append) { state.hits = []; state.total = 0; }
    state.error = '';
    if (state.type !== 'modpack' && !serverOf()) {
      state.error = state.type === 'mod' ? tr('Create a Fabric, Forge or NeoForge server first: mods are found for its version and loader.')
        : state.type === 'plugin' ? tr('Create a Paper, Purpur or Velocity server first: plugins are found for its version.')
          : tr('Create a server first: resource packs are found for its Minecraft version.');
      return render();
    }
    view.status.textContent = tr('Searching…');
    try {
      const r = await ide.api.invoke('minecraft:marketSearch', {
        type: state.type, query: state.query, sort: state.sort, offset: state.hits.length,
        serverDir: state.type === 'modpack' ? null : state.server, loader: state.loader || null, mc: state.version || null,
      });
      if (seq !== state.seq) return;
      state.hits = [...state.hits, ...r.hits];
      state.total = r.total;
    } catch (err) {
      if (seq !== state.seq) return;
      state.error = mc.errorText(err);
    }
    render();
  }

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.onclick = (e) => { e.preventDefault(); onClick(b); };
    return b;
  }

  function render() {
    if (!view) return;
    const srv = serverOf();
    view.status.textContent = state.error || (state.total ? tr('{count} projects', { count: compact(state.total) }) : tr('Nothing found.'));
    view.status.classList.toggle('mcm-error', !!state.error);
    view.grid.replaceChildren(...state.hits.map((h) => card(h, srv)));
    view.more.classList.toggle('hidden', !!state.error || state.hits.length >= state.total);
  }

  function card(h, srv) {
    const c = el('div', 'mcm-card');
    c.dataset.id = h.id;
    c.dataset.slug = h.slug;
    const icon = el('img', 'mcm-icon');
    icon.alt = '';
    icon.loading = 'lazy';
    icon.referrerPolicy = 'no-referrer';
    if (h.icon) icon.src = h.icon;
    icon.onerror = () => icon.removeAttribute('src');
    const body = el('div', 'mcm-body');
    const title = el('div', 'mcm-title');
    const name = el('span', 'mcm-name', h.title);
    name.dataset.userText = '';
    title.append(name, el('span', 'mcm-author muted', tr('by {author}', { author: h.author })));
    const desc = el('div', 'mcm-desc', h.description);
    desc.dataset.userText = '';
    const meta = el('div', 'mcm-meta muted');
    meta.append(el('span', null, `⬇ ${compact(h.downloads)}`), el('span', null, `♥ ${compact(h.follows)}`),
      ...h.categories.slice(0, 4).map((x) => el('span', 'mcm-chip', x)));
    const actions = el('div', 'mcm-actions');
    const installed = srv?.market?.[h.id];
    if (state.type === 'modpack') {
      actions.append(button(tr('Create Server…'), 'primary mcm-create', () => mc.newFromModpack(h.slug)));
    } else if (installed) {
      actions.append(el('span', 'mcm-installed', tr('Installed {version}', { version: installed.version })),
        button(tr('Update'), 'secondary mcm-update', (b) => install(h, b)), button(tr('Remove'), 'secondary mcm-remove', () => remove(h, installed)));
    } else actions.append(button(tr('Install'), 'primary mcm-install', (b) => install(h, b)));
    if (working.has(h.id)) for (const b of actions.querySelectorAll('button')) { b.disabled = true; if (b.classList.contains('mcm-install')) b.textContent = tr('Installing…'); }
    actions.append(button(tr('Modrinth Page'), 'secondary mcm-page', () => ide.api.invoke('shell:openExternal', h.page)));
    body.append(title, desc, meta, actions);
    c.append(icon, body);
    return c;
  }

  async function install(h, b) {
    const srv = serverOf();
    if (!srv || ide.trusted === false || working.has(h.id)) return;
    working.add(h.id);
    b.disabled = true;
    b.textContent = tr('Installing…');
    const con = mc.jobSession(tr('Market'));
    const j = mc.job(con);
    try {
      const r = await ide.api.invoke('minecraft:marketInstall', ide.root, srv.dir, { id: h.id, type: state.type }, j.id);
      for (const i of r.installed) {
        const what = { title: i.title, version: i.version };
        con.append(`${i.dependency ? tr('{title} {version} installed (a required dependency)', what) : tr('{title} {version} installed', what)} → ${i.file}\n`, 'ok');
      }
      for (const s of r.skipped) con.append(`${tr('{title} is client-only: players add it themselves', { title: s })}\n`, 'sys');
      if (!r.installed.length) con.append(`${tr('{title} is installed already, the newest for this server', { title: h.title })}\n`, 'ok');
      if (state.type === 'resourcepack' && r.installed.length) con.append(`${tr('Send to Players on the server\'s card sends the pack to everyone who joins.')}\n`, 'sys');
      if (mc.runningAt(srv.dir)) con.append(`${tr('Restart the server to load what was added.')}\n`, 'sys');
      ide.notifications?.notify({
        title: tr('{title} installed on {server}', { title: h.title, server: srv.name }), kind: 'ok', group: 'Minecraft', raw: true,
        actions: mc.runningAt(srv.dir) ? [{ label: tr('Restart Server'), run: (n) => { n.expire(); mc.restartIfRunning(srv.dir, con); } }] : [],
      });
    } catch (err) {
      con.append(`${mc.errorText(err)}\n`, /installed already/.test(err.message || '') ? 'ok' : 'err');
    } finally { j.done(); working.delete(h.id); }
    ide.refreshTree?.();
    await mc.refresh();
    render();
  }

  async function remove(h, installed) {
    const srv = serverOf();
    if (!srv || ide.trusted === false) return;
    if (working.has(h.id) || !(await ide.ui.confirm(tr('Remove {title} {version} from {server}?', { title: h.title, version: installed.version, server: srv.name }), { ok: tr('Remove') }))) return;
    working.add(h.id);
    try {
      await ide.api.invoke('minecraft:marketRemove', ide.root, srv.dir, h.id);
    } catch (err) { ide.ui.alert(mc.errorText(err)); } finally { working.delete(h.id); }
    ide.refreshTree?.();
    await mc.refresh();
    render();
  }

  ide.on('projectOpened', () => { state.server = null; if (view) { syncControls(); search(); } });
  ide.registerAction({ id: 'Minecraft.Market', title: tr('Minecraft Market…'), needsProject: true, run: () => open() });
  mc.market = { open, mount, shown, state: () => ({ ...state }) };
})();
