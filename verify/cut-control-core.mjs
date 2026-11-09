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
const lumetri = require('../renderer/features/cut/lumetri.js');
const keyframes = require('../renderer/features/cut/keyframes.js');
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
// --inventory prints its inventory section (every feature and what covers it).
if (process.argv.includes('--inventory')) {
  const heads = { keys: 'Keyboard actions (ui-keys.js)', automation: 'The Automation menu (ui-auto.js)', menu: 'Menu items without an action (ui-menubar.js)', commands: 'Edit commands (commands.js)', panels: 'Panels' };
  for (const [kind, title] of Object.entries(heads)) {
    console.log(`### ${title}\n\n| Feature | AI path |\n| --- | --- |`);
    for (const [id, e] of Object.entries(K.lib.inventory[kind])) {
      const how = e.no ? `Not for AI: ${e.no}` : [e.act ? `run_action${e.act.needs ? ` (needs ${e.act.needs})` : ''}` : '', ...(e.tools || []).map((t) => `\`${t}\``)].filter(Boolean).join(', ');
      console.log(`| \`${id}\` | ${how.replace(/\|/g, '\\|')} |`);
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
  check(size < 75000, `the list fits a model's context (${defs.length} tools, ${size} characters)`);
  const paths = defs.filter((d) => Object.keys(d.inputSchema.properties).some((k) => /path|file(?!_name)|dir|folder|url|command/i.test(k)));
  eq(paths.map((d) => d.name), ['import_media'], 'only import_media takes paths (the user confirms them); no tool takes a URL or a command');
  const doc = readFileSync(new URL('../docs/cut-ai-control.md', import.meta.url), 'utf8');
  eq(names.filter((n) => !doc.includes(`| \`${n}\` |`)), [], 'docs/cut-ai-control.md has a row for every tool (node verify/cut-control-core.mjs --table)');
  check(/import_media brings in only files the user confirms/.test(K.INSTRUCTIONS) && /ask the user first and write new files only/.test(K.INSTRUCTIONS) && /Nothing else reads or writes files/.test(K.INSTRUCTIONS) && /nothing is\s+downloaded unless the user agrees/.test(K.INSTRUCTIONS), 'the server instructions say which tools touch files, that they ask, and that nothing downloads without the user');
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

// ---------- the tools of control-project.js, control-auto.js and control-actions.js on a real project ----------
await section('more tools', async () => {
  const x = fresh();
  const [m3] = x.h.do(C.importMedia([{ path: 'C:/media/spare.wav', name: 'spare.wav', kind: 'audio', size: 1, mtime: 1, duration: 5 * T, video: null, audio: { rate: 48000, channels: 2, codec: 'pcm' } }])).ids;
  const cube = lumetri.store(lumetri.parseCube(lumetri.identityCube(2)), 'Warm');
  x.h.do(C.addLut(cube));
  const steps = () => x.h.list().filter((s) => s.done).length;
  const one = async (name, args, label, env = x.env) => {
    const before = steps();
    const r = await K.call(name, args, env);
    check(r.ok && steps() === before + 1 && model.validate(x.app.project).ok, `${label} (one undo step, valid)${r.ok ? '' : ` ${r.error}`}`);
    return r;
  };
  const refused = async (name, args, re, label, env = x.env) => {
    const before = x.h.serialize();
    const n = x.h.list().length;
    const r = await K.call(name, args, env);
    check(!r.ok && re.test(r.error || '') && x.h.serialize() === before && x.h.list().length === n, `${label}${r.ok ? ': accepted' : ` (${r.error})`}`);
  };
  const json0 = x.h.serialize();
  const v1 = () => x.on('V1')[0];
  const a1 = () => x.on('A1')[0];
  const src = (clip, s2) => model.sourceTime(clip, Math.round(s2 * T)) / T;
  let r;

  // Time Remapping: a speed ramp, a hold and a reverse
  r = await one('set_time_remap', { clip_id: v1().id, segments: [{ speed: 100, until: 2, ramp: 0.5 }, { speed: 50, until: 4 }, { hold: 1 }, { speed: 100, until: 6 }, { reverse: 1 }, { speed: 100 }] }, 'set_time_remap with a ramp, a hold and a reverse');
  eq(v1().remap.speeds, [1, 0.5, 0, 1, -1, 1, 1], 'the speeds: 100 %, ramping to 50 %, a hold, 100 %, backward, forward again');
  check(v1().remap.keys[0].t === 2 * T && v1().remap.keys[0].ramp === 0.5 * T && r.value.keys[0].ramp === 0.5, 'the ramp starts at 2 s and lasts 0.5 s (the result says so)');
  check(src(v1(), 1) === 1 && src(v1(), 2.25) > 2.15 && src(v1(), 2.25) < 2.25, 'before the ramp 100 %; inside it slower');
  check(src(v1(), 6.2) === src(v1(), 6.8), 'the hold shows one frame for its second');
  check(src(v1(), 9.8) < src(v1(), 9.2) && src(v1(), 10.8) > src(v1(), 10.2), 'the reverse plays backward, then forward again');
  check(r.value.duration === 15 && model.clipDuration(v1()) === 15 * T, 'the clip is 15 s long now (the hold, the slow part and the reverse added 5 s)');
  await refused('set_time_remap', { clip_id: v1().id, segments: [{ hold: 1 }, { speed: 100 }] }, /goes between two speed segments/, 'a hold first');
  await refused('set_time_remap', { clip_id: v1().id, segments: [{ speed: 100, until: 1, ramp: 0.5 }, { hold: 1 }, { speed: 100 }] }, /cannot ramp into a hold/, 'a ramp into a hold');
  await refused('set_time_remap', { clip_id: v1().id, segments: [{ speed: 100, until: 0.5 }, { reverse: 5 }, { speed: 100 }] }, /only 0\.5 s of source before/, 'a reverse longer than the source before it');
  await refused('set_time_remap', { clip_id: v1().id, segments: [{ speed: 100, hold: 1 }] }, /exactly one of speed, hold or reverse/, 'a segment of two kinds');
  await one('set_time_remap', { clip_id: v1().id, off: true }, 'Time Remapping off');

  // masks with keyframes
  r = await one('add_mask', { clip_id: v1().id, shape: 'ellipse', width: 0.4, height: 0.4 }, 'add_mask');
  const mid = r.value.mask;
  await one('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.path`, keyframes: [{ time: 0, value: { shape: 'ellipse', x: 0.3, width: 0.4, height: 0.4 } }, { time: 2, value: { shape: 'ellipse', x: 0.7, width: 0.4, height: 0.4 } }] }, 'a mask path animated (the ellipse moves right)');
  const pathKeys = v1().keyframes[`masks.${mid}.path`];
  check(pathKeys.length === 2 && Math.abs(pathKeys[0].v[0] - 0.3) < 1e-9 && Math.abs(keyframes.valueAt(pathKeys, 1 * T)[0] - 0.5) < 1e-9, 'at 1 s the ellipse is halfway (x 0.5)');
  await one('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.feather`, keyframes: [{ time: 0, value: 0 }, { time: 2, value: 120 }] }, 'mask feather keyframes');
  await one('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.expansion`, keyframes: [{ time: 0, value: -20 }, { time: 1, value: 40, ease: 'easeOut' }] }, 'mask expansion keyframes');
  await one('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.opacity`, keyframes: [{ time: 0, value: 100 }, { time: 1, value: 50 }] }, 'mask opacity keyframes');
  await refused('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.feather`, keyframes: [{ time: 0, value: 5000 }] }, /from 0 to 1000/, 'a mask feather out of range');
  await refused('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.path`, keyframes: [{ time: 0, value: { shape: 'star' } }] }, /shape must be ellipse or rectangle/, 'a mask shape that is not one');
  await refused('set_keyframes', { clip_id: v1().id, property: `masks.${mid}.path`, keyframes: [{ time: 0, value: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0] }] }, /has 3 points; mask m\d+ has 4/, 'a path of another point count');
  await refused('set_mask', { clip_id: v1().id, mask_id: mid, feather: 3 }, /has keyframes; change them with set_keyframes/, 'a static feather over keyframes');
  await refused('set_mask', { clip_id: v1().id, mask_id: mid, shape: 'rectangle' }, /masks\.m\d+\.path has keyframes/, 'a new shape over path keyframes');
  await one('set_mask', { clip_id: v1().id, mask_id: mid, inverted: true, mode: 'subtract' }, 'set_mask inverted and its mode');
  r = await one('add_effect', { clip_id: v1().id, type: 'blur.gaussian', params: { blurriness: 30 } }, 'an effect to mask');
  const blur = r.value.effect;
  r = await one('add_mask', { clip_id: v1().id, effect_id: blur, shape: 'rectangle' }, 'a mask on the effect');
  await one('set_keyframes', { clip_id: v1().id, property: `effects.${blur}.masks.${r.value.mask}.feather`, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 50 }] }, 'an effect mask\'s feather keyframes');
  await one('set_mask', { clip_id: v1().id, effect_id: blur, mask_id: r.value.mask, shape: 'ellipse', x: 0.25, y: 0.25, width: 0.2, height: 0.3 }, 'set_mask gives the effect\'s mask a new shape');
  check(Math.abs(v1().effects.find((e) => e.id === blur).masks[0].path[0] - 0.25) < 1e-9, 'an ellipse centered at x 0.25');

  // Lumetri: curves, the LUT, HSL secondary
  await one('set_color', { clip_id: v1().id, curves: { master: [0, 0, 0.5, 0.62, 1, 1], blue: [0, 0.05, 1, 0.95] }, hsl: { hue: 30, hue_range: 40, sat_low: 20, saturation: 140, hue_shift: -10 } }, 'set_color curves and HSL secondary');
  let lum = v1().effects.find((e) => e.type === 'color.basic');
  check(S(lum.params.curveMaster) === S([0, 0, 0.5, 0.62, 1, 1]) && lum.params.curveBlue[1] === 0.05 && lum.params.hslHue === 30 && lum.params.hslHueRange === 40 && lum.params.hslSaturation === 140 && lum.params.hslHueShift === -10, 'the curves and the HSL range and correction are set');
  await one('set_effect', { clip_id: v1().id, effect_id: lum.id, index: 0 }, 'set_effect moves Lumetri Color first');
  check(v1().effects[0].id === lum.id && v1().effects[1].id === blur, 'Lumetri Color, then the blur');
  await one('set_color', { clip_id: v1().id, lut: cube.id, lut_intensity: 60 }, 'set_color a LUT of the project');
  lum = v1().effects.find((e) => e.type === 'color.basic');
  check(lum.params.lut === cube.id && lum.params.lutIntensity === 60, 'the LUT at 60 %');
  r = await K.call('get_project', {}, x.env);
  check(r.value.luts.some((l) => l.id === cube.id && l.name === 'Warm'), 'get_project lists the project\'s LUTs');
  await refused('set_color', { clip_id: v1().id, lut: 'lut-0000000000000000' }, /a LUT the project has \(get_project lists luts: lut-/, 'a LUT the project does not have');
  await refused('set_color', { clip_id: v1().id, curves: { red: [0, 0, 2, 1] } }, /curves.red must be a flat list/, 'a curve point outside 0..1');
  await refused('set_color', { clip_id: v1().id, hsl: { hue: 400 } }, /hsl.hue 400 is outside 0 to 360/, 'a hue outside 0..360');

  // audio: effect parameters and their keyframes, the mixer, Essential Sound
  r = await one('add_effect', { clip_id: a1().id, type: 'audio.compressor', params: { ratio: 4 } }, 'an audio effect');
  await one('set_keyframes', { clip_id: a1().id, property: `effects.${r.value.effect}.threshold`, keyframes: [{ time: 0, value: -30 }, { time: 2, value: -12 }] }, 'an audio effect parameter animated');
  await one('set_effect', { clip_id: a1().id, effect_id: r.value.effect, params: { ratio: 8, attack: 20 } }, 'an audio effect\'s parameters');
  check(a1().effects.find((e) => e.id === r.value.effect).params.ratio === 8 && a1().keyframes[`effects.${r.value.effect}.threshold`].length === 2, 'ratio 8 and the threshold animated');
  await one('set_track', { track_id: 'A1', volume: -4.5, pan: -30, solo: true }, 'the mixer: A1 volume, pan, solo');
  await one('set_sequence', { master_gain: -1.5 }, 'the mixer\'s master');
  check(x.seq().tracks.find((t) => t.id === 'A1').pan === -30 && x.seq().masterGain === -1.5, 'A1 pan -30 and master -1.5 dB');
  r = await one('essential_sound', { clip_ids: [v1().id], action: 'clarity' }, 'Essential Sound clarity on a video clip goes to its linked audio');
  check(S(r.value.clips) === S([a1().id]) && a1().effects.some((e) => e.type === 'audio.eq') && x.h.list().filter((s2) => s2.done).at(-1).label === 'Clarity', 'an EQ and a compressor on A1, one Clarity step');
  await one('essential_sound', { clip_ids: [a1().id], action: 'reduce_hum_60' }, 'reduce hum 60 Hz');
  check(a1().effects.some((e) => e.type === 'audio.dehum' && e.params.frequency === '60'), 'a 60 Hz hum remover');
  await refused('essential_sound', { clip_ids: [x.on('V2')[0].id], action: 'noise_gate' }, /has no sound/, 'a picture has no sound');
  await one('set_clip', { clip_id: a1().id, role: 'dialogue', label: 'mango', linked: false }, 'set_clip role (the audio type) and a label');
  check(a1().role === 'dialogue' && a1().label === 'mango', 'dialogue, mango');

  // speed, trims, text, mattes
  const span = v1().out - v1().in;
  await one('set_speed', { clip_id: v1().id, duration: 5, ripple: false }, 'set_speed by duration');
  check(model.clipDuration(v1()) === 5 * T && Math.abs(v1().speed - span / (5 * T)) < 1e-9, `the same source fills 5 s (${Math.round(v1().speed * 100)} %)`);
  const in0 = v1().in;
  await one('trim_clip', { clip_id: v1().id, mode: 'slip', delta: 1 }, 'slip');
  check(Math.abs(v1().in - (in0 + v1().speed * T)) < 2 && v1().start === 0 && model.clipDuration(v1()) === 5 * T, 'slip shows the source one timeline second later, in place');
  await refused('trim_clip', { clip_id: v1().id, mode: 'slip', edge: 'end', delta: 1 }, /takes delta \(seconds\) and no edge/, 'slip with an edge');
  await refused('trim_clip', { clip_id: v1().id, delta: 1 }, /needs edge/, 'a trim without an edge');
  await one('trim_clip', { clip_id: v1().id, edge: 'end', mode: 'stretch', delta: 5 }, 'rate stretch');
  check(model.clipDuration(v1()) === 10 * T && Math.abs(v1().speed - span / (10 * T)) < 1e-9, 'stretched to 10 s, the speed halved');
  r = await one('add_color_matte', { at: 1, duration: 2, color: '#FF0000' }, 'add_color_matte');
  const matte = x.seq().clips.find((c) => c.id === r.value.clip);
  check(matte.source.generator === 'solid' && matte.source.color === '#ff0000' && model.clipDuration(matte) === 2 * T, 'a 2 s red matte');
  await one('set_clip', { clip_id: matte.id, color: '#00ff00', interpolation: 'blend' }, 'set_clip a matte\'s color');
  check(x.seq().clips.find((c) => c.id === matte.id).source.color === '#00ff00', 'the matte is green');
  await refused('set_clip', { clip_id: v1().id, color: '#00ff00' }, /color is for color mattes/, 'a color on a video clip');
  const title = x.seq().clips.find((c) => c.source?.generator === 'text');
  await one('set_text', { clip_id: title.id, italic: true, align: 'left', stroke: { color: '#000000', width: 6 }, shadow: { color: '#00000099', blur: 10 } }, 'set_text style: italic, left, stroke, shadow');
  const l1 = x.seq().clips.find((c) => c.id === title.id).source.layers[0];
  check(l1.italic && l1.align === 'left' && l1.stroke.width === 6 && l1.shadow.blur === 10, 'the title has its outline and shadow');
  r = await one('set_text', { clip_id: title.id, add_layer: true, text: '부제', size: 48, position: [0, 200] }, 'set_text adds a layer');
  const layer = r.value.layer;
  check(x.seq().clips.find((c) => c.id === title.id).source.layers.length === 2 && layer, 'two layers');
  await one('set_text', { clip_id: title.id, layer_id: layer, animation: 'rise' }, 'a motion preset on the new layer');
  check(x.seq().clips.find((c) => c.id === title.id).keyframes[`layers.${layer}.position`]?.length === 2, 'rise: the layer\'s position keyframes');
  await one('set_keyframes', { clip_id: title.id, property: `layers.${layer}.reveal`, keyframes: [{ time: 6, value: 0 }, { time: 7, value: 1 }] }, 'a layer\'s reveal keyframes');
  await one('set_text', { clip_id: title.id, layer_id: layer, remove_layer: true }, 'set_text removes the layer');
  const tnow = x.seq().clips.find((c) => c.id === title.id);
  check(tnow.source.layers.length === 1 && !Object.keys(tnow.keyframes).some((k) => k.includes(`.${layer}.`)), 'one layer, its keyframes gone');

  // tracks, transitions, caption tracks
  r = await one('add_track', { kind: 'audio', name: 'Music' }, 'add_track');
  const music = r.value.track;
  check(x.seq().tracks.find((t) => t.id === music)?.name === 'Music', `${music} named Music`);
  await one('remove_track', { track_id: music }, 'remove_track');
  await refused('remove_track', { track_id: 'A2' }, /A2 is locked/, 'removing a locked track');
  await one('razor', { at: 5 }, 'a cut to put a transition on');
  r = await one('add_transition', { track: 'V1', at: 5 }, 'add_transition');
  await one('set_transition', { transition_id: r.value.transition, duration: 0.5, align: 'end' }, 'set_transition');
  const tr1 = x.seq().transitions.find((t) => t.id === r.value.transition);
  check(tr1.duration === 0.5 * T && tr1.align === 'end', 'half a second, at the end of the edit');
  r = await one('add_captions', { name: '자막', items: [{ start: 0, end: 1, text: '하나' }] }, 'a caption track');
  const shown = [];
  await one('set_caption_track', { track_id: r.value.track, name: 'Korean', style: { size: 64, position: 'top', highlight: true, highlight_mode: 'box', background: null, speakers: 'name' }, shown: true }, 'set_caption_track: name and Caption Style', { ...x.env, services: { ...x.env.services, showCaptionTrack: (s2, id) => shown.push(id) } });
  const ct = x.seq().captions.find((t) => t.id === r.value.track);
  check(ct.name === 'Korean' && ct.style.size === 64 && ct.style.position === 'top' && ct.style.highlightMode === 'box' && ct.style.speakerName === true && ct.style.speakerColor === false && S(shown) === S([ct.id]), 'the style is set and the track is shown');

  // the project: sequences, bins, media, settings
  r = await one('add_sequence', { name: '세로', preset: 'shorts', fps: '25' }, 'add_sequence');
  check(r.value.width === 1080 && r.value.height === 1920 && r.value.fps === 25 && x.app.sequenceId === r.value.sequence, 'a 1080x1920 25 fps sequence, now active');
  const vert = r.value.sequence;
  await one('set_sequence', { sequence_id: vert, width: 720, height: 1280, fps: '30', name: '세로 2' }, 'set_sequence size and rate');
  check(x.app.project.sequences.find((s2) => s2.id === vert).w === 720 && x.app.project.sequences.find((s2) => s2.id === vert).fps[0] === 30, '720x1280 at 30 fps');
  r = await K.call('set_sequence', { sequence_id: x.app.project.sequences[0].id, active: true }, x.env);
  check(r.ok && x.app.sequenceId === x.app.project.sequences[0].id && !r.edit, 'set_sequence active brings it to the front (no undo step)');
  await refused('set_sequence', { width: 721 }, /width must be even/, 'an odd width');
  await one('remove_sequence', { sequence_id: vert }, 'remove_sequence');
  await refused('remove_sequence', { sequence_id: x.app.project.sequences[0].id }, /only sequence/, 'the last sequence stays');
  r = await one('project_items', { action: 'new_bin', name: '소리' }, 'a bin');
  const bin = r.value.bin;
  await one('project_items', { action: 'move', item_ids: [m3], bin_id: bin }, 'media into the bin');
  await one('project_items', { action: 'rename', item_id: m3, name: 'room tone.wav' }, 'rename media');
  r = await K.call('get_media', {}, x.env);
  check(r.value.find((m) => m.id === m3)?.bin === bin && r.value.find((m) => m.id === m3)?.name === 'room tone.wav', 'get_media shows the bin and the name');
  await refused('remove_media', { media_ids: [x.m1] }, /used by \d+ clips; delete them first \(the file itself is never deleted\)/, 'removing media that clips use');
  r = await one('remove_media', { unused: true }, 'remove_media unused (Remove Unused)');
  check(S(r.value.removed) === S([m3]) && /files stay on the disk/.test(r.value.note), 'only the unused media went, from the project only');
  await one('project_items', { action: 'remove_bin', bin_id: bin }, 'remove_bin');
  await one('set_project_settings', { still_duration: 3, transition_duration: 0.5, speech_terms: ['Nano Studio', '  Cut ', 'Cut'] }, 'set_project_settings');
  check(x.app.project.settings.stillDuration === 3 * T && S(x.app.project.settings.speechTerms) === S(['Nano Studio', 'Cut']), 'still length 3 s, the word list cleaned');

  // Highlights to Shorts
  r = await one('create_shorts', { ranges: [{ from: 6, to: 8 }, { from: 1, to: 2 }], name: 'Shorts' }, 'create_shorts');
  const shorts = x.app.project.sequences.find((s2) => s2.id === r.value.sequence);
  check(shorts.w === 1080 && shorts.h === 1920 && r.value.duration === 3 && x.app.sequenceId === shorts.id && r.edit.seqId === shorts.id, 'a 3 s 9:16 sequence of the two parts, now in front');
  await refused('create_shorts', { sequence_id: x.app.project.sequences[0].id, ranges: [{ from: 1, to: 3 }, { from: 2, to: 4 }] }, /overlap/, 'overlapping ranges');
  x.app.setSequence(x.app.project.sequences[0].id);

  // speakers
  r = await K.call('speakers', {}, x.env);
  check(r.ok && r.value.speakers.length === 0 && /label_speakers/.test(r.value.note), 'no speakers yet');
  await refused('speakers', { action: 'rename', speaker_id: 'sp1', name: '민수' }, /no speaker labels yet/, 'renaming before labels');
  x.h.do(C.setSpeakers({ list: [{ id: 'sp1', name: '', color: '#e5484d' }, { id: 'sp2', name: '', color: '#3e63dd' }], turns: {}, count: 2 }));
  await one('speakers', { action: 'rename', speaker_id: 'sp2', name: ' 민수 ' }, 'rename a speaker');
  check(x.app.project.speakers.list[1].name === '민수', 'speaker 2 is 민수');

  while (x.h.canUndo && x.h.serialize() !== json0) x.h.undo();
  check(x.h.serialize() === json0, 'undoing the steps brings back the exact JSON');
});

// ---------- the page's services, stood in ----------
await section('services', async () => {
  const x = fresh();
  const calls = [];
  const svc = (more) => ({ ...x.env, services: { ...x.env.services, ...more } });
  const refused = async (name, args, re, label, env) => {
    const before = x.h.serialize();
    const r = await K.call(name, args, env);
    check(!r.ok && re.test(r.error || '') && x.h.serialize() === before, `${label}${r.ok ? ': accepted' : ` (${r.error})`}`);
  };
  // import
  const importer = svc({ importMedia: async (q) => { calls.push(q); if (q.paths?.[0]?.includes('no')) return { declined: true }; const ids = x.h.do(C.importMedia([{ path: q.paths?.[0] || 'C:/p/x.mp4', name: 'x.mp4', kind: 'video', size: 1, mtime: 1, duration: T, video: { w: 64, h: 64, fps: 30 }, audio: null }])).ids; return { ok: true, ids, failed: [] }; } });
  let r = await K.call('import_media', { paths: ['C:\\Users\\me\\Videos\\a.mp4'] }, importer);
  check(r.ok && r.value.media[0].name === 'x.mp4' && calls.at(-1).paths[0] === 'C:\\Users\\me\\Videos\\a.mp4', 'import_media hands the paths to the page (which confirms them) and names what came in');
  await refused('import_media', { paths: ['\\\\nas\\share\\a.mp4'] }, /network share/, 'a network share', importer);
  await refused('import_media', { paths: ['videos\\a.mp4'] }, /not an absolute file path/, 'a relative path', importer);
  await refused('import_media', { paths: ['C:\\Users\\me\\..\\..\\Windows\\a.mp4'] }, /not an absolute file path/, 'a path that climbs with ..', importer);
  await refused('import_media', { paths: ['C:\\no\\b.mp4'] }, /did not confirm these files. Nothing was imported/, 'files the user does not confirm', importer);
  await refused('import_media', { paths: ['C:\\a.mp4'], folder: true }, /paths or folder/, 'paths and folder at once', importer);
  // save
  await refused('save_project', {}, /did not pick a place/, 'a save the user cancels', svc({ save: async () => ({ declined: true }) }));
  r = await K.call('save_project', {}, svc({ save: async () => ({ ok: true, name: 'film.ncut' }) }));
  check(r.ok && r.value.saved === 'film.ncut' && !/[\\/]/.test(S(r.value)), 'save_project says the file name, never a path');
  // frame and caption exports
  await refused('export_frame', { time: 1 }, /said no/, 'a frame export the user declines', svc({ exportFrame: async () => ({ ok: false, declined: true }) }));
  await refused('export_frame', { file_name: 'C:\\x' }, /plain name/, 'a frame file name with a folder', svc({ exportFrame: async () => ({ ok: true }) }));
  let asked = null;
  r = await K.call('export_frame', { time: 2, file_name: 'thumb' }, svc({ exportFrame: async (q) => { asked = q; return { ok: true, name: 'thumb.png' }; } }));
  check(r.ok && asked.t === 2 * T && asked.fileName === 'thumb', 'export_frame asks for the frame at 2 s');
  x.h.do(C.addCaptionTrack(x.seq().id, { name: 'ko', lang: 'ko', items: [{ start: 0, end: T, text: '하나' }] }));
  r = await K.call('export_captions', { format: 'vtt' }, svc({ exportCaptions: async (q) => { asked = q; return { ok: true, name: 'a.vtt', count: 1 }; } }));
  check(r.ok && asked.format === 'vtt' && r.value.captions === 1, 'export_captions as VTT');
  // export with options and waiting
  r = await K.call('export_sequence', { preset: 'youtube-1080p', width: 1280, height: 720, codec: 'hevc', bitrate: 8, audio_bitrate: 160, loudness: null, wait: true }, { ...svc({ exportAsk: async (q) => { asked = q; return { ok: true, name: 'a.mp4', job: 7 }; }, exportWait: async (id, o) => { calls.push(['wait', id]); o.progress(0.5); return { ok: true }; } }), progress: (f) => calls.push(['progress', f]) });
  check(r.ok && r.value.done && asked.settings.width === 1280 && asked.settings.video.family === 'hevc' && asked.settings.video.bitrate === 8e6 && asked.settings.audio.bitrate === 160000 && asked.settings.loudness === null, 'export_sequence with Export Settings overrides, waited for');
  check(calls.some((c2) => c2[0] === 'wait' && c2[1] === 7) && calls.some((c2) => c2[0] === 'progress' && c2[1] === 0.5), 'the wait follows job 7 and reports its progress');
  await refused('export_sequence', { preset: 'audio-m4a', width: 1280 }, /has no picture/, 'a picture size for audio only', svc({ exportAsk: async () => ({ ok: true }) }));
  await refused('export_sequence', { preset: '720p', audio_bitrate: 96 }, /audio_bitrate must be one of 128, 160, 192/, 'an audio bitrate the encoder does not take', svc({ exportAsk: async () => ({ ok: true }) }));
  await refused('export_sequence', { preset: '720p', wait: true }, /was cancelled/, 'an export stopped while waiting', svc({ exportAsk: async () => ({ ok: true, name: 'b.mp4', job: 8 }), exportWait: async () => ({ ok: false, cancelled: true }) }));
  // the export queue
  const jobs = [{ id: 1, name: 'a.mp4', state: 'running', fraction: 0.4 }, { id: 2, name: 'b.mp4', state: 'done', fraction: 1 }];
  const q = { jobs: () => jobs, cancel: (id) => { calls.push(['cancel', id]); return true; }, retry: () => true, remove: () => true, clearFinished: () => calls.push(['clear']) };
  r = await K.call('export_queue', {}, svc({ queue: q }));
  check(r.ok && r.value.jobs.length === 2 && r.value.jobs[0].progress === 0.4 && !S(r.value).includes('\\'), 'export_queue lists the jobs, names only');
  r = await K.call('export_queue', { action: 'cancel', job_id: 1 }, svc({ queue: q }));
  check(r.ok && calls.some((c2) => c2[0] === 'cancel' && c2[1] === 1), 'export_queue cancels a running job');
  await refused('export_queue', { action: 'retry', job_id: 1 }, /cannot be retried/, 'retrying a running job', svc({ queue: q }));
  await refused('export_queue', { action: 'cancel', job_id: 9 }, /no job 9/, 'a job that is not there', svc({ queue: q }));
  // proxies
  const P = { state: () => ({ proxy: 'none' }), create: (ids2) => { calls.push(['proxy', ids2]); return ids2.length; }, wait: async (ids2, o) => { o.progress?.(0.25); return o.signal?.aborted ? { cancelled: true, done: 0 } : { done: ids2.length }; } };
  r = await K.call('proxies', { action: 'create' }, svc({ proxies: P }));
  check(r.ok && calls.some((c2) => c2[0] === 'proxy' && c2[1].includes(x.m1) && !c2[1].includes(x.m2)), 'proxies create makes one of the video media and waits');
  const stopped = new AbortController();
  stopped.abort();
  await refused('proxies', { action: 'create', media_ids: [x.m1] }, /Stopped: the proxies not done yet were cancelled/, 'Stop during proxies', { ...svc({ proxies: P }), signal: stopped.signal });
  await refused('proxies', { action: 'create', media_ids: [x.m2] }, /proxies are for video media/, 'a proxy of a picture', svc({ proxies: P }));
  await refused('proxies', { action: 'remove' }, /None of these has a proxy/, 'removing proxies there are none of', svc({ proxies: P }));
  // automation
  const auto = (answer) => svc({ automation: async (action, a, o) => { calls.push(['auto', action, a, !!o.signal]); return typeof answer === 'function' ? answer(action, a, o) : answer; } });
  await refused('automation', { action: 'detect_scenes', every: 'bar' }, /detect_scenes takes clip_ids, threshold, mode; not every/, 'an argument of another job', auto({ ok: true }));
  await refused('automation', { action: 'detect_scenes', clip_ids: [x.on('A1')[0].id] }, /not a video clip of a media file/, 'scenes of an audio clip', auto({ ok: true }));
  await refused('automation', { action: 'auto_duck', threshold: 35 }, /-90\.\.-5 \(dB\)/, 'a duck threshold in %', auto({ ok: true }));
  await refused('automation', { action: 'transcribe', from: 1 }, /from and to together/, 'a range without its end', auto({ ok: true }));
  await refused('automation', { action: 'auto_captions' }, /did not agree to set up speech recognition \(Whisper\).*nothing was downloaded/, 'the user declines the model download', auto({ declined: true }));
  await refused('automation', { action: 'isolate_voice', clip_ids: [x.on('A1')[0].id] }, /was stopped. Nothing was changed/, 'a job stopped', auto({ cancelled: true }));
  await refused('automation', { action: 'detect_beats', clip_ids: [x.on('A1')[0].id] }, /No beats were found/, 'a job that found nothing says the editor\'s words', auto({ ok: false, error: 'No beats were found.' }));
  const ctl = new AbortController();
  r = await K.call('automation', { action: 'remove_fillers', from: 1, to: 9, pause_length: 0.8 }, { ...auto((action, a) => { x.h.do(C.extract(x.seq().id, 2 * T, 3 * T, ['V1', 'A1'])); return { ok: true, changed: true, at: 2 * T, value: { job: action, cuts: 1, seconds: 1, range: a.range.map((t) => t / T) } }; }), signal: ctl.signal });
  check(r.ok && r.value.cuts === 1 && S(r.value.range) === S([1, 9]) && r.edit?.at === 2 * T && calls.at(-1)[3] === true, 'a job runs with its range and the Stop signal, and its edit lands');
});

// ---------- every feature has an AI path (control-actions.js INVENTORY) ----------
const cutFile = (f) => readFileSync(new URL(`../renderer/features/cut/${f}`, import.meta.url), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); return i < 0 ? '' : text.slice(i, text.indexOf(b, i + a.length)); };
// What Cut has, read from its sources: keyboard actions, Automation items, menu items, panels, edit commands.
function features({ keys = cutFile('ui-keys.js'), auto = cutFile('ui-auto.js'), menu = cutFile('ui-menubar.js'), panels = readdirSync(new URL('../renderer/features/cut/', import.meta.url)).filter((f) => /^ui-.*\.js$/.test(f)).map(cutFile).join('\n'), commands = Object.keys(C).filter((k) => typeof C[k] === 'function' && !['createHistory', 'label'].includes(k)) } = {}) {
  return {
    keys: [...between(keys, 'const ACTIONS = [', '\n  ];').matchAll(/^\s*\['([\w.]+)', '/gm)].map((m) => m[1]),
    automation: [...between(auto, 'const ITEMS = [', '\n  ];').matchAll(/\['(\w+)', '/g)].map((m) => m[1]),
    menu: [...new Set([...between(menu, 'const MENUS = [', '\n  let bar').matchAll(/label: tr\('([^']+)'\)/g)].map((m) => m[1]))],
    panels: [...new Set([...panels.matchAll(/registerPanel\('(\w+)'/g)].map((m) => m[1]))],
    commands,
  };
}
// The features with no inventory entry: ["keys:<id>", ...].
const uncovered = (f) => Object.entries(f).flatMap(([kind, list]) => list.filter((id) => !Object.hasOwn(K.lib.inventory[kind], id)).map((id) => `${kind}:${id}`));
await section('inventory', async () => {
  const inv = K.lib.inventory;
  const f = features();
  check(f.keys.length >= 116 && f.automation.length >= 19 && f.menu.length >= 30 && f.panels.length >= 20 && f.commands.length >= 69, `the sources were read (${f.keys.length} keyboard actions, ${f.automation.length} Automation items, ${f.menu.length} menu items, ${f.panels.length} panels, ${f.commands.length} edit commands)`);
  eq(uncovered(f), [], 'every keyboard action, Automation item, menu item, panel and edit command has an AI path or a reason it is not for AI');
  eq(f.keys.filter((id) => inv.keys[id]?.act && !K.lib.actions.has(id)), [], 'every action marked runnable is in run_action');
  eq(Object.keys(inv.keys).filter((id) => !f.keys.includes(id)), [], 'no entry for a keyboard action that is gone');
  eq(Object.keys(inv.automation).filter((id) => !f.automation.includes(id)), [], 'no entry for an Automation item that is gone');
  eq(Object.keys(inv.commands).filter((id) => !f.commands.includes(id)), [], 'no entry for an edit command that is gone');
  const names = new Set(K.names());
  const entries = Object.entries(inv).flatMap(([kind, o]) => Object.entries(o).map(([id, e]) => [`${kind}:${id}`, e]));
  eq(entries.filter(([, e]) => !e.no && !e.act && !e.tools?.length).map(([k]) => k), [], 'each entry names tools, is a run_action action, or says why not');
  eq(entries.flatMap(([k, e]) => (e.tools || []).filter((t) => !names.has(t)).map((t) => `${k}:${t}`)), [], 'every tool an entry names exists');
  eq(entries.filter(([, e]) => e.no && !/^[A-Z].{15,}[.)]$/.test(e.no)).map(([k]) => k), [], 'every "not for AI" reason is a sentence');
  // a new feature without an entry fails the check
  const fake = features({
    keys: cutFile('ui-keys.js').replace('const ACTIONS = [', "const ACTIONS = [\n    ['fakeAction', 'Fake Action', []],"),
    auto: cutFile('ui-auto.js').replace('const ITEMS = [', "const ITEMS = [\n    ['fakeJob', 'Fake Job…', () => {}],"),
    menu: cutFile('ui-menubar.js').replace("{ label: tr('Import Folder…'),", "{ label: tr('Fake Item…'), run: () => {} },\n      { label: tr('Import Folder…'),"),
    panels: `${features().panels.map((id) => `registerPanel('${id}'`).join('\n')}\nregisterPanel('fakePanel', {})`,
    commands: [...f.commands, 'fakeCommand'],
  });
  eq(uncovered(fake), ['keys:fakeAction', 'automation:fakeJob', 'menu:Fake Item…', 'panels:fakePanel', 'commands:fakeCommand'], 'a keyboard action, Automation item, menu item, panel or command added without an entry fails the check');
  const doc = readFileSync(new URL('../docs/cut-ai-control.md', import.meta.url), 'utf8');
  eq(entries.map(([k]) => k).filter((k) => !doc.includes(`| \`${k.replace(/^\w+:/, '')}\` |`)), [], 'docs/cut-ai-control.md has the inventory (node verify/cut-control-core.mjs --inventory)');
});

// ---------- list_actions and run_action ----------
await section('run_action', async () => {
  const x = fresh();
  const ran = [];
  let said = [];
  const action = async (id, o) => {
    ran.push([id, o.panel]);
    const seq = x.seq();
    if (id === 'rippleDelete') x.h.do(C.remove(seq.id, [...x.app.selection], { ripple: true }));
    if (id === 'markIn') x.app.setInOut({ in: x.app.t });
    if (id === 'split') said = ['The playhead is not on a clip.'];
    return { ran: true, toasts: said };
  };
  const env = { ...x.env, services: { ...x.env.services, action } };
  const refused = async (args, re, label) => {
    const before = x.h.serialize();
    const n = ran.length;
    const r = await K.call('run_action', args, env);
    check(!r.ok && re.test(r.error || '') && x.h.serialize() === before && ran.length === n, `${label}${r.ok ? ': accepted' : ` (${r.error})`}`);
  };
  let r = await K.call('list_actions', {}, env);
  const listed = r.value.actions.map((a) => a.id);
  check(r.ok && listed.length === K.lib.actions.size && listed.includes('rippleStart') && listed.includes('window.mixer') && !listed.includes('save') && !listed.includes('open'), `list_actions lists the ${listed.length} runnable actions (not the ones with tools or not for AI)`);
  check(r.value.actions.find((a) => a.id === 'rippleDelete')?.needs === 'selected clips (select_clips or clip_ids)' && r.value.actions.find((a) => a.id === 'zoomIn')?.view === true, 'each says what it needs and whether it only changes the view');
  r = await K.call('list_actions', { search: 'marker' }, env);
  check(r.value.actions.length >= 4 && r.value.actions.every((a) => /marker/i.test(`${a.id} ${a.what}`)), 'search narrows the list');
  await refused({ id: 'save' }, /save has its own tool: save_project/, 'an action with a tool of its own');
  await refused({ id: 'open' }, /open is not for AI: It closes this project/, 'an action not for AI says why');
  await refused({ id: 'teleport' }, /no action teleport. list_actions/, 'an action that does not exist');
  await refused({ id: 'rippleDelete' }, /rippleDelete needs selected clips.*Nothing was changed/, 'an action whose selection is missing is refused before it runs');
  await refused({ id: 'goIn' }, /goIn needs a sequence In point/, 'Go to In without an In');
  await refused({ id: 'rippleStart', time: 14 }, /14 s is outside the sequence/, 'a time outside the sequence');
  const steps = x.h.list().filter((s) => s.done).length;
  const v2 = x.on('V2')[0].id;
  r = await K.call('run_action', { id: 'rippleDelete', clip_ids: [v2] }, env);
  check(r.ok && r.value.changed.undoStep && x.h.list().filter((s) => s.done).length === steps + 1 && !x.seq().clips.some((c) => c.id === v2) && r.edit, `rippleDelete with clip_ids selects, runs and reports the undo step (${r.value?.changed?.undoStep})`);
  check(S(ran.at(-1)) === S(['rippleDelete', 'timeline']), 'the action went to the timeline, as a key does');
  r = await K.call('run_action', { id: 'markIn', time: 2 }, env);
  check(r.ok && r.value.changed.inOut.in === 2 && r.value.playhead === 2 && !r.value.changed.undoStep && !r.edit, 'markIn at 2 s reports the In and the playhead, no undo step');
  r = await K.call('run_action', { id: 'goIn' }, env);
  check(r.ok, 'Go to In runs once there is an In');
  const before = x.h.serialize();
  r = await K.call('run_action', { id: 'split' }, env);
  check(!r.ok && /split changed nothing; the editor said: The playhead is not on a clip\./.test(r.error) && x.h.serialize() === before, `an action that did nothing says why, in the editor's words (${r.error})`);
  said = [];
  r = await K.call('run_action', { id: 'zoomIn' }, env);
  check(r.ok && S(r.value.changed) === '{}', 'a view action that ran is fine with nothing to report');
  r = await K.call('run_action', { id: 'window.mixer' }, env);
  check(r.ok && ran.at(-1)[0] === 'window.mixer', 'window.<panel> opens a panel');
});

// ---------- the chat's step lines are translated ----------
await section('step lines', () => {
  const ko = JSON.parse(cutFile('locales/ko.json'));
  const dummy = (p) => {
    const t = [].concat(p.type || 'string')[0];
    if (p.enum) return p.enum[0];
    return t === 'number' || t === 'integer' ? 1 : t === 'array' ? ['c1'] : t === 'boolean' ? true : t === 'object' ? {} : 'x';
  };
  const lines = new Set();
  for (const t of K.TOOLS) {
    lines.add(t.title);
    const props = t.input.properties || {};
    const base = Object.fromEntries((t.input.required || []).map((k) => [k, dummy(props[k])]));
    const variants = [base];
    for (const [k, p] of Object.entries(props)) {
      if (p.enum && typeof p.enum[0] === 'string') for (const v of p.enum) variants.push({ ...base, [k]: v });
      else if (['duration', 'ripple', 'whole_track', 'paths', 'remove_layer'].includes(k)) variants.push({ ...base, [k]: dummy(p) });
    }
    for (const v of variants) lines.add(K.describe(t.name, v)[0]);
  }
  eq([...lines].filter((l) => !Object.hasOwn(ko, l)), [], `every tool's title and step line (${lines.size}) has Korean in renderer/features/cut/locales/ko.json`);
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
  await refused('add_effect', { clip_id: v1.id, type: 'color.basic', params: { lut: 'lut-1' } }, /a LUT the project has.*Loading a LUT file is the user's/, 'a LUT the project does not have (loading a file) is refused');
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
  for (const file of ['control.js', 'control-project.js', 'control-auto.js', 'control-actions.js']) {
    const src = readFileSync(new URL(`../renderer/features/cut/${file}`, import.meta.url), 'utf8');
    check(!/require\(['"](fs|child_process|path|os|net|http)['"]\)|ide\.api|invoke\(|fetch\(|XMLHttpRequest|new Function|eval\(/.test(src), `${file} has no file, process, network or IPC call in it`);
  }
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
    check(r.json.result.tools.length === K.TOOLS.length + 1 && r.json.result.tools.every((t) => t.inputSchema?.type === 'object'), 'tools/list: every tool with its schema');
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

// ---------- graphic clips (graphic.js, control-graphic.js) ----------
await section('graphic', async () => {
  const graphic = require('../renderer/features/cut/graphic.js');
  const x = fresh();
  const call = (name, args) => K.call(name, args, x.env);
  const LAYERS = [
    { id: 'bg', kind: 'rect', size: [500, 120], radius: 16, fill: '#102040cc', position: [0, 120] },
    { id: 'grp', kind: 'group', position: [-200, 0] },
    { id: 'bar', kind: 'rect', parent: 'grp', size: [80, 200], fill: '#ff8800', anchor: [0, 100], repeatCount: 4, repeatOffset: [110, 0] },
    { id: 'wave', kind: 'path', d: 'M -250 0 C -150 -80 -50 80 50 0 S 200 -60 250 0', stroke: '#ffffff', strokeWidth: 6, trimEnd: 0 },
    { id: 'num', kind: 'text', text: '{value}%', value: 0, fontSize: 64, position: [0, 120] },
    { id: 'spark', kind: 'particles', count: 40, emitter: [600, 0], direction: 180, spread: 30, speed: 120, gravity: [0, 80], life: 1.5, fill: '#ffee88', fillEnd: '#ff4400' },
    { kind: 'star', points: 5, radius: 40, innerRadius: 18, fill: '#ffd700', position: [260, -120] },
  ];
  const before = x.h.serialize();
  let r = await call('add_graphic', { at: 1, duration: 3, name: 'Chart', layers: LAYERS });
  const gid = r.value?.clip;
  const clip = () => x.seq().clips.find((c) => c.id === gid);
  check(r.ok && clip()?.source.generator === 'graphic' && S(r.value.layers) === S(['bg', 'grp', 'bar', 'wave', 'num', 'spark', 'g1']) && model.validate(x.app.project).ok, `add_graphic: a graphic clip with the layers in order; an id is given where none was (${S(r.value?.layers || r.error)})`);
  check(x.h.list().filter((s) => s.done).at(-1).label === 'Add Graphic' && secs(clip()).join() === '1,4', 'one undo step, 1 s to 4 s on a free track');
  const id = gid;
  const refusals = [
    [{ kind: 'path', d: 'M0 0 A 5 5 0 0 1 10 10' }, /arcs/],
    [{ kind: 'rect', d: 'M0 0' }, /\(rect\) has no field d/],
    [{ kind: 'ellipse', parent: 'nope' }, /parent nope must be a group earlier/],
    [{ kind: 'rect', fill: 'red' }, /fill must be a color/],
    [{ kind: 'line', strokeWidth: -1 }, /strokeWidth must be a number from 0/],
  ];
  for (const [layer, re] of refusals) {
    r = await call('add_graphic', { at: 0, layers: [layer] });
    check(!r.ok && re.test(r.error), `refused: ${S(layer)} (${r.error})`);
  }
  check(x.h.list().filter((s) => s.done).length === JSON.parse(before).done?.length || x.seq().clips.filter((c) => c.source?.generator === 'graphic').length === 1, 'a refused graphic adds nothing');

  r = await call('get_clip', { clip_id: id });
  const bar = r.value.layers.find((l) => l.id === 'bar');
  check(r.ok && r.value.layers.length === 7 && bar.parent === 'grp' && bar.repeatCount === 4 && bar.cap === undefined, `get_clip shows each layer's fields that differ from the defaults (${S(bar)})`);

  r = await call('set_keyframes', { clip_id: id, property: 'layers.wave.trimEnd', keyframes: [{ time: 1, value: 0, ease: 'easeOut' }, { time: 3, value: 100 }] });
  check(r.ok, `set_keyframes animates a graphic layer's field (${r.error || ''})`);
  r = await call('set_keyframes', { clip_id: id, property: 'layers.num.value', keyframes: [{ time: 1, value: 0 }, { time: 2, value: 75 }] });
  check(r.ok, 'a counter: value keyframed');
  r = await call('set_keyframes', { clip_id: id, property: 'layers.bg.fill', keyframes: [{ time: 1, value: '#000000' }, { time: 2, value: '#ffffff' }] });
  check(r.ok, 'a color field animates');
  r = await call('set_keyframes', { clip_id: id, property: 'layers.wave.d', keyframes: [{ time: 1, value: 'M0 0' }] });
  check(!r.ok && /path layer animates .*trimEnd.*; not d/.test(r.error), `a field that cannot animate is refused with the ones that can (${r.error})`);
  r = await call('set_keyframes', { clip_id: id, property: 'layers.bg.opacity', keyframes: [{ time: 1, value: 150 }] });
  check(!r.ok && /0 to 100/.test(r.error), `a keyframe value out of range is refused (${r.error})`);
  const at = (sec) => clip().source.layers.map((l) => graphic.resolve(l, clip(), (sec - 1) * T));
  const mid = at(2);
  check(Math.abs(mid.find((l) => l.id === 'num').value - 75) < 1e-9 && mid.find((l) => l.id === 'bg').fill === '#ffffffff' && at(1.5).find((l) => l.id === 'num').value === 37.5, 'resolve: the keyframed values at a time (75 at 2 s, 37.5 at 1.5 s, the color at its end)');
  const trim = mid.find((l) => l.id === 'wave').trimEnd;
  check(trim > 50 && trim < 100, `easeOut: the line is past half drawn at the middle (${trim.toFixed(1)}%)`);

  // drawing, with a context that records what is drawn
  const rec = () => {
    const ops = [];
    const g = new Proxy({ __alpha: 1 }, {
      get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^(create\w+Gradient)$/.test(k) ? () => ({ addColorStop: () => {} }) : (...args) => { ops.push([k, ...args.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))]); }),
      set: (o, k, v) => { o[k] = v; ops.push([`=${String(k)}`, v]); return true; },
    });
    return { g, ops };
  };
  const drawAt = (sec) => { const { g, ops } = rec(); graphic.draw(g, at(sec), { w: 640, h: 360, scale: 1, t: sec - 1 }); return ops; };
  const o1 = drawAt(1);
  const o2 = drawAt(2.5);
  check(o1.filter((o) => o[0] === 'fill').length >= 5 && o1.filter((o) => o[0] === 'fillText').length === 1, `every kind draws (fills ${o1.filter((o) => o[0] === 'fill').length}, text 1)`);
  check(!o1.some((o) => o[0] === 'stroke') && o2.some((o) => o[0] === 'stroke'), 'the wave is not drawn at trimEnd 0, and is once it grows');
  check(o1.filter((o) => o[0] === 'fillText').every((o) => o[1] === '0%') && drawAt(2).find((o) => o[0] === 'fillText')[1] === '75%', 'the counter shows its value: 0% then 75%');
  check(S(drawAt(2.2)) === S(drawAt(2.2)) && S(drawAt(2.2)) !== S(drawAt(2.3)), 'particles: the same frame draws the same, the next frame moves');
  check(o1.filter((o) => o[0] === 'fillRect' || (o[0] === 'fill')).length > 0 && o1.filter((o) => o[0] === 'translate').length >= 4 + 3, 'the repeated bars are drawn as copies (moved each time)');

  // set_graphic
  const steps = () => x.h.list().filter((s) => s.done).length;
  let n0 = steps();
  r = await call('set_graphic', { clip_id: id, update: [{ id: 'bar', fill: '#00aaff', repeatCount: 6 }], add: [{ id: 'dot', kind: 'ellipse', size: [20, 20], after: 'bg' }], remove: ['wave'] });
  const ids = clip().source.layers.map((l) => l.id);
  check(r.ok && S(ids) === S(['bg', 'dot', 'grp', 'bar', 'num', 'spark', 'g1']) && clip().source.layers.find((l) => l.id === 'bar').repeatCount === 6 && steps() === n0 + 1, `set_graphic: update, add after a layer, remove, as one step (${S(ids)}${r.error || ''})`);
  check(!Object.keys(clip().keyframes).some((k) => k.startsWith('layers.wave.')) && !!clip().keyframes['layers.num.value'], 'a removed layer\'s keyframes go with it; the others stay');
  r = await call('set_graphic', { clip_id: id, update: [{ id: 'bar', kind: 'ellipse' }] });
  check(!r.ok && /keeps its kind/.test(r.error), 'a layer keeps its kind');
  r = await call('set_graphic', { clip_id: id, remove: ['grp'] });
  check(!r.ok && /parent grp must be a group earlier/.test(r.error), `a group with children is not removed alone (${r.error})`);
  r = await call('set_graphic', { clip_id: id, layers: [{ id: 'only', kind: 'ellipse', size: [100, 100] }] });
  check(r.ok && S(clip().source.layers.map((l) => l.id)) === S(['only']) && Object.keys(clip().keyframes).every((k) => !k.startsWith('layers.')), 'layers replaces them all (and the old layers\' keyframes)');
  r = await call('set_graphic', { clip_id: x.seq().clips.find((c) => c.source?.generator === 'text').id, update: [{ id: 'x' }] });
  check(!r.ok && /not a graphic clip/.test(r.error), 'set_graphic on another clip is refused');
  x.h.undo(); x.h.undo();
  check(S(clip().source.layers.map((l) => l.id)) === S(['bg', 'grp', 'bar', 'wave', 'num', 'spark', 'g1']) && !!clip().keyframes['layers.wave.trimEnd'], 'undo brings the layers and keyframes back');

  // saved and opened
  const saved = JSON.parse(JSON.stringify(x.app.project));
  const back = model.migrate(saved);
  check(back.version === 5 && model.validate(back).ok && S(back.sequences[0].clips.find((c) => c.id === id).source) === S(clip().source), 'a project with a graphic saves and opens as it was (format version 5)');
  const broken = JSON.parse(JSON.stringify(saved));
  broken.sequences[0].clips.find((c) => c.id === id).source.layers[0].kind = 'blob';
  check(!model.validate(broken).ok && model.validate(broken).errors.some((e) => /graphic layers\[0\]\.kind/.test(e)), 'a damaged graphic fails the project check');
  check(graphic.parsePath('m 0 0 l 10 0 l 0 10 z').subpaths[0].closed && graphic.parsePath('M 0 0 X 1').error !== '', 'path data: relative commands and Z parse; junk is refused');

  // the review's cases
  r = await call('set_graphic', { clip_id: id, remove: ['grp', 'bar'] });
  check(r.ok && !clip().source.layers.some((l) => l.id === 'grp' || l.id === 'bar'), `a group goes with its children in one call (${r.error || ''})`);
  r = await call('set_graphic', { clip_id: id, add: [{ id: 'g2', kind: 'group', after: 'bg' }], update: [{ id: 'num', parent: 'g2' }] });
  check(r.ok && clip().source.layers.find((l) => l.id === 'num').parent === 'g2', `a layer moves into a group added in the same call (${r.error || ''})`);
  check(x.h.list().filter((s) => s.done).at(-1).label === 'Edit Graphic', 'set_graphic is one step named Edit Graphic');
  await call('set_keyframes', { clip_id: id, property: 'layers.g1.rotation', keyframes: [{ time: 1, value: 0 }, { time: 2, value: 90 }] });
  r = await call('set_graphic', { clip_id: id, layers: [{ kind: 'star' }, { kind: 'rect' }] });
  check(r.ok && !r.value.layers.includes('g1') && !Object.keys(clip().keyframes).some((k) => k.startsWith('layers.')), `new layers without ids never take the old ids and their keyframes (${S(r.value?.layers)})`);
  r = await call('add_graphic', { at: 0, layers: [{ kind: 'particles', count: 2000, repeatCount: 20 }] });
  check(!r.ok && /at most 20000/.test(r.error), `per-frame work is bounded (${r.error})`);
  r = await call('add_graphic', { at: 0, layers: [{ kind: 'group', blur: 4 }] });
  check(!r.ok && /\(group\) has no field blur/.test(r.error), 'a group has no blend, blur or shadow of its own');
  const ops = (layers, t = 0) => { const o = []; const g = new Proxy({ __alpha: 1 }, { get: (q, k) => (k in q ? q[k] : (...a) => o.push([k, ...a])), set: (q, k, v) => { q[k] = v; o.push([`=${String(k)}`, v]); return true; } }); graphic.draw(g, layers.map((l) => graphic.normalize(l)), { w: 640, h: 360, scale: 1, t }); return o; };
  const lineOps = ops([{ id: 'l', kind: 'line', shadowColor: '#000000', shadowBlur: 6 }]);
  check(lineOps.filter((o) => o[0] === '=shadowColor').at(-1)[1] === '#000000' && lineOps.some((o) => o[0] === 'stroke'), 'a line casts its shadow');
  const sparks = ops([{ id: 'p', kind: 'particles', count: 1, emit: 'burst', life: 2, fill: '#ffffff', fillEnd: '#ff440000', speedVariation: 0 }], 1);
  check(sparks.filter((o) => o[0] === '=fillStyle').at(-1)[1] === '#ffa28080', `particle colors with and without alpha blend (${sparks.filter((o) => o[0] === '=fillStyle').at(-1)[1]})`);
  const wrap = graphic.strokeRuns({ trimStart: 0, trimEnd: 50, trimOffset: 75 }, graphic.outline(graphic.normalize({ kind: 'rect', size: [100, 100] }), 1));
  check(wrap.length === 1 && wrap[0].pts.some((p) => p[0] === -50 && p[1] === -50), `a trim through the outline's start is one run (its corner keeps the join) (${wrap.length} runs)`);
  check(!graphic.hasParticles([graphic.normalize({ kind: 'particles', emit: 'burst', life: 1 })], 2) && graphic.hasParticles([graphic.normalize({ kind: 'particles' })], 2), 'a finished burst stops redrawing every frame; a stream does not');
  const over = graphic.resolve({ id: 'o', kind: 'rect', opacity: 50 }, { keyframes: { 'layers.o.opacity': [{ t: 0, v: 50, ease: 'bezier', h: [0.3, 1.8, 0.6, 1.4] }, { t: T, v: 100 }] } }, T / 2);
  check(over.opacity === 100, `an ease that overshoots stops at the range's edge (${over.opacity})`);
});

// ---------- long calls: jobs and wait_job ----------
await section('jobs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cut-control-'));
  const control = createControl({ configFile: path.join(dir, 'cut-control.json'), holdMs: 300 });
  try {
    const port = await control.start();
    control.setTools(K.definitions(), K.INSTRUCTIONS);
    // the page: get_state answers at once; automation runs 1.2 s and reports progress every 200 ms
    const page = [];
    control.setTarget((channel, call) => {
      page.push(call);
      if (call.name !== 'automation') { setTimeout(() => control.answer({ id: call.id, result: { content: [{ type: 'text', text: '{"ok":1}' }] } }), 5); return true; }
      let k = 0;
      const tick = setInterval(() => {
        k++;
        control.progress({ id: call.id, fraction: k / 6, text: `step ${k}` });
        if (k === 6) { clearInterval(tick); control.answer({ id: call.id, result: { content: [{ type: 'text', text: '{"captions":12}' }] } }); }
      }, 200);
      return true;
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const callAs = (tok) => (id, name, args = {}) => post(url, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { Authorization: `Bearer ${tok}` });
    const chat = control.issue('turnA', 7);
    const call = callAs(chat);
    const list = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${chat}` });
    const wait = list.json.result.tools.find((t) => t.name === 'wait_job');
    check(list.json.result.tools.length === K.TOOLS.length + 1 && list.json.result.tools.at(-1) === wait && /wait/i.test(wait.description) && wait.inputSchema.required[0] === 'job', 'tools/list ends with wait_job');
    check(control.toolNames().includes('wait_job'), 'wait_job is among the names the agent allows');
    let t0 = Date.now();
    let r = await call(2, 'get_state');
    check(r.json.result.content[0].text === '{"ok":1}' && Date.now() - t0 < 300, 'a quick call answers itself, as before');
    t0 = Date.now();
    r = await call(3, 'automation', { action: 'transcribe' });
    const run = JSON.parse(r.json.result.content[0].text);
    check(r.json.result.isError === false && run.running === true && /^job\d+$/.test(run.job) && run.tool === 'automation' && Date.now() - t0 < 700, `a long call answers within the hold that it still runs (${S(run)})`);
    check(/wait_job/.test(run.note) && /Do not start automation again/.test(run.note), 'and says to wait with wait_job, not to start it again');
    r = await call(4, 'get_state');
    check(r.json.result.isError === true && new RegExp(`${run.job} \\(automation\\) is still running`).test(r.json.result.content[0].text) && page.filter((c) => c.name === 'get_state').length === 1, `another call meanwhile is refused and never reaches the page (${r.json.result.content[0].text})`);
    const other = control.issue('turnB', 7);
    r = await callAs(other)(5, 'wait_job', { job: run.job });
    check(r.json.result.isError === true && /no running job/.test(r.json.result.content[0].text), 'another turn cannot wait for this turn\'s job');
    r = await call(6, 'wait_job', { job: run.job });
    const mid = JSON.parse(r.json.result.content[0].text);
    check(mid.running === true && mid.job === run.job && mid.progress > 0 && mid.progress < 1 && /^step \d$/.test(mid.step) && mid.elapsed_s >= 0, `wait_job while it runs: the progress and the step (${S(mid)})`);
    let last = mid;
    for (let i = 0; i < 10 && last.running; i++) {
      r = await call(7 + i, 'wait_job', { job: run.job });
      try { last = JSON.parse(r.json.result.content[0].text); } catch { last = { text: r.json.result.content[0].text }; }
    }
    check(last.captions === 12 && r.json.result.isError === false, `wait_job ends with the tool's own answer (${S(last)})`);
    r = await call(20, 'wait_job', { job: run.job });
    check(r.json.result.isError === true && /given already/.test(r.json.result.content[0].text), 'a job\'s answer is handed over once');
    r = await call(21, 'get_state');
    check(r.json.result.isError === false && control.stats().jobs === 0, 'after the job other calls run again');
    // a turn that ends drops its job; a refused long call is a refusal, not a job
    r = await call(22, 'automation', { action: 'transcribe' });
    check(JSON.parse(r.json.result.content[0].text).running === true && control.stats().jobs === 1, 'a second long call is a job');
    control.revoke(chat);
    check(control.stats().jobs === 0, 'the turn\'s end drops its job');
    await sleep(1400);
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
    check(allowed.length === K.TOOLS.length + 1 && allowed.includes('mcp__cut__wait_job') && allowed.every((a) => /^mcp__cut__[a-z_]+$/.test(a)), 'only the Cut tools and wait_job are allowed (mcp__cut__<name>)');
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
  check(['control-project.js', 'control-auto.js', 'control-graphic.js', 'control-actions.js'].every((x) => order.indexOf(x) > order.indexOf('control.js')) && order.indexOf('ui-control.js') < order.indexOf('ui-assistant.js') && order.indexOf('presets.js') < order.indexOf('control.js'), 'index.js loads the tool files after control.js, presets.js before it, ui-control.js before ui-assistant.js');
  const mine = ['time.js', 'state.js', 'captionwords.js', 'remap.js', 'model.js', 'keyframes.js', 'masks.js', 'graphic.js', 'commands.js', 'lumetri.js', 'effects.js', 'textrender.js', 'presets.js', 'audiofx.js', 'analyze.js', 'speech.js', 'ai.js', 'control.js', 'control-project.js', 'control-auto.js', 'control-graphic.js', 'control-actions.js'];
  for (const file of order.filter((x) => mine.includes(x))) vm.runInContext(readFileSync(new URL(file, dir), 'utf8'), page, { filename: file });
  const out = await vm.runInContext(`(async () => {
    const p = Cut.model.createProject({ sequence: { fps: [30, 1], w: 320, h: 180 } });
    const app = Cut.state.createApp();
    app.setHistory(Cut.commands.createHistory(p));
    const r = await Cut.control.call('add_text', { text: 'hi', at: 0, duration: 1 }, { app, services: {} });
    const m = await Cut.control.call('add_color_matte', { at: 0, duration: 1 }, { app, services: {} });
    return [r.ok, m.ok, Cut.control.definitions().length, app.project.sequences[0].clips.length];
  })()`, page);
  eq(out, [true, true, K.TOOLS.length, 2], 'control.js and its tool files work as page scripts through globalThis.Cut (every tool listed)');
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
