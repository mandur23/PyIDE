// Decisions: what an AI nation does by scenario event, the player is asked. Conquest.ui.decisions = { check() }.
// A scenario event with skipIfPlayer never fires for the nation the player plays (Germany's march through Belgium);
// the worker's `decisions` query lists those whose conditions hold now and that would declare war for the player.
// check() runs when a game opens and each game day: the first one not asked before pauses the game and opens a
// dialog with what it means and two answers, Declare War (an ordinary declare-war order for each nation) and Not Now
// (it stays possible from the Diplomacy panel). Each is asked once a game: the ids asked live in game.meta.decisions,
// so they are saved with the game.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const log = ide.logger('#conquest');
  const game = Conquest.game;

  const TEXT = {
    schlieffen: {
      title: () => tr('The Road through Belgium'),
      body: () => tr('The staff\'s plan against France goes around the French fortress line, through Belgium and Luxembourg. Both are neutral, and Britain has guaranteed Belgium: it will enter the war against us at once.'),
    },
  };

  let open = false;
  let busy = false;

  async function check() {
    if (!game.running || game.outcome || open || busy) return;
    busy = true;
    try {
      let list;
      try { list = await game.query('decisions', {}); } catch (err) { log.warn(`no decisions: ${err.message}`); return; }
      if (!game.meta) game.meta = {};
      const asked = Array.isArray(game.meta.decisions) ? game.meta.decisions : (game.meta.decisions = []);
      const d = list.find((x) => !asked.includes(x.id));
      if (!d) return;
      asked.push(d.id);
      if (game.speed > 0) game.setSpeed(0);
      show(d);
    } finally {
      busy = false;
    }
  }

  function show(d) {
    const names = d.wars.map((n) => game.nationName(n)).join(', ');
    const text = TEXT[d.id];
    const body = el('div', 'cq-decision');
    body.dataset.decision = d.id;
    body.dataset.nations = d.wars.join(',');
    if (text) body.append(el('div', 'cq-decision-text', text.body()));
    body.append(el('div', 'cq-decision-wars', tr('Declaring war now puts us at war with: {list}', { list: names })));
    body.append(el('div', 'cq-decision-later', tr('If you wait, you can still declare war from the Diplomacy panel.')));
    open = true;
    ide.ui.dialog({
      title: text ? text.title() : tr('Declare War'),
      body,
      width: 460,
      onClose: () => { open = false; },
      buttons: [{ label: tr('Declare War'), primary: true, run: () => { declare(d); } }, { label: tr('Not Now') }],
    });
  }

  async function declare(d) {
    for (const n of d.wars) {
      const r = await game.order({ type: 'diplo', action: 'declare-war', to: n });
      if (!r.ok) log.warn(`could not declare war on ${game.nationName(n)}: ${r.reason}`);
    }
  }

  game.on('day', () => { check(); });
  ui.events.on('game', () => { check(); });

  ui.decisions = { check, get open() { return open; } };
})();
