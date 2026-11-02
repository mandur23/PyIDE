// The Minecraft screen, the whole of Nano Studio Craft in #craftHost: a list on the left, like New Project's types,
// choosing between Play (the instances, craft.js), Servers to Join (craft.js), My Servers (the list in index.js, cards
// side by side) and the Market; below them, what can be made, and Settings and About, since Craft has no main menu.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const PAGES = () => [['play', 'runRun', tr('Play Minecraft')], ['join', 'gamepad', tr('Servers to Join')], ['servers', 'desktop', tr('My Servers')], ['market', 'cart', tr('Market')]];
  let view = null;
  let page = 'play';

  function show(name = page) {
    page = name;
    if (!view) return;
    for (const b of view.nav.querySelectorAll('.mcs-page')) b.classList.toggle('selected', b.dataset.page === page);
    for (const [id] of PAGES()) view.pages[id].classList.toggle('hidden', page !== id);
    if (page === 'market') mc.market.shown();
    else if (page === 'play' || page === 'join') mc.craft.refresh();
  }

  function item(cls, icon, label, onClick) {
    const b = el('div', cls);
    b.setAttribute('role', 'option');
    b.title = label; // the only name a narrow window's list shows
    b.append(Object.assign(ide.icon(icon), { className: 'ide-icon mcs-icon' }), el('span', null, label));
    b.onclick = onClick;
    return b;
  }

  function build(host) {
    host.classList.add('mcs');
    const nav = el('div', 'mcs-nav');
    nav.setAttribute('role', 'listbox');
    const title = el('div', 'mcs-title');
    title.append(ide.icon('minecraft'), el('span', null, ide.appTitle));
    nav.append(title);
    for (const [id, icon, label] of PAGES()) {
      const b = item('mcs-page', icon, label, () => show(id));
      b.dataset.page = id;
      nav.append(b);
    }
    nav.append(el('div', 'mcs-group muted', tr('Create')),
      item('mcs-action mcs-new-instance', 'add', tr('New Instance…'), () => mc.craft.newInstance()),
      item('mcs-action mcs-new-server', 'desktop', tr('New Server…'), () => mc.newServer()),
      item('mcs-action mcs-new-pack', 'package', tr('Server from Modpack…'), () => mc.newFromModpack()),
      el('div', 'mcs-spacer'),
      item('mcs-action mcs-settings', 'settings', tr('Settings…'), () => ide.runAction('ShowSettings')),
      item('mcs-action mcs-about', 'info', tr('About Nano Studio'), () => ide.runAction('AboutPyIDE')));
    ide.ui.listKeys(nav, { rows: '.mcs-page, .mcs-action', select: (row) => row.click() });
    const servers = el('div', 'mcs-servers mc-tool');
    servers.id = 'minecraftScreen';
    const pages = { play: el('div', 'mcs-play'), join: el('div', 'mcs-join'), servers: serversPage(servers), market: el('div', 'mcs-market') };
    const body = el('div', 'mcs-body');
    body.append(...Object.values(pages));
    host.append(nav, body);
    mc.showServersIn(servers);
    mc.market.mount(pages.market);
    mc.craft.mount(pages.play, pages.join);
    return { nav, pages };
  }
  // A page like Play and Servers to Join, its head above the server list (index.js).
  function serversPage(servers) {
    const page = el('div', 'mcc-page mcs-servers-page');
    page.append(mc.craft.head(tr('My Servers'), tr('Servers that run on this computer. Start one, then Share it to give friends its join code.'),
      mc.craft.button(tr('New Server…'), 'primary mcc-new-server', () => mc.newServer(), 'add'),
      mc.craft.button(tr('Server from Modpack…'), 'secondary mcc-server-pack', () => mc.newFromModpack(), 'package')), servers);
    return page;
  }

  // The screen fills the window once the craft workspace is open. An editor tab opened from it (a server's settings, a
  // file) covers it until the last tab is closed.
  function mountCraft(host) {
    if (view || !host) return;
    host.replaceChildren();
    const box = el('div', 'mcs-craft');
    host.append(box);
    view = build(box);
    show(page);
  }
  ide.on('craftReady', (e) => mountCraft(e?.host || document.getElementById('craftHost')));
  // The plugin turned on after the window was ready.
  if (window.__ideReady && ide.root) mountCraft(document.getElementById('craftHost'));
  ide.on('activeTabChanged', () => document.body.classList.toggle('mc-craft-tab', ide.tabs.length > 0));

  ide.registerAction({ id: 'Minecraft.Open', title: tr('Minecraft Screen'), needsProject: true, run: () => show() });
  mc.screen = { show, page: () => (view ? page : null) };
})();
