// Builds Nano Studio Conquest's world map and 1914 scenario (docs/conquest-architecture.md sections 3 and 4) from
// three Natural Earth files and the hand-made tables in tools/conquest-data/:
//   renderer/features/conquest/data/world-1914/map.json, ids.png, scenario.json
// Usage: node tools/build-conquest-maps.mjs --src verify/out/downloads-cache/natural-earth [--out dir] [--preview file.png]
//   (--preview writes the world at a quarter of the texture's size, coloured by 1914 owner with province borders)
// The same sources and tables give the same bytes. Development only; not shipped.
//
// Provinces start as Natural Earth admin-1 units (admin-0 where a country has none), cut where a 1914 border ran
// through one (owners-1914.json `cuts`), with units too small to click merged into a neighbour of the same modern
// country and 1914 owner. theatres.json then sets a target size by theatre: in the war theatres small units join a
// neighbour of the same owner, and every unit over 1.5 times its target is cut on its own pixels into compact parts
// (balanced k-means with fixed seeds and steps, kept connected). A part is named for the first-ranked place of
// places.json in it, else for its unit and a wind; tables that name a city resolve to the part holding it, and a
// region selector to every part of its unit. Sea zones, straits and passages come from seas.json.
//
// Terrain and climate are hand-made: terrain.json draws mountain ranges, hills, deserts, marshes and forests as
// lon/lat shapes, and climate comes from latitude bands with shape overrides. A raster pass (relief and land cover,
// plan section 4.2) would replace the `terrainRaster` fill below with per-pixel classes; the per-province majority
// vote after it stays as it is.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(HERE, 'conquest-data');
const W = 8192, H = 4096, PPD = W / 360, N = W * H;
const MIN_PX = 6;            // a unit under this many pixels is merged into a neighbour
const MIN_EDGE = 2;           // pixel edges two provinces must share to be neighbours
const FRAGMENT_PX = 64;       // a cut-off sliver of a province up to this many pixels joins its own nation's land around it
const URBAN_KM2 = 4000;       // a great city makes its province urban terrain up to this size
const SOUTH_ROW = Math.round((90 + 66) * PPD);   // open water is left empty from here south (Antarctica is left out)
const TERRAINS = ['plains', 'forest', 'hills', 'mountain', 'marsh', 'desert', 'urban'];

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const SRC = path.resolve(arg('--src', path.join(ROOT, 'verify/out/downloads-cache/natural-earth')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'renderer/features/conquest/data/world-1914')));
const PREVIEW = arg('--preview', null);
const log = (...a) => { if (!process.argv.includes('--quiet')) console.log(...a); };
const fail = (msg) => { console.error(`build-conquest-maps: ${msg}`); process.exit(1); };

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const owners = readJson(path.join(DATA, 'owners-1914.json'));
const seas = readJson(path.join(DATA, 'seas.json'));
const terrainTable = readJson(path.join(DATA, 'terrain.json'));
const places = readJson(path.join(DATA, 'places.json'));
const economy = readJson(path.join(DATA, 'economy.json'));
const theatres = readJson(path.join(DATA, 'theatres.json'));
const world = (await import(pathToFileURL(path.join(DATA, 'nations-1914.mjs')).href)).default;


const px = (lon) => (lon + 180) * PPD;
const py = (lat) => (90 - lat) * PPD;
const lonOf = (x) => (x + 0.5) / PPD - 180;
const latOf = (y) => 90 - (y + 0.5) / PPD;
const round2 = (v) => Math.round(v * 100) / 100;

function geometryRings(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.flat();
}

function shapeRings(s) {
  if (s.poly) return [s.poly];
  if (s.box) { const [a, b, c, d] = s.box; return [[[a, b], [c, b], [c, d], [a, d]]]; }
  if (s.ellipse) {
    const [lon, lat, rx, ry, rot = 0] = s.ellipse, t = rot * Math.PI / 180, ring = [];
    for (let k = 0; k < 32; k++) {
      const a = 2 * Math.PI * k / 32, ex = rx * Math.cos(a), ey = ry * Math.sin(a);
      ring.push([lon + ex * Math.cos(t) - ey * Math.sin(t), lat + ex * Math.sin(t) + ey * Math.cos(t)]);
    }
    return [ring];
  }
  fail(`shape without poly, box or ellipse: ${JSON.stringify(s).slice(0, 80)}`);
}

// Even-odd scanline fill at pixel centres; holes and multipolygon parts are just more rings.
function fillRings(rings, span) {
  let y0 = Infinity, y1 = -Infinity;
  const edges = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const ya = py(a[1]), yb = py(b[1]);
      if (ya === yb) continue;
      const xa = px(a[0]), xb = px(b[0]);
      const lo = Math.max(0, Math.ceil(Math.min(ya, yb) - 0.5)), hi = Math.min(H - 1, Math.ceil(Math.max(ya, yb) - 0.5) - 1);
      if (lo > hi) continue;
      edges.push(lo, hi, xa, ya, (xb - xa) / (yb - ya));
      if (lo < y0) y0 = lo;
      if (hi > y1) y1 = hi;
    }
  }
  if (y0 > y1) return;
  const rows = Array.from({ length: y1 - y0 + 1 }, () => []);
  for (let e = 0; e < edges.length; e += 5) {
    const lo = edges[e], hi = edges[e + 1], xa = edges[e + 2], ya = edges[e + 3], k = edges[e + 4];
    for (let y = lo; y <= hi; y++) rows[y - y0].push(xa + (y + 0.5 - ya) * k);
  }
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r];
    if (c.length < 2) continue;
    c.sort((a, b) => a - b);
    for (let k = 0; k + 1 < c.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(c[k] - 0.5)), x1 = Math.min(W - 1, Math.ceil(c[k + 1] - 0.5) - 1);
      if (x0 <= x1) span(y0 + r, x0, x1);
    }
  }
}

function insideRings(rings, lon, lat) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const pixelAt = (lon, lat) => {
  const x = Math.min(W - 1, Math.max(0, Math.floor(px(lon)))), y = Math.min(H - 1, Math.max(0, Math.floor(py(lat))));
  return y * W + x;
};
const left = (i) => (i % W === 0 ? i + W - 1 : i - 1);
const right = (i) => (i % W === W - 1 ? i - W + 1 : i + 1);


log('reading Natural Earth');
const a1 = readJson(path.join(SRC, 'ne_10m_admin_1_states_provinces.geojson'));
const a0 = readJson(path.join(SRC, 'ne_10m_admin_0_countries.geojson'));
const riversSrc = readJson(path.join(SRC, 'ne_50m_rivers_lake_centerlines.geojson'));

const drop = new Set(owners.drop);
const units = [null];   // index = unit id in the unit raster
for (const f of a1.features) {
  const p = f.properties;
  if (drop.has(p.adm0_a3)) continue;
  units.push({ id: units.length, iso: p.adm0_a3, name: p.name || p.name_en || p.adm1_code, lon: p.longitude, lat: p.latitude, rings: geometryRings(f.geometry) });
}
const isoWithA1 = new Set(units.slice(1).map((u) => u.iso));
for (const f of a0.features) {
  const p = f.properties;
  if (drop.has(p.ADM0_A3) || isoWithA1.has(p.ADM0_A3)) continue;
  units.push({ id: units.length, iso: p.ADM0_A3, name: p.NAME, lon: p.LABEL_X, lat: p.LABEL_Y, rings: geometryRings(f.geometry) });
}

const isoOwner = new Map();
for (const [tag, isos] of Object.entries(owners.countries)) {
  for (const iso of isos) {
    if (isoOwner.has(iso)) fail(`${iso} is listed under ${isoOwner.get(iso)} and ${tag}`);
    isoOwner.set(iso, tag);
  }
}
const unitByName = (iso, name) => {
  const found = units.filter((u) => u && u.iso === iso && u.name === name);
  if (!found.length) fail(`no admin-1 unit "${name}" in ${iso}`);
  return found;
};
for (const u of units.slice(1)) {
  if (!isoOwner.has(u.iso)) fail(`country ${u.iso} (${u.name}) has no 1914 owner in owners-1914.json`);
  u.owner = isoOwner.get(u.iso);
}
for (const [iso, byOwner] of Object.entries(owners.provinces)) {
  for (const [tag, names] of Object.entries(byOwner)) for (const name of names) for (const u of unitByName(iso, name)) u.owner = tag;
}

