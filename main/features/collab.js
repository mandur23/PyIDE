// Real-time collaboration in Code (docs/collab-coding-plan.md): this process is either the host of a session (its
// project, its windows, its language servers) or one guest of another's, never both. The renderer side is
// renderer/features/collab. The session itself is main/collab: host.js and guest.js over link.js.
//
// Channels: collab:state, collab:start, collab:stop, collab:answer (accept or decline a guest), collab:setRole,
// collab:kick, collab:join, collab:leave, collab:tree, and the sends collab:cursor, collab:view. Events go to the main
// window as collab:event {type, ...}. A guest's documents are collab://<session>/<project-relative path>: their doc:*
// messages (main/windows.js) are routed here and on to the host, never to a file.
// PYIDE_BORE (tests): the bore client to run, as for port sharing. PYIDE_COLLAB_BIND, PYIDE_COLLAB_LAN_HOST (tests):
// where a same-network session listens and what address its code names. PYIDE_COLLAB_TEST: collab:testDrop works.
const { spawn } = require('child_process');
const { shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHost } = require('../collab/host');
const { createGuest, makeCode } = require('../collab/guest');
const P = require('../collab/protocol');
const textCodec = require('../text-codec');
const { guestPorts } = require('../collab/share');
const terminal = require('./terminal');

const BORE_SERVER = 'bore.pub';
const BORE_RE = /listening at ([\w.-]+:\d+)/;
const TUNNEL_MS = 20000;
const TREE_MS = 15000;

const standIn = (env) => {
  try { const argv = JSON.parse(process.env[env] || ''); if (Array.isArray(argv) && argv.length) return argv; } catch {}
  return null;
};
// This computer's private IPv4 address that others on the same network reach, or null.
function lanAddress() {
  if (process.env.PYIDE_COLLAB_LAN_HOST) return process.env.PYIDE_COLLAB_LAN_HOST;
  const priv = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && priv(i.address)) return i.address;
  }
  return null;
}
const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
const expected = (message, code) => ({ error: message, code });

// A file or folder a guest deleted goes to the Recycle Bin; PYIDE_COLLAB_TRASH (tests): to that folder instead.
const trash = (abs) => (process.env.PYIDE_COLLAB_TRASH
  ? fs.promises.rename(abs, path.join(process.env.PYIDE_COLLAB_TRASH, `${Date.now()}-${path.basename(abs)}`))
  : shell.trashItem(abs));

