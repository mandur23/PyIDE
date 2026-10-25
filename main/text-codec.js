// Reads and writes editor documents in their own encoding. Korean Windows files are often CP949 (EUC-KR superset);
// saving them as UTF-8 silently breaks the tools that read them (e.g. cmd.exe running a .bat), so the encoding is kept.
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
// The -nobom variants are UTF-16 files written without a byte order mark; they are saved without one too.
const ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'utf-16le-nobom', 'utf-16be-nobom', 'cp949'];

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// UTF-16 without a byte order mark (some Windows tools write it): in the first 8000 bytes at least a third of the
// code units are ASCII characters (a NUL byte beside a printable one) with the NUL on the same side, hardly any
// have it on the other side, none is U+0000, and the whole file decodes without a broken surrogate pair.
// -> 'utf-16le-nobom' | 'utf-16be-nobom' | null
const asciiText = (b) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13;
function utf16WithoutBom(buf) {
  if (buf.length < 2 || buf.length % 2) return null;
  const n = Math.min(buf.length, 8000);
  let le = 0;
  let be = 0;
  for (let i = 0; i < n; i += 2) {
    const a = buf[i];
    const b = buf[i + 1];
    if (a === 0 && b === 0) return null;
    if (b === 0 && asciiText(a)) le++;
    else if (a === 0 && asciiText(b)) be++;
  }
  const units = n / 2;
  const encoding = le >= units / 3 && be <= le / 20 ? 'utf-16le' : be >= units / 3 && le <= be / 20 ? 'utf-16be' : null;
  if (!encoding) return null;
  try {
    // TextDecoder knows UTF-16 LE only; BE is checked on a byte-swapped copy.
    new TextDecoder('utf-16le', { fatal: true }).decode(encoding === 'utf-16le' ? buf : Buffer.from(buf).swap16());
  } catch {
    return null;
  }
  return `${encoding}-nobom`;
}

function detect(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  const wide = utf16WithoutBom(buf);
  if (wide) return wide;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    // Not valid UTF-8: CP949 when it decodes the bytes cleanly. A UTF-8 file with a stray byte (a Latin-1 é pasted in)
    // stays UTF-8 with one replacement character, as in VS Code and PyCharm, instead of all its Korean turning to
    // CP949 mojibake that a save would then write for good.
    return iconv.decode(buf, 'cp949').includes('�') ? 'utf-8' : 'cp949';
  }
}

function decode(buf, encoding) {
  switch (encoding) {
    case 'utf-8-bom': return buf.subarray(3).toString('utf8');
    case 'utf-16le': case 'utf-16le-nobom': return iconv.decode(buf.subarray(buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0), 'utf-16le');
    case 'utf-16be': case 'utf-16be-nobom': return iconv.decode(buf.subarray(buf[0] === 0xfe && buf[1] === 0xff ? 2 : 0), 'utf-16be');
    case 'cp949': return iconv.decode(buf, 'cp949');
    default: return buf.toString('utf8');
  }
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf-8-bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf-16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf-16le')]);
    case 'utf-16be': return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf-16be')]);
    case 'utf-16le-nobom': return iconv.encode(text, 'utf-16le');
    case 'utf-16be-nobom': return iconv.encode(text, 'utf-16be');
    case 'cp949': return iconv.encode(text, 'cp949');
    default: return Buffer.from(text, 'utf8');
  }
}

// forced: an encoding from ENCODINGS, or 'auto' to read a file that looks binary as text all the same (Open as
// Text), in the encoding detected.
// -> {text, encoding, size} | {binary: true, size} | {tooLarge: true, size}
function read(p, forced) {
  const size = fs.statSync(p).size;
  if (size > MAX_TEXT_BYTES) return { tooLarge: true, size };
  const buf = fs.readFileSync(p);
  const encoding = ENCODINGS.includes(forced) ? forced : detect(buf);
  if (!forced && !encoding.startsWith('utf-16') && looksBinary(buf)) return { binary: true, size };
  return { text: decode(buf, encoding), encoding, size };
}

// Characters the target encoding cannot represent are refused rather than turned into '?'. The refusal is the user's
// to read (expected), not an IDE internal error.
function write(p, text, encoding = 'utf-8') {
  const buf = encode(text, encoding);
  if (encoding === 'cp949' && iconv.decode(buf, 'cp949') !== text) {
    throw Object.assign(new Error('Some characters cannot be saved in CP949. Convert the file to UTF-8 first.'), { code: 'EUNMAPPABLE', expected: true });
  }
  replaceFile(p, buf);
}

// Writes a new file next to the old one and renames it over, so a write that fails halfway (a full disk) or a crash
// never leaves a truncated file. In place, as before, where replacing would change what the file is or cannot work:
// a read-only file (the write fails as it should), a hard link (a new file would split it from its other names), a
// folder the user cannot create files in, or a file another program holds open without delete sharing.
// Files a save just replaced by rename: a file watcher sees a rename there, which is not a new file (the language
// server would take it as one and forget what it knew about every file).
const replaced = new Map();
const replacedRecently = (p) => {
  const k = path.resolve(p).toLowerCase();
  const t = replaced.get(k);
  if (t && Date.now() - t < 10000) return true;
  replaced.delete(k);
  return false;
};

// Over the existing file's bytes, then cut to length: Windows refuses to recreate ('w') a Hidden or System file, and a
// full disk can stop only the part past the old length.
function writeOver(p, buf) {
  let fd;
  try {
    fd = fs.openSync(p, 'r+');
  } catch (err) {
    if (err.code === 'ENOENT') return fs.writeFileSync(p, buf);
    throw err;
  }
  try {
    fs.writeFileSync(fd, buf);
    fs.ftruncateSync(fd, buf.length);
  } finally {
    fs.closeSync(fd);
  }
}

// The temp file starts as a copy of the file (CopyFile), so it carries the file's attributes (Hidden, System…) and
// alternate data streams (Zone.Identifier) through the rename; the new text is written over the copy.
function replaceFile(p, buf) {
  let target = p;
  let st;
  try {
    if (fs.lstatSync(p).isSymbolicLink()) target = fs.realpathSync(p);
    st = fs.statSync(target);
  } catch {
    return fs.writeFileSync(p, buf);
  }
  if (st.nlink > 1 || !(st.mode & 0o200)) return writeOver(p, buf);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.pyide-tmp`);
  try {
    fs.copyFileSync(target, tmp);
    writeOver(tmp, buf);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.code === 'EPERM' || err.code === 'EACCES') return writeOver(p, buf);
    throw err;
  }
  try {
    fs.renameSync(tmp, target);
    replaced.set(path.resolve(target).toLowerCase(), Date.now());
  } catch {
    fs.rmSync(tmp, { force: true });
    writeOver(p, buf);
  }
}

module.exports = { read, write, ENCODINGS, looksBinary, detect, decode, encode, replacedRecently };
