// The two zip operations the minecraft plugin needs and main/zip.js (a checked extractor for whole archives) does not
// do: writing a zip (a client pack, a resource pack) and reading one entry of a large jar (version.json from a
// Minecraft server jar) without unpacking it.
const fs = require('fs');
const zlib = require('zlib');

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
// is read up front; an entry is read when asked for. Stored and deflated entries (what jars and packs use).
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirAt = tail.readUInt32LE(eocd + 16);
    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirAt);
    const entries = new Map(); // name -> {method, packed, at}
    for (let p = 0, i = 0; i < count && p + 46 <= dir.length; i++) {
      const nameLen = dir.readUInt16LE(p + 28);
      entries.set(dir.toString('utf8', p + 46, p + 46 + nameLen), { method: dir.readUInt16LE(p + 10), packed: dir.readUInt32LE(p + 20), at: dir.readUInt32LE(p + 42) });
      p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return {
      names: [...entries.keys()],
      read(name) {
        const e = entries.get(name);
        if (!e) return null;
        const head = Buffer.alloc(30);
        fs.readSync(fd, head, 0, 30, e.at);
        const data = Buffer.alloc(e.packed);
        fs.readSync(fd, data, 0, e.packed, e.at + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
        return e.method === 0 ? data : e.method === 8 ? zlib.inflateRawSync(data) : null;
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

module.exports = { writeZip, readEntry, openZip };
