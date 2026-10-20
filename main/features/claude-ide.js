// Claude Code IDE integration, the way the official VS Code and JetBrains extensions do it: an MCP server over
// WebSocket on 127.0.0.1 plus a lock file in ~/.claude/ide/<port>.lock. Terminals started by PyIDE get
// CLAUDE_CODE_SSE_PORT, so `claude` in them connects to this window on its own: it sees the open files, the current
// selection and the problems, opens files here, and shows its edits as diffs to accept or reject in the IDE.
// Tool calls are answered by the renderer (renderer/features/claude-ide); this file owns the socket and the lock file.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PROTOCOL = '2025-03-26';
const TOOLS = [
  { name: 'openFile', description: 'Open a file in the editor and optionally select a range of text',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, preview: { type: 'boolean' }, startText: { type: 'string' },
      endText: { type: 'string' }, selectToEndOfLine: { type: 'boolean' }, makeFrontmost: { type: 'boolean' } }, required: ['filePath'] } },
  { name: 'openDiff', description: 'Show a diff of proposed changes and wait until the user accepts or rejects them',
    inputSchema: { type: 'object', properties: { old_file_path: { type: 'string' }, new_file_path: { type: 'string' },
      new_file_contents: { type: 'string' }, tab_name: { type: 'string' } }, required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'] } },
  { name: 'getCurrentSelection', description: 'Get the current text selection in the active editor', inputSchema: { type: 'object', properties: {} } },
  { name: 'getLatestSelection', description: 'Get the most recent text selection, even if the editor is no longer active', inputSchema: { type: 'object', properties: {} } },
  { name: 'getOpenEditors', description: 'Get the files open in editor tabs', inputSchema: { type: 'object', properties: {} } },
  { name: 'getWorkspaceFolders', description: 'Get the project folders', inputSchema: { type: 'object', properties: {} } },
  { name: 'getDiagnostics', description: 'Get errors and warnings for a file or all files',
    inputSchema: { type: 'object', properties: { uri: { type: 'string' } } } },
  { name: 'checkDocumentDirty', description: 'Check whether a file has unsaved changes',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
  { name: 'saveDocument', description: 'Save a file that has unsaved changes',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
  { name: 'close_tab', description: 'Close a tab by name', inputSchema: { type: 'object', properties: { tab_name: { type: 'string' } }, required: ['tab_name'] } },
  { name: 'closeAllDiffTabs', description: 'Close every diff tab', inputSchema: { type: 'object', properties: {} } },
];

let server = null;
let port = null;
const authToken = crypto.randomBytes(16).toString('hex');
// PYIDE_CLAUDE_IDE_DIR keeps test instances out of the user's real lock folder (verify/lib.mjs sets it).
const lockDir = () => process.env.PYIDE_CLAUDE_IDE_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide');

// The environment for terminals: empty until the server listens, or when the plugin is disabled.
exports.ideEnv = () => (port ? { CLAUDE_CODE_SSE_PORT: String(port), ENABLE_IDE_INTEGRATION: 'true' } : {});

// ---------- WebSocket (RFC 6455), server side only: text frames, ping/pong, close ----------
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

function acceptSocket(socket, onText, onClose) {
  let buf = Buffer.alloc(0);
  let parts = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); return; }
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      parts.push(payload);
      if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; onText(text); }
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => socket.destroy());
  return (text) => { if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(text, 'utf8'))); };
}

exports.register = ({ ipcMain, app, send }) => {
  const clients = new Set(); // {send}
  let workspaceFolders = [];
  let seq = 0;
  const pendingCalls = new Map(); // id -> resolve

  const writeLock = () => {
    if (!port) return;
    try {
      fs.mkdirSync(lockDir(), { recursive: true });
      fs.writeFileSync(path.join(lockDir(), `${port}.lock`), JSON.stringify({
        pid: process.pid, workspaceFolders, ideName: 'PyIDE', transport: 'ws', runningInWindows: process.platform === 'win32', authToken,
      }));
    } catch (err) { console.error('claude-ide: cannot write the lock file', err); }
  };
  const removeLock = () => { if (port) try { fs.unlinkSync(path.join(lockDir(), `${port}.lock`)); } catch {} };
  // A PyIDE that crashed or was killed never removed its lock file, and Claude Code would keep offering that window.
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
  const removeStaleLocks = async () => {
    for (const name of await fs.promises.readdir(lockDir()).catch(() => [])) {
      if (!name.endsWith('.lock')) continue;
      const file = path.join(lockDir(), name);
      try {
        const lock = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (lock.ideName === 'PyIDE' && Number.isInteger(lock.pid) && lock.pid !== process.pid && !alive(lock.pid)) await fs.promises.unlink(file);
      } catch {}
    }
  };
  const status = () => send('claudeIde:status', { port, connected: clients.size });

  // A tool call answered by the main window's renderer; openDiff stays pending until the user decides.
  const callRenderer = (name, args) => new Promise((resolve) => {
    const id = ++seq;
    pendingCalls.set(id, resolve);
    send('claudeIde:call', { id, name, args });
  });
  ipcMain.on('claudeIde:result', (_e, { id, content }) => {
    const resolve = pendingCalls.get(id);
    pendingCalls.delete(id);
    resolve?.(content);
  });

  async function handle(msg, reply) {
    const { id, method, params = {} } = msg;
    const ok = (result) => id !== undefined && reply(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (method === 'initialize') {
      return ok({ protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'PyIDE', version: app.getVersion() } });
    }
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      if (!TOOLS.some((t) => t.name === params.name)) {
        return reply(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool ${params.name}` } }));
      }
      const content = await callRenderer(params.name, params.arguments || {});
      return ok({ content });
    }
    if (method === 'ping') return ok({});
    if (method === 'ide_connected') { send('claudeIde:connected', params); return undefined; }
    if (id !== undefined && !String(method).startsWith('notifications/')) {
      reply(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }));
    }
    return undefined;
  }

  server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    // Only Claude Code holding this window's token may connect; anything else on this machine is refused.
    if (req.headers['x-claude-code-ide-authorization'] !== authToken || !req.headers['sec-websocket-key']) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = {};
    client.send = acceptSocket(socket, (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      handle(msg, client.send).catch((err) => console.error('claude-ide:', err));
    }, () => { clients.delete(client); status(); });
    clients.add(client);
    status();
  });
  server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    writeLock();
    status();
    removeStaleLocks();
  });
  server.on('error', (err) => console.error('claude-ide: server error', err));

  const notify = (method, params) => {
    const text = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const c of clients) c.send(text);
  };
  ipcMain.on('claudeIde:workspace', (_e, folders) => { workspaceFolders = folders.filter(Boolean); writeLock(); });
  ipcMain.on('claudeIde:notify', (_e, { method, params }) => {
    if (method === 'selection_changed' || method === 'at_mentioned') notify(method, params);
  });
  ipcMain.handle('claudeIde:status', () => ({ port, connected: clients.size }));
  app.on('will-quit', () => { removeLock(); server?.close(); });
  process.on('exit', removeLock);
};
