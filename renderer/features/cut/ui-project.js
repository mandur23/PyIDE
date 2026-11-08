// The project panel (video-editor-features.md section 2): the media, bins and sequences of the project, in a list
// (name, duration, size, frame rate, codec, uses) or as thumbnails that show the frame under the pointer (hover
// scrub). Import by the dialog, a whole folder (its subfolders become bins) or a drop from Explorer; files that cannot
// be used are listed with the reason. Media whose file moved is offline: it shows so, and the relink dialog finds the
// files again in a folder by name and size (or by name and duration when the size changed). New Sequence and new text
// and color items are here too. The More menu: Select Unused (media no sequence uses, shown across the bins), Remove
// Unused (one undo step, after a list of what goes), Find Missing Media (checks every file, then the relink dialog),
// and the proxies of the selected media (ui-proxy.js), whose state each item shows.
//
// Cut.ui.media: importDialog(app), importFolder(app), importPaths(app, paths, {binId}), checkOffline(app),
// relinkDialog(app), offline (Set of media ids), matchSequence(app, mediaId) -> Promise<bool>, describe(media),
// unusedIds(project), removeUnused(app), findMissing(app), selected() and selectUnused() (while the panel is mounted).
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, icon, button } = ui;
  const log = ide.logger('#cut');

  const offline = new Set();
  const settingKey = 'cut.project.view';

  // ---------- importing ----------
  const READ_CHUNK = 64 * 1024 * 1024;
  const ipcReader = (path, size) => ({
    size,
    async read(offset, length) {
      const parts = [];
      let got = 0;
      while (got < length) {
        const n = Math.min(READ_CHUNK, length - got);
        const r = await ide.api.invoke('cut:read', path, offset + got, n);
        if (!(r instanceof Uint8Array)) throw Object.assign(new Error(r?.error?.message || 'The file could not be read.'), { code: r?.error?.code || 'io' });
        parts.push(r);
        got += r.length;
        if (r.length < n) break;
      }
      if (parts.length === 1) return parts[0];
      const out = new Uint8Array(got);
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    },
  });
  const REASONS = {
    unsupported: 'The format or codec is not supported.',
    damaged: 'The file is damaged.',
    hdr: 'HDR video is not supported yet.',
    noTracks: 'The file has no video or audio.',
    codec: 'This PC cannot decode the codec.',
    missing: 'The file is gone.',
    io: 'The file could not be read.',
  };
  const reasonText = (e) => tr(REASONS[e?.code] || e?.message || REASONS.io);

  // One file -> {media} (a Media entry for commands.importMedia) or {path, error: {code, message}}. Used when the
  // engine's Cut.media.importFiles is not there.
  async function probeFile(path) {
    const st = await ide.api.invoke('cut:stat', path);
    if (!st || st.missing || st.error) return { path, error: { code: st?.error?.code || 'missing' } };
    if (!st.isFile) return { path, error: { code: 'unsupported' } };
    const name = ui.basename(path);
    let src;
    try {
      src = await Cut.probe.open(ipcReader(st.path || path, st.size), { name });
    } catch (err) {
      return { path, error: { code: err?.code === 'unsupported' ? 'unsupported' : 'damaged', message: err?.message } };
    }
    if (src.error) return { path, error: { code: src.error.code, message: src.error.detail } };
    const v = src.tracks.find((t) => t.kind === 'video');
    const a = src.tracks.find((t) => t.kind === 'audio');
    if (v && ['pq', 'hlg'].includes(v.colorSpace?.transfer)) return { path, error: { code: 'hdr' } };
    if (v && globalThis.VideoDecoder?.isConfigSupported) {
      const ok = await VideoDecoder.isConfigSupported({ codec: v.codec, codedWidth: v.width, codedHeight: v.height, ...(v.description ? { description: v.description } : {}) })
        .then((r) => r.supported).catch(() => false);
      if (!ok) return { path, error: { code: 'codec', message: v.codec } };
    }
    const image = src.container === 'image';
    if (!image && !v && !a) return { path, error: { code: 'noTracks' } };
    return {
      media: {
        path: st.path || path, name, size: st.size, mtime: st.mtime,
        kind: image || v ? (image ? 'image' : 'video') : 'audio',
        duration: image ? 0 : Math.max(0, Math.round(src.duration || 0)),
        video: image ? { w: src.image?.width || 0, h: src.image?.height || 0, fps: null, codec: src.image?.mime || 'image', vfr: false, rotation: 0 }
          : v ? { w: v.displayWidth || v.width, h: v.displayHeight || v.height, fps: v.frameRate, codec: v.codec, vfr: !!v.vfr, rotation: v.rotation || 0 } : null,
        audio: a ? { rate: a.sampleRate, channels: a.channels } : null,
      },
    };
  }
  // -> [{media} | {path, error}] whichever importer runs.
  async function probeAll(paths, onStep) {
    if (typeof Cut.media?.importFiles === 'function') {
      const r = await Cut.media.importFiles(paths);
      const list = Array.isArray(r) ? r : [...(r?.media || []).map((m) => ({ media: m })), ...(r?.errors || [])];
      return list.map((x, i) => (x?.error ? { path: x.path || paths[i], error: x.error }
        : x?.media ? x : x?.path && x?.kind ? { media: x } : { path: paths[i], error: { code: 'unsupported' } }));
    }
    const out = [];
    for (let i = 0; i < paths.length; i++) {
      onStep?.(i / paths.length, ui.basename(paths[i]));
      out.push(await probeFile(paths[i]).catch((err) => ({ path: paths[i], error: { code: 'damaged', message: err?.message } })));
    }
    return out;
  }

  // paths -> imported into the project (into binId, or into bins made from `bins`: path -> bin id). The files that
  // could not be imported are listed. -> the new media ids.
  async function importPaths(app, paths, { binId = null, bins = null } = {}) {
    const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p))];
    if (!unique.length) return [];
    const task = ide.tasks?.start({ title: tr('Importing media'), fraction: 0 });
    let results;
    try {
      results = await probeAll(unique, (f, name) => task?.update({ fraction: f, text: name }));
    } finally { task?.done(); }
    const ok = results.filter((r) => r.media);
    const failed = results.filter((r) => !r.media);
    const made = [];
    if (ok.length) {
      const groups = new Map();
      for (const r of ok) {
        const target = bins?.get(r.media.path) ?? bins?.get(unique.find((p) => p.toLowerCase() === String(r.media.path).toLowerCase()) || '') ?? binId;
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target).push(r.media);
      }
      app.history.begin(tr('Import'));
      try {
        for (const [target, list] of groups) made.push(...(app.history.do(Cut.commands.importMedia(list, target)).ids || []));
        app.history.commit();
      } catch (err) {
        app.history.cancel();
        ui.report(err);
        return [];
      }
    }
    if (failed.length) showImportErrors(failed);
    else if (made.length) ui.toast(tr('{n} files imported', { n: made.length }));
    for (const id of made) prefetch(app, id);
    if (made.length) ui.proxy?.offer?.(app, made)?.catch?.((err) => log.warn(`proxy offer: ${err?.message || err}`));
    return made;
  }
  function showImportErrors(failed) {
    const body = el('div', 'cut-import-errors');
    body.appendChild(el('div', 'dialog-message', tr('These files could not be imported:')));
    const list = el('ul', 'cut-import-error-list');
    for (const f of failed) {
      const li = el('li');
      const name = el('span', 'cut-import-error-name', ui.basename(f.path));
      name.dataset.userText = '';
      name.title = f.path;
      li.append(name, el('span', 'cut-import-error-reason', reasonText(f.error)));
      list.appendChild(li);
    }
    body.appendChild(list);
    ui.dialog({ title: tr('Import'), id: 'cutImportErrors', body, width: 520 });
  }
  // Thumbnails and peaks are made in the background, so the panel and the timeline have them when they need them.
  function prefetch(app, mediaId) {
    const m = app.project?.media.find((x) => x.id === mediaId);
    if (!m || !Cut.thumbs) return;
    const h = app.history;
    if (m.kind !== 'audio') Cut.thumbs.strip?.(app.project, mediaId, { from: 0, to: m.duration, count: SCRUB_FRAMES, height: THUMB_H, wanted: () => app.history === h }).catch(() => {});
    if (m.audio) Cut.thumbs.peaks?.(app.project, mediaId, { samplesPerPeak: 512 }).catch(() => {});
  }

  async function importDialog(app, { binId = currentBin } = {}) {
    const paths = await ide.api.invoke('cut:pickMedia', { multi: true, title: tr('Import Media'), filterName: tr('Media files'), allName: tr('All files') });
    if (!paths?.length) return [];
    return importPaths(app, paths, { binId });
  }
  // A folder: every media file under it, its subfolders as bins (inside the bin the folder itself becomes).
  async function importFolderPath(app, folder, { binId = currentBin } = {}) {
    const r = await ide.api.invoke('cut:listMedia', folder);
    if (r?.error) { ui.notify(tr('The folder could not be read: {error}', { error: r.error.message || r.error.code }), { kind: 'error' }); return []; }
    if (!r?.files?.length) { ui.toast(tr('There are no media files in that folder.')); return []; }
    const bins = new Map();
    const binOfDir = new Map();
    app.history.begin(tr('Import'));
    try {
      const top = app.history.do(Cut.commands.addBin(ui.basename(folder.replace(/[\\/]+$/, '')), binId)).id;
      binOfDir.set('', top);
      const ensure = (dir) => {
        if (binOfDir.has(dir)) return binOfDir.get(dir);
        const i = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
        const parent = ensure(i < 0 ? '' : dir.slice(0, i));
        const id = app.history.do(Cut.commands.addBin(i < 0 ? dir : dir.slice(i + 1), parent)).id;
        binOfDir.set(dir, id);
        return id;
      };
      for (const f of r.files) {
        const i = Math.max(f.rel.lastIndexOf('\\'), f.rel.lastIndexOf('/'));
        bins.set(f.path, ensure(i < 0 ? '' : f.rel.slice(0, i)));
      }
      app.history.commit();
    } catch (err) {
      app.history.cancel();
      ui.report(err);
      return [];
    }
    if (r.truncated) ui.notify(tr('The folder has too many files; only the first ones were imported.'), { kind: 'warn' });
    return importPaths(app, r.files.map((f) => f.path), { bins });
  }
  async function importFolder(app) {
    const folder = await ide.api.invoke('cut:pickFolder', { title: tr('Import Folder') });
    if (!folder) return [];
    return importFolderPath(app, folder);
  }

  // ---------- offline media and relinking ----------
  async function checkOffline(app, { ask = true } = {}) {
    const project = app.project;
    if (!project) return [];
    offline.clear();
    await Promise.all(project.media.map(async (m) => {
      const st = await ide.api.invoke('cut:stat', m.path).catch(() => ({ missing: true }));
      if (!st || st.missing || st.error || !st.isFile) offline.add(m.id);
    }));
    app.emit('offline', { ids: [...offline] });
    if (offline.size && ask) relinkDialog(app);
    return [...offline];
  }
  // Fills the media entry of a file found again.
  async function relinkTo(app, id, path) {
    const st = await ide.api.invoke('cut:stat', path);
    if (!st || st.missing || !st.isFile) return false;
    const old = app.project.media.find((m) => m.id === id)?.path;
    const r = ui.exec(app, Cut.commands.relinkMedia(id, { path: st.path || path, size: st.size, mtime: st.mtime }));
    if (!r) return false;
    offline.delete(id);
    if (old) Cut.media?.forget?.(old);
    return true;
  }
  // Offline media -> {paths: Map(media id -> path)} found under a folder: the same file name and size, else the same
  // name and a duration within a frame (a file saved again, or copied by a tool that changed its size).
  async function findInFolder(folder, list) {
    const named = (m) => ui.basename(m.path);
    const exact = await ide.api.invoke('cut:findMedia', folder, list.map((m) => ({ name: named(m), size: m.size })));
    if (!exact || exact.error) return { error: exact?.error || exact || 'error' };
    const paths = new Map();
    for (const m of list) if (exact[named(m)]) paths.set(m.id, exact[named(m)]);
    const rest = list.filter((m) => !paths.has(m.id) && m.kind !== 'image');
    if (!rest.length) return { paths };
    const loose = await ide.api.invoke('cut:findMedia', folder, rest.map((m) => ({ name: named(m) })));
    if (!loose || loose.error) return { paths };
    for (const m of rest) {
      const p = loose[named(m)];
      if (!p) continue;
      const [probed] = await probeAll([p]).catch(() => []);
      const d = probed?.media?.duration;
      const frame = m.video?.fps ? Cut.time.frameTicks(Cut.model.validFps(m.video.fps) ? m.video.fps : nearestRate(m.video.fps)) : Cut.time.TICKS / 100;
      if (Number.isFinite(d) && Math.abs(d - m.duration) <= frame) paths.set(m.id, p);
    }
    return { paths };
  }
  function relinkDialog(app) {
    const project = app.project;
    const missing = project.media.filter((m) => offline.has(m.id));
    if (!missing.length) return null;
    const body = el('div', 'cut-relink');
    body.appendChild(el('div', 'dialog-message', tr('These media files are offline: they were moved, renamed or deleted. Choose a folder to find them by name and size, or locate each one.')));
    const list = el('div', 'cut-relink-list');
    const draw = () => {
      list.replaceChildren();
      for (const m of project.media.filter((x) => missing.some((y) => y.id === x.id))) {
        const row = el('div', `cut-relink-row${offline.has(m.id) ? ' offline' : ' found'}`, undefined, { 'data-media': m.id });
        const name = el('span', 'cut-relink-name', m.name);
        name.dataset.userText = '';
        const where = el('span', 'cut-relink-path', m.path);
        where.dataset.userText = '';
        const state = el('span', 'cut-relink-state', offline.has(m.id) ? tr('Offline') : tr('Found'));
        const locate = button({ label: tr('Locate…'), cls: 'cut-relink-locate', onClick: async () => {
          const paths = await ide.api.invoke('cut:pickMedia', { multi: false, title: tr('Locate {name}', { name: m.name }), filterName: tr('Media files'), allName: tr('All files') });
          if (paths?.[0] && await relinkTo(app, m.id, paths[0])) { draw(); app.emit('offline', { ids: [...offline] }); }
        } });
        row.append(icon(offline.has(m.id) ? 'offline' : 'check'), name, where, state, locate);
        list.appendChild(row);
      }
    };
    draw();
    const status = el('div', 'cut-relink-status');
    body.append(list, status);
    const dlg = ui.dialog({
      title: tr('Relink Media'),
      id: 'cutRelinkDialog',
      body,
      width: 620,
      buttons: [
        { label: tr('Find in Folder…'), primary: true, run: async () => {
          const folder = await ide.api.invoke('cut:pickFolder', { title: tr('Find Media in Folder') });
          if (!folder) return false;
          status.textContent = tr('Searching…');
          const found = await findInFolder(folder, missing.filter((m) => offline.has(m.id)));
          let n = 0;
          if (found.error) status.textContent = tr('The folder could not be searched: {error}', { error: found.error.message || found.error.code || String(found.error) });
          else {
            app.history.begin(tr('Relink Media'));
            try {
              for (const m of missing) {
                const p = found.paths.get(m.id);
                if (p && offline.has(m.id) && await relinkTo(app, m.id, p)) n += 1;
              }
            } finally { app.history.commit(); }
          }
          app.emit('offline', { ids: [...offline] });
          status.textContent = tr('{n} files relinked, {left} still offline.', { n, left: missing.filter((m) => offline.has(m.id)).length });
          draw();
          return offline.size ? false : undefined;
        } },
        { label: tr('Close') },
      ],
    });
    return dlg;
  }

  // ---------- unused and missing media ----------
  // Media no clip of any sequence uses.
  const unusedIds = (project) => (project?.media || []).filter((m) => !project.sequences.some((s) => s.clips.some((c) => c.source?.media === m.id))).map((m) => m.id);
  function removeUnused(app) {
    const ids = unusedIds(app.project);
    if (!ids.length) { ui.toast(tr('There is no unused media.')); return null; }
    const body = el('div', 'cut-remove-unused');
    body.appendChild(el('div', 'dialog-message', tr('Remove these {n} media items that no sequence uses from the project? The files stay where they are.', { n: ids.length })));
    const list = el('ul', 'cut-remove-unused-list');
    for (const id of ids) {
      const m = app.project.media.find((x) => x.id === id);
      const li = el('li', null, m.name);
      li.dataset.userText = '';
      li.dataset.media = m.id;
      li.title = m.path;
      list.appendChild(li);
    }
    body.appendChild(list);
    return ui.dialog({
      title: tr('Remove Unused Media'),
      id: 'cutRemoveUnused',
      body,
      width: 480,
      buttons: [
        { label: tr('Remove'), primary: true, run: () => {
          // Checked again: an edit may have used one since the list was made.
          const now = new Set(unusedIds(app.project));
          const gone = ids.filter((id) => now.has(id));
          if (gone.length && ui.exec(app, Cut.commands.removeMedia(gone))) ui.toast(tr('{n} unused media items removed', { n: gone.length }));
        } },
        { label: tr('Cancel') },
      ],
    });
  }
  // Every media file is checked again; the offline ones go to the relink dialog.
  async function findMissing(app) {
    const ids = await checkOffline(app, { ask: false });
    if (!ids.length) { ui.toast(tr('No media is missing.')); return null; }
    return relinkDialog(app);
  }
  ui.onAction('selectUnused', () => { ui.showPanel('project'); ui.media.selectUnused?.(); });
  ui.onAction('removeUnused', ({ app }) => { removeUnused(app); });
  ui.onAction('findMissing', ({ app }) => { findMissing(app); });

  // ---------- sequences that follow their first clip ----------
  // Placing a clip whose size or frame rate differ: an empty sequence takes the clip's settings, a sequence with clips
  // asks once whether to. -> resolves when settled (true: the sequence changed).
  async function matchSequence(app, mediaId) {
    const seq = app.sequence;
    const m = app.project?.media.find((x) => x.id === mediaId);
    const v = m?.video;
    if (!seq || !v || m.kind !== 'video' || !v.w || !v.h) return false;
    // Media.video.w/h are already the upright size (media.js applies rotation and pixel aspect).
    const w = v.w;
    const h = v.h;
    const fps = Cut.model.validFps(v.fps) ? v.fps : nearestRate(v.fps);
    const same = seq.w === w && seq.h === h && seq.fps[0] === fps[0] && seq.fps[1] === fps[1];
    if (same) return false;
    if (seq.clips.length) {
      if (asked.has(seq.id)) return false;
      asked.add(seq.id);
      const yes = await ui.confirm(tr('This clip does not match the sequence settings ({clip}). Change the sequence to match the clip?',
        { clip: `${w}x${h} ${fpsLabel(fps)}` }), { title: tr('Clip Mismatch'), ok: tr('Change Sequence Settings') });
      if (!yes) return false;
    }
    return !!ui.exec(app, Cut.commands.setSequence(seq.id, { w: w - (w % 2), h: h - (h % 2), fps }));
  }
  const asked = new Set();
  const nearestRate = (fps) => {
    const v = fps ? fps[0] / fps[1] : 30;
    return Cut.time.FRAME_RATES.reduce((best, r) => (Math.abs(r[0] / r[1] - v) < Math.abs(best[0] / best[1] - v) ? r : best), [30, 1]);
  };
  const fpsLabel = (fps) => {
    if (!fps) return '';
    const v = fps[0] / fps[1];
    return `${Number.isInteger(v) ? v : v.toFixed(3).replace(/0+$/, '')} fps`;
  };

  // ---------- describing items ----------
  // Clips of the media in every sequence; a linked video and audio pair counts once.
  const usesOf = (project, mediaId) => {
    let n = 0;
    for (const s of project.sequences) {
      const links = new Set();
      for (const c of s.clips) {
        if (c.source?.media !== mediaId) continue;
        if (c.link) { if (links.has(c.link)) continue; links.add(c.link); }
        n += 1;
      }
    }
    return n;
  };
  function describe(m) {
    const fps = m.video?.fps;
    return {
      duration: m.kind === 'image' ? '' : Cut.time.timecode(m.duration, Cut.model.validFps(fps) ? fps : nearestRate(fps)),
      size: m.video ? `${m.video.w}x${m.video.h}` : '',
      fps: m.kind === 'video' ? fpsLabel(fps) : '',
      codec: [m.video?.codec?.split('.')[0], m.audio ? `${Math.round(m.audio.rate / 100) / 10} kHz` : ''].filter(Boolean).join(', '),
    };
  }
  const kindIcon = (m) => (m.kind === 'video' ? 'film' : m.kind === 'audio' ? 'audio' : 'image');

  // ---------- the panel ----------
  const THUMB_H = 90;
  const SCRUB_FRAMES = 12;
  let currentBin = null;

  function mount(root, app) {
    root.classList.add('cut-project');
    let view = ide.settings.get(settingKey, 'grid') === 'list' ? 'list' : 'grid';
    let query = '';
    let filter = null; // 'unused': the unused media of the whole project
    const selected = new Set();
    let anchor = null;

    // toolbar: made once (the search field keeps its text and caret), the list below is redrawn
    const bar = el('div', 'cut-panel-toolbar');
    const search = el('input', 'cut-search', undefined, { type: 'search', placeholder: tr('Search'), spellcheck: 'false' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); filter = null; draw(); });
    const listBtn = button({ icon: 'list', title: tr('List View'), toggle: true, pressed: view === 'list', cls: 'cut-view-list', onClick: () => setView('list') });
    const gridBtn = button({ icon: 'grid', title: tr('Icon View'), toggle: true, pressed: view === 'grid', cls: 'cut-view-grid', onClick: () => setView('grid') });
    const newBtn = button({ icon: 'add', title: tr('New Item'), cls: 'cut-new-item', onClick: () => ui.menu(newBtn, newItems()) });
    const moreBtn = button({ icon: 'more', title: tr('More'), cls: 'cut-project-more', onClick: () => { const m = ui.menu(moreBtn, moreItems()); if (m) m.id = 'cutProjectMore'; } });
    bar.append(
      button({ icon: 'download', title: tr('Import Media…'), cls: 'cut-import', onClick: () => importDialog(app) }),
      button({ icon: 'bin', title: tr('New Bin'), cls: 'cut-new-bin', onClick: () => newBin() }),
      newBtn, search, listBtn, gridBtn, moreBtn,
    );
    const offerSlot = el('div', 'cut-proxy-offer-slot');
    const crumbs = el('div', 'cut-crumbs');
    const items = el('div', 'cut-items', undefined, { tabindex: 0 });
    const foot = el('div', 'cut-panel-foot');
    root.append(bar, offerSlot, crumbs, items, foot);

    function setView(v) {
      view = v;
      ide.settings.set(settingKey, v);
      listBtn.setPressed(v === 'list');
      gridBtn.setPressed(v === 'grid');
      draw();
    }
    const newItems = () => [
      { label: tr('Sequence…'), icon: 'sequence', run: () => newSequenceDialog(app) },
      { label: tr('Bin'), icon: 'bin', run: () => newBin() },
      { separator: true },
      { label: tr('Text'), icon: 'textItem', run: () => newGenerated(app, { generator: 'text', layers: [Cut.model.createTextLayer({ text: tr('Title') })] }, tr('Text')) },
      { label: tr('Color Matte…'), icon: 'solid', run: () => colorMatte(app) },
      { separator: true },
      { label: tr('Import Folder…'), icon: 'folder', run: () => importFolder(app) },
    ];
    const selectedMedia = () => [...selected].filter((id) => app.project.media.some((m) => m.id === id));
    const moreItems = () => {
      const media = selectedMedia().map((id) => app.project.media.find((m) => m.id === id));
      const video = media.filter((m) => m.kind === 'video');
      return [
        { label: tr('Select Unused Media'), hint: ide.keymap.hint('Cut.selectUnused'), run: () => selectUnused() },
        { label: tr('Remove Unused Media…'), hint: ide.keymap.hint('Cut.removeUnused'), run: () => removeUnused(app) },
        { label: tr('Find Missing Media…'), hint: ide.keymap.hint('Cut.findMissing'), run: () => findMissing(app) },
        { separator: true },
        { label: tr('Create Proxy'), disabled: !video.length, run: () => ui.proxy?.create(app, video.map((m) => m.id)) },
        { label: tr('Remove Proxy'), disabled: !media.some((m) => m.proxy), run: () => ui.proxy?.remove(app, media.map((m) => m.id)) },
      ];
    };
    function selectUnused() {
      filter = 'unused';
      query = '';
      search.value = '';
      selected.clear();
      for (const id of unusedIds(app.project)) selected.add(id);
      anchor = [...selected][0] || null;
      draw();
      if (!selected.size) ui.toast(tr('There is no unused media.'));
    }
    function newBin() {
      const r = ui.exec(app, Cut.commands.addBin(tr('Bin'), currentBin));
      if (r?.id) { draw(); rename(r.id); }
    }

    // What the current bin holds: its sub-bins, then media and sequences; the search looks in every bin.
    const binsOf = (project, parent) => project.bins.filter((b) => (b.parent ?? null) === parent);
    const inSomeBin = (project, id) => project.bins.some((b) => b.items.includes(id));
    function entries() {
      const p = app.project;
      if (!p) return [];
      if (filter === 'unused') {
        const ids = new Set(unusedIds(p));
        return p.media.filter((m) => ids.has(m.id)).map((m) => ({ kind: 'media', id: m.id, name: m.name, item: m }));
      }
      const all = [
        ...p.bins.map((b) => ({ kind: 'bin', id: b.id, name: b.name, item: b })),
        ...p.media.map((m) => ({ kind: 'media', id: m.id, name: m.name, item: m })),
        ...p.sequences.map((s) => ({ kind: 'sequence', id: s.id, name: s.name, item: s })),
      ];
      if (query) {
        return all.filter((e) => {
          const d = e.kind === 'media' ? describe(e.item) : {};
          return [e.name, d.size, d.codec, d.fps, e.kind === 'media' ? e.item.path : ''].some((x) => String(x || '').toLowerCase().includes(query));
        });
      }
      const bin = currentBin ? p.bins.find((b) => b.id === currentBin) : null;
      return [
        ...binsOf(p, currentBin).map((b) => all.find((e) => e.id === b.id)),
        ...all.filter((e) => e.kind !== 'bin' && (bin ? bin.items.includes(e.id) : !inSomeBin(p, e.id))),
      ];
    }

    function drawCrumbs() {
      const p = app.project;
      crumbs.replaceChildren();
      const chain = [];
      for (let b = p?.bins.find((x) => x.id === currentBin); b; b = p.bins.find((x) => x.id === b.parent)) chain.unshift(b);
      const crumb = (label, id) => {
        const c = el('button', 'cut-crumb', label, { type: 'button', 'data-bin': id ?? '' });
        c.addEventListener('click', () => { currentBin = id; selected.clear(); draw(); });
        dropOnBin(c, id);
        return c;
      };
      crumbs.appendChild(crumb(tr('Project'), null));
      for (const b of chain) { crumbs.appendChild(el('span', 'cut-crumb-sep', '›')); const c = crumb(b.name, b.id); c.dataset.userText = ''; crumbs.appendChild(c); }
      crumbs.hidden = !chain.length && !query && !filter;
      if (query) crumbs.replaceChildren(el('span', 'cut-crumb-search', tr('Results in the whole project')));
      if (filter === 'unused') {
        const all = el('button', 'cut-crumb cut-crumb-all', tr('Show All'), { type: 'button' });
        all.addEventListener('click', () => { filter = null; draw(); });
        crumbs.replaceChildren(el('span', 'cut-crumb-search', tr('Unused media in the whole project')), all);
      }
    }

    // Every redraw makes new rows, so the drop targets of the old ones go first. A name being typed holds redraws
    // back until it is done (a redraw would take the field away).
    let renaming = null;
    function draw() { if (renaming) return; clearTargets(); render(); }
    let drawQueued = false;
    const later = () => {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(() => { drawQueued = false; draw(); });
    };
    function render() {
      const p = app.project;
      if (currentBin && !p?.bins.some((b) => b.id === currentBin)) currentBin = null;
      drawCrumbs();
      const list = entries();
      for (const id of [...selected]) if (!list.some((e) => e.id === id)) selected.delete(id);
      items.className = `cut-items ${view}`;
      items.replaceChildren();
      offerSlot.replaceChildren(...[ui.proxy?.offerBanner?.(app)].filter(Boolean));
      if (view === 'list') items.appendChild(header());
      for (const e of list) items.appendChild(view === 'list' ? listRow(e) : card(e));
      if (!list.length) items.appendChild(el('div', 'cut-empty', filter === 'unused' ? tr('Every media item is used.') : query ? tr('Nothing matches.') : tr('Import media to start: drop files here or use Import.')));
      foot.textContent = tr('{n} items', { n: list.length }) + (offline.size ? ` · ${tr('{n} offline', { n: offline.size })}` : '');
    }
    function header() {
      const h = el('div', 'cut-row-head');
      for (const [cls, label] of [['name', tr('Name')], ['dur', tr('Duration')], ['size', tr('Video')], ['fps', tr('Frame Rate')], ['codec', tr('Codec')], ['uses', tr('Uses')]]) {
        h.appendChild(el('span', `cut-col ${cls}`, label));
      }
      return h;
    }
    function rowCommon(n, e) {
      n.dataset.id = e.id;
      n.dataset.kind = e.kind;
      n.classList.toggle('selected', selected.has(e.id));
      if (e.kind === 'media' && offline.has(e.id)) n.classList.add('offline');
      n.addEventListener('pointerdown', (ev) => {
        if (ev.button === 2) { if (!selected.has(e.id)) choose(e.id, {}); return; }
        if (ev.button !== 0 || ev.target.closest('input')) return;
        if (ev.ctrlKey || ev.shiftKey || !selected.has(e.id)) choose(e.id, { ctrl: ev.ctrlKey, shift: ev.shiftKey });
        if (e.kind !== 'bin') {
          const ids = selected.has(e.id) ? [...selected] : [e.id];
          const mediaIds = ids.filter((id) => app.project.media.some((m) => m.id === id));
          const payload = e.kind === 'sequence' ? { kind: 'sequence', id: e.id } : { kind: 'media', ids: mediaIds, binIds: ids.filter((id) => app.project.bins.some((b) => b.id === id)) };
          ui.dnd.start(ev, payload, { label: ids.length > 1 ? tr('{n} items', { n: ids.length }) : e.name });
        } else ui.dnd.start(ev, { kind: 'bin', ids: [e.id] }, { label: e.name });
      });
      n.addEventListener('dblclick', (ev) => { if (!ev.target.closest('input')) openEntry(e); });
      n.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ui.menu(ev.clientX, ev.clientY, contextItems(e)); });
      if (e.kind === 'bin') dropOnBin(n, e.id);
    }
    function nameCell(e, cls) {
      const c = el('span', cls);
      c.appendChild(icon(e.kind === 'bin' ? 'bin' : e.kind === 'sequence' ? 'sequence' : offline.has(e.id) ? 'offline' : kindIcon(e.item)));
      const n = el('span', 'cut-item-name', e.name);
      n.dataset.userText = '';
      c.appendChild(n);
      if (e.kind === 'media') {
        const p = ui.proxy?.state?.(e.item);
        if (p && p.state !== 'none') c.appendChild(proxyBadge(p));
      }
      return c;
    }
    const PROXY_TEXT = {
      waiting: () => tr('Proxy queued'), running: (p) => tr('Making proxy {pct}%', { pct: Math.floor(p.fraction * 100) }), paused: () => tr('Proxy waits while playing'),
      ready: () => tr('Has a proxy'), missing: () => tr('Proxy file missing: the original plays'), failed: (p) => tr('The proxy could not be made: {error}', { error: tr(String(p.error || '')) }),
    };
    function proxyBadge(p) {
      const label = p.state === 'running' ? `P ${Math.floor(p.fraction * 100)}%` : 'P';
      const b = el('span', 'cut-proxy-badge', label, { 'data-state': p.state });
      b.title = (PROXY_TEXT[p.state] || (() => ''))(p);
      return b;
    }
    function listRow(e) {
      const r = el('div', 'cut-item-row');
      rowCommon(r, e);
      r.appendChild(nameCell(e, 'cut-col name'));
      if (e.kind === 'media') {
        const d = describe(e.item);
        r.append(el('span', 'cut-col dur', offline.has(e.id) ? tr('Offline') : d.duration), el('span', 'cut-col size', d.size), el('span', 'cut-col fps', d.fps),
          el('span', 'cut-col codec', d.codec), el('span', 'cut-col uses', String(usesOf(app.project, e.id) || '')));
      } else if (e.kind === 'sequence') {
        const s = e.item;
        r.append(el('span', 'cut-col dur', Cut.time.timecode(Cut.model.sequenceDuration(s), s.fps)), el('span', 'cut-col size', `${s.w}x${s.h}`),
          el('span', 'cut-col fps', fpsLabel(s.fps)), el('span', 'cut-col codec', ''), el('span', 'cut-col uses', ''));
      } else r.append(...['dur', 'size', 'fps', 'codec', 'uses'].map((c) => el('span', `cut-col ${c}`, '')));
      if (e.id === app.sequenceId) r.classList.add('active-sequence');
      return r;
    }
    function card(e) {
      const c = el('div', 'cut-item-card');
      rowCommon(c, e);
      const thumb = el('div', 'cut-thumb');
      if (e.kind === 'media' && e.item.kind !== 'audio' && !offline.has(e.id)) {
        const canvas = el('canvas', 'cut-thumb-canvas');
        canvas.width = 160;
        canvas.height = THUMB_H;
        thumb.appendChild(canvas);
        const head = el('div', 'cut-scrub-head');
        thumb.appendChild(head);
        hoverScrub(thumb, canvas, head, e.item);
      } else thumb.appendChild(icon(e.kind === 'bin' ? 'bin' : e.kind === 'sequence' ? 'sequence' : offline.has(e.id) ? 'offline' : kindIcon(e.item)));
      if (e.kind === 'media' && e.item.kind !== 'image') thumb.appendChild(el('span', 'cut-thumb-dur', offline.has(e.id) ? tr('Offline') : describe(e.item).duration));
      c.append(thumb, nameCell(e, 'cut-card-name'));
      return c;
    }
    // The thumbnail shows the frame under the pointer: the strip of SCRUB_FRAMES frames is fetched once (cached by
    // Cut.thumbs) and the pointer's place picks one.
    function hoverScrub(thumb, canvas, head, m) {
      let frames = null;
      let loading = null;
      const ctx = canvas.getContext('2d');
      const paint = (i) => {
        const bmp = frames?.[Math.max(0, Math.min(frames.length - 1, i))];
        if (!bmp) return;
        const s = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
        const w = bmp.width * s;
        const h = bmp.height * s;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      };
      const load = () => {
        if (loading || !Cut.thumbs?.strip) return loading;
        const count = m.kind === 'image' ? 1 : SCRUB_FRAMES;
        const h = app.history;
        loading = Cut.thumbs.strip(app.project, m.id, { from: 0, to: m.duration, count, height: THUMB_H, wanted: () => app.history === h })
          .then((list) => { frames = list; thumb.dataset.frames = String(list?.length || 0); paint(0); })
          .catch((err) => { log.warn(`thumbnails of ${m.name}: ${err?.message || err}`); });
        return loading;
      };
      load();
      if (m.kind === 'image') return;
      thumb.addEventListener('pointermove', (ev) => {
        const r = thumb.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        const i = Math.min(SCRUB_FRAMES - 1, Math.floor(f * SCRUB_FRAMES));
        thumb.dataset.scrub = String(i);
        thumb.dataset.scrubT = String(Math.round((m.duration * i) / SCRUB_FRAMES));
        head.style.left = `${f * 100}%`;
        thumb.classList.add('scrubbing');
        if (frames) paint(i); else load()?.then(() => paint(i));
      });
      thumb.addEventListener('pointerleave', () => { thumb.classList.remove('scrubbing'); delete thumb.dataset.scrub; paint(0); });
    }

    function choose(id, { ctrl = false, shift = false } = {}) {
      const order = entries().map((e) => e.id);
      if (shift && anchor && order.includes(anchor)) {
        const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
        if (!ctrl) selected.clear();
        for (const x of order.slice(a, b + 1)) selected.add(x);
      } else if (ctrl) {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        anchor = id;
      } else {
        selected.clear();
        selected.add(id);
        anchor = id;
      }
      for (const n of items.querySelectorAll('[data-id]')) n.classList.toggle('selected', selected.has(n.dataset.id));
    }
    function openEntry(e) {
      if (e.kind === 'bin') { currentBin = e.id; selected.clear(); search.value = ''; query = ''; draw(); return; }
      if (e.kind === 'sequence') { app.setSequence(e.id); ui.showPanel('timeline'); return; }
      if (offline.has(e.id)) { relinkDialog(app); return; }
      app.setSource({ mediaId: e.id, in: null, out: null, t: 0 });
      ui.showPanel('source');
    }
    function rename(id) {
      const n = items.querySelector(`[data-id="${id}"] .cut-item-name`);
      if (!n) return;
      const item = [...app.project.bins, ...app.project.media, ...app.project.sequences].find((x) => x.id === id);
      const input = el('input', 'cut-rename', undefined, { type: 'text', spellcheck: 'false' });
      input.value = item.name;
      n.replaceWith(input);
      input.focus();
      input.select();
      renaming = id;
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        renaming = null;
        const v = input.value.trim();
        if (commit && v && v !== item.name) ui.exec(app, Cut.commands.renameItem(id, v));
        draw();
        items.focus({ preventScroll: true });
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.isComposing) return;
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }
    function removeSelectedItems() {
      const p = app.project;
      const ids = [...selected];
      if (!ids.length) return false;
      const media = ids.filter((id) => p.media.some((m) => m.id === id));
      const seqs = ids.filter((id) => p.sequences.some((s) => s.id === id));
      const bins = ids.filter((id) => p.bins.some((b) => b.id === id));
      if (seqs.length && seqs.length >= p.sequences.length) { ui.toast(tr('A project keeps at least one sequence.')); return true; }
      app.history.begin(tr('Clear'));
      try {
        if (media.length) app.history.do(Cut.commands.removeMedia(media));
        for (const id of seqs) app.history.do(Cut.commands.removeSequence(id));
        for (const id of bins) app.history.do(Cut.commands.removeBin(id));
        app.history.commit();
      } catch (err) { app.history.cancel(); ui.report(err); }
      if (seqs.includes(app.sequenceId)) app.setSequence(app.project.sequences[0]?.id || null);
      selected.clear();
      return true;
    }
    function contextItems(e) {
      const list = [];
      if (e.kind === 'media') {
        list.push({ label: tr('Open in Source Monitor'), run: () => openEntry(e) });
        if (offline.has(e.id)) list.push({ label: tr('Relink Media…'), run: () => relinkDialog(app) });
        if (e.item.kind === 'video' && ui.proxy) {
          const st = ui.proxy.state(e.item).state;
          const ids = selected.has(e.id) ? selectedMedia() : [e.id];
          if (st === 'waiting' || st === 'running' || st === 'paused') list.push({ label: tr('Cancel Proxy'), run: () => { for (const id of ids) ui.proxy.cancel(id); } });
          else list.push({ label: e.item.proxy ? tr('Create Proxy Again') : tr('Create Proxy'), run: () => { if (e.item.proxy) ui.proxy.remove(app, ids); ui.proxy.create(app, ids); } });
          if (e.item.proxy) list.push({ label: tr('Remove Proxy'), run: () => ui.proxy.remove(app, ids) });
        }
        if (e.item.audio && ui.voice) list.push({ label: tr('Isolate Voice'), run: () => ui.voice.isolateMedia(app, selected.has(e.id) ? selectedMedia() : [e.id]).catch((err) => ui.report(err)) });
        list.push({ label: tr('Reveal in Explorer'), run: () => ide.api.invoke('cut:reveal', e.item.path) });
        list.push({ label: tr('New Sequence from Clip'), run: () => sequenceFromClip(app, e.item) });
      }
      if (e.kind === 'sequence') {
        list.push({ label: tr('Open in Timeline'), run: () => openEntry(e) });
        list.push({ label: tr('Duplicate'), run: () => { const r = ui.exec(app, Cut.commands.addSequence({ from: e.id, name: tr('{name} Copy', { name: e.name }) })); if (r?.id) app.setSequence(r.id); } });
        list.push({ label: tr('Sequence Settings…'), run: () => newSequenceDialog(app, e.item) });
      }
      if (e.kind === 'bin') list.push({ label: tr('Open Bin'), run: () => openEntry(e) });
      list.push({ label: tr('Rename'), hint: 'F2', run: () => rename(e.id) });
      if (selected.size) {
        const moveTo = app.project.bins.filter((b) => !selected.has(b.id)).map((b) => ({ label: b.name, userText: true, run: () => ui.exec(app, Cut.commands.moveToBin([...selected], b.id)) }));
        list.push({ label: tr('Move to Bin'), submenu: [{ label: tr('Project'), run: () => ui.exec(app, Cut.commands.moveToBin([...selected], null)) }, ...moveTo] });
      }
      list.push({ separator: true }, { label: tr('Clear'), hint: 'Delete', run: removeSelectedItems });
      return list;
    }

    // Items dragged onto a bin (a row, a card or a crumb) move into it.
    const dropTargets = [];
    function dropOnBin(node, binId) {
      dropTargets.push(ui.dnd.target(node, {
        accepts: (p) => (p.kind === 'media' || p.kind === 'bin' || p.kind === 'sequence') && !(p.kind === 'bin' && p.ids.includes(binId)),
        over: () => node.classList.add('drop-over'),
        leave: () => node.classList.remove('drop-over'),
        drop: (p) => {
          const ids = p.kind === 'sequence' ? [p.id] : [...(p.ids || []), ...(p.binIds || [])];
          if (ids.length) ui.exec(app, Cut.commands.moveToBin(ids, binId));
        },
      }));
    }
    const clearTargets = () => { for (const off of dropTargets.splice(0)) off(); };

    // Files dropped from Explorer (native drag and drop) are imported into the current bin.
    root.addEventListener('dragover', (ev) => {
      if (![...ev.dataTransfer.types].includes('Files')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      root.classList.add('drop-files');
    });
    root.addEventListener('dragleave', (ev) => { if (!root.contains(ev.relatedTarget)) root.classList.remove('drop-files'); });
    root.addEventListener('drop', async (ev) => {
      root.classList.remove('drop-files');
      if (!ev.dataTransfer.files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const paths = [...ev.dataTransfer.files].map((f) => { try { return ide.api.pathForFile(f); } catch { return null; } }).filter(Boolean);
      await importDropped(app, paths);
    });

    items.addEventListener('keydown', (ev) => {
      if (ui.isTyping(ev.target)) return;
      const order = entries();
      const at = order.findIndex((x) => x.id === anchor);
      const go = (i) => { const e = order[Math.max(0, Math.min(order.length - 1, i))]; if (e) { choose(e.id, { shift: ev.shiftKey }); anchor = ev.shiftKey ? anchor : e.id; items.querySelector(`[data-id="${e.id}"]`)?.scrollIntoView({ block: 'nearest' }); } };
      const cols = view === 'grid' ? Math.max(1, Math.floor(items.clientWidth / 150)) : 1;
      const handled = {
        ArrowDown: () => go(at + cols), ArrowUp: () => go(at - cols), ArrowRight: () => view === 'grid' && go(at + 1), ArrowLeft: () => view === 'grid' && go(at - 1),
        Home: () => go(0), End: () => go(order.length - 1),
        Enter: () => { const e = order[at]; if (e) openEntry(e); },
        F2: () => { if (anchor) rename(anchor); },
        Backspace: () => { if (currentBin && !selected.size) { currentBin = app.project.bins.find((b) => b.id === currentBin)?.parent ?? null; draw(); } else return false; },
      }[ev.key];
      if (handled && handled() !== false) { ev.preventDefault(); ev.stopPropagation(); }
    });
    items.addEventListener('pointerdown', (ev) => { if (ev.target === items) { selected.clear(); draw(); } });
    const offDelete = ui.onAction('delete', () => removeSelectedItems(), { panels: ['project'] });
    const offs = [
      offDelete,
      app.on('project', later),
      app.on('offline', later),
      app.on('sequence', later),
      app.on('proxies', later),
    ];
    draw();
    ui.media.select = (ids) => { selected.clear(); for (const id of ids) selected.add(id); draw(); };
    ui.media.visibleItems = () => entries().map((e) => e.id);
    ui.media.selected = () => selectedMedia();
    ui.media.selectUnused = () => selectUnused();
    ui.media.filter = () => filter;
    return { dispose: () => { for (const off of offs) off(); clearTargets(); }, focus: () => items.focus({ preventScroll: true }) };
  }

  // Dropped paths: folders through importFolderPath, caption files (.srt, .vtt) as a caption track each of the open
  // sequence (on the project panel or the timeline alike; they were refused as media before), files together.
  // -> the new media ids.
  const CAPTION_FILE = /\.(srt|vtt)$/i;
  async function importDropped(app, paths) {
    const files = [];
    const made = [];
    for (const p of paths) {
      const st = await ide.api.invoke('cut:stat', p).catch(() => null);
      if (st && !st.missing && !st.isFile) made.push(...await importFolderPath(app, p));
      else if (CAPTION_FILE.test(p) && ui.captions?.importFile) await ui.captions.importFile(app, p, { newTrack: true });
      else files.push(p);
    }
    if (files.length) made.push(...await importPaths(app, files, { binId: currentBin }));
    return made;
  }
  // Paths dropped on the timeline -> media ids in the order dropped (a folder's files in its order): a file already in
  // the project is used as it is, the others are imported.
  async function mediaForPaths(app, paths) {
    const key = (p) => String(p).replace(/\//g, '\\').toLowerCase();
    const have = new Map(app.project.media.map((m) => [key(m.path), m.id]));
    const fresh = paths.filter((p) => !have.has(key(p)));
    const made = fresh.length ? await importDropped(app, fresh) : [];
    const madeMedia = made.map((id) => app.project.media.find((m) => m.id === id)).filter(Boolean);
    const out = [];
    for (const p of paths) {
      if (have.has(key(p))) { out.push(have.get(key(p))); continue; }
      const k = key(p);
      const under = k.endsWith('\\') ? k : `${k}\\`;
      for (const m of madeMedia) if (key(m.path) === k || key(m.path).startsWith(under)) out.push(m.id);
    }
    // main may answer with another spelling of a path (its real path): what was imported is placed all the same.
    for (const m of madeMedia) out.push(m.id);
    return [...new Set(out)];
  }

  // ---------- new sequence, text and color items ----------
  function newSequenceDialog(app, editing = null) {
    const presets = Cut.presets?.sequencePresets?.() || Cut.presets?.SEQUENCE || [
      { id: 'youtube-1080p30', name: 'YouTube 1080p30', w: 1920, h: 1080, fps: [30, 1] },
      { id: 'youtube-4k30', name: 'YouTube 4K30', w: 3840, h: 2160, fps: [30, 1] },
      { id: 'shorts', name: 'Shorts 1080x1920', w: 1080, h: 1920, fps: [30, 1] },
      { id: 'square', name: 'Square 1080x1080', w: 1080, h: 1080, fps: [30, 1] },
    ];
    const seq = editing;
    const name = el('input', 'cut-seq-name', undefined, { type: 'text', spellcheck: 'false' });
    name.value = seq ? seq.name : tr('Sequence {n}', { n: app.project.sequences.length + 1 });
    const preset = ui.select({ options: [...presets.map((p) => ({ value: p.id, label: tr(p.name) })), { value: 'custom', label: tr('Custom') }], value: seq ? 'custom' : presets[0].id });
    const w = ui.numberField({ value: seq?.w ?? presets[0].w, min: 16, max: 7680, step: 2, precision: 0, unit: 'px', cls: 'cut-seq-w' });
    const h = ui.numberField({ value: seq?.h ?? presets[0].h, min: 16, max: 4320, step: 2, precision: 0, unit: 'px', cls: 'cut-seq-h' });
    const rates = Cut.time.FRAME_RATES.map((r) => ({ value: r.join('/'), label: fpsLabel(r) }));
    const fps = ui.select({ options: rates, value: (seq?.fps ?? presets[0].fps).join('/') });
    const bg = el('input', 'cut-seq-bg', undefined, { type: 'color' });
    bg.value = seq?.background ?? '#000000';
    preset.addEventListener('change', () => {
      const p = presets.find((x) => x.id === preset.value);
      if (!p) return;
      w.value = p.w;
      h.value = p.h;
      fps.value = p.fps.join('/');
    });
    const body = el('div', 'cut-form');
    body.append(ui.row(tr('Name'), name), ui.row(tr('Preset'), preset), ui.row(tr('Width'), w), ui.row(tr('Height'), h),
      ui.row(tr('Frame rate'), fps), ui.row(tr('Sample rate'), el('span', 'cut-form-value', '48 kHz')), ui.row(tr('Background'), bg));
    ui.dialog({
      title: seq ? tr('Sequence Settings') : tr('New Sequence'),
      id: 'cutSequenceDialog',
      body,
      width: 440,
      buttons: [
        { label: tr('OK'), primary: true, run: () => {
          const opts = { name: name.value.trim() || tr('Sequence'), w: w.value - (w.value % 2), h: h.value - (h.value % 2), fps: fps.value.split('/').map(Number), background: bg.value };
          if (seq) { ui.exec(app, Cut.commands.setSequence(seq.id, opts)); return; }
          const r = ui.exec(app, Cut.commands.addSequence({ ...opts, binId: currentBin ?? undefined }));
          if (r?.id) app.setSequence(r.id);
        } },
        { label: tr('Cancel') },
      ],
    });
  }
  function sequenceFromClip(app, m) {
    const v = m.video;
    const opts = { name: m.name.replace(/\.[^.]+$/, '') };
    if (v?.w) { opts.w = v.w - (v.w % 2); opts.h = v.h - (v.h % 2); }
    if (v?.fps) opts.fps = Cut.model.validFps(v.fps) ? v.fps : nearestRate(v.fps);
    app.history.begin(tr('New Sequence'));
    try {
      const { id } = app.history.do(Cut.commands.addSequence(opts));
      const seq = app.project.sequences.find((s) => s.id === id);
      app.history.do(Cut.commands.place(id, { source: { media: m.id }, at: 0, video: m.video ? seq.tracks.find((t) => t.kind === 'video').id : null,
        audio: m.audio ? seq.tracks.find((t) => t.kind === 'audio').id : null, mode: 'overwrite' }));
      app.history.commit();
      app.setSequence(id);
    } catch (err) { app.history.cancel(); ui.report(err); }
  }
  // A text or color clip at the playhead, on the patched video track.
  function newGenerated(app, source, name) {
    const seq = app.sequence;
    const track = ui.patchFor(app).video;
    if (!seq || !track) return void ui.toast(tr('There is no video track.'));
    const r = ui.exec(app, Cut.commands.addGenerated(seq.id, { track, at: app.t, source, name, mode: 'overwrite' }));
    if (r?.id) { app.select([r.id]); ui.showPanel(source.generator === 'text' ? 'text' : 'timeline'); }
  }
  function colorMatte(app) {
    const color = el('input', 'cut-matte-color', undefined, { type: 'color' });
    color.value = '#2f6fdb';
    const body = el('div', 'cut-form');
    body.appendChild(ui.row(tr('Color'), color));
    ui.dialog({ title: tr('Color Matte'), id: 'cutMatteDialog', body, width: 360,
      buttons: [{ label: tr('OK'), primary: true, run: () => newGenerated(app, { generator: 'solid', color: color.value }, tr('Color Matte')) }, { label: tr('Cancel') }] });
  }

  ui.offline = offline;
  ui.media = { importDialog, importFolder, importFolderPath, importPaths, importDropped, mediaForPaths, checkOffline, relinkDialog, relinkTo, findInFolder, offline, matchSequence, describe, probeFile, newSequenceDialog,
    unusedIds, removeUnused, findMissing };
  // Opening a project looks for its files; a new one has none.
  ui.registerPanel('project', { title: () => tr('Project'), mount });
})();
