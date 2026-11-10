// Zip archives of any size, written and read as streams: what a world backup needs (often more than 4 GB and more than
// 65,535 files) and what zipfile.js's whole-buffer helpers cannot do. The result is a plain .zip with ZIP64 records only
// where a count, a size or an offset needs them, which Explorer and 7-Zip open. Nothing holds an archive or a large file
// in memory, and deflating and inflating run on libuv's threads, so the main process keeps answering while a world is
// packed.
const fs = require('fs');
const zlib = require('zlib');

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const U32 = 0xffffffff;
const U16 = 0xffff;
// A file this close to 4 GB gets ZIP64 sizes in its local header too: deflate may make incompressible data a little
// larger than it was, and the local header is written before that is known.
const NEAR_U32 = U32 - 0x10000000;
// Reads of 4 MB went 1.6 times as fast as 1 MB ones on this PC's SSD (createReadStream, a 500 MB file).
const CHUNK = 4 << 20;

const crc32 = zlib.crc32;
const aborted = (signal) => { if (signal?.aborted) throw fail('Cancelled', 'cancelled'); };

// MS-DOS date and time, which is what a zip's entries carry (local time, two-second steps).
function dosTime(ms) {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const fromDos = (date, time) => new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();

const u64 = (b, at) => Number(b.readBigUInt64LE(at));
const put64 = (b, v, at) => b.writeBigUInt64LE(BigInt(v), at);

// ---------- writing ----------
// An entry's central directory record: ZIP64 values for whatever does not fit in 32 bits, in the order the format gives
// them (size, packed size, offset).
function centralRecord({ name, method, time = 0, date = 33, crc, size, packed, at, dir = false, big = false }) {
  const n = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');
  const wide = [size >= U32 && size, packed >= U32 && packed, at >= U32 && at].filter((v) => v !== false);
  const rec = Buffer.alloc(46 + n.length + (wide.length ? 4 + 8 * wide.length : 0));
  rec.writeUInt32LE(0x02014b50, 0);
  rec.writeUInt16LE(45, 4);
  rec.writeUInt16LE(wide.length || big ? 45 : 20, 6);
  rec.writeUInt16LE(0x0800, 8);
  rec.writeUInt16LE(method, 10);
  rec.writeUInt16LE(time, 12);
  rec.writeUInt16LE(date, 14);
  rec.writeUInt32LE(crc >>> 0, 16);
  rec.writeUInt32LE(packed >= U32 ? U32 : packed, 20);
  rec.writeUInt32LE(size >= U32 ? U32 : size, 24);
  rec.writeUInt16LE(n.length, 28);
  rec.writeUInt16LE(wide.length ? 4 + 8 * wide.length : 0, 30);
  rec.writeUInt32LE(dir ? 0x10 : 0x20, 38);
  rec.writeUInt32LE(at >= U32 ? U32 : at, 42);
  n.copy(rec, 46);
  if (wide.length) {
    const x = 46 + n.length;
    rec.writeUInt16LE(1, x);
    rec.writeUInt16LE(8 * wide.length, x + 2);
    wide.forEach((v, i) => put64(rec, v, x + 4 + 8 * i));
  }
  return rec;
}
// What ends an archive whose central directory of count records starts at dirAt: the ZIP64 end record and its locator
// when a count or an offset needs them, then the classic end record with 0xFFFF and 0xFFFFFFFF in their place.
function endRecords(count, dirAt, dirSize) {
  const parts = [];
  if (count >= U16 || dirAt >= U32 || dirSize >= U32) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    put64(rec, 44, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    put64(rec, count, 24);
    put64(rec, count, 32);
    put64(rec, dirSize, 40);
    put64(rec, dirAt, 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    put64(loc, dirAt + dirSize, 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, U16), 8);
  end.writeUInt16LE(Math.min(count, U16), 10);
  end.writeUInt32LE(Math.min(dirSize, U32), 12);
  end.writeUInt32LE(Math.min(dirAt, U32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

// A file under SMALL read whole and deflated on the thread pool (inline when it is too small to be worth the trip), ready
// for add({prepared}): several can be under way while an earlier one is written, which is what makes a world of many
// small files quick (opening each file costs more than its bytes, a virus scanner's look included).
const SMALL = CHUNK;
async function prepare({ file, data, store = false }, { level = 6 } = {}) {
  const whole = data || await fs.promises.readFile(file);
  const method = store || !whole.length ? 0 : 8;
  const out = method === 0 ? whole : whole.length < 16384 ? zlib.deflateRawSync(whole, { level })
    : await new Promise((resolve, reject) => { zlib.deflateRaw(whole, { level }, (err, r) => (err ? reject(err) : resolve(r))); });
  return { size: whole.length, crc: crc32(whole) >>> 0, out, method };
}

// A zip written to file, an entry at a time, beside it and renamed over it by finish(). add() takes
// {name, file?: a path read as a stream, data?: Buffer, prepared?: what prepare() gave, dir?: true, mtime?,
// store?: true to keep it as it is}. onBytes(n) after each piece of a file is read, for a progress bar.
async function createZipWriter(file, { level = 6 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  let count = 0;
  const central = [];
  // Small entries are gathered in memory and written a few MB at a time: a world has tens of thousands of small files,
  // and a write call apiece was most of the time spent on them.
  const BUF = 4 << 20;
  const buf = Buffer.allocUnsafe(BUF);
  let used = 0;
  let flushed = 0; // what is on disk
  const flush = async () => { if (used) { await fh.write(buf, 0, used, flushed); flushed += used; used = 0; } };
  const write = async (b) => {
    if (used + b.length > BUF) await flush();
    if (b.length >= BUF) { await fh.write(b, 0, b.length, flushed); flushed += b.length; return; }
    b.copy(buf, used);
    used += b.length;
  };
  // Bytes written earlier, changed in place: in the buffer while they are still there.
  const patch = async (b, at) => { if (at >= flushed) b.copy(buf, at - flushed); else await fh.write(b, 0, b.length, at); };
  const posOf = () => flushed + used;

  async function add({ name, file: src, data, dir = false, mtime = Date.now(), store = false, prepared }, { signal, onBytes } = {}) {
    aborted(signal);
    const n = Buffer.from(dir && !name.endsWith('/') ? `${name}/` : name, 'utf8');
    const known = prepared ? prepared.size : src ? (await fs.promises.stat(src)).size : data ? data.length : 0;
    const pre = prepared || (!dir && (data || known < CHUNK) ? await prepare({ file: src, data, store }, { level }) : null);
    aborted(signal);
    const big = known > NEAR_U32;
    const method = pre ? pre.method : dir || store || known === 0 ? 0 : 8;
    const { time, date } = dosTime(mtime);
    const at = posOf();
    const head = Buffer.alloc(30 + n.length + (big ? 20 : 0));
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(big ? 45 : 20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt16LE(n.length, 26);
    head.writeUInt16LE(big ? 20 : 0, 28);
    n.copy(head, 30);
    if (big) { head.writeUInt16LE(1, 30 + n.length); head.writeUInt16LE(16, 32 + n.length); }
    await write(head);
    let crc = 0;
    let size = 0;
    let packed = 0;
    const take = (chunk) => { crc = crc32(chunk, crc); size += chunk.length; onBytes?.(chunk.length); };
    if (dir) {
      // nothing follows a folder's header
    } else if (pre) {
      ({ crc, size } = pre);
      onBytes?.(size);
      await write(pre.out);
      packed = pre.out.length;
    } else {
      const input = fs.createReadStream(src, { highWaterMark: CHUNK });
      if (method === 0) {
        for await (const chunk of input) { aborted(signal); take(chunk); await write(chunk); packed += chunk.length; }
      } else {
        const deflater = zlib.createDeflateRaw({ level, chunkSize: CHUNK });
        const feed = (async () => {
          try {
            for await (const chunk of input) {
              aborted(signal);
              take(chunk);
              if (!deflater.write(chunk)) await new Promise((r) => { deflater.once('drain', r); });
            }
            deflater.end();
          } catch (err) { deflater.destroy(err); input.destroy(); throw err; }
        })();
        const drain = (async () => { for await (const out of deflater) { await write(out); packed += out.length; } })();
        await Promise.all([feed, drain]);
      }
    }
    // The real crc and sizes go back into the local header, so no data descriptor follows the data.
    const fix = Buffer.alloc(12);
    fix.writeUInt32LE(crc >>> 0, 0);
    fix.writeUInt32LE(big ? U32 : packed, 4);
    fix.writeUInt32LE(big ? U32 : size, 8);
    if (!big && (packed >= U32 || size >= U32)) throw fail(`${name} grew past 4 GB while it was packed`);
    await patch(fix, at + 14);
    if (big) {
      const ext = Buffer.alloc(16);
      put64(ext, size, 0);
      put64(ext, packed, 8);
      await patch(ext, at + 34 + n.length);
    }
    central.push(centralRecord({ name: n, method, time, date, crc, size, packed, at, dir, big }));
    count++;
    return { crc: crc >>> 0, size, packed };
  }

  async function finish() {
    const dirAt = posOf();
    for (let i = 0; i < central.length; i += 4096) await write(Buffer.concat(central.slice(i, i + 4096)));
    await write(endRecords(count, dirAt, posOf() - dirAt));
    await flush();
    await fh.sync();
    await fh.close();
    await fs.promises.rename(tmp, file);
    return { size: flushed, count };
  }
  async function abort() {
    await fh.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
  return { add, finish, abort, get size() { return posOf(); }, tmp };
}

// ---------- reading ----------
// Where the central directory is: {count, dirAt, dirSize}, from the end of the file (tail: its last bytes, which start at
// tailAt). read64(at) -> the 56 bytes at a ZIP64 end record's offset, called only when the archive has one.
function locate(tail, tailAt, size, read64, label) {
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > tail.length) throw fail(`${label} is not a zip file`, 'notZip');
  let count = tail.readUInt16LE(eocd + 10);
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirAt = tail.readUInt32LE(eocd + 16);
  const loc = eocd - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
    const at64 = u64(tail, loc + 8);
    if (at64 + 56 > tailAt + loc) throw fail(`${label} is damaged (cut short?)`, 'damaged');
    const rec = read64(at64);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw fail(`${label} is damaged`, 'damaged');
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirAt = u64(rec, 48);
  } else if (count === U16 || dirSize === U32 || dirAt === U32) throw fail(`${label} is damaged: its ZIP64 records are missing`, 'damaged');
  // A truncated archive names a directory past its end.
  if (dirAt + dirSize > size) throw fail(`${label} is damaged (cut short?)`, 'damaged');
  return { count, dirAt, dirSize };
}
// The central directory's records -> [{name, flags, method, crc, packed, size, at, mtime, dir}], ZIP64 values read from
// their extra field.
function entriesOf(dir, count) {
  const out = [];
  for (let p = 0, i = 0; i < count && p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50; i++) {
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const e = {
      name: dir.toString('utf8', p + 46, p + 46 + nameLen), flags: dir.readUInt16LE(p + 8), method: dir.readUInt16LE(p + 10),
      crc: dir.readUInt32LE(p + 16), packed: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24), at: dir.readUInt32LE(p + 42),
      mtime: fromDos(dir.readUInt16LE(p + 14), dir.readUInt16LE(p + 12)),
    };
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = dir.readUInt16LE(x);
      const len = dir.readUInt16LE(x + 2);
      if (id === 1) {
        let v = x + 4;
        for (const key of ['size', 'packed', 'at']) if (e[key] === U32 && v + 8 <= x + 4 + len) { e[key] = u64(dir, v); v += 8; }
      }
      x += 4 + len;
    }
    e.dir = e.name.endsWith('/');
    out.push(e);
    p += 46 + nameLen + extraLen + dir.readUInt16LE(p + 32);
  }
  if (out.length !== count) throw fail('The archive is damaged: its directory lists fewer files than it says', 'damaged');
  return out;
}
// Entries that share their data are a bomb, or damage: a real archive holds each file once.
function overlapping(entries) {
  const spans = [...entries].sort((a, b) => a.at - b.at);
  for (let i = 1; i < spans.length; i++) if (spans[i].at < spans[i - 1].at + 30 + spans[i - 1].packed) return spans[i];
  return null;
}

const TAIL = 65557 + 20;
// A zip on disk, opened for streaming its entries: {entries, size, stream(entry, sink, opts), close()}.
async function openArchive(file, label = file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const tail = Buffer.alloc(Math.min(size, TAIL));
    await fh.read(tail, 0, tail.length, size - tail.length);
    const read64 = (at) => { const b = Buffer.alloc(56); fs.readSync(fh.fd, b, 0, 56, at); return b; };
    const { count, dirAt, dirSize } = locate(tail, size - tail.length, size, read64, label);
    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirAt);
    const entries = entriesOf(dir, count);
    if (overlapping(entries)) throw fail(`${label} is refused: its entries overlap, as in a zip bomb`, 'bomb');
    // Each piece of an entry's data, inflated, to sink(chunk) (awaited); the crc and size are checked at the end.
    async function streamOne(e, sink, { signal, onBytes } = {}) {
      if (e.flags & 1) throw fail(`${e.name} is encrypted`, 'damaged');
      if (e.method !== 0 && e.method !== 8) throw fail(`${e.name} uses a compression Nano Studio does not read (method ${e.method})`, 'damaged');
      const head = Buffer.alloc(30);
      await fh.read(head, 0, 30, e.at);
      if (head.readUInt32LE(0) !== 0x04034b50) throw fail(`${e.name} is damaged`, 'damaged');
      let at = e.at + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const end = at + e.packed;
      if (end > dirAt) throw fail(`${e.name} is damaged`, 'damaged');
      let crc = 0;
      let size = 0;
      const out = async (chunk) => {
        size += chunk.length;
        if (size > e.size) throw fail(`${e.name} is damaged: it holds more than it says`, 'damaged');
        crc = crc32(chunk, crc);
        await sink(chunk);
      };
      const inflater = e.method === 8 ? zlib.createInflateRaw({ chunkSize: CHUNK }) : null;
      const pump = (async () => {
        try {
          while (at < end) {
            aborted(signal);
            const n = Math.min(CHUNK, end - at);
            const buf = Buffer.alloc(n);
            const { bytesRead } = await fh.read(buf, 0, n, at);
            if (!bytesRead) throw fail(`${e.name} is damaged (cut short?)`, 'damaged');
            at += bytesRead;
            onBytes?.(bytesRead);
            const piece = bytesRead === n ? buf : buf.subarray(0, bytesRead);
            if (!inflater) await out(piece);
            else if (!inflater.write(piece)) await new Promise((r) => { inflater.once('drain', r); });
          }
          inflater?.end();
        } catch (err) { inflater?.destroy(err); throw err; }
      })();
      const drain = inflater ? (async () => { for await (const chunk of inflater) await out(chunk); })() : null;
      try { await Promise.all([pump, drain]); } catch (err) {
        if (err.code === 'cancelled' || err.expected) throw err;
        throw fail(`${e.name} is damaged (${err.code || err.message})`, 'damaged');
      }
      if (size !== e.size || (crc >>> 0) !== e.crc) throw fail(`${e.name} is damaged: its contents do not match its checksum`, 'damaged');
    }
    // A damaged entry's error names it (entry), for the window to say which file it was.
    const stream = (e, sink, opts) => streamOne(e, sink, opts).catch((err) => { if (err.code === 'damaged') err.entry = e.name; throw err; });
    return { entries, size, stream, close: () => fh.close() };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

module.exports = { createZipWriter, prepare, SMALL, openArchive, locate, entriesOf, overlapping, centralRecord, endRecords, U32, U16 };
