// Nano Studio Cut's control API (docs/cut-ai-control.md) in plain Node, never the real Claude:
// - the tool list: names, descriptions written for a model, strict schemas (no unknown fields, required ones
//   declared), the MCP shape, the size of the list;
// - each editing tool on a real project: what it changes, one undo step each, the project still valid, undo exact;
//   the edit-command allowlist (ai.js) behind delete_range, razor, remove_markers and remove_silence;
// - refusals with a sentence the model can act on and the project unchanged: bad ids, times outside the sequence,
//   locked tracks, unknown effects and parameters, out-of-range values, a file path where a media id goes, unknown
//   or wrong arguments; a turn's undo cannot reach the steps before it;
// - no tool reaches the disk or the page's IPC (fs and child_process watched, ide.api a trap), and no tool takes a path;
// - history.squash: a turn's steps become one step named after the request, undone and redone whole;
// - main/cut/control.js over real HTTP: the token (none, wrong, a turn's after it ended, the external one only while
//   allowed and replaced by Disconnect), Origin and Host refused, GET, a large body, tools/list, a call answered by a
//   stand-in page, a page that goes away;
// - main/cut/agent.js with the scripted fake CLI (verify/fake-claude-cut.mjs): only Cut's tools allowed, no built-in
//   tools, the stream-json events in order, the MCP settings file gone and the token dead after the turn, Stop in the
//   middle, a usage limit (code quota), a missing CLI;
// - control.js as a page script next to an AMD `require`, in index.js order.
// Usage: node verify/cut-control-core.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import fsMod from 'fs';
import childMod from 'child_process';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const time = require('../renderer/features/cut/time.js');
const model = require('../renderer/features/cut/model.js');
const C = require('../renderer/features/cut/commands.js');
const effects = require('../renderer/features/cut/effects.js');
const state = require('../renderer/features/cut/state.js');
const K = require('../renderer/features/cut/control.js');
const { createControl } = require('../main/cut/control.js');
const { createAgent } = require('../main/cut/agent.js');
const claude = require('../main/ai/claude.js');

