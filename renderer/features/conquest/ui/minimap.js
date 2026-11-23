// The minimap in the bottom-left corner of the map: the world in the nations' colours by who controls each province,
// the part the map shows as a rectangle, and a click or drag on it that centres the map there (keeping the zoom). It
// is drawn from the view's own province raster, sampled once per map at the minimap's size (view.idAt), and redrawn at
// most every REDRAW_MS when provinces change hands, never per frame; only the rectangle follows the camera, on the
// view's frame event. It folds to its title bar, remembered in conquest.minimap (true, open) like the legend.
// ui.corner() is the bottom-left column it shares with the selection panel (ui/selpanel.js, above it); the province
// card ends above it (ui/command.js fitCard).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;

  const WIDTH = 200;
  const REDRAW_MS = 500;
  const SEA = [42, 72, 101];
  const NONE = [184, 179, 165];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) || 0);

  ui.corner = () => {
    if (!shell.corner) {
      shell.corner = el('div', 'cq-corner');
      shell.stage.append(shell.corner);
      ide.util.observeSize(shell.corner, () => ui.command?.fitCard());
    }
    return shell.corner;
  };

  const isOpen = () => ide.settings.get('conquest.minimap', true) !== false;
  let mm = null;
  let ids = null;
  let size = null; // { w, h, tw, th }
  let timer = 0;
  const offs = [];

  function build() {
    const box = el('div', 'cq-minimap');
    const head = el('div', 'cq-minimap-head');
    const title = el('span', 'cq-minimap-title', tr('Minimap of the World'));
    const toggle = el('button', 'cq-icon-btn cq-minimap-toggle');
    toggle.append(ide.icon('chevronDown'));
    toggle.onclick = () => ide.settings.set('conquest.minimap', !isOpen());
    head.append(title, toggle);
    const body = el('div', 'cq-minimap-body');
    const canvas = document.createElement('canvas');
    canvas.className = 'cq-minimap-map';
    const rect = el('div', 'cq-minimap-view');
    body.append(canvas, rect);
    box.append(head, body);
    ui.corner().append(box);
    let dragging = null;
    const goTo = (e) => {
      const v = shell.view;
      if (!v || !size) return;
      const r = canvas.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * size.tw;
      const my = ((e.clientY - r.top) / r.height) * size.th;
      v.camera.centerOn(mx, my);
      v.redraw();
    };
    body.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dragging = e.pointerId; body.setPointerCapture?.(e.pointerId); goTo(e); });
    body.addEventListener('pointermove', (e) => { if (dragging === e.pointerId) goTo(e); });
    const stop = (e) => { if (dragging === e.pointerId) { dragging = null; body.releasePointerCapture?.(e.pointerId); } };
    body.addEventListener('pointerup', stop);
    body.addEventListener('pointercancel', stop);
    mm = { box, body, canvas, rect, toggle };
    showState();
  }

  function showState() {
    if (!mm) return;
    const on = isOpen();
    mm.box.hidden = !game.running;
    mm.box.classList.toggle('folded', !on);
    mm.body.hidden = !on;
    const label = on ? tr('Hide the Minimap') : tr('Show the Minimap');
    mm.toggle.title = label;
    mm.toggle.setAttribute('aria-label', label);
    mm.toggle.setAttribute('aria-pressed', String(on));
    if (on) { paint(); placeRect(); }
  }
  ide.on('settingsChanged', (key) => { if (key === 'conquest.minimap' || key === undefined) showState(); });

  function sample() {
    const v = shell.view;
    const tw = v.map.texture.width;
    const th = v.map.texture.height;
    const w = WIDTH;
    const h = Math.max(1, Math.round((WIDTH * th) / tw));
    ids = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ids[y * w + x] = v.idAt(((x + 0.5) * tw) / w, ((y + 0.5) * th) / h);
    size = { w, h, tw, th };
    mm.canvas.width = w;
    mm.canvas.height = h;
  }

  function paint() {
    timer = 0;
    if (!mm || !ids || !game.running || mm.body.hidden) return;
    const { w, h } = size;
    const P = game.map.provinces;
    const colors = game.scenario.nations.map((n) => hex(n.color));
    const img = new ImageData(w, h);
    const px = img.data;
    for (let i = 0; i < w * h; i++) {
      const id = ids[i];
      if (!id) continue;
      const c = P[id]?.sea ? SEA : colors[game.prov.ctrl[id]] || NONE;
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
    }
    mm.canvas.getContext('2d').putImageData(img, 0, 0);
    mm.painted = (mm.painted || 0) + 1;
  }
  const schedule = () => { if (!timer) timer = setTimeout(paint, REDRAW_MS); };

  function placeRect() {
    const v = shell.view;
    if (!mm || !size || !v || mm.body.hidden) return;
    const c = v.camera;
    const k = mm.canvas.clientWidth / size.tw;
    const x = Math.max(0, c.x) * k;
    const y = Math.max(0, c.y) * k;
    const r = mm.rect.style;
    r.left = `${x}px`;
    r.top = `${y}px`;
    r.width = `${Math.min(size.tw, c.x + c.w / c.scale) * k - x}px`;
    r.height = `${Math.min(size.th, c.y + c.h / c.scale) * k - y}px`;
  }

  ui.events.on('game', async () => {
    if (!mm) build();
    for (const off of offs.splice(0)) off();
    ids = null;
    size = null;
    const v = shell.view;
    offs.push(v.on('frame', placeRect), game.on('tick', (d) => { if (d.provinces.size) schedule(); }));
    showState();
    await v.ready;
    if (shell.view !== v || !game.running) return;
    sample();
    paint();
    placeRect();
  });
  ui.events.on('start', () => { for (const off of offs.splice(0)) off(); showState(); });

  ui.minimap = { get painted() { return mm?.painted || 0; }, get size() { return size; }, get element() { return mm?.box || null; } };
})();
