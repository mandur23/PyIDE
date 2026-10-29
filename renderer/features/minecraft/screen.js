// The Minecraft screen: an editor tab with a list on the left, like New Project's types, choosing between the
// project's servers (the tool window's list, cards side by side) and the Market; below them, what can be made.
// Minecraft projects made with New Project open on it, and the tool window's Open Screen and the Market lead to it.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const PAGES = () => [['servers', '🖥', tr('Servers')], ['market', '🛒', tr('Market')]];
  let view = null;
  let page = 'servers';

  function show(name = page) {
    page = name;
    ide.openCustomTab({
      id: 'minecraft:home', title: tr('Minecraft'), icon: '⛏',
      mount: (host) => { view = build(host); },
      onClose: () => { mc.removeHost(view.servers); view = null; },
    });
    for (const b of view.nav.querySelectorAll('.mcs-page')) b.classList.toggle('selected', b.dataset.page === page);
    view.servers.classList.toggle('hidden', page !== 'servers');
    view.market.classList.toggle('hidden', page !== 'market');
    if (page === 'market') mc.market.shown();
  }

  function item(cls, icon, label, onClick) {
    const b = el('div', cls);
    b.setAttribute('role', 'option');
    b.append(el('span', 'mcs-icon', icon), el('span', null, label));
    b.onclick = onClick;
    return b;
  }

  function build(host) {
    host.classList.add('mcs');
    const nav = el('div', 'mcs-nav');
    nav.setAttribute('role', 'listbox');
    nav.append(el('div', 'mcs-title', `⛏ ${tr('Minecraft')}`));
    for (const [id, icon, label] of PAGES()) {
      const b = item('mcs-page', icon, label, () => show(id));
      b.dataset.page = id;
      nav.append(b);
    }
    nav.append(el('div', 'mcs-group muted', tr('Create')),
      item('mcs-action mcs-new-server', '＋', tr('New Server…'), () => mc.newServer()),
      item('mcs-action mcs-new-pack', '📦', tr('From Modpack…'), () => mc.newFromModpack()),
      item('mcs-action mcs-new-plugin', '🧩', tr('New Plugin…'), () => mc.newPlugin()),
      item('mcs-action mcs-new-mod', '⚙', tr('New Mod…'), () => mc.newMod()));
    ide.ui.listKeys(nav, { rows: '.mcs-page, .mcs-action', select: (row) => row.click() });
    const servers = el('div', 'mcs-servers mc-tool');
    servers.id = 'minecraftScreen';
    const market = el('div', 'mcs-market');
    const body = el('div', 'mcs-body');
    body.append(servers, market);
    host.append(nav, body);
    mc.addHost(servers);
    mc.market.mount(market);
    return { nav, servers, market };
  }

  ide.registerAction({ id: 'Minecraft.Open', title: tr('Minecraft Screen'), needsProject: true, run: () => show('servers') });
  mc.screen = { show, page: () => (view ? page : null) };
})();
