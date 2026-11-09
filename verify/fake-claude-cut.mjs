// A stand-in for the Claude Code CLI (`claude -p --output-format stream-json …`) with canned answers for Nano Studio
// Cut's text AI (main/cut/ai.js, renderer/features/cut/ai.js), so tests never call a model. verify/cut-ai.mjs and
// verify/cut-ai-core.mjs write a claude.cmd that runs this file and point PYIDE_CLAUDE_PATH at it.
//
// FAKE_CLAUDE_DIR holds scenario.json ({error, delayMs}) and receives log.jsonl (one line per call: task, retry, stdin,
// system, args). Answers come from the prompt alone ("Task: …" on its first line):
// - polish captions: double spaces joined, 됬 -> 됐, teh -> the, a full stop added where none ends the caption;
// - translate captions: a long sentence per caption in the target language (to exercise the line breaking);
// - YouTube metadata: chapters that need fixing (the first at 3 s, one 4 s after it, one past the end), a title over
//   100 characters, tags with # signs and a duplicate;
// - highlights: first two overlapping ranges (refused), then, asked again, non-overlapping ones;
// - edit command: by the request's words (silence, "first N seconds", music quieter, chapters, "extra field" (refused
//   once), "delete the project" (an unknown operation every time), anything else: no operations and a message).
//
// With --mcp-config (the AI assistant's turns, main/cut/agent.js) it is a scripted agent instead: it connects to the
// Cut control server that file names (MCP over HTTP, with the token it holds), lists the tools and calls them as a
// model would, printing the real CLI's stream-json events (system init, assistant text and tool_use, user
// tool_result, result). The words of the request pick the script (agent() at the end); scenario.json's `stepMs`
// waits after each call, so a test sees the timeline change while the turn runs. log.jsonl gets the start ({agent,
// start, args, request, system, prompt}) and every call ({agent, tool, args, ok, text, image}).
import fs from 'fs';
import path from 'path';

const dir = process.env.FAKE_CLAUDE_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
if (args.includes('--mcp-config')) {
  await agent();
  process.exit(0);
}
const sysFile = args[args.indexOf('--system-prompt-file') + 1];
const system = sysFile && fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : '';
const task = (stdin.match(/^Task: (.*)$/m)?.[1] || 'other').trim();
const retry = stdin.includes('Your previous answer could not be used');
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8')); } catch {}
if (dir) fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ pid: process.pid, task, retry, args, stdin, system, t: Date.now() })}\n`);

const field = (name) => stdin.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1]?.trim();
// The JSON of the line after "Captions (JSON):" (the original prompt's, before any retry text).
const captions = () => { try { return JSON.parse(stdin.split('Captions (JSON):\n')[1].split('\n')[0]); } catch { return []; } };
const fence = (v) => `Here is the result.\n\`\`\`json\n${JSON.stringify(v, null, 1)}\n\`\`\`\n`;

