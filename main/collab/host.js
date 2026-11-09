// The host of a collaboration session (docs/collab-coding-plan.md): the project stays on this computer, and guests see
// and edit it through this process. It listens on one port; every socket passes the private tunnel's handshake
// (main/collab/link.js) before a byte of it is read, then says who it is, and the host's user accepts or declines it.
// A guest is untrusted: every message is checked (main/collab/protocol.js), its paths are project-relative and may not
// name a hidden file, and it edits only once the host has given it the right.
//
// The documents guests open are the shared documents of main/shared-docs.js: a guest is one more holder, beside the
// host's windows, so one order of edits covers them all. A guest that drops off keeps its place (and its documents)
// for RESUME_MS: when it comes back its session resumes, and what was sent meanwhile in either direction arrives.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const gate = require('../bore-gate');
const P = require('./protocol');
const { channel, createSession } = require('./link');
const { pathKey } = require('../path-case');
const { hostPorts } = require('./share');

const MAX_PEOPLE = 5; // the host included
const RESUME_MS = 120000;
const HELLO_MS = 10000;
const MAX_UNPROVEN = 16;
const COLORS = 8;
// A guest's messages: a burst of BURST, then RATE a second. Past it the guest is dropped.
const RATE = 400;
const BURST = 4000;
const MAX_BAD = 20;

const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f20282029]+/g, ' ').trim().slice(0, max);

