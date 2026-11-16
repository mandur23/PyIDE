// The lane maths of Effect Controls (ui-controls.js) and the keyframe menu's easeList (ui-timeline.js) for the Rust
// port (crates/cut-app/src/controls): both files are panels that need a page, so the functions are taken out of their
// source text by name and run here on keyframes.js and model.js, exactly as written.
const fs = require('node:fs');
const path = require('node:path');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const K = require(path.join(CUT, 'keyframes.js'));
const model = require(path.join(CUT, 'model.js'));

// The text of `function name(` or `const name =` up to the end of its body: balanced braces, else the line's `;`.
function take(src, name) {
  const m = new RegExp(`\\n\\s*(function ${name}\\(|const ${name} = |${name}\\([^)]*\\) \\{)`).exec(src);
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

const controls = fs.readFileSync(path.join(CUT, 'ui-controls.js'), 'utf8');
const timeline = fs.readFileSync(path.join(CUT, 'ui-timeline.js'), 'utf8');
const body = ['laneX', 'laneT', 'direction', 'LANE_PAD', 'segment', 'keyAt', 'handleAt'].map((n) => take(controls, n)).join('\n');
const ease = take(timeline, 'easeList').replace(/^easeList/, 'function easeList');
// eslint-disable-next-line no-new-func
const lane = new Function('K', 'model', 'clipNow', `${body}\n${ease}\nreturn { laneX, laneT, direction, segment, keyAt, handleAt, easeList };`);

// keyAt and handleAt read the clip and the lane's size from the page: a row with the lane w x h points.
const run = (clip) => lane(K, model, () => clip);
const entry = (clip, path, w, h) => ({ clipId: clip.id, path, lane: { canvas: { parentElement: { clientWidth: w, clientHeight: h } } } });
const plain = (s) => s && { xa: s.xa, xb: s.xb, pts: s.pts, handles: s.handles, y0: s.yOf(0), y1: s.yOf(1), yHalf: s.yOf(0.5), pTop: s.pOf(4), pMid: s.pOf(s.yOf(0.25)) };

module.exports = {
  laneX: (clip, w, t) => run(clip).laneX(clip, w, t),
  laneT: (clip, w, x) => run(clip).laneT(clip, w, x),
  direction: (a, b) => run(null).direction(a, b),
  segment: (clip, list, i, w, h) => plain(run(clip).segment(clip, list, i, w, h)),
  keyAt: (clip, path, w, h, x) => run(clip).keyAt(entry(clip, path, w, h), x)?.t ?? null,
  handleAt: (clip, path, w, h, x, y) => {
    const r = run(clip).handleAt(entry(clip, path, w, h), x, y);
    return r && { index: r.index, which: r.which };
  },
  easeList: (list, times, e) => run(null).easeList(list, times, e),
};
