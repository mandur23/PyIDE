// The Cut control API (docs/cut-ai-control.md): the tools an AI uses to read and edit the open project, served over
// MCP by main/cut/control.js and answered here, in the page, by ui-assistant.js. The AI assistant panel's Claude and an
// external AI the user allows (the setting cut.control.external) call the same tools.
//
// Every tool is a row of TOOLS: a name, a description written for a model, a JSON schema (checked by `check` before
// anything runs), its kind ('read', 'edit', 'play' or 'export') and `run(c, a)`. An edit goes through Cut.commands
// (history.do, or several in one history group), and through the edit-command allowlist of ai.js (validatePlan,
// planCommands) where an operation of it fits, so the rules a person's edit follows hold for the AI's too. A refused
// edit throws a Refusal with a sentence the model can act on; history.do takes back a command that fails and a group
// that fails is cancelled, so a refusal never leaves half an edit.
//
// What no tool does: read or write a file, take a path, open anything, run a program. Media come in only by their ids
// in the project; the frame tool renders in the page; export_sequence asks the user (services.exportAsk) before the
// export queue writes a new file. Services (the frame, the transcript, silences, playback, the export question) are
// handed in by the page, so the Node test runs every tool on a real project with stand-ins.
//
// Times in and out are seconds on the sequence's timeline (frames at its rate beside them), source_in and source_out
// seconds of the source; ticks (time.js) inside.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).control = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const M = () => need('model');
  const C = () => need('commands');
  const TM = () => need('time');

  class Refusal extends Error {
    constructor(message) { super(message); this.refusal = true; }
  }
  const refuse = (message) => { throw new Refusal(message); };

  const r3 = (x) => Math.round(x * 1000) / 1000;
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const MAX_ITEMS = 500;
  const PRESETS = need('presets').EXPORT.map((p) => p.id);
  const MARKER_COLORS = ['green', 'red', 'purple', 'orange', 'yellow', 'white', 'blue', 'cyan'];
  const CLIP_ID = /^c\d+$/;
  // the timeline's clip labels (ui-timeline.js LABELS)
  const LABELS = ['violet', 'iris', 'caribbean', 'lavender', 'cerulean', 'forest', 'rose', 'mango'];

  const INSTRUCTIONS = [
    'Nano Studio Cut is a video editor. These tools read and edit the project open in it. Every edit shows live in the',
    'editor, becomes part of its undo history and can be undone by the user.',
    'Times are seconds on the sequence timeline (with frame numbers at the sequence rate beside them); source_in and',
    'source_out are seconds of the source media. Edits snap to whole frames.',
    'Ids (clips c<n>, media m<n>, tracks V1/A1, markers, captions, effects e<n>) come from the read tools: call',
    'get_sequence before editing, and get_clip for one clip\'s details. sequence_id may be left out: the active sequence.',
    'A refused edit changes nothing. Read its message, then fix the arguments or tell the user why it cannot be done.',
    'Change only what the request asks for. Do not change project or sequence settings, other clips or anything else',
    'the user did not ask about, not even to make a refused edit work; suggest such a change in your answer instead.',
    'Keyboard and menu commands without a tool of their own run with run_action (list_actions lists them).',
    'Long jobs (automation, proxies, an export with wait) report progress and end when the user presses Stop. A call',
    'still running after a while (or one waiting for the user\'s answer in a dialog) answers {running: true, job,',
    'progress}: it has not failed and goes on running. Call wait_job with that job until it gives the tool\'s own',
    'result; never start the tool again, and do not tell the user it failed or timed out while it runs.',
    'Files: import_media brings in only files the user confirms in a dialog or that are in the project\'s folder;',
    'export_sequence, export_frame and export_captions ask the user first and write new files only; save_project writes',
    'the project\'s own file (and asks where when it has none). Nothing else reads or writes files, and nothing is',
    'downloaded unless the user agrees in Cut\'s setup dialog. Locked tracks are the user\'s: leave them alone.',
  ].join(' ');

  // ---------- schemas ----------
  const num = (description, more = {}) => ({ type: 'number', description, ...more });
  const int = (description, more = {}) => ({ type: 'integer', description, ...more });
  const str = (description, more = {}) => ({ type: 'string', description, ...more });
  const bool = (description) => ({ type: 'boolean', description });
  const list = (items, description, more = {}) => ({ type: 'array', items, description, ...more });
  const pair = (description) => list({ type: 'number' }, description, { minItems: 2, maxItems: 2 });
  const ids = (description) => list({ type: 'string', maxLength: 64 }, description, { minItems: 1, maxItems: MAX_ITEMS });
  const SEQ = { sequence_id: str('The sequence; the active one when left out.', { maxLength: 64 }) };
  const obj = (properties, required = []) => ({ type: 'object', properties: { ...SEQ, ...properties }, required, additionalProperties: false });
  const bare = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

  // A small JSON-schema check: types, required, enums, ranges, lengths, no unknown fields. -> an error sentence or ''.
  function check(schema, value, at = 'arguments') {
    const types = [].concat(schema.type || []);
    if (value === null && types.includes('null')) return '';
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) && types.includes('integer') ? 'integer' : typeof value;
    const okType = types.some((t) => t === type || (t === 'number' && type === 'integer') || (t === 'integer' && type === 'number' && Number.isInteger(value)));
    if (types.length && !okType) return `${at} must be ${types.join(' or ')}.`;
    if (type === 'number' || type === 'integer') {
      if (!Number.isFinite(value)) return `${at} must be a finite number.`;
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}.`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}.`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}.`;
    }
    if (type === 'string') {
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}.`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength} characters.`;
    }
    if (type === 'array') {
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} needs at least ${schema.minItems} items.`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items.`;
      for (const [i, v] of value.entries()) {
        const e = schema.items ? check(schema.items, v, `${at}[${i}]`) : '';
        if (e) return e;
      }
    }
    if (type === 'object') {
      for (const k of schema.required || []) if (!own(value, k) || value[k] === undefined) return `${at === 'arguments' ? 'The call' : at} needs "${k}".`;
      for (const [k, v] of Object.entries(value)) {
        if (!schema.properties || !own(schema.properties, k)) {
          if (schema.additionalProperties === false) return `${at === 'arguments' ? 'There is no argument' : `${at} has no field`} "${k}"${schema.properties ? ` (known: ${Object.keys(schema.properties).join(', ') || 'none'})` : ''}.`;
          continue;
        }
        const e = check(schema.properties[k], v, `${at === 'arguments' ? '' : `${at}.`}${k}`);
        if (e) return e;
      }
    }
    return '';
  }

  // ---------- the sequence a call works on ----------
  function context(env, a = {}) {
    const { app } = env;
    const project = app.project;
    if (!project) refuse('No project is open.');
    let seq = app.sequence;
    if (a.sequence_id != null) {
      seq = project.sequences.find((s) => s.id === a.sequence_id);
      if (!seq) refuse(`There is no sequence ${a.sequence_id}. get_project lists the sequences.`);
    }
    if (!seq) refuse('There is no active sequence.');
    const T = TM().TICKS;
    const f = TM().frameTicks(seq.fps);
    return { ...env, project, seq, T, f, duration: M().sequenceDuration(seq) };
  }
  const sec = (c, ticks) => r3(ticks / c.T);
  const frame = (c, ticks) => Math.round(ticks / c.f);
  const ticks = (c, s) => Math.round(s * c.T);
  // A time on the timeline: inside the sequence (its end included, a little past it forgiven).
  function timeIn(c, s, what = 'time', { pastEnd = false } = {}) {
    const end = c.duration / c.T;
    if (s < 0 || (!pastEnd && s > end + 0.05)) refuse(`${what} ${s} s is outside the sequence (0 to ${r3(end)} s).`);
    return Math.min(ticks(c, s), pastEnd ? Infinity : c.duration);
  }
  function clipOf(c, id, { unlocked = true } = {}) {
    const clip = c.seq.clips.find((x) => x.id === id);
    if (!clip) refuse(`There is no clip ${id} in sequence "${c.seq.name}". get_sequence lists the clips.`);
    if (unlocked) trackOf(c, clip.track, { unlocked: true });
    return clip;
  }
  function trackOf(c, id, { kind = null, unlocked = false } = {}) {
    const t = c.seq.tracks.find((x) => x.id === id);
    if (!t) refuse(`There is no track ${id}. The tracks are ${c.seq.tracks.map((x) => x.id).join(', ')}.`);
    if (kind && t.kind !== kind) refuse(`Track ${id} is a${t.kind === 'audio' ? 'n audio' : ' video'} track; this needs a${kind === 'audio' ? 'n audio' : ' video'} track.`);
    if (unlocked && t.locked) refuse(`Track ${id} is locked. Locked tracks are the user's; edit other tracks, or ask the user to unlock it.`);
    return t;
  }
  const kindOf = (c, clip) => M().trackOf(c.seq, clip.track)?.kind;
  function mediaOf(c, id) {
    if (/[\\/:]|\.[a-z0-9]{2,4}$/i.test(id)) refuse('Media are named by their ids (get_media), never by a file path. Importing files is the user\'s: ask them to import it first.');
    const m = c.project.media.find((x) => x.id === id);
    if (!m) refuse(`There is no media ${id} in the project. get_media lists them.`);
    return m;
  }
  // Runs history.do; a command a person could not do either comes back as a refusal.
  function run(c, cmd) {
    try { return c.app.history.do(cmd); } catch (err) { throw new Refusal(`The editor refused: ${err?.message || err}`); }
  }
  // Several commands as one step that is taken back whole when one fails.
  function atomic(c, label, fn) {
    const h = c.app.history;
    h.begin(label);
    try {
      const r = fn();
      h.commit();
      return r;
    } catch (err) {
      h.cancel();
      throw err;
    }
  }
  // ai.js's whitelisted edit operations, checked there and turned into commands there.
  function plan(c, ops, { label, silence = [] } = {}) {
    const AI = need('ai');
    const v = AI.validatePlan({ ops }, {
      duration: c.duration, tracks: c.seq.tracks.map((t) => ({ id: t.id, kind: t.kind })), clips: c.seq.clips.map((x) => x.id), selection: [...(c.app.selection || [])],
    });
    if (v.error) refuse(v.error.replace(/^Operation 1(?: \(\w+\))?: ?/, ''));
    const cmds = AI.planCommands(v.value.ops, { seq: c.seq, selection: [...(c.app.selection || [])], silence });
    if (!cmds.length) refuse('That changes nothing.');
    return run(c, C().batch(label, cmds));
  }

  // ---------- what the read tools say ----------
  function sourceName(c, clip) {
    const s = clip.source || {};
    if (s.generator) return s.generator;
    if (s.sequence) return `nest ${s.sequence}`;
    return `${s.freeze ? 'freeze ' : ''}media ${s.media}`;
  }
  function clipSummary(c, clip) {
    const m = M();
    const kind = kindOf(c, clip);
    const out = { id: clip.id, track: clip.track, start: sec(c, clip.start), end: sec(c, m.clipEnd(clip)), startFrame: frame(c, clip.start), endFrame: frame(c, m.clipEnd(clip)) };
    const name = clip.name || (clip.source?.media ? m.mediaOf(c.project, clip)?.name : '') || '';
    if (name) out.name = name;
    out.source = sourceName(c, clip);
    if (!clip.source?.generator) { out.in = sec(c, clip.in); out.out = sec(c, clip.out); }
    if (clip.speed !== 1) out.speed = r3(clip.speed * 100);
    if (clip.reverse) out.reverse = true;
    if (clip.remap) out.timeRemap = true;
    if (clip.enabled === false) out.enabled = false;
    if (clip.link) out.link = clip.link;
    if (clip.group) out.group = clip.group;
    if (clip.role) out.role = clip.role;
    if (kind === 'audio') out.volume = clip.props.volume || 0;
    else if (clip.props.opacity !== 100) out.opacity = clip.props.opacity;
    if (clip.source?.generator === 'text') out.text = (clip.source.layers || []).map((l) => l.text).join(' / ').slice(0, 200);
    if (clip.effects?.length) out.effects = clip.effects.map((e) => `${e.id} ${e.type}${e.on ? '' : ' (off)'}`);
    const keyed = Object.keys(clip.keyframes || {});
    if (keyed.length) out.keyframed = keyed;
    if (clip.masks?.length) out.masks = clip.masks.length;
    if (clip.markers?.length) out.markers = clip.markers.length;
    return out;
  }
  function trackSummary(t) {
    const o = { id: t.id, kind: t.kind };
    if (t.name && t.name !== t.id) o.name = t.name;
    if (t.locked) o.locked = true;
    if (t.kind === 'video' && t.visible === false) o.hidden = true;
    if (t.kind === 'audio') { if (t.mute) o.mute = true; if (t.solo) o.solo = true; if (t.volume) o.volume = t.volume; if (t.pan) o.pan = t.pan; }
    if (!t.syncLock) o.syncLock = false;
    return o;
  }
  const fpsOf = (seq) => r3(seq.fps[0] / seq.fps[1]);
  function markerSummary(c, mk, base = 0) {
    const o = { id: mk.id, time: sec(c, base + mk.t), frame: frame(c, base + mk.t), kind: mk.kind, name: mk.name || '' };
    if (mk.color && mk.color !== 'green') o.color = mk.color;
    if (mk.note) o.note = mk.note;
    if (mk.duration) o.duration = sec(c, mk.duration);
    return o;
  }
  const overlaps = (a0, a1, from, to) => (from == null || a1 > from) && (to == null || a0 < to);
  function paramText(p) {
    const range = p.min !== undefined ? ` ${p.min}..${p.max}` : '';
    const choices = p.choices ? ` ${p.choices.map((x) => x[0]).join('|')}` : '';
    return `${p.id}: ${p.type}${range}${choices} = ${JSON.stringify(p.default)}${p.unit ? ` ${p.unit}` : ''}`;
  }

  // ---------- checks of values ----------
  function effectDef(c, type) {
    const E = c.services?.effects || need('effects');
    const def = E.get(type);
    if (!def || def.kind === undefined || E.transitions().some((t) => t.type === type)) refuse(`There is no effect "${type}". list_effects lists them.`);
    return def;
  }
  function paramValue(def, id, v, at = id, luts = null) {
    const p = def.params.find((x) => x.id === id);
    if (!p) refuse(`Effect ${def.type} has no parameter "${id}". Its parameters: ${def.params.map((x) => x.id).join(', ')}.`);
    switch (p.type) {
      case 'number': case 'percent': case 'angle':
        if (typeof v !== 'number' || !Number.isFinite(v)) refuse(`${at} must be a number.`);
        if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) refuse(`${at} ${v} is outside ${p.min} to ${p.max}.`);
        return v;
      case 'bool':
        if (typeof v !== 'boolean') refuse(`${at} must be true or false.`);
        return v;
      case 'choice':
        if (!p.choices.some((x) => x[0] === v)) refuse(`${at} must be one of ${p.choices.map((x) => x[0]).join(', ')}.`);
        return v;
      case 'color':
        if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) refuse(`${at} must be a color like #ff8800.`);
        return v;
      case 'point':
        if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) refuse(`${at} must be [x, y].`);
        return v;
      case 'curve':
        if (!Array.isArray(v) || v.length % 2 || v.length < 4 || v.length > 32 || !v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) refuse(`${at} must be a flat list of 2 to 16 points [x0, y0, x1, y1, ...] from 0 to 1.`);
        return v;
      case 'lut':
        if (v === '' || (typeof v === 'string' && luts && Object.hasOwn(luts, v))) return v;
        refuse(`${at} must be "" (no LUT) or a LUT the project has (get_project lists luts: ${Object.keys(luts || {}).join(', ') || 'none'}). Loading a LUT file is the user's.`);
        break;
      default:
        refuse(`${at} cannot be set by these tools.`);
    }
    return v;
  }
  const PROP_RULES = {
    position: { pair: true, desc: '[x, y] pixels from the center' },
    scale: { pair: true, min: 0, max: 10000, desc: '[width %, height %] or one %' },
    rotation: { min: -36000, max: 36000, desc: 'degrees' },
    anchor: { pair: true, desc: '[x, y] pixels from the center' },
    opacity: { min: 0, max: 100, desc: '%' },
    crop: { four: true, min: 0, max: 100, desc: '[top, right, bottom, left] %' },
    volume: { min: -60, max: 24, desc: 'dB' },
    pan: { min: -100, max: 100, desc: '-100 left to 100 right' },
  };
  function propValue(name, v) {
    const r = PROP_RULES[name];
    if (name === 'scale' && typeof v === 'number') v = [v, v];
    const inRange = (x) => Number.isFinite(x) && (r.min === undefined || (x >= r.min && x <= r.max));
    if (r.pair && (!Array.isArray(v) || v.length !== 2 || !v.every(inRange))) refuse(`${name} must be ${r.desc}${r.min !== undefined ? `, each ${r.min} to ${r.max}` : ''}.`);
    if (r.four && (!Array.isArray(v) || v.length !== 4 || !v.every(inRange))) refuse(`${name} must be ${r.desc}.`);
    if (!r.pair && !r.four && (typeof v !== 'number' || !inRange(v))) refuse(`${name} must be a number from ${r.min} to ${r.max} (${r.desc}).`);
    return v;
  }
  function needKind(c, clip, kind, what) {
    const k = kindOf(c, clip);
    if (k === kind) return;
    const partner = M().linkedClips(c.seq, clip).find((l) => kindOf(c, l) === kind);
    refuse(`${what} belongs to ${kind} clips; ${clip.id} is a${k === 'audio' ? 'n audio' : ' video'} clip.${partner ? ` Its linked ${kind} clip is ${partner.id}.` : ''}`);
  }

  // ---------- the tools ----------
  const TOOLS = [];
  const BY_NAME = new Map();
  const tool = (name, kind, title, description, input, runFn, say = null) => {
    if (BY_NAME.has(name)) throw new Error(`tool ${name} twice`);
    const t = { name, kind, title, description, input, run: runFn, say };
    TOOLS.push(t);
    BY_NAME.set(name, t);
  };

  // reading
  tool('get_project', 'read', 'Read the project',
    'The project\'s sequences (size, rate, length, clip count, which is active), its media count, bins, LUTs, settings, whether it was saved to a file and has unsaved changes, the playhead and the selection. Start here.',
    bare(), (c) => {
      const app = c.app;
      const p = app.project;
      if (!p) refuse('No project is open.');
      const T = TM().TICKS;
      const s = p.settings;
      return {
        sequences: p.sequences.map((q) => ({ id: q.id, name: q.name, width: q.w, height: q.h, fps: fpsOf(q), duration: r3(M().sequenceDuration(q) / T), clips: q.clips.length, active: q.id === app.sequenceId || undefined })),
        media: p.media.length,
        bins: p.bins.map((b) => ({ id: b.id, name: b.name, ...(b.parent ? { parent: b.parent } : {}), items: b.items.length })),
        luts: Object.entries(p.luts || {}).map(([id, e]) => ({ id, name: e.name })),
        activeSequence: app.sequenceId,
        playhead: r3(app.t / T),
        selection: [...(app.selection || [])],
        savedToFile: !!app.path, unsavedChanges: !!app.history?.dirty,
        settings: { stillDuration: r3(s.stillDuration / T), transitionDuration: r3(s.transitionDuration / T), freezeDuration: r3((s.freezeDuration || 0) / T), fit: s.fit, speechTerms: s.speechTerms || [] },
      };
    });
  tool('get_sequence', 'read', 'Read the timeline',
    'A sequence\'s tracks, clips (time on the timeline, source range, effects, links), transitions and caption tracks. from/to (seconds) keep the clips that overlap that range; long sequences are cut at max_clips.',
    obj({ from: num('Only clips that end after this time (s).', { minimum: 0 }), to: num('Only clips that start before this time (s).', { minimum: 0 }), max_clips: int('At most this many clips (default 300).', { minimum: 1, maximum: 2000 }) }),
    (c, a) => {
      const m = M();
      const all = c.seq.clips.filter((x) => overlaps(x.start / c.T, m.clipEnd(x) / c.T, a.from, a.to)).sort((x, y) => x.start - y.start || x.track.localeCompare(y.track));
      const max = a.max_clips || 300;
      return {
        id: c.seq.id, name: c.seq.name, width: c.seq.w, height: c.seq.h, fps: fpsOf(c.seq), duration: sec(c, c.duration), durationFrames: frame(c, c.duration),
        masterGain: c.seq.masterGain || 0,
        tracks: c.seq.tracks.map(trackSummary),
        clips: all.slice(0, max).map((x) => clipSummary(c, x)),
        ...(all.length > max ? { truncated: `${all.length - max} more clips; ask with from/to` } : {}),
        transitions: c.seq.transitions.map((t) => ({ id: t.id, track: t.track, at: sec(c, t.at), atFrame: frame(c, t.at), type: t.type, duration: sec(c, t.duration), align: t.align })),
        markers: c.seq.markers.length,
        captionTracks: (c.seq.captions || []).map((t) => ({ id: t.id, name: t.name, lang: t.lang, items: t.items.length })),
      };
    });
  tool('get_clip', 'read', 'Read a clip',
    'Everything about one clip: properties, keyframes (times on the timeline), effects with all their parameters, masks, text layers, clip markers.',
    obj({ clip_id: str('The clip.') }, ['clip_id']), (c, a) => {
      const clip = clipOf(c, a.clip_id, { unlocked: false });
      const E = c.services?.effects || need('effects');
      const out = clipSummary(c, clip);
      out.props = clip.props;
      out.keyframes = Object.fromEntries(Object.entries(clip.keyframes || {}).map(([k, list]) => [k, list.map((kf) => ({ time: sec(c, clip.start + kf.t), value: kf.v, ease: kf.ease }))]));
      out.effects = (clip.effects || []).map((e) => ({ id: e.id, type: e.type, on: e.on, params: E.resolve ? E.resolve(e.type, e.params) : e.params, masks: e.masks?.map((mk) => mk.id) }));
      if (clip.masks?.length) out.masks = clip.masks.map((mk) => ({ id: mk.id, mode: mk.mode, inverted: mk.inverted, feather: mk.feather, opacity: mk.opacity, expansion: mk.expansion, points: mk.path.length / 6 }));
      if (clip.source?.generator === 'text') out.layers = clip.source.layers.map((l) => ({ id: l.id, text: l.text, font: l.font, size: l.size, weight: l.weight, color: l.fill, position: l.position, align: l.align }));
      if (clip.source?.generator === 'solid') out.color = clip.source.color;
      if (clip.source?.generator === 'graphic') out.layers = lib.graphicLayers(clip);
      if (clip.markers?.length) out.markers = clip.markers.map((mk) => markerSummary(c, mk, clip.start));
      if (kindOf(c, clip) === 'audio') { out.fadeIn = sec(c, clip.fadeIn || 0); out.fadeOut = sec(c, clip.fadeOut || 0); }
      out.linked = M().linkedClips(c.seq, clip).map((l) => l.id);
      return out;
    });
  tool('get_media', 'read', 'Read the media',
    'The project\'s media: id, name, kind, length, picture size and rate, whether it has sound, how many clips use it, its bin, whether it has a proxy or its file is missing (offline). No file paths.',
    bare(), (c) => {
      const T = TM().TICKS;
      const p = c.app.project;
      if (!p) refuse('No project is open.');
      const used = new Map();
      for (const s of p.sequences) for (const x of s.clips) if (x.source?.media) used.set(x.source.media, (used.get(x.source.media) || 0) + 1);
      const binOf = new Map(p.bins.flatMap((b) => b.items.map((id) => [id, b.id])));
      return p.media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind, duration: m.kind === 'image' ? null : r3(m.duration / T),
        ...(m.video ? { width: m.video.w, height: m.video.h, fps: m.video.fps ? r3(m.video.fps) : undefined } : {}), audio: !!m.audio, clips: used.get(m.id) || 0,
        ...(binOf.has(m.id) ? { bin: binOf.get(m.id) } : {}), ...(m.proxy ? { proxy: true } : {}), ...(c.services?.offline?.(m.id) ? { offline: true } : {}),
      }));
    });
  tool('get_markers', 'read', 'Read the markers', 'The sequence markers and the clip markers (times on the timeline).',
    obj(), (c) => ({
      sequence: c.seq.markers.map((mk) => markerSummary(c, mk)),
      clips: c.seq.clips.flatMap((x) => (x.markers || []).map((mk) => ({ clip: x.id, ...markerSummary(c, mk, x.start) }))),
    }));
  tool('get_captions', 'read', 'Read the captions',
    'Caption tracks and their items (id, start, end, text). track_id picks one track; from/to (s) keep the items in that range; max_items caps each track (default 300).',
    obj({ track_id: str('A caption track (cc<n>).'), from: num('From this time (s).', { minimum: 0 }), to: num('Until this time (s).', { minimum: 0 }), max_items: int('At most this many items a track.', { minimum: 1, maximum: 2000 }) }),
    (c, a) => {
      const tracks = (c.seq.captions || []).filter((t) => !a.track_id || t.id === a.track_id);
      if (a.track_id && !tracks.length) refuse(`There is no caption track ${a.track_id}.`);
      return tracks.map((t) => {
        const items = t.items.filter((it) => overlaps(it.start / c.T, it.end / c.T, a.from, a.to));
        const max = a.max_items || 300;
        return { id: t.id, name: t.name, lang: t.lang, items: items.slice(0, max).map((it) => ({ id: it.id, start: sec(c, it.start), end: sec(c, it.end), text: it.text })), ...(items.length > max ? { truncated: items.length - max } : {}) };
      });
    });
  tool('get_transcript', 'read', 'Read the transcript',
    'What is said in the sequence, from speech recognition already done in Cut: segments with start, end (s) and text. Empty when the speech was not recognised yet (the user runs Auto Captions or the Transcript panel).',
    obj({ from: num('From this time (s).', { minimum: 0 }), to: num('Until this time (s).', { minimum: 0 }) }),
    async (c, a) => {
      const segs = (await c.services?.transcript?.(c.seq)) || [];
      const keep = segs.filter((s) => overlaps(s.start, s.end, a.from, a.to));
      return keep.length ? keep.slice(0, 2000).map((s) => ({ start: r3(s.start), end: r3(s.end), text: s.text })) : { segments: [], note: 'There is no transcript of this sequence yet.' };
    });
  tool('list_effects', 'read', 'List the effects',
    'The video and audio effects and the transitions there are, with their parameters as "id: type min..max = default". kind and search narrow the list.',
    bare({ kind: str('video or audio.', { enum: ['video', 'audio'] }), search: str('Part of a type, a name or a category.', { maxLength: 60 }) }),
    (c, a) => {
      const E = c.services?.effects || need('effects');
      const q = (a.search || '').toLowerCase();
      const hit = (d) => (!a.kind || d.kind === a.kind) && (!q || `${d.type} ${d.name} ${d.category || ''}`.toLowerCase().includes(q));
      const tr = new Set(E.transitions().map((t) => t.type));
      return {
        effects: E.list().filter((d) => !tr.has(d.type) && hit(d)).map((d) => ({ type: d.type, name: d.name, kind: d.kind, category: d.category, params: d.params.map(paramText) })),
        transitions: E.transitions().filter(hit).map((d) => ({ type: d.type, name: d.name, kind: d.kind, params: d.params.map(paramText) })),
      };
    });
  tool('get_frame', 'read', 'Look at a frame',
    'A PNG of the program monitor\'s picture at a time (the playhead when left out), with the shown caption track burned in, so you can see the edit.',
    obj({ time: num('The time (s).', { minimum: 0 }), width: int('Picture width in pixels, 160 to 1280 (default 640).', { minimum: 160, maximum: 1280 }) }),
    async (c, a) => {
      const t = a.time == null ? Math.min(c.app.t, Math.max(0, c.duration - c.f)) : timeIn(c, a.time);
      if (!c.services?.frame) refuse('Frames cannot be rendered here.');
      const r = await c.services.frame(c.seq, t, a.width || 640);
      if (!r?.ok) refuse(`The frame could not be rendered: ${r?.error || 'unknown error'}`);
      return { $image: { data: r.base64, mimeType: 'image/png' }, time: sec(c, t), frame: frame(c, t), width: r.width, height: r.height };
    });
  tool('get_state', 'read', 'Read the editor state',
    'The playhead, whether it plays, the selected clips, the sequence In/Out and the last steps of the undo history.',
    bare(), (c0) => {
      const c = context(c0);
      const h = c.app.history;
      const steps = h.list().filter((x) => x.done);
      return {
        sequence: c.seq.id, playhead: sec(c, c.app.t), playheadFrame: frame(c, c.app.t), playing: !!c.app.playing,
        selection: [...(c.app.selection || [])],
        inOut: { in: c.app.inOut?.in == null ? null : sec(c, c.app.inOut.in), out: c.app.inOut?.out == null ? null : sec(c, c.app.inOut.out) },
        canUndo: h.canUndo, canRedo: h.canRedo, lastSteps: steps.slice(-5).map((x) => x.label),
      };
    }, null);

  // placing, moving, trimming, cutting
  tool('place_clip', 'edit', 'Place a clip',
    'Puts media (or a nest of another sequence) on the timeline at a time. mode overwrite replaces what is there; insert pushes later clips. Video goes on video_track (default V1), sound on audio_track (default A1); null leaves that part out. source_in/source_out pick part of the media (s); a picture takes duration (s).',
    obj({
      media_id: str('The media (get_media).'), nest_sequence_id: str('Instead of media: another sequence, placed as one nest clip.'),
      at: num('Where it starts on the timeline (s).', { minimum: 0 }), mode: str('overwrite (default) or insert.', { enum: ['overwrite', 'insert'] }),
      video_track: { type: ['string', 'null'], description: 'Video track id, or null for none.' }, audio_track: { type: ['string', 'null'], description: 'Audio track id, or null for none.' },
      source_in: num('Start in the source (s).', { minimum: 0 }), source_out: num('End in the source (s).', { minimum: 0 }), duration: num('Length of a picture (s).', { minimum: 0.01, maximum: 3600 }),
    }, ['at']),
    (c, a) => {
      if ((a.media_id == null) === (a.nest_sequence_id == null)) refuse('Give media_id or nest_sequence_id (one of them).');
      const at = timeIn(c, a.at, 'at');
      let source;
      let hasV = true;
      let hasA = true;
      let length = Infinity;
      if (a.media_id != null) {
        const m = mediaOf(c, a.media_id);
        source = { media: m.id };
        hasV = m.kind === 'image' || !!m.video;
        hasA = !!m.audio;
        if (m.kind !== 'image') length = m.duration / c.T;
      } else {
        const inner = c.project.sequences.find((s) => s.id === a.nest_sequence_id);
        if (!inner) refuse(`There is no sequence ${a.nest_sequence_id}.`);
        if (M().nestLoop(c.project, c.seq.id, inner.id)) refuse('That nest would make the sequence show itself.');
        source = { sequence: inner.id };
        const kinds = M().nestKinds(c.project, inner.id);
        hasV = kinds.video; hasA = kinds.audio;
        length = M().sequenceDuration(inner) / c.T;
      }
      const vt = a.video_track === undefined ? (hasV ? 'V1' : null) : a.video_track;
      const at2 = a.audio_track === undefined ? (hasA ? 'A1' : null) : a.audio_track;
      if (vt) trackOf(c, vt, { kind: 'video', unlocked: true });
      if (at2) trackOf(c, at2, { kind: 'audio', unlocked: true });
      if (a.source_in != null && a.source_in >= length) refuse(`source_in ${a.source_in} s is past the end of the source (${r3(length)} s).`);
      if (a.source_out != null && a.source_in != null && a.source_out <= a.source_in) refuse('source_out must be after source_in.');
      const opts = { source, at, video: vt, audio: at2, mode: a.mode || 'overwrite' };
      if (Number.isFinite(length)) {
        if (a.source_in != null) opts.in = ticks(c, a.source_in);
        if (a.source_out != null) opts.out = ticks(c, Math.min(a.source_out, length));
      } else if (a.duration != null) { opts.in = 0; opts.out = ticks(c, a.duration); }
      const r = run(c, C().place(c.seq.id, opts));
      return { edit: { at: r.at }, clips: r.ids, start: sec(c, r.at), end: sec(c, r.at + r.duration) };
    }, (a) => ['Place {what} at {at} s', { what: a.media_id || a.nest_sequence_id, at: a.at }]);
  tool('move_clips', 'edit', 'Move clips',
    'Moves clips along the timeline (to: the new start of the earliest one, or delta: seconds, negative earlier) and between tracks (track_delta: +1 one track up, -1 down). Linked and grouped clips move along unless linked is false. insert pushes clips at the destination instead of overwriting them.',
    obj({ clip_ids: ids('The clips.'), to: num('New start of the earliest clip (s).', { minimum: 0 }), delta: num('Seconds to move by.'), track_delta: int('Tracks to move by.', { minimum: -20, maximum: 20 }), insert: bool('Push clips at the destination.'), linked: bool('Move linked clips too (default true).') }, ['clip_ids']),
    (c, a) => {
      const clips = a.clip_ids.map((id) => clipOf(c, id));
      if (a.to != null && a.delta != null) refuse('Give to or delta, not both.');
      const first = Math.min(...clips.map((x) => x.start));
      const delta = a.to != null ? ticks(c, a.to) - first : ticks(c, a.delta || 0);
      if (first + delta < 0) refuse(`That would move a clip before the start (by ${r3(delta / c.T)} s from ${sec(c, first)} s).`);
      if (!delta && !a.track_delta) refuse('Give to, delta or track_delta.');
      run(c, C().move(c.seq.id, a.clip_ids, { delta, trackDelta: a.track_delta || 0, insert: !!a.insert, linked: a.linked !== false }));
      return { edit: { at: first + delta }, moved: a.clip_ids };
    }, (a) => ['Move {n} clips', { n: a.clip_ids.length }]);
  tool('trim_clip', 'edit', 'Trim a clip',
    'Moves a clip\'s start or end edge (to: the new edge time, or delta: seconds). mode normal leaves a gap or fills one, ripple moves later clips with the edge, roll moves the neighbouring clip\'s edge too, stretch (Rate Stretch) changes the speed so the same source fills the new length. slip (delta s, no edge) shows a later (+) or earlier part of the source in place; slide (delta s, no edge) moves the clip while its neighbours trim. The result says where it stopped and why (source, neighbour, length, speed).',
    obj({ clip_id: str('The clip.'), edge: str('start or end (not for slip and slide).', { enum: ['start', 'end'] }), to: num('The new edge time (s).', { minimum: 0 }), delta: num('Seconds to move the edge (or slip, slide) by.'), mode: str('normal (default), ripple, roll, stretch, slip or slide.', { enum: ['normal', 'ripple', 'roll', 'stretch', 'slip', 'slide'] }), linked: bool('Linked clips too (default true).') }, ['clip_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      const mode = a.mode || 'normal';
      const linked = a.linked !== false;
      if (mode === 'slip' || mode === 'slide') {
        if (a.delta == null || a.to != null || a.edge != null) refuse(`${mode} takes delta (seconds) and no edge or to.`);
        const r = run(c, C()[mode](c.seq.id, clip.id, { delta: ticks(c, a.delta), linked }));
        const now = c.seq.clips.find((x) => x.id === clip.id);
        return { edit: { at: now.start }, applied: r?.applied != null ? r3(r.applied / c.T) : null, stoppedBy: r?.clamped || null, start: sec(c, now.start), end: sec(c, M().clipEnd(now)), in: sec(c, now.in), out: sec(c, now.out) };
      }
      if (!a.edge) refuse(`mode ${mode} needs edge (start or end).`);
      if ((a.to == null) === (a.delta == null)) refuse('Give to or delta (one of them).');
      const edgeAt = a.edge === 'start' ? clip.start : M().clipEnd(clip);
      const delta = a.to != null ? ticks(c, a.to) - edgeAt : ticks(c, a.delta);
      const r = run(c, mode === 'stretch' ? C().stretch(c.seq.id, clip.id, { edge: a.edge, delta, linked }) : C().trim(c.seq.id, clip.id, { edge: a.edge, delta, mode, linked }));
      const now = c.seq.clips.find((x) => x.id === clip.id);
      return { edit: { at: edgeAt + (r?.applied ?? delta) }, applied: r ? r3(r.applied / c.T) : null, stoppedBy: r?.clamped || null, ...(now ? { start: sec(c, now.start), end: sec(c, M().clipEnd(now)), ...(now.speed !== 1 ? { speed: r3(now.speed * 100) } : {}) } : {}) };
    }, (a) => [a.mode === 'slip' ? 'Slip {clip}' : a.mode === 'slide' ? 'Slide {clip}' : a.edge === 'start' ? 'Trim the start of {clip}' : 'Trim the end of {clip}', { clip: a.clip_id }]);
  tool('razor', 'edit', 'Razor',
    'Cuts clips in two at a time: on every unlocked track, or only on track_ids, or only clip_ids (with their linked clips).',
    obj({ at: num('Where to cut (s).', { minimum: 0 }), track_ids: ids('Only these tracks.'), clip_ids: ids('Only these clips.') }, ['at']),
    (c, a) => {
      const t = timeIn(c, a.at, 'at');
      const m = M();
      if (a.track_ids) for (const id of a.track_ids) trackOf(c, id, { unlocked: true });
      if (a.clip_ids) for (const id of a.clip_ids) clipOf(c, id);
      const under = c.seq.clips.filter((x) => x.start < t && t < m.clipEnd(x) && (!a.track_ids || a.track_ids.includes(x.track)) && (!a.clip_ids || a.clip_ids.includes(x.id)) && !m.trackOf(c.seq, x.track)?.locked);
      if (!under.length) refuse(`No clip on an unlocked track crosses ${a.at} s (cuts go inside a clip, not on its edge).`);
      const r = !a.track_ids && !a.clip_ids ? plan(c, [{ op: 'split', at: a.at }], { label: 'Add Edit' }).results[0]
        : run(c, C().split(c.seq.id, t, a.clip_ids ? { clipIds: a.clip_ids } : { trackIds: a.track_ids }));
      return { edit: { at: t }, newClips: r.ids };
    }, (a) => ['Cut at {at} s', { at: a.at }]);
  tool('delete_clips', 'edit', 'Delete clips',
    'Removes clips (with their linked and grouped clips unless linked is false). ripple closes the gaps they leave on their tracks and the sync-locked ones.',
    obj({ clip_ids: ids('The clips.'), ripple: bool('Close the gaps (default false).'), linked: bool('Linked clips too (default true).') }, ['clip_ids']),
    (c, a) => {
      const clips = a.clip_ids.map((id) => clipOf(c, id));
      for (const x of clips) for (const l of a.linked === false ? [] : M().linkedClips(c.seq, x)) trackOf(c, l.track, { unlocked: true });
      const at = Math.min(...clips.map((x) => x.start));
      const r = run(c, C().remove(c.seq.id, a.clip_ids, { ripple: !!a.ripple, linked: a.linked !== false }));
      return { edit: { at }, removed: r.ids };
    }, (a) => [a.ripple ? 'Ripple delete {n} clips' : 'Delete {n} clips', { n: a.clip_ids.length }]);
  tool('delete_range', 'edit', 'Delete a time range',
    'Removes from..to (s) on every unlocked track, or on track_ids. ripple (default true) pulls later material earlier (Premiere\'s Extract: "cut the first 3 seconds"); ripple false leaves a gap (Lift).',
    obj({ from: num('Start (s).', { minimum: 0 }), to: num('End (s).', { minimum: 0 }), ripple: bool('Close the gap (default true).'), track_ids: ids('Only these tracks.') }, ['from', 'to']),
    (c, a) => {
      const a0 = timeIn(c, a.from, 'from');
      const b0 = timeIn(c, a.to, 'to');
      if (b0 - a0 < c.f) refuse('"to" must be at least one frame after "from".');
      const ripple = a.ripple !== false;
      if (!a.track_ids) plan(c, [{ op: ripple ? 'cut' : 'lift', from: a.from, to: a.to }], { label: ripple ? 'Extract' : 'Lift' });
      else {
        for (const id of a.track_ids) trackOf(c, id, { unlocked: true });
        run(c, ripple ? C().extract(c.seq.id, a0, b0, a.track_ids) : C().lift(c.seq.id, a0, b0, a.track_ids));
      }
      return { edit: { at: a0 }, range: [sec(c, a0), sec(c, b0)] };
    }, (a) => [a.ripple === false ? 'Lift {from}–{to} s' : 'Delete {from}–{to} s', { from: a.from, to: a.to }]);
  tool('link_clips', 'edit', 'Link clips',
    'link joins clips so they move, trim and get deleted together; unlink parts them; group and ungroup do the same for a group (clips that move and delete together).',
    obj({ clip_ids: ids('The clips.'), action: str('link, unlink, group or ungroup.', { enum: ['link', 'unlink', 'group', 'ungroup'] }) }, ['clip_ids', 'action']),
    (c, a) => {
      const clips = a.clip_ids.map((id) => clipOf(c, id));
      if ((a.action === 'link' || a.action === 'group') && clips.length < 2) refuse(`To ${a.action}, give two clips or more.`);
      run(c, C()[a.action](c.seq.id, a.clip_ids));
      return { edit: { at: Math.min(...clips.map((x) => x.start)) }, clips: a.clip_ids };
    }, (a) => [{ link: 'Link {n} clips', unlink: 'Unlink {n} clips', group: 'Group {n} clips', ungroup: 'Ungroup {n} clips' }[a.action], { n: a.clip_ids.length }]);

  // clip settings
  tool('set_clip', 'edit', 'Change a clip',
    'Changes a clip\'s settings. Video clips: opacity (%), position ([x, y] px from the center), scale (% or [w %, h %]), rotation (deg), anchor, crop ([top, right, bottom, left] %), interpolation (sample or blend: Time Interpolation), color (a color matte\'s #rrggbb). Audio clips: volume (dB, 0 unchanged), pan (-100..100), fade_in, fade_out (s). Both: name, enabled, role (Essential Sound\'s audio type: dialogue, music, effects, ambience or null), label (a color label or null). The value is the clip\'s static value; set_keyframes animates it.',
    obj({
      clip_id: str('The clip.'), name: str('A name.', { maxLength: 200 }), enabled: bool('false hides and mutes it.'), role: { type: ['string', 'null'], enum: ['dialogue', 'music', 'effects', 'ambience'], description: 'What its sound is.' },
      label: { type: ['string', 'null'], enum: LABELS, description: `${LABELS.join(', ')} or null.` }, interpolation: str('sample or blend.', { enum: ['sample', 'blend'] }), color: str('A color matte\'s color like #2f6fdb.', { maxLength: 7 }),
      opacity: num('%', { minimum: 0, maximum: 100 }), position: pair('[x, y] px from the center.'), scale: { type: ['number', 'array'], items: { type: 'number' }, description: '% or [w %, h %].' },
      rotation: num('Degrees.'), anchor: pair('[x, y] px.'), crop: list({ type: 'number' }, '[top, right, bottom, left] %.', { minItems: 4, maxItems: 4 }),
      volume: num('dB.', { minimum: -60, maximum: 24 }), pan: num('-100 left to 100 right.', { minimum: -100, maximum: 100 }),
      fade_in: num('Fade-in (s).', { minimum: 0 }), fade_out: num('Fade-out (s).', { minimum: 0 }), linked: bool('Its linked clips too, where it applies (default true).'),
    }, ['clip_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      const patch = {};
      const props = {};
      for (const k of ['opacity', 'position', 'scale', 'rotation', 'anchor', 'crop']) if (a[k] !== undefined) { needKind(c, clip, 'video', k); props[k] = propValue(k, a[k]); }
      for (const k of ['volume', 'pan']) if (a[k] !== undefined) { needKind(c, clip, 'audio', k); props[k] = propValue(k, a[k]); }
      for (const [k, key] of [['fade_in', 'fadeIn'], ['fade_out', 'fadeOut']]) if (a[k] !== undefined) { needKind(c, clip, 'audio', k); patch[key] = ticks(c, a[k]); }
      for (const [k, v] of Object.entries(props)) if (clip.keyframes?.[k]?.length) refuse(`${k} of ${clip.id} has keyframes; change them with set_keyframes (or clear them there first).`);
      if (Object.keys(props).length) patch.props = props;
      for (const k of ['name', 'enabled', 'role', 'label']) if (a[k] !== undefined) patch[k] = a[k];
      if (a.interpolation !== undefined) { needKind(c, clip, 'video', 'interpolation'); patch.sampling = a.interpolation; }
      if (a.color !== undefined) {
        if (clip.source?.generator !== 'solid') refuse(`color is for color mattes; ${clip.id} is not one${clip.source?.generator === 'text' ? ' (set_text changes a title\'s color)' : ''}.`);
        if (!/^#[0-9a-f]{6}$/i.test(a.color)) refuse('color must look like #2f6fdb.');
      }
      if (!Object.keys(patch).length && a.color === undefined) refuse('Give at least one setting to change.');
      atomic(c, 'Clip Settings', () => {
        if (Object.keys(patch).length) run(c, C().setClip(c.seq.id, clip.id, patch, { linked: a.linked !== false }));
        if (a.color !== undefined) run(c, C().setGenerator(c.seq.id, clip.id, { color: a.color.toLowerCase() }));
      });
      return { edit: { at: clip.start }, clip: clip.id };
    }, (a) => ['Change {clip}', { clip: a.clip_id }]);
  tool('set_speed', 'edit', 'Change the speed',
    'Speed/Duration: a clip\'s constant speed in % (100 normal, 50 slow motion, 200 twice as fast), or the duration (s) that the same source should fill, and reverse. ripple (default true) moves later clips with the new length. Linked clips change too unless linked is false.',
    obj({ clip_id: str('The clip.'), speed: num('% (1 to 10000).', { minimum: 1, maximum: 10000 }), duration: num('Instead of speed: the new length (s).', { minimum: 0.01, maximum: 86400 }), reverse: bool('Play backwards.'), ripple: bool('Move later clips (default true).'), linked: bool('Linked clips too (default true).') }, ['clip_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      if (a.speed == null && a.reverse == null && a.duration == null) refuse('Give speed, duration or reverse.');
      if (a.speed != null && a.duration != null) refuse('Give speed or duration, not both.');
      if (clip.remap) refuse(`${clip.id} has Time Remapping; change it with set_time_remap, or turn it off there first.`);
      if (M().isStill(c.project, clip)) refuse(`${clip.id} is a still (a picture, text or a freeze frame) and has no speed; trim it to change its length.`);
      atomic(c, 'Speed/Duration', () => {
        if (a.speed != null) run(c, C().setClip(c.seq.id, clip.id, { speed: a.speed / 100, ripple: a.ripple !== false }, { linked: a.linked !== false }));
        if (a.duration != null) run(c, C().setClip(c.seq.id, clip.id, { duration: Math.max(c.f, Math.round(ticks(c, a.duration) / c.f) * c.f), ripple: a.ripple !== false }, { linked: a.linked !== false }));
        if (a.reverse != null) run(c, C().setClip(c.seq.id, clip.id, { reverse: a.reverse }, { linked: a.linked !== false }));
      });
      const now = c.seq.clips.find((x) => x.id === clip.id);
      return { edit: { at: clip.start }, start: sec(c, now.start), end: sec(c, M().clipEnd(now)), speed: r3(now.speed * 100) };
    }, (a) => (a.duration != null ? ['Duration of {clip}: {s} s', { clip: a.clip_id, s: a.duration }] : ['Speed of {clip}: {speed}%', { clip: a.clip_id, speed: a.speed ?? 100 }]));
  tool('set_time_remap', 'edit', 'Time remapping',
    'Time Remapping of a video clip: its speed changes along it, replacing any remapping it has. segments in order: {speed: % (1 to 10000), until: timeline time (s) where it ends, as the clip plays now; ramp: seconds of speed transition into the next speed segment}, {hold: seconds of a freeze frame} or {reverse: seconds it plays backward, then forward again for as long}. A hold or reverse goes between two speed segments; the last segment is a speed with no until. Each speed segment keeps its source frames, so the clip gets longer or shorter (up to the next clip). off: true goes back to one constant speed.',
    obj({
      clip_id: str('The video clip.'),
      segments: list(bare({ speed: num('%.', { minimum: 1, maximum: 10000 }), until: num('Timeline time (s) where this speed segment ends.', { minimum: 0 }), ramp: num('Seconds of transition into the next speed (0.04..60).', { minimum: 0, maximum: 60 }), hold: num('A freeze frame this long (s).', { minimum: 0.01, maximum: 3600 }), reverse: num('Backward this long (s), then forward again.', { minimum: 0.01, maximum: 3600 }) }), 'The segments.', { minItems: 1, maxItems: 32 }),
      off: bool('Turn Time Remapping off.'),
    }, ['clip_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      needKind(c, clip, 'video', 'Time Remapping');
      const R = need('remap');
      if (a.off) { run(c, C().setRemap(c.seq.id, clip.id, null)); return { edit: { at: clip.start } }; }
      if (!a.segments) refuse('Give segments, or off: true.');
      if (M().isStill(c.project, clip)) refuse(`${clip.id} is a still and has no source frames to remap.`);
      const frames = (s) => Math.max(c.f, Math.round(ticks(c, s) / c.f) * c.f);
      const moving = [];
      const inserts = [];
      a.segments.forEach((s, i) => {
        const kinds = ['speed', 'hold', 'reverse'].filter((k) => s[k] != null);
        if (kinds.length !== 1) refuse(`segments[${i}] needs exactly one of speed, hold or reverse.`);
        if (kinds[0] === 'speed') { moving.push({ ...s, i }); return; }
        if (s.until != null || s.ramp != null) refuse(`segments[${i}] (a ${kinds[0]}) takes no until or ramp.`);
        if (!moving.length || a.segments[i + 1]?.speed == null) refuse(`segments[${i}] (a ${kinds[0]}) goes between two speed segments.`);
        inserts.push({ key: moving.length - 1, kind: kinds[0], len: frames(s[kinds[0]]), i });
      });
      const end = M().clipEnd(clip);
      if (moving.at(-1).until != null) refuse('The last speed segment runs to the clip\'s end: leave out its "until".');
      if (moving.at(-1).ramp) refuse('The last speed segment has no next speed to ramp into.');
      // a remapped clip starts again from one speed: the speed it has at its first frame
      let r = M().remapOf(clip);
      if (clip.remap) { const v = R.speedAt(clip.remap, 0) || 1; r = R.constant(R.value(clip.remap, 0), Math.sign(v) * Math.min(R.MAX, Math.max(R.MIN, Math.abs(v))), M().clipDuration(clip)); }
      const cuts = moving.slice(0, -1).map((s) => {
        if (s.until == null) refuse(`segments[${s.i}] needs "until" (only the last speed goes to the clip's end).`);
        const t = Math.round((ticks(c, s.until) - clip.start) / c.f) * c.f;
        if (t <= 0 || clip.start + t >= end) refuse(`segments[${s.i}].until ${s.until} s is not inside the clip (${sec(c, clip.start)} to ${sec(c, end)} s).`);
        return t;
      });
      for (let i = 1; i < cuts.length; i++) if (cuts[i] <= cuts[i - 1]) refuse('The segments\' "until" times must grow.');
      for (const t of cuts) { const next = R.addKey(r, t); if (!next) refuse(`A segment cannot start at ${r3((clip.start + t) / c.T)} s.`); r = next; }
      const sign = Math.sign(r.speeds[0]) || 1;
      for (let i = moving.length - 1; i >= 0; i--) r = R.setSegmentSpeed(r, i, (sign * moving[i].speed) / 100, c.f);
      for (let j = 0; j < moving.length - 1; j++) {
        if (!moving[j].ramp) continue;
        if (inserts.some((x) => x.key === j)) refuse(`segments[${moving[j].i}] cannot ramp into a hold or a reverse.`);
        r = R.splitKey(r, j, 'right', frames(moving[j].ramp), c.f);
        if (!r.keys[j].ramp) refuse(`There is no room for the ramp of segments[${moving[j].i}].`);
      }
      for (const x of inserts.slice().sort((p, q) => q.key - p.key)) {
        if (x.kind === 'reverse') {
          const room = R.reverseRoom(r, x.key, c.f);
          if (x.len > room) refuse(`segments[${x.i}]: there is only ${r3(room / c.T)} s of source before that point to play backward.`);
        }
        const next = x.kind === 'hold' ? R.insertFreeze(r, x.key, x.len) : R.insertReverse(r, x.key, x.len);
        if (!next) refuse(`segments[${x.i}] cannot go there.`);
        r = next;
      }
      const res = run(c, C().setRemap(c.seq.id, clip.id, r));
      const now = c.seq.clips.find((x) => x.id === clip.id);
      const keys = now.remap?.keys || [];
      return {
        edit: { at: clip.start }, duration: sec(c, res.duration), stoppedBy: res.clamped || null,
        speeds: (now.remap?.speeds || []).map((v) => r3(v * 100)), keys: keys.map((k) => ({ at: sec(c, clip.start + k.t), ...(k.ramp ? { ramp: sec(c, k.ramp) } : {}) })),
      };
    }, (a) => ['Time Remapping of {clip}', { clip: a.clip_id }]);
  tool('set_keyframes', 'edit', 'Set keyframes',
    'Animates a property of a clip: the full list of keyframes (time on the timeline in s, inside the clip; value; ease linear, hold, easeIn, easeOut or easeInOut). An empty list removes the animation. property: a clip property (opacity, position, scale, rotation, anchor, crop, volume, pan), "effects.<effect id>.<parameter>" (video and audio effects), a mask\'s "masks.<mask id>.<path|feather|opacity|expansion>" (an effect\'s mask: "effects.<effect id>.masks.<mask id>.<field>"; a path value is {shape: ellipse|rectangle, x, y, width, height} in fractions 0..1, like add_mask) or a layer\'s "layers.<layer id>.<field>" (titles: opacity, position, reveal, size; graphics: number, [x, y], color fields).',
    obj({ clip_id: str('The clip.'), property: str('The property path.', { maxLength: 80 }), keyframes: list(bare({ time: num('Timeline time (s).', { minimum: 0 }), value: { type: ['number', 'array', 'string', 'boolean', 'object'], description: 'The value.' }, ease: str('linear (default), hold, easeIn, easeOut, easeInOut.', { enum: ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut'] }) }, ['time', 'value']), 'The keyframes.', { maxItems: 200 }) }, ['clip_id', 'property', 'keyframes']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      const kind = kindOf(c, clip);
      if (!M().validPropPath(clip, kind, a.property) || a.property === 'duck') refuse(`${clip.id} has no property "${a.property}". It has ${(kind === 'audio' ? M().AUDIO_PROPS : M().VIDEO_PROPS).join(', ')} and effects.<id>.<parameter> of its effects (${clip.effects.map((e) => e.id).join(', ') || 'none'}).`);
      const parts = a.property.split('.');
      const masks = need('masks');
      const maskPath = masks.parsePath(a.property);
      const value = (v, i) => {
        const at = `keyframes[${i}].value`;
        if (parts.length === 1) return propValue(parts[0], v);
        if (maskPath) {
          const holder = maskPath.effectId ? clip.effects.find((e) => e.id === maskPath.effectId) : clip;
          const mask = (holder?.masks || []).find((m) => m.id === maskPath.maskId);
          if (maskPath.field !== 'path') {
            const [lo, hi] = masks.RANGES[maskPath.field];
            if (typeof v !== 'number' || v < lo || v > hi) refuse(`${at} must be a number from ${lo} to ${hi}.`);
            return v;
          }
          const path = isObj(v) ? shapePath(v, at) : v;
          if (!masks.validPath(path)) refuse(`${at} must be {shape, x, y, width, height} or a mask path.`);
          if (path.length !== mask.path.length) refuse(`${at} has ${path.length / 6} points; mask ${mask.id} has ${mask.path.length / 6} (an ellipse and a rectangle have 4).`);
          return path;
        }
        if (parts[0] === 'layers' && clip.source?.generator === 'graphic') return lib.graphicKey(clip, parts[1], parts[2], v, at);
        if (parts[0] === 'layers') {
          const rule = LAYER_KEYS[parts[2]];
          if (!rule) refuse(`A title layer animates ${Object.keys(LAYER_KEYS).join(', ')}; not ${parts[2]}.`);
          return rule(v, at);
        }
        if (parts[0] === 'effects' && parts.length === 3) {
          const e = clip.effects.find((x) => x.id === parts[1]);
          const def = effectDef(c, e.type);
          const p = def.params.find((x) => x.id === parts[2]);
          if (p && p.keyframable === false) refuse(`${p.id} of ${def.type} cannot be animated.`);
          return paramValue(def, parts[2], v, `keyframes[${i}].value`);
        }
        return v;
      };
      const end = M().clipEnd(clip);
      const list2 = a.keyframes.map((k, i) => {
        const t = ticks(c, k.time);
        if (t < clip.start - c.f / 2 || t > end + c.f / 2) refuse(`keyframes[${i}].time ${k.time} s is outside the clip (${sec(c, clip.start)} to ${sec(c, end)} s).`);
        return { t: Math.max(0, t - clip.start), v: value(k.value, i), ease: k.ease || 'linear' };
      });
      run(c, C().setKeyframes(c.seq.id, clip.id, a.property, list2.length ? list2 : null));
      return { edit: { at: list2.length ? clip.start + list2[0].t : clip.start }, keyframes: list2.length };
    }, (a) => ['Keyframes of {prop} on {clip}', { prop: a.property, clip: a.clip_id }]);

  // effects and color
  tool('add_effect', 'edit', 'Add an effect',
    'Adds a video or audio effect (list_effects) to a clip, with parameters that differ from the defaults. The effect\'s kind must match the clip\'s track. Returns the effect id.',
    obj({ clip_id: str('The clip.'), type: str('The effect type.', { maxLength: 60 }), params: { type: 'object', description: 'Parameter values by id.' }, index: int('Its place in the clip\'s effect list (default last).', { minimum: 0, maximum: 50 }) }, ['clip_id', 'type']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      const def = effectDef(c, a.type);
      needKind(c, clip, def.kind, `${def.type} (a ${def.kind} effect)`);
      const params = {};
      for (const [k, v] of Object.entries(a.params || {})) params[k] = paramValue(def, k, v, `params.${k}`, c.project.luts);
      const r = run(c, C().addEffect(c.seq.id, clip.id, def.type, a.index ?? null, params));
      return { edit: { at: clip.start }, effect: r.id };
    }, (a) => ['Add {type} to {clip}', { type: a.type, clip: a.clip_id }]);
  tool('set_effect', 'edit', 'Change an effect', 'Turns an effect on or off, changes its parameters (null puts one back to its default) and moves it in the clip\'s effect order (index 0 is applied first).',
    obj({ clip_id: str('The clip.'), effect_id: str('The effect (e<n>, from get_clip).'), on: bool('On or off.'), params: { type: 'object', description: 'Parameter values by id.' }, index: int('Its new place in the effect list.', { minimum: 0, maximum: 50 }) }, ['clip_id', 'effect_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      const e = clip.effects.find((x) => x.id === a.effect_id);
      if (!e) refuse(`${clip.id} has no effect ${a.effect_id}; its effects: ${clip.effects.map((x) => `${x.id} ${x.type}`).join(', ') || 'none'}.`);
      const def = effectDef(c, e.type);
      const params = {};
      for (const [k, v] of Object.entries(a.params || {})) {
        if (v !== null && clip.keyframes?.[`effects.${e.id}.${k}`]?.length) refuse(`${k} has keyframes; change it with set_keyframes.`);
        if (v === null && !def.params.some((x) => x.id === k)) paramValue(def, k, v);
        params[k] = v === null ? null : paramValue(def, k, v, `params.${k}`, c.project.luts);
      }
      if (a.on === undefined && !Object.keys(params).length && a.index == null) refuse('Give on, params or index.');
      if (a.index != null && a.index >= clip.effects.length) refuse(`index must be below ${clip.effects.length} (the clip has ${clip.effects.length} effects).`);
      atomic(c, 'Effect Settings', () => {
        if (a.on !== undefined || Object.keys(params).length) run(c, C().setEffect(c.seq.id, clip.id, e.id, { ...(a.on !== undefined ? { on: a.on } : {}), params }));
        if (a.index != null) run(c, C().moveEffect(c.seq.id, clip.id, e.id, a.index));
      });
      return { edit: { at: clip.start }, effect: e.id };
    }, (a) => ['Change {effect} on {clip}', { effect: a.effect_id, clip: a.clip_id }]);
  tool('remove_effect', 'edit', 'Remove an effect', 'Removes an effect from a clip, with its keyframes and masks.',
    obj({ clip_id: str('The clip.'), effect_id: str('The effect.') }, ['clip_id', 'effect_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      if (!clip.effects.some((x) => x.id === a.effect_id)) refuse(`${clip.id} has no effect ${a.effect_id}.`);
      run(c, C().removeEffect(c.seq.id, clip.id, a.effect_id));
      return { edit: { at: clip.start } };
    }, (a) => ['Remove {effect} from {clip}', { effect: a.effect_id, clip: a.clip_id }]);
  const COLOR_KEYS = ['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'vibrance'];
  const CURVES = { master: 'curveMaster', red: 'curveRed', green: 'curveGreen', blue: 'curveBlue' };
  const HSL = {
    hue: 'hslHue', hue_range: 'hslHueRange', hue_soft: 'hslHueSoft', sat_low: 'hslSatLow', sat_high: 'hslSatHigh', sat_soft: 'hslSatSoft',
    lum_low: 'hslLumLow', lum_high: 'hslLumHigh', lum_soft: 'hslLumSoft', show_mask: 'hslMask',
    temperature: 'hslTemperature', tint: 'hslTint', contrast: 'hslContrast', saturation: 'hslSaturation', hue_shift: 'hslHueShift',
  };
  const curve = (d) => list({ type: 'number' }, d, { minItems: 4, maxItems: 32 });
  tool('set_color', 'edit', 'Lumetri color',
    'Lumetri Color of a video clip, every section (its Lumetri Color, added when it has none). Basic: temperature, tint, contrast, highlights, shadows, whites, blacks, vibrance (-100..100), exposure (-4..4 stops), saturation (0..200 %). Creative: lut (a LUT id from get_project, or "" for none), lut_intensity (%). curves: master, red, green, blue as flat [x0, y0, x1, y1, ...] lists 0..1 ([0, 0, 1, 1] is unchanged). hsl (HSL Secondary): the range (hue 0..360, hue_range and hue_soft in degrees; sat_low, sat_high, sat_soft, lum_low, lum_high, lum_soft %), its correction (temperature, tint, contrast, saturation %, hue_shift -180..180) and show_mask.',
    obj({
      clip_id: str('The video clip.'),
      ...Object.fromEntries(COLOR_KEYS.map((k) => [k, num(k === 'exposure' ? 'Stops, -4..4.' : k === 'saturation' ? '%, 0..200.' : '-100..100.')])),
      lut: str('A LUT id of the project, or "".', { maxLength: 80 }), lut_intensity: num('%, 0..100.', { minimum: 0, maximum: 100 }),
      curves: bare(Object.fromEntries(Object.keys(CURVES).map((k) => [k, curve(`The ${k} curve.`)]))),
      hsl: bare(Object.fromEntries(Object.keys(HSL).map((k) => [k, k === 'show_mask' ? bool('Show the range as a mask.') : num(k)]))),
    }, ['clip_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      needKind(c, clip, 'video', 'Lumetri Color');
      const def = effectDef(c, 'color.basic');
      const params = {};
      const put = (key, v, at) => { params[key] = paramValue(def, key, v, at, c.project.luts); };
      for (const k of COLOR_KEYS) if (a[k] !== undefined) put(k, a[k], k);
      if (a.lut !== undefined) put('lut', a.lut, 'lut');
      if (a.lut_intensity !== undefined) put('lutIntensity', a.lut_intensity, 'lut_intensity');
      for (const [k, key] of Object.entries(CURVES)) if (a.curves?.[k] !== undefined) put(key, a.curves[k], `curves.${k}`);
      for (const [k, key] of Object.entries(HSL)) if (a.hsl?.[k] !== undefined) put(key, a.hsl[k], `hsl.${k}`);
      if (!Object.keys(params).length) refuse(`Give at least one of ${[...COLOR_KEYS, 'lut', 'lut_intensity', 'curves', 'hsl'].join(', ')}.`);
      const e = clip.effects.find((x) => x.type === 'color.basic');
      for (const k of Object.keys(params)) if (e && clip.keyframes?.[`effects.${e.id}.${k}`]?.length) refuse(`${k} has keyframes; change it with set_keyframes on effects.${e.id}.${k}.`);
      const id = e ? (run(c, C().setEffect(c.seq.id, clip.id, e.id, { params })), e.id) : run(c, C().addEffect(c.seq.id, clip.id, 'color.basic', null, params)).id;
      return { edit: { at: clip.start }, effect: id, changed: Object.keys(params) };
    }, (a) => ['Color of {clip}', { clip: a.clip_id }]);

  // transitions
  tool('add_transition', 'edit', 'Add a transition',
    'Puts a transition on an edit point of a track (where two clips meet, or a clip\'s start or end). type from list_effects (default: a cross dissolve, or a crossfade on audio); duration (s) defaults to the project\'s; align center, start or end.',
    obj({ track: str('The track.'), at: num('The edit point (s).', { minimum: 0 }), type: str('The transition type.', { maxLength: 60 }), duration: num('Seconds.', { minimum: 0.01, maximum: 60 }), align: str('center (default), start or end.', { enum: ['center', 'start', 'end'] }), params: { type: 'object', description: 'Its parameters.' } }, ['track', 'at']),
    (c, a) => {
      const t = trackOf(c, a.track, { unlocked: true });
      const E = c.services?.effects || need('effects');
      const type = a.type || E.defaultTransition(t.kind);
      const def = E.transitions().find((x) => x.type === type);
      if (!def) refuse(`There is no transition "${type}". list_effects lists them.`);
      if ((def.kind || 'video') !== t.kind) refuse(`${type} is a ${def.kind || 'video'} transition and ${t.id} a ${t.kind} track.`);
      const at = ticks(c, a.at);
      const edge = c.seq.clips.filter((x) => x.track === t.id).flatMap((x) => [x.start, M().clipEnd(x)]).reduce((best, e) => (Math.abs(e - at) < Math.abs(best - at) ? e : best), Infinity);
      if (!(Math.abs(edge - at) <= c.f)) refuse(`There is no clip edge on ${t.id} at ${a.at} s${Number.isFinite(edge) ? `; the nearest is at ${sec(c, edge)} s` : ''}.`);
      const params = {};
      for (const [k, v] of Object.entries(a.params || {})) params[k] = paramValue({ ...def, type }, k, v, `params.${k}`);
      const r = run(c, C().addTransition(c.seq.id, { track: t.id, at: edge, type, duration: a.duration != null ? ticks(c, a.duration) : undefined, align: a.align || 'center', params }));
      return { edit: { at: edge }, transition: r.id };
    }, (a) => ['Add a transition on {track} at {at} s', { track: a.track, at: a.at }]);
  tool('remove_transition', 'edit', 'Remove a transition', 'Removes a transition (ids from get_sequence).',
    obj({ transition_id: str('The transition.') }, ['transition_id']),
    (c, a) => {
      const t = c.seq.transitions.find((x) => x.id === a.transition_id);
      if (!t) refuse(`There is no transition ${a.transition_id}.`);
      trackOf(c, t.track, { unlocked: true });
      run(c, C().removeTransition(c.seq.id, t.id));
      return { edit: { at: t.at } };
    }, (a) => ['Remove transition {id}', { id: a.transition_id }]);

  // text and titles
  const COLOR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
  const TEXT_STYLE = {
    size: int('Font size in px of a 1080-line picture.', { minimum: 8, maximum: 600 }), color: str('Text color like #ffffff.', { maxLength: 9 }), font: str('Font family.', { maxLength: 100 }),
    weight: int('100 to 900 (700 bold).', { minimum: 100, maximum: 900 }), italic: bool('Italic.'), align: str('left, center or right.', { enum: ['left', 'center', 'right'] }),
    tracking: num('Letter spacing (px).', { minimum: -200, maximum: 1000 }), leading: num('Line height, times the size.', { minimum: 0.5, maximum: 5 }),
    position: pair('[x, y] px from the center (y > 0 is lower).'), box: { type: ['string', 'null'], description: 'A background box color like #00000099, or null for none.' },
    stroke: { type: ['object', 'null'], properties: { color: str('#rrggbb.', { maxLength: 9 }), width: num('px.', { minimum: 0, maximum: 100 }) }, additionalProperties: false, description: 'An outline {color, width}, or null.' },
    shadow: { type: ['object', 'null'], properties: { color: str('#rrggbbaa.', { maxLength: 9 }), blur: num('px.', { minimum: 0, maximum: 200 }), x: num('px.', { minimum: -500, maximum: 500 }), y: num('px.', { minimum: -500, maximum: 500 }) }, additionalProperties: false, description: 'A drop shadow {color, blur, x, y}, or null.' },
  };
  function layerPatch(a) {
    const p = {};
    const color = (v, at) => (COLOR_RE.test(v || '') ? v : refuse(`${at} must look like #ffffff.`));
    if (a.text !== undefined) p.text = a.text;
    if (a.color !== undefined) p.fill = color(a.color, 'color');
    for (const k of ['size', 'font', 'weight', 'italic', 'align', 'tracking', 'leading']) if (a[k] !== undefined) p[k] = a[k];
    if (a.position !== undefined) p.position = propValue('position', a.position);
    if (a.box !== undefined) p.box = a.box === null ? null : { color: color(a.box, 'box'), padding: 16, radius: 6 };
    if (a.stroke !== undefined) p.stroke = a.stroke === null ? null : { color: color(a.stroke.color, 'stroke.color'), width: a.stroke.width ?? 4 };
    if (a.shadow !== undefined) p.shadow = a.shadow === null ? null : { color: color(a.shadow.color ?? '#000000aa', 'shadow.color'), blur: a.shadow.blur ?? 8, x: a.shadow.x ?? 0, y: a.shadow.y ?? 4 };
    return p;
  }
  tool('add_text', 'edit', 'Add a title',
    'Adds a text clip (a title) at a time for duration seconds (default the project\'s still length), on track or else on the lowest free video track above the clips there (a new track when none is free).',
    obj({ text: str('The text; \\n breaks lines.', { maxLength: 2000 }), at: num('Start (s).', { minimum: 0 }), duration: num('Seconds.', { minimum: 0.04, maximum: 3600 }), track: str('A video track.'), ...TEXT_STYLE }, ['text', 'at']),
    (c, a) => {
      if (!a.text.trim()) refuse('The text is empty.');
      const at = TM().snap(timeIn(c, a.at, 'at'), c.seq.fps);
      const d = Math.max(c.f, a.duration != null ? Math.round(ticks(c, a.duration) / c.f) * c.f : c.project.settings.stillDuration);
      const vids = c.seq.tracks.filter((t) => t.kind === 'video');
      let track = a.track ? trackOf(c, a.track, { kind: 'video', unlocked: true }).id : null;
      const id = atomic(c, 'Add Text', () => {
        if (!track) {
          const busy = (tid) => c.seq.clips.some((x) => x.track === tid && x.start < at + d && M().clipEnd(x) > at);
          let top = -1;
          vids.forEach((t, i) => { if (busy(t.id)) top = i; });
          track = vids.slice(top + 1).find((t) => !t.locked)?.id || run(c, C().addTrack(c.seq.id, 'video')).id;
        }
        return run(c, C().addGenerated(c.seq.id, { track, at, duration: d, name: a.text.split('\n')[0].slice(0, 60), source: { generator: 'text', layers: [{ ...layerPatch(a), text: a.text }] } })).id;
      });
      return { edit: { at }, clip: id, track };
    }, (a) => ['Add the title "{text}"', { text: String(a.text).slice(0, 40) }]);
  tool('set_text', 'edit', 'Change a title',
    'Changes a text clip: the text and look of its first layer (or layer_id); add_layer: true adds a new layer with these settings instead; remove_layer removes one. animation puts a motion preset on the layer as keyframes: fade, rise or typewriter, in (at the start, default) or out (at the end).',
    obj({ clip_id: str('The text clip.'), layer_id: str('A text layer (l<n>).'), text: str('New text.', { maxLength: 2000 }), ...TEXT_STYLE, add_layer: bool('Add a layer.'), remove_layer: bool('Remove layer_id.'), animation: str('fade, rise or typewriter.', { enum: ['fade', 'rise', 'typewriter'] }), animation_at: str('in (default) or out.', { enum: ['in', 'out'] }) }, ['clip_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      if (clip.source?.generator !== 'text') refuse(`${clip.id} is not a text clip.`);
      const patch = layerPatch(a);
      if (a.remove_layer) {
        if (!a.layer_id || Object.keys(patch).length || a.add_layer || a.animation) refuse('remove_layer takes layer_id and nothing else.');
        if (!clip.source.layers.some((l) => l.id === a.layer_id)) refuse(`${clip.id} has no text layer ${a.layer_id}.`);
        if (clip.source.layers.length === 1) refuse('A title keeps one layer at least; delete_clips removes the title.');
        run(c, C().removeLayer(c.seq.id, clip.id, a.layer_id));
        return { edit: { at: clip.start }, clip: clip.id };
      }
      if (a.add_layer && a.layer_id) refuse('add_layer makes a new layer: leave out layer_id.');
      if (a.add_layer && !String(patch.text || '').trim()) refuse('A new layer needs text.');
      const layer = a.add_layer ? null : a.layer_id ? clip.source.layers.find((l) => l.id === a.layer_id) : clip.source.layers[0];
      if (!a.add_layer && !layer) refuse(`${clip.id} has no text layer ${a.layer_id}.`);
      if (!Object.keys(patch).length && !a.animation) refuse('Give something to change.');
      const id = atomic(c, 'Edit Text', () => {
        const lid = a.add_layer ? run(c, C().addLayer(c.seq.id, clip.id, patch)).id : layer.id;
        if (!a.add_layer && Object.keys(patch).length) run(c, C().setLayer(c.seq.id, clip.id, lid, patch));
        if (a.animation) {
          const now = c.seq.clips.find((x) => x.id === clip.id);
          const keys = need('textrender').animations.apply(now, lid, a.animation, { out: a.animation_at === 'out', frame: c.f });
          for (const [prop, list2] of Object.entries(keys)) run(c, C().setKeyframes(c.seq.id, clip.id, prop, list2));
        }
        return lid;
      });
      return { edit: { at: clip.start }, clip: clip.id, layer: id };
    }, (a) => ['Change the title {clip}', { clip: a.clip_id }]);

  // captions
  const ITEM = bare({ start: num('Start (s).', { minimum: 0 }), end: num('End (s).', { minimum: 0 }), text: str('The caption text.', { maxLength: 500 }) }, ['start', 'end', 'text']);
  function captionItems(c, items) {
    return items.map((it, i) => {
      const a0 = timeIn(c, it.start, `items[${i}].start`);
      const b0 = timeIn(c, it.end, `items[${i}].end`, { pastEnd: !c.duration });
      if (b0 - a0 < c.f) refuse(`items[${i}] must end at least one frame after it starts.`);
      if (!it.text.trim()) refuse(`items[${i}] has no text.`);
      return { start: a0, end: b0, text: it.text };
    });
  }
  function captionTrack(c, id) {
    const t = (c.seq.captions || []).find((x) => x.id === id);
    if (!t) refuse(`There is no caption track ${id}. get_sequence lists them (captionTracks).`);
    return t;
  }
  tool('add_captions', 'edit', 'Add captions',
    'Adds caption items to a caption track (track_id), or makes a new caption track (name, lang) with them. Captions are subtitles shown over the picture, not title clips.',
    obj({ track_id: str('An existing caption track.'), name: str('A new track\'s name.', { maxLength: 100 }), lang: str('A new track\'s language code (ko, en...).', { maxLength: 10 }), items: list(ITEM, 'The captions.', { minItems: 1, maxItems: MAX_ITEMS }) }, ['items']),
    (c, a) => {
      const items = captionItems(c, a.items);
      let id = a.track_id;
      if (id) {
        const t = captionTrack(c, id);
        atomic(c, 'Add Caption', () => { for (const it of items) run(c, C().addCaption(c.seq.id, t.id, it)); });
      } else id = run(c, C().addCaptionTrack(c.seq.id, { name: a.name || 'Captions', lang: a.lang || 'ko', items })).id;
      return { edit: { at: Math.min(...items.map((x) => x.start)) }, track: id, added: items.length };
    }, (a) => ['Add {n} captions', { n: a.items.length }]);
  tool('set_caption', 'edit', 'Change a caption', 'Changes one caption\'s text or times.',
    obj({ track_id: str('The caption track.'), caption_id: str('The caption (from get_captions).'), text: str('New text.', { maxLength: 500 }), start: num('New start (s).', { minimum: 0 }), end: num('New end (s).', { minimum: 0 }) }, ['track_id', 'caption_id']),
    (c, a) => {
      const t = captionTrack(c, a.track_id);
      const it = t.items.find((x) => x.id === a.caption_id);
      if (!it) refuse(`Caption track ${t.id} has no caption ${a.caption_id}.`);
      const patch = {};
      if (a.text !== undefined) { if (!a.text.trim()) refuse('The text is empty; remove_captions removes a caption.'); patch.text = a.text; }
      if (a.start !== undefined) patch.start = timeIn(c, a.start, 'start');
      if (a.end !== undefined) patch.end = timeIn(c, a.end, 'end');
      if (!Object.keys(patch).length) refuse('Give text, start or end.');
      if ((patch.end ?? it.end) - (patch.start ?? it.start) < c.f) refuse('The caption must end at least one frame after it starts.');
      run(c, C().setCaption(c.seq.id, t.id, it.id, patch));
      return { edit: { at: patch.start ?? it.start } };
    }, (a) => ['Change caption {id}', { id: a.caption_id }]);
  tool('remove_captions', 'edit', 'Remove captions', 'Removes captions by id, or the whole caption track (whole_track: true).',
    obj({ track_id: str('The caption track.'), caption_ids: ids('The captions.'), whole_track: bool('Remove the track and all its captions.') }, ['track_id']),
    (c, a) => {
      const t = captionTrack(c, a.track_id);
      if (a.whole_track) { run(c, C().removeCaptionTrack(c.seq.id, t.id)); return { edit: { at: 0 }, removedTrack: t.id }; }
      if (!a.caption_ids) refuse('Give caption_ids, or whole_track: true.');
      const items = a.caption_ids.map((id) => t.items.find((x) => x.id === id) || refuse(`Caption track ${t.id} has no caption ${id}.`));
      atomic(c, 'Remove Caption', () => { for (const it of items) run(c, C().removeCaption(c.seq.id, t.id, it.id)); });
      return { edit: { at: Math.min(...items.map((x) => x.start)) }, removed: items.length };
    }, (a) => [a.whole_track ? 'Remove caption track {id}' : 'Remove {n} captions', { id: a.track_id, n: a.caption_ids?.length || 0 }]);

  // markers
  tool('add_marker', 'edit', 'Add a marker',
    'Adds a sequence marker at a time, or a clip marker (clip_id). kind comment (default), chapter (YouTube chapters) or beat; color one of green, red, purple, orange, yellow, white, blue, cyan.',
    obj({ at: num('Time (s).', { minimum: 0 }), name: str('Its name.', { maxLength: 200 }), kind: str('comment, chapter or beat.', { enum: ['comment', 'chapter', 'beat'] }), color: str('Its color.', { enum: MARKER_COLORS }), note: str('A note.', { maxLength: 2000 }), duration: num('A range marker\'s length (s).', { minimum: 0 }), clip_id: str('Put it on this clip.') }, ['at']),
    (c, a) => {
      const t = timeIn(c, a.at, 'at');
      const clip = a.clip_id ? clipOf(c, a.clip_id, { unlocked: false }) : null;
      if (clip && (t < clip.start || t > M().clipEnd(clip))) refuse(`${a.at} s is outside ${clip.id} (${sec(c, clip.start)} to ${sec(c, M().clipEnd(clip))} s).`);
      const kind = a.kind || 'comment';
      const marker = { t, name: a.name || '', kind, color: a.color || (kind === 'chapter' ? 'blue' : 'green'), ...(a.note ? { note: a.note } : {}), ...(a.duration ? { duration: ticks(c, a.duration) } : {}) };
      const r = run(c, C().addMarker(c.seq.id, marker, clip ? { clipId: clip.id } : {}));
      return { edit: { at: t }, marker: r.id };
    }, (a) => ['Add a marker at {at} s', { at: a.at }]);
  const markerOf = (c, id) => c.seq.markers.find((m) => m.id === id) || c.seq.clips.flatMap((x) => x.markers || []).find((m) => m.id === id) || refuse(`There is no marker ${id}. get_markers lists them.`);
  tool('set_marker', 'edit', 'Change a marker', 'Changes a marker\'s time, name, kind, color or note.',
    obj({ marker_id: str('The marker.'), at: num('New time (s).', { minimum: 0 }), name: str('Name.', { maxLength: 200 }), kind: str('comment, chapter or beat.', { enum: ['comment', 'chapter', 'beat'] }), color: str('Color.', { enum: MARKER_COLORS }), note: str('Note.', { maxLength: 2000 }) }, ['marker_id']),
    (c, a) => {
      const mk = markerOf(c, a.marker_id);
      const patch = {};
      if (a.at !== undefined) patch.t = timeIn(c, a.at, 'at');
      for (const k of ['name', 'kind', 'color', 'note']) if (a[k] !== undefined) patch[k] = a[k];
      if (!Object.keys(patch).length) refuse('Give something to change.');
      run(c, C().setMarker(c.seq.id, mk.id, patch));
      return { edit: { at: patch.t ?? mk.t } };
    }, (a) => ['Change marker {id}', { id: a.marker_id }]);
  tool('remove_markers', 'edit', 'Remove markers', 'Removes markers by id, or every sequence marker of a kind (comment, chapter, beat or all).',
    obj({ marker_ids: ids('The markers.'), kind: str('comment, chapter, beat or all.', { enum: ['comment', 'chapter', 'beat', 'all'] }) }),
    (c, a) => {
      if ((a.marker_ids == null) === (a.kind == null)) refuse('Give marker_ids or kind (one of them).');
      if (a.kind) {
        if (!c.seq.markers.some((m) => a.kind === 'all' || m.kind === a.kind)) refuse(`There are no ${a.kind === 'all' ? '' : `${a.kind} `}sequence markers.`);
        plan(c, [{ op: 'removeMarkers', kind: a.kind }], { label: 'Remove Marker' });
        return { edit: { at: 0 } };
      }
      const list2 = a.marker_ids.map((id) => markerOf(c, id));
      atomic(c, 'Remove Marker', () => { for (const m of list2) run(c, C().removeMarker(c.seq.id, m.id)); });
      return { edit: { at: Math.min(...list2.map((m) => m.t)) }, removed: list2.length };
    }, (a) => ['Remove markers', {}]);

  // masks
  // An ellipse or a rectangle centered at x, y with width and height (fractions of the picture): a mask path of four
  // points (masks.js: x, y and the two handles of each).
  function shapePath(s, at = 'the shape') {
    if (!['ellipse', 'rectangle'].includes(s.shape)) refuse(`${at}.shape must be ellipse or rectangle.`);
    for (const k of ['x', 'y', 'width', 'height']) {
      const min = k === 'width' || k === 'height' ? 0.001 : 0;
      if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || s[k] < min || s[k] > 4)) refuse(`${at}.${k} must be a fraction of the picture.`);
    }
    const cx = s.x ?? 0.5;
    const cy = s.y ?? 0.5;
    const hw = (s.width ?? 0.5) / 2;
    const hh = (s.height ?? 0.5) / 2;
    const k = need('masks').KAPPA;
    return s.shape === 'ellipse'
      ? [cx, cy - hh, -k * hw, 0, k * hw, 0, cx + hw, cy, 0, -k * hh, 0, k * hh, cx, cy + hh, k * hw, 0, -k * hw, 0, cx - hw, cy, 0, k * hh, 0, -k * hh]
      : [cx - hw, cy - hh, 0, 0, 0, 0, cx + hw, cy - hh, 0, 0, 0, 0, cx + hw, cy + hh, 0, 0, 0, 0, cx - hw, cy + hh, 0, 0, 0, 0];
  }
  // What a title layer animates (textrender.resolveLayer, the motion presets).
  const LAYER_KEYS = {
    opacity: (v, at) => (typeof v === 'number' && v >= 0 && v <= 100 ? v : refuse(`${at} must be 0..100 (%).`)),
    reveal: (v, at) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : refuse(`${at} must be 0..1.`)),
    size: (v, at) => (typeof v === 'number' && v >= 8 && v <= 600 ? v : refuse(`${at} must be 8..600 (px).`)),
    position: (v) => propValue('position', v),
  };
  const MASK_FIELDS ={ feather: num('Pixels, 0..1000.', { minimum: 0, maximum: 1000 }), opacity: num('%.', { minimum: 0, maximum: 100 }), expansion: num('Pixels, -2000..2000.', { minimum: -2000, maximum: 2000 }), inverted: bool('Keep the outside instead.'), mode: str('add, subtract, intersect, difference or none.', { enum: ['add', 'subtract', 'intersect', 'difference', 'none'] }) };
  tool('add_mask', 'edit', 'Add a mask',
    'Adds a mask to a video clip\'s Opacity (the clip shows only inside it), or to one of its effects (effect_id: the effect applies only inside). shape ellipse or rectangle, centered at x, y with width and height, all fractions 0..1 of the clip\'s picture.',
    obj({ clip_id: str('The video clip.'), effect_id: str('Mask this effect instead of the clip.'), shape: str('ellipse or rectangle.', { enum: ['ellipse', 'rectangle'] }), x: num('Center, 0..1 from the left.', { minimum: 0, maximum: 1 }), y: num('Center, 0..1 from the top.', { minimum: 0, maximum: 1 }), width: num('0..1 of the picture width.', { minimum: 0.001, maximum: 4 }), height: num('0..1 of the picture height.', { minimum: 0.001, maximum: 4 }), ...MASK_FIELDS }, ['clip_id', 'shape']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      needKind(c, clip, 'video', 'A mask');
      if (a.effect_id != null && !clip.effects.some((e) => e.id === a.effect_id)) refuse(`${clip.id} has no effect ${a.effect_id}.`);
      const mask = { path: shapePath(a) };
      for (const f of Object.keys(MASK_FIELDS)) if (a[f] !== undefined) mask[f] = a[f];
      const r = run(c, C().addMask(c.seq.id, clip.id, mask, { effectId: a.effect_id ?? null }));
      return { edit: { at: clip.start }, mask: r.id };
    }, (a) => ['Add a mask to {clip}', { clip: a.clip_id }]);
  tool('set_mask', 'edit', 'Change a mask', 'Changes a mask\'s static feather, opacity, expansion, inverted or mode, or its shape (shape with x, y, width, height as in add_mask). set_keyframes animates masks.<mask id>.<path|feather|opacity|expansion>.',
    obj({ clip_id: str('The clip.'), mask_id: str('The mask (m<n>).'), effect_id: str('When the mask is an effect\'s.'), shape: str('ellipse or rectangle: a new path.', { enum: ['ellipse', 'rectangle'] }), x: num('Center, 0..1 from the left.', { minimum: 0, maximum: 1 }), y: num('Center, 0..1 from the top.', { minimum: 0, maximum: 1 }), width: num('0..1 of the picture width.', { minimum: 0.001, maximum: 4 }), height: num('0..1 of the picture height.', { minimum: 0.001, maximum: 4 }), ...MASK_FIELDS }, ['clip_id', 'mask_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      const patch = {};
      for (const f of Object.keys(MASK_FIELDS)) if (a[f] !== undefined) patch[f] = a[f];
      if (a.shape) patch.path = shapePath(a);
      else if (['x', 'y', 'width', 'height'].some((k) => a[k] !== undefined)) refuse('x, y, width and height go with shape.');
      const kf = Object.keys(clip.keyframes || {}).find((k) => k.startsWith(`${a.effect_id ? `effects.${a.effect_id}.` : ''}masks.${a.mask_id}.`) && Object.hasOwn(patch, k.split('.').pop()));
      if (kf) refuse(`${kf} has keyframes; change them with set_keyframes.`);
      if (!Object.keys(patch).length) refuse('Give something to change.');
      run(c, C().setMask(c.seq.id, clip.id, a.mask_id, patch, { effectId: a.effect_id ?? null }));
      return { edit: { at: clip.start } };
    }, (a) => ['Change mask {id}', { id: a.mask_id }]);
  tool('remove_mask', 'edit', 'Remove a mask', 'Removes a mask and its keyframes.',
    obj({ clip_id: str('The clip.'), mask_id: str('The mask.'), effect_id: str('When the mask is an effect\'s.') }, ['clip_id', 'mask_id']),
    (c, a) => {
      const clip = clipOf(c, a.clip_id);
      run(c, C().removeMask(c.seq.id, clip.id, a.mask_id, { effectId: a.effect_id ?? null }));
      return { edit: { at: clip.start } };
    }, (a) => ['Remove mask {id}', { id: a.mask_id }]);

  // nesting, tracks, the sequence, silence
  tool('nest_clips', 'edit', 'Nest clips',
    'Moves clips (with their linked and grouped clips) into a new sequence and puts one nest clip of it in their place, as Premiere\'s Clip > Nest. Returns the new sequence and the nest clips.',
    obj({ clip_ids: ids('The clips.'), name: str('The new sequence\'s name.', { maxLength: 200 }) }, ['clip_ids']),
    (c, a) => {
      const clips = a.clip_ids.map((id) => clipOf(c, id));
      const r = run(c, C().nest(c.seq.id, a.clip_ids, { name: a.name || 'Nested Sequence' }));
      return { edit: { at: Math.min(...clips.map((x) => x.start)) }, sequence: r.id, clips: r.ids };
    }, (a) => ['Nest {n} clips', { n: a.clip_ids.length }]);
  tool('set_track', 'edit', 'Change a track',
    'Changes a track: name; video tracks visible; audio tracks mute, solo, volume (dB, -60..24) and pan (-100..100); sync_lock. Locking and unlocking stay the user\'s.',
    obj({ track_id: str('The track.'), name: str('Name.', { maxLength: 100 }), visible: bool('Show the video track.'), mute: bool('Mute.'), solo: bool('Solo.'), volume: num('dB.', { minimum: -60, maximum: 24 }), pan: num('-100..100.', { minimum: -100, maximum: 100 }), sync_lock: bool('Sync lock.') }, ['track_id']),
    (c, a) => {
      const t = trackOf(c, a.track_id, { unlocked: true });
      const patch = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.sync_lock !== undefined) patch.syncLock = a.sync_lock;
      if (a.visible !== undefined) { if (t.kind !== 'video') refuse('visible is for video tracks; audio tracks have mute.'); patch.visible = a.visible; }
      for (const k of ['mute', 'solo', 'pan']) if (a[k] !== undefined) { if (t.kind !== 'audio') refuse(`${k} is for audio tracks.`); patch[k] = a[k]; }
      if (a.volume !== undefined) {
        if (t.kind !== 'audio') refuse('volume is for audio tracks.');
        patch.volume = a.volume;
      }
      if (!Object.keys(patch).length) refuse('Give something to change.');
      run(c, C().setTrack(c.seq.id, t.id, patch));
      return { edit: { at: c.app.t } };
    }, (a) => ['Change track {id}', { id: a.track_id }]);
  // frame rates as a model writes them -> [num, den] (time.FRAME_RATES)
  const FPS = { '23.976': [24000, 1001], 24: [24, 1], 25: [25, 1], '29.97': [30000, 1001], 30: [30, 1], 50: [50, 1], '59.94': [60000, 1001], 60: [60, 1] };
  tool('set_sequence', 'edit', 'Change the sequence',
    'Sequence Settings and the master track: name, frame size (width, height px, even), fps (23.976, 24, 25, 29.97, 30, 50, 59.94 or 60; every time moves to the new frames), background color, master_gain (dB on the whole mix, -60..24: the Audio Track Mixer\'s master). active: true brings it to the front in the timeline (not an undo step).',
    obj({ name: str('Name.', { maxLength: 200 }), width: int('px.', { minimum: 16, maximum: 8192 }), height: int('px.', { minimum: 16, maximum: 8192 }), fps: str('Frames a second.', { enum: Object.keys(FPS) }), master_gain: num('dB.', { minimum: -60, maximum: 24 }), background: str('Color like #000000.', { maxLength: 7 }), active: bool('Show it in the timeline.') }),
    (c, a) => {
      const patch = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.master_gain !== undefined) patch.masterGain = a.master_gain;
      for (const k of ['width', 'height']) if (a[k] !== undefined) { if (a[k] % 2) refuse(`${k} must be even.`); patch[k[0]] = a[k]; }
      if (a.fps !== undefined) patch.fps = FPS[a.fps];
      if (a.background !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(a.background)) refuse('background must look like #000000.'); patch.background = a.background; }
      if (!Object.keys(patch).length && !a.active) refuse('Give something to change.');
      if (Object.keys(patch).length) run(c, C().setSequence(c.seq.id, patch));
      if (a.active && c.app.sequenceId !== c.seq.id) c.app.setSequence(c.seq.id);
      return Object.keys(patch).length ? { edit: { at: c.app.t }, sequence: c.seq.id } : { sequence: c.seq.id, active: true };
    }, () => ['Change the sequence', {}]);
  tool('remove_silence', 'edit', 'Remove silence',
    'Measures the sound on this PC and ripple-deletes every stretch quieter than threshold (dB, default -40) that lasts longer than longer_than seconds, on the speech tracks (music, effects and ambience clips do not count).',
    obj({ longer_than: num('Seconds, 0.1..60.', { minimum: 0.1, maximum: 60 }), threshold: num('dB, -90..-5.', { minimum: -90, maximum: -5 }) }, ['longer_than']),
    async (c, a) => {
      if (!c.services?.silence) refuse('The sound cannot be measured here.');
      const r = await c.services.silence(c.seq, { threshold: a.threshold ?? -40, minLength: a.longer_than });
      if (!r?.ranges?.length) refuse(`There is no silence longer than ${a.longer_than} s quieter than ${a.threshold ?? -40} dB.`);
      const op = { op: 'removeSilence', longerThan: a.longer_than, ...(a.threshold != null ? { threshold: a.threshold } : {}) };
      plan(c, [op], { label: 'Remove Silence', silence: [r] });
      return { edit: { at: r.ranges[0][0] }, cuts: r.ranges.length, seconds: r3(r.ranges.reduce((n, [x, y]) => n + y - x, 0) / c.T) };
    }, (a) => ['Remove silences longer than {s} s', { s: a.longer_than }]);

  // the selection, the playhead, undo
  tool('select_clips', 'play', 'Select clips', 'Selects clips on the timeline (an empty list clears the selection); add keeps the selection there was.',
    obj({ clip_ids: list({ type: 'string' }, 'The clips.', { maxItems: MAX_ITEMS }), add: bool('Add to the selection.') }, ['clip_ids']),
    (c, a) => {
      for (const id of a.clip_ids) clipOf(c, id, { unlocked: false });
      if (c.app.sequenceId !== c.seq.id) c.app.setSequence?.(c.seq.id);
      c.app.select(a.clip_ids, { add: !!a.add });
      return { selection: [...c.app.selection] };
    }, (a) => ['Select {n} clips', { n: a.clip_ids.length }]);
  tool('seek', 'play', 'Move the playhead', 'Moves the playhead (and the picture in the program monitor) to a time.',
    obj({ time: num('Seconds.', { minimum: 0 }) }, ['time']),
    (c, a) => {
      const t = TM().snap(timeIn(c, a.time), c.seq.fps);
      if (c.app.sequenceId !== c.seq.id) c.app.setSequence?.(c.seq.id);
      if (c.services?.seek) c.services.seek(t); else c.app.setTime(t);
      return { playhead: sec(c, t), frame: frame(c, t) };
    }, (a) => ['Go to {t} s', { t: a.time }]);
  tool('play', 'play', 'Play', 'Starts playback in the program monitor from the playhead.', bare(),
    (c0) => { const c = context(c0); c.services?.play?.(); return { playing: true, from: sec(c, c.app.t) }; });
  tool('stop', 'play', 'Stop', 'Stops playback in the program monitor; the playhead stays where it is.', bare(), (c0) => { const c = context(c0); c.services?.stop?.(); return { playing: false, playhead: sec(c, c.app.t) }; });
  tool('undo', 'play', 'Undo', 'Undoes the last step of the editor\'s history (the user\'s steps before your turn stay).', bare(),
    (c) => {
      const h = c.app.history;
      if (!h.canUndo || (c.undoFloor != null && h.position <= c.undoFloor)) refuse('There is nothing of yours to undo.');
      const label = h.list().filter((x) => x.done).at(-1)?.label;
      h.undo();
      return { undone: label, edit: { at: c.app.t } };
    });
  tool('redo', 'play', 'Redo', 'Redoes the step of the editor history that was undone last.', bare(),
    (c) => {
      const h = c.app.history;
      if (!h.canRedo) refuse('There is nothing to redo.');
      h.redo();
      return { redone: h.list().filter((x) => x.done).at(-1)?.label, edit: { at: c.app.t } };
    });

  // export
  // A plain file name (no folders): what the ask-first writers (export, frame, captions) take.
  const plainName = (v, what = 'file_name') => {
    if (v == null) return null;
    if (/[\/:*?"<>|]/.test(v) || /^\.+$/.test(v.trim()) || !v.trim()) refuse(`${what} is a plain name, without folders or any of \ / : * ? " < > |.`);
    return v.trim();
  };
  tool('export_sequence', 'export', 'Export',
    `Exports the sequence to a new file in the project's folder with a preset (${PRESETS.join(', ')}) and optional overrides of the Export Settings: width, height (px, even), codec (h264 or hevc), bitrate (Mbps), bitrate_mode, key_seconds, audio_bitrate (128, 160 or 192 kbps), loudness (target LUFS, or null to leave it). The user is asked first and may say no; an existing file is never replaced. from/to export part of it; captions burn draws the shown caption track into the picture. It joins the export queue; wait: true waits until it is written, with progress (Stop cancels it).`,
    obj({
      preset: str('The preset.', { enum: PRESETS }), file_name: str('A file name without folders (the preset\'s extension is added).', { maxLength: 120 }),
      from: num('Start (s).', { minimum: 0 }), to: num('End (s).', { minimum: 0 }), captions: str('none (default) or burn.', { enum: ['none', 'burn'] }),
      width: int('px.', { minimum: 16, maximum: 8192 }), height: int('px.', { minimum: 16, maximum: 8192 }), codec: str('h264 or hevc.', { enum: ['h264', 'hevc'] }),
      bitrate: num('Video Mbps, 0.1..400.', { minimum: 0.1, maximum: 400 }), bitrate_mode: str('variable or constant.', { enum: ['variable', 'constant'] }),
      key_seconds: num('Seconds between key frames.', { minimum: 0.5, maximum: 10 }), audio_bitrate: int('kbps.', { enum: [128, 160, 192] }),
      loudness: { type: ['number', 'null'], minimum: -40, maximum: -5, description: 'Target LUFS, or null.' }, wait: bool('Wait for the file (default false).'),
    }, ['preset']),
    async (c, a) => {
      if (!c.duration) refuse('The sequence is empty.');
      const fileName = plainName(a.file_name);
      const range = a.from != null || a.to != null ? { in: timeIn(c, a.from ?? 0, 'from'), out: timeIn(c, a.to ?? c.duration / c.T, 'to') } : null;
      if (range && range.out - range.in < c.f) refuse('"to" must be after "from".');
      const P = need('presets');
      const audioOnly = P.get(a.preset).kind === 'audio';
      const o = {};
      for (const [k, key] of [['width', 'w'], ['height', 'h'], ['codec', 'codec'], ['bitrate_mode', 'mode'], ['key_seconds', 'keySeconds']]) {
        if (a[k] === undefined) continue;
        if (audioOnly) refuse(`${a.preset} has no picture: ${k} does not apply.`);
        o[key] = a[k];
      }
      if (a.bitrate !== undefined) { if (audioOnly) refuse(`${a.preset} has no picture: bitrate does not apply (audio_bitrate does).`); o.bitrate = Math.round(a.bitrate * 1e6); }
      if (a.audio_bitrate !== undefined) o.audioBitrate = a.audio_bitrate * 1000;
      if (a.loudness !== undefined) o.loudness = a.loudness;
      const settings = P.resolve(a.preset, c.seq, o);
      const bad = P.validate(settings);
      if (bad.length) refuse(bad.join(' '));
      if (!c.services?.exportAsk) refuse('Exporting is not available here.');
      const r = await c.services.exportAsk({ seq: c.seq, preset: a.preset, fileName, range, captions: a.captions === 'burn' ? 'burn' : null, settings });
      if (!r?.ok) refuse(r?.declined ? 'The user said no to this export. Nothing was written.' : `The export could not start: ${r?.error || 'unknown error'}`);
      const out = { queued: r.name, job: r.job ?? null, settings: { width: settings.width, height: settings.height, video: settings.video ? `${settings.video.family} ${r3(settings.video.bitrate / 1e6)} Mbps` : null, audio: `${settings.audio.bitrate / 1000} kbps`, loudness: settings.loudness } };
      if (!a.wait) return { ...out, note: 'The user agreed; the export runs in the export queue (export_queue shows it).' };
      const w = await c.services.exportWait(r.job, { signal: c.signal, progress: c.progress });
      if (!w?.ok) refuse(w?.cancelled ? `The export of ${r.name} was cancelled; its unfinished file is removed.` : `The export of ${r.name} failed: ${w?.error || 'unknown error'}`);
      return { ...out, done: true };
    }, (a) => ['Export with {preset}', { preset: a.preset }]);

  // The clips of the sequence whose JSON changed (or that are new) since `before` (snapshot()).
  const snapshot = (seq) => new Map((seq?.clips || []).map((x) => [x.id, JSON.stringify(x)]));
  const changedSince = (seq, before) => (seq?.clips || []).filter((x) => before.get(x.id) !== JSON.stringify(x)).map((x) => x.id);

  // One tool call. env: {app (Cut.state's shape), services, undoFloor}. -> {ok: true, value, image?, edit: {seqId, at,
  // clips} | null} | {ok: false, error}. Never throws.
  async function call(name, args, env) {
    const def = BY_NAME.get(name);
    if (!def) return { ok: false, error: `There is no tool ${name}.` };
    const a = args == null ? {} : args;
    const bad = isObj(a) ? check(def.input, a) : 'The arguments must be an object.';
    if (bad) return { ok: false, error: bad };
    let c;
    try {
      c = def.input.properties && own(def.input.properties, 'sequence_id') ? context(env, a) : { ...env };
    } catch (err) { return { ok: false, error: err.message }; }
    const seq = c.seq || env.app.sequence;
    const before = def.kind === 'edit' ? snapshot(seq) : null;
    try {
      const value = await def.run(c, a);
      let image = null;
      let edit = null;
      let out = value;
      if (isObj(value) && value.$image) { image = value.$image; out = { ...value }; delete out.$image; }
      if (isObj(value) && value.edit) {
        const named = value.edit.seqId ? env.app.project?.sequences.find((x) => x.id === value.edit.seqId) : null;
        const s = named || (seq && env.app.project?.sequences.includes(seq) ? seq : env.app.sequence);
        edit = { seqId: s?.id ?? null, at: Number.isFinite(value.edit.at) ? value.edit.at : null, clips: before && !named ? changedSince(s, before) : [] };
        out = { ...value };
        delete out.edit;
      }
      return { ok: true, value: out, image, edit };
    } catch (err) {
      if (err?.refusal) return { ok: false, error: err.message };
      return { ok: false, error: `The editor refused: ${err?.message || err}` };
    }
  }

  // The tools as MCP lists them.
  const definitions = () => TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input, annotations: { title: t.title, readOnlyHint: t.kind === 'read', destructiveHint: t.kind === 'edit', openWorldHint: false } }));
  // A step's line in the chat: [English text for tr(), params].
  function describe(name, args) {
    const def = BY_NAME.get(name);
    if (!def) return [name, {}];
    if (def.say && isObj(args)) { try { return def.say(args); } catch {} }
    return [def.title, {}];
  }

  // What the other tool files (control-project.js, control-auto.js, control-actions.js) build their tools with.
  const lib = {
    tool, refuse, Refusal, need, M, C, TM, r3, isObj, own, MAX_ITEMS, CLIP_ID, MARKER_COLORS,
    num, int, str, bool, list, pair, ids, obj, bare, SEQ,
    context, sec, frame, ticks, timeIn, clipOf, trackOf, kindOf, mediaOf, run, atomic, plan, effectDef, paramValue, propValue, needKind, clipSummary,
    snapshot, changedSince, plainName,
  };
  const api = { TOOLS, INSTRUCTIONS, PRESETS, check, call, definitions, describe, kindOf: (name) => BY_NAME.get(name)?.kind || null, names: () => TOOLS.map((t) => t.name), lib };
  // A tool file adds its tools: required here in Node, and in the page it loads after this file and calls extend.
  api.extend = (part) => { part(lib); };
  if (NODE) for (const name of ['control-project', 'control-auto', 'control-graphic', 'control-actions']) api.extend(require(`./${name}.js`));
  return api;
});
