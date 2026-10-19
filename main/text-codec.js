// Reads and writes editor documents in their own encoding. Korean Windows files are often CP949 (EUC-KR superset);
// saving them as UTF-8 silently breaks the tools that read them (e.g. cmd.exe running a .bat), so the encoding is kept.
const fs = require('fs');
const iconv = require('iconv-lite');

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'cp949'];

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function detect(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'cp949';
  }
}

function decode(buf, encoding) {
  switch (encoding) {
    case 'utf-8-bom': return buf.subarray(3).toString('utf8');
    case 'utf-16le': return iconv.decode(buf.subarray(buf[0] === 0xff ? 2 : 0), 'utf-16le');
    case 'utf-16be': return iconv.decode(buf.subarray(buf[0] === 0xfe ? 2 : 0), 'utf-16be');
    case 'cp949': return iconv.decode(buf, 'cp949');
    default: return buf.toString('utf8');
  }
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf-8-bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf-16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf-16le')]);
    case 'utf-16be': return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf-16be')]);
    case 'cp949': return iconv.encode(text, 'cp949');
    default: return Buffer.from(text, 'utf8');
  }
}

// -> {text, encoding, size} | {binary: true, size} | {tooLarge: true, size}
function read(p, forced) {
  const size = fs.statSync(p).size;
  if (size > MAX_TEXT_BYTES) return { tooLarge: true, size };
  const buf = fs.readFileSync(p);
  const bom = buf[0] === 0xff && buf[1] === 0xfe || buf[0] === 0xfe && buf[1] === 0xff;
  if (!forced && !bom && looksBinary(buf)) return { binary: true, size };
  const encoding = forced && ENCODINGS.includes(forced) ? forced : detect(buf);
  return { text: decode(buf, encoding), encoding, size };
}

// Characters the target encoding cannot represent are refused rather than turned into '?'.
function write(p, text, encoding = 'utf-8') {
  const buf = encode(text, encoding);
  if (encoding === 'cp949' && iconv.decode(buf, 'cp949') !== text) {
    throw new Error('Some characters cannot be saved in CP949. Convert the file to UTF-8 first.');
  }
  fs.writeFileSync(p, buf);
}

module.exports = { read, write, ENCODINGS, looksBinary, detect, decode, encode };
