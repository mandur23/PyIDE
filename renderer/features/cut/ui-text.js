// The text panel of Nano Studio Cut (video-editor-features.md section 11): the layers of the selected text clip and
// the look of the chosen one (text, font from cut:fonts with its Korean name, style, size, tracking, leading,
// alignment, fill, stroke, shadow, background box, position), saved text styles (project settings.textStyles) and the
// motion presets (fade, rise, typewriter, in and out) as keyframes from Cut.textrender.animations, editable afterwards
// in the effect controls. Typing in the text field is one undo step per visit to the field, and nothing is recorded
// while an IME composes: the group closes when the field loses the keyboard.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const edit = ui.edit;
  const el = ui.el;

  const STYLE_FIELDS = ['font', 'size', 'weight', 'italic', 'tracking', 'leading', 'align', 'fill', 'stroke', 'shadow', 'box'];

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-text');
    const head = el('div', 'cut-text-head');
    const title = el('span', 'cut-text-title');
    const newBtn = ui.button({ label: tr('New Text'), title: tr('Add a text clip at the playhead'), onClick: () => addNew() });
    head.append(title, newBtn);
    const hint = el('div', 'cut-text-hint', tr('Select a text clip, or click the program monitor with the Type tool (T).'));
    const layers = el('div', 'cut-text-layers');
    const form = el('div', 'cut-text-form');
    root.append(head, hint, layers, form);
    host.appendChild(root);

    const seq = () => app.sequence;
    let clipId = null;
    let layerId = null;
    const clip = () => (clipId ? edit.clipById(seq(), clipId) : null);
    const layer = () => clip()?.source?.layers?.find((l) => l.id === layerId) || null;
    const path = (field) => `layers.${layerId}.${field}`;
    // A field set at the playhead: a keyframe when the field is keyframed, else the layer's value.
    const setField = (field, value) => {
      const c = clip();
      if (!c || !layer()) return null;
      return edit.write(app, c, path(field), value);
    };
    const valueOf = (field) => {
      const c = clip();
      const l = layer();
      if (!c || !l) return undefined;
      return edit.keyframed(c, path(field)) ? edit.valueAt(app, c, path(field)) : l[field];
    };
    const updates = [];
    const section = (name) => {
      const s = el('div', 'cut-text-sec');
      if (name) s.appendChild(el('div', 'cut-text-secname', name));
      form.appendChild(s);
      return s;
    };
    const fieldRow = (sec, label, ...controls) => {
      const r = el('div', 'cut-text-row');
      r.appendChild(el('span', 'cut-text-label', label));
      const box = el('span', 'cut-text-ctl');
      box.append(...controls);
      r.appendChild(box);
      sec.appendChild(r);
      return r;
    };
    const number = (field, opts, get = () => valueOf(field), set = (v) => setField(field, v)) => {
      const g = edit.gesture(app, 'Edit Text');
      const f = ui.numberField({ value: get() ?? 0, ...opts, onBegin: () => g.begin(), onEnd: () => g.end(), onChange: (v) => set(v) });
      updates.push(() => { const v = get(); if (!f.querySelector('input')) f.value = typeof v === 'number' ? v : NaN; });
      return f;
    };
    const colorInput = (get, set) => {
      const input = el('input', 'cut-text-color', undefined, { type: 'color' });
      const g = edit.gesture(app, 'Edit Text');
      input.addEventListener('focus', () => g.begin());
      input.addEventListener('input', () => set(input.value));
      input.addEventListener('change', () => g.end());
      input.addEventListener('blur', () => g.end());
      updates.push(() => { const v = get(); if (typeof v === 'string' && document.activeElement !== input) input.value = v.slice(0, 7); });
      return input;
    };
    const check = (get, set) => {
      const input = el('input', null, undefined, { type: 'checkbox' });
      input.addEventListener('change', () => set(input.checked));
      updates.push(() => { input.checked = !!get(); });
      return input;
    };

    // ---------- text ----------
    const s1 = section('');
    const text = el('textarea', 'cut-text-area', undefined, { rows: 3, spellcheck: false, placeholder: tr('Type the text here') });
    text.dataset.userText = '';
    const textGroup = edit.gesture(app, 'Edit Text');
    text.addEventListener('focus', () => textGroup.begin());
    text.addEventListener('input', () => {
      if (!layer()) return;
      textGroup.begin();
      try { app.history.do(C.setLayer(seq().id, clipId, layerId, { text: text.value })); } catch (err) { ui.report(err); }
    });
    text.addEventListener('blur', () => textGroup.end());
    s1.appendChild(text);
    updates.push(() => { const l = layer(); if (l && document.activeElement !== text && text.value !== l.text) text.value = l.text; });

    // ---------- font ----------
    const s2 = section(tr('Font'));
    let fonts = [];
    const family = ui.select({ options: [], onChange: (v) => {
      const fam = fonts.find((f) => f.family === v);
      const l = layer();
      if (!l) return;
      const style = fam ? nearest(fam.styles, l.weight, l.italic) : null;
      app.history.begin('Edit Text');
      try {
        app.history.do(C.setLayer(seq().id, clipId, layerId, { font: v, ...(style ? { weight: style.weight, italic: !!style.italic } : {}) }));
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
      Cut.textrender?.loadFont?.(v, { weight: style?.weight || l.weight, italic: !!style?.italic });
    } });
    family.classList.add('cut-text-family');
    const styleSel = ui.select({ options: [], onChange: (v) => {
      const [w, it] = v.split('|');
      ui.exec(app, C.setLayer(seq().id, clipId, layerId, { weight: Number(w), italic: it === '1' }));
      const l = layer();
      if (l) Cut.textrender?.loadFont?.(l.font, { weight: Number(w), italic: it === '1' });
    } });
    fieldRow(s2, tr('Family'), family);
    fieldRow(s2, tr('Style'), styleSel);
    const nearest = (styles, weight, italic) => styles.slice().sort((a, b) => (!!a.italic !== !!italic) - (!!b.italic !== !!italic) || Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0];
    const fontLabel = (f) => (f.localName && f.localName !== f.family ? `${f.localName} (${f.family})` : f.family);
    async function loadFonts() {
      try { fonts = (await (Cut.textrender?.fontList?.() ?? ide.api.invoke('cut:fonts'))) || []; } catch { fonts = []; }
      if (!Array.isArray(fonts)) fonts = [];
      fonts = fonts.slice().sort((a, b) => fontLabel(a).localeCompare(fontLabel(b)));
      syncFonts();
    }
    function syncFonts() {
      const l = layer();
      const list = fonts.map((f) => ({ value: f.family, label: fontLabel(f) }));
      if (l && !fonts.some((f) => f.family === l.font)) list.unshift({ value: l.font, label: tr('{name} (not installed)', { name: l.font }) });
      if (document.activeElement !== family) family.setOptions(list, l?.font ?? '');
      const fam = fonts.find((f) => f.family === l?.font);
      const styles = (fam?.styles || []).map((s) => ({ value: `${s.weight}|${s.italic ? 1 : 0}`, label: s.style || `${s.weight}${s.italic ? ' Italic' : ''}` }));
      const cur = l ? `${l.weight}|${l.italic ? 1 : 0}` : '';
      if (l && !styles.some((s) => s.value === cur)) styles.unshift({ value: cur, label: `${l.weight}${l.italic ? ` ${tr('Italic')}` : ''}` });
      if (document.activeElement !== styleSel) styleSel.setOptions(styles, cur);
    }
    updates.push(syncFonts);
    fieldRow(s2, tr('Size'), number('size', { min: 1, max: 2000, step: 1, unit: 'px' }));
    fieldRow(s2, tr('Tracking'), number('tracking', { min: -500, max: 2000, step: 1 }));
    fieldRow(s2, tr('Leading'), number('leading', { min: 0.5, max: 4, step: 0.05, precision: 2 }));
    const aligns = el('span', 'cut-text-aligns');
    const alignBtns = ['left', 'center', 'right'].map((a) => {
      const b = ui.button({ label: { left: tr('Left'), center: tr('Center'), right: tr('Right') }[a], toggle: true, cls: `cut-text-align-${a}`, onClick: () => ui.exec(app, C.setLayer(seq().id, clipId, layerId, { align: a })) });
      b.dataset.align = a;
      return b;
    });
    aligns.append(...alignBtns);
    updates.push(() => { const l = layer(); for (const b of alignBtns) b.setPressed(l?.align === b.dataset.align); });
    fieldRow(s2, tr('Align'), aligns);

    // ---------- appearance ----------
    const s3 = section(tr('Appearance'));
    fieldRow(s3, tr('Fill'), colorInput(() => valueOf('fill'), (v) => setField('fill', v)));
    const sub = (field, key, fallback) => ({
      get: () => layer()?.[field]?.[key],
      set: (v) => { const l = layer(); if (!l) return; ui.exec(app, C.setLayer(seq().id, clipId, layerId, { [field]: { ...(l[field] || fallback), [key]: v } })); },
    });
    const toggle = (field, fallback) => check(() => !!layer()?.[field], (on) => ui.exec(app, C.setLayer(seq().id, clipId, layerId, { [field]: on ? { ...fallback } : null })));
    const STROKE = { color: '#000000', width: 4 };
    const SHADOW = { color: '#000000b3', blur: 8, x: 3, y: 3 };
    const BOX = { color: '#000000aa', padding: 16, radius: 8 };
    const sc = sub('stroke', 'color', STROKE); const sw = sub('stroke', 'width', STROKE);
    fieldRow(s3, tr('Stroke'), toggle('stroke', STROKE), colorInput(sc.get, sc.set), number(null, { min: 0, max: 100, step: 1, unit: 'px' }, sw.get, sw.set));
    const hc = sub('shadow', 'color', SHADOW); const hb = sub('shadow', 'blur', SHADOW); const hx = sub('shadow', 'x', SHADOW); const hy = sub('shadow', 'y', SHADOW);
    fieldRow(s3, tr('Shadow'), toggle('shadow', SHADOW), colorInput(hc.get, hc.set), number(null, { min: 0, max: 200, step: 1, title: tr('Blur') }, hb.get, hb.set),
      number(null, { min: -500, max: 500, step: 1, title: 'X' }, hx.get, hx.set), number(null, { min: -500, max: 500, step: 1, title: 'Y' }, hy.get, hy.set));
    const bc = sub('box', 'color', BOX); const bp = sub('box', 'padding', BOX); const br = sub('box', 'radius', BOX);
    fieldRow(s3, tr('Background'), toggle('box', BOX), colorInput(bc.get, bc.set), number(null, { min: 0, max: 500, step: 1, title: tr('Padding') }, bp.get, bp.set),
      number(null, { min: 0, max: 500, step: 1, title: tr('Corner Radius') }, br.get, br.set));
    const px = number(null, { step: 1 }, () => valueOf('position')?.[0], (v) => setField('position', [v, valueOf('position')?.[1] ?? 0]));
    const py = number(null, { step: 1 }, () => valueOf('position')?.[1], (v) => setField('position', [valueOf('position')?.[0] ?? 0, v]));
    fieldRow(s3, tr('Position'), px, py);

    // ---------- styles ----------
    const s4 = section(tr('Text Styles'));
    const styleList = ui.select({ options: [] });
    const applyStyle = ui.button({ label: tr('Apply'), onClick: () => {
      const st = (app.project.settings.textStyles || []).find((x) => x.id === styleList.value);
      if (st && layer()) ui.exec(app, C.setLayer(seq().id, clipId, layerId, clone(st.style)));
    } });
    const saveStyle = ui.button({ label: tr('Save…'), onClick: async () => {
      const l = layer();
      if (!l) return;
      const name = await ide.ui.prompt(tr('Style name'), tr('Style {n}', { n: (app.project.settings.textStyles || []).length + 1 }));
      if (!name?.trim()) return;
      const list = (app.project.settings.textStyles || []).slice();
      let n = list.length + 1;
      while (list.some((x) => x.id === `ts${n}`)) n++;
      const style = Object.fromEntries(STYLE_FIELDS.map((k) => [k, clone(l[k])]));
      list.push({ id: `ts${n}`, name: name.trim(), style });
      if (ui.exec(app, C.setSettings({ textStyles: list }))) styleList.value = `ts${n}`;
    } });
    const delStyle = ui.button({ label: tr('Delete'), onClick: () => {
      const list = (app.project.settings.textStyles || []).filter((x) => x.id !== styleList.value);
      ui.exec(app, C.setSettings({ textStyles: list }));
    } });
    fieldRow(s4, tr('Style'), styleList, applyStyle, saveStyle, delStyle);
    updates.push(() => {
      const list = app.project?.settings.textStyles || [];
      const keep = styleList.value;
      styleList.setOptions(list.map((x) => ({ value: x.id, label: x.name })), list.some((x) => x.id === keep) ? keep : list[0]?.id ?? '');
      applyStyle.disabled = delStyle.disabled = !list.length || !layer();
    });

    // ---------- motion ----------
    const s5 = section(tr('Motion Presets'));
    const presets = () => Cut.textrender?.animations?.list?.() || [];
    const presetButtons = (out) => {
      const box = el('span', 'cut-text-presets');
      for (const p of presets()) {
        const b = ui.button({ label: tr(p.name), cls: `cut-text-preset-${out ? 'out' : 'in'}-${p.id}`, onClick: () => applyPreset(p.id, out) });
        b.dataset.preset = p.id;
        box.appendChild(b);
      }
      return box;
    };
    fieldRow(s5, tr('In'), presetButtons(false));
    fieldRow(s5, tr('Out'), presetButtons(true));
    function applyPreset(id, out) {
      const c = clip();
      if (!c || !layer()) return;
      let lists;
      try { lists = Cut.textrender.animations.apply(c, layerId, id, { out, frame: Cut.time.frameTicks(seq().fps) }); } catch (err) { ui.report(err); return; }
      app.history.begin('Motion Preset');
      try {
        for (const [prop, list] of Object.entries(lists)) app.history.do(C.setKeyframes(seq().id, c.id, prop, list));
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
    }

    function addNew() {
      const s = seq();
      if (!s) return;
      app.history.begin('Add Graphic');
      let id = null;
      try { id = edit.addText(app, { text: tr('Title') }); app.history.commit(); } catch (err) { app.history.cancel(); ui.report(err); return; }
      app.select([id]);
      requestAnimationFrame(() => { text.focus(); text.select(); });
    }

    function drawLayers() {
      const c = clip();
      const list = c?.source?.layers || [];
      layers.hidden = list.length < 2;
      layers.replaceChildren(...list.map((l) => {
        const row = el('div', `cut-text-layer${l.id === layerId ? ' active' : ''}`, (l.text || '').split('\n')[0] || tr('(empty)'), { 'data-layer': l.id });
        row.dataset.userText = '';
        row.addEventListener('mousedown', () => { layerId = l.id; refresh(); });
        return row;
      }));
    }
    let shownKey = '';
    function refresh() {
      const s = seq();
      const c = s ? edit.primaryClip(app) : null;
      const ok = c?.source?.generator === 'text';
      const prevClip = clipId;
      clipId = ok ? c.id : null;
      if (clipId !== prevClip || !c?.source?.layers?.some((l) => l.id === layerId)) layerId = ok ? c.source.layers[0]?.id ?? null : null;
      root.classList.toggle('disabled', !ok);
      hint.hidden = !!ok;
      form.hidden = !ok;
      title.textContent = ok ? c.name || tr('Text') : tr('Text');
      const key = ok ? `${c.id}|${c.source.layers.map((l) => `${l.id}:${l.text}`).join(',')}|${layerId}` : '';
      if (key !== shownKey) { shownKey = key; drawLayers(); }
      if (ok) for (const u of updates) u();
    }
    const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); }); };
    offs.push(app.on('project', later), app.on('selection', later), app.on('sequence', later), app.on('time', later));
    offs.push(() => cancelAnimationFrame(raf));
    offs.push(() => textGroup.end());
    loadFonts();
    refresh();
    ui.textPanel = { refresh, get layerId() { return layerId; }, field: text };
    return { dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); } };
  }

  ui.registerPanel('text', { title: () => tr('Text'), mount });
})();
