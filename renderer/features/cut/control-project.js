// The control API's tools for the project and its output (docs/cut-ai-control.md): media in (import_media, only files
// the user confirms or that lie in the project's folder), bins and names, sequences, tracks, transitions, caption
// tracks, color mattes, project settings, saving, the frame and caption exports, the export queue, proxies and the
// 9:16 shorts sequence. Edits go through Cut.commands as control.js's do; what touches a file or a dialog is a
// service of the page (ui-control.js), so the Node test runs every tool with stand-ins.
(function (part) {
  if (typeof module === 'object' && module.exports) module.exports = part;
  else globalThis.Cut.control.extend(part);
})((K) => {
  const { tool, refuse, need, M, C, r3, num, int, str, bool, list, ids, obj, bare, context, sec, ticks, timeIn, trackOf, mediaOf, run, atomic, paramValue } = K;
  const T = () => need('time').TICKS;

  // ---------- media ----------
  // A path as the user would type it: an absolute path on a drive of this PC (no network share, no device name).
  const PATH = /^[a-zA-Z]:[\\/](?:[^<>"|?*\x00-\x1f]*)$/;
  tool('import_media', 'edit', 'Import media',
    'Brings media files (video, sound, pictures) into the project, or caption files (.srt, .vtt) as a caption track of the sequence. paths: absolute file paths the user named; files in the project\'s folder come in at once, others only after the user confirms them in a dialog that lists them. Without paths the Import dialog opens for the user to pick files (folder: true picks a folder, its subfolders becoming bins). bin_id puts the media in a bin. Network shares are refused.',
    bare({ paths: list(str('An absolute path like C:\\Users\\me\\Videos\\a.mp4.', { maxLength: 400 }), 'The files.', { minItems: 1, maxItems: 50 }), folder: bool('Let the user pick a folder.'), bin_id: str('A bin (get_project).', { maxLength: 64 }) }),
    async (c0, a) => {
      const c = context(c0);
      if (a.paths && a.folder) refuse('Give paths or folder, not both.');
      for (const p of a.paths || []) {
        if (/^[\\/]{2}/.test(p)) refuse(`${p} is on a network share; Cut opens only files on this PC.`);
        if (!PATH.test(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p)) refuse(`${p} is not an absolute file path like C:\\Users\\me\\Videos\\clip.mp4.`);
      }
      if (a.bin_id != null && !c.project.bins.some((b) => b.id === a.bin_id)) refuse(`There is no bin ${a.bin_id}. get_project lists the bins.`);
      if (!c.services?.importMedia) refuse('Importing is not available here.');
      const r = await c.services.importMedia({ paths: a.paths || null, folder: !!a.folder, binId: a.bin_id ?? null, seq: c.seq });
      if (r?.declined) refuse(a.paths ? 'The user did not confirm these files. Nothing was imported.' : 'The user picked nothing. Nothing was imported.');
      if (!r?.ok) refuse(r?.error || 'Nothing was imported.');
      const out = { media: r.ids.map((id) => { const m = c.project.media.find((x) => x.id === id); return m ? { id, name: m.name, kind: m.kind } : { id }; }) };
      if (r.captionTracks?.length) out.captionTracks = r.captionTracks;
      if (r.failed?.length) out.failed = r.failed;
      if (!out.media.length && !out.captionTracks?.length) refuse(`Nothing could be imported${r.failed?.length ? `: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : '.'}`);
      return { edit: { at: c.app.t }, ...out };
    }, (a) => (a.paths ? ['Import {n} files', { n: a.paths.length }] : ['Import media', {}]));

  tool('remove_media', 'edit', 'Remove media',
    'Removes media from the project (never from the disk): media_ids, or unused: true for every media no sequence uses (Remove Unused). Media that clips use are refused; delete those clips first.',
    bare({ media_ids: ids('The media.'), unused: bool('Every unused media.') }),
    (c0, a) => {
      const c = context(c0);
      if ((a.media_ids == null) === !a.unused) refuse('Give media_ids or unused: true (one of them).');
      const uses = (id) => c.project.sequences.reduce((n, s) => n + s.clips.filter((x) => x.source?.media === id).length, 0);
      const list2 = a.unused ? c.project.media.filter((m) => !uses(m.id)).map((m) => m.id) : a.media_ids.map((id) => mediaOf(c, id).id);
      if (!list2.length) refuse('There is no unused media.');
      for (const id of list2) if (uses(id)) refuse(`${id} is used by ${uses(id)} clips; delete them first (the file itself is never deleted).`);
      run(c, C().removeMedia(list2));
      return { edit: { at: c.app.t }, removed: list2, note: 'Removed from the project only; the files stay on the disk.' };
    }, (a) => ['Remove {n} media from the project', { n: a.media_ids?.length ?? 0 }]);

  tool('project_items', 'edit', 'Bins and names',
    'The Project panel\'s items: new_bin (name, parent bin_id), remove_bin (bin_id; its items go to its parent), rename (item_id of a media, bin or sequence, name), move (item_ids into bin_id, or to the top when bin_id is left out).',
    bare({ action: str('new_bin, remove_bin, rename or move.', { enum: ['new_bin', 'remove_bin', 'rename', 'move'] }), name: str('A name.', { maxLength: 200 }), bin_id: str('A bin.', { maxLength: 64 }), item_id: str('A media, bin or sequence.', { maxLength: 64 }), item_ids: ids('Media, bins or sequences.') }, ['action']),
    (c0, a) => {
      const c = context(c0);
      const p = c.project;
      const bin = (id) => p.bins.find((b) => b.id === id) || refuse(`There is no bin ${id}. get_project lists the bins.`);
      const item = (id) => [...p.media, ...p.bins, ...p.sequences].find((x) => x.id === id) || refuse(`There is no media, bin or sequence ${id}.`);
      const only = (...keys) => { for (const k of ['name', 'bin_id', 'item_id', 'item_ids']) if (a[k] !== undefined && !keys.includes(k)) refuse(`${a.action} takes ${keys.join(', ') || 'nothing else'}, not ${k}.`); };
      if (a.action === 'new_bin') {
        only('name', 'bin_id');
        if (a.bin_id != null) bin(a.bin_id);
        const r = run(c, C().addBin(a.name?.trim() || 'Bin', a.bin_id ?? null));
        return { edit: { at: c.app.t }, bin: r.id };
      }
      if (a.action === 'remove_bin') {
        only('bin_id');
        if (a.bin_id == null) refuse('remove_bin needs bin_id.');
        run(c, C().removeBin(bin(a.bin_id).id));
        return { edit: { at: c.app.t }, note: 'Its items moved to the bin above it.' };
      }
      if (a.action === 'rename') {
        only('item_id', 'name');
        if (a.item_id == null || !a.name?.trim()) refuse('rename needs item_id and a name.');
        run(c, C().renameItem(item(a.item_id).id, a.name.trim()));
        return { edit: { at: c.app.t } };
      }
      only('item_ids', 'bin_id');
      if (!a.item_ids) refuse('move needs item_ids.');
      for (const id of a.item_ids) item(id);
      if (a.bin_id != null) bin(a.bin_id);
      run(c, C().moveToBin(a.item_ids, a.bin_id ?? null));
      return { edit: { at: c.app.t } };
    }, (a) => [{ new_bin: 'New bin', remove_bin: 'Delete bin {id}', rename: 'Rename {id}', move: 'Move {n} items' }[a.action], { id: a.bin_id || a.item_id || '', n: a.item_ids?.length || 0 }]);

  // ---------- sequences ----------
  const FPS = { '23.976': [24000, 1001], 24: [24, 1], 25: [25, 1], '29.97': [30000, 1001], 30: [30, 1], 50: [50, 1], '59.94': [60000, 1001], 60: [60, 1] };
  tool('add_sequence', 'edit', 'New sequence',
    'Makes a sequence: a preset (youtube-1080p30, youtube-4k30, shorts, square) or width, height (even px) and fps, or duplicate_of another sequence (Duplicate). It goes in bin_id if given, and becomes the active sequence unless active is false.',
    bare({ name: str('Name.', { maxLength: 200 }), preset: str('A sequence preset.', { enum: ['youtube-1080p30', 'youtube-4k30', 'shorts', 'square'] }), width: int('px.', { minimum: 16, maximum: 8192 }), height: int('px.', { minimum: 16, maximum: 8192 }), fps: str('Frames a second.', { enum: Object.keys(FPS) }), duplicate_of: str('A sequence to copy.', { maxLength: 64 }), bin_id: str('A bin.', { maxLength: 64 }), active: bool('Show it (default true).') }),
    (c0, a) => {
      const c = context(c0);
      const p = c.project;
      if (a.bin_id != null && !p.bins.some((b) => b.id === a.bin_id)) refuse(`There is no bin ${a.bin_id}.`);
      let opts;
      if (a.duplicate_of != null) {
        if (a.preset || a.width || a.height || a.fps) refuse('A duplicate keeps the size and rate of its sequence; change them after with set_sequence.');
        if (!p.sequences.some((s) => s.id === a.duplicate_of)) refuse(`There is no sequence ${a.duplicate_of}.`);
        opts = { from: a.duplicate_of };
      } else {
        const pre = need('presets').SEQUENCE.find((x) => x.id === (a.preset || 'youtube-1080p30'));
        const w = a.width ?? pre.w;
        const h = a.height ?? pre.h;
        if (w % 2 || h % 2) refuse('width and height must be even.');
        opts = { w, h, fps: a.fps ? FPS[a.fps] : pre.fps };
      }
      if (a.name?.trim()) opts.name = a.name.trim();
      if (a.bin_id != null) opts.binId = a.bin_id;
      const r = run(c, C().addSequence(opts));
      if (a.active !== false) c.app.setSequence(r.id);
      const s = p.sequences.find((x) => x.id === r.id);
      return { edit: { at: 0, seqId: a.active !== false ? r.id : null }, sequence: r.id, name: s.name, width: s.w, height: s.h, fps: r3(s.fps[0] / s.fps[1]) };
    }, (a) => ['New sequence {name}', { name: a.name || '' }]);

  tool('remove_sequence', 'edit', 'Delete a sequence',
    'Deletes a sequence from the project, with the nest clips of it in other sequences. The project keeps one sequence at least.',
    bare({ sequence_id: str('The sequence.', { maxLength: 64 }) }, ['sequence_id']),
    (c0, a) => {
      const c = context(c0, a);
      const p = c.project;
      if (p.sequences.length < 2) refuse('This is the only sequence; a project keeps one.');
      const uses = M().nestUses(p, c.seq.id).reduce((n, u) => n + u.clips.length, 0);
      for (const u of M().nestUses(p, c.seq.id)) for (const x of u.clips) if (u.seq.tracks.find((t) => t.id === x.track)?.locked) refuse(`A nest of it lies on locked track ${x.track} of "${u.seq.name}".`);
      const wasActive = c.app.sequenceId === c.seq.id;
      if (wasActive) c.app.setSequence(p.sequences.find((s) => s.id !== c.seq.id).id);
      try { run(c, C().removeSequence(c.seq.id)); } catch (err) { if (wasActive) c.app.setSequence(c.seq.id); throw err; }
      return { edit: { at: 0 }, removed: c.seq.id, nestClipsRemoved: uses, active: c.app.sequenceId };
    }, (a) => ['Delete sequence {id}', { id: a.sequence_id }]);

  // ---------- tracks ----------
  tool('add_track', 'edit', 'Add a track', 'Adds a video or audio track (on top of its kind, or at index among its kind, 0 the lowest), with a name.',
    obj({ kind: str('video or audio.', { enum: ['video', 'audio'] }), name: str('Name.', { maxLength: 100 }), index: int('Its place among the tracks of its kind.', { minimum: 0, maximum: 99 }) }, ['kind']),
    (c, a) => {
      const n = c.seq.tracks.filter((t) => t.kind === a.kind).length;
      if (a.index != null && a.index > n) refuse(`index is at most ${n} (there are ${n} ${a.kind} tracks).`);
      const id = atomic(c, 'Add Track', () => {
        const r = run(c, C().addTrack(c.seq.id, a.kind, a.index ?? null));
        if (a.name?.trim()) run(c, C().setTrack(c.seq.id, r.id, { name: a.name.trim() }));
        return r.id;
      });
      return { edit: { at: c.app.t }, track: id, tracks: c.seq.tracks.map((t) => t.id) };
    }, (a) => ['Add a {kind} track', { kind: a.kind }]);
  tool('remove_track', 'edit', 'Delete a track', 'Deletes a track with its clips and transitions. Locked tracks are refused.',
    obj({ track_id: str('The track.') }, ['track_id']),
    (c, a) => {
      const t = trackOf(c, a.track_id, { unlocked: true });
      if (c.seq.tracks.filter((x) => x.kind === t.kind).length < 2) refuse(`${t.id} is the only ${t.kind} track; a sequence keeps one.`);
      const clips = c.seq.clips.filter((x) => x.track === t.id).length;
      run(c, C().removeTrack(c.seq.id, t.id));
      return { edit: { at: c.app.t }, removedClips: clips, tracks: c.seq.tracks.map((x) => x.id) };
    }, (a) => ['Delete track {id}', { id: a.track_id }]);

  tool('set_transition', 'edit', 'Change a transition', 'Changes a transition: its duration (s), align (center, start or end of the edit), type (another transition of its kind, list_effects) or params.',
    obj({ transition_id: str('The transition.'), duration: num('Seconds.', { minimum: 0.01, maximum: 60 }), align: str('center, start or end.', { enum: ['center', 'start', 'end'] }), type: str('A transition type.', { maxLength: 60 }), params: { type: 'object', description: 'Its parameters.' } }, ['transition_id']),
    (c, a) => {
      const t = c.seq.transitions.find((x) => x.id === a.transition_id) || refuse(`There is no transition ${a.transition_id}. get_sequence lists them.`);
      trackOf(c, t.track, { unlocked: true });
      const E = c.services?.effects || need('effects');
      const type = a.type ?? t.type;
      const def = E.transitions().find((x) => x.type === type) || refuse(`There is no transition "${type}". list_effects lists them.`);
      if ((def.kind || 'video') !== trackOf(c, t.track).kind) refuse(`${type} is a ${def.kind || 'video'} transition and ${t.track} a ${trackOf(c, t.track).kind} track.`);
      const patch = {};
      if (a.type !== undefined) patch.type = a.type;
      if (a.align !== undefined) patch.align = a.align;
      if (a.duration !== undefined) patch.duration = Math.max(c.f, Math.round(ticks(c, a.duration) / c.f) * c.f);
      if (a.params) patch.params = Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, paramValue({ ...def, type }, k, v, `params.${k}`)]));
      if (!Object.keys(patch).length) refuse('Give something to change.');
      run(c, C().setTransition(c.seq.id, t.id, patch));
      const now = c.seq.transitions.find((x) => x.id === t.id);
      return { edit: { at: now.at }, duration: sec(c, now.duration), align: now.align, type: now.type };
    }, (a) => ['Change transition {id}', { id: a.transition_id }]);

  // ---------- caption tracks ----------
  const COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
  const CAPTION_STYLE = {
    font: str('Font family.', { maxLength: 100 }), size: int('px of a 1080-line picture.', { minimum: 8, maximum: 300 }), weight: int('100..900.', { minimum: 100, maximum: 900 }),
    color: str('#rrggbb.', { maxLength: 9 }), background: { type: ['string', 'null'], description: 'Box color #rrggbbaa, or null.' }, position: str('bottom or top.', { enum: ['bottom', 'top'] }),
    margin: num('% of the picture height from the edge.', { minimum: 0, maximum: 45 }), highlight: bool('Light the word being spoken.'), highlight_color: str('#rrggbb.', { maxLength: 9 }),
    highlight_mode: str('color or box.', { enum: ['color', 'box'] }), speakers: str('off, color, name or both: how speaker labels show.', { enum: ['off', 'color', 'name', 'both'] }),
  };
  tool('set_caption_track', 'edit', 'Caption track settings',
    'Changes a caption track: name, lang, sync_lock, and its Caption Style (font, size, weight, color, background, position, margin, highlight of the spoken word with highlight_color and highlight_mode, speakers). shown: true makes it the track the program monitor draws and an export burns in (not an undo step).',
    obj({ track_id: str('The caption track (cc<n>).'), name: str('Name.', { maxLength: 100 }), lang: str('Language code.', { maxLength: 10 }), sync_lock: bool('Moves with ripple edits.'), shown: bool('Show this track.'), style: bare(CAPTION_STYLE) }, ['track_id']),
    (c, a) => {
      const t = (c.seq.captions || []).find((x) => x.id === a.track_id) || refuse(`There is no caption track ${a.track_id}. get_sequence lists them (captionTracks).`);
      const patch = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.lang !== undefined) patch.lang = a.lang;
      if (a.sync_lock !== undefined) patch.syncLock = a.sync_lock;
      const s = a.style || {};
      const style = {};
      for (const k of ['font', 'size', 'weight', 'position', 'margin', 'highlight']) if (s[k] !== undefined) style[k] = s[k];
      for (const [k, key] of [['color', 'color'], ['highlight_color', 'highlightColor']]) if (s[k] !== undefined) style[key] = COLOR.test(s[k]) ? s[k] : refuse(`style.${k} must look like #ffffff.`);
      if (s.background !== undefined) style.background = s.background === null || COLOR.test(s.background) ? s.background ?? 'transparent' : refuse('style.background must look like #00000099 or be null.');
      if (s.highlight_mode !== undefined) style.highlightMode = s.highlight_mode;
      if (s.speakers !== undefined) Object.assign(style, { speakerColor: s.speakers === 'color' || s.speakers === 'both', speakerName: s.speakers === 'name' || s.speakers === 'both' });
      if (Object.keys(style).length) patch.style = style;
      if (!Object.keys(patch).length && !a.shown) refuse('Give something to change.');
      if (Object.keys(patch).length) run(c, C().setCaptionTrack(c.seq.id, t.id, patch));
      if (a.shown) c.services?.showCaptionTrack?.(c.seq, t.id);
      return Object.keys(patch).length ? { edit: { at: c.app.t }, track: t.id } : { track: t.id, shown: true };
    }, (a) => ['Change caption track {id}', { id: a.track_id }]);

  // ---------- graphics ----------
  tool('add_color_matte', 'edit', 'Add a color matte', 'Adds a color matte (a full-frame solid color clip) at a time for duration seconds (default the project\'s still length) on a video track (default the lowest free one above the clips there).',
    obj({ at: num('Start (s).', { minimum: 0 }), duration: num('Seconds.', { minimum: 0.04, maximum: 3600 }), color: str('#rrggbb (default #2f6fdb).', { maxLength: 7 }), track: str('A video track.'), name: str('Name.', { maxLength: 100 }) }, ['at']),
    (c, a) => {
      const color = (a.color ?? '#2f6fdb').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(color)) refuse('color must look like #2f6fdb.');
      const at = need('time').snap(timeIn(c, a.at, 'at'), c.seq.fps);
      const d = Math.max(c.f, a.duration != null ? Math.round(ticks(c, a.duration) / c.f) * c.f : c.project.settings.stillDuration);
      let track = a.track ? trackOf(c, a.track, { kind: 'video', unlocked: true }).id : null;
      const id = atomic(c, 'Add Graphic', () => {
        if (!track) {
          const vids = c.seq.tracks.filter((t) => t.kind === 'video');
          const busy = (tid) => c.seq.clips.some((x) => x.track === tid && x.start < at + d && M().clipEnd(x) > at);
          let top = -1;
          vids.forEach((t, i) => { if (busy(t.id)) top = i; });
          track = vids.slice(top + 1).find((t) => !t.locked)?.id || run(c, C().addTrack(c.seq.id, 'video')).id;
        }
        return run(c, C().addGenerated(c.seq.id, { track, at, duration: d, name: a.name || 'Color Matte', source: { generator: 'solid', color } })).id;
      });
      return { edit: { at }, clip: id, track };
    }, (a) => ['Add a color matte at {at} s', { at: a.at }]);

  // ---------- the project ----------
  tool('set_project_settings', 'edit', 'Project settings',
    'The project\'s settings: still_duration (s, new pictures and titles), transition_duration (s, new transitions), freeze_duration (s, Insert Frame Hold), fit (fit, fill or original: how new media of another size scale), speech_terms (the word list speech recognition is told of: names and terms, as written).',
    bare({ still_duration: num('Seconds.', { minimum: 0.04, maximum: 3600 }), transition_duration: num('Seconds.', { minimum: 0.04, maximum: 60 }), freeze_duration: num('Seconds.', { minimum: 0.04, maximum: 3600 }), fit: str('fit, fill or original.', { enum: ['fit', 'fill', 'original'] }), speech_terms: list(str('A term.', { maxLength: 100 }), 'The word list.', { maxItems: 200 }) }),
    (c0, a) => {
      const c = context(c0);
      const f = need('time').frameTicks([30, 1]);
      const ticksOf = (s) => Math.max(f, Math.round((s * T()) / f) * f);
      const patch = {};
      for (const [k, key] of [['still_duration', 'stillDuration'], ['transition_duration', 'transitionDuration'], ['freeze_duration', 'freezeDuration']]) if (a[k] !== undefined) patch[key] = ticksOf(a[k]);
      if (a.fit !== undefined) patch.fit = a.fit;
      if (a.speech_terms !== undefined) patch.speechTerms = [...new Set(a.speech_terms.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))];
      if (!Object.keys(patch).length) refuse('Give something to change.');
      run(c, C().setSettings(patch));
      return { edit: { at: c.app.t } };
    }, () => ['Change the project settings', {}]);

  tool('save_project', 'export', 'Save the project',
    'Saves the project to its file. A project that was never saved opens the Save As dialog, where the user picks the place (or cancels). Never writes anywhere else.',
    bare(), async (c0) => {
      const c = context(c0);
      if (!c.services?.save) refuse('Saving is not available here.');
      const r = await c.services.save();
      if (r?.declined) refuse('The user did not pick a place to save. Nothing was written.');
      if (!r?.ok) refuse(`The project could not be saved: ${r?.error || 'unknown error'}`);
      return { saved: r.name };
    }, () => ['Save the project', {}]);

  tool('export_frame', 'export', 'Export a frame',
    'Saves the program monitor\'s picture at a time (default the playhead) as a new PNG in the project\'s folder (Export Frame). The user is asked first; an existing file is never replaced.',
    obj({ time: num('Seconds.', { minimum: 0 }), file_name: str('A file name without folders (.png is added).', { maxLength: 120 }) }),
    async (c, a) => {
      if (!c.duration) refuse('The sequence is empty.');
      const t = a.time == null ? Math.min(c.app.t, Math.max(0, c.duration - c.f)) : Math.min(timeIn(c, a.time), Math.max(0, c.duration - c.f));
      const name = K.plainName(a.file_name);
      if (!c.services?.exportFrame) refuse('Exporting a frame is not available here.');
      const r = await c.services.exportFrame({ seq: c.seq, t, fileName: name });
      if (!r?.ok) refuse(r?.declined ? 'The user said no. Nothing was written.' : `The frame could not be saved: ${r?.error || 'unknown error'}`);
      return { saved: r.name, time: sec(c, t) };
    }, (a) => ['Export the frame at {t} s', { t: a.time ?? '' }]);

  tool('export_captions', 'export', 'Export captions',
    'Writes a caption track to a new .srt or .vtt file in the project\'s folder. The user is asked first; an existing file is never replaced.',
    obj({ track_id: str('The caption track (default the shown one).'), format: str('srt (default) or vtt.', { enum: ['srt', 'vtt'] }), file_name: str('A file name without folders.', { maxLength: 120 }) }),
    async (c, a) => {
      const tracks = c.seq.captions || [];
      const t = a.track_id ? tracks.find((x) => x.id === a.track_id) || refuse(`There is no caption track ${a.track_id}.`) : tracks[0] || refuse('The sequence has no captions.');
      if (!t.items.length) refuse(`Caption track ${t.id} is empty.`);
      const name = K.plainName(a.file_name);
      if (!c.services?.exportCaptions) refuse('Exporting captions is not available here.');
      const r = await c.services.exportCaptions({ seq: c.seq, trackId: a.track_id ?? null, format: a.format || 'srt', fileName: name });
      if (!r?.ok) refuse(r?.declined ? 'The user said no. Nothing was written.' : `The captions could not be saved: ${r?.error || 'unknown error'}`);
      return { saved: r.name, captions: r.count };
    }, () => ['Export the captions', {}]);

  tool('export_queue', 'export', 'Export queue',
    'The export queue: list (its jobs: id, file name, state, progress, error), cancel, retry or remove a job (job_id), clear_finished.',
    bare({ action: str('list (default), cancel, retry, remove or clear_finished.', { enum: ['list', 'cancel', 'retry', 'remove', 'clear_finished'] }), job_id: int('A job id (list).', { minimum: 0 }) }),
    (c0, a) => {
      const c = { ...c0 };
      const q = c.services?.queue;
      if (!q) refuse('The export queue is not available here.');
      const action = a.action || 'list';
      if (action !== 'list' && action !== 'clear_finished') {
        if (a.job_id == null) refuse(`${action} needs job_id.`);
        const job = q.jobs().find((j) => j.id === a.job_id) || refuse(`There is no job ${a.job_id}. export_queue lists them.`);
        const ok = { cancel: () => ['waiting', 'running'].includes(job.state) && q.cancel(job.id), retry: () => ['failed', 'cancelled'].includes(job.state) && q.retry(job.id), remove: () => !['running'].includes(job.state) && q.remove(job.id) }[action]();
        if (ok === false) refuse(`Job ${job.id} is ${job.state}; it cannot be ${action === 'remove' ? 'removed while it runs (cancel it first)' : `${action === 'cancel' ? 'cancelled' : 'retried'}`}.`);
      } else if (action === 'clear_finished') q.clearFinished();
      return { jobs: q.jobs().map((j) => ({ id: j.id, file: j.name, sequence: j.seqName, preset: j.presetName, state: j.state, progress: r3(j.fraction || 0), ...(j.error ? { error: j.error } : {}) })) };
    }, (a) => ['Export queue: {action}', { action: a.action || 'list' }]);

  tool('proxies', 'edit', 'Proxies',
    'Proxies (720p H.264 copies that play smoothly; exports always use the original): status of media_ids (or all video media), create them (waits with progress unless wait is false; Stop cancels the ones not done), or remove them (the media play their original again).',
    bare({ action: str('status (default), create or remove.', { enum: ['status', 'create', 'remove'] }), media_ids: ids('Video media.'), wait: bool('Wait for create (default true).') }),
    async (c0, a) => {
      const c = context(c0);
      const P = c.services?.proxies;
      if (!P) refuse('Proxies are not available here.');
      const all = (a.media_ids || c.project.media.filter((m) => m.kind === 'video').map((m) => m.id)).map((id) => mediaOf(c, id));
      const action = a.action || 'status';
      const state = () => all.map((m) => ({ id: m.id, name: m.name, ...P.state(m.id) }));
      if (action === 'status') return { media: state() };
      const video = all.filter((m) => m.kind === 'video' && m.video);
      if (!video.length) refuse('None of these is a video; proxies are for video media.');
      if (action === 'remove') {
        const withProxy = video.filter((m) => m.proxy);
        if (!withProxy.length) refuse('None of these has a proxy.');
        atomic(c, 'Remove Proxy', () => { for (const m of withProxy) run(c, C().setProxy(m.id, null)); });
        return { edit: { at: c.app.t }, removed: withProxy.map((m) => m.id) };
      }
      if (c.services.offline) for (const m of video) if (c.services.offline(m.id)) refuse(`${m.id} is offline (its file is missing); it cannot get a proxy.`);
      const queued = P.create(video.map((m) => m.id));
      if (a.wait === false) return { queued, media: state() };
      const w = await P.wait(video.map((m) => m.id), { signal: c.signal, progress: c.progress });
      if (w?.cancelled) refuse(`Stopped: the proxies not done yet were cancelled (${w.done || 0} of ${video.length} ready).`);
      return { edit: { at: c.app.t }, media: state() };
    }, (a) => ['Proxies: {action}', { action: a.action || 'status' }]);

  tool('create_shorts', 'edit', 'Create a shorts sequence',
    'Highlights to Shorts: a new 9:16 sequence (1080x1920) holding only the given ranges of this sequence, back to back, with the video scaled to fill (mode fill, default) or fit. Captions and markers in the ranges come along. Choose the ranges from get_transcript; the new sequence becomes the active one.',
    obj({ ranges: list(bare({ from: num('Start (s).', { minimum: 0 }), to: num('End (s).', { minimum: 0 }) }, ['from', 'to']), 'The parts to keep, in any order.', { minItems: 1, maxItems: 20 }), name: str('Name.', { maxLength: 200 }), mode: str('fill or fit.', { enum: ['fill', 'fit'] }) }, ['ranges']),
    (c, a) => {
      const AI = need('ai');
      const keep = a.ranges.map((x, i) => {
        const r0 = timeIn(c, x.from, `ranges[${i}].from`);
        const r1 = timeIn(c, x.to, `ranges[${i}].to`);
        if (r1 - r0 < c.f) refuse(`ranges[${i}] must end at least one frame after it starts.`);
        return [Math.round(r0 / c.f) * c.f, Math.round(r1 / c.f) * c.f];
      }).sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < keep.length; i++) if (keep[i][0] < keep[i - 1][1]) refuse('The ranges overlap; give each part once.');
      const src = c.seq;
      const id = atomic(c, 'Create Shorts Sequence', () => {
        const sid = run(c, C().addSequence({ from: src.id, name: a.name?.trim() || `${src.name} Shorts` })).id;
        const seqOf = () => c.project.sequences.find((s) => s.id === sid);
        for (const t of seqOf().tracks) if (t.locked) run(c, C().setTrack(sid, t.id, { locked: false }));
        for (const ct of seqOf().captions) if (!ct.syncLock) run(c, C().setCaptionTrack(sid, ct.id, { syncLock: true }));
        run(c, C().setSequence(sid, { w: 1080, h: 1920 }));
        const s = seqOf();
        const end = Math.max(M().sequenceDuration(s), ...s.captions.flatMap((t) => t.items.map((it) => it.end)), ...s.markers.map((m) => m.t + (m.duration || 0)), 0);
        for (const [x, y] of AI.complement(keep, end)) run(c, C().extract(sid, x, y));
        for (const cmd of AI.shortsEdits(c.project, seqOf(), { mode: a.mode || 'fill' })) run(c, cmd);
        return sid;
      });
      c.app.setSequence(id);
      const s = c.project.sequences.find((x) => x.id === id);
      return { edit: { at: 0, seqId: id }, sequence: id, name: s.name, duration: r3(M().sequenceDuration(s) / c.T) };
    }, (a) => ['Create a shorts sequence of {n} parts', { n: a.ranges.length }]);
});
