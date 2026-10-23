// Extracts a plugin .zip without an external program. `tar -xf` (Windows' bsdtar) put no limit on what an archive
// unpacks to, and PATH can name GNU tar (Git's usr/bin), which cannot read a zip at all. Every entry is checked before
// anything is written: its name stays inside the target (no "..", no absolute path, drive or ADS colon, no Windows
// device name), it is a plain file or folder (no link), and the declared sizes fit the limits; inflating stops at the
// declared size, and each file's CRC must match.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIMITS = { archive: 50 * 1024 * 1024, total: 100 * 1024 * 1024, entries: 2000 };
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// [{name, dir, method, crc, compressed, size, offset}] from the central directory, or a thrown readable reason.
function entries(buf, limits) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The file is not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  if (count > limits.entries) throw new Error(`The archive has more than ${limits.entries} entries`);
  if (cdOffset + cdSize > eocd) throw new Error('The archive is damaged');
  const out = [];
  const seen = new Set();
  let total = 0;
  for (let p = cdOffset, i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The archive is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const offset = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).replace(/\\/g, '/');
    p = next;
    if (flags & 1) throw new Error(`${name} is encrypted`);
    const dir = name.endsWith('/');
    const parts = name.split('/').filter((s, j, all) => s !== '' || j !== all.length - 1);
    if (!parts.length || parts.some((s) => !s || s === '.' || s === '..' || /[\0-\x1f:*?"<>|]/.test(s) || /[. ]$/.test(s) || DEVICE.test(s))) {
      throw new Error(`The archive has an entry with an unsafe name: ${JSON.stringify(name)}`);
    }
    if ((mode & 0o170000) === 0o120000) throw new Error(`The archive has a symbolic link: ${name}`);
    if (!dir && method !== 0 && method !== 8) throw new Error(`${name} uses an unsupported compression method (${method})`);
    const key = parts.join('/').toLowerCase();
    if (seen.has(key)) throw new Error(`The archive has ${name} twice`);
    seen.add(key);
    total += size;
    if (total > limits.total) throw new Error(`The archive unpacks to more than ${Math.round(limits.total / 1048576)} MB`);
    out.push({ name, parts, dir, method, crc, compressed, size, offset });
  }
  return out;
}

function extractZip(file, dest, limits = LIMITS) {
  if (fs.statSync(file).size > limits.archive) throw new Error(`The archive is larger than ${Math.round(limits.archive / 1048576)} MB`);
  const buf = fs.readFileSync(file);
  const list = entries(buf, limits);
  const root = path.resolve(dest);
  for (const e of list) {
    const target = path.join(root, ...e.parts);
    if (!target.startsWith(root + path.sep)) throw new Error(`The archive has an entry with an unsafe name: ${JSON.stringify(e.name)}`);
    if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    const h = e.offset;
    if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new Error(`The archive is damaged at ${e.name}`);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    if (start + e.compressed > buf.length) throw new Error(`The archive is damaged at ${e.name}`);
    const data = buf.subarray(start, start + e.compressed);
    let body;
    try {
      body = e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
    } catch {
      throw new Error(`${e.name} does not unpack to its declared size`);
    }
    if (body.length !== e.size || zlib.crc32(body) !== e.crc) throw new Error(`${e.name} is damaged (size or CRC mismatch)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

module.exports = { extractZip, LIMITS };