// root: the project folder as the host's windows spell it (their documents are keyed by it). hidden: the patterns no
// guest sees (protocol.js DEFAULT_HIDDEN). onEvent({type, ...}) tells the host's window.
// trash(abs): moves a file or folder a guest deleted to the Recycle Bin (shell.trashItem in the app). terminal:
// {tapOutput(fn), writeTo(id, data), alive(id)} of main/features/terminal.js, for the shared terminal.
function createHost({ root, sharedDocs, hidden = P.DEFAULT_HIDDEN, hostName = 'Host', version = '', bind = '127.0.0.1', onEvent = () => {}, log = () => {}, trash = (abs) => fs.promises.rm(abs, { recursive: true }), terminal = null }) {
  const secret = crypto.randomBytes(32);
  const guests = new Map(); // id -> guest
  const unproven = new Set();
  let server = null;
  let stopped = false;
  let nextId = 1;
  let hostView = null; // {path, line} of the host's active editor, for a guest that follows it
  let hostCursor = null; // {path, ranges}
  const markers = new Map(); // rel -> the host's problems in that file, for a guest that opens it later
  const chatLog = []; // the last messages, for a guest who joins later
  const ports = hostPorts((g, m) => { if (g.state !== 'gone') g.session.send(m); });
  // The shared terminal: {id, name, backlog, untap}, and the guests the host let type in it.
  let term = null;
  const typists = new Set();
  const termState = (g) => ({ type: 'term:state', shared: !!term, name: term?.name || '', canType: !!term && typists.has(g.id), cols: term?.cols, rows: term?.rows });

  const live = () => [...guests.values()].filter((g) => g.state !== 'pending');
  const people = () => [{ id: 0, name: hostName, color: 0, role: 'host', state: 'online' },
    ...live().map((g) => ({ id: g.id, name: g.name, color: g.color, role: g.role, state: g.state }))];
  const peopleChanged = () => {
    const list = people();
    for (const g of live()) g.session.send({ type: 'people', people: list });
    onEvent({ type: 'people', people: list, pending: [...guests.values()].filter((g) => g.state === 'pending').map((g) => ({ id: g.id, name: g.name })) });
  };
  const toGuests = (msg, except = null) => { for (const g of live()) if (g !== except) g.session.send(msg); };
  const relOf = (abs) => {
    const rel = P.relOf(root, abs);
    return rel === null || P.isHidden(rel, hidden) ? null : rel;
  };

  // ---------- connections ----------
  function onSocket(socket) {
    socket.on('error', () => {});
    if (stopped) return socket.destroy();
    // With every slot taken the newcomer stays and an older handshake goes, silent ones first: refusing the newcomer
    // would let a scanner holding sockets open lock every guest out (as main/bore-client.js gatedAccept).
    if (unproven.size >= MAX_UNPROVEN) {
      const victim = [...unproven].find((h) => !h.spoke) ?? unproven.values().next().value;
      unproven.delete(victim);
      victim.socket.destroy();
    }
    const h = { socket, spoke: false };
    unproven.add(h);
    gate.hostHandshake(socket, secret, { onHello: () => { h.spoke = true; } }).then((keys) => {
      unproven.delete(h);
      if (stopped) return socket.destroy();
      return connected(socket, keys);
    }, () => { unproven.delete(h); });
    return undefined;
  }

  function connected(socket, keys) {
    let guest = null;
    const ch = channel(socket, keys, 'host', {
      onFrame(f) {
        if (!guest) return hello(f);
        if (guest.link !== ch) return undefined;
        if (guest.state === 'pending' || !guest.session.frame(f)) return undefined;
        return undefined;
      },
      onClose(err) {
        clearTimeout(helloTimer);
        if (guest) log(`guest ${guest.id}: connection closed${err ? `: ${err.message}` : ''}${guest.link === ch ? '' : ' (not the current one)'}`);
        if (guest && guest.link === ch) lost(guest);
      },
    });
    const helloTimer = setTimeout(() => { if (!guest) ch.destroy(); }, HELLO_MS);
    function hello(f) {
      if (f?.k !== 'hello' || typeof f.name !== 'string' || typeof f.version !== 'string') return ch.destroy();
      clearTimeout(helloTimer);
      if (typeof f.resume === 'string') {
        const g = [...guests.values()].find((x) => x.token && x.token === f.resume && x.state !== 'pending');
        if (!g || !g.session.ok) {
          ch.send({ k: 'refused', code: 'expired' });
          return ch.close();
        }
        guest = g;
        if (g.link && g.link !== ch) g.link.destroy();
        clearTimeout(g.awayTimer);
        Object.assign(g, { link: ch, state: 'online' });
        ch.send({ k: 'accepted', id: g.id, token: g.token, recv: g.session.received, resumed: true });
        g.session.attach(ch, Number.isSafeInteger(f.recv) ? f.recv : 0);
        log(`guest ${g.id} is back`);
        return peopleChanged();
      }
      if (guests.size >= MAX_PEOPLE - 1) {
        ch.send({ k: 'refused', code: 'full' });
        return ch.close();
      }
      const used = new Set([0, ...[...guests.values()].map((g) => g.color)]);
      let color = 1;
      while (used.has(color) && color < COLORS - 1) color++;
      guest = { id: nextId++, name: oneLine(f.name, 40) || 'Guest', version: oneLine(f.version, 32), color, role: 'read', state: 'pending', token: null,
        session: null, link: ch, holder: `collab:${crypto.randomBytes(6).toString('hex')}`, docs: new Map(), tokens: BURST, at: Date.now(), bad: 0, cursor: null, view: null };
      guests.set(guest.id, guest);
      log(`guest ${guest.id} asks to join`);
      onEvent({ type: 'request', id: guest.id, name: guest.name });
      return peopleChanged();
    }
  }

  // The connection went: a pending guest's request is withdrawn; a guest in the session is away until it resumes.
  function lost(g) {
    g.link = null;
    if (g.state === 'pending') {
      guests.delete(g.id);
      onEvent({ type: 'withdrawn', id: g.id });
      return peopleChanged();
    }
    if (g.state === 'gone') return undefined;
    g.state = 'away';
    g.session.detach();
    clearTimeout(g.awayTimer);
    g.awayTimer = setTimeout(() => drop(g, 'lost'), RESUME_MS);
    g.awayTimer.unref?.();
    log(`guest ${g.id} dropped off`);
    return peopleChanged();
  }

  function drop(g, why) {
    if (g.state === 'gone') return;
    clearTimeout(g.awayTimer);
    g.state = 'gone';
    guests.delete(g.id);
    sharedDocs.leaveAll(g.holder);
    g.link?.close();
    g.link = null;
    log(`guest ${g.id} left (${why})`);
    onEvent({ type: 'left', id: g.id, name: g.name, why });
    toGuests({ type: 'cursor', id: g.id, path: null, ranges: [] });
    ports.drop(g);
    typists.delete(g.id);
    if (g.runAsk) onEvent({ type: 'runWithdrawn', by: g.id, req: g.runAsk });
    peopleChanged();
  }

  // ---------- the host's answers ----------
  function accept(id, { role = 'read' } = {}) {
    const g = guests.get(id);
    if (!g || g.state !== 'pending' || !g.link) return false;
    g.token = crypto.randomBytes(24).toString('base64url');
    g.role = role === 'edit' ? 'edit' : 'read';
    g.state = 'online';
    g.session = createSession((msg) => fromGuest(g, msg));
    g.link.send({ k: 'accepted', id: g.id, token: g.token, recv: 0 });
    g.session.attach(g.link, 0);
    g.session.send({ type: 'welcome', you: g.id, role: g.role, color: g.color, project: path.basename(root), host: hostName, hidden, people: people() });
    for (const m of chatLog) g.session.send(m);
    if (ports.ports().length) g.session.send({ type: 'ports', ports: ports.ports().map((port) => ({ port })) });
    if (term) { g.session.send(termState(g)); g.session.send({ type: 'term', data: term.backlog.join('') }); }
    if (hostView) g.session.send({ type: 'view', id: 0, ...hostView });
    if (hostCursor) g.session.send({ type: 'cursor', id: 0, ...hostCursor });
    for (const o of live()) {
      if (o === g) continue;
      if (o.view) g.session.send({ type: 'view', id: o.id, ...o.view });
      if (o.cursor) g.session.send({ type: 'cursor', id: o.id, ...o.cursor });
    }
    peopleChanged();
    return true;
  }
  function decline(id) {
    const g = guests.get(id);
    if (!g || g.state !== 'pending') return false;
    guests.delete(id);
    g.link?.send({ k: 'refused', code: 'declined' });
    g.link?.close();
    peopleChanged();
    return true;
  }
  function setRole(id, role) {
    const g = guests.get(id);
    if (!g || g.state === 'pending' || !['read', 'edit'].includes(role)) return false;
    g.role = role;
    g.session.send({ type: 'role', role });
    peopleChanged();
    return true;
  }
  function kick(id) {
    const g = guests.get(id);
    if (!g) return false;
    if (g.state === 'pending') return decline(id);
    g.session.send({ type: 'kicked' });
    // The message goes before the connection does.
    const link = g.link;
    g.link = null;
    setTimeout(() => link?.close(), 300);
    drop(g, 'kicked');
    return true;
  }

  // ---------- what guests send ----------
  function fromGuest(g, msg) {
    if (g.state === 'gone') return;
    const now = Date.now();
    g.tokens = Math.min(BURST, g.tokens + ((now - g.at) / 1000) * RATE);
    g.at = now;
    if (--g.tokens < 0) return drop(g, 'flood');
    const why = P.checkGuest(msg);
    if (why) {
      log(`guest ${g.id}: ${why}`);
      if (++g.bad > MAX_BAD) drop(g, 'protocol');
      return;
    }
    const handler = HANDLERS[msg.type];
    Promise.resolve().then(() => handler(g, msg)).catch((err) => log(`guest ${g.id} ${msg.type}: ${err.message}`));
  }

  const failDoc = (g, msg, err) => g.session.send({ type: 'doc:failed', path: msg.path, ticket: msg.ticket, error: String(err?.message || err).slice(0, 300), code: err?.code || 'failed' });
  // The guest's document path -> its absolute path (as the windows spell it), checked; throws {code}.
  async function docPath(rel) {
    const abs = P.resolveGuest(root, rel, { hidden });
    const real = await P.realGuest(root, rel, { hidden });
    const st = await fs.promises.stat(real);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'notFile' });
    return abs;
  }
  const senders = new Map(); // guest -> sender for shared documents
  function senderFor(g) {
    if (!senders.has(g)) {
      senders.set(g, (channelName, m) => {
        const k = pathKey(m.path);
        const rel = g.docs.get(k);
        if (rel === undefined || g.state === 'gone') return;
        try { g.session.send({ ...m, type: channelName, path: rel }); } catch (err) {
          // Too large for one message: the guest is out of the document, and told why.
          g.docs.delete(k);
          sharedDocs.leave(g.holder, m.path);
          g.session.send({ type: 'doc:failed', path: rel, ticket: m.ticket, error: err.message, code: err.code || 'tooLarge' });
        }
      });
    }
    return senders.get(g);
  }

  const HANDLERS = {
    hello: () => {},
    bye: (g) => drop(g, 'left'),
    async tree(g, msg) {
      try {
        g.session.send({ type: 'tree', path: msg.path, entries: await listFolder(msg.path) });
      } catch (err) {
        g.session.send({ type: 'tree', path: msg.path, error: err.code === 'ENOENT' ? 'missing' : err.code || 'failed' });
      }
    },
    async 'doc:join'(g, msg) {
      if (!Number.isSafeInteger(msg.ticket)) return failDoc(g, msg, Object.assign(new Error('no ticket'), { code: 'badMessage' }));
      let abs;
      try { abs = await docPath(msg.path); } catch (err) { return failDoc(g, msg, err); }
      if (g.state === 'gone') return undefined;
      g.docs.set(pathKey(abs), msg.path);
      // The host's window takes the document too (a tab in the background), so its language server, saving and
      // problems cover what the guest edits.
      onEvent({ type: 'open', path: abs, by: g.id });
      sharedDocs.join(g.holder, abs, senderFor(g), { remote: true, ticket: msg.ticket });
      const rel = relOf(abs);
      if (rel !== null && markers.has(rel)) g.session.send({ type: 'markers', path: rel, markers: markers.get(rel) });
      return undefined;
    },
    'doc:leave'(g, msg) {
      let abs;
      try { abs = P.resolveGuest(root, msg.path, { hidden }); } catch { return; }
      g.docs.delete(pathKey(abs));
      sharedDocs.leave(g.holder, abs);
    },
    'doc:op'(g, msg) {
      let abs;
      try { abs = P.resolveGuest(root, msg.path, { hidden }); } catch { return; }
      if (!g.docs.has(pathKey(abs))) return;
      if (g.role !== 'edit') {
        // The guest's text is no longer the host's: it is out of the document, and opens it again to see the host's.
        failDoc(g, msg, Object.assign(new Error('you may only view this session'), { code: 'readOnly' }));
        g.docs.delete(pathKey(abs));
        sharedDocs.leave(g.holder, abs);
        return;
      }
      sharedDocs.op(g.holder, { path: abs, base: msg.base, ops: msg.ops });
    },
    cursor(g, msg) {
      let abs = null;
      if (msg.path) {
        try { abs = P.resolveGuest(root, msg.path, { hidden }); } catch { return; }
      }
      g.cursor = { path: msg.path || null, ranges: msg.ranges };
      toGuests({ type: 'cursor', id: g.id, path: g.cursor.path, ranges: msg.ranges }, g);
      onEvent({ type: 'cursor', id: g.id, path: abs, ranges: msg.ranges });
    },
    // Saving, and the files and folders: only a guest the host lets edit. The host's window saves (its encoding, its
    // save actions); a document no window holds is written here from the shared text.
    async 'doc:save'(g, msg) {
      const answer = (ok, code, error) => g.session.send({ type: 'saved', req: msg.req, path: msg.path, ok, code, error });
      if (g.role !== 'edit') return answer(false, 'readOnly');
      let abs;
      try { abs = await docPath(msg.path); } catch (err) { return answer(false, err.code || 'failed', err.message); }
      return onEvent({ type: 'save', path: abs, by: g.id, req: msg.req, rel: msg.path });
    },
    async 'fs:create'(g, msg) {
      await fsOp(g, msg, async () => {
        const abs = P.resolveGuest(root, msg.path, { hidden });
        await parentOf(msg.path);
        if (msg.dir) await fs.promises.mkdir(abs);
        else await fs.promises.writeFile(abs, '', { flag: 'wx' });
        return { changed: [parentRel(msg.path)], event: { type: 'fsChanged', path: abs } };
      });
    },
    async 'fs:rename'(g, msg) {
      await fsOp(g, msg, async () => {
        const fromAbs = P.resolveGuest(root, msg.from, { hidden });
        await P.realGuest(root, msg.from, { hidden });
        const toAbs = P.resolveGuest(root, msg.to, { hidden });
        await parentOf(msg.to);
        // Never over another file: a name that differs only in case is the same file on Windows, and is a rename.
        if (pathKey(fromAbs) !== pathKey(toAbs) && await fs.promises.access(toAbs).then(() => true, () => false)) throw Object.assign(new Error('a file of that name is there'), { code: 'EEXIST' });
        await fs.promises.rename(fromAbs, toAbs);
        toGuests({ type: 'moved', from: clean(msg.from), to: clean(msg.to) });
        return { changed: [...new Set([parentRel(msg.from), parentRel(msg.to)])], event: { type: 'moved', from: fromAbs, to: toAbs } };
      });
    },
    async 'fs:delete'(g, msg) {
      await fsOp(g, msg, async () => {
        const abs = P.resolveGuest(root, msg.path, { hidden });
        const real = await P.realGuest(root, msg.path, { hidden });
        await trash(real);
        toGuests({ type: 'moved', from: clean(msg.path), to: null });
        return { changed: [parentRel(msg.path)], event: { type: 'moved', from: abs, to: null } };
      });
    },
    // The host's language server answers (the host's window asks it: lsp:answer comes back through lspAnswer).
    async lsp(g, msg) {
      let abs;
      try { abs = await docPath(msg.path); } catch { return g.session.send({ type: 'lsp:answer', req: msg.req, result: null }); }
      return onEvent({ type: 'lsp', by: g.id, req: msg.req, method: msg.method, path: abs, line: msg.line, character: msg.character });
    },
    chat(g, msg) { say(g.id, g.name, msg.text); },
    // Nothing runs here unless the host's user says so in the dialog this raises, for this one request.
    async 'run:request'(g, msg) {
      const answer = (allowed, code) => g.session.send({ type: 'run:answer', req: msg.req, allowed, code });
      if (g.runAsk) return answer(false, 'busy');
      let abs;
      try { abs = await docPath(msg.path); } catch (err) { return answer(false, err.code || 'badPath'); }
      if (g.state === 'gone') return undefined;
      g.runAsk = msg.req;
      return onEvent({ type: 'runRequest', by: g.id, name: g.name, req: msg.req, path: abs, rel: clean(msg.path) });
    },
    'term:ask'(g) {
      if (!term) return g.session.send({ type: 'term:answer', allowed: false, code: 'notShared' });
      if (typists.has(g.id)) return g.session.send(termState(g));
      return onEvent({ type: 'termRequest', by: g.id, name: g.name, terminal: term.name });
    },
    'term:input'(g, msg) {
      // Typed before the host allowed it, or after the host took it back: dropped.
      if (!term || !typists.has(g.id) || !terminal) return;
      terminal.writeTo(term.id, msg.data);
    },
    'tcp:open'(g, msg) { ports.open(g, msg); },
    'tcp:data'(g, msg) { ports.data(g, msg); },
    'tcp:close'(g, msg) { ports.close(g, msg); },
    view(g, msg) {
      let abs = null;
      if (msg.path) {
        try { abs = P.resolveGuest(root, msg.path, { hidden }); } catch { return; }
      }
      g.view = { path: msg.path || null, line: msg.line };
      toGuests({ type: 'view', id: g.id, ...g.view }, g);
      onEvent({ type: 'view', id: g.id, path: abs, line: msg.line });
    },
  };

  function say(id, name, text) {
    const m = { type: 'chat', id, name, text: String(text).slice(0, 4000), at: Date.now() };
    chatLog.push(m);
    if (chatLog.length > 200) chatLog.shift();
    toGuests(m);
    onEvent(m);
  }
  // Locations the host's language server gave, as the guest may see them: project files only, not hidden ones.
  const guestLocations = (list) => (Array.isArray(list) ? list : []).slice(0, 100).map((l) => {
    const rel = typeof l?.path === 'string' ? relOf(l.path) : null;
    return rel === null ? null : { path: rel, range: l.range };
  }).filter(Boolean);
  const clean = (rel) => rel.split(/[\\/]+/).filter(Boolean).join('/');
  const parentRel = (rel) => clean(rel).split('/').slice(0, -1).join('/');
  // The folder a new name goes in exists and is the project's (no link out, not hidden).
  async function parentOf(rel) {
    const parent = parentRel(rel);
    const real = parent ? await P.realGuest(root, parent, { hidden }) : await fs.promises.realpath(root);
    if (!(await fs.promises.stat(real)).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
  }
  async function fsOp(g, msg, run) {
    const answer = (ok, code, error) => g.session.send({ type: 'fs:result', req: msg.req, ok, code, error });
    if (g.role !== 'edit') return answer(false, 'readOnly');
    let r;
    try { r = await run(); } catch (err) { return answer(false, err.code || 'failed', String(err.message).slice(0, 300)); }
    answer(true);
    for (const folder of r.changed) toGuests({ type: 'tree:changed', path: folder });
    onEvent(r.event);
    return undefined;
  }

  // A folder's entries a guest may see: no hidden name, no name a guest path could not name, no link leading out.
  async function listFolder(rel) {
    const dir = rel ? await P.realGuest(root, rel, { hidden }) : await fs.promises.realpath(root);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const child = rel ? `${rel.replace(/\\/g, '/').replace(/\/+$/, '')}/${e.name}` : e.name;
      if (/\.pyide-tmp$/i.test(e.name)) continue;
      try { P.resolveGuest(root, child, { hidden }); } catch { continue; }
      let dirFlag = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          const real = await P.realGuest(root, child, { hidden });
          dirFlag = (await fs.promises.stat(real)).isDirectory();
        } catch { continue; }
      }
      out.push({ name: e.name, dir: dirFlag });
    }
    return out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
  }

  return {
    secret,
    async listen(port = 0) {
      server = net.createServer(onSocket);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => { server.off('error', reject); resolve(); });
      });
      server.on('error', (err) => log(`listener: ${err.message}`));
      return server.address().port;
    },
    accept, decline, setRole, kick, people,
    get guests() { return [...guests.values()]; },
    // The host's own caret and active file, for the guests' name tags and follow mode.
    hostCursor(abs, ranges) {
      const rel = abs ? relOf(abs) : null;
      if (abs && rel === null) return;
      hostCursor = { path: rel, ranges };
      toGuests({ type: 'cursor', id: 0, ...hostCursor });
    },
    hostView(abs, line) {
      const rel = abs ? relOf(abs) : null;
      hostView = { path: rel, line: Number.isSafeInteger(line) ? line : 1 };
      toGuests({ type: 'view', id: 0, ...hostView });
    },
    // Ends the session: every guest is told, then its connection and documents go.
    stop() {
      if (stopped) return;
      stopped = true;
      for (const g of [...guests.values()]) {
        if (g.state === 'pending') { g.link?.send({ k: 'refused', code: 'ended' }); g.link?.close(); guests.delete(g.id); continue; }
        g.session.send({ type: 'end' });
        const link = g.link;
        g.link = null;
        setTimeout(() => link?.close(), 300);
        drop(g, 'ended');
      }
      for (const h of unproven) h.socket.destroy();
      server?.close();
      ports.stop();
      if (term) { term.untap(); term = null; }
    },
    relOf,
    toGuests,
    // Files the host's window made, renamed or deleted, or that changed on disk: the guests' trees and tabs follow.
    filesChanged({ created = [], deleted = [], renamed = [], changed = [] } = {}) {
      const folders = new Set();
      const rel = (abs) => (typeof abs === 'string' ? relOf(abs) : null);
      const folderOf = (r) => r.split('/').slice(0, -1).join('/');
      for (const abs of [...created, ...changed].slice(0, 500)) { const r = rel(abs); if (r !== null) folders.add(folderOf(r)); }
      for (const abs of deleted.slice(0, 500)) {
        const r = rel(abs);
        if (r === null) continue;
        toGuests({ type: 'moved', from: r, to: null });
        folders.add(folderOf(r));
      }
      for (const pair of renamed.slice(0, 500)) {
        const [from, to] = Array.isArray(pair) ? pair.map(rel) : [null, null];
        if (from === null) continue;
        toGuests({ type: 'moved', from, to });
        folders.add(folderOf(from));
        if (to !== null) folders.add(folderOf(to));
      }
      for (const folder of [...folders].slice(0, 100)) toGuests({ type: 'tree:changed', path: folder });
    },
    // The host's answer to a run request: the host's window runs the file itself when allowed.
    runAnswer({ by, req, allowed }) {
      const g = guests.get(by);
      if (!g || g.runAsk !== req) return false;
      g.runAsk = null;
      g.session.send({ type: 'run:answer', req, allowed: !!allowed });
      return true;
    },
    // A terminal of the host's window shared with every guest (output only, until the host lets one type).
    shareTerminal(id, name, dims = {}) {
      if (!terminal || !terminal.alive(id)) return false;
      this.stopTerminal();
      const backlog = [];
      let size = 0;
      const untap = terminal.tapOutput((tid, data) => {
        if (tid !== term?.id) return;
        if (data === null) { this.stopTerminal(); return; }
        backlog.push(data);
        size += data.length;
        while (size > 65536 && backlog.length > 1) size -= backlog.shift().length;
        toGuests({ type: 'term', data });
      });
      const dim = (n) => (Number.isInteger(n) && n > 1 && n < 1000 ? n : null);
      term = { id, name: String(name || '').slice(0, 100), backlog, untap, cols: dim(dims.cols), rows: dim(dims.rows) };
      for (const g of live()) g.session.send(termState(g));
      onEvent({ type: 'term', shared: true, name: term.name });
      return true;
    },
    stopTerminal() {
      if (!term) return;
      term.untap();
      term = null;
      typists.clear();
      for (const g of live()) g.session.send(termState(g));
      onEvent({ type: 'term', shared: false });
    },
    termAnswer({ by, allowed }) {
      const g = guests.get(by);
      if (!g || !term) return false;
      if (allowed) typists.add(by); else typists.delete(by);
      g.session.send({ type: 'term:answer', allowed: !!allowed });
      g.session.send(termState(g));
      return true;
    },
    sharePorts(list) { ports.set(list, live()); onEvent({ type: 'ports', ports: ports.ports() }); },
    sharedPorts: () => ports.ports(),
    hostChat(text) { if (typeof text === 'string' && text.trim()) say(0, hostName, text); },
    // The host's language server's answer to a guest's request: definitions are made project-relative.
    lspAnswer({ by, req, method, result }) {
      const g = guests.get(by);
      if (!g || g.state === 'gone') return;
      const out = method === 'definition' ? guestLocations(result) : result ?? null;
      try { g.session.send({ type: 'lsp:answer', req, result: out }); } catch { g.session.send({ type: 'lsp:answer', req, result: null }); }
    },
    // The problems the host's window shows in a project file, for every guest (and kept for the ones who open it later).
    markers(abs, list) {
      const rel = relOf(abs);
      if (rel === null) return;
      const items = (Array.isArray(list) ? list : []).slice(0, 500);
      if (items.length) markers.set(rel, items); else markers.delete(rel);
      toGuests({ type: 'markers', path: rel, markers: items });
    },
    // What the host's runs print, for the guests to read along.
    runOutput(m) { toGuests({ type: 'run', name: String(m.name || '').slice(0, 200), text: String(m.text || '').slice(0, 65536), kind: m.kind || null, start: !!m.start }); },
    // The host's window saved (or could not save) what a guest asked it to.
    saved({ by, req, rel, ok, code, error }) {
      const g = guests.get(by);
      if (g && g.state !== 'gone') g.session.send({ type: 'saved', req, path: rel, ok: !!ok, code, error: error ? String(error).slice(0, 300) : undefined });
    },
  };
}

module.exports = { createHost, MAX_PEOPLE, RESUME_MS };
