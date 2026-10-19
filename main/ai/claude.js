// Single-turn completions through the Claude Code CLI (`claude -p`), signed in with the user's Claude subscription.
// No tools, no session file, no hooks or CLAUDE.md: the model sees only the system prompt and the prompt on stdin.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

class ClaudeError extends Error {
  // code: 'not-installed' | 'auth' | 'cli' | 'cancelled'
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// An empty working directory, so no project settings or CLAUDE.md files are picked up.
const WORK_DIR = path.join(os.tmpdir(), 'pyide-claude');

let cachedPath = null;

// Same lookup as the terminal plugin: PYIDE_CLAUDE_PATH ('none' simulates a missing install), the official installer's
// ~/.local/bin/claude.exe, then PATH (an npm install puts a claude.cmd shim there).
function findClaude() {
  const override = process.env.PYIDE_CLAUDE_PATH;
  if (override === 'none') return null;
  if (override) return fs.existsSync(override) ? override : null;
  if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return (cachedPath = local);
  try {
    const found = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).find((p) => /\.(exe|cmd)$/i.test(p));
    return (cachedPath = found || null);
  } catch {
    return null;
  }
}

function systemPromptFile(text) {
  const file = path.join(WORK_DIR, `system-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}.txt`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return file;
}

const AUTH_ERROR = /not logged in|\/login|invalid api key|authentication|oauth|\b401\b/i;

function killTree(child) {
  if (child.exitCode === null) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
}

// -> Promise<{text, ms}>. onText(textSoFar) streams the answer as it is generated. Rejects with a ClaudeError.
function complete({ system, prompt, model = 'haiku', signal, onText }) {
  const bin = findClaude();
  if (!bin) return Promise.reject(new ClaudeError('not-installed', 'Claude Code is not installed'));
  if (signal?.aborted) return Promise.reject(new ClaudeError('cancelled', 'Cancelled'));
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, '--tools', '', '--max-turns', '1', '--safe-mode', '--no-session-persistence',
    '--system-prompt-file', systemPromptFile(system),
  ];
  // An npm install is a .cmd shim, which only runs through cmd.exe. Inside double quotes cmd.exe takes & | < > ^
  // literally, but it still expands %VAR% and a quote would end the quoted string.
  const viaShell = /\.cmd$/i.test(bin);
  const unsafe = viaShell ? [bin, ...args].find((a) => /["%\r\n]/.test(a)) : undefined;
  if (unsafe !== undefined) return Promise.reject(new ClaudeError('cli', `cannot pass ${JSON.stringify(unsafe)} to ${bin}`));
  const quote = (a) => `"${a}"`;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const child = spawn(viaShell ? quote(bin) : bin, viaShell ? args.map(quote) : args,
    { cwd: WORK_DIR, env, shell: viaShell, windowsHide: true });

  return new Promise((resolve, reject) => {
    let streamed = '';
    let sawDelta = false;
    let result = null;
    let stderr = '';
    let buffer = '';
    let failed = null;
    const onAbort = () => { failed = new ClaudeError('cancelled', 'Cancelled'); killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handle = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
        sawDelta = true;
        streamed += msg.event.delta.text;
        onText?.(streamed);
      } else if (msg.type === 'assistant' && !sawDelta) {
        streamed = (msg.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        onText?.(streamed);
      } else if (msg.type === 'result') {
        result = msg;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => {
      failed ??= err.code === 'ENOENT' ? new ClaudeError('not-installed', 'Claude Code is not installed') : new ClaudeError('cli', err.message);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (buffer.trim()) handle(buffer.trim());
      const ms = Date.now() - started;
      if (failed) return reject(failed);
      if (result && !result.is_error) return resolve({ text: typeof result.result === 'string' ? result.result : streamed, ms });
      const message = (result && String(result.result || '')) || stderr.trim().split(/\r?\n/).slice(-3).join('\n')
        || `Claude Code exited with code ${code}`;
      reject(new ClaudeError(AUTH_ERROR.test(message) ? 'auth' : 'cli', message));
    });
  });
}

module.exports = { complete, findClaude, ClaudeError };
