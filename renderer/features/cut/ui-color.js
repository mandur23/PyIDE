// The Lumetri Color panel of Nano Studio Cut (video-editor-features.md section 10), laid out as Premiere's: collapsible
// sections that all edit one effect of the selected video clip, its Lumetri Color (`color.basic`, added at the end of
// the effect list the first time a control moves), plus the vignette (the `vignette` effect).
// - Basic Correction: white balance (with an eyedropper: a click on the program monitor picks a pixel that should be
//   white or gray, and temperature and tint are set so it becomes neutral; Auto, ui-auto.js, sets them and the
//   exposure from the whole picture), tone, saturation and vibrance.
// - Creative: the Look, a .cube LUT loaded through the dialog (cut:pickLut, read with cut:read, parsed by
//   Cut.lumetri.parseCube and kept in the project with commands.addLut, so the project opens on any PC), and its
//   intensity. A file that is not a usable LUT is refused with the reason, in the section and as a notification.
// - Curves: RGB curves, master and one per channel, edited on a square: a press adds a point and drags it, a press
//   on a point drags it, Ctrl+click removes one, a double click on the square straightens the channel.
// - HSL Secondary: a hue, saturation and luma qualifier (an eyedropper sets it around a picked color), Show Mask, and
//   the correction applied inside it.
// A slider or curve drag is one undo step; values are those at the playhead when a parameter has keyframes.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const edit = ui.edit;
  const el = ui.el;
  const LUMETRI = 'color.basic';
  const LUT_LIMIT = 64 * 1024 * 1024;

  // Used when the registry is not there yet; the registry's own definitions win.
  const BASIC = [
    ['White Balance', [['temperature', 'Temperature', -100, 100, 1], ['tint', 'Tint', -100, 100, 1]]],
    ['Tone', [['exposure', 'Exposure', -4, 4, 0.01], ['contrast', 'Contrast', -100, 100, 1], ['highlights', 'Highlights', -100, 100, 1],
      ['shadows', 'Shadows', -100, 100, 1], ['whites', 'Whites', -100, 100, 1], ['blacks', 'Blacks', -100, 100, 1]]],
    ['', [['saturation', 'Saturation', 0, 200, 1], ['vibrance', 'Vibrance', -100, 100, 1]]],
  ];
  const HSL_KEY = [['hslHue', 'Hue Center', 0, 360, 1], ['hslHueRange', 'Hue Range', 0, 360, 1], ['hslHueSoft', 'Hue Softness', 0, 180, 1],
    ['hslSatLow', 'Saturation Low', 0, 100, 1], ['hslSatHigh', 'Saturation High', 0, 100, 1], ['hslSatSoft', 'Saturation Softness', 0, 100, 1],
    ['hslLumLow', 'Luma Low', 0, 100, 1], ['hslLumHigh', 'Luma High', 0, 100, 1], ['hslLumSoft', 'Luma Softness', 0, 100, 1]];
  const HSL_FIX = [['hslTemperature', 'Temperature', -100, 100, 1], ['hslTint', 'Tint', -100, 100, 1], ['hslContrast', 'Contrast', -100, 100, 1],
    ['hslSaturation', 'Saturation', 0, 200, 1], ['hslHueShift', 'Hue Shift', -180, 180, 1]];
  const VIGNETTE = [['amount', 'Amount', -100, 100, 1], ['midpoint', 'Midpoint', 0, 100, 1], ['roundness', 'Roundness', -100, 100, 1], ['feather', 'Feather', 0, 100, 1]];
  // The curve channels: param, name, the color its line is drawn in.
  const CHANNELS = [['curveMaster', 'Master', '#e6e6e6'], ['curveRed', 'Red', '#ff5a5a'], ['curveGreen', 'Green', '#4fd16a'], ['curveBlue', 'Blue', '#5a96ff']];
  const SECTIONS = [['basic', 'Basic Correction'], ['creative', 'Creative'], ['curves', 'Curves'], ['hsl', 'HSL Secondary'], ['vignette', 'Vignette']];
  const PAD = 8; // CSS pixels between the curve square's edge and its 0..1 area
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

  // A .cube file's text -> { id, entry } for commands.addLut; throws the parser's refusal (err.code 'lut').
  async function readLut(path) {
    const st = await ide.api.invoke('cut:stat', path);
    if (!st || st.missing || st.error) { const e = new Error('The LUT file cannot be read.'); e.code = 'lut'; throw e; }
    if (st.size > LUT_LIMIT) { const e = new Error('The LUT file is too large (at most 64 MB).'); e.code = 'lut'; throw e; }
    const bytes = await ide.api.invoke('cut:read', path, 0, st.size);
    if (!bytes || bytes.error) { const e = new Error('The LUT file cannot be read.'); e.code = 'lut'; throw e; }
    const text = new TextDecoder('utf-8').decode(bytes);
    const lut = Cut.lumetri.parseCube(text);
    const name = String(path).split(/[\\/]/).pop();
    return Cut.lumetri.store(lut, name);
  }

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-color cut-lumetri');
    const head = el('div', 'cut-color-head');
    const title = el('span', 'cut-color-title');
    title.dataset.userText = '';
    const onBox = el('label', 'cut-color-on');
    const onCheck = el('input', null, undefined, { type: 'checkbox' });
    onBox.append(onCheck, el('span', null, tr('Lumetri Color')));
    const resetBtn = el('button', 'cut-btn', tr('Reset'), { type: 'button', title: tr('Reset every section') });
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
    function set(type, values, label = 'Color') {
      const c = clip();
      if (!c) return;
      const grouped = app.history.grouping;
      if (!grouped) app.history.begin(label);
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
    // Resets some parameters of an effect (their keyframes too) in one step.
    function resetParams(type, ids, label = 'Reset') {
      const c = clip();
      const e = effectOf(type);
      if (!c || !e) return;
      app.history.begin(label);
      try {
        for (const k of ids) {
          if (c.keyframes[`effects.${e.id}.${k}`]) app.history.do(C.setKeyframes(seq().id, c.id, `effects.${e.id}.${k}`, null));
        }
        app.history.do(C.setEffect(seq().id, c.id, e.id, { params: Object.fromEntries(ids.map((k) => [k, null])) }));
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    }

    // ---------- sections ----------
    const collapsed = new Set(ide.settings.get('cut.color.collapsed', ['vignette']) || []);
    const sections = {};
    function section(id, name, resetIds) {
      const sec = el('div', `cut-lm-sec${collapsed.has(id) ? ' collapsed' : ''}`, undefined, { 'data-section': id });
      const top = el('div', 'cut-lm-sechead');
      const tw = el('button', 'cut-lm-twisty', undefined, { type: 'button', 'aria-expanded': String(!collapsed.has(id)), title: tr(name) });
      tw.addEventListener('mousedown', (e) => e.preventDefault());
      const label = el('span', 'cut-lm-secname', tr(name));
      top.append(tw, label);
      const toggle = () => {
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        sec.classList.toggle('collapsed', collapsed.has(id));
        tw.setAttribute('aria-expanded', String(!collapsed.has(id)));
        ide.settings.set('cut.color.collapsed', [...collapsed]);
        if (!collapsed.has(id)) later();
      };
      tw.addEventListener('click', toggle);
      label.addEventListener('click', toggle);
      if (resetIds) {
        const r = el('button', 'cut-lm-reset', tr('Reset'), { type: 'button', title: tr('Reset {name}', { name: tr(name) }) });
        r.addEventListener('mousedown', (e) => e.preventDefault());
        r.addEventListener('click', () => resetIds());
        top.appendChild(r);
        sections[id] = { reset: r };
      }
      const content = el('div', 'cut-lm-content');
      sec.append(top, content);
      body.appendChild(sec);
      sections[id] = { ...(sections[id] || {}), el: sec, content };
      return content;
    }

    const controls = []; // {type, id, slider, field, row}
    function paramDef(type, id, fb) {
      const p = edit.paramDef(type, id);
      return p ? { min: p.min, max: p.max, step: p.step || 1, name: p.name, def: p.default } : { min: fb[2], max: fb[3], step: fb[4], name: fb[1], def: 0 };
    }
    function group(parent, name, type, specs) {
      const g = el('div', 'cut-color-group', undefined, { 'data-group': name || type });
      if (name) g.appendChild(el('div', 'cut-color-gname', tr(name)));
      for (const fb of specs) {
        const id = fb[0];
        const d = paramDef(type, id, fb);
        const row = el('div', 'cut-color-row', undefined, { 'data-param': id, 'data-effect': type });
        const label = el('span', 'cut-color-label', tr(fb[1] || d.name));
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
      parent.appendChild(g);
      return g;
    }
    const basicIds = BASIC.flatMap((g) => g[1].map((s) => s[0]));
    const L = Cut.lumetri;

    // Basic Correction
    const basicBox = section('basic', 'Basic Correction', () => resetParams(LUMETRI, basicIds));
    const wbGroup = group(basicBox, BASIC[0][0], LUMETRI, BASIC[0][1]);
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
    group(basicBox, BASIC[1][0], LUMETRI, BASIC[1][1]);
    group(basicBox, BASIC[2][0], LUMETRI, BASIC[2][1]);

    // Creative: the Look
    const creative = section('creative', 'Creative', () => resetParams(LUMETRI, ['lut', 'lutIntensity']));
    const lookRow = el('div', 'cut-color-row cut-lm-look', undefined, { 'data-param': 'lut' });
    const lookSel = ui.select({ options: [{ value: '', label: tr('None') }], value: '', cls: 'cut-lm-lutsel', title: tr('Look') });
    const browse = el('button', 'cut-btn cut-lm-browse', tr('Browse…'), { type: 'button', title: tr('Load a .cube LUT') });
    browse.addEventListener('mousedown', (e) => e.preventDefault());
    lookRow.append(el('span', 'cut-color-label', tr('Look')), lookSel, browse);
    const lookInfo = el('div', 'cut-lm-lutinfo');
    const lookError = el('div', 'cut-lm-luterror', undefined, { role: 'alert' });
    lookError.hidden = true;
    creative.append(lookRow, lookInfo, lookError);
    group(creative, '', LUMETRI, [['lutIntensity', 'Intensity', 0, 100, 1]]);
    lookSel.addEventListener('change', () => { lookError.hidden = true; set(LUMETRI, { lut: lookSel.value }); });
    browse.addEventListener('click', () => loadLut());
    async function loadLut() {
      if (!clip()) return;
      const path = await ide.api.invoke('cut:pickLut', { title: tr('Load LUT'), filterName: tr('Cube LUT'), allName: tr('All files') });
      if (!path || !clip()) return;
      let stored;
      try {
        stored = await readLut(path);
      } catch (err) {
        const text = err?.code === 'lut' ? tr(err.message, err.params) : tr('The LUT file cannot be read.');
        lookError.textContent = `${String(path).split(/[\\/]/).pop()}: ${text}`;
        lookError.hidden = false;
        ui.notify(text, { kind: 'warn', title: tr('Load LUT') });
        return;
      }
      if (!clip()) return;
      lookError.hidden = true;
      app.history.begin('Load LUT');
      try {
        app.history.do(C.addLut(stored));
        set(LUMETRI, { lut: stored.id });
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    }

    // Curves
    const curvesBox = section('curves', 'Curves', () => resetParams(LUMETRI, CHANNELS.map((c) => c[0])));
    curvesBox.appendChild(el('div', 'cut-color-gname', tr('RGB Curves')));
    const chanBar = el('div', 'cut-lm-channels', undefined, { role: 'radiogroup', 'aria-label': tr('Curve Channel') });
    let channel = 0;
    const chanBtns = CHANNELS.map(([param, name, color], i) => {
      const b = el('button', 'cut-lm-chan', undefined, { type: 'button', role: 'radio', 'aria-checked': String(i === 0), title: tr(name), 'data-channel': param });
      b.style.setProperty('--chan', color);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { channel = i; for (const [k, x] of chanBtns.entries()) x.setAttribute('aria-checked', String(k === i)); drawCurve(); });
      chanBar.appendChild(b);
      return b;
    });
    curvesBox.appendChild(chanBar);
    const curveWrap = el('div', 'cut-lm-curvewrap');
    const curveCanvas = el('canvas', 'cut-lm-curve', undefined, { 'data-pad': String(PAD), tabindex: '-1' });
    curveWrap.appendChild(curveCanvas);
    curvesBox.appendChild(curveWrap);
    curvesBox.appendChild(el('div', 'cut-lm-note', tr('Click to add a point and drag it; Ctrl+click removes a point; double-click straightens the curve.')));
    const curveOf = (i) => L.points(paramsOf(LUMETRI)[CHANNELS[i][0]]);
    function curveSpace() {
      const r = curveCanvas.getBoundingClientRect();
      const w = r.width - 2 * PAD;
      const h = r.height - 2 * PAD;
      return { r, w, h, toPx: ([x, y]) => [r.left + PAD + x * w, r.top + PAD + (1 - y) * h], fromPx: (cx, cy) => [(cx - r.left - PAD) / w, 1 - (cy - r.top - PAD) / h] };
    }
    function drawCurve() {
      const dpr = globalThis.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(curveCanvas.clientWidth * dpr));
      const ch = Math.max(1, Math.round(curveCanvas.clientHeight * dpr));
      if (curveCanvas.width !== cw || curveCanvas.height !== ch) { curveCanvas.width = cw; curveCanvas.height = ch; }
      const g = curveCanvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = curveCanvas.clientWidth;
      const H = curveCanvas.clientHeight;
      const w = W - 2 * PAD;
      const h = H - 2 * PAD;
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#141518';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const x = PAD + (k * w) / 4;
        const y = PAD + (k * h) / 4;
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, PAD); g.lineTo(Math.round(x) + 0.5, PAD + h); g.stroke();
        g.beginPath(); g.moveTo(PAD, Math.round(y) + 0.5); g.lineTo(PAD + w, Math.round(y) + 0.5); g.stroke();
      }
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.moveTo(PAD, PAD + h); g.lineTo(PAD + w, PAD); g.stroke();
      const line = (pts, color, width) => {
        const m = L.slopes(pts);
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        for (let i = 0; i <= 128; i++) {
          const x = i / 128;
          const y = L.evalCurve(pts, x, m);
          if (i) g.lineTo(PAD + x * w, PAD + (1 - y) * h); else g.moveTo(PAD + x * w, PAD + (1 - y) * h);
        }
        g.stroke();
      };
      CHANNELS.forEach((c, i) => { if (i !== channel && !L.isIdentityCurve(paramsOf(LUMETRI)[c[0]])) line(curveOf(i), `${c[2]}66`, 1); });
      const pts = curveOf(channel);
      line(pts, CHANNELS[channel][2], 1.6);
      for (const [i, p] of pts.entries()) {
        g.fillStyle = i === dragIndex ? '#ffffff' : CHANNELS[channel][2];
        g.fillRect(PAD + p[0] * w - 3.5, PAD + (1 - p[1]) * h - 3.5, 7, 7);
      }
      curveCanvas.dataset.points = String(pts.length);
    }
    let dragIndex = -1;
    let added = null; // the point the last press added: { at, moved }
    const curveGesture = edit.gesture(app, 'Curves');
    const writeCurve = (pts) => set(LUMETRI, { [CHANNELS[channel][0]]: L.flatten(pts) }, 'Curves');
    curveCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !clip()) return;
      e.preventDefault();
      const sp = curveSpace();
      const pts = curveOf(channel);
      let hit = -1;
      let best = 10;
      pts.forEach((p, i) => { const [px, py] = sp.toPx(p); const d = Math.hypot(px - e.clientX, py - e.clientY); if (d <= best) { best = d; hit = i; } });
      if (e.ctrlKey) {
        added = null;
        if (hit >= 0 && pts.length > 2) writeCurve(pts.filter((_, i) => i !== hit));
        return;
      }
      const [u, v] = sp.fromPx(e.clientX, e.clientY);
      curveGesture.begin();
      if (hit < 0) {
        if (pts.length >= L.MAX_POINTS) { curveGesture.end(); return; }
        const x = Math.max(0, Math.min(1, u));
        if (pts.some((p) => Math.abs(p[0] - x) < L.MIN_GAP)) { curveGesture.end(); return; }
        pts.push([x, Math.max(0, Math.min(1, v))]);
        pts.sort((a, b) => a[0] - b[0]);
        hit = pts.findIndex((p) => p[0] === x);
        writeCurve(pts);
        added = { at: performance.now(), moved: false };
      }
      dragIndex = hit;
      curveCanvas.setPointerCapture(e.pointerId);
      drawCurve();
    });
    curveCanvas.addEventListener('pointermove', (e) => {
      if (dragIndex < 0) return;
      const sp = curveSpace();
      const pts = curveOf(channel);
      if (!pts[dragIndex]) return;
      const [u, v] = sp.fromPx(e.clientX, e.clientY);
      const lo = dragIndex > 0 ? pts[dragIndex - 1][0] + L.MIN_GAP : 0;
      const hi = dragIndex < pts.length - 1 ? pts[dragIndex + 1][0] - L.MIN_GAP : 1;
      pts[dragIndex] = [Math.max(lo, Math.min(hi, u)), Math.max(0, Math.min(1, v))];
      if (added) added.moved = true;
      writeCurve(pts);
    });
    const endDrag = () => {
      if (dragIndex < 0) return;
      dragIndex = -1;
      curveGesture.end();
      drawCurve();
    };
    curveCanvas.addEventListener('pointerup', endDrag);
    curveCanvas.addEventListener('lostpointercapture', endDrag);
    // A double click straightens the channel; the point its first click added (and did not move) is taken back.
    curveCanvas.addEventListener('dblclick', () => {
      if (!clip()) return;
      if (added && !added.moved && performance.now() - added.at < 800) app.history.undo();
      added = null;
      writeCurve([[0, 0], [1, 1]]);
    });
    const ro = ide.util.observeSize(curveCanvas, () => drawCurve());
    offs.push(() => ro.disconnect());

    // HSL Secondary
    const hslBox = section('hsl', 'HSL Secondary', () => resetParams(LUMETRI, L.HSL_PARAMS));
    const keyGroup = group(hslBox, 'Key', LUMETRI, HSL_KEY.slice(0, 3));
    const hslDropper = el('button', 'cut-color-dropper cut-lm-hsldropper', undefined, { type: 'button', title: tr('Set the qualifier from a color: click it in the program monitor'), 'aria-pressed': 'false' });
    hslDropper.innerHTML = DROPPER;
    hslDropper.addEventListener('mousedown', (e) => e.preventDefault());
    hslDropper.addEventListener('click', () => pickKey());
    keyGroup.querySelector('.cut-color-gname').appendChild(hslDropper);
    const hueBar = el('canvas', 'cut-lm-huebar');
    keyGroup.insertBefore(hueBar, keyGroup.children[1]);
    group(hslBox, '', LUMETRI, HSL_KEY.slice(3));
    const maskRow = el('label', 'cut-lm-mask', undefined, { 'data-param': 'hslMask' });
    const maskCheck = el('input', null, undefined, { type: 'checkbox' });
    maskRow.append(maskCheck, el('span', null, tr('Show Mask')));
    maskCheck.addEventListener('change', () => set(LUMETRI, { hslMask: maskCheck.checked }));
    hslBox.appendChild(maskRow);
    group(hslBox, 'Correction', LUMETRI, HSL_FIX);
    function drawHueBar(p) {
      const dpr = globalThis.devicePixelRatio || 1;
      const W = hueBar.clientWidth;
      const H = hueBar.clientHeight;
      if (!W || !H) return;
      if (hueBar.width !== Math.round(W * dpr)) { hueBar.width = Math.round(W * dpr); hueBar.height = Math.round(H * dpr); }
      const g = hueBar.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let x = 0; x < W; x++) { g.fillStyle = `hsl(${(x / W) * 360}, 90%, 50%)`; g.fillRect(x, 0, 1, H); }
      // the qualified hues stay bright, the others are dimmed
      const q = L.hslPlan(p);
      for (let x = 0; x < W; x++) {
        const d = Math.abs(((x / W - q.hue + 0.5) % 1 + 1) % 1 - 0.5);
        const m = 1 - Math.min(1, Math.max(0, (d - q.half) / Math.max(q.hueSoft, 1e-4)));
        if (m < 1) { g.fillStyle = `rgba(20,21,24,${(0.8 * (1 - m)).toFixed(3)})`; g.fillRect(x, 0, 1, H); }
      }
    }
    async function pickKey() {
      if (!clip()) return;
      if (!ui.overlay?.pickColor) { ui.toast(tr('The program monitor is not open.')); return; }
      hslDropper.setAttribute('aria-pressed', 'true');
      let rgb = null;
      try { rgb = await ui.overlay.pickColor(); } finally { hslDropper.setAttribute('aria-pressed', 'false'); }
      if (!rgb || !clip()) return;
      set(LUMETRI, L.qualifierFor(rgb), 'HSL Secondary');
    }

    // Vignette (its own effect)
    const vigBox = section('vignette', 'Vignette', () => resetParams('vignette', VIGNETTE.map((v) => v[0])));
    group(vigBox, '', 'vignette', VIGNETTE);

    async function pick() {
      if (!clip()) return;
      if (!ui.overlay?.pickColor) { ui.toast(tr('The program monitor is not open.')); return; }
      dropper.setAttribute('aria-pressed', 'true');
      let rgb = null;
      try { rgb = await ui.overlay.pickColor(); } finally { dropper.setAttribute('aria-pressed', 'false'); }
      if (!rgb || !clip()) return;
      const wb = whiteBalance(rgb, paramsOf(LUMETRI));
      if (wb) set(LUMETRI, wb);
    }

    onCheck.addEventListener('change', () => {
      const e = effectOf(LUMETRI);
      if (e) ui.exec(app, C.setEffect(seq().id, clipId, e.id, { on: onCheck.checked }));
      else if (onCheck.checked) set(LUMETRI, {});
    });
    resetBtn.addEventListener('click', () => {
      const c = clip();
      if (!c) return;
      app.history.begin('Color');
      try {
        for (const type of [LUMETRI, 'vignette']) {
          const e = effectOf(type);
          if (!e) continue;
          for (const k of Object.keys(c.keyframes)) if (k.startsWith(`effects.${e.id}.`)) app.history.do(C.setKeyframes(seq().id, c.id, k, null));
          app.history.do(C.setEffect(seq().id, c.id, e.id, { params: Object.fromEntries(Object.keys(e.params).map((k) => [k, null])) }));
        }
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    });

    let lutKey = '';
    let drawnCurve = '';
    let drawnHue = '';
    function refreshLook(ok, p) {
      const luts = app.project?.luts || {};
      const key = `${Object.keys(luts).join(',')}|${p.lut}`;
      if (key !== lutKey) {
        lutKey = key;
        const opts = [{ value: '', label: tr('None') }, ...Object.entries(luts).map(([id, e]) => ({ value: id, label: e.name || e.title || id }))];
        if (p.lut && !luts[p.lut]) opts.push({ value: p.lut, label: tr('Missing LUT') });
        lookSel.setOptions(opts, p.lut || '');
      }
      lookSel.disabled = !ok;
      browse.disabled = !ok;
      const e = p.lut ? luts[p.lut] : null;
      lookInfo.textContent = !p.lut ? '' : e ? tr('{title} · {size} points a side', { title: e.title || e.name, size: e.size }) : tr('This LUT is not in the project; the clip is drawn without it.');
      lookInfo.classList.toggle('missing', !!p.lut && !e);
    }

    function refresh() {
      const s = seq();
      const c = s ? edit.primaryClip(app) : null;
      const ok = c && edit.kindOf(s, c) === 'video';
      if ((ok ? c.id : null) !== clipId) lookError.hidden = true;
      clipId = ok ? c.id : null;
      root.classList.toggle('disabled', !ok);
      title.textContent = ok ? c.name || Cut.model.mediaOf(app.project, c)?.name || tr('Clip') : '';
      hint.textContent = ok ? '' : tr('Select a video clip in the timeline to correct its color.');
      hint.hidden = !!ok;
      const lm = ok ? effectOf(LUMETRI) : null;
      onCheck.checked = !!lm && lm.on !== false;
      onCheck.disabled = !ok;
      resetBtn.disabled = !ok;
      dropper.disabled = !ok;
      hslDropper.disabled = !ok;
      maskCheck.disabled = !ok;
      for (const s2 of Object.values(sections)) if (s2.reset) s2.reset.disabled = !ok;
      autoBtn.disabled = !ok || Cut.model.mediaOf(app.project, c)?.kind == null;
      const vals = { [LUMETRI]: paramsOf(LUMETRI), vignette: paramsOf('vignette') };
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
      const p = vals[LUMETRI];
      maskCheck.checked = !!p.hslMask;
      refreshLook(ok, p);
      for (const [i, b] of chanBtns.entries()) b.classList.toggle('changed', !L.isIdentityCurve(p[CHANNELS[i][0]]));
      curveCanvas.classList.toggle('keyframed', !!lm && CHANNELS.some((ch) => edit.keyframed(clip(), `effects.${lm.id}.${ch[0]}`)));
      // Redrawn only when what they show changed: refresh runs on every frame while playing.
      const ck = JSON.stringify([CHANNELS.map((ch) => p[ch[0]]), channel, curveCanvas.clientWidth, curveCanvas.clientHeight]);
      if (!collapsed.has('curves') && ck !== drawnCurve) { drawnCurve = ck; drawCurve(); }
      const hk = JSON.stringify([L.HSL_PARAMS.slice(0, 3).map((k) => p[k]), hueBar.clientWidth]);
      if (!collapsed.has('hsl') && hk !== drawnHue) { drawnHue = hk; drawHueBar(p); }
    }
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); }); };
    offs.push(app.on('project', later), app.on('selection', later), app.on('sequence', later), app.on('time', later));
    offs.push(() => cancelAnimationFrame(raf));
    refresh();
    return { dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); } };
  }

  ui.color = { whiteBalance, readLut };
  ui.registerPanel('color', { title: () => tr('Lumetri Color'), mount });
})();
