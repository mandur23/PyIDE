// The private tunnel's protocol (docs/craft-private-share-design.md), pure over a pair of streams: the handshake that
// proves both sides hold the key and agrees keys of its own, then records in each direction. bore.pub carries these bytes
// and can neither read nor change them. Run by main/bore-client.js in its own process.
//
// The cipher goes through WebCrypto because that is the only way to it where this runs: Electron's BoringSSL has no
// chacha20-poly1305 in createCipheriv (ERR_CRYPTO_UNKNOWN_CIPHER), while crypto.subtle has it, with a 'raw-secret' key.
// subtle.encrypt returns the ciphertext with its tag after it, which is the record's layout. X25519 is in crypto itself.
// verify/private-share.mjs holds the Electron build to RFC 8439's and RFC 7748's vectors and to a client written with
// OpenSSL.
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');

const { subtle } = crypto.webcrypto;
const AEAD = 'ChaCha20-Poly1305';
const RANDOM_SIZE = 32;
const PUBLIC_SIZE = 32;
const HELLO_SIZE = RANDOM_SIZE + PUBLIC_SIZE;
const PROOF_SIZE = 32;
const LENGTH_SIZE = 2;
const TAG_SIZE = 16;
const MAX_RECORD = 16384;
const LAST_COUNTER = 2n ** 64n - 1n;
const HANDSHAKE_MS = 2000;
// A friend's handshake crosses bore twice and takes longer than the host's: this only stops a game waiting for ever.
const CLIENT_HANDSHAKE_MS = 15000;
// One direction over, the other has this long to finish what it carries. Past it the connection is half-open: gone.
const LINGER_MS = 5000;
// The DER around a raw X25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

// A pair made for one connection and dropped after it, which is what keeps a leaked key from opening a recorded session.
function ephemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-PUBLIC_SIZE) };
}

// A peer's low-order point makes the result all zero, a value anyone can compute. OpenSSL and BoringSSL both throw on it
// today, which is no promise, so the check stands here too.
function agree(mine, peerRaw) {
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, peerRaw]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey });
  if (shared.every((byte) => byte === 0)) throw new Error('the other side sent a low-order point');
  return shared;
}

const proof = (secret, label, transcript) => crypto.createHmac('sha256', secret).update(label).update(transcript).digest();

// Exactly n bytes, and nothing past them leaves the stream: what follows the handshake stays there for the records, and
// what follows a bad one is never read.
function readExactly(stream, n) {
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      stream.off('readable', pull);
      stream.off('end', closed);
      stream.off('close', closed);
      stream.off('error', settleError);
      settle(value);
    };
    const settleError = (err) => done(reject, err);
    const closed = () => done(reject, new Error('the connection closed during the handshake'));
    function pull() {
      const chunk = stream.read(n);
      if (!chunk) return;
      if (chunk.length === n) done(resolve, chunk);
      else closed();
    }
    stream.on('readable', pull);
    stream.once('end', closed);
    stream.once('close', closed);
    stream.once('error', settleError);
    pull();
  });
}

function deriveKeys(shared, secret, sn, cn) {
  const raw = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([shared, secret]), Buffer.concat([sn, cn]), 'nano1-keys', 88));
  return {
    client: { key: raw.subarray(0, 32), iv: raw.subarray(64, 76) },
    host: { key: raw.subarray(32, 64), iv: raw.subarray(76, 88) },
  };
}

