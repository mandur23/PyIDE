// Claude Code IDE integration: the lock file, terminals' CLAUDE_CODE_SSE_PORT, token-checked WebSocket MCP, the
// selection_changed notification, and every tool (open files, editors, selection, problems, dirty/save, diffs to
// accept or reject). The test plays Claude Code's side over a raw WebSocket. CLAUDE_IDE_REAL=1 also starts the real
// Claude Code in a PyIDE terminal and waits for it to connect (no prompt is sent, so it costs no model usage).
import { mkdtempSync, readFileSync, readdirSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const REAL = process.env.CLAUDE_IDE_REAL === '1';
// The real CLI only looks in the real lock folder; otherwise every instance shares one temp folder.
const lockDir = REAL ? path.join(homedir(), '.claude', 'ide') : mkdtempSync(path.join(tmpdir(), 'pyide-claude-ide-locks-'));
process.env.PYIDE_CLAUDE_IDE_DIR = lockDir;

// A minimal WebSocket client (masked frames, as clients must send them).
function connect(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...(token ? { 'x-claude-code-ide-authorization': token } : {}) } });
    req.on('response', (res) => resolve({ status: res.statusCode }));
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      const waiting = new Map();
      const notes = [];
      let id = 0;
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const msg = JSON.parse(buf.subarray(off, off + len).toString('utf8'));
          buf = buf.subarray(off + len);
          if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else notes.push(msg);
        }
      });
      const sendRaw = (obj) => {
        const payload = Buffer.from(JSON.stringify(obj));
        const mask = crypto.randomBytes(4);
        const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
        socket.write(Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))]));
      };
      const call = (method, params) => new Promise((r) => { const i = ++id; waiting.set(i, r); sendRaw({ jsonrpc: '2.0', id: i, method, params }); });
      const tool = async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result.content;
      resolve({ status: 101, call, tool, notes, notify: (method, params) => sendRaw({ jsonrpc: '2.0', method, params }), close: () => socket.destroy() });
    });
    req.end();
  });
}
const json = (content) => JSON.parse(content[0].text);

// Lock files a crashed Nano Studio or PyIDE left behind (its process is gone); another IDE's lock is not ours to remove.
const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
const staleLocks = REAL ? [] : [['1.lock', 'PyIDE'], ['2.lock', 'Visual Studio Code'], ['3.lock', 'Nano Studio']].map(([name, ideName]) => {
  writeFileSync(path.join(lockDir, name), JSON.stringify({ pid: deadPid, workspaceFolders: [], ideName, transport: 'ws', authToken: 'x' }));
  return path.join(lockDir, name);
});

