// The first-game guide (plan 7): a small card at the foot of the map that walks the real controls with the game paused,
// one step at a time, each with the control it is about outlined: pick an army, give it a front (drawn, or Staff
// Front), open the designer and look at the template, open production and add a factory to a line, draw an offensive,
// launch it, read an alert, and open the judgment panel when that panel is there (id 'judgment'; the step is left out
// otherwise). A step advances when the player does the thing (an order the worker accepted, a panel opened, an army
// selected, an alert clicked); the looking steps have Next. Skip Step, Close (for this game) and Don't Show Again
// (conquest.guideDone, also set at the end). It opens with the first new game while conquest.guideDone is not set,
// and from the top bar's Help button ('help' on Conquest.ui.events) at any time. Conquest.ui.guide = { show(), close(),
// step } for tests.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;
  const DONE = 'conquest.guideDone';

  const openIs = (id) => () => shell.panelOpen === id;
  const freeFactories = () => (game.factories?.mil || 0) - (game.me?.lines || []).reduce((s, l) => s + l.factories, 0);
  const ordered = (test) => ({ kind: 'order', test });
  const STEPS = [
    { id: 'army', title: () => tr('Pick an army'), text: () => tr('The army bar at the bottom lists your armies. Click one to select it (its divisions light up on the map), double-click it to find it on the map. On the map a left drag draws a box that selects your divisions, a right drag moves the map.'),
      target: '.cq-army', done: { kind: 'state', test: () => game.selection.army !== null } },
    { id: 'front', title: () => tr('Give it a front'), text: () => tr('Draw Front, then click or drag along the border and press Enter; or let the staff choose with Staff Front. The general spreads the army along it.'),
      target: '.cq-draw-front, .cq-staff-front', done: ordered((o) => o.type === 'front' && o.provinces), staffed: true },
    { id: 'designer', title: () => tr('Open the Division Designer'), text: () => tr('The buttons at the left of the top bar open the panels, one at a time beside the map. Open the Division Designer.'),
      target: '.cq-dock-tab[data-panel="designer"]', done: { kind: 'state', test: openIs('designer') } },
    { id: 'template', title: () => tr('Look at the template'), text: () => tr('Each slot is a battalion. The stats change as you change slots, and the counters check says in plain words what the layout is good and bad at.'),
      target: '.cq-sec-layout, .cq-sec-check', next: true },
    { id: 'production', title: () => tr('Open Production'), text: () => tr('Open the Production panel: your factories, lines, stock and resources.'),
      target: '.cq-dock-tab[data-panel="production"]', done: { kind: 'state', test: openIs('production') } },
    // Most great powers start with every military factory on a line, so + alone is refused: then the step says how to
    // free one, and any accepted line order (a − too) advances it.
    { id: 'factories', title: () => tr('Add factories to a line'), text: () => (freeFactories() > 0
      ? tr('Press + on a line to put a free military factory on it. Its output a day rises from the next day.')
      : tr('Every military factory is on a line now. Press − on a line to free one, then + on the line that should make more. The output changes from the next day.')),
    target: '.cq-line .cq-step-plus', done: ordered((o) => o.type === 'line') },
    { id: 'offensive', title: () => tr('Draw an offensive'), text: () => tr('Select an army, press Draw Offensive and click from its front toward the objective in enemy land, then Enter.'),
      target: '.cq-draw-offensive, .cq-army', done: ordered((o) => o.type === 'offensive' && Array.isArray(o.path)) },
    { id: 'launch', title: () => tr('Launch it'), text: () => tr('Press Launch Offensive in the list of offensives; the Offensives button under the map opens it. The general attacks where the odds are best along the arrow.'),
      target: '.cq-offs-pop:not([hidden]) .cq-launch, .cq-offs-btn[aria-expanded="false"]', done: ordered((o) => o.type === 'launch' && o.on) },
    { id: 'alert', title: () => tr('Read the alerts'), text: () => tr('Press Space to let time run. A new alert shows at the top right for a moment and is kept under its badge below the top bar: click one to see where it happened.'),
      target: '.cq-alerts', done: { kind: 'alert' }, next: true },
    { id: 'judgment', title: () => tr('See why the AI decided'), text: () => tr('Open this panel to see what each nation weighed before it acted.'),
      target: '.cq-dock-tab[data-panel="judgment"]', done: { kind: 'state', test: openIs('judgment') }, when: () => !!document.querySelector('.cq-dock-tab[data-panel="judgment"]') },
  ];

  let box = null;
  let at = -1;
  let timer = 0;

  function build() {
    box = el('div', 'cq-guide');
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    const count = el('div', 'cq-guide-count');
    const title = el('div', 'cq-guide-title');
    const text = el('div', 'cq-guide-text');
    const row = el('div', 'cq-guide-buttons');
    const next = el('button', 'cq-btn primary cq-guide-next', tr('Next'));
    const skip = el('button', 'cq-btn cq-guide-skip', tr('Skip Step'));
    const close = el('button', 'cq-btn cq-guide-close', tr('Close'));
    const never = el('button', 'cq-btn cq-guide-never', tr("Don't Show Again"));
    next.onclick = () => advance();
    skip.onclick = () => advance();
    close.onclick = () => hide();
    never.onclick = () => { ide.settings.set(DONE, true); hide(); };
    row.append(next, skip, el('span', 'cq-gap'), close, never);
    box.append(count, title, text, row);
    shell.stage.append(box);
    // Not box.title: that is the element's tooltip attribute, and the heading would never show.
    Object.assign(box, { count, heading: title, text, next, skip });
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    shell.alerts?.addEventListener('click', (e) => { if (e.target.closest?.('.cq-alert-main') && STEPS[at]?.done?.kind === 'alert') advance(); });
  }

  const steps = () => STEPS;
  function show() {
    if (!game.running) return;
    if (!box) build();
    if (game.speed > 0) game.setSpeed(0);
    at = -1;
    box.hidden = false;
    advance();
  }
  function hide() {
    at = -1;
    if (box) box.hidden = true;
    mark(null);
    clearInterval(timer);
    timer = 0;
  }
  function advance() {
    for (at++; at < STEPS.length && STEPS[at].when && !STEPS[at].when(); at++);
    if (at >= STEPS.length) { ide.settings.set(DONE, true); hide(); shell.toast(tr('That is the whole guide: Help in the top bar shows it again.')); return; }
    const s = STEPS[at];
    const n = STEPS.filter((x) => !x.when || x.when()).length;
    const i = STEPS.slice(0, at + 1).filter((x) => !x.when || x.when()).length;
    box.count.textContent = tr('Step {i} of {n}', { i, n });
    box.heading.textContent = s.title();
    box.text.textContent = s.text();
    box.dataset.step = s.id;
    box.next.hidden = !s.next;
    if (!timer) timer = setInterval(tick, 400);
    tick();
  }
  // Outlines the step's control (lists are redrawn, so the outline is put back) and checks a state step.
  function tick() {
    const s = STEPS[at];
    if (!s || !box || box.hidden) return;
    if (s.done?.kind === 'state' && s.done.test()) return advance();
    mark(s.target);
  }
  let marked = [];
  function mark(sel) {
    const want = sel ? [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length).slice(0, 1) : [];
    if (sel && sel.includes(',')) for (const part of sel.split(',')) { const n = [...document.querySelectorAll(part)].find((x) => x.getClientRects().length); if (n && !want.includes(n)) want.push(n); }
    for (const n of marked) if (!want.includes(n)) n.classList.remove('cq-guide-target');
    for (const n of want) n.classList.add('cq-guide-target');
    marked = want;
  }

  game.on('ordered', ({ order, result }) => {
    const s = STEPS[at];
    if (result.ok && s?.done?.kind === 'order' && s.done.test(order)) advance();
  });
  ui.events.on('staffed', ({ force }) => { if (force && STEPS[at]?.staffed) advance(); });
  game.on('loaded', ({ save }) => {
    hide();
    if (save === null && ide.settings.get(DONE, false) !== true) setTimeout(show, 0);
  });
  game.on('closed', hide);
  ui.events.on('help', () => show());

  ui.guide = { show, close: hide, get step() { return at >= 0 && box && !box.hidden ? STEPS[at].id : null; }, get steps() { return steps().map((s) => s.id); } };
})();
