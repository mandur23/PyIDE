// AI Chat and commit messages: conversations with Claude about the project, per-project chat history, and commit
// messages written from the staged diff. Every model call goes through the Claude Code CLI (main/ai/claude.js), like
// the ai-edit plugin; tests swap the CLI with PYIDE_CLAUDE_PATH.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { complete } = require('../ai/claude');
const trust = require('../trust');

const CHAT_SYSTEM = `You are the AI assistant inside PyIDE, a Python IDE. The user asks about their project; files and selections they attached are given as context.
Answer in Markdown and keep answers focused. Put code in fenced code blocks with a language tag.
When you change code from a file, show the complete changed function, class or file in one block, and write the file's project-relative path after the language in the fence info, like \`\`\`python path=src/app.py
Answer in the language the user writes in.`;

const LANGUAGES = { ko: 'Korean', en: 'English' };
const commitSystem = (lang) => `You write git commit messages from a diff.
Use the Conventional Commits format: "type(scope): summary", with type one of feat, fix, refactor, perf, docs, test, style, build, ci, chore. The scope is optional.
The summary line is at most 72 characters, says what the change does, and has no trailing period.
Add a blank line and a short body of one to three "- " bullet points only when the summary alone does not explain the change.
Write the summary and the body in ${LANGUAGES[lang] || LANGUAGES.ko}. Keep the type, the scope, code identifiers and file names as they are.
Reply with only the commit message: no code fences, no quotes, nothing before or after it.`;

// Claude Code model ids and aliases; the value ends up on a command line.
const MODEL_ID = /^[\w.\-[\]]+$/;
const MAX_FILE_CHARS = 40000;
const MAX_HISTORY_CHARS = 60000;

