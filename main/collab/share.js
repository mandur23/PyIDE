// A host's TCP ports opened to the guests of a collaboration session (a web server the host runs, for the guests'
// browsers), carried inside the session's encrypted connection: no second tunnel, nothing public. The host connects only
// to the ports it chose (on its loopback); a guest listens on its own loopback and relays each connection.
// Messages: ports {ports: [{port}]}, tcp:open {cid, port}, tcp:data {cid, data: base64}, tcp:close {cid}.
const net = require('net');

const CHUNK = 48 * 1024;
const MAX_CONNECTIONS = 64;

// send(guest, msg) sends to one guest. -> {set(ports), open(guest, msg), data(guest, msg), close(guest, msg), drop(guest), ports()}
function hostPorts(send) {
  let shared = new Set();
  const conns = new Map(); // guest -> Map(cid -> socket)
  const of = (g) => conns.get(g) || conns.set(g, new Map()).get(g);
  function closeOne(g, cid, tell) {
    const s = of(g).get(cid);
    if (!s) return;
    of(g).delete(cid);
    s.destroy();
    if (tell) send(g, { type: 'tcp:close', cid });
  }
  return {
    ports: () => [...shared],
    // The ports open to guests now; connections to a port taken off the list end.
    set(list, guests) {
      shared = new Set(list.filter((p) => Number.isInteger(p) && p > 0 && p < 65536));
      for (const [g, map] of conns) for (const [cid, s] of map) if (!shared.has(s.port)) closeOne(g, cid, true);
      for (const g of guests) send(g, { type: 'ports', ports: [...shared].map((port) => ({ port })) });
    },
    open(g, { cid, port }) {
      if (!shared.has(port) || of(g).has(cid) || of(g).size >= MAX_CONNECTIONS) return send(g, { type: 'tcp:close', cid });
      const s = net.connect({ host: '127.0.0.1', port });
      s.port = port;
      of(g).set(cid, s);
      s.on('data', (chunk) => { for (let i = 0; i < chunk.length; i += CHUNK) send(g, { type: 'tcp:data', cid, data: chunk.subarray(i, i + CHUNK).toString('base64') }); });
      s.on('error', () => {});
      s.on('close', () => { if (of(g).get(cid) === s) { of(g).delete(cid); send(g, { type: 'tcp:close', cid }); } });
      return undefined;
    },
    data(g, { cid, data }) { of(g).get(cid)?.write(Buffer.from(data, 'base64')); },
    close(g, { cid }) { closeOne(g, cid, false); },
    drop(g) { for (const cid of [...of(g).keys()]) closeOne(g, cid, false); conns.delete(g); },
    stop() { for (const g of [...conns.keys()]) this.drop(g); shared = new Set(); },
  };
}

// A guest's side: a listener on its loopback for each of the host's ports (the same number when it is free), each
// connection relayed. send(msg) to the host; onChange([{port, local}]) when the list changes.
function guestPorts(send, onChange) {
  const listeners = new Map(); // host port -> {server, local}
  const conns = new Map(); // cid -> socket
  let nextCid = 1;
  const listen = (server, port) => new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  const changed = () => onChange([...listeners].map(([port, l]) => ({ port, local: l.local })).filter((p) => p.local));
  return {
    async set(list) {
      const wanted = new Set((Array.isArray(list) ? list : []).map((p) => p?.port).filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 20));
      for (const [port, l] of listeners) if (!wanted.has(port)) { l.server.close(); listeners.delete(port); }
      for (const port of wanted) {
        if (listeners.has(port)) continue;
        const entry = { server: null, local: null };
        listeners.set(port, entry);
        const make = () => net.createServer((socket) => {
          const cid = nextCid++;
          conns.set(cid, socket);
          send({ type: 'tcp:open', cid, port });
          socket.on('data', (chunk) => { for (let i = 0; i < chunk.length; i += CHUNK) send({ type: 'tcp:data', cid, data: chunk.subarray(i, i + CHUNK).toString('base64') }); });
          socket.on('error', () => {});
          socket.on('close', () => { if (conns.get(cid) === socket) { conns.delete(cid); send({ type: 'tcp:close', cid }); } });
        });
        entry.server = make();
        if (!(await listen(entry.server, port))) {
          entry.server = make();
          await listen(entry.server, 0);
        }
        if (listeners.get(port) !== entry) { entry.server.close(); continue; }
        entry.local = entry.server.address()?.port || null;
      }
      changed();
    },
    data({ cid, data }) { if (typeof data === 'string') conns.get(cid)?.write(Buffer.from(data, 'base64')); },
    close({ cid }) { const s = conns.get(cid); conns.delete(cid); s?.destroy(); },
    stop() {
      for (const l of listeners.values()) l.server?.close();
      listeners.clear();
      for (const s of conns.values()) s.destroy();
      conns.clear();
      changed();
    },
  };
}

module.exports = { hostPorts, guestPorts };
