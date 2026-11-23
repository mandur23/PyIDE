// A generated test map in the shapes of docs/conquest-architecture.md section 3, for the view's tests and benchmark
// and for the app until data/world-1914 exists: about `provinces` Voronoi cells from a jittered grid of seeds, land
// where a smooth noise field is high, a few one-province islands, and nations grown from random land capitals.
// Conquest.view.synthetic({ seed, provinces, width, height, nations, islands }) ->
//   { map, idSource: canvas (RGB id encoding), ids: Uint32Array (the raster it encodes), owners: Int16Array, colors }
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});

  const mulberry = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const TERRAIN = ['plains', 'plains', 'plains', 'forest', 'forest', 'hills', 'mountain', 'marsh', 'desert', 'urban'];
  const PALETTE = ['#3d6cb3', '#7a7f87', '#c0504d', '#d9a441', '#6a9e4f', '#8e5aa8', '#4fa3a5', '#b5694a', '#c7b25a', '#5a6fa8',
    '#a8546f', '#7fa35a', '#d47d3c', '#4a8a6f', '#9a8ab8', '#b8a07a'];

  function synthetic({ seed = 1, provinces = 1500, width = 4096, height = 2048, nations = 12, islands = 3 } = {}) {
    const rnd = mulberry(seed);
    const gx = Math.max(2, Math.round(Math.sqrt((provinces * width) / height)));
    const gy = Math.max(2, Math.round(provinces / gx));
    const cw = width / gx;
    const ch = height / gy;
    // Jitter within [0.2, 0.8] of a cell keeps every pixel's nearest seed among the 3x3 cells around it.
    const sx = new Float32Array(gx * gy);
    const sy = new Float32Array(gx * gy);
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        sx[j * gx + i] = Math.floor((i + 0.2 + rnd() * 0.6) * cw);
        sy[j * gx + i] = Math.floor((j + 0.2 + rnd() * 0.6) * ch);
      }
    }
    const NX = 10;
    const NY = 6;
    const noise = Array.from({ length: (NX + 1) * (NY + 1) }, () => rnd());
    const land = (x, y) => {
      const u = (x / width) * NX;
      const v = (y / height) * NY;
      const i = Math.min(NX - 1, Math.floor(u));
      const j = Math.min(NY - 1, Math.floor(v));
      const fu = u - i;
      const fv = v - j;
      const n = (a, b) => noise[b * (NX + 1) + a];
      const h = (n(i, j) * (1 - fu) + n(i + 1, j) * fu) * (1 - fv) + (n(i, j + 1) * (1 - fu) + n(i + 1, j + 1) * fu) * fv;
      const edge = Math.min(x, width - x, y, height - y) / Math.min(width, height);
      return h > 0.45 && edge > 0.04;
    };

    const cells = new Uint32Array(width * height);
    for (let y = 0; y < height; y++) {
      const cj = Math.min(gy - 1, Math.floor(y / ch));
      for (let x = 0; x < width; x++) {
        const ci = Math.min(gx - 1, Math.floor(x / cw));
        let best = 0;
        let bd = Infinity;
        for (let j = Math.max(0, cj - 1); j <= Math.min(gy - 1, cj + 1); j++) {
          for (let i = Math.max(0, ci - 1); i <= Math.min(gx - 1, ci + 1); i++) {
            const k = j * gx + i;
            const dx = sx[k] - x;
            const dy = sy[k] - y;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = k; }
          }
        }
        cells[y * width + x] = best + 1;
      }
    }
    const count = gx * gy;
    const sea = Array.from({ length: count + 1 }, (_, id) => id > 0 && !land(sx[id - 1], sy[id - 1]));
    const anchors = Array.from({ length: count + 1 }, (_, id) => (id ? [sx[id - 1], sy[id - 1]] : null));

    // Islands: a small disc inside a sea cell, away from the cell's seed, becomes a land province of its own.
    let next = count + 1;
    const r = Math.max(3, Math.floor(Math.min(cw, ch) * 0.12));
    for (let tries = 0; tries < 400 && next <= count + islands; tries++) {
      const id = 1 + Math.floor(rnd() * count);
      if (!sea[id]) continue;
      const [ax, ay] = anchors[id];
      const cx = Math.round(ax + (rnd() < 0.5 ? -1 : 1) * cw * 0.25);
      const cy = Math.round(ay);
      let fits = cx - r > 0 && cx + r < width && cy - r > 0 && cy + r < height;
      for (let y = cy - r - 2; fits && y <= cy + r + 2; y++) {
        for (let x = cx - r - 2; x <= cx + r + 2; x++) if (cells[y * width + x] !== id) { fits = false; break; }
      }
      if (!fits) continue;
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) cells[y * width + x] = next;
      }
      sea[next] = false;
      anchors[next] = [cx, cy];
      next++;
    }
    const total = next - 1;

    const adj = Array.from({ length: total + 1 }, () => new Set());
    const area = new Uint32Array(total + 1);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = cells[y * width + x];
        area[a]++;
        const b = x + 1 < width ? cells[y * width + x + 1] : a;
        const c = y + 1 < height ? cells[(y + 1) * width + x] : a;
        if (b !== a) { adj[a].add(b); adj[b].add(a); }
        if (c !== a) { adj[a].add(c); adj[c].add(a); }
      }
    }

    const pxPerDeg = width / 360;
    const kmPerPx = 40075 / width;
    const provs = [null];
    for (let id = 1; id <= total; id++) {
      const [x, y] = anchors[id];
      const near = [...adj[id]].sort((a, b) => a - b);
      provs.push({
        id, name: `${sea[id] ? 'Sea' : 'Province'} ${id}`, sea: sea[id], iso: '',
        x, y, lon: +(x / pxPerDeg - 180).toFixed(2), lat: +(90 - y / pxPerDeg).toFixed(2),
        area: Math.round(area[id] * kmPerPx * kmPerPx),
        ...(sea[id] ? {} : {
          terrain: TERRAIN[Math.floor(rnd() * TERRAIN.length)], climate: 'temperate',
          coastal: near.some((n) => sea[n]), port: false,
        }),
        adj: near, ...(sea[id] ? {} : { river: [] }),
      });
    }
    const map = {
      v: 1, id: `synthetic-${seed}`, name: 'Generated map',
      texture: { file: null, width, height },
      projection: { type: 'equirect', lon0: -180, lat0: 90, pxPerDeg },
      provinces: provs, straits: [],
    };

    const owners = new Int16Array(total + 1).fill(-1);
    const landIds = provs.filter((p) => p && !p.sea).map((p) => p.id);
    const capitals = [];
    while (capitals.length < Math.min(nations, landIds.length)) {
      const id = landIds[Math.floor(rnd() * landIds.length)];
      if (!capitals.includes(id)) capitals.push(id);
    }
    for (const id of landIds) {
      let best = 0;
      let bd = Infinity;
      capitals.forEach((c, n) => {
        const d = (provs[c].x - provs[id].x) ** 2 + (provs[c].y - provs[id].y) ** 2;
        if (d < bd) { bd = d; best = n; }
      });
      owners[id] = best;
    }
    const colors = capitals.map((_, n) => PALETTE[n % PALETTE.length]);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const img = g.createImageData(width, height);
    const px = img.data;
    for (let i = 0, o = 0; i < cells.length; i++, o += 4) {
      const id = cells[i];
      px[o] = id >>> 16;
      px[o + 1] = (id >>> 8) & 255;
      px[o + 2] = id & 255;
      px[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return { map, idSource: canvas, ids: cells, owners, colors, capitals };
  }

  view.synthetic = synthetic;
})();
