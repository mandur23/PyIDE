// The installed fonts, for the text panel: every TTF, OTF and TTC/OTC in the font folders, read from the files' own
// tables (name: family and style, preferring the typographic names 16/17 over 1/2; OS/2: weight and italic; head:
// macStyle when OS/2 is missing). Only the table directory and those three tables are read, not whole files.
// A face inside a collection (TTC) is served by fontData as a standalone font file, since FontFace takes one font.
const fs = require('fs');
const path = require('path');
const { FONT_LIMIT } = require('./limits');
const { FONT, extOf, fail, isInside, realFile } = require('./paths');

const MAX_FACES = 64;
const MAX_TABLES = 512;
const NAME_LIMIT = 1024 * 1024;
const POOL = 16;

class Bad extends Error {}

const fileReader = (fh) => async (offset, length) => {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  if (bytesRead < length) throw new Bad('the font file ends early');
  return buf;
};
const bufferReader = (b) => async (offset, length) => {
  if (offset + length > b.length) throw new Bad('the font file ends early');
  return b.subarray(offset, offset + length);
};

const utf16be = (b) => {
  const c = Buffer.from(b);
  if (c.length % 2) return '';
  return c.swap16().toString('utf16le');
};
const clean = (s) => s.replace(/\0/g, '').trim();

// name table -> [{platform, encoding, language, id, text}]
function nameRecords(buf) {
  if (buf.length < 6) return [];
  const count = buf.readUInt16BE(2);
  const strings = buf.readUInt16BE(4);
  const out = [];
  for (let i = 0; i < count && 6 + i * 12 + 12 <= buf.length; i++) {
    const r = 6 + i * 12;
    const platform = buf.readUInt16BE(r);
    const encoding = buf.readUInt16BE(r + 2);
    const language = buf.readUInt16BE(r + 4);
    const id = buf.readUInt16BE(r + 6);
    const length = buf.readUInt16BE(r + 8);
    const offset = strings + buf.readUInt16BE(r + 10);
    if (offset + length > buf.length) continue;
    const raw = buf.subarray(offset, offset + length);
    let text = null;
    if (platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))) text = utf16be(raw);
    else if (platform === 1 && encoding === 0) text = raw.toString('latin1');
    if (text && clean(text)) out.push({ platform, encoding, language, id, text: clean(text) });
  }
  return out;
}

// The English name for an id (Windows US English first), or null.
function pick(records, id) {
  const of = records.filter((r) => r.id === id);
  return (of.find((r) => r.platform === 3 && r.language === 0x409)
    || of.find((r) => r.platform === 3 && (r.language & 0x3ff) === 0x09)
    || of.find((r) => r.platform === 1 && r.language === 0)
    || of.find((r) => r.platform === 0)
    || of.find((r) => r.platform === 3)
    || of[0])?.text || null;
}
const korean = (records, id) => records.find((r) => r.id === id && r.platform === 3 && r.language === 0x412)?.text || null;

async function tablesAt(read, at) {
  const head = await read(at, 12);
  const n = head.readUInt16BE(4);
  if (!n || n > MAX_TABLES) throw new Bad('not a font');
  const dir = await read(at + 12, n * 16);
  const tables = new Map();
  for (let i = 0; i < n; i++) {
    const r = i * 16;
    tables.set(dir.toString('latin1', r, r + 4), { tag: dir.toString('latin1', r, r + 4), checksum: dir.readUInt32BE(r + 4), offset: dir.readUInt32BE(r + 8), length: dir.readUInt32BE(r + 12) });
  }
  return { version: head.readUInt32BE(0), tables, header: head };
}

// The faces of a font file: [{family, style, weight, italic, index, localFamily}].
async function faces(read) {
  const first = await read(0, 12);
  const tag = first.toString('latin1', 0, 4);
  let starts = [0];
  if (tag === 'ttcf') {
    const n = Math.min(first.readUInt32BE(8), MAX_FACES);
    const offs = await read(12, n * 4);
    starts = Array.from({ length: n }, (_, i) => offs.readUInt32BE(i * 4));
  } else if (![0x00010000, 0x4f54544f, 0x74727565].includes(first.readUInt32BE(0))) throw new Bad('not a font'); // 1.0, 'OTTO', 'true'
  const out = [];
  for (let index = 0; index < starts.length; index++) {
    const { tables } = await tablesAt(read, starts[index]);
    const name = tables.get('name');
    if (!name || name.length > NAME_LIMIT) continue;
    const records = nameRecords(await read(name.offset, name.length));
    const family = pick(records, 16) || pick(records, 1);
    if (!family) continue;
    const style = pick(records, 17) || pick(records, 2) || 'Regular';
    let weight = 400;
    let italic = /italic|oblique/i.test(style);
    const os2 = tables.get('OS/2');
    if (os2 && os2.length >= 64) {
      const b = await read(os2.offset, 64);
      const w = b.readUInt16BE(4);
      if (w >= 1 && w <= 1000) weight = w < 10 ? w * 100 : w;
      const sel = b.readUInt16BE(62);
      italic = !!(sel & 0x201) || italic;
    } else if (tables.get('head')?.length >= 46) {
      const b = await read(tables.get('head').offset, 46);
      const mac = b.readUInt16BE(44);
      if (mac & 1) weight = 700;
      italic = !!(mac & 2) || italic;
    }
    out.push({ family, style, weight, italic, index, localFamily: korean(records, 16) || korean(records, 1) });
  }
  return out;
}