log(`rasterising ${units.length - 1} units`);
const uras = new Uint16Array(N);
for (const u of units.slice(1)) fillRings(u.rings, (y, x0, x1) => uras.fill(u.id, y * W + x0, y * W + x1 + 1));

for (const c of owners.cuts) {
  const [base] = unitByName(c.iso, c.name);
  const nu = { id: units.length, iso: c.iso, name: c.as, owner: c.owner, cut: c.as, rings: [] };
  let n = 0, sx = 0, sy = 0;
  fillRings([c.poly], (y, x0, x1) => {
    for (let i = y * W + x0, e = y * W + x1; i <= e; i++) if (uras[i] === base.id) { uras[i] = nu.id; n++; sx += i % W; sy += y; }
  });
  if (!n) fail(`cut ${c.as} takes no pixels from ${c.iso} ${c.name}`);
  nu.lon = round2(lonOf(sx / n)); nu.lat = round2(latOf(sy / n));
  units.push(nu);
}

const unitPx = new Int32Array(units.length);
for (let i = 0; i < N; i++) unitPx[uras[i]]++;
for (const u of units.slice(1)) {
  if (unitPx[u.id] || u.lon == null) continue;
  const i = pixelAt(u.lon, u.lat);
  if (uras[i] === 0) { uras[i] = u.id; unitPx[u.id] = 1; }
}


log('assigning sea zones');
const zones = seas.zones;
if (zones.length > 254) fail('more than 254 sea zones');
const zoneIndex = new Map(zones.map((z, k) => [z.name, k + 1]));
const sea = new Uint8Array(N);
const isWater = (i) => uras[i] === 0 && i < SOUTH_ROW * W;
zones.forEach((z, k) => {
  if (z.seed) return;
  for (const r of shapeRings(z)) fillRings([r], (y, x0, x1) => {
    for (let i = y * W + x0, e = y * W + x1; i <= e; i++) if (sea[i] === 0 && isWater(i)) sea[i] = k + 1;
  });
});
const queue = new Int32Array(N);
function flood(start, count, canEnter, take) {
  let head = start, tail = count;
  const visit = (j, i) => { if (canEnter(j)) { take(j, i); queue[tail++] = j; } };
  while (head < tail) {
    const i = queue[head++];
    visit(left(i), i); visit(right(i), i);
    if (i >= W) visit(i - W, i);
    if (i + W < N) visit(i + W, i);
  }
  return tail;
}
let qn = 0;
zones.forEach((z, k) => {
  if (!z.seed) return;
  const i = pixelAt(z.seed[0], z.seed[1]);
  if (!isWater(i) || sea[i]) fail(`seed of ${z.name} is not unassigned open water`);
  sea[i] = k + 1; queue[qn++] = i;
});
flood(0, qn, (j) => sea[j] === 0 && isWater(j), (j, i) => { sea[j] = sea[i]; });
qn = 0;
for (let i = 0; i < N; i++) if (sea[i]) queue[qn++] = i;
flood(0, qn, (j) => sea[j] === 0 && isWater(j), (j, i) => { sea[j] = sea[i]; });

// Water no zone reaches (and stray fragments of a zone cut off from its main body) joins the land around it.
const comp = new Int32Array(N);
function components(member) {
  comp.fill(0);
  const list = [];
  for (let s = 0; s < N; s++) {
    if (comp[s] || !member(s)) continue;
    const id = list.length + 1, key = member(s);
    comp[s] = id; queue[0] = s;
    const end = flood(0, 1, (j) => !comp[j] && member(j) === key, (j) => { comp[j] = id; });
    list.push({ id, key, start: s, size: end });
  }
  return list;
}
function pixelsOf(c) {
  queue[0] = c.start;
  comp[c.start] = -c.id;
  const end = flood(0, 1, (j) => comp[j] === c.id, (j) => { comp[j] = -c.id; });
  return Array.from(queue.subarray(0, end));
}
function bestNeighbour(pix, valueOf) {
  const count = new Map();
  for (const i of pix) {
    const y = (i / W) | 0;
    for (const j of [left(i), right(i), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j < 0) continue;
      const v = valueOf(j);
      if (v) count.set(v, (count.get(v) || 0) + 1);
    }
  }
  let best = 0, bestN = 0;
  for (const [v, n] of [...count].sort((a, b) => a[0] - b[0])) if (n > bestN) { best = v; bestN = n; }
  return best;
}
{
  const strays = components((i) => (isWater(i) && !sea[i] ? 1 : 0));
  for (const c of strays) {
    const pix = pixelsOf(c);
    const land = bestNeighbour(pix, (j) => uras[j]);
    if (land) for (const i of pix) { uras[i] = land; unitPx[land]++; }
  }
  const parts = components((i) => sea[i]);
  const biggest = new Map();
  for (const c of parts) if (!biggest.has(c.key) || biggest.get(c.key).size < c.size) biggest.set(c.key, c);
  for (const c of parts) {
    if (biggest.get(c.key) === c) continue;
    const pix = pixelsOf(c);
    const other = bestNeighbour(pix, (j) => (sea[j] && sea[j] !== c.key ? sea[j] : 0));
    if (other) for (const i of pix) sea[i] = other;
    else {
      const land = bestNeighbour(pix, (j) => uras[j]);
      for (const i of pix) { sea[i] = 0; if (land) { uras[i] = land; unitPx[land]++; } }
    }
  }
  const zonePx = new Int32Array(zones.length + 1);
  for (let i = 0; i < N; i++) zonePx[sea[i]]++;
  zones.forEach((z, k) => { if (!zonePx[k + 1]) fail(`sea zone ${z.name} has no water`); });
}


log('merging small units');
const alive = units.map((u) => !!u && unitPx[u.id] > 0);
const size = Float64Array.from(unitPx);
const sumX = new Float64Array(units.length), sumY = new Float64Array(units.length);
for (let i = 0; i < N; i++) { const u = uras[i]; if (u) { sumX[u] += i % W; sumY[u] += (i / W) | 0; } }
const nbrs = units.map(() => new Map());
for (let i = 0; i < N; i++) {
  const a = uras[i];
  if (!a) continue;
  for (const j of [right(i), i + W < N ? i + W : -1]) {
    if (j < 0) continue;
    const b = uras[j];
    if (b && b !== a) { nbrs[a].set(b, (nbrs[a].get(b) || 0) + 1); nbrs[b].set(a, (nbrs[b].get(a) || 0) + 1); }
  }
}
const members = units.map((u) => (u ? [u.id] : []));
const keyOf = (id) => `${units[id].iso}|${units[id].owner}`;
const isoTotal = new Map();
for (const u of units.slice(1)) isoTotal.set(u.iso, (isoTotal.get(u.iso) || 0) + unitPx[u.id]);
const kept = new Set();
function mergeTarget(r) {
  let best = 0, bestN = 0;
  for (const [v, n] of nbrs[r]) if (keyOf(v) === keyOf(r) && (n > bestN || (n === bestN && v < best))) { best = v; bestN = n; }
  if (best) return best;
  if (isoTotal.get(units[r].iso) < MIN_PX) {
    for (const [v, n] of nbrs[r]) if (n > bestN || (n === bestN && v < best)) { best = v; bestN = n; }
    if (best) return best;
  }
  const cx = sumX[r] / size[r], cy = sumY[r] / size[r];
  let bestD = 600 * 600;
  for (let v = 1; v < units.length; v++) {
    if (!alive[v] || v === r || keyOf(v) !== keyOf(r)) continue;
    let dx = Math.abs(sumX[v] / size[v] - cx); dx = Math.min(dx, W - dx);
    const d = dx * dx + (sumY[v] / size[v] - cy) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}
for (;;) {
  let r = 0;
  for (let v = 1; v < units.length; v++) if (alive[v] && !kept.has(v) && size[v] < MIN_PX && (!r || size[v] < size[r])) r = v;
  if (!r) break;
  const t = mergeTarget(r);
  if (!t) { kept.add(r); continue; }
  alive[r] = false;
  size[t] += size[r]; sumX[t] += sumX[r]; sumY[t] += sumY[r];
  members[t].push(...members[r]);
  for (const [w, n] of nbrs[r]) {
    nbrs[w].delete(r);
    if (w === t) continue;
    nbrs[t].set(w, (nbrs[t].get(w) || 0) + n);
    nbrs[w].set(t, (nbrs[w].get(t) || 0) + n);
  }
  nbrs[r].clear();
}

log('subdividing by theatre');
const terrainRaster = new Uint8Array(N);
for (let k = terrainTable.terrain.length - 1; k >= 0; k--) {
  const t = terrainTable.terrain[k], cls = TERRAINS.indexOf(t.t);
  if (cls < 1 || cls > 5) fail(`terrain class ${t.t} of ${t.name}`);
  for (const r of shapeRings(t)) fillRings([r], (y, x0, x1) => terrainRaster.fill(cls, y * W + x0, y * W + x1 + 1));
}
const DESERT = TERRAINS.indexOf('desert');
const km2Row = Float64Array.from({ length: H }, (_, y) => (111.32 / PPD) ** 2 * Math.cos(latOf(y) * Math.PI / 180));
const nb4 = (i, k) => (k === 0 ? left(i) : k === 1 ? right(i) : k === 2 ? (i >= W ? i - W : -1) : i + W < N ? i + W : -1);
const unwrap = (x, x0) => { const d = x - x0; return d > W / 2 ? d - W : d < -W / 2 ? d + W : d; };
const inBox = (b, lon, lat) => lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3];
const theatreOf = (iso, lon, lat, coastal, desert) => theatres.theatres.find((t) => (!t.iso || t.iso.includes(iso)) && (!t.box || inBox(t.box, lon, lat))
  && (t.coastal === undefined || t.coastal === coastal) && (t.desert === undefined || t.desert === desert)) || theatres.default;
