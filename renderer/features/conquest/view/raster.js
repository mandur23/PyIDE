// The id image of a generated map (sim/mapgen.js), which carries polygons per province (map.cells) instead of a texture
// file: Conquest.view.rasterize(map) -> a canvas of map.texture's size in the ids.png encoding (r << 16 | g << 8 | b).
// Polygons are filled by pixel centre with an even-odd scanline, not by the 2D canvas, whose antialiased edges would
// blend two ids into a third.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});

  function fillPolygon(ids, W, H, pts, id) {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 1; i < pts.length; i += 2) { y0 = Math.min(y0, pts[i]); y1 = Math.max(y1, pts[i]); }
    const n = pts.length / 2;
    const xs = [];
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = pts[2 * i]; const ay = pts[2 * i + 1];
        const bx = pts[2 * j]; const by = pts[2 * j + 1];
        if ((ay <= cy) !== (by <= cy)) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] - 0.5));
        const to = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = from; x <= to; x++) ids[y * W + x] = id;
      }
    }
  }

  view.rasterize = (map) => {
    const W = map.texture.width;
    const H = map.texture.height;
    const ids = new Uint32Array(W * H);
    for (let id = 1; id < map.provinces.length; id++) for (const poly of map.cells?.[id] || []) fillPolygon(ids, W, H, poly, id);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const img = g.createImageData(W, H);
    for (let i = 0, o = 0; i < ids.length; i++, o += 4) {
      const v = ids[i];
      img.data[o] = (v >> 16) & 255;
      img.data[o + 1] = (v >> 8) & 255;
      img.data[o + 2] = v & 255;
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return canvas;
  };
})();