// --table prints docs/cut-ai-control.md's tool tables from the tools themselves.
if (process.argv.includes('--table')) {
  const heads = { read: 'Reading', edit: 'Editing', play: 'Selection, playhead, undo', export: 'Export' };
  for (const kind of Object.keys(heads)) {
    console.log(`### ${heads[kind]}\n\n| Tool | Arguments (required in bold) | What it does |\n| --- | --- | --- |`);
    for (const t of K.TOOLS.filter((x) => x.kind === kind)) {
      const req = new Set(t.input.required || []);
      console.log(`| \`${t.name}\` | ${Object.keys(t.input.properties).map((a) => (req.has(a) ? `**${a}**` : a)).join(', ') || '(none)'} | ${t.description.replace(/\|/g, '\\|')} |`);
    }
    console.log('');
  }
  process.exit(0);
}

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }
const T = time.TICKS;
const F = time.frameTicks([30, 1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A project: a 10 s video with sound (m1), a picture (m2), V1/A1 clips of m1 at 0-10 s, a picture on V2 at 2-4 s,
// a locked track A2 with a clip, a text clip on V3; the app around it as the page has it.
function fresh() {
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
  const h = C.createHistory(JSON.parse(h0.serialize()), { limit: Infinity });
  const app = state.createApp();
  app.setHistory(h);
  const seq = () => app.project.sequences[0];
  const on = (track) => seq().clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
  return { app, h, seq, on, m1, m2, env: { app, services: { effects } } };
}
const secs = (c) => [c.start / T, model.clipEnd(c) / T];

// ---------- the tool list ----------
await section('schemas', () => {
  const defs = K.definitions();
  const names = defs.map((d) => d.name);
  check(names.length >= 45 && new Set(names).size === names.length && names.every((n) => /^[a-z][a-z_]{2,30}$/.test(n)), `${names.length} tools with unique snake_case names`);
  const bad = defs.filter((d) => {
    const s = d.inputSchema;
    return !d.description || d.description.length < 30 || d.description.length > 700 || s.type !== 'object' || s.additionalProperties !== false
      || !(s.required || []).every((k) => Object.prototype.hasOwnProperty.call(s.properties, k))
      || Object.values(s.properties).some((p) => !p.description && p.type !== 'object');
  });
  eq(bad.map((d) => d.name), [], 'every tool has a description for a model, an object schema without unknown fields, its required fields declared and each field described');
  const kinds = new Set(K.TOOLS.map((t) => t.kind));
  eq([...kinds].sort(), ['edit', 'export', 'play', 'read'], 'the kinds: read, edit, play, export');
  const want = ['get_project', 'get_sequence', 'get_clip', 'get_media', 'get_markers', 'get_captions', 'get_transcript', 'list_effects', 'get_frame', 'get_state',
    'place_clip', 'move_clips', 'trim_clip', 'razor', 'delete_clips', 'delete_range', 'link_clips', 'set_clip', 'set_speed', 'set_time_remap', 'set_keyframes',
    'add_effect', 'set_effect', 'remove_effect', 'set_color', 'add_transition', 'remove_transition', 'add_text', 'set_text', 'add_captions', 'set_caption',
    'remove_captions', 'add_marker', 'set_marker', 'remove_markers', 'add_mask', 'set_mask', 'remove_mask', 'nest_clips', 'set_track', 'set_sequence',
    'remove_silence', 'select_clips', 'seek', 'play', 'stop', 'undo', 'redo', 'export_sequence'];
  eq(want.filter((n) => !names.includes(n)), [], 'the tools of the brief are all there');
  check(defs.every((d) => d.annotations?.title && typeof d.annotations.readOnlyHint === 'boolean'), 'each has MCP annotations (a title, read-only hint)');
  check(defs.filter((d) => d.annotations.readOnlyHint).every((d) => K.kindOf(d.name) === 'read'), 'only the reading tools say read-only');
  const size = S(defs).length;
  check(size < 60000, `the list fits a model's context (${size} characters)`);
  const paths = defs.filter((d) => Object.keys(d.inputSchema.properties).some((k) => /path|file(?!_name)|dir|folder|url|command/i.test(k)));
  eq(paths.map((d) => d.name), [], 'no tool takes a path, a folder, a URL or a command');
  const doc = readFileSync(new URL('../docs/cut-ai-control.md', import.meta.url), 'utf8');
  eq(names.filter((n) => !doc.includes(`| \`${n}\` |`)), [], 'docs/cut-ai-control.md has a row for every tool (node verify/cut-control-core.mjs --table)');
  check(/never by a file path|Nothing here reads or writes files/.test(K.INSTRUCTIONS) && /export_sequence, which asks the user/.test(K.INSTRUCTIONS), 'the server instructions say files are out of reach and export asks');
});

// ---------- the editing tools on a real project ----------
await section('mapping', async () => {
  const x = fresh();
  const run = (name, args) => K.call(name, args, x.env);
  const steps = () => x.h.list().filter((s) => s.done).length;
  const one = async (name, args, label) => {
    const before = steps();
    const r = await run(name, args);
    check(r.ok && steps() === before + 1 && model.validate(x.app.project).ok, `${label} (one undo step, valid)${r.ok ? '' : ` ${r.error}`}`);
    return r;
  };
  const v1 = () => x.on('V1')[0];
  const json0 = x.h.serialize();

  let r = await one('delete_range', { from: 0, to: 3 }, 'delete_range 0-3 s ripple-deletes on every unlocked track');
  eq(x.on('V1').map(secs), [[0, 7]], 'V1 is now 0-7 s');
  eq(x.on('A2').map(secs), [[0, 4]], 'the locked A2 is untouched');
  check(r.edit.at === 0 && r.edit.clips.length >= 2 && x.h.list().at(-1).label === 'Extract', 'the edit says where (0 s) and which clips changed, labelled Extract');
  await one('delete_range', { from: 1, to: 2, ripple: false }, 'delete_range ripple false lifts');
  eq(x.on('V1').map(secs), [[0, 1], [2, 7]], 'a gap at 1-2 s');
  x.h.undo();
  r = await one('razor', { at: 5 }, 'razor at 5 s');
  check(r.value.newClips.length >= 2 && x.on('V1').length === 2, 'V1 split in two');
  r = await one('add_text', { text: '제목', at: 0, duration: 2, size: 120, color: '#ffcc00' }, 'add_text');
  const title = x.seq().clips.find((c) => c.id === r.value.clip);
  check(title && title.source.layers[0].text === '제목' && title.source.layers[0].size === 120 && title.source.layers[0].fill === '#ffcc00' && title.start === 0 && model.clipDuration(title) === 2 * T, 'a 2 s title with its size and color');
  check(title.track !== 'V1', `the title goes above the clips (${title.track})`);
  await one('set_text', { clip_id: title.id, text: '새 제목' }, 'set_text');
  check(x.seq().clips.find((c) => c.id === title.id).source.layers[0].text === '새 제목', 'the title text changed');
  r = await one('add_effect', { clip_id: v1().id, type: 'blur.gaussian', params: { blurriness: 25 } }, 'add_effect');
  check(v1().effects.at(-1).params.blurriness === 25 && r.value.effect === v1().effects.at(-1).id, 'the blur with its parameter');
  await one('set_effect', { clip_id: v1().id, effect_id: r.value.effect, on: false, params: { blurriness: 40 } }, 'set_effect');
  check(v1().effects.at(-1).on === false && v1().effects.at(-1).params.blurriness === 40, 'off at 40');
  await one('set_keyframes', { clip_id: v1().id, property: 'opacity', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100, ease: 'easeOut' }] }, 'set_keyframes on opacity');
  eq(v1().keyframes.opacity.map((k) => [k.t / T, k.v, k.ease]), [[0, 0, 'linear'], [1, 100, 'easeOut']], 'keyframes at clip times');
  await one('set_keyframes', { clip_id: v1().id, property: `effects.${r.value.effect}.blurriness`, keyframes: [{ time: 0.5, value: 0 }, { time: 1.5, value: 60 }] }, 'set_keyframes on an effect parameter');
  await one('remove_effect', { clip_id: v1().id, effect_id: r.value.effect }, 'remove_effect');
  check(!v1().effects.some((e) => e.id === r.value.effect) && !Object.keys(v1().keyframes).some((k) => k.startsWith('effects.')), 'gone with its keyframes');
  r = await one('set_color', { clip_id: v1().id, exposure: 0.5, saturation: 120 }, 'set_color adds Lumetri Color');
  const lum = v1().effects.find((e) => e.type === 'color.basic');
  check(lum?.params.exposure === 0.5 && lum.params.saturation === 120, 'exposure and saturation set');
  await one('set_color', { clip_id: v1().id, contrast: 20 }, 'set_color again');
  check(v1().effects.filter((e) => e.type === 'color.basic').length === 1 && v1().effects.find((e) => e.type === 'color.basic').params.contrast === 20, 'the same Lumetri Color changed, not a second one');
  const a1 = () => x.on('A1')[0];
  await one('set_clip', { clip_id: a1().id, volume: -6, fade_in: 0.5 }, 'set_clip volume and fade on audio');
  check(a1().props.volume === -6 && a1().fadeIn === Math.round(0.5 * T / F) * F, 'volume -6 dB and a half-second fade');
  await one('add_effect', { clip_id: a1().id, type: 'audio.compressor', params: { ratio: 4 } }, 'an audio effect on an audio clip');
  await one('set_clip', { clip_id: v1().id, rotation: 15, scale: 120, position: [10, -20] }, 'set_clip rotation, scale, position on video');
  check(v1().props.scale[0] === 120 && v1().props.scale[1] === 120 && v1().props.position[1] === -20, 'scale 120 % both ways, moved');
  await one('set_speed', { clip_id: x.on('V1')[1].id, speed: 50 }, 'set_speed 50 %');
  check(x.on('V1')[1].speed === 0.5, 'half speed');
  await one('add_marker', { at: 1, name: '여기', kind: 'chapter' }, 'add_marker');
  await one('add_marker', { at: 1.5, name: 'clip', clip_id: v1().id }, 'a clip marker');
  check(x.seq().markers.some((m) => m.kind === 'chapter' && m.t === 1 * T && m.color === 'blue') && v1().markers?.[0]?.t === 1.5 * T - v1().start, 'a blue chapter marker at 1 s; a clip marker in clip time');
  await one('set_marker', { marker_id: x.seq().markers[0].id, name: '처음' }, 'set_marker');
  await one('remove_markers', { kind: 'chapter' }, 'remove_markers by kind (the allowlist)');
  check(!x.seq().markers.some((m) => m.kind === 'chapter'), 'no chapter marker left');
  r = await one('add_captions', { name: '자막', lang: 'ko', items: [{ start: 0, end: 1.5, text: '안녕하세요' }, { start: 2, end: 3, text: '반가워요' }] }, 'add_captions makes a track');
  const ct = x.seq().captions.find((t) => t.id === r.value.track);
  check(ct?.items.length === 2 && ct.items[0].text === '안녕하세요' && ct.lang === 'ko', 'two Korean captions');
  await one('add_captions', { track_id: ct.id, items: [{ start: 4, end: 5, text: '셋' }] }, 'add_captions to that track');
  await one('set_caption', { track_id: ct.id, caption_id: ct.items[0].id, text: '안녕!' }, 'set_caption');
  await one('remove_captions', { track_id: ct.id, caption_ids: [ct.items.at(-1).id] }, 'remove_captions');
  check(x.seq().captions.find((t) => t.id === ct.id).items.length === 2, 'two captions left');
  r = await one('add_transition', { track: 'V1', at: 5 }, 'add_transition at the razor cut');
  check(x.seq().transitions.some((t) => t.id === r.value.transition && t.type === 'dissolve' && t.at === 5 * T), 'a cross dissolve at 5 s');
  await one('remove_transition', { transition_id: r.value.transition }, 'remove_transition');
  r = await one('add_mask', { clip_id: v1().id, shape: 'ellipse', x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 30 }, 'add_mask');
  check(v1().masks?.[0]?.feather === 30 && v1().masks[0].path.length === 24, 'an ellipse of four points, feathered');
  await one('set_mask', { clip_id: v1().id, mask_id: r.value.mask, inverted: true }, 'set_mask');
  await one('remove_mask', { clip_id: v1().id, mask_id: r.value.mask }, 'remove_mask');
  r = await one('place_clip', { media_id: x.m2, at: 7, video_track: 'V2', duration: 1.5 }, 'place_clip a picture');
  check(r.value.clips.length === 1 && r.value.start === 7 && r.value.end === 8.5, 'the picture at 7-8.5 s');
  r = await one('place_clip', { media_id: x.m1, at: 1, mode: 'insert', source_in: 2, source_out: 3 }, 'place_clip insert 1 s of the video');
  check(r.value.clips.length === 2, 'video and its sound, linked');
  await one('move_clips', { clip_ids: [r.value.clips[0]], delta: 0.5, insert: false }, 'move_clips');
  await one('trim_clip', { clip_id: x.on('V1').at(-1).id, edge: 'end', delta: -0.5, mode: 'ripple' }, 'trim_clip ripple');
  await one('link_clips', { clip_ids: r.value.clips, action: 'unlink' }, 'link_clips unlink');
  await one('delete_clips', { clip_ids: [r.value.clips[1]] }, 'delete_clips');
  await one('set_track', { track_id: 'A1', volume: -3, mute: true }, 'set_track');
  check(x.seq().tracks.find((t) => t.id === 'A1').volume === -3, 'A1 at -3 dB');
  await one('set_sequence', { master_gain: -2 }, 'set_sequence master gain');
  const tr = x.on('V1').find((c) => c.speed === 1 && !model.isStill(x.app.project, c) && model.clipDuration(c) >= 2 * T);
  r = await one('set_time_remap', { clip_id: tr.id, segments: [{ speed: 200, until: tr.start / T + 1 }, { speed: 100 }] }, 'set_time_remap');
  check(x.seq().clips.find((c) => c.id === tr.id).remap?.speeds?.[0] === 2, 'a 200 % segment first');
  await one('set_time_remap', { clip_id: tr.id, off: true }, 'set_time_remap off');
  r = await one('nest_clips', { clip_ids: [title.id], name: 'Titles' }, 'nest_clips');
  check(x.app.project.sequences.some((s2) => s2.id === r.value.sequence && s2.name === 'Titles'), 'a nested sequence');

  // the allowlist's measured op through a stand-in silence service
  const silent = { ...x.env, services: { ...x.env.services, silence: async () => ({ ranges: [[1 * T, 2 * T]], tracks: ['V1', 'A1'] }) } };
  const before = steps();
  r = await K.call('remove_silence', { longer_than: 0.5 }, silent);
  check(r.ok && steps() === before + 1 && x.h.list().at(-1).label === 'Remove Silence' && r.value.cuts === 1, 'remove_silence ripple-deletes the measured silence as one Remove Silence step');

  // reading
  r = await run('get_sequence', {});
  check(r.ok && r.value.tracks.some((t) => t.id === 'A2' && t.locked) && r.value.clips.every((c) => Number.isInteger(c.startFrame) && typeof c.start === 'number'), 'get_sequence: tracks (locked shown), clips in seconds and frames');
  check(!S(r.value).includes('C:/media'), 'no file path in what the AI reads');
  r = await run('get_media', {});
  check(r.ok && r.value.length === 2 && r.value.every((m) => !('path' in m)) && !S(r.value).includes('C:/'), 'get_media: names and kinds, no paths');
  r = await run('get_clip', { clip_id: v1().id });
  check(r.ok && r.value.effects.some((e) => e.type === 'color.basic' && e.params.exposure === 0.5 && e.params.temperature === 0) && Array.isArray(r.value.linked), 'get_clip: effects with every parameter, links');
  r = await run('list_effects', { kind: 'audio' });
  check(r.ok && r.value.effects.every((e) => e.kind === 'audio') && r.value.effects.some((e) => e.type === 'audio.eq' && e.params.some((p) => /^hpFreq: number 20\.\.20000 = 80 Hz$/.test(p))), 'list_effects: audio effects with "id: type min..max = default"');
  r = await run('get_captions', { from: 0, to: 1.8 });
  const all = x.seq().captions[0].items.length;
  check(r.ok && r.value[0].items.length >= 1 && r.value[0].items.length < all && r.value[0].items.every((it) => it.start < 1.8 && it.end > 0), 'get_captions within a range');
  r = await run('get_state', {});
  check(r.ok && Array.isArray(r.value.lastSteps) && r.value.canUndo === true, 'get_state: the playhead, the selection, the last steps');
  r = await K.call('get_transcript', {}, { ...x.env, services: { ...x.env.services, transcript: async () => [{ start: 0, end: 1.2, text: '안녕' }] } });
  eq(r.value, [{ start: 0, end: 1.2, text: '안녕' }], 'get_transcript from the transcript service');
  r = await K.call('get_frame', { time: 1, width: 320 }, { ...x.env, services: { ...x.env.services, frame: async (s2, t, w) => ({ ok: true, base64: 'iVBORw0KGgo=', width: w, height: w * 9 / 16, t }) } });
  check(r.ok && r.image?.mimeType === 'image/png' && r.image.data === 'iVBORw0KGgo=' && r.value.width === 320, 'get_frame: a PNG image and its size');
  r = await run('select_clips', { clip_ids: [v1().id] });
  check(r.ok && x.app.selection.has(v1().id), 'select_clips');
  r = await run('seek', { time: 2.5 });
  check(r.ok && x.app.t === 2.5 * T, 'seek');

  // undo exactly
  while (x.h.canUndo) x.h.undo();
  check(x.h.serialize() === json0, 'undoing every step brings back the exact JSON');
});

