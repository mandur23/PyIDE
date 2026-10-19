// AI edits: Ctrl+I inline edits and next edit suggestions. Prompts go in and parsed answers come out here, so the
// renderer only deals with lines and hunks.
const { complete } = require('../ai/claude');

const EDIT_SYSTEM = `You are the code-editing engine of a Python IDE. The user selected a region of a file and gave an instruction, in Korean or English.
Reply with only the complete new text that replaces the region: every line of the region, including the lines you keep unchanged (such as a def or class line above an added docstring), and no explanation, no Markdown code fences, no tags, nothing before or after it.
Keep the region's indentation and the file's style. Change only what the instruction asks for.
If the region is empty, write the code to insert there.
Write new code comments in the language the existing comments use.`;

const NES_SYSTEM = `You predict the next edit a programmer will make in a file, from the edits they just made. Typical next edits: after renaming a variable or parameter, update its remaining uses; after adding a field or parameter, update the constructor, the call sites or the docstring; after changing one of several similar lines, change the others the same way.
Only suggest an edit that the recent edits clearly imply, at a place the user has not edited yet. If none is clearly implied, answer exactly NONE.
Otherwise answer with exactly one block in this format and nothing else:
@@ <first line number>-<last line number> @@ <reason in a few words>
-<original line, copied exactly>
+<replacement line>
List every original line of the range with "-" in order, then every new line with "+". To insert lines, include a neighbouring original line as both "-" and "+". Use the line numbers of the excerpt. No Markdown, no explanation.`;

function editPrompt({ path, language, before, region, after, instruction, history = [], proposal = null }) {
  const parts = [
    `File: ${path}`,
    `Language: ${language}`,
    '',
    'The file around the region (the region is between <region> and </region>):',
    `<before>\n${before}\n</before>`,
    `<region>\n${region}\n</region>`,
    `<after>\n${after}\n</after>`,
    '',
  ];
  if (proposal === null) {
    parts.push(`Instruction: ${instruction}`);
  } else {
    parts.push('Earlier instructions for this region, oldest first:', ...history.map((h) => `- ${h}`), '',
      'Your current proposal for the region:', `<proposal>\n${proposal}\n</proposal>`, '',
      `Follow-up instruction: ${instruction}`, 'Reply with the complete new text for the region.');
  }
  return parts.join('\n');
}

const leadingWs = (s) => s.match(/^[ \t]*/)[0];
const firstText = (lines) => lines.find((l) => l.trim());
const countEdge = (lines, fromEnd) => {
  let n = 0;
  while (n < lines.length && !lines[fromEnd ? lines.length - 1 - n : n].trim()) n++;
  return n;
};

// The model's answer as the region's new lines. `partial` drops the line still being generated.
function parseReplacement(raw, region, partial = false) {
  let lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (partial) lines.pop();
  const regionLines = region.split('\n');
  const open = lines.findIndex((l) => l.trim());
  // A region that is itself a fenced block (Markdown) comes back fenced on purpose.
  if (open >= 0 && lines[open].trimStart().startsWith('```') && !firstText(regionLines)?.trimStart().startsWith('```')) {
    lines = lines.slice(open + 1);
    const close = lines.findIndex((l) => l.trimStart().startsWith('```'));
    if (close >= 0) lines = lines.slice(0, close);
  }
  if (lines[0]?.trim() === '<region>') lines.shift();
  if (lines[lines.length - 1]?.trim() === '</region>') lines.pop();

  if (!partial) {
    // Blank lines around the answer are kept only as far as the region had them.
    const trailing = Math.max(0, countEdge(lines, true) - countEdge(regionLines, true));
    lines = lines.slice(0, lines.length - trailing);
    const leading = Math.max(0, countEdge(lines, false) - countEdge(regionLines, false));
    lines = lines.slice(leading);
  }
  // Models often return an indented block flush left; put it back at the region's indentation. Comparing first lines
  // gives the streamed preview the indentation of the final answer as soon as its first line is in.
  const want = leadingWs(firstText(regionLines) ?? '');
  const got = leadingWs(firstText(lines) ?? want);
  if (got.length < want.length && want.startsWith(got)) {
    const add = want.slice(got.length);
    lines = lines.map((l) => (l.trim() ? add + l : l));
  }
  return lines;
}

