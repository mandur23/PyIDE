// Faststart: moves an MP4's moov box in front of its first mdat, so a player (or a site's upload check) can start
// before it has the whole file. Everything else keeps its order. The sample data moves by the size of the moov, so each
// chunk offset (stco, co64) in every track is shifted; an stco whose shifted offsets no longer fit in 32 bits becomes a
// co64, which makes the moov larger, so the layout is computed again until the size settles. The new file is written
// next to the old one and renamed over it.
//
// Box sizes: a 32-bit size, 1 for a 64-bit size after the type (mp4write writes the mdat that way), or 0 for "to the
// end of the file".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fail, realFile } = require('./paths');
const { renameOver } = require('./project');

const MP4 = new Set(['mp4', 'm4a', 'm4v', 'mov', '3gp']);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const MOOV_LIMIT = 512 * 1024 * 1024;
const COPY_CHUNK = 8 * 1024 * 1024;
const U32 = 0xffffffff;
// Room left on the disk after the copy, so moving the index never fills it.
const SPARE = 64 * 1024 * 1024;

class Damaged extends Error {}

// Box headers in buf[start, end): [{type, start, size, hdr}].
function boxesIn(buf, start, end) {
  const out = [];
  for (let pos = start; pos < end;) {
    if (end - pos < 8) throw new Damaged('a box is cut short');
    let size = buf.readUInt32BE(pos);
    let hdr = 8;
    if (size === 1) {
      if (end - pos < 16) throw new Damaged('a box is cut short');
      size = Number(buf.readBigUInt64BE(pos + 8));
      hdr = 16;
    } else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) throw new Damaged('a box size does not fit');
    out.push({ type: buf.toString('latin1', pos + 4, pos + 8), start: pos, size, hdr });
    pos += size;
  }
  return out;
}

const header = (type, size) => {
  if (size <= U32) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(size, 0);
    h.write(type, 4, 'latin1');
    return h;
  }
  const h = Buffer.alloc(16);
  h.writeUInt32BE(1, 0);
  h.write(type, 4, 'latin1');
  h.writeBigUInt64BE(BigInt(size + 8), 8);
  return h;
};

function chunkOffsets(buf, box, wide) {
  const at = box.start + box.hdr;
  if (box.size - box.hdr < 8) throw new Damaged(`${box.type} is cut short`);
  const count = buf.readUInt32BE(at + 4);
  if (box.hdr + 8 + count * (wide ? 8 : 4) > box.size) throw new Damaged(`${box.type} lists more chunks than it holds`);
  const offsets = new Array(count);
  for (let i = 0; i < count; i++) offsets[i] = wide ? Number(buf.readBigUInt64BE(at + 8 + i * 8)) : buf.readUInt32BE(at + 8 + i * 4);
  return offsets;
}

// A co64 stays a co64; an stco becomes one only when an offset no longer fits.
function offsetsBox(offsets, wasWide) {
  const wide = wasWide || offsets.some((o) => o > U32);
  const size = 16 + offsets.length * (wide ? 8 : 4);
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write(wide ? 'co64' : 'stco', 4, 'latin1');
  b.writeUInt32BE(offsets.length, 12);
  offsets.forEach((o, i) => (wide ? b.writeBigUInt64BE(BigInt(o), 16 + i * 8) : b.writeUInt32BE(o, 16 + i * 4)));
  return b;
}

function rebuild(buf, start, end, map) {
  const pieces = [];
  for (const box of boxesIn(buf, start, end)) {
    if (CONTAINERS.has(box.type)) {
      const children = rebuild(buf, box.start + box.hdr, box.start + box.size, map);
      const size = children.reduce((n, b) => n + b.length, 0);
      pieces.push(header(box.type, size + 8), ...children);
    } else if (box.type === 'stco' || box.type === 'co64') {
      const wide = box.type === 'co64';
      pieces.push(offsetsBox(chunkOffsets(buf, box, wide).map(map), wide));
    } else pieces.push(buf.subarray(box.start, box.start + box.size));
  }
  return pieces;
}

// The moov box (and anything else in buf) with every chunk offset passed through map. Pure, for the tests.
const rewriteMoov = (moov, map) => Buffer.concat(rebuild(moov, 0, moov.length, map));

async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (!bytesRead) throw new Damaged('the file ended early');
    done += bytesRead;
  }
  return buf;
}