function chatPrompt({ messages, context = [] }) {
  const parts = [];
  if (context.length) {
    parts.push('Context attached by the user:');
    for (const c of context) {
      const cut = c.truncated ? ' truncated="true"' : '';
      if (c.kind === 'selection') parts.push(`<selection path="${c.path}" lines="${c.startLine}-${c.endLine}" language="${c.language}">\n${c.text}\n</selection>`);
      else parts.push(`<file path="${c.path}" language="${c.language}"${c.current ? ' current="true"' : ''}${cut}>\n${c.text}\n</file>`);
    }
    parts.push('');
  }
  // Older turns are dropped first once the conversation is long; the last message is always sent.
  const turns = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.text}`);
  let kept = [turns.pop()];
  let size = kept[0].length;
  while (turns.length && size + turns[turns.length - 1].length < MAX_HISTORY_CHARS) {
    size += turns[turns.length - 1].length;
    kept.unshift(turns.pop());
  }
  if (kept.length > 1) parts.push('The conversation so far, oldest first:', '', ...kept.slice(0, -1).flatMap((t) => [t, '']));
  parts.push('Reply to this message from the user:', kept[kept.length - 1].replace(/^User:\n/, ''));
  return parts.join('\n');
}

// ---------- git ----------
// maxBytes: stop reading (and stop git) once this much output has come; the result then has capped: true.
function git(cwd, args, { input, maxBytes = Infinity } = {}) {
  // As in git.js: an untrusted repository's config could run programs through git.
  if (!trust.isTrusted(cwd)) return Promise.resolve({ code: -1, out: '' });
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], {
      cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    const out = [];
    let size = 0;
    let capped = false;
    child.stdout.on('data', (d) => {
      if (capped) return;
      out.push(d);
      size += d.length;
      if (size > maxBytes) { capped = true; child.kill(); }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ code: -1, out: '', capped }));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8'), capped }));
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input, 'utf8'); else child.stdin.end();
  });
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M'];
const MAX_DIFF_CHARS = 16000;
// Only the start of a huge diff reaches the prompt, so only that much is read: a diff of generated or data files
// can be hundreds of megabytes.
const MAX_DIFF_READ = 4 * 1024 * 1024;
const MAX_SECTION_CHARS = 3000;

// Cuts at a line boundary and says how much was left out.
function cutLines(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const kept = head.slice(0, Math.max(0, head.lastIndexOf('\n')));
  const dropped = text.slice(kept.length).split('\n').length - 1;
  return `${kept}\n… (${dropped} more lines truncated)\n`;
}

// A large diff keeps every file's header and the start of its hunks, so the model still sees what changed where.
function truncateDiff(diff, max = MAX_DIFF_CHARS) {
  if (diff.length <= max) return { text: diff, truncated: false };
  const sections = diff.split(/^(?=diff --git )/m);
  const out = [];
  let size = 0;
  const skipped = [];
  for (const s of sections) {
    const piece = cutLines(s, MAX_SECTION_CHARS);
    if (size + piece.length > max) { skipped.push(s.match(/^diff --git a\/(.*?) b\//)?.[1] || '?'); continue; }
    out.push(piece);
    size += piece.length;
  }
  if (skipped.length) out.push(`… (${skipped.length} more files not shown: ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ', …' : ''})\n`);
  return { text: out.join(''), truncated: true };
}

// An untracked file as an all-added diff (git diff only covers tracked files).
function newFileDiff(top, rel) {
  let buf;
  try {
    const fd = fs.openSync(path.join(top, rel), 'r');
    buf = Buffer.alloc(64 * 1024);
    buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    fs.closeSync(fd);
  } catch { return ''; }
  const head = `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n`;
  if (buf.includes(0)) return `${head}Binary file\n`;
  return head + buf.toString('utf8').replace(/\r\n/g, '\n').split('\n').map((l) => `+${l}`).join('\n') + '\n';
}

// The staged diff, or the diff of the given files (the changes ticked in the Commit window) when nothing is staged.
// files: [{path, status}] with absolute paths.
async function collectDiff(root, files) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).out.trim();
  if (!top) return { ok: false, code: 'not-repo', message: 'not a Git repository' };
  const staged = await git(top, ['diff', '--cached', ...DIFF_FLAGS], { maxBytes: MAX_DIFF_READ });
  if (staged.out.trim()) {
    const stat = (await git(top, ['diff', '--cached', '--stat=100', '--no-color'], { maxBytes: MAX_DIFF_READ })).out;
    return { ok: true, source: 'staged', stat, ...truncateDiff(staged.out) };
  }
  const rels = files.map((f) => ({ ...f, rel: path.relative(top, f.path).replace(/\\/g, '/') })).filter((f) => f.rel && !f.rel.startsWith('..'));
  if (!rels.length) return { ok: false, code: 'empty', message: 'no changes' };
  const tracked = rels.filter((f) => f.status !== 'unversioned');
  const hasHead = (await git(top, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 0;
  let diff = '';
  // git diff takes no --pathspec-from-file; batches keep the command line short.
  for (let i = 0; i < tracked.length && diff.length < MAX_DIFF_READ; i += 50) {
    const args = ['--literal-pathspecs', 'diff', ...(hasHead ? ['HEAD'] : []), ...DIFF_FLAGS, '--', ...tracked.slice(i, i + 50).map((f) => f.rel)];
    diff += (await git(top, args, { maxBytes: MAX_DIFF_READ - diff.length })).out;
  }
  for (const f of rels.filter((x) => x.status === 'unversioned').slice(0, 50)) {
    if (diff.length >= MAX_DIFF_READ) break;
    diff += newFileDiff(top, f.rel);
  }
  if (!diff.trim()) return { ok: false, code: 'empty', message: 'no changes' };
  const stat = rels.map((f) => `${f.status} ${f.rel}`).join('\n') + '\n';
  return { ok: true, source: 'selected', stat, ...truncateDiff(diff) };
}

function commitPrompt({ stat, text, truncated }) {
  return [
    'Changed files:', cutLines(stat, 4000), '',
    truncated ? 'The diff (shortened; parts are left out where marked):' : 'The diff:',
    text,
  ].join('\n');
}

// The model's answer as a commit message: no fences, quotes or "Commit message:" preamble.
function cleanMessage(raw) {
  let t = raw.replace(/\r\n?/g, '\n').trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)(\n```|$)/);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(commit message|커밋 메시지)\s*:\s*/i, '');
  if (/^(["'`]).*\1$/s.test(t) && !t.slice(1, -1).includes(t[0])) t = t.slice(1, -1).trim();
  return t.replace(/\n{3,}/g, '\n\n');
}

// ---------- history ----------
// <userData>/ai-chat/<project id>.json: {root, current, chats: [{id, title, created, updated, messages}]}
function historyFile(app, root) {
  const id = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'ai-chat', `${id}.json`);
}

exports.register = ({ ipcMain, app }) => {
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

  const streamTo = (e, channel, reqId, map = (t) => t) => (text) => {
    if (!e.sender.isDestroyed()) e.sender.send(channel, { reqId, text: map(text) });
  };

  // req: {reqId, model, messages: [{role, text}], context: [{kind, path, language, text, startLine?, endLine?, current?, truncated?}]}
  ipcMain.handle('ai-chat:send', async (e, req) => {
    const context = (req.context || []).map((c) => (c.text.length > MAX_FILE_CHARS ? { ...c, text: c.text.slice(0, MAX_FILE_CHARS), truncated: true } : c));
    const r = await run(req.reqId, {
      system: CHAT_SYSTEM, prompt: chatPrompt({ messages: req.messages, context }), model: req.model, timeoutMs: 300000,
      onText: streamTo(e, 'ai-chat:stream', req.reqId),
    });
    return r.ok ? { ok: true, text: r.text, ms: r.ms } : r;
  });

  // req: {reqId, root, files: [{path, status}], language: 'ko'|'en', model}
  ipcMain.handle('ai-chat:commitMessage', async (e, req) => {
    const diff = await collectDiff(req.root, req.files || []);
    if (!diff.ok) return diff;
    const r = await run(req.reqId, {
      system: commitSystem(req.language), prompt: commitPrompt(diff), model: req.model, timeoutMs: 120000,
      onText: streamTo(e, 'ai-chat:commit-stream', req.reqId, cleanMessage),
    });
    return r.ok ? { ok: true, text: cleanMessage(r.text), source: diff.source, truncated: diff.truncated, ms: r.ms } : r;
  });

  ipcMain.handle('ai-chat:cancel', (_e, reqId) => { running.get(reqId)?.abort(); });

  ipcMain.handle('ai-chat:loadHistory', (_e, root) => {
    try { return JSON.parse(fs.readFileSync(historyFile(app, root), 'utf8')); } catch { return null; }
  });

  ipcMain.handle('ai-chat:saveHistory', (_e, root, data) => {
    const file = historyFile(app, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, root }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  });
};

exports.chatPrompt = chatPrompt;
exports.truncateDiff = truncateDiff;
exports.cleanMessage = cleanMessage;
exports.collectDiff = collectDiff;
exports.git = git;