const t = await launch({ fixture: 'core', port: 9810, name: 'claude-ide' });
const { js, until, check, shot, press } = t;
let lockPath = null;
try {
  await until(`ide.api.invoke('claudeIde:status').then(s => !!s.port)`, 'IDE server listening');
  if (staleLocks.length) {
    for (let i = 0; i < 50 && (existsSync(staleLocks[0]) || existsSync(staleLocks[2])); i++) await new Promise((r) => setTimeout(r, 100));
    check(!existsSync(staleLocks[0]) && !existsSync(staleLocks[2]) && existsSync(staleLocks[1]), 'the lock files of a Nano Studio and a PyIDE that are no longer running are removed at startup, while other IDEs keep theirs');
    unlinkSync(staleLocks[1]);
  }
  const { port } = await js(`ide.api.invoke('claudeIde:status')`);
  lockPath = path.join(lockDir, `${port}.lock`);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  check(lock.transport === 'ws' && lock.ideName === 'Nano Studio' && /^[0-9a-f]{32}$/.test(lock.authToken) && lock.workspaceFolders[0]?.toLowerCase() === t.project.toLowerCase() && lock.runningInWindows === true,
    'the lock file names Nano Studio, the project folder, a WebSocket transport and a 128-bit token');

  const denied = await connect(port, 'wrong-token');
  check(denied.status === 401, 'a connection without the token is refused');

  // ---------- terminals carry the port ----------
  await js(`ide.terminal.open({ name: 'env check', shell: 'powershell' })`);
  await until(`ide.terminal.text().includes('PS ')`, 'prompt', 30000);
  await js(`ide.api.send('pty:write', { id: ide.terminal.active().id, data: 'echo "PORT=$env:CLAUDE_CODE_SSE_PORT"\\r' })`);
  await until(`ide.terminal.text().includes('PORT=${port}')`, 'env echo', 20000);
  check(true, 'terminals get CLAUDE_CODE_SSE_PORT, so claude started there connects to this window');

  // ---------- MCP ----------
  const c = await connect(port, lock.authToken);
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
  check(init.result.serverInfo.name === 'Nano Studio' && init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools, 'initialize answers with Nano Studio and tool support');
  c.notify('notifications/initialized', {});
  await until(`!document.querySelector('#claudeIdeStatus').classList.contains('hidden')`, 'connected status');
  check(true, 'the status bar shows that Claude Code is connected');
  const tools = (await c.call('tools/list', {})).result.tools.map((x) => x.name);
  check(['openFile', 'openDiff', 'getCurrentSelection', 'getLatestSelection', 'getOpenEditors', 'getWorkspaceFolders', 'getDiagnostics',
    'checkDocumentDirty', 'saveDocument', 'close_tab', 'closeAllDiffTabs'].every((n) => tools.includes(n)), `all IDE tools are listed (${tools.length})`);

  const ws = json(await c.tool('getWorkspaceFolders'));
  check(ws.success && ws.rootPath.toLowerCase() === t.project.toLowerCase(), 'getWorkspaceFolders returns the project');

  const opened = await c.tool('openFile', { filePath: 'hello.py', startText: 'print' });
  await until(`ide.activeTab()?.title === 'hello.py'`, 'hello.py opened');
  check(opened[0].text.startsWith('Opened file:') && await js(`ide.editor.getModel().getValueInRange(ide.editor.getSelection()) === 'print'`), 'openFile opens a project-relative path and selects startText');

  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 1, 6)), true)`);
  const want = await js(`ide.editor.getModel().getValueInRange(new ide.monaco.Range(1, 1, 1, 6))`);
  await new Promise((r) => setTimeout(r, 400));
  const note = c.notes.filter((n) => n.method === 'selection_changed').pop();
  check(note && note.params.text === want && want.length === 5 && note.params.filePath.toLowerCase().endsWith('hello.py') && note.params.selection.start.line === 0 && note.params.selection.isEmpty === false,
    `a selection in the editor is sent to Claude Code as selection_changed ${JSON.stringify(note?.params || c.notes.map((n) => n.method)).slice(0, 200)}`);
  const cur = json(await c.tool('getCurrentSelection'));
  check(cur.success && cur.text === want, `getCurrentSelection returns the editor selection ${JSON.stringify(cur).slice(0, 200)} active=${await js('ide.activeTab()?.title')} focused=${await js('document.activeElement?.className')}`);
  const editors = json(await c.tool('getOpenEditors'));
  check(editors.tabs.some((x) => x.label === 'hello.py' && x.isActive), 'getOpenEditors lists the active file');

  await openFile(t, 'broken.py');
  await until(`ide.problems.all().some(p => p.path.toLowerCase().endsWith('broken.py') && p.severity === 'error')`, 'pyright errors', 60000);
  const diags = json(await c.tool('getDiagnostics'));
  check(diags.some((f) => f.uri.toLowerCase().endsWith('broken.py') && f.diagnostics.some((d) => d.severity === 'Error' && d.range.start.line >= 0)), `getDiagnostics reports the problems with severities and ranges ${JSON.stringify(diags).slice(0, 300)}`);

  await js(`(ide.editor.getModel().applyEdits([{ range: new ide.monaco.Range(1, 1, 1, 1), text: '# edited\\n' }]), true)`);
  const dirty = json(await c.tool('checkDocumentDirty', { filePath: path.join(t.project, 'broken.py') }));
  const saved = json(await c.tool('saveDocument', { filePath: path.join(t.project, 'broken.py') }));
  check(dirty.isDirty === true && saved.saved && readFileSync(path.join(t.project, 'broken.py'), 'utf8').startsWith('# edited'), 'checkDocumentDirty and saveDocument work on open files');

  // ---------- diffs ----------
  const target = path.join(t.project, 'hello.py');
  const before = readFileSync(target, 'utf8');
  const pendingAccept = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: `${before}print("from claude")\n`, tab_name: 'edit-1' });
  await until(`!!document.querySelector('#claudeDiffAccept')`, 'diff tab');
  await shot('diff.png');
  await js(`document.querySelector('#claudeDiffAccept').click()`);
  const accepted = await pendingAccept;
  check(accepted[0].text === 'FILE_SAVED' && readFileSync(target, 'utf8').endsWith('print("from claude")\n'), 'accepting a diff returns FILE_SAVED and writes the file');

  const now = readFileSync(target, 'utf8');
  const pendingReject = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'nope\n', tab_name: 'edit-2' });
  await until(`!!document.querySelector('#claudeDiffReject')`, 'second diff');
  await js(`document.querySelector('#claudeDiffReject').click()`);
  check((await pendingReject)[0].text === 'DIFF_REJECTED' && readFileSync(target, 'utf8') === now, 'rejecting a diff returns DIFF_REJECTED and leaves the file alone');

  const pendingClosed = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'x\n', tab_name: 'edit-3' });
  await until(`!!document.querySelector('#claudeDiffReject')`, 'third diff');
  const closedAll = await c.tool('closeAllDiffTabs');
  check(closedAll[0].text === 'CLOSED_1_DIFF_TABS' && (await pendingClosed)[0].text === 'DIFF_REJECTED', 'closeAllDiffTabs closes open diffs when the answer came from the terminal');

  // A second diff under an open diff's tab name replaces it: the first is answered, the second shows its own proposal.
  const models = await js('ide.monaco.editor.getModels().length');
  const first = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'first proposal', tab_name: 'same' });
  await until(`!!document.querySelector('#claudeDiffAccept')`, 'first same-name diff');
  const second = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'second proposal', tab_name: 'same' });
  check((await first)[0].text === 'DIFF_REJECTED', 'a diff replaced by one with the same tab name is answered DIFF_REJECTED');
  await until(`ide.monaco.editor.getModels().some((m) => m.getValue() === 'second proposal') && !ide.monaco.editor.getModels().some((m) => m.getValue() === 'first proposal')`, 'second proposal shown');
  await js(`document.querySelector('#claudeDiffReject').click()`);
  check((await second)[0].text === 'DIFF_REJECTED', 'the replacing diff shows its own proposal and gets its own answer');
  // Closing the tab itself answers DIFF_REJECTED and frees the diff editor's models.
  const closedTab = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'closed', tab_name: 'closed' });
  await until(`!!document.querySelector('#claudeDiffReject')`, 'diff to close');
  await js(`(ide.closeTab('claude-diff:closed'), true)`);
  check((await closedTab)[0].text === 'DIFF_REJECTED' && await js('ide.monaco.editor.getModels().length') === models, 'closing a diff tab answers DIFF_REJECTED and disposes its models');
  // A file that cannot be written keeps the diff open with a message instead of failing silently.
  const unwritable = path.join(t.project, 'no-such-folder', 'new.py');
  const failing = c.tool('openDiff', { old_file_path: unwritable, new_file_path: unwritable, new_file_contents: 'x = 1', tab_name: 'unwritable' });
  await until(`!!document.querySelector('#claudeDiffAccept')`, 'unwritable diff');
  await js(`document.querySelector('#claudeDiffAccept').click()`);
  await until(`[...document.querySelectorAll('.dialog-body')].some((b) => b.textContent.includes('new.py'))`, 'save error dialog');
  check(await js(`!!document.querySelector('#claudeDiffAccept')`), 'accepting into a path that cannot be written shows the error and keeps the diff open');
  await js(`document.querySelector('.dialog-buttons .primary').click()`);
  await js(`document.querySelector('#claudeDiffReject').click()`);
  check((await failing)[0].text === 'DIFF_REJECTED', 'the diff can still be rejected after a failed save');
} catch (err) {
  check(false, err.message);
}

t.close();
const k = await launch({ fixture: 'core', port: 9811, name: 'claude-ide-ko', lang: 'ko-KR' });
try {
  const { port } = await k.js(`ide.api.invoke('claudeIde:status')`).then((s) => s.port ? s : k.until(`ide.api.invoke('claudeIde:status').then(s => !!s.port)`, 'port').then(() => k.js(`ide.api.invoke('claudeIde:status')`)));
  const lock = JSON.parse(readFileSync(path.join(lockDir, `${port}.lock`), 'utf8'));
  const c = await connect(port, lock.authToken);
  await c.call('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  await openFile(k, 'hello.py');
  const target = path.join(k.project, 'hello.py');
  const pending = c.tool('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'print(1)\n', tab_name: 'ko' });
  await k.until(`!!document.querySelector('#claudeDiffAccept')`, 'ko diff');
  const leaks = await englishLeaks(k, '.cide-bar, #claudeIdeStatus', ['Claude', 'Code']);
  k.check(!leaks.length && await k.js(`document.querySelector('#claudeDiffAccept').textContent === '수락'`), `the diff bar is Korean${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
  await k.shot('diff-ko.png');
  // A window that reloads while Claude Code waits on a diff answers it as rejected instead of leaving the CLI hanging.
  await k.js(`(setTimeout(() => location.reload(), 50), true)`);
  const answer = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 15000))]);
  k.check(answer?.[0]?.text === 'DIFF_REJECTED' && answer[1]?.text === 'ko', `a pending diff is answered DIFF_REJECTED when the window reloads ${JSON.stringify(answer)}`);
  c.close();
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) t.results.push(r);
k.close();

// ---------- the real Claude Code ----------
if (REAL) {
  const r = await launch({ fixture: 'core', port: 9812, name: 'claude-ide-real' });
  try {
    await r.until(`ide.api.invoke('claudeIde:status').then(s => !!s.port)`, 'server');
    const { port } = await r.js(`ide.api.invoke('claudeIde:status')`);
    await r.js(`ide.runAction('ClaudeCode')`);
    await r.until(`ide.api.invoke('claudeIde:status').then(s => s.connected > 0)`, 'real Claude Code connects', 90000);
    r.check(true, `the real Claude Code connects to Nano Studio on its own (port ${port})`);
    await r.shot('real-connected.png');
  } catch (err) {
    r.check(false, err.message);
  }
  const port = await r.js(`ide.api.invoke('claudeIde:status').then(s => s.port)`).catch(() => null);
  for (const x of r.results) t.results.push(x);
  r.close();
  // A killed test instance cannot remove its own lock file.
  if (port) try { unlinkSync(path.join(lockDir, `${port}.lock`)); } catch {}
}
if (REAL && lockPath) for (const f of [lockPath]) try { unlinkSync(f); } catch {}
const failed = t.results.filter((x) => !x.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
