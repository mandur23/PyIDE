// A stand-in of bore's server that follows src/server.rs of bore v0.6.0: the frames it sends and expects, and, with
// relay, players connecting to a real public port on loopback, each taken up with {"Accept":id} and spliced to that
// socket, half-closes and backpressure included, as tokio's copy_bidirectional does. A connection nobody accepts is
// dropped after 10 s. tap(direction, chunk) sees the bytes bore would see ('toHost', 'toClient') and returns what to
// pass on, as a bore.pub that reads, changes or records them would. latency {host, friend}: the round-trip times of the two
// links, spent where bore.pub would spend them, for a host dialling back and a friend far away. Not a test: suites import
// it.
import { randomUUID } from 'crypto';
import net from 'net';

export const frame = (m) => Buffer.from(`${JSON.stringify(m)}\0`);
const STALE_MS = 10000;

export function standInBore({ hello = { Hello: 41234 }, relay = false, latency = null } = {}) {
  const seen = { first: [], accepted: new Map(), control: null };
  const pending = new Map();
  const bore = { seen, publicPort: 0, tap: null, close: () => {},
    accepted: () => [...seen.accepted.values()].filter((s) => !s.destroyed && !s.readableEnded).length };
  const later = (ms, step) => { if (ms) setTimeout(step, ms); else step(); };
  const across = latency ? (latency.host + latency.friend) / 2 : 0;
  // The host's connect (one round trip) and its Accept (half of one) before bore can splice.
  const dialBack = latency ? latency.host * 1.5 : 0;

  // first: the delay of the first chunk, when it has been waiting at bore and crosses only the last link.
  function pass(from, to, direction, first = across) {
    let delay = first;
    from.on('data', (chunk) => {
      later(delay, () => {
        const out = bore.tap ? bore.tap(direction, chunk) : chunk;
        if (out?.length && !to.write(out)) {
          from.pause();
          to.once('drain', () => from.resume());
        }
      });
      delay = across;
    });
    from.on('end', () => later(across, () => to.end()));
    from.on('close', () => later(across, () => to.destroy()));
    from.on('error', () => to.destroy());
  }
  function splice(id, socket) {
    const player = pending.get(id);
    if (!player) return socket.destroy();
    pending.delete(id);
    clearTimeout(player.stale);
    pass(player, socket, 'toHost', latency ? latency.host / 2 : 0);
    pass(socket, player, 'toClient');
    player.resume();
    return undefined;
  }
  // The public side: only with relay, so the plain frame tests stay as they are.
  async function openPublicPort(control) {
    const open = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (player) => {
      player.on('error', () => {});
      const id = randomUUID();
      player.stale = setTimeout(() => { pending.delete(id); player.destroy(); }, STALE_MS);
      pending.set(id, player);
      later(across, () => control.write(frame({ Connection: id })));
    });
    await new Promise((resolve) => { open.listen(0, '127.0.0.1', resolve); });
    bore.publicPort = open.address().port;
    bore.close = () => {
      open.close();
      for (const player of pending.values()) { clearTimeout(player.stale); player.destroy(); }
      pending.clear();
    };
    return { Hello: bore.publicPort };
  }

  bore.server = net.createServer({ allowHalfOpen: relay }, (socket) => {
    let buffered = Buffer.alloc(0);
    const onData = async (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0);
      if (end < 0) return;
      const m = JSON.parse(buffered.subarray(0, end).toString());
      const rest = buffered.subarray(end + 1);
      seen.first.push(m);
      socket.off('data', onData);
      if (m.Accept) {
        seen.accepted.set(m.Accept, socket);
        if (rest.length) socket.unshift(rest);
        if (relay) later(dialBack, () => splice(m.Accept, socket));
        return;
      }
      seen.control = socket;
      // In two chunks, cut inside a frame, as TCP may deliver it.
      const reply = frame(relay ? await openPublicPort(socket) : hello);
      socket.write(reply.subarray(0, 3));
      setTimeout(() => socket.write(reply.subarray(3)), 30);
      socket.on('data', () => {});
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  return bore;
}