const lead = (list) => list.reduce((a, b) => (unitPx[b] > unitPx[a] ? b : a));

const roots = [];
for (let v = 1; v < units.length; v++) if (alive[v]) roots.push(v);
const R = roots.length;
const rootOfUnit = new Int32Array(units.length);
roots.forEach((r, k) => { for (const m of members[r]) rootOfUnit[m] = k + 1; });
// pid holds a root index (positive) until a pixel is given its part, then minus the part id, then the part id.
const pid = new Int32Array(N);
for (let i = 0; i < N; i++) if (uras[i]) pid[i] = rootOfUnit[uras[i]];

// Rasterised admin-1 outlines leave slivers of a province cut off inside its neighbours; a piece other than the
// province's largest, up to FRAGMENT_PX and touching land of the same 1914 owner, joins the province of that owner
// it borders most (an enclave inside another nation stays). Run on the units here and on the provinces at the end;
// a second pass catches slivers whose only such neighbour was another sliver.
function joinSlivers(arr, max, ownerOf) {
  for (let pass = 0; pass < 2; pass++) {
    comp.fill(0);
    const largest = new Int32Array(max + 1), small = [];
    for (let s = 0; s < N; s++) {
      const v = arr[s];
      if (!v || v > max || comp[s]) continue;
      comp[s] = 1; queue[0] = s;
      let h = 0, t = 1, touches = false;
      while (h < t) {
        const i = queue[h++];
        for (let k = 0; k < 4; k++) {
          const j = nb4(i, k);
          if (j < 0) continue;
          const u = arr[j];
          if (u === v) { if (!comp[j]) { comp[j] = 1; queue[t++] = j; } } else if (u && u <= max && ownerOf(u) === ownerOf(v)) touches = true;
        }
      }
      if (t > largest[v]) largest[v] = t;
      if (t <= FRAGMENT_PX && touches) small.push({ v, cells: queue.slice(0, t) });
    }
    for (const c of small) {
      if (c.cells.length === largest[c.v]) continue;
      const cnt = new Map();
      for (const i of c.cells) for (let k = 0; k < 4; k++) { const j = nb4(i, k), u = j < 0 ? 0 : arr[j]; if (u && u <= max && u !== c.v && ownerOf(u) === ownerOf(c.v)) cnt.set(u, (cnt.get(u) || 0) + 1); }
      let best = 0, bestN = 0;
      for (const [u, n] of cnt) if (n > bestN || (n === bestN && u < best)) { best = u; bestN = n; }
      if (best) for (const i of c.cells) arr[i] = best;
    }
  }
}
joinSlivers(pid, R, (r) => units[roots[r - 1]].owner);

const grp = [null];
{
  const first = new Int32Array(R + 1).fill(-1), area = new Float64Array(R + 1), sdx = new Float64Array(R + 1), sy = new Float64Array(R + 1), coast = new Uint8Array(R + 1), dry = new Float64Array(R + 1);
  for (let i = 0; i < N; i++) {
    const r = pid[i];
    if (!r) continue;
    const y = (i / W) | 0, a = km2Row[y];
    if (first[r] < 0) first[r] = i;
    area[r] += a; sdx[r] += unwrap(i % W, first[r] % W) * a; sy[r] += y * a;
    if (terrainRaster[i] === DESERT) dry[r] += a;
    if (!coast[r]) for (let k = 0; k < 4; k++) { const j = nb4(i, k); if (j >= 0 && sea[j] && !uras[j]) coast[r] = 1; }
  }
  for (let r = 1; r <= R; r++) {
    const u = units[roots[r - 1]];
    const lon = lonOf((((first[r] % W) + sdx[r] / area[r]) % W + W) % W), lat = latOf(sy[r] / area[r]);
    grp.push({ roots: [r], area: area[r], owner: u.owner, iso: u.iso, theatre: theatreOf(u.iso, lon, lat, !!coast[r], dry[r] > area[r] / 2), nb: new Map() });
  }
  for (let i = 0; i < N; i++) {
    const a = pid[i];
    if (!a) continue;
    for (let k = 1; k < 4; k += 2) {
      const j = nb4(i, k), b = j < 0 ? 0 : pid[j];
      if (b && b !== a) { grp[a].nb.set(b, (grp[a].nb.get(b) || 0) + 1); grp[b].nb.set(a, (grp[b].nb.get(a) || 0) + 1); }
    }
  }
}
const isFine = (g) => g.theatre.tier === 'fine';
for (;;) {
  let pick = 0;
  for (let r = 1; r <= R; r++) {
    const g = grp[r];
    if (g && !g.stuck && isFine(g) && (g.area < theatres.aggregate * g.theatre.target || g.area < theatres.minimum) && (!pick || g.area < grp[pick].area)) pick = r;
  }
  if (!pick) break;
  const g = grp[pick];
  let best = 0, bestN = 0;
  for (const [h, n] of g.nb) {
    const o = grp[h];
    if (o.owner === g.owner && isFine(o) && (g.area < theatres.minimum || (o.iso === g.iso && g.area + o.area <= 1.2 * o.theatre.target)) && (n > bestN || (n === bestN && h < best))) { best = h; bestN = n; }
  }
  if (!best) { g.stuck = true; continue; }
  const t = grp[best];
  t.roots.push(...g.roots); t.area += g.area; t.stuck = false;
  for (const [w, n] of g.nb) {
    grp[w].nb.delete(pick);
    if (w === best) continue;
    t.nb.set(w, (t.nb.get(w) || 0) + n);
    grp[w].nb.set(best, (grp[w].nb.get(best) || 0) + n);
  }
  grp[pick] = null;
}
const groups = grp.filter(Boolean);
const rootGroup = new Int32Array(R + 1);
groups.forEach((g, k) => { g.roots.sort((a, b) => a - b); for (const r of g.roots) rootGroup[r] = k; g.units = g.roots.flatMap((r) => members[roots[r - 1]]); g.lead = units[lead(g.units)]; });
const gStart = new Int32Array(groups.length + 1);
for (let i = 0; i < N; i++) if (pid[i]) gStart[rootGroup[pid[i]] + 1]++;
for (let k = 0; k < groups.length; k++) gStart[k + 1] += gStart[k];
const gPix = new Int32Array(gStart[groups.length]);
{
  const fill = gStart.slice(0, groups.length);
  for (let i = 0; i < N; i++) if (pid[i]) gPix[fill[rootGroup[pid[i]]]++] = i;
}

