// graphic.js's drawing for the Rust port (crates/cut-engine/src/graphic): what graphic.draw asks of a Canvas 2D
// context, recorded by a context that only listens, read back as plain data: the particles a layer draws at a time and
// the lines of text a text layer writes; and the time graphic.draw takes on a canvas-shaped recorder (its own work,
// without a rasteriser).
const path = require('node:path');

const G = require(path.join(__dirname, '..', '..', '..', 'renderer', 'features', 'cut', 'graphic.js'));

function record(layers, t) {
  const ops = [];
  const g = new Proxy({ __alpha: 1 }, {
    get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^create\w+Gradient$/.test(k) ? () => ({ addColorStop: () => {} }) : (...args) => { ops.push([k, ...args]); }),
    set: (o, k, v) => { o[k] = v; ops.push([`=${String(k)}`, v]); return true; },
  });
  G.draw(g, layers, { w: 0, h: 0, scale: 1, t });
  return ops;
}

module.exports = {
  // A particle layer (placed at the origin, unturned, at 100 %) at t seconds: [{x, y, size, alpha, color, turn}].
  particles: (layer, t) => {
    const ops = record([G.normalize(layer)], t);
    const out = [];
    let alpha = 1, color = null;
    for (let i = 0; i < ops.length; i++) {
      const [k, ...a] = ops[i];
      if (k === '=globalAlpha') alpha = a[0];
      else if (k === '=fillStyle') color = a[0];
      else if (k === 'arc') out.push({ x: a[0], y: a[1], size: a[2] * 2, alpha, color, turn: null });
      else if (k === 'translate' && ops[i - 1]?.[0] === 'save' && ops[i - 2]?.[0] === '=fillStyle') {
        const turn = (ops[i + 1][1] * 180) / Math.PI;
        const size = ops[i + 2][3];
        out.push({ x: a[0], y: a[1], size, alpha, color, turn });
      }
    }
    return out;
  },
  // The lines a text layer writes with fillText (or strokeText when it has no fill).
  lines: (layer) => record([G.normalize(layer)], 0).filter((o) => o[0] === 'fillText' || o[0] === 'strokeText').map((o) => o[1]),
  // Milliseconds graphic.draw takes per call for these layers (resolved here at t seconds of a clip with no keyframes).
  drawMs: (layers, t, n) => {
    const resolved = layers.map((l) => G.resolve(l, {}, 0));
    const g = new Proxy({ __alpha: 1 }, { get: (o, k) => (k in o ? o[k] : /^create\w+Gradient$/.test(String(k)) ? () => ({ addColorStop: () => {} }) : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) G.draw(g, resolved, { w: 1920, h: 1080, scale: 1, t });
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  },
};
