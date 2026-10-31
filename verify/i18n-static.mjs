// Every literal passed to tr() anywhere in the renderer (core, bundled plugins, catalog plugins) must have a Korean
// entry in the dictionary that will be loaded with it, in each app mode (code, craft) the plugin runs in.
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
// A process loads only the plugins of its mode, and their dictionaries (main/plugin-manager.js: inMode).
const inMode = (d, mode) => {
  const meta = readDict(path.join(d, 'plugin.json'));
  const modes = [].concat(meta.modes || []).filter((m) => m === 'code' || m === 'craft');
  return !!meta.required || (modes.length ? modes : ['code']).includes(mode);
};
const dictOf = (dirs) => Object.assign({}, core, ...dirs.map((d) => readDict(path.join(d, 'locales', 'ko.json'))));
const catalog = path.join(APP, 'plugins-catalog');
const catalogDirs = readdirSync(catalog).map((x) => path.join(catalog, x));

const problems = [];
const used = new Set();
const checkUnit = (label, files, dict) => {
  for (const f of files) for (const s of literals(f)) {
    used.add(s);
    if (!(s in dict)) problems.push(`${label}: no Korean for ${JSON.stringify(s)} (${path.relative(APP, f)})`);
  }
};
checkUnit('core', jsFiles(path.join(APP, 'renderer', 'core')), core);
const counts = {};
for (const mode of ['code', 'craft']) {
  const before = problems.length;
  const dirs = bundledDirs.filter((d) => inMode(d, mode));
  const dict = dictOf(dirs);
  for (const d of dirs) checkUnit(`${mode}/${path.basename(d)}`, jsFiles(d), dict);
  // Catalog plugins load only their own dictionary on top of the bundled ones.
  for (const d of catalogDirs.filter((x) => inMode(x, mode))) {
    checkUnit(`${mode}/catalog/${path.basename(d)}`, jsFiles(d), { ...dict, ...readDict(path.join(d, 'locales', 'ko.json')) });
  }
  counts[mode] = problems.length - before;
}
const bundledDict = dictOf(bundledDirs);

// The core also translates static markup through data-i18n attributes.
const html = readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) {
  used.add(m[1]);
  if (!(m[1] in core)) problems.push(`index.html: no Korean for ${JSON.stringify(m[1])}`);
}

const dynamic = Object.keys(bundledDict).filter((k) => !used.has(k));
console.log(`${used.size} distinct UI strings checked; ${problems.length} missing (code mode ${counts.code}, craft mode ${counts.craft}); ${dynamic.length} dictionary entries only reachable dynamically (plugin names, mapped messages)`);
for (const p of problems) console.log(`FAIL ${p}`);
process.exit(problems.length ? 1 : 0);
