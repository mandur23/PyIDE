// The two zip operations the minecraft plugin needs and main/zip.js (a checked extractor for whole archives) does not
// do: writing a zip (a client pack, a resource pack) and reading one entry of a large jar (version.json from a
// Minecraft server jar) without unpacking it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createZipWriter, locate, entriesOf, overlapping } = require('./zip64');

const fail = (message) => Object.assign(new Error(message), { expected: true });
// What reading an archive stops at. A zip bomb (a small file whose entries inflate to gigabytes, or a directory whose
// entries all point at the same data) is refused before anything is written; resource packs and modpack overrides
// are tens of MB.
const LIMITS = { entry: 512 * 1024 * 1024, total: 2 * 1024 * 1024 * 1024, files: 50000 };
const mb = (n) => Math.ceil(n / 1048576);

const CRC = new Int32Array(256).map((_v, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = zlib.crc32 || ((buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; });

// What writeZip writes in memory has no ZIP64 records, which hold no more than 65,535 entries and 4 GB: past that the
// directory's counts and offsets wrap and the archive comes out damaged without a word, so it is refused instead.
// writeZipFile has no such limit.
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
const tooMany = (n) => fail(`${n} files are more than the 65,535 a zip holds without ZIP64`);
const tooLarge = () => fail('The archive would be larger than the 4 GB a zip holds without ZIP64');
// One entry's local header and name, and its central directory record.
function record(name, data, packed, offset) {
  const n = Buffer.from(name, 'utf8');
  if (data.length > MAX_BYTES || packed.length > MAX_BYTES || offset > MAX_BYTES) throw tooLarge();
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
  head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
  return { local: Buffer.concat([head, n]), central: Buffer.concat([dir, n]) };
}
function endRecord(count, size, offset) {
  if (offset > MAX_BYTES || offset + size > MAX_BYTES) throw tooLarge();
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return end;
}

// entries: [{name, data: Buffer}] -> the zip's bytes (deflated, UTF-8 names).
function writeZip(entries) {
  if (entries.length > MAX_ENTRIES) throw tooMany(entries.length);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const packed = zlib.deflateRawSync(data);
    const r = record(name, data, packed, offset);
    locals.push(r.local, packed);
    central.push(r.central);
    offset += r.local.length + packed.length;
  }
  return Buffer.concat([...locals, ...central, endRecord(entries.length, central.reduce((s, b) => s + b.length, 0), offset)]);
}

// The same zip written to file as a stream (zip64.js): entries [{name, data?: Buffer, file?: a path read when its turn
// comes, read?: () => Buffer}]. Deflating runs on libuv's threads and nothing holds the whole archive or a whole large
// file, so a client pack of hundreds of MB of mods does not stop the main process, and ZIP64 records take it past
// 65,535 files and 4 GB. Written beside file and renamed over it at the end.
async function writeZipFile(file, entries) {
  const zip = await createZipWriter(file);
  try {
    for (const e of entries) await zip.add(e.file ? { name: e.name, file: e.file } : { name: e.name, data: e.data ?? e.read() });
    await zip.finish();
  } catch (err) {
    await zip.abort();
    throw err;
  }
}

// A zip on disk opened for reading entries: {names, read(name) -> Buffer | null, close()}. Only the central directory
// is read up front (ZIP64 records included); an entry is read when asked for. Stored and deflated entries (what jars
// and packs use); size(name) is the size the directory declares, which read() inflates no further than.
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65557 + 20));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const read64 = (at) => { const b = Buffer.alloc(56); fs.readSync(fd, b, 0, 56, at); return b; };
    const { count, dirAt, dirSize } = locate(tail, size - tail.length, size, read64, path.basename(file));
    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirAt);
    const list = entriesOf(dir, count);
    const entries = new Map(list.map((e) => [e.name, e]));
    if (overlapping(list)) throw Object.assign(fail(`${path.basename(file)} is refused: its entries overlap, as in a zip bomb`), { bomb: true });
    return {
      names: [...entries.keys()],
      size: (name) => entries.get(name)?.size ?? 0,
      read(name) {
        const e = entries.get(name);
        if (!e) return null;
        if (e.flags & 1) throw fail(`${name} is encrypted`);
        if (e.method !== 0 && e.method !== 8) throw fail(`${name} uses a compression Nano Studio does not read (method ${e.method})`);
        if (e.size > LIMITS.entry) throw fail(`${name} is too large (${mb(e.size)} MB)`);
        const head = Buffer.alloc(30);
        fs.readSync(fd, head, 0, 30, e.at);
        const at = e.at + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        if (head.readUInt32LE(0) !== 0x04034b50 || at + e.packed > size) throw fail(`${name} is damaged`);
        const data = Buffer.alloc(e.packed);
        fs.readSync(fd, data, 0, e.packed, at);
        // Limits count what an entry declares, so one that gives more than it declares is a bomb, not a file.
        let out;
        try { out = e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) }); } catch { throw fail(`${name} is damaged`); }
        if (out.length !== e.size) throw fail(`${name} is damaged`);
        return out;
      },
      close: () => fs.closeSync(fd),
    };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

// The bytes of one entry of a zip on disk, or null. A bomb is not "no such entry": the caller's user hears why.
function readEntry(file, name) {
  let zip;
  try {
    zip = openZip(file);
    return zip.read(name);
  } catch (err) {
    if (err.bomb) throw err;
    return null;
  } finally {
    zip?.close();
  }
}

// A relative path that is written where its text says: Windows reads \ as a separator, drops a trailing dot or space,
// and finds a folder by its 8.3 name (MODS~1), and . or .. moves elsewhere, so `mods/a.jar\` or `mods/b.jar/.` land as
// mods/a.jar and mods/b.jar past a check on the text. A colon names an alternate data stream.
const canonical = (rel) => typeof rel === 'string' && rel.split('/').every((s) => s && s !== '.' && s !== '..' && !/[\\:]|[. ]$/.test(s)
  && !/^[^.]{1,6}~\d+(\.[^.]{1,3})?$/.test(s));

// Every file of a zip (or of its folder prefix, left out of the names) written under dest: a resource pack, a
// modpack's overrides. An entry whose name is not canonical is skipped; an archive that unpacks to more than
// LIMITS.total writes nothing.
function unpackZip(file, dest, prefix = '') {
  const zip = openZip(file);
  const top = path.resolve(dest);
  try {
    const names = zip.names.filter((x) => x.startsWith(prefix) && !x.endsWith('/'));
    const total = names.reduce((s, n) => s + zip.size(n), 0);
    if (total > LIMITS.total) throw fail(`${path.basename(file)} unpacks to ${mb(total)} MB, more than the ${mb(LIMITS.total)} MB Nano Studio unpacks`);
    if (names.length > LIMITS.files) throw fail(`${path.basename(file)} holds ${names.length} files, more than the ${LIMITS.files} Nano Studio unpacks`);
    for (const n of names) {
      if (!canonical(n.slice(prefix.length))) continue;
      const out = path.resolve(top, n.slice(prefix.length));
      if (!out.startsWith(top + path.sep)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, zip.read(n));
    }
  } finally { zip.close(); }
}

module.exports = { writeZip, writeZipFile, readEntry, openZip, unpackZip, canonical };
