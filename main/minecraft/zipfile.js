// The two zip operations the minecraft plugin needs and main/zip.js (a checked extractor for whole archives) does not
// do: writing a zip (a client pack, a resource pack) and reading one entry of a large jar (version.json from a
// Minecraft server jar) without unpacking it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const fail = (message) => Object.assign(new Error(message), { expected: true });
// What reading an archive stops at. A zip bomb (a small file whose entries inflate to gigabytes, or a directory whose
// entries all point at the same data) is refused before anything is written; resource packs and modpack overrides
// are tens of MB.
const LIMITS = { entry: 512 * 1024 * 1024, total: 2 * 1024 * 1024 * 1024 };
const mb = (n) => Math.ceil(n / 1048576);

const CRC = new Int32Array(256).map((_v, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// entries: [{name, data: Buffer}] -> the zip's bytes (deflated, UTF-8 names).
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(head, n, packed);
    central.push(dir, n);
    offset += head.length + n.length + packed.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

// A zip on disk opened for reading entries: {names, read(name) -> Buffer | null, close()}. Only the central directory
// is read up front; an entry is read when asked for. Stored and deflated entries (what jars and packs use); size(name)
// is the size the directory declares, which read() inflates no further than.
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0 || eocd + 22 > tail.length) throw fail(`${path.basename(file)} is not a zip file`);
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirAt = tail.readUInt32LE(eocd + 16);
    // A truncated archive names a directory past its end.
    if (dirAt + dirSize > size) throw fail(`${path.basename(file)} is damaged (cut short?)`);
    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirAt);
    const entries = new Map(); // name -> {flags, method, packed, size, at}
    for (let p = 0, i = 0; i < count && p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50; i++) {
      const nameLen = dir.readUInt16LE(p + 28);
      entries.set(dir.toString('utf8', p + 46, p + 46 + nameLen), { flags: dir.readUInt16LE(p + 8), method: dir.readUInt16LE(p + 10),
        packed: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24), at: dir.readUInt32LE(p + 42) });
      p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
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
        if (e.method === 0) return data;
        // An entry that inflates to more than it declares is a bomb, not a file.
        try { return zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) }); } catch { throw fail(`${name} is damaged`); }
      },
      close: () => fs.closeSync(fd),
    };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

// The bytes of one entry of a zip on disk, or null.
function readEntry(file, name) {
  let zip;
  try {
    zip = openZip(file);
    return zip.read(name);
  } catch {
    return null;
  } finally {
    zip?.close();
  }
}

// Every file of a zip (or of its folder prefix, left out of the names) written under dest: a resource pack, a
// modpack's overrides. An entry naming a path outside dest, or an alternate data stream (a colon), is skipped; an
// archive that unpacks to more than LIMITS.total writes nothing.
function unpackZip(file, dest, prefix = '') {
  const zip = openZip(file);
  const top = path.resolve(dest);
  try {
    const names = zip.names.filter((x) => x.startsWith(prefix) && !x.endsWith('/'));
    const total = names.reduce((s, n) => s + zip.size(n), 0);
    if (total > LIMITS.total) throw fail(`${path.basename(file)} unpacks to ${mb(total)} MB, more than the ${mb(LIMITS.total)} MB Nano Studio unpacks`);
    for (const n of names) {
      const out = path.resolve(top, n.slice(prefix.length));
      if (!out.startsWith(top + path.sep) || out.slice(top.length).includes(':')) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, zip.read(n));
    }
  } finally { zip.close(); }
}

module.exports = { writeZip, readEntry, openZip, unpackZip };