function nesPrompt({ path, language, excerpt, edits, cursorLine }) {
  const width = String(excerpt.start + excerpt.lines.length).length;
  return [
    `File: ${path}`,
    `Language: ${language}`,
    '',
    'Recent edits by the user, oldest first:',
    edits.join('\n\n'),
    '',
    'Current file excerpt (line number | text):',
    ...excerpt.lines.map((l, i) => `${String(excerpt.start + i).padStart(width)}| ${l}`),
    '',
    `The cursor is on line ${cursorLine}.`,
  ].join('\n');
}

// The model's NES answer as {startLine, endLine, oldLines, newLines, reason}, or null. The "-" lines anchor the
// suggestion: it is placed where they match the file (near the claimed line), never where they do not.
function parseNes(raw, excerpt) {
  const text = raw.replace(/\r\n?/g, '\n');
  const header = text.match(/^@@\s*(\d+)\s*(?:[-,]\s*(\d+))?\s*@@[ \t]*(.*)$/m);
  if (!header) return null;
  const body = text.slice(header.index + header[0].length + 1).split('\n');
  const oldLines = [];
  const newLines = [];
  for (const l of body) {
    if (l.startsWith('-')) oldLines.push(l.slice(1));
    else if (l.startsWith('+')) newLines.push(l.slice(1));
    else if (l.trim()) break;
  }
  if (!oldLines.length) return null;
  const claimed = Number(header[1]);
  const fileLine = (n) => excerpt.lines[n - excerpt.start];
  const locate = (olds) => {
    const at = (n) => olds.every((o, k) => fileLine(n + k)?.trimEnd() === o.trimEnd());
    for (let d = 0; d <= 10; d++) for (const n of [claimed - d, claimed + d]) if (n >= excerpt.start && at(n)) return n;
    return null;
  };
  let start = locate(oldLines);
  let added = newLines;
  // "- code" with a space after the marker: the space is not part of the line.
  if (start === null && [...oldLines, ...newLines].every((l) => !l || l.startsWith(' '))) {
    start = locate(oldLines.map((l) => l.slice(1)));
    added = newLines.map((l) => l.slice(1));
  }
  if (start === null) return null;
  const old = excerpt.lines.slice(start - excerpt.start, start - excerpt.start + oldLines.length);
  if (old.length === added.length && old.every((l, i) => l === added[i])) return null;
  return { startLine: start, endLine: start + old.length - 1, oldLines: old, newLines: added, reason: header[3].trim() };
}

// Claude Code model ids and aliases (haiku, claude-sonnet-4-5[1m]); the value ends up on a command line.
const MODEL_ID = /^[\w.\-[\]]+$/;

exports.register = ({ ipcMain }) => {
  const running = new Map(); // reqId -> AbortController

  async function run(reqId, { system, prompt, model, timeoutMs, onText }) {
    if (!MODEL_ID.test(model)) return { ok: false, code: 'cli', message: `invalid model name "${model}"` };
    const ctl = new AbortController();
    running.set(reqId, ctl);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      return { ok: true, ...(await complete({ system, prompt, model, signal: ctl.signal, onText })) };
    } catch (err) {
      if (timedOut) return { ok: false, code: 'timeout', message: 'Claude Code did not answer in time' };
      return { ok: false, code: err.code || 'cli', message: err.message };
    } finally {
      clearTimeout(timer);
      running.delete(reqId);
    }
  }

  // req: {reqId, path, language, before, region, after, instruction, history, proposal, model}
  ipcMain.handle('ai-edit:edit', async (e, req) => {
    const r = await run(req.reqId, {
      system: EDIT_SYSTEM, prompt: editPrompt(req), model: req.model, timeoutMs: 180000,
      onText: (text) => { if (!e.sender.isDestroyed()) e.sender.send('ai-edit:stream', { reqId: req.reqId, lines: parseReplacement(text, req.region, true) }); },
    });
    return r.ok ? { ok: true, lines: parseReplacement(r.text, req.region), ms: r.ms } : r;
  });

  // req: {reqId, path, language, excerpt: {start, lines}, edits: [diff text], cursorLine, model}
  ipcMain.handle('ai-edit:nes', async (_e, req) => {
    const r = await run(req.reqId, { system: NES_SYSTEM, prompt: nesPrompt(req), model: req.model, timeoutMs: 60000 });
    return r.ok ? { ok: true, suggestion: parseNes(r.text, req.excerpt), ms: r.ms } : r;
  });

  ipcMain.handle('ai-edit:cancel', (_e, reqId) => { running.get(reqId)?.abort(); });
};

exports.parseReplacement = parseReplacement;
exports.parseNes = parseNes;
exports.editPrompt = editPrompt;
exports.nesPrompt = nesPrompt;
