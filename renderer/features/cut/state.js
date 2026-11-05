// The editor's shared state (Cut.app), which every panel reads and listens to: the open project and its edit history,
// the active sequence, the playhead, the selection, the tool, the source clip in the source monitor and the In/Out
// points. Panels change the project only through app.history.do(command) (commands.js); everything else through the
// setters here, each of which emits one event:
//   'project'   the project changed (an edit, undo, redo, open): {project, reason}
//   'sequence'  another sequence became active: {id}
//   'time'      the playhead moved: {t}
//   'playing'   playback started or stopped: {playing}
//   'selection' the selected clips changed: {ids}
//   'tool'      the timeline tool changed: {tool}
//   'source'    the source monitor shows another clip, or its In/Out changed: {source}
//   'inout'     the sequence In/Out changed: {in, out}
//   'focus'     the panel that has the keyboard changed: {panel}
// on(event, fn) returns a function that removes the listener.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).state = api;
})(() => {
  function createApp() {
    const listeners = new Map();
    const app = {
      history: null, // set by setHistory: {project, do, undo, redo, ...} from commands.js
      path: null, // the .ncut file, or null while untitled
      sequenceId: null,
      t: 0,
      playing: false,
      selection: new Set(),
      tool: 'select', // 'select' | 'trackForward' | 'trackBackward' | 'ripple' | 'roll' | 'rate' | 'razor' | 'slip' | 'slide' | 'pen' | 'hand' | 'zoom' | 'text'
      source: null, // {mediaId, in, out, t} shown in the source monitor
      inOut: { in: null, out: null },
      focusPanel: null, // 'project' | 'source' | 'program' | 'timeline' | 'controls' | 'effects' | 'captions' | ...

      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      emit(event, payload) {
        for (const fn of [...(listeners.get(event) || [])]) {
          try { fn(payload); } catch (err) { (globalThis.ide?.logger?.('#cut') || console).error?.(`${event} listener: ${err?.stack || err}`); }
        }
      },

      get project() { return app.history?.project || null; },
      get sequence() { return app.project?.sequences.find((s) => s.id === app.sequenceId) || null; },

      setHistory(history, path = null, reason = 'open') {
        app.history?.dispose?.();
        app.history = history;
        app.path = path;
        history.onChange?.((r) => app.emit('project', { project: history.project, reason: r }));
        app.selection = new Set();
        app.sequenceId = history.project.sequences[0]?.id || null;
        app.t = 0;
        app.inOut = { in: null, out: null };
        app.emit('project', { project: history.project, reason });
        app.emit('sequence', { id: app.sequenceId });
        app.emit('time', { t: 0 });
        app.emit('selection', { ids: [] });
      },
      setSequence(id) {
        if (id === app.sequenceId) return;
        app.sequenceId = id;
        app.selection = new Set();
        app.inOut = { in: null, out: null };
        app.emit('sequence', { id });
        app.emit('selection', { ids: [] });
      },
      setTime(t) {
        const v = Math.max(0, Math.round(t));
        if (v === app.t) return;
        app.t = v;
        app.emit('time', { t: v });
      },
      setPlaying(on) {
        if (on === app.playing) return;
        app.playing = on;
        app.emit('playing', { playing: on });
      },
      select(ids, { add = false, toggle = false } = {}) {
        const next = add || toggle ? new Set(app.selection) : new Set();
        for (const id of ids) {
          if (toggle && next.has(id)) next.delete(id);
          else next.add(id);
        }
        app.selection = next;
        app.emit('selection', { ids: [...next] });
      },
      setTool(tool) {
        if (tool === app.tool) return;
        app.tool = tool;
        app.emit('tool', { tool });
      },
      setSource(source) {
        app.source = source;
        app.emit('source', { source });
      },
      setInOut(inOut) {
        app.inOut = { ...app.inOut, ...inOut };
        app.emit('inout', app.inOut);
      },
      setFocus(panel) {
        if (panel === app.focusPanel) return;
        app.focusPanel = panel;
        app.emit('focus', { panel });
      },
    };
    return app;
  }
  return { createApp };
});
