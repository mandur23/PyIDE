// The game's layout and its shared surface (architecture section 7): Conquest.ui.shell.mount(host) builds once a top
// bar, the body (a panel dock on the left, the stage with the map) and the army bar along the bottom (ui/command.js
// fills it); the start screen (ui/start.js) sits over the stage while no game runs. The shell owns the map view (setMap
// swaps it when a game is on another map) and its binding to the game (ui/mapbind.js), the map mode switch and the
// legend toggle (bottom right of the map), the alerts, the crash notice, the game keys and Conquest.ui.panel.
//
// The top bar, left to right: the player's nation, a button per panel (glyph, label, its key in the tooltip), the
// resource chips (glyph and value; hovering or focusing one shows what it is and its breakdown from the mirror and the
// `economy` query), and on the right the time control (date, pause, slower, the five speed steps, faster), Help, the
// settings gear, Save and Quit. Labels shorten and then go as the bar narrows; values stay down to a 1024 px window.
// While paused the time control turns amber and the map shows a Paused flag and an amber frame.
//
// Alerts: a new one shows as a toast at the top right of the map that leaves after TOAST_MS (war declared and offers
// received stay until dismissed; at most MAX_TOASTS at once) and is collected under a badge per kind, with its count,
// in one row under the top bar. A badge opens its kind's list; an entry, like a toast, focuses its province (an offer
// opens the diplomacy panel). Per kind a "pause on this" setting in conquest.pauseOn, read again whenever it changes.
//
// Conquest.ui.panel({ id, title, icon, order, mount(el, game) -> { update(), destroy() } }) adds a panel and its top bar
// button. A panel is mounted the first time it opens and kept; one is open at a time, docked at the left of the map;
// update() is called on the open panel once a game day, after each of the player's orders is answered, and when it
// opens. The open panel's id is remembered (conquest.panel), and so is whether the legend is open (conquest.legend).
// shell.openPanel(id) opens one (null closes).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const log = ide.logger('#conquest');
  const game = Conquest.game;

  const MODE_LABELS = { political: () => tr('Political'), terrain: () => tr('Terrain'), supply: () => tr('Supply'), weather: () => tr('Weather'), diplomacy: () => tr('Diplomacy') };
  const MODE_KEYS = { political: 'F1', terrain: 'F2', supply: 'F3', weather: 'F4', diplomacy: 'F5' };
  const PANEL_KEYS = { production: 'Q', designer: 'W', diplomacy: 'E', judgment: 'R', log: 'T' };
  const PAUSE_DEFAULT = { war: true, offer: true, lost: false, taken: false, 'battle-lost': false, 'low-supply': false, event: false };
  const STICKY = new Set(['war', 'offer']);
  const TOAST_MS = 8000;
  const MAX_TOASTS = 3;
  const KEEP_PER_KIND = 40;
  const LOW_SUPPLY = 400;

  // Keys act only on a running game, never while the player types or a dialog is open.
  const typing = () => {
    const a = document.activeElement;
    return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
  };
  const playing = () => game.running && !typing() && !document.querySelector('.dialog-backdrop, .modal-backdrop');

  // Original 16 px glyphs for what the app's icon set has no drawing of. [d, stroke?]
  const GLYPHS = {
    manpower: [['M8 1.8a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2Z'], ['M2.8 14.2c0-3.1 2.3-5.4 5.2-5.4s5.2 2.3 5.2 5.4Z']],
    mil: [['M1.5 14.5V7.2l3.6 2.4V7.2l3.6 2.4V2.5h2.6v12Z'], ['M12.6 14.5V5.5h1.9v9Z']],
    civ: [['M2 14.5V3.5h6.5v11Z'], ['M9.5 14.5V7h4.5v7.5Z']],
    coal: [['M2.5 11.5l1.8-5 4-2.3 3.8 2.6 1.4 4.2-3.6 3H5.6Z']],
    iron: [['M1.5 12.5l2.6-5.2h7.8l2.6 5.2Z'], ['M4.5 6.3l1.4-2.8h4.2l1.4 2.8Z']],
    oil: [['M8 1.5C6.4 4 3.6 7.3 3.6 10.2a4.4 4.4 0 0 0 8.8 0C12.4 7.3 9.6 4 8 1.5Z']],
    fatigue: [['M1.5 4l4.2 4.2 2.8-2.8 5.2 5.6', true], ['M10.3 11h3.4V7.6', true]],
    bloc: [['M8 1.5l5.6 2.1v4.2c0 3.4-2.3 5.6-5.6 6.9c-3.3-1.3-5.6-3.5-5.6-6.9V3.6Z']],
    legend: [['M2 3.5h2.5M2 8h2.5M2 12.5h2.5M6.5 3.5H14M6.5 8H14M6.5 12.5H14', true]],
    // Each alert kind's mark, for the badge row when the names do not fit.
    'alert-war': [['M3 3l10 10M13 3L3 13M2 6l4-4M10 2l4 4', true]],
    'alert-lost': [['M8 2v9M4 7.5L8 11.5l4-4M3 14h10', true]],
    'alert-taken': [['M4 14.5V2', true], ['M4.5 2.5h8.5l-2.2 3 2.2 3H4.5Z']],
    'alert-battle-lost': [['M8 1.5l5.6 2.1v4.2c0 3.4-2.3 5.6-5.6 6.9c-3.3-1.3-5.6-3.5-5.6-6.9V3.6ZM5.8 5.6l4.4 4.4M10.2 5.6l-4.4 4.4', true]],
    'alert-low-supply': [['M8 2l6.3 11.5H1.7ZM8 6.3v3.4M8 11.6v.2', true]],
    'alert-offer': [['M2 4h12v8.5H2ZM2.3 4.4L8 8.8l5.7-4.4', true]],
    'alert-event': [['M8 2a6 6 0 1 0 0 12a6 6 0 1 0 0-12ZM8 4.6V8l2.4 2', true]],
    'alert-staff': [['M2.5 13.5L13 3M7 3h6v6', true]],
  };
  function glyph(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('cq-glyph');
    for (const [d, stroke] of GLYPHS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      if (stroke) { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); }
      else p.setAttribute('fill', 'currentColor');
      svg.append(p);
    }
    return svg;
  }

  // ---------- panels ----------
  const panels = [];
  const panelActions = new Set();
  let dock = null;
  ui.panel = (def) => {
    if (!def || typeof def.id !== 'string' || typeof def.mount !== 'function') throw new Error('Conquest.ui.panel needs { id, mount }');
    const i = panels.findIndex((p) => p.id === def.id);
    const entry = { order: 100, icon: 'more', title: def.id, ...def, inst: null, body: null };
    if (i >= 0) panels.splice(i, 1, entry); else panels.push(entry);
    panels.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    if (!panelActions.has(def.id)) {
      panelActions.add(def.id);
      ide.registerAction({ id: `Conquest.Panel.${def.id}`, title: tr('Open or Close {panel}', { panel: entry.title }), keys: PANEL_KEYS[def.id] ? [PANEL_KEYS[def.id]] : [],
        when: playing, run: () => dock?.toggle(def.id) });
    }
    dock?.render();
  };

  function makeDock(body, buttons) {
    const wrap = el('div', 'cq-dock');
    const box = el('div', 'cq-dock-body');
    const head = el('div', 'cq-dock-head');
    const title = el('span', 'cq-dock-title');
    const close = el('button', 'cq-icon-btn cq-dock-close');
    close.append(ide.icon('closeSmall'));
    close.title = ide.keymap.withKeys(tr('Close Panel'), 'Conquest.Escape');
    close.setAttribute('aria-label', tr('Close Panel'));
    head.append(title, close);
    const content = el('div', 'cq-dock-content');
    box.append(head, content);
    wrap.append(box);
    body.prepend(wrap);
    let open = null;
    const d = {
      el: wrap,
      get open() { return open; },
      render() {
        buttons.replaceChildren(...panels.map((p) => {
          const b = el('button', 'cq-dock-tab');
          b.dataset.panel = p.id;
          b.append(ide.icon(p.icon), el('span', 'cq-dock-tab-label', p.title));
          b.title = ide.keymap.withKeys(p.title, `Conquest.Panel.${p.id}`);
          b.setAttribute('aria-label', p.title);
          b.onclick = () => d.toggle(p.id);
          return b;
        }));
        d.show(open);
      },
      toggle(id) { d.show(open === id ? null : id, true); },
      show(id, remember = false) {
        const p = panels.find((x) => x.id === id) || null;
        open = p && game.running ? p.id : null;
        if (remember) ide.settings.set('conquest.panel', open);
        wrap.classList.toggle('open', !!open);
        for (const b of buttons.children) { const on = b.dataset.panel === open; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
        for (const x of panels) if (x.body) x.body.hidden = x.id !== open;
        if (!p || !open) return;
        title.textContent = p.title;
        if (!p.body) {
          p.body = el('div', 'cq-panel');
          p.body.dataset.panel = p.id;
          content.append(p.body);
          try { p.inst = p.mount(p.body, game) || null; } catch (err) { log.error(`panel ${p.id}: ${err?.stack || err}`); }
        }
        p.body.hidden = false;
        d.update();
      },
      update() {
        const p = panels.find((x) => x.id === open);
        if (p?.inst?.update) try { p.inst.update(); } catch (err) { log.error(`panel ${p.id} update: ${err?.stack || err}`); }
      },
      reset() {
        for (const p of panels) { try { p.inst?.destroy?.(); } catch {} p.inst = null; p.body?.remove(); p.body = null; }
        d.show(null);
      },
    };
    close.onclick = () => d.show(null, true);
    return d;
  }

  // ---------- the shell ----------
  const shell = (ui.shell = { view: null, bind: null, root: null, stage: null, bar: null, mapSource: null, TOAST_MS });
  Conquest.app = {
    get view() { return shell.view; },
    get source() { return shell.mapSource; },
    get map() { return shell.view?.map || null; },
    setMode: (m) => shell.setMode(m),
  };

  shell.mount = (host) => {
    const root = el('div', 'cq-app');
    const bar = el('div', 'cq-bar');
    const body = el('div', 'cq-body');
    const stage = el('div', 'cq-stage');
    const armybar = el('div', 'cq-armybar');
    armybar.hidden = true;
    body.append(stage);
    root.append(bar, body, armybar);
    host.replaceChildren(root);
    Object.assign(shell, { root, stage, bar, armybar, body });
    buildBar(bar);
    dock = makeDock(body, barParts.panels);
    buildAlerts(stage);
    buildLegend(stage);
    buildCrash(stage);
    shell.toastEl = el('div', 'cq-toast');
    shell.toastEl.hidden = true;
    stage.append(shell.toastEl);
    dock.render();
    game.on('loaded', onLoaded);
    game.on('closed', onClosed);
    game.on('tick', onTick);
    game.on('event', onEvent);
    game.on('offers', onOffers);
    game.on('over', onOver);
    game.on('day', onDay);
    game.on('ordered', () => { dock.update(); refreshEconomy(); });
    game.on('crashed', onCrashed);
    game.on('speed', showSpeed);
    showGame(false);
  };

  // Replaces the map view when the map is another one. -> the view (its `ready` promise settles once drawn).
  shell.setMap = ({ map, idSource, source, owners, colors, names, capitals, homes }) => {
    if (shell.view && shell.view.map === map) {
      if (owners) shell.view.setOwners(owners, colors);
      if (names) shell.view.setNames(names, capitals, homes);
      return shell.view;
    }
    shell.bind?.destroy();
    shell.bind = null;
    shell.view?.destroy();
    const view = Conquest.view.create(shell.stage, { map, idSource });
    shell.stage.prepend(shell.stage.querySelector('.cq-map'));
    if (owners) view.setOwners(owners, colors);
    if (names) view.setNames(names, capitals, homes);
    shell.view = view;
    shell.mapSource = source;
    const first = view.on('frame', () => { first(); window.__conquestReady = true; });
    showModes();
    for (const fn of viewListeners) fn(view);
    return view;
  };
  const viewListeners = new Set();
  shell.onView = (fn) => { viewListeners.add(fn); if (shell.view) fn(shell.view); return () => viewListeners.delete(fn); };

  shell.setMode = (m) => {
    if (!shell.view) return;
    shell.view.setMode(m);
    showModes();
    renderLegend();
  };

  // A short message near a point of the stage (a refused order next to the cursor), gone after a few seconds.
  let toastTimer = 0;
  shell.toast = (text, at) => {
    const t = shell.toastEl;
    t.textContent = text;
    t.hidden = false;
    const w = shell.stage.clientWidth;
    const h = shell.stage.clientHeight;
    const x = at ? Math.min(Math.max(8, at.sx + 14), w - t.offsetWidth - 8) : (w - t.offsetWidth) / 2;
    const y = at ? Math.min(Math.max(8, at.sy - 34), h - t.offsetHeight - 8) : h - t.offsetHeight - 24;
    t.style.transform = `translate(${x}px, ${y}px)`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  };

  // ---------- top bar ----------
  let barParts = null;
  function buildBar(bar) {
    const brand = el('span', 'cq-title cq-brand', ide.appTitle);
    const player = el('span', 'cq-player');
    const chip = el('span', 'cq-chip');
    const name = el('span', 'cq-title cq-nation');
    player.append(chip, name);
    player.dataset.userText = '';
    const panelsBox = el('div', 'cq-panels');
    panelsBox.setAttribute('role', 'toolbar');
    panelsBox.setAttribute('aria-label', tr('Panels'));

    const time = el('div', 'cq-time');
    const date = el('span', 'cq-date');
    const speed = el('div', 'cq-speed');
    speed.setAttribute('role', 'group');
    speed.setAttribute('aria-label', tr('Game Speed'));
    const pause = el('button', 'cq-speed-pause');
    const pauseIcon = el('span', 'cq-speed-icon');
    const pauseText = el('span', 'cq-speed-text');
    pause.append(pauseIcon, pauseText);
    pause.onclick = () => game.togglePause();
    const slower = el('button', 'cq-speed-step cq-slower', '−');
    slower.title = ide.keymap.withKeys(tr('Slower'), 'Conquest.Slower');
    slower.setAttribute('aria-label', tr('Slower'));
    slower.onclick = () => game.setSpeed(Math.max(1, game.speed - 1));
    const faster = el('button', 'cq-speed-step cq-faster', '+');
    faster.title = ide.keymap.withKeys(tr('Faster'), 'Conquest.Faster');
    faster.setAttribute('aria-label', tr('Faster'));
    faster.onclick = () => game.setSpeed(Math.min(5, game.speed + 1));
    speed.append(pause, slower);
    const speeds = [];
    for (let n = 1; n <= 5; n++) {
      const b = el('button', 'cq-speed-n');
      b.dataset.speed = String(n);
      b.title = speedTitle(n);
      b.setAttribute('aria-label', tr('Speed {n}', { n }));
      b.onclick = () => game.setSpeed(n);
      b.append(el('span', 'cq-speed-pip'));
      speed.append(b);
      speeds.push(b);
    }
    speed.append(faster);
    time.append(date, speed);

    const stats = el('div', 'cq-stats');
    const values = {};
    for (const k of STAT_KEYS) {
      const s = el('button', 'cq-stat');
      s.dataset.stat = k;
      const v = el('span', 'cq-stat-value');
      s.append(glyph(k), v);
      s.setAttribute('aria-label', STAT_TITLES[k]());
      s.addEventListener('mouseenter', () => showStatTip(k));
      s.addEventListener('focus', () => showStatTip(k));
      s.addEventListener('mouseleave', hideStatTip);
      s.addEventListener('blur', hideStatTip);
      stats.append(s);
      values[k] = v;
    }
    const bonus = el('span', 'cq-bonus', tr('AI bonus'));
    bonus.title = tr('AI production bonus is on: the AI nations draft a quarter more men.');
    bonus.hidden = true;
    const help = el('button', 'cq-icon-btn cq-help');
    help.append(ide.icon('info'));
    help.title = tr('Show the First-Game Guide');
    help.setAttribute('aria-label', help.title);
    help.onclick = () => ui.events.emit('help');
    const gear = el('button', 'cq-icon-btn cq-settings');
    gear.append(ide.icon('settings'));
    gear.title = tr('Conquest Settings');
    gear.setAttribute('aria-label', gear.title);
    gear.onclick = () => ide.openSettings?.('conquest');
    const source = el('span', 'cq-source');
    const save = el('button', 'cq-btn cq-save');
    save.append(el('span', 'cq-long', tr('Save Game')), el('span', 'cq-short', tr('Save')));
    save.title = tr('Save Game');
    save.onclick = () => askSave();
    const quit = el('button', 'cq-btn cq-quit');
    quit.append(el('span', 'cq-long', tr('Quit to Start')), el('span', 'cq-short', tr('Quit')));
    quit.title = tr('Quit to Start');
    quit.onclick = () => quitToStart();
    bar.append(brand, player, panelsBox, stats, el('span', 'cq-gap'), bonus, source, time, help, gear, save, quit);
    barParts = { brand, player, chip, name, panels: panelsBox, time, date, pause, pauseIcon, pauseText, speeds, slower, faster, stats, values, source, save, quit, bonus, help };
  }

  function showGame(on) {
    const p = barParts;
    for (const n of [p.player, p.panels, p.time, p.stats, p.save, p.quit, p.help]) n.hidden = !on;
    p.bonus.hidden = !on || !game.meta?.aiBonus;
    p.brand.hidden = on;
    shell.armybar.hidden = !on;
    dock.el.hidden = !on;
    shell.legend.hidden = !on || !legendOpen();
    shell.legendToggle.hidden = !on;
    shell.alerts.hidden = !on;
    shell.pausedFlag.hidden = !on || game.speed !== 0;
    shell.root.classList.toggle('cq-playing', on);
    p.source.textContent = !on && shell.mapSource === 'generated' ? tr('Generated map') : '';
    if (!on) hideStatTip();
  }

  function showModes() {
    if (!shell.modes || !shell.view) return;
    for (const b of shell.modes.querySelectorAll('.cq-mode')) {
      const on = b.dataset.mode === shell.view.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    barParts.source.textContent = !game.running && shell.mapSource === 'generated' ? tr('Generated map') : '';
  }

  function showSpeed() {
    const p = barParts;
    const paused = game.speed === 0;
    const label = paused ? tr('Resume Game') : tr('Pause Game');
    p.pauseText.textContent = paused ? tr('Resume') : tr('Pause');
    p.pauseIcon.replaceChildren(ide.icon(paused ? 'resume' : 'pause'));
    p.pause.classList.toggle('paused', paused);
    p.pause.title = ide.keymap.withKeys(label, 'Conquest.Pause');
    p.pause.setAttribute('aria-label', label);
    p.pause.setAttribute('aria-pressed', String(paused));
    p.speeds.forEach((b, i) => { b.classList.toggle('on', i < Math.max(1, game.speed)); b.classList.toggle('active', game.speed === i + 1); b.setAttribute('aria-pressed', String(game.speed === i + 1)); });
    p.slower.disabled = game.speed <= 1;
    p.faster.disabled = game.speed >= 5;
    shell.root.classList.toggle('cq-paused', paused);
    shell.pausedFlag.hidden = !paused || !game.running;
  }

  let lastHourShown = -1;
  function showBar(full) {
    const p = barParts;
    if (game.hour !== lastHourShown) {
      lastHourShown = game.hour;
      p.date.textContent = ui.text.date(game.date(), true);
    }
    if (!full) return;
    const me = game.nations[game.player];
    const sn = game.scenario.nations[game.player];
    p.chip.style.background = sn?.color || '#888';
    p.name.textContent = game.nationName(game.player);
    p.player.title = p.name.textContent;
    if (!me) return;
    const v = p.values;
    v.manpower.textContent = ui.text.number(me.manpower);
    v.mil.textContent = String(game.factories?.mil ?? '?');
    v.civ.textContent = String(game.factories?.civ ?? '?');
    for (const k of ['coal', 'iron', 'oil']) {
      v[k].textContent = ui.text.percent(me.suff?.[k] ?? 1000);
      v[k].parentElement.classList.toggle('low', (me.suff?.[k] ?? 1000) < 700);
    }
    v.fatigue.textContent = ui.text.percent(me.fatigue);
    v.fatigue.parentElement.classList.toggle('low', me.fatigue >= 500);
    v.bloc.textContent = ui.text.bloc(me.bloc);
    if (tipKey) renderStatTip();
  }

  // ---------- the resource chips' tooltips ----------
  const STAT_KEYS = ['manpower', 'mil', 'civ', 'coal', 'iron', 'oil', 'fatigue', 'bloc'];
  const STAT_TITLES = { manpower: () => tr('Manpower'), mil: () => tr('Military factories'), civ: () => tr('Civil factories'), coal: () => tr('Coal'), iron: () => tr('Iron'),
    oil: () => tr('Oil'), fatigue: () => tr('War fatigue'), bloc: () => tr('Bloc') };
  let eco = null;
  let ecoSeq = 0;
  async function refreshEconomy() {
    if (!game.running) return;
    const seq = ++ecoSeq;
    try { const r = await game.query('economy', {}); if (seq === ecoSeq) { eco = r; if (tipKey) renderStatTip(); } } catch {}
  }
  let tipKey = null;
  function showStatTip(k) {
    if (!game.running) return;
    tipKey = k;
    renderStatTip();
    refreshEconomy();
  }
  function hideStatTip() {
    tipKey = null;
    ui.tip.hide();
  }
  // -> { title, note, rows: [[key, label, text, raw]] } from the mirror and the last `economy` answer.
  function statTip(k) {
    const me = game.nations[game.player] || {};
    const n = ui.text.number;
    const pc = ui.text.percent;
    const out = { title: STAT_TITLES[k](), note: '', rows: [] };
    const row = (key, label, raw, text = String(raw)) => out.rows.push([key, label, text, raw]);
    if (k === 'manpower') {
      out.note = tr('Men ready to form new divisions and to refill those that lost men.');
      row('pool', tr('Ready now'), me.manpower, n(me.manpower));
      if (eco) {
        row('recruits', tr('Recruits a day'), eco.manpower.recruits, n(eco.manpower.recruits));
        row('draft', tr('Drafted a day by mobilisation'), eco.manpower.draft, n(eco.manpower.draft));
        row('training', tr('In training'), eco.manpower.training, n(eco.manpower.training));
        row('casualties', tr('Lost so far'), eco.manpower.casualties, n(eco.manpower.casualties));
      }
    } else if (k === 'mil') {
      out.note = tr('They make equipment on the production lines.');
      row('mil', tr('Military factories'), game.factories?.mil ?? 0);
      if (eco) { row('used', tr('On production lines'), eco.used); row('free', tr('Free'), eco.free); }
    } else if (k === 'civ') {
      out.note = tr('They build factories, forts and railways.');
      row('civ', tr('Civil factories'), game.factories?.civ ?? 0);
      if (eco) { row('builds', tr('Building projects'), eco.builds.length); row('points', tr('Build points a day'), eco.civ * eco.perCiv); }
    } else if (k === 'coal' || k === 'iron' || k === 'oil') {
      out.note = tr('Production lines that need it run at the share their needs are covered.');
      const r = eco?.resources?.[k];
      row('suff', tr('Needs covered'), me.suff?.[k] ?? 1000, pc(me.suff?.[k] ?? 1000));
      if (r) {
        row('own', tr('Own provinces'), r.own, n(r.own));
        row('imported', tr('Imported'), r.imported, n(r.imported));
        row('demand', tr('Needed by the lines'), r.demand, n(r.demand));
        row('blockade', tr('Blockade'), r.blockade, pc(r.blockade));
      }
    } else if (k === 'fatigue') {
      const f = me.fatigue | 0;
      const at = eco?.fatigue || { capitulate: 600, collapse: 750, collapseBase: 3, collapseSlope: 25 };
      row('fatigue', tr('War fatigue'), f, pc(f));
      row('capitulate', tr('Capitulation possible from'), at.capitulate, pc(at.capitulate));
      row('collapse', tr('Collapse possible from'), at.collapse, pc(at.collapse));
      out.note = f >= at.collapse ? tr('At this level the nation may collapse: a {chance}‰ chance each day of a peace with every enemy.', { chance: at.collapseBase + Math.trunc((f - at.collapse) / at.collapseSlope) })
        : f >= at.capitulate ? tr('At this level the nation capitulates if two of these hold: its capital is lost, it holds under half its cores or factories, or it has under a third of its divisions.')
          : tr('It rises with losses, enemy-held home provinces, blockade and every day of war, and falls in peace. Below {at} it has no effect.', { at: pc(at.capitulate) });
    } else if (k === 'bloc') {
      out.note = tr('The camp the nation fights with.');
      const allies = game.nations.filter((x) => x.ally && x.alive).map((x) => game.nationName(x.index));
      const foes = game.nations.filter((x) => x.war && x.alive).map((x) => game.nationName(x.index));
      row('bloc', tr('Bloc'), me.bloc ?? '', ui.text.bloc(me.bloc));
      row('allies', tr('Allies'), allies.length, allies.length ? allies.slice(0, 6).join(', ') + (allies.length > 6 ? ` +${allies.length - 6}` : '') : tr('None'));
      row('war', tr('At war with'), foes.length, foes.length ? foes.slice(0, 6).join(', ') + (foes.length > 6 ? ` +${foes.length - 6}` : '') : tr('Nobody'));
    }
    return out;
  }
  function renderStatTip() {
    const p = barParts;
    const chipEl = p.stats.querySelector(`.cq-stat[data-stat="${tipKey}"]`);
    if (!chipEl || !game.running) return hideStatTip();
    ui.tip.show(chipEl, { ...statTip(tipKey), key: tipKey });
  }

  // The rate of each speed, for its tooltip (sim/host.js SPEED).
  const RATES = [0, 2, 6, 24, 72, 0];
  function speedTitle(n) {
    const r = RATES[n];
    const what = !r ? tr('as fast as this computer runs') : r < 24 ? tr('{h} game hours a second', { h: r }) : r === 24 ? tr('1 game day a second') : tr('{d} game days a second', { d: r / 24 });
    return ide.keymap.withKeys(tr('Speed {n}: {what}', { n, what }), `Conquest.Speed${n}`);
  }

  shell.openPanel = (id) => dock?.show(id, true);
  Object.defineProperty(shell, 'panelOpen', { get: () => dock?.open || null });

  // ---------- alerts ----------
  const alerts = new Map();
  let toasts = [];
  let openKind = null;
  let alertSeq = 0;
  const readPauseOn = () => ({ ...PAUSE_DEFAULT, ...(ide.settings.get('conquest.pauseOn', {}) || {}) });
  let pauseOn = readPauseOn();
  ide.on('settingsChanged', (key) => {
    if (key !== 'conquest.pauseOn' && key !== undefined) return;
    pauseOn = readPauseOn();
    for (const box of shell.alerts?.querySelectorAll('.cq-pause-row input') || []) box.checked = !!pauseOn[box.dataset.kind];
  });
  function buildAlerts(stage) {
    const box = el('div', 'cq-alerts');
    const badges = el('div', 'cq-alert-badges');
    badges.setAttribute('role', 'toolbar');
    badges.setAttribute('aria-label', tr('Alerts'));
    const gear = el('button', 'cq-icon-btn cq-alerts-gear');
    gear.append(ide.icon('settings'));
    gear.title = tr('Pause on Alerts');
    gear.setAttribute('aria-label', gear.title);
    gear.onclick = (e) => { e.stopPropagation(); pausePopover.hidden = !pausePopover.hidden; if (!pausePopover.hidden) closeKind(); };
    const badgeList = el('div', 'cq-alert-badge-list');
    badges.append(badgeList, gear);
    const pausePopover = el('div', 'cq-pause-pop');
    pausePopover.hidden = true;
    pausePopover.append(el('div', 'cq-pause-title', tr('Pause the game when this happens:')));
    for (const kind of ui.text.ALERT_KINDS) {
      const row = el('label', 'cq-pause-row');
      const box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.dataset.kind = kind;
      box2.checked = !!pauseOn[kind];
      box2.onchange = () => { pauseOn = { ...pauseOn, [kind]: box2.checked }; ide.settings.set('conquest.pauseOn', pauseOn); };
      row.append(box2, el('span', null, ui.text.alert(kind)));
      if (kind === 'offer') row.title = tr('An offer you refused or let lapse does not pause the game when the same nation makes it again on the same terms.');
      pausePopover.append(row);
    }
    const pop = el('div', 'cq-alert-pop');
    pop.hidden = true;
    const toastBox = el('div', 'cq-alerts-list');
    box.append(badges, pausePopover, pop, toastBox);
    stage.append(box);
    shell.alerts = box;
    shell.alertList = toastBox;
    Object.assign(shell, { alertBadges: badgeList, alertPop: pop, pausePop: pausePopover });
    ide.util.observeSize(stage, () => fitBadges());
  }

  const countOf = (kind) => (alerts.get(kind) || []).reduce((s, a) => s + a.count, 0);
  shell.alertCounts = () => Object.fromEntries(ui.text.ALERT_KINDS.filter((k) => countOf(k)).map((k) => [k, countOf(k)]));

  // The names show while every one fits whole; otherwise the row is compact: each kind's mark and count, with the
  // name in the tooltip and the accessible name. Measured again when the badges or the map's width change.
  function fitBadges() {
    const row = shell.alertBadges?.parentElement;
    if (!row || row.hidden) return;
    row.classList.remove('compact');
    const list = shell.alertBadges;
    const cut = list.scrollWidth > list.clientWidth + 1 || [...list.querySelectorAll('.cq-alert-badge-label')].some((l) => l.scrollWidth > l.clientWidth + 1);
    row.classList.toggle('compact', cut);
  }
  shell.fitBadges = fitBadges;

  // Badges are kept and updated in place: alerts come in while the game runs, and a badge rebuilt between the press and
  // the release of a click loses that click.
  const badgeEls = new Map();
  function renderBadges() {
    const want = ui.text.ALERT_KINDS.filter((k) => countOf(k) > 0).map((kind) => {
      let b = badgeEls.get(kind);
      if (!b) {
        b = el('button', `cq-alert-badge cq-alert-${kind}`);
        b.dataset.kind = kind;
        b.append(el('span', 'cq-alert-dot'), glyph(`alert-${kind}`), el('span', 'cq-alert-badge-label', ui.text.alert(kind)), el('span', 'cq-alert-count'));
        b.onclick = (e) => { e.stopPropagation(); if (openKind === kind) closeKind(); else openKindList(kind); };
        badgeEls.set(kind, b);
      }
      const n = countOf(kind);
      b.lastChild.textContent = String(n);
      b.title = tr('{kind}: {n}. Show the list.', { kind: ui.text.alert(kind), n });
      b.setAttribute('aria-label', tr('{kind}: {n}', { kind: ui.text.alert(kind), n }));
      b.setAttribute('aria-expanded', String(openKind === kind));
      b.classList.toggle('active', openKind === kind);
      return b;
    });
    const box = shell.alertBadges;
    if (want.length !== box.children.length || want.some((b, i) => box.children[i] !== b)) box.replaceChildren(...want);
    fitBadges();
  }
  function openKindList(kind) {
    openKind = kind;
    shell.pausePop.hidden = true;
    renderPop();
    renderBadges();
  }
  function closeKind() {
    if (openKind === null) return;
    openKind = null;
    shell.alertPop.hidden = true;
    shell.alertPop.replaceChildren();
    renderBadges();
  }
  shell.openAlerts = (kind) => (kind ? openKindList(kind) : closeKind());

  const dateOf = (a) => ui.text.date(game.date(a.hour));
  function alertBody(a, withKind) {
    const main = el('button', 'cq-alert-main');
    if (withKind) main.append(el('span', 'cq-alert-kind', ui.text.alert(a.kind) + (a.count > 1 ? ` ×${a.count}` : '')));
    main.append(el('span', 'cq-alert-text', a.text + (!withKind && a.count > 1 ? ` ×${a.count}` : '')), el('span', 'cq-alert-date', dateOf(a)));
    main.onclick = () => openAlert(a);
    return main;
  }
  function renderPop() {
    const pop = shell.alertPop;
    const list = alerts.get(openKind) || [];
    if (!openKind || !list.length) { openKind = null; pop.hidden = true; return; }
    const head = el('div', 'cq-alert-pop-head');
    const clear = el('button', 'cq-btn cq-alert-clear', tr('Clear'));
    clear.onclick = () => { alerts.delete(openKind); toasts = toasts.filter((t) => t.kind !== openKind); closeKind(); renderToasts(); renderBadges(); };
    head.append(el('span', 'cq-alert-pop-title', ui.text.alert(openKind)), clear);
    const rows = list.map((a) => {
      const row = el('div', `cq-alert-entry cq-alert-${a.kind}`);
      row.dataset.kind = a.kind;
      const x = el('button', 'cq-icon-btn cq-alert-close');
      x.append(ide.icon('closeSmall'));
      x.title = tr('Dismiss');
      x.setAttribute('aria-label', x.title);
      x.onclick = () => dismiss(a, true);
      row.append(alertBody(a, false), x);
      return row;
    });
    const box = el('div', 'cq-alert-pop-list');
    box.append(...rows);
    pop.replaceChildren(head, box);
    pop.hidden = false;
  }

  function openAlert(a) {
    if (a.prov > 0 && shell.view) {
      shell.view.focus(a.prov);
      shell.view.setSelected(a.prov);
      game.setSelection({ province: a.prov });
    }
    if (a.kind === 'offer') ui.events.emit('open-offer', a);
    dropToast(a);
    closeKind();
  }
  // Dismissing a toast leaves its entry under the badge; dismissing an entry removes both.
  function dismiss(a, entry) {
    dropToast(a);
    if (entry) {
      const list = (alerts.get(a.kind) || []).filter((b) => b !== a);
      if (list.length) alerts.set(a.kind, list); else alerts.delete(a.kind);
      renderBadges();
      if (openKind === a.kind) renderPop();
    }
  }

  function dropToast(a) {
    clearTimeout(a.timer);
    a.timer = 0;
    if (!toasts.includes(a)) return;
    toasts = toasts.filter((t) => t !== a);
    renderToasts();
  }
  function armToast(a) {
    clearTimeout(a.timer);
    a.timer = STICKY.has(a.kind) ? 0 : setTimeout(() => dropToast(a), TOAST_MS);
  }
  function renderToasts() {
    const want = toasts.map((a) => a.el || (a.el = toastRow(a)));
    const box = shell.alertList;
    if (want.length !== box.children.length || want.some((r, i) => box.children[i] !== r)) box.replaceChildren(...want);
  }
  function toastRow(a) {
    const row = el('div', `cq-alert cq-alert-${a.kind}`);
    row.dataset.kind = a.kind;
    row.setAttribute('role', STICKY.has(a.kind) ? 'alert' : 'status');
    const x = el('button', 'cq-icon-btn cq-alert-close');
    x.append(ide.icon('closeSmall'));
    x.title = tr('Dismiss');
    x.setAttribute('aria-label', x.title);
    x.onclick = () => dismiss(a, false);
    row.append(alertBody(a, true), x);
    row.onmouseenter = () => { clearTimeout(a.timer); a.timer = 0; };
    row.onmouseleave = () => armToast(a);
    return row;
  }
  function showToast(a) {
    toasts = [a, ...toasts.filter((t) => t !== a)];
    while (toasts.length > MAX_TOASTS) {
      const out = [...toasts].reverse().find((t) => !STICKY.has(t.kind)) || toasts[toasts.length - 1];
      clearTimeout(out.timer);
      toasts = toasts.filter((t) => t !== out);
    }
    armToast(a);
    renderToasts();
  }

  // Alerts of a kind about the same thing in one game day are counted on one entry.
  shell.alert = (kind, text, prov = 0, group = null, { quiet = false } = {}) => {
    const day = Math.floor(game.hour / 24);
    const list = alerts.get(kind) || [];
    let a = group && list.find((x) => x.group === group && Math.floor(x.hour / 24) === day);
    if (a) { a.count++; a.text = text; a.prov = prov || a.prov; a.hour = game.hour; a.el = null; list.splice(list.indexOf(a), 1); }
    else a = { id: ++alertSeq, kind, text, prov, hour: game.hour, group, count: 1, timer: 0 };
    list.unshift(a);
    if (list.length > KEEP_PER_KIND) list.length = KEEP_PER_KIND;
    alerts.set(kind, list);
    if (!quiet) showToast(a);
    renderBadges();
    if (openKind === kind) renderPop();
    if (!quiet && pauseOn[kind] && game.speed > 0) game.setSpeed(0);
    return a;
  };
  function clearAlerts() {
    for (const t of toasts) clearTimeout(t.timer);
    alerts.clear();
    toasts = [];
    openKind = null;
    shell.alertPop.hidden = true;
    renderToasts();
    renderBadges();
  }

  // A province changes hands: 'taken' when the player took it, 'lost' when an enemy took it from the player (from the
  // player's hands, or the player's own land from an ally's). Who held it before is the controller at the previous tick
  // (heldBefore): the log entry names only the new holder, and an ally taking a French province back is no loss.
  const capital = (n) => game.scenario.nations[n]?.capital || 0;
  shell.takenKind = (prov, before, by) => {
    const me = game.player;
    if (by === me) return before === me ? null : 'taken';
    if (ui.sideOf(game, by) !== 'enemy') return null;
    if (before === me) return 'lost';
    return game.prov.owner[prov] === me && before >= 0 && ui.sideOf(game, before) === 'ally' ? 'lost' : null;
  };
  function onEvent(e) {
    if (!game.running || e.live) return;
    const me = game.player;
    switch (e.kind) {
      case 'war':
        if (e.a === me || e.b === me) shell.alert('war', ui.text.log(e), capital(e.a === me ? e.b : e.a));
        return;
      case 'taken': {
        const before = heldBefore.has(e.prov) ? heldBefore.get(e.prov) : game.prov.ctrl[e.prov];
        const kind = shell.takenKind(e.prov, before, e.by);
        if (kind === 'taken') shell.alert('taken', ui.text.log(e), e.prov, 'taken');
        else if (kind === 'lost') shell.alert('lost', tr('{nation} took {province}', { nation: game.nationName(e.by), province: game.map.provinces[e.prov]?.name }), e.prov, 'lost');
        return;
      }
      case 'battle':
        if ((e.side === me && e.won === 'def') || (e.defender === me && e.won === 'att')) shell.alert('battle-lost', ui.text.log(e), e.prov, 'battle');
        return;
      case 'event':
        shell.alert('event', ui.text.event(e.key), 0);
        return;
      case 'accepted': case 'refused':
        onAnswered(e);
        return;
      case 'capitulated': case 'collapsed': case 'peace':
        if (e.nation === me || e.a === me || e.b === me || ui.sideOf(game, e.nation) !== 'neutral') shell.alert('event', ui.text.log(e), capital(e.nation ?? -1));
        return;
      default:
    }
  }
  // The controller of each province as of the last tick (ctrlSeen), and for the provinces this tick changed, the one
  // before it (heldBefore), which the tick's log entries are read against.
  let ctrlSeen = null;
  const heldBefore = new Map();

  // Offers to the player. The AI offers again every OFFER_DAYS what the player refused or let lapse; such a repeat (same
  // nation, kind and terms) is counted under the badge and listed in the inbox as offered again, but neither pauses
  // nor stays as a toast. An offer that left the list without the player's answer (it expired, or peace or war
  // overtook it) stays in the inbox as expired (offerGone) until dismissed; its toast leaves.
  let offerSeen = new Set();
  let offerLive = new Map(); // id -> offer, the player's incoming offers as last sent
  let declined = new Map(); // offer key -> times the player refused or let it lapse
  let offerGone = new Map(); // id -> { offer, reason: 'expired' | 'overtaken', hour }
  let offerKnown = new Map(); // id -> offer, every incoming offer seen this game
  const GONE_KEEP = 4;
  const answered = new Set(); // ids the player accepted or refused (the log entry comes before the list without it)
  const sortedIds = (a) => (a || []).slice().sort((x, y) => x - y).join(',');
  const offerKey = (o) => `${o.from}|${o.action}|${o.action === 'offer-peace' ? `${sortedIds(o.terms?.take)}/${sortedIds(o.terms?.give)}` : o.action === 'call-to-arms' ? o.terms?.against : ''}`;
  shell.offerRepeats = (o) => declined.get(offerKey(o)) || 0;
  shell.offerGone = () => [...offerGone.values()];
  shell.dismissGoneOffer = (id) => { offerGone.delete(id); ui.events.emit('offers-changed'); };
  const offerAlerts = (id) => (alerts.get('offer') || []).filter((a) => a.offer === id);
  shell.dropOfferToast = (id) => { for (const a of offerAlerts(id)) dropToast(a); };
  function onOffers(list) {
    const now = new Map((list || []).filter((o) => o.to === game.player).map((o) => [o.id, o]));
    for (const [id, o] of offerLive) {
      if (now.has(id)) continue;
      shell.dropOfferToast(id);
      if (answered.delete(id)) continue;
      const expired = game.hour >= o.expires;
      if (expired) declined.set(offerKey(o), (declined.get(offerKey(o)) || 0) + 1);
      // One expired card per nation, kind and terms, and the newest few: the AI's repeats would pile up otherwise.
      for (const [gid, g] of offerGone) if (offerKey(g.offer) === offerKey(o)) offerGone.delete(gid);
      offerGone.set(id, { offer: o, reason: expired ? 'expired' : 'overtaken', hour: game.hour });
      while (offerGone.size > GONE_KEEP) offerGone.delete(offerGone.keys().next().value);
    }
    offerLive = now;
    for (const o of now.values()) offerKnown.set(o.id, o);
    for (const o of now.values()) {
      if (offerSeen.has(o.id)) continue;
      offerSeen.add(o.id);
      const again = shell.offerRepeats(o);
      const nation = game.nationName(o.from);
      const action = ui.text.action(o.action);
      const text = again ? tr('{nation} offers again: {action} (offered {n} times)', { nation, action, n: again + 1 }) : tr('{nation} offers: {action}', { nation, action });
      const a = shell.alert('offer', text, capital(o.from), null, { quiet: again > 0 });
      a.offer = o.id;
    }
    ui.events.emit('offers-changed');
  }
  function onAnswered(e) {
    if (e.to !== game.player) return;
    answered.add(e.offer);
    const o = offerKnown.get(e.offer);
    if (e.kind === 'refused' && o) declined.set(offerKey(o), (declined.get(offerKey(o)) || 0) + 1);
  }
  function onOver() {
    for (const a of alerts.get('offer') || []) dropToast(a);
    ui.events.emit('offers-changed');
  }

  const lowArmies = new Set();
  function onDay() {
    dock.update();
    refreshEconomy();
    for (const a of game.me?.armies || []) {
      let s = 0;
      let n = 0;
      for (const id of a.divs) { const d = game.divs.get(id); if (d) { s += d.sup; n++; } }
      const low = n > 0 && s / n < LOW_SUPPLY;
      if (low && !lowArmies.has(a.id)) {
        lowArmies.add(a.id);
        const d = game.divs.get(a.divs[0]);
        shell.alert('low-supply', tr('{army} is short of supply', { army: a.name }), d?.prov || 0);
      } else if (!low) lowArmies.delete(a.id);
    }
  }

  // ---------- map modes and the legend ----------
  const legendOpen = () => ide.settings.get('conquest.legend', false) === true;
  function buildLegend(stage) {
    const modes = el('div', 'cq-modes');
    modes.setAttribute('role', 'toolbar');
    modes.setAttribute('aria-label', tr('Map Mode'));
    for (const m of Conquest.view.MODES) {
      const b = el('button', 'cq-mode', MODE_LABELS[m]());
      b.dataset.mode = m;
      b.title = ide.keymap.withKeys(tr('{mode} map mode', { mode: MODE_LABELS[m]() }), `Conquest.Mode.${m}`);
      b.onclick = () => shell.setMode(m);
      modes.append(b);
    }
    const toggle = el('button', 'cq-icon-btn cq-legend-toggle');
    toggle.append(glyph('legend'));
    toggle.title = ide.keymap.withKeys(tr('Show or Hide the Legend'), 'Conquest.Legend');
    toggle.setAttribute('aria-label', tr('Legend'));
    toggle.onclick = () => setLegend(!legendOpen());
    modes.append(el('span', 'cq-modes-sep'), toggle);
    shell.legend = el('div', 'cq-legend');
    shell.legend.id = 'cq-legend';
    toggle.setAttribute('aria-controls', shell.legend.id);
    stage.append(shell.legend, modes);
    Object.assign(shell, { modes, legendToggle: toggle });
    showLegendState();
  }
  function setLegend(on) {
    ide.settings.set('conquest.legend', !!on);
    showLegendState();
  }
  function showLegendState() {
    const on = legendOpen();
    shell.legendToggle.classList.toggle('active', on);
    shell.legendToggle.setAttribute('aria-pressed', String(on));
    shell.legend.hidden = !on || !game.running;
    if (on) renderLegend();
  }
  shell.setLegend = setLegend;
  ide.on('settingsChanged', (key) => { if ((key === 'conquest.legend' || key === undefined) && shell.legend) showLegendState(); });

  function swatch(color, label, cls = '') {
    const row = el('div', 'cq-legend-row');
    const s = el('span', `cq-swatch ${cls}`);
    s.style.setProperty('--c', color);
    row.append(s, el('span', null, label));
    return row;
  }
  function renderLegend() {
    const L = shell.legend;
    if (!L || !shell.view) return;
    const mode = shell.view.mode;
    const rows = [el('div', 'cq-legend-title', MODE_LABELS[mode]?.() || mode)];
    if (mode === 'political') rows.push(el('div', 'cq-legend-note', tr('Colours show who holds a province; occupied land is tinted toward its owner.')));
    if (mode === 'supply') rows.push(swatch('#56a85c', tr('Well supplied')), swatch('#d6ba46', tr('Low supply')), swatch('#c44034', tr('Cut off')), swatch('#a39f95', tr('Not ours')));
    if (mode === 'weather') for (const [k, c] of [['clear', '#cdd6ae'], ['rain', '#7fa3c4'], ['mud', '#8c7050'], ['snow', '#eef1f4'], ['frost', '#a8c4dc']]) rows.push(swatch(c, ui.text.weather(k)));
    if (mode === 'diplomacy') rows.push(swatch('#f0b44c', tr('Us')), swatch('#5b8fd9', tr('Allies')), swatch('#d0504a', tr('At war with us')), swatch('#7ab48c', tr('Military access')), swatch('#a39f95', tr('Neutral')));
    rows.push(el('div', 'cq-legend-sep'));
    rows.push(swatch('#f4f1e8', tr('Our divisions'), 'ring'), swatch('#7fb2ff', tr('Allied divisions'), 'ring'), swatch('#ff5a4a', tr('Enemy divisions'), 'ring'), swatch('#ffd84a', tr('Selected'), 'ring'));
    rows.push(swatch('#f0b44c', tr('Front'), 'dash'), swatch('#f0b44c', tr('Planned offensive'), 'dash wide'), swatch('#f0b44c', tr('Launched offensive'), 'wide'));
    L.replaceChildren(...rows);
  }

  // ---------- the paused flag and the crash notice ----------
  function buildCrash(stage) {
    const flag = el('div', 'cq-paused-flag');
    flag.append(el('span', 'cq-paused-word', tr('Paused')), el('span', 'cq-paused-hint', tr('Space resumes')));
    flag.hidden = true;
    stage.append(flag);
    shell.pausedFlag = flag;
    const box = el('div', 'cq-crash');
    box.hidden = true;
    const card = el('div', 'cq-crash-card');
    const title = el('div', 'cq-crash-title', tr('The simulation stopped'));
    const msg = el('div', 'cq-crash-msg');
    msg.dataset.userText = '';
    const row = el('div', 'cq-crash-buttons');
    const reload = el('button', 'cq-btn primary cq-crash-reload', tr('Reload Last Save'));
    const back = el('button', 'cq-btn cq-crash-back', tr('Back to Start'));
    reload.onclick = async () => {
      reload.disabled = true;
      const r = await game.reloadLast();
      reload.disabled = false;
      if (r.ok) box.hidden = true;
      else msg.textContent = tr('The save could not be loaded: {reason}', { reason: ui.text.reason(r.reason) });
    };
    back.onclick = () => { box.hidden = true; onClosed(); };
    row.append(reload, back);
    card.append(title, el('div', 'cq-crash-hint', tr('The game is paused where it was last saved. Reload the last save to go on from there.')), msg, row);
    box.append(card);
    stage.append(box);
    shell.crash = { box, msg };
  }
  function onCrashed({ message }) {
    shell.crash.msg.textContent = message;
    shell.crash.box.hidden = false;
    showSpeed();
  }

  // ---------- game life ----------
  function onLoaded() {
    shell.crash.box.hidden = true;
    const view = shell.setMap({ map: game.map, idSource: game.idSource, source: game.source });
    shell.bind?.destroy();
    shell.bind = ui.mapbind(view, game, shell.stage);
    clearAlerts();
    offerSeen = new Set(game.offers.filter((o) => o.to === game.player).map((o) => o.id));
    offerLive = new Map(game.offers.filter((o) => o.to === game.player).map((o) => [o.id, o]));
    offerKnown = new Map(offerLive);
    declined = new Map();
    offerGone = new Map();
    answered.clear();
    lowArmies.clear();
    ctrlSeen = Int16Array.from(game.prov.ctrl);
    heldBefore.clear();
    eco = null;
    lastHourShown = -1;
    showGame(true);
    showBar(true);
    showSpeed();
    showLegendState();
    dock.reset();
    dock.render();
    dock.show(ide.settings.get('conquest.panel', null));
    refreshEconomy();
    ui.events.emit('game', game);
  }
  function onClosed() {
    shell.bind?.destroy();
    shell.bind = null;
    dock.reset();
    clearAlerts();
    showGame(false);
    ui.events.emit('start');
  }
  function onTick(d) {
    if (!game.running) return;
    heldBefore.clear();
    if (d.provinces.size && ctrlSeen) {
      for (const id of d.provinces) { heldBefore.set(id, ctrlSeen[id]); ctrlSeen[id] = game.prov.ctrl[id]; }
    }
    showBar(d.nations || d.me);
  }

  async function askSave() {
    const wasRunning = game.speed;
    const input = document.createElement('input');
    input.className = 'cq-input';
    const d = game.date();
    input.value = `${game.scenario.nations[game.player]?.tag || 'Game'} ${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    const body = el('div', 'cq-save-dialog');
    body.append(el('div', null, tr('Save name:')), input);
    ide.ui.dialog({
      title: tr('Save Game'),
      body,
      width: 380,
      buttons: [{ label: tr('Save Game'), primary: true, run: async () => {
        const r = await game.save(input.value.trim());
        shell.toast(r.ok ? tr('Saved "{name}"', { name: input.value.trim() }) : tr('Could not save: {reason}', { reason: ui.text.reason(r.code) }));
        if (wasRunning) game.setSpeed(wasRunning);
      } }, { label: tr('Cancel') }],
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  async function quitToStart() {
    const auto = ide.settings.get('conquest.autosave', true) !== false;
    const ok = await ide.ui.confirm(auto ? tr('The game is saved as "{name}" and you go back to the start screen.', { name: tr('Autosave') }) : tr('Autosave is off: the game is not saved. Go back to the start screen?'),
      { title: tr('Quit to Start'), ok: tr('Quit to Start') });
    if (!ok) return;
    await game.autosave();
    game.close();
  }

  // ---------- keys ----------
  // Main row and numpad alike: the keymap names a key by what it types (NumpadAdd is '+', Numpad3 is '3').
  ide.registerAction({ id: 'Conquest.Pause', title: tr('Pause or Resume'), keys: ['Space'], when: playing, run: () => game.togglePause() });
  ide.registerAction({ id: 'Conquest.Faster', title: tr('Faster'), keys: ['+', '=', 'Shift+='], when: playing, run: () => game.setSpeed(Math.min(5, game.speed + 1)) });
  ide.registerAction({ id: 'Conquest.Slower', title: tr('Slower'), keys: ['-'], when: playing, run: () => game.setSpeed(Math.max(1, game.speed - 1)) });
  for (let n = 1; n <= 5; n++) ide.registerAction({ id: `Conquest.Speed${n}`, title: tr('Speed {n}', { n }), keys: [String(n)], when: playing, run: () => game.setSpeed(n) });
  for (const m of Object.keys(MODE_KEYS)) ide.registerAction({ id: `Conquest.Mode.${m}`, title: tr('{mode} map mode', { mode: MODE_LABELS[m]() }), keys: [MODE_KEYS[m]], when: playing, run: () => shell.setMode(m) });
  ide.registerAction({ id: 'Conquest.Legend', title: tr('Show or Hide the Legend'), keys: ['L'], when: playing, run: () => setLegend(!legendOpen()) });
  // Escape closes what is open over the map: an alert list or the pause settings, else the first open window of
  // shell.overlays ({ open(), close() }, in the order pushed: ui/battle.js's division detail, then its battle window),
  // else the panel. ui/command.js's Escape (registered later, so asked first) cancels a plan being drawn, or clears the
  // selection when nothing is open.
  const popupOpen = () => !!(shell.alertPop && !shell.alertPop.hidden) || !!(shell.pausePop && !shell.pausePop.hidden);
  shell.overlays = [];
  const windowOpen = () => shell.overlays.find((o) => o.open()) || null;
  shell.overlayOpen = () => popupOpen() || !!windowOpen() || !!dock?.open;
  ide.registerAction({ id: 'Conquest.Escape', title: tr('Close the Panel'), keys: ['Escape'], when: () => playing() && shell.overlayOpen(),
    run: () => { const w = windowOpen(); if (popupOpen()) { closeKind(); shell.pausePop.hidden = true; } else if (w) w.close(); else dock.show(null, true); } });
  document.addEventListener('pointerdown', (e) => {
    if (!shell.alerts || shell.alerts.contains(e.target)) return;
    closeKind();
    if (shell.pausePop) shell.pausePop.hidden = true;
  }, true);

  // A tiny event hub for the ui scripts (start screen, command, panels added later).
  const hub = new Map();
  ui.events = {
    on(name, fn) { if (!hub.has(name)) hub.set(name, new Set()); hub.get(name).add(fn); return () => hub.get(name)?.delete(fn); },
    emit(name, arg) { for (const fn of hub.get(name) || []) try { fn(arg); } catch (err) { log.error(`${name}: ${err?.stack || err}`); } },
  };

  // The built-in log panel: the event log, newest first.
  ui.panel({
    id: 'log', title: tr('Event Log'), icon: 'history', order: 900,
    mount(root) {
      const list = el('div', 'cq-log');
      root.append(list);
      const SHOW = 200;
      const row = (e) => {
        const r = el('div', `cq-log-row cq-log-${e.kind}`);
        r.append(el('span', 'cq-log-date', ui.text.date(game.date(e.hour))), el('span', 'cq-log-text', ui.text.log(e)));
        if (e.prov > 0) { r.classList.add('link'); r.onclick = () => { shell.view?.focus(e.prov); shell.view?.setSelected(e.prov); game.setSelection({ province: e.prov }); }; }
        return r;
      };
      let shown = -1;
      const update = () => {
        if (shown === game.log.length && list.childElementCount) return;
        shown = game.log.length;
        const items = ui.text.oncePerEvent(game.log.slice(-SHOW)).reverse();
        list.replaceChildren(...items.map(row));
      };
      const off = game.on('event', () => { if (!root.hidden) update(); });
      return { update, destroy: off };
    },
  });
})();