// ---------- refusals ----------
await section('refusals', async () => {
  const x = fresh();
  const json = () => x.h.serialize();
  const steps = () => x.h.list().length;
  const refused = async (name, args, re, label, env = x.env) => {
    const before = json();
    const n = steps();
    const r = await K.call(name, args, env);
    check(!r.ok && re.test(r.error || '') && json() === before && steps() === n, `${label}${r.ok ? ': accepted' : ` (${r.error})`}`);
  };
  const v1 = x.on('V1')[0];
  const a2 = x.on('A2')[0];
  await refused('delete_clips', { clip_ids: ['c999'] }, /no clip c999.*get_sequence/, 'a clip id that does not exist');
  await refused('trim_clip', { clip_id: v1.id, edge: 'middle', delta: 1 }, /edge must be one of start, end/, 'an edge that is not one');
  await refused('set_track', { track_id: 'V9', name: 'x' }, /no track V9. The tracks are V1/, 'a track that does not exist names the tracks');
  await refused('delete_range', { from: 0, to: 30 }, /to 30 s is outside the sequence \(0 to 10 s\)/, 'a time past the end');
  await refused('razor', { at: -1 }, /at must be at least 0/, 'a negative time (schema)');
  await refused('add_marker', { at: 12 }, /outside the sequence/, 'a marker past the end');
  await refused('add_captions', { items: [{ start: 5, end: 4, text: 'x' }] }, /end at least one frame after/, 'a caption that ends before it starts');
  await refused('delete_clips', { clip_ids: [a2.id] }, /Track A2 is locked/, 'deleting a clip on a locked track');
  await refused('razor', { at: 1, track_ids: ['A2'] }, /A2 is locked/, 'a razor on a locked track');
  await refused('place_clip', { media_id: x.m1, at: 0, video_track: null, audio_track: 'A2' }, /A2 is locked/, 'placing on a locked track');
  await refused('set_clip', { clip_id: a2.id, volume: -3 }, /locked/, 'changing a clip on a locked track');
  await refused('set_track', { track_id: 'A2', name: 'mine' }, /locked/, 'renaming a locked track');
  await refused('set_track', { track_id: 'V1', locked: true }, /no argument "locked"/, 'locking is not a tool argument');
  await refused('add_effect', { clip_id: v1.id, type: 'sparkle.magic' }, /no effect "sparkle.magic". list_effects/, 'an unknown effect');
  await refused('add_effect', { clip_id: v1.id, type: 'dissolve' }, /no effect "dissolve"/, 'a transition is not an effect');
  await refused('add_effect', { clip_id: v1.id, type: 'audio.eq' }, /audio effect.*video clip.*linked audio clip/, 'an audio effect on a video clip names the linked audio');
  await refused('add_effect', { clip_id: v1.id, type: 'blur.gaussian', params: { radius: 3 } }, /no parameter "radius". Its parameters: blurriness/, 'an unknown parameter lists the right ones');
  await refused('add_effect', { clip_id: v1.id, type: 'blur.gaussian', params: { blurriness: 9000 } }, /outside 0 to 500/, 'a parameter out of range');
  await refused('add_effect', { clip_id: v1.id, type: 'color.basic', params: { lut: 'lut-1' } }, /cannot be set by these tools/, 'a LUT (a file) cannot be set');
  await refused('set_color', { clip_id: v1.id, exposure: 9 }, /outside -4 to 4/, 'an exposure out of range');
  await refused('add_transition', { track: 'V1', at: 4 }, /no clip edge on V1 at 4 s/, 'a transition where there is no edit point');
  await refused('add_transition', { track: 'A1', at: 10, type: 'dissolve' }, /video transition and A1 a audio track/, 'a video transition on an audio track');
  await refused('set_clip', { clip_id: v1.id, volume: -6 }, /audio clips.*Its linked audio clip is/, 'volume on a video clip');
  await refused('set_clip', { clip_id: v1.id, opacity: 150 }, /opacity must be at most 100/, 'opacity over 100 (schema)');
  await refused('set_clip', { clip_id: v1.id }, /at least one setting/, 'a change with nothing to change');
  await refused('set_speed', { clip_id: x.on('V2')[0].id, speed: 50 }, /still/, 'the speed of a picture');
  await refused('place_clip', { media_id: 'C:\\Users\\nano\\Videos\\secret.mp4', at: 0 }, /never by a file path/, 'a file path where a media id goes');
  await refused('place_clip', { media_id: '..\\..\\x.mp4', at: 0 }, /never by a file path/, 'a relative path');
  await refused('place_clip', { media_id: 'm77', at: 0 }, /no media m77/, 'a media id that does not exist');
  await refused('place_clip', { path: 'C:/x.mp4', at: 0 }, /no argument "path"/, 'a path argument');
  await refused('export_sequence', { preset: '720p', file_name: 'C:\\Windows\\x' }, /plain name, without folders/, 'an export file name with a folder');
  await refused('export_sequence', { preset: '720p', file_name: '..' }, /plain name/, 'an export file name of dots');
  await refused('export_sequence', { preset: 'prores' }, /preset must be one of/, 'an unknown preset');
  await refused('get_sequence', { sequence_id: 's99' }, /no sequence s99/, 'a sequence that does not exist');
  await refused('move_clips', { clip_ids: [v1.id], delta: -5 }, /before the start/, 'moving before 0');
  await refused('set_keyframes', { clip_id: v1.id, property: 'volume', keyframes: [] }, /no property "volume"/, 'a property the clip does not have');
  await refused('set_keyframes', { clip_id: v1.id, property: 'opacity', keyframes: [{ time: 30, value: 1 }] }, /outside the clip/, 'a keyframe outside the clip');
  await refused('set_time_remap', { clip_id: v1.id, segments: [{ speed: 50 }, { speed: 100 }] }, /needs "until"/, 'a remap segment without its end');
  await refused('add_text', { text: '   ', at: 0 }, /empty/, 'an empty title');
  await refused('nope_tool', {}, /no tool nope_tool/, 'an unknown tool');
  await refused('razor', { at: '1' }, /at must be number/, 'a string where a number goes');
  await refused('razor', {}, /needs "at"/, 'a missing argument');
  await refused('razor', { at: 4, extra: true }, /no argument "extra"/, 'an unknown argument');
  await refused('link_clips', { clip_ids: [v1.id], action: 'link' }, /two clips or more/, 'linking one clip');
  await refused('remove_markers', { kind: 'beat' }, /no beat sequence markers/, 'removing markers there are none of');
  await refused('undo', {}, /nothing of yours to undo/, 'a turn cannot undo the steps before it', { ...x.env, undoFloor: x.h.position });
  await refused('get_frame', {}, /cannot be rendered here/, 'a frame without the page');
  // the export question: declined
  const asked = [];
  await refused('export_sequence', { preset: 'youtube-1080p', file_name: 'out' }, /said no/, 'an export the user declines writes nothing',
    { ...x.env, services: { ...x.env.services, exportAsk: async (q) => { asked.push(q); return { ok: false, declined: true }; } } });
  check(asked.length === 1 && asked[0].preset === 'youtube-1080p' && asked[0].fileName === 'out', 'the export asked the user first');
});

