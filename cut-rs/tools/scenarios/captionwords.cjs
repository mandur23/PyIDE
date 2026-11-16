// captionwords.js with what a Rust test cannot send as JSON: the time maps a ripple passes to remap and remapDoubt,
// by name, and JavaScript's own character classes, to compare the Rust tables with.
const path = require('node:path');
const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const CW = require(path.join(CUT, 'captionwords.js'));
const time = require(path.join(CUT, 'time.js'));

// The same maps as commands.js: an insert of L at p, a ripple delete of [a, b), a frame rate change.
const MAPS = {
  identity: () => (x) => x,
  shift: (p, L) => (x, isEnd) => ((isEnd ? x > p : x >= p) ? x + L : x),
  remove: (a, b) => (x) => (x <= a ? x : x < b ? a : x - (b - a)),
  snap: (num, den) => (x) => time.snap(x, [num, den], { nearest: true }),
};
const map = ([name, ...args]) => MAPS[name](...args);

const api = {
  ...CW,
  remap: (words, from, to, fn) => CW.remap(words, from, to, map(fn)),
  remapDoubt: (doubt, from, to, fn, length) => CW.remapDoubt(doubt, from, to, map(fn), length),
  // code points from..to (surrogates left out) that /\s/, /[\p{P}\p{S}]/u match, and those toLowerCase changes
  spaces: (from, to) => points(from, to).filter((c) => /\s/.test(String.fromCodePoint(c))),
  punctOrSymbol: (from, to) => points(from, to).filter((c) => /[\p{P}\p{S}]/u.test(String.fromCodePoint(c))),
  lower: (from, to) => points(from, to).map((c) => [c, String.fromCodePoint(c).toLowerCase()]).filter(([c, l]) => l !== String.fromCodePoint(c)),
  lowerText: (texts) => texts.map((t) => t.toLowerCase()),
  unassigned: (cps) => cps.filter((c) => /\p{Cn}/u.test(String.fromCodePoint(c))),
};
// The oracle decodes stdin chunk by chunk, so a character split between chunks is lost: a test sends each call's
// arguments as an ASCII JSON text.
module.exports = { ...api, ascii: (fn, args) => api[fn](...JSON.parse(args)) };

function points(from, to) {
  const out = [];
  for (let c = from; c < to; c++) if (c < 0xd800 || c > 0xdfff) out.push(c);
  return out;
}
