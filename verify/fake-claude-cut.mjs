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
import fs from 'fs';
import path from 'path';

const dir = process.env.FAKE_CLAUDE_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
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