function hash2(ix, iy, s) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1;
}
function noise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Balanced k-means on a warped copy of the pixels: farthest-point seeds, a fixed number of Lloyd steps whose
// per-seed bias evens out the parts' km2, then every pixel to its nearest biased seed. The warp bends the
// straight Voronoi edges into borders that wander like drawn ones.
function splitPixels(pix, k, salt) {
  const n = pix.length, x0 = pix[0] % W;
  let syy = 0;
  for (let j = 0; j < n; j++) syy += (pix[j] / W) | 0;
  const cosl = Math.max(0.15, Math.cos(latOf(syy / n) * Math.PI / 180));
  const cell = Math.sqrt(n * cosl / k), L = cell * 0.55, A = cell * 0.22;
  const X = new Float64Array(n), Y = new Float64Array(n), M = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const i = pix[j], y = (i / W) | 0, ux = (x0 + unwrap(i % W, x0)) * cosl;
    const n1 = noise(ux / L, y / L, salt * 4) + 0.5 * noise(2 * ux / L, 2 * y / L, salt * 4 + 1);
    const n2 = noise(ux / L, y / L, salt * 4 + 2) + 0.5 * noise(2 * ux / L, 2 * y / L, salt * 4 + 3);
    X[j] = ux + A * n1; Y[j] = y + A * n2; M[j] = km2Row[y];
  }
  const m = Math.max(1, Math.ceil(n / 40000)), S = [];
  for (let j = 0; j < n; j += m) S.push(j);
  let tw = 0, tx = 0, ty = 0;
  for (const j of S) { tw += M[j]; tx += X[j] * M[j]; ty += Y[j] * M[j]; }
  const cx = new Float64Array(k), cy = new Float64Array(k), bias = new Float64Array(k);
  const minD = new Float64Array(S.length);
  let far = 0;
  for (let s = 0; s < S.length; s++) { const j = S[s], d = (X[j] - tx / tw) ** 2 + (Y[j] - ty / tw) ** 2; if (d > minD[far]) far = s; minD[s] = d; }
  for (let c = 0; c < k; c++) {
    const j = S[far];
    cx[c] = X[j]; cy[c] = Y[j];
    let next = 0;
    for (let s = 0; s < S.length; s++) {
      const jj = S[s], d = (X[jj] - cx[c]) ** 2 + (Y[jj] - cy[c]) ** 2;
      if (c === 0 || d < minD[s]) minD[s] = d;
      if (minD[s] > minD[next]) next = s;
    }
    far = next;
  }
  const nearest = (j) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) { const d = (X[j] - cx[c]) ** 2 + (Y[j] - cy[c]) ** 2 - bias[c]; if (d < bd) { bd = d; best = c; } }
    return best;
  };
  const goal = tw / k, scale = cell * cell, sw = new Float64Array(k), sx = new Float64Array(k), sy = new Float64Array(k);
  for (let it = 0; it < 40; it++) {
    sw.fill(0); sx.fill(0); sy.fill(0);
    for (const j of S) { const c = nearest(j); sw[c] += M[j]; sx[c] += X[j] * M[j]; sy[c] += Y[j] * M[j]; }
    for (let c = 0; c < k; c++) {
      if (sw[c] > 0) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; }
      bias[c] += 0.3 * scale * (goal - sw[c]) / goal;
    }
  }
  const label = new Int32Array(n);
  for (let j = 0; j < n; j++) label[j] = nearest(j);
  return label;
}

// Inside one province: a part's pieces other than its largest join the part they share most border with (a
// piece that touches no other part is an island and stays), then parts under 40% of the mean join a neighbour.
function settleParts(pix, lo, hi) {
  const inG = (v) => v <= -lo && v > -hi;
  for (let pass = 0; pass < 6; pass++) {
    for (const i of pix) comp[i] = 0;
    const pieces = [];
    let cid = 0;
    for (const s of pix) {
      if (comp[s]) continue;
      const p = pid[s];
      comp[s] = ++cid; queue[0] = s;
      let h = 0, t = 1;
      while (h < t) {
        const i = queue[h++];
        for (let q = 0; q < 4; q++) { const j = nb4(i, q); if (j >= 0 && !comp[j] && pid[j] === p) { comp[j] = cid; queue[t++] = j; } }
      }
      pieces.push({ p, cells: queue.slice(0, t) });
    }
    const big = new Map();
    for (const c of pieces) if (!big.has(c.p) || big.get(c.p).cells.length < c.cells.length) big.set(c.p, c);
    let changed = false;
    for (const c of pieces) {
      if (big.get(c.p) === c) continue;
      const to = borderWinner(c.cells, c.p, inG);
      if (to) { for (const i of c.cells) pid[i] = to; changed = true; }
    }
    if (!changed) break;
  }
  const n = hi - lo, area = new Float64Array(n);
  for (const i of pix) area[-pid[i] - lo] += km2Row[(i / W) | 0];
  const mean = area.reduce((s, a) => s + a, 0) / n;
  for (;;) {
    let s = -1;
    for (let c = 0; c < n; c++) if (area[c] > 0 && (s < 0 || area[c] < area[s])) s = c;
    if (area[s] >= 0.4 * mean || area.filter((a) => a > 0).length < 2) break;
    const cells = Array.from(pix).filter((i) => pid[i] === -(lo + s));
    const to = borderWinner(cells, -(lo + s), inG);
    if (!to) { area[s] = Infinity; continue; }
    for (const i of cells) pid[i] = to;
    area[-to - lo] += area[s]; area[s] = 0;
  }
}
function borderWinner(cells, self, inG) {
  const cnt = new Map();
  for (const i of cells) for (let q = 0; q < 4; q++) { const j = nb4(i, q), v = j < 0 ? 0 : pid[j]; if (v !== self && inG(v)) cnt.set(v, (cnt.get(v) || 0) + 1); }
  let best = 0, bestN = 0;
  for (const [v, n] of cnt) if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
  return best;
}

// A part of a coarser theatre whose centre lies in a finer one is cut again to the finer target, and a part the
// balancing left over twice its target (seeds stranded on far islands) is cut again to its own.
let nextPart = 1;
function carve(pix, g, T, salt, depth = 0) {
  let area = 0;
  for (const i of pix) area += km2Row[(i / W) | 0];
  if (area <= 1.5 * T) { const id = nextPart++; for (const i of pix) pid[i] = -id; return; }
  const lo = nextPart, label = splitPixels(pix, Math.min(64, Math.round(area / T)), salt);
  nextPart += Math.min(64, Math.round(area / T));
  for (let j = 0; j < pix.length; j++) pid[pix[j]] = -(lo + label[j]);
  settleParts(pix, lo, nextPart);
  for (let p = lo, hi = nextPart; p < hi; p++) {
    const sub = Int32Array.from(Array.from(pix).filter((i) => pid[i] === -p));
    if (!sub.length) continue;
    let a = 0, dx = 0, sy = 0, dry = 0, coastal = false;
    const x0 = sub[0] % W;
    for (const i of sub) {
      const y = (i / W) | 0, w = km2Row[y];
      a += w; dx += unwrap(i % W, x0) * w; sy += y * w;
      if (terrainRaster[i] === DESERT) dry += w;
      if (!coastal) for (let k = 0; k < 4; k++) { const j = nb4(i, k); if (j >= 0 && sea[j] && !uras[j]) coastal = true; }
    }
    const t = theatreOf(g.iso, lonOf(((x0 + dx / a) % W + W) % W), latOf(sy / a), coastal, dry > a / 2);
    if (t.target < T && a > 1.5 * t.target) carve(sub, g, t.target, (salt * 31 + p) | 0, depth + 1);
    else if (a > 2 * T && depth < 3) carve(sub, g, T, (salt * 37 + p) | 0, depth + 1);
  }
}
groups.forEach((g, k) => { g.lo = nextPart; carve(gPix.subarray(gStart[k], gStart[k + 1]), g, g.theatre.target, k); g.hi = nextPart; });
for (let i = 0; i < N; i++) pid[i] = -pid[i];

const nParts = nextPart;
const pFirst = new Int32Array(nParts).fill(-1), pCount = new Int32Array(nParts), pDX = new Float64Array(nParts), pY = new Float64Array(nParts);
const partGroup = new Int32Array(nParts);
groups.forEach((g, k) => {
  const pix = gPix.subarray(gStart[k], gStart[k + 1]), x0 = pix[0] % W;
  g.x0 = x0; g.count = pix.length; g.dx = 0; g.y = 0;
  for (const i of pix) {
    const p = pid[i], dx = unwrap(i % W, x0), y = (i / W) | 0;
    if (pFirst[p] < 0) pFirst[p] = i;
    pCount[p]++; pDX[p] += dx; pY[p] += y; g.dx += dx; g.y += y;
    partGroup[p] = k;
  }
});
const groupParts = new Int32Array(groups.length);
for (let p = 1; p < nParts; p++) if (pCount[p]) groupParts[partGroup[p]]++;

