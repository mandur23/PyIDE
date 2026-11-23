// The Conquest page of the Settings window (ide.settingsPages, craft: true, which is how the apps outside the IDE show
// their own pages; the gear in the top bar opens it): the running game's difficulty (set when a game starts), the AI
// production bonus for new games (conquest.aiBonus, off by default; plan 3.10), which alerts pause the game
// (conquest.pauseOn, the same setting the alerts' gear changes; the shell reads it again when it changes), the staff
// setting fronts for armies without a plan (conquest.staffFronts, on), what a left drag on the map does
// (conquest.leftDrag: 'select' a box of divisions, the default, or 'pan'), autosave (conquest.autosave, on) and the
// first-game guide (conquest.guideDone; Show the Guide Again resets it). Values go through the window's OK and Apply.
// Other screens add rows to this page with Conquest.ui.settingsRows.push({ id, title, mount(section, ctx) }): each
// gets its own section after these (the place kept for diplomacy's LLM replies, conquest.llmReplies).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;

  const DEFAULTS = { 'conquest.aiBonus': false, 'conquest.staffFronts': true, 'conquest.leftDrag': 'select', 'conquest.autosave': true, 'conquest.guideDone': false };
  ui.settingsRows = ui.settingsRows || [];

  function mount(host, ctx) {
    const { section, checkbox, fieldRow } = ctx.ui;
    host.classList.add('cq-settings-page');

    const g = section(host, tr('This Game'));
    const diff = el('span', 'cq-settings-difficulty', game.running ? ui.text.difficulty(game.meta?.difficulty || 'normal') : tr('No game is running'));
    g.appendChild(fieldRow(tr('Difficulty:'), diff, tr('chosen when the game started')));
    if (game.running) g.appendChild(el('div', 'muted settings-note cq-settings-bonus', game.meta?.aiBonus ? tr('The AI production bonus is on in this game.') : tr('The AI production bonus is off in this game.')));

    const ai = section(host, tr('AI'));
    ai.appendChild(checkbox('conquest.aiBonus', tr('AI production bonus in new games')));
    ai.appendChild(el('div', 'muted settings-note', tr('The AI nations draft a quarter more men; the top bar shows "AI bonus" while it is on. The AI never cheats otherwise.')));

    const alerts = section(host, tr('Pause on Alerts'));
    alerts.appendChild(el('div', 'muted settings-note', tr('Pause the game when this happens:')));
    const pauseValue = () => ({ war: true, offer: true, ...(ctx.value('conquest.pauseOn') || {}) });
    for (const kind of ui.text.ALERT_KINDS) {
      const row = el('label', 'settings-check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.pause = kind;
      box.checked = !!pauseValue()[kind];
      box.onchange = () => ctx.set('conquest.pauseOn', { ...pauseValue(), [kind]: box.checked });
      row.append(box, el('span', null, ui.text.alert(kind)));
      alerts.appendChild(row);
    }

    const play = section(host, tr('Playing'));
    play.appendChild(checkbox('conquest.staffFronts', tr('Let the staff set fronts for armies without a plan')));
    play.appendChild(el('div', 'muted settings-note', tr('While you are at war, the staff gives every army without a front its share of the border, or a place in reserve near the capital. A front you draw yourself is never changed, and offensives stay yours.')));
    const drag = document.createElement('select');
    drag.className = 'cq-select cq-left-drag';
    for (const [v, label] of [['select', tr('Select divisions in a box')], ['pan', tr('Move the map')]]) { const o = el('option', null, label); o.value = v; drag.append(o); }
    drag.value = ctx.value('conquest.leftDrag') === 'pan' ? 'pan' : 'select';
    drag.onchange = () => ctx.set('conquest.leftDrag', drag.value);
    play.appendChild(fieldRow(tr('Left drag on the map:'), drag, tr('a right or middle drag always moves the map')));
    play.appendChild(checkbox('conquest.autosave', tr('Autosave every game month and on quitting')));
    play.appendChild(el('div', 'muted settings-note', tr('Each game has its own autosave; the newest five are kept.')));

    const guide = section(host, tr('First-Game Guide'));
    const again = el('button', 'secondary cq-guide-reset', tr('Show the Guide Again'));
    again.type = 'button';
    const said = el('span', 'muted cq-guide-reset-note');
    again.onclick = () => { ide.settings.set('conquest.guideDone', false); said.textContent = tr('The guide opens with the next new game, or now from the Help button.'); };
    const r = el('div', 'settings-check');
    r.append(again, said);
    guide.appendChild(r);

    for (const extra of ui.settingsRows) {
      const s = section(host, typeof extra.title === 'function' ? extra.title() : extra.title || extra.id);
      s.dataset.row = extra.id || '';
      try { extra.mount(s, ctx); } catch (err) { ide.logger('#conquest').error(`settings row ${extra.id}: ${err?.stack || err}`); }
    }
  }

  (ide.settingsPages ||= []).push({
    id: 'conquest', title: () => tr('Conquest'), craft: true, defaults: DEFAULTS, mount, index: false,
    keywords: 'conquest game difficulty ai bonus pause alerts staff fronts autosave guide 게임 난이도 보너스 알림 멈춤 참모 전선 자동 저장 안내',
  });
})();