exports.register = ({ ipcMain, app, send, unpackedDir, windows, diagnostics }) => {
  const log = (m) => diagnostics?.logger?.('#collab')?.info?.(m);
  const version = app.getVersion();
  let host = null; // {session (createHost), root, code, mode, tunnel}
  let guest = null; // {session (createGuest), name, info (the welcome), docs: Map(rel lower -> webContents)}
  const event = (e) => send('collab:event', e);

  const state = () => (host ? { role: 'host', code: host.code, mode: host.mode, root: host.root, people: host.session.people(), pending: host.session.guests.filter((g) => g.state === 'pending').map((g) => ({ id: g.id, name: g.name })) }
    : guest ? { role: 'guest', sid: guest.session.sid, state: guest.session.state, hostName: guest.session.hostName, info: guest.info, name: guest.name } : { role: null });

  // ---------- host ----------
  function tunnel(port) {
    const argv = standIn('PYIDE_BORE') || [process.execPath, path.join(unpackedDir, 'main', 'bore-client.js')];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(argv[0], [...argv.slice(1), 'local', String(port), '--local-host', '127.0.0.1', '--to', BORE_SERVER],
          { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' } });
      } catch (err) { return reject(new Error(err.code || err.message)); }
      let out = '';
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new Error('no answer from bore.pub')); } }, TUNNEL_MS);
      const read = (chunk) => {
        out = (out + chunk.toString()).slice(-4000);
        const m = BORE_RE.exec(out);
        if (m && !done) { done = true; clearTimeout(timer); resolve({ child, address: m[1] }); }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
      child.on('exit', (code) => {
        if (!done) { done = true; clearTimeout(timer); return reject(new Error(out.trim().split(/\r?\n/).pop() || `bore exited with code ${code}`)); }
        if (host?.tunnel?.child === child) event({ type: 'tunnel', state: 'failed', error: out.trim().split(/\r?\n/).pop() || '' });
        return undefined;
      });
    });
  }

  ipcMain.handle('collab:start', async (_e, opts = {}) => {
    if (host || guest) return expected('A collaboration session is already open in this window', 'busy');
    const root = typeof opts.root === 'string' ? opts.root : '';
    try { if (!root || !(await fs.promises.stat(root)).isDirectory()) throw new Error(); } catch { return expected('Open a project to share first', 'noProject'); }
    const mode = opts.mode === 'lan' ? 'lan' : 'internet';
    const hidden = Array.isArray(opts.hidden) ? opts.hidden.map((h) => oneLine(h, 200)).filter(Boolean).slice(0, 200) : P.DEFAULT_HIDDEN;
    const hostName = oneLine(opts.name, 40) || os.userInfo().username || 'Host';
    const bind = mode === 'lan' ? process.env.PYIDE_COLLAB_BIND || '0.0.0.0' : '127.0.0.1';
    const session = createHost({ root, sharedDocs: windows.sharedDocs, hidden, hostName, version, bind, onEvent: event, log, trash, terminal });
    const starting = { session, root, mode, code: null, tunnel: null };
    host = starting;
    try {
      const port = await session.listen();
      let address;
      if (mode === 'lan') {
        const lan = lanAddress();
        if (!lan) throw Object.assign(new Error('This computer has no address on a local network'), { code: 'noLan' });
        address = `${lan}:${port}`;
      } else {
        starting.tunnel = await tunnel(port);
        address = starting.tunnel.address;
      }
      if (host !== starting) { starting.tunnel?.child.kill(); session.stop(); return expected('The session was stopped', 'stopped'); }
      starting.code = makeCode({ address, key: session.secret, name: hostName });
      log(`collaboration started (${mode})`);
      event({ type: 'started', ...state() });
      return { code: starting.code, ...state() };
    } catch (err) {
      session.stop();
      starting.tunnel?.child.kill();
      if (host === starting) host = null;
      return expected(err.message, err.code || 'tunnel');
    }
  });
  function stopHost() {
    if (!host) return;
    const h = host;
    host = null;
    h.session.stop();
    // The guests' "the session ended" goes through the tunnel: it closes once that is on its way.
    if (h.tunnel) setTimeout(() => h.tunnel.child.kill(), quitting ? 0 : 1500).unref?.();
    log('collaboration stopped');
    event({ type: 'stopped' });
  }
  ipcMain.handle('collab:stop', () => { stopHost(); return state(); });
  ipcMain.handle('collab:answer', (_e, id, allow, role) => (host ? (allow ? host.session.accept(id, { role }) : host.session.decline(id)) : false));
  ipcMain.handle('collab:setRole', (_e, id, role) => host?.session.setRole(id, role) ?? false);
  ipcMain.handle('collab:kick', (_e, id) => host?.session.kick(id) ?? false);
  ipcMain.handle('collab:state', () => state());
  // Step 5: what runs on the host, only ever by the host's answer.
  ipcMain.handle('collab:runAnswer', (_e, by, req, allowed) => host?.session.runAnswer({ by, req, allowed: allowed === true }) ?? false);
  ipcMain.handle('collab:shareTerminal', (_e, id, name, cols, rows) => host?.session.shareTerminal(id, name, { cols, rows }) ?? false);
  ipcMain.handle('collab:stopTerminal', () => { host?.session.stopTerminal(); return true; });
  ipcMain.handle('collab:termAnswer', (_e, by, allowed) => host?.session.termAnswer({ by, allowed: allowed === true }) ?? false);
  ipcMain.handle('collab:sharePorts', (_e, list) => { host?.session.sharePorts(Array.isArray(list) ? list.map(Number) : []); return host?.session.sharedPorts() ?? []; });
  // The host's window answers a guest's save. A document it does not hold is written from the shared text, in the
  // file's encoding and line separator.
  ipcMain.handle('collab:saved', async (_e, r = {}) => {
    if (!host) return false;
    let { ok, code, error } = r;
    if (r.noTab && typeof r.path === 'string') {
      const shared = windows.sharedDocs.textOf(r.path);
      try {
        if (!shared) throw Object.assign(new Error('the file is not open'), { code: 'notOpen' });
        const now = await textCodec.readAsync(r.path).catch(() => null);
        await textCodec.writeAsync(r.path, shared.eol === '\n' ? shared.text : shared.text.replace(/\n/g, shared.eol), now?.encoding || 'utf-8');
        ok = true;
      } catch (err) { ok = false; code = err.code || 'failed'; error = err.message; }
    }
    host.session.saved({ by: r.by, req: r.req, rel: r.rel, ok, code, error });
    return ok;
  });

  // The caret and the file in front, from whichever side this is.
  const ranges = (r) => (Array.isArray(r) ? r.filter((x) => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isSafeInteger(n) && n >= 0)).slice(0, 100) : []);
  ipcMain.on('collab:cursor', (_e, m = {}) => {
    if (host) host.session.hostCursor(typeof m.path === 'string' ? m.path : null, ranges(m.ranges));
    else if (guest) guest.session.send({ type: 'cursor', path: guestRel(m.path), ranges: ranges(m.ranges) });
  });
  ipcMain.on('collab:chat', (_e, text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    if (host) host.session.hostChat(text.slice(0, 4000));
    else if (guest) guest.session.send({ type: 'chat', text: text.slice(0, 4000) });
  });
  ipcMain.on('collab:lspAnswer', (_e, a = {}) => host?.session.lspAnswer(a));
  ipcMain.on('collab:markers', (_e, m = {}) => { if (typeof m.path === 'string') host?.session.markers(m.path, m.markers); });
  ipcMain.on('collab:runOutput', (_e, m = {}) => host?.session.runOutput(m));
  ipcMain.on('collab:filesChanged', (_e, c = {}) => {
    const list = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    host?.session.filesChanged({ created: list(c.created), deleted: list(c.deleted), changed: list(c.changed),
      renamed: Array.isArray(c.renamed) ? c.renamed.filter((r) => Array.isArray(r) && typeof r[0] === 'string') : [] });
  });
  ipcMain.on('collab:view', (_e, m = {}) => {
    const line = Number.isSafeInteger(m.line) && m.line > 0 ? m.line : 1;
    if (host) host.session.hostView(typeof m.path === 'string' ? m.path : null, line);
    else if (guest) guest.session.send({ type: 'view', path: guestRel(m.path), line });
  });

  // ---------- guest ----------
  const prefix = () => `collab://${guest.session.sid}/`;
  // A guest document's path -> its project-relative path, or null when it is not this session's.
  const guestRel = (p) => (guest && typeof p === 'string' && p.startsWith(prefix()) ? p.slice(prefix().length) : null);
  const treeWaits = new Map(); // rel -> [resolve]
  const answers = new Map(); // req -> resolve, for saved and fs:result
  let reqSeq = 0;
  const ask = (msg, ms = 20000) => new Promise((resolve) => {
    if (!guest || guest.session.state !== 'online') return resolve({ ok: false, code: 'offline' });
    const req = ++reqSeq;
    const timer = setTimeout(() => { answers.delete(req); resolve({ ok: false, code: 'timeout' }); }, ms);
    answers.set(req, (r) => { clearTimeout(timer); resolve(r); });
    guest.session.send({ ...msg, req });
    return undefined;
  });

  function fromHost(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type.startsWith('doc:')) {
      if (typeof msg.path !== 'string') return;
      const wc = guest.docs.get(msg.path.toLowerCase());
      const target = wc && !wc.isDestroyed() ? wc : windows.main()?.webContents;
      if (msg.type === 'doc:failed') guest.docs.delete(msg.path.toLowerCase());
      target?.send(msg.type, { ...msg, path: prefix() + msg.path });
      return;
    }
    if (msg.type === 'tree') {
      const waits = treeWaits.get(msg.path) || [];
      treeWaits.delete(msg.path);
      for (const w of waits) w(msg.error ? { error: String(msg.error).slice(0, 40) } : { entries: Array.isArray(msg.entries) ? msg.entries.filter((e) => typeof e?.name === 'string').slice(0, 20000).map((e) => ({ name: e.name.slice(0, 255), dir: !!e.dir })) : [] });
      return;
    }
    if (['saved', 'fs:result', 'lsp:answer', 'run:answer'].includes(msg.type)) {
      const done = answers.get(msg.req);
      answers.delete(msg.req);
      done?.({ ok: msg.type === 'lsp:answer' || !!msg.ok || msg.allowed === true, result: msg.result, code: typeof msg.code === 'string' ? msg.code.slice(0, 40) : undefined, error: typeof msg.error === 'string' ? msg.error.slice(0, 300) : undefined });
      return;
    }
    if (msg.type === 'ports') { guest.ports.set(msg.ports); return; }
    if (msg.type === 'tcp:data') { guest.ports.data(msg); return; }
    if (msg.type === 'tcp:close') { guest.ports.close(msg); return; }
    if (msg.type === 'term') { if (typeof msg.data === 'string') event({ type: 'remote:term', data: msg.data.slice(0, 262144) }); return; }
    if (msg.type === 'welcome') guest.info = { you: msg.you, role: msg.role, color: msg.color, project: oneLine(msg.project, 100), host: oneLine(msg.host, 40), hidden: Array.isArray(msg.hidden) ? msg.hidden.slice(0, 200).map((h) => oneLine(h, 200)) : [] };
    if (msg.type === 'role' && guest.info) guest.info.role = msg.role === 'edit' ? 'edit' : 'read';
    if (msg.type === 'end' || msg.type === 'kicked') { guest.session.end(msg.type === 'end' ? 'ended' : 'kicked'); return; }
    event({ ...msg, type: `remote:${msg.type}` });
  }

  ipcMain.handle('collab:join', (_e, opts = {}) => {
    if (host || guest) return expected('A collaboration session is already open in this window', 'busy');
    const name = oneLine(opts.name, 40) || os.userInfo().username || 'Guest';
    let session;
    try {
      session = createGuest({
        code: opts.code, name, version, log,
        onEvent(e) {
          if (!guest || guest.session !== session) return;
          if (e.type === 'message') return fromHost(e.msg);
          if (e.state === 'ended') {
            for (const waits of treeWaits.values()) for (const w of waits) w({ error: 'ended' });
            treeWaits.clear();
            for (const done of answers.values()) done({ ok: false, code: 'offline' });
            answers.clear();
            guest.ports.stop();
            guest = null;
          }
          return event({ type: 'state', state: e.state, why: e.why, resumed: e.resumed });
        },
      });
    } catch (err) { return expected(err.message, err.code || 'badCode'); }
    guest = { session, name, info: null, docs: new Map(),
      ports: guestPorts((m) => guest?.session.send(m), (list) => { if (guest) guest.forwarded = list; event({ type: 'remote:forwarded', ports: list }); }), forwarded: [] };
    return state();
  });
  ipcMain.handle('collab:leave', () => { if (guest) guest.session.leave(); return true; });
  // A guest's save and file operations, answered by the host.
  ipcMain.handle('collab:save', (_e, rel) => (typeof rel === 'string' ? ask({ type: 'doc:save', path: rel }, 60000) : { ok: false }));
  ipcMain.handle('collab:runRequest', (_e, rel) => ask({ type: 'run:request', path: String(rel || '') }, 15 * 60000));
  ipcMain.on('collab:termAsk', () => guest?.session.send({ type: 'term:ask' }));
  ipcMain.on('collab:termInput', (_e, data) => { if (typeof data === 'string' && data) guest?.session.send({ type: 'term:input', data: data.slice(0, 4096) }); });
  // Opens a host port the guest relays, in the browser: only a port of the list, on this computer's loopback.
  ipcMain.handle('collab:openForwarded', (_e, port) => {
    const f = guest?.forwarded.find((p) => p.port === port);
    if (!f) return false;
    shell.openExternal(`http://localhost:${f.local}/`);
    return true;
  });
  ipcMain.handle('collab:lsp', (_e, method, rel, pos = {}) => ask({ type: 'lsp', method: String(method), path: String(rel || ''), line: pos.line | 0, character: pos.character | 0 }, 15000));
  ipcMain.handle('collab:fs', (_e, op, a = {}) => {
    if (op === 'create') return ask({ type: 'fs:create', path: String(a.path || ''), dir: !!a.dir });
    if (op === 'rename') return ask({ type: 'fs:rename', from: String(a.from || ''), to: String(a.to || '') });
    if (op === 'delete') return ask({ type: 'fs:delete', path: String(a.path || '') });
    return { ok: false, code: 'badOp' };
  });
  ipcMain.handle('collab:tree', (_e, rel) => {
    if (!guest || guest.session.state !== 'online') return { error: 'offline' };
    const key = typeof rel === 'string' ? rel : '';
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'timeout' }), TREE_MS);
      const waits = treeWaits.get(key) || [];
      if (!waits.length) guest.session.send({ type: 'tree', path: key });
      waits.push((r) => { clearTimeout(timer); resolve(r); });
      treeWaits.set(key, waits);
    });
  });
  // Tests: the guest's connection drops as a network failure would.
  ipcMain.handle('collab:testDrop', () => { if (!process.env.PYIDE_COLLAB_TEST) return false; guest?.session.dropConnection(); return !!guest; });

  // A guest's documents: doc:* from its window go to the host, never to a file here.
  windows.routeDocs({
    // Every collab:// path, also one of a session that has ended: it never becomes a file of this computer.
    owns: (p) => typeof p === 'string' && p.startsWith('collab://'),
    join(wc, { path: p, ticket }, reply) {
      const rel = guestRel(p);
      if (rel === null || !guest.info) return reply('doc:failed', { path: p, ticket, error: 'not in the session', code: 'offline' });
      guest.docs.set(rel.toLowerCase(), wc);
      return guest.session.send({ type: 'doc:join', path: rel, ticket });
    },
    op(wc, { path: p, base, ops }) {
      const rel = guestRel(p);
      if (rel !== null) guest.session.send({ type: 'doc:op', path: rel, base, ops });
    },
    leave(wc, { path: p }) {
      const rel = guestRel(p);
      if (rel === null) return;
      guest.docs.delete(rel.toLowerCase());
      guest.session.send({ type: 'doc:leave', path: rel });
    },
  });

  let quitting = false;
  app.on('will-quit', () => {
    quitting = true;
    stopHost();
    guest?.session.leave();
  });
};