function nearIn(arr, ok, lon, lat, what) {
  const x0 = Math.floor(px(lon)), y0 = Math.floor(py(lat));
  for (let r = 0; r <= 8; r++) {
    let best = 0, bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const y = y0 + dy, x = (x0 + dx + W) % W;
      if (y < 0 || y >= H) continue;
      const v = arr[y * W + x];
      if (ok(v) && dx * dx + dy * dy < bestD) { best = v; bestD = dx * dx + dy * dy; }
    }
    if (best) return best;
  }
  fail(`${what} at ${lon},${lat} is not on land`);
}
const cityRank = (name) => { const f = places.cities[name][2] || ''; return f.includes('u') ? 3 : f.includes('h') ? 2 : f.includes('p') ? 1 : 0; };
const partCity = new Map();
for (const name of Object.keys(places.cities)) {
  const [lon, lat] = places.cities[name], p = nearIn(pid, (v) => v > 0, lon, lat, `city ${name}`);
  if (!partCity.has(p) || cityRank(name) > cityRank(partCity.get(p))) partCity.set(p, name);
}
// Wind names counter-clockwise from east; the eight main ones first, the sixteen when those are taken.
const WINDS = ['East', 'East-North-East', 'North-East', 'North-North-East', 'North', 'North-North-West', 'North-West', 'West-North-West',
  'West', 'West-South-West', 'South-West', 'South-South-West', 'South', 'South-South-East', 'South-East', 'East-South-East'];
const angleGap = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };
const compass = (dx, dy) => WINDS[(((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8) * 2];
// A group's parts without a city take, farthest from the centre first, the free wind closest to their bearing;
// a part near the centre is Central, and one left without a free wind takes its main wind and a number.
function windNames(list, radius) {
  const used = new Set(), out = new Map();
  list.sort((a, b) => b.dist - a.dist || a.p - b.p);
  for (const c of list) {
    let name = c.dist < radius && !used.has('Central') ? 'Central' : null;
    for (const step of [2, 1]) {
      if (name) break;
      let best = null, gap = Infinity;
      for (let k = 0; k < 16; k += step) {
        const d = angleGap(Math.atan2(c.dy, c.dx), k * Math.PI / 8);
        if (!used.has(WINDS[k]) && d < gap && d <= (step === 2 ? 3 : 2) * Math.PI / 8) { best = WINDS[k]; gap = d; }
      }
      name = best;
    }
    if (name) used.add(name);
    if (!name) { const w = compass(c.dx, c.dy); let n = 2; while (used.has(`${w} ${n}`)) n++; name = `${w} ${n}`; used.add(name); }
    out.set(c.p, name);
  }
  return out;
}

const land = [];
const windOf = new Map();
groups.forEach((g, k) => {
  if (groupParts[k] < 2) return;
  const cosl = Math.max(0.15, Math.cos(latOf(g.y / g.count) * Math.PI / 180)), list = [];
  for (let p = g.lo; p < g.hi; p++) {
    if (!pCount[p] || partCity.has(p)) continue;
    const dx = (pDX[p] / pCount[p] - g.dx / g.count) * cosl, dy = g.y / g.count - pY[p] / pCount[p];
    list.push({ p, dx, dy, dist: Math.hypot(dx, dy) });
  }
  for (const [p, w] of windNames(list, 0.25 * Math.sqrt(g.count * cosl / Math.PI))) windOf.set(p, w);
});
for (let p = 1; p < nParts; p++) {
  if (!pCount[p]) continue;
  const g = groups[partGroup[p]], split = groupParts[partGroup[p]] > 1, merged = g.roots.length > 1;
  const cxPx = g.x0 + pDX[p] / pCount[p], cyPx = pY[p] / pCount[p];
  let name = g.lead.name;
  if ((split || merged) && partCity.has(p)) name = partCity.get(p);
  else if (split) name = `${g.lead.name} ${windOf.get(p)}`;
  land.push({ part: p, name, sea: false, iso: g.iso, owner: g.owner, units: g.units, group: partGroup[p], first: pFirst[p],
    clon: lonOf(((cxPx % W) + W) % W), clat: latOf(cyPx) });
}

// Names stay unique within a 1914 nation: a clash between modern countries names the country of every member
// outside the nation's own; one inside a country takes a compass point from the clashing set's centre, then a number.
const countryName = new Map(a0.features.map((f) => [f.properties.ADM0_A3, f.properties.NAME]));
for (let round = 0; round < 3; round++) {
  const byKey = new Map();
  for (const P of land) { const key = `${P.owner}|${P.name}`; if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(P); }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    if (round === 0) {
      if (new Set(list.map((P) => P.iso)).size < 2) continue;
      for (const P of list) if (P.iso !== P.owner) P.name = `${P.name} (${countryName.get(P.iso) || P.iso})`;
    } else if (round === 1) {
      const mlon = list.reduce((s, P) => s + P.clon, 0) / list.length, mlat = list.reduce((s, P) => s + P.clat, 0) / list.length;
      for (const P of list) P.name = `${P.name} ${compass((P.clon - mlon) * Math.cos(mlat * Math.PI / 180), P.clat - mlat)}`;
    } else {
      list.sort((a, b) => a.first - b.first).forEach((P, k) => { if (k) P.name = `${P.name} ${k + 1}`; });
    }
  }
}
land.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : a.first - b.first));
const nLand = land.length;
const partProv = new Int32Array(nParts);
const provinces = [null];
const provsOfUnit = new Map();
land.forEach((P, k) => {
  P.id = k + 1; partProv[P.part] = P.id;
  provinces.push(P);
  for (const u of P.units) { if (!provsOfUnit.has(u)) provsOfUnit.set(u, []); provsOfUnit.get(u).push(P.id); }
});
zones.forEach((z, k) => provinces.push({ id: nLand + k + 1, name: z.name, sea: true }));
const nAll = provinces.length - 1;
if (nAll > 65535) fail('more than 65535 provinces');
log(`${nLand} land provinces from ${R} units (${groups.length} after joining small ones), ${zones.length} sea zones`);

const ids = new Uint16Array(N);
for (let i = 0; i < N; i++) ids[i] = pid[i] ? partProv[pid[i]] : sea[i] ? nLand + sea[i] : 0;

joinSlivers(ids, nLand, (v) => provinces[v].owner);

log('scanning borders');
const riverMask = new Uint8Array(N);
for (const f of riversSrc.features) {
  if (f.properties.featurecla !== 'River') continue;
  const g = f.geometry, lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  for (const line of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const x0 = px(line[k][0]), y0 = py(line[k][1]), x1 = px(line[k + 1][0]), y1 = py(line[k + 1][1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let s = 0; s <= steps; s++) {
        const x = Math.floor(x0 + (x1 - x0) * s / steps), y = Math.floor(y0 + (y1 - y0) * s / steps);
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = (x + dx + W) % W;
          if (yy >= 0 && yy < H) riverMask[yy * W + xx] = 1;
        }
      }
    }
  }
}
const border = new Map(), riverBorder = new Map();
for (let i = 0; i < N; i++) {
  const a = ids[i];
  if (!a) continue;
  for (const j of [right(i), i + W < N ? i + W : -1]) {
    if (j < 0) continue;
    const b = ids[j];
    if (!b || b === a) continue;
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    border.set(key, (border.get(key) || 0) + 1);
    if (a <= nLand && b <= nLand && (riverMask[i] || riverMask[j])) riverBorder.set(key, (riverBorder.get(key) || 0) + 1);
  }
}
const adj = Array.from({ length: nAll + 1 }, () => new Set());
const pairs = [...border].sort((p, q) => p[0] - q[0]);
for (const [key, n] of pairs) {
  if (n < MIN_EDGE) continue;
  const a = Math.floor(key / 65536), b = key % 65536;
  adj[a].add(b); adj[b].add(a);
}
for (const [key, n] of pairs) {
  const a = Math.floor(key / 65536), b = key % 65536;
  if (n < MIN_EDGE && (!adj[a].size || !adj[b].size)) { adj[a].add(b); adj[b].add(a); }
}
const river = Array.from({ length: nAll + 1 }, () => new Set());
for (const [key, n] of riverBorder) {
  const a = Math.floor(key / 65536), b = key % 65536, all = border.get(key);
  if (!adj[a].has(b)) continue;
  if (n >= 3 && (n >= 0.2 * all || n >= 25)) { river[a].add(b); river[b].add(a); }
}


