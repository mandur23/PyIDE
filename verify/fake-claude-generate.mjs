// A stand-in for the Claude Code CLI (`claude -p --output-format stream-json …`) with deterministic answers for the AI
// actions Write Documentation and Generate Unit Tests (main/features/ai-generate.js), so tests never call a model.
// verify/ai-generate.mjs writes a claude.cmd that runs this file and points PYIDE_CLAUDE_PATH at it.
//
// FAKE_CLAUDE_DIR holds scenario.json ({docstring|tests|other: {delayMs, error, reply}}) and receives log.jsonl
// (one line per call: pid, kind, args, stdin, system).
//
// Answers are built from the prompt alone:
// - docstring: the summary "Summary of <qualname>." (Korean "<name> 함수입니다." for Language: Korean) and the
//   parameters, return value and raised exceptions from the prompt's "Signature (JSON)" line, in the requested format.
// - tests: one test per doctest example (`>>> expr` and its expected output) of the code, a pytest.raises /
//   assertRaises test for an example whose output is a traceback, or `assert callable(...)` without examples; pytest
//   functions or a unittest.TestCase, importing the target as the prompt's "Import:" line says.
import fs from 'fs';
import path from 'path';

const dir = process.env.FAKE_CLAUDE_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
const sysFile = args[args.indexOf('--system-prompt-file') + 1];
const system = sysFile && fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : '';
const kind = stdin.startsWith('Task: write the docstring') ? 'docstring' : stdin.startsWith('Task: write unit tests') ? 'tests' : 'other';
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))[kind] || {}; } catch {}
if (dir) fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ pid: process.pid, kind, args, stdin, system, t: Date.now() })}\n`);

const field = (name) => stdin.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1]?.trim();
const sig = (() => { try { return JSON.parse(field('Signature \\(JSON\\)')); } catch { return { name: 'x', qualname: 'x', kind: 'function', params: [], raises: [] }; } })();
const korean = field('Language') === 'Korean';
const code = (() => { const i = stdin.lastIndexOf('<code>\n'); const j = stdin.lastIndexOf('\n</code>'); return i >= 0 && j > i ? stdin.slice(i + 7, j) : ''; })();

function docstring() {
  const format = field('Docstring format');
  const params = (sig.params || []).filter((p) => p.name);
  const summary = korean ? `${sig.name} ${sig.kind === 'class' ? '클래스' : '함수'}입니다.` : `Summary of ${sig.qualname}.`;
  const pdesc = (p) => (korean ? `${p.name} 값.` : `The ${p.name} value.`);
  const rdesc = korean ? '결과 값.' : 'The result.';
  const edesc = korean ? '입력이 잘못된 경우.' : 'If the input is invalid.';
  const returns = sig.kind !== 'class' && sig.returns && sig.returns !== 'None' ? sig.returns : null;
  const raises = sig.raises || [];
  const sections = [];
  if (format === 'Google') {
    if (params.length) sections.push(['Args:', ...params.map((p) => `    ${p.name}${p.annotation ? ` (${p.annotation})` : ''}: ${pdesc(p)}`)]);
    if (returns) sections.push(['Returns:', `    ${returns}: ${rdesc}`]);
    if (raises.length) sections.push(['Raises:', ...raises.map((e) => `    ${e}: ${edesc}`)]);
  } else if (format === 'NumPy') {
    if (params.length) sections.push(['Parameters', '----------', ...params.flatMap((p) => [`${p.name} : ${p.annotation || 'object'}`, `    ${pdesc(p)}`])]);
    if (returns) sections.push(['Returns', '-------', returns, `    ${rdesc}`]);
    if (raises.length) sections.push(['Raises', '------', ...raises.flatMap((e) => [e, `    ${edesc}`])]);
  } else if (format === 'reStructuredText') {
    const lines = [
      ...params.flatMap((p) => [`:param ${p.name}: ${pdesc(p)}`, ...(p.annotation ? [`:type ${p.name}: ${p.annotation}`] : [])]),
      ...(returns ? [`:return: ${rdesc}`, `:rtype: ${returns}`] : []),
      ...raises.map((e) => `:raises ${e}: ${edesc}`),
    ];
    if (lines.length) sections.push(lines);
  }
  return [summary, ...sections.flatMap((s) => ['', ...s])].join('\n');
}

// Doctest examples of the code: [{expr, expected} | {expr, raises}].
function examples() {
  const lines = code.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*>>> (.*)$/);
    if (!m) continue;
    const got = [];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*(>>>|""")/.test(lines[i + 1])) got.push(lines[++i].trim());
    if (got[0]?.startsWith('Traceback')) {
      const exc = got[got.length - 1].match(/^([A-Za-z_][\w.]*)/)?.[1] || 'Exception';
      out.push({ expr: m[1], raises: exc });
    } else if (got.length) out.push({ expr: m[1], expected: got.join(' ') });
  }
  return out;
}

function tests() {
  const unittest = field('Framework') === 'unittest';
  const imp = field('Import');
  const ref = field('Refer to it as') || sig.name;
  const ex = examples();
  const equal = ex.filter((e) => 'expected' in e);
  const raising = ex.filter((e) => e.raises);
  const name = sig.name.replace(/^_+/, '') || 'target';
  if (unittest) {
    const cls = `Test${name[0].toUpperCase()}${name.slice(1)}`;
    const methods = [];
    if (equal.length) methods.push([`    def test_${name}(self):`, ...equal.map((e) => `        self.assertEqual(${e.expr}, ${e.expected})`)]);
    else if (!raising.length) methods.push([`    def test_${name}_exists(self):`, `        self.assertTrue(callable(${ref}))`]);
    raising.forEach((e, i) => methods.push([`    def test_${name}_raises_${e.raises.toLowerCase()}${i ? `_${i + 1}` : ''}(self):`,
      `        with self.assertRaises(${e.raises}):`, `            ${e.expr}`]));
    return ['import unittest', '', imp, '', '', `class ${cls}(unittest.TestCase):`, methods.map((m) => m.join('\n')).join('\n\n'),
      '', '', 'if __name__ == "__main__":', '    unittest.main()', ''].join('\n');
  }
  const blocks = [];
  if (equal.length) blocks.push([`def test_${name}():`, ...equal.map((e) => `    assert ${e.expr} == ${e.expected}`)]);
  else if (!raising.length) blocks.push([`def test_${name}_exists():`, `    assert callable(${ref})`]);
  raising.forEach((e, i) => blocks.push([`def test_${name}_raises_${e.raises.toLowerCase()}${i ? `_${i + 1}` : ''}():`,
    `    with pytest.raises(${e.raises}):`, `        ${e.expr}`]));
  const head = raising.length ? ['import pytest', '', imp] : [imp];
  return `${['```python', ...head, '', '', blocks.map((b) => b.join('\n')).join('\n\n\n')].join('\n')}\n\`\`\`\n`;
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
const reply = scenario.reply ?? (kind === 'docstring' ? docstring() : kind === 'tests' ? tests() : 'OK');
for (const piece of reply.match(/[\s\S]{1,40}/g) || []) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 5 });
