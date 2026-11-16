// Oracle scenarios for cut-formats: the files the JavaScript tests build, probe and timing of given bytes, and
// mp4write's output for a list of samples.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CUT = path.join(ROOT, 'renderer', 'features', 'cut');
const codecs = require(path.join(CUT, 'codecs.js'));
const probe = require(path.join(CUT, 'probe.js'));
const mp4write = require(path.join(CUT, 'mp4write.js'));

const b64 = (bytes) => ({ $bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') });
// A Source as JSON: typed arrays as plain arrays, at the moment it is made.
const snapshot = (s) => JSON.parse(JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));

// Every file verify/cut-formats.mjs hands to probe.open (up to 64 MB), with what probe.open returned: the files it
// builds byte by byte, the files mp4write wrote, and its truncated and damaged copies. The test's own checks and
// output are not kept.
export async function capture() {
  const seen = new Set();
  const files = [];
  const open = probe.open;
  probe.open = async (reader, opts) => {
    const source = await open(reader, opts);
    try {
      if (reader && reader.size <= 64 * 1024 * 1024 && typeof reader.read === 'function') {
        const bytes = codecs.asBytes(await reader.read(0, reader.size)).slice();
        const hash = createHash('sha1').update(bytes).digest('hex');
        if (bytes.length === reader.size && !seen.has(hash)) {
          seen.add(hash);
          files.push({ bytes: b64(bytes), source: snapshot(source) });
        }
      }
    } catch { /* a reader that fails is the test's point, not a file */ }
    return source;
  };
  const { log } = console;
  const { exit } = process;
  console.log = () => {};
  process.exit = () => {};
  try {
    await import(pathToFileURL(path.join(ROOT, 'verify', 'cut-formats.mjs')));
  } finally {
    console.log = log;
    process.exit = exit;
    probe.open = open;
  }
  return files;
}

export async function probeBytes(bytes) {
  return snapshot(await probe.open(codecs.bufferReader(bytes)));
}

// Milliseconds per probe.open of `bytes`, the best of `rounds` rounds.
export async function probeTime(bytes, rounds) {
  const r = codecs.bufferReader(bytes);
  await probe.open(r);
  let best = Infinity;
  for (let i = 0; i < rounds; i++) {
    const t = process.hrtime.bigint();
    await probe.open(r);
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

const fill = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (seed * 131 + i * 7) & 255; return b; };

// mp4write on `samples` ([kind 'v' | 'a', size, seed, timestamp, duration, key, compositionOffset]): every write the
// sink got, the sample whose add threw first (-1), finish's error. `failAt`: the sink refuses its write number n.
export async function write({ video, audio, timescale, samples, failAt = 0 }) {
  const writes = [];
  let n = 0;
  const sink = {
    async write(bytes, position) {
      if (failAt && ++n >= failAt) throw new Error('disk full');
      writes.push([position ?? null, b64(bytes)]);
    },
  };
  let w;
  try {
    w = mp4write.create({ video, audio, sink, timescale });
  } catch (err) {
    return { create: String(err.message) };
  }
  let threw = -1;
  for (const [i, [kind, size, seed, timestamp, duration, key, compositionOffset]] of samples.entries()) {
    const sample = { data: fill(size, seed), timestamp, duration, key, compositionOffset };
    try {
      await (kind === 'v' ? w.addVideo(sample) : w.addAudio(sample));
    } catch {
      threw = i;
      break;
    }
  }
  let finish = null;
  let size = null;
  try {
    size = (await w.finish()).bytes;
  } catch (err) {
    finish = String(err.message);
  }
  return { writes, threw, finish, size };
}

// Milliseconds to write `n` video samples of 3 bytes at 30 fps with mp4write (into memory).
export async function writeTime(n, avcC) {
  const parts = [];
  const sink = { async write(b) { parts.push(b); } };
  const F = 254016000000 / 30;
  const t = process.hrtime.bigint();
  const w = mp4write.create({ video: { codec: 'avc1.640028', width: 64, height: 64, description: avcC, frameRate: [30, 1] }, sink });
  const data = Uint8Array.of(1, 2, 3);
  for (let i = 0; i < n; i++) w.addVideo({ data, timestamp: i * F, duration: F, key: i % 60 === 0 });
  await w.finish();
  return Number(process.hrtime.bigint() - t) / 1e6;
}
