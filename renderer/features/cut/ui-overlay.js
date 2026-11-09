// The program monitor's on-canvas handles of Nano Studio Cut (video-editor-features.md sections 4 and 11): the frame of
// the selected clip, dragged to move it, by a corner to scale it, by the knob above it to rotate it (Shift: 15°
// steps); a double click on a text clip, or the Type tool, edits the text in place. The edits write the clip's
// position, scale and rotation at the playhead (keyframes when the property has them), one undo step per drag.
//
// In-place text editing puts a textarea over the layer: its own glyphs are transparent and only the caret shows, so
// what you see is the compositor's rendering of the layer, updated on every input, the IME's composing text included.
// The whole visit is one undo group that closes when the editor does (Escape, Ctrl+Enter, a click elsewhere), so
// nothing is recorded while a syllable is still composing. Cut.ui.typing keeps the editor's keys from the shortcuts.
//
// The same layer also picks a color for the color panel's white balance (pickColor) from the rendered frame.
//
//   Cut.ui.overlay.attach(viewEl, app, player) -> { detach }      (ui-monitors.js, the program monitor)
//   Cut.ui.overlay.editText(clipId, { created })   Cut.ui.overlay.pickColor() -> Promise<[r, g, b] | null>
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { model, keyframes: K } = Cut;
  const C = Cut.commands;
  const edit = ui.edit;
  const el = ui.el;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  let active = null; // the attached monitor

  function attach(view, app, player) {
    const offs = [];
    const layer = el('div', 'cut-ov');
    const svg = svgEl('svg', { class: 'cut-ov-svg' });
    const box = svgEl('polygon', { class: 'cut-ov-box' });
    const stem = svgEl('line', { class: 'cut-ov-stem' });
    const knob = svgEl('circle', { class: 'cut-ov-rot', r: 6 });
    const handles = [0, 1, 2, 3].map((i) => svgEl('rect', { class: 'cut-ov-handle', width: 9, height: 9, 'data-corner': i }));
    const anchorMark = svgEl('g', { class: 'cut-ov-anchor' });
    anchorMark.append(svgEl('circle', { r: 5 }), svgEl('line', { x1: -8, y1: 0, x2: 8, y2: 0 }), svgEl('line', { x1: 0, y1: -8, x2: 0, y2: 8 }));
    svg.append(box, stem, knob, anchorMark, ...handles);
    layer.appendChild(svg);
    view.appendChild(layer);
    const canvas = () => view.querySelector('canvas.cut-monitor-canvas') || view.querySelector('canvas');
    let geom = null; // the shown clip's geometry, in layer pixels
    let mode = null; // null | 'text' (the Type tool) | 'pick' (eyedropper)
    let editor = null;
    let masksLayer = null; // the masks' handles (ui-masks.js), on this layer with its geometry

    // ---------- geometry ----------
    // The frame's rectangle inside the layer (CSS px) and the scale (CSS px per sequence px).
    function frameRect() {
      const cv = canvas();
      const seq = app.sequence;
      if (!cv || !seq) return null;
      const lr = layer.getBoundingClientRect();
      const cr = cv.getBoundingClientRect();
      const fr = player?.frameRect?.();
      if (fr && fr.w > 0) return { x: cr.left - lr.left + fr.x, y: cr.top - lr.top + fr.y, w: fr.w, h: fr.h, k: fr.w / seq.w };
      const s = Math.min(cr.width / seq.w, cr.height / seq.h);
      return { x: cr.left - lr.left + (cr.width - seq.w * s) / 2, y: cr.top - lr.top + (cr.height - seq.h * s) / 2, w: seq.w * s, h: seq.h * s, k: s };
    }
    // The clip's picture size in sequence pixels (compositor.js: the media's upright size fitted to the sequence,
    // the full frame for text and solids) and its values at the playhead.
    function placement(clip) {
      const seq = app.sequence;
      const W = seq.w;
      const H = seq.h;
      const local = edit.clipTime(app, clip);
      const v = (name, fb) => K.propValue(clip, name, local, clip.props?.[name] ?? fb);
      let w = W;
      let h = H;
      let content = null; // [x, y, w, h] relative to the picture's center
      const m = model.mediaOf(app.project, clip);
      const nest = model.nestOf(app.project, clip);
      if (m || nest) {
        const sw = nest ? nest.w : m.video?.w || W;
        const sh = nest ? nest.h : m.video?.h || H;
        const fit = Cut.compositor?.fitScale ? Cut.compositor.fitScale(sw, sh, W, H, app.project.settings?.fit) : Math.min(W / sw, H / sh);
        w = sw * fit;
        h = sh * fit;
      } else if (clip.source?.generator === 'text') {
        const boxes = (clip.source.layers || []).map((l) => {
          const r = Cut.textrender?.resolveLayer ? Cut.textrender.resolveLayer(l, clip, local) : l;
          const mm = Cut.textrender?.measure?.(r);
          return mm?.box || { x: -100, y: -40, w: 200, h: 80 };
        });
        if (boxes.length) {
          const x1 = Math.min(...boxes.map((b) => b.x));
          const y1 = Math.min(...boxes.map((b) => b.y));
          const x2 = Math.max(...boxes.map((b) => b.x + b.w));
          const y2 = Math.max(...boxes.map((b) => b.y + b.h));
          content = [x1, y1, Math.max(8, x2 - x1), Math.max(8, y2 - y1)];
        }
      }
      const crop = v('crop', [0, 0, 0, 0]).map((x) => (x || 0) / 100);
      if (!content) content = [-w / 2 + crop[3] * w, -h / 2 + crop[0] * h, w * (1 - crop[1] - crop[3]), h * (1 - crop[0] - crop[2])];
      return { W, H, w, h, content, position: v('position', [0, 0]), scale: v('scale', [100, 100]), rotation: v('rotation', 0), anchor: v('anchor', [0, 0]) };
    }
    // Sequence point of a picture point q (relative to its center): center + position + R S (q - anchor).
    function toSeq(p, q) {
      const a = (p.rotation * Math.PI) / 180;
      const sx = p.scale[0] / 100;
      const sy = p.scale[1] / 100;
      const x = (q[0] - p.anchor[0]) * sx;
      const y = (q[1] - p.anchor[1]) * sy;
      return [p.W / 2 + p.position[0] + x * Math.cos(a) - y * Math.sin(a), p.H / 2 + p.position[1] + x * Math.sin(a) + y * Math.cos(a)];
    }
    const toLayer = (fr, s) => [fr.x + s[0] * fr.k, fr.y + s[1] * fr.k];
    const shownClip = () => {
      const seq = app.sequence;
      if (!seq) return null;
      const c = edit.primaryClip(app);
      if (!c || edit.kindOf(seq, c) !== 'video' || !edit.inClip(app, c) || !c.enabled) return null;
      if (c.source?.generator === 'adjustment') return null;
      const t = edit.trackOf(seq, c.track);
      return t && t.visible !== false ? c : null;
    };

    function layout() {
      const fr = frameRect();
      // a mask being edited (ui-masks.js) replaces the motion handles, as in Premiere
      masksLayer?.layout(fr && !editor && mode !== 'pick' ? shownClip() : null);
      const c = fr && !editor && mode !== 'pick' && !ui.masks?.editing(app) ? shownClip() : null;
      layer.classList.toggle('typing', mode === 'text' || app.tool === 'text');
      layer.classList.toggle('picking', mode === 'pick');
      svg.setAttribute('width', String(layer.clientWidth));
      svg.setAttribute('height', String(layer.clientHeight));
      if (!c) { svg.classList.add('hidden'); geom = null; return; }
      svg.classList.remove('hidden');
      const p = placement(c);
      const [x, y, w, h] = p.content;
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((q) => toLayer(fr, toSeq(p, q)));
      box.setAttribute('points', corners.map((pt) => pt.join(',')).join(' '));
      corners.forEach((pt, i) => { handles[i].setAttribute('x', String(pt[0] - 4.5)); handles[i].setAttribute('y', String(pt[1] - 4.5)); });
      const topMid = toLayer(fr, toSeq(p, [x + w / 2, y]));
      const a = (p.rotation * Math.PI) / 180;
      const knobAt = [topMid[0] + 26 * Math.sin(a), topMid[1] - 26 * Math.cos(a)];
      stem.setAttribute('x1', String(topMid[0])); stem.setAttribute('y1', String(topMid[1]));
      stem.setAttribute('x2', String(knobAt[0])); stem.setAttribute('y2', String(knobAt[1]));
      knob.setAttribute('cx', String(knobAt[0])); knob.setAttribute('cy', String(knobAt[1]));
      const anchorAt = toLayer(fr, [p.W / 2 + p.position[0], p.H / 2 + p.position[1]]);
      anchorMark.setAttribute('transform', `translate(${anchorAt[0]} ${anchorAt[1]})`);
      geom = { clipId: c.id, p, fr, corners, anchorAt, knobAt };
    }
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout(); }); };

    // ---------- dragging ----------
    const local = (e) => { const r = layer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function drag(e, kind) {
      if (e.button !== 0 || !geom) return;
      e.preventDefault();
      e.stopPropagation();
      app.setFocus('program');
      const c = edit.clipById(app.sequence, geom.clipId);
      if (!c) return;
      const start = local(e);
      const g0 = geom;
      const p0 = g0.p;
      const label = kind === 'move' ? 'Position' : kind === 'scale' ? 'Scale' : 'Rotation';
      const gesture = edit.gesture(app, label);
      let moved = false;
      const target = e.target;
      target.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const pt = local(ev);
        if (!moved && Math.hypot(pt[0] - start[0], pt[1] - start[1]) < 2) return;
        if (!moved) { moved = true; gesture.begin(); }
        const clip = edit.clipById(app.sequence, g0.clipId);
        if (!clip) return;
        if (kind === 'move') {
          let dx = (pt[0] - start[0]) / g0.fr.k;
          let dy = (pt[1] - start[1]) / g0.fr.k;
          if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          edit.write(app, clip, 'position', [Math.round((p0.position[0] + dx) * 10) / 10, Math.round((p0.position[1] + dy) * 10) / 10]);
        } else if (kind === 'scale') {
          const d0 = Math.hypot(start[0] - g0.anchorAt[0], start[1] - g0.anchorAt[1]) || 1;
          const d1 = Math.hypot(pt[0] - g0.anchorAt[0], pt[1] - g0.anchorAt[1]);
          const f = d1 / d0;
          edit.write(app, clip, 'scale', p0.scale.map((s) => Math.max(0, Math.round(s * f * 10) / 10)));
        } else {
          const a0 = Math.atan2(start[1] - g0.anchorAt[1], start[0] - g0.anchorAt[0]);
          const a1 = Math.atan2(pt[1] - g0.anchorAt[1], pt[0] - g0.anchorAt[0]);
          let r = p0.rotation + ((a1 - a0) * 180) / Math.PI;
          r = ev.shiftKey ? Math.round(r / 15) * 15 : Math.round(r * 10) / 10;
          edit.write(app, clip, 'rotation', r);
        }
        layout();
      };
      const up = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
        gesture.end();
        later();
      };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    }
    box.addEventListener('pointerdown', (e) => drag(e, 'move'));
    for (const hdl of handles) hdl.addEventListener('pointerdown', (e) => drag(e, 'scale'));
    knob.addEventListener('pointerdown', (e) => drag(e, 'rotate'));
    box.addEventListener('dblclick', (e) => {
      const c = geom && edit.clipById(app.sequence, geom.clipId);
      if (c?.source?.generator === 'text') { e.preventDefault(); editText(c.id); }
    });

    // The Type tool: a click on the frame makes a text clip there and edits it; a click on a text clip edits it.
    layer.addEventListener('pointerdown', (e) => {
      if (mode === 'pick' || e.button !== 0) return;
      if (app.tool !== 'text' || editor) return;
      const fr = frameRect();
      if (!fr) return;
      const [x, y] = local(e);
      if (x < fr.x || y < fr.y || x > fr.x + fr.w || y > fr.y + fr.h) return;
      e.preventDefault();
      e.stopPropagation();
      app.setFocus('program');
      const c = shownClip();
      if (c?.source?.generator === 'text' && geom && inside([x, y], geom.corners)) { editText(c.id); return; }
      const seq = app.sequence;
      const pos = [Math.round((x - fr.x) / fr.k - seq.w / 2), Math.round((y - fr.y) / fr.k - seq.h / 2)];
      app.history.begin('Add Graphic');
      let id = null;
      try { id = edit.addText(app, { at: app.t, text: '', position: pos }); } catch (err) { app.history.cancel(); ui.report(err); return; }
      app.select([id]);
      requestAnimationFrame(() => editText(id, { created: true }));
    });
    const inside = (pt, poly) => {
      let inn = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inn = !inn;
      }
      return inn;
    };

    // ---------- in-place text ----------
    function editText(clipId, { created = false, layerId = null } = {}) {
      const seq = app.sequence;
      let c = edit.clipById(seq, clipId);
      if (!c || c.source?.generator !== 'text') { if (created) app.history.cancel(); return null; }
      if (editor) editor.close();
      if (!edit.inClip(app, c)) app.setTime(c.start);
      if (!app.selection.has(c.id)) app.select([c.id]);
      const lid = layerId || c.source.layers[0]?.id;
      if (!lid) return null;
      if (!created) app.history.begin('Edit Text');
      const area = el('textarea', 'cut-ov-edit', undefined, { spellcheck: false, 'aria-label': tr('Text') });
      area.value = c.source.layers.find((l) => l.id === lid)?.text ?? '';
      layer.appendChild(area);
      ui.typing = true;
      mode = null;
      layer.classList.add('editing');
      svg.classList.add('hidden');
      let closed = false;
      const place = () => {
        c = edit.clipById(app.sequence, clipId);
        const l = c?.source.layers.find((x) => x.id === lid);
        const fr = frameRect();
        if (!c || !l || !fr) return;
        const p = placement(c);
        const r = Cut.textrender?.resolveLayer ? Cut.textrender.resolveLayer(l, c, edit.clipTime(app, c)) : l;
        const mm = Cut.textrender?.measure?.(r) || { box: { x: -100, y: -40, w: 200, h: 80 }, lineHeight: l.size * 1.2, width: 200, height: 80 };
        const k = fr.k * (p.scale[0] / 100);
        const center = toLayer(fr, toSeq(p, [mm.box.x + mm.box.w / 2, mm.box.y + mm.box.h / 2]));
        const w = Math.max(mm.width || 0, l.size * 0.6) * k + 8;
        const h = Math.max(mm.height || 0, mm.lineHeight || l.size) * (fr.k * (p.scale[1] / 100)) + 4;
        Object.assign(area.style, {
          left: `${center[0] - w / 2}px`, top: `${center[1] - h / 2}px`, width: `${w}px`, height: `${h}px`,
          font: Cut.textrender?.fontString ? Cut.textrender.fontString(r, Math.max(1, (r.size || 96) * k)) : `${Math.max(1, l.size * k)}px sans-serif`,
          lineHeight: `${(mm.lineHeight || l.size * 1.2) * k}px`, textAlign: l.align || 'center',
          letterSpacing: `${((Number(l.tracking) || 0) / 1000) * (r.size || 96) * k}px`, transform: `rotate(${p.rotation}deg)`,
        });
      };
      place();
      area.addEventListener('input', () => {
        try { app.history.do(C.setLayer(app.sequence.id, clipId, lid, { text: area.value })); } catch (err) { ui.report(err); }
        place();
      });
      area.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.isComposing) return;
        if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) { e.preventDefault(); close(); }
      });
      area.addEventListener('blur', () => close());
      const offTime = app.on('project', () => { if (!closed) requestAnimationFrame(place); });
      function close() {
        if (closed) return;
        closed = true;
        offTime();
        const empty = !area.value.trim();
        area.remove();
        layer.classList.remove('editing');
        ui.typing = false;
        editor = null;
        if (created && empty) app.history.cancel();
        else app.history.commit();
        if (created && app.tool === 'text') app.setTool('select');
        later();
      }
      editor = { close, area, clipId, layerId: lid };
      requestAnimationFrame(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); });
      return editor;
    }

    // ---------- the eyedropper ----------
    let pickDone = null;
    function pickColor() {
      if (pickDone) pickDone(null);
      mode = 'pick';
      layout();
      return new Promise((resolve) => {
        const finish = (v) => {
          if (pickDone !== finish) return;
          pickDone = null;
          mode = null;
          layer.removeEventListener('pointerdown', down, true);
          removeEventListener('keydown', key, true);
          layout();
          resolve(v);
        };
        pickDone = finish;
        const down = async (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const fr = frameRect();
          const [x, y] = local(e);
          if (!fr || x < fr.x || y < fr.y || x > fr.x + fr.w || y > fr.y + fr.h) { finish(null); return; }
          finish(await sample((x - fr.x) / fr.w, (y - fr.y) / fr.h).catch(() => null));
        };
        const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
        layer.addEventListener('pointerdown', down, true);
        addEventListener('keydown', key, true);
      });
    }
    // The average color of a 5x5 block at (u, v) of the frame (0..1), read from the compositor's last render.
    async function sample(u, v) {
      const comp = player?.compositor;
      await player?.render?.();
      if (comp?.readPixels && comp.width && comp.height) {
        const px = await comp.readPixels();
        const seq = app.sequence;
        const s = Math.min(comp.width / seq.w, comp.height / seq.h);
        const ox = (comp.width - seq.w * s) / 2;
        const oy = (comp.height - seq.h * s) / 2;
        const cx = Math.round(ox + u * seq.w * s);
        const cy = Math.round(oy + v * seq.h * s);
        return average(px, comp.width, comp.height, cx, cy);
      }
      const cv = canvas();
      const fr = player?.frameRect?.() || { x: 0, y: 0, w: cv.clientWidth, h: cv.clientHeight };
      const sx = cv.width / (cv.clientWidth || cv.width);
      const g = new OffscreenCanvas(cv.width, cv.height).getContext('2d');
      g.drawImage(cv, 0, 0);
      const data = g.getImageData(0, 0, cv.width, cv.height).data;
      return average(data, cv.width, cv.height, Math.round((fr.x + u * fr.w) * sx), Math.round((fr.y + v * fr.h) * sx));
    }
    function average(px, w, h, cx, cy) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = (y * w + x) * 4;
          sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2];
          n++;
        }
      }
      return n ? sum.map((s) => s / n) : null;
    }

    masksLayer = ui.maskOverlay?.attach({ layer, app, player, frameRect, placement, toSeq }) || null;
    offs.push(() => masksLayer?.detach());
    for (const ev of ['time', 'project', 'selection', 'sequence', 'tool', 'mask']) offs.push(app.on(ev, later));
    const ro = ide.util.observeSize(view, later);
    offs.push(() => ro.disconnect());
    offs.push(() => cancelAnimationFrame(raf));
    const api = {
      editText, pickColor, layout, sample, placement,
      get geometry() { return geom; },
      get editor() { return editor; },
      detach() {
        for (const off of offs.splice(0)) { try { off(); } catch {} }
        editor?.close();
        pickDone?.(null);
        layer.remove();
        if (active === api) active = null;
      },
    };
    active = api;
    later();
    return api;
  }

  ui.overlay = {
    attach,
    editText: (clipId, opts) => active?.editText(clipId, opts) ?? null,
    pickColor: () => (active ? active.pickColor() : Promise.resolve(null)),
    // The rendered color at (u, v) of the frame (0..1), as the eyedropper reads it.
    pickColorAt: (u, v) => (active ? active.sample(u, v) : Promise.resolve(null)),
    get active() { return active; },
  };
})();
