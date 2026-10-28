// AI Chat tool window and AI commit messages against a stand-in `claude` that answers in the CLI's stream-json format
// (PYIDE_CLAUDE_PATH, as in verify/ai-edit.mjs). Ports 9940-9941.
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the stand-in CLI ----------
const fakeDir = mkdtempSync(path.join(tmpdir(), 'pyide-fake-claude-chat-'));
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
const sysFile = args[args.indexOf('--system-prompt-file') + 1];
const system = fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : '';
const kind = system.includes('git commit messages') ? 'commit' : 'chat';
const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))[kind] || { reply: 'OK' };
fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ pid: process.pid, kind, args, stdin, system, t: Date.now() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ type: 'system', subtype: 'init', model: 'fake', tools: [] });
if (sc.error) { out({ type: 'result', subtype: 'success', is_error: true, result: sc.error }); process.exit(1); }
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
process.env.PYIDE_CLAUDE_PATH = fakeCmd;

const t = await launch({ fixture: 'ai-chat', port: 9940, name: 'ai-chat' });
const { js, until, press, type, check, shot, cdp } = t;
const state = () => js('ide.aiChat.state()');
const settles = (expr, label, ms = 5000) => until(expr, label, ms).then(() => true, () => false);
// Clicks the first element matching `selector` whose text includes `text` (any element when text is empty).
async function clickText(selector, text = '') {
  const box = await js(`(() => {
    const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent !== null && x.textContent.includes(${JSON.stringify(text)}));
    if (!n) return null;
    n.scrollIntoView({ block: 'nearest' });
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no element ${selector} with "${text}"`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(80);
}
const text = () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);

