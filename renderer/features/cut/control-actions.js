// What of Cut an AI can do, and how (docs/cut-ai-control.md section 6): the inventory of every keyboard action
// (ui-keys.js), Automation item (ui-auto.js), menu item without an action (ui-menubar.js), edit command (commands.js)
// and panel, each covered by tools, by run_action, or marked not for AI with the reason. verify/cut-control-core.mjs
// fails when one of them has no entry, so a new feature cannot ship without an AI path.
//
// list_actions and run_action make the keyboard's actions an AI's: run_action checks what the action needs (a
// selection, the playhead on a clip, an In and Out...), refuses without it, runs the action the way a key does (given
// to the timeline), and says what changed (the undo step, the selection, the playhead, In/Out, the view).
(function (part) {
  if (typeof module === 'object' && module.exports) module.exports = part;
  else globalThis.Cut.control.extend(part);
})((K) => {
  const { tool, refuse, M, str, ids, bare, num, context, clipOf, sec } = K;

  // ---------- entries ----------
  const t = (...tools) => ({ tools });
  const no = (reason) => ({ no: reason });
  // A run_action action: what it does (for the model), what it needs, whether it is only a view change (no undo step).
  const act = (what, { needs = null, view = false, panel = 'timeline', also = [] } = {}) => ({ act: { what, needs, view, panel }, tools: also });

  const NEEDS = {
    selection: 'selected clips (select_clips or clip_ids)',
    two: 'two selected clips or more',
    clip: 'a clip under the playhead (seek or time)',
    video: 'a video clip of a media file under the playhead',
    in: 'a sequence In point (markIn)',
    out: 'a sequence Out point (markOut)',
    inOut: 'a sequence In and Out (markIn, markOut or markClip)',
    marker: 'a sequence marker at the playhead',
    markers: 'sequence markers',
    source: 'a clip open in the Source monitor (matchFrame opens one)',
    clipboard: 'clips copied with copy or cut',
  };

  // ui-keys.js ACTIONS
  const KEYS = {
    playPause: t('play', 'stop'), shuttleBack: no('Shuttling is hands-on playback; play, stop and seek move the picture.'),
    shuttleStop: t('stop'), shuttleForward: no('Shuttling is hands-on playback; play, stop and seek move the picture.'),
    playInToOut: act('Plays from the sequence In to its Out in the program monitor.', { needs: 'inOut', view: true }),
    frameBack: act('Moves the playhead one frame back.', { view: true, also: ['seek'] }), frameForward: act('Moves the playhead one frame on.', { view: true, also: ['seek'] }),
    frameBack5: act('Moves the playhead five frames back.', { view: true, also: ['seek'] }), frameForward5: act('Moves the playhead five frames on.', { view: true, also: ['seek'] }),
    prevEdit: act('Moves the playhead to the previous edit point of the targeted tracks.', { view: true }), nextEdit: act('Moves the playhead to the next edit point of the targeted tracks.', { view: true }),
    prevEditAny: act('Moves the playhead to the previous edit point on any track.', { view: true }), nextEditAny: act('Moves the playhead to the next edit point on any track.', { view: true }),
    goStart: act('Moves the playhead to the start.', { view: true, also: ['seek'] }), goEnd: act('Moves the playhead to the end.', { view: true, also: ['seek'] }),
    goIn: act('Moves the playhead to the sequence In.', { needs: 'in', view: true }), goOut: act('Moves the playhead to the sequence Out.', { needs: 'out', view: true }),
    markIn: act('Sets the sequence In at the playhead.', { view: true }), markOut: act('Sets the sequence Out at the playhead.', { view: true }),
    markClip: act('Sets In and Out around the clip under the playhead (the selected one first).', { needs: 'clip', view: true }),
    markSelection: act('Sets In and Out around the selected clips.', { needs: 'selection', view: true }),
    clearIn: act('Clears the sequence In.', { needs: 'in', view: true }), clearOut: act('Clears the sequence Out.', { needs: 'out', view: true }),
    clearInOut: act('Clears the sequence In and Out.', { view: true }),
    addMarker: act('Adds a marker at the playhead (on the selected clip there, else on the sequence).', { also: ['add_marker'] }),
    nextMarker: act('Moves the playhead to the next sequence marker.', { needs: 'markers', view: true }), prevMarker: act('Moves the playhead to the previous sequence marker.', { needs: 'markers', view: true }),
    clearMarker: act('Removes the sequence marker at the playhead.', { needs: 'marker', also: ['remove_markers'] }),
    clearAllMarkers: act('Removes every sequence marker.', { needs: 'markers', also: ['remove_markers'] }),
    insert: act('Insert: puts the Source monitor\'s clip (its In to Out) at the playhead on the patched tracks, pushing later clips.', { needs: 'source', also: ['place_clip'] }),
    overwrite: act('Overwrite: puts the Source monitor\'s clip at the playhead over what is there.', { needs: 'source', also: ['place_clip'] }),
    lift: act('Lift: removes In to Out on the targeted tracks and leaves a gap.', { needs: 'inOut', also: ['delete_range'] }),
    extract: act('Extract: removes In to Out on the targeted tracks and closes the gap.', { needs: 'inOut', also: ['delete_range'] }),
    split: act('Add Edit: cuts the selected clips at the playhead, or the targeted tracks\' clips there.', { also: ['razor'] }),
    splitAll: act('Add Edit to All Tracks: cuts every clip under the playhead.', { also: ['razor'] }),
    rippleStart: act('Ripple Trim Previous Edit to Playhead (Q): removes from the clip\'s start to the playhead and closes the gap.', { needs: 'clip' }),
    rippleEnd: act('Ripple Trim Next Edit to Playhead (W): removes from the playhead to the clip\'s end and closes the gap.', { needs: 'clip' }),
    rippleDelete: act('Deletes the selected clips and closes their gaps.', { needs: 'selection', also: ['delete_clips'] }),
    delete: act('Deletes the selected clips and leaves gaps.', { needs: 'selection', also: ['delete_clips'] }),
    toggleEnabled: act('Turns the selected clips off (hidden and muted) or on again.', { needs: 'selection', also: ['set_clip'] }),
    link: act('Links the selected clips, or unlinks them when linked.', { needs: 'selection', also: ['link_clips'] }),
    group: act('Groups the selected clips.', { needs: 'two', also: ['link_clips'] }), ungroup: act('Ungroups the selected clips.', { needs: 'selection', also: ['link_clips'] }),
    nest: t('nest_clips'),
    nudgeLeft: act('Moves the selected clips one frame earlier.', { needs: 'selection', also: ['move_clips'] }), nudgeRight: act('Moves the selected clips one frame later.', { needs: 'selection', also: ['move_clips'] }),
    nudgeLeft5: act('Moves the selected clips five frames earlier.', { needs: 'selection', also: ['move_clips'] }), nudgeRight5: act('Moves the selected clips five frames later.', { needs: 'selection', also: ['move_clips'] }),
    nudgeUp: act('Moves the selected clips one track up.', { needs: 'selection', also: ['move_clips'] }), nudgeDown: act('Moves the selected clips one track down.', { needs: 'selection', also: ['move_clips'] }),
    selectAtPlayhead: act('Selects the clips under the playhead on the targeted tracks.', { view: true, also: ['select_clips'] }),
    matchFrame: act('Match Frame: opens the media of the clip under the playhead in the Source monitor at the same frame.', { needs: 'clip', view: true }),
    extendEdit: act('Extend Edit: moves the nearest edit point of the selected clips (or the targeted tracks) to the playhead.', { also: ['trim_clip'] }),
    speed: t('set_speed'),
    freezeFrame: act('Insert Frame Hold Segment: holds the frame under the playhead for the freeze duration, pushing the rest later.', { needs: 'video', also: ['set_time_remap'] }),
    transitionVideo: act('Puts the default video transition on the edit nearest the playhead on the targeted tracks (or the selected clips\' edits).', { also: ['add_transition'] }),
    transitionAudio: act('Puts the default audio crossfade on the edit nearest the playhead.', { also: ['add_transition'] }),
    transitionBoth: act('Puts the default transitions on the selected clips\' ends.', { needs: 'selection', also: ['add_transition'] }),
    cut: act('Cuts the selected clips to the clipboard (they are removed).', { needs: 'selection' }),
    copy: act('Copies the selected clips to the clipboard.', { needs: 'selection', view: true }),
    paste: act('Pastes the clipboard at the playhead over what is there.', { needs: 'clipboard' }),
    pasteInsert: act('Pastes the clipboard at the playhead, pushing later clips.', { needs: 'clipboard' }),
    selectAll: act('Selects every clip of the sequence.', { view: true, also: ['select_clips'] }),
    deselect: act('Clears the selection.', { view: true, also: ['select_clips'] }),
    'tool.select': act('The timeline\'s Selection tool (V), for the user\'s mouse.', { view: true }), 'tool.trackForward': act('The Track Select Forward tool.', { view: true }),
    'tool.trackBackward': act('The Track Select Backward tool.', { view: true }), 'tool.ripple': act('The Ripple Edit tool.', { view: true }), 'tool.roll': act('The Rolling Edit tool.', { view: true }),
    'tool.rate': act('The Rate Stretch tool.', { view: true }), 'tool.razor': act('The Razor tool.', { view: true }), 'tool.slip': act('The Slip tool.', { view: true }),
    'tool.slide': act('The Slide tool.', { view: true }), 'tool.pen': act('The Pen tool.', { view: true }), 'tool.hand': act('The Hand tool.', { view: true }),
    'tool.zoom': act('The Zoom tool.', { view: true }), 'tool.text': act('The Type tool.', { view: true }),
    snap: act('Turns snapping in the timeline on or off.', { view: true }),
    zoomIn: act('Zooms the timeline in.', { view: true }), zoomOut: act('Zooms the timeline out.', { view: true }), zoomFit: act('Zooms the timeline to show the whole sequence.', { view: true }),
    videoTracksTaller: act('Makes the video tracks taller.'), videoTracksShorter: act('Makes the video tracks shorter.'),
    audioTracksTaller: act('Makes the audio tracks taller.'), audioTracksShorter: act('Makes the audio tracks shorter.'),
    expandTracks: act('Expands every track.'), minimizeTracks: act('Minimizes every track.'),
    fullscreen: no('Full-screen playback takes over the user\'s screen; the user starts it (Ctrl+`).'),
    maximizePanel: act('Maximizes the panel with the keyboard, or restores it.', { view: true }),
    maximizeUnderCursor: no('It acts on the panel under the mouse pointer, which an AI does not hold; maximizePanel does the same for the focused panel.'),
    undo: t('undo'), redo: t('redo'),
    save: t('save_project'),
    saveAs: no('It writes the project to a new file at a place the user picks; save_project saves it to its own file (asking for a place only when it has none).'),
    saveCopy: no('It writes a copy of the project to a place the user picks; the user does it.'),
    open: no('It closes this project and opens another; that is the user\'s call.'),
    newProject: no('It closes this project for a new one; that is the user\'s call.'),
    newSequence: t('add_sequence'), newBin: act('Adds a bin to the Project panel.', { also: ['project_items'] }),
    import: t('import_media'), export: t('export_sequence'), exportFrame: t('export_frame'),
    'workspace.editing': act('Shows the Editing workspace.', { view: true }), 'workspace.color': act('Shows the Color workspace.', { view: true }),
    'workspace.effects': act('Shows the Effects workspace.', { view: true }), 'workspace.audio': act('Shows the Audio workspace.', { view: true }),
    'workspace.captions': act('Shows the Captions and Graphics workspace.', { view: true }), 'workspace.export': act('Shows the Export workspace.', { view: true }),
    'workspace.reset': act('Resets the shown workspace to its saved layout.', { view: true }),
    keyHelp: no('A cheat sheet of keys for the person at the keyboard.'),
    keyboardShortcuts: no('The user\'s own keyboard settings.'), settings: no('The user\'s preferences (Settings > Video Editor).'),
    selectUnused: act('Selects the media no sequence uses in the Project panel.', { view: true, panel: 'project', also: ['get_media'] }),
    removeUnused: t('remove_media'),
    findMissing: no('Relinking picks files on disk in a dialog; the user does it (File > Find Missing Media…). get_media shows which media are offline.'),
    createProxy: t('proxies'),
  };
  // ui-auto.js ITEMS (the Automation menu)
  const AUTOMATION = {
    silence: t('remove_silence'), scenes: t('automation'), beats: t('automation'), captions: t('automation'), fillers: t('automation'), speakers: t('automation', 'speakers'),
    nextUncertain: act('Moves the playhead to the next word speech recognition was unsure of.', { view: true }),
    prevUncertain: act('Moves the playhead to the previous word speech recognition was unsure of.', { view: true }),
    aiPolish: no('The assistant is Claude: it reads the captions (get_captions) and fixes them itself (set_caption).'),
    aiTranslate: no('The assistant is Claude: it reads the captions (get_captions) and writes a translated track itself (add_captions).'),
    aiMetadata: no('The assistant is Claude: it writes titles and descriptions in its answer, from get_transcript; chapters are add_marker with kind chapter.'),
    aiHighlights: t('create_shorts', 'get_transcript'),
    aiCommand: no('An edit command in plain words is what the assistant itself does.'),
    aiAssistant: no('It opens this chat.'),
    loudness: t('automation'), clipLoudness: t('automation'), duck: t('automation'), isolateVoice: t('automation'), color: t('automation'),
  };
  // ui-menubar.js items without an action of their own, by their English label (submenus by theirs)
  const MENU = {
    New: t('add_sequence', 'project_items'), 'Project…': no('It closes this project for a new one; that is the user\'s call.'), 'Sequence…': t('add_sequence'), Bin: t('project_items'),
    'Save As…': no('It writes the project to a new file at a place the user picks.'), 'Save': t('save_project'), 'Import…': t('import_media'), 'Import Folder…': t('import_media'),
    Export: t('export_sequence', 'export_frame', 'export_captions'), 'Media…': t('export_sequence'), 'Frame…': t('export_frame'), 'Captions…': t('export_captions'),
    'Preferences…': no('The user\'s preferences.'), 'Video Options': t('set_time_remap'), 'Time Interpolation': t('set_clip'), 'Frame Sampling': t('set_clip'), 'Frame Blending': t('set_clip'),
    Proxy: t('proxies'), 'Sequence Settings…': t('set_sequence'), 'Add Video Track': t('add_track'), 'Add Audio Track': t('add_track'), 'Edit Marker…': t('set_marker'),
    'New Layer': t('add_text', 'add_color_matte'), Text: t('add_text'), 'Color Matte': t('add_color_matte'), 'Import Captions…': t('import_media'), 'Export Captions…': t('export_captions'),
    'Caption Style…': t('set_caption_track'), 'Playback Resolution': no('A viewing preference of the user (how sharp the monitor draws while editing).'),
    Full: no('A viewing preference of the user.'), '1/2': no('A viewing preference of the user.'), '1/4': no('A viewing preference of the user.'),
    'Play Proxies': no('A playback preference of the user; proxies makes and removes them.'), 'Safe Margins': no('A viewing aid of the user.'),
    'Timeline Tool Bar': no('A layout preference of the user.'), Workspaces: act('Workspaces: run_action workspace.<name>.', { view: true }), 'Find Action…': no('A search box for the person at the keyboard.'),
  };
  // commands.js
  const COMMANDS = {
    importMedia: t('import_media'), removeMedia: t('remove_media'), relinkMedia: no('Relinking picks a file on disk; the user does it (Find Missing Media…).'),
    addBin: t('project_items'), removeBin: t('project_items'), renameItem: t('project_items'), moveToBin: t('project_items'),
    addSequence: t('add_sequence', 'create_shorts'), removeSequence: t('remove_sequence'), setSequence: t('set_sequence'),
    addTrack: t('add_track'), removeTrack: t('remove_track'), setTrack: t('set_track'),
    place: t('place_clip'), placeRange: t('place_clip'), move: t('move_clips'), trim: t('trim_clip'), split: t('razor'), remove: t('delete_clips'),
    rippleToPlayhead: t('run_action'), closeGap: t('delete_range'), lift: t('delete_range'), extract: t('delete_range'),
    setClip: t('set_clip', 'set_speed'), setKeyframes: t('set_keyframes'), setRemap: t('set_time_remap'),
    link: t('link_clips'), unlink: t('link_clips'), group: t('link_clips'), ungroup: t('link_clips'), nest: t('nest_clips'),
    slip: t('trim_clip'), slide: t('trim_clip'), stretch: t('trim_clip'), extendEdit: t('run_action'),
    addEffect: t('add_effect', 'essential_sound', 'set_color'), removeEffect: t('remove_effect'), setEffect: t('set_effect', 'set_color'), moveEffect: t('set_effect'),
    addMask: t('add_mask'), setMask: t('set_mask'), removeMask: t('remove_mask'),
    addTransition: t('add_transition'), removeTransition: t('remove_transition'), setTransition: t('set_transition'),
    addGenerated: t('add_text', 'add_color_matte', 'add_graphic'), freezeFrame: t('run_action'),
    addMarker: t('add_marker'), setMarker: t('set_marker'), removeMarker: t('remove_markers'),
    addCaptionTrack: t('add_captions'), setCaptionTrack: t('set_caption_track'), removeCaptionTrack: t('remove_captions'), setCaptions: t('automation'),
    addCaption: t('add_captions'), setCaption: t('set_caption'), removeCaption: t('remove_captions'),
    setProxy: t('proxies'), setSettings: t('set_project_settings'), setSpeakers: t('speakers', 'automation'),
    addLut: no('Loading a .cube LUT reads a file the user picks in the Lumetri Color panel; set_color uses the LUTs the project has.'),
    paste: t('run_action'), setGenerator: t('set_clip', 'set_graphic'), setLayer: t('set_text', 'set_graphic'), addLayer: t('set_text', 'set_graphic'), removeLayer: t('set_text', 'set_graphic'), setRole: t('set_clip'),
    replaceAudio: t('automation'), batch: t('remove_silence', 'essential_sound'),
  };
  // Cut.ui.registerPanel ids
  const PANELS = {
    project: t('get_media', 'import_media', 'project_items', 'remove_media', 'add_sequence', 'proxies'), source: t('run_action', 'place_clip'),
    program: t('get_frame', 'seek', 'play', 'stop'), timeline: t('get_sequence', 'place_clip', 'move_clips', 'trim_clip', 'razor', 'delete_clips', 'set_track', 'add_track', 'run_action'),
    controls: t('get_clip', 'set_clip', 'set_keyframes', 'set_effect', 'set_time_remap', 'add_mask', 'set_mask'), effects: t('list_effects', 'add_effect', 'add_transition'),
    text: t('add_text', 'set_text'), color: t('set_color'), scopes: no('Scopes measure the program monitor\'s picture; get_frame shows the picture itself.'),
    history: t('undo', 'redo', 'get_state'), meters: no('Live levels while playing; automation match_loudness measures the loudness.'),
    markers: t('get_markers', 'add_marker', 'set_marker', 'remove_markers'), mixer: t('set_track', 'set_sequence'),
    essential: t('essential_sound', 'set_clip', 'automation'), captions: t('get_captions', 'add_captions', 'set_caption', 'remove_captions', 'set_caption_track'),
    transcript: t('get_transcript', 'automation', 'delete_range', 'speakers'), export: t('export_sequence'), queue: t('export_queue'), tools: t('run_action'),
    assistant: no('It is this chat; the AI works through the tools, not through the panel.'),
  };
  const INVENTORY = { keys: KEYS, automation: AUTOMATION, menu: MENU, commands: COMMANDS, panels: PANELS };

  // The actions run_action takes: the keyboard's, and window.<panel> (the Window menu).
  const ACTS = new Map(Object.entries(KEYS).filter(([, e]) => e.act).map(([id, e]) => [id, e.act]));
  for (const [id, e] of Object.entries(AUTOMATION)) if (e.act) ACTS.set(`auto.${id}`, e.act);
  for (const [id, e] of Object.entries(PANELS)) if (!e.no) ACTS.set(`window.${id}`, { what: `Opens the ${id} panel (Window menu).`, needs: null, view: true, panel: null });

  // ---------- the state an action needs ----------
  function lacks(c, needs) {
    if (!needs) return false;
    const app = c.app;
    const sel = c.seq.clips.filter((x) => app.selection?.has(x.id));
    const io = app.inOut || {};
    const under = c.seq.clips.filter((x) => x.start <= app.t && app.t < M().clipEnd(x) && !M().trackOf(c.seq, x.track)?.locked);
    switch (needs) {
      case 'selection': return !sel.length;
      case 'two': return sel.length < 2;
      case 'clip': return !under.length;
      case 'video': return !under.some((x) => K.kindOf(c, x) === 'video' && x.source?.media != null && !M().isStill(c.project, x));
      case 'in': return io.in == null;
      case 'out': return io.out == null;
      case 'inOut': return io.in == null || io.out == null || io.out <= io.in;
      case 'marker': return !c.seq.markers.some((m) => m.t === app.t || (m.duration > 0 && m.t <= app.t && app.t < m.t + m.duration));
      case 'markers': return !c.seq.markers.length;
      case 'source': return !app.source;
      case 'clipboard': return !(c.services?.clipboard?.() > 0);
      default: return false;
    }
  }
  // What a person sees of the editor, before and after an action.
  function state(c) {
    const app = c.app;
    const h = app.history;
    const steps = h.list().filter((x) => x.done);
    return {
      steps: steps.length, last: steps.at(-1)?.label ?? null, position: h.position, sequence: app.sequenceId, playhead: app.t,
      selection: [...(app.selection || [])].sort().join(','), in: app.inOut?.in ?? null, out: app.inOut?.out ?? null, tool: app.tool ?? null,
      source: app.source ? JSON.stringify(app.source) : null, view: JSON.stringify(c.services?.view?.() ?? null),
    };
  }

  tool('list_actions', 'read', 'List the actions',
    'The editor\'s keyboard and menu actions that run_action runs (the ones with a tool of their own are not listed): id, what it does, what it needs, and view: true when it changes only what the user sees (no undo step). search narrows by words of the id or the text.',
    bare({ search: str('Words to look for.', { maxLength: 60 }) }),
    (c, a) => {
      const words = String(a.search || '').toLowerCase().split(/\s+/).filter(Boolean);
      const out = [];
      for (const [id, x] of ACTS) {
        if (words.length && !words.every((w) => `${id} ${x.what}`.toLowerCase().includes(w))) continue;
        out.push({ id, what: x.what, ...(x.needs ? { needs: NEEDS[x.needs] } : {}), ...(x.view ? { view: true } : {}) });
      }
      return { actions: out };
    });

  tool('run_action', 'edit', 'Run an action',
    'Runs one of the editor\'s keyboard or menu actions as the key would (list_actions gives the ids, what they do and need). time moves the playhead first and clip_ids selects clips first, for actions that work at the playhead or on the selection. Refused when what the action needs is missing; the result says what changed (the undo step, the selection, the playhead, In/Out).',
    bare({ id: str('The action id (list_actions).', { maxLength: 60 }), time: num('Move the playhead here first (s).', { minimum: 0 }), clip_ids: ids('Select these clips first.') }, ['id']),
    async (c0, a) => {
      const x = ACTS.get(a.id);
      if (!x) {
        const e = KEYS[a.id] || AUTOMATION[a.id.replace(/^auto\./, '')];
        if (e?.no) refuse(`${a.id} is not for AI: ${e.no}`);
        if (e?.tools?.length) refuse(`${a.id} has its own tool: ${e.tools.join(' or ')}.`);
        refuse(`There is no action ${a.id}. list_actions lists them.`);
      }
      const c = context(c0);
      if (!c.services?.action) refuse('Actions cannot run here.');
      if (a.clip_ids) for (const id of a.clip_ids) clipOf(c, id, { unlocked: false });
      if (a.time != null) {
        const t0 = K.timeIn(c, a.time, 'time');
        const t1 = K.TM().snap(t0, c.seq.fps);
        if (c.services.seek) c.services.seek(t1); else c.app.setTime(t1);
      }
      if (a.clip_ids) c.app.select(a.clip_ids, { add: false });
      if (lacks(c, x.needs)) refuse(`${a.id} needs ${NEEDS[x.needs]}, and there is none. Nothing was changed.`);
      const before = state(c);
      const r = await c.services.action(a.id, { panel: x.panel });
      if (r?.error) refuse(`${a.id} failed: ${r.error}`);
      const after = state(c);
      const changed = {};
      if (after.steps !== before.steps || after.last !== before.last || after.position !== before.position) changed.undoStep = after.last;
      if (after.sequence !== before.sequence) changed.sequence = after.sequence;
      if (after.playhead !== before.playhead) changed.playhead = sec(c, after.playhead);
      if (after.selection !== before.selection) changed.selection = after.selection ? after.selection.split(',') : [];
      if (after.in !== before.in || after.out !== before.out) changed.inOut = { in: after.in == null ? null : sec(c, after.in), out: after.out == null ? null : sec(c, after.out) };
      if (after.tool !== before.tool) changed.tool = after.tool;
      if (after.source !== before.source) changed.sourceMonitor = c.app.source ? 'a clip is open' : 'empty';
      if (after.view !== before.view) changed.view = true;
      const said = (r?.toasts || []).filter(Boolean);
      if (!Object.keys(changed).length && !(x.view && r?.ran)) refuse(`${a.id} changed nothing${said.length ? `; the editor said: ${said.join(' ')}` : '.'}`);
      const value = { action: a.id, changed, playhead: sec(c, c.app.t), ...(said.length ? { said } : {}) };
      return changed.undoStep !== undefined ? { edit: { at: c.app.t }, ...value } : value;
    }, (a) => ['Run {id}', { id: a.id }]);

  // for the inventory test and the docs table
  K.inventory = INVENTORY;
  K.actions = ACTS;
});
