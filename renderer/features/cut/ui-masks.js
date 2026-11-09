// Masks on the program monitor of Nano Studio Cut (Premiere's mask editing; masks.js has the shape and the math). The
// mask selected in Effect Controls is drawn over the clip with its vertices, the handles of its smooth vertices, the
// expansion handle (a square) and the feather handle (a circle) above its top with their guide lines (the outline
// grown by the expansion, and dashed by half the feather more). On the frame:
// - drag inside the mask: the whole mask moves;
// - drag a vertex: it moves; Alt+click a vertex: corner <-> smooth; Ctrl+click a vertex: it goes (three stay);
// - drag a handle: the vertex's curve (the opposite handle turns along; Alt breaks them apart);
// - click on the outline (Ctrl+click as Premiere's help says, or a plain click): a vertex there, dragged on at once;
// - drag the feather or expansion handle: Mask Feather / Mask Expansion;
// - a click outside the mask lets it go (the motion handles come back).
// Each drag or click is one undo step; with Mask Path keyframed, an edit writes the keyframe at the playhead, and a
// vertex added or deleted is added or deleted on every keyframe (so the counts stay equal and the path interpolates).
// The Free Draw Bezier pen (Effect Controls) draws a new mask: click points (drag to pull out smooth handles), click the
// first point to close it (one undo step: Add Mask); Escape gives up.
//
//   Cut.ui.masks: { selected, pen, select(app, sel | null), startPen(app, {clipId, effectId}), stopPen(app),
//                   editing(app), create(app, clip, effectId, 'ellipse' | 'polygon'), remove(app, sel), maskOf(clip, sel),
//                   prefix(sel), screen(sel) (tests: the client points of the selected mask's parts) }
//   Cut.ui.maskOverlay.attach({ layer, app, player, frameRect, placement, toSeq }) -> { layout(clip), detach() }  (ui-overlay.js)
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const M = Cut.masks;
  const C = Cut.commands;
  const edit = ui.edit;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  // ---------- which mask ----------
  let selected = null; // { clipId, effectId, maskId }
  let pen = null; // { clipId, effectId }
  const holderOf = (clip, effectId) => (effectId ? clip?.effects.find((e) => e.id === effectId) : clip) || null;
  const maskOf = (clip, sel) => (sel && clip ? (holderOf(clip, sel.effectId)?.masks || []).find((m) => m.id === sel.maskId) || null : null);
  const prefix = (sel) => `${M.prefixOf(sel.effectId)}.${sel.maskId}`;
  const emit = (app) => app.emit('mask', { selected, pen });
  // The picture's size in sequence pixels (the overlay's placement, else the sequence's).
  const pictureSize = (app, clip) => {
    const p = ui.overlay?.active?.placement?.(clip);
    return p ? [p.w, p.h] : [app.sequence.w, app.sequence.h];
  };
  const state = {
    get selected() { return selected; },
    get pen() { return pen; },
    select(app, sel) { selected = sel ? { clipId: sel.clipId, effectId: sel.effectId || null, maskId: sel.maskId } : null; pen = null; emit(app); },
    startPen(app, target) { pen = { clipId: target.clipId, effectId: target.effectId || null }; selected = null; emit(app); },
    stopPen(app) { if (pen) { pen = null; emit(app); } },
    // A mask (or the pen) of the clip the monitor shows: the motion handles step aside.
    editing(app) {
      const c = edit.primaryClip(app);
      if (!c) return false;
      if (pen) return pen.clipId === c.id;
      return !!selected && selected.clipId === c.id && !!maskOf(c, selected);
    },
    create(app, clip, effectId, shape) {
      const [w, h] = pictureSize(app, clip);
      const path = shape === 'polygon' ? M.polygon(w, h) : M.ellipse(w, h);
      const r = ui.exec(app, C.addMask(app.sequence.id, clip.id, { path }, { effectId }));
      if (r?.id) state.select(app, { clipId: clip.id, effectId, maskId: r.id });
      return r?.id || null;
    },
    remove(app, sel) {
      ui.exec(app, C.removeMask(app.sequence.id, sel.clipId, sel.maskId, { effectId: sel.effectId }));
      if (selected && selected.maskId === sel.maskId && selected.clipId === sel.clipId) state.select(app, null);
    },
    maskOf,
    prefix,
    screen: () => null,
    clientPoint: () => null,
  };
  ui.masks = state;

  // ---------- the layer on the program monitor ----------
  function attach({ layer, app, frameRect, placement, toSeq }) {
    const svg = svgEl('svg', { class: 'cut-mask-svg hidden' });
    const hit = svgEl('rect', { class: 'cut-mask-hit', x: 0, y: 0, width: 0, height: 0 });
    const guideE = svgEl('polygon', { class: 'cut-mask-guide' });
    const guideF = svgEl('polygon', { class: 'cut-mask-guide feather' });
    const line = svgEl('path', { class: 'cut-mask-line' });
    const stem = svgEl('line', { class: 'cut-mask-stem' });
    const handles = svgEl('g', { class: 'cut-mask-handles' });
    const verts = svgEl('g', { class: 'cut-mask-verts' });
    const expand = svgEl('rect', { class: 'cut-mask-expand', width: 8, height: 8 });
    const feather = svgEl('circle', { class: 'cut-mask-feather', r: 4.5 });
    const draft = svgEl('path', { class: 'cut-mask-draft' });
    const draftPts = svgEl('g', { class: 'cut-mask-verts' });
    svg.append(hit, guideE, guideF, line, stem, handles, verts, expand, feather, draft, draftPts);
    layer.appendChild(svg);
    let geo = null; // what is drawn: the mask's geometry on screen
    let points = []; // the pen's points so far [{x, y, hx, hy}] (picture fractions)

    // Picture fractions <-> layer pixels through the clip's motion (ui-overlay's placement and toSeq).
    function mapping(clip) {
      const fr = frameRect();
      if (!fr) return null;
      const p = placement(clip);
      const to = (u, v) => { const s = toSeq(p, [u * p.w - p.w / 2, v * p.h - p.h / 2]); return [fr.x + s[0] * fr.k, fr.y + s[1] * fr.k]; };
      const from = (x, y) => {
        const a = (p.rotation * Math.PI) / 180;
        const dx = (x - fr.x) / fr.k - p.W / 2 - p.position[0];
        const dy = (y - fr.y) / fr.k - p.H / 2 - p.position[1];
        const sx = p.scale[0] / 100 || 1e-6;
        const sy = p.scale[1] / 100 || 1e-6;
        const rx = dx * Math.cos(a) + dy * Math.sin(a);
        const ry = -dx * Math.sin(a) + dy * Math.cos(a);
        return [(rx / sx + p.anchor[0] + p.w / 2) / p.w, (ry / sy + p.anchor[1] + p.h / 2) / p.h];
      };
      // The path with its vertices and handles on screen (an affine map, so the curve is the same curve).
      const screenPath = (path) => {
        const out = [];
        for (let i = 0; i < M.count(path); i++) {
          const k = i * 6;
          const v = to(path[k], path[k + 1]);
          const hi = to(path[k] + path[k + 2], path[k + 1] + path[k + 3]);
          const ho = to(path[k] + path[k + 4], path[k + 1] + path[k + 5]);
          out.push(v[0], v[1], hi[0] - v[0], hi[1] - v[1], ho[0] - v[0], ho[1] - v[1]);
        }
        return out;
      };
      // Screen pixels per picture pixel along the picture's up direction, and that direction on screen.
      const a = (p.rotation * Math.PI) / 180;
      const up = [Math.sin(a), -Math.cos(a)];
      const kUp = fr.k * Math.abs(p.scale[1] / 100 || 1e-6);
      return { fr, p, to, from, screenPath, up, kUp };
    }
    const dOf = (sp) => {
      const n = M.count(sp);
      let d = '';
      for (let i = 0; i < n; i++) {
        const e = M.edge(sp, i, 1, 1);
        if (i === 0) d += `M${e.p0[0].toFixed(1)} ${e.p0[1].toFixed(1)}`;
        d += e.straight ? `L${e.p3[0].toFixed(1)} ${e.p3[1].toFixed(1)}` : `C${e.p1.map((v) => v.toFixed(1)).join(' ')} ${e.p2.map((v) => v.toFixed(1)).join(' ')} ${e.p3.map((v) => v.toFixed(1)).join(' ')}`;
      }
      return `${d}Z`;
    };

    function layoutLayer(clip) {
      svg.setAttribute('width', String(layer.clientWidth));
      svg.setAttribute('height', String(layer.clientHeight));
      hit.setAttribute('width', String(layer.clientWidth));
      hit.setAttribute('height', String(layer.clientHeight));
      const penOn = !!pen && !!clip && pen.clipId === clip.id;
      const m = clip && !penOn ? maskOf(clip, selected) : null;
      svg.classList.toggle('hidden', !penOn && !m);
      svg.classList.toggle('pen', penOn);
      geo = null;
      for (const n of [guideE, guideF, line, stem, expand, feather]) n.classList.toggle('hidden', !m);
      handles.replaceChildren();
      verts.replaceChildren();
      draftPts.replaceChildren();
      draft.setAttribute('d', '');
      if (!penOn && !m) return;
      const map = mapping(clip);
      if (!map) return;
      if (penOn) { drawDraft(map); geo = { clip, map, pen: true }; return; }
      const sel = selected;
      const v = (f) => edit.valueAt(app, clip, `${prefix(sel)}.${f}`);
      const path = M.validPath(v('path')) ? v('path') : m.path;
      const fe = Number(v('feather')) || 0;
      const ex = Number(v('expansion')) || 0;
      const sp = map.screenPath(path);
      line.setAttribute('d', dOf(sp));
      // guide lines: the outline grown by the expansion, and by half the feather more (pixels of the picture)
      const W = map.p.w;
      const H = map.p.h;
      const pts = (d) => M.outline(path, W, H, d).map(([x, y]) => map.to(x / W, y / H).map((q) => q.toFixed(1)).join(',')).join(' ');
      guideE.setAttribute('points', ex ? pts(ex) : '');
      guideF.setAttribute('points', fe > 0 ? pts(ex + fe / 2) : '');
      for (let i = 0; i < M.count(sp); i++) {
        const k = i * 6;
        const [x, y] = [sp[k], sp[k + 1]];
        if (!M.isCorner(path, i)) {
          for (const [hx, hy, which] of [[sp[k + 2], sp[k + 3], 'in'], [sp[k + 4], sp[k + 5], 'out']]) {
            handles.append(svgEl('line', { class: 'cut-mask-hline', x1: x, y1: y, x2: x + hx, y2: y + hy }));
            handles.append(svgEl('circle', { class: 'cut-mask-hdl', cx: x + hx, cy: y + hy, r: 3.5, 'data-i': i, 'data-which': which }));
          }
        }
        verts.append(svgEl('rect', { class: `cut-mask-vtx${M.isCorner(path, i) ? '' : ' smooth'}`, x: x - 3.5, y: y - 3.5, width: 7, height: 7, 'data-i': i }));
      }
      // the expansion and feather handles above the top of the mask, on the picture's up direction; drawn at least
      // 14 px apart so a small feather still has a handle to take
      const top = M.topPoint(path, W, H);
      const base = map.to(top[0] / W, top[1] / H);
      const eAt = Math.max(0, ex) * map.kUp;
      const fAt = eAt + Math.max(14, (fe / 2) * map.kUp);
      const at = (d) => [base[0] + map.up[0] * d, base[1] + map.up[1] * d];
      const pe = at(eAt + 12);
      const pf = at(fAt + 12);
      expand.setAttribute('x', String(pe[0] - 4));
      expand.setAttribute('y', String(pe[1] - 4));
      feather.setAttribute('cx', String(pf[0]));
      feather.setAttribute('cy', String(pf[1]));
      stem.setAttribute('x1', String(base[0])); stem.setAttribute('y1', String(base[1]));
      stem.setAttribute('x2', String(pf[0])); stem.setAttribute('y2', String(pf[1]));
      geo = { clip, sel, map, path, sp, feather: fe, expansion: ex, expandAt: pe, featherAt: pf };
    }
    function drawDraft(map) {
      if (!points.length) return;
      const sp = map.screenPath(M.fromPoints(points));
      const n = M.count(sp);
      let d = '';
      for (let i = 0; i < n; i++) {
        const e = M.edge(sp, i, 1, 1);
        if (i === 0) d += `M${e.p0[0]} ${e.p0[1]}`;
        if (i === n - 1) break;
        d += e.straight ? `L${e.p3[0]} ${e.p3[1]}` : `C${e.p1.join(' ')} ${e.p2.join(' ')} ${e.p3.join(' ')}`;
      }
      draft.setAttribute('d', d);
      for (let i = 0; i < n; i++) draftPts.append(svgEl('rect', { class: `cut-mask-vtx${i === 0 ? ' first' : ''}`, x: sp[i * 6] - 3.5, y: sp[i * 6 + 1] - 3.5, width: 7, height: 7 }));
    }

    // ---------- pointer ----------
    const localPt = (e) => { const r = layer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const round = (v) => Math.round(v * 10) / 10;
    function hitTest(pt) {
      const g = geo;
      if (!g || g.pen) return null;
      const near = (q, r) => Math.hypot(q[0] - pt[0], q[1] - pt[1]) <= r;
      if (near(g.featherAt, 7)) return { kind: 'feather' };
      if (near(g.expandAt, 7)) return { kind: 'expansion' };
      for (let i = 0; i < M.count(g.sp); i++) {
        if (M.isCorner(g.path, i)) continue;
        const k = i * 6;
        if (near([g.sp[k] + g.sp[k + 2], g.sp[k + 1] + g.sp[k + 3]], 5)) return { kind: 'handle', index: i, which: 'in' };
        if (near([g.sp[k] + g.sp[k + 4], g.sp[k + 1] + g.sp[k + 5]], 5)) return { kind: 'handle', index: i, which: 'out' };
      }
      const v = M.nearestVertex(g.sp, 1, 1, pt[0], pt[1]);
      if (v.distance <= 6) return { kind: 'vertex', index: v.index };
      const e = M.nearestEdge(g.sp, 1, 1, pt[0], pt[1]);
      if (e.distance <= 5) return { kind: 'edge', index: e.index, t: e.t };
      if (M.contains(g.sp, 1, 1, pt[0], pt[1])) return { kind: 'inside' };
      return { kind: 'outside' };
    }
    // Writes the path: at the playhead (keyframed) or the mask's own; `all` maps every keyframe instead.
    function writePath(g, path, all = null) {
      const clip = edit.clipById(app.sequence, g.clip.id);
      if (!clip) return;
      const kp = `${prefix(g.sel)}.path`;
      const keys = clip.keyframes?.[kp];
      if (all && keys?.length) ui.exec(app, C.setKeyframes(app.sequence.id, clip.id, kp, M.mapKeyframes(keys, all)));
      else if (all) ui.exec(app, C.setMask(app.sequence.id, clip.id, g.sel.maskId, { path: all(maskOf(clip, g.sel).path) }, { effectId: g.sel.effectId }));
      else edit.write(app, clip, kp, path);
    }
    function down(e) {
      if (e.button !== 0 || !geo) return;
      e.preventDefault();
      e.stopPropagation();
      app.setFocus('program');
      const pt = localPt(e);
      if (geo.pen) { penDown(e, pt); return; }
      const g = geo;
      const h = hitTest(pt);
      if (!h || h.kind === 'outside') { state.select(app, null); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      const gesture = edit.gesture(app, h.kind === 'feather' ? 'Mask Feather' : h.kind === 'expansion' ? 'Mask Expansion' : 'Mask Path');
      // clicks that edit at once: delete, corner <-> smooth, a new vertex (dragged on)
      if (h.kind === 'vertex' && ctrl) {
        if (M.count(g.path) > M.MIN_POINTS) { gesture.begin(); writePath(g, null, (p) => M.removeVertex(p, h.index)); gesture.end(); }
        return;
      }
      if (h.kind === 'vertex' && e.altKey) { gesture.begin(); writePath(g, M.toggleSmooth(g.path, h.index, g.map.p.w, g.map.p.h)); gesture.end(); return; }
      let path0 = g.path;
      let target = h;
      if (h.kind === 'edge') {
        gesture.begin();
        writePath(g, null, (p) => M.insertVertex(p, h.index, h.t));
        path0 = M.insertVertex(g.path, h.index, h.t);
        target = { kind: 'vertex', index: h.index + 1 };
      }
      const start = pt;
      const u0 = g.map.from(pt[0], pt[1]);
      let moved = false;
      const move = (ev) => {
        const q = localPt(ev);
        if (!moved && Math.hypot(q[0] - start[0], q[1] - start[1]) < 2) return;
        if (!moved) { moved = true; gesture.begin(); }
        const u = g.map.from(q[0], q[1]);
        const du = u[0] - u0[0];
        const dv = u[1] - u0[1];
        const clip = edit.clipById(app.sequence, g.clip.id);
        if (!clip) return;
        if (target.kind === 'inside') writePath(g, M.translate(path0, du, dv));
        else if (target.kind === 'vertex') writePath(g, M.moveVertex(path0, target.index, du, dv));
        else if (target.kind === 'handle') {
          const k = target.index * 6;
          writePath(g, M.setHandle(path0, target.index, target.which, u[0] - path0[k], u[1] - path0[k + 1], g.map.p.w, g.map.p.h, { broken: ev.altKey }));
        } else {
          const along = ((q[0] - start[0]) * g.map.up[0] + (q[1] - start[1]) * g.map.up[1]) / g.map.kUp;
          if (target.kind === 'expansion') edit.write(app, clip, `${prefix(g.sel)}.expansion`, round(Math.max(M.RANGES.expansion[0], Math.min(M.RANGES.expansion[1], g.expansion + along))));
          else edit.write(app, clip, `${prefix(g.sel)}.feather`, round(Math.max(0, Math.min(M.RANGES.feather[1], g.feather + 2 * along))));
        }
      };
      const up = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
        gesture.end();
        ui.overlay?.active?.layout();
      };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    }
    // The pen: a point per press, its handles pulled out while the button is held; the first point closes the path.
    function penDown(e, pt) {
      const g = geo;
      const first = points.length >= M.MIN_POINTS && (() => { const s = g.map.to(points[0].x, points[0].y); return Math.hypot(s[0] - pt[0], s[1] - pt[1]) <= 7; })();
      if (first) {
        const target = pen;
        const path = M.fromPoints(points);
        points = [];
        const r = ui.exec(app, C.addMask(app.sequence.id, target.clipId, { path }, { effectId: target.effectId }));
        if (r?.id) state.select(app, { clipId: target.clipId, effectId: target.effectId, maskId: r.id });
        else state.stopPen(app);
        return;
      }
      const [x, y] = g.map.from(pt[0], pt[1]);
      const p = { x, y, hx: 0, hy: 0 };
      points.push(p);
      ui.overlay?.active?.layout();
      const move = (ev) => {
        const q = localPt(ev);
        if (Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 3) return;
        const u = g.map.from(q[0], q[1]);
        p.hx = u[0] - x;
        p.hy = u[1] - y;
        ui.overlay?.active?.layout();
      };
      const up = () => { removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    }
    hit.addEventListener('pointerdown', down);
    svg.addEventListener('pointerdown', (e) => { if (e.target !== hit) down(e); });
    const key = (e) => {
      if (e.key !== 'Escape' || !pen) return;
      e.preventDefault();
      e.stopPropagation();
      points = [];
      state.stopPen(app);
    };
    addEventListener('keydown', key, true);
    const offMask = app.on('mask', () => { if (!pen) points = []; });
    const offSel = app.on('selection', () => {
      if (selected && !app.selection.has(selected.clipId)) state.select(app, null);
      if (pen && !app.selection.has(pen.clipId)) { points = []; state.stopPen(app); }
    });

    // For tests: the client points of the selected mask's vertices, handles, center, feather and expansion handles.
    state.screen = () => {
      if (!geo || geo.pen) return null;
      const r = layer.getBoundingClientRect();
      const c = (q) => ({ x: Math.round(r.left + q[0]), y: Math.round(r.top + q[1]) });
      const sp = geo.sp;
      const vertices = [];
      const handlesOut = [];
      for (let i = 0; i < M.count(sp); i++) {
        vertices.push(c([sp[i * 6], sp[i * 6 + 1]]));
        handlesOut.push(c([sp[i * 6] + sp[i * 6 + 4], sp[i * 6 + 1] + sp[i * 6 + 5]]));
      }
      const e0 = M.edge(sp, 0, 1, 1);
      return { vertices, handlesOut, edge0: c(M.cubic(e0, 0.5)), feather: c(geo.featherAt), expansion: c(geo.expandAt), up: geo.map.up, kUp: geo.map.kUp };
    };
    // For tests: a picture point (fractions) of the shown clip, in client pixels.
    state.clientPoint = (u, v) => {
      const clip = edit.primaryClip(app);
      const map = clip && mapping(clip);
      if (!map) return null;
      const r = layer.getBoundingClientRect();
      const q = map.to(u, v);
      return { x: Math.round(r.left + q[0]), y: Math.round(r.top + q[1]) };
    };
    return {
      layout: layoutLayer,
      detach() {
        removeEventListener('keydown', key, true);
        offMask();
        offSel();
        svg.remove();
        state.screen = () => null;
        state.clientPoint = () => null;
      },
    };
  }

  ui.maskOverlay = { attach };
})();
