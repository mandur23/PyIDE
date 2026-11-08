// The Lumetri Scopes panel of Nano Studio Cut (docs/cut-architecture.md section 10): the luma waveform, the RGB
// parade, the YUV vectorscope (75% and 100% color bar targets, the skin tone line) and the RGB histogram of what the
// program monitor shows. The counts come from the monitor's compositor (Cut.compositor's scopes(): a compute pass on
// WebGPU, the CPU on the Canvas 2D back end, Cut.scopes); this panel draws them. It counts again after each frame the
// monitor draws, at most every 40 ms while stopped and every 150 ms (300 ms on the CPU) while playing, a quarter of
// the pixels then, so playback keeps its frames, and only while the panel is on screen. The scopes shown are kept in
// the setting `cut.scopes.show`.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const el = ui.el;
  const log = ide.logger('#cut');
  const S = Cut.scopes;
  const KINDS = [['wave', 'Waveform (Luma)'], ['parade', 'RGB Parade'], ['vector', 'Vectorscope YUV'], ['hist', 'Histogram']];
  const DEFAULT_SHOW = ['wave', 'vector'];
  const COLS = 256;
  const SIZE = 256;
  const BG = '#0b0c0e';
  const GRID = 'rgba(255,255,255,0.16)';
  const TEXT = 'rgba(255,255,255,0.55)';
  let state = { last: null, panel: null };

  // The display color of each vectorscope bin (its Cb, Cr at a middle luma), made once.
  let vecColors = null;
  function vectorColors() {
    if (vecColors) return vecColors;
    vecColors = new Float32Array(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const cb = ((x + 0.5) * 2 * S.RANGE) / SIZE - S.RANGE;
        const cr = S.RANGE - ((y + 0.5) * 2 * S.RANGE) / SIZE;
        const Y = 0.62;
        const rgb = [Y + 1.5748 * cr, Y - 0.1873 * cb - 0.4681 * cr, Y + 1.8556 * cb].map((v) => Math.max(0.25, Math.min(1, v)));
        vecColors.set(rgb, (y * SIZE + x) * 3);
      }
    }
    return vecColors;
  }
  // Brightness of a bin of n pixels when `full` pixels make a full bin.
  const glow = (n, full) => (n > 0 ? Math.min(1, 0.18 + Math.log1p(n) / Math.log1p(Math.max(2, full))) : 0);

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-scopes');
    const bar = el('div', 'cut-scopes-bar', undefined, { role: 'toolbar', 'aria-label': tr('Lumetri Scopes') });
    const grid = el('div', 'cut-scopes-grid');
    const empty = el('div', 'cut-scopes-empty', tr('The scopes show the program monitor’s picture.'));
    root.append(bar, grid, empty);
    host.appendChild(root);

    let show = (ide.settings.get('cut.scopes.show', DEFAULT_SHOW) || DEFAULT_SHOW).filter((k) => KINDS.some(([id]) => id === k));
    const buttons = new Map();
    const cells = new Map();
    for (const [id, name] of KINDS) {
      const b = el('button', 'cut-btn cut-scopes-toggle', tr(name), { type: 'button', 'aria-pressed': String(show.includes(id)), 'data-scope': id });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        show = show.includes(id) ? show.filter((k) => k !== id) : KINDS.map(([k]) => k).filter((k) => k === id || show.includes(k));
        ide.settings.set('cut.scopes.show', show);
        layout();
        want(true);
      });
      bar.appendChild(b);
      buttons.set(id, b);
      const cell = el('div', 'cut-scope', undefined, { 'data-scope': id });
      const canvas = el('canvas', 'cut-scope-canvas');
      cell.append(el('span', 'cut-scope-name', tr(name)), canvas);
      cells.set(id, { cell, canvas });
    }
    function layout() {
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(show.includes(id)));
      grid.replaceChildren(...show.map((id) => cells.get(id).cell));
      grid.dataset.count = String(show.length);
      draw();
    }

    // ---------- drawing ----------
    function canvasFor(id) {
      const { canvas } = cells.get(id);
      const dpr = globalThis.devicePixelRatio || 1;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (!W || !H) return null;
      const w = Math.round(W * dpr);
      const h = Math.round(H * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = BG;
      g.fillRect(0, 0, W, H);
      return { g, W, H };
    }
    const plane = (bins, color, full) => {
      const img = new ImageData(COLS, 256);
      for (let l = 0; l < 256; l++) {
        for (let c = 0; c < COLS; c++) {
          const a = glow(bins[l * COLS + c], full);
          if (!a) continue;
          const i = ((255 - l) * COLS + c) * 4;
          img.data[i] = color[0] * a;
          img.data[i + 1] = color[1] * a;
          img.data[i + 2] = color[2] * a;
          img.data[i + 3] = 255;
        }
      }
      return img;
    };
    const off = new OffscreenCanvas(COLS, 256);
    function levels(g, x, y, w, h, labels) {
      g.strokeStyle = GRID;
      g.fillStyle = TEXT;
      g.lineWidth = 1;
      g.font = '9px sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      for (let v = 0; v <= 100; v += 10) {
        const yy = Math.round(y + (1 - v / 100) * h) + 0.5;
        g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
        if (labels && v % 20 === 0) g.fillText(String(v), x - 3, yy);
      }
    }
    function drawWave(id, r, v) {
      const c = canvasFor(id);
      if (!c) return;
      const { g, W, H } = c;
      const x = 24;
      const y = 8;
      const w = W - x - 6;
      const h = H - y - 8;
      const full = Math.max(1, Math.ceil((r.rect.y1 - r.rect.y0) / r.step));
      g.imageSmoothingEnabled = true;
      if (id === 'wave') {
        off.getContext('2d').putImageData(plane(v.wave, [170, 255, 180], full), 0, 0);
        g.drawImage(off, x, y, w, h);
      } else {
        const colors = [[255, 80, 80], [80, 235, 110], [90, 150, 255]];
        const pw = (w - 8) / 3;
        for (let k = 0; k < 3; k++) {
          off.getContext('2d').putImageData(plane(v.parade[k], colors[k], full), 0, 0);
          g.drawImage(off, x + k * (pw + 4), y, pw, h);
        }
      }
      levels(g, x, y, w, h, true);
    }
    function drawVector(r, v) {
      const c = canvasFor('vector');
      if (!c) return;
      const { g, W, H } = c;
      const side = Math.max(16, Math.min(W, H) - 12);
      const x0 = (W - side) / 2;
      const y0 = (H - side) / 2;
      const img = new ImageData(SIZE, SIZE);
      const col = vectorColors();
      const full = Math.max(4, ((r.rect.x1 - r.rect.x0) * (r.rect.y1 - r.rect.y0)) / (r.step * r.step) / 64);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const a = glow(v.vector[i], full);
        if (!a) continue;
        const hot = Math.max(0, a - 0.75) * 2.4;
        for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.min(255, (col[i * 3 + k] * a + hot) * 255);
        img.data[i * 4 + 3] = 255;
      }
      off.getContext('2d').putImageData(img, 0, 0, 0, 0, SIZE, SIZE);
      g.imageSmoothingEnabled = true;
      g.drawImage(off, 0, 0, SIZE, SIZE, x0, y0, side, side);
      const k = side / SIZE;
      const cx = x0 + side / 2;
      const cy = y0 + side / 2;
      const rad = (0.5 / S.RANGE) * (side / 2);
      g.strokeStyle = GRID;
      g.lineWidth = 1;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy); g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad); g.stroke();
      // the skin tone line
      const a = (S.SKIN_DEGREES * Math.PI) / 180;
      g.strokeStyle = 'rgba(255,200,150,0.45)';
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * rad, cy - Math.sin(a) * rad); g.stroke();
      g.font = '9px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const box = Math.max(5, side * 0.035);
      for (const t of S.targets(SIZE)) {
        const [tx, ty] = [x0 + t.at75[0] * k, y0 + t.at75[1] * k];
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.strokeRect(tx - box / 2, ty - box / 2, box, box);
        const [ux, uy] = [x0 + t.at100[0] * k, y0 + t.at100[1] * k];
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(ux - 1.5, uy - 1.5, 3, 3);
        g.fillStyle = TEXT;
        const dx = tx - cx;
        const dy = ty - cy;
        const d = Math.hypot(dx, dy) || 1;
        g.fillText(t.name, tx + (dx / d) * (box + 6), ty + (dy / d) * (box + 6));
      }
    }
    function drawHist(r, v) {
      const c = canvasFor('hist');
      if (!c) return;
      const { g, W, H } = c;
      const x = 24;
      const y = 8;
      const w = W - x - 6;
      const h = H - y - 8;
      let ref = 1;
      for (let k = 0; k < 3; k++) for (let l = 1; l < 255; l++) ref = Math.max(ref, v.hist[k][l]);
      g.globalCompositeOperation = 'lighter';
      const colors = ['rgba(255,70,70,0.85)', 'rgba(70,235,100,0.85)', 'rgba(80,140,255,0.85)'];
      const rowH = h / 256;
      for (let k = 0; k < 3; k++) {
        g.fillStyle = colors[k];
        for (let l = 0; l < 256; l++) {
          const n = v.hist[k][l];
          if (!n) continue;
          g.fillRect(x, y + (255 - l) * rowH, Math.max(1, Math.min(1, n / ref) * w), Math.max(1, rowH));
        }
      }
      g.globalCompositeOperation = 'source-over';
      levels(g, x, y, w, h, true);
    }
    function draw() {
      const r = state.last;
      empty.hidden = !!r;
      if (!r) { for (const id of show) canvasFor(id); return; }
      const v = S.views(r.bins, r.layout);
      for (const id of show) {
        if (id === 'wave' || id === 'parade') drawWave(id, r, v);
        else if (id === 'vector') drawVector(r, v);
        else drawHist(r, v);
      }
    }

    // ---------- counting ----------
    const player = () => ui.monitors?.program?.player || null;
    const visible = () => root.isConnected && root.offsetParent !== null && root.clientWidth > 0 && show.length > 0;
    let bound = null;
    let unbind = null;
    let inflight = false;
    let again = false;
    let lastAt = -Infinity;
    let timer = 0;
    function bind() {
      const p = player();
      if (p === bound) return;
      unbind?.();
      bound = p;
      unbind = p ? p.on((ev) => { if (ev.type === 'frame' || ev.type === 'pause') want(); }) : null;
      want();
    }
    // A count soon: now when the last one was long enough ago, else at the end of the gap (the newest frame then).
    function want(now = false) {
      if (!visible()) return;
      const p = player();
      const comp = p?.compositor;
      if (!comp?.scopes) return;
      if (inflight) { again = true; return; }
      const gap = now ? 0 : p.playing ? (comp.backend === 'webgpu' ? 150 : 300) : 40;
      const wait = lastAt + gap - performance.now();
      if (wait > 0) {
        if (!timer) timer = setTimeout(() => { timer = 0; want(); }, wait);
        return;
      }
      run(comp, p.playing);
    }
    // Playing, a quarter of the pixels: the GPU count then costs the decoder and the monitor no time.
    async function run(comp, playing) {
      inflight = true;
      lastAt = performance.now();
      try {
        const r = await comp.scopes({ cols: COLS, size: SIZE, budget: playing ? S.BUDGET / 4 : S.BUDGET });
        if (r) {
          state.last = { ...r, at: performance.now(), t: app.t, renders: comp.stats?.().renders ?? 0 };
          state.count = (state.count || 0) + 1;
          draw();
        } else again = true;
      } catch (err) {
        log.warn(`scopes: ${err?.message || err}`);
      } finally {
        inflight = false;
        if (again) { again = false; want(); }
      }
    }

    const ro = ide.util.observeSize(root, () => { draw(); want(true); });
    const poll = setInterval(bind, 1000);
    offs.push(() => ro.disconnect(), () => clearInterval(poll), () => clearTimeout(timer), () => unbind?.());
    offs.push(app.on('workspace', () => { bind(); requestAnimationFrame(() => want(true)); }));
    layout();
    bind();
    state.panel = { refresh: () => want(true), get shown() { return show.slice(); } };
    return { dispose() { for (const f of offs.splice(0)) { try { f(); } catch {} } state.panel = null; root.remove(); } };
  }

  // For the tests: the last counts drawn ({ bins, layout, rect, step, width, height, backend, at, t, renders }), how
  // many counts were drawn, and a count now.
  ui.scopes = {
    get last() { return state.last; },
    get count() { return state.count || 0; },
    refresh: () => state.panel?.refresh(),
    get shown() { return state.panel?.shown || []; },
  };
  ui.registerPanel('scopes', { title: () => tr('Lumetri Scopes'), mount });
})();
