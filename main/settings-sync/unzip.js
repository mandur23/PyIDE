// A minimal ZIP reader for settings archives: the central directory, stored and deflated entries, CRC checks. It reads
// entries into memory by name and never writes anything to disk, so a hostile entry name cannot place a file anywhere.
// No ZIP library ships with PyIDE (yauzl and unzipper are build-time only), and the `tar` on PATH may be Git's GNU tar,
// which cannot read zips (see main/diagnostics/zip.js, the writer this pairs with).
//
// ZIP bombs are refused by open() before anything is inflated: at most maxEntries entries, every entry's local header
// and data in its own byte range (overlapping or shared ranges are how a small file unpacks to gigabytes), and the sizes
// the central directory declares capped per entry and in total. Inflating never produces more than the declared size
// (maxOutputLength) and the result must match it exactly, so the declared sizes bound what read() returns.
const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

class ZipError extends Error {
  constructor(code, detail = '', info = {}) {
    super(detail || code);
    this.code = code;
    Object.assign(this, info);
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MB = 2 ** 20;

// buf: the whole archive. Returns {entries: [{name, size, dir}], totalSize, has(name), read(name) -> Buffer,
// readAsync(name) -> Promise<Buffer>}. Throws ZipError notZip | tooManyEntries {count, limit} | overlap |
// tooLarge {size, limit}.
function open(buf, { maxEntries = 5000, maxEntryBytes = 256 * MB, maxTotalBytes = 512 * MB } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('notZip');
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 0xffff); i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('notZip');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError('notZip', 'ZIP64 archives are not supported');
  if (cdOffset + cdSize > eocd) throw new ZipError('notZip', 'the central directory is outside the archive');
  if (count > maxEntries) throw new ZipError('tooManyEntries', `${count} entries (at most ${maxEntries})`, { count, limit: maxEntries });

  const byName = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('notZip', 'damaged central directory');
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const end = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (end > cdOffset + cdSize) throw new ZipError('notZip', 'damaged central directory');
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    const entry = {
      name,
      flags,
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      packed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      local: buf.readUInt32LE(p + 42),
      dir: name.endsWith('/'),
    };
    if (byName.has(name)) throw new ZipError('notZip', `duplicate entry ${name}`);
    // The local header and the data it introduces: [local, dataEnd), all before the central directory.
    const at = entry.local;
    if (at + 30 > cdOffset || buf.readUInt32LE(at) !== LOCAL) throw new ZipError('notZip', `damaged entry ${name}`);
    entry.start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    entry.dataEnd = entry.start + entry.packed;
    if (entry.dataEnd > cdOffset) throw new ZipError('notZip', `damaged entry ${name}`);
    byName.set(name, entry);
    p = end;
  }

  // No two entries may share bytes: several central entries pointing at one local header, or one entry's header inside
  // another's data, is the overlapping ZIP bomb.
  const ranges = [...byName.values()].sort((a, b) => a.local - b.local);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].local < ranges[i - 1].dataEnd) throw new ZipError('overlap', `${ranges[i - 1].name} and ${ranges[i].name} share data`);
  }
  let totalSize = 0;
  for (const e of byName.values()) {
    if (e.size > maxEntryBytes) throw new ZipError('tooLarge', `${e.name} would unpack to ${e.size} bytes (at most ${maxEntryBytes})`, { size: e.size, limit: maxEntryBytes });
    totalSize += e.size;
  }
  if (totalSize > maxTotalBytes) throw new ZipError('tooLarge', `the entries would unpack to ${totalSize} bytes (at most ${maxTotalBytes})`, { size: totalSize, limit: maxTotalBytes });

  function entryOf(name) {
    const e = byName.get(name);
    if (!e) throw new ZipError('missing', name);
    if (e.flags & 1) throw new ZipError('notZip', `${name} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError('notZip', `${name} uses an unsupported compression method (${e.method})`);
    return e;
  }
  function checked(e, data) {
    if (data.length !== e.size || zlib.crc32(data) !== e.crc) throw new ZipError('notZip', `${e.name} is damaged (size or CRC mismatch)`);
    return Buffer.from(data);
  }

  // Synchronous: only for small entries (the manifest); the caller caps the size first.
  function read(name) {
    const e = entryOf(name);
    const raw = buf.subarray(e.start, e.dataEnd);
    if (e.method === 0) return checked(e, raw);
    let data;
    try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }); } catch (err) { throw new ZipError('notZip', `${name}: ${err.message}`); }
    return checked(e, data);
  }

  // Inflates on the thread pool, so the main process keeps running while a large entry unpacks.
  async function readAsync(name) {
    const e = entryOf(name);
    const raw = buf.subarray(e.start, e.dataEnd);
    if (e.method === 0) return checked(e, raw);
    let data;
    try { data = await inflateRaw(raw, { maxOutputLength: Math.max(1, e.size) }); } catch (err) { throw new ZipError('notZip', `${name}: ${err.message}`); }
    return checked(e, data);
  }

  return {
    entries: [...byName.values()].map(({ name, size, dir }) => ({ name, size, dir })),
    totalSize,
    has: (name) => byName.has(name),
    read,
    readAsync,
  };
}

module.exports = { open, ZipError };