async function facesOfFile(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    return await faces(fileReader(fh));
  } catch { return []; } finally { await fh?.close().catch(() => {}); }
}

// [{family, localName, styles: [{style, weight, italic, file, index}]}], families by name, styles by weight.
async function scan(dirs) {
  const files = [];
  const seen = new Set();
  for (const dir of dirs) {
    let ents = [];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (!ent.isFile() || !FONT.has(extOf(ent.name))) continue;
      const f = path.join(dir, ent.name);
      if (!seen.has(f.toLowerCase())) { seen.add(f.toLowerCase()); files.push(f); }
    }
  }
  const all = [];
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < files.length) {
      const file = files[next++];
      for (const face of await facesOfFile(file)) all.push({ ...face, file });
    }
  }));
  const families = new Map();
  for (const f of all.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.index - b.index))) {
    const k = f.family.toLowerCase();
    const fam = families.get(k) || families.set(k, { family: f.family, localName: null, styles: [], keys: new Set() }).get(k);
    if (!fam.localName && f.localFamily && f.localFamily !== f.family) fam.localName = f.localFamily;
    const sk = `${f.style.toLowerCase()}|${f.weight}|${f.italic}`;
    if (fam.keys.has(sk)) continue;
    fam.keys.add(sk);
    fam.styles.push({ style: f.style, weight: f.weight, italic: f.italic, file: f.file, index: f.index });
  }
  return [...families.values()]
    .map(({ family, localName, styles }) => ({ family, localName, styles: styles.sort((a, b) => a.weight - b.weight || a.italic - b.italic) }))
    .sort((a, b) => a.family.localeCompare(b.family, 'en', { sensitivity: 'base' }));
}

// One face of a collection as a font file of its own: its table directory with the tables laid out after it.
async function extractFace(buf, index) {
  if (buf.toString('latin1', 0, 4) !== 'ttcf') return buf;
  const n = buf.readUInt32BE(8);
  if (!(index >= 0 && index < n)) throw new Bad('no such face in the collection');
  const at = buf.readUInt32BE(12 + index * 4);
  const read = bufferReader(buf);
  const { tables, header } = await tablesAt(read, at);
  const list = [...tables.values()];
  const dirSize = 12 + list.length * 16;
  let size = dirSize;
  for (const t of list) size += (t.length + 3) & ~3;
  const out = Buffer.alloc(size);
  header.copy(out, 0, 0, 12);
  let pos = dirSize;
  list.forEach((t, i) => {
    const r = 12 + i * 16;
    out.write(t.tag, r, 'latin1');
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(pos, r + 8);
    out.writeUInt32BE(t.length, r + 12);
    if (t.offset + t.length > buf.length) throw new Bad(`the ${t.tag} table is cut short`);
    buf.copy(out, pos, t.offset, t.offset + t.length);
    pos += (t.length + 3) & ~3;
  });
  return out;
}

function createFonts(dirs) {
  let listing = null;
  const list = () => (listing ||= scan(dirs).catch((err) => { listing = null; throw err; }));
  async function data(file, index = 0) {
    const f = await realFile(file, FONT);
    if (f.error) return f;
    const roots = await Promise.all(dirs.map((d) => fs.promises.realpath(d).catch(() => null)));
    if (!roots.some((r) => r && isInside(r, f.real))) return fail('outside', 'not a file of the font folders');
    if (f.stat.size > FONT_LIMIT) return fail('tooLarge', 'the font file is too large');
    try {
      const face = await extractFace(await fs.promises.readFile(f.real), Number(index) || 0);
      return new Uint8Array(face.buffer, face.byteOffset, face.byteLength);
    } catch (err) {
      return err instanceof Bad ? fail('damaged', err.message) : fail('io', err.message);
    }
  }
  return { list, data };
}

// C:\Windows\Fonts and the fonts this user installed without administrator rights.
const fontDirs = () => [
  path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts'),
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')] : []),
];

module.exports = { createFonts, fontDirs, faces, bufferReader, extractFace, scan };
