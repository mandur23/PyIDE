// A guest's side of a collaboration session (docs/collab-coding-plan.md): one connection to the host named by a join
// code, through the private tunnel's handshake (main/collab/link.js). Nothing of the host's project is written to this
// computer: the files a guest opens live in its window's memory, and go when the session does.
//
// The host is not trusted either: what it sends is only shown (as text) and edited, never run here. The connection
// comes back by itself after a drop, resuming the session (main/collab/link.js), until the host has given up on it.
const crypto = require('crypto');
const net = require('net');
const gate = require('../bore-gate');
const { channel, createSession } = require('./link');

const CODE = /nanostudio:(?:\/\/)?collab\/?\?([^\s"'`()<>]+)/i;
const CONNECT_MS = 15000;
const RETRY_FOR_MS = 120000;

const fail = (message, code) => Object.assign(new Error(message), { code });
// A join code (nanostudio:collab?addr=<host:port>&key=<key>&name=<host>), anywhere in the pasted text ->
// {host, port, key: Buffer, name}. The code is someone else's input: an address that is not host:port, or a key that
// is not 32 bytes of base64url, is refused.
function parseCode(text) {
  const m = CODE.exec(String(text ?? ''));
  if (!m) throw fail('This is not a Nano Studio collaboration code (nanostudio:collab?…)', 'badCode');
  const raw = m[1].replace(/[.,;:!?]+$/, '');
  const q = new URLSearchParams(raw);
  // URLSearchParams decodes names too, so k%65y= is a key that redact.js, which masks key=, would leave in a log.
  if (q.getAll('key').length !== 1 || (raw.match(/(^|&)key=/g) || []).length !== 1) throw fail('The collaboration code has a damaged key', 'badCode');
  const key = Buffer.from(q.get('key'), 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== q.get('key')) throw fail('The collaboration code has a damaged key', 'badCode');
  const addr = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(q.get('addr') || '');
  const port = Number(addr?.[2]);
  if (!addr || !port || port > 65535) throw fail('The collaboration code has a damaged address', 'badCode');
  const name = String(q.get('name') || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 60);
  return { host: addr[1].replace(/^\[|\]$/g, ''), port, key, name };
}
const pastable = (s) => encodeURIComponent(s).replace(/[!'()*.]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const makeCode = ({ address, key, name }) => `nanostudio:collab?addr=${address}&key=${key.toString('base64url')}${name ? `&name=${pastable(name)}` : ''}`;

function dial(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(fail('the host did not answer', 'unreachable')); }, CONNECT_MS);
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', onError); resolve(socket); });
    const onError = (err) => { clearTimeout(timer); reject(fail(err.code === 'ECONNREFUSED' ? 'nothing answers at that address' : err.message, 'unreachable')); };
    socket.once('error', onError);
  });
}

// onEvent({type: 'state', state, ...} | {type: 'message', msg}). States: connecting, waiting (for the host to accept),
// online, reconnecting, ended {why}.
function createGuest({ code, name, version = '', onEvent = () => {}, log = () => {} }) {
  const target = parseCode(code);
  const sid = crypto.randomBytes(4).toString('hex');
  let session = null;
  let link = null;
  let token = null;
  let state = 'connecting';
  let ended = false;
  let leaving = false; // said bye: the host closing the connection is the end, not a drop
  let lostAt = 0;
  let retryTimer = null;
  let attempt = 0;
  // A connection is being made: one at a time, or two resumed at once would push each other out.
  let trying = false;
  const setState = (s, extra = {}) => { state = s; onEvent({ type: 'state', state: s, ...extra }); };

  function end(why) {
    if (ended) return;
    ended = true;
    clearTimeout(retryTimer);
    link?.close();
    link = null;
    setState('ended', { why });
  }

  async function connect() {
    trying = true;
    let socket;
    let keys;
    try {
      socket = await dial(target.host, target.port);
      keys = await gate.clientHandshake(socket, target.key);
    } catch (err) {
      socket?.destroy();
      trying = false;
      return failed(err.message.includes('key') ? fail('the host did not prove it holds the code\'s key', 'badKey') : err);
    }
    if (ended) { trying = false; return socket.destroy(); }
    let answered = false;
    const ch = channel(socket, keys, 'client', {
      onFrame(f) {
        if (!answered) {
          if (f?.k === 'refused') { answered = true; trying = false; return end(typeof f.code === 'string' ? f.code.slice(0, 20) : 'refused'); }
          if (f?.k !== 'accepted' || typeof f.token !== 'string') return undefined;
          answered = true;
          trying = false;
          attempt = 0;
          lostAt = 0;
          link = ch;
          token = f.token;
          if (!session || !f.resumed) session = createSession((msg) => onEvent({ type: 'message', msg }));
          session.attach(ch, Number.isSafeInteger(f.recv) ? f.recv : 0);
          return setState('online', { resumed: !!f.resumed, id: f.id });
        }
        if (link === ch) session.frame(f);
        return undefined;
      },
      onClose(err) {
        log(`connection closed${err ? `: ${err.message}` : ''}${link === ch ? '' : ' (not the current one)'}`);
        if (link === ch) { link = null; session?.detach(); } else if (answered) return; // replaced: the current one stands
        if (!answered) trying = false;
        if (ended) return;
        if (leaving) return end('left');
        if (!answered && !token) return failed(err || fail('the host closed the connection', 'closed'));
        lostAt ||= Date.now();
        retry();
      },
    });
    ch.send({ k: 'hello', name, version, ...(token ? { resume: token, recv: session.received } : {}) });
    if (!token) setState('waiting');
    return undefined;
  }
  // The first connection failed: told as it is. A dropped session tries again, a little later each time.
  function failed(err) {
    if (ended) return;
    if (!token) { end(err.code || 'unreachable'); log(`join failed: ${err.message}`); return; }
    retry();
  }
  function retry() {
    if (ended || trying || link) return;
    if (Date.now() - lostAt > RETRY_FOR_MS) return end('lost');
    if (state !== 'reconnecting') setState('reconnecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, Math.min(5000, 500 * 2 ** attempt++));
  }

  connect();
  return {
    sid,
    hostName: target.name,
    get state() { return state; },
    send(msg) { if (session && !ended) session.send(msg); },
    // Leaves: the host hears it, then the connection goes.
    leave() {
      if (ended) return;
      if (!session || !link) return end('left');
      leaving = true;
      session.send({ type: 'bye' });
      setTimeout(() => end('left'), 300);
      return undefined;
    },
    end,
    // Tests: the connection drops as a network failure would, and the session reconnects.
    dropConnection() { link?.destroy(); },
  };
}

module.exports = { createGuest, parseCode, makeCode };
