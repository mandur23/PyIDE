// The connection of a collaboration session (docs/collab-coding-plan.md): the private tunnel's handshake and records
// (main/bore-gate.js) run here in the main process, on the host for every socket its listener takes and on the guest
// for the one it dials, so a direct LAN connection and one through bore.pub are the same bytes, which bore can neither
// read nor change. Over the records go length-framed JSON messages (main/collab/protocol.js).
//
// A session outlives its connection: every message is numbered, kept until the other side says it has it, and sent
// again after a reconnect, so nothing typed while the network was down is lost or applied twice. Frames:
//   {k: 'm', s, m}  a message, numbered from 1          {k: 'a', n}  the last message number received
//   {k: 'p'}        a ping, sent while idle              anything else (hello, accepted, refused) is the handshake's
const gate = require('../bore-gate');
const { encode, decoder } = require('./protocol');

const PING_MS = 5000;
// No frame for this long and the connection is taken for dead: a dropped Wi-Fi rarely says so.
const DEAD_MS = 20000;
const ACK_MS = 500;
// The messages a side keeps for a peer that is away; past this it is not resumed but dropped.
const MAX_KEPT_BYTES = 64 * 1024 * 1024;

// The encrypted framed channel over a socket whose handshake is done (keys from gate.*Handshake). onFrame(object),
// onClose(error | null) once. -> {send(frame), close()}
function channel(wire, keys, role, { onFrame, onClose }) {
  const [outgoing, incoming] = role === 'host' ? [keys.host, keys.client] : [keys.client, keys.host];
  const seal = new gate.Seal(outgoing);
  const open = new gate.Open(incoming);
  let closed = false;
  let lastHeard = Date.now();
  const finish = (err) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const s of [seal, open, wire]) s.destroy();
    onClose(err || null);
  };
  const read = decoder((frame) => { lastHeard = Date.now(); if (!closed) onFrame(frame); }, finish);
  wire.setNoDelay?.(true);
  seal.pipe(wire);
  wire.pipe(open);
  open.on('data', read);
  for (const s of [seal, open, wire]) {
    s.on('error', finish);
    s.on('close', () => finish(null));
  }
  open.on('end', () => finish(null));
  const send = (frame) => { if (!closed) seal.write(encode(frame)); };
  const timer = setInterval(() => {
    if (Date.now() - lastHeard > DEAD_MS) return finish(new Error('the connection stopped answering'));
    send({ k: 'p' });
  }, PING_MS);
  timer.unref?.();
  return {
    send,
    // A clean end: the last record says so, then the socket goes.
    close() { if (closed) return; seal.end(); setTimeout(() => finish(null), 200).unref?.(); },
    destroy: () => finish(null),
    get closed() { return closed; },
  };
}

// The numbered messages of one session, over whichever channel it has now. onMessage(msg) in order, each once.
function createSession(onMessage) {
  let out = []; // [{s, m, size}] sent and not yet confirmed
  let keptBytes = 0;
  let nextSeq = 1;
  let received = 0; // the last message number taken
  let acked = 0; // the last number told to the peer
  let link = null;
  let ackTimer = null;
  const ack = () => {
    ackTimer = null;
    if (link && received !== acked) { acked = received; link.send({ k: 'a', n: received }); }
  };
  const session = {
    // false once the peer has been away with more kept than MAX_KEPT_BYTES: it cannot be resumed.
    ok: true,
    send(m) {
      const entry = { s: nextSeq++, m };
      // The size counts only toward the limit; a message too large for the wire throws here, at its sender.
      entry.size = encode({ k: 'm', s: entry.s, m }).length;
      out.push(entry);
      keptBytes += entry.size;
      if (keptBytes > MAX_KEPT_BYTES) session.ok = false;
      link?.send({ k: 'm', s: entry.s, m });
    },
    // A frame from the channel. -> true when it was the session's.
    frame(f) {
      if (f.k === 'm' && Number.isSafeInteger(f.s)) {
        if (f.s !== received + 1) return true; // a resend of one already taken
        received = f.s;
        if (!ackTimer) ackTimer = setTimeout(ack, ACK_MS);
        onMessage(f.m);
        return true;
      }
      if (f.k === 'a' && Number.isSafeInteger(f.n)) { confirm(f.n); return true; }
      return f.k === 'p';
    },
    // A (new) channel, and the last number the peer has from this side: what it misses is sent again.
    attach(next, peerReceived) {
      link = next;
      confirm(peerReceived);
      for (const e of out) link.send({ k: 'm', s: e.s, m: e.m });
      acked = -1;
      ack();
    },
    detach() { link = null; clearTimeout(ackTimer); ackTimer = null; },
    get received() { return received; },
    get link() { return link; },
  };
  function confirm(n) {
    let i = 0;
    while (i < out.length && out[i].s <= n) keptBytes -= out[i++].size;
    if (i) out = out.slice(i);
  }
  return session;
}

module.exports = { channel, createSession, PING_MS, DEAD_MS };
