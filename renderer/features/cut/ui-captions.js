// The captions panel (video-editor-features.md section 13): the caption track's items as a list of start, end and
// text, edited in place; a row clicked moves the playhead to its start, and the caption under the playhead is
// highlighted. Captions are imported from and exported to SRT (the encoding is detected: UTF-8, UTF-16, CP949), and
// the track's style (font, size, color, background, top or bottom, the word-by-word highlight) is set here. Text
// edits are committed when the field is left or Enter is pressed, never while an IME is composing, so undo never
// splits a syllable. The toolbar
// also starts Auto Captions (ui-speech.js) and Claude's polish and translation (ui-ai.js). A caption holding words
// speech recognition was unsure of (its doubt) is marked, with those words under its text: a word moves the playhead
// to it, the check mark keeps the text as it is, and editing the text clears the mark.
//
// Cut.ui.captions: importFile(app, path), exportFile(app, path), trackOf(app), reveal(app, t).
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, button } = ui;
  const T = () => Cut.time;
  const C = () => Cut.commands;

  let chosenTrack = null; // the caption track id shown, per sequence: the first one when unset
  const trackOf = (app) => {
    const seq = app.sequence;
    if (!seq?.captions?.length) return null;
    return seq.captions.find((c) => c.id === chosenTrack) || seq.captions[0];
  };
  // The shown track is also the one the program monitor draws and export burns in: a change is the app's 'captionTrack'.
  function choose(app, id) {
    if (chosenTrack === id) return;
    chosenTrack = id;
    app.emit('captionTrack', { id });
  }
  // The track to write into, made when the sequence has none yet.
  function ensureTrack(app) {
    const t = trackOf(app);
    if (t) return t.id;
    const r = ui.exec(app, C().addCaptionTrack(app.sequence.id, { name: tr('Captions'), lang: i18n?.locale === 'ko' ? 'ko' : 'en' }));
    choose(app, r?.id || null);
    return chosenTrack;
  }

  async function readText(path) {
    const st = await ide.api.invoke('cut:stat', path);
    if (!st || st.missing) throw new Error(tr('The file is gone.'));
    if (st.size > 16 * 1024 * 1024) throw new Error(tr('The file is too large for a caption file.'));
    const bytes = await ide.api.invoke('cut:read', path, 0, st.size);
    if (!(bytes instanceof Uint8Array)) throw new Error(bytes?.error?.message || tr('The file could not be read.'));
    return Cut.srt.decode(bytes);
  }
  // Writes text through the export sink (a .part file renamed when complete).
  async function writeText(path, text) {
    const bytes = new TextEncoder().encode(`${String.fromCharCode(0xfeff)}${text}`);
    const open = await ide.api.invoke('cut:writeOpen', path);
    if (!open?.id) throw new Error(open?.error?.message || tr('The file could not be written.'));
    const w = await ide.api.invoke('cut:writeAt', open.id, bytes);
    if (w?.error) { await ide.api.invoke('cut:writeClose', open.id, { commit: false }); throw new Error(w.error.message || w.error.code); }
    const r = await ide.api.invoke('cut:writeClose', open.id, { commit: true });
    if (!r?.ok) throw new Error(r?.error?.message || tr('The file could not be written.'));
    return r;
  }

  // An SRT (or VTT) file -> its captions replace those of the shown track (one undo step). -> the item count.
  // newTrack: a track of its own (a file dropped in): the chosen track and its captions are left as they are.
  async function importFile(app, path, { newTrack = false } = {}) {
    if (!app.sequence) { ui.toast(tr('Open a sequence to import captions into.')); return 0; }
    let items;
    try {
      const text = await readText(path);
      items = (Cut.srt.parseAny ? Cut.srt.parseAny(text, ui.basename(path)) : Cut.srt.parse(text));
    } catch (err) {
      ui.notify(tr('The captions could not be imported: {error}', { error: err?.message || String(err) }), { kind: 'error' });
      return 0;
    }
    if (!items.length) { ui.toast(tr('The file has no captions.')); return 0; }
    const seq = app.sequence;
    const existing = newTrack ? null : trackOf(app);
    app.history.begin(tr('Import Captions'));
    try {
      const id = existing?.id || app.history.do(C().addCaptionTrack(seq.id, { name: ui.basename(path).replace(/\.[^.]+$/, ''), lang: i18n?.locale === 'ko' ? 'ko' : 'en' })).id;
      app.history.do(C().setCaptions(seq.id, id, items));
      choose(app, id);
      app.history.commit();
    } catch (err) {
      app.history.cancel();
      ui.report(err);
      return 0;
    }
    ui.toast(tr('{n} captions imported', { n: items.length }));
    return items.length;
  }
  async function exportFile(app, path) {
    const t = trackOf(app);
    if (!t?.items.length) { ui.toast(tr('There are no captions to export.')); return null; }
    try {
      const r = await writeText(path, Cut.srt.write(Cut.speakers.written(app.project, t, t.items, tr).map(({ start, end, text }) => ({ start, end, text }))));
      ui.toast(tr('Saved {name}', { name: ui.basename(path) }));
      return r;
    } catch (err) {
      ui.notify(tr('The captions could not be exported: {error}', { error: err?.message || String(err) }), { kind: 'error' });
      return null;
    }
  }
  async function importDialog(app) {
    const path = await ide.api.invoke('dialog:openFile', [{ name: tr('Captions'), extensions: ['srt', 'vtt'] }]);
    if (path) await importFile(app, Array.isArray(path) ? path[0] : path);
  }
  async function exportDialog(app) {
    const home = await ide.api.invoke('cut:home').catch(() => null);
    const dir = app.path ? app.path.replace(/[\\/][^\\/]*$/, '') : home?.projects || '';
    const name = String(app.sequence?.name || 'Captions').replace(/[\\/:*?"<>|]+/g, '_');
    const path = await ide.api.invoke('cut:saveAs', { defaultPath: `${dir}\\${name}.srt`, filters: [{ name: tr('SubRip captions'), extensions: ['srt'] }], title: tr('Export Captions') });
    if (path) await exportFile(app, path);
  }

  // The style dialog: font, size, colors, background and where the captions sit.
  async function styleDialog(app) {
    const t = trackOf(app);
    if (!t) { ui.toast(tr('Add captions first.')); return; }
    const s = { ...Cut.model.defaultCaptionStyle(), ...t.style };
    const font = ui.select({ options: [{ value: s.font, label: s.font }], value: s.font, cls: 'cut-cap-font' });
    ide.api.invoke('cut:fonts').then((list) => {
      if (!Array.isArray(list)) return;
      const opts = list.map((f) => ({ value: f.family, label: f.localName && f.localName !== f.family ? `${f.localName} (${f.family})` : f.family }));
      if (!opts.some((o) => o.value === s.font)) opts.unshift({ value: s.font, label: s.font });
      font.setOptions(opts, s.font);
    }).catch(() => {});
    const size = ui.numberField({ value: s.size, min: 8, max: 300, step: 1, precision: 0, unit: 'px', cls: 'cut-cap-size' });
    const color = el('input', 'cut-cap-color', undefined, { type: 'color' });
    color.value = String(s.color).slice(0, 7);
    const bgHex = String(s.background || '#00000000');
    const bg = el('input', 'cut-cap-bg', undefined, { type: 'color' });
    bg.value = bgHex.slice(0, 7);
    const alpha = ui.numberField({ value: Math.round((parseInt(bgHex.slice(7, 9) || 'ff', 16) / 255) * 100), min: 0, max: 100, step: 1, precision: 0, unit: '%', cls: 'cut-cap-bg-alpha' });
    const pos = ui.select({ options: [{ value: 'bottom', label: tr('Bottom') }, { value: 'top', label: tr('Top') }], value: s.position, cls: 'cut-cap-pos' });
    // the word-by-word highlight: only captions with word timings (made from speech) light up
    const hlOn = el('input', 'cut-cap-hl', undefined, { type: 'checkbox' });
    hlOn.checked = !!s.highlight;
    const hlColor = el('input', 'cut-cap-hl-color', undefined, { type: 'color' });
    hlColor.value = String(s.highlightColor || '#ffd23f').slice(0, 7);
    const hlMode = ui.select({ options: [{ value: 'color', label: tr('Word color') }, { value: 'box', label: tr('Word color and box') }], value: s.highlightMode === 'box' ? 'box' : 'color', cls: 'cut-cap-hl-mode' });
    const timed = t.items.filter((it) => Cut.captionwords.valid(it.words, it.text)).length;
    // the speakers' colors and names (ui-speakers.js), for captions that know their speaker
    const spk = ui.speakers ? ui.select({ options: ui.speakers.CAPTION_MODES.map(([value, label]) => ({ value, label: tr(label) })), value: ui.speakers.modeOf(s), cls: 'cut-cap-speakers' }) : null;
    const body = el('div', 'cut-form');
    body.append(ui.row(tr('Font'), font), ui.row(tr('Size at 1080p'), size), ui.row(tr('Text color'), color), ui.row(tr('Background'), bg), ui.row(tr('Background opacity'), alpha), ui.row(tr('Position'), pos),
      ui.row(tr('Highlight each word as it is spoken'), hlOn), ui.row(tr('Highlight color'), hlColor), ui.row(tr('Highlight style'), hlMode),
      el('div', 'cut-dialog-note cut-cap-hl-note', tr('{n} of {m} captions have word timings. Captions made with Auto Captions have them; imported or typed ones show no highlight.', { n: timed, m: t.items.length })),
      spk ? ui.row(tr('Speakers'), spk) : '');
    ui.dialog({
      title: tr('Caption Style'),
      id: 'cutCaptionStyle',
      body,
      width: 420,
      buttons: [
        { label: tr('OK'), primary: true, run: () => {
          const a = Math.round((alpha.value / 100) * 255).toString(16).padStart(2, '0');
          ui.exec(app, C().setCaptionTrack(app.sequence.id, t.id, { style: { font: font.value, size: size.value, color: color.value, background: `${bg.value}${a}`, position: pos.value, highlight: hlOn.checked, highlightColor: hlColor.value, highlightMode: hlMode.value, ...(spk ? ui.speakers.styleOf(spk.value) : {}) } }));
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  function mount(root, app) {
    root.classList.add('cut-captions');
    const bar = el('div', 'cut-panel-toolbar');
    const trackSel = ui.select({ options: [], cls: 'cut-cap-track', title: tr('Caption track'), onChange: (v) => { choose(app, v); draw(); } });
    bar.append(
      button({ icon: 'add', title: tr('Add Caption at Playhead'), cls: 'cut-cap-add', onClick: () => addAtPlayhead() }),
      trackSel,
      button({ icon: 'download', title: tr('Import SRT…'), cls: 'cut-cap-import', onClick: () => importDialog(app) }),
      button({ icon: 'export', title: tr('Export SRT…'), cls: 'cut-cap-export', onClick: () => exportDialog(app) }),
      button({ icon: 'edit', title: tr('Caption Style…'), cls: 'cut-cap-style', onClick: () => styleDialog(app) }),
      button({ label: tr('Auto Captions…'), title: tr('Create captions from the speech (on this PC)'), cls: 'cut-cap-auto', onClick: () => Promise.resolve(ui.speech?.autoCaptions(app)).catch((err) => ui.report(err)) }),
      // Claude (ui-ai.js): polish or translate the shown track
      button({ label: tr('Claude'), title: tr('Polish or translate the captions with Claude'), cls: 'cut-cap-ai', onClick: (_e, b) => ui.menu(b, [
        { label: tr('Polish Captions with Claude…'), run: () => Promise.resolve(ui.ai?.polishCaptions(app)).catch((err) => ui.report(err)) },
        { label: tr('Translate Captions with Claude…'), run: () => Promise.resolve(ui.ai?.translateCaptions(app)).catch((err) => ui.report(err)) },
      ]) }),
    );
    const list = el('div', 'cut-cap-list');
    const foot = el('div', 'cut-panel-foot');
    root.append(bar, list, foot);

    const fps = () => app.sequence?.fps || [30, 1];
    function addAtPlayhead() {
      const seq = app.sequence;
      if (!seq) return;
      const id = ensureTrack(app);
      if (!id) return;
      const t = trackOf(app);
      const start = app.t;
      const next = t.items.find((x) => x.start > start);
      const end = Math.min(next ? next.start : Infinity, start + T().fromSeconds(2));
      const r = ui.exec(app, C().addCaption(seq.id, id, { start, end: end > start ? end : start + T().frameTicks(fps()), text: '' }));
      if (r?.id) { draw(); list.querySelector(`[data-id="${r.id}"] .cut-cap-text`)?.focus(); }
    }

    // Rows are kept per caption id, so a redraw after an edit leaves the field being typed in alone.
    const rows = new Map();
    function row(item, trackId) {
      const r = el('div', 'cut-cap-row', undefined, { 'data-id': item.id });
      const num = el('span', 'cut-cap-num');
      const start = ui.timecodeField({ fps, value: item.start, cls: 'cut-cap-start', title: tr('Start'), onChange: (t) => set({ start: t }) });
      const end = ui.timecodeField({ fps, value: item.end, cls: 'cut-cap-end', title: tr('End'), onChange: (t) => set({ end: t }) });
      const text = el('textarea', 'cut-cap-text', undefined, { rows: 2, spellcheck: 'false' });
      text.value = item.text;
      text.dataset.userText = '';
      const doubt = el('div', 'cut-cap-doubt');
      doubt.hidden = true;
      let shownDoubt = '';
      const remove = button({ icon: 'closeSmall', title: tr('Delete Caption'), cls: 'cut-cap-remove', onClick: () => ui.exec(app, C().removeCaption(app.sequence.id, trackId(), item.id)) });
      const commit = () => { if (text.value !== current().text) set({ text: text.value }); };
      text.addEventListener('change', commit);
      text.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); text.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); text.value = current().text; text.blur(); }
      });
      r.addEventListener('pointerdown', (e) => {
        if (e.target.closest('textarea, input, .cut-timecode, button')) return;
        app.setTime(current().start);
      });
      r.append(num, start, end, text, remove, doubt);
      const current = () => trackOf(app)?.items.find((x) => x.id === item.id) || item;
      function set(patch) { ui.exec(app, C().setCaption(app.sequence.id, trackId(), item.id, patch)); }
      // the doubtful words: each seeks to itself; the check mark says the caption is right as it is
      function paintDoubt(it) {
        const list = ui.speech?.marking() !== false ? it.doubt || [] : [];
        const key = JSON.stringify(list);
        if (key === shownDoubt) return;
        shownDoubt = key;
        r.classList.toggle('uncertain', list.length > 0);
        doubt.hidden = !list.length;
        if (!list.length) { doubt.replaceChildren(); return; }
        const pct = (p) => ui.speech?.percent(p) ?? `${Math.round(p * 100)}%`;
        doubt.replaceChildren(
          el('span', 'cut-cap-doubt-label', tr('Unsure:')),
          ...list.map((d) => button({ label: `${d.text} ${pct(d.p)}`, title: tr('Whisper was unsure of this word ({p}). Go to it.', { p: pct(d.p) }), cls: 'cut-cap-doubt-word', onClick: () => app.setTime(Cut.time.snap(Math.min(current().start + d.at, current().end - 1), fps())) })),
          button({ icon: 'check', title: tr('Mark as Checked: the caption is right as it is'), cls: 'cut-cap-doubt-ok', onClick: () => set({ doubt: null }) }),
        );
      }
      return { el: r, num, start, end, text, update(it, i) {
        num.textContent = String(i + 1);
        start.value = it.start;
        end.value = it.end;
        if (document.activeElement !== text) text.value = it.text;
        paintDoubt(it);
      } };
    }
    function draw() {
      const seq = app.sequence;
      const tracks = seq?.captions || [];
      trackSel.setOptions(tracks.map((t) => ({ value: t.id, label: t.name })), trackOf(app)?.id || '');
      trackSel.hidden = tracks.length < 2;
      const t = trackOf(app);
      const items = t?.items || [];
      const seen = new Set();
      items.forEach((it, i) => {
        let r = rows.get(it.id);
        if (!r) { r = row(it, () => trackOf(app)?.id); rows.set(it.id, r); }
        r.update(it, i);
        seen.add(it.id);
        if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] || null);
      });
      for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
      list.querySelector(':scope > .cut-empty')?.remove();
      if (!items.length) list.appendChild(el('div', 'cut-empty', tr('No captions. Add one at the playhead, import an SRT file, or create them from the speech with Auto Captions.')));
      const unsure = ui.speech?.marking() !== false ? items.filter((it) => it.doubt?.length).length : 0;
      foot.textContent = !items.length ? '' : unsure ? tr('{n} captions, {u} with uncertain words', { n: items.length, u: unsure }) : tr('{n} captions', { n: items.length });
      highlight();
    }
    function highlight() {
      const t = trackOf(app);
      const now = t?.items.find((x) => x.start <= app.t && app.t < x.end);
      for (const [id, r] of rows) r.el.classList.toggle('current', id === now?.id);
    }
    const offs = [
      app.on('project', draw),
      app.on('sequence', () => { choose(app, null); for (const r of rows.values()) r.el.remove(); rows.clear(); draw(); }),
      app.on('time', highlight),
      ide.on('settingsChanged', (k) => { if (k === 'cut.speech.markUncertain') draw(); }),
    ];
    // Next Uncertain Word: the caption at t scrolled into view.
    shown = (t) => {
      const it = trackOf(app)?.items.find((x) => x.start <= t && t < x.end);
      rows.get(it?.id)?.el.scrollIntoView({ block: 'nearest' });
    };
    offs.push(() => { shown = null; });
    draw();
    return { dispose: () => { for (const off of offs) off(); } };
  }

  let shown = null; // the mounted panel's reveal
  const reveal = (app, t) => shown?.(t);
  ui.captions = { importFile, exportFile, importDialog, exportDialog, styleDialog, trackOf, reveal };
  ui.registerPanel('captions', { title: () => tr('Captions'), mount });
})();
