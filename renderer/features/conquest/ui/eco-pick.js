// Picking a province on the map for an order (construction, where trained divisions form): Conquest.ui.pick.start({
// title, legal(id) -> true | reason key, describe(id) -> text, onPick(id) }) -> Promise<id | null>. While it runs the
// map shows political colours with every province that is not legal greyed out, a banner at the top of the map says
// what to pick (with Cancel; Esc too), the tooltip carries describe(id) for the province under the pointer, and a left
// click on a legal province ends it with onPick(id); a click elsewhere shows the reason beside the pointer. A plan
// being drawn (ui/command.js) is cancelled first. pick.active is the running pick or null.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;
  const GREY = '#4a4844';
  const NEUTRAL = '#b8b3a5';

  let active = null;
  let banner = null;

  function buildBanner() {
    banner = el('div', 'cq-pick');
    banner.hidden = true;
    const text = el('span', 'cq-pick-text');
    const cancel = el('button', 'cq-btn cq-pick-cancel', tr('Cancel'));
    cancel.onclick = () => end(null);
    banner.append(text, cancel);
    shell.stage.append(banner);
    banner.textEl = text;
  }

  function end(id) {
    const a = active;
    if (!a) return;
    active = null;
    const view = shell.view;
    banner.hidden = true;
    shell.root.classList.remove('cq-picking');
    if (view) {
      view.setPainter(null);
      view.setModeColor('political', null);
      if (a.mode !== view.mode) shell.setMode(a.mode);
      view.recolor(null);
    }
    a.offHover?.();
    shell.bind?.setTooltipExtra('');
    a.resolve(id);
  }

  function start({ title, legal, describe, onPick }) {
    if (active) end(null);
    const view = shell.view;
    if (!view || !game.running) return Promise.resolve(null);
    if (ui.command?.drawing) ui.command.cancelDraw();
    if (!banner) buildBanner();
    return new Promise((resolve) => {
      const ok = new Uint8Array(game.map.provinces.length);
      for (let p = 1; p < ok.length; p++) if (!game.map.provinces[p].sea && legal(p) === true) ok[p] = 1;
      active = { resolve, legal, describe, onPick, ok, mode: view.mode };
      const colors = game.scenario.nations.map((n) => n.color);
      view.setModeColor('political', (p, id) => {
        const c = colors[game.prov.ctrl[id]] || NEUTRAL;
        return ok[id] ? c : Conquest.view.mixHex(c, GREY, 0.75);
      });
      if (view.mode !== 'political') shell.setMode('political');
      view.recolor(null);
      banner.textEl.textContent = title;
      banner.hidden = false;
      shell.root.classList.add('cq-picking');
      active.offHover = view.on('hover', (e) => {
        if (!active || !(e.id > 0) || game.map.provinces[e.id].sea) return shell.bind?.setTooltipExtra('');
        const why = legal(e.id);
        shell.bind?.setTooltipExtra(why === true ? describe(e.id) : ui.text.reason(why));
      });
      view.setPainter({
        down(sx, sy) {
          const id = view.provinceAt(sx, sy);
          const why = id > 0 ? legal(id) : 'no-such-province';
          if (why !== true) { shell.toast(ui.text.reason(why), { sx, sy }); return true; }
          const a = active;
          end(id);
          a.onPick?.(id);
          return true;
        },
        move() {},
        up() {},
      });
    });
  }

  ui.pick = { start, cancel: () => end(null), get active() { return active ? { title: banner.textEl.textContent, legal: [...active.ok.keys()].filter((p) => active.ok[p]) } : null; } };
  ui.events.on('start', () => end(null));
  ide.registerAction({ id: 'Conquest.CancelPick', title: tr('Cancel Picking a Province'), keys: ['Escape'], when: () => !!active, run: () => end(null) });
})();