log('placing anchors');
const dist = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  const a = ids[i];
  if (!a) continue;
  const y = (i / W) | 0;
  const edge = ids[left(i)] !== a || ids[right(i)] !== a || y === 0 || y === H - 1 || ids[i - W] !== a || ids[i + W] !== a;
  dist[i] = edge ? 1 : 65535;
}
for (let y = 1; y < H; y++) for (let x = 1; x < W - 1; x++) {
  const i = y * W + x;
  if (dist[i] <= 1) continue;
  dist[i] = Math.min(dist[i], dist[i - 1] + 3, dist[i - W] + 3, dist[i - W - 1] + 4, dist[i - W + 1] + 4);
}
for (let y = H - 2; y >= 0; y--) for (let x = W - 2; x >= 1; x--) {
  const i = y * W + x;
  if (dist[i] <= 1) continue;
  dist[i] = Math.min(dist[i], dist[i + 1] + 3, dist[i + W] + 3, dist[i + W + 1] + 4, dist[i + W - 1] + 4);
}
const anchor = new Int32Array(nAll + 1).fill(-1), anchorD = new Int32Array(nAll + 1);
const area = new Float64Array(nAll + 1), pxCount = new Int32Array(nAll + 1);
for (let y = 0; y < H; y++) {
  const km2 = (111.32 / PPD) ** 2 * Math.cos(latOf(y) * Math.PI / 180);
  for (let x = 0, i = y * W; x < W; x++, i++) {
    const a = ids[i];
    if (!a) continue;
    area[a] += km2; pxCount[a]++;
    if (anchor[a] < 0 || dist[i] > anchorD[a]) { anchor[a] = i; anchorD[a] = dist[i]; }
  }
}
for (let p = 1; p <= nAll; p++) {
  if (anchor[p] < 0) fail(`province ${p} ${provinces[p].name} has no pixels`);
  const P = provinces[p], i = anchor[p];
  P.x = i % W; P.y = (i / W) | 0;
  P.lon = round2(lonOf(P.x)); P.lat = round2(latOf(P.y));
  P.area = Math.max(1, Math.round(area[p]));
}


const cityAt = new Map();
function landNear(lon, lat, what) {
  const x0 = Math.floor(px(lon)), y0 = Math.floor(py(lat));
  for (let r = 0; r <= 8; r++) {
    let best = 0, bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const y = y0 + dy, x = (x0 + dx + W) % W;
      if (y < 0 || y >= H) continue;
      const v = ids[y * W + x];
      if (v && v <= nLand && dx * dx + dy * dy < bestD) { best = v; bestD = dx * dx + dy * dy; }
    }
    if (best) return best;
  }
  fail(`${what} at ${lon},${lat} is not on land`);
}
for (const [name, [lon, lat]] of Object.entries(places.cities)) cityAt.set(name, landNear(lon, lat, `city ${name}`));
const cityFlags = (name) => places.cities[name][2] || '';

const cutUnits = new Map(units.filter((u) => u && u.cut).map((u) => [u.cut, u]));
function selectorProvinces(sel) {
  if (sel.startsWith('cut:')) {
    const u = cutUnits.get(sel.slice(4));
    if (!u) fail(`unknown cut ${sel}`);
    return provsOfUnit.get(u.id) || [];
  }
  const [iso, name] = sel.split(':');
  const us = name === '*' ? units.filter((u) => u && u.iso === iso && !u.cut) : unitByName(iso, name);
  if (!us.length) fail(`region selector ${sel} matches nothing`);
  return us.flatMap((u) => provsOfUnit.get(u.id) || []);
}
const regionCache = new Map();
function region(name) {
  if (!regionCache.has(name)) {
    const spec = places.regions[name];
    if (!spec) fail(`unknown region @${name}`);
    regionCache.set(name, [...new Set(spec.flatMap(selectorProvinces))].sort((a, b) => a - b));
  }
  return regionCache.get(name);
}
function refs(list, what) {
  const out = new Set();
  for (const r of [].concat(list)) {
    if (typeof r === 'number') out.add(r);
    else if (r.startsWith('@')) for (const p of region(r.slice(1))) out.add(p);
    else if (cityAt.has(r)) out.add(cityAt.get(r));
    else fail(`${what}: unknown place "${r}"`);
  }
  return [...out].sort((a, b) => a - b);
}
const ref = (r, what) => {
  const l = refs([r], what);
  if (l.length !== 1) fail(`${what}: "${r}" is not one province`);
  return l[0];
};


const straits = [];
for (const s of seas.straits) {
  const a = landNear(s.a[0], s.a[1], `strait ${s.name}`), b = landNear(s.b[0], s.b[1], `strait ${s.name}`);
  if (a === b) fail(`strait ${s.name} joins province ${a} to itself`);
  if (adj[a].has(b)) { log(`  strait ${s.name}: ${provinces[a].name} and ${provinces[b].name} already touch`); continue; }
  adj[a].add(b); adj[b].add(a);
  straits.push(a < b ? [a, b] : [b, a]);
}
const passages = [];
for (const s of seas.passages) {
  const a = zoneIndex.get(s.a), b = zoneIndex.get(s.b);
  if (!a || !b) fail(`passage ${s.name} names an unknown zone`);
  const pa = nLand + a, pb = nLand + b;
  if (!adj[pa].has(pb)) { adj[pa].add(pb); adj[pb].add(pa); }
  passages.push(pa < pb ? [pa, pb] : [pb, pa]);
}
{
  const seen = new Uint8Array(nAll + 1), stack = [1];
  seen[1] = 1;
  while (stack.length) for (const q of adj[stack.pop()]) if (!seen[q]) { seen[q] = 1; stack.push(q); }
  const lost = provinces.slice(1).filter((p) => !seen[p.id]);
  if (lost.length) fail(`not connected: ${lost.slice(0, 20).map((p) => `${p.id} ${p.name} (${p.iso || 'sea'})`).join(', ')}`);
}


log('terrain and climate');
const tcount = new Int32Array((nLand + 1) * 6);
for (let i = 0; i < N; i++) { const a = ids[i]; if (a && a <= nLand) tcount[a * 6 + terrainRaster[i]]++; }
const urbanProv = new Set();
for (const name of Object.keys(places.cities)) if (cityFlags(name).includes('u')) urbanProv.add(cityAt.get(name));
const climateShapes = terrainTable.climate.map((c) => ({ c: c.c, rings: shapeRings(c) }));
for (let p = 1; p <= nLand; p++) {
  const P = provinces[p];
  let best = 0, bestScore = tcount[p * 6];
  for (let c = 1; c < 6; c++) if (tcount[p * 6 + c] * 1.5 > bestScore) { best = c; bestScore = tcount[p * 6 + c] * 1.5; }
  P.terrain = urbanProv.has(p) && P.area <= URBAN_KM2 ? 'urban' : TERRAINS[best];
  const alat = Math.abs(P.lat), shape = climateShapes.find((s) => insideRings(s.rings, P.lon, P.lat));
  P.climate = alat >= 66 ? 'arctic' : shape ? shape.c : TERRAINS[best] === 'desert' ? 'arid' : alat >= 55 ? 'cold' : alat < 23.5 ? 'tropical' : 'temperate';
  P.coastal = [...adj[p]].some((q) => q > nLand);
}
const portProv = new Set();
for (const name of Object.keys(places.cities)) if (cityFlags(name).includes('p')) portProv.add(cityAt.get(name));
const isoHasPort = new Set();
for (let p = 1; p <= nLand; p++) {
  const P = provinces[p];
  P.port = P.coastal && (portProv.has(p) || ![...adj[p]].some((q) => q <= nLand));
  if (P.port) isoHasPort.add(P.iso);
}
for (const iso of [...new Set(provinces.slice(1, nLand + 1).map((P) => P.iso))]) {
  if (isoHasPort.has(iso)) continue;
  let best = 0, bestN = 0;
  for (let p = 1; p <= nLand; p++) {
    if (provinces[p].iso !== iso) continue;
    let coast = 0;
    for (const q of adj[p]) if (q > nLand) coast += border.get(p < q ? p * 65536 + q : q * 65536 + p) || 0;
    if (coast > bestN) { best = p; bestN = coast; }
  }
  if (best) provinces[best].port = true;
}


