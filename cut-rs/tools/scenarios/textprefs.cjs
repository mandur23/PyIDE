// The Text panel's and the preferences' pure parts for the Rust port (crates/cut-app/src/text_ui and src/prefs): the
// motion presets (textrender.js), the font style nearest a weight (ui-text.js), the keymap's key check and stored keys
// (renderer/core/ide.js), the shortcut kinds (ui-keys.js), the proxy's name and size (ui-proxy.js), and the folder
// search of relinking (main/cut/find.js). The panels' functions are taken out of their source text by name, as
// controls.cjs does, and run here exactly as written.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CUT = path.join(ROOT, 'renderer', 'features', 'cut');
const textrender = require(path.join(CUT, 'textrender.js'));
const find = require(path.join(ROOT, 'main', 'cut', 'find.js'));

// The text of `function name(` or `const name =` up to the end of its body: balanced braces, else the line's `;`.
function take(src, name) {
  const m = new RegExp(`\\n\\s*(function ${name}\\(|const ${name} = )`).exec(src);
  if (!m) throw new Error(`${name} is not in the source`);
  const from = m.index + m[0].indexOf(m[1]);
  const open = src.indexOf('{', from);
  const semi = src.indexOf(';', from);
  if (semi >= 0 && (open < 0 || semi < open)) return src.slice(from, semi + 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error(`${name} does not end`);
}
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
// eslint-disable-next-line no-new-func
const load = (src, names, ret) => new Function(`${names.map((n) => take(src, n)).join('\n')}\nreturn { ${ret} };`)();

const ide = load(read(ROOT, 'renderer', 'core', 'ide.js'), ['MODIFIER_KEYS', 'STROKE', 'validStroke', 'validKey', 'parseKeymap'], 'validKey, parseKeymap');
const keys = load(read(CUT, 'ui-keys.js'), ['KINDS', 'kindOf'], 'kindOf');
const proxy = load(read(CUT, 'ui-proxy.js'), ['even', 'sizeOf', 'hash'], 'sizeOf, hash');
const text = load(read(CUT, 'ui-text.js'), ['nearest'], 'nearest');

module.exports = {
  presetApply: (clip, layerId, id, out, frame) => textrender.animations.apply(clip, layerId, id, { out, frame }),
  nearest: (styles, weight, italic) => text.nearest(styles, weight, italic) ?? null,
  validKey: (k) => ide.validKey(k),
  parseKeymap: (raw) => Object.fromEntries(ide.parseKeymap(raw)),
  kindOf: (id) => keys.kindOf(id),
  proxySize: (w, h, height) => proxy.sizeOf({ video: w || h ? { w, h } : null }, height),
  proxyHash: (t) => proxy.hash(t),
  findMedia: (folder, wanted) => find.findMedia(folder, wanted),
};
