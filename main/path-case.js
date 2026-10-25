// Folders with case sensitivity turned on (`fsutil file setCaseSensitiveInfo <dir> enable`, or folders WSL made): there,
// a.py and A.py are two files. Documents, tabs and shared documents identify a file by pathKey: the path in lower case,
// except the names inside such folders (renderer/core/ide.js has the same function, fed by caseSensitiveDirs).
// Windows has no cheap query for the flag, so a folder is tested by looking up one of its entries with its letters'
// case swapped: an ordinary folder finds the same file. A folder without such an entry is tested again next time.
const fs = require('fs');
const path = require('path');

const tested = new Map(); // folder path as given -> whether it is case-sensitive
const sensitive = new Set(); // dirKey of each case-sensitive folder found
const sensitiveLower = []; // the same, lower-cased, to skip paths outside them quickly

const dirKey = (key) => key.replace(/[\\/]+/g, '\\').replace(/\\$/, '');
const swapCase = (s) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

function pathKey(p) {
  const s = String(p);
  const lower = s.toLowerCase();
  if (!sensitive.size) return lower;
  const probe = `${dirKey(lower)}\\`;
  if (!sensitiveLower.some((d) => probe.startsWith(`${d}\\`))) return lower;
  const parts = s.split(/([\\/]+)/);
  let key = '';
  for (let i = 0; i < parts.length; i += 2) key += (i && sensitive.has(dirKey(key)) ? parts[i] : parts[i].toLowerCase()) + (parts[i + 1] || '');
  return key;
}

async function test(dir) {
  if (tested.has(dir)) return tested.get(dir);
  let d = null;
  try {
    d = await fs.promises.opendir(dir);
    for (let ent = await d.read(); ent; ent = await d.read()) {
      const swapped = swapCase(ent.name);
      if (swapped === ent.name) continue;
      // A swapped name that cannot be looked up for another reason than ENOENT (a busy system file) tells nothing.
      const [a, b] = await Promise.all([path.join(dir, ent.name), path.join(dir, swapped)]
        .map((f) => fs.promises.lstat(f, { bigint: true }).catch((err) => (err.code === 'ENOENT' ? null : undefined))));
      if (!a || b === undefined) continue;
      const result = !b || b.ino !== a.ino || b.dev !== a.dev;
      tested.set(dir, result);
      return result;
    }
  } catch {} finally {
    d?.close().catch(() => {});
  }
  return false;
}

// -> the dirKeys of `folder` and its parents that are case-sensitive.
async function caseSensitiveDirs(folder) {
  const dirs = [];
  const start = String(folder);
  for (let d = /^[a-z]:$/i.test(start) ? start + path.sep : start; ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (path.dirname(d) === d) break;
  }
  const flags = await Promise.all(dirs.map(test));
  const found = [];
  dirs.forEach((d, i) => {
    if (!flags[i]) return;
    const k = dirKey(pathKey(d));
    if (!sensitive.has(k)) { sensitive.add(k); sensitiveLower.push(k.toLowerCase()); }
    found.push(k);
  });
  return found;
}

module.exports = { pathKey, caseSensitiveDirs };