log('scenario');
const ownedBy = new Map();
for (let p = 1; p <= nLand; p++) {
  const t = provinces[p].owner;
  if (!ownedBy.has(t)) ownedBy.set(t, []);
  ownedBy.get(t).push(p);
}
const specs = world.nations.filter((n) => ownedBy.has(n.tag));
for (const n of world.nations) if (!ownedBy.has(n.tag)) log(`  ${n.tag} ${n.name} has no province after merging and is left out`);
for (const t of ownedBy.keys()) if (!world.nations.some((n) => n.tag === t)) fail(`owner ${t} is not a nation in nations-1914.mjs`);
const tags = new Set(specs.map((n) => n.tag));

const econ = new Map();
const econOf = (p) => { if (!econ.has(p)) econ.set(p, { mil: 0, civ: 0, infra: 0, hub: false, coal: 0, iron: 0, oil: 0 }); return econ.get(p); };
for (let p = 1; p <= nLand; p++) {
  const P = provinces[p], I = economy.infra;
  const home = I.metropoles[P.owner];
  econOf(p).infra = I.pairs[`${P.owner}|${P.iso}`] ?? I.iso[P.iso] ?? (home && !home.includes(P.iso) ? I.colony : I.default);
}
for (const s of economy.infra.boxes) {
  for (let p = 1; p <= nLand; p++) {
    const P = provinces[p];
    if (P.lon >= s.box[0] && P.lat >= s.box[1] && P.lon <= s.box[2] && P.lat <= s.box[3] && (!s.iso || s.iso.includes(P.iso))) econOf(p).infra = s.infra;
  }
}
for (const s of economy.sites) {
  const p = ref(s.at, `economy site ${s.at}`), e = econOf(p);
  for (const k of ['mil', 'civ', 'coal', 'iron', 'oil']) e[k] += s[k] || 0;
  if (s.infra) e.infra = Math.max(e.infra, s.infra);
}
for (const name of Object.keys(places.cities)) {
  const p = cityAt.get(name), e = econOf(p);
  if (cityFlags(name).includes('h')) e.hub = true;
  if (cityFlags(name).includes('u')) e.infra = Math.min(5, e.infra + 1);
}

const nationArea = new Map(), nationFactories = new Map();
for (const [t, ps] of ownedBy) {
  nationArea.set(t, ps.reduce((s, p) => s + provinces[p].area, 0));
  nationFactories.set(t, ps.reduce((s, p) => s + econOf(p).mil + econOf(p).civ, 0));
}
const D = world.defaults;
const nations = [];
for (const spec of specs) {
  const capital = ref(spec.capital, `${spec.tag} capital`);
  if (provinces[capital].owner !== spec.tag) fail(`${spec.tag}'s capital ${spec.capital} is owned by ${provinces[capital].owner}`);
  const e = econOf(capital);
  e.hub = true;
  if (nationFactories.get(spec.tag) === 0) {
    e.civ = Math.max(1, Math.min(6, Math.round(nationArea.get(spec.tag) / 300000)));
    nationFactories.set(spec.tag, e.civ);
  }
  if (!ownedBy.get(spec.tag).some((p) => econOf(p).mil)) { e.mil = 1; nationFactories.set(spec.tag, nationFactories.get(spec.tag) + 1); }
  const mil = ownedBy.get(spec.tag).reduce((s, p) => s + econOf(p).mil, 0);
  const manpower = spec.manpower ?? Math.round((D.manpower.base + nationArea.get(spec.tag) * D.manpower.perKm2 + nationFactories.get(spec.tag) * D.manpower.perFactory) / 1000) * 1000;
  const goals = (spec.goals || [{ id: 'hold-capital', kind: 'hold', provinces: [spec.capital], weight: 500 }]).map((g) => {
    const out = { id: g.id, kind: g.kind };
    if (g.provinces) out.provinces = refs(g.provinces, `${spec.tag} goal ${g.id}`);
    if (g.nation) out.nation = g.nation;
    if (g.bloc !== undefined) out.bloc = g.bloc;
    if (g.when) out.when = resolveWhen(g.when, `${spec.tag} goal ${g.id}`);
    out.weight = g.weight;
    return out;
  });
  nations.push({
    tag: spec.tag, name: spec.name, color: spec.color || null, capital, bloc: spec.bloc ?? null, major: !!spec.major, manpower,
    personality: spec.personality || D.personality,
    goals,
    generals: spec.generals || [],
    templates: spec.templates || D.templates,
    lines: productionLines(spec.lines || D.lines, Math.max(1, mil)),
    navy: spec.navy ?? (ownedBy.get(spec.tag).some((p) => provinces[p].port) ? D.navy : 0),
    stock: startStock(spec),
    mob: { ...D.mob, ...(spec.mob || {}) },
  });
}

// Stock is a base plus an amount per division the nation starts with in world.armies; majors hold more.
function startStock(spec) {
  const S = D.stock, divisions = world.armies.filter((a) => a.nation === spec.tag).reduce((s, a) => s + a.divisions, 0);
  const out = {};
  for (const k of Object.keys(S.perDivision)) out[k] = Math.round((S.base[k] + S.perDivision[k] * divisions) * (spec.major ? S.major : 1) * (spec.stockScale?.[k] ?? 1) / 10) * 10;
  return out;
}

// Lines are written as shares of the nation's military factories; each takes its floor and the rest go in order.
function productionLines(shares, mil) {
  const out = shares.map((l) => ({ item: l.item, factories: Math.floor(mil * l.share) }));
  let left = mil - out.reduce((s, l) => s + l.factories, 0);
  for (let k = 0; left > 0; k = (k + 1) % out.length, left--) out[k].factories++;
  return out.filter((l) => l.factories > 0);
}

function resolveWhen(w, what) {
  const [k] = Object.keys(w), v = w[k];
  if (Object.keys(w).length !== 1) fail(`${what}: a condition has one key`);
  switch (k) {
    case 'all': case 'any': return { [k]: v.map((c) => resolveWhen(c, what)) };
    case 'not': return { not: resolveWhen(v, what) };
    case 'war': case 'ally': return { [k]: [needTag(v[0], what), needTag(v[1], what)] };
    case 'atWar': return { atWar: needTag(v, what) };
    case 'bloc': return { bloc: [needTag(v[0], what), v[1]] };
    case 'controls': case 'controlsAny': return { [k]: [needTag(v[0], what), refs(v[1], what)] };
    case 'fatigueAbove': return { fatigueAbove: [needTag(v[0], what), v[1]] };
    case 'dateAfter': case 'fired': case 'chance': return { [k]: v };
    case 'daysSince': return { daysSince: [v[0], v[1]] };
    default: fail(`${what}: unknown condition ${k}`);
  }
}
function resolveEffect(e, what) {
  const [k] = Object.keys(e), v = e[k];
  switch (k) {
    case 'declareWar': case 'peace': case 'ally': return { [k]: [needTag(v[0], what), needTag(v[1], what)] };
    case 'joinBloc': return { joinBloc: [needTag(v[0], what), v[1]] };
    case 'collapse': case 'mobilise': return { [k]: needTag(v, what) };
    case 'log': return { log: v };
    default: fail(`${what}: unknown effect ${k}`);
  }
}
function needTag(t, what) { if (!tags.has(t)) fail(`${what}: ${t} is not a nation`); return t; }

for (const n of nations) for (const g of n.goals) if (g.nation) needTag(g.nation, `${n.tag} goal ${g.id}`);

