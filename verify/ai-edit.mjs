// AI edits (Ctrl+I inline diff, next edit suggestions) against a stand-in `claude` that answers in the CLI's
// stream-json format. AI_EDIT_REAL=1 adds one real Ctrl+I edit and one real NES call with the installed Claude Code.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { DatabaseSync } from 'node:sqlite';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the stand-in CLI ----------
const fakeDir = mkdtempSync(path.join(tmpdir(), 'pyide-fake-claude-ai-'));
const fakeCmd = path.join(fakeDir, 'claude.cmd');
const fakeJs = path.join(fakeDir, 'fake-claude.mjs');
writeFileSync(fakeJs, `
import fs from 'fs';
import path from 'path';
const dir = ${JSON.stringify(fakeDir)};
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
const kind = stdin.includes('Recent edits by the user') ? 'nes' : 'edit';
const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))[kind] || { reply: 'NONE' };
const sysFile = args[args.indexOf('--system-prompt-file') + 1];
fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ pid: process.pid, kind, args, stdin, t: Date.now(),
  system: fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : null }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ type: 'system', subtype: 'init', model: 'fake', tools: [] });
if (sc.crash) { process.stderr.write(sc.crash + '\\n'); process.exit(2); }
if (sc.error) {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: sc.error }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: sc.error, api_error_status: 401 });
  process.exit(1);
}
await sleep(sc.delayMs || 0);
for (const piece of sc.reply.match(/[\\s\\S]{1,10}/g) || []) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
  await sleep(sc.chunkMs || 0);
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: sc.reply }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: sc.reply, duration_ms: 5 });
`);
writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
writeFileSync(path.join(fakeDir, 'log.jsonl'), '');
const scenario = (s) => writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(s));
const calls = () => readFileSync(path.join(fakeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
scenario({});

const SHAPES = readFileSync(new URL('./fixtures/ai-edit/shapes.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const RENAME = readFileSync(new URL('./fixtures/ai-edit/rename.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

async function helpers(t) {
  const { js, until, press, type } = t;
  // The local AI completion plugin's ghost text owns Tab whenever it shows; its model may be installed on this machine.
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  return {
    // Resolves to whether the condition came true, for checks whose failure should not end the run.
    settles: (expr, label, ms = 5000) => until(expr, label, ms).then(() => true, () => false),
    text: () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`),
    select: (l1, c1, l2, c2) => js(`(ide.editor.setSelection(new ide.monaco.Selection(${l1}, ${c1}, ${l2}, ${c2})), ide.editor.focus(), true)`),
    session: () => js('ide.aiEdit.session()'),
    async edit(instruction, until_ = 'reviewing') {
      await press('Ctrl+I');
      await until(`document.activeElement?.classList.contains('ai-edit-input')`, 'prompt input focused');
      await type(instruction);
      await press('Enter');
      if (until_) await until(`ide.aiEdit.session()?.phase === '${until_}'`, `session ${until_}`, 20000);
    },
  };
}

// ---------- English instance ----------
process.env.PYIDE_CLAUDE_PATH = fakeCmd;
const t = await launch({ fixture: 'ai-edit', port: 9650, name: 'ai-edit' });
const { js, until, press, type, check, shot, click } = t;
const h = await helpers(t);

try {
  await openFile(t, 'shapes.py');
  await until(`ide.editor.getModel()?.getLineCount() > 10`, 'shapes.py loaded');

  // ---------- Ctrl+I opens the prompt above the selection ----------
  await h.select(4, 1, 6, 17);
  await press('Ctrl+I');
  await until(`!!document.querySelector('.ai-edit-widget') && document.activeElement?.classList.contains('ai-edit-input')`, 'prompt widget');
  const place = await js(`(() => {
    const w = document.querySelector('.ai-edit-widget').getBoundingClientRect();
    const ed = ide.editor.getDomNode().getBoundingClientRect();
    const line = ed.top + ide.editor.getScrolledVisiblePosition({ lineNumber: 4, column: 1 }).top;
    return { gap: line - w.bottom, region: ide.aiEdit.session().region, phase: ide.aiEdit.session().phase };
  })()`);
  check(place.phase === 'prompting' && place.region.start === 4 && place.region.end === 6 && place.gap >= 0 && place.gap < 12,
    `Ctrl+I opens the prompt right above the selected lines 4-6 (gap ${place.gap}px)`);
  check((await js(`ide.keysFor('CheckinProject')`)) === 'Ctrl+K' && (await js(`ide.keysFor('AiEdit.InlineEdit')`)) === 'Ctrl+I'
    && !(await js(`ide.toolWindows.get('Commit')?.isVisible() || false`)), 'Ctrl+K stays Commit (PyCharm keymap); the inline edit is Ctrl+I');

  // ---------- Korean instruction, streaming, inline diff ----------
  const typed = 'def area(w: float, h: float) -> float:\n    """Area of a rectangle."""\n    return w * h\n';
  scenario({ edit: { reply: '```python\n' + typed + '```\n', chunkMs: 90 } });
  const instruction = '타입 힌트를 추가해 줘 (float)';
  await type(instruction);
  await press('Enter');
  await until(`ide.aiEdit.session()?.phase === 'generating'`, 'generating');
  await until(`ide.aiEdit.session()?.phase === 'generating' && !!document.querySelector('.ai-edit-add')`, 'streamed lines while generating', 10000);
  check(true, 'proposed code streams into the editor while it is generated');
  await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'reviewing', 20000);
  const editCall = calls().at(-1);
  check(editCall.kind === 'edit' && editCall.stdin.includes(`Instruction: ${instruction}`), 'the Korean instruction reaches Claude Code intact (stdin, UTF-8)');
  check(editCall.stdin.includes('<region>\ndef area(w, h):\n    """Area of a rectangle."""\n    return w * h\n</region>') && editCall.stdin.includes('File: shapes.py'),
    'the prompt carries the file name and the selected region');
  const flags = editCall.args.join(' ');
  check(['-p', '--output-format stream-json', '--include-partial-messages', '--model haiku', '--max-turns 1', '--safe-mode', '--no-session-persistence'].every((f) => flags.includes(f))
    && editCall.args[editCall.args.indexOf('--tools') + 1] === '' && /replaces the region/.test(editCall.system || ''),
  `claude runs headless, single turn, without tools, with the edit system prompt (${flags.replace(/--system-prompt-file \S+/, '--system-prompt-file …')})`);
  const s1 = await h.session();
  check(s1.hunks.length === 1 && s1.hunks[0].startLine === 4 && s1.hunks[0].endLine === 4
    && s1.hunks[0].newLines.join() === 'def area(w: float, h: float) -> float:', 'the answer (code fences stripped) is one hunk: line 4 replaced');
  const diffDom = await js(`(() => {
    const del = [...document.querySelectorAll('.view-overlays .ai-edit-del')];
    const add = [...document.querySelectorAll('.ai-edit-add .ai-line')].map((n) => n.textContent.replace(/\\u00a0/g, ' '));
    const rgb = (n) => getComputedStyle(n).backgroundColor;
    return { del: del.length, add, delColor: del[0] && rgb(del[0]), addColor: rgb(document.querySelector('.ai-edit-add')) };
  })()`);
  const tint = (c, ch) => { const [r, g, b] = (c || '').match(/\d+/g).map(Number); return ch === 'r' ? r > g && r > b : g > r && g > b; };
  check(diffDom.del === 1 && diffDom.add.join('\n') === 'def area(w: float, h: float) -> float:' && tint(diffDom.delColor, 'r') && tint(diffDom.addColor, 'g'),
    `the removed line is red and the added line is green (${diffDom.delColor} / ${diffDom.addColor})`);
  check((await h.text()) === SHAPES, 'the file is untouched while the diff is reviewed');
  await shot('review.png');

  // ---------- accept once, one undo ----------
  await press('Ctrl+Enter');
  await until(`!ide.aiEdit.session()`, 'session closed');
  const accepted = SHAPES.replace('def area(w, h):', 'def area(w: float, h: float) -> float:');
  check((await h.text()) === accepted, 'Ctrl+Enter applies the edit exactly once');
  await press('Ctrl+Z');
  check((await h.text()) === SHAPES, 'one Ctrl+Z restores the original');
  check(!(await js(`document.querySelector('.ai-edit-widget, .ai-edit-add, .view-overlays .ai-edit-del')`)), 'no diff or prompt is left behind');

  // ---------- reject ----------
  await h.select(9, 1, 10, 22);
  scenario({ edit: { reply: 'def perimeter(w, h):\n    return 2 * w + 2 * h\n' } });
  await h.edit('expand');
  await press('Escape');
  await until(`!ide.aiEdit.session()`, 'rejected');
  check((await h.text()) === SHAPES && !(await js(`ide.isDirty(ide.activeTab())`)), 'Esc rejects: the file is unchanged and not modified');

  // ---------- two hunks: accept one, reject the other ----------
  await h.select(13, 1, 19, 51);
  scenario({ edit: { reply: [
    'class Point:', '    def __init__(self, x, y):', '        self.x = float(x)', '        self.y = y', '',
    '    def norm(self):', '        return math.hypot(self.x, self.y)', ''].join('\n') } });
  await h.edit('use floats and math.hypot');
  const s2 = await h.session();
  check(s2.hunks.length === 2 && s2.hunks[0].startLine === 15 && s2.hunks[1].startLine === 19
    && (await js(`document.querySelectorAll('.ai-edit-hunk-actions').length`)) === 2, 'two separate changes show as two hunks, each with Accept and Reject');
  await click('.ai-edit-hunk-actions[data-hunk="0"] .ai-hunk-accept');
  await until(`ide.aiEdit.session()?.hunks.length === 1`, 'one hunk left');
  check((await h.text()).includes('        self.x = float(x)\n'), 'accepting the first hunk writes only that hunk');
  await click('.ai-edit-hunk-actions[data-hunk="0"] .ai-hunk-reject');
  await until(`!ide.aiEdit.session()`, 'session over after the last hunk');
  const mixed = SHAPES.replace('        self.x = x\n', '        self.x = float(x)\n');
  check((await h.text()) === mixed, 'rejecting the second hunk leaves its lines as they were');
  await press('Ctrl+Z');
  check((await h.text()) === SHAPES, 'the accepted hunk is one undo step');

  // ---------- follow-up instruction refines the proposal; Tab accepts ----------
  await h.select(9, 1, 10, 22);
  scenario({ edit: { reply: 'def perimeter(w, h):\n    """Perimeter of a rectangle."""\n    return 2 * (w + h)\n' } });
  await h.edit('add a docstring');
  check((await h.session()).hunks[0].newLines[0] === '    """Perimeter of a rectangle."""', 'first proposal adds a docstring');
  scenario({ edit: { reply: 'def perimeter(w, h):\n    """직사각형의 둘레."""\n    return 2 * (w + h)\n' } });
  await type('docstring in Korean');
  await press('Enter');
  await until(`ide.aiEdit.session()?.phase === 'reviewing' && ide.aiEdit.session().instructions.length === 2`, 'refined', 20000);
  const refine = calls().at(-1).stdin;
  check(refine.includes('Follow-up instruction: docstring in Korean') && refine.includes('- add a docstring')
    && refine.includes('<proposal>\ndef perimeter(w, h):\n    """Perimeter of a rectangle."""'), 'a follow-up sends the earlier instruction and the current proposal');
  check((await h.session()).hunks[0].newLines[0] === '    """직사각형의 둘레."""', 'the follow-up answer replaces the proposal');
  await js('ide.editor.focus()');
  await press('Tab');
  await until(`!ide.aiEdit.session()`, 'accepted with Tab');
  check((await h.text()) === SHAPES.replace('def perimeter(w, h):\n', 'def perimeter(w, h):\n    """직사각형의 둘레."""\n'), 'Tab in the editor accepts the refined edit');
  await press('Ctrl+Z');

  // ---------- the user edits the file while reviewing ----------
  const PERIM = 'def perimeter(w, h):\n    """Perimeter of a rectangle."""\n    return 2 * (w + h)\n';
  const NORM = '    def norm(self):\n        return math.hypot(self.x, self.y)\n';
  const INIT = '    def __init__(self, x, y):\n        self.x = float(x)\n        self.y = y\n';
  const deleteLines = async (from, to) => { await h.select(from, 1, to, 2); await press('Ctrl+Y'); };
  // Closes any session and undoes back to the fixture text.
  const restore = async () => {
    await js(`(ide.aiEdit.session() && document.querySelector('.ai-edit-reject')?.click(), true)`);
    for (let i = 0; i < 8 && (await h.text()) !== SHAPES; i++) await js(`(ide.editor.trigger('test', 'undo', null), true)`);
  };
  const reviewing = async (sel, reply, instruction = 'edit') => {
    await h.select(...sel);
    scenario({ edit: { reply } });
    await h.edit(instruction);
  };

  await reviewing([9, 1, 10, 22], PERIM);
  await deleteLines(8, 8);
  await press('Ctrl+Enter');
  check(await h.settles(`!ide.aiEdit.session()`, 'accepted') && (await h.text()) === SHAPES.replace('\n\n\ndef perimeter(w, h):\n', '\n\ndef perimeter(w, h):\n    """Perimeter of a rectangle."""\n'),
    'deleting the line right above the edited lines during review still applies the edit to them, once');
  await restore();

  await reviewing([18, 1, 19, 51], NORM);
  await deleteLines(20, 20);
  await press('Ctrl+Enter');
  check(await h.settles(`!ide.aiEdit.session()`, 'accepted') && (await h.text()) === SHAPES.replace('(self.x ** 2 + self.y ** 2) ** 0.5\n', 'math.hypot(self.x, self.y)'),
    'deleting the file\'s last line right below the edited lines during review still applies the edit to them, once');
  await restore();

  await reviewing([14, 1, 16, 19], INIT);
  await deleteLines(13, 14);
  await press('Ctrl+Enter');
  check(await h.settles(`!ide.aiEdit.session()`, 'accepted')
    && (await h.text()) === SHAPES.replace('class Point:\n    def __init__(self, x, y):\n        self.x = x\n', '    def __init__(self, x, y):\n        self.x = float(x)\n'),
  'deleting lines from above into the edited lines during review applies the edit to the lines that are left');
  await restore();

  await reviewing([9, 1, 10, 22], PERIM);
  await deleteLines(9, 10);
  const emptied = (await h.session()).hunks;
  await js(`(ide.editor.trigger('test', 'undo', null), true)`);
  const undone = (await h.session()).hunks;
  check(emptied.length === 1 && emptied[0].oldLines.length === 0 && emptied[0].newLines.join('\n') === PERIM.trimEnd()
    && undone.length === 1 && undone[0].startLine === 10 && undone[0].newLines.join() === '    """Perimeter of a rectangle."""',
  'deleting all the edited lines turns the edit into an insertion, and undo brings back the one-line change');
  await deleteLines(9, 10);
  await click('.ai-edit-hunk-actions[data-hunk="0"] .ai-hunk-accept');
  check(await h.settles(`!ide.aiEdit.session()`, 'accepted') && (await h.text()) === SHAPES.replace('def perimeter(w, h):\n    return 2 * (w + h)\n', PERIM),
    'after the edited lines were deleted, accepting the insertion writes it once and ends the review');
  await restore();

  await reviewing([18, 1, 19, 51], NORM);
  await deleteLines(18, 19);
  await click('.ai-edit-hunk-actions[data-hunk="0"] .ai-hunk-accept');
  check(await h.settles(`!ide.aiEdit.session()`, 'accepted') && (await h.text()) === SHAPES.replace('(self.x ** 2 + self.y ** 2) ** 0.5', 'math.hypot(self.x, self.y)'),
    'the same at the end of the file: the insertion is written once');
  await restore();

  // A snippet's tab stops own Tab while the snippet is active.
  await reviewing([9, 1, 10, 22], PERIM);
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 1 }), ide.editor.focus(), ide.editor.getContribution('snippetController2').insert('pair(\${1:a}, \${2:b})'), true)`);
  await press('Tab');
  check((await js(`ide.aiEdit.session()?.phase`)) === 'reviewing' && (await js(`ide.editor.getModel().getValueInRange(ide.editor.getSelection())`)) === 'b',
    'Tab in a snippet moves to the next tab stop instead of accepting the edit');
  await restore();

  // ---------- the streamed preview is indented like the final answer ----------
  await h.select(16, 1, 18, 20);
  scenario({ edit: { reply: '    self.y = float(y)\n\ndef norm(self):\n', chunkMs: 500 } });
  await h.edit('float y', 'generating');
  await h.settles(`[...document.querySelectorAll('.ai-edit-add .ai-line')].some((n) => n.textContent.includes('float(y)'))`, 'streamed line', 10000);
  const streamedLine = await js(`[...document.querySelectorAll('.ai-edit-add .ai-line')].map((n) => n.textContent.replace(/\\u00a0/g, ' ')).find((l) => l.includes('float(y)'))`);
  await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'reviewing', 20000);
  const finalLine = (await h.session()).hunks.flatMap((x) => x.newLines).find((l) => l.includes('float(y)'));
  check(streamedLine === '        self.y = float(y)' && finalLine === streamedLine, `the streamed preview has the final indentation (${JSON.stringify(streamedLine)} / ${JSON.stringify(finalLine)})`);
  await restore();

  // ---------- Markdown viewer: an embedded editor, and a region that is itself a fenced block ----------
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'notes.md'))`);
  await until(`(window.__md = ide.monaco.editor.getEditors().find((e) => e.getModel() === ide.getDocument(ide.util.joinPath(ide.root, 'notes.md'))?.model && !ide.editors().includes(e))) && __md.getDomNode().offsetHeight > 0`, 'Markdown editor');
  await js(`(__md.setSelection(new ide.monaco.Selection(1, 1, 1, 1)), __md.focus(), true)`);
  await press('Ctrl+I');
  await until(`document.activeElement?.classList.contains('ai-edit-input')`, 'prompt in the Markdown editor');
  await press('Escape');
  check(await h.settles(`!ide.aiEdit.session(__md) && __md.hasTextFocus()`, 'closed'), 'Esc in the prompt of an editor inside a viewer closes the prompt and returns to that editor');
  await js(`(__md.setSelection(new ide.monaco.Selection(3, 1, 5, 4)), __md.focus(), true)`);
  scenario({ edit: { reply: '```python\nprint("hello")\n```\n' } });
  await press('Ctrl+I');
  await until(`document.activeElement?.classList.contains('ai-edit-input')`, 'prompt in the Markdown editor');
  await type('say hello');
  await press('Enter');
  await until(`ide.aiEdit.session(__md)?.phase === 'reviewing'`, 'reviewing in the Markdown editor', 20000);
  const md = await js('ide.aiEdit.session(__md).hunks');
  check(md.length === 1 && md[0].startLine === 4 && md[0].newLines.join() === 'print("hello")', 'a fenced code block region keeps its fences in the proposal: one changed line');
  await js('__md.focus()');
  await press('Ctrl+Enter');
  await until(`!ide.aiEdit.session(__md)`, 'accepted in the Markdown editor');
  check((await js(`__md.getModel().getValue()`)).replace(/\r\n/g, '\n') === '# Notes\n\n```python\nprint("hello")\n```\n\nEnd.\n', 'Ctrl+Enter in the Markdown editor writes the fenced block');

  // ---------- query console: Ctrl+Enter accepts while reviewing instead of running SQL ----------
  const dbFile = path.join(t.project, 'ai.sqlite');
  new DatabaseSync(dbFile).close();
  const dbId = await js(`ide.database.addDataSource({ kind: 'sqlite', name: 'ai', file: ${JSON.stringify(dbFile)} })`);
  await js(`ide.database.openConsole(${JSON.stringify(dbId)})`);
  await until(`!!ide.database.activeConsole()?.editor.getDomNode().offsetHeight`, 'query console');
  await js(`(window.__db = ide.database.activeConsole().editor, __db.getModel().setValue('SELECT 1;'), __db.setSelection(new ide.monaco.Selection(1, 1, 1, 1)), __db.focus(), true)`);
  scenario({ edit: { reply: 'SELECT 2;\n' } });
  await press('Ctrl+I');
  await until(`document.activeElement?.classList.contains('ai-edit-input')`, 'prompt in the query console');
  await type('select two');
  await press('Enter');
  await until(`ide.aiEdit.session(__db)?.phase === 'reviewing'`, 'reviewing in the query console', 20000);
  const runs = await js('ide.database.activeConsole().runs');
  await js('__db.focus()');
  await press('Ctrl+Enter');
  check(await h.settles(`!ide.aiEdit.session(__db)`, 'accepted') && (await js('__db.getModel().getValue()')) === 'SELECT 2;' && (await js('ide.database.activeConsole().runs')) === runs,
    'Ctrl+Enter in a query console under review accepts the edit and runs no SQL');
  await openFile(t, 'shapes.py');

  // ---------- Esc while generating kills the process ----------
  await h.select(6, 5, 6, 5);
  scenario({ edit: { reply: 'never', delayMs: 60000 } });
  const before = calls().length;
  await h.edit('slow one', 'generating');
  const end = Date.now() + 10000;
  while (calls().length === before && Date.now() < end) await sleep(100);
  const pid = calls().at(-1).pid;
  check(calls().length === before + 1 && alive(pid), 'the CLI process is running while generating');
  await press('Escape');
  await until(`ide.aiEdit.session()?.phase === 'prompting'`, 'back to prompting');
  const gone = Date.now() + 8000;
  while (alive(pid) && Date.now() < gone) await sleep(150);
  check(!alive(pid) && (await h.session()).message === 'Cancelled.', 'Esc while generating cancels and kills the claude process');
  await press('Escape');
  await until(`!ide.aiEdit.session()`, 'closed');

  // ---------- CLI errors ----------
  await h.select(6, 5, 6, 5);
  scenario({ edit: { error: 'Not logged in · Please run /login' } });
  await h.edit('anything', 'prompting');
  await until(`!!document.querySelector('.ai-edit-status.error')`, 'error shown');
  check((await js(`document.querySelector('.ai-edit-status.error').textContent`)).includes('not signed in')
    && (await js(`[...document.querySelectorAll('.ai-edit-actions button')].some((b) => b.textContent === 'Open Claude Code')`)),
  'a signed-out CLI shows a readable message with a button to open Claude Code');
  scenario({ edit: { crash: 'boom: network unreachable' } });
  await js(`document.querySelector('.ai-edit-input').focus()`);
  await press('Enter');
  await until(`document.querySelector('.ai-edit-status.error')?.textContent.includes('boom')`, 'crash shown');
  check((await js(`document.querySelector('.ai-edit-status.error').textContent`)) === 'Claude Code failed: boom: network unreachable',
    'a non-zero exit shows the CLI\'s own error text');
  check((await h.text()) === SHAPES, 'errors leave the file unchanged');
  const pwned = path.join(fakeDir, 'pwned-model.txt');
  await js(`(ide.settings.set('aiEdit.model', ${JSON.stringify(`haiku&echo.>${pwned}`)}), true)`);
  const beforeModel = calls().length;
  await js(`document.querySelector('.ai-edit-input').focus()`);
  await press('Enter');
  await h.settles(`!document.querySelector('.ai-edit-status.error')?.textContent.includes('boom')`, 'answered');
  await sleep(1500);
  check(!existsSync(pwned) && calls().length === beforeModel && (await js(`document.querySelector('.ai-edit-status.error')?.textContent || ''`)).includes('invalid model name'),
    'a model setting with shell syntax in it is refused before any command line');
  await js(`(ide.settings.set('aiEdit.model', 'haiku'), true)`);

  // ---------- Claude Code not installed ----------
  renameSync(fakeCmd, `${fakeCmd}.off`);
  await press('Enter');
  await until(`document.querySelector('.ai-edit-status.error')?.textContent === 'Claude Code is not installed.'`, 'not installed');
  renameSync(`${fakeCmd}.off`, fakeCmd);
  await click('.ai-edit-actions .ai-edit-btn');
  await until(`ide.activeTab()?.title === 'Install Manager'`, 'Install Manager opened');
  await until(`[...document.querySelectorAll('#installCards *')].some((n) => n.textContent === 'Claude Code')`, 'Claude Code card');
  check(true, 'without Claude Code, the prompt offers the Install Manager, which opens on the AI category with Claude Code');
  await openFile(t, 'shapes.py');
  check(!(await h.session()), 'switching the editor to another file closed the session');

  // ---------- next edit suggestions ----------
  await openFile(t, 'rename.py');
  const nesCalls = () => calls().filter((c) => c.kind === 'nes');
  check((await js('ide.aiEdit.nesEnabled()')) === false && (await js(`ide.settings.get('aiEdit.nes.enabled')`)) === undefined, 'next edit suggestions are off by default');
  await h.select(1, 25, 1, 25);
  await type(' ');
  await press('Backspace');
  await sleep(1800);
  check(nesCalls().length === 0, 'with suggestions off, a paused edit calls nothing');

  await click('.ai-edit-statusbar');
  await until(`!!document.querySelector('.context-menu')`, 'status menu');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.textContent.startsWith('Next Edit Suggestions')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`ide.aiEdit.nesEnabled()`, 'NES on');
  check(true, 'the status bar menu turns next edit suggestions on');
  await js(`ide.settings.set('aiEdit.nes.minIntervalMs', 4000)`);

  scenario({ nes: { reply: '@@ 2-2 @@ use the renamed parameter\n-    result = value * factor\n+    result = value * ratio\n' } });
  await h.select(1, 18, 1, 24);
  await type('ratio');
  await until(`!!ide.aiEdit.nes()`, 'suggestion shown', 10000);
  const call1 = nesCalls().at(-1);
  check(call1.stdin.includes('-def scale(value, factor):\n+def scale(value, ratio):') && call1.stdin.includes('2|     result = value * factor'),
    'after a rename and a pause, the recent edit and the numbered file go to Claude Code');
  // nes() is set at once; the gutter glyph is a decoration Monaco draws on its next frame, which a busy machine delays.
  await until(`!!document.querySelector('.ai-nes-glyph') && !!document.querySelector('.ai-nes-hint .ai-nes-key')?.textContent && !!document.querySelector('.ai-nes-add .ai-line')`, 'suggestion drawn', 5000).catch(() => {});
  const hint = await js(`({ hint: document.querySelector('.ai-nes-hint .ai-nes-key')?.textContent, glyph: !!document.querySelector('.ai-nes-glyph'),
    add: [...document.querySelectorAll('.ai-nes-add .ai-line')].map((n) => n.textContent.replace(/\\u00a0/g, ' ')) })`);
  check(hint.hint === 'Tab to jump here' && hint.glyph && hint.add.join() === '    result = value * ratio', 'the suggestion shows at line 2 with a gutter hint and the proposed line');
  await shot('nes.png');
  await press('Tab');
  check((await js('ide.editor.getPosition().lineNumber')) === 2 && (await h.text()) === RENAME.replace('factor):', 'ratio):'), 'Tab jumps to the suggestion without changing the file');
  check((await js(`document.querySelector('.ai-nes-hint .ai-nes-key')?.textContent`)) === 'Tab to apply', 'at the suggestion the hint says Tab applies it');
  await press('Tab');
  const appliedAt = Date.now();
  check((await h.text()) === 'def scale(value, ratio):\n    result = value * ratio\n    return result\n' && !(await js('ide.aiEdit.nes()')), 'the second Tab applies the suggestion');

  scenario({ nes: { reply: '@@ 3-3 @@ note the scaling\n-    return result\n+    return result  # scaled\n' } });
  await until(`!!ide.aiEdit.nes()`, 'second suggestion', 12000);
  const [a, b] = nesCalls().slice(-2);
  // The times are when each fake CLI process started, so a loaded machine's spawn delay can shorten the gap a little.
  check(b.t - a.t >= 3500 && appliedAt + 2500 < a.t + 4000, `calls are rate-limited: the pause after applying waited for the 4 s interval (${b.t - a.t} ms apart)`);

  // Ghost text from an inline completion provider owns Tab while it is visible.
  await js(`(() => {
    window.__ghost = true;
    ide.monaco.languages.registerInlineCompletionsProvider('python', {
      provideInlineCompletions: (model, pos) => (window.__ghost && pos.lineNumber === 1 ? { items: [{ insertText: '  # GHOST', range: new ide.monaco.Range(1, pos.column, 1, pos.column) }] } : { items: [] }),
      disposeInlineCompletions() {},
    });
    ide.editor.setPosition({ lineNumber: 1, column: ide.editor.getModel().getLineMaxColumn(1) });
    ide.editor.focus();
    ide.editor.trigger('test', 'editor.action.inlineSuggest.trigger', {});
    return true;
  })()`);
  await until(`!!document.querySelector('.ghost-text-decoration, .ghost-text')`, 'ghost text visible');
  check(!!(await js('ide.aiEdit.nes()')), 'the suggestion and the ghost text are both visible');
  await press('Tab');
  await js('window.__ghost = false');
  check((await h.text()).startsWith('def scale(value, ratio):  # GHOST\n') && (await js('ide.editor.getPosition().lineNumber')) === 1
    && (await h.text()).includes('    return result\n'), 'Tab goes to the visible ghost text, not to the suggestion');

  await until(`!!ide.aiEdit.nes()`, 'suggestion again', 12000);
  await h.select(1, 1, 1, 1);
  await type('#');
  check(!(await js('ide.aiEdit.nes()')) && !(await js(`document.querySelector('.ai-nes-hint, .ai-nes-add')`)), 'a newer edit invalidates the shown suggestion');

  await js(`ide.settings.set('aiEdit.nes.minIntervalMs', 0)`);
  scenario({ nes: { reply: '@@ 3-3 @@ note the scaling\n-    return result\n+    return result  # scaled\n' } });
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 5 }), ide.editor.focus(), ide.editor.getContribution('snippetController2').insert('\${1:x} = \${2:y}\\n    '), true)`);
  await until(`!!ide.aiEdit.nes()`, 'suggestion during a snippet', 12000);
  await press('Tab');
  check((await js(`ide.editor.getModel().getValueInRange(ide.editor.getSelection())`)) === 'y' && !!(await js('ide.aiEdit.nes()')),
    'Tab in a snippet moves to the next tab stop, not to the suggestion');
  await js(`(ide.editor.trigger('test', 'leaveSnippet', null), true)`);

  // A suggestion that deletes the file's last lines.
  await js(`(window.__errors = [], addEventListener('error', (e) => __errors.push(e.message)), ['error', 'warn'].forEach((k) => { const f = console[k]; console[k] = (...a) => { __errors.push(String(a[0]?.message || a[0])); f.apply(console, a); }; }), true)`);
  const lastLines = (await h.text()).split('\n');
  const n = lastLines.length;
  scenario({ nes: { reply: `@@ ${n - 1}-${n} @@ drop the return\n-${lastLines[n - 2]}\n-\n` } });
  await h.select(1, 1, 1, 1);
  await type('#');
  await until(`ide.aiEdit.nes()?.line === ${n - 1}`, 'deleting suggestion', 12000);
  await press('Tab');
  await press('Tab');
  const errors = await js('__errors');
  check((await h.text()) === ['#' + lastLines[0], ...lastLines.slice(1, n - 2)].join('\n') && (await js('ide.editor.getPosition().lineNumber')) === n - 2 && errors.length === 0,
    `applying a suggestion that deletes the last lines leaves the cursor on the new last line, without errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  await js('ide.aiEdit.setNes(false)');
  await shot('ai-edit.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.close();

// ---------- Korean UI ----------
const k = await launch({ fixture: 'ai-edit', port: 9651, name: 'ai-edit-ko', lang: 'ko-KR' });
{
  const { js, until, press, type, check, shot, click } = k;
  const hk = await helpers(k);
  try {
    await openFile(k, 'shapes.py');
    await until(`ide.editor.getModel()?.getLineCount() > 10`, 'shapes.py loaded');
    await hk.select(13, 1, 19, 51);
    await press('Ctrl+I');
    await until(`!!document.querySelector('.ai-edit-widget')`, 'widget');
    const leaks = [];
    leaks.push(...await englishLeaks(k, '.ai-edit-widget'));
    scenario({ edit: { reply: [
      'class Point:', '    def __init__(self, x, y):', '        self.x = float(x)', '        self.y = y', '',
      '    def norm(self):', '        return math.hypot(self.x, self.y)', ''].join('\n') } });
    await type('부동소수점으로 바꿔 줘');
    await press('Enter');
    await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'reviewing', 20000);
    leaks.push(...await englishLeaks(k, '.ai-edit-widget'), ...await englishLeaks(k, '.ai-edit-hunk-actions'));
    await shot('review-ko.png');
    renameSync(fakeCmd, `${fakeCmd}.off`);
    await js(`document.querySelector('.ai-edit-input').focus()`);
    await type('다시');
    await press('Enter');
    await until(`!!document.querySelector('.ai-edit-status.error')`, 'not installed');
    renameSync(`${fakeCmd}.off`, fakeCmd);
    leaks.push(...await englishLeaks(k, '.ai-edit-widget'));
    check((await js(`document.querySelector('.ai-edit-status.error').textContent`)) === 'Claude Code가 설치되어 있지 않습니다.', 'the not-installed message is Korean');
    await press('Escape');
    await until(`!ide.aiEdit.session()`, 'closed');

    await click('.ai-edit-statusbar');
    await until(`!!document.querySelector('.context-menu')`, 'menu');
    leaks.push(...await englishLeaks(k, '.context-menu', ['Haiku', 'Sonnet', 'Opus']));
    await js(`ide.ui.closeMenus()`);
    check(/[가-힣]/.test(await js(`document.querySelector('.ai-edit-statusbar').title`)), 'the status bar tooltip is Korean');

    await openFile(k, 'rename.py');
    await js(`(ide.aiEdit.setNes(true), ide.settings.set('aiEdit.nes.minIntervalMs', 0), true)`);
    scenario({ nes: { reply: '@@ 2-2 @@ 바뀐 매개변수 이름 사용\n-    result = value * factor\n+    result = value * ratio\n' } });
    await hk.select(1, 18, 1, 24);
    await type('ratio');
    await until(`!!document.querySelector('.ai-nes-hint')`, 'NES hint', 10000);
    leaks.push(...await englishLeaks(k, '.ai-nes-hint'));
    check((await js(`document.querySelector('.ai-nes-key').textContent`)) === 'Tab: 이동', 'the NES hint is Korean');
    await js(`ide.openSettings('ai-edit')`);
    await until(`document.querySelector('.settings-page')?.dataset.page === 'ai-edit'`, 'AI settings page');
    check(await js(`document.querySelector('.settings-crumb').textContent.includes('AI') && document.querySelector('.settings-page [data-key="aiEdit.model"]')?.value === 'haiku'`), 'Settings › AI › Claude Edits shows the edit model and NES options');
    leaks.push(...await englishLeaks(k, '.settings-page', ['Haiku', 'Sonnet', 'Opus', 'Claude', 'Claude Code', 'CLI', 'NES', 'ms']));
    await click('.settings-page [data-key="aiEdit.nes.enabled"]');
    await click('#settingsApply');
    check(await hk.settles(`!ide.aiEdit.nes() && !document.querySelector('.ai-nes-hint') && document.querySelector('.ai-edit-statusbar').title.includes(tr('Next edit suggestions: off'))`, 'NES off'),
      'turning suggestions off in Settings removes the shown suggestion and updates the status bar');
    await press('Escape');
    check(leaks.length === 0, `Korean UI has no English leaks${leaks.length ? `: ${JSON.stringify(leaks)}` : ''}`);
    const ours = new Set([...readFileSync(new URL('../renderer/features/ai-edit/index.js', import.meta.url), 'utf8').matchAll(/\btr\('([^']*)'/g)].map((m) => m[1]));
    const missing = (await js('[...i18n.missing]')).filter((m) => ours.has(m));
    check(ours.size > 20 && missing.length === 0, `every one of the plugin's ${ours.size} UI strings has a Korean translation${missing.length ? `: ${missing.join(', ')}` : ''}`);
  } catch (err) {
    check(false, err.message);
    await shot('failure-ko.png');
  }
  k.close();
  for (const r of k.results) t.results.push(r);
  t.consoleErrors.push(...k.consoleErrors);
}

