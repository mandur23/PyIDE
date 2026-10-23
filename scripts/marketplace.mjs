// Builds the online plugin Marketplace: one <id>-<version>.zip per plugin folder and an index.json (format 1, read by
// main/marketplace.js) with each zip's sha256 and size. The URLs are relative to index.json, so the folder works
// wherever it is served from: committed to the repository it is
// https://raw.githubusercontent.com/mandur23/PyIDE/master/marketplace/index.json, PyIDE's default index.
//
//   node scripts/marketplace.mjs [plugins folder] [--out folder]     (defaults: plugins-catalog, marketplace)
//
// A plugin folder holds plugin.json ({id, name, version, vendor, description, i18n?, minIdeVersion?, homepage?}).
// The output folder belongs to this script: zips the new index does not list are removed. Zips are built the same
// way every time (sorted entries, fixed timestamps), so an unchanged plugin keeps its file and sha256.
import { createHash } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import zlib from 'zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const market = require('../main/marketplace.js');

function filesUnder(dir, rel = '') {
  return readdirSync(path.join(dir, rel), { withFileTypes: true })
    .filter((d) => !d.isSymbolicLink() && d.name !== '__pycache__' && !d.name.startsWith('.'))
    .flatMap((d) => (d.isDirectory() ? filesUnder(dir, path.posix.join(rel, d.name)) : d.isFile() ? [path.posix.join(rel, d.name)] : []))
    .sort();
}

// A zip of `files` ([{name, data}]), deflated where that is smaller, dated 1980-01-01.
export function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const [method, body] = deflated.length < data.length ? [8, deflated] : [0, data];
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, body);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export const zipFolder = (dir) => zipFiles(filesUnder(dir).map((name) => ({ name, data: readFileSync(path.join(dir, name)) })));

export function buildMarketplace({ source = path.join(ROOT, 'plugins-catalog'), out = path.join(ROOT, 'marketplace') } = {}) {
  const plugins = [];
  for (const d of readdirSync(source, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(source, d.name);
    let meta;
    try { meta = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const zip = zipFolder(dir);
    const file = `${meta.id}-${meta.version}.zip`;
    plugins.push({
      id: meta.id,
      name: meta.name,
      version: meta.version,
      vendor: meta.vendor,
      description: meta.description,
      ...(meta.i18n ? { i18n: meta.i18n } : {}),
      ...(meta.minIdeVersion ? { minIdeVersion: meta.minIdeVersion } : {}),
      url: file,
      sha256: createHash('sha256').update(zip).digest('hex'),
      size: zip.length,
      ...(meta.homepage ? { homepage: meta.homepage } : {}),
      zip,
    });
  }
  const index = { format: market.FORMAT, plugins: plugins.map(({ zip, ...entry }) => entry) };
  const text = `${JSON.stringify(index, null, 2)}\n`;
  // The same checks PyIDE makes when it reads the index: a plugin.json the Marketplace would refuse stops the build.
  market.parseIndex(text, pathToFileURL(path.join(out, 'index.json')).href);
  mkdirSync(out, { recursive: true });
  for (const p of plugins) writeFileSync(path.join(out, p.url), p.zip);
  writeFileSync(path.join(out, 'index.json'), text);
  const keep = new Set(plugins.map((p) => p.url));
  const removed = readdirSync(out).filter((f) => /\.zip$/i.test(f) && !keep.has(f));
  for (const f of removed) rmSync(path.join(out, f));
  return { index, out, removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = at >= 0 ? path.resolve(args.splice(at, 2)[1]) : undefined;
  try {
    const r = buildMarketplace({ source: args[0] ? path.resolve(args[0]) : undefined, out });
    for (const p of r.index.plugins) console.log(`${p.url}  ${p.size} bytes  sha256 ${p.sha256}`);
    for (const f of r.removed) console.log(`removed ${f}`);
    console.log(`${r.index.plugins.length} plugins -> ${path.join(r.out, 'index.json')} (${statSync(path.join(r.out, 'index.json')).size} bytes)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
