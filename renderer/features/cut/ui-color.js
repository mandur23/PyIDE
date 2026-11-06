// The color panel of Nano Studio Cut (video-editor-features.md section 10): the basic correction of the selected video
// clip, which is its `color.basic` effect (added at the end of the effect list the first time a control moves), and
// the vignette (the `vignette` effect). White balance has an eyedropper: a click on the program monitor picks a pixel
// that should be white or gray, and temperature and tint are set so it becomes neutral; Auto (ui-auto.js) sets them and
// the exposure from the whole picture. A slider drag is one undo step;
// values are those at the playhead when a parameter has keyframes.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const edit = ui.edit;
  const el = ui.el;

  // Used when the registry is not there yet; the registry's own definitions win.
  const BASIC = [
    ['White Balance', [['temperature', 'Temperature', -100, 100, 1], ['tint', 'Tint', -100, 100, 1]]],
    ['Tone', [['exposure', 'Exposure', -4, 4, 0.01], ['contrast', 'Contrast', -100, 100, 1], ['highlights', 'Highlights', -100, 100, 1],
      ['shadows', 'Shadows', -100, 100, 1], ['whites', 'Whites', -100, 100, 1], ['blacks', 'Blacks', -100, 100, 1]]],
    ['', [['saturation', 'Saturation', 0, 200, 1], ['vibrance', 'Vibrance', -100, 100, 1]]],
  ];
  const VIGNETTE = [['amount', 'Amount', -100, 100, 1], ['midpoint', 'Midpoint', 0, 100, 1], ['roundness', 'Roundness', -100, 100, 1], ['feather', 'Feather', 0, 100, 1]];
  const svg = (body) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const DROPPER = svg('<path d="m9.5 3.5 3 3M3 13l1-3 5.5-5.5 2 2L6 12z" stroke="currentColor" stroke-width="1.3"/><path d="m10.5 2.5 1-1a1.4 1.4 0 0 1 2 2l-1 1" stroke="currentColor" stroke-width="1.3"/>');

  // Temperature and tint that make the picked color neutral. The color was seen through the clip's current correction;
  // its white balance gains multiply, so the answer is the current temperature and tint plus the engine's solve
  // (Cut.effects.whiteBalance) for the color as seen. Saturation and contrast are undone first; the rest of the
  // correction keeps a gray gray.
  function whiteBalance(rgb, p) {
    const fx = Cut.effects;
    if (!fx?.whiteBalance) return null;
    let c = rgb.map((v) => Math.max(1e-5, fx.srgbToLinear(v / 255)));
    const L = fx.LUMA;
    const sat = (p.saturation ?? 100) / 100;
    if (sat > 0.01 && sat !== 1) {
      const y = c[0] * L[0] + c[1] * L[1] + c[2] * L[2];
      c = c.map((x) => Math.max(1e-5, y + (x - y) / sat));
    }
    const k = 1 + (p.contrast || 0) / 100;
    if (k !== 1) c = c.map((x) => 0.18 * (x / 0.18) ** (1 / k));
    const d = fx.whiteBalance(c);
    const clamp = (x) => Math.max(-100, Math.min(100, Math.round(x * 10) / 10));
    return { temperature: clamp((p.temperature || 0) + d.temperature), tint: clamp((p.tint || 0) + d.tint) };
  }

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-color');
    const head = el('div', 'cut-color-head');
    const title = el('span', 'cut-color-title');
    title.dataset.userText = '';
    const onBox = el('label', 'cut-color-on');
    const onCheck = el('input', null, undefined, { type: 'checkbox' });
    onBox.append(onCheck, el('span', null, tr('Basic Correction')));
    const resetBtn = el('button', 'cut-btn', tr('Reset'), { type: 'button' });
    resetBtn.addEventListener('mousedown', (e) => e.preventDefault());
    head.append(title, onBox, resetBtn);
    const body = el('div', 'cut-color-body');
    const hint = el('div', 'cut-color-hint');
    root.append(head, hint, body);
    host.appendChild(root);

    const seq = () => app.sequence;
    let clipId = null;
    const clip = () => (clipId ? edit.clipById(seq(), clipId) : null);
    const effectOf = (type) => clip()?.effects.find((e) => e.type === type) || null;
    const paramsOf = (type) => {
      const c = clip();
      const e = effectOf(type);
      const base = Cut.effects?.defaults?.(type) || {};
      if (!c || !e) return base;
      const out = { ...base };
      for (const k of Object.keys(base)) out[k] = edit.valueAt(app, c, `effects.${e.id}.${k}`);
      return out;
    };
    // The effect, added at the end of the list when the clip has none (inside the caller's undo group).
    function ensure(type) {
      const e = effectOf(type);
      if (e) return e;
      const r = app.history.do(C.addEffect(seq().id, clipId, type));
      return clip().effects.find((x) => x.id === r.id);
    }
    function set(type, values) {
      const c = clip();
      if (!c) return;
      const grouped = app.history.grouping;
      if (!grouped) app.history.begin('Color');
      try {
        const e = ensure(type);
        for (const [k, v] of Object.entries(values)) {
          const r = edit.write(app, clip(), `effects.${e.id}.${k}`, v);
          if (r === null) throw new Error('write failed');
        }
        if (!grouped) app.history.commit();
      } catch (err) {
        if (!grouped) app.history.cancel();
        if (err.message !== 'write failed') ui.report(err);
      }
    }

    const controls = []; // {type, id, slider, field, row}
    function paramDef(type, id, fb) {
      const p = edit.paramDef(type, id);
      return p ? { min: p.min, max: p.max, step: p.step || 1, name: p.name, def: p.default } : { min: fb[2], max: fb[3], step: fb[4], name: fb[1], def: 0 };
    }
    function group(name, type, specs) {
      const g = el('div', 'cut-color-group', undefined, { 'data-group': name || type });
      if (name) g.appendChild(el('div', 'cut-color-gname', tr(name)));
      for (const fb of specs) {
        const id = fb[0];
        const d = paramDef(type, id, fb);
        const row = el('div', 'cut-color-row', undefined, { 'data-param': id, 'data-effect': type });
        const label = el('span', 'cut-color-label', tr(d.name));
        label.title = tr('Double-click to reset');
        const gesture = edit.gesture(app, 'Color');
        const slider = ui.slider({ min: d.min, max: d.max, step: d.step, value: d.def, cls: 'cut-color-slider',
          onBegin: () => gesture.begin(), onEnd: () => gesture.end(), onInput: (v) => { set(type, { [id]: v }); field.value = v; } });
        const precision = d.step < 1 ? String(d.step).split('.')[1].length : 0;
        const field = ui.numberField({ value: d.def, min: d.min, max: d.max, step: d.step, precision,
          onBegin: () => gesture.begin(), onEnd: () => gesture.end(), onChange: (v) => { set(type, { [id]: v }); slider.value = String(v); } });
        label.addEventListener('dblclick', () => { const def = Cut.effects?.defaults?.(type)?.[id] ?? d.def; set(type, { [id]: def }); });
        row.append(label, slider, field);
        g.appendChild(row);
        controls.push({ type, id, slider, field, row });
      }
      body.appendChild(g);
      return g;
    }
    const wbGroup = group(BASIC[0][0], 'color.basic', BASIC[0][1]);
    const dropper = el('button', 'cut-color-dropper', undefined, { type: 'button', title: tr('White Balance Selector: click something white or gray in the program monitor'), 'aria-pressed': 'false' });
    dropper.innerHTML = DROPPER;
    dropper.addEventListener('mousedown', (e) => e.preventDefault());
    dropper.addEventListener('click', () => pick());
    wbGroup.querySelector('.cut-color-gname').appendChild(dropper);
    // Auto (ui-auto.js): white balance and exposure from the clip's picture at the playhead.
    const autoBtn = el('button', 'cut-btn cut-color-auto', tr('Auto'), { type: 'button', title: tr('Auto Color: neutral white balance and mid-grey exposure from the picture at the playhead') });
    autoBtn.addEventListener('mousedown', (e) => e.preventDefault());
    autoBtn.addEventListener('click', () => { ui.auto?.autoColor(app); });
    autoBtn.hidden = !ui.auto;
    wbGroup.querySelector('.cut-color-gname').appendChild(autoBtn);
    group(BASIC[1][0], 'color.basic', BASIC[1][1]);
    group(BASIC[2][0], 'color.basic', BASIC[2][1]);
    const vig = group('Vignette', 'vignette', VIGNETTE);
    void vig;

    async function pick() {
      if (!clip()) return;
      if (!ui.overlay?.pickColor) { ui.toast(tr('The program monitor is not open.')); return; }
      dropper.setAttribute('aria-pressed', 'true');
      let rgb = null;
      try { rgb = await ui.overlay.pickColor(); } finally { dropper.setAttribute('aria-pressed', 'false'); }
      if (!rgb || !clip()) return;
      const wb = whiteBalance(rgb, paramsOf('color.basic'));
      if (wb) set('color.basic', wb);
    }

    onCheck.addEventListener('change', () => {
      const e = effectOf('color.basic');
      if (e) ui.exec(app, C.setEffect(seq().id, clipId, e.id, { on: onCheck.checked }));
      else if (onCheck.checked) set('color.basic', {});
    });
    resetBtn.addEventListener('click', () => {
      const c = clip();
      if (!c) return;
      app.history.begin('Color');
      try {
        for (const type of ['color.basic', 'vignette']) {
          const e = effectOf(type);
          if (!e) continue;
          for (const k of Object.keys(c.keyframes)) if (k.startsWith(`effects.${e.id}.`)) app.history.do(C.setKeyframes(seq().id, c.id, k, null));
          app.history.do(C.setEffect(seq().id, c.id, e.id, { params: Object.fromEntries(Object.keys(e.params).map((k) => [k, null])) }));
        }
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    });

    function refresh() {
      const s = seq();
      const c = s ? edit.primaryClip(app) : null;
      const ok = c && edit.kindOf(s, c) === 'video';
      clipId = ok ? c.id : null;
      root.classList.toggle('disabled', !ok);
      title.textContent = ok ? c.name || Cut.model.mediaOf(app.project, c)?.name || tr('Clip') : '';
      hint.textContent = ok ? '' : tr('Select a video clip in the timeline to correct its color.');
      hint.hidden = !!ok;
      const basic = ok ? effectOf('color.basic') : null;
      onCheck.checked = !!basic && basic.on !== false;
      onCheck.disabled = !ok;
      resetBtn.disabled = !ok;
      dropper.disabled = !ok;
      autoBtn.disabled = !ok || Cut.model.mediaOf(app.project, c)?.kind == null;
      const vals = { 'color.basic': paramsOf('color.basic'), vignette: paramsOf('vignette') };
      for (const ctl of controls) {
        const v = vals[ctl.type][ctl.id];
        ctl.slider.disabled = !ok;
        ctl.field.disabled = !ok;
        if (typeof v === 'number') {
          if (!ctl.field.querySelector('input')) ctl.field.value = v;
          if (document.activeElement !== ctl.slider || !app.history.grouping) ctl.slider.value = String(v);
        }
        const e = ok ? effectOf(ctl.type) : null;
        ctl.row.classList.toggle('keyframed', !!e && edit.keyframed(clip(), `effects.${e.id}.${ctl.id}`));
      }
    }
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); }); };
    offs.push(app.on('project', later), app.on('selection', later), app.on('sequence', later), app.on('time', later));
    offs.push(() => cancelAnimationFrame(raf));
    refresh();
    return { dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); } };
  }

  ui.color = { whiteBalance };
  ui.registerPanel('color', { title: () => tr('Color'), mount });
})();