// ---------- real Claude Code (opt-in) ----------
if (process.env.AI_EDIT_REAL === '1') {
  delete process.env.PYIDE_CLAUDE_PATH;
  const r = await launch({ fixture: 'ai-edit', port: 9652, name: 'ai-edit-real' });
  const { js, until, press, type, check } = r;
  const hr = await helpers(r);
  try {
    await openFile(r, 'shapes.py');
    await until(`ide.editor.getModel()?.getLineCount() > 10`, 'shapes.py loaded');
    await hr.select(9, 1, 10, 22);
    const started = Date.now();
    await hr.edit('docstring 한 줄 추가', null);
    await until(`['reviewing', 'prompting'].includes(ide.aiEdit.session()?.phase)`, 'real answer', 120000);
    const s = await hr.session();
    console.log(`REAL edit: ${Date.now() - started} ms wall, cli ${s.ms} ms, phase ${s.phase}, message ${s.message}, hunks ${JSON.stringify(s.hunks)}`);
    check(s.phase === 'reviewing' && s.hunks.length >= 1, 'real Claude Code proposes an edit');
    check(s.hunks.every((h) => !h.oldLines.some((l) => l.startsWith('def perimeter'))) && s.hunks.some((h) => h.newLines.some((l) => /^    """/.test(l))),
      'the real edit keeps the def line and adds an indented docstring');
    await press('Escape');
    await press('Escape');
    await openFile(r, 'rename.py');
    await js(`(ide.aiEdit.setNes(true), true)`);
    await hr.select(1, 18, 1, 24);
    const nesStart = Date.now();
    await type('ratio');
    await until(`!!ide.aiEdit.nes() || /Claude/.test(document.querySelector('.ai-edit-statusbar').title.split('\\n')[2] || '')`, 'real NES answer', 90000).catch(() => {});
    const nes = await js('ide.aiEdit.nes()');
    console.log(`REAL NES: ${Date.now() - nesStart} ms wall (includes the 1 s pause), suggestion ${JSON.stringify(nes)}, status ${JSON.stringify(await js(`document.querySelector('.ai-edit-statusbar').title`))}`);
    check(!!nes, 'real Claude Code suggests the next edit after a rename');
  } catch (err) {
    check(false, err.message);
  }
  r.close();
  process.env.PYIDE_CLAUDE_PATH = fakeCmd;
  for (const x of r.results) t.results.push(x);
  t.consoleErrors.push(...r.consoleErrors);
}

// ---------- the CLI runner on its own ----------
{
  const require = createRequire(import.meta.url);
  const claudeJs = require.resolve('../main/ai/claude.js');
  const { complete } = require(claudeJs);
  const pwned = path.join(fakeDir, 'pwned-arg.txt');
  const model = `haiku&echo.>${pwned}`;
  scenario({ edit: { reply: 'ok' } });
  const n = calls().length;
  await complete({ system: 'sys', prompt: 'edit', model }).catch(() => {});
  await sleep(500);
  const args = calls()[n]?.args || [];
  t.check(!existsSync(pwned) && args[args.indexOf('--model') + 1] === model, 'arguments reach the claude.cmd shim verbatim; cmd.exe syntax in them never runs');
  t.check(await complete({ system: 'sys', prompt: 'edit', model: 'a%PATH%' }).then(() => false, (e) => e.code === 'cli'), 'an argument cmd.exe would expand (%) is refused');

  // Without taskkill on PATH, cancelling must not crash the process; the request settles once the CLI ends.
  scenario({ edit: { reply: 'never', delayMs: 60000 } });
  const m = calls().length;
  const script = `const { complete } = require(${JSON.stringify(claudeJs)}); const ctl = new AbortController(); setTimeout(() => ctl.abort(), 2500);
    complete({ system: 's', prompt: 'edit', model: 'haiku', signal: ctl.signal }).then(() => console.log('resolved'), (e) => console.log('rejected ' + e.code));`;
  const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, PATH: path.dirname(process.execPath) } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => child.on('close', r));
  await sleep(4000);
  const fake = calls()[m];
  if (fake && alive(fake.pid)) process.kill(fake.pid);
  const code = await Promise.race([exited, sleep(10000).then(() => 'hung')]);
  t.check(code === 0 && out.trim() === 'rejected cancelled', `cancelling when taskkill cannot start settles as cancelled (exit ${code}: ${out.trim() || err.match(/Error.*/)?.[0]})`);
}

t.finish();
