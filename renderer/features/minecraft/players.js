// The Players tab (main/minecraft/players): one editor tab per server. The list on the left has everyone the server has
// seen, online first; the right side shows the selected player's overview, inventory, timeline and actions, or a search
// across players, or the admin log. It follows the minecraft:players push. The only timer is the lease that keeps
// positions polled while the tab shows. Forms are mounted once per selected player and live values are patched in place,
// so a push cannot wipe what is typed or replace a button under a click. Names, chat and item names are a stranger's
// text: they only ever go in with textContent.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const tabId = (dir) => `minecraft:players:${dir.toLowerCase()}`;
  const sameDir = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
  const call = (channel, v, ...args) => ide.api.invoke(`players:${channel}`, ide.root, v.srv.dir, ...args);
  const ROW = 46; // the height of .mcpl-row
  const LEASE_MS = 10000;
  const PAGE = 100;
  const FADE_MS = 8000; // how long a success stays
  const SEARCH_PUSH_MS = 1000;
  const ITEM_WAIT_MS = 1500; // a first search of a version may wait for its client jar: the search does not
  const later = (fn, ms = 200) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(fn, ms, ...a); }; };
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };

  const SECTIONS = () => [['overview', tr('Overview')], ['inventory', tr('Inventory')], ['timeline', tr('Timeline')], ['actions', tr('Manage')]];
  // A chip -> the event types it stands for. The last four are what the NanoBridge plugin records.
  const TYPES = () => [['join', tr('Joins'), ['join']], ['leave', tr('Leaves'), ['leave']], ['chat', tr('Chat'), ['chat']], ['death', tr('Deaths'), ['death']], ['advancement', tr('Advancements'), ['advancement']],
    ['command', tr('Commands'), ['command', 'cmd']], ['blocks', tr('Blocks'), ['break', 'place', 'ignite', 'bucket', 'sign']], ['chests', tr('Chests'), ['open', 'take', 'put']],
    ['combat', tr('Combat'), ['hit', 'hurt', 'kill', 'pvp']], ['things', tr('Items'), ['pickup', 'drop']]];
  const chipOf = (type) => TYPES().find(([, , types]) => types.includes(type));
  const GAMEMODES = () => [['survival', tr('Survival')], ['creative', tr('Creative')], ['adventure', tr('Adventure')], ['spectator', tr('Spectator')]];
  const DIMENSIONS = () => ({ 'minecraft:overworld': tr('Overworld'), 'minecraft:the_nether': tr('The Nether'), 'minecraft:the_end': tr('The End') });
  const ACTION_TITLES = () => ({
    give: tr('Give Item'), clear: tr('Clear Inventory'), replaceSlot: tr('Replace Slot'), teleport: tr('Teleport'), gamemode: tr('Game mode'), heal: tr('Heal'), feed: tr('Feed'), effect: tr('Effect'),
    whisper: tr('Whisper'), kick: tr('Kick'), ban: tr('Ban'), pardon: tr('Pardon'), op: tr('Make Operator'), deop: tr('Remove Operator'), whitelistAdd: tr('Add to Whitelist'), whitelistRemove: tr('Remove from Whitelist'),
    moveItem: tr('Move Item'), bridgeInstall: tr('Turn On Detailed Logging'), bridgeRemove: tr('Turn Off Detailed Logging'),
  });
  // A result's code -> what the tab says. main's own text for these is English.
  const RESULTS = () => ({
    notRunning: tr('The server is not running, so nothing was sent.'), proxy: tr('A proxy has no players of its own to act on.'), refused: tr('The server refused this.'),
    noAnswer: tr('Sent. The server said nothing back.'), timeout: tr('The server did not answer in time.'), stopped: tr('The server stopped before it answered.'),
    busy: tr('Too many commands are waiting. Try again in a moment.'), name: tr('That is not a player name.'), item: tr('That is not an item id. Pick one from the list, or type one such as minecraft:diamond.'),
    enchantment: tr('That is not an enchantment id.'), 'enchantment level': tr('An enchantment level is a whole number from 1 to 255.'), effect: tr('That is not an effect id.'),
    count: tr('That count is out of range.'), slot: tr('That is not an inventory slot.'), gamemode: tr('That is not a game mode.'), coordinates: tr('Coordinates must be numbers within the world.'),
    duration: tr('A duration is a whole number of seconds from 1 to 1000000.'), amplifier: tr('An amplifier is a whole number from 0 to 255.'), text: tr('The text is empty or too long (256 characters at most).'),
    version: tr('Nano Studio has no confirmed command for this on this server\'s Minecraft version, so nothing was sent.'), action: tr('That is not a player action.'),
    noItem: tr('Choose an item.'), noEffect: tr('Choose an effect.'),
    offline: tr('The player is not online, so nothing was sent.'), changed: tr('Those slots changed in the game after this tab read them, so nothing was sent. Look at the inventory again and retry.'),
    otherAccount: tr('The server does not know this name as this player\'s account right now, so nothing was sent. Names can pass to another account, and the command would reach whoever holds the name.'),
    noRoom: tr('A swap goes through an empty inventory slot, and this player has none. Nothing was sent.'), armorFit: tr('That item does not go in that armor slot, so nothing was sent.'),
    emptySlot: tr('That slot is empty, so nothing was sent.'), sameSlot: tr('The item is in that slot already.'),
    notMoved: tr('Nothing moved. The slots are as they were, and nothing was sent again.'), mismatch: tr('The slots are not what they should be after this move. Nothing was sent again: check them below.'),
    unconfirmed: tr('The commands were sent, but the server did not show the result. Check the inventory before doing anything else. Nothing was sent again.'),
  });
  const NOTES = () => ({
    heal: tr('Instant Health restores health at once. It leaves fire, poison and other effects alone, and it does not revive a dead player.'),
    feed: tr('Saturation fills the food bar at once. It does nothing for a dead player.'),
  });
  // What a confirmed action did, in the words an owner reads. `w` is what the form knew: the titles of what was picked.
  const DONE = (name, a, w) => ({
    give: () => tr('Gave {count} of {item} to {name}.', { name, item: w.item, count: a.count ?? 1 }),
    clear: () => (!a.item ? tr('Emptied the whole inventory of {name}.', { name })
      : a.count ? tr('Removed {count} of {item} from {name}.', { name, item: w.item, count: a.count }) : tr('Removed {item} from {name}.', { name, item: w.item })),
    replaceSlot: () => (a.item === 'minecraft:air' ? tr('Emptied {slot} of {name}.', { name, slot: w.slot }) : tr('Put {count} of {item} in {slot} of {name}.', { name, item: w.item, slot: w.slot, count: a.count ?? 1 })),
    teleport: () => (a.to ? tr('Moved {name} to {to}.', { name, to: a.to }) : tr('Moved {name} to {x}, {y}, {z}.', { name, x: a.x, y: a.y, z: a.z })),
    gamemode: () => tr('Set the game mode of {name} to {mode}.', { name, mode: Object.fromEntries(GAMEMODES())[a.mode] }),
    heal: () => tr('Healed {name}.', { name }),
    feed: () => tr('Filled the food bar of {name}.', { name }),
    effect: () => (!a.clear ? tr('Gave {effect} to {name}.', { name, effect: w.effect })
      : a.effect ? tr('Removed {effect} from {name}.', { name, effect: w.effect }) : tr('Removed every effect from {name}.', { name })),
    whisper: () => tr('Whispered to {name}.', { name }),
    kick: () => tr('Kicked {name}.', { name }),
    ban: () => tr('Banned {name}.', { name }),
    pardon: () => tr('Pardoned {name}.', { name }),
    op: () => tr('Made {name} an operator.', { name }),
    deop: () => tr('{name} is no longer an operator.', { name }),
    whitelistAdd: () => tr('Added {name} to the whitelist.', { name }),
    whitelistRemove: () => tr('Took {name} off the whitelist.', { name }),
    moveItem: () => (a.op === 'clear' ? tr('Threw away {item} from {slot} of {name}.', { name, item: w.item, slot: w.slot })
      : a.op === 'place' ? tr('Put {count} of {item} in {slot} of {name}.', { name, item: w.item, slot: w.slot, count: a.count ?? 1 })
        : w.swapped ? tr('Swapped {slot} and {other} of {name}.', { name, slot: w.slot, other: w.other }) : tr('Moved {item} to {slot} of {name}.', { name, item: w.item, slot: w.slot })),
  }[a.type]?.() ?? tr('It worked.'));
  const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/; // typed out in full: a bare word is a search that found nothing

  const locale = () => (i18n.locale === 'ko' ? 'ko-KR' : 'en-US');
  const stamp = (t) => (t ? new Date(t).toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  function ago(t) {
    const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000);
    if (s < 60) return tr('just now');
    if (s < 3600) return tr('{count} min ago', { count: Math.floor(s / 60) });
    if (s < 86400) return tr('{count} h ago', { count: Math.floor(s / 3600) });
    return tr('{count} d ago', { count: Math.floor(s / 86400) });
  }
  function duration(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    return hours ? tr('{hours} h {minutes} min', { hours, minutes: minutes % 60 }) : tr('{minutes} min', { minutes });
  }
  const coords = (p) => [p.x, p.y, p.z].map((n) => (Math.round(n * 10) / 10).toFixed(1)).join(', ');
  const nameOf = (p) => p.name || p.uuid.slice(0, 8);
  const pretty = (id) => { const s = String(id).replace(/^[^:]*:/, '').replace(/[_/]/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
  const itemTitle = (item) => (i18n.locale === 'ko' && item.ko ? item.ko : item.name);
  const blankNumber = (input) => (input.value.trim() === '' ? undefined : Number(input.value));
  // The game writes levels 1 to 10 in roman numerals, and no level on an enchantment that has only one.
  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const ONE_LEVEL = new Set(['aqua_affinity', 'binding_curse', 'channeling', 'flame', 'infinity', 'mending', 'multishot', 'silk_touch', 'vanishing_curse']);
  function levelText(id, level) {
    if (level === 1 && ONE_LEVEL.has(id.replace(/^minecraft:/, ''))) return '';
    return ROMAN[level] ?? String(level);
  }
  // Item data gives the damage taken and not the maximum, so these are the game's own (from memory of the wiki's tables).
  const TOOLS = { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 };
  const ARMOR = { leather: 5, chainmail: 15, iron: 15, golden: 7, diamond: 33, netherite: 37, turtle: 25 };
  const PIECES = { helmet: 11, chestplate: 16, leggings: 15, boots: 13 };
  const OTHERS = { bow: 384, crossbow: 465, trident: 250, shield: 336, elytra: 432, shears: 238, fishing_rod: 64, flint_and_steel: 64, mace: 500, brush: 64, carrot_on_a_stick: 25, warped_fungus_on_a_stick: 100 };
  function maxDurability(id) {
    const [, name] = /^minecraft:(.*)$/.exec(id) ?? [];
    if (!name) return null;
    const [, material, piece] = /^([a-z]+)_([a-z]+)$/.exec(name) ?? [];
    return OTHERS[name] ?? (PIECES[piece] && ARMOR[material] ? PIECES[piece] * ARMOR[material] : null) ?? (['sword', 'pickaxe', 'axe', 'shovel', 'hoe'].includes(piece) ? TOOLS[material] ?? null : null);
  }

  // ---------- the tab ----------
  const views = new Set();
  function open(srv) {
    ide.openCustomTab({ id: tabId(srv.dir), title: tr('{name} Players', { name: srv.name }), icon: 'minecraft', mount: (host) => mount(host, srv),
      onClose: () => { for (const v of [...views]) if (sameDir(v.srv.dir, srv.dir)) closeView(v); } });
  }
  function closeView(v) {
    mc.players.drag?.cancel(v);
    views.delete(v);
    clearInterval(v.lease);
    clearTimeout(v.searchTimer);
    clearTimeout(v.resultFade);
    hideTip();
    if (v.watching) call('watch', v, false).catch(() => {});
  }
  // Positions are polled only while a tab shows them: each one adds a line a second to the server's own log.
  function lease(v) {
    const shown = !v.host.classList.contains('hidden');
    if (!shown && !v.watching) return;
    v.watching = shown;
    call('watch', v, shown).catch(() => {});
  }
  ide.on('activeTabChanged', () => { for (const v of views) lease(v); });
  ide.api.on('minecraft:players', ({ dir, kind }) => {
    for (const v of views) {
      if (!sameDir(v.srv.dir, dir)) continue;
      refresh(v);
      if (kind === 'roster' || (kind === 'event' && v.bridgeState?.installed !== 'none' && !v.bridgeState?.active)) mc.players.bridge.paint(v);
      if (kind !== 'event') continue;
      if (v.timeline?.loaded) newEvents(v);
      if (v.page === 'search') searchSoon(v);
    }
  });
  // The run state as the Minecraft window knows it: a server starting has said nothing to its session yet.
  function paintStates() {
    for (const v of views) {
      const running = mc.runningAt(v.srv.dir);
      if (running === v.seenRunning) continue;
      v.seenRunning = running;
      refresh(v);
    }
  }

  function mount(host, srv) {
    host.classList.add('mcset', 'mcpl');
    const v = { srv, host, data: null, selected: null, player: null, detail: null, section: 'overview', page: 'player', icons: new Map(), pool: [], shown: [], gates: [], reasons: [],
      timeline: null, seq: { detail: 0, timeline: 0, log: 0 }, watching: false, seenRunning: mc.runningAt(srv.dir), listOpen: false };
    const head = el('div', 'mcset-head');
    const text = el('div', 'mcset-head-text');
    const title = el('div', 'mcset-title');
    const name = userText('span', 'mcset-name', srv.name);
    v.chip = el('span', 'mcset-state');
    title.append(name, v.chip);
    v.sub = el('div', 'mcset-sub muted');
    text.append(title, v.sub);
    const tools = el('div', 'mcset-tools');
    const reload = el('button', 'secondary mcpl-reload', tr('Refresh'));
    reload.onclick = () => { refresh(v); loadDetail(v); if (v.timeline?.loaded) loadTimeline(v); if (v.page === 'search') runSearch(v); if (v.page === 'log') loadLog(v); };
    tools.append(mc.players.bridge.button(v), reload);
    head.append(text, tools);
    v.body = el('div', 'mcpl-body');
    host.append(head, v.body);
    host.addEventListener('scroll', hideTip, true);

    v.side = el('div', 'mcpl-side');
    // Only a stacked tab shows this: the player gets the room, and the list stays one press away.
    v.fold = el('button', 'secondary mcpl-fold');
    v.fold.type = 'button';
    v.foldDot = el('span', 'mc-dot');
    v.foldName = userText('span', 'mcpl-fold-name');
    v.foldHint = el('span', 'mcpl-fold-hint muted');
    v.fold.append(v.foldDot, v.foldName, v.foldHint);
    v.fold.onclick = () => {
      v.listOpen = !v.listOpen;
      paintFold(v);
      if (!v.listOpen) return;
      v.rows.scrollTop = Math.max(0, v.shown.findIndex((p) => p.uuid === v.selected)) * ROW;
      paintRows(v);
    };
    v.find = el('input', 'input mcpl-find');
    v.find.placeholder = tr('Find a player');
    v.find.spellcheck = false;
    v.find.oninput = () => { v.shown = filtered(v); v.rows.scrollTop = 0; paintRows(v); };
    v.rows = el('div', 'mcpl-rows');
    v.spacer = el('div', 'mcpl-spacer');
    v.window = el('div', 'mcpl-window');
    v.empty = el('div', 'mcpl-empty muted hidden');
    v.rows.append(v.spacer, v.window, v.empty);
    v.rows.onscroll = () => paintRows(v);
    const pages = el('div', 'mcpl-pages');
    v.searchButton = el('button', 'secondary mcpl-open-search', tr('Search All Players'));
    v.searchButton.onclick = () => showPage(v, 'search');
    v.logButton = el('button', 'secondary mcpl-open-log', tr('Admin Log'));
    v.logButton.onclick = () => showPage(v, 'log');
    pages.append(v.searchButton, v.logButton);
    v.side.append(v.fold, v.find, v.rows, pages);

    const main = el('div', 'mcpl-main');
    v.banner = el('div', 'mcset-note mcpl-banner hidden');
    v.bannerText = el('span', 'mcpl-banner-text');
    v.start = el('button', 'primary mcpl-start', tr('Start'));
    v.start.type = 'button';
    v.start.onclick = async () => {
      v.start.disabled = true;
      await mc.startServer(srv);
      v.start.disabled = false;
    };
    v.banner.append(v.bannerText, v.start);
    v.problem = el('div', 'mcset-error mcpl-problem hidden');
    v.playerPage = el('div', 'mcpl-page');
    v.searchPage = mountSearch(v);
    v.logPage = mountLog(v);
    v.result = el('div', 'mcpl-result hidden');
    v.result.setAttribute('role', 'status');
    main.append(v.banner, v.problem, v.playerPage, v.searchPage, v.logPage, v.result);
    v.body.append(v.side, main);
    v.playerPage.append(el('div', 'mcset-loading muted', tr('Reading the players…')));
    views.add(v);
    v.lease = setInterval(() => lease(v), LEASE_MS);
    refresh(v);
    mc.players.bridge.paint(v);
  }

  // Calls overlap with pushes: one at a time, and one more when something came in meanwhile.
  async function refresh(v) {
    if (v.loading) { v.again = true; return; }
    v.loading = true;
    try {
      const data = await call('list', v);
      if (views.has(v)) apply(v, data);
    } catch (err) {
      if (views.has(v)) problem(v, mc.errorText(err));
    } finally {
      v.loading = false;
      if (v.again && views.has(v)) { v.again = false; refresh(v); }
    }
  }
  const problem = (v, text) => { v.problem.textContent = text; v.problem.classList.toggle('hidden', !text); };

  function apply(v, data) {
    const was = v.data;
    const before = v.player;
    v.data = data;
    problem(v, '');
    paintHead(v);
    if (data.proxy) {
      v.body.replaceChildren(el('div', 'mcset-note mcpl-proxy', tr('A proxy has no players of its own: it sends them on to the servers behind it. Open Players on one of those servers.')));
      return;
    }
    v.shown = filtered(v);
    paintRows(v);
    v.player = data.players.find((p) => p.uuid === v.selected) ?? null;
    paintFold(v);
    if (!v.selected) {
      if (data.players.length) select(v, data.players[0].uuid);
      else v.playerPage.replaceChildren(el('div', 'mcpl-none muted', tr('No players yet. Everyone who joins this server shows up here.')));
      return;
    }
    paintPlayer(v);
    if (before && v.player && (before.online !== v.player.online || was?.state !== data.state)) loadDetail(v);
  }
  // A start is known here before main's session hears of it: the launch step comes first and can take a while.
  const stateOf = (v) => (v.data?.state === 'stopped' && mc.runningAt(v.srv.dir) ? 'starting' : v.data?.state);
  function paintHead(v) {
    const { srv, data } = v;
    const state = stateOf(v);
    const STATES = { running: tr('Running'), starting: tr('Starting'), stopping: tr('Stopping'), stopped: tr('Stopped') };
    v.chip.classList.toggle('on', state === 'running');
    v.chip.textContent = STATES[state] ?? tr('Stopped');
    const online = data.players.filter((p) => p.online).length;
    v.sub.textContent = [`${mc.kindTitle(srv.kind)} ${srv.mc || ''}`.trim(), ...(data.proxy ? [] : [tr('{count} players', { count: data.players.length }), tr('{count} online', { count: online })])].join(' · ');
    const why = data.proxy ? '' : blocked(v);
    v.bannerText.textContent = why;
    v.banner.classList.toggle('hidden', !why);
    v.start.classList.toggle('hidden', state !== 'stopped');
  }
  // Why nothing can be sent now, or '' when the server takes commands.
  function blocked(v) {
    const state = stateOf(v);
    return state === 'running' ? '' : state === 'starting' ? tr('The server is starting. Managing players works once it is up.')
      : state === 'stopping' ? tr('The server is stopping. Managing players is off, and this is what it saved.') : tr('The server is stopped. This is what it saved, and managing players works once it runs.');
  }

  // ---------- the list ----------
  // A long list: only the rows in sight exist, and they are the same nodes from paint to paint.
  function filtered(v) {
    const q = v.find.value.trim().toLowerCase();
    const all = v.data?.players ?? [];
    return q ? all.filter((p) => String(p.name).toLowerCase().includes(q) || p.uuid.startsWith(q)) : all;
  }
  function newRow(v) {
    const node = el('button', 'mcpl-row');
    node.type = 'button';
    const dot = el('span', 'mc-dot');
    const face = el('span', 'mcset-pface');
    const text = el('span', 'mcpl-row-text');
    const name = userText('span', 'mcpl-row-name');
    const sub = el('span', 'mcpl-row-sub muted');
    const flag = el('span', 'mcpl-row-flag');
    text.append(name, sub);
    node.append(face, text, flag, dot);
    node.onclick = () => select(v, node.dataset.uuid);
    v.window.append(node);
    return { node, dot, face, name, sub, flag };
  }
  function paintRows(v) {
    const list = v.shown;
    const first = Math.max(0, Math.floor(v.rows.scrollTop / ROW) - 4);
    const count = Math.min(list.length - first, Math.ceil(window.innerHeight / ROW) + 8);
    v.spacer.style.height = `${list.length * ROW}px`;
    v.window.style.transform = `translateY(${first * ROW}px)`;
    while (v.pool.length < count) v.pool.push(newRow(v));
    v.pool.forEach((row, i) => {
      const p = list[first + i];
      row.node.classList.toggle('hidden', !p);
      if (!p) return;
      row.node.dataset.uuid = p.uuid;
      row.node.dataset.name = p.name;
      row.node.classList.toggle('selected', p.uuid === v.selected && v.page === 'player');
      row.dot.classList.toggle('on', p.online);
      row.face.textContent = nameOf(p).slice(0, 1).toUpperCase();
      row.name.textContent = nameOf(p);
      row.sub.textContent = p.online ? tr('Online') : p.lastSeen ? tr('Seen {when}', { when: ago(p.lastSeen) }) : tr('No record in this app yet');
      row.flag.textContent = p.banned ? tr('Banned') : p.op ? 'OP' : '';
      row.flag.classList.toggle('bad', p.banned);
    });
    v.empty.textContent = v.data?.players.length ? tr('No player matches that.') : tr('No players yet.');
    v.empty.classList.toggle('hidden', !!list.length);
  }
  function paintFold(v) {
    const open = v.listOpen || !v.selected;
    v.side.classList.toggle('folded', !open);
    v.fold.classList.toggle('hidden', !v.selected);
    v.fold.setAttribute('aria-expanded', String(open));
    v.foldDot.classList.toggle('on', !!v.player?.online);
    v.foldName.textContent = v.player ? nameOf(v.player) : tr('Players');
    v.foldHint.textContent = open ? tr('Fold the List') : tr('All Players');
  }
  function select(v, uuid) {
    const changed = v.selected !== uuid;
    if (changed) clearResult(v);
    showPage(v, 'player');
    v.listOpen = false;
    if (changed) {
      mc.players.drag.cancel(v);
      v.selected = uuid;
      v.player = v.data?.players.find((p) => p.uuid === uuid) ?? null;
      v.detail = null;
      buildPlayer(v);
      paintRows(v);
      loadDetail(v);
    }
    paintFold(v);
  }
  function showPage(v, page) {
    if (page !== v.page) clearResult(v);
    v.page = page;
    v.playerPage.classList.toggle('hidden', page !== 'player');
    v.searchPage.classList.toggle('hidden', page !== 'search');
    v.logPage.classList.toggle('hidden', page !== 'log');
    v.searchButton.classList.toggle('active', page === 'search');
    v.logButton.classList.toggle('active', page === 'log');
    paintRows(v);
    if (page === 'search') runSearch(v);
    if (page === 'log') loadLog(v);
  }
  function openPlayer(v, uuid) {
    const i = v.shown.findIndex((p) => p.uuid === uuid);
    if (i === -1 && v.find.value) { v.find.value = ''; v.shown = filtered(v); }
    const at = v.shown.findIndex((p) => p.uuid === uuid);
    if (at === -1) return;
    v.rows.scrollTop = at * ROW;
    select(v, uuid);
    showSection(v, 'timeline');
  }

  // ---------- the selected player ----------
  function buildPlayer(v) {
    v.gates = [];
    v.reasons = [];
    const p = v.player;
    if (!p) { v.playerPage.replaceChildren(el('div', 'mcpl-none muted', tr('Choose a player on the left.'))); return; }
    const top = el('div', 'mcpl-top');
    const face = el('span', 'mcset-pface mcpl-face', nameOf(p).slice(0, 1).toUpperCase());
    const text = el('div', 'mcpl-top-text');
    const name = userText('div', 'mcpl-name', nameOf(p));
    const uuid = userText('div', 'mcpl-uuid muted', p.uuid);
    text.append(name, uuid);
    v.flags = el('div', 'mcpl-flags');
    top.append(face, text, v.flags);
    const strip = el('div', 'mcpl-tabs');
    v.tabs = new Map();
    for (const [id, label] of SECTIONS()) {
      const b = el('button', 'mcpl-tab', label);
      b.type = 'button';
      b.dataset.section = id;
      b.onclick = () => showSection(v, id);
      strip.append(b);
      v.tabs.set(id, b);
    }
    v.scroll = el('div', 'mcpl-scroll');
    v.sections = { overview: overview(v), inventory: inventory(v), timeline: timeline(v), actions: actions(v) };
    v.scroll.append(...Object.values(v.sections));
    v.playerPage.replaceChildren(top, strip, v.scroll);
    v.top = top;
    showSection(v, v.section);
    paintPlayer(v);
  }
  function showSection(v, id) {
    if (id !== v.section) clearResult(v);
    v.section = id;
    for (const [key, node] of Object.entries(v.sections)) node.classList.toggle('hidden', key !== id);
    for (const [key, tab] of v.tabs) tab.classList.toggle('active', key === id);
    // The sections share one scroller: a shorter section must not open out of sight, past where the last one was.
    v.top.scrollIntoView({ block: 'nearest' });
    if (id === 'timeline' && !v.timeline.loaded) loadTimeline(v);
  }
  function paintPlayer(v) {
    const p = v.player;
    if (!p || !v.flags) return;
    const flag = (text, cls = '') => el('span', `mcc-chip ${cls}`.trim(), text);
    v.flags.replaceChildren(flag(p.online ? tr('Online') : tr('Offline'), p.online ? 'sync' : ''),
      ...(p.op ? [flag(tr('Operator {level}', { level: p.opLevel }))] : []), ...(p.whitelisted ? [flag(tr('Whitelisted'))] : []), ...(p.banned ? [flag(tr('Banned'), 'bad')] : []));
    paintFacts(v);
    paintGates(v);
    paintTeleport(v);
    if (v.drag && !canEdit(v)) mc.players.drag.cancel(v);
  }
  // A control that needs the server up: needs is 'running' for that alone, and otherwise the player on it too, with a
  // function for any further reason (v) -> text. While an action waits every control is off, without a reason of its own.
  function gated(v, node, needs = 'online') { v.gates.push({ node, needs }); return node; }
  function why(v, needs) {
    const off = blocked(v);
    if (off || needs === 'running') return off;
    if (!v.player?.online) return tr('{name} is offline.', { name: nameOf(v.player) });
    return typeof needs === 'function' ? needs(v) : '';
  }
  function paintGates(v) {
    for (const g of v.gates) {
      const reason = why(v, g.needs);
      g.node.disabled = !!reason || !!v.acting;
      g.node.title = reason;
    }
    // The banner says why when the server is the reason.
    const text = blocked(v) || v.player?.online ? '' : tr('{name} is offline, so only ban, pardon, operator and whitelist work.', { name: nameOf(v.player) });
    for (const n of v.reasons) { n.textContent = text; n.classList.toggle('hidden', !text); }
    const p = v.player;
    if (v.toggles) {
      v.toggles.ban.classList.toggle('hidden', p.banned);
      v.toggles.pardon.classList.toggle('hidden', !p.banned);
      v.toggles.op.classList.toggle('hidden', p.op);
      v.toggles.deop.classList.toggle('hidden', !p.op);
      v.toggles.allow.classList.toggle('hidden', p.whitelisted);
      v.toggles.deny.classList.toggle('hidden', !p.whitelisted);
    }
  }
  const reasonLine = (v) => { const n = el('div', 'mcpl-reason muted hidden'); v.reasons.push(n); return n; };

  function overview(v) {
    const box = el('section', 'mcpl-section mcpl-overview');
    const FACTS = [['state', tr('State')], ['pos', tr('Position')], ['dimension', tr('Dimension')], ['gamemode', tr('Game mode')], ['health', tr('Health')], ['food', tr('Food')], ['xp', tr('Level')],
      ['playtime', tr('Play time')], ['first', tr('First seen')], ['last', tr('Last seen')], ['op', tr('Server operator')], ['whitelist', tr('Whitelist')], ['ban', tr('Ban')], ['deaths', tr('Deaths')],
      ['kills', tr('Mob kills')], ['jumps', tr('Jumps')], ['advancements', tr('Advancements')]];
    const grid = el('div', 'mcpl-facts');
    v.facts = {};
    for (const [key, label] of FACTS) {
      const cell = el('div', 'mcpl-fact');
      cell.dataset.fact = key;
      v.facts[key] = el('div', 'mcpl-fact-value', '—');
      cell.append(el('div', 'mcpl-fact-label muted', label), v.facts[key]);
      grid.append(cell);
    }
    const quick = el('div', 'mcpl-quick');
    v.toggles = {
      ban: quickButton(v, tr('Ban…'), 'mcpl-q-ban', () => ban(v), 'running'),
      pardon: quickButton(v, tr('Pardon'), 'mcpl-q-pardon', () => act(v, { type: 'pardon' }), 'running'),
      op: quickButton(v, tr('Make Operator…'), 'mcpl-q-op', () => op(v), 'running'),
      deop: quickButton(v, tr('Remove Operator'), 'mcpl-q-deop', () => act(v, { type: 'deop' }), 'running'),
      allow: quickButton(v, tr('Add to Whitelist'), 'mcpl-q-allow', () => act(v, { type: 'whitelistAdd' }), 'running'),
      deny: quickButton(v, tr('Remove from Whitelist'), 'mcpl-q-deny', () => act(v, { type: 'whitelistRemove' }), 'running'),
    };
    quick.append(quickButton(v, tr('Heal'), 'mcpl-q-heal', () => act(v, { type: 'heal' })), quickButton(v, tr('Feed'), 'mcpl-q-feed', () => act(v, { type: 'feed' })),
      quickButton(v, tr('Kick…'), 'mcpl-q-kick', () => kick(v)), ...Object.values(v.toggles));
    box.append(grid, el('h2', 'mcset-section-title', tr('Quick Manage')), reasonLine(v), quick);
    return box;
  }
  function quickButton(v, label, cls, run, needs) {
    const b = el('button', `secondary ${cls}`, label);
    b.type = 'button';
    b.onclick = run;
    return gated(v, b, needs);
  }
  function paintFacts(v) {
    const p = v.player;
    const d = v.detail;
    if (!p || !v.facts) return;
    const pos = p.pos ?? d?.pos ?? null;
    const dimension = p.pos?.dimension ?? d?.pos?.dimension;
    const stats = d?.stats;
    const flagged = (on) => (on ? tr('Yes') : tr('No'));
    const modes = Object.fromEntries(GAMEMODES());
    const number = (n) => (n === null || n === undefined ? '—' : String(n));
    // The server's files can hold play from before this app kept records.
    const seen = (t) => (t ? stamp(t) : stats?.playTimeTicks ? tr('Before records began') : '—');
    const set = {
      state: p.online ? tr('Online') : tr('Offline'), pos: pos ? coords(pos) : '—', dimension: dimension ? DIMENSIONS()[dimension] ?? dimension : '—', gamemode: modes[d?.gamemode] ?? '—',
      health: number(d?.health), food: number(d?.food), xp: number(d?.xpLevel), playtime: duration(Math.max(p.playTimeMs || 0, (stats?.playTimeTicks || 0) * 50)),
      first: seen(p.firstSeen), last: p.online ? tr('Now') : seen(p.lastSeen), op: p.op ? tr('Level {level}', { level: p.opLevel }) : tr('No'), whitelist: flagged(p.whitelisted), ban: flagged(p.banned),
      deaths: number(stats?.deaths), kills: number(stats?.mobKills), jumps: number(stats?.jumps), advancements: number(d?.advancements),
    };
    for (const [key, text] of Object.entries(set)) if (v.facts[key].textContent !== text) v.facts[key].textContent = text;
  }

  async function loadDetail(v) {
    const uuid = v.selected;
    if (!uuid) return;
    const seq = ++v.seq.detail;
    let d;
    try { d = await call('detail', v, uuid); } catch { d = { source: 'file', code: 'failed' }; }
    if (!views.has(v) || seq !== v.seq.detail || v.selected !== uuid) return;
    // Tiles are not swapped under a drag: this waits for its end. What the drag acts on is checked in main anyway.
    if (v.drag) { v.drag.held = d; return; }
    showDetail(v, d);
  }
  function showDetail(v, d) {
    v.detail = d;
    paintFacts(v);
    paintInventory(v);
  }

  // ---------- inventory ----------
  function inventory(v) {
    const box = el('section', 'mcpl-section mcpl-inventory');
    v.invNote = el('div', 'mcset-note mcpl-inv-note', tr('Reading the inventory…'));
    v.invBody = el('div', 'mcpl-inv-body');
    v.invTools = mc.players.drag.tools(v);
    box.append(v.invNote, v.invTools, v.invBody);
    return box;
  }
  const canEdit = (v) => v.detail?.source === 'live' && !why(v, 'online');
  function inventoryNote(v) {
    const d = v.detail;
    const name = nameOf(v.player);
    if (d.code === 'missing') return tr('The server has saved nothing for {name} yet.', { name });
    if (d.code === 'damaged') return tr('The saved file of {name} could not be read.', { name });
    if (d.code) return tr('The inventory could not be read.');
    if (canEdit(v)) return tr('Live from the server. Drag an item to move or swap it, or click a slot to do the same by keyboard.');
    if (d.source === 'live') return tr('Live from the server, read only: {why}', { why: why(v, 'online') });
    return v.player.online ? tr('{name} is online but the server gave no live data, so this is the last save, read only.', { name })
      : tr('Saved data, read only: {name} is offline.', { name });
  }
  const SLOT_NAMES = () => ({ 103: tr('Head'), 102: tr('Chest'), 101: tr('Legs'), 100: tr('Feet'), [-106]: tr('Offhand') });
  function slotTitle(n) {
    const named = SLOT_NAMES()[n];
    if (named) return named;
    return n <= 8 ? tr('Hotbar {n}', { n: n + 1 }) : tr('Inventory {n}', { n: n - 8 });
  }
  function paintInventory(v) {
    const d = v.detail;
    hideTip(); // its tile is about to go, and a removed tile never gets the mouse leaving it
    v.invNote.textContent = inventoryNote(v);
    v.invNote.classList.toggle('bad', !!d.code);
    const editable = canEdit(v);
    v.invTools.classList.toggle('hidden', !editable);
    if (!Array.isArray(d.inventory)) { v.invBody.replaceChildren(); return; }
    const at = new Map(d.inventory.map((s) => [s.slot, s]));
    const armor = new Map(d.armor.map((s) => [s.slot, s]));
    const tile = (slot, n, opts) => newTile(v, slot, n, { editable, ...opts });
    const grid = (cls, tiles) => { const g = el('div', `mcpl-grid ${cls}`); g.append(...tiles); return g; };
    const span = (from, count) => Array.from({ length: count }, (_, i) => from + i);
    const equip = el('div', 'mcpl-equip');
    equip.append(...[103, 102, 101, 100].map((n) => tile(armor.get(n), n)), el('span', 'mcpl-gap'), tile(d.offhand, -106));
    const panel = el('div', 'mcpl-inv');
    panel.append(el('div', 'mcpl-inv-title', tr('Equipment')), equip, el('div', 'mcpl-inv-title', tr('Inventory')), grid('mcpl-main-grid', span(9, 27).map((n) => tile(at.get(n), n))),
      grid('mcpl-hotbar', span(0, 9).map((n) => tile(at.get(n), n, { held: n === d.selected }))));
    const ender = new Map(d.ender.map((s) => [s.slot, s]));
    const chest = el('div', 'mcpl-inv');
    chest.append(el('div', 'mcpl-inv-title', tr('Ender Chest')), grid('mcpl-ender', span(0, 27).map((n) => tile(ender.get(n), n, { ender: true }))));
    v.invBody.replaceChildren(panel, chest);
    loadIcons(v);
  }
  // A slot's number in one line of numbers, the game's own: the ender chest starts at 200.
  const ENDER = 200;
  const slotLabel = (key) => (key >= ENDER ? tr('Ender chest {n}', { n: key - ENDER + 1 }) : slotTitle(key));
  // What this tab shows in a slot, whatever kind of slot it is.
  function shownIn(v, key) {
    const d = v.detail;
    if (key >= ENDER) return d.ender.find((s) => s.slot === key - ENDER) ?? null;
    if (key === -106) return d.offhand;
    return (key >= 100 ? d.armor : d.inventory).find((s) => s.slot === key) ?? null;
  }
  function newTile(v, slot, n, { editable = false, held = false, ender = false }) {
    const tile = el('button', 'mcpl-tile');
    const key = ender ? ENDER + n : n;
    tile.type = 'button';
    tile.dataset.slot = String(n);
    tile.dataset.key = String(key);
    if (ender) tile.dataset.ender = '';
    tile.classList.toggle('held', held);
    tile.classList.toggle('editable', editable);
    fillTile(v, tile, slot);
    const label = slotLabel(key);
    const lines = () => tipLines(v, slot, label);
    tile.onmouseenter = tile.onfocus = () => { if (!v.drag) showTip(tile, lines()); };
    tile.onmouseleave = tile.onblur = hideTip;
    if (editable) tile.onclick = () => { hideTip(); slotDialog(v, key, slot, label); };
    return tile;
  }
  function fillTile(v, tile, slot) {
    tile._slot = slot ?? null;
    tile.replaceChildren();
    tile.classList.toggle('filled', !!slot);
    if (!slot) return;
    tile.dataset.id = slot.id;
    tile.classList.toggle('enchanted', !!slot.enchantments.length);
    const item = v.icons.get(slot.id);
    if (item?.icon) {
      const img = el('img', 'mcpl-icon');
      img.src = item.icon;
      img.alt = '';
      tile.append(img);
    } else tile.append(userText('span', 'mcpl-tile-id', tileWord(item, slot.id)));
    if (slot.count > 1) tile.append(el('span', 'mcpl-count', String(slot.count)));
    if (slot.damage) tile.append(durabilityBar(slot));
  }
  // A tile too small for an id: the start of the item's name, or the initials of its id. The tooltip has the whole id.
  function tileWord(item, id) {
    if (item) { const title = itemTitle(item); return [...title].slice(0, /[가-힣]/.test(title) ? 2 : 3).join(''); }
    return id.replace(/^[^:]*:/, '').split(/[_/]/).map((word) => word[0]).join('').slice(0, 3).toUpperCase();
  }
  function durabilityBar(slot) {
    const max = maxDurability(slot.id);
    const bar = el('span', 'mcpl-durability');
    const fill = el('i');
    if (max) {
      const left = Math.max(0, 1 - slot.damage / max);
      fill.style.width = `${left * 100}%`;
      fill.style.background = `hsl(${Math.round(120 * left)} 100% 45%)`;
    } else bar.classList.add('unknown');
    bar.append(fill);
    return bar;
  }
  function tipLines(v, slot, label) {
    if (!slot) return [{ text: label, cls: 'dim' }];
    const item = v.icons.get(slot.id);
    const lines = [slot.name ? { text: slot.name, cls: 'custom', user: true } : { text: item ? itemTitle(item) : slot.id, cls: slot.enchantments.length ? 'magic' : '' }];
    if (slot.count > 1) lines.push({ text: tr('Count {count}', { count: slot.count }), cls: 'dim' });
    for (const e of slot.enchantments) lines.push({ text: `${v.titles?.get(e.id) ?? pretty(e.id)} ${levelText(e.id, e.level)}`.trim(), cls: 'enchant' });
    const max = maxDurability(slot.id);
    if (slot.damage) lines.push({ text: max ? tr('Durability {left} / {max}', { left: Math.max(0, max - slot.damage), max }) : tr('Durability worn by {count}', { count: slot.damage }), cls: 'dim' });
    if (item || slot.name) lines.push({ text: slot.id, cls: 'dim' });
    lines.push({ text: label, cls: 'dim' });
    return lines;
  }
  // What the inventory shows: one call per set of ids it has not asked about, drawn in when the answer comes.
  async function loadIcons(v) {
    const d = v.detail;
    const slots = [...d.inventory, ...d.armor, ...(d.offhand ? [d.offhand] : []), ...d.ender];
    if (slots.some((s) => s.enchantments.length)) namesOf(v);
    const ids = [...new Set(slots.map((s) => s.id))].filter((id) => !v.icons.has(id));
    if (!ids.length) return;
    let found = {};
    try { found = await call('icons', v, ids); } catch { return; }
    if (!views.has(v)) return;
    for (const id of ids) v.icons.set(id, found[id] ?? null);
    for (const tile of v.invBody.querySelectorAll('.mcpl-tile.filled')) if (ids.includes(tile.dataset.id)) fillTile(v, tile, tile._slot);
  }

  // The tooltip sits on the body: container-type on the tab can make it the box that a fixed element is placed in.
  let tip = null;
  function showTip(anchor, lines) {
    tip ??= el('div', 'mcpl-tip');
    tip.replaceChildren(...lines.map((l) => (l.user ? userText : el)('div', l.cls || null, l.text)));
    document.body.append(tip);
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(a.right + 6, innerWidth - t.width - 4))}px`;
    tip.style.top = `${Math.max(4, Math.min(a.top, innerHeight - t.height - 4))}px`;
  }
  function hideTip() { tip?.remove(); }

  function slotDialog(v, n, slot, label) {
    const target = v.player;
    const pick = itemPicker(v, 'mcpl-slot-item');
    const count = numberInput('mcpl-slot-count', 1, 64, '1');
    const ench = enchantEditor(v);
    const body = el('div', 'mc-dialog mcpl-slot-dialog');
    // The keyboard's way to do what a drag does.
    const dest = el('select', 'input mcpl-slot-dest');
    body.append(field(tr('Game item'), pick.node), field(tr('Count'), count), field(tr('Enchantments'), ench.node));
    if (slot) {
      for (const key of slotKeys().filter((k) => k !== n)) {
        const there = shownIn(v, key);
        dest.add(new Option(there ? `${slotLabel(key)} · ${slotItem(v, there)}` : slotLabel(key), String(key)));
      }
      body.append(field(tr('Move to'), dest));
    }
    const error = el('div', 'mc-dialog-error');
    body.append(error);
    const refuse = (text) => { error.textContent = text; return false; };
    const move = async () => {
      if (v.acting) return refuse(tr('The last command is still waiting. Try again in a moment.'));
      const r = await moveSlot(v, n, Number(dest.value));
      return r ? undefined : false;
    };
    const empty = async () => {
      if (v.acting) return refuse(tr('The last command is still waiting. Try again in a moment.'));
      const r = await act(v, { type: 'replaceSlot', slot: n, item: 'minecraft:air' }, { ask: (name) => tr('Empty {slot} of {name}? What it holds is gone for good.', { slot: label, name }), ok: tr('Empty Slot'), what: { slot: label } });
      return r ? undefined : false;
    };
    const replace = async () => {
      const item = pick.current();
      if (!item) return refuse(RESULTS()[pick.value() ? 'item' : 'noItem']);
      if (ench.invalid()) return refuse(RESULTS().enchantment);
      if (v.acting) return refuse(tr('The last command is still waiting. Try again in a moment.'));
      const ask = slot ? (name) => tr('Replace what {name} holds in {slot}? It is gone for good.', { slot: label, name }) : undefined;
      const r = await act(v, { type: 'replaceSlot', slot: n, item: item.id, count: blankNumber(count), enchantments: ench.value() }, { ask, ok: tr('Replace'), what: { item: item.title, slot: label } });
      return r ? undefined : false;
    };
    ide.ui.dialog({
      title: tr('{slot} of {name}', { slot: label, name: nameOf(target) }), body, width: 460,
      buttons: [{ label: tr('Replace'), primary: true, run: replace }, ...(slot ? [{ label: tr('Move'), run: move }, { label: tr('Empty Slot'), run: empty }] : []), { label: tr('Cancel') }],
    });
  }
  const slotKeys = () => [103, 102, 101, 100, -106, ...Array.from({ length: 36 }, (_, i) => i), ...Array.from({ length: 27 }, (_, i) => ENDER + i)];
  const slotItem = (v, slot) => { const item = v.icons.get(slot.id); return slot.name ?? (item ? itemTitle(item) : pretty(slot.id)); };
  // A stack to another slot, by drag or by the dialog. Onto a filled slot, main swaps them.
  function moveSlot(v, from, to) {
    const [a, b] = [shownIn(v, from), shownIn(v, to)];
    return act(v, { type: 'moveItem', op: 'move', from, to, shown: { from: a?.print ?? null, to: b?.print ?? null } },
      { what: { item: a ? slotItem(v, a) : '', slot: slotLabel(to), other: slotLabel(from), swapped: !!b } });
  }

  // ---------- timeline ----------
  // Events of the NanoBridge plugin are data: the sentence is made here, in the UI's language, with the item's own name.
  const eventIds = (e) => [e.id, e.weapon, e.other].filter((id) => typeof id === 'string' && id.includes(':'));
  function nameIn(v, id) {
    if (!id) return '';
    if (!id.includes(':')) return id;
    const item = v.icons.get(id);
    return item ? itemTitle(item) : pretty(id);
  }
  const ACTIVITY = {
    break: (e, n) => tr('Mined {count} of {item}', { count: e.n, item: n(e.id) }), place: (e, n) => tr('Placed {count} of {item}', { count: e.n, item: n(e.id) }),
    ignite: (e, n) => tr('Lit {item} with flint and steel', { item: n(e.id) }), open: (e, n) => tr('Opened {item}', { item: n(e.id) }),
    take: (e, n) => tr('Took {count} of {item} from {other}', { count: e.n, item: n(e.id), other: n(e.other) }), put: (e, n) => tr('Put {count} of {item} in {other}', { count: e.n, item: n(e.id), other: n(e.other) }),
    pickup: (e, n) => tr('Picked up {count} of {item}', { count: e.n, item: n(e.id) }), drop: (e, n) => tr('Dropped {count} of {item}', { count: e.n, item: n(e.id) }),
    bucket: (e, n) => (e.other === 'fill' ? tr('Filled {item}', { item: n(e.id) }) : tr('Emptied {item}', { item: n(e.id) })),
    hit: (e, n) => (e.weapon ? tr('Hit {other} {count} times with {item}, {amount} damage', { other: n(e.other), count: e.n, item: n(e.weapon), amount: e.amount ?? 0 }) : tr('Hit {other} {count} times, {amount} damage', { other: n(e.other), count: e.n, amount: e.amount ?? 0 })),
    hurt: (e, n) => tr('Took {amount} damage from {other}', { other: n(e.other), amount: e.amount ?? 0 }),
    kill: (e, n) => (e.weapon ? tr('Killed {other} with {item}', { other: n(e.other), item: n(e.weapon) }) : tr('Killed {other}', { other: n(e.other) })),
    pvp: (e, n) => (e.weapon ? tr('Killed player {other} with {item}', { other: n(e.other), item: n(e.weapon) }) : tr('Killed player {other}', { other: n(e.other) })),
    cmd: (e) => tr('Ran {command}', { command: e.text }), sign: (e) => tr('Wrote on a sign: {text}', { text: e.text }),
  };
  const WORLDS = () => ({ world: '', world_nether: tr('The Nether'), world_the_end: tr('The End') });
  function activityText(v, e) {
    const what = ACTIVITY[e.type](e, (id) => nameIn(v, id));
    const where = `${e.x}, ${e.y}, ${e.z}`;
    const world = WORLDS()[e.world] ?? e.world ?? '';
    return `${what} · ${where}${world ? ` · ${world}` : ''}`;
  }
  function eventText(v, e) {
    if (ACTIVITY[e.type]) return activityText(v, e);
    if (e.type === 'join') {
      const base = e.why === 'reconciled' ? tr('Joined (found by the player list)') : tr('Joined');
      return e.x === undefined ? base : tr('{what} at {where}', { what: base, where: coords(e) });
    }
    if (e.type === 'leave') {
      if (e.why === 'stopped') return tr('Left when the server stopped');
      if (e.why === 'reconciled') return tr('Left (found by the player list)');
      return e.text || tr('Left');
    }
    return e.text;
  }
  function eventRow(v, e, who) {
    const row = el('div', 'mcpl-event');
    row.dataset.type = e.type;
    const chip = chipOf(e.type);
    row.append(el('span', 'mcpl-event-time muted', stamp(e.time ?? e.t)), el('span', `mcpl-badge ${chip?.[0] ?? e.type}`, chip?.[1] ?? e.type));
    if (who) {
      const name = userText('button', 'mcpl-link', e.name || '');
      name.type = 'button';
      name.onclick = () => openPlayer(v, e.uuid);
      row.append(name);
    }
    const body = el('span', 'mcpl-event-text', eventText(v, e));
    if (e.text || ACTIVITY[e.type]) body.dataset.userText = '';
    row.append(body);
    if (e.secure === false) row.append(el('span', 'mcc-chip', tr('Unsigned')));
    if (e.ip) row.append(userText('span', 'mcpl-ip muted', e.ip));
    return row;
  }
  function typeFilter(onChange) {
    const on = new Set();
    const box = el('div', 'mcpl-chips');
    for (const [id, label] of TYPES()) {
      const c = el('button', 'mcpl-chip', label);
      c.type = 'button';
      c.dataset.type = id;
      c.onclick = () => {
        if (!on.delete(id)) on.add(id);
        c.classList.toggle('on', on.has(id));
        onChange();
      };
      box.append(c);
    }
    return { node: box, types: () => TYPES().filter(([id]) => on.has(id)).flatMap(([, , types]) => types) };
  }
  // Names for the ids of these events, asked once per id. repaint: called when an answer has brought any.
  async function namesFor(v, events, repaint) {
    const ids = [...new Set(events.flatMap(eventIds))].filter((id) => !v.icons.has(id)).slice(0, 256);
    if (!ids.length) return;
    let found = {};
    try { found = await call('icons', v, ids); } catch { return; }
    if (!views.has(v)) return;
    for (const id of ids) v.icons.set(id, found[id] ?? null);
    if (Object.keys(found).length) repaint();
  }
  // A search in Korean finds items by the name the owner reads: their ids are what the records hold.
  async function idsNamed(v, q) {
    if (!/[가-힣]/.test(q)) return [];
    const list = call('items', v, q).then((r) => r.items.slice(0, 64).map((i) => i.id), () => []);
    return Promise.race([list, new Promise((resolve) => { setTimeout(resolve, ITEM_WAIT_MS, []); })]);
  }
  function timeline(v) {
    const box = el('section', 'mcpl-section mcpl-timeline');
    const again = later(() => { if (views.has(v)) loadTimeline(v); });
    const filter = typeFilter(() => loadTimeline(v));
    const q = el('input', 'input mcpl-tl-search');
    q.placeholder = tr('Search this timeline, or type x y z');
    q.spellcheck = false;
    q.oninput = again;
    const list = el('div', 'mcpl-events');
    const status = el('div', 'mcpl-status muted');
    const more = el('button', 'secondary mcpl-more hidden', tr('Load More'));
    more.type = 'button';
    more.onclick = () => loadTimeline(v, true);
    const bar = el('div', 'mcpl-filter');
    bar.append(q, filter.node);
    box.append(bar, list, status, more);
    v.timeline = { events: [], more: false, loaded: false, filter, q, list, status, moreButton: more };
    return box;
  }
  const timelineQuery = async (v, t) => ({ types: t.filter.types(), q: t.q.value.trim(), ids: await idsNamed(v, t.q.value.trim()) });
  async function loadTimeline(v, more = false) {
    const t = v.timeline;
    const uuid = v.selected;
    const seq = ++v.seq.timeline;
    t.loaded = true;
    const before = more ? t.events.at(-1)?.t : undefined;
    let r;
    try { r = await call('timeline', v, uuid, { ...await timelineQuery(v, t), limit: PAGE, ...(before && { before }) }); } catch (err) {
      if (views.has(v) && t === v.timeline) t.status.textContent = mc.errorText(err);
      return;
    }
    if (!views.has(v) || t !== v.timeline || seq !== v.seq.timeline) return;
    t.events = more ? [...t.events, ...r.events] : r.events;
    t.more = r.more;
    paintTimeline(t, v);
  }
  // What came in on top of the pages already loaded, which stay. A push that brought more than a page starts over.
  async function newEvents(v) {
    const t = v.timeline;
    const seq = v.seq.timeline;
    let r;
    try { r = await call('timeline', v, v.selected, { ...await timelineQuery(v, t), limit: PAGE }); } catch { return; }
    if (!views.has(v) || t !== v.timeline || seq !== v.seq.timeline) return;
    const top = t.events[0]?.t;
    const fresh = top ? r.events.filter((e) => e.t > top) : r.events;
    if (!fresh.length) return;
    if (fresh.length === r.events.length && r.more) { t.events = r.events; t.more = true; } else t.events = [...fresh, ...t.events];
    paintTimeline(t, v);
  }
  function paintTimeline(t, v) {
    t.list.replaceChildren(...t.events.map((e) => eventRow(v, e, false)));
    t.status.textContent = t.events.length ? '' : tr('Nothing recorded here yet.');
    t.moreButton.classList.toggle('hidden', !t.more);
    namesFor(v, t.events, () => { if (t === v.timeline) paintTimeline(t, v); });
  }

  // ---------- actions ----------
  // A confirmed action sent to the server. -> the result, or null when the user said no or one is already running.
  // `what` holds the titles of what the form picked, for the summary.
  async function act(v, action, { ask, ok, what = {} } = {}) {
    const name = v.player?.name;
    if (!name || v.acting) return null;
    if (ask && !(await ide.ui.confirm(ask(name), { title: ACTION_TITLES()[action.type], ok }))) return null;
    v.acting = true;
    paintGates(v);
    paintResult(v, 'sending', headingOf(action, name), tr('Sending to the server…'));
    let r;
    // The uuid lets main refuse a name that has passed to another account since.
    try { r = await call('action', v, { ...action, target: name, uuid: v.player.uuid }); } catch (err) {
      r = { ok: false, code: 'failed', text: mc.errorText(err), commands: [] };
    }
    v.acting = false;
    if (!views.has(v)) return r;
    paintPlayer(v);
    showResult(v, action, r, name, what);
    refresh(v);
    if (r.commands.length) loadDetail(v);
    if (v.page === 'log') loadLog(v);
    return r;
  }
  function headingOf(action, name) {
    const who = el('span', 'mcpl-result-who', `${ACTION_TITLES()[action.type]} · `);
    who.append(userText('span', null, `'${name}'`));
    return who;
  }
  // The result bar. Only a success goes by itself: anything that went wrong stays until it is closed or left behind.
  function paintResult(v, tint, heading, says, more = []) {
    clearTimeout(v.resultFade);
    v.result.className = `mcpl-result ${tint}`;
    const title = el('div', 'mcpl-result-title');
    title.append(el('span', 'mcpl-result-mark'));
    if (heading) title.append(heading);
    title.append(el('span', 'mcpl-result-what', says));
    if (tint !== 'sending') {
      const close = el('button', 'secondary mcpl-result-close', '✕');
      close.type = 'button';
      close.title = tr('Close');
      close.onclick = () => clearResult(v);
      title.append(close);
    }
    v.result.replaceChildren(title, ...more);
    if (tint === 'ok') v.resultFade = setTimeout(() => {
      v.result.classList.add('fading');
      v.resultFade = setTimeout(() => clearResult(v), 400);
    }, FADE_MS);
  }
  function clearResult(v) {
    if (v.acting) return;
    clearTimeout(v.resultFade);
    v.result.classList.add('hidden');
  }
  function showResult(v, action, r, name = v.player?.name, what = {}) {
    const tint = !r.ok ? 'bad' : r.code ? 'warn' : 'ok';
    const says = tint === 'ok' ? DONE(name, action, what) : RESULTS()[r.code] ?? tr('That did not work.');
    const more = [];
    if (r.note) more.push(el('div', 'mcpl-result-note', NOTES()[action.type] ?? ''));
    for (const w of r.wrong ?? []) {
      const key = w.slot;
      const got = w.got ? `${nameIn(v, w.got.id)} ×${w.got.count}` : tr('empty');
      more.push(userText('div', 'mcpl-result-wrong', tr('{slot} now holds: {what}', { slot: slotLabel(key), what: got })));
    }
    if (r.whole === false) more.push(el('div', 'mcpl-result-wrong', tr('The player\'s stacks do not add up either: something else in the inventory changed at the same moment.')));
    if (r.code === 'mismatch') more.push(el('div', 'mcpl-result-wrong', tr('What each changed slot held before and after is in the Admin Log, so a lost stack can be put back by hand.')));
    if (r.commands.length) {
      const fold = el('details', 'mcpl-result-more');
      fold.append(el('summary', null, tr('Command and server answer')), userText('div', 'mcpl-result-commands', r.commands.map((c) => `> ${c}`).join('\n')));
      // Without a command sent, text is main's own English for a refusal, which `says` has in the UI's language.
      if (r.text) {
        const answer = el('div', 'mcpl-result-answer');
        answer.append(el('span', 'muted', tr('The server said:')), ' ', userText('span', 'mcpl-result-text', r.text));
        fold.append(answer);
      }
      // Someone reading the details keeps them.
      fold.ontoggle = () => { clearTimeout(v.resultFade); v.result.classList.remove('fading'); };
      more.push(fold);
    }
    paintResult(v, tint, tint === 'ok' ? null : headingOf(action, name), says, more);
  }
  const refused = (v, action, code) => showResult(v, action, { ok: false, code, commands: [] });
  const kick = (v, reason) => act(v, { type: 'kick', reason }, { ask: (name) => tr('Kick {name} from the server?', { name }), ok: tr('Kick') });
  const ban = (v, reason) => act(v, { type: 'ban', reason }, { ask: (name) => tr('Ban {name} from the server? They cannot join until they are pardoned.', { name }), ok: tr('Ban') });
  const op = (v) => act(v, { type: 'op' }, { ask: (name) => tr('Make {name} an operator? Operators can run server commands.', { name }), ok: tr('Make Operator') });

  function numberInput(cls, min, max, placeholder) {
    const i = el('input', `input ${cls}`);
    i.type = 'number';
    i.min = min;
    i.max = max;
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  const textInput = (cls, placeholder) => {
    const i = el('input', `input ${cls}`);
    i.placeholder = placeholder;
    i.spellcheck = false;
    return i;
  };
  // A <label> around a button would press it on a click of the label's text.
  function field(label, control) {
    const f = el(control.matches('input, select') ? 'label' : 'div', 'mcpl-field');
    f.append(el('span', 'mcpl-field-label muted', label), control);
    return f;
  }
  function card(title, cls) {
    const c = el('section', `mcpl-card ${cls}`);
    c.append(el('div', 'mcpl-card-title', title));
    return c;
  }
  const row = (...nodes) => { const r = el('div', 'mcpl-card-row'); r.append(...nodes); return r; };
  const actionButton = (v, label, cls, run, needs, style = 'secondary') => {
    const b = el('button', `${style} ${cls}`, label);
    b.type = 'button';
    b.onclick = run;
    return gated(v, b, needs);
  };
  // ---------- pick lists ----------
  // Choice {id, title, name, icon}: one row of a pick list. title is what the owner reads; name the English one, which
  // a search also matches.
  const choice = ({ id, name, ko, icon }) => ({ id, name: name ?? pretty(id), title: (i18n.locale === 'ko' && ko) || name || pretty(id), icon: icon ?? null });
  const choiceIcon = (c) => {
    if (!c.icon) return el('span', 'mcpl-pick-icon');
    const img = el('img', 'mcpl-pick-icon');
    img.src = c.icon;
    img.alt = '';
    return img;
  };
  // The one list that can be open, on the body. In the flow its folding moved the button under a press, so the release
  // missed it, and any box inside the tab or a dialog's body would clip it. Focus stays in the text box: the list closes
  // when that box blurs, and a press on the list must not blur it.
  const popBox = el('div', 'mcpl-picks');
  const popNote = el('div', 'mcpl-pick-note muted');
  const popList = el('div', 'mcpl-pick-list');
  popBox.append(popNote, popList);
  popBox.onmousedown = (e) => e.preventDefault();
  let pop = null; // {input, rows, active, pick}
  function placePop() {
    if (!pop) return;
    const r = pop.input.getBoundingClientRect();
    // In a dialog it stops above the buttons, so a list of any length leaves Cancel in reach.
    const foot = pop.input.closest('.dialog')?.querySelector('.dialog-buttons')?.getBoundingClientRect().top;
    const below = (foot ?? innerHeight) - r.bottom - 6;
    const up = !foot && below < 140 && r.top > below;
    const width = Math.max(r.width, 220);
    popBox.style.left = `${Math.max(4, Math.min(r.left, innerWidth - width - 4))}px`;
    popBox.style.width = `${width}px`;
    popBox.style.top = up ? '' : `${r.bottom + 2}px`;
    popBox.style.bottom = up ? `${innerHeight - r.top + 2}px` : '';
    popBox.style.maxHeight = `${Math.min(220, up ? r.top - 6 : below)}px`;
  }
  function closePop() {
    pop = null;
    popBox.remove();
  }
  function showPop(input, rows, note, pick) {
    if (!rows.length && !note) { closePop(); return; }
    pop = { input, rows, active: -1, pick };
    popNote.textContent = note;
    popNote.classList.toggle('hidden', !note);
    popList.replaceChildren(...rows.map((c) => {
      const p = el('div', 'mcpl-pick');
      p.dataset.id = c.id;
      p.append(choiceIcon(c), userText('span', 'mcpl-pick-name', c.title), userText('span', 'mcpl-pick-id muted', c.id));
      p.onclick = () => pick(c);
      return p;
    }));
    document.body.append(popBox);
    popList.scrollTop = 0;
    placePop();
  }
  addEventListener('scroll', (e) => { if (!popBox.contains(e.target)) placePop(); }, true);
  addEventListener('resize', placePop);
  // On the window and before anything else: a dialog takes its keys there, Escape to close and Enter to press its button.
  addEventListener('keydown', (e) => {
    if (!pop || e.target !== pop.input || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!pop.rows.length) return;
      pop.active = (pop.active + (e.key === 'ArrowDown' ? 1 : -1) + pop.rows.length) % pop.rows.length;
      [...popList.children].forEach((n, i) => n.classList.toggle('active', i === pop.active));
      popList.children[pop.active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const c = pop.rows[Math.max(0, pop.active)];
      if (c) pop.pick(c); else closePop();
    } else if (e.key === 'Escape') closePop();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // A text box that searches: what was picked shows in the box with its id beneath, and an id the list does not have can
  // always be typed. search(text) -> {rows: [Choice], note}. A keyboard arrival does not open the list: a press or typing
  // does, or Arrow Down.
  function picker({ cls, placeholder, none, waiting = '', search }) {
    const box = el('div', 'mcpl-picker');
    const input = textInput(cls, placeholder);
    const face = el('div', 'mcpl-chosen');
    let chosen = null;
    let rows = [];
    let seq = 0;
    const paintChosen = () => {
      box.classList.toggle('chosen', !!chosen);
      if (!chosen) return;
      const text = el('span', 'mcpl-chosen-text');
      text.append(userText('span', 'mcpl-chosen-name', chosen.title), userText('span', 'mcpl-chosen-id muted', chosen.id));
      const x = el('button', 'mcpl-chosen-clear', '✕');
      x.type = 'button';
      x.title = tr('Remove');
      x.onmousedown = (e) => e.preventDefault();
      x.onclick = () => { chosen = null; input.value = ''; paintChosen(); input.focus(); };
      face.replaceChildren(choiceIcon(chosen), text, x);
    };
    const pick = (c) => {
      chosen = c;
      input.value = c.id;
      paintChosen();
      closePop();
      input.select();
    };
    const find = later(async () => {
      const mine = ++seq;
      const text = chosen ? '' : input.value.trim();
      const focused = () => document.activeElement === input;
      if (waiting && !rows.length && focused()) showPop(input, [], waiting, pick);
      let r;
      try { r = await search(text); } catch { r = { rows: [], note: '' }; }
      if (mine !== seq) return;
      rows = r.rows;
      if (focused()) showPop(input, rows, r.note || (!rows.length && text ? none : ''), pick);
    }, 150);
    input.oninput = () => { chosen = null; paintChosen(); find(); };
    // A press on a pick selects all of it, so that typing replaces it: a caret would add to the id instead.
    input.onmousedown = (e) => { if (!chosen) return; e.preventDefault(); input.focus(); input.select(); };
    input.onclick = find;
    input.onblur = () => { seq++; if (pop?.input === input) closePop(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !pop && !e.isComposing) { e.preventDefault(); find(); } });
    box.append(input, face);
    // What the box holds: the pick, a row named or an id typed out in full, or null for text that is neither.
    const current = () => {
      const text = input.value.trim();
      if (chosen || !text) return chosen;
      const same = (s) => s.toLowerCase() === text.toLowerCase();
      return rows.find((c) => same(c.id) || same(c.title) || same(c.name)) ?? (ID.test(text) ? { id: text, title: text, name: text, icon: null } : null);
    };
    return { node: box, input, current, value: () => current()?.id ?? input.value.trim() };
  }
  const ITEM_REASONS = () => ({ version: tr('This Minecraft version has no item list, so items are ids.'), download: tr('The item list could not be downloaded, so items are ids.'),
    korean: tr('The Korean item names could not be downloaded.'), error: tr('The item list could not be read, so items are ids.') });
  const itemPicker = (v, cls) => picker({
    cls, placeholder: tr('Search items, or type an id'), none: tr('No item matches that.'),
    // The first search of a version waits for its client jar to be downloaded and read.
    waiting: tr('Looking up items…'),
    search: async (text) => {
      const r = await call('items', v, text);
      return { rows: r.items.slice(0, 50).map(choice), note: ITEM_REASONS()[r.reasonCode] ?? '' };
    },
  });
  // The names of enchantments and effects, from the same language file as items, or bare ids with a reason.
  function namesOf(v) {
    v.names ??= call('names', v).catch(() => ({ enchantments: [], effects: [] })).then((r) => {
      const names = { enchantments: r.enchantments.map(choice), effects: r.effects.map(choice), note: r.reason ? tr('The Korean names could not be downloaded.') : '' };
      v.titles = new Map([...names.enchantments, ...names.effects].map((c) => [c.id, c.title]));
      return names;
    });
    return v.names;
  }
  const namePicker = (v, kind, cls, placeholder, none) => picker({
    cls, placeholder, none,
    search: async (text) => {
      const q = text.toLowerCase();
      const names = await namesOf(v);
      return { rows: names[kind].filter((c) => [c.title, c.name, c.id].some((s) => s.toLowerCase().includes(q))), note: names.note };
    },
  });
  function enchantEditor(v) {
    const box = el('div', 'mcpl-enchants');
    const list = el('div', 'mcpl-enchant-list');
    const rows = new Set();
    const add = el('button', 'secondary mcpl-enchant-add', tr('Add Enchantment'));
    add.type = 'button';
    add.onclick = () => {
      const r = el('div', 'mcpl-enchant');
      const pick = namePicker(v, 'enchantments', 'mcpl-enchant-id', tr('Search enchantments'), tr('No enchantment matches that.'));
      const level = numberInput('mcpl-enchant-level', 1, 255);
      level.value = '1';
      const entry = { pick, level };
      const x = el('button', 'secondary mcpl-enchant-remove', '✕');
      x.type = 'button';
      x.title = tr('Remove');
      x.onclick = () => { rows.delete(entry); r.remove(); };
      r.append(pick.node, level, x);
      rows.add(entry);
      list.append(r);
      pick.input.focus();
    };
    box.append(list, add);
    return {
      node: box,
      value: () => [...rows].map((e) => ({ id: e.pick.value(), level: Number(e.level.value) })).filter((e) => e.id),
      invalid: () => [...rows].some((e) => e.pick.value() && !e.pick.current()),
    };
  }

  function actions(v) {
    const box = el('section', 'mcpl-section mcpl-actions');
    box.append(reasonLine(v));
    const cards = el('div', 'mcpl-cards');
    cards.append(giveCard(v), clearCard(v), teleportCard(v), modeCard(v), effectCard(v), whisperCard(v), moderationCard(v));
    box.append(cards);
    return box;
  }
  function giveCard(v) {
    const c = card(tr('Give Item'), 'mcpl-give');
    const pick = itemPicker(v, 'mcpl-give-item');
    const count = numberInput('mcpl-give-count', 1, 6400, '1');
    const ench = enchantEditor(v);
    const go = actionButton(v, tr('Give'), 'mcpl-give-go', () => {
      const item = pick.current();
      if (!item) refused(v, { type: 'give' }, pick.value() ? 'item' : 'noItem');
      else if (ench.invalid()) refused(v, { type: 'give' }, 'enchantment');
      else act(v, { type: 'give', item: item.id, count: blankNumber(count), enchantments: ench.value() }, { what: { item: item.title } });
    }, 'online', 'primary');
    // An open list took its Enter first, on the window.
    c.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input')) return;
      e.preventDefault();
      go.click();
    });
    c.append(field(tr('Game item'), pick.node), field(tr('Count'), count), field(tr('Enchantments'), ench.node), row(go));
    return c;
  }
  function clearCard(v) {
    const c = card(tr('Clear Inventory'), 'mcpl-clear');
    const pick = itemPicker(v, 'mcpl-clear-item');
    const count = numberInput('mcpl-clear-count', 1, 2147483647, tr('All of them'));
    const one = actionButton(v, tr('Clear This Item…'), 'mcpl-clear-one', () => {
      const item = pick.current();
      if (!item) { refused(v, { type: 'clear' }, pick.value() ? 'item' : 'noItem'); return; }
      act(v, { type: 'clear', item: item.id, count: blankNumber(count) }, { ask: (name) => tr('Remove {item} from the inventory of {name}?', { item: item.title, name }), ok: tr('Clear'), what: { item: item.title } });
    });
    const all = actionButton(v, tr('Clear Everything…'), 'mcpl-clear-all', () => act(v, { type: 'clear' }, { ask: (name) => tr('Empty the whole inventory of {name}? The items are gone for good.', { name }), ok: tr('Clear Everything') }));
    c.append(field(tr('Game item'), pick.node), field(tr('Count'), count), row(one, all));
    return c;
  }
  const othersOnline = (v) => v.data.players.filter((p) => p.online && p.uuid !== v.selected).map((p) => p.name);
  const noOneElse = (v) => (othersOnline(v).length ? '' : tr('No other player is online.'));
  function paintTeleport(v) {
    if (!v.tpTo) return;
    const names = othersOnline(v);
    const said = why(v, noOneElse);
    v.tpWhy.textContent = said;
    v.tpWhy.classList.toggle('hidden', !said || !v.player?.online || !!blocked(v));
    v.tpTo.disabled = !names.length;
    const held = v.tpTo.value;
    if (names.join() === [...v.tpTo.options].map((o) => o.value).join()) return;
    v.tpTo.replaceChildren(...names.map((n) => new Option(n, n)));
    if (names.includes(held)) v.tpTo.value = held;
  }
  function teleportCard(v) {
    const c = card(tr('Teleport'), 'mcpl-teleport');
    v.tpTo = el('select', 'input mcpl-tp-to');
    v.tpWhy = el('div', 'mcpl-tp-why muted hidden');
    const to = actionButton(v, tr('Teleport to Player'), 'mcpl-tp-player', () => act(v, { type: 'teleport', to: v.tpTo.value }), noOneElse);
    const axis = (name) => textInput(`mcpl-tp-${name}`, name);
    const [x, y, z] = ['x', 'y', 'z'].map(axis);
    const at = actionButton(v, tr('Teleport to Coordinates'), 'mcpl-tp-here', () => act(v, { type: 'teleport', x: x.value.trim(), y: y.value.trim(), z: z.value.trim() }));
    const point = el('div', 'mcpl-coords');
    point.append(x, y, z);
    c.append(field(tr('Player'), v.tpTo), v.tpWhy, row(to), field(tr('Coordinates'), point), row(at));
    return c;
  }
  function modeCard(v) {
    const c = card(tr('Game Mode and Health'), 'mcpl-mode');
    const mode = el('select', 'input mcpl-mode-select');
    for (const [id, label] of GAMEMODES()) mode.add(new Option(label, id));
    const set = actionButton(v, tr('Set Game Mode'), 'mcpl-mode-go', () => act(v, { type: 'gamemode', mode: mode.value }));
    const heal = actionButton(v, tr('Heal'), 'mcpl-heal', () => act(v, { type: 'heal' }));
    const feed = actionButton(v, tr('Feed'), 'mcpl-feed', () => act(v, { type: 'feed' }));
    c.append(field(tr('Game mode'), mode), row(set), row(heal, feed));
    return c;
  }
  function effectCard(v) {
    const c = card(tr('Effect'), 'mcpl-effect');
    const id = namePicker(v, 'effects', 'mcpl-effect-id', tr('Search effects'), tr('No effect matches that.'));
    const seconds = numberInput('mcpl-effect-seconds', 1, 1000000, '30');
    const amplifier = numberInput('mcpl-effect-amplifier', 0, 255, '0');
    const forever = el('input');
    forever.type = 'checkbox';
    forever.className = 'mcpl-effect-forever';
    forever.onchange = () => { seconds.disabled = forever.checked; };
    const hide = el('input');
    hide.type = 'checkbox';
    hide.className = 'mcpl-effect-hide';
    const check = (input, label) => { const l = el('label', 'mc-dialog-check'); l.append(input, ` ${label}`); return l; };
    const give = actionButton(v, tr('Give Effect'), 'mcpl-effect-go', () => {
      const effect = id.current();
      if (!effect) { refused(v, { type: 'effect' }, id.value() ? 'effect' : 'noEffect'); return; }
      act(v, { type: 'effect', effect: effect.id, seconds: forever.checked ? 'infinite' : blankNumber(seconds), amplifier: blankNumber(amplifier), hideParticles: hide.checked }, { what: { effect: effect.title } });
    });
    const clear = actionButton(v, tr('Remove Effects'), 'mcpl-effect-clear', () => {
      const effect = id.current();
      if (id.value() && !effect) { refused(v, { type: 'effect' }, 'effect'); return; }
      act(v, { type: 'effect', clear: true, ...(effect && { effect: effect.id }) }, { what: { effect: effect?.title } });
    });
    c.append(field(tr('Effect'), id.node), field(tr('Seconds'), seconds), field(tr('Amplifier'), amplifier), row(check(forever, tr('Endless')), check(hide, tr('Hide particles'))), row(give, clear));
    return c;
  }
  function whisperCard(v) {
    const c = card(tr('Whisper'), 'mcpl-whisper');
    const text = textInput('mcpl-whisper-text', tr('A private message'));
    text.maxLength = 256;
    const send = actionButton(v, tr('Send'), 'mcpl-whisper-go', async () => { if ((await act(v, { type: 'whisper', text: text.value }))?.ok) text.value = ''; });
    c.append(field(tr('Message'), text), row(send));
    return c;
  }
  function moderationCard(v) {
    const c = card(tr('Moderation'), 'mcpl-moderation');
    const reason = textInput('mcpl-reason-text', tr('Why (optional, the player sees it)'));
    reason.maxLength = 256;
    const said = () => reason.value.trim() || undefined;
    c.append(field(tr('Reason'), reason),
      row(actionButton(v, tr('Kick…'), 'mcpl-kick', () => kick(v, said())), actionButton(v, tr('Ban…'), 'mcpl-ban', () => ban(v, said()), 'running'), actionButton(v, tr('Pardon'), 'mcpl-pardon', () => act(v, { type: 'pardon' }), 'running')),
      row(actionButton(v, tr('Make Operator…'), 'mcpl-op', () => op(v), 'running'), actionButton(v, tr('Remove Operator'), 'mcpl-deop', () => act(v, { type: 'deop' }), 'running')),
      row(actionButton(v, tr('Add to Whitelist'), 'mcpl-allow', () => act(v, { type: 'whitelistAdd' }), 'running'), actionButton(v, tr('Remove from Whitelist'), 'mcpl-deny', () => act(v, { type: 'whitelistRemove' }), 'running')));
    return c;
  }

  // ---------- search across players, admin log ----------
  function mountSearch(v) {
    const page = el('div', 'mcpl-page mcpl-search hidden');
    const again = later(() => { if (views.has(v)) runSearch(v); });
    const filter = typeFilter(() => runSearch(v));
    const q = el('input', 'input mcpl-all-search');
    q.placeholder = tr('Search names, chat, blocks, or x y z…');
    q.spellcheck = false;
    q.oninput = again;
    const bar = el('div', 'mcpl-filter');
    bar.append(q, filter.node);
    const status = el('div', 'mcpl-status muted');
    const list = el('div', 'mcpl-events');
    const scroll = el('div', 'mcpl-scroll');
    scroll.append(bar, status, list);
    page.append(el('h2', 'mcpl-page-title', tr('Search All Players')), scroll);
    v.search = { q, filter, status, list };
    return page;
  }
  // A push can come 4 times a second and a search reads every player's file, so pushes wait for one timer. It does not
  // restart on the next push, as then a busy server would never get a search at all.
  function searchSoon(v) {
    v.searchTimer ||= setTimeout(() => {
      v.searchTimer = 0;
      if (views.has(v) && v.page === 'search') runSearch(v);
    }, SEARCH_PUSH_MS);
  }
  // One at a time, and one more when something came in meanwhile, as refresh() does.
  async function runSearch(v) {
    if (v.searching) { v.searchAgain = true; return; }
    v.searching = true;
    const s = v.search;
    const asked = () => JSON.stringify({ q: s.q.value.trim(), types: s.filter.types() });
    const query = asked();
    try {
      const opts = JSON.parse(query);
      const found = await call('search', v, { ...opts, ids: await idsNamed(v, opts.q) });
      if (views.has(v) && query === asked()) {
        const paint = () => s.list.replaceChildren(...found.map((e) => eventRow(v, e, true)));
        s.status.textContent = found.length ? '' : tr('Nothing found.');
        paint();
        namesFor(v, found, () => { if (query === asked()) paint(); });
      }
    } catch (err) {
      if (views.has(v)) s.status.textContent = mc.errorText(err);
    } finally {
      v.searching = false;
      if (v.searchAgain && views.has(v)) {
        v.searchAgain = false;
        if (v.page === 'search') runSearch(v);
      }
    }
  }
  function mountLog(v) {
    const page = el('div', 'mcpl-page mcpl-log hidden');
    const list = el('div', 'mcpl-log-list');
    const status = el('div', 'mcpl-status muted');
    const scroll = el('div', 'mcpl-scroll');
    scroll.append(status, list);
    page.append(el('h2', 'mcpl-page-title', tr('Admin Log')), scroll);
    v.log = { list, status };
    return page;
  }
  async function loadLog(v) {
    const seq = ++v.seq.log;
    let entries;
    try { entries = await call('adminLog', v, { limit: 200 }); } catch (err) {
      if (views.has(v)) v.log.status.textContent = mc.errorText(err);
      return;
    }
    if (!views.has(v) || seq !== v.seq.log) return;
    v.log.status.textContent = entries.length ? '' : tr('No actions yet.');
    v.log.list.replaceChildren(...entries.map((e) => {
      const r = el('div', `mcpl-log-row${e.ok ? '' : ' bad'}`);
      const top = el('div', 'mcpl-log-top');
      top.append(el('span', 'mcpl-event-time muted', stamp(e.t)), el('span', 'mcpl-log-what', ACTION_TITLES()[e.action?.type] ?? String(e.action?.type ?? '')),
        userText('span', 'mcpl-log-target', String(e.action?.target ?? '')), el('span', `mcc-chip ${e.ok ? 'sync' : 'bad'}`, e.ok ? tr('Done') : tr('Failed')));
      r.append(top);
      const says = RESULTS()[e.code];
      if (says) r.append(el('div', 'mcpl-log-why', says));
      if (e.commands?.length) r.append(userText('div', 'mcpl-result-commands', e.commands.map((c) => `> ${c}`).join('\n')));
      if (e.commands?.length && e.text) r.append(userText('div', 'mcpl-log-text muted', e.text));
      if (e.changed?.length) {
        const fold = el('details', 'mcpl-result-more');
        const empty = tr('empty');
        fold.append(el('summary', null, tr('Slots before and after')), userText('div', 'mcpl-result-commands', e.changed.flatMap((c) => [
          tr('{slot} before: {what}', { slot: slotLabel(c.slot), what: c.before ?? empty }), tr('{slot} after: {what}', { slot: slotLabel(c.slot), what: c.after ?? empty }),
        ]).join('\n')));
        r.append(fold);
      }
      return r;
    }));
  }

  // What the two parts of this tab in their own files need from here.
  const kit = { call, views, act, canEdit, paintResult, refresh, showDetail, hideTip, moveSlot, shownIn, slotLabel, slotItem, choice, choiceIcon, numberInput, field, later, userText };
  mc.players = { open, tabId, paintStates, kit };
  const here = document.currentScript.src.replace(/[^/]*$/, '');
  for (const file of ['players-drag.js', 'players-bridge.js']) {
    const script = el('script');
    script.src = `${here}${file}`;
    script.async = false;
    document.body.appendChild(script);
  }
})();
