// Copies the JavaScript engine's WGSL into crates/cut-engine/shaders, so the native
// engine runs the same shader text the WebGPU compositor runs. Every file says where it came from; the few changes
// wgpu's validation needs are the PATCHES below, applied here and nowhere else.
//   node tools/engine-wgsl.mjs           writes the files
//   node tools/engine-wgsl.mjs --check   exits 1 when a file differs from what the JavaScript gives (cargo test runs it)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUT = path.resolve(HERE, '..', '..', 'renderer', 'features', 'cut');
const OUT = path.resolve(HERE, '..', 'crates', 'cut-engine', 'shaders');
const fx = require(path.join(CUT, 'effects.js'));
const masks = require(path.join(CUT, 'masks.js'));
const scopes = require(path.join(CUT, 'scopes.js'));

// { file: [[from, to, why]] }: text replaced after copying.
const PATCHES = {};

// compositor.js keeps its own shaders inside createGpu: read them from its source text.
function compositorShaders() {
  const text = fs.readFileSync(path.join(CUT, 'compositor.js'), 'utf8');
  const literal = (re) => {
    const m = re.exec(text);
    if (!m) throw new Error(`compositor.js: ${re} not found`);
    return m[1];
  };
  const srgb = literal(/const SRGB_WGSL = \/\* wgsl \*\/ `([\s\S]*?)`;/);
  const body = literal(/function shaders\(fx\) \{([\s\S]*?)\n {4}\};\n {2}\}/);
  const out = {};
  for (const m of body.matchAll(/(\w+): \/\* wgsl \*\/ `([\s\S]*?)`,/g)) {
    out[m[1]] = m[2].replaceAll('${V}', fx.wgsl.VERTEX).replaceAll('${SRGB_WGSL}', srgb);
  }
  return out;
}

const files = {};
const put = (name, from, code) => {
  let text = code;
  for (const [a, b] of PATCHES[name] || []) {
    if (!text.includes(a)) throw new Error(`${name}: patch text not found: ${a}`);
    text = text.replaceAll(a, b);
  }
  files[name] = `// Copied from ${from} by tools/engine-wgsl.mjs: do not edit, rerun the tool.\n${text.trim()}\n`;
};
const comp = compositorShaders();
for (const name of ['decodeImage', 'composite', 'final', 'blit']) put(`compositor/${name}.wgsl`, `renderer/features/cut/compositor.js (shaders().${name})`, comp[name]);
for (const d of fx.list('video')) put(`effects/${d.type}.wgsl`, `renderer/features/cut/effects.js (the '${d.type}' effect's gpu.code)`, d.gpu.code);
for (const d of fx.transitions('video')) put(`transitions/${d.type}.wgsl`, `renderer/features/cut/effects.js (the '${d.type}' transition's gpu.code)`, d.gpu.code);
put('masks.wgsl', 'renderer/features/cut/masks.js (WGSL)', masks.WGSL);
put('scopes.wgsl', 'renderer/features/cut/scopes.js (WGSL)', scopes.WGSL);

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, text] of Object.entries(files)) {
  const file = path.join(OUT, name);
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (now === text) continue;
  if (check) {
    stale++;
    console.error(`${name} differs from the JavaScript`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
if (check && stale) process.exit(1);
console.log(`${Object.keys(files).length} files ${check ? 'checked' : 'written'}`);
