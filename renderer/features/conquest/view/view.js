// The map view the screens use: the WebGL map (gl.js) with division counters in the same context (units.js) under a
// 2D overlay of nation names (labels.js), then border lines, fronts, arrows and battle markers (arrows.js), moved by
// camera.js and answering clicks from the CPU copy of the ids (pick.js); border geometry comes from borders.js.
// Conquest.view.create(host, { map, idSource }) -> { ready, setOwners(owners, colors, ctrl?), setMode(name),
//   setModeColor(name, fn | null), setSeaColor(fn | null), recolor(ids?), setSelected(id), setPainter(p | null),
//   setBox(fn | null), on('select' | 'dblselect' | 'hover' | 'context' | 'frame', fn) -> off, pan(dx, dy), idAt(mx, my), setUnits, setFronts, setArrows, setMarkers, setNames(names, capitals?, homes?),
//   setBorderLines([{ pairs: [[a, b]], color, width?, casing? }]), counters() (the clusters drawn at this zoom,
//   units.js), labels, labelAlpha, borderLines, edge(a, b), markers, markerAt(sx, sy), focus(id), zoom(factor), destroy }.
// Names are placed from the controllers (owners when no ctrl) whenever they change, at most once per LABEL_MS. A
// border line is drawn along the edges of its province pairs, resolved once per call (borders.js caches each pair).
// A click on a battle marker selects the marker's province before anything under it; its select event has marker: true.
// map is map.json's shape (docs/conquest-architecture.md section 3); idSource is the decoded ids.png (an
// HTMLImageElement, ImageBitmap or canvas). owners: per province id the owner's index into colors (#rrggbb), -1 none;
// ctrl, when given, the controller's: the political mode then colours by controller, tinted toward the owner where
// they differ, and the darker border lines follow control (the front). A mode's colour is fn(province, id, s) ->
// '#rrggbb' for a land province; setModeColor replaces the built-in one (null restores it). setSeaColor(fn) gives a
// sea zone fn(id) -> null | [hex, alpha 0..1] over the sea colour. select, hover and context events carry
// { id, province, sx, sy, shift } (CSS pixels in the map); a painter ({ down, move, up }, camera.js) takes left drags,
// else the box setBox's fn() answers ({ start, move, end, cancel }, camera.js), else they pan. idAt(mx, my) is the
// province at a texture point.
// Calls made before `ready` settles apply once it does.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});

  const NEUTRAL = '#b8b3a5';
  const TERRAIN = { plains: '#a7bb78', forest: '#5d8a4b', hills: '#b19a69', mountain: '#8a8178', marsh: '#77998a', desert: '#d6c38b', urban: '#9c8f8c' };
  // Each map mode is how it colours a land province.
  const MODES = {
    political: (p, id, s) => {
      if (!s.ctrl) return s.colors[s.owners[id]] || NEUTRAL;
      const c = s.ctrl[id];
      const o = s.owners[id];
      const cc = s.colors[c] || NEUTRAL;
      return o >= 0 && c !== o ? mixHex(cc, s.colors[o] || NEUTRAL, OCCUPIED_TINT) : cc;
    },
    terrain: (p) => TERRAIN[p.terrain] || NEUTRAL,
    supply: () => NEUTRAL,
    weather: () => NEUTRAL,
    diplomacy: () => NEUTRAL,
  };
  const PALETTE = { Sea: '#2a4865', Coast: '#16283a', Outside: '#121a24', ProvLine: '#1a1a1a', OwnerLine: '#202020', SelLine: '#ffd84a' };
  view.MODES = Object.keys(MODES);

  const hexBytes = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) || 0);
  const OCCUPIED_TINT = 0.35;
  const LABEL_MS = 500;
  const mixHex = (a, b, t) => {
    const x = hexBytes(a);
    const y = hexBytes(b);
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  };
  view.mixHex = mixHex;

  view.create = (host, { map, idSource }) => {
    const W = map.texture.width;
    const H = map.texture.height;
    const N = map.provinces.length - 1;
    const root = document.createElement('div');
    root.className = 'cq-map';
    const glCanvas = document.createElement('canvas');
    glCanvas.className = 'cq-map-gl';
    const overlay = document.createElement('canvas');
    overlay.className = 'cq-map-overlay';
    root.append(glCanvas, overlay);
    host.appendChild(root);
    const g2 = overlay.getContext('2d');

    const s = { mode: 'political', owners: new Int16Array(N + 1).fill(-1), ctrl: null, colors: [], selected: 0, hovered: 0, painter: null, box: null, seaColor: null };
    const modes = { ...MODES };
    const fill = new Uint8Array((N + 1) * 4);
    const meta = new Uint8Array((N + 1) * 4);
    const cam = view.camera(W, H);
    const units = view.unitLayer(map);
    const lines = view.lineLayer();
    const fontOf = () => getComputedStyle(root).fontFamily || 'system-ui, sans-serif';
    const labels = view.labelLayer(map, fontOf);
    let borders = null;
    let borderReq = [];
    let borderLines = [];
    let labelTimer = 0;
    const listeners = { select: new Set(), dblselect: new Set(), hover: new Set(), context: new Set(), frame: new Set() };
    const emit = (name, arg) => { for (const fn of listeners[name]) try { fn(arg); } catch (err) { console.error(err); } };
    let renderer = null;
    let picker = null;
    let scheduled = 0;
    let destroyed = false;
    const cleanups = [];

    const colour = (id) => {
      const p = map.provinces[id];
      if (p && !p.sea) fill.set([...hexBytes(modes[s.mode](p, id, s)), 255], id * 4);
      else {
        const t = p && s.seaColor ? s.seaColor(id) : null;
        fill.set(t ? [...hexBytes(t[0]), Math.round(Math.max(0, Math.min(1, t[1])) * 255)] : [0, 0, 0, 0], id * 4);
      }
      const o = ((s.ctrl || s.owners)[id] ?? -1) + 1;
      meta.set([o & 255, o >> 8, p?.sea ? 255 : 0, 255], id * 4);
    };
    const recolor = (ids) => {
      for (const id of ids || map.provinces.keys()) if (id > 0) colour(id);
      renderer?.update('fill', ids);
      renderer?.update('meta', ids);
      invalidate();
    };

    function frame() {
      scheduled = 0;
      if (destroyed || !renderer) return;
      const t0 = performance.now();
      const dpr = devicePixelRatio || 1;
      const dw = Math.max(1, Math.round(cam.w * dpr));
      const dh = Math.max(1, Math.round(cam.h * dpr));
      const pxPerTex = cam.scale * dpr;
      const drawn = renderer.draw({ x: cam.x, y: cam.y, texPerPx: 1 / pxPerTex, width: dw, height: dh, dpr, selected: s.selected, hovered: s.hovered,
        provAlpha: Math.max(0, Math.min(1, (pxPerTex - 0.3) / 0.7)) * 0.5, palette: PALETTE });
      if (overlay.width !== dw || overlay.height !== dh) { overlay.width = dw; overlay.height = dh; } else g2.clearRect(0, 0, dw, dh);
      labels.draw(g2, cam, dpr);
      lines.draw(g2, cam, map, dpr);
      const counters = units.visible(cam);
      const ms = performance.now() - t0;
      if (drawn) emit('frame', { ms, counters });
    }
    function invalidate() { if (!scheduled && !destroyed) scheduled = requestAnimationFrame(frame); }

    const pickAt = (sx, sy) => (picker && sx != null ? picker.at(...cam.toMap(sx, sy)) : 0);
    const placeNames = () => { labelTimer = 0; labels.update(s.ctrl || s.owners); invalidate(); };
    function resolveBorders() {
      if (!borders) return;
      borderLines = borderReq.map((l) => {
        const paths = [];
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [a, b] of l.pairs || []) {
          for (const path of borders.edge(a, b)) {
            paths.push(path);
            for (let i = 0; i < path.length; i += 2) {
              box[0] = Math.min(box[0], path[i]); box[1] = Math.min(box[1], path[i + 1]);
              box[2] = Math.max(box[2], path[i]); box[3] = Math.max(box[3], path[i + 1]);
            }
          }
        }
        return { ...l, paths, box };
      });
      lines.setBorders(borderLines);
    }
    const province = (id) => (id > 0 ? map.provinces[id] || null : null);
    const api = {
      map, camera: cam,
      get mode() { return s.mode; },
      get selected() { return s.selected; },
      get hovered() { return s.hovered; },
      get info() { return renderer?.info || null; },
      get lost() { return !!renderer?.lost; },
      provinceAt: pickAt,
      idAt: (mx, my) => (picker ? picker.at(mx, my) : 0),
      setOwners(owners, colors, ctrl) {
        const nextColors = Array.isArray(colors) ? colors.map(String) : s.colors;
        const changed = [];
        if (ctrl && !s.ctrl) s.ctrl = new Int16Array(N + 1).fill(-1);
        const dropped = !ctrl && !!s.ctrl;
        if (dropped) s.ctrl = null;
        for (let id = 1; id <= N; id++) {
          const o = owners?.[id] ?? -1;
          const c = ctrl ? ctrl[id] ?? -1 : -1;
          let moved = false;
          if (o !== s.owners[id]) { s.owners[id] = o; moved = true; }
          if (ctrl && c !== s.ctrl[id]) { s.ctrl[id] = c; moved = true; }
          if (moved) changed.push(id);
        }
        if (nextColors.join() !== s.colors.join() || dropped) { s.colors = nextColors; recolor(null); } else if (changed.length) recolor(changed);
        if (changed.length && !labelTimer) labelTimer = setTimeout(placeNames, LABEL_MS);
      },
      setNames(names, capitals, homes) { labels.setNames(names, capitals, homes); placeNames(); },
      get labels() { return labels.labels; },
      get labelAlpha() { return labels.alpha(cam); },
      setBorderLines(list) { borderReq = Array.isArray(list) ? list.filter((l) => l && Array.isArray(l.pairs)) : []; resolveBorders(); invalidate(); },
      get borderLines() { return borderLines; },
      edge: (a, b) => (borders ? borders.edge(a, b) : []),
      counters: () => units.clusters(cam.scale),
      get markers() { return lines.markers; },
      markerAt: (sx, sy) => lines.markerAt(sx, sy, cam, map),
      markerPoint: (m) => lines.markerPoint(m, cam, map),
      setMode(name) {
        if (!modes[name] || name === s.mode) return;
        s.mode = name;
        recolor(null);
      },
      setModeColor(name, fn) {
        if (!MODES[name]) return;
        modes[name] = fn || MODES[name];
        if (name === s.mode) recolor(null);
      },
      setSeaColor(fn) { s.seaColor = fn || null; recolor(null); },
      recolor: (ids) => recolor(ids || null),
      setPainter(p) { s.painter = p || null; },
      setBox(fn) { s.box = fn || null; },
      setSelected(id) {
        const next = id > 0 && id <= N ? id : 0;
        if (next === s.selected) return;
        s.selected = next;
        invalidate();
      },
      on(name, fn) { listeners[name]?.add(fn); return () => listeners[name]?.delete(fn); },
      setUnits(list) { units.set(list); invalidate(); },
      setFronts(list) { lines.setFronts(list); invalidate(); },
      setArrows(list) { lines.setArrows(list); invalidate(); },
      setMarkers(list) { lines.setMarkers(list); invalidate(); },
      focus(id) {
        const p = province(id);
        if (!p) return;
        cam.centerOn(p.x, p.y, Math.max(cam.scale, 2));
        invalidate();
      },
      zoom(factor) { cam.zoomAt(cam.w / 2, cam.h / 2, factor); invalidate(); },
      pan(dx, dy) { cam.pan(dx, dy); invalidate(); },
      redraw: invalidate,
      // Draws a frame now and reads its pixels at CSS points [[x, y], ...] -> [[r, g, b], ...] (tests).
      sample(points) {
        if (!renderer || renderer.lost) return null;
        if (scheduled) cancelAnimationFrame(scheduled);
        frame();
        const gl = renderer.gl;
        const dpr = devicePixelRatio || 1;
        const px = new Uint8Array(4);
        return points.map(([x, y]) => {
          gl.readPixels(Math.floor(x * dpr), glCanvas.height - 1 - Math.floor(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return [px[0], px[1], px[2]];
        });
      },
      destroy() {
        destroyed = true;
        if (scheduled) cancelAnimationFrame(scheduled);
        for (const fn of cleanups) fn();
        if (labelTimer) clearTimeout(labelTimer);
        renderer?.dispose();
        root.remove();
      },
    };

    api.ready = (async () => {
      const ids = await view.decodeIds(idSource, W, H, N);
      if (destroyed) return api;
      picker = view.picker(ids, W, H);
      borders = view.borderCache(ids, W, H, N);
      resolveBorders();
      for (let id = 1; id <= N; id++) colour(id);
      renderer = view.renderer(glCanvas, { width: W, height: H, ids, count: N, fill, meta }, { layers: [units], onRestored: invalidate });
      const size = () => {
        const r = root.getBoundingClientRect();
        const first = cam.w <= 1;
        cam.resize(r.width, r.height);
        if (first) cam.fit();
        invalidate();
      };
      size();
      const watch = (globalThis.ide?.util?.observeSize || ((el, fn) => { const ro = new ResizeObserver(fn); ro.observe(el); return ro; }))(root, size);
      cleanups.push(() => watch.disconnect());
      cleanups.push(view.attachCamera(cam, overlay.parentElement, {
        change: invalidate,
        click: (sx, sy, e) => {
          const m = lines.markerAt(sx, sy, cam, map);
          api.setSelected(m ? m.prov : pickAt(sx, sy));
          emit('select', { id: s.selected, province: province(s.selected), sx, sy, marker: !!m, shift: !!e?.shiftKey });
        },
        dblclick: (sx, sy, e) => {
          const id = pickAt(sx, sy);
          emit('dblselect', { id, province: province(id), sx, sy, shift: !!e?.shiftKey });
        },
        hover: (sx, sy) => {
          const id = pickAt(sx, sy);
          if (id !== s.hovered) { s.hovered = id; invalidate(); }
          emit('hover', { id, province: province(id), sx, sy });
        },
        context: (sx, sy) => {
          const id = pickAt(sx, sy);
          emit('context', { id, province: province(id), sx, sy });
        },
        painter: () => s.painter,
        box: () => (s.box ? s.box() : null),
      }));
      return api;
    })();
    return api;
  };
})();
