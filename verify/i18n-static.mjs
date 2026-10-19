// Every literal passed to tr() anywhere in the renderer (core, bundled plugins, catalog plugins) must have a Korean
// entry in the dictionary that will be loaded with it.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITERAL = /\btr\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const literals = (file) => [...readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').matchAll(LITERAL)]
  .filter((m) => m[1] !== '`' || !m[2].includes('${'))
  .map((m) => m[2].replace(/\\(['"`\\])/g, '$1'));
const readDict = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const jsFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

const core = readDict(path.join(APP, 'renderer', 'locales', 'ko.json'));
const bundledDirs = readdirSync(path.join(APP, 'renderer', 'features')).map((d) => path.join(APP, 'renderer', 'features', d));
const bundledDict = Object.assign({}, core, ...bundledDirs.map((d) => readDict(path.join(d, 'locales', 'ko.json'))));

const problems = [];
const used = new Set();
const checkUnit = (label, files, dict) => {
  for (const f of files) for (const s of literals(f)) {
    used.add(s);
    if (!(s in dict)) problems.push(`${label}: no Korean for ${JSON.stringify(s)} (${path.relative(APP, f)})`);
  }
};
checkUnit('core', jsFiles(path.join(APP, 'renderer', 'core')), core);
for (const d of bundledDirs) checkUnit(path.basename(d), jsFiles(d), bundledDict);
// Catalog plugins load only their own dictionary on top of the bundled ones.
const catalog = path.join(APP, 'plugins-catalog');
for (const d of readdirSync(catalog).map((x) => path.join(catalog, x))) {
  checkUnit(`catalog/${path.basename(d)}`, jsFiles(d), { ...bundledDict, ...readDict(path.join(d, 'locales', 'ko.json')) });
}

// The core also translates static markup through data-i18n attributes.
const html = readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) {
  used.add(m[1]);
  if (!(m[1] in core)) problems.push(`index.html: no Korean for ${JSON.stringify(m[1])}`);
}

const dynamic = Object.keys(bundledDict).filter((k) => !used.has(k));
console.log(`${used.size} distinct UI strings checked; ${problems.length} missing; ${dynamic.length} dictionary entries only reachable dynamically (plugin names, mapped messages)`);
for (const p of problems) console.log(`FAIL ${p}`);
process.exit(problems.length ? 1 : 0);