const AREA_TYPED = 'def area(w: float, h: float) -> float:\n    """Area of a rectangle."""\n    return w * h';
const REPLY = [
  '타입 힌트를 추가했습니다. **`area`** 는 이제 `float` 를 받습니다.',
  '',
  '```python path=shapes.py',
  AREA_TYPED,
  '```',
  '',
  '호출 예:',
  '',
  '```python',
  'print(perimeter(2, 3))',
  '```',
].join('\n');

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await openFile(t, 'shapes.py');
  await until(`ide.editor.getModel()?.getLineCount() > 10`, 'shapes.py loaded');
  const SHAPES = await text();

  // ---------- the tool window, its shortcut and the editor entries ----------
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 1 }), ide.editor.focus(), true)`);
  await press('Ctrl+Shift+L');
  await until(`ide.toolWindows.get('AIChat').isVisible() && document.activeElement?.classList.contains('aic-input')`, 'chat open and focused');
  const placement = await js(`(() => {
    const p = document.getElementById('rightPanel').getBoundingClientRect();
    const c = document.getElementById('center').getBoundingClientRect();
    return { right: p.left >= c.right - 1, width: p.width, stripe: !!document.querySelector('#stripeRight .stripe-btn[data-tool="AIChat"]') };
  })()`);
  check(placement.right && placement.width > 200 && placement.stripe, `Ctrl+Shift+L opens AI Chat on the right side (${Math.round(placement.width)}px, button on the right stripe)`);
  const st0 = await state();
  check(st0.chips.length === 1 && st0.chips[0].kind === 'current' && st0.chips[0].label === 'shapes.py', 'the current file is a context chip');
  await press('Ctrl+Shift+L');
  await until(`!ide.toolWindows.get('AIChat').isVisible()`, 'chat hidden');
  check(true, 'Ctrl+Shift+L again (focus in the chat) hides it');
  check(await js(`!!ide.editor.getAction('aiChat.askAboutSelection') && !!ide.editor.getAction('aiChat.open')`), 'the editor context menu has Ask AI about Selection and Open AI Chat');

  // ---------- Alt+Enter › Ask AI about Selection ----------
  // Pyright's first markers, arriving a moment after the file opens, cancel a quick fix request that is under way and
  // Monaco then says "No code actions available"; that holds for every Alt+Enter action, so wait for them.
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 30000);
  await sleep(2000);
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 3, 17)), ide.editor.focus(), true)`);
  await press('Alt+Enter');
  await until(`[...document.querySelectorAll('.action-widget [role="option"]')].some((n) => n.textContent.includes('Ask AI about Selection'))`, 'context action listed', 10000);
  check(true, 'Alt+Enter lists Ask AI about Selection for a selection');
  await clickText('.action-widget [role="option"], .action-widget .monaco-list-row', 'Ask AI about Selection');
  await until(`ide.toolWindows.get('AIChat').isVisible() && ide.aiChat.state().chips.some((c) => c.kind === 'selection')`, 'selection chip');
  const st1 = await state();
  check(st1.chips.some((c) => c.kind === 'selection' && c.label === 'shapes.py:1-3'), `Alt+Enter › Ask AI about Selection adds the selection chip (${st1.chips.map((c) => c.label).join(', ')})`);

  // ---------- @file completion ----------
  await js(`(document.querySelector('.aic-input').focus(), true)`);
  await type('@help');
  await until(`!document.querySelector('.aic-complete').classList.contains('hidden') && document.querySelector('.aic-complete-item.active')?.textContent.includes('helpers.py')`, '@ completion lists helpers.py');
  check(true, 'typing @help lists utils/helpers.py from the project files');
  await press('Enter');
  const st2 = await state();
  const inputText = await js(`document.querySelector('.aic-input').value`);
  check(st2.chips.some((c) => c.kind === 'file' && c.label === 'helpers.py') && inputText === '@utils/helpers.py ',
    `Enter on the completion adds a file chip and writes the mention (${JSON.stringify(inputText)})`);

  // ---------- send, stream ----------
  scenario({ chat: { reply: REPLY, chunkMs: 60 } });
  const question = '이 함수에 타입 힌트를 추가해 줘';
  await type(question);
  await press('Enter');
  await until(`(() => { const m = ide.aiChat.state().messages.at(-1); return m?.pending && m.text.length > 0; })()`, 'streaming reply', 15000);
  const mid = (await state()).messages.at(-1).text.length;
  check(mid > 0 && mid < REPLY.length, `the reply streams in (${mid}/${REPLY.length} characters while generating)`);
  check(await js(`document.querySelector('.aic-send').textContent === 'Stop'`), 'the Send button turns into Stop while generating');
  await until(`!ide.aiChat.state().pending`, 'reply done', 20000);
  const st3 = await state();
  check(st3.messages.length === 2 && st3.messages[1].text === REPLY && !st3.messages[1].error, 'the full reply is kept');
  const call = calls().filter((c) => c.kind === 'chat').at(-1);
  check(call.stdin.includes('<selection path="shapes.py" lines="1-3" language="python">\ndef area(w, h):\n    """Area of a rectangle."""\n    return w * h\n</selection>'),
    'the selection chip goes into the request with its lines and text');
  check(call.stdin.includes('<file path="utils/helpers.py" language="python">\ndef slugify(text):') && call.stdin.includes('<file path="shapes.py" language="python" current="true">'),
    'the @file and the current file go into the request');
  check(call.stdin.includes(question) && call.args.includes('--model') && call.args[call.args.indexOf('--tools') + 1] === '' && /AI assistant inside PyIDE/.test(call.system),
    'the question reaches Claude Code headless, without tools, with the chat system prompt');
  const dom = await js(`(() => {
    const msg = [...document.querySelectorAll('.aic-msg.assistant')].at(-1);
    return { strong: msg.querySelector('.aic-md strong')?.textContent, blocks: msg.querySelectorAll('.aic-code').length,
      buttons: [...msg.querySelectorAll('.aic-code')[0].querySelectorAll('.aic-code-btn')].map((b) => b.dataset.action + (b.disabled ? '-off' : '')),
      label: msg.querySelector('.aic-code-lang').textContent, colored: !!msg.querySelector('.aic-pre span[class^="mtk"]') };
  })()`);
  check(dom.strong === 'area' && dom.blocks === 2 && dom.label === 'shapes.py' && dom.buttons.join() === 'copy,insert,apply',
    `Markdown is rendered and code blocks get Copy / Insert at Cursor / Apply to File (${dom.buttons.join(', ')})`);
  check(dom.colored, 'code blocks are syntax-colored');
  await shot('chat.png');

  // ---------- Insert at Cursor ----------
  const lines = SHAPES.split('\n').length;
  await js(`(ide.editor.setPosition({ lineNumber: ${lines}, column: 1 }), true)`);
  await js(`([...document.querySelectorAll('.aic-msg.assistant')].at(-1).querySelectorAll('.aic-code')[1].querySelector('[data-action="insert"]').classList.add('test-insert'), true)`);
  await clickText('.test-insert');
  check((await text()) === SHAPES + 'print(perimeter(2, 3))', 'Insert at Cursor puts the code at the editor caret');
  await js(`(ide.editor.trigger('test', 'undo', null), true)`);
  check((await text()) === SHAPES, 'the insert is one undo step');

  // ---------- Apply to File (ai-edit diff preview) ----------
  await js(`([...document.querySelectorAll('.aic-msg.assistant')].at(-1).querySelector('[data-action="apply"]').click(), true)`);
  await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'apply review', 10000);
  const review = await js('ide.aiEdit.session()');
  check(review.region.start === 1 && review.region.end === 3 && review.hunks.length === 1 && review.hunks[0].newLines.join() === 'def area(w: float, h: float) -> float:',
    `Apply opens ai-edit's diff preview over the asked-about lines (region ${review.region.start}-${review.region.end}, ${review.hunks.length} hunk)`);
  check((await text()) === SHAPES && await js(`!!document.querySelector('.ai-edit-add') && !!document.querySelector('.ai-edit-accept')`), 'the file is untouched while the diff is reviewed');
  await shot('apply.png');
  await clickText('.ai-edit-accept');
  await until(`!ide.aiEdit.session()`, 'review closed');
  check((await text()) === SHAPES.replace('def area(w, h):', 'def area(w: float, h: float) -> float:'), 'accepting the preview applies the block');

  // ---------- history survives a reload ----------
  await js('ide.saveAll()');
  await js('ide.aiChat.saved()');
  await cdp('Page.reload');
  await sleep(1500);
  await until('window.__ideReady === true', 'IDE ready after reload', 40000);
  await until(`ide.aiChat.state().messages.length === 2`, 'history loaded', 10000);
  const st4 = await state();
  check(st4.messages[0].text === `@utils/helpers.py ${question}` && st4.messages[1].text === REPLY && st4.messages[0].context.some((c) => c.kind === 'selection' && c.startLine === 1),
    'the conversation and its context survive a reload');
  await js(`(ide.toolWindows.get('AIChat').show(), true)`);
  check(await js(`document.querySelectorAll('.aic-msg').length === 2 && !!document.querySelector('.aic-msg.assistant .aic-code')`), 'the reloaded chat is drawn with its code blocks');

  // ---------- Apply without a selection finds the method ----------
  await openFile(t, 'shapes.py');
  scenario({ chat: { reply: 'Docstring:\n\n```python\ndef volume(self, d):\n    """Volume of the box."""\n    return self.w * self.h * d\n```\n' } });
  await js(`ide.aiChat.send('volume에 docstring 추가')`);
  await until(`!ide.aiChat.state().pending && ide.aiChat.state().messages.length === 4`, 'second reply', 15000);
  await js(`([...document.querySelectorAll('.aic-msg.assistant')].at(-1).querySelector('[data-action="apply"]').click(), true)`);
  await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'method review', 10000);
  const r2 = await js('ide.aiEdit.session()');
  check(r2.region.start === 15 && r2.region.end === 16 && r2.hunks.length === 1 && r2.hunks[0].newLines.join('|') === '        """Volume of the box."""',
    `Apply without a selection replaces the method it redefines, at the method's indentation (region ${r2.region.start}-${r2.region.end})`);
  await press('Escape');
  await until(`!ide.aiEdit.session()`, 'review rejected');

  // ---------- history: new chat and switching back ----------
  const firstId = (await state()).current;
  await js(`(ide.aiChat.newChat(), true)`);
  check((await state()).messages.length === 0 && await js(`!!document.querySelector('.aic-empty')`), 'New Chat starts an empty conversation');

  // ---------- Stop ----------
  const LONG = 'Lorem ipsum dolor sit amet. '.repeat(30);
  scenario({ chat: { reply: LONG, chunkMs: 150 } });
  await js(`(document.querySelector('.aic-input').focus(), true)`);
  await type('길게 답해 줘');
  await press('Enter');
  await until(`(ide.aiChat.state().messages.at(-1)?.text.length || 0) > 20`, 'long reply streaming', 15000);
  const pid = calls().at(-1).pid;
  await clickText('.aic-send');
  await until(`!ide.aiChat.state().pending`, 'stopped', 10000);
  const stopped = (await state()).messages.at(-1);
  await sleep(700);
  const later = (await state()).messages.at(-1);
  check(stopped.stopped && stopped.text.length < LONG.length && later.text === stopped.text, `Stop cancels the reply and keeps what came (${stopped.text.length}/${LONG.length})`);
  check(await settles(`${!alive(pid)}`, 'fake CLI gone', 4000) || !alive(pid), 'Stop ends the Claude Code process');
  check(await js(`document.querySelector('.aic-msg.assistant:last-child .aic-note')?.textContent === 'Stopped.'`), 'the stopped reply is marked');
  await js(`(ide.aiChat.newChat(), true)`);
  await js('ide.aiChat.saved()');
  const hist = await js(`ide.api.invoke('ai-chat:loadHistory', ide.root)`);
  check(hist.chats.length === 2 && hist.chats.some((c) => c.id === firstId && c.messages.length === 4), `chats are saved per project (${hist.chats.length} chats)`);

  // ---------- opening another project while a reply streams ----------
  await js('ide.saveAll()');
  const home = t.project;
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'pyide-ai-chat-other-'));
  writeFileSync(path.join(elsewhere, 'other.py'), 'x = 1\n');
  scenario({ chat: { reply: LONG, chunkMs: 150 } });
  await js(`(document.querySelector('.aic-input').focus(), true)`);
  await type('switch test');
  await press('Enter');
  await until(`(ide.aiChat.state().messages.at(-1)?.text.length || 0) > 20`, 'reply streaming before the switch', 15000);
  await js(`(ide.ui.confirm = async () => true, ide.openProject(${JSON.stringify(elsewhere)}).then(() => true))`);
  await until(`!ide.aiChat.state().pending && ide.aiChat.state().root?.toLowerCase() === ${JSON.stringify(elsewhere.toLowerCase())}`, 'other project loaded', 10000);
  check((await state()).messages.length === 0, 'the other project starts with its own chats, and is not blocked by the reply of the previous one');
  await js('ide.aiChat.saved()');
  const homeHist = await js(`ide.api.invoke('ai-chat:loadHistory', ${JSON.stringify(home)})`);
  const asked = homeHist.chats.find((c) => c.messages.some((m) => m.text === 'switch test'));
  const answer = asked?.messages.at(-1);
  check(answer?.role === 'assistant' && answer.stopped && answer.text.length > 20 && homeHist.chats.length === 3,
    `the reply in progress is stopped and kept in the previous project's history (${answer?.text.length} chars, ${homeHist.chats.length} chats)`);
  await js(`ide.openProject(${JSON.stringify(home)}).then(() => true)`);
  await until(`ide.aiChat.state().root?.toLowerCase() === ${JSON.stringify(home.toLowerCase())}`, 'back to the project', 10000);

  // ---------- commit message from the staged diff ----------
  await js('ide.saveAll()');
  const git = (...a) => execFileSync('git', a, { cwd: t.project, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  appendFileSync(path.join(t.project, 'utils', 'helpers.py'), '\n\ndef titleize(text):\n    return text.title()\n');
  git('add', 'utils/helpers.py');
  appendFileSync(path.join(t.project, 'README.md'), 'unstaged line\n');
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await js('ide.vcs.refresh()');
  await until(`!!document.querySelector('.vcs-msg-box .aic-commit-gen') && ide.vcs.repo()?.files.length === 2`, 'commit window with the ✨ button');
  const MSG = 'feat(utils): 문자열을 제목 형식으로 바꾸는 titleize 추가';
  scenario({ commit: { reply: '```\n' + MSG + '\n```', chunkMs: 80 } });
  await clickText('.aic-commit-gen');
  await until(`ide.aiChat.state().commitPending && document.querySelector('.vcs-msg').value.length > 0`, 'commit message streaming', 15000);
  const partial = await js(`document.querySelector('.vcs-msg').value`);
  check(partial.length > 0 && partial.length < MSG.length, `the message streams into the box (${JSON.stringify(partial)})`);
  await until(`!ide.aiChat.state().commitPending`, 'commit message done', 15000);
  const box = await js(`(() => { const b = document.querySelector('.vcs-msg'); return { value: b.value, editable: !b.readOnly && !b.disabled, focused: document.activeElement === b }; })()`);
  check(box.value === MSG && box.editable, `✨ fills the commit message box, fences stripped, and it stays editable (${JSON.stringify(box.value)})`);
  const cc = calls().filter((c) => c.kind === 'commit').at(-1);
  check(cc.stdin.includes('diff --git a/utils/helpers.py b/utils/helpers.py') && cc.stdin.includes('+def titleize(text):') && !cc.stdin.includes('unstaged line'),
    'the request carries the staged diff only');
  check(/Conventional Commits/.test(cc.system) && /in Korean/.test(cc.system), 'the prompt asks for a conventional message in Korean (the default)');
  await type(' (수정)');
  check((await js(`document.querySelector('.vcs-msg').value`)) === MSG + ' (수정)', 'the generated message can be edited');

  // nothing staged: the ticked changes
  git('commit', '-qm', 'helpers');
  await js(`(document.querySelector('.vcs-msg').value = '', true)`);
  writeFileSync(path.join(t.project, 'notes.txt'), 'untracked\n');
  await js('ide.vcs.refresh()');
  await until(`ide.vcs.repo()?.files.length === 2`, 'two changes');
  scenario({ commit: { reply: 'docs: README 줄 추가' } });
  await js('ide.aiChat.generateCommitMessage()');
  const sel = calls().filter((c) => c.kind === 'commit').at(-1);
  check(sel.stdin.includes('diff --git a/README.md b/README.md') && sel.stdin.includes('+unstaged line') && !sel.stdin.includes('notes.txt'),
    'with nothing staged it uses the changes ticked in the Commit window (unversioned files stay out)');
  check((await js(`document.querySelector('.vcs-msg').value`)) === 'docs: README 줄 추가', 'and fills the box');

  // a huge staged diff, in English
  writeFileSync(path.join(t.project, 'big.py'), Array.from({ length: 20000 }, (_, i) => `value_${i} = ${i}  # generated line`).join('\n') + '\n');
  git('add', 'big.py');
  await js(`(ide.settings.set('aiChat.commitLanguage', 'en'), true)`);
  scenario({ commit: { reply: 'chore: add generated values' } });
  await js('ide.aiChat.generateCommitMessage()');
  const big = calls().filter((c) => c.kind === 'commit').at(-1);
  check(big.stdin.length < 25000 && /more lines truncated/.test(big.stdin) && big.stdin.includes('big.py') && big.stdin.includes('+value_0 = 0'),
    `a huge diff is cut at line boundaries before it is sent (${big.stdin.length} characters for a ${20000 * 34}-character file)`);
  check(/in English/.test(big.system) && (await js(`document.querySelector('.vcs-msg').value`)) === 'chore: add generated values', 'the language setting switches the message to English');
  // Only the start of a huge diff is read: git is stopped once enough has come, instead of buffering all of it.
  const { git: readGit } = createRequire(import.meta.url)('../main/features/ai-chat.js');
  const head = await readGit(t.project, ['diff', '--cached'], { maxBytes: 4096 });
  check(head.capped && head.out.startsWith('diff --git') && head.out.length < 4096 + 65536, `reading a diff stops at the size limit (${head.out.length} characters read)`);
  await shot('commit.png');

  // ---------- an expired sign-in offers to sign in again ----------
  await js(`(ide.aiChat.newChat(), true)`);
  scenario({ chat: { error: 'Failed to authenticate: OAuth session expired and could not be refreshed' } });
  await js(`ide.aiChat.send('hello')`);
  await until(`!!document.querySelector('.aic-note.error .aic-login')`, 'sign-in button in the chat', 15000);
  check((await js(`document.querySelector('.aic-note.error').textContent`)).includes('its sign-in has expired'), 'an expired CLI sign-in is explained, not just "not signed in"');
  await js(`document.querySelector('.aic-note.error .aic-login').click()`);
  await until(`ide.terminal.sessions().some(s => s.kind === 'claude-login')`, 'sign-in terminal', 15000);
  check(await js(`ide.terminal.sessions().find(s => s.kind === 'claude-login').name === 'Sign in to Claude Code'`), 'Sign in to Claude Code opens a terminal tab running claude auth login');
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}

// ---------- Korean ----------
const k = await launch({ fixture: 'ai-chat', port: 9941, name: 'ai-chat-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.toolWindows.get('AIChat').show(), true)`);
  await k.until(`!!document.querySelector('.aic-empty')`, 'empty chat');
  const leaks = await englishLeaks(k, '#rightPanel');
  t.check(!leaks.length, `the chat window is in Korean (${leaks.map((l) => l.text).join(' | ') || 'no English left'})`);
  t.check(await k.js(`document.querySelector('.aic-send').textContent === '보내기' && document.getElementById('rightTitle').textContent === 'AI 채팅'`), 'Send and the title are translated');
} catch (err) {
  t.check(false, err.message);
}
for (const e of k.consoleErrors) t.consoleErrors.push(`[ko] ${e}`);
k.close();
t.finish();