// ---------- nothing reaches the disk ----------
await section('no disk', async () => {
  const src = readFileSync(new URL('../renderer/features/cut/control.js', import.meta.url), 'utf8');
  check(!/require\(['"](fs|child_process|path|os|net|http)['"]\)|ide\.api|invoke\(|fetch\(|XMLHttpRequest|new Function|eval\(/.test(src), 'control.js has no file, process, network or IPC call in it');
  const x = fresh();
  const touched = [];
  const watch = (obj, name) => {
    const saved = {};
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] !== 'function') continue;
      const fn = obj[k];
      try { obj[k] = function (...a) { touched.push(`${name}.${k}`); return fn.apply(this, a); }; saved[k] = fn; } catch {}
    }
    return () => { for (const [k, fn] of Object.entries(saved)) obj[k] = fn; };
  };
  const undo = [watch(fsMod, 'fs'), watch(fsMod.promises, 'fs.promises'), watch(childMod, 'child_process')];
  globalThis.ide = new Proxy({}, { get(_, k) { touched.push(`ide.${String(k)}`); throw new Error('no ide here'); } });
  const ask = [];
  const env = { ...x.env, services: { effects, frame: async () => ({ ok: true, base64: '', width: 1, height: 1 }), transcript: async () => [], silence: async () => ({ ranges: [], tracks: [] }), exportAsk: async (q) => { ask.push(q); return { ok: false, declined: true }; } } };
  const sample = {
    get_clip: { clip_id: x.on('V1')[0].id }, get_frame: {}, place_clip: { media_id: x.m2, at: 1, video_track: 'V2', duration: 1 }, move_clips: { clip_ids: [x.on('V1')[0].id], delta: 1 },
    trim_clip: { clip_id: x.on('V1')[0].id, edge: 'end', delta: -1 }, razor: { at: 3 }, delete_clips: { clip_ids: [x.on('V2')[0].id] }, delete_range: { from: 0, to: 1 },
    link_clips: { clip_ids: [x.on('V1')[0].id, x.on('A1')[0].id], action: 'link' }, set_clip: { clip_id: x.on('V1')[0].id, opacity: 80 }, set_speed: { clip_id: x.on('V1')[0].id, speed: 200 },
    set_time_remap: { clip_id: x.on('V1')[0].id, off: true }, set_keyframes: { clip_id: x.on('V1')[0].id, property: 'opacity', keyframes: [] }, add_effect: { clip_id: x.on('V1')[0].id, type: 'mosaic' },
    set_effect: { clip_id: x.on('V1')[0].id, effect_id: 'e1', on: false }, remove_effect: { clip_id: x.on('V1')[0].id, effect_id: 'e1' }, set_color: { clip_id: x.on('V1')[0].id, tint: 5 },
    add_transition: { track: 'V1', at: 0 }, remove_transition: { transition_id: 't1' }, add_text: { text: 'x', at: 0 }, set_text: { clip_id: x.on('V3')[0].id, text: 'y' },
    add_captions: { items: [{ start: 0, end: 1, text: 'a' }] }, set_caption: { track_id: 'cc1', caption_id: 'cap1', text: 'b' }, remove_captions: { track_id: 'cc1', whole_track: true },
    add_marker: { at: 1 }, set_marker: { marker_id: 'mk1', name: 'n' }, remove_markers: { kind: 'all' }, add_mask: { clip_id: x.on('V1')[0].id, shape: 'rectangle' },
    set_mask: { clip_id: x.on('V1')[0].id, mask_id: 'm1', feather: 1 }, remove_mask: { clip_id: x.on('V1')[0].id, mask_id: 'm1' }, nest_clips: { clip_ids: [x.on('V3')[0].id] },
    set_track: { track_id: 'V1', name: 'Main' }, set_sequence: { name: 'S' }, remove_silence: { longer_than: 1 }, select_clips: { clip_ids: [] }, seek: { time: 1 },
    export_sequence: { preset: '720p' },
  };
  const ran = [];
  try {
    for (const t of K.TOOLS) {
      const r = await K.call(t.name, sample[t.name] || {}, env);
      ran.push(`${t.name}:${r.ok ? 'ok' : 'refused'}`);
    }
  } finally {
    for (const f of undo) f();
    delete globalThis.ide;
  }
  eq(touched, [], `no tool touched fs, child_process or the page's ide while ${ran.length} tools ran (${ran.filter((s) => s.endsWith('ok')).length} did their work)`);
  check(ask.length === 1, 'the one export went to the question, nowhere else');
});