async function topBoxes(fh, size) {
  const out = [];
  for (let pos = 0; pos < size;) {
    if (size - pos < 8) throw new Damaged('the file ends inside a box header');
    const head = await readAt(fh, Math.min(16, size - pos), pos);
    let len = head.readUInt32BE(0);
    let hdr = 8;
    if (len === 1) {
      if (head.length < 16) throw new Damaged('the file ends inside a box header');
      len = Number(head.readBigUInt64BE(8));
      hdr = 16;
    } else if (len === 0) len = size - pos;
    if (len < hdr || pos + len > size) throw new Damaged('a box size does not fit the file');
    out.push({ type: head.toString('latin1', 4, 8), start: pos, size: len, hdr });
    pos += len;
  }
  return out;
}

async function copyRange(from, to, start, end, at) {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(1, end - start)));
  let pos = start;
  let out = at;
  while (pos < end) {
    const { bytesRead } = await from.read(buf, 0, Math.min(buf.length, end - pos), pos);
    if (!bytesRead) throw new Damaged('the file ended early');
    let done = 0;
    while (done < bytesRead) done += (await to.write(buf, done, bytesRead - done, out + done)).bytesWritten;
    pos += bytesRead;
    out += bytesRead;
  }
  return out;
}

// temp: {add(file), remove(file)} journals the full-size copy while it exists, so a crash does not leave it behind.
async function faststart(p, { temp } = {}) {
  const file = await realFile(p, MP4);
  if (file.error) return file;
  const size = file.stat.size;
  let src;
  try { src = await fs.promises.open(file.real, 'r'); } catch (err) { return fail('io', err.message); }
  let tmp = null;
  try {
    const top = await topBoxes(src, size);
    const moovs = top.filter((b) => b.type === 'moov');
    const firstMdat = top.findIndex((b) => b.type === 'mdat');
    if (moovs.length !== 1) return fail('damaged', moovs.length ? 'the file has more than one moov box' : 'the file has no moov box');
    const moovAt = top.indexOf(moovs[0]);
    if (firstMdat < 0 || moovAt < firstMdat) return { ok: true, already: true, bytes: size };
    if (top.some((b) => b.type === 'moof')) return fail('fragmented', 'a fragmented MP4 is not rearranged');
    const moov = moovs[0];
    if (moov.size > MOOV_LIMIT) return fail('tooLarge', 'the moov box is too large');
    const moovBytes = await readAt(src, moov.size, moov.start);
    const insertAt = top[firstMdat].start;
    const oldSize = moov.size;
    const mapFor = (newSize) => (off) => {
      if (off >= moov.start && off < moov.start + oldSize) throw new Damaged('a chunk offset points into the moov box');
      if (off >= size) throw new Damaged('a chunk offset points past the end of the file');
      return off < insertAt ? off : off < moov.start ? off + newSize : off + newSize - oldSize;
    };
    let newSize = oldSize;
    let rewritten = rewriteMoov(moovBytes, mapFor(newSize));
    for (let i = 0; rewritten.length !== newSize; i++) {
      if (i > 8) throw new Damaged('the moov size does not settle');
      newSize = rewritten.length;
      rewritten = rewriteMoov(moovBytes, mapFor(newSize));
    }
    // The copy is as large as the file: on a disk without room for it the file stays as it is (it plays; only not before
    // it has been read to the end).
    const disk = await fs.promises.statfs(path.dirname(file.real)).catch(() => null);
    if (disk && disk.bavail * disk.bsize < size - oldSize + newSize + SPARE) return fail('diskFull', 'there is not enough free space to move the index to the front');
    tmp = `${file.real}.${crypto.randomBytes(4).toString('hex')}.faststart.tmp`;
    await temp?.add(tmp);
    const out = await fs.promises.open(tmp, 'w');
    let end;
    try {
      end = await copyRange(src, out, 0, insertAt, 0);
      let done = 0;
      while (done < rewritten.length) done += (await out.write(rewritten, done, rewritten.length - done, end + done)).bytesWritten;
      end += rewritten.length;
      end = await copyRange(src, out, insertAt, moov.start, end);
      end = await copyRange(src, out, moov.start + oldSize, size, end);
      await out.sync();
    } finally { await out.close(); }
    if (end !== size - oldSize + newSize) throw new Damaged('the rearranged file has the wrong size');
    await src.close();
    src = null;
    await renameOver(tmp, file.real);
    await temp?.remove(tmp);
    tmp = null;
    return { ok: true, moved: true, bytes: end, path: file.real };
  } catch (err) {
    return err instanceof Damaged ? fail('damaged', err.message) : fail(err.code === 'ENOSPC' ? 'diskFull' : 'io', err.message);
  } finally {
    if (src) await src.close().catch(() => {});
    if (tmp) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      if (!fs.existsSync(tmp)) await temp?.remove(tmp);
    }
  }
}

module.exports = { faststart, rewriteMoov, boxesIn };
