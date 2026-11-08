// The effect controls panel of Nano Studio Cut (video-editor-features.md sections 7 and 8): the properties of the
// selected clip (motion, opacity, crop; volume and pan for sound; the keyframable fields of a text layer), its effects
// in order with their parameters built from the registry's definitions (Cut.effects), and, when a transition is
// selected in the timeline, the transition's settings. Values are those at the playhead. Each keyframable row has a
// stopwatch, previous/add/next keyframe buttons and a small lane of the clip's span with its keyframes: click to pick,
// Shift to pick more, drag to move them, right-click for the interpolation (linear, ease in/out, bezier, hold), copy
// and paste. Between two keyframes the lane draws the segment's shape from the first value to the next (rising or
// falling with the value): a step for hold, the timing curve for the others; a bezier segment shows its two handles,
// which are dragged to reshape it (one undo step).
//
// The form is built once per clip shape (which properties and effects it has) and only its values change with the
// playhead or an edit, so a field being typed in is never replaced.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { time, model, keyframes: K } = Cut;
  const C = Cut.commands;
  const edit = ui.edit;
  const el = ui.el;

  const EASES = edit.EASES;
  const svg = (body) => `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const GLYPHS = {
    watch: svg('<circle cx="8" cy="9" r="5.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 6v3.2l2 1.3M6.5 2h3M8 2v1.8" stroke="currentColor" stroke-width="1.3"/>'),
    prev: svg('<path d="M10.5 3.5v9L4.5 8z" fill="currentColor"/>'),
    next: svg('<path d="M5.5 3.5v9l6-4.5z" fill="currentColor"/>'),
    key: svg('<path d="M8 3.2 12.8 8 8 12.8 3.2 8z" stroke="currentColor" stroke-width="1.3"/>'),
    keyOn: svg('<path d="M8 3.2 12.8 8 8 12.8 3.2 8z" fill="currentColor"/>'),
    reset: svg('<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 2.5v3h3" stroke="currentColor" stroke-width="1.3"/>'),
    remove: svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.3"/>'),
    up: svg('<path d="M8 3.5v9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.3"/>'),
    down: svg('<path d="M8 12.5v-9M4.5 9 8 12.5 11.5 9" stroke="currentColor" stroke-width="1.3"/>'),
    fx: svg('<rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor"/><path d="M5.5 10.5 7 5.5h2M5.8 8h2.2M9.5 7.5l2 3M11.5 7.5l-2 3" stroke="currentColor"/>'),
    twisty: svg('<path d="m5.5 4 4 4-4 4" stroke="currentColor" stroke-width="1.4"/>'),
  };
  const glyph = (name) => {
    const s = el('span', 'ide-icon cut-icon');
    s.innerHTML = GLYPHS[name];
    return s;
  };
  function iconButton(name, title, onClick, cls = '') {
    const b = el('button', `cut-ec-ib ${cls}`, undefined, { type: 'button', title, 'aria-label': title });
    b.appendChild(glyph(name));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e, b); });
    return b;
  }

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-ec');
    const head = el('div', 'cut-ec-head');
    const title = el('span', 'cut-ec-title');
    title.dataset.userText = '';
    const sub = el('span', 'cut-ec-sub');
    head.append(title, sub);
    const laneHead = el('div', 'cut-ec-lanehead');
    const laneRuler = el('canvas', 'cut-ec-laneruler');
    laneHead.appendChild(laneRuler);
    const body = el('div', 'cut-ec-body');
    const empty = el('div', 'cut-ec-empty');
    root.append(head, laneHead, body, empty);
    host.appendChild(root);

    let shapeKey = null;
    let rows = []; // {path, clipId, update(), lane?}
    const collapsed = new Set();
    const picked = new Set(); // `${clipId}|${path}|${t}` of the keyframes picked in the lanes
    let kfClipboard = null;
    let subject = null; // {kind: 'clip', clipId} | {kind: 'transition', id}

    const seq = () => app.sequence;
    const clipNow = (id) => edit.clipById(seq(), id);
    const fps = () => seq()?.fps || [30, 1];

    // ---------- what is shown ----------
    function pickSubject() {
      const s = seq();
      if (!s) return null;
      const trId = app.selectedTransition;
      if (trId && s.transitions.some((t) => t.id === trId) && !app.selection.size) return { kind: 'transition', id: trId };
      const c = edit.primaryClip(app);
      return c ? { kind: 'clip', clipId: c.id } : null;
    }
    function shapeOf(sj) {
      const s = seq();
      if (!sj) return 'none';
      if (sj.kind === 'transition') {
        const t = s.transitions.find((x) => x.id === sj.id);
        return t ? `t|${t.id}|${t.type}` : 'none';
      }
      const c = clipNow(sj.clipId);
      if (!c) return 'none';
      const parts = [c.id, edit.kindOf(s, c), c.source?.generator || 'media', c.effects.map((e) => `${e.id}:${e.type}`).join(','), (c.source?.layers || []).map((l) => l.id).join(',')];
      for (const a of companions(c)) parts.push(`+${a.id}:${a.effects.map((e) => `${e.id}:${e.type}`).join(',')}`);
      return parts.join('|');
    }
    // A linked audio clip selected with the video one shows its sound sections too.
    function companions(c) {
      const s = seq();
      return model.linkedClips(s, c).filter((x) => app.selection.has(x.id) && edit.kindOf(s, x) === 'audio' && edit.kindOf(s, c) === 'video');
    }

    function refresh() {
      subject = pickSubject();
      const key = shapeOf(subject);
      if (key !== shapeKey) {
        shapeKey = key;
        build();
      }
      update();
    }

    function build() {
      body.replaceChildren();
      rows = [];
      const s = seq();
      empty.hidden = !!subject && shapeKey !== 'none';
      laneHead.hidden = true;
      if (!subject || shapeKey === 'none') {
        title.textContent = '';
        sub.textContent = '';
        empty.textContent = tr('Select a clip in the timeline to see its properties and effects.');
        return;
      }
      if (subject.kind === 'transition') { buildTransition(s.transitions.find((x) => x.id === subject.id)); return; }
      const c = clipNow(subject.clipId);
      laneHead.hidden = false;
      const kind = edit.kindOf(s, c);
      if (kind === 'video') {
        section('motion', tr('Motion'), c, [
          { label: tr('Position'), path: 'position', type: 'point', step: 1 },
          { label: tr('Scale'), path: 'scale', type: 'uniform', min: 0, max: 10000, step: 1, unit: '%', slider: [0, 400] },
          { label: tr('Rotation'), path: 'rotation', type: 'number', min: -36000, max: 36000, step: 1, unit: '°' },
          { label: tr('Anchor Point'), path: 'anchor', type: 'point', step: 1 },
        ]);
        section('opacity', tr('Opacity'), c, [{ label: tr('Opacity'), path: 'opacity', type: 'number', min: 0, max: 100, step: 1, unit: '%', slider: [0, 100] }]);
        section('crop', tr('Crop'), c, [
          { label: tr('Top'), path: 'crop', index: 0, type: 'number', min: 0, max: 100, step: 0.5, unit: '%', slider: [0, 100] },
          { label: tr('Right'), path: 'crop', index: 1, type: 'number', min: 0, max: 100, step: 0.5, unit: '%', slider: [0, 100] },
          { label: tr('Bottom'), path: 'crop', index: 2, type: 'number', min: 0, max: 100, step: 0.5, unit: '%', slider: [0, 100] },
          { label: tr('Left'), path: 'crop', index: 3, type: 'number', min: 0, max: 100, step: 0.5, unit: '%', slider: [0, 100] },
        ]);
        for (const l of c.source?.generator === 'text' ? c.source.layers : []) {
          section(`text:${l.id}`, tr('Text: {name}', { name: (l.text || '').split('\n')[0].slice(0, 24) || l.id }), c, [
            { label: tr('Position'), path: `layers.${l.id}.position`, type: 'point', step: 1 },
            { label: tr('Size'), path: `layers.${l.id}.size`, type: 'number', min: 1, max: 2000, step: 1, slider: [8, 400] },
            { label: tr('Opacity'), path: `layers.${l.id}.opacity`, type: 'number', min: 0, max: 100, step: 1, unit: '%', slider: [0, 100], fallback: 100 },
            { label: tr('Tracking'), path: `layers.${l.id}.tracking`, type: 'number', min: -500, max: 2000, step: 1 },
            { label: tr('Characters Shown'), path: `layers.${l.id}.reveal`, type: 'number', min: 0, max: 1, step: 0.01, slider: [0, 1], fallback: 1 },
            { label: tr('Fill'), path: `layers.${l.id}.fill`, type: 'color' },
          ]);
        }
        speedSection(c);
      } else {
        audioSections(c);
        speedSection(c);
      }
      for (const a of companions(c)) audioSections(a, true);
      effectSections(c);
      for (const a of companions(c)) effectSections(a);
      title.textContent = c.name || model.mediaOf(app.project, c)?.name || tr('Clip');
      sub.textContent = kind === 'audio' ? tr('Audio Clip') : c.source?.generator === 'text' ? tr('Text') : c.source?.generator ? tr('Graphic') : tr('Video Clip');
      drawLaneRuler();
    }
    function audioSections(c, linked = false) {
      section(`volume:${c.id}`, linked ? tr('Volume (linked audio)') : tr('Volume'), c, [
        { label: tr('Level'), path: 'volume', type: 'number', min: -96, max: 15, step: 0.1, unit: 'dB', slider: [-60, 15] },
        { label: tr('Fade In'), path: 'fadeIn', type: 'duration' },
        { label: tr('Fade Out'), path: 'fadeOut', type: 'duration' },
      ]);
      section(`panner:${c.id}`, tr('Panner'), c, [{ label: tr('Balance'), path: 'pan', type: 'number', min: -100, max: 100, step: 1, slider: [-100, 100] }]);
    }
    // Speed and reverse of a clip with a source (a still has none); later clips move along, a linked pair together.
    function speedSection(c) {
      if (model.isStill(app.project, c)) return;
      section(`speed:${c.id}`, tr('Speed'), c, [
        { label: tr('Speed'), path: 'speed', type: 'number', min: 1, max: 10000, step: 1, precision: 2, unit: '%', slider: [10, 400],
          field: { get: (x) => Math.round(x.speed * 10000) / 100, patch: (v) => ({ speed: v / 100 }), reset: { speed: 1 } } },
        { label: tr('Reverse Speed'), path: 'reverse', type: 'bool',
          field: { get: (x) => !!x.reverse, patch: (v) => ({ reverse: !!v }), reset: { reverse: false } } },
      ]);
    }
    function effectSections(c) {
      c.effects.forEach((e, i) => {
        const def = edit.effectDef(e.type);
        const params = (def?.params || []).map((p) => ({
          label: tr(p.name), path: `effects.${e.id}.${p.id}`, type: p.type === 'percent' || p.type === 'angle' ? 'number' : p.type, min: p.min, max: p.max, step: p.step,
          unit: p.unit || (p.type === 'percent' ? '%' : p.type === 'angle' ? '°' : ''), choices: p.choices, keyframable: p.keyframable !== false,
          slider: Number.isFinite(p.min) && Number.isFinite(p.max) && p.max - p.min <= 2000 ? [p.min, p.max] : null, fallback: p.default,
        })).flatMap((spec, k, all) => {
          const g = def.params[k].group;
          return g && g !== def.params[k - 1]?.group ? [{ heading: tr(g) }, spec] : [spec];
        });
        const sec = section(`fx:${c.id}:${e.id}`, def ? tr(def.name) : e.type, c, params, { effect: e, index: i, count: c.effects.length });
        // An effect may add a view above its rows (ui-audiofx.js: the EQ's frequency response): {node, update()}.
        const view = ui.effectViews?.[e.type]?.({ app, clipId: c.id, effectId: e.id });
        if (view) { sec.querySelector('.cut-ec-rows').prepend(view.node); rows.push(view); }
      });
    }

    // ---------- a section and its rows ----------
    function section(id, name, clip, specs, fx = null) {
      const sec = el('div', `cut-ec-sec${collapsed.has(id) ? ' collapsed' : ''}`, undefined, { 'data-section': id });
      const top = el('div', 'cut-ec-sechead');
      const tw = iconButton('twisty', collapsed.has(id) ? tr('Expand') : tr('Collapse'), () => {
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        sec.classList.toggle('collapsed', collapsed.has(id));
        drawLanes();
      }, 'twisty');
      top.appendChild(tw);
      if (fx) {
        const onBtn = iconButton('fx', tr('Effect On/Off'), () => ui.exec(app, C.setEffect(seq().id, clip.id, fx.effect.id, { on: !clipEffect(clip.id, fx.effect.id)?.on })), 'fxon');
        onBtn.dataset.effect = fx.effect.id;
        top.appendChild(onBtn);
        rows.push({ update() { const e = clipEffect(clip.id, fx.effect.id); onBtn.setAttribute('aria-pressed', String(!!e?.on)); } });
      }
      const label = el('span', 'cut-ec-secname', name);
      top.appendChild(label);
      top.addEventListener('dblclick', () => tw.click());
      const tools = el('span', 'cut-ec-sectools');
      tools.appendChild(iconButton('reset', tr('Reset'), () => resetSection(clip.id, specs, fx)));
      if (fx) {
        if (fx.index > 0) tools.appendChild(iconButton('up', tr('Move Up'), () => ui.exec(app, C.moveEffect(seq().id, clip.id, fx.effect.id, fx.index - 1))));
        if (fx.index < fx.count - 1) tools.appendChild(iconButton('down', tr('Move Down'), () => ui.exec(app, C.moveEffect(seq().id, clip.id, fx.effect.id, fx.index + 1))));
        tools.appendChild(iconButton('remove', tr('Remove Effect'), () => ui.exec(app, C.removeEffect(seq().id, clip.id, fx.effect.id)), 'remove'));
        top.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || e.target.closest('button')) return;
          ui.dnd.start(e, { kind: 'effectOrder', clipId: clip.id, effectId: fx.effect.id }, { label: name });
        });
        top.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          ui.menu(e.clientX, e.clientY, [
            { label: tr('Move Up'), disabled: fx.index === 0, run: () => ui.exec(app, C.moveEffect(seq().id, clip.id, fx.effect.id, fx.index - 1)) },
            { label: tr('Move Down'), disabled: fx.index >= fx.count - 1, run: () => ui.exec(app, C.moveEffect(seq().id, clip.id, fx.effect.id, fx.index + 1)) },
            { label: tr('Reset'), run: () => resetSection(clip.id, specs, fx) },
            { separator: true },
            { label: tr('Remove Effect'), run: () => ui.exec(app, C.removeEffect(seq().id, clip.id, fx.effect.id)) },
          ]);
        });
      }
      top.appendChild(tools);
      sec.appendChild(top);
      const list = el('div', 'cut-ec-rows');
      // An effect whose parameters have groups (Lumetri Color) shows each group's name above its rows.
      for (const spec of specs) list.appendChild(spec.heading ? el('div', 'cut-ec-subhead', spec.heading) : paramRow(clip.id, spec));
      sec.appendChild(list);
      body.appendChild(sec);
      return sec;
    }
    const clipEffect = (clipId, effectId) => clipNow(clipId)?.effects.find((e) => e.id === effectId) || null;
    function resetSection(clipId, specs, fx) {
      const c = clipNow(clipId);
      if (!c) return;
      app.history.begin('Reset');
      try {
        for (const spec of specs) {
          if (spec.heading) continue;
          if (spec.field) { app.history.do(C.setClip(seq().id, c.id, { ...spec.field.reset, ripple: true })); continue; }
          if (spec.type === 'duration') { app.history.do(C.setClip(seq().id, c.id, { [spec.path]: 0 })); continue; }
          if (edit.keyframed(c, spec.path)) app.history.do(C.setKeyframes(seq().id, c.id, spec.path, null));
          const def = edit.defaultOf(c, spec.path) ?? spec.fallback;
          if (spec.path.startsWith('layers.') && ['opacity', 'reveal'].includes(spec.path.split('.')[2])) continue;
          if (def !== undefined) edit.setStatic(app, clipNow(clipId), spec.path, def);
        }
        if (fx) app.history.do(C.setEffect(seq().id, c.id, fx.effect.id, { params: Object.fromEntries(Object.keys(clipEffect(clipId, fx.effect.id)?.params || {}).map((k) => [k, null])) }));
        app.history.commit();
      } catch (err) {
        app.history.cancel();
        ui.report(err);
      }
    }

    function paramRow(clipId, spec) {
      const row = el('div', 'cut-ec-row', undefined, { 'data-path': spec.index != null ? `${spec.path}[${spec.index}]` : spec.path });
      const left = el('div', 'cut-ec-left');
      const lane = el('div', 'cut-ec-lane');
      const path = spec.path;
      const keyframable = spec.type !== 'duration' && spec.type !== 'choice' && spec.type !== 'bool' && spec.keyframable !== false && !spec.field && spec.index == null;
      const keyframableArray = spec.index != null; // crop: the whole array is one keyframed property
      let watch = null;
      if (keyframable || (keyframableArray && spec.index === 0)) {
        watch = iconButton('watch', tr('Toggle Animation'), () => {
          const c = clipNow(clipId);
          if (c) edit.setKeyframing(app, c, path, !edit.keyframed(c, path));
        }, 'watch');
        left.appendChild(watch);
      } else left.appendChild(el('span', 'cut-ec-ib-space'));
      left.appendChild(el('span', 'cut-ec-label', spec.label));
      const ctl = el('span', 'cut-ec-ctl');
      left.appendChild(ctl);
      const value = () => {
        const c = clipNow(clipId);
        if (!c) return undefined;
        if (spec.field) return spec.field.get(c);
        if (spec.type === 'duration') return c[path] || 0;
        const v = edit.valueAt(app, c, path);
        return v === undefined ? spec.fallback : v;
      };
      const gesture = edit.gesture(app, spec.type === 'duration' || spec.field ? 'Clip Settings' : 'Effect Settings');
      const write = (v) => {
        const c = clipNow(clipId);
        if (!c) return;
        if (spec.field) { ui.exec(app, C.setClip(seq().id, c.id, { ...spec.field.patch(v), ripple: true })); return; }
        if (spec.type === 'duration') { ui.exec(app, C.setClip(seq().id, c.id, { [path]: v }, { linked: false })); return; }
        let next = v;
        if (spec.index != null) { next = (value() || [0, 0, 0, 0]).slice(); next[spec.index] = v; }
        if (spec.type === 'uniform') next = [v, v];
        edit.write(app, c, path, next);
      };
      const updates = [];
      const numberCtl = (get, set, opts = {}) => {
        const f = ui.numberField({
          value: get() ?? 0, min: opts.min ?? spec.min, max: opts.max ?? spec.max, step: opts.step ?? spec.step ?? 1, unit: opts.unit ?? spec.unit ?? '',
          precision: spec.precision ?? ((opts.step ?? spec.step ?? 1) < 1 ? String(opts.step ?? spec.step).split('.')[1].length : 0),
          onBegin: () => gesture.begin(), onEnd: () => gesture.end(), onChange: (v) => set(v),
        });
        updates.push(() => { const v = get(); if (!f.querySelector('input')) f.value = typeof v === 'number' ? v : NaN; });
        return f;
      };
      switch (spec.type) {
        case 'point': {
          ctl.append(numberCtl(() => value()?.[0], (v) => write([v, value()?.[1] ?? 0]), { unit: '' }), numberCtl(() => value()?.[1], (v) => write([value()?.[0] ?? 0, v]), { unit: '' }));
          break;
        }
        case 'uniform':
        case 'number': {
          const get = () => { const v = value(); return spec.type === 'uniform' ? v?.[0] : spec.index != null ? v?.[spec.index] : v; };
          ctl.appendChild(numberCtl(get, write));
          if (spec.slider) {
            const s = ui.slider({ min: spec.slider[0], max: spec.slider[1], step: spec.step ?? 1, value: get() ?? 0, onBegin: () => gesture.begin(), onEnd: () => gesture.end(), onInput: (v) => write(v), cls: 'cut-ec-slider' });
            updates.push(() => { const v = get(); if (typeof v === 'number' && document.activeElement !== s) s.value = String(v); });
            row.classList.add('has-slider');
            row.dataset.slider = '1';
            left.appendChild(s);
          }
          break;
        }
        case 'color': {
          const input = el('input', 'cut-ec-color', undefined, { type: 'color' });
          input.addEventListener('focus', () => gesture.begin());
          input.addEventListener('input', () => write(input.value));
          input.addEventListener('change', () => gesture.end());
          input.addEventListener('blur', () => gesture.end());
          updates.push(() => { const v = value(); if (typeof v === 'string' && document.activeElement !== input) input.value = v.slice(0, 7); });
          ctl.appendChild(input);
          break;
        }
        case 'bool': {
          const input = el('input', null, undefined, { type: 'checkbox' });
          input.addEventListener('change', () => write(input.checked));
          updates.push(() => { input.checked = !!value(); });
          ctl.appendChild(input);
          break;
        }
        case 'choice': {
          const s = ui.select({ options: (spec.choices || []).map(([id, name]) => ({ value: id, label: tr(name) })), onChange: (v) => write(v) });
          updates.push(() => { const v = value(); if (v != null) s.value = String(v); });
          ctl.appendChild(s);
          break;
        }
        case 'duration': {
          const f = ui.timecodeField({ fps, value: value() || 0, onChange: (t) => write(t) });
          updates.push(() => { f.value = value() || 0; });
          ctl.appendChild(f);
          break;
        }
        // Lumetri Color's curves and Look are edited in its panel; the row shows what is set (and keyframes the curve).
        case 'curve': {
          const t = el('span', 'cut-ec-note');
          updates.push(() => { const v = value(); t.textContent = tr('{n} points', { n: Array.isArray(v) ? Math.floor(v.length / 2) : 2 }); });
          ctl.appendChild(t);
          break;
        }
        case 'lut': {
          const t = el('span', 'cut-ec-note');
          updates.push(() => { const v = value(); t.textContent = v ? app.project.luts?.[v]?.name || tr('Missing LUT') : tr('None'); });
          ctl.appendChild(t);
          break;
        }
        default: break;
      }
      let nav = null;
      if (watch) {
        nav = el('span', 'cut-ec-nav');
        const prev = iconButton('prev', tr('Go to Previous Keyframe'), () => { const c = clipNow(clipId); if (c) edit.jumpKeyframe(app, c, path, -1); }, 'prev');
        const add = iconButton('key', tr('Add/Remove Keyframe'), () => { const c = clipNow(clipId); if (c) edit.toggleKeyframe(app, c, path); }, 'addkey');
        const next = iconButton('next', tr('Go to Next Keyframe'), () => { const c = clipNow(clipId); if (c) edit.jumpKeyframe(app, c, path, 1); }, 'next');
        nav.append(prev, add, next);
        left.appendChild(nav);
        updates.push(() => {
          const c = clipNow(clipId);
          const on = !!c && edit.keyframed(c, path);
          watch.setAttribute('aria-pressed', String(on));
          nav.classList.toggle('shown', on);
          const here = on && edit.inClip(app, c) && c.keyframes[path].some((k) => k.t === edit.clipTime(app, c));
          add.replaceChildren(glyph(here ? 'keyOn' : 'key'));
          add.setAttribute('aria-pressed', String(here));
        });
      }
      row.append(left, lane);
      const entry = { clipId, path, update: () => { for (const u of updates) u(); }, lane: null };
      if (watch) {
        const canvas = el('canvas', 'cut-ec-lanecanvas');
        lane.appendChild(canvas);
        entry.lane = { canvas, el: lane };
        laneEvents(entry);
      }
      rows.push(entry);
      return row;
    }

    // ---------- transitions ----------
    function buildTransition(t) {
      const s = seq();
      const kind = edit.trackOf(s, t.track)?.kind || 'video';
      const defs = (Cut.effects?.transitions?.(kind) || []);
      const def = defs.find((d) => d.type === t.type);
      title.textContent = def ? tr(def.name) : t.type;
      sub.textContent = tr('Transition');
      const sec = el('div', 'cut-ec-sec', undefined, { 'data-section': 'transition' });
      const list = el('div', 'cut-ec-rows');
      const set = (patch) => ui.exec(app, C.setTransition(s.id, t.id, patch));
      const cur = () => seq().transitions.find((x) => x.id === t.id);
      const typeSel = ui.select({ options: defs.map((d) => ({ value: d.type, label: tr(d.name) })), value: t.type, onChange: (v) => set({ type: v }) });
      const dur = ui.timecodeField({ fps, value: t.duration, onChange: (d) => set({ duration: d }) });
      const align = ui.select({ options: [['center', tr('Center at Cut')], ['start', tr('Start at Cut')], ['end', tr('End at Cut')]].map(([value, label]) => ({ value, label })), value: t.align, onChange: (v) => set({ align: v }) });
      const simpleRow = (label, control) => {
        const r = el('div', 'cut-ec-row');
        const left = el('div', 'cut-ec-left');
        left.append(el('span', 'cut-ec-ib-space'), el('span', 'cut-ec-label', label));
        const ctl = el('span', 'cut-ec-ctl');
        ctl.appendChild(control);
        left.appendChild(ctl);
        r.append(left, el('div', 'cut-ec-lane'));
        return r;
      };
      list.append(simpleRow(tr('Transition'), typeSel), simpleRow(tr('Duration'), dur), simpleRow(tr('Alignment'), align));
      for (const p of def?.params || []) {
        if (p.type !== 'choice') continue;
        const ps = ui.select({ options: p.choices.map(([id, name]) => ({ value: id, label: tr(name) })), value: t.params?.[p.id] ?? p.default, onChange: (v) => set({ params: { [p.id]: v === p.default ? null : v } }) });
        list.appendChild(simpleRow(tr(p.name), ps));
        rows.push({ update() { const x = cur(); if (x) ps.value = String(x.params?.[p.id] ?? p.default); } });
      }
      rows.push({ update() { const x = cur(); if (!x) return; typeSel.value = x.type; dur.value = x.duration; align.value = x.align; } });
      sec.appendChild(list);
      body.appendChild(sec);
    }

    // ---------- values and lanes ----------
    function update() {
      for (const r of rows) r.update?.();
      drawLanes();
      drawLaneRuler();
    }
    const subjectClip = () => (subject?.kind === 'clip' ? clipNow(subject.clipId) : null);
    function laneGeom(canvas) {
      const w = canvas.parentElement.clientWidth;
      const h = canvas.parentElement.clientHeight || 22;
      const dpr = devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    }
    const laneX = (clip, w, t) => 6 + (t / Math.max(1, model.clipDuration(clip))) * (w - 12);
    const laneT = (clip, w, x) => ((x - 6) / Math.max(1, w - 12)) * model.clipDuration(clip);
    function cssVar(name, fb) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }
    // Which way a segment's value goes: up (1) or down (-1); a value that does not change counts as up.
    function direction(a, b) {
      if (typeof a === 'number' && typeof b === 'number') return b < a ? -1 : 1;
      if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (typeof a[i] === 'number' && b[i] !== a[i]) return b[i] < a[i] ? -1 : 1;
      }
      return 1;
    }
    // The drawing of segment i of a lane (keyframe i to i + 1), in lane pixels: its ends, the y of a progress p
    // (0 at the first value, 1 at the next) and back, and the bezier handles' points when it has them.
    const LANE_PAD = 4;
    function segment(c, list, i, w, h) {
      const a = list[i];
      const b = list[i + 1];
      if (!b) return null;
      const xa = laneX(c, w, a.t);
      const xb = laneX(c, w, b.t);
      const lo = h - LANE_PAD;
      const hi = LANE_PAD;
      const dir = direction(a.v, b.v);
      const yOf = (p) => (dir > 0 ? lo - p * (lo - hi) : hi + p * (lo - hi));
      const pOf = (y) => (dir > 0 ? (lo - y) / (lo - hi) : (y - hi) / (lo - hi));
      const hd = a.ease === 'hold' ? null : K.handles(a);
      const pts = hd ? [[xa + hd[0] * (xb - xa), yOf(hd[1])], [xa + hd[2] * (xb - xa), yOf(hd[3])]] : null;
      // handles only where there is room to grab them
      const handles = a.ease === 'bezier' && xb - xa >= 16 ? pts : null;
      return { a, b, xa, xb, yOf, pOf, pts, handles };
    }
    function drawLanes() {
      const accent = cssVar('--cut-accent', '#e8743b');
      const text = cssVar('--gray10', '#b4b8bf');
      const line = cssVar('--gray4', '#43454a');
      const curve = cssVar('--gray8', '#868a91');
      const head = cssVar('--cut-playhead', '#e05555');
      for (const r of rows) {
        if (!r.lane) continue;
        const c = clipNow(r.clipId);
        if (!c || !r.lane.canvas.isConnected || !r.lane.canvas.parentElement.clientWidth) continue;
        const { ctx, w, h } = laneGeom(r.lane.canvas);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = line;
        ctx.fillRect(6, Math.round(h / 2), w - 12, 1);
        const list = c.keyframes?.[r.path] || [];
        // the segments' shapes under the keyframes
        for (let i = 0; i < list.length - 1; i++) {
          const s = segment(c, list, i, w, h);
          ctx.strokeStyle = curve;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(s.xa, s.yOf(0));
          if (s.a.ease === 'hold') {
            ctx.lineTo(s.xb, s.yOf(0));
            ctx.lineTo(s.xb, s.yOf(1));
          } else ctx.bezierCurveTo(s.pts[0][0], s.pts[0][1], s.pts[1][0], s.pts[1][1], s.xb, s.yOf(1));
          ctx.stroke();
          if (s.handles) {
            const on = picked.has(`${c.id}|${r.path}|${s.a.t}`);
            ctx.strokeStyle = on ? accent : text;
            ctx.fillStyle = on ? accent : text;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(s.xa, s.yOf(0)); ctx.lineTo(s.handles[0][0], s.handles[0][1]);
            ctx.moveTo(s.xb, s.yOf(1)); ctx.lineTo(s.handles[1][0], s.handles[1][1]);
            ctx.stroke();
            for (const [hx, hy] of s.handles) { ctx.beginPath(); ctx.arc(hx, hy, 2.5, 0, Math.PI * 2); ctx.fill(); }
          }
        }
        ctx.lineWidth = 1;
        for (let i = 0; i < list.length; i++) {
          const k = list[i];
          const x = laneX(c, w, k.t);
          const y = h / 2;
          const on = picked.has(`${c.id}|${r.path}|${k.t}`);
          ctx.fillStyle = on ? accent : text;
          ctx.strokeStyle = on ? accent : text;
          ctx.beginPath();
          const sz = 5;
          // linear: a diamond; eased and bezier: a circle; hold: a square
          if (k.ease === 'hold') ctx.rect(x - sz + 1, y - sz + 1, 2 * sz - 2, 2 * sz - 2);
          else if (k.ease && k.ease !== 'linear') ctx.arc(x, y, sz - 0.5, 0, Math.PI * 2);
          else { ctx.moveTo(x, y - sz); ctx.lineTo(x + sz, y); ctx.lineTo(x, y + sz); ctx.lineTo(x - sz, y); ctx.closePath(); }
          ctx.fill();
        }
        if (edit.inClip(app, c)) {
          const px = Math.round(laneX(c, w, app.t - c.start)) + 0.5;
          ctx.fillStyle = head;
          ctx.fillRect(px - 0.5, 0, 1, h);
        }
      }
    }
    function drawLaneRuler() {
      const c = subjectClip();
      if (!c || laneHead.hidden || !laneHead.clientWidth) return;
      const { ctx, w, h } = laneGeom(laneRuler);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = cssVar('--gray8', '#868a91');
      ctx.font = '10px Consolas, monospace';
      ctx.textBaseline = 'top';
      const d = model.clipDuration(c);
      ctx.fillText(time.timecode(c.start, fps()), 6, 2);
      const end = time.timecode(c.start + d, fps());
      ctx.fillText(end, w - 6 - ctx.measureText(end).width, 2);
      if (edit.inClip(app, c)) {
        const px = laneX(c, w, app.t - c.start);
        ctx.fillStyle = cssVar('--cut-playhead', '#e05555');
        ctx.beginPath();
        ctx.moveTo(px - 5, h - 8); ctx.lineTo(px + 5, h - 8); ctx.lineTo(px, h - 2); ctx.closePath();
        ctx.fill();
      }
    }
    // The lane header scrubs the playhead inside the clip.
    laneHead.addEventListener('pointerdown', (e) => {
      const c = subjectClip();
      if (!c || e.button !== 0) return;
      e.preventDefault();
      laneHead.setPointerCapture(e.pointerId);
      const f = time.frameTicks(fps());
      const go = (ev) => {
        const r = laneHead.getBoundingClientRect();
        const t = laneT(c, r.width, ev.clientX - r.left);
        app.setTime(c.start + Math.max(0, Math.min(model.clipDuration(c) - f, Math.round(t / f) * f)));
      };
      go(e);
      const move = (ev) => go(ev);
      const up = () => { laneHead.removeEventListener('pointermove', move); laneHead.removeEventListener('pointerup', up); };
      laneHead.addEventListener('pointermove', move);
      laneHead.addEventListener('pointerup', up);
    });

    function keyAt(entry, x) {
      const c = clipNow(entry.clipId);
      if (!c) return null;
      const w = entry.lane.canvas.parentElement.clientWidth;
      const list = c.keyframes?.[entry.path] || [];
      let best = null;
      for (const k of list) {
        const d = Math.abs(laneX(c, w, k.t) - x);
        if (d <= 6 && (!best || d < best.d)) best = { k, d };
      }
      return best?.k || null;
    }
    // A bezier handle under a lane point: {index (the segment), which: 0 | 1}.
    function handleAt(entry, x, y) {
      const c = clipNow(entry.clipId);
      if (!c) return null;
      const w = entry.lane.canvas.parentElement.clientWidth;
      const h = entry.lane.canvas.parentElement.clientHeight || 22;
      const list = c.keyframes?.[entry.path] || [];
      let best = null;
      for (let i = 0; i < list.length - 1; i++) {
        const s = segment(c, list, i, w, h);
        if (!s?.handles) continue;
        s.handles.forEach(([hx, hy], which) => {
          const d = Math.hypot(hx - x, hy - y);
          if (d <= 5 && (!best || d < best.d)) best = { index: i, which, d };
        });
      }
      return best;
    }
    // Dragging a bezier handle: x stays inside the segment (0..1), y may overshoot (-1..2); live in one undo step.
    function dragHandle(e, entry, hit) {
      const node = entry.lane.el;
      const c = clipNow(entry.clipId);
      const list = (c.keyframes?.[entry.path] || []).map((k) => ({ ...k, h: k.h?.slice() }));
      const r = node.getBoundingClientRect();
      const s = segment(c, list, hit.index, r.width, r.height);
      node.setPointerCapture(e.pointerId);
      picked.clear();
      picked.add(`${c.id}|${entry.path}|${s.a.t}`);
      let open = false;
      const move = (ev) => {
        const u = Math.max(0, Math.min(1, (ev.clientX - r.left - s.xa) / Math.max(1, s.xb - s.xa)));
        const p = Math.max(-1, Math.min(2, s.pOf(ev.clientY - r.top)));
        const next = list.map((k) => ({ ...k, h: k.h?.slice() }));
        const k = next[hit.index];
        k.h = (k.h || K.handles(k)).slice();
        k.h[hit.which * 2] = Math.round(u * 1000) / 1000;
        k.h[hit.which * 2 + 1] = Math.round(p * 1000) / 1000;
        if (open) app.history.cancel();
        app.history.begin('Keyframes');
        open = true;
        try { app.history.do(C.setKeyframes(seq().id, c.id, entry.path, next.map(({ h: hh, ...rest }) => (rest.ease === 'bezier' ? { ...rest, h: hh } : rest)))); } catch (err) { ui.toast(ui.errorText(err)); }
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('lostpointercapture', up);
        if (open) app.history.commit();
        drawLanes();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('lostpointercapture', up);
      drawLanes();
    }
    function laneEvents(entry) {
      const node = entry.lane.el;
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const c = clipNow(entry.clipId);
        if (!c) return;
        e.preventDefault();
        const r = node.getBoundingClientRect();
        const x = e.clientX - r.left;
        const hh = handleAt(entry, x, e.clientY - r.top);
        if (hh) { dragHandle(e, entry, hh); return; }
        const k = keyAt(entry, x);
        const f = time.frameTicks(fps());
        if (!k) {
          if (!e.shiftKey) picked.clear();
          const t = laneT(c, r.width, x);
          app.setTime(c.start + Math.max(0, Math.min(model.clipDuration(c) - f, Math.round(t / f) * f)));
          drawLanes();
          return;
        }
        const id = `${c.id}|${entry.path}|${k.t}`;
        if (e.shiftKey) { if (picked.has(id)) picked.delete(id); else picked.add(id); } else if (!picked.has(id)) { picked.clear(); picked.add(id); }
        drawLanes();
        // drag the picked keyframes of this clip
        node.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const plan = new Map(); // path -> [times picked]
        for (const p of picked) {
          const [cid, path, t] = p.split('|');
          if (cid !== c.id) continue;
          if (!plan.has(path)) plan.set(path, []);
          plan.get(path).push(Number(t));
        }
        const base = Object.fromEntries([...plan.keys()].map((p) => [p, (c.keyframes?.[p] || []).map((x2) => ({ ...x2 }))]));
        let moved = false;
        let open = false;
        let lastD = 0;
        const move = (ev) => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          const d = Math.round(((dx / Math.max(1, r.width - 12)) * model.clipDuration(c)) / f) * f;
          if (d === lastD && open) return;
          lastD = d;
          if (!open) { app.history.begin('Keyframes'); open = true; } else { app.history.cancel(); app.history.begin('Keyframes'); }
          const D = model.clipDuration(c);
          try {
            for (const [p, times] of plan) {
              const moving = new Set(times);
              const kept = base[p].filter((x2) => !moving.has(x2.t));
              let list = kept;
              for (const x2 of base[p].filter((y) => moving.has(y.t))) list = K.insert(list, { ...x2, t: Math.max(0, Math.min(D - f, x2.t + d)) });
              app.history.do(C.setKeyframes(seq().id, c.id, p, list));
            }
          } catch (err) { ui.toast(ui.errorText(err)); }
        };
        const up = () => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.removeEventListener('lostpointercapture', up);
          if (open) {
            app.history.commit();
            picked.clear();
            for (const [p, times] of plan) for (const t of times) picked.add(`${c.id}|${p}|${Math.max(0, t + lastD)}`);
          }
          drawLanes();
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('lostpointercapture', up);
      });
      node.addEventListener('dblclick', (e) => {
        const c = clipNow(entry.clipId);
        const k = c && keyAt(entry, e.clientX - node.getBoundingClientRect().left);
        if (k) app.setTime(c.start + k.t);
      });
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const c = clipNow(entry.clipId);
        if (!c) return;
        const k = keyAt(entry, e.clientX - node.getBoundingClientRect().left);
        if (k) {
          const id = `${c.id}|${entry.path}|${k.t}`;
          if (!picked.has(id)) { picked.clear(); picked.add(id); drawLanes(); }
        }
        const sel = pickedOf(c);
        ui.menu(e.clientX, e.clientY, [
          ...EASES.map(([ease, label]) => ({ label: tr(label), disabled: !sel.length, checked: sel.length > 0 && sel.every((x) => x.k.ease === ease), run: () => setEase(c, sel, ease) })),
          { separator: true },
          { label: tr('Copy'), disabled: !sel.length, run: () => { const t0 = Math.min(...sel.map((x) => x.k.t)); kfClipboard = sel.map((x) => ({ path: x.path, t: x.k.t - t0, v: x.k.v, ease: x.k.ease, h: x.k.h })); } },
          { label: tr('Paste'), disabled: !kfClipboard?.length, run: () => pasteKeys(c) },
          { label: tr('Delete'), disabled: !sel.length, run: () => deleteKeys(c, sel) },
        ]);
      });
    }
    function pickedOf(c) {
      const out = [];
      for (const p of picked) {
        const [cid, path, t] = p.split('|');
        if (cid !== c.id) continue;
        const k = (c.keyframes?.[path] || []).find((x) => x.t === Number(t));
        if (k) out.push({ path, k });
      }
      return out;
    }
    function groupByPath(sel) {
      const m = new Map();
      for (const x of sel) { if (!m.has(x.path)) m.set(x.path, []); m.get(x.path).push(x.k.t); }
      return m;
    }
    function setEase(c, sel, ease) {
      app.history.begin('Keyframes');
      try {
        for (const [p, times] of groupByPath(sel)) {
          app.history.do(C.setKeyframes(seq().id, c.id, p, edit.easeList(c.keyframes[p], times, ease)));
        }
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    }
    function deleteKeys(c, sel) {
      app.history.begin('Keyframes');
      try {
        for (const [p, times] of groupByPath(sel)) {
          const set = new Set(times);
          const left = c.keyframes[p].filter((k) => !set.has(k.t));
          app.history.do(C.setKeyframes(seq().id, c.id, p, left.length ? left : null));
        }
        app.history.commit();
        picked.clear();
      } catch (err) { app.history.cancel(); ui.report(err); }
    }
    function pasteKeys(c) {
      const t0 = edit.clipTime(app, c);
      const D = model.clipDuration(c);
      app.history.begin('Keyframes');
      try {
        const byPath = new Map();
        for (const k of kfClipboard) { if (!byPath.has(k.path)) byPath.set(k.path, []); byPath.get(k.path).push(k); }
        for (const [p, list] of byPath) {
          if (!model.validPropPath(c, edit.kindOf(seq(), c), p)) continue;
          let next = c.keyframes?.[p] || [];
          for (const k of list) if (t0 + k.t < D) next = K.insert(next, { t: t0 + k.t, v: k.v, ease: k.ease, h: k.h });
          app.history.do(C.setKeyframes(seq().id, c.id, p, next));
        }
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    }

    // effects dropped here go on the clip shown; effect sections dragged by their header change the order
    offs.push(ui.dnd.target(root, {
      accepts: (p) => (p?.kind === 'effect' && subject?.kind === 'clip') || (p?.kind === 'effectOrder' && subject?.kind === 'clip' && p.clipId === subject.clipId) || (p?.kind === 'transition' && subject?.kind === 'transition'),
      over(p) { root.classList.add('drop'); void p; },
      leave() { root.classList.remove('drop'); },
      drop(p, e) {
        root.classList.remove('drop');
        const c = subjectClip();
        if (p.kind === 'transition' && subject?.kind === 'transition') { ui.exec(app, C.setTransition(seq().id, subject.id, { type: p.type })); return; }
        if (!c) return;
        if (p.kind === 'effect') { ui.timeline.applyEffect?.(c.id, p.type) ?? ui.exec(app, C.addEffect(seq().id, c.id, p.type)); return; }
        // the new index: how many of the other effects sit above the pointer
        const others = [...body.querySelectorAll('.cut-ec-sec[data-section^="fx:"]')]
          .filter((s) => s.dataset.section.startsWith(`fx:${c.id}:`) && s.dataset.section !== `fx:${c.id}:${p.effectId}`);
        const index = others.filter((s) => { const r = s.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
        const from = c.effects.findIndex((x) => x.id === p.effectId);
        if (from >= 0 && index !== from) ui.exec(app, C.moveEffect(seq().id, c.id, p.effectId, index));
      },
    }));

    // Keys in the panel: Delete removes picked keyframes.
    root.addEventListener('keydown', (e) => {
      if (ui.isTyping(e.target)) return;
      const c = subjectClip();
      if (c && (e.key === 'Delete' || e.key === 'Backspace') && pickedOf(c).length) { e.preventDefault(); e.stopPropagation(); deleteKeys(c, pickedOf(c)); }
    });
    offs.push(ui.onAction('delete', () => { const c = subjectClip(); if (!c || !pickedOf(c).length) return false; deleteKeys(c, pickedOf(c)); return true; }, { panels: ['controls'] }));
    offs.push(ui.onAction('copy', () => { const c = subjectClip(); const sel = c ? pickedOf(c) : []; if (!sel.length) return false; const t0 = Math.min(...sel.map((x) => x.k.t)); kfClipboard = sel.map((x) => ({ path: x.path, t: x.k.t - t0, v: x.k.v, ease: x.k.ease, h: x.k.h })); return true; }, { panels: ['controls'] }));
    offs.push(ui.onAction('paste', () => { const c = subjectClip(); if (!c || !kfClipboard?.length) return false; pasteKeys(c); return true; }, { panels: ['controls'] }));

    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); }); };
    offs.push(app.on('project', later));
    offs.push(app.on('selection', () => { picked.clear(); later(); }));
    offs.push(app.on('sequence', later));
    offs.push(app.on('transitionSelection', later));
    offs.push(app.on('time', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; for (const r of rows) r.update?.(); drawLanes(); drawLaneRuler(); }); }));
    const ro = ide.util.observeSize(root, () => { drawLanes(); drawLaneRuler(); });
    offs.push(() => ro.disconnect());
    offs.push(() => cancelAnimationFrame(raf));
    refresh();
    // For tests: the client point of a lane's keyframe, or of a bezier handle of the segment leaving it.
    const lanePoint = (path, t, which = null) => {
      const r = rows.find((x) => x.lane && x.path === path);
      const c = r && clipNow(r.clipId);
      if (!c) return null;
      const box = r.lane.el.getBoundingClientRect();
      const list = c.keyframes?.[path] || [];
      const i = list.findIndex((k) => k.t === t);
      if (i < 0) return null;
      if (which === null) return { x: box.left + laneX(c, box.width, t), y: box.top + box.height / 2 };
      const s = segment(c, list, i, box.width, box.height);
      const pt = s?.pts?.[which];
      return pt ? { x: box.left + pt[0], y: box.top + pt[1], shown: !!s.handles } : null;
    };
    ui.controls = { refresh, lanePoint, get subject() { return subject; }, get picked() { return [...picked]; } };
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); },
    };
  }

  ui.registerPanel('controls', { title: () => tr('Effect Controls'), mount });
})();
