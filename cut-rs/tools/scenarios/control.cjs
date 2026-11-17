// The control API's tools (renderer/features/cut/control*.js) for the Rust port (crates/cut-app/src/control): the
// tool table as MCP lists it, the instructions, run_action's action table, the schema check, the chat's step lines,
// and whole scripts of tool calls run on a project with the Node test's stand-in services (effects only), so the
// Rust tools can be compared answer by answer and the project after them field by field.
const path = require('node:path');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const K = require(path.join(CUT, 'control.js'));
const C = require(path.join(CUT, 'commands.js'));
const state = require(path.join(CUT, 'state.js'));
const effects = require(path.join(CUT, 'effects.js'));

const plainSet = (v) => (v instanceof Set ? [...v] : v);

// What run_action says of an id it does not run: the keyboard's and the Automation menu's entries, not for AI or with
// tools of their own.
const entries = (o) => Object.fromEntries(Object.entries(o).filter(([, e]) => !e.act).map(([id, e]) => [id, e.no ? { no: e.no } : { tools: e.tools }]));

module.exports = {
  // The table the Rust tools load (crates/cut-app/src/control/table.json).
  table: () => {
    const kinds = new Map(K.TOOLS.map((t) => [t.name, t.kind]));
    return {
      instructions: K.INSTRUCTIONS,
      tools: K.definitions().map((d) => ({ name: d.name, kind: kinds.get(d.name), title: d.annotations.title, description: d.description, inputSchema: d.inputSchema })),
      actions: [...K.lib.actions].map(([id, a]) => ({ id, what: a.what, needs: a.needs, view: a.view, panel: a.panel })),
      keys: entries(K.lib.inventory.keys),
      automation: entries(K.lib.inventory.automation),
    };
  },
  definitions: () => K.definitions(),
  instructions: () => K.INSTRUCTIONS,
  kinds: () => K.TOOLS.map((t) => [t.name, t.kind]),
  actions: () => [...K.lib.actions].map(([id, a]) => ({ id, ...a })),
  needs: () => {
    // the sentences of control-actions.js's NEEDS, as list_actions writes them
    const out = {};
    for (const a of K.lib.actions.values()) if (a.needs) out[a.needs] = null;
    return Object.keys(out);
  },
  // verify/cut-control-core.mjs's project: a 20 s video with sound (m1), a picture (m2), V1/A1 clips of m1 at 0-10 s,
  // the picture on V2 at 2-4 s, a locked A2 with a clip, a text clip on V3; plus a marker, a caption track, an effect.
  fresh: () => {
    const model = require(path.join(CUT, 'model.js'));
    const T = require(path.join(CUT, 'time.js')).TICKS;
    const p = model.createProject({ sequence: { fps: [30, 1], w: 640, h: 360 } });
    const h0 = C.createHistory(p);
    const [m1, m2] = h0.do(C.importMedia([
      { path: 'C:/media/talk.mp4', name: 'talk.mp4', kind: 'video', size: 1, mtime: 1, duration: 20 * T, video: { w: 640, h: 360, fps: 30, codec: 'avc1' }, audio: { rate: 48000, channels: 2, codec: 'mp4a' } },
      { path: 'C:/media/logo.png', name: 'logo.png', kind: 'image', size: 1, mtime: 1, duration: 0, video: { w: 200, h: 200 }, audio: null },
    ])).ids;
    const s = h0.project.sequences[0];
    h0.do(C.place(s.id, { source: { media: m1 }, in: 0, out: 10 * T, at: 0, video: 'V1', audio: 'A1' }));
    h0.do(C.place(s.id, { source: { media: m2 }, in: 0, out: 2 * T, at: 2 * T, video: 'V2', audio: null }));
    h0.do(C.place(s.id, { source: { media: m1 }, in: 0, out: 4 * T, at: 0, video: null, audio: 'A2' }));
    h0.do(C.addTrack(s.id, 'video'));
    h0.do(C.addGenerated(s.id, { track: 'V3', at: 6 * T, duration: 2 * T, name: 'Hello', source: { generator: 'text', layers: [{ text: 'Hello' }] } }));
    h0.do(C.setTrack(s.id, 'A2', { locked: true }));
    h0.do(C.addMarker(s.id, { t: 3 * T, name: 'Intro', kind: 'chapter', color: 'blue' }));
    h0.do(C.addCaptionTrack(s.id, { name: 'Korean', lang: 'ko', items: [{ start: T, end: 2 * T, text: '안녕하세요' }, { start: 3 * T, end: 4 * T, text: 'Hi' }] }));
    return JSON.parse(h0.serialize()).project ?? JSON.parse(JSON.stringify(h0.project));
  },
  // check() with the tool's own schema (its properties in their order)
  check: (name, value) => K.check(K.TOOLS.find((x) => x.name === name).input, value),
  describe: (name, args) => K.describe(name, args),
  // A script on a project: {project (its JSON), setup: {sequence, t, selection, inOut, undoFloor}, calls: [[name, args]]}
  // -> {results: [{ok, value | error, edit}], project, app: {sequence, t, selection, inOut}}.
  async run({ project, setup = {}, calls }) {
    const h = C.createHistory(project, { limit: Infinity });
    const app = state.createApp();
    app.setHistory(h);
    if (setup.sequence) app.setSequence(setup.sequence);
    if (setup.t != null) app.setTime(setup.t);
    if (setup.selection) app.select(setup.selection);
    if (setup.inOut) app.setInOut(setup.inOut);
    const results = [];
    for (const [name, args] of calls) {
      const r = await K.call(name, args, { app, services: { effects }, undoFloor: setup.undoFloor ?? null });
      results.push(r.ok ? { ok: true, value: r.value, edit: r.edit } : { ok: false, error: r.error });
    }
    return {
      results,
      project: JSON.parse(JSON.stringify(h.project)),
      app: { sequence: app.sequenceId, t: app.t, selection: plainSet(app.selection), inOut: app.inOut, steps: h.list().filter((x) => x.done).map((x) => x.label) },
    };
  },
};