// ---------- squash ----------
await section('squash', () => {
  const x = fresh();
  const json0 = x.h.serialize();
  const floor = x.h.position;
  const s = x.seq().id;
  x.h.do(C.split(s, 2 * T));
  x.h.do(C.addMarker(s, { t: T, name: 'a' }));
  x.h.do(C.setSequence(s, { masterGain: -3 }));
  const mid = x.h.serialize();
  const events = [];
  x.app.on('history', (e) => events.push(e.reason));
  check(x.h.squash(floor, '앞 3초 잘라내고 제목 자막 넣어줘'), 'squash says it named a step');
  check(x.h.list().length === floor + 1 && x.h.list().at(-1).label === '앞 3초 잘라내고 제목 자막 넣어줘' && x.h.serialize() === mid, 'three steps became one named after the request; the project is unchanged');
  eq(events, ['commit'], 'the history panel hears it as a commit');
  x.h.undo();
  check(x.h.serialize() === json0, 'one undo takes the whole turn back');
  x.h.redo();
  check(x.h.serialize() === mid, 'one redo brings it back');
  check(!x.h.squash(x.h.position, 'nothing'), 'nothing after the position: no step');
  x.h.markSaved();
  x.h.do(C.addMarker(s, { t: 2 * T, name: 'b' }));
  x.h.squash(x.h.position - 1, 'one');
  check(x.h.dirty, 'a squashed edit after saving is still unsaved');
});

