// Searching a folder the user chose: for offline media to relink (findMedia) and for the media files of a folder
// import (listMedia). Both go at most 8 folders deep and look at 50,000 entries at most, breadth first, so a drive root
// answers in bounded time. Junctions and symbolic links are not followed (a loop, or a way out of the folder).
const fs = require('fs');
const path = require('path');
const { MEDIA, extOf, fail, realEntry } = require('./paths');

const MAX_DEPTH = 8;
const MAX_ENTRIES = 50000;

async function walk(root, visit) {
  let queue = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      let ents;
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) {
        if (++seen > MAX_ENTRIES) return { truncated: true };
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (depth < MAX_DEPTH) next.push({ dir: p, depth: depth + 1 }); } else if (ent.isFile() && (await visit(p, ent.name)) === false) return { truncated: false, stopped: true };
      }
    }
    queue = next;
  }
  return { truncated: false };
}

async function folderOf(folder) {
  const entry = await realEntry(folder);
  if (entry.error) return entry;
  if (!entry.stat.isDirectory()) return fail('notFile', 'not a folder');
  return entry;
}

// wanted: [{name, size?}] -> {[name]: path}: a file of that name (any case) and, when a size is given, that size.
async function findMedia(folder, wanted) {
  const root = await folderOf(folder);
  if (root.error) return root;
  if (!Array.isArray(wanted)) return fail('badArgs', 'findMedia takes a list of {name, size}');
  const byName = new Map();
  for (const w of wanted.slice(0, 100000)) {
    if (!w || typeof w.name !== 'string' || !w.name) continue;
    const k = w.name.toLowerCase();
    (byName.get(k) || byName.set(k, []).get(k)).push({ name: w.name, size: Number.isFinite(w.size) ? w.size : null });
  }
  const found = Object.create(null);
  let left = byName.size;
  await walk(root.real, async (p, name) => {
    const list = byName.get(name.toLowerCase());
    if (!list) return true;
    let size = null;
    for (const w of list) {
      if (w.name in found) continue;
      if (w.size !== null) {
        if (size === null) { try { size = (await fs.promises.stat(p)).size; } catch { return true; } }
        if (size !== w.size) continue;
      }
      found[w.name] = p;
    }
    if (list.every((w) => w.name in found)) {
      byName.delete(name.toLowerCase());
      left--;
    }
    return left > 0;
  });
  return { ...found };
}

// The media files under a folder: {files: [{path, rel, size, mtime}], truncated}. `rel` uses the folder's own
// separators, so the importer can build bins from it.
async function listMedia(folder) {
  const root = await folderOf(folder);
  if (root.error) return root;
  const files = [];
  const r = await walk(root.real, async (p, name) => {
    if (!MEDIA.has(extOf(name))) return true;
    try {
      const st = await fs.promises.stat(p);
      files.push({ path: p, rel: path.relative(root.real, p), size: st.size, mtime: st.mtimeMs });
    } catch {}
    return true;
  });
  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }));
  return { files, truncated: r.truncated };
}

module.exports = { findMedia, listMedia, MAX_DEPTH, MAX_ENTRIES };
