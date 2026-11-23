// The real edge between two provinces, from the id raster: the pixel-grid segments where a pixel of one province
// touches a pixel of the other, chained into polylines and simplified to within RDP_EPS pixels. Vertex (x, y) is the
// corner shared by pixels (x - 1 .. x, y - 1 .. y), so every vertex of an edge touches a pixel of each province.
// Conquest.view.borderCache(ids, width, height, count) -> { edge(a, b), box(id) }.
// edge(a, b) -> Edge: [Float32Array [x0, y0, x1, y1, ...]] in texture pixels (vertex coordinates); [] when the two do
// not touch. Each pair is derived once and cached under min(a, b) * (count + 1) + max(a, b). box(id) -> [x0, y0, x1, y1]
// (pixels, inclusive) from one scan of the raster made on the first call and kept; [] boxes read as empty.
// Conquest.view.simplifyLine(points, eps) is the same simplification at another tolerance (arrows.js, zoomed out).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});
  const RDP_EPS = 0.75;

  // Ramer-Douglas-Peucker over a chain of [x, y] pairs; keeps original vertices only.
  function simplify(pts, eps = RDP_EPS) {
    const n = pts.length / 2;
    if (n <= 2) return Float32Array.from(pts);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      let far = -1;
      let fd = eps;
      for (let k = i + 1; k < j; k++) {
        const d = Math.abs((pts[2 * k] - ax) * dy - (pts[2 * k + 1] - ay) * dx) / len;
        if (d > fd) { fd = d; far = k; }
      }
      if (far >= 0) { keep[far] = 1; stack.push([i, far], [far, j]); }
    }
    const out = [];
    for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[2 * k], pts[2 * k + 1]);
    return Float32Array.from(out);
  }

  view.simplifyLine = simplify;

  view.borderCache = (ids, W, H, count) => {
    let boxes = null;
    const cache = new Map();
    const VW = W + 1;

    function scan() {
      boxes = new Int32Array((count + 1) * 4);
      for (let id = 0; id <= count; id++) { boxes[id * 4] = W; boxes[id * 4 + 1] = H; boxes[id * 4 + 2] = -1; boxes[id * 4 + 3] = -1; }
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let x = 0;
        while (x < W) {
          const id = ids[row + x];
          let e = x + 1;
          while (e < W && ids[row + e] === id) e++;
          const o = id * 4;
          if (x < boxes[o]) boxes[o] = x;
          if (y < boxes[o + 1]) boxes[o + 1] = y;
          if (e - 1 > boxes[o + 2]) boxes[o + 2] = e - 1;
          if (y > boxes[o + 3]) boxes[o + 3] = y;
          x = e;
        }
      }
    }
    const box = (id) => {
      if (!boxes) scan();
      const o = id * 4;
      return boxes[o + 2] < 0 ? [] : [boxes[o], boxes[o + 1], boxes[o + 2], boxes[o + 3]];
    };

    function derive(a, b) {
      const ba = box(a);
      const bb = box(b);
      if (!ba.length || !bb.length) return [];
      const x0 = Math.max(ba[0], bb[0]) - 1, y0 = Math.max(ba[1], bb[1]) - 1;
      const x1 = Math.min(ba[2], bb[2]) + 1, y1 = Math.min(ba[3], bb[3]) + 1;
      const next = new Map();
      const link = (p, q) => {
        (next.get(p) || next.set(p, []).get(p)).push(q);
        (next.get(q) || next.set(q, []).get(q)).push(p);
      };
      for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
          const id = ids[y * W + x];
          if (id !== a && id !== b) continue;
          const other = id === a ? b : a;
          if (x + 1 < W && ids[y * W + x + 1] === other) link(y * VW + x + 1, (y + 1) * VW + x + 1);
          if (y + 1 < H && ids[(y + 1) * W + x] === other) link((y + 1) * VW + x, (y + 1) * VW + x + 1);
        }
      }
      const used = new Set();
      const key = (p, q) => (p < q ? p * 4294967296 + q : q * 4294967296 + p);
      const walk = (start) => {
        const pts = [start % VW, Math.floor(start / VW)];
        let at = start;
        for (;;) {
          const q = (next.get(at) || []).find((n) => !used.has(key(at, n)));
          if (q === undefined) break;
          used.add(key(at, q));
          pts.push(q % VW, Math.floor(q / VW));
          at = q;
        }
        return pts;
      };
      const out = [];
      const ends = [...next.keys()].filter((p) => next.get(p).length !== 2).sort((p, q) => p - q);
      for (const p of ends.concat([...next.keys()].sort((p, q) => p - q))) {
        while ((next.get(p) || []).some((n) => !used.has(key(p, n)))) {
          const pts = walk(p);
          if (pts.length >= 4) out.push(simplify(pts));
        }
      }
      return out;
    }

    return {
      box,
      edge(a, b) {
        if (!(a > 0) || !(b > 0) || a === b) return [];
        const k = Math.min(a, b) * (count + 1) + Math.max(a, b);
        let e = cache.get(k);
        if (!e) { e = derive(a, b); cache.set(k, e); }
        return e;
      },
    };
  };
})();