// ---------- the server ----------
async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : S(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, session: res.headers.get('mcp-session-id') };
}
await section('server', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cut-control-'));
  const control = createControl({ configFile: path.join(dir, 'cut-control.json') });
  try {
    const port = await control.start();
    check(Number.isInteger(port) && port > 0, `listening on 127.0.0.1:${port}`);
    control.setTools(K.definitions(), K.INSTRUCTIONS);
    const x = fresh();
    const page = [];
    control.setTarget((channel, call) => {
      page.push(call);
      setTimeout(async () => {
        const r = await K.call(call.name, call.args, x.env);
        control.answer({ id: call.id, result: { content: [{ type: 'text', text: r.ok ? S(r.value) : r.error }], isError: !r.ok } });
      }, 5);
      return channel === 'cut:controlCall';
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } };
    let r = await post(url, init);
    check(r.status === 401 && page.length === 0, 'no token: 401');
    r = await post(url, init, { Authorization: 'Bearer 0123' });
    check(r.status === 401, 'a wrong token: 401');
    const ext = await control.setExternal(false);
    check(ext.on === false, 'external AIs are off until allowed');
    const chat = control.issue('turn1', 7);
    r = await post(url, init, { Authorization: `Bearer ${chat}`, Origin: 'http://evil.example' });
    check(r.status === 403, 'a request from a web page (Origin): 403, even with the token');
    const raw = await new Promise((resolve) => {
      const req = require('http').request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: `rebind.example:${port}`, Authorization: `Bearer ${chat}`, 'Content-Type': 'application/json' } }, (res) => resolve(res.statusCode));
      req.end(S(init));
    });
    check(raw === 403, 'another Host (DNS rebinding): 403');
    r = await post(url, init, { Authorization: `Bearer ${chat}` });
    check(r.status === 200 && r.json.result.serverInfo.name === 'Nano Studio Cut' && /video editor/.test(r.json.result.instructions) && !!r.session, 'a turn\'s token: initialize answers with instructions and a session');
    const auth = { Authorization: `Bearer ${chat}`, 'Mcp-Session-Id': r.session };
    r = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    check(r.status === 202, 'a notification: 202');
    r = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    check(r.json.result.tools.length === K.TOOLS.length && r.json.result.tools.every((t) => t.inputSchema?.type === 'object'), 'tools/list: every tool with its schema');
    r = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_range', arguments: { from: 0, to: 2 } } }, auth);
    check(r.json.result.isError === false && page.at(-1).client.kind === 'chat' && page.at(-1).client.turn === 'turn1' && x.on('V1')[0] && model.clipEnd(x.on('V1')[0]) === 8 * T, 'a call goes to the page with who called (this turn), runs there and answers');
    r = await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_clips', arguments: { clip_ids: ['c999'] } } }, auth);
    check(r.json.result.isError === true && /no clip c999/.test(r.json.result.content[0].text), 'a refused call: isError with the reason');
    r = await post(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_program', arguments: {} } }, auth);
    check(r.json.error?.code === -32602 && page.every((c) => c.name !== 'run_program'), 'a tool that is not listed never reaches the page');
    r = await post(url, '{bad', auth);
    check(r.status === 400 && r.json.error.code === -32700, 'broken JSON: a parse error');
    const get = await fetch(url, { headers: auth });
    check(get.status === 405, 'GET: 405 (no event stream)');
    r = await post(url, S({ jsonrpc: '2.0', id: 6, method: 'ping', pad: 'x'.repeat(1.2 * 1024 * 1024) }), auth).catch(() => ({ status: 413 }));
    check(r.status === 413, 'a body over 1 MB: 413');
    control.revoke(chat);
    r = await post(url, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, auth);
    check(r.status === 401, 'a turn\'s token after the turn: 401');

    // external AIs
    const on = await control.setExternal(true);
    check(on.on && on.url === url && /^[0-9a-f]{48}$/.test(on.token), 'allowed: the URL and a token');
    const saved = JSON.parse(readFileSync(path.join(dir, 'cut-control.json'), 'utf8'));
    check(saved.token === on.token && saved.port === port, 'the token and the port are kept for next time');
    const clientEvents = [];
    control.onClients((e) => clientEvents.push(e.external.length));
    r = await post(url, init, { Authorization: `Bearer ${on.token}` });
    check(r.status === 200 && control.connected().length === 1 && clientEvents.at(-1) === 1, 'the external AI connects with its token and is listed as connected');
    const extAuth = { Authorization: `Bearer ${on.token}`, 'Mcp-Session-Id': r.session };
    r = await post(url, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, extAuth);
    check(r.json.result.isError === false && page.at(-1).client.kind === 'external', 'its calls reach the page marked external');
    const again = await control.setExternal(true);
    check(again.token === on.token, 'asking again keeps the same token');
    const fresh2 = await control.disconnect();
    check(fresh2.token !== on.token && control.connected().length === 0 && clientEvents.at(-1) === 0, 'Disconnect replaces the token and lists nobody');
    r = await post(url, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, extAuth);
    check(r.status === 401, 'the old token is refused after Disconnect');
    await control.setExternal(false);
    r = await post(url, init, { Authorization: `Bearer ${fresh2.token}` });
    check(r.status === 401, 'with the setting off, the external token is refused');

    // a page that goes away answers its calls as errors
    control.setTarget(() => true);
    const chat2 = control.issue('turn2', 7);
    const pending = post(url, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, { Authorization: `Bearer ${chat2}` });
    await sleep(100);
    control.abandon();
    r = await pending;
    check(r.json.result.isError === true && /reloaded or closed/.test(r.json.result.content[0].text), 'a page that reloads: its pending call ends as an error');
    control.setTarget(() => false);
    r = await post(url, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, { Authorization: `Bearer ${chat2}` });
    check(r.json.result.isError === true && /not open/.test(r.json.result.content[0].text), 'no page: the call says the window is not open');
  } finally {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the agent with the scripted fake CLI ----------
await section('agent', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cut-agent-'));
  const control = createControl({ configFile: path.join(dir, 'cut-control.json') });
  const cmd = path.join(dir, 'claude.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${path.join(process.cwd(), 'verify', 'fake-claude-cut.mjs')}" %*\r\n`);
  writeFileSync(path.join(dir, 'log.jsonl'), '');
  const old = { p: process.env.PYIDE_CLAUDE_PATH, d: process.env.FAKE_CLAUDE_DIR };
  process.env.PYIDE_CLAUDE_PATH = cmd;
  process.env.FAKE_CLAUDE_DIR = dir;
  const scenario = (s) => writeFileSync(path.join(dir, 'scenario.json'), S(s));
  try {
    await control.start();
    control.setTools(K.definitions(), K.INSTRUCTIONS);
    const x = fresh();
    let turnId = null;
    control.setTarget((_ch, call) => {
      setTimeout(async () => {
        const r = call.client.turn === turnId ? await K.call(call.name, call.args, x.env) : { ok: false, error: 'This request has ended.' };
        control.answer({ id: call.id, result: { content: [{ type: 'text', text: r.ok ? S(r.value) : r.error }], isError: !r.ok } });
      }, 1);
      return true;
    });
    const agent = createAgent({ control });
    const events = [];
    const sender = { isDestroyed: () => false, send: (ch, e) => { if (ch === 'cut:agentEvent') events.push(e); } };
    const sys = 'You are the editing assistant inside Nano Studio Cut.';
    scenario({ stepMs: 0 });
    turnId = 'a1';
    const floor = x.h.position;
    let r = await agent.run(7, { turn: 'a1', system: sys, prompt: 'The editor now (JSON): {}\n\nThe user\'s request: 앞 3초 잘라내고 제목 자막 넣어줘', model: 'sonnet' }, sender);
    check(r.ok && /앞 3초/.test(r.text), `the turn ends with Claude's answer (${r.text || r.error})`);
    const log = readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.agent);
    const args = log.find((l) => l.start).args;
    const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
    check(allowed.length === K.TOOLS.length && allowed.every((a) => /^mcp__cut__[a-z_]+$/.test(a)), 'only the Cut tools are allowed (mcp__cut__<name>)');
    check(args[args.indexOf('--tools') + 1] === '' && args.includes('--strict-mcp-config') && args[args.indexOf('--permission-mode') + 1] === 'dontAsk' && !args.some((a) => /Bash|Write|Edit|WebFetch|Read\b/.test(a)), 'no built-in tool, only this MCP server, nothing asked or allowed beyond');
    check(args.includes('--no-session-persistence') && args.includes('--system-prompt-file') && log.find((l) => l.start).system === sys && log.find((l) => l.start).env.mds === '1', 'no session file, our system prompt, no CLAUDE.md');
    const cfgFile = args[args.indexOf('--mcp-config') + 1];
    check(!existsSync(cfgFile), 'the MCP settings file (with the token) is gone after the turn');
    eq(log.filter((l) => l.tool).map((l) => `${l.tool}:${l.ok}`), ['get_sequence:true', 'delete_range:true', 'add_text:true', 'add_marker:true'], 'the agent read, then made three edits');
    const types = events.filter((e) => e.turn === 'a1').map((e) => e.type);
    check(types.includes('text') && types.indexOf('tool') < types.indexOf('result') && types.at(-1) === 'done', `the events: what Claude says, tool and result pairs, done last (${types.join(' ')})`);
    const tools = events.filter((e) => e.type === 'tool');
    const resultsOf = events.filter((e) => e.type === 'result');
    check(tools.length === 4 && tools.every((t) => resultsOf.some((x2) => x2.id === t.id && x2.ok)) && tools[1].name === 'delete_range' && tools[1].input.to === 3, 'each tool call is an event with its name (without mcp__cut__) and input, answered by its result');
    check(x.h.position === floor + 3 && x.on('V1').map(secs)[0][1] === 7, 'the three edits landed (V1 is 7 s long)');
    const stale = await post(`http://127.0.0.1:${control.port}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${JSON.parse('{}').x || 'none'}` });
    check(stale.status === 401 && control.stats().turns === 0, 'no turn token is left');

    // a refused call
    turnId = 'a2';
    events.length = 0;
    const json = x.h.serialize();
    r = await agent.run(7, { turn: 'a2', system: sys, prompt: 'The user\'s request: 잠긴 트랙의 클립을 지워줘' }, sender);
    const res2 = events.find((e) => e.type === 'result' && !e.ok);
    check(r.ok && res2 && /locked/.test(res2.text) && x.h.serialize() === json, 'a refused call comes back as a failed result with the reason; nothing changed');

    // Stop in the middle
    turnId = 'a3';
    events.length = 0;
    scenario({ stepMs: 400 });
    const before = x.h.position;
    const running = agent.run(7, { turn: 'a3', system: sys, prompt: 'The user\'s request: 천천히 표시 넣어줘' }, sender);
    for (let i = 0; i < 100 && events.filter((e) => e.type === 'result').length < 2; i++) await sleep(50);
    const t0 = Date.now();
    check(agent.stop(7, 'a3').ok, 'Stop is accepted');
    r = await running;
    const done = x.h.position - before;
    check(r.code === 'cancelled' && Date.now() - t0 < 5000 && events.at(-1).type === 'done' && events.at(-1).code === 'cancelled', `Stop ends the turn at once (${Date.now() - t0} ms)`);
    check(done >= 1 && done < 8 && model.validate(x.app.project).ok, `the edits made before Stop stay (${done} of 8) and the project is valid`);
    await sleep(900);
    check(x.h.position - before === done, 'nothing lands after Stop');
    check(!agent.stop(7, 'a3').ok, 'a stopped turn is gone');

    // a usage limit, a missing CLI, bad requests
    scenario({});
    r = await agent.run(7, { turn: 'a4', system: sys, prompt: 'The user\'s request: quota' }, sender);
    check(r.code === 'quota' && /usage limit/.test(r.error), 'a usage limit gives code quota');
    process.env.PYIDE_CLAUDE_PATH = 'none';
    r = await agent.run(7, { turn: 'a5', system: sys, prompt: 'The user\'s request: x' }, sender);
    check(r.code === 'not-installed', 'no Claude Code: not-installed');
    process.env.PYIDE_CLAUDE_PATH = cmd;
    check((await agent.run(7, { turn: 'bad id!', system: sys, prompt: 'x' }, sender)).code === 'badArgs' && (await agent.run(7, { turn: 'a6', system: sys, prompt: 'x', model: 'gpt' }, sender)).code === 'badArgs', 'a bad turn id or model is refused');
    check(claude.classify("You've hit your limit · resets 5pm") === 'quota' && claude.classify('Not logged in · Please run /login') === 'auth' && claude.classify('boom') === 'cli', 'the CLI\'s messages are told apart: quota, auth, other');
    const left = readdirSync(claude.WORK_DIR).filter((f) => f.startsWith('cut-mcp-'));
    eq(left, [], 'no MCP settings file is left in the CLI\'s folder');
  } finally {
    control.close();
    process.env.PYIDE_CLAUDE_PATH = old.p ?? '';
    if (!old.p) delete process.env.PYIDE_CLAUDE_PATH;
    if (old.d) process.env.FAKE_CLAUDE_DIR = old.d; else delete process.env.FAKE_CLAUDE_DIR;
    await sleep(200);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- as a page script ----------
await section('page', async () => {
  const page = { console, JSON, Math, Number, String, Array, Object, Map, Set, Error, Float32Array, Float64Array, Uint16Array, Uint32Array, Int32Array, Uint8ClampedArray, Uint8Array, Promise, RegExp, Symbol, Reflect, Proxy };
  page.globalThis = page;
  page.require = () => { throw new Error('Check dependency list!'); };
  vm.createContext(page);
  const dir = new URL('../renderer/features/cut/', import.meta.url);
  const order = readFileSync(new URL('index.js', dir), 'utf8').match(/'[a-z0-9-]+\.js'/g).map((x) => x.slice(1, -1));
  check(order.indexOf('control.js') > order.indexOf('ai.js') && order.indexOf('control.js') > order.indexOf('commands.js') && order.indexOf('ui-assistant.js') > order.indexOf('ui-ai.js') && order.indexOf('ui-assistant.js') < order.indexOf('ui-settings.js'), 'index.js loads control.js after ai.js, ui-assistant.js after ui-ai.js and before the settings page');
  const mine = ['time.js', 'state.js', 'captionwords.js', 'remap.js', 'model.js', 'keyframes.js', 'masks.js', 'commands.js', 'lumetri.js', 'effects.js', 'analyze.js', 'speech.js', 'ai.js', 'control.js'];
  for (const file of order.filter((x) => mine.includes(x))) vm.runInContext(readFileSync(new URL(file, dir), 'utf8'), page, { filename: file });
  const out = await vm.runInContext(`(async () => {
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
    const app = Cut.state.createApp();
    app.setHistory(Cut.commands.createHistory(p));
    const r = await Cut.control.call('add_text', { text: 'hi', at: 0, duration: 1 }, { app, services: {} });
    return [r.ok, Cut.control.definitions().length > 40, app.project.sequences[0].clips.length];
  })()`, page);
  eq(out, [true, true, 1], 'control.js works as a page script through globalThis.Cut');
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
