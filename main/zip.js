// Extracts a plugin .zip without an external program. `tar -xf` (Windows' bsdtar) put no limit on what an archive
// unpacks to, and PATH can name GNU tar (Git's usr/bin), which cannot read a zip at all. Every entry is checked before
// anything is written: its name stays inside the target (no "..", no absolute path, drive or ADS colon, no Windows
// device name), it is a plain file or folder (no link), and the declared sizes fit the limits; inflating stops at the
// declared size, and each file's CRC must match.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const iconv = require('iconv-lite');

const LIMITS = { archive: 50 * 1024 * 1024, total: 100 * 1024 * 1024, entries: 2000 };
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// A name without the UTF-8 flag is in the OEM code page of the computer that zipped it: CP949 from Korean Windows
// Explorer, otherwise CP437 as the zip format specifies. CP949 is taken only when the bytes are valid CP949 (they
// decode and encode back unchanged).
function legacyName(raw) {
  const korean = iconv.decode(raw, 'cp949');
  return iconv.encode(korean, 'cp949').equals(raw) ? korean : iconv.decode(raw, 'cp437');
}

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
    const name = (flags & 0x800 ? raw.toString('utf8') : legacyName(raw)).replace(/\\/g, '/');
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

// Reads chosen entries of a zip (a jar in the Maven cache) without loading the whole file: the central directory, then
// each wanted entry. want(name) picks them; entries larger than maxSize, damaged ones and other compression methods are
// left out. Nothing is written, so names need no checks. -> Map name -> Buffer; a file that is no zip throws.
async function readZipEntries(file, want, { maxSize = 16 * 1024 * 1024 } = {}) {
  const fh = await fs.promises.open(file, 'r');
  const at = async (pos, len) => {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, pos);
    return bytesRead === len ? b : null;
  };
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await at(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; tail && i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('The file is not a zip archive');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > size) throw new Error('ZIP64 archives are not supported');
    const cd = await at(cdOffset, cdSize);
    const out = new Map();
    for (let p = 0, i = 0; cd && i < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; i++) {
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressed = cd.readUInt32LE(p + 20);
      const length = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
      if (!want(name) || (method !== 0 && method !== 8) || length > maxSize || compressed > maxSize) continue;
      const head = await at(offset, 30);
      if (!head || head.readUInt32LE(0) !== 0x04034b50) continue;
      const data = await at(offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), compressed);
      if (!data) continue;
      let body;
      try { body = method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, length) }); } catch { continue; }
      if (body.length === length && zlib.crc32(body) === crc) out.set(name, body);
    }
    return out;
  } finally {
    await fh.close();
  }
}

module.exports = { extractZip, readZipEntries, LIMITS };
