// The start screen, what the Conquest window opens to while no game runs: a card over the map with Continue (the
// newest autosave: each game has its own, ui/game.js), New Game (scenario: the 1914 world or a generated map with its size, nations, seed and "at war from the
// start"; the nation, picked by clicking the map or from the great powers listed, with a line about it from the
// scenario; difficulty; seed) and Load Game (every save with its date and nation, newest first). The map behind it is
// the scenario's own, coloured by its owners. The form is built once; only the lists are redrawn.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const log = ide.logger('#conquest');
  const game = Conquest.game;
  const shell = ui.shell;

  const GEN_DEFAULT = { provinces: 160, nations: 4, seed: 7, war: false };
  let data = null;
  let choice = { scenario: 'world', player: -1, difficulty: 'normal', seed: 1914, gen: { ...GEN_DEFAULT } };
  let form = null;
  let offSelect = null;

  function segmented(cls, items, pick) {
    const box = el('div', `cq-seg ${cls}`);
    const buttons = items.map(([value, label]) => {
      const b = el('button', 'cq-seg-btn', label);
      b.dataset.value = value;
      b.onclick = () => pick(value);
      box.append(b);
      return b;
    });
    return { box, show(v) { for (const b of buttons) b.classList.toggle('active', b.dataset.value === v); } };
  }
  const numberInput = (cls, value, min, max) => {
    const i = document.createElement('input');
    i.type = 'number';
    i.className = `cq-input ${cls}`;
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    return i;
  };
  const field = (label, control) => { const f = el('label', 'cq-field'); f.append(el('span', 'cq-field-label', label), control); return f; };

  function build() {
    const box = el('div', 'cq-start');
    box.append(el('div', 'cq-start-title', ide.appTitle), el('div', 'cq-start-sub', tr('Lead a nation through the Great War')));
    const cont = el('button', 'cq-btn primary cq-continue');
    cont.hidden = true;
    cont.onclick = () => { if (cont.dataset.save) loadSave(cont.dataset.save, cont); };
    const tabs = segmented('cq-start-tabs', [['new', tr('New Game')], ['load', tr('Load Game')]], (v) => showTab(v));

    const pageNew = el('div', 'cq-start-page cq-start-new');
    const scen = segmented('cq-scenario', [['world', tr('1914 World')], ['generated', tr('Generated Map')]], (v) => pickScenario(v));
    const gen = el('div', 'cq-gen');
    const gp = numberInput('cq-gen-provinces', GEN_DEFAULT.provinces, 8, 3000);
    const gn = numberInput('cq-gen-nations', GEN_DEFAULT.nations, 2, 24);
    const gs = numberInput('cq-gen-seed', GEN_DEFAULT.seed, 0, 999999);
    const warBox = document.createElement('input');
    warBox.type = 'checkbox';
    warBox.className = 'cq-gen-war';
    const warRow = el('label', 'cq-check');
    warRow.append(warBox, el('span', null, tr('At war from the start')));
    const regen = el('button', 'cq-btn cq-generate', tr('Generate Map'));
    regen.onclick = () => {
      choice.gen = { provinces: Math.max(8, Math.min(3000, gp.value | 0)), nations: Math.max(2, Math.min(24, gn.value | 0)), seed: gs.value | 0, war: warBox.checked };
      showScenario();
    };
    gen.append(field(tr('Provinces'), gp), field(tr('Nations'), gn), field(tr('Map seed'), gs), warRow, regen);

    const nationHead = el('div', 'cq-start-label', tr('Nation'));
    const hint = el('div', 'cq-start-hint', tr('Click a nation on the map, or pick a great power:'));
    const majors = el('div', 'cq-majors');
    const picked = el('div', 'cq-picked');
    const pickedName = el('div', 'cq-picked-name');
    const pickedText = el('div', 'cq-picked-text');
    picked.append(pickedName, pickedText);
    const diff = segmented('cq-difficulty', ['easy', 'normal', 'hard'].map((d) => [d, ui.text.difficulty(d)]), (v) => { choice.difficulty = v; diff.show(v); });
    const seed = numberInput('cq-seed', choice.seed, 0, 999999999);
    const startBtn = el('button', 'cq-btn primary cq-start-game', tr('Start Game'));
    startBtn.onclick = () => startGame();
    const status = el('div', 'cq-start-status');
    pageNew.append(field(tr('Scenario'), scen.box), gen, nationHead, hint, majors, picked, field(tr('Difficulty'), diff.box), field(tr('Seed'), seed), startBtn);

    const pageLoad = el('div', 'cq-start-page cq-start-load');
    const saves = el('div', 'cq-saves');
    pageLoad.append(saves);
    box.append(cont, tabs.box, pageNew, pageLoad, status);
    shell.stage.append(box);
    form = { box, cont, tabs, pageNew, pageLoad, scen, gen, gp, gn, gs, warBox, majors, picked, pickedName, pickedText, diff, seed, startBtn, status, saves };
    diff.show(choice.difficulty);
    showTab('new');
  }

  function showTab(v) {
    form.tabs.show(v);
    form.pageNew.hidden = v !== 'new';
    form.pageLoad.hidden = v !== 'load';
    if (v === 'load') listSaves();
  }

  const setStatus = (text, bad = false) => { form.status.textContent = text || ''; form.status.classList.toggle('bad', bad); };

  async function pickScenario(v) {
    choice.scenario = v;
    choice.player = -1;
    await showScenario();
  }

  async function showScenario() {
    form.scen.show(choice.scenario);
    form.gen.hidden = choice.scenario !== 'generated';
    setStatus(tr('Loading the map…'));
    try {
      if (choice.scenario === 'world') data = await game.loadWorld();
      else {
        const g = await game.generate(choice.gen);
        data = { source: 'generated', map: g.map, scenario: g.scenario, rules: null, idSource: Conquest.view.rasterize(g.map) };
      }
    } catch (err) {
      log.warn(`the ${choice.scenario} map did not load: ${err?.message || err}`);
      if (choice.scenario === 'world') { choice.scenario = 'generated'; return showScenario(); }
      setStatus(tr('The map could not start: {message}', { message: String(err?.message || err) }), true);
      return;
    }
    const owners = new Int16Array(data.map.provinces.length).fill(-1);
    data.scenario.nations.forEach((n, i) => { for (const id of data.scenario.owner?.[n.tag] || []) if (id > 0 && id < owners.length) owners[id] = i; });
    data.owners = owners;
    const view = shell.setMap({ map: data.map, idSource: data.idSource, source: data.source, owners, colors: data.scenario.nations.map((n) => n.color),
      names: data.scenario.nations.map((n) => ui.text.nation(n.name)), capitals: data.scenario.nations.map((n) => n.capital), homes: ui.homesOf(data.scenario) });
    offSelect?.();
    offSelect = view.on('select', ({ id }) => { if (!game.running && id > 0 && owners[id] >= 0) pickNation(owners[id]); });
    setStatus('');
    renderMajors();
    if (choice.player < 0) pickNation(Math.max(0, data.scenario.nations.findIndex((n) => n.tag === 'FRA')));
    else pickNation(choice.player);
  }

  function renderMajors() {
    const sc = data.scenario;
    const list = sc.nations.map((n, i) => ({ n, i })).filter(({ n }) => n.major);
    const shown = list.length ? list : sc.nations.map((n, i) => ({ n, i }));
    form.majors.replaceChildren(...shown.map(({ n, i }) => {
      const b = el('button', 'cq-major');
      b.dataset.tag = n.tag;
      const chip = el('span', 'cq-chip');
      chip.style.background = n.color;
      b.append(chip, el('span', null, ui.text.nation(n.name)));
      b.onclick = () => { pickNation(i); shell.view?.focus(n.capital); };
      return b;
    }));
  }

  function describe(i) {
    const sc = data.scenario;
    const n = sc.nations[i];
    const owned = sc.owner?.[n.tag] || [];
    let mil = 0;
    let civ = 0;
    for (const p of owned) { mil += sc.provinces?.[p]?.mil | 0; civ += sc.provinces?.[p]?.civ | 0; }
    const divisions = (sc.armies || []).filter((a) => a.nation === n.tag).reduce((s, a) => s + (a.divisions | 0), 0);
    const parts = [n.bloc ? ui.text.bloc(n.bloc) : tr('No bloc'), tr('{n} provinces', { n: owned.length }), tr('{n} divisions', { n: divisions }),
      tr('{mil} military and {civ} civil factories', { mil, civ })];
    const goal = (n.goals || []).find((g) => g.kind === 'take');
    let text = `${parts.join(' · ')}.`;
    if (n.personality) text += ` ${n.personality.revanchism >= 70 ? tr('It wants lost land back.') : n.personality.boldness >= 60 ? tr('It is bold and ambitious.') : n.personality.caution >= 60 ? tr('It is cautious.') : ''}`;
    if (goal) text += ` ${tr('Aim: {goal}.', { goal: ui.text.words(goal.id) })}`;
    return text.trim();
  }

  function pickNation(i) {
    if (!data || !data.scenario.nations[i]) return;
    choice.player = i;
    const n = data.scenario.nations[i];
    form.pickedName.textContent = ui.text.nation(n.name);
    form.pickedName.style.setProperty('--c', n.color);
    form.pickedText.textContent = describe(i);
    form.picked.dataset.tag = n.tag;
    for (const b of form.majors.children) b.classList.toggle('active', b.dataset.tag === n.tag);
    form.startBtn.disabled = false;
  }

  async function startGame() {
    if (choice.player < 0) return;
    form.startBtn.disabled = true;
    setStatus(tr('Starting the game…'));
    const r = await game.newGame({ data, scenario: choice.scenario, gen: choice.scenario === 'generated' ? choice.gen : null, player: choice.player, seed: form.seed.value | 0, difficulty: choice.difficulty });
    form.startBtn.disabled = false;
    if (!r.ok) setStatus(tr('The game could not start: {reason}', { reason: ui.text.reason(r.reason) }), true);
    else setStatus('');
  }

  async function loadSave(name, button) {
    if (button) button.disabled = true;
    setStatus(tr('Loading "{name}"…', { name }));
    const r = await game.load(name);
    if (button) button.disabled = false;
    if (!r.ok) setStatus(tr('"{name}" could not be loaded: {reason}', { name, reason: ui.text.reason(r.reason) }), true);
    else setStatus('');
  }

  const saveLine = (meta) => {
    if (!meta) return tr('Unknown game');
    const date = Array.isArray(meta.date) ? ui.text.date({ y: meta.date[0], m: meta.date[1], d: meta.date[2] }) : '';
    const nation = meta.nation ? ui.text.nation(meta.nation) : meta.tag || '';
    return [nation, date, meta.scenario === 'generated' ? tr('Generated map') : ''].filter(Boolean).join(' · ');
  };

  async function listSaves() {
    const r = await game.list();
    const items = r.ok ? r.items : [];
    const auto = items.find((s) => game.isAutosave(s.name));
    form.cont.hidden = !auto;
    form.cont.dataset.save = auto ? auto.name : '';
    if (auto) form.cont.textContent = tr('Continue: {what}', { what: saveLine(auto.meta) });
    form.saves.replaceChildren(...(items.length ? items.map((s) => {
      const row = el('button', 'cq-save-row');
      row.dataset.save = s.name;
      row.append(el('span', 'cq-save-name', game.isAutosave(s.name) ? tr('Autosave') : s.name), el('span', 'cq-save-meta', saveLine(s.meta)),
        el('span', 'cq-save-time', new Date(s.mtime).toLocaleString()));
      row.onclick = () => loadSave(s.name, row);
      return row;
    }) : [el('div', 'cq-start-hint', tr('No saved games yet.'))]));
  }

  ui.start = {
    async show() {
      if (!form) build();
      form.box.hidden = false;
      listSaves();
      if (!data || shell.view?.map !== data.map) await showScenario();
      else {
        shell.view.setOwners(data.owners, data.scenario.nations.map((n) => n.color));
        // Back from a game the camera is where the game left it (often deep in one front): show the world again.
        shell.view.camera.fit();
        shell.view.redraw();
        pickNation(choice.player);
      }
    },
    hide() { if (form) form.box.hidden = true; },
    get choice() { return { ...choice }; },
  };
  ui.events.on('game', () => ui.start.hide());
  ui.events.on('start', () => ui.start.show());
})();
