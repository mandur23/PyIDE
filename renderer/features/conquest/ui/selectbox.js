// Selecting divisions on the map with the mouse, and moving the map with the keys. A left drag on the map draws a
// selection box and selects the player's counters inside it (all the stacks a merged counter holds); with Shift it adds
// to the selection. A double click on one of the player's counters selects every stack of that counter's army on
// screen. The setting conquest.leftDrag ('select', the default, or 'pan') makes a left drag move the map instead; a
// right or middle drag always moves it (view/camera.js), and the drawing tools take the left drag first in both. The
// arrow keys move the map by PAN_PX. Escape drops a box being dragged before anything else. The selection keeps the
// rule of a click on a counter (ui/command.js): the army most of the divisions belong to becomes the selected army.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;

  const PAN_PX = 120;
  const view = () => shell.view;
  const leftPans = () => ide.settings.get('conquest.leftDrag', 'select') === 'pan';

  let boxEl = null;
  let box = null; // { x0, y0, x1, y1 } in CSS pixels of the map
  const rect = (b) => ({ left: Math.min(b.x0, b.x1), top: Math.min(b.y0, b.y1), right: Math.max(b.x0, b.x1), bottom: Math.max(b.y0, b.y1) });
  function show() {
    if (!boxEl) { boxEl = el('div', 'cq-select-box'); shell.stage.append(boxEl); }
    const r = rect(box);
    boxEl.hidden = false;
    boxEl.style.transform = `translate(${r.left}px, ${r.top}px)`;
    boxEl.style.width = `${r.right - r.left}px`;
    boxEl.style.height = `${r.bottom - r.top}px`;
  }
  function hide() { box = null; if (boxEl) boxEl.hidden = true; }

  // Each counter drawn at this zoom, with its screen point and the own groups (mapbind's) it holds.
  function ownCounters() {
    const v = view();
    const groups = shell.bind?.groups || [];
    const P = game.map.provinces;
    const out = [];
    for (const c of v.counters()) {
      const own = c.members.map((j) => groups[j]).filter((g) => g && g.side === 'own');
      if (!own.length) continue;
      const [x, y] = v.camera.toScreen(P[c.prov].x + 0.5, P[c.prov].y + 0.5);
      out.push({ x: x + c.dx, y: y + c.dy, divs: own.flatMap((g) => g.divs) });
    }
    return out;
  }
  const mostArmy = (divs) => {
    const counts = new Map();
    for (const id of divs) { const a = game.divs.get(id)?.army; if (a !== null && a !== undefined) counts.set(a, (counts.get(a) || 0) + 1); }
    let army = null;
    let most = 0;
    for (const [a, c] of counts) if (c > most) { most = c; army = a; }
    return army;
  };
  function choose(divs, add) {
    const list = add ? [...new Set([...game.selection.divisions, ...divs])] : divs;
    if (!list.length && add) return;
    game.setSelection({ divisions: list, army: list.length ? mostArmy(list) : game.selection.army });
  }

  const handler = {
    start(sx, sy) { box = { x0: sx, y0: sy, x1: sx, y1: sy }; show(); },
    move(sx, sy) { if (!box) return; box.x1 = sx; box.y1 = sy; show(); },
    end(sx, sy, shift) {
      if (!box) return;
      box.x1 = sx;
      box.y1 = sy;
      const r = rect(box);
      hide();
      const { W, H } = Conquest.view.COUNTER;
      const inside = ownCounters().filter((c) => c.x + W / 2 >= r.left && c.x - W / 2 <= r.right && c.y + H / 2 >= r.top && c.y - H / 2 <= r.bottom);
      choose(inside.flatMap((c) => c.divs), shift);
    },
    cancel() { hide(); },
  };

  function onDouble(e) {
    if (!game.running || ui.command?.drawing) return;
    const hit = shell.bind?.counterAt(e.sx, e.sy);
    if (!hit || hit.side !== 'own') return;
    const army = mostArmy(hit.all.flatMap((g) => g.divs));
    if (army === null) return;
    const v = view();
    const on = ownCounters().filter((c) => c.x >= 0 && c.y >= 0 && c.x <= v.camera.w && c.y <= v.camera.h);
    choose(on.flatMap((c) => c.divs).filter((id) => game.divs.get(id)?.army === army), e.shift);
  }

  const offs = [];
  ui.events.on('game', () => {
    for (const off of offs.splice(0)) off();
    hide();
    const v = view();
    v.setBox(() => (game.running && !leftPans() ? handler : null));
    offs.push(v.on('dblselect', onDouble));
  });
  ui.events.on('start', () => { for (const off of offs.splice(0)) off(); hide(); });

  const typing = () => { const a = document.activeElement; return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))); };
  const playing = () => game.running && !typing() && !document.querySelector('.dialog-backdrop, .modal-backdrop');
  for (const [dir, dx, dy, title] of [['Left', 1, 0, tr('Move the Map Left')], ['Right', -1, 0, tr('Move the Map Right')], ['Up', 0, 1, tr('Move the Map Up')], ['Down', 0, -1, tr('Move the Map Down')]]) {
    ide.registerAction({ id: `Conquest.Pan${dir}`, title, keys: [`Arrow${dir}`], when: () => playing() && !!view(), run: () => view().pan(dx * PAN_PX, dy * PAN_PX) });
  }
  ide.registerAction({ id: 'Conquest.CancelBox', title: tr('Cancel the Selection Box'), keys: ['Escape'], when: () => !!box, run: () => hide() });

  ui.selectBox = { get box() { return box && rect(box); }, leftPans };
})();