// Colours: majors keep their own; everyone else takes the first palette colour that stands apart from every
// coloured neighbour (land border or strait) in lightness and in hue.
const touch = new Map(nations.map((n) => [n.tag, new Set()]));
for (let p = 1; p <= nLand; p++) for (const q of adj[p]) if (q <= nLand && provinces[q].owner !== provinces[p].owner) touch.get(provinces[p].owner).add(provinces[q].owner);
const lab = (hex) => {
  const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const X = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047, Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], Z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const apart = (h1, h2) => {
  const a = lab(h1), b = lab(h2);
  return Math.abs(a[0] - b[0]) >= 6 && Math.hypot(a[1] - b[1], a[2] - b[2]) >= 20;
};
const palette = [];
for (const l of [0.3, 0.42, 0.56, 0.7, 0.82, 0.9]) for (let h = 0; h < 360; h += 20) {
  const s = 0.45, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  palette.push('#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join(''));
}
const colorOf = new Map(nations.filter((n) => n.color).map((n) => [n.tag, n.color]));
for (const n of nations) {
  if (n.color) continue;
  const near = [...touch.get(n.tag)].filter((t) => colorOf.has(t)).map((t) => colorOf.get(t));
  const used = new Set(colorOf.values());
  const pick = palette.find((c) => !used.has(c) && near.every((o) => apart(c, o))) || palette.find((c) => near.every((o) => apart(c, o)));
  if (!pick) fail(`no colour for ${n.tag} apart from ${near.join(' ')}`);
  n.color = pick; colorOf.set(n.tag, pick);
}
for (const n of nations) for (const t of touch.get(n.tag)) if (!apart(n.color, colorOf.get(t))) fail(`colours of neighbours ${n.tag} ${n.color} and ${t} ${colorOf.get(t)} are too close`);

const owner = {};
for (const n of nations) owner[n.tag] = ownedBy.get(n.tag);
const cores = {};
for (const spec of specs) {
  if (!spec.home && !spec.homeBox && !spec.claims) continue;
  const set = new Set();
  for (const p of ownedBy.get(spec.tag)) {
    const P = provinces[p], b = spec.homeBox;
    if (spec.home && !spec.home.includes(P.iso)) continue;
    if (b && !(P.lon >= b[0] && P.lat >= b[1] && P.lon <= b[2] && P.lat <= b[3])) continue;
    set.add(p);
  }
  for (const p of refs(spec.claims || [], `${spec.tag} claims`)) set.add(p);
  cores[spec.tag] = [...set].sort((a, b) => a - b);
}

const provEcon = {};
for (let p = 1; p <= nLand; p++) {
  const e = econOf(p), out = {};
  if (e.mil) out.mil = e.mil;
  if (e.civ) out.civ = e.civ;
  if (e.infra !== 2) out.infra = Math.max(1, Math.min(5, e.infra));
  if (e.hub) out.hub = true;
  if (e.coal) out.coal = e.coal;
  if (e.iron) out.iron = e.iron;
  if (e.oil) out.oil = e.oil;
  if (Object.keys(out).length) provEcon[p] = out;
}

const armies = world.armies.map((a) => {
  const n = nations.find((x) => x.tag === a.nation);
  if (!n) fail(`army ${a.name}: ${a.nation} is not a nation`);
  if (a.general && !n.generals.some((g) => g.name === a.general)) fail(`army ${a.name}: ${a.general} is not a general of ${a.nation}`);
  if (!n.templates.some((t) => t.id === a.template)) fail(`army ${a.name}: no template ${a.template}`);
  const at = refs(a.at, `army ${a.name}`);
  for (const p of at.slice()) {
    if (groupParts[provinces[p].group] < 2) continue;
    for (const q of adj[p]) if (q <= nLand && provinces[q].group === provinces[p].group && provinces[q].owner === a.nation && !at.includes(q)) at.push(q);
  }
  at.sort((x, y) => x - y);
  for (const p of at) if (provinces[p].owner !== a.nation) fail(`army ${a.name} stands in ${provinces[p].name}, owned by ${provinces[p].owner}`);
  return { nation: a.nation, name: a.name, general: a.general || null, template: a.template, divisions: a.divisions, at };
});
const alliances = world.alliances.map(([a, b]) => [needTag(a, 'alliance'), needTag(b, 'alliance')]);
const eventIds = new Set(world.events.map((e) => e.id));
const events = world.events.map((e) => {
  const out = { id: e.id, once: e.once !== false };
  if (e.skipIfPlayer) out.skipIfPlayer = needTag(e.skipIfPlayer, `event ${e.id}`);
  out.when = resolveWhen(e.when, `event ${e.id}`);
  out.effects = e.effects.map((x) => resolveEffect(x, `event ${e.id}`));
  return out;
});
const firedRefs = JSON.stringify(events).matchAll(/"(?:fired|daysSince)":\[?"([^"]+)"/g);
for (const [, id] of firedRefs) if (!eventIds.has(id)) fail(`a condition names event ${id}, which does not exist`);

const scenario = {
  v: 1, id: '1914', map: 'world', name: world.name, start: world.start, end: world.end, notes: world.notes,
  nations, owner, cores, provinces: provEcon, armies, alliances, wars: [], events,
};


const mapOut = {
  v: 1, id: 'world', name: 'World',
  texture: { file: 'ids.png', width: W, height: H },
  projection: { type: 'equirect', lon0: -180, lat0: 90, pxPerDeg: Math.round(PPD * 10000) / 10000 },
  provinces: [null, ...provinces.slice(1).map((P) => P.sea
    ? { id: P.id, name: P.name, sea: true, x: P.x, y: P.y, lon: P.lon, lat: P.lat, area: P.area, adj: [...adj[P.id]].sort((a, b) => a - b) }
    : { id: P.id, name: P.name, sea: false, iso: P.iso, x: P.x, y: P.y, lon: P.lon, lat: P.lat, area: P.area, terrain: P.terrain, climate: P.climate,
      coastal: P.coastal, port: P.port, adj: [...adj[P.id]].sort((a, b) => a - b), river: [...river[P.id]].sort((a, b) => a - b) })],
  straits: straits.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  passages: passages.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
};

function pretty(v, depth = 0, max = 2) {
  if (depth >= max || v === null || typeof v !== 'object') return JSON.stringify(v);
  const pad = '\n' + ' '.repeat(depth + 1), end = '\n' + ' '.repeat(depth);
  if (Array.isArray(v)) return v.some((x) => x && typeof x === 'object') ? '[' + v.map((x) => pad + pretty(x, depth + 1, max)).join(',') + end + ']' : JSON.stringify(v);
  return '{' + Object.keys(v).map((k) => pad + JSON.stringify(k) + ': ' + pretty(v[k], depth + 1, max)).join(',') + end + '}';
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(w, h, rgb) {
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride), up = y ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let bestF = 0, bestS = Infinity;
    for (let f = 0; f < 3; f++) {
      const c = cand[f];
      let s = 0;
      for (let i = 0; i < stride; i++) {
        const v = f === 0 ? row[i] : f === 1 ? (row[i] - (i >= 3 ? row[i - 3] : 0)) & 255 : (row[i] - (up ? up[i] : 0)) & 255;
        c[i] = v; s += v < 128 ? v : 256 - v;
      }
      if (s < bestS) { bestS = s; bestF = f; }
    }
    raw[y * (stride + 1)] = bestF;
    cand[bestF].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

log('writing');
fs.mkdirSync(OUT, { recursive: true });
const rgb = Buffer.alloc(N * 3);
for (let i = 0; i < N; i++) { const v = ids[i]; rgb[i * 3] = v >> 16; rgb[i * 3 + 1] = (v >> 8) & 255; rgb[i * 3 + 2] = v & 255; }
fs.writeFileSync(path.join(OUT, 'ids.png'), encodePng(W, H, rgb));
fs.writeFileSync(path.join(OUT, 'map.json'), pretty(mapOut) + '\n');
fs.writeFileSync(path.join(OUT, 'scenario.json'), pretty(scenario) + '\n');

if (PREVIEW) {
  const pw = 2048, ph = 1024, out = Buffer.alloc(pw * ph * 3);
  const ownerColor = new Map(nations.map((n) => [n.tag, [1, 3, 5].map((k) => parseInt(n.color.slice(k, k + 2), 16))]));
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = (y * 4 + 2) * W + x * 4 + 2, v = ids[i];
    let c = !v ? [16, 20, 24] : v > nLand ? (v % 2 ? [28, 52, 84] : [34, 60, 94]) : ownerColor.get(provinces[v].owner);
    const r = ids[(y * 4 + 2) * W + ((x * 4 + 6) % W)], d = y < ph - 1 ? ids[(y * 4 + 6) * W + x * 4 + 2] : v;
    const diff = (u) => u !== v && u && v && u <= nLand && v <= nLand;
    if (diff(r) || diff(d)) {
      const nb = diff(r) ? r : d, nationEdge = provinces[nb].owner !== provinces[v].owner;
      c = c.map((k) => Math.round(k * (nationEdge ? 0.3 : 0.78)));
    }
    out.set(c, (y * pw + x) * 3);
  }
  fs.mkdirSync(path.dirname(path.resolve(PREVIEW)), { recursive: true });
  fs.writeFileSync(path.resolve(PREVIEW), encodePng(pw, ph, out));
}
const sizes = ['map.json', 'ids.png', 'scenario.json'].map((f) => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2)} MB`);
log(`done: ${nLand} land, ${zones.length} sea, ${nations.length} nations, ${straits.length} straits, ${events.length} events; ${sizes.join(', ')}`);