function polish() {
  return fence({ lines: captions().map(({ i, text }) => {
    let t = text.replace(/[ \t]{2,}/g, ' ').replace(/됬/g, '됐').replace(/\bteh\b/g, 'the');
    if (!/[.?!。]$/.test(t)) t += '.';
    return { i, text: t };
  }) });
}
const SENTENCES = {
  en: (i) => `Caption ${i} in English, made a little longer for the line test.`,
  ja: (i) => `字幕${i}番の日本語訳です。行の長さを試すために少し長くしています。`,
  zh: (i) => `这是第${i}条字幕的中文翻译，为了测试换行而写得长一些。`,
  es: (i) => `Subtítulo ${i} traducido al español para probar las líneas.`,
  ko: (i) => `${i}번 자막을 한국어로 옮긴 문장입니다 줄 나누기를 시험합니다`,
};
function translate() {
  const to = field('Target language')?.match(/\((\w+)\)/)?.[1] || 'en';
  return fence({ lines: captions().map(({ i }) => ({ i, text: (SENTENCES[to] || SENTENCES.en)(i) })) });
}
function metadata() {
  const seconds = Number(stdin.match(/long \(([\d.]+) s\)/)?.[1] || 60);
  const short = /no chapters/.test(stdin);
  return fence({
    titles: ['자막 만들기 쉬워요', `${'아주 긴 제목 '.repeat(20)}끝`, '편집 이야기'],
    description: '오늘은 자막을 만들어 봅니다.\n\n편집이 쉬워요.',
    chapters: short ? [] : [
      { t: 3, title: '시작' }, { t: 7, title: '너무 가까움' }, { t: 20.6, title: '자막' }, { t: Math.floor(seconds * 0.6), title: '편집' },
      { t: seconds + 5, title: '끝 뒤' },
    ],
    tags: ['#자막', '편집', '편집', 'Nano Studio', '#Cut'],
  });
}
function highlights() {
  const seconds = Number(stdin.match(/this ([\d.]+) s video/)?.[1] || 60);
  const count = Number(stdin.match(/Pick up to (\d+)/)?.[1] || 3);
  const [min, max] = (stdin.match(/Each one (\d+) to (\d+) seconds/) || [0, 5, 20]).slice(1).map(Number);
  if (!retry) return fence({ highlights: [{ start: 1, end: 1 + min + 1, title: '하나', reason: 'a' }, { start: 2, end: 2 + min + 1, title: '둘', reason: 'b' }] });
  const out = [];
  for (let k = 0, at = 1; k < count && at + min + 1 <= seconds; k++, at += min + 4) out.push({ start: at, end: at + min + 1, title: `장면 ${k + 1}`, reason: `이유 ${k + 1}` });
  void max;
  return fence({ highlights: out });
}
function command() {
  const req = field('Request') || '';
  let m;
  if (/delete the project/i.test(req)) return fence({ ops: [{ op: 'deleteProject' }] });
  if (/extra field/i.test(req)) return fence({ ops: [retry ? { op: 'cut', from: 0, to: 1 } : { op: 'cut', from: 0, to: 1, speed: 2 }] });
  if ((m = req.match(/silences? longer than ([\d.]+)/i))) return fence({ ops: [{ op: 'removeSilence', longerThan: Number(m[1]) }] });
  if ((m = req.match(/first (\d+) seconds/i))) return fence({ ops: [{ op: 'cut', from: 0, to: Number(m[1]) }], message: '' });
  if (/music/i.test(req) && (m = req.match(/(\d+) ?dB/i))) return fence({ ops: [{ op: 'clipVolume', clips: 'music', db: -Number(m[1]) }] });
  if (/chapter/i.test(req)) return fence({ ops: [{ op: 'removeMarkers', kind: 'chapter' }, ...[0, 4, 8].map((t, k) => ({ op: 'marker', at: t, name: `Part ${k + 1}`, kind: 'chapter' }))] });
  return fence({ ops: [], message: 'Nothing to edit for that.' });
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ type: 'system', subtype: 'init', model: 'fake', tools: [] });
if (scenario.error) {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: scenario.error }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: scenario.error });
  process.exit(1);
}
await sleep(scenario.delayMs || 0);
const reply = { 'polish captions': polish, 'translate captions': translate, 'YouTube metadata': metadata, highlights, 'edit command': command }[task]?.() ?? 'OK';
for (const piece of reply.match(/[\s\S]{1,40}/g) || []) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 5 });

