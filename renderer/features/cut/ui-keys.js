// The editor's keyboard (video-editor-features.md section 18): every key is an IDE action 'Cut.<id>' (so Find Action
// lists them and the keymap can change them), and its run hands the action to Cut.ui.runAction, which gives it to
// the panel with the keyboard. Keys never act while a person types in a field or a text layer, and a key that the
// focused panel does not handle is left alone (the arrows of the project list stay the list's).
//
// Project-wide actions (undo, save, export, tools, workspaces) are handled here; so are defaults for the edits that
// need only the selection and the playhead (split, ripple delete, Q/W, enable, link, speed, freeze frame, markers,
// copy and paste), which the timeline may replace with its own handlers (the newest handler goes first).
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el } = ui;

  // [id, title, keys, scope]. scope 'panel': only when the focused panel has a handler; 'global': whatever has the
  // keyboard; 'always': even while typing (save, open: the IDE's way for Ctrl+S).
  const ACTIONS = [
    ['playPause', 'Play/Stop', 'Space'],
    ['shuttleBack', 'Shuttle Left', 'J'],
    ['shuttleStop', 'Shuttle Stop', 'K'],
    ['shuttleForward', 'Shuttle Right', 'L'],
    ['frameBack', 'Step Back One Frame', 'ArrowLeft'],
    ['frameForward', 'Step Forward One Frame', 'ArrowRight'],
    ['frameBack5', 'Step Back Five Frames', 'Shift+ArrowLeft'],
    ['frameForward5', 'Step Forward Five Frames', 'Shift+ArrowRight'],
    ['prevEdit', 'Go to Previous Edit Point', 'ArrowUp'],
    ['nextEdit', 'Go to Next Edit Point', 'ArrowDown'],
    ['goStart', 'Go to Start', 'Home'],
    ['goEnd', 'Go to End', 'End'],
    ['goIn', 'Go to In', 'Shift+I'],
    ['goOut', 'Go to Out', 'Shift+O'],
    ['markIn', 'Mark In', 'I'],
    ['markOut', 'Mark Out', 'O'],
    ['markClip', 'Mark Clip', 'X'],
    ['clearInOut', 'Clear In and Out', 'Alt+X'],
    ['addMarker', 'Add Marker', 'M'],
    ['insert', 'Insert', ','],
    ['overwrite', 'Overwrite', '.'],
    ['lift', 'Lift', ';'],
    ['extract', 'Extract', "'"],
    ['split', 'Add Edit', 'Ctrl+K'],
    ['splitAll', 'Add Edit to All Tracks', 'Ctrl+Shift+K'],
    ['rippleStart', 'Ripple Trim Previous Edit to Playhead', 'Q'],
    ['rippleEnd', 'Ripple Trim Next Edit to Playhead', 'W'],
    ['rippleDelete', 'Ripple Delete', 'Shift+Delete'],
    ['delete', 'Clear', ['Delete', 'Backspace']],
    ['toggleEnabled', 'Enable', 'Shift+E'],
    ['link', 'Link/Unlink', 'Ctrl+L'],
    ['group', 'Group', 'Ctrl+G'],
    ['ungroup', 'Ungroup', 'Ctrl+Shift+G'],
    ['nudgeLeft', 'Nudge Clip Selection Left One Frame', 'Alt+ArrowLeft'],
    ['nudgeRight', 'Nudge Clip Selection Right One Frame', 'Alt+ArrowRight'],
    ['nudgeLeft5', 'Nudge Clip Selection Left Five Frames', 'Alt+Shift+ArrowLeft'],
    ['nudgeRight5', 'Nudge Clip Selection Right Five Frames', 'Alt+Shift+ArrowRight'],
    ['selectAtPlayhead', 'Select Clip at Playhead', 'D'],
    ['matchFrame', 'Match Frame', 'F'],
    ['extendEdit', 'Extend Selected Edit to Playhead', 'E'],
    ['speed', 'Speed/Duration…', 'Ctrl+R'],
    ['freezeFrame', 'Insert Frame Hold', 'Shift+F'],
    ['transitionVideo', 'Apply Video Transition', 'Ctrl+D'],
    ['transitionAudio', 'Apply Audio Transition', 'Ctrl+Shift+D'],
    ['transitionBoth', 'Apply Default Transitions', 'Shift+D'],
    ['cut', 'Cut', 'Ctrl+X'],
    ['copy', 'Copy', 'Ctrl+C'],
    ['paste', 'Paste', 'Ctrl+V'],
    ['pasteInsert', 'Paste Insert', 'Ctrl+Shift+V'],
    ['selectAll', 'Select All', 'Ctrl+A'],
    ['deselect', 'Deselect All', 'Escape'],
    ['tool.select', 'Selection Tool', 'V'],
    ['tool.trackForward', 'Track Select Forward Tool', 'A'],
    ['tool.trackBackward', 'Track Select Backward Tool', 'Shift+A'],
    ['tool.ripple', 'Ripple Edit Tool', 'B'],
    ['tool.roll', 'Rolling Edit Tool', 'N'],
    ['tool.rate', 'Rate Stretch Tool', 'R'],
    ['tool.razor', 'Razor Tool', 'C'],
    ['tool.slip', 'Slip Tool', 'Y'],
    ['tool.slide', 'Slide Tool', 'U'],
    ['tool.pen', 'Pen Tool', 'P'],
    ['tool.hand', 'Hand Tool', 'H'],
    ['tool.zoom', 'Zoom Tool', 'Z'],
    ['tool.text', 'Type Tool', 'T'],
    ['snap', 'Snap', 'S'],
    ['zoomIn', 'Zoom In', '='],
    ['zoomOut', 'Zoom Out', '-'],
    ['zoomFit', 'Zoom to Sequence', '\\'],
    ['fullscreen', 'Full Screen Playback', 'Ctrl+`', 'global'],
    ['undo', 'Undo', 'Ctrl+Z', 'global'],
    ['redo', 'Redo', ['Ctrl+Shift+Z', 'Ctrl+Y'], 'global'],
    ['save', 'Save Project', 'Ctrl+S', 'always'],
    ['saveAs', 'Save Project As…', 'Ctrl+Shift+S', 'always'],
    ['open', 'Open Project…', 'Ctrl+O', 'always'],
    ['newProject', 'New Project', 'Ctrl+Alt+N', 'always'],
    ['import', 'Import Media…', 'Ctrl+I', 'global'],
    ['export', 'Export Media…', 'Ctrl+M', 'always'],
    ['exportFrame', 'Export Frame…', 'Ctrl+Shift+E', 'global'],
    ['workspace.editing', 'Editing Workspace', 'Alt+Shift+1', 'always'],
    ['workspace.color', 'Color Workspace', 'Alt+Shift+2', 'always'],
    ['workspace.captions', 'Captions and Graphics Workspace', 'Alt+Shift+3', 'always'],
    ['workspace.export', 'Export Workspace', 'Alt+Shift+4', 'always'],
    // the shortcut editor and the ? cheat sheet (ui-shortcuts.js), the settings page (ui-settings.js), media cleanup
    // (ui-project.js) and proxies (ui-proxy.js)
    ['keyHelp', 'Keyboard Shortcut Overview', 'Shift+/', 'global'],
    ['keyboardShortcuts', 'Keyboard Shortcuts…', [], 'always'],
    ['settings', 'Video Editor Settings…', [], 'always'],
    ['selectUnused', 'Select Unused Media', [], 'global'],
    ['removeUnused', 'Remove Unused Media…', [], 'global'],
    ['findMissing', 'Find Missing Media…', [], 'global'],
    ['createProxy', 'Create Proxy', [], 'global'],
  ];
  // The kinds the shortcut editor and the cheat sheet group the actions by (an id's first match).
  const KINDS = [
    ['playback', 'Playback and Navigation', /^(playPause|shuttle|frame|prevEdit|nextEdit|goStart|goEnd|goIn|goOut|fullscreen)/],
    ['marks', 'Marking', /^(markIn|markOut|markClip|clearInOut|addMarker)$/],
    ['tools', 'Tools', /^(tool\.|snap$)/],
    ['view', 'View', /^(zoomIn|zoomOut|zoomFit|keyHelp)$/],
    ['project', 'Project', /^(undo|redo|save|saveAs|open|newProject|import|export|exportFrame|keyboardShortcuts|settings)$/],
    ['media', 'Media', /^(selectUnused|removeUnused|findMissing|createProxy)$/],
    ['workspaces', 'Workspaces and Panels', /^(workspace\.|window\.)/],
    ['automation', 'Automation', /^auto\./],
    ['editing', 'Editing', /./],
  ];
  const kindOf = (id) => KINDS.find(([, , re]) => re.test(id))[0];
  const TITLES = new Map(ACTIONS.map(([id, title]) => [id, title]));

  // The keyboard belongs to the editor when it is in the editor's window part (not a dialog, a menu or the status bar).
  const inEditor = () => {
    const a = document.activeElement;
    return !!document.querySelector('.cut-root') && (!a || a === document.body || !!a.closest?.('.cut-root'));
  };
  // A range slider or a select keeps its arrow keys.
  const ownsArrows = () => {
    const a = document.activeElement;
    return a?.tagName === 'INPUT' && ['range', 'radio'].includes(a.type);
  };
  const ARROWS = new Set(['frameBack', 'frameForward', 'frameBack5', 'frameForward5', 'prevEdit', 'nextEdit', 'nudgeLeft', 'nudgeRight', 'nudgeLeft5', 'nudgeRight5']);
  function allowed(id, scope) {
    if (!inEditor() && scope !== 'always') return false;
    if (scope === 'always') return !!document.querySelector('.cut-root');
    if (ui.isTyping()) return false;
    if (ARROWS.has(id) && ownsArrows()) return false;
    if (scope === 'global') return true;
    return ui.hasHandler(id, Cut.app?.focusPanel ?? null);
  }

  // K held down: J and L step one frame instead of shuttling (the monitors read ui.keys.kHeld).
  const keys = {
    kHeld: false, actions: ACTIONS.map(([id]) => id), title: (id) => tr(TITLES.get(id) || id),
    kinds: KINDS.map(([id, title]) => ({ id, title: () => tr(title) })), kindOf,
  };
  addEventListener('keydown', (e) => { if (e.code === 'KeyK' && !e.ctrlKey && !e.altKey && !ui.isTyping()) keys.kHeld = true; }, true);
  addEventListener('keyup', (e) => { if (e.code === 'KeyK') keys.kHeld = false; }, true);
  addEventListener('blur', () => { keys.kHeld = false; });

  for (const [id, title, k, scope = 'panel'] of ACTIONS) {
    ide.registerAction({
      id: `Cut.${id}`,
      title: tr(title),
      keys: k,
      when: () => allowed(id, scope),
      run: () => ui.runAction(id, { source: 'key', kHeld: keys.kHeld }),
    });
  }

  // ---------- project-wide handlers ----------
  const on = (id, fn, panels = null) => ui.onAction(id, fn, { panels });
  const life = () => ui.lifecycle;
  on('undo', ({ app }) => { if (!app.history?.undo()) ui.toast(tr('Nothing to undo')); });
  on('redo', ({ app }) => { if (!app.history?.redo()) ui.toast(tr('Nothing to redo')); });
  on('save', () => { life()?.save(); });
  on('saveAs', () => { life()?.saveAs(); });
  on('open', () => { life()?.open(); });
  on('newProject', () => { life()?.newProject(); });
  on('import', ({ app }) => { ui.media?.importDialog(app); });
  on('export', ({ app }) => { ui.exportDialog?.open(app); });
  on('exportFrame', ({ app }) => { ui.exportDialog?.exportFrame(app); });
  for (const ws of ['editing', 'color', 'captions', 'export']) on(`workspace.${ws}`, () => { ui.setWorkspace?.(ws); });

  const TOOLS = { 'tool.select': 'select', 'tool.trackForward': 'trackForward', 'tool.trackBackward': 'trackBackward', 'tool.ripple': 'ripple',
    'tool.roll': 'roll', 'tool.rate': 'rate', 'tool.razor': 'razor', 'tool.slip': 'slip', 'tool.slide': 'slide', 'tool.pen': 'pen',
    'tool.hand': 'hand', 'tool.zoom': 'zoom', 'tool.text': 'text' };
  const EDITING = ['timeline', 'program', 'controls'];
  for (const [id, tool] of Object.entries(TOOLS)) on(id, ({ app }) => { app.setTool(tool); }, EDITING);
  on('snap', ({ app }) => {
    ui.setSnapping(app, !ui.editing.snapping);
    ui.toast(ui.editing.snapping ? tr('Snapping on') : tr('Snapping off'));
  }, EDITING);

  // ---------- default edits (the timeline's own handlers come first) ----------
  const selectedClips = (app) => {
    const seq = app.sequence;
    return seq ? seq.clips.filter((c) => app.selection.has(c.id)) : [];
  };
  const withSeq = (fn) => (ctx) => {
    const seq = ctx.app.sequence;
    if (!seq || !ctx.app.history) return;
    return fn(ctx, seq);
  };
  // One undo step for edits made on several clips.
  const grouped = (app, label, fn) => {
    app.history.begin(label);
    try { fn(); app.history.commit(); } catch (err) { app.history.cancel(); throw err; }
  };
  const C = () => Cut.commands;
  on('split', withSeq(({ app }, seq) => {
    const ids = [...app.selection].filter((id) => seq.clips.some((c) => c.id === id));
    ui.exec(app, C().split(seq.id, app.t, ids.length ? { clipIds: ids } : {}));
  }), EDITING);
  on('splitAll', withSeq(({ app }, seq) => { ui.exec(app, C().split(seq.id, app.t, { allTracks: true })); }), EDITING);
  on('rippleStart', withSeq(({ app }, seq) => {
    const r = ui.exec(app, C().rippleToPlayhead(seq.id, app.t, 'before', {}));
    if (r?.range) app.setTime(r.range.in);
  }), EDITING);
  on('rippleEnd', withSeq(({ app }, seq) => { ui.exec(app, C().rippleToPlayhead(seq.id, app.t, 'after', {})); }), EDITING);
  const removeSelected = (ripple) => withSeq(({ app }, seq) => {
    const ids = selectedClips(app).map((c) => c.id);
    if (!ids.length) return false;
    if (ui.exec(app, C().remove(seq.id, ids, { ripple }))) app.select([]);
  });
  on('rippleDelete', removeSelected(true), ['timeline']);
  on('delete', removeSelected(false), ['timeline']);
  on('toggleEnabled', withSeq(({ app }, seq) => {
    const clips = selectedClips(app);
    if (!clips.length) return;
    const on2 = !clips.every((c) => c.enabled);
    try { grouped(app, tr('Enable'), () => { for (const c of clips) app.history.do(C().setClip(seq.id, c.id, { enabled: on2 }, { linked: false })); }); } catch (err) { ui.report(err); }
  }), EDITING);
  on('link', withSeq(({ app }, seq) => {
    const clips = selectedClips(app);
    if (!clips.length) return;
    const ids = clips.map((c) => c.id);
    ui.exec(app, clips.some((c) => c.link) ? C().unlink(seq.id, ids) : C().link(seq.id, ids));
  }), EDITING);
  on('freezeFrame', withSeq(({ app }, seq) => {
    const under = (c) => c.start <= app.t && app.t < Cut.model.clipEnd(c);
    const video = (c) => seq.tracks.find((t) => t.id === c.track)?.kind === 'video';
    const clip = selectedClips(app).find((c) => video(c) && under(c))
      || Cut.model.clipsAt(seq, app.t, { kind: 'video' }).filter((c) => c.source?.media != null).pop();
    if (!clip) return void ui.toast(tr('The playhead is not on a video clip.'));
    const r = ui.exec(app, C().freezeFrame(seq.id, clip.id, app.t));
    if (r?.id) app.select([r.id]);
  }), EDITING);
  on('addMarker', withSeq(({ app }, seq) => {
    const clip = selectedClips(app).find((c) => c.start <= app.t && app.t < Cut.model.clipEnd(c));
    ui.exec(app, C().addMarker(seq.id, { t: app.t }, clip ? { clipId: clip.id } : {}));
  }), ['timeline', 'program']);
  on('selectAll', withSeq(({ app }, seq) => { app.select(seq.clips.map((c) => c.id)); }), ['timeline']);
  on('deselect', ({ app }) => { if (!app.selection.size) return false; app.select([]); }, ['timeline', 'program']);

  // Copy and paste: clips go to the playhead on the patched tracks (their own tracks when the patch has none).
  let clipboard = [];
  on('copy', withSeq(({ app }, seq) => {
    const clips = selectedClips(app);
    if (!clips.length) return false;
    clipboard = clips.map((c) => ({ ...JSON.parse(JSON.stringify(c)), kind: seq.tracks.find((t) => t.id === c.track)?.kind }));
    ui.toast(tr('{n} clips copied', { n: clips.length }));
  }), ['timeline']);
  on('paste', withSeq(({ app }, seq) => {
    if (!clipboard.length) return false;
    const r = ui.exec(app, C().paste(seq.id, clipboard, { at: app.t, mode: 'overwrite' }));
    if (r?.ids) app.select(r.ids);
  }), ['timeline', 'program']);

  // Speed/Duration (Ctrl+R): speed in percent or a duration, reverse, and whether later clips move along.
  on('speed', withSeq(({ app }, seq) => {
    const clip = selectedClips(app)[0];
    if (!clip) return void ui.toast(tr('Select a clip first.'));
    const fps = seq.fps;
    const speed = ui.numberField({ value: Math.round(clip.speed * 10000) / 100, min: 1, max: 10000, step: 1, precision: 2, unit: '%' });
    let duration = Cut.model.clipDuration(clip);
    const durField = ui.timecodeField({ fps, value: duration, onChange: (t) => { duration = t; byDuration = true; } });
    let byDuration = false;
    const reverse = el('input', null, undefined, { type: 'checkbox' });
    reverse.checked = !!clip.reverse;
    const ripple = el('input', null, undefined, { type: 'checkbox' });
    ripple.checked = true;
    const body = el('div', 'cut-form');
    body.append(
      ui.row(tr('Speed'), speed),
      ui.row(tr('Duration'), durField),
      ui.row(tr('Reverse speed'), reverse),
      ui.row(tr('Ripple edit, shifting trailing clips'), ripple),
    );
    ui.dialog({
      title: tr('Clip Speed/Duration'),
      id: 'cutSpeedDialog',
      body,
      width: 420,
      buttons: [
        { label: tr('OK'), primary: true, run: () => {
          const patch = { reverse: reverse.checked, ripple: ripple.checked };
          if (byDuration) patch.duration = duration;
          else patch.speed = speed.value / 100;
          ui.exec(app, C().setClip(seq.id, clip.id, patch));
        } },
        { label: tr('Cancel') },
      ],
    });
  }), EDITING);

  ui.keys = keys;
})();