// step(): the handshake's exchange. On any failure, or past its time, the stream is closed at once with no reply.
async function shake(wire, timeoutMs, step) {
  // Stays for the stream's whole life: a reset between the handshake and the records must not end the process.
  wire.on('error', () => {});
  const timer = setTimeout(() => wire.destroy(new Error('the handshake took too long')), timeoutMs);
  try {
    return await step();
  } catch (err) {
    wire.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The host answers nothing until it has the client's hello, so a scanner that only listens learns nothing. onHello: the
// other side has sent what a friend sends first, which bore-client.js weighs when it must drop a handshake.
function hostHandshake(wire, secret, { timeoutMs = HANDSHAKE_MS, onHello = () => {} } = {}) {
  return shake(wire, timeoutMs, async () => {
    const hello = await readExactly(wire, HELLO_SIZE);
    onHello();
    const cn = hello.subarray(0, RANDOM_SIZE);
    const sn = crypto.randomBytes(RANDOM_SIZE);
    const mine = ephemeral();
    wire.write(Buffer.concat([sn, mine.raw]));
    const transcript = Buffer.concat([hello, sn, mine.raw]);
    const answer = await readExactly(wire, PROOF_SIZE);
    if (!crypto.timingSafeEqual(answer, proof(secret, 'nano1-client', transcript))) throw new Error('the client does not hold the key');
    const shared = agree(mine, hello.subarray(RANDOM_SIZE));
    wire.write(proof(secret, 'nano1-host', transcript));
    return deriveKeys(shared, secret, sn, cn);
  });
}

function clientHandshake(wire, secret, { timeoutMs = CLIENT_HANDSHAKE_MS } = {}) {
  return shake(wire, timeoutMs, async () => {
    const cn = crypto.randomBytes(RANDOM_SIZE);
    const mine = ephemeral();
    const hello = Buffer.concat([cn, mine.raw]);
    wire.write(hello);
    const reply = await readExactly(wire, HELLO_SIZE);
    const sn = reply.subarray(0, RANDOM_SIZE);
    const shared = agree(mine, reply.subarray(RANDOM_SIZE));
    const transcript = Buffer.concat([hello, reply]);
    wire.write(proof(secret, 'nano1-client', transcript));
    const answer = await readExactly(wire, PROOF_SIZE);
    if (!crypto.timingSafeEqual(answer, proof(secret, 'nano1-host', transcript))) throw new Error('the other side does not hold the key');
    return deriveKeys(shared, secret, sn, cn);
  });
}

// The counter sits in the IV base's last 8 bytes, big-endian, as in TLS 1.3. Past the last value the record is refused,
// which ends the connection before a nonce could repeat.
function nextNonce(direction) {
  if (direction.counter > LAST_COUNTER) throw new Error('the record counter ran out');
  const nonce = Buffer.from(direction.iv);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(direction.counter);
  for (let i = 0; i < counter.length; i++) nonce[nonce.length - counter.length + i] ^= counter[i];
  direction.counter += 1n;
  return nonce;
}

// One direction's cipher state: the key made usable once, and a counter that starts at 0.
async function direction({ key, iv }, usage) {
  return { cryptoKey: await subtle.importKey('raw-secret', key, AEAD, false, [usage]), iv, counter: 0n };
}

const lengthOf = (size) => {
  const length = Buffer.alloc(LENGTH_SIZE);
  length.writeUInt16BE(size);
  return length;
};

async function sealRecord(state, plain) {
  const length = lengthOf(plain.length);
  const sealed = await subtle.encrypt({ name: AEAD, iv: nextNonce(state), additionalData: length }, state.cryptoKey, plain);
  return Buffer.concat([length, Buffer.from(sealed)]);
}

async function openRecord(state, length, sealed) {
  return Buffer.from(await subtle.decrypt({ name: AEAD, iv: nextNonce(state), additionalData: length }, state.cryptoKey, sealed));
}

// A Transform holds its callback while the reading side is full, so each stage stops pulling until the next has room,
// and both ends of a tunnel stop reading their socket: that is what keeps a fast sender's bytes out of memory. Records go
// one at a time, so a counter never runs ahead of the byte stream. The stream's end is a record of no bytes: only someone
// with the keys can say the sender is done, so bore cannot pass off a cut connection as a finished one.
class Seal extends Transform {
  constructor(keys) {
    super();
    this.keys = keys;
  }

  _construct(done) {
    direction(this.keys, 'encrypt').then((state) => { this.state = state; done(); }, done);
  }

  async _transform(chunk, _encoding, done) {
    try {
      for (let at = 0; at < chunk.length; at += MAX_RECORD) this.push(await sealRecord(this.state, chunk.subarray(at, at + MAX_RECORD)));
      done();
    } catch (err) { done(err); }
  }

  async _flush(done) {
    try {
      this.push(await sealRecord(this.state, Buffer.alloc(0)));
      done();
    } catch (err) { done(err); }
  }
}

class Open extends Transform {
  constructor(keys) {
    super();
    this.keys = keys;
    this.rest = Buffer.alloc(0);
    this.ended = false;
  }

  _construct(done) {
    direction(this.keys, 'decrypt').then((state) => { this.state = state; done(); }, done);
  }

  async _transform(chunk, _encoding, done) {
    try {
      let data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
      while (data.length >= LENGTH_SIZE && !this.ended) {
        const size = data.readUInt16BE(0);
        // Before anything is held for it: a stranger's length decides nothing about memory.
        if (size > MAX_RECORD) throw new Error('a record has a length out of range');
        const end = LENGTH_SIZE + size + TAG_SIZE;
        if (data.length < end) break;
        const plain = await openRecord(this.state, data.subarray(0, LENGTH_SIZE), data.subarray(LENGTH_SIZE, end));
        if (size) this.push(plain);
        else this.ended = true;
        data = data.subarray(end);
      }
      if (this.ended && data.length) throw new Error('something came after the last record');
      this.rest = data;
      done();
    } catch (err) { done(err); }
  }

  _flush(done) {
    done(this.ended ? undefined : new Error('the connection ended without its last record'));
  }
}

// Records between wire (the bore side) and plain (the game or the server), after a handshake. role says which keys this
// side sends with. A failure anywhere destroys both streams at once, and a wire that ends without its last record is one;
// a clean end in one direction gives the other LINGER_MS to finish, so a server's last words still arrive and a peer that
// never closes does not stay open.
function tunnel(wire, plain, keys, role) {
  const [outgoing, incoming] = role === 'host' ? [keys.host, keys.client] : [keys.client, keys.host];
  const seal = new Seal(outgoing);
  const open = new Open(incoming);
  let lingering = null;
  const close = () => {
    clearTimeout(lingering);
    for (const stream of [wire, plain, seal, open]) stream.destroy();
  };
  const over = (err) => {
    if (err || lingering) return close();
    lingering = setTimeout(close, LINGER_MS);
    lingering.unref();
    return undefined;
  };
  pipeline(plain, seal, wire, over);
  pipeline(wire, open, plain, over);
}

module.exports = { hostHandshake, clientHandshake, tunnel, Seal, Open, deriveKeys, ephemeral, agree, sealRecord, direction, MAX_RECORD };