// ---------- the scripted agent ----------
async function agent() {
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let scenario = {};
  try { scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8')); } catch {}
  const note = (o) => { if (dir) fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ agent: true, pid: process.pid, t: Date.now(), ...o })}\n`); };
  const request = (stdin.match(/The user's request: ([\s\S]*)$/)?.[1] || '').trim();
  const sysFile = args[args.indexOf('--system-prompt-file') + 1];
  note({ start: true, args, request, system: sysFile && fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : '', prompt: stdin, env: { mds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS || null } });
  if (/quota|한도/.test(request)) {
    const msg = 'Claude AI usage limit reached|1700000000';
    emit({ type: 'system', subtype: 'init', model: 'fake', tools: [] });
    emit({ type: 'result', subtype: 'success', is_error: true, result: msg });
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  const server = Object.values(cfg.mcpServers)[0];
  let session = null;
  let rpcId = 0;
  async function rpc(method, params) {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    if (res.headers.get('mcp-session-id')) session = res.headers.get('mcp-session-id');
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  emit({ type: 'system', subtype: 'init', model: 'fake', tools: tools.map((n) => `mcp__cut__${n}`), mcp_servers: [{ name: 'cut', status: 'connected' }] });
  let n = 0;
  const say = (text) => {
    emit({ type: 'stream_event', event: { type: 'message_start' } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  };
  // one tool call: the tool_use, the call, the tool_result -> {ok, text, value, image}. A call still running
  // ({running: true, job}) is waited for with wait_job, as the instructions say, until its own answer comes.
  async function use(name, input) {
    let r = await use1(name, input);
    for (let i = 0; i < 400 && r.ok && r.value?.running === true; i++) {
      note({ running: r.value });
      r = await use1('wait_job', { job: r.value.job });
    }
    return r;
  }
  async function use1(name, input) {
    const id = `toolu_${++n}`;
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__cut__${name}`, input }] } });
    const r = await rpc('tools/call', { name, arguments: input });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const image = (r.content || []).find((c) => c.type === 'image') || null;
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.content, is_error: !!r.isError }] } });
    note({ tool: name, args: input, ok: !r.isError, text: text.slice(0, 400), image: image ? { mimeType: image.mimeType, bytes: Buffer.from(image.data, 'base64').length } : null });
    let value = null;
    try { value = JSON.parse(text); } catch {}
    await sleep(scenario.stepMs ?? 0);
    return { ok: !r.isError, text, value, image };
  }
  const finish = (text) => {
    say(text);
    // the usage fields of the real CLI's result line; the model's id from --model
    const model = args[args.indexOf('--model') + 1] || 'sonnet';
    emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: n + 1, duration_ms: 2400, total_cost_usd: 0.0421,
      usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 8100, output_tokens: 450 }, modelUsage: { [`claude-${model}-fake`]: {} } });
  };
  const seq = (await use('get_sequence', {})).value;
  // verify/cut-ai-tools.mjs: the keyboard's actions, the editing tools, import, automation
  if (/키보드 동작/.test(request)) {
    say('편집 동작을 차례로 실행할게요.');
    await use('list_actions', { search: 'extract' });
    const steps = [
      await use('run_action', { id: 'markIn', time: 1 }),
      await use('run_action', { id: 'markOut', time: 3 }),
      await use('run_action', { id: 'extract' }),
      await use('run_action', { id: 'rippleDelete' }),
      await use('run_action', { id: 'addMarker', time: 2 }),
    ];
    return finish(`${steps.filter((s) => s.ok).length}개를 했고 ${steps.filter((s) => !s.ok).length}개는 하지 못했어요.`);
  }
  if (/그래픽/.test(request)) {
    // a red box, a green ring that draws itself over 2 s, a counter (the 320x180 sequence of cut-ai-tools.mjs)
    const g = await use('add_graphic', { at: 0, duration: 3, name: '차트', layers: [
      { id: 'box', kind: 'rect', size: [80, 80], fill: '#ff0000', position: [-100, 0] },
      { id: 'ring', kind: 'ellipse', size: [80, 80], fill: null, stroke: '#00ff00', strokeWidth: 14, cap: 'butt', trimEnd: 0, position: [90, 0] },
      { id: 'n', kind: 'text', text: '{value}', fontSize: 30, position: [0, -60] },
    ] });
    const k1 = await use('set_keyframes', { clip_id: g.value?.clip, property: 'layers.ring.trimEnd', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 100 }] });
    const k2 = await use('set_keyframes', { clip_id: g.value?.clip, property: 'layers.n.value', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 100 }] });
    const f = await use('get_frame', { time: 2.5 });
    return finish(g.ok && k1.ok && k2.ok && f.ok && f.image ? '그래픽을 넣고 원이 그려지게 했어요.' : `하지 못했어요: ${[g, k1, k2, f].filter((x) => !x.ok).map((x) => x.text).join(' / ')}`);
  }
  if (/효과 편집/.test(request)) {
    const video = seq.clips.find((c) => c.track === 'V1');
    const audioTrack = seq.tracks.find((t) => t.kind === 'audio' && !t.locked);
    const r = [
      await use('set_time_remap', { clip_id: video.id, segments: [{ speed: 100, until: 2, ramp: 0.5 }, { speed: 50, until: 4 }, { hold: 1 }, { speed: 100 }] }),
      await use('add_mask', { clip_id: video.id, shape: 'ellipse', width: 0.5, height: 0.5 }),
    ];
    const mask = r[1].value?.mask;
    r.push(await use('set_keyframes', { clip_id: video.id, property: `masks.${mask}.path`, keyframes: [{ time: 0, value: { shape: 'ellipse', x: 0.3, width: 0.5, height: 0.5 } }, { time: 2, value: { shape: 'ellipse', x: 0.7, width: 0.5, height: 0.5 } }] }));
    r.push(await use('set_keyframes', { clip_id: video.id, property: `masks.${mask}.feather`, keyframes: [{ time: 0, value: 0 }, { time: 2, value: 60 }] }));
    r.push(await use('set_color', { clip_id: video.id, curves: { master: [0, 0, 0.5, 0.7, 1, 1] }, hsl: { hue: 200, hue_range: 60, saturation: 150 } }));
    r.push(await use('set_track', { track_id: audioTrack.id, volume: -6, pan: 20 }));
    r.push(await use('set_sequence', { master_gain: -2 }));
    return finish(r.every((x) => x.ok) ? '속도 램프, 마스크 움직임, 커브, 믹서를 바꿨어요.' : `일부를 하지 못했어요: ${r.filter((x) => !x.ok).map((x) => x.text).join(' / ')}`);
  }
  if (/가져와/.test(request)) {
    const paths = request.match(/[A-Za-z]:\\[^\s"]+/g) || [];
    const r = await use('import_media', { paths });
    return finish(r.ok ? `가져왔어요: ${(r.value.media || []).map((m) => m.name).join(', ')}` : `가져오지 못했어요: ${r.text}`);
  }
  if (/자동 자막/.test(request)) {
    const r = await use('automation', { action: 'auto_captions', language: 'ko' });
    return finish(r.ok ? `자막 ${r.value.count}개를 만들었어요.` : `자막을 만들지 못했어요: ${r.text}`);
  }
  if (/잠긴|locked/i.test(request)) {
    const lockedTrack = seq.tracks.find((t) => t.locked);
    const clip = seq.clips.find((c) => c.track === lockedTrack?.id);
    const r = await use('delete_clips', { clip_ids: [clip?.id || 'c1'], ripple: true });
    return finish(r.ok ? '지웠어요.' : `그 클립은 잠긴 트랙에 있어서 지우지 못했어요: ${r.text}`);
  }
  if (/모르는|unknown/i.test(request)) {
    const r = await use('add_effect', { clip_id: seq.clips[0]?.id || 'c1', type: 'sparkle.magic' });
    return finish(r.ok ? '넣었어요.' : `그런 효과는 없어요: ${r.text}`);
  }
  if (/천천히|slowly/i.test(request)) {
    say('표시를 차례로 넣을게요.');
    for (let k = 1; k <= 8; k++) await use('add_marker', { at: k * 0.5, name: `표시 ${k}` });
    return finish('표시를 여덟 개 넣었어요.');
  }
  if (/내보내|export/i.test(request)) {
    const r = await use('export_sequence', { preset: '720p', file_name: 'AI export' });
    return finish(r.ok ? `내보내기 대기열에 넣었어요: ${r.value?.queued}` : `내보내지 않았어요: ${r.text}`);
  }
  if (/화면|frame/i.test(request)) {
    const r = await use('get_frame', { time: 1, width: 320 });
    return finish(r.ok && r.image ? `화면을 봤어요 (${r.value.width}x${r.value.height}).` : `화면을 보지 못했어요: ${r.text}`);
  }
  if (/잘라|cut/i.test(request)) {
    say('앞 3초를 잘라내고 제목을 넣을게요.');
    const cut = await use('delete_range', { from: 0, to: 3, ripple: true });
    const title = await use('add_text', { text: '제목', at: 0, duration: 2, size: 120 });
    const mark = await use('add_marker', { at: 0, name: '제목', kind: 'chapter' });
    return finish(cut.ok && title.ok && mark.ok ? '앞 3초를 잘라내고 처음 2초에 제목을 넣었어요.' : '일부를 하지 못했어요.');
  }
  await use('get_project', {});
  return finish('무엇을 바꿀까요?');
}
