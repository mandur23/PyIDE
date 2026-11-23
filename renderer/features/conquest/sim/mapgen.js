// generate({ seed, provinces, nations, divisions, islands }): a made-up world { map, scenario } in the shapes of architecture
// sections 3 and 4, the same for the same arguments on every machine. It is the engine's test map and the game's
// generated-map mode, from 8 to 5000 land provinces.
//
// The world is a brick grid (odd rows shifted half a cell, so every cell has six neighbours) whose shared vertices
// are jittered from a hash, giving irregular cells that still tile exactly. Land is grown from the centre, highest
// elevation-minus-distance first, until it has `provinces` cells less the islands': one connected landmass. With
// `islands` (default 0, at most provinces / 8) that many islands of 1 to 3 cells are placed in the sea, never
// touching other land; each has a port and is a colony of nation (island index mod nations) with a garrison of one
// division, and every even-numbered island two cells from the mainland is joined to it by a strait. Every other cell
// is sea.
// Sea cells are grouped into zones by 5×5 blocks (connected parts of a block). Terrain comes from elevation and
// moisture noise (by percentile, so every size gets mountains), climate from latitude. Rivers follow cell edges
// from a random edge towards lower ground until they reach the sea. Nations: capitals by farthest-point sampling,
// land by breadth-first growth from them. Divisions (default 0.3 per province) are shared by land area and placed
// on each nation's borders in armies of at most 24. Coastal provinces are ports with 35% chance (capitals always);
// nations get a navy (majors 80..120, others 0..30) and provinces coal, iron and oil levels.
//
// map.cells[id] is the list of polygons of a province (flat [x, y, x, y, ...] in map pixels; a land province has
// one, a sea zone one per grid cell) and map.texture is { file: null, width, height }: the view rasterises cells.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).mapgen = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;
  const R = NODE ? require('./rng.js') : globalThis.Conquest.rng;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;

  const CW = 40;
  const CH = 34;
  const KM_PER_PX = 1.2;
  const PX_PER_DEG = 111 / KM_PER_PX;
  const CLIMATES = ['arctic', 'cold', 'temperate', 'mediterranean', 'arid', 'tropical'];
  const SYL = ['ar', 'bel', 'cor', 'dan', 'el', 'fen', 'gor', 'hal', 'is', 'jor', 'kal', 'lin', 'mar', 'nor', 'os', 'pel', 'quin', 'ros', 'sal', 'tor', 'ul', 'var', 'wen', 'yl', 'zan', 'bra', 'dru', 'kre', 'sto', 'vin'];
  const TRAITS = ['offence', 'defence', 'terrain', 'logistics'];

  function mix(x, y, salt) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function noise(col, row, s, salt) {
    const ix = Math.floor(col / s);
    const iy = Math.floor(row / s);
    const fx = col - ix * s;
    const fy = row - iy * s;
    const v = (x, y) => mix(x, y, salt) & 1023;
    const top = v(ix, iy) * (s - fx) + v(ix + 1, iy) * fx;
    const bot = v(ix, iy + 1) * (s - fx) + v(ix + 1, iy + 1) * fx;
    return Math.trunc((top * (s - fy) + bot * fy) / (s * s));
  }

  function name(r) {
    const n = 2 + R.int(r, 2);
    let s = '';
    for (let i = 0; i < n; i++) s += SYL[R.int(r, SYL.length)];
    return s[0].toUpperCase() + s.slice(1);
  }

  function color(i) {
    const h = ((i * 137.508) % 360) / 60;
    const c = 0.55;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    const hex = (v) => Math.round((v + 0.3) * 255).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  function generate(opts = {}) {
    const seed = opts.seed | 0;
    const N = Math.max(8, opts.provinces | 0 || 200);
    const nIslands = Math.max(0, Math.min(opts.islands | 0, Math.floor(N / 8)));
    const K = Math.max(1, Math.min(opts.nations | 0 || 4, Math.floor(N / 2)));
    const r = R.seed(seed ^ 0x6d617067);
    const want = Math.ceil(N * 1.6);
    const inner = Math.max(4, F.isqrt(Math.round(want * 1.4)));
    const cols = inner + 2;
    const rows = Math.max(3, Math.ceil(want / inner)) + 2;
    const C = cols * rows;
    const nb = [];
    for (let c = 0; c < C; c++) {
      const row = Math.floor(c / cols);
      const col = c % cols;
      const out = [];
      if (col > 0) out.push(c - 1);
      if (col < cols - 1) out.push(c + 1);
      for (const dr of [-1, 1]) {
        const rr = row + dr;
        if (rr < 0 || rr >= rows) continue;
        const c0 = row & 1 ? col : col - 1;
        for (const cc of [c0, c0 + 1]) if (cc >= 0 && cc < cols) out.push(rr * cols + cc);
      }
      nb.push(out.sort((a, b) => a - b));
    }
    const s1 = R.next(r) | 0;
    const s2 = R.next(r) | 0;
    const s3 = R.next(r) | 0;
    const s4 = R.next(r) | 0;
    const elev = new Int32Array(C);
    const moist = new Int32Array(C);
    for (let c = 0; c < C; c++) {
      const row = Math.floor(c / cols);
      const col = c % cols;
      elev[c] = Math.trunc((noise(col, row, 6, s1) * 2 + noise(col, row, 3, s2)) / 3);
      moist[c] = Math.trunc((noise(col, row, 5, s3) * 2 + noise(col, row, 2, s4)) / 3);
    }

    const land = new Uint8Array(C);
    const crow = rows >> 1;
    const ccol = cols >> 1;
    const rb = Math.max(2, F.isqrt(N));
    const interior = (c) => { const row = Math.floor(c / cols); const col = c % cols; return row > 0 && row < rows - 1 && col > 0 && col < cols - 1; };
    const prio = (c) => { const dr = Math.floor(c / cols) - crow; const dc = (c % cols) - ccol; return elev[c] - Math.trunc((F.isqrt(dr * dr + dc * dc) * 1000) / rb); };
    const grow = M.heap();
    grow.push(-prio(crow * cols + ccol), crow * cols + ccol);
    const isleSize = [];
    for (let i = 0; i < nIslands; i++) isleSize.push(1 + R.int(r, 3));
    let count = 0;
    const growTo = (target) => {
      while (count < target && grow.size) {
        const c = grow.pop();
        if (land[c]) continue;
        land[c] = 1;
        count++;
        for (const q of nb[c]) if (!land[q] && interior(q)) grow.push(-prio(q), q);
      }
    };
    growTo(N - isleSize.reduce((a, b) => a + b, 0));
    const isle = new Int32Array(C).fill(-1);
    const isleCells = [];
    for (let i = 0; i < nIslands; i++) {
      const fits = (c) => interior(c) && !land[c] && nb[c].every((q) => !land[q] || isle[q] === i);
      const start = R.int(r, C);
      let seed = -1;
      const coastNear = (c) => nb[c].some((q) => nb[q].some((x) => land[x] && isle[x] < 0));
      for (let pass = i % 2 ? 1 : 0; pass < 2 && seed < 0; pass++) {
        for (let t = 0; t < C && seed < 0; t++) { const c = (start + t) % C; if (fits(c) && nb[c].every((q) => !land[q]) && (pass || coastNear(c))) seed = c; }
      }
      if (seed < 0) break;
      const mine = [seed];
      land[seed] = 1; isle[seed] = i; count++;
      for (let j = 0; j < mine.length && mine.length < isleSize[i]; j++) {
        for (const q of nb[mine[j]]) {
          if (mine.length >= isleSize[i] || !fits(q)) continue;
          land[q] = 1; isle[q] = i; count++; mine.push(q);
        }
      }
      isleCells.push(mine.sort((a, b) => a - b));
    }
    growTo(N);

    const cellProv = new Int32Array(C);
    let id = 0;
    for (let c = 0; c < C; c++) if (land[c]) cellProv[c] = ++id;
    const B = 5;
    const block = (c) => Math.floor(Math.floor(c / cols) / B) * 1000 + Math.floor((c % cols) / B);
    const zones = [];
    for (let c = 0; c < C; c++) {
      if (land[c] || cellProv[c]) continue;
      const zid = N + zones.length + 1;
      const cells = [c];
      cellProv[c] = zid;
      for (let i = 0; i < cells.length; i++) {
        for (const q of nb[cells[i]]) if (!land[q] && !cellProv[q] && block(q) === block(c)) { cellProv[q] = zid; cells.push(q); }
      }
      zones.push(cells.sort((a, b) => a - b));
    }

    const vtx = (k, row) => {
      const edge = row === 0 || row === rows || k <= 0 || k >= 2 * cols;
      const jx = edge ? 0 : (mix(k, row, s1 ^ 77) % 11) - 5;
      const jy = edge ? 0 : (mix(k, row, s2 ^ 91) % 11) - 5;
      return [Math.trunc((k * CW) / 2) + jx, row * CH + jy];
    };
    const poly = (c) => {
      const row = Math.floor(c / cols);
      const k0 = 2 * (c % cols) + (row & 1);
      return [...vtx(k0, row), ...vtx(k0 + 1, row), ...vtx(k0 + 2, row), ...vtx(k0 + 2, row + 1), ...vtx(k0 + 1, row + 1), ...vtx(k0, row + 1)];
    };
    const centre = (pts) => { let x = 0; let y = 0; for (let i = 0; i < pts.length; i += 2) { x += pts[i]; y += pts[i + 1]; } return [Math.round((x * 2) / pts.length), Math.round((y * 2) / pts.length)]; };
    const areaPx = (pts) => { let a = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; } return Math.abs(a) / 2; };
    const width = (2 * cols + 1) * (CW / 2);
    const height = rows * CH;
    const lon0 = -5;
    const lat0 = 48 + height / PX_PER_DEG / 2;
    const geo = (x, y) => ({ lon: Math.round((lon0 + x / PX_PER_DEG) * 100) / 100, lat: Math.round((lat0 - y / PX_PER_DEG) * 100) / 100 });
    const km2 = (px) => Math.max(1, Math.round(px * KM_PER_PX * KM_PER_PX));

    const landCells = [];
    for (let c = 0; c < C; c++) if (land[c]) landCells.push(c);
    const sortedElev = landCells.map((c) => elev[c]).sort((a, b) => a - b);
    const sortedMoist = landCells.map((c) => moist[c]).sort((a, b) => a - b);
    const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor((arr.length * q) / 100))];
    const eMount = pct(sortedElev, 93);
    const eHill = pct(sortedElev, 80);
    const eLow = pct(sortedElev, 20);
    const mWet = pct(sortedMoist, 70);
    const mMarsh = pct(sortedMoist, 85);
    const mDry = pct(sortedMoist, 12);

    const provinces = [null];
    const cells = [null];
    for (const c of landCells) {
      const pts = poly(c);
      const [x, y] = centre(pts);
      const g = geo(x, y);
      let terrain = 'plains';
      if (elev[c] >= eMount) terrain = 'mountain';
      else if (elev[c] >= eHill) terrain = 'hills';
      else if (moist[c] >= mMarsh && elev[c] <= eLow) terrain = 'marsh';
      else if (moist[c] >= mWet) terrain = 'forest';
      else if (moist[c] <= mDry && g.lat < 42) terrain = 'desert';
      let ci = g.lat >= 62 ? 0 : g.lat >= 54 ? 1 : g.lat >= 43 ? 2 : g.lat >= 36 ? 3 : g.lat >= 27 ? 4 : 5;
      if (terrain === 'mountain' && ci > 0) ci--;
      const adj = [...new Set(nb[c].map((q) => cellProv[q]))].sort((a, b) => a - b);
      const coastal = nb[c].some((q) => !land[q]);
      provinces.push({ id: cellProv[c], name: name(r), sea: false, iso: 'GEN', x, y, lon: g.lon, lat: g.lat, area: km2(areaPx(pts)), terrain, climate: CLIMATES[ci], coastal, port: coastal && R.int(r, 1000) < 350, adj, river: [] });
      cells.push([pts]);
    }
    const straits = [];
    isleCells.forEach((mine, i) => {
      const first = provinces[cellProv[mine[0]]];
      first.port = true;
      if (i % 2) return;
      for (const a of mine) {
        for (const sc of nb[a]) {
          if (land[sc]) continue;
          const b = nb[sc].find((q) => land[q] && isle[q] < 0);
          if (b === undefined) continue;
          const pa = provinces[cellProv[a]];
          const pb = provinces[cellProv[b]];
          pa.adj = [...pa.adj, pb.id].sort((x, y) => x - y);
          pb.adj = [...pb.adj, pa.id].sort((x, y) => x - y);
          straits.push([Math.min(pa.id, pb.id), Math.max(pa.id, pb.id)]);
          return;
        }
      }
    });
    zones.forEach((zc, i) => {
      const polys = zc.map(poly);
      const [x, y] = centre(polys[Math.floor(polys.length / 2)]);
      const g = geo(x, y);
      const adj = new Set();
      for (const c of zc) for (const q of nb[c]) if (cellProv[q] !== N + i + 1) adj.add(cellProv[q]);
      provinces.push({ id: N + i + 1, name: `Sea Zone ${i + 1}`, sea: true, x, y, lon: g.lon, lat: g.lat, area: km2(polys.reduce((s, p) => s + areaPx(p), 0)), adj: [...adj].sort((a, b) => a - b) });
      cells.push(polys);
    });

    const riverCount = Math.max(1, Math.floor(N / 50));
    const edges = new Set();
    const addRiver = (a, b) => {
      const pa = provinces[cellProv[a]];
      const pb = provinces[cellProv[b]];
      if (!pa.river.includes(pb.id)) { pa.river.push(pb.id); pa.river.sort((x, y) => x - y); }
      if (!pb.river.includes(pa.id)) { pb.river.push(pa.id); pb.river.sort((x, y) => x - y); }
    };
    for (let k = 0; k < riverCount; k++) {
      let a = landCells[R.int(r, landCells.length)];
      const ln = nb[a].filter((q) => land[q]);
      if (!ln.length) continue;
      let b = ln[R.int(r, ln.length)];
      let from = -1;
      for (let len = 0; len < 16; len++) {
        const ek = Math.min(a, b) * C + Math.max(a, b);
        if (edges.has(ek)) break;
        edges.add(ek);
        addRiver(a, b);
        const common = nb[a].filter((q) => q !== from && nb[b].includes(q));
        if (!common.length) break;
        const x = common.length > 1 && elev[common[1]] < elev[common[0]] ? common[1] : common[0];
        if (!land[x]) break;
        if (elev[a] <= elev[b]) { from = b; b = x; } else { from = a; a = x; }
      }
    }

    const landAdj = (p) => provinces[p].adj.filter((q) => q <= N);
    const bfs = (sources, allowed) => {
      const dist = new Int32Array(N + 1).fill(-1);
      const queue = [];
      for (const s of sources) { dist[s] = 0; queue.push(s); }
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i];
        for (const q of landAdj(p)) if (dist[q] < 0 && (!allowed || allowed(q))) { dist[q] = dist[p] + 1; queue.push(q); }
      }
      return dist;
    };
    const mainland = landCells.filter((c) => isle[c] < 0).map((c) => cellProv[c]);
    const capitals = [mainland[R.int(r, mainland.length)]];
    const minDist = bfs([capitals[0]]);
    while (capitals.length < K) {
      let best = 1;
      for (let p = 1; p <= N; p++) if (minDist[p] > minDist[best]) best = p;
      capitals.push(best);
      const d = bfs([best]);
      for (let p = 1; p <= N; p++) if (d[p] >= 0 && d[p] < minDist[p]) minDist[p] = d[p];
    }
    const owner = new Int32Array(N + 1).fill(-1);
    {
      const queues = capitals.map((p) => [p]);
      const heads = capitals.map(() => 0);
      const grown = capitals.map(() => 0);
      for (;;) {
        let a = -1;
        for (let i = 0; i < K; i++) if (heads[i] < queues[i].length && (a < 0 || grown[i] < grown[a])) a = i;
        if (a < 0) break;
        const p = queues[a][heads[a]++];
        if (owner[p] >= 0) continue;
        owner[p] = a;
        grown[a]++;
        for (const q of landAdj(p)) if (owner[q] < 0) queues[a].push(q);
      }
    }
    isleCells.forEach((mine, i) => { for (const c of mine) if (owner[cellProv[c]] < 0) owner[cellProv[c]] = i % K; });

    const tags = capitals.map((_, i) => `N${String(i + 1).padStart(2, '0')}`);
    const size = capitals.map(() => 0);
    for (let p = 1; p <= N; p++) size[owner[p]]++;
    const order = size.map((s, i) => i).sort((a, b) => size[b] - size[a] || a - b);
    const majors = new Set(order.slice(0, Math.max(1, Math.ceil(K * 0.3))));
    const scProv = {};
    const milSum = capitals.map(() => 0);
    capitals.forEach((cap, i) => {
      const dist = bfs([cap], (q) => owner[q] === i);
      for (let p = 1; p <= N; p++) {
        if (owner[p] !== i) continue;
        const pr = provinces[p];
        const c = landCells[p - 1];
        const row = Math.floor(c / cols);
        const col = c % cols;
        const isCap = p === cap;
        const e = {
          mil: isCap ? 4 + R.int(r, 3) : R.int(r, 1000) < 120 ? 1 + R.int(r, 2) : 0,
          civ: isCap ? 6 : R.int(r, 1000) < 200 ? 1 + R.int(r, 3) : 0,
          infra: isCap ? 6 : Math.max(1, 5 - Math.floor(Math.max(0, dist[p]) / 4)) + R.int(r, 2),
          hub: !isCap && row % 6 === 3 && col % 6 === 3,
          coal: R.int(r, 1000) < 150 ? 1 + R.int(r, 3) : 0,
          iron: R.int(r, 1000) < 120 ? 1 + R.int(r, 3) : 0,
          oil: R.int(r, 1000) < 40 ? 1 + R.int(r, 2) : 0,
        };
        if (isCap) { pr.terrain = 'urban'; pr.port = pr.coastal; }
        milSum[i] += e.mil;
        if (e.mil || e.civ || e.infra !== 2 || e.hub || e.coal || e.iron || e.oil) scProv[p] = e;
      }
    });

    const total = opts.divisions !== undefined ? Math.max(0, opts.divisions | 0) : Math.max(2 * K, Math.round(N * 0.3));
    const share = size.map((s) => Math.floor((total * s) / N));
    const rest = size.map((s, i) => i).sort((a, b) => ((total * size[b]) % N) - ((total * size[a]) % N) || a - b);
    for (let i = 0; share.reduce((x, y) => x + y, 0) < total; i++) share[rest[i % K]]++;

    const nations = [];
    const armies = [];
    capitals.forEach((cap, i) => {
      const nname = name(r);
      const generals = [0, 1, 2].map(() => ({ name: `General ${name(r)}`, trait: TRAITS[R.int(r, TRAITS.length)] }));
      const mil = milSum[i];
      const lines = [{ item: 'rifles', factories: Math.floor(mil * 0.45) }, { item: 'guns', factories: Math.floor(mil * 0.2) }, { item: 'mgs', factories: Math.floor(mil * 0.15) }, { item: 'shells', factories: Math.floor(mil * 0.1) }, { item: 'horses', factories: Math.floor(mil * 0.05) }];
      nations.push({
        tag: tags[i], name: nname, color: color(i), capital: cap, bloc: null, major: majors.has(i), manpower: size[i] * 4000,
        navy: majors.has(i) ? 80 + R.int(r, 41) : R.int(r, 31),
        personality: { boldness: R.int(r, 101), caution: R.int(r, 101), loyalty: R.int(r, 101), revanchism: R.int(r, 101) },
        goals: [], generals,
        templates: [
          { id: 'inf14', name: 'Infantry Division', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art', 'mg', 'mg'], support: ['eng', 'cav'] },
          { id: 'cav14', name: 'Cavalry Division', line: ['cav', 'cav', 'cav', 'cav', 'cav', 'cav', 'art', 'mg'], support: [] },
        ],
        lines,
      });
      const border = [];
      for (let p = 1; p <= N; p++) if (owner[p] === i && landAdj(p).some((q) => owner[q] !== i)) border.push(p);
      const at = border.length ? border : [cap];
      const nArmies = Math.ceil(share[i] / 24);
      for (let j = 0; j < nArmies; j++) {
        const lo = Math.floor((j * at.length) / nArmies);
        const hi = Math.max(lo + 1, Math.floor(((j + 1) * at.length) / nArmies));
        const divisions = Math.floor(share[i] / nArmies) + (j < share[i] % nArmies ? 1 : 0);
        armies.push({ nation: tags[i], name: `${nname} Army ${j + 1}`, general: generals[j % generals.length].name, template: 'inf14', divisions, at: at.slice(lo, hi) });
      }
    });

    isleCells.forEach((mine, i) => {
      const p = cellProv[mine[0]];
      armies.push({ nation: tags[owner[p]], name: `${nations[owner[p]].name} Garrison ${i + 1}`, general: null, template: 'inf14', divisions: 1, at: [p] });
    });

    const ownerLists = {};
    tags.forEach((t) => { ownerLists[t] = []; });
    for (let p = 1; p <= N; p++) ownerLists[tags[owner[p]]].push(p);

    const map = {
      v: 1, id: `gen-${seed}`, name: `Generated ${seed}`,
      texture: { file: null, width, height },
      projection: { type: 'equirect', lon0, lat0, pxPerDeg: PX_PER_DEG },
      provinces, cells, straits,
    };
    const scenario = {
      v: 1, id: `gen-${seed}`, map: map.id, name: `Generated world ${seed}`, start: '1914-06-28', end: '1920-01-01',
      nations, owner: ownerLists, cores: {}, provinces: scProv, armies, alliances: [], wars: [], events: [],
    };
    return { map, scenario };
  }

  return { generate };
});
